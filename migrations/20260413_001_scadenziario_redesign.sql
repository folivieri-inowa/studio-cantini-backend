-- 20260413_001_scadenziario_redesign.sql

-- Estensione tabella scadenziario
ALTER TABLE scadenziario
  ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'altro',
  ADD COLUMN IF NOT EXISTS alert_days INT DEFAULT 15,
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS invoice_date DATE,
  ADD COLUMN IF NOT EXISTS company_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS vat_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS iban VARCHAR(34),
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payment_terms JSONB,
  ADD COLUMN IF NOT EXISTS attachment_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS group_id UUID;

-- Nuova tabella per i piani di rate
CREATE TABLE IF NOT EXISTS scadenziario_groups (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(50),
  total_amount  DECIMAL(12,2),
  installments  INT,
  frequency     VARCHAR(20),
  start_date    DATE,
  owner_id      UUID REFERENCES owners(id),
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- FK da scadenziario a groups
ALTER TABLE scadenziario
  ADD CONSTRAINT fk_scadenziario_group
  FOREIGN KEY (group_id) REFERENCES scadenziario_groups(id)
  ON DELETE SET NULL;

-- Indici
CREATE INDEX IF NOT EXISTS idx_scadenziario_type ON scadenziario(type);
CREATE INDEX IF NOT EXISTS idx_scadenziario_group_id ON scadenziario(group_id);
CREATE INDEX IF NOT EXISTS idx_scadenziario_groups_owner ON scadenziario_groups(owner_id);
