-- Minimalna długość odcinka formatki dla linii bazowej.
ALTER TABLE machines
  ADD COLUMN baseline_min_length_mm REAL NOT NULL DEFAULT 650;
