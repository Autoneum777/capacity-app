import { db, saveDb } from '../db/connection.js';
import { allocateScenarioEntityId } from './scenarioIdReservationService.js';
import {
  getMachineCapacitiesForYear,
  getMachineLoadComputationDetails,
  resolveSettingsForYear,
  volumeToWeekly,
  resolveOperationVolumeForYear,
  resolveSourceMachineWeeklyForAllocation,
  type SourceMachineWeekly,
  type OperationYearVolumeRow,
  getEffectiveVolumeForPart,
  getEffectiveVolumeForPartPreferContract,
  resolveWeeklyVolumeFromResolved,
  resolveOperationCycleForCalculator,
  operationHasAlternativeCycle,
  invalidateAllocationSplitIndex,
} from './capacityService.js';
import { assignIsoWeekToStartMonth, getProductionMonthNumbersInYear, getProductionMonthsInYear, parseSopEop } from '../utils/sopEopFormat.js';

/** Alokacja „placeholder” — wolumen 0, ale rok w zakresie SOP–EOP (wolumeny mogą pojawić się później). */
export function canAllocateZeroVolumePlaceholder(
  sop: unknown,
  eop: unknown,
  year: number,
  resolvedVolume: number
): boolean {
  if (resolvedVolume > 1e-9) return false;
  return getProductionMonthsInYear(sop, eop, year) > 0;
}

export type TargetCycleOnAllocation = {
  cycleTimeSecondsOnTarget?: number | null;
  useAlternativeCycleOnTarget?: boolean;
};

/** Czas / gniazda / OEE operacji na maszynie docelowej po alokacji. */
export function resolveTargetCycleOnAllocation(
  op: any,
  opts: TargetCycleOnAllocation
): { ok: true; cycleSeconds: number; nests: number; oeeForResolve: number | null } | { ok: false; error: string } {
  if (opts.useAlternativeCycleOnTarget) {
    if (!operationHasAlternativeCycle(op)) {
      return { ok: false, error: 'Operacja nie ma zdefiniowanego alternatywnego czasu cyklu.' };
    }
    const alt = Number(op.alt_cycle_time_seconds);
    const nestsRaw =
      op.alt_nests_count != null && Number(op.alt_nests_count) > 0
        ? Number(op.alt_nests_count)
        : Number(op.nests_count ?? 1);
    const oee =
      op.alt_oee_override != null && Number(op.alt_oee_override) > 0
        ? Number(op.alt_oee_override)
        : op.oee_override != null
          ? Number(op.oee_override)
          : null;
    return { ok: true, cycleSeconds: alt, nests: Math.max(1, nestsRaw || 1), oeeForResolve: oee };
  }
  const manual =
    opts.cycleTimeSecondsOnTarget != null &&
    Number.isFinite(Number(opts.cycleTimeSecondsOnTarget)) &&
    Number(opts.cycleTimeSecondsOnTarget) > 0;
  if (manual) {
    return {
      ok: true,
      cycleSeconds: Number(opts.cycleTimeSecondsOnTarget),
      nests: Math.max(1, Number(op.nests_count ?? 1) || 1),
      oeeForResolve: op.oee_override != null ? Number(op.oee_override) : null,
    };
  }
  const resolved = resolveOperationCycleForCalculator(op);
  return {
    ok: true,
    cycleSeconds: resolved.cycleSeconds,
    nests: resolved.nests,
    oeeForResolve: resolved.oeeForResolve,
  };
}
import type { ScenarioBundle, ScenarioVolumeEdit } from './scenarioSnapshotService.js';
import {
  parseScenarioSnapshotJson,
  pushScenarioAudit,
  scenarioAssignedMachineLabel,
  scenarioAssignedPartLabel,
  resolveSettingsForScenarioYear,
  scenarioHydratedOperationsForActiveProjects,
  getEffectiveVolumeForPartScenarioPreferContract,
} from './scenarioSnapshotService.js';

export interface OverloadInfo {
  machine_id: number;
  internal_number: string | number;
  type: string;
  year: number;
  load_percent: number;
  required_sec_per_week: number;
  availability_sec_per_week: number;
}

export function getOverloadedMachines(year: number, thresholdPercent: number = 100): OverloadInfo[] {
  const rows = getMachineCapacitiesForYear(year);
  return rows.filter((r) => r.load_percent > thresholdPercent).map((r) => ({
    machine_id: r.machine_id,
    internal_number: r.internal_number,
    type: r.type,
    year,
    load_percent: r.load_percent,
    required_sec_per_week: r.required_sec_per_week,
    availability_sec_per_week: r.availability_sec_per_week,
  }));
}

/** Get candidate machines for reallocation: same nest OR in alternatives list; optionally same line (pole location = nr linii). Must be "free" (under threshold). */
export function getCandidatesForAllocation(
  machineId: number,
  year: number,
  maxLoadPercent: number = 90,
  /** Do listy wyboru (np. modal alokacji): dołącz maszyny z jawnej listy alternatyw nawet przy obciążeniu ≥ max (bez zmiany filtru gniazda). */
  includeOverloadedAlternatives: boolean = false,
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfq: boolean = true,
  useContractualVolumes: boolean = false
): { machine_id: number; internal_number: string | number; type: string; sap_number: string | null; load_percent: number; free_capacity_sec_per_week: number }[] {
  const opsOverride =
    scenarioSnapshot != null ? scenarioHydratedOperationsForActiveProjects(scenarioSnapshot, { includeRfq: scenarioIncludeRfq }) : undefined;
  const capacities = getMachineCapacitiesForYear(
    year,
    undefined,
    undefined,
    opsOverride,
    scenarioSnapshot ?? null,
    scenarioIncludeRfq,
    useContractualVolumes
  );
  const sourceMachine = capacities.find((c) => c.machine_id === machineId);
  /* Bez wiersza źródła (np. maszyna nieaktywna) nie ma sensu listy kandydatów. */
  if (!sourceMachine) return [];

  const nestMachineIds = db.prepare(`
    SELECT nm2.machine_id
    FROM nest_machines nm1
    JOIN nest_machines nm2 ON nm2.nest_id = nm1.nest_id
    WHERE nm1.machine_id = ? AND nm2.machine_id != ?
  `).all(machineId, machineId) as { machine_id: number }[];

  const altMachineIds = db.prepare(`
    SELECT alternative_machine_id AS machine_id FROM machine_alternatives WHERE machine_id = ?
  `).all(machineId) as { machine_id: number }[];

  const candidateIds = new Set<number>([
    ...nestMachineIds.map((m) => m.machine_id),
    ...altMachineIds.map((m) => m.machine_id),
  ]);

  const sourceLocation = sourceMachine.location ?? null;

  const buildList = (respectLocation: boolean) => {
    const result: { machine_id: number; internal_number: string | number; type: string; sap_number: string | null; load_percent: number; free_capacity_sec_per_week: number }[] = [];
    for (const id of candidateIds) {
      const cap = capacities.find((c) => c.machine_id === id);
      if (!cap || cap.load_percent >= maxLoadPercent) continue;

      if (respectLocation && sourceLocation) {
        if (cap.location != null && String(cap.location) !== String(sourceLocation)) continue;
      }

      const freeSec = Math.max(0, cap.availability_sec_per_week - cap.required_sec_per_week);
      const machineRow = db.prepare('SELECT internal_number, type, sap_number FROM machines WHERE id = ?').get(id) as any;
      result.push({
        machine_id: id,
        internal_number: machineRow.internal_number,
        type: machineRow.type,
        sap_number: machineRow.sap_number ?? null,
        load_percent: cap.load_percent,
        free_capacity_sec_per_week: freeSec,
      });
    }
    result.sort((a, b) => b.free_capacity_sec_per_week - a.free_capacity_sec_per_week);
    return result;
  };

  let result = buildList(true);
  /* Gdy w bazie są alternatywy / gniazdo, ale wszystkie odpadły przez różny nr linii — pokaż je mimo to. */
  if (result.length === 0 && candidateIds.size > 0) {
    result = buildList(false);
  }

  if (!includeOverloadedAlternatives) return result;

  const inResult = new Set(result.map((r) => r.machine_id));
  const extra: typeof result = [];
  for (const row of altMachineIds) {
    const id = row.machine_id;
    if (inResult.has(id)) continue;
    const cap = capacities.find((c) => c.machine_id === id);
    if (!cap) continue;
    const freeSec = Math.max(0, cap.availability_sec_per_week - cap.required_sec_per_week);
    const machineRow = db.prepare('SELECT internal_number, type, sap_number FROM machines WHERE id = ?').get(id) as any;
    if (!machineRow) continue;
    extra.push({
      machine_id: id,
      internal_number: machineRow.internal_number,
      type: machineRow.type,
      sap_number: machineRow.sap_number ?? null,
      load_percent: cap.load_percent,
      free_capacity_sec_per_week: freeSec,
    });
  }
  extra.sort((a, b) => b.free_capacity_sec_per_week - a.free_capacity_sec_per_week);
  return [...result, ...extra];
}

export type AllocationLoadHint = {
  current_load_percent: number;
  /** Udział tej operacji w obciążeniu maszyny (jak w kalkulatorze). */
  op_load_percent: number;
  /** Wolumen do przeniesienia (w jednostce effective), żeby zostawić maszynę źródłową przy ~100% obciążenia (tylko ta operacja). */
  suggested_volume_to_reach_100: number;
  suggested_volume_unit: 'annual' | 'monthly' | 'weekly';
  effective_volume_value: number;
  effective_volume_unit: 'annual' | 'monthly' | 'weekly';
  load_ratio_sum: number;
  usage: number;
  op_ratio_contrib: number;
  weekly_volume_effective: number;
  working_weeks_per_year: number;
  year_fraction: number;
};

/** Udział jednej operacji w obciążeniu maszyny [%], spójny z current_load_percent. */
export function operationLoadPercentOfMachine(
  loadRatioSum: number,
  opRatioContrib: number,
  machineLoadPercent: number
): number {
  if (loadRatioSum <= 1e-12 || opRatioContrib <= 1e-12) return 0;
  return (opRatioContrib / loadRatioSum) * machineLoadPercent;
}

/**
 * Tygodniowy wolumen efektywny grupy, do którego odnosi się op_load_percent.
 * Tylko ten wolumen może służyć do przeliczeń obciążenie% ↔ wolumen (jest spójny z op_load_percent).
 */
function movableBaseWeekly(
  hint: Pick<AllocationLoadHint, 'weekly_volume_effective'>,
  groupWeeklyMovable?: number
): number {
  const group = groupWeeklyMovable ?? 0;
  if (group > 1e-9) return group;
  return hint.weekly_volume_effective > 1e-9 ? hint.weekly_volume_effective : 0;
}

/** Szacowane obciążenie maszyny po przeniesieniu wolumenu (effective weekly) z wybranej operacji. */
export function projectMachineLoadAfterTransfer(
  hint: Pick<
    AllocationLoadHint,
    'current_load_percent' | 'load_ratio_sum' | 'op_ratio_contrib' | 'weekly_volume_effective' | 'op_load_percent'
  >,
  moveWeeklyEffective: number,
  groupWeeklyMovable?: number
): number {
  const base = movableBaseWeekly(hint, groupWeeklyMovable);
  if (base <= 1e-12) return hint.current_load_percent;
  const applied = Math.min(base, Math.max(0, moveWeeklyEffective));
  const opLoadPercent =
    hint.op_load_percent > 1e-9
      ? hint.op_load_percent
      : operationLoadPercentOfMachine(hint.load_ratio_sum, hint.op_ratio_contrib, hint.current_load_percent);
  const reduction = (applied / base) * opLoadPercent;
  return Math.round(Math.max(0, hint.current_load_percent - reduction));
}

/**
 * Wolumen przeniesienia z żądania execute — spójny z effective_volume_weekly z API maszyn.
 * Gdy unit=weekly, wartość jest już tygodniowym wolumenem efektywnym dla roku (SOP/EOP), bez ponownego × fraction.
 */
export function resolveAllocationMoveWeekly(
  volumeToMove: number,
  volumeUnit: 'annual' | 'monthly' | 'weekly',
  settings: Parameters<typeof volumeToWeekly>[2],
  yearFraction: number
): { moveWeeklyEffective: number; moveBaseWeekly: number } {
  const f = yearFraction > 1e-12 ? yearFraction : 1;
  if (volumeUnit === 'weekly') {
    return {
      moveWeeklyEffective: volumeToMove,
      moveBaseWeekly: volumeToMove / f,
    };
  }
  const moveWeeklyEffective = volumeToWeekly(volumeToMove, volumeUnit, settings) * f;
  return {
    moveWeeklyEffective,
    moveBaseWeekly: moveWeeklyEffective / f,
  };
}

/**
 * Wolumen do przeniesienia, aby po alokacji na maszynie źródłowej zostało `remainingLoadPercent` obciążenia.
 */
export function computeVolumeForRemainingMachineLoad(
  hint: AllocationLoadHint,
  /** Docelowe obciążenie maszyny źródłowej po przeniesieniu [%] — „ile ma pozostać”. */
  remainingLoadPercent: number,
  groupWeeklyMovable?: number
): {
  volume: number;
  unit: AllocationLoadHint['suggested_volume_unit'];
  projected_load_percent: number;
  move_weekly_effective: number;
  insufficient: boolean;
  already_at_or_below: boolean;
} {
  const remaining = Math.min(300, Math.max(0, remainingLoadPercent));
  const current = hint.current_load_percent;
  const u = hint.suggested_volume_unit;
  const base = movableBaseWeekly(hint, groupWeeklyMovable);

  if (current <= remaining + 1e-9) {
    return {
      volume: 0,
      unit: u,
      projected_load_percent: current,
      move_weekly_effective: 0,
      insufficient: false,
      already_at_or_below: true,
    };
  }
  if (base <= 1e-9) {
    return {
      volume: 0,
      unit: u,
      projected_load_percent: current,
      move_weekly_effective: 0,
      insufficient: true,
      already_at_or_below: false,
    };
  }

  const surplusLoadPercent = current - remaining;
  const opLoadPercent =
    hint.op_load_percent > 1e-9
      ? hint.op_load_percent
      : operationLoadPercentOfMachine(hint.load_ratio_sum, hint.op_ratio_contrib, current);

  if (opLoadPercent <= 1e-9) {
    return {
      volume: 0,
      unit: u,
      projected_load_percent: current,
      move_weekly_effective: 0,
      insufficient: true,
      already_at_or_below: false,
    };
  }

  // Ułamek wolumenu grupy do przeniesienia: ile trzeba zabrać, aby zdjąć `surplus` p.p. obciążenia.
  const fractionOfGroup = Math.min(1, Math.max(0, surplusLoadPercent / opLoadPercent));
  const moveWeeklyEff = fractionOfGroup * base;

  // Cała grupa zdejmuje tylko op_load_percent p.p. — gdy to za mało, nie da się zejść do celu jedną operacją.
  const projectedIfMoveAll = Math.round(Math.max(0, current - opLoadPercent));
  const insufficient = projectedIfMoveAll > remaining + 1;
  const projected = projectMachineLoadAfterTransfer(hint, moveWeeklyEff, base);

  const fractionY = hint.year_fraction > 1e-12 ? hint.year_fraction : 1;
  const moveBaseWeekly = moveWeeklyEff / fractionY;
  let volume = 0;
  if (u === 'weekly') volume = moveBaseWeekly;
  else if (u === 'annual') volume = moveBaseWeekly * hint.working_weeks_per_year;
  else volume = (moveBaseWeekly * hint.working_weeks_per_year) / 12;

  return {
    volume: Math.round(volume * 1e6) / 1e6,
    unit: u,
    projected_load_percent: projected,
    move_weekly_effective: moveWeeklyEff,
    insufficient,
    already_at_or_below: false,
  };
}

/** @deprecated alias — używaj computeVolumeForRemainingMachineLoad */
export function computeSurplusVolumeForTargetLoad(
  hint: AllocationLoadHint,
  remainingLoadPercent: number,
  groupWeeklyMovable?: number
): { volume: number; unit: AllocationLoadHint['suggested_volume_unit']; projected_load_percent: number } {
  const r = computeVolumeForRemainingMachineLoad(hint, remainingLoadPercent, groupWeeklyMovable);
  return { volume: r.volume, unit: r.unit, projected_load_percent: r.projected_load_percent };
}

/**
 * Sugestia przeniesienia wolumenu z jednej operacji, żeby po przeniesieniu obciążenie maszyny źródłowej było ~100%
 * (wg tej samej metody co kalkulator: suma required/availability per operacja × usage).
 * Pola load_ratio_sum, op_ratio_contrib, weekly_volume_effective, usage, year_fraction służą do symulacji % po przeniesieniu (klient).
 */
export function getAllocationLoadHint(
  machineId: number,
  year: number,
  operationIds: number[],
  scenarioSnapshot?: ScenarioBundle | null,
  scenarioIncludeRfq: boolean = true,
  useContractualVolumes: boolean = false
): AllocationLoadHint | { error: string } {
  const ids = [...new Set(operationIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return { error: 'Brak identyfikatorów operacji.' };

  const details = getMachineLoadComputationDetails(
    year,
    machineId,
    undefined,
    scenarioSnapshot ?? null,
    scenarioIncludeRfq,
    useContractualVolumes
  );
  if (!details) return { error: 'Brak danych capacity (ustawienia roku lub maszyna).' };

  const ops = ids.map((id) => details.op_by_id[id]).filter((o): o is NonNullable<typeof o> => o != null);
  if (ops.length === 0) return { error: 'Operacja nie należy do tej maszyny lub brak w danym roku.' };

  const { load_ratio_sum: loadRatioSum, usage, working_weeks_per_year: workWeeks } = details;
  const ratioContrib = ops.reduce((s, o) => s + o.ratio_contrib, 0);
  const weeklyVol = ops.reduce((s, o) => s + o.weekly_volume, 0);
  const primary = ops.reduce((best, o) => (o.weekly_volume > best.weekly_volume ? o : best), ops[0]);
  const fraction = primary.fraction > 1e-12 ? primary.fraction : 1;
  const u = primary.resolved_volume_unit;

  const weeklyRounded = Math.round(weeklyVol * 1e6) / 1e6;
  const baseHint: AllocationLoadHint = {
    current_load_percent: details.load_percent,
    op_load_percent: operationLoadPercentOfMachine(loadRatioSum, ratioContrib, details.load_percent),
    suggested_volume_to_reach_100: 0,
    suggested_volume_unit: u,
    effective_volume_value: primary.resolved_volume_value,
    effective_volume_unit: u,
    load_ratio_sum: loadRatioSum,
    usage,
    op_ratio_contrib: ratioContrib,
    weekly_volume_effective: weeklyRounded,
    working_weeks_per_year: workWeeks,
    year_fraction: Math.round((fraction > 1e-12 ? fraction : 1) * 1e6) / 1e6,
  };

  const to100 = computeVolumeForRemainingMachineLoad(baseHint, 100, weeklyRounded);
  baseHint.suggested_volume_to_reach_100 = to100.volume;

  return baseHint;
}

function yearVolumeMapFromRows(rows: any[]): Map<number, OperationYearVolumeRow> {
  const map = new Map<number, OperationYearVolumeRow>();
  for (const r of rows) {
    const id = Number(r.operation_id);
    if (!Number.isFinite(id)) continue;
    map.set(id, {
      volume_value: Number(r.volume_value),
      volume_unit: String(r.volume_unit || 'annual'),
      volume_value_before: r.volume_value_before ?? null,
      effective_from_month: r.effective_from_month ?? null,
      effective_from_week: r.effective_from_week ?? null,
      source: r.source ?? null,
    });
  }
  return map;
}

/**
 * Zapis przeniesienia. W niepełnym roku displayWeekly jest zagęszczony jak na maszynie,
 * a do bazy wraca ta sama waga udziału, która tam już leżała.
 */
function allocationStoredVolumes(
  fromMonth: number | null,
  view: SourceMachineWeekly,
  currentWeekly: number,
  moveWeekly: number,
  fraction: number,
  moveBaseWeekly: number,
  volumeToMove: number,
  volumeUnit: string
): { remainingBaseWeekly: number; childVolumeValue: number; childVolumeUnit: string } {
  if (fromMonth == null && view.shareWeightWeekly != null && currentWeekly > 1e-9) {
    const ratio = view.shareWeightWeekly / currentWeekly;
    let remainingBaseWeekly = Math.max(0, view.shareWeightWeekly - moveWeekly * ratio);
    if (remainingBaseWeekly < 1e-6) remainingBaseWeekly = 0;
    return { remainingBaseWeekly, childVolumeValue: moveWeekly * ratio, childVolumeUnit: 'weekly' };
  }
  return {
    remainingBaseWeekly: fraction > 1e-9 ? (currentWeekly - moveWeekly) / fraction : currentWeekly - moveWeekly,
    childVolumeValue: volumeUnit === 'weekly' ? moveBaseWeekly : volumeToMove,
    childVolumeUnit: volumeUnit === 'weekly' ? 'weekly' : volumeUnit,
  };
}

/** Execute allocation: move (or split) volume for wybrany rok — ten sam wolumen co w kalkulatorze (nadpisanie per rok > projekt/detal > pole operacji). */
export function executeAllocation(
  operationId: number,
  targetMachineId: number,
  volumeToMove: number,
  volumeUnit: 'annual' | 'monthly' | 'weekly',
  year: number,
  cycleTimeSecondsOnTarget?: number | null,
  useContractualVolumes: boolean = false,
  useAlternativeCycleOnTarget: boolean = false,
  effectiveFrom?: { month: number; week?: number } | null
): { success: boolean; error?: string } {
  const op = db
    .prepare(
      `
    SELECT o.*, p.sop, p.eop
    FROM operations o
    JOIN projects p ON p.id = o.project_id
    WHERE o.id = ?
  `
    )
    .get(operationId) as any;
  if (!op) return { success: false, error: 'Operation not found' };
  const targetMachineError = allocationTargetMachineError(targetMachineId);
  if (targetMachineError) return { success: false, error: targetMachineError };

  const settings = resolveSettingsForYear(year);

  const opYearRow = db
    .prepare(
      `SELECT volume_value, volume_unit, volume_value_before, effective_from_month, effective_from_week, source
       FROM operation_volume_by_year WHERE operation_id = ? AND year = ?`
    )
    .get(operationId, year) as OperationYearVolumeRow | undefined;

  let yearRows: any[] = [];
  try {
    yearRows = db
      .prepare(
        `SELECT operation_id, volume_value, volume_unit, volume_value_before, effective_from_month, effective_from_week, source
         FROM operation_volume_by_year WHERE year = ?`
      )
      .all(year) as any[];
  } catch {
    yearRows = db
      .prepare(`SELECT operation_id, volume_value, volume_unit FROM operation_volume_by_year WHERE year = ?`)
      .all(year) as any[];
  }

  /**
   * Sufit przeniesienia = tygodniówka z obciążenia maszyny źródłowej (także niepełny rok).
   * effectiveFrom z tego żądania nie wchodzi do stawki — zapisujemy go osobno.
   */
  const view = resolveSourceMachineWeeklyForAllocation({
    operationId,
    projectId: op.project_id ?? null,
    partId: op.part_id ?? null,
    volumeValue: op.volume_value,
    volumeUnit: op.volume_unit,
    splitFromOperationId: op.split_from_operation_id ?? null,
    year,
    opYearRow: opYearRow ?? null,
    scenarioSnapshot: null,
    useContractualVolumes,
    settings,
    sop: op.sop ?? '',
    eop: op.eop ?? '',
    volumeMap: yearVolumeMapFromRows(yearRows),
  });
  const resolved = {
    volume_value: view.volumeValue,
    volume_unit: view.volumeUnit,
    volume_origin: view.volumeOrigin,
    count_after_eop: view.countAfterEop,
  };

  const zeroPlaceholder = canAllocateZeroVolumePlaceholder(op.sop, op.eop, year, resolved.volume_value);

  if (resolved.volume_value <= 0 && !zeroPlaceholder) {
    return { success: false, error: 'Dla wybranego roku wolumen tej operacji wynosi 0.' };
  }

  const fraction = zeroPlaceholder ? 1 : view.fraction;
  const currentWeekly = zeroPlaceholder ? 0 : view.displayWeekly;
  const { moveWeeklyEffective: moveWeekly, moveBaseWeekly } = zeroPlaceholder
    ? { moveWeeklyEffective: 0, moveBaseWeekly: 0 }
    : resolveAllocationMoveWeekly(volumeToMove, volumeUnit, settings, fraction);

  if (zeroPlaceholder) {
    if (volumeToMove > 1e-6) {
      return { success: false, error: 'Dla roku bez wolumenu można przypisać detal tylko z przeniesieniem 0.' };
    }
  } else {
    if (volumeToMove <= 0) return { success: false, error: 'Wolumen musi być dodatni.' };
    if (moveWeekly > currentWeekly + 1e-6) {
      return { success: false, error: 'Wolumen do przeniesienia przekracza wolumen operacji dla wybranego roku.' };
    }
  }

  const targetCycle = resolveTargetCycleOnAllocation(op, {
    cycleTimeSecondsOnTarget,
    useAlternativeCycleOnTarget,
  });
  if (!targetCycle.ok) return { success: false, error: targetCycle.error };
  const effectiveCycleOnTarget = targetCycle.cycleSeconds;
  const targetNests = targetCycle.nests;
  const targetOeeOverride = targetCycle.oeeForResolve;

  // Zawsze wykonujemy podział roczny (nawet przy "pełnym" przeniesieniu roku),
  // żeby nie przepinać całej operacji globalnie między maszynami.
  const fromMonth =
    effectiveFrom?.month != null && Number.isFinite(Number(effectiveFrom.month))
      ? Math.min(12, Math.max(1, Math.floor(Number(effectiveFrom.month))))
      : null;
  const fromWeek =
    fromMonth != null
      ? Math.min(5, Math.max(1, Math.floor(Number(effectiveFrom?.week) || 1)))
      : null;
  const stored = allocationStoredVolumes(
    fromMonth,
    view,
    currentWeekly,
    moveWeekly,
    fraction,
    moveBaseWeekly,
    volumeToMove,
    volumeUnit
  );
  const remainingBaseWeekly = stored.remainingBaseWeekly;
  const childVolumeValue = stored.childVolumeValue;
  const childVolumeUnit = stored.childVolumeUnit;

  /** Przy alokacji od miesiąca/tygodnia: pełna stawka (bazowa weekly) przed punktem startu. */
  const parentBeforeWeekly =
    fromMonth != null
      ? (() => {
          if (opYearRow?.effective_from_month != null && opYearRow.volume_value_before != null) {
            return Number(opYearRow.volume_value_before);
          }
          return fraction > 1e-9 ? currentWeekly / fraction : currentWeekly;
        })()
      : null;

  upsertOperationYearVolume({
    operationId,
    year,
    volumeValue: remainingBaseWeekly,
    volumeUnit: 'weekly',
    source: 'allocation',
    volumeValueBefore: parentBeforeWeekly,
    effectiveFromMonth: fromMonth,
    effectiveFromWeek: fromWeek,
  });

  const insertOp = db.prepare(`
    INSERT INTO operations (project_id, part_id, phase_id, machine_id, cycle_time_seconds, volume_value, volume_unit, nests_count, oee_override, capacity_percent, opf, sap, description, split_from_operation_id,
      alt_cycle_time_seconds, alt_nests_count, alt_oee_override, alt_comment, use_alternative_in_calculator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insResult = insertOp.run(
    op.project_id,
    op.part_id,
    op.phase_id,
    targetMachineId,
    effectiveCycleOnTarget,
    0,
    'weekly',
    targetNests,
    targetOeeOverride,
    op.capacity_percent,
    op.opf,
    op.sap,
    op.description,
    operationId,
    null,
    null,
    null,
    null,
    0
  );
  const newOpId = insResult.lastInsertRowid;
  if (newOpId) {
    seedSplitChildYearVolumes(
      Number(newOpId),
      Number(op.project_id),
      operationId,
      year,
      childVolumeValue,
      childVolumeUnit,
      fromMonth != null
        ? { month: fromMonth, week: fromWeek ?? 1, volumeBefore: 0 }
        : null
    );
  }

  saveDb();
  invalidateAllocationSplitIndex();
  return { success: true };
}

function upsertOperationYearVolume(opts: {
  operationId: number;
  year: number;
  volumeValue: number;
  volumeUnit: string;
  source: string;
  volumeValueBefore?: number | null;
  effectiveFromMonth?: number | null;
  effectiveFromWeek?: number | null;
}): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO operation_volume_by_year
        (operation_id, year, volume_value, volume_unit, source, volume_value_before, effective_from_month, effective_from_week)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.operationId,
      opts.year,
      opts.volumeValue,
      opts.volumeUnit,
      opts.source,
      opts.volumeValueBefore ?? null,
      opts.effectiveFromMonth ?? null,
      opts.effectiveFromWeek ?? null
    );
  } catch (_) {
    db.prepare(
      'INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit, source) VALUES (?, ?, ?, ?, ?)'
    ).run(opts.operationId, opts.year, opts.volumeValue, opts.volumeUnit, opts.source);
  }
}

function upsertOpYearInBundle(
  bundle: ScenarioBundle,
  operationId: number,
  year: number,
  volumeValue: number,
  volumeUnit: string,
  source: string,
  effectiveFrom?: { month: number; week: number; volumeBefore: number } | null
): void {
  if (!bundle.operation_volume_by_year) bundle.operation_volume_by_year = [];
  const rows = bundle.operation_volume_by_year;
  const idx = rows.findIndex((r: any) => Number(r.operation_id) === operationId && Number(r.year) === year);
  const next: any = {
    operation_id: operationId,
    year,
    volume_value: volumeValue,
    volume_unit: volumeUnit,
    source,
    volume_value_before: effectiveFrom ? effectiveFrom.volumeBefore : null,
    effective_from_month: effectiveFrom ? effectiveFrom.month : null,
    effective_from_week: effectiveFrom ? effectiveFrom.week : null,
  };
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...next };
  } else {
    rows.push(next);
  }
}

function ensureSplitChildYearCoverageScenario(bundle: ScenarioBundle, operationId: number): void {
  const ops = bundle.operations || [];
  const op = ops.find((o: any) => Number(o.id) === operationId) as any;
  if (!op || op.split_from_operation_id == null) return;

  let yearList = yearsForSplitChildScenario(bundle, Number(op.project_id), Number(op.split_from_operation_id), new Date().getFullYear());
  const ov = bundle.operation_volume_by_year || [];
  for (const v of ov.filter((row: any) => Number(row.operation_id) === operationId)) {
    const y = Number(v.year);
    if (Number.isInteger(y) && !yearList.includes(y)) yearList.push(y);
  }
  yearList = [...new Set(yearList)].sort((a, b) => a - b);
  if (yearList.length === 0) return;

  if (!bundle.operation_volume_by_year) bundle.operation_volume_by_year = [];
  const ovRows = bundle.operation_volume_by_year;
  for (const y of yearList) {
    const has = ovRows.some((v: any) => Number(v.operation_id) === operationId && Number(v.year) === y);
    if (!has) ovRows.push({ operation_id: operationId, year: y, volume_value: 0, volume_unit: 'weekly', source: 'allocation' });
  }
}

/** Alokacja zapisana wyłącznie w snapshotcie scenariusza (bez zmian w tabelach produkcyjnych). */
export function executeAllocationInScenario(
  scenarioId: number,
  operationId: number,
  targetMachineId: number,
  volumeToMove: number,
  volumeUnit: 'annual' | 'monthly' | 'weekly',
  year: number,
  cycleTimeSecondsOnTarget?: number | null,
  actor: string = 'system',
  useContractualVolumes: boolean = false,
  useAlternativeCycleOnTarget: boolean = false,
  effectiveFrom?: { month: number; week?: number } | null,
  batchId?: string | null
): { success: boolean; error?: string } {
  const row = db.prepare('SELECT snapshot FROM scenarios WHERE id = ?').get(scenarioId) as { snapshot: string } | undefined;
  if (!row) return { success: false, error: 'Scenariusz nie znaleziony' };
  let bundle: ScenarioBundle;
  try {
    bundle = parseScenarioSnapshotJson(row.snapshot);
  } catch {
    return { success: false, error: 'Niepoprawny snapshot scenariusza' };
  }

  const ops = bundle.operations || [];
  const op = ops.find((o: any) => Number(o.id) === operationId) as any;
  if (!op) return { success: false, error: 'Operation not found' };
  const targetMachineError = allocationTargetMachineError(targetMachineId);
  if (targetMachineError) return { success: false, error: targetMachineError };

  const proj = (bundle.projects || []).find((p: any) => Number(p.id) === Number(op.project_id));
  const sop = proj?.sop ?? '';
  const eop = proj?.eop ?? '';

  const ovRows = bundle.operation_volume_by_year || [];
  const opYearRow = ovRows.find((v: any) => Number(v.operation_id) === operationId && Number(v.year) === year) as
    | OperationYearVolumeRow
    | undefined;

  const settings = resolveSettingsForScenarioYear(year, bundle) ?? resolveSettingsForYear(year);

  const view = resolveSourceMachineWeeklyForAllocation({
    operationId,
    projectId: op.project_id ?? null,
    partId: op.part_id ?? null,
    volumeValue: op.volume_value,
    volumeUnit: op.volume_unit,
    splitFromOperationId: op.split_from_operation_id ?? null,
    year,
    opYearRow: opYearRow ?? null,
    scenarioSnapshot: bundle,
    useContractualVolumes,
    settings,
    sop: String(sop),
    eop: String(eop),
    volumeMap: yearVolumeMapFromRows(ovRows.filter((v: any) => Number(v.year) === year)),
    splitOperations: ops,
  });
  const resolved = {
    volume_value: view.volumeValue,
    volume_unit: view.volumeUnit,
    volume_origin: view.volumeOrigin,
    count_after_eop: view.countAfterEop,
  };

  const zeroPlaceholder = canAllocateZeroVolumePlaceholder(sop, eop, year, resolved.volume_value);

  if (resolved.volume_value <= 0 && !zeroPlaceholder) {
    return { success: false, error: 'Dla wybranego roku wolumen tej operacji wynosi 0.' };
  }

  const fraction = zeroPlaceholder ? 1 : view.fraction;
  const currentWeekly = zeroPlaceholder ? 0 : view.displayWeekly;
  const { moveWeeklyEffective: moveWeekly, moveBaseWeekly } = zeroPlaceholder
    ? { moveWeeklyEffective: 0, moveBaseWeekly: 0 }
    : resolveAllocationMoveWeekly(volumeToMove, volumeUnit, settings, fraction);

  if (zeroPlaceholder) {
    if (volumeToMove > 1e-6) {
      return { success: false, error: 'Dla roku bez wolumenu można przypisać detal tylko z przeniesieniem 0.' };
    }
  } else {
    if (volumeToMove <= 0) return { success: false, error: 'Wolumen musi być dodatni.' };
    if (moveWeekly > currentWeekly + 1e-6) {
      return { success: false, error: 'Wolumen do przeniesienia przekracza wolumen operacji dla wybranego roku.' };
    }
  }

  const targetCycle = resolveTargetCycleOnAllocation(op, {
    cycleTimeSecondsOnTarget,
    useAlternativeCycleOnTarget,
  });
  if (!targetCycle.ok) return { success: false, error: targetCycle.error };
  const effectiveCycleOnTarget = targetCycle.cycleSeconds;
  const targetNests = targetCycle.nests;
  const targetOeeOverride = targetCycle.oeeForResolve;

  const parentYearBefore = opYearRow ? JSON.parse(JSON.stringify(opYearRow)) : null;
  const sourceMachineId = Number(op.machine_id);

  const fromMonth =
    effectiveFrom?.month != null && Number.isFinite(Number(effectiveFrom.month))
      ? Math.min(12, Math.max(1, Math.floor(Number(effectiveFrom.month))))
      : null;
  const fromWeek =
    fromMonth != null
      ? Math.min(5, Math.max(1, Math.floor(Number(effectiveFrom?.week) || 1)))
      : null;
  const stored = allocationStoredVolumes(
    fromMonth,
    view,
    currentWeekly,
    moveWeekly,
    fraction,
    moveBaseWeekly,
    volumeToMove,
    volumeUnit
  );
  const remainingBaseWeekly = stored.remainingBaseWeekly;
  const childVolumeValue = stored.childVolumeValue;
  const childVolumeUnit = stored.childVolumeUnit;
  const parentBeforeWeekly =
    fromMonth != null
      ? opYearRow?.effective_from_month != null && opYearRow.volume_value_before != null
        ? Number(opYearRow.volume_value_before)
        : fraction > 1e-9
          ? currentWeekly / fraction
          : currentWeekly
      : null;
  const parentEffective =
    fromMonth != null
      ? { month: fromMonth, week: fromWeek ?? 1, volumeBefore: parentBeforeWeekly ?? currentWeekly }
      : null;

  upsertOpYearInBundle(bundle, operationId, year, remainingBaseWeekly, 'weekly', 'allocation', parentEffective);

  const newOpId = allocateScenarioEntityId('operation', scenarioId, bundle);
  const newOp: any = {
    ...op,
    id: newOpId,
    machine_id: targetMachineId,
    cycle_time_seconds: effectiveCycleOnTarget,
    volume_value: 0,
    volume_unit: 'weekly',
    nests_count: targetNests,
    oee_override: targetOeeOverride,
    split_from_operation_id: operationId,
    alt_cycle_time_seconds: null,
    alt_nests_count: null,
    alt_oee_override: null,
    alt_comment: null,
    use_alternative_in_calculator: 0,
  };
  bundle.operations = [...ops, newOp];

  const childEffective =
    fromMonth != null ? { month: fromMonth, week: fromWeek ?? 1, volumeBefore: 0 } : null;
  const yearList = yearsForSplitChildScenario(bundle, Number(op.project_id), operationId, year);
  for (const y of yearList) {
    if (y === year) upsertOpYearInBundle(bundle, newOpId, y, childVolumeValue, childVolumeUnit, 'allocation', childEffective);
    else upsertOpYearInBundle(bundle, newOpId, y, 0, 'weekly', 'allocation');
  }
  ensureSplitChildYearCoverageScenario(bundle, newOpId);

  const moveBatch = String(batchId ?? '').trim() || `move-${newOpId}`;
  if (!bundle.allocation_moves) bundle.allocation_moves = [];
  let pack = bundle.allocation_moves.find((m) => m.batchId === moveBatch);
  if (!pack) {
    const nextMoveId = bundle.allocation_moves.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1;
    pack = { id: nextMoveId, batchId: moveBatch, at: new Date().toISOString(), steps: [] };
    bundle.allocation_moves.push(pack);
  }
  pack.steps.push({
    sourceOperationId: operationId,
    childOperationId: newOpId,
    year,
    sourceMachineId: Number.isFinite(sourceMachineId) ? sourceMachineId : 0,
    targetMachineId,
    partId: op.part_id != null ? Number(op.part_id) : null,
    parentYearBefore,
  });

  const partLabel = scenarioAssignedPartLabel(bundle, op.part_id != null ? Number(op.part_id) : null);
  const sourceLabel = scenarioAssignedMachineLabel(Number(op.machine_id));
  const targetLabel = scenarioAssignedMachineLabel(targetMachineId);
  const detailBit = partLabel ? `detalu ${partLabel}` : 'detalu';
  pushScenarioAudit(bundle, {
    author: actor || 'system',
    note_type: 'auto',
    note: `Automatyczna zmiana: alokacja — część wolumenu ${detailBit} z maszyny ${sourceLabel} przeniesiona na maszynę ${targetLabel}, rok ${year}.`,
    project_id: op.project_id != null ? Number(op.project_id) : null,
    machine_id: targetMachineId,
    part_id: op.part_id != null ? Number(op.part_id) : null,
    operation_id: newOpId,
  });

  try {
    db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), scenarioId);
  } catch {
    db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), scenarioId);
  }
  saveDb();
  invalidateAllocationSplitIndex();
  return { success: true };
}

const AUDIT_ALLOC_NOTE = /operacji #(\d+) przeniesiona na maszynę #(\d+), utworzono operację #(\d+), rok (\d+)/;

/** Starsze notatki alokacji (sprzed pakietów) dopisuje jako osobne ruchy, jeśli operacja-dziecko jeszcze jest. */
export function collectScenarioAllocationMoves(bundle: ScenarioBundle): boolean {
  if (!bundle.allocation_moves) bundle.allocation_moves = [];
  const known = new Set(bundle.allocation_moves.flatMap((m) => m.steps.map((s) => s.childOperationId)));
  let changed = false;
  const notes = [...(bundle.audit_log || [])].sort((a, b) => Number(a.id) - Number(b.id));
  for (const n of notes) {
    const match = AUDIT_ALLOC_NOTE.exec(String(n.note ?? ''));
    if (!match) continue;
    const childId = Number(match[3]);
    if (known.has(childId)) continue;
    const sourceId = Number(match[1]);
    const sourceOp = (bundle.operations || []).find((o: any) => Number(o.id) === sourceId);
    const childExists = (bundle.operations || []).some((o: any) => Number(o.id) === childId);
    if (!childExists) continue;
    const nextId = bundle.allocation_moves.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
    bundle.allocation_moves.push({
      id: nextId,
      batchId: `audit-${n.id}`,
      at: String(n.note_date ?? ''),
      steps: [
        {
          sourceOperationId: sourceId,
          childOperationId: childId,
          year: Number(match[4]),
          sourceMachineId: sourceOp?.machine_id != null ? Number(sourceOp.machine_id) : 0,
          targetMachineId: Number(match[2]),
          partId: n.part_id != null ? Number(n.part_id) : sourceOp?.part_id != null ? Number(sourceOp.part_id) : null,
          parentYearBefore: null,
        },
      ],
    });
    known.add(childId);
    changed = true;
  }
  if (sortAllocationMovesChronologically(bundle)) changed = true;
  return changed;
}

/** Data ruchu. Sama data (YYYY-MM-DD) jest początkiem dnia, więc znacznik z godziną tego samego dnia jest późniejszy. */
function allocationMoveTime(at: string | undefined): number {
  const raw = String(at ?? '').trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareAllocationMoves(
  a: { at?: string; id?: number },
  b: { at?: string; id?: number }
): number {
  const dt = allocationMoveTime(a.at) - allocationMoveTime(b.at);
  if (dt !== 0) return dt;
  return (Number(a.id) || 0) - (Number(b.id) || 0);
}

/** Najstarszy ruch na początku, najnowszy na końcu — od tego zależy cofanie i drzewo ruchów. */
function sortAllocationMovesChronologically(bundle: ScenarioBundle): boolean {
  const moves = bundle.allocation_moves || [];
  const sorted = [...moves].sort(compareAllocationMoves);
  const changed = sorted.some((move, index) => move !== moves[index]);
  if (changed) bundle.allocation_moves = sorted;
  return changed;
}

function restoreScenarioParentYear(bundle: ScenarioBundle, step: NonNullable<ScenarioBundle['allocation_moves']>[number]['steps'][number]): void {
  if (!bundle.operation_volume_by_year) bundle.operation_volume_by_year = [];
  const rows = bundle.operation_volume_by_year;
  const idx = rows.findIndex((r: any) => Number(r.operation_id) === step.sourceOperationId && Number(r.year) === step.year);
  if (step.parentYearBefore) {
    const restored = { ...step.parentYearBefore, operation_id: step.sourceOperationId, year: step.year };
    if (idx >= 0) rows[idx] = restored;
    else rows.push(restored);
    return;
  }
  const child = rows.find((r: any) => Number(r.operation_id) === step.childOperationId && Number(r.year) === step.year);
  if (!child) return;
  if (idx >= 0) {
    rows[idx] = {
      ...rows[idx],
      volume_value: Number(rows[idx].volume_value) + Number(child.volume_value || 0),
    };
  } else {
    rows.push({ ...child, operation_id: step.sourceOperationId });
  }
}

export type ScenarioMoveListItem = {
  id: number;
  at: string;
  years: number[];
  partLabel: string;
  sourceLabel: string;
  targetLabel: string;
  canUndo: boolean;
};

export type ScenarioMoveTreeNode = {
  title: string;
  meta: string;
  children: ScenarioMoveTreeNode[];
};

type OrderedMoveStep = NonNullable<ScenarioBundle['allocation_moves']>[number]['steps'][number] & { order: number };

function orderedAllocationSteps(bundle: ScenarioBundle): OrderedMoveStep[] {
  const out: OrderedMoveStep[] = [];
  let order = 0;
  for (const move of bundle.allocation_moves || []) {
    for (const step of move.steps || []) out.push({ ...step, order: order++ });
  }
  return out;
}

function volumeUnitLabel(unit: unknown): string {
  if (unit === 'monthly') return 'miesięcznie';
  if (unit === 'weekly') return 'tygodniowo';
  return 'rocznie';
}

function operationYearRow(bundle: ScenarioBundle, operationId: number, year: number): { volume_value?: number; volume_unit?: string } | undefined {
  return (bundle.operation_volume_by_year || []).find(
    (r: any) => Number(r.operation_id) === operationId && Number(r.year) === year
  ) as { volume_value?: number; volume_unit?: string } | undefined;
}

/** Wolumen, który zszedł ze zwalnianej maszyny w tym roku — łącznie z tym, co poszło dalej. */
function volumeLeftInYear(bundle: ScenarioBundle, steps: OrderedMoveStep[], step: OrderedMoveStep): Map<string, number> {
  const holders = new Set<number>([step.childOperationId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const next of steps) {
      if (next.year !== step.year) continue;
      if (holders.has(next.sourceOperationId) && !holders.has(next.childOperationId)) {
        holders.add(next.childOperationId);
        grew = true;
      }
    }
  }
  const passedOn = new Set(
    steps.filter((row) => row.year === step.year && holders.has(row.sourceOperationId)).map((row) => row.sourceOperationId)
  );
  const byUnit = new Map<string, number>();
  for (const opId of holders) {
    if (passedOn.has(opId)) continue;
    const row = operationYearRow(bundle, opId, step.year);
    const value = Number(row?.volume_value);
    if (!row || !Number.isFinite(value)) continue;
    const unit = String(row.volume_unit || 'annual');
    byUnit.set(unit, (byUnit.get(unit) || 0) + value);
  }
  if (byUnit.size > 0) return byUnit;
  const direct = operationYearRow(bundle, step.childOperationId, step.year);
  const directValue = Number(direct?.volume_value);
  if (Number.isFinite(directValue)) return new Map([[String(direct?.volume_unit || 'annual'), directValue]]);
  const before = Number(step.parentYearBefore?.volume_value);
  if (Number.isFinite(before)) return new Map([[String(step.parentYearBefore?.volume_unit || 'annual'), before]]);
  return new Map();
}

function yearVolumeTitle(bundle: ScenarioBundle, steps: OrderedMoveStep[], yearSteps: OrderedMoveStep[]): string {
  const year = yearSteps[0].year;
  const byUnit = new Map<string, number>();
  for (const step of yearSteps) {
    for (const [unit, value] of volumeLeftInYear(bundle, steps, step)) {
      if (!Number.isFinite(value)) continue;
      byUnit.set(unit, (byUnit.get(unit) || 0) + value);
    }
  }
  const bits = [...byUnit.entries()].map(([unit, value]) => {
    const rounded = Math.round(value * 1000) / 1000;
    return `${rounded} ${volumeUnitLabel(unit)}`;
  });
  return bits.length > 0 ? `rok ${year} · ${bits.join('; ')}` : `rok ${year}`;
}

function partYearNodes(bundle: ScenarioBundle, allSteps: OrderedMoveStep[], partSteps: OrderedMoveStep[]): ScenarioMoveTreeNode[] {
  return groupSteps(partSteps, (step) => String(step.year))
    .sort((a, b) => a[0].year - b[0].year)
    .map((yearSteps) => ({
      title: yearVolumeTitle(bundle, allSteps, yearSteps),
      meta: '',
      children: [],
    }));
}

function groupSteps(steps: OrderedMoveStep[], key: (step: OrderedMoveStep) => string): OrderedMoveStep[][] {
  const map = new Map<string, OrderedMoveStep[]>();
  for (const step of steps) {
    const k = key(step);
    const bucket = map.get(k);
    if (bucket) bucket.push(step);
    else map.set(k, [step]);
  }
  return [...map.values()].sort((a, b) => Math.min(...a.map((s) => s.order)) - Math.min(...b.map((s) => s.order)));
}

function freedMachineOutline(bundle: ScenarioBundle, steps: OrderedMoveStep[]): ScenarioMoveTreeNode[] {
  const released = steps.filter((step) => step.sourceMachineId > 0);
  return groupSteps(released, (step) => String(step.sourceMachineId))
    .map((machineSteps) => {
      const machineId = machineSteps[0].sourceMachineId;
      const parts = groupSteps(machineSteps, (step) => String(step.partId ?? 0))
        .map((partSteps) => ({
          title: scenarioAssignedPartLabel(bundle, partSteps[0].partId) || 'detal',
          meta: '',
          children: partYearNodes(bundle, steps, partSteps),
        }))
        .sort((a, b) => a.title.localeCompare(b.title, 'pl'));
      return {
        title: scenarioAssignedMachineLabel(machineId),
        meta: '',
        children: parts,
      };
    })
    .filter((node) => node.children.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title, 'pl'));
}

function freedPartOutline(bundle: ScenarioBundle, steps: OrderedMoveStep[]): ScenarioMoveTreeNode[] {
  const released = steps.filter((step) => Number(step.partId) > 0 && step.sourceMachineId > 0);
  return groupSteps(released, (step) => String(step.partId ?? 0))
    .map((partSteps) => {
      const machines = groupSteps(partSteps, (step) => String(step.sourceMachineId))
        .map((machineSteps) => ({
          title: scenarioAssignedMachineLabel(machineSteps[0].sourceMachineId),
          meta: '',
          children: partYearNodes(bundle, steps, machineSteps),
        }))
        .sort((a, b) => a.title.localeCompare(b.title, 'pl'));
      return {
        title: scenarioAssignedPartLabel(bundle, partSteps[0].partId) || 'detal',
        meta: '',
        children: machines,
      };
    })
    .filter((node) => node.children.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title, 'pl'));
}

/** Wszystkie maszyny zwalniane albo wszystkie detale, na jednym widoku. */
export function buildScenarioAllocationReport(bundle: ScenarioBundle): {
  machines: ScenarioMoveTreeNode[];
  parts: ScenarioMoveTreeNode[];
} {
  collectScenarioAllocationMoves(bundle);
  const steps = orderedAllocationSteps(bundle);
  return { machines: freedMachineOutline(bundle, steps), parts: freedPartOutline(bundle, steps) };
}

function moveEndpointLabel(bundle: ScenarioBundle, machineIds: number[]): string {
  const ids = [...new Set(machineIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return '';
  if (ids.length === 1) return scenarioAssignedMachineLabel(ids[0]);
  return ids.map((id) => scenarioAssignedMachineLabel(id)).filter(Boolean).join(', ');
}

export function listScenarioAllocationMoves(bundle: ScenarioBundle): ScenarioMoveListItem[] {
  collectScenarioAllocationMoves(bundle);
  const moves = bundle.allocation_moves || [];
  const newestId = moves.length > 0 ? moves[moves.length - 1].id : null;
  return moves.map((move) => {
    const years = [...new Set(move.steps.map((s) => s.year))].sort((a, b) => a - b);
    const partIds = [...new Set(move.steps.map((s) => s.partId).filter((id): id is number => id != null && id > 0))];
    const partLabels = partIds.map((id) => scenarioAssignedPartLabel(bundle, id)).filter(Boolean);
    const partLabel =
      partLabels.length <= 1 ? partLabels[0] || '' : partLabels.length <= 3 ? partLabels.join(', ') : `${partLabels.length} detali`;
    return {
      id: move.id,
      at: move.at,
      years,
      partLabel,
      sourceLabel: moveEndpointLabel(bundle, move.steps.map((s) => s.sourceMachineId)),
      targetLabel: moveEndpointLabel(bundle, move.steps.map((s) => s.targetMachineId)),
      canUndo: move.id === newestId,
    };
  });
}

export type ScenarioChangeListItem = {
  kind: 'allocation' | 'volume';
  id: number;
  at: string;
  years: number[];
  partLabel: string;
  sourceLabel: string;
  targetLabel: string;
  scopeLabel: string;
  canUndo: boolean;
};

function volumeEditScopeLabel(edit: { applyProduction: boolean; applyContract: boolean }): string {
  if (edit.applyProduction && edit.applyContract) return 'produkcyjny i kontraktowy';
  if (edit.applyContract) return 'kontraktowy';
  return 'produkcyjny';
}

function latestVolumeEdit(bundle: ScenarioBundle): ScenarioVolumeEdit | null {
  const edits = [...(bundle.volume_edits || [])].sort(compareAllocationMoves);
  return edits.length > 0 ? edits[edits.length - 1] : null;
}

/** Alokacje i zmiany wolumenu, najnowsze na początku. Cofnięcie tylko dla ostatniego zdarzenia. */
export function listScenarioChanges(bundle: ScenarioBundle): ScenarioChangeListItem[] {
  const allocations = listScenarioAllocationMoves(bundle).map((move) => ({
    kind: 'allocation' as const,
    id: move.id,
    at: move.at,
    years: move.years,
    partLabel: move.partLabel,
    sourceLabel: move.sourceLabel,
    targetLabel: move.targetLabel,
    scopeLabel: '',
    canUndo: false,
  }));
  const volumes = [...(bundle.volume_edits || [])].sort(compareAllocationMoves).map((edit) => ({
    kind: 'volume' as const,
    id: edit.id,
    at: edit.at,
    years: [...edit.years].sort((a, b) => a - b),
    partLabel: scenarioAssignedPartLabel(bundle, edit.partId),
    sourceLabel: '',
    targetLabel: '',
    scopeLabel: volumeEditScopeLabel(edit),
    canUndo: false,
  }));
  const items = [...allocations, ...volumes].sort((a, b) => compareAllocationMoves(b, a));
  if (items.length > 0) items[0].canUndo = true;
  return items;
}

function undoScenarioVolumeEdit(scenarioId: number, actor: string, edit: ScenarioVolumeEdit, bundle: ScenarioBundle): { success: boolean; error?: string; label?: string } {
  const parts = bundle.parts || [];
  const part = parts.find((pt: any) => Number(pt.id) === edit.partId) as any;
  if (!part) return { success: false, error: 'Detal z tej zmiany wolumenu już nie istnieje w scenariuszu.' };
  part.volume_mode = edit.before.volume_mode || 'project';
  part.contract_volume_mode = edit.before.contract_volume_mode || 'project';
  bundle.part_volume_by_year = [
    ...(bundle.part_volume_by_year || []).filter((r: any) => Number(r.part_id) !== edit.partId),
    ...(edit.before.part_volume_by_year || []),
  ];
  bundle.part_volume_contract_by_year = [
    ...(bundle.part_volume_contract_by_year || []).filter((r: any) => Number(r.part_id) !== edit.partId),
    ...(edit.before.part_volume_contract_by_year || []),
  ];
  bundle.volume_edits = (bundle.volume_edits || []).filter((row) => row.id !== edit.id);
  const partLabel = scenarioAssignedPartLabel(bundle, edit.partId);
  const years = [...edit.years].sort((a, b) => a - b);
  const detail = partLabel ? `detalu ${partLabel}` : 'detalu';
  pushScenarioAudit(bundle, {
    author: actor || 'system',
    note_type: 'auto',
    note: `Cofnięto zmianę wolumenu ${volumeEditScopeLabel(edit)} ${detail}, lata ${years.join(', ') || '—'}.`,
    project_id: edit.projectId,
    part_id: edit.partId,
  });
  try {
    db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), scenarioId);
  } catch {
    db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), scenarioId);
  }
  saveDb();
  return { success: true, label: `wolumen ${volumeEditScopeLabel(edit)} ${detail}, lata ${years.join(', ')}` };
}

/** Cofa najnowsze zdarzenie: alokację albo zmianę wolumenu. */
export function undoLastScenarioChange(scenarioId: number, actor: string): { success: boolean; error?: string; label?: string } {
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(scenarioId) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return { success: false, error: 'Scenariusz nie znaleziony' };
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return { success: false, error: 'Scenariusz zarchiwizowany — cofanie jest wyłączone.' };
  }
  let bundle: ScenarioBundle;
  try {
    bundle = parseScenarioSnapshotJson(row.snapshot);
  } catch {
    return { success: false, error: 'Niepoprawny snapshot scenariusza' };
  }
  collectScenarioAllocationMoves(bundle);
  const alloc = (bundle.allocation_moves || []).slice().sort(compareAllocationMoves).pop() ?? null;
  const volume = latestVolumeEdit(bundle);
  if (!alloc && !volume) return { success: false, error: 'Brak ruchów do cofnięcia.' };
  const volumeIsNewer = volume != null && (alloc == null || compareAllocationMoves(alloc, volume) < 0);
  if (!volumeIsNewer) return undoLastScenarioAllocationMove(scenarioId, actor);
  return undoScenarioVolumeEdit(scenarioId, actor, volume as ScenarioVolumeEdit, bundle);
}

/** Cofa najnowszy pakiet alokacji w scenariuszu. Starsze pakiety dopiero po cofnięciu nowszych. */
export function undoLastScenarioAllocationMove(
  scenarioId: number,
  actor: string
): { success: boolean; error?: string; label?: string } {
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(scenarioId) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return { success: false, error: 'Scenariusz nie znaleziony' };
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return { success: false, error: 'Scenariusz zarchiwizowany — cofanie jest wyłączone.' };
  }
  let bundle: ScenarioBundle;
  try {
    bundle = parseScenarioSnapshotJson(row.snapshot);
  } catch {
    return { success: false, error: 'Niepoprawny snapshot scenariusza' };
  }
  collectScenarioAllocationMoves(bundle);
  const moves = [...(bundle.allocation_moves || [])].sort(compareAllocationMoves);
  if (moves.length === 0) return { success: false, error: 'Brak ruchów do cofnięcia.' };
  const move = moves[moves.length - 1];
  const ops = bundle.operations || [];
  for (const step of move.steps) {
    const further = ops.some((o: any) => Number(o.split_from_operation_id) === step.childOperationId);
    if (further) {
      return { success: false, error: 'Ten ruch ma późniejsze alokacje wychodzące z utworzonej operacji. Cofnij je najpierw.' };
    }
  }
  for (let i = move.steps.length - 1; i >= 0; i--) {
    const step = move.steps[i];
    restoreScenarioParentYear(bundle, step);
    bundle.operation_volume_by_year = (bundle.operation_volume_by_year || []).filter(
      (r: any) => Number(r.operation_id) !== step.childOperationId
    );
    bundle.operations = (bundle.operations || []).filter((o: any) => Number(o.id) !== step.childOperationId);
  }
  bundle.allocation_moves = moves.filter((row) => row.id !== move.id);
  const years = [...new Set(move.steps.map((s) => s.year))].sort((a, b) => a - b);
  const step = move.steps[0];
  const partIds = [...new Set(move.steps.map((s) => s.partId).filter((id): id is number => id != null && id > 0))];
  const partLabels = partIds.map((id) => scenarioAssignedPartLabel(bundle, id)).filter(Boolean);
  const partLabel =
    partLabels.length <= 1 ? partLabels[0] || '' : partLabels.length <= 3 ? partLabels.join(', ') : `${partLabels.length} detali`;
  const source = moveEndpointLabel(bundle, move.steps.map((s) => s.sourceMachineId));
  const target = moveEndpointLabel(bundle, move.steps.map((s) => s.targetMachineId));
  const detail = partLabel ? `detalu ${partLabel}` : 'detalu';
  pushScenarioAudit(bundle, {
    author: actor || 'system',
    note_type: 'auto',
    note: `Cofnięto alokację ${detail} z maszyny ${target} z powrotem na maszynę ${source}, lata ${years.join(', ')}.`,
    project_id: null,
    machine_id: step?.sourceMachineId || null,
    part_id: step?.partId ?? null,
    operation_id: step?.sourceOperationId ?? null,
  });
  try {
    db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), scenarioId);
  } catch {
    db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), scenarioId);
  }
  saveDb();
  invalidateAllocationSplitIndex();
  return { success: true, label: `${detail}: ${target} → ${source}, lata ${years.join(', ')}` };
}

/**
 * Przed usunięciem operacji potomnej z alokacji: sumuje wolumen per rok z dziecka z wolumenem rodzica (w „bazowym” tygodniowym przepływie),
 * zapisuje w operation_volume_by_year rodzica jako weekly — zgodnie z konwencją zapisu przy podziale.
 */
/** Najwyższy przodek w łańcuchu alokacji (split_from → … → NULL). */
export function findAllocationTreeRootOperationId(operationId: number): number {
  let id = operationId;
  for (let i = 0; i < 10000; i++) {
    const row = db
      .prepare('SELECT split_from_operation_id FROM operations WHERE id = ?')
      .get(id) as { split_from_operation_id: number | null } | undefined;
    if (!row) return operationId;
    if (row.split_from_operation_id == null) return id;
    id = row.split_from_operation_id;
  }
  return operationId;
}

const VOLUME_EPS = 1e-6;

type OpMachineRow = {
  id: number;
  split_from_operation_id: number | null;
  machine_id: number | null;
  part_id: number | null;
  project_id: number | null;
  status: string | null;
  internal_number: string | number | null;
  machine_row_id: number | null;
};

export type VolumeHeirCandidate = {
  operationId: number;
  machineId: number;
  machineLabel: string;
};

export type VolumeHeirResolution =
  | { ok: true; heirOperationId: number; machineLabel: string; skippedInactive: boolean }
  | { ok: false; code: 'choose_heir' | 'no_heir'; error: string; candidates: VolumeHeirCandidate[] };

function machineStatusCanHoldVolume(status: unknown, machineRowId: number | null): boolean {
  if (machineRowId == null) return false;
  return String(status ?? '').trim().toLowerCase() !== 'inactive';
}

function machineLabelOf(row: { internal_number: string | number | null; machine_id: number | null }): string {
  if (row.internal_number != null && String(row.internal_number).trim() !== '') return String(row.internal_number);
  return row.machine_id != null ? `#${row.machine_id}` : '?';
}

function loadOpMachine(operationId: number): OpMachineRow | undefined {
  return db
    .prepare(
      `SELECT o.id, o.split_from_operation_id, o.machine_id, o.part_id, o.project_id,
              m.status, m.internal_number, m.id AS machine_row_id
       FROM operations o
       LEFT JOIN machines m ON m.id = o.machine_id
       WHERE o.id = ?`
    )
    .get(operationId) as OpMachineRow | undefined;
}

function allocationTargetMachineError(targetMachineId: number): string | null {
  const row = db
    .prepare('SELECT id, status, internal_number FROM machines WHERE id = ?')
    .get(targetMachineId) as { id: number; status: string | null; internal_number: string | number | null } | undefined;
  if (!row) return 'Nie znaleziono maszyny docelowej.';
  if (!machineStatusCanHoldVolume(row.status, row.id)) {
    return `Maszyna ${machineLabelOf({ internal_number: row.internal_number, machine_id: row.id })} jest nieaktywna. Wolumen można przenieść tylko na maszynę aktywną lub RFQ.`;
  }
  return null;
}

function collectAllocationTree(rootId: number): OpMachineRow[] {
  const out: OpMachineRow[] = [];
  const queue = [rootId];
  const seen = new Set<number>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = loadOpMachine(id);
    if (!row) continue;
    out.push(row);
    const kids = db.prepare('SELECT id FROM operations WHERE split_from_operation_id = ?').all(id) as { id: number }[];
    for (const kid of kids) queue.push(Number(kid.id));
  }
  return out;
}

/**
 * Spadkobierca wolumenu usuwanego z dziecka alokacji.
 * Najbliższy przodek na maszynie active/RFQ; jeśli cała linia matek jest nieaktywna —
 * jedyna inna operacja tego drzewa i detalu na maszynie, która może przyjąć wolumen.
 * Przy kilku kandydatach wymagane jest jawne wskazanie.
 */
export function resolveVolumeHeir(sourceOperationId: number, preferredHeirOperationId?: number | null): VolumeHeirResolution {
  const source = loadOpMachine(sourceOperationId);
  if (!source) return { ok: false, code: 'no_heir', error: 'Nie znaleziono operacji.', candidates: [] };
  const parentId = source.split_from_operation_id != null ? Number(source.split_from_operation_id) : null;
  const sourceCanHold = machineStatusCanHoldVolume(source.status, source.machine_row_id);
  if ((parentId == null || !Number.isFinite(parentId)) && sourceCanHold) {
    return { ok: true, heirOperationId: source.id, machineLabel: machineLabelOf(source), skippedInactive: false };
  }

  let nearest: OpMachineRow | undefined;
  let skippedInactive = false;
  let currentId: number | null = parentId != null && Number.isFinite(parentId) ? parentId : null;
  const seenAncestors = new Set<number>();
  while (currentId != null && !seenAncestors.has(currentId)) {
    seenAncestors.add(currentId);
    const row = loadOpMachine(currentId);
    if (!row) break;
    if (machineStatusCanHoldVolume(row.status, row.machine_row_id)) {
      nearest = row;
      break;
    }
    skippedInactive = true;
    currentId = row.split_from_operation_id != null ? Number(row.split_from_operation_id) : null;
  }

  if (nearest && source.machine_id != null && Number(nearest.machine_id) === Number(source.machine_id)) {
    nearest = undefined;
    skippedInactive = true;
  }

  const rootId = findAllocationTreeRootOperationId(sourceOperationId);
  const depthById = new Map<number, number>();
  const depthOf = (id: number): number => {
    const cached = depthById.get(id);
    if (cached != null) return cached;
    let depth = 0;
    let current = id;
    const seen = new Set<number>();
    while (!seen.has(current)) {
      seen.add(current);
      const row = loadOpMachine(current);
      if (!row || row.split_from_operation_id == null) break;
      depth++;
      current = Number(row.split_from_operation_id);
    }
    depthById.set(id, depth);
    return depth;
  };
  const byMachine = new Map<number, { candidate: VolumeHeirCandidate; depth: number }>();
  for (const row of collectAllocationTree(rootId)) {
    if (row.id === source.id) continue;
    if (source.machine_id != null && Number(row.machine_id) === Number(source.machine_id)) continue;
    if (!machineStatusCanHoldVolume(row.status, row.machine_row_id)) continue;
    if (source.part_id != null && row.part_id != null && Number(row.part_id) !== Number(source.part_id)) continue;
    const machineId = Number(row.machine_id);
    if (!Number.isFinite(machineId)) continue;
    const candidate: VolumeHeirCandidate = {
      operationId: row.id,
      machineId,
      machineLabel: machineLabelOf(row),
    };
    const depth = depthOf(row.id);
    const prev = byMachine.get(machineId);
    if (!prev || depth < prev.depth) byMachine.set(machineId, { candidate, depth });
  }
  const candidates = [...byMachine.values()]
    .map((entry) => entry.candidate)
    .sort((a, b) => a.machineLabel.localeCompare(b.machineLabel, 'pl', { numeric: true }));

  const preferred = preferredHeirOperationId != null ? Number(preferredHeirOperationId) : NaN;
  if (!nearest && candidates.length > 1) {
    if (Number.isFinite(preferred)) {
      const picked = candidates.find((c) => c.operationId === preferred);
      if (picked) {
        return { ok: true, heirOperationId: picked.operationId, machineLabel: picked.machineLabel, skippedInactive: true };
      }
    }
    return {
      ok: false,
      code: 'choose_heir',
      error: 'Wolumen nie może wrócić na nieaktywną maszynę. Wybierz aktywną maszynę docelową.',
      candidates,
    };
  }

  if (nearest) {
    return {
      ok: true,
      heirOperationId: nearest.id,
      machineLabel: machineLabelOf(nearest),
      skippedInactive,
    };
  }
  if (candidates.length === 1) {
    return {
      ok: true,
      heirOperationId: candidates[0].operationId,
      machineLabel: candidates[0].machineLabel,
      skippedInactive: true,
    };
  }
  return {
    ok: false,
    code: 'no_heir',
    error:
      'Wolumen nie może wrócić na nieaktywną maszynę, a w tym drzewie alokacji nie ma aktywnej operacji, która może go przejąć. Wolumen pozostaje bez zmian.',
    candidates: [],
  };
}

type YearVolumePoint = { year: number; month: number; week: number };

function todayVolumePoint(now = new Date()): YearVolumePoint {
  return assignIsoWeekToStartMonth(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isAfterToday(year: number, month: number, week: number, today: YearVolumePoint): boolean {
  if (year !== today.year) return year > today.year;
  if (month !== today.month) return month > today.month;
  return week > today.week;
}

/** Czy wiersz roku ma dodatni wolumen od bieżącego tygodnia włącznie (historia sprzed dziś nie liczy się). */
export function yearRowHasForwardVolume(
  row: {
    year: number;
    volume_value: number;
    volume_value_before?: number | null;
    effective_from_month?: number | null;
    effective_from_week?: number | null;
  },
  now = new Date()
): boolean {
  const year = Number(row.year);
  if (!Number.isInteger(year)) return false;
  const today = todayVolumePoint(now);
  if (year < today.year) return false;
  const after = Number(row.volume_value) > VOLUME_EPS;
  const before = row.volume_value_before != null && Number(row.volume_value_before) > VOLUME_EPS;
  if (year > today.year) return after || before;
  if (row.effective_from_month == null) return after;
  const fromMonth = Math.floor(Number(row.effective_from_month));
  const fromWeek = Math.floor(Number(row.effective_from_week) || 1);
  if (isAfterToday(year, fromMonth, fromWeek, today)) return before || after;
  return after;
}

/**
 * Lata produkcji od dziś włącznie (SOP–EOP), tak jak w kalkulatorze.
 * Brak SOP/EOP = operacja aktywna; horyzont 20 lat.
 */
function productionYearsFromToday(sop: unknown, eop: unknown, today: YearVolumePoint): number[] {
  const sopP = parseSopEop(sop);
  const eopP = parseSopEop(eop);
  if (!sopP || !eopP) {
    const years: number[] = [];
    for (let y = today.year; y <= today.year + 20; y++) years.push(y);
    return years;
  }
  if (eopP.year < today.year) return [];
  if (eopP.year === today.year && eopP.month < today.month) return [];
  const start = Math.max(today.year, sopP.year);
  const years: number[] = [];
  for (let y = start; y <= eopP.year; y++) {
    if (y === today.year) {
      const months = getProductionMonthNumbersInYear(sop, eop, y);
      if (!months.some((m) => m >= today.month)) continue;
    }
    years.push(y);
  }
  return years;
}

/** Dezaktywacja: wolumen od dziś w przód. Lata historyczne i część bieżącego roku przed dziś nie blokują. */
export function forwardVolumeBlockForMachine(machineId: number, now = new Date()): { blocked: boolean; years: number[] } {
  const ops = db
    .prepare(
      `SELECT o.id, o.volume_value, o.volume_unit, o.split_from_operation_id, o.project_id, o.part_id, p.sop, p.eop
       FROM operations o
       LEFT JOIN projects p ON p.id = o.project_id
       WHERE o.machine_id = ?`
    )
    .all(machineId) as {
    id: number;
    volume_value: number;
    volume_unit: string | null;
    split_from_operation_id: number | null;
    project_id: number | null;
    part_id: number | null;
    sop: string | null;
    eop: string | null;
  }[];
  const years = new Set<number>();
  const today = todayVolumePoint(now);
  for (const op of ops) {
    const rows = db
      .prepare(
        `SELECT year, volume_value, volume_value_before, effective_from_month, effective_from_week
         FROM operation_volume_by_year WHERE operation_id = ?`
      )
      .all(op.id) as {
      year: number;
      volume_value: number;
      volume_value_before: number | null;
      effective_from_month: number | null;
      effective_from_week: number | null;
    }[];
    const coveredYears = new Set<number>();
    if (rows.length > 0) {
      for (const row of rows) {
        coveredYears.add(Number(row.year));
        if (yearRowHasForwardVolume(row, now)) years.add(Number(row.year));
      }
    }
    if (op.split_from_operation_id != null) continue;
    for (const year of productionYearsFromToday(op.sop, op.eop, today)) {
      if (coveredYears.has(year)) continue;
      const resolved = resolveOperationVolumeForYear(
        {
          operation_id: op.id,
          project_id: op.project_id,
          part_id: op.part_id,
          volume_value: Number(op.volume_value) || 0,
          volume_unit: op.volume_unit || 'annual',
          split_from_operation_id: null,
        },
        year,
        null,
        null,
        false
      );
      if (Number(resolved.volume_value) > VOLUME_EPS) years.add(year);
    }
  }
  return { blocked: years.size > 0, years: [...years].sort((a, b) => a - b) };
}

/** To samo co produkcja, ale wolumen i SOP/EOP biorą się ze snapshotu scenariusza. */
export function forwardVolumeBlockForMachineInScenario(
  bundle: ScenarioBundle,
  machineId: number,
  now = new Date()
): { blocked: boolean; years: number[] } {
  const today = todayVolumePoint(now);
  const ops = (bundle.operations || []).filter(
    (o: any) => Number(o.machine_id) === machineId && String(o.status ?? 'active') === 'active'
  );
  const years = new Set<number>();
  for (const op of ops) {
    const rows = (bundle.operation_volume_by_year || []).filter((r: any) => Number(r.operation_id) === Number(op.id));
    const coveredYears = new Set<number>();
    if (rows.length > 0) {
      for (const row of rows) {
        coveredYears.add(Number(row.year));
        if (yearRowHasForwardVolume(row, now)) years.add(Number(row.year));
      }
    }
    if (op.split_from_operation_id != null) continue;
    for (const year of productionYearsFromToday(op.sop, op.eop, today)) {
      if (coveredYears.has(year)) continue;
      const resolved = resolveOperationVolumeForYear(
        {
          operation_id: Number(op.id),
          project_id: op.project_id,
          part_id: op.part_id,
          volume_value: Number(op.volume_value) || 0,
          volume_unit: op.volume_unit || 'annual',
          split_from_operation_id: null,
        },
        year,
        null,
        bundle,
        false
      );
      if (Number(resolved.volume_value) > VOLUME_EPS) years.add(year);
    }
  }
  return { blocked: years.size > 0, years: [...years].sort((a, b) => a - b) };
}

/**
 * Jednorazowo przenosi wolumen od bieżącej daty z maszyn nieaktywnych na jednoznacznego spadkobiercę.
 * Przypadki z wieloma kandydatami zostają bez zmian i trafiają do logu.
 */
export function repairInactiveForwardVolumesOnce(now = new Date()): { moved: number; ambiguous: string[] } {
  const existing = db.prepare(`SELECT value FROM admin_settings WHERE key = 'inactive_volume_repair_v1'`).get() as
    | { value?: string }
    | undefined;
  if (existing) return { moved: 0, ambiguous: [] };

  const sources = db
    .prepare(
      `SELECT DISTINCT o.id
       FROM operations o
       JOIN machines m ON m.id = o.machine_id
       WHERE lower(COALESCE(m.status, '')) = 'inactive'`
    )
    .all() as { id: number }[];

  let moved = 0;
  const ambiguous: string[] = [];
  for (const source of sources) {
    const rows = db
      .prepare(
        `SELECT year, volume_value, volume_unit, volume_value_before, effective_from_month, effective_from_week
         FROM operation_volume_by_year WHERE operation_id = ?`
      )
      .all(source.id) as {
      year: number;
      volume_value: number;
      volume_unit: string;
      volume_value_before: number | null;
      effective_from_month: number | null;
      effective_from_week: number | null;
    }[];
    const forwardYears = rows.filter((row) => yearRowHasForwardVolume(row, now)).map((row) => Number(row.year));
    if (forwardYears.length === 0) continue;
    const heir = resolveVolumeHeir(source.id);
    const op = loadOpMachine(source.id);
    const fromLabel = op ? machineLabelOf(op) : String(source.id);
    if (!heir.ok) {
      ambiguous.push(`maszyna ${fromLabel}, operacja #${source.id}, lata ${forwardYears.join(', ')}: ${heir.error}`);
      continue;
    }
    if (heir.heirOperationId === source.id) {
      ambiguous.push(`maszyna ${fromLabel}, operacja #${source.id}: brak innej operacji w drzewie alokacji.`);
      continue;
    }
    for (const year of forwardYears) {
      mergeSplitChildYearVolumeIntoParent(heir.heirOperationId, source.id, year);
      db.prepare(
        `INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit, source)
         VALUES (?, ?, 0, 'weekly', 'allocation')`
      ).run(source.id, year);
    }
    moved++;
  }

  db.prepare(
    `INSERT INTO admin_settings (key, value) VALUES ('inactive_volume_repair_v1', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify({ at: new Date().toISOString(), moved, ambiguous }));
  saveDb();
  if (ambiguous.length) {
    console.warn('[capacity] Wolumeny na maszynach nieaktywnych wymagają ręcznego wskazania spadkobiercy:\n' + ambiguous.join('\n'));
  }
  return { moved, ambiguous };
}

/** Scala wolumen jednego roku z operacji-dziecka alokacji z powrotem do rodzica. */
export function mergeSplitChildYearVolumeIntoParent(
  parentOperationId: number,
  childOperationId: number,
  year: number
): void {
  const row = db
    .prepare(
      `SELECT year, volume_value, volume_unit, volume_value_before, effective_from_month, effective_from_week
       FROM operation_volume_by_year WHERE operation_id = ? AND year = ?`
    )
    .get(childOperationId, year) as
    | {
        year: number;
        volume_value: number;
        volume_unit: string;
        volume_value_before: number | null;
        effective_from_month: number | null;
        effective_from_week: number | null;
      }
    | undefined;
  if (!row) return;

  const cu = row.volume_unit === 'monthly' || row.volume_unit === 'weekly' ? row.volume_unit : 'annual';
  const settings = resolveSettingsForYear(year);

  const childAfterWeekly = volumeToWeekly(row.volume_value, cu, settings);
  const childBeforeWeekly =
    row.effective_from_month != null && row.volume_value_before != null
      ? volumeToWeekly(Number(row.volume_value_before), cu, settings)
      : childAfterWeekly;
  if (childAfterWeekly <= 1e-9 && childBeforeWeekly <= 1e-9) return;

  const parentYearRow = db
    .prepare(
      `SELECT volume_value, volume_unit, volume_value_before, effective_from_month, effective_from_week
       FROM operation_volume_by_year WHERE operation_id = ? AND year = ?`
    )
    .get(parentOperationId, year) as
    | {
        volume_value: number;
        volume_unit: string;
        volume_value_before: number | null;
        effective_from_month: number | null;
        effective_from_week: number | null;
      }
    | undefined;

  let parentAfterWeekly = 0;
  let parentBeforeWeekly = 0;
  let fromMonth: number | null = null;
  let fromWeek: number | null = null;
  if (parentYearRow) {
    const pu =
      parentYearRow.volume_unit === 'monthly' || parentYearRow.volume_unit === 'weekly'
        ? parentYearRow.volume_unit
        : 'annual';
    parentAfterWeekly = volumeToWeekly(parentYearRow.volume_value, pu, settings);
    parentBeforeWeekly =
      parentYearRow.effective_from_month != null && parentYearRow.volume_value_before != null
        ? volumeToWeekly(Number(parentYearRow.volume_value_before), pu, settings)
        : parentAfterWeekly;
    fromMonth = parentYearRow.effective_from_month;
    fromWeek = parentYearRow.effective_from_week;
  }
  if (row.effective_from_month != null) {
    fromMonth = fromMonth ?? row.effective_from_month;
    fromWeek = fromWeek ?? row.effective_from_week ?? 1;
  }

  const mergedAfter = parentAfterWeekly + childAfterWeekly;
  const mergedBefore = parentBeforeWeekly + childBeforeWeekly;
  if (fromMonth != null && Math.abs(mergedBefore - mergedAfter) > 1e-6) {
    upsertOperationYearVolume({
      operationId: parentOperationId,
      year,
      volumeValue: mergedAfter,
      volumeUnit: 'weekly',
      source: 'allocation',
      volumeValueBefore: mergedBefore,
      effectiveFromMonth: fromMonth,
      effectiveFromWeek: fromWeek ?? 1,
    });
  } else {
    upsertOperationYearVolume({
      operationId: parentOperationId,
      year,
      volumeValue: mergedAfter,
      volumeUnit: 'weekly',
      source: 'allocation',
    });
  }
}

export function mergeSplitChildVolumesIntoParent(parentOperationId: number, childOperationId: number): void {
  const childRows = db
    .prepare(`SELECT year FROM operation_volume_by_year WHERE operation_id = ? ORDER BY year`)
    .all(childOperationId) as { year: number }[];

  for (const { year } of childRows) {
    mergeSplitChildYearVolumeIntoParent(parentOperationId, childOperationId, year);
  }
  ensureSplitChildYearCoverage(parentOperationId);
}

/** Usuwa wpisy operation_volume_by_year bez istniejącej operacji (po usunięciu bez CASCADE). */
export function cleanupOrphanOperationYearVolumes(): number {
  const r = db
    .prepare(
      `DELETE FROM operation_volume_by_year
       WHERE operation_id NOT IN (SELECT id FROM operations)`
    )
    .run();
  return Number(r.changes ?? 0);
}

/** If parent has no more split children, remove allocation overrides and return to project/detail volumes. */
export function clearParentAllocationOverridesIfNoChildren(parentOperationId: number): void {
  const parentRow = db
    .prepare('SELECT id, split_from_operation_id FROM operations WHERE id = ?')
    .get(parentOperationId) as { id: number; split_from_operation_id: number | null } | undefined;
  if (!parentRow) return;
  // Critical safeguard: never clear yearly allocation overrides for a split child.
  // Child operations must keep their year-scoped allocation rows even if they currently
  // have no own descendants, otherwise they fallback to base volume for all years.
  if (parentRow.split_from_operation_id != null) return;

  const hasChildren = db
    .prepare('SELECT 1 FROM operations WHERE split_from_operation_id = ? LIMIT 1')
    .get(parentOperationId);
  if (hasChildren) return;
  db.prepare('DELETE FROM operation_volume_by_year WHERE operation_id = ? AND COALESCE(source, \'manual\') = \'allocation\'').run(parentOperationId);
}

/**
 * For split children, missing year rows are dangerous: calculator falls back to operation base volume
 * for those years. This guard backfills missing years with explicit 0 weekly rows.
 */
function yearsForSplitChildDb(projectId: number, parentOperationId: number, allocationYear: number): number[] {
  const years = new Set<number>([allocationYear]);
  for (const r of db.prepare('SELECT year FROM project_volumes WHERE project_id = ?').all(projectId) as { year: number }[]) {
    const y = Number(r.year);
    if (Number.isInteger(y)) years.add(y);
  }
  const ovRows = db
    .prepare(
      `SELECT DISTINCT year FROM operation_volume_by_year
       WHERE operation_id = ? OR operation_id IN (SELECT id FROM operations WHERE project_id = ?)`
    )
    .all(parentOperationId, projectId) as { year: number }[];
  for (const r of ovRows) {
    const y = Number(r.year);
    if (Number.isInteger(y)) years.add(y);
  }
  return [...years].sort((a, b) => a - b);
}

function seedSplitChildYearVolumes(
  childOperationId: number,
  projectId: number,
  parentOperationId: number,
  allocationYear: number,
  yearVolumeValue: number,
  yearVolumeUnit: string,
  effectiveFrom?: { month: number; week: number; volumeBefore: number } | null
): void {
  const yearList = yearsForSplitChildDb(projectId, parentOperationId, allocationYear);
  for (const y of yearList) {
    if (y === allocationYear) {
      upsertOperationYearVolume({
        operationId: childOperationId,
        year: y,
        volumeValue: yearVolumeValue,
        volumeUnit: yearVolumeUnit,
        source: 'allocation',
        volumeValueBefore: effectiveFrom ? effectiveFrom.volumeBefore : null,
        effectiveFromMonth: effectiveFrom ? effectiveFrom.month : null,
        effectiveFromWeek: effectiveFrom ? effectiveFrom.week : null,
      });
    } else {
      upsertOperationYearVolume({
        operationId: childOperationId,
        year: y,
        volumeValue: 0,
        volumeUnit: 'weekly',
        source: 'allocation',
      });
    }
  }
  ensureSplitChildYearCoverage(childOperationId);
}

function yearsForSplitChildScenario(
  bundle: ScenarioBundle,
  projectId: number,
  parentOperationId: number,
  allocationYear: number
): number[] {
  const years = new Set<number>([allocationYear]);
  for (const r of (bundle.project_volumes || []).filter((v: any) => Number(v.project_id) === projectId)) {
    const y = Number((r as any).year);
    if (Number.isInteger(y)) years.add(y);
  }
  const ops = bundle.operations || [];
  const projectOpIds = new Set(ops.filter((o: any) => Number(o.project_id) === projectId).map((o: any) => Number(o.id)));
  projectOpIds.add(parentOperationId);
  for (const v of bundle.operation_volume_by_year || []) {
    if (projectOpIds.has(Number((v as any).operation_id))) {
      const y = Number((v as any).year);
      if (Number.isInteger(y)) years.add(y);
    }
  }
  return [...years].sort((a, b) => a - b);
}

export function ensureSplitChildYearCoverage(operationId: number): void {
  const op = db
    .prepare('SELECT id, project_id, split_from_operation_id FROM operations WHERE id = ?')
    .get(operationId) as { id: number; project_id: number; split_from_operation_id: number | null } | undefined;
  if (!op || op.split_from_operation_id == null) return;

  const parentId = Number(op.split_from_operation_id);
  const anchorRow = db
    .prepare(
      'SELECT year FROM operation_volume_by_year WHERE operation_id = ? AND volume_value > 1e-9 ORDER BY year DESC LIMIT 1'
    )
    .get(operationId) as { year: number } | undefined;
  const anchorYear =
    anchorRow != null && Number.isInteger(Number(anchorRow.year)) ? Number(anchorRow.year) : new Date().getFullYear();
  let yearList = yearsForSplitChildDb(Number(op.project_id), parentId, anchorYear);
  const existing = db
    .prepare('SELECT year FROM operation_volume_by_year WHERE operation_id = ? ORDER BY year')
    .all(operationId) as { year: number }[];
  for (const r of existing) {
    const y = Number(r.year);
    if (Number.isInteger(y)) yearList.push(y);
  }
  yearList = [...new Set(yearList)].sort((a, b) => a - b);
  if (yearList.length === 0) return;

  const hasYearStmt = db.prepare('SELECT 1 FROM operation_volume_by_year WHERE operation_id = ? AND year = ? LIMIT 1');
  const ins = db.prepare(
    'INSERT OR REPLACE INTO operation_volume_by_year (operation_id, year, volume_value, volume_unit, source) VALUES (?, ?, ?, ?, ?)'
  );
  for (const y of yearList) {
    const has = hasYearStmt.get(operationId, y);
    if (!has) ins.run(operationId, y, 0, 'weekly', 'allocation');
  }
}
