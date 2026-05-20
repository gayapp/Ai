# IRC · AI 中转平台接入可行性调研

> ⚠️ **2026-05-19 方向调整说明**
>
> 本文初稿假设 ai-guard 维持"UGC 审核中转"定位不变，结论是"IRC 只接入 text_moderator 一条线，其余维持直连 xAI / Gemini"。
>
> 经与 IRC 项目方对齐，**方向调整为**：ai-guard 从"UGC 审核中转"扩展为"AI 内容服务中转"，新增"内容生成 / 分析"业务线（视频帧 / 图片 / 简介生成等）；IRC 主流 AI 调用以独立 biz_type 接入新业务线，而不是套用现有审核 schema。
>
> 新方向的正式规划见 [optimization/content-services-expansion.md](../optimization/content-services-expansion.md)（RFC）。
>
> 本文降级为**输入素材**：保留 IRC 五条 AI 链路的盘点（§2）、文件清单（§8.1）和文本审核线的接入路径（§4.1 / §5）作为新方向 P1 阶段的子集；§3 的兼容性矩阵不再适用（其前提"ai-guard 输出 schema 不变"已被推翻）。
>
> ---
>
> 调研对象：ai-guard（本仓库，`C:\code\ai\`）
> 调研主体：IRC 智能资源中心（`c:\code\irc\`）
> 撰写日期：2026-05-19
> 状态：**已被新规划取代（输入素材保留）**
> 参考契约（不再重述）：
> - [02-api-public.md](../02-api-public.md) — Public API
> - [04-callback-spec.md](../04-callback-spec.md) — 固定回调契约
> - [01-architecture.md](../01-architecture.md) — 数据模型 / Queue / KV
> - [apps/一起看-integration.md](一起看-integration.md) — 当前最完整的接入实例

---

## 0. 一句话结论

IRC 共有 **5 条独立 AI 链路**，其中 4 条（视频帧 / 图片 / 小说 / 简介生成）输出的是**结构化任务结果**（tags、cover、region、intro、title 等），与 ai-guard 当前固定 4 种 biz_type 审核 schema 不兼容；唯一与 ai-guard **强对齐** 的是 `text_moderator`（文本审核），建议作为首批接入；其余 4 条维持 IRC 直连 xAI / Gemini 不变。

---

## 1. 双方背景与定位对照

| 维度 | ai-guard | IRC |
|------|----------|-----|
| 定位 | 成人男同社交 APP 的 **UGC 审核**中间层 | 公司"生产环境资料中心"：8 类资产（GV / 社区视频 / 社区图文 / 电影 / 电视 / 写真 / 小说 / 漫画）的去重、AI 整理、分发 |
| 主要业务 | 4 种 biz_type：`comment / nickname / bio / avatar` | 视频帧多模态分析 / 图片分析 / 小说分析 / 简介生成 / 文本审核 |
| 对外契约 | 固定 JSON schema（status / risk_level / categories / reason），代码层 Zod 锁死 | 各模块各自 schema（含 8+ 字段的复合结构） |
| 鉴权 | HMAC-SHA256 + Timestamp + Nonce + AppId（4 header） | 内部：`X-IRC-Signature` + `X-IRC-Timestamp`（2 header，已自建） |
| Prompt 管理 | D1 prompts 表 + KV 60s 热更新 + 版本号 + 发布 diff | D1 `vrc_prompts` 表 + `prompt_service.resolve_prompt` + 版本 / 草稿 / 发布 diff（管理后台 [prompts.vue](../../worker/admin-web/src/views/prompts.vue) 已实现） |
| Provider | xAI Grok（文本）+ Gemini Vision（图像）+ router 熔断 | xAI Grok / Gemini，`AIClient._resolve_provider_order` 实现简单 fallback |
| 应用注册 | `apps` 表：app_id / secret_hash / callback_url / biz_types / rate_limit_qps | `vrc_apps` 表（**注意：语义不同**，见下） |

### 关键差异 1：两个 "app" 是不同概念

- **ai-guard `apps`**：消费 AI 审核能力的业务方（一起看、同趣、IRC 等）。
- **IRC `vrc_apps`**：IRC 自己作为分发服务，给采集端 / 同趣 / 一起看 / 旧采集中心提交资源时的身份。**与 ai-guard 的 apps 是不同维度**。

→ 如果 IRC 接入 ai-guard，IRC **整体**在 ai-guard 这边表现为 **一个 app**（例如 `app_irc`）。IRC 与 vrc_apps 之间的关系不动。

### 关键差异 2：IRC 已经实现了"迷你 ai-guard"

`text_moderator.moderate(task_id, text, app_id, callback_url)` 这一调用形态：

- 入参里有 `app_id` + `callback_url`
- 出向 `callback_url` POST 时带 `X-IRC-Signature` HMAC 签名（[`build_callback_signature`](../../python/app/pipeline/callback_sender.py)）
- secret 来自 `vrc_apps.secret_key`

实质上 IRC 内部已经有一个 **专门给其上游应用做文本审核** 的中转层。这意味着接入 ai-guard 不是"从无到有"，而是**把 IRC 这一层的 AI 实现替换成 ai-guard 调用**。

---

## 2. IRC 现状 AI 调用全景

| 序 | 模块 | 入口 | 输入 | 输出（关键字段） | 调用方式 | provider | 同步性 |
|---|---|---|---|---|---|---|---|
| ① | 视频帧分析 | [ai_analyzer.py](../../python/app/pipeline/ai_analyzer.py) | 8 张视频帧 + 标题 + duration | moderation + tags + ad_detection + faceCoordinates + cover_candidates + trial + region + frame_notes | `AIClient.analyze_video_frames` | xai / gemini fallback | pipeline 内同步 |
| ② | 图片分析 | [image_analyzer.py](../../python/app/pipeline/image_analyzer.py) | 单张图（含 OCR + 人脸 + 地区） | 类似 ① 的 single-image 版 + OCR/face 子字段 | `analyze_video_frames` 复用 | xai / gemini | 同步 + 内部 callback |
| ③ | 小说分析 | [novel_analyzer.py](../../python/app/pipeline/novel_analyzer.py) | 整本采样章节文本 | ai_title + ai_intro + ai_categories | `generate_text_json` | xai / gemini | 同步 |
| ④ | 简介生成 | [intro_generator.py](../../python/app/pipeline/intro_generator.py) | 视频结构化结果 + OCR + 字幕 | ai_intro | `generate_text_json` | xai / gemini | 同步 |
| ⑤ | 文本审核 | [text_moderator.py](../../python/app/pipeline/text_moderator.py) | 评论 / 简介 / 昵称类纯文本 | action + reason + flagged_content + categories(contact_info/external_link/underage/spam) | `generate_text_json` | xai / gemini | 同步 + HMAC callback |

所有调用最终落在 [`ai_client.py`](../../python/app/services/ai_client.py)，统一走 `XAI_API_KEY` / `GEMINI_API_KEY`（IRC 自有），并在 [`token_metrics.py`](../../python/app/monitoring/token_metrics.py) 中做 token 计费聚合。

---

## 3. 兼容性矩阵

| IRC 模块 | 与 ai-guard 哪种 biz_type 对应 | 兼容度 | 关键不匹配点 |
|---|---|---|---|
| ① 视频帧 | 无 | ❌ 不兼容 | 输出 8 个独立结构化字段（tags / cover / region / face / trial / ad），ai-guard 输出只有 `status / risk_level / categories[] / reason` |
| ② 图片单图 | `avatar`（部分） | ⚠️ 部分 | 只有 moderation 子结果能对齐；tags / region / OCR / face / cover 候选都无法承接 |
| ③ 小说 | 无 | ❌ 不兼容 | 是文本**生成任务**（title / intro / categories），不是判定 |
| ④ 简介生成 | 无 | ❌ 不兼容 | 同上，生成任务 |
| ⑤ 文本审核 | `comment` / `nickname` / `bio` | ✅ **强对齐** | 输入纯文本、输出 pass/reject/review、类别枚举几乎可一一映射；并且 IRC 默认 prompt 与 ai-guard v3 默认 prompt **同标的**（成人男同社交平台） |

### 字段映射草表（仅 ⑤ 文本审核）

| IRC `ModerationResult` 字段 | ai-guard 回调字段 | 映射 |
|---|---|---|
| `action: allow` | `status: pass` | 直接对应 |
| `action: reject` | `status: reject` | 直接对应 |
| `action: review` / `manual_review` | `status: review` | 直接对应 |
| `reason` | `reason` | 直接对应 |
| `flagged_content[]`（自由文本数组，IRC 自己 + AI 合并产生） | 无对应字段 | **不可直接覆盖**——需要 IRC 在收到 ai-guard 回调后，结合本地规则（contact / minor pattern）自己组装 |
| `categories.contact_info / external_link / underage / spam` | `categories[]`（枚举 `politics / porn / abuse / ad / spam / violence / other`） | 部分映射：`underage → other + 高 risk_level`、`contact_info / external_link → ad`、`spam → spam`；需要 IRC 端做一层翻译 |

---

## 4. 推荐接入路径

### 4.1 第一优先：text_moderator 内部委托给 ai-guard

**改造范围**：仅 [`text_moderator._analyze_with_ai`](../../python/app/pipeline/text_moderator.py) 一处。

**改造前**（当前）：

```
IRC text_moderator.moderate(text, app_id, callback_url)
  → rule check（contact / minor / spam pattern）
  → ai_client.generate_text_json(prompt_service.resolve('text_moderation_v?'))
  → merge_moderation_results(rule, ai)
  → POST callback_url（X-IRC-Signature）
```

**改造后**：

```
IRC text_moderator.moderate(text, app_id, callback_url)
  → rule check（同前，保留 IRC 本地）
  → ai-guard adapter:
        POST /v1/moderate
          biz_type = comment | bio | nickname（按 IRC 入口区分）
          content  = sanitized_text
          mode     = sync
          extra    = { rule_hints: { has_contact, has_minor, ... } }
        ← 200 + result（或 202 + callback 入 IRC 中转队列）
  → translate ai-guard categories → IRC categories
  → merge with rule
  → POST 上游 callback_url（保持 X-IRC-Signature，IRC 仍是中转）
```

**收益**：
- 减一份 prompt 维护：IRC `text_moderation_*` prompt → 全切到 ai-guard 的 `comment / bio / nickname`
- 减一份 token / 错误率统计：移到 ai-guard `stats_rollup`
- 减一份 xAI / Gemini key：IRC `ai_client.py` 在 text 通路上不再需要直连
- 复用 ai-guard 的 KV 去重缓存（相同短文本秒级返回，省 token）
- 复用 ai-guard 的 provider 熔断 / fallback / 告警

**风险**：
- ai-guard 当前默认 50 QPS / app（一起看升到 100）。IRC 文本审核流量需先压测，超 200 QPS 需协商上调
- IRC 原 `flagged_content[]`（自由文本数组）丢失—— ai-guard 不返回这种字段。需要 IRC 用 `categories[] + 本地规则结果` 重建
- 改造期间需要 feature flag（建议环境变量 `TEXT_MODERATION_BACKEND=internal|ai_guard`），灰度比对，避免一次切爆

### 4.2 第二优先（可选）：image_analyzer 中 moderation 子结果二次校核

**思路**：image_analyzer 走完 IRC 自己的多模态管线后，把 moderation 子字段额外通过 ai-guard `biz_type=avatar` 做一次二次确认，构成双轨审核。

**收益**：图片审核双源校验，提升 reject 召回率。
**成本**：每张图额外一次 Gemini 调用（~3.5s + token 翻倍）。
**建议**：仅作为 **管理后台 toggle** 而非默认开启，且仅对疑似 unsafe 的子集开启（基于 IRC 自己 moderation.confidence 阈值二次过滤后再送）。

### 4.3 不推荐接入

- ① 视频帧分析、③ 小说分析、④ 简介生成：输出 schema 不兼容，且都是"任务执行"而非"审核判定"。维持 IRC 直连 xAI / Gemini。
- 如果未来 ai-guard 想扩展，可在 `docs/optimization/` 里加一条"通用 JSON 任务代理"愿景，**但这会直接挑战"对外契约"铁律**（[04-callback-spec.md](../04-callback-spec.md) 开篇 ★），不在本调研推荐之列。

---

## 5. 阶段化路线图

| 阶段 | 工作 | 工时（粗估） | 前置依赖 |
|---|---|---|---|
| P0 | ai-guard 管理员在 Admin UI 注册 `app_irc`：启用 biz_types=[comment, bio, nickname]，发 secret 通过安全渠道交给 IRC；IRC 把 secret 写入 `secrets-hub`（`& "C:\code\secrets-hub\bin\secrets.ps1" get ai_guard_secret`） | 0.5 d | ai-guard 管理员配合 |
| P1 | IRC 侧 `text_moderator` 增加 `AiGuardClient` adapter（HMAC 签名 + sync /v1/moderate + 类别翻译），feature flag `TEXT_MODERATION_BACKEND` 控制走旧（internal）还是新（ai_guard） | 1 d | P0 |
| P2 | 灰度：在低流量 biz_type（如社区图文短简介审核）开 10% → 50% → 100%，对比一周 reject/review/error 命中差异 | 1 周 | P1 |
| P3 | 全量切换 + 下线 IRC 内置 `text_moderation_*` prompt 版本表（保留只读归档 90 天） | 0.5 d | P2 |
| P4 (可选) | image_analyzer 二次校核 toggle | 1.5 d | P3 |

**评审建议**：P1 出 IRC 侧 SPEC 文档（`docs/specs/SPEC-YYYYMMDD-ai-guard-text-adapter.md`，依 IRC 流程规范 v1.7）；P2 灰度策略与回滚剧本沉淀进 IRC `docs/runbook/`。

---

## 6. 风险与边界

| 风险 | 说明 | 缓解 |
|------|------|------|
| QPS 不足 | ai-guard 默认 50 QPS / app；IRC 文本审核（社区帖子 + 简介 + 昵称）合计可能突发 100+ | P1 前先做流量测算；ai-guard 端可独立调高 IRC 限额 |
| 契约绝对锁死 | ai-guard `04-callback-spec.md` 是铁律契约；IRC 不能要求 ai-guard 多返字段 | 字段缺口在 IRC 端用本地规则 + 翻译层补齐（`flagged_content` 自由文本即此例） |
| Prompt 同标的但不同实现 | ai-guard v3 默认 prompt 与 IRC `text_moderation` 默认 prompt 都标的"成人男同平台"，但具体判定边界不同 | P2 灰度时需逐 case 对比；如有显著差异，推动 ai-guard `tune-prompt` skill 而非 IRC 各自维护 |
| 数据所有权与统计 | IRC `token_metrics` 表会失去 text 链路数据 | 接受。统计迁到 ai-guard Admin UI（[06-stats.md](../06-stats.md)）；IRC 端只保留视频/图片/小说三条线的 token 视图 |
| 失败回退 | ai-guard 整体故障时 IRC 文本审核会中断 | feature flag 保留"回切 internal" 的能力（P1 出口设计） |

---

## 7. 待 ai-guard / IRC 双方协商的开放问题

1. **是否需要新 biz_type**？IRC 的"社区图文帖子（community_posts）正文" 与 `comment` 边界略有不同（更长、可能含多段）；是否复用 `comment` 还是新增 `forum_post`？建议先复用，观察 prompt 命中率再说。
2. **`extra` 字段的 rule hints 会被 ai-guard prompt 利用吗**？IRC 想把本地规则前置结果（contact 命中、minor 命中）作为 hint 透传——目前 ai-guard `extra` 是回调原样回传，不进 prompt。是否考虑 ai-guard 端做一个 "prompt-aware extra"？或者推动 ai-guard 落地 [edge-prefilter.md](../optimization/edge-prefilter.md) 之后由 ai-guard 自己识别？
3. **IRC 现有上游 callback 协议（X-IRC-Signature）是否要逐步迁到 ai-guard 协议**？涉及同趣 / 一起看 / 采集软件多个外部 SDK。**短期建议不动**——IRC 保留中转身份，外部 SDK 零改造；长期可再讨论统一。
4. **IRC 在 ai-guard 上能否获取"应用作用域只读 token"**？方便 IRC 运维只看自己 app 的 D1 记录（参见 [一起看-integration.md](一起看-integration.md) §11 末段提到的方案）。
5. **QPS 上限建议值**？取决于 IRC 上游业务方流量，请双方先各报一个估算值。

---

## 8. 附录

### 8.1 IRC AI 链路关键文件清单

| 链路 | 关键文件 |
|------|----------|
| ① 视频帧 | [python/app/pipeline/ai_analyzer.py](../../python/app/pipeline/ai_analyzer.py)、[python/app/services/ai_client.py:69](../../python/app/services/ai_client.py#L69) `analyze_video_frames` |
| ② 图片 | [python/app/pipeline/image_analyzer.py](../../python/app/pipeline/image_analyzer.py)、`image_callback.py` |
| ③ 小说 | [python/app/pipeline/novel_analyzer.py](../../python/app/pipeline/novel_analyzer.py)、`novel_prompt.py` |
| ④ 简介 | [python/app/pipeline/intro_generator.py](../../python/app/pipeline/intro_generator.py) |
| ⑤ 文本审核 | [python/app/pipeline/text_moderator.py](../../python/app/pipeline/text_moderator.py)、`callback_sender.py` |
| Prompt 管理 | [worker/admin-web/src/views/prompts.vue](../../worker/admin-web/src/views/prompts.vue)、`prompt_service.py`（IRC 现有版本化机制） |
| Token 监控 | [python/app/monitoring/token_metrics.py](../../python/app/monitoring/token_metrics.py) |
| AI 凭据 | `XAI_API_KEY` / `GEMINI_API_KEY`（由 IRC `secrets-hub` 管理，参见 IRC `CLAUDE.md` §0.4） |

### 8.2 ai-guard 关键参考（不重复全文）

- 协议：[02-api-public.md](../02-api-public.md)
- 回调契约：[04-callback-spec.md](../04-callback-spec.md)（★ 对外契约）
- 数据模型：[01-architecture.md](../01-architecture.md)
- 现有接入实例：[一起看-integration.md](一起看-integration.md)、[同趣-integration.md](同趣-integration.md)
- 优化路线（与 IRC 接入相关）：[optimization/edge-prefilter.md](../optimization/edge-prefilter.md)、[optimization/prompts-adult-platform.md](../optimization/prompts-adult-platform.md)

### 8.3 本调研未覆盖的内容

- 具体 prompt 字段映射细节（需要 P1 阶段对照 ai-guard 当前 prompt v3 文本与 IRC `text_moderation_v?` 文本逐条对齐）
- 灰度比对方案（P2 阶段会单独出文档）
- 退路设计（P3 完成后是否保留 internal backend 多长时间）

— END —
