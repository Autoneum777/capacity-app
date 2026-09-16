import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED, MACHINES_IMPORT_CONFIRM } from '../api/client';
import { useI18n } from '../context/I18nContext';
import { useOcuMode } from '../context/OcuModeContext';
import ServerStorageBrowser from '../components/admin/ServerStorageBrowser';

export default function AdminSettings() {
  const { t, te } = useI18n();
  const { refreshOcuFeature } = useOcuMode();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({
    backup_enabled: false,
    backup_frequency_days: 1,
    backup_output_dir: 'backups',
    project_attachments_output_dir: 'attachments',
    volumes_autosave_enabled: true,
    ocu_enabled: false,
  });
  const [savingOcu, setSavingOcu] = useState(false);
  const [savingBehavior, setSavingBehavior] = useState(false);
  const [absoluteDir, setAbsoluteDir] = useState('');
  const [backupPathWritable, setBackupPathWritable] = useState<boolean | null>(null);
  const [attachmentsPathWritable, setAttachmentsPathWritable] = useState<boolean | null>(null);
  const [pickLocationAvailable, setPickLocationAvailable] = useState(true);
  const [storageBaseDir, setStorageBaseDir] = useState('');
  const [storageBrowse, setStorageBrowse] = useState<{ kind: 'backup' | 'attachments'; initialPath?: string } | null>(
    null
  );
  const [absoluteAttachmentsDir, setAbsoluteAttachmentsDir] = useState('');
  const [pickingAttachmentsDir, setPickingAttachmentsDir] = useState(false);
  const [pickingBackupDir, setPickingBackupDir] = useState(false);
  const [pickingBackupFile, setPickingBackupFile] = useState(false);
  const [savingAttachments, setSavingAttachments] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState('');
  const [lastBackupFile, setLastBackupFile] = useState('');
  const [backupFiles, setBackupFiles] = useState<{ name: string; path: string; modified_at: string; size_bytes: number }[]>([]);
  const [restorePath, setRestorePath] = useState('');
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const [bundleConfirm, setBundleConfirm] = useState('');
  const [bundleDownloading, setBundleDownloading] = useState(false);
  const [bundleImporting, setBundleImporting] = useState(false);
  const [bundleImportMode, setBundleImportMode] = useState<'full' | 'partial'>('full');
  type BundlePartialKey =
    | 'machines'
    | 'projects'
    | 'part_designations'
    | 'parts'
    | 'operations'
    | 'scenarios'
    | 'call_off_comparisons'
    | 'call_off_volumes';
  const [bundlePartial, setBundlePartial] = useState<Record<BundlePartialKey, boolean>>({
    machines: true,
    projects: true,
    part_designations: true,
    parts: true,
    operations: false,
    scenarios: false,
    call_off_comparisons: false,
    call_off_volumes: false,
  });
  const BUNDLE_PARTIAL_KEYS: BundlePartialKey[] = [
    'machines',
    'projects',
    'part_designations',
    'parts',
    'operations',
    'scenarios',
    'call_off_comparisons',
    'call_off_volumes',
  ];
  const [dataFile, setDataFile] = useState<File | null>(null);
  const [dataConfirm, setDataConfirm] = useState('');
  const [dataDownloading, setDataDownloading] = useState(false);
  const [dataImporting, setDataImporting] = useState(false);
  /** false = dopisz/aktualizuj (domyślnie); true = usuń rekordy spoza pliku */
  const [dataImportReplaceAll, setDataImportReplaceAll] = useState(false);
  const [machinesFile, setMachinesFile] = useState<File | null>(null);
  const [machinesConfirm, setMachinesConfirm] = useState('');
  const [machinesDownloading, setMachinesDownloading] = useState(false);
  const [machinesImporting, setMachinesImporting] = useState(false);
  const [dataSchemaDiag, setDataSchemaDiag] = useState<
    | null
    | { ok: true; schemaTag: string; templateFilename: string }
    | { ok: false; detail: string }
  >(null);
  const [templateInfo, setTemplateInfo] = useState<{
    schemaTag: string;
    downloadFilename: string;
    sheets: string[];
    machinesSheetHeaders: string[];
    instructionRow1MustInclude: string;
  } | null>(null);
  const [templateInfoError, setTemplateInfoError] = useState('');
  const [clearConfirm, setClearConfirm] = useState('');
  const [clearCreateBackup, setClearCreateBackup] = useState(true);
  const [clearBackupAck, setClearBackupAck] = useState(false);
  const [clearing, setClearing] = useState(false);

  const loadBackupFiles = () => {
    api.admin
      .listBackupFiles()
      .then((list) => setBackupFiles(list))
      .catch(() => setBackupFiles([]));
  };

  const load = () => {
    setLoading(true);
    setError('');
    api.admin
      .getBackupSettings()
      .then((cfg) => {
        setForm({
          backup_enabled: !!cfg.backup_enabled,
          backup_frequency_days: Number(cfg.backup_frequency_days || 0),
          backup_output_dir: cfg.backup_output_dir || 'backups',
          project_attachments_output_dir: cfg.project_attachments_output_dir || 'attachments',
          volumes_autosave_enabled: cfg.volumes_autosave_enabled !== false,
          ocu_enabled: cfg.ocu_enabled === true,
        });
        setAbsoluteDir(cfg.absolute_output_dir || '');
        setAbsoluteAttachmentsDir(cfg.absolute_attachments_output_dir || '');
        setPickLocationAvailable(cfg.pick_location_available !== false);
        setStorageBaseDir(cfg.storage_base_dir || '');
        setLastBackupAt(cfg.last_backup_at || '');
        setLastBackupFile(cfg.last_backup_file || '');
        loadBackupFiles();
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.loadFailed')))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  useEffect(() => {
    const raw = form.project_attachments_output_dir.trim();
    if (!raw) {
      setAbsoluteAttachmentsDir('');
      setAttachmentsPathWritable(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api.admin
        .previewStoragePath(raw, 'attachments')
        .then((result) => {
          setAbsoluteAttachmentsDir(result.absolute_path || '');
          setAttachmentsPathWritable(result.writable ?? null);
        })
        .catch(() => {
          setAbsoluteAttachmentsDir('');
          setAttachmentsPathWritable(null);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [form.project_attachments_output_dir]);

  useEffect(() => {
    const raw = form.backup_output_dir.trim();
    if (!raw) {
      setAbsoluteDir('');
      setBackupPathWritable(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api.admin
        .previewStoragePath(raw, 'backup')
        .then((result) => {
          setAbsoluteDir(result.absolute_path || '');
          setBackupPathWritable(result.writable ?? null);
        })
        .catch(() => {
          setAbsoluteDir('');
          setBackupPathWritable(null);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [form.backup_output_dir]);

  useEffect(() => {
    api.admin.fetchCapacityDataImportSchemaDiagnostics().then(setDataSchemaDiag);
    api.admin
      .fetchCapacityDataImportTemplateInfo()
      .then((d) => {
        setTemplateInfo(d);
        setTemplateInfoError('');
      })
      .catch((e: any) => {
        setTemplateInfo(null);
        setTemplateInfoError(te(e?.message) || t('adminSettingsExtra.templateManifestFailed'));
      });
  }, []);

  const saveBehavior = () => {
    setSavingBehavior(true);
    setError('');
    setMessage('');
    api.admin
      .setBackupSettings({
        backup_enabled: form.backup_enabled,
        backup_frequency_days: Math.max(0, Number(form.backup_frequency_days) || 0),
        backup_output_dir: form.backup_output_dir.trim() || 'backups',
        volumes_autosave_enabled: form.volumes_autosave_enabled,
      })
      .then((cfg) => {
        setForm((prev) => ({
          ...prev,
          volumes_autosave_enabled: cfg.volumes_autosave_enabled !== false,
        }));
        setMessage(t('settings.behaviorSaved'));
      })
      .catch((e: any) => setError(te(e?.message) || t('settings.behaviorSaveFailed')))
      .finally(() => setSavingBehavior(false));
  };

  const saveOcuFeature = () => {
    setSavingOcu(true);
    setError('');
    setMessage('');
    api.admin
      .setBackupSettings({ ocu_enabled: form.ocu_enabled })
      .then((cfg) => {
        setForm((prev) => ({ ...prev, ocu_enabled: cfg.ocu_enabled === true }));
        refreshOcuFeature();
        setMessage(t('adminSettingsExtra.ocuSaved'));
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.saveFailed')))
      .finally(() => setSavingOcu(false));
  };

  const save = () => {
    setSaving(true);
    setError('');
    setMessage('');
    api.admin
      .setBackupSettings({
        backup_enabled: form.backup_enabled,
        backup_frequency_days: Math.max(0, Number(form.backup_frequency_days) || 0),
        backup_output_dir: form.backup_output_dir.trim() || 'backups',
        project_attachments_output_dir: form.project_attachments_output_dir.trim(),
        volumes_autosave_enabled: form.volumes_autosave_enabled,
      })
      .then((cfg) => {
        setAbsoluteDir(cfg.absolute_output_dir || '');
        setAbsoluteAttachmentsDir(cfg.absolute_attachments_output_dir || '');
        setLastBackupAt(cfg.last_backup_at || '');
        setLastBackupFile(cfg.last_backup_file || '');
        setMessage('Ustawienia backupu zapisane.');
        loadBackupFiles();
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.saveFailed')))
      .finally(() => setSaving(false));
  };

  const createBackupNow = () => {
    setCreatingBackup(true);
    setError('');
    setMessage('');
    api.admin
      .backupNow()
      .then((result) => {
        const inc = result.included;
        const extras = inc
          ? ` (baza + call-offs: ${inc.call_offs ? 'tak' : 'brak'}, załączniki: ${inc.attachments ? 'tak' : 'brak'}, scenariusze JSON: ${inc.scenarios_count ?? 0})`
          : '';
        setMessage(`Pełny backup ZIP utworzony: ${result.file_path}${extras}`);
        setLastBackupAt(result.created_at);
        setLastBackupFile(result.file_path);
        loadBackupFiles();
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.backupFailed')))
      .finally(() => setCreatingBackup(false));
  };

  const pickAttachmentsLocation = () => {
    setError('');
    setMessage(t('adminSettingsExtra.pickLocationHint'));
    setPickingAttachmentsDir(true);
    api.admin
      .waitForPickLocation('attachments')
      .then((result) => {
        if (!result.chosen || !result.path) {
          setMessage(t('adminSettingsExtra.pickCancelled'));
          return;
        }
        setForm((prev) => ({ ...prev, project_attachments_output_dir: result.path }));
        setAbsoluteAttachmentsDir(result.path);
        setMessage(t('adminSettingsExtra.pickLocationChosen'));
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.pickLocationFailed')))
      .finally(() => setPickingAttachmentsDir(false));
  };

  const saveAttachmentsSettings = () => {
    setSavingAttachments(true);
    setError('');
    setMessage('');
    api.admin
      .setBackupSettings({
        project_attachments_output_dir: form.project_attachments_output_dir.trim(),
      })
      .then((cfg) => {
        setForm((prev) => ({ ...prev, project_attachments_output_dir: cfg.project_attachments_output_dir || '' }));
        setAbsoluteAttachmentsDir(cfg.absolute_attachments_output_dir || '');
        setMessage(t('adminSettingsExtra.attachmentsSaved'));
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.saveFailed')))
      .finally(() => setSavingAttachments(false));
  };

  const pickLocation = () => {
    setError('');
    setMessage(t('adminSettingsExtra.pickLocationHint'));
    setPickingBackupDir(true);
    api.admin
      .waitForPickLocation('backup')
      .then((result) => {
        if (!result.chosen || !result.path) {
          setMessage(t('adminSettingsExtra.pickCancelled'));
          return;
        }
        setForm((prev) => ({ ...prev, backup_output_dir: result.path }));
        setAbsoluteDir(result.path);
        setMessage(t('adminSettingsExtra.pickLocationChosen'));
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.pickLocationFailed')))
      .finally(() => setPickingBackupDir(false));
  };

  const pickBackupFile = () => {
    setError('');
    setMessage(t('adminSettingsExtra.pickLocationHint'));
    setPickingBackupFile(true);
    api.admin
      .waitForPickLocation('backup-file', form.backup_output_dir.trim() || absoluteDir)
      .then((result) => {
        if (!result.chosen || !result.path) {
          setMessage(t('adminSettingsExtra.pickCancelled'));
          return;
        }
        setRestorePath(result.path);
        setMessage(t('adminSettingsExtra.pickLocationChosen'));
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.pickBackupFailed')))
      .finally(() => setPickingBackupFile(false));
  };

  const restoreFromBackup = () => {
    const pathToRestore = restorePath.trim();
    if (!pathToRestore) {
      setError(t('adminSettingsExtra.restorePathRequired'));
      return;
    }
    if (!window.confirm(t('adminSettingsExtra.restoreConfirm'))) {
      return;
    }
    setRestoring(true);
    setError('');
    setMessage('');
    api.admin
      .restoreFromBackup({ backup_file_path: pathToRestore })
      .then((result) => {
        setMessage(`Przywrócono bazę z: ${result.restored_from}. Kopia bezpieczeństwa: ${result.safety_backup_file}`);
        load();
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.restoreFailed')))
      .finally(() => setRestoring(false));
  };

  const downloadBundleTemplate = () => {
    const onlyTables: BundlePartialKey[] | undefined =
      bundleImportMode === 'partial'
        ? BUNDLE_PARTIAL_KEYS.filter((k) => bundlePartial[k])
        : undefined;
    if (bundleImportMode === 'partial' && (onlyTables?.length ?? 0) === 0) {
      setError('Zaznacz co najmniej jedną tabelę, aby pobrać częściowy szablon.');
      return;
    }
    setBundleDownloading(true);
    setError('');
    setMessage('');
    api.admin
      .downloadCapacityBundleTemplate(onlyTables)
      .then(() =>
        setMessage(
          bundleImportMode === 'partial'
            ? `Pobrano częściowy szablon (${onlyTables!.join(', ')}) — plik capacity_baza_szablon_wybrane.zip.`
            : 'Pobrano pełną paczkę capacity_baza_szablon.zip (Excel + scenarios + call-offs).'
        )
      )
      .catch((e: any) => setError(e?.message || 'Nie udało się pobrać szablonu.'))
      .finally(() => setBundleDownloading(false));
  };

  const downloadDataTemplate = () => {
    setDataDownloading(true);
    setError('');
    setMessage('');
    api.admin
      .downloadCapacityDataTemplate()
      .then(async ({ backendSchemaHeader }) => {
        const diag = await api.admin.fetchCapacityDataImportSchemaDiagnostics();
        setDataSchemaDiag(diag);
        try {
          const info = await api.admin.fetchCapacityDataImportTemplateInfo();
          setTemplateInfo(info);
          setTemplateInfoError('');
        } catch (e: any) {
          setTemplateInfo(null);
          setTemplateInfoError(e?.message || 'Manifest szablonu niedostępny.');
        }
        const schemaOk = diag.ok && diag.schemaTag === CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED;
        const headerOk = backendSchemaHeader === CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED;
        const base =
          'Pobrano szablon importu danych — oczekiwana nazwa pliku: capacity_szablon_import_danych_v2.xlsx (arkusz „Operacje”: tryb, wybor_po, identyfikator_detalu itd.). ';
        if (schemaOk && headerOk) {
          setMessage(base + 'Schemat operacje-v2 potwierdzony (nagłówek odpowiedzi i endpoint diagnostyczny).');
        } else if (schemaOk && !headerOk) {
          setMessage(
            base +
              'Schemat operacje-v2 potwierdzony przez endpoint diagnostyczny. Nagłówka X-Capacity-Data-Import-Schema często nie widać przy starszej konfiguracji CORS — zaktualizuj backend i odśwież; sam plik powinien być już w układzie v2.',
          );
        } else if (!schemaOk && headerOk) {
          setMessage(base + 'Nagłówek wskazuje operacje-v2; sprawdź endpoint diagnostyczny (możliwy problem sieci).');
        } else {
          setMessage(
            base +
              'Uwaga: backend nie potwierdza operacje-v2 (404 lub stary kod). W katalogu server uruchom `npm run build`, potem `npm start`, albo `npm run dev`. Upewnij się, że frontend trafia na ten sam API co przeglądasz (proxy /api lub poprawne VITE_API_BASE).',
          );
        }
      })
      .catch((e: any) => setError(e?.message || 'Nie udało się pobrać szablonu danych.'))
      .finally(() => setDataDownloading(false));
  };

  const importData = () => {
    if (!dataFile) {
      setError('Wybierz plik .xlsx do wgrania.');
      return;
    }
    const phrase = dataConfirm.trim();
    if (phrase !== 'IMPORTUJ_DANE') {
      setError('Aby zaimportować dane, wpisz dokładnie: IMPORTUJ_DANE (wielkość liter ma znaczenie).');
      return;
    }
    const replaceAll = dataImportReplaceAll;
    if (
      !window.confirm(
        replaceAll
          ? 'Tryb ZASTĄP: dane wejściowe w bazie zostaną dopasowane do pliku Excel — rekordy spoza pliku (maszyny, projekty, operacje itd.) zostaną usunięte. Przed importem system utworzy kopię zapasową. Kontynuować?'
          : 'Tryb DODAJ: dane z pliku zostaną dopisane lub zaktualizowane; istniejące rekordy, których nie ma w Excelu, pozostaną. Brakujące operacje z arkusza „Operacje” zostaną utworzone. Przed importem system utworzy kopię zapasową. Kontynuować?',
      )
    ) {
      return;
    }
    setDataImporting(true);
    setError('');
    setMessage('');
    api.admin
      .importCapacityData(dataFile, phrase, { mode: replaceAll ? 'replace' : 'merge' })
      .then((r) => {
        const c = r.counts;
        const parts = [
          `maszyny: +${c.machines_created} / ~${c.machines_updated}${c.machines_deleted ? ` / −${c.machines_deleted}` : ''}`,
          `projekty: +${c.projects_created} / ~${c.projects_updated}${c.projects_deleted ? ` / −${c.projects_deleted}` : ''}`,
          `detale: +${c.designations_created} / ~${c.designations_updated}${c.designations_deleted ? ` / −${c.designations_deleted}` : ''}`,
          `powiązania: +${c.parts_created}${c.parts_deleted ? ` / −${c.parts_deleted}` : ''} (pominięte wiersze: ${c.parts_skipped})`,
          `wolumeny: ${c.volumes_upserted}${c.volumes_deleted ? ` / usunięte lata: ${c.volumes_deleted}` : ''}`,
          `operacje: +${c.operations_created} / ~${c.operations_updated}${c.operations_deleted ? ` / −${c.operations_deleted}` : ''}`,
          `fazy procesu: +${c.phases_created ?? 0}`,
        ];
        let msg =
          r.mode === 'replace'
            ? 'Import danych zakończony (zastąpienie stanu z pliku).'
            : 'Import danych zakończony (dopisanie i aktualizacja z pliku).';
        if (r.backup_file) msg += ` Kopia zapasowa: ${r.backup_file}.`;
        msg += ` ${parts.join(' · ')}`;
        if (r.warnings?.length) {
          msg += ` Uwagi (${r.warnings.length}): ${r.warnings.slice(0, 3).join(' ')}${r.warnings.length > 3 ? '…' : ''}`;
        }
        setMessage(msg);
        setDataFile(null);
        setDataConfirm('');
      })
      .catch((e: any) => setError(e?.message || 'Import danych nie powiódł się.'))
      .finally(() => setDataImporting(false));
  };

  const downloadMachinesTemplate = () => {
    setMachinesDownloading(true);
    setError('');
    setMessage('');
    api.admin
      .downloadMachinesImportTemplate()
      .then(() => setMessage(t('adminSettingsExtra.machinesTemplateDownloaded')))
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.machinesTemplateFailed')))
      .finally(() => setMachinesDownloading(false));
  };

  const importMachines = () => {
    if (!machinesFile) {
      setError(t('adminSettingsExtra.machinesFileRequired'));
      return;
    }
    const phrase = machinesConfirm.trim();
    if (phrase !== MACHINES_IMPORT_CONFIRM) {
      setError(t('adminSettingsExtra.machinesImportConfirmRequired'));
      return;
    }
    if (!window.confirm(t('adminSettingsExtra.machinesImportConfirm'))) return;
    setMachinesImporting(true);
    setError('');
    setMessage('');
    api.admin
      .importMachines(machinesFile, phrase)
      .then((r) => {
        const parts = [
          t('adminSettingsExtra.machinesImportDone'),
          `${t('adminSettingsExtra.machinesCreated')}: ${r.created}`,
          `${t('adminSettingsExtra.machinesUpdated')}: ${r.updated}`,
        ];
        if (r.skipped > 0) parts.push(`${t('adminSettingsExtra.machinesSkipped')}: ${r.skipped}`);
        if (r.types_added?.length) parts.push(`${t('adminSettingsExtra.machinesTypesAdded')}: ${r.types_added.join(', ')}`);
        if (r.errors?.length) parts.push(`${t('adminSettingsExtra.machinesImportErrors')}: ${r.errors.slice(0, 5).join('; ')}${r.errors.length > 5 ? '…' : ''}`);
        if (r.backup_file) parts.push(`Kopia zapasowa: ${r.backup_file}`);
        setMessage(parts.join(' '));
        setMachinesFile(null);
        setMachinesConfirm('');
      })
      .catch((e: any) => setError(te(e?.message) || t('adminSettingsExtra.machinesImportFailed')))
      .finally(() => setMachinesImporting(false));
  };

  const clearDatabase = () => {
    const phrase = clearConfirm.trim();
    if (phrase !== 'WYCZYSC_BAZE') {
      setError('Aby wyczyścić bazę, wpisz dokładnie: WYCZYSC_BAZE (wielkość liter ma znaczenie).');
      return;
    }
    if (!clearCreateBackup && !clearBackupAck) {
      setError('Zaznacz potwierdzenie posiadania kopii zapasowej albo włącz automatyczne utworzenie backupu przed wyczyszczeniem.');
      return;
    }
    const backupNote = clearCreateBackup
      ? 'Przed wyczyszczeniem system utworzy automatyczną kopię zapasową bazy.'
      : 'Nie tworzysz kopii automatycznej — upewnij się, że masz własny backup.';
    if (
      !window.confirm(
        `Operacja jest nieodwracalna: wszystkie dane aplikacji (maszyny, projekty, operacje, scenariusze itd.) zostaną trwale usunięte. Ustawienia backupu w administracji pozostaną. ${backupNote} Kontynuować?`,
      )
    ) {
      return;
    }
    setClearing(true);
    setError('');
    setMessage('');
    api.admin
      .clearDatabase({ confirm: phrase, create_backup: clearCreateBackup })
      .then((r) => {
        const total = Object.values(r.rows_deleted).reduce((a, n) => a + n, 0);
        let msg = `Baza wyczyszczona (${r.tables_cleared.length} tabel, usunięto ${total} wierszy).`;
        if (r.backup_file) msg += ` Kopia zapasowa: ${r.backup_file}.`;
        setMessage(msg);
        setClearConfirm('');
        setClearBackupAck(false);
        load();
      })
      .catch((e: any) => setError(e?.message || 'Nie udało się wyczyścić bazy.'))
      .finally(() => setClearing(false));
  };

  const importBundle = () => {
    if (!bundleFile) {
      setError('Wybierz plik .xlsx lub .zip (pełna paczka) do wgrania.');
      return;
    }
    const isZip =
      bundleFile.name.toLowerCase().endsWith('.zip') ||
      bundleFile.type === 'application/zip' ||
      bundleFile.type === 'application/x-zip-compressed';
    const phrase = bundleConfirm.trim();
    if (phrase !== 'IMPORTUJ_BAZE') {
      setError('Aby zaimportować, wpisz dokładnie: IMPORTUJ_BAZE (wielkość liter ma znaczenie).');
      return;
    }
    const onlyTables: BundlePartialKey[] =
      bundleImportMode === 'partial' ? BUNDLE_PARTIAL_KEYS.filter((k) => bundlePartial[k]) : [];
    if (bundleImportMode === 'partial' && onlyTables.length === 0) {
      setError('Zaznacz co najmniej jedną tabelę do importu częściowego.');
      return;
    }
    const zipNote = isZip
      ? ' Z paczki .zip zostaną też odtworzone duże snapshoty scenariuszy oraz katalog call-offs (pliki źródłowe).'
      : '';
    const confirmMsg =
      bundleImportMode === 'partial'
        ? `Import częściowy: wyczyszczone i uzupełnione z pliku zostaną wyłącznie tabele: ${onlyTables.join(', ')}. Pozostałe dane w bazie nie są usuwane. W pliku muszą być arkusze o nazwach jak tabele.${zipNote} Wykonać backup przed kontynuacją. Kontynuować?`
        : `Import z Excela usunie dane w większości tabel i wstawi zawartość pliku. Ustawienia backupu pozostaną.${zipNote} Zalecany jest świeży backup. Kontynuować?`;
    if (!window.confirm(confirmMsg)) {
      return;
    }
    setBundleImporting(true);
    setError('');
    setMessage('');
    const importCall = isZip
      ? api.admin.importCapacityBundleZip(bundleFile, phrase, bundleImportMode === 'partial' ? onlyTables : undefined)
      : api.admin.importCapacityBundle(bundleFile, phrase, bundleImportMode === 'partial' ? onlyTables : undefined);
    importCall
      .then((r) => {
        const parts = Object.entries(r.rows_counts)
          .filter(([, n]) => n > 0)
          .map(([t, n]) => `${t}: ${n}`)
          .slice(0, 12);
        const more = Object.values(r.rows_counts).filter((n) => n > 0).length > 12 ? '…' : '';
        const prefix = r.partial ? 'Import częściowy zakończony. ' : 'Import zakończony. ';
        const zipResult = r as Partial<{ call_offs_restored: number; scenario_snapshots_restored: number }>;
        const extra =
          zipResult.call_offs_restored != null
            ? ` Odtworzono katalog call-offs (${zipResult.call_offs_restored} plików) i ${zipResult.scenario_snapshots_restored ?? 0} snapshotów scenariuszy z paczki ZIP.`
            : '';
        setMessage(`${prefix}Wstawione wiersze (fragment): ${parts.join(', ')}${more}${extra}`);
        setBundleFile(null);
        setBundleConfirm('');
      })
      .catch((e: any) => setError(e?.message || 'Import nie powiódł się.'))
      .finally(() => setBundleImporting(false));
  };

  if (loading) return <p>{t('common.loading')}</p>;

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <Link to="/administracja" style={{ color: 'var(--cap-green)' }}>
          {t('admin.backAdmin')}
        </Link>
      </div>
      <h1 style={{ marginTop: 0 }}>{t('admin.adminSettings')}</h1>
      <p style={{ color: '#555', marginBottom: '1rem' }}>{t('adminSettingsExtra.intro')}</p>

      {error && <p style={{ color: '#c62828', marginBottom: 10, maxWidth: 760 }}>{error}</p>}
      {message && <p style={{ color: '#2e7d32', marginBottom: 10, maxWidth: 760 }}>{message}</p>}

      <div
        style={{
          background: 'white',
          borderRadius: 8,
          padding: '1rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          maxWidth: 760,
          marginBottom: '1rem',
        }}
      >
        <h3 style={{ margin: '0 0 10px' }}>{t('adminSettingsExtra.appBehaviorTitle')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: '#555', lineHeight: 1.45 }}>{t('settings.behaviorIntro')}</p>
        <label style={{ display: 'block', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={form.volumes_autosave_enabled}
            onChange={(e) => setForm((prev) => ({ ...prev, volumes_autosave_enabled: e.target.checked }))}
            style={{ marginRight: 8 }}
          />
          {t('adminSettingsExtra.volumesAutosave')}
        </label>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#666', lineHeight: 1.45 }}>{t('adminSettingsExtra.volumesAutosaveHint')}</p>
        <button
          type="button"
          onClick={saveBehavior}
          disabled={savingBehavior}
          style={{ padding: '0.5rem 1rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}
        >
          {savingBehavior ? t('common.saving') : t('common.save')}
        </button>
      </div>

      <div
        style={{
          background: 'white',
          borderRadius: 8,
          padding: '1rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          maxWidth: 760,
          marginBottom: '1rem',
        }}
      >
        <h3 style={{ margin: '0 0 10px' }}>{t('adminSettingsExtra.dataImportTitle')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: '#555', lineHeight: 1.5 }}>
          {t('adminSettingsExtra.dataImportIntro')}
        </p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12, fontSize: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dataImportReplaceAll}
            onChange={(e) => setDataImportReplaceAll(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>{t('adminSettingsExtra.replaceAllCheckbox')}</strong>
          </span>
        </label>
        {dataSchemaDiag != null && (
          <div
            role="status"
            style={{
              marginBottom: 12,
              padding: '8px 10px',
              borderRadius: 6,
              fontSize: 13,
              lineHeight: 1.45,
              background:
                dataSchemaDiag.ok && dataSchemaDiag.schemaTag === CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED ? '#e8f5e9' : '#fff3e0',
              color: '#333',
              border: `1px solid ${
                dataSchemaDiag.ok && dataSchemaDiag.schemaTag === CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED ? '#c8e6c9' : '#ffe0b2'
              }`,
            }}
          >
            {dataSchemaDiag.ok && dataSchemaDiag.schemaTag === CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED ? (
              <>
                {t('adminSettingsExtra.schemaBackendOk', {
                  tag: dataSchemaDiag.schemaTag,
                  filename: dataSchemaDiag.templateFilename,
                })}
              </>
            ) : dataSchemaDiag.ok ? (
              <>
                {t('adminSettingsExtra.schemaBackendWrong', {
                  actual: dataSchemaDiag.schemaTag || t('adminSettingsExtra.schemaBackendEmpty'),
                  expected: CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED,
                })}
              </>
            ) : (
              <>{t('adminSettingsExtra.schemaReadFailed', { detail: dataSchemaDiag.detail })}</>
            )}
          </div>
        )}
        {templateInfoError ? (
          <div
            role="alert"
            style={{
              marginBottom: 12,
              padding: '8px 10px',
              borderRadius: 6,
              fontSize: 13,
              background: '#ffebee',
              border: '1px solid #ffcdd2',
              color: '#333',
            }}
          >
            {templateInfoError}
          </div>
        ) : null}
        {templateInfo != null ? (
          <div
            style={{
              marginBottom: 12,
              padding: '8px 10px',
              borderRadius: 6,
              fontSize: 13,
              lineHeight: 1.45,
              background: '#e3f2fd',
              border: '1px solid #bbdefb',
              color: '#333',
            }}
          >
            <strong>{t('adminSettingsExtra.templateManifestTitle')}</strong> {t('adminSettingsExtra.templateManifestSheets')}{' '}
            <code style={{ wordBreak: 'break-word' }}>{templateInfo.sheets.join(' → ')}</code>.
            <br />
            {t('adminSettingsExtra.templateMachinesSheet')} <code>{templateInfo.machinesSheetHeaders.join(', ')}</code>{' '}
            {t('adminSettingsExtra.templateMachinesHeaderNote')}
            <br />
            {t('adminSettingsExtra.templateInstructionNote', { code: templateInfo.instructionRow1MustInclude })}
          </div>
        ) : null}
        <label style={{ display: 'block', marginBottom: 10 }}>
          {t('adminSettingsExtra.xlsxFile')}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'block', marginTop: 6 }}
            onChange={(e) => setDataFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 10 }}>
          {t('adminSettingsExtra.importConfirmLabel')}
          <input
            type="text"
            value={dataConfirm}
            onChange={(e) => setDataConfirm(e.target.value)}
            placeholder={t('adminSettingsExtra.confirmImportData')}
            autoComplete="off"
            style={{ display: 'block', marginTop: 6, width: '100%', maxWidth: 320, padding: 6 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <button
            type="button"
            onClick={downloadDataTemplate}
            disabled={dataDownloading}
            style={{ padding: '0.5rem 1rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {dataDownloading ? t('adminSettingsExtra.downloading') : t('adminSettingsExtra.downloadDataTemplate')}
          </button>
          <button
            type="button"
            onClick={importData}
            disabled={dataImporting}
            style={{ padding: '0.5rem 1rem', background: '#1565c0', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {dataImporting ? t('adminSettingsExtra.importing') : t('adminSettingsExtra.uploadData')}
          </button>
        </div>
      </div>

      <div
        style={{
          background: 'white',
          borderRadius: 8,
          padding: '1rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          maxWidth: 760,
          marginBottom: '1rem',
        }}
      >
        <h3 style={{ margin: '0 0 10px' }}>{t('adminSettingsExtra.machinesImportTitle')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: '#555', lineHeight: 1.5 }}>
          {t('adminSettingsExtra.machinesImportIntro')}
        </p>
        <label style={{ display: 'block', marginBottom: 10, fontSize: 14 }}>
          {t('adminSettingsExtra.xlsxFile')}{' '}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setMachinesFile(e.target.files?.[0] ?? null)}
            style={{ marginLeft: 8 }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 12, fontSize: 14 }}>
          {t('adminSettingsExtra.machinesImportConfirmLabel')}{' '}
          <code style={{ background: '#f5f5f5', padding: '2px 6px', borderRadius: 4 }}>{MACHINES_IMPORT_CONFIRM}</code>
          <input
            type="text"
            value={machinesConfirm}
            onChange={(e) => setMachinesConfirm(e.target.value)}
            style={{ display: 'block', marginTop: 6, width: '100%', maxWidth: 280, padding: 6 }}
            autoComplete="off"
          />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            onClick={downloadMachinesTemplate}
            disabled={machinesDownloading}
            style={{ padding: '0.5rem 1rem', background: '#2e7d32', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {machinesDownloading ? t('adminSettingsExtra.downloading') : t('adminSettingsExtra.downloadMachinesTemplate')}
          </button>
          <button
            type="button"
            onClick={importMachines}
            disabled={machinesImporting}
            style={{ padding: '0.5rem 1rem', background: '#1565c0', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {machinesImporting ? t('adminSettingsExtra.importing') : t('adminSettingsExtra.uploadMachines')}
          </button>
        </div>
      </div>

      <div
        style={{
          background: 'white',
          borderRadius: 8,
          padding: '1rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          maxWidth: 760,
          marginBottom: '1rem',
        }}
      >
        <h3 style={{ margin: '0 0 10px' }}>{t('adminSettingsExtra.bundleTitle')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: '#555', lineHeight: 1.5 }}>
          {t('adminSettingsExtra.bundleIntro')}
        </p>
        <div style={{ marginBottom: 14, fontSize: 14, color: '#444' }}>
          <span style={{ fontWeight: 600, marginRight: 10 }}>{t('adminSettingsExtra.importScope')}</span>
          <label style={{ marginRight: 14, cursor: 'pointer' }}>
            <input type="radio" name="bundleImp" checked={bundleImportMode === 'full'} onChange={() => setBundleImportMode('full')} style={{ marginRight: 6 }} />
            {t('adminSettingsExtra.importFull')}
          </label>
          <label style={{ cursor: 'pointer' }}>
            <input type="radio" name="bundleImp" checked={bundleImportMode === 'partial'} onChange={() => setBundleImportMode('partial')} style={{ marginRight: 6 }} />
            {t('adminSettingsExtra.importPartial')}
          </label>
        </div>
        {bundleImportMode === 'partial' && (
          <div
            style={{
              marginBottom: 14,
              padding: '10px 12px',
              background: '#f5f5f5',
              borderRadius: 6,
              border: '1px solid #e0e0e0',
              fontSize: 14,
            }}
          >
            <p style={{ margin: '0 0 8px', color: '#555' }}>{t('adminSettingsExtra.partialHint')}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginBottom: 8 }}>
              {BUNDLE_PARTIAL_KEYS.map((key) => (
                <label key={key} style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={bundlePartial[key]}
                    onChange={(e) => setBundlePartial((p) => ({ ...p, [key]: e.target.checked }))}
                    style={{ marginRight: 6 }}
                  />
                  {t(
                    key === 'machines'
                      ? 'adminSettingsExtra.partialTableMachines'
                      : key === 'projects'
                        ? 'adminSettingsExtra.partialTableProjects'
                        : key === 'part_designations'
                          ? 'adminSettingsExtra.partialTableDesignations'
                          : key === 'parts'
                            ? 'adminSettingsExtra.partialTableParts'
                            : key === 'operations'
                              ? 'adminSettingsExtra.partialTableOperations'
                              : key === 'scenarios'
                                ? 'adminSettingsExtra.partialTableScenarios'
                                : key === 'call_off_comparisons'
                                  ? 'adminSettingsExtra.partialTableCallOffComparisons'
                                  : 'adminSettingsExtra.partialTableCallOffVolumes'
                  )}
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setBundlePartial(
                  Object.fromEntries(BUNDLE_PARTIAL_KEYS.map((k) => [k, true])) as Record<BundlePartialKey, boolean>
                )
              }
              style={{ padding: '4px 10px', fontSize: 13, border: '1px solid #bdbdbd', borderRadius: 4, background: 'white', cursor: 'pointer' }}
            >
              {t('adminSettingsExtra.selectAllPartial')}
            </button>
          </div>
        )}
        <label style={{ display: 'block', marginBottom: 10 }}>
          {t('adminSettingsExtra.bundleFileLabel')}
          <input
            type="file"
            accept=".xlsx,.zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip,application/x-zip-compressed"
            style={{ display: 'block', marginTop: 6 }}
            onChange={(e) => setBundleFile(e.target.files?.[0] ?? null)}
          />
          <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#777' }}>
            {t('adminSettingsExtra.bundleFileHint')}
          </span>
        </label>
        <label style={{ display: 'block', marginBottom: 10 }}>
          {t('adminSettingsExtra.importConfirmLabel')}
          <input
            type="text"
            value={bundleConfirm}
            onChange={(e) => setBundleConfirm(e.target.value)}
            placeholder={t('adminSettingsExtra.confirmImportBundle')}
            autoComplete="off"
            style={{ display: 'block', marginTop: 6, width: '100%', maxWidth: 320, padding: 6 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <button
            type="button"
            onClick={downloadBundleTemplate}
            disabled={bundleDownloading}
            style={{ padding: '0.5rem 1rem', background: '#455a64', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {bundleDownloading ? t('adminSettingsExtra.downloading') : t('adminSettingsExtra.downloadExcelTemplate')}
          </button>
          <button
            type="button"
            onClick={importBundle}
            disabled={bundleImporting}
            style={{ padding: '0.5rem 1rem', background: '#6a1b9a', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {bundleImporting ? t('adminSettingsExtra.importing') : t('adminSettingsExtra.uploadAndImport')}
          </button>
        </div>
      </div>

      <div style={{ background: 'white', borderRadius: 8, padding: '1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', maxWidth: 760 }}>
        <label style={{ display: 'block', marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={form.backup_enabled}
            onChange={(e) => setForm((prev) => ({ ...prev, backup_enabled: e.target.checked }))}
            style={{ marginRight: 8 }}
          />
          {t('adminSettingsExtra.autoBackup')}
        </label>

        <label style={{ display: 'block', marginBottom: 10 }}>
          {t('adminSettingsExtra.frequencyDays')}
          <input
            type="number"
            min={1}
            value={form.backup_frequency_days}
            onChange={(e) => setForm((prev) => ({ ...prev, backup_frequency_days: Number(e.target.value) || 0 }))}
            style={{ marginLeft: 8, width: 140, padding: 4 }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 10 }}>
          {t('adminSettingsExtra.backupLocation')}
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#666', lineHeight: 1.5, fontWeight: 400 }}>
            {t('adminSettingsExtra.serverPathHint', { base: storageBaseDir || t('adminSettingsExtra.storageBaseFallback') })}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={form.backup_output_dir}
              onChange={(e) => setForm((prev) => ({ ...prev, backup_output_dir: e.target.value }))}
              style={{ width: '70%', minWidth: 260, padding: 4 }}
              placeholder={t('adminSettingsExtra.serverPathPlaceholderBackup')}
            />
            <button
              type="button"
              onClick={() => setStorageBrowse({ kind: 'backup', initialPath: form.backup_output_dir })}
              style={{ padding: '0.5rem 0.75rem', background: '#455a64', color: 'white', border: 'none', borderRadius: 4 }}
            >
              {t('adminSettingsExtra.browseServer')}
            </button>
            {pickLocationAvailable && (
              <button
                type="button"
                onClick={pickLocation}
                disabled={pickingBackupDir}
                title={t('adminSettingsExtra.pickLocationLocalOnlyHint')}
                style={{ padding: '0.5rem 0.75rem', background: '#607d8b', color: 'white', border: 'none', borderRadius: 4 }}
              >
                {pickingBackupDir ? t('adminSettingsExtra.pickingLocation') : t('adminSettingsExtra.pickLocation')}
              </button>
            )}
          </div>
        </label>

        <p style={{ margin: '0 0 10px', fontSize: 13, color: '#666' }}>
          {t('adminSettingsExtra.resolvedPath')} <strong>{absoluteDir || '—'}</strong>
          {backupPathWritable === true && (
            <span style={{ marginLeft: 8, color: 'var(--cap-green)' }}>{t('adminSettingsExtra.pathWritable')}</span>
          )}
          {backupPathWritable === false && (
            <span style={{ marginLeft: 8, color: 'var(--cap-red)' }}>{t('adminSettingsExtra.pathNotWritable')}</span>
          )}
        </p>
        <p style={{ margin: '0 0 4px', fontSize: 13, color: '#666' }}>
          {t('adminSettingsExtra.lastBackup')} <strong>{lastBackupAt || t('adminSettingsExtra.none')}</strong>
        </p>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#666' }}>
          {t('adminSettingsExtra.lastFile')} <strong>{lastBackupFile || t('adminSettingsExtra.none')}</strong>
        </p>

        <div style={{ borderTop: '1px solid #eceff1', paddingTop: 12, marginTop: 10 }}>
          <h3 style={{ margin: '0 0 10px' }}>{t('adminSettingsExtra.restoreTitle')}</h3>
          <label style={{ display: 'block', marginBottom: 8 }}>
            {t('adminSettingsExtra.backupFile')}
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <input
                type="text"
                value={restorePath}
                onChange={(e) => setRestorePath(e.target.value)}
                style={{ width: '70%', minWidth: 260, padding: 4 }}
                placeholder={t('adminSettingsExtra.restorePathPlaceholder')}
              />
              <button
                type="button"
                onClick={pickBackupFile}
                disabled={pickingBackupFile || !pickLocationAvailable}
                title={!pickLocationAvailable ? t('adminSettingsExtra.pickFileServerHint') : undefined}
                style={{
                  padding: '0.5rem 0.75rem',
                  background: pickLocationAvailable ? '#607d8b' : '#bdbdbd',
                  color: 'white',
                  border: 'none',
                  borderRadius: 4,
                  cursor: pickLocationAvailable ? 'pointer' : 'not-allowed',
                }}
              >
                {pickingBackupFile ? t('adminSettingsExtra.pickingLocation') : t('adminSettingsExtra.pickBackupFile')}
              </button>
            </div>
          </label>
          {backupFiles.length > 0 && (
            <label style={{ display: 'block', marginBottom: 10 }}>
              {t('adminSettingsExtra.orFromList')}
              <select
                value={restorePath}
                onChange={(e) => setRestorePath(e.target.value)}
                style={{ marginTop: 6, display: 'block', minWidth: 420, maxWidth: '100%', padding: 6 }}
              >
                <option value="">{t('adminSettingsExtra.chooseBackup')}</option>
                {backupFiles.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.name} ({new Date(f.modified_at).toLocaleString('pl-PL')})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            style={{ padding: '0.5rem 1rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {saving ? t('common.saving') : t('adminSettingsExtra.saveSettings')}
          </button>
          <button
            type="button"
            onClick={createBackupNow}
            disabled={creatingBackup}
            style={{ padding: '0.5rem 1rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {creatingBackup ? t('adminSettingsExtra.creatingBackup') : t('adminSettingsExtra.createBackupNow')}
          </button>
          <button
            type="button"
            onClick={load}
            style={{ padding: '0.5rem 1rem', background: '#9e9e9e', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {t('adminSettingsExtra.refresh')}
          </button>
          <button
            type="button"
            onClick={restoreFromBackup}
            disabled={restoring}
            style={{ padding: '0.5rem 1rem', background: '#f57c00', color: 'white', border: 'none', borderRadius: 4 }}
          >
            {restoring ? t('adminSettingsExtra.restoring') : t('adminSettingsExtra.restoreFromBackup')}
          </button>
        </div>
      </div>

      <div style={{ background: 'white', borderRadius: 8, padding: '1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', maxWidth: 760, marginTop: '2rem' }}>
        <h2 style={{ margin: '0 0 8px', fontSize: '1.15rem' }}>{t('adminSettingsExtra.attachmentsTitle')}</h2>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: '#555', lineHeight: 1.55 }}>{t('adminSettingsExtra.attachmentsIntro')}</p>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#666', lineHeight: 1.5 }}>
          {t('adminSettingsExtra.attachmentsServerHint', {
            base: storageBaseDir || t('adminSettingsExtra.storageBaseFallback'),
          })}
        </p>
        {pickLocationAvailable && (
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#666', lineHeight: 1.5 }}>
            {t('adminSettingsExtra.attachmentsManualHint')}
          </p>
        )}
        <label style={{ display: 'block', marginBottom: 10 }}>
          {t('adminSettingsExtra.attachmentsLocation')}
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={form.project_attachments_output_dir}
              onChange={(e) => setForm((prev) => ({ ...prev, project_attachments_output_dir: e.target.value }))}
              style={{ width: '70%', minWidth: 260, padding: 4 }}
              placeholder={t('adminSettingsExtra.serverPathPlaceholderAttachments')}
            />
            <button
              type="button"
              onClick={() => setStorageBrowse({ kind: 'attachments', initialPath: form.project_attachments_output_dir })}
              style={{ padding: '0.5rem 0.75rem', background: '#455a64', color: 'white', border: 'none', borderRadius: 4 }}
            >
              {t('adminSettingsExtra.browseServer')}
            </button>
            {pickLocationAvailable && (
              <button
                type="button"
                onClick={pickAttachmentsLocation}
                disabled={pickingAttachmentsDir}
                title={t('adminSettingsExtra.pickLocationLocalOnlyHint')}
                style={{ padding: '0.5rem 0.75rem', background: '#607d8b', color: 'white', border: 'none', borderRadius: 4 }}
              >
                {pickingAttachmentsDir ? t('adminSettingsExtra.pickingLocation') : t('adminSettingsExtra.pickLocation')}
              </button>
            )}
          </div>
        </label>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#666' }}>
          {t('adminSettingsExtra.resolvedPath')} <strong>{absoluteAttachmentsDir || '—'}</strong>
          {attachmentsPathWritable === true && (
            <span style={{ marginLeft: 8, color: 'var(--cap-green)' }}>{t('adminSettingsExtra.pathWritable')}</span>
          )}
          {attachmentsPathWritable === false && (
            <span style={{ marginLeft: 8, color: 'var(--cap-red)' }}>{t('adminSettingsExtra.pathNotWritable')}</span>
          )}
        </p>
        <button
          type="button"
          onClick={saveAttachmentsSettings}
          disabled={savingAttachments || !form.project_attachments_output_dir.trim()}
          style={{ padding: '0.5rem 1rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}
        >
          {savingAttachments ? t('common.saving') : t('common.save')}
        </button>
      </div>

      <div
        style={{
          marginTop: '2rem',
          maxWidth: 760,
          borderRadius: 8,
          border: '1px solid #ddd',
          background: '#fff',
          padding: '1rem 1.1rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: '1.15rem' }}>{t('adminSettingsExtra.ocuTitle')}</h2>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: '#555', lineHeight: 1.55 }}>{t('adminSettingsExtra.ocuIntro')}</p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14, fontSize: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.ocu_enabled}
            onChange={(e) => setForm((prev) => ({ ...prev, ocu_enabled: e.target.checked }))}
            style={{ marginTop: 3 }}
          />
          <span>{t('adminSettingsExtra.ocuEnabled')}</span>
        </label>
        <button
          type="button"
          onClick={saveOcuFeature}
          disabled={savingOcu}
          style={{ padding: '0.5rem 1rem', background: 'var(--cap-green)', color: 'white', border: 'none', borderRadius: 4 }}
        >
          {savingOcu ? t('common.saving') : t('common.save')}
        </button>
      </div>

      <div
        style={{
          marginTop: '2rem',
          maxWidth: 760,
          borderRadius: 8,
          border: '2px solid #c62828',
          background: '#ffebee',
          padding: '1rem 1.1rem',
          boxShadow: '0 1px 3px rgba(198,40,40,0.15)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', color: '#b71c1c', fontSize: '1.15rem' }}>{t('adminSettingsExtra.dangerZone')}</h2>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: '#5d4037', lineHeight: 1.55 }}>{t('adminSettingsExtra.clearIntro')}</p>
        <p style={{ margin: '0 0 14px', fontSize: 14, color: '#5d4037', lineHeight: 1.55 }}>{t('adminSettingsExtra.clearSettingsNote')}</p>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, fontSize: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={clearCreateBackup}
            onChange={(e) => {
              setClearCreateBackup(e.target.checked);
              if (e.target.checked) setClearBackupAck(false);
            }}
            style={{ marginTop: 3 }}
          />
          <span>
            {t('adminSettingsExtra.clearAutoBackupCheckbox')}
          </span>
        </label>

        {!clearCreateBackup && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12, fontSize: 14, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={clearBackupAck}
              onChange={(e) => setClearBackupAck(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>{t('adminSettingsExtra.clearBackupAckCheckbox')}</span>
          </label>
        )}

        <label style={{ display: 'block', marginBottom: 12, fontSize: 14 }}>
          {t('adminSettingsExtra.clearConfirmLabel')}
          <input
            type="text"
            value={clearConfirm}
            onChange={(e) => setClearConfirm(e.target.value)}
            placeholder={t('adminSettingsExtra.confirmClearDb')}
            autoComplete="off"
            style={{ display: 'block', marginTop: 6, width: '100%', maxWidth: 320, padding: 6, border: '1px solid #e57373' }}
          />
        </label>

        <button
          type="button"
          onClick={clearDatabase}
          disabled={
            clearing ||
            clearConfirm.trim() !== 'WYCZYSC_BAZE' ||
            (!clearCreateBackup && !clearBackupAck)
          }
          style={{
            padding: '0.5rem 1rem',
            background: '#c62828',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor:
              clearing || clearConfirm.trim() !== 'WYCZYSC_BAZE' || (!clearCreateBackup && !clearBackupAck)
                ? 'not-allowed'
                : 'pointer',
            opacity:
              clearing || clearConfirm.trim() !== 'WYCZYSC_BAZE' || (!clearCreateBackup && !clearBackupAck) ? 0.65 : 1,
          }}
        >
          {clearing ? t('adminSettingsExtra.clearing') : t('adminSettingsExtra.clearDatabase')}
        </button>
      </div>

      {storageBrowse && (
        <ServerStorageBrowser
          kind={storageBrowse.kind}
          initialPath={storageBrowse.initialPath}
          onClose={() => setStorageBrowse(null)}
          onSelect={(value) => {
            if (storageBrowse.kind === 'backup') {
              setForm((prev) => ({ ...prev, backup_output_dir: value }));
            } else {
              setForm((prev) => ({ ...prev, project_attachments_output_dir: value }));
            }
            setMessage(t('adminSettingsExtra.pickLocationChosen'));
          }}
        />
      )}
    </div>
  );
}
