-- Migration: Add doc_date column to archive_documents
-- Created: 2026-02-17
-- Description: Aggiunge colonna doc_date per la data del documento estratta dai metadati

ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS doc_date DATE;

COMMENT ON COLUMN archive_documents.doc_date IS 'Data del documento estratta dai metadati (es. data fattura)';
