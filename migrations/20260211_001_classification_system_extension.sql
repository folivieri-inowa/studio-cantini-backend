-- Migration: Estensione classificazione automatica
-- Data: 2026-02-11
-- Descrizione: Schema esteso per sistema classificazione locale (sostituisce n8n)

-- ==========================================
-- 0. CREA classification_feedback SE NON ESISTE
-- ==========================================

-- Enable pg_trgm extension for similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS classification_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    db VARCHAR(255) NOT NULL,
    
    -- Original transaction info
    transaction_id UUID NOT NULL,
    original_description TEXT NOT NULL,
    amount DECIMAL(15, 2),
    transaction_date DATE,
    
    -- AI suggestion (what was proposed)
    suggested_category_id UUID,
    suggested_subject_id UUID,
    suggested_detail_id UUID,
    suggestion_confidence DECIMAL(5, 2),
    suggestion_method VARCHAR(50),
    
    -- User correction (what was actually chosen)
    corrected_category_id UUID NOT NULL,
    corrected_subject_id UUID NOT NULL,
    corrected_detail_id UUID,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255)
);

-- Index for fast similarity searches using trigrams
CREATE INDEX IF NOT EXISTS idx_feedback_description_trgm ON classification_feedback USING gin(original_description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_feedback_db ON classification_feedback(db);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON classification_feedback(corrected_category_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON classification_feedback(created_at DESC);

-- ==========================================
-- 1. ESTENDI classification_feedback
-- ==========================================

ALTER TABLE classification_feedback 
  ADD COLUMN IF NOT EXISTS amount_bucket VARCHAR(20),
  ADD COLUMN IF NOT EXISTS matching_score DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS ranking_metadata JSONB;

COMMENT ON COLUMN classification_feedback.amount_bucket IS 'Categoria importo: micro, small, medium, large, xlarge';
COMMENT ON COLUMN classification_feedback.matching_score IS 'Score composito del match (0-100)';
COMMENT ON COLUMN classification_feedback.ranking_metadata IS 'Metadata dettagliato: text_sim, amount_prox, recency, frequency';

-- Indici ottimizzati per ricerca
CREATE INDEX IF NOT EXISTS idx_feedback_amount_bucket 
  ON classification_feedback(db, amount_bucket);

-- Indice composito per query comuni (senza WHERE per evitare errore IMMUTABLE)
CREATE INDEX IF NOT EXISTS idx_feedback_composite 
  ON classification_feedback(db, corrected_category_id, corrected_subject_id, created_at);

-- Indice per ricerca per descrizione e importo
CREATE INDEX IF NOT EXISTS idx_feedback_description_amount
  ON classification_feedback(db, original_description, amount, created_at);

-- ==========================================
-- 2. TABELLA classification_rules
-- ==========================================

CREATE TABLE IF NOT EXISTS classification_rules (
  id SERIAL PRIMARY KEY,
  db VARCHAR(50) NOT NULL,
  rule_name VARCHAR(100) NOT NULL,
  priority INTEGER DEFAULT 50,
  enabled BOOLEAN DEFAULT true,
  
  -- Pattern matching
  description_patterns TEXT[], -- array di regex/keywords
  amount_min DECIMAL(15,2),
  amount_max DECIMAL(15,2),
  payment_types TEXT[],
  
  -- Target classification
  category_id UUID NOT NULL,
  subject_id UUID NOT NULL,
  detail_id UUID,
  
  confidence INTEGER DEFAULT 95, -- fixed confidence per regola
  reasoning TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by VARCHAR(255),
  
  CONSTRAINT fk_rule_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  CONSTRAINT fk_rule_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
  CONSTRAINT fk_rule_detail FOREIGN KEY (detail_id) REFERENCES details(id) ON DELETE CASCADE
);

CREATE INDEX idx_rules_priority ON classification_rules(db, priority DESC, enabled) WHERE enabled = true;
CREATE INDEX idx_rules_patterns ON classification_rules USING gin(description_patterns);
CREATE INDEX idx_rules_db ON classification_rules(db);

COMMENT ON TABLE classification_rules IS 'Regole deterministiche per classificazione automatica (Stage 1)';
COMMENT ON COLUMN classification_rules.priority IS 'Priorità esecuzione regola (DESC): più alta = valutata prima';
COMMENT ON COLUMN classification_rules.description_patterns IS 'Array di pattern regex (case-insensitive)';
COMMENT ON COLUMN classification_rules.confidence IS 'Confidence fissa assegnata dalla regola (95-100)';

-- ==========================================
-- 3. TABELLA classification_metrics
-- ==========================================

CREATE TABLE IF NOT EXISTS classification_metrics (
  id SERIAL PRIMARY KEY,
  db VARCHAR(50) NOT NULL,
  transaction_id UUID NOT NULL,
  
  stage_used VARCHAR(50) NOT NULL, -- 'rule', 'exact', 'semantic', 'manual'
  confidence DECIMAL(5,2) NOT NULL,
  latency_ms INTEGER,
  
  -- Dettagli scoring (per analysis)
  vector_score DECIMAL(5,2),
  amount_score DECIMAL(5,2),
  recency_score DECIMAL(5,2),
  frequency_score DECIMAL(5,2),
  
  candidates_count INTEGER, -- quanti candidati trovati
  cluster_count INTEGER, -- quanti cluster formati (semantic stage)
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT fk_metrics_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX idx_metrics_db_stage ON classification_metrics(db, stage_used, created_at DESC);
CREATE INDEX idx_metrics_confidence ON classification_metrics(db, confidence);
CREATE INDEX idx_metrics_transaction ON classification_metrics(transaction_id);
CREATE INDEX idx_metrics_created_at ON classification_metrics(created_at DESC);

COMMENT ON TABLE classification_metrics IS 'Metriche real-time per monitoring performance classificazione';
COMMENT ON COLUMN classification_metrics.stage_used IS 'Stage pipeline: rule, exact, semantic, manual';
COMMENT ON COLUMN classification_metrics.candidates_count IS 'Numero candidati recuperati (semantic/exact stage)';
COMMENT ON COLUMN classification_metrics.cluster_count IS 'Numero cluster formati (semantic stage)';

-- ==========================================
-- 4. REGOLE DI DEFAULT (esempi)
-- ==========================================

-- Nota: Inserire regole specifiche per ogni DB dopo analisi feedback storici
-- Questi sono esempi generici da configurare manualmente dopo deployment

-- ESEMPIO INSERT:
-- INSERT INTO classification_rules (
--   db, rule_name, priority, enabled,
--   description_patterns, amount_min, amount_max, payment_types,
--   category_id, subject_id, detail_id,
--   confidence, reasoning
-- ) VALUES
-- ('db1', 'Commissioni Bancarie', 100, true,
--  ARRAY['COMMISSIONI', 'COMMISS', 'COMM\.', 'COMM :'], 0.30, 5.00, NULL,
--  'category_id_banche', 'subject_id_spese_bancarie', NULL,
--  98, 'Commissione bancaria: importo tipico < 5€ + keyword')
-- ON CONFLICT DO NOTHING;

-- ==========================================
-- 5. VIEW PER MONITORING
-- ==========================================

-- View: Performance summary per stage
CREATE OR REPLACE VIEW v_classification_performance AS
SELECT 
  db,
  stage_used,
  COUNT(*) as total_classifications,
  AVG(confidence)::numeric(5,2) as avg_confidence,
  STDDEV(confidence)::numeric(5,2) as stddev_confidence,
  AVG(latency_ms) as avg_latency_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95_latency_ms,
  COUNT(*) FILTER (WHERE confidence >= 85) as high_confidence_count,
  (COUNT(*) FILTER (WHERE confidence >= 85)::float / NULLIF(COUNT(*), 0) * 100)::numeric(5,2) as high_confidence_pct,
  COUNT(*) FILTER (WHERE confidence < 70) as manual_review_count,
  (COUNT(*) FILTER (WHERE confidence < 70)::float / NULLIF(COUNT(*), 0) * 100)::numeric(5,2) as manual_review_pct,
  DATE_TRUNC('day', MIN(created_at)) as first_date,
  DATE_TRUNC('day', MAX(created_at)) as last_date
FROM classification_metrics
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY db, stage_used;

COMMENT ON VIEW v_classification_performance IS 'Performance summary per database e stage (ultimi 30 giorni)';

-- View: Accuracy per categoria (richiede feedback)
CREATE OR REPLACE VIEW v_classification_accuracy AS
SELECT 
  cf.db,
  c.name as category_name,
  COUNT(DISTINCT cf.transaction_id) as total_classified,
  COUNT(*) FILTER (WHERE cf.suggested_category_id = cf.corrected_category_id) as correct_category_predictions,
  (COUNT(*) FILTER (WHERE cf.suggested_category_id = cf.corrected_category_id)::float / NULLIF(COUNT(*), 0) * 100)::numeric(5,2) as category_accuracy_pct,
  COUNT(*) FILTER (WHERE cf.suggested_subject_id = cf.corrected_subject_id) as correct_subject_predictions,
  (COUNT(*) FILTER (WHERE cf.suggested_subject_id = cf.corrected_subject_id)::float / NULLIF(COUNT(*), 0) * 100)::numeric(5,2) as subject_accuracy_pct,
  AVG(cf.suggestion_confidence)::numeric(5,2) as avg_suggested_confidence
FROM classification_feedback cf
JOIN categories c ON cf.corrected_category_id = c.id
WHERE cf.created_at > NOW() - INTERVAL '30 days'
  AND cf.suggested_category_id IS NOT NULL
GROUP BY cf.db, c.name;

COMMENT ON VIEW v_classification_accuracy IS 'Accuracy effettiva basata su feedback utenti (ultimi 30 giorni)';

-- ==========================================
-- 6. FUNZIONI HELPER
-- ==========================================

-- Funzione: Ottieni bucket importo
CREATE OR REPLACE FUNCTION get_amount_bucket(amount NUMERIC)
RETURNS VARCHAR(20) AS $$
BEGIN
  IF ABS(amount) <= 10 THEN RETURN 'micro';
  ELSIF ABS(amount) <= 50 THEN RETURN 'small';
  ELSIF ABS(amount) <= 150 THEN RETURN 'medium';
  ELSIF ABS(amount) <= 500 THEN RETURN 'large';
  ELSE RETURN 'xlarge';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION get_amount_bucket IS 'Restituisce bucket importo: micro, small, medium, large, xlarge';

-- Update automatico amount_bucket in classification_feedback
CREATE OR REPLACE FUNCTION update_amount_bucket()
RETURNS TRIGGER AS $$
BEGIN
  NEW.amount_bucket := get_amount_bucket(NEW.amount);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger per auto-popolazione amount_bucket
DROP TRIGGER IF EXISTS trigger_update_amount_bucket ON classification_feedback;
CREATE TRIGGER trigger_update_amount_bucket
  BEFORE INSERT OR UPDATE OF amount ON classification_feedback
  FOR EACH ROW
  EXECUTE FUNCTION update_amount_bucket();

-- ==========================================
-- 7. BACKFILL DATA ESISTENTI
-- ==========================================

-- Update amount_bucket per feedback esistenti
UPDATE classification_feedback
SET amount_bucket = get_amount_bucket(amount)
WHERE amount_bucket IS NULL AND amount IS NOT NULL;

-- ==========================================
-- FINE MIGRATION
-- ==========================================

-- Nota: Il sistema di migrazione gestisce automaticamente
-- l'inserimento nella tabella migrations
