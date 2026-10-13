# 定制化 frps / frpc

本文档记录**从源码构建定制版 frp** 的完整方法，并已在本机实测通过
（Debian 13 / x86_64 / Go 1.27.1 / frp v0.71.0）。

## 结论先说

| 问题 | 答案 |
|---|---|
| 能否从源码构建 | ✅ 能，已实测构建出 frps(20M) / frpc(17M) |
| 能否加自定义功能 | ✅ 能，已实测新增 `frpc diag` 子命令并运行成功 |
| 构建耗时 | 首次约 1 分钟（含拉依赖），增量约 5 秒 |
| 磁盘占用 | Go 工具链约 250M + 源码约 100M |
| 能否保持上游升级 | ✅ 用补丁方式，`git pull` 上游后重新应用即可 |

## 服务器访问 GitHub 不畅

构建需要下载 frp 源码、Go 工具链和 Go 依赖。可用前缀代理与国内镜像：

```bash
GITHUB_PROXY=https://raw.xiaoy.de \
GOPROXY=https://goproxy.cn,direct \
GO_DOWNLOAD_BASE=https://golang.google.cn/dl \
./custom-frp/build-custom-frp.sh
```

| 变量 | 作用 | 示例 |
|---|---|---|
| `GITHUB_PROXY` | 前缀代理，拼成 `<proxy>/<原 GitHub URL>` | `https://raw.xiaoy.de` |
| `GOPROXY` | Go 模块代理链 | `https://goproxy.cn,direct` |
| `GO_DOWNLOAD_BASE` | Go 工具链下载源 | `https://golang.google.cn/dl` |
| `FRP_SOURCE_BASE` | 直接指定 frp 源码包 URL（跳过拼接） | `https://my.mirror/frp.tar.gz` |

在面板「定制构建」页触发时，这些值会自动取自面板设置（frps 设置 → GitHub 代理 / 镜像）。

> 实测注意：前缀代理通常**只支持文件下载**，对 `api.github.com` 返回 403。
> 因此源码包下载走代理没问题，但版本检测 API 不走代理。

## 快速开始

```bash
# 一键构建（自动装 Go、拉源码、应用补丁、编译）
cd /root/dsh/frp
./custom-frp/build-custom-frp.sh

# 产物
ls -lh custom-frp/out/{frps,frpc}

# 验证定制命令
./custom-frp/out/frpc diag --help
```

其他用法：

```bash
./custom-frp/build-custom-frp.sh --with-web     # 同时构建内置 Dashboard（需 npm）
./custom-frp/build-custom-frp.sh --version 0.72.0
./custom-frp/build-custom-frp.sh --clean
```

## ⚠️ 关键坑：`noweb` 构建标签

frp 的 Web Dashboard 前端是用 `go:embed` **编译进二进制**的：

```go
// web/frps/embed.go
//go:build !noweb
//go:embed dist
var EmbedFS embed.FS
```

GitHub 的源码 tarball **不含 `web/*/dist`**，所以直接 `go build` 会失败：

```
web/frps/embed.go:11:12: pattern dist: no matching files found
```

两种解法（脚本已自动处理）：

| 方式 | 命令 | 结果 |
|---|---|---|
| 不要内置 Dashboard | `-tags "frps,noweb"` | 二进制不含 frps Dashboard（推荐，面板已提供同类功能） |
| 要内置 Dashboard | 先 `cd web && npm ci && npm run build --workspace frps` | 需 Node.js，构建更慢 |

另外 frps/frpc 需要各自的 tag（`frps` / `frpc`），官方 Makefile 也是这样做的。

## 已实现的定制（全部实测通过）

| # | 定制 | 位置 | 效果 |
|---|---|---|---|
| 0 | 内置 Dashboard | frps/frpc | `--with-web` 编译，含完整网页（默认自动检测 web/*/dist） |
| 1 | `frpc diag` 诊断 | frpc | 一键检查 frps 连通性、本地服务、代理状态，退出码可脚本化 |
| 2 | frpc 心跳上报 | frpc | 定时把主机名/版本/代理状态/负载推给面板，**无需 SSH 即可看节点在线** |
| 3 | frps 审计日志 | frps | JSON 行格式记录 client/proxy/连接事件，可入库分析 |
| 4 | frps 流量配额 | frps | 按代理限制流量，超限**拒绝新建代理**并记录 `quota_rejected` |

实测联合验证（定制 frps + 定制 frpc）：

```
1) 穿透可用       REAL-TUNNEL-OK:/probe
2) 审计日志       client_online clients=1
                  proxy_created full-test
3) 心跳上报       online: True | 代理: [('full-test','running')]
4) frpc diag      结果: 全部正常
```

### frps 审计日志

由环境变量启用（无需改配置文件）：

```bash
FRP_CONSOLE_AUDIT_LOG=/var/log/frps-audit.log   # 留空或 console 则输出到标准输出
FRP_CONSOLE_QUOTA="web=1GB,ssh=500MB,*=10GB"    # 按代理配额，*=默认
```

输出为 JSON 行，便于采集：

```json
{"time":"2026-09-25T05:49:08Z","event":"client_online","detail":"clients=1"}
{"time":"2026-09-25T05:49:08Z","event":"proxy_created","name":"full-test","type":"tcp","client_id":"5243c29e2ec5e17c"}
{"time":"2026-09-25T05:49:22Z","event":"quota_rejected","name":"quota-test","total_in":44600,"quota_bytes":1000}
```

事件类型：`client_online` / `client_offline` / `proxy_created` / `proxy_closed` / `quota_rejected`

配额超限实测（设置 `quota-test=1KB` 后灌流量）：

```
[console] proxy "quota-test" exceeded quota: used=1115 quota=1000
new proxy [quota-test] rejected by quota: traffic quota exhausted (44600/1000 bytes)
[quota-test] start error: traffic quota exhausted (44600/1000 bytes)   # frpc 侧
```

> 实现细节：frp 的 `metrics.Server` 被 `pkg/metrics/aggregate` 在自己的 `init()` 里用
> `sync.Once` 占用，直接 `Register()` 会被静默忽略；且 `NewControl` 会**快照**
> `metrics.Server`，注册晚了也无效。因此补丁改为提供 `fanoutMetrics` 包装并在
> `installConsoleAudit()` 里安装（早于 `NewService`）。

### frpc 心跳上报

由一键安装脚本自动写入 systemd unit，无需手工配置：

```ini
Environment=FRP_CONSOLE_PANEL_URL=http://<面板>:37000
Environment=FRP_CONSOLE_INSTALL_TOKEN=<节点token>
Environment=FRP_CONSOLE_HEARTBEAT_INTERVAL=30
```

面板在「节点管理」中显示 `在线/离线` 徽章，节点详情显示主机名、版本、架构、
运行时长、代理运行数、内存占用。上报失败不影响 frpc 运行。

> 对上游 frpc（无此补丁）这些环境变量是惰性的，不会造成任何影响。

## 定制方式：两层补丁机制

所有定制都在 `custom-frp/patches/`，分两类：

### 版本标识

定制版与官方版基础版本相同（`0.71.0`），若不区分，安装脚本的「同版本跳过下载」
会导致节点换不成定制版。因此构建时注入后缀，产出 `0.71.0-console`：

```bash
CONSOLE_SUFFIX=-console ./custom-frp/build-custom-frp.sh   # 可自定义
```

对应 `src/variant.ts` 的 `customVersionString()` / `baseVersionOf()`。
压缩包名仍用基础版本，保持与上游一致。

### 1) 文件投放 `patches/files/*.go`

新文件，文件头声明目标路径：

```go
// frp-console-target: cmd/frpc/sub/diag.go
```

### 2) 源码变换 `patches/transforms.json`

需要改动 frp 已有代码时使用，做**精确字符串替换**：

```json
{
  "file": "server/control.go",
  "why": "在注册代理前插入流量配额检查",
  "anchor": "	retContent, err := ...",
  "replace": "	retContent, err := ... (含配额检查)"
}
```

关键保障：

- `anchor` 必须**恰好出现一次**，否则构建**直接失败**——避免上游变动后静默产生错误代码
- 构建前从 `.frp-console-orig/` 快照还原，因此**重复构建幂等**，不会叠加变换
- 每个补丁带 `why` 说明，便于审查

这样做的价值：**不动上游代码**，frp 升级后重新应用补丁即可；每个定制独立可审查、可回滚。

### 已实现的定制：`frpc diag`

官方 frpc 只有 `reload` / `status` / `stop`，缺少「一键排障」。`diag` 会依次检查：

1. **frps 连通性**（含延迟）
2. **本地管理 API** 是否可用
3. **每个代理的本地服务端口**是否可连接
4. **每个代理的运行状态**（从 admin API 读取）

退出码 `0` = 无问题，`1` = 有问题，可直接用于脚本健康检查。

实测输出：

```
$ frpc -c frpc.toml diag
frpc 诊断报告 (client v0.71.0)
配置文件: frpc.toml

✓ frps 连通性  127.0.0.1:37000  (0ms)
✓ 本地管理 API  127.0.0.1:7401

本地服务探测:
  ✓ [ok-http] 127.0.0.1:18080
  ✗ [broken-local] 127.0.0.1:59999  -> connect: connection refused

代理状态:
  broken-local tcp  error: port not allowed
  ok-http      tcp  error: port not allowed

结果: 发现 3 个问题
  - 代理 [broken-local] 的本地服务 127.0.0.1:59999 无法连接（本地服务未启动？）
  - 代理 [broken-local] 状态异常：port not allowed
  - 代理 [ok-http] 状态异常：port not allowed
```

支持 `--json` 输出，便于面板集成：

```bash
frpc -c frpc.toml diag --json
```

## 把定制版分发给节点

面板已有 `downloadBase` 字段（节点配置里的「下载镜像 base URL」）。
安装脚本据此拼接下载地址：

```
${DOWNLOAD_BASE}/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz
```

所以只要把你的定制二进制按此结构放到自建 HTTP 服务上即可：

```bash
# 1) 打包成 frp 官方命名的压缩包
mkdir -p /srv/frp-dist/v0.71.0/pkg && cd /srv/frp-dist/v0.71.0
cp /root/dsh/frp/custom-frp/out/frps /root/dsh/frp/custom-frp/out/frpc pkg/
tar czf frp_0.71.0_linux_amd64.tar.gz pkg/   # 注意：解压后需含 frps/frpc

# 2) 起个静态服务
python3 -m http.server 8081 --directory /srv/frp-dist

# 3) 面板里把节点的「下载镜像 base URL」填成 http://<你的IP>:8081
#    然后重新生成/执行一键安装脚本
```

> 提示：`tar` 包内层目录名不限，安装脚本用 `find` 定位二进制。

## 什么时候真的需要定制

| 需求 | 是否需要改源码 |
|---|---|
| 查状态、流量、客户端列表 | ❌ 用 frps 内置 REST API（`/api/serverinfo` 等） |
| 热改代理、免重启 | ❌ 用 frpc 内置 `PUT /api/config` + `GET /api/reload`（已实测可行） |
| 登录鉴权、端口管控 | ❌ 用官方 HTTP 插件（`[[httpPlugins]]`） |
| 诊断/巡检 | ⚠️ 可用本文的 `diag` 补丁，或外部脚本调 admin API |
| 改计费/审计/流量入库 | ✅ 需要改源码或写插件 |
| 单二进制内嵌自有逻辑 | ✅ 需要改源码 |

**建议**：优先用内置 API 和 HTTP 插件；只有当要改的确实是 frp 核心行为时，才用本文的补丁方式定制。

## 目录说明

```
custom-frp/
├── build-custom-frp.sh      一键构建脚本
├── patches/                 定制补丁（按目标路径自动投放）
│   └── frpc-diag.go         frpc diag 诊断子命令
└── out/                     构建产物（frps / frpc）
```
