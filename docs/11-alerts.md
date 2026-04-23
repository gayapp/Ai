# 11 · 告警（Telegram）

## 阈值

| 指标 | 阈值 | 行为 |
|------|------|------|
| 错误率 | ≥ 5% | warn（≥20% → crit） |
| 最高延迟 | ≥ 15s | warn |
| 时间窗口 | 最近 5 分钟 | 滚动检查 |
| 最小样本 | 20 条请求 | 低于不判定 |
| 去重 | 同类型 5 分钟内不重发 | 防刷屏 |

额外的 provider 监控：

| 指标 | 阈值 | 行为 |
|------|------|------|
| **Provider 凭证失效**（401/403） | 任何一次 | **crit**，立即熔断 10 min，同时 Telegram + 邮件 |
| **xAI key 巡检** `/v1/api-key` | 每小时 | `api_key_disabled` / `team_blocked` → crit |
| **Gemini key 巡检**（最小 ping） | 每小时 | `API_KEY_INVALID` / 401 → crit |

触发频率：
- Cron `*/5 * * * *` — 错误率/延迟检查
- Cron 每小时整点 — provider 健康巡检（`checkProviderHealth`）
- 实时 — Provider 返回 401/403 时 pipeline 立即 `alertProviderAuthFailed`

配置在 [wrangler.toml](../wrangler.toml)。
阈值代码：
- [src/alerts/telegram.ts](../src/alerts/telegram.ts) · 错误率/延迟
- [src/alerts/provider-health.ts](../src/alerts/provider-health.ts) · key 状态

## 邮件通知（可选）

基于 Resend 服务。免费档每月 100 封。

```bash
# 1. 注册 https://resend.com，拿 API Key
# 2. wrangler secret put RESEND_API_KEY
# 3. wrangler secret put ALERT_EMAIL     # 收件人
# 4. (可选) wrangler secret put ALERT_EMAIL_FROM   # 默认 alerts@resend.dev
```

未配置 `RESEND_API_KEY` + `ALERT_EMAIL` 时邮件告警 no-op（仅 Telegram 发）。
仅在 **provider 凭证失效**这种 crit 级场景发邮件，避免刷屏。

## 配置（一次性，约 3 分钟）

### 1. 创建 Bot

1. Telegram 里找 `@BotFather`
2. `/newbot` → 取名 → 取 username（以 `bot` 结尾）
3. 拿到 Bot Token：`123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxx`

### 2. 拿 Chat ID

**个人聊天**：
1. 先给你的 Bot 发一条消息（任何内容）
2. 浏览器打开 `https://api.telegram.org/bot<你的 TOKEN>/getUpdates`
3. 找 `chat.id` 字段（正数）

**群组聊天**（推荐，多人看）：
1. 把 Bot 拉进群
2. 在群里发 `/start@你的_bot_username`
3. 同样访问 `getUpdates`，`chat.id` 是负数

### 3. 配置 secret

```bash
cd C:\code\ai
export CLOUDFLARE_API_TOKEN='<你的 token>'

# prod
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID

# dev（可选）
wrangler secret put TELEGRAM_BOT_TOKEN --env dev
wrangler secret put TELEGRAM_CHAT_ID --env dev
```

### 4. 测试

在 Admin UI → 告警页 → 点"发送测试消息"。如果 Telegram 收到 *"🟦 ai-guard · 告警自检"*，配置成功。

未配置时 Cron 仍会跑，只是告警不会发出（no-op），不会报错。

## 消息样例

```
🚨 *ai-guard · 错误率告警*
时间窗口: 最近 5 分钟
请求总数: 142
错误数: 18
错误率: 12.68%（阈值 5%）

排查: https://aicenter.1.gay/#/requests?status=error

_2026-04-23T15:30:00.000Z_
```

## 手动触发（运维排查用）

```bash
# 发一条测试消息
curl -X POST https://aicenter-api.1.gay/admin/alerts/test \
  -H "authorization: Bearer $ADMIN_TOKEN"

# 立即执行一次阈值检查（绕过 cron）
curl -X POST https://aicenter-api.1.gay/admin/alerts/check \
  -H "authorization: Bearer $ADMIN_TOKEN"
```
