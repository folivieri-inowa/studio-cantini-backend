-- 20260610_001_cash_flow.sql
-- Tabelle per la gestione del flusso di denaro contante

CREATE TABLE IF NOT EXISTS cash_flow (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID REFERENCES owners(id) ON DELETE SET NULL,
  withdrawal_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  employee_name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_flow_expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cash_flow_id UUID NOT NULL REFERENCES cash_flow(id) ON DELETE CASCADE,
  expense_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  category VARCHAR(100),
  description TEXT,
  recipient VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_flow_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expense_id UUID NOT NULL REFERENCES cash_flow_expenses(id) ON DELETE CASCADE,
  filename VARCHAR(500) NOT NULL,
  original_name VARCHAR(500) NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'receipt' CHECK (type IN ('receipt', 'declaration')),
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_owner ON cash_flow(owner_id);
CREATE INDEX IF NOT EXISTS idx_cash_flow_status ON cash_flow(status);
CREATE INDEX IF NOT EXISTS idx_cash_flow_expenses_parent ON cash_flow_expenses(cash_flow_id);
CREATE INDEX IF NOT EXISTS idx_cf_attachments_expense ON cash_flow_attachments(expense_id);
