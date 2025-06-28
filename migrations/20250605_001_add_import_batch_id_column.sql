-- Migration per aggiungere la colonna import_batch_id alla tabella transactions se non esiste già
-- Questa migrazione è stata creata specificamente per risolvere l'errore:
-- "Error fetching import history: error: column t.import_batch_id does not exist"

-- Aggiunta della colonna import_batch_id alla tabella transactions
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS import_batch_id INTEGER;

-- Aggiunta della foreign key con opzione ON DELETE SET NULL
-- Usiamo una condizione per verificare se il vincolo esiste già
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batch'
    ) THEN
        ALTER TABLE transactions
        ADD CONSTRAINT fk_import_batch
        FOREIGN KEY (import_batch_id)
        REFERENCES import_batches(id)
        ON DELETE SET NULL;
    END IF;
END $$;

-- Aggiungiamo un indice per migliorare le prestazioni delle query che filtrano per import_batch_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_transactions_import_batch_id'
    ) THEN
        CREATE INDEX idx_transactions_import_batch_id ON transactions(import_batch_id);
    END IF;
END $$;
