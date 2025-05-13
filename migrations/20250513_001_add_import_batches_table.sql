-- Migration per aggiungere la tabella import_batches e aggiornare la tabella transactions
-- Questa tabella è necessaria per tracciare i batch di importazione e consentire l'annullamento

-- Creazione della tabella import_batches
CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  db VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  owner_id UUID NOT NULL,
  category_id UUID NOT NULL,
  subject_id UUID NOT NULL,
  detail_id UUID,
  filename VARCHAR(255),
  file_size INTEGER,
  created_by UUID,
  FOREIGN KEY (owner_id) REFERENCES owners(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (detail_id) REFERENCES details(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

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
