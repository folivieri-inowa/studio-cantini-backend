-- Migration: Add 'text' value to chunk_type enum
-- Created: 2026-02-17
-- Description: Aggiunge il valore 'text' all'enum chunk_type usato dall'embedding

ALTER TYPE chunk_type ADD VALUE IF NOT EXISTS 'text';
