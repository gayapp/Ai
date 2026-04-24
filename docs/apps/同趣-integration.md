# 同趣 · AI 审核中间平台对接文档

> 本文档面向"同趣"业务方的开发者（人或 AI 助手均可直接按此落地）。
> 平台名：**ai-guard**（内部称"AI 中间平台"）
> 生成时间：2026-04-23

---

## 0. 一句话说明

你的应用把用户发的 **评论 / 昵称 / 个人简介 / 头像 URL** 通过一个 HTTP 接口交给 ai-guard，它返回"是否通过、违规类别、理由"的固定 JSON。文本 ≤10s 一般同步返回；头像等较慢的调用走异步回调。

---

## 1. 你的凭证（**保存好，不要进代码仓库**）

| 字段 | 值 |
|------|----|
| 应用名 | 同趣 |
| `app_id` | `app_79e81a7183747039` |
| `secret` | `<通过安全渠道单独发你，不入仓库>` |
| 启用业务类型 | `comment`, `nickname`, `bio`, `avatar` |
| 速率限制 | `100 QPS` |
| AI 策略 | `auto`（可在平台管理端改为 `grok` / `gemini` / `round_robin`） |

> **AI 策略说明**：`auto` 下文本类走 Grok、头像走 Gemini；可随时在 Admin UI 的 Apps 页点"改"切换。头像因 Grok 不支持视觉始终走 Gemini。策略切换只影响后续请求，已有缓存结果不受影响。

> 如果 secret 泄漏：由管理员在 Admin UI 点"轮换 secret"立即换发，或调 `POST /admin/apps/{app_id}/rotate-secret`。

## 2. 服务地址

| 环境 | Base URL |
|------|----------|
| **生产** | `https://aicenter-api.1.gay` |
| 备用（同一服务） | `https://ai-guard.schetkovvlad.workers.dev` |

两个 URL 指向同一个 Worker，任选。建议生产用 `aicenter-api.1.gay`。

---

## 3. 认证机制 · HMAC-SHA256

**每一个**请求都要带 4 个 header。算法固定，用标准库即可，无需第三方依赖。

### 3.1 Header 定义

| Header | 说明 |
|--------|------|
| `X-App-Id` | `app_79e81a7183747039` |
| `X-Timestamp` | Unix 秒级时间戳（**十进制字符串**）。服务端允许 ±300 秒偏移 |
| `X-Nonce` | 16 字节随机数的 hex 表示（32 个字符）。5 分钟内不可重复 |
| `X-Signature` | HMAC-SHA256 签名，见下 |
| `Content-Type` | `application/json` |

### 3.2 签名算法（严格按步骤）

```
body_hash     = hex(sha256(request_body_bytes))      # ← 请求体原始字节的 SHA-256，hex
string_to_sign = X-Timestamp + "\n" + X-Nonce + "\n" + body_hash
X-Signature   = hex(hmac_sha256(secret, string_to_sign))
```

**注意点**：
1. `request_body_bytes` 是**原样发送的字节**，不要在签名前后做 JSON 格式化（空格/换行）。先序列化一次，对该字节串计算哈希、然后发送同一字节串。
2. `string_to_sign` 里的 `\n` 是换行符（0x0A），**不是两字符的 `\\n`**。
3. 所有 hex 输出要**小写**。
4. GET 请求的 body 当作空串 `""`，hash = `e3b0c442...` (sha256 of empty string)。

### 3.3 示例（文本形式）

```
# 下列所有数字用"演示密钥"计算，只作算法验证用，不是任何真实 app 的数据。

Body:      {"biz_type":"comment","biz_id":"c-1","content":"hello"}
Secret:    DEMO_ONLY_NOT_A_REAL_SECRET
Timestamp: 1776944928
Nonce:     69bb4c942a2261af949475ab66ca0761
body_hash: 7190efad8cb0c29907c9b74c548543ba553ca777513c5ab7baa8ab003ce94841
string_to_sign:
  1776944928
  69bb4c942a2261af949475ab66ca0761
  7190efad8cb0c29907c9b74c548543ba553ca777513c5ab7baa8ab003ce94841
Signature (HMAC-SHA256):
  61ab65eabb21f924467f400480de55fd1ca1d67f9027ee9037b6b391f0dfcc12
```

把上述任何一步对应的输出代入自己的实现，如果算出相同的 Signature，说明签名实现正确。

---

## 4. 接口 1：`POST /v1/moderate` — 提交审核

### 4.1 请求体

```json
{
  "biz_type": "comment | nickname | bio | avatar",
  "biz_id":   "业务侧唯一 ID，回调会原样带回，≤128 字符",
  "content":  "文本正文 或 图片 URL（仅 avatar）",
  "user_id":  "可选，终端用户 ID，用于反滥用排行；≤128",
  "mode":     "sync | async | auto（默认 auto）",
  "callback_url": "可选，覆盖应用默认回调地址；async 模式必填",
  "extra":    { "任意 KV，≤4KB，回调原样回传": true }
}
```

| 字段 | 必填 | 约束 |
|------|------|------|
| `biz_type` | ✓ | 必须是启用的 4 种之一 |
| `biz_id` | ✓ | 应用内唯一即可，不强制格式 |
| `content` | ✓ | 文本 ≤16KB；`avatar` 时填图片 URL（必须 `https://`；≤8MB） |
| `user_id` | ○ | 强烈建议带上，便于反滥用 |
| `mode` | ○ | `auto`：文本默认同步、`avatar` 默认异步、超时自动降级；`sync`：强制同步（模型慢会 504）；`async`：一律异步 + 回调 |
| `callback_url` | ○ | 如果 app 预置了 default callback，可不填；`async` 或降级到异步时必须有一处 |
| `extra` | ○ | 原样回传到回调，适合放业务上下文（帖子 ID、话题 tag 等） |

### 4.2 响应 A — 同步（或命中缓存）

HTTP `200`
```json
{
  "request_id": "01HXYZ-...（UUIDv7）",
  "cached": false,
  "result": {
    "status": "pass | reject | review",
    "risk_level": "safe | low | medium | high",
    "categories": ["abuse", "ad", ...],
    "reason": "一句中文说明"
  }
}
```

**应用端如何落地**：

| `status` | 建议处置 |
|---------|---------|
| `pass` | 正常展示 |
| `reject` | 拦截，可选提示用户具体原因（reason） |
| `review` | 先降权展示或隐藏，入人工审核队列 |

`categories` 枚举：`politics / porn / abuse / ad / spam / violence / other`。
`risk_level` 枚举：`safe / low / medium / high`。

### 4.3 响应 B — 异步

HTTP `202`
```json
{
  "request_id": "01HXYZ-...",
  "accepted_at": "2026-04-23T14:00:00.000Z",
  "downgraded": false
}
```

结果稍后通过回调送达（见 §6）。如果响应里 `downgraded=true`，表示本来 `mode=auto` 准备同步，但模型超时转为异步。

### 4.4 错误响应

任何失败都是：
```json
{ "error_code": "bad_signature", "message": "signature mismatch" }
```

| HTTP | `error_code` | 含义 |
|------|--------------|------|
| 400 | `invalid_request` | Body 不符 schema、async 无 callback_url 等 |
| 401 | `bad_signature` | HMAC 校验失败 |
| 401 | `expired_timestamp` | 时间戳超出 ±300s 偏差 |
| 401 | `replay_nonce` | 5 分钟内同 nonce 重复 |
| 403 | `biz_type_not_allowed` | 本 app 未启用此 biz_type |
| 403 | `app_disabled` | 本 app 被停用（联系管理员） |
| 404 | `app_not_found` | app_id 不存在 |
| 422 | `unsupported_content` | 图片 URL 无法访问 / 非图片 |
| 429 | `rate_limited` | 超过 QPS 限额（本 app 默认 100/s）；响应体 `details.retry_after_seconds` |
| 502 | `provider_error` | 上游模型异常，建议重试 |
| 504 | `sync_timeout` | 同步模式超时，改用 `async` |

---

## 5. 接口 2：`GET /v1/moderate/{request_id}` — 查询历史结果

用于回调投递失败后补查，或应用端重启时对未落库的请求做兜底。

**同样要签名**（空 body）。

响应 `200`：
```json
{
  "request_id": "01HXYZ-...",
  "status": "pass | reject | review | error",
  "result": { "status": "...", "risk_level": "...", "categories": [...], "reason": "..." },
  "provider": "grok",
  "model": "grok-4-fast-non-reasoning",
  "cached": false,
  "tokens": { "input": 140, "output": 28 },
  "latency_ms": 580,
  "created_at": "2026-04-23T14:00:00.000Z",
  "completed_at": "2026-04-23T14:00:00.580Z"
}
```

响应 `404`：`request_id` 不存在或不属于该 app。

---

## 6. 回调接收 · 你的 webhook 要实现的

当审核走异步路径时，平台会 POST 结果到你的 `callback_url`。

### 6.1 请求

```
POST <你的 callback_url>
Content-Type: application/json
X-App-Id:     app_79e81a7183747039
X-Timestamp:  1776944928                              # Unix 秒
X-Request-Id: 01HXYZ...
X-Signature:  <HMAC-SHA256(secret, raw_body)>         # ← 直接对 body 做 HMAC，不掺时间戳和 nonce
```

### 6.2 Body（**固定 schema，代码层锁定**）

```json
{
  "schema_version": "1.0",
  "request_id":     "01HXYZ...",
  "app_id":         "app_79e81a7183747039",
  "biz_type":       "avatar",
  "biz_id":         "原样回传你提交时的 biz_id",
  "user_id":        "可能为 null",
  "status":         "pass | reject | review | error",
  "risk_level":     "safe | low | medium | high | null",
  "categories":     ["politics","porn","abuse","ad","spam","violence","other"],
  "reason":         "一句中文说明",
  "provider":       "grok | gemini | null",
  "model":          "grok-4-fast-non-reasoning | gemini-2.5-flash | null",
  "prompt_version": 2,
  "cached":         false,
  "tokens":         { "input": 140, "output": 28 },
  "latency_ms":     3512,
  "extra":          { "原样回传你提交时的 extra": true },
  "created_at":     "2026-04-23T14:00:00.000Z"
}
```

- **兼容承诺**：以后可能加字段（比如新类别），不会删字段、不会改现有字段含义。你的代码应该**忽略未知字段**。
- `status = "error"` 表示审核系统本身出了错（模型返回不合规、上游故障等）——应用可选择重试或兜底放行（按你的风控策略）。

### 6.3 必须做的事

1. **2xx 内返回**。非 2xx 会按 `1min → 5min → 30min → 2h → 12h` 重试 5 次，失败进 DLQ。
2. **校验签名**（Node 示例见 §7.4）。永远用常数时间比较。
3. **按 `request_id` 幂等**。at-least-once 投递，你可能收到同一 `request_id` 多次。

### 6.4 伪代码

```
on POST /your/callback:
  raw = request.raw_body                                # 字节，不要 reparse JSON
  expected = hex(hmac_sha256(secret, raw))
  if not constant_time_equal(expected, header["X-Signature"]):
    return 401
  body = json.parse(raw)
  if body.status == "reject":
    mark_post_as_blocked(body.biz_id, body.reason)
  elif body.status == "review":
    enqueue_manual_review(body.biz_id)
  # status=pass：不做事；status=error：按风控策略
  return 200
```

---

## 7. 完整代码示例

### 7.1 Node.js · 签名并发请求

```javascript
// deps: 仅 node:crypto, node:fetch (Node >= 18)
import { createHash, createHmac, randomBytes } from "node:crypto";

const BASE = "https://aicenter-api.1.gay";
const APP_ID = "app_79e81a7183747039";
const SECRET = process.env.AI_GUARD_SECRET;      // 不要硬编码！

async function moderate(biz_type, biz_id, content, opts = {}) {
  const body = JSON.stringify({ biz_type, biz_id, content, ...opts });
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", SECRET)
    .update(`${ts}\n${nonce}\n${bodyHash}`)
    .digest("hex");

  const res = await fetch(`${BASE}/v1/moderate`, {
    method: "POST",
    headers: {
      "x-app-id": APP_ID,
      "x-timestamp": ts,
      "x-nonce": nonce,
      "x-signature": sig,
      "content-type": "application/json",
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error_code}: ${data.message}`);
  return data;                                     // { request_id, cached, result } 或 { request_id, accepted_at }
}

// ── 用法 ────────────────────────────────────────
// 1) 评论（同步）
const r = await moderate("comment", "post-1234", "这个电影真好看");
// r.result.status ∈ {"pass","reject","review"}

// 2) 头像（异步，必须提供 callback_url）
await moderate("avatar", "user-5678", "https://cdn.example.com/avatars/u5678.jpg", {
  mode: "auto",
  callback_url: "https://api.tongqu.com/hooks/moderation",
  user_id: "u5678",
  extra: { room_id: "room-999" },
});
```

### 7.2 Python · 签名并发请求

```python
import hashlib, hmac, json, os, secrets, time
import requests   # or httpx

BASE = "https://aicenter-api.1.gay"
APP_ID = "app_79e81a7183747039"
SECRET = os.environ["AI_GUARD_SECRET"]            # 不要硬编码！

def moderate(biz_type: str, biz_id: str, content: str, **opts) -> dict:
    payload = {"biz_type": biz_type, "biz_id": biz_id, "content": content, **opts}
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    body_hash = hashlib.sha256(body).hexdigest()
    string_to_sign = f"{ts}\n{nonce}\n{body_hash}".encode()
    sig = hmac.new(SECRET.encode(), string_to_sign, hashlib.sha256).hexdigest()

    res = requests.post(
        f"{BASE}/v1/moderate",
        headers={
            "x-app-id": APP_ID,
            "x-timestamp": ts,
            "x-nonce": nonce,
            "x-signature": sig,
            "content-type": "application/json",
        },
        data=body,
        timeout=15,
    )
    data = res.json()
    if not res.ok:
        raise RuntimeError(f"{res.status_code} {data['error_code']}: {data['message']}")
    return data

# ── 用法 ──────────────────────────────────────────
r = moderate("comment", "post-1234", "这个电影真好看")
# r["result"]["status"]

# 头像异步
moderate(
  "avatar", "user-5678",
  "https://cdn.example.com/avatars/u5678.jpg",
  mode="auto",
  callback_url="https://api.tongqu.com/hooks/moderation",
  user_id="u5678",
  extra={"room_id": "room-999"},
)
```

### 7.3 Go · 签名并发请求

```go
package main

import (
  "bytes"
  "crypto/hmac"
  "crypto/rand"
  "crypto/sha256"
  "encoding/hex"
  "encoding/json"
  "fmt"
  "net/http"
  "os"
  "time"
)

const (
  base   = "https://aicenter-api.1.gay"
  appID  = "app_79e81a7183747039"
)

func moderate(bizType, bizID, content string, opts map[string]any) (map[string]any, error) {
  secret := os.Getenv("AI_GUARD_SECRET")
  body := map[string]any{"biz_type": bizType, "biz_id": bizID, "content": content}
  for k, v := range opts { body[k] = v }
  raw, _ := json.Marshal(body)

  ts := fmt.Sprintf("%d", time.Now().Unix())
  nb := make([]byte, 16); rand.Read(nb)
  nonce := hex.EncodeToString(nb)
  bh := sha256.Sum256(raw)
  msg := ts + "\n" + nonce + "\n" + hex.EncodeToString(bh[:])
  m := hmac.New(sha256.New, []byte(secret)); m.Write([]byte(msg))
  sig := hex.EncodeToString(m.Sum(nil))

  req, _ := http.NewRequest("POST", base+"/v1/moderate", bytes.NewReader(raw))
  req.Header.Set("x-app-id", appID)
  req.Header.Set("x-timestamp", ts)
  req.Header.Set("x-nonce", nonce)
  req.Header.Set("x-signature", sig)
  req.Header.Set("content-type", "application/json")
  res, err := http.DefaultClient.Do(req); if err != nil { return nil, err }
  defer res.Body.Close()
  out := map[string]any{}; json.NewDecoder(res.Body).Decode(&out)
  if res.StatusCode >= 400 { return nil, fmt.Errorf("%s: %v", res.Status, out) }
  return out, nil
}
```

### 7.4 Node.js · 校验回调签名

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const SECRET = process.env.AI_GUARD_SECRET;
const app = express();

// 关键：要拿到原始字节，不要让 body-parser 把它丢掉
app.post(
  "/hooks/moderation",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sigHeader = req.header("x-signature") || "";
    const expected = createHmac("sha256", SECRET).update(req.body).digest("hex");
    const a = Buffer.from(sigHeader, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).send("bad signature");
    }
    const body = JSON.parse(req.body.toString("utf8"));
    // 按 request_id 幂等处理
    console.log("[moderation]", body.request_id, body.status, body.reason);
    // TODO: 更新 DB / 通知用户 / 入人工队列
    res.status(200).send("ok");
  },
);

app.listen(3000);
```

### 7.5 Python · 校验回调签名（FastAPI）

```python
import hashlib, hmac
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
SECRET = os.environ["AI_GUARD_SECRET"].encode()

@app.post("/hooks/moderation")
async def hook(req: Request):
    raw = await req.body()
    sig_hex = req.headers.get("x-signature", "")
    expected = hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig_hex, expected):
        raise HTTPException(401, "bad signature")
    body = await req.json()
    # 幂等处理
    print("[moderation]", body["request_id"], body["status"], body["reason"])
    # TODO: upsert by request_id
    return {"ok": True}
```

---

## 8. 四种业务类型的使用示例

### 8.1 评论（comment）· 同步

```javascript
await moderate("comment", "post-9527", "这个主播超棒 ❤️", { user_id: "u42" });
// → {"status":"pass","risk_level":"safe","reason":"..."}
```

### 8.2 昵称（nickname）· 同步

```javascript
await moderate("nickname", "u42", "追风少年", { user_id: "u42" });
// pass / review / reject 之一
```

### 8.3 个人简介（bio）· 同步

```javascript
await moderate("bio", "u42", "95后程序员，爱好摄影", { user_id: "u42" });
```

### 8.4 头像（avatar）· **强制异步 + 必须 callback_url**

```javascript
await moderate("avatar", "u42", "https://cdn.tongqu.com/u42.jpg", {
  user_id: "u42",
  callback_url: "https://api.tongqu.com/hooks/moderation",
  extra: { ts: Date.now() },
});
// → {"request_id":"...","accepted_at":"..."}
// 结果稍后到 callback_url
```

> 如果同趣的头像 CDN 有防盗链或鉴权，请确保**公网可直接 GET**。平台会从 CF Workers 边缘拉图。

---

## 9. 常见坑位

| 坑 | 原因 | 解法 |
|----|------|------|
| `bad_signature` | 签名 body 和实际发的 body 不是同一份字节 | 确保 stringify 一次后重用；不要在签完再格式化 |
| `bad_signature` | 中文被 shell 或 curl 二次转码 | 用 `--data-binary @file` 或语言自带 HTTP 库，别用 bash `-d '{...}'` |
| `bad_signature` | body_hash 算了两次 hex | 先 sha256 → bytes → hex 一次 |
| `expired_timestamp` | 服务器时钟不准 | 用 NTP；时间戳单位必须是**秒**不是毫秒 |
| `replay_nonce` | 手动重发了相同 nonce | 每个请求生成新 nonce（16 随机字节） |
| `async mode requires callback_url` | 头像请求没带 callback | 请求里传，或让管理员给 app 配默认 callback |
| 回调 401 | body-parser 把 body 变 JSON 导致字节变化 | 用 raw body；校验完再 parse |
| 收到重复回调 | at-least-once | 按 `request_id` 幂等；DB 唯一索引 |

---

## 10. 接入 Checklist

- [ ] secret 写进环境变量 / 密钥管理，**不入 git**
- [ ] 包装一个 `moderate(biz_type, biz_id, content, opts)` 辅助函数，走 HMAC
- [ ] 评论/昵称/简介：**同步路径**，拿 `result.status` 决定展示
- [ ] 头像：**异步路径** + 提供 `callback_url`
- [ ] 实现 callback webhook：**必校验签名** → parse → **按 request_id 幂等** → 处置
- [ ] 错误码处理：5xx/429 走重试（指数退避），4xx 按错误码区分用户错 vs 代码错
- [ ] 灰度：先小流量跑一周，看 ai-guard 的 admin 后台有没有异常 reject
- [ ] 监控：把"命中 reject 的比例"做成你方的业务指标，反向回灌到业务规则

---

## 11. 联调支持

- 测试用 `biz_id` 建议加 `test-` 前缀方便识别
- 线上 admin 后台：https://aicenter.1.gay（域名 DNS 签发完成后生效，过渡用 https://ai-guard-admin.pages.dev）
  - 登录需要 ADMIN_TOKEN，是平台侧的，不给业务方
- 如果你需要看自己 app 的实时记录，告诉平台对接人，我们走只读 app-scoped token 方案
- 对接中遇到的签名/回调问题，把 `request_id` 发给对接人，我们走日志反查

## 12. 平台开源 & 架构

- GitHub: https://github.com/gayapp/Ai
- 系统架构图（含 5 张 Mermaid 流程图）：<https://aicenter-api.1.gay/architecture>
