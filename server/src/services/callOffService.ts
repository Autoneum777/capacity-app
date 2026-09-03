import { db, saveDb } from '../db/connection.js';
import { assignIsoWeekToStartMonth } from '../utils/sopEopFormat.js';
import {
  deleteCallOffSourceFiles,
  getCallOffSourceFilePath,
  getCallOffUnmatchedReportPath,
  isCallOffUnmatchedReportAvailable,
  saveCallOffSourceFile,
  saveCallOffUnmatchedReport,
} from './callOffFileService.js';
import {
  detectSalesFcstDateRange,
  parseSalesFcstWorkbook,
  normalizeSalesFcstSapRef,
  truncateSapRefLastTwo,
} from './salesFcstImportService.js';

export type CallOffUnmatchedSapRow = {
  sap_ref: string;
  row_count: number;
  total_quantity: number;
};

export type CallOffImportResult = {
  imported: number;
  skippedOutOfRange: number;
  skippedInvalid: number;
  unmatchedSap: number;
  matchedExact: number;
  matchedTruncated: number;
  unmatchedReport: CallOffUnmatchedSapRow[];
};

type SapPartLookup = {
  resolve(sapRef: string): { partIds: number[]; match: 'exact' | 'truncated' } | null;
};

function addPartId(map: Map<string, number[]>, key: string, partId: number): void {
  const list = map.get(key) ?? [];
  if (!list.includes(partId)) list.push(partId);
  map.set(key, list);
}

function buildSapPartLookup(): SapPartLookup {
  const rows = db
    .prepare(
      `SELECT p.id AS part_id, d.sap_number
       FROM parts p
       JOIN part_designations d ON d.id = p.designation_id
       WHERE d.sap_number IS NOT NULL AND TRIM(d.sap_number) <> ''`
    )
    .all() as { part_id: number; sap_number: string }[];

  const exactMap = new Map<string, number[]>();
  const truncMap = new Map<string, number[]>();

  for (const r of rows) {
    const full = normalizeSalesFcstSapRef(r.sap_number);
    if (!full || full === '0') continue;
    const partId = Number(r.part_id);
    addPartId(exactMap, full, partId);
    const trunc = truncateSapRefLastTwo(full);
    if (trunc) addPartId(truncMap, trunc, partId);
  }

  return {
    resolve(sapRef: string) {
      const norm = normalizeSalesFcstSapRef(sapRef);
      const exact = exactMap.get(norm);
      if (exact?.length) return { partIds: exact, match: 'exact' as const };
      const trunc = truncateSapRefLastTwo(norm);
      if (trunc) {
        const byTrunc = truncMap.get(trunc);
        if (byTrunc?.length) return { partIds: byTrunc, match: 'truncated' as const };
      }
      return null;
    },
  };
}

export type CallOffComparisonRow = {
  id: number;
  name: string;
  date_from: string;
  date_to: string;
  notes: string | null;
  source_filename: string | null;
  source_stored_filename: string | null;
  last_import_json: string | null;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  volume_row_count?: number;
};

export function isCallOffArchived(row: Pick<CallOffComparisonRow, 'archived_at'>): boolean {
  return row.archived_at != null && String(row.archived_at).trim() !== '';
}

export function assertCallOffNotArchived(row: Pick<CallOffComparisonRow, 'archived_at'>, message: string): void {
  if (isCallOffArchived(row)) throw new Error(message);
}

export type CallOffLastImport = CallOffImportResult;

export function parseCallOffLastImport(raw: string | null | undefined): CallOffLastImport | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as CallOffLastImport;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.unmatchedReport)) parsed.unmatchedReport = [];
    return parsed;
  } catch {
    return null;
  }
}

export function isCallOffSourceFileAvailable(row: Pick<CallOffComparisonRow, 'id' | 'source_stored_filename'>): boolean {
  if (!row.source_stored_filename?.trim()) return false;
  return getCallOffSourceFilePath(row.id, row.source_stored_filename) != null;
}

export function ensureCallOffUnmatchedReportFile(
  comparisonId: number,
  lastImport: CallOffLastImport | null
): boolean {
  if (!lastImport) return false;
  if (isCallOffUnmatchedReportAvailable(comparisonId)) return true;
  saveCallOffUnmatchedReport(comparisonId, lastImport.unmatchedReport ?? []);
  return getCallOffUnmatchedReportPath(comparisonId) != null;
}

export function listCallOffComparisons(options?: { archived?: boolean }): CallOffComparisonRow[] {
  const wantArchived = options?.archived === true;
  const clause = wantArchived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL';
  const order = wantArchived
    ? 'datetime(c.archived_at) DESC, datetime(c.updated_at) DESC, c.id DESC'
    : 'datetime(c.updated_at) DESC, c.id DESC';
  try {
    return db
      .prepare(
        `SELECT c.*, (
         SELECT COUNT(*) FROM call_off_volumes v WHERE v.comparison_id = c.id
       ) AS volume_row_count
       FROM call_off_comparisons c
       WHERE ${clause}
       ORDER BY ${order}`
      )
      .all() as CallOffComparisonRow[];
  } catch {
    const rows = db
      .prepare(
        `SELECT c.*, (
         SELECT COUNT(*) FROM call_off_volumes v WHERE v.comparison_id = c.id
       ) AS volume_row_count
       FROM call_off_comparisons c
       ORDER BY datetime(c.updated_at) DESC, c.id DESC`
      )
      .all() as CallOffComparisonRow[];
    if (wantArchived) return [];
    return rows.map((r) => ({ ...r, archived_at: r.archived_at ?? null }));
  }
}

export function archiveCallOffComparison(id: number): void {
  const row = getCallOffComparison(id);
  if (!row) throw new Error('Porównanie Call off nie istnieje');
  db.prepare(`UPDATE call_off_comparisons SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  saveDb();
}

export function unarchiveCallOffComparison(id: number): void {
  const row = getCallOffComparison(id);
  if (!row) throw new Error('Porównanie Call off nie istnieje');
  db.prepare(`UPDATE call_off_comparisons SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  saveDb();
}

export function getCallOffComparison(id: number): CallOffComparisonRow | undefined {
  return db
    .prepare(
      `SELECT c.*, (
         SELECT COUNT(*) FROM call_off_volumes v WHERE v.comparison_id = c.id
       ) AS volume_row_count
       FROM call_off_comparisons c WHERE c.id = ?`
    )
    .get(id) as CallOffComparisonRow | undefined;
}

export function createCallOffComparison(
  name: string,
  dateFrom: string,
  dateTo: string,
  notes?: string | null
): CallOffComparisonRow {
  const notesVal = notes?.trim() ? notes.trim() : null;
  const r = db
    .prepare(`INSERT INTO call_off_comparisons (name, date_from, date_to, notes) VALUES (?, ?, ?, ?)`)
    .run(name.trim(), dateFrom, dateTo, notesVal);
  const id = Number(r.lastInsertRowid);
  saveDb();
  return getCallOffComparison(id)!;
}

/** Tworzy porównanie z zakresem dat wyliczonym z pliku SalesFcst i od razu importuje dane. */
export function createCallOffComparisonWithImport(
  name: string,
  notes: string | null | undefined,
  buffer: Buffer,
  filename: string
): { comparison: CallOffComparisonRow; import: CallOffImportResult } {
  const range = detectSalesFcstDateRange(buffer);
  const created = createCallOffComparison(name, range.dateFrom, range.dateTo, notes);
  const importResult = importSalesFcstFile(created.id, buffer, filename);
  return { comparison: getCallOffComparison(created.id)!, import: importResult };
}

export function deleteCallOffComparison(id: number): void {
  deleteCallOffSourceFiles(id);
  db.prepare('DELETE FROM call_off_volumes WHERE comparison_id = ?').run(id);
  db.prepare('DELETE FROM call_off_comparisons WHERE id = ?').run(id);
  saveDb();
}

export function importSalesFcstFile(
  comparisonId: number,
  buffer: Buffer,
  filename: string
): CallOffImportResult {
  const cmp = getCallOffComparison(comparisonId);
  if (!cmp) throw new Error('Porównanie Call off nie istnieje');
  assertCallOffNotArchived(cmp, 'Porównanie jest zarchiwizowane — import wyłączony.');

  const { rows, skippedOutOfRange, skippedInvalid } = parseSalesFcstWorkbook(buffer, cmp.date_from, cmp.date_to);
  const sapLookup = buildSapPartLookup();

  db.prepare('DELETE FROM call_off_volumes WHERE comparison_id = ?').run(comparisonId);

  const insert = db.prepare(
    `INSERT INTO call_off_volumes (comparison_id, sap_ref, part_id, volume_date, year, month, week, quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let imported = 0;
  let matchedExact = 0;
  let matchedTruncated = 0;
  const unmatchedStats = new Map<string, { row_count: number; total_quantity: number }>();

  for (const row of rows) {
    const resolved = sapLookup.resolve(row.sap_ref);
    if (!resolved) {
      const stat = unmatchedStats.get(row.sap_ref) ?? { row_count: 0, total_quantity: 0 };
      stat.row_count += 1;
      stat.total_quantity += row.quantity;
      unmatchedStats.set(row.sap_ref, stat);
      insert.run(comparisonId, row.sap_ref, null, row.volume_date, row.year, row.month, row.week, row.quantity);
    } else {
      if (resolved.match === 'exact') matchedExact += 1;
      else matchedTruncated += 1;
      for (const partId of resolved.partIds) {
        insert.run(comparisonId, row.sap_ref, partId, row.volume_date, row.year, row.month, row.week, row.quantity);
      }
    }
    imported++;
  }

  const unmatchedReport = [...unmatchedStats.entries()]
    .map(([sap_ref, s]) => ({
      sap_ref,
      row_count: s.row_count,
      total_quantity: Math.round(s.total_quantity * 1000) / 1000,
    }))
    .sort((a, b) => a.sap_ref.localeCompare(b.sap_ref, undefined, { numeric: true }));

  const storedFilename = saveCallOffSourceFile(comparisonId, buffer, filename);
  saveCallOffUnmatchedReport(comparisonId, unmatchedReport);

  const importResult: CallOffImportResult = {
    imported,
    skippedOutOfRange,
    skippedInvalid,
    unmatchedSap: unmatchedReport.length,
    matchedExact,
    matchedTruncated,
    unmatchedReport,
  };

  db.prepare(
    `UPDATE call_off_comparisons
     SET source_filename = ?, source_stored_filename = ?, last_import_json = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(filename, storedFilename, JSON.stringify(importResult), comparisonId);
  saveDb();

  return importResult;
}

export type CallOffVolumeMaps = {
  annual: Map<number, Map<number, number>>;
  monthly: Map<number, Map<number, Map<number, number>>>;
  /** Tydzień w miesiącu (T1 = pierwszy tydzień pn–nd w miesiącu) — zgodnie z rozwinięciem w kalkulatorze. */
  weekly: Map<number, Map<number, Map<number, Map<number, number>>>>;
};

/** Roczny wolumen per part_id z pliku SAP (suma Corr.qty). */
export function loadCallOffAnnualVolumeByPart(comparisonId: number): Map<number, Map<number, number>> {
  return loadCallOffVolumeMaps(comparisonId).annual;
}

/** Wolumeny roczne, miesięczne i tygodniowe (w miesiącu) per part_id z pliku SAP. */
export function loadCallOffVolumeMaps(comparisonId: number): CallOffVolumeMaps {
  const annualRows = db
    .prepare(
      `SELECT part_id, year, SUM(quantity) AS qty
       FROM call_off_volumes
       WHERE comparison_id = ? AND part_id IS NOT NULL
       GROUP BY part_id, year`
    )
    .all(comparisonId) as { part_id: number; year: number; qty: number }[];

  const monthlyRows = db
    .prepare(
      `SELECT part_id, year, month, SUM(quantity) AS qty
       FROM call_off_volumes
       WHERE comparison_id = ? AND part_id IS NOT NULL
       GROUP BY part_id, year, month`
    )
    .all(comparisonId) as { part_id: number; year: number; month: number; qty: number }[];

  const dailyRows = db
    .prepare(
      `SELECT part_id, year, month, volume_date, SUM(quantity) AS qty
       FROM call_off_volumes
       WHERE comparison_id = ? AND part_id IS NOT NULL
       GROUP BY part_id, year, month, volume_date`
    )
    .all(comparisonId) as { part_id: number; year: number; month: number; volume_date: string; qty: number }[];

  const annual = new Map<number, Map<number, number>>();
  for (const r of annualRows) {
    const partId = Number(r.part_id);
    const year = Number(r.year);
    if (!annual.has(partId)) annual.set(partId, new Map());
    annual.get(partId)!.set(year, Number(r.qty) || 0);
  }

  const monthly = new Map<number, Map<number, Map<number, number>>>();
  for (const r of monthlyRows) {
    const partId = Number(r.part_id);
    const year = Number(r.year);
    const month = Number(r.month);
    if (!monthly.has(partId)) monthly.set(partId, new Map());
    const byYear = monthly.get(partId)!;
    if (!byYear.has(year)) byYear.set(year, new Map());
    byYear.get(year)!.set(month, Number(r.qty) || 0);
  }

  const weekly = new Map<number, Map<number, Map<number, Map<number, number>>>>();
  for (const r of dailyRows) {
    const partId = Number(r.part_id);
    const year = Number(r.year);
    const month = Number(r.month);
    const day = Number(String(r.volume_date ?? '').slice(8, 10));
    // Cały wolumen tygodnia → miesiąc, w którym tydzień się zaczyna (poniedziałek).
    const home = assignIsoWeekToStartMonth(year, month, Number.isFinite(day) && day > 0 ? day : 1);
    const qty = Number(r.qty) || 0;
    if (!weekly.has(partId)) weekly.set(partId, new Map());
    const byYear = weekly.get(partId)!;
    if (!byYear.has(home.year)) byYear.set(home.year, new Map());
    const byMonth = byYear.get(home.year)!;
    if (!byMonth.has(home.month)) byMonth.set(home.month, new Map());
    const byWeek = byMonth.get(home.month)!;
    byWeek.set(home.week, (byWeek.get(home.week) ?? 0) + qty);
  }

  return { annual, monthly, weekly };
}

export function getCallOffVolumeStats(comparisonId: number) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS row_count,
              COUNT(DISTINCT sap_ref) AS sap_count,
              COUNT(DISTINCT part_id) AS part_count,
              MIN(volume_date) AS min_date,
              MAX(volume_date) AS max_date
       FROM call_off_volumes WHERE comparison_id = ?`
    )
    .get(comparisonId) as {
    row_count: number;
    sap_count: number;
    part_count: number;
    min_date: string | null;
    max_date: string | null;
  };
  return row;
}

/** Lata, w których porównanie ma jakikolwiek wolumen SAP (z pliku). */
export function getCallOffVolumeYears(comparisonId: number): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT year
       FROM call_off_volumes
       WHERE comparison_id = ? AND part_id IS NOT NULL AND year IS NOT NULL
       ORDER BY year`
    )
    .all(comparisonId) as { year: number }[];
  return rows
    .map((r) => Number(r.year))
    .filter((y) => Number.isFinite(y) && y >= 2000 && y <= 2100);
}

/** Zakres miesięcy (1–12) z danymi SAP w danym roku — min…max po wszystkich detalach. */
export function getSapMonthRangeForYear(
  volumes: CallOffVolumeMaps,
  year: number
): { from: number; to: number } | null {
  let from = 13;
  let to = 0;
  for (const byYear of volumes.monthly.values()) {
    const mMap = byYear.get(year);
    if (!mMap) continue;
    for (const [month, qty] of mMap) {
      const m = Number(month);
      if (!Number.isFinite(m) || m < 1 || m > 12) continue;
      if (!(Number(qty) > 0)) continue;
      if (m < from) from = m;
      if (m > to) to = m;
    }
  }
  if (from > to) return null;
  return { from, to };
}

/** Zakres tygodni w miesiącu z danymi SAP — min…max. */
export function getSapWeekRangeForMonth(
  volumes: CallOffVolumeMaps,
  year: number,
  month: number
): { from: number; to: number } | null {
  let from = 99;
  let to = 0;
  for (const byYear of volumes.weekly.values()) {
    const byMonth = byYear.get(year);
    if (!byMonth) continue;
    const byWeek = byMonth.get(month);
    if (!byWeek) continue;
    for (const [week, qty] of byWeek) {
      const w = Number(week);
      if (!Number.isFinite(w) || w < 1) continue;
      if (!(Number(qty) > 0)) continue;
      if (w < from) from = w;
      if (w > to) to = w;
    }
  }
  if (from > to) return null;
  return { from, to };
}

/** Średnia arytmetyczna % (zaokrąglenie jak load_percent). */
export function averageLoadPercent(values: number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += Number.isFinite(v) ? v : 0;
  return Math.round(sum / values.length);
}
