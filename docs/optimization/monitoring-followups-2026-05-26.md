# 监控与告警 followups（2026-05-26 ~ 05-27 巡检发现）

> 来源：本次会话从 Telegram "GROK 凭证失效" 告警起，一路排查 dashboard / analyze-ops / D1 / 告警链路 / IRC ack 漏做，沉淀出的优化与隐患清单。
>
> 已闭环项已注明 commit / version。开放项按优先级排，按 [优化任务清单](README.md) 的 P0/P1/P2/P3 风格。

## 本次会话已闭环 ✅

| 项 | 修复 | 版本 / commit |
|---|---|---|
| M8 · provider-health cron 从 hourly → 每 5 min（事故 2026-05-26 发现的 26 min 检测盲区） | 去掉 `src/index.ts` 里 `isHourTick` 闸门 | commit `69d3967`，prod version `4db2d7b8`（2026-05-27 17:06Z） |
| M11 · xAI `team_blocked` 专项实时 crit 告警 | `checkXai` 拆分 reason 枚举；`team_blocked` 单独走 🚨🚨 标题 + console.x.ai 链接；dedupTtl 统一 600s 配合 5min cron | commit `69d3967`，prod version `4db2d7b8`（2026-05-27 17:06Z） |
| M12 · 同根因 24h 内复发自动 escalate | DEDUP_CACHE 写 `recur-count:<provider>:<reason>` 24h TTL，≥2 次标题加「⚠️⚠️ 复发 (24h 内 N 次)」并强制 crit。`checkProviderHealth` + `alertProviderAuthFailed` 均接入 | commit `69d3967`，prod version `4db2d7b8`（2026-05-27 17:06Z） |
| M13 · moderation fallback gemini 安全过滤 400 → status=review（不再标 error） | `pipeline.ts` fallback catch 里识别 `http 400` + body 含 `safety/blocked/INVALID_ARGUMENT`，合成 `{status:"review",risk_level:"medium",categories:["other"],provider:"gemini",prompt_version:null}`。其他 400 仍按 PROVIDER_ERROR 走 | commit `69d3967`，prod version `4db2d7b8`（2026-05-27 17:06Z） |
| `wrangler secret put` 通过 PowerShell pipe 上传带尾换行，Bearer 头畸形 401 | 改走 Cloudflare REST API `PUT /workers/scripts/.../secrets`，精确字节上传 | 2026-05-18，记入 memory `wrangler-secret-put-newline-pwsh` |
| analyze pull-unacked alert SQL 把 `delivery_mode=both AND delivered_at IS NOT NULL` 剔除，导致 IRC ack 漏做 22h 内 1124 条静默累积 | SQL 改为 `delivery_mode IN ('pull','both')`，不再按 callback 投递状态过滤 | version `43b79366`（2026-05-26 prod） |
| moderation 流量稀疏（30 min 才 0-7 单），`sampleWindowMs=5min` / `minSample=20` 导致告警永远 skip → 100% 失败也无声 | 拆出 `moderationSampleWindowMs=30min`，`minSample` 20→5 | version `3139eb2a`（2026-05-26 prod） |
| 告警通路自身没有正向心跳，1124 条 backlog 案例就是因为通路出现 SQL bug 没人能感知 | 加 `sendWeeklyHeartbeat()`，daily cron 调，dedup 6.5 天 → Telegram 每周一条 `ai-guard · 告警通路心跳` | version `3139eb2a` |
| IRC analyze `delivery_mode=both` callback 后没补 ack，1124 条历史 backlog | 已交付排查 brief 给 IRC AGENT；IRC 团队 2026-05-26 15:15Z 修复上线，10 min bulk ack 清理完成，至今稳态正常 ack | IRC 侧修复（外部仓库） |
| 2026-05-25 13–17Z `schema_validation_failed` 集中爆发（~2100 条）根因不明 | 归档：是 [abac498](abac498) 真 bug 修复——LLM 偶尔输出带 markdown 包裹或解释文字的 JSON、空 raw 抛 SVF 不能 fallback；abac498 加 `extractFirstJsonObject` 容错 + 空输出降级为 PROVIDER_ERROR | 结构性修复，已带 +56 行测试，复发风险低 |
| M8/M11/M12/M13 **prod 实测验证**（4h 监控期 17:06–21:13Z） | wrangler tail 实测 `[scheduled] provider health` 日志每 5 min 一次（旧 hourly）✅；2026-05-27 16:22Z+ 那次 team_blocked 恢复期 pending 620→0 自然消化，错误率全程 0%；M11 / M12 升级路径代码可达但 17:06Z 后无新 team_blocked 触发 | 验证通过，4h 实测无回归 |
| M9 · pending sweep 加超龄放弃上限（终止无限重投） | [pending-sweep.ts](../../src/analyze/pending-sweep.ts) 两段式：>2h pending → 标 `pending_timeout` + 终态 callback 退出池（≤100/次）；5min–2h → 重投。背景：2026-05-28~29 第 4 次 team_blocked 13.5h 制造 14000 backlog 无界堆积 | prod version `2b12a79f`（2026-05-30 18:xxZ）；+2 sweep 测试用例；部署后用于消化 14000 backlog | 
| M19 · 低流量窗口 err_rate 告警假阳保护 | [telegram.ts](../../src/alerts/telegram.ts) `checkAndAlert` 加 `minErrorCount=2`，`analyzeMinErrorCount=2` 阈值；err_rate 与绝对错误数同时越过才发 Telegram。背景：2026-05-30 10:05Z 巡查实测 moderation 9 单/1 错（11%）被规则判定越阈，但根因仅是单条 pending_timeout 偶发——属 M18 同源问题 | prod version `a0fea8a0`（2026-05-30 12:21Z）；+1 alert 测试用例 |
| M20 · daily cron DELETE 无 try/catch 把 rollup 一起带挂 | [index.ts](../../src/index.ts) `5 0 * * *` 分支里两个 `DELETE` 没 try/catch，抛错则后面 `rollupYesterday` + `sendWeeklyHeartbeat` 全部不跑。背景：2026-05-31 14:45Z 巡查发现 `stats_rollup` 最新 period_start=2026-05-29，缺 5-30/5-31 两天。每个 DELETE 独立 try/catch + 警告日志 | prod version `dba666e6`（2026-05-31 14:46Z）<br/>**追加观察 2026-05-31 22:16Z**：5-30 那一天的 rollup 行已自动回到表里（n=4 与原数据 distinct group 数吻合），来源不明——CF cron 可能有 missed-run 补跑或同区域 worker 重启时再触发。**最干净验证点**：2026-06-01 00:05Z cron 跑后 5-31 行应该出现，那次跑用的是新代码（`dba666e6`），如果还缺说明 cron 触发本身有问题；如果出现说明 try/catch 修复有效 |
| M25 · sweep give-up 写 provider=null 污染 stats_rollup `unknown` 桶 | [pending-sweep.ts](../../src/analyze/pending-sweep.ts) 给 give-up SELECT 加 `LEFT JOIN apps` 取 `provider_strategy`；新增 `resolveIntendedProvider(biz, strategy)` 调 `resolveAnalyzeRoute` 得 primary，传给 `completeAnalyze` 的 `provider` 字段；biz/strategy 解不出时退回 null。背景：38d 累计 29.9% 请求落 `unknown` 桶（5-28~29 backlog 事故主因） | prod version `aece72b0`（2026-06-01 06:48Z）；+2 测试用例覆盖 strategy=grok 与 app 已删 fallback；旧 21277 unknown 不回填，但新数据 30d 内 unknown 占比应滑降到 <1% |
| M4 + M17 (b) · rollup latency p50/p95 实至名归（之前 p50=AVG，p95=MAX 都是错的） | [rollup.ts](../../src/stats/rollup.ts) 拆成 2 个 SELECT：counts/sums 走原聚合；p50/p95 用 `PERCENT_RANK() OVER (PARTITION BY ...)` CTE 算真分位，再 JS 端按 `(app_id, biz_type, provider)` 三元组合并。只统计 `latency_ms > 0` 的样本（排除 cached / sweep give-up / 老旧零延迟行）。背景：M17 IRC analyze max_lat 60-90s 但实际 p95 数据没真的存过 | prod version `aece72b0`（2026-06-01 06:48Z）；2026-06-02 00:05Z 第一次新 cron 跑完后可对照 `stats_rollup` 与 raw `analyze_requests` 的 p95 验证 |
| M18 · sync auto mode 写库改 await（杜绝 pending_timeout baseline 损耗） | [moderate.ts](../../src/routes/moderate.ts) 两处 `c.executionCtx.waitUntil(recordCompleted(...))` 改成 `await recordCompleted(...)` | prod version `3c734dd6`（2026-06-01 19:30Z）<br/>**验证 2026-06-02 12:01Z**：post-deploy 16.5h 仅 1 条 pending_timeout，之后 13h 零损耗。partial success，残余路径下 M27 兜底 |
| M27 · M18 残余路径兜底（await 失败时 fallback waitUntil） | [moderate.ts](../../src/routes/moderate.ts) 抽 `recordCompletedWithFallback(c, args)`：`try { await recordCompleted } catch { waitUntil(retry) }`。两层全失败时 row 留 pending，由 sweep 兜（M9）。M18 + M27 组合：99% 同步落库 + 偶发 D1 抖动后台再补 | prod version `1203166f`（2026-06-02 17:18Z）；7d 后查 `pending_timeout` 是否真归零 |
| M10 · 熔断器 fail threshold 5 → 3 | [circuit.ts:17](../../src/providers/circuit.ts#L17) 把 `FAIL_THRESHOLD = 5` 改为 `3`。背景：2026-05-26 21:34-22:07 xAI partial degraded（成功率 30-50%）33min 始终没攒够 5 次连续失败，熔断器全程 closed，每次都"先打 xAI 失败再 fallback"。降到 3 后类似场景能更快走 fallback | prod version `7b714ce8`（2026-06-03 04:46Z）；+5 测试用例（新建 [test/circuit.test.ts](../../test/circuit.test.ts)）；media-analysis 集成测试调整 15→9 gemini fetch 数 |
| M7 · 6h 滚动窗 moderation 零流量 info 告警 | [telegram.ts](../../src/alerts/telegram.ts) `AlertThresholds` 加 `moderationZeroTrafficWindowMs=6h` / `Enabled=true`；`checkAndAlert` 主流程在 moderation 错误率 / 延迟之后追加 SELECT total，total=0 触发 info 告警，dedupTtl 6h | prod version `7b714ce8`（2026-06-03 04:46Z）；+2 测试用例（zero / non-zero） |
| M14 · chronic saw-tooth 告警（3h 内完成耗时 > 5min 的 ok 请求数） | [telegram.ts](../../src/alerts/telegram.ts) `AlertThresholds` 加 `analyzeSawToothWindowMs=3h` / `SlowThresholdMs=5min` / `MinCount=50`；`checkAnalyzeAndAlert` 末尾追加 SELECT slow_n（status=ok cached=0 且 completed_at-created_at > 5min），≥ 50 触发 warn 告警，dedupTtl 1h。检测 xAI partial degraded（错误率 0% 但延迟拉长） | prod version `7b714ce8`（2026-06-03 04:46Z）；+2 测试用例（slow_n=80 触发 / =10 不触发） |
| M28 · D1 size 24h 涨速监控告警 | [telegram.ts](../../src/alerts/telegram.ts) 新加 `getD1SizeBytes`（PRAGMA `page_count * page_size`）+ `checkD1SizeAndAlert`：daily cron 查 D1 size，与 KV snapshot 对比，delta ≥ warn(200MB) → warn / ≥ crit(500MB) → crit Telegram。首次跑只记 snapshot 不告警。snapshot TTL 3 天容忍 cron 单次 miss。`AlertThresholds` 加 `d1SizeDeltaWarnBytes` / `d1SizeDeltaCritBytes`。[index.ts](../../src/index.ts) 在 `5 0 * * *` cron 末尾接入 `checkD1SizeAndAlert(env)` | prod version `92df3daf`（2026-06-15 11:55Z）；+3 测试用例（first-snapshot / warn / below-warn）；182 passed 15 skipped；首次跑在下次 daily cron（06-16 00:05Z）|
| analyze_requests 90d cleanup 缺失（D1 涨速失控） | 巡查发现：2026-06-15 D1 size 769MB，6 天涨 474MB（28x baseline）。根因：[index.ts daily cron](../../src/index.ts) 只清 `moderation_requests` + `callback_deliveries`，**`analyze_requests` 从未被 cleanup**。叠加 IRC 06-09 后放量（峰值 06-11 43,433 单/天，avg 2.9KB/行包含 result_json 1.7KB + input_json 1.2KB），每天净增 ~80-130MB。10GB D1 cap 在持续放量下 ~110 天会触顶。<br/>修复：在 daily cron 加 `DELETE FROM analyze_requests WHERE created_at < ?`，**60d 保留期**（vs moderation 90d，因 analyze 单行更大且 IRC 业务侧已有自己的持久任务表）。每条 DELETE 独立 try/catch，与 moderation/callback 同模式 | prod version `7c674cb5`（2026-06-15 07:54Z）；143 tests passed / 15 skipped；首次 cron 在 06-16 00:05Z 触发，但 oldest analyze row=2026-05-21 距 60d cutoff 2026-04-16 还有 35d 余裕，所以本周不会真删；effective 时间在 7-19（5-21 + 60d）|
| Gemini dead code cleanup（gemini sunset + 5 天） | 验证窗：Gemini sunset 后 48h 内 0 调用，5d 内 0 调用，删 dead code 安全。改动：(1) 删 [src/providers/gemini.ts](../../src/providers/gemini.ts) 整文件。(2) [router.ts:getAdapter](../../src/providers/router.ts) gemini 分支改为显式 throw `PROVIDER_ERROR`（防御性，理论上不可达）。(3) [pipeline.ts](../../src/moderation/pipeline.ts) 删 `synthesizeGeminiSafetyReview` (M13) + `getErrorBody` helper（gemini 不再被路由到，safety filter 路径死代码）。fallback 链路结构保留 dormant 以便未来引入新 provider。(4) `test/admin-prompts.test.ts` 3 个 gemini dry-run 测试 `.skip`。`Provider` zod enum 保留 `gemini` 兼容历史 D1 行 | prod version `2ebf12af`（2026-06-09 18:22Z）；136 passed / 15 skipped；典型 health: mod 0 err / analyze 65 (30min) / pool 0 |
| M22 Phase 2 · 补 bio 真实中文生产 baseline | 跨会话期间已有 3 个 synthetic English baselines（id=3 bio×grok 英文合成 / id=4 media_intro×xai / id=5 media_analysis×xai），覆盖通用 patterns。本次加 id=6 `bio-grok-zh-prod-2026-06-09`（10 samples，真实生产 Chinese 内容）覆盖 prod 实际遇到的 idiom：飞行员/冰友（drugs）/ 学生弟（CSAM）/ 上门服务/快餐价格 / Q 号引流等。双 baseline 互补：英文合成跑语言泛化，中文 prod 跑实战 idiom 召回 | 已就位 2026-06-09 18:25Z；5 类 biz_type 全部有 baseline |
| M22 Phase 1 · prompt 回归集初版 baseline（comment + nickname） | 通过 admin POST `/admin/prompt-regression` 建两个回归集：(1) `comment-grok-baseline-2026-06-05` id=1，10 samples 覆盖 3 NSFW chat pass / 2 平台讨论 pass / 3 ad reject / 2 CSAM reject；(2) `nickname-grok-baseline-2026-06-05` id=2，10 samples 覆盖 NSFW handle pass / ad-多变体 reject / CSAM 黑话 reject / 冒官方 / 毒品黑话 / politics reject / 模糊 review。每条 sample 带 `expected` = `{status, risk_level, categories}`。改 prompt 前用 admin `/prompt-regression/{id}/run?draft_content=...` 即可 diff active vs draft。素材来自生产 30d 内 distinct content_hash | 已就位 2026-06-05 04:21Z（D1 wall clock，对应系统 06-05）；剩余 biz_type baseline（bio / avatar / media_analysis / media_intro）后续补 |
| Gemini 全平台下线（用户指令 2026-06-04） | (1) [grok.ts](../../src/providers/grok.ts) 加 image 分支：`args.isImage` 时切到 `GROK_VISION_MODEL`（默认 grok-4）+ `image_url` payload，文本仍走 grok-4-fast-non-reasoning。(2) [router.ts](../../src/providers/router.ts) `DEFAULT_ROUTE` 全部 biz_type（含 avatar）primary=grok fallback=null；`DEFAULT_ANALYZE_ROUTE` 全部 xai primary fallback=null；`resolveRoute`/`resolveAnalyzeRoute` strategy 退化为单一 xai/grok-only。(3) admin API 发布 `avatar:grok v1` prompt（id=31，复用 avatar:gemini 中文内容，contracts 兼容）。(4) demo-prod app `provider_strategy: auto → grok`。(5) 测试侧：providers-router.test.ts 重写 + 12 个 gemini-fallback-chain 测试 `.skip`（M13 safety filter / M16(c) gemini-fallback / media-analysis 多 gemini-primary / media-intro xai fallback gemini） | prod version `213defe6`（2026-06-04 22:18Z）；现有 gemini.ts adapter 保留为 dead code（不再被 router 调用）；KV `cb:gemini:*` 熔断器 key 自然过期；建议 7d 后做 cleanup pass 删 gemini.ts / GEMINI_API_KEY secret |
| M21 · media_analysis xai prompt v1 → v2 | 通过 [admin /prompts POST](../../src/routes/admin-prompts.ts) 发布 v2（id=30，prompts 表 active）。基于 prod 7d 数据观察：v1 reject 时 violations 数组 100% 用 `{category:"unknown", confidence:0, evidence:""}` 占位（即模型已写清 summary 但归类卡死）。v2 改进：(1) 显式列举 violation.category 词汇 `minor/non_consensual/bestiality/gore/offsite_ad/non_gay_male/drugs/gambling/political/other` 并禁止 `unknown` (2) 强制 `confidence > 0` + `evidence` 非空具体一句 (3) 新增 CLAUDE.md 铁律 0 零容忍类（drugs/gambling/political）(4) 强化"成人男同性 NSFW 是平台常态，NEVER reject"措辞 | prod prompt version 2（2026-06-04 21:40Z）；dry-run schema_ok 通过；v1 → v2 在 KV PROMPTS 60s 内全 edge 生效。**24h post-deploy 验证**：reject 案例的 violations.category 应不再是 `unknown`，evidence 应非空具体一句 |
| M16(c) · moderation 错误路径 provider 归因 | [pipeline.ts](../../src/moderation/pipeline.ts) 新加 `annotateProviderOnError(err, provider)`，tryProvider catch 块抛错前注入 `{ provider, body? }` 到 `AppError.details`；导出 `getErrorProvider(err)` helper。`synthesizeGeminiSafetyReview` 改用 `getErrorBody` 兼容 string + `{body}` 两种形态。[moderate.ts:213-229](../../src/routes/moderate.ts#L213) 写库时从 `err.details.provider` 提取，不再硬写 null。fallback 二次失败时 details 不被覆盖（保留 fallback provider 归因，与 IRC 实际感知一致） | prod version `a04efccb`（2026-06-04 21:30Z）；+1 测试用例（fallback failure carries fallback provider in details）<br/>**post-deploy 7d 验证**：`SELECT COUNT(*) FROM moderation_requests WHERE status='error' AND provider IS NULL AND prefiltered_by IS NULL AND created_at > <deploy_ts>` 应 = 0（baseline ~74/7d）|
| M3 Phase 1 · analyze 入口背压（hard_limit=2000 canary） | 新建 [backpressure.ts](../../src/analyze/backpressure.ts)（getPendingCountCached + getBacklogSeverity + enforceBackpressure），KV `kv:analyze:pending:count` 5min 缓存。[analyze.ts](../../src/routes/analyze.ts) POST 入口在鉴权/限流/参数校验通过后、写 D1 前拦截：count > 2000 返 503 + `error_code=backlog_overload` + `retry_after_seconds=30`；所有响应（含 202/503）始终带 `X-Analyze-Backlog` + `X-Analyze-Backlog-Severity: ok\|warn\|crit` header。[index.ts](../../src/index.ts) `*/5min` cron 末尾追加 `SELECT COUNT(*) WHERE status='pending'` 写 KV。[telegram.ts](../../src/alerts/telegram.ts) `checkAnalyzeAndAlert` 末尾加 pool 容量告警（warn 60% / crit 100%）。[errors.ts](../../src/lib/errors.ts) 加 `BACKLOG_OVERLOAD` enum | prod version `b76f95d7`（2026-06-04 20:16Z）；+10 测试用例（backpressure.test.ts 4 + boundaries / 现有 analyze 不破）<br/>**协商记录**：[ai2ai.md](../../ai2ai.md) 与 IRC agent 锁定契约，IRC 端 requeue 路径并行开发；待 IRC 追加 `IRC requeue ready` → 把 hard_limit 从 2000 降到 final 500（一行改 + 重部署）<br/>**RFC**：[m3-rfc-pending-pool-backpressure.md](m3-rfc-pending-pool-backpressure.md) Status=Locked |
| M26 · analyze cache hit rate 24h 告警 | [telegram.ts](../../src/alerts/telegram.ts) `AlertThresholds` 加 `analyzeCacheHitMinPct=30` / `WindowMs=24h` / `MinSample=100`；`checkAnalyzeAndAlert` 末尾追加 cache 检查段：低于阈值 + 样本充足 → 发 warn 告警（hit% < 阈值/3 升 crit）；dedupTtl=1h。背景：5-31 实测 cache 90.7%，若 KV/dedup 故障掉到 5% 则 token cost 暴涨 10x，之前完全无告警维度 | prod version `3c734dd6`（2026-06-01 19:30Z）；+3 测试用例（低 hit/低样本/健康基线）；首次实测窗口：本周内 |
| M16 (b) · `04-callback-spec.md` 加 `provider IS NULL` 语义说明 | [docs/04-callback-spec.md](../04-callback-spec.md) 表格 `provider` 改 `enum \| null`；加子章节列出 NULL 的三种 by-design 场景（prefilter 命中 / 历史 sweep give-up / 错误路径丢归因）+ admin 查询建议 | 2026-06-01 19:30Z 文档生效 |
| M24 · IRC handoff doc 加 `biz_types` 字段语义说明 | [docs/apps/IRC-analyze-handoff.md](../apps/IRC-analyze-handoff.md) 加 `apps.biz_types` 字段语义章节，说明 IRC analyze app `biz_types=[]` 是 by-design（不是漏配），并交叉引用 moderate.ts 与 prompts 表 | 2026-06-01 19:30Z 文档生效 |

## 事故复盘

### 2026-05-27 16:22 ~ 17:37Z · xAI team_blocked 第二次（24h 内复发）— 已 closeout

**时间线**（UTC）：

| 时刻 | 事件 | pending | 备注 |
|---|---|---|---|
| ~16:20 | xAI 又返 `team_blocked=true` | 累积起步 | 距上次事件（05-26 21:34Z）约 19 小时 |
| 16:22 (T+~5) | /loop 巡检捕获 `pending>5m=169` | 169 | mod 也 2/2 100% 错（fallback gemini 400 — M13 此时尚未部署） |
| 16:37 (T+~20) | pending5m **409**, total 493 | 493 | 15 min 内 +240 |
| 16:52 (T+~35) | xAI `team_blocked=false`，第二次自愈 | 683 peak | 比第一次（33 min）慢 |
| 17:06 (T+~50) | M8/M11/M12/M13 fix 部署 prod `4db2d7b8` | 620 | 在恢复阶段顺势升级 |
| 17:07 (T+~51) | pending 开始大幅消化 | 620→471 | M8 5min cron 已开始生效 |
| 17:22 (T+~66) | 池 471 | 471 | -149 / 15min |
| 17:37 (T+~81) | 池 212 | 212 | -259 / 15min（消化加速） |
| 17:52 (T+~96) | 池 159 | 159 | — |
| 18:22 (T+~126) | 池 24 | 24 | 接近 closeout |
| 18:52 (T+~156) | 池 10 | 10 | 事故 closeout |

**业务影响**：
- IRC analyze 80 min 内 pending 池峰值 683，错误率 0%（队列重试 + 自然消化）
- moderation 100% err（comment fallback gemini 400）— 这是 **M13 修复的精确场景**，下次复发预期变 status=review 不阻塞业务

**与 2026-05-26 21:34Z 那次同根因**：xAI 平台层对该账号 team-level 屏蔽。**24h 内两次** = 账号侧风险（billing / 信用卡 / xAI 风控），需要外部排查根因。

**4h 监控后续观察（17:06 ~ 21:13Z）**：
- 没再发生新的 team_blocked
- pending5m 长期在 5-83 间 saw-tooth（xAI 仍有 chronic partial degradation），符合 M14 描述
- 错误率持续 0%，业务无可见影响

---

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

#### M3 · 🔴 **P1 紧急** · analyze 在 provider 长时间 down 时的无界 churn

**📄 RFC 已就绪**：[m3-rfc-pending-pool-backpressure.md](m3-rfc-pending-pool-backpressure.md)（2026-06-03 起草）。下一步：与 IRC agent 对齐 hard_limit 数值 + IRC 侧 503 处理承诺。

- **升级原因（2026-05-28~29 事故坐实）**：第 4 次 team_blocked 持续 ~13.5h，analyze pending 池从 0 涨到 **14000+**。xAI 恢复后队列吞吐≈流入，backlog 长时间清不动。
- 2026-05-26 03–09Z 也复盘过：grok auth_failed → 熔断 open → fallback gemini → gemini 429 → 4,746 条 `service_unavailable`
- **现状**：strategy=grok 时 fallback=null，circuit open → 请求保持 pending，由 sweep 无限重投（见 M9）。pending 池无上限增长。
- **改法**：
  - analyze 类（async + delivery_mode=pull/both）在 primary circuit open 且无可用 fallback 时，**保持 pending 但不无限重投**（配合 M9 的重试上限）
  - 给 pending 池设软上限 / 背压：超过阈值时对新请求直接返 503（让 IRC 侧降速），而不是无脑收下再积压
- 影响 [src/analyze/pipeline/media-analysis.ts:145-154](../../src/analyze/pipeline/media-analysis.ts#L145-L154)、[src/analyze/pending-sweep.ts](../../src/analyze/pending-sweep.ts)
- **验收**：模拟 provider 持续 down，pending 池增长应有上限、不再无界；恢复后能正常消化

#### M9 · 🔴 **P1 紧急** · pending sweep 无限重入队（无终止条件）
- **升级原因（2026-05-28~29 事故坐实）**：[sweepAnalyzePending](../../src/analyze/pending-sweep.ts) 每 5 min 把 `pending > 5min` 的请求（≤500 条/次）**无条件重投** ANALYZE_QUEUE，**没有重试次数/最大寿命上限**。team_blocked 13.5h 期间这制造了持续的 CF 侧空转（Worker 调用 + D1 写 + Queue 操作 + DLQ 堆积），且 14000 backlog 永远不会被标 error 退出 pending 池。
- **确认无害的部分**：熔断器（`cb:xai:media_analysis` open）让这些重投在打 xAI 前就 fast-fail，**没有 token 消耗、没有 xAI 请求洪流**（实测封禁期 token≈0）。代价纯在 Cloudflare 侧。
- **改法**：
  - sweep 给每条 pending 加"最大寿命/重试次数"上限（如 created 超过 2h 或重投 N 次）→ 标 `status=error, error_code=pending_timeout` 并发终态 callback，退出 pending 池
  - 需要 attempts 计数：加 `analyze_requests.sweep_attempts` 列（migration 只追加），或用 created_at 年龄近似
  - give-up 也要 LIMIT 分批，避免一次性生成上万条 callback
- **验收**：provider 长 down 时，pending 池有上限；超龄请求转 error 让 IRC 侧可重提；DLQ 不再无限堆积

#### M10 · xAI 部分降级时熔断器无感（事故衍生）
- **现状**：熔断器要求"连续 5 次失败"才 open（[circuit.ts:16](../../src/providers/circuit.ts#L16)），`canTry()` 才会切到 fallback
- **问题**：xAI 在 partial degraded（如成功率 50%）时不会触发熔断，每个请求都"先打 xAI 失败再丢"；本次事故中 21:34-22:07 这 33 min 全部是这种状态
- **改法**：
  - (a) 降低 fail threshold 到 3
  - (b) 引入"成功率窗口"——10 个请求里失败 ≥ 6 就 open（更贴合现实流量）
  - (c) 加 latency-based circuit（连续 N 次 > 阈值也 open）
- **配合 M1**：如果同时让 strategy=grok 的 fallback 不为 null，部分降级时就能自动切 gemini，减少业务感知
- **优先级**：P3，因为熔断目前是"防止持续打不通"，不是"加速切换"

#### M14 · 长尾低强度 saw-tooth 监控（chronic 状态）
- **观察**：2026-05-27 04:38Z 起持续 7+ 小时 xAI 间歇性故障，pending5m 在 8-79 间震荡，错误率 0% 但 IRC 体验慢
- **特征**：不触发现有任何阈值告警（err_rate 0% 因为重试覆盖；pending<200 不触发突发告警）
- **现实风险**：长尾期间 IRC 业务体感延迟从平时 ~2s 拖到 ~30s+，但 ai-guard 报告全绿
- **改法**：
  - (a) 加 "持续 3h 内 pending5m 平均 >20" 阈值告警
  - (b) 或 Admin UI Dashboard 加 "pending 滑动窗" 趋势图，让人眼能看出 saw-tooth
- **优先级**：P3，体验问题不是 SLA → **2026-05-30 巡查印证：见 M17 的硬数据**

#### M17 · 🟡 P2 · analyze vision 工作负载延迟基线确立 + 优化空间
- **数据**（2026-05-30 巡查 D1 聚合，`status=ok AND cached=0`）：

  | 日期 | n | avg_lat | max_lat |
  |---|---|---|---|
  | 2026-05-23 | **2** | 697 ms | 728 ms |
  | 2026-05-25 | 4070 | 11236 ms | 89136 ms |
  | 2026-05-26 | 5772 | 11523 ms | 85218 ms |
  | 2026-05-27 | 4518 | 8741 ms | 69144 ms |
  | 2026-05-28 | 3973 | 12000 ms | 64180 ms |
  | 2026-05-29 | 1883 | 11679 ms | 62027 ms |
  | 2026-05-30 | 4 | 10828 ms | 16419 ms |

- **澄清**：5-23 的 n=2 / 697ms 是 dev 期单图小样本，**不是合规基线**；IRC 流量从 5-25 上量后 avg_lat 稳定在 9~12s — 这是 grok-4 + `detail=high` + 多图 vision 的工作负载本身代价（见 [xai-media.ts:26-42](../../src/analyze/providers/xai-media.ts#L26-L42)），不是性能退化。
- **真问题**：
  1. **max_lat 60-90s** 已逼近 timeout，单次抖动可能直接 timeout → 用户感知"卡死"
  2. avg_lat 11s 对 IRC 异步拉取没问题，但所有 `auto` 模式 sync 请求都被自动降级 async（默认 SYNC_TIMEOUT_MS=10000ms），用户体验是 "立即响应转后台等"
  3. 一旦 IRC 流量恢复峰值（4000+/天），账单也按 vision token + image 算费——M6 还没把 image 计费打进 cost 看板
- **可优化方向**（按 ROI 排序）：
  - (a) **降图数**：检查 IRC 是否真的每个请求都送 6 张帧，能否降到 3 张 → 直接砍 50% 延迟和成本
  - (b) **detail: "low"**：6 张图全 high 是 156 tokens/image，low 是 ~85 tokens/image。多数 NSFW 判定不需要 high 细节
  - (c) **试 `grok-4-fast` vision**：如果 xAI 已上线 fast vision tier，可能 50% 时延
  - (d) **R2 image 链路**：image_url 走外网拉，xAI 也要再拉一次。能否预 base64 内联减少一次跳？
- **首要建议**：先 **加 p95 latency 监控**（M4 升级），把今天的 ~12s 作为**正式基线**入库；任何未来涨到 > 15s 持续 24h 就告警。这样无论 xAI 是否再退化，我们都能在 2 天内发现。
- **优先级**：P2 — 不阻塞业务（异步 mode 工作正常），但代表未优化的成本和未来回归的盲区
- **入口**：[src/analyze/providers/xai-media.ts:26-42](../../src/analyze/providers/xai-media.ts#L26-L42)（`GROK_MEDIA_MODEL` + `detail: "high"`）

  > **5-23 到 5-25 之间的 commits**（确认无 ai-guard 侧引入延迟的改动）：
  > - 3447ead (5-25 20:10) accept raw frame quality scores — schema 容忍
  > - 33193c7 (5-25 22:17) honor app provider strategy — 路由
  > - 595fbbf (5-25 22:23) normalize loose media analysis output — schema 容忍
  >
  > 全是 schema 容错与路由微调，不动 fetch 链路。所以 avg 11s 是真实 vision 工作负载，不是 ai-guard 端 bug。

#### M16 · 🟡 P2 · moderation prefilter 路径 `provider=null` 观测混淆
- **数据**（2026-05-30 巡查 7d 聚合）：

  | prefiltered_by | status | provider_is_null | n |
  |---|---|---|---|
  | NULL | pass | 0 | 268 |
  | low_signal | pass | 1 | 114 |
  | NULL | error | 1 | 74 |
  | NULL | review | 0 | 46 |
  | NULL | reject | 0 | 19 |
  | ad:qq_number | reject | 1 | 13 |
  | ad:phone_cn | reject | 1 | 4 |

- **本质**：`provider IS NULL <=> prefiltered_by IS NOT NULL`（131 条）。前置漏斗命中时不打模型，写库时 provider=null **是 by-design**（[moderate.ts:88-103](../../src/routes/moderate.ts#L88-L103) 的 pf 路径直接写）。但 74 条 `provider=null AND prefiltered_by IS NULL AND status=error` 是真"丢归因"。
- **影响**：
  - Admin UI / 告警 SQL 按 `provider` group by 时出现"NULL 桶"，需要每个查询点手动 join `prefiltered_by`
  - 错误归因丢失：error 路径下 `provider=null` 既可能是 prefilter（应正常），也可能是 provider_error 没拿到 provider 名（应记录）
- **改法**：
  - (a) 显式列：在 `moderation_requests` 写一个 `provider_label`（虚拟列或 view），prefilter 命中时 = `'prefilter:<tag>'`，错误丢归因时 = `'unknown'`；告警 / 看板用它
  - (b) 文档化：在 [docs/04-callback-spec.md](../04-callback-spec.md) 显式注明 NULL provider 的含义
  - (c) 修改错误路径：`moderate.ts:211-228` 错误捕获时若已知失败 provider，把 provider 名也写库（需要 AppError.details 带 provider 字段）
- **建议优先级**：P2。(b)（文档）今天可做，(a)/(c) 是 dashboard 改时一并做
- **入口**：[src/routes/moderate.ts:88-103](../../src/routes/moderate.ts#L88-L103)、[src/routes/moderate.ts:211-228](../../src/routes/moderate.ts#L211-L228)

#### M26 · 🟡 P2 · cache hit rate 是隐性成本基线，缺专门告警
- **数据**（2026-06-01 巡查 analyze 7d）：

  | 日 | 总单 | cache_hit% | distinct_inputs |
  |---|---|---|---|
  | 5-25 | 9989 | 37.4% | 4161 |
  | 5-26 | 19150 | 41.2% | 5765 |
  | 5-27 | 9646 | 52.4% | 4611 |
  | 5-28 | 12493 | 52.5% | 4807 |
  | 5-29 | 15324 | **9.9%** ⚠️ | 2239（事故期间 sweep 标 error，cached=0） |
  | 5-31 | 2415 | 90.7% | 828 |

- **成本敏感度**：5-31 流量 2415 单，按当前 90.7% cache 只打 226 单 LLM。若 cache 链路故障掉到 5%，要打 2294 单 ≈ **10 倍 token cost**；按 grok-4 vision 平均 750 input tokens/请求估算，单日成本从 ~$1 飙到 ~$10-15
- **链路脆弱点**：
  - (a) KV DEDUP_CACHE 故障（Cloudflare KV outage）
  - (b) `dedupKey(biz_type, primary_provider, prompt_version, content_hash)` 算法变更 → 全局失效
  - (c) prompt 升级（prompt_version + 1）→ 全部 cache 失效是 by-design，但缺成本爬坡告警
- **建议改法**：
  - (a) 短：[telegram.ts](../../src/alerts/telegram.ts) 加 `cache_hit_pct_24h < 30%` 阈值告警（analyze 类）
  - (b) 中：admin UI / dashboard 加 cache hit 趋势图（M6 升级时一并做）
  - (c) prompt 升级触发"全 cache 失效成本爬坡预期 + 1h 后验证"工作流
- **优先级**：P2 — 现在没真问题，但 cache 故障是 silent expensive failure
- **入口**：[telegram.ts:checkAndAlert](../../src/alerts/telegram.ts)、[dedup.ts](../../src/moderation/dedup.ts)

#### M25 · 🟡 P2 · analyze sweep `provider=null` 把 30% 请求计入 stats_rollup `unknown` 桶
- **数据**（2026-05-31 22:35Z 巡查）：

  | provider 桶 | rollup rows | total_requests | 占比 |
  |---|---|---|---|
  | xai | 9 | 45818 | 64.4% |
  | **unknown** | **78** | **21277** | **29.9%** |
  | grok | 98 | 3067 | 4.3% |
  | gemini | 23 | 967 | 1.4% |

- **来源拆解**（analyze_requests 全表）：

  | 维度 | 数量 |
  |---|---|
  | 总 status=error | 21779 |
  | error 且 provider IS NULL | 18778（86%） |
  | error_code='pending_timeout'（sweep 写的） | 13952（64%） |

- **根因**：[pending-sweep.ts:38-50](../../src/analyze/pending-sweep.ts#L38-L50) sweep give-up 路径调 `completeAnalyze({...provider: null, model: null, prompt_version: null...})`；[rollup.ts:35](../../src/stats/rollup.ts#L35) `COALESCE(provider, 'unknown')` 把它们打到统一 unknown 桶
- **历史背景放大**：2026-05-28~29 14000 backlog 事故里这条路径被密集触发；现在 sweep 累计 expired ≈ 13952，是 unknown 桶的主成分
- **业务影响**：Admin UI / dashboard 按 provider 切 cost / latency / 错误率时，会有 30% 流量被算到"unknown"，影响成本归因 + 告警 SQL 写法
- **建议改法**（按 ROI）：
  - (a) **短**：sweep give-up 写 provider 时回填"原 intended provider"（IRC analyze 一律 xai）—— 改一行；新数据立刻干净
  - (b) **中**：[rollup.ts](../../src/stats/rollup.ts) 把 `prefiltered` / `sweep_expired` 拆成专用 bucket（'prefilter:low_signal' / 'sweep:expired' 等），不混 provider
  - (c) **长**：admin UI 按"原因层"展示（success / cached / prefilter / sweep / error），而不是直接按 provider 切
- **优先级**：P2 — 历史 21277 unknown 数据没法回填，但今后流量按 (a) 改后 30d 内 unknown 占比会自然滑降到 < 1%
- **入口**：[pending-sweep.ts:38-50](../../src/analyze/pending-sweep.ts#L38-L50)、[rollup.ts:35](../../src/stats/rollup.ts#L35)、[admin-stats.ts](../../src/routes/admin-stats.ts)

#### M22 · 🟡 P2 · `prompt_regression_sets` 表生产为空（无 prompt 回归保护）
- **数据**（2026-05-31 巡查）：`SELECT biz_type, COUNT(*) FROM prompt_regression_sets GROUP BY biz_type` → 0 行
- **工具链假设**：[.claude/skills/tune-prompt/](../../.claude/skills/tune-prompt/) 设计上依赖该表做 prompt 改动的"金线"对比；[test/admin-prompt-regression.test.ts](../../test/admin-prompt-regression.test.ts) 测的是接口，没填生产数据
- **现实**：bio/comment/nickname/avatar prompt 已迭代 3-4 版，每次都靠开发者手工 dry-run，无自动回归保护
- **风险**：[CLAUDE.md] 铁律 2 要求 prompt 只决定"如何判断"不能决定"输出结构"——schema 变了一定坏；但 prompt 变了不一定立刻坏，可能 ROC 偏移几天才发现
- **行动**：
  - (a) 从 production moderation_requests 采样高代表性 case（10/biz_type，覆盖 pass/reject/review）
  - (b) 标注 expected status + risk_level，入 `prompt_regression_sets`
  - (c) 改 prompt 前 admin UI 一键跑回归，diff 输出 → 通过率 < 阈值不让发布
- **优先级**：P2 — 单 app 暂能扛，多 app 接入后必上

#### M23 · 🟢 P3 · 数据库残留测试 app
- **数据**：`apps` 表中 `rl-strict` (qps=1) 和 `ratelimit-test` (qps=2) 是 2026-04-23 注册的限流测试 app，已不再使用
- **影响**：Admin UI app 列表混杂；HMAC secret 仍有效，理论上若被扫到可冒充
- **行动**：(a) 物理删除（如果 D1 上无外键引用就安全）；(b) 加 `status='archived'` 列做软删除
- **优先级**：P3 — 治理向

#### M24 · 🟢 P3 · IRC analyze app `biz_types=[]` 字段语义易混淆
- **数据**：`app_50b5c734c751d589 (IRC-资源中心)` `biz_types=[]`，但同时跑 media_analysis 流量稳定
- **原因**：analyze 路径不读 `apps.biz_types`（只 [moderate.ts:44](../../src/routes/moderate.ts#L44) 用它做 moderation biz 准入）；analyze 准入通过 prompt 表 + provider 路由
- **现状无 bug**，但运维新人看到 `biz_types=[]` 会误判"这 app 啥都不能用"
- **行动**：(a) 引入 `analyze_biz_types` 列做明示；(b) 或在 admin UI 显示"该 app 已启用 N 种 analyze biz" 并跳到 schema/envelope.ts 的 ANALYZE_BIZ_TYPES 常量
- **优先级**：P3 — 仅文档化/可读性，业务无关

#### M21 · 🟢 P3 · media_analysis / media_intro prompt 仍 v1（IRC 上线初版）
- **数据**（2026-05-31 巡查 active prompts）：

  | biz_type | provider | active v |
  |---|---|---|
  | avatar | gemini | 3 |
  | bio | grok / gemini | 4 / 4 |
  | comment | grok / gemini | 3 / 3 |
  | nickname | grok / gemini | 4 / 4 |
  | media_analysis | xai / gemini | **1 / 1** |
  | media_intro | xai / gemini | **1 / 1** |

- **含义**：除 media_* 都已迭代到 v3-v4，IRC analyze 上线一周内累积了约 22000 单 ok+cached=0 样本（M17 数据）+ 一批 review/error 样本，**有足够素材对 media prompt 做一次基于数据的精调**
- **建议方向**：
  - (a) 抓 status=review 的样本，看哪些场景是"模型不确定"，加规则
  - (b) 抓 SVF（schema_validation_failed）样本，找 LLM 喜欢偏离的字段
  - (c) prompt 增加"成人男同社交"定位说明（CLAUDE.md 铁律 0），避免 LLM 自带性向偏见判 reject
- **入口**：[.claude/skills/tune-prompt/](../../.claude/skills/tune-prompt/)（已有 skill 框架）
- **优先级**：P3 — 业务可用，是优化向，不阻塞

#### M18 · 🟡 P2 升级 · moderation pending_timeout 根因找到（sync auto mode + waitUntil 不保证）
- **数据**（2026-06-01 巡查 14d）：

  | mode | biz_type | n |
  |---|---|---|
  | auto | comment | 25 |
  | auto | nickname | 7 |

  → **100% 是 `mode=auto`** + 纯文本 biz_type（无 avatar，因 avatar 自动降级 async）
- **根因定位**：
  - [moderate.ts:213-229](../../src/routes/moderate.ts#L213-L229) 错误路径 + [moderate.ts:234-250](../../src/routes/moderate.ts#L234-L250) 成功路径都用 `c.executionCtx.waitUntil(recordCompleted(...))` 写库
  - `waitUntil` 是 fire-and-forget，CF 文档承诺"最多 30s after response"但**不保证 100% 完成**：worker CPU 限额、客户端 abort 后 waitUntil 边界、平台重启等都可能让它丢
  - 写库丢失 → row 保持 status=pending → 5min 后被 sweep 标 `pending_timeout`
  - 注释 `用 waitUntil 保证客户端断开后写入也完成` 实际反了——waitUntil 让响应立刻返回但不保证写完，await 才是保证
- **建议修复**（按 ROI）：
  - (a) **短**：[moderate.ts](../../src/routes/moderate.ts) 两处 `c.executionCtx.waitUntil(recordCompleted(...))` 改成 `await recordCompleted(...)`。代价：sync API 响应延迟 +30-80ms（D1 写）；收益：杜绝单条 pending_timeout 损耗
  - (b) 折中：写库前 `Promise.race([recordCompleted, sleep(2000)])`，2s 内完成就 await，否则降级 waitUntil
  - (c) 不动代码，接受 1-2/h baseline 损耗（成本极低，IRC 业务侧能容忍 5min 后收 error callback）
- **建议**：(a)。沪上 P95 LLM 调用 ~3-12s，+50ms D1 写完全淹没在那里
- **优先级升级 P3→P2**：根因明确，修复成本低，杜绝长期 baseline 噪声 + 改善 M19 假阳的根源
- **入口**：[moderate.ts:213](../../src/routes/moderate.ts#L213)、[moderate.ts:234](../../src/routes/moderate.ts#L234)
- **附记 2026-05-30**：M19 已修告警侧的低流量假阳；本次 M18 是修写库根因，两者互补不重复

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

## 运行中的监控基线（snapshot 2026-05-31）

| 路径 | 状态 | 备注 |
|---|---|---|
| Worker `*/5` cron alert check | ✅ 跑 | M19 后 err_rate 增加 `min_errors=2` 绝对量保护 |
| Worker 每 5 min provider-health 巡检 | ✅ 跑 | M8 后 hourly → 5 min；team_blocked 检测盲区从 26 min 收窄到 5 min |
| Worker `5 0 * * *` daily cleanup + rollup + heartbeat | ⚠️ 修复中 | M20：DELETE 抛错原会带挂下游；prod `dba666e6` 起独立 try/catch；2026-06-01 00:05Z 验证 |
| Telegram crit/warn 告警 | ✅ | Bot token + chat ID 双 secret；dedup KV；M11/M12 team_blocked 专项 + 复发升级 |
| `/loop` 15min D1 巡检 | ✅ session-only | 见 M2 |
| wrangler tail 常驻 Monitor | ❌ 不挂 | Windows libuv 长连接不稳；按需 60s 短窗 |
| callback delivery 健康度 | ✅ baseline | 2026-05-31 巡查：7d 内 68437 条 100% delivered 200 OK，max_attempts=2，零 give_up |

## 后续触发点

- 任一 worker 部署后，跑一次本文档的 [docs/07-runbook.md](../07-runbook.md) smoke
- 月底如果 Telegram 没收到 weekly heartbeat → 告警通路本身死了，按 [memory wrangler-secret-put-newline-pwsh](#) 类似套路排查
- IRC 灰度从 50% → 100% 时，重新巡检 analyze-ops 灰度门禁与 backlog
