
-- Cambia il tipo della colonna parent_transaction_id nella tabella import_batches da INTEGER a UUID
ALTER TABLE import_batches 
ALTER COLUMN parent_transaction_id TYPE UUID USING NULL;

-- Aggiungi un commento alla migrazione
COMMENT ON COLUMN import_batches.parent_transaction_id IS 'ID della transazione principale a cui sono associate le transazioni importate (UUID)';
