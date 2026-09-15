-- Linia bazowa: flaga + parametry wydajności / formatki / odpadu bocznego
ALTER TABLE machines ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE machines ADD COLUMN baseline_max_throughput_kg_h REAL;
ALTER TABLE machines ADD COLUMN baseline_min_throughput_kg_h REAL;
ALTER TABLE machines ADD COLUMN baseline_max_speed_m_min REAL;
ALTER TABLE machines ADD COLUMN baseline_min_speed_m_min REAL;
ALTER TABLE machines ADD COLUMN baseline_max_blank_width_mm REAL;
ALTER TABLE machines ADD COLUMN baseline_min_blank_width_mm REAL;
ALTER TABLE machines ADD COLUMN baseline_max_blanks_across REAL;
ALTER TABLE machines ADD COLUMN baseline_side_scrap_value REAL;
ALTER TABLE machines ADD COLUMN baseline_side_scrap_unit TEXT NOT NULL DEFAULT 'mm';
