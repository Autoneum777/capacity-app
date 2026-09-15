CREATE TABLE IF NOT EXISTS machine_baseline_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  alias TEXT,
  description TEXT,
  sap_number TEXT,
  grammage_kg_m2 REAL,
  width_mm REAL,
  length_mm REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_machine_baseline_materials_machine
  ON machine_baseline_materials(machine_id);
