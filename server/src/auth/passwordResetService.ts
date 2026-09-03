import { db } from '../db/connection.js';
import { generateSecureToken, hashToken } from '../auth/session.js';

const DEFAULT_TTL_HOURS = Number(process.env.PASSWORD_RESET_TTL_HOURS ?? 24);

export type AppBaseUrlRequest = {
  get: (name: string) => string | undefined;
  protocol?: string;
};

export function resetTokenExpiresAt(): string {
  const d = new Date();
  d.setHours(d.getHours() + DEFAULT_TTL_HOURS);
  return d.toISOString();
}

export function createPasswordResetToken(
  userId: number,
  via: 'email' | 'admin_link' | 'request',
  createdByUserId?: number
): { token: string; expiresAt: string } {
  const token = generateSecureToken();
  const tokenHash = hashToken(token);
  const expiresAt = resetTokenExpiresAt();
  db.prepare(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_by_user_id, via) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, tokenHash, expiresAt, createdByUserId ?? null, via);
  return { token, expiresAt };
}

export function consumePasswordResetToken(token: string): number | null {
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
    )
    .get(tokenHash) as { id: number; user_id: number } | undefined;
  if (!row) return null;
  db.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  return Number(row.user_id);
}

export function createPasswordResetRequest(userId: number): number {
  const r = db
    .prepare(`INSERT INTO password_reset_requests (user_id, status) VALUES (?, 'pending')`)
    .run(userId);
  return Number(r.lastInsertRowid);
}

function normalizeBaseUrl(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
}

export function isLoopbackBaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url);
  }
}

/** Jawna konfiguracja (admin_settings / ENV). Ignoruje puste. */
export function getConfiguredAppBaseUrl(): string | null {
  const row = db.prepare(`SELECT value FROM admin_settings WHERE key = 'app_base_url'`).get() as
    | { value?: string }
    | undefined;
  const fromDb = normalizeBaseUrl(String(row?.value ?? ''));
  const fromEnv = normalizeBaseUrl(String(process.env.APP_BASE_URL ?? ''));
  // Migracja 059 wstawia localhost:3001 — nie wolno tego preferować nad sensownym ENV.
  if (fromEnv && !isLoopbackBaseUrl(fromEnv)) return fromEnv;
  if (fromDb && !isLoopbackBaseUrl(fromDb)) return fromDb;
  if (fromEnv) return fromEnv;
  if (fromDb) return fromDb;
  return null;
}

/** Publiczny URL z nagłówków przeglądarki / proxy (Origin, Referer, X-Forwarded-*). */
export function baseUrlFromRequest(req: AppBaseUrlRequest): string | null {
  const origin = String(req.get('origin') ?? '').trim();
  if (origin && /^https?:\/\//i.test(origin)) return normalizeBaseUrl(origin);

  const referer = String(req.get('referer') ?? '').trim();
  if (referer) {
    try {
      const u = new URL(referer);
      return normalizeBaseUrl(`${u.protocol}//${u.host}`);
    } catch {
      /* ignore */
    }
  }

  const xfHost = String(req.get('x-forwarded-host') ?? '')
    .split(',')[0]
    .trim();
  if (xfHost) {
    const xfProto =
      String(req.get('x-forwarded-proto') ?? 'https')
        .split(',')[0]
        .trim() || 'https';
    return normalizeBaseUrl(`${xfProto}://${xfHost}`);
  }

  const host = String(req.get('host') ?? '').trim();
  if (host) {
    const proto =
      String(req.get('x-forwarded-proto') ?? '')
        .split(',')[0]
        .trim() || (req.protocol === 'https' ? 'https' : 'http');
    return normalizeBaseUrl(`${proto}://${host}`);
  }
  return null;
}

/**
 * Publiczny bazowy URL aplikacji do linków resetu hasła.
 * Priorytet: nie-loopback config → URL z requestu → config (nawet localhost) → fallback.
 */
export function resolvePublicAppBaseUrl(req?: AppBaseUrlRequest | null): string {
  const configured = getConfiguredAppBaseUrl();
  const fromReq = req ? baseUrlFromRequest(req) : null;

  if (fromReq && (!configured || isLoopbackBaseUrl(configured))) return fromReq;
  if (configured && !isLoopbackBaseUrl(configured)) return configured;
  if (fromReq) return fromReq;
  if (configured) return configured;
  return 'http://localhost:5173';
}

/** @deprecated Użyj resolvePublicAppBaseUrl(req) — bez req może zostać localhost z migracji. */
export function getAppBaseUrl(): string {
  return resolvePublicAppBaseUrl(null);
}

export function buildResetPasswordUrl(token: string, req?: AppBaseUrlRequest | null): string {
  return `${resolvePublicAppBaseUrl(req)}/reset-hasla?token=${encodeURIComponent(token)}`;
}
