import { Router } from 'express';
import { db } from '../db/connection.js';
import { ALL_PERMISSION_KEYS, isValidPermissionKey } from '../auth/permissions.js';
import { hashPassword, validatePasswordStrength } from '../auth/password.js';
import {
  getPermissionsForRole,
  setRolePermissions,
  setUserRoles,
  userLoginLabel,
} from '../auth/userService.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { issuePasswordResetForUser } from './auth.js';

export const usersAdminRouter = Router();
usersAdminRouter.use(requireAuth);

function parseRoleIds(body: any, fallback?: number): number[] {
  if (Array.isArray(body?.role_ids)) {
    const raw = body.role_ids as unknown[];
    const ids = raw.map((x) => Number(x)).filter((id): id is number => Number.isFinite(id) && id > 0);
    return [...new Set(ids)];
  }
  if (body?.role_id != null) {
    const id = Number(body.role_id);
    return Number.isFinite(id) && id > 0 ? [id] : [];
  }
  return fallback != null && fallback > 0 ? [fallback] : [];
}

function filterAssignableRoleIds(roleIds: number[]): number[] {
  if (roleIds.length === 0) return [];
  const placeholders = roleIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM roles WHERE id IN (${placeholders}) AND login_required = 1`)
    .all(...roleIds) as { id: number }[];
  const allowed = new Set(rows.map((r) => r.id));
  return roleIds.filter((id) => allowed.has(id));
}

function mapUserRow(row: any) {
  const roleRows = db
    .prepare(
      `SELECT r.id, r.name
       FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?
       ORDER BY r.name`
    )
    .all(row.id) as { id: number; name: string }[];
  const role_ids = roleRows.map((r) => r.id);
  const role_names = roleRows.map((r) => r.name);
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    role_id: role_ids[0] ?? row.role_id,
    role_name: role_names.length > 0 ? role_names.join(', ') : row.role_name,
    role_ids,
    role_names,
    is_active: row.is_active,
    must_change_password: row.must_change_password,
    is_guest: 0,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    login: userLoginLabel(row),
  };
}

usersAdminRouter.get('/', requirePermission('user_management.view'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY COALESCE(u.display_name, u.username, u.email)`
    )
    .all() as any[];
  res.json(rows.map(mapUserRow));
});

usersAdminRouter.post('/', requirePermission('user_management.edit'), async (req, res) => {
  try {
    const username = req.body?.username != null ? String(req.body.username).trim() || null : null;
    const email = req.body?.email != null ? String(req.body.email).trim().toLowerCase() || null : null;
    const display_name = req.body?.display_name != null ? String(req.body.display_name).trim() || null : null;
    const role_ids = filterAssignableRoleIds(parseRoleIds(req.body));
    const password = String(req.body?.password ?? '');
    if (!username && !email) return res.status(400).json({ error: 'Podaj nazwę użytkownika lub e-mail' });
    if (role_ids.length === 0) return res.status(400).json({ error: 'Wybierz co najmniej jedną rolę' });
    const pwdErr = validatePasswordStrength(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });
    const password_hash = await hashPassword(password);
    const r = db
      .prepare(
        `INSERT INTO users (username, email, password_hash, display_name, role_id, is_active, must_change_password)
         VALUES (?, ?, ?, ?, ?, 1, 1)`
      )
      .run(username, email, password_hash, display_name, role_ids[0]);
    const userId = Number(r.lastInsertRowid);
    setUserRoles(userId, role_ids);
    const row = db
      .prepare(`SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`)
      .get(userId) as any;
    res.status(201).json(mapUserRow(row));
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) return res.status(400).json({ error: 'Użytkownik o takim loginie lub e-mailu już istnieje' });
    res.status(500).json({ error: e?.message || 'Błąd tworzenia użytkownika' });
  }
});

usersAdminRouter.put('/:id', requirePermission('user_management.edit'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const username = req.body?.username !== undefined ? String(req.body.username).trim() || null : existing.username;
    const email = req.body?.email !== undefined ? String(req.body.email).trim().toLowerCase() || null : existing.email;
    const display_name =
      req.body?.display_name !== undefined ? String(req.body.display_name).trim() || null : existing.display_name;
    const is_active = req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active;
    if (!username && !email) return res.status(400).json({ error: 'Podaj nazwę użytkownika lub e-mail' });
    const role_ids = filterAssignableRoleIds(
      req.body?.role_ids !== undefined || req.body?.role_id !== undefined
        ? parseRoleIds(req.body, existing.role_id)
        : parseRoleIds({}, existing.role_id)
    );
    if (role_ids.length === 0) return res.status(400).json({ error: 'Wybierz co najmniej jedną rolę' });
    db.prepare(
      `UPDATE users SET username = ?, email = ?, display_name = ?, role_id = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(username, email, display_name, role_ids[0], is_active, id);
    setUserRoles(id, role_ids);
    const row = db
      .prepare(`SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`)
      .get(id) as any;
    res.json(mapUserRow(row));
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) return res.status(400).json({ error: 'Użytkownik o takim loginie lub e-mailu już istnieje' });
    res.status(500).json({ error: e?.message || 'Błąd zapisu użytkownika' });
  }
});

usersAdminRouter.delete('/:id', requirePermission('user_management.delete'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return res.status(400).json({ error: 'Nie możesz usunąć własnego konta' });
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

usersAdminRouter.post('/:id/reset-password', requirePermission('user_management.edit'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sendEmail = req.body?.send_email === true;
    const result = await issuePasswordResetForUser(id, req.user!.id, sendEmail ? 'email' : 'admin_link', req);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd generowania linku resetu' });
  }
});

usersAdminRouter.get('/password-reset-requests', requirePermission('user_management.view'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT pr.id, pr.user_id, pr.status, pr.requested_at, pr.resolved_at, pr.note,
              u.username, u.email, u.display_name,
              ru.display_name AS resolved_by_name
       FROM password_reset_requests pr
       INNER JOIN users u ON u.id = pr.user_id
       LEFT JOIN users ru ON ru.id = pr.resolved_by_user_id
       WHERE pr.status = 'pending'
       ORDER BY pr.requested_at ASC`
    )
    .all();
  res.json(rows);
});

usersAdminRouter.patch('/password-reset-requests/:id', requirePermission('user_management.edit'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const action = String(req.body?.action ?? '').trim();
    const row = db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(id) as any;
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'Not found' });

    if (action === 'reject') {
      db.prepare(
        `UPDATE password_reset_requests SET status = 'rejected', resolved_at = datetime('now'), resolved_by_user_id = ?, note = ? WHERE id = ?`
      ).run(req.user!.id, String(req.body?.note ?? '').trim() || null, id);
      return res.json({ ok: true, status: 'rejected' });
    }
    if (action === 'approve') {
      const sendEmail = req.body?.send_email === true;
      const result = await issuePasswordResetForUser(Number(row.user_id), req.user!.id, sendEmail ? 'email' : 'request', req);
      db.prepare(
        `UPDATE password_reset_requests SET status = 'approved', resolved_at = datetime('now'), resolved_by_user_id = ? WHERE id = ?`
      ).run(req.user!.id, id);
      return res.json({ ok: true, status: 'approved', ...result });
    }
    return res.status(400).json({ error: 'Nieprawidłowa akcja' });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd obsługi żądania' });
  }
});

export const rolesAdminRouter = Router();
rolesAdminRouter.use(requireAuth);

rolesAdminRouter.get('/', requirePermission('role_management.view'), (_req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY name').all() as any[];
  const out = roles.map((r) => ({
    ...r,
    login_required: r.login_required == null ? 1 : Number(r.login_required),
    permissions: getPermissionsForRole(r.id),
  }));
  res.json(out);
});

rolesAdminRouter.get('/permissions-catalog', requirePermission('role_management.view'), (_req, res) => {
  res.json({ permissions: ALL_PERMISSION_KEYS });
});

rolesAdminRouter.post('/', requirePermission('role_management.edit'), (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    const description = req.body?.description != null ? String(req.body.description).trim() : null;
    const login_required = req.body?.login_required === false || req.body?.login_required === 0 ? 0 : 1;
    if (!name) return res.status(400).json({ error: 'Nazwa roli jest wymagana' });
    const r = db
      .prepare(`INSERT INTO roles (name, description, is_system, login_required) VALUES (?, ?, 0, ?)`)
      .run(name, description, login_required);
    const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(r.lastInsertRowid) as any;
    res.status(201).json({ ...row, login_required: Number(row.login_required ?? 1), permissions: [] });
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) return res.status(400).json({ error: 'Rola o takiej nazwie już istnieje' });
    res.status(500).json({ error: e?.message || 'Błąd tworzenia roli' });
  }
});

rolesAdminRouter.put('/:id', requirePermission('role_management.edit'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const description = req.body?.description !== undefined ? String(req.body.description).trim() : existing.description;
    const login_required =
      req.body?.login_required !== undefined
        ? req.body.login_required === false || req.body.login_required === 0
          ? 0
          : 1
        : Number(existing.login_required ?? 1);
    db.prepare(`UPDATE roles SET name = ?, description = ?, login_required = ?, updated_at = datetime('now') WHERE id = ?`).run(
      name,
      description,
      login_required,
      id
    );
    const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
    res.json({ ...row, login_required: Number(row.login_required ?? 1), permissions: getPermissionsForRole(id) });
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) return res.status(400).json({ error: 'Rola o takiej nazwie już istnieje' });
    res.status(500).json({ error: e?.message || 'Błąd zapisu roli' });
  }
});

rolesAdminRouter.put('/:id/permissions', requirePermission('role_management.edit'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const keys = Array.isArray(req.body?.permissions) ? req.body.permissions.map((k: unknown) => String(k)) : [];
  const filtered = keys.filter((k: string) => isValidPermissionKey(k));
  setRolePermissions(id, filtered);
  res.json({ id, permissions: filtered });
});

rolesAdminRouter.delete('/:id', requirePermission('role_management.delete'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.is_system) return res.status(400).json({ error: 'Nie można usunąć roli systemowej' });
  const used = db.prepare('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?').get(id) as { c: number };
  if (Number(used.c) > 0) return res.status(400).json({ error: 'Rola jest przypisana do użytkowników' });
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  res.status(204).send();
});
