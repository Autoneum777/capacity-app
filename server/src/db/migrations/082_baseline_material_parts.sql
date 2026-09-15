CREATE TABLE IF NOT EXISTS machine_baseline_material_parts (
  material_id INTEGER NOT NULL REFERENCES machine_baseline_materials(id) ON DELETE CASCADE,
  designation_id INTEGER NOT NULL REFERENCES part_designations(id) ON DELETE CASCADE,
  PRIMARY KEY (material_id, designation_id)
);

CREATE INDEX IF NOT EXISTS idx_baseline_material_parts_designation
  ON machine_baseline_material_parts(designation_id);
