-- Flaga wolumenu zewnętrznego dla materiału linii bazowej.
-- Gdy = 1, wolumen nie pochodzi z powiązanych detali, lecz z tabeli
-- machine_baseline_material_volumes (roczne wolumeny tygodniowe).
ALTER TABLE machine_baseline_materials
  ADD COLUMN use_external_volume INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS machine_baseline_material_volumes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES machine_baseline_materials(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  weekly_volume REAL NOT NULL DEFAULT 0,
  UNIQUE (material_id, year)
);
