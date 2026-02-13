-- ==========================================
-- BACKFILL PRODUCTION: Classification Feedback
-- ==========================================
-- Popola classification_feedback con tutte le transazioni 
-- già classificate per permettere all'analytics AI di vedere
-- tutti i 7410 record storici invece di solo 257
-- ==========================================

BEGIN;

-- Mostra stato PRIMA del backfill
DO $$
DECLARE
  classified_count INTEGER;
  feedback_count INTEGER;
  missing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO classified_count 
  FROM transactions 
  WHERE categoryid IS NOT NULL AND subjectid IS NOT NULL AND status = 'completed';
  
  SELECT COUNT(DISTINCT transaction_id) INTO feedback_count 
  FROM classification_feedback;
  
  missing_count := classified_count - feedback_count;
  
  RAISE NOTICE '====================================';
  RAISE NOTICE 'STATO PRIMA DEL BACKFILL';
  RAISE NOTICE '====================================';
  RAISE NOTICE 'Transazioni classificate: %', classified_count;
  RAISE NOTICE 'Già in feedback: %', feedback_count;
  RAISE NOTICE 'Da inserire: %', missing_count;
  RAISE NOTICE '====================================';
END $$;

-- Inserisci i dati storici
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
  -- Per dati storici: suggested = corrected (erano già classificati correttamente)
  t.categoryid as suggested_category_id,
  t.subjectid as suggested_subject_id,
  t.detailid as suggested_detail_id,
  100 as suggestion_confidence, -- Confidence alta per dati storici verificati
  'historical' as suggestion_method,
  t.categoryid as corrected_category_id,
  t.subjectid as corrected_subject_id,
  t.detailid as corrected_detail_id,
  NOW() as created_at,
  'migration_backfill' as created_by
FROM transactions t
WHERE 
  t.categoryid IS NOT NULL 
  AND t.subjectid IS NOT NULL
  AND t.status = 'completed'
  AND NOT EXISTS (
    SELECT 1 
    FROM classification_feedback cf 
    WHERE cf.transaction_id = t.id
  )
ORDER BY t.date DESC;

-- Mostra stato DOPO il backfill
DO $$
DECLARE
  classified_count INTEGER;
  feedback_count INTEGER;
  coverage_pct NUMERIC;
  db1_count INTEGER;
  db2_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO classified_count 
  FROM transactions 
  WHERE categoryid IS NOT NULL AND subjectid IS NOT NULL AND status = 'completed';
  
  SELECT COUNT(DISTINCT transaction_id) INTO feedback_count 
  FROM classification_feedback;
  
  coverage_pct := ROUND((feedback_count::numeric / NULLIF(classified_count, 0) * 100), 2);
  
  SELECT COUNT(*) INTO db1_count FROM classification_feedback WHERE db = 'db1';
  SELECT COUNT(*) INTO db2_count FROM classification_feedback WHERE db = 'db2';
  
  RAISE NOTICE '';
  RAISE NOTICE '====================================';
  RAISE NOTICE '✅ BACKFILL COMPLETATO!';
  RAISE NOTICE '====================================';
  RAISE NOTICE 'Transazioni classificate: %', classified_count;
  RAISE NOTICE 'Record in feedback: %', feedback_count;
  RAISE NOTICE 'Copertura: %%%', coverage_pct;
  RAISE NOTICE '';
  RAISE NOTICE 'Distribuzione per database:';
  RAISE NOTICE '  db1: % record', db1_count;
  RAISE NOTICE '  db2: % record', db2_count;
  RAISE NOTICE '====================================';
  RAISE NOTICE '';
  RAISE NOTICE '💡 Ora lo strumento di analisi AI può vedere tutti i dati storici!';
  RAISE NOTICE '   Vai su: Dashboard > Machine Learning > Analytics';
  RAISE NOTICE '====================================';
END $$;

-- Verifica integrità (nessun duplicato)
SELECT 
  CASE 
    WHEN COUNT(*) - COUNT(DISTINCT transaction_id) = 0 
    THEN '✅ Nessun duplicato' 
    ELSE '⚠️ Attenzione: ci sono duplicati!' 
  END as check_duplicati,
  COUNT(*) as total_records,
  COUNT(DISTINCT transaction_id) as unique_transactions
FROM classification_feedback;

-- Distribuzione per metodo
SELECT 
  suggestion_method,
  COUNT(*) as count,
  ROUND(AVG(suggestion_confidence), 2) as avg_confidence,
  MIN(created_at)::date as prima_data,
  MAX(created_at)::date as ultima_data
FROM classification_feedback
GROUP BY suggestion_method
ORDER BY count DESC;

COMMIT;
