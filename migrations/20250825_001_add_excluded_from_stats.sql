-- Migrazione per aggiungere la colonna excluded_from_stats alla tabella transactions
-- Data: 2025-08-25
-- Descrizione: Aggiunge possibilità di escludere record dalle statistiche

-- Aggiungi la colonna excluded_from_stats con default FALSE
ALTER TABLE transactions 
ADD COLUMN excluded_from_stats BOOLEAN DEFAULT FALSE;

-- Crea un indice per migliorare le performance dei filtri
CREATE INDEX idx_transactions_excluded_from_stats ON transactions(excluded_from_stats);

-- Commento sulla colonna
COMMENT ON COLUMN transactions.excluded_from_stats IS 'Indica se il record deve essere escluso dalle statistiche e report';
