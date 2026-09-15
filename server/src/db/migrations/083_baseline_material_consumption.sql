-- Zużycie formatki materiału na jedną sztukę przypisanego detalu.
ALTER TABLE machine_baseline_material_parts
  ADD COLUMN consumption_per_detail REAL NOT NULL DEFAULT 1;
