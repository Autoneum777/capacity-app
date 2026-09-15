-- Indywidualna liczba tygodni produkcyjnych w roku dla linii bazowej.
ALTER TABLE machines
  ADD COLUMN baseline_weeks_per_year REAL NOT NULL DEFAULT 52;
