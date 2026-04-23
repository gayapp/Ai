# 04 · 固定 JSON 回调契约 ★

> **本文档是对外契约。修改前必须走评审，且保持向后兼容。**
> 
> 契约由代码强制：[../src/moderation/schema.ts](../src/moderation/schema.ts) 定义 Zod schema，运行时把模型的自由返回收敛到此结构；prompt 中无论写什么，都不可能让字段越界。

## 回调方式

```
POST {app.callback_url}
Content-Type: application/json
X-Signature: hex(HMAC-SHA256(app_secret, raw_body))
X-Timestamp: <unix seconds>
X-Request-Id: <request_id>
```

## JSON 结构

```json
{
  "schema_version":  "1.0",
  "request_id":      "01HXYZ...",
  "app_id":          "app_7f3a2c8d",
  "biz_type":        "comment",
  "biz_id":          "app-side-post-12345",
  "user_id":         "u_88991",
  "status":          "pass",
  "risk_level":      "safe",
  "categories":      [],
  "reason":          "内容正常",
  "provider":        "grok",
  "model":           "grok-2-latest",
  "prompt_version":  7,
  "cached":          false,
  "tokens":          { "input": 182, "output": 45 },
  "latency_ms":      1234,
  "extra":           { "任意应用提交的 extra 原样回传": true },
  "created_at":      "2026-04-23T08:00:01Z"
}
```

## 字段定义

| 字段 | 类型 | 允许值 / 约束 | 说明 |
|------|------|--------------|------|
| `schema_version` | string | 当前固定 `"1.0"` | 破坏性变更才会升 major |
| `request_id` | string | UUIDv7 | 本次审核唯一 ID |
| `app_id` | string | `app_*` | 应用 ID |
| `biz_type` | enum | `comment \| nickname \| bio \| avatar` | 业务类型 |
| `biz_id` | string | ≤128 | 应用侧提交时的业务 ID |
| `user_id` | string \| null | ≤128 | 应用侧提交时的 user_id，可空 |
| **`status`** | enum | `pass \| reject \| review \| error` | **最终判定** |
| `risk_level` | enum | `safe \| low \| medium \| high` | 风险等级 |
| `categories` | string[] | 见下 | 命中的风险类别，可多个；`status=pass` 时为 `[]` |
| `reason` | string | ≤512 | 人类可读原因 |
| `provider` | enum | `grok \| gemini` | 实际调用的上游 |
| `model` | string | 如 `grok-2-latest` | 模型标识 |
| `prompt_version` | integer | | 使用的 prompt 版本号 |
| `cached` | boolean | | 是否命中去重缓存 |
| `tokens.input` | integer | | 输入 token 数 |
| `tokens.output` | integer | | 输出 token 数 |
| `latency_ms` | integer | | 端到端耗时（含队列等待） |
| `extra` | object | ≤4KB | 应用提交时的 `extra` 原样回传 |
| `created_at` | string | ISO-8601 | 审核完成时间（不是请求时间） |

### `status` 取值语义

| status | 含义 | 应用端建议动作 |
|--------|------|---------------|
| `pass` | 内容通过 | 正常展示 |
| `reject` | 命中违规 | 拦截 + 提示用户 |
| `review` | 不确定，建议人工复审 | 放入人工队列或先降权展示 |
| `error` | 审核失败（模型异常、结构不合规等） | **重试或兜底策略自决**。同一 `request_id` 不会重复计费，应用可选择重新提交或按既定策略处理 |

### `categories` 取值

```
["politics", "porn", "abuse", "ad", "spam", "violence", "other"]
```

- Zod 在解析层做 allow-list 校验：prompt 即使返回 `"terrorism"`，也会被收敛为 `"violence"` 或 `"other"`。
- 多个 category 以数组返回，按严重度降序。
- `status=pass` 时必为 `[]`。

---

## 签名校验（应用端）

```js
import crypto from "node:crypto";

function verify(secret, rawBody, headers) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(headers["x-signature"], "hex")
  );
}
```

> **务必使用 `timingSafeEqual`**，避免时序攻击。

---

## 重试与幂等

- 投递失败（非 2xx / 超时）按 `1min → 5min → 30min → 2h → 12h` 指数退避重试 5 次。
- 最终失败进 DLQ，可在 Admin UI 手工触发。
- 应用端**必须按 `request_id` 幂等处理**，可能收到重复回调（at-least-once）。

---

## 兼容性承诺

**保证**：
- 不会删除已有字段。
- 不会改变已有字段的含义。
- 新增字段默认放在合适的位置，应用端**必须忽略未知字段**。
- 枚举新增值时，`other` 类别会兜底——应用端也应把未知枚举当 `other` 处理。

**破坏性变更流程**：
1. 新版本 schema 以新 `schema_version` 并行提供。
2. app 配置中选择订阅版本。
3. 老版本保留至少 6 个月。
