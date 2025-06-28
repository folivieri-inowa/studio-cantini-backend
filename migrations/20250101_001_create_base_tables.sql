-- Migrazione per creare tutte le tabelle necessarie del database
-- Data: 2025-01-01

-- Creazione tabella categories
CREATE TABLE IF NOT EXISTS categories (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    db text,
    PRIMARY KEY(id)
);

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

-- Creazione tabella subjects
CREATE TABLE IF NOT EXISTS subjects (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    category_id uuid NOT NULL,
    db text,
    PRIMARY KEY(id),
    CONSTRAINT subjects_categories_id_fk FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- Creazione tabella details
CREATE TABLE IF NOT EXISTS details (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text,
    subject_id uuid NOT NULL,
    db text,
    PRIMARY KEY(id),
    CONSTRAINT details_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES subjects(id)
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
    PRIMARY KEY(id),
    CONSTRAINT transactions_categories_id_fk FOREIGN KEY (categoryid) REFERENCES categories(id),
    CONSTRAINT transactions_subjects_id_fk FOREIGN KEY (subjectid) REFERENCES subjects(id),
    CONSTRAINT transactions_details_id_fk FOREIGN KEY (detailid) REFERENCES details(id),
    CONSTRAINT transactions_owners_id_fk FOREIGN KEY (ownerid) REFERENCES owners(id),
    CONSTRAINT fk_transaction_parent FOREIGN KEY (parent_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

-- Creazione tabella documents
CREATE TABLE IF NOT EXISTS documents (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    url text,
    db text,
    transaction_id uuid NOT NULL,
    PRIMARY KEY(id),
    CONSTRAINT documents_transactions_id_fk FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

-- Creazione tabella import_batches
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
    parent_transaction_id UUID,
    FOREIGN KEY (owner_id) REFERENCES owners(id),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (subject_id) REFERENCES subjects(id),
    FOREIGN KEY (detail_id) REFERENCES details(id),
    CONSTRAINT fk_import_batch_parent FOREIGN KEY (parent_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

-- Aggiunta della colonna import_batch_id alla tabella transactions
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS import_batch_id INTEGER;

-- Aggiunta della foreign key con opzione ON DELETE SET NULL
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch'
    ) THEN
        ALTER TABLE transactions
        ADD CONSTRAINT fk_import_batch
        FOREIGN KEY (import_batch_id)
        REFERENCES import_batches(id)
        ON DELETE SET NULL;
    END IF;
END $$;