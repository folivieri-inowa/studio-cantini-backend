-- Migration: Create archive_chunks table
-- Created: 2026-02-13
-- Description: Tabella per chunks semantici dei documenti (embedding + Qdrant sync)

-- Enum per tipo chunk
DO $$ BEGIN
    CREATE TYPE chunk_type AS ENUM (
        'paragraph',
        'table',
        'header',
        'invoice_header',
        'invoice_body',
        'generic'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Tabella chunks
CREATE TABLE IF NOT EXISTS archive_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    
    -- Contenuto chunk
    chunk_text TEXT NOT NULL,
    chunk_order INTEGER NOT NULL, -- Ordine nel documento originale
    chunk_type chunk_type DEFAULT 'generic',
    
    -- Metadata chunk
    char_start INTEGER, -- Posizione inizio nel testo originale
    char_end INTEGER, -- Posizione fine nel testo originale
    page_number INTEGER,
    
    -- Embedding e vector store
    qdrant_id UUID UNIQUE, -- ID del punto in Qdrant
    qdrant_collection VARCHAR(100) DEFAULT 'archive_documents',
    embedding_model VARCHAR(100) DEFAULT 'nomic-embed-text', -- Modello usato per embedding
    embedding_dimensions INTEGER DEFAULT 768,
    
    -- Sync status con Qdrant
    synced_to_qdrant BOOLEAN DEFAULT false,
    qdrant_sync_at TIMESTAMP,
    qdrant_sync_error TEXT,
    
    -- Metadata aggiuntivi per retrieval
    chunk_metadata JSONB, -- Es. tabelle estratte, entità nominate, etc.
    
    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraint per ordine chunk
    CONSTRAINT unique_document_chunk_order UNIQUE (document_id, chunk_order)
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_archive_chunks_document_id ON archive_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_archive_chunks_qdrant_id ON archive_chunks(qdrant_id);
CREATE INDEX IF NOT EXISTS idx_archive_chunks_sync_status ON archive_chunks(synced_to_qdrant) WHERE synced_to_qdrant = false;
CREATE INDEX IF NOT EXISTS idx_archive_chunks_type ON archive_chunks(chunk_type);
CREATE INDEX IF NOT EXISTS idx_archive_chunks_order ON archive_chunks(document_id, chunk_order);

-- Indice GIN per ricerca full-text su chunk_text
CREATE INDEX IF NOT EXISTS idx_archive_chunks_text_search 
    ON archive_chunks USING gin(to_tsvector('italian', chunk_text));

-- Indice GIN per metadata JSONB
CREATE INDEX IF NOT EXISTS idx_archive_chunks_metadata 
    ON archive_chunks USING gin(chunk_metadata);

-- Trigger per updated_at automatico
CREATE OR REPLACE FUNCTION update_archive_chunks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_archive_chunks_updated_at ON archive_chunks;
CREATE TRIGGER trigger_update_archive_chunks_updated_at
    BEFORE UPDATE ON archive_chunks
    FOR EACH ROW
    EXECUTE FUNCTION update_archive_chunks_updated_at();

-- Commenti
COMMENT ON TABLE archive_chunks IS 'Chunks semantici dei documenti per embedding e ricerca vettoriale';
COMMENT ON COLUMN archive_chunks.chunk_order IS 'Ordine sequenziale del chunk nel documento (per preservare contesto)';
COMMENT ON COLUMN archive_chunks.qdrant_id IS 'UUID del punto corrispondente in Qdrant vector store';
COMMENT ON COLUMN archive_chunks.synced_to_qdrant IS 'Flag di sincronizzazione con Qdrant';
COMMENT ON COLUMN archive_chunks.chunk_metadata IS 'Metadata aggiuntivi per migliorare il retrieval (tabelle, entità, ecc.)';
