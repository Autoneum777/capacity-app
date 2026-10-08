import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import {
  AdminModal,
  adminBadgeGuest,
  adminBadgeSystem,
  adminBtnDanger,
  adminBtnEdit,
  adminBtnPrimary,
  adminBtnSecondary,
  adminFilterInputStyle,
  adminFilterRowStyle,
  adminInputStyle,
  adminTableStyle,
  adminTdStyle,
  adminThStyle,
} from '../components/AdminAuthUi';
import SortableTh from '../components/SortableTh';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { useTableSort, sortRows } from '../utils/tableSort';

type PermAction = 'view' | 'details' | 'change_status' | 'edit' | 'delete' | 'download' | 'create_rfq' | 'view_confidential';

const PERMISSION_RESOURCES: { key: string; labelKey: string; actions: PermAction[] }[] = [
  { key: 'calculator', labelKey: 'auth.permCalculator', actions: ['view', 'download'] },
  { key: 'machines', labelKey: 'auth.permMachines', actions: ['view', 'details', 'change_status', 'edit', 'delete', 'download'] },
  {
    key: 'projects',
    labelKey: 'auth.permProjects',
    actions: ['view', 'details', 'change_status', 'edit', 'delete', 'create_rfq'],
  },
  { key: 'designations', labelKey: 'auth.permDesignations', actions: ['view', 'edit', 'delete', 'download'] },
  { key: 'scenarios', labelKey: 'auth.permScenarios', actions: ['view', 'edit', 'delete', 'download', 'view_confidential'] },
  { key: 'call_offs', labelKey: 'auth.permCallOffs', actions: ['view', 'edit', 'delete', 'download'] },
  { key: 'admin_database', labelKey: 'auth.permAdminDatabase', actions: ['view', 'edit', 'download'] },
  { key: 'admin_settings', labelKey: 'auth.permAdminSettings', actions: ['view', 'edit', 'download'] },
  { key: 'admin_data_viz', labelKey: 'auth.permAdminDataViz', actions: ['view', 'edit', 'download'] },
  { key: 'admin_ocu', labelKey: 'auth.permAdminOcu', actions: ['view', 'edit'] },
  { key: 'admin_attachments', labelKey: 'auth.permAdminAttachments', actions: ['view', 'download'] },
  { key: 'change_history', labelKey: 'auth.permChangeHistory', actions: ['view', 'download'] },
  { key: 'user_management', labelKey: 'auth.permUserManagement', actions: ['view', 'edit', 'delete'] },
  { key: 'role_management', labelKey: 'auth.permRoleManagement', actions: ['view', 'edit', 'delete'] },
];

const ACTION_COLUMNS: PermAction[] = [
  'view',
  'details',
  'change_status',
  'edit',
  'delete',
  'download',
  'create_rfq',
  'view_confidential',
];

export function PermissionMatrix({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const set = useMemo(() => new Set(value), [value]);
  const toggle = (perm: string) => {
    if (disabled) return;
    const next = new Set(set);
    if (next.has(perm)) {
      next.delete(perm);
      // Wyłączenie obsługi załączników = też brak pobierania plików
      if (perm === 'admin_attachments.view') next.delete('admin_attachments.download');
    } else {
      next.add(perm);
    }
    onChange([...next].sort());
  };
  const actionLabel = (action: PermAction) => {
    if (action === 'view') return t('auth.permView');
    if (action === 'details') return t('auth.permDetails');
    if (action === 'change_status') return t('auth.permChangeStatus');
    if (action === 'edit') return t('auth.permEdit');
    if (action === 'delete') return t('auth.permDelete');
    if (action === 'create_rfq') return t('auth.permCreateRfq');
    if (action === 'view_confidential') return t('auth.permViewConfidential');
    return t('auth.permDownload');
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ ...adminTableStyle, boxShadow: 'none', border: '1px solid #eee' }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <th style={{ ...adminThStyle, minWidth: 160 }}>{t('auth.permResource')}</th>
            {ACTION_COLUMNS.map((action) => (
              <th key={action} style={{ ...adminThStyle, textAlign: 'center', fontSize: 12, whiteSpace: 'nowrap' }}>
                {actionLabel(action)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMISSION_RESOURCES.map((row) => (
            <tr key={row.key} style={{ borderTop: '1px solid #eee' }}>
              <td style={adminTdStyle}>{t(row.labelKey)}</td>
              {ACTION_COLUMNS.map((action) => {
                const perm = `${row.key}.${action}`;
                const supported = row.actions.includes(action);
                return (
                  <td key={action} style={{ ...adminTdStyle, textAlign: 'center' }}>
                    {supported ? (
                      <input type="checkbox" checked={set.has(perm)} disabled={disabled} onChange={() => toggle(perm)} />
                    ) : (
                      <span style={{ color: '#bbb' }}>—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: '#666', lineHeight: 1.45 }}>{t('auth.permCreateRfqHint')}</p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#666', lineHeight: 1.45 }}>{t('auth.permConfidentialHint')}</p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#666', lineHeight: 1.45 }}>{t('auth.permAttachmentsDownloadHint')}</p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#666', lineHeight: 1.45 }}>{t('auth.permCallOffsDownloadHint')}</p>
    </div>
  );
}

type RoleRow = {
  id: number;
  name: string;
  description: string | null;
  is_system: number;
  login_required: number;
  permissions: string[];
};

type RoleSortCol = 'name' | 'description' | 'login';

export default function AdminRoles() {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('role_management.edit');
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [modal, setModal] = useState<'new' | number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loginRequired, setLoginRequired] = useState(true);
  const [perms, setPerms] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterName, setFilterName] = useState('');
  const [filterDescription, setFilterDescription] = useState('');
  const [filterLogin, setFilterLogin] = useState('');
  const { sortCol, sortDir, toggle } = useTableSort<RoleSortCol>('name');

  const load = () => api.adminRoles.list().then(setRoles).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const editingRole = typeof modal === 'number' ? roles.find((r) => r.id === modal) ?? null : null;

  const openNew = () => {
    setName('');
    setDescription('');
    setLoginRequired(true);
    setPerms([]);
    setError(null);
    setModal('new');
  };

  const openEdit = (r: RoleRow) => {
    setName(r.name);
    setDescription(r.description ?? '');
    setLoginRequired(r.login_required !== 0);
    const next = new Set(r.permissions ?? []);
    if (!next.has('admin_attachments.view')) next.delete('admin_attachments.download');
    setPerms([...next].sort());
    setError(null);
    setModal(r.id);
  };

  const closeModal = () => {
    setModal(null);
    setError(null);
  };

  const createRole = async () => {
    if (!canEdit || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.adminRoles.create({
        name: name.trim(),
        description: description.trim() || undefined,
        login_required: loginRequired,
      });
      await api.adminRoles.setPermissions(r.id, perms);
      await load();
      closeModal();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveRole = async () => {
    if (!canEdit || !editingRole) return;
    setSaving(true);
    setError(null);
    try {
      await api.adminRoles.update(editingRole.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        login_required: loginRequired,
      });
      await api.adminRoles.setPermissions(editingRole.id, perms);
      await load();
      closeModal();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async () => {
    if (!canEdit || !editingRole || editingRole.is_system) return;
    if (!window.confirm(t('auth.deleteRoleConfirm', { name: editingRole.name }))) return;
    await api.adminRoles.delete(editingRole.id);
    closeModal();
    await load();
  };

  const displayRoles = useMemo(() => {
    const filtered = roles.filter((r) => {
      const loginLabel = r.login_required === 0 ? t('auth.guestRoleBadge') : t('auth.loginRequired');
      if (filterName.trim() && !r.name.toLowerCase().includes(filterName.trim().toLowerCase())) return false;
      if (filterDescription.trim() && !(r.description ?? '').toLowerCase().includes(filterDescription.trim().toLowerCase())) return false;
      if (filterLogin.trim() && !loginLabel.toLowerCase().includes(filterLogin.trim().toLowerCase())) return false;
      return true;
    });
    return sortRows(filtered, sortCol, sortDir, (r, col) => {
      switch (col) {
        case 'name':
          return r.name;
        case 'description':
          return r.description ?? '';
        case 'login':
          return r.login_required === 0 ? '0' : '1';
        default:
          return '';
      }
    });
  }, [roles, filterName, filterDescription, filterLogin, sortCol, sortDir, t]);

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <Link to="/administracja/uzytkownicy-i-uprawnienia" style={{ color: 'var(--cap-green)' }}>
          {t('common.back', { target: t('layout.usersAndPermissions') })}
        </Link>
      </div>
      <h1 style={{ marginTop: 0 }}>{t('auth.rolesTitle')}</h1>
      <p style={{ color: '#666', marginBottom: '1rem' }}>{t('auth.rolesIntro')}</p>
      {error && !modal && <p style={{ color: 'var(--cap-red)' }}>{error}</p>}

      {canEdit && (
        <div style={{ marginBottom: '1rem' }}>
          <button type="button" onClick={openNew} style={adminBtnPrimary}>
            {t('auth.newRole')}
          </button>
        </div>
      )}

      <table style={adminTableStyle}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <SortableTh label={t('auth.roleName')} active={sortCol === 'name'} direction={sortDir} onClick={() => toggle('name')} />
            <SortableTh label={t('auth.roleDescription')} active={sortCol === 'description'} direction={sortDir} onClick={() => toggle('description')} />
            <SortableTh label={t('auth.loginRequired')} active={sortCol === 'login'} direction={sortDir} onClick={() => toggle('login')} />
            <th style={{ ...adminThStyle, width: 120 }}>{t('commonExtra.actions')}</th>
          </tr>
          <tr style={adminFilterRowStyle}>
            <th style={{ padding: '4px 6px' }}>
              <input
                type="text"
                value={filterName}
                onChange={(e) => setFilterName(e.target.value)}
                placeholder={t('common.filterColumn', { column: t('auth.roleName') })}
                style={adminFilterInputStyle}
              />
            </th>
            <th style={{ padding: '4px 6px' }}>
              <input
                type="text"
                value={filterDescription}
                onChange={(e) => setFilterDescription(e.target.value)}
                placeholder={t('common.filterColumn', { column: t('auth.roleDescription') })}
                style={adminFilterInputStyle}
              />
            </th>
            <th style={{ padding: '4px 6px' }}>
              <input
                type="text"
                value={filterLogin}
                onChange={(e) => setFilterLogin(e.target.value)}
                placeholder={t('common.filterColumn', { column: t('auth.loginRequired') })}
                style={adminFilterInputStyle}
              />
            </th>
            <th style={{ padding: '4px 6px' }} />
          </tr>
        </thead>
        <tbody>
          {displayRoles.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={adminTdStyle}>
                {r.name}
                {r.is_system ? <span style={adminBadgeSystem}>{t('auth.systemRole')}</span> : null}
              </td>
              <td style={{ ...adminTdStyle, color: r.description ? '#333' : '#999' }}>{r.description || t('common.dash')}</td>
              <td style={adminTdStyle}>
                {r.login_required === 0 ? (
                  <span style={adminBadgeGuest}>{t('auth.guestRoleBadge')}</span>
                ) : (
                  t('auth.loginRequired')
                )}
              </td>
              <td style={adminTdStyle}>
                {canEdit ? (
                  <button type="button" onClick={() => openEdit(r)} style={adminBtnEdit}>
                    {t('commonExtra.edit')}
                  </button>
                ) : (
                  t('common.dash')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {roles.length === 0 && <p style={{ color: '#999', marginTop: 8 }}>{t('auth.rolesEmpty')}</p>}

      {modal != null && (
        <AdminModal wide title={modal === 'new' ? t('auth.newRole') : t('auth.editRole')} onClose={closeModal}>
          {error && <p style={{ color: 'var(--cap-red)', marginTop: 0 }}>{error}</p>}
          <label style={{ display: 'block', marginBottom: 12 }}>
            {t('auth.roleName')}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit || Boolean(editingRole?.is_system)}
              style={adminInputStyle}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 12 }}>
            {t('auth.roleDescription')}
            <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} style={adminInputStyle} />
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16, cursor: canEdit ? 'pointer' : 'default' }}>
            <input
              type="checkbox"
              checked={loginRequired}
              onChange={(e) => setLoginRequired(e.target.checked)}
              disabled={!canEdit}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>{t('auth.loginRequired')}</strong>
              <span style={{ display: 'block', fontSize: 12, color: '#666', marginTop: 2 }}>{t('auth.loginRequiredHint')}</span>
            </span>
          </label>
          <PermissionMatrix value={perms} onChange={setPerms} disabled={!canEdit} />
          {canEdit && (
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {editingRole ? (
                <>
                  <button type="button" onClick={saveRole} disabled={saving} style={adminBtnPrimary}>
                    {t('common.save')}
                  </button>
                  {!editingRole.is_system && (
                    <button type="button" onClick={deleteRole} style={adminBtnDanger}>
                      {t('common.delete')}
                    </button>
                  )}
                </>
              ) : (
                <button type="button" onClick={createRole} disabled={saving || !name.trim()} style={adminBtnPrimary}>
                  {t('auth.createRole')}
                </button>
              )}
              <button type="button" onClick={closeModal} style={adminBtnSecondary}>
                {t('common.cancel')}
              </button>
            </div>
          )}
        </AdminModal>
      )}
    </div>
  );
}
