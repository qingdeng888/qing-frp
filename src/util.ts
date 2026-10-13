import crypto from 'node:crypto';

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** URL-safe short id used in install URLs. */
export function shortId(len = 12): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function asBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
  return fallback;
}

/** Turn a free-form label into a safe frp proxy name. */
export function slugifyProxyName(input: string): string {
  const s = String(input ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || `proxy-${shortId(6)}`;
}

export function isValidProxyName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name);
}

export function toList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  return arr.map((v) => String(v).trim()).filter((v) => v !== '');
}

export function toOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function toOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
