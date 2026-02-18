-- Migration: Clear all archive documents and related data
-- Created: 2026-02-17
-- Description: Elimina completamente tutti i documenti e le tracce correlate dall'archivio
--              Utile per resettare l'archivio senza dover ricreare le tabelle

-- ATTENZIONE: Questa operazione è irreversibile!

-- 1. Svuota la tabella principale dei documenti
-- Grazie alle FOREIGN KEY con ON DELETE CASCADE, verranno eliminati automaticamente:
-- - archive_chunks (chunk dei documenti)
-- - archive_processing_jobs (job di processamento)
TRUNCATE TABLE archive_documents CASCADE;

-- 2. Pulisci la coda di pg-boss (jobs in coda per l'elaborazione)
-- Cancella tutti i jobs dalle tabelle di pg-boss
DELETE FROM pgboss.job WHERE name LIKE 'archive-%';
DELETE FROM pgboss.archive WHERE name LIKE 'archive-%';

-- 3. Nota: I file fisici su MinIO/storage locale NON vengono eliminati da questa migration.
--    Per eliminare anche i file fisici, è necessario farlo manualmente o via codice.

-- 4. Se usi Qdrant per gli embedding, i vettori NON vengono eliminati automaticamente.
--    È necessario cancellare la collection 'archive_documents' da Qdrant manualmente.

-- Verifica: conta i documenti rimasti (dovrebbe essere 0)
-- SELECT COUNT(*) as remaining_documents FROM archive_documents;
-- SELECT COUNT(*) as remaining_chunks FROM archive_chunks;
-- SELECT COUNT(*) as remaining_jobs FROM archive_processing_jobs;

COMMENT ON TABLE archive_documents IS 'Documenti dell''archivio digitale intelligente (RESET ESEGUITO IL 2026-02-17)';
