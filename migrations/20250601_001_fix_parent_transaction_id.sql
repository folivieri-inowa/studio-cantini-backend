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

-- Re-add the foreign key constraints, ma solo se i tipi sono compatibili
DO $$
BEGIN
    -- Verifica se i tipi sono compatibili
    DECLARE
        import_batches_type TEXT;
        transactions_id_type TEXT;
    BEGIN
        SELECT data_type INTO import_batches_type
        FROM information_schema.columns 
        WHERE table_name = 'import_batches' 
        AND column_name = 'parent_transaction_id';
        
        SELECT data_type INTO transactions_id_type
        FROM information_schema.columns 
        WHERE table_name = 'transactions' 
        AND column_name = 'id';
        
        IF import_batches_type = transactions_id_type OR 
           (import_batches_type = 'integer' AND transactions_id_type IN ('integer', 'bigint')) THEN
            -- I tipi sono compatibili, possiamo creare la foreign key
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
            ) THEN
                ALTER TABLE import_batches
                ADD CONSTRAINT fk_import_batch_parent
                FOREIGN KEY (parent_transaction_id)
                REFERENCES transactions(id)
                ON DELETE CASCADE;
                
                RAISE NOTICE 'Creata foreign key da import_batches.parent_transaction_id a transactions.id';
            END IF;
        ELSE
            -- I tipi non sono compatibili, non creiamo la foreign key
            RAISE NOTICE 'ATTENZIONE: Non è possibile creare una foreign key da import_batches.parent_transaction_id (%) a transactions.id (%)', import_batches_type, transactions_id_type;
        END IF;
    END;
END $$;

DO $$
BEGIN
    -- Verifica se i tipi sono compatibili
    DECLARE
        parent_type TEXT;
        id_type TEXT;
    BEGIN
        SELECT data_type INTO parent_type
        FROM information_schema.columns 
        WHERE table_name = 'transactions' 
        AND column_name = 'parent_transaction_id';
        
        SELECT data_type INTO id_type
        FROM information_schema.columns 
        WHERE table_name = 'transactions' 
        AND column_name = 'id';
        
        IF parent_type = id_type THEN
            -- I tipi sono compatibili, possiamo creare la foreign key
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
            ) THEN
                ALTER TABLE transactions
                ADD CONSTRAINT fk_transaction_parent
                FOREIGN KEY (parent_transaction_id)
                REFERENCES transactions(id)
                ON DELETE CASCADE;
                
                RAISE NOTICE 'Creata foreign key da transactions.parent_transaction_id a transactions.id';
            END IF;
        ELSE
            -- I tipi non sono compatibili, non creiamo la foreign key
            RAISE NOTICE 'ATTENZIONE: Non è possibile creare una foreign key da transactions.parent_transaction_id (%) a transactions.id (%)', parent_type, id_type;
        END IF;
    END;
END $$;
