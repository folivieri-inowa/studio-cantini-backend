-- Script di pulizia database archivio
-- Eseguire con: psql -h localhost -p 5435 -U root -d studio-cantini-local -f cleanup-archive-db.sql

-- 1. Mostra documenti duplicati (stesso hash, non soft-deleted)
SELECT 'DUPLICATI ESATTI TROVATI:' as info;
SELECT
    file_hash,
    COUNT(*) as count,
    ARRAY_AGG(id ORDER BY created_at DESC) as ids,
    ARRAY_AGG(original_filename ORDER BY created_at DESC) as filenames
FROM archive_documents
WHERE file_hash IS NOT NULL
    AND deleted_at IS NULL
GROUP BY file_hash
HAVING COUNT(*) > 1;

-- 2. Mostra documenti soft-deleted (cestino)
SELECT 'DOCUMENTI NEL CESTINO:' as info;
SELECT
    id,
    original_filename,
    file_hash,
    deleted_at
FROM archive_documents
WHERE deleted_at IS NOT NULL
ORDER BY deleted_at DESC;

-- 3. Pulizia: elimina definitivamente i soft-deleted
-- DEcommentare la riga sotto per eseguire la pulizia:
-- DELETE FROM archive_documents WHERE deleted_at IS NOT NULL;

-- 4. Per eliminare un documento specifico by ID:
-- DELETE FROM archive_documents WHERE id = 'ID_DEL_DOCUMENTO';

-- 5. Verifica finale
SELECT 'RIEPILOGO:' as info;
SELECT
    COUNT(*) FILTER (WHERE deleted_at IS NULL) as documenti_attivi,
    COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) as nel_cesto,
    COUNT(DISTINCT file_hash) FILTER (WHERE deleted_at IS NULL) as hash_unici
FROM archive_documents;
