-- Migration: Add cleaned_text column to archive_documents
-- Created: 2026-02-17
-- Description: Aggiunge colonna per testo pulito dalla fase di cleaning

ALTER TABLE archive_documents
ADD COLUMN IF NOT EXISTS cleaned_text TEXT;

COMMENT ON COLUMN archive_documents.cleaned_text IS 'Testo pulito dopo la fase di cleaning LLM';
