/**
 * Responsive layout verification (desktop / small desktop / mobile).
 * Logs in first because the panel is password protected.
 * Usage: node scripts/layout-check.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:37000';
const USER = process.env.PANEL_USER ?? 'admin';
const PASS = process.env.PANEL_PASSWORD ?? 'changeme';

const browser = await chromium.launch();
let bad = 0;

for (const [w, h, label] of [[1440, 900, '桌面'], [1024, 768, '小桌面'], [390, 844, '手机']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Login screen metrics.
  const login = await page.evaluate(() => {
    const de = document.documentElement;
    const card = document.querySelector('.login-card');
    return {
      overflowX: de.scrollWidth > de.clientWidth + 1,
      cardW: Math.round(card?.getBoundingClientRect().width || 0),
      visible: !!document.querySelector('#loginRoot')?.offsetParent,
    };
  });
  if (login.overflowX) bad++;

  // Authenticate, then measure the app shell.
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#appRoot:not(.hidden)', { timeout: 15000 });
  await page.waitForTimeout(600);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const card = document.querySelector('#page-dashboard .card');
    return {
      overflowX: de.scrollWidth > de.clientWidth + 1,
      scrollW: de.scrollWidth,
      clientW: de.clientWidth,
      cardW: Math.round(card?.getBoundingClientRect().width || 0),
      navCount: document.querySelectorAll('.nav-item').length,
      sidebarVisible: !!document.querySelector('.sidebar')?.offsetParent,
      logoutVisible: !!document.querySelector('.sidebar-foot button')?.offsetParent,
    };
  });
  if (m.overflowX) bad++;

  console.log(
    `${label} ${w}x${h}: 登录页[溢出=${login.overflowX} 卡片宽=${login.cardW}] ` +
    `主界面[溢出=${m.overflowX} scrollW=${m.scrollW} clientW=${m.clientW} 卡片宽=${m.cardW} ` +
    `导航=${m.navCount} 侧栏=${m.sidebarVisible} 退出按钮=${m.logoutVisible}]`,
  );
  await page.close();
}

await browser.close();
console.log(bad === 0 ? '\n\x1b[32m布局检查通过（无横向溢出）\x1b[0m\n' : `\n\x1b[31m${bad} 处横向溢出\x1b[0m\n`);
process.exit(bad ? 1 : 0);
