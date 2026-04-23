# 10 · Admin Web UI

## 访问地址

- **默认 URL**：<https://ai-guard-admin.pages.dev>（立刻可用）
- **自定义域名**：`https://aicenter.gv.live`（**待完成一步**，见下）

## 登录

1. 打开 URL
2. `API Base` 保留默认 `https://aicenter-api.gv.live`
3. `ADMIN_TOKEN` 粘贴（从 `SECRETS.local.md` 或新建环境的 wrangler secret）
4. Token 存浏览器 localStorage，登出会清

## 页面清单

| 路径 | 功能 |
|------|------|
| `/dashboard` | 总览（请求数/通过率/缓存命中率/Token 消耗/状态堆叠条 + 最近 20 条） |
| `/requests` | 全量审核记录（按 app/biz/status 过滤，点行看详情） |
| `/callbacks` | 回调投递列表（可筛仅失败） |
| `/apps` | 应用管理（新建/轮换 secret/启用禁用） |
| `/prompts` | Prompt 管理（新版本/回滚/干跑） |
| `/alerts` | Telegram 告警配置 + 手动测试 |

### 审核记录详情（点击行）

完整字段：request_id / app_id / biz_type / biz_id / user_id / content_hash / status / risk_level / categories / reason / provider / model / prompt_version / tokens / latency_ms / callback_url / mode / cached / extra / 创建/完成时间。

### 应用管理
- 新建应用：弹窗选启用的 biz_types、QPS 限额、回调 URL；创建后一次性弹出 secret
- 轮换 secret：旧的立即失效
- 启用/禁用：软禁用，不删除历史

### Prompt 管理
- 按 biz_type × provider 筛选，展示全部历史版本
- 当前 active 在卡片高亮
- "发布新版本"：编辑弹窗（默认带上当前 active 正文），发布立即生效
- "回滚到此"：任一历史版本一键切回 active
- "干跑测试"：临时 prompt + N 条样本，走真实模型但不影响线上

### Telegram 告警
- 说明了从创建 Bot → 拿 chat_id → 配置 secret 的 4 步
- "发送测试消息"：立刻触发一条测试告警
- "立即跑一次阈值检查"：手动执行 scheduled 里的检查逻辑

## 技术栈

- **React 19** + **Vite 7** + **react-router v7** (HashRouter，适配 Pages 静态托管)
- 无 UI 库、无状态管理库 —— 纯 React + CSS（手写暗色主题，支持浅色模式）
- 所有 API 走 `src/lib/api.ts`，`Authorization: Bearer <token>` 统一处理
- 产物：263KB / 82KB gzipped

## 完成 `aicenter.gv.live` 的最后一步

Pages 自定义域名已申请，但 DNS CNAME 记录需要 Zone:DNS:Edit 权限（当前 API Token 不含）。二选一：

### 方案 A · CF Dashboard 手动加 CNAME（推荐，30 秒）

1. 打开 <https://dash.cloudflare.com/> → 选 `gv.live` 域 → DNS → Records
2. 点 "Add record"：
   - **Type**：`CNAME`
   - **Name**：`aicenter`
   - **Target**：`ai-guard-admin.pages.dev`
   - **Proxy**：✅ Proxied（橙云）
   - **TTL**：Auto
3. 保存。2 分钟内 Pages 自动签发 SSL，`https://aicenter.gv.live` 生效

### 方案 B · 生成 DNS Edit Token 我自动做

新建一个 API Token（My Profile → API Tokens → Create Token → Custom），权限：

- Zone / DNS / Edit（对 `gv.live` 或 All zones）
- Account / Cloudflare Pages / Edit
- Account / Workers Scripts / Edit

给我新 token，我一条命令搞定。
