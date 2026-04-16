-- Migration: 20260416_001_create_vehicles_module
-- Gestione Auto: tabelle base del dominio veicoli

-- -------------------------------------------------------
-- vehicles: anagrafica veicolo
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plate VARCHAR(20) NOT NULL,
  vin VARCHAR(50),
  make VARCHAR(100),
  model VARCHAR(100),
  registration_date DATE,
  vehicle_usage VARCHAR(100),
  fuel_type VARCHAR(50),
  kw NUMERIC(10,2),
  engine_cc INTEGER,
  seats INTEGER,
  status VARCHAR(30) NOT NULL DEFAULT 'attivo',
  owner_type VARCHAR(20),
  owner_name VARCHAR(255),
  availability_type VARCHAR(30),
  assignee_type VARCHAR(20),
  assignee_name VARCHAR(255),
  assignment_notes TEXT,
  purchase_date DATE,
  purchase_vendor VARCHAR(255),
  purchase_amount NUMERIC(12,2),
  purchase_notes TEXT,
  disposal_date DATE,
  disposal_buyer VARCHAR(255),
  disposal_amount NUMERIC(12,2),
  disposal_reason TEXT,
  disposal_notes TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(plate);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner_type ON vehicles(owner_type);
CREATE INDEX IF NOT EXISTS idx_vehicles_availability_type ON vehicles(availability_type);
CREATE INDEX IF NOT EXISTS idx_vehicles_assignee_name ON vehicles(assignee_name);

-- -------------------------------------------------------
-- vehicle_documents: documenti allegati al veicolo
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL,  -- es. libretto, assicurazione, bollo, revisione, altro
  title VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  document_date DATE,
  expiry_date DATE,
  related_entity_type VARCHAR(50),
  related_entity_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle_id ON vehicle_documents(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_expiry_date ON vehicle_documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_document_type ON vehicle_documents(document_type);

-- -------------------------------------------------------
-- vehicle_maintenance: interventi di manutenzione
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_maintenance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  maintenance_type VARCHAR(100) NOT NULL,  -- es. tagliando, freni, olio, filtri, etc.
  title VARCHAR(255) NOT NULL,
  maintenance_date DATE NOT NULL,
  mileage INTEGER,
  vendor VARCHAR(255),
  amount NUMERIC(12,2),
  next_due_date DATE,
  next_due_mileage INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_vehicle_id ON vehicle_maintenance(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_date ON vehicle_maintenance(maintenance_date);

-- -------------------------------------------------------
-- vehicle_tires: gestione pneumatici
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_tires (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  tire_type VARCHAR(30) NOT NULL,    -- estivi, invernali, 4stagioni
  brand VARCHAR(100),
  model VARCHAR(100),
  size VARCHAR(50),
  install_date DATE,
  mileage_at_install INTEGER,
  storage_location VARCHAR(255),
  condition VARCHAR(50),             -- buono, usura, da sostituire
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_tires_vehicle_id ON vehicle_tires(vehicle_id);

-- -------------------------------------------------------
-- vehicle_incidents: sinistri ed eventi straordinari
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_incidents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  incident_type VARCHAR(50) NOT NULL,  -- sinistro, furto, danno, altro
  title VARCHAR(255) NOT NULL,
  incident_date DATE NOT NULL,
  description TEXT,
  damage_amount NUMERIC(12,2),
  insurance_claim_number VARCHAR(100),
  status VARCHAR(30) DEFAULT 'aperto',  -- aperto, in_lavorazione, chiuso
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_incidents_vehicle_id ON vehicle_incidents(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_incidents_date ON vehicle_incidents(incident_date);

-- -------------------------------------------------------
-- vehicle_assignments_history: storico assegnazioni
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_assignments_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  assignee_type VARCHAR(20),
  assignee_name VARCHAR(255),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unassigned_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_vehicle_id ON vehicle_assignments_history(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_assignee_name ON vehicle_assignments_history(assignee_name);
