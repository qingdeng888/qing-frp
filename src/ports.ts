import type { PortRange } from './types.js';

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/**
 * Port pool: normalises `allowPorts` ranges, tracks which ports are already
 * taken and picks random ports out of the frps-configured ranges.
 */

export function isValidPort(value: unknown): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

/** Parse a JSON-encoded allowPorts array coming from the database. */
export function parseRanges(raw: unknown): PortRange[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeRanges(parsed as PortRange[]);
  } catch {
    return [];
  }
}

/**
 * Validate, clamp and merge overlapping/adjacent ranges into a canonical list.
 * Throws when a range is malformed so the API can surface a clear error.
 */
export function normalizeRanges(input: PortRange[]): PortRange[] {
  const cleaned: PortRange[] = [];
  for (const item of input ?? []) {
    const start = Number(item?.start);
    const end = Number(item?.end ?? item?.start);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`端口范围必须是整数: ${JSON.stringify(item)}`);
    }
    if (!isValidPort(start) || !isValidPort(end)) {
      throw new Error(`端口范围必须在 ${MIN_PORT}-${MAX_PORT} 之间: ${start}-${end}`);
    }
    if (start > end) {
      throw new Error(`端口范围起始值不能大于结束值: ${start}-${end}`);
    }
    cleaned.push({ start, end });
  }
  if (cleaned.length === 0) return [];

  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PortRange[] = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i++) {
    const cur = cleaned[i];
    const last = merged[merged.length - 1];
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

export function rangesToToml(ranges: PortRange[]): string {
  if (!ranges.length) return '[]';
  const parts = ranges.map((r) =>
    r.start === r.end ? `{ single = ${r.start} }` : `{ start = ${r.start}, end = ${r.end} }`,
  );
  return `[\n${parts.map((p) => `  ${p},`).join('\n')}\n]`;
}

export function rangeContains(ranges: PortRange[], port: number): boolean {
  return ranges.some((r) => port >= r.start && port <= r.end);
}

export function countPorts(ranges: PortRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}

/**
 * Pick a random free port inside the configured ranges.
 * Uses an explicit candidate list for moderate pools and random probing for
 * very large pools so memory stays bounded.
 */
export function pickRandomPort(ranges: PortRange[], used: ReadonlySet<number>): number | null {
  if (!ranges.length) return null;
  const total = countPorts(ranges);
  if (total <= 0) return null;

  if (total <= 200_000) {
    const free: number[] = [];
    for (const r of ranges) {
      for (let p = r.start; p <= r.end; p++) {
        if (!used.has(p)) free.push(p);
      }
    }
    if (!free.length) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  for (let attempt = 0; attempt < 20_000; attempt++) {
    const r = ranges[Math.floor(Math.random() * ranges.length)];
    const p = r.start + Math.floor(Math.random() * (r.end - r.start + 1));
    if (!used.has(p)) return p;
  }
  return null;
}

export interface PoolStats {
  ranges: PortRange[];
  total: number;
  used: number;
  free: number;
  usedPorts: number[];
  reservedByServer: number[];
}

export function buildPoolStats(
  ranges: PortRange[],
  used: ReadonlySet<number>,
  serverReserved: ReadonlySet<number>,
): PoolStats {
  const usedInPool = ranges.flatMap((r) => {
    const list: number[] = [];
    for (let p = r.start; p <= r.end; p++) if (used.has(p)) list.push(p);
    return list;
  });
  const total = countPorts(ranges);
  return {
    ranges,
    total,
    used: usedInPool.length,
    free: Math.max(0, total - usedInPool.length),
    usedPorts: usedInPool.sort((a, b) => a - b),
    reservedByServer: [...serverReserved].sort((a, b) => a - b),
  };
}

/** Ports frps itself listens on — never hand these to a client. */
export function serverReservedPorts(settings: {
  bindPort: number;
  kcpBindPort: number | null;
  quicBindPort: number | null;
  vhostHttpPort: number | null;
  vhostHttpsPort: number | null;
  dashboardEnabled: boolean;
  dashboardPort: number;
}): Set<number> {
  const set = new Set<number>();
  const add = (v: number | null | undefined) => {
    if (typeof v === 'number' && isValidPort(v)) set.add(v);
  };
  add(settings.bindPort);
  add(settings.kcpBindPort);
  add(settings.quicBindPort);
  add(settings.vhostHttpPort);
  add(settings.vhostHttpsPort);
  if (settings.dashboardEnabled) add(settings.dashboardPort);
  return set;
}
