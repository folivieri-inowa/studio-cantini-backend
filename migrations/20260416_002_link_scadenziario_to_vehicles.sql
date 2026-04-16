-- Migration: 20260416_002_link_scadenziario_to_vehicles
-- Collega le scadenze ai veicoli del modulo Gestione Auto

ALTER TABLE scadenziario
  ADD COLUMN IF NOT EXISTS vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_module VARCHAR(50) DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_scadenziario_vehicle_id ON scadenziario(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_scadenziario_source_module ON scadenziario(source_module);
