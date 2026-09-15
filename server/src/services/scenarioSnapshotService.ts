import { db, saveDb } from '../db/connection.js';
import { normalizeVolumeOrigin, type VolumeEntryOrigin } from './capacityService.js';
import {
  releaseAllReservationsForScenario,
  releaseReservationsForDeployedIds,
} from './scenarioIdReservationService.js';

/** Wpis historii zmian przechowywany w snapshotcie scenariusza (osobno od tabeli project_notes w produkcji). */
export type ScenarioAuditEntry = {
  id: number;
  note_date: string;
  author: string | null;
  note: string;
  note_type: 'manual' | 'auto';
  project_id?: number | null;
  machine_id?: number | null;
  part_id?: number | null;
  operation_id?: number | null;
};

/** Zestaw danych zapisywany w scenariuszu (osobna instancja od produkcji). */
export type ScenarioBundle = {
  version: 2;
  projects: any[];
  parts: any[];
  operations: any[];
  working_days: any[];
  project_volumes: any[];
  /** Wolumeny kontraktowe na poziomie projektu (per rok). */
  project_volumes_contract?: any[];
  operation_volume_by_year: any[];
  part_volume_by_year: any[];
  /** Wolumeny kontraktowe detalu (tryb override). */
  part_volume_contract_by_year?: any[];
  part_volume_share_by_year: any[];
  part_volume_contract_share_by_year?: any[];
  operation_set_members: any[];
  project_eop_extensions: any[];
  part_designations: any[];
  /** Historia zmian w ramach scenariusza (nie miesza się z produkcyjną historią). */
  audit_log?: ScenarioAuditEntry[];
};

export function exportLiveScenarioBundle(): ScenarioBundle {
  const projects = db.prepare('SELECT * FROM projects ORDER BY id').all() as any[];
  const parts = db.prepare('SELECT * FROM parts ORDER BY id').all() as any[];
  const operations = db.prepare('SELECT * FROM operations ORDER BY id').all() as any[];
  const working_days = db.prepare('SELECT * FROM working_days ORDER BY year').all() as any[];
  const project_volumes = db.prepare('SELECT * FROM project_volumes').all() as any[];
  let project_volumes_contract: any[] = [];
  try {
    project_volumes_contract = db.prepare('SELECT * FROM project_volumes_contract').all() as any[];
  } catch {
    project_volumes_contract = [];
  }
  const operation_volume_by_year = db.prepare('SELECT * FROM operation_volume_by_year').all() as any[];
  const part_volume_by_year = db.prepare('SELECT * FROM part_volume_by_year').all() as any[];
  let part_volume_contract_by_year: any[] = [];
  try {
    part_volume_contract_by_year = db.prepare('SELECT * FROM part_volume_contract_by_year').all() as any[];
  } catch {
    part_volume_contract_by_year = [];
  }
  const part_volume_share_by_year = db.prepare('SELECT * FROM part_volume_share_by_year').all() as any[];
  let part_volume_contract_share_by_year: any[] = [];
  try {
    part_volume_contract_share_by_year = db.prepare('SELECT * FROM part_volume_contract_share_by_year').all() as any[];
  } catch {
    part_volume_contract_share_by_year = [];
  }
  let operation_set_members: any[] = [];
  try {
    operation_set_members = db.prepare('SELECT * FROM operation_set_members').all() as any[];
  } catch {
    operation_set_members = [];
  }
  let project_eop_extensions: any[] = [];
  try {
    project_eop_extensions = db.prepare('SELECT * FROM project_eop_extensions').all() as any[];
  } catch {
    project_eop_extensions = [];
  }
  const desIds = new Set<number>();
  for (const p of parts) {
    if (p.designation_id != null && Number.isFinite(Number(p.designation_id))) desIds.add(Number(p.designation_id));
  }
  let part_designations: any[] = [];
  if (desIds.size > 0) {
    const ph = Array.from(desIds)
      .map(() => '?')
      .join(',');
    part_designations = db.prepare(`SELECT * FROM part_designations WHERE id IN (${ph})`).all(...Array.from(desIds)) as any[];
  }
  return {
    version: 2,
    projects,
    parts,
    operations,
    working_days,
    project_volumes,
    project_volumes_contract,
    operation_volume_by_year,
    part_volume_by_year,
    part_volume_contract_by_year,
    part_volume_share_by_year,
    part_volume_contract_share_by_year,
    operation_set_members,
    project_eop_extensions,
    part_designations,
    audit_log: [],
  };
}

export function parseScenarioSnapshotJson(raw: string): ScenarioBundle {
  const o = JSON.parse(raw) as any;
  if (o && o.version === 2 && Array.isArray(o.projects)) {
    const b = o as ScenarioBundle;
    if (!Array.isArray(b.audit_log)) b.audit_log = [];
    if (!Array.isArray(b.project_volumes_contract)) b.project_volumes_contract = [];
    if (!Array.isArray(b.part_volume_contract_by_year)) b.part_volume_contract_by_year = [];
    if (!Array.isArray(b.part_volume_contract_share_by_year)) b.part_volume_contract_share_by_year = [];
    return b;
  }
  return {
    version: 2,
    projects: o?.projects ?? [],
    parts: o?.parts ?? [],
    operations: o?.operations ?? [],
    working_days: o?.working_days ?? [],
    project_volumes: [],
    project_volumes_contract: [],
    operation_volume_by_year: [],
    part_volume_by_year: [],
    part_volume_contract_by_year: [],
    part_volume_share_by_year: [],
    part_volume_contract_share_by_year: [],
    operation_set_members: [],
    project_eop_extensions: [],
    part_designations: [],
    audit_log: [],
  };
}

export function cloneScenarioBundle(bundle: ScenarioBundle): ScenarioBundle {
  return JSON.parse(JSON.stringify(bundle)) as ScenarioBundle;
}

const SCENARIO_LINE_STATUSES = ['active', 'inactive', 'RFQ'] as const;
export type ScenarioLineStatus = (typeof SCENARIO_LINE_STATUSES)[number];

/** Status wiersza w scenariuszu (projekt / detal / operacja). Tylko snapshot JSON — nie kolumny produkcyjne. */
export function normalizeScenarioLineStatus(v: unknown): ScenarioLineStatus | null {
  const s = String(v ?? '').trim();
  return (SCENARIO_LINE_STATUSES as readonly string[]).includes(s) ? (s as ScenarioLineStatus) : null;
}

export function declaredProjectStatus(p: any): ScenarioLineStatus {
  return normalizeScenarioLineStatus(p?.status) ?? 'active';
}

/** Efektywny status detalu: własny `status` w snapshotcie lub status projektu. */
export function effectivePartStatus(snapshot: ScenarioBundle, part: any): ScenarioLineStatus {
  const own = normalizeScenarioLineStatus(part?.status);
  if (own != null) return own;
  const proj = (snapshot.projects || []).find((x: any) => Number(x.id) === Number(part?.project_id));
  return declaredProjectStatus(proj);
}

/** Efektywny status operacji dla kalkulatora: własny `status` w snapshotcie lub detal → projekt. */
export function effectiveOperationStatus(snapshot: ScenarioBundle, op: any): ScenarioLineStatus {
  const own = normalizeScenarioLineStatus(op?.status);
  if (own != null) return own;
  const pt = (snapshot.parts || []).find((x: any) => Number(x.id) === Number(op?.part_id));
  if (pt) return effectivePartStatus(snapshot, pt);
  const proj = (snapshot.projects || []).find((x: any) => Number(x.id) === Number(op?.project_id));
  return declaredProjectStatus(proj);
}

/** Usuwa pole `status` z wierszy części/operacji przed wgraniem do produkcji (brak kolumny w DB). */
export function stripScenarioLineStatusForProduction(rows: any[]): any[] {
  if (!rows?.length) return rows;
  return rows.map((r) => {
    if (r == null || typeof r !== 'object') return r;
    const { status: _s, ...rest } = r as any;
    return rest;
  });
}

/** Dodaje wpis do `audit_log` w buforze snapshotu (przed zapisem UPDATE scenarios). */
export function pushScenarioAudit(
  bundle: ScenarioBundle,
  entry: Omit<ScenarioAuditEntry, 'id' | 'note_date'> & { note_date?: string }
): void {
  if (!bundle.audit_log) bundle.audit_log = [];
  const nextId = bundle.audit_log.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) + 1;
  const note_date = entry.note_date ?? new Date().toISOString().slice(0, 10);
  bundle.audit_log.push({
    id: nextId,
    note_date,
    author: entry.author ?? null,
    note: entry.note,
    note_type: entry.note_type,
    project_id: entry.project_id ?? null,
    machine_id: entry.machine_id ?? null,
    part_id: entry.part_id ?? null,
    operation_id: entry.operation_id ?? null,
  });
}

export function resolveSettingsForScenarioYear(year: number, snapshot: ScenarioBundle): any | null {
  const rows = snapshot.working_days || [];
  let row = rows.find((r: any) => Number(r.year) === year && (r.status === 'active' || r.status == null));
  if (!row) row = rows.find((r: any) => Number(r.year) === year);
  return row ?? null;
}

/** Jak getEffectiveVolumeForPart, ale z danych scenariusza (bez zapytań do tabel projektów w produkcji). */
export function getEffectiveVolumeForPartScenario(projectId: number, partId: number, year: number, snap: ScenarioBundle): any | null {
  const pv = (snap.project_volumes || []).find((r: any) => Number(r.project_id) === projectId && Number(r.year) === year) as
    | { volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number; volume_origin?: string }
    | undefined;
  const proj = (snap.projects || []).find((p: any) => Number(p.id) === projectId) as { eop: string } | undefined;
  const projectEop = proj?.eop ?? null;
  const part = (snap.parts || []).find((p: any) => Number(p.id) === partId) as any | undefined;
  const partVol = (snap.part_volume_by_year || []).find((r: any) => Number(r.part_id) === partId && Number(r.year) === year) as
    | { volume_value: number; volume_unit: string; volume_origin?: string }
    | undefined;

  const eopMatch = projectEop ? String(projectEop).trim().match(/^\d{1,2}\.(\d{4})$/) : null;
  const eopYear = eopMatch ? parseInt(eopMatch[1], 10) : null;
  const isAfterEop = eopYear != null && year > eopYear;
  const incAfter = Number(pv?.include_in_calculator_after_eop ?? 0);
  const countAfterEop = Boolean(isAfterEop && pv && incAfter === 1);
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
    const row = (snap.part_volume_share_by_year || []).find((r: any) => Number(r.part_id) === partId && Number(r.year) === year) as { share_percent: number } | undefined;
    if (row != null) sharePct = row.share_percent;
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

/** Jak getEffectiveVolumeForPartScenario, ale z tabel kontraktowych w snapshotcie. */
export function getEffectiveVolumeForPartScenarioContract(projectId: number, partId: number, year: number, snap: ScenarioBundle): any | null {
  const pvc = (snap.project_volumes_contract || []).find((r: any) => Number(r.project_id) === projectId && Number(r.year) === year) as
    | { volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number; volume_origin?: string }
    | undefined;
  const proj = (snap.projects || []).find((p: any) => Number(p.id) === projectId) as { eop: string } | undefined;
  const projectEop = proj?.eop ?? null;
  const part = (snap.parts || []).find((p: any) => Number(p.id) === partId) as any | undefined;
  const partVolC = (snap.part_volume_contract_by_year || []).find((r: any) => Number(r.part_id) === partId && Number(r.year) === year) as
    | { volume_value: number; volume_unit: string; volume_origin?: string }
    | undefined;

  const eopMatch = projectEop ? String(projectEop).trim().match(/^\d{1,2}\.(\d{4})$/) : null;
  const eopYear = eopMatch ? parseInt(eopMatch[1], 10) : null;
  const isAfterEop = eopYear != null && year > eopYear;
  const pvProd = (snap.project_volumes || []).find((r: any) => Number(r.project_id) === projectId && Number(r.year) === year) as
    | { volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number }
    | undefined;
  const pvForEop = pvc ?? pvProd;
  const countAfterEop = Boolean(isAfterEop && pvForEop && Number(pvForEop.include_in_calculator_after_eop) === 1);
  const volumeOriginFromRow = (row: { volume_origin?: string } | undefined, fallback: VolumeEntryOrigin): VolumeEntryOrigin =>
    normalizeVolumeOrigin(row?.volume_origin ?? fallback);

  const mode = String(part?.contract_volume_mode ?? 'project');
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
      const u = ['annual', 'monthly', 'weekly'].includes(String(part.contract_default_volume_unit)) ? String(part.contract_default_volume_unit) : 'annual';
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
    const rowC = (snap.part_volume_contract_share_by_year || []).find(
      (r: any) => Number(r.part_id) === partId && Number(r.year) === year
    ) as { share_percent: number } | undefined;
    if (rowC != null) sharePct = rowC.share_percent;
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

/** Kontraktowe z fallbackiem do produkcyjnych (brak wpisów kontraktowych). */
export function getEffectiveVolumeForPartScenarioPreferContract(
  projectId: number,
  partId: number,
  year: number,
  snap: ScenarioBundle,
  useContractual: boolean
): any | null {
  if (!useContractual) return getEffectiveVolumeForPartScenario(projectId, partId, year, snap);
  const c = getEffectiveVolumeForPartScenarioContract(projectId, partId, year, snap);
  return c ?? getEffectiveVolumeForPartScenario(projectId, partId, year, snap);
}

/** Operacje ze snapshotu w kształcie zbliżonym do zapytania capacity (join z projektem).
 *  Domyślnie: projekty active + RFQ (kalkulator scenariusza). Przy `includeRfq: false` tylko active (np. scenariusz zarchiwizowany = jak produkcja). */
export function scenarioHydratedOperationsForActiveProjects(
  snapshot: ScenarioBundle,
  opts?: { includeRfq?: boolean }
): any[] {
  const includeRfq = opts?.includeRfq !== false;
  const hydrated = hydrateOperationsForScenario(snapshot);
  return hydrated.filter((o: any) => {
    const st = String(o.project_status ?? 'active');
    if (st === 'inactive') return false;
    if (st === 'RFQ') return includeRfq;
    return st === 'active';
  });
}

export function hydrateOperationsForScenario(snapshot: ScenarioBundle): any[] {
  const projectsById = new Map((snapshot.projects || []).map((p: any) => [Number(p.id), p]));
  const partsById = new Map((snapshot.parts || []).map((pt: any) => [Number(pt.id), pt]));
  const designationsById = new Map((snapshot.part_designations || []).map((d: any) => [Number(d.id), d]));
  const ops = snapshot.operations || [];
  return ops.map((o: any) => {
    const p = projectsById.get(Number(o.project_id));
    const pt = partsById.get(Number(o.part_id));
    const pd = pt?.designation_id != null ? designationsById.get(Number(pt.designation_id)) : null;
    const lineStatus = effectiveOperationStatus(snapshot, o);
    return {
      ...o,
      operation_id: o.id,
      sop: p?.sop ?? '',
      eop: p?.eop ?? '',
      /** Dla kalkulatora scenariusza: efektywny status linii (operacja → detal → projekt). */
      project_status: lineStatus,
      project_client: p?.client ?? '',
      project_name: p?.name ?? '',
      detail_sap_number: pd?.sap_number ?? null,
      detail_alias: pd?.alias ?? null,
      detail_free_text: pd?.free_text ?? null,
      detail_designation_id: pd?.id ?? pt?.designation_id ?? null,
      detail_designation: pt?.designation ?? null,
    };
  });
}

function collectInsertColumns(rows: any[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r && typeof r === 'object') Object.keys(r).forEach((k) => keys.add(k));
  }
  return Array.from(keys);
}

function insertRows(table: string, rows: any[]) {
  if (!rows?.length) return;
  const cols = collectInsertColumns(rows);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  for (const r of rows) {
    stmt.run(...cols.map((c) => (r[c] !== undefined ? r[c] : null)));
  }
}

/** Wstawia wiersze bez kolumn AUTOINCREMENT (np. id), żeby uniknąć kolizji UNIQUE po częściowym czyszczeniu lub zduplikowanych id w snapshotcie. */
function insertRowsOmittingColumns(table: string, rows: any[], omitCols: string[]) {
  if (!rows?.length) return;
  const omit = new Set(omitCols);
  const cols = collectInsertColumns(rows).filter((c) => !omit.has(c));
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  for (const r of rows) {
    stmt.run(...cols.map((c) => (r[c] !== undefined ? r[c] : null)));
  }
}

function insertOrReplaceRows(table: string, rows: any[]) {
  if (!rows?.length) return;
  const cols = collectInsertColumns(rows);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  for (const r of rows) {
    stmt.run(...cols.map((c) => (r[c] !== undefined ? r[c] : null)));
  }
}

function insertOrReplaceRowsOmittingColumns(table: string, rows: any[], omitCols: string[]) {
  if (!rows?.length) return;
  const omit = new Set(omitCols);
  const cols = collectInsertColumns(rows).filter((c) => !omit.has(c));
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  for (const r of rows) {
    stmt.run(...cols.map((c) => (r[c] !== undefined ? r[c] : null)));
  }
}

/** Ostatni wiersz wygrywa — usuwa zduplikowane id w snapshotcie (np. po scaleniach), które powodują UNIQUE przy wgrywaniu. */
export function dedupeRowsById(rows: any[], idField = 'id'): any[] {
  if (!rows?.length) return [];
  const m = new Map<number, any>();
  for (const r of rows) {
    const id = Number(r[idField]);
    if (!Number.isFinite(id)) continue;
    m.set(id, r);
  }
  return Array.from(m.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

export function dedupeRowsByComposite(rows: any[], keyFields: string[]): any[] {
  if (!rows?.length) return [];
  const m = new Map<string, any>();
  for (const r of rows) {
    const key = keyFields.map((f) => String((r as any)[f] ?? '')).join('\u0001');
    m.set(key, r);
  }
  return Array.from(m.values());
}

export type AddableProductionProject = {
  id: number;
  client: string;
  name: string;
  sop: string | null;
  eop: string | null;
  status: string;
};

/** Projekty z bazy produkcyjnej, których nie ma jeszcze w snapshotcie scenariusza. */
export function listProductionProjectsNotInBundle(bundle: ScenarioBundle): AddableProductionProject[] {
  const inSnap = new Set((bundle.projects || []).map((p: any) => Number(p.id)).filter((n: number) => Number.isFinite(n)));
  const rows = db
    .prepare('SELECT id, client, name, sop, eop, status FROM projects ORDER BY client COLLATE NOCASE, name COLLATE NOCASE')
    .all() as any[];
  return rows
    .filter((r) => !inSnap.has(Number(r.id)))
    .map((r) => ({
      id: Number(r.id),
      client: String(r.client ?? ''),
      name: String(r.name ?? ''),
      sop: r.sop != null ? String(r.sop) : null,
      eop: r.eop != null ? String(r.eop) : null,
      status: String(r.status ?? 'active'),
    }));
}

function cloneDbRow(r: any): any {
  return JSON.parse(JSON.stringify(r)) as any;
}

/** Dołącza do snapshotu kopię wybranych projektów z produkcji (części, operacje, wolumeny, oznaczenia detali). */
export function appendProductionProjectsToBundle(bundle: ScenarioBundle, projectIds: number[]): {
  addedProjectIds: number[];
  skippedAlreadyInBundle: number[];
  notFoundInProduction: number[];
} {
  const existingProj = new Set((bundle.projects || []).map((p: any) => Number(p.id)));
  const existingDes = new Set((bundle.part_designations || []).map((d: any) => Number(d.id)).filter((n: number) => Number.isFinite(n)));

  const addedProjectIds: number[] = [];
  const skippedAlreadyInBundle: number[] = [];
  const notFoundInProduction: number[] = [];

  const want = [...new Set(projectIds.map((x) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0))];

  for (const pid of want) {
    if (existingProj.has(pid)) {
      skippedAlreadyInBundle.push(pid);
      continue;
    }
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as any;
    if (!proj) {
      notFoundInProduction.push(pid);
      continue;
    }

    const parts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(pid) as any[];
    const operations = db.prepare('SELECT * FROM operations WHERE project_id = ?').all(pid) as any[];
    const projectVolumes = db.prepare('SELECT * FROM project_volumes WHERE project_id = ?').all(pid) as any[];
    let projectVolumesContract: any[] = [];
    try {
      projectVolumesContract = db.prepare('SELECT * FROM project_volumes_contract WHERE project_id = ?').all(pid) as any[];
    } catch {
      projectVolumesContract = [];
    }

    let pex: any[] = [];
    try {
      pex = db.prepare('SELECT * FROM project_eop_extensions WHERE project_id = ?').all(pid) as any[];
    } catch {
      pex = [];
    }

    const partIds = parts.map((p) => Number(p.id)).filter((n) => Number.isFinite(n));
    const opIds = operations.map((o) => Number(o.id)).filter((n) => Number.isFinite(n));

    let partVolYear: any[] = [];
    let partVolContractYear: any[] = [];
    let partShareYear: any[] = [];
    let partContractShareYear: any[] = [];
    let opVolYear: any[] = [];
    let opSetMembers: any[] = [];

    if (partIds.length > 0) {
      const ph = partIds.map(() => '?').join(',');
      partVolYear = db.prepare(`SELECT * FROM part_volume_by_year WHERE part_id IN (${ph})`).all(...partIds) as any[];
      try {
        partVolContractYear = db.prepare(`SELECT * FROM part_volume_contract_by_year WHERE part_id IN (${ph})`).all(...partIds) as any[];
      } catch {
        partVolContractYear = [];
      }
      try {
        partShareYear = db.prepare(`SELECT * FROM part_volume_share_by_year WHERE part_id IN (${ph})`).all(...partIds) as any[];
      } catch {
        partShareYear = [];
      }
      try {
        partContractShareYear = db.prepare(`SELECT * FROM part_volume_contract_share_by_year WHERE part_id IN (${ph})`).all(...partIds) as any[];
      } catch {
        partContractShareYear = [];
      }
    }
    if (opIds.length > 0) {
      const oh = opIds.map(() => '?').join(',');
      opVolYear = db.prepare(`SELECT * FROM operation_volume_by_year WHERE operation_id IN (${oh})`).all(...opIds) as any[];
      try {
        opSetMembers = db.prepare(`SELECT * FROM operation_set_members WHERE operation_id IN (${oh})`).all(...opIds) as any[];
      } catch {
        opSetMembers = [];
      }
    }

    const desIds = new Set<number>();
    for (const pt of parts) {
      if (pt.designation_id != null && Number.isFinite(Number(pt.designation_id))) desIds.add(Number(pt.designation_id));
    }
    const newDesignations: any[] = [];
    for (const did of desIds) {
      if (existingDes.has(did)) continue;
      const drow = db.prepare('SELECT * FROM part_designations WHERE id = ?').get(did) as any;
      if (drow) {
        newDesignations.push(cloneDbRow(drow));
        existingDes.add(did);
      }
    }

    bundle.projects = [...(bundle.projects || []), cloneDbRow(proj)];
    bundle.parts = [...(bundle.parts || []), ...parts.map(cloneDbRow)];
    bundle.operations = [...(bundle.operations || []), ...operations.map(cloneDbRow)];
    bundle.project_volumes = [...(bundle.project_volumes || []), ...projectVolumes.map(cloneDbRow)];
    if (!bundle.project_volumes_contract) bundle.project_volumes_contract = [];
    bundle.project_volumes_contract = [...bundle.project_volumes_contract, ...projectVolumesContract.map(cloneDbRow)];
    bundle.part_volume_by_year = [...(bundle.part_volume_by_year || []), ...partVolYear.map(cloneDbRow)];
    if (!bundle.part_volume_contract_by_year) bundle.part_volume_contract_by_year = [];
    bundle.part_volume_contract_by_year = [...bundle.part_volume_contract_by_year, ...partVolContractYear.map(cloneDbRow)];
    bundle.part_volume_share_by_year = [...(bundle.part_volume_share_by_year || []), ...partShareYear.map(cloneDbRow)];
    if (!bundle.part_volume_contract_share_by_year) bundle.part_volume_contract_share_by_year = [];
    bundle.part_volume_contract_share_by_year = [...bundle.part_volume_contract_share_by_year, ...partContractShareYear.map(cloneDbRow)];
    bundle.operation_volume_by_year = [...(bundle.operation_volume_by_year || []), ...opVolYear.map(cloneDbRow)];
    bundle.operation_set_members = [...(bundle.operation_set_members || []), ...opSetMembers.map(cloneDbRow)];
    bundle.project_eop_extensions = [...(bundle.project_eop_extensions || []), ...pex.map(cloneDbRow)];
    bundle.part_designations = [...(bundle.part_designations || []), ...newDesignations];

    existingProj.add(pid);
    addedProjectIds.push(pid);
  }

  return { addedProjectIds, skippedAlreadyInBundle, notFoundInProduction };
}

/**
 * Zastępuje dane produkcyjne zawartością scenariusza (maszyny, typy, gniazda — bez zmian).
 * Usuwa projekty i powiązane dane, potem wstawia wiersze ze snapshotu (zachowane id).
 */
export function applyScenarioBundleToProduction(bundle: ScenarioBundle, scenarioId?: number): void {
  /* CASCADE usuwa części, operacje, wolumeny, notatki projektów itd. */
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM working_days').run();

  const workingDays = dedupeRowsByComposite(bundle.working_days || [], ['year']);
  const designations = dedupeRowsById(bundle.part_designations || []);
  const projects = dedupeRowsById(bundle.projects || []);
  const pex = dedupeRowsById(bundle.project_eop_extensions || []);
  const parts = dedupeRowsById(bundle.parts || []);
  const projectVolumes = dedupeRowsByComposite(bundle.project_volumes || [], ['project_id', 'year']);
  const projectVolumesContract = dedupeRowsByComposite(bundle.project_volumes_contract || [], ['project_id', 'year']);
  const partVolYear = dedupeRowsByComposite(bundle.part_volume_by_year || [], ['part_id', 'year']);
  const partVolContractYear = dedupeRowsByComposite(bundle.part_volume_contract_by_year || [], ['part_id', 'year']);
  const partShareYear = dedupeRowsByComposite(bundle.part_volume_share_by_year || [], ['part_id', 'year']);
  const partContractShareYear = dedupeRowsByComposite(bundle.part_volume_contract_share_by_year || [], ['part_id', 'year']);
  const operations = dedupeRowsById(bundle.operations || []);
  const opSetMembers = dedupeRowsByComposite(bundle.operation_set_members || [], ['operation_id', 'part_id']);
  const opVolYear = dedupeRowsByComposite(bundle.operation_volume_by_year || [], ['operation_id', 'year']);

  insertOrReplaceRows('working_days', workingDays);
  insertOrReplaceRows('part_designations', designations);
  insertOrReplaceRows('projects', projects);
  insertRowsOmittingColumns('project_eop_extensions', pex, ['id']);
  insertOrReplaceRows('parts', stripScenarioLineStatusForProduction(parts));
  insertOrReplaceRows('project_volumes', projectVolumes);
  insertOrReplaceRows('project_volumes_contract', projectVolumesContract);
  insertOrReplaceRows('part_volume_by_year', partVolYear);
  insertOrReplaceRows('part_volume_contract_by_year', partVolContractYear);
  insertOrReplaceRows('part_volume_share_by_year', partShareYear);
  insertOrReplaceRows('part_volume_contract_share_by_year', partContractShareYear);
  insertOrReplaceRows('operations', stripScenarioLineStatusForProduction(operations));
  insertOrReplaceRows('operation_set_members', opSetMembers);
  insertOrReplaceRowsOmittingColumns('operation_volume_by_year', opVolYear, ['id']);
  saveDb();
  if (scenarioId != null && scenarioId > 0) releaseAllReservationsForScenario(scenarioId);
}

function dedupePositiveIds(arr: number[]): number[] {
  return [...new Set(arr.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
}

/**
 * Wgrywa do produkcji tylko wybrane projekty (z wszystkimi detalami) albo wybrane detale (części) w ramach wskazanych projektów.
 * Nie modyfikuje `working_days` ani projektów spoza listy. W trybie „tylko detale” nie usuwa całych projektów — tylko zastępuje wskazane wiersze `parts` i zależne.
 */
export function applyScenarioBundleSubsetToProduction(
  bundle: ScenarioBundle,
  opts: { projectIds: number[]; partIds?: number[] | null },
  scenarioId?: number
): { projectsTouched: number; partsTouched: number; mode: 'projects' | 'parts' } {
  const projectIds = dedupePositiveIds(opts.projectIds);
  if (projectIds.length === 0) throw new Error('Wybierz co najmniej jeden projekt.');

  const projById = new Map((bundle.projects || []).map((p: any) => [Number(p.id), p]));
  for (const pid of projectIds) {
    if (!projById.has(pid)) throw new Error(`Projekt #${pid} nie występuje w zawartości scenariusza.`);
  }
  const bundleProjects = projectIds.map((id) => projById.get(id)!).filter(Boolean);

  const partIdFilter = opts.partIds != null && opts.partIds.length > 0 ? new Set(dedupePositiveIds(opts.partIds)) : null;
  const partsOnly = partIdFilter != null;

  let partsRows = (bundle.parts || []).filter((pt: any) => projectIds.includes(Number(pt.project_id)));
  if (partsOnly) {
    for (const want of partIdFilter!) {
      const row = (bundle.parts || []).find((pt: any) => Number(pt.id) === want);
      if (!row) throw new Error(`Detal (część) #${want} nie występuje w scenariuszu.`);
      if (!projectIds.includes(Number(row.project_id))) {
        throw new Error(`Detal #${want} nie należy do wybranych projektów.`);
      }
    }
    partsRows = partsRows.filter((pt: any) => partIdFilter!.has(Number(pt.id)));
  }

  if (partsRows.length === 0) {
    throw new Error(partsOnly ? 'Brak detali do wgrania (sprawdź zaznaczenie).' : 'Brak części przypisanych do wybranych projektów w scenariuszu.');
  }

  const partIdSet = new Set(partsRows.map((p: any) => Number(p.id)));
  const operationsRows = (bundle.operations || []).filter(
    (o: any) => projectIds.includes(Number(o.project_id)) && partIdSet.has(Number(o.part_id))
  );
  const operationIdSet = new Set(operationsRows.map((o: any) => Number(o.id)));

  const projectVolumesRows = (bundle.project_volumes || []).filter((v: any) => projectIds.includes(Number(v.project_id)));
  const projectVolumesContractRows = (bundle.project_volumes_contract || []).filter((v: any) => projectIds.includes(Number(v.project_id)));
  const partVolYearRows = (bundle.part_volume_by_year || []).filter((v: any) => partIdSet.has(Number(v.part_id)));
  const partVolContractYearRows = (bundle.part_volume_contract_by_year || []).filter((v: any) => partIdSet.has(Number(v.part_id)));
  const partShareYearRows = (bundle.part_volume_share_by_year || []).filter((v: any) => partIdSet.has(Number(v.part_id)));
  const partContractShareYearRows = (bundle.part_volume_contract_share_by_year || []).filter((v: any) => partIdSet.has(Number(v.part_id)));
  const opVolYearRows = (bundle.operation_volume_by_year || []).filter((v: any) => operationIdSet.has(Number(v.operation_id)));
  const opSetMembersRows = (bundle.operation_set_members || []).filter(
    (m: any) => operationIdSet.has(Number(m.operation_id)) && partIdSet.has(Number(m.part_id))
  );
  const pexRows = (bundle.project_eop_extensions || []).filter((x: any) => projectIds.includes(Number(x.project_id)));

  const desIds = new Set<number>();
  for (const pt of partsRows) {
    if (pt.designation_id != null && Number.isFinite(Number(pt.designation_id))) desIds.add(Number(pt.designation_id));
  }
  const designationsRows = dedupeRowsById((bundle.part_designations || []).filter((d: any) => desIds.has(Number(d.id))));

  /* Usuń z produkcji — pełne projekty lub pojedyncze części */
  if (!partsOnly) {
    for (const pid of projectIds) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    }
  } else {
    for (const ptid of partIdSet) {
      db.prepare('DELETE FROM parts WHERE id = ?').run(ptid);
    }
  }

  insertOrReplaceRows('part_designations', designationsRows);
  insertOrReplaceRows('projects', dedupeRowsById(bundleProjects));
  insertRowsOmittingColumns('project_eop_extensions', dedupeRowsById(pexRows), ['id']);
  insertOrReplaceRows('parts', stripScenarioLineStatusForProduction(dedupeRowsById(partsRows)));
  insertOrReplaceRows('project_volumes', dedupeRowsByComposite(projectVolumesRows, ['project_id', 'year']));
  insertOrReplaceRows('project_volumes_contract', dedupeRowsByComposite(projectVolumesContractRows, ['project_id', 'year']));
  insertOrReplaceRows('part_volume_by_year', dedupeRowsByComposite(partVolYearRows, ['part_id', 'year']));
  insertOrReplaceRows('part_volume_contract_by_year', dedupeRowsByComposite(partVolContractYearRows, ['part_id', 'year']));
  insertOrReplaceRows('part_volume_share_by_year', dedupeRowsByComposite(partShareYearRows, ['part_id', 'year']));
  insertOrReplaceRows('part_volume_contract_share_by_year', dedupeRowsByComposite(partContractShareYearRows, ['part_id', 'year']));
  insertOrReplaceRows('operations', stripScenarioLineStatusForProduction(dedupeRowsById(operationsRows)));
  insertOrReplaceRows('operation_set_members', dedupeRowsByComposite(opSetMembersRows, ['operation_id', 'part_id']));
  insertOrReplaceRowsOmittingColumns('operation_volume_by_year', dedupeRowsByComposite(opVolYearRows, ['operation_id', 'year']), ['id']);

  saveDb();
  if (scenarioId != null && scenarioId > 0) {
    releaseReservationsForDeployedIds(scenarioId, {
      projectIds,
      partIds: [...partIdSet],
      operationIds: [...operationIdSet],
    });
  }
  return {
    projectsTouched: projectIds.length,
    partsTouched: partsRows.length,
    mode: partsOnly ? 'parts' : 'projects',
  };
}
