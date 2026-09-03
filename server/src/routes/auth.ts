import { Router } from 'express';
import { db } from '../db/connection.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../auth/password.js';
import {
  buildResetPasswordUrl,
  consumePasswordResetToken,
  createPasswordResetRequest,
  createPasswordResetToken,
} from '../auth/passwordResetService.js';
import {
  clearSessionCookie,
  createGuestSession,
  createSession,
  hashToken,
  parseCookies,
  revokeAllUserSessions,
  revokeSession,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from '../auth/session.js';
import {
  findUserByLogin,
  getGuestPermissions,
  getPermissionsForUser,
  getUserById,
  guestUserDto,
  isGuestLoginAvailable,
  listAdministratorContacts,
  userLoginLabel,
} from '../auth/userService.js';
import { requireAuth } from '../middleware/auth.js';
import { isSmtpReady, sendPasswordResetEmail } from '../services/emailService.js';

export const authRouter = Router();

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, max = 10, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

function publicUserDto(user: ReturnType<typeof getUserById> | ReturnType<typeof guestUserDto>) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    role_id: user.role_id,
    role_name: user.role_name,
    role_ids: user.role_ids,
    role_names: user.role_names,
    is_active: user.is_active,
    must_change_password: user.must_change_password,
    is_guest: user.is_guest ?? 0,
    login: userLoginLabel(user),
  };
}

authRouter.get('/guest-available', (_req, res) => {
  res.json({ available: isGuestLoginAvailable() });
});

authRouter.get('/admin-contacts', (_req, res) => {
  const contacts = listAdministratorContacts().map((c) => ({
    display_name: c.display_name,
    email: c.email,
    username: c.username,
    label: c.label,
    contact: c.contact,
  }));
  res.json({ contacts });
});

authRouter.post('/guest', (req, res) => {
  try {
    if (!isGuestLoginAvailable()) {
      return res.status(403).json({ error: 'Wejście jako gość jest wyłączone' });
    }
    const ip = String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const token = createGuestSession(ip, String(req.headers['user-agent'] ?? ''));
    setSessionCookie(res, token);
    const permissions = getGuestPermissions();
    res.json({ user: publicUserDto(guestUserDto()), permissions });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd logowania gościa' });
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const ip = String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    if (!checkRateLimit(`login:${ip}`)) {
      return res.status(429).json({ error: 'Zbyt wiele prób logowania. Spróbuj później.' });
    }
    const user = findUserByLogin(login);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Nieprawidłowy login lub hasło' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło' });

    const token = createSession(user.id, ip, String(req.headers['user-agent'] ?? ''));
    db.prepare(`UPDATE users SET last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(user.id);
    setSessionCookie(res, token);
    const permissions = getPermissionsForUser(user.id);
    res.json({ user: publicUserDto(getUserById(user.id)), permissions });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd logowania' });
  }
});

authRouter.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) revokeSession(token);
  clearSessionCookie(res);
  res.status(204).send();
});

authRouter.get('/me', requireAuth, (req, res) => {
  if (req.user?.is_guest) {
    return res.json({ user: publicUserDto(guestUserDto()), permissions: req.user.permissions });
  }
  const user = getUserById(req.user!.id);
  if (!user) return res.status(401).json({ error: 'Użytkownik nie istnieje' });
  res.json({ user: publicUserDto(user), permissions: req.user!.permissions });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  try {
    if (req.user?.is_guest) return res.status(403).json({ error: 'Konto gościa nie może zmieniać hasła' });
    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');
    const err = validatePasswordStrength(next);
    if (err) return res.status(400).json({ error: err });

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
    const ok = await verifyPassword(current, row.password_hash);
    if (!ok) return res.status(400).json({ error: 'Aktualne hasło jest nieprawidłowe' });

    const passwordHash = await hashPassword(next);
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(passwordHash, req.user!.id);

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const exceptHash = token ? hashToken(token) : undefined;
    revokeAllUserSessions(req.user!.id, exceptHash);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd zmiany hasła' });
  }
});

authRouter.post('/forgot-password', async (req, res) => {
  try {
    const login = String(req.body?.login ?? '').trim();
    const ip = String(req.ip ?? 'unknown');
    if (!checkRateLimit(`forgot:${ip}`)) {
      return res.status(429).json({ error: 'Zbyt wiele prób. Spróbuj później.' });
    }
    const user = findUserByLogin(login);
    if (!user) {
      return res.json({ ok: true, message: 'Jeśli konto istnieje, zgłoszenie zostało przyjęte.' });
    }
    createPasswordResetRequest(user.id);
    res.json({ ok: true, message: 'Jeśli konto istnieje, zgłoszenie zostało przyjęte.' });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd żądania resetu' });
  }
});

authRouter.post('/reset-password', async (req, res) => {
  try {
    const token = String(req.body?.token ?? '').trim();
    const password = String(req.body?.password ?? '');
    const err = validatePasswordStrength(password);
    if (err) return res.status(400).json({ error: err });
    const userId = consumePasswordResetToken(token);
    if (!userId) return res.status(400).json({ error: 'Link resetu jest nieprawidłowy lub wygasł' });
    const passwordHash = await hashPassword(password);
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(passwordHash, userId);
    revokeAllUserSessions(userId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd resetu hasła' });
  }
});

export async function issuePasswordResetForUser(
  userId: number,
  createdByUserId: number | null,
  via: 'email' | 'admin_link' | 'request',
  req?: { get: (name: string) => string | undefined; protocol?: string } | null
): Promise<{ reset_url: string; email_sent: boolean }> {
  const user = getUserById(userId);
  if (!user) throw new Error('Użytkownik nie istnieje');
  const { token } = createPasswordResetToken(userId, via, createdByUserId ?? undefined);
  const reset_url = buildResetPasswordUrl(token, req);
  let email_sent = false;
  if (via === 'email' || isSmtpReady()) {
    const to = user.email;
    if (to && isSmtpReady()) {
      await sendPasswordResetEmail(to, reset_url);
      email_sent = true;
    }
  }
  return { reset_url, email_sent };
}
