import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { db, saveDb } from '../db/connection.js';
import { parseInternalMachineNumber } from '../utils/internalMachineNumber.js';
import { excelExportCell } from '../utils/excelExportCell.js';
import { addDirectoryToZip, extractZipFolderToDisk, scenarioSnapshotExcelCell } from './backupService.js';
import { getCallOffsStorageRoot } from './callOffFileService.js';

const README_SHEET = '_INSTRUKCJA';

/**
 * Konta / RBAC / sesje — nigdy w szablonie Excel i nigdy nie importowane ani czyszczone
 * przez „Szablon Excel”. Stare pliki z arkuszem users/roles są ignorowane (także przy pełnym imporcie).
 */
const AUTH_PROTECTED_TABLES = [
  'users',
  'user_roles',
  'roles',
  'role_permissions',
  'sessions',
  'password_reset_tokens',
  'password_reset_requests',
] as const;

function isAuthProtectedTable(name: string): boolean {
  const n = String(name ?? '')
    .trim()
    .toLowerCase();
  return (AUTH_PROTECTED_TABLES as readonly string[]).includes(n);
}

/** Tabele systemowe / pomijane w eksporcie arkusza. */
const SKIP_EXPORT = new Set<string>([
  'sqlite_sequence',
  'sqlite_stat1',
  'sqlite_stat4',
  '_migrations',
  ...AUTH_PROTECTED_TABLES,
]);

/**
 * Przy imporcie / czyszczeniu nie ruszamy ustawień admina ani kont.
 * Import users z Excela niszczy password_hash → brak logowania admina (gość działa).
 */
const SKIP_IMPORT = new Set<string>([
  'admin_settings',
  'sqlite_sequence',
  'sqlite_stat1',
  'sqlite_stat4',
  '_migrations',
  README_SHEET,
  ...AUTH_PROTECTED_TABLES,
]);

/** Ostateczny filtr — nigdy nie czyść / nie wstawiaj tabel auth (nawet ze starego Excela). */
function withoutAuthTables(tables: string[]): string[] {
  return tables.filter((t) => !SKIP_IMPORT.has(t) && !isAuthProtectedTable(t) && t !== README_SHEET);
}

/**
 * Kolejność wstawiania (rodzice przed dziećmi). Scenariusze na końcu.
 * Duże snapshoty trafiają też do ZIP (scenarios/*.json) — w Excelu może być znacznik __FILE__.
 */
const IMPORT_ORDER_BASE: string[] = [
  'working_days',
  'machine_types',
  'process_phases',
  'machines',
  'part_designations',
  'nests',
  'nest_machines',
  'machine_alternatives',
  'projects',
  'project_volumes',
  'project_volumes_contract',
  'project_eop_extensions',
  'project_notes',
  'parts',
  'part_volume_by_year',
  'part_volume_contract_by_year',
  'part_volume_share_by_year',
  'part_volume_contract_share_by_year',
  'operations',
  'operation_volume_by_year',
  'operation_set_members',
  'call_off_comparisons',
  'call_off_volumes',
  'scenarios',
];

function safeIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Nieprawidłowa nazwa tabeli: ${name}`);
  return name;
}

export function listUserTables(): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function resolveImportOrder(): string[] {
  const existing = new Set(listUserTables());
  const out: string[] = [];
  for (const t of IMPORT_ORDER_BASE) {
    if (existing.has(t)) out.push(t);
  }
  for (const t of existing) {
    if (!out.includes(t) && !SKIP_IMPORT.has(t) && !SKIP_EXPORT.has(t) && t !== README_SHEET) {
      out.push(t);
    }
  }
  return out;
}

function tableColumns(table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${safeIdent(table)})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function rowsToAoa(rows: Record<string, unknown>[], columns: string[]): (string | number | null)[][] {
  const header = columns;
  const body = rows.map((r) => columns.map((c) => normalizeExportValue(r[c])));
  return [header, ...body];
}

function normalizeExportValue(v: unknown): string | number | null {
  return excelExportCell(v);
}

function buildReadmeAoa(): (string | number | null)[][] {
  return [
    ['Capacity — szablon Excel bazy danych'],
    [],
    ['Jak używać'],
    ['1. Pobierz szablon (aktualna zawartość bazy jako arkusze).'],
    ['2. Edytuj dane w arkuszach (nazwa arkusza = nazwa tabeli). Pierwszy wiersz to nagłówki kolumn — nie zmieniaj ich nazw.'],
    ['3. Zapisz plik .xlsx i wgraj w aplikacji: Administracja → Ustawienia administracyjne → Import z Excela.'],
    ['4. Potwierdź wpisując frazę z komunikatu.'],
    [],
    ['Uwagi'],
    ['• Operacja IMPORTU (pełna) usuwa dane z większości tabel (wg listy poniżej) i wstawia zawartość z pliku. Import częściowy (wybrane tabele w UI) czyści i wypełnia tylko zaznaczone arkusze — reszta bazy bez zmian; zachowaj spójność kluczy (np. operacje → maszyny i detale).'],
    ['• Konta użytkowników, role, sesje i reset hasła NIE są w szablonie. Import pełny/częściowy ich nie czyści i nie nadpisuje — także gdy stary plik Excel nadal ma arkusze users/roles (są ignorowane).'],
    ['• Tabela scenarios jest eksportowana. Duże snapshoty trafiają do plików scenarios/scenario_{id}.json w paczce ZIP (w Excelu komórka może zawierać znacznik __FILE__:…). Preferuj pobieranie / wgrywanie paczki ZIP.'],
    ['• Paczka ZIP zawiera także katalog call-offs/ (pliki źródłowe SalesFcst).'],
    ['• Kolumny SOP i EOP (tekst w bazie): przy imporcie zapisujemy daty jako DD.MM.RRRR z wiodącymi zerami (także gdy Excel trzyma komórkę jako liczbę-serial).'],
    ['• Kolejność arkuszy nie ma znaczenia; serwer importuje w bezpiecznej kolejności zależności.'],
    [],
    ['Tabele objęte importem (kolejność zapisu)'],
    ...resolveImportOrder().map((t, i) => [i + 1, t]),
  ];
}

/** Arkusz _INSTRUKCJA dla szablonu tylko z wybranymi tabelami. */
function buildReadmeAoaPartial(selectedTables: string[]): (string | number | null)[][] {
  const sorted = [...selectedTables].sort((a, b) => a.localeCompare(b));
  return [
    ['Capacity — szablon Excel (wybrane tabele)'],
    [],
    ['Ten plik zawiera wyłącznie arkusze danych:'],
    [sorted.join(', ')],
    [],
    ['Jak używać'],
    ['1. Edytuj wyłącznie te arkusze (nazwa arkusza = nazwa tabeli). Pierwszy wiersz = nagłówki kolumn — nie zmieniaj ich nazw.'],
    ['2. W aplikacji wybierz import częściowy i zaznacz te same tabele co przy pobieraniu szablonu.'],
    ['3. Potwierdź import wpisując IMPORTUJ_BAZE.'],
    [],
    ['Uwagi'],
    ['• Import częściowy czyści i wypełnia tylko zaznaczone tabele — reszta bazy bez zmian.'],
    ['• Zachowaj spójność identyfikatorów (np. operacje odwołują się do maszyn i detali).'],
    ['• Przed importem wykonaj backup.'],
  ];
}

function allowedTablesForPartialTemplate(): Set<string> {
  return new Set(withoutAuthTables(resolveImportOrder()));
}

/**
 * Szablon Excel: _INSTRUKCJA + arkusze per tabela.
 * @param options.onlyTables — jeśli podane i niepuste, tylko te tabele (muszą być dozwolone do eksportu częściowego).
 */
export function buildCapacityBundleTemplateBuffer(options?: { onlyTables?: string[] | null }): Buffer {
  const requested = (options?.onlyTables ?? []).map((t) => String(t).trim()).filter(Boolean);
  const partial = requested.length > 0;

  let tables: string[];
  if (partial) {
    const allowed = allowedTablesForPartialTemplate();
    for (const t of requested) {
      if (!allowed.has(t)) {
        throw new Error(`Niedozwolona lub nieobsługiwana tabela w szablonie częściowym: ${t}`);
      }
      if (!listUserTables().includes(t)) {
        throw new Error(`Brak tabeli w bazie: ${t}`);
      }
    }
    tables = [...new Set(requested)].sort((a, b) => a.localeCompare(b));
  } else {
    tables = listUserTables()
      .filter((t) => !SKIP_EXPORT.has(t) && !isAuthProtectedTable(t))
      .sort((a, b) => a.localeCompare(b));
  }

  const wb = XLSX.utils.book_new();
  const readme = XLSX.utils.aoa_to_sheet(partial ? buildReadmeAoaPartial(tables) : buildReadmeAoa());
  XLSX.utils.book_append_sheet(wb, readme, README_SHEET);

  for (const table of tables) {
    const cols = tableColumns(table);
    const rows = db.prepare(`SELECT * FROM ${safeIdent(table)}`).all() as Record<string, unknown>[];
    let aoa: (string | number | null)[][];
    if (table === 'scenarios' && rows.length > 0) {
      aoa = [
        cols,
        ...rows.map((r) =>
          cols.map((c) => {
            if (c === 'snapshot') {
              return scenarioSnapshotExcelCell(r.snapshot, Number(r.id));
            }
            return normalizeExportValue(r[c]);
          })
        ),
      ];
    } else {
      aoa = rows.length === 0 ? [cols] : rowsToAoa(rows, cols);
    }
    const sh = XLSX.utils.aoa_to_sheet(aoa);
    const name = table.length > 31 ? table.slice(0, 31) : table;
    XLSX.utils.book_append_sheet(wb, sh, name);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Pełna paczka szablonu: Excel (wszystkie / wybrane tabele) + scenarios/*.json + call-offs/.
 */
export async function buildCapacityBundlePackageBuffer(options?: {
  onlyTables?: string[] | null;
}): Promise<{ buffer: Buffer; filename: string }> {
  const onlyTables = options?.onlyTables?.length ? options.onlyTables : undefined;
  const xlsx = buildCapacityBundleTemplateBuffer(onlyTables ? { onlyTables } : undefined);
  const zip = new JSZip();
  const xlsxName = onlyTables?.length ? 'capacity_baza_szablon_wybrane.xlsx' : 'capacity_baza_szablon.xlsx';
  zip.file(xlsxName, xlsx);
  zip.file(
    'MANIFEST.json',
    JSON.stringify(
      {
        format: 'capacity-bundle-package-v1',
        created_at: new Date().toISOString(),
        excel: xlsxName,
        only_tables: onlyTables ?? null,
        extras: ['scenarios/', 'call-offs/'],
      },
      null,
      2
    )
  );

  const includeScenarios = !onlyTables || onlyTables.includes('scenarios');
  if (includeScenarios) {
    try {
      const rows = db.prepare(`SELECT * FROM scenarios`).all() as Record<string, unknown>[];
      for (const r of rows) {
        const id = Number(r.id);
        if (!Number.isFinite(id)) continue;
        let snap: unknown = r.snapshot;
        try {
          snap = typeof r.snapshot === 'string' ? JSON.parse(String(r.snapshot)) : r.snapshot;
        } catch {
          snap = r.snapshot;
        }
        zip.file(`scenarios/scenario_${id}.json`, JSON.stringify({ ...r, snapshot: snap }, null, 2));
      }
    } catch {
      /* no scenarios table */
    }
  }

  const includeCallOffs =
    !onlyTables ||
    onlyTables.some((t) => t === 'call_off_comparisons' || t === 'call_off_volumes');
  if (includeCallOffs) {
    try {
      addDirectoryToZip(zip, getCallOffsStorageRoot(), 'call-offs');
    } catch {
      /* ignore */
    }
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const filename = onlyTables?.length ? 'capacity_baza_szablon_wybrane.zip' : 'capacity_baza_szablon.zip';
  return { buffer, filename };
}

function coerceCell(v: unknown): string | number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  if (s !== '' && !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return n;
  return s;
}

/** Kolumny tekstowe z datami (SOP/EOP) — import z Excela ma zachować wiodące zera (DD.MM.RRRR). */
const DATE_TEXT_COLUMNS = new Set(['sop', 'eop', 'eop_original', 'eop_extension', 'eop_before', 'eop_after']);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format DD.MM.RRRR z lokalnej daty (komórki typu Date z arkusza). */
function formatLocalDottedDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Excel serial (dzień) → DD.MM.RRRR w UTC (unika przesunięć strefy przy samej dacie). */
function formatExcelSerialAsDotted(serial: number): string | null {
  const whole = Math.floor(serial);
  if (!Number.isFinite(whole) || whole < 25000 || whole > 80000) return null;
  const ms = Date.UTC(1970, 0, 1) + (whole - 25569) * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** Ujednolica „1.5.2025”, „1/5/2025”, „2025-05-01” → DD.MM.RRRR. */
function normalizeDateLikeString(s: string): string {
  const t = s.trim();
  if (!t) return '';
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const dmy = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dmy) return `${pad2(Number(dmy[1]))}.${pad2(Number(dmy[2]))}.${dmy[3]}`;
  return t;
}

function coerceDateTextColumn(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const s = formatLocalDottedDate(v);
    return s || null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const fromSerial = formatExcelSerialAsDotted(v);
    if (fromSerial) return fromSerial;
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = normalizeDateLikeString(String(v));
  return s === '' ? null : s;
}

function coerceCellForImport(column: string, v: unknown): string | number | null {
  if (DATE_TEXT_COLUMNS.has(column)) return coerceDateTextColumn(v);
  return coerceCell(v);
}

/** Numery wewnętrzne występujące więcej niż raz w arkuszu machines (przed importem). */
function duplicateInternalNumbersInMachineRows(rows: Record<string, unknown>[]): string[] {
  const counts = new Map<string, number>();
  for (const raw of rows) {
    const cell = coerceCellForImport('internal_number', raw.internal_number);
    const parsed = parseInternalMachineNumber(cell);
    if (!parsed.ok) continue;
    const key = parsed.value;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 1)
    .map(([num]) => num)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export type ImportBundleResult =
  | { ok: true; tables_imported: string[]; rows_counts: Record<string, number>; partial: boolean }
  | { ok: false; error: string };

export type ClearDatabaseResult =
  | { ok: true; tables_cleared: string[]; rows_deleted: Record<string, number> }
  | { ok: false; error: string };

/** Usuwa dane aplikacji ze wszystkich tabel importowalnych; zachowuje admin_settings, _migrations i konta/RBAC. */
export function clearApplicationDatabase(): ClearDatabaseResult {
  const order = resolveImportOrder();
  const toClear = withoutAuthTables(order);
  if (toClear.length === 0) {
    return { ok: false, error: 'Brak tabel do wyczyszczenia.' };
  }
  const rowsDeleted: Record<string, number> = {};
  try {
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.prepare('BEGIN TRANSACTION').run();
    for (let i = toClear.length - 1; i >= 0; i--) {
      const t = toClear[i];
      const r = db.prepare(`DELETE FROM ${safeIdent(t)}`).run();
      rowsDeleted[t] = r.changes;
    }
    db.prepare('COMMIT').run();
    db.prepare('PRAGMA foreign_keys = ON').run();
    saveDb();
    return { ok: true, tables_cleared: toClear, rows_deleted: rowsDeleted };
  } catch (e: any) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      /* ignore */
    }
    try {
      db.prepare('PRAGMA foreign_keys = ON').run();
    } catch {
      /* ignore */
    }
    return { ok: false, error: e?.message || 'Błąd czyszczenia bazy' };
  }
}

/**
 * @param options.onlyTables — jeśli niepusta, importujemy i czyścimy wyłącznie te tabele (w kolejności zależności).
 *   Pozostałe tabele w bazie pozostają bez zmian. Wymagane arkusze o nazwach jak tabele.
 */
export function importCapacityBundleFromBuffer(buf: Buffer, options?: { onlyTables?: string[] | null }): ImportBundleResult {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true } as XLSX.ParsingOptions);
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Niepoprawny plik Excel.' };
  }
  return importCapacityBundleFromWorkbook(wb, options);
}

/**
 * Rdzeń importu działający na już wczytanym `XLSX.WorkBook` — wydzielony, żeby
 * `importCapacityBundlePackageFromZipBuffer` mógł najpierw podmienić w arkuszu „scenarios”
 * komórki z markerem `__FILE__:...` na realną treść z plików scenarios/*.json w paczce ZIP.
 */
export function importCapacityBundleFromWorkbook(
  wb: XLSX.WorkBook,
  options?: { onlyTables?: string[] | null }
): ImportBundleResult {
  const order = resolveImportOrder();
  const requested = (options?.onlyTables ?? [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    // Stare klienty / pliki mogły prosić o users — zawsze odrzuć z listy roboczej
    .filter((t) => !isAuthProtectedTable(t));
  const partial = (options?.onlyTables?.length ?? 0) > 0;

  let toProcess: string[];
  if (partial) {
    const allowedForPartial = new Set(withoutAuthTables(order));
    const rawRequested = (options?.onlyTables ?? []).map((t) => String(t).trim()).filter(Boolean);
    for (const t of rawRequested) {
      if (isAuthProtectedTable(t)) {
        return {
          ok: false,
          error: `Tabela „${t}” (konta/hasła/role) nie jest importowana — pomiń ją. Konta na serwerze pozostają bez zmian.`,
        };
      }
      if (!allowedForPartial.has(t)) {
        return { ok: false, error: `Niedozwolona lub nieznana tabela w imporcie częściowym: ${t}` };
      }
    }
    toProcess = withoutAuthTables(order.filter((t) => requested.includes(t)));
    if (toProcess.length === 0) {
      return { ok: false, error: 'Import częściowy: żadna z podanych nazw nie pasuje do tabel w bazie.' };
    }
  } else {
    toProcess = withoutAuthTables(order);
  }

  // Twarde zabezpieczenie — nawet gdyby lista się rozszerzyła
  toProcess = withoutAuthTables(toProcess);

  const counts: Record<string, number> = {};

  for (const table of toProcess) {
    if (table !== 'machines') continue;
    const sheetName = table.length > 31 ? table.slice(0, 31) : table;
    if (!wb.SheetNames.includes(sheetName)) continue;
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: true,
      cellDates: true,
    } as XLSX.Sheet2JSONOpts);
    const dups = duplicateInternalNumbersInMachineRows(rows);
    if (dups.length > 0) {
      return {
        ok: false,
        error: `Arkusz „machines”: powtórzony numer maszyny (internal_number) w pliku: ${dups.join(', ')}. Zostaw jeden wiersz na numer lub popraw dane.`,
      };
    }
  }

  try {
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.prepare('BEGIN TRANSACTION').run();

    for (let i = toProcess.length - 1; i >= 0; i--) {
      const t = toProcess[i];
      if (isAuthProtectedTable(t) || SKIP_IMPORT.has(t)) continue;
      db.prepare(`DELETE FROM ${safeIdent(t)}`).run();
    }

    for (const table of toProcess) {
      if (isAuthProtectedTable(table) || SKIP_IMPORT.has(table)) {
        counts[table] = 0;
        continue;
      }
      const sheetName = table.length > 31 ? table.slice(0, 31) : table;
      if (!wb.SheetNames.includes(sheetName)) {
        counts[table] = 0;
        continue;
      }
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: true,
      cellDates: true,
    } as XLSX.Sheet2JSONOpts);
      if (rows.length === 0) {
        counts[table] = 0;
        continue;
      }

      const dbCols = new Set(tableColumns(table));
      const first = rows[0];
      const cols = Object.keys(first).filter((c) => dbCols.has(c));
      if (cols.length === 0) {
        counts[table] = 0;
        continue;
      }

      const placeholders = cols.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT INTO ${safeIdent(table)} (${cols.map((c) => safeIdent(c)).join(',')}) VALUES (${placeholders})`);

      let n = 0;
      for (const raw of rows) {
        const vals = cols.map((c) => coerceCellForImport(c, raw[c]));
        if (vals.every((v) => v === null)) continue;
        stmt.run(...vals);
        n++;
      }
      counts[table] = n;
    }

    db.prepare('COMMIT').run();
    db.prepare('PRAGMA foreign_keys = ON').run();
    saveDb();
    return { ok: true, tables_imported: toProcess, rows_counts: counts, partial };
  } catch (e: any) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      /* ignore */
    }
    try {
      db.prepare('PRAGMA foreign_keys = ON').run();
    } catch {
      /* ignore */
    }
    return { ok: false, error: e?.message || 'Błąd importu' };
  }
}

/** Prefiks komórki Excela — pełna treść snapshotu jest w pliku ZIP (patrz `scenarioSnapshotExcelCell`). */
const FILE_MARKER_PREFIX = '__FILE__:';

/**
 * Rozpoznaje paczkę ZIP (Excel + scenarios/ + call-offs/) i odróżnia ją od samego .xlsx —
 * .xlsx też jest ZIP-em, ale zawiera `[Content_Types].xml`. Bez tego wgranie paczki na trasę
 * dla .xlsx kończyło się błędem SheetJS „Unsupported ZIP file”.
 */
export async function isCapacityBundlePackage(buf: Buffer): Promise<boolean> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  try {
    const zip = await JSZip.loadAsync(buf);
    if (zip.file('[Content_Types].xml')) return false;
    return Object.keys(zip.files).some((k) => !zip.files[k]!.dir && k.toLowerCase().endsWith('.xlsx'));
  } catch {
    return false;
  }
}

/**
 * Podmienia w arkuszu „scenarios” komórki `snapshot` z markerem `__FILE__:scenarios/scenario_{id}.json`
 * na realną treść z odpowiadającego pliku w paczce ZIP — inaczej import z samego Excela zapisałby
 * do bazy dosłowny tekst markera i zepsuł scenariusz (duże snapshoty nie mieszczą się w komórce Excela).
 */
async function patchScenarioSnapshotFileMarkers(wb: XLSX.WorkBook, zip: JSZip): Promise<number> {
  const sheetName = 'scenarios';
  if (!wb.SheetNames.includes(sheetName)) return 0;
  const ws = wb.Sheets[sheetName];
  const ref = ws['!ref'];
  if (!ref) return 0;
  const range = XLSX.utils.decode_range(ref);

  let snapshotCol = -1;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const headerCell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })];
    if (headerCell && String(headerCell.v ?? '').trim().toLowerCase() === 'snapshot') {
      snapshotCol = c;
      break;
    }
  }
  if (snapshotCol < 0) return 0;

  let patched = 0;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: snapshotCol });
    const cell = ws[addr];
    const raw = cell?.v;
    if (typeof raw !== 'string' || !raw.startsWith(FILE_MARKER_PREFIX)) continue;
    const zipPath = raw.slice(FILE_MARKER_PREFIX.length).trim().replace(/\\/g, '/');
    const entry = zip.file(zipPath) ?? zip.file(zipPath.replace(/^\/+/, ''));
    if (!entry) continue;
    try {
      const text = await entry.async('string');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const snap = parsed.snapshot;
      const snapStr = typeof snap === 'string' ? snap : JSON.stringify(snap ?? null);
      ws[addr] = { t: 's', v: snapStr };
      patched++;
    } catch {
      /* zostaw marker — wiersz zaimportuje się z niepoprawnym snapshotem, ale resztę pliku importujemy dalej */
    }
  }
  return patched;
}

export type ImportBundlePackageResult =
  | (Extract<ImportBundleResult, { ok: true }> & { call_offs_restored: number; scenario_snapshots_restored: number })
  | { ok: false; error: string };

/**
 * Import z pełnej paczki ZIP pobranej z `/capacity-bundle-template.xlsx` (Excel + scenarios/*.json + call-offs/).
 * W przeciwieństwie do `importCapacityBundleFromBuffer` (tylko .xlsx) odtwarza też duże snapshoty scenariuszy
 * (które w samym Excelu są tylko markerem `__FILE__:...`) oraz katalog call-offs/ (pliki źródłowe SalesFcst).
 */
export async function importCapacityBundlePackageFromZipBuffer(
  zipBuf: Buffer,
  options?: { onlyTables?: string[] | null }
): Promise<ImportBundlePackageResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Niepoprawne archiwum ZIP.' };
  }

  let excelName: string | null = null;
  const manifestEntry = zip.file('MANIFEST.json');
  if (manifestEntry) {
    try {
      const manifest = JSON.parse(await manifestEntry.async('string')) as { excel?: string };
      if (manifest.excel && zip.file(manifest.excel)) excelName = manifest.excel;
    } catch {
      /* ignore — spróbuj wykryć plik po rozszerzeniu */
    }
  }
  if (!excelName) {
    excelName =
      Object.keys(zip.files).find((k) => !zip.files[k]!.dir && !k.includes('/') && k.toLowerCase().endsWith('.xlsx')) ?? null;
  }
  if (!excelName) {
    return { ok: false, error: 'W archiwum ZIP nie znaleziono pliku .xlsx (np. capacity_baza_szablon.xlsx).' };
  }

  const excelEntry = zip.file(excelName);
  if (!excelEntry) {
    return { ok: false, error: `Brak pliku „${excelName}” w archiwum ZIP.` };
  }
  const excelBuf = await excelEntry.async('nodebuffer');

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(excelBuf, { type: 'buffer', cellDates: true } as XLSX.ParsingOptions);
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Niepoprawny plik Excel w archiwum ZIP.' };
  }

  const scenarioSnapshotsRestored = await patchScenarioSnapshotFileMarkers(wb, zip);

  const result = importCapacityBundleFromWorkbook(wb, options);
  if (!result.ok) return result;

  const onlyTables = options?.onlyTables ?? null;
  const includeCallOffs =
    !onlyTables?.length || onlyTables.some((t) => t === 'call_off_comparisons' || t === 'call_off_volumes');
  let callOffsRestored = 0;
  if (includeCallOffs) {
    try {
      callOffsRestored = await extractZipFolderToDisk(zip, 'call-offs', getCallOffsStorageRoot());
    } catch {
      callOffsRestored = 0;
    }
  }

  return { ...result, call_offs_restored: callOffsRestored, scenario_snapshots_restored: scenarioSnapshotsRestored };
}
