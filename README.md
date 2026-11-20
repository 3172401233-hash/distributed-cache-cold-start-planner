# 多区域缓存冷启动规划器

为多区域缓存集群设计**离线**冷启动预热计划：根据键热度、TTL、对象大小、区域容量、
源站限流与预热带宽，安排分批预热顺序，控制同一热门键跨区域的并发预热，并在命中率
不足时给出受控回源的降级策略与截止时间。

> **重要：本工具不连接真实缓存、源站或任何网络服务。**
> 它只读取 JSON 场景描述，在内存中做确定性的规划与模拟，输出 JSON 计划。
> 所有“预热 / 回源 / 故障 / 热点变化”均为数学模拟，不产生任何真实网络请求。

## 运行环境

- 目标运行时：Node.js **24.16.0**（仅使用 Node 内置模块 `node:test`、`node:fs`、
  `node:child_process` 等稳定 API，无第三方依赖；在 Node.js 22+ 上同样可运行）。
- 项目为 ESM（`package.json` 中 `"type": "module"`）。

## 快速开始

```bash
# 仅生成预热计划
node src/cli.js examples/scenario.json

# 生成计划并执行场景模拟（失败重试、区域故障、短时热点变化）
node src/cli.js --simulate examples/scenario.json

# 从 stdin 读取
cat examples/scenario.json | node src/cli.js --simulate

# 写入文件
node src/cli.js examples/scenario.json --output plan.json
```

## 输入格式

```json
{
  "keys": [
    { "id": "key-hot-1", "heat": 100, "ttlSeconds": 30, "sizeBytes": 2000000 }
  ],
  "regions": [
    { "id": "region-a", "capacityBytes": 10000000, "bandwidthMbps": 16 }
  ],
  "origin": {
    "rpsLimit": 2,
    "bandwidthMbps": 100,
    "maxBypassRps": 5
  },
  "config": {
    "maxRetries": 3,
    "maxConcurrencyPerKey": 1,
    "deadlineSeconds": 120,
    "hitRateTarget": 0.9
  }
}
```

- `keys[].heat`：键热度（权重，越大越优先预热）；`ttlSeconds`：TTL；`sizeBytes`：对象大小。
- `regions[].capacityBytes`：区域容量；`bandwidthMbps`：该区域预热带宽（Mbps）。
- `origin.rpsLimit`：源站每秒可承受的预热请求上限；`origin.bandwidthMbps`：源站带宽上限；
  `origin.maxBypassRps`：允许划给降级回源请求的 RPS 配额。
- `config.maxConcurrencyPerKey`：同一热门键跨区域同时预热的最大并发数（默认 1，
  即同键在多个区域串行预热，避免源站瞬时承受数倍流量）。
- `config.deadlineSeconds`：整体预热截止时间；`config.hitRateTarget`：命中率目标。

## 规划器做了什么

1. **容量准入**：每个区域按热度从高到低尝试装入键；装不下的键直接标记
   `capacity-overflow` 降级，不参与预热。
2. **分批预约（秒级时间桶）**：`ReservationBoard` 为每个预热任务精确预约每秒的
   - 源站 RPS 与源站带宽，
   - 区域预热带宽，
   - 同键跨区域并发数。
   贪心放置并逐秒推进，任何一秒都不会突破限流、带宽或同键并发约束。
3. **优先级排序**：热度高 → TTL 短 → 对象小 → id 字典序，结果确定可复现。
4. **截止时间与降级**：开始时间晚于截止时间的任务生成 `preheat-at-risk` 条目，
   截止时间之前的请求按 `bypass-to-origin` 回源。
5. **命中率核算**：按热度权重估算每区域与整体命中率；低于目标时在输出中明确提示，
   未覆盖键的请求走降级回源。
6. **同时过期治理**：对相同 TTL 的键施加确定性的 ±20% TTL 抖动（FNV-1a 哈希，
   多次运行结果一致），打散过期时刻，并给出到期前 10% 的续预热时间点。

## 降级与回源

所有降级条目都包含 `fallback: "bypass-to-origin"`、`deadlineSecond` 与按热度权重
分配的 `allowanceRps`（总和不超过 `origin.maxBypassRps`）。类型包括：

| 类型 | 触发场景 |
| --- | --- |
| `capacity-overflow` | 区域容量不足，键无法装入 |
| `preheat-at-risk` | 预热无法在整体截止时间前完成 |
| `retry-exhausted` | 预热连续失败且重试次数耗尽 |
| `region-unavailable` | 区域故障且无健康区域可承接 |
| `unplanned-hotkey` | 短时新热点未纳入原计划 |

## 场景模拟（`--simulate`）

在内存中驱动计划执行，并通过 `simulation.events` 注入事件：

```json
"simulation": {
  "failures": [{ "taskId": "region-a__key-hot-1", "times": 2 }],
  "events": [
    { "type": "task-failure", "atSecond": 5, "taskId": "region-a__key-hot-1" },
    { "type": "region-down",   "atSecond": 1, "regionId": "region-b" },
    { "type": "region-up",     "atSecond": 18, "regionId": "region-b" },
    { "type": "heat-update",   "atSecond": 10,
      "changes": [{ "id": "key-sudden", "heat": 95, "sizeBytes": 400000, "ttlSeconds": 20 }] }
  ]
}
```

- **预热失败重试**：指数退避（基础延迟 × 退避因子，含确定性抖动与上限封顶）；
  超过 `maxRetries` 后生成 `retry-exhausted` 降级。
- **区域故障**：在途任务被中止并容灾到健康区域（健康区域已有同键副本时直接复用）；
  区域恢复后缓存视为清空，按原计划重新预热。同秒多区域故障不会把任务容灾到
  即将故障的区域。
- **短时热点变化**：新键按剩余容量动态准入并预热；容量不足或需要挤占低热度待办
  任务时，生成 `unplanned-hotkey` 降级并记录在 `replans` 中。
- 模拟全程复用同一块预约板，因此同样不突破源站 RPS、带宽与同键并发约束。

## 输出结构（摘要）

- `plan.waves`：分批预热波次（每波的开始秒与任务列表）。
- `plan.tasks`：每个任务的区域、键、开始/完成秒、持续时长。
- `plan.capacity`：各区域容量使用与溢出统计。
- `plan.hitRate`：每区域与整体命中率、是否低于目标。
- `plan.expiryPolicy`：每键抖动后的 TTL、续预热时间点与同时过期风险。
- `plan.degradation`：回源预算与全部降级条目（含截止时间与 RPS 配额）。
- `simulation.timeline` / `replans` / `loaded` / `summary`：模拟时间线、重规划、
  最终装载结果与失败/重试/容灾计数。

## 测试

```bash
node --test
```

覆盖：集中热点排序与同键跨区域串行、源站 RPS 限流、容量差距降级、TTL 同时过期抖动、
截止时间降级、失败重试（成功与耗尽）、区域故障容灾与恢复、短时热点动态准入，
以及模拟全程不突破 RPS 与同键并发约束、CLI 冒烟与输入校验。

## 目录结构

```
src/
  model.js       输入归一化/校验、确定性哈希、常量
  scheduler.js   秒级预约板（RPS/带宽/同键并发约束）与任务优先级
  policies.js    重试退避、降级条目、TTL 抖动与过期治理
  planner.js     冷启动规划器主流程
  simulator.js   场景模拟器（失败/故障/热点变化）
  cli.js         命令行入口
  index.js       编程接口导出
examples/
  scenario.json  示例场景
test/            node:test 测试
```
