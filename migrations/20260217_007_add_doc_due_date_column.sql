-- Migration: Add doc_due_date column to archive_documents
-- Created: 2026-02-17
-- Description: Aggiunge colonna doc_due_date per la data di scadenza del documento

ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS doc_due_date DATE;

COMMENT ON COLUMN archive_documents.doc_due_date IS 'Data di scadenza del documento (es. data pagamento fattura)';
