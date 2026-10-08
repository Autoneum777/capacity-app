import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useI18n } from '../context/I18nContext';
import { confirmDelete } from '../confirmDelete';
import SortableTh from '../components/SortableTh';
import { useTableSort, sortRows } from '../utils/tableSort';

type ScenarioRow = {
  id: number;
  name: string;
  scenario_scope?: string;
  created_at: string;
  source_scenario_id?: number | null;
  source_scenario_name?: string | null;
  source_call_off_comparison_id?: number | null;
  source_call_off_name?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
  is_confidential?: boolean | number;
};

/** Jednakowa szerokość przycisków w kolumnie akcji (Aktywne i Archiwum). */
const scenarioRowActionStyle: CSSProperties = {
  display: 'inline-block',
  width: 122,
  minWidth: 122,
  maxWidth: 122,
  boxSizing: 'border-box',
  textAlign: 'center',
  padding: '0.35rem 0.35rem',
  borderRadius: 4,
  marginRight: 8,
  verticalAlign: 'middle',
  fontSize: 13,
};

export default function Scenarios() {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<'active' | 'archive'>('active');
  const [list, setList] = useState<ScenarioRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filterNazwa, setFilterNazwa] = useState('');
  const [filterUtworzono, setFilterUtworzono] = useState('');

  const load = () => {
    setLoading(true);
    setListError(null);
    return api.scenarios
      .list({ archived: viewMode === 'archive' })
      .then(setList)
      .catch((e) => setListError(e.message || t('scenarios.loadError')))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [viewMode]);

  const handleDelete = (id: number, name: string) => {
    if (!confirmDelete(`Czy na pewno usunąć scenariusz „${name}”? Tej operacji nie można cofnąć.`)) return;
    api.scenarios.delete(id).then(load);
  };

  const handleArchive = (id: number, name: string) => {
    if (!window.confirm(t('scenarios.archiveConfirm', { name }))) return;
    api.scenarios.archive(id).then(load).catch((e) => setListError(e?.message || t('scenarios.archiveError')));
  };

  const handleUnarchive = (id: number, name: string) => {
    if (!window.confirm(t('scenarios.unarchiveConfirm', { name }))) return;
    api.scenarios.unarchive(id).then(load).catch((e) => setListError(e?.message || t('scenarios.unarchiveError')));
  };

  const sourceLabel = (s: ScenarioRow) => {
    let base: string;
    if (s.source_scenario_id != null && s.source_scenario_id > 0) {
      base = s.source_scenario_name
        ? t('scenarios.sourceScenarioNamed', { name: s.source_scenario_name })
        : t('scenarios.sourceScenarioId', { id: s.source_scenario_id });
    } else {
      base = t('scenarios.sourceCurrentDb');
    }
    if (s.source_call_off_comparison_id != null && s.source_call_off_comparison_id > 0) {
      const suffix = s.source_call_off_name
        ? t('scenarios.sourceCallOffNamed', { name: s.source_call_off_name })
        : t('scenarios.sourceCallOffId', { id: s.source_call_off_comparison_id });
      return base + suffix;
    }
    return base;
  };

  type ScenarioSortCol = 'name' | 'scope' | 'source' | 'created' | 'archived';
  const { sortCol, sortDir, toggle } = useTableSort<ScenarioSortCol>('created', 'desc');

  const filteredList = useMemo(() => {
    const filtered = list.filter((s) => {
      if (filterNazwa.trim() && !s.name.toLowerCase().includes(filterNazwa.trim().toLowerCase())) return false;
      const createdStr = new Date(s.created_at).toLocaleString('pl-PL');
      if (filterUtworzono.trim() && !createdStr.includes(filterUtworzono.trim())) return false;
      return true;
    });
    return sortRows(filtered, sortCol, sortDir, (s, col) => {
      switch (col) {
        case 'name':
          return s.name;
        case 'scope':
          return String(s.scenario_scope ?? '');
        case 'source':
          return sourceLabel(s);
        case 'created':
          return new Date(s.created_at).getTime();
        case 'archived':
          return s.archived_at ? new Date(s.archived_at).getTime() : 0;
        default:
          return '';
      }
    });
  }, [list, filterNazwa, filterUtworzono, sortCol, sortDir]);

  if (loading && list.length === 0) return <p>{t('common.loading')}</p>;
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>{t('scenarios.title')}</h1>
      <p style={{ color: '#666', marginBottom: '1rem' }}>
        {t('scenarios.introLead1')} <strong>{t('scenarios.introBold1')}</strong> {t('scenarios.introMid1')}{' '}
        <strong>{t('scenarios.introBold2')}</strong> {t('scenarios.introMid2')}
      </p>
      {listError && (
        <p style={{ padding: '0.75rem', background: '#ffebee', color: '#c62828', borderRadius: 8, marginBottom: '1rem' }}>{listError}</p>
      )}
      <div style={{ marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #90caf9', background: '#fff' }}>
          <button
            type="button"
            onClick={() => setViewMode('active')}
            style={{
              padding: '0.45rem 1rem',
              border: 'none',
              cursor: 'pointer',
              background: viewMode === 'active' ? '#1565c0' : '#e3f2fd',
              color: viewMode === 'active' ? '#fff' : '#0d47a1',
              fontWeight: viewMode === 'active' ? 600 : 400,
            }}
          >
            {t('scenarios.active')}
          </button>
          <button
            type="button"
            onClick={() => setViewMode('archive')}
            style={{
              padding: '0.45rem 1rem',
              border: 'none',
              borderLeft: '1px solid #90caf9',
              cursor: 'pointer',
              background: viewMode === 'archive' ? '#1565c0' : '#e3f2fd',
              color: viewMode === 'archive' ? '#fff' : '#0d47a1',
              fontWeight: viewMode === 'archive' ? 600 : 400,
            }}
          >
            {t('scenarios.archive')}
          </button>
        </div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <SortableTh label={t('scenarios.name')} active={sortCol === 'name'} direction={sortDir} onClick={() => toggle('name')} />
            <SortableTh label={t('scenarios.scope')} active={sortCol === 'scope'} direction={sortDir} onClick={() => toggle('scope')} />
            <SortableTh label={t('scenarios.source')} active={sortCol === 'source'} direction={sortDir} onClick={() => toggle('source')} />
            <SortableTh label={t('scenarios.created')} active={sortCol === 'created'} direction={sortDir} onClick={() => toggle('created')} />
            {viewMode === 'archive' && (
              <SortableTh label={t('scenarios.archived')} active={sortCol === 'archived'} direction={sortDir} onClick={() => toggle('archived')} />
            )}
            <th style={{ padding: '0.75rem', textAlign: 'left' }}></th>
          </tr>
          <tr style={{ background: '#fafafa' }}>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('scenarios.name') })} value={filterNazwa} onChange={(e) => setFilterNazwa(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px' }} />
            <th style={{ padding: '4px 6px' }} />
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('scenarios.created') })} value={filterUtworzono} onChange={(e) => setFilterUtworzono(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            {viewMode === 'archive' && <th style={{ padding: '4px 6px' }} />}
            <th style={{ padding: '4px 6px' }} />
          </tr>
        </thead>
        <tbody>
          {filteredList.map((s) => (
            <tr key={s.id}>
              <td style={{ padding: '0.75rem' }}>
                {s.name}
                {Number(s.is_confidential) === 1 ? (
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: '#6a1b9a', background: '#f3e5f5', borderRadius: 4, padding: '1px 6px' }}>
                    confidential
                  </span>
                ) : null}
              </td>
              <td style={{ padding: '0.75rem', fontSize: 13, color: '#555', maxWidth: 320, verticalAlign: 'top' }}>
                {s.scenario_scope && s.scenario_scope.trim()
                  ? s.scenario_scope.trim().length > 140
                    ? `${s.scenario_scope.trim().slice(0, 140)}…`
                    : s.scenario_scope.trim()
                  : '—'}
              </td>
              <td style={{ padding: '0.75rem', fontSize: 14, color: '#444' }}>{sourceLabel(s)}</td>
              <td style={{ padding: '0.75rem' }}>{new Date(s.created_at).toLocaleString('pl-PL')}</td>
              {viewMode === 'archive' && (
                <td style={{ padding: '0.75rem', fontSize: 13, color: '#555' }}>
                  {s.archived_at ? new Date(s.archived_at).toLocaleString('pl-PL') : '—'}
                </td>
              )}
              <td style={{ padding: '0.75rem', whiteSpace: 'nowrap' }}>
                <Link
                  to={`/scenariusze/${s.id}/edycja`}
                  style={{ ...scenarioRowActionStyle, background: '#455a64', color: 'white', textDecoration: 'none' }}
                >
                  {t('scenarios.editBtn')}
                </Link>
                <Link
                  to={`/scenariusze/${s.id}`}
                  style={{ ...scenarioRowActionStyle, background: '#2196f3', color: 'white', textDecoration: 'none' }}
                >
                  {t('scenarios.previewBtn')}
                </Link>
                {viewMode === 'active' ? (
                  <button
                    type="button"
                    onClick={() => handleArchive(s.id, s.name)}
                    style={{ ...scenarioRowActionStyle, background: '#6d4c41', color: 'white', border: 'none', cursor: 'pointer' }}
                  >
                    {t('scenarios.archiveBtn')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleUnarchive(s.id, s.name)}
                    style={{ ...scenarioRowActionStyle, background: '#00897b', color: 'white', border: 'none', cursor: 'pointer' }}
                  >
                    {t('scenarios.restoreBtn')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(s.id, s.name)}
                  style={{ ...scenarioRowActionStyle, marginRight: 0, background: '#c62828', color: 'white', border: 'none', cursor: 'pointer' }}
                >
                  {t('common.delete')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {filteredList.length === 0 && !loading && (
        <p style={{ color: '#666' }}>
          {list.length === 0
            ? viewMode === 'archive'
              ? t('scenarios.emptyArchived')
              : t('scenarios.emptyActive')
            : t('scenarios.emptyFilter')}
        </p>
      )}

    </div>
  );
}
