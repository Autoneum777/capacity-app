import * as XLSX from 'xlsx';
import { db } from '../db/connection.js';
import { getProductionMonthsInYear } from '../utils/sopEopFormat.js';
import {
  inflateZipEntry,
  readZipEntries,
  rewriteZipEntries,
  rewriteZipEntriesFiltered,
} from '../utils/zipEntryRewrite.js';
import {
  baseQtyForMaterial,
  componentsWithCodeDeep,
  materialCellValue,
  parseSapRoutingBuffer,
  splitS2102ByFormatka,
  type SapRoutingComponent,
  type SapRoutingIndex,
} from './sapRoutingParser.js';
import { readWorkbookBufferWithOptionalPassword } from '../utils/excelPasswordUnlock.js';
import {
  applyHeaderHintsToColumnLetters,
  DEFAULT_OCU_COLUMN_LETTERS,
  excelLetterFromColIndex0,
  mergeOcuColumnLetters,
  type OcuColumnLetters,
} from './ocuColumnMapping.js';

export type { OcuColumnLetters } from './ocuColumnMapping.js';
export {
  DEFAULT_OCU_COLUMN_LETTERS,
  OCU_COLUMN_FIELD_META,
  shiftOcuColumnsAfterLetter,
} from './ocuColumnMapping.js';

/** Excel 1-based letters → 0-based index. */
export function excelColIndex(letter: string): number {
  const s = String(letter).trim().toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) continue;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** 1-based Excel column number from letter (dla ExcelJS). */
function excelCol1(letter: string): number {
  return excelColIndex(letter) + 1;
}

const TRANSITION = {
  sonar: excelColIndex('B'),
  erp: excelColIndex('C'),
  year: excelColIndex('D'),
} as const;

type InputColMap = {
  year: number;
  sonarCode: number;
  x: number;
  ab: number;
  ac: number;
  ad: number;
  ae: number;
};

function normKey(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    // unikaj notacji naukowej / ułamków z Excela
    if (Number.isInteger(v) || Math.abs(v - Math.trunc(v)) < 1e-9) return String(Math.trunc(v));
    return String(v);
  }
  let s = String(v).trim();
  if (!s) return '';
  // sap z importu często jako "106616040102.0"
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(Math.trunc(n));
  }
  return s;
}

/** Klucz porównawczy SAP/ERP (bez .0 i spacji). */
function normSapKey(v: unknown): string {
  return normKey(v).replace(/\s+/g, '').replace(/\.0+$/, '');
}

function asYear(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const y = Math.trunc(v);
    return y >= 1900 && y <= 2200 ? y : null;
  }
  const m = String(v).trim().match(/^(19|20|21)\d{2}/);
  if (!m) return null;
  const y = Number(m[0]);
  return y >= 1900 && y <= 2200 ? y : null;
}

type TransitionRow = { sonar: string; erp: string; year: number };

function parseTransitionSheet(buffer: Buffer): TransitionRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Tabela przejścia: brak arkusza.');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null }) as unknown[][];
  if (!rows.length) throw new Error('Tabela przejścia: pusty plik.');
  const out: TransitionRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const sonar = normKey(row[TRANSITION.sonar]);
    const erp = normSapKey(row[TRANSITION.erp]);
    const year = asYear(row[TRANSITION.year]);
    if (!sonar || year == null) continue;
    out.push({ sonar: normKey(sonar), erp, year });
  }
  if (!out.length) throw new Error('Tabela przejścia: nie znaleziono wierszy z Sonar Part Code i rokiem.');
  return out;
}

/** 1-based column number → Excel letters (1=A … 24=X … 28=AB). */
function colLetterFrom1(col1: number): string {
  let n = col1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inputColsFromLetters(letters: OcuColumnLetters): InputColMap {
  return {
    year: excelCol1(letters.year),
    sonarCode: excelCol1(letters.sonarCode),
    x: excelCol1(letters.x),
    ab: excelCol1(letters.ab),
    ac: excelCol1(letters.ac),
    ad: excelCol1(letters.ad),
    ae: excelCol1(letters.ae),
  };
}

/**
 * Buduje mapę kolumn capacity z liter użytkownika.
 * Gdy `preferHeaderDetect` i brak jawnego override — Sonar/Year z nagłówków.
 */
function resolveInputColumns(
  headerRow: unknown[],
  letters: OcuColumnLetters,
  options?: { preferHeaderDetect?: boolean }
): InputColMap {
  const cols = inputColsFromLetters(letters);
  if (!options?.preferHeaderDetect) return cols;

  // Auto-detect tylko gdy litery odczytu = domyślne (użytkownik jeszcze nie przesunął).
  const defaults = DEFAULT_OCU_COLUMN_LETTERS;
  const yearIsDefault = letters.year.toUpperCase() === defaults.year;
  const sonarIsDefault = letters.sonarCode.toUpperCase() === defaults.sonarCode;
  if (!yearIsDefault && !sonarIsDefault) return cols;

  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] ?? '')
      .trim()
      .toLowerCase();
    if (!h) continue;
    if (sonarIsDefault && (h === 'sonar part code' || h.includes('sonar part code'))) {
      cols.sonarCode = i + 1;
    }
    if (yearIsDefault && (h === 'date year' || h.includes('date year'))) {
      cols.year = i + 1;
    }
  }
  return cols;
}

function findInputHeaderRow(rows: unknown[][]): { headerRowNum: number; header: unknown[] } {
  const maxScan = Math.min(25, rows.length);
  for (let i = 0; i < maxScan; i++) {
    const header = rows[i] ?? [];
    const hasSonar = header.some((c) =>
      String(c ?? '')
        .toLowerCase()
        .includes('sonar part code')
    );
    if (!hasSonar) continue;
    return { headerRowNum: i + 1, header };
  }
  throw new Error('Katowice_Data / Input: nie znaleziono wiersza nagłówka (Sonar Part Code).');
}

function findInputSheetMatrix(
  buffer: Buffer,
  letters: OcuColumnLetters
): { rows: unknown[][]; headerRowNum: number; cols: InputColMap; header: unknown[] } {
  const wb = XLSX.read(buffer, { type: 'buffer', sheets: ['Input'], cellDates: true });
  const sheet = wb.Sheets['Input'];
  if (!sheet) throw new Error('Katowice_Data: nie znaleziono arkusza „Input”.');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as unknown[][];
  if (!rows.length) throw new Error('Katowice_Data / Input: pusty arkusz.');

  const { headerRowNum, header } = findInputHeaderRow(rows);
  const cols = resolveInputColumns(header, letters, { preferHeaderDetect: true });
  return { rows, headerRowNum, cols, header };
}

/** Blok Opt1bxx / Opt2bxx (S2102) — litery z mapowania (domyślnie CR–DC / DD–DO). */
type S2102BlockCols = {
  machineGroup: string;
  costCenter: string;
  capacity: string;
  oeeActual: string;
  oeeTarget: string;
  erpNo: string;
  cavities: string;
  unitPerHour: string;
  lanes: string;
  moulded: string;
  length: string;
  width: string;
};

function buildS2102BlocksFromLetters(letters: OcuColumnLetters): {
  large: S2102BlockCols;
  small: S2102BlockCols;
} {
  return {
    large: {
      machineGroup: letters.s2102LargeMachineGroup,
      costCenter: letters.s2102LargeCostCenter,
      capacity: letters.s2102LargeCapacity,
      oeeActual: letters.s2102LargeOeeActual,
      oeeTarget: letters.s2102LargeOeeTarget,
      erpNo: letters.s2102LargeErpNo,
      cavities: letters.s2102LargeCavities,
      unitPerHour: letters.s2102LargeUnitPerHour,
      lanes: letters.s2102LargeLanes,
      moulded: letters.s2102LargeMoulded,
      length: letters.s2102LargeLength,
      width: letters.s2102LargeWidth,
    },
    small: {
      machineGroup: letters.s2102SmallMachineGroup,
      costCenter: letters.s2102SmallCostCenter,
      capacity: letters.s2102SmallCapacity,
      oeeActual: letters.s2102SmallOeeActual,
      oeeTarget: letters.s2102SmallOeeTarget,
      erpNo: letters.s2102SmallErpNo,
      cavities: letters.s2102SmallCavities,
      unitPerHour: letters.s2102SmallUnitPerHour,
      lanes: letters.s2102SmallLanes,
      moulded: letters.s2102SmallMoulded,
      length: letters.s2102SmallLength,
      width: letters.s2102SmallWidth,
    },
  };
}

export type OcuInputHeaderPreview = {
  headerRowNum: number;
  headers: { letter: string; header: string; col1: number }[];
  suggested: OcuColumnLetters;
};

/** Podgląd nagłówków arkusza Input — do mapowania kolumn w UI. */
export async function previewKatowiceInputHeaders(
  katowiceBuffer: Buffer,
  options?: { katowicePassword?: string | null; columnMapping?: Partial<OcuColumnLetters> | null }
): Promise<OcuInputHeaderPreview> {
  const katowiceUnlocked = await readWorkbookBufferWithOptionalPassword(
    katowiceBuffer,
    options?.katowicePassword,
    'Katowice_Data'
  );
  const wb = XLSX.read(katowiceUnlocked, { type: 'buffer', sheets: ['Input'], cellDates: true });
  const sheet = wb.Sheets['Input'];
  if (!sheet) throw new Error('Katowice_Data: nie znaleziono arkusza „Input”.');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as unknown[][];
  if (!rows.length) throw new Error('Katowice_Data / Input: pusty arkusz.');

  const { headerRowNum, header } = findInputHeaderRow(rows);
  const headers: OcuInputHeaderPreview['headers'] = [];
  for (let i = 0; i < header.length; i++) {
    const text = String(header[i] ?? '').trim();
    if (!text) continue;
    headers.push({
      letter: excelLetterFromColIndex0(i),
      header: text,
      col1: i + 1,
    });
  }

  const base = mergeOcuColumnLetters(options?.columnMapping);
  const suggested = applyHeaderHintsToColumnLetters(headers, base);
  return { headerRowNum, headers, suggested };
}

type DbDetailProfile = {
  /** nests dla AC: pojedyncza liczba lub lista składowych setu */
  nestsParts: number[];
  /** AE — liczba gniazd (nie suma AC; np. AC „2+2” → AE 2) */
  nestsCount: number;
  /** max cykl [s] ze wszystkich operacji detalu */
  maxCycleSeconds: number | null;
  /** linia (machines.location) → „waga” w roku (miesiące produkcji / wolumen) */
  lineWeightByYear: Map<number, Map<string, number>>;
};

function nestsCountFromParts(parts: number[]): number {
  if (!parts.length) return 0;
  return Math.max(...parts.map((n) => Number(n) || 0));
}

function loadDetailProfilesBySap(yearsNeeded: number[]): Map<string, DbDetailProfile> {
  const years = yearsNeeded.length ? [...new Set(yearsNeeded)].sort((a, b) => a - b) : [];
  if (!years.length) {
    const y = new Date().getFullYear();
    years.push(y);
  }
  const map = new Map<string, DbDetailProfile>();

  type OpRow = {
    operation_id: number;
    sap_number: string | null;
    nests_count: number;
    cycle_time_seconds: number | null;
    alt_cycle_time_seconds: number | null;
    is_set: number;
    line_number: string | null;
    sop: string | null;
    eop: string | null;
  };

  const opRows = db
    .prepare(
      `SELECT
         o.id AS operation_id,
         pd.sap_number AS sap_number,
         COALESCE(o.nests_count, 1) AS nests_count,
         o.cycle_time_seconds AS cycle_time_seconds,
         o.alt_cycle_time_seconds AS alt_cycle_time_seconds,
         COALESCE(o.is_set, 0) AS is_set,
         m.location AS line_number,
         p.sop AS sop,
         p.eop AS eop
       FROM operations o
       JOIN parts pt ON pt.id = o.part_id
       LEFT JOIN part_designations pd ON pd.id = pt.designation_id
       LEFT JOIN machines m ON m.id = o.machine_id
       LEFT JOIN projects p ON p.id = pt.project_id
       WHERE pd.sap_number IS NOT NULL AND TRIM(pd.sap_number) != ''`
    )
    .all() as OpRow[];

  const setMemberRows = db
    .prepare(
      `SELECT osm.operation_id AS operation_id, COALESCE(o.nests_count, 1) AS nests_count, pd.sap_number AS member_sap
       FROM operation_set_members osm
       JOIN operations o ON o.id = osm.operation_id
       JOIN parts pt ON pt.id = osm.part_id
       LEFT JOIN part_designations pd ON pd.id = pt.designation_id
       ORDER BY osm.operation_id, osm.part_id`
    )
    .all() as { operation_id: number; nests_count: number; member_sap: string | null }[];

  const membersByOp = new Map<number, number[]>();
  const setOpsByMemberSap = new Map<string, number[]>();
  for (const row of setMemberRows) {
    const list = membersByOp.get(row.operation_id) ?? [];
    list.push(Number(row.nests_count) || 1);
    membersByOp.set(row.operation_id, list);
    const ms = normSapKey(row.member_sap);
    if (!ms) continue;
    const ops = setOpsByMemberSap.get(ms) ?? [];
    ops.push(row.operation_id);
    setOpsByMemberSap.set(ms, ops);
  }

  const volumes = db
    .prepare(`SELECT operation_id, year, volume_value FROM operation_volume_by_year`)
    .all() as { operation_id: number; year: number; volume_value: number }[];
  const volByOpYear = new Map<string, number>();
  for (const v of volumes) {
    volByOpYear.set(`${v.operation_id}|${v.year}`, Number(v.volume_value) || 0);
  }

  const ensure = (sap: string): DbDetailProfile => {
    let p = map.get(sap);
    if (!p) {
      p = {
        nestsParts: [],
        nestsCount: 0,
        maxCycleSeconds: null,
        lineWeightByYear: new Map(),
      };
      map.set(sap, p);
    }
    return p;
  };

  const addCycle = (p: DbDetailProfile, cycle: number | null | undefined, alt: number | null | undefined) => {
    for (const c of [cycle, alt]) {
      const n = Number(c);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (p.maxCycleSeconds == null || n > p.maxCycleSeconds) p.maxCycleSeconds = n;
    }
  };

  const addLineWeight = (p: DbDetailProfile, year: number, line: string, weight: number) => {
    if (!line || weight <= 0) return;
    let byLine = p.lineWeightByYear.get(year);
    if (!byLine) {
      byLine = new Map();
      p.lineWeightByYear.set(year, byLine);
    }
    byLine.set(line, (byLine.get(line) ?? 0) + weight);
  };

  // Operacje setów — indeks po id, żeby member SAP dostał ten sam profil linii/cyklu
  const setOpMeta = new Map<number, OpRow>();

  for (const op of opRows) {
    const sap = normSapKey(op.sap_number);
    if (!sap) continue;
    const p = ensure(sap);
    addCycle(p, op.cycle_time_seconds, op.alt_cycle_time_seconds);

    if (Number(op.is_set) === 1) {
      setOpMeta.set(op.operation_id, op);
      const parts = membersByOp.get(op.operation_id);
      if (parts?.length && p.nestsParts.length === 0) {
        p.nestsParts = [...parts];
        p.nestsCount = nestsCountFromParts(parts);
      }
    } else if (p.nestsParts.length === 0) {
      const n = Number(op.nests_count) || 1;
      p.nestsParts = [n];
      p.nestsCount = n;
    } else {
      // wiele operacji tego samego SAP — bierz max gniazd / zachowaj pierwszą listę
      const n = Number(op.nests_count) || 1;
      if (p.nestsParts.length === 1 && n > p.nestsParts[0]) {
        p.nestsParts = [n];
        p.nestsCount = n;
      }
    }

    const line = normKey(op.line_number);
    // Waga: miesiące SOP–EOP w roku; fallback: wolumen roczny
    for (const year of years) {
      let w = getProductionMonthsInYear(op.sop ?? '', op.eop ?? '', year);
      if (w <= 0) {
        const vol = volByOpYear.get(`${op.operation_id}|${year}`) ?? 0;
        w = vol > 0 ? vol : 0;
      }
      if (w > 0 && line) addLineWeight(p, year, line, w);
    }
  }

  // Detale występujące tylko jako członkowie setu (bez własnej operacji-kotwicy)
  for (const [memberSap, opIds] of setOpsByMemberSap) {
    const p = ensure(memberSap);
    for (const opId of opIds) {
      const op = setOpMeta.get(opId);
      if (!op) continue;
      addCycle(p, op.cycle_time_seconds, op.alt_cycle_time_seconds);
      if (p.nestsParts.length === 0) {
        const parts = membersByOp.get(opId) ?? [Number(op.nests_count) || 1];
        p.nestsParts = [...parts];
        p.nestsCount = nestsCountFromParts(parts);
      }
      const line = normKey(op.line_number);
      for (const year of years) {
        let w = getProductionMonthsInYear(op.sop ?? '', op.eop ?? '', year);
        if (w <= 0) {
          const vol = volByOpYear.get(`${opId}|${year}`) ?? 0;
          w = vol > 0 ? vol : 0;
        }
        if (w > 0 && line) addLineWeight(p, year, line, w);
      }
    }
  }

  return map;
}

/**
 * Ostatnie 2 cyfry SAP = rewizja detalu.
 * Stem (bez rewizji) — dopasowanie operacji w Capacity, gdy dokładny ERP z Tabeli przejścia
 * nie ma operacji / nie istnieje w bazie.
 */
function sapRevisionStem(sap: string): string | null {
  const s = normSapKey(sap);
  if (s.length < 4 || !/\d{2}$/.test(s)) return null;
  return s.slice(0, -2);
}

function profileOperationScore(p: DbDetailProfile): number {
  let score = 0;
  if (p.lineWeightByYear.size > 0) score += 1000;
  if (p.nestsParts.length > 0) score += 50;
  if (p.maxCycleSeconds != null && p.maxCycleSeconds > 0) score += 20;
  for (const byLine of p.lineWeightByYear.values()) {
    for (const w of byLine.values()) score += Math.min(Number(w) || 0, 100);
  }
  return score;
}

function profileHasDescribedOperation(p: DbDetailProfile | undefined): boolean {
  if (!p) return false;
  return (
    p.lineWeightByYear.size > 0 ||
    p.nestsParts.length > 0 ||
    (p.maxCycleSeconds != null && p.maxCycleSeconds > 0)
  );
}

/**
 * Profil Capacity dla ERP z przejścia: najpierw dokładny numer,
 * potem inna rewizja (te same cyfry poza ostatnimi dwoma) z opisanymi operacjami.
 */
function resolveDetailProfileByErp(
  profiles: Map<string, DbDetailProfile>,
  erp: string
): { profile: DbDetailProfile; matchedSap: string } | null {
  const key = normSapKey(erp);
  if (!key) return null;

  const exact = profiles.get(key);
  if (exact && profileHasDescribedOperation(exact)) {
    return { profile: exact, matchedSap: key };
  }

  const stem = sapRevisionStem(key);
  if (stem) {
    let bestSap: string | null = null;
    let best: DbDetailProfile | null = null;
    let bestScore = 0;
    let bestRevDist = Number.POSITIVE_INFINITY;
    const wantRev = Number(key.slice(-2));

    for (const [sap, p] of profiles) {
      if (sap === key) continue;
      if (sapRevisionStem(sap) !== stem) continue;
      if (!profileHasDescribedOperation(p)) continue;
      const score = profileOperationScore(p);
      const rev = Number(sap.slice(-2));
      const revDist = Number.isFinite(wantRev) && Number.isFinite(rev) ? Math.abs(wantRev - rev) : 999;
      if (
        score > bestScore ||
        (score === bestScore && revDist < bestRevDist) ||
        (score === bestScore && revDist === bestRevDist && (bestSap == null || sap < bestSap))
      ) {
        bestScore = score;
        bestRevDist = revDist;
        best = p;
        bestSap = sap;
      }
    }
    if (best && bestSap) return { profile: best, matchedSap: bestSap };
  }

  if (exact) return { profile: exact, matchedSap: key };
  return null;
}

/** Linia 999 w Capacity = placeholder (np. maszyna pomocnicza HT) — nie używaj do kolumny X w OCU, gdy jest realna linia. */
const OCU_PLACEHOLDER_LINE = '999';

function isOcuPlaceholderLine(line: string): boolean {
  return normKey(line) === OCU_PLACEHOLDER_LINE;
}

function pickBestLineFromWeights(byLine: Map<string, number>): string | null {
  const real = new Map<string, number>();
  const placeholders = new Map<string, number>();
  for (const [line, w] of byLine) {
    if (w <= 0 || !line) continue;
    if (isOcuPlaceholderLine(line)) placeholders.set(line, w);
    else real.set(line, w);
  }
  const pool = real.size > 0 ? real : placeholders;
  let best: string | null = null;
  let bestW = -1;
  for (const [line, w] of pool) {
    if (w > bestW) {
      bestW = w;
      best = line;
    }
  }
  return best;
}

function pickLineForYear(profile: DbDetailProfile | undefined, year: number | null): string | null {
  if (!profile || year == null) return null;
  const byLine = profile.lineWeightByYear.get(year);
  if (byLine && byLine.size > 0) {
    const picked = pickBestLineFromWeights(byLine);
    if (picked) return picked;
  }
  // fallback: dowolna linia z dowolnego roku (największa waga łącznie; 999 na końcu)
  const totals = new Map<string, number>();
  for (const m of profile.lineWeightByYear.values()) {
    for (const [line, w] of m) totals.set(line, (totals.get(line) ?? 0) + w);
  }
  return pickBestLineFromWeights(totals);
}

/** Wartości „pustego” wiersza technologii — zawsze 0 (nie „-”). */
function clearTechPlaceholder(cellUpdates: Map<string, string | number>, excelRow: number, col: string): void {
  cellUpdates.set(`${col}${excelRow}`, 0);
}

function clearS2102Block(cellUpdates: Map<string, string | number>, excelRow: number, block: S2102BlockCols): void {
  for (const col of Object.values(block)) {
    clearTechPlaceholder(cellUpdates, excelRow, col);
  }
}

function writeRoutingErpNo(
  cellUpdates: Map<string, string | number>,
  excelRow: number,
  colLetter: string,
  materials: { materialNumber: string }[],
  machineGroupCol: string
): number {
  const mat = materials[0];
  if (mat?.materialNumber) {
    cellUpdates.set(`${colLetter}${excelRow}`, materialCellValue(mat.materialNumber));
    return 1;
  }
  cellUpdates.set(`${colLetter}${excelRow}`, 0);
  clearTechPlaceholder(cellUpdates, excelRow, machineGroupCol);
  return 0;
}

/**
 * S2102: CW/DI + wymiary + Base Qty; przy braku materiału czyści cały blok CR–DC / DD–DO
 * (usuwa m.in. opis HL / B03_Heavy Layer z Machinegroup).
 */
function writeS2102Block(
  cellUpdates: Map<string, string | number>,
  excelRow: number,
  block: S2102BlockCols,
  materials: SapRoutingComponent[],
  routingIndex: SapRoutingIndex
): number {
  const mat = materials[0];
  if (!mat?.materialNumber) {
    clearS2102Block(cellUpdates, excelRow, block);
    return 0;
  }
  cellUpdates.set(`${block.erpNo}${excelRow}`, materialCellValue(mat.materialNumber));
  const baseQty = baseQtyForMaterial(routingIndex, mat.materialNumber);
  cellUpdates.set(`${block.unitPerHour}${excelRow}`, baseQty ?? 0);
  cellUpdates.set(`${block.length}${excelRow}`, mat.length ?? 0);
  cellUpdates.set(`${block.width}${excelRow}`, mat.width ?? 0);
  return 1;
}

export type OcuDataGenerateResult = {
  buffer: Buffer;
  filename: string;
  stats: {
    pivot_rows: number;
    filled_ab: number;
    filled_x: number;
    filled_ac: number;
    filled_ad: number;
    filled_ae: number;
    filled_s1619: number;
    filled_s2102_large: number;
    filled_s2102_small: number;
    unmatched_sonar: number;
    unmatched_erp_in_db: number;
    unmatched_routing: number;
    routing_finished_goods: number;
  };
};

function cellXmlValue(addr: string, value: string | number, styleId?: string): string {
  const sAttr = styleId != null && styleId !== '' ? ` s="${styleId}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${addr}"${sAttr}><v>${value}</v></c>`;
  }
  return `<c r="${addr}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function colIndexFromLetters(letters: string): number {
  let n = 0;
  const s = letters.toUpperCase();
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

/**
 * Wstawia / podmienia komórki w XML arkusza.
 * Zachowuje atrybut stylu s= przy podmianie.
 * Nowe komórki wstawiane są w rosnącej kolejności kolumn (wymóg OOXML) —
 * dopisywanie na końcu wiersza (po CR/CW) powoduje, że Excel ignoruje X/AB/AD/AE.
 */
function applyCellUpdatesToSheetXml(xml: string, updates: Map<string, string | number>): string {
  if (!updates.size) return xml;

  const byRow = new Map<number, Map<string, string | number>>();
  for (const [addr, value] of updates) {
    const m = /^([A-Z]+)(\d+)$/i.exec(addr);
    if (!m) continue;
    const row = Number(m[2]);
    const letter = m[1].toUpperCase();
    let rowMap = byRow.get(row);
    if (!rowMap) {
      rowMap = new Map();
      byRow.set(row, rowMap);
    }
    rowMap.set(letter, value);
  }

  const cellRe = /<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/gi;

  return xml.replace(/<row\b[^>]*>[\s\S]*?<\/row>/gi, (rowXml) => {
    const rm = /\br="(\d+)"/i.exec(rowXml);
    if (!rm) return rowXml;
    const rowNum = Number(rm[1]);
    const rowUpdates = byRow.get(rowNum);
    if (!rowUpdates) return rowXml;

    const openMatch = rowXml.match(/^<row\b[^>]*>/i);
    if (!openMatch) return rowXml;
    let openTag = openMatch[0];
    const closeTag = '</row>';
    const inner = rowXml.slice(openTag.length, rowXml.length - closeTag.length);

    type CellPiece = { letter: string; colIdx: number; xml: string };
    const pieces: CellPiece[] = [];
    let last = 0;
    let prefix = '';
    let suffix = '';
    let firstCellAt = -1;
    let m: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((m = cellRe.exec(inner)) !== null) {
      if (firstCellAt < 0) {
        firstCellAt = m.index;
        prefix = inner.slice(0, m.index);
      }
      const cell = m[0];
      const am = /\br="([A-Z]+)(\d+)"/i.exec(cell);
      if (!am || Number(am[2]) !== rowNum) {
        pieces.push({ letter: '', colIdx: -1, xml: cell });
      } else {
        const letter = am[1].toUpperCase();
        pieces.push({ letter, colIdx: colIndexFromLetters(letter), xml: cell });
      }
      last = m.index + cell.length;
    }
    if (firstCellAt < 0) {
      prefix = inner;
      suffix = '';
    } else {
      suffix = inner.slice(last);
    }

    const pending = new Map(rowUpdates);
    const byLetter = new Map<string, CellPiece>();
    const extras: CellPiece[] = [];
    for (const p of pieces) {
      if (!p.letter) {
        extras.push(p);
        continue;
      }
      if (pending.has(p.letter)) {
        const value = pending.get(p.letter)!;
        pending.delete(p.letter);
        const styleId = /\bs="([^"]+)"/i.exec(p.xml)?.[1];
        byLetter.set(p.letter, {
          letter: p.letter,
          colIdx: p.colIdx,
          xml: cellXmlValue(`${p.letter}${rowNum}`, value, styleId),
        });
      } else {
        byLetter.set(p.letter, p);
      }
    }
    for (const [letter, value] of pending) {
      byLetter.set(letter, {
        letter,
        colIdx: colIndexFromLetters(letter),
        xml: cellXmlValue(`${letter}${rowNum}`, value),
      });
    }

    const sorted = [...byLetter.values()].sort((a, b) => a.colIdx - b.colIdx);
    const allCells = [...extras, ...sorted].map((p) => p.xml).join('');

    if (sorted.length) {
      const minC = sorted[0]!.colIdx;
      const maxC = sorted[sorted.length - 1]!.colIdx;
      if (/\bspans="/i.test(openTag)) {
        openTag = openTag.replace(/\bspans="[^"]*"/i, `spans="${minC}:${maxC}"`);
      } else {
        openTag = openTag.replace(/^<row\b/i, `<row spans="${minC}:${maxC}"`);
      }
    }

    return `${openTag}${prefix}${allCells}${suffix}${closeTag}`;
  });
}

const AUTO_FILTER_BLOCK =
  /<(?:[\w.-]+:)?autoFilter\b[^>]*\/>|<(?:[\w.-]+:)?autoFilter\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?autoFilter>/gi;
const SORT_STATE_BLOCK =
  /<(?:[\w.-]+:)?sortState\b[^>]*\/>|<(?:[\w.-]+:)?sortState\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?sortState>/gi;
const MERGE_CELLS_BLOCK =
  /<(?:[\w.-]+:)?mergeCells\b[^>]*\/>|<(?:[\w.-]+:)?mergeCells\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?mergeCells>/gi;
const SHEET_PROTECTION_BLOCK =
  /<(?:[\w.-]+:)?sheetProtection\b[^>]*\/>|<(?:[\w.-]+:)?sheetProtection\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?sheetProtection>/gi;
const TABLE_PARTS_BLOCK =
  /<(?:[\w.-]+:)?tableParts\b[^>]*\/>|<(?:[\w.-]+:)?tableParts\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?tableParts>/gi;
const PROTECTED_RANGES_BLOCK =
  /<(?:[\w.-]+:)?protectedRanges\b[^>]*\/>|<(?:[\w.-]+:)?protectedRanges\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?protectedRanges>/gi;
const WORKBOOK_PROTECTION_BLOCK =
  /<(?:[\w.-]+:)?workbookProtection\b[^>]*\/>|<(?:[\w.-]+:)?workbookProtection\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?workbookProtection>/gi;
const FILE_SHARING_BLOCK =
  /<(?:[\w.-]+:)?fileSharing\b[^>]*\/>|<(?:[\w.-]+:)?fileSharing\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?fileSharing>/gi;

/** Czyści filtry, ochronę, scalenia i tabele Excel — ułatwia kopiowanie kolumn w wygenerowanym pliku. */
function clearFiltersAndUnhideInXml(xml: string, opts: { isTable?: boolean }): string {
  let out = xml;
  if (opts.isTable) {
    out = out.replace(AUTO_FILTER_BLOCK, (m) => {
      const open = /^(<(?:[\w.-]+:)?autoFilter\b)([^>]*)/i.exec(m);
      if (!open) return '<autoFilter/>';
      // zachowaj atrybuty (ref, xr:uid, …), usuń tylko dzieci (filterColumn)
      const attrs = open[2].replace(/\/\s*$/, '').trim();
      return attrs ? `<autoFilter ${attrs}/>` : `<autoFilter/>`;
    });
    return out;
  }

  out = out.replace(AUTO_FILTER_BLOCK, '');
  out = out.replace(SORT_STATE_BLOCK, '');
  out = out.replace(MERGE_CELLS_BLOCK, '');
  out = out.replace(SHEET_PROTECTION_BLOCK, '');
  out = out.replace(PROTECTED_RANGES_BLOCK, '');
  out = out.replace(TABLE_PARTS_BLOCK, '');
  out = out.replace(/\sfilterMode="1"/gi, '');
  out = out.replace(/\sfilterMode='1'/gi, '');
  out = out.replace(/(<row\b[^>]*?)\s+hidden="1"/gi, '$1');
  out = out.replace(/(<row\b[^>]*?)\s+hidden='1'/gi, '$1');
  return out;
}

/** Usuwa ochronę struktury skoroszytu (blokuje m.in. dodawanie nowych zakładek). */
function stripWorkbookStructureLocks(wbXml: string): string {
  return wbXml.replace(WORKBOOK_PROTECTION_BLOCK, '').replace(FILE_SHARING_BLOCK, '');
}

/** Odblokowuje komórki w stylach (domyślnie locked=1 — razem z sheetProtection uniemożliwia edycję). */
function unlockStylesXml(stylesXml: string): string {
  return stylesXml.replace(/\blocked="1"/gi, ' locked="0"').replace(/\blocked='1'/gi, " locked='0'");
}

function stripMarkAsFinal(xml: string): string {
  return xml
    .replace(/<(?:[\w.-]+:)?MarkAsFinal\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?MarkAsFinal>/gi, '')
    .replace(/<(?:[\w.-]+:)?MarkAsFinal\b[^>]*\/>/gi, '');
}

/** Usuwa relacje do Excel Table z sheet.rels (kopiowanie kolumn nie działa na ListObject). */
function stripTableRelationshipsFromSheetRels(relsXml: string): string {
  return relsXml.replace(/<Relationship\b[^>]*\/?>/gi, (tag) => {
    const type = tag.match(/\bType="([^"]+)"/i)?.[1] ?? tag.match(/\bType='([^']+)'/i)?.[1] ?? '';
    const target = tag.match(/\bTarget="([^"]+)"/i)?.[1] ?? tag.match(/\bTarget='([^']+)'/i)?.[1] ?? '';
    if (/\/table$/i.test(type) || /tables\//i.test(target)) return '';
    return tag;
  });
}

/**
 * Usuwa wszystkie typowe blokady Excel z paczki OOXML:
 * ochrona skoroszytu/arkusza, tabele, scalenia, Mark as Final, locked w stylach.
 */
function makeWorkbookFullyEditable(buffer: Buffer): Buffer {
  const { entries } = readZipEntries(buffer);
  const replacements = new Map<string, Buffer>();

  for (const entry of entries) {
    if (entry.name === 'xl/workbook.xml') {
      const xml = inflateZipEntry(entry).toString('utf8');
      const next = stripWorkbookStructureLocks(xml);
      if (next !== xml) replacements.set(entry.name, Buffer.from(next, 'utf8'));
      continue;
    }
    if (entry.name === 'xl/styles.xml') {
      const xml = inflateZipEntry(entry).toString('utf8');
      const next = unlockStylesXml(xml);
      if (next !== xml) replacements.set(entry.name, Buffer.from(next, 'utf8'));
      continue;
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)) {
      const xml = inflateZipEntry(entry).toString('utf8');
      const next = clearFiltersAndUnhideInXml(xml, { isTable: false });
      if (next !== xml) replacements.set(entry.name, Buffer.from(next, 'utf8'));
      continue;
    }
    if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/i.test(entry.name)) {
      const xml = inflateZipEntry(entry).toString('utf8');
      const next = stripTableRelationshipsFromSheetRels(xml);
      if (next !== xml) replacements.set(entry.name, Buffer.from(next, 'utf8'));
      continue;
    }
    if (entry.name === '[Content_Types].xml') {
      const xml = inflateZipEntry(entry).toString('utf8');
      const next = xml
        .replace(/<Override\b[^>]*PartName="\/xl\/tables\/[^"]+"[^>]*\/>/gi, '')
        .replace(/<Override\b[^>]*PartName='\/xl\/tables\/[^']+'[^>]*\/>/gi, '');
      if (next !== xml) replacements.set(entry.name, Buffer.from(next, 'utf8'));
      continue;
    }
    if (/^docProps\//i.test(entry.name) && entry.name.endsWith('.xml')) {
      const xml = inflateZipEntry(entry).toString('utf8');
      const next = stripMarkAsFinal(xml);
      if (next !== xml) replacements.set(entry.name, Buffer.from(next, 'utf8'));
    }
  }

  return rewriteZipEntriesFiltered(buffer, replacements, (name) => !/^xl\/tables\//i.test(name));
}

/**
 * Buduje nowy, prosty .xlsx z arkusza Input (same wartości, bez merge/tabel/ochrony/VBA).
 * Patch OOXML szablonu Katowice nadal blokował kopiowanie („multiple selections”) i filtry.
 */
function rebuildPlainInputWorkbook(filledBuffer: Buffer): Buffer {
  const wb = XLSX.read(filledBuffer, { type: 'buffer', cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => String(n).trim().toLowerCase() === 'input') ?? wb.SheetNames[0];
  if (!sheetName) throw new Error('Katowice_Data_OCU: brak arkusza po wypełnieniu.');
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error('Katowice_Data_OCU: pusty arkusz Input.');

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true }) as unknown[][];
  let lastRow = rows.length;
  while (lastRow > 0) {
    const r = rows[lastRow - 1] ?? [];
    if (r.some((c) => c != null && String(c).trim() !== '')) break;
    lastRow--;
  }
  const trimmed = rows.slice(0, Math.max(1, lastRow)).map((r) => (Array.isArray(r) ? [...r] : []));

  let maxCols = 1;
  for (const r of trimmed) maxCols = Math.max(maxCols, r.length);
  for (const r of trimmed) {
    while (r.length < maxCols) r.push('');
  }

  let headerIdx = 0;
  for (let i = 0; i < Math.min(25, trimmed.length); i++) {
    if (
      trimmed[i]?.some((c) =>
        String(c ?? '')
          .toLowerCase()
          .includes('sonar part code')
      )
    ) {
      headerIdx = i;
      break;
    }
  }

  const newSheet = XLSX.utils.aoa_to_sheet(trimmed);
  const lastColLetter = colLetterFrom1(maxCols);
  const filterStart = headerIdx + 1;
  const filterEnd = Math.max(filterStart, trimmed.length);
  newSheet['!ref'] = `A1:${lastColLetter}${filterEnd}`;
  newSheet['!autofilter'] = { ref: `A${filterStart}:${lastColLetter}${filterEnd}` };

  // Duże numery SAP (ERP) — format całkowity zamiast notacji naukowej.
  for (const addr of Object.keys(newSheet)) {
    if (addr.startsWith('!')) continue;
    const cell = newSheet[addr] as XLSX.CellObject | undefined;
    if (!cell || typeof cell.v !== 'number' || !Number.isFinite(cell.v)) continue;
    if (Number.isInteger(cell.v) && Math.abs(cell.v) >= 1e10) {
      cell.z = '0';
      cell.t = 'n';
    }
  }

  const outWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWb, newSheet, 'Input');
  return Buffer.from(
    XLSX.write(outWb, {
      type: 'buffer',
      bookType: 'xlsx',
      compression: true,
    })
  );
}

function resolveWorkbookInputPath(buffer: Buffer): {
  inputPath: string;
  inputRid: string;
  wbXml: string;
  relsXml: string;
} {
  const { entries } = readZipEntries(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const wbEntry = byName.get('xl/workbook.xml');
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  if (!wbEntry || !relsEntry) throw new Error('Katowice_Data: brak workbook.xml / rels.');

  const wbXml = inflateZipEntry(wbEntry).toString('utf8');
  const relsXml = inflateZipEntry(relsEntry).toString('utf8');

  const sheetTag =
    wbXml.match(/<sheet\b[^>]*\bname="Input"[^>]*\/?>/i) ??
    wbXml.match(/<sheet\b[^>]*\bname='Input'[^>]*\/?>/i);
  if (!sheetTag) throw new Error('Katowice_Data: nie znaleziono arkusza „Input”.');
  const rid =
    sheetTag[0].match(/\br:id="([^"]+)"/i)?.[1] ?? sheetTag[0].match(/\br:id='([^']+)'/i)?.[1];
  if (!rid) throw new Error('Katowice_Data: brak r:id arkusza Input.');
  const rel =
    relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`, 'i')) ??
    relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bId='${rid}'[^>]*>`, 'i'));
  const target =
    rel?.[0].match(/\bTarget="([^"]+)"/i)?.[1] ?? rel?.[0].match(/\bTarget='([^']+)'/i)?.[1];
  if (!target) throw new Error('Katowice_Data: brak Target arkusza Input.');
  let inputPath = target.replace(/\\/g, '/');
  if (inputPath.startsWith('/')) inputPath = inputPath.slice(1);
  if (!inputPath.startsWith('xl/')) inputPath = `xl/${inputPath}`;
  return { inputPath, inputRid: rid, wbXml, relsXml };
}

function resolveXlPath(fromDir: string, target: string): string {
  let path = target.replace(/\\/g, '/');
  if (path.startsWith('/')) path = path.slice(1);
  if (path.startsWith('xl/')) return path;
  // Target jest względny względem katalogu pliku .rels (np. xl/worksheets/_rels → ../tables/…)
  const baseParts = fromDir.split('/').filter(Boolean);
  const targetParts = path.split('/');
  for (const part of targetParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

function collectRelationshipTargets(relsXml: string, fromDir: string): string[] {
  const out: string[] = [];
  const re = /<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml))) {
    out.push(resolveXlPath(fromDir, m[1]));
  }
  const re2 = /<Relationship\b[^>]*\bTarget='([^']+)'[^>]*>/gi;
  while ((m = re2.exec(relsXml))) {
    out.push(resolveXlPath(fromDir, m[1]));
  }
  return out;
}

/** Usuwa VBA/makra i ustawia ContentType zwykłego .xlsx (arkusze bez zmian). */
function stripMacrosToXlsx(buffer: Buffer): Buffer {
  try {
    const { entries } = readZipEntries(buffer);
    if (!entries.some((e) => /vbaProject/i.test(e.name))) {
      // mimo braku VBA — ContentType może być macroEnabled
      const ct = entries.find((e) => e.name === '[Content_Types].xml');
      if (!ct) return buffer;
      let ctXml = inflateZipEntry(ct).toString('utf8');
      const next = ctXml.replace(
        /ContentType="application\/vnd\.ms-excel\.sheet\.macroEnabled\.main\+xml"/gi,
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"'
      );
      if (next === ctXml) return buffer;
      return rewriteZipEntries(buffer, new Map([['[Content_Types].xml', Buffer.from(next, 'utf8')]]));
    }

    const byName = new Map(entries.map((e) => [e.name, e]));
    const replacements = new Map<string, Buffer>();

    const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
    if (relsEntry) {
      let relsXml = inflateZipEntry(relsEntry).toString('utf8');
      relsXml = relsXml.replace(/<Relationship\b[^>]*(?:vbaProject|macrosheet|control)[^>]*\/?>/gi, '');
      replacements.set('xl/_rels/workbook.xml.rels', Buffer.from(relsXml, 'utf8'));
    }

    const ctEntry = byName.get('[Content_Types].xml');
    if (ctEntry) {
      let ctXml = inflateZipEntry(ctEntry).toString('utf8');
      ctXml = ctXml.replace(
        /ContentType="application\/vnd\.ms-excel\.sheet\.macroEnabled\.main\+xml"/gi,
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"'
      );
      ctXml = ctXml.replace(/<Override\b[^>]*vbaProject[^>]*\/>/gi, '');
      replacements.set('[Content_Types].xml', Buffer.from(ctXml, 'utf8'));
    }

    return rewriteZipEntriesFiltered(buffer, replacements, (name) => !/vbaProject/i.test(name));
  } catch {
    return buffer;
  }
}

/** Usuwa makra i wszystkie arkusze poza Input; zachowuje XML Input (wiersze/kolumny/style). */
function stripToInputOnlyNoMacros(buffer: Buffer): Buffer {
  const { entries } = readZipEntries(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const { inputPath, inputRid, wbXml, relsXml } = resolveWorkbookInputPath(buffer);

  const keep = new Set<string>([
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    inputPath,
  ]);

  // stałe części skoroszytu
  for (const name of entries.map((e) => e.name)) {
    if (
      name === 'xl/styles.xml' ||
      name === 'xl/sharedStrings.xml' ||
      name.startsWith('xl/theme/') ||
      name.startsWith('docProps/')
    ) {
      keep.add(name);
    }
  }

  // relacje arkusza Input (bez Excel Table — blokują kopiowanie całych kolumn)
  const sheetBase = inputPath.replace(/^xl\/worksheets\//i, '');
  const sheetRelsPath = `xl/worksheets/_rels/${sheetBase}.rels`;
  const sheetRelsEntry = byName.get(sheetRelsPath);
  let cleanedSheetRelsXml: string | null = null;
  if (sheetRelsEntry) {
    keep.add(sheetRelsPath);
    const sheetRelsXml = inflateZipEntry(sheetRelsEntry).toString('utf8');
    cleanedSheetRelsXml = stripTableRelationshipsFromSheetRels(sheetRelsXml);
    for (const target of collectRelationshipTargets(cleanedSheetRelsXml, 'xl/worksheets')) {
      if (/^xl\/tables\//i.test(target)) continue;
      keep.add(target);
      // relacje rysunków / wykresów
      if (/^xl\/drawings\/drawing\d+\.xml$/i.test(target)) {
        const dRels = target.replace(/^xl\/drawings\//i, 'xl/drawings/_rels/') + '.rels';
        if (byName.has(dRels)) {
          keep.add(dRels);
          const dXml = inflateZipEntry(byName.get(dRels)!).toString('utf8');
          for (const t of collectRelationshipTargets(dXml, 'xl/drawings')) keep.add(t);
        }
      }
    }
  }

  // workbook.xml — tylko arkusz Input
  const sheetsBlock = wbXml.match(/<(?:\w+:)?sheets\b[^>]*>[\s\S]*?<\/(?:\w+:)?sheets>/i)?.[0];
  if (!sheetsBlock) throw new Error('Katowice_Data: brak sekcji sheets w workbook.xml.');
  const inputSheetTag =
    sheetsBlock.match(/<(?:\w+:)?sheet\b[^>]*\bname="Input"[^>]*\/?>/i)?.[0] ??
    sheetsBlock.match(/<(?:\w+:)?sheet\b[^>]*\bname='Input'[^>]*\/?>/i)?.[0];
  if (!inputSheetTag) throw new Error('Katowice_Data: brak tagu sheet Input.');
  const normalizedSheet = inputSheetTag
    .replace(/\bsheetId="[^"]*"/i, 'sheetId="1"')
    .replace(/\bsheetId='[^']*'/i, "sheetId='1'");
  const sheetsOpen = sheetsBlock.match(/^<(?:\w+:)?sheets\b[^>]*>/i)?.[0] ?? '<sheets>';
  const sheetsClose = sheetsBlock.match(/<\/(?:\w+:)?sheets>$/i)?.[0] ?? '</sheets>';
  const newWbXml = stripWorkbookStructureLocks(
    wbXml.replace(sheetsBlock, `${sheetsOpen}${normalizedSheet}${sheetsClose}`)
  );

  // workbook rels — Input + style/theme/sharedStrings (bez innych sheetów i VBA)
  const relTags = [...relsXml.matchAll(/<Relationship\b[^>]*\/?>/gi)].map((m) => m[0]);
  const keptRels: string[] = [];
  for (const tag of relTags) {
    const id = tag.match(/\bId="([^"]+)"/i)?.[1] ?? tag.match(/\bId='([^']+)'/i)?.[1] ?? '';
    const type = tag.match(/\bType="([^"]+)"/i)?.[1] ?? tag.match(/\bType='([^']+)'/i)?.[1] ?? '';
    const target = tag.match(/\bTarget="([^"]+)"/i)?.[1] ?? tag.match(/\bTarget='([^']+)'/i)?.[1] ?? '';
    const typeL = type.toLowerCase();
    const targetL = target.toLowerCase();
    if (/vba|macrosheet|control/i.test(typeL) || /vbaproject/i.test(targetL)) continue;
    if (/\/worksheet$/i.test(typeL) || /worksheets\//i.test(targetL)) {
      if (id === inputRid) keptRels.push(tag);
      continue;
    }
    keptRels.push(tag);
    const abs = resolveXlPath('xl', target);
    if (byName.has(abs)) keep.add(abs);
  }
  const relsBody = keptRels.join('');
  const newRelsXml = relsXml.replace(
    /(<Relationships\b[^>]*>)[\s\S]*?(<\/Relationships>)/i,
    `$1${relsBody}$2`
  );

  // Content_Types — bez makr i bez usuniętych części
  const ctEntry = byName.get('[Content_Types].xml');
  if (!ctEntry) throw new Error('Katowice_Data: brak [Content_Types].xml.');
  let ctXml = inflateZipEntry(ctEntry).toString('utf8');
  ctXml = ctXml.replace(
    /ContentType="application\/vnd\.ms-excel\.sheet\.macroEnabled\.main\+xml"/gi,
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"'
  );
  ctXml = ctXml.replace(/<Override\b[^>]*PartName="\/([^"]+)"[^>]*\/>/gi, (full, part) => {
    const name = String(part);
    if (/vbaProject/i.test(name)) return '';
    if (name.startsWith('xl/worksheets/') && !name.includes('/_rels/')) {
      return name === inputPath ? full : '';
    }
    if (
      name === 'xl/workbook.xml' ||
      name === 'xl/styles.xml' ||
      name === 'xl/sharedStrings.xml' ||
      name.startsWith('xl/theme/') ||
      name.startsWith('docProps/')
    ) {
      return full;
    }
    return keep.has(name) ? full : '';
  });
  ctXml = ctXml.replace(/<Override\b[^>]*PartName='\/([^']+)'[^>]*\/>/gi, (full, part) => {
    const name = String(part);
    if (/vbaProject/i.test(name)) return '';
    if (name.startsWith('xl/worksheets/') && !name.includes('/_rels/')) {
      return name === inputPath ? full : '';
    }
    if (
      name === 'xl/workbook.xml' ||
      name === 'xl/styles.xml' ||
      name === 'xl/sharedStrings.xml' ||
      name.startsWith('xl/theme/') ||
      name.startsWith('docProps/')
    ) {
      return full;
    }
    return keep.has(name) ? full : '';
  });

  const replacements = new Map<string, Buffer>();
  replacements.set('xl/workbook.xml', Buffer.from(newWbXml, 'utf8'));
  replacements.set('xl/_rels/workbook.xml.rels', Buffer.from(newRelsXml, 'utf8'));
  replacements.set('[Content_Types].xml', Buffer.from(ctXml, 'utf8'));
  if (cleanedSheetRelsXml != null) {
    replacements.set(sheetRelsPath, Buffer.from(cleanedSheetRelsXml, 'utf8'));
  }

  // Input: upewnij się, że nie zostały merge/tableParts/ochrona (gdy strip idzie bez mutate)
  const inputEntry = byName.get(inputPath);
  if (inputEntry) {
    const inputXml0 = inflateZipEntry(inputEntry).toString('utf8');
    const inputCleared = clearFiltersAndUnhideInXml(inputXml0, { isTable: false });
    if (inputCleared !== inputXml0) {
      replacements.set(inputPath, Buffer.from(inputCleared, 'utf8'));
    }
  }

  const stylesEntry = byName.get('xl/styles.xml');
  if (stylesEntry) {
    const stylesXml = inflateZipEntry(stylesEntry).toString('utf8');
    const stylesUnlocked = unlockStylesXml(stylesXml);
    if (stylesUnlocked !== stylesXml) {
      replacements.set('xl/styles.xml', Buffer.from(stylesUnlocked, 'utf8'));
    }
  }

  return rewriteZipEntriesFiltered(buffer, replacements, (name) => {
    if (/vbaProject/i.test(name)) return false;
    if (/^xl\/tables\//i.test(name)) return false;
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) return name === inputPath;
    if (/^xl\/worksheets\/_rels\//i.test(name)) return name === sheetRelsPath;
    if (keep.has(name)) return true;
    if (
      name.startsWith('xl/media/') ||
      name.startsWith('xl/charts/') ||
      name.startsWith('xl/tables/') ||
      name.startsWith('xl/drawings/') ||
      name.startsWith('xl/printerSettings/')
    ) {
      return false;
    }
    // poza xl/ (np. customXml, docProps już w keep) — zostaw
    if (!name.startsWith('xl/')) return true;
    return false;
  });
}

/**
 * Mutuje skoroszyt OOXML bez JSZip.generate (copy-through ZIP) —
 * Excel nie otwierał plików po pełnym przepisaniu dużego .xlsm.
 */
function mutateKatowicePackage(
  buffer: Buffer,
  cellUpdates: Map<string, string | number>
): { cleaned: Buffer; filled: Buffer } {
  const { entries } = readZipEntries(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const { inputPath } = resolveWorkbookInputPath(buffer);

  const cleanedReplacements = new Map<string, Buffer>();
  const filledReplacements = new Map<string, Buffer>();

  for (const entry of entries) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name) || entry.name === inputPath) {
      const xml0 = inflateZipEntry(entry).toString('utf8');
      const cleared = clearFiltersAndUnhideInXml(xml0, { isTable: false });
      if (cleared !== xml0) cleanedReplacements.set(entry.name, Buffer.from(cleared, 'utf8'));

      if (entry.name === inputPath || entry.name.replace(/^\/+/, '') === inputPath) {
        const patched = applyCellUpdatesToSheetXml(cleared, cellUpdates);
        filledReplacements.set(entry.name, Buffer.from(patched, 'utf8'));
      } else if (cleared !== xml0) {
        filledReplacements.set(entry.name, Buffer.from(cleared, 'utf8'));
      }
      continue;
    }

    if (/^xl\/tables\/table\d+\.xml$/i.test(entry.name)) {
      const xml0 = inflateZipEntry(entry).toString('utf8');
      const cleared = clearFiltersAndUnhideInXml(xml0, { isTable: true });
      if (cleared !== xml0) {
        const buf = Buffer.from(cleared, 'utf8');
        cleanedReplacements.set(entry.name, buf);
        filledReplacements.set(entry.name, buf);
      }
    }
  }

  // Input sheet musi trafić do filled nawet gdy nie było filtrów/ukryć, ale są cellUpdates
  if (!filledReplacements.has(inputPath)) {
    const entry = byName.get(inputPath);
    if (!entry) throw new Error(`Katowice_Data: brak pliku arkusza ${inputPath}`);
    const xml0 = inflateZipEntry(entry).toString('utf8');
    const cleared = clearFiltersAndUnhideInXml(xml0, { isTable: false });
    filledReplacements.set(inputPath, Buffer.from(applyCellUpdatesToSheetXml(cleared, cellUpdates), 'utf8'));
    if (cleared !== xml0) cleanedReplacements.set(inputPath, Buffer.from(cleared, 'utf8'));
  }

  const cleaned = rewriteZipEntries(buffer, cleanedReplacements);
  const filled = rewriteZipEntries(buffer, filledReplacements);
  return { cleaned, filled };
}

async function clearWorkbookFiltersAndUnhide(buffer: Buffer): Promise<Buffer> {
  // Lekkie pliki (tabela przejścia) — copy-through też
  try {
    const { entries } = readZipEntries(buffer);
    const replacements = new Map<string, Buffer>();
    for (const entry of entries) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name)) {
        const xml0 = inflateZipEntry(entry).toString('utf8');
        const cleared = clearFiltersAndUnhideInXml(xml0, { isTable: false });
        if (cleared !== xml0) replacements.set(entry.name, Buffer.from(cleared, 'utf8'));
      } else if (/^xl\/tables\/table\d+\.xml$/i.test(entry.name)) {
        const xml0 = inflateZipEntry(entry).toString('utf8');
        const cleared = clearFiltersAndUnhideInXml(xml0, { isTable: true });
        if (cleared !== xml0) replacements.set(entry.name, Buffer.from(cleared, 'utf8'));
      }
    }
    if (!replacements.size) return buffer;
    return rewriteZipEntries(buffer, replacements);
  } catch {
    // nie-ZIP / stary .xls — oddaj bez zmian
    return buffer;
  }
}

/**
 * Uzupełnia arkusz Input (Katowice_Data):
 * - X, AB, AC, AD, AE z bazy Capacity + tabela przejścia
 * - AK (S1619); CW + DB/DC + CY oraz DI + DN/DO + DK (S2102) z routingu SAP (BOM wielopoziomowy)
 * - brak S2102 → czyszczenie całego bloku CR–DC / DD–DO wartościami 0 (m.in. Machinegroup HL)
 * Filtry wyłączane + wiersze odkrywane; wynik OCU: .xlsx bez makr, tylko Input.
 * Brak dopasowania → 0 (nadpisuje wcześniejsze wartości z szablonu).
 */
export async function generateOcuKatowiceWorkbook(
  transitionBuffer: Buffer,
  katowiceBuffer: Buffer,
  routingBuffer: Buffer,
  options?: {
    katowicePassword?: string | null;
    columnMapping?: Partial<OcuColumnLetters> | null;
  }
): Promise<OcuDataGenerateResult> {
  const JSZip = (await import('jszip')).default;
  const letters = mergeOcuColumnLetters(options?.columnMapping);
  const s2102Blocks = buildS2102BlocksFromLetters(letters);

  // Hasło otwarcia nie da się ominąć — odszyfruj przed odczytem Input / OOXML.
  const katowiceUnlocked = await readWorkbookBufferWithOptionalPassword(
    katowiceBuffer,
    options?.katowicePassword,
    'Katowice_Data'
  );

  const transitionNoFilter = await clearWorkbookFiltersAndUnhide(transitionBuffer);
  const routingIndex: SapRoutingIndex = parseSapRoutingBuffer(routingBuffer);

  const transition = parseTransitionSheet(transitionNoFilter);
  const erpBySonarYear = new Map<string, string>();
  for (const row of transition) {
    erpBySonarYear.set(`${row.sonar}|${row.year}`, row.erp);
  }

  const { rows, headerRowNum, cols } = findInputSheetMatrix(katowiceUnlocked, letters);
  const yearsNeeded: number[] = transition.map((t) => t.year);
  for (let i = headerRowNum; i < rows.length; i++) {
    const y = asYear(rows[i]?.[cols.year - 1]);
    if (y != null) yearsNeeded.push(y);
  }
  const profiles = loadDetailProfilesBySap(yearsNeeded);

  const stats = {
    pivot_rows: 0,
    filled_ab: 0,
    filled_x: 0,
    filled_ac: 0,
    filled_ad: 0,
    filled_ae: 0,
    filled_s1619: 0,
    filled_s2102_large: 0,
    filled_s2102_small: 0,
    unmatched_sonar: 0,
    unmatched_erp_in_db: 0,
    unmatched_routing: 0,
    routing_finished_goods: routingIndex.finishedGoods,
  };

  const cellUpdates = new Map<string, string | number>();
  const colX = colLetterFrom1(cols.x);
  const colAb = colLetterFrom1(cols.ab);
  const colAc = colLetterFrom1(cols.ac);
  const colAd = colLetterFrom1(cols.ad);
  const colAe = colLetterFrom1(cols.ae);
  // Numery materiałów SAP → wyłącznie kolumny ERP No (AK / CW / DI), nie Machinegroup (AF/CR/DD).

  for (let i = headerRowNum; i < rows.length; i++) {
    const excelRow = i + 1;
    const row = rows[i] ?? [];
    const sonar = normKey(row[cols.sonarCode - 1]);
    const year = asYear(row[cols.year - 1]);
    if (!sonar) continue;
    stats.pivot_rows++;

    let abValue: string | number = 0;
    let xValue: string | number = 0;
    let acValue: string | number = 0;
    let adValue: string | number = 0;
    let aeValue: string | number = 0;
    let s1619: SapRoutingComponent[] = [];
    let s2102Large: SapRoutingComponent[] = [];
    let s2102Small: SapRoutingComponent[] = [];

    const erp = year != null ? erpBySonarYear.get(`${sonar}|${year}`) : undefined;
    if (erp == null || erp === '') {
      stats.unmatched_sonar++;
    } else {
      const erpNum = Number(erp);
      abValue =
        Number.isFinite(erpNum) && String(Math.trunc(erpNum)) === erp ? erpNum : erp;
      stats.filled_ab++;

      if (!erp || erp === '0') {
        stats.unmatched_erp_in_db++;
      } else {
        const resolved = resolveDetailProfileByErp(profiles, erp);
        if (!resolved) {
          stats.unmatched_erp_in_db++;
        } else {
          const { profile } = resolved;
          const line = pickLineForYear(profile, year);
          if (line) {
            xValue = `L${line}`;
            stats.filled_x++;
          }

          if (profile.nestsParts.length) {
            acValue = profile.nestsParts.join('+');
            stats.filled_ac++;
          }

          if (profile.maxCycleSeconds != null && profile.maxCycleSeconds > 0) {
            adValue = Math.round(3600 / profile.maxCycleSeconds);
            stats.filled_ad++;
          }

          if (profile.nestsCount > 0) {
            aeValue = profile.nestsCount;
            stats.filled_ae++;
          }
        }

        // Routing SAP — komponenty powiązane z wyrobem (ERP = Material w routingu)
        const fgKey = normSapKey(erp);
        const hasFg = routingIndex.byFinishedGood.has(fgKey);
        if (!hasFg) {
          stats.unmatched_routing++;
        } else {
          // Wielopoziomowy BOM: S2102/S1619 mogą być pod półproduktem (np. FG → 10670608… → S2102 = HL).
          s1619 = componentsWithCodeDeep(routingIndex, fgKey, 'S1619');
          const s2102All = componentsWithCodeDeep(routingIndex, fgKey, 'S2102');
          const split = splitS2102ByFormatka(s2102All);
          s2102Large = split.large;
          s2102Small = split.small;
        }
      }
    }

    cellUpdates.set(`${colAb}${excelRow}`, abValue);
    cellUpdates.set(`${colX}${excelRow}`, xValue);
    cellUpdates.set(`${colAc}${excelRow}`, acValue);
    cellUpdates.set(`${colAd}${excelRow}`, adValue);
    cellUpdates.set(`${colAe}${excelRow}`, aeValue);

    stats.filled_s1619 += writeRoutingErpNo(
      cellUpdates,
      excelRow,
      letters.s1619Erp,
      s1619,
      letters.s1619MachineGroup
    );
    stats.filled_s2102_large += writeS2102Block(
      cellUpdates,
      excelRow,
      s2102Blocks.large,
      s2102Large,
      routingIndex
    );
    stats.filled_s2102_small += writeS2102Block(
      cellUpdates,
      excelRow,
      s2102Blocks.small,
      s2102Small,
      routingIndex
    );
  }

  const { cleaned: katowiceNoFilterRaw, filled: katowiceFilled } = mutateKatowicePackage(
    katowiceUnlocked,
    cellUpdates
  );
  // Pełne odblokowanie wersji „bez filtrów” (zachowuje wygląd szablonu).
  const katowiceNoFilter = makeWorkbookFullyEditable(stripMacrosToXlsx(katowiceNoFilterRaw));
  // OCU: nowy czysty .xlsx (bez merge/tabel/ochrony) — kopiowanie wierszy i filtry działają.
  const katowiceOcu = rebuildPlainInputWorkbook(katowiceFilled);

  const outZip = new JSZip();
  outZip.file('Tabela_przejscia.xlsx', transitionNoFilter);
  outZip.file('Katowice_Data_bez_filtrow.xlsx', katowiceNoFilter);
  outZip.file('Katowice_Data_OCU.xlsx', katowiceOcu);
  outZip.file('routing.txt', routingBuffer);
  const zipBuffer = await outZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return {
    buffer: Buffer.from(zipBuffer),
    filename: 'Dane_do_OCU.zip',
    stats,
  };
}
