-- Migration per aggiungere il campo is_credit_card alla tabella owners
-- Data: 2025-05-16

-- Aggiungi il campo is_credit_card per identificare se il record è riferito ad una carta di credito
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'owners' AND column_name = 'is_credit_card'
    ) THEN
        ALTER TABLE owners ADD COLUMN is_credit_card BOOLEAN DEFAULT FALSE;
    ELSE
        RAISE NOTICE 'La colonna is_credit_card esiste già nella tabella owners';
    END IF;
END $$;

-- Aggiungi un commento che descrive il campo
COMMENT ON COLUMN owners.is_credit_card IS 'Indica se il record è riferito ad una carta di credito (TRUE) o no (FALSE)';
