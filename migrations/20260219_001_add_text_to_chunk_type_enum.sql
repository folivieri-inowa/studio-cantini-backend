-- Migration: Add 'text' to chunk_type enum
-- Created: 2026-02-19
-- Description: Il worker usa chunk_type='text' ma il valore non era nell'enum

ALTER TYPE chunk_type ADD VALUE IF NOT EXISTS 'text';
