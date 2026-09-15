import { useEffect, useState, useMemo, Fragment } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useScenarioMode } from '../context/ScenarioModeContext';
import { useReferenceDisplay } from '../context/ReferenceDisplayContext';
import { formatDetailSapAliasLabel } from '../utils/detailLabel';
import StatusMultiFilter, { type ProjectStatusFilterValue } from '../components/StatusMultiFilter';
import SortableTh from '../components/SortableTh';
import { useTableSort, sortRows } from '../utils/tableSort';
import { useI18n } from '../context/I18nContext';
import { formatSopEop, sopEopYearsRange } from '../utils/sopEopFormat';

type VolumeUnit = 'annual' | 'monthly' | 'weekly';
type VolumeDraftRow = { year: number; volume_value: string; volume_unit: VolumeUnit };

const INHERIT = '__inherit__';
type LineStatus = 'active' | 'inactive' | 'RFQ';

function normScenarioStatus(v: unknown): LineStatus | null {
  const s = String(v ?? '').trim();
  if (s === 'active' || s === 'inactive' || s === 'RFQ') return s;
  return null;
}

function declaredProjectStatus(p: any): LineStatus {
  return normScenarioStatus(p?.status) ?? 'active';
}

function effectivePartStatus(p: any, pt: any): LineStatus {
  return normScenarioStatus(pt?.status) ?? declaredProjectStatus(p);
}

function effectiveOpStatus(p: any, pt: any, op: any): LineStatus {
  return normScenarioStatus(op?.status) ?? effectivePartStatus(p, pt);
}

function projectDescendantMismatch(p: any, projectParts: any[], opsByPart: Map<number, any[]>): boolean {
  const d = declaredProjectStatus(p);
  for (const pt of projectParts) {
    if (effectivePartStatus(p, pt) !== d) return true;
    const partOps = opsByPart.get(Number(pt.id)) ?? [];
    for (const op of partOps) {
      if (effectiveOpStatus(p, pt, op) !== d) return true;
    }
  }
  return false;
}

function partChildOpMismatch(p: any, pt: any, partOps: any[]): boolean {
  const e = effectivePartStatus(p, pt);
  return partOps.some((op) => effectiveOpStatus(p, pt, op) !== e);
}

/** Obramowanie detalu: potomek (operacja) ≠ efekt detalu LUB detal ≠ zadeklarowany projekt. */
function partStatusBorderWarn(p: any, pt: any, partOps: any[]): boolean {
  return partChildOpMismatch(p, pt, partOps) || effectivePartStatus(p, pt) !== declaredProjectStatus(p);
}

function statusControlColors(st: string): { background: string; color: string } {
  if (st === 'active') return { background: 'var(--cap-green)', color: 'white' };
  if (st === 'RFQ') return { background: '#ff9800', color: 'white' };
  return { background: '#9e9e9e', color: 'white' };
}

/** Edytowalna komórka SOP/EOP w tabeli — zapis dopiero na blur (nie na każdy znak), tylko w scenariuszu. */
function SopEopInput({
  value,
  disabled,
  onSave,
}: {
  value: string | null | undefined;
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(formatSopEop(value ?? ''));
  useEffect(() => {
    setDraft(formatSopEop(value ?? ''));
  }, [value]);
  return (
    <input
      type="text"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next !== formatSopEop(value ?? '')) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      placeholder="MM.RRRR"
      title="MM.RRRR (np. 6.2026)"
      style={{ width: 84, padding: '0.3rem', border: '1px solid #ccc', borderRadius: 4, fontSize: 13 }}
    />
  );
}

/** Wcięcia poziomów drzewka (px od lewej krawędzi komórki z treścią). */
const TREE_INDENT_EXPAND_PART = 22;
const TREE_INDENT_LABEL_PART = 30;
const TREE_INDENT_EXPAND_OP = 44;
const TREE_INDENT_LABEL_OP = 56;

export default function ScenarioView() {
  const { t, te } = useI18n();
  const { id } = useParams();
  const { setActiveScenario } = useScenarioMode();
  const { referenceDisplay } = useReferenceDisplay();

  const [scenario, setScenario] = useState<{
    id: number;
    name: string;
    scenario_scope?: string;
    created_at: string;
    updated_at?: string | null;
    source_scenario_id?: number | null;
    archived_at?: string | null;
    snapshot: any;
  } | null>(null);
  const [sourceParentName, setSourceParentName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterKlient, setFilterKlient] = useState('');
  const [filterNazwa, setFilterNazwa] = useState('');
  const [filterSop, setFilterSop] = useState('');
  const [filterEop, setFilterEop] = useState('');
  const [filterStatuses, setFilterStatuses] = useState<ProjectStatusFilterValue[]>([]);
  const [statusSavingKey, setStatusSavingKey] = useState<string | null>(null);
  const [projectStatusError, setProjectStatusError] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<number[]>([]);
  const [expandedPartIds, setExpandedPartIds] = useState<number[]>([]);
  const [addProjectsModalOpen, setAddProjectsModalOpen] = useState(false);
  const [addProjectsLoading, setAddProjectsLoading] = useState(false);
  const [addProjectsCandidates, setAddProjectsCandidates] = useState<
    { id: number; client: string; name: string; sop: string | null; eop: string | null; status: string }[]
  >([]);
  const [addProjectsPick, setAddProjectsPick] = useState<number[]>([]);
  const [addProjectsBusy, setAddProjectsBusy] = useState(false);
  const [addProjectsError, setAddProjectsError] = useState<string | null>(null);
  const [scenarioActionInfo, setScenarioActionInfo] = useState<string | null>(null);
  const [volumeModalPart, setVolumeModalPart] = useState<{ part: any; project: any } | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<VolumeDraftRow[]>([]);
  const [volumeSaving, setVolumeSaving] = useState(false);
  const [volumeError, setVolumeError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoadError(null);
    api.scenarios
      .get(Number(id))
      .then(setScenario)
      .catch((e) => setLoadError(te(e.message) || t('scenarioViewExtra.loadFailed')))
      .finally(() => setLoading(false));
  }, [id]);

  /** Nagłówek korzysta z kontekstu — po wejściu na podgląd innego scenariusza trzeba go zsynchronizować. */
  useEffect(() => {
    if (!scenario) return;
    setActiveScenario(scenario.id, scenario.name);
  }, [scenario, setActiveScenario]);

  useEffect(() => {
    const sid = scenario?.source_scenario_id;
    if (sid != null && sid > 0) {
      api.scenarios
        .get(sid)
        .then((p) => setSourceParentName(p.name))
        .catch(() => setSourceParentName(null));
    } else {
      setSourceParentName(null);
    }
  }, [scenario?.source_scenario_id]);

  const bundleProjects = scenario?.snapshot?.projects ?? [];
  const bundleParts = scenario?.snapshot?.parts ?? [];
  const bundleOperations = scenario?.snapshot?.operations ?? [];

  const partsByProject = useMemo(() => {
    const m = new Map<number, any[]>();
    for (const pt of bundleParts) {
      const pid = Number(pt.project_id);
      if (!Number.isFinite(pid)) continue;
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid)!.push(pt);
    }
    for (const arr of m.values()) arr.sort((a, b) => Number(a.id) - Number(b.id));
    return m;
  }, [bundleParts]);

  const opsByPart = useMemo(() => {
    const m = new Map<number, any[]>();
    for (const o of bundleOperations) {
      const bid = Number(o.part_id);
      if (!Number.isFinite(bid)) continue;
      if (!m.has(bid)) m.set(bid, []);
      m.get(bid)!.push(o);
    }
    for (const arr of m.values()) arr.sort((a, b) => Number(a.id) - Number(b.id));
    return m;
  }, [bundleOperations]);

  type ScenarioProjSortCol = 'client' | 'name' | 'sop' | 'eop' | 'status';
  const { sortCol: projSortCol, sortDir: projSortDir, toggle: toggleProjSort } = useTableSort<ScenarioProjSortCol>('client');

  const filteredProjects = useMemo(() => {
    const filtered = bundleProjects.filter((p: any) => {
      if (filterKlient.trim() && !(p.client ?? '').toLowerCase().includes(filterKlient.trim().toLowerCase())) return false;
      if (filterNazwa.trim() && !(p.name ?? '').toLowerCase().includes(filterNazwa.trim().toLowerCase())) return false;
      if (filterSop.trim() && !String(p.sop ?? '').toLowerCase().includes(filterSop.trim().toLowerCase())) return false;
      if (filterEop.trim() && !String(p.eop ?? '').toLowerCase().includes(filterEop.trim().toLowerCase())) return false;
      if (filterStatuses.length > 0 && !filterStatuses.includes((p.status ?? 'active') as ProjectStatusFilterValue)) return false;
      return true;
    });
    return sortRows(filtered, projSortCol, projSortDir, (p: any, col) => {
      switch (col) {
        case 'client':
          return String(p.client ?? '');
        case 'name':
          return String(p.name ?? '');
        case 'sop':
          return String(p.sop ?? '');
        case 'eop':
          return String(p.eop ?? '');
        case 'status':
          return String(p.status ?? 'active');
        default:
          return '';
      }
    });
  }, [bundleProjects, filterKlient, filterNazwa, filterSop, filterEop, filterStatuses, projSortCol, projSortDir]);

  const handleScenarioProjectStatus = async (p: any, nextStatus: 'active' | 'inactive' | 'RFQ') => {
    const sid = scenario?.id;
    if (!sid || scenario?.archived_at) return;
    const pid = Number(p.id);
    if (!Number.isFinite(pid)) return;
    if ((p.status ?? 'active') === nextStatus) return;
    setProjectStatusError(null);
    setStatusSavingKey(`p:${pid}`);
    const prev = p.status ?? 'active';
    setScenario((s) => {
      if (!s?.snapshot?.projects) return s;
      const nextProjects = (s.snapshot.projects as any[]).map((pr: any) =>
        Number(pr.id) === pid ? { ...pr, status: nextStatus } : pr
      );
      return { ...s, snapshot: { ...s.snapshot, projects: nextProjects } };
    });
    try {
      await api.scenarios.patchProjectStatus(sid, pid, { status: nextStatus });
    } catch (e: any) {
      setScenario((s) => {
        if (!s?.snapshot?.projects) return s;
        const nextProjects = (s.snapshot.projects as any[]).map((pr: any) =>
          Number(pr.id) === pid ? { ...pr, status: prev } : pr
        );
        return { ...s, snapshot: { ...s.snapshot, projects: nextProjects } };
      });
      setProjectStatusError(te(e?.message) || t('scenarioViewExtra.statusSaveFailed'));
    } finally {
      setStatusSavingKey(null);
    }
  };

  /** SOP/EOP projektu — tylko w tym scenariuszu (snapshot), nie zmienia produkcji. */
  const handleScenarioProjectDate = async (p: any, field: 'sop' | 'eop', nextValue: string) => {
    const sid = scenario?.id;
    if (!sid || scenario?.archived_at) return;
    const pid = Number(p.id);
    if (!Number.isFinite(pid)) return;
    const prev = String(p[field] ?? '');
    if (prev === nextValue) return;
    setProjectStatusError(null);
    setStatusSavingKey(`${field}:${pid}`);
    setScenario((s) => {
      if (!s?.snapshot?.projects) return s;
      const nextProjects = (s.snapshot.projects as any[]).map((pr: any) =>
        Number(pr.id) === pid ? { ...pr, [field]: nextValue } : pr
      );
      return { ...s, snapshot: { ...s.snapshot, projects: nextProjects } };
    });
    try {
      await api.scenarios.patchProjectSopEop(sid, pid, { [field]: nextValue });
    } catch (e: any) {
      setScenario((s) => {
        if (!s?.snapshot?.projects) return s;
        const nextProjects = (s.snapshot.projects as any[]).map((pr: any) =>
          Number(pr.id) === pid ? { ...pr, [field]: prev } : pr
        );
        return { ...s, snapshot: { ...s.snapshot, projects: nextProjects } };
      });
      setProjectStatusError(te(e?.message) || t('scenarioViewExtra.statusSaveFailed'));
    } finally {
      setStatusSavingKey(null);
    }
  };

  const handlePartStatus = async (_p: any, pt: any, next: LineStatus | null) => {
    const sid = scenario?.id;
    if (!sid || scenario?.archived_at) return;
    const partId = Number(pt.id);
    if (!Number.isFinite(partId)) return;
    setProjectStatusError(null);
    setStatusSavingKey(`pt:${partId}`);
    const prevRaw = pt.status;
    setScenario((s) => {
      if (!s?.snapshot?.parts) return s;
      const nextParts = (s.snapshot.parts as any[]).map((row: any) => {
        if (Number(row.id) !== partId) return row;
        if (next == null) {
          const copy = { ...row };
          delete copy.status;
          return copy;
        }
        return { ...row, status: next };
      });
      return { ...s, snapshot: { ...s.snapshot, parts: nextParts } };
    });
    try {
      await api.scenarios.patchPartStatus(sid, partId, { status: next });
    } catch (e: any) {
      setScenario((s) => {
        if (!s?.snapshot?.parts) return s;
        const nextParts = (s.snapshot.parts as any[]).map((row: any) => {
          if (Number(row.id) !== partId) return row;
          if (prevRaw == null || prevRaw === '') {
            const copy = { ...row };
            delete copy.status;
            return copy;
          }
          return { ...row, status: prevRaw };
        });
        return { ...s, snapshot: { ...s.snapshot, parts: nextParts } };
      });
      setProjectStatusError(te(e?.message) || t('scenarioViewExtra.statusSaveFailed'));
    } finally {
      setStatusSavingKey(null);
    }
  };

  const handleOperationStatus = async (_p: any, _pt: any, op: any, next: LineStatus | null) => {
    const sid = scenario?.id;
    if (!sid || scenario?.archived_at) return;
    const oid = Number(op.id);
    if (!Number.isFinite(oid)) return;
    setProjectStatusError(null);
    setStatusSavingKey(`op:${oid}`);
    const prevRaw = op.status;
    setScenario((s) => {
      if (!s?.snapshot?.operations) return s;
      const nextOps = (s.snapshot.operations as any[]).map((row: any) => {
        if (Number(row.id) !== oid) return row;
        if (next == null) {
          const copy = { ...row };
          delete copy.status;
          return copy;
        }
        return { ...row, status: next };
      });
      return { ...s, snapshot: { ...s.snapshot, operations: nextOps } };
    });
    try {
      await api.scenarios.patchOperationStatus(sid, oid, { status: next });
    } catch (e: any) {
      setScenario((s) => {
        if (!s?.snapshot?.operations) return s;
        const nextOps = (s.snapshot.operations as any[]).map((row: any) => {
          if (Number(row.id) !== oid) return row;
          if (prevRaw == null || prevRaw === '') {
            const copy = { ...row };
            delete copy.status;
            return copy;
          }
          return { ...row, status: prevRaw };
        });
        return { ...s, snapshot: { ...s.snapshot, operations: nextOps } };
      });
      setProjectStatusError(te(e?.message) || t('scenarioViewExtra.statusSaveFailed'));
    } finally {
      setStatusSavingKey(null);
    }
  };

  /** Otwiera modal wolumenu detalu — wypełniony istniejącym nadpisaniem (jeśli jest) albo zerami dla lat SOP–EOP projektu. */
  const openVolumeModal = (p: any, pt: any) => {
    setVolumeError(null);
    const range = sopEopYearsRange(p?.sop, p?.eop).years;
    const existing = ((scenario?.snapshot?.part_volume_by_year as any[]) ?? []).filter(
      (r: any) => Number(r.part_id) === Number(pt.id)
    );
    const existingByYear = new Map(existing.map((r: any) => [Number(r.year), r]));
    const years = [...new Set<number>([...range, ...existing.map((r: any) => Number(r.year))])].sort((a, b) => a - b);
    const draft: VolumeDraftRow[] = (years.length > 0 ? years : [new Date().getFullYear()]).map((year) => {
      const row = existingByYear.get(year);
      return {
        year,
        volume_value: row ? String(row.volume_value) : '0',
        volume_unit: (row?.volume_unit as VolumeUnit) ?? 'annual',
      };
    });
    setVolumeDraft(draft);
    setVolumeModalPart({ part: pt, project: p });
  };

  const closeVolumeModal = () => {
    if (volumeSaving) return;
    setVolumeModalPart(null);
    setVolumeError(null);
  };

  const updateVolumeDraftRow = (year: number, field: 'volume_value' | 'volume_unit', value: string) => {
    setVolumeDraft((prev) => prev.map((r) => (r.year === year ? { ...r, [field]: value } : r)));
  };

  /** Zapisuje w snapshotcie lokalnie (bez ponownego GET) — odpowiedź serwera ma znormalizowane wiersze. */
  const applyPartVolumeResult = (
    partId: number,
    res: { volume_mode: string; volumes: { part_id: number; year: number; volume_value: number; volume_unit: string }[] }
  ) => {
    setScenario((s) => {
      if (!s?.snapshot) return s;
      const nextParts = ((s.snapshot.parts as any[]) ?? []).map((pt: any) =>
        Number(pt.id) === partId ? { ...pt, volume_mode: res.volume_mode } : pt
      );
      const others = ((s.snapshot.part_volume_by_year as any[]) ?? []).filter((r: any) => Number(r.part_id) !== partId);
      return {
        ...s,
        snapshot: { ...s.snapshot, parts: nextParts, part_volume_by_year: [...others, ...res.volumes] },
      };
    });
  };

  const saveVolumeOverride = async () => {
    const sid = scenario?.id;
    if (!sid || !volumeModalPart) return;
    const entries = volumeDraft
      .map((d) => ({ year: Number(d.year), volume_value: Number(d.volume_value), volume_unit: d.volume_unit }))
      .filter((d) => Number.isFinite(d.year) && Number.isFinite(d.volume_value) && d.volume_value >= 0);
    if (entries.length === 0) {
      setVolumeError('Podaj przynajmniej jeden rok z wolumenem (≥ 0).');
      return;
    }
    setVolumeSaving(true);
    setVolumeError(null);
    try {
      const res = await api.scenarios.putPartVolumes(sid, Number(volumeModalPart.part.id), { mode: 'override', volumes: entries });
      applyPartVolumeResult(Number(volumeModalPart.part.id), res);
      setVolumeModalPart(null);
    } catch (e: any) {
      setVolumeError(te(e?.message) || 'Błąd zapisu wolumenu detalu.');
    } finally {
      setVolumeSaving(false);
    }
  };

  const resetVolumeOverride = async () => {
    const sid = scenario?.id;
    if (!sid || !volumeModalPart) return;
    setVolumeSaving(true);
    setVolumeError(null);
    try {
      const res = await api.scenarios.putPartVolumes(sid, Number(volumeModalPart.part.id), { mode: 'project' });
      applyPartVolumeResult(Number(volumeModalPart.part.id), res);
      setVolumeModalPart(null);
    } catch (e: any) {
      setVolumeError(te(e?.message) || 'Błąd zapisu wolumenu detalu.');
    } finally {
      setVolumeSaving(false);
    }
  };

  if (loading) return <p>{t('common.loading')}</p>;
  if (loadError) {
    return (
      <div>
        <div style={{ marginBottom: '1rem' }}>
          <Link to="/scenariusze" style={{ color: 'var(--cap-green)' }}>
            ← Scenariusze
          </Link>
        </div>
        <p style={{ color: 'var(--cap-red)' }}>{loadError}</p>
      </div>
    );
  }
  if (!scenario) return <p>{t('common.loadError')}</p>;

  const projects = bundleProjects;
  const parts = bundleParts;
  const operations = bundleOperations;

  const sourceDescription =
    scenario.source_scenario_id != null && scenario.source_scenario_id > 0
      ? t('scenarioViewExtra.sourceCopy', { name: sourceParentName ?? `#${scenario.source_scenario_id}` })
      : t('scenarioViewExtra.sourceFromProduction');

  const designations = scenario.snapshot?.part_designations ?? [];

  const toggleProjectExpanded = (pid: number) => {
    setExpandedProjectIds((prev) => (prev.includes(pid) ? prev.filter((x) => x !== pid) : [...prev, pid]));
  };
  const togglePartExpanded = (tid: number) => {
    setExpandedPartIds((prev) => (prev.includes(tid) ? prev.filter((x) => x !== tid) : [...prev, tid]));
  };

  const partLabel = (pt: any) => {
    const pd = designations.find((d: any) => Number(d.id) === Number(pt.designation_id));
    return formatDetailSapAliasLabel(
      {
        sap_number: pd?.sap_number ?? null,
        alias: pd?.alias ?? null,
        free_text: pd?.free_text ?? null,
        designation: pt.designation ?? null,
        id: pt.id,
      },
      referenceDisplay
    );
  };

  const openAddProjectsModal = () => {
    if (!scenario?.id || scenario.archived_at) return;
    setAddProjectsError(null);
    setScenarioActionInfo(null);
    setAddProjectsPick([]);
    setAddProjectsModalOpen(true);
    setAddProjectsLoading(true);
    api.scenarios
      .addableProjects(scenario.id)
      .then((rows) => {
        setAddProjectsCandidates(Array.isArray(rows) ? rows : []);
      })
      .catch((e: any) => {
        setAddProjectsError(te(e?.message) || t('scenarioViewExtra.projectsListFailed'));
        setAddProjectsCandidates([]);
      })
      .finally(() => setAddProjectsLoading(false));
  };

  const toggleAddProjectPick = (pid: number) => {
    setAddProjectsPick((prev) => (prev.includes(pid) ? prev.filter((x) => x !== pid) : [...prev, pid]));
  };

  const toggleAddAllCandidates = () => {
    const ids = addProjectsCandidates.map((c) => c.id);
    setAddProjectsPick((prev) => (ids.length > 0 && ids.every((i) => prev.includes(i)) ? [] : ids));
  };

  const submitAddProjectsFromCapacity = async () => {
    if (!scenario?.id || addProjectsPick.length === 0) return;
    setAddProjectsBusy(true);
    setAddProjectsError(null);
    try {
      const r = await api.scenarios.addProjectsFromCapacity(scenario.id, { projectIds: addProjectsPick });
      const fresh = await api.scenarios.get(scenario.id);
      setScenario(fresh);
      setAddProjectsModalOpen(false);
      setAddProjectsPick([]);
      const parts: string[] = [`Dodano ${r.addedProjectIds.length} projekt(ów) do scenariusza.`];
      if (r.skippedAlreadyInBundle?.length) parts.push(`Pominięto (już w scenariuszu): ${r.skippedAlreadyInBundle.join(', ')}.`);
      if (r.notFoundInProduction?.length) parts.push(`Brak w produkcji: ${r.notFoundInProduction.join(', ')}.`);
      setScenarioActionInfo(parts.join(' '));
    } catch (e: any) {
      setAddProjectsError(te(e?.message) || t('scenarioViewExtra.addProjectsFailed'));
    } finally {
      setAddProjectsBusy(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <Link to="/scenariusze" style={{ color: 'var(--cap-green)' }}>
          {t('scenarioViewExtra.back')}
        </Link>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12, marginTop: 0 }}>
        <h1 style={{ marginTop: 0, marginBottom: 0 }}>{t('scenarioViewExtra.title', { name: scenario.name })}</h1>
        <Link to={`/scenariusze/${scenario.id}/edycja`} style={{ fontSize: 14, color: '#1565c0' }}>
          {t('scenarioViewExtra.editNameScope')}
        </Link>
      </div>
      {scenario.archived_at && (
        <div
          style={{
            background: '#efebe9',
            border: '1px solid #a1887f',
            borderRadius: 8,
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            color: '#4e342e',
            fontSize: 14,
          }}
        >
          <strong>{t('scenarioViewExtra.archivedBanner')}</strong> {t('scenarioViewExtra.archivedAt', { date: new Date(scenario.archived_at).toLocaleString('pl-PL') })} {t('scenarioViewExtra.restoreHint')}{' '}
          <Link to="/scenariusze" style={{ color: '#00695c' }}>
            {t('scenarios.title')}
          </Link>{' '}
          {t('scenarioViewExtra.restoreSteps')}
        </div>
      )}
      <p style={{ color: '#666' }}>
        {t('scenarioViewExtra.created')} {new Date(scenario.created_at).toLocaleString('pl-PL')}
        {scenario.updated_at ? ` · ${t('scenarioViewExtra.lastChange')} ${new Date(scenario.updated_at).toLocaleString('pl-PL')}` : null}
      </p>
      <p style={{ color: '#555', marginBottom: '1rem' }}>
        <strong>{t('scenarioViewExtra.sourcePoint')}</strong> {sourceDescription}
      </p>
      {scenario.scenario_scope != null && String(scenario.scenario_scope).trim() !== '' && (
        <p style={{ color: '#37474f', marginBottom: '1rem', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
          <strong>{t('scenarioViewExtra.scope')}</strong> {String(scenario.scenario_scope).trim()}
        </p>
      )}
      {scenarioActionInfo ? (
        <p style={{ margin: '0 0 0.75rem', padding: '0.5rem 0.75rem', background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 6, color: '#1b5e20', fontSize: 14 }}>
          {scenarioActionInfo}
        </p>
      ) : null}
      {addProjectsModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-projects-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: 16,
          }}
          onClick={() => !addProjectsBusy && setAddProjectsModalOpen(false)}
        >
          <div
            style={{
              background: 'white',
              maxWidth: 720,
              width: '100%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              padding: '1.25rem',
              borderRadius: 8,
              boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="add-projects-modal-title" style={{ marginTop: 0, fontSize: '1.15rem' }}>
              {t('scenarioViewExtra.addProjectsTitle')}
            </h2>
            <p style={{ color: '#555', fontSize: 14, lineHeight: 1.45, marginBottom: 12 }}>
              {t('scenarioViewExtra.addProjectsIntro')}
            </p>
            {addProjectsError ? <p style={{ color: 'var(--cap-red)', marginBottom: 8 }}>{addProjectsError}</p> : null}
            {addProjectsLoading ? (
              <p style={{ color: '#666' }}>{t('scenarioViewExtra.loadingList')}</p>
            ) : addProjectsCandidates.length === 0 ? (
              <p style={{ color: '#666' }}>{t('scenarioViewExtra.noProjectsToAdd')}</p>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={addProjectsCandidates.length > 0 && addProjectsCandidates.every((c) => addProjectsPick.includes(c.id))}
                      onChange={toggleAddAllCandidates}
                    />
                    {t('scenarioViewExtra.selectAll', { count: addProjectsCandidates.length })}
                  </label>
                  <span style={{ fontSize: 13, color: '#666' }}>{t('scenarioViewExtra.selected', { count: addProjectsPick.length })}</span>
                </div>
                <div style={{ overflow: 'auto', maxHeight: 'min(52vh, 420px)', border: '1px solid #e0e0e0', borderRadius: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                    <thead>
                      <tr style={{ background: '#f5f5f5', position: 'sticky', top: 0 }}>
                        <th style={{ padding: '0.5rem', width: 40 }} aria-label={t('scenarioViewExtra.selectionAria')} />
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projects.client')}</th>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projects.name')}</th>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projects.sop')}</th>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('projects.eop')}</th>
                        <th style={{ padding: '0.5rem', textAlign: 'left' }}>{t('scenarioViewExtra.statusCapacity')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {addProjectsCandidates.map((c) => (
                        <tr key={c.id} style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                            <input type="checkbox" checked={addProjectsPick.includes(c.id)} onChange={() => toggleAddProjectPick(c.id)} />
                          </td>
                          <td style={{ padding: '0.5rem' }}>{c.client}</td>
                          <td style={{ padding: '0.5rem' }}>{c.name}</td>
                          <td style={{ padding: '0.5rem' }}>{c.sop ?? '—'}</td>
                          <td style={{ padding: '0.5rem' }}>{c.eop ?? '—'}</td>
                          <td style={{ padding: '0.5rem' }}>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '0.2rem 0.45rem',
                                borderRadius: 4,
                                fontSize: 12,
                                fontWeight: 600,
                                color: '#fff',
                                background: c.status === 'active' ? 'var(--cap-green)' : c.status === 'RFQ' ? '#ff9800' : '#9e9e9e',
                              }}
                            >
                              {c.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={addProjectsBusy}
                onClick={() => setAddProjectsModalOpen(false)}
                style={{ padding: '0.5rem 1rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4, cursor: addProjectsBusy ? 'not-allowed' : 'pointer' }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={addProjectsBusy || addProjectsPick.length === 0 || addProjectsLoading || addProjectsCandidates.length === 0}
                onClick={() => void submitAddProjectsFromCapacity()}
                style={{
                  padding: '0.5rem 1rem',
                  background: addProjectsPick.length === 0 ? '#bdbdbd' : 'var(--cap-green)',
                  color: 'white',
                  border: 'none',
                  borderRadius: 4,
                  cursor: addProjectsPick.length === 0 || addProjectsBusy ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                }}
              >
                {addProjectsBusy ? t('scenarioViewExtra.adding') : t('scenarioViewExtra.addSelected')}
              </button>
            </div>
          </div>
        </div>
      )}
      {volumeModalPart && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="volume-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: 16,
          }}
          onClick={closeVolumeModal}
        >
          <div
            style={{
              background: 'white',
              maxWidth: 560,
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              padding: '1.25rem',
              borderRadius: 8,
              boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="volume-modal-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
              Wolumen detalu: {partLabel(volumeModalPart.part)}
            </h2>
            <p style={{ color: '#555', fontSize: 13, lineHeight: 1.45, marginBottom: 12 }}>
              Zmiana obowiązuje tylko w tym scenariuszu — nie wpływa na kalkulator produkcyjny. Bieżący tryb:{' '}
              <strong>
                {String(volumeModalPart.part.volume_mode ?? 'project') === 'override'
                  ? 'nadpisanie (scenariusz)'
                  : 'dziedziczy z projektu'}
              </strong>
              .
            </p>
            {volumeError ? <p style={{ color: 'var(--cap-red)', marginBottom: 8, fontSize: 13 }}>{volumeError}</p> : null}
            <div style={{ overflow: 'auto', maxHeight: 'min(48vh, 380px)', border: '1px solid #e0e0e0', borderRadius: 6, marginBottom: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f5f5f5', position: 'sticky', top: 0 }}>
                    <th style={{ padding: '0.4rem', textAlign: 'left' }}>Rok</th>
                    <th style={{ padding: '0.4rem', textAlign: 'left' }}>Wolumen</th>
                    <th style={{ padding: '0.4rem', textAlign: 'left' }}>Jednostka</th>
                  </tr>
                </thead>
                <tbody>
                  {volumeDraft.map((row) => (
                    <tr key={row.year} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: '0.35rem 0.4rem', fontWeight: 600 }}>{row.year}</td>
                      <td style={{ padding: '0.35rem 0.4rem' }}>
                        <input
                          type="number"
                          min={0}
                          value={row.volume_value}
                          onChange={(e) => updateVolumeDraftRow(row.year, 'volume_value', e.target.value)}
                          style={{ width: 110, padding: '0.3rem', border: '1px solid #ccc', borderRadius: 4 }}
                        />
                      </td>
                      <td style={{ padding: '0.35rem 0.4rem' }}>
                        <select
                          value={row.volume_unit}
                          onChange={(e) => updateVolumeDraftRow(row.year, 'volume_unit', e.target.value)}
                          style={{ padding: '0.3rem', border: '1px solid #ccc', borderRadius: 4 }}
                        >
                          <option value="annual">rocznie</option>
                          <option value="monthly">miesięcznie</option>
                          <option value="weekly">tygodniowo</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={volumeSaving}
                onClick={() => void resetVolumeOverride()}
                title="Usuwa nadpisanie — detal wraca do wolumenu dziedziczonego z projektu"
                style={{
                  padding: '0.5rem 1rem',
                  background: '#fff',
                  color: '#9e9e9e',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  cursor: volumeSaving ? 'not-allowed' : 'pointer',
                }}
              >
                Przywróć wolumen z projektu
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  disabled={volumeSaving}
                  onClick={closeVolumeModal}
                  style={{ padding: '0.5rem 1rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4, cursor: volumeSaving ? 'not-allowed' : 'pointer' }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={volumeSaving}
                  onClick={() => void saveVolumeOverride()}
                  style={{
                    padding: '0.5rem 1rem',
                    background: 'var(--cap-green)',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    cursor: volumeSaving ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {volumeSaving ? t('common.saving') : t('common.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <h2 style={{ marginTop: '1.5rem' }}>{t('scenarioViewExtra.projectsInScenario')}</h2>
      {projectStatusError ? <p style={{ color: 'var(--cap-red)', marginBottom: 8 }}>{projectStatusError}</p> : null}
      <p style={{ margin: '0 0 0.75rem', fontSize: 14, color: '#555', maxWidth: 920 }}>
        {t('scenarioViewExtra.calculatorIntro')}
        {scenario.archived_at ? (
          <span>
            {' '}
            <strong>{t('scenarioViewExtra.calculatorArchivedNote')}</strong>
          </span>
        ) : null}
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem' }}>
        <button
          type="button"
          onClick={openAddProjectsModal}
          disabled={!!scenario.archived_at}
          title={
            scenario.archived_at
              ? t('scenarioViewExtra.addProjectsArchived')
              : t('scenarioViewExtra.addProjectsHint')
          }
          style={{
            padding: '0.45rem 0.95rem',
            border: '1px solid #1565c0',
            borderRadius: 6,
            cursor: scenario.archived_at ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            background: scenario.archived_at ? '#eceff1' : '#fff',
            color: scenario.archived_at ? '#9e9e9e' : '#0d47a1',
          }}
        >
          {t('scenarioViewExtra.addProjectsTitle')}
        </button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <th style={{ padding: '0.5rem', width: 36 }} aria-label={t('scenarioViewExtra.expandAria')} />
            <SortableTh label={t('projects.client')} active={projSortCol === 'client'} direction={projSortDir} onClick={() => toggleProjSort('client')} />
            <SortableTh label={t('projects.name')} active={projSortCol === 'name'} direction={projSortDir} onClick={() => toggleProjSort('name')} />
            <SortableTh label={t('projects.sop')} active={projSortCol === 'sop'} direction={projSortDir} onClick={() => toggleProjSort('sop')} />
            <SortableTh label={t('projects.eop')} active={projSortCol === 'eop'} direction={projSortDir} onClick={() => toggleProjSort('eop')} />
            <SortableTh label={t('projects.status')} active={projSortCol === 'status'} direction={projSortDir} onClick={() => toggleProjSort('status')} />
          </tr>
          <tr style={{ background: '#fafafa' }}>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }} />
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('projects.client') })} value={filterKlient} onChange={(e) => setFilterKlient(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('projects.name') })} value={filterNazwa} onChange={(e) => setFilterNazwa(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('projects.sop') })} value={filterSop} onChange={(e) => setFilterSop(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('projects.eop') })} value={filterEop} onChange={(e) => setFilterEop(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <StatusMultiFilter selected={filterStatuses} onChange={setFilterStatuses} />
            </th>
          </tr>
        </thead>
        <tbody>
          {filteredProjects.map((p: any) => {
            const pid = Number(p.id);
            const pParts = partsByProject.get(pid) ?? [];
            const projOpen = expandedProjectIds.includes(pid);
            const projBorder = projectDescendantMismatch(p, pParts, opsByPart);
            const pDecl = declaredProjectStatus(p);
            const pCols = statusControlColors(pDecl);
            return (
              <Fragment key={`proj-${pid}`}>
                <tr style={{ background: '#fff' }}>
                  <td style={{ padding: '0.35rem', verticalAlign: 'middle', textAlign: 'center' }}>
                    <button
                      type="button"
                      aria-expanded={projOpen}
                      onClick={() => toggleProjectExpanded(pid)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 14,
                        padding: '2px 4px',
                        lineHeight: 1,
                      }}
                      title={projOpen ? 'Zwiń detale' : 'Rozwiń detale'}
                    >
                      {projOpen ? '▼' : '▶'}
                    </button>
                  </td>
                  <td style={{ padding: '0.75rem' }}>{p.client}</td>
                  <td style={{ padding: '0.75rem' }}>{p.name}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <SopEopInput
                      value={p.sop}
                      disabled={!!scenario.archived_at}
                      onSave={(next) => void handleScenarioProjectDate(p, 'sop', next)}
                    />
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <SopEopInput
                      value={p.eop}
                      disabled={!!scenario.archived_at}
                      onSave={(next) => void handleScenarioProjectDate(p, 'eop', next)}
                    />
                  </td>
                  <td style={{ padding: '0.75rem' }}>
                    <select
                      value={p.status ?? 'active'}
                      disabled={!!scenario.archived_at || statusSavingKey === `p:${pid}`}
                      onChange={(e) => void handleScenarioProjectStatus(p, e.target.value as LineStatus)}
                      style={{
                        minWidth: 120,
                        padding: '0.35rem 0.5rem',
                        borderRadius: 4,
                        border: projBorder ? '2px solid #d32f2f' : '1px solid #ccc',
                        fontWeight: 600,
                        ...pCols,
                      }}
                    >
                      <option value="active">{t('common.active')}</option>
                      <option value="inactive">{t('common.inactive')}</option>
                      <option value="RFQ">{t('common.rfq')}</option>
                    </select>
                  </td>
                </tr>
                {projOpen &&
                  pParts.map((pt: any) => {
                    const tid = Number(pt.id);
                    const partOps = opsByPart.get(tid) ?? [];
                    const partOpen = expandedPartIds.includes(tid);
                    const partDisplay = effectivePartStatus(p, pt);
                    const partOwn = normScenarioStatus(pt.status);
                    const partSelVal = partOwn != null ? partOwn : INHERIT;
                    const partBorderWarn = partStatusBorderWarn(p, pt, partOps);
                    const partCols = statusControlColors(partDisplay);
                    return (
                      <Fragment key={`part-${pid}-${tid}`}>
                        <tr style={{ background: '#f5f9ff' }}>
                          <td
                            style={{
                              padding: '0.35rem',
                              paddingLeft: TREE_INDENT_EXPAND_PART,
                              textAlign: 'center',
                              verticalAlign: 'middle',
                            }}
                          >
                            {partOps.length > 0 ? (
                              <button
                                type="button"
                                aria-expanded={partOpen}
                                onClick={() => togglePartExpanded(tid)}
                                style={{
                                  border: 'none',
                                  background: 'transparent',
                                  cursor: 'pointer',
                                  fontSize: 13,
                                  padding: '2px 4px',
                                  lineHeight: 1,
                                }}
                                title={partOpen ? 'Zwiń operacje' : 'Rozwiń operacje'}
                              >
                                {partOpen ? '▼' : '▶'}
                              </button>
                            ) : (
                              <span style={{ display: 'inline-block', width: 22 }} />
                            )}
                          </td>
                          <td
                            colSpan={2}
                            style={{
                              padding: '0.55rem 0.75rem',
                              paddingLeft: TREE_INDENT_LABEL_PART,
                              fontSize: 13,
                            }}
                          >
                            <strong>Detal:</strong> {partLabel(pt)} <span style={{ color: '#888' }}>(#{tid})</span>
                            <button
                              type="button"
                              onClick={() => openVolumeModal(p, pt)}
                              disabled={!!scenario.archived_at}
                              title="Zmiana wolumenu — tylko w tym scenariuszu, nie zmienia produkcji"
                              style={{
                                marginLeft: 10,
                                padding: '2px 8px',
                                fontSize: 12,
                                border: '1px solid #1565c0',
                                borderRadius: 4,
                                background: String(pt.volume_mode ?? 'project') === 'override' ? '#e3f2fd' : '#fff',
                                color: '#0d47a1',
                                cursor: scenario.archived_at ? 'not-allowed' : 'pointer',
                              }}
                            >
                              Wolumen{String(pt.volume_mode ?? 'project') === 'override' ? ' (nadpisany)' : ''}
                            </button>
                          </td>
                          <td style={{ padding: '0.55rem 0.75rem', fontSize: 13, color: '#888' }}>—</td>
                          <td style={{ padding: '0.55rem 0.75rem', fontSize: 13, color: '#888' }}>—</td>
                          <td style={{ padding: '0.55rem 0.75rem' }}>
                            <select
                              value={partSelVal}
                              disabled={!!scenario.archived_at || statusSavingKey === `pt:${tid}`}
                              onChange={(e) => {
                                const v = e.target.value;
                                void handlePartStatus(p, pt, v === INHERIT ? null : (v as LineStatus));
                              }}
                              style={{
                                minWidth: 130,
                                padding: '0.35rem 0.5rem',
                                borderRadius: 4,
                                border: partBorderWarn ? '2px solid #d32f2f' : '1px solid #ccc',
                                fontWeight: 600,
                                ...partCols,
                              }}
                            >
                              <option value={INHERIT}>jak projekt ({declaredProjectStatus(p)})</option>
                              <option value="active">{t('common.active')}</option>
                              <option value="inactive">{t('common.inactive')}</option>
                              <option value="RFQ">{t('common.rfq')}</option>
                            </select>
                          </td>
                        </tr>
                        {partOpen &&
                          partOps.map((op: any) => {
                            const oid = Number(op.id);
                            const opDisplay = effectiveOpStatus(p, pt, op);
                            const opOwn = normScenarioStatus(op.status);
                            const opSelVal = opOwn != null ? opOwn : INHERIT;
                            const opCols = statusControlColors(opDisplay);
                            return (
                              <tr key={`op-${pid}-${tid}-${oid}`} style={{ background: '#eef2f6' }}>
                                <td style={{ padding: 0, paddingLeft: TREE_INDENT_EXPAND_OP, width: 36 }} />
                                <td
                                  colSpan={2}
                                  style={{
                                    padding: '0.45rem 0.75rem',
                                    paddingLeft: TREE_INDENT_LABEL_OP,
                                    fontSize: 12,
                                    color: '#37474f',
                                  }}
                                >
                                  Operacja #{oid} · maszyna {op.machine_id}
                                  {op.phase_id != null ? ` · faza ${op.phase_id}` : ''}
                                </td>
                                <td style={{ fontSize: 12, color: '#888' }}>—</td>
                                <td style={{ fontSize: 12, color: '#888' }}>—</td>
                                <td style={{ padding: '0.45rem 0.75rem' }}>
                                  <select
                                    value={opSelVal}
                                    disabled={!!scenario.archived_at || statusSavingKey === `op:${oid}`}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      void handleOperationStatus(p, pt, op, v === INHERIT ? null : (v as LineStatus));
                                    }}
                                    style={{
                                      minWidth: 130,
                                      padding: '0.35rem 0.5rem',
                                      borderRadius: 4,
                                      border: '1px solid #ccc',
                                      fontWeight: 600,
                                      ...opCols,
                                    }}
                                  >
                                    <option value={INHERIT}>jak detal ({effectivePartStatus(p, pt)})</option>
                                    <option value="active">{t('common.active')}</option>
                                    <option value="inactive">{t('common.inactive')}</option>
                                    <option value="RFQ">{t('common.rfq')}</option>
                                  </select>
                                </td>
                              </tr>
                            );
                          })}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {filteredProjects.length === 0 && <p style={{ color: '#666' }}>{projects.length === 0 ? t('scenarioViewExtra.noProjects') : t('scenarioViewExtra.noFilterResults')}</p>}
      <p style={{ marginTop: '1rem', fontSize: 14, color: '#666' }}>
        W scenariuszu: {projects.length} projektów, {parts.length} części, {operations.length} operacji.
      </p>
    </div>
  );
}
