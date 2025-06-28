-- Migrazione per risolvere definitivamente tutti i problemi di migrazioni precedenti
-- Questa migrazione sovrascrive e unifica tutte le migrazioni problematiche relative a parent_transaction_id

-- 1. Verifica se le tabelle esistono e le crea se necessario
DO $$
BEGIN
    -- Crea la tabella transactions se non esiste
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions'
    ) THEN
        CREATE TABLE transactions (
            id UUID PRIMARY KEY,
            -- Altri campi di base...
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;

    -- Crea la tabella import_batches se non esiste
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches'
    ) THEN
        CREATE TABLE import_batches (
            id SERIAL PRIMARY KEY,
            -- Campi base richiesti
            db VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- 2. Rimuovi tutti i vincoli di foreign key esistenti
DO $$
BEGIN
    -- Disabilita temporaneamente i vincoli
    SET session_replication_role = replica;
    
    -- Rimuovi vincolo da import_batches se esiste
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) THEN
        ALTER TABLE import_batches DROP CONSTRAINT fk_import_batch_parent;
    END IF;
    
    -- Rimuovi vincolo generato automaticamente se esiste
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_parent_transaction_id_fkey'
    ) THEN
        ALTER TABLE import_batches DROP CONSTRAINT import_batches_parent_transaction_id_fkey;
    END IF;
    
    -- Rimuovi vincolo da transactions se esiste
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT fk_transaction_parent;
    END IF;
    
    -- Rimuovi vincolo generato automaticamente se esiste
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transactions_parent_transaction_id_fkey'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT transactions_parent_transaction_id_fkey;
    END IF;
    
    -- Riabilita i vincoli
    SET session_replication_role = DEFAULT;
END $$;

-- 3. Gestisci la colonna parent_transaction_id nella tabella transactions
DO $$
BEGIN
    -- Aggiungi o correggi la colonna nella tabella transactions
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'parent_transaction_id'
    ) THEN
        ALTER TABLE transactions ADD COLUMN parent_transaction_id UUID;
    ELSE
        -- Aggiorna il tipo se necessario
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'transactions' 
            AND column_name = 'parent_transaction_id'
            AND data_type <> 'uuid'
        ) THEN
            ALTER TABLE transactions ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;
        END IF;
    END IF;
END $$;

-- 4. Gestisci la colonna parent_transaction_id nella tabella import_batches
DO $$
BEGIN
    -- Aggiungi o correggi la colonna nella tabella import_batches
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' AND column_name = 'parent_transaction_id'
    ) THEN
        ALTER TABLE import_batches ADD COLUMN parent_transaction_id UUID;
    ELSE
        -- Aggiorna il tipo se necessario
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'import_batches' 
            AND column_name = 'parent_transaction_id'
            AND data_type <> 'uuid'
        ) THEN
            ALTER TABLE import_batches ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;
        END IF;
    END IF;
END $$;

-- 5. Aggiungi vincoli di foreign key con controlli dei tipi
DO $$
BEGIN
    -- Aggiungi vincolo alla tabella import_batches
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' AND column_name = 'parent_transaction_id'
        AND data_type = 'uuid'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'id'
        AND data_type = 'uuid'
    ) THEN
        ALTER TABLE import_batches
        ADD CONSTRAINT fk_import_batch_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;

    -- Aggiungi vincolo alla tabella transactions
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'parent_transaction_id'
        AND data_type = 'uuid'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'id'
        AND data_type = 'uuid'
    ) THEN
        ALTER TABLE transactions
        ADD CONSTRAINT fk_transaction_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;
END $$;

-- 6. Aggiungi commenti alle colonne
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' AND column_name = 'parent_transaction_id'
    ) THEN
        COMMENT ON COLUMN import_batches.parent_transaction_id IS 'ID della transazione principale a cui sono associate le transazioni importate (UUID)';
    END IF;
    
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'parent_transaction_id'
    ) THEN
        COMMENT ON COLUMN transactions.parent_transaction_id IS 'ID della transazione principale (UUID)';
    END IF;
END $$;
