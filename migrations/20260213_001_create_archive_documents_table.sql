-- Migration: Create archive_documents table
-- Created: 2026-02-13
-- Description: Tabella principale per documenti dell'archivio digitale intelligente

-- Estensioni necessarie
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enum per tipologia documento
DO $$ BEGIN
    CREATE TYPE document_type AS ENUM (
        'fattura',
        'contratto',
        'bilancio',
        'dichiarazione_fiscale',
        'comunicazione',
        'ricevuta',
        'altro'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Enum per stato processamento
DO $$ BEGIN
    CREATE TYPE processing_status AS ENUM (
        'pending',
        'ocr_in_progress',
        'ocr_completed',
        'cleaning_in_progress',
        'cleaning_completed',
        'embedding_in_progress',
        'embedding_completed',
        'completed',
        'failed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Enum per livello priorità
DO $$ BEGIN
    CREATE TYPE priority_level AS ENUM (
        'URGENT',
        'HIGH',
        'NORMAL',
        'LOW',
        'BATCH'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Tabella principale documenti
CREATE TABLE IF NOT EXISTS archive_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    db VARCHAR(255) NOT NULL,
    
    -- Metadati file originale
    original_filename VARCHAR(500) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 per deduplicazione
    
    -- Storage
    storage_path TEXT NOT NULL, -- Path su MinIO
    storage_bucket VARCHAR(100) NOT NULL DEFAULT 'archive',
    
    -- Tipologia e classificazione
    document_type document_type,
    document_subtype VARCHAR(100),
    
    -- Metadati documento
    title TEXT,
    description TEXT,
    document_date DATE,
    fiscal_year INTEGER,
    
    -- Entità correlate
    related_subject_id UUID, -- FK a subjects table
    related_category_id UUID, -- FK a categories table
    related_transaction_ids UUID[], -- Array di transaction IDs
    
    -- Contenuto estratto
    extracted_text TEXT, -- Testo OCR completo
    extracted_metadata JSONB, -- Metadata estratti (es. tabelle, importi, date)
    
    -- Stato processamento
    processing_status processing_status DEFAULT 'pending',
    priority priority_level DEFAULT 'NORMAL',
    
    -- Errori e retry
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    last_retry_at TIMESTAMP,
    
    -- Deduplicazione
    is_duplicate BOOLEAN DEFAULT false,
    duplicate_of UUID REFERENCES archive_documents(id) ON DELETE SET NULL,
    similarity_score DECIMAL(5, 4), -- Score similarità per duplicati fuzzy
    
    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Soft delete
    deleted_at TIMESTAMP,
    deleted_by VARCHAR(255)
);

-- Indici per performance
CREATE INDEX IF NOT EXISTS idx_archive_documents_db ON archive_documents(db);
CREATE INDEX IF NOT EXISTS idx_archive_documents_status ON archive_documents(processing_status);
CREATE INDEX IF NOT EXISTS idx_archive_documents_priority ON archive_documents(priority);
CREATE INDEX IF NOT EXISTS idx_archive_documents_hash ON archive_documents(file_hash);
CREATE INDEX IF NOT EXISTS idx_archive_documents_type ON archive_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_archive_documents_date ON archive_documents(document_date DESC);
CREATE INDEX IF NOT EXISTS idx_archive_documents_fiscal_year ON archive_documents(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_archive_documents_created_at ON archive_documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_documents_deleted_at ON archive_documents(deleted_at) WHERE deleted_at IS NULL;

-- Indice GIN per ricerca full-text su testo estratto
CREATE INDEX IF NOT EXISTS idx_archive_documents_text_search 
    ON archive_documents USING gin(to_tsvector('italian', COALESCE(extracted_text, '')));

-- Indice trigram per ricerca fuzzy su filename e title
CREATE INDEX IF NOT EXISTS idx_archive_documents_filename_trgm 
    ON archive_documents USING gin(original_filename gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_archive_documents_title_trgm 
    ON archive_documents USING gin(title gin_trgm_ops);

-- Indice GIN per metadata JSONB
CREATE INDEX IF NOT EXISTS idx_archive_documents_metadata 
    ON archive_documents USING gin(extracted_metadata);

-- Indice per array di transaction IDs
CREATE INDEX IF NOT EXISTS idx_archive_documents_transactions 
    ON archive_documents USING gin(related_transaction_ids);

-- Trigger per updated_at automatico
CREATE OR REPLACE FUNCTION update_archive_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_archive_documents_updated_at ON archive_documents;
CREATE TRIGGER trigger_update_archive_documents_updated_at
    BEFORE UPDATE ON archive_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_archive_documents_updated_at();

-- Commenti
COMMENT ON TABLE archive_documents IS 'Documenti dell''archivio digitale intelligente';
COMMENT ON COLUMN archive_documents.file_hash IS 'SHA-256 hash del contenuto per deduplicazione esatta';
COMMENT ON COLUMN archive_documents.extracted_metadata IS 'Metadata estratti dal documento (tabelle, importi, intestazioni, ecc.)';
COMMENT ON COLUMN archive_documents.processing_status IS 'Stato corrente della pipeline di processamento';
COMMENT ON COLUMN archive_documents.priority IS 'Livello di priorità per la coda di elaborazione';
COMMENT ON COLUMN archive_documents.similarity_score IS 'Score di similarità per duplicati fuzzy (0-1)';
COMMENT ON COLUMN archive_documents.related_transaction_ids IS 'Array di UUID delle transazioni collegate';
