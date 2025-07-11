-- Migrazione post-consolidata per assicurare l'esistenza della tabella databases
-- Data: 2025-07-11
-- Nota: Questa migrazione viene eseguita dopo la consolidata per garantire che la tabella databases esista

-- ==========================================
-- TABELLA DATABASES (se non esiste)
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

-- Inserimento dei database esistenti (solo se non esistono già)
INSERT INTO databases (db_key, db_name, description) VALUES 
('db1', 'Guido', 'Database per Guido Cantini'),
('db2', 'Marta', 'Database per Marta')
ON CONFLICT (db_key) DO NOTHING;

-- Aggiunta degli indici per performance (se non esistono)
CREATE INDEX IF NOT EXISTS idx_databases_active ON databases(is_active);
CREATE INDEX IF NOT EXISTS idx_databases_db_key ON databases(db_key);

-- Verifica che la tabella sia stata creata correttamente
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'databases'
    ) THEN
        RAISE EXCEPTION 'Errore: Tabella databases non creata correttamente';
    END IF;
    
    RAISE NOTICE 'Tabella databases verificata e pronta';
END $$;
