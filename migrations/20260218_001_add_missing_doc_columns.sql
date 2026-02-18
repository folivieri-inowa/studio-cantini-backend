-- Migration: Add missing document columns to archive_documents
-- Created: 2026-02-18
-- Description: Aggiunge colonne mancanti per i metadati estratti: doc_amount, doc_sender, doc_recipient

-- Aggiungi colonna per l'importo del documento
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS doc_amount DECIMAL(15, 2);

-- Aggiungi colonna per il mittente del documento
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS doc_sender TEXT;

-- Aggiungi colonna per il destinatario del documento
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS doc_recipient TEXT;

-- Aggiungi indici per ricerca sui nuovi campi
CREATE INDEX IF NOT EXISTS idx_archive_documents_doc_amount ON archive_documents(doc_amount) WHERE doc_amount IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_archive_documents_doc_sender ON archive_documents USING gin(doc_sender gin_trgm_ops) WHERE doc_sender IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_archive_documents_doc_recipient ON archive_documents USING gin(doc_recipient gin_trgm_ops) WHERE doc_recipient IS NOT NULL;

-- Commenti
COMMENT ON COLUMN archive_documents.doc_amount IS 'Importo totale del documento estratto dai metadati (es. totale fattura)';
COMMENT ON COLUMN archive_documents.doc_sender IS 'Mittente/Emittente del documento estratto dai metadati';
COMMENT ON COLUMN archive_documents.doc_recipient IS 'Destinatario/Intestatario del documento estratto dai metadati';
