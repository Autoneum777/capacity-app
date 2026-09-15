-- Udział wolumenu materiału produkowany w danym zakładzie (0-100%).
ALTER TABLE machine_baseline_materials
  ADD COLUMN production_share_percent REAL NOT NULL DEFAULT 100;
