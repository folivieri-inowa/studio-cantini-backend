-- Migration per aggiungere un nuovo campo alla tabella owners
-- Data: 2025-05-15

-- Aggiungi il campo email alla tabella owners
ALTER TABLE owners ADD COLUMN email VARCHAR(255);

-- Aggiungi un commento che descrive il campo
COMMENT ON COLUMN owners.email IS 'Indirizzo email del proprietario';

-- Aggiungi il campo is_credit_card per identificare se il record è riferito ad una carta di credito
ALTER TABLE owners ADD COLUMN is_credit_card BOOLEAN DEFAULT FALSE;

-- Aggiungi un commento che descrive il campo
COMMENT ON COLUMN owners.is_credit_card IS 'Indica se il record è riferito ad una carta di credito (TRUE) o no (FALSE)';
