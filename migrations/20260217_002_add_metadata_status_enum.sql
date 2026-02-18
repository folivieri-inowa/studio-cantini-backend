-- Migration: Add metadata extraction status to enum
-- Created: 2026-02-17
-- Description: Aggiunge stati mancanti per la fase di estrazione metadata

-- Aggiungi i nuovi valori all'enum processing_status
ALTER TYPE processing_status ADD VALUE IF NOT EXISTS 'metadata_extraction';
ALTER TYPE processing_status ADD VALUE IF NOT EXISTS 'metadata_completed';

-- Nota: In PostgreSQL non è possibile rimuovere valori da un enum esistente
-- Se serve riordinare o modificare, bisogna creare un nuovo enum e migrare i dati
