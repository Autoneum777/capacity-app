import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { confirmDelete } from '../confirmDelete';
import { useI18n } from '../context/I18nContext';
import { useReferenceDisplay } from '../context/ReferenceDisplayContext';
import { formatDetailSapAliasLabel } from '../utils/detailLabel';
import { blankMassKg } from '../utils/baselineMaterialMass';

type ExternalVolumeRow = { year: number; weekly_volume: string };

type MaterialForm = {
  alias: string;
  description: string;
  sap_number: string;
  includeInCapacity: boolean;
  productionSharePercent: string;
  grammage_kg_m2: string;
  width_mm: string;
  length_mm: string;
  useExternalVolume: boolean;
  externalVolumes: ExternalVolumeRow[];
  designationIds: number[];
  designationConsumptions: Record<number, string>;
};

const EMPTY: MaterialForm = {
  alias: '',
  description: '',
  sap_number: '',
  includeInCapacity: true,
  productionSharePercent: '100',
  grammage_kg_m2: '',
  width_mm: '',
  length_mm: '',
  useExternalVolume: false,
  externalVolumes: [],
  designationIds: [],
  designationConsumptions: {},
};

function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fmtMass(v: number | null | undefined, dash: string): string {
  if (v == null || !Number.isFinite(Number(v))) return dash;
  return String(Number(v));
}

function fmtHourlyCapacity(v: number | null | undefined, dash: string): string {
  if (v == null || !Number.isFinite(Number(v))) return dash;
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function containsText(value: unknown, query: string): boolean {
  if (!query) return true;
  return String(value ?? '')
    .toLowerCase()
    .includes(query);
}

function containsNumber(value: unknown, query: string): boolean {
  if (!query) return true;
  if (value == null || value === '') return false;
  const normalizedQuery = query.replace(/\s/g, '').replace(',', '.');
  const comparison = normalizedQuery.match(/^(<=|>=|<|>)(-?\d+(?:\.\d+)?)$/);
  if (comparison) {
    const actual = Number(value);
    const expected = Number(comparison[2]);
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
    if (comparison[1] === '<') return actual < expected;
    if (comparison[1] === '>') return actual > expected;
    if (comparison[1] === '<=') return actual <= expected;
    return actual >= expected;
  }
  const raw = String(value);
  const q = normalizedQuery.toLowerCase();
  return raw.toLowerCase().includes(q) || raw.replace('.', ',').toLowerCase().includes(q);
}

function detailsText(row: any): string {
  return ((row.details ?? []) as { label?: string; consumption_per_detail?: number }[])
    .map((d) => `${d.label || ''} ${d.consumption_per_detail ?? 1}`)
    .filter(Boolean)
    .join(', ');
}

/** Który czynnik ogranicza wydajność rzeczywistą materiału: masa (przepływ) czy prędkość linii. */
function limitingFactor(row: any): 'mass' | 'speed' | null {
  const massNum = row.mass_capacity_per_hour == null ? null : Number(row.mass_capacity_per_hour);
  const speedNum = row.speed_capacity_per_hour == null ? null : Number(row.speed_capacity_per_hour);
  const massValid = massNum != null && Number.isFinite(massNum);
  const speedValid = speedNum != null && Number.isFinite(speedNum);
  if (!massValid && !speedValid) return null;
  if (!massValid) return 'speed';
  if (!speedValid) return 'mass';
  return (massNum as number) <= (speedNum as number) ? 'mass' : 'speed';
}

type SortKey =
  | 'alias'
  | 'description'
  | 'sap_number'
  | 'production_share_percent'
  | 'details'
  | 'grammage_kg_m2'
  | 'width_mm'
  | 'length_mm'
  | 'blank_mass_kg'
  | 'include_in_capacity'
  | 'web_width_mm'
  | 'mass_capacity_per_hour'
  | 'speed_capacity_per_hour'
  | 'actual_capacity_per_hour';

function sortValue(row: any, key: SortKey): string | number | null {
  switch (key) {
    case 'details':
      return detailsText(row).toLowerCase();
    case 'include_in_capacity':
      return Number(row.include_in_capacity ?? 1);
    case 'alias':
    case 'description':
    case 'sap_number':
      return String(row[key] ?? '').toLowerCase();
    case 'production_share_percent': {
      const v = row.production_share_percent;
      return v == null ? 100 : Number(v);
    }
    default: {
      const v = row[key];
      return v == null ? null : Number(v);
    }
  }
}

type MaterialFilters = {
  search: string;
  alias: string;
  description: string;
  sap: string;
  details: string;
  grammage: string;
  width: string;
  length: string;
  mass: string;
  share: string;
  /** '' = wszystkie, 'yes' = tylko wliczane, 'no' = tylko wyłączone z capacity */
  includeFilter: string;
  /** '' = wszystkie, 'mass' = ograniczone wydajnością (masą), 'speed' = ograniczone prędkością */
  limitFilter: string;
};

const EMPTY_FILTERS: MaterialFilters = {
  search: '',
  alias: '',
  description: '',
  sap: '',
  details: '',
  grammage: '',
  width: '',
  length: '',
  mass: '',
  share: '',
  includeFilter: '',
  limitFilter: '',
};

export default function BaselineMaterialsSection({
  machineId,
  maxBlankWidthMm,
  maxBlankWidthUnit,
  minLengthMm,
}: {
  machineId: number;
  maxBlankWidthMm?: number | null;
  maxBlankWidthUnit?: string | null;
  minLengthMm?: number | null;
}) {
  const { t, te } = useI18n();
  const { referenceDisplay } = useReferenceDisplay();
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<MaterialForm>(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [designations, setDesignations] = useState<any[]>([]);
  const [detailQuery, setDetailQuery] = useState('');
  /** Raz przypięte pozycje nie skaczą po liście przy odznaczeniu. */
  const [pinnedDetailIds, setPinnedDetailIds] = useState<number[]>([]);
  const [bulkConsumption, setBulkConsumption] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [filters, setFilters] = useState<MaterialFilters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    matched_details: number;
    materials_created: number;
    materials_updated: number;
    links_created: number;
    details_without_material?: number;
  } | null>(null);
  const routingInputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    api.machines.materials
      .list(machineId)
      .then((rows) => {
        setList(rows);
        setSelectedIds((prev) => prev.filter((id) => rows.some((r: any) => Number(r.id) === id)));
      })
      .catch((e) => setError(te(e?.message) || t('machineDetail.materialsLoadError')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [machineId]);

  useEffect(() => {
    setSelectedIds([]);
    setFilters(EMPTY_FILTERS);
    setSortKey(null);
    setSortDir('asc');
  }, [machineId]);

  useEffect(() => {
    api.machines.materials
      .designations(machineId)
      .then(setDesignations)
      .catch(() => setDesignations([]));
  }, [machineId]);

  const previewMass = useMemo(() => {
    const g = parseNum(form.grammage_kg_m2);
    const w = parseNum(form.width_mm);
    const l = parseNum(form.length_mm);
    if (g == null || w == null || l == null) return { after: null as number | null };
    return { after: blankMassKg(g, w, l) };
  }, [form.grammage_kg_m2, form.width_mm, form.length_mm]);

  const orientDimensions = (first: number, second: number) => {
    const configuredWidth = Number(maxBlankWidthMm);
    const maxWidth =
      Number.isFinite(configuredWidth) && configuredWidth > 0
        ? String(maxBlankWidthUnit ?? 'mm').toLowerCase() === 'cm'
          ? configuredWidth * 10
          : configuredWidth
        : 1400;
    const minLength = Number(minLengthMm);
    const minimumLength = Number.isFinite(minLength) && minLength >= 0 ? minLength : 650;
    // Oba boki większe niż maksymalna szerokość toru — żadna orientacja się nie zmieści,
    // więc szerokością bierzemy niższą z dwóch wartości (musi być zgodne z serwerem: orientBaselineDimensions).
    if (first > maxWidth && second > maxWidth) {
      return first <= second ? { width: first, length: second } : { width: second, length: first };
    }
    const candidates = [
      { width: first, length: second },
      { width: second, length: first },
    ].filter((d) => d.width <= maxWidth && d.length >= minimumLength);
    const selected = candidates.sort((a, b) => b.width - a.width)[0];
    return selected ?? (first <= maxWidth ? { width: first, length: second } : { width: second, length: first });
  };

  const handleLengthChange = (rawLength: string) => {
    const currentWidth = parseNum(form.width_mm);
    const newLength = parseNum(rawLength);
    if (currentWidth == null || newLength == null) {
      setForm((f) => ({ ...f, length_mm: rawLength }));
      return;
    }
    const oriented = orientDimensions(currentWidth, newLength);
    setForm((f) => ({
      ...f,
      width_mm: String(oriented.width),
      length_mm: String(oriented.length),
    }));
  };

  const detailOptions = useMemo(
    () =>
      designations
        .map((d) => ({
          id: Number(d.id),
          label: formatDetailSapAliasLabel(d, referenceDisplay),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'pl')),
    [designations, referenceDisplay]
  );

  /** Wybrane referencje zostają na górze listy, żeby dało się ustawić im zużycie bez szukania. */
  const visibleDetails = useMemo(() => {
    const q = detailQuery.trim().toLowerCase();
    const pinned = new Set<number>([...form.designationIds, ...pinnedDetailIds]);
    const top = detailOptions.filter((d) => pinned.has(d.id));
    const rest = detailOptions.filter((d) => !pinned.has(d.id));
    return [...top, ...(q ? rest.filter((d) => d.label.toLowerCase().includes(q)) : rest)];
  }, [detailOptions, detailQuery, form.designationIds, pinnedDetailIds]);

  const filteredList = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    const alias = filters.alias.trim().toLowerCase();
    const description = filters.description.trim().toLowerCase();
    const sap = filters.sap.trim().toLowerCase();
    const details = filters.details.trim().toLowerCase();
    const grammage = filters.grammage.trim().toLowerCase();
    const width = filters.width.trim().toLowerCase();
    const length = filters.length.trim().toLowerCase();
    const mass = filters.mass.trim().toLowerCase();
    const share = filters.share;
    const includeFilter = filters.includeFilter;
    const limitFilterVal = filters.limitFilter;
    return list.filter((row) => {
      const detailsLabel = detailsText(row);
      if (alias && !containsText(row.alias, alias)) return false;
      if (description && !containsText(row.description, description)) return false;
      if (sap && !containsText(row.sap_number, sap)) return false;
      if (details && !containsText(detailsLabel, details)) return false;
      if (grammage && !containsNumber(row.grammage_kg_m2, grammage)) return false;
      if (width && !containsNumber(row.width_mm, width)) return false;
      if (length && !containsNumber(row.length_mm, length)) return false;
      if (mass && !containsNumber(row.blank_mass_kg, mass)) return false;
      const rowShare = Number(row.production_share_percent ?? 100);
      if (share === 'below100' && !(rowShare < 100)) return false;
      if (share === '100' && rowShare !== 100) return false;
      const includedInCapacity = Number(row.include_in_capacity ?? 1) === 1;
      if (includeFilter === 'yes' && !includedInCapacity) return false;
      if (includeFilter === 'no' && includedInCapacity) return false;
      if (limitFilterVal && limitingFactor(row) !== limitFilterVal) return false;
      if (!search) return true;
      return (
        containsText(row.alias, search) ||
        containsText(row.description, search) ||
        containsText(row.sap_number, search) ||
        containsText(detailsLabel, search) ||
        containsNumber(row.grammage_kg_m2, search) ||
        containsNumber(row.width_mm, search) ||
        containsNumber(row.length_mm, search) ||
        containsNumber(row.blank_mass_kg, search) ||
        containsNumber(row.production_share_percent ?? 100, search)
      );
    });
  }, [list, filters]);

  const filtersActive = useMemo(
    () => Object.values(filters).some((v) => String(v).trim() !== ''),
    [filters]
  );

  const sortedList = useMemo(() => {
    if (!sortKey) return filteredList;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filteredList].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb), 'pl') * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });
  }, [filteredList, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '');

  const renderSortableHeader = (label: string, key: SortKey) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      title={t('machineDetail.materialsSortHint')}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        margin: 0,
        font: 'inherit',
        fontWeight: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        color: sortKey === key ? '#1976d2' : 'inherit',
      }}
    >
      {label}
      {sortArrow(key)}
    </button>
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY);
    setError('');
    setDetailQuery('');
    setPinnedDetailIds([]);
    setBulkConsumption('');
    setModalOpen(true);
  };

  const startEdit = (row: any) => {
    setEditingId(row.id);
    const linkedIds: number[] = Array.isArray(row.designation_ids)
      ? row.designation_ids.map(Number)
      : (row.details ?? []).map((d: any) => Number(d.id));
    setPinnedDetailIds(linkedIds);
    setBulkConsumption('');
    const useExtVol = Number(row.use_external_volume ?? 0) === 1;
    const formBase: MaterialForm = {
      alias: row.alias ?? '',
      description: row.description ?? '',
      sap_number: row.sap_number ?? '',
      includeInCapacity: Number(row.include_in_capacity ?? 1) === 1,
      productionSharePercent: String(row.production_share_percent ?? 100),
      grammage_kg_m2: row.grammage_kg_m2 != null ? String(row.grammage_kg_m2) : '',
      width_mm: row.width_mm != null ? String(row.width_mm) : '',
      length_mm: row.length_mm != null ? String(row.length_mm) : '',
      useExternalVolume: useExtVol,
      externalVolumes: [],
      designationIds: Array.isArray(row.designation_ids)
        ? row.designation_ids.map(Number)
        : (row.details ?? []).map((d: any) => Number(d.id)),
      designationConsumptions: Object.fromEntries(
        (row.details ?? []).map((d: any) => [
          Number(d.id),
          String(d.consumption_per_detail ?? 1),
        ])
      ),
    };
    setForm(formBase);
    setError('');
    setDetailQuery('');
    setModalOpen(true);
    if (useExtVol) {
      api.machines.materials.externalVolumes
        .list(machineId, row.id)
        .then((vols) =>
          setForm((f) => ({
            ...f,
            externalVolumes: vols.map((v) => ({ year: v.year, weekly_volume: String(v.weekly_volume) })),
          }))
        )
        .catch((e) => setError(te(e?.message) || 'Błąd ładowania wolumenów'));
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingId(null);
    setForm(EMPTY);
    setError('');
    setDetailQuery('');
    setPinnedDetailIds([]);
    setBulkConsumption('');
  };

  const applyBulkConsumption = () => {
    const value = parseNum(bulkConsumption);
    if (value == null || value < 0 || form.designationIds.length === 0) return;
    setForm((f) => ({
      ...f,
      designationConsumptions: {
        ...f.designationConsumptions,
        ...Object.fromEntries(f.designationIds.map((id) => [id, String(value)])),
      },
    }));
  };

  const toggleDetail = (id: number) => {
    setPinnedDetailIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setForm((f) => {
      if (f.designationIds.includes(id)) {
        const designationConsumptions = { ...f.designationConsumptions };
        delete designationConsumptions[id];
        return {
          ...f,
          designationIds: f.designationIds.filter((x) => x !== id),
          designationConsumptions,
        };
      }
      return {
        ...f,
        designationIds: [...f.designationIds, id],
        designationConsumptions: { ...f.designationConsumptions, [id]: '1' },
      };
    });
  };

  const handleSave = () => {
    if (!form.alias.trim() && !form.sap_number.trim()) {
      setError(t('machineDetail.materialsAliasOrSap'));
      return;
    }
    const productionShare = parseNum(form.productionSharePercent);
    if (productionShare == null || productionShare < 0 || productionShare > 100) {
      setError(t('machineDetail.materialProductionShareError'));
      return;
    }
    const body = {
      alias: form.alias.trim(),
      description: form.description.trim(),
      sap_number: form.sap_number.trim(),
      include_in_capacity: form.includeInCapacity,
      production_share_percent: productionShare,
      grammage_kg_m2: parseNum(form.grammage_kg_m2),
      width_mm: parseNum(form.width_mm),
      length_mm: parseNum(form.length_mm),
      use_external_volume: form.useExternalVolume,
      designation_ids: form.useExternalVolume ? [] : form.designationIds,
      designation_consumptions: form.useExternalVolume
        ? {}
        : Object.fromEntries(
            form.designationIds.map((id) => [
              id,
              Math.max(0, parseNum(form.designationConsumptions[id] ?? '1') ?? 1),
            ])
          ),
    };
    setSaving(true);
    setError('');
    const req =
      editingId != null
        ? api.machines.materials.update(machineId, editingId, body)
        : api.machines.materials.create(machineId, body);
    req
      .then(async (saved: any) => {
        const savedId = saved?.id ?? editingId;
        if (form.useExternalVolume && savedId != null) {
          const volRows = form.externalVolumes
            .map((r) => ({ year: Number(r.year), weekly_volume: parseNum(r.weekly_volume) ?? 0 }))
            .filter((r) => Number.isFinite(r.year) && r.year >= 1900 && r.year <= 2100);
          await api.machines.materials.externalVolumes.save(machineId, savedId, volRows);
        }
        closeModal();
        load();
      })
      .catch((e) => {
        setError(te(e?.message) || t('common.saveError'));
        setSaving(false);
      })
      .finally(() => setSaving(false));
  };

  const handleDelete = (row: any) => {
    if (!confirmDelete(t('machineDetail.materialsDeleteConfirm', { name: row.alias || row.sap_number || row.id }))) {
      return;
    }
    api.machines.materials
      .delete(machineId, row.id)
      .then(() => {
        setSelectedIds((prev) => prev.filter((id) => id !== Number(row.id)));
        load();
      })
      .catch((e) => setError(te(e?.message) || t('common.saveError')));
  };

  const confirmBulkDelete = (all: boolean, count: number) => {
    const first = all
      ? t('machineDetail.materialsDeleteAllConfirm', { count })
      : t('machineDetail.materialsDeleteSelectedConfirm', { count });
    const second = all
      ? t('machineDetail.materialsDeleteAllConfirmAgain')
      : t('machineDetail.materialsDeleteSelectedConfirmAgain', { count });
    return confirmDelete(first) && confirmDelete(second);
  };

  const handleBulkDelete = (all: boolean) => {
    const ids = all ? list.map((row) => Number(row.id)) : selectedIds;
    if (!ids.length) {
      setError(t('machineDetail.materialsDeleteNoneSelected'));
      return;
    }
    if (!confirmBulkDelete(all, ids.length)) return;
    setDeleting(true);
    setError('');
    api.machines.materials
      .bulkDelete(machineId, all ? { all: true } : { ids })
      .then(() => {
        setSelectedIds([]);
        load();
      })
      .catch((e) => setError(te(e?.message) || t('common.saveError')))
      .finally(() => setDeleting(false));
  };

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const visibleIds = filteredList.map((row) => Number(row.id));
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const someSelected = visibleIds.some((id) => selectedIds.includes(id)) && !allSelected;

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allSelected) return prev.filter((id) => !visibleIds.includes(id));
      return [...new Set([...prev, ...visibleIds])];
    });
  };

  const handleRoutingImport = (file: File) => {
    setImporting(true);
    setImportResult(null);
    setError('');
    api.machines.materials
      .importRouting(machineId, file)
      .then((result) => {
        setImportResult(result);
        load();
      })
      .catch((e) => setError(te(e?.message) || t('machineDetail.materialRoutingImportError')))
      .finally(() => {
        setImporting(false);
        if (routingInputRef.current) routingInputRef.current.value = '';
      });
  };

  const inputStyle = { width: '100%', padding: 6, boxSizing: 'border-box' as const };
  const columnFilterStyle = { width: '100%', padding: 4, fontSize: 12, boxSizing: 'border-box' as const };

  const setFilter = (key: keyof MaterialFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const renderColumnFilter = (key: keyof MaterialFilters, columnLabel: string) => (
    <input
      type="search"
      value={filters[key]}
      onChange={(e) => setFilter(key, e.target.value)}
      placeholder={t('common.filterColumn', { column: columnLabel })}
      style={columnFilterStyle}
    />
  );

  return (
    <div style={{ background: 'white', padding: '1.5rem', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('machineDetail.tabMaterials')}</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <input
            ref={routingInputRef}
            type="file"
            accept=".txt,text/plain"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleRoutingImport(file);
            }}
          />
          <button
            type="button"
            onClick={() => routingInputRef.current?.click()}
            disabled={importing}
            style={{ padding: '0.4rem 0.85rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {importing ? t('machineDetail.materialRoutingImporting') : t('machineDetail.materialRoutingImport')}
          </button>
          <button
            type="button"
            onClick={openCreate}
            style={{ padding: '0.4rem 0.85rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4, flexShrink: 0 }}
          >
            {t('machineDetail.materialsAdd')}
          </button>
          <button
            type="button"
            onClick={() => handleBulkDelete(false)}
            disabled={deleting || selectedIds.length === 0}
            style={{
              padding: '0.4rem 0.85rem',
              background: selectedIds.length === 0 ? '#ef9a9a' : '#c62828',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            {t('machineDetail.materialsDeleteSelected')}
          </button>
          <button
            type="button"
            onClick={() => handleBulkDelete(true)}
            disabled={deleting || list.length === 0}
            style={{
              padding: '0.4rem 0.85rem',
              background: list.length === 0 ? '#ef9a9a' : '#8e0000',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            {t('machineDetail.materialsDeleteAll')}
          </button>
        </div>
      </div>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>{t('machineDetail.materialsHint')}</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          type="search"
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
          placeholder={t('machineDetail.materialsSearchPlaceholder')}
          style={{ minWidth: 220, flex: '1 1 220px', padding: '0.4rem 0.6rem', boxSizing: 'border-box' }}
        />
        <button
          type="button"
          className="filter-clear-btn"
          onClick={() => setFilters(EMPTY_FILTERS)}
          disabled={!filtersActive}
          style={{ padding: '0.4rem 0.85rem' }}
        >
          {t('common.clearFilters')}
        </button>
        {filtersActive && (
          <span style={{ fontSize: 13, color: '#666' }}>
            {filteredList.length}/{list.length}
          </span>
        )}
      </div>

      {error && !modalOpen && <p style={{ color: 'var(--cap-red)' }}>{error}</p>}
      {importResult && (
        <p style={{ color: '#2e7d32', fontSize: 13 }}>
          {t('machineDetail.materialRoutingImportResult', {
            details: importResult.matched_details,
            created: importResult.materials_created,
            updated: importResult.materials_updated,
            links: importResult.links_created,
            withoutMaterial: importResult.details_without_material ?? 0,
          })}
        </p>
      )}

      {loading ? (
        <p>{t('common.loading')}</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem', width: 36 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleSelectAll}
                  disabled={filteredList.length === 0}
                  aria-label={t('machineDetail.materialsDeleteAll')}
                />
              </th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialAlias'), 'alias')}</th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialDescription'), 'description')}</th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialSap'), 'sap_number')}</th>
              <th style={{ padding: '0.5rem' }}>
                {renderSortableHeader(t('machineDetail.materialProductionShare'), 'production_share_percent')}
              </th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialDetails'), 'details')}</th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialGrammage'), 'grammage_kg_m2')}</th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialWidth'), 'width_mm')}</th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialLength'), 'length_mm')}</th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialMass'), 'blank_mass_kg')}</th>
              <th style={{ padding: '0.5rem' }}>
                {renderSortableHeader(t('machineDetail.materialIncludeInCapacityColumn'), 'include_in_capacity')}
              </th>
              <th style={{ padding: '0.5rem' }}>{renderSortableHeader(t('machineDetail.materialWebWidth'), 'web_width_mm')}</th>
              <th style={{ padding: '0.5rem' }}>
                {renderSortableHeader(t('machineDetail.materialMassCapacity'), 'mass_capacity_per_hour')}
              </th>
              <th style={{ padding: '0.5rem' }}>
                {renderSortableHeader(t('machineDetail.materialSpeedCapacity'), 'speed_capacity_per_hour')}
              </th>
              <th style={{ padding: '0.5rem' }}>
                {renderSortableHeader(t('machineDetail.materialActualCapacity'), 'actual_capacity_per_hour')}
              </th>
              <th />
            </tr>
            <tr style={{ background: '#fafafa' }}>
              <th style={{ padding: '4px 6px' }} />
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('alias', t('machineDetail.materialAlias'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('description', t('machineDetail.materialDescription'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('sap', t('machineDetail.materialSap'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                <select
                  value={filters.share}
                  onChange={(e) => setFilter('share', e.target.value)}
                  aria-label={t('machineDetail.materialProductionShare')}
                  style={columnFilterStyle}
                >
                  <option value="">{t('machineDetail.materialShareFilterAll')}</option>
                  <option value="below100">{t('machineDetail.materialShareFilterBelow100')}</option>
                  <option value="100">{t('machineDetail.materialShareFilter100')}</option>
                </select>
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('details', t('machineDetail.materialDetails'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('grammage', t('machineDetail.materialGrammage'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('width', t('machineDetail.materialWidth'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('length', t('machineDetail.materialLength'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                {renderColumnFilter('mass', t('machineDetail.materialMass'))}
              </th>
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                <select
                  value={filters.includeFilter}
                  onChange={(e) => setFilter('includeFilter', e.target.value)}
                  aria-label={t('machineDetail.materialIncludeInCapacityColumn')}
                  style={columnFilterStyle}
                >
                  <option value="">{t('machineDetail.materialIncludeFilterAll')}</option>
                  <option value="yes">{t('machineDetail.materialIncludeFilterYes')}</option>
                  <option value="no">{t('machineDetail.materialIncludeFilterNo')}</option>
                </select>
              </th>
              <th style={{ padding: '4px 6px' }} />
              <th style={{ padding: '4px 6px' }} />
              <th style={{ padding: '4px 6px' }} />
              <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                <select
                  value={filters.limitFilter}
                  onChange={(e) => setFilter('limitFilter', e.target.value)}
                  aria-label={t('machineDetail.materialActualCapacity')}
                  style={columnFilterStyle}
                >
                  <option value="">{t('machineDetail.materialLimitFilterAll')}</option>
                  <option value="mass">{t('machineDetail.materialLimitFilterMass')}</option>
                  <option value="speed">{t('machineDetail.materialLimitFilterSpeed')}</option>
                </select>
              </th>
              <th style={{ padding: '4px 6px' }} />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={16} style={{ padding: '0.75rem', color: '#888' }}>
                  {t('machineDetail.materialsEmpty')}
                </td>
              </tr>
            )}
            {list.length > 0 && filteredList.length === 0 && (
              <tr>
                <td colSpan={16} style={{ padding: '0.75rem', color: '#888' }}>
                  {t('machineDetail.materialsFilterEmpty')}
                </td>
              </tr>
            )}
            {sortedList.map((row) => (
              <tr key={row.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(Number(row.id))}
                    onChange={() => toggleSelected(Number(row.id))}
                  />
                </td>
                <td style={{ padding: '0.5rem' }}>{row.alias || t('common.dash')}</td>
                <td style={{ padding: '0.5rem' }}>{row.description || t('common.dash')}</td>
                <td style={{ padding: '0.5rem' }}>{row.sap_number || t('common.dash')}</td>
                <td style={{ padding: '0.5rem' }}>
                  {fmtMass(row.production_share_percent ?? 100, t('common.dash'))}%
                </td>
                <td style={{ padding: '0.5rem', maxWidth: 220 }}>
                  {(row.details ?? []).length
                    ? (row.details as { label: string; consumption_per_detail?: number }[])
                        .map(
                          (d) =>
                            `${d.label} (${fmtMass(d.consumption_per_detail ?? 1, '1')} ${t(
                              'machineDetail.materialConsumptionUnit'
                            )})`
                        )
                        .join(', ')
                    : t('common.dash')}
                </td>
                <td style={{ padding: '0.5rem' }}>{fmtMass(row.grammage_kg_m2, t('common.dash'))}</td>
                <td style={{ padding: '0.5rem' }}>{fmtMass(row.width_mm, t('common.dash'))}</td>
                <td style={{ padding: '0.5rem' }}>{fmtMass(row.length_mm, t('common.dash'))}</td>
                <td style={{ padding: '0.5rem' }}>{fmtMass(row.blank_mass_kg, t('common.dash'))}</td>
                <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                  {Number(row.include_in_capacity ?? 1) === 1 ? (
                    <span title={t('machineDetail.materialIncludeYes')} style={{ color: '#2e7d32', fontWeight: 700 }}>
                      ✔
                    </span>
                  ) : (
                    <span title={t('machineDetail.materialIncludeNo')} style={{ color: '#c62828', fontWeight: 700 }}>
                      ✖
                    </span>
                  )}
                </td>
                <td style={{ padding: '0.5rem' }}>{fmtMass(row.web_width_mm, t('common.dash'))}</td>
                <td style={{ padding: '0.5rem' }}>
                  {fmtHourlyCapacity(row.mass_capacity_per_hour, t('common.dash'))}
                </td>
                <td style={{ padding: '0.5rem' }}>
                  {fmtHourlyCapacity(row.speed_capacity_per_hour, t('common.dash'))}
                </td>
                <td style={{ padding: '0.5rem', fontWeight: 600 }}>
                  {fmtHourlyCapacity(row.actual_capacity_per_hour, t('common.dash'))}
                  {(() => {
                    const factor = limitingFactor(row);
                    if (!factor) return null;
                    return (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: '#888' }}>
                        ({factor === 'mass' ? t('machineDetail.materialLimitBadgeMass') : t('machineDetail.materialLimitBadgeSpeed')})
                      </span>
                    );
                  })()}
                </td>
                <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>
                  <button
                    type="button"
                    onClick={() => startEdit(row)}
                    style={{ marginRight: 6, padding: '0.25rem 0.5rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}
                  >
                    {t('commonExtra.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(row)}
                    style={{ padding: '0.25rem 0.5rem', background: '#c62828', color: 'white', border: 'none', borderRadius: 4 }}
                  >
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalOpen && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 120,
            padding: 16,
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background: 'white',
              padding: '1.5rem',
              borderRadius: 8,
              width: 'min(720px, 96vw)',
              maxHeight: '92vh',
              overflow: 'auto',
            }}
          >
            <h2 style={{ marginTop: 0 }}>
              {editingId != null ? t('machineDetail.materialsEdit') : t('machineDetail.materialsAdd')}
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label>
                {t('machineDetail.materialAlias')}
                <input value={form.alias} onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))} style={inputStyle} />
              </label>
              <label>
                {t('machineDetail.materialSap')}
                <input value={form.sap_number} onChange={(e) => setForm((f) => ({ ...f, sap_number: e.target.value }))} style={inputStyle} />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                {t('machineDetail.materialDescription')}
                <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} style={inputStyle} />
              </label>
              <label
                style={{
                  gridColumn: '1 / -1',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontWeight: 600,
                }}
              >
                <input
                  type="checkbox"
                  checked={form.includeInCapacity}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, includeInCapacity: e.target.checked }))
                  }
                />
                {t('machineDetail.materialIncludeInCapacity')}
              </label>
              <label
                style={{
                  gridColumn: '1 / -1',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontWeight: 600,
                }}
              >
                <input
                  type="checkbox"
                  checked={form.useExternalVolume}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, useExternalVolume: e.target.checked }))
                  }
                />
                {t('machineDetail.materialExternalVolume')}
              </label>
              <label>
                {t('machineDetail.materialProductionShare')}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    value={form.productionSharePercent}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, productionSharePercent: e.target.value }))
                    }
                    style={inputStyle}
                  />
                  <span>%</span>
                </div>
              </label>
              {form.useExternalVolume && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('machineDetail.materialExternalVolumeTable')}</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f5f5f5' }}>
                        <th style={{ textAlign: 'left', padding: '4px 8px', border: '1px solid #ddd' }}>{t('machineDetail.materialExtVolYear')}</th>
                        <th style={{ textAlign: 'left', padding: '4px 8px', border: '1px solid #ddd' }}>{t('machineDetail.materialExtVolWeekly')}</th>
                        <th style={{ padding: '4px 4px', border: '1px solid #ddd', width: 32 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {form.externalVolumes.map((row, idx) => (
                        <tr key={idx}>
                          <td style={{ padding: '2px 4px', border: '1px solid #ddd' }}>
                            <input
                              type="number"
                              min={2000}
                              max={2100}
                              step={1}
                              value={row.year}
                              onChange={(e) => {
                                const updated = [...form.externalVolumes];
                                updated[idx] = { ...updated[idx], year: Number(e.target.value) };
                                setForm((f) => ({ ...f, externalVolumes: updated }));
                              }}
                              style={{ width: 80, padding: 3 }}
                            />
                          </td>
                          <td style={{ padding: '2px 4px', border: '1px solid #ddd' }}>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              value={row.weekly_volume}
                              onChange={(e) => {
                                const updated = [...form.externalVolumes];
                                updated[idx] = { ...updated[idx], weekly_volume: e.target.value };
                                setForm((f) => ({ ...f, externalVolumes: updated }));
                              }}
                              style={{ width: 110, padding: 3 }}
                            />
                          </td>
                          <td style={{ padding: '2px 4px', border: '1px solid #ddd', textAlign: 'center' }}>
                            <button
                              type="button"
                              onClick={() =>
                                setForm((f) => ({
                                  ...f,
                                  externalVolumes: f.externalVolumes.filter((_, i) => i !== idx),
                                }))
                              }
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c62828', fontSize: 16, lineHeight: 1 }}
                              title={t('common.delete')}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button
                    type="button"
                    onClick={() =>
                      setForm((f) => {
                        const lastYear =
                          f.externalVolumes.length > 0
                            ? Math.max(...f.externalVolumes.map((r) => Number(r.year)))
                            : new Date().getFullYear() - 1;
                        return {
                          ...f,
                          externalVolumes: [
                            ...f.externalVolumes,
                            { year: lastYear + 1, weekly_volume: '' },
                          ],
                        };
                      })
                    }
                    style={{ marginTop: 6, padding: '4px 12px', background: '#1976d2', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
                  >
                    + {t('machineDetail.materialExtVolAdd')}
                  </button>
                </div>
              )}
              {!form.useExternalVolume && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ marginBottom: 2 }}>{t('machineDetail.materialDetails')}</div>
                <input
                  type="search"
                  value={detailQuery}
                  onChange={(e) => setDetailQuery(e.target.value)}
                  placeholder={t('machineDetail.materialDetailsSearch')}
                  style={{ ...inputStyle, marginBottom: 6 }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                  <span>{t('machineDetail.materialConsumptionBulk')}</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={bulkConsumption}
                    onChange={(e) => setBulkConsumption(e.target.value)}
                    placeholder="0,5"
                    style={{ width: 90, padding: 4 }}
                  />
                  <button
                    type="button"
                    onClick={applyBulkConsumption}
                    disabled={form.designationIds.length === 0 || parseNum(bulkConsumption) == null}
                    style={{ padding: '0.25rem 0.6rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 4 }}
                  >
                    {t('machineDetail.materialConsumptionBulkApply')}
                  </button>
                </div>
                <div
                  style={{
                    border: '1px solid #ddd',
                    borderRadius: 4,
                    maxHeight: 180,
                    overflowY: 'auto',
                    padding: 6,
                  }}
                >
                  {visibleDetails.length === 0 ? (
                    <div style={{ color: '#888', fontSize: 13, padding: 4 }}>{t('machineDetail.materialDetailsEmpty')}</div>
                  ) : (
                    visibleDetails.map((d) => {
                      const selected = form.designationIds.includes(d.id);
                      return (
                      <div
                        key={d.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '3px 4px',
                          fontSize: 13,
                          background: selected ? '#f1f8e9' : undefined,
                          borderRadius: 3,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleDetail(d.id)}
                        />
                        <span style={{ flex: 1 }}>{d.label}</span>
                        {selected && (
                          <>
                            <label htmlFor={`material-consumption-${d.id}`}>
                              {t('machineDetail.materialConsumption')}
                            </label>
                            <input
                              id={`material-consumption-${d.id}`}
                              type="number"
                              min={0}
                              step="any"
                              value={form.designationConsumptions[d.id] ?? '1'}
                              onChange={(e) =>
                                setForm((f) => ({
                                  ...f,
                                  designationConsumptions: {
                                    ...f.designationConsumptions,
                                    [d.id]: e.target.value,
                                  },
                                }))
                              }
                              style={{ width: 80, padding: 3 }}
                            />
                            <span>{t('machineDetail.materialConsumptionUnit')}</span>
                          </>
                        )}
                      </div>
                      );
                    })
                  )}
                </div>
                <span style={{ fontSize: 12, color: '#666' }}>
                  {t('machineDetail.materialDetailsSelected', { count: form.designationIds.length })}
                </span>
              </div>
              )}
              <label>
                {t('machineDetail.materialGrammage')}
                <input value={form.grammage_kg_m2} onChange={(e) => setForm((f) => ({ ...f, grammage_kg_m2: e.target.value }))} style={inputStyle} />
              </label>
              <label>
                {t('machineDetail.materialWidth')}
                <input value={form.width_mm} onChange={(e) => setForm((f) => ({ ...f, width_mm: e.target.value }))} style={inputStyle} />
              </label>
              <label>
                {t('machineDetail.materialLength')}
                <input value={form.length_mm} onChange={(e) => handleLengthChange(e.target.value)} style={inputStyle} />
              </label>
              <p style={{ margin: '8px 0 0' }}>
                <strong>{t('machineDetail.materialMass')}</strong> {fmtMass(previewMass.after, t('common.dash'))} kg
              </p>
            </div>
            {error && <p style={{ color: 'var(--cap-red)' }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{ padding: '0.45rem 0.9rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
              <button
                type="button"
                onClick={closeModal}
                style={{ padding: '0.45rem 0.9rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4 }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
