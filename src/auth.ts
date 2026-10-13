import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { COOKIE_SECURE, PANEL_PASSWORD, PANEL_USER, SESSION_COOKIE, SESSION_TTL_MS } from './config.js';
import { get, run } from './db.js';

/**
 * Panel authentication.
 *
 * Two mechanisms are accepted so both the browser UI and scripted clients work:
 *  - a session cookie (what the login page issues)
 *  - HTTP Basic, so `curl -u admin:pw ...` keeps working
 *
 * Credentials come from FRP_CONSOLE_USER / FRP_CONSOLE_PASSWORD.
 *
 * Sessions live in SQLite so they survive panel restarts, and only the token
 * hash is persisted: a database leak cannot be replayed as a live session.
 */

interface Session {
  token: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Hash first so inputs of different length still take the same path.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function verifyCredentials(username: string, password: string): boolean {
  // Evaluate both comparisons so a wrong username and a wrong password cost the same.
  const userOk = safeEqual(username, PANEL_USER);
  const passOk = safeEqual(password, PANEL_PASSWORD);
  return userOk && passOk;
}

/** Delete expired rows. Cheap thanks to idx_sessions_expires. */
export function sweepExpiredSessions(now = Date.now()): number {
  const res = run('DELETE FROM sessions WHERE expires_at <= ?', now);
  return res.changes;
}

/**
 * 登录尝试速率限制（内存态，按 IP + 用户名双维度）。
 *
 * 目的：拖慢对口令的暴力破解。窗口期内超过上限后锁定一段时间。
 * 内存实现即可满足单机面板的规模；重启即重置，不影响可用性。
 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 分钟滑动窗口
const LOGIN_MAX_ATTEMPTS = 10; // 窗口内最多 10 次失败
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 触发后锁定 15 分钟

interface LoginAttempt { times: number[]; lockedUntil: number }
const loginAttempts = new Map<string, LoginAttempt>();

function loginKey(ip: string, username: string): string {
  return `${ip}|${username}`;
}

export function isLoginLocked(ip: string, username: string, now = Date.now()): number {
  const rec = loginAttempts.get(loginKey(ip, username));
  if (!rec) return 0;
  if (rec.lockedUntil > now) return Math.ceil((rec.lockedUntil - now) / 1000);
  return 0;
}

export function recordLoginFailure(ip: string, username: string, now = Date.now()): void {
  const key = loginKey(ip, username);
  const rec = loginAttempts.get(key) ?? { times: [], lockedUntil: 0 };
  rec.times = rec.times.filter((t) => now - t < LOGIN_WINDOW_MS);
  rec.times.push(now);
  if (rec.times.length >= LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
    rec.times = [];
  }
  loginAttempts.set(key, rec);

  // 顺手清理过期条目，避免 map 无限增长
  if (loginAttempts.size > 10_000) {
    for (const [k, r] of loginAttempts) {
      if (r.lockedUntil <= now && (r.times.length === 0 || now - r.times[r.times.length - 1]! > LOGIN_WINDOW_MS)) {
        loginAttempts.delete(k);
      }
    }
  }
}

export function clearLoginFailures(ip: string, username: string): void {
  loginAttempts.delete(loginKey(ip, username));
}

export function createSession(
  username: string,
  meta: { userAgent?: string; remoteIp?: string } = {},
): Session {
  const now = Date.now();
  sweepExpiredSessions(now);
  const session: Session = {
    token: crypto.randomBytes(32).toString('base64url'),
    username,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  run(
    'INSERT INTO sessions (token_hash, username, created_at, expires_at, user_agent, remote_ip) VALUES (?,?,?,?,?,?)',
    hashToken(session.token),
    username,
    session.createdAt,
    session.expiresAt,
    (meta.userAgent ?? '').slice(0, 300),
    (meta.remoteIp ?? '').slice(0, 64),
  );
  return session;
}

export function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  const row = get<{ username: string; created_at: number; expires_at: number }>(
    'SELECT username, created_at, expires_at FROM sessions WHERE token_hash = ?',
    hashToken(token),
  );
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
    return null;
  }
  return {
    token,
    username: row.username,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function destroySession(token: string | undefined): void {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
}

export function setSessionCookie(reply: FastifyReply, session: Session): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${SESSION_COOKIE}=${session.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** True when the request carries a valid session cookie or Basic credentials. */
export function isAuthenticated(req: FastifyRequest): { ok: boolean; username?: string; via?: 'cookie' | 'basic' } {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE]);
  if (session) return { ok: true, username: session.username, via: 'cookie' };

  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return { ok: false };
    }
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    if (verifyCredentials(user, pass)) return { ok: true, username: user, via: 'basic' };
  }
  return { ok: false };
}

export function currentUsername(req: FastifyRequest): string {
  return isAuthenticated(req).username ?? '';
}
