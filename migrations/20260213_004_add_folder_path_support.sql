-- Migration: Add folder path support to archive_documents
-- Created: 2026-02-13
-- Description: Aggiunge supporto per percorsi gerarchici e navigazione tipo Finder

-- Aggiungi colonne per percorso gerarchico
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS folder_path TEXT;
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS folder_path_array TEXT[];
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS parent_folder TEXT;
ALTER TABLE archive_documents ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Indici per performance su ricerca cartelle
CREATE INDEX IF NOT EXISTS idx_archive_documents_folder_path ON archive_documents USING btree (db, folder_path);
CREATE INDEX IF NOT EXISTS idx_archive_documents_parent_folder ON archive_documents USING btree (db, parent_folder);
CREATE INDEX IF NOT EXISTS idx_archive_documents_tags ON archive_documents USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_archive_documents_folder_path_array ON archive_documents USING gin (folder_path_array);

-- Funzione per estrarre path dal filename
CREATE OR REPLACE FUNCTION extract_folder_path(filename TEXT)
RETURNS TABLE (
    folder_path TEXT,
    folder_path_array TEXT[],
    parent_folder TEXT,
    clean_filename TEXT
) AS $$
DECLARE
    parts TEXT[];
BEGIN
    -- Rimuovi spazi iniziali/finali e normalizza gli slash
    filename := TRIM(filename);
    filename := REPLACE(filename, '\', '/');
    
    -- Split del path
    parts := string_to_array(filename, '/');
    
    -- Se c'è solo un elemento, non c'è gerarchia
    IF array_length(parts, 1) = 1 THEN
        RETURN QUERY SELECT 
            NULL::TEXT,
            NULL::TEXT[],
            NULL::TEXT,
            parts[1];
    ELSE
        -- Rimuovi l'ultimo elemento (il filename)
        parts := parts[1:array_length(parts, 1) - 1];
        
        RETURN QUERY SELECT 
            array_to_string(parts, '/')::TEXT,
            parts,
            parts[array_length(parts, 1)]::TEXT,
            filename;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- View per navigazione cartelle (simile a Finder)
CREATE OR REPLACE VIEW archive_folders AS
WITH folder_items AS (
    -- Estrai tutte le cartelle dalla gerarchia
    SELECT DISTINCT
        db,
        unnest(folder_path_array) as folder_name,
        generate_subscripts(folder_path_array, 1) as level,
        folder_path_array[1:generate_subscripts(folder_path_array, 1)] as path_array,
        array_to_string(folder_path_array[1:generate_subscripts(folder_path_array, 1)], '/') as full_path
    FROM archive_documents
    WHERE folder_path_array IS NOT NULL
)
SELECT 
    db,
    folder_name,
    level,
    full_path,
    path_array,
    CASE 
        WHEN level > 1 THEN array_to_string(path_array[1:level-1], '/')
        ELSE NULL
    END as parent_path,
    COUNT(*) OVER (PARTITION BY db, full_path) as item_count
FROM folder_items;

-- Commenti
COMMENT ON COLUMN archive_documents.folder_path IS 'Percorso completo cartelle separato da / (es: autovetture/Mercedes/assicurazione)';
COMMENT ON COLUMN archive_documents.folder_path_array IS 'Array delle cartelle nel percorso per query gerarchiche';
COMMENT ON COLUMN archive_documents.parent_folder IS 'Nome della cartella padre immediata';
COMMENT ON COLUMN archive_documents.tags IS 'Tag personalizzati per categorizzazione flessibile';
