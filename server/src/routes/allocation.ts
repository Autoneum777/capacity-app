import { Router } from 'express';
import { db } from '../db/connection.js';
import {
  getOverloadedMachines,
  getCandidatesForAllocation,
  getAllocationLoadHint,
  executeAllocation,
  executeAllocationInScenario,
} from '../services/allocationService.js';
import { parseScenarioSnapshotJson } from '../services/scenarioSnapshotService.js';
import { resolveActor } from '../utils/authActor.js';
import { blockHiddenScenarioAccess } from '../auth/scenarioVisibility.js';

export const allocationRouter = Router();
allocationRouter.use(blockHiddenScenarioAccess);

function loadScenarioBundleForAllocation(scenarioId: number): { bundle: ReturnType<typeof parseScenarioSnapshotJson>; includeRfq: boolean } | null {
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(scenarioId) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return null;
  try {
    const archived = row.archived_at != null && String(row.archived_at).trim() !== '';
    return { bundle: parseScenarioSnapshotJson(row.snapshot), includeRfq: !archived };
  } catch {
    return null;
  }
}

allocationRouter.get('/overloaded', (req, res) => {
  const year = Number(req.query.year ?? new Date().getFullYear());
  const threshold = Number(req.query.threshold ?? 100);
  const list = getOverloadedMachines(year, threshold);
  res.json({ year, threshold, machines: list });
});

allocationRouter.get('/candidates/:machineId', (req, res) => {
  const machineId = Number(req.params.machineId);
  const year = Number(req.query.year ?? new Date().getFullYear());
  const maxLoad = Number(req.query.maxLoad ?? 90);
  const includeOverloaded =
    req.query.includeOverloadedAlternatives === '1' || String(req.query.includeOverloadedAlternatives).toLowerCase() === 'true';
  const useContractualVolumes =
    req.query.useContractualVolumes === '1' || String(req.query.useContractualVolumes ?? '').toLowerCase() === 'true';
  const scenarioIdRaw = req.query.scenarioId != null ? Number(req.query.scenarioId) : NaN;
  const scenarioMeta =
    Number.isFinite(scenarioIdRaw) && scenarioIdRaw > 0 ? loadScenarioBundleForAllocation(scenarioIdRaw) : null;
  const scenarioBundle = scenarioMeta?.bundle ?? null;
  const scenarioIncludeRfq = scenarioMeta?.includeRfq ?? true;
  if (Number.isFinite(scenarioIdRaw) && scenarioIdRaw > 0 && !scenarioBundle) {
    return res.status(404).json({ error: 'Scenariusz nie znaleziony' });
  }
  const list = getCandidatesForAllocation(machineId, year, maxLoad, includeOverloaded, scenarioBundle, scenarioIncludeRfq, useContractualVolumes);
  res.json({ machineId, year, candidates: list });
});

allocationRouter.get('/hint/:machineId', (req, res) => {
  const machineId = Number(req.params.machineId);
  const year = Number(req.query.year ?? new Date().getFullYear());
  const operationId = Number(req.query.operationId);
  const operationIdsRaw = String(req.query.operationIds ?? '').trim();
  const operationIdsFromList = operationIdsRaw
    ? operationIdsRaw
        .split(/[,;]+/)
        .map((s) => Number(s.trim()))
        .filter((id) => Number.isFinite(id) && id > 0)
    : [];
  const useContractualVolumes =
    req.query.useContractualVolumes === '1' || String(req.query.useContractualVolumes ?? '').toLowerCase() === 'true';
  if (!Number.isFinite(operationId) || operationId <= 0) {
    return res.status(400).json({ error: 'Parametr operationId jest wymagany.' });
  }
  const operationIds = operationIdsFromList.length > 0 ? operationIdsFromList : [operationId];
  const scenarioIdRaw = req.query.scenarioId != null ? Number(req.query.scenarioId) : NaN;
  const scenarioMeta =
    Number.isFinite(scenarioIdRaw) && scenarioIdRaw > 0 ? loadScenarioBundleForAllocation(scenarioIdRaw) : null;
  const scenarioBundle = scenarioMeta?.bundle ?? null;
  const scenarioIncludeRfq = scenarioMeta?.includeRfq ?? true;
  if (Number.isFinite(scenarioIdRaw) && scenarioIdRaw > 0 && !scenarioBundle) {
    return res.status(404).json({ error: 'Scenariusz nie znaleziony' });
  }
  const hint = getAllocationLoadHint(machineId, year, operationIds, scenarioBundle, scenarioIncludeRfq, useContractualVolumes);
  if ('error' in hint) return res.status(400).json({ error: hint.error });
  res.json(hint);
});

allocationRouter.post('/execute', (req, res) => {
  const {
    operationId,
    targetMachineId,
    volumeToMove,
    volumeUnit,
    cycleTimeSecondsOnTarget,
    useAlternativeCycleOnTarget: useAltCycleBody,
    year,
    scenarioId,
    useContractualVolumes: useCvBody,
    effectiveFromMonth,
    effectiveFromWeek,
    batchId,
  } = req.body as any;
  const useContractualVolumes =
    useCvBody === true ||
    useCvBody === 1 ||
    String(useCvBody ?? '').toLowerCase() === 'true';
  const y = Number(year);
  const yearResolved = Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
  const useAlternativeCycleOnTarget =
    useAltCycleBody === true || useAltCycleBody === 1 || String(useAltCycleBody ?? '').toLowerCase() === 'true';
  const cycle =
    !useAlternativeCycleOnTarget &&
    cycleTimeSecondsOnTarget !== undefined &&
    cycleTimeSecondsOnTarget !== null &&
    Number(cycleTimeSecondsOnTarget) > 0
      ? Number(cycleTimeSecondsOnTarget)
      : undefined;
  const volUnit = volumeUnit === 'monthly' ? 'monthly' : volumeUnit === 'weekly' ? 'weekly' : 'annual';
  const fromMonthNum = Number(effectiveFromMonth);
  const fromWeekNum = Number(effectiveFromWeek);
  const effectiveFrom =
    Number.isFinite(fromMonthNum) && fromMonthNum >= 1 && fromMonthNum <= 12
      ? {
          month: Math.floor(fromMonthNum),
          week:
            Number.isFinite(fromWeekNum) && fromWeekNum >= 1 && fromWeekNum <= 5
              ? Math.floor(fromWeekNum)
              : 1,
        }
      : null;
  const sid = scenarioId != null ? Number(scenarioId) : NaN;
  if (Number.isFinite(sid) && sid > 0) {
    const exists = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(sid);
    if (!exists) return res.status(404).json({ error: 'Scenariusz nie znaleziony' });
    const result = executeAllocationInScenario(
      sid,
      Number(operationId),
      Number(targetMachineId),
      Number(volumeToMove),
      volUnit,
      yearResolved,
      cycle,
      resolveActor(req),
      useContractualVolumes,
      useAlternativeCycleOnTarget,
      effectiveFrom,
      batchId != null ? String(batchId) : null
    );
    if (!result.success) return res.status(400).json({ ...result, error: result.error });
    return res.json(result);
  }
  const result = executeAllocation(
    Number(operationId),
    Number(targetMachineId),
    Number(volumeToMove),
    volUnit,
    yearResolved,
    cycle,
    useContractualVolumes,
    useAlternativeCycleOnTarget,
    effectiveFrom
  );
  if (!result.success) return res.status(400).json({ ...result, error: result.error });
  res.json(result);
});
