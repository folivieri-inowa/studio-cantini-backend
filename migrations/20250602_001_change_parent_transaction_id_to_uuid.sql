-- Migrazione per modificare il tipo di parent_transaction_id da INTEGER a UUID

-- Rimuovi le foreign key esistenti se presenti
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) THEN
        ALTER TABLE import_batches DROP CONSTRAINT fk_import_batch_parent;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT fk_transaction_parent;
    END IF;
END $$;

-- Modifica il tipo di colonna parent_transaction_id in import_batches
ALTER TABLE import_batches 
ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;

-- Modifica il tipo di colonna parent_transaction_id in transactions
ALTER TABLE transactions 
ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;

-- Ricrea le foreign key con il tipo corretto
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) THEN
        ALTER TABLE import_batches
        ADD CONSTRAINT fk_import_batch_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) THEN
        ALTER TABLE transactions
        ADD CONSTRAINT fk_transaction_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;
END $$;
