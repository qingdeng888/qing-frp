import { FRPC_CONFIG_PATH } from './config.js';
import { DEFAULT_FRP_VERSION, normalizeVersion } from './frp.js';
import { renderFrpcToml, type ResolvedPort } from './render.js';
import {
  getNode,
  listProxies,
  getSettings,
  resolveNodeAuthToken,
  resolveNodeServerAddr,
  resolveNodeServerPort,
} from './store.js';
import type { FrpVariant, Node, Proxy } from './types.js';
import { PORT_CONSUMING_TYPES } from './types.js';
import { customVersionString } from './variant.js';

/**
 * One-click frpc installer generator.
 *
 * The generated bash script is fully self-contained: it embeds the rendered
 * frpc.toml (base64) together with every `[[proxies]]` entry, downloads the
 * matching frp release, installs a per-node systemd unit and starts it.
 */

export interface InstallPlan {
  node: Node;
  proxies: Proxy[];
  serverAddr: string;
  serverPort: number;
  authToken: string;
  frpcToml: string;
  serviceName: string;
  installDir: string;
  frpVersion: string;
  downloadBase: string;
  /** Which build this node should run. */
  variant: FrpVariant;
  /** Panel-served distribution base, used for the custom variant. */
  customBase: string;
  /**
   * 外部托管的二进制直链映射：`资产文件名 -> 完整 URL`（可含签名查询参数）。
   *
   * 整张表都会嵌入安装脚本，由脚本在**目标节点上**按自身的 CPU 架构挑选对应
   * 条目——生成脚本时并不知道目标机的架构，所以不能在这里预先查表。
   * 直链失败会自动回退到 customBase / downloadBase。
   */
  assetMirrors: Record<string, string>;
}

export const SERVICE_PREFIX = 'frpc';

export function serviceNameFor(node: Node): string {
  return `${SERVICE_PREFIX}-${node.installToken.slice(0, 12)}`;
}

/**
 * Base URL the node uses to fetch panel-hosted binaries.
 * Empty when the operator has not configured a public panel URL, which makes
 * installation impossible (reported clearly rather than silently downgraded).
 */
function resolveCustomBase(settings: { publicBaseUrl: string }): string {
  const base = String(settings.publicBaseUrl ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/custom-frp` : '';
}

/** Build everything needed to install one node's frpc. */
export function buildInstallPlan(nodeId: number): InstallPlan {
  const node = getNode(nodeId);
  if (!node) throw new Error('节点不存在');
  const settings = getSettings();

  // 节点未单独填写时继承「frps 设置 → frps 对外地址」，免去逐个重填。
  const serverAddr = resolveNodeServerAddr(node) || '<请填写 frps 公网地址>';
  const serverPort = resolveNodeServerPort(node);
  // Always follow the live frps token unless the node explicitly overrides it.
  const authToken = resolveNodeAuthToken(node);

  const proxies = listProxies(nodeId);
  const resolved = new Map<number, ResolvedPort>();
  for (const p of proxies) {
    resolved.set(p.id, { remotePort: p.remotePort, random: p.remotePortRandom });
  }

  const frpcToml = renderFrpcToml(node, proxies, {
    serverAddr,
    serverPort,
    authToken,
    resolved,
    tcpMux: settings.tcpMux,
  });

  // frp-console only ships the tuned build: there is no upstream fallback.
  // An explicit node version wins, otherwise use the standard tuned version.
  const customDistBase = resolveCustomBase(settings);
  const explicitVersion = normalizeVersion(node.frpcVersion || '');
  const variantVersion = explicitVersion
    ? explicitVersion
    : customVersionString(DEFAULT_FRP_VERSION);

  return {
    node,
    proxies,
    serverAddr,
    serverPort,
    authToken,
    frpcToml,
    serviceName: serviceNameFor(node),
    installDir: node.installDir || '/etc/frp',
    frpVersion: variantVersion,
    // A node-level mirror can host our tarballs; the panel's own endpoint is
    // the default source. GitHub is never used.
    downloadBase: node.downloadBase,
    variant: 'custom',
    customBase: node.downloadBase ? '' : customDistBase,
    assetMirrors: settings.assetMirrors ?? {},
  };
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Wrap base64 into fixed-width lines for a readable, safe heredoc. */
function wrapBase64(data: string, width = 100): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += width) lines.push(data.slice(i, i + width));
  return lines.join('\n');
}

export interface InstallScriptOptions {
  /** Base URL of this panel, used for the optional live-refresh mode. */
  panelUrl: string;
  /** Base URL for panel-hosted custom binaries (e.g. http://panel:37000/custom-frp). */
  customBase?: string;
  /** Include the `--refresh` mode that re-pulls frpc.toml from the panel. */
  includeRefresh?: boolean;
}

/**
 * Render the complete installer. When piped to bash it installs frpc, writes
 * the config and enables the systemd unit — no manual steps.
 */
export function renderInstallScript(plan: InstallPlan, opts: InstallScriptOptions): string {
  const { node } = plan;
  const tomlB64 = wrapBase64(b64(plan.frpcToml));
  // 直链映射以 JSON+base64 嵌入：URL 含 ?sign=...:0 等特殊字符，
  // 直接拼进 shell 变量会被解释。
  const mirrorsB64 = wrapBase64(b64(JSON.stringify(plan.assetMirrors ?? {})));
  const refreshUrl = `${opts.panelUrl.replace(/\/+$/, '')}/api/install/${node.installToken}/frpc.toml`;

  const proxySummary = plan.proxies
    .filter((p) => p.enabled)
    .map((p) => {
      const rp = PORT_CONSUMING_TYPES.includes(p.type)
        ? p.remotePortRandom
          ? `远端端口 ${p.remotePort ?? 0}（随机/范围内分配）`
          : `远端端口 ${p.remotePort}`
        : p.type.toUpperCase();
      return `#   - ${p.name} [${p.type}] ${p.localIp}:${p.localPort} -> ${rp}`;
    })
    .join('\n');

  return `#!/usr/bin/env bash
# ============================================================================
#  frpc one-click installer  —  generated by frp-console
# ----------------------------------------------------------------------------
#  Node      : ${node.name} (#${node.id})
#  Server    : ${plan.serverAddr}:${plan.serverPort}
#  Service   : ${plan.serviceName}
#  frp ver   : v${plan.frpVersion}  (frp-console 定制版: 诊断/心跳/审计/配额)
#  Proxies   : ${plan.proxies.filter((p) => p.enabled).length} enabled / ${plan.proxies.length} total
#
#  Usage:
#    curl -fsSL <panel>/api/install/${node.installToken}.sh | sudo bash
#    # or save & run:
#    sudo bash frpc-install-${node.installToken}.sh
#
#  Options:
#    --refresh     re-download frpc.toml from the panel before restarting
#    --uninstall   stop the service and remove config/unit
#    --dir <path>  install to a custom directory (default ${plan.installDir})
#    --version <v> install a specific frp version (default ${plan.frpVersion})
#    --base <url>      自建镜像 base（与面板 /custom-frp/ 同结构）
# ============================================================================
set -euo pipefail

${proxySummary || '#   (no enabled proxies yet)'}

FRP_VERSION="\${FRP_VERSION:-${plan.frpVersion}}"
INSTALL_DIR="\${INSTALL_DIR:-${plan.installDir}}"
SERVICE_NAME="\${SERVICE_NAME:-${plan.serviceName}}"
DOWNLOAD_BASE="\${DOWNLOAD_BASE:-${plan.downloadBase}}"
CUSTOM_BASE="\${CUSTOM_BASE:-${plan.customBase}}"
# 该资产的专属直链（来自面板「设置 → 二进制直链」）。为空表示未配置。
  # 外部直链映射（JSON 的 base64）。URL 含 & ? = 等字符，
  # 以 base64 传递避免被 shell 解释；脚本解码后按本机架构查表。
  ASSET_MIRRORS_B64="\${ASSET_MIRRORS_B64:-}"
PANEL_REFRESH_URL="\${PANEL_REFRESH_URL:-${refreshUrl}}"

REFRESH=0
UNINSTALL=0
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --refresh)   REFRESH=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --dir)       INSTALL_DIR="\$2"; shift ;;
    --version)   FRP_VERSION="\$2"; shift ;;
    --base)      DOWNLOAD_BASE="\$2"; shift ;;
    -h|--help)
      sed -n '2,20p' "\$0"; exit 0 ;;
    *) echo "未知参数: \$1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\\033[1;32m[frpc]\\033[0m %s\\n' "\$*"; }
warn() { printf '\\033[1;33m[frpc]\\033[0m %s\\n' "\$*" >&2; }
die()  { printf '\\033[1;31m[frpc]\\033[0m %s\\n' "\$*" >&2; exit 1; }

[[ \$(id -u) -eq 0 ]] || die "请使用 root 运行（sudo bash \$0）"

# systemd is the normal supervisor on bare hosts. Containers usually lack it,
# so fall back to a nohup-managed process instead of failing outright.
USE_SYSTEMD=1
if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
  USE_SYSTEMD=0
  warn "未检测到 systemd，将以 nohup 后台进程方式运行 frpc（无开机自启）"
fi

# Detect an existing installation so we can report install vs update.
IS_UPDATE=0
if [[ -f "/etc/systemd/system/\$SERVICE_NAME.service" ]] || [[ -x "\$INSTALL_DIR/frpc" ]] || [[ -f "\$INSTALL_DIR/frpc.toml" ]]; then
  IS_UPDATE=1
fi

if [[ "\$UNINSTALL" == "1" ]]; then
  log "卸载 \$SERVICE_NAME ..."
  if [[ "\$USE_SYSTEMD" == "1" ]]; then
    systemctl disable --now "\$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/\$SERVICE_NAME.service"
    systemctl daemon-reload || true
  else
    # nohup 模式：按 pid 文件停止
    if [[ -f "\$INSTALL_DIR/frpc.pid" ]]; then
      kill "\$(cat "\$INSTALL_DIR/frpc.pid")" 2>/dev/null || true
      rm -f "\$INSTALL_DIR/frpc.pid"
    fi
    pkill -f "\$INSTALL_DIR/frpc -c" 2>/dev/null || true
  fi
  rm -f "\$INSTALL_DIR/frpc" "\$INSTALL_DIR/frpc.toml" "\$INSTALL_DIR/frpc.toml.bak"
  log "已卸载。"
  exit 0
fi

# ---------------------------------------------------------------- detect arch
case "\$(uname -m)" in
  x86_64|amd64)   ARCH=amd64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  armv7l|armv6l)  ARCH=arm ;;
  i386|i686)      ARCH=386 ;;
  loongarch64)    ARCH=loong64 ;;
  riscv64)        ARCH=riscv64 ;;
  *) die "不支持的架构: \$(uname -m)" ;;
esac
log "检测到架构: \$ARCH, frp 版本: v\$FRP_VERSION"

# ------------------------------------------------------------- install deps
for cmd in curl tar; do
  command -v "\$cmd" >/dev/null 2>&1 || die "缺少依赖命令: \$cmd"
done


mkdir -p "\$INSTALL_DIR"

# ------------------------------------------------------- 下载定制版 frpc 二进制
# frp-console 只分发自己的定制版，不使用上游预编译包。
# 压缩包名沿用上游命名，便于自建镜像复用同一套目录结构。
BASE_VERSION="\${FRP_VERSION%%-*}"
ASSET="frp_\${BASE_VERSION}_linux_\${ARCH}.tar.gz"
if [[ -n "\$DOWNLOAD_BASE" ]]; then
  # 节点级自建镜像（与面板 /custom-frp/ 相同的目录结构）。
  URL="\${DOWNLOAD_BASE%/}/\${ASSET}"
elif [[ -n "\$CUSTOM_BASE" ]]; then
  # 面板内置分发端点（默认）。
  URL="\${CUSTOM_BASE%/}/\${ASSET}"
else
  die "未配置面板公网地址，无法下载定制版 frpc。请在面板「frps 设置 → 面板公网地址」中填写后重新生成脚本，或用 --base 指定自建镜像。"
fi

TMP_DIR="\$(mktemp -d)"
trap 'rm -rf "\$TMP_DIR"' EXIT

# 外部直链映射（JSON 的 base64）。为空表示只用面板/自建镜像分发。
if [[ -z "\$ASSET_MIRRORS_B64" ]]; then
  ASSET_MIRRORS_B64="\$(cat <<'ASSET_MIRRORS_B64_EOF'
${mirrorsB64}
ASSET_MIRRORS_B64_EOF
)"
fi

NEED_DOWNLOAD=1
if [[ -x "\$INSTALL_DIR/frpc" ]]; then
  # Compare the full version string (including the "-console" suffix) so a
  # stale install is detected and refreshed.
  CURRENT="\$("\$INSTALL_DIR/frpc" --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9]+)?' | head -1 || true)"
  if [[ "\$CURRENT" == "\$FRP_VERSION" ]]; then
    NEED_DOWNLOAD=0
    log "已安装 frpc v\$CURRENT，跳过下载"
  else
    log "检测到已安装 v\$CURRENT，将更新为 v\$FRP_VERSION"
  fi
fi

if [[ "\$NEED_DOWNLOAD" == "1" ]]; then
  # 下载顺序：专属直链 → 节点自建镜像 → 面板内置分发。
  # 直链可能因签名过期/存储故障失效，因此失败后自动回退，保证新节点仍能装上。
  CANDIDATES=()
  # 解析直链映射并取出本机架构对应的条目。
  #
  # 注意：一律用 if 而非「[[ ... ]] && ...」形式。脚本开头是 set -e，
  # 而「[[ ]] && x」在条件不成立时整行返回非 0，会让 set -e 直接把脚本
  # 静默终止（无任何报错）——这正是「未配置直链的架构装不上」的原因。
  ASSET_MIRROR=""
  if [[ -n "\$ASSET_MIRRORS_B64" ]]; then
    MIRRORS_JSON="\$(printf '%s' "\$ASSET_MIRRORS_B64" | base64 -d 2>/dev/null || true)"
    if [[ -n "\$MIRRORS_JSON" ]]; then
      if command -v python3 >/dev/null 2>&1; then
        ASSET_MIRROR="\$(printf '%s' "\$MIRRORS_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1],""))' "\$ASSET" 2>/dev/null || true)"
      else
        # 无 python3 时的简易提取：定位 "资产名":"URL" 并取引号内内容
        ASSET_MIRROR="\$(printf '%s' "\$MIRRORS_JSON" | tr ',' '\n' | grep -F "\\"\$ASSET\\":" | sed -e 's/.*:\\"//' -e 's/\\".*//' | head -1 || true)"
      fi
    fi
  fi
  if [[ -n "\$ASSET_MIRROR" ]]; then CANDIDATES+=("\$ASSET_MIRROR"); fi
  if [[ -n "\$DOWNLOAD_BASE" ]]; then CANDIDATES+=("\${DOWNLOAD_BASE%/}/\$ASSET"); fi
  if [[ -n "\$CUSTOM_BASE" ]]; then CANDIDATES+=("\${CUSTOM_BASE%/}/\$ASSET"); fi

  if [[ \${#CANDIDATES[@]} -eq 0 ]]; then
    die "未配置面板公网地址，无法下载定制版 frpc。请在面板「frps 设置 → 面板公网地址」中填写后重新生成脚本，或用 --base 指定自建镜像。"
  fi

  OK=0
  for CAND in "\${CANDIDATES[@]}"; do
    # 直链可能带查询串（如 OpenList 的 ?sign=xxx:0），日志里隐藏签名值
    log "下载 \${CAND%%\\?*}"
    if curl -fL --retry 3 --connect-timeout 15 -o "\$TMP_DIR/frp.tar.gz" "\$CAND" \\
       && tar -xzf "\$TMP_DIR/frp.tar.gz" -C "\$TMP_DIR" 2>/dev/null \\
       && [[ -n "\$(find "\$TMP_DIR" -maxdepth 2 -type f -name frpc | head -1)" ]]; then
      OK=1
      break
    fi
    warn "该地址不可用，尝试下一个来源"
    rm -rf "\$TMP_DIR"; mkdir -p "\$TMP_DIR"
  done
  [[ "\$OK" == "1" ]] || die "所有下载地址均失败，请检查网络，或用 --base 指定镜像地址"
  SRC="\$(find "\$TMP_DIR" -maxdepth 2 -type f -name frpc | head -1)"
  [[ -n "\$SRC" ]] || die "压缩包中未找到 frpc 二进制"
  install -m 0755 "\$SRC" "\$INSTALL_DIR/frpc"
  log "frpc 已安装到 \$INSTALL_DIR/frpc"
fi

# ------------------------------------------------------------- write frpc.toml
write_config() {
  base64 -d > "\$INSTALL_DIR/frpc.toml" <<'FRPC_TOML_B64'
${tomlB64}
FRPC_TOML_B64
}

# Back up an existing config so a bad update can be reverted quickly.
if [[ -f "\$INSTALL_DIR/frpc.toml" ]]; then
  cp -f "\$INSTALL_DIR/frpc.toml" "\$INSTALL_DIR/frpc.toml.bak" 2>/dev/null || true
fi

if [[ "\$REFRESH" == "1" ]]; then
  log "从面板刷新 frpc.toml ..."
  if curl -fsSL --connect-timeout 15 "\$PANEL_REFRESH_URL" -o "\$TMP_DIR/frpc.toml"; then
    install -m 0644 "\$TMP_DIR/frpc.toml" "\$INSTALL_DIR/frpc.toml"
  else
    warn "刷新失败，沿用内嵌配置"
    write_config
  fi
else
  write_config
fi
chmod 0644 "\$INSTALL_DIR/frpc.toml"

# --------------------------------------------------- 清理同一节点的旧服务
# The unit name embeds the install token. When the operator rotates the token,
# the new name differs and the previous unit would linger, fighting over the
# same config file. Remove any panel-managed unit for this install dir whose
# name is not the one we are about to write.
if [[ "\$USE_SYSTEMD" == "1" ]]; then
  STALE_UNITS=""
  for unit_file in /etc/systemd/system/frpc-*.service; do
    [[ -e "\$unit_file" ]] || continue
    unit_name="\$(basename "\$unit_file" .service)"
    if [[ "\$unit_name" == "\$SERVICE_NAME" ]]; then continue; fi
    if grep -q "ExecStart=\$INSTALL_DIR/frpc" "\$unit_file" 2>/dev/null; then
      STALE_UNITS="\$STALE_UNITS \$unit_name"
      systemctl disable --now "\$unit_name" >/dev/null 2>&1 || true
      rm -f "\$unit_file"
    fi
  done
  if [[ -n "\$STALE_UNITS" ]]; then
    log "已清理同一节点的旧服务:\$STALE_UNITS"
  fi
fi

# ---------------------------------------------------- 服务定义与启动
if [[ "\$USE_SYSTEMD" == "1" ]]; then
cat > "/etc/systemd/system/\$SERVICE_NAME.service" <<UNIT
[Unit]
Description=frp client for ${node.name} (managed by frp-console)
Documentation=https://github.com/fatedier/frp
After=network.target
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5s
# frp-console: enable heartbeat reporting so the panel shows live node status.
# These are inert on an upstream frpc binary.
Environment=FRP_CONSOLE_PANEL_URL=${opts.panelUrl.replace(/\/+$/, '')}
Environment=FRP_CONSOLE_INSTALL_TOKEN=${node.installToken}
Environment=FRP_CONSOLE_HEARTBEAT_INTERVAL=30
ExecStart=\$INSTALL_DIR/frpc -c \$INSTALL_DIR/frpc.toml
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "\$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "\$SERVICE_NAME"
  sleep 2
  if ! systemctl is-active --quiet "\$SERVICE_NAME"; then
    warn "服务未处于 active 状态，最近日志："
    journalctl -u "\$SERVICE_NAME" -n 30 --no-pager || true
    if [[ -f "\$INSTALL_DIR/frpc.toml.bak" ]]; then
      warn "可用旧配置回滚：cp \$INSTALL_DIR/frpc.toml.bak \$INSTALL_DIR/frpc.toml && systemctl restart \$SERVICE_NAME"
    fi
    die "安装失败，请检查上方日志"
  fi
  if [[ "\$IS_UPDATE" == "1" ]]; then
    log "更新完成（覆盖安装），服务 \$SERVICE_NAME 正在运行。"
    if [[ -f "\$INSTALL_DIR/frpc.toml.bak" ]]; then log "旧配置已备份为 \$INSTALL_DIR/frpc.toml.bak"; fi
  else
    log "安装完成，服务 \$SERVICE_NAME 正在运行。"
  fi
  log "查看日志: journalctl -u \$SERVICE_NAME -f"
else
  # ---- 无 systemd：以 nohup 后台进程运行，用 pid 文件管理 ----
  if [[ -f "\$INSTALL_DIR/frpc.pid" ]]; then
    kill "\$(cat "\$INSTALL_DIR/frpc.pid")" 2>/dev/null || true
    sleep 1
  fi
  pkill -f "\$INSTALL_DIR/frpc -c" 2>/dev/null || true

  # Heartbeat env vars must be exported here too: the systemd path gets them via
  # Environment= lines in the unit, which nohup has no equivalent for.
  export FRP_CONSOLE_PANEL_URL="${opts.panelUrl.replace(/\/+$/, '')}"
  export FRP_CONSOLE_INSTALL_TOKEN="${node.installToken}"
  export FRP_CONSOLE_HEARTBEAT_INTERVAL="30"
  nohup "\$INSTALL_DIR/frpc" -c "\$INSTALL_DIR/frpc.toml" \
    >> "\$INSTALL_DIR/frpc.log" 2>&1 &
  echo \$! > "\$INSTALL_DIR/frpc.pid"
  sleep 2

  if kill -0 "\$(cat "\$INSTALL_DIR/frpc.pid")" 2>/dev/null; then
    if [[ "\$IS_UPDATE" == "1" ]]; then
      log "更新完成（覆盖安装），frpc 已在后台运行（PID \$(cat "\$INSTALL_DIR/frpc.pid")）。"
    else
      log "安装完成，frpc 已在后台运行（PID \$(cat "\$INSTALL_DIR/frpc.pid")）。"
    fi
    log "日志: tail -f \$INSTALL_DIR/frpc.log"
    warn "当前环境无 systemd，未配置开机自启"
  else
    warn "frpc 启动失败，最近日志："
    tail -n 30 "\$INSTALL_DIR/frpc.log" 2>/dev/null || true
    die "安装失败，请检查上方日志"
  fi
fi
`;
}

/** Short snippet suitable for pasting into an existing host. */
export function renderFrpcTomlOnly(nodeId: number): string {
  return buildInstallPlan(nodeId).frpcToml;
}

export const FRPC_REMOTE_PATH = FRPC_CONFIG_PATH;
