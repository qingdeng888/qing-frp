import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { all, get, run } from './db.js';
import { getNodeByToken } from './store.js';
import type { Node } from './types.js';

/**
 * Node heartbeat ingestion (fed by the customized frpc build).
 *
 * The frpc patch posts to /api/heartbeat with its install token, which doubles
 * as the shared secret. This module validates and stores the latest state so
 * the panel can show live node health without SSH.
 */

export interface HeartbeatProxy {
  name: string;
  type: string;
  status: string;
  err?: string;
}

export interface HeartbeatPayload {
  token: string;
  hostname?: string;
  version?: string;
  os?: string;
  arch?: string;
  timestamp?: number;
  uptime_sec?: number;
  proxies?: HeartbeatProxy[];
  load?: { num_goroutine?: number; mem_alloc_mb?: number };
}

export interface NodeHeartbeat {
  nodeId: number;
  hostname: string;
  version: string;
  os: string;
  arch: string;
  uptimeSec: number;
  proxyTotal: number;
  proxyRunning: number;
  proxies: HeartbeatProxy[];
  goroutines: number;
  memAllocMb: number;
  remoteIp: string;
  reportedAt: number;
  receivedAt: string;
}

type Row = Record<string, unknown>;

function rowToHeartbeat(r: Row): NodeHeartbeat {
  let proxies: HeartbeatProxy[] = [];
  try {
    const parsed = JSON.parse(String(r.proxies_json ?? '[]'));
    if (Array.isArray(parsed)) proxies = parsed as HeartbeatProxy[];
  } catch {
    /* ignore malformed */
  }
  return {
    nodeId: Number(r.node_id),
    hostname: String(r.hostname ?? ''),
    version: String(r.version ?? ''),
    os: String(r.os ?? ''),
    arch: String(r.arch ?? ''),
    uptimeSec: Number(r.uptime_sec ?? 0),
    proxyTotal: Number(r.proxy_total ?? 0),
    proxyRunning: Number(r.proxy_running ?? 0),
    proxies,
    goroutines: Number(r.goroutines ?? 0),
    memAllocMb: Number(r.mem_alloc_mb ?? 0),
    remoteIp: String(r.remote_ip ?? ''),
    reportedAt: Number(r.reported_at ?? 0),
    receivedAt: String(r.received_at ?? ''),
  };
}

/** A node counts as online when its last heartbeat is within this window. */
export const HEARTBEAT_ONLINE_WINDOW_SEC = Number(process.env.FRP_CONSOLE_ONLINE_WINDOW ?? 90);

export interface HeartbeatResult {
  ok: boolean;
  nodeId?: number;
  status?: number;
  error?: string;
}

/** Validate and persist one heartbeat. */
export function recordHeartbeat(payload: HeartbeatPayload, remoteIp: string): HeartbeatResult {
  const token = String(payload?.token ?? '').trim();
  if (!token) {
    return { ok: false, status: 400, error: '缺少 token' };
  }
  const node: Node | null = getNodeByToken(token);
  if (!node) {
    return { ok: false, status: 404, error: 'token 无效' };
  }

  const proxies = Array.isArray(payload.proxies) ? payload.proxies.slice(0, 500) : [];
  const running = proxies.filter((p) => String(p?.status ?? '').toLowerCase() === 'running').length;
  const receivedAt = Date.now();

  run(
    `INSERT INTO node_heartbeats
       (node_id, hostname, version, os, arch, uptime_sec, proxy_total, proxy_running,
        proxies_json, goroutines, mem_alloc_mb, remote_ip, reported_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(node_id) DO UPDATE SET
       hostname=excluded.hostname, version=excluded.version, os=excluded.os, arch=excluded.arch,
       uptime_sec=excluded.uptime_sec, proxy_total=excluded.proxy_total,
       proxy_running=excluded.proxy_running, proxies_json=excluded.proxies_json,
       goroutines=excluded.goroutines, mem_alloc_mb=excluded.mem_alloc_mb,
       remote_ip=excluded.remote_ip, reported_at=excluded.reported_at,
       received_at=datetime('now')`,
    node.id,
    String(payload.hostname ?? '').slice(0, 200),
    String(payload.version ?? '').slice(0, 64),
    String(payload.os ?? '').slice(0, 32),
    String(payload.arch ?? '').slice(0, 32),
    Number(payload.uptime_sec ?? 0) || 0,
    proxies.length,
    running,
    JSON.stringify(proxies).slice(0, 200_000),
    Number(payload.load?.num_goroutine ?? 0) || 0,
    Number(payload.load?.mem_alloc_mb ?? 0) || 0,
    String(remoteIp ?? '').slice(0, 64),
    receivedAt,
  );

  return { ok: true, nodeId: node.id };
}

export function getHeartbeat(nodeId: number): NodeHeartbeat | null {
  const row = get<Row>('SELECT * FROM node_heartbeats WHERE node_id = ?', nodeId);
  return row ? rowToHeartbeat(row) : null;
}

export function listHeartbeats(): NodeHeartbeat[] {
  return all<Row>('SELECT * FROM node_heartbeats').map(rowToHeartbeat);
}

/** True when the node reported recently enough to be considered online. */
export function isOnline(hb: NodeHeartbeat | null): boolean {
  if (!hb) return false;
  const ageSec = (Date.now() - hb.reportedAt) / 1000;
  return ageSec <= HEARTBEAT_ONLINE_WINDOW_SEC;
}

export interface NodeLiveStatus {
  nodeId: number;
  online: boolean;
  heartbeat: NodeHeartbeat | null;
  ageSeconds: number | null;
}

export function getNodeLiveStatus(nodeId: number): NodeLiveStatus {
  const hb = getHeartbeat(nodeId);
  if (!hb) return { nodeId, online: false, heartbeat: null, ageSeconds: null };
  const ageSeconds = Math.round((Date.now() - hb.reportedAt) / 1000);
  return { nodeId, online: isOnline(hb), heartbeat: hb, ageSeconds };
}

export function deleteHeartbeat(nodeId: number): void {
  run('DELETE FROM node_heartbeats WHERE node_id = ?', nodeId);
}

/** Reject obviously bogus heartbeats before touching the database. */
export function rejectHeartbeat(reply: FastifyReply, status: number, error: string): void {
  reply.code(status).send({ ok: false, error });
}

export function newHeartbeatNonce(): string {
  return crypto.randomBytes(8).toString('hex');
}
