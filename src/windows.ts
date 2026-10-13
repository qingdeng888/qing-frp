/**
 * Windows 节点支持。
 *
 * Windows 没有 systemd，也通常没有 bash，因此不能用 Linux 那套安装脚本。
 * 面板改为生成一个 .zip 包：内含 frpc.exe、配置，以及 .cmd 管理脚本与
 * 计划任务定义，用户解压后双击运行即可完成安装 / 启动 / 停止 / 开机自启 / 卸载。
 *
 * ── 编码（关键）────────────────────────────────────────────────────────────
 * .cmd 必须以 **GBK（cp936）** 编码，而不是 UTF-8。
 * cmd.exe 按控制台代码页（中文 Windows 为 936）逐字节解析批处理文件。若文件是
 * UTF-8，中文的每个字节都在 0x80-0xFF，会被当成 GBK 双字节字符，而 GBK 的次字节
 * 范围是 0x40-0xFE —— 于是行尾的 CR(0x0D) 可能被当成次字节吞掉，导致该行与下一行
 * 粘连，出现 `'[7]' is not recognized as an internal or external command` 这类错误。
 * GBK 的次字节不可能是 0x0D/0x0A，因此 GBK 编码天然不会破坏行结构。
 *
 * ── 心跳上报 ───────────────────────────────────────────────────────────────
 * Linux 版靠 systemd 的 Environment= 注入 FRP_CONSOLE_PANEL_URL / INSTALL_TOKEN。
 * Windows 没有 systemd，必须在启动 frpc **之前** set 这两个环境变量，否则面板
 * 收不到心跳、节点一直显示离线。交互式启动与开机自启两条路径都要覆盖。
 */

import iconv from 'iconv-lite';
import type { InstallPlan } from './installer.js';
import { createZip, toCrlf, type ZipEntry } from './zip.js';

/** 计划任务名（同时也是进程识别用的标识）。 */
function taskName(nodeId: number): string {
  return `frp-console-frpc-${nodeId}`;
}

/** UTF-8 带 BOM：让记事本正确识别中文 .txt。 */
function utf8Bom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

/** .cmd 一律 GBK 编码（见文件头说明），并统一 CRLF。 */
function gbkCmd(text: string): Buffer {
  const buf = iconv.encode(toCrlf(text), 'gbk');
  // iconv 用 '?' 替换无法编码的字符；出现即说明脚本里有 GBK 覆盖不到的字符。
  if (buf.includes(0x3f) && text.includes('\uFFFD')) {
    throw new Error('Windows 脚本包含 GBK 无法编码的字符，请改用纯中文/ASCII');
  }
  return buf;
}

/** XML 特殊字符转义（计划任务定义用）。 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 面板 /api/heartbeat 的基址（frpc 会自行追加 /api/heartbeat）。 */
function heartbeatEnv(plan: InstallPlan, panelUrl: string) {
  return {
    url: panelUrl.replace(/\/+$/, ''),
    token: plan.node.installToken,
  };
}

/**
 * 启动脚本：设置心跳环境变量后运行 frpc。
 *
 * 独立成一个文件，是因为**计划任务需要一个无需交互、自带环境的入口**：
 * 任务在登录时由系统启动，拿不到管理脚本里 set 的变量。
 * 交互式菜单启动 frpc 时不走这里（那里用 PowerShell 直接拿精确 PID）。
 */
export function renderWindowsStartCmd(plan: InstallPlan, panelUrl: string): string {
  const hb = heartbeatEnv(plan, panelUrl);
  return toCrlf(`@echo off
REM Set codepage BEFORE any non-ASCII output (this file is GBK-encoded).
chcp 936 >nul 2>&1
REM ============================================================================
REM  frp-console - frpc 启动器（供开机自启的计划任务调用）
REM  由 frp-console 生成，请勿手工修改。
REM ============================================================================
setlocal

REM 切到脚本所在目录，保证 frpc.log / frpc.toml 的相对路径可用
cd /d "%~dp0"

REM ---- 心跳上报所需的环境变量（面板据此判断节点在线）----
set "FRP_CONSOLE_PANEL_URL=${hb.url}"
set "FRP_CONSOLE_INSTALL_TOKEN=${hb.token}"
set "FRP_CONSOLE_HEARTBEAT_INTERVAL=30"

REM ---- 前台运行，进程生命周期由计划任务托管 ----
"%~dp0frpc.exe" -c "%~dp0frpc.toml" >> "%~dp0frpc.log" 2>&1
`);
}

/**
 * 计划任务 XML。
 *
 * 用 XML 而不是 `schtasks /TR "..."` 是因为命令行引号在 CMD 里极易出错
 * （路径含空格时尤甚）。XML 把命令与参数放在独立元素里，完全回避转义问题。
 * RunLevel 为 HighestAvailable，等价于 /RL HIGHEST（需要管理员权限创建）。
 *
 * 注意：`<Command>` 必须是**绝对路径**，而解压目录在生成时未知，因此这里写入
 * 占位符 {@link LAUNCHER_PLACEHOLDER}，由管理脚本在注册任务前替换为真实路径。
 */
export const LAUNCHER_PLACEHOLDER = '__FRPC_LAUNCHER__';

export function renderWindowsTaskXml(plan: InstallPlan): string {
  const desc = `frp-console frpc autostart - node ${plan.node.name} (#${plan.node.id})`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(desc)}</Description>
    <URI>\\${xmlEscape(taskName(plan.node.id))}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(LAUNCHER_PLACEHOLDER)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * 交互式管理脚本（GBK 编码）。
 *
 * 无参数时进入菜单，按键 1-7 选择；带参数时直接执行对应动作，便于脚本调用。
 */
export function renderWindowsManageCmd(plan: InstallPlan, panelUrl: string): string {
  const { node } = plan;
  const task = taskName(node.id);
  const hb = heartbeatEnv(plan, panelUrl);

  return toCrlf(`@echo off
REM Set codepage BEFORE any non-ASCII output. This file is GBK-encoded;
REM if the host console uses another codepage (e.g. English Windows),
REM Chinese text would render as garbage.
chcp 936 >nul 2>&1
REM ============================================================================
REM  frp-console - frpc for Windows
REM  节点: ${node.name} (#${node.id})
REM  由 frp-console 生成（定制版 frp ${plan.frpVersion}）
REM
REM  双击本文件进入交互菜单；也可传参直接执行：
REM    frpc-manage.cmd install^|start^|stop^|restart^|status^|autostart^|uninstall
REM ============================================================================
setlocal enabledelayedexpansion
title frp-console - ${node.name}

set "SCRIPT_DIR=%~dp0"
set "FRPC_EXE=%SCRIPT_DIR%frpc.exe"
set "LAUNCHER=%SCRIPT_DIR%frpc-start.cmd"
set "TASK_XML=%SCRIPT_DIR%frpc-task.xml"
set "CONFIG=%SCRIPT_DIR%frpc.toml"
set "LOG=%SCRIPT_DIR%frpc.log"
set "PID_FILE=%SCRIPT_DIR%frpc.pid"
set "TASK_NAME=${task}"

REM ---- 心跳上报环境变量（启动 frpc 前必须设置，否则面板显示离线）----
set "FRP_CONSOLE_PANEL_URL=${hb.url}"
set "FRP_CONSOLE_INSTALL_TOKEN=${hb.token}"
set "FRP_CONSOLE_HEARTBEAT_INTERVAL=30"

REM ---- 带参数则直接执行，不进菜单 ----
if not "%1"=="" goto :dispatch

:menu
cls
echo ============================================================
echo   frp-console - frpc for Windows
echo ------------------------------------------------------------
echo   节点   : ${node.name} (#${node.id})
echo   服务器 : ${plan.serverAddr}:${plan.serverPort}
echo ============================================================
call :statusline
echo.
echo   [1] 安装（启动 + 设置开机自启）
echo   [2] 启动
echo   [3] 停止
echo   [4] 重启
echo   [5] 查看状态
echo   [6] 设置开机自启
echo   [7] 卸载（停止 + 删除开机自启）
echo   [0] 退出
echo.
set "CHOICE="
set /p "CHOICE=请输入序号后回车: "
if "!CHOICE!"=="1" goto :install
if "!CHOICE!"=="2" goto :start
if "!CHOICE!"=="3" goto :stop
if "!CHOICE!"=="4" goto :restart
if "!CHOICE!"=="5" goto :status
if "!CHOICE!"=="6" goto :autostart
if "!CHOICE!"=="7" goto :uninstall
if "!CHOICE!"=="0" goto :quit
echo.
echo 无效输入，请重新选择。
timeout /t 2 >nul
goto :menu

:dispatch
if /i "%1"=="install"   goto :install
if /i "%1"=="start"     goto :start
if /i "%1"=="stop"      goto :stop
if /i "%1"=="restart"   goto :restart
if /i "%1"=="status"    goto :status
if /i "%1"=="autostart" goto :autostart
if /i "%1"=="uninstall" goto :uninstall
if /i "%1"=="_elevated_autostart" goto :autostart_do
if /i "%1"=="_elevated_uninstall" goto :uninstall_do
echo 未知参数: %1
echo 用法: %~nx0 [install^|start^|stop^|restart^|status^|autostart^|uninstall]
exit /b 1

REM ---------------------------------------------------------------- 工具函数
:check_files
if not exist "%FRPC_EXE%" (
  echo [错误] 未找到 frpc.exe: %FRPC_EXE%
  exit /b 1
)
if not exist "%CONFIG%" (
  echo [错误] 未找到 frpc.toml: %CONFIG%
  exit /b 1
)
exit /b 0

:is_admin
REM S-1-16-12288 = 高完整性级别（已提权），与系统语言无关
whoami /groups 2>nul | find "S-1-16-12288" >nul 2>&1
exit /b %errorlevel%

:is_running
if not exist "%PID_FILE%" exit /b 1
set "PID="
set /p PID=<"%PID_FILE%"
if "!PID!"=="" exit /b 1
tasklist /FI "PID eq !PID!" 2>nul | find "!PID!" >nul
if errorlevel 1 exit /b 1
exit /b 0

:statusline
call :is_running && (
  set /p PID=<"%PID_FILE%"
  echo   运行状态: 运行中 ^(PID !PID!^)
) || (
  echo   运行状态: 已停止
)
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1 && (
  echo   开机自启: 已启用
) || (
  echo   开机自启: 未启用
)
exit /b 0

REM 停止进程（内联实现：CMD 中 call 进的子程序若含 goto 会跳走，
REM 导致调用方后续语句被跳过，所以这里重复三处也不封装成子程序）
:kill_now
if exist "%PID_FILE%" (
  set "PID="
  set /p PID=<"%PID_FILE%"
  if not "!PID!"=="" taskkill /PID !PID! /F >nul 2>&1
  del "%PID_FILE%" >nul 2>&1
)
REM 兜底：按可执行文件路径精确匹配本目录的 frpc 实例
REM （不用 wmic —— 它在较新 Windows 已被移除）
for /f "usebackq delims=" %%P in (\`powershell -NoProfile -Command "Get-Process frpc -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '%FRPC_EXE%' } | ForEach-Object { $_.Id }"\`) do taskkill /PID %%P /F >nul 2>&1
exit /b 0

REM ------------------------------------------------------------------- 动作
:install
call :check_files || goto :pause_return
REM 创建带 HighestAvailable 的计划任务需要管理员权限，提前提权
call :is_admin || (
  echo.
  echo 安装需要管理员权限（用于设置开机自启）。
  echo 即将弹出 UAC 窗口，请点击“是”。
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'install' -Verb RunAs" >nul 2>&1
  goto :quit
)
echo 正在停止可能已运行的实例...
call :kill_now
echo 正在启动 frpc...
call :start_do || goto :pause_return
echo 正在设置开机自启...
call :autostart_do
echo.
echo 安装完成。配置文件: %CONFIG%
goto :pause_return

:start
call :check_files || goto :pause_return
call :is_running && (
  echo frpc 已在运行中。
  goto :pause_return
)
echo 正在启动 frpc...
call :start_do || goto :pause_return
goto :pause_return

:start_do
REM 用 PowerShell Start-Process -PassThru 直接拿到精确 PID
REM （tasklist/wmic 会匹配到别的 frpc 实例，wmic 在新版 Windows 已移除）
set "PID="
for /f "usebackq delims=" %%P in (\`powershell -NoProfile -Command "(Start-Process -FilePath '%FRPC_EXE%' -ArgumentList @('-c','%CONFIG%') -WindowStyle Minimized -PassThru).Id"\`) do set "PID=%%P"
if "!PID!"=="" (
  echo [警告] 已启动，但未能获取 PID；停止功能可能不可用。
  echo        可改用「设置开机自启」由计划任务托管。
  exit /b 1
)
>"%PID_FILE%" echo !PID!
echo frpc 已启动 ^(PID !PID!^)。
echo 日志: %LOG%
exit /b 0

:stop
call :is_running || (
  echo frpc 未在运行。
  goto :pause_return
)
set /p PID=<"%PID_FILE%"
echo 正在停止 frpc ^(PID !PID!^)...
taskkill /PID !PID! /F >nul 2>&1
del "%PID_FILE%" >nul 2>&1
echo frpc 已停止。
goto :pause_return

:restart
echo 正在重启...
call :kill_now
timeout /t 1 >nul
call :start_do
goto :pause_return

:status
call :statusline
echo.
echo 配置文件: %CONFIG%
echo 日志文件: %LOG%
goto :pause_return

:autostart
call :check_files || goto :pause_return
call :is_admin || (
  echo.
  echo 设置开机自启需要管理员权限。
  echo 即将弹出 UAC 窗口，请点击“是”。
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'autostart' -Verb RunAs" >nul 2>&1
  goto :quit
)
:autostart_do
if not exist "%TASK_XML%" (
  echo [错误] 未找到计划任务定义: %TASK_XML%
  exit /b 1
)
if not exist "%LAUNCHER%" (
  echo [错误] 未找到启动器: %LAUNCHER%
  exit /b 1
)
REM XML 里的启动器路径是占位符，注册前替换为真实绝对路径。
REM 用 PowerShell 替换（路径含空格/中文时 CMD 的字符串替换不可靠）。
powershell -NoProfile -Command "$xml = Get-Content -LiteralPath '%TASK_XML%' -Raw -Encoding Unicode; $xml = $xml.Replace('${LAUNCHER_PLACEHOLDER}', '%LAUNCHER%'); Set-Content -LiteralPath '%TASK_XML%.tmp' -Value $xml -Encoding Unicode" >nul 2>&1
if errorlevel 1 (
  echo [错误] 生成计划任务定义失败。
  exit /b 1
)
REM 先删除旧任务，避免残留定义冲突
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
schtasks /Create /TN "%TASK_NAME%" /XML "%TASK_XML%.tmp" /F
if errorlevel 1 (
  echo.
  echo [错误] 创建计划任务失败。
  echo 可能原因：未以管理员身份运行，或系统策略禁止创建计划任务。
  echo 请右键 frpc-manage.cmd - 以管理员身份运行后重试。
  del "%TASK_XML%.tmp" >nul 2>&1
  exit /b 1
)
del "%TASK_XML%.tmp" >nul 2>&1
echo 开机自启已启用（任务名: %TASK_NAME%）。
echo frpc 将在每次登录 Windows 时自动启动。
exit /b 0

:uninstall
call :is_admin || (
  echo.
  echo 卸载需要管理员权限（用于删除计划任务）。
  echo 即将弹出 UAC 窗口，请点击“是”。
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'uninstall' -Verb RunAs" >nul 2>&1
  goto :quit
)
:uninstall_do
echo 正在卸载...
call :kill_now
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
echo 开机自启已移除。
echo 完成。frpc 已停止，可删除本目录。
goto :pause_return

:pause_return
echo.
set "BACK="
set /p "BACK=按回车返回菜单（输入 q 退出）: "
if /i "!BACK!"=="q" goto :quit
goto :menu

:quit
endlocal
exit /b 0
`);
}

export interface WindowsPackageOptions {
  /** 面板基址，用于写入心跳地址（必须节点可达）。 */
  panelUrl: string;
  /** 是否包含中文 README。 */
  includeReadme?: boolean;
}

export interface WindowsPackageFile {
  name: string;
  data: Buffer;
  /** 便于测试与排查：文本类文件同时保留可读内容。 */
  text?: string;
}

/**
 * 组装 Windows 包内所有文件（不压缩）。
 * 拆分出来便于单测直接检查各文件内容与编码。
 */
export function buildWindowsPackageFiles(
  plan: InstallPlan,
  exe: Buffer,
  opts: WindowsPackageOptions,
): { root: string; files: WindowsPackageFile[] } {
  const { node } = plan;
  const root = `frp-console-frpc-${node.id}`;
  const panel = opts.panelUrl.replace(/\/+$/, '');
  const refreshUrl = `${panel}/api/install/${node.installToken}/frpc.toml`;

  const proxyLines = plan.proxies
    .filter((p) => p.enabled)
    .map(
      (p) =>
        `  - ${p.name} [${p.type}] ${p.localIp}:${p.localPort} -> 远端 ${p.remotePort ?? '(随机)'}`,
    )
    .join('\n');

  const manage = renderWindowsManageCmd(plan, panel);
  const start = renderWindowsStartCmd(plan, panel);
  const taskXml = renderWindowsTaskXml(plan);

  const files: WindowsPackageFile[] = [
    { name: `${root}/frpc.exe`, data: exe },
    // frpc.toml 由 Go 程序读取，必须是 UTF-8（不能 GBK）
    { name: `${root}/frpc.toml`, data: Buffer.from(plan.frpcToml, 'utf8'), text: plan.frpcToml },
    { name: `${root}/frpc-start.cmd`, data: gbkCmd(start), text: start },
    { name: `${root}/frpc-manage.cmd`, data: gbkCmd(manage), text: manage },
    {
      name: `${root}/frpc-task.xml`,
      // 计划任务定义用 UTF-16LE + BOM：schtasks /XML 对 Unicode 支持最稳
      data: iconv.encode(`\ufeff${taskXml}`, 'utf16-le'),
      text: taskXml,
    },
  ];

  if (opts.includeReadme !== false) {
    const readme = toCrlf(`frp-console - Windows 节点使用说明
==============================================

节点: ${node.name} (#${node.id})
frp : ${plan.frpVersion} (定制版)
服务器: ${plan.serverAddr}:${plan.serverPort}
心跳上报: ${panel}/api/heartbeat (每 30 秒)

已配置的穿透:
${proxyLines || '  (无)'}

【安装步骤】
1. 解压本压缩包到任意目录（建议 C:\\frpc，路径不要含中文）
2. 双击 frpc-manage.cmd
3. 输入 1 回车（安装）
4. 弹出 UAC 窗口时点“是”（设置开机自启需要管理员权限）

安装完成后：
  - frpc 立即启动，并在面板「节点管理」显示为在线
  - 每次登录 Windows 会自动启动

【常用命令】（也可双击后按数字选择）
  frpc-manage.cmd install     安装 + 启动 + 开机自启
  frpc-manage.cmd start       启动
  frpc-manage.cmd stop        停止
  frpc-manage.cmd restart     重启
  frpc-manage.cmd status      查看运行状态
  frpc-manage.cmd autostart   仅设置开机自启
  frpc-manage.cmd uninstall   卸载（停止并删除自启）

【日志】
  frpc.log（与本文件同目录）

【文件说明】
  frpc.exe          定制版 frpc（含心跳上报与 diag 诊断）
  frpc.toml         本节点的配置
  frpc-start.cmd    启动器，开机自启的计划任务调用它
  frpc-manage.cmd   交互式管理菜单
  frpc-task.xml     开机自启的计划任务定义

【面板拉取最新配置】
  在面板修改代理后，重新下载本安装包覆盖，
  或直接访问：${refreshUrl}

【排查】
  - 面板显示离线：确认 frpc.log 中有 "heartbeat enabled"，并检查
    节点能否访问 ${panel}（防火墙 / 安全组需放行该端口）
  - 开机自启失败：需以管理员身份运行（脚本会自动请求提权）
  - 杀毒软件误报：定制版 frp 为自行编译，请添加信任
  - 需放行到服务器的 ${plan.serverPort} 端口
`);

    files.push({ name: `${root}/README.txt`, data: utf8Bom(readme), text: readme });
  }

  return { root, files };
}

/**
 * 生成 Windows 安装包（.zip）。
 * 下载时实时组装，因此每个节点拿到的是自己的 frpc.toml 与心跳 token。
 */
export function buildWindowsPackage(
  plan: InstallPlan,
  exe: Buffer,
  opts: WindowsPackageOptions,
): { buffer: Buffer; name: string } {
  const { root, files } = buildWindowsPackageFiles(plan, exe, opts);

  const entries: ZipEntry[] = [
    { name: `${root}/`, data: '' },
    ...files.map((f) => ({
      name: f.name,
      data: f.data,
      // exe 已是压缩格式，再 deflate 收益极小
      store: f.name.endsWith('.exe'),
    })),
  ];

  return {
    buffer: createZip(entries),
    name: `${root}-windows-amd64.zip`,
  };
}