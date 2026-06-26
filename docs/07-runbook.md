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

## Dev e2e 冒烟测试账号

**仅 dev 环境**的常驻测试 app，供签名 e2e 冒烟用。secret 仅在 dev 有效（dev 是无真实用户/PII 的弃用环境，故可入档）；**prod 严禁复用此 secret**。

| 字段 | 值 |
|------|-----|
| `APP_ID` | `app_e2e_smoketest` |
| `SECRET` | `35d500c11b50be38537f0413b91b26d19d6ee3e0f4040e19541c4569abdafda5` |
| biz_types | `comment, nickname, bio` |
| 环境 | dev only（`ai-guard-dev` D1） |

跑一次签名请求（`scripts/smoke.sh` 用文件签名，规避 CJK 转义问题）：

```bash
export APP_ID=app_e2e_smoketest
export SECRET=35d500c11b50be38537f0413b91b26d19d6ee3e0f4040e19541c4569abdafda5
export BASE=https://ai-guard-dev.schetkovvlad.workers.dev

# 广告引流（汉字数字 QQ）→ 期望 prefiltered_by=ad:cn_numeral_contact, status=reject
MODE=sync bash scripts/smoke.sh comment t1 "扣。三十四亿一千零四十三万七千四百八十九"
# 正常评论 → 走模型（dev grok key 为占位 key，会返回 provider_auth_failed，属预期）
MODE=sync bash scripts/smoke.sh comment t2 "这个电影真不错"
```

若账号丢失，重建：

```bash
wrangler d1 execute ai-guard-dev --remote --file=- <<'SQL'
INSERT OR REPLACE INTO apps
 (id, name, secret, callback_url, biz_types, rate_limit_qps, disabled, provider_strategy, created_at)
VALUES
 ('app_e2e_smoketest', 'e2e-smoketest (dev only)',
  '35d500c11b50be38537f0413b91b26d19d6ee3e0f4040e19541c4569abdafda5', NULL,
  '["comment","nickname","bio"]', 50, 0, 'auto', strftime('%s','now')*1000);
SQL
```

> 注：dev 的 `apps` 表落后 prod（缺 `analyze_biz_types/delivery_mode/callback_max_concurrency` 列，migration 0007 未在 dev 应用）。上面 INSERT 故意只用 dev 现有列；代码读取时这些缺列走默认值。prod 做 e2e 请临时建号、测完即删，不要常驻。

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

### ③ moderate pending timeout

**症状**：Telegram 收到 `ai-guard · moderate pending 超时`，或 Admin UI `/requests` 中出现 `error_code=pending_timeout`。

**系统自动动作**：

1. Cron 每 5 分钟扫描 `moderation_requests.status='pending'` 且创建时间超过 5 分钟的请求。
2. 将其标记为 `status=error`、`error_code=pending_timeout`、`reason=Worker 未完成（sweep）`。
3. 重新投递 callback 队列，让接入方收到最终 `error` 回调。
4. 发送 Telegram 告警，附带样本 `request_id` 和后台链接。

**管理后台处理**：

1. 打开 Admin UI → `/requests?status=error`，找到 `reason=Worker 未完成（sweep）` 或详情里的 `error_code=pending_timeout`。
2. 再打开 `/requests?status=pending`，确认是否还有未完成积压。
3. 如果 `pending=0` 且只有少数历史 `pending_timeout`：通常是 Worker/Queue 短暂中断，观察即可。
4. 如果持续新增：检查 `wrangler tail`、Queue consumer、provider circuit、最近部署版本，并临时通知接入方关注 error callback。
5. 对文本类记录可在详情页使用 replay 评估当前 provider/prompt 是否正常；replay 不会改写原记录。

### ④ D1 写入慢

**症状**：P95 飙高、`d1_query_error` 日志。

**处置**：
1. `wrangler d1 insights --env prod`（CF 提供的慢查询分析）。
2. 检查热写表索引（`moderation_requests`）。
3. 考虑把写操作移到 Queue（异步落库）。

### ⑤ KV 缓存污染

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

### ⑥ 密钥泄漏

**处置**：
1. Admin UI → Apps → 该 app → "轮换密钥"。
2. 新密钥给应用方，**老密钥立即失效**（`APPS` KV 立刻更新 hash）。
3. 在 `moderation_requests` 里排查该 `app_id` 最近 24h 可疑请求（大量拒绝 / 异常 user_id）。

### ⑦ 生产部署回滚

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
| analyze 错误率 / 5min | ≥ 5%（≥20% crit） | Telegram |
| analyze 最高延迟 / 5min | ≥ 90s | Telegram |
| analyze pending 超时 | > 5min | Telegram |
| analyze pull 未 ack | ≥20 条且 > 2h | Telegram；仅统计 `pull` 或 `both` 且 callback 也未送达的兜底未消费 |
| analyze callback 未投递 | ≥1 条且 > 30min | Telegram |
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

### IRC analyze 7 天观察

灰度期保持以下节奏：

1. Telegram 自动监控每 5 分钟执行一次，覆盖 analyze 错误率、延迟、pending、pull ack、callback 未投递。
   同一周期会重扫 analyze pending request 与 analyze callback delivery：
   - pending >5 分钟：重新入 `ANALYZE_QUEUE`，provider 恢复后自动追赶。
   - callback 卡在 `attempts=0` 或到达 `next_retry_at`：重新入 `CALLBACK_QUEUE`。
2. 每天查看 `/analyze-ops`，确认 `pending_older_than_5m=0`、错误率低于 1%、provider 主要为 `xai`。
3. `/analyze-records?status=error` 中旧 `schema_validation_failed` 行是长留存审计；判断是否仍需处理时以“是否有更新 ok 记录”为准。
4. `unsupported_content` 且 input URL 为旧 `/duanvideo/` 的记录，交给 IRC 重新生成帧图 URL 后重新提交，不使用 admin reprocess。

## 联系方式

- **平台负责人**：TBD（添加到 docs/00-overview.md）
- **代码仓库**：TBD
- **工单**：TBD
