import crypto from 'node:crypto';
import { all, ensureSettingsRow, get, parseJsonArray, run, tx } from './db.js';
import { countPorts, isValidPort, normalizeRanges, parseRanges, pickRandomPort, rangeContains, buildPoolStats, type PoolStats } from './ports.js';
import type { FrpsSettings, Node, PortRange, Proxy, ProxyType } from './types.js';
import { PORT_CONSUMING_TYPES } from './types.js';
import { asBool, clampInt, isValidProxyName, nowIso, shortId, slugifyProxyName, toList, toOptionalInt, toOptionalString } from './util.js';
import { isValidProxy, normalizeProxy } from './mirror.js';
import { isValidBaseUrl, normalizeBaseUrl } from './panel-url.js';

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

type Row = Record<string, any>;

/** 资产文件名只允许我们实际分发的形态，避免映射被滥用成开放代理。 */
const ASSET_NAME_RE = /^frp_[0-9]+\.[0-9]+\.[0-9]+_linux_[A-Za-z0-9_]+\.tar\.gz$/;

/**
 * 解析数据库里的直链映射。
 * 容忍脏数据：JSON 坏掉或条目非法时退化为空表，而不是让整个面板起不来。
 */
function parseAssetMirrors(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return normalizeAssetMirrors(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * 校验并规范化直链映射。
 *
 * 只接受 http/https 的绝对 URL，且键必须是面板会分发的资产名——
 * 否则这里就成了一个任意 URL 的转发点。签名/查询参数原样保留
 * （OpenList 的 `?sign=...:0` 必须完整带到安装脚本里）。
 */
function normalizeAssetMirrors(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('assetMirrors 必须是「文件名: 下载地址」的映射对象');
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const val = String(rawVal ?? '').trim();
    // 允许删除条目：值为空即忽略该键
    if (!key && !val) continue;
    if (!ASSET_NAME_RE.test(key)) {
      throw new Error(`不支持的资产名: ${key}（应形如 frp_0.71.0_linux_amd64.tar.gz）`);
    }
    if (!val) continue;
    let parsed: URL;
    try {
      parsed = new URL(val);
    } catch {
      throw new Error(`资产 ${key} 的下载地址不是合法 URL: ${val}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`资产 ${key} 的下载地址必须以 http:// 或 https:// 开头`);
    }
    out[key] = val;
  }
  return out;
}

/**
 * 校验并规范化「frps 对外地址」。
 *
 * 这里存的是**主机名或 IP**（不带端口、不带协议）——端口由 bindPort 单独描述，
 * 生成 frpc.toml 时二者拼接。用户可能习惯性粘贴完整 URL，
 * 因此这里宽容地剥掉 scheme、路径与端口，只保留主机部分。
 */
function normalizeFrpsAddr(input: unknown): string {
  let v = String(input ?? '').trim();
  if (!v) return '';
  // 剥掉 http(s):// 前缀
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // 剥掉路径 / 查询 / 片段
  v = v.split('/')[0] ?? '';
  // IPv6 字面量保留方括号内的内容
  const v6 = v.match(/^\[([^\]]+)\]/);
  if (v6) {
    const host = v6[1] ?? '';
    if (!/^[0-9A-Fa-f:.]+$/.test(host)) throw new Error('frps 地址不是合法的 IPv6 地址');
    return `[${host}]`;
  }
  // 剥掉端口
  v = v.replace(/:(\d+)$/, '');
  if (!v) return '';
  if (/\s/.test(v)) throw new Error('frps 地址不能包含空格');
  // 允许域名、IPv4；不允许奇怪字符
  if (!/^[A-Za-z0-9.-]+$/.test(v)) throw new Error('frps 地址只能包含域名或 IP（不含端口和协议）');
  if (/^\.|\.$|\.\./.test(v)) throw new Error('frps 地址格式不正确');
  return v;
}

function rowToSettings(r: Row): FrpsSettings {
  return {
    bindAddr: r.bind_addr,
    bindPort: r.bind_port,
    kcpBindPort: r.kcp_bind_port,
    quicBindPort: r.quic_bind_port,
    proxyBindAddr: r.proxy_bind_addr,
    vhostHttpPort: r.vhost_http_port,
    vhostHttpsPort: r.vhost_https_port,
    authMethod: r.auth_method,
    authToken: r.auth_token,
    allowPorts: parseRanges(r.allow_ports),
    maxPortsPerClient: r.max_ports_per_client,
    subdomainHost: r.subdomain_host,
    logLevel: r.log_level,
    logMaxDays: r.log_max_days,
    dashboardEnabled: !!r.dashboard_enabled,
    dashboardUser: r.dashboard_user,
    dashboardPassword: r.dashboard_password,
    dashboardPort: r.dashboard_port,
    tlsForce: !!r.tls_force,
    tlsCertFile: r.tls_cert_file,
    tlsKeyFile: r.tls_key_file,
    tlsTrustedCaFile: r.tls_trusted_ca_file,
    tlsOnly: !!r.tls_only,
    heartbeatTimeout: r.heartbeat_timeout,
    maxPoolCount: r.max_pool_count,
    tcpMux: !!r.tcp_mux,
    tcpMuxKeepalive: r.tcp_mux_keepalive,
    udpPacketSize: r.udp_packet_size,
    natholeReserveHours: r.nathole_reserve_hours,
    detailedErrors: !!r.detailed_errors,
    enablePrometheus: !!r.enable_prometheus,
    extraToml: r.extra_toml,
    githubProxy: r.github_proxy ?? '',
    githubProxyApi: !!r.github_proxy_api,
    goproxy: r.goproxy ?? '',
    goDownloadBase: r.go_download_base ?? '',
    assetMirrors: parseAssetMirrors(r.asset_mirrors),
    frpsAddr: r.frps_addr ?? '',
    publicBaseUrl: r.public_base_url ?? '',
    updatedAt: r.updated_at,
  };
}

function rowToNode(r: Row): Node {
  return {
    id: r.id,
    name: r.name,
    remark: r.remark,
    serverAddr: r.server_addr,
    installDir: r.install_dir,
    frpcVersion: r.frpc_version,
    downloadBase: r.download_base,
    serverPort: r.server_port,
    authToken: r.auth_token,
    logLevel: r.log_level,
    loginFailExit: !!r.login_fail_exit,
    tlsEnable: !!r.tls_enable,
    protocol: r.protocol,
    user: r.user,
    extraToml: r.extra_toml,
    installToken: r.install_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToProxy(r: Row): Proxy {
  return {
    id: r.id,
    nodeId: r.node_id,
    name: r.name,
    type: r.type,
    localIp: r.local_ip,
    localPort: r.local_port,
    remotePort: r.remote_port,
    remotePortRandom: !!r.remote_port_random,
    customDomains: parseJsonArray(r.custom_domains),
    subdomain: r.subdomain,
    locations: parseJsonArray(r.locations),
    multiplexer: r.multiplexer,
    secretKey: r.secret_key,
    useEncryption: !!r.use_encryption,
    useCompression: !!r.use_compression,
    bandwidthLimit: r.bandwidth_limit,
    proxyProtocol: r.proxy_protocol,
    httpUser: r.http_user,
    httpPassword: r.http_password,
    hostHeaderRewrite: r.host_header_rewrite,
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
  };
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function getSettings(): FrpsSettings {
  ensureSettingsRow(shortId(24));
  const row = get<Row>('SELECT * FROM settings WHERE id = 1');
  if (!row) throw new Error('settings row missing');
  return rowToSettings(row);
}

export interface SettingsValidation {
  settings: FrpsSettings;
  warnings: string[];
}

export function updateSettings(patch: Record<string, unknown>): SettingsValidation {
  const current = getSettings();
  const warnings: string[] = [];

  const bindPort = patch.bindPort !== undefined ? clampInt(patch.bindPort, 1, 65535, current.bindPort) : current.bindPort;
  if (!isValidPort(bindPort)) throw new Error('bindPort 必须是 1-65535 的整数');

  const allowPorts = patch.allowPorts !== undefined ? normalizeRanges(patch.allowPorts as PortRange[]) : current.allowPorts;

  const authToken = patch.authToken !== undefined ? String(patch.authToken) : current.authToken;
  if (!authToken.trim()) throw new Error('auth.token 不能为空');

  const dashboardEnabled =
    patch.dashboardEnabled !== undefined ? asBool(patch.dashboardEnabled, current.dashboardEnabled) : current.dashboardEnabled;
  const dashboardPort =
    patch.dashboardPort !== undefined ? clampInt(patch.dashboardPort, 1, 65535, current.dashboardPort) : current.dashboardPort;

  const kcpBindPort = patch.kcpBindPort !== undefined ? toOptionalInt(patch.kcpBindPort) : current.kcpBindPort;
  const quicBindPort = patch.quicBindPort !== undefined ? toOptionalInt(patch.quicBindPort) : current.quicBindPort;
  const vhostHttpPort = patch.vhostHttpPort !== undefined ? toOptionalInt(patch.vhostHttpPort) : current.vhostHttpPort;
  const vhostHttpsPort = patch.vhostHttpsPort !== undefined ? toOptionalInt(patch.vhostHttpsPort) : current.vhostHttpsPort;

  const result: FrpsSettings = {
    ...current,
    bindAddr: patch.bindAddr !== undefined ? String(patch.bindAddr).trim() || '0.0.0.0' : current.bindAddr,
    bindPort,
    kcpBindPort,
    quicBindPort,
    proxyBindAddr: patch.proxyBindAddr !== undefined ? toOptionalString(patch.proxyBindAddr) : current.proxyBindAddr,
    vhostHttpPort,
    vhostHttpsPort,
    authMethod: (patch.authMethod as 'token' | 'oidc') ?? current.authMethod,
    authToken,
    allowPorts,
    maxPortsPerClient:
      patch.maxPortsPerClient !== undefined
        ? clampInt(patch.maxPortsPerClient, 0, 100000, current.maxPortsPerClient)
        : current.maxPortsPerClient,
    subdomainHost: patch.subdomainHost !== undefined ? toOptionalString(patch.subdomainHost) : current.subdomainHost,
    logLevel: (patch.logLevel as FrpsSettings['logLevel']) ?? current.logLevel,
    logMaxDays: patch.logMaxDays !== undefined ? clampInt(patch.logMaxDays, 1, 365, current.logMaxDays) : current.logMaxDays,
    dashboardEnabled,
    dashboardUser: patch.dashboardUser !== undefined ? String(patch.dashboardUser) : current.dashboardUser,
    dashboardPassword: patch.dashboardPassword !== undefined ? String(patch.dashboardPassword) : current.dashboardPassword,
    dashboardPort,
    tlsForce: patch.tlsForce !== undefined ? asBool(patch.tlsForce, current.tlsForce) : current.tlsForce,
    tlsCertFile: patch.tlsCertFile !== undefined ? toOptionalString(patch.tlsCertFile) : current.tlsCertFile,
    tlsKeyFile: patch.tlsKeyFile !== undefined ? toOptionalString(patch.tlsKeyFile) : current.tlsKeyFile,
    tlsTrustedCaFile: patch.tlsTrustedCaFile !== undefined ? toOptionalString(patch.tlsTrustedCaFile) : current.tlsTrustedCaFile,
    tlsOnly: patch.tlsOnly !== undefined ? asBool(patch.tlsOnly, current.tlsOnly) : current.tlsOnly,
    heartbeatTimeout:
      patch.heartbeatTimeout !== undefined ? clampInt(patch.heartbeatTimeout, -1, 3600, current.heartbeatTimeout) : current.heartbeatTimeout,
    maxPoolCount: patch.maxPoolCount !== undefined ? clampInt(patch.maxPoolCount, 1, 1000, current.maxPoolCount) : current.maxPoolCount,
    tcpMux: patch.tcpMux !== undefined ? asBool(patch.tcpMux, current.tcpMux) : current.tcpMux,
    tcpMuxKeepalive:
      patch.tcpMuxKeepalive !== undefined ? clampInt(patch.tcpMuxKeepalive, 1, 3600, current.tcpMuxKeepalive) : current.tcpMuxKeepalive,
    udpPacketSize: patch.udpPacketSize !== undefined ? clampInt(patch.udpPacketSize, 1, 65535, current.udpPacketSize) : current.udpPacketSize,
    natholeReserveHours:
      patch.natholeReserveHours !== undefined ? clampInt(patch.natholeReserveHours, 0, 8760, current.natholeReserveHours) : current.natholeReserveHours,
    detailedErrors: patch.detailedErrors !== undefined ? asBool(patch.detailedErrors, current.detailedErrors) : current.detailedErrors,
    enablePrometheus: patch.enablePrometheus !== undefined ? asBool(patch.enablePrometheus, current.enablePrometheus) : current.enablePrometheus,
    extraToml: patch.extraToml !== undefined ? String(patch.extraToml) : current.extraToml,
    githubProxy: patch.githubProxy !== undefined ? normalizeProxy(patch.githubProxy) : current.githubProxy,
    githubProxyApi: patch.githubProxyApi !== undefined ? asBool(patch.githubProxyApi, current.githubProxyApi) : current.githubProxyApi,
    goproxy: patch.goproxy !== undefined ? String(patch.goproxy).trim() : current.goproxy,
    goDownloadBase: patch.goDownloadBase !== undefined ? String(patch.goDownloadBase).trim().replace(/\/+$/, '') : current.goDownloadBase,
    assetMirrors:
      patch.assetMirrors !== undefined ? normalizeAssetMirrors(patch.assetMirrors) : current.assetMirrors,
    frpsAddr: patch.frpsAddr !== undefined ? normalizeFrpsAddr(patch.frpsAddr) : current.frpsAddr,
    publicBaseUrl: patch.publicBaseUrl !== undefined ? normalizeBaseUrl(patch.publicBaseUrl) : current.publicBaseUrl,
  };

  if (!isValidBaseUrl(result.publicBaseUrl)) {
    throw new Error('面板公网地址无效，示例：http://1.2.3.4:37000 或 https://frp.example.com');
  }

  if (!isValidProxy(result.githubProxy)) {
    throw new Error('GitHub 代理地址无效，应为 http(s):// 开头的 URL，例如 https://raw.xiaoy.de');
  }

  // Sanity warnings: server listeners sitting inside the client port pool.
  const serverPorts = new Map<string, number | null>([
    ['bindPort', result.bindPort],
    ['kcpBindPort', result.kcpBindPort],
    ['quicBindPort', result.quicBindPort],
    ['vhostHTTPPort', result.vhostHttpPort],
    ['vhostHTTPSPort', result.vhostHttpsPort],
    ['dashboardPort', result.dashboardEnabled ? result.dashboardPort : null],
  ]);
  for (const [name, port] of serverPorts) {
    if (port && rangeContains(result.allowPorts, port)) {
      warnings.push(`${name}=${port} 落在客户端端口范围内，已自动从可用池中排除。`);
    }
  }

  run(
    `UPDATE settings SET
       bind_addr=?, bind_port=?, kcp_bind_port=?, quic_bind_port=?, proxy_bind_addr=?,
       vhost_http_port=?, vhost_https_port=?, auth_method=?, auth_token=?, allow_ports=?,
       max_ports_per_client=?, subdomain_host=?, log_level=?, log_max_days=?,
       dashboard_enabled=?, dashboard_user=?, dashboard_password=?, dashboard_port=?,
       tls_force=?, tls_cert_file=?, tls_key_file=?, tls_trusted_ca_file=?, tls_only=?,
       heartbeat_timeout=?, max_pool_count=?, tcp_mux=?, tcp_mux_keepalive=?,
       udp_packet_size=?, nathole_reserve_hours=?, detailed_errors=?, enable_prometheus=?,
       extra_toml=?, github_proxy=?, github_proxy_api=?, goproxy=?, go_download_base=?,
       asset_mirrors=?, frps_addr=?, public_base_url=?, updated_at=datetime('now')
     WHERE id = 1`,
    result.bindAddr,
    result.bindPort,
    result.kcpBindPort,
    result.quicBindPort,
    result.proxyBindAddr,
    result.vhostHttpPort,
    result.vhostHttpsPort,
    result.authMethod,
    result.authToken,
    JSON.stringify(result.allowPorts),
    result.maxPortsPerClient,
    result.subdomainHost,
    result.logLevel,
    result.logMaxDays,
    result.dashboardEnabled ? 1 : 0,
    result.dashboardUser,
    result.dashboardPassword,
    result.dashboardPort,
    result.tlsForce ? 1 : 0,
    result.tlsCertFile,
    result.tlsKeyFile,
    result.tlsTrustedCaFile,
    result.tlsOnly ? 1 : 0,
    result.heartbeatTimeout,
    result.maxPoolCount,
    result.tcpMux ? 1 : 0,
    result.tcpMuxKeepalive,
    result.udpPacketSize,
    result.natholeReserveHours,
    result.detailedErrors ? 1 : 0,
    result.enablePrometheus ? 1 : 0,
    result.extraToml,
    result.githubProxy,
    result.githubProxyApi ? 1 : 0,
    result.goproxy,
    result.goDownloadBase,
    JSON.stringify(result.assetMirrors ?? {}),
    result.frpsAddr,
    result.publicBaseUrl,
  );

  reconcileReservations();
  return { settings: getSettings(), warnings };
}

/* ------------------------------------------------------------------ *
 * Nodes
 * ------------------------------------------------------------------ */

export function listNodes(): Node[] {
  return all<Row>('SELECT * FROM nodes ORDER BY id ASC').map(rowToNode);
}

export function getNode(id: number): Node | null {
  const row = get<Row>('SELECT * FROM nodes WHERE id = ?', id);
  return row ? rowToNode(row) : null;
}

export function getNodeByToken(token: string): Node | null {
  const row = get<Row>('SELECT * FROM nodes WHERE install_token = ?', token);
  return row ? rowToNode(row) : null;
}

/**
 * Effective auth token for a node.
 *
 * frps authenticates clients with a single global token, so a node that has no
 * explicit override must always follow the current frps token. Rotating the
 * frps token therefore propagates to every inheriting node on the next render,
 * instead of leaving them with a stale copy that can never log in.
 */
export function resolveNodeAuthToken(node: Node): string {
  const override = (node.authToken ?? '').trim();
  if (override) return override;
  return getSettings().authToken;
}

/** Effective serverPort: node override, else the current frps bindPort. */
/**
 * 解析节点的 frps 地址：节点未单独填写时继承「frps 设置」里的对外地址。
 * 二者都为空时返回空串，交由调用方提示用户补填。
 */
export function resolveNodeServerAddr(node: Node): string {
  return String(node.serverAddr ?? '').trim() || getSettings().frpsAddr || '';
}

export { normalizeFrpsAddr };

export function resolveNodeServerPort(node: Node): number {
  return node.serverPort ?? getSettings().bindPort;
}

export interface NodeInput {
  name?: string;
  remark?: string;
  serverAddr?: string;
  installDir?: string;
  frpcVersion?: string;
  downloadBase?: string;
  serverPort?: number | null;
  /**
   * Per-node auth token override. Leave empty to inherit the frps token at
   * render time — that keeps existing nodes working when the frps token is
   * rotated (frps has a single global token, so a stale copy can never log in).
   */
  authToken?: string;
  logLevel?: string;
  loginFailExit?: boolean;
  tlsEnable?: boolean;
  protocol?: Node['protocol'];
  user?: string;
  extraToml?: string;
}

function uniqueInstallToken(): string {
  for (let i = 0; i < 20; i++) {
    const token = shortId(16);
    if (!get('SELECT id FROM nodes WHERE install_token = ?', token)) return token;
  }
  throw new Error('无法生成唯一安装 token');
}

export function createNode(input: NodeInput): Node {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('节点名称不能为空');
  const settings = getSettings();
  const token = uniqueInstallToken();
  const res = run(
    `INSERT INTO nodes
      (name, remark, server_addr, install_dir, frpc_version, download_base, server_port, auth_token,
       log_level, login_fail_exit, tls_enable, protocol, user, extra_toml, install_token)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    name,
    String(input.remark ?? ''),
    String(input.serverAddr ?? ''),
    String(input.installDir || '/etc/frp'),
    String(input.frpcVersion ?? ''),
    String(input.downloadBase ?? ''),
    input.serverPort ?? settings.bindPort,
    // Store an override only when explicitly provided; empty means "inherit".
    input.authToken !== undefined ? String(input.authToken).trim() : '',
    String(input.logLevel || 'info'),
    asBool(input.loginFailExit, true) ? 1 : 0,
    asBool(input.tlsEnable, false) ? 1 : 0,
    String(input.protocol || 'tcp'),
    String(input.user ?? ''),
    String(input.extraToml ?? ''),
    token,
  );
  const created = getNode(res.lastInsertRowid);
  if (!created) throw new Error('创建节点失败');
  return created;
}

export function updateNode(id: number, input: NodeInput): Node {
  const existing = getNode(id);
  if (!existing) throw new Error('节点不存在');
  const merged = {
    name: input.name !== undefined ? String(input.name).trim() : existing.name,
    remark: input.remark !== undefined ? String(input.remark) : existing.remark,
    serverAddr: input.serverAddr !== undefined ? String(input.serverAddr).trim() : existing.serverAddr,
    installDir: input.installDir !== undefined ? String(input.installDir).trim() || '/etc/frp' : existing.installDir,
    frpcVersion: input.frpcVersion !== undefined ? String(input.frpcVersion).trim() : existing.frpcVersion,
    downloadBase: input.downloadBase !== undefined ? String(input.downloadBase).trim() : existing.downloadBase,
    serverPort: input.serverPort !== undefined ? input.serverPort : existing.serverPort,
    authToken: input.authToken !== undefined ? String(input.authToken).trim() : existing.authToken,
    logLevel: input.logLevel !== undefined ? String(input.logLevel) : existing.logLevel,
    loginFailExit: input.loginFailExit !== undefined ? asBool(input.loginFailExit, existing.loginFailExit) : existing.loginFailExit,
    tlsEnable: input.tlsEnable !== undefined ? asBool(input.tlsEnable, existing.tlsEnable) : existing.tlsEnable,
    protocol: (input.protocol ?? existing.protocol) as Node['protocol'],
    user: input.user !== undefined ? String(input.user) : existing.user,
    extraToml: input.extraToml !== undefined ? String(input.extraToml) : existing.extraToml,
  };
  if (!merged.name) throw new Error('节点名称不能为空');

  run(
    `UPDATE nodes SET name=?, remark=?, server_addr=?, install_dir=?, frpc_version=?, download_base=?,
       server_port=?, auth_token=?, log_level=?, login_fail_exit=?, tls_enable=?, protocol=?, user=?,
       extra_toml=?, updated_at=datetime('now') WHERE id=?`,
    merged.name,
    merged.remark,
    merged.serverAddr,
    merged.installDir,
    merged.frpcVersion,
    merged.downloadBase,
    merged.serverPort,
    merged.authToken,
    merged.logLevel,
    merged.loginFailExit ? 1 : 0,
    merged.tlsEnable ? 1 : 0,
    merged.protocol,
    merged.user,
    merged.extraToml,
    id,
  );
  const updated = getNode(id);
  if (!updated) throw new Error('节点不存在');
  return updated;
}

export function regenerateInstallToken(id: number): Node {
  const token = uniqueInstallToken();
  run("UPDATE nodes SET install_token=?, updated_at=datetime('now') WHERE id=?", token, id);
  const node = getNode(id);
  if (!node) throw new Error('节点不存在');
  return node;
}

export function deleteNode(id: number): void {
  tx(() => {
    run('DELETE FROM port_reservations WHERE node_id = ?', id);
    run('DELETE FROM proxies WHERE node_id = ?', id);
    run('DELETE FROM nodes WHERE id = ?', id);
  });
}

/* ------------------------------------------------------------------ *
 * Proxies
 * ------------------------------------------------------------------ */

export function listProxies(nodeId: number): Proxy[] {
  return all<Row>('SELECT * FROM proxies WHERE node_id = ? ORDER BY sort_order ASC, id ASC', nodeId).map(rowToProxy);
}

export function listAllProxies(): Proxy[] {
  return all<Row>('SELECT * FROM proxies ORDER BY node_id ASC, sort_order ASC, id ASC').map(rowToProxy);
}

export function getProxy(id: number): Proxy | null {
  const row = get<Row>('SELECT * FROM proxies WHERE id = ?', id);
  return row ? rowToProxy(row) : null;
}

export interface ProxyInput {
  name?: string;
  type?: ProxyType;
  localIp?: string;
  localPort?: number;
  remotePort?: number | null;
  remotePortRandom?: boolean;
  customDomains?: string[] | string;
  subdomain?: string;
  locations?: string[] | string;
  multiplexer?: string;
  secretKey?: string;
  useEncryption?: boolean;
  useCompression?: boolean;
  bandwidthLimit?: string;
  proxyProtocol?: string;
  httpUser?: string;
  httpPassword?: string;
  hostHeaderRewrite?: string;
  enabled?: boolean;
  sortOrder?: number;
}

/** Ports already claimed by explicit (non-random) proxies on any node. */
function explicitUsedPorts(excludeProxyId?: number): Set<number> {
  const rows = all<Row>(
    `SELECT remote_port FROM proxies
      WHERE remote_port IS NOT NULL AND remote_port > 0 AND remote_port_random = 0
        AND type IN (${PORT_CONSUMING_TYPES.map(() => '?').join(',')})
        AND (? IS NULL OR id <> ?)`,
    ...PORT_CONSUMING_TYPES,
    excludeProxyId ?? null,
    excludeProxyId ?? null,
  );
  const set = new Set<number>();
  for (const r of rows) set.add(Number(r.remote_port));
  return set;
}

/** Ports explicitly reserved by the operator inside the pool. */
function manualReservedPorts(): Set<number> {
  const rows = all<Row>('SELECT port FROM port_reservations WHERE proxy_id IS NULL');
  return new Set(rows.map((r) => Number(r.port)));
}

/** Ports held by relay tokens (pool-allocated random ports). */
function relayReservedPorts(excludeProxyId?: number): Map<number, number> {
  const rows = all<Row>(
    'SELECT port, proxy_id FROM port_reservations WHERE proxy_id IS NOT NULL AND (? IS NULL OR proxy_id <> ?)',
    excludeProxyId ?? null,
    excludeProxyId ?? null,
  );
  const map = new Map<number, number>();
  for (const r of rows) map.set(Number(r.port), Number(r.proxy_id));
  return map;
}

export function poolStats(): PoolStats {
  const settings = getSettings();
  const used = explicitUsedPorts();
  for (const p of relayReservedPorts().keys()) used.add(p);
  const reserved = new Set<number>(manualReservedPorts());
  for (const p of serverReservedSet()) reserved.add(p);
  return buildPoolStats(settings.allowPorts, used, reserved);
}

function serverReservedSet(): Set<number> {
  const s = getSettings();
  const set = new Set<number>();
  const add = (v: number | null | undefined) => {
    if (typeof v === 'number' && isValidPort(v)) set.add(v);
  };
  add(s.bindPort);
  add(s.kcpBindPort);
  add(s.quicBindPort);
  add(s.vhostHttpPort);
  add(s.vhostHttpsPort);
  if (s.dashboardEnabled) add(s.dashboardPort);
  return set;
}

export interface AllocationResult {
  remotePort: number | null;
  random: boolean;
  warning?: string;
}

/**
 * Decide the remote port for a proxy.
 * - explicit: validated against the pool and conflicts
 * - random without relay token: `remotePort = 0`, frps picks at runtime
 * - random with relay token: a concrete free port is drawn from the ranges
 */
export function allocatePort(
  input: { type: ProxyType; remotePort?: number | null; remotePortRandom?: boolean },
  opts: { proxyId?: number; relayToken?: string | null; avoidPort?: number | null } = {},
): AllocationResult {
  const settings = getSettings();
  const random = !!input.remotePortRandom;
  const consumesPort = PORT_CONSUMING_TYPES.includes(input.type);

  if (!consumesPort) return { remotePort: null, random: false };

  if (!random) {
    const port = toOptionalInt(input.remotePort);
    if (port === null || !isValidPort(port)) {
      throw new Error('远端端口必须是 1-65535 的整数，或勾选“随机分配”');
    }
    // Check server listeners first: that is the more specific, more confusing case.
    if (serverReservedSet().has(port)) {
      throw new Error(`远端端口 ${port} 被 frps 服务自身占用（bindPort/dashboard 等），请换一个`);
    }
    if (settings.allowPorts.length && !rangeContains(settings.allowPorts, port)) {
      throw new Error(`远端端口 ${port} 不在 frps 允许的端口范围 ${formatRanges(settings.allowPorts)} 内`);
    }
    if (explicitUsedPorts(opts.proxyId).has(port)) {
      throw new Error(`远端端口 ${port} 已被其它代理占用`);
    }
    if (relayReservedPorts(opts.proxyId).has(port)) {
      throw new Error(`远端端口 ${port} 已被其它代理的随机分配占用`);
    }
    return { remotePort: port, random: false };
  }

  // Random allocation.
  if (opts.relayToken) {
    const used = explicitUsedPorts(opts.proxyId);
    for (const p of relayReservedPorts(opts.proxyId).keys()) used.add(p);
    for (const p of manualReservedPorts()) used.add(p);
    for (const p of serverReservedSet()) used.add(p);
    const port = pickRandomPort(settings.allowPorts, used);
    if (port !== null) {
      // "Re-roll" should visibly change the port when another one is free.
      if (opts.avoidPort && port === opts.avoidPort) {
        const retry = pickRandomPort(settings.allowPorts, new Set([...used, opts.avoidPort]));
        if (retry !== null) return { remotePort: retry, random: true };
      }
      return { remotePort: port, random: true };
    }
    return {
      remotePort: 0,
      random: true,
      warning: '端口范围内已无可用端口，已回退为 remotePort=0（由 frps 随机分配）',
    };
  }

  return {
    remotePort: 0,
    random: true,
    warning: settings.allowPorts.length
      ? undefined
      : 'frps 未配置端口范围，将使用 frps allowPorts 的默认策略',
  };
}

function formatRanges(ranges: PortRange[]): string {
  return ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(', ');
}

/**
 * frp rejects http/https proxies at runtime when the matching vhost listener
 * is unset. Catch that at creation time instead of silently failing later.
 */
function assertVhostPortConfigured(type: ProxyType): void {
  const s = getSettings();
  if (type === 'http' && !s.vhostHttpPort) {
    throw new Error('frps 未配置 vhostHTTPPort，http 类型代理无法工作。请先在「frps 设置」中填写 vhostHTTPPort 并重启 frps。');
  }
  if (type === 'https' && !s.vhostHttpsPort) {
    throw new Error('frps 未配置 vhostHTTPSPort，https 类型代理无法工作。请先在「frps 设置」中填写 vhostHTTPSPort 并重启 frps。');
  }
}

export function createProxy(nodeId: number, input: ProxyInput): Proxy {
  const node = getNode(nodeId);
  if (!node) throw new Error('节点不存在');
  const type = (input.type ?? 'tcp') as ProxyType;
  assertVhostPortConfigured(type);
  const name = input.name ? slugifyProxyName(input.name) : slugifyProxyName(`${type}-${shortId(5)}`);
  if (!isValidProxyName(name)) throw new Error('代理名称只能包含字母、数字、下划线、点和短横线');
  if (get('SELECT id FROM proxies WHERE node_id = ? AND name = ?', nodeId, name)) {
    throw new Error(`节点内已存在名为 ${name} 的代理`);
  }
  const maxSort = get<Row>('SELECT COALESCE(MAX(sort_order), 0) AS m FROM proxies WHERE node_id = ?', nodeId);
  const sortOrder = input.sortOrder ?? Number(maxSort?.m ?? 0) + 1;

  const allocation = allocatePort(
    { type, remotePort: input.remotePort ?? null, remotePortRandom: input.remotePortRandom },
    { relayToken: node.installToken },
  );

  const res = run(
    `INSERT INTO proxies
      (node_id, name, type, local_ip, local_port, remote_port, remote_port_random, custom_domains, subdomain,
       locations, multiplexer, secret_key, use_encryption, use_compression, bandwidth_limit, proxy_protocol,
       http_user, http_password, host_header_rewrite, enabled, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    nodeId,
    name,
    type,
    String(input.localIp || '127.0.0.1'),
    clampInt(input.localPort, 0, 65535, 0),
    allocation.remotePort,
    allocation.random ? 1 : 0,
    JSON.stringify(toList(input.customDomains)),
    String(input.subdomain ?? ''),
    JSON.stringify(toList(input.locations)),
    String(input.multiplexer ?? ''),
    String(input.secretKey ?? ''),
    asBool(input.useEncryption, false) ? 1 : 0,
    asBool(input.useCompression, false) ? 1 : 0,
    String(input.bandwidthLimit ?? ''),
    String(input.proxyProtocol ?? ''),
    String(input.httpUser ?? ''),
    String(input.httpPassword ?? ''),
    String(input.hostHeaderRewrite ?? ''),
    asBool(input.enabled, true) ? 1 : 0,
    sortOrder,
  );

  syncReservation(res.lastInsertRowid, node.installToken);
  const created = getProxy(res.lastInsertRowid);
  if (!created) throw new Error('创建代理失败');
  return created;
}

export function updateProxy(id: number, input: ProxyInput): Proxy {
  const existing = getProxy(id);
  if (!existing) throw new Error('代理不存在');
  const node = getNode(existing.nodeId);
  if (!node) throw new Error('节点不存在');

  const type = (input.type ?? existing.type) as ProxyType;
  assertVhostPortConfigured(type);
  const name = input.name !== undefined ? slugifyProxyName(input.name) : existing.name;
  const clash = get<Row>('SELECT id FROM proxies WHERE node_id = ? AND name = ? AND id <> ?', existing.nodeId, name, id);
  if (clash) throw new Error(`节点内已存在名为 ${name} 的代理`);

  const remotePortRandom = input.remotePortRandom !== undefined ? asBool(input.remotePortRandom, existing.remotePortRandom) : existing.remotePortRandom;
  const remotePortInput = input.remotePort !== undefined ? input.remotePort : existing.remotePort;

  const allocation = allocatePort(
    { type, remotePort: remotePortInput, remotePortRandom },
    {
      proxyId: id,
      relayToken: node.installToken,
      // Re-rolling an already-random proxy should land on a different port.
      avoidPort: remotePortRandom && existing.remotePortRandom ? existing.remotePort : null,
    },
  );

  run(
    `UPDATE proxies SET name=?, type=?, local_ip=?, local_port=?, remote_port=?, remote_port_random=?,
       custom_domains=?, subdomain=?, locations=?, multiplexer=?, secret_key=?, use_encryption=?,
       use_compression=?, bandwidth_limit=?, proxy_protocol=?, http_user=?, http_password=?,
       host_header_rewrite=?, enabled=?, sort_order=?, updated_at=datetime('now')
     WHERE id=?`,
    name,
    type,
    input.localIp !== undefined ? String(input.localIp) : existing.localIp,
    input.localPort !== undefined ? clampInt(input.localPort, 0, 65535, existing.localPort) : existing.localPort,
    allocation.remotePort,
    allocation.random ? 1 : 0,
    JSON.stringify(input.customDomains !== undefined ? toList(input.customDomains) : existing.customDomains),
    input.subdomain !== undefined ? String(input.subdomain) : existing.subdomain,
    JSON.stringify(input.locations !== undefined ? toList(input.locations) : existing.locations),
    input.multiplexer !== undefined ? String(input.multiplexer) : existing.multiplexer,
    input.secretKey !== undefined ? String(input.secretKey) : existing.secretKey,
    input.useEncryption !== undefined ? (asBool(input.useEncryption, existing.useEncryption) ? 1 : 0) : existing.useEncryption ? 1 : 0,
    input.useCompression !== undefined ? (asBool(input.useCompression, existing.useCompression) ? 1 : 0) : existing.useCompression ? 1 : 0,
    input.bandwidthLimit !== undefined ? String(input.bandwidthLimit) : existing.bandwidthLimit,
    input.proxyProtocol !== undefined ? String(input.proxyProtocol) : existing.proxyProtocol,
    input.httpUser !== undefined ? String(input.httpUser) : existing.httpUser,
    input.httpPassword !== undefined ? String(input.httpPassword) : existing.httpPassword,
    input.hostHeaderRewrite !== undefined ? String(input.hostHeaderRewrite) : existing.hostHeaderRewrite,
    input.enabled !== undefined ? (asBool(input.enabled, existing.enabled) ? 1 : 0) : existing.enabled ? 1 : 0,
    input.sortOrder !== undefined ? clampInt(input.sortOrder, 0, 100000, existing.sortOrder) : existing.sortOrder,
    id,
  );

  syncReservation(id, node.installToken);
  const updated = getProxy(id);
  if (!updated) throw new Error('代理不存在');
  return updated;
}

export function deleteProxy(id: number): void {
  tx(() => {
    run('DELETE FROM port_reservations WHERE proxy_id = ?', id);
    run('DELETE FROM proxies WHERE id = ?', id);
  });
}

/** Allocate a fresh random port for one specific proxy. */
export function rerollProxyPort(id: number): Proxy {
  const proxy = getProxy(id);
  if (!proxy) throw new Error('代理不存在');
  return updateProxy(id, { remotePortRandom: true, remotePort: null });
}

/** Re-create/refresh the pool reservation for a proxy row. */
function syncReservation(proxyId: number, relayToken: string | null | undefined): void {
  const proxy = getProxy(proxyId);
  if (!proxy) return;
  const node = getNode(proxy.nodeId);
  const settings = getSettings();

  if (!relayToken || !node || node.installToken !== relayToken) {
    run('DELETE FROM port_reservations WHERE proxy_id = ?', proxyId);
    return;
  }
  if (!proxy.remotePortRandom || !PORT_CONSUMING_TYPES.includes(proxy.type)) {
    run('DELETE FROM port_reservations WHERE proxy_id = ?', proxyId);
    return;
  }
  if (!proxy.remotePort || proxy.remotePort <= 0) {
    // remotePort = 0 means frps allocates dynamically: nothing to reserve here.
    run('DELETE FROM port_reservations WHERE proxy_id = ?', proxyId);
    return;
  }
  const existing = get<Row>('SELECT port FROM port_reservations WHERE proxy_id = ?', proxyId);
  const stillValid =
    existing &&
    rangeContains(settings.allowPorts, Number(existing.port)) &&
    Number(existing.port) === proxy.remotePort;
  if (stillValid) return;

  run('DELETE FROM port_reservations WHERE proxy_id = ?', proxyId);
  run('INSERT OR REPLACE INTO port_reservations (port, node_id, proxy_id) VALUES (?,?,?)', proxy.remotePort, proxy.nodeId, proxyId);
}

/** Drop reservations that no longer map to a live random proxy. */
export function reconcileReservations(): void {
  tx(() => {
    const nodes = new Map<number, Node>(listNodes().map((n) => [n.id, n]));
    const proxies = listAllProxies();
    run('DELETE FROM port_reservations WHERE proxy_id IS NOT NULL');
    const settings = getSettings();
    // Explicit ports + server listeners + operator pins win over random picks.
    const taken = explicitUsedPorts();
    for (const p of serverReservedSet()) taken.add(p);
    for (const p of manualReservedPorts()) taken.add(p);

    for (const proxy of proxies) {
      const node = nodes.get(proxy.nodeId);
      if (!node) continue;
      if (!proxy.remotePortRandom) continue;
      if (!PORT_CONSUMING_TYPES.includes(proxy.type)) continue;
      if (!proxy.remotePort || proxy.remotePort <= 0) continue;
      if (!rangeContains(settings.allowPorts, proxy.remotePort)) {
        // Range shrank: re-draw a port for this proxy.
        const fresh = pickRandomPort(settings.allowPorts, taken);
        if (fresh !== null) {
          run('UPDATE proxies SET remote_port = ? WHERE id = ?', fresh, proxy.id);
          taken.add(fresh);
          run('INSERT OR REPLACE INTO port_reservations (port, node_id, proxy_id) VALUES (?,?,?)', fresh, proxy.nodeId, proxy.id);
        } else {
          run('UPDATE proxies SET remote_port = 0 WHERE id = ?', proxy.id);
        }
        continue;
      }
      if (taken.has(proxy.remotePort)) {
        const fresh = pickRandomPort(settings.allowPorts, taken);
        if (fresh !== null) {
          run('UPDATE proxies SET remote_port = ? WHERE id = ?', fresh, proxy.id);
          taken.add(fresh);
          run('INSERT OR REPLACE INTO port_reservations (port, node_id, proxy_id) VALUES (?,?,?)', fresh, proxy.nodeId, proxy.id);
        }
        continue;
      }
      taken.add(proxy.remotePort);
      run('INSERT OR REPLACE INTO port_reservations (port, node_id, proxy_id) VALUES (?,?,?)', proxy.remotePort, proxy.nodeId, proxy.id);
    }
  });
}

/* Migrations for operators who want to pin/unpin ports inside the pool. */

export function listManualReservations(): Array<{ id: number; port: number; createdAt: string }> {
  return all<Row>('SELECT id, port, created_at AS createdAt FROM port_reservations WHERE proxy_id IS NULL ORDER BY port ASC') as any;
}

export function addManualReservation(port: number): void {
  if (!isValidPort(port)) throw new Error('端口必须是 1-65535 的整数');
  if (explicitUsedPorts().has(port)) throw new Error(`端口 ${port} 已被代理使用`);
  run('INSERT OR IGNORE INTO port_reservations (port, node_id, proxy_id) VALUES (?, NULL, NULL)', port);
}

export function removeManualReservation(port: number): void {
  run('DELETE FROM port_reservations WHERE port = ? AND proxy_id IS NULL', port);
}

export function poolSummaryText(): string {
  const stats = poolStats();
  return `${stats.used}/${stats.total} 已用，剩余 ${stats.free}`;
}

export function newSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function totalPoolSize(ranges: PortRange[]): number {
  return countPorts(ranges);
}
