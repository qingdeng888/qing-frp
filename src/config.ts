import fs from 'node:fs';
import path from 'node:path';
import { detectLanAddress } from './panel-url.js';

/**
 * Runtime paths and process configuration.
 *
 * Everything is rooted at FRP_CONSOLE_HOME (defaults to the current working
 * directory) so the panel can be installed anywhere without rebuilding.
 */
function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

export const HOME_DIR = path.resolve(envOr('FRP_CONSOLE_HOME', process.cwd()));
export const DATA_DIR = path.resolve(envOr('FRP_CONSOLE_DATA_DIR', path.join(HOME_DIR, 'data')));

/**
 * Locate the web assets. The panel can be started from anywhere, so probe the
 * usual candidates instead of assuming the CWD contains `public/`.
 */
function resolvePublicDir(): string {
  const explicit = process.env.FRP_CONSOLE_PUBLIC_DIR;
  if (explicit && explicit.trim() !== '') return path.resolve(explicit.trim());
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(HOME_DIR, 'public'),
    path.resolve(here, '..', 'public'), // src/ -> <root>/public (dev, tsx)
    path.resolve(here, '..', '..', 'public'), // dist/src/ -> <root>/public (built)
    path.resolve(process.cwd(), 'public'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}

export const PUBLIC_DIR = resolvePublicDir();
export const BIN_DIR = path.join(DATA_DIR, 'bin');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const DB_PATH = path.join(DATA_DIR, 'panel.db');

/** Where the generated frps config + systemd unit live (root paths by default). */
export const FRPS_CONFIG_PATH = envOr('FRP_CONSOLE_FRPS_CONFIG', '/etc/frp/frps.toml');
export const FRPC_CONFIG_PATH = envOr('FRP_CONSOLE_FRPC_CONFIG', '/etc/frp/frpc.toml');
export const FRPS_SERVICE_PATH = envOr('FRP_CONSOLE_FRPS_UNIT', '/etc/systemd/system/frps.service');
export const FRPS_SERVICE_NAME = envOr('FRP_CONSOLE_FRPS_SERVICE', 'frps');
export const FRPS_BIN_PATH = path.resolve(envOr('FRP_CONSOLE_FRPS_BIN', path.join(BIN_DIR, 'frps')));

/**
 * True when the operator pinned the frps binary location explicitly. In that
 * case the panel must copy the downloaded release onto that path; otherwise it
 * can point systemd straight at the versioned binary and skip copying (which
 * also avoids ETXTBSY on a running service).
 */
export const FRPS_BIN_PINNED = Boolean(process.env.FRP_CONSOLE_FRPS_BIN?.trim());

export const PANEL_HOST = envOr('FRP_CONSOLE_HOST', '0.0.0.0');
export const PANEL_PORT = Number(envOr('FRP_CONSOLE_PORT', '37000'));

/** Panel login credentials. Override with env vars in production. */
export const PANEL_USER = envOr('FRP_CONSOLE_USER', 'admin');
export const PANEL_PASSWORD = envOr('FRP_CONSOLE_PASSWORD', 'changeme');

/** How long a login session stays valid. */
export const SESSION_TTL_MS = Number(envOr('FRP_CONSOLE_SESSION_TTL', String(12 * 3600))) * 1000;

/** Set to 1 when the panel is served over HTTPS so the cookie gets Secure. */
export const COOKIE_SECURE = envOr('FRP_CONSOLE_COOKIE_SECURE', '0') === '1';

export const SESSION_COOKIE = 'frp_console_session';

/**
 * Env fallback for the panel's public URL. The effective value is resolved at
 * request time by panel-url.ts, where a saved setting takes precedence.
 */
export const PUBLIC_URL_ENV = process.env.FRP_CONSOLE_PUBLIC_URL?.trim() ?? '';

/** Auto-detected LAN URL, used only when nothing else is configured. */
export const DETECTED_LAN_URL = `http://${detectLanAddress()}:${PANEL_PORT}`;

export { detectLanAddress, listLocalAddresses } from './panel-url.js';

/**
 * Service manager to use. Empty means auto-detect: systemd on bare hosts,
 * supervisord inside containers, otherwise config-only mode.
 */
export const SERVICE_MANAGER = envOr('FRP_CONSOLE_SERVICE_MANAGER', '') as
  | ''
  | 'systemd'
  | 'supervisor'
  | 'none';

/** supervisord integration paths (container deployments). */
export const SUPERVISOR_INCLUDE_DIR = envOr('FRP_CONSOLE_SUPERVISOR_INCLUDE', '/etc/supervisor/conf.d');
export const SUPERVISOR_LOG_DIR = envOr('FRP_CONSOLE_SUPERVISOR_LOG', '/var/log/frps');
export const SUPERVISORCTL = envOr('FRP_CONSOLE_SUPERVISORCTL', 'supervisorctl');

/**
 * Panel version, read from package.json so it always reflects the code that is
 * actually running. Used to verify a deployment (e.g. whether a rebuilt Docker
 * image really contains a given version).
 */
export function panelVersion(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(here, '..', 'package.json'), // dist/ -> <root>/package.json
    path.resolve(here, '..', '..', 'package.json'), // dist/src/ -> <root>/package.json
    path.join(process.cwd(), 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string };
      if (pkg?.version) return String(pkg.version);
    } catch {
      /* try the next candidate */
    }
  }
  return 'unknown';
}

/** Set to 0 to disable any process management (config generation only). */
export const SYSTEMD_ENABLED = envOr('FRP_CONSOLE_SYSTEMD', '1') !== '0';

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, BIN_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
