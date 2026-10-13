# ============================================================================
#  frp-console — Docker 镜像
# ----------------------------------------------------------------------------
#  多阶段构建：
#    1) builder  安装依赖并编译 TypeScript
#    2) runtime  仅带运行时依赖 + 预构建 frp 二进制
#
#  镜像内自带 6 个架构的定制版 frp 包（custom-frp/dist），
#  因此节点安装时无需 Go 工具链，也不必访问 GitHub。
#
#  用法见 docker-compose.yml 与 README 的「Docker 部署」章节。
#
#  在国内网络构建时可用构建参数切换镜像源（无需改本文件）：
#    docker build \
#      --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#      --build-arg APK_MIRROR=mirrors.aliyun.com \
#      -t frp-console .
#  或设置 BASE_IMAGE 指向内网镜像仓库中的 node:22-alpine。
# ============================================================================

# ---- 可配置的镜像源（默认官方源，国内可覆盖） ----
ARG BASE_IMAGE=node:22-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APK_MIRROR=""
# 面板版本标签（可选）。compose 会从 .env 自动传入；容器内 /api/health
# 始终返回真实版本（读自 package.json），不依赖这个标签。
ARG APP_VERSION=""

# ------------------------------------------------------------------ builder
FROM ${BASE_IMAGE} AS builder

ARG NPM_REGISTRY
WORKDIR /build

# 依赖层单独缓存：源码变更不会导致重新安装依赖
COPY package.json package-lock.json* ./
RUN npm config set registry "${NPM_REGISTRY}" \
 && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund)

# 全量依赖（含 typescript）用于编译
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 从 package.json 提取真实版本，随镜像分发（权威来源，无需手工同步）
RUN node -p "require('./package.json').version" > /build/VERSION

# 只保留生产依赖，减小拷贝体积
RUN npm prune --omit=dev

# ------------------------------------------------------------------ runtime
FROM ${BASE_IMAGE} AS runtime

# 版本标签由构建参数传入（compose 会自动从 .env 读取，见 docker-compose.yml）。
# 注意：LABEL 无法引用 RUN 设置的变量，只能用于 ARG，因此这里不设默认值，
# 未传时标签为空而不是误导性的 "unknown"。
# 运行时权威版本始终是 /app/VERSION（读自 package.json），可用
#   docker compose exec frp-console cat /app/VERSION
# 或  curl http://127.0.0.1:37000/api/health  查看。
ARG APP_VERSION=""
LABEL org.opencontainers.image.title="frp-console" \
      org.opencontainers.image.description="frps/frpc 管理面板（含定制版 frp，支持 Linux 6 架构与 Windows）" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/fatedier/frp"

ARG APK_MIRROR
# frps/frpc 与面板运行所需的最小工具集：
#   supervisor  容器内进程管理（PID 1 不是 systemd）
#   curl/tar    安装脚本与分发使用
#   tini        正确的 PID 1 信号转发与僵尸回收
RUN if [ -n "${APK_MIRROR}" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${APK_MIRROR}|g" /etc/apk/repositories; \
    fi \
 && apk add --no-cache \
      supervisor \
      curl \
      tar \
      tini \
      ca-certificates \
      tzdata \
    && rm -rf /var/cache/apk/*

ENV NODE_ENV=production \
    FRP_CONSOLE_HOME=/data \
    FRP_CONSOLE_HOST=0.0.0.0 \
    FRP_CONSOLE_PORT=37000 \
    FRP_CONSOLE_SERVICE_MANAGER=supervisor \
    FRP_CONSOLE_FRPS_CONFIG=/etc/frp/frps.toml \
    FRP_CONSOLE_FRPS_BIN=/usr/local/bin/frps \
    FRP_CONSOLE_SUPERVISOR_INCLUDE=/etc/supervisor/conf.d \
    FRP_CONSOLE_SUPERVISOR_LOG=/var/log/frps \
    FRP_CONSOLE_SUPERVISOR_CONF=/etc/supervisord.conf \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

# 运行时代码与生产依赖
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json
COPY public ./public
# 真实版本号（读自 package.json），用于核对部署版本
COPY --from=builder /build/VERSION ./VERSION

# 定制版 frp：预构建的多架构分发包 + 宿主架构可执行文件
COPY custom-frp/dist ./custom-frp/dist
COPY custom-frp/build-custom-frp.sh ./custom-frp/build-custom-frp.sh
COPY custom-frp/patches ./custom-frp/patches

# 运行时可写目录（数据卷挂载点）
RUN mkdir -p /data /etc/frp /var/log/frps /var/log/frps-console \
    && chmod +x /app/custom-frp/build-custom-frp.sh

# supervisord 主配置：只守护 frps，面板由容器 CMD 直接运行。
# Alpine 的 supervisord/supervisorctl 默认读 /etc/supervisord.conf，因此写到
# 该路径并覆盖发行版自带配置，避免 supervisorctl 找不到 socket。
COPY docker/supervisord.conf /etc/supervisord.conf

# 健康检查复用面板自带的 /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${FRP_CONSOLE_PORT}/api/health" || exit 1

# Host networking is the recommended mode (see docker-compose.yml), in which
# case EXPOSE is informational only. These are the default ports.
EXPOSE 37000 37001 37002

# tini 作为 PID 1；入口脚本准备 frps 二进制与初始配置
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
