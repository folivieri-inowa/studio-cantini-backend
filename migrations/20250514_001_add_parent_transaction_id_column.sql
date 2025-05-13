-- Migrazione per aggiungere la colonna parent_transaction_id alle tabelle import_batches e transactions
-- Questa colonna è necessaria per tracciare le relazioni tra transazioni principali e commissioni associate

-- Aggiunta della colonna parent_transaction_id alla tabella import_batches
ALTER TABLE import_batches
ADD COLUMN IF NOT EXISTS parent_transaction_id UUID;

-- Aggiunta della colonna parent_transaction_id alla tabella transactions
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS parent_transaction_id UUID;

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