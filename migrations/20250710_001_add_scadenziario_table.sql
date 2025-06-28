-- Migrazione per creare la tabella scadenziario
-- Questa migrazione è stata creata per aggiungere la tabella scadenziario
-- poiché la migrazione precedente (20250610_001_create_scadenziario_table.sql)
-- non viene eseguita perché precedente alla migrazione consolidata (20250700_001_consolidated_schema.sql)

-- Assicuriamoci che l'estensione uuid-ossp sia installata
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Creazione della tabella scadenziario
CREATE TABLE IF NOT EXISTS scadenziario (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject VARCHAR(255) NOT NULL,
    description TEXT,
    causale VARCHAR(255),
    date DATE NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    payment_date DATE,
    status VARCHAR(50) NOT NULL,
    owner_id UUID REFERENCES owners(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indici per migliorare le prestazioni
CREATE INDEX IF NOT EXISTS idx_scadenziario_date ON scadenziario(date);
CREATE INDEX IF NOT EXISTS idx_scadenziario_status ON scadenziario(status);
CREATE INDEX IF NOT EXISTS idx_scadenziario_owner_id ON scadenziario(owner_id);

-- Trigger per aggiornare automaticamente updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_scadenziario_updated_at
BEFORE UPDATE ON scadenziario
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
