
-- Cambia il tipo della colonna parent_transaction_id nella tabella import_batches da INTEGER a UUID

-- Prima controlla se la colonna esiste prima di modificarla
DO $$
BEGIN
    -- Aggiungi la colonna se non esiste
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'import_batches' 
        AND column_name = 'parent_transaction_id'
    ) THEN
        ALTER TABLE import_batches ADD COLUMN parent_transaction_id UUID;
    ELSE
        -- Cambia il tipo solo se la colonna esiste e non è già UUID
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'import_batches' 
            AND column_name = 'parent_transaction_id'
            AND data_type <> 'uuid'
        ) THEN
            -- Rimuovi eventuali vincoli esistenti
            IF EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
            ) THEN
                ALTER TABLE import_batches DROP CONSTRAINT fk_import_batch_parent;
            END IF;
            
            -- Modifica il tipo della colonna
            ALTER TABLE import_batches ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;
        END IF;
    END IF;
    
    -- Aggiungi un commento alla migrazione
    COMMENT ON COLUMN import_batches.parent_transaction_id IS 'ID della transazione principale a cui sono associate le transazioni importate (UUID)';
END $$;
