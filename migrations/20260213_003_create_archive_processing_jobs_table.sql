-- Migration: Create archive processing jobs table
-- Created: 2026-02-13
-- Description: Tabella per tracking jobs di processamento (OCR, cleaning, embedding)

-- Enum per tipo job
DO $$ BEGIN
    CREATE TYPE job_type AS ENUM (
        'ocr',
        'cleaning',
        'embedding',
        'reconciliation'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Enum per stato job
DO $$ BEGIN
    CREATE TYPE job_status AS ENUM (
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Tabella jobs
CREATE TABLE IF NOT EXISTS archive_processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES archive_documents(id) ON DELETE CASCADE,
    
    -- Tipologia job
    job_type job_type NOT NULL,
    job_status job_status DEFAULT 'queued',
    priority priority_level DEFAULT 'NORMAL',
    
    -- Payload e risultato
    job_payload JSONB, -- Input parameters per il job
    job_result JSONB, -- Output del job
    
    -- Timing
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Durata in millisecondi
    duration_ms INTEGER,
    
    -- Errori e retry
    error_message TEXT,
    error_stack TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    
    -- Worker info
    worker_id VARCHAR(100), -- ID del worker che ha preso in carico il job
    
    -- pg-boss job id (per integrazione con priority queue)
    pgboss_job_id UUID,
    
    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_archive_jobs_document_id ON archive_processing_jobs(document_id);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_type ON archive_processing_jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_status ON archive_processing_jobs(job_status);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_priority ON archive_processing_jobs(priority);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_pgboss_id ON archive_processing_jobs(pgboss_job_id);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_queued_at ON archive_processing_jobs(queued_at);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_status_priority ON archive_processing_jobs(job_status, priority) WHERE job_status = 'queued';

-- Indice composito per trovare jobs in coda per tipo e priorità
CREATE INDEX IF NOT EXISTS idx_archive_jobs_queue_processing 
    ON archive_processing_jobs(job_type, priority, queued_at) 
    WHERE job_status IN ('queued', 'running');

-- Trigger per updated_at automatico
CREATE OR REPLACE FUNCTION update_archive_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    
    -- Calcola durata se il job è completato o fallito
    IF NEW.job_status IN ('completed', 'failed') AND NEW.started_at IS NOT NULL THEN
        NEW.duration_ms = EXTRACT(EPOCH FROM (COALESCE(NEW.completed_at, CURRENT_TIMESTAMP) - NEW.started_at)) * 1000;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_archive_jobs_updated_at ON archive_processing_jobs;
CREATE TRIGGER trigger_update_archive_jobs_updated_at
    BEFORE UPDATE ON archive_processing_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_archive_jobs_updated_at();

-- Commenti
COMMENT ON TABLE archive_processing_jobs IS 'Jobs di processamento per documenti dell''archivio (OCR, cleaning, embedding)';
COMMENT ON COLUMN archive_processing_jobs.job_payload IS 'Parametri di input per il job';
COMMENT ON COLUMN archive_processing_jobs.job_result IS 'Output e risultati del job';
COMMENT ON COLUMN archive_processing_jobs.duration_ms IS 'Durata esecuzione job in millisecondi';
COMMENT ON COLUMN archive_processing_jobs.pgboss_job_id IS 'ID del job in pg-boss (per priority queue)';
