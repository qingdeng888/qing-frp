/** Shared domain types for the frp-console panel. */

export type PortRange = { start: number; end: number };

/** A single frpc proxy (`[[proxies]]`) entry. */
export interface Proxy {
  id: number;
  nodeId: number;
  name: string;
  type: ProxyType;
  localIp: string;
  localPort: number;
  /** null when remotePortRandom is true (frps picks the port). */
  remotePort: number | null;
  remotePortRandom: boolean;
  customDomains: string[];
  subdomain: string;
  locations: string[];
  multiplexer: string;
  secretKey: string;
  useEncryption: boolean;
  useCompression: boolean;
  bandwidthLimit: string;
  proxyProtocol: string;
  httpUser: string;
  httpPassword: string;
  hostHeaderRewrite: string;
  enabled: boolean;
  sortOrder: number;
}

/** frp-console only distributes its own tuned build. */
export type FrpVariant = 'custom';

export type ProxyType = 'tcp' | 'udp' | 'http' | 'https' | 'tcpmux' | 'stcp' | 'xtcp' | 'sudp';

export const PROXY_TYPES: ProxyType[] = ['tcp', 'udp', 'http', 'https', 'tcpmux', 'stcp', 'xtcp', 'sudp'];

/** Proxy types that consume a port out of the frps allowPorts ranges. */
export const PORT_CONSUMING_TYPES: ProxyType[] = ['tcp', 'udp', 'tcpmux', 'sudp'];

export interface Node {
  id: number;
  name: string;
  remark: string;
  serverAddr: string;
  installDir: string;
  frpcVersion: string;
  downloadBase: string;
  serverPort: number | null;
  authToken: string;
  logLevel: string;
  loginFailExit: boolean;
  tlsEnable: boolean;
  protocol: 'tcp' | 'kcp' | 'quic' | 'websocket' | 'wss';
  user: string;
  extraToml: string;
  installToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface FrpsSettings {
  bindAddr: string;
  bindPort: number;
  kcpBindPort: number | null;
  quicBindPort: number | null;
  proxyBindAddr: string | null;
  vhostHttpPort: number | null;
  vhostHttpsPort: number | null;
  authMethod: 'token' | 'oidc';
  authToken: string;
  allowPorts: PortRange[];
  maxPortsPerClient: number;
  subdomainHost: string | null;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  logMaxDays: number;
  dashboardEnabled: boolean;
  dashboardUser: string;
  dashboardPassword: string;
  dashboardPort: number;
  tlsForce: boolean;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  tlsTrustedCaFile: string | null;
  tlsOnly: boolean;
  heartbeatTimeout: number;
  maxPoolCount: number;
  tcpMux: boolean;
  tcpMuxKeepalive: number;
  udpPacketSize: number;
  natholeReserveHours: number;
  detailedErrors: boolean;
  enablePrometheus: boolean;
  extraToml: string;
  /** GitHub prefix proxy, e.g. https://raw.xiaoy.de */
  githubProxy: string;
  /** Whether the proxy also serves api.github.com (many do not). */
  githubProxyApi: boolean;
  /** Go module proxy chain, e.g. https://goproxy.cn,direct */
  goproxy: string;
  /** Go toolchain download base, e.g. https://golang.google.cn/dl */
  goDownloadBase: string;
  /**
   * 二进制资产的外部直链映射：`资产文件名 -> 完整下载 URL`。
   * 用于把 frp 安装包托管到 OpenList/对象存储等，并携带各自的签名参数
   * （例如 OpenList 的 `?sign=xxx:0`）。面板仍保留本地分发作为回退，
   * 直链不可用时安装不会中断。
   */
  assetMirrors: Record<string, string>;
  /**
   * frps 对外公布的地址（公网 IP 或域名）。
   *
   * 新建节点时若「frps 地址」留空，则继承此值——避免每建一个节点都要
   * 重填一遍同样的公网地址。留空表示不做继承（届时节点必须自己填）。
   */
  frpsAddr: string;
  /**
   * Public address of this panel, embedded into generated install scripts.
   * Empty means auto-detect (LAN guess).
   */
  publicBaseUrl: string;
  updatedAt?: string;
}

export interface NodeWithProxies extends Node {
  proxies: Proxy[];
}

export interface GeneratedArtifacts {
  frpsToml: string;
  systemdUnit: string;
  installScript: string;
}
