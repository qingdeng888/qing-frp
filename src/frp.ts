import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BIN_DIR, TMP_DIR, ensureDirs } from './config.js';
import { applyProxy, resolveReleaseUrl } from './mirror.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_FRP_VERSION = '0.71.0';
const GITHUB_RELEASES = 'https://api.github.com/repos/fatedier/frp/releases';

export type FrpKind = 'frps' | 'frpc';

/** Map Node's arch identifiers onto frp's release asset names. */
export function mapArch(arch: string = process.arch): string {
  switch (arch) {
    case 'x64':
      return 'amd64';
    case 'arm64':
      return 'arm64';
    case 'arm':
      return 'arm';
    case 'ia32':
      return '386';
    case 'loong64':
      return 'loong64';
    case 'riscv64':
      return 'riscv64';
    case 'mips64el':
      return 'mips64le';
    default:
      return arch;
  }
}

export function assetName(version: string, arch: string = process.arch, goos = process.platform): string {
  return `frp_${normalizeVersion(version)}_${goos}_${mapArch(arch)}.tar.gz`;
}

export function normalizeVersion(version: string): string {
  const v = String(version).trim().replace(/^v/, '');
  // 空值是合法输入：调用方（buildInstallPlan）用空表示「未指定，走默认版本」。
  if (!v) return '';
  // 该值会被拼进下载 URL 与压缩包文件名（frp_<version>_linux_<arch>.tar.gz）。
  // 语义化版本 + 可选的 -console 后缀之外的一切都拒绝，防止路径穿越 / URL 注入。
  if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9]+)?$/.test(v)) {
    throw new Error(`frp 版本号格式不合法: ${JSON.stringify(String(version))}（应为 x.y.z 或 x.y.z-后缀）`);
  }
  return v;
}

export function downloadUrl(version: string, arch: string = process.arch, goos = process.platform): string {
  const v = normalizeVersion(version);
  return `https://github.com/fatedier/frp/releases/download/v${v}/${assetName(v, arch, goos)}`;
}

export interface ResolvedBinary {
  kind: FrpKind;
  version: string;
  path: string;
  downloaded: boolean;
}

function binaryPath(kind: FrpKind, version: string): string {
  return path.join(BIN_DIR, `${kind}-${normalizeVersion(version)}`);
}

export async function installedVersion(binPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 10_000 });
    // Keep any build suffix (e.g. "0.71.0-console") so tuned builds are
    // distinguishable from upstream ones.
    const m = stdout.trim().match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/);
    return m ? m[1] : stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Query GitHub for the newest frp release tag. Falls back to the bundled default.
 *
 * `apiProxy` is only used when the operator explicitly enabled API proxying,
 * because prefix proxies commonly reject api.github.com with 403.
 */
export async function fetchLatestVersion(
  apiProxy: { proxy?: string | null; useForApi?: boolean } = {},
): Promise<{ version: string; source: 'github' | 'fallback'; error?: string; url?: string }> {
  const base = apiProxy.useForApi ? applyProxy(GITHUB_RELEASES, apiProxy.proxy) : GITHUB_RELEASES;
  try {
    const res = await fetch(base, {
      headers: { 'User-Agent': 'frp-console', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = (await res.json()) as { tag_name?: string };
    const tag = String(data.tag_name ?? '');
    const m = tag.match(/(\d+\.\d+\.\d+)/);
    if (!m) throw new Error('无法解析版本号');
    return { version: m[1], source: 'github', url: base };
  } catch (err) {
    return {
      version: DEFAULT_FRP_VERSION,
      source: 'fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'frp-console' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
}

/**
 * Ensure a frps/frpc binary exists locally, downloading the release archive
 * from GitHub (or a mirror) when needed.
 */
export async function ensureBinary(
  kind: FrpKind,
  version: string,
  opts: { downloadBase?: string; githubProxy?: string; force?: boolean } = {},
): Promise<ResolvedBinary> {
  ensureDirs();
  const v = normalizeVersion(version || DEFAULT_FRP_VERSION);
  const target = binaryPath(kind, v);

  if (!opts.force && fs.existsSync(target)) {
    return { kind, version: v, path: target, downloaded: false };
  }

  const arch = mapArch();
  const goos = process.platform;
  const url = resolveReleaseUrl({
    version: v,
    asset: assetName(v, arch, goos),
    mirrorBase: opts.downloadBase,
    githubProxy: opts.githubProxy,
  });

  const workDir = await fsp.mkdtemp(path.join(TMP_DIR, `${kind}-`));
  const archive = path.join(workDir, 'frp.tar.gz');
  try {
    await downloadTo(url, archive);
    // Extract only the binary we need; the tarball also ships the other one.
    await execFileAsync('tar', ['-xzf', archive, '-C', workDir], { timeout: 120_000 });
    const entries = await fsp.readdir(workDir, { withFileTypes: true });
    const dir = entries.find((e) => e.isDirectory());
    if (!dir) throw new Error('压缩包结构异常：未找到解压目录');
    const extracted = path.join(workDir, dir.name, kind);
    if (!fs.existsSync(extracted)) throw new Error(`压缩包中未找到 ${kind}`);
    // Atomic swap: the target may be the running frps/frpc binary (ETXTBSY).
    const tmp = `${target}.new-${process.pid}-${Date.now()}`;
    await fsp.copyFile(extracted, tmp);
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, target);
    return { kind, version: v, path: target, downloaded: true };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Guarantee a `frps` binary exists at the canonical location used by the
 * generated systemd unit, and return its absolute path.
 */
export async function ensureFrpsBinary(version: string, downloadBase?: string, githubProxy?: string): Promise<ResolvedBinary> {
  return ensureBinary('frps', version, { downloadBase, githubProxy });
}

export function hostPlatformInfo(): { platform: string; arch: string; release: string; hostname: string } {
  return {
    platform: process.platform,
    arch: mapArch(),
    release: os.release(),
    hostname: os.hostname(),
  };
}
