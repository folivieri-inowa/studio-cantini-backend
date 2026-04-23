-- 20260423_002_vehicle_policies_taxes_ztl.sql

-- Polizze assicurative
CREATE TABLE IF NOT EXISTS vehicle_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  policy_number VARCHAR(100) NOT NULL,
  insurer VARCHAR(255) NOT NULL,
  policy_types TEXT[] DEFAULT '{}',
  broker VARCHAR(255),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  premium_amount NUMERIC(12,2),
  status VARCHAR(30) NOT NULL DEFAULT 'attiva',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_policies_vehicle_id ON vehicle_policies(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_policies_status ON vehicle_policies(status);

-- Collega sinistri a polizza
ALTER TABLE vehicle_incidents
  ADD COLUMN IF NOT EXISTS policy_id UUID REFERENCES vehicle_policies(id) ON DELETE SET NULL;

-- Bollo e superbollo
CREATE TABLE IF NOT EXISTS vehicle_taxes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  region VARCHAR(100),
  kw_at_payment NUMERIC(10,2),
  bollo_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  superbollo_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_reference VARCHAR(100),
  due_date DATE,
  paid_date DATE,
  payment_method VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'da_pagare',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vehicle_id, year)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_taxes_vehicle_id ON vehicle_taxes(vehicle_id);

-- ZTL
CREATE TABLE IF NOT EXISTS vehicle_ztl (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  city VARCHAR(100),
  authorization_number VARCHAR(100),
  permit_type VARCHAR(50),
  valid_until DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_ztl_vehicle_id ON vehicle_ztl(vehicle_id);

-- Telepass su vehicles
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS telepass_serial VARCHAR(100),
  ADD COLUMN IF NOT EXISTS telepass_notes TEXT;
