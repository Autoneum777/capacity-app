import { db } from '../db/connection.js';
import {
  clearParentAllocationOverridesIfNoChildren,
  cleanupOrphanOperationYearVolumes,
  ensureSplitChildYearCoverage,
  findAllocationTreeRootOperationId,
  mergeSplitChildVolumesIntoParent,
  mergeSplitChildYearVolumeIntoParent,
  resolveVolumeHeir,
  type VolumeHeirCandidate,
} from './allocationService.js';
import { invalidateAllocationSplitIndex } from './capacityService.js';

export type DeleteOperationResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; statusCode?: number; code?: 'choose_heir' | 'no_heir'; candidates?: VolumeHeirCandidate[] };

function operationHasPositiveVolume(operationId: number, year?: number): boolean {
  const rows = (
    year != null
      ? db
          .prepare(
            `SELECT volume_value, volume_value_before FROM operation_volume_by_year WHERE operation_id = ? AND year = ?`
          )
          .all(operationId, year)
      : db.prepare(`SELECT volume_value, volume_value_before FROM operation_volume_by_year WHERE operation_id = ?`).all(operationId)
  ) as { volume_value: number; volume_value_before: number | null }[];
  return rows.some(
    (row) => Number(row.volume_value) > 1e-6 || (row.volume_value_before != null && Number(row.volume_value_before) > 1e-6)
  );
}

function writeInheritanceNote(
  projectId: number,
  note: string,
  machineId: number | null,
  partId: number | null,
  operationId: number
): void {
  const noteDate = new Date().toISOString().slice(0, 10);
  try {
    db.prepare(
      `INSERT INTO project_notes (project_id, note_date, author, note, note_type, machine_id, part_id, operation_id)
       VALUES (?, ?, 'system', ?, 'auto', ?, ?, ?)`
    ).run(projectId, noteDate, note, machineId, partId, operationId);
  } catch {
    try {
      db.prepare(`INSERT INTO project_notes (project_id, note_date, author, note, note_type) VALUES (?, ?, 'system', ?, 'auto')`).run(
        projectId,
        noteDate,
        note
      );
    } catch {
      /* notatka jest dodatkiem — brak tabeli nie może cofnąć scalenia wolumenu */
    }
  }
}


/** Usuwa z projektu detale bez powiązanych operacji (główny part_id ani set_member). */
export function cleanupOrphanPartsForProject(projectId: number): void {
  db.prepare(`
    DELETE FROM parts
    WHERE project_id = ?
      AND id NOT IN (
        SELECT o.part_id FROM operations o WHERE o.project_id = ?
        UNION
        SELECT osm.part_id
        FROM operation_set_members osm
        JOIN operations o2 ON o2.id = osm.operation_id
        WHERE o2.project_id = ?
      )
  `).run(projectId, projectId, projectId);
}

/** Usuwa operację w projekcie (ta sama logika co DELETE /projects/:id/operations/:opId). */
export function deleteOperationInProject(
  projectId: number,
  opId: number,
  preferredHeirOperationId?: number | null
): DeleteOperationResult {
  const opRow = db
    .prepare('SELECT id, split_from_operation_id, machine_id, part_id FROM operations WHERE id = ? AND project_id = ?')
    .get(opId, projectId) as
    | { id: number; split_from_operation_id: number | null; machine_id: number | null; part_id: number | null }
    | undefined;
  if (!opRow) return { ok: false, error: 'Nie znaleziono operacji', statusCode: 404 };

  const hasChildren = db.prepare('SELECT 1 FROM operations WHERE split_from_operation_id = ? LIMIT 1').get(opId);

  if (hasChildren) {
    if (opRow.split_from_operation_id == null) {
      return {
        ok: false,
        statusCode: 400,
        error:
          'Operacja ma operacje potomne — najpierw usuń potomki lub operacje pośrednie z alokacji wolumenu.',
      };
    }
    const rootId = findAllocationTreeRootOperationId(opId);
    const rootInProject = db.prepare('SELECT id FROM operations WHERE id = ? AND project_id = ?').get(rootId, projectId);
    if (!rootInProject || rootId === opId) {
      return { ok: false, statusCode: 400, error: 'Nie można ustalić operacji źródłowej do scalenia wolumenu.' };
    }
    const childIds = db.prepare('SELECT id FROM operations WHERE split_from_operation_id = ?').all(opId) as { id: number }[];
    const mustInherit = operationHasPositiveVolume(opId);
    const heir = mustInherit ? resolveVolumeHeir(opId, preferredHeirOperationId) : null;
    if (heir && !heir.ok) {
      return {
        ok: false,
        error: heir.error,
        statusCode: heir.code === 'choose_heir' ? 409 : 400,
        code: heir.code,
        candidates: heir.candidates,
      };
    }
    if (heir?.ok && heir.heirOperationId !== opId) mergeSplitChildVolumesIntoParent(heir.heirOperationId, opId);
    else if (!mustInherit) mergeSplitChildVolumesIntoParent(rootId, opId);
    if (heir?.ok && heir.skippedInactive) {
      writeInheritanceNote(
        projectId,
        `Odziedziczenie: wolumen operacji #${opId} przeszedł na maszynę ${heir.machineLabel}, bo maszyna matki jest nieaktywna.`,
        opRow.machine_id,
        opRow.part_id,
        heir.heirOperationId
      );
    }
    db.prepare('UPDATE operations SET split_from_operation_id = ? WHERE split_from_operation_id = ?').run(rootId, opId);
    for (const { id } of childIds) {
      ensureSplitChildYearCoverage(id);
    }
    const r = db.prepare('DELETE FROM operations WHERE id = ? AND project_id = ?').run(opId, projectId);
    if (r.changes === 0) return { ok: false, error: 'Nie znaleziono operacji', statusCode: 404 };
    // CASCADE czasem nie działa (stare sesje / FK) — wolumen wraca do matki, potem czyścimy resztki.
    db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id = ?').run(opId);
    cleanupOrphanPartsForProject(projectId);
    clearParentAllocationOverridesIfNoChildren(rootId);
    const immediateParentId = Number(opRow.split_from_operation_id);
    if (Number.isFinite(immediateParentId)) {
      clearParentAllocationOverridesIfNoChildren(immediateParentId);
    }
    cleanupOrphanOperationYearVolumes();
    invalidateAllocationSplitIndex();
    return heir?.ok && heir.skippedInactive
      ? { ok: true, message: `Wolumen przeszedł na maszynę ${heir.machineLabel}, bo maszyna matki jest nieaktywna.` }
      : { ok: true };
  }

  const parentId = opRow.split_from_operation_id != null ? Number(opRow.split_from_operation_id) : null;
  let inheritedMessage: string | undefined;
  if (parentId != null && !Number.isNaN(parentId)) {
    const parent = db.prepare('SELECT id FROM operations WHERE id = ? AND project_id = ?').get(parentId, projectId);
    if (parent) {
      const mustInherit = operationHasPositiveVolume(opId);
      const heir = mustInherit ? resolveVolumeHeir(opId, preferredHeirOperationId) : null;
      if (heir && !heir.ok) {
        return {
          ok: false,
          error: heir.error,
          statusCode: heir.code === 'choose_heir' ? 409 : 400,
          code: heir.code,
          candidates: heir.candidates,
        };
      }
      if (heir?.ok && heir.heirOperationId !== opId) mergeSplitChildVolumesIntoParent(heir.heirOperationId, opId);
      else if (!mustInherit) mergeSplitChildVolumesIntoParent(parentId, opId);
      if (heir?.ok && heir.skippedInactive) {
        inheritedMessage = `Wolumen przeszedł na maszynę ${heir.machineLabel}, bo maszyna matki jest nieaktywna.`;
        writeInheritanceNote(
          projectId,
          `Odziedziczenie: wolumen operacji #${opId} przeszedł na maszynę ${heir.machineLabel}, bo maszyna matki jest nieaktywna.`,
          opRow.machine_id,
          opRow.part_id,
          heir.heirOperationId
        );
      }
    }
  }

  const r = db.prepare('DELETE FROM operations WHERE id = ? AND project_id = ?').run(opId, projectId);
  if (r.changes === 0) return { ok: false, error: 'Nie znaleziono operacji', statusCode: 404 };
  db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id = ?').run(opId);
  cleanupOrphanPartsForProject(projectId);
  if (parentId != null && !Number.isNaN(parentId)) {
    clearParentAllocationOverridesIfNoChildren(parentId);
  }
  cleanupOrphanOperationYearVolumes();
  invalidateAllocationSplitIndex();
  return inheritedMessage ? { ok: true, message: inheritedMessage } : { ok: true };
}

/**
 * Usuwa wolumen operacji dla jednego roku.
 * Dla dziecka alokacji — najpierw scala ten rok z powrotem do matki.
 */
export function deleteOperationYearVolumeInProject(
  projectId: number,
  opId: number,
  year: number,
  preferredHeirOperationId?: number | null
): DeleteOperationResult {
  const op = db
    .prepare('SELECT id, split_from_operation_id FROM operations WHERE id = ? AND project_id = ?')
    .get(opId, projectId) as { id: number; split_from_operation_id: number | null } | undefined;
  if (!op) return { ok: false, error: 'Nie znaleziono operacji', statusCode: 404 };
  if (!Number.isInteger(year)) return { ok: false, error: 'Nieprawidłowy rok', statusCode: 400 };

  const parentId = op.split_from_operation_id != null ? Number(op.split_from_operation_id) : null;
  let inheritedMessage: string | undefined;
  if (parentId != null && Number.isFinite(parentId)) {
    const parent = db.prepare('SELECT id FROM operations WHERE id = ? AND project_id = ?').get(parentId, projectId);
    if (parent) {
      const mustInherit = operationHasPositiveVolume(opId, year);
      const heir = mustInherit ? resolveVolumeHeir(opId, preferredHeirOperationId) : null;
      if (heir && !heir.ok) {
        return {
          ok: false,
          error: heir.error,
          statusCode: heir.code === 'choose_heir' ? 409 : 400,
          code: heir.code,
          candidates: heir.candidates,
        };
      }
      if (heir?.ok && heir.heirOperationId !== opId) mergeSplitChildYearVolumeIntoParent(heir.heirOperationId, opId, year);
      else if (!mustInherit) mergeSplitChildYearVolumeIntoParent(parentId, opId, year);
      if (heir?.ok && heir.skippedInactive) {
        inheritedMessage = `Wolumen roku ${year} przeszedł na maszynę ${heir.machineLabel}, bo maszyna matki jest nieaktywna.`;
        const ctx = db
          .prepare('SELECT machine_id, part_id FROM operations WHERE id = ?')
          .get(opId) as { machine_id: number | null; part_id: number | null } | undefined;
        writeInheritanceNote(projectId, `Odziedziczenie: ${inheritedMessage}`, ctx?.machine_id ?? null, ctx?.part_id ?? null, heir.heirOperationId);
      }
    }
  }

  db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id = ? AND year = ?').run(opId, year);

  // Dziecko alokacji bez wiersza roku = 0 w kalkulatorze — zostaw jawne 0, żeby nie wracało do volume_value bazy.
  if (parentId != null && Number.isFinite(parentId)) {
    db.prepare(
      `INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit, source)
       VALUES (?, ?, 0, 'weekly', 'allocation')`
    ).run(opId, year);
    clearParentAllocationOverridesIfNoChildren(parentId);
  }

  invalidateAllocationSplitIndex();
  return inheritedMessage ? { ok: true, message: inheritedMessage } : { ok: true };
}

export type DesignationRelatedOperation = {
  id: number;
  project_id: number;
  project_client: string;
  project_name: string;
  machine_id: number;
  machine_internal: string | number | null;
  machine_sap: string | null;
  machine_type: string | null;
  phase_name: string;
  cycle_time_seconds: number;
  is_set: number;
  has_children: number;
  detail_sap_number: string | null;
  detail_alias: string | null;
  detail_free_text: string | null;
};

/** Operacje powiązane z oznaczeniem detalu (part główny lub skład setu). */
export function listOperationsForDesignation(designationId: number): DesignationRelatedOperation[] {
  return db
    .prepare(
      `
    SELECT DISTINCT
      o.id,
      o.project_id,
      TRIM(COALESCE(pr.client, '')) AS project_client,
      TRIM(COALESCE(pr.name, '')) AS project_name,
      o.machine_id,
      m.internal_number AS machine_internal,
      m.sap_number AS machine_sap,
      m.type AS machine_type,
      ph.name AS phase_name,
      o.cycle_time_seconds,
      COALESCE(o.is_set, 0) AS is_set,
      CASE WHEN EXISTS (SELECT 1 FROM operations ch WHERE ch.split_from_operation_id = o.id) THEN 1 ELSE 0 END AS has_children,
      pd.sap_number AS detail_sap_number,
      pd.alias AS detail_alias,
      pd.free_text AS detail_free_text
    FROM operations o
    JOIN projects pr ON pr.id = o.project_id
    JOIN machines m ON m.id = o.machine_id
    JOIN process_phases ph ON ph.id = o.phase_id
    LEFT JOIN parts pt ON pt.id = o.part_id
    LEFT JOIN part_designations pd ON pd.id = pt.designation_id
    WHERE pt.designation_id = ?
       OR o.id IN (
         SELECT osm.operation_id
         FROM operation_set_members osm
         JOIN parts pt2 ON pt2.id = osm.part_id
         WHERE pt2.designation_id = ?
       )
    ORDER BY pr.client, pr.name, o.id
  `
    )
    .all(designationId, designationId) as DesignationRelatedOperation[];
}

export function countOperationsForDesignation(designationId: number): number {
  const row = db
    .prepare(
      `
    SELECT COUNT(DISTINCT o.id) AS c
    FROM operations o
    LEFT JOIN parts pt ON pt.id = o.part_id
    WHERE pt.designation_id = ?
       OR o.id IN (
         SELECT osm.operation_id
         FROM operation_set_members osm
         JOIN parts pt2 ON pt2.id = osm.part_id
         WHERE pt2.designation_id = ?
       )
  `
    )
    .get(designationId, designationId) as { c: number };
  return Number(row?.c ?? 0);
}
