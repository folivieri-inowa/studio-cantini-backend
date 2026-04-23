-- 20260423_001_scadenziario_parent_id.sql

-- 1. Nuova colonna parent_id
ALTER TABLE scadenziario
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES scadenziario(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_scadenziario_parent_id ON scadenziario(parent_id);

-- 2. Aggiungi 'acconto' e 'saldo' ai type validi (solo documentazione, il campo è VARCHAR)
-- I valori ammessi diventano: fattura, acconto, saldo, rata, fiscale, ricorrente, altro

-- 3. Vista di aggregazione per le fatture madri
CREATE OR REPLACE VIEW scadenziario_invoice_summary AS
SELECT
  p.id,
  p.owner_id,
  p.amount                                                                        AS total_amount,
  COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'completed'), 0)               AS paid_amount,
  p.amount - COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'completed'), 0)    AS residual_amount,
  COUNT(c.id)                                                                     AS tranches_count,
  COUNT(c.id) FILTER (WHERE c.status = 'completed')                              AS tranches_paid,
  CASE
    WHEN COUNT(c.id) = 0 THEN p.status
    WHEN COUNT(c.id) = COUNT(c.id) FILTER (WHERE c.status = 'completed') THEN 'completed'
    WHEN COUNT(c.id) FILTER (WHERE c.status = 'completed') > 0 THEN 'partial'
    ELSE p.status
  END                                                                             AS computed_status
FROM scadenziario p
LEFT JOIN scadenziario c ON c.parent_id = p.id
WHERE p.parent_id IS NULL
GROUP BY p.id, p.amount, p.owner_id, p.status;
