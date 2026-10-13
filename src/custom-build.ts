import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HOME_DIR } from './config.js';
import { findHostTarball, extractBinaries } from './variant.js';
import { getSettings } from './store.js';

/**
 * Custom frp build driver (part C).
 *
 * Wraps custom-frp/build-custom-frp.sh so the panel can:
 *   - report whether a Go toolchain and the tuned binaries are present
 *   - trigger a build and stream its output
 *   - install the resulting binaries into the panel's bin directory
 *
 * Builds run as detached background processes; the panel exposes their log.
 */

/**
 * Locate custom-frp/. It normally sits next to the source tree (or the project
 * root when running from dist/), not inside FRP_CONSOLE_HOME, so probe the
 * usual candidates rather than assuming one layout.
 */
function resolveCustomDir(): string {
  const explicit = process.env.FRP_CONSOLE_CUSTOM_DIR;
  if (explicit && explicit.trim() !== '') return path.resolve(explicit.trim());

  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(HOME_DIR, 'custom-frp'),
    path.resolve(here, '..', 'custom-frp'), // src/ -> <root>/custom-frp (tsx)
    path.resolve(here, '..', '..', 'custom-frp'), // dist/src/ -> <root>/custom-frp
    path.resolve(process.cwd(), 'custom-frp'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'build-custom-frp.sh'))) return dir;
  }
  return candidates[0];
}

export const CUSTOM_DIR = resolveCustomDir();
export const CUSTOM_SCRIPT = path.join(CUSTOM_DIR, 'build-custom-frp.sh');
export const CUSTOM_OUT_DIR = path.join(CUSTOM_DIR, 'out');
export const CUSTOM_DIST_DIR = path.join(CUSTOM_DIR, 'dist');

const BUILD_LOG = path.join(HOME_DIR, 'data', 'custom-build.log');

export interface BuildStatus {
  scriptPresent: boolean;
  scriptPath: string;
  outDir: string;
  goToolchain: { present: boolean; path: string; version: string | null };
  binaries: {
    frps: { present: boolean; path: string; sizeBytes: number; builtAt: string | null };
    frpc: { present: boolean; path: string; sizeBytes: number; builtAt: string | null };
  };
  customFeatures: string[];
  running: boolean;
  lastBuildLogTail: string;
  mirrors: { githubProxy: string; goproxy: string; goDownloadBase: string };
  /** Architectures with a prebuilt tarball in custom-frp/dist. */
  prebuiltArches: string[];
  /** Tarballs available for distribution. */
  prebuiltPackages: { arch: string; file: string; sizeBytes: number }[];
}

let activeBuild: { pid: number; startedAt: number; version: string } | null = null;

async function fileInfo(p: string): Promise<{ present: boolean; path: string; sizeBytes: number; builtAt: string | null }> {
  try {
    const st = await fsp.stat(p);
    return { present: true, path: p, sizeBytes: st.size, builtAt: st.mtime.toISOString() };
  } catch {
    return { present: false, path: p, sizeBytes: 0, builtAt: null };
  }
}

async function goVersion(goPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(goPath, ['version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 8000);
  });
}

/** Detect which customizations are compiled into the built frpc. */
async function detectFeatures(frpcPath: string): Promise<string[]> {
  const features: string[] = [];
  if (!fs.existsSync(frpcPath)) return features;
  // `--help` is cheap and reveals the diag subcommand.
  const help = await new Promise<string>((resolve) => {
    const child = spawn(frpcPath, ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(out); }, 8000);
  });
  if (/\bdiag\b/.test(help)) features.push('frpc diag（连通性诊断）');

  // Heartbeat support is signalled by the env var name embedded in the binary.
  try {
    const buf = await fsp.readFile(frpcPath, { encoding: 'latin1' });
    if (buf.includes('FRP_CONSOLE_PANEL_URL')) features.push('frpc 心跳上报');
  } catch {
    /* ignore */
  }
  return features;
}

/** List prebuilt tarballs in custom-frp/dist. */
export async function listPrebuiltPackages(): Promise<{ arch: string; file: string; sizeBytes: number }[]> {
  try {
    const entries = await fsp.readdir(CUSTOM_DIST_DIR);
    const out: { arch: string; file: string; sizeBytes: number }[] = [];
    for (const name of entries) {
      const m = name.match(/^frp_\d+\.\d+\.\d+_linux_([A-Za-z0-9_]+)\.tar\.gz$/);
      if (!m) continue;
      const st = await fsp.stat(path.join(CUSTOM_DIST_DIR, name));
      out.push({ arch: m[1], file: name, sizeBytes: st.size });
    }
    return out.sort((a, b) => a.arch.localeCompare(b.arch));
  } catch {
    return [];
  }
}

export async function getBuildStatus(): Promise<BuildStatus> {
  const goPath = process.env.GO_BIN ?? '/opt/go/bin/go';
  const version = await goVersion(goPath).catch(() => null);
  let frpsPath = path.join(CUSTOM_OUT_DIR, 'frps');
  let frpcPath = path.join(CUSTOM_OUT_DIR, 'frpc');

  // Containers ship only the prebuilt tarballs (no custom-frp/out). Materialise
  // the host-arch pair into a cache directory so the status reports real
  // binaries and the feature probe can run.
  if (!fs.existsSync(frpsPath) || !fs.existsSync(frpcPath)) {
    const tarball = findHostTarball(CUSTOM_DIR);
    if (tarball) {
      const extracted = await extractBinaries(tarball, path.join(CUSTOM_OUT_DIR, '.cache'));
      if (extracted) {
        frpsPath = extracted.frps;
        frpcPath = extracted.frpc;
      }
    }
  }

  let logTail = '';
  try {
    const log = await fsp.readFile(BUILD_LOG, 'utf8');
    logTail = log.split('\n').slice(-40).join('\n');
  } catch {
    /* no build yet */
  }

  const settings = getSettings();
  const prebuilt = await listPrebuiltPackages();
  return {
    prebuiltArches: prebuilt.map((p) => p.arch),
    prebuiltPackages: prebuilt,
    mirrors: {
      githubProxy: settings.githubProxy,
      goproxy: settings.goproxy,
      goDownloadBase: settings.goDownloadBase,
    },
    scriptPresent: fs.existsSync(CUSTOM_SCRIPT),
    scriptPath: CUSTOM_SCRIPT,
    outDir: CUSTOM_OUT_DIR,
    goToolchain: { present: version !== null, path: goPath, version },
    binaries: {
      frps: await fileInfo(frpsPath),
      frpc: await fileInfo(frpcPath),
    },
    customFeatures: await detectFeatures(frpcPath),
    running: activeBuild !== null,
    lastBuildLogTail: logTail,
  };
}

export interface StartBuildResult {
  started: boolean;
  error?: string;
  version?: string;
  pid?: number;
}

/** Start a detached build, streaming output to the panel's build log. */
export async function startCustomBuild(version = '0.71.0'): Promise<StartBuildResult> {
  if (activeBuild) return { started: false, error: '已有构建在进行中' };
  if (!fs.existsSync(CUSTOM_SCRIPT)) {
    return { started: false, error: `未找到构建脚本: ${CUSTOM_SCRIPT}` };
  }

  await fsp.mkdir(path.dirname(BUILD_LOG), { recursive: true });
  const logStream = fs.createWriteStream(BUILD_LOG, { flags: 'w' });

  // Forward the panel's mirror configuration so builds work on hosts that
  // cannot reach GitHub directly.
  const settings = getSettings();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FRP_VERSION: version,
    BUILD_ROOT: process.env.BUILD_ROOT ?? '/opt/frp-build',
  };
  if (settings.githubProxy) env.GITHUB_PROXY = settings.githubProxy;
  if (settings.goproxy) env.GOPROXY = settings.goproxy;
  if (settings.goDownloadBase) env.GO_DOWNLOAD_BASE = settings.goDownloadBase;

  const child = spawn('bash', [CUSTOM_SCRIPT, '--version', version], {
    cwd: CUSTOM_DIR,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.unref();

  const pid = child.pid ?? 0;
  activeBuild = { pid, startedAt: Date.now(), version };

  child.on('exit', (code) => {
    logStream.write(`\n[panel] build finished with exit code ${code}\n`);
    logStream.end();
    activeBuild = null;
  });

  return { started: true, version, pid };
}

/** Copy the freshly built binaries into the panel's bin dir for deployment. */
export async function installCustomBinaries(binDir: string): Promise<{ installed: string[]; warnings: string[] }> {
  const installed: string[] = [];
  const warnings: string[] = [];
  for (const kind of ['frps', 'frpc'] as const) {
    const src = path.join(CUSTOM_OUT_DIR, kind);
    if (!fs.existsSync(src)) {
      warnings.push(`${kind} 尚未构建，跳过`);
      continue;
    }
    const dest = path.join(binDir, `${kind}-custom`);
    const tmp = `${dest}.new-${process.pid}`;
    await fsp.copyFile(src, tmp);
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, dest);
    installed.push(dest);
  }
  return { installed, warnings };
}

export function customBuildIsRunning(): boolean {
  return activeBuild !== null;
}
