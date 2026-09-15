import { useEffect, useMemo, useState, useRef } from 'react';
import SortableTh from '../components/SortableTh';
import { useTableSort, sortRows } from '../utils/tableSort';
import { Link, useLocation } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { api } from '../api/client';
import SearchableSelect from '../components/SearchableSelect';
import MachineTypesMultiFilter from '../components/MachineTypesMultiFilter';
import MachineStatusActiveProjectsModal from '../components/MachineStatusActiveProjectsModal';
import MachineGroupsModal from '../components/MachineGroupsModal';
import StatusMultiFilter, { type ProjectStatusFilterValue } from '../components/StatusMultiFilter';
import { joinCsvFilter } from '../utils/filterParams';
import { digitsOnlyMachineLine, parseMachineLineForSave, toStoredMachineLine } from '../utils/machineLineInput';
import { parseInternalMachineNumber, parseOptionalInternalMachineNumber } from '../utils/internalMachineNumber';
import { machineStatusFromDb, machineStatusReadonlyStyle, machineStatusSelectStyle } from '../utils/machineStatusStyle';
import { useI18n } from '../context/I18nContext';
import { useAuth } from '../context/AuthContext';

type MachineFormStatus = 'active' | 'inactive' | 'RFQ';

type MachineFormState = {
  internal_number: string;
  sap_number: string;
  type: string;
  status: MachineFormStatus;
  location: string;
  machine_usage: string;
  oee_override: string;
  is_baseline: boolean;
};

const EMPTY_MACHINE: MachineFormState = {
  internal_number: '',
  sap_number: '',
  type: '',
  status: 'active',
  location: '',
  machine_usage: '1',
  oee_override: '',
  is_baseline: false,
};

function parseStatusFromImportCell(raw: unknown): MachineFormStatus {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'active';
  if (s.includes('nieaktyw')) return 'inactive';
  if (s === 'rfq' || s.includes('rfq')) return 'RFQ';
  return 'active';
}

function parseCsvOrTsv(text: string): string[][] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.length);
  const sep = text.includes('\t') ? '\t' : ',';
  return lines.map((line) => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (c === sep || c === ',')) { out.push(cur.trim()); cur = ''; if (c === ',') continue; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  });
}

function rowsToMachines(rows: string[][]): any[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const numIdx = header.findIndex((h) => /nr|numer|number|internal/.test(h));
  const sapIdx = header.findIndex((h) => /sap/.test(h));
  const typeIdx = header.findIndex((h) => /typ|type/.test(h));
  const statusIdx = header.findIndex((h) => /status/.test(h));
  const locIdx = header.findIndex((h) => /lok|location|hala|linia|nr_?linii|line/.test(h));
  const oeeIdx = header.findIndex((h) => /oee/.test(h));
  const machines: any[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const internal_number = numIdx >= 0 ? row[numIdx] : row[0];
    const type = typeIdx >= 0 ? row[typeIdx] : (row[2] ?? row[1]);
    if (!internal_number && !type) continue;
    const nrParsed = internal_number ? parseInternalMachineNumber(internal_number) : null;
    machines.push({
      internal_number: nrParsed?.ok ? nrParsed.value : internal_number ? String(internal_number).trim() : '',
      sap_number: sapIdx >= 0 ? row[sapIdx] : (row[1] ?? ''),
      type: String(type ?? '').trim(),
      status: statusIdx >= 0 ? parseStatusFromImportCell(row[statusIdx]) : 'active',
      location: locIdx >= 0 ? row[locIdx] : '',
      oee_override: oeeIdx >= 0 ? row[oeeIdx] : '',
    });
  }
  return machines;
}

export default function Machines() {
  const { t } = useI18n();
  const { hasAnyPermission } = useAuth();
  const canChangeStatus = hasAnyPermission(['machines.change_status', 'machines.edit']);
  const canViewDetails = hasAnyPermission(['machines.details', 'machines.edit']);
  const location = useLocation();
  const scenarioQs = location.search || '';
  const [list, setList] = useState<any[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /** Pusty = wszystkie statusy (jak w StatusMultiFilter). */
  const [toolbarStatusFilter, setToolbarStatusFilter] = useState<ProjectStatusFilterValue[]>([]);
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [filterNr, setFilterNr] = useState('');
  const [filterSap, setFilterSap] = useState('');
  const [filterTyp, setFilterTyp] = useState<string[]>([]);
  const [filterLine, setFilterLine] = useState('');
  const [filterStatusesCol, setFilterStatusesCol] = useState<ProjectStatusFilterValue[]>([]);
  const [addModal, setAddModal] = useState(false);
  const [groupsModal, setGroupsModal] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [importMode, setImportMode] = useState<'excel' | 'csv' | 'paste'>('excel');
  const [importPaste, setImportPaste] = useState('');
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);
  const [form, setForm] = useState(EMPTY_MACHINE);
  const [machineCatalog, setMachineCatalog] = useState<{ id: number; name: string; default_machine_usage: number }[]>([]);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingStatusId, setSavingStatusId] = useState<number | null>(null);
  const [savingLineId, setSavingLineId] = useState<number | null>(null);
  const [lineEdits, setLineEdits] = useState<Record<number, string>>({});
  const [statusGuard, setStatusGuard] = useState<{
    machineId: number;
    next: MachineFormStatus;
    projects: { id: number; client: string; name: string }[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  type MachineSortCol = 'sap' | 'internal' | 'line' | 'type' | 'status';
  const { sortCol, sortDir, toggle } = useTableSort<MachineSortCol>('internal');

  const displayList = useMemo(() => {
    const filtered = list.filter((m) => {
      if (filterNr.trim() && !String(m.internal_number ?? '').includes(filterNr.trim())) return false;
      if (filterSap.trim() && !(m.sap_number ?? '').toLowerCase().includes(filterSap.trim().toLowerCase())) return false;
      if (filterLine.trim() && !String(m.location ?? '').toLowerCase().includes(filterLine.trim().toLowerCase())) return false;
      if (filterTyp.length > 0 && (!m.type || !filterTyp.includes(m.type))) return false;
      if (filterStatusesCol.length > 0 && !filterStatusesCol.includes((m.status ?? 'active') as ProjectStatusFilterValue)) return false;
      return true;
    });
    return sortRows(filtered, sortCol, sortDir, (m, col) => {
      switch (col) {
        case 'sap':
          return String(m.sap_number ?? '');
        case 'internal':
          return String(m.internal_number ?? '');
        case 'line':
          return String(m.location ?? '');
        case 'type':
          return String(m.type ?? '');
        case 'status':
          return String(m.status ?? '');
        default:
          return '';
      }
    });
  }, [list, filterNr, filterSap, filterLine, filterTyp, filterStatusesCol, sortCol, sortDir]);

  const load = () => {
    setLoadError(null);
    setLoading(true);
    const params: Record<string, string | undefined> = {};
    const statuses = joinCsvFilter(toolbarStatusFilter);
    if (statuses) params.statuses = statuses;
    const types = joinCsvFilter(typeFilter);
    if (types) params.types = types;
    if (search.trim()) params.search = search.trim();
    api.machines
      .list(params)
      .then((data) => {
        setList(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        setLoadError(err.message || t('machines.loadListError'));
        setList([]);
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => { api.machines.types().then(setTypes).catch(() => {}); }, []);
  useEffect(() => {
    api.settings.machineTypes.list().then(setMachineCatalog).catch(() => setMachineCatalog([]));
  }, []);
  useEffect(load, [toolbarStatusFilter.join(','), typeFilter.join(','), search]);

  const openAdd = () => {
    api.settings.machineTypes.list().then(setMachineCatalog).catch(() => setMachineCatalog([]));
    setForm(EMPTY_MACHINE);
    setFormError('');
    setAddModal(true);
  };
  const openImport = () => { setImportResult(null); setImportPaste(''); setImportModal(true); setImportMode('excel'); if (fileInputRef.current) fileInputRef.current.value = ''; };
  const clearAllFilters = () => {
    setToolbarStatusFilter([]);
    setTypeFilter([]);
    setSearch('');
    setFilterNr('');
    setFilterSap('');
    setFilterTyp([]);
    setFilterLine('');
    setFilterStatusesCol([]);
  };

  const handleAddSubmit = () => {
    const sapNumber = form.sap_number.trim();
    if (!sapNumber) { setFormError('Podaj numer SAP'); return; }
    const internalParsed = parseOptionalInternalMachineNumber(form.internal_number);
    if (!internalParsed.ok) { setFormError(internalParsed.error); return; }
    if (machineCatalog.length > 0) {
      if (!form.type.trim() || !machineCatalog.some((t) => t.name === form.type)) {
        setFormError('Wybierz typ maszyny z listy.');
        return;
      }
    } else if (!form.type.trim()) {
      setFormError('Podaj typ maszyny lub zdefiniuj typy w Administracja → Ustawienia bazy → Typy maszyn.');
      return;
    }
    const lineStored = toStoredMachineLine(form.location);
    if (!lineStored) {
      setFormError('Podaj numer linii (tylko cyfry, liczba całkowita)');
      return;
    }
    const machineUsage = Number(form.machine_usage);
    if (!Number.isFinite(machineUsage) || machineUsage < 0 || machineUsage > 1) {
      setFormError('Machine usage musi być liczbą z zakresu 0..1');
      return;
    }
    setFormError('');
    setSaving(true);
    api.machines.create({
      internal_number: internalParsed.value ?? undefined,
      sap_number: sapNumber,
      type: form.type.trim(),
      status: form.status,
      location: lineStored,
      machine_usage: machineUsage,
      oee_override: form.oee_override !== '' ? Number(form.oee_override) : null,
      is_baseline: form.is_baseline ? 1 : 0,
    }).then(() => {
      setAddModal(false);
      load();
      api.machines.types().then(setTypes);
      api.settings.machineTypes.list().then(setMachineCatalog).catch(() => {});
    }).catch((e) => setFormError(e.message || 'Błąd zapisu')).finally(() => setSaving(false));
  };

  const handleFileImport = (file: File) => {
    if (importMode === 'csv') {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        const rows = parseCsvOrTsv(text);
        const machines = rowsToMachines(rows);
        if (!machines.length) { setImportResult({ created: 0, skipped: 0, errors: ['Brak wierszy do importu'] }); return; }
        api.machines.import(machines).then((r) => { setImportResult(r); load(); api.machines.types().then(setTypes); }).catch((e) => setImportResult({ created: 0, skipped: 0, errors: [e.message] }));
      };
      reader.readAsText(file, 'utf-8');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      const first = wb.SheetNames[0];
      const ws = wb.Sheets[first];
      const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const machines = rowsToMachines(rows);
      if (!machines.length) { setImportResult({ created: 0, skipped: 0, errors: ['Brak wierszy w arkuszu'] }); return; }
      api.machines.import(machines).then((r) => { setImportResult(r); load(); api.machines.types().then(setTypes); }).catch((err) => setImportResult({ created: 0, skipped: 0, errors: [err.message] }));
    };
    reader.readAsArrayBuffer(file);
  };

  const handlePasteImport = () => {
    const rows = parseCsvOrTsv(importPaste);
    const machines = rowsToMachines(rows);
    if (!machines.length) { setImportResult({ created: 0, skipped: 0, errors: ['Wklej dane w formacie CSV lub TSV (pierwszy wiersz = nagłówki)'] }); return; }
    api.machines.import(machines).then((r) => { setImportResult(r); load(); api.machines.types().then(setTypes); }).catch((e) => setImportResult({ created: 0, skipped: 0, errors: [e.message] }));
  };

  const lineDisplayValue = (m: { id: number; location?: string | null }) =>
    lineEdits[m.id] !== undefined ? lineEdits[m.id] : String(m.location ?? '');

  const saveRowLine = async (m: { id: number; location?: string | null }) => {
    const stored = parseMachineLineForSave(lineDisplayValue(m));
    if (stored === undefined) {
      alert('Podaj numer linii (tylko cyfry, liczba całkowita).');
      setLineEdits((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
      return;
    }
    const current = parseMachineLineForSave(String(m.location ?? ''));
    if (stored === current) {
      setLineEdits((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
      return;
    }
    setSavingLineId(m.id);
    try {
      await api.machines.update(m.id, { location: stored });
      setList((prev) => prev.map((x) => (x.id === m.id ? { ...x, location: stored } : x)));
      setLineEdits((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Nie udało się zapisać numeru linii.');
    } finally {
      setSavingLineId(null);
    }
  };

  const completeRowStatusChange = (machineId: number, next: MachineFormStatus) => {
    setSavingStatusId(machineId);
    api.machines
      .update(machineId, { status: next })
      .then(() => load())
      .catch((err: Error) => alert(err?.message || 'Błąd zapisu statusu'))
      .finally(() => setSavingStatusId(null));
  };

  const handleRowStatusChange = async (machineId: number, current: string | undefined, next: MachineFormStatus) => {
    if (current === next) return;
    if (next === 'inactive' || next === 'RFQ') {
      try {
        const data = await api.machines.activeProjectOperationCount(machineId);
        if (data.count > 0) {
          setStatusGuard({
            machineId,
            next,
            projects: data.projects ?? [],
          });
          return;
        }
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : 'Nie udało się zweryfikować operacji.');
        return;
      }
    }
    completeRowStatusChange(machineId, next);
  };

  if (loading && list.length === 0 && !loadError) return <p>{t('common.loading')}</p>;
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>{t('machines.title')}</h1>
      {loadError && (
        <p style={{ padding: '0.75rem', background: '#ffebee', color: '#c62828', borderRadius: 8, marginBottom: '1rem' }}>
          {loadError} {t('common.serverHint')}
        </p>
      )}
      <div className="filters-toolbar">
        <button onClick={openAdd} style={{ padding: '0.5rem 1rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{t('machines.add')}</button>
        <div style={{ position: 'relative' }}>
          <button onClick={openImport} style={{ padding: '0.5rem 1rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.import')}</button>
        </div>
        <span className="filters-label">{t('machines.machineStatus')}</span>
        <div style={{ minWidth: 200, maxWidth: 280, alignSelf: 'center' }}>
          <StatusMultiFilter selected={toolbarStatusFilter} onChange={setToolbarStatusFilter} />
        </div>
        <span>{t('machines.machineType')}</span>
        <div style={{ minWidth: 180, maxWidth: 260 }}>
          <MachineTypesMultiFilter types={types} selected={typeFilter} onChange={setTypeFilter} />
        </div>
        <input type="text" placeholder={t('machines.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 200 }} />
        <button type="button" className="filter-clear-btn" onClick={clearAllFilters}>{t('common.clearFilters')}</button>
        <button
          type="button"
          onClick={() => setGroupsModal(true)}
          style={{ marginLeft: 'auto', padding: '0.5rem 1rem', background: '#5c6bc0', color: 'white', border: 'none', borderRadius: 4, flexShrink: 0 }}
        >
          {t('machines.groupsBtn')}
        </button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <SortableTh label={t('machines.sapNumber')} active={sortCol === 'sap'} direction={sortDir} onClick={() => toggle('sap')} />
            <SortableTh label={t('machines.internalNumber')} active={sortCol === 'internal'} direction={sortDir} onClick={() => toggle('internal')} />
            <SortableTh label={t('machines.lineNumber')} active={sortCol === 'line'} direction={sortDir} onClick={() => toggle('line')} />
            <SortableTh label={t('machines.type')} active={sortCol === 'type'} direction={sortDir} onClick={() => toggle('type')} />
            <SortableTh label={t('machines.status')} active={sortCol === 'status'} direction={sortDir} onClick={() => toggle('status')} />
            <th style={{ padding: '0.75rem', textAlign: 'left' }}></th>
          </tr>
          <tr style={{ background: '#fafafa' }}>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('machines.sapNumber') })} value={filterSap} onChange={(e) => setFilterSap(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('machines.internalNumber') })} value={filterNr} onChange={(e) => setFilterNr(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <input type="text" placeholder={t('common.filterColumn', { column: t('machines.lineNumber') })} value={filterLine} onChange={(e) => setFilterLine(e.target.value)} style={{ width: '100%', padding: 4, fontSize: 12 }} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <MachineTypesMultiFilter types={types} selected={filterTyp} onChange={setFilterTyp} />
            </th>
            <th style={{ padding: '4px 6px', verticalAlign: 'top' }}>
              <StatusMultiFilter selected={filterStatusesCol} onChange={setFilterStatusesCol} />
            </th>
            <th style={{ padding: '4px 6px' }}></th>
          </tr>
        </thead>
        <tbody>
          {displayList.map((m) => (
            <tr key={m.id}>
              <td style={{ padding: '0.75rem' }}>{m.sap_number || '-'}</td>
              <td style={{ padding: '0.75rem' }}>{m.internal_number ?? '-'}</td>
              <td style={{ padding: '0.75rem', minWidth: 88 }}>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={lineDisplayValue(m)}
                  onChange={(e) =>
                    setLineEdits((prev) => ({ ...prev, [m.id]: digitsOnlyMachineLine(e.target.value) }))
                  }
                  onBlur={() => void saveRowLine(m)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') {
                      setLineEdits((prev) => {
                        const next = { ...prev };
                        delete next[m.id];
                        return next;
                      });
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  disabled={savingLineId === m.id}
                  title={t('machines.lineSaveTitle')}
                  style={{
                    width: 72,
                    padding: '4px 6px',
                    fontSize: 14,
                    border: '1px solid #bdbdbd',
                    borderRadius: 4,
                    opacity: savingLineId === m.id ? 0.6 : 1,
                  }}
                />
              </td>
              <td style={{ padding: '0.75rem' }}>{m.type}</td>
              <td style={{ padding: '0.75rem', minWidth: 140 }}>
                {canChangeStatus ? (
                <select
                  value={machineStatusFromDb(m.status)}
                  onChange={(e) => void handleRowStatusChange(m.id, m.status, e.target.value as MachineFormStatus)}
                  disabled={savingStatusId === m.id}
                  title={t('machines.changeStatusTitle')}
                  style={machineStatusSelectStyle(m.status, { saving: savingStatusId === m.id })}
                >
                  <option value="active">{t('common.active')}</option>
                  <option value="inactive">{t('common.inactive')}</option>
                  <option value="RFQ">{t('common.rfq')}</option>
                </select>
                ) : (
                  <span style={machineStatusReadonlyStyle(m.status)}>
                    {machineStatusFromDb(m.status) === 'active'
                      ? t('common.active')
                      : machineStatusFromDb(m.status) === 'RFQ'
                        ? t('common.rfq')
                        : t('common.inactive')}
                  </span>
                )}
              </td>
              <td style={{ padding: '0.75rem' }}>
                {canViewDetails ? (
                <Link to={`/maszyny/${m.id}${scenarioQs}`} style={{ padding: '0.25rem 0.5rem', background: '#2196f3', color: 'white', textDecoration: 'none', borderRadius: 4 }}>{t('common.details')}</Link>
                ) : (
                  <span style={{ color: '#999', fontSize: 13 }}>{t('common.dash')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {addModal && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setAddModal(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div onMouseDown={(e) => e.stopPropagation()} style={{ background: 'white', padding: '1.5rem', borderRadius: 8, minWidth: 360 }}>
            <h2 style={{ marginTop: 0 }}>{t('machines.addTitle')}</h2>
            <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1rem' }}>
              <label>{t('machines.sapRequired')} <input type="text" value={form.sap_number} onChange={(e) => setForm((f) => ({ ...f, sap_number: e.target.value }))} style={{ width: '100%', padding: 6 }} /></label>
              <label>
                {t('machines.internalNumber')}{' '}
                <input
                  type="text"
                  value={form.internal_number}
                  onChange={(e) => setForm((f) => ({ ...f, internal_number: e.target.value }))}
                  placeholder={t('machines.internalPlaceholder')}
                  style={{ width: '100%', padding: 6 }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.is_baseline}
                  onChange={(e) => setForm((f) => ({ ...f, is_baseline: e.target.checked }))}
                />
                <span>{t('machines.baselineMachine')}</span>
              </label>
              <label style={{ display: 'block' }}>
                {t('machines.typeRequired')}{' '}
                {machineCatalog.length > 0 ? (
                  <SearchableSelect
                    value={form.type}
                    onChange={(e) => {
                      const typeName = e.target.value;
                      const entry = machineCatalog.find((t) => t.name === typeName);
                      const usageStr =
                        entry != null && entry.default_machine_usage != null && Number.isFinite(Number(entry.default_machine_usage))
                          ? String(Math.round(Math.max(0.1, Math.min(1, Number(entry.default_machine_usage))) * 10) / 10)
                          : form.machine_usage;
                      setForm((f) => ({ ...f, type: typeName, machine_usage: typeName ? usageStr : f.machine_usage }));
                    }}
                    style={{ width: '100%', padding: 6 }}
                  >
                    <option value="">{t('machineDetail.chooseType')}</option>
                    {machineCatalog.map((t) => (
                      <option key={t.id} value={t.name}>{t.name}</option>
                    ))}
                  </SearchableSelect>
                ) : (
                  <input type="text" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} placeholder="np. MC, WJ" style={{ width: '100%', padding: 6, marginTop: 4 }} />
                )}
              </label>
              {machineCatalog.length === 0 && (
                <p style={{ fontSize: 12, color: '#666', margin: '0 0 4px' }}>
                  {t('machineDetail.typesHintPrefix')}{' '}
                  <Link to="/administracja/ustawienia-bazy/typy-maszyn" style={{ color: 'var(--cap-green)' }}>{t('settings.machineTypes')}</Link>.
                </p>
              )}
              <label>
                {t('machines.status')}{' '}
                <select
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as MachineFormStatus }))}
                  style={{ ...machineStatusSelectStyle(form.status), width: '100%', maxWidth: 280 }}
                >
                  <option value="active">{t('common.active')}</option>
                  <option value="inactive">{t('common.inactive')}</option>
                  <option value="RFQ">{t('common.rfq')}</option>
                </select>
              </label>
              <label>
                {t('machines.lineRequired')}{' '}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={t('machines.digitsOnly')}
                  value={form.location}
                  onChange={(e) => setForm((f) => ({ ...f, location: digitsOnlyMachineLine(e.target.value) }))}
                  required
                  style={{ width: '100%', padding: 6 }}
                />
              </label>
              <label>{t('machines.machineUsage')}
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={form.machine_usage}
                  onChange={(e) => setForm((f) => ({ ...f, machine_usage: e.target.value }))}
                  placeholder={t('machines.usagePlaceholder')}
                  style={{ width: '100%', padding: 6 }}
                />
              </label>
              <label>{t('machines.oeeOverride')} <input type="number" step="0.01" placeholder={t('machines.oeeEmpty')} value={form.oee_override} onChange={(e) => setForm((f) => ({ ...f, oee_override: e.target.value }))} style={{ width: '100%', padding: 6 }} /></label>
            </div>
            {formError && <p style={{ color: 'var(--cap-red)', marginBottom: 8 }}>{formError}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleAddSubmit} disabled={saving} style={{ padding: '0.5rem 1rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.save')}</button>
              <button onClick={() => setAddModal(false)} style={{ padding: '0.5rem 1rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {importModal && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setImportModal(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div onMouseDown={(e) => e.stopPropagation()} style={{ background: 'white', padding: '1.5rem', borderRadius: 8, minWidth: 440, maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto' }}>
            <h2 style={{ marginTop: 0 }}>{t('machines.import')}</h2>
            <p style={{ color: '#666', fontSize: 14 }}>{t('machines.importColumnsHelp')}</p>
            <div style={{ marginBottom: '1rem' }}>
              <label><input type="radio" name="importMode" checked={importMode === 'excel'} onChange={() => setImportMode('excel')} /> {t('machines.importFromExcel')}</label>
              <label style={{ marginLeft: 16 }}><input type="radio" name="importMode" checked={importMode === 'csv'} onChange={() => setImportMode('csv')} /> {t('machines.importFromCsv')}</label>
              <label style={{ marginLeft: 16 }}><input type="radio" name="importMode" checked={importMode === 'paste'} onChange={() => setImportMode('paste')} /> {t('machines.importPasteMode')}</label>
            </div>
            {(importMode === 'excel' || importMode === 'csv') && (
              <div style={{ marginBottom: '1rem' }}>
                <input ref={fileInputRef} type="file" accept={importMode === 'excel' ? '.xlsx,.xls' : '.csv,.txt'} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileImport(f); }} style={{ width: '100%' }} />
              </div>
            )}
            {importMode === 'paste' && (
              <div style={{ marginBottom: '1rem' }}>
                <textarea value={importPaste} onChange={(e) => setImportPaste(e.target.value)} placeholder={t('machines.importPastePlaceholder')} rows={6} style={{ width: '100%', padding: 8, fontFamily: 'monospace' }} />
                <button onClick={handlePasteImport} style={{ marginTop: 4, padding: '0.5rem 1rem', background: '#1976d2', color: 'white', border: 'none', borderRadius: 4 }}>{t('machines.importPasteBtn')}</button>
              </div>
            )}
            {importResult && (
              <div style={{ marginTop: '1rem', padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                <p><strong>{t('machines.importResult', { created: importResult.created, skipped: importResult.skipped })}</strong></p>
                {importResult.errors.length > 0 && <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--cap-red)' }}>{importResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
              </div>
            )}
            <button onClick={() => setImportModal(false)} style={{ marginTop: 12, padding: '0.5rem 1rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4 }}>{t('common.close')}</button>
          </div>
        </div>
      )}

      {groupsModal && <MachineGroupsModal onClose={() => setGroupsModal(false)} />}

      {statusGuard && (
        <MachineStatusActiveProjectsModal
          open
          machineId={statusGuard.machineId}
          navigationSearch={scenarioQs}
          projects={statusGuard.projects}
          targetStatus={statusGuard.next === 'RFQ' ? 'RFQ' : 'inactive'}
          onCancel={() => setStatusGuard(null)}
          onConfirm={() => {
            const g = statusGuard;
            setStatusGuard(null);
            completeRowStatusChange(g.machineId, g.next);
          }}
        />
      )}
    </div>
  );
}
