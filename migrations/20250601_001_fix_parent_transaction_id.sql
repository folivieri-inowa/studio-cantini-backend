-- Migrazione per aggiungere esplicitamente la colonna parent_transaction_id alle tabelle

-- Drop existing constraints if they exist
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

-- Check if parent_transaction_id column exists in import_batches and add it if not
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' AND column_name = 'parent_transaction_id'
    ) THEN
        ALTER TABLE import_batches ADD COLUMN parent_transaction_id INTEGER;
    END IF;
END $$;

-- Check if parent_transaction_id column exists in transactions and add it if not
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'parent_transaction_id'
    ) THEN
        ALTER TABLE transactions ADD COLUMN parent_transaction_id INTEGER;
    END IF;
END $$;

-- Re-add the foreign key constraints
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) THEN
        ALTER TABLE import_batches
        ADD CONSTRAINT fk_import_batch_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE CASCADE;
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
        ON DELETE CASCADE;
    END IF;
END $$;
