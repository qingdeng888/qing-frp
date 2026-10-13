// Code generated for frp-console. DO NOT EDIT upstream.
// frp-console-target: cmd/frpc/sub/diag.go
//
// Copyright 2026 frp-console contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package sub

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sort"
	"time"

	"github.com/spf13/cobra"

	"github.com/fatedier/frp/pkg/config"
	clientsdk "github.com/fatedier/frp/pkg/sdk/client"
	"github.com/fatedier/frp/pkg/util/version"
)

// diagTimeout bounds every network probe so the command never hangs.
var diagTimeout = 8 * time.Second

// diagProxyStatus mirrors one entry of the frpc admin API /api/status response.
type diagProxyStatus struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Status     string `json:"status"`
	Err        string `json:"err"`
	LocalAddr  string `json:"local_addr"`
	RemoteAddr string `json:"remote_addr"`
}

// diagResult is the machine-readable report, also used for the JSON output mode.
type diagResult struct {
	Version    string            `json:"version"`
	ConfigFile string            `json:"config_file"`
	Server     diagServerResult  `json:"server"`
	AdminAPI   diagAdminResult   `json:"admin_api"`
	LocalPorts []diagLocalResult `json:"local_ports"`
	Proxies    []diagProxyStatus `json:"proxies"`
	Problems   []string          `json:"problems"`
	OK         bool              `json:"ok"`
}

type diagServerResult struct {
	Addr      string `json:"addr"`
	Reachable bool   `json:"reachable"`
	Detail    string `json:"detail"`
	LatencyMS int64  `json:"latency_ms"`
}

type diagAdminResult struct {
	Addr      string `json:"addr"`
	Reachable bool   `json:"reachable"`
	Detail    string `json:"detail"`
}

type diagLocalResult struct {
	Proxy     string `json:"proxy"`
	Type      string `json:"type"`
	LocalAddr string `json:"local_addr"`
	Reachable bool   `json:"reachable"`
	Detail    string `json:"detail"`
}

func init() {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "diag",
		Short: "Run connectivity diagnostics (server / local service / proxy status)",
		Long: `Run connectivity diagnostics for this frpc instance.

It checks, in order:
  1. whether the configured frps address is reachable
  2. whether the local admin API is up
  3. whether each proxy's local service port accepts a connection
  4. each proxy's reported status from the admin API

Exit code is 0 when no problems are found, 1 otherwise, which makes it
suitable for scripts and health checks.`,
		Run: func(cmd *cobra.Command, args []string) {
			loaded, err := config.LoadClientConfigResult(cfgFile, strictConfigMode)
			if err != nil {
				fmt.Println("failed to load config:", err)
				os.Exit(1)
			}
			result := RunDiagnostics(loaded, cfgFile)
			if jsonOut {
				enc := json.NewEncoder(os.Stdout)
				enc.SetIndent("", "  ")
				_ = enc.Encode(result)
			} else {
				printDiagReport(result)
			}
			if !result.OK {
				os.Exit(1)
			}
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "output the report as JSON")
	rootCmd.AddCommand(cmd)
}

// RunDiagnostics performs every probe and returns the aggregated report.
func RunDiagnostics(loaded *config.ClientConfigLoadResult, configFile string) diagResult {
	cfg := loaded.Common
	res := diagResult{
		Version:    version.Full(),
		ConfigFile: configFile,
		Problems:   []string{},
		OK:         true,
	}

	// 1. frps reachability.
	serverAddr := net.JoinHostPort(cfg.ServerAddr, fmt.Sprintf("%d", cfg.ServerPort))
	res.Server.Addr = serverAddr
	start := time.Now()
	conn, err := net.DialTimeout("tcp", serverAddr, diagTimeout)
	res.Server.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		res.Server.Detail = err.Error()
		res.Problems = append(res.Problems,
			fmt.Sprintf("无法连接 frps %s：%v（检查地址/端口/防火墙）", serverAddr, err))
	} else {
		res.Server.Reachable = true
		res.Server.Detail = "connection accepted"
		_ = conn.Close()
	}

	// 2. Local admin API.
	if cfg.WebServer.Port > 0 {
		adminAddr := net.JoinHostPort(cfg.WebServer.Addr, fmt.Sprintf("%d", cfg.WebServer.Port))
		if adminAddr == fmt.Sprintf(":%d", cfg.WebServer.Port) {
			adminAddr = net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", cfg.WebServer.Port))
		}
		res.AdminAPI.Addr = adminAddr
		c, err := net.DialTimeout("tcp", adminAddr, diagTimeout)
		if err != nil {
			res.AdminAPI.Detail = err.Error()
			// Not fatal: the admin API is optional.
			res.Problems = append(res.Problems,
				fmt.Sprintf("本地管理 API %s 不可达：%v（webServer 未启用或不监听该地址）", adminAddr, err))
		} else {
			res.AdminAPI.Reachable = true
			res.AdminAPI.Detail = "connection accepted"
			_ = c.Close()
		}
	} else {
		res.AdminAPI.Detail = "webServer not configured"
	}

	// 3. Local service ports for each configured proxy.
	type localTarget struct {
		proxy string
		ptype string
		addr  string
	}
	var targets []localTarget
	for _, p := range loaded.Proxies {
		base := p.GetBaseConfig()
		// Only tcp-ish proxies have a dialable local address.
		if base.LocalPort == 0 {
			continue
		}
		ip := base.LocalIP
		if ip == "" {
			ip = "127.0.0.1"
		}
		targets = append(targets, localTarget{
			proxy: base.Name,
			ptype: base.Type,
			addr:  net.JoinHostPort(ip, fmt.Sprintf("%d", base.LocalPort)),
		})
	}

	for _, t := range targets {
		entry := diagLocalResult{Proxy: t.proxy, Type: t.ptype, LocalAddr: t.addr}
		// A UDP proxy still uses a TCP-style probe here only when it is tcp.
		if t.ptype == "udp" || t.ptype == "sudp" {
			entry.Reachable = true
			entry.Detail = "skipped (udp)"
			res.LocalPorts = append(res.LocalPorts, entry)
			continue
		}
		c, err := net.DialTimeout("tcp", t.addr, diagTimeout)
		if err != nil {
			entry.Detail = err.Error()
			res.Problems = append(res.Problems,
				fmt.Sprintf("代理 [%s] 的本地服务 %s 无法连接：%v（本地服务未启动？）", t.proxy, t.addr, err))
		} else {
			entry.Reachable = true
			entry.Detail = "connection accepted"
			_ = c.Close()
		}
		res.LocalPorts = append(res.LocalPorts, entry)
	}

	// 4. Proxy status via the admin API, when available.
	if res.AdminAPI.Reachable {
		sdkClient := clientsdk.New(cfg.WebServer.Addr, cfg.WebServer.Port)
		sdkClient.SetAuth(cfg.WebServer.User, cfg.WebServer.Password)
		ctx, cancel := context.WithTimeout(context.Background(), diagTimeout)
		statuses, err := sdkClient.GetAllProxyStatus(ctx)
		cancel()
		if err != nil {
			res.Problems = append(res.Problems, fmt.Sprintf("读取代理状态失败：%v", err))
		} else {
			for _, list := range statuses {
				for _, ps := range list {
					res.Proxies = append(res.Proxies, diagProxyStatus{
						Name:       ps.Name,
						Type:       ps.Type,
						Status:     ps.Status,
						Err:        ps.Err,
						LocalAddr:  ps.LocalAddr,
						RemoteAddr: ps.RemoteAddr,
					})
					if ps.Err != "" {
						res.Problems = append(res.Problems,
							fmt.Sprintf("代理 [%s] 状态异常：%s", ps.Name, ps.Err))
					}
				}
			}
		}
	}

	if len(res.Problems) > 0 {
		res.OK = false
	}
	return res
}

// printDiagReport renders a human-friendly report.
func printDiagReport(r diagResult) {
	fmt.Printf("frpc 诊断报告 (client v%s)\n", r.Version)
	fmt.Printf("配置文件: %s\n\n", r.ConfigFile)

	mark := func(ok bool) string {
		if ok {
			return "\u2713"
		}
		return "\u2717"
	}

	serverLine := fmt.Sprintf("%s frps 连通性  %s", mark(r.Server.Reachable), r.Server.Addr)
	if r.Server.Reachable {
		serverLine += fmt.Sprintf("  (%dms)", r.Server.LatencyMS)
	}
	fmt.Println(serverLine)
	if !r.Server.Reachable {
		fmt.Printf("    %s\n", r.Server.Detail)
	}

	fmt.Printf("%s 本地管理 API  %s", mark(r.AdminAPI.Reachable), r.AdminAPI.Addr)
	if !r.AdminAPI.Reachable && r.AdminAPI.Detail != "" {
		fmt.Printf("  (%s)", r.AdminAPI.Detail)
	}
	fmt.Println()

	if len(r.LocalPorts) > 0 {
		fmt.Println("\n本地服务探测:")
		for _, l := range r.LocalPorts {
			fmt.Printf("  %s [%s] %s", mark(l.Reachable), l.Proxy, l.LocalAddr)
			if !l.Reachable {
				fmt.Printf("  -> %s", l.Detail)
			}
			fmt.Println()
		}
	}

	if len(r.Proxies) > 0 {
		fmt.Println("\n代理状态:")
		sort.Slice(r.Proxies, func(i, j int) bool { return r.Proxies[i].Name < r.Proxies[j].Name })
		for _, p := range r.Proxies {
			status := p.Status
			if p.Err != "" {
				status = "error: " + p.Err
			}
			fmt.Printf("  %-10s %-10s %s", p.Name, p.Type, status)
			if p.RemoteAddr != "" {
				fmt.Printf("  remote=%s", p.RemoteAddr)
			}
			fmt.Println()
		}
	}

	fmt.Println()
	if r.OK {
		fmt.Println("结果: 全部正常")
		return
	}
	fmt.Printf("结果: 发现 %d 个问题\n", len(r.Problems))
	for _, p := range r.Problems {
		fmt.Printf("  - %s\n", p)
	}
}
