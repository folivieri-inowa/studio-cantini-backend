ALTER TABLE vehicle_tires DROP COLUMN IF EXISTS axle;
ALTER TABLE vehicle_tires ADD COLUMN IF NOT EXISTS size_front VARCHAR(50);
ALTER TABLE vehicle_tires ADD COLUMN IF NOT EXISTS size_rear VARCHAR(50);
-- migra i dati esistenti dal campo size generico
UPDATE vehicle_tires SET size_front = size, size_rear = size WHERE size IS NOT NULL AND size_front IS NULL;
