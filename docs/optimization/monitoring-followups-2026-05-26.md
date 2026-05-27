# 监控与告警 followups（2026-05-26 ~ 05-27 巡检发现）

> 来源：本次会话从 Telegram "GROK 凭证失效" 告警起，一路排查 dashboard / analyze-ops / D1 / 告警链路 / IRC ack 漏做，沉淀出的优化与隐患清单。
>
> 已闭环项已注明 commit / version。开放项按优先级排，按 [优化任务清单](README.md) 的 P0/P1/P2/P3 风格。

## 本次会话已闭环 ✅

| 项 | 修复 | 版本 / commit |
|---|---|---|
| `wrangler secret put` 通过 PowerShell pipe 上传带尾换行，Bearer 头畸形 401 | 改走 Cloudflare REST API `PUT /workers/scripts/.../secrets`，精确字节上传 | 2026-05-18，记入 memory `wrangler-secret-put-newline-pwsh` |
| analyze pull-unacked alert SQL 把 `delivery_mode=both AND delivered_at IS NOT NULL` 剔除，导致 IRC ack 漏做 22h 内 1124 条静默累积 | SQL 改为 `delivery_mode IN ('pull','both')`，不再按 callback 投递状态过滤 | version `43b79366`（2026-05-26 prod） |
| moderation 流量稀疏（30 min 才 0-7 单），`sampleWindowMs=5min` / `minSample=20` 导致告警永远 skip → 100% 失败也无声 | 拆出 `moderationSampleWindowMs=30min`，`minSample` 20→5 | version `3139eb2a`（2026-05-26 prod） |
| 告警通路自身没有正向心跳，1124 条 backlog 案例就是因为通路出现 SQL bug 没人能感知 | 加 `sendWeeklyHeartbeat()`，daily cron 调，dedup 6.5 天 → Telegram 每周一条 `ai-guard · 告警通路心跳` | version `3139eb2a` |
| IRC analyze `delivery_mode=both` callback 后没补 ack，1124 条历史 backlog | 已交付排查 brief 给 IRC AGENT；IRC 团队 2026-05-26 15:15Z 修复上线，10 min bulk ack 清理完成，至今稳态正常 ack | IRC 侧修复（外部仓库） |
| 2026-05-25 13–17Z `schema_validation_failed` 集中爆发（~2100 条）根因不明 | 归档：是 [abac498](abac498) 真 bug 修复——LLM 偶尔输出带 markdown 包裹或解释文字的 JSON、空 raw 抛 SVF 不能 fallback；abac498 加 `extractFirstJsonObject` 容错 + 空输出降级为 PROVIDER_ERROR | 结构性修复，已带 +56 行测试，复发风险低 |

## 事故复盘

### 2026-05-26 21:34 ~ 22:37Z · xAI team_blocked 短期故障

**时间线**（UTC）：

| 时刻 | 事件 | pending | 备注 |
|---|---|---|---|
| 21:34 | xAI team-level 屏蔽开始（`api_key/v1/api-key` 返 `team_blocked=true`） | 0 → 累积 | 触发条件未知（账单/审查/ToS？） |
| 21:39 (T+5) | worker 内置 alert `analyze-pending-timeout` 应该首次触发（dedup 30min） | ~50 | Telegram 推送 |
| 21:52 (T+18) | /loop 巡检捕获 `pending>5m=128`，chat 推送诊断 | 128 | 用户首次看见 |
| 22:00 (T+26) | hourly provider-health cron 应该执行 → 看到 `team_blocked=true` | ~190 | 但日志暂未观察到（需查 tail） |
| 22:07 (T+33) | xAI 自愈，`team_blocked=false` | 303 peak | 平台层屏蔽解除 |
| 22:22 (T+48) | 队列追上：`pending` 363→56 (15min 内消化 307 条) | 56 | OK/min 从 ~3 涨到 ~20 |
| 22:37 (T+63) | pending = 0，事故 closeout | 0 | 总耗时 ~63 分钟 |

**业务影响**：
- IRC analyze 25 分钟内成功率 < 10%，pending 峰值 363 条
- xAI 恢复后通过队列重试自然消化，**没有任何请求最终失败**（错误率始终 0%）——pending sweep 没来得及把它们标 `pending_timeout`，因为 sweep 阈值也是 5min 但每 5min 跑一次，恰好慢了一拍
- IRC `provider_strategy=grok` → fallback=null → 期间 0 流量被 gemini 接管（符合现有代码行为，见 M1）

**根因评估**：
- xAI 平台层屏蔽，**ai-guard 端无法预防或加速恢复**
- ai-guard 端的应对是"队列重试 + sweep"两层兜底，这次没把任何请求误标 error，行为正确
- 改进点：检测速度 / 告警精度 / 兜底链路鲁棒性，详见 M8-M10



#### M1 · `provider_strategy=grok` 文档与代码不一致
- **文档**：[docs/apps/IRC-analyze-handoff.md:138](../apps/IRC-analyze-handoff.md#L138) 说 IRC analyze 线"不 fallback 到 Gemini"
- **代码**：[src/analyze/pipeline/media-analysis.ts:145-154](../../src/analyze/pipeline/media-analysis.ts#L145-L154) 在 grok 熔断器 open 时切换到 gemini fallback
- **现实数据**：2026-05-26 03–09Z 事故中产生 367 条 gemini 失败 + 29 条 gemini 成功，证实 fallback 确实在跑
- **mitigated by**：worker 已有 `analyze-provider-mismatch` Telegram 告警（[telegram.ts:230-265](../../src/alerts/telegram.ts#L230-L265)）
- **两条路**：
  - (a) 改文档：把 IRC handoff 改成"仅在 xAI 熔断 open 时 fallback gemini"，更符合实际
  - (b) 改代码：让 `resolveAnalyzeRoute` 在 strategy=grok 时返回 `fallback=null`，请求 pending 等 xAI 恢复
- **建议**：先 (a)（低风险），保留 fallback 提升可用性；若 IRC 真的不想要 gemini 结果再走 (b)

#### M2 · /loop 巡检 session-only 局限
- 当前 /loop `14da2bd1` 每 15 min 跑 D1 巡检，但 7 天自动到期，Claude 会话关闭即停
- 长期方案：迁到 `/schedule`（Cloudflare cloud 跑，不依赖本会话）
- 当前 mitigation：worker 自己的 `*/5` cron + Telegram 告警是真正的"长哨兵"，/loop 只是 chat 内可视化

#### M3 · 双 provider 同时 degraded 时的 fail-fast 行为
- 2026-05-26 03–09Z 事故复盘：grok auth_failed → 熔断 open → fallback gemini → gemini 429 → 4,746 条 `service_unavailable`
- 当前两个 provider 都 circuit open 时立刻返 503，不重试
- 可考虑：分类型处理。analyze 类（async + delivery_mode=pull/both）应该转 pending 入队等 provider 恢复，而不是立即 503——因为 IRC 用户态没有"实时"诉求
- 影响 [src/analyze/pipeline/media-analysis.ts:150-154](../../src/analyze/pipeline/media-analysis.ts#L150-L154) 处
- 风险：会增加 pending 池规模，需要配合 pending sweep 的超时阈值调整

#### M8 · provider-health cron 拉到每 5 分钟（事故衍生）
- **现状**：[src/index.ts:294-303](../../src/index.ts#L294-L303) 通过 `isHourTick = now.getUTCMinutes() < 1` 限制只在 xx:00 那次 cron 跑 `checkProviderHealth`
- **本次事故**：xAI `team_blocked=true` 发生于 21:34Z，要等到 22:00Z 才会被主动巡检发现——**理论上有 26 分钟知情盲区**（实际本次靠 `pending-timeout` 间接告警在 T+5 抓到）
- **改法**：去掉 `isHourTick` 闸门，让 provider-health 跟 alert check 一样每 5 min 跑一次。`checkProviderHealth` 每次 2 个 HTTP 调用（xAI + Gemini），成本可忽略
- **风险**：xAI / Gemini 的 health endpoint 自身被频繁打可能引起小规模限流；可设短超时 + 软失败
- **收益**：把"team blocked / key disabled"这类**根因告警**前置 25 分钟。比依赖 `pending-timeout` 这种症状告警更直接

#### M9 · pending sweep 阈值与 cron 频率错位（事故衍生）
- **现状**：sweep 把 `pending > 5min` 标为 `pending_timeout`，cron 也是 `*/5 * * * *`——理论可能恰好慢一拍把"刚要被队列重试成功"的请求标错为 error
- **本次事故**：363 条 pending 中 0 条最终被 sweep 标 error，恰好运气。但若 xAI 恢复再晚 5 min，sweep 就会击中
- **改法**：sweep 阈值与 cron 周期之间至少留 1.5x buffer：阈值 5 min → cron 频率 7 min 或更稀，或反之
- **替代**：sweep 之前先一次 retry——把 pending 重新入队，让队列处理 N 次失败后再标 error（业务上更友好）
- **优先级**：低。当前 sweep 实际表现是正确的，事故里没误伤

#### M10 · xAI 部分降级时熔断器无感（事故衍生）
- **现状**：熔断器要求"连续 5 次失败"才 open（[circuit.ts:16](../../src/providers/circuit.ts#L16)），`canTry()` 才会切到 fallback
- **问题**：xAI 在 partial degraded（如成功率 50%）时不会触发熔断，每个请求都"先打 xAI 失败再丢"；本次事故中 21:34-22:07 这 33 min 全部是这种状态
- **改法**：
  - (a) 降低 fail threshold 到 3
  - (b) 引入"成功率窗口"——10 个请求里失败 ≥ 6 就 open（更贴合现实流量）
  - (c) 加 latency-based circuit（连续 N 次 > 阈值也 open）
- **配合 M1**：如果同时让 strategy=grok 的 fallback 不为 null，部分降级时就能自动切 gemini，减少业务感知
- **优先级**：P3，因为熔断目前是"防止持续打不通"，不是"加速切换"

### 🟢 P3 — 按需再做（小修小补）

#### M4 · max_lat 告警升级为 p95
- 当前告警条件是 max_lat ≥ 阈值。单次抖动易触发，趋势性恶化不易看
- 可加 p95 维度：D1 用 NTILE 或 percentile_cont 近似
- 优先级低：max_lat 当哨兵够用，p95 dashboard 已有

#### M5 · `provider` 字段命名不一致
- `moderation_requests.provider` = `grok` / `gemini`
- `analyze_requests.provider` = `xai` / `gemini`
- 跨表统计写 SQL 时需要 `COALESCE(NULLIF(provider,'xai'),'grok')` 之类的别扭转换
- 影响：所有读这两张表的统计端点 / Admin UI / 告警 SQL
- 选项：
  - (a) 改写 analyze 侧统一用 `grok`（要补 migration、所有插入点）
  - (b) 留着，文档说明（最省事）
- 建议 (b)：仅文档记一笔，不改数据

#### M6 · 成本 / token 趋势看板
- `stats_rollup` 已存了 input_tokens / output_tokens 每日汇总
- Admin UI Dashboard 暂未把 token 转 USD 估算和趋势线展示
- 触发条件：账单 > $30/月 或老板要数（参考 [README.md:120](README.md#L120) 物理服务器触发线）

#### M7 · 零流量告警（moderation 完全静默时报警）
- moderation 当前流量 0-7 单/30 min，正常波动包含 0
- 但如果某 app 集成断了（HMAC 失效 / DNS / 客户端 bug），ai-guard 完全无感
- 可加：6h 滚动窗内 moderation 总量 = 0 时报 `info` 级 Telegram，提醒"是否上游集成断了"
- 优先级低：业务侧自己应该有自检；ai-guard 端报这个边界模糊

## 运行中的监控基线（snapshot 2026-05-26）

| 路径 | 状态 | 备注 |
|---|---|---|
| Worker `*/5` cron alert check | ✅ 跑 | 新 SQL 在 prod，零误报 |
| Worker xx:00 hourly provider-health 巡检 | ✅ 跑 | 调 xAI `/v1/api-key`、Gemini probe |
| Worker `5 0 * * *` daily cleanup + rollup + heartbeat | ✅ 跑 | 首条心跳 ~2026-05-27 00:05 UTC |
| Telegram crit/warn 告警 | ✅ | Bot token + chat ID 双 secret 配齐；dedup KV `b2f7a8be...` |
| `/loop 14da2bd1` 15min D1 巡检 | ✅ session-only | 见 M2 |
| wrangler tail 常驻 Monitor | ❌ 不挂 | Windows libuv 长连接不稳；改为按需 60s 短窗 |

## 后续触发点

- 任一 worker 部署后，跑一次本文档的 [docs/07-runbook.md](../07-runbook.md) smoke
- 月底如果 Telegram 没收到 weekly heartbeat → 告警通路本身死了，按 [memory wrangler-secret-put-newline-pwsh](#) 类似套路排查
- IRC 灰度从 50% → 100% 时，重新巡检 analyze-ops 灰度门禁与 backlog
