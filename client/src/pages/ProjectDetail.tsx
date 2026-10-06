import { Fragment, forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { confirmDelete } from '../confirmDelete';
import SearchableSelect from '../components/SearchableSelect';
import ProjectActivateRfqMachinesModal from '../components/ProjectActivateRfqMachinesModal';
import { machineStatusFromDb } from '../utils/machineStatusStyle';
import { formatDetailSapAliasLabel, formatSapNumberForDisplay } from '../utils/detailLabel';
import { formatMachineSapInternalLabel, machineSelectFilterText } from '../utils/machineLabel';
import { useReferenceDisplay } from '../context/ReferenceDisplayContext';
import { useI18n } from '../context/I18nContext';
import { useAuth } from '../context/AuthContext';
import { translateHistoryNote } from '../i18n/historyNotes';
import SortableTh from '../components/SortableTh';
import { useTableSort, sortRows } from '../utils/tableSort';
import { parseYearValuePaste } from '../utils/parseYearValueTable';
import { formatSopEop, sopEopYearsRange } from '../utils/sopEopFormat';
import { normalizeClientName } from '../utils/clientName';
import { isDesignationDuplicateError } from '../utils/designationDuplicate';
import { canDownloadProjectAttachments, canEditProjectContent } from '../utils/projectPermissions';
import {
  partHasPositiveVolumeInSopEopRange,
  sopEopYearsLabel,
  type ProjectVolumeContext,
} from '../utils/partEffectiveVolume';

/** Krótka etykieta projektu (klient + nazwa) do nagłówków zakładek. */
function projectContextSubtitle(project: { id?: number; client?: string; name?: string } | null | undefined): string {
  if (!project) return '';
  const client = String(project.client ?? '').trim();
  const name = String(project.name ?? '').trim();
  if (client && name) return `${client} · ${name}`;
  if (name) return name;
  if (client) return client;
  return project.id != null ? `#${project.id}` : '';
}

const ZeroClearNumberInput = forwardRef(function ZeroClearNumberInput({
  value,
  onChange,
  onBlur,
  style,
  ...rest
}: {
  value: number;
  onChange: (n: number) => void;
  onBlur?: () => void;
  style?: React.CSSProperties;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'type' | 'style'>, ref: React.Ref<HTMLInputElement>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <input
      ref={ref}
      type="number"
      min={0}
      {...rest}
      style={style}
      value={editing ? draft : value}
      onFocus={() => {
        setEditing(true);
        setDraft(value === 0 ? '' : String(value));
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const num = draft === '' || Number.isNaN(Number(draft)) ? 0 : Math.max(0, Number(draft));
        onChange(num);
        setEditing(false);
        queueMicrotask(() => onBlur?.());
      }}
    />
  );
});

export default function ProjectDetail() {
  const { t } = useI18n();
  const location = useLocation();
  const { id } = useParams();
  const scenarioIdFromSearch = useMemo(() => {
    const q = new URLSearchParams(location.search).get('scenarioId');
    const n = q != null ? Number(q) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [location.search]);
  const rfqActivateGuardEnabled = scenarioIdFromSearch == null;
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'opis' | 'operacje' | 'notatki' | 'zalaczniki' | 'wolumeny'>('opis');
  const [phases, setPhases] = useState<any[]>([]);
  const [opModal, setOpModal] = useState<{ open: boolean; edit?: any }>({ open: false });

  const load = () => (id ? api.projects.get(Number(id)).then(setProject) : Promise.resolve());
  useEffect(() => {
    if (!id) return;
    load().finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    api.settings.phases.list().then(setPhases);
  }, []);

  if (loading || !project) return <p>{t('projectDetail.loading')}</p>;

  const tabs = [
    { id: 'opis' as const, label: t('projectDetail.tabDescription') },
    { id: 'wolumeny' as const, label: t('projectDetail.tabVolumes') },
    { id: 'operacje' as const, label: t('projectDetail.tabOperations') },
    { id: 'notatki' as const, label: t('projectDetail.tabNotes') },
    { id: 'zalaczniki' as const, label: t('projectDetail.tabAttachments') },
  ];

  return (
    <div className="project-detail-layout">
      <div className="project-detail-nav">
        <div style={{ marginBottom: '1rem' }}>
          <Link to={`/projekty${location.search}`} style={{ color: 'var(--cap-green)', fontSize: 14 }}>
            {t('projectDetail.back')}
          </Link>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tabs.map((tabItem) => (
            <button
              key={tabItem.id}
              onClick={() => setTab(tabItem.id)}
              style={{
                padding: '0.4rem 0.5rem',
                textAlign: 'left',
                fontSize: 13,
                background: tab === tabItem.id ? 'var(--cap-green)' : '#eee',
                color: tab === tabItem.id ? 'white' : '#333',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              {tabItem.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="project-detail-content">
        {tab === 'opis' && (
          <ProjectDescTab
            project={project}
            onUpdate={load}
            onGoToVolumes={() => setTab('wolumeny')}
            navigationSearch={location.search}
            rfqActivateGuardEnabled={rfqActivateGuardEnabled}
          />
        )}
        {tab === 'wolumeny' && (
          <VolumesTab key={`vol-${project.id}-${project.eop ?? ''}`} project={project} onUpdate={load} />
        )}
        {tab === 'operacje' && (
          <ProjectOperationsTab
            project={project}
            onReload={load}
            onEdit={(op) => setOpModal({ open: true, edit: op })}
            onNew={() => setOpModal({ open: true })}
          />
        )}
        {tab === 'notatki' && (
          <div style={{ background: 'white', padding: '1.5rem', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginTop: 0 }}>
              {t('projectDetailExtra.notesTitle')}
              <span style={{ display: 'block', fontSize: '1rem', fontWeight: 600, color: 'var(--cap-gray)', marginTop: '0.35rem' }}>{projectContextSubtitle(project)}</span>
            </h2>
            <AddNoteForm projectId={project.id} onAdded={load} />
            <ProjectNotesTable projectId={project.id} notes={project.notes ?? []} onChanged={load} />
          </div>
        )}
        {tab === 'zalaczniki' && (
          <ProjectAttachmentsTab project={project} onChanged={load} />
        )}
      </div>
      {opModal.open && (
        <OperationModal
          key={opModal.edit?.id != null ? `op-${opModal.edit.id}` : 'op-new'}
          projectId={project.id}
          parts={project.parts ?? []}
          phases={phases}
          projectVolumeContext={{
            sop: project.sop,
            eop: project.eop,
            project_volumes: project.project_volumes ?? [],
          }}
          edit={opModal.edit}
          onClose={() => setOpModal({ open: false })}
          onSaved={() => { setOpModal({ open: false }); load(); }}
        />
      )}
    </div>
  );
}

function opMatchesSearch(op: any, q: string): boolean {
  if (!q.trim()) return true;
  const s = q.trim().toLowerCase();
  const hay = [
    op.machine_sap_number,
    op.machine_number,
    op.machine_type,
    op.part_designation,
    op.phase_name,
    op.cycle_time_seconds,
    op.volume_value,
    op.volume_unit,
  ]
    .map((x) => String(x ?? '').toLowerCase())
    .join(' ');
  return hay.includes(s);
}

/** Etykieta liczby podziałów z alokacji (1 podział / 2 podziały / 5 podziałów). */
function podzialyZAlokacjiLabel(n: number, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (n === 1) return t('projectDetailExtra.splitOne');
  const mod100 = n % 100;
  if (mod100 >= 12 && mod100 <= 14) return t('projectDetailExtra.splitManyAlt', { n });
  const mod10 = n % 10;
  if (mod10 >= 2 && mod10 <= 4) return t('projectDetailExtra.splitMany', { n });
  return t('projectDetailExtra.splitManyAlt', { n });
}

function groupOperationsForDisplay(operations: any[]): {
  roots: any[];
  childrenByParent: Map<number, any[]>;
} {
  const ops = operations ?? [];
  const byId = new Map<number, any>(ops.map((o: any) => [o.id, o]));
  const roots = ops.filter((o: any) => {
    const sid = o.split_from_operation_id;
    return sid == null || !byId.has(sid);
  });

  const topRootByOpId = new Map<number, number>();
  const resolveTopRootId = (op: any): number => {
    const cached = topRootByOpId.get(op.id);
    if (cached != null) return cached;
    let current = op;
    const visited = new Set<number>();
    while (current?.split_from_operation_id != null && byId.has(current.split_from_operation_id) && !visited.has(current.id)) {
      visited.add(current.id);
      current = byId.get(current.split_from_operation_id);
    }
    const rootId = Number(current?.id ?? op.id);
    topRootByOpId.set(op.id, rootId);
    return rootId;
  };

  const childrenByParent = new Map<number, any[]>();
  roots.forEach((r: any) => childrenByParent.set(r.id, []));
  for (const o of ops) {
    const rootId = resolveTopRootId(o);
    if (o.id === rootId) continue;
    if (!childrenByParent.has(rootId)) childrenByParent.set(rootId, []);
    childrenByParent.get(rootId)!.push(o);
  }
  return { roots, childrenByParent };
}

type OperationSortColumn = 'machine' | 'detail' | 'phase' | 'cycle' | 'volume';
type OperationSortDirection = 'asc' | 'desc';

function operationDisplayedCycle(op: any): number {
  const altCycle = Number(op?.alt_cycle_time_seconds);
  const hasAltCycle = Number.isFinite(altCycle) && altCycle > 0;
  const useAlternative =
    (op?.use_alternative_in_calculator === 1 || op?.use_alternative_in_calculator === true) && hasAltCycle;
  const baseCycle = Number(op?.cycle_time_seconds);
  const displayed = useAlternative ? altCycle : baseCycle;
  return Number.isFinite(displayed) ? displayed : 0;
}

function operationVolumeSortKey(op: any): number {
  if (Number(op?.volume_value) === 0) return -1;
  return Number(op?.volume_value) || 0;
}

function compareOperationsForSort(
  a: any,
  b: any,
  col: OperationSortColumn,
  dir: OperationSortDirection,
  keys: { machine: (op: any) => string; detail: (op: any) => string }
): number {
  const mul = dir === 'asc' ? 1 : -1;
  switch (col) {
    case 'machine':
      return mul * keys.machine(a).localeCompare(keys.machine(b), 'pl', { numeric: true, sensitivity: 'base' });
    case 'detail':
      return mul * keys.detail(a).localeCompare(keys.detail(b), 'pl', { numeric: true, sensitivity: 'base' });
    case 'phase':
      return mul * String(a.phase_name ?? '').localeCompare(String(b.phase_name ?? ''), 'pl', {
        numeric: true,
        sensitivity: 'base',
      });
    case 'cycle':
      return mul * (operationDisplayedCycle(a) - operationDisplayedCycle(b));
    case 'volume': {
      const diff = operationVolumeSortKey(a) - operationVolumeSortKey(b);
      if (diff !== 0) return mul * diff;
      return mul * String(a.volume_unit ?? '').localeCompare(String(b.volume_unit ?? ''), 'pl', { sensitivity: 'base' });
    }
    default:
      return 0;
  }
}

function noteAuthorsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function isManualNote(note: { note_type?: string | null }): boolean {
  return String(note.note_type ?? 'manual') !== 'auto';
}

function ProjectNotesTable({ projectId, notes, onChanged }: { projectId: number; notes: any[]; onChanged: () => void }) {
  const { t, te, locale } = useI18n();
  type NoteSortCol = 'date' | 'type' | 'author' | 'note';
  const { sortCol, sortDir, toggle } = useTableSort<NoteSortCol>('date', 'desc');
  const [currentActor, setCurrentActor] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);

  useEffect(() => {
    api.projects.getSessionActor().then((r) => setCurrentActor(r.login ?? '')).catch(() => setCurrentActor(''));
  }, []);

  const canManageNote = (n: any) => isManualNote(n) && noteAuthorsMatch(n.author, currentActor);

  const startEdit = (n: any) => {
    setEditingId(Number(n.id));
    setEditText(String(n.note ?? ''));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const saveEdit = (noteId: number) => {
    const text = editText.trim();
    if (!text) return;
    setSavingId(noteId);
    api.projects
      .updateNote(projectId, noteId, { note: text })
      .then(() => {
        cancelEdit();
        onChanged();
      })
      .catch((e: Error) => window.alert(te(e?.message) || t('common.error')))
      .finally(() => setSavingId(null));
  };

  const removeNote = (n: any) => {
    if (!confirmDelete(t('projectDetailExtra.noteDeleteConfirm'))) return;
    setSavingId(Number(n.id));
    api.projects
      .deleteNote(projectId, Number(n.id))
      .then(() => onChanged())
      .catch((e: Error) => window.alert(te(e?.message) || t('common.error')))
      .finally(() => setSavingId(null));
  };

  const sorted = useMemo(
    () =>
      sortRows(notes, sortCol, sortDir, (n, col) => {
        switch (col) {
          case 'date':
            return String(n.note_date ?? '');
          case 'type':
            return n.note_type === 'auto' ? t('projectDetailExtra.noteAuto') : t('projectDetailExtra.noteManual');
          case 'author':
            return String(n.author ?? '');
          case 'note':
            return translateHistoryNote(locale, String(n.note ?? ''));
          default:
            return '';
        }
      }),
    [notes, sortCol, sortDir, locale, t]
  );
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: '#f5f5f5' }}>
          <SortableTh label={t('history.date')} active={sortCol === 'date'} direction={sortDir} onClick={() => toggle('date')} />
          <SortableTh label={t('history.type')} active={sortCol === 'type'} direction={sortDir} onClick={() => toggle('type')} />
          <SortableTh label={t('history.author')} active={sortCol === 'author'} direction={sortDir} onClick={() => toggle('author')} />
          <SortableTh label={t('projectDetailExtra.notePlaceholder')} active={sortCol === 'note'} direction={sortDir} onClick={() => toggle('note')} />
          <th style={{ padding: '0.75rem', width: 140, textAlign: 'left' }}>{t('projectDetailExtra.noteActionsCol')}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((n: any) => {
          const editing = editingId === Number(n.id);
          const busy = savingId === Number(n.id);
          const manageable = canManageNote(n);
          return (
            <tr key={n.id}>
              <td style={{ padding: '0.75rem', verticalAlign: 'top' }}>{n.note_date}</td>
              <td style={{ padding: '0.75rem', verticalAlign: 'top' }}>{n.note_type === 'auto' ? t('projectDetailExtra.noteAuto') : t('projectDetailExtra.noteManual')}</td>
              <td style={{ padding: '0.75rem', verticalAlign: 'top' }}>{n.author || '-'}</td>
              <td style={{ padding: '0.75rem', verticalAlign: 'top' }}>
                {editing ? (
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={3}
                    style={{ width: '100%', padding: '0.35rem', font: 'inherit', resize: 'vertical' }}
                    disabled={busy}
                  />
                ) : (
                  translateHistoryNote(locale, String(n.note ?? ''))
                )}
              </td>
              <td style={{ padding: '0.75rem', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                {manageable && !editing && (
                  <>
                    <button
                      type="button"
                      onClick={() => startEdit(n)}
                      disabled={busy || editingId != null}
                      style={{ marginRight: 6, padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: '1px solid #bdbdbd', background: '#fff', cursor: busy || editingId != null ? 'default' : 'pointer' }}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeNote(n)}
                      disabled={busy || editingId != null}
                      style={{ padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: '1px solid #e57373', background: '#fff', color: '#c62828', cursor: busy || editingId != null ? 'default' : 'pointer' }}
                    >
                      {t('common.delete')}
                    </button>
                  </>
                )}
                {manageable && editing && (
                  <>
                    <button
                      type="button"
                      onClick={() => saveEdit(Number(n.id))}
                      disabled={busy || !editText.trim()}
                      style={{ marginRight: 6, padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: 'none', background: '#2196f3', color: '#fff', cursor: busy || !editText.trim() ? 'default' : 'pointer' }}
                    >
                      {busy ? t('common.saving') : t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={busy}
                      style={{ padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: '1px solid #bdbdbd', background: '#fff', cursor: busy ? 'default' : 'pointer' }}
                    >
                      {t('common.cancel')}
                    </button>
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ProjectOperationsTab({
  project,
  onReload,
  onEdit,
  onNew,
}: {
  project: any;
  onReload: () => void;
  onEdit: (op: any) => void;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const { referenceDisplay, machineDisplay } = useReferenceDisplay();
  const [opSearch, setOpSearch] = useState('');
  const [heirPick, setHeirPick] = useState<{
    opId: number;
    candidates: { operationId: number; machineId: number; machineLabel: string }[];
  } | null>(null);
  const formatMachineLabel = (op: any): string =>
    formatMachineSapInternalLabel(
      { sap_number: op?.machine_sap_number, internal_number: op?.machine_number },
      machineDisplay
    );
  const formatPartLabel = (part: any): string =>
    formatDetailSapAliasLabel(
      {
        sap_number: part?.detail_sap_number ?? part?.detail?.sap_number,
        alias: part?.detail_alias ?? part?.detail?.alias,
        free_text: part?.detail_free_text ?? part?.detail?.free_text,
        designation: part?.designation,
        id: part?.id,
      },
      referenceDisplay
    );
  const partLabelById = useMemo(() => {
    const map = new Map<number, string>();
    for (const part of project.parts ?? []) {
      map.set(Number(part.id), formatPartLabel(part));
    }
    return map;
  }, [project.parts, referenceDisplay]);
  const partById = useMemo(() => {
    const map = new Map<number, any>();
    for (const part of project.parts ?? []) {
      map.set(Number(part.id), part);
    }
    return map;
  }, [project.parts]);
  const projectVolumeContext = useMemo<ProjectVolumeContext>(
    () => ({
      sop: project.sop,
      eop: project.eop,
      project_volumes: project.project_volumes ?? [],
    }),
    [project.sop, project.eop, project.project_volumes]
  );
  const detailLabelForOperation = (op: any): string => {
    if (op?.is_set) return String(op.part_designation ?? 'Set');
    const fromPart = partLabelById.get(Number(op?.part_id));
    return fromPart || String(op?.part_designation ?? '—');
  };
  const { sortCol: opSortCol, sortDir: opSortDir, toggle: toggleOpSort } = useTableSort<OperationSortColumn>('machine');
  const sortKeys = useMemo(
    () => ({
      machine: (op: any) => `${formatMachineLabel(op)} (${op.machine_type ?? ''})`.trim(),
      detail: (op: any) => detailLabelForOperation(op),
    }),
    [referenceDisplay, partLabelById]
  );

  const { roots, childrenByParent } = useMemo(() => {
    const grouped = groupOperationsForDisplay(project.operations ?? []);
    const cmp = (a: any, b: any) => compareOperationsForSort(a, b, opSortCol, opSortDir, sortKeys);
    const sortedRoots = [...grouped.roots].sort(cmp);
    const sortedChildren = new Map<number, any[]>();
    for (const [pid, kids] of grouped.childrenByParent) {
      sortedChildren.set(pid, [...kids].sort(cmp));
    }
    return { roots: sortedRoots, childrenByParent: sortedChildren };
  }, [project.operations, opSortCol, opSortDir, sortKeys]);

  const [expandedParents, setExpandedParents] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    setExpandedParents(new Set());
  }, [project.id]);

  const toggleParent = (id: number) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const q = opSearch;
  const visibleRoots = roots.filter((root) => {
    const kids = childrenByParent.get(root.id) ?? [];
    if (opMatchesSearch(root, q)) return true;
    return kids.some((c) => opMatchesSearch(c, q));
  });

  const volUnitLabel = (u: string) =>
    u === 'annual' ? t('common.unitAnnual') : u === 'monthly' ? t('common.unitMonthly') : u === 'weekly' ? t('common.unitWeekly') : u;
  const formatOpVolumeFallback = (op: any) =>
    op.volume_value === 0 ? `0 (${volUnitLabel(op.volume_unit ?? 'annual')})` : `${op.volume_value} (${volUnitLabel(op.volume_unit)})`;
  const setVolumeSourceWarningTitle = (op: any): string | null => {
    if (!op?.is_set || op.part_id == null) return null;
    const part = partById.get(Number(op.part_id));
    if (!part || partHasPositiveVolumeInSopEopRange(part, projectVolumeContext)) return null;
    return t('projectDetailExtra.setVolumeSourceNoVolume', {
      part: partLabelById.get(Number(op.part_id)) ?? String(op.part_id),
      years: sopEopYearsLabel(projectVolumeContext),
      opVolume: formatOpVolumeFallback(op),
    });
  };
  const volumeCell = (op: any) => {
    const warnTitle = setVolumeSourceWarningTitle(op);
    return (
      <>
        {op.volume_value === 0 ? t('projectDetailExtra.volumeFromPart') : `${op.volume_value} (${volUnitLabel(op.volume_unit)})`}
        {warnTitle && (
          <span
            style={{ marginLeft: 6, fontSize: 11, color: '#e65100', fontWeight: 700, cursor: 'help' }}
            title={warnTitle}
            aria-label={t('projectDetailExtra.setVolumeSourceNoVolumeShort')}
          >
            ⚠
          </span>
        )}
      </>
    );
  };
  const cycleCell = (op: any) => {
    const baseCycle = Number(op?.cycle_time_seconds);
    const altCycle = Number(op?.alt_cycle_time_seconds);
    const hasAltCycle = Number.isFinite(altCycle) && altCycle > 0;
    const useAlternative = (op?.use_alternative_in_calculator === 1 || op?.use_alternative_in_calculator === true) && hasAltCycle;
    const displayedCycle = useAlternative ? altCycle : baseCycle;
    const cycleText = Number.isFinite(displayedCycle) ? String(displayedCycle) : '—';
    if (!useAlternative) return cycleText;
    return (
      <>
        {cycleText}
        <span style={{ marginLeft: 6, fontSize: 11, color: '#ef6c00', fontWeight: 700 }} title={t('projectDetailExtra.altInCalculatorTitle')}>
          (alt)
        </span>
      </>
    );
  };
  const allocationYearsLabel = (op: any): string | null => {
    if (!op?.split_from_operation_id) return null;
    const years = (Array.isArray(op.volume_by_year) ? op.volume_by_year : [])
      .filter((r: any) => Number(r?.volume_value) > 0)
      .map((r: any) => Number(r?.year))
      .filter((y: number) => Number.isInteger(y))
      .sort((a: number, b: number) => a - b);
    if (years.length === 0) return null;
    if (years.length === 1) return t('projectDetailExtra.allocYearOne', { year: years[0] });
    return t('projectDetailExtra.allocYearsMany', { list: years.join(', ') });
  };

  /** Wiersz rodzica zaczyna tekst po chevronie (~36px); dzieci mają wyraźnie większe wcięcie niż ta linia bazowa. */
  const childFirstColPaddingLeft = 'calc(0.75rem + 2.75rem + 1.25rem)';

  const removeOperation = (opId: number, heirOperationId?: number) => {
    api.projects
      .deleteOperation(project.id, opId, heirOperationId)
      .then((result) => {
        if (result?.message) window.alert(result.message);
        onReload();
      })
      .catch((e: Error & { code?: string; candidates?: { operationId: number; machineId: number; machineLabel: string }[] }) => {
        if (e?.code === 'choose_heir' && e.candidates?.length) {
          const unique = new Map<number, { operationId: number; machineId: number; machineLabel: string }>();
          for (const candidate of e.candidates) {
            if (!unique.has(candidate.machineId)) unique.set(candidate.machineId, candidate);
          }
          setHeirPick({ opId, candidates: [...unique.values()] });
          return;
        }
        window.alert(e?.message || 'Nie udało się usunąć operacji.');
      });
  };

  const renderRow = (op: any, opts: { isChild: boolean }) => {
    const { isChild } = opts;
    const allocationYears = allocationYearsLabel(op);
    return (
      <tr key={op.id} style={{ background: isChild ? '#f8fafc' : undefined }}>
        <td
          style={{
            padding: '0.75rem',
            paddingLeft: isChild ? childFirstColPaddingLeft : '0.75rem',
            verticalAlign: 'middle',
          }}
        >
          {formatMachineLabel(op)} ({op.machine_type})
          {isChild && (
            <span style={{ marginLeft: 8, fontSize: 11, color: '#1565c0', fontWeight: 600 }}>
              {allocationYears
                ? t('projectDetailExtra.allocBadgeWithYears', { years: allocationYears })
                : t('projectDetailExtra.allocBadge')}
            </span>
          )}
        </td>
        <td style={{ padding: '0.75rem' }}>{detailLabelForOperation(op)}</td>
        <td style={{ padding: '0.75rem' }}>{op.phase_name}</td>
        <td style={{ padding: '0.75rem' }}>{cycleCell(op)}</td>
        <td style={{ padding: '0.75rem' }}>{volumeCell(op)}</td>
        <td style={{ padding: '0.75rem' }}>
          <button
            type="button"
            onClick={() => onEdit(op)}
            style={{ marginRight: 4, padding: '0.25rem 0.5rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {t('common.edit')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirmDelete(t('projectDetailExtra.deleteOpConfirm'))) return;
              removeOperation(op.id);
            }}
            style={{ padding: '0.25rem 0.5rem', background: '#c62828', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {t('common.delete')}
          </button>
        </td>
      </tr>
    );
  };

  return (
    <div style={{ background: 'white', padding: '1.5rem', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
      <h2 style={{ marginTop: 0 }}>
        {t('projectDetailExtra.operationsTitle')}
        <span style={{ display: 'block', fontSize: '1rem', fontWeight: 600, color: 'var(--cap-gray)', marginTop: '0.35rem' }}>{projectContextSubtitle(project)}</span>
      </h2>
      <p style={{ margin: '0 0 0.75rem', fontSize: 13, color: '#555' }}>
        {t('projectDetailExtra.allocOpsIntro')}
      </p>
      <input
        type="text"
        placeholder={t('projectDetailExtra.searchOpsPlaceholder')}
        value={opSearch}
        onChange={(e) => setOpSearch(e.target.value)}
        style={{ marginBottom: '1rem', padding: '0.5rem', width: 280 }}
      />
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <SortableTh label={t('projectDetailExtra.machineCol')} active={opSortCol === 'machine'} direction={opSortDir} onClick={() => toggleOpSort('machine')} title={t('projectDetailExtra.sortByMachine')} />
            <SortableTh label={t('projectDetailExtra.detailCol')} active={opSortCol === 'detail'} direction={opSortDir} onClick={() => toggleOpSort('detail')} title={t('projectDetailExtra.sortByDetail')} />
            <SortableTh label={t('projectDetailExtra.phaseCol')} active={opSortCol === 'phase'} direction={opSortDir} onClick={() => toggleOpSort('phase')} title={t('projectDetailExtra.sortByPhase')} />
            <SortableTh label={t('projectDetailExtra.cycleCol')} active={opSortCol === 'cycle'} direction={opSortDir} onClick={() => toggleOpSort('cycle')} title={t('projectDetailExtra.sortByCycle')} />
            <SortableTh label={t('projectDetailExtra.volumeCol')} active={opSortCol === 'volume'} direction={opSortDir} onClick={() => toggleOpSort('volume')} title={t('projectDetailExtra.sortByVolume')} />
            <th style={{ padding: '0.75rem', textAlign: 'left' }}></th>
          </tr>
        </thead>
        <tbody>
          {visibleRoots.map((root) => {
            const children = childrenByParent.get(root.id) ?? [];
            const hasChildren = children.length > 0;
            const expanded = expandedParents.has(root.id);
            const rootMatches = opMatchesSearch(root, q);
            const visibleChildren = expanded
              ? rootMatches
                ? children
                : children.filter((c) => opMatchesSearch(c, q))
              : [];
            return (
              <Fragment key={root.id}>
                <tr style={{ background: hasChildren ? '#f1f8e9' : undefined }}>
                  <td style={{ padding: '0.75rem', verticalAlign: 'middle' }}>
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={() => toggleParent(root.id)}
                        aria-expanded={expanded}
                        title={expanded ? t('projectDetailExtra.collapseAllocOps') : t('projectDetailExtra.expandAllocOps')}
                        style={{
                          marginRight: 8,
                          width: 28,
                          height: 28,
                          padding: 0,
                          border: '1px solid #c5e1a5',
                          borderRadius: 4,
                          background: '#fff',
                          cursor: 'pointer',
                          fontSize: 14,
                          lineHeight: 1,
                          verticalAlign: 'middle',
                        }}
                      >
                        {expanded ? '▼' : '▶'}
                      </button>
                    ) : (
                      <span style={{ display: 'inline-block', width: 36 }} />
                    )}
                    <span style={{ fontWeight: hasChildren ? 600 : undefined }}>
                      {formatMachineLabel(root)} ({root.machine_type})
                    </span>
                    {hasChildren && (
                      <span
                        style={{
                          marginLeft: 10,
                          fontSize: 11,
                          fontWeight: 700,
                          color: '#2e7d32',
                          background: '#e8f5e9',
                          padding: '2px 8px',
                          borderRadius: 10,
                          verticalAlign: 'middle',
                        }}
                        title={t('projectDetailExtra.allocSplitsTitle')}
                      >
                        {podzialyZAlokacjiLabel(children.length, t)}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.75rem' }}>{detailLabelForOperation(root)}</td>
                  <td style={{ padding: '0.75rem' }}>{root.phase_name}</td>
                  <td style={{ padding: '0.75rem' }}>{cycleCell(root)}</td>
                  <td style={{ padding: '0.75rem' }}>{volumeCell(root)}</td>
                  <td style={{ padding: '0.75rem' }}>
                    <button
                      type="button"
                      onClick={() => onEdit(root)}
                      style={{ marginRight: 4, padding: '0.25rem 0.5rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirmDelete(t('projectDetailExtra.deleteOpConfirm'))) return;
                        removeOperation(root.id);
                      }}
                      style={{ padding: '0.25rem 0.5rem', background: '#c62828', color: 'white', border: 'none', borderRadius: 4 }}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
                {visibleChildren.map((child) => renderRow(child, { isChild: true }))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <button type="button" onClick={onNew} style={{ marginTop: 8, padding: '0.5rem 1rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}>
        {t('projectDetailExtra.newOperation')}
      </button>
      {heirPick && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 40,
            padding: 16,
          }}
        >
          <div style={{ background: 'white', borderRadius: 8, padding: '1.25rem', width: 'min(420px, 100%)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 0.5rem' }}>Wybierz maszynę docelową</h3>
            <p style={{ margin: '0 0 1rem', color: '#444', fontSize: 14 }}>
              Wolumen nie może wrócić na nieaktywną ani usuwaną maszynę. Wybierz aktywną maszynę, która ma go przejąć.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {heirPick.candidates.map((candidate) => (
                <button
                  key={candidate.machineId}
                  type="button"
                  onClick={() => {
                    const opId = heirPick.opId;
                    const heirOperationId = candidate.operationId;
                    setHeirPick(null);
                    removeOperation(opId, heirOperationId);
                  }}
                  style={{
                    textAlign: 'left',
                    padding: '0.65rem 0.8rem',
                    border: '1px solid #c5e1a5',
                    borderRadius: 6,
                    background: '#f1f8e9',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {candidate.machineLabel}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setHeirPick(null)}
              style={{ marginTop: 14, padding: '0.45rem 0.8rem', border: '1px solid #bdbdbd', borderRadius: 4, background: 'white', cursor: 'pointer' }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectDescTab({
  project,
  onUpdate,
  onGoToVolumes,
  navigationSearch,
  rfqActivateGuardEnabled,
}: {
  project: any;
  onUpdate: () => void;
  onGoToVolumes?: () => void;
  navigationSearch: string;
  /** false w podglądzie scenariusza (?scenarioId=) — bez modala RFQ przy aktywacji */
  rfqActivateGuardEnabled: boolean;
}) {
  const { t, te } = useI18n();
  const [editing, setEditing] = useState(false);
  const [eopExtension, setEopExtension] = useState('');
  const [saving, setSaving] = useState(false);
  const [showCheckVolumes, setShowCheckVolumes] = useState(false);
  const [editClient, setEditClient] = useState(normalizeClientName(project.client ?? ''));
  const [editName, setEditName] = useState(project.name ?? '');
  const [editSop, setEditSop] = useState(formatSopEop(project.sop));
  const [editEop, setEditEop] = useState(formatSopEop(project.eop));
  const [savingDesc, setSavingDesc] = useState(false);
  const [rfqActivateOpen, setRfqActivateOpen] = useState(false);
  const [projectActivateSaving, setProjectActivateSaving] = useState(false);

  useEffect(() => {
    setEditClient(normalizeClientName(project.client ?? ''));
    setEditName(project.name ?? '');
    setEditSop(formatSopEop(project.sop));
    setEditEop(formatSopEop(project.eop));
  }, [project.id, project.client, project.name, project.sop, project.eop]);

  const saveDescription = () => {
    const client = normalizeClientName(editClient);
    const name = editName.trim();
    if (!client || !name) return;
    setSavingDesc(true);
    api.projects.update(project.id, { client, name, sop: editSop.trim() || undefined, eop: editEop.trim() || undefined })
      .then(() => { onUpdate(); setEditing(false); })
      .finally(() => setSavingDesc(false));
  };

  const saveEopExtension = () => {
    const value = eopExtension.trim();
    if (!value) return;
    setSaving(true);
    setShowCheckVolumes(false);
    api.projects.update(project.id, { eop_extension: value })
      .then(() => { setEopExtension(''); onUpdate(); setShowCheckVolumes(true); })
      .finally(() => setSaving(false));
  };

  const applyProjectStatus = (newStatus: 'active' | 'inactive' | 'RFQ') => {
    api.projects.update(project.id, { status: newStatus }).then(onUpdate);
  };

  const onStatusSelectChange = (newStatus: 'active' | 'inactive' | 'RFQ') => {
    if (rfqActivateGuardEnabled && newStatus === 'active' && project.status !== 'active') {
      const ops = project.operations ?? [];
      const hasRfqMachine = ops.some((op: any) => machineStatusFromDb(op?.machine_status) === 'RFQ');
      if (hasRfqMachine) {
        setRfqActivateOpen(true);
        return;
      }
    }
    applyProjectStatus(newStatus);
  };

  const confirmActivateProjectAfterRfq = () => {
    setProjectActivateSaving(true);
    api.projects
      .update(project.id, { status: 'active' })
      .then(() => {
        setRfqActivateOpen(false);
        onUpdate();
      })
      .catch((err: { message?: string }) => {
        alert(te(err?.message) || t('projectDetailExtra.statusSaveError'));
      })
      .finally(() => setProjectActivateSaving(false));
  };

  return (
    <div style={{ background: 'white', padding: '1.5rem', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
      <h2 style={{ marginTop: 0 }}>{t('projectDetail.tabDescription')}</h2>
      <div style={{ marginBottom: '1rem' }}>
        {!editing ? (
          <>
            <p style={{ marginBottom: 6 }}><strong>{t('projectDetailExtra.clientLabel')}</strong> {project.client ?? t('common.dash')}</p>
            <p style={{ marginBottom: 6 }}><strong>{t('projectDetailExtra.projectNameLabel')}</strong> {project.name ?? t('common.dash')}</p>
            <p style={{ marginBottom: 6 }}><strong>{t('projectDetailExtra.sopLabel')}</strong> {formatSopEop(project.sop) || t('common.dash')}</p>
            <p style={{ marginBottom: 8 }}><strong>{t('projectDetailExtra.eopLabel')}</strong> {formatSopEop(project.eop) || t('common.dash')}</p>
            <button type="button" onClick={() => setEditing(true)} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.edit')}</button>
          </>
        ) : (
          <>
            <p style={{ marginBottom: 6 }}>
              <strong>{t('projectDetailExtra.clientLabel')}</strong>{' '}
              <input type="text" value={editClient} onChange={(e) => setEditClient(e.target.value.toUpperCase())} style={{ padding: '0.35rem', width: 280, maxWidth: '100%' }} placeholder={t('projectDetailExtra.clientPlaceholder')} />
            </p>
            <p style={{ marginBottom: 6 }}>
              <strong>{t('projectDetailExtra.projectNameLabel')}</strong>{' '}
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ padding: '0.35rem', width: 280, maxWidth: '100%' }} placeholder={t('projects.nameRequired')} />
            </p>
            <p style={{ marginBottom: 6 }}>
              <strong>{t('projectDetailExtra.sopLabel')}</strong>{' '}
              <input type="text" value={editSop} onChange={(e) => setEditSop(e.target.value)} style={{ padding: '0.35rem', width: 120 }} placeholder={t('common.exampleSop')} title={t('projectDetailExtra.sopFormatTitle')} />
            </p>
            <p style={{ marginBottom: 8 }}>
              <strong>{t('projectDetailExtra.eopLabel')}</strong>{' '}
              <input type="text" value={editEop} onChange={(e) => setEditEop(e.target.value)} style={{ padding: '0.35rem', width: 120 }} placeholder={t('common.exampleEop')} title={t('projectDetailExtra.sopFormatTitle')} />
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={saveDescription} disabled={savingDesc || !editClient.trim() || !editName.trim()} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>
                {savingDesc ? t('common.saving') : t('common.save')}
              </button>
              <button type="button" onClick={() => setEditing(false)} style={{ padding: '0.35rem 0.75rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.cancel')}</button>
            </div>
          </>
        )}
      </div>
      {project.eop_original && (
        <p style={{ fontSize: 13, color: '#555' }}><strong>{t('projectDetailExtra.eopOriginal')}</strong> {formatSopEop(project.eop_original)} <span style={{ fontStyle: 'italic' }}>{t('projectDetailExtra.beforeExtension')}</span></p>
      )}
      {(project.eop_extensions?.length > 0) && (
        <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
          <strong>{t('projectDetailExtra.previousExtensions')}</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: '1.25rem' }}>
            {(project.eop_extensions || []).map((ext: { eop_before: string; eop_after: string; created_at?: string }, i: number) => (
              <li key={i}>
                {formatSopEop(ext.eop_before)} → {formatSopEop(ext.eop_after)}
                {ext.created_at && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>
                    {t('projectDetailExtra.extensionSaved', { date: ext.created_at })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>
        <strong>{t('projectDetailExtra.eopExtensionLabel')}</strong>{' '}
        <input
          type="text"
          placeholder={t('projectDetailExtra.eopExtensionPlaceholder')}
          value={eopExtension}
          onChange={(e) => setEopExtension(e.target.value)}
          style={{ padding: '0.35rem', width: 160, marginRight: 8 }}
        />
        <button onClick={saveEopExtension} disabled={saving || !eopExtension.trim()} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>
          {t('common.save')}
        </button>
        <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#666' }}>{t('projectDetailExtra.eopOverrideHint')}</span>
      </p>
      {showCheckVolumes && onGoToVolumes && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: '#e3f2fd', border: '1px solid #2196f3', borderRadius: 6 }}>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('projectDetailExtra.eopUpdatedCheck')}</p>
          <button type="button" onClick={onGoToVolumes} style={{ padding: '0.35rem 0.75rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetailExtra.goToVolumes')}</button>
        </div>
      )}
      <p>
        <strong>{t('projectDetailExtra.statusLabel')}</strong>{' '}
        <span style={{ background: project.status === 'active' ? 'var(--cap-green)' : project.status === 'RFQ' ? '#ff9800' : '#9e9e9e', color: 'white', padding: '0.25rem 0.5rem', borderRadius: 4, marginRight: 8 }}>
          {project.status === 'active' ? t('common.active') : project.status === 'RFQ' ? t('common.rfq') : t('common.inactive')}
        </span>
        <SearchableSelect
          value={project.status}
          onChange={(e) => {
            const newStatus = e.target.value as 'active' | 'inactive' | 'RFQ';
            onStatusSelectChange(newStatus);
          }}
          style={{ padding: '0.25rem 0.5rem', borderRadius: 4 }}
        >
          <option value="active">{t('common.active')}</option>
          <option value="inactive">{t('common.inactive')}</option>
          <option value="RFQ">{t('common.rfq')}</option>
        </SearchableSelect>
      </p>
      <ProjectActivateRfqMachinesModal
        open={rfqActivateOpen}
        operations={project.operations}
        navigationSearch={navigationSearch}
        onClose={() => setRfqActivateOpen(false)}
        onMachinesUpdated={onUpdate}
        onConfirmActivateProject={confirmActivateProjectAfterRfq}
        projectActivateSaving={projectActivateSaving}
      />
    </div>
  );
}

const WORK_WEEKS_PER_YEAR = 48;
function toAnnual(value: number, unit: string): number {
  if (unit === 'annual') return value;
  if (unit === 'monthly') return value * 12;
  return value * WORK_WEEKS_PER_YEAR;
}
function derivedValues(value: number, unit: string) {
  const annual = toAnnual(value, unit);
  return { annual, monthly: annual / 12, weekly: annual / WORK_WEEKS_PER_YEAR };
}

/** Ułamek roku uwzględniający SOP/EOP: pierwszy rok od startMonth, ostatni do endMonth, środkowe = 1. */
function productionMonthsInYear(
  sopEop: { years: number[]; startMonth?: number; endMonth?: number },
  year: number
): number {
  if (!sopEop.years.length) return 12;
  const isFirst = year === sopEop.years[0];
  const isLast = year === sopEop.years[sopEop.years.length - 1];
  if (isFirst && isLast && sopEop.startMonth != null && sopEop.endMonth != null) {
    return Math.max(0, sopEop.endMonth - sopEop.startMonth + 1);
  }
  if (isFirst && sopEop.startMonth != null) return 13 - sopEop.startMonth;
  if (isLast && sopEop.endMonth != null) return sopEop.endMonth;
  return 12;
}

function yearFraction(
  sopEop: { years: number[]; startMonth?: number; endMonth?: number },
  year: number,
  t: (key: string, params?: Record<string, string | number>) => string
): { fraction: number; label?: string } {
  if (!sopEop.years.length) return { fraction: 1 };
  const isFirst = year === sopEop.years[0];
  const isLast = year === sopEop.years[sopEop.years.length - 1];
  if (isFirst && sopEop.startMonth != null) {
    const monthsInYear = 13 - sopEop.startMonth;
    return { fraction: monthsInYear / 12, label: t('projectDetailExtra.sopEopMonthsOfYear', { months: monthsInYear }) };
  }
  if (isLast && sopEop.endMonth != null) {
    return { fraction: sopEop.endMonth / 12, label: t('projectDetailExtra.sopEopMonthsOfYear', { months: sopEop.endMonth }) };
  }
  return { fraction: 1 };
}

type VolumeOrigin = 'default_all_years' | 'manual_year';

function normalizeVolumeOrigin(raw: unknown): VolumeOrigin {
  return String(raw ?? '').trim() === 'default_all_years' ? 'default_all_years' : 'manual_year';
}

/** Podgląd przeliczeń — zgodny z logiką kalkulatora (dwie ścieżki dla lat niepełnych). */
function effectiveDerivedValues(
  value: number,
  unit: string,
  volumeOrigin: VolumeOrigin,
  sopEop: { years: number[]; startMonth?: number; endMonth?: number },
  year: number,
  t: (key: string, params?: Record<string, string | number>) => string
): { annual: number; monthly: number; weekly: number; label?: string } {
  const months = productionMonthsInYear(sopEop, year);
  const isPartial = months > 0 && months < 12;
  if (volumeOrigin === 'manual_year' && isPartial && unit === 'annual') {
    const monthly = value / months;
    const weekly = (monthly * 12) / WORK_WEEKS_PER_YEAR;
    return {
      // Suma wpisana na rok/okres (jak tooltip kalkulatora) — nie ekwiwalent ×12/miesiące.
      annual: value,
      monthly,
      weekly,
      label: t('projectDetailExtra.sopEopMonthsOfYear', { months }),
    };
  }
  if (volumeOrigin === 'manual_year') {
    return derivedValues(value, unit);
  }
  const { fraction, label } = yearFraction(sopEop, year, t);
  const d = derivedValues(value, unit);
  return {
    annual: d.annual * fraction,
    monthly: (d.annual * fraction) / 12,
    weekly: (d.annual * fraction) / WORK_WEEKS_PER_YEAR,
    label,
  };
}

type ProjectVolumeRow = {
  year: number;
  volume_value: number;
  volume_unit: string;
  include_in_calculator_after_eop?: number | boolean;
  volume_origin?: VolumeOrigin;
};

function mapProjectVolumeRow(pv: any, normInclude: (v: any) => number): ProjectVolumeRow {
  return {
    ...pv,
    include_in_calculator_after_eop: normInclude(pv.include_in_calculator_after_eop),
    volume_origin: normalizeVolumeOrigin(pv.volume_origin),
  };
}
function VolumesTab({ project, onUpdate }: { project: any; onUpdate: () => void }) {
  const { t, te } = useI18n();
  const volUnitLabel = (u: string) =>
    u === 'annual' ? t('common.unitAnnual') : u === 'monthly' ? t('common.unitMonthly') : u === 'weekly' ? t('common.unitWeekly') : u;
  const normInclude = (v: any) => (v === 1 || v === true || v === '1' ? 1 : 0);
  const [projectVolumes, setProjectVolumes] = useState<ProjectVolumeRow[]>(() => (project.project_volumes ?? []).map((pv: any) => mapProjectVolumeRow(pv, normInclude)));
  const [newYear, setNewYear] = useState(new Date().getFullYear());
  const [newValue, setNewValue] = useState('');
  const [newUnit, setNewUnit] = useState<'annual' | 'monthly' | 'weekly'>('annual');
  const [saving, setSaving] = useState(false);
  const [applyAllValue, setApplyAllValue] = useState('');
  const [applyAllUnit, setApplyAllUnit] = useState<'annual' | 'monthly' | 'weekly'>('annual');
  const valueInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const addValueInputRef = useRef<HTMLInputElement | null>(null);
  const projectVolumesRef = useRef(projectVolumes);
  projectVolumesRef.current = projectVolumes;
  const projectVolumesDirtyRef = useRef(false);

  const [projectVolumesContract, setProjectVolumesContract] = useState<ProjectVolumeRow[]>(() =>
    (project.project_volumes_contract ?? []).map((pv: any) => mapProjectVolumeRow(pv, normInclude))
  );
  const [newYearCo, setNewYearCo] = useState(new Date().getFullYear());
  const [newValueCo, setNewValueCo] = useState('');
  const [newUnitCo, setNewUnitCo] = useState<'annual' | 'monthly' | 'weekly'>('annual');
  const [applyAllValueCo, setApplyAllValueCo] = useState('');
  const [applyAllUnitCo, setApplyAllUnitCo] = useState<'annual' | 'monthly' | 'weekly'>('annual');
  const valueInputRefsCo = useRef<Record<number, HTMLInputElement | null>>({});
  const addValueInputRefCo = useRef<HTMLInputElement | null>(null);
  const projectVolumesContractRef = useRef(projectVolumesContract);
  projectVolumesContractRef.current = projectVolumesContract;
  const projectVolumesContractDirtyRef = useRef(false);

  const [volumesAutosaveEnabled, setVolumesAutosaveEnabled] = useState(true);
  useEffect(() => {
    api.settings
      .getBehavior()
      .then((cfg) => setVolumesAutosaveEnabled(cfg.volumes_autosave_enabled !== false))
      .catch(() => setVolumesAutosaveEnabled(true));
  }, []);

  useEffect(() => {
    projectVolumesDirtyRef.current = false;
    projectVolumesContractDirtyRef.current = false;
  }, [project?.id]);

  useEffect(() => {
    if (projectVolumesDirtyRef.current) return;
    const list = (project.project_volumes ?? []).map((pv: any) => mapProjectVolumeRow(pv, normInclude));
    setProjectVolumes(list);
  }, [project?.id, project?.eop, project?.project_volumes]);

  useEffect(() => {
    if (projectVolumesContractDirtyRef.current) return;
    const list = (project.project_volumes_contract ?? []).map((pv: any) => mapProjectVolumeRow(pv, normInclude));
    setProjectVolumesContract(list);
  }, [project?.id, project?.eop, project?.project_volumes_contract]);

  const saveProjectVolumes = (volumes: ProjectVolumeRow[]) => {
    setSaving(true);
    api.projects.setVolumes(project.id, volumes)
      .then((rows) => {
        projectVolumesDirtyRef.current = false;
        setProjectVolumes(rows.map((pv: any) => mapProjectVolumeRow(pv, normInclude)));
        onUpdate();
      })
      .finally(() => setSaving(false));
  };

  const addProjectVolume = () => {
    const v = Number(newValue);
    if (newValue.trim() === '' || isNaN(v) || v < 0) return;
    if (projectVolumes.some((pv) => pv.year === newYear)) return;
    const next = [...projectVolumes, { year: newYear, volume_value: v, volume_unit: newUnit, include_in_calculator_after_eop: 0, volume_origin: 'manual_year' as const }].sort((a, b) => a.year - b.year);
    setProjectVolumes(next);
    setNewValue('');
    setNewYear((prev) => prev + 1);
    saveProjectVolumes(next);
    setTimeout(() => addValueInputRef.current?.focus(), 0);
  };

  const removeProjectVolume = (year: number) => {
    if (!confirmDelete(t('projectDetailExtra.removeProjectVolumeConfirm', { year }))) return;
    const next = projectVolumes.filter((pv) => pv.year !== year);
    setProjectVolumes(next);
    saveProjectVolumes(next);
  };

  const updateProjectVolume = (year: number, field: 'volume_value' | 'volume_unit' | 'include_in_calculator_after_eop', val: number | string | boolean) => {
    projectVolumesDirtyRef.current = true;
    setProjectVolumes((prev) => {
      const next = prev.map((pv) =>
        pv.year === year
          ? {
              ...pv,
              [field]: val,
              ...(field === 'volume_value' || field === 'volume_unit' ? { volume_origin: 'manual_year' as const } : {}),
            }
          : pv
      );
      projectVolumesRef.current = next;
      return next;
    });
  };

  const persistVolumeChange = () => {
    saveProjectVolumes(projectVolumesRef.current);
  };

  const applySameToAllYears = () => {
    const v = Number(applyAllValue);
    if (applyAllValue.trim() === '' || isNaN(v) || v < 0 || projectVolumes.length === 0) return;
    if (
      !confirmDelete(
        t('projectDetailExtra.applyAllYearsConfirm', {
          value: v,
          unit: volUnitLabel(applyAllUnit),
          count: projectVolumes.length,
        })
      )
    )
      return;
    const next = projectVolumes.map((pv) => ({
      ...pv,
      volume_value: v,
      volume_unit: applyAllUnit,
      volume_origin: 'default_all_years' as const,
    }));
    setProjectVolumes(next);
    saveProjectVolumes(next);
  };

  const sortedYears = [...projectVolumes].map((pv) => pv.year).sort((a, b) => a - b);
  const sopEop = sopEopYearsRange(project.sop ?? '', project.eop ?? '');
  const eopYear = sopEop.years.length > 0 ? sopEop.years[sopEop.years.length - 1] : null;
  const applyAllNum = Number(applyAllValue);
  const applyDerived = applyAllValue.trim() && !isNaN(applyAllNum) && applyAllNum >= 0 ? derivedValues(applyAllNum, applyAllUnit) : null;

  const toggleIncludeAfterEop = (year: number) => {
    const pv = projectVolumes.find((v) => v.year === year);
    if (!pv) return;
    const current = pv.include_in_calculator_after_eop === 1 || pv.include_in_calculator_after_eop === true;
    const next = projectVolumes.map((v) => v.year === year ? { ...v, include_in_calculator_after_eop: current ? 0 : 1 } : v);
    setProjectVolumes(next);
    saveProjectVolumes(next);
  };

  const fillYearsFromSopEop = () => {
    if (sopEop.years.length === 0) return;
    const existing = new Set(projectVolumes.map((pv) => pv.year));
    const toAdd = sopEop.years.filter((y) => !existing.has(y)).map((year) => ({ year, volume_value: 0, volume_unit: 'annual' as const, include_in_calculator_after_eop: 0 }));
    if (toAdd.length === 0) return;
    const next = [...projectVolumes, ...toAdd].sort((a, b) => a.year - b.year);
    setProjectVolumes(next);
    saveProjectVolumes(next);
  };

  const saveProjectVolumesContract = (volumes: ProjectVolumeRow[]) => {
    setSaving(true);
    api.projects
      .setVolumesContract(project.id, volumes)
      .then((rows) => {
        projectVolumesContractDirtyRef.current = false;
        setProjectVolumesContract(rows.map((pv: any) => mapProjectVolumeRow(pv, normInclude)));
        onUpdate();
      })
      .finally(() => setSaving(false));
  };

  const addProjectVolumeContract = () => {
    const v = Number(newValueCo);
    if (newValueCo.trim() === '' || isNaN(v) || v < 0) return;
    if (projectVolumesContract.some((pv) => pv.year === newYearCo)) return;
    const next = [...projectVolumesContract, { year: newYearCo, volume_value: v, volume_unit: newUnitCo, include_in_calculator_after_eop: 0, volume_origin: 'manual_year' as const }].sort((a, b) => a.year - b.year);
    setProjectVolumesContract(next);
    setNewValueCo('');
    setNewYearCo((prev) => prev + 1);
    saveProjectVolumesContract(next);
    setTimeout(() => addValueInputRefCo.current?.focus(), 0);
  };

  const removeProjectVolumeContract = (year: number) => {
    if (!confirmDelete(t('projectDetailExtra.removeContractVolumeConfirm', { year }))) return;
    const next = projectVolumesContract.filter((pv) => pv.year !== year);
    setProjectVolumesContract(next);
    saveProjectVolumesContract(next);
  };

  const updateProjectVolumeContract = (year: number, field: 'volume_value' | 'volume_unit' | 'include_in_calculator_after_eop', val: number | string | boolean) => {
    projectVolumesContractDirtyRef.current = true;
    setProjectVolumesContract((prev) => {
      const next = prev.map((pv) =>
        pv.year === year
          ? {
              ...pv,
              [field]: val,
              ...(field === 'volume_value' || field === 'volume_unit' ? { volume_origin: 'manual_year' as const } : {}),
            }
          : pv
      );
      projectVolumesContractRef.current = next;
      return next;
    });
  };

  const persistVolumeChangeContract = () => {
    saveProjectVolumesContract(projectVolumesContractRef.current);
  };

  const applySameToAllYearsContract = () => {
    const v = Number(applyAllValueCo);
    if (applyAllValueCo.trim() === '' || isNaN(v) || v < 0 || projectVolumesContract.length === 0) return;
    if (
      !confirmDelete(
        t('projectDetailExtra.applyAllContractYearsConfirm', {
          value: v,
          unit: volUnitLabel(applyAllUnitCo),
          count: projectVolumesContract.length,
        })
      )
    )
      return;
    const next = projectVolumesContract.map((pv) => ({
      ...pv,
      volume_value: v,
      volume_unit: applyAllUnitCo,
      volume_origin: 'default_all_years' as const,
    }));
    setProjectVolumesContract(next);
    saveProjectVolumesContract(next);
  };

  const sortedYearsContract = [...projectVolumesContract].map((pv) => pv.year).sort((a, b) => a - b);
  const applyAllNumCo = Number(applyAllValueCo);
  const applyDerivedCo =
    applyAllValueCo.trim() && !isNaN(applyAllNumCo) && applyAllNumCo >= 0 ? derivedValues(applyAllNumCo, applyAllUnitCo) : null;

  const toggleIncludeAfterEopContract = (year: number) => {
    const pv = projectVolumesContract.find((v) => v.year === year);
    if (!pv) return;
    const current = pv.include_in_calculator_after_eop === 1 || pv.include_in_calculator_after_eop === true;
    const next = projectVolumesContract.map((v) => (v.year === year ? { ...v, include_in_calculator_after_eop: current ? 0 : 1 } : v));
    setProjectVolumesContract(next);
    saveProjectVolumesContract(next);
  };

  const fillYearsFromSopEopContract = () => {
    if (sopEop.years.length === 0) return;
    const existing = new Set(projectVolumesContract.map((pv) => pv.year));
    const toAdd = sopEop.years.filter((y) => !existing.has(y)).map((year) => ({ year, volume_value: 0, volume_unit: 'annual' as const, include_in_calculator_after_eop: 0 }));
    if (toAdd.length === 0) return;
    const next = [...projectVolumesContract, ...toAdd].sort((a, b) => a.year - b.year);
    setProjectVolumesContract(next);
    saveProjectVolumesContract(next);
  };

  return (
    <div style={{ background: 'white', padding: '1.5rem', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', minWidth: 0, maxWidth: '100%' }}>
      <h2 style={{ marginTop: 0 }}>
        {t('projectDetailExtra.volumesTabTitle')}
        <span style={{ display: 'block', fontSize: '1rem', fontWeight: 600, color: 'var(--cap-gray)', marginTop: '0.35rem' }}>{projectContextSubtitle(project)}</span>
      </h2>
      <p style={{ color: '#555', marginBottom: '1rem', fontSize: 14, lineHeight: 1.45 }}>{t('projectDetailExtra.volumesIntro')}</p>

      <div className="volumes-project-split" style={{ marginBottom: '2rem' }}>
      <section className="volumes-split-col volumes-split-col-prod" style={{ margin: 0 }}>
        <h3 style={{ marginTop: 0 }}>{t('projectDetailExtra.productionVolumes')}</h3>
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
          <button
            type="button"
            disabled={saving}
            style={{ padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: '1px solid #bdbdbd', background: '#fff', cursor: saving ? 'default' : 'pointer' }}
            onClick={() => {
              if (!window.confirm(t('projectDetailExtra.copyProdToContract'))) return;
              setSaving(true);
              api.projects
                .mirrorProjectVolumes(project.id, 'production_to_contract')
                .then(() => {
                  projectVolumesDirtyRef.current = false;
                  projectVolumesContractDirtyRef.current = false;
                  onUpdate();
                })
                .catch((e: Error) => window.alert(te(e?.message) || t('common.error')))
                .finally(() => setSaving(false));
            }}
          >
            {t('projectDetailExtra.arrowToContract')}
          </button>
        </div>

        {sopEop.years.length > 0 && (
          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#e3f2fd', borderRadius: 6, border: '1px solid #90caf9' }}>
            <strong>
              {t('projectDetailExtra.sopEopYears', { sop: formatSopEop(project.sop), eop: formatSopEop(project.eop), years: sopEop.years.join(', ') })}
            </strong>
            {(sopEop.startMonth != null || (sopEop.endMonth != null && sopEop.years.length > 1)) && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 12, color: '#555' }}>
                {sopEop.startMonth != null && (
                  <span>{t('projectDetailExtra.yearFromMonth', { year: sopEop.years[0], month: sopEop.startMonth })}</span>
                )}
                {sopEop.endMonth != null && sopEop.years.length > 1 && (
                  <span>{t('projectDetailExtra.yearToMonth', { year: sopEop.years[sopEop.years.length - 1], month: sopEop.endMonth })}</span>
                )}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <button type="button" onClick={fillYearsFromSopEop} disabled={saving} style={{ padding: '0.35rem 0.75rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}>
                {t('projectDetailExtra.fillYearsSopEop')}
              </button>
            </div>
          </div>
        )}

        <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#f0f7f0', borderRadius: 6, border: '1px solid #c8e6c9' }}>
          <strong style={{ display: 'block', marginBottom: 6 }}>{t('projectDetailExtra.sameValueAllYears')}</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="number" min={0} placeholder={t('projectDetailExtra.valuePlaceholder')} value={applyAllValue} onChange={(e) => setApplyAllValue(e.target.value)} style={{ width: 100, padding: 4 }} />
            <SearchableSelect value={applyAllUnit} onChange={(e) => setApplyAllUnit(e.target.value as any)} style={{ padding: 4 }}>
              <option value="annual">{t('common.unitAnnual')}</option>
              <option value="monthly">{t('common.unitMonthly')}</option>
              <option value="weekly">{t('common.unitWeekly')}</option>
            </SearchableSelect>
            <button type="button" onClick={applySameToAllYears} disabled={projectVolumes.length === 0 || saving} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>
              {t('projectDetailExtra.applyToAll')}
            </button>
          </div>
          {applyDerived && (
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#2e7d32' }}>
              {t('projectDetailExtra.derivedPreview', {
                annual: Math.round(applyDerived.annual),
                monthly: Math.round(applyDerived.monthly),
                weekly: Math.round(applyDerived.weekly),
              })}
            </p>
          )}
          {projectVolumes.length === 0 && !applyDerived && <span style={{ fontSize: 12, color: '#666' }}>{t('projectDetailExtra.fillYearsHint')}</span>}
        </div>

        {saving && <span style={{ fontSize: 13, color: '#666', marginBottom: 8, display: 'block' }}>{t('common.saving')}</span>}

        <div className="volumes-table-wrap volumes-table-wrap--wide">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('common.year')}</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('common.value')}</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('common.unit')}</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projectDetailExtra.calculatedUnits')}</th>
              <th className="volumes-th-eop" style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projectDetailExtra.countAfterEop')}</th>
              <th style={{ padding: '0.5rem', width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {projectVolumes.map((pv, idx) => {
              const origin = normalizeVolumeOrigin(pv.volume_origin);
              const d = effectiveDerivedValues(pv.volume_value, pv.volume_unit, origin, sopEop, pv.year, t);
              const label = d.label;
              const effectiveAnnual = d.annual;
              const effectiveMonthly = d.monthly;
              const effectiveWeekly = d.weekly;
              const nextYear = sortedYears[idx + 1];
              const isAfterEop = eopYear != null && pv.year > eopYear;
              const includeAfterEop = pv.include_in_calculator_after_eop === 1 || pv.include_in_calculator_after_eop === true;
              return (
                <tr key={pv.year}>
                  <td style={{ padding: '0.5rem' }}>{pv.year}</td>
                  <td style={{ padding: '0.5rem' }}>
                    <ZeroClearNumberInput
                      ref={(el) => { valueInputRefs.current[pv.year] = el; }}
                      value={pv.volume_value}
                      onChange={(n) => updateProjectVolume(pv.year, 'volume_value', n)}
                      onBlur={persistVolumeChange}
                      onKeyDown={(e) => { if (e.key === 'Enter' && nextYear != null) { e.preventDefault(); valueInputRefs.current[nextYear]?.focus(); } }}
                      style={{ width: 100 }}
                      title={t('projectDetailExtra.editQty')}
                    />
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <SearchableSelect
                      value={pv.volume_unit}
                      onChange={(e) => updateProjectVolume(pv.year, 'volume_unit', e.target.value)}
                      onBlur={persistVolumeChange}
                    >
                      <option value="annual">{t('common.unitAnnual')}</option>
                      <option value="monthly">{t('common.unitMonthly')}</option>
                      <option value="weekly">{t('common.unitWeekly')}</option>
                    </SearchableSelect>
                  </td>
                  <td style={{ padding: '0.5rem', fontSize: 13, color: '#666' }}>
                    {label ? (
                      <span title={t('projectDetailExtra.sopEopFractionTitle', { label })}>
                        {Math.round(effectiveAnnual)} / {Math.round(effectiveMonthly)} / {Math.round(effectiveWeekly)}
                        <span style={{ marginLeft: 6, color: '#1565c0', fontWeight: 600 }}>({label})</span>
                      </span>
                    ) : (
                      <span>{Math.round(effectiveAnnual)} / {Math.round(effectiveMonthly)} / {Math.round(effectiveWeekly)}</span>
                    )}
                    {origin === 'manual_year' && (
                      <span style={{ marginLeft: 6, color: '#c62828', fontWeight: 600 }} title={t('projectDetailExtra.manualYearOverride')}>
                        {t('projectDetailExtra.manualYearOverrideShort')}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem', fontSize: 12 }}>
                    {isAfterEop ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={includeAfterEop} onChange={() => toggleIncludeAfterEop(pv.year)} />
                        <span>{t('projectDetailExtra.countInCalculator')}</span>
                        {includeAfterEop && (
                          <span style={{ color: '#c62828', fontWeight: 600 }} title={t('projectDetailExtra.manualOverrideEop')}>
                            {t('projectDetailExtra.manualOverrideEopShort')}
                          </span>
                        )}
                      </label>
                    ) : (
                      <span style={{ color: '#888' }}>{t('common.dash')}</span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <button type="button" onClick={() => removeProjectVolume(pv.year)} style={{ padding: '0.2rem 0.5rem', background: '#c62828', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.delete')}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <input type="number" placeholder={t('projectDetailExtra.yearPlaceholder')} value={newYear} onChange={(e) => setNewYear(Number(e.target.value))} style={{ width: 70, padding: 4 }} title={t('projectDetailExtra.yearNextHint')} />
          <input ref={addValueInputRef} type="number" placeholder={t('projectDetailExtra.valuePlaceholder')} value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addProjectVolume(); }} style={{ width: 100, padding: 4 }} />
          <SearchableSelect value={newUnit} onChange={(e) => setNewUnit(e.target.value as any)} style={{ padding: 4 }}>
            <option value="annual">{t('common.unitAnnual')}</option>
            <option value="monthly">{t('common.unitMonthly')}</option>
            <option value="weekly">{t('common.unitWeekly')}</option>
          </SearchableSelect>
          <button type="button" onClick={addProjectVolume} disabled={saving} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetailExtra.addYear')}</button>
        </div>
      </section>

      <section className="volumes-split-col volumes-split-col-contract" style={{ margin: 0 }}>
        <h3 style={{ marginTop: 0 }}>{t('projectDetailExtra.contractVolumes')}</h3>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button
            type="button"
            disabled={saving}
            style={{ padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: '1px solid #bdbdbd', background: '#fff', cursor: saving ? 'default' : 'pointer' }}
            onClick={() => {
              if (!window.confirm(t('projectDetailExtra.copyContractToProd'))) return;
              setSaving(true);
              api.projects
                .mirrorProjectVolumes(project.id, 'contract_to_production')
                .then(() => {
                  projectVolumesDirtyRef.current = false;
                  projectVolumesContractDirtyRef.current = false;
                  onUpdate();
                })
                .catch((e: Error) => window.alert(te(e?.message) || t('common.error')))
                .finally(() => setSaving(false));
            }}
          >
            {t('projectDetailExtra.arrowToProduction')}
          </button>
        </div>

        {sopEop.years.length > 0 && (
          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#fff8e1', borderRadius: 6, border: '1px solid #ffcc80' }}>
            <strong>
              {t('projectDetailExtra.sopEopYears', { sop: formatSopEop(project.sop), eop: formatSopEop(project.eop), years: sopEop.years.join(', ') })}
            </strong>
            {(sopEop.startMonth != null || (sopEop.endMonth != null && sopEop.years.length > 1)) && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 12, color: '#555' }}>
                {sopEop.startMonth != null && (
                  <span>{t('projectDetailExtra.yearFromMonth', { year: sopEop.years[0], month: sopEop.startMonth })}</span>
                )}
                {sopEop.endMonth != null && sopEop.years.length > 1 && (
                  <span>{t('projectDetailExtra.yearToMonth', { year: sopEop.years[sopEop.years.length - 1], month: sopEop.endMonth })}</span>
                )}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <button type="button" onClick={fillYearsFromSopEopContract} disabled={saving} style={{ padding: '0.35rem 0.75rem', background: '#ff9800', color: 'white', border: 'none', borderRadius: 4 }}>
                {t('projectDetailExtra.fillYearsSopEop')}
              </button>
            </div>
          </div>
        )}

        <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#fff3e0', borderRadius: 6, border: '1px solid #ffcc80' }}>
          <strong style={{ display: 'block', marginBottom: 6 }}>{t('projectDetailExtra.sameValueAllYears')}</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="number" min={0} placeholder={t('projectDetailExtra.valuePlaceholder')} value={applyAllValueCo} onChange={(e) => setApplyAllValueCo(e.target.value)} style={{ width: 100, padding: 4 }} />
            <SearchableSelect value={applyAllUnitCo} onChange={(e) => setApplyAllUnitCo(e.target.value as any)} style={{ padding: 4 }}>
              <option value="annual">{t('common.unitAnnual')}</option>
              <option value="monthly">{t('common.unitMonthly')}</option>
              <option value="weekly">{t('common.unitWeekly')}</option>
            </SearchableSelect>
            <button type="button" onClick={applySameToAllYearsContract} disabled={projectVolumesContract.length === 0 || saving} style={{ padding: '0.35rem 0.75rem', background: '#ff9800', color: 'white', border: 'none', borderRadius: 4 }}>
              {t('projectDetailExtra.applyToAll')}
            </button>
          </div>
          {applyDerivedCo && (
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#e65100' }}>
              {t('projectDetailExtra.derivedPreview', {
                annual: Math.round(applyDerivedCo.annual),
                monthly: Math.round(applyDerivedCo.monthly),
                weekly: Math.round(applyDerivedCo.weekly),
              })}
            </p>
          )}
          {projectVolumesContract.length === 0 && !applyDerivedCo && (
            <span style={{ fontSize: 12, color: '#666' }}>{t('projectDetailExtra.fillYearsHint')}</span>
          )}
        </div>

        {saving && <span style={{ fontSize: 13, color: '#666', marginBottom: 8, display: 'block' }}>{t('common.saving')}</span>}
        <div className="volumes-table-wrap volumes-table-wrap--wide">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#fff8e1' }}>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('common.year')}</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('common.value')}</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('common.unit')}</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projectDetailExtra.calculatedUnits')}</th>
              <th className="volumes-th-eop" style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projectDetailExtra.countAfterEop')}</th>
              <th style={{ padding: '0.5rem', width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {projectVolumesContract.map((pv, idx) => {
              const origin = normalizeVolumeOrigin(pv.volume_origin);
              const d = effectiveDerivedValues(pv.volume_value, pv.volume_unit, origin, sopEop, pv.year, t);
              const label = d.label;
              const effectiveAnnual = d.annual;
              const effectiveMonthly = d.monthly;
              const effectiveWeekly = d.weekly;
              const nextYear = sortedYearsContract[idx + 1];
              const isAfterEop = eopYear != null && pv.year > eopYear;
              const includeAfterEop = pv.include_in_calculator_after_eop === 1 || pv.include_in_calculator_after_eop === true;
              return (
                <tr key={pv.year}>
                  <td style={{ padding: '0.5rem' }}>{pv.year}</td>
                  <td style={{ padding: '0.5rem' }}>
                    <ZeroClearNumberInput
                      ref={(el) => { valueInputRefsCo.current[pv.year] = el; }}
                      value={pv.volume_value}
                      onChange={(n) => updateProjectVolumeContract(pv.year, 'volume_value', n)}
                      onBlur={persistVolumeChangeContract}
                      onKeyDown={(e) => { if (e.key === 'Enter' && nextYear != null) { e.preventDefault(); valueInputRefsCo.current[nextYear]?.focus(); } }}
                      style={{ width: 100 }}
                      title={t('projectDetailExtra.editQty')}
                    />
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <SearchableSelect
                      value={pv.volume_unit}
                      onChange={(e) => updateProjectVolumeContract(pv.year, 'volume_unit', e.target.value)}
                      onBlur={persistVolumeChangeContract}
                    >
                      <option value="annual">{t('common.unitAnnual')}</option>
                      <option value="monthly">{t('common.unitMonthly')}</option>
                      <option value="weekly">{t('common.unitWeekly')}</option>
                    </SearchableSelect>
                  </td>
                  <td style={{ padding: '0.5rem', fontSize: 13, color: '#666' }}>
                    {label ? (
                      <span title={t('projectDetailExtra.sopEopFractionTitle', { label })}>
                        {Math.round(effectiveAnnual)} / {Math.round(effectiveMonthly)} / {Math.round(effectiveWeekly)}
                        <span style={{ marginLeft: 6, color: '#e65100', fontWeight: 600 }}>({label})</span>
                      </span>
                    ) : (
                      <span>{Math.round(effectiveAnnual)} / {Math.round(effectiveMonthly)} / {Math.round(effectiveWeekly)}</span>
                    )}
                    {origin === 'manual_year' && (
                      <span style={{ marginLeft: 6, color: '#c62828', fontWeight: 600 }} title={t('projectDetailExtra.manualYearOverride')}>
                        {t('projectDetailExtra.manualYearOverrideShort')}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem', fontSize: 12 }}>
                    {isAfterEop ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={includeAfterEop} onChange={() => toggleIncludeAfterEopContract(pv.year)} />
                        <span>{t('projectDetailExtra.countInCalculator')}</span>
                        {includeAfterEop && (
                          <span style={{ color: '#c62828', fontWeight: 600 }} title={t('projectDetailExtra.manualOverrideEop')}>
                            {t('projectDetailExtra.manualOverrideEopShort')}
                          </span>
                        )}
                      </label>
                    ) : (
                      <span style={{ color: '#888' }}>{t('common.dash')}</span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <button type="button" onClick={() => removeProjectVolumeContract(pv.year)} style={{ padding: '0.2rem 0.5rem', background: '#c62828', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.delete')}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <input type="number" placeholder={t('projectDetailExtra.yearPlaceholder')} value={newYearCo} onChange={(e) => setNewYearCo(Number(e.target.value))} style={{ width: 70, padding: 4 }} title={t('projectDetailExtra.yearNextHint')} />
          <input ref={addValueInputRefCo} type="number" placeholder={t('projectDetailExtra.valuePlaceholder')} value={newValueCo} onChange={(e) => setNewValueCo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addProjectVolumeContract(); }} style={{ width: 100, padding: 4 }} />
          <SearchableSelect value={newUnitCo} onChange={(e) => setNewUnitCo(e.target.value as any)} style={{ padding: 4 }}>
            <option value="annual">{t('common.unitAnnual')}</option>
            <option value="monthly">{t('common.unitMonthly')}</option>
            <option value="weekly">{t('common.unitWeekly')}</option>
          </SearchableSelect>
          <button type="button" onClick={addProjectVolumeContract} disabled={saving} style={{ padding: '0.35rem 0.75rem', background: '#ff9800', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetailExtra.addYear')}</button>
        </div>
      </section>
      </div>

      <section style={{ minWidth: 0, maxWidth: '100%' }}>
        <h3 style={{ marginTop: 0 }}>{t('projectDetailExtra.partVolumesTitle')}</h3>
        {(project.parts ?? []).length === 0 ? (
          <p style={{ color: '#888' }}>{t('projectDetailExtra.noPartsInProject')}</p>
        ) : (
          (project.parts ?? []).map((part: any) => (
            <div key={part.id} className="volumes-part-split" style={{ marginBottom: '1rem' }}>
              <div className="volumes-split-col volumes-split-col-prod">
                <PartVolumeRow projectId={project.id} part={part} projectVolumes={projectVolumes} contractColumn={false} projectContractVolumes={projectVolumesContract} sop={project.sop} eop={project.eop} volumesAutosaveEnabled={volumesAutosaveEnabled} onUpdate={onUpdate} />
              </div>
              <div className="volumes-split-col volumes-split-col-contract">
                <PartVolumeRow projectId={project.id} part={part} projectVolumes={projectVolumes} contractColumn projectContractVolumes={projectVolumesContract} sop={project.sop} eop={project.eop} volumesAutosaveEnabled={volumesAutosaveEnabled} onUpdate={onUpdate} />
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

type PartVolumeEditorState = {
  mode: string;
  sharePercent: string;
  shareByYear: Record<number, string>;
  volumeByYear: { year: number; volume_value: number; volume_unit: string; volume_origin?: VolumeOrigin }[];
  defaultVolumeValue: string;
  defaultVolumeUnit: 'annual' | 'monthly' | 'weekly';
};

function partVolumeStateFromPart(part: any, contractColumn: boolean): PartVolumeEditorState {
  const shareByYear: Record<number, string> = {};
  const shareRows = contractColumn ? (part.volume_contract_share_by_year ?? []) : (part.volume_share_by_year ?? []);
  shareRows.forEach((r: { year: number; share_percent: number }) => {
    shareByYear[r.year] = String(r.share_percent);
  });
  const volumeRows = contractColumn ? (part.volume_contract_by_year ?? []) : (part.volume_by_year ?? []);
  return {
    mode: contractColumn ? (part.contract_volume_mode ?? 'project') : (part.volume_mode ?? 'project'),
    sharePercent: contractColumn
      ? part.contract_volume_share_percent != null
        ? String(part.contract_volume_share_percent)
        : ''
      : part.volume_share_percent != null
        ? String(part.volume_share_percent)
        : '',
    shareByYear,
    volumeByYear: volumeRows.map((r: any) => ({
      year: r.year,
      volume_value: r.volume_value,
      volume_unit: r.volume_unit,
      volume_origin: normalizeVolumeOrigin(r.volume_origin),
    })),
    defaultVolumeValue: contractColumn
      ? part.contract_default_volume_value != null
        ? String(part.contract_default_volume_value)
        : ''
      : part.default_volume_value != null
        ? String(part.default_volume_value)
        : '',
    defaultVolumeUnit: (() => {
      const u = contractColumn ? part.contract_default_volume_unit : part.default_volume_unit;
      return u && ['annual', 'monthly', 'weekly'].includes(u) ? u : 'annual';
    })(),
  };
}

function partVolumeStateSignature(state: PartVolumeEditorState): string {
  const shareEntries = Object.keys(state.shareByYear)
    .map(Number)
    .sort((a, b) => a - b)
    .map((year) => `${year}:${state.shareByYear[year] ?? ''}`);
  const volumeRows = [...state.volumeByYear]
    .sort((a, b) => a.year - b.year)
    .map((row) => `${row.year}:${row.volume_value}:${row.volume_unit}:${row.volume_origin ?? 'manual_year'}`);
  return JSON.stringify({
    mode: state.mode,
    sharePercent: state.sharePercent,
    share: shareEntries,
    volume: volumeRows,
    defaultVolumeValue: state.defaultVolumeValue,
    defaultVolumeUnit: state.defaultVolumeUnit,
  });
}

function PartVolumeRow({
  projectId,
  part,
  projectVolumes,
  projectContractVolumes,
  contractColumn,
  sop,
  eop,
  volumesAutosaveEnabled,
  onUpdate,
}: {
  projectId: number;
  part: any;
  projectVolumes: { year: number; volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number | boolean }[];
  projectContractVolumes: { year: number; volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number | boolean }[];
  contractColumn?: boolean;
  sop?: string;
  eop?: string;
  volumesAutosaveEnabled?: boolean;
  onUpdate: () => void;
}) {
  const { t } = useI18n();
  const { referenceDisplay } = useReferenceDisplay();
  const volUnit = (u: string) =>
    u === 'annual' ? t('common.unitAnnual') : u === 'monthly' ? t('common.unitMonthly') : t('common.unitWeekly');
  const label = formatDetailSapAliasLabel(
    {
      sap_number: part.detail_sap_number,
      alias: part.detail_alias,
      free_text: part.detail_free_text,
      designation: part.designation,
      id: part.id,
    },
    referenceDisplay
  );
  const [mode, setMode] = useState<string>(contractColumn ? (part.contract_volume_mode ?? 'project') : (part.volume_mode ?? 'project'));
  const [sharePercent, setSharePercent] = useState<string>(
    contractColumn
      ? part.contract_volume_share_percent != null
        ? String(part.contract_volume_share_percent)
        : ''
      : part.volume_share_percent != null
        ? String(part.volume_share_percent)
        : ''
  );
  const [shareByYear, setShareByYear] = useState<Record<number, string>>(() => {
    const byYear: Record<number, string> = {};
    const rows = contractColumn ? (part.volume_contract_share_by_year ?? []) : (part.volume_share_by_year ?? []);
    rows.forEach((r: { year: number; share_percent: number }) => {
      byYear[r.year] = String(r.share_percent);
    });
    return byYear;
  });
  const [volumeByYear, setVolumeByYear] = useState<{ year: number; volume_value: number; volume_unit: string; volume_origin?: VolumeOrigin }[]>(() =>
    contractColumn ? (part.volume_contract_by_year ?? []) : (part.volume_by_year ?? [])
  );
  const [defaultVolumeValue, setDefaultVolumeValue] = useState<string>(
    contractColumn
      ? part.contract_default_volume_value != null
        ? String(part.contract_default_volume_value)
        : ''
      : part.default_volume_value != null
        ? String(part.default_volume_value)
        : ''
  );
  const [defaultVolumeUnit, setDefaultVolumeUnit] = useState<'annual' | 'monthly' | 'weekly'>(() => {
    const u = contractColumn ? part.contract_default_volume_unit : part.default_volume_unit;
    return u && ['annual', 'monthly', 'weekly'].includes(u) ? u : 'annual';
  });
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [addingYear, setAddingYear] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [importingPaste, setImportingPaste] = useState(false);
  const saveFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const saveStateRef = useRef({
    mode: 'project' as string,
    shareByYear: {} as Record<number, string>,
    volumeByYear: [] as { year: number; volume_value: number; volume_unit: string; volume_origin?: VolumeOrigin }[],
    sharePercent: '',
    defaultVolumeValue: '',
    defaultVolumeUnit: 'annual' as 'annual' | 'monthly' | 'weekly',
    contractColumn: false,
    yearsForOverride: [] as number[],
    yearsForShare: [] as number[],
  });

  const sopEopParsed = sopEopYearsRange(sop ?? '', eop ?? '');
  const sopEopYears = sopEopParsed.years;
  const eopYear = sopEopYears.length > 0 ? sopEopYears[sopEopYears.length - 1] : null;
  const projVol = contractColumn ? projectContractVolumes : projectVolumes;
  const yearsForShare = sopEopYears.length > 0 ? sopEopYears : projVol.map((pv) => pv.year);
  const yearsForOverride =
    sopEopYears.length > 0 ? sopEopYears : (contractColumn ? projectContractVolumes : projectVolumes).map((pv) => pv.year);
  const displayYears = mode === 'share' ? yearsForShare : yearsForOverride;
  const suggestedNextYear =
    Math.max(0, ...displayYears, ...volumeByYear.map((r) => r.year), ...Object.keys(shareByYear).map(Number)) + 1;
  const [newPartYear, setNewPartYear] = useState(suggestedNextYear);

  useEffect(() => {
    setNewPartYear(suggestedNextYear);
  }, [suggestedNextYear, part.id, eop]);

  useEffect(() => {
    saveStateRef.current = {
      mode,
      shareByYear,
      volumeByYear,
      sharePercent,
      defaultVolumeValue,
      defaultVolumeUnit,
      contractColumn: !!contractColumn,
      yearsForOverride,
      yearsForShare,
    };
  }, [mode, shareByYear, volumeByYear, sharePercent, defaultVolumeValue, defaultVolumeUnit, contractColumn, yearsForOverride, yearsForShare]);

  const savedStateSignature = useMemo(
    () => partVolumeStateSignature(partVolumeStateFromPart(part, !!contractColumn)),
    [
      part,
      contractColumn,
      part.volume_mode,
      part.volume_share_percent,
      part.volume_share_by_year,
      part.volume_by_year,
      part.default_volume_value,
      part.default_volume_unit,
      part.contract_volume_mode,
      part.contract_volume_share_percent,
      part.volume_contract_share_by_year,
      part.volume_contract_by_year,
      part.contract_default_volume_value,
      part.contract_default_volume_unit,
    ]
  );
  const currentStateSignature = useMemo(
    () =>
      partVolumeStateSignature({
        mode,
        sharePercent,
        shareByYear,
        volumeByYear,
        defaultVolumeValue,
        defaultVolumeUnit,
      }),
    [mode, sharePercent, shareByYear, volumeByYear, defaultVolumeValue, defaultVolumeUnit]
  );
  const isDirty = currentStateSignature !== savedStateSignature;

  const getEffectiveShareForYear = (year: number): number => {
    const fromYear = shareByYear[year];
    if (fromYear !== undefined && fromYear !== '' && !isNaN(Number(fromYear))) return Math.max(0, Math.min(100, Number(fromYear)));
    if (sharePercent !== '' && !isNaN(Number(sharePercent))) return Math.max(0, Math.min(100, Number(sharePercent)));
    return 0;
  };

  const shareZeroProjectVolumeYears = useMemo(() => {
    if (mode !== 'share') return [] as number[];
    const years: number[] = [];
    for (const y of yearsForShare) {
      const pct = getEffectiveShareForYear(y);
      if (pct <= 0) continue;
      const pv = projVol.find((p) => p.year === y);
      const projectVol = pv != null ? Number(pv.volume_value) : 0;
      if (!Number.isFinite(projectVol) || projectVol <= 0) years.push(y);
    }
    return years;
  }, [mode, yearsForShare, projVol, shareByYear, sharePercent]);

  const setShareForYear = (year: number, value: string) => {
    setShareByYear((prev) => {
      const next = { ...prev, [year]: value };
      saveStateRef.current = { ...saveStateRef.current, shareByYear: next };
      return next;
    });
    scheduleAutoSave();
  };

  const assignedVolumeText = (() => {
    const ovRows = volumeByYear;
    if (mode === 'override') {
      const hasDefault = defaultVolumeValue !== '' && !isNaN(Number(defaultVolumeValue)) && Number(defaultVolumeValue) > 0;
      if (ovRows.length > 0 && !hasDefault) {
        const sum = ovRows.reduce((a, v) => a + toAnnual(v.volume_value, v.volume_unit), 0);
        const first = ovRows[0];
        if (ovRows.length === 1) {
          return t('projectDetailExtra.assignedOverrideSingleYear', {
            value: Math.round(first.volume_value),
            unit: volUnit(first.volume_unit),
            year: first.year,
          });
        }
        return t('projectDetailExtra.assignedOverrideMultiYears', {
          count: ovRows.length,
          avg: Math.round(sum / ovRows.length),
        });
      }
      if (hasDefault && ovRows.length === 0) {
        const v = Number(defaultVolumeValue);
        return t('projectDetailExtra.assignedOverrideDefaultOnly', {
          value: Math.round(v),
          unit: volUnit(defaultVolumeUnit),
        });
      }
      if (hasDefault && ovRows.length > 0) {
        const v = Number(defaultVolumeValue);
        return t('projectDetailExtra.assignedOverrideDefaultWithOverrides', {
          value: Math.round(v),
          unit: volUnit(defaultVolumeUnit),
          count: ovRows.length,
        });
      }
    }
    if (mode === 'share') {
      const displayYear = projVol[0]?.year ?? yearsForShare[0];
      const pv = projVol.find((p) => p.year === displayYear);
      const pct = getEffectiveShareForYear(displayYear);
      if (pv && (pct > 0 || sharePercent !== '' || shareByYear[displayYear] !== undefined)) {
        const v = pv.volume_value * (pct / 100);
        return t('projectDetailExtra.assignedShareDefaultPct', {
          value: Math.round(v),
          unit: volUnit(pv.volume_unit),
          year: displayYear,
          percent: sharePercent || t('common.dash'),
        });
      }
      if (projVol.length > 0 && sharePercent !== '') {
        const first = projVol[0];
        const v = first.volume_value * (Number(sharePercent) / 100);
        return t('projectDetailExtra.assignedShareProjectPct', {
          value: Math.round(v),
          unit: volUnit(first.volume_unit),
          year: first.year,
          percent: sharePercent,
        });
      }
    }
    if ((mode === 'project' || !mode) && projVol.length > 0) {
      const first = projVol[0];
      return t('projectDetailExtra.assignedFromProject', {
        value: Math.round(first.volume_value),
        unit: volUnit(first.volume_unit),
        year: first.year,
      });
    }
    return null;
  })();

  const savePart = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (saveFeedbackTimerRef.current) {
      clearTimeout(saveFeedbackTimerRef.current);
      saveFeedbackTimerRef.current = null;
    }
    if (savingRef.current) return Promise.resolve();
    const {
      mode: saveMode,
      shareByYear: saveShareByYear,
      volumeByYear: saveVolumeByYear,
      sharePercent: saveSharePercent,
      defaultVolumeValue: saveDefaultVolumeValue,
      defaultVolumeUnit: saveDefaultVolumeUnit,
      contractColumn: saveContractColumn,
    } = saveStateRef.current;
    setSaveFeedback(null);
    savingRef.current = true;
    setSaving(true);
    const shareByYearArray = Object.entries(saveShareByYear)
      .filter(([, v]) => v !== '' && !isNaN(Number(v)))
      .map(([year, share_percent]) => ({ year: Number(year), share_percent: Number(share_percent) }));
    const defaultVal =
      saveMode === 'override' && saveDefaultVolumeValue !== '' && !isNaN(Number(saveDefaultVolumeValue))
        ? Number(saveDefaultVolumeValue)
        : null;
    const defaultUn = saveMode === 'override' && defaultVal != null ? saveDefaultVolumeUnit : null;
    const volumesToSave =
      saveMode === 'override' && saveVolumeByYear.length > 0
        ? saveVolumeByYear.map((row) => ({ ...row, volume_origin: row.volume_origin ?? 'manual_year' }))
        : [];
    const volumesToSaveContract =
      saveMode === 'override' && saveVolumeByYear.length > 0
        ? saveVolumeByYear.map((row) => ({ ...row, volume_origin: row.volume_origin ?? 'manual_year' }))
        : [];
    const promise = saveContractColumn
      ? (() => {
          const updateBody: Record<string, unknown> = {
            contract_volume_mode: saveMode,
            contract_volume_share_percent: saveMode === 'share' && saveSharePercent !== '' ? Number(saveSharePercent) : null,
            contract_volume_share_by_year: saveMode === 'share' ? shareByYearArray : [],
            contract_default_volume_value: defaultVal,
            contract_default_volume_unit: defaultUn,
          };
          const p = api.projects.updatePart(projectId, part.id, updateBody);
          return p.then(() =>
            api.projects.setPartVolumesContract(
              projectId,
              part.id,
              saveMode === 'override' ? volumesToSaveContract : []
            )
          );
        })()
      : api.projects
          .updatePart(projectId, part.id, {
            volume_mode: saveMode,
            volume_share_percent: saveMode === 'share' && saveSharePercent !== '' ? Number(saveSharePercent) : null,
            volume_share_by_year: saveMode === 'share' ? shareByYearArray : [],
            default_volume_value: defaultVal,
            default_volume_unit: defaultUn,
          })
          .then(() => api.projects.setPartVolumes(projectId, part.id, volumesToSave));
    return promise
      .then(() => {
        setSaveFeedback({
          type: 'success',
          text: saveContractColumn ? t('projectDetailExtra.contractSaved') : t('projectDetailExtra.changesSaved'),
        });
        saveFeedbackTimerRef.current = setTimeout(() => setSaveFeedback(null), 2500);
        onUpdate();
      })
      .catch((e: any) => {
        setSaveFeedback({
          type: 'error',
          text: e?.message || (saveContractColumn ? t('projectDetailExtra.saveFailed') : t('projectDetailExtra.saveChangesFailed')),
        });
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }, [contractColumn, onUpdate, part.id, projectId, t]);

  const scheduleAutoSave = useCallback(() => {
    if (!volumesAutosaveEnabled) return;
    const { mode: saveMode } = saveStateRef.current;
    if (saveMode !== 'share' && saveMode !== 'override') return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void savePart();
    }, 700);
  }, [savePart, volumesAutosaveEnabled]);

  const flushAutoSave = useCallback(() => {
    if (!volumesAutosaveEnabled) return;
    const { mode: saveMode } = saveStateRef.current;
    if (saveMode !== 'share' && saveMode !== 'override') return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    void savePart();
  }, [savePart, volumesAutosaveEnabled]);

  const updateYearRow = (year: number, field: string, val: number | string) => {
    setVolumeByYear((prev) => {
      const idx = prev.findIndex((r) => r.year === year);
      const next =
        idx >= 0
          ? prev.map((r) => (r.year === year ? { ...r, [field]: val, volume_origin: 'manual_year' as const } : r))
          : [
              ...prev,
              {
                year,
                volume_value: field === 'volume_value' ? Number(val) : 0,
                volume_unit: field === 'volume_unit' ? (val as string) : 'annual',
                volume_origin: 'manual_year' as const,
              },
            ].sort((a, b) => a.year - b.year);
      saveStateRef.current = { ...saveStateRef.current, volumeByYear: next };
      return next;
    });
    scheduleAutoSave();
  };
  const getRowForYear = (year: number) => volumeByYear.find((r) => r.year === year) ?? { year, volume_value: 0, volume_unit: 'annual' as const };

  const applyDefaultVolumeToAllYearsInTable = () => {
    const v = Number(defaultVolumeValue);
    if (defaultVolumeValue === '' || isNaN(v) || v < 0) {
      window.alert(t('projectDetailExtra.defaultValueNonNegative'));
      return;
    }
    if (yearsForOverride.length === 0) {
      window.alert(t('projectDetailExtra.noYearsInTable'));
      return;
    }
    const unit = defaultVolumeUnit;
    const wouldOverwrite = yearsForOverride.some((year) => {
      const r = volumeByYear.find((row) => row.year === year);
      if (!r) return false;
      return r.volume_value !== v || r.volume_unit !== unit;
    });
    if (wouldOverwrite && !window.confirm(t('projectDetailExtra.overwriteAllYears'))) return;
    setVolumeByYear([]);
    saveStateRef.current = { ...saveStateRef.current, volumeByYear: [] };
    scheduleAutoSave();
  };

  const addPartVolumeYear = () => {
    if (contractColumn || (mode !== 'share' && mode !== 'override')) return;
    const year = newPartYear;
    if (!Number.isInteger(year) || year < 1900) return;
    if (displayYears.includes(year)) {
      window.alert(t('projectDetailExtra.partYearAlreadyInTable'));
      return;
    }
    const extendsEop = eopYear != null && year > eopYear;
    const newEop = `12.${year}`;
    if (extendsEop) {
      if (!window.confirm(t('projectDetailExtra.partAddYearEopConfirm', { year, currentEop: eop ?? t('common.dash'), newEop }))) return;
    }
    setAddingYear(true);
    api.projects
      .addPartVolumeYear(projectId, part.id, year)
      .then(() => {
        setNewPartYear(year + 1);
        onUpdate();
      })
      .catch((e: any) => window.alert(e?.message || t('projectDetailExtra.partAddYearFailed')))
      .finally(() => setAddingYear(false));
  };

  const importPastedVolumes = async () => {
    if (mode !== 'override') return;
    const rows = parseYearValuePaste(pasteText);
    if (rows.length === 0) {
      window.alert(t('projectDetailExtra.partVolumePasteEmpty'));
      return;
    }
    const knownYears = new Set(yearsForOverride);
    const missingYears = rows.map((r) => r.year).filter((year) => !knownYears.has(year));
    const uniqueMissing = [...new Set(missingYears)].sort((a, b) => a - b);
    const maxMissingBeyondEop = uniqueMissing.filter((year) => eopYear != null && year > eopYear);
    if (maxMissingBeyondEop.length > 0) {
      const maxYear = Math.max(...maxMissingBeyondEop);
      const newEop = `12.${maxYear}`;
      if (
        !window.confirm(
          t('projectDetailExtra.partVolumePasteEopConfirm', {
            years: uniqueMissing.join(', '),
            currentEop: eop ?? t('common.dash'),
            newEop,
          })
        )
      ) {
        return;
      }
    }
    setImportingPaste(true);
    try {
      const volumeSide = contractColumn ? 'contract' : 'production';
      const savedMode = contractColumn ? part.contract_volume_mode : part.volume_mode;
      if (savedMode !== 'override') {
        await api.projects.updatePart(
          projectId,
          part.id,
          contractColumn ? { contract_volume_mode: 'override' } : { volume_mode: 'override' }
        );
      }
      for (const year of uniqueMissing) {
        await api.projects.addPartVolumeYear(projectId, part.id, year, volumeSide);
      }
      const pastedByYear = new Map(rows.map((r) => [r.year, r.value]));
      const nextYears = [...new Set([...yearsForOverride, ...rows.map((r) => r.year)])].sort((a, b) => a - b);
      const merged = nextYears.map((year) => {
        const existing = volumeByYear.find((r) => r.year === year);
        const pasted = pastedByYear.get(year);
        return {
          year,
          volume_value: pasted !== undefined ? pasted : (existing?.volume_value ?? 0),
          volume_unit: existing?.volume_unit ?? ('annual' as const),
          volume_origin: 'manual_year' as const,
        };
      });
      saveStateRef.current = { ...saveStateRef.current, mode: 'override', volumeByYear: merged, yearsForOverride: nextYears };
      setVolumeByYear(merged);
      setMode('override');
      await savePart();
      setPasteText('');
    } catch (e: any) {
      window.alert(e?.message || t('projectDetailExtra.partVolumePasteFailed'));
    } finally {
      setImportingPaste(false);
    }
  };

  const partAddYearControls =
    !contractColumn && (mode === 'share' || mode === 'override') ? (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8, marginBottom: 4 }}>
        <input
          type="number"
          placeholder={t('projectDetailExtra.yearPlaceholder')}
          value={newPartYear}
          onChange={(e) => setNewPartYear(Number(e.target.value))}
          style={{ width: 70, padding: 4 }}
          title={t('projectDetailExtra.yearNextHint')}
        />
        <button
          type="button"
          onClick={addPartVolumeYear}
          disabled={saving || addingYear}
          style={{
            padding: '0.35rem 0.75rem',
            background: contractColumn ? '#ff9800' : 'var(--cap-green)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: saving || addingYear ? 'default' : 'pointer',
          }}
        >
          {addingYear ? t('common.saving') : t('projectDetailExtra.addYear')}
        </button>
      </div>
    ) : null;

  useEffect(() => {
    if (contractColumn) {
      setMode(part.contract_volume_mode ?? 'project');
      setSharePercent(part.contract_volume_share_percent != null ? String(part.contract_volume_share_percent) : '');
      const byC: Record<number, string> = {};
      (part.volume_contract_share_by_year ?? []).forEach((r: { year: number; share_percent: number }) => {
        byC[r.year] = String(r.share_percent);
      });
      setShareByYear(byC);
      setVolumeByYear(
        (part.volume_contract_by_year ?? []).map((r: any) => ({ ...r, volume_origin: normalizeVolumeOrigin(r.volume_origin) }))
      );
      setDefaultVolumeValue(part.contract_default_volume_value != null ? String(part.contract_default_volume_value) : '');
      setDefaultVolumeUnit(
        part.contract_default_volume_unit && ['annual', 'monthly', 'weekly'].includes(part.contract_default_volume_unit)
          ? part.contract_default_volume_unit
          : 'annual'
      );
    } else {
      setMode(part.volume_mode ?? 'project');
      setSharePercent(part.volume_share_percent != null ? String(part.volume_share_percent) : '');
      const byYear: Record<number, string> = {};
      (part.volume_share_by_year ?? []).forEach((r: { year: number; share_percent: number }) => {
        byYear[r.year] = String(r.share_percent);
      });
      setShareByYear(byYear);
      setVolumeByYear((part.volume_by_year ?? []).map((r: any) => ({ ...r, volume_origin: normalizeVolumeOrigin(r.volume_origin) })));
      setDefaultVolumeValue(part.default_volume_value != null ? String(part.default_volume_value) : '');
      setDefaultVolumeUnit(
        part.default_volume_unit && ['annual', 'monthly', 'weekly'].includes(part.default_volume_unit) ? part.default_volume_unit : 'annual'
      );
    }
  }, [
    part.id,
    contractColumn,
    part.volume_mode,
    part.volume_share_percent,
    part.volume_by_year,
    part.volume_share_by_year,
    part.default_volume_value,
    part.default_volume_unit,
    part.contract_volume_mode,
    part.contract_volume_share_percent,
    part.volume_contract_by_year,
    part.volume_contract_share_by_year,
    part.contract_default_volume_value,
    part.contract_default_volume_unit,
  ]);

  useEffect(() => {
    if (mode !== 'override' || yearsForOverride.length === 0) return;
    setVolumeByYear((prev) => {
      const existing = new Set(prev.map((r) => r.year));
      const toAdd = yearsForOverride.filter((y) => !existing.has(y)).map((year) => ({ year, volume_value: 0, volume_unit: 'annual' as const }));
      if (toAdd.length === 0) return prev;
      return [...prev, ...toAdd].sort((a, b) => a.year - b.year);
    });
  }, [mode, yearsForOverride.join(','), contractColumn]);

  useEffect(() => {
    return () => {
      if (saveFeedbackTimerRef.current) clearTimeout(saveFeedbackTimerRef.current);
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  return (
    <div key={contractColumn ? `${part.id}-c` : `${part.id}-p`} style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: '1rem', marginBottom: contractColumn ? 0 : '1rem', background: contractColumn ? '#fffbf5' : '#fafafa', minWidth: 0, maxWidth: '100%' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}{contractColumn ? t('projectDetailExtra.contractColumnSuffix') : ''}</div>
      {!contractColumn && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
          <button
            type="button"
            disabled={saving}
            style={{ padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: '1px solid #bdbdbd', background: '#fff', cursor: saving ? 'default' : 'pointer' }}
            onClick={() => {
              if (!window.confirm(t('projectDetailExtra.copyProdToContractShort'))) return;
              setSaving(true);
              api.projects
                .mirrorPartVolumes(projectId, part.id, 'production_to_contract')
                .then(() => onUpdate())
                .catch((e: Error) => window.alert(e?.message || t('projectDetailExtra.genericError')))
                .finally(() => setSaving(false));
            }}
          >
            {t('projectDetailExtra.arrowToContract')}
          </button>
        </div>
      )}
      {contractColumn && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button
            type="button"
            disabled={saving}
            style={{ padding: '0.25rem 0.55rem', fontSize: 12, borderRadius: 4, border: '1px solid #bdbdbd', background: '#fff', cursor: saving ? 'default' : 'pointer' }}
            onClick={() => {
              if (!window.confirm(t('projectDetailExtra.copyContractToProdShort'))) return;
              setSaving(true);
              api.projects
                .mirrorPartVolumes(projectId, part.id, 'contract_to_production')
                .then(() => onUpdate())
                .catch((e: Error) => window.alert(e?.message || t('projectDetailExtra.genericError')))
                .finally(() => setSaving(false));
            }}
          >
            {t('projectDetailExtra.arrowToProduction')}
          </button>
        </div>
      )}
      {assignedVolumeText && (
        <p style={{ margin: '0 0 8px', fontSize: 15, color: contractColumn ? '#e65100' : '#1565c0', fontWeight: 600 }}>
          {contractColumn
            ? t('projectDetailExtra.contractVolumeLabel', { text: assignedVolumeText })
            : t('projectDetailExtra.assignedVolumeLabel', { text: assignedVolumeText })}
        </p>
      )}
      <div className="volume-mode-radios">
        <span>{t('projectDetailExtra.volumeSourceLabel')}</span>
        <label><input type="radio" name={contractColumn ? `volc-${part.id}` : `vol-${part.id}`} checked={mode === 'project'} onChange={() => setMode('project')} /> {t('projectDetailExtra.fromProject')}</label>
        <label><input type="radio" name={contractColumn ? `volc-${part.id}` : `vol-${part.id}`} checked={mode === 'share'} onChange={() => setMode('share')} /> {t('projectDetailExtra.sharePercent')}</label>
        <label><input type="radio" name={contractColumn ? `volc-${part.id}` : `vol-${part.id}`} checked={mode === 'override'} onChange={() => setMode('override')} /> {t('projectDetailExtra.ownValue')}</label>
      </div>
      {mode === 'share' && (
        <div style={{ marginBottom: 8 }}>
          {shareZeroProjectVolumeYears.length > 0 && (
            <p
              role="alert"
              style={{
                margin: '0 0 10px',
                padding: '8px 10px',
                background: '#fff3e0',
                border: '1px solid #ffb74d',
                borderRadius: 6,
                fontSize: 13,
                color: '#e65100',
                lineHeight: 1.45,
              }}
            >
              {t('projectDetailExtra.shareZeroProjectVolumeWarning', {
                years: shareZeroProjectVolumeYears.join(', '),
              })}
            </p>
          )}
          <div style={{ marginBottom: 10, padding: '8px 10px', background: contractColumn ? '#fff3e0' : '#f0f7ff', borderRadius: 6 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{t('projectDetailExtra.defaultForAllYears')}</div>
            <label>{t('projectDetailExtra.sharePercentLabel')} <input type="number" min={0} max={100} step={0.1} value={sharePercent} onChange={(e) => { const v = e.target.value; setSharePercent(v); saveStateRef.current = { ...saveStateRef.current, sharePercent: v }; scheduleAutoSave(); }} onBlur={flushAutoSave} style={{ width: 80, marginLeft: 4, padding: 4 }} /></label>
          </div>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{t('projectDetailExtra.perYearSeparate')}</div>
          <div className="volumes-table-wrap">
          <table style={{ borderCollapse: 'collapse', marginBottom: 4 }}>
            <thead><tr style={{ background: '#eee' }}><th style={{ padding: 4 }}>{t('common.year')}</th><th style={{ padding: 4 }}>{t('projectDetailExtra.shareCol')}</th></tr></thead>
            <tbody>
              {yearsForShare.map((y) => {
                const zeroProjectVol = shareZeroProjectVolumeYears.includes(y);
                return (
                <tr key={y} style={zeroProjectVol ? { background: '#fff8e1' } : undefined}>
                  <td style={{ padding: 4 }}>
                    {y}
                    {zeroProjectVol && (
                      <span style={{ display: 'block', fontSize: 11, color: '#e65100', fontWeight: 600 }}>
                        {t('projectDetailExtra.shareZeroProjectVolumeRowHint')}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: 4 }}>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={shareByYear[y] ?? ''}
                      onChange={(e) => setShareForYear(y, e.target.value)}
                      onBlur={flushAutoSave}
                      placeholder={sharePercent !== '' ? sharePercent : '—'}
                      style={{ width: 90 }}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {yearsForShare.length === 0 && <p style={{ fontSize: 12, color: '#888' }}>{t('projectDetailExtra.noYearsInTable')}</p>}
          {partAddYearControls}
        </div>
      )}
      {mode === 'override' && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ marginBottom: 12, padding: '8px 10px', background: contractColumn ? '#fff3e0' : '#f0f7ff', borderRadius: 6 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{t('projectDetailExtra.defaultValueAllYears')}</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label>
                {t('common.value')}:{' '}
                <input type="number" min={0} value={defaultVolumeValue} onChange={(e) => { const v = e.target.value; setDefaultVolumeValue(v); saveStateRef.current = { ...saveStateRef.current, defaultVolumeValue: v }; scheduleAutoSave(); }} onBlur={flushAutoSave} style={{ width: 100, padding: 4 }} />
              </label>
              <label>
                {t('common.unit')}:{' '}
                <SearchableSelect value={defaultVolumeUnit} onChange={(e) => { const u = e.target.value as 'annual' | 'monthly' | 'weekly'; setDefaultVolumeUnit(u); saveStateRef.current = { ...saveStateRef.current, defaultVolumeUnit: u }; scheduleAutoSave(); }} onBlur={flushAutoSave} style={{ padding: 4 }}>
                  <option value="annual">{t('common.unitAnnual')}</option>
                  <option value="monthly">{t('common.unitMonthly')}</option>
                  <option value="weekly">{t('common.unitWeekly')}</option>
                </SearchableSelect>
              </label>
            </div>
            <button
              type="button"
              onClick={applyDefaultVolumeToAllYearsInTable}
              disabled={saving || yearsForOverride.length === 0}
              style={{
                marginTop: 10,
                padding: '0.35rem 0.75rem',
                fontSize: 13,
                background: contractColumn ? '#ff9800' : 'var(--cap-green)',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: saving || yearsForOverride.length === 0 ? 'default' : 'pointer',
              }}
            >
              {t('projectDetailExtra.applyToAllTableBelow')}
            </button>
          </div>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{t('projectDetailExtra.perYearSeparate')}</div>
          <div style={{ marginBottom: 10, padding: '8px 10px', background: contractColumn ? '#fff8e1' : '#f5f5f5', borderRadius: 6 }}>
            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{t('projectDetailExtra.partVolumePasteTitle')}</div>
            <p style={{ margin: '0 0 6px', fontSize: 12, color: '#666' }}>{t('projectDetailExtra.partVolumePasteHint')}</p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={t('projectDetailExtra.partVolumePastePlaceholder')}
              rows={4}
              style={{ width: '100%', maxWidth: 420, padding: 8, fontFamily: 'monospace', fontSize: 13, boxSizing: 'border-box' }}
            />
            <button
              type="button"
              onClick={() => void importPastedVolumes()}
              disabled={saving || importingPaste || !pasteText.trim()}
              style={{
                marginTop: 6,
                padding: '0.35rem 0.75rem',
                fontSize: 13,
                background: contractColumn ? '#ff9800' : 'var(--cap-green)',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: saving || importingPaste || !pasteText.trim() ? 'default' : 'pointer',
              }}
            >
              {importingPaste ? t('common.saving') : t('projectDetailExtra.partVolumePasteBtn')}
            </button>
          </div>
          <div className="volumes-table-wrap">
          <table style={{ borderCollapse: 'collapse', marginBottom: 4 }}>
            <thead><tr style={{ background: '#eee' }}><th style={{ padding: 4 }}>{t('common.year')}</th><th style={{ padding: 4 }}>{t('common.value')}</th><th style={{ padding: 4 }}>{t('common.unit')}</th></tr></thead>
            <tbody>
              {yearsForOverride.map((year) => {
                const r = getRowForYear(year);
                const rowOrigin = normalizeVolumeOrigin(r.volume_origin);
                return (
                  <tr key={year}>
                    <td style={{ padding: 4 }}>{year}</td>
                    <td style={{ padding: 4 }}>
                      <ZeroClearNumberInput value={r.volume_value} onChange={(n) => updateYearRow(year, 'volume_value', n)} onBlur={flushAutoSave} style={{ width: 90 }} />
                      {rowOrigin === 'manual_year' && (
                        <span style={{ marginLeft: 6, color: '#c62828', fontWeight: 600, fontSize: 12 }} title={t('projectDetailExtra.manualYearOverride')}>
                          {t('projectDetailExtra.manualYearOverrideShort')}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: 4 }}>
                      <SearchableSelect value={r.volume_unit} onChange={(e) => updateYearRow(year, 'volume_unit', e.target.value)} onBlur={flushAutoSave}>
                        <option value="annual">{t('common.unitAnnual')}</option>
                        <option value="monthly">{t('common.unitMonthly')}</option>
                        <option value="weekly">{t('common.unitWeekly')}</option>
                      </SearchableSelect>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {yearsForOverride.length === 0 && <p style={{ fontSize: 12, color: '#888' }}>{t('projectDetailExtra.noYearsInTable')}</p>}
          {partAddYearControls}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => void savePart()} disabled={saving} style={{ padding: '0.35rem 0.75rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {isDirty && !saving && (
          <span style={{ fontSize: 13, color: '#e65100', fontWeight: 600 }}>{t('projectDetailExtra.unsavedChanges')}</span>
        )}
        {saveFeedback && (
          <span style={{ fontSize: 13, color: saveFeedback.type === 'success' ? '#2e7d32' : '#c62828', fontWeight: 600 }}>
            {saveFeedback.text}
          </span>
        )}
      </div>
    </div>
  );
}

function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function ProjectAttachmentsTab({
  project,
  onChanged,
}: {
  project: { id: number; client?: string; name?: string; status?: string };
  onChanged: () => void;
}) {
  const { t, te } = useI18n();
  const { hasPermission } = useAuth();
  const canDownload = canDownloadProjectAttachments(hasPermission);
  const canUpload = canEditProjectContent(hasPermission, project.status);
  const canDelete = hasPermission('projects.delete');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [storageConfigured, setStorageConfigured] = useState(false);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [description, setDescription] = useState('');
  const [isShared, setIsShared] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAttachments = useCallback(() => {
    setLoading(true);
    setError('');
    return api.projects
      .getAttachments(project.id)
      .then((data) => {
        setStorageConfigured(!!data.storage_configured);
        setAttachments(data.attachments ?? []);
      })
      .catch((e: Error) => setError(te(e?.message) || t('common.loadError')))
      .finally(() => setLoading(false));
  }, [project.id, t, te]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const setFileWithPreview = (file: File | null) => {
    setSelectedFile(file);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      if (!file || !file.type.startsWith('image/')) return null;
      return URL.createObjectURL(file);
    });
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const ext = item.type.split('/')[1] || 'png';
          const named = new File([file], `screenshot-${Date.now()}.${ext}`, { type: item.type });
          setFileWithPreview(named);
          e.preventDefault();
        }
        break;
      }
    }
  };

  const upload = () => {
    if (!selectedFile) {
      setError(t('projectDetailExtra.attachmentNoFile'));
      return;
    }
    setUploading(true);
    setError('');
    api.projects
      .uploadAttachment(project.id, selectedFile, description.trim(), isShared)
      .then(() => {
        setDescription('');
        setIsShared(false);
        setFileWithPreview(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return loadAttachments().then(() => {
          onChanged();
        });
      })
      .catch((e: Error) => setError(te(e?.message) || t('common.saveError')))
      .finally(() => setUploading(false));
  };

  const removeAttachment = (attachment: { id: number; is_shared?: number }) => {
    const msg = attachment.is_shared
      ? t('projectDetailExtra.attachmentSharedDeleteConfirm')
      : t('projectDetailExtra.attachmentDeleteConfirm');
    if (!confirmDelete(msg)) return;
    setError('');
    api.projects
      .deleteAttachment(project.id, attachment.id)
      .then(() => loadAttachments().then(() => onChanged()))
      .catch((e: Error) => setError(te(e?.message) || t('common.saveError')));
  };

  return (
    <div style={{ background: 'white', padding: '1.5rem', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
      <h2 style={{ marginTop: 0 }}>
        {t('projectDetailExtra.attachmentsTitle')}
        <span style={{ display: 'block', fontSize: '1rem', fontWeight: 600, color: 'var(--cap-gray)', marginTop: '0.35rem' }}>
          {projectContextSubtitle(project)}
        </span>
      </h2>
      <p style={{ margin: '0 0 1rem', fontSize: 14, color: '#666', lineHeight: 1.5 }}>{t('projectDetailExtra.attachmentsIntro')}</p>

      {!loading && !storageConfigured && (
        <p style={{ margin: '0 0 1rem', padding: '0.75rem 1rem', background: '#fff3e0', color: '#e65100', borderRadius: 8 }}>
          {t('projectDetailExtra.attachmentsStorageMissing')}
        </p>
      )}

      {error && (
        <p style={{ margin: '0 0 1rem', padding: '0.75rem 1rem', background: '#ffebee', color: '#c62828', borderRadius: 8 }}>{error}</p>
      )}

      {canUpload && (
      <div
        style={{
          marginBottom: '1rem',
          padding: '0.75rem',
          border: '1px dashed #cfd8dc',
          borderRadius: 8,
          background: '#fafbfc',
          opacity: storageConfigured ? 1 : 0.6,
        }}
        onPaste={storageConfigured ? onPaste : undefined}
        tabIndex={storageConfigured ? 0 : -1}
      >
        <label style={{ display: 'block', marginBottom: 8, fontSize: 14 }}>
          {t('projectDetailExtra.attachmentDescriptionPlaceholder')}
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!storageConfigured || uploading}
            placeholder={t('projectDetailExtra.attachmentDescriptionPlaceholder')}
            style={{ display: 'block', width: '100%', marginTop: 4, padding: '0.5rem' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 8, fontSize: 14 }}>
          {t('projectDetailExtra.attachmentFileLabel')}
          <input
            ref={fileInputRef}
            type="file"
            disabled={!storageConfigured || uploading}
            onChange={(e) => setFileWithPreview(e.target.files?.[0] ?? null)}
            style={{ display: 'block', marginTop: 4 }}
          />
        </label>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#777' }}>{t('projectDetailExtra.attachmentPasteHint')}</p>
        {previewUrl && (
          <div style={{ marginBottom: 8 }}>
            <img src={previewUrl} alt="" style={{ maxWidth: 280, maxHeight: 180, border: '1px solid #ddd', borderRadius: 4 }} />
          </div>
        )}
        {selectedFile && !previewUrl && (
          <p style={{ margin: '0 0 8px', fontSize: 13, color: '#444' }}>
            {selectedFile.name} ({formatAttachmentSize(selectedFile.size)})
          </p>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 14, cursor: storageConfigured ? 'pointer' : 'default' }}>
          <input
            type="checkbox"
            checked={isShared}
            onChange={(e) => setIsShared(e.target.checked)}
            disabled={!storageConfigured || uploading}
          />
          <span>{t('projectDetailExtra.attachmentSharedLabel')}</span>
        </label>
        <button
          type="button"
          onClick={upload}
          disabled={!storageConfigured || uploading}
          style={{ padding: '0.5rem 1rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}
        >
          {uploading ? t('projectDetailExtra.attachmentUploading') : t('projectDetailExtra.attachmentAddBtn')}
        </button>
      </div>
      )}

      {loading ? (
        <p>{t('common.loading')}</p>
      ) : attachments.length === 0 ? (
        <p style={{ color: '#666' }}>{t('projectDetailExtra.attachmentEmpty')}</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
              <th style={{ padding: '0.75rem' }}>{t('projectDetailExtra.attachmentColDate')}</th>
              <th style={{ padding: '0.75rem' }}>{t('projectDetailExtra.attachmentColFile')}</th>
              <th style={{ padding: '0.75rem' }}>{t('projectDetailExtra.attachmentColDescription')}</th>
              <th style={{ padding: '0.75rem' }}>{t('projectDetailExtra.attachmentColAuthor')}</th>
              <th style={{ padding: '0.75rem' }}>{t('projectDetailExtra.attachmentColSize')}</th>
              <th style={{ padding: '0.75rem' }}></th>
            </tr>
          </thead>
          <tbody>
            {attachments.map((a) => (
              <tr key={a.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '0.75rem', whiteSpace: 'nowrap' }}>{formatAttachmentDate(a.uploaded_at)}</td>
                <td style={{ padding: '0.75rem' }}>
                  {a.original_filename}
                  {!!a.is_shared && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        fontWeight: 600,
                        color: '#1565c0',
                        background: '#e3f2fd',
                        padding: '2px 6px',
                        borderRadius: 4,
                      }}
                    >
                      {t('projectDetailExtra.attachmentSharedBadge')}
                    </span>
                  )}
                </td>
                <td style={{ padding: '0.75rem' }}>{a.description || '—'}</td>
                <td style={{ padding: '0.75rem' }}>{a.uploaded_by || '—'}</td>
                <td style={{ padding: '0.75rem', whiteSpace: 'nowrap' }}>{formatAttachmentSize(Number(a.size_bytes))}</td>
                <td style={{ padding: '0.75rem', whiteSpace: 'nowrap' }}>
                  {canDownload ? (
                    <a
                      href={api.projects.attachmentDownloadUrl(project.id, a.id)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ marginRight: 10, color: 'var(--cap-green)' }}
                    >
                      {t('projectDetailExtra.attachmentDownload')}
                    </a>
                  ) : (
                    <span
                      style={{ marginRight: 10, color: '#999', fontSize: 12 }}
                      title={t('projectDetailExtra.attachmentDownloadDenied')}
                    >
                      {t('projectDetailExtra.attachmentDownloadDeniedShort')}
                    </span>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => removeAttachment(a)}
                      style={{ padding: '2px 8px', fontSize: 12, background: '#c62828', color: 'white', border: 'none', borderRadius: 4 }}
                    >
                      {t('projectDetailExtra.attachmentDelete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AddNoteForm({ projectId, onAdded }: { projectId: number; onAdded: () => void }) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const save = () => {
    if (!note.trim()) return;
    api.projects.addNote(projectId, { note: note.trim() }).then(() => { setNote(''); onAdded(); });
  };
  return (
    <div style={{ marginBottom: '1rem', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <input type="text" placeholder={t('projectDetailExtra.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} style={{ padding: '0.5rem', flex: 1 }} />
      <button onClick={save} style={{ padding: '0.5rem 1rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetailExtra.newNoteBtn')}</button>
    </div>
  );
}

function OperationModal({
  projectId,
  parts,
  phases,
  projectVolumeContext,
  edit,
  onClose,
  onSaved,
}: {
  projectId: number;
  parts: any[];
  phases: any[];
  projectVolumeContext: ProjectVolumeContext;
  edit?: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { referenceDisplay, machineDisplay } = useReferenceDisplay();
  const setMemberKey = (m: { part_id?: number; designation_id?: number }) => {
    if (m.part_id != null) return `p:${Number(m.part_id)}`;
    if (m.designation_id != null) return `d:${Number(m.designation_id)}`;
    return '';
  };
  const currentYear = new Date().getFullYear();
  const yearsPreviewCount = 6;
  const [partsList, setPartsList] = useState(parts);
  const [part_id, setPart_id] = useState(edit?.part_id ?? (parts[0]?.id));
  const [phase_id, setPhase_id] = useState(edit?.phase_id ?? (phases[0]?.id));
  const [machine_id, setMachine_id] = useState(edit?.machine_id ?? '');
  const [cycle_time_seconds, setCycle_time_seconds] = useState(edit?.cycle_time_seconds ?? 60);
  const [nests_count, setNests_count] = useState(edit?.nests_count ?? 1);
  const [oee_override, setOee_override] = useState(edit?.oee_override != null ? String(Math.round(edit.oee_override * 100)) : '');
  const [alt_cycle_time_seconds, setAlt_cycle_time_seconds] = useState<number | ''>(
    edit?.alt_cycle_time_seconds != null && Number(edit.alt_cycle_time_seconds) > 0 ? Number(edit.alt_cycle_time_seconds) : ''
  );
  const [alt_nests_count, setAlt_nests_count] = useState<number | ''>(
    edit?.alt_nests_count != null && Number(edit.alt_nests_count) > 0 ? Number(edit.alt_nests_count) : ''
  );
  const [alt_oee_override, setAlt_oee_override] = useState(
    edit?.alt_oee_override != null ? String(Math.round(edit.alt_oee_override * 100)) : ''
  );
  const [alt_comment, setAlt_comment] = useState(edit?.alt_comment != null ? String(edit.alt_comment) : '');
  const [use_alternative_in_calculator, setUse_alternative_in_calculator] = useState(
    !!(edit?.use_alternative_in_calculator === 1 || edit?.use_alternative_in_calculator === true)
  );
  const [machines, setMachines] = useState<any[]>([]);
  const [freeCapacityByYear, setFreeCapacityByYear] = useState<{ year: number; load: number; free: number }[]>([]);
  const [freeCapacityLoading, setFreeCapacityLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  type OperationCopyRow = {
    id: number;
    machine_id: number;
    phase_id: number;
    cycle_time_seconds: number;
    nests_count: number;
    oee_override: number | null;
    is_set: number;
    alt_cycle_time_seconds: number | null;
    alt_nests_count: number | null;
    alt_oee_override: number | null;
    alt_comment: string | null;
    use_alternative_in_calculator: number;
    label: string;
    project_client?: string;
    project_name?: string;
    detail_sap_number?: string | null;
    detail_alias?: string | null;
    detail_free_text?: string | null;
    phase_name?: string;
    machine_internal?: number | string;
    machine_type?: string | null;
    set_designation_ids?: number[] | null;
    source_designation_id?: number | null;
  };
  const [copyRows, setCopyRows] = useState<OperationCopyRow[]>([]);
  const [copyLoading, setCopyLoading] = useState(false);
  const [copySearchLoading, setCopySearchLoading] = useState(false);
  const copyRowsRef = useRef<OperationCopyRow[]>([]);
  const [copyPickId, setCopyPickId] = useState('');
  const [copyApplied, setCopyApplied] = useState<string | null>(null);
  const [showNewDetail, setShowNewDetail] = useState(false);
  const [detailSearchBy, setDetailSearchBy] = useState<'sap' | 'alias'>('sap');
  const [selectedDetailId, setSelectedDetailId] = useState<number | ''>(() => (edit && edit.part_id ? (parts.find((p: any) => p.id === edit.part_id)?.designation_id ?? '') : ''));
  const [newDetailSap, setNewDetailSap] = useState('');
  const [newDetailAlias, setNewDetailAlias] = useState('');
  const [newDetailFreeText, setNewDetailFreeText] = useState('');
  const [designations, setDesignations] = useState<{ id: number; designation?: string; sap_number?: string | null; alias?: string | null; free_text?: string | null }[]>([]);
  const [isSet, setIsSet] = useState(!!edit?.is_set);
  const [setSearchBy, setSetSearchBy] = useState<'sap' | 'alias'>('sap');
  const [setMembers, setSetMembers] = useState<{ part_id?: number; designation_id?: number; label: string }[]>(() => {
    if (edit?.set_members?.length) {
      return edit.set_members.map((m: any) => {
        const part = parts.find((p: any) => p.id === m.part_id);
        return {
          part_id: m.part_id,
          designation_id: part?.designation_id,
          label: m.label || String(m.part_id),
        };
      });
    }
    return [];
  });
  const [setAddDesignationId, setSetAddDesignationId] = useState<number | ''>('');
  const [setVolumeSourceKey, setSetVolumeSourceKey] = useState<string>('');

  const resolvedVolumeSourcePart = useMemo(() => {
    if (!isSet || !setVolumeSourceKey) return null;
    const member = setMembers.find((m) => setMemberKey(m) === setVolumeSourceKey);
    if (!member) return null;
    if (member.part_id != null) {
      return partsList.find((p) => Number(p.id) === Number(member.part_id)) ?? null;
    }
    if (member.designation_id != null) {
      return partsList.find((p) => Number(p.designation_id) === Number(member.designation_id)) ?? null;
    }
    return null;
  }, [isSet, setVolumeSourceKey, setMembers, partsList]);

  const volumeSourcePartMissingVolume = useMemo(() => {
    if (!resolvedVolumeSourcePart) return false;
    return !partHasPositiveVolumeInSopEopRange(resolvedVolumeSourcePart, projectVolumeContext);
  }, [resolvedVolumeSourcePart, projectVolumeContext]);

  const designationListFilter = (d: { sap_number?: string | null; alias?: string | null; free_text?: string | null }, by: 'sap' | 'alias') => {
    const sap = (d.sap_number ?? '').trim();
    const alias = (d.alias ?? '').trim();
    const free = (d.free_text ?? '').trim();
    if (by === 'sap') return Boolean(sap || free);
    return Boolean(alias || free);
  };

  const detailFieldDisplay = (value: string | null | undefined, formatSap = false) => {
    const s = value != null ? String(value).trim() : '';
    if (!s) return t('designations.emptyValue');
    return formatSap ? formatSapNumberForDisplay(value) : s;
  };

  const selectedDetail = selectedDetailId ? designations.find((d) => d.id === Number(selectedDetailId)) : null;
  /** Etykieta listy detalu wg wyboru „Nr SAP” / „Alias” w tym modalu (nie z ustawień wizualnych). */
  const designationChooserLabel = (
    d: { id?: number; sap_number?: string | null; alias?: string | null; free_text?: string | null; designation?: string | null },
    by: 'sap' | 'alias',
  ) => {
    const raw = formatDetailSapAliasLabel(
      {
        sap_number: d.sap_number,
        alias: d.alias,
        free_text: d.free_text,
        designation: d.designation,
        id: d.id,
      },
      by === 'sap' ? 'sap' : 'alias',
    );
    return String(raw).replace(/\s*\(#\d+\)\s*$/u, '').trim() || '—';
  };

  useEffect(() => { setPartsList(parts); if (edit?.part_id) setPart_id(edit.part_id); }, [parts, edit?.part_id]);
  useEffect(() => {
    if (edit?.part_id && !edit?.is_set) setSelectedDetailId(parts.find((p: any) => p.id === edit.part_id)?.designation_id ?? '');
  }, [edit?.part_id, edit?.is_set, parts]);
  useEffect(() => {
    if (edit?.is_set && edit?.set_members?.length) {
      setSetMembers(
        edit.set_members.map((m: any) => {
          const part = parts.find((p: any) => p.id === m.part_id);
          return {
            part_id: m.part_id,
            designation_id: part?.designation_id,
            label: m.label || String(m.part_id),
          };
        })
      );
    }
  }, [edit?.id, parts]);
  useEffect(() => {
    if (!isSet) {
      setSetVolumeSourceKey('');
      return;
    }
    setSetVolumeSourceKey((prev) => {
      const selectedStillExists = prev && setMembers.some((m) => setMemberKey(m) === prev);
      if (selectedStillExists) return prev;
      const fromEdit = edit?.part_id != null ? setMembers.find((m) => Number(m.part_id) === Number(edit.part_id)) : undefined;
      if (fromEdit) return setMemberKey(fromEdit);
      if (setMembers[0]) return setMemberKey(setMembers[0]);
      return '';
    });
  }, [isSet, setMembers, edit?.part_id]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.machines.list({ status: 'active' }), api.machines.list({ status: 'RFQ' })])
      .then(([activeList, rfqList]) => {
        if (cancelled) return;
        const byId = new Map<number, any>();
        for (const m of activeList) byId.set(Number(m.id), m);
        for (const m of rfqList) byId.set(Number(m.id), m);
        const merged = [...byId.values()].sort(
          (a, b) => Number(a.internal_number ?? 0) - Number(b.internal_number ?? 0)
        );
        setMachines(merged);
      })
      .catch(() => {
        if (!cancelled) setMachines([]);
      });
    api.settings.designations.list().then(setDesignations);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!machine_id) {
      setFreeCapacityByYear([]);
      setFreeCapacityLoading(false);
      return;
    }
    const yearFrom = currentYear;
    const yearTo = currentYear + yearsPreviewCount - 1;
    setFreeCapacityLoading(true);
    api.capacity
      .machine(Number(machine_id), { yearFrom, yearTo })
      .then((data: { years?: Record<number, { load_percent?: number }> }) => {
        const rows: { year: number; load: number; free: number }[] = [];
        for (let y = yearFrom; y <= yearTo; y++) {
          const load = Number(data.years?.[y]?.load_percent ?? 0);
          const free = Math.max(0, Math.round(100 - load));
          rows.push({ year: y, load, free });
        }
        setFreeCapacityByYear(rows);
      })
      .catch(() => setFreeCapacityByYear([]))
      .finally(() => setFreeCapacityLoading(false));
  }, [machine_id, currentYear]);

  const copySearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    copyRowsRef.current = copyRows;
  }, [copyRows]);

  const loadCopySources = useCallback((q?: string) => {
    const trimmed = q?.trim() ?? '';
    const limit = trimmed ? 500 : 10000;
    const isSearchRefresh = copyRowsRef.current.length > 0 || trimmed.length > 0;
    if (isSearchRefresh) setCopySearchLoading(true);
    else setCopyLoading(true);
    return api.projects
      .operationsCopySources({ q: trimmed || undefined, limit })
      .then((r) => {
        const ops = r.operations;
        setCopyRows(ops);
        setCopyPickId((prev) => {
          const pid = Number(prev);
          if (!prev || !Number.isFinite(pid)) return prev;
          return ops.some((o: OperationCopyRow) => o.id === pid) ? prev : '';
        });
        return ops;
      })
      .catch(() => {
        setCopyRows([]);
        return [];
      })
      .finally(() => {
        setCopyLoading(false);
        setCopySearchLoading(false);
      });
  }, []);

  const handleCopySearchQuery = useCallback(
    (query: string) => {
      if (copySearchTimerRef.current) clearTimeout(copySearchTimerRef.current);
      copySearchTimerRef.current = setTimeout(() => {
        void loadCopySources(query);
      }, 280);
    },
    [loadCopySources]
  );

  useEffect(() => {
    return () => {
      if (copySearchTimerRef.current) clearTimeout(copySearchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (edit) {
      setCopyRows([]);
      setCopyPickId('');
      setCopyApplied(null);
      return;
    }
    setCopyPickId('');
    setCopyApplied(null);
  }, [edit]);

  useEffect(() => {
    if (edit) return;
    void loadCopySources();
  }, [edit, loadCopySources]);

  const operationCopyListLabel = (r: OperationCopyRow) => {
    const detailPart =
      formatDetailSapAliasLabel(
        {
          sap_number: r.detail_sap_number,
          alias: r.detail_alias,
          free_text: r.detail_free_text,
        },
        referenceDisplay
      )
        .replace(/\s*\(#\d+\)\s*$/u, '')
        .trim() || '—';
    const mn = r.machine_internal != null ? String(r.machine_internal) : '?';
    const mt = r.machine_type != null ? String(r.machine_type) : '';
    const setMark = Number(r.is_set) === 1 ? ' · set' : '';
    return `${detailPart} · ${mn}${mt ? ` (${mt})` : ''} · ${r.phase_name || '—'} · ${r.cycle_time_seconds ?? '?'}s${setMark}`;
  };

  const applyCopiedOperationParams = () => {
    const pick = Number(copyPickId);
    if (!Number.isFinite(pick) || pick <= 0) return;
    const op = copyRows.find((r) => r.id === pick);
    if (!op) return;
    setMachine_id(String(op.machine_id));
    setPhase_id(Number(op.phase_id));
    setCycle_time_seconds(Number(op.cycle_time_seconds) || 60);
    setNests_count(Number(op.nests_count) || 1);
    setOee_override(
      op.oee_override != null && Number.isFinite(Number(op.oee_override))
        ? String(Math.round(Number(op.oee_override) * 100))
        : ''
    );
    const ac = op.alt_cycle_time_seconds != null ? Number(op.alt_cycle_time_seconds) : NaN;
    setAlt_cycle_time_seconds(Number.isFinite(ac) && ac > 0 ? ac : '');
    const anRaw = op.alt_nests_count != null ? Number(op.alt_nests_count) : NaN;
    setAlt_nests_count(Number.isFinite(anRaw) && anRaw > 0 ? anRaw : '');
    setAlt_oee_override(
      op.alt_oee_override != null && Number.isFinite(Number(op.alt_oee_override))
        ? String(Math.round(Number(op.alt_oee_override) * 100))
        : ''
    );
    setAlt_comment(op.alt_comment != null ? String(op.alt_comment) : '');
    setUse_alternative_in_calculator(Number(op.use_alternative_in_calculator) === 1);

    const sDes = op.set_designation_ids;
    if (Number(op.is_set) === 1 && Array.isArray(sDes) && sDes.length >= 2) {
      setIsSet(true);
      setSelectedDetailId('');
      setSetAddDesignationId('');
      setShowNewDetail(false);
      const members = sDes.map((designationId) => {
        const des = designations.find((d) => d.id === designationId);
        const label = des ? designationChooserLabel(des, setSearchBy) : t('projectDetailExtra.designationIdFallback', { id: designationId });
        const existing = partsList.find((p: any) => Number(p.designation_id) === Number(designationId));
        return {
          designation_id: designationId,
          part_id: existing?.id != null ? Number(existing.id) : undefined,
          label,
        };
      });
      setSetMembers(members);
      const volKey = setMemberKey(members[0]);
      setSetVolumeSourceKey(volKey || '');
      setCopyApplied(t('projectDetailExtra.copyParamsSetApplied', { id: op.id }));
    } else if (Number(op.is_set) === 1) {
      setIsSet(true);
      setSelectedDetailId('');
      setSetMembers([]);
      setSetVolumeSourceKey('');
      setSetAddDesignationId('');
      setShowNewDetail(false);
      setCopyApplied(t('projectDetailExtra.copyParamsSetManual', { id: op.id }));
    } else {
      setIsSet(false);
      setSetMembers([]);
      setSetAddDesignationId('');
      setSetVolumeSourceKey('');
      const srcDes = op.source_designation_id;
      if (srcDes != null && Number(srcDes) > 0) {
        setSelectedDetailId(Number(srcDes));
      }
      setCopyApplied(t('projectDetailExtra.copyParamsApplied', { id: op.id }));
    }
    setError('');
  };

  const hasNewDetailFields = newDetailSap.trim() || newDetailAlias.trim() || newDetailFreeText.trim();

  const addDesignationToSet = async (
    designationId: number,
    designationOverride?: { sap_number?: string | null; alias?: string | null; free_text?: string | null; designation?: string }
  ) => {
    setError('');
    const designation = designationOverride ?? designations.find((d) => d.id === designationId);
    const label = designation ? designationChooserLabel(designation, setSearchBy) : String(designationId);
    try {
      let partId: number | undefined;
      const existing = partsList.find((p: any) => p.designation_id === designationId);
      if (existing) partId = existing.id;
      if (setMembers.some((m) => (partId != null && m.part_id === partId) || m.designation_id === designationId)) {
        setError(t('projectDetailExtra.detailInSet'));
        return;
      }
      setSetMembers((prev) => [...prev, { part_id: partId, designation_id: designationId, label }]);
      return true;
    } catch (e: any) {
      setError(e.message || t('projectDetailExtra.addDetailToSetFailed'));
      return false;
    }
  };
  const addToSet = async () => {
    if (!setAddDesignationId) return;
    const ok = await addDesignationToSet(Number(setAddDesignationId));
    if (ok) setSetAddDesignationId('');
  };

  const removeFromSet = (member: { part_id?: number; designation_id?: number }) => {
    if (!confirmDelete(t('projectDetailExtra.removeFromSetConfirm'))) return;
    setSetMembers((prev) =>
      prev.filter(
        (m) =>
          !(m.part_id != null && member.part_id != null && m.part_id === member.part_id) &&
          !(m.part_id == null && member.part_id == null && m.designation_id != null && member.designation_id != null && m.designation_id === member.designation_id)
      )
    );
  };

  const addNewPart = async () => {
    setError('');
    try {
      if (selectedDetailId) {
        const newPart = await api.projects.addPart(projectId, { designation_id: Number(selectedDetailId) });
        setPartsList((prev) => [...prev, newPart]);
        setPart_id(newPart.id);
        setShowNewDetail(false);
        setSelectedDetailId('');
      } else if (hasNewDetailFields) {
        const created = await api.settings.designations.create({
          sap_number: newDetailSap.trim() || undefined,
          alias: newDetailAlias.trim() || undefined,
          free_text: newDetailFreeText.trim() || undefined,
        });
        setDesignations((prev) => [...prev, created]);
        const newPart = await api.projects.addPart(projectId, { designation_id: created.id });
        setPartsList((prev) => [...prev, newPart]);
        setPart_id(newPart.id);
        setShowNewDetail(false);
        setNewDetailSap('');
        setNewDetailAlias('');
        setNewDetailFreeText('');
      }
    } catch (e: any) {
      if (isDesignationDuplicateError(e.message)) {
        window.alert(t('designations.duplicateExistsModal'));
        return;
      }
      setError(e.message || t('projectDetailExtra.addDetailFailed'));
    }
  };
  const addNewPartToSet = async () => {
    setError('');
    if (!hasNewDetailFields) return;
    try {
      const created = await api.settings.designations.create({
        sap_number: newDetailSap.trim() || undefined,
        alias: newDetailAlias.trim() || undefined,
        free_text: newDetailFreeText.trim() || undefined,
      });
      setDesignations((prev) => [...prev, created]);
      const ok = await addDesignationToSet(created.id, created);
      if (!ok) return;
      setNewDetailSap('');
      setNewDetailAlias('');
      setNewDetailFreeText('');
      setShowNewDetail(false);
      setSetAddDesignationId('');
    } catch (e: any) {
      if (isDesignationDuplicateError(e.message)) {
        window.alert(t('designations.duplicateExistsModal'));
        return;
      }
      setError(e.message || t('projectDetailExtra.addDetailToSetFailed'));
    }
  };

  const save = async () => {
    setError('');
    if (isSet) {
      if (setMembers.length < 2) {
        setError(t('projectDetailExtra.setMinTwo'));
        return;
      }
      if (!setVolumeSourceKey) {
        setError(t('errors.setVolumeSource'));
        return;
      }
    } else {
      if (!edit && !selectedDetailId) {
        if (showNewDetail && hasNewDetailFields) setError(t('projectDetailExtra.clickAddAndSelect'));
        else setError(t('projectDetailExtra.pickDetailOrCreate'));
        return;
      }
    }
    const machineIdNum = Number(machine_id);
    if (!String(machine_id ?? '').trim() || !Number.isFinite(machineIdNum) || machineIdNum <= 0) {
      setError(t('projectDetail.machineRequired'));
      return;
    }
    setSaving(true);
    try {
      let partId = part_id;
      if (!isSet && !edit && selectedDetailId) {
        const existing = partsList.find((p: any) => p.designation_id === Number(selectedDetailId));
        if (existing) partId = existing.id;
        else {
          const newPart = await api.projects.addPart(projectId, { designation_id: Number(selectedDetailId) });
          setPartsList((prev: any[]) => [...prev, newPart]);
          partId = newPart.id;
        }
      }
      const oeeVal = oee_override === '' ? null : Number(oee_override) / 100;
      const ac =
        alt_cycle_time_seconds === '' || alt_cycle_time_seconds == null ? NaN : Number(alt_cycle_time_seconds);
      const hasAlt = Number.isFinite(ac) && ac > 0;
      const body: any = {
        phase_id,
        machine_id: Number(machine_id),
        cycle_time_seconds,
        nests_count,
        oee_override: oeeVal,
        alt_cycle_time_seconds: hasAlt ? ac : null,
        alt_nests_count:
          !hasAlt || alt_nests_count === '' || alt_nests_count == null ? null : Number(alt_nests_count) || null,
        alt_oee_override:
          !hasAlt || alt_oee_override === '' ? null : Number(alt_oee_override) / 100,
        alt_comment: !hasAlt || !String(alt_comment).trim() ? null : String(alt_comment).trim(),
        use_alternative_in_calculator: hasAlt && use_alternative_in_calculator,
      };
      if (!edit) {
        body.volume_value = 0;
        body.volume_unit = 'annual';
      }
      if (isSet) {
        const resolvedSetPartIds: number[] = [];
        const resolvedPartIdByKey = new Map<string, number>();
        for (const member of setMembers) {
          let resolvedPartId: number;
          if (member.part_id != null) {
            resolvedPartId = Number(member.part_id);
            resolvedSetPartIds.push(resolvedPartId);
            const key = setMemberKey(member);
            if (key) resolvedPartIdByKey.set(key, resolvedPartId);
            resolvedPartIdByKey.set(`p:${resolvedPartId}`, resolvedPartId);
            continue;
          }
          if (!member.designation_id) {
            setError(t('projectDetailExtra.missingPartIdInSet'));
            setSaving(false);
            return;
          }
          const existing = partsList.find((p: any) => p.designation_id === member.designation_id);
          if (existing?.id) {
            resolvedPartId = Number(existing.id);
            resolvedSetPartIds.push(resolvedPartId);
            const key = setMemberKey(member);
            if (key) resolvedPartIdByKey.set(key, resolvedPartId);
            resolvedPartIdByKey.set(`d:${Number(member.designation_id)}`, resolvedPartId);
            resolvedPartIdByKey.set(`p:${resolvedPartId}`, resolvedPartId);
            continue;
          }
          const newPart = await api.projects.addPart(projectId, { designation_id: member.designation_id });
          setPartsList((prev: any[]) => [...prev, newPart]);
          resolvedPartId = Number(newPart.id);
          resolvedSetPartIds.push(resolvedPartId);
          const key = setMemberKey(member);
          if (key) resolvedPartIdByKey.set(key, resolvedPartId);
          resolvedPartIdByKey.set(`d:${Number(member.designation_id)}`, resolvedPartId);
          resolvedPartIdByKey.set(`p:${resolvedPartId}`, resolvedPartId);
        }
        const volumeSourcePartId = resolvedPartIdByKey.get(setVolumeSourceKey) ?? null;
        if (volumeSourcePartId == null) {
          setError(t('projectDetailExtra.setVolumeSourceResolveFailed'));
          setSaving(false);
          return;
        }
        body.is_set = true;
        body.part_id = volumeSourcePartId;
        body.set_part_ids = [volumeSourcePartId, ...resolvedSetPartIds.filter((pid) => pid !== volumeSourcePartId)];
      } else {
        body.is_set = false;
        body.part_id = partId;
      }
      await (edit ? api.projects.updateOperation(projectId, edit.id, body) : api.projects.addOperation(projectId, body));
      onSaved();
    } catch (e: any) {
      setError(e.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ background: 'white', padding: '1.5rem', borderRadius: 8, maxWidth: 560, width: '100%', maxHeight: '90vh', overflow: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>{edit ? t('projectDetail.editOperation') : t('projectDetail.newOperation')}</h3>
        {!edit && (
          <div style={{ marginBottom: 14, padding: 12, background: '#f0f4f8', borderRadius: 8, border: '1px solid #c5d5e8' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('calculator.copyParams')}</div>
            <p style={{ fontSize: 12, color: '#455a64', margin: '0 0 10px', lineHeight: 1.45 }}>
              {t('projectDetailExtra.copyParamsIntro')}
            </p>
            {copyApplied && <p style={{ color: '#2e7d32', fontSize: 13, margin: '0 0 8px' }}>{copyApplied}</p>}
            <div style={{ marginBottom: 10 }}>
              {copyLoading && copyRows.length === 0 ? (
                <div style={{ padding: 10, fontSize: 13, color: '#546e7a' }}>{t('calculator.loadingCopyList')}</div>
              ) : copyRows.length === 0 ? (
                <div style={{ padding: 10, fontSize: 13, color: '#78909c' }}>{t('calculator.noCopyOps')}</div>
              ) : (
                <>
                {copySearchLoading && (
                  <div style={{ fontSize: 12, color: '#546e7a', marginBottom: 4 }}>{t('calculator.loadingCopyList')}</div>
                )}
                <SearchableSelect
                  value={copyPickId}
                  onChange={(e) => {
                    setCopyPickId(e.target.value);
                    setCopyApplied(null);
                  }}
                  style={{ width: '100%', display: 'block' }}
                  searchPlaceholder={t('calculator.searchCopyOps')}
                  serverFiltered
                  onSearchQueryChange={handleCopySearchQuery}
                  filterMatchText={(o) => {
                    if (!o.value) return '';
                    const row = copyRows.find((r) => String(r.id) === o.value);
                    if (!row) return '';
                    const detailAll = formatDetailSapAliasLabel(
                      {
                        sap_number: row.detail_sap_number,
                        alias: row.detail_alias,
                        free_text: row.detail_free_text,
                      },
                      'both'
                    );
                    return [
                      detailAll,
                      row.detail_sap_number,
                      row.detail_alias,
                      row.detail_free_text,
                      row.project_client,
                      row.project_name,
                      row.phase_name,
                      row.machine_internal,
                      row.machine_type,
                      row.id,
                    ]
                      .filter(Boolean)
                      .join(' ');
                  }}
                >
                  <option value="">{t('projectDetailExtra.chooseSourceOp')}</option>
                  {copyRows.map((r) => (
                    <option key={r.id} value={String(r.id)}>
                      {operationCopyListLabel(r)}
                    </option>
                  ))}
                </SearchableSelect>
                </>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={applyCopiedOperationParams}
                disabled={!copyPickId}
                style={{
                  padding: '6px 14px',
                  background: copyPickId ? 'var(--cap-green)' : '#ccc',
                  color: 'white',
                  border: 'none',
                  borderRadius: 4,
                  cursor: copyPickId ? 'pointer' : 'not-allowed',
                  fontWeight: 600,
                }}
              >
                {t('calculator.applyForm')}
              </button>
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '1rem' }}>
          <div>
            <label style={{ fontWeight: 600 }}>{t('projectDetailExtra.volumeForLabel')} </label>
            <div style={{ marginTop: 4, marginBottom: 10 }}>
              <label style={{ marginRight: 16 }}><input type="radio" name="volumeFor" checked={!isSet} onChange={() => { setIsSet(false); setSetMembers([]); setSetAddDesignationId(''); setSetVolumeSourceKey(''); setShowNewDetail(false); }} /> {t('projectDetailExtra.singlePart')}</label>
              <label><input type="radio" name="volumeFor" checked={isSet} onChange={() => { setIsSet(true); setSelectedDetailId(''); setShowNewDetail(false); setSetSearchBy('sap'); }} /> {t('projectDetailExtra.setMode')}</label>
            </div>
          </div>
          {!isSet && (
            <div>
              <label>{t('projectDetailExtra.detailLabel')} </label>
              <div style={{ marginTop: 4 }}>
                <div style={{ marginBottom: 6 }}>
                  <span style={{ marginRight: 12 }}>{t('projectDetailExtra.pickBy')}</span>
                  <label><input type="radio" name="detailBy" checked={detailSearchBy === 'sap'} onChange={() => { setDetailSearchBy('sap'); setSelectedDetailId(''); }} /> {t('designations.sapCol')}</label>
                  <label style={{ marginLeft: 8 }}><input type="radio" name="detailBy" checked={detailSearchBy === 'alias'} onChange={() => { setDetailSearchBy('alias'); setSelectedDetailId(''); }} /> {t('designations.aliasCol')}</label>
                </div>
                <SearchableSelect value={showNewDetail ? '__new__' : String(selectedDetailId || '')} onChange={(e) => { const v = e.target.value; if (v === '__new__') setShowNewDetail(true); else { setShowNewDetail(false); setSelectedDetailId(v === '' ? '' : Number(v)); } }} style={{ padding: 4, minWidth: 260 }}>
                  <option value="">{t('projectDetailExtra.pickFromCatalog')}</option>
                  {designations
                    .filter((d) => designationListFilter(d, detailSearchBy))
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {designationChooserLabel(d, detailSearchBy)}
                      </option>
                    ))}
                  <option value="__new__">{t('projectDetailExtra.newDetailOption')}</option>
                </SearchableSelect>
                {selectedDetail && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>
                    {t('designations.sapCol')}: <strong>{detailFieldDisplay(selectedDetail.sap_number, true)}</strong> · {t('designations.aliasCol')}: <strong>{detailFieldDisplay(selectedDetail.alias)}</strong>
                    {selectedDetail.free_text && <> · {t('designations.freeTextCol')}: {selectedDetail.free_text}</>}
                  </div>
                )}
              </div>
              {showNewDetail && (
                <div style={{ marginTop: 8, padding: 8, background: '#f9f9f9', borderRadius: 6 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 13, color: '#555' }}>{t('projectDetailExtra.fillNewDetailHint')}</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <input type="text" placeholder={t('designations.sapCol')} value={newDetailSap} onChange={(e) => setNewDetailSap(e.target.value)} style={{ padding: '0.5rem', width: 140 }} />
                    <input type="text" placeholder={t('designations.aliasCol')} value={newDetailAlias} onChange={(e) => setNewDetailAlias(e.target.value)} style={{ padding: '0.5rem', width: 140 }} />
                    <input type="text" placeholder={t('designations.freeTextCol')} value={newDetailFreeText} onChange={(e) => setNewDetailFreeText(e.target.value)} style={{ padding: '0.5rem', width: 160 }} />
                  </div>
                  <button type="button" onClick={addNewPart} disabled={!hasNewDetailFields} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetailExtra.addAndSelect')}</button>
                </div>
              )}
            </div>
          )}
          {isSet && (
            <div style={{ padding: 8, background: '#f5f9f5', borderRadius: 6, border: '1px solid #c8e6c9' }}>
              <label style={{ fontWeight: 600 }}>{t('projectDetailExtra.setPartsTitle')}</label>
              <p style={{ margin: '4px 0 8px', fontSize: 12, color: '#555' }}>{t('projectDetailExtra.setCycleHint')}</p>
              <div style={{ marginBottom: 6 }}>
                <span style={{ marginRight: 12 }}>{t('projectDetailExtra.pickBy')}</span>
                <label><input type="radio" name="setDetailBy" checked={setSearchBy === 'sap'} onChange={() => { setSetSearchBy('sap'); setSetAddDesignationId(''); }} /> {t('designations.sapCol')}</label>
                <label style={{ marginLeft: 8 }}><input type="radio" name="setDetailBy" checked={setSearchBy === 'alias'} onChange={() => { setSetSearchBy('alias'); setSetAddDesignationId(''); }} /> {t('designations.aliasCol')}</label>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <SearchableSelect
                  value={showNewDetail ? '__new__' : String(setAddDesignationId)}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__new__') {
                      setShowNewDetail(true);
                      setSetAddDesignationId('');
                      return;
                    }
                    setShowNewDetail(false);
                    setSetAddDesignationId(v === '' ? '' : Number(v));
                  }}
                  style={{ padding: 4, minWidth: 220 }}
                >
                  <option value="">{t('projectDetailExtra.pickDetailToAdd')}</option>
                  {designations
                    .filter((d) => designationListFilter(d, setSearchBy))
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {designationChooserLabel(d, setSearchBy)}
                      </option>
                    ))}
                  <option value="__new__">{t('projectDetailExtra.newDetailOption')}</option>
                </SearchableSelect>
                <button type="button" onClick={addToSet} disabled={!setAddDesignationId} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetailExtra.addToSet')}</button>
              </div>
              {showNewDetail && (
                <div style={{ marginTop: 8, marginBottom: 8, padding: 8, background: '#f9f9f9', borderRadius: 6 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 13, color: '#555' }}>{t('projectDetailExtra.createAndAddToSetHint')}</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <input type="text" placeholder={t('designations.sapCol')} value={newDetailSap} onChange={(e) => setNewDetailSap(e.target.value)} style={{ padding: '0.5rem', width: 140 }} />
                    <input type="text" placeholder={t('designations.aliasCol')} value={newDetailAlias} onChange={(e) => setNewDetailAlias(e.target.value)} style={{ padding: '0.5rem', width: 140 }} />
                    <input type="text" placeholder={t('designations.freeTextCol')} value={newDetailFreeText} onChange={(e) => setNewDetailFreeText(e.target.value)} style={{ padding: '0.5rem', width: 160 }} />
                  </div>
                  <button type="button" onClick={addNewPartToSet} disabled={!hasNewDetailFields} style={{ padding: '0.35rem 0.75rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetailExtra.createAndAddToSet')}</button>
                </div>
              )}
              {setMembers.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {setMembers.map((m, idx) => {
                    const des = m.designation_id != null ? designations.find((d) => d.id === m.designation_id) : undefined;
                    const showLabel = des ? designationChooserLabel(des, setSearchBy) : m.label;
                    return (
                    <span key={`${m.part_id ?? 'new'}-${m.designation_id ?? 'x'}-${idx}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', background: 'white', borderRadius: 4, border: '1px solid #a5d6a7' }}>
                      {idx > 0 && <span style={{ color: '#888' }}>+</span>}
                      <span>{showLabel}</span>
                      <button type="button" onClick={() => removeFromSet(m)} style={{ padding: '0 4px', lineHeight: 1, background: 'transparent', border: 'none', color: '#c62828', cursor: 'pointer', fontSize: 16 }} title={t('projectDetailExtra.removeFromSet')}>×</button>
                    </span>
                    );
                  })}
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <label style={{ fontWeight: 600 }}>{t('projectDetailExtra.volumeFromDetail')}</label>
                <div style={{ marginTop: 6 }}>
                  <SearchableSelect value={setVolumeSourceKey} onChange={(e) => setSetVolumeSourceKey(e.target.value)} style={{ minWidth: 260 }}>
                    <option value="">{t('projectDetailExtra.chooseVolumeSource')}</option>
                    {setMembers.map((m, idx) => {
                      const key = setMemberKey(m);
                      if (!key) return null;
                      const des = m.designation_id != null ? designations.find((d) => d.id === m.designation_id) : undefined;
                      const showLabel = des ? designationChooserLabel(des, setSearchBy) : m.label;
                      return (
                        <option key={`${key}-${idx}`} value={key}>
                          {showLabel}
                        </option>
                      );
                    })}
                  </SearchableSelect>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#555' }}>
                  {t('projectDetailExtra.setSaveRequiresVolumeSource')}
                </p>
                {volumeSourcePartMissingVolume && (
                  <p
                    role="alert"
                    style={{
                      margin: '8px 0 0',
                      padding: '8px 10px',
                      fontSize: 12,
                      color: '#bf360c',
                      background: '#fff3e0',
                      border: '1px solid #ffcc80',
                      borderRadius: 4,
                    }}
                  >
                    {t('projectDetailExtra.setVolumeSourceNoVolumeModal', {
                      years: sopEopYearsLabel(projectVolumeContext),
                    })}
                  </p>
                )}
              </div>
            </div>
          )}
          <label>{t('projectDetail.phase')} <SearchableSelect value={phase_id} onChange={(e) => setPhase_id(Number(e.target.value))} style={{ marginLeft: 8 }}>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SearchableSelect></label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('projectDetail.machine')}
            <SearchableSelect
              value={machine_id}
              onChange={(e) => setMachine_id(e.target.value)}
              style={{ marginLeft: 8, minWidth: 220 }}
              filterMatchText={(o) => {
                const m = machines.find((x) => String(x.id) === o.value);
                return m ? machineSelectFilterText(m) : o.label;
              }}
            >
              <option value="">--</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {formatMachineSapInternalLabel(m, machineDisplay, {
                    includeType: true,
                    rfq: String(m.status ?? '').toUpperCase() === 'RFQ',
                  })}
                </option>
              ))}
            </SearchableSelect>
          </label>
          {machine_id && (
            <div style={{ marginTop: -2, marginBottom: 2 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
                {t('projectDetailExtra.freeCapacityLabel')}
              </div>
              {freeCapacityLoading ? (
                <div style={{ fontSize: 12, color: '#888' }}>{t('common.loading')}</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {freeCapacityByYear.map((r) => {
                    const bg = r.free <= 0 ? '#ffcdd2' : r.free < 20 ? '#fff9c4' : '#c8e6c9';
                    return (
                      <span
                        key={r.year}
                        title={t('projectDetailExtra.freeCapacityYearTitle', { year: r.year, load: Math.round(r.load), free: r.free })}
                        style={{
                          display: 'inline-block',
                          minWidth: 66,
                          textAlign: 'center',
                          padding: '4px 6px',
                          borderRadius: 6,
                          border: '1px solid #e0e0e0',
                          background: bg,
                          fontSize: 12,
                        }}
                      >
                        <strong>{r.year}</strong>: {r.free}%
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {machine_id && (
            <p style={{ fontSize: 12, color: '#666', margin: '0 0 4px' }}>
              {t('projectDetailExtra.capacityShareHint')}
            </p>
          )}
          <label>{t('projectDetail.cycle')} <input type="number" value={cycle_time_seconds} onChange={(e) => setCycle_time_seconds(Number(e.target.value))} style={{ marginLeft: 8, width: 80 }} /></label>
          <p style={{ fontSize: 13, color: '#555', margin: '4px 0' }}>{t('projectDetail.volumeHint')}</p>
          <label>{t('projectDetail.nests')} <input type="number" min={1} value={nests_count} onChange={(e) => setNests_count(Number(e.target.value))} style={{ marginLeft: 8, width: 60 }} /></label>
          <label>{t('projectDetail.oee')} <input type="number" min={0} max={100} step={0.01} placeholder={t('projectDetailExtra.oeePlaceholder')} title={t('projectDetailExtra.oeeOverrideTitle')} value={oee_override} onChange={(e) => setOee_override(e.target.value)} style={{ marginLeft: 8, width: 80 }} /></label>
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 8,
              border: '2px solid #ff9800',
              background: 'linear-gradient(180deg, #fff8e1 0%, #fff3e0 100%)',
            }}
          >
            <div style={{ fontWeight: 700, color: '#e65100', marginBottom: 8 }}>{t('projectDetail.alternative')}</div>
            <p style={{ fontSize: 12, color: '#5d4037', margin: '0 0 10px' }}>
              {t('projectDetailExtra.altVariantDesc')}
            </p>
            <label>
              {t('projectDetailExtra.altCycleLabel')}{' '}
              <input
                type="number"
                min={1}
                value={alt_cycle_time_seconds === '' ? '' : alt_cycle_time_seconds}
                onChange={(e) => {
                  const v = e.target.value;
                  setAlt_cycle_time_seconds(v === '' ? '' : Number(v));
                }}
                style={{ width: 80 }}
                placeholder="—"
              />
            </label>
            <label style={{ marginLeft: 12 }}>
              {t('projectDetailExtra.altNestsLabel')}{' '}
              <input
                type="number"
                min={1}
                value={alt_nests_count === '' ? '' : alt_nests_count}
                onChange={(e) => {
                  const v = e.target.value;
                  setAlt_nests_count(v === '' ? '' : Number(v));
                }}
                style={{ width: 56 }}
                placeholder={t('projectDetailExtra.altNestsPlaceholder')}
                title={t('projectDetailExtra.altNestsTitle')}
              />
            </label>
            <label style={{ display: 'block', marginTop: 8 }}>
              {t('projectDetailExtra.altOeeLabel')}{' '}
              <input
                type="number"
                min={0}
                max={100}
                step={0.01}
                placeholder={t('projectDetailExtra.altOeePlaceholder')}
                value={alt_oee_override}
                onChange={(e) => setAlt_oee_override(e.target.value)}
                style={{ width: 80 }}
              />
            </label>
            <label style={{ display: 'block', marginTop: 8 }}>
              {t('projectDetailExtra.commentLabel')}{' '}
              <textarea
                value={alt_comment}
                onChange={(e) => setAlt_comment(e.target.value)}
                rows={2}
                style={{ width: '100%', maxWidth: 420, marginTop: 4, padding: 8, boxSizing: 'border-box' }}
                placeholder={t('projectDetailExtra.altPlaceholder')}
              />
            </label>
          </div>
          <div style={{ marginTop: 4 }}>
            <span style={{ fontWeight: 600, marginRight: 8 }}>{t('projectDetailExtra.calcVariantLabel')}</span>
            <label style={{ marginRight: 12 }}>
              <input
                type="radio"
                name="calcVariant"
                checked={!use_alternative_in_calculator}
                disabled={!(alt_cycle_time_seconds !== '' && Number(alt_cycle_time_seconds) > 0)}
                onChange={() => setUse_alternative_in_calculator(false)}
              />{' '}
              {t('projectDetailExtra.calcVariantBase')}
            </label>
            <label>
              <input
                type="radio"
                name="calcVariant"
                checked={use_alternative_in_calculator}
                disabled={!(alt_cycle_time_seconds !== '' && Number(alt_cycle_time_seconds) > 0)}
                onChange={() => setUse_alternative_in_calculator(true)}
              />{' '}
              {t('projectDetailExtra.calcVariantAlt')}
            </label>
          </div>
        </div>
        {error && <p style={{ color: 'var(--cap-red)', marginBottom: 8 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ padding: '0.5rem 1rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{saving ? t('common.saving') : t('projectDetail.save')}</button>
          <button onClick={onClose} style={{ padding: '0.5rem 1rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4 }}>{t('projectDetail.cancel')}</button>
        </div>
      </div>
    </div>
  );
}
