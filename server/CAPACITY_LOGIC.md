# Logika obliczania obciążenia (load %) i capacity

Dokumentacja zgodna z `server/src/services/capacityService.ts` (komentarz w kodzie + implementacja).
Pełny przewodnik użytkownika (PL/EN/DE): **Administracja → Instrukcja obsługi** (sekcje 13–14: wzory i FAQ).

## 1. Dostępność bazowa maszyny [s/tydzień]

```
availability_base =
  (working_days_year / 52)
  × shift_time_seconds   // w UI: minuty zmiany (np. 450 = 7,5 h)
  × 60
  × shifts_per_day
  × OEE
  − startup_shutdown_seconds
```

- **working_days_year**, **shifts_per_day**, **working_weeks_per_year**, **startup_shutdown** — Ustawienia bazy → Dni robocze (profil Capacity albo OCU).
- **OEE** (priorytet): nadpisanie na operacji → nadpisanie na maszynie → `oee_factor` z ustawień roku (domyślnie 0,85).

## 2. Machine usage → dostępność efektywna

```
usage = clamp(machine_usage, 0.1, 1)   // domyślnie 1
effective_availability = availability_base / usage
```

Przykład: `usage = 0,5` → dwukrotnie większa efektywna capacity → obciążenie o połowę mniejsze przy tym samym wymaganym czasie.

## 3. Wolumen na tydzień [szt/tydzień]

| `volume_unit` | Przeliczenie |
|---------------|--------------|
| `annual` | `volume_value / working_weeks_per_year` (domyślnie 48) |
| `monthly` | `(volume_value × 12) / working_weeks_per_year` |
| `weekly` | `volume_value` |

### Priorytet źródła wolumenu (dla roku)

1. `operation_volume_by_year` (nadpisanie na operacji),
2. wolumeny projektu / detalu (produkcyjne lub kontraktowe — zależnie od przełącznika w nagłówku),
3. pola `volume_value` / `volume_unit` na operacji.

**Tryb kontraktowy:** najpierw `project_volumes_contract`; gdy brak — fallback do wolumenów produkcyjnych.

**Origin:** `default_all_years` vs `manual_year` — inne traktowanie lat częściowych względem SOP/EOP.
W tooltipie kalkulatora (szt./rok) dla `manual_year` pokazywana jest **wpisana suma** na rok/okres, a nie ekwiwalent pełnego roku z gęstości miesięcznej (obciążenie % nadal liczone z densyfikacji).

## 4. Wymagany czas [s/tydzień]

```
required_sec_per_week = Σ_operacje (
  weekly_volume × (cycle_time_seconds / max(1, nests_count))
)
```

- **Gniazdowość (`nests_count`):** liczba detali z jednego cyklu; czas na sztukę = cykl / gniazda.
- Jeśli `use_alternative_in_calculator`: używane są `alt_cycle_time_seconds`, `alt_nests_count`, `alt_oee_override`.

## 5. Obciążenie maszyny [%]

```
load_percent = round( (Σ required_sec) / effective_availability × 100 )
```

- Przy `effective_availability ≤ 0` i dodatnim wymaganym czasie → 100%.
- Wartość > 100% = przeciążenie.

## 6. SOP / EOP

- Format `MM.YYYY`. Poza zakresem produkcji wolumen = 0 (chyba że `include_in_calculator_after_eop` / ręczne nadpisanie roku).
- Ułamek roku / miesiąca / tygodnia ogranicza wolumen w okresach ramp-up / ramp-down.
- Rozwinięcie okresów: miesiące → tygodnie **ISO** (poniedziałek–niedziela).

## 7. Agregacje w kalkulatorze / Data Viz

- **Suma** = suma % widocznych maszyn.
- **Średnia** = suma / liczba maszyn.
- **Max średnia wg typu** = `max` po typach ze średnich % w typie (używane przy agregacji linii / wielu maszyn / zakładu na **wszystkich** wykresach w Wizualizacji danych).

### Wartość w komórce okresu

| Źródło | Rok | Miesiąc |
|--------|-----|---------|
| Produkcja / scenariusz | średnia z **12 miesięcy** (zera po EOP też wchodzą, np. 6×182 + 6×0 → 91) | średnia z tygodni w miesiącu |
| Call offs | średnia miesięcy od **pierwszego do ostatniego** miesiąca z danymi SAP w pliku | średnia tygodni w zakresie SAP w miesiącu |

W Call offs: zera **wewnątrz** zakresu SAP liczą się do średniej; zera **poza** zakresem są pomijane.

## 8. Call offs (mapowanie SAP)

1. Dopasowanie **dokładne** znormalizowanego `sap_number`,
2. inaczej dopasowanie **po obcięciu 2 ostatnich znaków**,
3. niedopasowane → raport CSV.

Zakres dat / miesięcy z wolumenem w pliku ogranicza, które okresy wchodzą do średniej Call offs (oraz które lata mają punkty na wykresach).

Gdy detal jest w systemie, ma operację na maszynie i w pliku SAP jest ilość > 0 w okresie, wolumen Call offs jest liczony **nawet bez** wolumenów produkcyjnych/kontraktowych oraz **nawet gdy** SOP/EOP projektu nie obejmuje tego roku (okres bierze się z pliku SAP).

## Uwagi operacyjne

- Profile **Capacity** i **OCU** mają osobne tabele dni roboczych; scenariusze zawsze liczą profilem Capacity.
- Przed importem Excel / czyszczeniem bazy wykonaj backup (Ustawienia administracyjne).
