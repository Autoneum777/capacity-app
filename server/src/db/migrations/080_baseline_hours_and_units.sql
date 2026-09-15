-- Dostępny czas tygodniowy i niezależne jednostki parametrów linii bazowej.
ALTER TABLE machines ADD COLUMN baseline_available_hours_per_week REAL NOT NULL DEFAULT 120;
ALTER TABLE machines ADD COLUMN baseline_max_throughput_unit TEXT NOT NULL DEFAULT 'kg/h';
ALTER TABLE machines ADD COLUMN baseline_min_throughput_unit TEXT NOT NULL DEFAULT 'kg/h';
ALTER TABLE machines ADD COLUMN baseline_max_speed_unit TEXT NOT NULL DEFAULT 'm/min';
ALTER TABLE machines ADD COLUMN baseline_min_speed_unit TEXT NOT NULL DEFAULT 'm/min';
ALTER TABLE machines ADD COLUMN baseline_max_blank_width_unit TEXT NOT NULL DEFAULT 'mm';
ALTER TABLE machines ADD COLUMN baseline_min_blank_width_unit TEXT NOT NULL DEFAULT 'mm';
ALTER TABLE machines ADD COLUMN baseline_max_blanks_across_unit TEXT NOT NULL DEFAULT 'szt';
