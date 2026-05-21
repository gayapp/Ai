# 16 · Admin Console 全面规划

> 更新日期：2026-05-22  
> 范围：ai-guard 管理后台的信息架构、IRC analyze 运维闭环、后续开发路线。本文不包含任何 secret。

## 目标

管理后台从“审核配置工具”升级为双轨运营控制台：

| 轨道 | 核心用户 | 后台要解决的问题 |
| --- | --- | --- |
| moderate | 审核运营 / 风控 / Prompt 维护 | 看审核质量、追查单条请求、热更新 prompt、处理回调失败 |
| analyze | IRC / 内容服务接入方 / 运维 | 创建 analyze app、观察灰度门禁、追踪 pull/callback 交付、排查 provider 与模型问题 |

不可破坏的边界：

- `/v1/moderate` 的 4 个 biz_type 请求和回调字段不变。
- `docs/04-callback-spec.md` 不动；analyze 回调看 `docs/13-callback-spec-analyze.md`。
- app secret 只在创建或轮换时明文显示一次，文档和后台不得持久展示。
- prod Worker 部署仍需用户授权；Admin UI Pages 可独立发布。

## 当前信息架构

| 页面 | 现状 | IRC 相关用途 |
| --- | --- | --- |
| `/dashboard` 总览 | moderate / analyze 双轨摘要，按 1h / 24h / 7d 看请求、错误、token、缓存 | 日常看 analyze 总量、OK 率、错误数 |
| `/analyze-ops` Analyze 灰度 | 新增灰度门禁页，调用 `/admin/stats/analyze-gray` | IRC 升档前查看 ready、错误率、P95、pull/callback 积压 |
| `/analyze-records` 内容服务记录 | 长留存 input/result 明细，支持 app / biz / status / delivery / biz_id / window 过滤 | 按 `request_id` / `biz_id` 对账，查看完整 input_json / result_json |
| `/apps` 应用管理 | 创建、编辑、禁用、轮换 secret；支持 `IRC analyze` 预设 | 创建 IRC 独立 app，选择 `media_analysis` / `media_intro` 和 `delivery_mode=both` |
| `/prompts` 指令管理 | moderate 与 analyze prompt 版本管理，支持 analyze provider `xai` / `gemini` | 查看或发布 `media_analysis` / `media_intro` prompt |
| `/callbacks` 回调投递 | 查看 callback 失败与重试 | 排查 IRC callback 未到达 |
| `/alerts` 告警 | Telegram 测试、阈值检查、provider health 手动检查 | Gemini / xAI 故障时辅助判断是否触发降级或熔断 |

## IRC 标准操作流

### 1. 创建独立 IRC app

后台路径：`/apps`

1. 点击 `New app`。
2. 点击 `IRC analyze` 预设。
3. 填写名称，例如 `IRC` 或 `IRC prod`。
4. 填写 IRC callback URL。
5. 确认：
   - `analyze_biz_types`: `media_analysis`, `media_intro`
   - `delivery_mode`: `both`
   - `provider_strategy`: `auto`
   - `rate_limit_qps`: 按 IRC 峰值设置，默认预设为 500
6. 创建后把一次性显示的 secret 交给 IRC 安全配置，不在文档或聊天中明文传播。

### 2. 灰度观察

后台路径：`/analyze-ops`

升档前选择 IRC app，设置：

- `window`: 推荐 24h；刚开始 smoke 可用 1h。
- `IRC baseline p95 ms`: IRC 原内部方案的 P95，单位 ms。
- `sample limit`: 默认 10000。

门禁全部通过时，`Ready` 显示 `YES`。当前后端门禁：

| Gate | 标准 |
| --- | --- |
| 有样本 | 样本数 > 0 |
| 错误率 | `< 1%` |
| pending | 无超过 5 分钟仍 pending 的请求 |
| 缓存命中 | `>= 30%` |
| 延迟 | ai-guard P95 `<= IRC baseline P95 × 1.5` |

如果失败：

- 错误率失败：点 `只看错误` 跳到 `/analyze-records`，看 `error_code` 与 detail。
- pending 失败：看 `/analyze-records?status=pending`，确认 queue / provider 是否卡住。
- pull unacked 或 callback undelivered 非 0：分别排查 IRC ack cron 或 callback endpoint。
- provider 相关错误：去 `/alerts` 点 `检查 Provider 健康`。

### 3. 单条追查

后台路径：`/analyze-records`

常用查询：

- 按 `request_id`：点击行看 detail。
- 按 `biz_id`：输入 IRC 侧业务 ID 后点 Refresh。
- 按 `status=error`：定位 provider / schema / timeout 问题。
- 按 `delivery=pull|callback|both`：区分交付链路。

detail 中重点字段：

- `input_json`: IRC 原始提交内容。
- `result_json`: ai-guard 输出给 IRC 的结构化结果。
- `provider / model / prompt_version`: 判断走了哪个模型与 prompt。
- `acked_at / delivered_at`: 判断 pull 与 callback 是否闭环。

## 开发路线

### P0 已完成

- app 双轨配置：`biz_types` + `analyze_biz_types`。
- delivery mode：`callback` / `pull` / `both`。
- analyze 记录长留存查看。
- `IRC analyze` app 创建预设。
- analyze 灰度门禁页。
- provider health 手动检查入口。
- Provider 状态页：模型配置、secret 配置状态、global/analyze KV 熔断状态。
- Analyze backlog 统计：pending / pull_unacked / callback_undelivered 年龄桶。
- App onboarding：创建或轮换 secret 后显示 IRC env、pull/ack 入口和 HMAC 签名格式。
- Analyze prompt dry-run：`media_intro` provider 干跑；`media_analysis` input schema + prompt preview。

### P1 建议下一轮

| 项 | 价值 | 验收 |
| --- | --- | --- |
| 审计日志 | 记录 app secret rotation、prompt publish、disable app 等管理动作 | D1 新表 + Admin UI 列表 |
| Analyze prompt regression set | Prompt 发布前批量跑固定样本集 | 支持保存样本集、对比 active vs draft |

### P2 后续增强

| 项 | 价值 |
| --- | --- |
| 多环境切换 | 在同一后台安全切换 dev / prod API Base，并显著标记环境 |
| 角色权限 | 区分只读、运营、运维、超级管理员 |
| 导出与报表 | CSV 导出 analyze 记录、灰度报告复制成 Markdown |
| Runbook 内嵌 | 页面根据失败 gate 展示对应操作命令和文档链接 |
| 成本看板 | 按 app / biz / provider 估算 token 与外部模型成本 |

## 文档索引

- 管理后台使用说明：[10-admin-ui.md](10-admin-ui.md)
- Admin API：[03-api-admin.md](03-api-admin.md)
- 内容服务总览：[12-content-service.md](12-content-service.md)
- Analyze 回调：[13-callback-spec-analyze.md](13-callback-spec-analyze.md)
- Analyze pull / 调用记录：[14-analyze-records.md](14-analyze-records.md)
- Analyze 灰度 runbook：[15-analyze-gray-runbook.md](15-analyze-gray-runbook.md)
- IRC 交接：[apps/IRC-analyze-handoff.md](apps/IRC-analyze-handoff.md)
