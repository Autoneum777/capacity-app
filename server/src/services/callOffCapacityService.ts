import {
  getMachineCapacityByYears,
  getMachineMonthlyAverageLoads,
  getMachinePeriodBreakdown,
  type CapacityCalculationOptions,
  type MaterialBreakdownItem,
} from './capacityService.js';
import { loadCallOffVolumeMaps } from './callOffService.js';
import type { MachineDimensionFilter } from '../utils/machineDimensionFilter.js';
import type { MachineStatusFilterInput, CalculationSettingsProfile } from './capacityService.js';

const CALL_OFF_PROD_OPTIONS: CapacityCalculationOptions = {
  includeAssignedZeroVolumeDetailsInBreakdown: true,
};

export type CallOffCalculatorMachine = {
  machine_id: number;
  internal_number: string | number;
  sap_number: string | null;
  type: string;
  machine_status: string | null;
  location: string | null;
  years: Record<
    number,
    {
      load_percent: number;
      /** Średnia miesięcy w zakresie danych SAP — dolny pasek w komórce roku w Kalkulatorze. */
      call_off_load_percent: number;
      /**
       * Data Viz: ta sama średnia co call_off_load_percent (zakres SAP, zera w zakresie liczą się).
       */
      call_off_annual_load_percent?: number;
      call_off_annual_required_sec_per_week?: number;
      call_off_annual_availability_sec_per_week?: number;
      capacity_pcs_per_week: number;
      required_sec_per_week: number;
      availability_sec_per_week?: number;
      alternative_border?: 'none' | 'unused' | 'all_alt' | 'mixed';
      detail_breakdown?: {
        project_label: string;
        detail_label: string;
        contribution_percent: number;
        share_percent: number;
        volume_quantity: number;
        has_rfq: boolean;
      }[];
      call_off_detail_breakdown?: {
        project_label: string;
        detail_label: string;
        contribution_percent: number;
        share_percent: number;
        volume_quantity: number;
        has_rfq: boolean;
      }[];
      /** Rozbicie na materiały (linie bazowe) — wolumeny produkcyjne/kontraktowe. */
      material_breakdown?: MaterialBreakdownItem[];
      /** Rozbicie na materiały (linie bazowe) — wolumeny Call off (SAP). */
      call_off_material_breakdown?: MaterialBreakdownItem[];
      has_rfq?: boolean;
    }
  >;
};

export type CallOffPeriodBreakdownMachine = {
  machine_id: number;
  has_sop?: boolean;
  has_eop?: boolean;
  months: Record<
    number,
    {
      load_percent: number;
      call_off_load_percent: number;
      weeks: Record<
        number,
        {
          load_percent: number;
          call_off_load_percent: number;
          detail_breakdown?: {
            project_label: string;
            detail_label: string;
            contribution_percent: number;
            share_percent: number;
            volume_quantity: number;
            has_rfq: boolean;
          }[];
          call_off_detail_breakdown?: {
            project_label: string;
            detail_label: string;
            contribution_percent: number;
            share_percent: number;
            volume_quantity: number;
            has_rfq: boolean;
          }[];
          material_breakdown?: MaterialBreakdownItem[];
          call_off_material_breakdown?: MaterialBreakdownItem[];
        }
      >;
      has_sop?: boolean;
      has_eop?: boolean;
      detail_breakdown?: {
        project_label: string;
        detail_label: string;
        contribution_percent: number;
        share_percent: number;
        volume_quantity: number;
        has_rfq: boolean;
      }[];
      call_off_detail_breakdown?: {
        project_label: string;
        detail_label: string;
        contribution_percent: number;
        share_percent: number;
        volume_quantity: number;
        has_rfq: boolean;
      }[];
      material_breakdown?: MaterialBreakdownItem[];
      call_off_material_breakdown?: MaterialBreakdownItem[];
    }
  >;
};

type DetailBreakdownRow = NonNullable<CallOffCalculatorMachine['years'][number]['call_off_detail_breakdown']>;

/** Detale z Capacity bez wolumenu SAP w okresie — dopisz jako 0%, żeby prognoza pokazywała skład maszyny. */
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

/** Materiały (linie bazowe) z Capacity bez wolumenu SAP w okresie — dopisz jako 0%, żeby lista Call off pokazywała skład maszyny. */
function mergeAssignedMaterialsIntoCallOffBreakdown(
  callOffMaterials: MaterialBreakdownItem[] | undefined,
  baseMaterials: MaterialBreakdownItem[] | undefined
): MaterialBreakdownItem[] {
  const co = [...(callOffMaterials ?? [])];
  const key = (m: MaterialBreakdownItem) => `${m.material_alias ?? ''}\0${m.material_sap ?? ''}`;
  const seen = new Set(co.map(key));
  for (const m of baseMaterials ?? []) {
    if (seen.has(key(m))) continue;
    seen.add(key(m));
    co.push({
      material_alias: m.material_alias,
      material_sap: m.material_sap,
      material_width_mm: m.material_width_mm,
      material_length_mm: m.material_length_mm,
      material_grammage_kg_m2: m.material_grammage_kg_m2,
      contribution_percent: 0,
      details: [],
    });
  }
  return co.sort((a, b) => b.contribution_percent - a.contribution_percent);
}

export function getCallOffComparisonCalculator(
  comparisonId: number,
  yearFrom: number,
  yearTo: number,
  machineIds?: number[],
  machineType?: string | string[],
  useContractualVolumes?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[],
  settingsProfile?: CalculationSettingsProfile
): CallOffCalculatorMachine[] {
  const callOffVolumes = loadCallOffVolumeMaps(comparisonId);

  const baseMachines = getMachineCapacityByYears(
    yearFrom,
    yearTo,
    machineIds,
    machineType,
    undefined,
    null,
    undefined,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    null,
    CALL_OFF_PROD_OPTIONS
  );

  /** Rok → maszyna → średnia w zakresie miesięcy SAP. */
  const sapAvgByYear = new Map<
    number,
    Map<
      number,
      { load_percent: number; detail_breakdown: DetailBreakdownRow; material_breakdown: MaterialBreakdownItem[] }
    >
  >();

  for (let y = yearFrom; y <= yearTo; y++) {
    sapAvgByYear.set(
      y,
      getMachineMonthlyAverageLoads(
        y,
        machineIds,
        machineType,
        undefined,
        null,
        undefined,
        useContractualVolumes,
        machineStatusFilter,
        dimensionFilters,
        settingsProfile,
        callOffVolumes
      )
    );
  }

  return baseMachines.map((m) => {
    const years: CallOffCalculatorMachine['years'] = {};
    for (const [yearKey, yData] of Object.entries(m.years)) {
      const year = Number(yearKey);
      const avg = sapAvgByYear.get(year)?.get(m.machine_id);
      const load = avg?.load_percent ?? 0;
      years[year] = {
        ...yData,
        call_off_load_percent: load,
        call_off_annual_load_percent: load,
        call_off_annual_required_sec_per_week: 0,
        call_off_annual_availability_sec_per_week: 0,
        call_off_detail_breakdown: avg?.detail_breakdown ?? [],
        call_off_material_breakdown: mergeAssignedMaterialsIntoCallOffBreakdown(
          avg?.material_breakdown,
          (yData as any).material_breakdown
        ),
      };
    }
    return { ...m, years };
  });
}

export function getCallOffPeriodBreakdown(
  comparisonId: number,
  year: number,
  machineIds?: number[],
  machineType?: string | string[],
  useContractualVolumes?: boolean,
  machineStatusFilter?: MachineStatusFilterInput,
  dimensionFilters?: MachineDimensionFilter[],
  settingsProfile?: CalculationSettingsProfile
): CallOffPeriodBreakdownMachine[] {
  const callOffVolumes = loadCallOffVolumeMaps(comparisonId);

  const base = getMachinePeriodBreakdown(
    year,
    machineIds,
    machineType,
    undefined,
    null,
    undefined,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    null,
    { includeAssignedZeroVolumeDetailsInBreakdown: true }
  );

  const callOff = getMachinePeriodBreakdown(
    year,
    machineIds,
    machineType,
    undefined,
    null,
    undefined,
    useContractualVolumes,
    machineStatusFilter,
    dimensionFilters,
    settingsProfile,
    callOffVolumes,
    { includeAssignedZeroVolumeDetailsInBreakdown: true }
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
            coWeek?.detail_breakdown,
            wd.detail_breakdown
          ),
          material_breakdown: (wd as any).material_breakdown ?? [],
          call_off_material_breakdown: mergeAssignedMaterialsIntoCallOffBreakdown(
            (coWeek as any)?.material_breakdown,
            (wd as any).material_breakdown
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
          coMd?.detail_breakdown,
          md.detail_breakdown
        ),
        material_breakdown: (md as any).material_breakdown ?? [],
        call_off_material_breakdown: mergeAssignedMaterialsIntoCallOffBreakdown(
          (coMd as any)?.material_breakdown,
          (md as any).material_breakdown
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
