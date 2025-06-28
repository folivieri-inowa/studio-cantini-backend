-- Creazione tabella databases per gestione dinamica dei database
-- Data: 2025-06-28

-- ==========================================
-- TABELLA DATABASES
-- ==========================================
CREATE TABLE IF NOT EXISTS databases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    db_key VARCHAR(50) UNIQUE NOT NULL, -- Chiave identificativa (es. "db1", "db2")
    db_name VARCHAR(255) NOT NULL, -- Nome visualizzato (es. "Guido", "Marta")
    description TEXT, -- Descrizione opzionale
    is_active BOOLEAN DEFAULT true, -- Se il database è attivo
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inserimento dei database esistenti
INSERT INTO databases (db_key, db_name, description) VALUES 
('db1', 'Guido', 'Database per Guido Cantini'),
('db2', 'Marta', 'Database per Marta')
ON CONFLICT (db_key) DO NOTHING;

-- Aggiunta dell'indice per performance
CREATE INDEX IF NOT EXISTS idx_databases_active ON databases(is_active);
CREATE INDEX IF NOT EXISTS idx_databases_db_key ON databases(db_key);
