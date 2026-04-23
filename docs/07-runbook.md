# 07 · 运维手册

本地与线上出问题时的处置步骤。

## 线上访问点

| 类型 | URL |
|------|-----|
| Prod API | https://aicenter-api.1.gay |
| Prod API（workers.dev 兜底） | https://ai-guard.schetkovvlad.workers.dev |
| Dev API | https://ai-guard-dev.schetkovvlad.workers.dev |
| Admin UI | https://aicenter.1.gay |
| Admin UI（pages.dev 兜底） | https://ai-guard-admin.pages.dev |
| 架构图 | https://aicenter-api.1.gay/architecture |

## 常用命令

```bash
# 本地开发
pnpm dev                          # wrangler dev，含 D1/KV/Queue 模拟器
pnpm test                         # vitest
pnpm -s typecheck                 # tsc --noEmit

# 部署
wrangler deploy --env dev
wrangler deploy --env prod        # 必须先 dev + smoke

# D1
wrangler d1 migrations list ai-guard
wrangler d1 migrations apply ai-guard --env dev
wrangler d1 execute ai-guard --env dev --command "SELECT count(*) FROM apps"

# KV
wrangler kv key list  --binding=DEDUP_CACHE --env dev
wrangler kv key get   --binding=PROMPTS --env dev "comment:grok:active"

# Queue
wrangler queues list
wrangler queues consumer list ai-guard-moderation

# 观测
wrangler tail                         # prod (top-level env)
wrangler tail --env dev               # dev
wrangler tail --search "error_code=provider_error"

# 手动触发告警检查
curl -X POST https://aicenter-api.1.gay/admin/alerts/check \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

## 应急场景

### ① 上游 Provider 故障

**症状**：Admin UI 报 `provider_error` 激增；`wrangler tail` 里大量 502/503。

**处置**：
1. 在 Admin UI → Apps 页临时提升 `rate_limit_qps=0`（断流）或保留但降速。
2. 确认熔断是否自动切备：查 KV `CIRCUIT_STATE`（Phase 2 规划）。
3. 如主备都挂，临时在 `/admin/prompts/*/test` 接口打开"审核降级"——本次 MVP 不实现自动降级为放行，**默认 `status=error` 让应用自决**。

### ② DLQ 堆积

**症状**：`CALLBACK_QUEUE-DLQ` 非空，应用抱怨收不到回调。

**处置**：
1. `wrangler queues dlq list ai-guard-callback`
2. 逐条查 `callback_deliveries.last_error`，常见原因：
   - 应用端 callback_url 挂了 → 联系业务方。
   - 签名算法不匹配 → 核对 [docs/04](04-callback-spec.md)。
3. 修复后 Admin UI → Callbacks 页批量 retry，或 `wrangler queues dlq retry`。

### ③ D1 写入慢

**症状**：P95 飙高、`d1_query_error` 日志。

**处置**：
1. `wrangler d1 insights --env prod`（CF 提供的慢查询分析）。
2. 检查热写表索引（`moderation_requests`）。
3. 考虑把写操作移到 Queue（异步落库）。

### ④ KV 缓存污染

**症状**：改了 prompt 但线上仍走旧结果。

**检查**：
- `PROMPTS` KV 是否更新（TTL 60s，最多 1 分钟生效）。
- `DEDUP_CACHE` 的 key 是否含新 `prompt_version`——如果没有，这是 **bug，立即修复 `src/moderation/dedup.ts`**。

**临时处置**：
```bash
wrangler kv key list --binding=DEDUP_CACHE --env prod --prefix "comment:" | \
  jq -r '.[].name' | xargs -I{} wrangler kv key delete --binding=DEDUP_CACHE --env prod "{}"
```
⚠️ 会短期拉高 token 成本，仅应急。

### ⑤ 密钥泄漏

**处置**：
1. Admin UI → Apps → 该 app → "轮换密钥"。
2. 新密钥给应用方，**老密钥立即失效**（`APPS` KV 立刻更新 hash）。
3. 在 `moderation_requests` 里排查该 `app_id` 最近 24h 可疑请求（大量拒绝 / 异常 user_id）。

### ⑥ 生产部署回滚

```bash
wrangler rollback --env prod                    # 上一个版本
wrangler rollback --env prod --version-id <id>  # 指定版本
```

D1 migration 不可回滚——只能用"新增迁移撤销"的方式前滚。

## 密钥轮换

### 应用密钥
Admin UI → Apps → 目标 app → "轮换密钥" 即可。

### HMAC_MASTER / GROK_API_KEY / GEMINI_API_KEY

```bash
wrangler secret put GROK_API_KEY --env prod
# 粘贴新 key
```
Worker 自动在下次请求生效（边缘会拉新版本）。**旧请求中的 HMAC 签名仍能工作**，因为 app secret 是独立的。

## 监控与告警（已实现）

| 指标 | 阈值 | 通道 |
|------|------|------|
| 错误率 / 5min | ≥ 5%（≥20% crit） | Telegram |
| 最高延迟 / 5min | ≥ 15s | Telegram |
| 最小样本 | 20 条/窗口 | 低于此数不判定 |
| 去重 | 同类型 5 分钟内只发一次 | 防刷屏 |

实现：`src/alerts/telegram.ts`；Cron 每 5 分钟 (`*/5 * * * *`) 触发。
secret：`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（通过 `wrangler secret put` 配置）。
未配置 secret 时 Cron 仍然跑，只是告警不发出（不报错）。

手动测试：
```bash
curl -X POST https://aicenter-api.1.gay/admin/alerts/test \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

## 联系方式

- **平台负责人**：TBD（添加到 docs/00-overview.md）
- **代码仓库**：TBD
- **工单**：TBD
