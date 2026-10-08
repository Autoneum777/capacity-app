import { useEffect, useMemo, useState, type ReactNode } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { api, type ScenarioAllocationReportRow } from '../api/client';
import { useI18n } from '../context/I18nContext';
import type { Locale } from '../i18n/types';
import { pdfSafe } from '../utils/pdfText';

type Report = { rows: ScenarioAllocationReportRow[] };

function groupBy<T>(rows: T[], key: (row: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(row);
    else groups.set(groupKey, [row]);
  }
  return [...groups.entries()];
}

function addNullable(values: (number | null)[]): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) : null;
}

function aggregateRows(rows: ScenarioAllocationReportRow[]): ScenarioAllocationReportRow[] {
  return groupBy(
    rows,
    (row) =>
      `${row.sourceMachineId}|${row.targetMachineId}|${row.partId ?? 0}|${row.year}|${row.volumeUnit}`
  ).map(([, group]) => ({
    ...group[0],
    volumeBefore: addNullable(group.map((row) => row.volumeBefore)),
    volumeRemaining: addNullable(group.map((row) => row.volumeRemaining)),
    volumeMoved: addNullable(group.map((row) => row.volumeMoved)),
  }));
}

function localeTag(locale: Locale): string {
  if (locale === 'de') return 'de-DE';
  if (locale === 'en') return 'en-GB';
  return 'pl-PL';
}

function formatVolume(value: number | null, locale: Locale): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 3 }).format(Math.round(value * 1000) / 1000);
}

function DotBranch({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 7 }}>
      <span
        aria-hidden
        style={{
          flex: '0 0 auto',
          width: 12,
          height: 12,
          marginTop: 3,
          border: '2px solid #455a64',
          borderRadius: '50%',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

/** Raport ruchów w oknie Raport na kalkulatorze: wszystkie maszyny zwalniane albo wszystkie detale. */
export default function ScenarioMoveReport({ scenarioId }: { scenarioId: number }) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<'machine' | 'part'>('machine');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(scenarioId) || scenarioId <= 0) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.scenarios
      .allocationReport(scenarioId)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setReport(null);
        setError(e?.message || t('scenarios.loadError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scenarioId, t]);

  const rows = useMemo(() => aggregateRows(report?.rows ?? []), [report]);
  const volumeUnitLabel = (unit: string) =>
    unit === 'annual'
      ? t('common.unitAnnualShort')
      : unit === 'monthly'
        ? t('common.unitMonthlyShort')
        : t('common.unitWeeklyShort');

  const valueText = (row: ScenarioAllocationReportRow) =>
    `${t('scenarios.moveReportBefore')}: ${formatVolume(row.volumeBefore, locale)}, ` +
    `${t('scenarios.moveReportRemaining')}: ${formatVolume(row.volumeRemaining, locale)}, ` +
    `${t('scenarios.moveReportMoved')}: ${formatVolume(row.volumeMoved, locale)} ${volumeUnitLabel(row.volumeUnit)}`;

  const exportRows = rows.map((row) => [
    row.sourceMachineLabel,
    row.targetMachineLabel,
    row.partLabel,
    row.year,
    formatVolume(row.volumeBefore, locale),
    formatVolume(row.volumeRemaining, locale),
    formatVolume(row.volumeMoved, locale),
    volumeUnitLabel(row.volumeUnit),
  ]);
  const exportHeaders = [
    t('scenarios.moveReportSource'),
    t('scenarios.moveReportTarget'),
    t('scenarios.moveReportPart'),
    t('scenarios.moveReportYear'),
    t('scenarios.moveReportBefore'),
    t('scenarios.moveReportRemaining'),
    t('scenarios.moveReportMoved'),
    t('scenarios.moveReportUnit'),
  ];

  const downloadPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(16);
    doc.text(pdfSafe(t('layout.moveReport')), 36, 32);
    autoTable(doc, {
      startY: 45,
      head: [exportHeaders.map(pdfSafe)],
      body: exportRows.map((row) => row.map(pdfSafe)),
      styles: { fontSize: 7, cellPadding: 3 },
      headStyles: { fillColor: [21, 101, 192] },
    });
    doc.save(`raport_ruchow_scenariusz_${scenarioId}.pdf`);
  };

  const downloadExcel = () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([exportHeaders, ...exportRows]);
    sheet['!cols'] = [{ wch: 22 }, { wch: 22 }, { wch: 38 }, { wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 22 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(workbook, sheet, t('scenarios.moveReportMoves'));
    XLSX.writeFile(workbook, `raport_ruchow_scenariusz_${scenarioId}.xlsx`);
  };

  const renderYear = (row: ScenarioAllocationReportRow) => (
    <DotBranch key={`${row.sourceMachineId}-${row.targetMachineId}-${row.partId}-${row.year}-${row.volumeUnit}`}>
      <strong>{t('scenarios.moveReportYear')} {row.year}</strong>
      <span style={{ color: '#546e7a' }}> · {valueText(row)}</span>
    </DotBranch>
  );

  const machineTree = groupBy(rows, (row) => `${row.sourceMachineId}|${row.sourceMachineLabel}`)
    .sort((a, b) => a[1][0].sourceMachineLabel.localeCompare(b[1][0].sourceMachineLabel, locale))
    .map(([sourceKey, sourceRows]) => (
      <DotBranch key={sourceKey}>
        <strong>{t('scenarios.moveReportSource')}: {sourceRows[0].sourceMachineLabel}</strong>
        <div style={{ marginLeft: 16 }}>
          {groupBy(sourceRows, (row) => `${row.targetMachineId}|${row.targetMachineLabel}`).map(([targetKey, targetRows]) => (
            <DotBranch key={targetKey}>
              <strong>{t('scenarios.moveReportTarget')}: {targetRows[0].targetMachineLabel}</strong>
              <div style={{ marginLeft: 16 }}>
                {groupBy(targetRows, (row) => `${row.partId ?? 0}|${row.partLabel}`).map(([partKey, partRows]) => (
                  <DotBranch key={partKey}>
                    <span>{partRows[0].partLabel}</span>
                    <div style={{ marginLeft: 16 }}>{[...partRows].sort((a, b) => a.year - b.year).map(renderYear)}</div>
                  </DotBranch>
                ))}
              </div>
            </DotBranch>
          ))}
        </div>
      </DotBranch>
    ));

  const partTree = groupBy(rows, (row) => `${row.partId ?? 0}|${row.partLabel}`)
    .sort((a, b) => a[1][0].partLabel.localeCompare(b[1][0].partLabel, locale))
    .map(([partKey, partRows]) => (
      <DotBranch key={partKey}>
        <strong>{partRows[0].partLabel}</strong>
        <div style={{ marginLeft: 16 }}>
          {groupBy(partRows, (row) => `${row.sourceMachineId}|${row.sourceMachineLabel}`).map(([sourceKey, sourceRows]) => (
            <DotBranch key={sourceKey}>
              <span>{t('scenarios.moveReportSource')}: {sourceRows[0].sourceMachineLabel}</span>
              <div style={{ marginLeft: 16 }}>
                {groupBy(sourceRows, (row) => `${row.targetMachineId}|${row.targetMachineLabel}`).map(([targetKey, targetRows]) => (
                  <DotBranch key={targetKey}>
                    <strong>{t('scenarios.moveReportTarget')}: {targetRows[0].targetMachineLabel}</strong>
                    <div style={{ marginLeft: 16 }}>{[...targetRows].sort((a, b) => a.year - b.year).map(renderYear)}</div>
                  </DotBranch>
                ))}
              </div>
            </DotBranch>
          ))}
        </div>
      </DotBranch>
    ));

  return (
    <div>
      <p style={{ color: '#555', margin: '0 0 10px', fontSize: 13, lineHeight: 1.45 }}>{t('scenarios.moveReportIntro')}</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <label>
          <input type="radio" name="moveReportView" checked={view === 'machine'} onChange={() => setView('machine')} />{' '}
          {t('scenarios.moveReportMachines')}
        </label>
        <label>
          <input type="radio" name="moveReportView" checked={view === 'part'} onChange={() => setView('part')} />{' '}
          {t('scenarios.moveReportParts')}
        </label>
      </div>
      {loading ? <p style={{ margin: 0 }}>{t('common.loading')}</p> : null}
      {error ? <p style={{ color: 'var(--cap-red)', margin: 0 }}>{error}</p> : null}
      {!loading && !error && rows.length === 0 ? <p style={{ margin: 0 }}>{t('scenarios.moveReportEmpty')}</p> : null}
      {!loading && !error && rows.length > 0 ? (
        <>
        <div style={{ maxHeight: 'min(52vh, 480px)', overflow: 'auto', border: '1px solid #e0e0e0', borderRadius: 8, padding: '0.75rem 1rem' }}>
          {view === 'machine' ? machineTree : partTree}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={downloadPdf} style={{ padding: '0.4rem 0.75rem' }}>
            {t('scenarios.moveReportDownloadPdf')}
          </button>
          <button type="button" onClick={downloadExcel} style={{ padding: '0.4rem 0.75rem' }}>
            {t('scenarios.moveReportDownloadExcel')}
          </button>
        </div>
        </>
      ) : null}
    </div>
  );
}
