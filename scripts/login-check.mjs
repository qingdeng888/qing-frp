/**
 * Login-flow verification for the panel.
 * Usage: node scripts/login-check.mjs [baseUrl] [user] [pass]
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.argv[2] ?? 'http://127.0.0.1:37000';
const USER = process.argv[3] ?? 'admin';
const PASS = process.argv[4] ?? 'changeme';

let failures = 0;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function check(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
  }
}

console.log(`\n\x1b[1m登录流程验证 @ ${BASE}\x1b[0m`);

await page.goto(BASE, { waitUntil: 'networkidle' });

await check('未登录时显示登录页，主应用隐藏', async () => {
  await page.waitForSelector('#loginRoot:not(.hidden)', { timeout: 10000 });
  assert.ok(await page.locator('#loginRoot').isVisible());
  assert.ok(!(await page.locator('#appRoot').isVisible()), '主应用不应可见');
});

await check('登录表单含账号/密码/登录按钮', async () => {
  assert.equal(await page.inputValue('#loginUser'), 'admin');
  assert.equal(await page.getAttribute('#loginPass', 'type'), 'password');
  assert.ok(await page.locator('#loginBtn').isVisible());
});

await check('错误密码显示错误提示且不放行', async () => {
  await page.fill('#loginPass', 'wrong-password');
  await page.click('#loginBtn');
  await page.waitForSelector('#loginError:not(.hidden)', { timeout: 8000 });
  const msg = await page.locator('#loginError').innerText();
  assert.match(msg, /账号或密码错误/);
  assert.ok(!(await page.locator('#appRoot').isVisible()), '错误密码不应进入主界面');
  assert.equal(await page.inputValue('#loginPass'), '', '密码框应被清空');
});

await check('正确账号密码可登录并进入主界面', async () => {
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#appRoot:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#loginRoot.hidden', { state: 'attached', timeout: 5000 });
  assert.ok(await page.locator('#appRoot').isVisible());
});

await check('登录后总览正常加载数据', async () => {
  await page.waitForFunction(() => {
    const el = document.getElementById('sysInfoKv');
    return el && !el.innerText.includes('…');
  }, { timeout: 15000 });
  const txt = await page.locator('#sysInfoKv').innerText();
  assert.match(txt, /frp 版本/);
});

await check('会话在刷新后保持（cookie 生效）', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#appRoot:not(.hidden)', { timeout: 12000 });
  assert.ok(!(await page.locator('#loginRoot').isVisible()));
});

await check('受保护的 API 已无法匿名访问', async () => {
  const anon = await browser.newContext();
  const p2 = await anon.newPage();
  const res = await p2.goto(`${BASE}/api/settings`);
  assert.equal(res.status(), 401);
  await anon.close();
});

await check('退出登录后回到登录页', async () => {
  await page.click('button:has-text("退出登录")');
  await page.waitForSelector('#loginRoot:not(.hidden)', { timeout: 10000 });
  const msg = await page.locator('#loginError').innerText();
  assert.match(msg, /已退出登录/);
});

await check('退出后刷新仍停留在登录页', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#loginRoot:not(.hidden)', { timeout: 10000 });
  assert.ok(!(await page.locator('#appRoot').isVisible()));
});

await check('无 JS 运行错误', async () => {
  assert.deepEqual(errors, [], errors.join('\n'));
});

await browser.close();
console.log(`\n\x1b[1m结果: ${failures === 0 ? '\x1b[32m全部通过' : `\x1b[31m${failures} 项失败`}\x1b[0m\n`);
process.exit(failures ? 1 : 0);
