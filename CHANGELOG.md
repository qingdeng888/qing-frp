# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.0.1] — 2026-10-13

首个公开版本。

### 功能

- **frps 管理**：Web 界面配置控制端口、连接密钥、端口范围、虚拟主机、
  Dashboard、TLS、日志等；一键生成 `frps.toml` + 服务定义并重启
- **服务管理抽象**：自动识别 systemd / supervisord / 仅生成配置三种后端，
  同一套面板同时适配裸机与容器
- **端口池**：从 `allowPorts` 范围分配端口，自动排除 frps 自身监听端口，
  支持自定义端口、随机分配、手动保留、范围收缩后自动重算
- **节点管理**：每个节点独立安装 token，生成一键安装脚本（systemd 守护，
  无 systemd 时回退 nohup）
- **Windows 节点**：下载 zip 解压即用，交互式 `frpc-manage.cmd` 支持
  安装 / 启动 / 停止 / 重启 / 状态 / 开机自启 / 卸载
- **多 `[[proxies]]` 支持**：tcp / udp / http / https / tcpmux / stcp / xtcp / sudp，
  填写时实时预览将写入的 TOML
- **二进制直链托管**：可把安装包托管到 OpenList / 对象存储 / CDN，
  每个文件独立直链（含签名参数），失效自动回退到面板分发
- **定制版 frp**：自建 frps/frpc 含审计日志、流量配额、诊断、心跳上报，
  预构建 6 个 Linux 架构 + Windows amd64，随仓库分发，节点部署无需 Go 工具链
- **节点心跳**：节点主动上报状态，面板显示在线/离线、主机名、版本、
  运行时长、代理运行数与内存占用
- **frps 对外地址**：设置一处即可，新建节点留空自动继承
- **覆盖更新**：安装脚本幂等，自动清理同节点旧服务、备份旧配置
- **GitHub 代理 / 镜像**：支持前缀代理与自建镜像
- **Docker 部署**：多阶段构建、host 网络模式、支持国内镜像源构建

### 默认端口

| 端口 | 用途 |
| --- | --- |
| 37000 | 面板 Web 界面 |
| 37001 | frps 控制端口 |
| 37002 | frps 内置 Dashboard |
| 37010-37099 | 客户端端口范围（可配置） |

### 技术栈

Node.js 22 + TypeScript（ESM）+ Fastify 5 + `node:sqlite`（零原生依赖）。
前端为无构建步骤的原生 JavaScript。

### CI / 发布

`.github/workflows/docker-publish.yml`：推送到 `main`、打 `v*` 标签或手动触发时，
自动构建 `linux/amd64` + `linux/arm64` 多架构镜像并发布到 GitHub Container Registry。

- 镜像：`ghcr.io/qingdeng888/qing-frp`
- 标签：`latest` / 分支名 / 语义化版本 / `sha-<短哈希>`
- 构建步骤内置重试（应对拉取依赖时的网络抖动）；遇权限类错误立即中止并给出排查指引
