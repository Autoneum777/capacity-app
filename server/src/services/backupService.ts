import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { db, getDatabasePath, restoreDbFromBackupFile, saveDb } from '../db/connection.js';
import { getCallOffsStorageRoot } from './callOffFileService.js';
import { resolveAttachmentsDirectory } from './projectAttachmentService.js';
import { resolveStoragePath } from '../utils/storagePath.js';

const DEFAULT_BACKUP_DIR = 'backups';
const EXCEL_CELL_MAX = 32000;

export type BackupReason = 'manual' | 'scheduled' | 'before_data_import' | 'before_machines_import';

export type BackupResult = {
  filePath: string;
  at: string;
  kind: 'zip';
  included: { database: boolean; call_offs: boolean; attachments: boolean; scenarios_count: number };
};

function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value != null ? String(row.value) : null;
}

function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function resolveBackupDir(rawDir: string): string {
  return resolveStoragePath(rawDir, DEFAULT_BACKUP_DIR);
}

function getBackupOutputDir(): string {
  const outDirRaw = getSetting('backup_output_dir');
  return resolveBackupDir(outDirRaw?.trim() || DEFAULT_BACKUP_DIR);
}

function formatStamp(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/** Rekursywnie dodaje katalog do ZIP (ścieżki względne z prefixem). */
export function addDirectoryToZip(zip: JSZip, absDir: string, zipPrefix: string): number {
  if (!fs.existsSync(absDir)) return 0;
  let count = 0;
  const prefix = zipPrefix.replace(/\\/g, '/').replace(/\/?$/, '/');
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.' || name === '..') continue;
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const nextRel = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        walk(full, nextRel);
      } else if (st.isFile()) {
        zip.file(`${prefix}${nextRel.replace(/\\/g, '/')}`, fs.readFileSync(full));
        count++;
      }
    }
  };
  walk(absDir, '');
  return count;
}

function clearDirectoryContents(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    fs.rmSync(full, { recursive: true, force: true });
  }
}

export async function extractZipFolderToDisk(
  zip: JSZip,
  zipFolderPrefix: string,
  targetDir: string
): Promise<number> {
  const prefix = zipFolderPrefix.replace(/\\/g, '/').replace(/\/?$/, '/');
  const entries = Object.keys(zip.files).filter((k) => k.replace(/\\/g, '/').startsWith(prefix) && !zip.files[k]!.dir);
  if (!entries.length) return 0;
  clearDirectoryContents(targetDir);
  let n = 0;
  for (const key of entries) {
    const rel = key.replace(/\\/g, '/').slice(prefix.length);
    if (!rel || rel.includes('..')) continue;
    const dest = path.join(targetDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = await zip.files[key]!.async('nodebuffer');
    fs.writeFileSync(dest, data);
    n++;
  }
  return n;
}

/**
 * Pełny backup: ZIP z capacity.db + call-offs/ + attachments/ + scenarios/*.json (snapshoty).
 * Scenariusze są też w .db — pliki JSON ułatwiają odzyskanie i kompletność pakietu.
 */
export async function performDatabaseBackup(reason: BackupReason): Promise<BackupResult> {
  const dbPath = getDatabasePath();
  const outDir = getBackupOutputDir();
  fs.mkdirSync(outDir, { recursive: true });
  saveDb();

  const stamp = formatStamp(new Date());
  const reasonTag = reason === 'before_data_import' ? 'pre-import' : reason;
  const fileName = `capacity-backup-${reasonTag}-${stamp}.zip`;
  const targetPath = path.join(outDir, fileName);

  const zip = new JSZip();
  zip.file('capacity.db', fs.readFileSync(dbPath));
  zip.file(
    'MANIFEST.json',
    JSON.stringify(
      {
        format: 'capacity-full-backup-v1',
        created_at: new Date().toISOString(),
        reason,
        contents: ['capacity.db', 'call-offs/', 'attachments/', 'scenarios/'],
      },
      null,
      2
    )
  );

  let callOffsFiles = 0;
  try {
    callOffsFiles = addDirectoryToZip(zip, getCallOffsStorageRoot(), 'call-offs');
  } catch {
    callOffsFiles = 0;
  }

  let attachmentFiles = 0;
  try {
    const attDir = resolveAttachmentsDirectory();
    if (attDir && fs.existsSync(attDir)) {
      attachmentFiles = addDirectoryToZip(zip, attDir, 'attachments');
    }
  } catch {
    attachmentFiles = 0;
  }

  let scenariosCount = 0;
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
      zip.file(
        `scenarios/scenario_${id}.json`,
        JSON.stringify({ ...r, snapshot: snap }, null, 2)
      );
      scenariosCount++;
    }
  } catch {
    scenariosCount = 0;
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(targetPath, buf);

  const nowIso = new Date().toISOString();
  setSetting('backup_last_at', nowIso);
  setSetting('backup_last_file', targetPath);
  setSetting('backup_last_reason', reason);
  saveDb();

  return {
    filePath: targetPath,
    at: nowIso,
    kind: 'zip',
    included: {
      database: true,
      call_offs: callOffsFiles > 0,
      attachments: attachmentFiles > 0,
      scenarios_count: scenariosCount,
    },
  };
}

export type RestoreBackupResult = {
  restored_from: string;
  restored_database: boolean;
  restored_call_offs_files: number;
  restored_attachment_files: number;
  restored_scenarios_from_json: number;
};

/**
 * Przywraca pełny backup (.zip) lub legacy (.db).
 * Dla ZIP: baza + katalogi call-offs i attachments.
 */
export async function restoreFromBackupArchive(backupFilePath: string): Promise<RestoreBackupResult> {
  const resolved = path.resolve(backupFilePath);
  if (!fs.existsSync(resolved)) throw new Error(`Plik backupu nie istnieje: ${resolved}`);
  const lower = resolved.toLowerCase();

  if (lower.endsWith('.db')) {
    await restoreDbFromBackupFile(resolved);
    return {
      restored_from: resolved,
      restored_database: true,
      restored_call_offs_files: 0,
      restored_attachment_files: 0,
      restored_scenarios_from_json: 0,
    };
  }

  if (!lower.endsWith('.zip')) {
    throw new Error('Nieobsługiwany format backupu — oczekiwano .zip (pełny) lub .db (legacy).');
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(resolved));
  const dbEntry =
    zip.file('capacity.db') ||
    Object.keys(zip.files)
      .map((k) => zip.files[k]!)
      .find((f) => !f.dir && f.name.toLowerCase().endsWith('.db'));
  if (!dbEntry) throw new Error('W archiwum backupu brak pliku capacity.db.');

  const tmpDir = path.join(getBackupOutputDir(), `.restore-tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpDb = path.join(tmpDir, 'capacity.db');
  try {
    fs.writeFileSync(tmpDb, await dbEntry.async('nodebuffer'));
    await restoreDbFromBackupFile(tmpDb);

    let callOffs = 0;
    try {
      callOffs = await extractZipFolderToDisk(zip, 'call-offs', getCallOffsStorageRoot());
    } catch {
      callOffs = 0;
    }

    let attachments = 0;
    try {
      const attDir = resolveAttachmentsDirectory();
      if (attDir) {
        attachments = await extractZipFolderToDisk(zip, 'attachments', attDir);
      }
    } catch {
      attachments = 0;
    }

    /** Uzupełnij scenariusze z JSON, jeśli w ZIP są kompletniejsze snapshoty. */
    let scenariosFromJson = 0;
    const scenarioFiles = Object.keys(zip.files).filter(
      (k) => k.replace(/\\/g, '/').startsWith('scenarios/') && k.toLowerCase().endsWith('.json') && !zip.files[k]!.dir
    );
    if (scenarioFiles.length) {
      const cols = (
        db.prepare(`PRAGMA table_info(scenarios)`).all() as { name: string }[]
      ).map((c) => c.name);
      for (const key of scenarioFiles) {
        try {
          const raw = JSON.parse(await zip.files[key]!.async('string')) as Record<string, unknown>;
          const id = Number(raw.id);
          if (!Number.isFinite(id) || raw.snapshot == null) continue;
          const snap =
            typeof raw.snapshot === 'string' ? raw.snapshot : JSON.stringify(raw.snapshot);
          const row: Record<string, unknown> = { ...raw, id, snapshot: snap };
          const useCols = cols.filter((c) => row[c] !== undefined);
          if (!useCols.includes('id') || !useCols.includes('snapshot')) continue;
          const placeholders = useCols.map(() => '?').join(',');
          const updates = useCols
            .filter((c) => c !== 'id')
            .map((c) => `${c} = excluded.${c}`)
            .join(', ');
          db.prepare(
            `INSERT INTO scenarios (${useCols.join(',')}) VALUES (${placeholders})
             ON CONFLICT(id) DO UPDATE SET ${updates}`
          ).run(...useCols.map((c) => (row[c] == null ? null : row[c])));
          scenariosFromJson++;
        } catch {
          /* skip bad json */
        }
      }
      if (scenariosFromJson > 0) saveDb();
    }

    return {
      restored_from: resolved,
      restored_database: true,
      restored_call_offs_files: callOffs,
      restored_attachment_files: attachments,
      restored_scenarios_from_json: scenariosFromJson,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function resolveBackupDirectory(rawDir: string): string {
  return resolveBackupDir(rawDir);
}

/** Marker w komórce Excela gdy snapshot scenariusza jest za duży — pełna treść w ZIP scenarios/. */
export function scenarioSnapshotExcelCell(snapshot: unknown, scenarioId: number): string {
  const s = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot ?? null);
  if (s.length <= EXCEL_CELL_MAX) return s;
  return `__FILE__:scenarios/scenario_${scenarioId}.json`;
}

export { EXCEL_CELL_MAX };
