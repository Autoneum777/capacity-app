import { API_UNREACHABLE_MESSAGE } from '../i18n/apiErrors';

const ENV_API = (import.meta.env.VITE_API_BASE ?? '').toString().trim().replace(/\/+$/, '');
const BASE = ENV_API || '/api';

/** Zgodny z `CAPACITY_DATA_IMPORT_SCHEMA_TAG` na backendzie — weryfikacja pobranego szablonu. */
export const CAPACITY_DATA_IMPORT_SCHEMA_EXPECTED = 'operacje-v2';
export const MACHINES_IMPORT_CONFIRM = 'IMPORTUJ_MASZYNY';

function mapFetchFailure(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return new Error(API_UNREACHABLE_MESSAGE);
  }
  return e instanceof Error ? e : new Error(msg);
}

function isLikelyApiUnreachable(res: Response, data: unknown): boolean {
  if (res.status >= 502 && res.status <= 504) return true;
  if (res.status !== 500) return false;
  const err = (data as { error?: string }).error;
  if (err) return false;
  return res.statusText === 'Internal Server Error' || res.statusText === '';
}

/** Build query string only from defined, non-empty params (no "undefined" in URL). */
function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const init: RequestInit = { cache: 'no-store', credentials: 'include', ...options };
  const headers = new Headers(init.headers as HeadersInit | undefined);
  const hasBody = init.body != null && init.body !== '';
  if (hasBody && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  init.headers = headers;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (e) {
    throw mapFetchFailure(e);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent('capacity:unauthorized'));
  }
  if (!res.ok) {
    const apiError = (data as { error?: string }).error;
    if (isLikelyApiUnreachable(res, data)) {
      throw new Error(API_UNREACHABLE_MESSAGE);
    }
    if (apiError) throw new Error(apiError);
    throw new Error(res.statusText || `HTTP ${res.status}`);
  }
  return data as T;
}

export type AuthUser = {
  id: number;
  username: string | null;
  email: string | null;
  display_name: string | null;
  role_id: number;
  role_name: string;
  role_ids: number[];
  role_names: string[];
  is_active: number;
  must_change_password: number;
  is_guest?: number;
  login: string;
};

type VisualSettings = {
  show_alternative_borders: boolean;
  show_rfq_badge: boolean;
  colorize_load_cells: boolean;
  colorize_sum_row: boolean;
  colorize_avg_row: boolean;
  reference_display: 'sap' | 'alias' | 'both';
  machine_display: 'sap' | 'internal' | 'both';
  data_viz_machine_bar_label: 'sap' | 'internal' | 'both';
  ok_enabled: boolean;
  ok_from: number;
  ok_to: number;
  ok_color: string;
  warn_enabled: boolean;
  warn_from: number;
  warn_to: number;
  warn_color: string;
  danger_enabled: boolean;
  danger_from: number;
  danger_to: number;
  danger_color: string;
  contractual_calculator_frame_color: string;
  calculator_page_size: number;
  load_expansion_direction?: 'horizontal' | 'vertical';
  show_sop_marker?: boolean;
  show_eop_marker?: boolean;
  period_month_header_color?: string;
  period_month_frame_color?: string;
  period_week_header_color?: string;
  period_week_frame_color?: string;
  data_viz_default_year_from: number;
  data_viz_default_year_to: number;
};

const VISUAL_SETTINGS_TTL_MS = 45_000;
let visualSettingsCache: { expires: number; value: VisualSettings } | null = null;
let visualSettingsInFlight: Promise<VisualSettings> | null = null;

function invalidateVisualSettingsCache(): void {
  visualSettingsCache = null;
  visualSettingsInFlight = null;
}

function getVisualSettingsCached(): Promise<VisualSettings> {
  if (visualSettingsCache && Date.now() < visualSettingsCache.expires) {
    return Promise.resolve(visualSettingsCache.value);
  }
  if (visualSettingsInFlight) return visualSettingsInFlight;
  visualSettingsInFlight = request<VisualSettings>('/settings/visual')
    .then((value) => {
      visualSettingsCache = { expires: Date.now() + VISUAL_SETTINGS_TTL_MS, value };
      visualSettingsInFlight = null;
      return value;
    })
    .catch((err) => {
      visualSettingsInFlight = null;
      throw err;
    });
  return visualSettingsInFlight;
}

export const api = {
  auth: {
    login: (body: { login: string; password: string }) =>
      request<{ user: AuthUser; permissions: string[] }>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
    logout: () => request<void>('/auth/logout', { method: 'POST' }),
    me: () => request<{ user: AuthUser; permissions: string[] }>('/auth/me'),
    changePassword: (body: { current_password: string; new_password: string }) =>
      request<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify(body) }),
    forgotPassword: (body: { login: string }) =>
      request<{ ok: boolean; message?: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify(body) }),
    resetPassword: (body: { token: string; password: string }) =>
      request<{ ok: boolean }>('/auth/reset-password', { method: 'POST', body: JSON.stringify(body) }),
    guestAvailable: () => request<{ available: boolean }>('/auth/guest-available'),
    adminContacts: () =>
      request<{
        contacts: {
          display_name: string | null;
          email: string | null;
          username: string | null;
          label: string;
          contact: string;
        }[];
      }>('/auth/admin-contacts'),
    guestLogin: () => request<{ user: AuthUser; permissions: string[] }>('/auth/guest', { method: 'POST' }),
  },
  adminUsers: {
    list: () => request<AuthUser[]>('/admin/users'),
    create: (body: {
      username?: string;
      email?: string;
      display_name?: string;
      role_id?: number;
      role_ids?: number[];
      password: string;
    }) => request<AuthUser>('/admin/users', { method: 'POST', body: JSON.stringify(body) }),
    update: (
      id: number,
      body: Partial<{
        username: string;
        email: string;
        display_name: string;
        role_id: number;
        role_ids: number[];
        is_active: boolean;
      }>
    ) => request<AuthUser>(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: number) => request<void>(`/admin/users/${id}`, { method: 'DELETE' }),
    resetPassword: (id: number, send_email?: boolean) =>
      request<{ reset_url: string; email_sent: boolean }>(`/admin/users/${id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ send_email: send_email === true }),
      }),
    listResetRequests: () =>
      request<
        {
          id: number;
          user_id: number;
          status: string;
          requested_at: string;
          username: string | null;
          email: string | null;
          display_name: string | null;
        }[]
      >('/admin/users/password-reset-requests'),
    resolveResetRequest: (id: number, action: 'approve' | 'reject', opts?: { send_email?: boolean; note?: string }) =>
      request<{ ok: boolean; status: string; reset_url?: string; email_sent?: boolean }>(
        `/admin/users/password-reset-requests/${id}`,
        { method: 'PATCH', body: JSON.stringify({ action, ...opts }) }
      ),
  },
  adminRoles: {
    list: () =>
      request<
        {
          id: number;
          name: string;
          description: string | null;
          is_system: number;
          login_required: number;
          permissions: string[];
        }[]
      >('/admin/roles'),
    permissionsCatalog: () => request<{ permissions: string[] }>('/admin/roles/permissions-catalog'),
    create: (body: { name: string; description?: string; login_required?: boolean }) =>
      request<{ id: number; name: string; permissions: string[]; login_required: number }>('/admin/roles', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (id: number, body: { name?: string; description?: string; login_required?: boolean }) =>
      request(`/admin/roles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    setPermissions: (id: number, permissions: string[]) =>
      request(`/admin/roles/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) }),
    delete: (id: number) => request<void>(`/admin/roles/${id}`, { method: 'DELETE' }),
  },
  admin: {
    getBackupSettings: () =>
      request<{
        backup_enabled: boolean;
        backup_frequency_days: number;
        backup_output_dir: string;
        absolute_output_dir: string;
        absolute_attachments_output_dir: string;
        project_attachments_output_dir: string;
        last_backup_at: string;
        last_backup_file: string;
        volumes_autosave_enabled: boolean;
        ocu_enabled: boolean;
        pick_location_available?: boolean;
        is_docker?: boolean;
        storage_base_dir?: string;
        suggested_backup_dir?: string;
        suggested_attachments_dir?: string;
      }>('/admin/backup-settings'),
    setBackupSettings: (body: {
      backup_enabled?: boolean;
      backup_frequency_days?: number;
      backup_output_dir?: string;
      project_attachments_output_dir?: string;
      volumes_autosave_enabled?: boolean;
      ocu_enabled?: boolean;
    }) =>
      request<{
        backup_enabled: boolean;
        backup_frequency_days: number;
        backup_output_dir: string;
        absolute_output_dir: string;
        absolute_attachments_output_dir: string;
        project_attachments_output_dir: string;
        last_backup_at: string;
        last_backup_file: string;
        volumes_autosave_enabled: boolean;
        ocu_enabled: boolean;
        pick_location_available?: boolean;
        is_docker?: boolean;
        storage_base_dir?: string;
      }>('/admin/backup-settings', { method: 'PUT', body: JSON.stringify(body) }),
    backupNow: () =>
      request<{
        ok: boolean;
        file_path: string;
        created_at: string;
        kind?: string;
        included?: { database: boolean; call_offs: boolean; attachments: boolean; scenarios_count: number };
      }>('/admin/backup-now', { method: 'POST' }),
    pickBackupDirectory: () => request<{ chosen: boolean; path: string }>('/admin/pick-backup-directory', { method: 'POST' }),
    pickAttachmentsDirectory: () => request<{ chosen: boolean; path: string }>('/admin/pick-attachments-directory', { method: 'POST' }),
    listAttachments: () =>
      request<{
        storage_configured: boolean;
        storage_root: string | null;
        attachments: {
          id: number;
          project_id: number;
          project_client: string;
          project_name: string;
          description: string;
          original_filename: string;
          stored_filename: string;
          mime_type: string | null;
          size_bytes: number;
          uploaded_at: string;
          uploaded_by: string | null;
          is_shared: number;
          relative_dir: string;
          absolute_path: string | null;
          file_exists: boolean | null;
        }[];
      }>('/admin/attachments'),
    generateOcuData: async (
      transition: File,
      katowice: File,
      routing: File,
      options?: { katowicePassword?: string; columnMapping?: Record<string, string> }
    ) => {
      const fd = new FormData();
      const pwd = String(options?.katowicePassword ?? '').trim();
      // Hasło pierwsze w multipart + nagłówek — duże pliki / proxy czasem gubią pola tekstowe na końcu.
      if (pwd) fd.append('katowicePassword', pwd);
      if (options?.columnMapping) {
        fd.append('columnMapping', JSON.stringify(options.columnMapping));
      }
      fd.append('transition', transition);
      fd.append('katowice', katowice);
      fd.append('routing', routing);
      const headers: Record<string, string> = {};
      if (pwd) headers['X-Katowice-Password'] = pwd;
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/ocu-data/generate`, {
          method: 'POST',
          body: fd,
          headers,
          credentials: 'include',
          cache: 'no-store',
        });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || res.statusText || 'OCU generate failed');
      }
      const statsHeader = res.headers.get('X-OCU-Stats');
      let stats = {
        pivot_rows: 0,
        filled_ab: 0,
        filled_x: 0,
        filled_ac: 0,
        filled_ad: 0,
        filled_ae: 0,
        filled_s1619: 0,
        filled_s2102_large: 0,
        filled_s2102_small: 0,
        unmatched_sonar: 0,
        unmatched_erp_in_db: 0,
        unmatched_routing: 0,
        routing_finished_goods: 0,
      };
      if (statsHeader) {
        try {
          stats = { ...stats, ...JSON.parse(statsHeader) };
        } catch {
          /* ignore */
        }
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition') || '';
      const matched = /filename="([^"]+)"/i.exec(disposition);
      a.download = matched?.[1] || 'Dane_do_OCU.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return { stats };
    },
    previewOcuHeaders: async (
      katowice: File,
      options?: { katowicePassword?: string; columnMapping?: Record<string, string> }
    ) => {
      const fd = new FormData();
      const pwd = String(options?.katowicePassword ?? '').trim();
      if (pwd) fd.append('katowicePassword', pwd);
      if (options?.columnMapping) {
        fd.append('columnMapping', JSON.stringify(options.columnMapping));
      }
      fd.append('katowice', katowice);
      const headers: Record<string, string> = {};
      if (pwd) headers['X-Katowice-Password'] = pwd;
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/ocu-data/preview-headers`, {
          method: 'POST',
          body: fd,
          headers,
          credentials: 'include',
          cache: 'no-store',
        });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || res.statusText || 'OCU preview failed');
      }
      return res.json() as Promise<{
        headerRowNum: number;
        headers: { letter: string; header: string; col1: number }[];
        suggested: Record<string, string>;
      }>;
    },
    startPickLocation: (body: { target: 'backup' | 'attachments' | 'backup-file'; initial_dir?: string }) =>
      request<{ job_id: string }>('/admin/pick-location/start', { method: 'POST', body: JSON.stringify(body) }),
    getPickLocationResult: (jobId: string) =>
      request<{ status: 'pending' | 'done' | 'cancelled' | 'error'; path?: string; error?: string }>(
        `/admin/pick-location/result/${encodeURIComponent(jobId)}`,
      ),
    waitForPickLocation: async (target: 'backup' | 'attachments' | 'backup-file', initialDir?: string) => {
      const { job_id } = await api.admin.startPickLocation({ target, initial_dir: initialDir });
      const started = Date.now();
      while (Date.now() - started < 10 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const result = await api.admin.getPickLocationResult(job_id);
        if (result.status === 'pending') continue;
        if (result.status === 'error') throw new Error(result.error || 'Nie udało się otworzyć wyboru lokalizacji.');
        return { chosen: result.status === 'done' && !!result.path, path: result.path || '' };
      }
      throw new Error('Przekroczono czas oczekiwania na wybór lokalizacji.');
    },
    previewStoragePath: (path: string, kind: 'attachments' | 'backup' = 'attachments') =>
      request<{ absolute_path: string; exists?: boolean; writable?: boolean; setting_value?: string }>(
        '/admin/preview-storage-path',
        {
          method: 'POST',
          body: JSON.stringify({ path, kind }),
        }
      ),
    browseStorage: (body: { path?: string; kind: 'backup' | 'attachments' }) =>
      request<{
        current_path: string;
        setting_value: string;
        parent_path: string | null;
        parent_setting_value: string | null;
        entries: { name: string; path: string; setting_value: string }[];
      }>('/admin/storage/browse', { method: 'POST', body: JSON.stringify(body) }),
    listBackupFiles: () => request<{ name: string; path: string; modified_at: string; size_bytes: number }[]>('/admin/backup-files'),
    pickBackupFile: () => request<{ chosen: boolean; path: string }>('/admin/pick-backup-file', { method: 'POST' }),
    restoreFromBackup: (body: { backup_file_path: string }) =>
      request<{ ok: boolean; restored_from: string; safety_backup_file: string; restored_at: string }>('/admin/restore-from-backup', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    clearDatabase: (body: { confirm: string; create_backup: boolean }) =>
      request<{
        ok: boolean;
        cleared_at: string;
        tables_cleared: string[];
        rows_deleted: Record<string, number>;
        backup_file?: string;
        backup_at?: string;
      }>('/admin/clear-database', { method: 'POST', body: JSON.stringify(body) }),
    /** Pobiera .xlsx: arkusz na tabelę + _INSTRUKCJA. `onlyTables` → tylko wskazane arkusze (szablon pod import częściowy). */
    downloadCapacityBundleTemplate: async (onlyTables?: string[]) => {
      const qs =
        onlyTables?.length != null && onlyTables.length > 0
          ? `?onlyTables=${encodeURIComponent(JSON.stringify(onlyTables))}`
          : '';
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/capacity-bundle-template.xlsx${qs}`, { cache: 'no-store' });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || res.statusText);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        onlyTables?.length != null && onlyTables.length > 0
          ? 'capacity_baza_szablon_wybrane.zip'
          : 'capacity_baza_szablon.zip';
      a.click();
      URL.revokeObjectURL(url);
    },
    /** Multipart: confirm === IMPORTUJ_BAZE, opcjonalnie onlyTables (JSON), na końcu plik. Pola tekstowe muszą być przed `file` — inaczej multer bywa bez `onlyTables` w req.body i import częściowy jest traktowany jak pełny. */
    importCapacityBundle: async (file: File, confirm: string, onlyTables?: string[]) => {
      const fd = new FormData();
      fd.append('confirm', confirm);
      if (onlyTables?.length) fd.append('onlyTables', JSON.stringify(onlyTables));
      fd.append('file', file);
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/capacity-bundle-import`, { method: 'POST', body: fd });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
      return data as { ok: boolean; tables_imported: string[]; rows_counts: Record<string, number>; partial: boolean };
    },
    /** Diagnostyka: czy backend ma endpoint szablonu v2 (`operacje-v2`). */
    fetchCapacityDataImportSchemaDiagnostics: async (): Promise<
      | { ok: true; schemaTag: string; templateFilename: string }
      | { ok: false; detail: string }
    > => {
      try {
        const res = await fetch(`${BASE}/admin/capacity-data-import-schema.txt${toQuery({ t: Date.now() })}`, {
          cache: 'no-store',
        });
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        const text = await res.text();
        const lines = text
          .trim()
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          ok: true,
          schemaTag: lines[0] ?? '',
          templateFilename: lines[1] ?? '',
        };
      } catch (e) {
        return { ok: false, detail: mapFetchFailure(e).message };
      }
    },
    /** Lista arkuszy i nagłówków — ta sama wersja co capacity-data-template.xlsx (bez pobierania pliku). */
    fetchCapacityDataImportTemplateInfo: () =>
      request<{
        schemaTag: string;
        downloadFilename: string;
        sheets: string[];
        machinesSheetHeaders: string[];
        instructionRow1MustInclude: string;
      }>('/admin/capacity-data-template-info.json'),
    downloadCapacityDataTemplate: async (): Promise<{ backendSchemaHeader: string | null }> => {
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/capacity-data-template.xlsx${toQuery({ t: Date.now() })}`, {
          cache: 'no-store',
        });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      const backendSchemaHeader = res.headers.get('X-Capacity-Data-Import-Schema');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const apiErr = (data as { error?: string }).error;
        if (res.status === 404) {
          throw new Error(
            apiErr ||
              'Endpoint importu danych nie został znaleziony (404). Zrestartuj serwer backend (w katalogu server: npm run dev) i odśwież stronę.',
          );
        }
        throw new Error(apiErr || res.statusText);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      let filename = 'capacity_szablon_import_danych_v2.xlsx';
      const cd = res.headers.get('Content-Disposition');
      if (cd) {
        const m = /filename="([^"]+)"/i.exec(cd);
        if (m?.[1]) filename = m[1];
      }
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return { backendSchemaHeader };
    },
    importCapacityData: async (
      file: File,
      confirm: string,
      options?: { mode?: 'merge' | 'replace' }
    ) => {
      const fd = new FormData();
      fd.append('confirm', confirm);
      fd.append('mode', options?.mode === 'replace' ? 'replace' : 'merge');
      fd.append('file', file);
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/capacity-data-import`, { method: 'POST', body: fd });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const apiErr = (data as { error?: string }).error;
        if (res.status === 404) {
          throw new Error(
            apiErr ||
              'Endpoint importu danych nie został znaleziony (404). Zrestartuj serwer backend (w katalogu server: npm run dev).',
          );
        }
        throw new Error(apiErr || res.statusText);
      }
      return data as {
        ok: boolean;
        backup_file?: string;
        backup_at?: string;
        counts: {
          machines_created: number;
          machines_updated: number;
          machines_deleted?: number;
          projects_created: number;
          projects_updated: number;
          projects_deleted?: number;
          designations_created: number;
          designations_updated: number;
          designations_deleted?: number;
          parts_created: number;
          parts_skipped: number;
          parts_deleted?: number;
          volumes_upserted: number;
          volumes_deleted?: number;
          operations_created: number;
          operations_updated: number;
          operations_deleted?: number;
          phases_created?: number;
        };
        warnings: string[];
        mode?: 'merge' | 'replace';
      };
    },
    downloadMachinesImportTemplate: async () => {
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/machines-import-template.xlsx${toQuery({ t: Date.now() })}`, { cache: 'no-store' });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || res.statusText);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'maszyny_import.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    },
    importMachines: async (file: File, confirm: string) => {
      const fd = new FormData();
      fd.append('confirm', confirm);
      fd.append('file', file);
      let res: Response;
      try {
        res = await fetch(`${BASE}/admin/machines-import`, { method: 'POST', body: fd });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
      return data as {
        ok: boolean;
        created: number;
        updated: number;
        skipped: number;
        errors: string[];
        types_added: string[];
        backup_file?: string;
        backup_at?: string;
      };
    },
  },
  settings: {
    list: () => request<any[]>('/settings'),
    get: (id: number) => request<any>(`/settings/${id}`),
    create: (body: any) => request<any>('/settings', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, body: any) => request<any>(`/settings/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: number) => request<void>(`/settings/${id}`, { method: 'DELETE' }),
    fromMonths: (months: number[]) => request<{ working_days_year: number }>('/settings/from-months', { method: 'POST', body: JSON.stringify({ months }) }),
    getDefaults: () =>
      request<{
        working_days_year: number;
        oee_factor: number;
        shift_time_seconds: number;
        startup_shutdown_seconds: number;
        working_weeks_per_year: number;
        shifts_per_day: number;
      }>('/settings/defaults'),
    setDefaults: (body: {
      working_days_year?: number;
      oee_factor?: number;
      shift_time_seconds?: number;
      startup_shutdown_seconds?: number;
      working_weeks_per_year?: number;
      shifts_per_day?: number;
    }) =>
      request<{
        working_days_year: number;
        oee_factor: number;
        shift_time_seconds: number;
        startup_shutdown_seconds: number;
        working_weeks_per_year: number;
        shifts_per_day: number;
      }>('/settings/defaults', { method: 'PUT', body: JSON.stringify(body) }),
    getBehavior: () => request<{ volumes_autosave_enabled: boolean; ocu_enabled: boolean }>('/settings/behavior'),
    setBehavior: (body: { volumes_autosave_enabled?: boolean; ocu_enabled?: boolean }) =>
      request<{ volumes_autosave_enabled: boolean; ocu_enabled: boolean }>('/settings/behavior', { method: 'PUT', body: JSON.stringify(body) }),
    ocu: {
      list: () => request<any[]>('/settings/ocu'),
      get: (id: number) => request<any>(`/settings/ocu/${id}`),
      create: (body: any) => request<any>('/settings/ocu', { method: 'POST', body: JSON.stringify(body) }),
      update: (id: number, body: any) => request<any>(`/settings/ocu/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
      delete: (id: number) => request<void>(`/settings/ocu/${id}`, { method: 'DELETE' }),
      getDefaults: () =>
        request<{
          working_days_year: number;
          oee_factor: number;
          shift_time_seconds: number;
          startup_shutdown_seconds: number;
          working_weeks_per_year: number;
          shifts_per_day: number;
        }>('/settings/ocu/defaults'),
      setDefaults: (body: {
        working_days_year?: number;
        oee_factor?: number;
        shift_time_seconds?: number;
        startup_shutdown_seconds?: number;
        working_weeks_per_year?: number;
        shifts_per_day?: number;
      }) =>
        request<{
          working_days_year: number;
          oee_factor: number;
          shift_time_seconds: number;
          startup_shutdown_seconds: number;
          working_weeks_per_year: number;
          shifts_per_day: number;
        }>('/settings/ocu/defaults', { method: 'PUT', body: JSON.stringify(body) }),
    },
    visual: {
      get: () => getVisualSettingsCached(),
      update: (body: {
        show_alternative_borders: boolean;
        show_rfq_badge: boolean;
        colorize_load_cells: boolean;
        colorize_sum_row: boolean;
        colorize_avg_row: boolean;
        reference_display: 'sap' | 'alias' | 'both';
        machine_display: 'sap' | 'internal' | 'both';
        data_viz_machine_bar_label: 'sap' | 'internal' | 'both';
        ok_enabled: boolean;
        ok_from: number;
        ok_to: number;
        ok_color: string;
        warn_enabled: boolean;
        warn_from: number;
        warn_to: number;
        warn_color: string;
        danger_enabled: boolean;
        danger_from: number;
        danger_to: number;
        danger_color: string;
        contractual_calculator_frame_color: string;
        calculator_page_size: number;
        load_expansion_direction?: 'horizontal' | 'vertical';
        show_sop_marker?: boolean;
        show_eop_marker?: boolean;
        period_month_header_color?: string;
        period_month_frame_color?: string;
        period_week_header_color?: string;
        period_week_frame_color?: string;
        data_viz_default_year_from: number;
        data_viz_default_year_to: number;
      }) =>
        request<any>('/settings/visual', { method: 'PUT', body: JSON.stringify(body) }).then((res) => {
          invalidateVisualSettingsCache();
          return res;
        }),
    },
    phases: {
      list: () => request<{ id: number; name: string }[]>('/settings/phases'),
      create: (name: string) => request<{ id: number; name: string }>('/settings/phases', { method: 'POST', body: JSON.stringify({ name }) }),
      update: (id: number, name: string) => request<{ id: number; name: string }>(`/settings/phases/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
      delete: (id: number) => request<void>(`/settings/phases/${id}`, { method: 'DELETE' }),
    },
    designations: {
      list: () =>
        request<
          {
            id: number;
            designation?: string;
            sap_number?: string | null;
            alias?: string | null;
            free_text?: string | null;
            slot_number?: string | null;
            projects?: { id: number; name: string }[];
            machine_lines?: string[];
          }[]
        >('/settings/designations'),
      create: (body: { sap_number?: string; alias?: string; free_text?: string; slot_number?: string; designation?: string }) =>
        request<{
          id: number;
          designation?: string;
          sap_number?: string | null;
          alias?: string | null;
          free_text?: string | null;
          slot_number?: string | null;
          projects?: { id: number; name: string }[];
          machine_lines?: string[];
        }>('/settings/designations', { method: 'POST', body: JSON.stringify(body) }),
      update: (id: number, body: { sap_number?: string; alias?: string; free_text?: string; slot_number?: string; designation?: string }) =>
        request<{
          id: number;
          designation?: string;
          sap_number?: string | null;
          alias?: string | null;
          free_text?: string | null;
          slot_number?: string | null;
          projects?: { id: number; name: string }[];
          machine_lines?: string[];
        }>(`/settings/designations/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
      delete: (id: number) => request<void>(`/settings/designations/${id}`, { method: 'DELETE' }),
      relatedOperations: (id: number) =>
        request<{
          operations: {
            id: number;
            project_id: number;
            project_client: string;
            project_name: string;
            machine_id: number;
            machine_internal: string | number | null;
            phase_name: string;
            cycle_time_seconds: number;
            is_set: number;
            has_children: number;
            label: string;
            detail_label: string;
          }[];
        }>(`/settings/designations/${id}/related-operations`),
      deleteCascade: (id: number, operation_ids: number[]) =>
        request<{
          operations_deleted: number;
          designation_deleted: boolean;
          operations_remaining: number;
          errors: string[];
        }>(`/settings/designations/${id}/delete-cascade`, {
          method: 'POST',
          body: JSON.stringify({ operation_ids }),
        }),
    },
    machineTypes: {
      list: () => request<{ id: number; name: string; default_machine_usage: number }[]>('/settings/machine-types'),
      create: (body: { name: string; default_machine_usage?: number }) =>
        request<{ id: number; name: string; default_machine_usage: number }>('/settings/machine-types', { method: 'POST', body: JSON.stringify(body) }),
      update: (id: number, body: { name: string; default_machine_usage?: number }) =>
        request<{ id: number; name: string; default_machine_usage: number }>(`/settings/machine-types/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
      delete: (id: number) => request<void>(`/settings/machine-types/${id}`, { method: 'DELETE' }),
      syncFromMachines: () =>
        request<{ inserted: number; types: { id: number; name: string; default_machine_usage: number }[] }>(
          '/settings/machine-types/sync-from-machines',
          { method: 'POST' }
        ),
    },
  },
  machines: {
    list: (params?: { status?: string; statuses?: string; type?: string; types?: string; search?: string }) => {
      const q = toQuery(params || {});
      return request<any[]>(`/machines${q}`);
    },
    types: () => request<string[]>('/machines/types'),
    get: (id: number) => request<any>(`/machines/${id}`),
    activeProjectOperationCount: (id: number) =>
      request<{ count: number; projects: { id: number; client: string; name: string }[] }>(
        `/machines/${id}/active-project-operation-count`
      ),
    operations: (id: number, params?: { year?: number; scenarioId?: number; useContractualVolumes?: boolean }) => {
      const q = toQuery(params || {});
      return request<any[]>(`/machines/${id}/operations${q}`);
    },
    create: (body: any) => request<any>('/machines', { method: 'POST', body: JSON.stringify(body) }),
    import: (machines: any[]) => request<{ created: number; skipped: number; errors: string[]; createdNumbers: number[]; skippedNumbers: number[] }>('/machines/import', { method: 'POST', body: JSON.stringify({ machines }) }),
    update: (id: number, body: any) => request<any>(`/machines/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: number) => request<void>(`/machines/${id}`, { method: 'DELETE' }),
    materials: {
      list: (machineId: number) => request<any[]>(`/machines/${machineId}/materials`),
      designations: (machineId: number) => request<any[]>(`/machines/${machineId}/material-designations`),
      importRouting: (
        machineId: number,
        file: File
      ) => {
        const body = new FormData();
        body.append('file', file);
        return request<{
          routing_finished_goods: number;
          matched_details: number;
          unmatched_details: number;
          materials_created: number;
          materials_updated: number;
          links_created: number;
        }>(`/machines/${machineId}/materials/import-routing`, { method: 'POST', body });
      },
      create: (machineId: number, body: any) =>
        request<any>(`/machines/${machineId}/materials`, { method: 'POST', body: JSON.stringify(body) }),
      update: (machineId: number, materialId: number, body: any) =>
        request<any>(`/machines/${machineId}/materials/${materialId}`, { method: 'PUT', body: JSON.stringify(body) }),
      delete: (machineId: number, materialId: number) =>
        request<void>(`/machines/${machineId}/materials/${materialId}`, { method: 'DELETE' }),
      bulkDelete: (machineId: number, body: { all?: boolean; ids?: number[] }) =>
        request<{ deleted: number }>(`/machines/${machineId}/materials/bulk-delete`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      externalVolumes: {
        list: (machineId: number, materialId: number) =>
          request<{ year: number; weekly_volume: number }[]>(
            `/machines/${machineId}/materials/${materialId}/external-volumes`
          ),
        save: (machineId: number, materialId: number, rows: { year: number; weekly_volume: number }[]) =>
          request<{ year: number; weekly_volume: number }[]>(
            `/machines/${machineId}/materials/${materialId}/external-volumes`,
            { method: 'PUT', body: JSON.stringify(rows) }
          ),
      },
    },
  },
  machineGroups: {
    list: () =>
      request<
        {
          id: number;
          name: string;
          created_at: string;
          machines: { id: number; internal_number: string | null; sap_number: string | null; type: string }[];
        }[]
      >('/machine-groups'),
    get: (id: number) => request<any>(`/machine-groups/${id}`),
    create: (name: string, machine_ids: number[] = []) =>
      request<any>('/machine-groups', { method: 'POST', body: JSON.stringify({ name, machine_ids }) }),
    update: (id: number, name: string, machine_ids?: number[]) =>
      request<any>(`/machine-groups/${id}`, { method: 'PUT', body: JSON.stringify({ name, machine_ids }) }),
    delete: (id: number) => request<void>(`/machine-groups/${id}`, { method: 'DELETE' }),
  },
  nests: {
    list: () => request<any[]>('/nests'),
    get: (id: number) => request<any>(`/nests/${id}`),
    create: (body: any) => request<any>('/nests', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, body: any) => request<any>(`/nests/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: number) => request<void>(`/nests/${id}`, { method: 'DELETE' }),
    addMachine: (nestId: number, machineId: number) =>
      request<any[]>(`/nests/${nestId}/machines`, { method: 'POST', body: JSON.stringify({ machine_id: machineId }) }),
    removeMachine: (nestId: number, machineId: number) =>
      request<void>(`/nests/${nestId}/machines/${machineId}`, { method: 'DELETE' }),
  },
  alternatives: {
    list: (machineId: number) => request<any[]>(`/alternatives/machine/${machineId}`),
    add: (machineId: number, alternativeMachineId: number) =>
      request<any>('/alternatives', { method: 'POST', body: JSON.stringify({ machine_id: machineId, alternative_machine_id: alternativeMachineId }) }),
    remove: (machineId: number, alternativeMachineId: number) =>
      request<void>(`/alternatives/${machineId}/${alternativeMachineId}`, { method: 'DELETE' }),
  },
  projects: {
    list: (params?: { status?: string; statuses?: string; client?: string; clients?: string; search?: string }) => {
      const q = toQuery(params || {});
      return request<any[]>(`/projects${q}`);
    },
    clients: () => request<string[]>('/projects/clients'),
    rfqFilterTree: () =>
      request<{
        clients: {
          client: string;
          projects: {
            id: number;
            name: string;
            parts: {
              id: number;
              label: string;
              operations: {
                id: number;
                label: string;
                machine_id: number;
                location: string | null;
              }[];
            }[];
          }[];
        }[];
      }>('/projects/rfq-filter-tree'),
    get: (id: number) => request<any>(`/projects/${id}`),
    getVolumes: (id: number) => request<{ year: number; volume_value: number; volume_unit: string }[]>(`/projects/${id}/volumes`),
    setVolumes: (id: number, volumes: { year: number; volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number | boolean }[]) => request<any[]>(`/projects/${id}/volumes`, { method: 'PUT', body: JSON.stringify({ volumes }) }),
    getVolumesContract: (id: number) =>
      request<{ year: number; volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number }[]>(`/projects/${id}/volumes-contract`),
    setVolumesContract: (id: number, volumes: { year: number; volume_value: number; volume_unit: string; include_in_calculator_after_eop?: number | boolean }[]) =>
      request<any[]>(`/projects/${id}/volumes-contract`, { method: 'PUT', body: JSON.stringify({ volumes }) }),
    mirrorProjectVolumes: (id: number, direction: 'production_to_contract' | 'contract_to_production') =>
      request<{ ok: boolean }>(`/projects/${id}/volumes-mirror`, { method: 'POST', body: JSON.stringify({ direction }) }),
    create: (body: any) => request<any>('/projects', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, body: any) => request<any>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: number) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
    addPart: (projectId: number, body: any) => request<any>(`/projects/${projectId}/parts`, { method: 'POST', body: JSON.stringify(body) }),
    updatePart: (projectId: number, partId: number, body: any) => request<any>(`/projects/${projectId}/parts/${partId}`, { method: 'PUT', body: JSON.stringify(body) }),
    getPartVolumes: (projectId: number, partId: number) => request<{ year: number; volume_value: number; volume_unit: string }[]>(`/projects/${projectId}/parts/${partId}/volumes`),
    setPartVolumes: (projectId: number, partId: number, volumes: { year: number; volume_value: number; volume_unit: string }[]) => request<any[]>(`/projects/${projectId}/parts/${partId}/volumes`, { method: 'PUT', body: JSON.stringify({ volumes }) }),
    getPartVolumesContract: (projectId: number, partId: number) =>
      request<{ year: number; volume_value: number; volume_unit: string }[]>(`/projects/${projectId}/parts/${partId}/volumes-contract`),
    setPartVolumesContract: (projectId: number, partId: number, volumes: { year: number; volume_value: number; volume_unit: string }[]) =>
      request<any[]>(`/projects/${projectId}/parts/${partId}/volumes-contract`, { method: 'PUT', body: JSON.stringify({ volumes }) }),
    mirrorPartVolumes: (projectId: number, partId: number, direction: 'production_to_contract' | 'contract_to_production') =>
      request<{ ok: boolean }>(`/projects/${projectId}/parts/${partId}/volumes-mirror`, {
        method: 'POST',
        body: JSON.stringify({ direction }),
      }),
    addPartVolumeYear: (projectId: number, partId: number, year: number, volumeSide: 'production' | 'contract' = 'production') =>
      request<{ year: number; eop: string; eop_extended: boolean }>(`/projects/${projectId}/parts/${partId}/volume-year`, {
        method: 'POST',
        body: JSON.stringify({ year, volumeSide }),
      }),
    deletePart: (projectId: number, partId: number) => request<void>(`/projects/${projectId}/parts/${partId}`, { method: 'DELETE' }),
    phases: (projectId: number) => request<any[]>(`/projects/${projectId}/phases`),
    addOperation: (projectId: number, body: any) => request<any>(`/projects/${projectId}/operations`, { method: 'POST', body: JSON.stringify(body) }),
    updateOperation: (projectId: number, opId: number, body: any) => request<any>(`/projects/${projectId}/operations/${opId}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteOperation: (projectId: number, opId: number) => request<void>(`/projects/${projectId}/operations/${opId}`, { method: 'DELETE' }),
    getOperationVolumes: (projectId: number, opId: number) => request<{ year: number; volume_value: number; volume_unit: string }[]>(`/projects/${projectId}/operations/${opId}/volumes`),
    setOperationVolumeYear: (projectId: number, opId: number, body: { year: number; volume_value: number; volume_unit: string }) => request<any>(`/projects/${projectId}/operations/${opId}/volumes`, { method: 'PUT', body: JSON.stringify(body) }),
    setOperationVolumes: (projectId: number, opId: number, volumes: { year: number; volume_value: number; volume_unit: string }[]) => request<any[]>(`/projects/${projectId}/operations/${opId}/volumes`, { method: 'PUT', body: JSON.stringify({ volumes }) }),
    deleteOperationVolumeYear: (projectId: number, opId: number, year: number) => request<void>(`/projects/${projectId}/operations/${opId}/volumes/${year}`, { method: 'DELETE' }),
    addNote: (projectId: number, body: any) => request<any>(`/projects/${projectId}/notes`, { method: 'POST', body: JSON.stringify(body) }),
    updateNote: (projectId: number, noteId: number, body: { note: string }) =>
      request<any>(`/projects/${projectId}/notes/${noteId}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteNote: (projectId: number, noteId: number) => request<void>(`/projects/${projectId}/notes/${noteId}`, { method: 'DELETE' }),
    getSessionActor: () => request<{ login: string }>('/projects/session/actor'),
    getAttachments: (projectId: number) =>
      request<{
        storage_configured: boolean;
        absolute_output_dir: string;
        attachments: {
          id: number;
          project_id: number;
          description: string;
          original_filename: string;
          stored_filename: string;
          mime_type: string | null;
          size_bytes: number;
          uploaded_at: string;
          uploaded_by: string | null;
          is_shared: number;
        }[];
      }>(`/projects/${projectId}/attachments`),
    uploadAttachment: async (projectId: number, file: File, description: string, shared = false) => {
      const fd = new FormData();
      fd.append('description', description);
      if (shared) fd.append('shared', '1');
      fd.append('file', file);
      let res: Response;
      try {
        res = await fetch(`${BASE}/projects/${projectId}/attachments`, { method: 'POST', body: fd });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
      return data;
    },
    deleteAttachment: (projectId: number, attachmentId: number) =>
      request<void>(`/projects/${projectId}/attachments/${attachmentId}`, { method: 'DELETE' }),
    attachmentDownloadUrl: (projectId: number, attachmentId: number) =>
      `${BASE}/projects/${projectId}/attachments/${attachmentId}/download`,
    operationsCopySources: (params?: { q?: string; limit?: number }) => {
      const q = toQuery((params || {}) as Record<string, string | number | boolean | undefined | null>);
      return request<{
        operations: {
          id: number;
          project_id: number;
          project_client: string;
          project_name: string;
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
          phase_name: string;
          machine_internal: number | string;
          machine_sap: string | null;
          machine_type: string | null;
          detail_sap_number?: string | null;
          detail_alias?: string | null;
          detail_free_text?: string | null;
          label: string;
          set_designation_ids?: number[] | null;
          source_designation_id?: number | null;
        }[];
      }>(`/projects/operations-copy-sources${q}`);
    },
    history: (params?: {
      projectId?: number;
      projectIds?: string;
      machineId?: number;
      machineIds?: string;
      partId?: number;
      partIds?: string;
      client?: string;
      clients?: string;
      author?: string;
      authors?: string;
      text?: string;
    }) => {
      const q = toQuery((params || {}) as Record<string, string | number | boolean | undefined | null>);
      return request<any[]>(`/projects/history${q}`);
    },
    historyFilters: () =>
      request<{
        projects: { id: number; client: string; name: string }[];
        clients: string[];
        machines: { id: number; sap_number?: string | null; internal_number?: string | null; type?: string | null }[];
        details: { id: number; label: string }[];
        authors: string[];
      }>('/projects/history/filters'),
  },
  capacity: {
    calculator: (params?: {
      yearFrom?: number;
      yearTo?: number;
      type?: string;
      types?: string;
      machines?: string;
      scenarioId?: number;
      client?: string;
      clients?: string;
      useContractualVolumes?: boolean;
      machineStatus?: 'active' | 'inactive' | 'RFQ' | 'all';
      machineStatuses?: string;
      groupIds?: string;
      widthOp?: 'gte' | 'lte';
      widthValue?: number;
      depthOp?: 'gte' | 'lte';
      depthValue?: number;
      heightOp?: 'gte' | 'lte';
      heightValue?: number;
      strokeOp?: 'gte' | 'lte';
      strokeValue?: number;
      settingsProfile?: 'capacity' | 'ocu';
      includeRfqOperationIds?: string;
    }) => {
      const q = new URLSearchParams();
      if (params?.yearFrom != null) q.set('yearFrom', String(params.yearFrom));
      if (params?.yearTo != null) q.set('yearTo', String(params.yearTo));
      if (params?.type) q.set('type', params.type);
      if (params?.types) q.set('types', params.types);
      if (params?.machines) q.set('machines', params.machines);
      if (params?.scenarioId != null) q.set('scenarioId', String(params.scenarioId));
      if (params?.client) q.set('client', params.client);
      if (params?.clients) q.set('clients', params.clients);
      if (params?.useContractualVolumes) q.set('useContractualVolumes', '1');
      if (params?.machineStatuses) q.set('machineStatuses', params.machineStatuses);
      else if (params?.machineStatus != null) q.set('machineStatus', String(params.machineStatus));
      if (params?.groupIds) q.set('groupIds', params.groupIds);
      if (params?.settingsProfile === 'ocu') q.set('settingsProfile', 'ocu');
      if (params?.includeRfqOperationIds) q.set('includeRfqOperationIds', params.includeRfqOperationIds);
      const dimPairs = [
        ['width', params?.widthOp, params?.widthValue],
        ['depth', params?.depthOp, params?.depthValue],
        ['height', params?.heightOp, params?.heightValue],
        ['stroke', params?.strokeOp, params?.strokeValue],
      ] as const;
      for (const [prefix, op, val] of dimPairs) {
        const n = val == null ? NaN : Number(val);
        if (op && Number.isFinite(n)) {
          q.set(`${prefix}Op`, op);
          q.set(`${prefix}Value`, String(n));
        }
      }
      const qs = q.toString();
      return request<{
        yearFrom: number;
        yearTo: number;
        scenarioId: number | null;
        dimensionFilters?: { field: string; op: string; value: number }[];
        machines: any[];
      }>(`/capacity/calculator${qs ? `?${qs}` : ''}`);
    },
    periodBreakdown: (params: {
      year: number;
      machineIds?: string;
      yearFrom?: number;
      yearTo?: number;
      type?: string;
      types?: string;
      machines?: string;
      scenarioId?: number;
      client?: string;
      clients?: string;
      useContractualVolumes?: boolean;
      machineStatus?: 'active' | 'inactive' | 'RFQ' | 'all';
      machineStatuses?: string;
      groupIds?: string;
      widthOp?: 'gte' | 'lte';
      widthValue?: number;
      depthOp?: 'gte' | 'lte';
      depthValue?: number;
      heightOp?: 'gte' | 'lte';
      heightValue?: number;
      strokeOp?: 'gte' | 'lte';
      strokeValue?: number;
      settingsProfile?: 'capacity' | 'ocu';
      includeRfqOperationIds?: string;
    }) => {
      const q = new URLSearchParams();
      q.set('year', String(params.year));
      if (params.machineIds) q.set('machineIds', params.machineIds);
      if (params.yearFrom != null) q.set('yearFrom', String(params.yearFrom));
      if (params.yearTo != null) q.set('yearTo', String(params.yearTo));
      if (params.type) q.set('type', params.type);
      if (params.types) q.set('types', params.types);
      if (params.machines) q.set('machines', params.machines);
      if (params.scenarioId != null) q.set('scenarioId', String(params.scenarioId));
      if (params.client) q.set('client', params.client);
      if (params.clients) q.set('clients', params.clients);
      if (params.useContractualVolumes) q.set('useContractualVolumes', '1');
      if (params.machineStatuses) q.set('machineStatuses', params.machineStatuses);
      else if (params.machineStatus != null) q.set('machineStatus', String(params.machineStatus));
      if (params.groupIds) q.set('groupIds', params.groupIds);
      if (params.settingsProfile === 'ocu') q.set('settingsProfile', 'ocu');
      if (params.includeRfqOperationIds) q.set('includeRfqOperationIds', params.includeRfqOperationIds);
      const dimPairs = [
        ['width', params.widthOp, params.widthValue],
        ['depth', params.depthOp, params.depthValue],
        ['height', params.heightOp, params.heightValue],
        ['stroke', params.strokeOp, params.strokeValue],
      ] as const;
      for (const [prefix, op, val] of dimPairs) {
        const n = val == null ? NaN : Number(val);
        if (op && Number.isFinite(n)) {
          q.set(`${prefix}Op`, op);
          q.set(`${prefix}Value`, String(n));
        }
      }
      return request<{ year: number; machines: { machine_id: number; has_sop?: boolean; has_eop?: boolean; months: Record<number, { load_percent: number; weeks: Record<number, { load_percent: number }>; has_sop?: boolean; has_eop?: boolean }> }[] }>(
        `/capacity/calculator/period-breakdown?${q.toString()}`
      );
    },
    sopEopMarkers: (params: {
      machineIds?: string;
      yearFrom?: number;
      yearTo?: number;
      type?: string;
      types?: string;
      machines?: string;
      scenarioId?: number;
      client?: string;
      clients?: string;
      machineStatus?: 'active' | 'inactive' | 'RFQ' | 'all';
      machineStatuses?: string;
      groupIds?: string;
      widthOp?: 'gte' | 'lte';
      widthValue?: number;
      depthOp?: 'gte' | 'lte';
      depthValue?: number;
      heightOp?: 'gte' | 'lte';
      heightValue?: number;
      strokeOp?: 'gte' | 'lte';
      strokeValue?: number;
      settingsProfile?: 'capacity' | 'ocu';
    }) => {
      const q = new URLSearchParams();
      if (params.machineIds) q.set('machineIds', params.machineIds);
      if (params.yearFrom != null) q.set('yearFrom', String(params.yearFrom));
      if (params.yearTo != null) q.set('yearTo', String(params.yearTo));
      if (params.type) q.set('type', params.type);
      if (params.types) q.set('types', params.types);
      if (params.machines) q.set('machines', params.machines);
      if (params.scenarioId != null) q.set('scenarioId', String(params.scenarioId));
      if (params.client) q.set('client', params.client);
      if (params.clients) q.set('clients', params.clients);
      if (params.machineStatuses) q.set('machineStatuses', params.machineStatuses);
      else if (params.machineStatus != null) q.set('machineStatus', String(params.machineStatus));
      if (params.groupIds) q.set('groupIds', params.groupIds);
      if (params.settingsProfile === 'ocu') q.set('settingsProfile', 'ocu');
      const dimPairs = [
        ['width', params.widthOp, params.widthValue],
        ['depth', params.depthOp, params.depthValue],
        ['height', params.heightOp, params.heightValue],
        ['stroke', params.strokeOp, params.strokeValue],
      ] as const;
      for (const [prefix, op, val] of dimPairs) {
        const n = val == null ? NaN : Number(val);
        if (op && Number.isFinite(n)) {
          q.set(`${prefix}Op`, op);
          q.set(`${prefix}Value`, String(n));
        }
      }
      return request<{
        yearFrom: number;
        yearTo: number;
        machines: { machine_id: number; years: Record<number, { has_sop: boolean; has_eop: boolean; months: Record<number, { has_sop: boolean; has_eop: boolean }> }> }[];
      }>(`/capacity/calculator/sop-eop-markers?${q.toString()}`);
    },
    breakdown: (params: {
      year: number;
      month?: number;
      week?: number;
      line?: string;
      machineId?: number;
      series: string;
      yearFrom?: number;
      yearTo?: number;
      type?: string;
      types?: string;
      client?: string;
      clients?: string;
      scenarioId?: number;
      callOffComparisonId?: number;
      machineStatus?: 'active' | 'inactive' | 'RFQ' | 'all';
      machineStatuses?: string;
      settingsProfile?: 'capacity' | 'ocu';
      includeRfqOperationIds?: string;
      widthOp?: 'gte' | 'lte';
      widthValue?: number;
      depthOp?: 'gte' | 'lte';
      depthValue?: number;
      heightOp?: 'gte' | 'lte';
      heightValue?: number;
      strokeOp?: 'gte' | 'lte';
      strokeValue?: number;
    }) => {
      const q = new URLSearchParams();
      q.set('year', String(params.year));
      q.set('series', params.series);
      if (params.month != null) q.set('month', String(params.month));
      if (params.week != null) q.set('week', String(params.week));
      if (params.line) q.set('line', params.line);
      if (params.machineId != null) q.set('machineId', String(params.machineId));
      if (params.yearFrom != null) q.set('yearFrom', String(params.yearFrom));
      if (params.yearTo != null) q.set('yearTo', String(params.yearTo));
      if (params.types) q.set('types', params.types);
      else if (params.type) q.set('type', params.type);
      if (params.clients) q.set('clients', params.clients);
      else if (params.client) q.set('client', params.client);
      if (params.scenarioId != null) q.set('scenarioId', String(params.scenarioId));
      if (params.callOffComparisonId != null) q.set('callOffComparisonId', String(params.callOffComparisonId));
      if (params.machineStatuses) q.set('machineStatuses', params.machineStatuses);
      else if (params.machineStatus != null) q.set('machineStatus', String(params.machineStatus));
      if (params.settingsProfile === 'ocu') q.set('settingsProfile', 'ocu');
      if (params.includeRfqOperationIds) q.set('includeRfqOperationIds', params.includeRfqOperationIds);
      const dimPairs = [
        ['width', params.widthOp, params.widthValue],
        ['depth', params.depthOp, params.depthValue],
        ['height', params.heightOp, params.heightValue],
        ['stroke', params.strokeOp, params.strokeValue],
      ] as const;
      for (const [prefix, op, val] of dimPairs) {
        const n = val == null ? NaN : Number(val);
        if (op && Number.isFinite(n)) {
          q.set(`${prefix}Op`, op);
          q.set(`${prefix}Value`, String(n));
        }
      }
      return request<{
        year: number;
        month?: number | null;
        week?: number | null;
        series: Partial<
          Record<
            'production' | 'contract' | 'scenario_production' | 'scenario_contract' | 'call_off',
            {
              load_percent: number | null;
              clients: {
                client: string;
                load_percent: number;
                share_percent: number;
                projects: {
                  project_id: number;
                  project_name: string;
                  load_percent: number;
                  share_percent: number;
                  details: {
                    detail_label: string;
                    load_percent: number;
                    share_percent: number;
                    has_rfq: boolean;
                  }[];
                }[];
              }[];
            }
          >
        >;
      }>(`/capacity/breakdown?${q.toString()}`);
    },
    settings: (year: number, params?: { settingsProfile?: 'capacity' | 'ocu' }) => {
      const q = params?.settingsProfile === 'ocu' ? '?settingsProfile=ocu' : '';
      return request<any>(`/capacity/settings/${year}${q}`);
    },
    machine: (machineId: number, params?: { yearFrom?: number; yearTo?: number; scenarioId?: number; useContractualVolumes?: boolean; settingsProfile?: 'capacity' | 'ocu' }) => {
      const q = new URLSearchParams();
      if (params?.yearFrom != null) q.set('yearFrom', String(params.yearFrom));
      if (params?.yearTo != null) q.set('yearTo', String(params.yearTo));
      if (params?.scenarioId != null) q.set('scenarioId', String(params.scenarioId));
      if (params?.useContractualVolumes) q.set('useContractualVolumes', '1');
      if (params?.settingsProfile === 'ocu') q.set('settingsProfile', 'ocu');
      const qs = q.toString();
      return request<any>(`/capacity/machine/${machineId}${qs ? `?${qs}` : ''}`);
    },
    year: (year: number, params?: { type?: string; machines?: string }) => {
      const q = new URLSearchParams(params as any).toString();
      return request<{ year: number; machines: any[] }>(`/capacity/year/${year}${q ? `?${q}` : ''}`);
    },
    nests: (year: number) => request<any[]>(`/capacity/nests/year/${year}`),
  },
  allocation: {
    overloaded: (params?: { year?: number; threshold?: number }) => {
      const q = new URLSearchParams(params as any).toString();
      return request<{ year: number; machines: any[] }>(`/allocation/overloaded${q ? `?${q}` : ''}`);
    },
    candidates: (machineId: number, params?: { year?: number; maxLoad?: number; includeOverloadedAlternatives?: boolean; scenarioId?: number; useContractualVolumes?: boolean }) => {
      const q = toQuery((params || {}) as Record<string, string | number | boolean | undefined>);
      return request<{ candidates: any[] }>(`/allocation/candidates/${machineId}${q}`);
    },
    hint: (machineId: number, params: { year: number; operationId: number; operationIds?: string; scenarioId?: number; useContractualVolumes?: boolean }) => {
      const q = toQuery(params as Record<string, string | number | boolean | undefined | null>);
      return request<{
        current_load_percent: number;
        op_load_percent: number;
        suggested_volume_to_reach_100: number;
        suggested_volume_unit: string;
        effective_volume_value: number;
        effective_volume_unit: string;
        load_ratio_sum: number;
        usage: number;
        op_ratio_contrib: number;
        weekly_volume_effective: number;
        working_weeks_per_year: number;
        year_fraction: number;
      }>(`/allocation/hint/${machineId}${q ? `?${q}` : ''}`);
    },
    execute: (body: {
      operationId: number;
      targetMachineId: number;
      volumeToMove: number;
      volumeUnit: string;
      year: number;
      cycleTimeSecondsOnTarget?: number | null;
      useAlternativeCycleOnTarget?: boolean;
      scenarioId?: number;
      useContractualVolumes?: boolean;
      effectiveFromMonth?: number;
      effectiveFromWeek?: number;
    }) => request<any>('/allocation/execute', { method: 'POST', body: JSON.stringify(body) }),
  },
  scenarios: {
    list: (params?: { archived?: boolean }) =>
      request<
        {
          id: number;
          name: string;
          created_at: string;
          scenario_scope?: string;
          source_scenario_id?: number | null;
          source_scenario_name?: string | null;
          source_call_off_comparison_id?: number | null;
          source_call_off_name?: string | null;
          updated_at?: string | null;
          archived_at?: string | null;
        }[]
      >(`/scenarios${params?.archived ? '?archived=1' : ''}`),
    get: (id: number) =>
      request<{
        id: number;
        name: string;
        scenario_scope?: string;
        created_at: string;
        updated_at?: string | null;
        source_scenario_id?: number | null;
        source_call_off_comparison_id?: number | null;
        archived_at?: string | null;
        snapshot: any;
      }>(`/scenarios/${id}`),
    create: (body: {
      name: string;
      scenario_scope: string;
      sourceScenarioId?: number | null;
      sourceCallOffComparisonId?: number | null;
    }) =>
      request<{
        id: number;
        name: string;
        scenario_scope?: string;
        created_at: string;
        source_scenario_id?: number | null;
        source_call_off_comparison_id?: number | null;
        updated_at?: string | null;
      }>(
        '/scenarios',
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      ),
    update: (id: number, body: { name?: string; scenario_scope?: string; snapshot?: unknown }) =>
      request<{ id: number; name: string; scenario_scope?: string; created_at: string; source_scenario_id?: number | null; updated_at?: string | null }>(
        `/scenarios/${id}`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        }
      ),
    historyFilters: (scenarioId: number) =>
      request<{
        projects: { id: number; client: string; name: string }[];
        clients: string[];
        machines: { id: number; sap_number?: string | null; internal_number?: string | null; type?: string | null }[];
        details: { id: number; label: string }[];
        authors: string[];
      }>(`/scenarios/${scenarioId}/history/filters`),
    history: (
      scenarioId: number,
      params?: {
        projectId?: number;
        projectIds?: string;
        machineId?: number;
        machineIds?: string;
        partId?: number;
        partIds?: string;
        client?: string;
        clients?: string;
        author?: string;
        authors?: string;
        text?: string;
      }
    ) => {
      const q = toQuery((params || {}) as Record<string, string | number | boolean | undefined | null>);
      return request<any[]>(`/scenarios/${scenarioId}/history${q}`);
    },
    patchProjectStatus: (scenarioId: number, projectId: number, body: { status: 'active' | 'inactive' | 'RFQ' }) =>
      request<{ id: number; status: string; unchanged?: boolean }>(`/scenarios/${scenarioId}/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    /** Zmiana SOP/EOP projektu — tylko w scenariuszu, bez wpływu na produkcję. */
    patchProjectSopEop: (scenarioId: number, projectId: number, body: { sop?: string; eop?: string }) =>
      request<{ id: number; status: string; sop: string | null; eop: string | null; unchanged?: boolean }>(
        `/scenarios/${scenarioId}/projects/${projectId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        }
      ),
    /** Wolumen detalu (roczne wartości) — tylko w scenariuszu, bez wpływu na produkcję. */
    putPartVolumes: (
      scenarioId: number,
      partId: number,
      body:
        | { mode: 'override'; volumes: { year: number; volume_value: number; volume_unit: 'annual' | 'monthly' | 'weekly' }[] }
        | { mode: 'project' }
    ) =>
      request<{
        id: number;
        volume_mode: string;
        volumes: { part_id: number; year: number; volume_value: number; volume_unit: string; volume_origin?: string }[];
        unchanged?: boolean;
      }>(`/scenarios/${scenarioId}/parts/${partId}/volumes`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    patchPartStatus: (scenarioId: number, partId: number, body: { status: 'active' | 'inactive' | 'RFQ' | null }) =>
      request<{ id: number; status: string | null; unchanged?: boolean }>(`/scenarios/${scenarioId}/parts/${partId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    patchOperationStatus: (scenarioId: number, operationId: number, body: { status: 'active' | 'inactive' | 'RFQ' | null }) =>
      request<{ id: number; status: string | null; unchanged?: boolean }>(`/scenarios/${scenarioId}/operations/${operationId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    addableProjects: (scenarioId: number) =>
      request<{ id: number; client: string; name: string; sop: string | null; eop: string | null; status: string }[]>(
        `/scenarios/${scenarioId}/addable-projects`
      ),
    addProjectsFromCapacity: (scenarioId: number, body: { projectIds: number[] }) =>
      request<{
        ok: boolean;
        addedProjectIds: number[];
        skippedAlreadyInBundle: number[];
        notFoundInProduction: number[];
      }>(`/scenarios/${scenarioId}/add-projects-from-capacity`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    deployChallenge: (id: number) =>
      request<{ phrase: string; expiresInSec: number; deployToken: string }>(`/scenarios/${id}/deploy-challenge`),
    applyToProduction: (id: number, body: { challengePhrase: string; deployToken: string }) =>
      request<{ ok: boolean; message: string }>(`/scenarios/${id}/apply-to-production`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** Częściowe wgranie: wybrane projekty (całość) lub wybrane detale; bez nadpisywania całej bazy / working_days. */
    applySubsetToProduction: (
      id: number,
      body: { challengePhrase: string; deployToken: string; projectIds: number[]; partIds?: number[] }
    ) =>
      request<{ ok: boolean; message: string; projectsTouched?: number; partsTouched?: number; mode?: string }>(
        `/scenarios/${id}/apply-subset-to-production`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      ),
    delete: (id: number) => request<void>(`/scenarios/${id}`, { method: 'DELETE' }),
    archive: (id: number) => request<{ ok: boolean }>(`/scenarios/${id}/archive`, { method: 'POST' }),
    unarchive: (id: number) => request<{ ok: boolean }>(`/scenarios/${id}/unarchive`, { method: 'POST' }),
  },
  callOffs: {
    list: (params?: { archived?: boolean }) =>
      request<
        {
          id: number;
          name: string;
          date_from: string;
          date_to: string;
          notes?: string | null;
          source_filename: string | null;
          created_at: string;
          updated_at: string;
          archived_at?: string | null;
          volume_row_count?: number;
        }[]
      >(`/call-offs${params?.archived ? '?archived=1' : ''}`),
    get: (id: number) =>
      request<{
        id: number;
        name: string;
        date_from: string;
        date_to: string;
        notes?: string | null;
        source_filename: string | null;
        source_stored_filename?: string | null;
        created_at: string;
        updated_at: string;
        archived_at?: string | null;
        volume_row_count?: number;
        source_file_available?: boolean;
        unmatched_report_available?: boolean;
        last_import?: {
          imported: number;
          skippedOutOfRange: number;
          skippedInvalid: number;
          unmatchedSap: number;
          matchedExact: number;
          matchedTruncated: number;
          unmatchedReport: { sap_ref: string; row_count: number; total_quantity: number }[];
        } | null;
        stats?: {
          row_count: number;
          sap_count: number;
          part_count: number;
          min_date: string | null;
          max_date: string | null;
        };
      }>(`/call-offs/${id}`),
    create: async (body: { name: string; notes?: string; file: File }) => {
      const fd = new FormData();
      fd.append('name', body.name);
      if (body.notes?.trim()) fd.append('notes', body.notes.trim());
      fd.append('file', body.file);
      const res = await fetch(`${BASE}/call-offs`, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
      return data as {
        id: number;
        name: string;
        date_from: string;
        date_to: string;
        notes: string | null;
        source_filename: string | null;
        last_import?: {
          imported: number;
          skippedOutOfRange: number;
          skippedInvalid: number;
          unmatchedSap: number;
          matchedExact: number;
          matchedTruncated: number;
          unmatchedReport: { sap_ref: string; row_count: number; total_quantity: number }[];
        };
      };
    },
    delete: (id: number) => request<void>(`/call-offs/${id}`, { method: 'DELETE' }),
    archive: (id: number) => request<{ ok: boolean }>(`/call-offs/${id}/archive`, { method: 'POST' }),
    unarchive: (id: number) => request<{ ok: boolean }>(`/call-offs/${id}/unarchive`, { method: 'POST' }),
    downloadSourceFile: async (id: number, filename: string) => {
      let res: Response;
      try {
        res = await fetch(`${BASE}/call-offs/${id}/source-file`, { credentials: 'include', cache: 'no-store' });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || res.statusText);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'SalesFcst.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    },
    downloadUnmatchedReport: async (id: number, filename: string) => {
      let res: Response;
      try {
        res = await fetch(`${BASE}/call-offs/${id}/unmatched-report`, { credentials: 'include', cache: 'no-store' });
      } catch (e) {
        throw mapFetchFailure(e);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || res.statusText);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    importSalesFcst: async (
      id: number,
      file: File
    ): Promise<{
      imported: number;
      skippedOutOfRange: number;
      skippedInvalid: number;
      unmatchedSap: number;
      matchedExact: number;
      matchedTruncated: number;
      unmatchedReport: { sap_ref: string; row_count: number; total_quantity: number }[];
    }> => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${BASE}/call-offs/${id}/import-sales-fcst`, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
      return data;
    },
    calculator: (id: number, params?: Record<string, string | number | boolean | undefined | null>) =>
      request<{
        comparisonId: number;
        yearFrom: number;
        yearTo: number;
        date_from: string;
        date_to: string;
        volumeYears?: number[];
        machines: {
          machine_id: number;
          internal_number: string | number;
          sap_number: string | null;
          type: string;
          machine_status?: string | null;
          location?: string | null;
          years: Record<
            number,
            {
              load_percent: number;
              call_off_load_percent: number;
              call_off_annual_load_percent?: number;
              call_off_annual_required_sec_per_week?: number;
              call_off_annual_availability_sec_per_week?: number;
              availability_sec_per_week?: number;
              required_sec_per_week?: number;
              alternative_border?: string;
              has_rfq?: boolean;
              detail_breakdown?: unknown[];
              call_off_detail_breakdown?: unknown[];
            }
          >;
        }[];
      }>(`/call-offs/${id}/calculator${toQuery(params ?? {})}`),
    periodBreakdown: (
      id: number,
      params: { year: number; machineIds: string } & Record<string, string | number | boolean | undefined | null>
    ) =>
      request<{
        year: number;
        machines: {
          machine_id: number;
          has_sop?: boolean;
          has_eop?: boolean;
          months: Record<
            number,
            {
              load_percent: number;
              call_off_load_percent: number;
              weeks: Record<number, { load_percent: number; call_off_load_percent: number }>;
              has_sop?: boolean;
              has_eop?: boolean;
            }
          >;
        }[];
      }>(`/call-offs/${id}/calculator/period-breakdown${toQuery(params)}`),
    sopEopMarkers: (id: number, params?: Record<string, string | number | boolean | undefined | null>) =>
      request<{
        yearFrom: number;
        yearTo: number;
        machines: { machine_id: number; years: Record<number, unknown> }[];
      }>(`/call-offs/${id}/calculator/sop-eop-markers${toQuery(params ?? {})}`),
  },
};
