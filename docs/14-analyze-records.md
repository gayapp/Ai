# 14 · Analyze 调用记录与交付模式 ★

> 本文档**仅适用于 analyze 系业务**（`media_analysis` / `media_intro` 等）。moderate 系沿用 [02-api-public.md](02-api-public.md) + [04-callback-spec.md](04-callback-spec.md)，不受本文档影响。
>
> 本文档与 [12-content-service.md](12-content-service.md) 总览、[13-callback-spec-analyze.md](13-callback-spec-analyze.md) callback 契约配套；RFC 原文 [optimization/content-services-expansion.md](optimization/content-services-expansion.md) §5.4 + §8.2。

---

## 1. 留存策略

analyze 线与 moderate 线的数据性质完全不同，留存策略**显式分离**。

| 维度 | moderate 线 | analyze 线 |
|------|-------------|-----------|
| 输入性质 | 终端用户 UGC（评论 / 昵称 / 简介 / 头像 URL），合规敏感 | 资源元数据（image_urls / title / OCR / 字幕），非用户隐私 |
| 输入留存 | 不存原文，仅 `content_hash` | **`input_json` 完整长保留** |
| 结果留存 | KV `DEDUP_CACHE` 7d TTL；D1 行按既定 TTL 清理 | **`result_json` 完整长保留**（不 TTL） |
| 历史复跑 | 不支持 | 支持（input_json 可复跑、对账、A/B 比对新 prompt） |
| 合规依据 | [00-overview.md](00-overview.md) "非目标"节：不长期留存用户原始数据 | 资源元数据无 GDPR 类风险；业务方需要历史追溯 |

**承诺**：

- `analyze_requests.input_json` / `result_json` **不参与任何自动清理 cron**
- 如未来某 app 需要自定义留存策略，可走 `apps.analyze_retention_days`（默认 0=永久）—— 该字段当前未启用，需要时再加 migration
- Admin UI 提供「按 biz_id / 时间 / app 检索 analyze 调用记录」入口，可直接查看完整 `input_json` + `result_json`

---

## 2. 交付模式：callback + pull 双轨

### 2.1 三种模式

每个 app 的 analyze 业务可配置 `delivery_mode ∈ {callback, pull, both}`，默认 `both`。

| 模式 | 行为 | 适用 |
|------|------|------|
| `callback` | 完成时 POST 到 `callback_url`；不支持 pull / ack | 实时审核类、消费方公网可达 |
| `pull` | 不发 callback，结果留在 ai-guard 等消费方拉取 | 批量回填、内网部署、自主控速 |
| `both` | 完成时发 callback；同时允许 pull 兜底（投递失败 / 消费方重启） | **推荐默认**，最稳 |

### 2.2 请求级覆盖

单次 `POST /v1/analyze` 可通过 `delivery_mode` 字段覆盖 app 级配置（仅当 app 允许该模式时）。例如 app 配 `both`，某条批量请求显式 `delivery_mode: "pull"` 跳过 callback。

---

## 3. 新接口契约

> 所有接口沿用 [02-api-public.md](02-api-public.md) §「鉴权」的 HMAC 签名机制（X-App-Id / X-Timestamp / X-Nonce / X-Signature），GET / ack 请求 body 为空串。

### 3.1 `GET /v1/analyze/{request_id}` — 单次查询

幂等查询，用途：callback 接收失败后复查、确认某个 request_id 的最终状态。

**Response 200**：

```json
{
  "request_id": "01HXYZ...",
  "status": "ok",
  "biz_type": "media_analysis",
  "biz_id": "video-12345",
  "result": { /* ... 按 biz_type 的 result schema */ },
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "cached": false,
  "tokens": { "input": 4823, "output": 1102 },
  "latency_ms": 8431,
  "delivery_mode": "both",
  "delivered_at": "2026-05-19T08:00:01Z",
  "acked_at": null,
  "created_at": "2026-05-19T07:59:53Z",
  "completed_at": "2026-05-19T08:00:01Z"
}
```

**Response 404**：request_id 不存在或不属于该 app。

### 3.2 `GET /v1/analyze` — 批量 cursor 拉取

按 UUIDv7 时间序游标分页拉取，断点续拉。

**Query 参数**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `status` | enum | ✓ | — | `ok` / `error` |
| `biz_type` | string | | (all) | `media_analysis` / `media_intro` |
| `since_id` | UUIDv7 | | (empty) | 上次拉取的最大 id；首次留空 |
| `include` | enum | | `unacked` | `unacked` 只返未 ack 的 / `all` 返全部（含已 ack） |
| `limit` | integer | | 50 | 1..100 |

**Response 200**：

```json
{
  "items": [
    {
      "request_id": "01HXYZ001...",
      "status": "ok",
      "biz_type": "media_analysis",
      "biz_id": "video-12345",
      "result": { /* ... */ },
      "provider": "gemini",
      "tokens": { "input": 4823, "output": 1102 },
      "latency_ms": 8431,
      "delivery_mode": "both",
      "delivered_at": "2026-05-19T08:00:01Z",
      "acked_at": null,
      "created_at": "2026-05-19T07:59:53Z",
      "completed_at": "2026-05-19T08:00:01Z"
    }
    // ...
  ],
  "next_since_id": "01HXYZ0NN..."  // null 表示无更多
}
```

**注意**：
- 仅返回 `delivery_mode IN ('pull', 'both')` 的请求；`callback`-only 不会被 pull 拉到
- `include=unacked` 过滤条件：`acked_at IS NULL`
- 结果按 `id ASC` 排序（UUIDv7 即时间序）

### 3.3 `POST /v1/analyze/{request_id}/ack` — 显式确认

幂等确认已消费，防止下次 pull 重复拿到。

**Body**：空 body（HMAC 签名需要 body_hash = sha256("") = `e3b0c442...`）。

**Response 200**：

```json
{ "request_id": "01HXYZ...", "acked_at": "2026-05-19T08:01:30Z" }
```

**Response 404**：request_id 不存在或不属于该 app。

**Response 409**：该 request 的 `delivery_mode='callback'`，不允许 ack（仅 pull / both 模式的请求可 ack）。

**幂等行为**：重复 ack 同一 id 返 200；`acked_at` **不刷新**（保留首次确认时间）。

---

## 4. callback 行为细节

### 4.1 限速

`apps.callback_max_concurrency`（默认 10）控制 ai-guard 对该 app 同时投递 callback 的最大并发。超额请求在 `CALLBACK_QUEUE` 排队，**不丢失**。

→ 高 QPS 场景下，ai-guard 不会反向把消费方打爆。

### 4.2 投递成功标记

callback 收到 2xx 时，ai-guard 写 `analyze_requests.delivered_at = now()`。

→ Admin UI 的「调用记录」视图可基于 `delivered_at IS NULL AND status='ok' AND delivery_mode IN ('callback','both')` 看出"已完成但未投递"的请求。

### 4.3 与 ack 的关系

| delivery_mode | callback 行为 | ack 行为 |
|----------------|---------------|----------|
| `callback` | 投递直到 5 次重试后入 DLQ | 不允许 ack（409） |
| `pull` | 不投递 | 必须 ack 才不会被重复拉到 |
| `both` | 投递成功也算"已交付"（写 delivered_at）；但仍需要消费方 ack（写 acked_at）才不会被 pull 拉到 | callback 成功后**消费方应同时 ack**，避免下次 cron pull 重复 |

`both` 模式的关键：**callback 不自动等同于 ack**。这是为了保证 callback 投递了但消费方没真正处理（崩了 / 进程死了）时，pull cron 仍能补救。消费方收到 callback 处理完毕后必须显式调 ack。

---

## 5. 消费方推荐用法（以 IRC 为例）

### 5.1 配置

ai-guard 管理员给消费方注册 app 时：

```
app_id:                  app_irc
secret:                  <安全渠道交付>
biz_types:               []                              # moderate 系不启用
analyze_biz_types:       ["media_analysis", "media_intro"]
delivery_mode:           "both"                          # 默认
callback_max_concurrency: 10                             # 按消费方承载调整
rate_limit_qps:          500                             # 按业务流量协商
```

消费方在自己的密钥管理中存 secret（IRC 走 `secrets-hub`），key 名建议 `ai_guard_secret`。

### 5.2 在线场景（采集端实时入库）

- 默认 `delivery_mode=both`
- 提交时不传 `delivery_mode` 字段（沿用 app 默认）
- 消费方暴露 callback endpoint：收到 → 处理 → **同时调 ack**
- cron 每分钟兜底 pull：`GET /v1/analyze?status=ok&since_id=$max_acked_id&include=unacked&limit=50`，处理后 ack

### 5.3 批量回填场景

- 单次请求传 `delivery_mode: "pull"`（避免 callback 反向冲击）
- 消费方按自己的速率 cron pull
- 处理完后 ack

### 5.4 消费方重启 / 灾难恢复

- 直接 pull：`GET /v1/analyze?status=ok&include=unacked&since_id=` 从最早未 ack 的开始
- 不需要任何特殊恢复流程；ack 状态本身就是消费进度

### 5.5 错误请求

- `status=error` 的请求也可被 pull / callback 投递
- 消费方按 `error_code` 决定是否重提（参考 [13-callback-spec-analyze.md](13-callback-spec-analyze.md)）
- 错误请求处理完同样 ack，避免重复拉

---

## 6. 端到端示例（curl）

```bash
APP_ID=app_irc
SECRET=<from secrets-hub>
BASE=https://aicenter-api.1.gay

sign() {
  local body="$1"
  local ts=$(date +%s)
  local nonce=$(openssl rand -hex 16)
  local bh=$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $2}')
  local sig=$(printf '%s\n%s\n%s' "$ts" "$nonce" "$bh" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
  echo "$ts $nonce $sig"
}

# 1) 提交 media_analysis 请求
BODY='{"biz_type":"media_analysis","biz_id":"video-12345","input":{"image_urls":["https://cdn.irc.example.com/frames/v12345/1.jpg","..."],"title":"...","duration_seconds":632}}'
read TS NONCE SIG < <(sign "$BODY")
curl -X POST $BASE/v1/analyze \
  -H "x-app-id: $APP_ID" -H "x-timestamp: $TS" -H "x-nonce: $NONCE" -H "x-signature: $SIG" \
  -H "content-type: application/json" -d "$BODY"
# → 202 + {request_id, accepted_at}

# 2) 拉取未 ack 的 ok 结果
read TS NONCE SIG < <(sign "")
curl -X GET "$BASE/v1/analyze?status=ok&since_id=&include=unacked&limit=50" \
  -H "x-app-id: $APP_ID" -H "x-timestamp: $TS" -H "x-nonce: $NONCE" -H "x-signature: $SIG"
# → 200 + {items[], next_since_id}

# 3) 处理后 ack
REQ=01HXYZ...
read TS NONCE SIG < <(sign "")  # ack body 为空
curl -X POST "$BASE/v1/analyze/$REQ/ack" \
  -H "x-app-id: $APP_ID" -H "x-timestamp: $TS" -H "x-nonce: $NONCE" -H "x-signature: $SIG"
# → 200 + {request_id, acked_at}
```

Python / Node SDK 见各 app 自身 integration 文档（如 [apps/IRC-integration.md](apps/IRC-integration.md)）。

---

## 7. Admin 后台

Admin UI（`https://aicenter.1.gay`）"Analyze 调用记录"页支持：

- 按 app / biz_type / biz_id / 时间范围 / status 筛选
- 列表展示元数据（id / status / provider / latency / tokens / delivered_at / acked_at）
- 点击展开看完整 `input_json` + `result_json`（JSON tree viewer）
- 复制 input / result 为 JSON 字符串
- 单条复跑（开发模式开放，prod 默认不开放）

详见 Admin UI 操作手册（与本文档分离维护，未来加 `docs/15-admin-analyze-ui.md`）。

---

## 8. FAQ

**Q：moderate 线也想用 pull 模式吗？**
A：不支持。moderate 线设计上是低延迟实时审核，pull 周期太慢；同时 moderate 线遵守"不长期留存用户原始数据"承诺，不应保留 input。如有需求，开 RFC。

**Q：callback 和 ack 重复怎么办？**
A：`both` 模式下：callback 写 `delivered_at`、ack 写 `acked_at`，两者独立。Admin UI 可以看到 callback 已投递但消费方未 ack（消费方崩溃）的请求。

**Q：cursor 拉取时漏了请求会怎样？**
A：不会漏。`since_id` 按 UUIDv7 时间序单调递增，只要消费方持久化 `max_processed_id` 不重置，每个请求最终都会被拉到至少一次（at-least-once）。重复拉到时按 `request_id` 幂等处理。

**Q：input_json 永久保留会不会爆 D1？**
A：单条 analyze_requests 行预估 5–50KB；按 IRC 日量几千请求估算，每日新增几十 MB。D1 单库上限 10 GB，预估可用 2–3 年。届时可加 `analyze_retention_days` 按业务方分级，或归档到 R2。本文档发布时 D1 容量监控未启用，T-006 阶段加入。

**Q：可以查询 status=pending 的请求吗？**
A：本期 `GET /v1/analyze` 不返 pending（只返 `status ∈ {ok, error}`）；`GET /v1/analyze/{id}` 返回 pending 状态。未来如需，可加 `status=pending` 过滤值。

---

## 9. 与其他文档的关系

| 文档 | 范围 |
|------|------|
| [00-overview.md](00-overview.md) | 平台总览（含双轨说明） |
| [02-api-public.md](02-api-public.md) | Public API 通用契约（鉴权 / 限流 / 错误码）+ /v1/moderate + /v1/analyze 提交契约 |
| [04-callback-spec.md](04-callback-spec.md) | **moderate 系** callback 契约（不动） |
| [12-content-service.md](12-content-service.md) | analyze 系总览 / 业务定位 / 与 moderate 关系 |
| [13-callback-spec-analyze.md](13-callback-spec-analyze.md) | **analyze 系** callback 契约（schema_version 1.1） |
| 本文档 14 | analyze 留存策略 + pull 接口契约 + 消费方推荐用法 |

— END —
