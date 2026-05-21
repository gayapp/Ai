# 10 · Admin Web UI

## 访问地址

- **自定义域名**：<https://aicenter.1.gay>
- **Pages 默认域名**：<https://ai-guard-admin.pages.dev>
- **API Base 默认值**：`https://aicenter-api.1.gay`

## 登录

1. 打开 Admin UI。
2. `API Base` 保留默认生产域名，开发时可改成 localhost 或 dev Worker。
3. 填入 `ADMIN_TOKEN`。
4. Token 只存浏览器 localStorage，点击退出会清除。

不要在文档、聊天或 issue 中粘贴 `ADMIN_TOKEN`、app secret、Cloudflare token。

## 页面清单

| 路径 | 功能 |
| --- | --- |
| `/dashboard` | moderate / analyze 双轨总览：总量、状态、缓存、token、analyze 结果大小 |
| `/requests` | moderate 审核记录：按 app / biz / status 过滤，点击行看详情和 replay |
| `/analyze-ops` | analyze 灰度门禁：Ready、错误率、P95、pull/callback 积压、分布 |
| `/analyze-records` | analyze 长留存记录：按 app / biz / status / delivery / biz_id / 时间窗过滤 |
| `/callbacks` | callback 投递记录：支持只看失败或未投递 |
| `/providers` | Provider 状态：模型配置、secret 配置状态、KV 熔断状态、手动 health check |
| `/apps` | app 管理：新建、编辑、禁用、轮换 secret，支持 `IRC analyze` 预设 |
| `/prompts` | prompt 管理：moderate / analyze prompt 版本、发布、回滚 |
| `/alerts` | Telegram 告警测试、阈值检查、provider health 手动检查 |

## IRC 常用操作

### 创建 IRC analyze app

路径：`/apps`

1. 点击 `New app`。
2. 点击 `IRC analyze` 预设。
3. 填名称和 callback URL。
4. 确认：
   - `analyze_biz_types`: `media_analysis`, `media_intro`
   - `delivery_mode`: `both`
   - `provider_strategy`: `auto`
5. 创建后只显示一次 secret，请交给 IRC 安全配置。

### 灰度升档检查

路径：`/analyze-ops`

1. 选择 IRC app。
2. 选择观察窗口，正式升档建议 `24h`。
3. 填 IRC 原方案的 `baseline p95 ms`。
4. 点击 `Refresh`。
5. `Ready=YES` 且各 gate 通过后再升档。

如果 `Ready=NO`：

- 点 `只看错误` 进入 analyze 记录页查看 `error_code`。
- `pull_unacked > 0`：检查 IRC ack cron。
- `callback_undelivered > 0`：检查 IRC callback endpoint。
- provider 相关错误：去 `/alerts` 点 `检查 Provider 健康`。

灰度页的 Backlog 区域会按 `<5m` / `5m-30m` / `30m-2h` / `>2h` 展示：

- `pending`：请求仍未完成，通常看 queue 或 provider。
- `pull_unacked`：结果已完成但接入方未 ack，通常看 IRC pull/ack cron。
- `callback_undelivered`：结果已完成但 callback 未成功投递，通常看 callback URL、网络或重试状态。

### 单条 analyze 追查

路径：`/analyze-records`

可按 `biz_id` 对账 IRC 业务记录。点击行后可查看：

- `input_json`
- `result_json`
- `provider / model / prompt_version`
- `delivery_mode`
- `delivered_at`
- `acked_at`
- `error_code`

## moderate 记录详情

路径：`/requests`

点击行可查看完整 moderate 请求：

- request_id / app_id / biz_type / biz_id / user_id
- content_hash / content_text / evidence
- status / risk_level / categories / reason
- provider / model / prompt_version
- tokens / latency_ms / cached
- callback_url / mode / error_code / extra

文本类记录支持 replay，用当前 active prompt 重新跑一次，不写数据库。

## 应用管理

路径：`/apps`

- 新建 app：选择 moderate / analyze biz types、delivery mode、QPS、callback URL。
- `IRC analyze` 预设：清空 moderate biz，选择 `media_analysis` + `media_intro`，delivery 设置为 `both`。
- 轮换 secret：旧 secret 立即失效，新 secret 只显示一次。
- 禁用 app：软禁用，历史记录保留。

## Prompt 管理

路径：`/prompts`

- moderate providers：`grok` / `gemini`
- analyze providers：`xai` / `gemini`
- 发布新版本后立即 active。
- 回滚会切回历史版本。
- Dry run：
  - moderate：一行一个文本或图片 URL 样本，真实请求 provider 并校验输出 schema。
  - `media_intro`：一行一个 JSON input object，真实请求 xAI / Gemini text provider 并校验 `MediaIntroOutput`。
  - `media_analysis`：一行一个 JSON input object，只做 input schema 校验和 prompt preview，不请求多模态 provider。

## App Onboarding

路径：`/apps`

创建 app 或轮换 secret 后，弹窗会提供：

- 一次性 app secret。
- `AI_GUARD_*` env 配置片段。
- `/v1/analyze` submit / pull / ack 入口。
- HMAC 签名格式。

`Copy IRC env` 会复制完整 env 片段，适合 IRC 新建独立 app 后直接交接到安全配置。

## 告警

路径：`/alerts`

支持三个手动动作：

- 发送 Telegram 测试消息。
- 立即跑一次阈值检查。
- 检查 provider health。

Cron 自动行为：

- 每 5 分钟跑阈值检查。
- 每小时跑 provider health。

阈值在 `src/alerts/telegram.ts` 中定义，改动后需要重新部署 Worker。

## Provider 状态

路径：`/providers`

页面默认只调用 `GET /admin/providers/status`，不会请求上游，也不会触发告警。展示：

- Grok / Gemini secret 是否已配置。
- 当前 Grok / Gemini 模型名。
- global circuit：moderate 路由熔断状态。
- `media_analysis` / `media_intro` circuit：analyze 路由熔断状态。

`Run health check` 会调用 `POST /admin/alerts/provider-health`，真实请求上游 provider；如 provider 异常，可能按现有去重规则发送 Telegram 告警。

## 技术栈

- React 19 + Vite 7 + react-router v7，使用 HashRouter 适配 Pages 静态托管。
- 无 UI 库、无状态管理库，纯 React + CSS。
- API 客户端集中在 `admin-ui/src/lib/api.ts`。
- 静态资源由 Cloudflare Pages 托管，可独立于 Worker 发布。

## 规划

后台全面规划见 [16-admin-console-roadmap.md](16-admin-console-roadmap.md)。
