-- Migrazione per modificare il tipo della colonna parent_transaction_id
-- La colonna deve essere INTEGER invece di UUID per essere compatibile con l'id auto-incrementale

-- Rimuovi tutte le foreign key esistenti nelle tabelle
DO $$
BEGIN
    -- Rimuovi vincoli da import_batches
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) THEN
        ALTER TABLE import_batches DROP CONSTRAINT fk_import_batch_parent;
    END IF;
    
    -- Rimuovi eventuali foreign key generate automaticamente
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_parent_transaction_id_fkey'
    ) THEN
        ALTER TABLE import_batches DROP CONSTRAINT import_batches_parent_transaction_id_fkey;
    END IF;
    
    -- Disabilita temporaneamente i vincoli di foreign key
    SET session_replication_role = replica;
END $$;

-- Rimuovi la foreign key esistente nella tabella transactions
DO $$
BEGIN
    -- Rimuovi tutte le foreign key che potrebbero essere state create automaticamente
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT fk_transaction_parent;
    END IF;
    
    -- Controlla anche altri possibili nomi di vincolo generati automaticamente
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transactions_parent_transaction_id_fkey'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT transactions_parent_transaction_id_fkey;
    END IF;
END $$;

-- Modifica il tipo della colonna parent_transaction_id nelle tabelle se esistono
DO $$
BEGIN
    -- Per import_batches
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' 
        AND column_name = 'parent_transaction_id'
    ) THEN
        ALTER TABLE import_batches
        ALTER COLUMN parent_transaction_id TYPE INTEGER USING NULL;
    END IF;
    
    -- Per transactions
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' 
        AND column_name = 'parent_transaction_id'
    ) THEN
        ALTER TABLE transactions
        ALTER COLUMN parent_transaction_id TYPE INTEGER USING NULL;
    END IF;
END $$;

-- Aggiunta della foreign key con opzione ON DELETE CASCADE per la tabella import_batches
-- Ma solo se i tipi sono compatibili
DO $$
BEGIN
    -- Verifica se i tipi sono compatibili
    DECLARE
        import_batches_type TEXT;
        transactions_type TEXT;
    BEGIN
        SELECT data_type INTO import_batches_type
        FROM information_schema.columns 
        WHERE table_name = 'import_batches' 
        AND column_name = 'parent_transaction_id';
        
        SELECT data_type INTO transactions_type
        FROM information_schema.columns 
        WHERE table_name = 'transactions' 
        AND column_name = 'id';
        
        IF import_batches_type = transactions_type THEN
            -- I tipi sono uguali, possiamo creare la foreign key
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
            ) THEN
                ALTER TABLE import_batches
                ADD CONSTRAINT fk_import_batch_parent
                FOREIGN KEY (parent_transaction_id)
                REFERENCES transactions(id)
                ON DELETE CASCADE;
            END IF;
        ELSE
            -- I tipi non sono compatibili, non creiamo la foreign key
            RAISE NOTICE 'Non è possibile creare la foreign key: i tipi sono incompatibili (% vs %)', import_batches_type, transactions_type;
        END IF;
    END;
END $$;

-- Riattiva i vincoli di foreign key
DO $$
BEGIN
    SET session_replication_role = DEFAULT;
END $$;

-- Aggiunta della foreign key con opzione ON DELETE CASCADE per la tabella transactions
-- Ma solo se i tipi sono compatibili (dovrebbero essere entrambi UUID)
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
            -- I tipi sono uguali, possiamo creare la foreign key
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
            ) THEN
                ALTER TABLE transactions
                ADD CONSTRAINT fk_transaction_parent
                FOREIGN KEY (parent_transaction_id)
                REFERENCES transactions(id)
                ON DELETE CASCADE;
            END IF;
        ELSE
            -- I tipi non sono compatibili, non creiamo la foreign key
            RAISE NOTICE 'Non è possibile creare la foreign key: i tipi sono incompatibili (% vs %)', parent_type, id_type;
        END IF;
    END;
END $$;