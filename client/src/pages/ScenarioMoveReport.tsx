import { useEffect, useState } from 'react';
import { api, type AllocationTreeNode } from '../api/client';
import { useI18n } from '../context/I18nContext';

type Report = { machines: AllocationTreeNode[]; parts: AllocationTreeNode[] };

function OutlineList({ nodes }: { nodes: AllocationTreeNode[] }) {
  if (!nodes.length) return null;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {nodes.map((node, index) => (
        <li key={`${node.title}-${index}`} style={{ marginTop: index === 0 ? 0 : 6 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
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
            <div style={{ minWidth: 0 }}>
              <span>{node.title}</span>
              {node.children.length > 0 ? (
                <div style={{ marginLeft: 4, marginTop: 4 }}>
                  <OutlineList nodes={node.children} />
                </div>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Raport ruchów w oknie Raport na kalkulatorze: wszystkie maszyny zwalniane albo wszystkie detale. */
export default function ScenarioMoveReport({ scenarioId }: { scenarioId: number }) {
  const { t } = useI18n();
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

  const nodes = view === 'machine' ? report?.machines ?? [] : report?.parts ?? [];

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
      {!loading && !error && nodes.length === 0 ? <p style={{ margin: 0 }}>{t('scenarios.moveReportEmpty')}</p> : null}
      {!loading && !error && nodes.length > 0 ? (
        <div style={{ maxHeight: 'min(52vh, 480px)', overflow: 'auto', border: '1px solid #e0e0e0', borderRadius: 8, padding: '0.75rem 1rem' }}>
          <OutlineList nodes={nodes} />
        </div>
      ) : null}
    </div>
  );
}
