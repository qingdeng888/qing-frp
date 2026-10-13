import os from 'node:os';

/**
 * Resolve the panel's own public base URL.
 *
 * Generated install scripts embed this URL so the target node can call back for
 * heartbeats and `--refresh`. Auto-detection can only ever guess the LAN
 * address, which is useless for a node outside that network, so an explicit
 * setting always wins:
 *
 *   1. operator setting saved in the database
 *   2. FRP_CONSOLE_PUBLIC_URL environment variable
 *   3. auto-detected LAN address (best effort, clearly flagged as a guess)
 */

export interface PanelUrlSource {
  url: string;
  source: 'setting' | 'env' | 'auto';
  /** True when this URL is a guess that will likely not work off-LAN. */
  isGuess: boolean;
}

/** Turn user input into a bare origin like http://host:port (no trailing slash). */
export function normalizeBaseUrl(input: unknown): string {
  let s = String(input ?? '').trim();
  if (!s) return '';
  // Accept "example.com", "example.com:8080", "http://example.com/".
  if (!/^https?:\/\//i.test(s)) {
    // A bare host with a port, or with a path, is assumed https unless the port
    // looks like a plain HTTP dev port.
    const hasHttpPort = /:(80|8080|3000|8000|5000|26000|37000)\b/.test(s);
    s = `${hasHttpPort ? 'http' : 'https'}://${s}`;
  }
  s = s.replace(/\/+$/, '');
  try {
    const u = new URL(s);
    // Keep only the origin plus an optional path prefix (reverse-proxy setups).
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '';
  }
}

export function isValidBaseUrl(input: unknown): boolean {
  const v = String(input ?? '').trim();
  if (!v) return true; // empty = auto

  // A scheme-looking prefix must be a real http(s) scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https?:\/\//i.test(v)) return false;

  const normalized = normalizeBaseUrl(v);
  if (!normalized) return false;

  // Reject anything with whitespace or characters a host cannot contain.
  if (/\s/.test(v)) return false;
  try {
    const u = new URL(normalized);
    if (!u.hostname) return false;
    // Hostname must look like a domain, IPv4, or bracketed IPv6.
    if (!/^[A-Za-z0-9.-]+$/.test(u.hostname) && !u.hostname.startsWith('[')) return false;
    return true;
  } catch {
    return false;
  }
}

/** First non-internal IPv4 address, or 127.0.0.1 when there is none. */
export function detectLanAddress(): string {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch {
    /* ignore */
  }
  return '127.0.0.1';
}

/** All non-internal IPv4 addresses, for showing the operator their options. */
export function listLocalAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) out.push(net.address);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Resolve the effective panel URL.
 *
 * `requestHost` (the Host header of the current request) is used as a smarter
 * auto-detect when the operator has not configured anything: if someone reached
 * the panel via a public address, that address is almost certainly the right one
 * to put in the install command.
 */
export function resolvePanelUrl(opts: {
  setting?: string | null;
  envValue?: string | null;
  port: number;
  requestHost?: string | null;
}): PanelUrlSource {
  const fromSetting = normalizeBaseUrl(opts.setting);
  if (fromSetting) return { url: fromSetting, source: 'setting', isGuess: false };

  const fromEnv = normalizeBaseUrl(opts.envValue);
  if (fromEnv) return { url: fromEnv, source: 'env', isGuess: false };

  // Prefer the host the browser actually used, when it is not a LAN address.
  // The Host header already carries the port when it is non-default, so we must
  // not append PANEL_PORT here: a bare host means the client used port 80/443.
  const reqHost = String(opts.requestHost ?? '').trim();
  if (reqHost) {
    const explicitProto = /^https?:\/\//i.test(reqHost) ? reqHost.slice(0, reqHost.indexOf(':')).toLowerCase() : '';
    const bare = reqHost.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const hostOnly = bare.split(':')[0];
    const isLan = isPrivateAddress(hostOnly);
    if (!isLan && hostOnly !== 'localhost') {
      const proto = explicitProto || (bare.endsWith(':443') ? 'https' : 'http');
      return { url: `${proto}://${bare}`, source: 'auto', isGuess: false };
    }
  }

  return { url: `http://${detectLanAddress()}:${opts.port}`, source: 'auto', isGuess: true };
}

/** RFC1918 / loopback / link-local detection. */
export function isPrivateAddress(host: string): boolean {
  const h = String(host ?? '').trim();
  if (!h) return true;
  if (h === 'localhost' || h === '::1') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // a hostname like frp.example.com is public
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
