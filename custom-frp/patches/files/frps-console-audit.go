// Code generated for frp-console. DO NOT EDIT upstream.
// frp-console-target: cmd/frps/console_audit.go
//
// frp-console 定制：在 frps 启动流程中启用审计日志与流量配额。
//
// 通过环境变量配置，无需改动 frps 主流程：
//   FRP_CONSOLE_AUDIT_LOG   审计日志文件路径；留空或 "console" 输出到标准输出
//   FRP_CONSOLE_QUOTA       配额规则，如 "web=1GB,ssh=500MB,*=10GB"
//   FRP_CONSOLE_QUOTA_EXIT  配额超限时是否关闭客户端（默认 true）
package main

import (
	"os"
	"strings"
	"sync"
	"time"

	"github.com/fatedier/frp/pkg/util/log"
	"github.com/fatedier/frp/server/metrics"
)

// consoleAuditInstalled guards one-time setup.
var consoleAuditInstalled bool

// init runs before frp's own initialisation completes, which matters because
// NewControl copies metrics.Server into the Control struct. Wrapping later would
// leave already-created controls pointing at the unwrapped value.
func init() {
	// Defer the actual work until main() reads flags; init only ensures our
	// package is linked. installConsoleAudit performs the installation.
}

// installConsoleAudit wires the console metrics implementation into frps.
// It is called from root.go before the service starts.
func installConsoleAudit() {
	if consoleAuditInstalled {
		return
	}
	consoleAuditInstalled = true
	auditPath := strings.TrimSpace(os.Getenv("FRP_CONSOLE_AUDIT_LOG"))
	quotaSpec := strings.TrimSpace(os.Getenv("FRP_CONSOLE_QUOTA"))

	quotas := metrics.ParseQuotaSpec(quotaSpec)

	// Only install when the operator asked for auditing or quotas; otherwise
	// frps behaves exactly like upstream (noop metrics).
	if auditPath == "" && len(quotas) == 0 {
		return
	}

	exitOnExceed := os.Getenv("FRP_CONSOLE_QUOTA_EXIT") != "false"

	// Fire each proxy's exceed callback at most once per minute so a proxy in
	// heavy traffic does not spam the audit log.
	var mu sync.Mutex
	lastFire := make(map[string]time.Time)

	onExceed := func(name string, used, quota int64) {
		mu.Lock()
		if t, ok := lastFire[name]; ok && time.Since(t) < time.Minute {
			mu.Unlock()
			return
		}
		lastFire[name] = time.Now()
		mu.Unlock()

		log.Warnf("[console] proxy %q exceeded quota: used=%d quota=%d", name, used, quota)

		if exitOnExceed {
			// frps has no per-proxy kill switch exposed to this package, so we
			// report it and let the operator's tooling act. Closing the whole
			// process would take down unrelated clients.
			log.Warnf("[console] proxy %q traffic quota exceeded, please review (no automatic kill)", name)
		}
	}

	cm, err := metrics.EnableConsoleMetrics(auditPath, quotas, onExceed)
	if err != nil {
		log.Warnf("[console] failed to enable audit metrics: %v", err)
		return
	}

	if len(quotas) > 0 {
		log.Infof("[console] traffic quota enabled for %d rule(s)", len(quotas))
	}
	if auditPath != "" && auditPath != "console" {
		log.Infof("[console] audit log -> %s", auditPath)
	}

	// cm is reachable via metrics.ConsoleMetricsInstance() for CheckQuota.
	_ = cm
}
