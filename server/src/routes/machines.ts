import { Router } from 'express';
import multer from 'multer';
import { db, saveDb } from '../db/connection.js';
import { parseCsvQueryParamSingleOrMulti, parseMachineStatusList, sqlInClause } from '../utils/queryListParams.js';
import {
  resolveOperationVolumeForYear,
  resolveSettingsForYear,
  resolveWeeklyVolumeFromResolved,
  volumeToWeekly,
} from '../services/capacityService.js';
import {
  getEffectiveVolumeForPartScenarioPreferContract,
  parseScenarioSnapshotJson,
  resolveSettingsForScenarioYear,
  scenarioHydratedOperationsForActiveProjects,
  type ScenarioBundle,
} from '../services/scenarioSnapshotService.js';
import { formatDetailSapAliasLabel } from '../utils/detailLabel.js';
import { loadReferenceDisplayMode } from '../utils/referenceDisplayMode.js';
import { normalizeMachineLineLocationOrOne, normalizeMachineLineLocationOptional, normalizeMachineLineLocationStrict } from '../utils/machineLineLocation.js';
import { parseInternalMachineNumber, parseOptionalInternalMachineNumber } from '../utils/internalMachineNumber.js';
import { ensureMachineTypesExist } from '../utils/machineTypes.js';
import { blankMassKg, resolveBaselineMaterialAlias, materialAliasFromDescription } from '../utils/baselineMaterialMass.js';
import {
  baselineMaterialHourlyCapacity,
  orientBaselineDimensions,
} from '../services/baselineCapacityService.js';
import {
  componentsWithCodeViaSubassemblies,
  parseEuNumber,
  parseSapRoutingBuffer,
} from '../services/sapRoutingParser.js';

export const machinesRouter = Router();
const routingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/** Tygodniowy wolumen operacji w roku — z ułamkiem SOP/EOP lub logiką ręcznego roku niepełnego. */
function effectiveWeeklyVolumeForOperationYear(
  row: { project_id?: number | null; part_id?: number | null; sop?: string; eop?: string },
  year: number,
  resolved: {
    volume_value: number;
    volume_unit: 'annual' | 'monthly' | 'weekly';
    volume_origin: import('../services/capacityService.js').VolumeEntryOrigin;
    count_after_eop?: boolean;
  },
  settings: Parameters<typeof volumeToWeekly>[2],
  _useContractualVolumes: boolean,
  _scenarioBundle?: ScenarioBundle | null
): number {
  return resolveWeeklyVolumeFromResolved(resolved.volume_value, resolved.volume_unit, settings, {
    sop: row.sop ?? '',
    eop: row.eop ?? '',
    year,
    volume_origin: resolved.volume_origin,
    count_after_eop: resolved.count_after_eop,
    has_project: row.project_id != null,
  }).weekly;
}

/** Słownik typów + wartości występujące na maszynach (np. po imporcie). */
function mergedMachineTypeNames(): string[] {
  const catalogRows = db.prepare('SELECT name FROM machine_types ORDER BY name COLLATE NOCASE').all() as { name: string }[];
  const usedRows = db
    .prepare(`SELECT DISTINCT TRIM(type) AS t FROM machines WHERE type IS NOT NULL AND TRIM(type) != ''`)
    .all() as { t: string }[];
  const set = new Set<string>();
  for (const r of catalogRows) set.add(r.name);
  for (const r of usedRows) set.add(r.t);
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'pl', { sensitivity: 'base' }));
}

function machineTypeCatalogHasEntries(): boolean {
  const row = db.prepare('SELECT 1 AS x FROM machine_types LIMIT 1').get() as { x: number } | undefined;
  return !!row;
}

function machineTypeIsInCatalog(type: string): boolean {
  const t = String(type ?? '').trim();
  if (!t) return false;
  const row = db.prepare('SELECT 1 FROM machine_types WHERE TRIM(name) = ? COLLATE NOCASE LIMIT 1').get(t);
  return !!row;
}

function machineTypeValidationError(type: string): string | null {
  if (!machineTypeCatalogHasEntries()) return null;
  if (machineTypeIsInCatalog(type)) return null;
  return 'Typ maszyny musi być jednym z typów zdefiniowanych w Administracja → Ustawienia bazy → Typy maszyn.';
}

/** Clamp value to 0..1 and round to one decimal (0.1 step). */
function clampMachineUsage(v: unknown): number {
  const n = Number(v);
  if (Number.isNaN(n)) return 1;
  const clamped = Math.max(0, Math.min(1, n));
  return Math.round(clamped * 10) / 10;
}

function normalizeMachineStatus(raw: unknown, fallback: 'active' | 'inactive' | 'RFQ' = 'active'): 'active' | 'inactive' | 'RFQ' {
  const s = String(raw ?? fallback).trim().toLowerCase();
  if (s === 'inactive') return 'inactive';
  if (s === 'rfq') return 'RFQ';
  return 'active';
}

function parseOptionalDimension(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseBaselineFlag(v: unknown, fallback = 0): number {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true') return 1;
  return 0;
}

type BaselineFields = {
  is_baseline: number;
  baseline_available_hours_per_week: number;
  baseline_weeks_per_year: number;
  baseline_max_throughput_kg_h: number | null;
  baseline_max_throughput_unit: string;
  baseline_min_throughput_kg_h: number | null;
  baseline_min_throughput_unit: string;
  baseline_max_speed_m_min: number | null;
  baseline_max_speed_unit: string;
  baseline_min_speed_m_min: number | null;
  baseline_min_speed_unit: string;
  baseline_max_blank_width_mm: number | null;
  baseline_max_blank_width_unit: string;
  baseline_min_blank_width_mm: number | null;
  baseline_min_blank_width_unit: string;
  baseline_min_length_mm: number | null;
  baseline_max_blanks_across: number | null;
  baseline_max_blanks_across_unit: string;
};

function parseBaselineFieldsFromBody(body: any, existing?: Partial<BaselineFields> | null): BaselineFields {
  const is_baseline =
    body.is_baseline !== undefined ? parseBaselineFlag(body.is_baseline) : Number(existing?.is_baseline ?? 0) ? 1 : 0;
  const pickDim = (key: keyof BaselineFields, bodyKey: string): number | null => {
    if (body[bodyKey] !== undefined) return parseOptionalDimension(body[bodyKey]) ?? null;
    const prev = existing?.[key];
    return prev != null && Number.isFinite(Number(prev)) ? Number(prev) : null;
  };
  const pickUnit = (key: keyof BaselineFields, fallback: string): string => {
    const raw = body[key] !== undefined ? body[key] : existing?.[key];
    const value = String(raw ?? '').trim();
    return value || fallback;
  };
  const availableHoursRaw =
    body.baseline_available_hours_per_week !== undefined
      ? Number(body.baseline_available_hours_per_week)
      : Number(existing?.baseline_available_hours_per_week ?? 120);
  const availableHours = Number.isFinite(availableHoursRaw)
    ? Math.max(0, Math.min(168, availableHoursRaw))
    : 120;
  const weeksPerYearRaw =
    body.baseline_weeks_per_year !== undefined
      ? Number(body.baseline_weeks_per_year)
      : Number(existing?.baseline_weeks_per_year ?? 52);
  const weeksPerYear = Number.isFinite(weeksPerYearRaw)
    ? Math.max(1, Math.min(53, Math.round(weeksPerYearRaw)))
    : 52;
  if (!is_baseline) {
    return {
      is_baseline: 0,
      baseline_available_hours_per_week: 120,
      baseline_weeks_per_year: 52,
      baseline_max_throughput_kg_h: null,
      baseline_max_throughput_unit: 'kg/h',
      baseline_min_throughput_kg_h: null,
      baseline_min_throughput_unit: 'kg/h',
      baseline_max_speed_m_min: null,
      baseline_max_speed_unit: 'm/min',
      baseline_min_speed_m_min: null,
      baseline_min_speed_unit: 'm/min',
      baseline_max_blank_width_mm: null,
      baseline_max_blank_width_unit: 'mm',
      baseline_min_blank_width_mm: null,
      baseline_min_blank_width_unit: 'mm',
      baseline_min_length_mm: 650,
      baseline_max_blanks_across: null,
      baseline_max_blanks_across_unit: 'szt',
    };
  }
  return {
    is_baseline: 1,
    baseline_available_hours_per_week: availableHours,
    baseline_weeks_per_year: weeksPerYear,
    baseline_max_throughput_kg_h: pickDim('baseline_max_throughput_kg_h', 'baseline_max_throughput_kg_h'),
    baseline_max_throughput_unit: pickUnit('baseline_max_throughput_unit', 'kg/h'),
    baseline_min_throughput_kg_h: pickDim('baseline_min_throughput_kg_h', 'baseline_min_throughput_kg_h'),
    baseline_min_throughput_unit: pickUnit('baseline_min_throughput_unit', 'kg/h'),
    baseline_max_speed_m_min: pickDim('baseline_max_speed_m_min', 'baseline_max_speed_m_min'),
    baseline_max_speed_unit: pickUnit('baseline_max_speed_unit', 'm/min'),
    baseline_min_speed_m_min: pickDim('baseline_min_speed_m_min', 'baseline_min_speed_m_min'),
    baseline_min_speed_unit: pickUnit('baseline_min_speed_unit', 'm/min'),
    baseline_max_blank_width_mm: pickDim('baseline_max_blank_width_mm', 'baseline_max_blank_width_mm'),
    baseline_max_blank_width_unit: pickUnit('baseline_max_blank_width_unit', 'mm'),
    baseline_min_blank_width_mm: pickDim('baseline_min_blank_width_mm', 'baseline_min_blank_width_mm'),
    baseline_min_blank_width_unit: pickUnit('baseline_min_blank_width_unit', 'mm'),
    baseline_min_length_mm: Math.max(
      0,
      pickDim('baseline_min_length_mm', 'baseline_min_length_mm') ?? 650
    ),
    baseline_max_blanks_across: pickDim('baseline_max_blanks_across', 'baseline_max_blanks_across'),
    baseline_max_blanks_across_unit: pickUnit('baseline_max_blanks_across_unit', 'szt'),
  };
}

const MACHINE_DIMENSION_COLS = 'width_mm, depth_mm, height_mm, stroke_mm';
const MACHINE_BASELINE_COLS =
  'is_baseline, baseline_available_hours_per_week, baseline_weeks_per_year, baseline_max_throughput_kg_h, baseline_max_throughput_unit, baseline_min_throughput_kg_h, baseline_min_throughput_unit, baseline_max_speed_m_min, baseline_max_speed_unit, baseline_min_speed_m_min, baseline_min_speed_unit, baseline_max_blank_width_mm, baseline_max_blank_width_unit, baseline_min_blank_width_mm, baseline_min_blank_width_unit, baseline_min_length_mm, baseline_max_blanks_across, baseline_max_blanks_across_unit';
const MACHINE_SELECT_COLS = `id, internal_number, sap_number, type, oee_override, status, location, COALESCE(machine_usage, 1) AS machine_usage, ${MACHINE_DIMENSION_COLS}, ${MACHINE_BASELINE_COLS}`;

machinesRouter.get('/', (req, res) => {
  const statuses = parseMachineStatusList(req.query.status, req.query.statuses);
  const types = parseCsvQueryParamSingleOrMulti(req.query.type, req.query.types);
  const search = (req.query.search as string)?.trim();

  let sql = `SELECT ${MACHINE_SELECT_COLS} FROM machines WHERE 1=1`;
  const params: (string | number)[] = [];

  if (statuses.length === 1) {
    sql += ' AND status = ?';
    params.push(statuses[0]);
  } else if (statuses.length > 1) {
    const statusIn = sqlInClause(statuses, 'status');
    sql += ` AND ${statusIn.clause}`;
    params.push(...statusIn.params);
  }
  if (types.length === 1) {
    sql += ' AND type = ?';
    params.push(types[0]);
  } else if (types.length > 1) {
    const typeIn = sqlInClause(types, 'type');
    sql += ` AND ${typeIn.clause}`;
    params.push(...typeIn.params);
  }
  if (search) {
    sql += ' AND (CAST(internal_number AS TEXT) LIKE ? OR sap_number LIKE ? OR type LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  sql += ' ORDER BY internal_number';

  const list = db.prepare(sql).all(...params);
  res.json(list);
});

machinesRouter.get('/types', (_req, res) => {
  res.json(mergedMachineTypeNames());
});

/** Operacje na maszynie powiązane z projektami w statusie „active” — liczba + lista projektów (UI ostrzeżenia). */
machinesRouter.get('/:id/active-project-operation-count', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
  const exists = db.prepare('SELECT 1 FROM machines WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM operations o
       INNER JOIN projects p ON p.id = o.project_id
       WHERE o.machine_id = ? AND p.status = 'active'`
    )
    .get(id) as { c: number };
  const projects = db
    .prepare(
      `SELECT DISTINCT p.id, p.client, p.name
       FROM operations o
       INNER JOIN projects p ON p.id = o.project_id
       WHERE o.machine_id = ? AND p.status = 'active'
       ORDER BY p.client COLLATE NOCASE, p.name COLLATE NOCASE`
    )
    .all(id) as { id: number; client: string; name: string }[];
  res.json({ count: Number(row?.c ?? 0), projects });
});

machinesRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const machine = db.prepare(`
    SELECT ${MACHINE_SELECT_COLS}
    FROM machines WHERE id = ?
  `).get(id) as any;
  if (!machine) return res.status(404).json({ error: 'Not found' });

  const alternatives = db.prepare(`
    SELECT m.id, m.internal_number, m.sap_number, m.type
    FROM machine_alternatives a
    JOIN machines m ON m.id = a.alternative_machine_id
    WHERE a.machine_id = ?
  `).all(id) as any[];

  const projects = db.prepare(`
    SELECT DISTINCT p.id, p.client, p.name, p.status
    FROM projects p
    JOIN operations o ON o.project_id = p.id
    WHERE o.machine_id = ?
  `).all(id) as any[];

  res.json({
    ...machine,
    machine_usage: machine.machine_usage != null ? Number(machine.machine_usage) : 1,
    alternatives,
    projects,
  });
});

machinesRouter.get('/:id/operations', (req, res) => {
  const refMode = loadReferenceDisplayMode();
  const id = Number(req.params.id);
  const yearQ = req.query.year != null ? Number(req.query.year) : NaN;
  const year = Number.isFinite(yearQ) ? yearQ : null;
  const useContractualVolumes =
    req.query.useContractualVolumes === '1' || String(req.query.useContractualVolumes ?? '').toLowerCase() === 'true';
  const scenarioIdQ = req.query.scenarioId != null ? Number(req.query.scenarioId) : NaN;
  if (Number.isFinite(scenarioIdQ) && scenarioIdQ > 0) {
    const snapRow = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(scenarioIdQ) as
      | { snapshot: string; archived_at: string | null }
      | undefined;
    if (!snapRow) return res.status(404).json({ error: 'Scenariusz nie znaleziony' });
    const bundle = parseScenarioSnapshotJson(snapRow.snapshot);
    const archived = snapRow.archived_at != null && String(snapRow.archived_at).trim() !== '';
    const hydrated = scenarioHydratedOperationsForActiveProjects(bundle, { includeRfq: !archived });
    const list = hydrated
      .filter((o: any) => Number(o.machine_id) === id)
      .map((o: any) => {
        const ph = db.prepare('SELECT name FROM process_phases WHERE id = ?').get(o.phase_id) as { name: string } | undefined;
        const p = (bundle.projects || []).find((pr: any) => Number(pr.id) === Number(o.project_id));
        return {
          id: o.id,
          project_id: o.project_id,
          part_id: o.part_id,
          phase_id: o.phase_id,
          cycle_time_seconds: o.cycle_time_seconds,
          nests_count: o.nests_count,
          oee_override: o.oee_override,
          alt_cycle_time_seconds: o.alt_cycle_time_seconds ?? null,
          alt_nests_count: o.alt_nests_count ?? null,
          alt_oee_override: o.alt_oee_override ?? null,
          use_alternative_in_calculator: o.use_alternative_in_calculator ?? 0,
          volume_value: o.volume_value,
          volume_unit: o.volume_unit,
          phase_name: ph?.name ?? '',
          detail_sap_number: o.detail_sap_number ?? null,
          detail_alias: o.detail_alias ?? null,
          detail_free_text: o.detail_free_text ?? null,
          detail_designation: o.detail_designation ?? null,
          project_name: p?.name ?? '',
          client: p?.client ?? '',
          sop: p?.sop ?? '',
          eop: p?.eop ?? '',
        };
      })
      .sort((a: any, b: any) => Number(a.id) - Number(b.id)) as any[];
    for (const row of list) {
      row.part_designation = formatDetailSapAliasLabel(
        {
          sap_number: row.detail_sap_number,
          alias: row.detail_alias,
          free_text: row.detail_free_text,
          designation: row.detail_designation,
          id: row.part_id,
        },
        refMode
      );
    }
    if (year != null) {
      const settings = resolveSettingsForScenarioYear(year, bundle) ?? resolveSettingsForYear(year);
      const ov = bundle.operation_volume_by_year || [];
      const volumeMap = new Map(
        ov
          .filter((v: any) => Number(v.year) === year)
          .map((v: any) => [
            Number(v.operation_id),
            {
              volume_value: Number(v.volume_value),
              volume_unit: String(v.volume_unit),
              source: v.source ?? null,
            },
          ])
      );
      for (const row of list) {
        const opYear = volumeMap.get(Number(row.id)) ?? null;
        const resolved = resolveOperationVolumeForYear(
          {
            operation_id: row.id,
            project_id: row.project_id,
            part_id: row.part_id,
            volume_value: row.volume_value,
            volume_unit: row.volume_unit,
            split_from_operation_id: row.split_from_operation_id,
          },
          year,
          opYear,
          bundle,
          useContractualVolumes,
          undefined,
          undefined,
          undefined,
          volumeMap
        );
        row.effective_volume_value = resolved.volume_value;
        row.effective_volume_unit = resolved.volume_unit;
        row.effective_volume_source = resolved.source;
        row.effective_volume_weekly = effectiveWeeklyVolumeForOperationYear(
          row,
          year,
          resolved,
          settings,
          useContractualVolumes,
          bundle
        );
      }
    }
    return res.json(list);
  }

  const list = db.prepare(`
    SELECT o.id, o.project_id, o.part_id, o.phase_id, o.cycle_time_seconds, o.nests_count, o.oee_override,
           o.split_from_operation_id,
           o.alt_cycle_time_seconds, o.alt_nests_count, o.alt_oee_override, o.use_alternative_in_calculator,
           o.volume_value, o.volume_unit,
           ph.name AS phase_name,
           pd.sap_number AS detail_sap_number, pd.alias AS detail_alias, pd.free_text AS detail_free_text,
           pt.designation AS detail_designation,
           p.name AS project_name, p.client, p.sop, p.eop
    FROM operations o
    JOIN process_phases ph ON ph.id = o.phase_id
    JOIN parts pt ON pt.id = o.part_id
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    JOIN projects p ON p.id = o.project_id
    WHERE o.machine_id = ?
    ORDER BY o.id
  `).all(id) as any[];
  for (const row of list) {
    row.part_designation = formatDetailSapAliasLabel(
      {
        sap_number: row.detail_sap_number,
        alias: row.detail_alias,
        free_text: row.detail_free_text,
        designation: row.detail_designation,
        id: row.part_id,
      },
      refMode
    );
  }
  if (year != null) {
    const settings = resolveSettingsForYear(year);
    let volumeMap = new Map<number, { volume_value: number; volume_unit: string; source?: string | null }>();
    try {
      const rows = db
        .prepare(
          `SELECT operation_id, volume_value, volume_unit, COALESCE(source, 'manual') AS source
           FROM operation_volume_by_year WHERE year = ?`
        )
        .all(year) as { operation_id: number; volume_value: number; volume_unit: string; source: string }[];
      volumeMap = new Map(
        rows.map((v) => [
          v.operation_id,
          { volume_value: v.volume_value, volume_unit: v.volume_unit, source: v.source },
        ])
      );
    } catch {
      const rows = db
        .prepare('SELECT operation_id, volume_value, volume_unit FROM operation_volume_by_year WHERE year = ?')
        .all(year) as { operation_id: number; volume_value: number; volume_unit: string }[];
      volumeMap = new Map(rows.map((v) => [v.operation_id, v]));
    }
    for (const row of list) {
      const opYear = volumeMap.get(row.id) ?? null;
      const resolved = resolveOperationVolumeForYear(
        {
          operation_id: row.id,
          project_id: row.project_id,
          part_id: row.part_id,
          volume_value: row.volume_value,
          volume_unit: row.volume_unit,
          split_from_operation_id: row.split_from_operation_id,
        },
        year,
        opYear,
        null,
        useContractualVolumes,
        undefined,
        undefined,
        undefined,
        volumeMap
      );
      row.effective_volume_value = resolved.volume_value;
      row.effective_volume_unit = resolved.volume_unit;
      row.effective_volume_source = resolved.source;
      row.effective_volume_weekly = effectiveWeeklyVolumeForOperationYear(row, year, resolved, settings, useContractualVolumes);
    }
  }
  res.json(list);
});

function requireBaselineMachine(id: number): { ok: true; machine: any } | { ok: false; status: number; error: string } {
  const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as any;
  if (!machine) return { ok: false, status: 404, error: 'Not found' };
  if (!Number(machine.is_baseline)) return { ok: false, status: 400, error: 'Materiały są dostępne tylko dla maszyny bazowej.' };
  return { ok: true, machine };
}

function parseDesignationIds(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const ids = arr
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(ids)];
}

function parseDesignationConsumptions(
  raw: unknown,
  designationIds: number[]
): Map<number, number> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = new Map<number, number>();
  for (const id of designationIds) {
    const parsed = Number(source[String(id)]);
    result.set(id, Number.isFinite(parsed) && parsed >= 0 ? parsed : 1);
  }
  return result;
}

function replaceMaterialDesignations(
  materialId: number,
  designationIds: number[],
  consumptions: Map<number, number>
) {
  db.prepare('DELETE FROM machine_baseline_material_parts WHERE material_id = ?').run(materialId);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO machine_baseline_material_parts
      (material_id, designation_id, consumption_per_detail) VALUES (?, ?, ?)`
  );
  for (const designationId of designationIds) {
    const exists = db.prepare('SELECT 1 FROM part_designations WHERE id = ?').get(designationId);
    if (exists) ins.run(materialId, designationId, consumptions.get(designationId) ?? 1);
  }
}

function materialDesignations(materialId: number) {
  const refMode = loadReferenceDisplayMode();
  const rows = db
    .prepare(
      `SELECT d.id, d.sap_number, d.alias, d.free_text, d.designation,
              mp.consumption_per_detail
       FROM machine_baseline_material_parts mp
       JOIN part_designations d ON d.id = mp.designation_id
       WHERE mp.material_id = ?
       ORDER BY d.alias COLLATE NOCASE, d.sap_number COLLATE NOCASE`
    )
    .all(materialId) as {
    id: number;
    sap_number: string | null;
    alias: string | null;
    free_text: string | null;
    designation: string | null;
    consumption_per_detail: number;
  }[];
  return rows.map((d) => ({
    id: d.id,
    sap_number: d.sap_number,
    alias: d.alias,
    free_text: d.free_text,
    consumption_per_detail: Number(d.consumption_per_detail ?? 1),
    label: formatDetailSapAliasLabel(d, refMode),
  }));
}

function enrichBaselineMaterial(row: any, machine: any) {
  const grammage = row.grammage_kg_m2 != null ? Number(row.grammage_kg_m2) : NaN;
  const width = row.width_mm != null ? Number(row.width_mm) : NaN;
  const length = row.length_mm != null ? Number(row.length_mm) : NaN;
  const oriented =
    Number.isFinite(width) && Number.isFinite(length)
      ? orientBaselineDimensions(machine, width, length)
      : null;
  const details = materialDesignations(row.id);
  const hourlyCapacity = baselineMaterialHourlyCapacity(
    { ...machine, machine_id: Number(machine.id) },
    row
  );
  const displayAlias = resolveBaselineMaterialAlias(row.alias, row.description);
  return {
    ...row,
    width_mm: oriented?.widthMm ?? row.width_mm,
    length_mm: oriented?.lengthMm ?? row.length_mm,
    alias: displayAlias,
    details,
    designation_ids: details.map((d) => d.id),
    blank_mass_kg: blankMassKg(grammage, width, length),
    blanks_across: hourlyCapacity?.blanksAcross ?? null,
    web_width_mm: hourlyCapacity?.webWidthMm ?? null,
    web_mass_kg: hourlyCapacity?.webMassKg ?? null,
    mass_capacity_per_hour: hourlyCapacity?.massCapacityPerHour ?? null,
    speed_capacity_per_hour: hourlyCapacity?.speedCapacityPerHour ?? null,
    actual_capacity_per_hour: hourlyCapacity?.actualCapacityPerHour ?? null,
  };
}

function parseMaterialBody(body: any) {
  const alias = body.alias != null ? String(body.alias).trim() : '';
  const description = body.description != null ? String(body.description).trim() : '';
  const sap_number = body.sap_number != null ? String(body.sap_number).trim() : '';
  const productionShareRaw = Number(
    String(body.production_share_percent ?? 100).trim().replace(',', '.')
  );
  const production_share_percent = Number.isFinite(productionShareRaw)
    ? Math.min(100, Math.max(0, productionShareRaw))
    : 100;
  const grammage_kg_m2 = parseOptionalDimension(body.grammage_kg_m2) ?? null;
  const width_mm = parseOptionalDimension(body.width_mm) ?? null;
  const length_mm = parseOptionalDimension(body.length_mm) ?? null;
  const designation_ids = parseDesignationIds(body.designation_ids ?? body.detail_ids);
  const designation_consumptions = parseDesignationConsumptions(
    body.designation_consumptions,
    designation_ids
  );
  const include_in_capacity =
    body.include_in_capacity === false ||
    body.include_in_capacity === 0 ||
    body.include_in_capacity === '0' ||
    body.include_in_capacity === 'false'
      ? 0
      : 1;
  const use_external_volume =
    body.use_external_volume === true ||
    body.use_external_volume === 1 ||
    body.use_external_volume === '1' ||
    body.use_external_volume === 'true'
      ? 1
      : 0;
  return {
    alias,
    description,
    sap_number,
    grammage_kg_m2,
    width_mm,
    length_mm,
    designation_ids,
    designation_consumptions,
    include_in_capacity,
    production_share_percent,
    use_external_volume,
  };
}

function normalizeSapKey(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, '').replace(/\.0+$/, '');
}

/** Z routingu bierzemy tylko formatki S2102; C21Q1 to półprodukt, w którym S2102 może siedzieć poziom niżej. */
const BASELINE_MATERIAL_CODE = 'S2102';
const BASELINE_SUBASSEMBLY_CODES = ['C21Q1'];

function grammageKgM2FromRouting(code: string, description: string): number | null {
  const text = `${code} ${description}`;
  const kg = text.match(/(\d+(?:[.,]\d+)?)\s*kg(?:\s*\/?\s*m(?:2|²))?/i);
  if (kg) return parseEuNumber(kg[1]);
  const grams = text.match(/(\d+(?:[.,]\d+)?)\s*g(?:\s*\/?\s*m(?:2|²))?/i);
  const g = grams ? parseEuNumber(grams[1]) : null;
  return g != null ? g / 1000 : null;
}

machinesRouter.post('/:id/materials/import-routing', routingUpload.single('file'), (req, res) => {
  const id = Number(req.params.id);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Brak pliku routing.txt.' });

  try {
    const routing = parseSapRoutingBuffer(req.file.buffer);
    const designationRows = db
      .prepare(
        `SELECT id, sap_number
         FROM part_designations
         WHERE sap_number IS NOT NULL AND TRIM(CAST(sap_number AS TEXT)) != ''`
      )
      .all() as { id: number; sap_number: string | number | null }[];
    const existingMaterials = db
      .prepare(
        `SELECT id, sap_number
         FROM machine_baseline_materials
         WHERE machine_id = ?`
      )
      .all(id) as { id: number; sap_number: string | null }[];
    const materialIdBySap = new Map(
      existingMaterials
        .map((row) => [normalizeSapKey(row.sap_number), Number(row.id)] as const)
        .filter(([sap]) => Boolean(sap))
    );
    const insertMaterial = db.prepare(
      `INSERT INTO machine_baseline_materials
        (machine_id, alias, description, sap_number, grammage_kg_m2, width_mm, length_mm,
         include_in_capacity, production_share_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100)`
    );
    const updateMaterial = db.prepare(
      `UPDATE machine_baseline_materials
       SET alias = ?, description = ?, grammage_kg_m2 = ?, width_mm = ?, length_mm = ?,
           include_in_capacity = ?
       WHERE id = ? AND machine_id = ?`
    );
    const insertLink = db.prepare(
      `INSERT INTO machine_baseline_material_parts
        (material_id, designation_id, consumption_per_detail)
       VALUES (?, ?, ?)
       ON CONFLICT(material_id, designation_id) DO UPDATE SET
         consumption_per_detail = excluded.consumption_per_detail`
    );

    let matchedDetails = 0;
    let unmatchedDetails = 0;
    let detailsWithoutMaterial = 0;
    let created = 0;
    let updated = 0;
    let linksCreated = 0;
    const seenDetailMaterial = new Set<string>();

    for (const designation of designationRows) {
      const detailSap = normalizeSapKey(designation.sap_number);
      if (!detailSap || !routing.byFinishedGood.has(detailSap)) {
        unmatchedDetails++;
        continue;
      }
      matchedDetails++;
      const components = componentsWithCodeViaSubassemblies(
        routing,
        detailSap,
        BASELINE_MATERIAL_CODE,
        BASELINE_SUBASSEMBLY_CODES
      );
      if (!components.length) detailsWithoutMaterial++;
      for (const component of components) {
        const materialSap = normalizeSapKey(component.materialNumber);
        if (!materialSap) continue;
        const oriented = component.width != null && component.length != null
          ? orientBaselineDimensions(found.machine, component.width, component.length)
          : { widthMm: component.width, lengthMm: component.length };
        let materialId = materialIdBySap.get(materialSap);
        const grammage = grammageKgM2FromRouting(component.code, component.description);
        const includeInCapacity = routing.capacityMaterials.has(materialSap) ? 1 : 0;
        if (materialId == null) {
          const result = insertMaterial.run(
            id,
            materialAliasFromDescription(component.description),
            component.description || null,
            materialSap,
            grammage,
            oriented.widthMm,
            oriented.lengthMm,
            includeInCapacity
          );
          materialId = Number(result.lastInsertRowid);
          materialIdBySap.set(materialSap, materialId);
          created++;
        } else {
          updateMaterial.run(
            materialAliasFromDescription(component.description),
            component.description || null,
            grammage,
            oriented.widthMm,
            oriented.lengthMm,
            includeInCapacity,
            materialId,
            id
          );
          updated++;
        }
        const linkKey = `${materialId}|${designation.id}`;
        if (seenDetailMaterial.has(linkKey)) continue;
        seenDetailMaterial.add(linkKey);
        const consumption =
          component.bomQuantityPerDetail != null && component.bomQuantityPerDetail >= 0
            ? component.bomQuantityPerDetail
            : 1;
        const linkResult = insertLink.run(materialId, designation.id, consumption);
        linksCreated += Number(linkResult.changes ?? 0);
      }
    }

    saveDb();
    res.json({
      routing_finished_goods: routing.finishedGoods,
      matched_details: matchedDetails,
      unmatched_details: unmatchedDetails,
      details_without_material: detailsWithoutMaterial,
      materials_created: created,
      materials_updated: updated,
      links_created: linksCreated,
    });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Nie udało się zaimportować pliku routing.' });
  }
});

machinesRouter.get('/:id/material-designations', (req, res) => {
  const id = Number(req.params.id);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const refMode = loadReferenceDisplayMode();
  const rows = db
    .prepare(
      `SELECT id, sap_number, alias, free_text, designation
       FROM part_designations
       ORDER BY alias COLLATE NOCASE, sap_number COLLATE NOCASE`
    )
    .all() as {
    id: number;
    sap_number: string | null;
    alias: string | null;
    free_text: string | null;
    designation: string | null;
  }[];
  res.json(
    rows.map((d) => ({
      id: d.id,
      sap_number: d.sap_number,
      alias: d.alias,
      free_text: d.free_text,
      designation: d.designation,
      label: formatDetailSapAliasLabel(d, refMode),
    }))
  );
});

machinesRouter.get('/:id/materials', (req, res) => {
  const id = Number(req.params.id);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const rows = db
    .prepare(
      `SELECT id, machine_id, alias, description, sap_number, grammage_kg_m2, width_mm, length_mm, created_at
              , include_in_capacity, production_share_percent, use_external_volume
       FROM machine_baseline_materials WHERE machine_id = ? ORDER BY id`
    )
    .all(id) as any[];
  res.json(rows.map((row) => enrichBaselineMaterial(row, found.machine)));
});

machinesRouter.post('/:id/materials', (req, res) => {
  const id = Number(req.params.id);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const body = parseMaterialBody(req.body);
  if (body.width_mm != null && body.length_mm != null) {
    const oriented = orientBaselineDimensions(found.machine, body.width_mm, body.length_mm);
    body.width_mm = oriented.widthMm;
    body.length_mm = oriented.lengthMm;
  }
  if (!body.alias && !body.sap_number) {
    return res.status(400).json({ error: 'Podaj alias lub numer SAP materiału.' });
  }
  const r = db
    .prepare(
      `INSERT INTO machine_baseline_materials
        (machine_id, alias, description, sap_number, grammage_kg_m2, width_mm, length_mm,
         include_in_capacity, production_share_percent, use_external_volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      body.alias || null,
      body.description || null,
      body.sap_number || null,
      body.grammage_kg_m2,
      body.width_mm,
      body.length_mm,
      body.include_in_capacity,
      body.production_share_percent,
      body.use_external_volume
    );
  replaceMaterialDesignations(
    Number(r.lastInsertRowid),
    body.designation_ids,
    body.designation_consumptions
  );
  saveDb();
  const row = db.prepare('SELECT * FROM machine_baseline_materials WHERE id = ?').get(Number(r.lastInsertRowid)) as any;
  res.status(201).json(enrichBaselineMaterial(row, found.machine));
});

machinesRouter.put('/:id/materials/:materialId', (req, res) => {
  const id = Number(req.params.id);
  const materialId = Number(req.params.materialId);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const existing = db
    .prepare('SELECT * FROM machine_baseline_materials WHERE id = ? AND machine_id = ?')
    .get(materialId, id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const body = parseMaterialBody(req.body);
  if (body.width_mm != null && body.length_mm != null) {
    const oriented = orientBaselineDimensions(found.machine, body.width_mm, body.length_mm);
    body.width_mm = oriented.widthMm;
    body.length_mm = oriented.lengthMm;
  }
  db.prepare(
    `UPDATE machine_baseline_materials
     SET alias = ?, description = ?, sap_number = ?, grammage_kg_m2 = ?, width_mm = ?, length_mm = ?,
         include_in_capacity = ?, production_share_percent = ?, use_external_volume = ?
     WHERE id = ? AND machine_id = ?`
  ).run(
    body.alias || null,
    body.description || null,
    body.sap_number || null,
    body.grammage_kg_m2,
    body.width_mm,
    body.length_mm,
    body.include_in_capacity,
    body.production_share_percent,
    body.use_external_volume,
    materialId,
    id
  );
  replaceMaterialDesignations(materialId, body.designation_ids, body.designation_consumptions);
  saveDb();
  const row = db.prepare('SELECT * FROM machine_baseline_materials WHERE id = ?').get(materialId) as any;
  res.json(enrichBaselineMaterial(row, found.machine));
});

machinesRouter.get('/:id/materials/:materialId/external-volumes', (req, res) => {
  const id = Number(req.params.id);
  const materialId = Number(req.params.materialId);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const mat = db.prepare('SELECT id FROM machine_baseline_materials WHERE id = ? AND machine_id = ?').get(materialId, id);
  if (!mat) return res.status(404).json({ error: 'Not found' });
  const rows = db
    .prepare('SELECT year, weekly_volume FROM machine_baseline_material_volumes WHERE material_id = ? ORDER BY year')
    .all(materialId) as { year: number; weekly_volume: number }[];
  res.json(rows);
});

machinesRouter.put('/:id/materials/:materialId/external-volumes', (req, res) => {
  const id = Number(req.params.id);
  const materialId = Number(req.params.materialId);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const mat = db.prepare('SELECT id FROM machine_baseline_materials WHERE id = ? AND machine_id = ?').get(materialId, id);
  if (!mat) return res.status(404).json({ error: 'Not found' });
  const rows: { year: number; weekly_volume: number }[] = Array.isArray(req.body) ? req.body : [];
  const upsert = db.prepare(
    `INSERT INTO machine_baseline_material_volumes (material_id, year, weekly_volume)
     VALUES (?, ?, ?)
     ON CONFLICT(material_id, year) DO UPDATE SET weekly_volume = excluded.weekly_volume`
  );
  const del = db.prepare('DELETE FROM machine_baseline_material_volumes WHERE material_id = ? AND year = ?');
  for (const entry of rows) {
    const year = Number(entry.year);
    const vol = Number(entry.weekly_volume);
    if (!Number.isFinite(year) || year < 1900 || year > 2100) continue;
    if (!Number.isFinite(vol) || vol < 0) {
      del.run(materialId, year);
    } else {
      upsert.run(materialId, year, vol);
    }
  }
  // remove years not in payload
  const sentYears = rows.map((r) => Number(r.year)).filter((y) => Number.isFinite(y));
  if (sentYears.length > 0) {
    const placeholders = sentYears.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM machine_baseline_material_volumes WHERE material_id = ? AND year NOT IN (${placeholders})`
    ).run(materialId, ...sentYears);
  } else {
    db.prepare('DELETE FROM machine_baseline_material_volumes WHERE material_id = ?').run(materialId);
  }
  saveDb();
  const updated = db
    .prepare('SELECT year, weekly_volume FROM machine_baseline_material_volumes WHERE material_id = ? ORDER BY year')
    .all(materialId) as { year: number; weekly_volume: number }[];
  res.json(updated);
});

machinesRouter.post('/:id/materials/bulk-delete', (req, res) => {
  const id = Number(req.params.id);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const all = Boolean((req.body as any)?.all);
  const ids = parseDesignationIds((req.body as any)?.ids);
  let deleted = 0;
  if (all) {
    const r = db.prepare('DELETE FROM machine_baseline_materials WHERE machine_id = ?').run(id);
    deleted = Number(r.changes ?? 0);
  } else {
    if (!ids.length) return res.status(400).json({ error: 'Zaznacz pozycje do usunięcia.' });
    const del = db.prepare('DELETE FROM machine_baseline_materials WHERE id = ? AND machine_id = ?');
    for (const materialId of ids) {
      deleted += Number(del.run(materialId, id).changes ?? 0);
    }
  }
  saveDb();
  res.json({ deleted });
});

machinesRouter.delete('/:id/materials/:materialId', (req, res) => {
  const id = Number(req.params.id);
  const materialId = Number(req.params.materialId);
  const found = requireBaselineMachine(id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });
  const r = db.prepare('DELETE FROM machine_baseline_materials WHERE id = ? AND machine_id = ?').run(materialId, id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  saveDb();
  res.status(204).send();
});

machinesRouter.post('/', (req, res) => {
  const body = req.body as any;
  const internalParsed = parseOptionalInternalMachineNumber(body.internal_number);
  if (!internalParsed.ok) return res.status(400).json({ error: internalParsed.error });
  const internal_number = internalParsed.value;
  const sap_number_raw = body.sap_number != null ? String(body.sap_number).trim() : '';
  if (!sap_number_raw) return res.status(400).json({ error: 'sap_number is required' });
  const sap_number = sap_number_raw;
  const type = String(body.type ?? '').trim();
  const oee_override = body.oee_override != null ? Number(body.oee_override) : null;
  const status = normalizeMachineStatus(body.status, 'active');
  const locRes = normalizeMachineLineLocationStrict(body.location);
  if (!locRes.ok) return res.status(400).json({ error: locRes.error });
  const location = locRes.value;
  const machine_usage = body.machine_usage !== undefined ? clampMachineUsage(body.machine_usage) : 1;
  const baseline = parseBaselineFieldsFromBody(body);
  const width_mm = baseline.is_baseline ? null : parseOptionalDimension(body.width_mm) ?? null;
  const depth_mm = baseline.is_baseline ? null : parseOptionalDimension(body.depth_mm) ?? null;
  const height_mm = baseline.is_baseline ? null : parseOptionalDimension(body.height_mm) ?? null;
  const stroke_mm = baseline.is_baseline ? null : parseOptionalDimension(body.stroke_mm) ?? null;
  if (!type) return res.status(400).json({ error: 'type is required' });
  const typeErr = machineTypeValidationError(type);
  if (typeErr) return res.status(400).json({ error: typeErr });

  if (internal_number != null) {
    const existing = db.prepare('SELECT id FROM machines WHERE internal_number = ?').get(internal_number);
    if (existing) return res.status(400).json({ error: 'Machine number already exists' });
  }

  db.prepare(`
    INSERT INTO machines (
      internal_number, sap_number, type, oee_override, status, location, machine_usage,
      width_mm, depth_mm, height_mm, stroke_mm,
      is_baseline, baseline_available_hours_per_week, baseline_weeks_per_year,
      baseline_max_throughput_kg_h, baseline_max_throughput_unit,
      baseline_min_throughput_kg_h, baseline_min_throughput_unit,
      baseline_max_speed_m_min, baseline_max_speed_unit,
      baseline_min_speed_m_min, baseline_min_speed_unit,
      baseline_max_blank_width_mm, baseline_max_blank_width_unit,
      baseline_min_blank_width_mm, baseline_min_blank_width_unit,
      baseline_min_length_mm,
      baseline_max_blanks_across, baseline_max_blanks_across_unit
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    internal_number,
    sap_number,
    type,
    oee_override,
    status,
    location,
    machine_usage,
    width_mm,
    depth_mm,
    height_mm,
    stroke_mm,
    baseline.is_baseline,
    baseline.baseline_available_hours_per_week,
    baseline.baseline_weeks_per_year,
    baseline.baseline_max_throughput_kg_h,
    baseline.baseline_max_throughput_unit,
    baseline.baseline_min_throughput_kg_h,
    baseline.baseline_min_throughput_unit,
    baseline.baseline_max_speed_m_min,
    baseline.baseline_max_speed_unit,
    baseline.baseline_min_speed_m_min,
    baseline.baseline_min_speed_unit,
    baseline.baseline_max_blank_width_mm,
    baseline.baseline_max_blank_width_unit,
    baseline.baseline_min_blank_width_mm,
    baseline.baseline_min_blank_width_unit,
    baseline.baseline_min_length_mm,
    baseline.baseline_max_blanks_across,
    baseline.baseline_max_blanks_across_unit
  );
  const lastId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(lastId.id) as any;
  res.status(201).json(row);
});

/** Bulk import: body { machines: [{ internal_number, sap_number?, type, status?, location?, oee_override? }] } */
machinesRouter.post('/import', (req, res) => {
  const body = req.body as { machines: any[] };
  const list = Array.isArray(body?.machines) ? body.machines : [];
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const insertStmt = db.prepare(`
    INSERT INTO machines (internal_number, sap_number, type, oee_override, status, location, machine_usage, width_mm, depth_mm, height_mm, stroke_mm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const typesToEnsure = list
    .map((row) => (row?.type != null ? String(row.type).trim() : ''))
    .filter(Boolean);
  const typesAdded = ensureMachineTypesExist(typesToEnsure);

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const internalParsed = parseInternalMachineNumber(row?.internal_number);
    if (!internalParsed.ok) {
      errors.push(`Wiersz ${i + 1}: ${internalParsed.error}`);
      continue;
    }
    const internal_number = internalParsed.value;
    const sap_number = row.sap_number != null ? String(row.sap_number).trim() || null : null;
    const type = row.type != null ? String(row.type).trim() : '';
    if (!type) {
      errors.push(`Wiersz ${i + 1} (nr ${internal_number}): brak typu`);
      continue;
    }
    const status = normalizeMachineStatus(row.status, 'active');
    const location = normalizeMachineLineLocationOrOne(row.location);
    const oee_override = row.oee_override != null && row.oee_override !== '' ? Number(row.oee_override) : null;
    const machine_usage = row.machine_usage !== undefined ? clampMachineUsage(row.machine_usage) : 1;
    const width_mm = parseOptionalDimension(row.width_mm) ?? null;
    const depth_mm = parseOptionalDimension(row.depth_mm) ?? null;
    const height_mm = parseOptionalDimension(row.height_mm) ?? null;
    const stroke_mm = parseOptionalDimension(row.stroke_mm) ?? null;

    const existing = db.prepare('SELECT id FROM machines WHERE internal_number = ?').get(internal_number);
    if (existing) {
      skipped.push(internal_number);
      continue;
    }
    try {
      insertStmt.run(internal_number, sap_number, type, oee_override, status, location, machine_usage, width_mm, depth_mm, height_mm, stroke_mm);
      created.push(internal_number);
    } catch (e: any) {
      errors.push(`Wiersz ${i + 1} (nr ${internal_number}): ${e.message || 'błąd zapisu'}`);
    }
  }

  if (created.length > 0 || typesAdded.length > 0) saveDb();
  res.json({
    created: created.length,
    skipped: skipped.length,
    types_added: typesAdded.length,
    types_added_names: typesAdded,
    errors,
    createdNumbers: created,
    skippedNumbers: skipped,
  });
});

machinesRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as any;
  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });

  let internal_number: string | null = row.internal_number != null ? String(row.internal_number) : null;
  if (body.internal_number !== undefined) {
    const parsed = parseOptionalInternalMachineNumber(body.internal_number);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (parsed.value != null) {
      const other = db.prepare('SELECT id FROM machines WHERE internal_number = ? AND id != ?').get(parsed.value, id);
      if (other) return res.status(400).json({ error: 'Machine number already exists' });
    }
    internal_number = parsed.value;
  }

  const sap_number = body.sap_number !== undefined ? body.sap_number : row.sap_number;
  const type = body.type !== undefined ? String(body.type).trim() : row.type;
  if (body.type !== undefined) {
    const typeErrPut = machineTypeValidationError(type);
    if (typeErrPut) return res.status(400).json({ error: typeErrPut });
  }
  const oee_override = body.oee_override !== undefined ? (body.oee_override == null ? null : Number(body.oee_override)) : row.oee_override;
  const status = body.status !== undefined ? normalizeMachineStatus(body.status) : normalizeMachineStatus(row.status, 'active');
  let location = row.location;
  if (body.location !== undefined) {
    const locRes = normalizeMachineLineLocationOptional(body.location);
    if (!locRes.ok) return res.status(400).json({ error: locRes.error });
    location = locRes.value;
  }
  const machine_usage = body.machine_usage !== undefined ? clampMachineUsage(body.machine_usage) : (row.machine_usage != null ? clampMachineUsage(row.machine_usage) : 1);
  const baseline = parseBaselineFieldsFromBody(body, row);
  const width_mm = baseline.is_baseline
    ? null
    : body.width_mm !== undefined
      ? parseOptionalDimension(body.width_mm) ?? null
      : row.width_mm;
  const depth_mm = baseline.is_baseline
    ? null
    : body.depth_mm !== undefined
      ? parseOptionalDimension(body.depth_mm) ?? null
      : row.depth_mm;
  const height_mm = baseline.is_baseline
    ? null
    : body.height_mm !== undefined
      ? parseOptionalDimension(body.height_mm) ?? null
      : row.height_mm;
  const stroke_mm = baseline.is_baseline
    ? null
    : body.stroke_mm !== undefined
      ? parseOptionalDimension(body.stroke_mm) ?? null
      : row.stroke_mm;

  try {
    db.prepare(`
      UPDATE machines SET internal_number = ?, sap_number = ?, type = ?, oee_override = ?, status = ?, location = ?, machine_usage = ?,
        width_mm = ?, depth_mm = ?, height_mm = ?, stroke_mm = ?,
        is_baseline = ?, baseline_available_hours_per_week = ?, baseline_weeks_per_year = ?,
        baseline_max_throughput_kg_h = ?, baseline_max_throughput_unit = ?,
        baseline_min_throughput_kg_h = ?, baseline_min_throughput_unit = ?,
        baseline_max_speed_m_min = ?, baseline_max_speed_unit = ?,
        baseline_min_speed_m_min = ?, baseline_min_speed_unit = ?,
        baseline_max_blank_width_mm = ?, baseline_max_blank_width_unit = ?,
        baseline_min_blank_width_mm = ?, baseline_min_blank_width_unit = ?,
        baseline_min_length_mm = ?,
        baseline_max_blanks_across = ?, baseline_max_blanks_across_unit = ?
      WHERE id = ?
    `).run(
      internal_number,
      sap_number,
      type,
      oee_override,
      status,
      location,
      machine_usage,
      width_mm,
      depth_mm,
      height_mm,
      stroke_mm,
      baseline.is_baseline,
      baseline.baseline_available_hours_per_week,
      baseline.baseline_weeks_per_year,
      baseline.baseline_max_throughput_kg_h,
      baseline.baseline_max_throughput_unit,
      baseline.baseline_min_throughput_kg_h,
      baseline.baseline_min_throughput_unit,
      baseline.baseline_max_speed_m_min,
      baseline.baseline_max_speed_unit,
      baseline.baseline_min_speed_m_min,
      baseline.baseline_min_speed_unit,
      baseline.baseline_max_blank_width_mm,
      baseline.baseline_max_blank_width_unit,
      baseline.baseline_min_blank_width_mm,
      baseline.baseline_min_blank_width_unit,
      baseline.baseline_min_length_mm,
      baseline.baseline_max_blanks_across,
      baseline.baseline_max_blanks_across_unit,
      id
    );
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE') || e?.message?.includes('unique')) return res.status(400).json({ error: 'Machine number already exists' });
    throw e;
  }
  saveDb();
  const updated = db.prepare(`SELECT ${MACHINE_SELECT_COLS} FROM machines WHERE id = ?`).get(id) as any;
  res.json({ ...updated, machine_usage: updated.machine_usage != null ? Number(updated.machine_usage) : 1 });
});

machinesRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM machines WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});
