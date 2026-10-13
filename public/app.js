/* frp-console frontend — no build step, plain ES2020. */

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);

/** Set when the server answers 401 so we stop hammering protected APIs. */
let loggedOut = false;

async function api(path, opts = {}) {
  // Only advertise a JSON content-type when a body is actually sent: Fastify
  // rejects `Content-Type: application/json` with an empty body (400).
  const headers = opts.body === undefined ? {} : { 'Content-Type': 'application/json' };
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    showLogin('登录已过期，请重新登录');
    throw new Error('未登录');
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ login */

function showLogin(message = '') {
  loggedOut = true;
  $('appRoot').classList.add('hidden');
  $('loginRoot').classList.remove('hidden');
  $('loginError').textContent = message;
  $('loginError').classList.toggle('hidden', !message);
  setTimeout(() => $('loginUser')?.focus(), 30);
}

function hideLogin() {
  loggedOut = false;
  $('loginRoot').classList.add('hidden');
  $('appRoot').classList.remove('hidden');
}

async function doLogin(event) {
  event.preventDefault();
  const btn = $('loginBtn');
  $('loginError').classList.add('hidden');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('loginUser').value, password: $('loginPass').value },
    });
    $('loginPass').value = '';
    hideLogin();
    bootApp();
  } catch (err) {
    $('loginError').textContent = err.message === '未登录' ? '账号或密码错误' : err.message;
    $('loginError').classList.remove('hidden');
    $('loginPass').value = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  showLogin('已退出登录');
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function globalAlert(msg, kind = 'err') {
  $('globalAlert').innerHTML = msg ? `<div class="alert ${kind}">${escapeHtml(msg)}</div>` : '';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function val(id) { const e = $(id); return e ? e.value.trim() : ''; }
function num(id) { const v = val(id); return v === '' ? null : Number(v); }
function checked(id) { const e = $(id); return e ? e.checked : false; }
function setVal(id, v) { const e = $(id); if (e) e.value = v === null || v === undefined ? '' : v; }
function setChecked(id, v) { const e = $(id); if (e) e.checked = !!v; }

/* ------------------------------------------------------------- navigation */

const PAGE_TITLES = { dashboard: '总览', frps: 'frps 设置', ports: '端口范围', nodes: '节点管理', build: '定制构建' };

function go(page) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'dashboard') loadDashboard();
  if (page === 'frps') loadSettings();
  if (page === 'ports') loadPorts();
  if (page === 'nodes') loadNodes();
  if (page === 'build') loadBuildStatus();
}

document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => go(n.dataset.page)));

/* -------------------------------------------------------------- dashboard */

async function loadDashboard() {
  try {
    const [health, status, info, ports] = await Promise.all([
      api('/api/health'),
      api('/api/frps/status'),
      api('/api/system/info'),
      api('/api/ports'),
    ]);
    globalAlert('');

    const s = status.status || {};
    const badge = s.active ? '<span class="badge green">运行中</span>'
      : s.available === false ? '<span class="badge amber">未安装/不可用</span>'
      : '<span class="badge red">已停止</span>';
    $('frpsStatusBox').innerHTML = `
      <div class="kv" style="grid-template-columns:110px 1fr">
        <div class="k">状态</div><div class="v">${badge} ${escapeHtml(s.state || '')}</div>
        <div class="k">开机自启</div><div class="v">${s.enabled ? '已启用' : '未启用'}</div>
        <div class="k">启动时间</div><div class="v">${escapeHtml(s.since || '-')}</div>
        <div class="k">PID / 内存</div><div class="v">${s.mainPid || '-'} ${s.memory ? '/ ' + s.memory : ''}</div>
        <div class="k">配置文件</div><div class="v">${escapeHtml(status.paths.configPath)}</div>
        <div class="k">二进制</div><div class="v">${escapeHtml(status.paths.binaryPath)}</div>
      </div>
      <div class="btn-row">
        <button class="primary" onclick="deployFrps()">生成配置并重启 frps</button>
        <button onclick="controlFrps('restart')">重启</button>
        <button onclick="controlFrps('stop')">停止</button>
        <button onclick="showLogs()">查看日志</button>
      </div>`;

    $('statNodes').textContent = info.counts.nodes;
    $('statProxies').textContent = info.counts.proxies;
    $('statPool').textContent = `${ports.used}/${ports.total}`;
    $('navNodeCount').textContent = info.counts.nodes;

    const h = info.host, f = info.frp;
    $('sysInfoKv').innerHTML = `
      <div class="k">面板地址</div><div class="v">${escapeHtml(info.panel.baseUrl)}
        ${info.panel.baseUrlIsGuess
          ? '<span class="badge amber" style="margin-left:6px">自动探测（内网）</span>'
          : `<span class="badge green" style="margin-left:6px">${{ setting: '已设置', env: '环境变量', auto: '自动' }[info.panel.baseUrlSource] || '已设置'}</span>`}
      </div>
      <div class="k">面板鉴权</div><div class="v">${info.panel.passwordProtected ? '已启用（HTTP Basic）' : '未启用'}</div>
      <div class="k">主机</div><div class="v">${escapeHtml(h.hostname)} · ${escapeHtml(h.platform)}/${escapeHtml(h.arch)}</div>
      <div class="k">frp 版本</div><div class="v">定制版 v${escapeHtml(f.version)}
        ${f.buildReady ? '<span class="badge green" style="margin-left:6px">构建就绪</span>' : '<span class="badge red" style="margin-left:6px">未构建</span>'}
        ${f.frpsInstalledVersion ? ` · 运行中 v${escapeHtml(f.frpsInstalledVersion)}` : ''}
        ${f.buildIssue ? `<div style="color:var(--amber);font-size:12px">${escapeHtml(f.buildIssue)}</div>` : ''}
      </div>`;
  } catch (err) {
    globalAlert(`加载失败: ${err.message}`);
  }
}

async function deployFrps() {
  if (!confirm('将写入 frps.toml 与 systemd unit，并重启 frps 服务。继续？')) return;
  try {
    const r = await api('/api/frps/deploy', { method: 'POST' });
    const bad = (r.steps || []).filter((s) => !s.ok && !s.skipped);
    if (bad.length) {
      globalAlert(`部分 systemd 命令失败:\n${bad.map((b) => `${b.command}\n${b.stderr}`).join('\n\n')}`, 'warn');
    } else {
      toast('frps 配置已生成并重启');
    }
    go('dashboard');
  } catch (err) { globalAlert(`部署失败: ${err.message}`); }
}

async function controlFrps(action) {
  try {
    const r = await api('/api/frps/control', { method: 'POST', body: { action } });
    if (!r.result.ok && !r.result.skipped) {
      globalAlert(`${action} 失败: ${r.result.stderr || r.result.stdout}`, 'warn');
    } else {
      toast(`frps ${action} 完成`);
    }
    loadDashboard();
  } catch (err) { globalAlert(`${action} 失败: ${err.message}`); }
}

async function showLogs() {
  try {
    const r = await api('/api/frps/logs?lines=200');
    openModal(`frps 日志`, `<pre class="code">${escapeHtml(r.stdout || r.stderr || '(无日志)')}</pre>`,
      `<button onclick="closeModal()">关闭</button>`);
  } catch (err) { globalAlert(`读取日志失败: ${err.message}`); }
}

/* --------------------------------------------------------------- settings */

function genToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  setVal('s_authToken', [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

/** Guards against saving before the form is populated (which would wipe values). */
let settingsLoaded = false;

async function loadSettings() {
  try {
    settingsLoaded = false;
    const [s, info] = await Promise.all([api('/api/settings'), api('/api/system/info')]);
    renderPanelUrlWarning(info);
    // 直链资产名需要 frp 基础版本号（由后端提供，避免前后端不一致）
    FRP_BASE_VERSION = info?.frp?.baseVersion || '';
    FRPS_ADDR = s.frpsAddr || '';
    setVal('s_bindPort', s.bindPort);
    setVal('s_bindAddr', s.bindAddr);
    setVal('s_frpsAddr', s.frpsAddr);
    setVal('s_authMethod', s.authMethod);
    setVal('s_authToken', s.authToken);
    setVal('s_kcpBindPort', s.kcpBindPort);
    setVal('s_quicBindPort', s.quicBindPort);
    setVal('s_udpPacketSize', s.udpPacketSize);
    setVal('s_vhostHttpPort', s.vhostHttpPort);
    setVal('s_vhostHttpsPort', s.vhostHttpsPort);
    setVal('s_subdomainHost', s.subdomainHost);
    setChecked('s_dashboardEnabled', s.dashboardEnabled);
    setVal('s_dashboardPort', s.dashboardPort);
    setVal('s_dashboardUser', s.dashboardUser);
    setVal('s_dashboardPassword', s.dashboardPassword);
    setVal('s_logLevel', s.logLevel);
    setVal('s_logMaxDays', s.logMaxDays);
    setVal('s_heartbeatTimeout', s.heartbeatTimeout);
    setVal('s_maxPoolCount', s.maxPoolCount);
    setVal('s_tcpMuxKeepalive', s.tcpMuxKeepalive);
    setVal('s_maxPortsPerClient', s.maxPortsPerClient);
    setChecked('s_tcpMux', s.tcpMux);
    setChecked('s_tlsForce', s.tlsForce);
    setChecked('s_detailedErrors', s.detailedErrors);
    setChecked('s_enablePrometheus', s.enablePrometheus);
    setVal('s_extraToml', s.extraToml);
    setVal('s_publicBaseUrl', s.publicBaseUrl);
    setVal('s_githubProxy', s.githubProxy);
    setChecked('s_githubProxyApi', s.githubProxyApi);
    setVal('s_goproxy', s.goproxy);
    setVal('s_goDownloadBase', s.goDownloadBase);
    renderMirrorRows(s.assetMirrors || {});
    settingsLoaded = true;
    renderVariantStatus();
  } catch (err) { globalAlert(`加载设置失败: ${err.message}`); }
}

function collectSettings() {
  return {
    bindPort: num('s_bindPort'), bindAddr: val('s_bindAddr'), authMethod: val('s_authMethod'),
    frpsAddr: val('s_frpsAddr'),
    authToken: val('s_authToken'), kcpBindPort: num('s_kcpBindPort'), quicBindPort: num('s_quicBindPort'),
    udpPacketSize: num('s_udpPacketSize'), vhostHttpPort: num('s_vhostHttpPort'),
    vhostHttpsPort: num('s_vhostHttpsPort'), subdomainHost: val('s_subdomainHost') || null,
    dashboardEnabled: checked('s_dashboardEnabled'), dashboardPort: num('s_dashboardPort'),
    dashboardUser: val('s_dashboardUser'), dashboardPassword: val('s_dashboardPassword'),
    logLevel: val('s_logLevel'), logMaxDays: num('s_logMaxDays'), heartbeatTimeout: num('s_heartbeatTimeout'),
    maxPoolCount: num('s_maxPoolCount'), tcpMuxKeepalive: num('s_tcpMuxKeepalive'),
    maxPortsPerClient: num('s_maxPortsPerClient'), tcpMux: checked('s_tcpMux'),
    tlsForce: checked('s_tlsForce'), detailedErrors: checked('s_detailedErrors'),
    enablePrometheus: checked('s_enablePrometheus'), extraToml: val('s_extraToml'),
    publicBaseUrl: val('s_publicBaseUrl'),
    githubProxy: val('s_githubProxy'), githubProxyApi: checked('s_githubProxyApi'),
    goproxy: val('s_goproxy'), goDownloadBase: val('s_goDownloadBase'),
    // 二进制直链映射：必须随设置一起提交，否则保存后直链会丢失
    assetMirrors: collectMirrorRows(),
  };
}

async function saveSettings() {
  // Never submit a half-populated form: an empty token would clear frps auth.
  if (!settingsLoaded) {
    globalAlert('设置尚未加载完成，请稍候再保存。');
    return;
  }
  if (!val('s_authToken')) {
    globalAlert('auth.token 不能为空——这会让 frpc 无法通过 frps 认证。');
    return;
  }
  try {
    const r = await api('/api/settings', { method: 'PUT', body: collectSettings() });
    if (r.warnings && r.warnings.length) globalAlert(`已保存，但需注意:\n${r.warnings.join('\n')}`, 'warn');
    else { globalAlert(''); toast('设置已保存'); }
    // 记住刚保存的 frps 对外地址：节点表单要显示「留空则继承」的值，
    // 若不同步，改完地址后立刻新建节点会看到过期的继承值。
    FRPS_ADDR = val('s_frpsAddr');
    // Refresh the derived public-URL state so the warning reflects the new value
    // immediately instead of staying stale until a page reload.
    try { renderPanelUrlWarning(await api('/api/system/info')); } catch { /* non-fatal */ }
    renderVariantStatus();
  } catch (err) { globalAlert(`保存失败: ${err.message}`); }
}

async function previewToml() {
  try {
    await saveSettings();
    const r = await api('/api/settings/preview');
    openModal('frps.toml 预览', `<pre class="code">${escapeHtml(r.frpsToml)}</pre>`,
      `<button onclick="closeModal()">关闭</button>
       ${copyButton(r.frpsToml)}`);
  } catch (err) { globalAlert(`预览失败: ${err.message}`); }
}

/** Show whether the tuned build is ready and which architectures exist. */
async function renderVariantStatus() {
  const box = $('variantStatus');
  const archBox = $('variantArches');
  if (!box) return;

  try {
    const st = await api('/api/custom-build/status');
    const frpsOk = st.binaries?.frps?.present;
    const frpcOk = st.binaries?.frpc?.present;
    const features = st.customFeatures || [];
    const arches = st.prebuiltArches || [];

    if (frpsOk && frpcOk) {
      box.innerHTML = `<span class="badge green">已就绪</span> ` +
        features.map((f) => `<span class="badge" style="margin-left:4px">${escapeHtml(f)}</span>`).join('');
    } else {
      box.innerHTML = `<span class="badge red">不可用</span> ` +
        `<span style="color:var(--text-dim)">尚未构建，面板无法部署 frps、节点也无法安装</span>`;
    }

    if (archBox) {
      archBox.innerHTML = arches.length
        ? arches.map((a) => `<span class="badge blue" style="margin-right:4px">${escapeHtml(a)}</span>`).join('')
        : '<span class="badge amber">无预构建包</span> <span style="color:var(--text-dim)">仅能服务面板同架构节点</span>';
    }
  } catch {
    box.textContent = '(无法读取定制构建状态)';
  }
}

/** Fill the field with the address this browser is using right now. */
function useDetectedUrl() {
  setVal('s_publicBaseUrl', location.origin);
  toast(`已填入 ${location.origin}`);
}

/** 把当前访问地址的主机名填入「frps 地址」（不带端口）。 */
function useDetectedForFrps() {
  const host = location.hostname;
  setVal('s_frpsAddr', host);
  toast(`已填入 ${host}（端口请用上方的 bindPort）`);
}

/** True for loopback / RFC1918 / link-local hosts. */
function isPrivateHost(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 169 && b === 254) ||
         (a === 100 && b >= 64 && b <= 127);
}

/** Warn when the resolved URL is an auto-detected LAN guess. */
function renderPanelUrlWarning(info) {
  const box = $('panelUrlWarn');
  const hint = $('detectedUrlHint');
  if (!box) return;
  const p = info?.panel;
  if (p) {
    if (hint) {
      const addrs = (p.lanAddresses || []).join(', ') || '无';
      hint.textContent = `当前生效: ${p.baseUrl}（来源: ${{setting:'已设置',env:'环境变量',auto:'自动探测'}[p.baseUrlSource] || p.baseUrlSource}）· 本机内网地址: ${addrs}`;
    }
    const configuredIsPrivate = !!p.configuredBaseUrl && isPrivateHost(p.configuredBaseUrl);
    if ((p.baseUrlIsGuess && !p.configuredBaseUrl) || configuredIsPrivate) {
      box.style.display = '';
      box.textContent = configuredIsPrivate
        ? `⚠ 你填写的 ${p.configuredBaseUrl} 是内网/回环地址，外部节点无法访问。请改成公网 IP 或域名。`
        : `⚠ 当前使用的是自动探测的内网地址 ${p.baseUrl}。如果节点在别的网络，安装脚本里的回连地址将无法访问——请在上方填写公网地址或域名。`;
    } else {
      box.style.display = 'none';
    }
  }
}

async function testGithubProxy() {
  const proxy = val('s_githubProxy');
  const box = $('proxyTestResult');
  box.textContent = '测试中…';
  box.style.color = 'var(--text-dim)';
  try {
    // Persist first so the server tests exactly what the operator sees.
    await saveSettings();
    const r = await api('/api/mirrors/test', {
      method: 'POST',
      body: { proxy, testApi: checked('s_githubProxyApi') },
    });
    const parts = [];
    parts.push(r.download.ok
      ? `文件下载 ✓ (${r.download.status}, ${r.download.detail})`
      : `文件下载 ✗ (${r.download.detail})`);
    if (r.api) {
      parts.push(r.api.ok ? 'API ✓' : `API ✗ (${r.api.detail})`);
    }
    const ok = r.download.ok;
    box.textContent = parts.join('  |  ');
    box.style.color = ok ? 'var(--green)' : 'var(--red)';
  } catch (err) {
    box.textContent = `测试失败: ${err.message}`;
    box.style.color = 'var(--red)';
  }
}

async function verifyToml() {
  try {
    const r = await api('/api/settings/verify', { method: 'POST', body: {} });
    if (r.ok) toast('frps verify 通过，配置合法');
    else globalAlert(`配置校验失败:\n${r.stderr || r.stdout}\n\n--- 配置 ---\n${r.frpsToml}`, 'err');
  } catch (err) { globalAlert(`校验失败: ${err.message}`); }
}

/* ------------------------------------------------------------------ ports */

let rangeDraft = [];

function addRangeRow(start = '', end = '') {
  rangeDraft.push({ start, end });
  renderRanges();
}

function renderRanges() {
  $('rangeList').innerHTML = rangeDraft.length
    ? rangeDraft.map((r, i) => `
      <div class="range-row">
        <input type="number" min="1" max="65535" value="${r.start}" placeholder="起始" oninput="rangeDraft[${i}].start=this.value">
        <span style="color:var(--text-dim)">—</span>
        <input type="number" min="1" max="65535" value="${r.end}" placeholder="结束" oninput="rangeDraft[${i}].end=this.value">
        <button class="sm danger" onclick="rangeDraft.splice(${i},1);renderRanges()">删除</button>
      </div>`).join('')
    : '<div class="empty">还没有端口区间，点击右上角「+ 添加区间」</div>';
}

function collectRanges() {
  const out = [];
  for (const r of rangeDraft) {
    if (r.start === '' || r.end === '') continue;
    out.push({ start: Number(r.start), end: Number(r.end) });
  }
  return out;
}

async function loadPorts() {
  try {
    const r = await api('/api/ports');
    rangeDraft = (r.ranges || []).map((x) => ({ start: x.start, end: x.end }));
    renderRanges();
    $('poolTotal').textContent = r.total;
    $('poolUsed').textContent = r.used;
    $('poolFree').textContent = r.free;
    $('usedPortsBox').textContent = (r.usedPorts || []).join(', ') || '(无)';
    $('manualReservations').innerHTML = (r.manualReservations || []).length
      ? (r.manualReservations || []).map((m) =>
          `<span class="badge" style="margin:0 6px 6px 0">${m.port}
             <a href="#" onclick="unreservePort(${m.port});return false" style="color:var(--red)">×</a></span>`).join('')
      : '<span style="color:var(--text-dim);font-size:13px">无手动保留</span>';
  } catch (err) { globalAlert(`加载端口池失败: ${err.message}`); }
}

async function saveRanges() {
  try {
    const r = await api('/api/settings', { method: 'PUT', body: { allowPorts: collectRanges() } });
    if (r.warnings && r.warnings.length) globalAlert(r.warnings.join('\n'), 'warn');
    else { globalAlert(''); toast('端口范围已保存'); }
    loadPorts();
  } catch (err) { globalAlert(`保存失败: ${err.message}`); }
}

async function reservePort() {
  const port = num('reservePort');
  if (!port) return toast('请输入端口号', 'err');
  try {
    await api('/api/ports/reserve', { method: 'POST', body: { port } });
    setVal('reservePort', '');
    toast(`已保留端口 ${port}`);
    loadPorts();
  } catch (err) { globalAlert(`保留失败: ${err.message}`); }
}

async function unreservePort(port) {
  try {
    await api(`/api/ports/reserve/${port}`, { method: 'DELETE' });
    toast(`已释放端口 ${port}`);
    loadPorts();
  } catch (err) { globalAlert(`释放失败: ${err.message}`); }
}

/* ------------------------------------------------------------------ nodes */

let currentNodeId = null;

async function loadNodes() {
  try {
    const nodes = await api('/api/nodes');
    $('navNodeCount').textContent = nodes.length;
    $('nodeList').innerHTML = nodes.length ? `
      <table><thead><tr>
        <th>ID</th><th>名称</th><th>服务器地址</th><th>协议</th><th>代理数</th><th>安装目录</th><th></th>
      </tr></thead><tbody>
      ${nodes.map((n) => `<tr>
        <td class="mono">#${n.id}</td>
        <td><a href="#" onclick="showNode(${n.id});return false">${escapeHtml(n.name)}</a>
            ${n.online === true ? '<span class="badge green" style="margin-left:6px">在线</span>' : n.online === false ? '<span class="badge">离线</span>' : ''}
            ${n.remark ? `<div style="color:var(--text-dim);font-size:12px">${escapeHtml(n.remark)}</div>` : ''}</td>
        <td class="mono">${escapeHtml(n.effectiveServerAddr || '(未设置)')}:${n.effectiveServerPort ?? ''}${n.addrInherited ? ' <span class="badge" title="继承自 frps 设置">继承</span>' : ''}</td>
        <td><span class="badge blue">${escapeHtml(n.protocol)}</span></td>
        <td>${n.proxyCount}</td>
        <td class="mono">${escapeHtml(n.installDir)}</td>
        <td class="actions">
          <button class="sm" onclick="showNode(${n.id})">详情</button>
          <button class="sm" onclick="showInstallScript(${n.id})">安装脚本</button>
          <button class="sm danger" onclick="removeNode(${n.id},'${escapeHtml(n.name)}')">删除</button>
        </td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">还没有节点，点击「+ 新建节点」开始</div>';

    if (currentNodeId && !nodes.some((n) => n.id === currentNodeId)) {
      currentNodeId = null;
      $('nodeDetail').classList.add('hidden');
    }
  } catch (err) { globalAlert(`加载节点失败: ${err.message}`); }
}

function openNodeModal(id = null) {
  const edit = id !== null;
  const node = edit ? (window.__nodesCache || []).find((n) => n.id === id) : null;
  const n = node || { name: '', remark: '', serverAddr: '', serverPort: '', installDir: '/etc/frp', frpcVersion: '', downloadBase: '', protocol: 'tcp', user: '', logLevel: 'info', loginFailExit: true, tlsEnable: false, authToken: '', extraToml: '' };

  openModal(edit ? `编辑节点 #${id}` : '新建节点', `
    <div class="grid2">
      <label class="field"><span>节点名称 *</span><input type="text" id="n_name" value="${escapeHtml(n.name)}" placeholder="例如 香港节点-A"></label>
      <label class="field"><span>备注</span><input type="text" id="n_remark" value="${escapeHtml(n.remark)}"></label>
      <label class="field"><span>frps 地址</span><input type="text" id="n_serverAddr" value="${escapeHtml(n.serverAddr)}" placeholder="留空 = 继承 frps 设置里的地址">
        <div class="hint">留空时自动使用「frps 设置 → frps 地址（对外公布）」，改一次全局生效。当前继承值：<b>${escapeHtml(FRPS_ADDR || '(未设置)')}</b></div></label>
      <label class="field"><span>frps 控制端口</span><input type="number" id="n_serverPort" value="${n.serverPort ?? ''}" placeholder="默认取 frps bindPort"></label>
      <label class="field"><span>连接密钥 auth.token（留空即继承 frps）</span><input type="text" id="n_authToken" value="${escapeHtml(n.authToken)}" placeholder="留空 = 自动跟随 frps 当前密钥（推荐）">
        <div class="hint">frps 只有一个全局密钥。留空时脚本会始终使用 frps 当前密钥，<b>之后改 frps 密钥也无需重装 frpc</b>；只有需要单独覆盖时才填写。</div></label>
      <label class="field"><span>连接协议（frpc 如何连 frps）</span>
        <select id="n_protocol">
          ${['tcp', 'kcp', 'quic', 'websocket', 'wss'].map((p) => `<option value="${p}" ${n.protocol === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <div class="hint">这是 frpc→frps 的<b>连接方式</b>（对应 frpc.toml 顶层的 transport.protocol），<b>不是代理类型</b>。非 tcp 会自动启用 TLS。真正要填 localIP / localPort / remotePort 的 <code>[[proxies]]</code>，请保存后到「节点详情 → + 添加代理」里配置。</div></label>
      <label class="field"><span>安装目录</span><input type="text" id="n_installDir" value="${escapeHtml(n.installDir)}"></label>
      <label class="field"><span>frp 版本</span><input type="text" id="n_frpcVersion" value="${escapeHtml(n.frpcVersion)}" placeholder="留空使用默认 v0.71.0"></label>
      <label class="field"><span>下载镜像 base URL</span><input type="text" id="n_downloadBase" value="${escapeHtml(n.downloadBase)}" placeholder="留空用 GitHub"></label>
      <label class="field"><span>客户端 user 前缀</span><input type="text" id="n_user" value="${escapeHtml(n.user)}"></label>
      <label class="field"><span>日志级别</span>
        <select id="n_logLevel">${['trace', 'debug', 'info', 'warn', 'error'].map((l) => `<option ${n.logLevel === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" id="n_loginFailExit" ${n.loginFailExit ? 'checked' : ''}><span>登录失败即退出 loginFailExit</span></label>
    <label class="check"><input type="checkbox" id="n_tlsEnable" ${n.tlsEnable ? 'checked' : ''}><span>启用 TLS 加密 transport.tls.enable</span></label>
    <label class="field"><span>额外 TOML（追加到 frpc.toml）</span><textarea id="n_extraToml" rows="3">${escapeHtml(n.extraToml)}</textarea></label>
  `, `<button onclick="closeModal()">取消</button>
      <button class="primary" onclick="saveNode(${id})">保存</button>`);
}

async function saveNode(id) {
  const body = {
    name: val('n_name'), remark: val('n_remark'), serverAddr: val('n_serverAddr'),
    serverPort: num('n_serverPort'), authToken: val('n_authToken') || undefined,
    protocol: val('n_protocol'), installDir: val('n_installDir'), frpcVersion: val('n_frpcVersion'),
    downloadBase: val('n_downloadBase'), user: val('n_user'), logLevel: val('n_logLevel'),
    loginFailExit: checked('n_loginFailExit'), tlsEnable: checked('n_tlsEnable'), extraToml: val('n_extraToml'),
  };
  try {
    if (id) await api(`/api/nodes/${id}`, { method: 'PUT', body });
    else await api('/api/nodes', { method: 'POST', body });
    closeModal();
    toast(id ? '节点已更新' : '节点已创建');
    await loadNodes();
    if (id) showNode(id);
  } catch (err) { globalAlert(`保存失败: ${err.message}`); }
}

async function showNode(id) {
  try {
    const n = await api(`/api/nodes/${id}`);
    currentNodeId = id;
    $('nodeDetail').classList.remove('hidden');
    $('nodeDetailTitle').textContent = `节点 #${n.id} · ${n.name}`;
    const installCmd = `${location.origin}/api/install/${n.installToken}.sh`;
    const hb = n.heartbeat;
    const liveRow = n.online === true
      ? `<div class="k">实时状态</div><div class="v"><span class="badge green">在线</span> ${hb ? `${escapeHtml(hb.hostname)} · v${escapeHtml(hb.version)} · ${escapeHtml(hb.os)}/${escapeHtml(hb.arch)} · 运行 ${hb.uptimeSec}s · 代理 ${hb.proxyRunning}/${hb.proxyTotal} · 内存 ${hb.memAllocMb}MB` : ''}</div>`
      : `<div class="k">实时状态</div><div class="v"><span class="badge">离线</span>${n.lastSeenSeconds != null ? ` 最后上报 ${n.lastSeenSeconds}s 前` : ' 未收到心跳（需使用定制版 frpc）'}</div>`;
    $('nodeDetailKv').innerHTML = `
      <div class="k">frps 地址</div><div class="v">${escapeHtml(n.effectiveServerAddr || '(未设置)')}:${n.effectiveServerPort ?? ''}${n.addrInherited ? ' <span class="badge">继承 frps 设置</span>' : ''}</div>
      ${liveRow}
      <div class="k">协议 / 密钥</div><div class="v">${escapeHtml(n.protocol)} / ${n.authToken ? '已设置' : '(继承 frps)'}</div>
      <div class="k">安装目录</div><div class="v">${escapeHtml(n.installDir)}</div>
      <div class="k">安装 token</div><div class="v">${escapeHtml(n.installToken)}</div>
      <div class="k">一键安装</div><div class="v">curl -fsSL ${escapeHtml(installCmd)} | sudo bash</div>
      <div class="k">服务名</div><div class="v">frpc-${escapeHtml(n.installToken.slice(0, 12))}</div>`;
    renderProxies(n.proxies || []);
    window.__nodesCache = (window.__nodesCache || []).filter((x) => x.id !== id).concat([n]);
  } catch (err) { globalAlert(`加载节点失败: ${err.message}`); }
}

async function removeNode(id, name) {
  if (!confirm(`删除节点「${name}」及其全部代理？此操作不可恢复。`)) return;
  try {
    await api(`/api/nodes/${id}`, { method: 'DELETE' });
    toast('节点已删除');
    if (currentNodeId === id) { currentNodeId = null; $('nodeDetail').classList.add('hidden'); }
    loadNodes();
  } catch (err) { globalAlert(`删除失败: ${err.message}`); }
}

async function regenToken(id) {
  if (!confirm('重置安装 token 后，旧的一键安装链接会立即失效。继续？')) return;
  try {
    const n = await api(`/api/nodes/${id}/token`, { method: 'POST' });
    toast(`新 token: ${n.installToken}`);
    showNode(id);
  } catch (err) { globalAlert(`重置失败: ${err.message}`); }
}

/* --------------------------------------------------------------- proxies */

function renderProxies(proxies) {
  // Cache so the edit modal can prefill from the existing row.
  window.__proxyCache = proxies;
  if (!proxies.length) {
    $('proxyList').innerHTML = '<div class="empty">还没有代理，点击「+ 添加代理」</div>';
    return;
  }
  $('proxyList').innerHTML = `
    <table><thead><tr>
      <th>名称</th><th>类型</th><th>本地地址</th><th>远端端口</th><th>域名 / 其它</th><th>状态</th><th></th>
    </tr></thead><tbody>
    ${proxies.map((p) => {
      let remote;
      if (p.type === 'stcp' || p.type === 'xtcp' || p.type === 'sudp') remote = '<span class="badge">密钥访问</span>';
      else if (p.remotePortRandom) remote = `<span class="badge amber">随机 ${p.remotePort ?? 0}</span>`;
      else remote = `<span class="badge blue">${p.remotePort ?? '-'}</span>`;
      const extra = [p.customDomains.join(', '), p.subdomain && `*.${p.subdomain}`, p.multiplexer, p.secretKey && 'sk=***']
        .filter(Boolean).join(' · ') || '-';
      return `<tr>
        <td class="mono">${escapeHtml(p.name)}</td>
        <td><span class="badge">${escapeHtml(p.type)}</span></td>
        <td class="mono">${escapeHtml(p.localIp)}:${p.localPort}</td>
        <td>${remote}</td>
        <td style="font-size:12px;color:var(--text-dim)">${escapeHtml(extra)}</td>
        <td>${p.enabled ? '<span class="badge green">启用</span>' : '<span class="badge">禁用</span>'}</td>
        <td class="actions">
          ${p.remotePortRandom ? `<button class="sm" onclick="reroll(${p.id})">换端口</button>` : ''}
          <button class="sm" onclick="openProxyModal(${p.id})">编辑</button>
          <button class="sm danger" onclick="removeProxy(${p.id})">删除</button>
        </td></tr>`;
    }).join('')}
    </tbody></table>`;
}

const NEEDS_REMOTE = ['tcp', 'udp', 'tcpmux', 'sudp'];

function openProxyModal(id = null) {
  const p = id ? (window.__proxyCache || []).find((x) => x.id === id) : null;
  const d = p || {
    name: '', type: 'tcp', localIp: '127.0.0.1', localPort: '', remotePort: null, remotePortRandom: false,
    customDomains: [], subdomain: '', locations: [], multiplexer: '', secretKey: '', useEncryption: false,
    useCompression: false, bandwidthLimit: '', proxyProtocol: '', httpUser: '', httpPassword: '',
    hostHeaderRewrite: '', enabled: true,
  };
  openModal(id ? `编辑代理 #${id}` : '添加代理', `
    <div class="grid2">
      <label class="field"><span>代理名称 *</span><input type="text" id="p_name" value="${escapeHtml(d.name)}" placeholder="例如 ssh / web01">
        <div class="hint">只能含字母数字 _ . -</div></label>
      <label class="field"><span>类型</span>
        <select id="p_type" onchange="onProxyTypeChange()">
          ${['tcp', 'udp', 'http', 'https', 'tcpmux', 'stcp', 'xtcp', 'sudp'].map((t) => `<option value="${t}" ${d.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></label>
      <label class="field"><span>本地 IP</span><input type="text" id="p_localIp" value="${escapeHtml(d.localIp)}"></label>
      <label class="field"><span>本地端口 *</span><input type="number" id="p_localPort" value="${d.localPort}"></label>
    </div>

    <div id="remoteBox">
      <label class="check"><input type="checkbox" id="p_remotePortRandom" ${d.remotePortRandom ? 'checked' : ''} onchange="onRandomToggle()">
        <span>远端端口随机分配（从 frps 的端口范围中挑选）</span></label>
      <label class="field"><span>远端端口</span>
        <div class="inline">
          <input type="number" id="p_remotePort" value="${d.remotePort ?? ''}">
          <button class="sm" onclick="pickFreePortHint()">?</button>
        </div>
        <div class="hint" id="remoteHint">留空/勾选随机则由面板从端口范围里分配一个可用端口</div>
      </label>
    </div>

    <div id="httpBox">
      <label class="field"><span>自定义域名（逗号分隔）</span><input type="text" id="p_customDomains" value="${escapeHtml(d.customDomains.join(', '))}"></label>
      <div class="grid2">
        <label class="field"><span>子域名 subdomain</span><input type="text" id="p_subdomain" value="${escapeHtml(d.subdomain)}"></label>
        <label class="field"><span>locations（逗号分隔）</span><input type="text" id="p_locations" value="${escapeHtml(d.locations.join(', '))}"></label>
        <label class="field"><span>HTTP Basic 用户</span><input type="text" id="p_httpUser" value="${escapeHtml(d.httpUser)}"></label>
        <label class="field"><span>HTTP Basic 密码</span><input type="text" id="p_httpPassword" value="${escapeHtml(d.httpPassword)}"></label>
      </div>
      <label class="field"><span>Host 头重写</span><input type="text" id="p_hostHeaderRewrite" value="${escapeHtml(d.hostHeaderRewrite)}"></label>
    </div>

    <div id="tcpmuxBox">
      <label class="field"><span>multiplexer</span>
        <select id="p_multiplexer"><option value="">(未设置)</option>
          <option value="httpconnect" ${d.multiplexer === 'httpconnect' ? 'selected' : ''}>httpconnect</option></select></label>
    </div>

    <div id="secretBox">
      <label class="field"><span>secretKey（stcp/xtcp/sudp 访问密钥）</span><input type="text" id="p_secretKey" value="${escapeHtml(d.secretKey)}"></label>
    </div>

    <div class="grid3">
      <label class="field"><span>带宽限制</span><input type="text" id="p_bandwidthLimit" value="${escapeHtml(d.bandwidthLimit)}" placeholder="如 1MB"></label>
      <label class="field"><span>proxyProtocol</span>
        <select id="p_proxyProtocol"><option value="">(未设置)</option>
          <option value="v1" ${d.proxyProtocol === 'v1' ? 'selected' : ''}>v1</option>
          <option value="v2" ${d.proxyProtocol === 'v2' ? 'selected' : ''}>v2</option></select></label>
    </div>
    <label class="check"><input type="checkbox" id="p_useEncryption" ${d.useEncryption ? 'checked' : ''}><span>加密传输 useEncryption</span></label>
    <label class="check"><input type="checkbox" id="p_useCompression" ${d.useCompression ? 'checked' : ''}><span>压缩传输 useCompression</span></label>
    <label class="check"><input type="checkbox" id="p_enabled" ${d.enabled ? 'checked' : ''}><span>启用该代理</span></label>

    <div class="preview-box">
      <div class="preview-head">
        <span>将写入 frpc.toml 的内容（实时预览）</span>
        <span id="p_previewNote" class="preview-note"></span>
      </div>
      <pre class="code" id="p_previewToml">填写上方字段后这里会实时显示生成的 [[proxies]] 段</pre>
    </div>
  `, `<button onclick="closeModal()">取消</button>
      <button class="primary" onclick="saveProxy(${id})">保存</button>`);

  // Any edit re-renders the preview so the field <-> TOML mapping is obvious.
  $('modalRoot').querySelectorAll('input, select, textarea').forEach((el) => {
    el.addEventListener('input', schedulePreview);
    el.addEventListener('change', schedulePreview);
  });
  onProxyTypeChange();
}

/** Ask the server to render the current draft so the operator sees real output. */
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshProxyPreview, 350);
}

async function refreshProxyPreview() {
  const box = $('p_previewToml');
  if (!box) return;
  const body = {
    name: val('p_name'), type: val('p_type'), localIp: val('p_localIp'), localPort: num('p_localPort'),
    remotePortRandom: checked('p_remotePortRandom'), remotePort: num('p_remotePort'),
    customDomains: val('p_customDomains'), subdomain: val('p_subdomain'), locations: val('p_locations'),
    multiplexer: val('p_multiplexer'), secretKey: val('p_secretKey'), useEncryption: checked('p_useEncryption'),
    useCompression: checked('p_useCompression'), bandwidthLimit: val('p_bandwidthLimit'),
    proxyProtocol: val('p_proxyProtocol'), httpUser: val('p_httpUser'), httpPassword: val('p_httpPassword'),
    hostHeaderRewrite: val('p_hostHeaderRewrite'), enabled: checked('p_enabled'),
  };
  try {
    const r = await api('/api/proxies/preview', { method: 'POST', body });
    box.textContent = r.toml;
    const note = $('p_previewNote');
    if (note) {
      note.textContent = r.note || '';
      note.classList.toggle('warn', Boolean(r.note && /注意|拒绝|请填写|回退/.test(r.note)));
    }
  } catch (err) {
    box.textContent = `预览失败: ${err.message}`;
  }
}

function onProxyTypeChange() {
  const t = val('p_type');
  const needsRemote = NEEDS_REMOTE.includes(t);
  $('remoteBox').classList.toggle('hidden', !needsRemote);
  $('httpBox').classList.toggle('hidden', !['http', 'https'].includes(t));
  $('tcpmuxBox').classList.toggle('hidden', t !== 'tcpmux');
  $('secretBox').classList.toggle('hidden', !['stcp', 'xtcp', 'sudp'].includes(t));
  onRandomToggle();
  schedulePreview();
}

function onRandomToggle() {
  const rand = checked('p_remotePortRandom');
  const input = $('p_remotePort');
  if (input) input.disabled = rand;
  schedulePreview();
}

async function pickFreePortHint() {
  try {
    const r = await api('/api/ports');
    $('remoteHint').textContent = `当前端口范围 ${r.ranges.map((x) => (x.start === x.end ? x.start : `${x.start}-${x.end}`)).join(', ') || '(未配置)'}；已用 ${r.used}/${r.total}，剩余 ${r.free}`;
  } catch { /* ignore */ }
}

async function saveProxy(id) {
  const body = {
    name: val('p_name'), type: val('p_type'), localIp: val('p_localIp'), localPort: num('p_localPort'),
    remotePortRandom: checked('p_remotePortRandom'), remotePort: num('p_remotePort'),
    customDomains: val('p_customDomains'), subdomain: val('p_subdomain'), locations: val('p_locations'),
    multiplexer: val('p_multiplexer'), secretKey: val('p_secretKey'), useEncryption: checked('p_useEncryption'),
    useCompression: checked('p_useCompression'), bandwidthLimit: val('p_bandwidthLimit'),
    proxyProtocol: val('p_proxyProtocol'), httpUser: val('p_httpUser'), httpPassword: val('p_httpPassword'),
    hostHeaderRewrite: val('p_hostHeaderRewrite'), enabled: checked('p_enabled'),
  };
  try {
    if (id) await api(`/api/proxies/${id}`, { method: 'PUT', body });
    else await api(`/api/nodes/${currentNodeId}/proxies`, { method: 'POST', body });
    closeModal();
    toast(id ? '代理已更新' : '代理已创建');
    showNode(currentNodeId);
  } catch (err) { globalAlert(`保存失败: ${err.message}`); }
}

async function removeProxy(id) {
  if (!confirm('删除该代理？')) return;
  try {
    await api(`/api/proxies/${id}`, { method: 'DELETE' });
    toast('代理已删除');
    showNode(currentNodeId);
  } catch (err) { globalAlert(`删除失败: ${err.message}`); }
}

async function reroll(id) {
  try {
    const p = await api(`/api/proxies/${id}/reroll`, { method: 'POST' });
    toast(`已换到端口 ${p.remotePort}`);
    showNode(currentNodeId);
  } catch (err) { globalAlert(`换端口失败: ${err.message}`); }
}

/* -------------------------------------------------------------- artifacts */

async function showInstallScript(id) {
  try {
    const res = await fetch(`/api/nodes/${id}/install-script`);
    const script = await res.text();
    const node = (window.__nodesCache || []).find((n) => n.id === id);
    const oneLiner = node ? `curl -fsSL ${location.origin}/api/install/${node.installToken}.sh | sudo bash` : '';
    openModal('frpc 一键安装脚本', `
      <div class="alert info">在目标机器上执行（需 root）：
        <div class="mono" style="margin-top:6px;user-select:all">${escapeHtml(oneLiner)}</div>
      </div>
      <pre class="code">${escapeHtml(script)}</pre>`,
      `<button onclick="closeModal()">关闭</button>
       ${copyButton(oneLiner, '复制一行命令')}
       <button class="primary" onclick="downloadScript(${id})">下载脚本</button>`);
  } catch (err) { globalAlert(`生成失败: ${err.message}`); }
}

function downloadScript(id) {
  window.location.href = `/api/nodes/${id}/install-script`;
}

/** 下载 Windows 安装包（zip，内含 frpc.exe + 管理脚本）。 */
async function downloadWindows(id) {
  try {
    // 先确认面板有 Windows 版二进制，避免下载到空/失败响应
    const st = await api(`/api/nodes/${id}/windows-status`);
    if (!st.available) {
      globalAlert('面板尚未构建 Windows 版 frpc.exe。请先在「定制构建」页构建 windows/amd64，或运行：custom-frp/build-custom-frp.sh --arches windows/amd64', 'warn');
      return;
    }
    toast('开始下载 Windows 安装包');
    window.location.href = `/api/nodes/${id}/windows-package`;
  } catch (err) {
    globalAlert(`下载失败: ${err.message}`);
  }
}

// ───────────────────────── 二进制直链托管 ─────────────────────────
/** 版本由后端下发（见 /api/system/info），避免前端硬编码与后端不一致。 */
let FRP_BASE_VERSION = '';

/** 「frps 设置 → frps 地址」，用于在节点表单里展示继承值。 */
let FRPS_ADDR = '';

/** 可托管的 Linux 资产（面板实际分发的 6 个架构）。 */
function mirrorAssets() {
  const archs = ['amd64', 'arm64', 'arm', '386', 'loong64', 'riscv64'];
  if (!FRP_BASE_VERSION) return [];
  return archs.map((a) => `frp_${FRP_BASE_VERSION}_linux_${a}.tar.gz`);
}

/** 渲染直链列表；已配置的条目在前，其余留空行可填。 */
function renderMirrorRows(mirrors) {
  const box = document.getElementById('mirrorRows');
  if (!box) return;
  const entries = Object.entries(mirrors || {});
  const rows = entries.length ? entries : [['', '']];
  box.innerHTML = rows.map(([file, url]) => mirrorRowHtml(file, url)).join('');
}

function mirrorRowHtml(file, url) {
  const assets = mirrorAssets();
  const opts = assets
    .map((a) => `<option value="${a}"${a === file ? ' selected' : ''}>${a}</option>`)
    .join('');
  return `<div class="mirror-row" style="display:flex;gap:8px;margin-bottom:8px;align-items:flex-start">
    <select class="mirror-file" style="flex:0 0 250px" onchange="syncMirrorFile(this)">
      <option value="">— 选择文件 —</option>${opts}
      ${file && !assets.includes(file) ? `<option value="${escapeHtml(file)}" selected>${escapeHtml(file)}</option>` : ''}
    </select>
    <input type="text" class="mirror-url" style="flex:1;min-width:220px"
           placeholder="http://host:23613/d/path/frp_xxx.tar.gz?sign=xxx:0"
           value="${escapeHtml(url)}">
    <button class="sm danger" type="button" onclick="this.closest('.mirror-row').remove()">删除</button>
  </div>`;
}

function addMirrorRow() {
  const box = document.getElementById('mirrorRows');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', mirrorRowHtml('', ''));
}

/** 一键填入 6 个架构的文件名（地址留空待填）。 */
function fillMirrorTemplate() {
  const box = document.getElementById('mirrorRows');
  if (!box) return;
  const filled = collectMirrorRows();
  const assets = mirrorAssets();
  if (!assets.length) {
    toast('尚未获取到 frp 版本，请刷新页面重试');
    return;
  }
  box.innerHTML = assets.map((a) => mirrorRowHtml(a, filled[a] || '')).join('');
  toast('已列出 6 个架构，逐个粘贴直链即可');
}

function syncMirrorFile(sel) {
  // 占位：选择即生效，无需额外处理
}

/** 收集表单里的直链映射，忽略未填地址的行。 */
function collectMirrorRows() {
  const out = {};
  document.querySelectorAll('#mirrorRows .mirror-row').forEach((row) => {
    const file = row.querySelector('.mirror-file')?.value?.trim() ?? '';
    const url = row.querySelector('.mirror-url')?.value?.trim() ?? '';
    if (file && url) out[file] = url;
  });
  return out;
}

async function showFrpcToml(id) {
  try {
    const res = await fetch(`/api/nodes/${id}/frpc.toml`);
    const toml = await res.text();
    openModal('frpc.toml', `<pre class="code">${escapeHtml(toml)}</pre>`,
      `<button onclick="closeModal()">关闭</button>
       ${copyButton(toml)}`);
  } catch (err) { globalAlert(`加载失败: ${err.message}`); }
}

/* --------------------------------------------------------------- clipboard */

/**
 * Text destined for a `copyText(...)` inline handler is kept here rather than
 * interpolated into the HTML: JSON.stringify would emit double quotes and break
 * the enclosing attribute.
 */
const copyRegistry = new Map();
let copySeq = 0;

function registerCopy(text) {
  const key = `c${++copySeq}`;
  copyRegistry.set(key, text);
  return key;
}

function copyRegistered(key) {
  copyText(copyRegistry.get(key) ?? '');
}

function copyButton(text, label = '复制') {
  return `<button onclick="copyRegistered('${registerCopy(text)}')">${escapeHtml(label)}</button>`;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('已复制到剪贴板'),
    () => toast('复制失败，请手动选择', 'err'),
  );
}

/* ------------------------------------------------------------------ modal */

function openModal(title, bodyHtml, actionsHtml) {
  $('modalRoot').innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h2>${escapeHtml(title)}</h2>
        ${bodyHtml}
        <div class="modal-actions">${actionsHtml || '<button onclick="closeModal()">关闭</button>'}</div>
      </div>
    </div>`;
}

function closeModal() {
  $('modalRoot').innerHTML = '';
  copyRegistry.clear();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });


/* ------------------------------------------------------------ custom build */

let buildPollTimer = null;

async function loadBuildStatus() {
  try {
    const st = await api('/api/custom-build/status');
    const go = st.goToolchain;
    $('buildEnvKv').innerHTML = `
      <div class="k">构建脚本</div><div class="v">${st.scriptPresent ? '已就绪' : '缺失'} <span style="color:var(--text-dim)">${escapeHtml(st.scriptPath)}</span></div>
      <div class="k">Go 工具链</div><div class="v">${go.present ? escapeHtml(go.version || '已安装') : '未安装（构建时自动下载）'}</div>
      <div class="k">产物目录</div><div class="v">${escapeHtml(st.outDir)}</div>
      <div class="k">构建状态</div><div class="v">${st.running ? '<span class="badge amber">进行中</span>' : '<span class="badge">空闲</span>'}</div>`;

    const fmt = (b) => b.present
      ? `${(b.sizeBytes / 1024 / 1024).toFixed(1)} MB · ${new Date(b.builtAt).toLocaleString()}`
      : '未构建';
    $('buildBinKv').innerHTML = `
      <div class="k">frps</div><div class="v">${fmt(st.binaries.frps)}</div>
      <div class="k">frpc</div><div class="v">${fmt(st.binaries.frpc)}</div>`;

    $('buildFeatures').innerHTML = st.customFeatures.length
      ? st.customFeatures.map((f) => `<span class="badge green" style="margin:0 6px 6px 0">${escapeHtml(f)}</span>`).join('')
      : '<span class="badge">未检测到定制功能（尚未构建或为原版）</span>';

    if (st.lastBuildLogTail) $('buildLog').textContent = st.lastBuildLogTail;
    if (st.running) startBuildPolling();
  } catch (err) {
    globalAlert(`读取构建状态失败: ${err.message}`);
  }
}

function startBuildPolling() {
  if (buildPollTimer) return;
  buildPollTimer = setInterval(async () => {
    try {
      const [log, st] = await Promise.all([api('/api/custom-build/log'), api('/api/custom-build/status')]);
      const box = $('buildLog');
      if (box) {
        box.textContent = log.log || '(暂无输出)';
        box.scrollTop = box.scrollHeight;
      }
      if (!st.running) {
        clearInterval(buildPollTimer);
        buildPollTimer = null;
        toast('构建结束');
        loadBuildStatus();
      }
    } catch { /* keep polling */ }
  }, 2000);
}

async function startBuild() {
  const version = val('buildVersion') || '0.71.0';
  if (!confirm(`开始从源码构建 frp v${version}？\n首次构建会下载 Go 工具链与源码，耗时 1-3 分钟。`)) return;
  try {
    await api('/api/custom-build/start', { method: 'POST', body: { version } });
    toast('构建已启动');
    startBuildPolling();
  } catch (err) {
    globalAlert(`启动构建失败: ${err.message}`);
  }
}

async function installBuilt() {
  try {
    const r = await api('/api/custom-build/install', { method: 'POST', body: {} });
    const msg = r.installed.length ? `已安装: ${r.installed.join(', ')}` : '没有可安装的产物';
    if (r.warnings.length) globalAlert(`${msg}\n${r.warnings.join('\n')}`, 'warn');
    else toast(msg);
    loadBuildStatus();
  } catch (err) {
    globalAlert(`安装失败: ${err.message}`);
  }
}

/* ------------------------------------------------------------------- boot */

function bootApp() {
  // 提前取回 frps 对外地址：用户可能直接进「节点管理」，
  // 若不预取，节点表单里的「当前继承值」会显示成 (未设置)。
  api('/api/system/info')
    .then((info) => { FRPS_ADDR = info?.frp?.frpsAddr || ''; })
    .catch(() => { /* non-fatal */ });
  api('/api/nodes')
    .then((nodes) => {
      window.__nodesCache = nodes;
      $('navNodeCount').textContent = nodes.length;
    })
    .catch(() => { /* handled by api() */ });
  loadDashboard();
}

async function boot() {
  $('loginForm').addEventListener('submit', doLogin);
  try {
    const me = await api('/api/auth/me');
    if (me.authenticated) {
      hideLogin();
      bootApp();
      return;
    }
  } catch { /* fall through to the login screen */ }
  showLogin();
}

boot();
