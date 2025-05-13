-- Migrazione per correggere definitivamente il tipo di parent_transaction_id nelle tabelle

-- Controlla e correggi transactions
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' 
        AND column_name = 'parent_transaction_id'
        AND data_type <> 'uuid'
    ) THEN
        -- Rimuovi eventuali vincoli
        IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
        ) THEN
            ALTER TABLE transactions DROP CONSTRAINT fk_transaction_parent;
        END IF;
        
        -- Modifica il tipo di colonna
        ALTER TABLE transactions 
        ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;
        
        -- Aggiungi CONSTRAINTS
        ALTER TABLE transactions
        ADD CONSTRAINT fk_transaction_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;
END $$;

-- Controlla e correggi import_batches
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' 
        AND column_name = 'parent_transaction_id'
        AND data_type <> 'uuid'
    ) THEN
        -- Rimuovi eventuali vincoli
        IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
        ) THEN
            ALTER TABLE import_batches DROP CONSTRAINT fk_import_batch_parent;
        END IF;
        
        -- Modifica il tipo di colonna
        ALTER TABLE import_batches 
        ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;
        
        -- Aggiungi CONSTRAINTS
        ALTER TABLE import_batches
        ADD CONSTRAINT fk_import_batch_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;
END $$;

-- Aggiungi commenti
COMMENT ON COLUMN transactions.parent_transaction_id IS 'ID della transazione principale (UUID)';
COMMENT ON COLUMN import_batches.parent_transaction_id IS 'ID della transazione principale (UUID)';
