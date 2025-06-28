-- Migrazione consolidata per definire lo schema completo del database
-- Data: 2025-07-00
-- Questa migrazione sostituisce tutte le precedenti migrazioni e definisce lo schema corretto
-- completo del database in un unico file. Funziona sia su database vuoti sia esistenti.

-- Disattiva temporaneamente il controllo dei vincoli di foreign key
SET session_replication_role = replica;

-- ==========================================
-- TABELLA MIGRATIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    migration_name VARCHAR(255) NOT NULL UNIQUE,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- TABELLA CATEGORIES
-- ==========================================
CREATE TABLE IF NOT EXISTS categories (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    db text,
    PRIMARY KEY(id)
);

-- ==========================================
-- TABELLA OWNERS
-- ==========================================
CREATE TABLE IF NOT EXISTS owners (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    cc text,
    iban text,
    db text,
    initialbalance double precision,
    "date" date,
    email text,
    is_credit_card boolean DEFAULT false,
    PRIMARY KEY(id)
);
-- Aggiungi commenti alle colonne
DO $$
BEGIN
    COMMENT ON COLUMN owners.email IS 'Indirizzo email del proprietario';
    COMMENT ON COLUMN owners.is_credit_card IS 'Indica se il record è riferito ad una carta di credito (TRUE) o no (FALSE)';
EXCEPTION WHEN OTHERS THEN
    -- Ignora eventuali errori sui commenti
END;
$$;

-- ==========================================
-- TABELLA SUBJECTS
-- ==========================================
CREATE TABLE IF NOT EXISTS subjects (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    category_id uuid NOT NULL,
    db text,
    PRIMARY KEY(id)
);

-- ==========================================
-- TABELLA DETAILS
-- ==========================================
CREATE TABLE IF NOT EXISTS details (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    subject_id uuid NOT NULL,
    db text,
    PRIMARY KEY(id)
);

-- ==========================================
-- TABELLA TRANSACTIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS transactions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    db text,
    "date" date,
    amount double precision,
    categoryid uuid,
    subjectid uuid,
    detailid uuid,
    description text,
    note text,
    ownerid uuid,
    paymenttype text,
    status text,
    parent_transaction_id uuid,
    PRIMARY KEY(id)
);

-- ==========================================
-- TABELLA DOCUMENTS
-- ==========================================
CREATE TABLE IF NOT EXISTS documents (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    url text,
    db text,
    transaction_id uuid NOT NULL,
    PRIMARY KEY(id)
);

-- ==========================================
-- TABELLA IMPORT_BATCHES
-- ==========================================
CREATE TABLE IF NOT EXISTS import_batches (
    id SERIAL PRIMARY KEY,
    db VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    owner_id UUID NOT NULL,
    category_id UUID NOT NULL,
    subject_id UUID NOT NULL,
    detail_id UUID,
    filename VARCHAR(255),
    file_size INTEGER,
    created_by UUID,
    parent_transaction_id UUID
);

-- ==========================================
-- TABELLA USERS
-- ==========================================
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

-- ==========================================
-- RELAZIONI E VINCOLI
-- ==========================================

-- Aggiungi i vincoli Foreign Key con controlli di esistenza
DO $$
BEGIN
    -- Relazioni per subjects
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'subjects_categories_id_fk' 
        AND conrelid = 'subjects'::regclass::oid
    ) THEN
        ALTER TABLE subjects ADD CONSTRAINT subjects_categories_id_fk 
        FOREIGN KEY (category_id) REFERENCES categories(id);
    END IF;

    -- Relazioni per details
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'details_subjects_id_fk' 
        AND conrelid = 'details'::regclass::oid
    ) THEN
        ALTER TABLE details ADD CONSTRAINT details_subjects_id_fk 
        FOREIGN KEY (subject_id) REFERENCES subjects(id);
    END IF;

    -- Relazioni per transactions
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_categories_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_categories_id_fk 
        FOREIGN KEY (categoryid) REFERENCES categories(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_subjects_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_subjects_id_fk 
        FOREIGN KEY (subjectid) REFERENCES subjects(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_details_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_details_id_fk 
        FOREIGN KEY (detailid) REFERENCES details(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_owners_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_owners_id_fk 
        FOREIGN KEY (ownerid) REFERENCES owners(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_transaction_parent' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT fk_transaction_parent 
        FOREIGN KEY (parent_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
    END IF;

    -- Relazioni per documents
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'documents_transactions_id_fk' 
        AND conrelid = 'documents'::regclass::oid
    ) THEN
        ALTER TABLE documents ADD CONSTRAINT documents_transactions_id_fk 
        FOREIGN KEY (transaction_id) REFERENCES transactions(id);
    END IF;

    -- Relazioni per import_batches
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'import_batches_owner_id_fkey' 
        AND conrelid = 'import_batches'::regclass::oid
    ) THEN
        ALTER TABLE import_batches ADD CONSTRAINT import_batches_owner_id_fkey 
        FOREIGN KEY (owner_id) REFERENCES owners(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'import_batches_category_id_fkey' 
        AND conrelid = 'import_batches'::regclass::oid
    ) THEN
        ALTER TABLE import_batches ADD CONSTRAINT import_batches_category_id_fkey 
        FOREIGN KEY (category_id) REFERENCES categories(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'import_batches_subject_id_fkey' 
        AND conrelid = 'import_batches'::regclass::oid
    ) THEN
        ALTER TABLE import_batches ADD CONSTRAINT import_batches_subject_id_fkey 
        FOREIGN KEY (subject_id) REFERENCES subjects(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'import_batches_detail_id_fkey' 
        AND conrelid = 'import_batches'::regclass::oid
    ) THEN
        ALTER TABLE import_batches ADD CONSTRAINT import_batches_detail_id_fkey 
        FOREIGN KEY (detail_id) REFERENCES details(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_import_batch_parent' 
        AND conrelid = 'import_batches'::regclass::oid
    ) THEN
        ALTER TABLE import_batches ADD CONSTRAINT fk_import_batch_parent 
        FOREIGN KEY (parent_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- Riattiva il controllo dei vincoli di foreign key
SET session_replication_role = DEFAULT;

-- ==========================================
-- CREAZIONE UTENTE DI DEFAULT
-- ==========================================
-- Inserimento utente di test se non esiste già
-- Password: Inowa2024! (hashata con bcrypt)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'f.olivieri@inowa.it') THEN
        INSERT INTO users (email, password, firstName, lastName, dbrole) 
        VALUES (
            'f.olivieri@inowa.it', 
            '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- Inowa2024!
            'Francesco',
            'Olivieri',
            '[{"db":"db1","role":"admin"}]'::jsonb
        );
    END IF;
END
$$;
