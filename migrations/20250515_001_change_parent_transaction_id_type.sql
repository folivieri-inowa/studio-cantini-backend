-- Migrazione per modificare il tipo della colonna parent_transaction_id
-- La colonna deve essere INTEGER invece di UUID per essere compatibile con l'id auto-incrementale

-- Rimuovi la foreign key esistente nella tabella import_batches
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) THEN
        ALTER TABLE import_batches DROP CONSTRAINT fk_import_batch_parent;
    END IF;
END $$;

-- Rimuovi la foreign key esistente nella tabella transactions
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT fk_transaction_parent;
    END IF;
END $$;

-- Modifica il tipo della colonna parent_transaction_id nella tabella import_batches
ALTER TABLE import_batches
ALTER COLUMN parent_transaction_id TYPE INTEGER USING parent_transaction_id::INTEGER;

-- Modifica il tipo della colonna parent_transaction_id nella tabella transactions
ALTER TABLE transactions
ALTER COLUMN parent_transaction_id TYPE INTEGER USING parent_transaction_id::INTEGER;

-- Aggiunta della foreign key con opzione ON DELETE CASCADE per la tabella import_batches
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

-- Aggiunta della foreign key con opzione ON DELETE CASCADE per la tabella transactions
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