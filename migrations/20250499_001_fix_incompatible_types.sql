-- Migrazione per correggere il problema di incompatibilità tra tipi di colonne
-- Il problema è che stiamo cercando di collegare una colonna UUID a una colonna INTEGER

-- 1. Rimuoviamo prima tutte le foreign key problematiche
DO $$
BEGIN
    -- Verifica se la tabella import_batches esiste
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches'
    ) THEN
        -- Rimuovi la foreign key da import_batches a transactions
        IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch_parent'
        ) THEN
            ALTER TABLE import_batches DROP CONSTRAINT fk_import_batch_parent;
        END IF;
        
        -- Rimuovi eventuali altre foreign key generate automaticamente
        IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_parent_transaction_id_fkey'
        ) THEN
            ALTER TABLE import_batches DROP CONSTRAINT import_batches_parent_transaction_id_fkey;
        END IF;
    ELSE
        RAISE NOTICE 'La tabella import_batches non esiste ancora';
    END IF;
    
    -- Rimuovi anche il vincolo di rimbalzo da transactions a se stessa che potrebbe causare problemi
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transaction_parent'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT fk_transaction_parent;
    END IF;
    
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transactions_parent_transaction_id_fkey'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT transactions_parent_transaction_id_fkey;
    END IF;
END $$;

-- 2. Ora aggiustiamo il tipo della colonna parent_transaction_id in import_batches
-- Deve essere INTEGER perché punta all'id di import_batches che è INTEGER/SERIAL
DO $$
BEGIN
    -- Verifica se la tabella import_batches esiste
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches'
    ) THEN
        -- Modifica il tipo di colonna in import_batches
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'import_batches' 
            AND column_name = 'parent_transaction_id'
            AND data_type = 'uuid'
        ) THEN
            -- Modifichiamo prima a text e poi a INTEGER per evitare errori di conversione diretta
            ALTER TABLE import_batches 
            ALTER COLUMN parent_transaction_id TYPE TEXT USING NULL;
            
            ALTER TABLE import_batches 
            ALTER COLUMN parent_transaction_id TYPE INTEGER USING NULL;
            
            RAISE NOTICE 'Colonna parent_transaction_id in import_batches convertita da UUID a INTEGER';
        END IF;
    ELSE
        RAISE NOTICE 'La tabella import_batches non esiste ancora';
    END IF;
END $$;

-- 3. Ripristiniamo le foreign key con i tipi corretti
DO $$
BEGIN
    -- Verifica se la tabella import_batches esiste
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches'
    ) THEN
        -- Aggiungiamo la foreign key da import_batches.parent_transaction_id a transactions.id
        -- Ma solo se la colonna parent_transaction_id esiste ed è di tipo INTEGER
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'import_batches' 
            AND column_name = 'parent_transaction_id'
            AND data_type = 'integer'
        ) THEN
            -- Non possiamo creare questa foreign key perché i tipi sono incompatibili
            -- (INTEGER non può referenziare UUID)
            RAISE NOTICE 'ATTENZIONE: Non è possibile creare una foreign key da import_batches.parent_transaction_id (INTEGER) a transactions.id (UUID)';
        END IF;
    ELSE
        RAISE NOTICE 'La tabella import_batches non esiste ancora';
    END IF;
END $$;

-- 4. Commento per spiegare la situazione
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'import_batches'
    ) THEN
        COMMENT ON COLUMN import_batches.parent_transaction_id IS 'ID della transazione principale. NOTA: Non può essere una foreign key a transactions.id perché i tipi sono incompatibili (INTEGER vs UUID)';
    END IF;
END $$;
