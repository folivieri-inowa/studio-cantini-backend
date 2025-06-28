-- Creazione tabella users per l'autenticazione
-- Data: 2025-05-24

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    firstName VARCHAR(255),
    lastName VARCHAR(255),
    dbrole JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inserimento utente di test
-- Password: Inowa2024! (hashata con bcrypt)
INSERT INTO users (email, password, firstName, lastName, dbrole) 
VALUES (
    'f.olivieri@inowa.it', 
    '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- Inowa2024!
    'Francesco', 
    'Olivieri',
    '[{"db": "db1", "role": "admin"}, {"db": "db2", "role": "admin"}]'::jsonb
)
ON CONFLICT (email) DO NOTHING;
