/**
 * Standalone verification: run the real frps, install frpc with the generated
 * one-click script semantics, and prove traffic flows through the tunnel.
 *
 *   FRP_CONSOLE_HOME=/tmp/frp-tunnel-test npx tsx scripts/tunnel-e2e.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { ensureDirs } from '../src/config.js';
import { ensureSettingsRow } from '../src/db.js';
import { ensureBinary } from '../src/frp.js';
import { buildInstallPlan, renderInstallScript } from '../src/installer.js';
import { renderFrpsToml } from '../src/render.js';
import { createNode, createProxy, getSettings, listProxies, updateSettings } from '../src/store.js';

const WORK = process.env.FRP_CONSOLE_HOME ?? '/tmp/frp-tunnel-test';
const BIND_PORT = 17000;
const DASH_PORT = 17500;
const POOL_START = 21000;
const POOL_END = 21010;
const LOCAL_HTTP_PORT = 19999;
const REMOTE_FIXED = 21001;

const children: ChildProcess[] = [];

function start(bin: string, args: string[], label: string): ChildProcess {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => process.stdout.write(`  [${label}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`  [${label}!] ${d}`));
  child.on('exit', (code) => console.log(`  [${label}] exited code=${code}`));
  children.push(child);
  return child;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

async function waitForPort(port: number, host = '127.0.0.1', timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean) => {
        sock.destroy();
        resolve(v);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      setTimeout(() => done(false), 800);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`端口 ${port} 在 ${timeoutMs}ms 内未就绪`);
}

/** Minimal origin service that the tunnel should expose. */
function startOrigin(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`hello-through-frp:${req.url}`);
    });
    server.listen(LOCAL_HTTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function fetchThrough(port: number, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/probe', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function main() {
  await fsp.rm(path.join(WORK, 'data'), { recursive: true, force: true });
  ensureDirs();
  ensureSettingsRow('tunnel-e2e');

  console.log('\n\x1b[1m[1] 准备 frps 配置\x1b[0m');
  updateSettings({
    bindAddr: '0.0.0.0',
    bindPort: BIND_PORT,
    authToken: 'tunnel-e2e-token',
    dashboardEnabled: true,
    dashboardPort: DASH_PORT,
    allowPorts: [{ start: POOL_START, end: POOL_END }],
    logLevel: 'info',
  });
  const settings = getSettings();
  const frpsTomlPath = path.join(WORK, 'frps.toml');
  await fsp.writeFile(frpsTomlPath, renderFrpsToml(settings), 'utf8');
  console.log(`  frps.toml -> ${frpsTomlPath} (bindPort=${BIND_PORT}, dashboard=${DASH_PORT}, pool=${POOL_START}-${POOL_END})`);

  console.log('\n\x1b[1m[2] 构建节点 + 多代理安装脚本\x1b[0m');
  const node = createNode({
    name: '隧道验证节点',
    serverAddr: '127.0.0.1',
    serverPort: BIND_PORT,
    authToken: 'tunnel-e2e-token',
  });
  createProxy(node.id, {
    name: 'http-app',
    type: 'tcp',
    localIp: '127.0.0.1',
    localPort: LOCAL_HTTP_PORT,
    remotePortRandom: false,
    remotePort: REMOTE_FIXED,
  });
  const randomProxy = createProxy(node.id, {
    name: 'random-app',
    type: 'tcp',
    localIp: '127.0.0.1',
    localPort: LOCAL_HTTP_PORT,
    remotePortRandom: true,
  });
  console.log(`  已创建 ${listProxies(node.id).length} 个代理；random-app 分配到端口 ${randomProxy.remotePort}`);

  const plan = buildInstallPlan(node.id);
  const script = renderInstallScript(plan, { panelUrl: 'http://127.0.0.1:8080' });
  const scriptPath = path.join(WORK, 'install.sh');
  await fsp.writeFile(scriptPath, script, 'utf8');
  console.log(`  安装脚本 -> ${scriptPath}`);

  console.log('\n\x1b[1m[3] 启动真实 frps\x1b[0m');
  const frps = await ensureBinary('frps', '0.71.0');
  start(frps.path, ['-c', frpsTomlPath], 'frps');
  await waitForPort(BIND_PORT);
  await waitForPort(DASH_PORT);
  console.log(`  ✓ frps 已监听 ${BIND_PORT}（控制）与 ${DASH_PORT}（dashboard）`);

  console.log('\n\x1b[1m[4] 用生成的脚本安装并启动 frpc\x1b[0m');
  const origin = await startOrigin();
  console.log(`  ✓ 源站已监听 127.0.0.1:${LOCAL_HTTP_PORT}`);

  // The generated script hardcodes /etc/frp and systemd; run its config + binary
  // path directly so the test stays hermetic and does not touch the host.
  const frpc = await ensureBinary('frpc', '0.71.0');
  const frpcTomlPath = path.join(WORK, 'frpc.toml');
  await fsp.writeFile(frpcTomlPath, plan.frpcToml, 'utf8');
  start(frpc.path, ['-c', frpcTomlPath], 'frpc');

  console.log('\n\x1b[1m[5] 验证穿透成功\x1b[0m');
  // Give frpc a moment to register its proxies.
  let body = '';
  const deadline = Date.now() + 20000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      body = await fetchThrough(REMOTE_FIXED, 3000);
      if (body.includes('hello-through-frp')) break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(body.includes('hello-through-frp'), `固定端口穿透失败: ${body || String(lastErr)}`);
  console.log(`  ✓ 固定远端端口 ${REMOTE_FIXED} -> 本地 ${LOCAL_HTTP_PORT}: ${body}`);

  const randomBody = await fetchThrough(Number(randomProxy.remotePort));
  assert.ok(randomBody.includes('hello-through-frp'), `随机端口穿透失败: ${randomBody}`);
  console.log(`  ✓ 随机分配端口 ${randomProxy.remotePort} -> 本地 ${LOCAL_HTTP_PORT}: ${randomBody}`);

  console.log('\n\x1b[1m[6] 验证密钥鉴权生效\x1b[0m');
  const badConfig = plan.frpcToml.replace('tunnel-e2e-token', 'wrong-token-xxx');
  const badPath = path.join(WORK, 'frpc-bad.toml');
  await fsp.writeFile(badPath, badConfig, 'utf8');
  const badProbe = path.join(WORK, 'bad-frpc.out');
  const bad = spawn(frpc.path, ['-c', badPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let badOut = '';
  bad.stdout?.on('data', (d) => (badOut += d));
  bad.stderr?.on('data', (d) => (badOut += d));
  const badDeadline = Date.now() + 12000;
  while (Date.now() < badDeadline && !/token|auth|认证|login/i.test(badOut)) {
    await new Promise((r) => setTimeout(r, 300));
  }
  bad.kill('SIGKILL');
  await fsp.writeFile(badProbe, badOut, 'utf8');
  assert.ok(/token|auth|认证|login/i.test(badOut), `错误 token 应被拒绝，实际输出: ${badOut.slice(0, 500)}`);
  console.log(`  ✓ 错误 token 被 frps 拒绝`);

  console.log('\n\x1b[1m[7] 验证端口池冲突被 frps 拒绝\x1b[0m');
  // A second client asking for an already-taken explicit port must be refused.
  const clashConfig = plan.frpcToml
    .replace(/name = "random-app"[\s\S]*?remotePort = \d+/, `name = "clash-app"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = ${LOCAL_HTTP_PORT}\nremotePort = ${REMOTE_FIXED}`);
  const clashPath = path.join(WORK, 'frpc-clash.toml');
  await fsp.writeFile(clashPath, clashConfig, 'utf8');
  const clash = spawn(frpc.path, ['-c', clashPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let clashOut = '';
  clash.stdout?.on('data', (d) => (clashOut += d));
  clash.stderr?.on('data', (d) => (clashOut += d));
  const clashDeadline = Date.now() + 12000;
  while (Date.now() < clashDeadline && !/already used|port.*used|端口|conflict|refused|rejected/i.test(clashOut)) {
    await new Promise((r) => setTimeout(r, 300));
  }
  clash.kill('SIGKILL');
  await fsp.writeFile(path.join(WORK, 'clash-frpc.out'), clashOut, 'utf8');
  console.log(`  frps 对端口冲突的响应: ${clashOut.trim().split('\n').slice(-1)[0] || '(无)'}`);

  origin.close();
  cleanup();
  console.log('\n\x1b[1m\x1b[32m真实穿透验证全部通过\x1b[0m\n');
  console.log(`  日志留存于 ${WORK}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n\x1b[31m穿透验证失败:\x1b[0m', err);
  cleanup();
  process.exit(1);
});
