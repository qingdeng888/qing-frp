import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Serve tuned frp builds to nodes.
 *
 * The panel cannot rewrite the upstream release layout, so it exposes its own
 * distribution endpoint. Install scripts point at it when the operator selects
 * the custom variant.
 *
 * Layout served here mirrors what the installer expects from a mirror base:
 *   <base>/v<version>/frp_<version>_linux_<arch>.tar.gz
 */

export const VARIANT_CUSTOM = 'custom';

/** frp-console only ships tuned builds; upstream binaries are not supported. */
export type Variant = typeof VARIANT_CUSTOM;

/**
 * Version string for tuned builds.
 *
 * The suffix marks a build as ours and lets the installer detect a stale
 * install. The base version stays parseable for archive naming.
 */
export const CUSTOM_SUFFIX = '-console';

export function customVersionString(baseVersion: string): string {
  const v = String(baseVersion).replace(/^v/, '').trim();
  return v.endsWith(CUSTOM_SUFFIX) ? v : `${v}${CUSTOM_SUFFIX}`;
}

/** Strip the tuned suffix to recover the upstream version. */
export function baseVersionOf(version: string): string {
  return String(version).replace(/^v/, '').replace(new RegExp(`${CUSTOM_SUFFIX}$`), '');
}

export function isCustomVersion(version: string): boolean {
  return String(version).includes(CUSTOM_SUFFIX);
}

/** frp asset architecture names for the host running the panel. */
export function hostAssetArch(arch: string = process.arch): string {
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

/** Every architecture the panel can prebuild and distribute. */
export const SUPPORTED_ARCHES = ['amd64', 'arm64', 'arm', '386', 'loong64', 'riscv64'] as const;

export type SupportedArch = (typeof SUPPORTED_ARCHES)[number];

/** Map a node's `uname -m` value to the asset architecture name. */
export function archFromUname(uname: string): string | null {
  const table: Record<string, string> = {
    x86_64: 'amd64',
    amd64: 'amd64',
    aarch64: 'arm64',
    arm64: 'arm64',
    armv7l: 'arm',
    armv6l: 'arm',
    i386: '386',
    i686: '386',
    loongarch64: 'loong64',
    riscv64: 'riscv64',
  };
  return table[uname.trim()] ?? null;
}

export interface VariantAvailability {
  variant: Variant;
  available: boolean;
  reason?: string;
  /** Actionable hint shown in the UI when unavailable. */
  fixHint?: string;
  frpsPath?: string;
  frpcPath?: string;
  frpsSize?: number;
  frpcSize?: number;
}

/**
 * Check whether the tuned binaries are present and look executable.
 * `customDir` is the resolved custom-frp directory.
 */
export async function checkCustomAvailability(customDir: string): Promise<VariantAvailability> {
  const outDir = path.join(customDir, 'out');
  const frpsPath = path.join(outDir, 'frps');
  const frpcPath = path.join(outDir, 'frpc');

  // Preference order:
  //   1. custom-frp/out         (a local build)
  //   2. custom-frp/dist/*.tar.gz (a prebuilt package; extract on demand)
  // This matters in containers, where only the shipped tarballs exist.
  if (fs.existsSync(frpsPath) && fs.existsSync(frpcPath)) {
    try {
      const [a, b] = await Promise.all([fsp.stat(frpsPath), fsp.stat(frpcPath)]);
      return {
        variant: VARIANT_CUSTOM,
        available: true,
        frpsPath,
        frpcPath,
        frpsSize: a.size,
        frpcSize: b.size,
      };
    } catch (err) {
      return {
        variant: VARIANT_CUSTOM,
        available: false,
        reason: `读取定制二进制失败: ${err instanceof Error ? err.message : String(err)}`,
        fixHint: '检查 custom-frp/out 目录权限，或重新构建',
      };
    }
  }

  const tarball = findHostTarball(customDir);
  if (tarball) {
    return {
      variant: VARIANT_CUSTOM,
      available: true,
      // Report the archive; callers that need a real path extract it first.
      frpsPath: tarball,
      frpcPath: tarball,
      frpsSize: (await fsp.stat(tarball)).size,
      frpcSize: 0,
    };
  }

  const missing = [
    !fs.existsSync(frpsPath) ? 'frps' : null,
    !fs.existsSync(frpcPath) ? 'frpc' : null,
  ].filter(Boolean).join(', ');
  return {
    variant: VARIANT_CUSTOM,
    available: false,
    reason: `缺少定制二进制: ${missing}，且 dist/ 下没有本机架构的预构建包`,
    fixHint: '运行 custom-frp/build-custom-frp.sh（可用 --all-arches 预构建多架构）',
  };
}

/** Locate the prebuilt tarball matching this host's architecture. */
export function findHostTarball(customDir: string, arch: string = hostAssetArch()): string | null {
  const distDir = path.join(customDir, 'dist');
  try {
    const match = fs
      .readdirSync(distDir)
      .filter((f) => f.endsWith(`_linux_${arch}.tar.gz`))
      .sort()
      .pop();
    return match ? path.join(distDir, match) : null;
  } catch {
    return null;
  }
}

/** Extract frps/frpc from a prebuilt tarball into a cache directory. */
export async function extractBinaries(
  tarball: string,
  destDir: string,
): Promise<{ frps: string; frpc: string } | null> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'frp-console-extract-'));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xzf', tarball, '-C', tmp]);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
    });
    const entries = await fsp.readdir(tmp, { withFileTypes: true });
    const dir = entries.find((e) => e.isDirectory());
    if (!dir) return null;

    await fsp.mkdir(destDir, { recursive: true });
    const out: { frps: string; frpc: string } = { frps: '', frpc: '' };
    for (const kind of ['frps', 'frpc'] as const) {
      const src = path.join(tmp, dir.name, kind);
      if (!fs.existsSync(src)) return null;
      const dest = path.join(destDir, kind);
      const tmpDest = `${dest}.new-${process.pid}`;
      await fsp.copyFile(src, tmpDest);
      await fsp.chmod(tmpDest, 0o755);
      await fsp.rename(tmpDest, dest);
      out[kind] = dest;
    }
    return out;
  } catch {
    return null;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface PackResult {
  file: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Pack a tuned binary into the archive layout the installer expects.
 * The tarball contains a top-level directory with frps/frpc inside.
 */
export async function packCustomTarball(opts: {
  customDir: string;
  version: string;
  arch?: string;
  workDir: string;
}): Promise<PackResult> {
  const arch = opts.arch ?? hostAssetArch();
  const base = baseVersionOf(opts.version);
  const outDir = path.join(opts.customDir, 'out');

  const stage = await fsp.mkdtemp(path.join(opts.workDir, 'pack-'));
  const inner = path.join(stage, `frp_${base}_linux_${arch}`);
  await fsp.mkdir(inner, { recursive: true });

  for (const kind of ['frps', 'frpc'] as const) {
    const src = path.join(outDir, kind);
    if (!fs.existsSync(src)) throw new Error(`缺少 ${kind}，请先构建定制版`);
    const dest = path.join(inner, kind);
    await fsp.copyFile(src, dest);
    await fsp.chmod(dest, 0o755);
  }

  const file = path.join(opts.workDir, `frp_${base}_linux_${arch}.tar.gz`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', file, '-C', stage, path.basename(inner)]);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
  });

  const buf = await fsp.readFile(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  await fsp.rm(stage, { recursive: true, force: true });

  return { file, sha256, sizeBytes: buf.length };
}

/** Human-readable summary for the UI. */
export function describeVariant(_v: Variant = VARIANT_CUSTOM): {
  label: string;
  features: string[];
  caveat?: string;
} {
  return {
    label: '定制版',
    features: ['frpc diag 诊断', 'frpc 心跳上报', 'frps 审计日志', 'frps 流量配额'],
    caveat: '需先用 custom-frp/build-custom-frp.sh 构建（可在「定制构建」页一键完成）',
  };
}

export function osLabel(): string {
  return os.platform();
}
