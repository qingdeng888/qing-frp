#!/bin/sh
# ============================================================================
#  frp-console 容器入口
# ----------------------------------------------------------------------------
#  职责：
#    1. 从预构建分发包中取出本机架构的 frps/frpc 二进制
#    2. 首次启动时用面板自身渲染初始 frps.toml（随机 token），让 frps 立刻可用
#    3. 生成 supervisor 的 frps 程序定义（面板后续部署会覆盖它）
#    4. 以前台 supervisord 作为主进程
#
#  一切操作幂等：已存在的数据卷不会被覆盖。
# ============================================================================
set -eu

log() { printf '\033[1;32m[entrypoint]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[entrypoint]\033[0m %s\n' "$*" >&2; }

HOME_DIR="${FRP_CONSOLE_HOME:-/data}"
FRPS_CONFIG="${FRP_CONSOLE_FRPS_CONFIG:-/etc/frp/frps.toml}"
FRPS_BIN="${FRP_CONSOLE_FRPS_BIN:-/usr/local/bin/frps}"
SUPERVISOR_INCLUDE="${FRP_CONSOLE_SUPERVISOR_INCLUDE:-/etc/supervisor/conf.d}"
DIST_DIR="/app/custom-frp/dist"
LOG_DIR="${FRP_CONSOLE_SUPERVISOR_LOG:-/var/log/frps}"

mkdir -p "$HOME_DIR" "$(dirname "$FRPS_CONFIG")" "$SUPERVISOR_INCLUDE" "$LOG_DIR"

# ------------------------------------------------------- 1) 准备 frps 二进制
# 容器架构 -> frp 资产名
case "$(uname -m)" in
  x86_64)         ARCH=amd64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  armv7l|armv6l)  ARCH=arm ;;
  i386|i686)      ARCH=386 ;;
  loongarch64)    ARCH=loong64 ;;
  riscv64)        ARCH=riscv64 ;;
  *) warn "未知架构 $(uname -m)，跳过二进制解包"; ARCH="" ;;
esac

if [ -n "$ARCH" ] && [ ! -x "$FRPS_BIN" ]; then
  TARBALL=""
  # 优先精确匹配，其次取任意可用包（避免因版本号变化而失败）
  for candidate in "$DIST_DIR"/frp_*_linux_"$ARCH".tar.gz; do
    [ -f "$candidate" ] && TARBALL="$candidate" && break
  done

  if [ -n "$TARBALL" ]; then
    log "从 $(basename "$TARBALL") 解出 frps ($ARCH)"
    TMP="$(mktemp -d)"
    tar -xzf "$TARBALL" -C "$TMP"
    SRC="$(find "$TMP" -maxdepth 2 -type f -name frps | head -1)"
    if [ -n "$SRC" ]; then
      install -m 0755 "$SRC" "$FRPS_BIN"
    else
      warn "压缩包中未找到 frps"
    fi
    rm -rf "$TMP"
  else
    warn "未找到 $ARCH 架构的预构建包（$DIST_DIR）"
  fi
fi

if [ -x "$FRPS_BIN" ]; then
  log "frps 就绪: $FRPS_BIN ($("$FRPS_BIN" --version 2>/dev/null || echo '?'))"
else
  warn "frps 二进制不可用，面板将无法托管 frps（仍可管理节点与生成脚本）"
fi

# ------------------------------------------------- 2) 首次生成 frps.toml
if [ ! -f "$FRPS_CONFIG" ]; then
  log "生成初始配置 $FRPS_CONFIG"
  if node /app/dist/cli.js frps-toml > "$FRPS_CONFIG" 2>/dev/null; then
    log "初始配置已生成（含随机 auth.token，可在面板中修改）"
  else
    warn "无法通过面板生成初始配置，写入最小可用配置"
    cat > "$FRPS_CONFIG" <<'EOF'
bindAddr = "0.0.0.0"
bindPort = 37001
auth.method = "token"
auth.token = "change-me-in-the-panel"
log.to = "console"
log.level = "info"
EOF
  fi
else
  log "沿用已有配置 $FRPS_CONFIG"
fi

# ------------------------------------------- 3) supervisor 的 frps 程序定义
# 仅在缺失时写入；面板「生成配置并重启 frps」会覆盖此文件。
FRPS_CONF="$SUPERVISOR_INCLUDE/frps.conf"
if [ ! -f "$FRPS_CONF" ]; then
  log "写入 supervisor 定义 $FRPS_CONF"
  cat > "$FRPS_CONF" <<EOF
[program:frps]
command=$FRPS_BIN -c $FRPS_CONFIG
autostart=true
autorestart=true
startsecs=2
stopwaitsecs=5
stdout_logfile=$LOG_DIR/frps.log
stderr_logfile=$LOG_DIR/frps.err.log
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=10MB
environment=FRP_CONSOLE_MANAGED="1"
EOF
fi

# --------------------------------------------------------------- 4) 启动
# 设计取舍：
#   面板作为容器主进程（CMD），日志直达 `docker logs`；supervisord 在后台
#   仅守护 frps，提供自动重启与 supervisorctl（面板的「重启 frps」按钮依赖它）。
#   面板退出则容器退出，由 restart 策略接管；supervisord 退出不影响面板运行，
#   此时面板会把 frps 状态显示为不可用。
if [ "${FRP_CONSOLE_SUPERVISOR:-1}" = "1" ]; then
  log "后台启动 supervisord（守护 frps）"
  SUPERVISORD_CONF="${FRP_CONSOLE_SUPERVISOR_CONF:-/etc/supervisord.conf}"
  /usr/bin/supervisord -c "$SUPERVISORD_CONF" &
  # 给 supervisorctl 的 socket 一点时间就绪，避免面板启动即报错
  for _ in 1 2 3 4 5; do
    [ -S /var/run/supervisor.sock ] && break
    sleep 0.4
  done
else
  warn "FRP_CONSOLE_SUPERVISOR=0，跳过 frps 守护"
fi

if [ -f /app/VERSION ]; then
  log "frp-console 面板版本: $(cat /app/VERSION)"
fi
log "启动面板: $*"
exec "$@"
