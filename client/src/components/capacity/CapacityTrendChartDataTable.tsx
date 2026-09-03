import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../context/I18nContext';
import type { TrendChartRow, TrendSeriesDef } from '../../utils/capacityTrends';
import type { BreakdownFetchParams } from '../../utils/capacityBreakdownExcel';
import { breakdownFetchParamsToApi } from '../../utils/capacityBreakdownExcel';
import { applyChartMetric, type ChartMetricMode } from '../../utils/chartMetricMode';

export type CapacityBreakdownSeriesKey =
  | 'production'
  | 'contract'
  | 'scenario_production'
  | 'scenario_contract'
  | 'call_off';

export type ChartBreakdownScope = {
  kind: 'line' | 'machine';
  line?: string;
  machineId?: number;
  fetchParams: BreakdownFetchParams;
};

type BreakdownResponse = Awaited<ReturnType<typeof api.capacity.breakdown>>;
type BreakdownSeries = NonNullable<BreakdownResponse['series'][CapacityBreakdownSeriesKey]>;
type BreakdownClient = BreakdownSeries['clients'][number];
type BreakdownProject = BreakdownClient['projects'][number];
type BreakdownDetail = BreakdownProject['details'][number];
type BreakdownYearData = {
  common?: BreakdownResponse;
  callOffById: Map<number, BreakdownResponse>;
};

function fmtMetricPct(value: number | null | undefined, mode: ChartMetricMode): string {
  const v = applyChartMetric(value, mode);
  return v != null ? `${v}%` : '—';
}

export function seriesBreakdownKey(seriesKey: string): CapacityBreakdownSeriesKey | null {
  if (seriesKey.includes('_calloff') || seriesKey.endsWith('calloff')) return 'call_off';
  if (seriesKey.endsWith('_scen_contract')) return 'scenario_contract';
  if (seriesKey.endsWith('_scen_prod')) return 'scenario_production';
  if (seriesKey.endsWith('_contract_rfq') || seriesKey.endsWith('_kon_rfq')) return 'contract';
  if (seriesKey.endsWith('_prod_rfq')) return 'production';
  if (seriesKey.endsWith('_contract') || seriesKey.endsWith('_kon')) return 'contract';
  if (seriesKey.endsWith('_prod')) return 'production';
  return null;
}

function callOffIdFromSeriesKey(seriesKey: string): number | null {
  const m = /_co(\d+)_calloff$/i.exec(seriesKey);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function findClient(series: BreakdownSeries | undefined, client: string): BreakdownClient | undefined {
  return series?.clients.find((c) => c.client === client);
}

function findProject(series: BreakdownSeries | undefined, client: string, projectId: number): BreakdownProject | undefined {
  return findClient(series, client)?.projects.find((p) => p.project_id === projectId);
}

function findDetail(
  series: BreakdownSeries | undefined,
  client: string,
  projectId: number,
  detailLabel: string
): BreakdownDetail | undefined {
  return findProject(series, client, projectId)?.details.find((d) => d.detail_label === detailLabel);
}

/**
 * Udział w obciążeniu okresu: wartość z wykresu (miesiąc/tydzień/rok) × share_percent / 100.
 * Dzięki temu klienci sumują się do miesiąca, projekty do klienta, detale do projektu.
 */
function contributionOfPeriod(
  periodAnchor: number | null | undefined,
  node: { load_percent?: number; share_percent?: number } | undefined,
  seriesLoadPercent: number | null | undefined
): number | null {
  if (periodAnchor == null || !Number.isFinite(periodAnchor) || !node) return null;
  const share = Number(node.share_percent);
  if (Number.isFinite(share)) {
    return Math.round(periodAnchor * (share / 100) * 100) / 100;
  }
  const nodeLoad = Number(node.load_percent);
  const seriesLoad = Number(seriesLoadPercent);
  if (Number.isFinite(nodeLoad) && Number.isFinite(seriesLoad) && Math.abs(seriesLoad) > 1e-9) {
    return Math.round(periodAnchor * (nodeLoad / seriesLoad) * 100) / 100;
  }
  return Number.isFinite(nodeLoad) ? nodeLoad : null;
}

function unionClientsFromBreakdowns(breakdowns: BreakdownResponse[]): BreakdownClient[] {
  const byClient = new Map<string, BreakdownClient>();
  for (const breakdown of breakdowns) {
    for (const series of Object.values(breakdown.series)) {
      for (const client of series?.clients ?? []) {
        const existing = byClient.get(client.client);
        if (!existing) {
          byClient.set(client.client, {
            ...client,
            projects: client.projects.map((p) => ({ ...p, details: [...p.details] })),
          });
          continue;
        }
        for (const project of client.projects) {
          const existingProject = existing.projects.find((p) => p.project_id === project.project_id);
          if (!existingProject) {
            existing.projects.push({ ...project, details: [...project.details] });
            continue;
          }
          for (const detail of project.details) {
            if (!existingProject.details.some((d) => d.detail_label === detail.detail_label)) {
              existingProject.details.push(detail);
            }
          }
        }
      }
    }
  }
  return [...byClient.values()].sort((a, b) => a.client.localeCompare(b.client, 'pl'));
}

type Props = {
  rows: TrendChartRow[];
  activeSeries: TrendSeriesDef[];
  breakdownScope?: ChartBreakdownScope;
  metricMode?: ChartMetricMode;
  /** Granularność osi X — etykiety kolumny i zapytanie breakdown. */
  rangeMode?: 'year' | 'month' | 'week';
};

const INDENT_STEP_PX = 28;
const CHEVRON_WIDTH = 14;

function TreeLabelCell({
  level,
  background,
  fontWeight,
  fontSize,
  textColor,
  expandable,
  open,
  onToggle,
  children,
}: {
  level: number;
  background?: string;
  fontWeight?: number | string;
  fontSize?: number;
  textColor?: string;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const chevron = (isOpen: boolean) => (isOpen ? '▾' : '▸');
  return (
    <td
      style={{
        padding: '6px 10px',
        verticalAlign: 'middle',
        background,
        borderTop: '1px solid #eee',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: level * INDENT_STEP_PX,
        }}
      >
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              font: 'inherit',
              fontWeight: fontWeight ?? 'inherit',
              fontSize: fontSize ?? 'inherit',
              padding: 0,
              textAlign: 'left',
            }}
            aria-expanded={open}
          >
            <span aria-hidden style={{ width: CHEVRON_WIDTH, textAlign: 'center', color: '#666', flexShrink: 0 }}>
              {chevron(Boolean(open))}
            </span>
            <span>{children}</span>
          </button>
        ) : (
          <>
            <span aria-hidden style={{ width: CHEVRON_WIDTH, flexShrink: 0 }} />
            <span style={{ fontWeight, fontSize, color: textColor }}>{children}</span>
          </>
        )}
      </div>
    </td>
  );
}

function SeriesValueCell({
  series,
  value,
  background,
  metricMode = 'load',
}: {
  series: TrendSeriesDef;
  value: number | null | undefined;
  background?: string;
  metricMode?: ChartMetricMode;
}) {
  return (
    <td style={{ padding: '6px 10px', verticalAlign: 'middle', background, borderTop: '1px solid #eee' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 6,
          minWidth: 48,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: series.color,
            flexShrink: 0,
            opacity: 0.85,
          }}
        />
        <span>{fmtMetricPct(value, metricMode)}</span>
      </span>
    </td>
  );
}

export default function CapacityTrendChartDataTable({
  rows,
  activeSeries,
  breakdownScope,
  metricMode = 'load',
  rangeMode = 'year',
}: Props) {
  const { t } = useI18n();
  const [expandedYears, setExpandedYears] = useState<Set<number>>(() => new Set());
  const [expandedClients, setExpandedClients] = useState<Set<string>>(() => new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [breakdownCache, setBreakdownCache] = useState<Map<number, BreakdownYearData>>(() => new Map());
  const [loadingYears, setLoadingYears] = useState<Set<number>>(() => new Set());
  const [errorYears, setErrorYears] = useState<Map<number, string>>(() => new Map());

  const periodColLabel =
    rangeMode === 'week' ? t('dataViz.colWeek') : rangeMode === 'month' ? t('dataViz.colMonth') : t('dataViz.colYear');
  const noDataLabel =
    rangeMode === 'week'
      ? t('dataViz.breakdownNoDataWeek')
      : rangeMode === 'month'
        ? t('dataViz.breakdownNoDataMonth')
        : t('dataViz.breakdownNoData');

  const uniqueSeriesKeys = [
    ...new Set(
      activeSeries.map((s) => seriesBreakdownKey(s.key)).filter((k): k is CapacityBreakdownSeriesKey => k != null)
    ),
  ];
  const callOffSeriesIds = [
    ...new Set(activeSeries.map((s) => callOffIdFromSeriesKey(s.key)).filter((id): id is number => id != null)),
  ];
  const uniqueSeriesKey = uniqueSeriesKeys.slice().sort().join(',');
  const callOffSeriesIdsKey = callOffSeriesIds.slice().sort((a, b) => a - b).join(',');
  const fetchParamsKey = JSON.stringify(breakdownScope?.fetchParams ?? null);
  const cacheScopeKey = `${uniqueSeriesKey}|${callOffSeriesIdsKey}|${fetchParamsKey}|${rangeMode}`;

  useEffect(() => {
    setBreakdownCache(new Map());
    setErrorYears(new Map());
  }, [cacheScopeKey]);

  const loadBreakdown = useCallback(
    async (periodId: number, row: TrendChartRow) => {
      if (!breakdownScope || uniqueSeriesKeys.length === 0 || breakdownCache.has(periodId)) return;

      const calendarYear = row.calendarYear ?? (rangeMode === 'year' ? row.year : undefined);
      if (calendarYear == null || !Number.isFinite(calendarYear)) {
        setErrorYears((prev) => new Map(prev).set(periodId, 'Invalid period'));
        return;
      }

      setLoadingYears((prev) => new Set(prev).add(periodId));
      setErrorYears((prev) => {
        const next = new Map(prev);
        next.delete(periodId);
        return next;
      });
      try {
        const baseQuery = {
          year: calendarYear,
          month: rangeMode === 'year' ? undefined : row.month,
          week: rangeMode === 'week' ? row.week : undefined,
          line: breakdownScope.kind === 'line' ? breakdownScope.line : undefined,
          machineId: breakdownScope.kind === 'machine' ? breakdownScope.machineId : undefined,
          ...breakdownFetchParamsToApi(breakdownScope.fetchParams),
        };
        const sharedSeries = uniqueSeriesKeys.filter((k) => k !== 'call_off');
        const [common, callOffEntries] = await Promise.all([
          sharedSeries.length > 0
            ? api.capacity.breakdown({
                ...baseQuery,
                series: sharedSeries.join(','),
              })
            : Promise.resolve(undefined),
          Promise.all(
            callOffSeriesIds.map(async (callOffId) => [
              callOffId,
              await api.capacity.breakdown({
                ...baseQuery,
                series: 'call_off',
                callOffComparisonId: callOffId,
              }),
            ] as const)
          ),
        ]);
        setBreakdownCache((prev) =>
          new Map(prev).set(periodId, {
            common,
            callOffById: new Map(callOffEntries),
          })
        );
      } catch (e) {
        setErrorYears((prev) => new Map(prev).set(periodId, e instanceof Error ? e.message : String(e)));
      } finally {
        setLoadingYears((prev) => {
          const next = new Set(prev);
          next.delete(periodId);
          return next;
        });
      }
    },
    [breakdownScope, uniqueSeriesKeys, callOffSeriesIds, breakdownCache, rangeMode]
  );

  const toggleYear = (periodId: number, row: TrendChartRow) => {
    setExpandedYears((prev) => {
      const next = new Set(prev);
      if (next.has(periodId)) next.delete(periodId);
      else {
        next.add(periodId);
        void loadBreakdown(periodId, row);
      }
      return next;
    });
  };

  const toggleClient = (year: number, client: string) => {
    const key = `${year}|${client}`;
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleProject = (year: number, client: string, projectId: number) => {
    const key = `${year}|${client}|${projectId}`;
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const chevron = (open: boolean) => (open ? '▾' : '▸');

  const renderBreakdownRows = (yearData: BreakdownYearData, periodRow: TrendChartRow) => {
    const year = periodRow.year;
    const allBreakdowns = [...(yearData.common ? [yearData.common] : []), ...Array.from(yearData.callOffById.values())];
    const clients = unionClientsFromBreakdowns(allBreakdowns);
    if (!clients.length) {
      return (
        <tr>
          <td colSpan={activeSeries.length + 1} style={{ padding: '8px 10px 8px 36px', color: '#888', fontSize: 12, background: '#fafafa' }}>
            {noDataLabel}
          </td>
        </tr>
      );
    }

    return clients.flatMap((clientNode) => {
      const breakdownForSeries = (seriesKey: string): BreakdownResponse | undefined => {
        const bk = seriesBreakdownKey(seriesKey);
        if (!bk) return undefined;
        if (bk !== 'call_off') return yearData.common;
        const callOffId = callOffIdFromSeriesKey(seriesKey);
        if (callOffId != null) return yearData.callOffById.get(callOffId);
        return yearData.common;
      };
      const cellValue = (
        seriesKey: string,
        node: { load_percent?: number; share_percent?: number } | undefined
      ): number | null => {
        const bk = seriesBreakdownKey(seriesKey);
        const seriesBreakdown = breakdownForSeries(seriesKey);
        const seriesData = bk && seriesBreakdown ? seriesBreakdown.series[bk] : undefined;
        const periodAnchor = periodRow[seriesKey] as number | null | undefined;
        return contributionOfPeriod(periodAnchor, node, seriesData?.load_percent);
      };
      const clientKey = `${year}|${clientNode.client}`;
      const clientOpen = expandedClients.has(clientKey);
      const clientBg = '#fafafa';
      const clientRows = [
        <tr key={clientKey}>
          <TreeLabelCell
            level={1}
            background={clientBg}
            fontWeight={600}
            expandable
            open={clientOpen}
            onToggle={() => toggleClient(year, clientNode.client)}
          >
            {t('projects.client')}: {clientNode.client}
          </TreeLabelCell>
          {activeSeries.map((s) => {
            const bk = seriesBreakdownKey(s.key);
            const seriesBreakdown = breakdownForSeries(s.key);
            const node = bk && seriesBreakdown ? findClient(seriesBreakdown.series[bk], clientNode.client) : undefined;
            return <SeriesValueCell key={s.key} series={s} value={cellValue(s.key, node)} background={clientBg} metricMode={metricMode} />;
          })}
        </tr>,
      ];

      if (!clientOpen) return clientRows;

      for (const projectNode of clientNode.projects) {
        const projectKey = `${year}|${clientNode.client}|${projectNode.project_id}`;
        const projectOpen = expandedProjects.has(projectKey);
        const projectBg = '#f5f7f8';
        clientRows.push(
          <tr key={projectKey}>
            <TreeLabelCell
              level={2}
              background={projectBg}
              fontWeight={600}
              expandable
              open={projectOpen}
              onToggle={() => toggleProject(year, clientNode.client, projectNode.project_id)}
            >
              {t('projects.name')}: {projectNode.project_name}
            </TreeLabelCell>
            {activeSeries.map((s) => {
              const bk = seriesBreakdownKey(s.key);
              const seriesBreakdown = breakdownForSeries(s.key);
              const node =
                bk && seriesBreakdown
                  ? findProject(seriesBreakdown.series[bk], clientNode.client, projectNode.project_id)
                  : undefined;
              return <SeriesValueCell key={s.key} series={s} value={cellValue(s.key, node)} background={projectBg} metricMode={metricMode} />;
            })}
          </tr>
        );

        if (projectOpen) {
          for (const detailNode of projectNode.details) {
            const detailBg = '#f0f2f3';
            clientRows.push(
              <tr key={`${projectKey}|${detailNode.detail_label}`}>
                <TreeLabelCell level={3} background={detailBg} fontSize={12} textColor="#444">
                  <>
                    {t('layout.details')}: {detailNode.detail_label}
                    {detailNode.has_rfq ? (
                      <span style={{ marginLeft: 6, fontSize: 11, color: '#6a1b9a' }}>RFQ</span>
                    ) : null}
                  </>
                </TreeLabelCell>
                {activeSeries.map((s) => {
                  const bk = seriesBreakdownKey(s.key);
                  const seriesBreakdown = breakdownForSeries(s.key);
                  const node = bk
                    && seriesBreakdown
                    ? findDetail(seriesBreakdown.series[bk], clientNode.client, projectNode.project_id, detailNode.detail_label)
                    : undefined;
                  return <SeriesValueCell key={s.key} series={s} value={cellValue(s.key, node)} background={detailBg} metricMode={metricMode} />;
                })}
              </tr>
            );
          }
        }
      }

      return clientRows;
    });
  };

  return (
    <div style={{ marginTop: 12, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '38%' }} />
          {activeSeries.map((s) => (
            <col key={s.key} />
          ))}
        </colgroup>
        <thead>
          <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
            <th style={{ padding: '8px 10px' }}>{periodColLabel}</th>
            {activeSeries.map((s) => (
              <th key={s.key} style={{ padding: '8px 10px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                  {s.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {rows.map((row) => {
          const yearOpen = expandedYears.has(row.year);
          const breakdown = breakdownCache.get(row.year);
          const loading = loadingYears.has(row.year);
          const error = errorYears.get(row.year);
          const canExpand = Boolean(breakdownScope && uniqueSeriesKeys.length);
          const periodLabel = row.periodLabel ?? String(row.year);

          return (
            <tbody
              key={row.year}
              data-viz-export-table-part=""
              data-viz-export-table-year={String(row.year)}
            >
              <tr style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '8px 10px', fontWeight: 600, verticalAlign: 'middle' }}>
                  {canExpand ? (
                    <button
                      type="button"
                      onClick={() => toggleYear(row.year, row)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        font: 'inherit',
                        fontWeight: 600,
                        padding: 0,
                        color: '#333',
                      }}
                      aria-expanded={yearOpen}
                    >
                      <span aria-hidden style={{ width: 14, textAlign: 'center', color: '#666' }}>
                        {chevron(yearOpen)}
                      </span>
                      {periodLabel}
                    </button>
                  ) : (
                    periodLabel
                  )}
                </td>
                {activeSeries.map((s) => {
                  // Wartość roku zawsze z serii wykresu — breakdown tylko w wierszach rozwijanych.
                  // Dzięki temu punkt na wykresie i komórka roku są spójne (średnia w zakresie SAP).
                  const yearValue = row[s.key] as number | null | undefined;
                  return (
                    <td key={s.key} style={{ padding: '8px 10px', verticalAlign: 'middle' }}>
                      {fmtMetricPct(yearValue, metricMode)}
                    </td>
                  );
                })}
              </tr>
              {canExpand && yearOpen && loading && (
                <tr>
                  <td colSpan={activeSeries.length + 1} style={{ padding: '8px 10px 8px 24px', color: '#666', fontSize: 12, background: '#fafafa' }}>
                    {t('dataViz.breakdownLoading')}
                  </td>
                </tr>
              )}
              {canExpand && yearOpen && error && (
                <tr>
                  <td colSpan={activeSeries.length + 1} style={{ padding: '8px 10px 8px 24px', color: 'var(--cap-red, #c62828)', fontSize: 12, background: '#fafafa' }}>
                    {t('dataViz.breakdownFailed')}
                  </td>
                </tr>
              )}
              {canExpand && yearOpen && !loading && !error && breakdown && renderBreakdownRows(breakdown, row)}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
