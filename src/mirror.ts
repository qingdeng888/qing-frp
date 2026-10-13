/**
 * Mirror / proxy URL handling.
 *
 * Many servers cannot reach GitHub (or go.dev) reliably. Operators run prefix
 * style proxies that take the original URL as a suffix:
 *
 *   https://raw.xiaoy.de/https://github.com/fatedier/frp/releases/download/...
 *
 * Not every proxy supports every host: testing showed a common prefix proxy
 * serving release *downloads* fine while returning 403 for api.github.com.
 * So proxying is applied per-purpose rather than blindly to every URL.
 */

/** Hosts that a prefix proxy is expected to handle. */
export const PROXYABLE_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'codeload.github.com'];

/** The GitHub REST API host. Frequently unsupported by prefix proxies. */
export const GITHUB_API_HOST = 'api.github.com';

/** Normalise a user-supplied proxy prefix ("https://raw.xiaoy.de/" -> no slash). */
export function normalizeProxy(input: unknown): string {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    // Be forgiving: a bare host is assumed to be https.
    return `https://${s.replace(/\/+$/, '')}`;
  }
  return s.replace(/\/+$/, '');
}

/** True when the value looks like a usable proxy prefix. */
export function isValidProxy(input: unknown): boolean {
  const s = normalizeProxy(input);
  if (!s) return true; // empty means "direct", which is valid
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Apply a prefix proxy to a URL.
 * Returns the original URL when no proxy is configured.
 */
export function applyProxy(url: string, proxy: string | null | undefined): string {
  const p = normalizeProxy(proxy);
  if (!p) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  // Never double-proxy an already proxied URL.
  if (url.startsWith(`${p}/`)) return url;
  return `${p}/${url}`;
}

/**
 * Hosts that must never be proxied, even though they look like subdomains of
 * an allowed host. api.github.com is a subdomain of github.com but is a
 * different service that prefix proxies commonly reject (observed: 403).
 */
export const PROXY_DENY_HOSTS = [GITHUB_API_HOST];

/** Apply a proxy only when the URL's host is in the allowed list. */
export function applyProxyIfHostAllowed(
  url: string,
  proxy: string | null | undefined,
  allowedHosts: string[] = PROXYABLE_DOWNLOAD_HOSTS,
): string {
  const p = normalizeProxy(proxy);
  if (!p) return url;
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return url;
  }

  // Explicit deny wins over the allow-list (api.github.com vs github.com).
  if (PROXY_DENY_HOSTS.some((h) => host === h.toLowerCase())) return url;

  const allowed = allowedHosts.some((h) => {
    const target = h.toLowerCase();
    return host === target || host.endsWith(`.${target}`);
  });
  if (!allowed) return url;
  return applyProxy(url, p);
}

/**
 * Resolve the download URL for an frp release asset.
 *
 * Precedence:
 *   1. an explicit full mirror base (node-level "download base")
 *   2. a GitHub prefix proxy
 *   3. direct GitHub
 */
export function resolveReleaseUrl(opts: {
  version: string;
  asset: string;
  mirrorBase?: string | null;
  githubProxy?: string | null;
}): string {
  const direct = `https://github.com/fatedier/frp/releases/download/v${opts.version}/${opts.asset}`;
  const base = String(opts.mirrorBase ?? '').trim().replace(/\/+$/, '');
  if (base) return `${base}/v${opts.version}/${opts.asset}`;
  return applyProxy(direct, opts.githubProxy);
}

export interface MirrorSettings {
  githubProxy: string;
  githubProxyApi: boolean;
  goproxy: string;
  goDownloadBase: string;
}

/** Default Go module proxy chain, used when the operator sets nothing. */
export const DEFAULT_GOPROXY = 'https://proxy.golang.org,direct';

/** A commonly reachable Go module proxy mirror. */
export const GOPROXY_MIRROR_CN = 'https://goproxy.cn,direct';

/** A commonly reachable Go toolchain mirror. */
export const GO_DOWNLOAD_MIRROR_CN = 'https://golang.google.cn/dl';
