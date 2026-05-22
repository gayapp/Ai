# 17 · Admin Console 任务清单

> 更新日期：2026-05-22  
> 范围：管理后台后续开发任务看板。本文用于让用户在开发前看到计划、优先级、验收标准和需要配合的点。

## 使用方式

- 每次继续开发前，先看本清单。
- 做完一项后更新状态、提交文档和代码。
- 涉及契约、schema、留存策略、生产部署策略的任务，先开 ADR 或向用户确认。
- 生产 Worker 部署仍需用户明确授权；Admin UI Pages 可独立发布。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| Done | 已开发、验证、部署或已合并 |
| Next | 下一批优先开发 |
| Planned | 已规划，排在 Next 后 |
| Needs input | 需要用户或 IRC 侧提供信息 |
| Blocked | 被外部条件阻塞 |
| Deferred | 暂缓，不影响当前 IRC 接入 |

## 已完成

| ID | 任务 | 状态 | 验收 |
| --- | --- | --- | --- |
| ADM-001 | Apps 双轨配置 | Done | app 同时支持 `biz_types` 与 `analyze_biz_types` |
| ADM-002 | IRC analyze 预设 | Done | 新建 app 可一键选择 `media_analysis` / `media_intro` / `both` |
| ADM-003 | Analyze records 页面 | Done | 可按 app / biz / status / delivery / biz_id / window 查询 |
| ADM-004 | Analyze 灰度页 | Done | 展示 ready gate、错误率、P95、dedup、交付状态 |
| ADM-005 | Analyze backlog | Done | 展示 pending / pull_unacked / callback_undelivered 年龄桶 |
| ADM-006 | Provider 状态页 | Done | 展示模型、secret 配置、global/analyze circuit |
| ADM-007 | App onboarding | Done | 创建/轮换 secret 后展示 IRC env、pull/ack、HMAC |
| ADM-008 | Analyze prompt dry-run | Done | `media_intro` provider 干跑；`media_analysis` schema + prompt preview |
| ADM-009 | 审计日志 | Done | 记录 app create/update/rotate-secret 与 prompt publish/rollback |

## 下一批开发

| ID | 优先级 | 任务 | 为什么做 | 验收 | 备注 |
| --- | --- | --- | --- | --- | --- |
| ADM-010 | P1 | Roadmap / 任务清单页面 | 用户可以在后台看到下一步计划 | Admin UI 有 `/roadmap`，文档有本清单 | 本轮推进 |
| ADM-011 | P1 | Analyze 灰度报告复制 | IRC 升档需要把门禁结果贴到群或 issue | `/analyze-ops` 支持复制 Markdown 报告 | 不改后端 |
| ADM-012 | P1 | 审计日志 CSV 导出 | 方便安全审查 | `/audit` 支持导出当前过滤结果 | 前端导出即可 |
| ADM-013 | P1 | Prompt regression set 设计 | 发布 prompt 前要比对样本集 | 文档先定义样本集格式与保存策略 | 可能需要 D1 表 |

## 已规划

| ID | 优先级 | 任务 | 为什么做 | 验收 | 风险 |
| --- | --- | --- | --- | --- | --- |
| ADM-014 | P2 | Prompt regression set 实现 | 降低 prompt 发布回归风险 | 可保存样本集、运行 draft vs active、展示差异 | 需要新增表和更多模型调用 |
| ADM-015 | P2 | 多环境明显标识 | 防止 dev/prod 操作混淆 | Header 明确显示 API Base 环境和危险提示 | 仅前端 |
| ADM-016 | P2 | 灰度 runbook 内嵌 | 失败 gate 直接看到处置建议 | `/analyze-ops` 每个失败 gate 展示对应处理步骤 | 仅前端 |
| ADM-017 | P2 | 成本看板 | 按 app / biz / provider 估算 token 成本 | Dashboard 增加成本估算卡片 | 需要维护模型价格配置 |
| ADM-018 | P2 | Analyze records 导出 | 方便离线对账 | 当前过滤条件可导出 CSV | 注意 result_json 体积 |

## 需要用户或 IRC 侧配合

| ID | 事项 | 需要谁 | 说明 |
| --- | --- | --- | --- |
| INP-001 | IRC 独立 app 是否创建 | 用户 / IRC | 若需要隔离“一起看”，在 `/apps` 创建独立 IRC app |
| INP-002 | IRC baseline P95 | IRC | `/analyze-ops` 灰度 gate 需要原内部方案 P95 |
| INP-003 | IRC 灰度开始时间 | IRC | 避免 24h 窗口混入早期 smoke 失败样本 |
| INP-004 | Prompt regression 样本 | 运营 / IRC | ADM-013/014 需要样本输入和预期输出 |
| INP-005 | 权限模型 | 用户 | 是否需要只读/运营/管理员分级 |

## 暂缓

| ID | 任务 | 暂缓原因 |
| --- | --- | --- |
| DEF-001 | 完整 RBAC | 当前只有 Bearer admin token，Cloudflare Access 未作为强依赖接入 |
| DEF-002 | 站内通知中心 | Telegram + 页面状态已覆盖当前运维 |
| DEF-003 | 自动生产发布流水线 | 当前仍采用人工授权生产部署，更安全 |

## 下一步建议

当前建议顺序：

1. ADM-010 Roadmap / 任务清单页面。
2. ADM-011 Analyze 灰度报告复制。
3. ADM-012 审计日志 CSV 导出。
4. ADM-013 Prompt regression set 设计。

如果 IRC 灰度已经开始，优先 ADM-011。若还在准备接入，优先 ADM-013。
