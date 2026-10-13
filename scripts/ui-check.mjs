/**
 * Browser-level UI verification against a running panel.
 * Usage: node scripts/ui-check.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.argv[2] ?? 'http://127.0.0.1:37000';
const USER = process.env.PANEL_USER ?? 'admin';
const PASS = process.env.PANEL_PASSWORD ?? 'changeme';
const shots = [];
let failures = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
const badRequests = [];
page.on('response', async (res) => {
  // 401 from /api/auth/me is the expected logged-out probe.
  if (res.status() >= 400 && res.url().includes('/api/') && !res.url().includes('/api/auth/me')) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    badRequests.push(`${res.status()} ${res.request().method()} ${res.url()} :: ${body}`);
  }
});

// Unique per run so repeated runs never collide with leftover nodes/proxies.
const RUN = Date.now().toString(36).slice(-5);
const NODE_NAME = `UI节点-${RUN}`;

/** Pick an explicit remote port that the live frps config will accept. */
async function pickAllowedPort() {
  const cfg = await (await page.request.get(`${BASE}/api/settings`)).json();
  const pool = await (await page.request.get(`${BASE}/api/ports`)).json();
  const used = new Set(pool.usedPorts ?? []);
  for (const r of cfg.allowPorts ?? []) {
    for (let p = r.start; p <= r.end; p++) {
      if (!used.has(p)) return p;
    }
  }
  return null;
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
  }
}

/** Toasts auto-dismiss after ~3.2s; clear any leftovers before asserting. */
async function clearToasts() {
  await page.evaluate(() => { document.getElementById('toastRoot').innerHTML = ''; });
}

/** Wait for a toast whose text matches, ignoring stale ones. */
async function waitToast(re, timeout = 25000) {
  await page.waitForFunction(
    (src) => {
      const el = document.querySelector('.toast');
      return el && new RegExp(src).test(el.innerText);
    },
    re.source ?? String(re),
    { timeout },
  );
  return page.locator('.toast').first().innerText();
}

async function shot(name) {
  const file = `/tmp/ui-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  return file;
}

console.log(`\n\x1b[1m浏览器 UI 验证 @ ${BASE}\x1b[0m`);

await page.goto(BASE, { waitUntil: 'networkidle' });

// The panel is password protected: authenticate before exercising the app.
async function loginIfNeeded() {
  const onLogin = await page.locator('#loginRoot:not(.hidden)').count();
  if (!onLogin) return;
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#appRoot:not(.hidden)', { timeout: 15000 });
}

await check('页面标题正确', async () => {
  assert.match(await page.title(), /frp-console/);
});

await check('未登录时展示登录页', async () => {
  await page.waitForSelector('#loginRoot:not(.hidden)', { timeout: 10000 });
  assert.ok(await page.locator('#loginRoot').isVisible());
});

await check('使用 admin 账号登录成功', async () => {
  await loginIfNeeded();
  assert.ok(await page.locator('#appRoot').isVisible());
  assert.ok(!(await page.locator('#loginRoot').isVisible()));
});

await check('侧边栏导航齐备（含定制构建）', async () => {
  const items = await page.locator('.nav-item span:first-of-type').allInnerTexts();
  assert.deepEqual(items, ['总览', 'frps 设置', '端口范围', '节点管理', '定制构建']);
});

await check('总览页渲染 frps 状态（非"加载中"）', async () => {
  await page.waitForFunction(() => {
    const el = document.getElementById('frpsStatusBox');
    return el && !el.innerText.includes('加载中');
  }, { timeout: 15000 });
  const txt = await page.locator('#frpsStatusBox').innerText();
  assert.match(txt, /运行中|已停止|未安装/);
});

await check('总览统计卡片有数值', async () => {
  const nodes = await page.locator('#statNodes').innerText();
  const pool = await page.locator('#statPool').innerText();
  // 端口池必须渲染成 used/total；节点数允许为 0（空库场景）
  assert.match(pool, /\d+\/\d+/, `端口池应显示 used/total，实际 ${pool}`);
  assert.ok(Number(nodes) >= 0, `节点数应为数字，实际 ${nodes}`);
});

await check('环境信息显示 frp 版本', async () => {
  const txt = await page.locator('#sysInfoKv').innerText();
  assert.match(txt, /frp 版本/);
  assert.match(txt, /v\d+\.\d+\.\d+/);
});

await shot('01-dashboard');

/* ------------------------------------------------------------- frps 设置 */
await page.click('.nav-item[data-page="frps"]');
await page.waitForSelector('#page-frps.active');

await check('frps 设置页回填了当前值', async () => {
  // Read the live values instead of hardcoding, so the test survives config edits.
  const s = await (await page.request.get(`${BASE}/api/settings`)).json();
  // Wait for the form to populate rather than racing the fetch.
  await page.waitForFunction(
    (want) => document.getElementById('s_authToken')?.value === want,
    s.authToken,
    { timeout: 15000 },
  );
  const port = await page.inputValue('#s_bindPort');
  const token = await page.inputValue('#s_authToken');
  assert.equal(Number(port), s.bindPort);
  assert.equal(token, s.authToken);
});

await check('token 为空时拒绝保存（防止误清空 frps 密钥）', async () => {
  const original = await page.inputValue('#s_authToken');
  await page.fill('#s_authToken', '');
  await page.click('button:has-text("保存设置")');
  await page.waitForFunction(
    () => /auth\.token 不能为空/.test(document.getElementById('globalAlert')?.innerText || ''),
    { timeout: 8000 },
  );
  const alertText = await page.locator('#globalAlert').innerText();
  assert.match(alertText, /auth\.token 不能为空/);

  // The server value must be untouched.
  const live = await (await page.request.get(`${BASE}/api/settings`)).json();
  assert.equal(live.authToken, original, '拒绝保存后服务端 token 不应改变');

  await page.fill('#s_authToken', original);
  await page.evaluate(() => { document.getElementById('globalAlert').innerHTML = ''; });
});

await check('随机生成密钥可用', async () => {
  const before = await page.inputValue('#s_authToken');
  await page.click('button:has-text("随机生成")');
  const after = await page.inputValue('#s_authToken');
  assert.notEqual(before, after);
  assert.equal(after.length, 32);
  await page.fill('#s_authToken', before); // restore
});

await check('frps.toml 预览弹窗显示配置', async () => {
  await page.click('button:has-text("预览 frps.toml")');
  await page.waitForSelector('.modal pre.code');
  const code = await page.locator('.modal pre.code').innerText();
  const s = await (await page.request.get(`${BASE}/api/settings`)).json();
  assert.match(code, new RegExp(`bindPort = ${s.bindPort}`));
  assert.ok(code.includes(`auth.token = "${s.authToken}"`), '应包含当前 token');
  await shot('02-toml-preview');
  await page.click('.modal-actions button:has-text("关闭")');
});

await check('frps verify 校验通过', async () => {
  await clearToasts();
  await page.click('button:has-text("用 frps verify 校验")');
  const toast = await waitToast(/通过|合法/);
  assert.match(toast, /通过|合法/);
});

/* ------------------------------------------------------------- 端口范围 */
await page.click('.nav-item[data-page="ports"]');
await page.waitForSelector('#page-ports.active');

// This section must not depend on pre-existing configuration: the operator may
// have changed ports. Verify the page reflects whatever the API reports.
await check('端口范围页显示现有区间（与 API 一致）', async () => {
  const live = await (await page.request.get(`${BASE}/api/settings`)).json();
  const rows = await page.locator('#rangeList .range-row').count();
  assert.equal(rows, live.allowPorts.length, `区间数量应与 API 一致（${live.allowPorts.length}）`);
  if (live.allowPorts.length > 0) {
    const first = await page.locator('#rangeList .range-row input').first().inputValue();
    assert.equal(Number(first), live.allowPorts[0].start);
  }
});

await check('端口池统计与占用列表渲染（与 API 一致）', async () => {
  const pool = await (await page.request.get(`${BASE}/api/ports`)).json();
  const total = await page.locator('#poolTotal').innerText();
  assert.equal(Number(total), pool.total, '区间总量应与 API 一致');
  const used = await page.locator('#usedPortsBox').innerText();
  assert.ok(used.trim().length > 0, '应渲染占用列表');
});

await check('可添加并删除端口区间（草稿态）', async () => {
  const before = await page.locator('#rangeList .range-row').count();
  await page.click('button:has-text("+ 添加区间")');
  const after = await page.locator('#rangeList .range-row').count();
  assert.equal(after, before + 1);
  await page.locator('#rangeList .range-row button').last().click();
  assert.equal(await page.locator('#rangeList .range-row').count(), before);
});

await shot('03-ports');

/* ------------------------------------------------------------- 节点管理 */
await page.click('.nav-item[data-page="nodes"]');
await page.waitForSelector('#page-nodes.active');

// Build our own node + proxies so the checks never depend on prior state.
await check('创建测试节点（供本段用例使用）', async () => {
  await page.click('button:has-text("+ 新建节点")');
  await page.waitForSelector('.modal');
  await page.fill('#n_name', NODE_NAME);
  await page.fill('#n_serverAddr', `ui-${RUN}.example.com`);
  await page.click('.modal-actions button:has-text("保存")');
  await page.waitForFunction((n) => document.querySelector('#nodeList')?.innerText.includes(n), NODE_NAME, { timeout: 15000 });
  assert.match(await page.locator('#nodeList').innerText(), new RegExp(NODE_NAME));
});

await check('点击节点打开详情并显示代理表', async () => {
  await page.click(`#nodeList a:has-text("${NODE_NAME}")`);
  await page.waitForSelector('#nodeDetail:not(.hidden)');
  const kv = await page.locator('#nodeDetailKv').innerText();
  assert.match(kv, /frps 地址/);
  assert.match(kv, /curl -fsSL/, '详情应显示一键安装命令');
});

await check('代理表渲染类型与随机端口徽章', async () => {
  // Add one explicit and one random proxy so both renderings are covered.
  await page.click('button:has-text("+ 添加代理")');
  await page.waitForSelector('.modal');
  const fixedPort = await pickAllowedPort();
  assert.ok(fixedPort, '需要至少一个空闲端口用于本用例');
  await page.fill('#p_name', `fixed-${RUN}`);
  await page.selectOption('#p_type', 'tcp');
  await page.fill('#p_localPort', '8080');
  await page.uncheck('#p_remotePortRandom');
  await page.fill('#p_remotePort', String(fixedPort));
  await page.click('.modal-actions button:has-text("保存")');
  await page.waitForFunction((n) => document.querySelector('#proxyList')?.innerText.includes(n), `fixed-${RUN}`, { timeout: 15000 });

  await page.click('button:has-text("+ 添加代理")');
  await page.waitForSelector('.modal');
  await page.fill('#p_name', `rnd-${RUN}`);
  await page.selectOption('#p_type', 'tcp');
  await page.fill('#p_localPort', '8081');
  await page.check('#p_remotePortRandom');
  await page.click('.modal-actions button:has-text("保存")');
  await page.waitForFunction((n) => document.querySelector('#proxyList')?.innerText.includes(n), `rnd-${RUN}`, { timeout: 15000 });

  const txt = await page.locator('#proxyList').innerText();
  assert.match(txt, /tcp/);
  assert.match(txt, /随机 \d+/, '随机端口应显示徽章');
});

await shot('04-node-detail');

await check('打开添加代理弹窗并按类型切换字段', async () => {
  await page.click('button:has-text("+ 添加代理")');
  await page.waitForSelector('.modal');
  // tcp => remote box visible, http box hidden
  assert.ok(await page.locator('#remoteBox').isVisible());
  assert.ok(!(await page.locator('#httpBox').isVisible()));
  // switch to http => http box appears, remote box hides
  await page.selectOption('#p_type', 'http');
  assert.ok(await page.locator('#httpBox').isVisible());
  assert.ok(!(await page.locator('#remoteBox').isVisible()));
  // stcp => secret box appears
  await page.selectOption('#p_type', 'stcp');
  assert.ok(await page.locator('#secretBox').isVisible());
  await shot('05-proxy-modal');
  await page.click('.modal-actions button:has-text("取消")');
});

await check('远端端口默认可填写；勾选随机后被禁用', async () => {
  await page.click('button:has-text("+ 添加代理")');
  await page.waitForSelector('.modal');
  await page.selectOption('#p_type', 'tcp');
  // Default is an explicit port so the field is usable immediately.
  assert.ok(!(await page.locator('#p_remotePortRandom').isChecked()), '默认应不勾选随机');
  assert.ok(!(await page.locator('#p_remotePort').isDisabled()), '默认应可直接填写远端端口');
  await page.check('#p_remotePortRandom');
  assert.ok(await page.locator('#p_remotePort').isDisabled(), '勾选随机后应禁用输入');
  await page.uncheck('#p_remotePortRandom');
  assert.ok(!(await page.locator('#p_remotePort').isDisabled()));
  await page.click('.modal-actions button:has-text("取消")');
});

await check('代理弹窗实时预览生成的 [[proxies]] 段', async () => {
  await page.click('button:has-text("+ 添加代理")');
  await page.waitForSelector('.modal');
  await page.selectOption('#p_type', 'tcp');
  await page.fill('#p_name', `preview-${RUN}`);
  await page.fill('#p_localPort', '22');
  await page.uncheck('#p_remotePortRandom');
  const previewPort = (await pickAllowedPort()) ?? 22022;
  await page.fill('#p_remotePort', String(previewPort));
  // Live preview is debounced; wait for the rendered block.
  await page.waitForFunction(
    (want) => (document.getElementById('p_previewToml')?.innerText || '').includes(`remotePort = ${want}`),
    previewPort,
    { timeout: 10000 },
  );
  const toml = await page.locator('#p_previewToml').innerText();
  assert.match(toml, /\[\[proxies\]\]/);
  assert.match(toml, new RegExp(`name = "preview-${RUN}"`));
  assert.match(toml, /type = "tcp"/);
  assert.match(toml, /localIP = "127\.0\.0\.1"/);
  assert.match(toml, /localPort = 22/);
  assert.match(toml, new RegExp(`remotePort = ${previewPort}`));
  await page.click('.modal-actions button:has-text("取消")');
});

await check('切换到随机时预览给出端口说明', async () => {
  await page.click('button:has-text("+ 添加代理")');
  await page.waitForSelector('.modal');
  await page.selectOption('#p_type', 'tcp');
  await page.check('#p_remotePortRandom');
  await page.waitForFunction(
    () => /随机分配|无空闲端口/.test(document.getElementById('p_previewNote')?.innerText || ''),
    { timeout: 10000 },
  );
  const note = await page.locator('#p_previewNote').innerText();
  assert.match(note, /随机分配|无空闲端口/);
  await page.click('.modal-actions button:has-text("取消")');
});

await check('通过 UI 新增的节点与代理已持久化', async () => {
  const nodes = await (await page.request.get(`${BASE}/api/nodes`)).json();
  const created = nodes.find((n) => n.name === NODE_NAME);
  assert.ok(created, '新建的节点应出现在 API 中');
  const detail = await (await page.request.get(`${BASE}/api/nodes/${created.id}`)).json();
  const names = detail.proxies.map((p) => p.name);
  assert.ok(names.includes(`fixed-${RUN}`), '固定端口代理应已保存');
  assert.ok(names.includes(`rnd-${RUN}`), '随机端口代理应已保存');
});

await shot('06-new-node-proxy');

await check('一键安装脚本弹窗含一行命令与内嵌配置', async () => {
  await page.click('#nodeDetail button:has-text("一键安装脚本")');
  await page.waitForSelector('.modal pre.code', { timeout: 15000 });
  const info = await page.locator('.modal .alert.info').innerText();
  assert.match(info, /curl -fsSL .*\/api\/install\/.+\.sh \| sudo bash/);
  const code = await page.locator('.modal pre.code').innerText();
  assert.match(code, /#!\/usr\/bin\/env bash/);
  assert.match(code, /systemctl enable/);
  assert.match(code, /base64 -d/);
  await shot('07-install-script');
  await page.click('.modal-actions button:has-text("关闭")');
});

await check('frpc.toml 弹窗含多个 [[proxies]]', async () => {
  await page.click('#nodeDetail button:has-text("frpc.toml")');
  await page.waitForSelector('.modal pre.code', { timeout: 15000 });
  const code = await page.locator('.modal pre.code').innerText();
  assert.match(code, /\[\[proxies\]\]/);
  assert.match(code, new RegExp(`serverAddr = "ui-${RUN}\\.example\\.com"`));
  await page.click('.modal-actions button:has-text("关闭")');
});

await check('删除 UI 新建的节点', async () => {
  page.once('dialog', (d) => d.accept());
  await page.click(`#nodeList tr:has-text("${NODE_NAME}") button:has-text("删除")`);
  await page.waitForFunction((n) => !document.querySelector('#nodeList')?.innerText.includes(n), NODE_NAME, { timeout: 15000 });
});


await check('定制构建页展示环境与已构建二进制', async () => {
  await page.click('.nav-item[data-page="build"]');
  await page.waitForSelector('#page-build.active');
  await page.waitForFunction(() => {
    const el = document.getElementById('buildEnvKv');
    return el && !el.innerText.includes('…');
  }, { timeout: 15000 });
  const env = await page.locator('#buildEnvKv').innerText();
  assert.match(env, /构建脚本/);
  assert.match(env, /Go 工具链/);
  const features = await page.locator('#buildFeatures').innerText();
  assert.match(features, /diag|心跳|未检测/, `定制功能应可见，实际: ${features}`);
});

await check('节点列表渲染（有节点时应显示在线/离线徽章）', async () => {
  await page.click('.nav-item[data-page="nodes"]');
  await page.waitForSelector('#page-nodes.active');
  await page.waitForTimeout(800);
  const txt = await page.locator('#nodeList').innerText();
  const rows = await page.locator('#nodeList tbody tr').count();
  if (rows === 0) {
    assert.match(txt, /还没有节点/, '空库应显示引导文案');
  } else {
    assert.match(txt, /在线|离线/, '有节点时应显示在线/离线徽章');
  }
});

await check('无 JS 控制台错误', async () => {
  assert.deepEqual(badRequests, [], `API 错误响应:\n${badRequests.join('\n')}`);
  const real = consoleErrors.filter((e) => !/favicon/i.test(e));
  assert.deepEqual(real, [], `控制台错误:\n${real.join('\n')}`);
});

// Always remove nodes this run created, even if an earlier check threw.
try {
  const nodes = await (await page.request.get(`${BASE}/api/nodes`)).json();
  for (const n of nodes) {
    if (n.name === NODE_NAME) {
      await page.request.delete(`${BASE}/api/nodes/${n.id}`);
      console.log(`  (清理测试节点 ${n.name})`);
    }
  }
} catch { /* best effort */ }

await browser.close();

console.log(`\n截图: ${shots.join(', ')}`);
console.log(`\x1b[1m结果: ${failures === 0 ? '\x1b[32m全部通过' : `\x1b[31m${failures} 项失败`}\x1b[0m\n`);
process.exit(failures ? 1 : 0);
