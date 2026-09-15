-- Materiał może pozostać przypisany do detali, ale nie obciążać capacity linii bazowej.
ALTER TABLE machine_baseline_materials
  ADD COLUMN include_in_capacity INTEGER NOT NULL DEFAULT 1;
