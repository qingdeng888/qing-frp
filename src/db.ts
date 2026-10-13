import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from './config.js';

/**
 * Thin data layer on top of the built-in node:sqlite driver.
 * No native compilation required, so the panel installs on a bare machine.
 */
ensureDirs();

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  bind_addr              TEXT    NOT NULL DEFAULT '0.0.0.0',
  bind_port              INTEGER NOT NULL DEFAULT 37001,
  kcp_bind_port          INTEGER,
  quic_bind_port         INTEGER,
  proxy_bind_addr        TEXT,
  vhost_http_port        INTEGER,
  vhost_https_port       INTEGER,
  auth_method            TEXT    NOT NULL DEFAULT 'token',
  auth_token             TEXT    NOT NULL DEFAULT '',
  allow_ports            TEXT    NOT NULL DEFAULT '[{"start":37010,"end":37099}]',
  max_ports_per_client   INTEGER NOT NULL DEFAULT 0,
  subdomain_host         TEXT,
  log_level              TEXT    NOT NULL DEFAULT 'info',
  log_max_days           INTEGER NOT NULL DEFAULT 3,
  dashboard_enabled      INTEGER NOT NULL DEFAULT 1,
  dashboard_user         TEXT    NOT NULL DEFAULT 'admin',
  dashboard_password     TEXT    NOT NULL DEFAULT 'admin',
  dashboard_port         INTEGER NOT NULL DEFAULT 37002,
  tls_force              INTEGER NOT NULL DEFAULT 0,
  tls_cert_file          TEXT,
  tls_key_file           TEXT,
  tls_trusted_ca_file    TEXT,
  tls_only               INTEGER NOT NULL DEFAULT 0,
  heartbeat_timeout      INTEGER NOT NULL DEFAULT 90,
  max_pool_count         INTEGER NOT NULL DEFAULT 5,
  tcp_mux                INTEGER NOT NULL DEFAULT 1,
  tcp_mux_keepalive      INTEGER NOT NULL DEFAULT 30,
  udp_packet_size        INTEGER NOT NULL DEFAULT 1500,
  nathole_reserve_hours  INTEGER NOT NULL DEFAULT 168,
  detailed_errors        INTEGER NOT NULL DEFAULT 1,
  enable_prometheus      INTEGER NOT NULL DEFAULT 0,
  extra_toml             TEXT    NOT NULL DEFAULT '',
  github_proxy           TEXT    NOT NULL DEFAULT '',
  github_proxy_api       INTEGER NOT NULL DEFAULT 0,
  goproxy                TEXT    NOT NULL DEFAULT '',
  go_download_base       TEXT    NOT NULL DEFAULT '',
  -- Public address of this panel, used inside generated install scripts.
  -- Empty means "auto-detect", which is only correct on a flat network.
  public_base_url        TEXT    NOT NULL DEFAULT '',
  -- Kept for schema compatibility. frp-console only ships its tuned build,
  -- which enables auditing/quota/diag/heartbeat.
  default_variant        TEXT    NOT NULL DEFAULT 'custom',
    -- 外部直链映射（JSON）：把二进制资产名指向自建/第三方托管地址，
    -- 例如 OpenList 的带签名直链。形如：
    --   {"frp_0.71.0_linux_amd64.tar.gz":"http://host/d/path/frp_xxx.tar.gz?sign=abc:0"}
    -- 面板保留本地分发作为回退，直链失效时安装不会中断。
    asset_mirrors          TEXT    NOT NULL DEFAULT '{}',
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  remark          TEXT    NOT NULL DEFAULT '',
  server_addr     TEXT    NOT NULL DEFAULT '',
  install_dir     TEXT    NOT NULL DEFAULT '/etc/frp',
  frpc_version    TEXT    NOT NULL DEFAULT '',
  download_base   TEXT    NOT NULL DEFAULT '',
  server_port     INTEGER,
  auth_token      TEXT    NOT NULL DEFAULT '',
  log_level       TEXT    NOT NULL DEFAULT 'info',
  login_fail_exit INTEGER NOT NULL DEFAULT 1,
  tls_enable      INTEGER NOT NULL DEFAULT 0,
  protocol        TEXT    NOT NULL DEFAULT 'tcp',
  user            TEXT    NOT NULL DEFAULT '',
  extra_toml      TEXT    NOT NULL DEFAULT '',
  install_token   TEXT    NOT NULL UNIQUE,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id            INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  type               TEXT    NOT NULL DEFAULT 'tcp',
  local_ip           TEXT    NOT NULL DEFAULT '127.0.0.1',
  local_port         INTEGER NOT NULL DEFAULT 0,
  remote_port        INTEGER,
  remote_port_random INTEGER NOT NULL DEFAULT 0,
  custom_domains     TEXT    NOT NULL DEFAULT '[]',
  subdomain          TEXT    NOT NULL DEFAULT '',
  locations          TEXT    NOT NULL DEFAULT '[]',
  multiplexer        TEXT    NOT NULL DEFAULT '',
  secret_key         TEXT    NOT NULL DEFAULT '',
  use_encryption     INTEGER NOT NULL DEFAULT 0,
  use_compression    INTEGER NOT NULL DEFAULT 0,
  bandwidth_limit    TEXT    NOT NULL DEFAULT '',
  proxy_protocol     TEXT    NOT NULL DEFAULT '',
  http_user          TEXT    NOT NULL DEFAULT '',
  http_password      TEXT    NOT NULL DEFAULT '',
  host_header_rewrite TEXT   NOT NULL DEFAULT '',
  enabled            INTEGER NOT NULL DEFAULT 1,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proxies_node ON proxies(node_id);

CREATE TABLE IF NOT EXISTS port_reservations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  port       INTEGER NOT NULL UNIQUE,
  node_id    INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  proxy_id   INTEGER REFERENCES proxies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Panel login sessions. Only the SHA-256 of the cookie token is stored, so a
-- database leak does not hand out usable sessions. Survives panel restarts.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  username   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT    NOT NULL DEFAULT '',
  remote_ip  TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Node heartbeats pushed by the customized frpc build (see custom-frp/).
-- Only the latest row per node is kept; older rows are pruned on write.
CREATE TABLE IF NOT EXISTS node_heartbeats (
  node_id        INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  hostname       TEXT    NOT NULL DEFAULT '',
  version        TEXT    NOT NULL DEFAULT '',
  os             TEXT    NOT NULL DEFAULT '',
  arch           TEXT    NOT NULL DEFAULT '',
  uptime_sec     INTEGER NOT NULL DEFAULT 0,
  proxy_total    INTEGER NOT NULL DEFAULT 0,
  proxy_running  INTEGER NOT NULL DEFAULT 0,
  proxies_json   TEXT    NOT NULL DEFAULT '[]',
  goroutines     INTEGER NOT NULL DEFAULT 0,
  mem_alloc_mb   INTEGER NOT NULL DEFAULT 0,
  remote_ip      TEXT    NOT NULL DEFAULT '',
  reported_at    INTEGER NOT NULL,
  received_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
`);

/**
 * Add columns introduced after the initial schema. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so probe pragma table_info first.
 */
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('settings', 'github_proxy', "github_proxy TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'github_proxy_api', 'github_proxy_api INTEGER NOT NULL DEFAULT 0');
ensureColumn('settings', 'goproxy', "goproxy TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'go_download_base', "go_download_base TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'asset_mirrors', "asset_mirrors TEXT NOT NULL DEFAULT '{}'");
ensureColumn('settings', 'frps_addr', "frps_addr TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'public_base_url', "public_base_url TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'default_variant', "default_variant TEXT NOT NULL DEFAULT 'custom'");

export type SqlValue = string | number | null;

export function all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
  const res = db.prepare(sql).run(...params);
  return {
    changes: Number(res.changes),
    lastInsertRowid: Number(res.lastInsertRowid),
  };
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Ensure the singleton settings row exists. Safe to call on every boot. */
export function ensureSettingsRow(seedToken: string): void {
  const existing = get('SELECT id FROM settings WHERE id = 1');
  if (!existing) {
    run('INSERT INTO settings (id, auth_token) VALUES (1, ?)', seedToken);
  }
}

export function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}
