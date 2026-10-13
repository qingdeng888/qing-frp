import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import {
  PANEL_HOST,
  PANEL_PORT,
  PUBLIC_DIR,
  PUBLIC_URL_ENV,
  DETECTED_LAN_URL,
  ensureDirs,
  panelVersion,
} from './config.js';
import {
  listLocalAddresses,
  resolvePanelUrl,
  type PanelUrlSource,
} from './panel-url.js';
import { get } from './db.js';
import { DEFAULT_FRP_VERSION, assetName, hostPlatformInfo, installedVersion } from './frp.js';
import {
  controlFrps,
  deployFrps,
  frpsLogs,
  frpsPaths,
  frpsStatus,
  serviceBackendInfo,
  verifyFrpsConfig,
} from './frps-service.js';
import { buildInstallPlan, renderFrpcTomlOnly, renderInstallScript } from './installer.js';
import { renderFrpsToml, renderFrpsUnit, renderProxyBlockText } from './render.js';
import {
  addManualReservation,
  createNode,
  createProxy,
  deleteNode,
  deleteProxy,
  getNode,
  getNodeByToken,
  getSettings,
  listManualReservations,
  listNodes,
  listProxies,
  poolStats,
  regenerateInstallToken,
  removeManualReservation,
  rerollProxyPort,
  resolveNodeServerAddr,
  resolveNodeServerPort,
  updateNode,
  updateProxy,
  updateSettings,
} from './store.js';
import { normalizeRanges, pickRandomPort, rangeContains } from './ports.js';
import { applyProxy, isValidProxy, normalizeProxy } from './mirror.js';
import {
  checkCustomAvailability,
  hostAssetArch,
  packCustomTarball,
  customVersionString,
} from './variant.js';
import { CUSTOM_DIR } from './custom-build.js';
import { buildWindowsPackage } from './windows.js';
import { createHash } from 'node:crypto';
import {
  getNodeLiveStatus,
  recordHeartbeat,
  type HeartbeatPayload,
} from './heartbeat.js';
import {
  getBuildStatus,
  startCustomBuild,
  installCustomBinaries,
} from './custom-build.js';
import { BIN_DIR, DATA_DIR, TMP_DIR } from './config.js';
import fsp from 'node:fs/promises';
import type { PortRange, Proxy } from './types.js';
import { PORT_CONSUMING_TYPES } from './types.js';
import { slugifyProxyName, toList } from './util.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  isAuthenticated,
  setSessionCookie,
  clearLoginFailures,
  isLoginLocked,
  recordLoginFailure,
  verifyCredentials,
} from './auth.js';
import { PANEL_PASSWORD, PANEL_USER, SESSION_COOKIE } from './config.js';

function unauthorized(reply: FastifyReply) {
  reply.code(401).send({ error: '未登录或会话已过期，请重新登录' });
}

async function readBuildLog(): Promise<string> {
  const fsMod = await import('node:fs/promises');
  const pathMod = await import('node:path');
  try {
    const raw = await fsMod.readFile(pathMod.join(DATA_DIR, 'custom-build.log'), 'utf8');
    return raw;
  } catch {
    return '(暂无构建日志)';
  }
}

/**
 * Effective panel URL for the current request. A saved setting wins, then the
 * env var, then a guess based on the Host header / LAN address.
 */
function panelUrlFor(req?: { headers?: Record<string, unknown> }): PanelUrlSource {
  const settings = getSettings();
  const host = String(req?.headers?.host ?? '') || null;
  return resolvePanelUrl({
    setting: settings.publicBaseUrl,
    envValue: PUBLIC_URL_ENV,
    port: PANEL_PORT,
    requestHost: host,
  });
}

function fail(reply: FastifyReply, err: unknown, code = 400) {
  const message = err instanceof Error ? err.message : String(err);
  reply.code(code).send({ error: message });
}

/**
 * Windows frpc.exe 的内容缓存。
 *
 * exe 约 17MB，每次打包请求都从磁盘读取会让并发下载成倍占用内存。
 * 以 { mtimeMs, size } 为 key 缓存内容：文件被重新构建后自动失效。
 */
let windowsExeCache: { key: string; buf: Buffer } | null = null;
async function readWindowsExeCached(exePath: string): Promise<Buffer> {
  const st = await fsp.stat(exePath);
  const key = `${exePath}:${st.mtimeMs}:${st.size}`;
  if (windowsExeCache && windowsExeCache.key === key) return windowsExeCache.buf;
  const buf = await fsp.readFile(exePath);
  windowsExeCache = { key, buf };
  return buf;
}

/** Locate a built Windows frpc.exe (prebuilt zip or unpacked directory). */
async function findWindowsFrpcExe(): Promise<string | null> {
  const distDir = path.join(CUSTOM_DIR, 'dist');
  const candidates: string[] = [];
  // Prebuilt unpacked dirs (custom-frp/dist/frp_*_windows_amd64/frpc.exe)
  try {
    for (const e of await fsp.readdir(distDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.includes('_windows_')) {
        candidates.push(path.join(distDir, e.name, 'frpc.exe'));
      }
    }
  } catch { /* no dist dir */ }
  candidates.push(path.join(distDir, 'frpc-windows-amd64.exe'));
  candidates.push(path.join(CUSTOM_DIR, 'out', 'frpc.exe'));

  for (const c of candidates) {
    try {
      await fsp.access(c, fs.constants.R_OK);
      // Basic sanity: must be a Windows PE executable.
      const head = await fsp.readFile(c, { encoding: 'latin1' });
      if (head.slice(0, 2) === 'MZ') return c;
    } catch { /* try next */ }
  }
  return null;
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.FRP_CONSOLE_LOG_LEVEL ?? 'info' }, bodyLimit: 4 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'internal error' });
  });

  // NOTE: Fastify hooks only apply to routes registered *after* them, so this
  // guard must stay above every route definition.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    // Public endpoints: the login flow, and the capability-URL installer.
    if (url.startsWith('/api/install/')) return;
    // Heartbeat is authenticated by the node's install token in the body.
    if (url === '/api/heartbeat') return;
    if (url === '/api/health') return;
    if (url === '/api/auth/login' || url === '/api/auth/logout' || url === '/api/auth/me') return;
    if (!url.startsWith('/api/')) return;
    if (!isAuthenticated(req).ok) return unauthorized(reply);
  });

  /* ------------------------------- auth ------------------------------ */

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');

    // 暴力破解防护：滑动窗口内失败超限则锁定（按 IP+用户名）
    const lockedSeconds = isLoginLocked(req.ip, username);
    if (lockedSeconds > 0) {
      return reply
        .code(429)
        .header('Retry-After', String(lockedSeconds))
        .send({ error: `尝试次数过多，请 ${lockedSeconds} 秒后再试` });
    }

    if (!verifyCredentials(username, password)) {
      // Deliberately vague: do not reveal which half was wrong.
      recordLoginFailure(req.ip, username);
      return reply.code(401).send({ error: '账号或密码错误' });
    }
    clearLoginFailures(req.ip, username);
    const session = createSession(username, {
      userAgent: String(req.headers['user-agent'] ?? ''),
      remoteIp: req.ip,
    });
    setSessionCookie(reply, session);
    return { ok: true, username, expiresAt: session.expiresAt };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookies = req.headers.cookie ?? '';
    const match = cookies.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    destroySession(match?.[1]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // Probe endpoint: always 200 so a logged-out page load produces no console
  // error noise. Callers branch on the `authenticated` flag.
  app.get('/api/auth/me', async (req) => {
    const auth = isAuthenticated(req);
    if (!auth.ok) return { authenticated: false };
    return { authenticated: true, username: auth.username, via: auth.via };
  });

  /* ----------------------------- system ----------------------------- */

  // Unauthenticated: used by Docker healthchecks and for verifying a deploy.
  app.get('/api/health', async () => ({
    ok: true,
    version: panelVersion(),
    time: new Date().toISOString(),
  }));

  app.get('/api/system/info', async (req) => {
    const paths = await frpsPaths();
    const settings = getSettings();
    // No GitHub lookup: this panel ships and distributes its own build.
    const frpsVer = fs.existsSync(paths.binaryPath) ? await installedVersion(paths.binaryPath) : null;
    const custom = await checkCustomAvailability(CUSTOM_DIR);
    return {
      panel: (() => {
        const resolved = panelUrlFor(req);
        return {
          version: panelVersion(),
          baseUrl: resolved.url,
          baseUrlSource: resolved.source,
          baseUrlIsGuess: resolved.isGuess,
          configuredBaseUrl: getSettings().publicBaseUrl,
          detectedUrl: DETECTED_LAN_URL,
          lanAddresses: listLocalAddresses(),
          username: PANEL_USER,
          authEnabled: true,
        };
      })(),
      host: hostPlatformInfo(),
      frp: {
        // Version this panel ships and distributes.
        version: customVersionString(DEFAULT_FRP_VERSION),
        // 对外公布的 frps 地址，前端用于在节点表单里展示「留空则继承」的值。
        frpsAddr: getSettings().frpsAddr,
        baseVersion: DEFAULT_FRP_VERSION,
        buildReady: custom.available,
        buildIssue: custom.available ? null : custom.reason,
        buildFixHint: custom.available ? null : custom.fixHint ?? null,
        frpsInstalledVersion: frpsVer,
      },
      paths,
      counts: {
        nodes: (get<{ c: number }>('SELECT COUNT(*) AS c FROM nodes')?.c ?? 0) as number,
        proxies: (get<{ c: number }>('SELECT COUNT(*) AS c FROM proxies')?.c ?? 0) as number,
      },
    };
  });

  /* ---------------------------- settings ---------------------------- */

  app.get('/api/settings', async () => getSettings());

  app.put('/api/settings', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.allowPorts !== undefined) normalizeRanges(body.allowPorts as PortRange[]);
      const result = updateSettings(body);
      return result;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/settings/preview', async () => {
    const settings = getSettings();
    return { frpsToml: renderFrpsToml(settings), systemdUnit: renderFrpsUnit() };
  });

  app.post('/api/settings/verify', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { frpsToml?: string; draft?: Record<string, unknown> };
      const toml = body.frpsToml ?? renderFrpsToml(body.draft ? { ...getSettings(), ...(body.draft as object) } : getSettings());
      const result = await verifyFrpsConfig(toml);
      return { ...result, frpsToml: toml };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /* ------------------------------ frps ------------------------------ */

  app.get('/api/frps/status', async () => ({
    status: await frpsStatus(),
    paths: await frpsPaths(),
    backend: await serviceBackendInfo(),
  }));

  app.post('/api/frps/deploy', async (_req, reply) => {
    try {
      return await deployFrps();
    } catch (err) {
      return fail(reply, err, 500);
    }
  });

  app.post('/api/frps/control', async (req, reply) => {
    const body = (req.body ?? {}) as { action?: string };
    const action = body.action as 'start' | 'stop' | 'restart' | 'reload' | undefined;
    if (!action || !['start', 'stop', 'restart', 'reload'].includes(action)) {
      return fail(reply, 'action 必须是 start/stop/restart/reload 之一');
    }
    const result = await controlFrps(action);
    return { result, status: await frpsStatus() };
  });

  app.get('/api/frps/logs', async (req) => {
    const lines = Number((req.query as Record<string, string>)?.lines ?? 200);
    return frpsLogs(Number.isFinite(lines) ? Math.min(Math.max(lines, 10), 2000) : 200);
  });

  /* ------------------------------ ports ----------------------------- */

  app.get('/api/ports', async () => ({ ...poolStats(), manualReservations: listManualReservations() }));

  app.post('/api/ports/reserve', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { port?: number };
      addManualReservation(Number(body.port));
      return { ok: true, ...poolStats() };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/ports/reserve/:port', async (req, reply) => {
    const port = Number((req.params as { port: string }).port);
    if (!Number.isFinite(port)) return fail(reply, '端口无效');
    removeManualReservation(port);
    return { ok: true, ...poolStats() };
  });

  /* ------------------------------ nodes ----------------------------- */

  app.get('/api/nodes', async () => {
    const nodes = listNodes();
    return nodes.map((n) => {
      const live = getNodeLiveStatus(n.id);
      return {
        ...n,
        // 生效值：节点自填优先，否则继承 frps 设置。前端直接展示它，
        // 避免界面上出现「(未设置)」而实际安装脚本里却有地址的困惑。
        effectiveServerAddr: resolveNodeServerAddr(n),
        effectiveServerPort: resolveNodeServerPort(n),
        addrInherited: !String(n.serverAddr ?? '').trim() && !!resolveNodeServerAddr(n),
        proxyCount: listProxies(n.id).length,
        online: live.online,
        lastSeenSeconds: live.ageSeconds,
        heartbeat: live.heartbeat
          ? {
              hostname: live.heartbeat.hostname,
              version: live.heartbeat.version,
              os: live.heartbeat.os,
              arch: live.heartbeat.arch,
              uptimeSec: live.heartbeat.uptimeSec,
              proxyTotal: live.heartbeat.proxyTotal,
              proxyRunning: live.heartbeat.proxyRunning,
              memAllocMb: live.heartbeat.memAllocMb,
            }
          : null,
      };
    });
  });

  app.post('/api/nodes', async (req, reply) => {
    try {
      return createNode((req.body ?? {}) as Record<string, never>);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/nodes/:id', async (req, reply) => {
    const node = getNode(Number((req.params as { id: string }).id));
    if (!node) return fail(reply, '节点不存在', 404);
    const live = getNodeLiveStatus(node.id);
    return {
      ...node,
      effectiveServerAddr: resolveNodeServerAddr(node),
      effectiveServerPort: resolveNodeServerPort(node),
      addrInherited: !String(node.serverAddr ?? '').trim() && !!resolveNodeServerAddr(node),
      proxies: listProxies(node.id),
      online: live.online,
      lastSeenSeconds: live.ageSeconds,
      heartbeat: live.heartbeat,
    };
  });

  app.put('/api/nodes/:id', async (req, reply) => {
    try {
      return updateNode(Number((req.params as { id: string }).id), (req.body ?? {}) as Record<string, never>);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/nodes/:id', async (req, reply) => {
    try {
      deleteNode(Number((req.params as { id: string }).id));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/nodes/:id/token', async (req, reply) => {
    try {
      return regenerateInstallToken(Number((req.params as { id: string }).id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /* ----------------------------- proxies ---------------------------- */

  app.get('/api/nodes/:id/proxies', async (req) => listProxies(Number((req.params as { id: string }).id)));

  app.post('/api/nodes/:id/proxies', async (req, reply) => {
    try {
      return createProxy(Number((req.params as { id: string }).id), (req.body ?? {}) as Record<string, never>);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put('/api/proxies/:id', async (req, reply) => {
    try {
      return updateProxy(Number((req.params as { id: string }).id), (req.body ?? {}) as Record<string, never>);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/proxies/:id', async (req, reply) => {
    try {
      deleteProxy(Number((req.params as { id: string }).id));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/proxies/:id/reroll', async (req, reply) => {
    try {
      return rerollProxyPort(Number((req.params as { id: string }).id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Render the `[[proxies]]` block for an unsaved draft so the operator sees
   * exactly what will be written to frpc.toml while filling the form.
   */
  app.post('/api/proxies/preview', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const type = String(body.type ?? 'tcp') as Proxy['type'];
      const random = body.remotePortRandom === undefined ? true : Boolean(body.remotePortRandom);
      const settings = getSettings();

      // Resolve the remote port the same way the real allocator would, without
      // reserving anything: explicit value, else a sample free port.
      let remotePort: number | null = null;
      let note = '';
      if (PORT_CONSUMING_TYPES.includes(type)) {
        if (random) {
          const stats = poolStats();
          const used = new Set<number>([...stats.usedPorts, ...stats.reservedByServer]);
          const sample = pickRandomPort(settings.allowPorts, used);
          remotePort = sample;
          note = sample
            ? `随机分配：将从端口范围中取一个空闲端口（当前示例为 ${sample}，保存时确定）`
            : '端口范围已无空闲端口，将回退为 remotePort = 0（由 frps 运行时分配）';
        } else {
          const explicit = Number(body.remotePort);
          if (Number.isFinite(explicit) && explicit > 0) {
            remotePort = explicit;
            if (settings.allowPorts.length && !rangeContains(settings.allowPorts, explicit)) {
              note = `注意：${explicit} 不在 frps 允许的端口范围内，保存会被拒绝`;
            }
          } else {
            note = '请填写远端端口，或勾选随机分配';
          }
        }
      }

      const draft: Proxy = {
        id: 0,
        nodeId: 0,
        name: slugifyProxyName(String(body.name ?? `${type}-example`)),
        type,
        localIp: String(body.localIp ?? '127.0.0.1') || '127.0.0.1',
        localPort: Number(body.localPort) || 0,
        remotePort,
        remotePortRandom: random,
        customDomains: toList(body.customDomains),
        subdomain: String(body.subdomain ?? ''),
        locations: toList(body.locations),
        multiplexer: String(body.multiplexer ?? ''),
        secretKey: String(body.secretKey ?? ''),
        useEncryption: Boolean(body.useEncryption),
        useCompression: Boolean(body.useCompression),
        bandwidthLimit: String(body.bandwidthLimit ?? ''),
        proxyProtocol: String(body.proxyProtocol ?? ''),
        httpUser: String(body.httpUser ?? ''),
        httpPassword: String(body.httpPassword ?? ''),
        hostHeaderRewrite: String(body.hostHeaderRewrite ?? ''),
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        sortOrder: 0,
      };

      return {
        toml: renderProxyBlockText(draft, { remotePort, random }),
        resolvedPort: remotePort,
        note,
        allowedRanges: settings.allowPorts,
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /* ---------------------------- artifacts --------------------------- */

  app.get('/api/nodes/:id/install-script', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const plan = buildInstallPlan(id);
      const reqUrl = panelUrlFor(req).url;
      if (!plan.customBase && plan.variant === 'custom') {
        plan.customBase = `${reqUrl.replace(/\/+$/, '')}/custom-frp`;
      }
      const script = renderInstallScript(plan, { panelUrl: reqUrl });
      reply
        .header('Content-Type', 'text/x-shellscript; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="frpc-install-${plan.node.installToken}.sh"`);
      return script;
    } catch (err) {
      return fail(reply, err, 404);
    }
  });

  app.get('/api/nodes/:id/frpc.toml', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const node = getNode(id);
      if (!node) return fail(reply, '节点不存在', 404);
      reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="frpc.toml"`);
      return renderFrpcTomlOnly(id);
    } catch (err) {
      return fail(reply, err, 404);
    }
  });

  /* --------------------- public one-click endpoints ------------------ */
  // These are intentionally unauthenticated: the per-node install token
  // embedded in the URL is the capability. Regenerate it to revoke access.

  app.get('/api/install/:token.sh', async (req, reply) => {
    const raw = (req.params as { token: string }).token;
    const token = raw.replace(/\.sh$/, '');
    const node = getNodeByToken(token);
    if (!node) return fail(reply, '安装 token 无效', 404);
    const plan = buildInstallPlan(node.id);
    reply.header('Content-Type', 'text/x-shellscript; charset=utf-8');
    const reqUrl = panelUrlFor(req).url;
    if (!plan.customBase && plan.variant === 'custom') {
      plan.customBase = `${reqUrl.replace(/\/+$/, '')}/custom-frp`;
    }
    return renderInstallScript(plan, { panelUrl: reqUrl });
  });

  /**
   * Windows 节点安装包。
   * 返回 .zip：内含 frpc.exe、frpc.toml、管理脚本与中文说明，
   * 用户解压后运行 frpc-manage.cmd install 即可（支持安装/启动/停止/开机自启/卸载）。
   */
  app.get('/api/nodes/:id/windows-package', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const node = getNode(id);
    if (!node) return fail(reply, '节点不存在', 404);

    const plan = buildInstallPlan(id);
    const exePath = await findWindowsFrpcExe();
    if (!exePath) {
      return fail(
        reply,
        '未找到 Windows 版定制 frpc.exe。请先构建：' +
          './custom-frp/build-custom-frp.sh --arches windows/amd64',
        503,
      );
    }

    try {
      const exe = await readWindowsExeCached(exePath);
      const pkg = buildWindowsPackage(plan, exe, {
        panelUrl: panelUrlFor(req).url,
      });
      reply
        .header('Content-Type', 'application/zip')
        .header('Content-Length', String(pkg.buffer.length))
        .header('Content-Disposition', `attachment; filename="${pkg.name}"`);
      return pkg.buffer;
    } catch (err) {
      return fail(reply, err, 500);
    }
  });

  /** 免鉴权版本：节点用安装 token 直接下载 Windows 包。 */
  app.get('/api/install/:token/windows', async (req, reply) => {
    const token = String((req.params as { token: string }).token);
    const node = getNodeByToken(token);
    if (!node) return fail(reply, '安装 token 无效', 404);

    const plan = buildInstallPlan(node.id);
    const exePath = await findWindowsFrpcExe();
    if (!exePath) {
      return fail(reply, '未找到 Windows 版定制 frpc.exe', 503);
    }
    const exe = await readWindowsExeCached(exePath);
    const pkg = buildWindowsPackage(plan, exe, { panelUrl: panelUrlFor(req).url });
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', String(pkg.buffer.length))
      .header('Content-Disposition', `attachment; filename="${pkg.name}"`);
    return pkg.buffer;
  });

  /** Windows 支持状态：是否已有 frpc.exe 可供分发。 */
  app.get('/api/nodes/:id/windows-status', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getNode(id)) return fail(reply, '节点不存在', 404);
    const exePath = await findWindowsFrpcExe();
    return { available: exePath !== null, exePath };
  });

  app.get('/api/install/:token/frpc.toml', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const node = getNodeByToken(token);
    if (!node) return fail(reply, '安装 token 无效', 404);
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return renderFrpcTomlOnly(node.id);
  });

  /* ---------------------------- heartbeat --------------------------- */
  // Fed by the customized frpc build (custom-frp/patches/files/frpc-heartbeat.go).
  // Unauthenticated like the installer: the install token is the capability.

  app.post('/api/heartbeat', async (req, reply) => {
    const result = recordHeartbeat((req.body ?? {}) as HeartbeatPayload, req.ip);
    if (!result.ok) {
      reply.code(result.status ?? 400).send({ ok: false, error: result.error });
      return;
    }
    return { ok: true, nodeId: result.nodeId };
  });

  app.get('/api/nodes/:id/heartbeat', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const node = getNode(id);
    if (!node) return fail(reply, '节点不存在', 404);
    return getNodeLiveStatus(id);
  });

  /* --------------------------- custom build -------------------------- */
  // Part C: drive custom-frp/build-custom-frp.sh from the panel.

  app.get('/api/custom-build/status', async () => getBuildStatus());

  app.post('/api/custom-build/start', async (req, reply) => {
    const body = (req.body ?? {}) as { version?: string };
    const version = String(body.version ?? DEFAULT_FRP_VERSION).replace(/^v/, '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      return fail(reply, '版本号格式应为 x.y.z');
    }
    const result = await startCustomBuild(version);
    if (!result.started) return fail(reply, result.error ?? '启动构建失败', 409);
    return result;
  });

  app.get('/api/custom-build/log', async () => {
    try {
      const log = await readBuildLog();
      return { log };
    } catch (err) {
      return { log: `读取构建日志失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  app.post('/api/custom-build/install', async (_req, reply) => {
    try {
      return await installCustomBinaries(BIN_DIR);
    } catch (err) {
      return fail(reply, err, 500);
    }
  });

  /* ------------------------------ mirrors --------------------------- */

  /**
   * Probe a GitHub proxy before the operator relies on it. Tests the asset
   * download path and, when requested, the API host (many proxies 403 it).
   */
  app.post('/api/mirrors/test', async (req, reply) => {
    const body = (req.body ?? {}) as { proxy?: string; testApi?: boolean };
    const proxy = normalizeProxy(body.proxy ?? getSettings().githubProxy);

    if (proxy && !isValidProxy(proxy)) {
      return fail(reply, '代理地址无效，应为 http(s):// 开头的 URL');
    }

    const version = DEFAULT_FRP_VERSION;
    const asset = assetName(version, process.arch, process.platform);
    const directUrl = `https://github.com/fatedier/frp/releases/download/v${version}/${asset}`;
    const downloadUrl = proxy ? `${proxy}/${directUrl}` : directUrl;

    const probe = async (url: string) => {
      try {
        const res = await fetch(url, {
          method: 'HEAD',
          redirect: 'follow',
          headers: { 'User-Agent': 'frp-console' },
          signal: AbortSignal.timeout(15_000),
        });
        const len = res.headers.get('content-length');
        return {
          ok: res.ok,
          status: res.status,
          detail: res.ok
            ? `${res.status}${len ? ` · ${(Number(len) / 1024 / 1024).toFixed(1)} MB` : ''}`
            : `${res.status} ${res.statusText}`,
        };
      } catch (err) {
        return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
      }
    };

    const download = await probe(downloadUrl);
    const api = body.testApi
      ? await probe(applyProxy('https://api.github.com/repos/fatedier/frp/releases/latest', proxy))
      : undefined;

    return { proxy: proxy || '(直连)', downloadUrl, download, api };
  });

  /* --------------------- custom binary distribution ------------------ */
  // Serves tuned builds in the archive layout the installer expects:
  //   /custom-frp/v<version>/frp_<base>_linux_<arch>.tar.gz
  // Unauthenticated like the installer: nodes fetch without panel credentials.

  app.get('/custom-frp/:file', async (req, reply) => {
    const file = String((req.params as { file: string }).file);

    // Only serve the exact names the installer asks for; this prevents path
    // traversal and keeps the surface minimal.
    const m =
      file.match(/^frp_(\d+\.\d+\.\d+)_linux_([A-Za-z0-9_]+)\.tar\.gz$/) ||
      file.match(/^frp_(\d+\.\d+\.\d+)_windows_([A-Za-z0-9_]+)\.zip$/);
    if (!m) {
      return fail(reply, '文件名格式应为 frp_<version>_<os>_<arch>.tar.gz 或 .zip', 400);
    }
    const [, baseVersion, arch] = m;

    const distDir = path.join(CUSTOM_DIR, 'dist');
    const candidates = [
      path.join(distDir, file),
      // Fall back to packing from custom-frp/out when dist/ was not prebuilt.
      null,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const buf = await fsp.readFile(candidate);
        const sha = createHash('sha256').update(buf).digest('hex');
        reply
          .header('Content-Type', 'application/gzip')
          .header('Content-Length', String(buf.length))
          .header('X-Checksum-Sha256', sha);
        return buf;
      }
    }

    // No prebuilt archive: pack the host build on demand, but only for the
    // architecture this machine can actually run/verify.
    const availability = await checkCustomAvailability(CUSTOM_DIR);
    if (!availability.available) {
      return fail(
        reply,
        `定制版不可用：${availability.reason}。${availability.fixHint ?? ''}`,
        503,
      );
    }
    if (arch !== hostAssetArch()) {
      return fail(
        reply,
        `未找到 ${arch} 架构的预构建包。请用 --all-arches 重新构建，或让节点使用与面板相同的架构。`,
        404,
      );
    }
    try {
      const workDir = path.join(TMP_DIR, 'dist');
      await fsp.mkdir(workDir, { recursive: true });
      const packed = await packCustomTarball({
        customDir: CUSTOM_DIR,
        version: customVersionString(baseVersion),
        arch,
        workDir,
      });
      const buf = await fsp.readFile(packed.file);
      reply
        .header('Content-Type', 'application/gzip')
        .header('Content-Length', String(buf.length))
        .header('X-Checksum-Sha256', packed.sha256);
      return buf;
    } catch (err) {
      return fail(reply, err, 500);
    }
  });

  /* ------------------------------ static ---------------------------- */

  if (fs.existsSync(PUBLIC_DIR)) {
    /**
     * 静态资源。
     *
     * 关键：面板升级后，浏览器若继续用**缓存的旧 app.js**，会出现
     * 「页面是新版、脚本是旧版」的错配——例如新增的函数不存在，点保存直接报错，
     * 表现为「设置无法保存」。所以：
     *   - index.html 不缓存，保证每次都拿到带最新版本戳的页面
     *   - app.js / style.css 用带版本号的 URL，可长期缓存且升级后自动失效
     */
    /**
     * 首页显式渲染：把 /app.js 与 /style.css 的引用替换为带版本戳的 URL。
     * 版本变化 → URL 变化 → 浏览器必然重新拉取，杜绝「新页面 + 旧脚本」错配。
     */
    app.get('/', async (_req, reply) => {
      const file = path.join(PUBLIC_DIR, 'index.html');
      const html = await fsp.readFile(file, 'utf8');
      const v = encodeURIComponent(panelVersion());
      const stamped = html
        .replace('href="/style.css"', `href="/style.css?v=${v}"`)
        .replace('src="/app.js"', `src="/app.js?v=${v}"`);
      reply.header('Cache-Control', 'no-cache, must-revalidate');
      reply.type('text/html; charset=utf-8');
      return stamped;
    });

    app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });

    /**
     * 静态资源的缓存策略。
     *
     * 用 onSend 而不是 @fastify/static 的 setHeaders：后者会被底层 send
     * 的默认值覆盖（实测仍是 max-age=0）。onSend 在响应发出前最后一刻执行，
     * 能确保生效。
     *
     * 为什么要版本戳：面板升级后若浏览器继续用缓存的旧 app.js，会出现
     * 「新页面 + 旧脚本」错配——新函数不存在，点保存直接报错，表现为
     * 「设置无法保存」。首页已把引用改写为 /app.js?v=<版本>，版本变化即
     * URL 变化，配合 immutable 长缓存既快又不会用错版本。
     */
    app.addHook('onSend', async (req, reply, payload) => {
      const url = (req.raw.url ?? '').split('?')[0] ?? '';
      if (url === '/' || url === '/index.html') {
        reply.header('Cache-Control', 'no-cache, must-revalidate');
      } else if (/\.(js|css)$/.test(url)) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return payload;
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    });
  }

  // Auth is enforced by the onRequest hook registered above.

  return app;
}

export async function startServer(): Promise<void> {
  ensureDirs();
  const app = buildServer();
  try {
    await app.listen({ host: PANEL_HOST, port: PANEL_PORT });
    const resolved = panelUrlFor();
    app.log.info(`frp-console listening on http://${PANEL_HOST}:${PANEL_PORT} (public: ${resolved.url})`);
    if (resolved.isGuess) {
      app.log.warn('面板公网地址为自动探测的内网 IP，外部节点将无法回连。请在「frps 设置」中填写公网地址。');
    }
    app.log.info(`面板登录账号: ${PANEL_USER}`);
    if (PANEL_PASSWORD === 'changeme') {
      app.log.warn('面板正在使用默认密码，请设置 FRP_CONSOLE_PASSWORD 环境变量后重启。');
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
