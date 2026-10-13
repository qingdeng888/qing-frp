# frp-console

基于 **frps / frpc** 的可视化管理面板：在 Web 上配置 frps 服务端，在节点管理处为每台机器生成 **一键安装脚本**（systemd 守护），并支持单脚本配置多个 `[[proxies]]`，远端端口可自定义或从 frps 端口范围内随机分配。

实测环境：Debian 13 / Node 22 / frp v0.71.0（已通过真实 frps+frpc 建立隧道验证）。

---

## 功能

### frps 服务端
- Web 界面配置**控制端口 `bindPort`**、监听地址、**连接密钥 `auth.token`**（支持一键随机生成）
- 配置**允许客户端使用的端口范围 `allowPorts`**，支持多个区间、可视化增删
- 虚拟主机（`vhostHTTPPort` / `vhostHTTPSPort` / `subDomainHost`）
- 可选启用 frps 自带 Dashboard、KCP/QUIC 端口、TLS、日志级别、心跳、`maxPortsPerClient` 等
- 一键**生成 `frps.toml` + systemd unit + 启动/重启服务**，支持 `frps verify` 预校验
- 额外的自定义 TOML 片段可直接追加

### 端口池
- 只从 frps 的 `allowPorts` 区间分配端口，并自动**排除 frps 自身监听的端口**（bindPort / dashboard / vhost 等）
- **远端端口自定义**：校验是否在允许范围内、是否与其它代理冲突
- **远端端口随机**：从端口范围内挑选空闲端口并持久化占用，界面可见
- 端口池耗尽时自动回退为 `remotePort = 0`（由 frps 运行时分配）
- 支持**手动保留端口**，随机分配会跳过
- 端口范围收缩后自动重算已越界的随机端口

### 节点与 frpc
- 节点（每台跑 frpc 的机器）增删改查，独立安装 token
- **密钥/端口自动继承**：节点的 `auth.token` 与 `serverPort` 留空时自动跟随 frps 当前值。
  frps 只有**一个全局密钥**，因此改 frps 密钥或控制端口后，重新生成脚本即可，**不必逐节点重装**
- **一键安装脚本**：`curl ... | sudo bash` 即可完成下载 frp、写配置、装 systemd 服务
  - 自动识别架构（amd64 / arm64 / arm / 386 / loong64 / riscv64）
  - 已安装同版本则跳过下载；支持 `--base` 指定 GitHub 镜像
  - 支持 `--refresh`（从面板拉取最新配置）、`--uninstall`、`--dir`、`--version`
  - 日志输出到 console，因此 `journalctl -u <service>` 可直接看到
- **节点实时状态**：配合定制版 frpc，节点会主动上报心跳，面板直接显示在线/离线、
  主机名、版本、运行时长、代理运行数与内存占用，**无需 SSH**
- **一键定制构建**：面板「定制构建」页可从源码构建带审计/配额/诊断/心跳的 frps/frpc
- **GitHub 代理 / 镜像**：服务器连 GitHub 不畅时，可填前缀代理（如 `https://raw.xiaoy.de`），
  下载会自动拼成 `https://raw.xiaoy.de/https://github.com/...`；支持自建镜像、Go 模块代理
- **单个脚本配置多个 `[[proxies]]`**，支持类型：
  `tcp` / `udp` / `http` / `https` / `tcpmux` / `stcp` / `xtcp` / `sudp`
- **填写代理时实时预览**：弹窗底部随时显示该代理将写入 `frpc.toml` 的 `[[proxies]]` 段，
  字段与生成结果一一对应，并提示端口是否越界
- 每个代理可设置：本地 IP/端口、远端端口（固定或随机）、自定义域名、子域名、locations、
  `secretKey`、`multiplexer`、加密/压缩、带宽限制、`proxyProtocolVersion`、HTTP Basic 认证、Host 重写、启用/禁用
- 生成 `frpc.toml` 可单独查看/下载

> ⚠️ **两个「协议」不是一回事，容易混淆：**
> - **新建节点 → 连接协议**：frpc 如何连上 frps（`tcp`/`kcp`/`quic`/`websocket`/`wss`），
>   对应 `frpc.toml` 顶层的 `transport.protocol`，**与 `[[proxies]]` 无关**
> - **节点详情 → 添加代理 → 类型**：这才是 `[[proxies]]` 的类型，选完才会出现
>   `localIP` / `localPort` / `remotePort` 等字段；填写时弹窗底部有实时 TOML 预览

### 面板本身
- 零原生依赖：使用 Node 内置 `node:sqlite`，无需编译
- **账号密码登录**：默认 `admin` / `changeme`，会话 Cookie（HttpOnly + SameSite），支持退出登录
- **会话持久化在 SQLite**：面板重启/升级后无需重新登录；数据库只存 token 的 SHA-256 哈希，库泄露也无法重放会话；退出登录或在过期时自动删除
- 同时兼容 HTTP Basic，方便 `curl -u admin:密码 ...` 脚本调用
- 一键安装端点使用**不可猜测的 per-node token** 作为凭证，可在面板重置以吊销
- 响应式界面，手机可用

---

## 快速开始

```bash
cd /root/dsh/frp
npm install
npm run build

# 启动面板：默认监听 0.0.0.0:37000，登录账号 admin / changeme
node --disable-warning=ExperimentalWarning dist/index.js

# 生产环境建议改掉默认密码
FRP_CONSOLE_PASSWORD='你的强密码' node --disable-warning=ExperimentalWarning dist/index.js
```

开发模式（热重载）：

```bash
npm run dev
```

浏览器打开 `http://<服务器IP>:37000`，使用 **admin / changeme** 登录。

### 推荐使用流程

1. **frps 设置** —— 填写控制端口与密钥，保存
2. **端口范围** —— 添加允许客户端使用的区间，例如 `20000-30000`
3. **总览 → 生成配置并重启 frps** —— 写入 `/etc/frp/frps.toml` 并启动 systemd 服务
4. **节点管理 → 新建节点** —— 填写该节点要连接的 frps 公网地址
   （此处的「连接协议」只是 frpc→frps 的连接方式，不是代理类型）
5. 进入节点详情 → **添加代理** —— 这里选「类型」后才会出现 `[[proxies]]` 字段：
   逐个配置本地 IP/端口，远端端口填固定值或勾选随机。弹窗底部会**实时显示生成的 TOML**
6. 点击 **一键安装脚本** —— 复制一行命令，到目标机器执行：

```bash
curl -fsSL http://<面板IP>:8080/api/install/<install-token>.sh | sudo bash
```

安装完成后 frpc 由 systemd 守护，开机自启。

---

## 源码打包分发

打包成可分发的源码包，用于在**其他机器**安装测试：

```bash
./release.sh                    # 输出到 dist-release/
./release.sh --with-deps        # 额外内嵌 node_modules（离线安装）
./release.sh --out /path/to/dir # 指定输出目录
```

产出：

```
dist-release/frp-console-<version>.tar.gz        约 99 MB
dist-release/frp-console-<version>.tar.gz.sha256 校验文件
```

### 包内容

| 包含 | 说明 |
| --- | --- |
| `src/` `public/` `scripts/` | 面板源码与测试脚本 |
| `custom-frp/dist/*.tar.gz` | **6 个架构**的定制版 frp 预构建包 |
| `custom-frp/out/{frps,frpc}` | 本机架构可直接运行的二进制 |
| `custom-frp/patches/` | 定制补丁（源码变换清单 + Go 补丁） |
| `Dockerfile` `docker-compose.yml` `docker/` | Docker 部署文件 |
| `INSTALL.md` | 自动生成的安装说明（含首次使用流程与排查表） |
| `release.sh` | 便于在目标机二次打包分发 |

### 包内不含（目标机生成或属于本机状态）

| 排除 | 原因 |
| --- | --- |
| `node_modules/` | 目标机 `npm install` 生成（或用 `--with-deps` 内嵌） |
| `dist/` | 目标机 `npm run build` 生成 |
| `data/` | **运行时状态，含数据库与会话密钥** |
| `custom-frp/dist/*/` | 解压后的架构目录，冗余（tarball 已含） |
| `.git/` | 版本控制信息 |

### 目标机安装

```bash
# 1) 校验完整性（可选但推荐）
sha256sum -c frp-console-<version>.tar.gz.sha256

# 2) 解压
tar xzf frp-console-<version>.tar.gz
cd frp-console-<version>

# 3) 查看安装说明并选择部署方式
cat INSTALL.md
```

两种部署方式：

- **Docker**（推荐）：`docker compose up -d --build`
- **直接运行**：`npm install && npm run build && node dist/index.js`

### 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | >= 22.5（需内置 `node:sqlite`，无原生编译依赖） |
| Docker | 20.10+ / Compose v2（Docker 方式） |
| 操作系统 | Linux（amd64 / arm64 / arm / 386 / loong64 / riscv64） |

> 目标机**不需要 Go 工具链**，也**不需要访问 GitHub**——定制版二进制已随包分发。

## Docker 部署

镜像**内置 6 个架构的定制版 frp 分发包**，开箱即用：节点安装不需要 Go 工具链，
也不需要访问 GitHub。

### 使用预构建镜像（ghcr.io）

每次推送到 `main` 或打 `v*` 标签，GitHub Actions 会自动构建多架构镜像并发布：

```bash
docker pull ghcr.io/qingdeng888/qing-frp:latest
```

可用标签：

| 标签 | 说明 |
| --- | --- |
| `latest` | 默认分支最新构建 |
| `main` | 分支名 |
| `0.0.1` | 语义化版本（打 `v*` 标签时） |
| `0.0` | 主次版本 |
| `sha-xxxxxxx` | 每次提交的短哈希，便于回溯 |

支持 `linux/amd64` 与 `linux/arm64`。

> 首次发布后，若希望匿名拉取，需在
> `https://github.com/users/qingdeng888/packages/container/qing-frp/settings`
> 把该 Package 的可见性设为 Public。

### 快速开始（本地构建）

```bash
cd /root/dsh/frp

# 1) 可选：自定义密码与端口
cat > .env <<'EOF'
PANEL_PASSWORD=你的强密码
PUBLIC_URL=http://你的公网IP:37000
EOF

# 2) 构建并启动
docker compose up -d --build

# 3) 查看状态
docker compose ps
docker compose logs -f frp-console
```

浏览器打开 `http://<服务器IP>:37000`，用 `admin` / 你设置的密码登录。

### 网络模式：host（为什么不用端口映射）

compose 默认使用 `network_mode: host`。原因是 **frps 需要监听任意端口范围**：

frps 的 `allowPorts`（例如 `20000-30000`）意味着最多上万个端口要对外监听。
bridge 模式下每个端口都得写一条 `-p 20000:20000`，**完全不可维护**；
host 模式下容器直接使用宿主机网络，**范围端口自动生效**。

代价是没有网络隔离，端口直接暴露在宿主机上，需要自行配置防火墙。

### 端口说明

host 模式下监听端口即宿主机端口：

| 默认端口 | 用途 | 如何修改 |
| --- | --- | --- |
| 37000 | 面板 Web 界面 | 环境变量 `PANEL_PORT` |
| 37001 | frps 控制端口（frpc 连接用） | 面板「frps 设置 → 控制端口」 |
| 37002 | frps 内置 Dashboard（默认未启用） | 面板「frps 设置 → Dashboard」 |
| 自定义范围 | 穿透的业务端口（如 20000-30000） | 面板「端口范围」 |

> 穿透端口由 frps 的 `allowPorts` 决定，host 模式下自动监听宿主机，无需任何映射。

### 如果坚持用 bridge 模式

若必须使用端口映射（例如多实例隔离），可改用 `ports:` 并显式列出每个端口：

```yaml
# 注意：范围端口必须逐个列出，端口多时不实用
ports:
  - "37000:37000"    # 面板
  - "37001:37001"    # frps 控制端口
  - "20000-20100:20000-20100"   # 业务端口范围（Docker 支持该写法）
```

Docker 实际支持 `-p 20000-20100:20000-20100` 这样的范围映射，但仍需**手动与 allowPorts 保持同步**，
且端口数量很大时启动会明显变慢。因此默认仍推荐 host 模式。

### 国内网络构建

构建镜像需联网拉取 `node:22-alpine`、npm 依赖与 apk 包。网络不畅时在 `.env` 中切换源：

```bash
NPM_REGISTRY=https://registry.npmmirror.com
APK_MIRROR=mirrors.aliyun.com
BASE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
```

```bash
docker compose build --no-cache && docker compose up -d
```

完全离线时可先在别处构建再导出镜像：

```bash
docker save frp-console:latest | gzip > frp-console-image.tar.gz
# 目标机
gunzip -c frp-console-image.tar.gz | docker load && docker compose up -d
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PANEL_PASSWORD` | `changeme` | 面板登录密码，**生产必须修改** |
| `PANEL_USER` | `admin` | 面板登录账号 |
| `PANEL_PORT` | `37000` | 面板监听端口（host 模式） |
| `PUBLIC_URL` | 空 | **面板对外地址**，见下方说明 |

| `TZ` | `Asia/Shanghai` | 时区 |

> frps 控制端口不通过环境变量设置，而是在面板「frps 设置 → 控制端口」中配置
> （默认 37001，写入 `frps.toml` 的 `bindPort`）。

### ⚠ 必须设置 PUBLIC_URL

一键安装脚本会把该地址写入节点，供节点回连（心跳与配置刷新）。
留空则自动探测容器内网 IP，**外部节点将无法连接**：

```
FRP_CONSOLE_PANEL_URL=http://172.17.0.2:37000   ← 容器内网地址，节点连不上
```

在 `docker-compose.yml` 里设置，或在面板「frps 设置 → 面板公网地址」中填写：

```yaml
environment:
  FRP_CONSOLE_PUBLIC_URL: "http://你的公网IP:37000"
```

### 容器内的进程管理

容器里 **PID 1 不是 systemd**，因此面板使用 **supervisord** 守护 frps：

| 环境 | 后端 | 面板「重启 frps」实际执行 |
| --- | --- | --- |
| 裸机 / VM | systemd | `systemctl restart frps` |
| Docker 容器 | supervisord | `supervisorctl restart frps` |
| 都没有 | 仅生成配置 | 提示手动启动 |

后端是**自动探测**的（`/run/systemd/system` 是否存在），也可用
`FRP_CONSOLE_SERVICE_MANAGER=systemd|supervisor|none` 强制指定。

### 数据持久化

```yaml
volumes:
  - frp-console-data:/data      # SQLite、会话、二进制缓存（命名卷）
  - ./data/frps:/etc/frp        # frps.toml，便于手工编辑
  - ./data/logs:/var/log/frps   # frps 日志
```

备份只需保留 `frp-console-data` 卷与 `./data` 目录。

### 节点也部署在容器里

安装脚本会自动检测 systemd：**没有 systemd 时回退为 nohup 后台进程**
（含 pid 文件管理、心跳环境变量注入），只是不配置开机自启。

```bash
# 在容器节点内执行安装脚本
curl -fsSL http://<面板>/api/install/<token>.sh | bash
```

### 常用命令

```bash
docker compose logs -f frp-console     # 面板日志
docker compose exec frp-console supervisorctl status   # frps 状态
docker compose exec frp-console supervisorctl restart frps
docker compose restart frp-console     # 重启面板
docker compose down                    # 停止（保留数据卷）
docker compose down -v                 # 停止并删除数据卷（危险）
```

### 镜像说明

多阶段构建，运行镜像基于 `node:22-alpine`：

| 层 | 内容 |
| --- | --- |
| builder | 安装依赖、编译 TypeScript、裁剪为生产依赖 |
| runtime | 仅生产依赖 + 6 个架构的定制版 frp 包 + supervisord/tini |

镜像内 `node:sqlite` 为 Node 内置模块，**无需原生编译**，因此 Alpine 即可运行。

## CLI（无需启动面板）

```bash
npx tsx src/cli.ts settings --bind-port 7000 --token mysecret --range "20000-30000"
npx tsx src/cli.ts node add --name 香港节点 --addr 1.2.3.4
npx tsx src/cli.ts proxy add --node 1 --name ssh --type tcp --local-port 22 --remote random
npx tsx src/cli.ts proxy add --node 1 --name web --type http --local-port 8080 --domain app.example.com
npx tsx src/cli.ts install --node 1 > install.sh
npx tsx src/cli.ts frps-toml
npx tsx src/cli.ts ports
```

---

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FRP_CONSOLE_HOME` | 当前目录 | 数据根目录 |
| `FRP_CONSOLE_DATA_DIR` | `$HOME/data` | SQLite、frp 二进制、临时文件 |
| `FRP_CONSOLE_PUBLIC_DIR` | 自动探测 | 前端静态资源目录 |
| `FRP_CONSOLE_HOST` | `0.0.0.0` | 面板监听地址 |
| `FRP_CONSOLE_PORT` | `37000` | 面板端口 |
| `FRP_CONSOLE_USER` | `admin` | 面板登录账号 |
| `FRP_CONSOLE_PASSWORD` | `changeme` | 面板登录密码；**请在生产环境修改** |
| `FRP_CONSOLE_SESSION_TTL` | `43200` | 登录会话有效期（秒），默认 12 小时。会话存在 SQLite，重启面板不会掉线 |
| `FRP_CONSOLE_COOKIE_SECURE` | `0` | 面板走 HTTPS 时设为 `1`，Cookie 加 Secure |
| `FRP_CONSOLE_PUBLIC_URL` | 自动探测内网 IP | 面板公网地址（**推荐在界面里设置**，见下） |
| `FRP_CONSOLE_FRPS_CONFIG` | `/etc/frp/frps.toml` | frps 配置路径 |
| `FRP_CONSOLE_FRPS_UNIT` | `/etc/systemd/system/frps.service` | frps unit 路径 |
| `FRP_CONSOLE_FRPS_BIN` | `$DATA/bin/frps` | frps 二进制路径 |
| `FRP_CONSOLE_FRPS_SERVICE` | `frps` | frps 服务名 |
| `FRP_CONSOLE_SYSTEMD` | `1` | 设为 `0` 则只写文件、不调用 systemctl |

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（免鉴权） |
| POST | `/api/auth/login` | 登录，`{"username":"admin","password":"..."}` |
| POST | `/api/auth/logout` | 退出登录，清除会话 |
| GET | `/api/auth/me` | 当前登录状态（免鉴权，始终 200） |
| GET | `/api/system/info` | 主机/版本/路径信息 |
| GET/PUT | `/api/settings` | 读取/保存 frps 设置 |
| GET | `/api/settings/preview` | 预览生成的 `frps.toml` 与 unit |
| POST | `/api/settings/verify` | 用 `frps verify` 校验配置 |
| GET | `/api/frps/status` | 服务状态 |
| POST | `/api/frps/deploy` | 写配置 + 重启 frps |
| POST | `/api/frps/control` | `{"action":"start\|stop\|restart\|reload"}` |
| GET | `/api/frps/logs` | journald 日志 |
| GET | `/api/ports` | 端口池统计与保留列表 |
| POST/DELETE | `/api/ports/reserve[/:port]` | 手动保留/释放端口 |
| GET/POST | `/api/nodes` | 节点列表/创建 |
| GET/PUT/DELETE | `/api/nodes/:id` | 节点详情/更新/删除 |
| POST | `/api/nodes/:id/token` | 重置安装 token |
| GET/POST | `/api/nodes/:id/proxies` | 代理列表/创建 |
| PUT/DELETE | `/api/proxies/:id` | 更新/删除代理 |
| POST | `/api/proxies/:id/reroll` | 重新随机分配端口 |
| POST | `/api/proxies/preview` | 渲染草稿代理的 `[[proxies]]` 段（面板实时预览用） |
| GET | `/api/nodes/:id/install-script` | 下载一键安装脚本 |
| GET | `/api/nodes/:id/frpc.toml` | 下载 `frpc.toml` |
| GET | `/api/install/:token.sh` | **免鉴权**一键安装（token 即凭证） |
| GET | `/api/install/:token/frpc.toml` | **免鉴权**配置拉取（供 `--refresh`） |
| POST | `/api/heartbeat` | **免鉴权**节点心跳上报（token 即凭证，定制 frpc 调用） |
| GET | `/api/nodes/:id/heartbeat` | 节点最新心跳与在线状态 |
| GET | `/api/custom-build/status` | 定制构建环境与产物状态 |
| POST | `/api/custom-build/start` | 从源码启动定制构建 |
| GET | `/api/custom-build/log` | 构建日志 |
| POST | `/api/custom-build/install` | 把构建产物安装到面板 bin 目录 |
| POST | `/api/mirrors/test` | 测试 GitHub 代理连通性（下载 + 可选 API） |

---

## 测试

```bash
# 单元 + 集成测试（含用真实 frps/frpc 二进制校验生成的配置）
FRP_CONSOLE_HOME=/tmp/frp-console-e2e npx tsx scripts/e2e.ts

# 真实穿透验证：启动 frps，建立隧道并实际拉取数据
FRP_CONSOLE_HOME=/tmp/frp-tunnel-test npx tsx scripts/tunnel-e2e.ts

# 浏览器 UI 验证（需面板运行中 + playwright；会自动用 admin 登录）
PANEL_PASSWORD='changeme' node scripts/ui-check.mjs http://127.0.0.1:37000
node scripts/login-check.mjs http://127.0.0.1:37000 admin changeme
node scripts/layout-check.mjs http://127.0.0.1:37000

# 会话持久化验证（自动启动/重启面板，验证重启后不掉线）
node --disable-warning=ExperimentalWarning scripts/session-check.mjs
```

---

## 只使用定制版 frp

frp-console **只分发自己的定制版 frp**，不再支持上游预编译包。定制版包含：

| 能力 | 说明 |
|---|---|
| `frpc diag` | 节点连通性一键诊断 |
| frpc 心跳上报 | 节点主动上报，面板显示在线/负载 |
| frps 审计日志 | JSON 行事件日志 |
| frps 流量配额 | 按代理限额，超限拒绝新建 |
| 内置 Dashboard | 编译时已包含前端资源，功能与上游一致 |

### 预构建多架构二进制

二进制**随项目分发**，节点部署时不需要 Go 工具链，也不需要访问 GitHub：

```
custom-frp/dist/frp_0.71.0_linux_amd64.tar.gz     14M   x86_64
custom-frp/dist/frp_0.71.0_linux_arm64.tar.gz     13M   aarch64
custom-frp/dist/frp_0.71.0_linux_arm.tar.gz       13M   armv7l / armv6l
custom-frp/dist/frp_0.71.0_linux_386.tar.gz       13M   i386 / i686
custom-frp/dist/frp_0.71.0_linux_loong64.tar.gz   13M   loongarch64
custom-frp/dist/frp_0.71.0_linux_riscv64.tar.gz   13M   riscv64
```

覆盖安装脚本能识别的**全部 6 种架构**，缺任一架构都会有测试失败提示。

重新构建（含交叉编译，需 Go 与 npm）：

```bash
./custom-frp/build-custom-frp.sh --with-web --all-arches
```

### 版本标识

定制版带 `-console` 后缀，便于识别与检测陈旧安装：

```
0.71.0-console
```

压缩包名仍用基础版本（`frp_0.71.0_linux_amd64.tar.gz`），因此自建镜像可直接复用同一套目录结构。

### 分发与依赖

节点通过面板端点下载，**没有 GitHub 回退**：

```
http://<面板地址>/custom-frp/frp_0.71.0_linux_amd64.tar.gz
```

因此**必须配置面板公网地址**。未配置时安装脚本会**明确报错**，而不是静默降级：

```
未配置面板公网地址，无法下载定制版 frpc。
请在面板「frps 设置 → 面板公网地址」中填写后重新生成脚本，或用 --base 指定自建镜像。
```

同理，若面板找不到定制 frps 二进制，部署会报错并提示去「定制构建」页构建。

### 自建镜像

节点级「下载镜像 base URL」可指向自建静态服务，结构为 `<base>/frp_<版本>_linux_<架构>.tar.gz`：

```bash
mkdir -p /srv/frp/v0.71.0 && cp custom-frp/dist/*.tar.gz /srv/frp/v0.71.0/
python3 -m http.server 8081 --directory /srv/frp
# 节点配置里填 http://<IP>:8081/v0.71.0
```

## 面板公网地址（重要）

一键安装脚本会把面板地址写进节点的 systemd unit，供节点回连（心跳上报、`--refresh` 拉配置）。
自动探测只能得到**内网 IP**，对跨网络的节点毫无用处：

```
Environment=FRP_CONSOLE_PANEL_URL=http://10.88.32.112:37000   ← 外网节点连不上
```

所以在「frps 设置 → 面板公网地址」里填写**公网 IP 或域名**：

```
http://1.2.3.4:37000
https://frp.example.com          （HTTPS 反代场景，不带端口）
```

### 解析优先级

```
界面设置  >  FRP_CONSOLE_PUBLIC_URL 环境变量  >  按请求 Host 智能推断  >  内网探测（标记为猜测）
```

其中「按请求 Host 推断」是：如果你用公网域名访问面板，面板会自动采用该域名；
只有用内网 IP 访问时才回退为内网猜测，并在界面上**显式警告**：

> ⚠ 当前使用的是自动探测的内网地址 http://10.88.32.112:37000。如果节点在别的网络，
> 安装脚本里的回连地址将无法访问——请在上方填写公网地址或域名。

填入内网地址也会被提示（面板能识别 RFC1918 / 回环 / CGNAT 地址）。
设置页有「用当前访问地址填入」一键按钮。

## frps 对外地址与节点继承

「frps 设置 → 监听与密钥」里有 **frps 地址（对外公布）**：

```
frps 地址（对外公布）  [ 203.0.113.10 ]  [用当前访问地址填入]
```

新建节点时「frps 地址」**留空即继承**此值：

| 节点「frps 地址」 | 实际使用 |
| --- | --- |
| 留空 | 继承 frps 设置里的地址 |
| 填写 | 用节点自己的 |
| 留空且设置也为空 | 生成配置时提示补填 |

> 只需维护一处，**改一次全局生效**：之后新建的节点不用再填，已建节点
> （留空的）也会自动跟随，无需逐个重装。
> 节点列表/详情会显示生效地址，继承来的标注「继承」徽标。

**输入宽容**：可直接粘贴完整 URL，会自动剥掉协议、端口与路径：

| 输入 | 存为 |
| --- | --- |
| `https://frp.example.com:37001/some/path` | `frp.example.com` |
| `http://1.2.3.4:37001` | `1.2.3.4` |
| `[2001:db8::1]:37001` | `[2001:db8::1]` |

> 只填主机名或 IP，**不要带 `http://` 和端口**——端口由 `bindPort` 单独控制。

## Windows 节点

Windows 没有 systemd，也通常没有 bash，因此不使用 Linux 的一键安装脚本，
而是**下载一个 zip 包解压使用**。

### 安装步骤

1. 面板「节点管理」→ 打开节点 → 点 **Windows 包**
2. 得到一个 `frp-console-frpc-<id>-windows-amd64.zip`，解压到任意目录（建议 `C:\frpc`）
3. 右键 `frpc-manage.cmd` → **以管理员身份运行**，或 CMD 中执行：

```bat
frpc-manage.cmd install
```

这会启动 frpc 并**设置开机自启**（Windows 任务计划程序，登录时触发）。

### 交互式菜单

**双击 `frpc-manage.cmd`** 即可打开菜单，按数字选择：

```
============================================================
  frp-console - frpc for Windows
------------------------------------------------------------
  节点   : 你的节点名
  服务器 : 1.2.3.4:37001
============================================================
  运行状态: 已停止
  开机自启: 未启用

  [1] 安装（启动 + 设置开机自启）
  [2] 启动
  [3] 停止
  [4] 重启
  [5] 查看状态
  [6] 设置开机自启
  [7] 卸载（停止 + 删除开机自启）
  [0] 退出

请输入序号后回车:
```

每次操作后会提示「按回车返回菜单（输入 q 退出）」，可连续操作。

### 命令行参数（便于脚本调用）

也可直接传参，跳过菜单：

| 命令 | 作用 |
| --- | --- |
| `frpc-manage.cmd install` | 安装：启动 + 设置开机自启 |
| `frpc-manage.cmd start` | 启动 |
| `frpc-manage.cmd stop` | 停止 |
| `frpc-manage.cmd restart` | 重启 |
| `frpc-manage.cmd status` | 查看运行状态 |
| `frpc-manage.cmd autostart` | 仅设置开机自启 |
| `frpc-manage.cmd uninstall` | 卸载：停止 + 删除自启 |

> `install` / `uninstall` / `autostart` 需要**管理员权限**（要写任务计划程序）。
> 脚本会自动检测并弹出 UAC 提权窗口，点「是」即可；若被系统策略拦截，
> 请右键 `frpc-manage.cmd` → 以管理员身份运行。

### 心跳与在线状态

安装包里的脚本会在启动 frpc 前设置两个环境变量：

```bat
set "FRP_CONSOLE_PANEL_URL=http://<面板地址>:37000"
set "FRP_CONSOLE_INSTALL_TOKEN=<该节点的安装 token>"
```

frpc 据此每 30 秒向面板上报状态，面板「节点管理」即可显示**在线**、
主机名、版本、运行时长与代理状态。若显示离线：

1. 确认 `frpc.log` 里有 `[console] heartbeat enabled`
2. 确认节点能访问面板地址（防火墙 / 安全组需放行面板端口）

> 交互式启动与开机自启两条路径都注入了这两个变量。
> 开机自启走 `frpc-start.cmd`（计划任务直接调用），它自带环境变量 —— 
> 计划任务由系统启动，拿不到管理脚本里 `set` 的变量。

### 包内容

```
frp-console-frpc-<id>/
  frpc.exe          定制版 Windows 二进制（含心跳上报与 diag 诊断）
  frpc.toml         该节点配置（UTF-8）
  frpc-manage.cmd   交互式管理菜单（GBK 编码）
  frpc-start.cmd    启动器，供开机自启的计划任务调用
  frpc-task.xml     开机自启的计划任务定义（UTF-16LE）
  README.txt        中文使用说明（UTF-8 BOM，记事本友好）
```

> **编码说明**：`.cmd` 用 **GBK** 编码。cmd.exe 按控制台代码页逐字节解析批处理
> 文件，若用 UTF-8，中文字节会被当成 GBK 双字节字符并吞掉行尾 CR，导致命令粘连
> 报错（如 `'[7]' is not recognized`）。GBK 的次字节不可能是 0x0D，因此不会
> 破坏行结构。`frpc.toml` 由 Go 程序读取，必须保持 UTF-8。

### 构建 Windows 二进制

面板分发 Windows 包前需要有 `frpc.exe`：

```bash
./custom-frp/build-custom-frp.sh --arches windows/amd64
```

产物在 `custom-frp/dist/frp_<版本>_windows_amd64/frpc.exe`。
若未构建，面板会提示「未找到 Windows 版 frpc.exe」而不是给出坏包。

> Windows 包用内置 ZIP 打包器生成（`src/zip.ts`，零依赖），
> 不依赖宿主机的 `zip` 命令。文件名保持 ASCII，避免部分解压工具下中文乱码。

## 二进制直链托管

把 frp 安装包托管到 **OpenList / 对象存储 / CDN**，节点安装时优先从直链下载，
减轻面板带宽压力。

**配置**：面板「frps 设置 → 二进制直链托管」→ 逐个填入完整直链。

### 每个文件独立直链

托管平台通常给**每个文件一个带签名的直链**，所以这里按文件逐一配置：

| 文件 | 直链 |
| --- | --- |
| `frp_0.71.0_linux_amd64.tar.gz` | `http://your-host:23613/d/frp/frp_0.71.0_linux_amd64.tar.gz?sign=<你的签名>:0` |
| `frp_0.71.0_linux_arm64.tar.gz` | `http://host:23613/d/115/frp/frp_0.71.0_linux_arm64.tar.gz?sign=另一个签名:0` |

> 签名参数请**完整粘贴**。OpenList 的 `?sign=xxx:0` 中 `:0` 表示永不过期；
> 若是限时链接，过期后会自动回退到面板分发。

点「**填入本机全部架构**」可一键列出 6 个文件名，逐个粘贴即可。

### 下载优先级

```
专属直链（OpenList） → 节点自建镜像 → 面板内置分发
```

**失败自动回退**：直链因签名过期 / 存储故障 / 404 失效时，自动尝试下一个来源，
新节点安装不会中断。日志会隐藏签名值：

```
[frpc] 下载 http://host:23613/d/115/frp/frp_0.71.0_linux_amd64.tar.gz
curl: (22) The requested URL returned error: 403
[frpc] 该地址不可用，尝试下一个来源
[frpc] 下载 http://面板地址:37000/custom-frp/frp_0.71.0_linux_amd64.tar.gz
```

### 安全说明

- 只接受面板实际分发的资产名（`frp_<版本>_linux_<架构>.tar.gz`），
  拒绝路径穿越等非法键名
- 只接受 `http://` / `https://` 绝对 URL
- 直链由节点直接访问，请确保节点网络能到达托管地址

## 定制版 frps

选择定制版后，「总览 → 生成配置并重启 frps」会优先使用本地构建的定制 frps
（`custom-frp/out/frps`），从而获得 **审计日志** 与 **流量配额**：

```bash
FRP_CONSOLE_AUDIT_LOG=/var/log/frps-audit.log
FRP_CONSOLE_QUOTA="web=1GB,ssh=500MB,*=10GB"
```

也可通过 systemd 为 frps 注入这些变量：

```bash
systemctl edit frps
# [Service]
# Environment=FRP_CONSOLE_AUDIT_LOG=/var/log/frps-audit.log
# Environment=FRP_CONSOLE_QUOTA=web=1GB
```

若定制 frps 不存在，面板会**回退为官方版下载**并在部署结果里给出警告。

## GitHub 代理 / 镜像

服务器直连 GitHub 常常很慢或不通。面板支持**前缀式代理**：

```
代理:  https://raw.xiaoy.de
最终:  https://raw.xiaoy.de/https://github.com/fatedier/frp/releases/download/v0.71.0/...
```

在「frps 设置 → GitHub 代理 / 镜像」里填写即可，覆盖以下场景：

| 场景 | 是否走代理 |
|---|---|
| 面板下载 frps 二进制 | ✅ |
| 生成的一键安装脚本在节点上下载 frpc | ✅（也可用 `--gh-proxy` 临时指定） |
| 定制构建下载 frp 源码 | ✅ |
| 定制构建拉 Go 模块 | ✅（走 GOPROXY） |
| Go 工具链下载 | ✅（走独立下载源） |

### 重要：GitHub API 默认不走代理

实测多数前缀代理**不支持 `api.github.com`（返回 403）**，但下载文件正常。
因此「最新版本检测」默认仍走直连，只把**文件下载**走代理——避免因 API 不通而误判。
如果你的代理确实支持 API，可勾选「该代理同时支持 api.github.com」。

### 优先级

```
节点级「自建镜像 base」  >  面板级 GitHub 前缀代理  >  直连 GitHub
```

节点只需下载单个文件的场景，用自建镜像更省事：把打包好的 frp 压缩包放到静态服务上，
节点配置里填 base URL 即可（路径格式 `<base>/v<版本>/<文件名>`）。

### 连通性自检

设置页有「测试代理连通性」按钮（对应 `POST /api/mirrors/test`），会实际发请求验证：

```json
{
  "proxy": "https://raw.xiaoy.de",
  "downloadUrl": "https://raw.xiaoy.de/https://github.com/...",
  "download": { "ok": true, "status": 200, "detail": "200 · 13.3 MB" },
  "api": { "ok": false, "status": 403, "detail": "403 Forbidden" }
}
```

### 定制构建时的环境变量

命令行构建同样支持（也可由面板自动透传）：

```bash
GITHUB_PROXY=https://raw.xiaoy.de \
GOPROXY=https://goproxy.cn,direct \
GO_DOWNLOAD_BASE=https://golang.google.cn/dl \
./custom-frp/build-custom-frp.sh
```

## 安全说明

- 默认账号 `admin` / `changeme` 已内置，**部署到公网前请务必用 `FRP_CONSOLE_PASSWORD` 改掉密码**，否则任何人都能登录面板。
- 一键安装 URL 中的 token 等价于该节点的密钥，**请勿公开**；泄露后在面板点「重置安装 token」即可吊销。
- 面板与 frps Dashboard 都建议只在内网或加反代鉴权后暴露。
- 若面板经 HTTPS 反代访问，设置 `FRP_CONSOLE_COOKIE_SECURE=1`。
- `frps.toml` 权限由系统默认（root 写 `/etc/frp`），密钥不会出现在前端以外的日志中。

## 运维注意

### 数据目录
面板数据（SQLite、frp 二进制）位于 `$FRP_CONSOLE_HOME/data`（默认当前目录）。
**不要放在 `/tmp`** —— 重启会被清空，导致设置、节点、登录会话全部丢失。
建议显式指定：

```bash
FRP_CONSOLE_HOME=/opt/frp-console node dist/index.js
```

### 重装 / 更新节点（覆盖安装）

一键安装脚本是**幂等**的，重复执行即为「覆盖更新」：

- 已安装同版本 frpc → 跳过下载（`--version` 可强制换版本）
- 覆盖前把旧配置备份为 `frpc.toml.bak`，失败时可回滚
- 重置过安装 token 也不怕：脚本会**自动清理同一节点的旧 systemd 服务**
  （服务名含 token，token 变了名字就变，旧服务会抢同一份配置）
- 输出会区分「安装完成」与「更新完成（覆盖安装）」

```bash
# 重装/更新（覆盖）
curl -fsSL http://<面板>/api/install/<token>.sh | sudo bash

# 只刷新配置，不重装二进制
curl -fsSL http://<面板>/api/install/<token>.sh | sudo bash -s -- --refresh

# 完全卸载（含配置与备份）
curl -fsSL http://<面板>/api/install/<token>.sh | sudo bash -s -- --uninstall
```

> 注意：覆盖安装会以**面板中的节点配置为准**。如果本机 frpc 曾手工改过
> `serverAddr`（例如 NAT 回环场景需要写 `127.0.0.1`），重装会覆盖回面板值。

### 改 frps 端口或密钥之后
`auth.token` 与 `bindPort` 变更后，**已安装的 frpc 需要拿到新配置**。两种方式：

1. 面板里节点保持 `authToken` / `serverPort` **留空**（继承），然后重新执行一次安装脚本的刷新：
   ```bash
   curl -fsSL http://<面板>/api/install/<token>.sh | sudo bash -s -- --refresh
   ```
2. 或者重新执行完整安装脚本（幂等，会重下配置并重启服务）。

### 二进制更新（不再 ETXTBSY）
面板升级 frps 二进制时采用「写临时文件 + `rename`」原子替换，不会覆盖正在运行的可执行文件，
因此**服务运行中也能安全更新**。默认 systemd unit 直接指向版本化二进制（`frps-0.71.0`），
只有当显式设置 `FRP_CONSOLE_FRPS_BIN` 时才会额外拷贝到该路径。

## 目录结构

```
src/
  config.ts        路径/环境变量/面板账号
  auth.ts          登录会话（SQLite 持久化）与 HTTP Basic 鉴权
  db.ts            SQLite schema 与查询封装
  store.ts         设置、节点、代理、端口分配与保留
  ports.ts         端口范围归一化与随机分配
  render.ts        生成 frps.toml / frpc.toml / systemd unit
  installer.ts     一键安装脚本生成器
  frp.ts           frp 二进制下载与版本探测
  frps-service.ts  frps 服务部署与控制
  server.ts        Fastify API
  cli.ts           命令行工具
  index.ts         入口
  heartbeat.ts     节点心跳接收与在线状态
  custom-build.ts  定制构建驱动（调用 custom-frp/）
public/            前端（原生 JS，无构建步骤）
custom-frp/        定制化 frp 构建（源码补丁 + 一键脚本）
scripts/           测试与验证脚本
```

## 定制化 frp

项目支持从源码构建**定制版 frps/frpc**，已实测通过：

| 定制 | 说明 |
|---|---|
| `frpc diag` | 一键诊断 frps 连通性、本地服务、代理状态（退出码可用于监控） |
| frpc 心跳上报 | 节点主动上报状态，面板实时显示在线情况，无需 SSH |
| frps 审计日志 | JSON 行格式记录客户端/代理/连接事件 |
| frps 流量配额 | 按代理限额，超限拒绝新建并记录审计事件 |

```bash
./custom-frp/build-custom-frp.sh          # 命令行构建
# 或在面板「定制构建」页一键构建
```

详见 [`custom-frp/README.md`](custom-frp/README.md)。
