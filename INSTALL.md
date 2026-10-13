# frp-console 安装说明

版本：@VERSION@
打包时间：@BUILD_TIME@

本包已包含 **6 个架构的定制版 frp 二进制**，节点安装无需 Go 工具链、无需访问 GitHub。

---

## 方式一：Docker（推荐）

```bash
# 1) 配置（务必修改密码与公网地址）
cat > .env <<'ENVEOF'
PANEL_PASSWORD=你的强密码
PUBLIC_URL=http://你的公网IP:37000
ENVEOF

# 2) 构建并启动
docker compose up -d --build

# 3) 查看状态
docker compose ps
docker compose logs -f frp-console
```

浏览器打开 `http://<服务器IP>:37000`，用 `admin` / 你设置的密码登录。

> `PUBLIC_URL` 必须填写节点能访问到的地址。留空会探测到容器内网 IP，
> 外部节点将无法回连（心跳与配置刷新会失败）。

### 国内网络构建（重要）

构建镜像需要联网拉取基础镜像、npm 依赖与 apk 包。若目标机访问国际网络较慢，
在 `.env` 中加入以下配置后重新构建即可（无需改 Dockerfile）：

```bash
cat >> .env <<'ENVEOF'
NPM_REGISTRY=https://registry.npmmirror.com
APK_MIRROR=mirrors.aliyun.com
# 基础镜像也可指向国内镜像仓库
BASE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
ENVEOF

docker compose build --no-cache
docker compose up -d
```

若要完全离线构建，可在有网机器上 `docker save` 镜像后传输：

```bash
# 有网机器
docker compose build
docker save frp-console:latest | gzip > frp-console-image.tar.gz

# 目标机
gunzip -c frp-console-image.tar.gz | docker load
docker compose up -d          # 已加载镜像时无需 --build
```

---

## 方式二：直接运行（裸机 / VM）

```bash
# 1) 安装依赖并编译
npm install
npm run build

# 2) 启动（建议用 systemd 托管，见 README）
FRP_CONSOLE_PASSWORD='你的强密码' \
FRP_CONSOLE_PUBLIC_URL='http://你的公网IP:37000' \
FRP_CONSOLE_HOME=/opt/frp-console \
node --disable-warning=ExperimentalWarning dist/index.js
```

浏览器打开 `http://<服务器IP>:37000`。

---

## 首次使用流程

1. **frps 设置** —— 填写控制端口与密钥，保存
2. **端口范围** —— 添加允许客户端使用的区间（如 `20000-30000`）
3. **总览 → 生成配置并重启 frps** —— 应用配置
4. **节点管理 → 新建节点** —— 填写 frps 公网地址
5. 节点详情 → **添加代理** —— 配置需要穿透的服务
6. **一键安装脚本** —— 复制命令到目标机器执行：
   ```bash
   curl -fsSL http://<面板地址>/api/install/<token>.sh | sudo bash
   ```

---

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | >= 22.5（需内置 `node:sqlite`，无原生编译依赖） |
| Docker | 20.10+ / Compose v2（方式一） |
| 操作系统 | Linux（x86_64 / arm64 / arm / 386 / loong64 / riscv64） |

---

## 验证安装

```bash
# 面板健康检查
curl -s http://127.0.0.1:37000/api/health

# 查看预构建架构是否齐全
docker compose exec frp-console ls /app/custom-frp/dist/*.tar.gz

# frps 状态（容器内）
docker compose exec frp-console supervisorctl status
```

---

## 排查

| 现象 | 原因与处理 |
| --- | --- |
| 面板地址显示内网 IP | 未设置 `PUBLIC_URL`，在「frps 设置 → 面板公网地址」填写 |
| 节点安装提示无 systemd | 正常，已自动回退为 nohup 后台进程（无开机自启） |
| 节点连不上 frps | 检查防火墙是否放行 frps 控制端口 |
| 面板 37000 被占用 | 改 `PANEL_PORT` 环境变量 |
| 节点提示端口不允许 | 目标端口不在 frps 的 `allowPorts` 范围内 |

完整文档见 `README.md`。
