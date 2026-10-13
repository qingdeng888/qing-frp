/**
 * frp-console CLI — generate configs and install scripts without the web panel.
 *
 *   npx tsx src/cli.ts init
 *   npx tsx src/cli.ts settings --bind-port 7000 --token secret --range 20000-30000
 *   npx tsx src/cli.ts node add --name 香港节点 --addr 1.2.3.4
 *   npx tsx src/cli.ts proxy add --node 1 --name ssh --type tcp --local-port 22 --remote random
 *   npx tsx src/cli.ts install --node 1 > install.sh
 *   npx tsx src/cli.ts frps-toml
 */
import crypto from 'node:crypto';
import { ensureDirs } from './config.js';
import { ensureSettingsRow } from './db.js';
import { DEFAULT_FRP_VERSION } from './frp.js';
import { buildInstallPlan, renderInstallScript } from './installer.js';
import { renderFrpsToml, renderFrpsUnit } from './render.js';
import {
  createNode,
  createProxy,
  deleteNode,
  deleteProxy,
  getNode,
  getSettings,
  listNodes,
  listProxies,
  poolStats,
  rerollProxyPort,
  resolveNodeServerAddr,
  resolveNodeServerPort,
  updateSettings,
} from './store.js';
import type { ProxyType } from './types.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function need(name: string): string {
  const v = arg(name);
  if (v === undefined) {
    console.error(`缺少参数 --${name}`);
    process.exit(2);
  }
  return v;
}

function parseRanges(input: string | undefined): Array<{ start: number; end: number }> {
  if (!input) return [];
  return input.split(',').map((part) => {
    const [a, b] = part.split('-');
    return { start: Number(a), end: Number(b ?? a) };
  });
}

const HELP = `frp-console CLI

  init                                    初始化数据库
  settings [options]                      查看/修改 frps 设置
      --bind-port <n> --bind-addr <ip> --token <str>
      --range "20000-30000,40000"         设置允许的客户端端口范围
      --dashboard-port <n> --no-dashboard
  settings-show                           打印当前 frps 设置(JSON)
  frps-toml                               打印生成的 frps.toml
  frps-unit                               打印 systemd unit
  ports                                   打印端口池使用情况
  node list                               列出节点
  node add --name <n> --addr <ip> [--port <n>] [--token <t>] [--user <u>] [--protocol tcp|kcp|quic|websocket|wss]
  node rm --id <id>
  proxy list --node <id>
  proxy add --node <id> --name <n> --type <t> --local-port <n> [--local-ip <ip>] [--remote <n>|random] [--domain a.com,b.com]
  proxy rm --id <id>
  proxy reroll --id <id>
  install --node <id> [--panel-url http://host:8080]   输出一键安装脚本
  frpc-toml --node <id>                   输出节点的 frpc.toml
`;

function main() {
  ensureDirs();
  ensureSettingsRow(crypto.randomBytes(12).toString('hex'));

  // Re-derive positionals so `--flag value` pairs never look like commands.
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) i++;
      continue;
    }
    positional.push(argv[i]);
  }
  const command = positional[0];
  const subcommand = positional[1];

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return;

    case 'init':
      console.log('数据库已初始化。');
      return;

    case 'settings': {
      const patch: Record<string, unknown> = {};
      const bindPort = arg('bind-port');
      const bindAddr = arg('bind-addr');
      const token = arg('token');
      const range = arg('range');
      const dashPort = arg('dashboard-port');
      if (bindPort) patch.bindPort = Number(bindPort);
      if (bindAddr) patch.bindAddr = bindAddr;
      if (token) patch.authToken = token;
      if (range) patch.allowPorts = parseRanges(range);
      if (dashPort) {
        patch.dashboardEnabled = true;
        patch.dashboardPort = Number(dashPort);
      }
      if (flag('no-dashboard')) patch.dashboardEnabled = false;
      const { settings, warnings } = updateSettings(patch);
      for (const w of warnings) console.error(`警告: ${w}`);
      console.log(JSON.stringify(settings, null, 2));
      return;
    }

    case 'settings-show':
      console.log(JSON.stringify(getSettings(), null, 2));
      return;

    case 'frps-toml':
      process.stdout.write(renderFrpsToml(getSettings()));
      return;

    case 'frps-unit':
      process.stdout.write(renderFrpsUnit());
      return;

    case 'ports': {
      const stats = poolStats();
      console.log(`端口范围: ${stats.ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(', ') || '(未配置)'}`);
      console.log(`总量: ${stats.total}  已用: ${stats.used}  剩余: ${stats.free}`);
      console.log(`已用端口: ${stats.usedPorts.join(', ') || '(无)'}`);
      console.log(`服务端保留: ${stats.reservedByServer.join(', ') || '(无)'}`);
      return;
    }

    case 'node': {
      if (subcommand === 'list' || subcommand === undefined) {
        const nodes = listNodes();
        if (!nodes.length) {
          console.log('(无节点)');
          return;
        }
        for (const n of nodes) {
          const addr = resolveNodeServerAddr(n) || '(未设置地址)';
          const inherited = !String(n.serverAddr ?? '').trim() && !!resolveNodeServerAddr(n);
          console.log(
            `#${n.id}  ${n.name}  ${addr}:${resolveNodeServerPort(n)}${inherited ? ' (继承)' : ''}  代理数=${listProxies(n.id).length}  dir=${n.installDir}`,
          );
        }
        return;
      }
      if (subcommand === 'add') {
        const node = createNode({
          name: need('name'),
          serverAddr: arg('addr') ?? '',
          serverPort: arg('port') ? Number(arg('port')) : undefined,
          authToken: arg('token'),
          user: arg('user') ?? '',
          protocol: (arg('protocol') as never) ?? 'tcp',
        });
        console.log(`已创建节点 #${node.id} ${node.name}`);
        console.log(`安装 token: ${node.installToken}`);
        return;
      }
      if (subcommand === 'rm') {
        deleteNode(Number(need('id')));
        console.log('已删除。');
        return;
      }
      console.error(`未知 node 子命令: ${subcommand}`);
      process.exit(2);
    }

    case 'proxy': {
      const nodeId = Number(need('node'));
      if (subcommand === 'list') {
        const proxies = listProxies(nodeId);
        if (!proxies.length) {
          console.log('(无代理)');
          return;
        }
        for (const p of proxies) {
          const remote = p.remotePortRandom ? `随机:${p.remotePort ?? 0}` : p.type === 'tcp' || p.type === 'udp' ? String(p.remotePort ?? '-') : '-';
          console.log(`#${p.id}  ${p.name}  [${p.type}]  ${p.localIp}:${p.localPort} -> ${remote}  ${p.enabled ? '' : '(已禁用)'}`);
        }
        return;
      }
      if (subcommand === 'add') {
        const remote = arg('remote');
        const proxy = createProxy(nodeId, {
          name: need('name'),
          type: (arg('type') ?? 'tcp') as ProxyType,
          localIp: arg('local-ip') ?? '127.0.0.1',
          localPort: Number(arg('local-port') ?? 0),
          remotePortRandom: remote === 'random' || remote === undefined,
          remotePort: remote && remote !== 'random' ? Number(remote) : null,
          customDomains: arg('domain')?.split(','),
        });
        console.log(`已创建代理 #${proxy.id} ${proxy.name}，远端端口: ${proxy.remotePortRandom ? `随机 ${proxy.remotePort}` : proxy.remotePort}`);
        return;
      }
      if (subcommand === 'rm') {
        deleteProxy(Number(need('id')));
        console.log('已删除。');
        return;
      }
      if (subcommand === 'reroll') {
        const p = rerollProxyPort(Number(need('id')));
        console.log(`已重新分配: ${p.remotePort}`);
        return;
      }
      console.error(`未知 proxy 子命令: ${subcommand}`);
      process.exit(2);
    }

    case 'install': {
      const nodeId = Number(need('node'));
      const node = getNode(nodeId);
      if (!node) {
        console.error('节点不存在');
        process.exit(1);
      }
      const plan = buildInstallPlan(nodeId);
      process.stdout.write(renderInstallScript(plan, { panelUrl: arg('panel-url') ?? 'http://127.0.0.1:8080' }));
      return;
    }

    case 'frpc-toml': {
      const plan = buildInstallPlan(Number(need('node')));
      process.stdout.write(plan.frpcToml);
      return;
    }

    case 'version':
      console.log(`frp-console (frp ${DEFAULT_FRP_VERSION})`);
      return;

    default:
      console.error(`未知命令: ${command}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main();
