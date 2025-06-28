-- Migrazione per risolvere i problemi di ordinamento delle migrazioni precedenti
-- Questa migrazione assicura che la colonna parent_transaction_id esista prima di essere modificata

-- 1. Crea la tabella import_batches se non esiste
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'import_batches' 
    ) THEN
        -- Non fare nulla, la tabella verrà creata dalla migrazione successiva
        RAISE NOTICE 'La tabella import_batches non esiste ancora, verrà creata dalla migrazione successiva';
    ELSE
        -- Aggiungi la colonna parent_transaction_id se non esiste
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'import_batches' 
            AND column_name = 'parent_transaction_id'
        ) THEN
            ALTER TABLE import_batches
            ADD COLUMN parent_transaction_id UUID;
        END IF;
    END IF;
END $$;

-- 2. Aggiungi la colonna parent_transaction_id a transactions se non esiste
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'transactions' 
    ) THEN
        -- Non fare nulla, la tabella verrà creata dalla migrazione successiva
        RAISE NOTICE 'La tabella transactions non esiste ancora, verrà creata dalla migrazione successiva';
    ELSE
        -- Aggiungi la colonna parent_transaction_id se non esiste
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'transactions' 
            AND column_name = 'parent_transaction_id'
        ) THEN
            ALTER TABLE transactions
            ADD COLUMN parent_transaction_id UUID;
        END IF;
    END IF;
END $$;

-- 3. Assicurati che il tipo sia corretto
DO $$
BEGIN
    -- Per import_batches
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'import_batches'
    ) AND EXISTS (
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
    END IF;
    
    -- Per transactions
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'transactions'
    ) AND EXISTS (
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
    END IF;
END $$;

-- 4. Aggiungi foreign key se non esistono
DO $$
BEGIN
    -- Per import_batches
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' AND column_name = 'parent_transaction_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
    ) THEN
        ALTER TABLE import_batches
        ADD CONSTRAINT fk_import_batch_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;
    
    -- Per transactions
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'parent_transaction_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) THEN
        ALTER TABLE transactions
        ADD CONSTRAINT fk_transaction_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
    END IF;
END $$;

-- 5. Aggiungi commenti se le colonne esistono
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' AND column_name = 'parent_transaction_id'
    ) THEN
        COMMENT ON COLUMN import_batches.parent_transaction_id IS 'ID della transazione principale a cui sono associate le transazioni importate (UUID)';
    END IF;
    
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'parent_transaction_id'
    ) THEN
        COMMENT ON COLUMN transactions.parent_transaction_id IS 'ID della transazione principale (UUID)';
    END IF;
END $$;
