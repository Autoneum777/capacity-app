import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AuthUser } from '../api/client';
import {
  AdminModal,
  adminBtnDanger,
  adminBtnEdit,
  adminBtnNeutral,
  adminBtnPrimary,
  adminBtnSecondary,
  adminFilterInputStyle,
  adminFilterRowStyle,
  adminInputStyle,
  adminStatusActive,
  adminStatusInactive,
  adminTableStyle,
  adminTdStyle,
  adminThStyle,
} from '../components/AdminAuthUi';
import SortableTh from '../components/SortableTh';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { useTableSort, sortRows } from '../utils/tableSort';

type ResetRequest = {
  id: number;
  user_id: number;
  status: string;
  requested_at: string;
  username: string | null;
  email: string | null;
  display_name: string | null;
};

type UserSortCol = 'display' | 'username' | 'email' | 'roles' | 'status';

/** Link resetu zawsze względem originu, z którego korzysta administrator (nie localhost z konfiguracji serwera). */
function toBrowserResetUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl, window.location.origin);
    return `${window.location.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return serverUrl;
  }
}

export default function AdminUsers() {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('user_management.edit');
  const canDelete = hasPermission('user_management.delete');
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [roles, setRoles] = useState<{ id: number; name: string; login_required?: number }[]>([]);
  const [requests, setRequests] = useState<ResetRequest[]>([]);
  const [modal, setModal] = useState<'new' | number | null>(null);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [password, setPassword] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterDisplay, setFilterDisplay] = useState('');
  const [filterUsername, setFilterUsername] = useState('');
  const [filterEmail, setFilterEmail] = useState('');
  const [filterRoles, setFilterRoles] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const { sortCol, sortDir, toggle } = useTableSort<UserSortCol>('display');

  const load = async () => {
    const [u, r, req] = await Promise.all([
      api.adminUsers.list(),
      api.adminRoles.list(),
      api.adminUsers.listResetRequests(),
    ]);
    setUsers(u);
    setRoles(r.filter((x) => x.login_required !== 0).map((x) => ({ id: x.id, name: x.name, login_required: x.login_required })));
    setRequests(req);
  };

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  const editingUser = typeof modal === 'number' ? users.find((u) => u.id === modal) ?? null : null;

  const openNew = () => {
    setUsername('');
    setEmail('');
    setDisplayName('');
    setPassword('');
    setIsActive(true);
    setRoleIds([]);
    setResetLink(null);
    setError(null);
    setModal('new');
    // Przeglądarka czasem wstawia login/hasło po mount — wyczyść jeszcze raz.
    requestAnimationFrame(() => {
      setUsername('');
      setPassword('');
      setEmail('');
      setDisplayName('');
    });
    window.setTimeout(() => {
      setUsername('');
      setPassword('');
      setEmail('');
      setDisplayName('');
    }, 50);
  };

  const openEdit = (u: AuthUser) => {
    setUsername(u.username ?? '');
    setEmail(u.email ?? '');
    setDisplayName(u.display_name ?? '');
    setRoleIds(u.role_ids?.length ? [...u.role_ids] : u.role_id ? [u.role_id] : []);
    setIsActive(u.is_active !== 0);
    setPassword('');
    setResetLink(null);
    setError(null);
    setModal(u.id);
  };

  const closeModal = () => {
    setModal(null);
    setError(null);
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    setResetLink(null);
    try {
      if (modal === 'new') {
        await api.adminUsers.create({
          username: username.trim() || undefined,
          email: email.trim() || undefined,
          display_name: displayName.trim() || undefined,
          role_ids: roleIds,
          password,
        });
        closeModal();
      } else if (editingUser) {
        await api.adminUsers.update(editingUser.id, {
          username: username.trim() || undefined,
          email: email.trim() || undefined,
          display_name: displayName.trim() || undefined,
          role_ids: roleIds,
          is_active: isActive,
        });
        closeModal();
      }
      await load();
    } catch (err: any) {
      setError(err?.message || t('common.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!canDelete || !editingUser) return;
    if (!window.confirm(t('auth.deleteUserConfirm', { name: editingUser.display_name || editingUser.login }))) return;
    await api.adminUsers.delete(editingUser.id);
    closeModal();
    await load();
  };

  const onResetPassword = async () => {
    if (!canEdit || !editingUser) return;
    setError(null);
    try {
      const r = await api.adminUsers.resetPassword(editingUser.id, false);
      setResetLink(toBrowserResetUrl(r.reset_url));
    } catch (err: any) {
      setError(err?.message || t('auth.resetLinkFailed'));
    }
  };

  const onResolveRequest = async (id: number, action: 'approve' | 'reject') => {
    if (!canEdit) return;
    setError(null);
    try {
      const r = await api.adminUsers.resolveResetRequest(id, action, { send_email: false });
      if (r.reset_url) setResetLink(toBrowserResetUrl(r.reset_url));
      await load();
    } catch (err: any) {
      setError(err?.message || t('auth.resetRequestFailed'));
    }
  };

  const copyLink = async () => {
    if (!resetLink) return;
    try {
      await navigator.clipboard.writeText(resetLink);
    } catch {
      /* ignore */
    }
  };

  const displayUsers = useMemo(() => {
    const filtered = users.filter((u) => {
      const rolesLabel = (u.role_names?.length ? u.role_names.join(', ') : u.role_name) || '';
      const statusLabel = u.is_active ? t('common.active') : t('common.inactive');
      const display = u.display_name || u.login || '';
      if (filterDisplay.trim() && !display.toLowerCase().includes(filterDisplay.trim().toLowerCase())) return false;
      if (filterUsername.trim() && !(u.username ?? '').toLowerCase().includes(filterUsername.trim().toLowerCase())) return false;
      if (filterEmail.trim() && !(u.email ?? '').toLowerCase().includes(filterEmail.trim().toLowerCase())) return false;
      if (filterRoles.trim() && !rolesLabel.toLowerCase().includes(filterRoles.trim().toLowerCase())) return false;
      if (filterStatus.trim() && !statusLabel.toLowerCase().includes(filterStatus.trim().toLowerCase())) return false;
      return true;
    });
    return sortRows(filtered, sortCol, sortDir, (u, col) => {
      const rolesLabel = (u.role_names?.length ? u.role_names.join(', ') : u.role_name) || '';
      switch (col) {
        case 'display':
          return u.display_name || u.login || '';
        case 'username':
          return u.username ?? '';
        case 'email':
          return u.email ?? '';
        case 'roles':
          return rolesLabel;
        case 'status':
          return u.is_active ? '0' : '1';
        default:
          return '';
      }
    });
  }, [users, filterDisplay, filterUsername, filterEmail, filterRoles, filterStatus, sortCol, sortDir, t]);

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <Link to="/administracja/uzytkownicy-i-uprawnienia" style={{ color: 'var(--cap-green)' }}>
          {t('common.back', { target: t('layout.usersAndPermissions') })}
        </Link>
      </div>
      <h1 style={{ marginTop: 0 }}>{t('auth.usersTitle')}</h1>
      <p style={{ color: '#666', marginBottom: '1rem' }}>{t('auth.usersIntro')}</p>
      {error && !modal && <p style={{ color: 'var(--cap-red)' }}>{error}</p>}

      {requests.length > 0 && (
        <section style={{ marginBottom: '1.5rem', padding: '1rem', background: '#fff8e1', borderRadius: 8, border: '1px solid #ffe082' }}>
          <h3 style={{ marginTop: 0 }}>{t('auth.resetRequestsTitle')}</h3>
          <table style={adminTableStyle}>
            <thead>
              <tr style={{ background: '#f5f5f5' }}>
                <th style={adminThStyle}>{t('auth.userColumn')}</th>
                <th style={adminThStyle}>{t('auth.requestedAt')}</th>
                {canEdit && <th style={{ ...adminThStyle, width: 220 }}>{t('commonExtra.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={adminTdStyle}>{req.display_name || req.username || req.email}</td>
                  <td style={adminTdStyle}>{new Date(req.requested_at).toLocaleString()}</td>
                  {canEdit && (
                    <td style={adminTdStyle}>
                      <button type="button" onClick={() => void onResolveRequest(req.id, 'approve')} style={{ ...adminBtnEdit, marginRight: 8 }}>
                        {t('auth.approveRequest')}
                      </button>
                      <button type="button" onClick={() => void onResolveRequest(req.id, 'reject')} style={adminBtnNeutral}>
                        {t('auth.rejectRequest')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {resetLink && !modal && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: '#e8f5e9', borderRadius: 6, border: '1px solid #c8e6c9' }}>
          <strong>{t('auth.resetLinkLabel')}</strong>
          <p style={{ wordBreak: 'break-all', fontSize: 13, margin: '0.5rem 0' }}>{resetLink}</p>
          <button type="button" onClick={() => void copyLink()} style={{ ...adminBtnNeutral, marginRight: 8 }}>
            {t('auth.copyResetLink')}
          </button>
          <button type="button" onClick={() => setResetLink(null)} style={adminBtnNeutral}>
            {t('common.close')}
          </button>
        </div>
      )}

      {canEdit && (
        <div style={{ marginBottom: '1rem' }}>
          <button type="button" onClick={openNew} style={adminBtnPrimary}>
            {t('auth.newUser')}
          </button>
        </div>
      )}

      <table style={adminTableStyle}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <SortableTh label={t('auth.displayNameField')} active={sortCol === 'display'} direction={sortDir} onClick={() => toggle('display')} />
            <SortableTh label={t('auth.usernameField')} active={sortCol === 'username'} direction={sortDir} onClick={() => toggle('username')} />
            <SortableTh label={t('auth.emailField')} active={sortCol === 'email'} direction={sortDir} onClick={() => toggle('email')} />
            <SortableTh label={t('auth.rolesField')} active={sortCol === 'roles'} direction={sortDir} onClick={() => toggle('roles')} />
            <SortableTh label={t('auth.userActive')} active={sortCol === 'status'} direction={sortDir} onClick={() => toggle('status')} />
            <th style={{ ...adminThStyle, width: 120 }}>{t('commonExtra.actions')}</th>
          </tr>
          <tr style={adminFilterRowStyle}>
            <th style={{ padding: '4px 6px' }}>
              <input type="text" value={filterDisplay} onChange={(e) => setFilterDisplay(e.target.value)} placeholder={t('common.filterColumn', { column: t('auth.displayNameField') })} style={adminFilterInputStyle} />
            </th>
            <th style={{ padding: '4px 6px' }}>
              <input type="text" value={filterUsername} onChange={(e) => setFilterUsername(e.target.value)} placeholder={t('common.filterColumn', { column: t('auth.usernameField') })} style={adminFilterInputStyle} />
            </th>
            <th style={{ padding: '4px 6px' }}>
              <input type="text" value={filterEmail} onChange={(e) => setFilterEmail(e.target.value)} placeholder={t('common.filterColumn', { column: t('auth.emailField') })} style={adminFilterInputStyle} />
            </th>
            <th style={{ padding: '4px 6px' }}>
              <input type="text" value={filterRoles} onChange={(e) => setFilterRoles(e.target.value)} placeholder={t('common.filterColumn', { column: t('auth.rolesField') })} style={adminFilterInputStyle} />
            </th>
            <th style={{ padding: '4px 6px' }}>
              <input type="text" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} placeholder={t('common.filterColumn', { column: t('auth.userActive') })} style={adminFilterInputStyle} />
            </th>
            <th style={{ padding: '4px 6px' }} />
          </tr>
        </thead>
        <tbody>
          {displayUsers.map((u) => {
            const rolesLabel = (u.role_names?.length ? u.role_names.join(', ') : u.role_name) || t('common.dash');
            return (
              <tr key={u.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={adminTdStyle}>{u.display_name || u.login}</td>
                <td style={adminTdStyle}>{u.username || t('common.dash')}</td>
                <td style={adminTdStyle}>{u.email || t('common.dash')}</td>
                <td style={adminTdStyle}>{rolesLabel}</td>
                <td style={adminTdStyle}>
                  <span style={u.is_active ? adminStatusActive : adminStatusInactive}>
                    {u.is_active ? t('common.active') : t('common.inactive')}
                  </span>
                </td>
                <td style={adminTdStyle}>
                  {canEdit ? (
                    <button type="button" onClick={() => openEdit(u)} style={adminBtnEdit}>
                      {t('commonExtra.edit')}
                    </button>
                  ) : (
                    t('common.dash')
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {users.length === 0 && <p style={{ color: '#999', marginTop: 8 }}>{t('auth.usersEmpty')}</p>}

      {modal != null && (
        <AdminModal title={modal === 'new' ? t('auth.newUser') : t('auth.editUser')} onClose={closeModal}>
          <form autoComplete="off" onSubmit={onSave}>
            {error && <p style={{ color: 'var(--cap-red)', marginTop: 0 }}>{error}</p>}
            {modal === 'new' && (
              <div aria-hidden style={{ position: 'absolute', left: -10000, top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
                <input type="text" name="fake-username" autoComplete="username" tabIndex={-1} defaultValue="" />
                <input type="password" name="fake-password" autoComplete="current-password" tabIndex={-1} defaultValue="" />
              </div>
            )}
            <label style={{ display: 'block', marginBottom: 12 }}>
              {t('auth.displayNameField')}
              <input
                name="capacity_display_name"
                autoComplete="off"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={!canEdit}
                style={adminInputStyle}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 12 }}>
              {t('auth.usernameField')}
              <input
                name="capacity_new_username"
                autoComplete={modal === 'new' ? 'off' : 'username'}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={!canEdit}
                style={adminInputStyle}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 12 }}>
              {t('auth.emailField')}
              <input
                type="email"
                name="capacity_email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!canEdit}
                style={adminInputStyle}
              />
            </label>
            <fieldset style={{ border: '1px solid #e0e0e0', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
              <legend style={{ padding: '0 4px', fontSize: 13, fontWeight: 600 }}>{t('auth.rolesField')}</legend>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#666' }}>{t('auth.rolesFieldHint')}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {roles.map((r) => (
                  <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={roleIds.includes(r.id)}
                      disabled={!canEdit}
                      onChange={(e) => {
                        setRoleIds((prev) => {
                          if (e.target.checked) return [...prev, r.id].sort((a, b) => a - b);
                          return prev.filter((id) => id !== r.id);
                        });
                      }}
                    />
                    {r.name}
                  </label>
                ))}
              </div>
            </fieldset>
            {modal === 'new' && (
              <label style={{ display: 'block', marginBottom: 12 }}>
                {t('auth.initialPasswordField')}
                <input
                  type="password"
                  name="capacity_new_password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={!canEdit}
                  style={adminInputStyle}
                />
              </label>
            )}
            {editingUser && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={!canEdit} />
                {t('auth.userActive')}
              </label>
            )}
            {resetLink && (
              <div style={{ marginBottom: 12, padding: '0.75rem', background: '#e8f5e9', borderRadius: 6, fontSize: 13 }}>
                <strong>{t('auth.resetLinkLabel')}</strong>
                <p style={{ wordBreak: 'break-all', margin: '0.5rem 0' }}>{resetLink}</p>
                <button type="button" onClick={() => void copyLink()} style={adminBtnNeutral}>
                  {t('auth.copyResetLink')}
                </button>
              </div>
            )}
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
                <button type="submit" disabled={saving} style={adminBtnPrimary}>
                  {t('common.save')}
                </button>
                {editingUser && (
                  <>
                    <button type="button" onClick={() => void onResetPassword()} style={adminBtnNeutral}>
                      {t('auth.generateResetLink')}
                    </button>
                    {canDelete && (
                      <button type="button" onClick={() => void onDelete()} style={adminBtnDanger}>
                        {t('common.delete')}
                      </button>
                    )}
                  </>
                )}
                <button type="button" onClick={closeModal} style={adminBtnSecondary}>
                  {t('common.cancel')}
                </button>
              </div>
            )}
          </form>
        </AdminModal>
      )}
    </div>
  );
}
