#!/usr/bin/env bash
# ============================================================================
#  release.sh — 把 frp-console 打包成可分发的源码包
# ----------------------------------------------------------------------------
#  产出：dist-release/frp-console-<版本>.tar.gz
#
#  包内含：
#    - 面板源码（src / public / scripts / docker 配置文件）
#    - 预构建的 6 架构定制版 frp 二进制（custom-frp/dist/*.tar.gz）
#    - 构建与部署脚本、文档
#
#  包内不含：
#    - node_modules（目标机 npm install 生成）
#    - data/（运行时状态，含密钥）
#    - 编译产物 dist/（目标机 npm run build 生成）
#    - custom-frp/out 与解压后的架构目录（冗余，可从 tarball 解出）
#
#  用法：
#    ./release.sh                    # 打包当前版本
#    ./release.sh --with-deps        # 额外内嵌 node_modules（离线安装）
#    ./release.sh --out /path/dir    # 指定输出目录
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

WITH_DEPS=0
OUT_BASE="$HERE/dist-release"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-deps) WITH_DEPS=1 ;;
    --out)       OUT_BASE="$2"; shift ;;
    --version)   VERSION="$2"; shift ;;
    -h|--help)   sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;32m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[release]\033[0m %s\n' "$*" >&2; exit 1; }

PKG_NAME="frp-console-${VERSION}"
STAGE="$(mktemp -d)"
TARGET="$STAGE/$PKG_NAME"
mkdir -p "$TARGET"

# --------------------------------------------------------------- 完整性检查
[[ -f package.json ]] || die "未找到 package.json，请在项目根目录运行"
[[ -f src/index.ts ]] || die "未找到 src/index.ts"
[[ -f public/index.html ]] || die "未找到前端文件"

# 收集所有预构建包：linux 的 tar.gz 与 windows 的 zip
shopt -s nullglob
TARBALLS=("$HERE"/custom-frp/dist/*.tar.gz)
WIN_ZIPS=("$HERE"/custom-frp/dist/*.zip)
shopt -u nullglob
if [[ ${#TARBALLS[@]} -eq 0 && ${#WIN_ZIPS[@]} -eq 0 ]]; then
  die "未找到预构建二进制（custom-frp/dist/*.tar.gz 或 *.zip）。请先运行 custom-frp/build-custom-frp.sh --all-arches"
fi
log "预构建包: linux ${#TARBALLS[@]} 个, windows ${#WIN_ZIPS[@]} 个"

# ------------------------------------------------------------------- 源码
log "复制源码 ..."
for item in src public scripts docker; do
  [[ -e "$item" ]] || { warn "跳过缺失项: $item"; continue; }
  cp -r "$item" "$TARGET/"
done

# 源码里的临时/诊断脚本不随包分发
rm -f "$TARGET"/scripts/_tmp*.mjs 2>/dev/null || true

for f in package.json package-lock.json tsconfig.json README.md CHANGELOG.md \
         Dockerfile docker-compose.yml .dockerignore .gitignore \
         release.sh; do
  [[ -f "$f" ]] && cp "$f" "$TARGET/"
done
[[ -f "$TARGET/release.sh" ]] && chmod +x "$TARGET/release.sh"

# --------------------------------------------------------------- 定制版 frp
log "复制定制版 frp（含 6 架构预构建包）..."
mkdir -p "$TARGET/custom-frp/dist"
cp custom-frp/build-custom-frp.sh "$TARGET/custom-frp/"
[[ -f custom-frp/README.md ]] && cp custom-frp/README.md "$TARGET/custom-frp/"
cp -r custom-frp/patches "$TARGET/custom-frp/"
for t in "${TARBALLS[@]}"; do
  cp "$t" "$TARGET/custom-frp/dist/"
done
# Windows zip（若有）
for z in "${WIN_ZIPS[@]}"; do
  cp "$z" "$TARGET/custom-frp/dist/"
done
# Windows 的 frpc.exe：面板生成 Windows 安装包时直接读取它。
# 若构建时未压缩成 zip，则从解压目录复制并补一个 zip（用内置打包器）。
WIN_DIR=""
for d in "$HERE"/custom-frp/dist/*_windows_*; do
  [[ -d "$d" ]] || continue
  [[ -f "$d/frpc.exe" ]] || continue
  WIN_DIR="$d"
  break
done
if [[ -n "$WIN_DIR" ]]; then
  mkdir -p "$TARGET/custom-frp/dist/$(basename "$WIN_DIR")"
  cp "$WIN_DIR/frpc.exe" "$TARGET/custom-frp/dist/$(basename "$WIN_DIR")/"
  log "已包含 Windows frpc.exe ($(basename "$WIN_DIR"))"
  # 若还没有 zip，就地生成一个，方便直接分发
  WIN_ZIP_NAME="$(basename "$WIN_DIR").zip"
  if [[ ! -f "$TARGET/custom-frp/dist/$WIN_ZIP_NAME" ]]; then
    if command -v zip >/dev/null 2>&1; then
      ( cd "$TARGET/custom-frp/dist" && zip -qr "$WIN_ZIP_NAME" "$(basename "$WIN_DIR")" ) \
        && log "已生成 $WIN_ZIP_NAME"
    fi
  fi
fi
chmod +x "$TARGET/custom-frp/build-custom-frp.sh"

# 本机架构的可用二进制（免去首次启动时的解包等待）
HOST_ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
HOST_TAR="$TARGET/custom-frp/dist/frp_${VERSION}_linux_${HOST_ARCH}.tar.gz"
# 版本号可能与包名不同（例如 0.71.0-console），按实际文件名匹配
HOST_TAR="$(ls "$TARGET"/custom-frp/dist/*_linux_"$HOST_ARCH".tar.gz 2>/dev/null | head -1 || true)"
if [[ -n "$HOST_TAR" && -f "$HOST_TAR" ]]; then
  mkdir -p "$TARGET/custom-frp/out"
  tmp="$(mktemp -d)"
  tar -xzf "$HOST_TAR" -C "$tmp"
  find "$tmp" -maxdepth 2 -name frps -exec cp {} "$TARGET/custom-frp/out/frps" \;
  find "$tmp" -maxdepth 2 -name frpc -exec cp {} "$TARGET/custom-frp/out/frpc" \;
  chmod +x "$TARGET/custom-frp/out/"* 2>/dev/null || true
  rm -rf "$tmp"
  log "已附上本机架构（$HOST_ARCH）可直接运行的二进制"
fi

# --------------------------------------------------------- 可选：依赖内嵌
if [[ "$WITH_DEPS" == "1" ]]; then
  log "内嵌 node_modules（离线安装用，体积较大）..."
  cp -r node_modules "$TARGET/"
fi

# --------------------------------------------------------- .env 模板
# 只提供模板，不自动创建 .env：否则用户可能带着占位符密码直接启动，
# 却不知道自己的密码是什么。用户 cp 后按提示填写即可。
if [[ -f .env.example ]]; then
  sed -e "s|^APP_VERSION=.*|APP_VERSION=${VERSION}|" \
      -e "s|^# frp-console .* 部署配置示例|# frp-console ${VERSION} 部署配置示例|" \
      .env.example > "$TARGET/.env.example"
  log "已生成 .env.example"
fi

# --------------------------------------------------------------- 安装说明
# 优先使用仓库内的 INSTALL.md 模板（便于审阅与维护），替换版本/时间占位符。
if [[ -f INSTALL.md ]]; then
  sed -e "s|@VERSION@|${VERSION}|g" \
      -e "s|@BUILD_TIME@|$(date '+%Y-%m-%d %H:%M:%S')|g" \
      INSTALL.md > "$TARGET/INSTALL.md"
  log "已生成 INSTALL.md（来自模板）"
else
  warn "未找到 INSTALL.md 模板，跳过"
fi

# ------------------------------------------------ 权限归一（避免 600 权限）
# 打包前把只读文件放宽，否则解压到别的机器后其他用户无法读取。
log "归一化文件权限 ..."
find "$TARGET" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$TARGET" -type f -exec chmod 644 {} + 2>/dev/null || true
# 可执行文件单独恢复
for exe in "$TARGET"/release.sh "$TARGET"/custom-frp/build-custom-frp.sh \
           "$TARGET"/docker/docker-entrypoint.sh \
           "$TARGET"/custom-frp/out/frps "$TARGET"/custom-frp/out/frpc; do
  [[ -f "$exe" ]] && chmod 755 "$exe"
done

# ------------------------------------------------------------------- 打包
mkdir -p "$OUT_BASE"
ARCHIVE="$OUT_BASE/${PKG_NAME}.tar.gz"
log "生成压缩包 ..."
( cd "$STAGE" && tar -czf "$ARCHIVE" "$PKG_NAME" )

# 同时输出 sha256 便于校验传输完整性
( cd "$OUT_BASE" && sha256sum "${PKG_NAME}.tar.gz" > "${PKG_NAME}.tar.gz.sha256" )

rm -rf "$STAGE"

# Use stat rather than du: du can report a stale size while the file is still
# being flushed to disk.
BYTES="$(stat -c '%s' "$ARCHIVE")"
SIZE="$(awk -v b="$BYTES" 'BEGIN{printf "%.1f MB", b/1048576}')"
COUNT="$(tar -tzf "$ARCHIVE" | wc -l)"
log "完成：$ARCHIVE"
log "  大小: $SIZE（$BYTES 字节）   文件数: $COUNT"
log "  校验: $(cat "${ARCHIVE}.sha256" | awk '{print $1}')"
log ""
log "传输到目标机后："
log "  tar xzf ${PKG_NAME}.tar.gz && cd ${PKG_NAME}"
log "  cat INSTALL.md"
