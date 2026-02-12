-- Migration: Fix classification rules
-- Data: 2026-02-11
-- Descrizione: Fix di pattern ATM e amount ranges (valori assoluti + swap min/max)

-- ==========================================
-- 1. FIX PATTERN ATM (PRELEV → PRELI)
-- ==========================================

UPDATE classification_rules 
SET description_patterns = ARRAY['PRELI.*CONT', 'PRELIEVO ATM', 'PRELEV.*ATM', 'BANCOMAT.*CARTA', 'PREL.*BANC']
WHERE id = 10 AND rule_name = 'Prelievi contanti ATM';

-- log
DO $$ BEGIN
  RAISE NOTICE 'Fixed ATM pattern: PRELEV → PRELI';
END $$;

-- ==========================================
-- 2. FIX AMOUNT RANGES (converti a valori assoluti)
-- ==========================================

-- Converti tutti gli amount negativi a valori assoluti
UPDATE classification_rules 
SET amount_min = ABS(amount_min), amount_max = ABS(amount_max)
WHERE amount_min < 0 OR amount_max < 0;

-- log
DO $$ BEGIN
  RAISE NOTICE 'Converted negative amount ranges to absolute values';
END $$;

-- ==========================================
-- 3. SWAP MIN/MAX se invertiti
-- ==========================================

-- Swap dove min > max
UPDATE classification_rules 
SET 
  amount_min = amount_max,
  amount_max = amount_min
WHERE amount_min > amount_max;

-- log
DO $$ BEGIN
  RAISE NOTICE 'Swapped inverted amount ranges (min > max)';
END $$;

-- ==========================================
-- VERIFICA
-- ==========================================

-- Mostra tutte le regole fixate
DO $$
DECLARE
  rec RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Classification Rules After Fix:';
  RAISE NOTICE '========================================';
  
  FOR rec IN 
    SELECT id, rule_name, amount_min, amount_max, description_patterns
    FROM classification_rules 
    WHERE amount_min IS NOT NULL
    ORDER BY id
  LOOP
    RAISE NOTICE 'Rule %: % [%.2f, %.2f] - % patterns', 
      rec.id, rec.rule_name, rec.amount_min, rec.amount_max, 
      array_length(rec.description_patterns, 1);
  END LOOP;
  
  RAISE NOTICE '========================================';
END $$;
