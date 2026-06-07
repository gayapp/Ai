# RFC · M3 · analyze pending pool 软上限 + 入口背压

**Status**: **Locked — 进入实现**（2026-06-04 与 IRC agent 协商完成；见 [ai2ai.md](../../ai2ai.md)）
**Owner**: ai-guard
**Created**: 2026-06-03
**Triggers**: 2026-05-28~29 xAI team_blocked 13.5h 制造 14000+ pending backlog 的事故复盘

## 协商结果（locked 2026-06-04）

| 项 | 决定 |
|---|---|
| Final `BACKPRESSURE_HARD_LIMIT` | **500**（稳态 <50 的 10x headroom） |
| Canary 初始 | **2000**，ai-guard 本周即可上 |
| 降到 500 前置 | **IRC 持久任务队列 requeue 路径在 prod**（IRC 在 ai2ai.md 追加 `IRC requeue ready` 即触发降阈值） |
| 503 body | `{"error_code":"backlog_overload","retry_after_seconds":30}`（snake_case，配合 ErrorCodes 风格） |
| 单池单阈值 | 不区分 biz_type；IRC 在自己 task_claimer 本地优先 `media_intro` |
| Header | `X-Analyze-Backlog: <count>` + `X-Analyze-Backlog-Severity: ok|warn|crit` 始终带；IRC Day 1 log 不主动降速 |
| 业务降级 | 关键澄清：IRC analyze 是后台异步 enrichment，**没有用户实时等结果**。2h TTL 超时后视频不带 AI 富化直接发布（无分析标签 / intro fallback） |
| IRC 重试粒度 | "wall-clock 2h TTL + 分钟级慢重投"，不是固定 N 次 |

**关键洞察**：背压不是"在 ai-guard 加缓冲"，而是"把 backlog 搬到 IRC 已经为全量视频规模设计好的持久任务表"。RFC 原 §6 的"IRC 必须实现内存缓冲（cap 1000）"是错的。



---

## 1. 问题

当 xAI（analyze 主链路 provider）长时间 down 时，pending 池会无界增长：

| 时段 | 持续 | pending 峰值 |
|---|---|---|
| 2026-05-26 21:34Z 第 1 次 team_blocked | 33 min | 363 |
| 2026-05-27 16:22Z 第 2 次 | ~50 min | 683 |
| 2026-05-28~29 第 4 次 | 13.5 h | **14000+** |

M9 解决了"无限重投"导致的 CF 侧空转，给每条 pending 加了 2h 寿命 + sweep give-up。但**入口仍然是无限接收** — IRC 持续 `POST /v1/analyze`，ai-guard 持续 202 收下、写 D1、入 ANALYZE_QUEUE，并不感知后端 provider 已挂。

这意味着即使解决了"重投空转"，下一次 long outage 仍会：
- D1 写入压力线性增长（pending 行 + content_text + extra_json）
- ANALYZE_QUEUE 持续堆积 → DLQ 风险
- IRC 侧业务不感知，仍在累积"等待结果"的 user-facing call

## 2. 目标

- pending 池有**软上限**，越过时拒绝新请求（让 IRC 侧感知 ai-guard 拥堵）
- 既不阻塞 IRC 业务可用性（partial degradation 容忍），也不让池无界
- IRC 收到背压信号后有明确的 retry / fallback 策略
- 不破坏现有 callback 契约（[docs/04-callback-spec.md](../04-callback-spec.md)）

## 3. 约束

- **ai-guard 是中间层**：不能决定 IRC 业务如何降级；只能给出明确的"我现在拥堵"信号
- **bounded latency requirement**：当前 ANALYZE_QUEUE 消费稳态 100-200/min，xAI 健康时 pending 池常驻 < 50
- **D1 + KV 一致性**：pending 池计数需要快速读，但 `SELECT COUNT(*) FROM analyze_requests WHERE status='pending'` 在 70k 行表里 ~50ms，每个 POST 都跑会拉延迟
- **CF Workers cold start**：背压决策不能跨 Worker invocation 共享内存，只能走 KV / D1

## 4. 设计选项

### 选项 A · 硬阈值 503（推荐起点）

POST /v1/analyze 入口前加：

```ts
const pendingCount = await getPendingCountCached(env);  // 缓存到 KV，5s TTL
if (pendingCount > BACKPRESSURE_HARD_LIMIT) {
  throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 503, "analyze backlog exceeded; retry after 30s");
}
```

- `BACKPRESSURE_HARD_LIMIT`：建议 **500**（远超稳态 50，又远小于事故峰值 14000）
- KV 缓存：cron `*/5min` 写一次 pending count 到 `kv:analyze:pending:count`（TTL 60s），入口 read。容忍 5min 偏差
- 503 响应 body：`{"error_code":"BACKLOG_OVERLOAD","retry_after_seconds":30}`
- IRC 收到 503：本地排队，按 `retry_after_seconds` 延迟重提

**Pros**：实现简单（~30 行）；语义明确（503 = ai-guard 拒绝接收）
**Cons**：阶梯式拒绝（要么 100% 收要么 100% 拒）；IRC 侧需要实现本地缓冲

### 选项 B · 软阈值 + Retry-After 头（202 + 显式 backoff）

入口仍接受请求并返 202，但响应里加：

```http
HTTP/1.1 202 Accepted
Retry-After: 60
X-Analyze-Backlog: 800
X-Analyze-Backlog-Severity: warn  # ok | warn | crit
```

IRC 读这些 header 自决：业务可用时不退避，业务可降级时按 backlog severity 退避。

**Pros**：IRC 有更多控制权；不强制拒绝；适合"想用就用"的场景
**Cons**：IRC 必须主动读 header（多一次集成）；ai-guard 仍然全收，D1 压力不减

### 选项 C · 概率性 shedding

按 pending 池大小，概率拒绝 % 新请求：

| pending count | reject rate |
|---|---|
| < 300 | 0% |
| 300-500 | linear 0% → 50% |
| 500-1000 | linear 50% → 90% |
| > 1000 | 90% |

**Pros**：smooth degradation；上游不会感知到阶梯
**Cons**：调试难（同样请求重试可能成功）；IRC 侧的成功率不可预期

### 选项 D · 队列长度 backpressure（Cloudflare Queues 原生）

依赖 CF Queues 自身的 backpressure（push 速率 > consume 速率时入口阻塞）。

**Pros**：零代码改动
**Cons**：CF Queues 的 backpressure 是 producer 端事件丢弃，不是 HTTP 层信号；IRC 拿不到明确 retry 指引

## 5. 推荐方案

**Phase 1: 选项 A** + 选项 B 的 X-Analyze-Backlog header（混合）

- 阈值：500 硬拒，warn header threshold 300
- 默认 5s KV cache 减轻 D1 读压力
- 实现 ~50 行 + 测试
- IRC 侧：解析 503 + `retry_after_seconds` 是必须；解析 `X-Analyze-Backlog` 是可选优化

**Phase 2**（如果 Phase 1 不够）：转选项 C 平滑曲线 + IRC 数据反馈

## 6. IRC 契约变更（locked 2026-06-04）

IRC 已确认实现路径（不是内存缓冲，是持久队列 requeue）：

1. **必须**：[ai_guard_client](https://placeholder-irc-repo) 识别 503 + `error_code=backlog_overload`，解析 `retry_after_seconds`
2. **必须**：[ai_analyzer](https://placeholder-irc-repo) / [intro_generator](https://placeholder-irc-repo) 收到 `BACKLOG_OVERLOAD` 时**退回持久任务队列（deferred/retry 态）**，延迟 = `retry_after_seconds` + jitter，**不计入** `PIPELINE_STAGE_MAX_RETRIES` 快速预算
3. **必须**：单任务以 **wall-clock 2h TTL** 封顶（与 ai-guard pending give-up 对齐）；超时后视频不带 AI 富化直接发布
4. **必须**：task_claimer / cron 支持 deferred 任务到点重领
5. **Day 1 log**：`X-Analyze-Backlog` + `X-Analyze-Backlog-Severity` 记入观测（不门禁主动降速）
6. **可选 Phase 2**：基于 severity 的主动降速（IRC 内部跨节点协调代价，看 prod 真实 503 率再决定）

## 7. 监控

新增告警：

- `analyze-pending-pool > 80% of hard limit` → warn Telegram
- `analyze-pending-pool > hard limit && 503 rate > 0` → crit Telegram（"ai-guard 在拒请求中"）
- Telegram 每条 503 拒绝事件都计数（KV 累加），cron 5min 汇报到 `[scheduled] alert check` 日志

新增 dashboard 指标：

- 历史 pending 池曲线（已存 [stats_rollup](../../src/stats/rollup.ts) 但没拉趋势图，M6 一并补）
- 503 BACKLOG_OVERLOAD 拒绝率（小时粒度）

## 8. 实现 sketch

文件改动：

| 文件 | 改动 |
|---|---|
| [src/routes/analyze.ts](../../src/routes/analyze.ts) | POST /v1/analyze 入口加 `enforceBackpressure(env)`，超阈抛 SERVICE_UNAVAILABLE；响应 header 加 `X-Analyze-Backlog`、`X-Analyze-Backlog-Severity` |
| [src/analyze/backpressure.ts](../../src/analyze/backpressure.ts) | 新文件，`getPendingCountCached()` + `enforceBackpressure()` + threshold 常量 |
| [src/index.ts](../../src/index.ts) | scheduled `*/5min` 加一段：`SELECT COUNT(*) FROM analyze_requests WHERE status='pending'` → 写 KV `kv:analyze:pending:count`（TTL 60s） |
| [src/lib/errors.ts](../../src/lib/errors.ts) | 新增 `ErrorCodes.BACKLOG_OVERLOAD = "backlog_overload"` |
| [src/alerts/telegram.ts](../../src/alerts/telegram.ts) | 新告警：pending pool > 80% 软告警 / > 100% crit |
| [docs/04-callback-spec.md](../04-callback-spec.md) | 加 503 + `BACKLOG_OVERLOAD` 错误码语义 |
| [docs/apps/IRC-analyze-handoff.md](../apps/IRC-analyze-handoff.md) | 加"背压响应处理"章节，给 IRC 实现指引 |

## 9. 验证

1. unit test：mock pending count = 400/600/800，验证入口在 hard_limit=500 时正确 503
2. integration：dev 环境手动注入 600 fake pending，POST /v1/analyze 应稳定收到 503
3. canary：prod 先把 hard_limit 设到 2000（防误伤），观察 1 周 503 触发率；再降到 500
4. 复盘：下次 xAI long outage 发生时（无法主动触发），观察 pending 是否封顶在 hard_limit 附近，不再无界

## 10. 待 IRC 协商的开放问题

1. **IRC 侧本地缓冲上限是多少？** — 影响 ai-guard hard_limit 的合理值
2. **IRC 业务降级路径** — 拿到 503 + 缓冲满后，能否给用户"内容审核中"占位响应？
3. **503 + retry 重试上限是 IRC 侧定还是 ai-guard 给？** — 建议 IRC 侧本地最多重试 5 次，超过转业务降级
4. **是否区分 biz_type？** — media_intro 可能比 media_analysis 优先（用户更关注）

## 11. 时间线（locked 2026-06-04）

- **Week 1**（2026-06-04 ~）：协商完成 ✅；ai-guard 实现 + dev → prod canary（hard_limit=2000），IRC 并行实现 requeue 路径
- **Week 2**：IRC requeue 上 prod；IRC 在 ai2ai.md 追加 `IRC requeue ready` 通知 → ai-guard 把 prod hard_limit 渐降 2000 → 1000 → 500
- **Week 3+**：实战观察 + 调优（如果 503 率 > 预期或 < 预期，再讨论）

## 附录 · 历史数据参考

| 日期 | 事件 | 持续 | pending 峰值 | 备注 |
|---|---|---|---|---|
| 2026-05-26 | xAI team_blocked #1 | 33 min | 363 | 无 backpressure，IRC 持续提交 |
| 2026-05-27 | xAI team_blocked #2 | ~50 min | 683 | M11 后实时 crit 告警 |
| 2026-05-28~29 | xAI team_blocked #4 | 13.5 h | 14000+ | M9 给 sweep 加 give-up 后能消化，但事故期间池无上限 |
| 稳态 | 健康运行 | n/a | < 50 | M14 saw-tooth 状态下 8-79 间震荡 |

如果 hard_limit 设 500：
- 5-26 #1 不会触发（峰值 363 < 500）
- 5-27 #2 触发短期 503（683 > 500）
- 5-28~29 #4 触发持续 503，但池被封顶在 500（而非 14000），D1 压力降 28x
