# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.1.1] — 2026-09-28

### 🐞 严重修复：长连接每隔固定时间被断开

**现象**：通过 frp 穿透的 SSH（以及任何长连接）每隔约 90 秒断开一次，
frpc 自动重连后又断，无限循环。换成原版 frps/frpc 则正常。

**根因**：面板在生成 `frps.toml` 时显式写入了一行

```toml
transport.heartbeatTimeout = 90
```

而 frp 的设计是——当 `tcpMux` 启用（默认）时，**两侧都关闭应用层心跳**，
改用 tcpMux 自带的保活机制：

```go
// frp 源码：ServerTransportConfig.Complete()
if tcpMux 启用 {
    HeartbeatTimeout = -1   // 禁用
} else {
    HeartbeatTimeout = 90
}
// frp 源码：ClientTransportConfig.Complete()
if tcpMux 启用 {
    HeartbeatInterval = -1  // 客户端根本不发心跳
}
```

面板写死的 `90` 使 `EmptyOr` 默认值失效，于是：

| 侧 | 实际行为 |
| --- | --- |
| frpc | `HeartbeatInterval = -1`，**不发送**应用层心跳 |
| frps | 等待心跳，**90 秒后超时** |

frps 超时后关闭控制连接；由于 tcpMux 将所有用户连接复用在控制连接上，
**所有隧道瞬间中断**。frps 日志中的关键证据：

```
[W] [server/control.go:647] heartbeat timeout
[I] [proxy/proxy.go:139] [ssh-test] proxy closing
[I] [server/control.go:721] client exit success
[I] [server/service.go:803] client login info      ← frpc 重连
```

**修复**：`tcpMux` 启用时不再写入 `heartbeatTimeout`，交回 frp 自行决定默认值。
仅当 `tcpMux` 关闭时才写入该配置（此时两侧都会启用应用层心跳）。

**同时修复**：`frpc.toml` 此前从不声明 `transport.tcpMux`（永远走默认 `true`），
若用户在面板关闭 frps 的 tcpMux，两侧配置会不一致。现在会同步下发。

**影响范围**：所有长连接场景 —— SSH、数据库连接、WebSocket、长轮询等。
老版本部署的用户建议立即升级。

**新增回归测试**：
- `tcpMux` 开启时不得出现 `heartbeatTimeout`
- `tcpMux` 关闭时才写入 `heartbeatTimeout`
- `frpc.toml` 与 `frps.toml` 的 `tcpMux` 必须一致

---

## [0.4.0] — 2026-09-30

### ✨ 新增：frps 对外地址 + 节点自动继承

**背景**：新建节点时「frps 地址」是必填项，于是每建一个节点都要重复填一遍
同样的公网地址；而「frps 设置」里当时也没有这个字段。

**新增配置**：面板「frps 设置 → 监听与密钥」下新增：

```
frps 地址（对外公布）  [ 203.0.113.10 ]  [用当前访问地址填入]
```

**继承规则**：

| 节点「frps 地址」 | 实际使用 |
| --- | --- |
| 留空 | 继承 frps 设置里的地址 |
| 填写 | 用节点自己的（覆盖继承） |
| 留空且设置也为空 | 生成配置时提示 `请填写 frps 公网地址` |

只需在设置里维护一处，**改一次全局生效**——之后新建的节点不用再填，
已建节点（留空的）也会自动跟着变，无需逐个重装。

**输入宽容**：直接粘贴完整 URL 也能识别，会自动剥掉协议、端口与路径：

| 输入 | 存为 |
| --- | --- |
| `https://frp.example.com:37001/some/path` | `frp.example.com` |
| `http://1.2.3.4:37001` | `1.2.3.4` |
| `[2001:db8::1]:37001` | `[2001:db8::1]` |

非法内容会被拒绝（空格、`|`、`;` 等字符，以及 `a..b` 这类畸形域名）。

**界面改进**：

- 节点表单里「frps 地址」不再是必填，并直接显示**当前继承值**
- 节点列表与详情显示**生效地址**，继承来的会标注「继承」徽标
- CLI `node list` 同样标注 `(继承)`
- 「用当前访问地址填入」按钮自动只取主机名（不含端口）

**新增 7 项回归测试**：读写、URL 规范化、非法内容拒绝、留空继承、
自填优先、双空提示、修改后同步生效。

---

## [0.3.2] — 2026-09-30

### 🐞 修复：直链保存后刷新即丢失 + 安装脚本不命中直链

**根因：前端保存时根本没提交 `assetMirrors`**

`collectSettings()` 负责把表单收集成 PUT 请求体，但它在构造对象时**漏掉了
`assetMirrors` 字段**——设置页能正常显示、能回显，但点保存时这个字段不在
请求体里，后端自然无从保存。刷新后自然就没了。

同时因为没保存成功，生成的安装脚本里也不含直链，于是「不命中直链」。

修复：把 `assetMirrors: collectMirrorRows()` 加进 `collectSettings()`。

**为什么上一版没发现**：0.3.1 我用 curl 直接 PUT JSON 验证后端，
绕过前端表单收集逻辑，所以后端一切正常、前端却漏字段。

### ✅ 本次实测（真实浏览器 + 真实直链）

| 步骤 | 结果 |
| --- | --- |
| 点「填入本机全部架构」 | 生成 6 行 |
| 给 amd64 填入真实直链 | — |
| 点保存 | PUT 请求体**包含** `assetMirrors` |
| 硬刷新页面 | **直链仍保留** |
| 执行安装脚本 | **命中直链**：从 OpenList 下载成功 |

### 🧪 新增回归测试

- `collectSettings()` 必须包含 `assetMirrors: collectMirrorRows()`
- 加载设置时必须回显已保存的直链
- 首页必须给 `app.js` / `style.css` 打版本戳，并使用 `onSend` 设置缓存头

---

## [0.3.1] — 2026-09-30

### 🐞 修复 0.3.0 直链托管的两个严重问题

**1. 安装脚本静默退出，未配置直链的架构完全装不上**

脚本开头是 `set -euo pipefail`，而候选下载地址是用这种写法构建的：

```bash
[[ -n "$ASSET_MIRROR" ]] && CANDIDATES+=("$ASSET_MIRROR")
```

当 `ASSET_MIRROR` 为空（**绝大多数节点**——只为 amd64 配了直链，arm64 等架构
就没值）时，`[[ ]]` 返回非 0，`set -e` 立即**终止整个脚本且无任何报错**。

现象：脚本跑几步就“直接结束”，没有下载、没有回退、没有错误提示。

修复：3 处改为 `if [[ ... ]]; then ...; fi` 形式，条件不成立也不再返回非 0。

同类陷阱还排查出 **3 处历史遗留**（非本次引入），一并修复：
- 清理旧 unit 时 `[[ "$unit_name" == "$SERVICE_NAME" ]] && continue`
- 安装失败时 `[[ -f frpc.toml.bak ]] && warn ...`（导致失败原因被吞掉）
- 覆盖安装时 `[[ -f frpc.toml.bak ]] && log ...`

新增回归测试：扫描生成的脚本，禁止出现 `[[ ... ]] && cmd`
（`|| die` / `|| continue` / `|| true` 这类「失败即终止或跳过」的安全写法除外）。

**2. 升级后「设置无法保存」**

`app.js` / `style.css` 的引用没有版本参数，也没有缓存控制头。
面板升级后浏览器继续使用**缓存的旧脚本**，而页面是新版——旧脚本里不存在
新函数（如直链相关逻辑），执行到保存就直接报错。

修复：
- 首页渲染时把引用改写为带版本戳的 URL：`/app.js?v=<版本>`
- 版本变化 → URL 变化 → 浏览器必然重新拉取
- 静态资源改用 immutable 长缓存，首页 `no-cache`
  （`@fastify/static` 的 `setHeaders` 会被底层覆盖，实测无效，改用 `onSend` 钩子）

修复后缓存头实测：

```
/                → no-cache, must-revalidate
/app.js?v=0.3.1  → public, max-age=31536000, immutable
/style.css?v=... → public, max-age=31536000, immutable
```

### ✅ 实测验证（使用真实 OpenList 直链）

| 场景 | 结果 |
| --- | --- |
| 直链有效 | 从托管地址下载并安装成功 |
| 未配置该架构直链 | 正确回退到面板（修复前会静默退出） |
| 直链不可达 | 自动回退到面板，安装成功 |
| 直链返回 403 | 自动回退到面板 |

---

## [0.3.0] — 2026-09-30

### ✨ 新增：二进制直链托管（OpenList / 对象存储 / CDN）

把 frp 安装包托管到外部存储，节点安装时优先从直链下载，减轻面板带宽压力，
并可利用对象存储的 CDN 加速。

**配置位置**：面板「frps 设置 → 二进制直链托管」

- 每个资产可填**各自独立的完整直链**，签名参数原样保留
  （如 OpenList 的 `?sign=xxx:0`，`:0` 表示永不过期）
- 示例：
  ```
  frp_0.71.0_linux_amd64.tar.gz →
    http://your-host:23613/d/frp/frp_0.71.0_linux_amd64.tar.gz?sign=<你的签名>:0
  ```
- 支持 6 个 Linux 架构，面板提供「填入本机全部架构」按钮快速列出文件名
- 未配置直链的资产自动走面板分发

**下载优先级（失败自动回退）**：

```
专属直链（OpenList） → 节点自建镜像 → 面板内置分发
```

直链因签名过期 / 存储故障 / 404 失效时，自动尝试下一个来源，
**新节点安装不会中断**。日志会隐藏签名值，避免泄露到终端记录。

**实现要点**：

- 映射以 JSON+base64 嵌入安装脚本：URL 含 `& ? =` 等字符，
  直接拼进 shell 变量会被解释
- 脚本在**目标节点上**按自身 CPU 架构查表 —— 生成脚本时并不知道目标机架构
- 优先用 `python3` 解析 JSON，无 python3 时退回 `grep` 提取
- 整表新增 `settings.asset_mirrors` 字段（JSON），随设置持久化

**安全校验**：

- 只接受面板会分发的资产名（`frp_<版本>_linux_<架构>.tar.gz`），
  拒绝路径穿越等非法键
- 只接受 `http://` / `https://` 绝对 URL，拒绝 `file://` 等协议

**新增 5 项回归测试**：映射读写、非法资产名拒绝、非法协议拒绝、
脚本嵌入与回退结构、未配置时不产生直链。

---

## [0.2.1] — 2026-09-30

### 🐞 修复 Windows 安装包的三个严重问题

0.2.0 的 Windows 支持存在三个缺陷，导致安装包实际不可用。

**1. `.cmd` 编码错误 —— 菜单报「'[7]' is not recognized」**

脚本以 UTF-8 写出，但 cmd.exe 按控制台代码页（中文 Windows 为 936/GBK）
逐字节解析批处理文件。中文的 UTF-8 字节都 ≥ 0x80，会被当成 GBK 双字节字符，
而 GBK 次字节范围是 0x40-0xFE —— 行尾的 CR(0x0D) 可能被吞掉，导致该行与
下一行粘连，于是出现：

```
'[7]' is not recognized as an internal or external command
```

修复：`.cmd` 一律以 **GBK 编码**输出（GBK 次字节不可能是 0x0D/0x0A，
天然不破坏行结构），并改用 `chcp 936`。同时把 `chcp` 提到任何非 ASCII 输出
之前，避免英文系统上先乱码。

**2. 未注入心跳环境变量 —— 面板一直显示「离线」**

Linux 版靠 systemd 的 `Environment=` 注入 `FRP_CONSOLE_PANEL_URL` 与
`FRP_CONSOLE_INSTALL_TOKEN`；Windows 版漏了这两步，而 frpc 的心跳上报在
两个变量都为空时是 no-op，因此 frpc 虽然连上了 frps，面板却始终显示离线。

修复：管理脚本与启动器都在启动 frpc 前 `set` 这两个变量（含 30 秒上报间隔）。
新增 `frpc-start.cmd` 专供计划任务调用 —— 计划任务由系统启动，拿不到管理
脚本里设置的变量，必须自带环境。

**3. 开机自启无法设置**

原实现用 `schtasks /TR "..."`，并把错误输出丢弃了：
- 路径含空格时命令行引号转义极易出错
- `RunLevel=HighestAvailable` 需要管理员权限，双击运行时静默失败
- `>nul 2>&1` 把失败原因也吞掉了，用户看不到任何提示

修复：
- 改用 **XML 定义**计划任务（`frpc-task.xml`，UTF-16LE + BOM），
  命令与参数分列独立元素，彻底回避引号问题
- 通过 `S-1-16-12288`（高完整性级别，与系统语言无关）检测管理员权限，
  未提权时用 PowerShell `-Verb RunAs` 自动弹出 UAC
- 不再吞掉 `schtasks` 的错误输出，失败时明确提示原因
- 启动器路径在注册前用 PowerShell 替换占位符（解压前路径未知）

### 🔧 其他改进

- 取 PID 改用 PowerShell `Start-Process -PassThru`，直接得到精确 PID
  （原 `wmic` 方案在较新 Windows 上已被移除，`tasklist` 会匹配到其他实例）
- `frpc.toml` 保持 UTF-8（Go 程序读取），`README.txt` 加 UTF-8 BOM
  （记事本友好），三类文件按用途分别编码
- 新增 6 项 Windows 回归测试：GBK 编码正确性、CR/LF 配对、chcp 时序、
  心跳变量注入、XML 任务定义、自动提权

---

## [0.2.0] — 2026-09-30

### ✨ 新增：Windows 节点支持

Windows 没有 systemd，也通常没有 bash，因此不使用 Linux 的一键安装脚本，
改为**下载 zip 包解压使用**。

- 面板节点详情新增「Windows 包」按钮，下载
  `frp-console-frpc-<id>-windows-amd64.zip`
- 包内含：定制版 `frpc.exe`（含心跳上报与 `diag` 诊断）、`frpc.toml`、
  `frpc-manage.cmd` 管理脚本、中文 `README.txt`
- 管理脚本**交互式菜单**：双击 `frpc-manage.cmd` 后按 `1`-`7` 选择
  （安装 / 启动 / 停止 / 重启 / 状态 / 开机自启 / 卸载），操作后可回车返回菜单
- 同时保留命令行参数模式（`frpc-manage.cmd install` 等），便于脚本调用
- 管理脚本**按节点独立生成**：每个节点的 zip 内含自己的 `frpc.toml` 与
  独立的任务名（`frp-console-frpc-<id>`），同一台 Windows 可装多个节点互不冲突
- `frpc.exe` 在所有节点间共享同一份二进制（下载时实时打包，不做预打包）
- 开机自启通过**任务计划程序**（登录时触发，最高权限）实现；
  停止用 `taskkill`，PID 优先用 `wmic` 精确匹配（避免误杀其他 frpc 实例）
- 构建脚本支持 `--arches windows/amd64`（目标形如 `<os>/<arch>`）
- Windows 包用内置 ZIP 打包器（`src/zip.ts`，零依赖）生成，
  不依赖宿主机 `zip` 命令；文件名保持 ASCII，避免部分解压工具中文乱码
- 新增端点：
  - `GET /api/nodes/:id/windows-package`（需登录）
  - `GET /api/install/:token/windows`（免鉴权，token 即凭证）
  - `GET /api/nodes/:id/windows-status`（是否已构建 exe）

### 🐞 修复

- **CMD 陷阱**：`:install` / `:restart` / `:uninstall` 原先用 `call :stop`，
  而 CMD 中 `call` 进的子程序若内部执行 `goto` 会直接跳走，导致后续语句
  （启动 frpc、设置自启、删除计划任务）被静默跳过。已改为内联停止逻辑，
  并加回归测试锁死。
- 配置日志注释原先写死 `journalctl`（Linux 专有），已改为平台无关表述
- Windows 脚本统一 CRLF 换行，并 `chcp 65001` 切 UTF-8 代码页
- Windows 包内文件名改为 ASCII（`README.txt`），避免部分解压工具中文乱码
- PID 识别优先用 `wmic` 按命令行精确匹配，避免误杀其他 frpc 实例
- Windows `frpc.exe` 原先未被打包脚本收录，已修复

### 🐳 Docker

- 版本标签不再默认 `unknown`：改由构建参数传入，留空即为空（不误导）；
  运行时权威版本仍以 `/app/VERSION` 与 `/api/health` 为准
- 镜像内含 Windows `frpc.exe`，容器可直接分发 Windows 安装包

---

## [0.1.0] — 2026-09-25

首个版本。

### 功能

- **frps 管理**：Web 界面配置控制端口、连接密钥、端口范围、虚拟主机、
  Dashboard、TLS、日志等；一键生成 `frps.toml` + 服务定义并重启
- **服务管理抽象**：自动识别 systemd / supervisord / 仅生成配置三种后端，
  同一套面板同时适配裸机与容器
- **端口池**：从 `allowPorts` 范围分配端口，自动排除 frps 自身监听端口，
  支持自定义端口、随机分配、手动保留、范围收缩后自动重算
- **节点管理**：每个节点独立安装 token，生成一键安装脚本（systemd 守护，
  无 systemd 时回退 nohup）
- **多 `[[proxies]]` 支持**：tcp / udp / http / https / tcpmux / stcp / xtcp / sudp，
  填写时实时预览将写入的 TOML
- **定制版 frp**：面板只分发自建定制版（官方版 + `frpc diag` 诊断 +
  心跳上报 + frps 审计日志 + 流量配额），预构建 6 个架构随包分发，
  节点部署无需 Go 工具链与 GitHub
- **节点心跳**：节点主动上报状态，面板显示在线/离线、主机名、版本、
  运行时长、代理运行数与内存占用
- **密钥/端口继承**：节点未显式覆盖时自动跟随 frps 当前配置
- **覆盖更新**：安装脚本幂等，自动清理同节点旧服务、备份旧配置
- **GitHub 代理/镜像**：支持前缀代理与自建镜像
- **Docker 部署**：多阶段构建、host 网络模式、支持国内镜像源构建

### 默认端口

| 端口 | 用途 |
| --- | --- |
| 37000 | 面板 Web 界面 |
| 37001 | frps 控制端口 |
| 37002 | frps 内置 Dashboard |
| 37010-37099 | 客户端端口范围（可配置） |
