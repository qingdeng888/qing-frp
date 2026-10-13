#!/usr/bin/env bash
# ============================================================================
#  build-custom-frp.sh — 从源码构建定制版 frps / frpc
# ----------------------------------------------------------------------------
#  实测环境：Debian 13 / x86_64 / Go 1.27.1 / frp v0.71.0
#
#  用法:
#    ./custom-frp/build-custom-frp.sh                 # 构建，应用全部补丁
#    ./custom-frp/build-custom-frp.sh --with-web      # 同时构建内置 Dashboard（需 npm，首次较慢）
#    ./custom-frp/build-custom-frp.sh --version 0.71.0
#    ./custom-frp/build-custom-frp.sh --clean         # 清理构建目录
#
#  服务器访问 GitHub 不畅时可指定前缀代理:
#    GITHUB_PROXY=https://raw.xiaoy.de ./custom-frp/build-custom-frp.sh
#    GOPROXY=https://goproxy.cn,direct ./custom-frp/build-custom-frp.sh
#    GO_DOWNLOAD_BASE=https://golang.google.cn/dl ./custom-frp/build-custom-frp.sh
#
#  产物: custom-frp/out/{frps,frpc}
#
#  重要：frp 的 Web Dashboard 前端是用 go:embed 编进二进制的。源码 tarball
#  不含 web/*/dist，因此默认必须加 `noweb` 构建 tag，否则报错：
#      web/frps/embed.go: pattern dist: no matching files found
# ============================================================================
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.71.0}"
GO_VERSION="${GO_VERSION:-1.27.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="${BUILD_ROOT:-/opt/frp-build}"
SRC_DIR="$BUILD_ROOT/frp-$FRP_VERSION"
OUT_DIR="$HERE/out"
DIST_DIR="$HERE/dist"
GO_BIN="${GO_BIN:-/opt/go/bin/go}"
WITH_WEB=0
# 定制版版本标识：与官方版同为 0.71.0，若不区分，安装脚本的
# 「同版本跳过下载」会误判，导致节点换不成定制版。
CONSOLE_SUFFIX="${CONSOLE_SUFFIX:--console}"
# 预构建的架构列表；--all-arches 可构建全部，便于分发到异构节点。
ARCHES="${ARCHES:-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"
# GitHub/Go 代理。服务器访问 GitHub 不畅时设置 GITHUB_PROXY，例如
#   GITHUB_PROXY=https://raw.xiaoy.de
# 会拼成 https://raw.xiaoy.de/https://github.com/...
GITHUB_PROXY="${GITHUB_PROXY:-}"
GOPROXY_VALUE="${GOPROXY:-}"
GO_DOWNLOAD_BASE="${GO_DOWNLOAD_BASE:-https://go.dev/dl}"
FRP_SOURCE_BASE="${FRP_SOURCE_BASE:-}"

# 给任意 URL 套用 GitHub 前缀代理（仅 http(s)）
proxy_url() {
  local url="$1"
  if [[ -z "$GITHUB_PROXY" ]]; then
    printf '%s' "$url"
    return
  fi
  printf '%s/%s' "${GITHUB_PROXY%/}" "$url"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-web) WITH_WEB=1 ;;
    --all-arches) ARCHES="amd64,arm64,arm,386,loong64,riscv64" ;;
    --arches) ARCHES="$2"; shift ;;
    --dist)   DIST_ONLY=1 ;;
    --version)  FRP_VERSION="$2"; SRC_DIR="$BUILD_ROOT/frp-$FRP_VERSION"; shift ;;
    --clean)    rm -rf "$SRC_DIR" "$OUT_DIR" "$DIST_DIR"; echo "已清理构建产物"; exit 0 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;32m[build]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------- Go 工具链
if [[ ! -x "$GO_BIN" ]]; then
  log "未找到 Go，安装 go$GO_VERSION 到 /opt/go ..."
  mkdir -p "$BUILD_ROOT" && cd "$BUILD_ROOT"
  GO_TARBALL="${GO_DOWNLOAD_BASE%/}/go${GO_VERSION}.linux-amd64.tar.gz"
  # go.dev is not GitHub, so only apply GITHUB_PROXY when the base is GitHub-ish.
  curl -fsSL -o go.tar.gz "$GO_TARBALL"
  EXPECT="$(curl -fsSL "${GO_DOWNLOAD_BASE%/}/?mode=json" | python3 -c "
import sys,json
for r in json.load(sys.stdin):
    if r['version']=='go${GO_VERSION}':
        for f in r['files']:
            if f['filename']=='go${GO_VERSION}.linux-amd64.tar.gz': print(f['sha256'])
" 2>/dev/null || true)"
  ACTUAL="$(sha256sum go.tar.gz | awk '{print $1}')"
  if [[ -n "$EXPECT" ]]; then
    [[ "$EXPECT" == "$ACTUAL" ]] || die "Go 校验失败：期望 $EXPECT 实际 $ACTUAL"
    log "Go 校验通过"
  else
    warn "无法获取官方校验值，跳过校验"
  fi
  rm -rf /opt/go && tar -C /opt -xzf go.tar.gz
fi
log "$("$GO_BIN" version)"

export PATH="$(dirname "$GO_BIN"):$PATH"
export GOPROXY="${GOPROXY_VALUE:-https://proxy.golang.org,direct}"
export GOFLAGS=-mod=mod
export CGO_ENABLED=0

# ------------------------------------------------------------------- frp 源码
if [[ ! -f "$SRC_DIR/go.mod" ]]; then
  log "下载 frp v$FRP_VERSION 源码 ..."
  mkdir -p "$SRC_DIR" && cd "$BUILD_ROOT"
  SOURCE_URL="${FRP_SOURCE_BASE:-https://github.com/fatedier/frp/archive/refs/tags/v$FRP_VERSION.tar.gz}"
  if [[ -z "$FRP_SOURCE_BASE" ]]; then
    SOURCE_URL="$(proxy_url "https://github.com/fatedier/frp/archive/refs/tags/v$FRP_VERSION.tar.gz")"
  fi
  log "源码下载: $SOURCE_URL"
  curl -fsSL -o "frp-$FRP_VERSION.tar.gz" "$SOURCE_URL"
  tar xzf "frp-$FRP_VERSION.tar.gz" -C "$SRC_DIR" --strip-components=1
fi
log "源码目录: $SRC_DIR"

# --------------------------------------------------------------- 应用定制补丁
# 1) 文件投放：patches/files/*.go，文件头用
#      // frp-console-target: <相对 frp 源码根的路径>
#    声明目标位置。
# 2) 源码变换：patches/transforms.json，对目标文件做精确字符串替换。
#    anchor 必须恰好出现一次，否则直接报错（避免静默产生错误代码）。
apply_file_patches() {
  local applied=0
  if ! compgen -G "$HERE/patches/files/*.go" > /dev/null; then
    log "无文件补丁"
    return 0
  fi
  for patch in "$HERE/patches/files"/*.go; do
    local target
    target="$(grep -m1 'frp-console-target:' "$patch" | sed 's/.*frp-console-target:[[:space:]]*//' | tr -d '\r')"
    [[ -n "$target" ]] || die "$(basename "$patch") 缺少 frp-console-target 声明"
    mkdir -p "$SRC_DIR/$(dirname "$target")"
    cp "$patch" "$SRC_DIR/$target"
    log "投放: $(basename "$patch") -> $target"
    applied=$((applied + 1))
  done
  log "文件补丁完成（$applied 个）"
}

apply_transforms() {
  local spec="$HERE/patches/transforms.json"
  [[ -f "$spec" ]] || { log "无源码变换"; return 0; }

  python3 - "$spec" "$SRC_DIR" <<'PYEOF_INNER'
import json, sys, os, shutil

spec_path, src_dir = sys.argv[1], sys.argv[2]
spec = json.load(open(spec_path, encoding='utf-8'))
transforms = spec.get('transforms', [])
failures = []

# Idempotency: keep a pristine copy of every touched file and restore it before
# applying transforms, so repeated builds never stack edits.
bak = os.path.join(src_dir, '.frp-console-orig')
os.makedirs(bak, exist_ok=True)
for rel in sorted({t['file'] for t in transforms}):
    src_f = os.path.join(src_dir, rel)
    bak_f = os.path.join(bak, rel)
    if not os.path.exists(src_f):
        continue
    if not os.path.exists(bak_f):
        os.makedirs(os.path.dirname(bak_f), exist_ok=True)
        shutil.copy2(src_f, bak_f)
    else:
        shutil.copy2(bak_f, src_f)

for i, t in enumerate(transforms, 1):
    path = os.path.join(src_dir, t['file'])
    why = t.get('why', '')
    if not os.path.exists(path):
        failures.append(f"[{i}] {t['file']} 文件不存在 ({why})")
        continue
    src = open(path, encoding='utf-8').read()
    n = src.count(t['anchor'])
    if n != 1:
        failures.append(f"[{i}] {t['file']} anchor 出现 {n} 次（应为 1 次）: {why}")
        continue
    if t['replace'] in src:
        print(f"  [{i}] {t['file']} 已应用，跳过")
        continue
    open(path, 'w', encoding='utf-8').write(src.replace(t['anchor'], t['replace'], 1))
    print(f"  [{i}] {t['file']} 已变换: {why}")

if failures:
    print("\n源码变换失败：", file=sys.stderr)
    for f in failures:
        print("  " + f, file=sys.stderr)
    sys.exit(1)
print(f"源码变换完成（{len(transforms)} 条）")
PYEOF_INNER
}

log "应用文件补丁 ..."
apply_file_patches
log "应用源码变换 ..."
apply_transforms

# --------------------------------------------------------------------- 构建
NOWEB_TAG=",noweb"
if [[ "$WITH_WEB" == "1" ]]; then
  command -v npm >/dev/null || die "--with-web 需要 npm"
  log "构建 Web Dashboard 前端 ..."
  ( cd "$SRC_DIR/web" && npm ci && npm run build --workspace frps && npm run build --workspace frpc )
  NOWEB_TAG=""
fi

# ------------------------------------------------------- 交叉编译多架构产物
# 预构建后随项目分发，节点直接从面板下载，部署时无需 Go 工具链与 GitHub。
cd "$SRC_DIR"
VERSION_PKG="github.com/fatedier/frp/pkg/util/version"
CUSTOM_VERSION="${FRP_VERSION}${CONSOLE_SUFFIX}"
LDFLAGS="-s -w -X ${VERSION_PKG}.version=${CUSTOM_VERSION}"

# 需要构建的架构：默认只构建宿主架构；--all-arches 构建全部。
IFS=',' read -r -a ARCH_LIST <<< "$ARCHES"
mkdir -p "$DIST_DIR"

BUILT_ANY=0
for target in "${ARCH_LIST[@]}"; do
  target="$(echo "$target" | tr -d '[:space:]')"
  [[ -n "$target" ]] || continue

  # target 形如 linux/amd64 或 windows/amd64；只写架构名时默认 linux。
  case "$target" in
    */*) GOOS="${target%%/*}"; GOARCH="${target##*/}" ;;
    *)   GOOS=linux; GOARCH="$target" ;;
  esac

  case "$GOOS" in
    linux)   EXT="";  ;;
    windows) EXT=".exe" ;;
    *) warn "跳过未知系统: $GOOS"; continue ;;
  esac

  case "$GOARCH" in
    amd64|arm64|arm|386|loong64|riscv64) ;;
    *) warn "跳过未知架构: $GOARCH"; continue ;;
  esac

  pkg_dir="$DIST_DIR/frp_${FRP_VERSION}_${GOOS}_${GOARCH}"
  rm -rf "$pkg_dir"
  mkdir -p "$pkg_dir"

  log "编译 ${GOOS}/${GOARCH} (tags: frps${NOWEB_TAG#?}, version: ${CUSTOM_VERSION}) ..."
  if ! env CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
      go build -trimpath -ldflags "$LDFLAGS" -tags "frps${NOWEB_TAG}" \
      -o "$pkg_dir/frps$EXT" ./cmd/frps; then
    warn "${GOOS}/${GOARCH} 的 frps 编译失败，跳过"
    rm -rf "$pkg_dir"
    continue
  fi
  if ! env CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
      go build -trimpath -ldflags "$LDFLAGS" -tags "frpc${NOWEB_TAG}" \
      -o "$pkg_dir/frpc$EXT" ./cmd/frpc; then
    warn "${GOOS}/${GOARCH} 的 frpc 编译失败，跳过"
    rm -rf "$pkg_dir"
    continue
  fi

  chmod 0755 "$pkg_dir/frps$EXT" "$pkg_dir/frpc$EXT"
  # 打成与上游同名的压缩包（Windows 用 zip），安装脚本无需改动即可下载
  if [[ "$GOOS" == "windows" ]]; then
    # Windows 用户需要 .zip。`zip` CLI 未必存在，故用项目自带的 Node 打包器
    # （零依赖，见 src/zip.ts），并通过面板的打包工具生成安装包。
    if command -v zip >/dev/null 2>&1; then
      ( cd "$DIST_DIR" && zip -qr "frp_${FRP_VERSION}_${GOOS}_${GOARCH}.zip" "frp_${FRP_VERSION}_${GOOS}_${GOARCH}" ) \
        || { warn "zip 打包失败"; rm -rf "$pkg_dir"; continue; }
      BUILT_ANY=1
      log "  -> $DIST_DIR/frp_${FRP_VERSION}_${GOOS}_${GOARCH}.zip"
    else
      log "  未安装 zip 命令，跳过压缩（面板会使用内置 ZIP 打包器）"
      BUILT_ANY=1
      log "  -> $pkg_dir/ (未压缩)"
    fi
  else
    tar -czf "$DIST_DIR/frp_${FRP_VERSION}_${GOOS}_${GOARCH}.tar.gz" \
      -C "$DIST_DIR" "frp_${FRP_VERSION}_${GOOS}_${GOARCH}"
    BUILT_ANY=1
    log "  -> $DIST_DIR/frp_${FRP_VERSION}_${GOOS}_${GOARCH}.tar.gz"
  fi
done

if [[ "$BUILT_ANY" == "0" ]]; then
  die "没有任何架构编译成功"
fi

# 宿主架构同时放到 out/ 便于本机直接使用与自检
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  x86_64) HOST_ARCH=amd64 ;;
  aarch64) HOST_ARCH=arm64 ;;
esac
mkdir -p "$OUT_DIR"
if [[ -f "$DIST_DIR/frp_${FRP_VERSION}_linux_${HOST_ARCH}/frps" ]]; then
  cp -f "$DIST_DIR/frp_${FRP_VERSION}_linux_${HOST_ARCH}/frps" "$OUT_DIR/frps"
  cp -f "$DIST_DIR/frp_${FRP_VERSION}_linux_${HOST_ARCH}/frpc" "$OUT_DIR/frpc"
fi

log "构建完成:"
ls -lh "$DIST_DIR"/*.tar.gz 2>/dev/null || true
if [[ -x "$OUT_DIR/frps" ]]; then
  log "本机版本: $("$OUT_DIR/frps" --version) / $("$OUT_DIR/frpc" --version)"
fi

if [[ -x "$OUT_DIR/frpc" ]] && "$OUT_DIR/frpc" --help 2>&1 | grep -q diag; then
  log "定制子命令 frpc diag 已包含"
fi
