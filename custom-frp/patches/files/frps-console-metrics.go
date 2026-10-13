// Code generated for frp-console. DO NOT EDIT upstream.
// frp-console-target: server/metrics/console.go
//
// frp-console 定制：服务端审计日志 + 客户端流量配额。
//
// 通过实现 metrics.ServerMetrics 接口并注册为全局实现，在不修改 frp 核心
// 逻辑的前提下，拿到每个代理的流量与连接事件。配额超限时通过回调通知
// frps 关闭对应客户端。
package metrics

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// AuditEvent is one structured audit line.
type AuditEvent struct {
	Time      string `json:"time"`
	Event     string `json:"event"`
	Name      string `json:"name,omitempty"`
	Type      string `json:"type,omitempty"`
	User      string `json:"user,omitempty"`
	ClientID  string `json:"client_id,omitempty"`
	Bytes     int64  `json:"bytes,omitempty"`
	TotalIn   int64  `json:"total_in,omitempty"`
	TotalOut  int64  `json:"total_out,omitempty"`
	QuotaByte int64  `json:"quota_bytes,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// ProxyUsage tracks per-proxy counters.
type ProxyUsage struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	User      string `json:"user"`
	ClientID  string `json:"client_id"`
	TrafficIn int64  `json:"traffic_in"`
	TrafficOut int64 `json:"traffic_out"`
	CurConns  int64  `json:"cur_conns"`
	Conns     int64  `json:"conns_total"`
}

// ConsoleMetrics implements ServerMetrics with auditing and quota enforcement.
type ConsoleMetrics struct {
	mu       sync.Mutex
	proxies  map[string]*ProxyUsage
	clients  int64
	file     *os.File
	quota    *QuotaConfig
	onExceed func(name string, used int64, quota int64)
}

// QuotaConfig holds the resolved quota rules for this process.
type QuotaConfig struct {
	rules []quotaRule
}

// quotaRule is one proxy budget rule.
type quotaRule struct {
	Name   string
	Bytes  int64
	Period string
}

var (
	consoleOnce    sync.Once
	consoleMetrics *ConsoleMetrics
)

// QuotaSpec is the raw, user-supplied quota rule list.
type QuotaSpec struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	Period string `json:"period"`
}

// RegisterOnce installs m as an *additional* metrics sink.
//
// frp's metrics.Register uses sync.Once and the aggregate package claims that
// slot in its own init(), so replacing Server is not possible. Instead we keep a
// separate list of extra sinks and fan out to them from a thin wrapper that is
// installed the same way aggregate does it.
var (
	extraSinks   []ServerMetrics
	extraSinksMu sync.RWMutex
)

// RegisterOnce appends a sink that will receive every metrics callback in
// addition to whatever Server already points at.
func RegisterOnce(m ServerMetrics) {
	if m == nil {
		return
	}
	extraSinksMu.Lock()
	extraSinks = append(extraSinks, m)
	extraSinksMu.Unlock()

	// Wrap the current Server so existing behaviour is preserved and our sink
	// also receives events. Only wrap once.
	wrapOnce.Do(func() {
		Server = &fanoutMetrics{primary: Server}
	})
}

var wrapOnce sync.Once

// fanoutMetrics forwards every call to the previously installed implementation
// (if any) and then to all extra sinks.
type fanoutMetrics struct {
	primary ServerMetrics
}

func (f *fanoutMetrics) each(fn func(ServerMetrics)) {
	if f.primary != nil {
		fn(f.primary)
	}
	extraSinksMu.RLock()
	sinks := append([]ServerMetrics(nil), extraSinks...)
	extraSinksMu.RUnlock()
	for _, s := range sinks {
		fn(s)
	}
}

func (f *fanoutMetrics) NewClient() { f.each(func(s ServerMetrics) { s.NewClient() }) }
func (f *fanoutMetrics) CloseClient() { f.each(func(s ServerMetrics) { s.CloseClient() }) }
func (f *fanoutMetrics) NewProxy(name, t, u, c string) {
	f.each(func(s ServerMetrics) { s.NewProxy(name, t, u, c) })
}
func (f *fanoutMetrics) CloseProxy(name, t string) {
	f.each(func(s ServerMetrics) { s.CloseProxy(name, t) })
}
func (f *fanoutMetrics) OpenConnection(name, t string) {
	f.each(func(s ServerMetrics) { s.OpenConnection(name, t) })
}
func (f *fanoutMetrics) CloseConnection(name, t string) {
	f.each(func(s ServerMetrics) { s.CloseConnection(name, t) })
}
func (f *fanoutMetrics) AddTrafficIn(name, t string, n int64) {
	f.each(func(s ServerMetrics) { s.AddTrafficIn(name, t, n) })
}
func (f *fanoutMetrics) AddTrafficOut(name, t string, n int64) {
	f.each(func(s ServerMetrics) { s.AddTrafficOut(name, t, n) })
}

// EnableConsoleMetrics installs the auditing/quota metrics implementation.
//
// auditPath may be empty to disable file logging. quotas may be nil.
// onExceed is called once per proxy when its quota is first exceeded.
//
// NOTE: frp's aggregate metrics package registers itself in its own init(), so
// calling Register() here would be a no-op. The aggregate layer supports fanning
// out to several implementations, so we attach ourselves to it instead.
func EnableConsoleMetrics(auditPath string, quotas []QuotaSpec, onExceed func(name string, used, quota int64)) (*ConsoleMetrics, error) {
	var err error
	consoleOnce.Do(func() {
		cm := &ConsoleMetrics{
			proxies:  make(map[string]*ProxyUsage),
			quota:    &QuotaConfig{},
			onExceed: onExceed,
		}
		if auditPath != "" && auditPath != "console" {
			cm.file, err = os.OpenFile(auditPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
			if err != nil {
				return
			}
		}
		cm.setQuotas(quotas)
		RegisterOnce(cm)
		consoleMetrics = cm
	})
	return consoleMetrics, err
}

// ConsoleMetricsInstance returns the installed instance, or nil.
func ConsoleMetricsInstance() *ConsoleMetrics { return consoleMetrics }

func (c *ConsoleMetrics) setQuotas(specs []QuotaSpec) {
	for _, s := range specs {
		if s.Name == "" || s.Bytes <= 0 {
			continue
		}
		if s.Period == "" {
			s.Period = "total"
		}
		c.quota.rules = append(c.quota.rules, quotaRule{Name: s.Name, Bytes: s.Bytes, Period: s.Period})
	}
	sort.Slice(c.quota.rules, func(i, j int) bool { return c.quota.rules[i].Name < c.quota.rules[j].Name })
}

func (c *ConsoleMetrics) emit(ev AuditEvent) {
	ev.Time = time.Now().Format(time.RFC3339)
	line, err := json.Marshal(ev)
	if err != nil {
		return
	}
	if c.file != nil {
		_, _ = c.file.Write(append(line, '\n'))
		return
	}
	fmt.Fprintf(os.Stdout, "[audit] %s\n", line)
}

/* ------------------------------ interface ------------------------------ */

func (c *ConsoleMetrics) NewClient() {
	c.mu.Lock()
	c.clients++
	n := c.clients
	c.mu.Unlock()
	c.emit(AuditEvent{Event: "client_online", Detail: fmt.Sprintf("clients=%d", n)})
}

func (c *ConsoleMetrics) CloseClient() {
	c.mu.Lock()
	c.clients--
	n := c.clients
	c.mu.Unlock()
	c.emit(AuditEvent{Event: "client_offline", Detail: fmt.Sprintf("clients=%d", n)})
}

func (c *ConsoleMetrics) NewProxy(name, proxyType, user, clientID string) {
	c.mu.Lock()
	p := c.proxies[name]
	if p == nil {
		p = &ProxyUsage{Name: name}
		c.proxies[name] = p
	}
	p.Type, p.User, p.ClientID = proxyType, user, clientID
	c.mu.Unlock()
	c.emit(AuditEvent{Event: "proxy_created", Name: name, Type: proxyType, User: user, ClientID: clientID})
}

func (c *ConsoleMetrics) CloseProxy(name, proxyType string) {
	c.mu.Lock()
	delete(c.proxies, name)
	c.mu.Unlock()
	c.emit(AuditEvent{Event: "proxy_closed", Name: name, Type: proxyType})
}

func (c *ConsoleMetrics) OpenConnection(name, proxyType string) {
	c.mu.Lock()
	if p := c.proxies[name]; p != nil {
		p.CurConns++
		p.Conns++
	}
	c.mu.Unlock()
}

func (c *ConsoleMetrics) CloseConnection(name, proxyType string) {
	c.mu.Lock()
	if p := c.proxies[name]; p != nil && p.CurConns > 0 {
		p.CurConns--
	}
	c.mu.Unlock()
}

func (c *ConsoleMetrics) AddTrafficIn(name, proxyType string, n int64) {
	c.addTraffic(name, proxyType, n, true)
}

func (c *ConsoleMetrics) AddTrafficOut(name, proxyType string, n int64) {
	c.addTraffic(name, proxyType, n, false)
}

func (c *ConsoleMetrics) addTraffic(name, proxyType string, n int64, inbound bool) {
	c.mu.Lock()
	p := c.proxies[name]
	if p == nil {
		p = &ProxyUsage{Name: name, Type: proxyType}
		c.proxies[name] = p
	}
	if inbound {
		p.TrafficIn += n
	} else {
		p.TrafficOut += n
	}
	total := p.TrafficIn + p.TrafficOut
	quota := c.quotaForLocked(name)
	exceeded := quota > 0 && total >= quota
	c.mu.Unlock()

	if exceeded && c.onExceed != nil {
		c.onExceed(name, total, quota)
	}
}

// quotaForLocked returns the byte budget for a proxy (caller holds the lock).
func (c *ConsoleMetrics) quotaForLocked(name string) int64 {
	var specific, wildcard int64
	for _, r := range c.quota.rules {
		if r.Name == name {
			specific = r.Bytes
		} else if r.Name == "*" {
			wildcard = r.Bytes
		}
	}
	if specific > 0 {
		return specific
	}
	return wildcard
}

// Snapshot returns a copy of usage for reporting.
func (c *ConsoleMetrics) Snapshot() []ProxyUsage {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]ProxyUsage, 0, len(c.proxies))
	for _, p := range c.proxies {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ClientCount returns the number of connected clients.
func (c *ConsoleMetrics) ClientCount() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.clients
}

// CheckQuota returns an error when the named proxy has exhausted its quota.
// Safe to call concurrently and when no quota is configured.
func (c *ConsoleMetrics) CheckQuota(name string) error {
	c.mu.Lock()
	p := c.proxies[name]
	quota := c.quotaForLocked(name)
	var used int64
	if p != nil {
		used = p.TrafficIn + p.TrafficOut
	}
	c.mu.Unlock()

	if quota <= 0 {
		return nil
	}
	if used >= quota {
		c.emit(AuditEvent{
			Event:     "quota_rejected",
			Name:      name,
			TotalIn:   used,
			QuotaByte: quota,
			Detail:    "proxy creation refused: traffic quota exhausted",
		})
		return fmt.Errorf("traffic quota exhausted (%d/%d bytes)", used, quota)
	}
	return nil
}

// ParseQuotaSpec parses "name=1GB,name2=500MB" or "*=10GB" style rules.
func ParseQuotaSpec(s string) []QuotaSpec {
	var out []QuotaSpec
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		eq := strings.LastIndex(part, "=")
		if eq <= 0 {
			continue
		}
		name := strings.TrimSpace(part[:eq])
		size := strings.TrimSpace(part[eq+1:])
		bytes, err := ParseBytes(size)
		if err != nil || bytes <= 0 {
			continue
		}
		out = append(out, QuotaSpec{Name: name, Bytes: bytes, Period: "total"})
	}
	return out
}

// ParseBytes understands B/KB/MB/GB/TB (base 1000) and KiB/MiB/GiB (base 1024).
func ParseBytes(s string) (int64, error) {
	s = strings.TrimSpace(strings.ToUpper(s))
	if s == "" {
		return 0, fmt.Errorf("empty size")
	}
	mult := int64(1)
	units := []struct {
		suffix string
		mult   int64
	}{
		{"TIB", 1 << 40}, {"GIB", 1 << 30}, {"MIB", 1 << 20}, {"KIB", 1 << 10},
		{"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"KB", 1e3}, {"B", 1},
	}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			mult = u.mult
			s = strings.TrimSpace(strings.TrimSuffix(s, u.suffix))
			break
		}
	}
	var f float64
	if _, err := fmt.Sscanf(s, "%f", &f); err != nil {
		return 0, fmt.Errorf("invalid size: %s", s)
	}
	if f < 0 {
		return 0, fmt.Errorf("negative size")
	}
	return int64(f * float64(mult)), nil
}
