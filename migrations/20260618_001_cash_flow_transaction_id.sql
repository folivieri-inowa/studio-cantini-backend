-- 20260618_001_cash_flow_transaction_id.sql
-- Collega un prelievo contante a un movimento di prima nota

ALTER TABLE cash_flow ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_flow_transaction ON cash_flow(transaction_id);
