-- Migration per creare le tabelle base del database
-- Data: 2025-01-02

-- Creazione tabella owners
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
COMMENT ON COLUMN owners.email IS 'Indirizzo email del proprietario';
COMMENT ON COLUMN owners.is_credit_card IS 'Indica se il record è riferito ad una carta di credito (TRUE) o no (FALSE)';

-- Creazione tabella categories
CREATE TABLE IF NOT EXISTS categories (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    db text,
    PRIMARY KEY(id)
);

-- Creazione tabella subjects
CREATE TABLE IF NOT EXISTS subjects (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    category_id uuid NOT NULL,
    db text,
    PRIMARY KEY(id)
);

-- Aggiunta del vincolo alla tabella subjects, se non esiste già
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'subjects_categories_id_fk' 
        AND conrelid = 'subjects'::regclass::oid
    ) THEN
        ALTER TABLE subjects ADD CONSTRAINT subjects_categories_id_fk FOREIGN KEY (category_id) REFERENCES categories(id);
    END IF;
END
$$;

-- Creazione tabella details
CREATE TABLE IF NOT EXISTS details (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    subject_id uuid NOT NULL,
    db text,
    PRIMARY KEY(id)
);

-- Aggiunta del vincolo alla tabella details, se non esiste già
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'details_subjects_id_fk' 
        AND conrelid = 'details'::regclass::oid
    ) THEN
        ALTER TABLE details ADD CONSTRAINT details_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES subjects(id);
    END IF;
END
$$;

-- Creazione tabella documents
CREATE TABLE IF NOT EXISTS documents (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    url text,
    db text,
    transaction_id uuid NOT NULL,
    PRIMARY KEY(id)
);

-- Creazione tabella transactions con tutti i riferimenti
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

-- Aggiunta dei vincoli alla tabella transactions, se non esistono già
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_categories_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_categories_id_fk FOREIGN KEY (categoryid) REFERENCES categories(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_subjects_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_subjects_id_fk FOREIGN KEY (subjectid) REFERENCES subjects(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_details_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_details_id_fk FOREIGN KEY (detailid) REFERENCES details(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'transactions_owners_id_fk' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_owners_id_fk FOREIGN KEY (ownerid) REFERENCES owners(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_transaction_parent' 
        AND conrelid = 'transactions'::regclass::oid
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT fk_transaction_parent FOREIGN KEY (parent_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- Aggiunta del vincolo alla tabella documents dopo la creazione della tabella transactions
DO $$
BEGIN
    -- Verifica se il vincolo esiste già prima di aggiungerlo
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'documents_transactions_id_fk' 
        AND conrelid = 'documents'::regclass::oid
    ) THEN
        ALTER TABLE documents ADD CONSTRAINT documents_transactions_id_fk FOREIGN KEY (transaction_id) REFERENCES transactions(id);
    END IF;
END
$$;
