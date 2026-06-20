# 同趣 · 社区帖子（图文 / 视频）审核 — 接口对接文档

> 面向调用方（同趣 VPS / moderation-service）。配套契约：[02-api-public.md](../02-api-public.md) · [04-callback-spec.md](../04-callback-spec.md)。
> 本文档只覆盖新增的 `biz_type=post`；`comment / nickname / bio / avatar` 沿用 [同趣-integration.md](同趣-integration.md)，不变。

| 项 | 值 |
|----|----|
| Base URL | `https://aicenter-api.1.gay` |
| App ID | `app_79e81a7183747039`（复用现有，无需新发） |
| Secret | 复用现有同趣 secret（HMAC-SHA256） |
| Endpoint | `POST /v1/moderate` |
| 新增 biz_type | `post` —— 需平台侧先为本 app 启用 |
| 限额 | 受同趣 100 QPS 约束；存量回填请自行限速 |

---

## 1. 适用场景

一个 `post` 覆盖三类发帖，**同一接口、同一字段形态**：

| 场景 | `content` | `image_urls` | 视觉模型 |
|------|-----------|--------------|----------|
| 纯文字帖 | 标题/正文 | 省略或 `[]` | 文本模型（快） |
| 图文帖 | 标题/正文（可空） | 1~N 张图 | 视觉模型 |
| 视频帖 | 标题/正文（可空） | 抽帧后的 N 张帧图 | 视觉模型 |

- 视频帖由同趣 VPS **先抽帧**成多张帧图，ai-guard 当多图处理，**无需视频解码**。
- 对一帖的多图/多帧**综合出一个结论**（命中任一严重违规即 `reject`）。

---

## 2. 认证（HMAC-SHA256）

与现有同趣对接完全一致。每个请求带 4 个头：

| Header | 说明 |
|--------|------|
| `X-App-Id` | `app_79e81a7183747039` |
| `X-Timestamp` | Unix 秒级时间戳（十进制字符串），允许 ±300s 偏移 |
| `X-Nonce` | 16 字节随机数的 hex（32 字符），5 分钟内不可重复 |
| `X-Signature` | 见下 |

```
body_hash      = hex(sha256(request_body_bytes))
string_to_sign = X-Timestamp + "\n" + X-Nonce + "\n" + body_hash
X-Signature    = hex(hmac_sha256(secret, string_to_sign))
```

> 签名的 body 必须与实际发送的字节**逐字节一致**（先 `json.dumps` 一次后复用，不要签完再格式化）。

---

## 3. 请求 `POST /v1/moderate`

### 3.1 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `biz_type` | string | ✓ | 固定 `"post"` |
| `biz_id` | string | ✓ | = 同趣 `post_id`（ULID，≤128），回调原样带回 |
| `content` | string | 见说明 | 标题/正文（≤16KB）。与 `image_urls` **至少其一非空** |
| `image_urls` | string[] | 见说明 | 多图/帧 URL，每个 `https://` 起，**≤12 张**，单图 ≤8MB |
| `user_id` | string |  | 终端用户 ID（滥用统计用） |
| `mode` | enum |  | `sync`（默认拿结论）/ `auto`（超时降级异步+回调）/ `async` |
| `callback_url` | string |  | `auto`/`async` 用；不传则用 app 默认回调地址 |
| `extra` | object |  | ≤4KB，原样回传，如 `{ "post_type": "video", "media_count": 8 }` |

约束补充：
- `image_urls` 仅 `post` 可用；非图/不可达 URL → 该请求 `status=error`（按约定重试或转人工）。
- **图文/视频帖请用 `mode=auto`**（强烈建议）：服务端同步调用上限 10s，而多图视觉模型（grok-4）通常 >10s，`mode=sync` 多图会大概率返回 `504 provider_timeout`。`mode=auto` 会在同步超时后自动降级为异步并走回调，**必须带 `callback_url`**（或 app 已配默认回调）。
- **纯文字帖**可用 `mode=sync` 直接拿结论（文本模型快，<10s）。
- 线上实测：2 张图 `mode=auto` 约 12~20s 出结论（异步回调）。

### 3.2 示例

**图文帖（同步）**
```json
{
  "biz_type": "post",
  "biz_id": "01HXYZ_post_ulid",
  "content": "周末爬山\n风景很好",
  "image_urls": [
    "https://f000.backblazeb2.com/file/duanvideo/temp/2026-06-15/post/01HXYZ/0.webp",
    "https://f000.backblazeb2.com/file/duanvideo/temp/2026-06-15/post/01HXYZ/1.webp"
  ],
  "user_id": "u_12345",
  "mode": "sync",
  "extra": { "post_type": "image", "media_count": 2 }
}
```

**视频帖（auto + 回调，帧图即 image_urls）**
```json
{
  "biz_type": "post",
  "biz_id": "01HABC_post_ulid",
  "content": "",
  "image_urls": [
    "https://f000.backblazeb2.com/file/duanvideo/temp/.../frame_0.webp",
    "https://f000.backblazeb2.com/file/duanvideo/temp/.../frame_1.webp",
    "https://f000.backblazeb2.com/file/duanvideo/temp/.../frame_2.webp"
  ],
  "mode": "auto",
  "callback_url": "https://api.tongqu.com/hooks/moderation",
  "extra": { "post_type": "video", "media_count": 3, "duration_seconds": 42 }
}
```

**纯文字帖**
```json
{ "biz_type": "post", "biz_id": "01HDEF_post_ulid", "content": "标题\n正文", "mode": "sync" }
```

---

## 4. 同步响应（`mode=sync` / 缓存命中）

```json
{
  "request_id": "01HXYZ-...",
  "cached": false,
  "result": {
    "status": "reject",
    "risk_level": "high",
    "categories": ["porn", "ad"],
    "reason": "第2张图含未成年性化嫌疑，第3张图含微信引流",
    "labels": [
      { "category": "minor_face", "detected": true,  "confidence": 0.82, "evidence": "第2张图出现疑似未成年男性面孔" },
      { "category": "csam",       "detected": true,  "confidence": 0.71, "evidence": "第2张图未成年+裸露" },
      { "category": "ad",         "detected": true,  "confidence": 0.90, "evidence": "第3张图右下角微信号 abc123" },
      { "category": "drug",       "detected": false, "confidence": 0.0,  "evidence": "" },
      { "category": "gambling",   "detected": false, "confidence": 0.0,  "evidence": "" },
      { "category": "politics",   "detected": false, "confidence": 0.0,  "evidence": "" },
      { "category": "nsfw",       "detected": true,  "confidence": 0.95, "evidence": "成人男性裸露（合法，不影响判定）" }
    ]
  }
}
```

### 4.1 `result` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | enum | `pass` 放行 / `reject` 拦截 / `review` 转人工 / `error` 审核失败 |
| `risk_level` | enum | `safe / low / medium / high` |
| `categories` | string[] | 命中风险类别（`politics/porn/abuse/ad/spam/violence/other`），`pass` 时为 `[]` |
| `reason` | string | 一句中文说明（指明在第几张图/帧看到什么） |
| `labels` | object[] | 逐类结构化标签，见 4.2 |

### 4.2 `labels`（逐类"是否有 + 是什么"）

每个 category 一条 `{ category, detected, confidence, evidence }`：

| category | 含义 | 对结论的影响 |
|----------|------|--------------|
| `minor_face` | 疑似未成年人面孔 | detected 但无性化 → `review`（建议人工复核） |
| `csam` | 未成年性化 | detected → `reject`（零容忍） |
| `ad` | 广告引流 | detected → `reject`（零容忍） |
| `drug` | 毒品 | detected → `reject`（零容忍） |
| `gambling` | 赌博 | detected → `reject`（零容忍） |
| `politics` | 政治敏感 | detected → `reject`（零容忍） |
| `id_document` | 身份证/护照/证件等可证明身份的图片 | detected → `reject`（零容忍，隐私/合规） |
| `nsfw` | 合法成人内容（裸露/男同色情） | 仅描述，**detected=true 不影响判定** |

- `confidence` 为 0~1；`evidence` 为命中位置/描述（未命中为空串）。
- 同趣可直接用 `labels` 做精细化处置（如仅 `minor_face` 命中转人工、`ad` 命中扣分）。
- `labels` 共 **8** 类（含 `id_document`）；`ad` 含二维码与引流性账号水印。

---

## 5. 异步响应与回调

`mode=auto` 超时或 `mode=async` 时先返回 `202`：

```json
{ "request_id": "01HXYZ-...", "accepted_at": "2026-06-15T08:00:00Z" }
```

结果随后 POST 到 `callback_url`（契约见 [04-callback-spec.md](../04-callback-spec.md)）：

```json
{
  "schema_version": "1.0",
  "request_id": "01HXYZ-...",
  "app_id": "app_79e81a7183747039",
  "biz_type": "post",
  "biz_id": "01HXYZ_post_ulid",
  "user_id": "u_12345",
  "status": "reject",
  "risk_level": "high",
  "categories": ["porn", "ad"],
  "reason": "…",
  "labels": [ /* 同 4.2，逐类标签 */ ],
  "provider": "grok",
  "model": "grok-4",
  "prompt_version": 1,
  "cached": false,
  "tokens": { "input": 4823, "output": 412 },
  "latency_ms": 8431,
  "extra": { "post_type": "video", "media_count": 3 },
  "created_at": "2026-06-15T08:00:09Z"
}
```

**回调头**：`X-App-Id` / `X-Timestamp` / `X-Request-Id` / `X-Signature = hex(HMAC-SHA256(secret, raw_body))`（直接对 body 做 HMAC，不掺时间戳/nonce）。

校验示例（Python）：
```python
expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
assert hmac.compare_digest(expected, request.headers["x-signature"])
```

回调投递失败重试：`1min → 5min → 30min → 2h → 12h`，5 次后进 DLQ；请按 `request_id` **幂等**处理。

### 5.1 单条轮询 `GET /v1/moderate/{request_id}`

回调丢失/对账时可主动拉取（**对空 body 签名**，头同 §2）：

```json
{
  "request_id": "01HXYZ-...",
  "status": "pass",
  "result": { "status": "pass", "risk_level": "safe", "categories": [], "reason": "...", "labels": [ /* 同 4.2，post 含逐类标签 */ ] },
  "provider": "grok", "model": "grok-4.3", "cached": false,
  "tokens": { "input": 1057, "output": 208 }, "latency_ms": 15845,
  "created_at": "...", "completed_at": "..."
}
```

- `result.labels` 与 sync 响应 / callback **完全一致**（post 行返回七类标签；非 post 行无此字段）。
- moderate **没有** analyze 那种 pull/ack 批量游标；要批量对账请逐条 GET（按 `request_id`），或以 callback 为准。

---

## 6. 调用示例（Python · httpx/requests）

```python
import os, json, time, secrets, hashlib, hmac, requests

BASE   = "https://aicenter-api.1.gay"
APP_ID = "app_79e81a7183747039"
SECRET = os.environ["AI_GUARD_SECRET"]

def moderate_post(biz_id: str, content: str, image_urls: list[str] | None = None, **opts) -> dict:
    payload = {"biz_type": "post", "biz_id": biz_id, "content": content}
    if image_urls:
        payload["image_urls"] = image_urls
    payload.update(opts)  # mode / user_id / callback_url / extra
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    ts    = str(int(time.time()))
    nonce = secrets.token_hex(16)
    body_hash = hashlib.sha256(body).hexdigest()
    sig = hmac.new(SECRET.encode(), f"{ts}\n{nonce}\n{body_hash}".encode(), hashlib.sha256).hexdigest()

    res = requests.post(
        f"{BASE}/v1/moderate",
        headers={
            "x-app-id": APP_ID, "x-timestamp": ts, "x-nonce": nonce,
            "x-signature": sig, "content-type": "application/json",
        },
        data=body, timeout=20,
    )
    data = res.json()
    if not res.ok:
        raise RuntimeError(f"{res.status_code} {data.get('error_code')}: {data.get('message')}")
    return data

# 图文帖（同步）
r = moderate_post(
    "01HXYZ_post_ulid", "周末爬山\n风景很好",
    image_urls=["https://f000.backblazeb2.com/.../0.webp", "https://f000.backblazeb2.com/.../1.webp"],
    mode="sync", user_id="u_12345", extra={"post_type": "image", "media_count": 2},
)
print(r["result"]["status"], r["result"]["labels"])

# 视频帖（auto + 回调）
moderate_post(
    "01HABC_post_ulid", "",
    image_urls=[f"https://f000.backblazeb2.com/.../frame_{i}.webp" for i in range(8)],
    mode="auto", callback_url="https://api.tongqu.com/hooks/moderation",
    extra={"post_type": "video", "media_count": 8},
)
```

---

## 7. 错误码

| HTTP | error_code | 含义 / 处理 |
|------|-----------|-------------|
| 400 | `invalid_request` | 请求体不符（如 `image_urls` >12、非 https、post 既无 content 又无图） |
| 401 | `bad_signature` / `expired_timestamp` / `replay_nonce` | 签名/时间戳/nonce 问题 |
| 403 | `biz_type_not_allowed` | 本 app 尚未启用 `post`，联系平台开通 |
| 200 | `result.status=error` | 模型异常 / 图片不可达 / 结构不合规：按 `request_id` 重试或转人工 |

---

## 8. 联调验收清单

- [ ] 用测试 `biz_id`（`test-post-*`）+ 2~3 张图调 `/v1/moderate`，拿到合并 verdict + `labels`。
- [ ] 正常图 → `pass`；含违规图 → `reject` + categories/reason + 对应 label `detected=true`。
- [ ] 含疑似未成年面孔 → `minor_face.detected=true` + `review`/`reject`。
- [ ] 不可达 / 非图 URL → `status=error`。
- [ ] `mode=auto` 超时 → `202` 降级，回调 `biz_type=post`、`biz_id`/`extra` 原样回传、签名校验通过。
- [ ] 纯文字帖（无 `image_urls`）→ 正常 `pass`/`reject`。

---

## 9. 兼容性

- `biz_type` 枚举**只增** `post`、`result`/回调**只增** `labels` 字段；旧消费方忽略未知字段，不受影响。
- `labels` 为 `post` 专属；其他 biz_type 不返回该字段。
