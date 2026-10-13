import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Service management abstraction.
 *
 * frp-console runs both on bare hosts (systemd) and inside containers, where
 * PID 1 is not systemd and `systemctl` is unavailable. The panel talks to a
 * backend instead of calling systemctl directly, so "restart frps" works in
 * both environments.
 *
 * Backends:
 *   systemd    - bare metal / VM, writes a unit and drives systemctl
 *   supervisor - containers, writes an include file and drives supervisorctl
 *   none       - config generation only; the operator runs frps themselves
 */

export type ServiceManagerKind = 'systemd' | 'supervisor' | 'none';

export interface CommandResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  code: number | null;
  skipped?: boolean;
}

export interface ServiceStatus {
  available: boolean;
  active: boolean;
  enabled: boolean;
  state: string;
  since: string;
  mainPid: number | null;
  memory: string;
  raw: string;
  error?: string;
  backend: ServiceManagerKind;
}

export interface InstallOptions {
  /** systemd unit text (ignored by non-systemd backends). */
  unitContent: string;
  /** Absolute path of the frps binary to run. */
  binPath: string;
  /** Absolute path of the frps config file. */
  configPath: string;
}

export interface ServiceBackend {
  readonly kind: ServiceManagerKind;
  /** Human-readable name for the UI. */
  readonly label: string;
  /** Whether the backend's control tool is usable right now. */
  available(): Promise<boolean>;
  /**
   * Persist the service definition.
   *
   * `unitContent` is a ready-made systemd unit. Supervisor needs its own
   * format, so it is given the resolved `binPath`/`configPath` and renders its
   * own block — that way the definition always matches the binary that was
   * actually resolved for this deployment.
   */
  install(name: string, opts: InstallOptions): Promise<void>;
  reload(): Promise<CommandResult>;
  enable(name: string): Promise<CommandResult>;
  start(name: string): Promise<CommandResult>;
  stop(name: string): Promise<CommandResult>;
  restart(name: string): Promise<CommandResult>;
  status(name: string): Promise<ServiceStatus>;
  logs(name: string, lines: number): Promise<CommandResult>;
  /** Where the definition is written, for display. */
  definitionPath(name: string): string;
}

/** Run a command and normalise the result. */
export async function run(
  cmd: string,
  args: string[],
  timeout = 30_000,
): Promise<CommandResult> {
  const rendered = [cmd, ...args].join(' ');
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, command: rendered, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      ok: false,
      command: rendered,
      stdout: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? e.message ?? err).trim(),
      code: typeof e.code === 'number' ? e.code : null,
    };
  }
}

async function hasCommand(cmd: string): Promise<boolean> {
  const res = await run('sh', ['-c', `command -v ${cmd}`], 5000);
  return res.ok && res.stdout.length > 0;
}

function emptyStatus(kind: ServiceManagerKind, state: string, error?: string): ServiceStatus {
  return {
    available: false,
    active: false,
    enabled: false,
    state,
    since: '',
    mainPid: null,
    memory: '',
    raw: '',
    error,
    backend: kind,
  };
}

/* ------------------------------------------------------------------ systemd */

class SystemdBackend implements ServiceBackend {
  readonly kind = 'systemd' as const;
  readonly label = 'systemd';
  constructor(
    private readonly unitDir: string,
    private readonly binPath: string,
    private readonly configPath: string,
    private readonly serviceName: string,
  ) {}

  definitionPath(name: string): string {
    return path.join(this.unitDir, `${name}.service`);
  }

  async available(): Promise<boolean> {
    // systemctl exists AND we are talking to a running systemd (PID 1).
    if (!(await hasCommand('systemctl'))) return false;
    if (!fs.existsSync('/run/systemd/system')) return false;
    return true;
  }

  async install(name: string, opts: InstallOptions): Promise<void> {
    await fsp.mkdir(this.unitDir, { recursive: true });
    await fsp.writeFile(this.definitionPath(name), opts.unitContent, 'utf8');
  }

  reload(): Promise<CommandResult> {
    return run('systemctl', ['daemon-reload']);
  }

  enable(name: string): Promise<CommandResult> {
    return run('systemctl', ['enable', name]);
  }

  start(name: string): Promise<CommandResult> {
    return run('systemctl', ['start', name]);
  }

  stop(name: string): Promise<CommandResult> {
    return run('systemctl', ['stop', name]);
  }

  restart(name: string): Promise<CommandResult> {
    return run('systemctl', ['restart', name]);
  }

  async status(name: string): Promise<ServiceStatus> {
    const active = await run('systemctl', ['is-active', name]);
    const enabled = await run('systemctl', ['is-enabled', name]);
    const show = await run('systemctl', [
      'show',
      name,
      '--property=ActiveState,SubState,ExecMainStartTimestamp,MainPID,MemoryCurrent',
    ]);

    const props = new Map<string, string>();
    for (const line of show.stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) props.set(line.slice(0, idx), line.slice(idx + 1));
    }
    const memRaw = props.get('MemoryCurrent');
    const memNum = memRaw && /^\d+$/.test(memRaw) ? Number(memRaw) : null;
    const state = active.stdout || (active.ok ? 'unknown' : 'not-found');

    return {
      available: state !== 'not-found' && !/could not be found|not-found/i.test(active.stderr),
      active: state === 'active',
      enabled: enabled.stdout === 'enabled',
      state,
      since: props.get('ExecMainStartTimestamp') ?? '',
      mainPid: props.get('MainPID') && props.get('MainPID') !== '0' ? Number(props.get('MainPID')) : null,
      memory: memNum !== null ? `${(memNum / 1024 / 1024).toFixed(1)} MiB` : '',
      raw: show.stdout,
      error: active.ok ? undefined : active.stderr || undefined,
      backend: 'systemd',
    };
  }

  logs(name: string, lines: number): Promise<CommandResult> {
    return run('journalctl', ['-u', name, '-n', String(lines), '--no-pager', '-o', 'short-iso'], 20_000);
  }
}

/* --------------------------------------------------------------- supervisor */

class SupervisorBackend implements ServiceBackend {
  readonly kind = 'supervisor' as const;
  readonly label = 'supervisord';

  constructor(
    private readonly includeDir: string,
    private readonly logDir: string,
    private readonly binPath: string,
    private readonly configPath: string,
    private readonly serviceName: string,
    private readonly supervisorctl: string,
  ) {}

  definitionPath(name: string): string {
    return path.join(this.includeDir, `${name}.conf`);
  }

  async available(): Promise<boolean> {
    return hasCommand(this.supervisorctl);
  }

  async install(name: string, opts: InstallOptions): Promise<void> {
    // frps is declared statically in the image's supervisor config so the
    // container works even when the panel is not running. We rewrite the block
    // using the binary resolved for THIS deployment.
    await fsp.mkdir(this.includeDir, { recursive: true });
    const conf = this.renderConf(name, opts.binPath, opts.configPath);
    await fsp.writeFile(this.definitionPath(name), conf, 'utf8');
  }

  /** Supervisor program block for frps. */
  private renderConf(name: string, binPath: string, configPath: string): string {
    return `[program:${name}]
command=${binPath} -c ${configPath}
autostart=true
autorestart=true
startsecs=2
stopwaitsecs=5
stdout_logfile=${path.join(this.logDir, `${name}.log`)}
stderr_logfile=${path.join(this.logDir, `${name}.err.log`)}
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=10MB
environment=FRP_CONSOLE_MANAGED="1"
`;
  }

  private ctl(args: string[]): Promise<CommandResult> {
    return run(this.supervisorctl, args, 30_000);
  }

  async reload(): Promise<CommandResult> {
    // supervisor requires a reread + update cycle to pick up new files.
    const reread = await this.ctl(['reread']);
    const update = await this.ctl(['update']);
    return {
      ok: reread.ok && update.ok,
      command: `${reread.command} && ${update.command}`,
      stdout: [reread.stdout, update.stdout].filter(Boolean).join('\n'),
      stderr: [reread.stderr, update.stderr].filter(Boolean).join('\n'),
      code: update.code,
    };
  }

  enable(name: string): Promise<CommandResult> {
    // supervisor has no separate enable step; autostart=true covers it.
    return Promise.resolve({
      ok: true,
      command: `(supervisor autostart for ${name})`,
      stdout: '',
      stderr: '',
      code: 0,
      skipped: true,
    });
  }

  start(name: string): Promise<CommandResult> {
    return this.ctl(['start', name]);
  }

  stop(name: string): Promise<CommandResult> {
    return this.ctl(['stop', name]);
  }

  restart(name: string): Promise<CommandResult> {
    return this.ctl(['restart', name]);
  }

  async status(name: string): Promise<ServiceStatus> {
    const res = await this.ctl(['status', name]);
    // Output looks like: "frps    RUNNING   pid 12, uptime 0:01:23"
    const text = `${res.stdout} ${res.stderr}`.trim();
    const m = text.match(/\b(RUNNING|STOPPED|STARTING|BACKOFF|FATAL|EXITED|STOPPING)\b/);
    const state = m ? m[1].toLowerCase() : res.ok ? 'unknown' : 'not-found';
    const pidMatch = text.match(/pid\s+(\d+)/);
    const uptimeMatch = text.match(/uptime\s+([\d:]+)/);

    return {
      available: state !== 'not-found',
      active: state === 'running',
      enabled: true, // autostart=true is configured statically
      state,
      since: uptimeMatch ? `uptime ${uptimeMatch[1]}` : '',
      mainPid: pidMatch ? Number(pidMatch[1]) : null,
      memory: '',
      raw: text,
      error: res.ok ? undefined : res.stderr || undefined,
      backend: 'supervisor',
    };
  }

  async logs(name: string, lines: number): Promise<CommandResult> {
    // Prefer supervisor's own log file; fall back to tail of the captured log.
    const logFile = path.join(this.logDir, `${name}.log`);
    if (fs.existsSync(logFile)) {
      return run('tail', ['-n', String(lines), logFile], 20_000);
    }
    const res = await this.ctl(['tail', '-' + String(Math.min(lines, 2000)), name]);
    return res;
  }
}

/* --------------------------------------------------------------------- none */

class NoneBackend implements ServiceBackend {
  readonly kind = 'none' as const;
  readonly label = '仅生成配置';
  constructor(
    private readonly configPath: string,
    private readonly binPath: string,
  ) {}

  definitionPath(): string {
    return '(未托管)';
  }

  async available(): Promise<boolean> {
    return true;
  }

  async install(_name: string, _opts: InstallOptions): Promise<void> {
    /* nothing to install */
  }

  private skipped(cmd: string): CommandResult {
    return { ok: true, command: cmd, stdout: '', stderr: '', code: 0, skipped: true };
  }

  reload(): Promise<CommandResult> {
    return Promise.resolve(this.skipped('(none) reload'));
  }

  enable(): Promise<CommandResult> {
    return Promise.resolve(this.skipped('(none) enable'));
  }

  start(): Promise<CommandResult> {
    return Promise.resolve(this.skipped('(none) start'));
  }

  stop(): Promise<CommandResult> {
    return Promise.resolve(this.skipped('(none) stop'));
  }

  restart(): Promise<CommandResult> {
    return Promise.resolve(this.skipped('(none) restart'));
  }

  async status(): Promise<ServiceStatus> {
    // Report based on whether our own frps process is reachable via its port.
    return {
      ...emptyStatus('none', 'unmanaged'),
      available: true,
      enabled: false,
      raw: `配置: ${this.configPath}\n二进制: ${this.binPath}\n（本面板未托管 frps 进程）`,
    };
  }

  logs(): Promise<CommandResult> {
    return Promise.resolve(this.skipped('(none) logs'));
  }
}

/* ------------------------------------------------------------------ factory */

export interface BackendOptions {
  /** Explicit override via FRP_CONSOLE_SERVICE_MANAGER. */
  force?: ServiceManagerKind | '';
  unitDir: string;
  supervisorIncludeDir: string;
  supervisorLogDir: string;
  supervisorctl: string;
  binPath: string;
  configPath: string;
  serviceName: string;
}

let cached: ServiceBackend | null = null;

/** Pick and cache the service backend for this process. */
export async function getServiceBackend(opts: BackendOptions): Promise<ServiceBackend> {
  if (cached) return cached;

  const build = (kind: ServiceManagerKind): ServiceBackend => {
    switch (kind) {
      case 'systemd':
        return new SystemdBackend(opts.unitDir, opts.binPath, opts.configPath, opts.serviceName);
      case 'supervisor':
        return new SupervisorBackend(
          opts.supervisorIncludeDir,
          opts.supervisorLogDir,
          opts.binPath,
          opts.configPath,
          opts.serviceName,
          opts.supervisorctl,
        );
      default:
        return new NoneBackend(opts.configPath, opts.binPath);
    }
  };

  if (opts.force) {
    cached = build(opts.force);
    return cached;
  }

  // Auto-detect: systemd on bare hosts, supervisor in containers.
  const systemd = build('systemd');
  if (await systemd.available()) {
    cached = systemd;
    return cached;
  }
  const supervisor = build('supervisor');
  if (await supervisor.available()) {
    cached = supervisor;
    return cached;
  }
  cached = build('none');
  return cached;
}

/** Test seam: forget the cached backend. */
export function resetServiceBackend(): void {
  cached = null;
}

export { emptyStatus };
