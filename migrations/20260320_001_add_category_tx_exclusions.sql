-- Migration: Add category_tx_exclusions table
-- Created: 2026-03-20
-- Description: Esclusioni contestuali per-transazione per categoria,
--              separate dal flag globale excluded_from_stats

CREATE TABLE IF NOT EXISTS category_tx_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  db TEXT NOT NULL,
  transaction_id UUID NOT NULL,
  category_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(db, transaction_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_category_tx_exclusions_lookup
  ON category_tx_exclusions(db, category_id, transaction_id);
