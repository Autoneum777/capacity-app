import type { ScenarioBundle } from './scenarioSnapshotService.js';
import { getMachineCapacityByYears, getMachineMonthlyAverageLoads, getMachinePeriodBreakdown } from './capacityService.js';
import type { MachineDimensionFilter } from '../utils/machineDimensionFilter.js';
import type { MachineStatusFilterInput, CalculationSettingsProfile } from './capacityService.js';
import { loadCallOffVolumeMaps } from './callOffService.js';
import type { CallOffCalculatorMachine, CallOffPeriodBreakdownMachine } from './callOffCapacityService.js';

type DetailBreakdownRow = NonNullable<CallOffCalculatorMachine['years'][number]['call_off_detail_breakdown']>;

const SCENARIO_BREAKDOWN_OPTS = { includeAssignedZeroVolumeDetailsInBreakdown: true as const };

/** Detale ze scenariusza bez wolumenu SAP — dopisz jako 0% w pasku Call offs. */
function mergeAssignedDetailsIntoCallOffBreakdown(
  callOffDetails: DetailBreakdownRow | undefined,
  baseDetails: DetailBreakdownRow | undefined
): DetailBreakdownRow {
  const co = [...(callOffDetails ?? [])];
  const seen = new Set(co.map((d) => `${d.project_label}\0${d.detail_label}`));
  for (const d of baseDetails ?? []) {
    const key = `${d.project_label}\0${d.detail_label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    co.push({
      project_label: d.project_label,
      detail_label: d.detail_label,
      contribution_percent: 0,
      share_percent: 0,
      volume_quantity: 0,
      has_rfq: d.has_rfq,
    });
  }
  return co.sort((a, b) => b.contribution_percent - a.contribution_percent);
}

/**
 * Kalkulator scenariusza z porównaniem Call offs:
 * górny pasek = wolumeny produkcyjne/scenariuszowe, dolny = SAP z wybranego porównania.
 */
export function getScenarioCallOffCalculator(
  comparisonId: number,
  yearFrom: number,
  yearTo: number,
  machineIds: number[] | undefined,
  machineType: string | string[] | undefined,
  operationsOverride: any[] | undefined,
  scenarioSnapshot: ScenarioBundle | null,
  scenarioIncludeRfqProjects: boolean | undefined,
  useContractualVolumes: boolean | undefined,
  machineStatusFilter: MachineStatusFilterInput | undefined,
  dimensionFilters: MachineDimensionFilter[] | undefined,
  settingsProfile: CalculationSettingsProfile | undefined
): CallOffCalculatorMachine[] {
  const callOffVolumes = loadCallOffVolumeMaps(comparisonId);

  const baseMachines = getMachineCapacityByYears(
    yearFrom,
    yearTo,
    machineIds,
    machineType,
    operationsOverride,
    scenarioSnapshot,
    scenarioIncludeRfqProjects,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    null,
    SCENARIO_BREAKDOWN_OPTS
  );

  const yearAvgByMachine = new Map<number, Map<number, { load_percent: number; detail_breakdown: DetailBreakdownRow }>>();
  for (let y = yearFrom; y <= yearTo; y++) {
    const averages = getMachineMonthlyAverageLoads(
      y,
      machineIds,
      machineType,
      operationsOverride,
      scenarioSnapshot,
      scenarioIncludeRfqProjects,
      useContractualVolumes,
      machineStatusFilter,
      dimensionFilters,
      settingsProfile,
      callOffVolumes
    );
    for (const [machineId, avg] of averages) {
      if (!yearAvgByMachine.has(machineId)) yearAvgByMachine.set(machineId, new Map());
      yearAvgByMachine.get(machineId)!.set(y, avg);
    }
  }

  return baseMachines.map((m) => {
    const avgsByYear = yearAvgByMachine.get(m.machine_id);
    const years: CallOffCalculatorMachine['years'] = {};
    for (const [yearKey, yData] of Object.entries(m.years)) {
      const year = Number(yearKey);
      const avg = avgsByYear?.get(year);
      const coLoad = avg?.load_percent ?? 0;
      years[year] = {
        ...yData,
        call_off_load_percent: coLoad,
        call_off_annual_load_percent: coLoad,
        call_off_annual_required_sec_per_week: 0,
        call_off_annual_availability_sec_per_week: 0,
        call_off_detail_breakdown: mergeAssignedDetailsIntoCallOffBreakdown(
          avg?.detail_breakdown,
          yData.detail_breakdown as DetailBreakdownRow | undefined
        ),
      };
    }
    return { ...m, years };
  });
}

export function getScenarioCallOffPeriodBreakdown(
  comparisonId: number,
  year: number,
  machineIds: number[] | undefined,
  machineType: string | string[] | undefined,
  operationsOverride: any[] | undefined,
  scenarioSnapshot: ScenarioBundle | null,
  scenarioIncludeRfqProjects: boolean | undefined,
  useContractualVolumes: boolean | undefined,
  machineStatusFilter: MachineStatusFilterInput | undefined,
  dimensionFilters: MachineDimensionFilter[] | undefined,
  settingsProfile: CalculationSettingsProfile | undefined
): CallOffPeriodBreakdownMachine[] {
  const callOffVolumes = loadCallOffVolumeMaps(comparisonId);

  const base = getMachinePeriodBreakdown(
    year,
    machineIds,
    machineType,
    operationsOverride,
    scenarioSnapshot,
    scenarioIncludeRfqProjects,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    null,
    SCENARIO_BREAKDOWN_OPTS
  );

  const callOff = getMachinePeriodBreakdown(
    year,
    machineIds,
    machineType,
    operationsOverride,
    scenarioSnapshot,
    scenarioIncludeRfqProjects,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    callOffVolumes,
    SCENARIO_BREAKDOWN_OPTS
  );

  const callOffByMachine = new Map(callOff.map((m) => [m.machine_id, m]));

  return base.map((m) => {
    const coM = callOffByMachine.get(m.machine_id);
    const months: CallOffPeriodBreakdownMachine['months'] = {};
    for (const [monthKey, md] of Object.entries(m.months)) {
      const month = Number(monthKey);
      const coMd = coM?.months?.[month];
      const weeks: CallOffPeriodBreakdownMachine['months'][number]['weeks'] = {};
      for (const [weekKey, wd] of Object.entries(md.weeks)) {
        const week = Number(weekKey);
        const coWeek = coMd?.weeks?.[week];
        weeks[week] = {
          load_percent: wd.load_percent,
          call_off_load_percent: coWeek?.load_percent ?? 0,
          detail_breakdown: wd.detail_breakdown ?? [],
          call_off_detail_breakdown: mergeAssignedDetailsIntoCallOffBreakdown(
            coWeek?.detail_breakdown as DetailBreakdownRow | undefined,
            wd.detail_breakdown as DetailBreakdownRow | undefined
          ),
        };
      }
      months[month] = {
        load_percent: md.load_percent,
        call_off_load_percent: coMd?.load_percent ?? 0,
        weeks,
        has_sop: md.has_sop,
        has_eop: md.has_eop,
        detail_breakdown: md.detail_breakdown ?? [],
        call_off_detail_breakdown: mergeAssignedDetailsIntoCallOffBreakdown(
          coMd?.detail_breakdown as DetailBreakdownRow | undefined,
          md.detail_breakdown as DetailBreakdownRow | undefined
        ),
      };
    }
    return {
      machine_id: m.machine_id,
      has_sop: m.has_sop,
      has_eop: m.has_eop,
      months,
    };
  });
}
