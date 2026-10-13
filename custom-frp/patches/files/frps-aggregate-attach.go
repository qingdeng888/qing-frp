// Code generated for frp-console. DO NOT EDIT upstream.
// frp-console-target: pkg/metrics/aggregate/console_attach.go
//
// frp-console 定制：把额外的 ServerMetrics 实现挂到 aggregate 多路复用器上。
//
// 背景：aggregate 包在自己的 init() 里调用 metrics.Register()，且 metrics
// 包的 Register 使用 sync.Once，因此外部再注册会被静默忽略。aggregate 本身
// 设计上就是聚合多个实现，这里暴露一个入口把自定义实现追加进去。
//
// 放在 aggregate 包内是为了避免导入循环：
//   server/metrics -> pkg/metrics/aggregate -> server/metrics （循环，不可行）
// 因此由 cmd/frps 同时导入两者并调用 Attach。
package aggregate

import (
	"github.com/fatedier/frp/server/metrics"
)

// Attach adds an extra metrics implementation to the fan-out list.
// It is safe to call once during startup.
func Attach(m metrics.ServerMetrics) {
	if m == nil {
		return
	}
	sm.Add(m)
}
