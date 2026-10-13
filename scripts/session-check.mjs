/**
 * Session persistence test.
 *
 * Proves the SQLite-backed session store survives a panel restart, that only
 * token hashes are persisted, and that logout/expiry still revoke access.
 *
 * Usage: node --disable-warning=ExperimentalWarning scripts/session-check.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const HOME = '/tmp/frp-session-test';
const PORT = 34588;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = process.env.PANEL_USER ?? 'admin';
const PASS = process.env.PANEL_PASSWORD ?? 'changeme';
const DB = path.join(HOME, 'data', 'panel.db');

let child = null;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
  }
}

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('面板未能在超时内启动');
}

async function startPanel() {
  child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'dist/index.js'],
    { env: { ...process.env, FRP_CONSOLE_HOME: HOME, FRP_CONSOLE_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitReady();
}

async function stopPanel() {
  if (!child) return;
  const dead = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([dead, new Promise((r) => setTimeout(r, 5000))]);
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 600));
  child = null;
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie.includes('frp_console_session='), `登录应下发会话 cookie，实际: ${res.headers.get('set-cookie')}`);
  return cookie;
}

async function authed(cookie, path = '/api/settings') {
  return fetch(`${BASE}${path}`, { headers: { cookie } });
}

console.log(`\n\x1b[1m会话持久化验证 @ ${BASE}\x1b[0m`);

await fsp.rm(HOME, { recursive: true, force: true });
await fsp.mkdir(HOME, { recursive: true });
await startPanel();

let cookie = '';

await test('登录成功并获得会话 cookie', async () => {
  cookie = await login();
  const res = await authed(cookie);
  assert.equal(res.status, 200);
});

await test('数据库中只存 token 哈希，不存明文', async () => {
  const token = cookie.split('=')[1];
  const db = new DatabaseSync(DB);
  const rows = db.prepare('SELECT token_hash, username FROM sessions').all();
  db.close();
  assert.ok(rows.length >= 1, '应存在会话记录');
  const plaintext = rows.find((r) => r.token_hash === token);
  assert.equal(plaintext, undefined, '不应存在明文 token 记录');
  const expected = crypto.createHash('sha256').update(token).digest('hex');
  assert.ok(rows.some((r) => r.token_hash === expected), '应存在该 token 的哈希记录');
});

await test('数据库中记录了登录用户名', async () => {
  const db = new DatabaseSync(DB);
  const row = db.prepare('SELECT username FROM sessions LIMIT 1').get();
  db.close();
  assert.equal(row.username, USER);
});

await test('重启面板后会话仍然有效（核心目标）', async () => {
  await stopPanel();
  await startPanel();
  const res = await authed(cookie);
  assert.equal(res.status, 200, `重启后应保持登录，实际 HTTP ${res.status}`);
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json();
  assert.equal(me.authenticated, true);
  assert.equal(me.username, USER);
});

await test('重启后仍能正常操作受保护接口', async () => {
  const res = await authed(cookie, '/api/nodes');
  assert.equal(res.status, 200);
});

await test('退出登录后会话立即失效', async () => {
  const out = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  const res = await authed(cookie);
  assert.equal(res.status, 401, '退出后应返回 401');
});

await test('退出后数据库中该会话已被删除', async () => {
  const db = new DatabaseSync(DB);
  const rows = db.prepare('SELECT COUNT(*) AS c FROM sessions').all();
  db.close();
  assert.equal(Number(rows[0].c), 0, '会话记录应被清理');
});

await test('伪造的 cookie 无法通过鉴权', async () => {
  const res = await authed('frp_console_session=deadbeef-not-a-real-token');
  assert.equal(res.status, 401);
});

await test('过期会话被拒绝并清理', async () => {
  // Inject an already-expired row, then confirm it is refused and swept.
  const db = new DatabaseSync(DB);
  const fake = 'expired-token-value';
  const hash = crypto.createHash('sha256').update(fake).digest('hex');
  db.prepare('INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?,?,?,?)')
    .run(hash, USER, Date.now() - 100000, Date.now() - 1000);
  db.close();

  const res = await authed(`frp_console_session=${fake}`);
  assert.equal(res.status, 401, '过期会话应 401');

  const db2 = new DatabaseSync(DB);
  const row = db2.prepare('SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?').get(hash);
  db2.close();
  assert.equal(Number(row.c), 0, '过期会话应被清除');
});

await test('Basic 鉴权在重启后依然可用', async () => {
  const res = await fetch(`${BASE}/api/settings`, {
    headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
  });
  assert.equal(res.status, 200);
});

await stopPanel();

console.log(`\n\x1b[1m结果: ${failed === 0 ? `\x1b[32m${passed} 通过` : `\x1b[31m${passed} 通过, ${failed} 失败`}\x1b[0m\n`);
process.exit(failed ? 1 : 0);
