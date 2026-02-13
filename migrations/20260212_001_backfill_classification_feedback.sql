-- Migration: Backfill classification_feedback con dati storici
-- Data: 2026-02-12
-- Descrizione: Popola classification_feedback con tutte le transazioni già classificate
--              per permettere all'analytics AI di vedere tutti i dati storici

-- ==========================================
-- BACKFILL DATI STORICI
-- ==========================================

-- Inserisci tutte le transazioni classificate che non sono già in classification_feedback
INSERT INTO classification_feedback (
  db,
  transaction_id,
  original_description,
  amount,
  transaction_date,
  suggested_category_id,
  suggested_subject_id,
  suggested_detail_id,
  suggestion_confidence,
  suggestion_method,
  corrected_category_id,
  corrected_subject_id,
  corrected_detail_id,
  created_at,
  created_by
)
SELECT 
  t.db,
  t.id as transaction_id,
  t.description as original_description,
  t.amount,
  t.date as transaction_date,
  -- Per dati storici, suggested = corrected (non sappiamo cosa era stato suggerito)
  t.categoryid as suggested_category_id,
  t.subjectid as suggested_subject_id,
  t.detailid as suggested_detail_id,
  100 as suggestion_confidence, -- Confidence alta per dati storici confermati
  'historical' as suggestion_method,
  t.categoryid as corrected_category_id,
  t.subjectid as corrected_subject_id,
  t.detailid as corrected_detail_id,
  NOW() as created_at,
  'migration_backfill' as created_by
FROM transactions t
WHERE 
  -- Solo transazioni classificate
  t.categoryid IS NOT NULL 
  AND t.subjectid IS NOT NULL
  AND t.status = 'completed'
  -- Escludi quelle già presenti in classification_feedback
  AND NOT EXISTS (
    SELECT 1 
    FROM classification_feedback cf 
    WHERE cf.transaction_id = t.id
  )
ORDER BY t.date DESC;

-- Output statistiche
DO $$
DECLARE
  inserted_count INTEGER;
  total_classified INTEGER;
  total_feedback INTEGER;
BEGIN
  -- Conta record inseriti
  SELECT COUNT(*) INTO inserted_count
  FROM classification_feedback
  WHERE created_by = 'migration_backfill';
  
  -- Conta totale transazioni classificate
  SELECT COUNT(*) INTO total_classified
  FROM transactions
  WHERE categoryid IS NOT NULL AND subjectid IS NOT NULL;
  
  -- Conta totale feedback
  SELECT COUNT(*) INTO total_feedback
  FROM classification_feedback;
  
  RAISE NOTICE '✅ Backfill completato!';
  RAISE NOTICE '📊 Record inseriti: %', inserted_count;
  RAISE NOTICE '📊 Totale transazioni classificate: %', total_classified;
  RAISE NOTICE '📊 Totale record in classification_feedback: %', total_feedback;
  RAISE NOTICE '📊 Copertura: %', ROUND((total_feedback::numeric / NULLIF(total_classified, 0) * 100), 2) || '%';
END $$;

-- ==========================================
-- VERIFICA INTEGRITÀ
-- ==========================================

-- Controlla che non ci siano duplicati
SELECT 
  'Verifica duplicati' as check_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT transaction_id) as unique_transactions,
  COUNT(*) - COUNT(DISTINCT transaction_id) as duplicates
FROM classification_feedback;

-- Controlla distribuzione per database
SELECT 
  'Distribuzione per database' as check_name,
  db,
  COUNT(*) as feedback_records,
  COUNT(DISTINCT transaction_id) as unique_transactions
FROM classification_feedback
GROUP BY db
ORDER BY db;

-- Controlla distribuzione per metodo
SELECT 
  'Distribuzione per metodo' as check_name,
  suggestion_method,
  COUNT(*) as count,
  ROUND(AVG(suggestion_confidence), 2) as avg_confidence
FROM classification_feedback
GROUP BY suggestion_method
ORDER BY count DESC;
