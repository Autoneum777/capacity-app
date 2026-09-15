import { db } from '../db/connection.js';
import { formatDetailSapAliasLabel } from '../utils/detailLabel.js';
import { loadReferenceDisplayMode } from '../utils/referenceDisplayMode.js';
import type { MachineDimensionFilter } from '../utils/machineDimensionFilter.js';
import { appendMachineDimensionFilters } from '../utils/machineDimensionFilter.js';
import type { ScenarioBundle } from './scenarioSnapshotService.js';
import {
  getEffectiveVolumeForPartScenarioPreferContract,
  resolveSettingsForScenarioYear,
  scenarioHydratedOperationsForActiveProjects,
  effectiveOperationStatus,
} from './scenarioSnapshotService.js';
import {
  type CalculationSettingsProfile,
  getOcuDefaultTemplate,
  getOcuFallbackWorkingDaysForYear,
  getOcuSettingsForYear,
} from '../utils/ocuSettings.js';
import { getCapacityFallbackWorkingDaysForYear, getCapacityDefaultTemplate } from '../utils/capacitySettings.js';
import { mergeWorkingDaysWithDefaults, normalizeOverrideRow } from '../utils/workingDaysMerge.js';
import { parseSopEop, getProductionMonthsInYear, isMonthInProduction, getWeekCountInMonth } from '../utils/sopEopFormat.js';
import {
  type VolumePrefetchMaps,
  buildVolumePrefetchForYearRange,
  collectProjectPartIdsFromOperations,
  lookupEffectiveVolumeForPartPreferContract,
} from './volumePrefetch.js';
import {
  getSapMonthRangeForYear,
  getSapWeekRangeForMonth,
  averageLoadPercent,
} from './callOffService.js';
import {
  baselineAvailabilitySeconds,
  baselineRequiredSeconds,
  baselineRequiredSecondsPerMaterial,
  baselineMaterialHourlyCapacity,
  baselineExternalVolumeRequiredSeconds,
  loadBaselineMaterialIndex,
  loadBaselineExternalVolumeIndex,
  loadBaselineExternalMaterialIndex,
  orientBaselineDimensions,
  type BaselineMaterialIndex,
  type BaselineExternalVolumeIndex,
  type BaselineExternalMaterialIndex,
} from './baselineCapacityService.js';
import { resolveBaselineMaterialAlias } from '../utils/baselineMaterialMass.js';

export type MaterialBreakdownDetailItem = {
  project_label: string;
  detail_label: string;
  contribution_percent: number;
};

/** Rozbicie obciążenia maszyny bazowej na materiały (tooltip kalkulatora) — z wymiarem i gramaturą do etykiety. */
export type MaterialBreakdownItem = {
  material_alias: string | null;
  material_sap: string | null;
  material_width_mm: number | null;
  material_length_mm: number | null;
  material_grammage_kg_m2: number | null;
  contribution_percent: number;
  details: MaterialBreakdownDetailItem[];
};

function indexOperationsByMachine(operations: any[]): Map<number, any[]> {
  const map = new Map<number, any[]>();
  for (const o of operations) {
    const mid = Number(o.machine_id);
    if (!Number.isFinite(mid)) continue;
    const list = map.get(mid);
    if (list) list.push(o);
    else map.set(mid, [o]);
  }
  return map;
}

export type OperationYearVolumeRow = {
  volume_value: number;
  volume_unit: string;
  volume_value_before?: number | null;
  effective_from_month?: number | null;
  effective_from_week?: number | null;
  /** `allocation` | `manual` — z operation_volume_by_year.source */
  source?: string | null;
};

export type CapacityComputeShared = {
  operations: any[];
  operationsByMachine: Map<number, any[]>;
  baselineMaterials: BaselineMaterialIndex;
  baselineExternalVolumes: BaselineExternalVolumeIndex;
  baselineExternalMaterials: BaselineExternalMaterialIndex;
  refMode: ReturnType<typeof loadReferenceDisplayMode>;
  volumePrefetchByYear: Map<number, VolumePrefetchMaps>;
  opVolumeMapByYear: Map<number, Map<number, OperationYearVolumeRow>>;
  settingsByYear: Map<number, WorkingDaysRow>;
  scenarioSnapshot: ScenarioBundle | null;
  effectiveProfile: CalculationSettingsProfile;
  scenarioRfqMachineIds: number[];
  /** Maszyny hostujące wybrane operacje RFQ (mogą mieć status RFQ — trzeba je dociągnąć do zapytania). */
  includeRfqMachineIds: number[];
  /** Cache udziałów SAP: klucz = year|month|week|contract */
  callOffShareCache?: Map<string, Map<number, number>>;
};

const CAPACITY_OPS_SELECT = `
    SELECT o.id AS operation_id, o.project_id, o.part_id, o.machine_id, o.cycle_time_seconds, o.volume_value, o.volume_unit, o.nests_count, o.oee_override, o.capacity_percent,
           o.alt_cycle_time_seconds, o.alt_nests_count, o.alt_oee_override, o.use_alternative_in_calculator, o.split_from_operation_id,
           p.sop, p.eop, p.status AS project_status, p.client AS project_client, p.name AS project_name,
           pd.sap_number AS detail_sap_number,
           pd.alias AS detail_alias,
           pd.free_text AS detail_free_text,
           pd.id AS detail_designation_id,
           pt.designation AS detail_designation
    FROM operations o
    JOIN projects p ON p.id = o.project_id
    JOIN parts pt ON pt.id = o.part_id
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
`;

function normalizeIncludeRfqOperationIds(ids?: number[] | null): number[] {
  if (!ids?.length) return [];
  return [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
}

function loadRfqOperationsByIds(operationIds: number[]): any[] {
  const ids = normalizeIncludeRfqOperationIds(operationIds);
  if (!ids.length) return [];
  return db
    .prepare(`${CAPACITY_OPS_SELECT} WHERE p.status = 'RFQ' AND o.id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as any[];
}

function mergeOperationsById(base: any[], extra: any[]): any[] {
  if (!extra.length) return base;
  const byId = new Map<number, any>();
  for (const o of base) {
    const id = Number(o.operation_id ?? o.id);
    if (Number.isFinite(id)) byId.set(id, o);
  }
  for (const o of extra) {
    const id = Number(o.operation_id ?? o.id);
    if (Number.isFinite(id)) byId.set(id, o);
  }
  return [...byId.values()];
}

const BASELINE_INFERRED_OPERATION = 'baseline_material_demand';

function baselineSyntheticOperationId(machineId: number, partId: number): number {
  return -(machineId * 1_000_000_000 + partId);
}

/**
 * Linia bazowa nie wymaga ręcznego dodawania operacji. Jej popyt wynika
 * automatycznie z: materiał → detal katalogowy → wystąpienia detalu w projektach.
 */
function loadBaselineMaterialDemandOperations(
  scenario: ScenarioBundle | null,
  allowedProjectIds?: Set<number>
): any[] {
  const links = db
    .prepare(
      `SELECT DISTINCT bm.machine_id, bmp.designation_id
       FROM machine_baseline_material_parts bmp
       JOIN machine_baseline_materials bm ON bm.id = bmp.material_id
       JOIN machines m ON m.id = bm.machine_id
       WHERE m.is_baseline = 1
         AND bm.include_in_capacity = 1`
    )
    .all() as { machine_id: number; designation_id: number }[];
  if (!links.length) return [];

  const machinesByDesignation = new Map<number, number[]>();
  for (const link of links) {
    const did = Number(link.designation_id);
    const list = machinesByDesignation.get(did);
    if (list) list.push(Number(link.machine_id));
    else machinesByDesignation.set(did, [Number(link.machine_id)]);
  }

  const parts = scenario
    ? scenario.parts ?? []
    : (db.prepare('SELECT * FROM parts').all() as any[]);
  const projects = scenario
    ? scenario.projects ?? []
    : (db.prepare('SELECT * FROM projects').all() as any[]);
  const designations = scenario
    ? scenario.part_designations ?? []
    : (db.prepare('SELECT * FROM part_designations').all() as any[]);
  const projectsById = new Map(projects.map((p: any) => [Number(p.id), p]));
  const designationsById = new Map(designations.map((d: any) => [Number(d.id), d]));
  const result: any[] = [];

  for (const part of parts) {
    const partId = Number(part.id);
    const projectId = Number(part.project_id);
    const designationId = Number(part.designation_id);
    if (![partId, projectId, designationId].every(Number.isFinite)) continue;
    if (allowedProjectIds && !allowedProjectIds.has(projectId)) continue;
    const project: any = projectsById.get(projectId);
    if (!project || String(project.status ?? 'active') !== 'active') continue;
    const designation: any = designationsById.get(designationId);
    for (const machineId of machinesByDesignation.get(designationId) ?? []) {
      result.push({
        operation_id: baselineSyntheticOperationId(machineId, partId),
        project_id: projectId,
        part_id: partId,
        machine_id: machineId,
        cycle_time_seconds: 0,
        nests_count: 1,
        capacity_percent: 100,
        split_from_operation_id: null,
        sop: project.sop ?? '',
        eop: project.eop ?? '',
        project_status: project.status ?? 'active',
        project_client: project.client ?? '',
        project_name: project.name ?? '',
        detail_sap_number: designation?.sap_number ?? null,
        detail_alias: designation?.alias ?? null,
        detail_free_text: designation?.free_text ?? null,
        detail_designation_id: designationId,
        detail_designation: part.designation ?? null,
        baseline_inferred_source: BASELINE_INFERRED_OPERATION,
      });
    }
  }
  return result;
}

export function resolveMachineIdsForRfqOperations(operationIds: number[]): number[] {
  const ops = loadRfqOperationsByIds(operationIds);
  return [
    ...new Set(
      ops
        .map((o) => Number(o.machine_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
}

function loadOpVolumeMapsForYearRange(yearFrom: number, yearTo: number): Map<number, Map<number, OperationYearVolumeRow>> {
  const byYear = new Map<number, Map<number, OperationYearVolumeRow>>();
  for (let y = yearFrom; y <= yearTo; y++) byYear.set(y, new Map());
  try {
    const rows = db
      .prepare(
        `SELECT operation_id, year, volume_value, volume_unit, volume_value_before, effective_from_month, effective_from_week,
                COALESCE(source, 'manual') AS source
         FROM operation_volume_by_year WHERE year >= ? AND year <= ?`
      )
      .all(yearFrom, yearTo) as {
      operation_id: number;
      year: number;
      volume_value: number;
      volume_unit: string;
      volume_value_before: number | null;
      effective_from_month: number | null;
      effective_from_week: number | null;
      source: string;
    }[];
    for (const r of rows) {
      const yMap = byYear.get(r.year);
      if (yMap) {
        yMap.set(r.operation_id, {
          volume_value: r.volume_value,
          volume_unit: r.volume_unit,
          volume_value_before: r.volume_value_before,
          effective_from_month: r.effective_from_month,
          effective_from_week: r.effective_from_week,
          source: r.source,
        });
      }
    }
  } catch (_) {
    try {
      const rows = db
        .prepare('SELECT operation_id, year, volume_value, volume_unit FROM operation_volume_by_year WHERE year >= ? AND year <= ?')
        .all(yearFrom, yearTo) as { operation_id: number; year: number; volume_value: number; volume_unit: string }[];
      for (const r of rows) {
        const yMap = byYear.get(r.year);
        if (yMap) yMap.set(r.operation_id, r);
      }
    } catch (__) {}
  }
  return byYear;
}

function buildCapacityComputeShared(
  yearFrom: number,
  yearTo: number,
  operationsOverride: any[] | undefined,
  scenarioSnapshot: ScenarioBundle | null | undefined,
  settingsProfile: CalculationSettingsProfile | undefined,
  includeRfqOperationIds?: number[]
): CapacityComputeShared {
  const scenario = scenarioSnapshot ?? null;
  const effectiveProfile: CalculationSettingsProfile = scenario != null ? 'capacity' : (settingsProfile ?? 'capacity');
  let operations =
    operationsOverride ??
    (db.prepare(`${CAPACITY_OPS_SELECT} WHERE p.status = 'active'`).all() as any[]);
  let includeRfqMachineIds: number[] = [];

  /** Filtr RFQ z wizualizacji — tylko poza ścieżką scenariusza (operationsOverride). */
  if (!operationsOverride) {
    const rfqOps = loadRfqOperationsByIds(includeRfqOperationIds ?? []);
    if (rfqOps.length) {
      operations = mergeOperationsById(operations, rfqOps);
      includeRfqMachineIds = [
        ...new Set(
          rfqOps
            .map((o) => Number(o.machine_id))
            .filter((id) => Number.isFinite(id) && id > 0)
        ),
      ];
    }
  }

  const allowedBaselineProjects =
    operationsOverride != null
      ? new Set(
          operationsOverride
            .map((o: any) => Number(o.project_id))
            .filter((id: number) => Number.isFinite(id))
        )
      : undefined;
  operations = mergeOperationsById(
    operations,
    loadBaselineMaterialDemandOperations(scenario, allowedBaselineProjects)
  );

  const { projectIds, partIds } = collectProjectPartIdsFromOperations(operations);
  const settingsByYear = new Map<number, WorkingDaysRow>();
  for (let y = yearFrom; y <= yearTo; y++) {
    settingsByYear.set(
      y,
      scenario != null
        ? resolveSettingsForScenarioYear(y, scenario) ?? resolveSettingsForYear(y, 'capacity')
        : resolveSettingsForYear(y, effectiveProfile)
    );
  }

  return {
    operations,
    operationsByMachine: indexOperationsByMachine(operations),
    baselineMaterials: loadBaselineMaterialIndex(),
    baselineExternalVolumes: loadBaselineExternalVolumeIndex(),
    baselineExternalMaterials: loadBaselineExternalMaterialIndex(),
    refMode: loadReferenceDisplayMode(),
    volumePrefetchByYear:
      scenario != null ? new Map() : buildVolumePrefetchForYearRange(yearFrom, yearTo, projectIds, partIds),
    opVolumeMapByYear:
      scenario != null
        ? (() => {
            const byYear = new Map<number, Map<number, OperationYearVolumeRow>>();
            for (let y = yearFrom; y <= yearTo; y++) {
              const rows = (scenario.operation_volume_by_year || []).filter((v: any) => Number(v.year) === y) as {
                operation_id: number;
                volume_value: number;
                volume_unit: string;
                volume_value_before?: number | null;
                effective_from_month?: number | null;
                effective_from_week?: number | null;
              }[];
              byYear.set(
                y,
                new Map(
                  rows.map((v) => [
                    Number(v.operation_id),
                    {
                      volume_value: v.volume_value,
                      volume_unit: v.volume_unit,
                      volume_value_before: v.volume_value_before,
                      effective_from_month: v.effective_from_month,
                      effective_from_week: v.effective_from_week,
                      source: (v as { source?: string | null }).source ?? null,
                    },
                  ])
                )
              );
            }
            return byYear;
          })()
        : loadOpVolumeMapsForYearRange(yearFrom, yearTo),
    settingsByYear,
    scenarioSnapshot: scenario,
    effectiveProfile,
    scenarioRfqMachineIds: [],
    includeRfqMachineIds,
    callOffShareCache: new Map(),
  };
}

function formatProjectLabel(client: string | null | undefined, name: string | null | undefined): string {
  const c = String(client ?? '').trim();
  const n = String(name ?? '').trim();
  if (c && n) return `${c} · ${n}`;
  return n || c || '—';
}

/** Maszyny RFQ w produkcji z operacją w scenariuszu w projekcie liczonym w kalkulatorze (active / ewent. RFQ). */
function scenarioLinkedRfqProductionMachineIds(snapshot: ScenarioBundle, includeRfqProjects: boolean): number[] {
  const candidateMids = new Set<number>();
  for (const o of snapshot.operations || []) {
    const eff = effectiveOperationStatus(snapshot, o);
    if (eff === 'inactive') continue;
    if (eff === 'RFQ' && !includeRfqProjects) continue;
    if (eff !== 'active' && eff !== 'RFQ') continue;
    const mid = Number((o as any).machine_id);
    if (Number.isFinite(mid) && mid > 0) candidateMids.add(mid);
  }
  if (candidateMids.size === 0) return [];
  const ids = [...candidateMids];
  const ph = ids.map(() => '?').join(',');
  const rfqRows = db.prepare(`SELECT id FROM machines WHERE status = 'RFQ' AND id IN (${ph})`).all(...ids) as { id: number }[];
  return rfqRows.map((r) => r.id);
}

/**
 * LOGIKA OBLICZANIA OBCIĄŻENIA (load_percent) I CAPACITY
 * --------------------------------------------------------
 * 1) Dostępność maszyny [s/tydzień]:
 *    availability_sec_per_week = (working_days_year / 52) * shift_time_seconds * 60 * shifts_per_day * OEE - startup_shutdown_seconds
 *    - working_days_year: liczba dni roboczych w roku (z ustawień Dni robocze)
 *    - shift_time_seconds: czas jednej zmiany w MINUTACH (np. 450 = 7,5 h)
 *    - shifts_per_day: liczba zmian na dobę (1, 2, 3) – z ustawień
 *    - OEE: z operacji lub maszyny lub domyślny z ustawień
 *
 * 2) Wolumen na tydzień [szt/tydzień]:
 *    - Dla volume_unit = 'annual': volume_value / working_weeks_per_year (domyślnie 48 pracujących tygodni)
 *    - Dla 'monthly': (volume_value * 12) / working_weeks_per_year
 *    - Dla 'weekly': volume_value
 *
 * 3) Wymagany czas [s/tydzień] na maszynie:
 *    required_sec_per_week = suma po operacjach: (weekly_volume * (cycle_time_seconds / max(1, nests_count)))
 *    Gniazdowość (nests_count) = liczba detali z jednego cyklu – czas na sztukę = cykl / gniazd.
 *    Dla operacji można podać wolumen per rok w operation_volume_by_year – ma pierwszeństwo przed wolumenem z projektu/detalu i przed polami operacji.
 *
 * 4) Obciążenie:
 *    load_percent = round((required_sec_per_week / availability_sec_per_week) * 100)
 */

/** Calendar weeks per year (for days-per-week conversion). */
const CALENDAR_WEEKS_PER_YEAR = 52;

function volumeSettingsForMachine(settings: WorkingDaysRow, machine: any): WorkingDaysRow {
  if (!Number(machine?.is_baseline)) return settings;
  const rawWeeks = Number(machine?.baseline_weeks_per_year);
  const weeks = Number.isFinite(rawWeeks) ? Math.max(1, Math.min(53, rawWeeks)) : 52;
  return { ...settings, working_weeks_per_year: weeks };
}

/** Domyślne „Dni robocze” gdy w bazie brak wpisu dla danego roku (szablon z ustawień). */
export const DEFAULT_WORKING_DAYS_SETTINGS = {
  working_days_year: 252,
  oee_factor: 0.85,
  shift_time_seconds: 450,
  startup_shutdown_seconds: 720,
  working_weeks_per_year: 48,
  shifts_per_day: 3,
} as const;

export interface WorkingDaysRow {
  id: number;
  year: number;
  working_days_year: number;
  oee_factor: number;
  shift_time_seconds: number; // czas jednej zmiany w minutach (np. 450 = 7,5 h)
  startup_shutdown_seconds: number;
  working_weeks_per_year?: number; // pracujące tygodnie w roku (np. 48)
  shifts_per_day?: number; // liczba zmian na dobę (1, 2, 3)
  /** Zgodnie z kolumną `status` w `working_days` (np. przy zapytaniach SQL). */
  status?: string;
}

export function getSettingsForYear(year: number): WorkingDaysRow | null {
  const row = db.prepare('SELECT * FROM working_days WHERE year = ? AND status = ?').get(year, 'active') as WorkingDaysRow | undefined;
  const raw = row ?? (db.prepare('SELECT * FROM working_days WHERE year = ?').get(year) as WorkingDaysRow | undefined);
  if (!raw) return null;
  return mergeWorkingDaysWithDefaults(normalizeOverrideRow(raw), getCapacityDefaultTemplate());
}

/** Gdy w bazie brak wpisu working_days dla danego roku – szablon domyślny z ustawień administracyjnych. */
export function getFallbackWorkingDaysForYear(year: number): WorkingDaysRow {
  return getCapacityFallbackWorkingDaysForYear(year);
}

export type { CalculationSettingsProfile };

export function resolveSettingsForYear(year: number, profile: CalculationSettingsProfile = 'capacity'): WorkingDaysRow {
  if (profile === 'ocu') {
    return getOcuSettingsForYear(year) ?? getOcuFallbackWorkingDaysForYear(year);
  }
  return getSettingsForYear(year) ?? getFallbackWorkingDaysForYear(year);
}

/**
 * Dostępność maszyny [s/tydzień]:
 * (dni_robocze_w_roku / 52) * (minuty_na_zmianę * 60) * liczba_zmian_na_dobę * OEE - startup_shutdown_seconds.
 * Uwzględnia liczbę zmian produkcyjnych i pracujące tygodnie tylko pośrednio przez working_days_year.
 */
export function availabilitySecondsPerWeek(settings: WorkingDaysRow, oee: number): number {
  const shiftMinutes = settings.shift_time_seconds;
  const shiftsPerDay = Math.max(1, settings.shifts_per_day ?? 1);
  const secPerWeek = (settings.working_days_year / CALENDAR_WEEKS_PER_YEAR) * shiftMinutes * 60 * shiftsPerDay * oee;
  return Math.max(0, Math.round(secPerWeek - (settings.startup_shutdown_seconds ?? 0)));
}

/** Resolve OEE: operation override > machine override > settings default. */
export function resolveOee(settings: WorkingDaysRow, machineOee: number | null, operationOee: number | null): number {
  if (operationOee != null && operationOee > 0) return operationOee;
  if (machineOee != null && machineOee > 0) return machineOee;
  return settings.oee_factor;
}

/** Zdefiniowany drugi wariant czasu (wpisany dodatni alt_cycle_time_seconds). */
export function operationHasAlternativeCycle(op: { alt_cycle_time_seconds?: number | null }): boolean {
  const a = op.alt_cycle_time_seconds;
  return a != null && Number(a) > 0;
}

/** Czas / gniazda / OEE wg wyboru „podstawowy vs alternatywa” dla kalkulatora i alokacji. */
export function resolveOperationCycleForCalculator(op: any): {
  cycleSeconds: number;
  nests: number;
  oeeForResolve: number | null;
  usesAlternativeInCalculator: boolean;
} {
  const hasAlt = operationHasAlternativeCycle(op);
  const useAlt = hasAlt && (Number(op.use_alternative_in_calculator) === 1 || op.use_alternative_in_calculator === true);
  const cycleSeconds = useAlt ? Number(op.alt_cycle_time_seconds) : Number(op.cycle_time_seconds);
  const nestsRaw = useAlt
    ? op.alt_nests_count != null && Number(op.alt_nests_count) > 0
      ? Number(op.alt_nests_count)
      : Number(op.nests_count ?? 1)
    : Number(op.nests_count ?? 1);
  const nests = Math.max(1, nestsRaw || 1);
  const oeeForResolve =
    useAlt && op.alt_oee_override != null && Number(op.alt_oee_override) > 0
      ? Number(op.alt_oee_override)
      : op.oee_override != null
        ? Number(op.oee_override)
        : null;
  return { cycleSeconds, nests, oeeForResolve, usesAlternativeInCalculator: !!useAlt };
}

/**
 * Konwersja wolumenu na szt/tydzień.
 * Dla annual: volume / working_weeks_per_year (np. 48).
 * Dla monthly: (volume * 12) / working_weeks_per_year.
 */
export function volumeToWeekly(volumeValue: number, volumeUnit: 'annual' | 'monthly' | 'weekly', settings: WorkingDaysRow): number {
  const workWeeks = Math.max(1, settings.working_weeks_per_year ?? 48);
  if (volumeUnit === 'weekly') return volumeValue;
  if (volumeUnit === 'annual') return volumeValue / workWeeks;
  if (volumeUnit === 'monthly') return (volumeValue * 12) / workWeeks;
  return volumeValue / workWeeks;
}

/** Tygodniowy wolumen → ilość do tooltipa (roczna / miesięczna / tygodniowa). */
export function weeklyToDisplayVolume(
  weekly: number,
  period: 'annual' | 'monthly' | 'weekly',
  workWeeks: number
): number {
  const ww = Math.max(1, workWeeks);
  if (period === 'weekly') return weekly;
  if (period === 'monthly') return (weekly * ww) / 12;
  return weekly * ww;
}

/**
 * Ilość w tooltipie detail_breakdown.
 * Dla okresu rocznego + jednostka annual + manual_year: pokaż wpisaną sumę na rok/okres
 * (np. 10002), bez ponownego „×12/miesiące” jak przy gęstości obciążenia.
 */
export function resolvedVolumeToTooltipQuantity(
  volumeValue: number,
  volumeUnit: 'annual' | 'monthly' | 'weekly',
  weekly: number,
  period: 'annual' | 'monthly' | 'weekly',
  workWeeks: number,
  opts: {
    volume_origin: VolumeEntryOrigin;
    production_months: number;
    fraction: number;
  }
): number {
  if (period === 'weekly') return weekly;
  if (period === 'monthly') return weeklyToDisplayVolume(weekly, 'monthly', workWeeks);

  // period === 'annual'
  if (volumeUnit === 'annual') {
    if (opts.volume_origin === 'manual_year') return volumeValue;
    const frac = opts.fraction > 0 && opts.fraction < 1 ? opts.fraction : 1;
    return volumeValue * frac;
  }
  if (volumeUnit === 'monthly') {
    const months =
      opts.production_months > 0 && opts.production_months <= 12 ? opts.production_months : 12;
    return volumeValue * months;
  }
  return weeklyToDisplayVolume(weekly, 'annual', workWeeks);
}

/** volume_quantity z breakdown tygodniowego → jednostka miesięczna (tooltip miesiąca). */
export function convertBreakdownVolumesWeeklyToMonthly<
  T extends { volume_quantity?: number | null },
>(details: T[], workWeeks: number): T[] {
  const ww = Math.max(1, workWeeks);
  return details.map((d) => {
    const q = d.volume_quantity;
    if (q == null || !Number.isFinite(Number(q))) return d;
    return {
      ...d,
      volume_quantity: Math.round(weeklyToDisplayVolume(Number(q), 'monthly', ww) * 100) / 100,
    };
  });
}

/**
 * Ułamek roku dla capacity: pierwszy rok od startMonth, ostatni do endMonth (SOP/EOP w formacie MM.YYYY).
 */
export function getYearFractionFromSopEop(sop: string, eop: string, year: number): number {
  const months = getProductionMonthsInYear(sop, eop, year);
  if (months <= 0) return 0;
  return months / 12;
}

export type VolumeEntryOrigin = 'default_all_years' | 'manual_year';

export function normalizeVolumeOrigin(raw: unknown): VolumeEntryOrigin {
  return String(raw ?? '').trim() === 'default_all_years' ? 'default_all_years' : 'manual_year';
}

/**
 * Tygodniowy wolumen efektywny dla operacji w roku.
 * - default_all_years + rok niepełny: annual × (miesiące/12) ÷ tygodnie robocze (dotychczasowa logika).
 * - manual_year + rok niepełny + jednostka roczna: wpisana wartość ÷ miesiące produkcyjne → miesięczna, potem na tygodniową.
 * - manual_year + rok pełny: bez korekty SOP/EOP.
 */
export function resolveWeeklyVolumeFromResolved(
  volumeValue: number,
  volumeUnit: 'annual' | 'monthly' | 'weekly',
  settings: WorkingDaysRow,
  opts: {
    sop?: string;
    eop?: string;
    year: number;
    volume_origin: VolumeEntryOrigin;
    count_after_eop?: boolean;
    has_project?: boolean;
  }
): { weekly: number; fraction: number; production_months: number } {
  const sop = opts.sop ?? '';
  const eop = opts.eop ?? '';
  const prodMonths = getProductionMonthsInYear(sop, eop, opts.year);
  const isPartial = prodMonths > 0 && prodMonths < 12;

  if (opts.count_after_eop || !opts.has_project) {
    return {
      weekly: volumeToWeekly(volumeValue, volumeUnit, settings),
      fraction: 1,
      production_months: prodMonths || 12,
    };
  }

  if (prodMonths <= 0) {
    return { weekly: 0, fraction: 0, production_months: 0 };
  }

  if (opts.volume_origin === 'manual_year') {
    if (isPartial && volumeUnit === 'annual') {
      const monthly = volumeValue / prodMonths;
      return {
        weekly: volumeToWeekly(monthly, 'monthly', settings),
        fraction: 1,
        production_months: prodMonths,
      };
    }
    return {
      weekly: volumeToWeekly(volumeValue, volumeUnit, settings),
      fraction: 1,
      production_months: prodMonths || 12,
    };
  }

  const fraction = getYearFractionFromSopEop(sop, eop, opts.year);
  return {
    weekly: volumeToWeekly(volumeValue, volumeUnit, settings) * fraction,
    fraction,
    production_months: prodMonths || 12,
  };
}

export type EffectiveVolumeResult = {
  volume_value: number;
  volume_unit: 'annual' | 'monthly' | 'weekly';
  count_after_eop?: boolean; // true = liczyć w kalkulatorze mimo roku po EOP (zmienione ręcznie)
  volume_origin?: VolumeEntryOrigin;
};

/** Zwraca skuteczny wolumen dla detalu w danym roku (projekt → tryb detalu → własna wartość). Gdy brak: null = użyj volume_value/volume_unit z operacji. */
export function getEffectiveVolumeForPart(
  projectId: number,
  partId: number,
  year: number
): EffectiveVolumeResult | null {
  let pv: { volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number; volume_origin?: string } | undefined;
  let projectEop: string | null = null;
  let part: { volume_mode: string; volume_share_percent: number | null; default_volume_value?: number | null; default_volume_unit?: string | null } | undefined;
  let partVol: { volume_value: number; volume_unit: string; volume_origin?: string } | undefined;
  try {
    pv = db.prepare('SELECT volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes WHERE project_id = ? AND year = ?').get(projectId, year) as any;
    const proj = db.prepare('SELECT eop FROM projects WHERE id = ?').get(projectId) as { eop: string } | undefined;
    projectEop = proj?.eop ?? null;
    part = db.prepare('SELECT volume_mode, volume_share_percent, default_volume_value, default_volume_unit FROM parts WHERE id = ?').get(partId) as any;
    partVol = db.prepare('SELECT volume_value, volume_unit, volume_origin FROM part_volume_by_year WHERE part_id = ? AND year = ?').get(partId, year) as any;
  } catch (_) {
    return null;
  }
  const eopYear = parseSopEop(projectEop)?.year ?? null;
  const isAfterEop = eopYear != null && year > eopYear;
  const countAfterEop = isAfterEop && pv && Number(pv.include_in_calculator_after_eop) === 1;

  const volumeOriginFromRow = (row: { volume_origin?: string } | undefined, fallback: VolumeEntryOrigin): VolumeEntryOrigin =>
    normalizeVolumeOrigin(row?.volume_origin ?? fallback);

  const mode = part?.volume_mode ?? 'project';
  if (mode === 'override') {
    if (partVol)
      return {
        volume_value: partVol.volume_value,
        volume_unit: partVol.volume_unit as any,
        count_after_eop: countAfterEop || undefined,
        volume_origin: volumeOriginFromRow(partVol, 'manual_year'),
      };
    if (part?.default_volume_value != null && part?.default_volume_unit) {
      const u = ['annual', 'monthly', 'weekly'].includes(part.default_volume_unit) ? part.default_volume_unit : 'annual';
      return {
        volume_value: Number(part.default_volume_value),
        volume_unit: u as any,
        count_after_eop: countAfterEop || undefined,
        volume_origin: 'default_all_years',
      };
    }
  }
  if (mode === 'project' && pv) {
    return {
      volume_value: pv.volume_value,
      volume_unit: pv.volume_unit as any,
      count_after_eop: countAfterEop || undefined,
      volume_origin: volumeOriginFromRow(pv, 'manual_year'),
    };
  }
  if (mode === 'share' && pv) {
    let sharePct: number | null = null;
    try {
      const row = db.prepare('SELECT share_percent FROM part_volume_share_by_year WHERE part_id = ? AND year = ?').get(partId, year) as { share_percent: number } | undefined;
      if (row != null) sharePct = row.share_percent;
    } catch (_) {}
    if (sharePct == null) sharePct = part?.volume_share_percent ?? null;
    if (sharePct != null) {
      const share = Math.max(0, Math.min(100, Number(sharePct))) / 100;
      return {
        volume_value: pv.volume_value * share,
        volume_unit: pv.volume_unit as any,
        count_after_eop: countAfterEop || undefined,
        volume_origin: volumeOriginFromRow(pv, 'manual_year'),
      };
    }
  }
  return null;
}

/** Wolumeny kontraktowe z DB; brak danych kontraktowych dla trybu/roku → null (wtedy fallback do produkcji). */
export function getEffectiveVolumeForPartContract(projectId: number, partId: number, year: number): EffectiveVolumeResult | null {
  let pvc: { volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number; volume_origin?: string } | undefined;
  let pvProd: { volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number; volume_origin?: string } | undefined;
  let projectEop: string | null = null;
  let part: {
    contract_volume_mode?: string;
    contract_volume_share_percent?: number | null;
    contract_default_volume_value?: number | null;
    contract_default_volume_unit?: string | null;
  } | undefined;
  let partVolC: { volume_value: number; volume_unit: string; volume_origin?: string } | undefined;
  try {
    pvc = db
      .prepare(
        'SELECT volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes_contract WHERE project_id = ? AND year = ?'
      )
      .get(projectId, year) as any;
    pvProd = db
      .prepare(
        'SELECT volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes WHERE project_id = ? AND year = ?'
      )
      .get(projectId, year) as any;
    const proj = db.prepare('SELECT eop FROM projects WHERE id = ?').get(projectId) as { eop: string } | undefined;
    projectEop = proj?.eop ?? null;
    part = db
      .prepare(
        'SELECT contract_volume_mode, contract_volume_share_percent, contract_default_volume_value, contract_default_volume_unit FROM parts WHERE id = ?'
      )
      .get(partId) as any;
    partVolC = db
      .prepare('SELECT volume_value, volume_unit, volume_origin FROM part_volume_contract_by_year WHERE part_id = ? AND year = ?')
      .get(partId, year) as any;
  } catch (_) {
    return null;
  }
  const eopYear = parseSopEop(projectEop)?.year ?? null;
  const isAfterEop = eopYear != null && year > eopYear;
  const pvForEop = pvc ?? pvProd;
  const countAfterEop = isAfterEop && pvForEop && Number(pvForEop.include_in_calculator_after_eop) === 1;

  const volumeOriginFromRow = (row: { volume_origin?: string } | undefined, fallback: VolumeEntryOrigin): VolumeEntryOrigin =>
    normalizeVolumeOrigin(row?.volume_origin ?? fallback);

  const mode = part?.contract_volume_mode ?? 'project';
  if (mode === 'override') {
    if (partVolC) {
      return {
        volume_value: partVolC.volume_value,
        volume_unit: partVolC.volume_unit as any,
        count_after_eop: countAfterEop || undefined,
        volume_origin: volumeOriginFromRow(partVolC, 'manual_year'),
      };
    }
    if (part?.contract_default_volume_value != null && part?.contract_default_volume_unit) {
      const u = ['annual', 'monthly', 'weekly'].includes(part.contract_default_volume_unit) ? part.contract_default_volume_unit : 'annual';
      return {
        volume_value: Number(part.contract_default_volume_value),
        volume_unit: u as any,
        count_after_eop: countAfterEop || undefined,
        volume_origin: 'default_all_years',
      };
    }
    return { volume_value: 0, volume_unit: 'annual', count_after_eop: countAfterEop || undefined, volume_origin: 'manual_year' };
  }
  if (mode === 'project' && pvc && Number(pvc.volume_value) > 0) {
    return {
      volume_value: pvc.volume_value,
      volume_unit: pvc.volume_unit as any,
      count_after_eop: countAfterEop || undefined,
      volume_origin: volumeOriginFromRow(pvc, 'manual_year'),
    };
  }
  if (mode === 'share' && pvc && Number(pvc.volume_value) > 0) {
    let sharePct: number | null = null;
    try {
      const row = db
        .prepare('SELECT share_percent FROM part_volume_contract_share_by_year WHERE part_id = ? AND year = ?')
        .get(partId, year) as { share_percent: number } | undefined;
      if (row != null) sharePct = row.share_percent;
    } catch (_) {}
    if (sharePct == null) sharePct = part?.contract_volume_share_percent ?? null;
    if (sharePct != null) {
      const share = Math.max(0, Math.min(100, Number(sharePct))) / 100;
      return {
        volume_value: pvc.volume_value * share,
        volume_unit: pvc.volume_unit as any,
        count_after_eop: countAfterEop || undefined,
        volume_origin: volumeOriginFromRow(pvc, 'manual_year'),
      };
    }
  }
  return null;
}

/** Przy włączonych wolumenach kontraktowych: kontrakt, a gdy brak — produkcja. */
export function getEffectiveVolumeForPartPreferContract(
  projectId: number,
  partId: number,
  year: number,
  useContractual: boolean
): EffectiveVolumeResult | null {
  if (!useContractual) return getEffectiveVolumeForPart(projectId, partId, year);
  return getEffectiveVolumeForPartContract(projectId, partId, year) ?? getEffectiveVolumeForPart(projectId, partId, year);
}

function totalCalculatorWeeksInYear(year: number): number {
  let n = 0;
  for (let m = 1; m <= 12; m++) n += getWeekCountInMonth(year, m);
  return Math.max(1, n);
}

/** Liczba tygodni (T1…Tn) ściśle przed wskazanym miesiącem/tygodniem. */
function weeksBeforeEffectiveFrom(year: number, fromMonth: number, fromWeek: number): number {
  const month = Math.min(12, Math.max(1, Math.floor(fromMonth) || 1));
  const weekCount = getWeekCountInMonth(year, month);
  const week = Math.min(weekCount, Math.max(1, Math.floor(fromWeek) || 1));
  let n = 0;
  for (let m = 1; m < month; m++) n += getWeekCountInMonth(year, m);
  n += week - 1;
  return Math.max(0, n);
}

/**
 * Wybiera wolumen operacji dla okresu (rok / miesiąc / tydzień) przy alokacji od miesiąca/tygodnia.
 * effective_from_* = NULL → volume_value obowiązuje cały rok.
 */
export function pickOperationYearVolumeForPeriod(
  row: OperationYearVolumeRow,
  year: number,
  activeMonth?: number,
  activeWeek?: number
): { volume_value: number; volume_unit: string } {
  const fromMRaw = row.effective_from_month;
  if (fromMRaw == null || !Number.isFinite(Number(fromMRaw))) {
    return { volume_value: Number(row.volume_value) || 0, volume_unit: row.volume_unit };
  }
  const fromM = Math.min(12, Math.max(1, Math.floor(Number(fromMRaw)) || 1));
  const fromWCount = getWeekCountInMonth(year, fromM);
  const fromW = Math.min(fromWCount, Math.max(1, Math.floor(Number(row.effective_from_week) || 1)));
  const after = Number(row.volume_value) || 0;
  const before =
    row.volume_value_before != null && Number.isFinite(Number(row.volume_value_before))
      ? Number(row.volume_value_before)
      : 0;
  const unit = row.volume_unit;

  if (activeMonth == null || !Number.isFinite(activeMonth)) {
    const total = totalCalculatorWeeksInYear(year);
    const beforeWeeks = weeksBeforeEffectiveFrom(year, fromM, fromW);
    const afterWeeks = Math.max(0, total - beforeWeeks);
    const weighted = (before * beforeWeeks + after * afterWeeks) / total;
    return { volume_value: weighted, volume_unit: unit };
  }

  const month = Math.min(12, Math.max(1, Math.floor(activeMonth)));
  if (activeWeek == null || !Number.isFinite(activeWeek)) {
    if (month < fromM) return { volume_value: before, volume_unit: unit };
    if (month > fromM) return { volume_value: after, volume_unit: unit };
    const wc = getWeekCountInMonth(year, month);
    const beforeInMonth = Math.max(0, fromW - 1);
    const afterInMonth = Math.max(0, wc - beforeInMonth);
    const weighted = (before * beforeInMonth + after * afterInMonth) / Math.max(1, wc);
    return { volume_value: weighted, volume_unit: unit };
  }

  const week = Math.max(1, Math.floor(activeWeek));
  if (month < fromM || (month === fromM && week < fromW)) {
    return { volume_value: before, volume_unit: unit };
  }
  return { volume_value: after, volume_unit: unit };
}

export type OperationVolumeSource = 'operation_year' | 'part' | 'operation_base';

function isAllocationVolumeSource(source: string | null | undefined): boolean {
  return String(source ?? '').trim().toLowerCase() === 'allocation';
}

/** Indeks split_from — ładowany raz, invalidowany po alokacji. */
let allocationSplitParentById: Map<number, number | null> | null = null;
let allocationChildrenByParent: Map<number, number[]> | null = null;

type AllocationShareCacheEntry = {
  year: number;
  activeMonth: number | undefined;
  activeWeek: number | undefined;
  settingsKey: string;
  shares: Map<number, number>;
};

/** Cache udziałów per volumeMap (ten sam obiekt mapy w ramach jednego przeliczenia). */
let allocationShareCache = new WeakMap<Map<number, OperationYearVolumeRow>, AllocationShareCacheEntry>();

export function invalidateAllocationSplitIndex(): void {
  allocationSplitParentById = null;
  allocationChildrenByParent = null;
  allocationShareCache = new WeakMap();
}

function buildAllocationSplitIndexFromOperations(ops: { id?: number; operation_id?: number; split_from_operation_id?: number | null }[]): {
  parentById: Map<number, number | null>;
  childrenByParent: Map<number, number[]>;
} {
  const parentById = new Map<number, number | null>();
  const childrenByParent = new Map<number, number[]>();
  for (const op of ops) {
    const id = Number(op.operation_id ?? op.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const parent =
      op.split_from_operation_id != null && Number.isFinite(Number(op.split_from_operation_id))
        ? Number(op.split_from_operation_id)
        : null;
    parentById.set(id, parent);
    if (parent != null) {
      const list = childrenByParent.get(parent);
      if (list) list.push(id);
      else childrenByParent.set(parent, [id]);
    }
  }
  return { parentById, childrenByParent };
}

/** Ops (np. snapshot scenariusza) nadpisują indeks z bazy produkcyjnej. */
function mergeAllocationSplitIndexes(
  primary: { parentById: Map<number, number | null>; childrenByParent: Map<number, number[]> },
  fallback: { parentById: Map<number, number | null>; childrenByParent: Map<number, number[]> }
): { parentById: Map<number, number | null>; childrenByParent: Map<number, number[]> } {
  const parentById = new Map(fallback.parentById);
  for (const [id, parent] of primary.parentById) parentById.set(id, parent);
  const childrenByParent = new Map<number, number[]>();
  for (const [id, parent] of parentById) {
    if (parent == null) continue;
    const list = childrenByParent.get(parent);
    if (list) list.push(id);
    else childrenByParent.set(parent, [id]);
  }
  return { parentById, childrenByParent };
}

function ensureAllocationSplitIndex(): {
  parentById: Map<number, number | null>;
  childrenByParent: Map<number, number[]>;
} {
  if (allocationSplitParentById && allocationChildrenByParent) {
    return { parentById: allocationSplitParentById, childrenByParent: allocationChildrenByParent };
  }
  const parentById = new Map<number, number | null>();
  const childrenByParent = new Map<number, number[]>();
  try {
    const rows = db.prepare('SELECT id, split_from_operation_id FROM operations').all() as {
      id: number;
      split_from_operation_id: number | null;
    }[];
    for (const r of rows) {
      const id = Number(r.id);
      if (!Number.isFinite(id)) continue;
      const parent =
        r.split_from_operation_id != null && Number.isFinite(Number(r.split_from_operation_id))
          ? Number(r.split_from_operation_id)
          : null;
      parentById.set(id, parent);
      if (parent != null) {
        const list = childrenByParent.get(parent);
        if (list) list.push(id);
        else childrenByParent.set(parent, [id]);
      }
    }
  } catch {
    /* ignore */
  }
  allocationSplitParentById = parentById;
  allocationChildrenByParent = childrenByParent;
  return { parentById, childrenByParent };
}

/** Korzeń łańcucha alokacji w zbiorze operacji (split_from → …). */
function allocationFamilyRootId(
  opId: number,
  splitFrom: number | null | undefined,
  opById: Map<number, { split_from_operation_id?: number | null }>
): number {
  let cur = opId;
  let parent = splitFrom != null ? Number(splitFrom) : null;
  for (let i = 0; i < 10000; i++) {
    if (parent == null || !Number.isFinite(parent)) return cur;
    const pOp = opById.get(parent);
    if (!pOp) return parent;
    cur = parent;
    parent = pOp.split_from_operation_id != null ? Number(pOp.split_from_operation_id) : null;
  }
  return cur;
}

function allocationFamilyRootFromIndex(operationId: number, parentById: Map<number, number | null>): number {
  let cur = operationId;
  for (let i = 0; i < 10000; i++) {
    const parent = parentById.get(cur);
    if (parent == null || !Number.isFinite(parent)) return cur;
    cur = parent;
  }
  return cur;
}

function collectAllocationFamilyIds(
  rootId: number,
  childrenByParent: Map<number, number[]>
): number[] {
  const familyIds: number[] = [rootId];
  const queue = [rootId];
  const seen = new Set<number>([rootId]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const children = childrenByParent.get(id);
    if (!children) continue;
    for (const cid of children) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      familyIds.push(cid);
      queue.push(cid);
    }
  }
  return familyIds;
}

function settingsCacheKey(settings: WorkingDaysRow): string {
  return `${settings.working_weeks_per_year ?? 48}|${settings.working_days_year ?? 252}`;
}

/**
 * Buduje mapę udziałów alokacji wyłącznie z volumeMap + indeksu split (bez zapytań per operacja).
 * @param splitIndex — opcjonalnie ze snapshotu scenariusza / listy ops (nadpisuje samą bazę produkcyjną).
 */
function buildAllocationFamilyShareMap(
  volumeMap: Map<number, OperationYearVolumeRow>,
  year: number,
  settings: WorkingDaysRow,
  activeMonth?: number,
  activeWeek?: number,
  splitIndex?: { parentById: Map<number, number | null>; childrenByParent: Map<number, number[]> }
): Map<number, number> {
  const shares = new Map<number, number>();
  const { parentById, childrenByParent } = splitIndex ?? ensureAllocationSplitIndex();

  const weeklyOf = (row: OperationYearVolumeRow | null | undefined): number => {
    if (!row) return 0;
    const picked = pickOperationYearVolumeForPeriod(row, year, activeMonth, activeWeek);
    const unit =
      picked.volume_unit === 'monthly' || picked.volume_unit === 'weekly' ? picked.volume_unit : 'annual';
    return volumeToWeekly(Number(picked.volume_value) || 0, unit, settings);
  };

  const rootsDone = new Set<number>();
  for (const opId of volumeMap.keys()) {
    const rootId = allocationFamilyRootFromIndex(opId, parentById);
    if (rootsDone.has(rootId)) continue;
    rootsDone.add(rootId);
    const familyIds = collectAllocationFamilyIds(rootId, childrenByParent);
    if (familyIds.length <= 1) continue;

    let totalWeekly = 0;
    const weeklies = new Map<number, number>();
    for (const fid of familyIds) {
      const w = weeklyOf(volumeMap.get(fid));
      weeklies.set(fid, w);
      totalWeekly += w;
    }
    if (totalWeekly <= 1e-9) continue;
    for (const [fid, w] of weeklies) {
      // Jawne 0 dla członków bez wolumenu — inaczej Call offs traktuje brak wpisu
      // jako „brak udziału” i w fallbacku znów przypisuje 100% SAP na maszynę źródłową.
      shares.set(fid, w / totalWeekly);
    }
  }
  return shares;
}

function getAllocationFamilyShareMap(
  volumeMap: Map<number, OperationYearVolumeRow>,
  year: number,
  settings: WorkingDaysRow,
  activeMonth?: number,
  activeWeek?: number
): Map<number, number> {
  const sk = settingsCacheKey(settings);
  const cached = allocationShareCache.get(volumeMap);
  if (
    cached &&
    cached.year === year &&
    cached.activeMonth === activeMonth &&
    cached.activeWeek === activeWeek &&
    cached.settingsKey === sk
  ) {
    return cached.shares;
  }
  const shares = buildAllocationFamilyShareMap(volumeMap, year, settings, activeMonth, activeWeek);
  allocationShareCache.set(volumeMap, {
    year,
    activeMonth,
    activeWeek,
    settingsKey: sk,
    shares,
  });
  return shares;
}

/**
 * Udział operacji w rodzinie alokacji (weekly z nadpisań allocation).
 * Zwraca null, gdy nie ma sensownego podziału (brak rodzeństwa / zerowe sumy).
 */
function allocationFamilyShareForOperation(
  operationId: number,
  year: number,
  opYearOverride: OperationYearVolumeRow | null | undefined,
  volumeMap: Map<number, OperationYearVolumeRow> | null | undefined,
  settings: WorkingDaysRow,
  activeMonth?: number,
  activeWeek?: number
): number | null {
  if (!opYearOverride) return null;
  if (!volumeMap || volumeMap.size === 0) return null;

  if (!volumeMap.has(operationId)) {
    volumeMap.set(operationId, opYearOverride);
    // Nowa zawartość mapy — wymuś przebudowę cache udziałów.
    allocationShareCache.delete(volumeMap);
  }
  const shares = getAllocationFamilyShareMap(volumeMap, year, settings, activeMonth, activeWeek);
  const share = shares.get(operationId);
  return share != null && Number.isFinite(share) ? share : null;
}

/** Ten sam wolumen co w kalkulatorze obciążenia dla operacji w danym roku: nadpisanie per rok > projekt/detal > pole operacji. */
export function resolveOperationVolumeForYear(
  op: {
    operation_id: number;
    project_id: number | null;
    part_id: number | null;
    volume_value: number;
    volume_unit: string;
    /** Operacja-dziecko po alokacji — wolumen wyłącznie z operation_volume_by_year (brak wiersza = 0). */
    split_from_operation_id?: number | null;
  },
  year: number,
  opYearOverride?: OperationYearVolumeRow | null,
  scenarioSnapshot?: ScenarioBundle | null,
  useContractualVolumes: boolean = false,
  volumePrefetch?: VolumePrefetchMaps | null,
  activeMonth?: number,
  activeWeek?: number,
  /** Mapa nadpisań roku (do proporcji alokacji przy wolumenach kontraktowych). */
  opVolumeMapForYear?: Map<number, OperationYearVolumeRow> | null,
  /** false = nie skaluj alokacji do kontraktu (np. liczenie udziałów SAP). */
  applyAllocationContractFraction: boolean = true
): {
  volume_value: number;
  volume_unit: 'annual' | 'monthly' | 'weekly';
  source: OperationVolumeSource;
  volume_origin: VolumeEntryOrigin;
  count_after_eop?: boolean;
} {
  const asUnit = (u: string): 'annual' | 'monthly' | 'weekly' =>
    u === 'monthly' || u === 'weekly' ? u : 'annual';

  const periodOverride =
    opYearOverride != null
      ? pickOperationYearVolumeForPeriod(opYearOverride, year, activeMonth, activeWeek)
      : null;

  const allocationOverride =
    opYearOverride != null &&
    (isAllocationVolumeSource(opYearOverride.source) ||
      (op.split_from_operation_id != null &&
        (opYearOverride.source == null ||
          String(opYearOverride.source).trim() === '' ||
          isAllocationVolumeSource(opYearOverride.source))));

  /** Nadpisanie alokacji = udział w rodzinie × aktualny wolumen detalu (produkcja lub kontrakt). */
  if (
    applyAllocationContractFraction &&
    allocationOverride &&
    periodOverride &&
    op.project_id &&
    op.part_id
  ) {
    const effective = scenarioSnapshot
      ? getEffectiveVolumeForPartScenarioPreferContract(
          op.project_id,
          op.part_id,
          year,
          scenarioSnapshot,
          useContractualVolumes
        )
      : volumePrefetch
        ? lookupEffectiveVolumeForPartPreferContract(
            op.project_id,
            op.part_id,
            year,
            volumePrefetch,
            useContractualVolumes,
            parseSopEop,
            normalizeVolumeOrigin
          )
        : getEffectiveVolumeForPartPreferContract(op.project_id, op.part_id, year, useContractualVolumes);
    if (effective) {
      const settings =
        scenarioSnapshot != null
          ? resolveSettingsForScenarioYear(year, scenarioSnapshot) ?? resolveSettingsForYear(year, 'capacity')
          : resolveSettingsForYear(year, 'capacity');
      const share = allocationFamilyShareForOperation(
        op.operation_id,
        year,
        opYearOverride,
        opVolumeMapForYear ?? null,
        settings,
        activeMonth,
        activeWeek
      );
      if (share != null && Number.isFinite(share)) {
        return {
          volume_value: (Number(effective.volume_value) || 0) * share,
          volume_unit: asUnit(effective.volume_unit),
          source: 'part',
          volume_origin: effective.volume_origin ?? 'manual_year',
          count_after_eop: effective.count_after_eop,
        };
      }
    }
  }

  if (op.split_from_operation_id != null) {
    if (periodOverride) {
      return {
        volume_value: periodOverride.volume_value,
        volume_unit: asUnit(periodOverride.volume_unit),
        source: 'operation_year',
        volume_origin: 'manual_year',
      };
    }
    return { volume_value: 0, volume_unit: 'weekly', source: 'operation_year', volume_origin: 'manual_year' };
  }

  if (periodOverride) {
    return {
      volume_value: periodOverride.volume_value,
      volume_unit: asUnit(periodOverride.volume_unit),
      source: 'operation_year',
      volume_origin: 'manual_year',
    };
  }
  if (op.project_id && op.part_id) {
    const effective = scenarioSnapshot
      ? getEffectiveVolumeForPartScenarioPreferContract(op.project_id, op.part_id, year, scenarioSnapshot, useContractualVolumes)
      : volumePrefetch
        ? lookupEffectiveVolumeForPartPreferContract(
            op.project_id,
            op.part_id,
            year,
            volumePrefetch,
            useContractualVolumes,
            parseSopEop,
            normalizeVolumeOrigin
          )
        : getEffectiveVolumeForPartPreferContract(op.project_id, op.part_id, year, useContractualVolumes);
    if (effective) {
      return {
        volume_value: effective.volume_value,
        volume_unit: asUnit(effective.volume_unit),
        source: 'part',
        volume_origin: effective.volume_origin ?? 'manual_year',
        count_after_eop: effective.count_after_eop,
      };
    }
  }
  return {
    volume_value: op.volume_value,
    volume_unit: asUnit(op.volume_unit),
    source: 'operation_base',
    volume_origin: 'manual_year',
  };
}

export interface MachineCapacityRow {
  machine_id: number;
  internal_number: string | number;
  type: string;
  sap_number: string | null;
  oee_override: number | null;
  year: number;
  availability_sec_per_week: number;
  required_sec_per_week: number;
  capacity_pcs_per_week: number;
  load_percent: number;
  utilization_percent: number;
  /** Oznaczenie kafelka % w kalkulatorze (operacje z alternatywą na maszynie w tym roku). */
  alternative_border?: 'none' | 'unused' | 'all_alt' | 'mixed';
  /** Udział detali w obciążeniu tej maszyny (dla tooltipa w kalkulatorze). */
  detail_breakdown?: {
    project_label: string;
    detail_label: string;
    contribution_percent: number;
    share_percent: number;
    volume_quantity: number;
    has_rfq: boolean;
  }[];
  /** Czy w tym roku na tej maszynie liczy się przynajmniej jedna operacja z projektu RFQ. */
  has_rfq?: boolean;
  /** Status maszyny w bazie (np. RFQ) — do znacznika w kalkulatorze scenariusza. */
  machine_status?: string | null;
  /** Nr linii (kolumna location). */
  location?: string | null;
  width_mm?: number | null;
  depth_mm?: number | null;
  height_mm?: number | null;
  stroke_mm?: number | null;
}

/** Optional operations override for scenario: array of { machine_id, cycle_time_seconds, volume_value, volume_unit, nests_count, oee_override, capacity_percent } */
export type CalculatorMachineStatusFilter = 'active' | 'inactive' | 'RFQ' | 'all';

export type MachineStatusFilterInput = CalculatorMachineStatusFilter | CalculatorMachineStatusFilter[];

function normalizeMachineTypes(machineType?: string | string[]): string[] {
  if (Array.isArray(machineType)) return machineType.filter((t) => t && t !== 'Wszystkie');
  if (machineType && machineType !== 'Wszystkie' && machineType !== '') return [machineType];
  return [];
}

function normalizeMachineStatusFilters(filter?: MachineStatusFilterInput): CalculatorMachineStatusFilter[] {
  if (Array.isArray(filter)) {
    return [...new Set(filter.filter((f) => f && f !== 'all'))] as CalculatorMachineStatusFilter[];
  }
  if (!filter || filter === 'all') return [];
  return [filter];
}

function isOperationActiveInYear(
  sop: unknown,
  eop: unknown,
  year: number,
  countAfterEop: boolean,
  hasProject: boolean
): boolean {
  if (!hasProject) return true;
  const sopP = parseSopEop(sop);
  const eopP = parseSopEop(eop);
  if (countAfterEop) {
    if (!eopP) return true;
    return year > eopP.year;
  }
  if (!sopP || !eopP) return true;
  if (year < sopP.year || year > eopP.year) return false;
  return true;
}

function isOperationActiveInMonth(
  sop: unknown,
  eop: unknown,
  year: number,
  month: number,
  countAfterEop: boolean,
  hasProject: boolean
): boolean {
  if (!hasProject) return true;
  if (countAfterEop) {
    const eopP = parseSopEop(eop);
    if (!eopP) return true;
    if (year < eopP.year) return false;
    if (year === eopP.year && month <= eopP.month) return false;
    return true;
  }
  return isMonthInProduction(sop, eop, year, month);
}

function shouldIncludeOperationInCapacity(
  sop: unknown,
  eop: unknown,
  year: number,
  activeMonth: number | undefined,
  countAfterEop: boolean,
  hasProject: boolean
): boolean {
  if (!isOperationActiveInYear(sop, eop, year, countAfterEop, hasProject)) return false;
  if (activeMonth != null && !isOperationActiveInMonth(sop, eop, year, activeMonth, countAfterEop, hasProject)) return false;
  return true;
}

/**
 * Czy operacja jest faktycznie przypisana do maszyny w danym roku/miesiącu.
 * Dzieci alokacji (split_from) liczą się tylko gdy mają wolumen alokacji > 0 w tym roku.
 */
function isOperationAssignedOnMachineForPeriod(
  op: { split_from_operation_id?: number | null; sop?: unknown; eop?: unknown; project_id?: number | null },
  year: number,
  activeMonth: number | undefined,
  resolved: { volume_value: number; count_after_eop?: boolean }
): boolean {
  if (
    !shouldIncludeOperationInCapacity(
      op.sop ?? '',
      op.eop ?? '',
      year,
      activeMonth,
      Boolean(resolved.count_after_eop),
      op.project_id != null
    )
  ) {
    return false;
  }
  if (op.split_from_operation_id != null) {
    return resolved.volume_value > 1e-9;
  }
  return true;
}

function buildMachineStatusWhere(
  filters: CalculatorMachineStatusFilter[],
  scenarioRfqs: number[],
): { clause: string; params: (string | number)[] } {
  if (filters.length === 0) return { clause: '1=1', params: [] };
  const unique = [...new Set(filters)];
  if (unique.length === 1 && unique[0] === 'active' && scenarioRfqs.length > 0) {
    return {
      clause: `(m.status = 'active' OR (m.status = 'RFQ' AND m.id IN (${scenarioRfqs.map(() => '?').join(',')})))`,
      params: scenarioRfqs,
    };
  }
  return {
    clause: `m.status IN (${unique.map(() => '?').join(',')})`,
    params: unique,
  };
}

type CallOffVolumeMaps = import('./callOffService.js').CallOffVolumeMaps;

function callOffQuantityForPeriod(
  callOffVolumes: CallOffVolumeMaps,
  partId: number,
  year: number,
  activeMonth: number | undefined,
  activeWeek: number | undefined
): number {
  if (activeMonth != null && activeWeek != null) {
    return callOffVolumes.weekly.get(partId)?.get(year)?.get(activeMonth)?.get(activeWeek) ?? 0;
  }
  if (activeMonth != null) {
    return callOffVolumes.monthly.get(partId)?.get(year)?.get(activeMonth) ?? 0;
  }
  return callOffVolumes.annual.get(partId)?.get(year) ?? 0;
}

/** Call offs: nadpisanie z ilością SAP > 0 → licz mimo braku prod/kontrakt i poza SOP–EOP. */
function isCallOffSapVolumeOverride(
  callOffVolumes: CallOffVolumeMaps | null | undefined,
  opVolumeOverride: OperationYearVolumeRow | null | undefined
): boolean {
  if (!callOffVolumes || !opVolumeOverride) return false;
  if (String(opVolumeOverride.source ?? '').trim().toLowerCase() !== 'call_off') return false;
  return Number(opVolumeOverride.volume_value) > 1e-9;
}

function callOffVolumeUnitForPeriod(
  activeMonth: number | undefined,
  activeWeek: number | undefined
): 'annual' | 'monthly' | 'weekly' {
  if (activeMonth != null && activeWeek != null) return 'weekly';
  if (activeMonth != null) return 'monthly';
  return 'annual';
}

/** Udział operacji w wolumenie SAP — w rodzinie alokacji (wszystkie maszyny), nie per maszyna. */
function buildCallOffOperationShares(
  allOps: any[],
  year: number,
  activeMonth: number | undefined,
  activeWeek: number | undefined,
  volumeMap: Map<number, OperationYearVolumeRow>,
  scenarioSnapshotEff: ScenarioBundle | null,
  useContract: boolean,
  volumePrefetch: VolumePrefetchMaps | undefined,
  settings: ReturnType<typeof resolveSettingsForYear>,
  callOffVolumes: CallOffVolumeMaps
): Map<number, number> {
  const callOffOpShare = new Map<number, number>();
  for (const op of allOps) {
    if (op.baseline_inferred_source !== BASELINE_INFERRED_OPERATION) continue;
    const opKey = Number(op.operation_id ?? op.id);
    if (Number.isFinite(opKey)) callOffOpShare.set(opKey, 1);
  }

  // 1) Udziały z nadpisań alokacji — indeks split ze snapshotu/ops + baza produkcyjna.
  //    Samo DB nie widzi alokacji zrobionych tylko w scenariuszu → obie maszyny dostawały 100% SAP.
  const splitIndex = mergeAllocationSplitIndexes(
    buildAllocationSplitIndexFromOperations(allOps),
    ensureAllocationSplitIndex()
  );
  const familyShares = buildAllocationFamilyShareMap(
    volumeMap,
    year,
    settings,
    activeMonth,
    activeWeek,
    splitIndex
  );
  for (const [opId, share] of familyShares) {
    callOffOpShare.set(opId, share);
  }

  const opById = new Map<number, any>();
  for (const op of allOps) {
    const opKey = Number(op.operation_id ?? op.id);
    if (Number.isFinite(opKey)) opById.set(opKey, op);
  }

  const familyKeyOf = (op: any, opKey: number) =>
    allocationFamilyRootId(opKey, op.split_from_operation_id, opById);

  const hasAssignedShare = (opKey: number) => callOffOpShare.has(opKey);

  const weeklyFromResolved = (op: any, opKey: number, useContractForShare: boolean): number => {
    const resolved = resolveOperationVolumeForYear(
      {
        operation_id: opKey,
        project_id: op.project_id,
        part_id: op.part_id,
        volume_value: op.volume_value,
        volume_unit: op.volume_unit,
        split_from_operation_id: op.split_from_operation_id,
      },
      year,
      volumeMap.get(opKey),
      scenarioSnapshotEff,
      useContractForShare,
      volumePrefetch,
      activeMonth,
      activeWeek,
      volumeMap,
      false
    );
    if (
      !shouldIncludeOperationInCapacity(
        op.sop ?? '',
        op.eop ?? '',
        year,
        activeMonth ?? undefined,
        Boolean(resolved.count_after_eop),
        op.project_id != null
      )
    ) {
      return 0;
    }
    return resolveWeeklyVolumeFromResolved(resolved.volume_value, resolved.volume_unit, settings, {
      sop: op.sop ?? '',
      eop: op.eop ?? '',
      year,
      volume_origin: resolved.volume_origin,
      count_after_eop: resolved.count_after_eop,
      has_project: op.project_id != null,
    }).weekly;
  };

  const accumulateShares = (useContractForShare: boolean) => {
    const familyWeeklyTotal = new Map<number, number>();
    const opWeekly = new Map<number, number>();
    const opFamily = new Map<number, number>();

    for (const op of allOps) {
      const opKey = Number(op.operation_id ?? op.id);
      if (!Number.isFinite(opKey)) continue;
      if (op.baseline_inferred_source === BASELINE_INFERRED_OPERATION) continue;
      if (hasAssignedShare(opKey)) continue;

      const weekly = weeklyFromResolved(op, opKey, useContractForShare);
      if (weekly <= 1e-9) continue;
      const partId = op.part_id != null ? Number(op.part_id) : null;
      if (partId == null || !Number.isFinite(partId)) continue;
      const family = familyKeyOf(op, opKey);
      opWeekly.set(opKey, weekly);
      opFamily.set(opKey, family);
      familyWeeklyTotal.set(family, (familyWeeklyTotal.get(family) ?? 0) + weekly);
    }

    for (const [opKey, weekly] of opWeekly) {
      if (hasAssignedShare(opKey)) continue;
      const family = opFamily.get(opKey);
      if (family == null) continue;
      const total = familyWeeklyTotal.get(family) ?? weekly;
      if (total <= 1e-9) continue;
      callOffOpShare.set(opKey, weekly / total);
    }
  };

  accumulateShares(useContract);
  if (!useContract) accumulateShares(true);

  const opsByFamilyWithoutShare = new Map<number, number[]>();
  for (const op of allOps) {
    const opKey = Number(op.operation_id ?? op.id);
    if (!Number.isFinite(opKey)) continue;
    if (op.baseline_inferred_source === BASELINE_INFERRED_OPERATION) continue;
    if (hasAssignedShare(opKey)) continue;
    const partId = op.part_id != null ? Number(op.part_id) : null;
    if (partId == null || !Number.isFinite(partId)) continue;

    const sapRaw = callOffQuantityForPeriod(callOffVolumes, partId, year, activeMonth, activeWeek);
    if (sapRaw <= 0) continue;

    const resolved = resolveOperationVolumeForYear(
      {
        operation_id: opKey,
        project_id: op.project_id,
        part_id: op.part_id,
        volume_value: op.volume_value,
        volume_unit: op.volume_unit,
        split_from_operation_id: op.split_from_operation_id,
      },
      year,
      volumeMap.get(opKey),
      scenarioSnapshotEff,
      useContract,
      volumePrefetch,
      undefined,
      undefined,
      volumeMap,
      false
    );
    // SAP w pliku + operacja w systemie: licz mimo braku prod/kontrakt i poza SOP–EOP projektu.
    if (op.split_from_operation_id != null && !(resolved.volume_value > 1e-9)) continue;

    const family = familyKeyOf(op, opKey);
    if (!opsByFamilyWithoutShare.has(family)) opsByFamilyWithoutShare.set(family, []);
    opsByFamilyWithoutShare.get(family)!.push(opKey);
  }

  for (const opKeys of opsByFamilyWithoutShare.values()) {
    if (opKeys.length === 0) continue;
    const equalShare = 1 / opKeys.length;
    for (const opKey of opKeys) callOffOpShare.set(opKey, equalShare);
  }

  return callOffOpShare;
}

export function getMachineCapacitiesForYear(
  year: number,
  machineIds?: number[],
  machineType?: string | string[],
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  /** Gdy kalkulator scenariusza (snapshot + override): czy projekty RFQ liczą się do doboru maszyn RFQ. */
  scenarioIncludeRfqProjects?: boolean,
  /** Wolumeny kontraktowe z fallbackiem do produkcyjnych (kalkulator / alokacja). */
  useContractualVolumes?: boolean,
  /** Filtr statusu maszyny w kalkulatorze; `active` = dotychczasowa logika (active + RFQ ze scenariusza gdy dotyczy). */
  machineStatusFilter?: MachineStatusFilterInput,
  /** Filtry wymiarów maszyny (szerokość, głębokość, wysokość, skok). */
  dimensionFilters?: MachineDimensionFilter[],
  /** Profil ustawień (Capacity / OCU); w scenariuszu zawsze Capacity. */
  settingsProfile?: CalculationSettingsProfile,
  /** Gdy podany — liczy obciążenie tylko dla operacji aktywnych w tym miesiącu (SOP/EOP). */
  activeMonth?: number,
  /** Współdzielony kontekst obliczeń (prefetch wolumenów, indeks operacji). */
  shared?: CapacityComputeShared,
  /** Wolumeny z pliku SAP Call off. Gdy ustawione, nadpisuje wolumen operacji. */
  callOffVolumes?: import('./callOffService.js').CallOffVolumeMaps | null,
  /** Jednostka ilości w detail_breakdown (domyślnie: roczna lub miesięczna przy activeMonth). */
  detailVolumePeriod?: 'annual' | 'monthly' | 'weekly',
  calculationOptions?: CapacityCalculationOptions,
  /** Tydzień w miesiącu (T1…T5) — Call offs; wymaga activeMonth. */
  activeWeek?: number
): MachineCapacityRow[] {
  const includeAssignedZeroVolumeDetails =
    calculationOptions?.includeAssignedZeroVolumeDetailsInBreakdown === true;
  const useContract = useContractualVolumes === true;
  const computeShared =
    shared ??
    buildCapacityComputeShared(
      year,
      year,
      operationsOverride,
      scenarioSnapshot ?? null,
      settingsProfile,
      calculationOptions?.includeRfqOperationIds
    );
  const scenarioSnapshotEff = computeShared.scenarioSnapshot;
  const effectiveProfile = computeShared.effectiveProfile;
  const settings = computeShared.settingsByYear.get(year) ?? resolveSettingsForYear(year, effectiveProfile);
  const refMode = computeShared.refMode;
  const volumePrefetch = computeShared.volumePrefetchByYear.get(year);
  const volumePeriod: 'annual' | 'monthly' | 'weekly' =
    detailVolumePeriod ??
    (activeWeek != null && activeMonth != null ? 'weekly' : activeMonth != null ? 'monthly' : 'annual');
  const scenarioRfqs =
    scenarioSnapshotEff != null && operationsOverride != null
      ? scenarioLinkedRfqProductionMachineIds(scenarioSnapshotEff, scenarioIncludeRfqProjects !== false)
      : [];

  const msList = normalizeMachineStatusFilters(machineStatusFilter);
  const effectiveStatuses: CalculatorMachineStatusFilter[] =
    msList.length > 0 ? msList : machineStatusFilter === undefined ? ['active'] : [];
  const statusWhere = buildMachineStatusWhere(effectiveStatuses, scenarioRfqs);
  const rfqMachineIds = computeShared.includeRfqMachineIds ?? [];
  let machineStatusClause = statusWhere.clause;
  const machineStatusParams: (number | string)[] = [...statusWhere.params];
  if (rfqMachineIds.length) {
    machineStatusClause = `(${statusWhere.clause}) OR m.id IN (${rfqMachineIds.map(() => '?').join(',')})`;
    machineStatusParams.push(...rfqMachineIds);
  }

  let machinesSql = `
    SELECT m.id AS machine_id, m.internal_number, m.type, m.sap_number, m.oee_override, m.status AS machine_status, m.location, COALESCE(m.machine_usage, 1) AS machine_usage,
           m.width_mm, m.depth_mm, m.height_mm, m.stroke_mm,
           m.is_baseline, m.baseline_available_hours_per_week, m.baseline_weeks_per_year,
           m.baseline_max_throughput_kg_h, m.baseline_max_throughput_unit,
           m.baseline_max_speed_m_min, m.baseline_max_speed_unit,
           m.baseline_max_blank_width_mm, m.baseline_max_blank_width_unit,
           m.baseline_min_length_mm,
           m.baseline_max_blanks_across
    FROM machines m
    WHERE ${machineStatusClause}
  `;
  const params: (number | string)[] = [...machineStatusParams];
  if (machineIds?.length) {
    machinesSql += ` AND m.id IN (${machineIds.map(() => '?').join(',')})`;
    params.push(...machineIds);
  }
  const types = normalizeMachineTypes(machineType);
  if (types.length === 1) {
    machinesSql += ' AND m.type = ?';
    params.push(types[0]);
  } else if (types.length > 1) {
    machinesSql += ` AND m.type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }
  if (dimensionFilters?.length) {
    const dim = appendMachineDimensionFilters(dimensionFilters);
    if (dim.clause !== '1=1') {
      machinesSql += ` AND (${dim.clause})`;
      params.push(...dim.params);
    }
  }
  machinesSql += ' ORDER BY m.internal_number';

  const machines = db.prepare(machinesSql).all(...params) as any[];
  const operations = computeShared.operations;
  const operationsByMachine = computeShared.operationsByMachine;
  const volumeMap = computeShared.opVolumeMapByYear.get(year) ?? new Map();

  /** Udziały SAP raz na rok/miesiąc/tydzień — z cache shared (Call offs liczy wiele tygodni). */
  const callOffOpShare = (() => {
    if (!callOffVolumes) return null;
    const cache = computeShared.callOffShareCache ?? (computeShared.callOffShareCache = new Map());
    const key = `${year}|${activeMonth ?? ''}|${activeWeek ?? ''}|${useContract ? 1 : 0}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const built = buildCallOffOperationShares(
      operations,
      year,
      activeMonth,
      activeWeek,
      volumeMap,
      scenarioSnapshotEff,
      useContract,
      volumePrefetch,
      settings,
      callOffVolumes
    );
    cache.set(key, built);
    return built;
  })();

  return machines.map((m) => {
    const machineVolumeSettings = volumeSettingsForMachine(settings, m);
    const workWeeksForVolume = Math.max(
      1,
      machineVolumeSettings.working_weeks_per_year ?? 48
    );
    const allMachineOps = operationsByMachine.get(m.machine_id) ?? [];
    const machineOps = Number(m.is_baseline)
      ? allMachineOps.filter((op) => op.baseline_inferred_source === BASELINE_INFERRED_OPERATION)
      : allMachineOps.filter((op) => op.baseline_inferred_source !== BASELINE_INFERRED_OPERATION);
    let totalRequiredSec = 0;
    let loadRatioSum = 0; // suma (wymagany_czas / dostępność_z_OEE_dla_tej_operacji)
    let altBorderRelevant = 0;
    let altBorderUsed = 0;
    let altBorderUnused = 0;
    const detailContributionSec = new Map<
      string,
      { project_label: string; detail_label: string; requiredSec: number; volumeQuantity: number; hasRfq: boolean }
    >();
    /** Tylko dla maszyn bazowych: rozbicie obciążenia na materiały → detale. */
    const materialContribSec = new Map<
      number,
      {
        alias: string | null;
        sap_number: string | null;
        width_mm: number | null;
        length_mm: number | null;
        grammage_kg_m2: number | null;
        requiredSec: number;
        details: Map<string, { project_label: string; detail_label: string; requiredSec: number }>;
      }
    >();
    let hasRfq = false;

    for (const op of machineOps) {
      const opKey = Number(op.operation_id ?? op.id);
      if (!Number.isFinite(opKey)) continue;
      let opVolumeOverride = volumeMap.get(opKey);
      if (callOffVolumes) {
        const share = callOffOpShare?.get(opKey);
        const partId = op.part_id != null ? Number(op.part_id) : null;
        const periodUnit = callOffVolumeUnitForPeriod(activeMonth, activeWeek);
        if (share != null && share > 0 && partId != null && Number.isFinite(partId)) {
          const sapRaw = callOffQuantityForPeriod(callOffVolumes, partId, year, activeMonth, activeWeek);
          opVolumeOverride = {
            volume_value: sapRaw * share,
            volume_unit: periodUnit,
            source: 'call_off',
          };
        } else if (includeAssignedZeroVolumeDetails) {
          /** Detal przypisany w SOP–EOP bez wolumenu SAP w okresie — nadal w podglądzie (0%). */
          opVolumeOverride = {
            volume_value: 0,
            volume_unit: periodUnit,
            source: 'call_off',
          };
        } else {
          continue;
        }
      }
      const callOffSapActive = isCallOffSapVolumeOverride(callOffVolumes, opVolumeOverride);
      const resolved = resolveOperationVolumeForYear(
        {
          operation_id: opKey,
          project_id: op.project_id,
          part_id: op.part_id,
          volume_value: op.volume_value,
          volume_unit: op.volume_unit,
          split_from_operation_id: op.split_from_operation_id,
        },
        year,
        opVolumeOverride,
        scenarioSnapshotEff,
        useContract,
        volumePrefetch,
        activeMonth,
        activeWeek,
        callOffVolumes ? null : volumeMap
      );
      if (
        !callOffSapActive &&
        !shouldIncludeOperationInCapacity(
          op.sop ?? '',
          op.eop ?? '',
          year,
          activeMonth ?? undefined,
          Boolean(resolved.count_after_eop),
          op.project_id != null
        )
      ) {
        continue;
      }
      const volValue = resolved.volume_value;
      const volUnit = resolved.volume_unit;
      const weeklyResolved = resolveWeeklyVolumeFromResolved(volValue, volUnit, machineVolumeSettings, {
        sop: op.sop ?? '',
        eop: op.eop ?? '',
        year,
        volume_origin: resolved.volume_origin,
        // Call offs: ilość z pliku SAP obowiązuje w okresie pliku — bez zerowania przez SOP–EOP.
        count_after_eop: callOffSapActive ? true : resolved.count_after_eop,
        has_project: op.project_id != null,
      });
      let weeklyVol = weeklyResolved.weekly;
      const fraction = weeklyResolved.fraction;
      const { cycleSeconds, nests, oeeForResolve, usesAlternativeInCalculator } = resolveOperationCycleForCalculator(op);
      const requiredSecOp = Number(m.is_baseline)
        ? baselineRequiredSeconds(
            m,
            op.detail_designation_id,
            weeklyVol,
            computeShared.baselineMaterials
          )
        : weeklyVol * (cycleSeconds / nests);
      totalRequiredSec += requiredSecOp;

      // Material breakdown dla maszyn bazowych
      if (Number(m.is_baseline) && weeklyVol > 1e-9) {
        const perMat = baselineRequiredSecondsPerMaterial(
          m,
          op.detail_designation_id,
          weeklyVol,
          computeShared.baselineMaterials
        );
        const detLabelForMat = formatDetailSapAliasLabel(
          { sap_number: op.detail_sap_number, alias: op.detail_alias, free_text: op.detail_free_text, designation: op.detail_designation, id: op.part_id },
          refMode
        );
        const projLabelForMat = formatProjectLabel(op.project_client, op.project_name);
        for (const { material_id, alias, sap_number, width_mm, length_mm, grammage_kg_m2, requiredSeconds } of perMat) {
          if (!materialContribSec.has(material_id)) {
            materialContribSec.set(material_id, {
              alias,
              sap_number,
              width_mm,
              length_mm,
              grammage_kg_m2,
              requiredSec: 0,
              details: new Map(),
            });
          }
          const matEntry = materialContribSec.get(material_id)!;
          matEntry.requiredSec += requiredSeconds;
          const dKey = `${Number(op.project_id)}|${detLabelForMat}`;
          const existing = matEntry.details.get(dKey);
          if (existing) {
            existing.requiredSec += requiredSeconds;
          } else {
            matEntry.details.set(dKey, { project_label: projLabelForMat, detail_label: detLabelForMat, requiredSec: requiredSeconds });
          }
        }
      }

      if (String(op.project_status ?? '').toUpperCase() === 'RFQ' && weeklyVol > 1e-9) {
        hasRfq = true;
      }
      if (operationHasAlternativeCycle(op) && weeklyVol > 1e-9) {
        altBorderRelevant++;
        if (usesAlternativeInCalculator) altBorderUsed++;
        else altBorderUnused++;
      }
      if (
        requiredSecOp > 1e-9 ||
        callOffSapActive ||
        (includeAssignedZeroVolumeDetails && isOperationAssignedOnMachineForPeriod(op, year, activeMonth, resolved))
      ) {
        const detailLabel = formatDetailSapAliasLabel(
          {
            sap_number: op.detail_sap_number,
            alias: op.detail_alias,
            free_text: op.detail_free_text,
            designation: op.detail_designation,
            id: op.part_id,
          },
          refMode
        );
        const projectLabel = formatProjectLabel(op.project_client, op.project_name);
        const contribKey = `${Number(op.project_id)}|${detailLabel}`;
        const isOpRfq = String(op.project_status ?? '').toUpperCase() === 'RFQ';
        const volQty = resolvedVolumeToTooltipQuantity(
          volValue,
          volUnit,
          weeklyVol,
          volumePeriod,
          workWeeksForVolume,
          {
            volume_origin: resolved.volume_origin,
            production_months: weeklyResolved.production_months,
            fraction,
          }
        );
        const existing = detailContributionSec.get(contribKey);
        if (existing) {
          existing.requiredSec += requiredSecOp;
          existing.volumeQuantity += volQty;
          if (isOpRfq) existing.hasRfq = true;
        } else {
          detailContributionSec.set(contribKey, {
            project_label: projectLabel,
            detail_label: detailLabel,
            requiredSec: requiredSecOp,
            volumeQuantity: volQty,
            hasRfq: isOpRfq,
          });
        }
      }
      const oeeOp = resolveOee(settings, m.oee_override, oeeForResolve);
      const availabilitySecOp = Number(m.is_baseline)
        ? baselineAvailabilitySeconds(m, resolveOee(settings, m.oee_override, null))
        : availabilitySecondsPerWeek(settings, oeeOp);
      if (availabilitySecOp > 0) {
        loadRatioSum += requiredSecOp / availabilitySecOp;
      }
    }

    // Materiały z wolumenem zewnętrznym (linia bazowa) — ich czas doliczamy do totalRequiredSec
    if (Number(m.is_baseline)) {
      const extMaterials = computeShared.baselineExternalMaterials.get(Number(m.machine_id)) ?? [];
      for (const mat of extMaterials) {
        const mid = Number(mat.material_id);
        const yearVolumes = computeShared.baselineExternalVolumes.get(mid);
        if (!yearVolumes) continue;
        const weeklyVol = yearVolumes.get(year) ?? 0;
        if (weeklyVol <= 0) continue;
        const hc = baselineMaterialHourlyCapacity(m, mat);
        if (hc == null) continue;
        const shareRaw = Number(mat.production_share_percent);
        const share = Number.isFinite(shareRaw) ? Math.min(100, Math.max(0, shareRaw)) / 100 : 1;
        const extSec = (weeklyVol * share / hc.actualCapacityPerHour) * 3600;
        totalRequiredSec += extSec;
        const oeeExt = resolveOee(settings, m.oee_override, null);
        const availExt = baselineAvailabilitySeconds(m, oeeExt);
        if (availExt > 0) loadRatioSum += extSec / availExt;

        // Dodaj do material breakdown
        const extAlias = resolveBaselineMaterialAlias(mat.alias, mat.description);
        const extSap = mat.sap_number ?? null;
        const extDimA = Number(mat.width_mm);
        const extDimB = Number(mat.length_mm);
        const extOriented =
          Number.isFinite(extDimA) && extDimA > 0 && Number.isFinite(extDimB) && extDimB > 0
            ? orientBaselineDimensions(m, extDimA, extDimB)
            : null;
        if (!materialContribSec.has(mid)) {
          materialContribSec.set(mid, {
            alias: extAlias,
            sap_number: extSap,
            width_mm: extOriented?.widthMm ?? mat.width_mm ?? null,
            length_mm: extOriented?.lengthMm ?? mat.length_mm ?? null,
            grammage_kg_m2: mat.grammage_kg_m2 ?? null,
            requiredSec: 0,
            details: new Map(),
          });
        }
        const matEntry = materialContribSec.get(mid)!;
        matEntry.requiredSec += extSec;
        if (!matEntry.details.has('__external__')) {
          matEntry.details.set('__external__', { project_label: '', detail_label: 'Wolumen zewnętrzny', requiredSec: extSec });
        } else {
          matEntry.details.get('__external__')!.requiredSec += extSec;
        }
      }
    }

    // Machine usage 0..1: np. 0.5 = podwaja effective capacity (obciążenie maleje dwukrotnie).
    const usage = Math.max(0.1, Math.min(1, m.machine_usage ?? 1));
    const oeeMachine = resolveOee(settings, m.oee_override, null);
    const availabilitySecBase = Number(m.is_baseline)
      ? baselineAvailabilitySeconds(m, oeeMachine)
      : availabilitySecondsPerWeek(settings, oeeMachine);
    const availabilitySec = availabilitySecBase * (1 / usage);
    const loadPercent =
      availabilitySec > 0
        ? Math.round((totalRequiredSec / availabilitySec) * 100)
        : totalRequiredSec > 0
          ? 100
          : 0;
    const capacityPcsWeek = 0;

    let alternative_border: 'none' | 'unused' | 'all_alt' | 'mixed' = 'none';
    if (altBorderRelevant > 0) {
      if (altBorderUsed === altBorderRelevant) alternative_border = 'all_alt';
      else if (altBorderUnused === altBorderRelevant) alternative_border = 'unused';
      else alternative_border = 'mixed';
    }
    const detail_breakdown = Array.from(detailContributionSec.values())
      .map(({ project_label, detail_label, requiredSec, volumeQuantity, hasRfq }) => {
        const contribution_percent =
          availabilitySec > 0 ? Math.round((requiredSec / availabilitySec) * 10000) / 100 : 0;
        const share_percent = totalRequiredSec > 0 ? Math.round((requiredSec / totalRequiredSec) * 10000) / 100 : 0;
        const volume_quantity = Math.round(volumeQuantity * 100) / 100;
        return { project_label, detail_label, contribution_percent, share_percent, volume_quantity, has_rfq: hasRfq };
      })
      .sort((a, b) => b.contribution_percent - a.contribution_percent);

    const material_breakdown: MaterialBreakdownItem[] | undefined = Number(m.is_baseline)
      ? Array.from(materialContribSec.entries()).map(([, mat]) => ({
          material_alias: mat.alias,
          material_sap: mat.sap_number,
          material_width_mm: mat.width_mm,
          material_length_mm: mat.length_mm,
          material_grammage_kg_m2: mat.grammage_kg_m2,
          contribution_percent:
            availabilitySec > 0 ? Math.round((mat.requiredSec / availabilitySec) * 10000) / 100 : 0,
          details: Array.from(mat.details.values())
            .map((d) => ({
              project_label: d.project_label,
              detail_label: d.detail_label,
              contribution_percent:
                availabilitySec > 0 ? Math.round((d.requiredSec / availabilitySec) * 10000) / 100 : 0,
            }))
            .sort((a, b) => b.contribution_percent - a.contribution_percent),
        }))
        .sort((a, b) => b.contribution_percent - a.contribution_percent)
      : undefined;

    return {
      machine_id: m.machine_id,
      internal_number: m.internal_number,
      type: m.type,
      sap_number: m.sap_number,
      oee_override: m.oee_override,
      machine_status: m.machine_status ?? null,
      location: m.location != null ? String(m.location).trim() || null : null,
      width_mm: m.width_mm != null && Number.isFinite(Number(m.width_mm)) ? Number(m.width_mm) : null,
      depth_mm: m.depth_mm != null && Number.isFinite(Number(m.depth_mm)) ? Number(m.depth_mm) : null,
      height_mm: m.height_mm != null && Number.isFinite(Number(m.height_mm)) ? Number(m.height_mm) : null,
      stroke_mm: m.stroke_mm != null && Number.isFinite(Number(m.stroke_mm)) ? Number(m.stroke_mm) : null,
      year,
      is_baseline: Boolean(m.is_baseline),
      availability_sec_per_week: availabilitySec,
      required_sec_per_week: Math.round(totalRequiredSec),
      capacity_pcs_per_week: capacityPcsWeek,
      load_percent: loadPercent,
      utilization_percent: loadPercent,
      alternative_border,
      detail_breakdown,
      material_breakdown,
      has_rfq: hasRfq,
    };
  });
}

/** Szczegóły pod kątem symulacji alokacji (jedna maszyna): suma loadRatio i wkład wybranej operacji. */
export function getMachineLoadComputationDetails(
  year: number,
  machineId: number,
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  /** Gdy snapshot scenariusza i brak override: czy uwzględniać projekty RFQ (false = jak kalkulator produkcyjny, np. scenariusz zarchiwizowany). */
  scenarioIncludeRfq: boolean = true,
  useContractualVolumes: boolean = false,
  settingsProfile?: CalculationSettingsProfile
): {
  load_ratio_sum: number;
  usage: number;
  load_percent: number;
  availability_sec_per_week: number;
  required_sec_per_week: number;
  working_weeks_per_year: number;
  op_by_id: Record<
    number,
    {
      ratio_contrib: number;
      weekly_volume: number;
      resolved_volume_value: number;
      resolved_volume_unit: 'annual' | 'monthly' | 'weekly';
      fraction: number;
    }
  >;
} | null {
  const useContract = useContractualVolumes === true;
  const effectiveProfile: CalculationSettingsProfile = scenarioSnapshot != null ? 'capacity' : (settingsProfile ?? 'capacity');
  const settings =
    scenarioSnapshot != null
      ? resolveSettingsForScenarioYear(year, scenarioSnapshot) ?? resolveSettingsForYear(year, 'capacity')
      : resolveSettingsForYear(year, effectiveProfile);

  const mCandidate = db
    .prepare(`
    SELECT m.id AS machine_id, m.internal_number, m.type, m.oee_override, m.status, COALESCE(m.machine_usage, 1) AS machine_usage,
           m.is_baseline, m.baseline_available_hours_per_week, m.baseline_weeks_per_year,
           m.baseline_max_throughput_kg_h, m.baseline_max_throughput_unit,
           m.baseline_max_speed_m_min, m.baseline_max_speed_unit,
           m.baseline_max_blank_width_mm, m.baseline_max_blank_width_unit,
           m.baseline_min_length_mm,
           m.baseline_max_blanks_across
    FROM machines m
    WHERE m.id = ?
  `)
    .get(machineId) as any;
  if (!mCandidate) return null;
  const st = String(mCandidate.status ?? 'active');
  if (st === 'inactive') return null;
  if (st === 'RFQ') {
    if (!scenarioSnapshot || !operationsOverride) return null;
    const allow = scenarioLinkedRfqProductionMachineIds(scenarioSnapshot, scenarioIncludeRfq);
    if (!allow.includes(machineId)) return null;
  }
  const m = mCandidate;
  const machineVolumeSettings = volumeSettingsForMachine(settings, m);

  const baseOperations =
    operationsOverride ??
    (scenarioSnapshot != null
      ? scenarioHydratedOperationsForActiveProjects(scenarioSnapshot, { includeRfq: scenarioIncludeRfq })
      : (db.prepare(`
    SELECT o.id AS operation_id, o.project_id, o.part_id, o.machine_id, o.cycle_time_seconds, o.volume_value, o.volume_unit, o.nests_count, o.oee_override, o.capacity_percent,
           o.alt_cycle_time_seconds, o.alt_nests_count, o.alt_oee_override, o.use_alternative_in_calculator, o.split_from_operation_id,
           p.sop, p.eop, pt.designation_id AS detail_designation_id
    FROM operations o
    JOIN projects p ON p.id = o.project_id
    JOIN parts pt ON pt.id = o.part_id
    WHERE p.status = 'active'
  `).all() as any[]));
  const allowedBaselineProjects =
    operationsOverride != null
      ? new Set(
          operationsOverride
            .map((o: any) => Number(o.project_id))
            .filter((id: number) => Number.isFinite(id))
        )
      : undefined;
  const operations = mergeOperationsById(
    baseOperations,
    loadBaselineMaterialDemandOperations(scenarioSnapshot ?? null, allowedBaselineProjects)
  );

  const volumeMap = (() => {
    if (scenarioSnapshot != null) {
      const rows = (scenarioSnapshot.operation_volume_by_year || []).filter((v: any) => Number(v.year) === year) as {
        operation_id: number;
        year: number;
        volume_value: number;
        volume_unit: string;
        source?: string | null;
      }[];
      return new Map(
        rows.map((v) => [
          Number(v.operation_id),
          {
            volume_value: v.volume_value,
            volume_unit: v.volume_unit,
            source: v.source ?? null,
          },
        ])
      );
    }
    try {
      const volumeByYear = db
        .prepare(
          `SELECT operation_id, year, volume_value, volume_unit, COALESCE(source, 'manual') AS source
           FROM operation_volume_by_year WHERE year = ?`
        )
        .all(year) as {
        operation_id: number;
        year: number;
        volume_value: number;
        volume_unit: string;
        source: string;
      }[];
      return new Map(
        volumeByYear.map((v) => [
          v.operation_id,
          { volume_value: v.volume_value, volume_unit: v.volume_unit, source: v.source },
        ])
      );
    } catch {
      const volumeByYear = db
        .prepare('SELECT operation_id, year, volume_value, volume_unit FROM operation_volume_by_year WHERE year = ?')
        .all(year) as { operation_id: number; year: number; volume_value: number; volume_unit: string }[];
      return new Map(volumeByYear.map((v) => [v.operation_id, v]));
    }
  })();

  const machineOps = operations.filter(
    (o: any) =>
      o.machine_id === m.machine_id &&
      (Number(m.is_baseline)
        ? o.baseline_inferred_source === BASELINE_INFERRED_OPERATION
        : o.baseline_inferred_source !== BASELINE_INFERRED_OPERATION)
  );
  const baselineMaterials = loadBaselineMaterialIndex();
  const baselineExtVolumes = loadBaselineExternalVolumeIndex();
  const baselineExtMaterials = loadBaselineExternalMaterialIndex();
  let totalRequiredSec = 0;
  let loadRatioSum = 0;
  const opById: Record<
    number,
    {
      ratio_contrib: number;
      weekly_volume: number;
      resolved_volume_value: number;
      resolved_volume_unit: 'annual' | 'monthly' | 'weekly';
      fraction: number;
    }
  > = {};

  for (const op of machineOps) {
    const opKey = Number(op.operation_id ?? op.id);
    if (!Number.isFinite(opKey)) continue;
    const opVolumeOverride = volumeMap.get(opKey);
    const resolved = resolveOperationVolumeForYear(
      {
        operation_id: opKey,
        project_id: op.project_id,
        part_id: op.part_id,
        volume_value: op.volume_value,
        volume_unit: op.volume_unit,
        split_from_operation_id: op.split_from_operation_id,
      },
      year,
      opVolumeOverride ?? null,
      scenarioSnapshot ?? null,
      useContract,
      undefined,
      undefined,
      undefined,
      volumeMap
    );
    if (
      !shouldIncludeOperationInCapacity(
        op.sop ?? '',
        op.eop ?? '',
        year,
        undefined,
        Boolean(resolved.count_after_eop),
        op.project_id != null
      )
    ) {
      continue;
    }
    const volValue = resolved.volume_value;
    const volUnit = resolved.volume_unit;
    const weeklyResolved = resolveWeeklyVolumeFromResolved(volValue, volUnit, machineVolumeSettings, {
      sop: op.sop ?? '',
      eop: op.eop ?? '',
      year,
      volume_origin: resolved.volume_origin,
      count_after_eop: resolved.count_after_eop,
      has_project: op.project_id != null,
    });
    const weeklyVol = weeklyResolved.weekly;
    const fraction = weeklyResolved.fraction;
    const { cycleSeconds, nests, oeeForResolve } = resolveOperationCycleForCalculator(op);
    const requiredSecOp = Number(m.is_baseline)
      ? baselineRequiredSeconds(m, op.detail_designation_id, weeklyVol, baselineMaterials)
      : weeklyVol * (cycleSeconds / nests);
    totalRequiredSec += requiredSecOp;
    const oeeOp = resolveOee(settings, m.oee_override, oeeForResolve);
    const availabilitySecOp = Number(m.is_baseline)
      ? baselineAvailabilitySeconds(m, resolveOee(settings, m.oee_override, null))
      : availabilitySecondsPerWeek(settings, oeeOp);
    const ratioContrib = availabilitySecOp > 0 ? requiredSecOp / availabilitySecOp : 0;
    loadRatioSum += ratioContrib;
    opById[opKey] = {
      ratio_contrib: ratioContrib,
      weekly_volume: weeklyVol,
      resolved_volume_value: volValue,
      resolved_volume_unit: volUnit,
      fraction,
    };
  }

  // Materiały z wolumenem zewnętrznym (linia bazowa)
  if (Number(m.is_baseline)) {
    const extSec = baselineExternalVolumeRequiredSeconds(m, year, baselineExtVolumes, baselineExtMaterials);
    totalRequiredSec += extSec;
    const oeeExt = resolveOee(settings, m.oee_override, null);
    const availExt = baselineAvailabilitySeconds(m, oeeExt);
    if (availExt > 0) loadRatioSum += extSec / availExt;
  }

  const usage = Math.max(0.1, Math.min(1, m.machine_usage ?? 1));
  const oeeMachine = resolveOee(settings, m.oee_override, null);
  const availabilitySecBase = Number(m.is_baseline)
    ? baselineAvailabilitySeconds(m, oeeMachine)
    : availabilitySecondsPerWeek(settings, oeeMachine);
  const availabilitySec = availabilitySecBase * (1 / usage);
  const loadPercent =
    availabilitySec > 0
      ? Math.round((totalRequiredSec / availabilitySec) * 100)
      : totalRequiredSec > 0
        ? 100
        : 0;

  return {
    load_ratio_sum: loadRatioSum,
    usage,
    load_percent: loadPercent,
    availability_sec_per_week: availabilitySec,
    required_sec_per_week: Math.round(totalRequiredSec),
    working_weeks_per_year: Math.max(
      1,
      machineVolumeSettings.working_weeks_per_year ?? 48
    ),
    op_by_id: opById,
  };
}

export function getMachineCapacityByYears(
  yearFrom: number,
  yearTo: number,
  machineIds?: number[],
  machineType?: string | string[],
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfqProjects?: boolean,
  useContractualVolumes?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[],
  settingsProfile?: CalculationSettingsProfile,
  callOffVolumes?: import('./callOffService.js').CallOffVolumeMaps | null,
  calculationOptions?: CapacityCalculationOptions
): {
  machine_id: number;
  internal_number: string | number;
  sap_number: string | null;
  type: string;
  is_baseline: boolean;
  machine_status: string | null;
  location: string | null;
  width_mm: number | null;
  depth_mm: number | null;
  height_mm: number | null;
  stroke_mm: number | null;
  years: Record<
    number,
    {
      load_percent: number;
      capacity_pcs_per_week: number;
      required_sec_per_week: number;
      availability_sec_per_week?: number;
      alternative_border?: 'none' | 'unused' | 'all_alt' | 'mixed';
      detail_breakdown?: {
        project_label: string;
        detail_label: string;
        contribution_percent: number;
        share_percent: number;
        volume_quantity: number;
        has_rfq: boolean;
      }[];
      material_breakdown?: MaterialBreakdownItem[];
      has_rfq?: boolean;
    }
  >;
}[] {
  const machineMap = new Map<
    number,
    {
      internal_number: string | number;
      sap_number: string | null;
      type: string;
      is_baseline: boolean;
      machine_status: string | null;
      location: string | null;
      width_mm: number | null;
      depth_mm: number | null;
      height_mm: number | null;
      stroke_mm: number | null;
      years: Record<number, any>;
    }
  >();

  const shared = buildCapacityComputeShared(
    yearFrom,
    yearTo,
    operationsOverride,
    scenarioSnapshot ?? null,
    settingsProfile,
    calculationOptions?.includeRfqOperationIds
  );

  for (let y = yearFrom; y <= yearTo; y++) {
    const rows = getMachineCapacitiesForYear(
      y,
      machineIds,
      machineType,
      operationsOverride,
      scenarioSnapshot ?? null,
      scenarioIncludeRfqProjects,
      useContractualVolumes,
      machineStatusFilter,
      dimensionFilters,
      settingsProfile,
      undefined,
      shared,
      callOffVolumes,
      undefined,
      calculationOptions
    );

    /**
     * Produkcja / scenariusz / kontrakt (bez Call offs): obciążenie roczne = średnia z 12 miesięcy
     * (zera po EOP też wchodzą do średniej — np. 6×182 + 6×0 → 91).
     * Call offs nadpisuje load w callOffCapacityService / scenarioCallOffCapacityService
     * (średnia miesięcy w zakresie danych SAP).
     */
    const monthlyByMachine =
      callOffVolumes == null
        ? getMachineMonthlyLoadsByMonth(
            y,
            machineIds,
            machineType,
            operationsOverride,
            scenarioSnapshot ?? null,
            scenarioIncludeRfqProjects,
            useContractualVolumes,
            machineStatusFilter,
            dimensionFilters,
            settingsProfile,
            null,
            calculationOptions
          )
        : null;

    for (const r of rows) {
      if (!machineMap.has(r.machine_id)) {
        machineMap.set(r.machine_id, {
          internal_number: r.internal_number,
          sap_number: r.sap_number ?? null,
          type: r.type,
          is_baseline: Boolean((r as any).is_baseline),
          machine_status: r.machine_status != null ? String(r.machine_status) : null,
          location: r.location != null ? String(r.location).trim() || null : null,
          width_mm: r.width_mm != null && Number.isFinite(Number(r.width_mm)) ? Number(r.width_mm) : null,
          depth_mm: r.depth_mm != null && Number.isFinite(Number(r.depth_mm)) ? Number(r.depth_mm) : null,
          height_mm: r.height_mm != null && Number.isFinite(Number(r.height_mm)) ? Number(r.height_mm) : null,
          stroke_mm: r.stroke_mm != null && Number.isFinite(Number(r.stroke_mm)) ? Number(r.stroke_mm) : null,
          years: {},
        });
      }
      const ent = machineMap.get(r.machine_id)!;
      let loadPercent = r.load_percent;
      if (monthlyByMachine) {
        const months = monthlyByMachine.get(r.machine_id);
        const vals: number[] = [];
        for (let m = 1; m <= 12; m++) vals.push(months?.get(m)?.load_percent ?? 0);
        const sum = vals.reduce((a, b) => a + b, 0);
        loadPercent = Math.round(sum / 12);
      }
      ent.years[r.year] = {
        load_percent: loadPercent,
        capacity_pcs_per_week: r.capacity_pcs_per_week,
        required_sec_per_week: r.required_sec_per_week,
        availability_sec_per_week: r.availability_sec_per_week,
        alternative_border: r.alternative_border,
        detail_breakdown: r.detail_breakdown ?? [],
        material_breakdown: (r as any).material_breakdown ?? undefined,
        has_rfq: Boolean(r.has_rfq),
      };
    }
  }

  return Array.from(machineMap.entries()).map(([machine_id, v]) => ({
    machine_id,
    internal_number: v.internal_number,
    sap_number: v.sap_number,
    type: v.type,
    is_baseline: (v as any).is_baseline ?? false,
    machine_status: v.machine_status,
    location: v.location,
    width_mm: v.width_mm,
    depth_mm: v.depth_mm,
    height_mm: v.height_mm,
    stroke_mm: v.stroke_mm,
    years: v.years,
  }));
}

export type MachinePeriodMonthBreakdown = {
  load_percent: number;
  weeks: Record<
    number,
    {
      load_percent: number;
      detail_breakdown?: {
        project_label: string;
        detail_label: string;
        contribution_percent: number;
        share_percent: number;
        volume_quantity: number;
        has_rfq: boolean;
      }[];
      material_breakdown?: MaterialBreakdownItem[];
    }
  >;
  has_sop: boolean;
  has_eop: boolean;
  detail_breakdown?: {
    project_label: string;
    detail_label: string;
    contribution_percent: number;
    share_percent: number;
    volume_quantity: number;
    has_rfq: boolean;
  }[];
  material_breakdown?: MaterialBreakdownItem[];
};

export type MachinePeriodBreakdownRow = {
  machine_id: number;
  has_sop: boolean;
  has_eop: boolean;
  months: Record<number, MachinePeriodMonthBreakdown>;
};

export type MachineYearSopEopMarkers = {
  has_sop: boolean;
  has_eop: boolean;
  months: Record<number, { has_sop: boolean; has_eop: boolean }>;
};

function emptyYearSopEopMarkers(): MachineYearSopEopMarkers {
  return { has_sop: false, has_eop: false, months: {} };
}

function applySopEopToYearMarkers(markers: MachineYearSopEopMarkers, sop: unknown, eop: unknown, year: number): void {
  const sopP = parseSopEop(sop);
  const eopP = parseSopEop(eop);
  if (sopP && sopP.year === year) {
    markers.has_sop = true;
    if (!markers.months[sopP.month]) markers.months[sopP.month] = { has_sop: false, has_eop: false };
    markers.months[sopP.month].has_sop = true;
  }
  if (eopP && eopP.year === year) {
    markers.has_eop = true;
    if (!markers.months[eopP.month]) markers.months[eopP.month] = { has_sop: false, has_eop: false };
    markers.months[eopP.month].has_eop = true;
  }
}

function computeMachineSopEopMarkersForYear(machineOps: any[], year: number): MachineYearSopEopMarkers {
  const markers = emptyYearSopEopMarkers();
  for (const op of machineOps) {
    applySopEopToYearMarkers(markers, op.sop, op.eop, year);
  }
  return markers;
}

function loadCalculatorOperations(
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null
): any[] {
  if (operationsOverride) return operationsOverride;
  return db.prepare(`
    SELECT o.id AS operation_id, o.machine_id, p.sop, p.eop, p.status AS project_status
    FROM operations o
    JOIN projects p ON p.id = o.project_id
    WHERE p.status = 'active'
  `).all() as any[];
}

/** Znaczniki SOP/EOP detali na maszynach w zakresie lat (do kafelków kalkulatora). */
export function getMachineSopEopMarkersByYears(
  yearFrom: number,
  yearTo: number,
  machineIds?: number[],
  machineType?: string | string[],
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfqProjects?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[]
): { machine_id: number; years: Record<number, MachineYearSopEopMarkers> }[] {
  const scenarioRfqs =
    scenarioSnapshot != null && operationsOverride != null
      ? scenarioLinkedRfqProductionMachineIds(scenarioSnapshot, scenarioIncludeRfqProjects !== false)
      : [];
  const msList = normalizeMachineStatusFilters(machineStatusFilter);
  const effectiveStatuses: CalculatorMachineStatusFilter[] =
    msList.length > 0 ? msList : machineStatusFilter === undefined ? ['active'] : [];
  const statusWhere = buildMachineStatusWhere(effectiveStatuses, scenarioRfqs);

  let machinesSql = `SELECT m.id AS machine_id FROM machines m WHERE ${statusWhere.clause}`;
  const params: (number | string)[] = [...statusWhere.params];
  if (machineIds?.length) {
    machinesSql += ` AND m.id IN (${machineIds.map(() => '?').join(',')})`;
    params.push(...machineIds);
  }
  const types = normalizeMachineTypes(machineType);
  if (types.length === 1) {
    machinesSql += ' AND m.type = ?';
    params.push(types[0]);
  } else if (types.length > 1) {
    machinesSql += ` AND m.type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }
  if (dimensionFilters?.length) {
    const dim = appendMachineDimensionFilters(dimensionFilters);
    if (dim.clause !== '1=1') {
      machinesSql += ` AND (${dim.clause})`;
      params.push(...dim.params);
    }
  }
  const machines = db.prepare(machinesSql).all(...params) as { machine_id: number }[];
  const operations = loadCalculatorOperations(operationsOverride, scenarioSnapshot);

  return machines.map((m) => {
    const machineOps = operations.filter((o: any) => Number(o.machine_id) === m.machine_id);
    const years: Record<number, MachineYearSopEopMarkers> = {};
    for (let y = yearFrom; y <= yearTo; y++) {
      years[y] = computeMachineSopEopMarkersForYear(machineOps, y);
    }
    return { machine_id: m.machine_id, years };
  });
}

export type MachinePeriodBreakdownOptions = {
  /** Domyślnie true. false = tylko miesiące (bez tygodni) — szybka ścieżka pod średnią roczną Call offs. */
  includeWeeks?: boolean;
  /** Call offs: pokaż przypisane detale z 0% (bez placeholderów alokacji na inny rok). */
  includeAssignedZeroVolumeDetailsInBreakdown?: boolean;
  includeRfqOperationIds?: number[];
};

export type CapacityCalculationOptions = {
  includeAssignedZeroVolumeDetailsInBreakdown?: boolean;
  /** Operacje projektów RFQ do doliczenia do capacity produkcyjnego/kontraktowego (wizualizacja). */
  includeRfqOperationIds?: number[];
};

type MonthPeakDetail = {
  project_label: string;
  detail_label: string;
  contribution_percent: number;
  share_percent: number;
  volume_quantity: number;
  has_rfq: boolean;
}[];

/**
 * Rozkład detali i materiałów (linie bazowe) do tooltipa przy średniej obciążenia:
 * wybierz okres najbliższy targetLoad, ale preferuj okresy z niepustym breakdown
 * (inaczej „najbliższy” często jest 0% bez detali przy średniej np. 25–60%).
 * Używane wszędzie, gdzie miesiąc/rok = średnia tygodni/miesięcy
 * (getMachinePeriodBreakdown, getMachineMonthlyLoadsByMonth/AverageLoads).
 */
function pickBreakdownsClosestToLoad(
  candidates: { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }[],
  targetLoad: number
): { detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] } {
  if (candidates.length === 0) return { detail_breakdown: [], material_breakdown: [] };
  const withDetails = candidates.filter(
    (c) => (c.detail_breakdown?.length ?? 0) > 0 || (c.material_breakdown?.length ?? 0) > 0
  );
  const pool = withDetails.length > 0 ? withDetails : candidates;
  let best = pool[0]!;
  let bestDist = Math.abs(Number(best.load_percent) - targetLoad);
  for (let i = 1; i < pool.length; i++) {
    const c = pool[i]!;
    const dist = Math.abs(Number(c.load_percent) - targetLoad);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return { detail_breakdown: best.detail_breakdown ?? [], material_breakdown: best.material_breakdown ?? [] };
}

/**
 * Obciążenie miesięczne (1–12) dla wszystkich maszyn.
 * Produkcja / scenariusz: obciążenie z wolumenu miesięcznego (rok = średnia 12 miesięcy).
 * Call offs: miesiąc = średnia tygodni w zakresie danych SAP (zera w zakresie liczą się).
 * Bez tygodni SAP → obciążenie z wolumenu miesięcznego.
 */
export function getMachineMonthlyLoadsByMonth(
  year: number,
  machineIds?: number[],
  machineType?: string | string[],
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfqProjects?: boolean,
  useContractualVolumes?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[],
  settingsProfile?: CalculationSettingsProfile,
  callOffVolumes?: import('./callOffService.js').CallOffVolumeMaps | null,
  calculationOptions?: CapacityCalculationOptions
): Map<
  number,
  Map<number, { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }>
> {
  const shared = buildCapacityComputeShared(
    year,
    year,
    operationsOverride,
    scenarioSnapshot ?? null,
    settingsProfile,
    calculationOptions?.includeRfqOperationIds
  );
  const byMachine = new Map<
    number,
    Map<number, { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }>
  >();

  for (let month = 1; month <= 12; month++) {
    if (callOffVolumes) {
      const weekRange = getSapWeekRangeForMonth(callOffVolumes, year, month);
      if (weekRange) {
        const weekLoads = new Map<
          number,
          { loads: number[]; details: MonthPeakDetail[]; materials: MaterialBreakdownItem[][] }
        >();
        for (let w = weekRange.from; w <= weekRange.to; w++) {
          const weekRows = getMachineCapacitiesForYear(
            year,
            machineIds,
            machineType,
            operationsOverride,
            scenarioSnapshot,
            scenarioIncludeRfqProjects,
            useContractualVolumes,
            machineStatusFilter,
            dimensionFilters,
            settingsProfile,
            month,
            shared,
            callOffVolumes,
            'weekly',
            calculationOptions,
            w
          );
          for (const row of weekRows) {
            if (!weekLoads.has(row.machine_id)) {
              weekLoads.set(row.machine_id, { loads: [], details: [], materials: [] });
            }
            const bucket = weekLoads.get(row.machine_id)!;
            bucket.loads.push(row.load_percent ?? 0);
            bucket.details.push((row.detail_breakdown ?? []) as MonthPeakDetail);
            bucket.materials.push(((row as any).material_breakdown ?? []) as MaterialBreakdownItem[]);
          }
        }
        for (const [machineId, bucket] of weekLoads) {
          if (!byMachine.has(machineId)) byMachine.set(machineId, new Map());
          const avg = averageLoadPercent(bucket.loads);
          const picked = pickBreakdownsClosestToLoad(
            bucket.loads.map((load_percent, i) => ({
              load_percent,
              detail_breakdown: bucket.details[i] ?? [],
              material_breakdown: bucket.materials[i] ?? [],
            })),
            avg
          );
          const ww = Math.max(1, shared.settingsByYear.get(year)?.working_weeks_per_year ?? 48);
          byMachine.get(machineId)!.set(month, {
            load_percent: avg,
            detail_breakdown: convertBreakdownVolumesWeeklyToMonthly(picked.detail_breakdown, ww),
            material_breakdown: picked.material_breakdown,
          });
        }
        continue;
      }
    }

    const monthRows = getMachineCapacitiesForYear(
      year,
      machineIds,
      machineType,
      operationsOverride,
      scenarioSnapshot,
      scenarioIncludeRfqProjects,
      useContractualVolumes,
      machineStatusFilter,
      dimensionFilters,
      settingsProfile,
      month,
      shared,
      callOffVolumes,
      undefined,
      calculationOptions
    );
    for (const row of monthRows) {
      if (!byMachine.has(row.machine_id)) byMachine.set(row.machine_id, new Map());
      byMachine.get(row.machine_id)!.set(month, {
        load_percent: row.load_percent ?? 0,
        detail_breakdown: (row.detail_breakdown ?? []) as MonthPeakDetail,
        material_breakdown: ((row as any).material_breakdown ?? []) as MaterialBreakdownItem[],
      });
    }
  }

  return byMachine;
}

/**
 * Średnie obciążenie w roku z miesięcy (produkcja: 1–12; Call offs: zakres miesięcy z danymi SAP).
 * Używane przy komórkach rocznych Call offs / scenariuszy z Call offs.
 */
export function getMachineMonthlyAverageLoads(
  year: number,
  machineIds?: number[],
  machineType?: string | string[],
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfqProjects?: boolean,
  useContractualVolumes?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[],
  settingsProfile?: CalculationSettingsProfile,
  callOffVolumes?: import('./callOffService.js').CallOffVolumeMaps | null
): Map<number, { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }> {
  const byMonth = getMachineMonthlyLoadsByMonth(
    year,
    machineIds,
    machineType,
    operationsOverride,
    scenarioSnapshot,
    scenarioIncludeRfqProjects,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    callOffVolumes
  );
  const sapMonthRange = callOffVolumes ? getSapMonthRangeForYear(callOffVolumes, year) : { from: 1, to: 12 };
  const monthFrom = sapMonthRange?.from ?? null;
  const monthTo = sapMonthRange?.to ?? null;
  const averages = new Map<
    number,
    { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }
  >();
  if (monthFrom == null || monthTo == null) {
    for (const machineId of byMonth.keys()) {
      averages.set(machineId, { load_percent: 0, detail_breakdown: [], material_breakdown: [] });
    }
    return averages;
  }
  for (const [machineId, months] of byMonth) {
    const vals: number[] = [];
    const monthCandidates: { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }[] =
      [];
    for (let m = monthFrom; m <= monthTo; m++) {
      const md = months.get(m) ?? {
        load_percent: 0,
        detail_breakdown: [] as MonthPeakDetail,
        material_breakdown: [] as MaterialBreakdownItem[],
      };
      vals.push(md.load_percent);
      monthCandidates.push({
        load_percent: md.load_percent,
        detail_breakdown: md.detail_breakdown ?? [],
        material_breakdown: md.material_breakdown ?? [],
      });
    }
    const avg = averageLoadPercent(vals);
    const picked = pickBreakdownsClosestToLoad(monthCandidates, avg);
    averages.set(machineId, {
      load_percent: avg,
      detail_breakdown: picked.detail_breakdown,
      material_breakdown: picked.material_breakdown,
    });
  }
  // Maszyny bez wpisu w byMonth (brak load w zakresie) — 0%.
  if (machineIds?.length) {
    for (const id of machineIds) {
      if (!averages.has(id)) averages.set(id, { load_percent: 0, detail_breakdown: [], material_breakdown: [] });
    }
  }
  return averages;
}

/** @deprecated Użyj getMachineMonthlyAverageLoads — zachowane dla kompatybilności importów. */
export function getMachineMonthlyPeakLoads(
  year: number,
  machineIds?: number[],
  machineType?: string | string[],
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfqProjects?: boolean,
  useContractualVolumes?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[],
  settingsProfile?: CalculationSettingsProfile,
  callOffVolumes?: import('./callOffService.js').CallOffVolumeMaps | null
): Map<number, { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }> {
  return getMachineMonthlyAverageLoads(
    year,
    machineIds,
    machineType,
    operationsOverride,
    scenarioSnapshot,
    scenarioIncludeRfqProjects,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    callOffVolumes
  );
}

/** Rozbicie obciążenia maszyn na miesiące i tygodnie w jednym roku (SOP/EOP per operacja). */
export function getMachinePeriodBreakdown(
  year: number,
  machineIds?: number[],
  machineType?: string | string[],
  operationsOverride?: any[],
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfqProjects?: boolean,
  useContractualVolumes?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[],
  settingsProfile?: CalculationSettingsProfile,
  callOffVolumes?: import('./callOffService.js').CallOffVolumeMaps | null,
  options?: MachinePeriodBreakdownOptions
): MachinePeriodBreakdownRow[] {
  const includeWeeks = options?.includeWeeks !== false;
  const calculationOptions: CapacityCalculationOptions | undefined =
    options?.includeAssignedZeroVolumeDetailsInBreakdown || options?.includeRfqOperationIds?.length
      ? {
          ...(options?.includeAssignedZeroVolumeDetailsInBreakdown
            ? { includeAssignedZeroVolumeDetailsInBreakdown: true }
            : {}),
          ...(options?.includeRfqOperationIds?.length
            ? { includeRfqOperationIds: options.includeRfqOperationIds }
            : {}),
        }
      : undefined;
  const shared = buildCapacityComputeShared(
    year,
    year,
    operationsOverride,
    scenarioSnapshot ?? null,
    settingsProfile,
    calculationOptions?.includeRfqOperationIds
  );
  const operationsByMachine = shared.operationsByMachine;

  const machines = getMachineCapacitiesForYear(
    year,
    machineIds,
    machineType,
    operationsOverride,
    scenarioSnapshot,
    scenarioIncludeRfqProjects,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    undefined,
    shared,
    callOffVolumes,
    undefined,
    calculationOptions
  );

  /** month -> machine_id -> { load, detail } — jeden przebieg na miesiąc dla wszystkich maszyn. */
  const monthByMachine = new Map<
    number,
    Record<number, { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }>
  >();
  /** machineId-month-week -> week load (Call offs: osobny wolumen na tydzień). */
  const weekByMachineMonthWeek = new Map<
    string,
    { load_percent: number; detail_breakdown: MonthPeakDetail; material_breakdown: MaterialBreakdownItem[] }
  >();

  for (const m of machines) {
    monthByMachine.set(m.machine_id, {});
  }

  for (let month = 1; month <= 12; month++) {
    const monthRows = getMachineCapacitiesForYear(
      year,
      machineIds,
      machineType,
      operationsOverride,
      scenarioSnapshot,
      scenarioIncludeRfqProjects,
      useContractualVolumes,
      machineStatusFilter,
      dimensionFilters,
      settingsProfile,
      month,
      shared,
      callOffVolumes,
      undefined,
      calculationOptions
    );
    for (const row of monthRows) {
      const bucket = monthByMachine.get(row.machine_id);
      if (!bucket) continue;
      bucket[month] = {
        load_percent: row.load_percent ?? 0,
        detail_breakdown: (row.detail_breakdown ?? []) as MonthPeakDetail,
        material_breakdown: ((row as any).material_breakdown ?? []) as MaterialBreakdownItem[],
      };
    }

    if (includeWeeks) {
      const weekCount = getWeekCountInMonth(year, month);
      const useTrueWeeklyCallOff = callOffVolumes != null;
      const yearHasPartialAllocation = [...(shared.opVolumeMapByYear.get(year)?.values() ?? [])].some(
        (v) => v.effective_from_month != null && Number.isFinite(Number(v.effective_from_month))
      );
      const computeEachWeek = useTrueWeeklyCallOff || yearHasPartialAllocation;
      for (let w = 1; w <= weekCount; w++) {
        const weekRows = getMachineCapacitiesForYear(
          year,
          machineIds,
          machineType,
          operationsOverride,
          scenarioSnapshot,
          scenarioIncludeRfqProjects,
          useContractualVolumes,
          machineStatusFilter,
          dimensionFilters,
          settingsProfile,
          month,
          shared,
          callOffVolumes,
          'weekly',
          calculationOptions,
          computeEachWeek ? w : undefined
        );
        for (const row of weekRows) {
          weekByMachineMonthWeek.set(`${row.machine_id}-${month}-${w}`, {
            load_percent: row.load_percent ?? 0,
            detail_breakdown: (row.detail_breakdown ?? []) as MonthPeakDetail,
            material_breakdown: ((row as any).material_breakdown ?? []) as MaterialBreakdownItem[],
          });
        }
        // Bez Call offs i bez alokacji od tygodnia: jeden przebieg wystarczy — skopiuj do pozostałych tygodni.
        if (!computeEachWeek) {
          for (const row of weekRows) {
            for (let w2 = 2; w2 <= weekCount; w2++) {
              weekByMachineMonthWeek.set(`${row.machine_id}-${month}-${w2}`, {
                load_percent: row.load_percent ?? 0,
                detail_breakdown: (row.detail_breakdown ?? []) as MonthPeakDetail,
                material_breakdown: ((row as any).material_breakdown ?? []) as MaterialBreakdownItem[],
              });
            }
          }
          break;
        }
      }
    }
  }

  const result: MachinePeriodBreakdownRow[] = [];
  for (const m of machines) {
    const machineOps = operationsByMachine.get(m.machine_id) ?? [];
    const yearMarkers = computeMachineSopEopMarkersForYear(machineOps, year);
    const monthsData = monthByMachine.get(m.machine_id) ?? {};
    const months: Record<number, MachinePeriodMonthBreakdown> = {};
    for (let month = 1; month <= 12; month++) {
      const md = monthsData[month] ?? { load_percent: 0, detail_breakdown: [], material_breakdown: [] };
      const weeks: MachinePeriodMonthBreakdown['weeks'] = {};
      if (includeWeeks) {
        const weekCount = getWeekCountInMonth(year, month);
        for (let w = 1; w <= weekCount; w++) {
          const wd = weekByMachineMonthWeek.get(`${m.machine_id}-${month}-${w}`);
          weeks[w] = {
            load_percent: wd?.load_percent ?? md.load_percent,
            detail_breakdown: wd?.detail_breakdown ?? md.detail_breakdown ?? [],
            material_breakdown: wd?.material_breakdown ?? md.material_breakdown ?? [],
          };
        }
      }
      const monthMarker = yearMarkers.months[month] ?? { has_sop: false, has_eop: false };
      let monthLoad = md.load_percent;
      let monthDetail = md.detail_breakdown ?? [];
      let monthMaterial = md.material_breakdown ?? [];
      // Miesiąc = średnia tygodni w okresie (produkcja: wszystkie tygodnie; Call offs: zakres SAP).
      if (includeWeeks) {
        const weekCount = getWeekCountInMonth(year, month);
        let from = 1;
        let to = weekCount;
        if (callOffVolumes) {
          const wr = getSapWeekRangeForMonth(callOffVolumes, year, month);
          if (wr) {
            from = wr.from;
            to = wr.to;
          } else {
            // Brak tygodni SAP — zostaw obciążenie miesięczne z wolumenu miesięcznego.
            from = 0;
            to = -1;
          }
        }
        if (from <= to) {
          const vals: number[] = [];
          const details: MonthPeakDetail[] = [];
          const materials: MaterialBreakdownItem[][] = [];
          for (let w = from; w <= to; w++) {
            const wd = weeks[w];
            vals.push(wd?.load_percent ?? 0);
            details.push((wd?.detail_breakdown ?? []) as MonthPeakDetail);
            materials.push((wd?.material_breakdown ?? []) as MaterialBreakdownItem[]);
          }
          monthLoad = averageLoadPercent(vals);
          const picked = pickBreakdownsClosestToLoad(
            vals.map((load_percent, i) => ({
              load_percent,
              detail_breakdown: details[i] ?? [],
              material_breakdown: materials[i] ?? [],
            })),
            monthLoad
          );
          // Obciążenie miesiąca = średnia tygodni; skład z tygodnia najbliższego średniej.
          // Tooltip miesiąca: szt./mies. — przelicz ilości z tygodniowych (produkcja i Call offs).
          const ww = Math.max(1, shared.settingsByYear.get(year)?.working_weeks_per_year ?? 48);
          monthDetail = convertBreakdownVolumesWeeklyToMonthly(picked.detail_breakdown, ww);
          monthMaterial = picked.material_breakdown;
        }
      }
      months[month] = {
        load_percent: monthLoad,
        weeks,
        has_sop: monthMarker.has_sop,
        has_eop: monthMarker.has_eop,
        detail_breakdown: monthDetail,
        material_breakdown: monthMaterial,
      };
    }
    result.push({
      machine_id: m.machine_id,
      has_sop: yearMarkers.has_sop,
      has_eop: yearMarkers.has_eop,
      months,
    });
  }
  return result;
}

export function getNestCapacitiesForYear(year: number): { nest_id: number; nest_name: string | null; machines: MachineCapacityRow[] }[] {
  const nests = db.prepare('SELECT id, name FROM nests').all() as { id: number; name: string | null }[];
  const result: { nest_id: number; nest_name: string | null; machines: MachineCapacityRow[] }[] = [];

  for (const nest of nests) {
    const machineIds = db.prepare('SELECT machine_id FROM nest_machines WHERE nest_id = ?').all(nest.id) as { machine_id: number }[];
    const ids = machineIds.map((m) => m.machine_id);
    if (ids.length === 0) continue;
    const machines = getMachineCapacitiesForYear(year, ids);
    result.push({ nest_id: nest.id, nest_name: nest.name, machines });
  }
  return result;
}

function lineKeyFromLocation(location: string | null | undefined): string {
  const t = String(location ?? '').trim();
  return t || '—';
}

export type CapacityBreakdownDetail = {
  detail_label: string;
  load_percent: number;
  share_percent: number;
  has_rfq: boolean;
};

export type CapacityBreakdownProject = {
  project_id: number;
  project_name: string;
  load_percent: number;
  share_percent: number;
  details: CapacityBreakdownDetail[];
};

export type CapacityBreakdownClient = {
  client: string;
  load_percent: number;
  share_percent: number;
  projects: CapacityBreakdownProject[];
};

export type CapacityBreakdownSeries = {
  load_percent: number | null;
  clients: CapacityBreakdownClient[];
};

export type CapacityBreakdownSeriesKey =
  | 'production'
  | 'contract'
  | 'scenario_production'
  | 'scenario_contract'
  | 'call_off';

type BreakdownScope = { kind: 'line'; line: string } | { kind: 'machine'; machineId: number };

type BreakdownOpts = {
  machineIds?: number[];
  machineType?: string | string[];
  operationsOverride?: any[];
  scenarioSnapshot?: ScenarioBundle | null;
  scenarioIncludeRfqProjects?: boolean;
  useContractualVolumes?: boolean;
  machineStatusFilter?: MachineStatusFilterInput;
  dimensionFilters?: MachineDimensionFilter[];
  settingsProfile?: CalculationSettingsProfile;
  callOffVolumes?: import('./callOffService.js').CallOffVolumeMaps | null;
  includeRfqOperationIds?: number[];
  /** Miesiąc 1–12 — breakdown jak na wykresie miesięcznym/tygodniowym. */
  activeMonth?: number;
  /** Tydzień w miesiącu (T1…) — wymaga activeMonth. */
  activeWeek?: number;
};

function scenarioProjectLookup(snapshot: ScenarioBundle | null | undefined): Map<number, { client: string; name: string }> {
  const map = new Map<number, { client: string; name: string }>();
  if (!snapshot?.projects) return map;
  for (const p of snapshot.projects) {
    map.set(Number(p.id), { client: String(p.client ?? ''), name: String(p.name ?? '') });
  }
  return map;
}

function loadOperationsForBreakdown(
  operationsOverride?: any[],
  includeRfqOperationIds?: number[],
  scenarioSnapshot?: ScenarioBundle | null
): any[] {
  let operations =
    operationsOverride ??
    mergeOperationsById(
      db.prepare(`${CAPACITY_OPS_SELECT} WHERE p.status = 'active'`).all() as any[],
      loadRfqOperationsByIds(includeRfqOperationIds ?? [])
    );
  const allowedBaselineProjects =
    operationsOverride != null
      ? new Set(
          operationsOverride
            .map((o: any) => Number(o.project_id))
            .filter((id: number) => Number.isFinite(id))
        )
      : undefined;
  operations = mergeOperationsById(
    operations,
    loadBaselineMaterialDemandOperations(scenarioSnapshot ?? null, allowedBaselineProjects)
  );
  return operations;
}

function resolveScopeMachineIds(
  scope: BreakdownScope,
  opts: Pick<
    BreakdownOpts,
    | 'machineIds'
    | 'machineType'
    | 'machineStatusFilter'
    | 'dimensionFilters'
    | 'scenarioSnapshot'
    | 'scenarioIncludeRfqProjects'
    | 'includeRfqOperationIds'
  >
): number[] {
  const msList = normalizeMachineStatusFilters(opts.machineStatusFilter);
  const effectiveStatuses: CalculatorMachineStatusFilter[] =
    msList.length > 0 ? msList : opts.machineStatusFilter === undefined ? ['active'] : [];
  const scenarioRfqs =
    opts.scenarioSnapshot != null
      ? scenarioLinkedRfqProductionMachineIds(opts.scenarioSnapshot, opts.scenarioIncludeRfqProjects !== false)
      : [];
  const statusWhere = buildMachineStatusWhere(effectiveStatuses, scenarioRfqs);
  const rfqMachineIds = resolveMachineIdsForRfqOperations(opts.includeRfqOperationIds ?? []);
  let machineStatusClause = statusWhere.clause;
  const machineStatusParams: (number | string)[] = [...statusWhere.params];
  if (rfqMachineIds.length) {
    machineStatusClause = `(${statusWhere.clause}) OR m.id IN (${rfqMachineIds.map(() => '?').join(',')})`;
    machineStatusParams.push(...rfqMachineIds);
  }

  let machinesSql = `
    SELECT m.id AS machine_id, m.location
    FROM machines m
    WHERE ${machineStatusClause}
  `;
  const params: (number | string)[] = [...machineStatusParams];
  if (opts.machineIds?.length) {
    machinesSql += ` AND m.id IN (${opts.machineIds.map(() => '?').join(',')})`;
    params.push(...opts.machineIds);
  }
  const types = normalizeMachineTypes(opts.machineType);
  if (types.length === 1) {
    machinesSql += ' AND m.type = ?';
    params.push(types[0]);
  } else if (types.length > 1) {
    machinesSql += ` AND m.type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }
  if (opts.dimensionFilters?.length) {
    const dim = appendMachineDimensionFilters(opts.dimensionFilters);
    if (dim.clause !== '1=1') {
      machinesSql += ` AND (${dim.clause})`;
      params.push(...dim.params);
    }
  }

  const machines = db.prepare(machinesSql).all(...params) as { machine_id: number; location: string | null }[];
  return machines
    .filter((m) => {
      if (scope.kind === 'machine') return m.machine_id === scope.machineId;
      return lineKeyFromLocation(m.location) === scope.line;
    })
    .map((m) => m.machine_id);
}

function scopeTotalsFromRows(rows: MachineCapacityRow[]): {
  requiredSec: number;
  availabilitySec: number;
  loadPercent: number | null;
} {
  if (!rows.length) return { requiredSec: 0, availabilitySec: 0, loadPercent: null };
  let req = 0;
  let avail = 0;
  for (const r of rows) {
    req += r.required_sec_per_week ?? 0;
    avail += r.availability_sec_per_week ?? 0;
  }
  if (avail <= 0) return { requiredSec: req, availabilitySec: avail, loadPercent: req > 0 ? 100 : null };
  return {
    requiredSec: req,
    availabilitySec: avail,
    loadPercent: Math.round((req / avail) * 100),
  };
}

function scopeLoadPercentFromRows(rows: MachineCapacityRow[], _scope: BreakdownScope): number | null {
  return scopeTotalsFromRows(rows).loadPercent;
}

type BreakdownAccum = {
  totalRequiredSec: number;
  clients: Map<
    string,
    {
      requiredSec: number;
      projects: Map<
        number,
        {
          project_name: string;
          requiredSec: number;
          details: Map<string, { requiredSec: number; hasRfq: boolean }>;
        }
      >;
    }
  >;
};

function accumulateScopeBreakdown(
  year: number,
  scopeMachineIds: Set<number>,
  opts: BreakdownOpts
): BreakdownAccum {
  const useContract = opts.useContractualVolumes === true;
  const effectiveProfile: CalculationSettingsProfile =
    opts.scenarioSnapshot != null ? 'capacity' : (opts.settingsProfile ?? 'capacity');
  const settings =
    opts.scenarioSnapshot != null
      ? resolveSettingsForScenarioYear(year, opts.scenarioSnapshot) ?? resolveSettingsForYear(year, 'capacity')
      : resolveSettingsForYear(year, effectiveProfile);
  const refMode = loadReferenceDisplayMode();
  const projectLookup = scenarioProjectLookup(opts.scenarioSnapshot);
  const operations = loadOperationsForBreakdown(
    opts.operationsOverride,
    opts.includeRfqOperationIds,
    opts.scenarioSnapshot
  );
  const baselineMaterials = loadBaselineMaterialIndex();
  const baselineScopeExtVolumes = loadBaselineExternalVolumeIndex();
  const baselineScopeExtMaterials = loadBaselineExternalMaterialIndex();
  const scopeMachines = db
    .prepare(
      `SELECT id AS machine_id, is_baseline,
              baseline_weeks_per_year,
              baseline_max_throughput_kg_h, baseline_max_throughput_unit,
              baseline_max_speed_m_min, baseline_max_speed_unit,
              baseline_max_blank_width_mm, baseline_max_blank_width_unit,
              baseline_min_length_mm,
              baseline_max_blanks_across
       FROM machines
       WHERE id IN (${[...scopeMachineIds].map(() => '?').join(',')})`
    )
    .all(...scopeMachineIds) as any[];
  const scopeMachineById = new Map(
    scopeMachines.map((machine) => [Number(machine.machine_id), machine])
  );
  const volumeMap = (() => {
    if (opts.scenarioSnapshot != null) {
      const rows = (opts.scenarioSnapshot.operation_volume_by_year || []).filter((v: any) => Number(v.year) === year) as {
        operation_id: number;
        year: number;
        volume_value: number;
        volume_unit: string;
        source?: string | null;
      }[];
      return new Map(
        rows.map((v) => [
          Number(v.operation_id),
          {
            volume_value: v.volume_value,
            volume_unit: v.volume_unit,
            source: v.source ?? null,
          },
        ])
      );
    }
    try {
      const volumeByYear = db
        .prepare(
          `SELECT operation_id, year, volume_value, volume_unit, COALESCE(source, 'manual') AS source
           FROM operation_volume_by_year WHERE year = ?`
        )
        .all(year) as {
        operation_id: number;
        year: number;
        volume_value: number;
        volume_unit: string;
        source: string;
      }[];
      return new Map(
        volumeByYear.map((v) => [
          v.operation_id,
          { volume_value: v.volume_value, volume_unit: v.volume_unit, source: v.source },
        ])
      );
    } catch {
      const volumeByYear = db
        .prepare('SELECT operation_id, year, volume_value, volume_unit FROM operation_volume_by_year WHERE year = ?')
        .all(year) as { operation_id: number; year: number; volume_value: number; volume_unit: string }[];
      return new Map(volumeByYear.map((v) => [v.operation_id, v]));
    }
  })();
  const callOffOpShare = opts.callOffVolumes
    ? buildCallOffOperationShares(
        operations,
        year,
        opts.activeMonth,
        opts.activeWeek,
        volumeMap,
        opts.scenarioSnapshot ?? null,
        useContract,
        undefined,
        settings,
        opts.callOffVolumes
      )
    : null;

  const accum: BreakdownAccum = { totalRequiredSec: 0, clients: new Map() };

  for (const op of operations) {
    const machineId = Number(op.machine_id);
    if (!scopeMachineIds.has(machineId)) continue;
    const machine = scopeMachineById.get(machineId);
    const baseline = Number(machine?.is_baseline) === 1;
    const machineVolumeSettings = volumeSettingsForMachine(settings, machine);
    if (
      baseline !==
      (op.baseline_inferred_source === BASELINE_INFERRED_OPERATION)
    ) {
      continue;
    }

    const opKey = Number(op.operation_id ?? op.id);
    if (!Number.isFinite(opKey)) continue;
    let opVolumeOverride = volumeMap.get(opKey);
    if (opts.callOffVolumes) {
      const share = callOffOpShare?.get(opKey);
      const partId = op.part_id != null ? Number(op.part_id) : null;
      if (share == null || share <= 0 || partId == null || !Number.isFinite(partId)) continue;
      opVolumeOverride = {
        volume_value:
          callOffQuantityForPeriod(opts.callOffVolumes, partId, year, opts.activeMonth, opts.activeWeek) * share,
        volume_unit: callOffVolumeUnitForPeriod(opts.activeMonth, opts.activeWeek),
        source: 'call_off',
      };
    }
    const callOffSapActive = isCallOffSapVolumeOverride(opts.callOffVolumes, opVolumeOverride);
    const resolved = resolveOperationVolumeForYear(
      {
        operation_id: opKey,
        project_id: op.project_id,
        part_id: op.part_id,
        volume_value: op.volume_value,
        volume_unit: op.volume_unit,
        split_from_operation_id: op.split_from_operation_id,
      },
      year,
      opVolumeOverride,
      opts.scenarioSnapshot ?? null,
      useContract,
      undefined,
      opts.activeMonth,
      opts.activeWeek,
      opts.callOffVolumes ? null : volumeMap
    );
    if (
      !callOffSapActive &&
      !shouldIncludeOperationInCapacity(
        op.sop ?? '',
        op.eop ?? '',
        year,
        opts.activeMonth,
        Boolean(resolved.count_after_eop),
        op.project_id != null
      )
    ) {
      continue;
    }
    const volValue = resolved.volume_value;
    const volUnit = resolved.volume_unit;
    const weeklyResolved = resolveWeeklyVolumeFromResolved(volValue, volUnit, machineVolumeSettings, {
      sop: op.sop ?? '',
      eop: op.eop ?? '',
      year,
      volume_origin: resolved.volume_origin,
      count_after_eop: callOffSapActive ? true : resolved.count_after_eop,
      has_project: op.project_id != null,
    });
    const weeklyVol = weeklyResolved.weekly;
    if (weeklyVol <= 1e-9) continue;

    const { cycleSeconds, nests } = resolveOperationCycleForCalculator(op);
    const requiredSecOp = baseline
      ? baselineRequiredSeconds(
          machine,
          op.detail_designation_id,
          weeklyVol,
          baselineMaterials
        )
      : weeklyVol * (cycleSeconds / nests);
    if (requiredSecOp <= 1e-9) continue;

    const lookup = projectLookup.get(Number(op.project_id));
    const client = String(op.project_client ?? lookup?.client ?? '—').trim() || '—';
    const projectName = String(op.project_name ?? lookup?.name ?? '—').trim() || '—';
    const projectId = Number(op.project_id);
    const detailLabel = formatDetailSapAliasLabel(
      {
        sap_number: op.detail_sap_number,
        alias: op.detail_alias,
        free_text: op.detail_free_text,
        designation: op.detail_designation,
        id: op.part_id,
      },
      refMode
    );
    const hasRfq = String(op.project_status ?? '').toUpperCase() === 'RFQ';

    accum.totalRequiredSec += requiredSecOp;

    if (!accum.clients.has(client)) {
      accum.clients.set(client, { requiredSec: 0, projects: new Map() });
    }
    const clientNode = accum.clients.get(client)!;
    clientNode.requiredSec += requiredSecOp;

    if (!clientNode.projects.has(projectId)) {
      clientNode.projects.set(projectId, { project_name: projectName, requiredSec: 0, details: new Map() });
    }
    const projectNode = clientNode.projects.get(projectId)!;
    projectNode.requiredSec += requiredSecOp;

    const detailNode = projectNode.details.get(detailLabel) ?? { requiredSec: 0, hasRfq: false };
    detailNode.requiredSec += requiredSecOp;
    if (hasRfq) detailNode.hasRfq = true;
    projectNode.details.set(detailLabel, detailNode);
  }

  // Materiały z wolumenem zewnętrznym (linia bazowa)
  for (const machine of [...scopeMachineById.values()].filter((mc) => Number(mc.is_baseline))) {
    if (!scopeMachineIds.has(Number(machine.machine_id))) continue;
    const extSec = baselineExternalVolumeRequiredSeconds(
      machine,
      year,
      baselineScopeExtVolumes,
      baselineScopeExtMaterials
    );
    if (extSec > 0) accum.totalRequiredSec += extSec;
  }

  return accum;
}

function finalizeBreakdownTree(
  accum: BreakdownAccum,
  scopeAvailabilitySec: number,
  scopeRequiredSec: number
): CapacityBreakdownSeries {
  const total = accum.totalRequiredSec;
  const scopeLoadPercent =
    scopeAvailabilitySec > 0
      ? Math.round((scopeRequiredSec / scopeAvailabilitySec) * 100)
      : scopeRequiredSec > 0
        ? 100
        : null;
  const toLoad = (sec: number) => {
    if (scopeAvailabilitySec <= 0) return sec > 0 ? 100 : 0;
    return Math.round((sec / scopeAvailabilitySec) * 10000) / 100;
  };
  const toShare = (sec: number) => (total > 0 ? Math.round((sec / total) * 10000) / 100 : 0);

  const clients = [...accum.clients.entries()]
    .map(([client, c]) => ({
      client,
      load_percent: toLoad(c.requiredSec),
      share_percent: toShare(c.requiredSec),
      projects: [...c.projects.entries()]
        .map(([project_id, p]) => ({
          project_id,
          project_name: p.project_name,
          load_percent: toLoad(p.requiredSec),
          share_percent: toShare(p.requiredSec),
          details: [...p.details.entries()]
            .map(([detail_label, d]) => ({
              detail_label,
              load_percent: toLoad(d.requiredSec),
              share_percent: toShare(d.requiredSec),
              has_rfq: d.hasRfq,
            }))
            .sort((a, b) => b.load_percent - a.load_percent),
        }))
        .sort((a, b) => b.load_percent - a.load_percent),
    }))
    .sort((a, b) => b.load_percent - a.load_percent);

  return { load_percent: scopeLoadPercent, clients };
}

function buildScopeBreakdownSeries(
  year: number,
  scope: BreakdownScope,
  scopeMachineIds: number[],
  opts: BreakdownOpts
): CapacityBreakdownSeries {
  if (!scopeMachineIds.length) return { load_percent: null, clients: [] };
  const activeMonth = opts.activeMonth;
  const activeWeek = opts.activeWeek;
  const detailVolumePeriod =
    activeWeek != null && activeMonth != null ? 'weekly' : activeMonth != null ? 'monthly' : undefined;
  const capacityRows = getMachineCapacitiesForYear(
    year,
    scopeMachineIds,
    opts.machineType,
    opts.operationsOverride,
    opts.scenarioSnapshot ?? null,
    opts.scenarioIncludeRfqProjects,
    opts.useContractualVolumes,
    opts.machineStatusFilter,
    opts.dimensionFilters,
    opts.settingsProfile,
    activeMonth,
    undefined,
    opts.callOffVolumes,
    detailVolumePeriod,
    opts.includeRfqOperationIds?.length
      ? { includeRfqOperationIds: opts.includeRfqOperationIds }
      : undefined,
    activeWeek
  );
  const scopeTotals = scopeTotalsFromRows(capacityRows);
  const accum = accumulateScopeBreakdown(year, new Set(scopeMachineIds), opts);
  return finalizeBreakdownTree(accum, scopeTotals.availabilitySec, scopeTotals.requiredSec);
}

export function getCapacityScopeBreakdown(
  year: number,
  scope: BreakdownScope,
  opts: BreakdownOpts,
  seriesKeys: CapacityBreakdownSeriesKey[]
): Partial<Record<CapacityBreakdownSeriesKey, CapacityBreakdownSeries>> {
  const scopeMachineIds = resolveScopeMachineIds(scope, opts);
  const out: Partial<Record<CapacityBreakdownSeriesKey, CapacityBreakdownSeries>> = {};

  const base: BreakdownOpts = {
    machineIds: opts.machineIds,
    machineType: opts.machineType,
    machineStatusFilter: opts.machineStatusFilter,
    dimensionFilters: opts.dimensionFilters,
    settingsProfile: opts.settingsProfile,
    scenarioIncludeRfqProjects: opts.scenarioIncludeRfqProjects,
    includeRfqOperationIds: opts.includeRfqOperationIds,
    activeMonth: opts.activeMonth,
    activeWeek: opts.activeWeek,
  };

  for (const key of seriesKeys) {
    let variant: BreakdownOpts;
    if (key === 'production') {
      variant = { ...base, useContractualVolumes: false, scenarioSnapshot: null, operationsOverride: undefined };
    } else if (key === 'contract') {
      variant = { ...base, useContractualVolumes: true, scenarioSnapshot: null, operationsOverride: undefined };
    } else if (key === 'scenario_production') {
      variant = {
        ...base,
        useContractualVolumes: false,
        scenarioSnapshot: opts.scenarioSnapshot ?? null,
        operationsOverride: opts.operationsOverride,
      };
    } else if (key === 'call_off') {
      if (!opts.callOffVolumes) {
        out[key] = { load_percent: null, clients: [] };
        continue;
      }
      variant = {
        ...base,
        useContractualVolumes: false,
        scenarioSnapshot: null,
        operationsOverride: undefined,
        callOffVolumes: opts.callOffVolumes,
      };
    } else {
      variant = {
        ...base,
        useContractualVolumes: true,
        scenarioSnapshot: opts.scenarioSnapshot ?? null,
        operationsOverride: opts.operationsOverride,
      };
    }
    out[key] = buildScopeBreakdownSeries(year, scope, scopeMachineIds, variant);
  }

  return out;
}
