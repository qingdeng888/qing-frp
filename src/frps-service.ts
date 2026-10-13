import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BIN_DIR,
  FRPS_BIN_PATH,
  FRPS_BIN_PINNED,
  TMP_DIR,
  FRPS_CONFIG_PATH,
  FRPS_SERVICE_NAME,
  FRPS_SERVICE_PATH,
  SERVICE_MANAGER,
  SUPERVISORCTL,
  SUPERVISOR_INCLUDE_DIR,
  SUPERVISOR_LOG_DIR,
  SYSTEMD_ENABLED,
} from './config.js';
import {
  getServiceBackend,
  run as runCmd,
  type CommandResult,
  type ServiceStatus,
} from './service-backend.js';
import { renderFrpsToml, renderFrpsUnit } from './render.js';
import { getSettings } from './store.js';
import { DEFAULT_FRP_VERSION, mapArch, installedVersion } from './frp.js';
import { CUSTOM_DIR } from './custom-build.js';
import { CUSTOM_SUFFIX } from './variant.js';

const execFileAsync = promisify(execFile);

/** frps lifecycle: render config, install systemd unit, restart, report status. */

/**
 * Resolve the configured service backend (systemd / supervisor / none).
 * Cached after first call.
 */
async function backend() {
  return getServiceBackend({
    force: SERVICE_MANAGER,
    unitDir: path.dirname(FRPS_SERVICE_PATH),
    supervisorIncludeDir: SUPERVISOR_INCLUDE_DIR,
    supervisorLogDir: SUPERVISOR_LOG_DIR,
    supervisorctl: SUPERVISORCTL,
    binPath: FRPS_BIN_PATH,
    configPath: FRPS_CONFIG_PATH,
    serviceName: FRPS_SERVICE_NAME,
  });
}

/** Compatibility wrapper: skip everything when management is disabled. */
async function sh(cmd: string, args: string[], timeout = 30_000): Promise<CommandResult> {
  if (!SYSTEMD_ENABLED) {
    return { ok: true, command: [cmd, ...args].join(' '), stdout: '', stderr: '', code: 0, skipped: true };
  }
  return runCmd(cmd, args, timeout);
}

/**
 * Copy `src` onto `dest` without ever writing to an existing `dest`.
 *
 * `dest` may be the binary of a running service, in which case writing to it
 * directly fails with ETXTBSY. Writing a sibling temp file and renaming it
 * replaces the directory entry atomically; the running process keeps its old
 * inode until it restarts.
 */
export async function installBinaryAtomically(src: string, dest: string): Promise<void> {
  const dir = path.dirname(dest);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.new-${process.pid}-${Date.now()}`);
  try {
    await fsp.copyFile(src, tmp);
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    // Fall back to an explicit unlink+copy when rename is not permitted
    // (e.g. dest and tmp ended up on different filesystems).
    if ((err as NodeJS.ErrnoException).code === 'EXDEV' || (err as NodeJS.ErrnoException).code === 'EPERM') {
      await fsp.rm(dest, { force: true });
      await fsp.copyFile(src, dest);
      await fsp.chmod(dest, 0o755);
      return;
    }
    throw err;
  }
}


/**
 * Resolve the frps binary frp-console should run.
 *
 * Only our tuned build is supported: it adds the audit log and traffic quota.
 * The binary comes from custom-frp/out (after a build) or from a prebuilt
 * tarball in custom-frp/dist.
 */
async function resolveFrpsBinary(_settings: { githubProxy: string }): Promise<{
  path: string;
  version: string;
  source: 'custom';
  warning?: string;
}> {
  // frp-console ships only its own build; upstream frps is not supported.
  const candidates = [
    path.join(CUSTOM_DIR, 'out', 'frps'),
    path.join(CUSTOM_DIR, 'dist', `frp_${DEFAULT_FRP_VERSION}_linux_${mapArch()}`, 'frps'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const ver = await installedVersion(candidate);
    if (ver) return { path: candidate, version: ver, source: 'custom' };
  }

  // Auto-install from the panel's own prebuilt tarballs when available.
  const distTarball = path.join(CUSTOM_DIR, 'dist', `frp_${DEFAULT_FRP_VERSION}_linux_${mapArch()}.tar.gz`);
  if (fs.existsSync(distTarball)) {
    const extracted = await extractFrpsFromTarball(distTarball);
    if (extracted) return { path: extracted, version: (await installedVersion(extracted)) ?? 'unknown', source: 'custom' };
  }

  throw new Error(
    '未找到定制版 frps 二进制。请先在「定制构建」页点击「开始构建」，' +
    '或运行 custom-frp/build-custom-frp.sh（可用 --all-arches 预构建多架构）。',
  );
}

/** Extract just frps from a panel-built tarball into the bin directory. */
async function extractFrpsFromTarball(tarball: string): Promise<string | null> {
  const tmp = await fsp.mkdtemp(path.join(TMP_DIR, 'frps-extract-'));
  try {
    await execFileAsync('tar', ['-xzf', tarball, '-C', tmp], { timeout: 60_000 });
    const entries = await fsp.readdir(tmp, { withFileTypes: true });
    const dir = entries.find((e) => e.isDirectory());
    if (!dir) return null;
    const src = path.join(tmp, dir.name, 'frps');
    if (!fs.existsSync(src)) return null;
    const dest = path.join(BIN_DIR, `frps-${DEFAULT_FRP_VERSION}${CUSTOM_SUFFIX}`);
    await installBinaryAtomically(src, dest);
    return dest;
  } catch {
    return null;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface FrpsDeployResult {
  configPath: string;
  unitPath: string;
  binaryPath: string;
  binaryVersion: string;
  binarySource: 'custom' | 'download';
  /** Which service manager handled the deployment. */
  serviceManager: string;
  frpsToml: string;
  unit: string;
  steps: CommandResult[];
  warnings: string[];
}

/**
 * Write frps.toml + the systemd unit, download frps when missing, reload,
 * enable and restart the service.
 */
export async function deployFrps(): Promise<FrpsDeployResult> {
  const settings = getSettings();
  const warnings: string[] = [];
  const steps: CommandResult[] = [];
  const be = await backend();

  // Resolve the binary first so the definition can point straight at it. Only
  // copy when the operator pinned a custom path via FRP_CONSOLE_FRPS_BIN.
  const resolved = await resolveFrpsBinary(settings);
  if (resolved.warning) warnings.push(resolved.warning);
  const bin = { path: resolved.path, version: resolved.version };
  const needsCopy = FRPS_BIN_PINNED && path.resolve(bin.path) !== path.resolve(FRPS_BIN_PATH);
  const effectiveBinary = needsCopy ? FRPS_BIN_PATH : bin.path;

  const frpsToml = renderFrpsToml(settings);
  const unit = renderFrpsUnit(effectiveBinary);

  await fsp.mkdir(path.dirname(FRPS_CONFIG_PATH), { recursive: true });
  await fsp.writeFile(FRPS_CONFIG_PATH, frpsToml, 'utf8');

  if (needsCopy) {
    await installBinaryAtomically(bin.path, FRPS_BIN_PATH);
  }

  // Write the backend-specific definition, then bring the service up.
  await be.install(FRPS_SERVICE_NAME, {
    unitContent: unit,
    binPath: effectiveBinary,
    configPath: FRPS_CONFIG_PATH,
  });
  steps.push(await be.reload());
  steps.push(await be.enable(FRPS_SERVICE_NAME));
  steps.push(await be.restart(FRPS_SERVICE_NAME));

  if (be.kind === 'none') {
    warnings.push(
      '未检测到 systemd 或 supervisord，仅生成了配置。请自行启动 frps，例如：' +
        `${effectiveBinary} -c ${FRPS_CONFIG_PATH}`,
    );
  } else if (steps.some((s) => !s.ok && !s.skipped)) {
    warnings.push(`${be.label} 操作存在失败项，请检查下方命令输出。`);
  }

  return {
    configPath: FRPS_CONFIG_PATH,
    unitPath: be.definitionPath(FRPS_SERVICE_NAME),
    binaryPath: effectiveBinary,
    binaryVersion: bin.version,
    binarySource: resolved.source,
    serviceManager: be.kind,
    frpsToml,
    unit,
    steps,
    warnings,
  };
}

export async function frpsStatus(): Promise<ServiceStatus> {
  if (!SYSTEMD_ENABLED) {
    return {
      available: false, active: false, enabled: false, state: 'disabled-by-env',
      since: '', mainPid: null, memory: '', raw: '', backend: 'none',
    };
  }
  return (await backend()).status(FRPS_SERVICE_NAME);
}

export async function controlFrps(action: 'start' | 'stop' | 'restart' | 'reload'): Promise<CommandResult> {
  const be = await backend();
  switch (action) {
    case 'start':
      return be.start(FRPS_SERVICE_NAME);
    case 'stop':
      return be.stop(FRPS_SERVICE_NAME);
    case 'restart':
      return be.restart(FRPS_SERVICE_NAME);
    case 'reload':
      return be.reload();
  }
}

/** Recent frps logs from whichever backend is active. */
export async function frpsLogs(lines = 200): Promise<CommandResult> {
  return (await backend()).logs(FRPS_SERVICE_NAME, lines);
}

/** Which backend is managing frps, for the UI. */
export async function serviceBackendInfo(): Promise<{ kind: string; label: string; definitionPath: string }> {
  const be = await backend();
  return { kind: be.kind, label: be.label, definitionPath: be.definitionPath(FRPS_SERVICE_NAME) };
}

/** Validate a rendered frps.toml with `frps verify` before applying it. */
export async function verifyFrpsConfig(toml: string): Promise<CommandResult> {
  const tmp = path.join(TMP_DIR, `frps-verify-${Date.now()}.toml`);
  await fsp.mkdir(TMP_DIR, { recursive: true });
  try {
    await fsp.writeFile(tmp, toml, 'utf8');
    const r = await resolveFrpsBinary(getSettings());
    return await runCmd(r.path, ['verify', '-c', tmp], 20_000);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Paths reported to the UI.
 *
 * `unitPath` depends on the active backend (systemd unit vs supervisor include
 * vs nothing), so it is resolved dynamically rather than assumed.
 */
export async function frpsPaths(): Promise<{
  configPath: string;
  unitPath: string;
  binaryPath: string;
  serviceName: string;
  serviceManager: string;
  serviceManagerLabel: string;
}> {
  const be = await backend();
  return {
    configPath: FRPS_CONFIG_PATH,
    unitPath: be.definitionPath(FRPS_SERVICE_NAME),
    binaryPath: FRPS_BIN_PATH,
    serviceName: FRPS_SERVICE_NAME,
    serviceManager: be.kind,
    serviceManagerLabel: be.label,
  };
}
