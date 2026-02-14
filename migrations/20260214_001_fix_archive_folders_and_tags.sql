-- Migration: Fix archive_folders structure and add tags table
-- Created: 2026-02-14
-- Description: Crea tabella archive_folders con ID e tabella archive_document_tags per allinearsi al codice esistente

-- ==========================================
-- TABELLA: archive_folders
-- Gerarchia cartelle con ID (richiesto da hybrid-search.service.js)
-- ==========================================
CREATE TABLE IF NOT EXISTS archive_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    db VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    parent_id UUID REFERENCES archive_folders(id) ON DELETE CASCADE,
    path TEXT NOT NULL DEFAULT '/',
    parent_path TEXT, -- Path del genitore per compatibilità con la vecchia view
    depth INTEGER NOT NULL DEFAULT 0,
    color VARCHAR(7),
    icon VARCHAR(50),
    item_count INTEGER DEFAULT 0, -- Contatore elementi per compatibilità
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255),

    -- Vincolo: nome univoco all'interno dello stesso parent e db
    UNIQUE(db, parent_id, name)
);

-- Indici archive_folders
CREATE INDEX IF NOT EXISTS idx_archive_folders_db ON archive_folders(db);
CREATE INDEX IF NOT EXISTS idx_archive_folders_parent ON archive_folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_archive_folders_path ON archive_folders(path);

-- Trigger per updated_at automatico
CREATE OR REPLACE FUNCTION update_archive_folders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_archive_folders_updated_at ON archive_folders;
CREATE TRIGGER trigger_update_archive_folders_updated_at
    BEFORE UPDATE ON archive_folders
    FOR EACH ROW
    EXECUTE FUNCTION update_archive_folders_updated_at();

-- ==========================================
-- TABELLA: archive_document_tags
-- Tag per i documenti (richiesto da hybrid-search.service.js)
-- ==========================================
CREATE TABLE IF NOT EXISTS archive_document_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    tag VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Evita duplicati
    UNIQUE(document_id, tag)
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_archive_document_tags_document ON archive_document_tags(document_id);
CREATE INDEX IF NOT EXISTS idx_archive_document_tags_tag ON archive_document_tags(tag);

-- ==========================================
-- AGGIORNA archive_documents: aggiungi folder_id
-- ==========================================
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES archive_folders(id) ON DELETE SET NULL;

-- Indice per folder_id
CREATE INDEX IF NOT EXISTS idx_archive_documents_folder_id ON archive_documents(folder_id);

-- ==========================================
-- MIGRAZIONE DATI: Converte folder_path esistenti in cartelle
-- ==========================================

-- Inserisce le cartelle uniche trovate nei documenti esistenti
INSERT INTO archive_folders (db, name, path, depth, created_at)
SELECT DISTINCT
    d.db,
    d.parent_folder as name,
    d.folder_path as path,
    COALESCE(array_length(d.folder_path_array, 1), 1) as depth,
    CURRENT_TIMESTAMP
FROM archive_documents d
WHERE d.parent_folder IS NOT NULL
    AND d.folder_path IS NOT NULL
ON CONFLICT (db, parent_id, name) DO NOTHING;

-- Aggiorna i documenti esistenti con il folder_id corrispondente
UPDATE archive_documents d
SET folder_id = f.id
FROM archive_folders f
WHERE d.db = f.db
    AND d.parent_folder = f.name
    AND d.folder_path = f.path;

-- Commenti
COMMENT ON TABLE archive_folders IS 'Gerarchia cartelle dell''archivio digitale';
COMMENT ON TABLE archive_document_tags IS 'Tag associati ai documenti dell''archivio';
COMMENT ON COLUMN archive_documents.folder_id IS 'Riferimento alla cartella contenitore';
