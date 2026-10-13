// Code generated for frp-console. DO NOT EDIT upstream.
// frp-console-target: cmd/frpc/sub/console_heartbeat.go
//
// frp-console 定制：frpc 定期把自身状态上报给面板。
//
// 这样面板无需 SSH 即可看到节点在线、代理状态与负载。配置通过环境变量注入，
// 由一键安装脚本写入 systemd unit：
//   FRP_CONSOLE_PANEL_URL    面板地址，如 http://1.2.3.4:34567
//   FRP_CONSOLE_INSTALL_TOKEN 该节点的安装 token（面板据此识别节点）
//   FRP_CONSOLE_HEARTBEAT_INTERVAL 上报间隔秒数，默认 30
//
// 上报失败不影响 frpc 运行；网络恢复后自动继续。
package sub

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fatedier/frp/pkg/util/log"
	"github.com/fatedier/frp/pkg/util/version"
)

// HeartbeatPayload is what frpc sends to the panel.
type HeartbeatPayload struct {
	Token     string            `json:"token"`
	Hostname  string            `json:"hostname"`
	Version   string            `json:"version"`
	OS        string            `json:"os"`
	Arch      string            `json:"arch"`
	Timestamp int64             `json:"timestamp"`
	UptimeSec int64             `json:"uptime_sec"`
	Proxies   []HeartbeatProxy  `json:"proxies"`
	Load      HeartbeatLoad     `json:"load"`
}

// HeartbeatProxy mirrors the frpc admin status for one proxy.
type HeartbeatProxy struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Status string `json:"status"`
	Err    string `json:"err,omitempty"`
}

// HeartbeatLoad carries lightweight host metrics.
type HeartbeatLoad struct {
	NumGoroutine int    `json:"num_goroutine"`
	MemAllocMB   uint64 `json:"mem_alloc_mb"`
}

var (
	hbStartTime = time.Now()
	hbOnce      sync.Once
)

// startConsoleHeartbeat launches the reporter when the panel URL and token are
// configured. It is a no-op otherwise, keeping upstream behaviour intact.
func startConsoleHeartbeat(statusFn func() map[string][]proxyStatusLite) {
	panelURL := strings.TrimRight(strings.TrimSpace(os.Getenv("FRP_CONSOLE_PANEL_URL")), "/")
	token := strings.TrimSpace(os.Getenv("FRP_CONSOLE_INSTALL_TOKEN"))
	if panelURL == "" || token == "" {
		return
	}

	interval := 30
	if v := strings.TrimSpace(os.Getenv("FRP_CONSOLE_HEARTBEAT_INTERVAL")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 5 {
			interval = n
		}
	}

	hbOnce.Do(func() {
		log.Infof("[console] heartbeat enabled -> %s every %ds", panelURL+"/api/heartbeat", interval)
		go heartbeatLoop(panelURL, token, time.Duration(interval)*time.Second, statusFn)
	})
}

type proxyStatusLite struct {
	Name   string
	Type   string
	Status string
	Err    string
}

func heartbeatLoop(panelURL, token string, interval time.Duration, statusFn func() map[string][]proxyStatusLite) {
	client := &http.Client{Timeout: 10 * time.Second}
	hostname, _ := os.Hostname()

	send := func() {
		payload := HeartbeatPayload{
			Token:     token,
			Hostname:  hostname,
			Version:   version.Full(),
			OS:        runtime.GOOS,
			Arch:      runtime.GOARCH,
			Timestamp: time.Now().Unix(),
			UptimeSec: int64(time.Since(hbStartTime).Seconds()),
			Load: HeartbeatLoad{
				NumGoroutine: runtime.NumGoroutine(),
				MemAllocMB:   currentMemMB(),
			},
		}
		if statusFn != nil {
			for _, list := range statusFn() {
				for _, s := range list {
					payload.Proxies = append(payload.Proxies, HeartbeatProxy{
						Name: s.Name, Type: s.Type, Status: s.Status, Err: s.Err,
					})
				}
			}
		}

		body, err := json.Marshal(payload)
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, panelURL+"/api/heartbeat", bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			log.Debugf("[console] heartbeat failed: %v", err)
			return
		}
		_ = resp.Body.Close()
		if resp.StatusCode >= 300 {
			log.Debugf("[console] heartbeat rejected: HTTP %d", resp.StatusCode)
		}
	}

	// Send one immediately so the panel sees the node without waiting.
	send()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		send()
	}
}

// currentMemMB reports the process heap size in MiB, read without importing
// runtime/metrics to keep this patch dependency-free.
func currentMemMB() uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.Alloc / 1024 / 1024
}
