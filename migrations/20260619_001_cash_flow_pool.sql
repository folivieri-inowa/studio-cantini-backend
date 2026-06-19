-- 20260619_001_cash_flow_pool.sql
-- Modello fondo unico: spese non devono essere per forza legate a un prelievo specifico

ALTER TABLE cash_flow_expenses DROP CONSTRAINT IF EXISTS cash_flow_expenses_cash_flow_id_fkey;
ALTER TABLE cash_flow_expenses ALTER COLUMN cash_flow_id DROP NOT NULL;
ALTER TABLE cash_flow_expenses ADD CONSTRAINT cash_flow_expenses_cash_flow_id_fkey
  FOREIGN KEY (cash_flow_id) REFERENCES cash_flow(id) ON DELETE SET NULL;
