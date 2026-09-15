import { Router } from 'express';
import multer from 'multer';
import { db, saveDb } from '../db/connection.js';
import {
  cleanupOrphanPartsForProject,
  deleteOperationInProject,
  deleteOperationYearVolumeInProject,
} from '../services/operationDeleteService.js';
import { formatDetailSapAliasLabel, type ReferenceDisplayMode } from '../utils/detailLabel.js';
import { loadReferenceDisplayMode } from '../utils/referenceDisplayMode.js';
import {
  ATTACHMENTS_STORAGE_NOT_CONFIGURED,
  createProjectAttachment,
  deleteProjectAttachment,
  getAttachmentAbsolutePath,
  getProjectAttachment,
  isAttachmentsStorageConfigured,
  listAllProjectIds,
  listProjectAttachments,
  resolveAttachmentsDirectory,
} from '../services/projectAttachmentService.js';
import { parseCsvQueryParamSingleOrMulti, parseIdList, parseMachineStatusList, sqlInClause } from '../utils/queryListParams.js';
import { normalizeClientName, parseClientFilterQuery } from '../utils/clientName.js';
import { formatSopEop, sopEopYearsRange } from '../utils/sopEopFormat.js';
import { resolveActor } from '../utils/authActor.js';

export const projectsRouter = Router();

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

projectsRouter.use((req, _res, next) => {
  (req as { referenceDisplay?: ReferenceDisplayMode }).referenceDisplay = loadReferenceDisplayMode();
  next();
});

function referenceModeFromReq(req: any): ReferenceDisplayMode {
  return (req?.referenceDisplay as ReferenceDisplayMode | undefined) ?? 'both';
}

function operationCopySourceLabel(r: {
  detail_sap_number?: string | null;
  detail_alias?: string | null;
  detail_free_text?: string | null;
  machine_internal?: unknown;
  machine_type?: string | null;
  phase_name?: string | null;
  cycle_time_seconds?: number | null;
  is_set?: number | null;
}, refMode: ReferenceDisplayMode): string {
  const detailRef = formatDetailSapAliasLabel(
    {
      sap_number: r.detail_sap_number,
      alias: r.detail_alias,
      free_text: r.detail_free_text,
    },
    refMode
  );
  const detailPart = String(detailRef).replace(/\s*\(#\d+\)\s*$/u, '').trim() || '—';
  const mn = r.machine_internal != null ? String(r.machine_internal) : '?';
  const mt = r.machine_type != null ? String(r.machine_type) : '';
  const setMark = Number(r.is_set) === 1 ? ' · set' : '';
  return `${detailPart} · ${mn}${mt ? ` (${mt})` : ''} · ${r.phase_name || '—'} · ${r.cycle_time_seconds ?? '?'}s${setMark}`;
}

type NoteContext = {
  machineId?: number | null;
  partId?: number | null;
  operationId?: number | null;
};

function isManualProjectNote(note: { note_type?: string | null }): boolean {
  return String(note.note_type ?? 'manual') !== 'auto';
}

function manualNoteOwnerError(note: { author?: string | null; note_type?: string | null }, actor: string): string | null {
  if (!isManualProjectNote(note)) return 'Tylko notatki ręczne można edytować lub usuwać.';
  const author = String(note.author ?? '').trim();
  if (!author || author.toLowerCase() !== actor.trim().toLowerCase()) {
    return 'Możesz edytować lub usuwać tylko własne notatki.';
  }
  return null;
}

function insertProjectNote(
  projectId: number,
  note: string,
  author: string,
  noteType: 'manual' | 'auto' = 'auto',
  noteDate?: string,
  context?: NoteContext
): void {
  const dateValue = noteDate && String(noteDate).trim() ? String(noteDate).trim() : new Date().toISOString().slice(0, 10);
  const machineId = context?.machineId != null && Number.isFinite(Number(context.machineId)) ? Number(context.machineId) : null;
  const partId = context?.partId != null && Number.isFinite(Number(context.partId)) ? Number(context.partId) : null;
  const operationId = context?.operationId != null && Number.isFinite(Number(context.operationId)) ? Number(context.operationId) : null;
  try {
    db
      .prepare(
        'INSERT INTO project_notes (project_id, note_date, author, note, note_type, machine_id, part_id, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(projectId, dateValue, author || null, note, noteType, machineId, partId, operationId);
  } catch (e1) {
    try {
      db.prepare('INSERT INTO project_notes (project_id, note_date, author, note, note_type) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, dateValue, author || null, note, noteType);
    } catch (e2) {
      db.prepare('INSERT INTO project_notes (project_id, note_date, author, note) VALUES (?, ?, ?, ?)')
        .run(projectId, dateValue, author || null, note);
    }
  }
}

function formatDetailLabel(
  detail: {
    id?: number;
    sap_number?: string | null;
    alias?: string | null;
    free_text?: string | null;
    designation?: string | null;
  },
  mode: ReferenceDisplayMode
): string {
  return formatDetailSapAliasLabel(detail, mode);
}

function applyPartDesignationToOperationRow(row: any, mode: ReferenceDisplayMode): void {
  row.part_designation = formatDetailSapAliasLabel(
    {
      sap_number: row._op_sap,
      alias: row._op_alias,
      free_text: row._op_free,
      designation: row._op_pt_des,
      id: row.part_id,
    },
    mode
  );
  delete row._op_sap;
  delete row._op_alias;
  delete row._op_free;
  delete row._op_pt_des;
}

function enrichSetMembersWithLabels(members: any[], mode: ReferenceDisplayMode): { part_id: number; quantity_per_set: number; label: string }[] {
  return members.map((m) => ({
    part_id: Number(m.part_id),
    quantity_per_set: Number(m.quantity_per_set ?? 1),
    label: formatDetailSapAliasLabel(
      {
        sap_number: m.m_sap,
        alias: m.m_alias,
        free_text: m.m_free,
        designation: m.m_des,
        id: m.part_id,
      },
      mode
    ),
  }));
}

function getPartLabel(partId: number, mode: ReferenceDisplayMode): string {
  const row = db.prepare(`
    SELECT pt.id, pt.designation, pd.sap_number, pd.alias, pd.free_text
    FROM parts pt
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    WHERE pt.id = ?
  `).get(partId) as any;
  if (!row) return `detal #${partId}`;
  return formatDetailLabel(row, mode);
}

function getMachineLabel(machineId: number): string {
  const row = db.prepare('SELECT sap_number, internal_number FROM machines WHERE id = ?').get(machineId) as any;
  const sap = String(row?.sap_number ?? '').trim();
  const internal = String(row?.internal_number ?? '').trim();
  if (sap && internal) return `${sap} (${internal})`;
  if (sap) return sap;
  if (internal) return internal;
  return `maszyna #${machineId}`;
}

function formatProjectSopEopFields<T extends { sop?: unknown; eop?: unknown; eop_original?: unknown | null }>(row: T): T {
  return {
    ...row,
    sop: formatSopEop(row.sop),
    eop: formatSopEop(row.eop),
    eop_original: row.eop_original != null && row.eop_original !== '' ? formatSopEop(row.eop_original) : row.eop_original,
  };
}

/** Zwraca listę lat z zakresu SOP–EOP oraz rok z EOP (do usunięcia wolumenów poza zakresem). */
function getSopEopYears(sop: string, eop: string): { years: number[]; eopYear: number } {
  const { years } = sopEopYearsRange(sop, eop);
  const eopYear = years.length > 0 ? years[years.length - 1] : 0;
  return { years, eopYear };
}

/** Synchronizuje project_volumes i project_volumes_contract z zakresem SOP–EOP: dodaje brakujące lata (0, annual), usuwa lata > eopYear. */
function syncProjectVolumesToSopEop(projectId: number, sop: string, eop: string): void {
  const { years, eopYear } = getSopEopYears(sop, eop);
  const syncOne = (table: 'project_volumes' | 'project_volumes_contract') => {
    const existing = db.prepare(`SELECT year FROM ${table} WHERE project_id = ?`).all(projectId) as { year: number }[];
    const existingSet = new Set(existing.map((r) => r.year));
    const toAdd = years.filter((y) => !existingSet.has(y));
    const toDelete = existing.filter((r) => r.year > eopYear).map((r) => r.year);
    const delStmt = db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND year = ?`);
    for (const y of toDelete) delStmt.run(projectId, y);
    try {
      const ins = db.prepare(
        `INSERT INTO ${table} (project_id, year, volume_value, volume_unit, include_in_calculator_after_eop) VALUES (?, ?, ?, ?, ?)`
      );
      for (const y of toAdd) ins.run(projectId, y, 0, 'annual', 0);
    } catch (_) {
      const ins = db.prepare(`INSERT INTO ${table} (project_id, year, volume_value, volume_unit) VALUES (?, ?, 0, ?)`);
      for (const y of toAdd) ins.run(projectId, y, 'annual');
    }
  };
  syncOne('project_volumes');
  try {
    syncOne('project_volumes_contract');
  } catch (_) {
    /* brak tabeli kontraktowej (stara baza przed migracją) */
  }
}

const PART_VOLUME_YEAR_TABLES = [
  'part_volume_by_year',
  'part_volume_contract_by_year',
  'part_volume_share_by_year',
  'part_volume_contract_share_by_year',
] as const;

/** Usuwa lata wolumenów detali poza zakresem SOP–EOP (po skróceniu EOP). */
function syncPartVolumesToSopEop(projectId: number, sop: string, eop: string): void {
  const { eopYear } = getSopEopYears(sop, eop);
  if (eopYear <= 0) return;
  const partIds = (db.prepare('SELECT id FROM parts WHERE project_id = ?').all(projectId) as { id: number }[]).map((p) => p.id);
  for (const partId of partIds) {
    for (const table of PART_VOLUME_YEAR_TABLES) {
      try {
        const rows = db.prepare(`SELECT year FROM ${table} WHERE part_id = ? AND year > ?`).all(partId, eopYear) as { year: number }[];
        const delStmt = db.prepare(`DELETE FROM ${table} WHERE part_id = ? AND year = ?`);
        for (const { year } of rows) delStmt.run(partId, year);
      } catch (_) {
        /* tabela opcjonalna */
      }
    }
  }
}

/** Synchronizuje wolumeny projektu i detali z zakresem SOP–EOP. */
function syncVolumesToSopEop(projectId: number, sop: string, eop: string): void {
  syncProjectVolumesToSopEop(projectId, sop, eop);
  syncPartVolumesToSopEop(projectId, sop, eop);
}

/**
 * Drzewo projektów RFQ z detalami i operacjami — do filtra "Pokaż detale RFQ" w kalkulatorze.
 * Struktura: klienci → projekty → detale → operacje (maszyny).
 */
projectsRouter.get('/rfq-filter-tree', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const rows = db.prepare(`
    SELECT p.id AS project_id, p.name AS project_name, p.client,
           pt.id AS part_id,
           pd.designation, pd.sap_number, pd.alias, pd.free_text, pt.designation_id,
           o.id AS operation_id,
           m.id AS machine_id, m.internal_number, m.sap_number AS machine_sap, m.location
    FROM projects p
    JOIN parts pt ON pt.project_id = p.id
    JOIN operations o ON o.part_id = pt.id
    JOIN machines m ON m.id = o.machine_id
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    WHERE p.status = 'RFQ'
    ORDER BY p.client, p.name, pt.id, o.id
  `).all() as any[];

  // Grupowanie: klient → projekt → detal → operacje
  const clientMap = new Map<string, {
    client: string;
    projects: Map<number, {
      id: number;
      name: string;
      parts: Map<number, {
        id: number;
        label: string;
        operations: { id: number; label: string; machine_id: number; location: string | null }[];
      }>;
    }>;
  }>();

  for (const row of rows) {
    const client = String(row.client ?? '').trim();
    if (!clientMap.has(client)) clientMap.set(client, { client, projects: new Map() });
    const clientEntry = clientMap.get(client)!;

    if (!clientEntry.projects.has(row.project_id)) {
      clientEntry.projects.set(row.project_id, { id: row.project_id, name: String(row.project_name ?? ''), parts: new Map() });
    }
    const proj = clientEntry.projects.get(row.project_id)!;

    if (!proj.parts.has(row.part_id)) {
      const detailLabel = formatDetailSapAliasLabel(
        { sap_number: row.sap_number, alias: row.alias, free_text: row.free_text, designation: row.designation, id: row.part_id },
        refMode
      );
      proj.parts.set(row.part_id, { id: row.part_id, label: detailLabel, operations: [] });
    }
    const part = proj.parts.get(row.part_id)!;

    const machineSap = String(row.machine_sap ?? '').trim();
    const machineInternal = row.internal_number != null ? String(row.internal_number).trim() : '';
    const machineLabel = machineSap && machineInternal
      ? `${machineSap} (${machineInternal})`
      : machineSap || machineInternal || `M${row.machine_id}`;

    if (!part.operations.find((o) => o.id === row.operation_id)) {
      part.operations.push({
        id: Number(row.operation_id),
        label: machineLabel,
        machine_id: Number(row.machine_id),
        location: row.location != null ? String(row.location) : null,
      });
    }
  }

  res.json({
    clients: Array.from(clientMap.values()).map((c) => ({
      client: c.client,
      projects: Array.from(c.projects.values()).map((p) => ({
        id: p.id,
        name: p.name,
        parts: Array.from(p.parts.values()).map((pt) => ({
          id: pt.id,
          label: pt.label,
          operations: pt.operations,
        })),
      })),
    })),
  });
});

projectsRouter.get('/', (req, res) => {
  const statuses = parseMachineStatusList(req.query.status, req.query.statuses);
  const clients = parseClientFilterQuery(req.query.client, req.query.clients);
  const search = (req.query.search as string)?.trim();

  let sql = `
    SELECT p.id, p.client, p.name, p.sop, p.eop, p.status
    FROM projects p
    WHERE 1=1
  `;
  const params: (string | number)[] = [];
  if (statuses.length === 1) {
    sql += ' AND p.status = ?';
    params.push(statuses[0]);
  } else if (statuses.length > 1) {
    const statusIn = sqlInClause(statuses, 'p.status');
    sql += ` AND ${statusIn.clause}`;
    params.push(...statusIn.params);
  }
  if (clients.length === 1) {
    sql += ' AND p.client = ?';
    params.push(clients[0]);
  } else if (clients.length > 1) {
    const clientIn = sqlInClause(clients, 'p.client');
    sql += ` AND ${clientIn.clause}`;
    params.push(...clientIn.params);
  }
  if (search) {
    sql += ' AND (p.client LIKE ? OR p.name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  sql += ' ORDER BY p.client, p.name';

  const list = db.prepare(sql).all(...params) as any[];
  const withMeta = list.map((p) => {
    const machineRows = db.prepare(`
      SELECT DISTINCT m.id AS machine_id, m.internal_number, m.sap_number, m.type AS machine_type, m.status AS machine_status
      FROM operations o
      JOIN machines m ON m.id = o.machine_id
      WHERE o.project_id = ?
      ORDER BY m.internal_number
    `).all(p.id) as { machine_id: number; internal_number: string | number; sap_number: string | null; machine_type?: string | null; machine_status?: string | null }[];
    const partRows = db
      .prepare(
        `SELECT pt.id, pt.designation, pd.sap_number AS detail_sap_number, pd.alias AS detail_alias, pd.free_text AS detail_free_text
         FROM parts pt
         LEFT JOIN part_designations pd ON pd.id = pt.designation_id
         WHERE pt.project_id = ?`
      )
      .all(p.id) as any[];
    return formatProjectSopEopFields({
      ...p,
      machines: machineRows,
      parts: partRows,
    });
  });
  res.json(withMeta);
});

projectsRouter.get('/clients', (_req, res) => {
  const rows = db.prepare('SELECT DISTINCT client FROM projects WHERE TRIM(client) <> "" ORDER BY client').all() as {
    client: string;
  }[];
  const seen = new Set<string>();
  const clients: string[] = [];
  for (const r of rows) {
    const n = normalizeClientName(r.client);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    clients.push(n);
  }
  clients.sort((a, b) => a.localeCompare(b, 'pl'));
  res.json(clients);
});

/** Drzewo filtrów RFQ: klient → projekt → detal → operacje (tylko projekty status=RFQ). */
projectsRouter.get('/rfq-filter-tree', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projects = db
    .prepare(`SELECT id, client, name FROM projects WHERE status = 'RFQ' ORDER BY client, name`)
    .all() as { id: number; client: string; name: string }[];

  if (!projects.length) {
    return res.json({ clients: [] });
  }

  const projectIds = projects.map((p) => p.id);
  const parts = db
    .prepare(
      `SELECT pt.id, pt.project_id, pt.designation,
              pd.sap_number AS detail_sap_number, pd.alias AS detail_alias, pd.free_text AS detail_free_text
       FROM parts pt
       LEFT JOIN part_designations pd ON pd.id = pt.designation_id
       WHERE pt.project_id IN (${projectIds.map(() => '?').join(',')})
       ORDER BY pt.id`
    )
    .all(...projectIds) as {
    id: number;
    project_id: number;
    designation: string | null;
    detail_sap_number: string | null;
    detail_alias: string | null;
    detail_free_text: string | null;
  }[];

  const ops = db
    .prepare(
      `SELECT o.id, o.project_id, o.part_id, o.machine_id,
              m.location AS machine_location,
              ph.name AS phase_name,
              m.internal_number AS machine_internal,
              m.type AS machine_type
       FROM operations o
       JOIN process_phases ph ON ph.id = o.phase_id
       JOIN machines m ON m.id = o.machine_id
       WHERE o.project_id IN (${projectIds.map(() => '?').join(',')})
       ORDER BY o.part_id, ph.name, m.internal_number`
    )
    .all(...projectIds) as {
    id: number;
    project_id: number;
    part_id: number;
    machine_id: number;
    machine_location: string | null;
    phase_name: string | null;
    machine_internal: string | number | null;
    machine_type: string | null;
  }[];

  const opsByPart = new Map<number, typeof ops>();
  for (const op of ops) {
    const list = opsByPart.get(op.part_id) ?? [];
    list.push(op);
    opsByPart.set(op.part_id, list);
  }

  const partsByProject = new Map<number, typeof parts>();
  for (const part of parts) {
    const list = partsByProject.get(part.project_id) ?? [];
    list.push(part);
    partsByProject.set(part.project_id, list);
  }

  const byClient = new Map<
    string,
    {
      client: string;
      projects: {
        id: number;
        name: string;
        parts: {
          id: number;
          label: string;
          operations: {
            id: number;
            label: string;
            machine_id: number;
            location: string | null;
          }[];
        }[];
      }[];
    }
  >();

  for (const p of projects) {
    const client = normalizeClientName(p.client) || String(p.client ?? '').trim() || '—';
    if (!byClient.has(client)) byClient.set(client, { client, projects: [] });
    const projectParts = (partsByProject.get(p.id) ?? [])
      .map((part) => {
        const partOps = (opsByPart.get(part.id) ?? []).map((op) => {
          const phase = String(op.phase_name ?? '').trim() || '—';
          const machine = [op.machine_internal, op.machine_type].filter((x) => x != null && String(x).trim()).join(' · ');
          return {
            id: op.id,
            label: machine ? `${phase} · ${machine}` : phase,
            machine_id: Number(op.machine_id),
            location: op.machine_location != null ? String(op.machine_location) : null,
          };
        });
        if (!partOps.length) return null;
        return {
          id: part.id,
          label: formatDetailSapAliasLabel(
            {
              sap_number: part.detail_sap_number,
              alias: part.detail_alias,
              free_text: part.detail_free_text,
              designation: part.designation,
              id: part.id,
            },
            refMode
          ),
          operations: partOps,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    if (!projectParts.length) continue;
    byClient.get(client)!.projects.push({
      id: p.id,
      name: String(p.name ?? '').trim() || `Project #${p.id}`,
      parts: projectParts,
    });
  }

  const treeClients = [...byClient.values()]
    .filter((c) => c.projects.length > 0)
    .sort((a, b) => a.client.localeCompare(b.client, 'pl'));

  res.json({ clients: treeClients });
});

projectsRouter.get('/session/actor', (req, res) => {
  res.json({ login: resolveActor(req) });
});

projectsRouter.get('/history/filters', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projects = db.prepare('SELECT id, client, name FROM projects ORDER BY client, name').all() as { id: number; client: string; name: string }[];
  const clients = db.prepare('SELECT DISTINCT client FROM projects WHERE TRIM(client) <> "" ORDER BY client').all() as { client: string }[];
  const clientNames = [...new Set(clients.map((r) => normalizeClientName(r.client)).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'pl')
  );
  const machines = db.prepare('SELECT id, sap_number, internal_number, type FROM machines ORDER BY sap_number, internal_number').all() as {
    id: number;
    sap_number: string | null;
    internal_number: string | null;
    type: string | null;
  }[];
  const details = db.prepare(`
    SELECT pt.id, pd.sap_number, pd.alias, pd.free_text, pt.designation
    FROM parts pt
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    ORDER BY COALESCE(pd.sap_number, ''), COALESCE(pd.alias, ''), pt.id
  `).all() as any[];
  const authors = db.prepare('SELECT DISTINCT author FROM project_notes WHERE TRIM(COALESCE(author, "")) <> "" ORDER BY author').all() as { author: string }[];
  res.json({
    projects,
    clients: clientNames,
    machines,
    details: details.map((d) => ({ id: Number(d.id), label: formatDetailLabel(d, refMode) })),
    authors: authors.map((r) => r.author),
  });
});

projectsRouter.get('/history', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projectIds = parseIdList(req.query.projectId, req.query.projectIds);
  const machineIds = parseIdList(req.query.machineId, req.query.machineIds);
  const partIds = parseIdList(req.query.partId, req.query.partIds);
  const clients = parseClientFilterQuery(req.query.client, req.query.clients);
  const authors = parseCsvQueryParamSingleOrMulti(req.query.author, req.query.authors);
  const text = String(req.query.text ?? '').trim();

  let sql = `
    SELECT
      n.id,
      n.project_id,
      n.note_date,
      n.author,
      n.note,
      COALESCE(n.note_type, 'manual') AS note_type,
      COALESCE(n.machine_id, op.machine_id) AS machine_id,
      COALESCE(n.part_id, op.part_id) AS part_id,
      COALESCE(n.operation_id, op.id) AS operation_id,
      p.client,
      p.name AS project_name,
      m.sap_number AS machine_sap_number,
      m.internal_number AS machine_internal_number,
      m.type AS machine_type,
      pd.sap_number AS detail_sap_number,
      pd.alias AS detail_alias,
      pd.free_text AS detail_free_text,
      pt.designation AS detail_designation
    FROM project_notes n
    JOIN projects p ON p.id = n.project_id
    LEFT JOIN operations op ON op.id = n.operation_id
    LEFT JOIN machines m ON m.id = COALESCE(n.machine_id, op.machine_id)
    LEFT JOIN parts pt ON pt.id = COALESCE(n.part_id, op.part_id)
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    WHERE 1=1
  `;
  const params: Array<number | string> = [];
  if (projectIds.length === 1) {
    sql += ' AND n.project_id = ?';
    params.push(projectIds[0]);
  } else if (projectIds.length > 1) {
    const projectIn = sqlInClause(projectIds, 'n.project_id');
    sql += ` AND ${projectIn.clause}`;
    params.push(...projectIn.params);
  }
  if (machineIds.length === 1) {
    sql += ' AND COALESCE(n.machine_id, op.machine_id) = ?';
    params.push(machineIds[0]);
  } else if (machineIds.length > 1) {
    const machineIn = sqlInClause(machineIds, 'COALESCE(n.machine_id, op.machine_id)');
    sql += ` AND ${machineIn.clause}`;
    params.push(...machineIn.params);
  }
  if (partIds.length === 1) {
    sql += ' AND COALESCE(n.part_id, op.part_id) = ?';
    params.push(partIds[0]);
  } else if (partIds.length > 1) {
    const partIn = sqlInClause(partIds, 'COALESCE(n.part_id, op.part_id)');
    sql += ` AND ${partIn.clause}`;
    params.push(...partIn.params);
  }
  if (clients.length === 1) {
    sql += ' AND p.client = ?';
    params.push(clients[0]);
  } else if (clients.length > 1) {
    const clientIn = sqlInClause(clients, 'p.client');
    sql += ` AND ${clientIn.clause}`;
    params.push(...clientIn.params);
  }
  if (authors.length === 1) {
    sql += ' AND n.author = ?';
    params.push(authors[0]);
  } else if (authors.length > 1) {
    const authorIn = sqlInClause(authors, 'n.author');
    sql += ` AND ${authorIn.clause}`;
    params.push(...authorIn.params);
  }
  if (text) {
    sql += ' AND (n.note LIKE ? OR COALESCE(n.author, "") LIKE ? OR p.name LIKE ? OR p.client LIKE ?)';
    const q = `%${text}%`;
    params.push(q, q, q, q);
  }
  sql += ' ORDER BY n.id DESC LIMIT 2000';
  const rows = db.prepare(sql).all(...params) as any[];
  const parseOperationIdFromNote = (note: string): number | null => {
    const m = String(note ?? '').match(/operacj(?:ę|e|i)\s*#(\d+)/i);
    if (!m) return null;
    const id = Number(m[1]);
    return Number.isFinite(id) && id > 0 ? id : null;
  };
  const parseDetailLabelFromNote = (note: string): string => {
    const m = String(note ?? '').match(/detalu\s+"([^"]+)"/i);
    return m?.[1]?.trim() || '';
  };
  const opIdsToLoad = new Set<number>();
  for (const r of rows) {
    if (r.machine_id != null || r.part_id != null || r.operation_id != null) continue;
    const opId = parseOperationIdFromNote(String(r.note ?? ''));
    if (opId != null) opIdsToLoad.add(opId);
  }
  const opMetaById = new Map<
    number,
    {
      machine_id: number | null;
      part_id: number | null;
      machine_sap_number: string | null;
      machine_internal_number: string | null;
      detail_sap_number: string | null;
      detail_alias: string | null;
      detail_free_text: string | null;
      detail_designation: string | null;
    }
  >();
  if (opIdsToLoad.size > 0) {
    const opIds = Array.from(opIdsToLoad);
    const placeholders = opIds.map(() => '?').join(', ');
    const opRows = db
      .prepare(`
        SELECT
          o.id,
          o.machine_id,
          o.part_id,
          m.sap_number AS machine_sap_number,
          m.internal_number AS machine_internal_number,
          pd.sap_number AS detail_sap_number,
          pd.alias AS detail_alias,
          pd.free_text AS detail_free_text,
          pt.designation AS detail_designation
        FROM operations o
        LEFT JOIN machines m ON m.id = o.machine_id
        LEFT JOIN parts pt ON pt.id = o.part_id
        LEFT JOIN part_designations pd ON pd.id = pt.designation_id
        WHERE o.id IN (${placeholders})
      `)
      .all(...opIds) as any[];
    for (const op of opRows) {
      opMetaById.set(Number(op.id), {
        machine_id: op.machine_id != null ? Number(op.machine_id) : null,
        part_id: op.part_id != null ? Number(op.part_id) : null,
        machine_sap_number: op.machine_sap_number ?? null,
        machine_internal_number: op.machine_internal_number ?? null,
        detail_sap_number: op.detail_sap_number ?? null,
        detail_alias: op.detail_alias ?? null,
        detail_free_text: op.detail_free_text ?? null,
        detail_designation: op.detail_designation ?? null,
      });
    }
  }
  res.json(
    rows.map((r) => {
      const parsedOpId = parseOperationIdFromNote(String(r.note ?? ''));
      const opMeta = parsedOpId != null ? opMetaById.get(parsedOpId) : undefined;
      const resolvedMachineId = r.machine_id ?? opMeta?.machine_id ?? null;
      const resolvedPartId = r.part_id ?? opMeta?.part_id ?? null;
      const machineSap = String(r.machine_sap_number ?? opMeta?.machine_sap_number ?? '').trim();
      const machineInternal = String(r.machine_internal_number ?? opMeta?.machine_internal_number ?? '').trim();
      let machineLabel = '';
      if (machineSap && machineInternal) machineLabel = `${machineSap} (${machineInternal})`;
      else if (machineSap) machineLabel = machineSap;
      else if (machineInternal) machineLabel = machineInternal;
      else if (resolvedMachineId != null) machineLabel = `maszyna #${resolvedMachineId}`;

      let detailLabel = '';
      if (resolvedPartId != null) {
        detailLabel = formatDetailLabel(
          {
            id: Number(resolvedPartId),
            sap_number: r.detail_sap_number ?? opMeta?.detail_sap_number ?? null,
            alias: r.detail_alias ?? opMeta?.detail_alias ?? null,
            free_text: r.detail_free_text ?? opMeta?.detail_free_text ?? null,
            designation: r.detail_designation ?? opMeta?.detail_designation ?? null,
          },
          refMode
        );
      } else {
        detailLabel = parseDetailLabelFromNote(String(r.note ?? ''));
      }
      return {
        ...r,
        machine_id: resolvedMachineId,
        part_id: resolvedPartId,
        operation_id: r.operation_id ?? parsedOpId ?? null,
        machine_label: machineLabel,
        detail_label: detailLabel,
      };
    })
  );
});

const OPERATIONS_COPY_SOURCES_SELECT = `
        SELECT
          o.id,
          o.project_id,
          TRIM(COALESCE(pr.client, '')) AS project_client,
          TRIM(COALESCE(pr.name, '')) AS project_name,
          o.machine_id,
          o.phase_id,
          o.cycle_time_seconds,
          o.nests_count,
          o.oee_override,
          o.is_set,
          o.alt_cycle_time_seconds,
          o.alt_nests_count,
          o.alt_oee_override,
          o.alt_comment,
          o.use_alternative_in_calculator,
          ph.name AS phase_name,
          m.internal_number AS machine_internal,
          m.sap_number AS machine_sap,
          m.type AS machine_type,
          pd.sap_number AS detail_sap_number,
          pd.alias AS detail_alias,
          pd.free_text AS detail_free_text,
          (SELECT pt.designation_id FROM parts pt WHERE pt.id = o.part_id) AS part_designation_id,
          (
            SELECT GROUP_CONCAT(designation_id)
            FROM (
              SELECT pt.designation_id AS designation_id
              FROM operation_set_members osm
              JOIN parts pt ON pt.id = osm.part_id
              WHERE osm.operation_id = o.id
              ORDER BY osm.part_id
            )
          ) AS set_designation_ids_csv
        FROM operations o
        JOIN projects pr ON pr.id = o.project_id
        JOIN process_phases ph ON ph.id = o.phase_id
        JOIN machines m ON m.id = o.machine_id
        LEFT JOIN parts pt_src ON pt_src.id = o.part_id
        LEFT JOIN part_designations pd ON pd.id = pt_src.designation_id`;

const OPERATIONS_COPY_SOURCES_SEARCH_WHERE = `
        WHERE pr.client LIKE ? COLLATE NOCASE
           OR pr.name LIKE ? COLLATE NOCASE
           OR ph.name LIKE ? COLLATE NOCASE
           OR CAST(m.internal_number AS TEXT) LIKE ? COLLATE NOCASE
           OR COALESCE(m.sap_number, '') LIKE ? COLLATE NOCASE
           OR m.type LIKE ? COLLATE NOCASE
           OR CAST(o.id AS TEXT) LIKE ?
           OR COALESCE(pd.sap_number, '') LIKE ? COLLATE NOCASE
           OR COALESCE(pd.alias, '') LIKE ? COLLATE NOCASE
           OR COALESCE(pd.free_text, '') LIKE ? COLLATE NOCASE
           OR COALESCE(pd.designation, '') LIKE ? COLLATE NOCASE
           OR EXISTS (
             SELECT 1
             FROM operation_set_members osm
             JOIN parts pt_m ON pt_m.id = osm.part_id
             LEFT JOIN part_designations pd_m ON pd_m.id = pt_m.designation_id
             WHERE osm.operation_id = o.id
               AND (
                 COALESCE(pd_m.sap_number, '') LIKE ? COLLATE NOCASE
                 OR COALESCE(pd_m.alias, '') LIKE ? COLLATE NOCASE
                 OR COALESCE(pd_m.free_text, '') LIKE ? COLLATE NOCASE
                 OR COALESCE(pd_m.designation, '') LIKE ? COLLATE NOCASE
               )
           )`;

/** Lista operacji z wszystkich projektów — do kopiowania parametrów przy tworzeniu nowej operacji. */
projectsRouter.get('/operations-copy-sources', (req, res) => {
  try {
    const refMode = loadReferenceDisplayMode();
    const needle = String(req.query.q ?? '').trim();
    const requestedLimit = Number(req.query.limit);
    const limit = needle
      ? Math.min(500, Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 200))
      : Math.min(10000, Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10000));
    const like = needle ? `%${needle.replace(/%/g, '').replace(/_/g, '')}%` : '';
    const searchParams = needle
      ? [
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
        ]
      : [];
    const rows = (needle
      ? db.prepare(
          `${OPERATIONS_COPY_SOURCES_SELECT}
        ${OPERATIONS_COPY_SOURCES_SEARCH_WHERE}
        ORDER BY o.id DESC
        LIMIT ?`
        )
      : db.prepare(
          `${OPERATIONS_COPY_SOURCES_SELECT}
        ORDER BY o.id DESC
        LIMIT ?`
        )
    ).all(...searchParams, limit) as any[];
    const out = rows.map((r: any) => {
      const label = operationCopySourceLabel(r, refMode);
      let set_designation_ids: number[] | null = null;
      const csv = r.set_designation_ids_csv;
      if (Number(r.is_set) === 1 && csv != null && String(csv).trim() !== '') {
        set_designation_ids = String(csv)
          .split(',')
          .map((s: string) => Number(String(s).trim()))
          .filter((n: number) => Number.isFinite(n) && n > 0);
        if (set_designation_ids.length < 2) set_designation_ids = null;
      }
      const pd = r.part_designation_id;
      const source_designation_id =
        pd != null && Number.isFinite(Number(pd)) && Number(pd) > 0 ? Number(pd) : null;
      const { set_designation_ids_csv, part_designation_id, ...rest } = r;
      return {
        ...rest,
        label,
        set_designation_ids,
        source_designation_id,
        detail_sap_number: r.detail_sap_number ?? null,
        detail_alias: r.detail_alias ?? null,
        detail_free_text: r.detail_free_text ?? null,
      };
    });
    res.json({ operations: out });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd wyszukiwania operacji' });
  }
});

projectsRouter.get('/:id', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const id = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!project) return res.status(404).json({ error: 'Not found' });

  const parts = db.prepare(`
    SELECT pt.*, pd.sap_number AS detail_sap_number, pd.alias AS detail_alias, pd.free_text AS detail_free_text
    FROM parts pt
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    WHERE pt.project_id = ?
    ORDER BY pt.id
  `).all(id) as any[];
  let projectVolumes: { year: number; volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number }[] = [];
  let projectVolumesContract: { year: number; volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number }[] = [];
  try {
    projectVolumes = db.prepare('SELECT year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes WHERE project_id = ? ORDER BY year').all(id) as any[];
  } catch (_) {}
  try {
    projectVolumesContract = db
      .prepare(
        'SELECT year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes_contract WHERE project_id = ? ORDER BY year'
      )
      .all(id) as any[];
  } catch (_) {}
  const partsWithDetail = parts.map((p: any) => {
    let volume_by_year: { year: number; volume_value: number; volume_unit: string }[] = [];
    let volume_contract_by_year: { year: number; volume_value: number; volume_unit: string }[] = [];
    let volume_share_by_year: { year: number; share_percent: number }[] = [];
    let volume_contract_share_by_year: { year: number; share_percent: number }[] = [];
    try {
      volume_by_year = db.prepare('SELECT year, volume_value, volume_unit, volume_origin FROM part_volume_by_year WHERE part_id = ? ORDER BY year').all(p.id) as any[];
    } catch (_) {}
    try {
      volume_contract_by_year = db
        .prepare('SELECT year, volume_value, volume_unit, volume_origin FROM part_volume_contract_by_year WHERE part_id = ? ORDER BY year')
        .all(p.id) as any[];
    } catch (_) {}
    try {
      volume_share_by_year = db.prepare('SELECT year, share_percent FROM part_volume_share_by_year WHERE part_id = ? ORDER BY year').all(p.id) as any[];
    } catch (_) {}
    try {
      volume_contract_share_by_year = db
        .prepare('SELECT year, share_percent FROM part_volume_contract_share_by_year WHERE part_id = ? ORDER BY year')
        .all(p.id) as any[];
    } catch (_) {}
    return {
      ...p,
      volume_mode: p.volume_mode ?? 'project',
      volume_share_percent: p.volume_share_percent ?? null,
      volume_by_year,
      volume_contract_by_year,
      volume_share_by_year,
      contract_volume_mode: p.contract_volume_mode ?? 'project',
      contract_volume_share_percent: p.contract_volume_share_percent ?? null,
      contract_default_volume_value: p.contract_default_volume_value ?? null,
      contract_default_volume_unit: p.contract_default_volume_unit ?? null,
      volume_contract_share_by_year: volume_contract_share_by_year,
      detail: p.designation_id ? { sap_number: p.detail_sap_number, alias: p.detail_alias, free_text: p.detail_free_text } : null,
    };
  });
  const operationsRaw = db.prepare(`
    SELECT o.*, ph.name AS phase_name,
           pd.sap_number AS _op_sap, pd.alias AS _op_alias, pd.free_text AS _op_free, pt.designation AS _op_pt_des,
           m.internal_number AS machine_number, m.sap_number AS machine_sap_number, m.type AS machine_type,
           m.status AS machine_status
    FROM operations o
    JOIN process_phases ph ON ph.id = o.phase_id
    JOIN parts pt ON pt.id = o.part_id
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    JOIN machines m ON m.id = o.machine_id
    WHERE o.project_id = ?
    ORDER BY o.id
  `).all(id) as any[];
  const operationIds = operationsRaw.map((o: any) => Number(o.id)).filter((v: number) => Number.isFinite(v) && v > 0);
  const volumeByYearByOperation = new Map<number, { year: number; volume_value: number; volume_unit: string; source?: string | null }[]>();
  if (operationIds.length > 0) {
    const placeholders = operationIds.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT operation_id, year, volume_value, volume_unit, source
       FROM operation_volume_by_year
       WHERE operation_id IN (${placeholders})
       ORDER BY year`
    ).all(...operationIds) as { operation_id: number; year: number; volume_value: number; volume_unit: string; source?: string | null }[];
    for (const row of rows) {
      if (!volumeByYearByOperation.has(row.operation_id)) volumeByYearByOperation.set(row.operation_id, []);
      volumeByYearByOperation.get(row.operation_id)!.push({
        year: row.year,
        volume_value: row.volume_value,
        volume_unit: row.volume_unit,
        source: row.source ?? null,
      });
    }
  }
  const operations = operationsRaw.map((op: any) => {
    op.volume_by_year = volumeByYearByOperation.get(Number(op.id)) ?? [];
    if (op.is_set) {
      try {
        const membersRaw = db.prepare(`
          SELECT osm.part_id, osm.quantity_per_set,
                 pd.sap_number AS m_sap, pd.alias AS m_alias, pd.free_text AS m_free, pt.designation AS m_des
          FROM operation_set_members osm
          JOIN parts pt ON pt.id = osm.part_id
          LEFT JOIN part_designations pd ON pd.id = pt.designation_id
          WHERE osm.operation_id = ?
          ORDER BY osm.part_id
        `).all(op.id) as any[];
        op.set_members = enrichSetMembersWithLabels(membersRaw, refMode);
        op.part_designation = 'Set: ' + op.set_members.map((m: { label: string }) => m.label).join(' + ');
      } catch (_) {
        op.set_members = [];
      }
    } else {
      applyPartDesignationToOperationRow(op, refMode);
    }
    return op;
  });
  const notes = db.prepare('SELECT * FROM project_notes WHERE project_id = ? ORDER BY note_date DESC').all(id) as any[];
  let eop_extensions: { eop_before: string; eop_after: string; created_at: string }[] = [];
  try {
    eop_extensions = db.prepare('SELECT eop_before, eop_after, created_at FROM project_eop_extensions WHERE project_id = ? ORDER BY created_at ASC').all(id) as any[];
  } catch (_) {}

  const eopExtensionsFormatted = (eop_extensions || []).map((ext: { eop_before: string; eop_after: string; created_at?: string }) => ({
    ...ext,
    eop_before: formatSopEop(ext.eop_before),
    eop_after: formatSopEop(ext.eop_after),
  }));
  res.json({
    ...formatProjectSopEopFields(project),
    project_volumes: projectVolumes,
    project_volumes_contract: projectVolumesContract,
    parts: partsWithDetail,
    operations,
    notes,
    eop_extensions: eopExtensionsFormatted,
  });
});

projectsRouter.post('/', (req, res) => {
  const body = req.body as any;
  const client = normalizeClientName(body.client ?? '');
  const name = String(body.name ?? '').trim();
  const sop = formatSopEop(body.sop ?? '');
  const eop = formatSopEop(body.eop ?? '');
  const status = body.status === 'RFQ' ? 'RFQ' : body.status === 'inactive' ? 'inactive' : 'active';

  const r = db.prepare('INSERT INTO projects (client, name, sop, eop, status) VALUES (?, ?, ?, ?, ?)')
    .run(client, name, sop, eop, status);
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid) as any;
  res.status(201).json(formatProjectSopEopFields(row));
});

projectsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!project) return res.status(404).json({ error: 'Not found' });
  const actor = resolveActor(req);

  const body = req.body as any;
  const client = body.client !== undefined ? normalizeClientName(body.client) : normalizeClientName(project.client);
  const name = body.name !== undefined ? String(body.name).trim() : project.name;
  const sop = body.sop !== undefined ? formatSopEop(body.sop) : formatSopEop(project.sop);
  const status = body.status === 'RFQ' ? 'RFQ' : body.status === 'inactive' ? 'inactive' : 'active';

  let eop: string;
  let eop_original: string | null;

  const eopExtensionValue = body.eop_extension !== undefined && body.eop_extension !== '' && body.eop_extension != null ? String(body.eop_extension).trim() : null;
  if (eopExtensionValue) {
    eop = formatSopEop(eopExtensionValue);
    eop_original = project.eop_original ?? project.eop;
    const noteText = `Automatyczna zmiana: Przedłużenie EOP (poprzednia data ${project.eop}, nowa data ${eop}).`;
    insertProjectNote(id, noteText, actor, 'auto');
    try {
      db.prepare('INSERT INTO project_eop_extensions (project_id, eop_before, eop_after) VALUES (?, ?, ?)')
        .run(id, project.eop, eop);
    } catch (_) {}
  } else {
    eop = body.eop !== undefined ? formatSopEop(body.eop) : formatSopEop(project.eop);
    eop_original = project.eop_original != null ? formatSopEop(project.eop_original) : null;
  }

  db.prepare('UPDATE projects SET client = ?, name = ?, sop = ?, eop = ?, eop_original = ?, status = ? WHERE id = ?')
    .run(client, name, sop, eop, eop_original, status, id);
  const changed: string[] = [];
  if (client !== project.client) changed.push(`klient: "${project.client}" → "${client}"`);
  if (name !== project.name) changed.push(`nazwa: "${project.name}" → "${name}"`);
  if (sop !== project.sop) changed.push(`SOP: "${project.sop}" → "${sop}"`);
  if (eop !== project.eop && !eopExtensionValue) changed.push(`EOP: "${project.eop}" → "${eop}"`);
  if (status !== project.status) changed.push(`status: "${project.status}" → "${status}"`);
  if (changed.length > 0) insertProjectNote(id, `Automatyczna zmiana: ${changed.join('; ')}`, actor, 'auto');
  if (eop !== project.eop) {
    try {
      syncVolumesToSopEop(id, sop, eop);
      saveDb();
    } catch (_) {}
  }
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  res.json(formatProjectSopEopFields(updated));
});

projectsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

// Parts
projectsRouter.post('/:id/parts', (req, res) => {
  const projectId = Number(req.params.id);
  const actor = resolveActor(req);
  const body = req.body as any;
  const designation_id = body.designation_id != null ? Number(body.designation_id) : null;
  let designation = String(body.designation ?? '').trim();
  if (designation_id) {
    const detail = db.prepare('SELECT sap_number, alias, free_text, designation FROM part_designations WHERE id = ?').get(designation_id) as any;
    if (detail) designation = detail.sap_number || detail.alias || detail.free_text || detail.designation || designation;
  }
  const side = body.side && ['RH', 'LH'].includes(body.side) ? body.side : null;
  const r = db.prepare('INSERT INTO parts (project_id, designation, side, designation_id) VALUES (?, ?, ?, ?)')
    .run(projectId, designation || '-', side, designation_id);
  const row = db.prepare('SELECT pt.*, pd.sap_number AS detail_sap_number, pd.alias AS detail_alias, pd.free_text AS detail_free_text FROM parts pt LEFT JOIN part_designations pd ON pd.id = pt.designation_id WHERE pt.id = ?').get(r.lastInsertRowid) as any;
  const part = row ? { ...row, detail: row.designation_id ? { sap_number: row.detail_sap_number, alias: row.detail_alias, free_text: row.detail_free_text } : null } : db.prepare('SELECT * FROM parts WHERE id = ?').get(r.lastInsertRowid) as any;
  insertProjectNote(projectId, `Automatyczna zmiana: dodano detal "${designation || '-'}".`, actor, 'auto', undefined, { partId: Number(part.id) });
  res.status(201).json(part);
});

projectsRouter.delete('/:projectId/parts/:partId', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projectId = Number(req.params.projectId);
  const partId = Number(req.params.partId);
  const actor = resolveActor(req);
  const partLabel = getPartLabel(partId, refMode);
  const r = db.prepare('DELETE FROM parts WHERE id = ?').run(partId);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  insertProjectNote(projectId, `Automatyczna zmiana: usunięto detal "${partLabel}".`, actor, 'auto', undefined, { partId });
  res.status(204).send();
});

// Project volumes (per year; annual/monthly/weekly)
projectsRouter.get('/:id/volumes', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  try {
    const rows = db.prepare('SELECT year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes WHERE project_id = ? ORDER BY year').all(id) as any[];
    res.json(rows);
  } catch (_) {
    res.json([]);
  }
});

projectsRouter.put('/:id/volumes', (req, res) => {
  const id = Number(req.params.id);
  const actor = resolveActor(req);
  const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const body = req.body as any;
  const volumes = Array.isArray(body.volumes) ? body.volumes : [];
  try {
    db.prepare('DELETE FROM project_volumes WHERE project_id = ?').run(id);
    let rows: any[];
    try {
      const ins = db.prepare('INSERT INTO project_volumes (project_id, year, volume_value, volume_unit, include_in_calculator_after_eop, volume_origin) VALUES (?, ?, ?, ?, ?, ?)');
      for (const v of volumes) {
        const year = Number(v.year);
        const volume_value = Number(v.volume_value);
        const volume_unit = ['annual', 'monthly', 'weekly'].includes(v.volume_unit) ? v.volume_unit : 'annual';
        const include_after_eop = v.include_in_calculator_after_eop === true || v.include_in_calculator_after_eop === 1 ? 1 : 0;
        const volume_origin = String(v.volume_origin ?? '').trim() === 'default_all_years' ? 'default_all_years' : 'manual_year';
        ins.run(id, year, volume_value, volume_unit, include_after_eop, volume_origin);
      }
      rows = db.prepare('SELECT year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes WHERE project_id = ? ORDER BY year').all(id) as any[];
    } catch (colErr: any) {
      if (colErr?.message?.includes('include_in_calculator_after_eop') || colErr?.message?.includes('volume_origin') || colErr?.message?.includes('no such column')) {
        const ins = db.prepare('INSERT INTO project_volumes (project_id, year, volume_value, volume_unit) VALUES (?, ?, ?, ?)');
        for (const v of volumes) {
          ins.run(id, Number(v.year), Number(v.volume_value), ['annual', 'monthly', 'weekly'].includes(v.volume_unit) ? v.volume_unit : 'annual');
        }
        rows = (db.prepare('SELECT year, volume_value, volume_unit FROM project_volumes WHERE project_id = ? ORDER BY year').all(id) as any[]).map((r: any) => ({ ...r, include_in_calculator_after_eop: 0, volume_origin: 'manual_year' }));
      } else {
        throw colErr;
      }
    }
    // Kalkulator stosuje operation_volume_by_year przed wolumenem projektu — po zapisie nowych wolumenów projektu
    // usuń te nadpisania, żeby obciążenie brało się z aktualnej tabeli project_volumes (chyba że są aktywne podziały alokacji).
    try {
      const split = db
        .prepare('SELECT 1 AS x FROM operations WHERE project_id = ? AND split_from_operation_id IS NOT NULL LIMIT 1')
        .get(id) as { x: number } | undefined;
      if (!split) {
        try {
          db.prepare(`
            DELETE FROM operation_volume_by_year
            WHERE operation_id IN (SELECT id FROM operations WHERE project_id = ?)
              AND COALESCE(source, 'manual') = 'allocation'
          `).run(id);
        } catch (_) {
          // Legacy DB without source column: fallback to full cleanup for project.
          db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id IN (SELECT id FROM operations WHERE project_id = ?)').run(id);
        }
      }
    } catch (_) {
      /* brak kolumny split_from_operation_id lub tabeli — pomiń */
    }
    saveDb();
    insertProjectNote(id, `Automatyczna zmiana: zaktualizowano wolumeny projektu (${volumes.length} rekordów).`, actor, 'auto');
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed' });
  }
});

projectsRouter.get('/:id/volumes-contract', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  try {
    const rows = db
      .prepare(
        'SELECT year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes_contract WHERE project_id = ? ORDER BY year'
      )
      .all(id) as any[];
    res.json(rows);
  } catch (_) {
    res.json([]);
  }
});

projectsRouter.put('/:id/volumes-contract', (req, res) => {
  const id = Number(req.params.id);
  const actor = resolveActor(req);
  const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const body = req.body as any;
  const volumes = Array.isArray(body.volumes) ? body.volumes : [];
  try {
    db.prepare('DELETE FROM project_volumes_contract WHERE project_id = ?').run(id);
    const ins = db.prepare(
      'INSERT INTO project_volumes_contract (project_id, year, volume_value, volume_unit, include_in_calculator_after_eop, volume_origin) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const v of volumes) {
      const year = Number(v.year);
      const volume_value = Number(v.volume_value);
      const volume_unit = ['annual', 'monthly', 'weekly'].includes(v.volume_unit) ? v.volume_unit : 'annual';
      const include_after_eop = v.include_in_calculator_after_eop === true || v.include_in_calculator_after_eop === 1 ? 1 : 0;
      const volume_origin = String(v.volume_origin ?? '').trim() === 'default_all_years' ? 'default_all_years' : 'manual_year';
      ins.run(id, year, volume_value, volume_unit, include_after_eop, volume_origin);
    }
    try {
      const split = db
        .prepare('SELECT 1 AS x FROM operations WHERE project_id = ? AND split_from_operation_id IS NOT NULL LIMIT 1')
        .get(id) as { x: number } | undefined;
      if (!split) {
        try {
          db.prepare(`
            DELETE FROM operation_volume_by_year
            WHERE operation_id IN (SELECT id FROM operations WHERE project_id = ?)
              AND COALESCE(source, 'manual') = 'allocation'
          `).run(id);
        } catch (_) {
          db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id IN (SELECT id FROM operations WHERE project_id = ?)').run(id);
        }
      }
    } catch (_) {}
    saveDb();
    insertProjectNote(id, `Automatyczna zmiana: zaktualizowano wolumeny kontraktowe projektu (${volumes.length} rekordów).`, actor, 'auto');
    const rows = db
      .prepare(
        'SELECT year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0) AS include_in_calculator_after_eop, volume_origin FROM project_volumes_contract WHERE project_id = ? ORDER BY year'
      )
      .all(id) as any[];
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed' });
  }
});

/** Skopiuj wolumeny projektu produkcja ↔ kontrakt (tylko zapisane w bazie). */
projectsRouter.post('/:id/volumes-mirror', (req, res) => {
  const id = Number(req.params.id);
  const actor = resolveActor(req);
  const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const direction = String((req.body as any)?.direction || '');
  if (direction !== 'production_to_contract' && direction !== 'contract_to_production') {
    return res.status(400).json({ error: 'direction: production_to_contract | contract_to_production' });
  }
  const cleanupAllocationVolumes = () => {
    try {
      const split = db
        .prepare('SELECT 1 AS x FROM operations WHERE project_id = ? AND split_from_operation_id IS NOT NULL LIMIT 1')
        .get(id) as { x: number } | undefined;
      if (!split) {
        try {
          db.prepare(`
            DELETE FROM operation_volume_by_year
            WHERE operation_id IN (SELECT id FROM operations WHERE project_id = ?)
              AND COALESCE(source, 'manual') = 'allocation'
          `).run(id);
        } catch (_) {
          db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id IN (SELECT id FROM operations WHERE project_id = ?)').run(id);
        }
      }
    } catch (_) {
      /* ignore */
    }
  };
  try {
    if (direction === 'production_to_contract') {
      db.prepare('DELETE FROM project_volumes_contract WHERE project_id = ?').run(id);
      db.prepare(
        `INSERT INTO project_volumes_contract (project_id, year, volume_value, volume_unit, include_in_calculator_after_eop, volume_origin)
         SELECT project_id, year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0), COALESCE(volume_origin, 'manual_year') FROM project_volumes WHERE project_id = ?`
      ).run(id);
      cleanupAllocationVolumes();
    } else {
      db.prepare('DELETE FROM project_volumes WHERE project_id = ?').run(id);
      db.prepare(
        `INSERT INTO project_volumes (project_id, year, volume_value, volume_unit, include_in_calculator_after_eop, volume_origin)
         SELECT project_id, year, volume_value, volume_unit, COALESCE(include_in_calculator_after_eop, 0), COALESCE(volume_origin, 'manual_year') FROM project_volumes_contract WHERE project_id = ?`
      ).run(id);
      cleanupAllocationVolumes();
    }
    saveDb();
    insertProjectNote(
      id,
      `Automatyczna zmiana: skopiowano wolumeny projektu (${direction === 'production_to_contract' ? 'produkcja → kontrakt' : 'kontrakt → produkcja'}).`,
      actor,
      'auto'
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed' });
  }
});

// Part volume mode, share (default + per year) and override per year
projectsRouter.put('/:projectId/parts/:partId', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projectId = Number(req.params.projectId);
  const partId = Number(req.params.partId);
  const actor = resolveActor(req);
  const body = req.body as any;
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId) as any;
  if (!part) return res.status(404).json({ error: 'Not found' });
  const designation = body.designation !== undefined ? String(body.designation).trim() : part.designation;
  const side = body.side !== undefined ? (body.side && ['RH', 'LH'].includes(body.side) ? body.side : null) : part.side;
  const volume_mode = body.volume_mode !== undefined && ['project', 'share', 'override'].includes(body.volume_mode) ? body.volume_mode : (part.volume_mode ?? 'project');
  const volume_share_percent = body.volume_share_percent !== undefined ? (body.volume_share_percent == null ? null : Number(body.volume_share_percent)) : (part.volume_share_percent ?? null);
  const default_volume_value = body.default_volume_value !== undefined ? (body.default_volume_value == null || body.default_volume_value === '' ? null : Number(body.default_volume_value)) : (part.default_volume_value ?? null);
  const default_volume_unit = body.default_volume_unit !== undefined ? (['annual', 'monthly', 'weekly'].includes(body.default_volume_unit) ? body.default_volume_unit : null) : (part.default_volume_unit ?? null);
  const contract_volume_mode =
    body.contract_volume_mode !== undefined && ['project', 'share', 'override'].includes(body.contract_volume_mode)
      ? body.contract_volume_mode
      : (part.contract_volume_mode ?? 'project');
  const contract_volume_share_percent =
    body.contract_volume_share_percent !== undefined
      ? body.contract_volume_share_percent == null
        ? null
        : Number(body.contract_volume_share_percent)
      : (part.contract_volume_share_percent ?? null);
  const contract_default_volume_value =
    body.contract_default_volume_value !== undefined
      ? body.contract_default_volume_value == null || body.contract_default_volume_value === ''
        ? null
        : Number(body.contract_default_volume_value)
      : (part.contract_default_volume_value ?? null);
  const contract_default_volume_unit =
    body.contract_default_volume_unit !== undefined
      ? ['annual', 'monthly', 'weekly'].includes(body.contract_default_volume_unit)
        ? body.contract_default_volume_unit
        : null
      : (part.contract_default_volume_unit ?? null);
  try {
    db.prepare(
      `UPDATE parts SET designation = ?, side = ?, volume_mode = ?, volume_share_percent = ?, default_volume_value = ?, default_volume_unit = ?,
        contract_volume_mode = ?, contract_volume_share_percent = ?, contract_default_volume_value = ?, contract_default_volume_unit = ?
        WHERE id = ?`
    ).run(
      designation,
      side,
      volume_mode,
      volume_share_percent,
      default_volume_value,
      default_volume_unit,
      contract_volume_mode,
      contract_volume_share_percent,
      contract_default_volume_value,
      contract_default_volume_unit,
      partId
    );
  } catch (_) {
    try {
      db.prepare('UPDATE parts SET designation = ?, side = ?, volume_mode = ?, volume_share_percent = ?, default_volume_value = ?, default_volume_unit = ? WHERE id = ?')
        .run(designation, side, volume_mode, volume_share_percent, default_volume_value, default_volume_unit, partId);
    } catch (__) {
      try {
        db.prepare('UPDATE parts SET designation = ?, side = ?, volume_mode = ?, volume_share_percent = ? WHERE id = ?')
          .run(designation, side, volume_mode, volume_share_percent, partId);
      } catch (___) {
        db.prepare('UPDATE parts SET designation = ?, side = ? WHERE id = ?').run(designation, side, partId);
      }
    }
  }
  if (Array.isArray(body.volume_share_by_year)) {
    try {
      db.prepare('DELETE FROM part_volume_share_by_year WHERE part_id = ?').run(partId);
      const ins = db.prepare('INSERT INTO part_volume_share_by_year (part_id, year, share_percent) VALUES (?, ?, ?)');
      for (const row of body.volume_share_by_year) {
        const year = Number(row.year);
        const share_percent = Number(row.share_percent);
        if (!Number.isInteger(year) || isNaN(share_percent)) continue;
        ins.run(partId, year, Math.max(0, Math.min(100, share_percent)));
      }
    } catch (_) {}
  }
  if (Array.isArray(body.contract_volume_share_by_year)) {
    try {
      db.prepare('DELETE FROM part_volume_contract_share_by_year WHERE part_id = ?').run(partId);
      const insC = db.prepare('INSERT INTO part_volume_contract_share_by_year (part_id, year, share_percent) VALUES (?, ?, ?)');
      for (const row of body.contract_volume_share_by_year) {
        const year = Number(row.year);
        const share_percent = Number(row.share_percent);
        if (!Number.isInteger(year) || isNaN(share_percent)) continue;
        insC.run(partId, year, Math.max(0, Math.min(100, share_percent)));
      }
    } catch (_) {}
  }
  const updated = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId) as any;
  insertProjectNote(projectId, `Automatyczna zmiana: zaktualizowano ustawienia wolumenu detalu "${getPartLabel(partId, refMode)}".`, actor, 'auto', undefined, { partId });
  saveDb();
  res.json(updated);
});

/** Skopiuj zapisane wolumeny produkcji ↔ kontrakt (tylko baza, bez niezapisanych zmian w formularzu). */
projectsRouter.post('/:projectId/parts/:partId/volumes-mirror', (req, res) => {
  const projectId = Number(req.params.projectId);
  const partId = Number(req.params.partId);
  const actor = resolveActor(req);
  const refMode = referenceModeFromReq(req);
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId) as any;
  if (!part) return res.status(404).json({ error: 'Not found' });
  if (Number(part.project_id) !== projectId) return res.status(400).json({ error: 'Part not in project' });
  const direction = String((req.body as any)?.direction || '');
  if (direction !== 'production_to_contract' && direction !== 'contract_to_production') {
    return res.status(400).json({ error: 'direction: production_to_contract | contract_to_production' });
  }
  try {
    if (direction === 'production_to_contract') {
      db.prepare('DELETE FROM part_volume_contract_by_year WHERE part_id = ?').run(partId);
      db.prepare(
        `INSERT INTO part_volume_contract_by_year (part_id, year, volume_value, volume_unit)
         SELECT part_id, year, volume_value, volume_unit FROM part_volume_by_year WHERE part_id = ?`
      ).run(partId);
      db.prepare('DELETE FROM part_volume_contract_share_by_year WHERE part_id = ?').run(partId);
      db.prepare(
        `INSERT INTO part_volume_contract_share_by_year (part_id, year, share_percent)
         SELECT part_id, year, share_percent FROM part_volume_share_by_year WHERE part_id = ?`
      ).run(partId);
      db.prepare(
        `UPDATE parts SET
          contract_volume_mode = volume_mode,
          contract_volume_share_percent = volume_share_percent,
          contract_default_volume_value = default_volume_value,
          contract_default_volume_unit = default_volume_unit
         WHERE id = ?`
      ).run(partId);
    } else {
      db.prepare('DELETE FROM part_volume_by_year WHERE part_id = ?').run(partId);
      db.prepare(
        `INSERT INTO part_volume_by_year (part_id, year, volume_value, volume_unit)
         SELECT part_id, year, volume_value, volume_unit FROM part_volume_contract_by_year WHERE part_id = ?`
      ).run(partId);
      db.prepare('DELETE FROM part_volume_share_by_year WHERE part_id = ?').run(partId);
      db.prepare(
        `INSERT INTO part_volume_share_by_year (part_id, year, share_percent)
         SELECT part_id, year, share_percent FROM part_volume_contract_share_by_year WHERE part_id = ?`
      ).run(partId);
      db.prepare(
        `UPDATE parts SET
          volume_mode = contract_volume_mode,
          volume_share_percent = contract_volume_share_percent,
          default_volume_value = contract_default_volume_value,
          default_volume_unit = contract_default_volume_unit
         WHERE id = ?`
      ).run(partId);
    }
    saveDb();
    insertProjectNote(
      projectId,
      `Automatyczna zmiana: skopiowano wolumeny (${direction === 'production_to_contract' ? 'produkcja → kontrakt' : 'kontrakt → produkcja'}) detalu "${getPartLabel(partId, refMode)}".`,
      actor,
      'auto',
      undefined,
      { partId }
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed' });
  }
});

projectsRouter.get('/:projectId/parts/:partId/volumes', (req, res) => {
  const partId = Number(req.params.partId);
  const part = db.prepare('SELECT 1 FROM parts WHERE id = ?').get(partId);
  if (!part) return res.status(404).json({ error: 'Not found' });
  try {
    const rows = db.prepare('SELECT year, volume_value, volume_unit FROM part_volume_by_year WHERE part_id = ? ORDER BY year').all(partId) as any[];
    res.json(rows);
  } catch (_) {
    res.json([]);
  }
});

projectsRouter.put('/:projectId/parts/:partId/volumes', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projectId = Number(req.params.projectId);
  const partId = Number(req.params.partId);
  const actor = resolveActor(req);
  const part = db.prepare('SELECT 1 FROM parts WHERE id = ?').get(partId);
  if (!part) return res.status(404).json({ error: 'Not found' });
  const body = req.body as any;
  const volumes = Array.isArray(body.volumes) ? body.volumes : [];
  try {
    db.prepare('DELETE FROM part_volume_by_year WHERE part_id = ?').run(partId);
    const ins = db.prepare('INSERT INTO part_volume_by_year (part_id, year, volume_value, volume_unit, volume_origin) VALUES (?, ?, ?, ?, ?)');
    for (const v of volumes) {
      const year = Number(v.year);
      const volume_value = Number(v.volume_value);
      const volume_unit = ['annual', 'monthly', 'weekly'].includes(v.volume_unit) ? v.volume_unit : 'annual';
      const volume_origin = String(v.volume_origin ?? '').trim() === 'default_all_years' ? 'default_all_years' : 'manual_year';
      ins.run(partId, year, volume_value, volume_unit, volume_origin);
    }
    const rows = db.prepare('SELECT year, volume_value, volume_unit, volume_origin FROM part_volume_by_year WHERE part_id = ? ORDER BY year').all(partId) as any[];
    insertProjectNote(
      projectId,
      `Automatyczna zmiana: zaktualizowano wolumeny detalu "${getPartLabel(partId, refMode)}" (${volumes.length} rekordów).`,
      actor,
      'auto',
      undefined,
      { partId }
    );
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed' });
  }
});

projectsRouter.get('/:projectId/parts/:partId/volumes-contract', (req, res) => {
  const partId = Number(req.params.partId);
  const part = db.prepare('SELECT 1 FROM parts WHERE id = ?').get(partId);
  if (!part) return res.status(404).json({ error: 'Not found' });
  try {
    const rows = db.prepare('SELECT year, volume_value, volume_unit FROM part_volume_contract_by_year WHERE part_id = ? ORDER BY year').all(partId) as any[];
    res.json(rows);
  } catch (_) {
    res.json([]);
  }
});

projectsRouter.put('/:projectId/parts/:partId/volumes-contract', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projectId = Number(req.params.projectId);
  const partId = Number(req.params.partId);
  const actor = resolveActor(req);
  const part = db.prepare('SELECT 1 FROM parts WHERE id = ?').get(partId);
  if (!part) return res.status(404).json({ error: 'Not found' });
  const body = req.body as any;
  const volumes = Array.isArray(body.volumes) ? body.volumes : [];
  try {
    db.prepare('DELETE FROM part_volume_contract_by_year WHERE part_id = ?').run(partId);
    const ins = db.prepare('INSERT INTO part_volume_contract_by_year (part_id, year, volume_value, volume_unit, volume_origin) VALUES (?, ?, ?, ?, ?)');
    for (const v of volumes) {
      const year = Number(v.year);
      const volume_value = Number(v.volume_value);
      const volume_unit = ['annual', 'monthly', 'weekly'].includes(v.volume_unit) ? v.volume_unit : 'annual';
      const volume_origin = String(v.volume_origin ?? '').trim() === 'default_all_years' ? 'default_all_years' : 'manual_year';
      ins.run(partId, year, volume_value, volume_unit, volume_origin);
    }
    const rows = db.prepare('SELECT year, volume_value, volume_unit, volume_origin FROM part_volume_contract_by_year WHERE part_id = ? ORDER BY year').all(partId) as any[];
    insertProjectNote(
      projectId,
      `Automatyczna zmiana: zaktualizowano wolumeny kontraktowe detalu "${getPartLabel(partId, refMode)}" (${volumes.length} rekordów).`,
      actor,
      'auto',
      undefined,
      { partId }
    );
    saveDb();
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed' });
  }
});

/** Dodaj rok w wolumenie detalu; opcjonalnie przedłuż EOP do 12.{year}. */
projectsRouter.post('/:projectId/parts/:partId/volume-year', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projectId = Number(req.params.projectId);
  const partId = Number(req.params.partId);
  const actor = resolveActor(req);
  const year = Number((req.body as any)?.year);
  const volumeSide = (req.body as any)?.volumeSide === 'contract' ? 'contract' : 'production';
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return res.status(400).json({ error: 'Nieprawidłowy rok.' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) return res.status(404).json({ error: 'Not found' });
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId) as any;
  if (!part || Number(part.project_id) !== projectId) return res.status(404).json({ error: 'Not found' });
  const volumeMode =
    volumeSide === 'contract' ? (part.contract_volume_mode ?? 'project') : (part.volume_mode ?? 'project');
  if (volumeMode !== 'share' && volumeMode !== 'override') {
    return res.status(400).json({ error: 'Dodawanie roku jest dostępne tylko dla trybu „% udział” lub „Własna wartość”.' });
  }
  const partLabel = getPartLabel(partId, refMode);
  const { years: sopEopYears, eopYear } = getSopEopYears(project.sop, project.eop);
  if (sopEopYears.includes(year)) {
    return res.status(400).json({ error: 'Ten rok jest już w tabeli.' });
  }
  const extendsEop = eopYear > 0 && year > eopYear;
  /** Rok poza bieżącym EOP, ale zapisany w bazie po wcześniejszym przedłużeniu — przywróć zamiast blokować. */
  const orphanedBeyondEop = (existsInTable: boolean) => existsInTable && year > eopYear;
  try {
    if (volumeMode === 'share') {
      if (volumeSide === 'contract') {
        const exists =
          (db.prepare('SELECT 1 AS x FROM part_volume_contract_share_by_year WHERE part_id = ? AND year = ?').get(partId, year) as
            | { x: number }
            | undefined) != null;
        if (exists && !orphanedBeyondEop(exists)) return res.status(400).json({ error: 'Ten rok jest już w tabeli.' });
        if (!exists) {
          const contractPct = part.contract_volume_share_percent != null ? Number(part.contract_volume_share_percent) : 0;
          db.prepare('INSERT INTO part_volume_contract_share_by_year (part_id, year, share_percent) VALUES (?, ?, ?)').run(
            partId,
            year,
            contractPct
          );
        }
      } else {
        const exists =
          (db.prepare('SELECT 1 AS x FROM part_volume_share_by_year WHERE part_id = ? AND year = ?').get(partId, year) as { x: number } | undefined) !=
          null;
        if (exists && !orphanedBeyondEop(exists)) return res.status(400).json({ error: 'Ten rok jest już w tabeli.' });
        if (!exists) {
          const sharePct = part.volume_share_percent != null ? Number(part.volume_share_percent) : 0;
          db.prepare('INSERT INTO part_volume_share_by_year (part_id, year, share_percent) VALUES (?, ?, ?)').run(partId, year, sharePct);
          try {
            const contractPct = part.contract_volume_share_percent != null ? Number(part.contract_volume_share_percent) : sharePct;
            db.prepare('INSERT INTO part_volume_contract_share_by_year (part_id, year, share_percent) VALUES (?, ?, ?)').run(partId, year, contractPct);
          } catch (_) {}
        }
      }
    } else if (volumeSide === 'contract') {
      const exists =
        (db.prepare('SELECT 1 AS x FROM part_volume_contract_by_year WHERE part_id = ? AND year = ?').get(partId, year) as { x: number } | undefined) !=
        null;
      if (exists && !orphanedBeyondEop(exists)) return res.status(400).json({ error: 'Ten rok jest już w tabeli.' });
      if (!exists) {
        db.prepare('INSERT INTO part_volume_contract_by_year (part_id, year, volume_value, volume_unit) VALUES (?, ?, ?, ?)').run(
          partId,
          year,
          0,
          'annual'
        );
      }
    } else {
      const exists =
        (db.prepare('SELECT 1 AS x FROM part_volume_by_year WHERE part_id = ? AND year = ?').get(partId, year) as { x: number } | undefined) != null;
      if (exists && !orphanedBeyondEop(exists)) return res.status(400).json({ error: 'Ten rok jest już w tabeli.' });
      if (!exists) {
        db.prepare('INSERT INTO part_volume_by_year (part_id, year, volume_value, volume_unit) VALUES (?, ?, ?, ?)').run(partId, year, 0, 'annual');
        try {
          db.prepare('INSERT INTO part_volume_contract_by_year (part_id, year, volume_value, volume_unit) VALUES (?, ?, ?, ?)').run(partId, year, 0, 'annual');
        } catch (_) {}
      }
    }
    let newEop = project.eop;
    if (extendsEop) {
      const oldEop = project.eop;
      newEop = formatSopEop(`12.${year}`);
      const eop_original = project.eop_original ?? project.eop;
      db.prepare('UPDATE projects SET eop = ?, eop_original = ? WHERE id = ?').run(newEop, eop_original, projectId);
      try {
        db.prepare('INSERT INTO project_eop_extensions (project_id, eop_before, eop_after) VALUES (?, ?, ?)').run(projectId, oldEop, newEop);
      } catch (_) {}
      syncVolumesToSopEop(projectId, project.sop, newEop);
    }
    saveDb();
    const volumeLabel = volumeSide === 'contract' ? 'wolumenie kontraktowym detalu' : 'wolumenie detalu';
    const noteParts = [`dodano rok ${year} w ${volumeLabel} "${partLabel}" (zmiana z poziomu detalu)`];
    if (extendsEop) noteParts.push(`przedłużono EOP (poprzednia data ${project.eop}, nowa data ${newEop})`);
    insertProjectNote(projectId, `Automatyczna zmiana: ${noteParts.join('; ')}.`, actor, 'auto', undefined, { partId });
    res.json({ year, eop: newEop, eop_extended: extendsEop });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed' });
  }
});

/** Przy dodawaniu operacji: jeśli suma (istniejące + nowa) przekraczałaby 100%, równo rozdziel procenty między wszystkie operacje na tej maszynie w projekcie. */
function rebalanceCapacityPercentOnInsert(machineId: number, projectId: number, newOpCapacityPercent: number): number {
  const existing = db.prepare('SELECT id, capacity_percent FROM operations WHERE machine_id = ? AND project_id = ?').all(machineId, projectId) as { id: number; capacity_percent: number }[];
  const currentSum = existing.reduce((s, r) => s + r.capacity_percent, 0);
  const wouldBeTotal = currentSum + newOpCapacityPercent;
  if (Math.abs(wouldBeTotal - 100) <= 0.01) return newOpCapacityPercent;
  if (wouldBeTotal <= 100) return newOpCapacityPercent;
  const n = existing.length + 1;
  const perOp = Math.round((100 / n) * 100) / 100;
  db.prepare('UPDATE operations SET capacity_percent = ? WHERE machine_id = ? AND project_id = ?').run(perOp, machineId, projectId);
  return perOp;
}

projectsRouter.get('/:id/phases', (_req, res) => {
  const phases = db.prepare('SELECT id, name FROM process_phases ORDER BY name').all() as any[];
  res.json(phases);
});

projectsRouter.post('/:id/operations', (req, res) => {
  try {
    const refMode = referenceModeFromReq(req);
    const projectId = Number(req.params.id);
    const actor = resolveActor(req);
    const body = req.body as any;
    const is_set = body.is_set ? 1 : 0;
    const set_part_ids: number[] = Array.isArray(body.set_part_ids) ? Array.from(new Set(body.set_part_ids.map(Number).filter((v: number) => Number.isFinite(v) && v > 0))) : [];
    const selected_set_part_id = body.part_id != null ? Number(body.part_id) : NaN;
    const part_id = is_set ? selected_set_part_id : Number(body.part_id);
    const phase_id = Number(body.phase_id);
    const machine_id = Number(body.machine_id);
    const cycle_time_seconds = Number(body.cycle_time_seconds);
    const volume_value = Number(body.volume_value);
    const volume_unit = ['annual', 'monthly', 'weekly'].includes(body.volume_unit) ? body.volume_unit : 'annual';
    const nests_count = Number(body.nests_count ?? 1) || 1;
    const oee_override = body.oee_override != null ? Number(body.oee_override) : null;
    const capacity_percent = Number(body.capacity_percent ?? 100);
    const opf = body.opf ? 1 : 0;
    const sap = body.sap ?? null;
    const description = body.description ?? null;

    const rawAltCycle = body.alt_cycle_time_seconds;
    const alt_cycle_time_seconds =
      rawAltCycle !== undefined && rawAltCycle !== null && rawAltCycle !== '' ? Number(rawAltCycle) : null;
    const hasAlt = alt_cycle_time_seconds != null && Number.isFinite(alt_cycle_time_seconds) && alt_cycle_time_seconds > 0;
    const alt_nests_count =
      body.alt_nests_count !== undefined && body.alt_nests_count !== null && body.alt_nests_count !== ''
        ? Number(body.alt_nests_count)
        : null;
    const alt_oee_override =
      body.alt_oee_override !== undefined && body.alt_oee_override !== null && body.alt_oee_override !== ''
        ? Number(body.alt_oee_override)
        : null;
    const alt_comment =
      body.alt_comment != null && String(body.alt_comment).trim() !== '' ? String(body.alt_comment).trim() : null;
    let use_alternative_in_calculator = body.use_alternative_in_calculator ? 1 : 0;
    if (!hasAlt) use_alternative_in_calculator = 0;

    if (is_set && set_part_ids.length < 2) {
      return res.status(400).json({ error: 'Set musi zawierać co najmniej 2 detale.' });
    }
    if (is_set && (!Number.isFinite(selected_set_part_id) || selected_set_part_id <= 0)) {
      return res.status(400).json({ error: 'Dla setu wybierz detal źródłowy wolumenu.' });
    }
    if (is_set && !set_part_ids.includes(selected_set_part_id)) {
      return res.status(400).json({ error: 'Detal źródłowy wolumenu musi należeć do setu.' });
    }
    if (!Number.isFinite(machine_id) || machine_id <= 0) {
      return res.status(400).json({ error: 'Wybierz maszynę z listy — pole „Maszyna” jest wymagane.' });
    }
    const machineRow = db.prepare('SELECT id FROM machines WHERE id = ?').get(machine_id);
    if (!machineRow) {
      return res.status(400).json({ error: 'Wybrana maszyna nie istnieje w bazie. Wybierz maszynę z listy.' });
    }

    const capacityPercentToInsert = rebalanceCapacityPercentOnInsert(machine_id, projectId, capacity_percent);

    db.prepare(`
      INSERT INTO operations (project_id, part_id, phase_id, machine_id, cycle_time_seconds, volume_value, volume_unit, nests_count, oee_override, capacity_percent, opf, sap, description, is_set,
        alt_cycle_time_seconds, alt_nests_count, alt_oee_override, alt_comment, use_alternative_in_calculator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      part_id,
      phase_id,
      machine_id,
      cycle_time_seconds,
      volume_value,
      volume_unit,
      nests_count,
      oee_override,
      capacityPercentToInsert,
      opf,
      sap,
      description,
      is_set,
      hasAlt ? alt_cycle_time_seconds : null,
      alt_nests_count,
      alt_oee_override,
      alt_comment,
      use_alternative_in_calculator
    );

    const lastId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
    if (is_set && set_part_ids.length) {
      const ins = db.prepare('INSERT INTO operation_set_members (operation_id, part_id, quantity_per_set) VALUES (?, ?, 1)');
      for (const pid of set_part_ids) {
        ins.run(lastId.id, pid);
      }
    }

    const row = db.prepare(`
      SELECT o.*, ph.name AS phase_name,
             pd.sap_number AS _op_sap, pd.alias AS _op_alias, pd.free_text AS _op_free, pt.designation AS _op_pt_des,
             m.internal_number AS machine_number, m.sap_number AS machine_sap_number, m.type AS machine_type
      FROM operations o
      JOIN process_phases ph ON ph.id = o.phase_id
      JOIN parts pt ON pt.id = o.part_id
      LEFT JOIN part_designations pd ON pd.id = pt.designation_id
      JOIN machines m ON m.id = o.machine_id
      WHERE o.id = ?
    `).get(lastId.id) as any;
    if (row.is_set) {
      const membersRaw = db.prepare(`
        SELECT osm.part_id, osm.quantity_per_set,
               pd.sap_number AS m_sap, pd.alias AS m_alias, pd.free_text AS m_free, pt.designation AS m_des
        FROM operation_set_members osm
        JOIN parts pt ON pt.id = osm.part_id
        LEFT JOIN part_designations pd ON pd.id = pt.designation_id
        WHERE osm.operation_id = ?
        ORDER BY osm.part_id
      `).all(lastId.id) as any[];
      row.set_members = enrichSetMembersWithLabels(membersRaw, refMode);
      row.part_designation = 'Set: ' + row.set_members.map((m: { label: string }) => m.label).join(' + ');
    } else {
      applyPartDesignationToOperationRow(row, refMode);
    }
    insertProjectNote(
      projectId,
      `Automatyczna zmiana: dodano operację #${row.id} na maszynie ${getMachineLabel(Number(row.machine_id))}.`,
      actor,
      'auto',
      undefined,
      { operationId: Number(row.id), machineId: Number(row.machine_id), partId: Number(row.part_id) }
    );
    res.status(201).json(row);
  } catch (e: any) {
    console.error('POST /operations error:', e);
    const msg = e?.message ?? String(e);
    if (msg.includes('no such column: is_set') || msg.includes('no such table: operation_set_members')) {
      return res.status(500).json({ error: 'Baza wymaga migracji (sety). Zrestartuj serwer (npm run dev) i spróbuj ponownie.' });
    }
    if (msg.includes('FOREIGN KEY')) {
      return res.status(400).json({ error: 'Wybierz maszynę z listy — pole „Maszyna” jest wymagane.' });
    }
    res.status(500).json({ error: msg || 'Internal Server Error' });
  }
});

projectsRouter.put('/:projectId/operations/:opId', (req, res) => {
  const refMode = referenceModeFromReq(req);
  const projectId = Number(req.params.projectId);
  const opId = Number(req.params.opId);
  const actor = resolveActor(req);
  const op = db.prepare('SELECT * FROM operations WHERE id = ? AND project_id = ?').get(opId, projectId) as any;
  if (!op) return res.status(404).json({ error: 'Not found' });

  const body = req.body as any;
  const is_set = body.is_set !== undefined ? (body.is_set ? 1 : 0) : op.is_set;
  let set_part_ids: number[] = Array.isArray(body.set_part_ids)
    ? Array.from(new Set(body.set_part_ids.map(Number).filter((v: number) => Number.isFinite(v) && v > 0)))
    : [];
  let part_id = body.part_id !== undefined ? Number(body.part_id) : op.part_id;
  if (is_set) {
    if (set_part_ids.length === 0) {
      set_part_ids = (
        db.prepare('SELECT part_id FROM operation_set_members WHERE operation_id = ? ORDER BY part_id').all(opId) as { part_id: number }[]
      )
        .map((r) => Number(r.part_id))
        .filter((v) => Number.isFinite(v) && v > 0);
    }
    if (set_part_ids.length < 2) {
      return res.status(400).json({ error: 'Set musi zawierać co najmniej 2 detale.' });
    }
    if (!Number.isFinite(part_id) || part_id <= 0) {
      return res.status(400).json({ error: 'Dla setu wybierz detal źródłowy wolumenu.' });
    }
    if (!set_part_ids.includes(part_id)) {
      return res.status(400).json({ error: 'Detal źródłowy wolumenu musi należeć do setu.' });
    }
  }

  const phase_id = body.phase_id !== undefined ? Number(body.phase_id) : op.phase_id;
  const machine_id = body.machine_id !== undefined ? Number(body.machine_id) : op.machine_id;
  const cycle_time_seconds = body.cycle_time_seconds !== undefined ? Number(body.cycle_time_seconds) : op.cycle_time_seconds;
  const volumeExplicit = body.volume_value !== undefined || body.volume_unit !== undefined;
  const volume_value = body.volume_value !== undefined ? Number(body.volume_value) : op.volume_value;
  const volume_unit = body.volume_unit !== undefined && ['annual', 'monthly', 'weekly'].includes(body.volume_unit) ? body.volume_unit : op.volume_unit;
  const nests_count = body.nests_count !== undefined ? Number(body.nests_count) || 1 : op.nests_count;
  const oee_override = body.oee_override !== undefined ? (body.oee_override == null ? null : Number(body.oee_override)) : op.oee_override;
  const capacity_percent = body.capacity_percent !== undefined ? Number(body.capacity_percent) : op.capacity_percent;
  const opf = body.opf ? 1 : 0;
  const sap = body.sap !== undefined ? body.sap : op.sap;
  const description = body.description !== undefined ? body.description : op.description;

  const alt_cycle_time_seconds =
    body.alt_cycle_time_seconds !== undefined
      ? body.alt_cycle_time_seconds == null || body.alt_cycle_time_seconds === ''
        ? null
        : Number(body.alt_cycle_time_seconds)
      : op.alt_cycle_time_seconds;
  const hasAltPut =
    alt_cycle_time_seconds != null && Number.isFinite(Number(alt_cycle_time_seconds)) && Number(alt_cycle_time_seconds) > 0;
  const alt_nests_count =
    body.alt_nests_count !== undefined
      ? body.alt_nests_count == null || body.alt_nests_count === ''
        ? null
        : Number(body.alt_nests_count)
      : op.alt_nests_count;
  const alt_oee_override =
    body.alt_oee_override !== undefined
      ? body.alt_oee_override == null || body.alt_oee_override === ''
        ? null
        : Number(body.alt_oee_override)
      : op.alt_oee_override;
  const alt_comment =
    body.alt_comment !== undefined
      ? body.alt_comment == null || String(body.alt_comment).trim() === ''
        ? null
        : String(body.alt_comment).trim()
      : op.alt_comment;
  let use_alternative_in_calculator =
    body.use_alternative_in_calculator !== undefined ? (body.use_alternative_in_calculator ? 1 : 0) : (op.use_alternative_in_calculator ?? 0);
  if (!hasAltPut) use_alternative_in_calculator = 0;

  if (!Number.isFinite(machine_id) || machine_id <= 0) {
    return res.status(400).json({ error: 'Wybierz maszynę z listy — pole „Maszyna” jest wymagane.' });
  }
  const machineRowPut = db.prepare('SELECT id FROM machines WHERE id = ?').get(machine_id);
  if (!machineRowPut) {
    return res.status(400).json({ error: 'Wybrana maszyna nie istnieje w bazie. Wybierz maszynę z listy.' });
  }

  db.prepare(`
    UPDATE operations SET part_id = ?, phase_id = ?, machine_id = ?, cycle_time_seconds = ?, volume_value = ?, volume_unit = ?, nests_count = ?, oee_override = ?, capacity_percent = ?, opf = ?, sap = ?, description = ?, is_set = ?,
      alt_cycle_time_seconds = ?, alt_nests_count = ?, alt_oee_override = ?, alt_comment = ?, use_alternative_in_calculator = ?
    WHERE id = ?
  `).run(
    part_id,
    phase_id,
    machine_id,
    cycle_time_seconds,
    volume_value,
    volume_unit,
    nests_count,
    oee_override,
    capacity_percent,
    opf,
    sap,
    description,
    is_set,
    hasAltPut ? alt_cycle_time_seconds : null,
    alt_nests_count,
    alt_oee_override,
    alt_comment,
    use_alternative_in_calculator,
    opId
  );

  if (is_set && set_part_ids.length) {
    db.prepare('DELETE FROM operation_set_members WHERE operation_id = ?').run(opId);
    const ins = db.prepare('INSERT INTO operation_set_members (operation_id, part_id, quantity_per_set) VALUES (?, ?, 1)');
    for (const pid of set_part_ids) {
      ins.run(opId, pid);
    }
  } else if (!is_set) {
    db.prepare('DELETE FROM operation_set_members WHERE operation_id = ?').run(opId);
  }

  if (volumeExplicit) {
    db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id = ?').run(opId);
  }
  cleanupOrphanPartsForProject(projectId);

  const row = db.prepare(`
    SELECT o.*, ph.name AS phase_name,
           pd.sap_number AS _op_sap, pd.alias AS _op_alias, pd.free_text AS _op_free, pt.designation AS _op_pt_des,
           m.internal_number AS machine_number, m.sap_number AS machine_sap_number, m.type AS machine_type
    FROM operations o
    JOIN process_phases ph ON ph.id = o.phase_id
    JOIN parts pt ON pt.id = o.part_id
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    JOIN machines m ON m.id = o.machine_id
    WHERE o.id = ?
  `).get(opId) as any;
  if (row.is_set) {
    const membersRaw = db.prepare(`
      SELECT osm.part_id, osm.quantity_per_set,
             pd.sap_number AS m_sap, pd.alias AS m_alias, pd.free_text AS m_free, pt.designation AS m_des
      FROM operation_set_members osm
      JOIN parts pt ON pt.id = osm.part_id
      LEFT JOIN part_designations pd ON pd.id = pt.designation_id
      WHERE osm.operation_id = ?
      ORDER BY osm.part_id
    `).all(opId) as any[];
    row.set_members = enrichSetMembersWithLabels(membersRaw, refMode);
    row.part_designation = 'Set: ' + row.set_members.map((m: { label: string }) => m.label).join(' + ');
  } else {
    applyPartDesignationToOperationRow(row, refMode);
  }
  insertProjectNote(projectId, `Automatyczna zmiana: zaktualizowano operację #${opId}.`, actor, 'auto', undefined, {
    operationId: opId,
    machineId: Number(row.machine_id),
    partId: Number(row.part_id),
  });
  res.json(row);
});

projectsRouter.delete('/:projectId/operations/:opId', (req, res) => {
  const opId = Number(req.params.opId);
  const projectId = Number(req.params.projectId);
  const actor = resolveActor(req);
  const opRow = db
    .prepare('SELECT id, machine_id, part_id FROM operations WHERE id = ? AND project_id = ?')
    .get(opId, projectId) as { id: number; machine_id: number | null; part_id: number | null } | undefined;
  if (!opRow) return res.status(404).json({ error: 'Not found' });

  const result = deleteOperationInProject(projectId, opId);
  if (!result.ok) {
    return res.status(result.statusCode ?? 400).json({ error: result.error });
  }
  saveDb();
  insertProjectNote(projectId, `Automatyczna zmiana: usunięto operację #${opId}.`, actor, 'auto', undefined, {
    operationId: opId,
    machineId: opRow.machine_id,
    partId: opRow.part_id,
  });
  res.status(204).send();
});

// Operation volume by year (override dla wybranych lat; brak wpisu = używany volume_value/volume_unit operacji)
projectsRouter.get('/:projectId/operations/:opId/volumes', (req, res) => {
  const opId = Number(req.params.opId);
  const projectId = Number(req.params.projectId);
  const op = db.prepare('SELECT id FROM operations WHERE id = ? AND project_id = ?').get(opId, projectId);
  if (!op) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT year, volume_value, volume_unit FROM operation_volume_by_year WHERE operation_id = ? ORDER BY year').all(opId) as any[];
  res.json(rows);
});

projectsRouter.put('/:projectId/operations/:opId/volumes', (req, res) => {
  const opId = Number(req.params.opId);
  const projectId = Number(req.params.projectId);
  const actor = resolveActor(req);
  const op = db
    .prepare('SELECT id, machine_id, part_id, split_from_operation_id FROM operations WHERE id = ? AND project_id = ?')
    .get(opId, projectId) as
    | { id: number; machine_id: number | null; part_id: number | null; split_from_operation_id: number | null }
    | undefined;
  if (!op) return res.status(404).json({ error: 'Not found' });
  const body = req.body as any;
  const parentId = op.split_from_operation_id != null ? Number(op.split_from_operation_id) : null;
  if (body.volumes && Array.isArray(body.volumes)) {
    if (parentId != null && Number.isFinite(parentId)) {
      return res.status(400).json({
        error:
          'Operacja z alokacji: żeby oddać wolumen matce usuń operację potomną albo wyzeruj / usuń wolumen wybranego roku. Hurtowa podmiana wolumenów jest niedozwolona.',
      });
    }
    db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id = ?').run(opId);
    for (const v of body.volumes) {
      const year = Number(v.year);
      const volume_value = Number(v.volume_value);
      const volume_unit = ['annual', 'monthly', 'weekly'].includes(v.volume_unit) ? v.volume_unit : 'annual';
      try {
        db.prepare('INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit, source) VALUES (?, ?, ?, ?, ?)').run(opId, year, volume_value, volume_unit, 'manual');
      } catch (_) {
        db.prepare('INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit) VALUES (?, ?, ?, ?)').run(opId, year, volume_value, volume_unit);
      }
    }
    const rows = db.prepare('SELECT year, volume_value, volume_unit FROM operation_volume_by_year WHERE operation_id = ? ORDER BY year').all(opId) as any[];
    insertProjectNote(projectId, `Automatyczna zmiana: zaktualizowano wolumeny operacji #${opId}.`, actor, 'auto', undefined, {
      operationId: opId,
      machineId: op.machine_id,
      partId: op.part_id,
    });
    saveDb();
    return res.json(rows);
  }
  const year = Number(body.year);
  const volume_value = Number(body.volume_value);
  const volume_unit = ['annual', 'monthly', 'weekly'].includes(body.volume_unit) ? body.volume_unit : 'annual';
  // Obniżenie / wyzerowanie roku u dziecka alokacji — najpierw oddaj stary wolumen matce.
  if (parentId != null && Number.isFinite(parentId) && Number.isFinite(volume_value) && volume_value <= 1e-9) {
    const parent = db.prepare('SELECT id FROM operations WHERE id = ? AND project_id = ?').get(parentId, projectId);
    if (parent) {
      const result = deleteOperationYearVolumeInProject(projectId, opId, year);
      if (!result.ok) {
        return res.status(result.statusCode ?? 400).json({ error: result.error });
      }
      saveDb();
      const row = db.prepare('SELECT year, volume_value, volume_unit FROM operation_volume_by_year WHERE operation_id = ? AND year = ?').get(opId, year) as any;
      insertProjectNote(projectId, `Automatyczna zmiana: zaktualizowano wolumen operacji #${opId} dla roku ${year}.`, actor, 'auto', undefined, {
        operationId: opId,
        machineId: op.machine_id,
        partId: op.part_id,
      });
      return res.json(row ?? { year, volume_value: 0, volume_unit: 'weekly' });
    }
  }
  const source = parentId != null ? 'allocation' : 'manual';
  try {
    db.prepare('INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit, source) VALUES (?, ?, ?, ?, ?)').run(opId, year, volume_value, volume_unit, source);
  } catch (_) {
    db.prepare('INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit) VALUES (?, ?, ?, ?)').run(opId, year, volume_value, volume_unit);
  }
  const row = db.prepare('SELECT year, volume_value, volume_unit FROM operation_volume_by_year WHERE operation_id = ? AND year = ?').get(opId, year) as any;
  insertProjectNote(projectId, `Automatyczna zmiana: zaktualizowano wolumen operacji #${opId} dla roku ${year}.`, actor, 'auto', undefined, {
    operationId: opId,
    machineId: op.machine_id,
    partId: op.part_id,
  });
  saveDb();
  res.json(row);
});

projectsRouter.delete('/:projectId/operations/:opId/volumes/:year', (req, res) => {
  const opId = Number(req.params.opId);
  const projectId = Number(req.params.projectId);
  const year = Number(req.params.year);
  const actor = resolveActor(req);
  const op = db
    .prepare('SELECT id, machine_id, part_id FROM operations WHERE id = ? AND project_id = ?')
    .get(opId, projectId) as { id: number; machine_id: number | null; part_id: number | null } | undefined;
  if (!op) return res.status(404).json({ error: 'Not found' });
  const result = deleteOperationYearVolumeInProject(projectId, opId, year);
  if (!result.ok) {
    return res.status(result.statusCode ?? 400).json({ error: result.error });
  }
  saveDb();
  insertProjectNote(projectId, `Automatyczna zmiana: usunięto wolumen operacji #${opId} dla roku ${year}.`, actor, 'auto', undefined, {
    operationId: opId,
    machineId: op.machine_id,
    partId: op.part_id,
  });
  res.status(204).send();
});

// Notes
projectsRouter.post('/:id/notes', (req, res) => {
  const projectId = Number(req.params.id);
  const body = req.body as any;
  const note = String(body.note ?? '').trim();
  const author = resolveActor(req);
  const note_date = body.note_date ?? new Date().toISOString().slice(0, 10);
  insertProjectNote(projectId, note, author, 'manual', note_date);
  const r = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  const row = db.prepare('SELECT * FROM project_notes WHERE id = ?').get(r.id) as any;
  saveDb();
  res.status(201).json(row);
});

projectsRouter.put('/:projectId/notes/:noteId', (req, res) => {
  const projectId = Number(req.params.projectId);
  const noteId = Number(req.params.noteId);
  const actor = resolveActor(req);
  const noteText = String((req.body as any)?.note ?? '').trim();
  if (!noteText) return res.status(400).json({ error: 'Treść notatki nie może być pusta.' });
  const existing = db.prepare('SELECT * FROM project_notes WHERE id = ? AND project_id = ?').get(noteId, projectId) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const ownerError = manualNoteOwnerError(existing, actor);
  if (ownerError) return res.status(403).json({ error: ownerError });
  db.prepare('UPDATE project_notes SET note = ? WHERE id = ?').run(noteText, noteId);
  saveDb();
  const row = db.prepare('SELECT * FROM project_notes WHERE id = ?').get(noteId) as any;
  res.json(row);
});

projectsRouter.delete('/:projectId/notes/:noteId', (req, res) => {
  const projectId = Number(req.params.projectId);
  const noteId = Number(req.params.noteId);
  const actor = resolveActor(req);
  const existing = db.prepare('SELECT * FROM project_notes WHERE id = ? AND project_id = ?').get(noteId, projectId) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const ownerError = manualNoteOwnerError(existing, actor);
  if (ownerError) return res.status(403).json({ error: ownerError });
  db.prepare('DELETE FROM project_notes WHERE id = ?').run(noteId);
  saveDb();
  res.status(204).send();
});

function attachmentStorageErrorResponse(res: any): boolean {
  if (!isAttachmentsStorageConfigured()) {
    res.status(400).json({
      error:
        'Nie skonfigurowano ścieżki przechowywania załączników projektów. Ustaw ją w Ustawieniach administracyjnych.',
      code: ATTACHMENTS_STORAGE_NOT_CONFIGURED,
    });
    return true;
  }
  return false;
}

projectsRouter.get('/:id/attachments', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const configured = isAttachmentsStorageConfigured();
  let absoluteOutputDir = '';
  if (configured) {
    try {
      absoluteOutputDir = resolveAttachmentsDirectory();
    } catch {
      absoluteOutputDir = '';
    }
  }
  const attachments = listProjectAttachments(projectId);
  res.json({ storage_configured: configured, absolute_output_dir: absoluteOutputDir, attachments });
});

function insertSharedAttachmentNotes(noteText: string, actor: string): void {
  for (const projectId of listAllProjectIds()) {
    insertProjectNote(projectId, noteText, actor, 'auto');
  }
}

function parseSharedAttachmentFlag(body: Record<string, unknown> | undefined): boolean {
  const raw = body?.shared ?? body?.is_shared;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'on') return true;
  return false;
}

projectsRouter.post('/:id/attachments', attachmentUpload.single('file'), (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (attachmentStorageErrorResponse(res)) return;

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Brak pliku do zapisania.' });

  const description = String((req.body as { description?: string })?.description ?? '').trim();
  const isShared = parseSharedAttachmentFlag(req.body as Record<string, unknown>);
  const actor = resolveActor(req);
  const originalFilename = file.originalname?.trim() || 'plik';

  try {
    const row = createProjectAttachment(
      projectId,
      file.buffer,
      originalFilename,
      file.mimetype || 'application/octet-stream',
      description,
      actor,
      isShared,
    );
    if (isShared) {
      const noteText = description
        ? `dodano załącznik zbiorczy "${originalFilename}" — ${description}.`
        : `dodano załącznik zbiorczy "${originalFilename}".`;
      insertSharedAttachmentNotes(noteText, actor);
    } else {
      const noteText = description
        ? `dodano załącznik "${originalFilename}" — ${description}.`
        : `dodano załącznik "${originalFilename}".`;
      insertProjectNote(projectId, noteText, actor, 'auto');
    }
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.message === ATTACHMENTS_STORAGE_NOT_CONFIGURED) {
      return attachmentStorageErrorResponse(res);
    }
    return res.status(500).json({ error: e?.message || 'Nie udało się zapisać załącznika.' });
  }
});

projectsRouter.get('/:projectId/attachments/:attachmentId/download', (req, res) => {
  const projectId = Number(req.params.projectId);
  const attachmentId = Number(req.params.attachmentId);
  if (attachmentStorageErrorResponse(res)) return;

  const row = getProjectAttachment(projectId, attachmentId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  try {
    const filePath = getAttachmentAbsolutePath(row);
    return res.download(filePath, row.original_filename);
  } catch (e: any) {
    if (e?.message === ATTACHMENTS_STORAGE_NOT_CONFIGURED) {
      return attachmentStorageErrorResponse(res);
    }
    return res.status(500).json({ error: e?.message || 'Nie udało się pobrać załącznika.' });
  }
});

projectsRouter.delete('/:projectId/attachments/:attachmentId', (req, res) => {
  const projectId = Number(req.params.projectId);
  const attachmentId = Number(req.params.attachmentId);
  if (attachmentStorageErrorResponse(res)) return;

  const row = deleteProjectAttachment(projectId, attachmentId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const actor = resolveActor(req);
  if (row.is_shared) {
    insertSharedAttachmentNotes(`usunięto załącznik zbiorczy "${row.original_filename}".`, actor);
  } else {
    insertProjectNote(projectId, `usunięto załącznik "${row.original_filename}".`, actor, 'auto');
  }
  res.status(204).send();
});
