-- 20260424_001_vehicle_fines.sql

CREATE TABLE IF NOT EXISTS vehicle_fines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  fine_date DATE NOT NULL,
  violation_number VARCHAR(100),
  issuing_authority VARCHAR(100),
  violation_type VARCHAR(100),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2),
  due_date DATE,
  paid_date DATE,
  payment_method VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'da_pagare',
  appeal_notes TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_fines_vehicle_id ON vehicle_fines(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_fines_status ON vehicle_fines(status);
