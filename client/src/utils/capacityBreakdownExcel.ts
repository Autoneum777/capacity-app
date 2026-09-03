import { api } from '../api/client';
import type { TrendTableBuildOptions } from './capacityTrends';
import { deltaPp } from './capacityTrends';
import { excelExportCell } from './excelExportCell';
import type { BreakdownDetailLevel } from './visualizationReportOptions';
import { pdfTrendHeaders } from '../i18n/reportLabels';
import type { Locale } from '../i18n/types';
import type { DimFiltersState } from './machineDimensionFilters';
import { buildDimensionApiParams, EMPTY_DIM_FILTERS } from './machineDimensionFilters';
import { joinCsvFilter, joinCsvFilterNumbers } from './filterParams';

export type MachineStatusFilterValue = 'active' | 'inactive' | 'RFQ' | 'all';

export type BreakdownFetchParams = {
  yearFrom: number;
  yearTo: number;
  machineStatus: MachineStatusFilterValue[];
  type?: string[];
  client?: string[];
  scenarioId?: number;
  callOffComparisonId?: number;
  settingsProfile?: 'capacity' | 'ocu';
  dimFilters?: DimFiltersState;
  includeRfqOperationIds?: number[];
};

export type BreakdownSeriesKey =
  | 'production'
  | 'contract'
  | 'scenario_production'
  | 'scenario_contract'
  | 'call_off';

type BreakdownResponse = Awaited<ReturnType<typeof api.capacity.breakdown>>;

type BreakdownClient = {
  client: string;
  projects: {
    project_id: number;
    project_name: string;
    details: { detail_label: string }[];
  }[];
};

export function breakdownFetchParamsToApi(fetchParams: BreakdownFetchParams) {
  return {
    yearFrom: fetchParams.yearFrom,
    yearTo: fetchParams.yearTo,
    machineStatuses: joinCsvFilter(fetchParams.machineStatus),
    types: joinCsvFilter(fetchParams.type ?? []),
    clients: joinCsvFilter(fetchParams.client ?? []),
    scenarioId: fetchParams.scenarioId,
    callOffComparisonId: fetchParams.callOffComparisonId,
    settingsProfile: fetchParams.settingsProfile,
    includeRfqOperationIds: joinCsvFilterNumbers(fetchParams.includeRfqOperationIds ?? []),
    ...buildDimensionApiParams(fetchParams.dimFilters ?? EMPTY_DIM_FILTERS),
  };
}

export type BreakdownExcelLabels = {
  year: string;
  client: string;
  project: string;
  detail: string;
};

export type SeriesValues = {
  production: number | null;
  contract: number | null;
  scenarioProduction: number | null;
  scenarioContract: number | null;
};

export function activeBreakdownSeriesKeys(opts: TrendTableBuildOptions): BreakdownSeriesKey[] {
  const keys: BreakdownSeriesKey[] = [];
  if (opts.showProduction) keys.push('production');
  if (opts.showContract) keys.push('contract');
  if (opts.hasScenario && opts.showScenarioProduction) keys.push('scenario_production');
  if (opts.hasScenario && opts.showScenarioContract) keys.push('scenario_contract');
  return keys;
}

function unionClients(breakdown: BreakdownResponse): BreakdownClient[] {
  const byClient = new Map<string, BreakdownClient>();
  for (const series of Object.values(breakdown.series)) {
    for (const client of series?.clients ?? []) {
      const existing = byClient.get(client.client);
      if (!existing) {
        byClient.set(client.client, {
          client: client.client,
          projects: client.projects.map((p) => ({
            project_id: p.project_id,
            project_name: p.project_name,
            details: p.details.map((d) => ({ detail_label: d.detail_label })),
          })),
        });
        continue;
      }
      for (const project of client.projects) {
        const existingProject = existing.projects.find((p) => p.project_id === project.project_id);
        if (!existingProject) {
          existing.projects.push({
            project_id: project.project_id,
            project_name: project.project_name,
            details: project.details.map((d) => ({ detail_label: d.detail_label })),
          });
          continue;
        }
        for (const detail of project.details) {
          if (!existingProject.details.some((d) => d.detail_label === detail.detail_label)) {
            existingProject.details.push({ detail_label: detail.detail_label });
          }
        }
      }
    }
  }
  return [...byClient.values()].sort((a, b) => a.client.localeCompare(b.client));
}

function scaleLoadByShare(
  periodAnchor: number | null | undefined,
  sharePercent: number | null | undefined,
  fallbackLoad?: number | null,
  seriesLoadPercent?: number | null
): number | null {
  if (periodAnchor == null || !Number.isFinite(periodAnchor)) return null;
  const share = Number(sharePercent);
  if (Number.isFinite(share)) {
    return Math.round(periodAnchor * (share / 100) * 100) / 100;
  }
  const nodeLoad = Number(fallbackLoad);
  const seriesLoad = Number(seriesLoadPercent);
  if (Number.isFinite(nodeLoad) && Number.isFinite(seriesLoad) && Math.abs(seriesLoad) > 1e-9) {
    return Math.round(periodAnchor * (nodeLoad / seriesLoad) * 100) / 100;
  }
  return Number.isFinite(nodeLoad) ? nodeLoad : null;
}

function periodAnchorForSeries(yearTotals: SeriesValues, seriesKey: BreakdownSeriesKey): number | null {
  if (seriesKey === 'production') return yearTotals.production;
  if (seriesKey === 'contract') return yearTotals.contract;
  if (seriesKey === 'scenario_production') return yearTotals.scenarioProduction;
  if (seriesKey === 'scenario_contract') return yearTotals.scenarioContract;
  return null;
}

function readSeriesLoad(
  breakdown: BreakdownResponse | null | undefined,
  seriesKey: BreakdownSeriesKey,
  path: { client?: string; projectId?: number; detailLabel?: string },
  yearTotals: SeriesValues
): number | null {
  const series = breakdown?.series[seriesKey];
  const periodAnchor = periodAnchorForSeries(yearTotals, seriesKey);
  if (!path.client) return periodAnchor;
  if (!series) return null;
  const client = series.clients.find((c) => c.client === path.client);
  if (!client) return null;
  if (path.projectId == null && !path.detailLabel) {
    return scaleLoadByShare(periodAnchor, client.share_percent, client.load_percent, series.load_percent);
  }
  const project = client.projects.find((p) => p.project_id === path.projectId);
  if (!project) return null;
  if (!path.detailLabel) {
    return scaleLoadByShare(periodAnchor, project.share_percent, project.load_percent, series.load_percent);
  }
  const detail = project.details.find((d) => d.detail_label === path.detailLabel);
  if (!detail) return null;
  return scaleLoadByShare(periodAnchor, detail.share_percent, detail.load_percent, series.load_percent);
}

function valuesFromBreakdown(
  breakdown: BreakdownResponse | null | undefined,
  path: { client?: string; projectId?: number; detailLabel?: string },
  opts: TrendTableBuildOptions,
  yearTotals: SeriesValues
): SeriesValues {
  return {
    production: opts.showProduction ? readSeriesLoad(breakdown, 'production', path, yearTotals) : null,
    contract: opts.showContract ? readSeriesLoad(breakdown, 'contract', path, yearTotals) : null,
    scenarioProduction:
      opts.hasScenario && opts.showScenarioProduction
        ? readSeriesLoad(breakdown, 'scenario_production', path, yearTotals)
        : null,
    scenarioContract:
      opts.hasScenario && opts.showScenarioContract
        ? readSeriesLoad(breakdown, 'scenario_contract', path, yearTotals)
        : null,
  };
}

function valuesToCells(values: SeriesValues, opts: TrendTableBuildOptions): (string | number | null)[] {
  const cells: (string | number | null)[] = [];
  if (opts.showProduction) cells.push(excelExportCell(values.production));
  if (opts.showContract) cells.push(excelExportCell(values.contract));
  if (opts.showProduction && opts.showContract) {
    cells.push(excelExportCell(deltaPp(values.contract, values.production)));
  }
  if (opts.hasScenario && opts.showScenarioProduction) cells.push(excelExportCell(values.scenarioProduction));
  if (opts.hasScenario && opts.showScenarioProduction && opts.showProduction) {
    cells.push(excelExportCell(deltaPp(values.production, values.scenarioProduction)));
  }
  if (opts.hasScenario && opts.showScenarioContract) cells.push(excelExportCell(values.scenarioContract));
  if (opts.hasScenario && opts.showScenarioContract && opts.showContract) {
    cells.push(excelExportCell(deltaPp(values.contract, values.scenarioContract)));
  }
  return cells;
}

function buildHierarchyHeaders(
  detailLevel: BreakdownDetailLevel,
  colLabels: BreakdownExcelLabels,
  extraPrefix: string[] = []
): string[] {
  const headers = [...extraPrefix, colLabels.year];
  if (detailLevel === 'year') return headers;
  headers.push(colLabels.client);
  if (detailLevel === 'client') return headers;
  headers.push(colLabels.project);
  if (detailLevel === 'project') return headers;
  headers.push(colLabels.detail);
  return headers;
}

export function breakdownTableHeaders(
  locale: Locale,
  opts: TrendTableBuildOptions,
  detailLevel: BreakdownDetailLevel,
  colLabels: BreakdownExcelLabels,
  extraPrefix: string[] = []
): string[] {
  return [...buildHierarchyHeaders(detailLevel, colLabels, extraPrefix), ...pdfTrendHeaders(locale, opts).slice(1)];
}

function hierarchyCells(detailLevel: BreakdownDetailLevel, year: number, client = '', project = '', detail = ''): (string | number | null)[] {
  if (detailLevel === 'year') return [excelExportCell(year)];
  if (detailLevel === 'client') return [excelExportCell(year), client];
  if (detailLevel === 'project') return [excelExportCell(year), client, project];
  return [excelExportCell(year), client, project, detail];
}

function flattenYearBreakdown(
  year: number,
  breakdown: BreakdownResponse | null,
  yearTotals: SeriesValues,
  detailLevel: BreakdownDetailLevel,
  opts: TrendTableBuildOptions
): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  rows.push([...hierarchyCells(detailLevel, year), ...valuesToCells(yearTotals, opts)]);

  if (detailLevel === 'year' || !breakdown) return rows;

  const clients = unionClients(breakdown);
  for (const clientNode of clients) {
    if (detailLevel === 'client') {
      const clientValues = valuesFromBreakdown(breakdown, { client: clientNode.client }, opts, yearTotals);
      rows.push([...hierarchyCells(detailLevel, year, clientNode.client), ...valuesToCells(clientValues, opts)]);
      continue;
    }

    if (detailLevel === 'detail') {
      const clientValues = valuesFromBreakdown(breakdown, { client: clientNode.client }, opts, yearTotals);
      rows.push([
        ...hierarchyCells(detailLevel, year, clientNode.client, '', ''),
        ...valuesToCells(clientValues, opts),
      ]);
    }

    for (const projectNode of clientNode.projects) {
      if (detailLevel === 'project') {
        const projectValues = valuesFromBreakdown(
          breakdown,
          { client: clientNode.client, projectId: projectNode.project_id },
          opts,
          yearTotals
        );
        rows.push([
          ...hierarchyCells(detailLevel, year, clientNode.client, projectNode.project_name),
          ...valuesToCells(projectValues, opts),
        ]);
        continue;
      }

      if (detailLevel === 'detail') {
        const projectValues = valuesFromBreakdown(
          breakdown,
          { client: clientNode.client, projectId: projectNode.project_id },
          opts,
          yearTotals
        );
        rows.push([
          ...hierarchyCells(detailLevel, year, clientNode.client, projectNode.project_name, ''),
          ...valuesToCells(projectValues, opts),
        ]);
      }

      if (detailLevel !== 'detail') continue;

      for (const detailNode of projectNode.details) {
        const detailValues = valuesFromBreakdown(
          breakdown,
          {
            client: clientNode.client,
            projectId: projectNode.project_id,
            detailLabel: detailNode.detail_label,
          },
          opts,
          yearTotals
        );
        rows.push([
          ...hierarchyCells(detailLevel, year, clientNode.client, projectNode.project_name, detailNode.detail_label),
          ...valuesToCells(detailValues, opts),
        ]);
      }
    }
  }

  return rows;
}

async function fetchBreakdownForYear(
  year: number,
  scope: { line?: string; machineId?: number },
  seriesKeys: BreakdownSeriesKey[],
  fetchParams: BreakdownFetchParams
): Promise<BreakdownResponse | null> {
  if (!seriesKeys.length) return null;
  try {
    return await api.capacity.breakdown({
      year,
      series: seriesKeys.join(','),
      line: scope.line,
      machineId: scope.machineId,
      ...breakdownFetchParamsToApi(fetchParams),
    });
  } catch {
    return null;
  }
}

export async function fetchEntityBreakdowns(
  years: number[],
  scope: { line?: string; machineId?: number },
  seriesKeys: BreakdownSeriesKey[],
  fetchParams: BreakdownFetchParams
): Promise<Map<number, BreakdownResponse | null>> {
  const entries = await Promise.all(
    years.map(async (year) => [year, await fetchBreakdownForYear(year, scope, seriesKeys, fetchParams)] as const)
  );
  return new Map(entries);
}

export async function buildBreakdownTrendSection(input: {
  locale: Locale;
  years: number[];
  detailLevel: BreakdownDetailLevel;
  tableOpts: TrendTableBuildOptions;
  colLabels: BreakdownExcelLabels;
  scope: { line?: string; machineId?: number };
  fetchParams: BreakdownFetchParams;
  getYearTotals: (year: number) => SeriesValues;
}): Promise<{ headers: string[]; rows: (string | number | null)[][] }> {
  const seriesKeys = activeBreakdownSeriesKeys(input.tableOpts);
  const headers = breakdownTableHeaders(input.locale, input.tableOpts, input.detailLevel, input.colLabels);
  const breakdowns =
    input.detailLevel === 'year' || !seriesKeys.length
      ? new Map<number, BreakdownResponse | null>()
      : await fetchEntityBreakdowns(input.years, input.scope, seriesKeys, input.fetchParams);

  const rows: (string | number | null)[][] = [];
  for (const year of input.years) {
    const yearTotals = input.getYearTotals(year);
    const breakdown = breakdowns.get(year) ?? null;
    rows.push(...flattenYearBreakdown(year, breakdown, yearTotals, input.detailLevel, input.tableOpts));
  }

  return { headers, rows };
}

export async function buildBreakdownLinesOverviewSection(input: {
  locale: Locale;
  lines: string[];
  years: number[];
  detailLevel: BreakdownDetailLevel;
  tableOpts: TrendTableBuildOptions;
  colLabels: BreakdownExcelLabels;
  lineLabel: string;
  fetchParams: BreakdownFetchParams;
  getYearTotals: (line: string, year: number) => SeriesValues;
  sheetTitle: string;
}): Promise<{ sheetTitle: string; headers: string[]; rows: (string | number | null)[][] }> {
  const seriesKeys = activeBreakdownSeriesKeys(input.tableOpts);
  const headers = breakdownTableHeaders(input.locale, input.tableOpts, input.detailLevel, input.colLabels, [input.lineLabel]);
  const rows: (string | number | null)[][] = [];

  for (const line of input.lines) {
    const breakdowns =
      input.detailLevel === 'year' || !seriesKeys.length
        ? new Map<number, BreakdownResponse | null>()
        : await fetchEntityBreakdowns(input.years, { line }, seriesKeys, input.fetchParams);

    for (const year of input.years) {
      const yearTotals = input.getYearTotals(line, year);
      if (input.detailLevel === 'year') {
        rows.push([line, ...hierarchyCells('year', year), ...valuesToCells(yearTotals, input.tableOpts)]);
        continue;
      }
      const breakdown = breakdowns.get(year) ?? null;
      const yearRows = flattenYearBreakdown(year, breakdown, yearTotals, input.detailLevel, input.tableOpts);
      for (const yr of yearRows) {
        rows.push([line, ...yr]);
      }
    }
  }

  return { sheetTitle: input.sheetTitle, headers, rows };
}
