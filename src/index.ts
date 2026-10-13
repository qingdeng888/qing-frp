import { ensureDirs } from './config.js';
import { ensureSettingsRow } from './db.js';
import { startServer } from './server.js';
import { DEFAULT_FRP_VERSION } from './frp.js';
import { customVersionString, checkCustomAvailability } from './variant.js';
import { CUSTOM_DIR } from './custom-build.js';
import { getSettings, reconcileReservations } from './store.js';
import { sweepExpiredSessions } from './auth.js';
import { shortId } from './util.js';
import fs from 'node:fs';
import path from 'node:path';

/** Summarise whether the tuned binaries needed to run/deploy are present. */
async function describeLocalBinaries(): Promise<{ summary: string }> {
  const avail = await checkCustomAvailability(CUSTOM_DIR);
  if (!avail.available) {
    return { summary: `⚠ 定制二进制不可用（${avail.reason}）— 请在「定制构建」页构建` };
  }
  const distDir = path.join(CUSTOM_DIR, 'dist');
  let arches: string[] = [];
  try {
    arches = fs.readdirSync(distDir)
      .map((f) => f.match(/^frp_\d+\.\d+\.\d+_linux_([A-Za-z0-9_]+)\.tar\.gz$/)?.[1])
      .filter(Boolean) as string[];
  } catch { /* no dist */ }
  return {
    summary: arches.length
      ? `就绪，可分发架构: ${arches.sort().join(', ')}`
      : '就绪（尚无预构建分发包，仅能服务面板同架构）',
  };
}

/** frp-console entrypoint. */

async function main(): Promise<void> {
  ensureDirs();
  ensureSettingsRow(shortId(24));
  reconcileReservations();

  // Sessions live in SQLite; drop anything already expired on boot.
  const purged = sweepExpiredSessions();
  if (purged > 0) console.log(`[frp-console] 清理了 ${purged} 个过期登录会话`);

  // Keep the table tidy without blocking the event loop.
  const timer = setInterval(() => {
    try {
      sweepExpiredSessions();
    } catch (err) {
      console.error('[frp-console] 清理会话失败:', err);
    }
  }, 60 * 60 * 1000);
  timer.unref();

  // Report the tuned build's availability instead of querying GitHub: this
  // panel only ever distributes its own build.
  const binStatus = await describeLocalBinaries();
  console.log(`[frp-console] 定制版 frp v${customVersionString(DEFAULT_FRP_VERSION)} · ${binStatus.summary}`);

  await startServer();
}

main().catch((err) => {
  console.error('[frp-console] 启动失败:', err);
  process.exit(1);
});
