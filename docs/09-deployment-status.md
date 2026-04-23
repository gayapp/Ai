# 09 · 部署状态 · dev 环境

> 最后更新：2026-04-23（由本次自动部署生成）

## Worker

- **Dev URL**：<https://ai-guard-dev.schetkovvlad.workers.dev>
- **Prod URL**：<https://aicenter-api.1.gay> / <https://ai-guard.schetkovvlad.workers.dev>
- **Admin Web UI**：<https://ai-guard-admin.pages.dev>（自定义域名 <https://aicenter.1.gay> 待 DNS 生效）
- **健康检查**：`GET /health` → `{"ok":true,...}`
- **绑定资源**（wrangler.toml `[env.dev]`）

## Cloudflare 资源

| 类型 | 名称 | ID |
|------|------|----|
| Worker | `ai-guard-dev` | — |
| D1 | `ai-guard-dev` | `e07b8f19-cc85-4571-9ce1-96150936b119` |
| KV | `ai-guard-dev-dedup-cache` | `03bd0d7c192e47ee87e8269c2b71a47a` |
| KV | `ai-guard-dev-prompts` | `7a83a472084846b6841d90618dca3771` |
| KV | `ai-guard-dev-apps` | `de87f0040ed14194a3c3536feacfa080` |
| KV | `ai-guard-dev-nonce` | `f0cf9dc5e5664005bbf18003547ccac6` |
| Queue | `ai-guard-dev-moderation` | `e3e32eaf5a6a492c9f8d438cbcc35a49` |
| Queue | `ai-guard-dev-callback` | `22b7c2d4581f4dd6a536b6ee6582453e` |
| Queue (DLQ) | `ai-guard-dev-moderation-dlq` | `696f52ec1a44483eaf82dc23088e24f9` |
| Queue (DLQ) | `ai-guard-dev-callback-dlq` | `239c1c2ef1464a1c8f6f9607219096aa` |

> 命名统一前缀 `ai-guard-dev-`（prod 对应 `ai-guard-`）。

## Secrets（wrangler secret）

| 名称 | 状态 |
|------|------|
| `ADMIN_TOKEN` | ✅ 已设置（32 字节随机） |
| `GROK_API_KEY` | ✅ 已设置（真 key） |
| `GEMINI_API_KEY` | ✅ 已设置（真 key） |

## 使用的模型

| 业务类型 | Provider | 模型 |
|---------|---------|------|
| comment / nickname / bio | Grok | `grok-4-fast-non-reasoning` |
| avatar | Gemini Vision | `gemini-2.5-flash` |

Provider 可在 Admin API / wrangler.toml `[vars]` 热切换，无需改代码。

## D1 初始状态

- 已执行 `migrations/0001_init.sql`。
- 表：`apps`, `prompts`, `moderation_requests`, `callback_deliveries`, `stats_rollup`。
- Seed 默认 prompt：
  - `comment/grok` v1 active
  - `nickname/grok` v1 active
  - `bio/grok` v1 active
  - `avatar/gemini` v1 active
  - `comment/gemini` v1 active（fallback 用）
  - `nickname/gemini` v1 active（fallback 用）
  - `bio/gemini` v1 active（fallback 用）

## 冒烟测试记录（真 key + 真模型，已跑通）

| 测试项 | 结果 |
|--------|------|
| `GET /health` | 200 ✓ |
| `POST /admin/apps` 创建应用 | 201 ✓ |
| `GET /admin/apps` 列表 | 200 ✓ |
| `GET /admin/stats/summary` 真实统计 | 200 ✓ |
| `POST /v1/moderate` 鉴权失败（bad HMAC） | 401 bad_signature ✓ |
| `POST /v1/moderate` 正常评论 → Grok | 200 pass/safe，~400ms ✓ |
| `POST /v1/moderate` 辱骂评论 → Grok | 200 reject/high/abuse，~580ms ✓ |
| `POST /v1/moderate` 广告评论 → Grok | 200 reject/medium/ad ✓ |
| `POST /v1/moderate` 正常/违规昵称 → Grok | 200 pass / reject ✓ |
| `POST /v1/moderate` 正常/违规简介 → Grok | 200 pass / reject ✓ |
| `POST /v1/moderate` 头像（async） → Gemini Vision | 202 accepted + 后续异步完成 ✓ |
| 缓存命中：同内容第 2 次请求 | cached=true，~480ms（无模型调用）✓ |
| Prompt 热更新（发新 version） | Admin API 生效，旧缓存自动失效，新请求走新 prompt ✓ |
| 回调投递 → webhook.site | `status_code=200, attempts=1, delivered_at` 有值 ✓ |
| Provider 路由：文本 Grok / 图片 Gemini | 按设计分流 ✓ |

### 实测性能

- Grok `grok-4-fast-non-reasoning` 审核文本：**~400–600ms**
- Gemini `gemini-2.5-flash` 审核图片：**~3–4s**
- 缓存命中：**~300–500ms**（只 KV，不打模型）

### 实测 token 开销（16 次请求后）

- 总输入 token：~2600
- 总输出 token：~520
- 缓存命中率：单会话内 ~6%（随时间上升）

## 样例应用

在 dev / prod 各建了一个 `demo-*` 应用。**凭证不入仓库**——放在项目根的 `SECRETS.local.md`（已 gitignore）。

如果丢了：
```bash
# 轮换（旧 secret 立即失效）
curl -X POST https://ai-guard-dev.schetkovvlad.workers.dev/admin/apps/<app_id>/rotate-secret \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

### 一条冒烟命令

```bash
BASE=https://ai-guard-dev.schetkovvlad.workers.dev
APP_ID=<see SECRETS.local.md>
SECRET=<see SECRETS.local.md>
BODY='{"biz_type":"comment","biz_id":"smoke-1","content":"hello"}'

eval $(node scripts/sign-request.mjs "$APP_ID" "$SECRET" "$BODY")
curl -sS "$BASE/v1/moderate" \
  -H "x-app-id: $X_APP_ID" \
  -H "x-timestamp: $X_TS" \
  -H "x-nonce: $X_NONCE" \
  -H "x-signature: $X_SIG" \
  -H "content-type: application/json" \
  --data-raw "$X_BODY"
```

替换占位 Grok/Gemini key 后应返回 `{"request_id":"...","cached":false,"result":{"status":"pass",...}}`。

## 生产（prod）尚未部署

一期先只部署了 dev。部署 prod 走：

```bash
bash scripts/bootstrap-cf.sh prod
wrangler secret put GROK_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put ADMIN_TOKEN
pnpm deploy
```
