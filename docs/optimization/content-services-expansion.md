# Content Services Expansion · 内容服务扩展规划（RFC v1.1 · APPROVED）

> 状态：**v1.1 已批准** 2026-05-20
> 提议日期：2026-05-19
> 批准日期：2026-05-19（v1.0）；v1.1 修订确认：2026-05-20（IRC 项目方 / ai-guard 平台方双方对齐）
> 驱动方：IRC 智能资源中心（`c:\code\irc\`）
> 输入素材：[apps/IRC-feasibility.md](../apps/IRC-feasibility.md)（IRC 五条 AI 链路盘点）
> 评审依据：[01-architecture.md](../01-architecture.md)、[04-callback-spec.md](../04-callback-spec.md)、[CLAUDE.md](../../CLAUDE.md) 铁律 §1
>
> **实施清单**：[content-services-implementation.md](content-services-implementation.md) · 含 T-001 至 T-009 可执行任务、Zod schema、DDL、验收标准
>
> 产出物：扶正为 `docs/12-content-service.md`（T-001），同步更新 `00-overview.md` / `02-api-public.md` 加 `/v1/analyze` 章节、新建 `13-callback-spec-analyze.md`。
>
> ---
>
> ## 决策确认（§12 评审项最终选择）
>
> | # | 议题 | 采用 |
> |---|------|------|
> | 1 | 端点设计 | ✅ **新增 `/v1/analyze`** |
> | 2 | biz_type 命名 | ✅ **`media_analysis` + `media_intro`** |
> | 3 | 第一批范围 | ✅ **两 biz_type 同期**（P2 + P3 并行设计、串行落地） |
> | 4 | 输出 schema 锚定 | ✅ **直接采用 IRC `normalize_video_ai_response`** 结构 |
> | 5 | Provider 路由默认 | ✅ **media_analysis → gemini · media_intro → xai** |
> | 6 | Prompt fragment 模型 | ✅ **P2 先单 string，P4+ 视需要切片化** |
> | 7 | callback 契约文档 | ✅ **新建 `13-callback-spec-analyze.md`**，04 不动，schema_version 升 1.1 |
> | 8 | 与审核线（IRC text_moderator）的关系 | ✅ **并行**，由 IRC 团队独立推进，不阻塞本期 |
> | 9 | `media_analysis` 视频/图片合并方式 | ✅ **方案 A 合并 superset**：单 biz_type；output 加 `description`/`score`，video 专属字段标 optional；N=1/N>1 按 prompt 引导（§4.1） |
> | 10 | 留存策略 | ✅ **moderate 短 TTL / analyze 长保留**：`analyze_requests` 同时存 `input_json` + `result_json` 不 TTL（§5.4） |
> | 11 | 交付模式 | ✅ **callback + pull 双轨**：analyze 线 app 配置 `delivery_mode ∈ {callback, pull, both}`，默认 `both`；新增 `GET /v1/analyze` / `POST .../ack` 接口（§8.2） |

---

## 0. 摘要

ai-guard 当前业务边界是 **UGC 审核**（4 个 biz_type，固定 Zod 输出 schema）。本文提议把 ai-guard 从「UGC 审核中转」演进为「AI 内容服务中转」，新增"内容生成 / 分析"业务线，第一批由 IRC 驱动落地 **`media_analysis`（图片 / 视频帧多模态分析）** 与 **`media_intro`（视频简介生成）** 两个 biz_type。

**核心主张**：
- 审核（moderate）和内容服务（analyze）是**两条平行业务线**，端点 / schema / D1 表 / Queue 各自独立。
- 底层基础设施（HMAC 鉴权、KV 去重、Provider Router、Prompt 版本管理、Queue 异步 + Callback、统计 rollup）**完全复用**，无重复建设。
- 不动 `/v1/moderate` 现有 4 biz_type 的对外契约（[04-callback-spec.md](../04-callback-spec.md) 是铁律）。
- IRC 视频帧 / 图片分析 / 简介生成三条 AI 链路 backend 切到 ai-guard；IRC 自家 `ai_client.py` 在这三条线上不再需要直连 xAI / Gemini。

---

## 1. 背景与动机

### 1.1 现状不匹配

ai-guard 现在的对外契约假设：输入是 UGC 文本 / 单张头像 URL，输出是 `status / risk_level / categories / reason` 这种判定结构。

IRC 主流 AI 调用的真实形态：

| 链路 | 输入 | 输出 |
|------|------|------|
| 视频帧分析 | 8 张帧 + 标题 + duration | moderation + tags + ad_detection + faceCoordinates + cover_candidates + trial + region + frame_notes（8 个独立结构化字段） |
| 图片单图分析 | 1 张图 | 同上的 single-image 退化版 + OCR / face 子字段 |
| 视频简介生成 | 标题 + tags + frame_notes + OCR + 字幕 | ai_intro（+ 可选 title 建议） |
| 小说分析 | 整本采样章节 | ai_title + ai_intro + ai_categories（暂不入选） |

→ **判定（moderate）和内容服务（analyze）输出契约根本不同**。强套同一 schema 会把审核契约毁掉，也无法承载内容服务的真实输出。

### 1.2 重复建设浪费

IRC 自己已实现一个迷你 AI 网关（`ai_client.py` + `prompt_service` + `token_metrics` + `vrc_apps + callback_sender` + 双 provider fallback），与 ai-guard 的核心能力 ~80% 重叠。让 IRC 把这一层 backend 委托给 ai-guard，可以：

- 减少 xAI / Gemini key 散落点（统一在 ai-guard `wrangler secret`）
- 减少 prompt 维护重复（IRC `vrc_prompts` 内容服务部分 → 全切到 ai-guard `prompts`）
- 复用 ai-guard 已有的 KV 去重缓存（相同输入命中秒级返回，省 token）
- 复用熔断 / 告警 / 统计 rollup 基础设施

### 1.3 与铁律的兼容性

[CLAUDE.md](../../CLAUDE.md) §1 铁律："回调 JSON schema 是对外契约。新增字段必须向后兼容；不得删字段或改字段含义"。

本提议**不破坏铁律**：现有 `/v1/moderate` 4 biz_type 的输出 schema 一字不改；新增 `/v1/analyze` 端点 + 新 biz_type 命名空间 + 新 callback 契约文档（独立向后兼容）。

---

## 2. 范围与边界

### 2.1 第一批入选

| biz_type | 替代 IRC 模块 | 形态 |
|----------|---------------|------|
| `media_analysis` | `ai_analyzer.py`（视频帧）+ `image_analyzer.py` 中"AI 部分"（OCR / face 仍在 IRC 端） | 多模态：1..16 张图 + 上下文 → 大结构化 JSON |
| `media_intro` | `intro_generator.py` | 文本：结构化输入 → 简介字符串 |

→ 用户提议"图片分析合并到视频帧"完全成立——它们只是 N=1 与 N>1 的关系，同一 biz_type 涵盖。

### 2.2 暂不入选

- **小说分析**（IRC `novel_analyzer.py`）—— IRC 当前不急；schema 已稳定，未来可加 `novel_analyze` biz_type
- **文本审核**（IRC `text_moderator.py`）—— 走原 `/v1/moderate`，作为 [IRC-feasibility.md](../apps/IRC-feasibility.md) §4.1 的"审核线 P1"独立推进
- **通用 LLM 中转**（chat / instruct）—— 偏离平台定位，不做
- **IRC 视觉特征模型**（DINOv2 embedding、InsightFace、PaddleOCR、faster-whisper）—— 物理服务器本地能力，不进云中转

### 2.3 与现有 4 biz_type 关系

| 现有 biz_type | 归属 | 是否变更 |
|---------------|------|----------|
| `comment` / `nickname` / `bio` / `avatar` | moderate 线 | 不变 |
| `media_analysis` / `media_intro` | analyze 线（新增） | 新增 |

---

## 3. 端点与契约设计

### 3.1 推荐方案 · 新端点 `/v1/analyze`

与 `/v1/moderate` 平级，鉴权 / 限流 / 响应模式 / `extra` 透传 **完全复用**。

```http
POST /v1/analyze
Headers: X-App-Id / X-Timestamp / X-Nonce / X-Signature  ← 同 /v1/moderate
Body:
{
  "biz_type": "media_analysis",          // 或 "media_intro"
  "biz_id":   "video-12345",
  "input":    { ... 按 biz_type 各自 schema ... },
  "mode":     "async",                   // media_analysis 强制 async；media_intro 默认 auto
  "callback_url": "https://...",
  "user_id":  "u_88991",                 // 可选
  "extra":    { ... }
}
→ 202 + { request_id, accepted_at }（async / auto 降级时）
  或 200 + { request_id, cached, result }（sync / 命中缓存时）
```

输入字段从 `content: string` 改为 `input: object`——这是 analyze 线相对 moderate 线最显著的差异（结构化输入 vs 纯字符串）。

### 3.2 备选方案 · 扩展 `/v1/moderate`（不推荐）

让 `/v1/moderate` 接受 `biz_type=media_analysis`，根据 biz_type 返回不同 schema。
- ✗ 违反"固定回调契约"铁律的精神（即使技术上"枚举值新增"是兼容的，业务语义混淆）
- ✗ moderate / analyze 命名空间合一，未来 SDK / 监控 / 限流策略难分线
- ✗ 现有审核接入方（一起看 / 同趣）认知成本

### 3.3 备选方案 · 子路径 `/v1/content/*`（不推荐）

`/v1/content/analyze` / `/v1/content/intro` 各一条。
- ✗ 端点数膨胀，每加一个 biz_type 一个新路径
- 推荐方案的"单端点 + biz_type 区分"在现有架构上一致性更好

---

## 4. 各 biz_type 输入 / 输出 schema 草案

> 输出 schema **直接采用 IRC 已成熟的 `normalize_*` 结果结构**作为锚定，避免重新设计；IRC 端切换 backend 时无适配成本。

### 4.1 `media_analysis`

**Input**：

```ts
{
  image_urls:     string[],            // 必填，1..16 张 https:// URL
  title?:         string,              // 资源标题 hint
  duration_seconds?: number,           // 视频时长；仅视频时填
  frame_metadata?: {                   // 与 image_urls 一一对应（按下标）
    timestamp_seconds: number,         // 帧对应原视频时间点
    quality_score: number,             // 0..1
    scene_id?:    number,
  }[],
  region_hint?:   string,              // 上层已有的地区猜测，可选
}
```

**Output**（callback `result` 字段下；锚定 IRC `normalize_video_ai_response` + `normalize_image_analysis_response` 的 **superset**）：

> **N=1 vs N>1 字段规则**（prompt 内引导模型按图数量决定填哪些）：
> - **始终填**：`moderation` / `tags` / `ad_detection` / `region` / `face_coordinates`
> - **N=1（单图）专属**：`description`（可见描述）/ `score`（图本身可用度评分 0–100）+ `scoring_breakdown`
> - **N>1（视频帧）专属**：`cover_candidates`（top 5 选封面）/ `trial`（试看片段）/ `frame_notes`（逐帧摘要）
> - 不适用的字段 **省略**（不是 null、不是空数组），消费方按 optional 解析

```ts
{
  moderation: {
    decision:    "approve" | "reject" | "review",
    confidence:  number,
    summary:     string,
    violations:  {
      category:  string,
      detected:  boolean,
      confidence: number,
      evidence:  string,
      frame_index?: number,            // N=1 时省略
      timestamp_seconds?: number,      // N=1 时省略
    }[],
  },
  tags: {
    tag_names:        string[],
    extra_tag_names:  string[],
    categories:       { meta: {}, appearance: {}, context: {}, production: {} },
    summary:          string,
    status:           "ready" | "pending",
  },
  ad_detection: {
    is_ad:       boolean,
    categories:  string[],
    elements:    string[],
    contacts:    string[],
    urls:        string[],
    reason:      string,
  },
  face_coordinates: {
    frame_index?: number,              // N=1 时省略
    timestamp_seconds?: number,        // N=1 时省略
    box:         { x: number, y: number, width: number, height: number },
    orientation: string,
    confidence:  number,
  }[],
  region: {
    code:           string,            // japan/china/taiwan/.../other
    requested_code: string,
    confidence:     number,
    reasoning:      string,
    signals:        Record<string, unknown>,
  },

  // ── N=1 单图专属 ────────────────────────────────────
  description?: string,                // 单图可见描述
  score?: number,                      // 0..100，图本身可用度评分
  scoring_breakdown?: Record<string, number>,

  // ── N>1 视频帧专属 ──────────────────────────────────
  cover_candidates?: {                 // top 5，按 score 降序
    frame_index:       number,
    timestamp_seconds: number,
    score:             number,         // 0..100
    scoring_breakdown: Record<string, number>,
    reason:            string,
    is_recommended:    boolean,
  }[],
  trial?: {
    trial_start_seconds: number,
    trial_end_seconds:   number,
    trial_score:         number,
    reason:              string,
    status:              "ready" | "pending",
  },
  frame_notes?: {
    frame_index:       number,
    timestamp_seconds: number,
    summary:           string,
  }[],
}
```

### 4.2 `media_intro`

**Input**：

```ts
{
  title:             string,
  duration_seconds?: number,
  tags?:             string[],
  frame_notes?:      { timestamp_seconds: number, summary: string }[],
  ocr_lines?:        string[],
  subtitle_text?:    string,
  trial_excerpt?:    string,
  style_hint?:       "concise" | "narrative" | "marketing",
  max_length?:       number,           // 字符上限 hint（不硬截）
}
```

**Output**：

```ts
{
  intro:               string,         // 必有
  title_suggestions?:  string[],       // 可选，2-3 个备选标题
  beats?:              { timestamp_seconds: number, summary: string }[],
}
```

### 4.3 未来 biz_type 占位

| 候选 biz_type | 场景 | 时间窗 |
|---------------|------|--------|
| `novel_analyze` | 整本采样章节 → title + intro + categories | IRC 启用后 |
| `image_caption` | 单图 → 短描述（轻量版 media_analysis） | 需求未到 |
| `text_describe` | 长文本 → 简介风格改写 | 需求未到 |

---

## 5. 数据模型扩展

### 5.1 D1 表

**`apps` 表**：

```sql
ALTER TABLE apps ADD COLUMN analyze_biz_types         TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN delivery_mode             TEXT    NOT NULL DEFAULT 'both';
   -- 'callback' | 'pull' | 'both'，仅作用于 analyze 系（moderate 系沿用 callback）
ALTER TABLE apps ADD COLUMN callback_max_concurrency  INTEGER NOT NULL DEFAULT 10;
   -- ai-guard 对该 app 投递 callback 的最大并发，避免反向打爆消费方
```

**`prompts` 表**：现有 `(biz_type, provider, version)` 复合唯一足够，沿用。biz_type 值域扩到 `media_analysis` / `media_intro` 即可。

**新表 `analyze_requests`**（与 `moderation_requests` 分开）：

```sql
CREATE TABLE analyze_requests (
  id               TEXT PRIMARY KEY,         -- UUIDv7
  app_id           TEXT NOT NULL,
  biz_type         TEXT NOT NULL,
  biz_id           TEXT NOT NULL,
  user_id          TEXT,
  input_hash       TEXT NOT NULL,            -- canonicalized input json sha256
  input_json       TEXT NOT NULL,            -- 完整规整化 input（长保留，见 §5.4）
  prompt_version   INTEGER,
  provider         TEXT,
  model            TEXT,
  mode             TEXT NOT NULL,
  cached           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,            -- pending | ok | error
  result_json      TEXT,                     -- 完整 result（可能 10KB+）
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  error_code       TEXT,
  delivery_mode    TEXT,                     -- 'callback' | 'pull' | 'both'，请求级覆盖
  delivered_at     INTEGER,                  -- callback 成功投递时间（pull 模式不写）
  acked_at         INTEGER,                  -- pull 模式 IRC 显式 ack 时间
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_analyze_app_time   ON analyze_requests(app_id, created_at);
CREATE INDEX idx_analyze_hash       ON analyze_requests(input_hash, biz_type);
CREATE INDEX idx_analyze_app_pull   ON analyze_requests(app_id, status, acked_at, id);
   -- 加速 GET /v1/analyze?app_id=...&status=ok&since_id=... 的 cursor 拉取
```

**理由**：
- 保留 `input_json` 与 `result_json` 对称，支持复跑 / 对账 / 调试；analyze 线**长保留不 TTL**（见 §5.4）。
- `delivered_at` / `acked_at` 分别跟踪 callback 投递与 pull 确认；查询"未交付"= `delivered_at IS NULL AND acked_at IS NULL`。
- 独立表便于按业务线监控存储成本与查询路径，不污染 moderation_requests。

**`callback_deliveries` 表**：复用（按 request_id 区分两条线）。

**`stats_rollup` 表**：扩列 `output_bytes_total INTEGER NOT NULL DEFAULT 0`，便于看 analyze 线的存储增长。

### 5.2 KV Namespaces

| Namespace | 变更 | 说明 |
|-----------|------|------|
| `DEDUP_CACHE` | key 改为 `{biz_type}:{prompt_version}:{input_hash}` | 输入为 object 时按 stable JSON canonicalize（键排序 + UTF-8）后 sha256 |
| `PROMPTS` | 复用 | biz_type 值域扩展 |
| `APPS` | value JSON 多带 `analyze_biz_types[]` | 缓存可读 |

### 5.3 Queues

新增 `ANALYZE_QUEUE`，与 `MODERATION_QUEUE` 并列。

**理由**：analyze 单次任务时延高（多模态 + 多图，普遍 5–30s），如与 moderate 短任务混队，会拖慢 moderate callback 优先级；DLQ 隔离便于排障。

回调投递走现有 `CALLBACK_QUEUE`（不区分业务线，按 request_id 派发）。

### 5.4 留存策略：moderate vs analyze

两条业务线的数据性质完全不同，留存策略**显式分离**。

| 维度 | moderate 线 | analyze 线 |
|------|-------------|-----------|
| 输入性质 | 终端用户 UGC（评论 / 昵称 / 简介 / 头像 URL），合规敏感 | 资源元数据（image_urls / title / OCR / 字幕），非用户隐私 |
| 输入留存 | `moderation_requests` 不存 raw content，仅 `content_hash` | `analyze_requests.input_json` **完整长保留** |
| 结果留存 | KV `DEDUP_CACHE` 7d TTL；D1 行按现有 TTL 清理 | `analyze_requests.result_json` **完整长保留**（不 TTL） |
| 历史复跑 | 不支持（已无原文） | 支持（input_json 可复跑、对账、A/B 比对新 prompt） |
| 合规依据 | [00-overview.md](../00-overview.md) "非目标"节：不长期留存用户原始数据 | 资源元数据无 GDPR 类风险；IRC 业务需要历史追溯 |

**实施约束**：
- `moderation_requests` 表结构不动（沿用 7d TTL）
- `analyze_requests.input_json` / `result_json` 不参与任何自动清理 cron
- 如未来需要按 app 单独配置 analyze 留存策略，加 `apps.analyze_retention_days` 列（默认 0=永久）
- Admin UI 提供「按 biz_id / 时间 / app 检索 analyze 调用记录」入口（T-006 实施）

详细对外说明见 [docs/14-analyze-records.md](../14-analyze-records.md)。

---

## 6. Prompt 管理策略

IRC 当前 prompt 是 **多片段拼接** 产生的：

```
[adult_gay_platform_policy] + [compact_region_rules] + [compact_video_response_contract] + [video info + frames]
```

ai-guard 当前 `prompts.content` 是单 string。

**P2 阶段方案（最简）**：直接把 IRC 的 `prompt_fragments` 模块迁到 ai-guard worker 内部（`src/moderation/prompt-fragments.ts` 或新建 `src/analyze/prompt-fragments.ts`），`prompts.content` 字段存最终拼好的字符串。Admin UI 编辑时编辑成品 prompt。

**P4+ 演进**：如果 fragment 复用需求强（region rules / response contract 多 biz_type 共享），可加 `prompt_fragments` 表 + 占位符替换（`{{fragment_name}}`）。初期不做。

---

## 7. Provider 路由

```
biz_type        主 provider   备 provider   理由
─────────────────────────────────────────────────────────
media_analysis  gemini        xai           Gemini Vision + responseSchema 稳；xai 兜底
media_intro     xai           gemini        Grok 文本快且便宜
```

per-app `provider_strategy` 覆盖逻辑不变（沿用现有 `apps.provider_strategy`）。

**熔断**：现有 60s 窗口内 5 次失败熔断 30s 的策略，按 `(provider, biz_type)` 而非全局，确保 analyze 故障不连累 moderate（反之亦然）。

---

## 8. 响应模式

### 8.1 同步 vs 异步

| biz_type | 默认 mode | 强制 mode |
|----------|-----------|-----------|
| `media_analysis` | async | 不允许 sync（强制 async / auto 降级） |
| `media_intro` | auto | sync 允许（< 10s 概率高） |

callback envelope 沿用 [04-callback-spec.md](../04-callback-spec.md) 的字段集，增加 `result: object`（schema 由 biz_type 决定）；同时新增 `13-callback-spec-analyze.md` 单独描述 analyze 系 `status` 取值与 result schema。

**`schema_version` 升级到 `1.1`**：保持向后兼容（不删字段、不改含义），加：
- analyze 系 status 取值 `ok | error`（与 moderate 系的 `pass / reject / review / error` 不重叠）
- `result: object`（仅 analyze 系出现）

> moderate 系应用收到 `schema_version=1.1` 不应崩溃——因新增字段在 moderate 回调中不出现。

### 8.2 交付模式：callback + pull 双轨

IRC 类批处理场景（高吞吐、容忍秒级到分钟级延迟、可能没有公网 callback endpoint）需要"轮询拉取"作为兜底/主路径。analyze 线**同时提供 callback 与 pull**，由 app 配置选择 `callback / pull / both`。moderate 线不变（仅 callback）。

| 维度 | callback（push） | pull（轮询拉取） |
|------|------------------|-------------------|
| 实时性 | 数百毫秒 | 取决于轮询周期（建议 30s–60s） |
| 消费方依赖 | 必须公网 HTTPS endpoint | 无（仅出向 HTTPS） |
| 投递保证 | at-least-once + 指数退避 | 显式 ack，断点续拉 |
| 适用场景 | 实时审核（一起看 / 同趣）、IRC 在线请求 | IRC 历史回填、内网部署、callback 投递不稳时兜底 |
| 默认值 | moderate 线 only | analyze 线默认 `both`，IRC 可关 callback 只走 pull |

**新接口契约**：

```
GET  /v1/analyze/{request_id}
    单次查询（与 moderate 线现有 GET /v1/moderate/{request_id} 形态一致）
    Headers: 同 POST /v1/analyze（HMAC 签空 body）
    Response 200:
      { request_id, status, result?, provider?, model?, cached?, tokens?, latency_ms?, created_at?, completed_at? }
    Response 404: 不存在或不属于该 app

GET  /v1/analyze
    批量 cursor 拉取
    Query:
      status:    "ok" | "error"           （必填）
      biz_type?: "media_analysis" | "media_intro"
      since_id?: UUIDv7                    （上次拉取的最大 id，断点续拉）
      include:   "unacked" | "all"         （默认 unacked，只拉未 ack 的）
      limit:     1..100                    （默认 50）
    Headers: HMAC 签空 body
    Response 200:
      {
        items: [{ request_id, biz_type, biz_id, status, result?, ..., created_at, completed_at }],
        next_since_id: UUIDv7 | null      // null 表示无更多
      }

POST /v1/analyze/{request_id}/ack
    pull 模式显式确认已消费；幂等
    Headers: HMAC 签空 body
    Response 200: { request_id, acked_at }
    Response 404: 不存在或不属于该 app
    Response 409: 该 request_id delivery_mode='callback' 不允许 ack（仅 callback 模式的请求无需 ack）
```

**关键约束**：
- `since_id` 用 UUIDv7 时间序，IRC 端只需存最大已处理 id（`max_processed_id`）即可断点续拉
- 同一 request 收到 callback 后 IRC 应**也 ack**（如果 app 配 `delivery_mode=both`），避免下次 pull 重复拿到
- 服务端 ack 幂等：重复 ack 同一 id 返 200，`acked_at` 不刷新
- pull 不传播 `acked_at IS NULL AND delivery_mode IN ('pull', 'both')` 的过滤条件（默认 include=unacked）

**callback 限速**：
- `apps.callback_max_concurrency`（默认 10）控制 ai-guard 对该 app 同时投递的 callback 并发
- 超额 callback 在 `CALLBACK_QUEUE` 中排队（不丢失），自然背压

**IRC 推荐用法**（仅设计澄清，IRC 端实施细节见 [docs/14-analyze-records.md](../14-analyze-records.md)）：
- 在线场景（采集端实时入库）：`delivery_mode=both`，callback 主，cron 每分钟兜底 pull
- 批量回填（T-015 类）：可 `delivery_mode=pull`，IRC 自己控速消费，避免高并发 callback 反向冲击
- IRC 重启场景：所有未 ack 的 pull 一遍即可恢复

---

## 9. IRC 现状 → 新方案迁移映射

| IRC 现状 | 新方案 |
|----------|--------|
| `ai_client.analyze_video_frames`（视频 + 图片） | `POST /v1/analyze` biz_type=`media_analysis` |
| `ai_client.generate_text_json`（简介生成） | `POST /v1/analyze` biz_type=`media_intro` |
| `ai_client.generate_text_json`（文本审核） | `POST /v1/moderate` biz_type=`comment`/`bio`/`nickname`（独立线，沿用 [IRC-feasibility.md](../apps/IRC-feasibility.md) §4.1） |
| `ai_client.generate_text_json`（小说分析） | **暂不迁移**，IRC 自留 xAI / Gemini key |
| IRC `prompt_service` + `vrc_prompts` 表中 `video_analysis_*` / `image_analysis_*` / `intro_*` 条目 | 迁移到 ai-guard `prompts` 表 |
| IRC `token_metrics` 表中 text + media 部分 | 迁移到 ai-guard `stats_rollup`；IRC 仅保留小说线 |
| IRC `image_analyzer.py` 中的 OCR / 人脸 / 地区分类 | 不动（依赖物理服务器本地模型） |
| IRC pipeline 编排（frame_sampler / cover_scoring / trial_extractor 等） | 不动 |

→ IRC 上的改动量：
- `ai_client.py` 新增一个 `AiGuardClient` 适配层，feature flag 控制走旧还是新
- `ai_analyzer.py` / `image_analyzer.py` / `intro_generator.py` 三处调用 backend 切换
- 小说线、文本审核线在本期不动

---

## 10. 风险与边界

| 风险 | 说明 | 缓解 |
|------|------|------|
| 平台定位漂移 | 「成人男同社交 APP 审核」→「同时覆盖资源中心内容生成」，可能引起接入方认知混乱 | README + 00-overview 明确"双轨：moderate / analyze"；moderate 线对外定位与铁律不变 |
| CF Worker subrequest 限额 | 每请求 50 subrequest 上限；16 图 fetch 占 16 个 | 当前 IRC 上限 8 张帧，不触顶；上限设 16 留余量；超量考虑 R2 代理 |
| CF Worker CPU / 内存限额 | Worker 单次 CPU time 50ms（unbound 30s）；多图 base64 拼装吃内存 | analyze 一律走 Queue handler（Queue 消费者 CPU 限额更宽松）；图片不在 Worker 内 base64，直接传 image_url 给 Gemini（Gemini API 支持 url 拉取） |
| 多模态 token 成本 | 每张图 ~500 token；8 张图 + 复杂 schema 单次 ~5000 input tokens | KV 去重严格按 `(biz_type, prompt_version, input_hash)`；input_hash 含 image_urls 的字节 sha256 而非 URL 字符串（避免 CDN 缓存破坏命中） |
| schema 演进窗口 | analyze 系 schema 初期可能频繁调整 | sphema_version 字段 + 至少向后兼容 6 个月（沿用 moderate 契约纪律） |
| Provider key 单点 | analyze 与 moderate 共用同一 GROK_API_KEY / GEMINI_API_KEY，鉴权失败会同时挂 | 长期：每业务线独立 key 池；短期：现有 `provider_auth_failed` 告警链路足够 |
| IRC pipeline 同步性变化 | IRC 当前 `ai_analyzer` 是 pipeline 内同步调用；切到 ai-guard async 后变成"发请求 → 等 callback" | IRC 端需要状态机改造：发完请求把 task 标 `waiting_ai`，callback 收到后继续 pipeline；改造工作量在 IRC 侧 P2 阶段 |

---

## 11. 阶段化路线

| 阶段 | 内容 | 工时（粗估） |
|------|------|--------------|
| **P0** | RFC 评审 + schema v0.1 → v1.0 定稿 | 2 d |
| **P1** | ai-guard 基础设施：`analyze_requests` 表 / `ANALYZE_QUEUE` / `/v1/analyze` 路由壳（返 501 not_implemented）+ `/v1/analyze/{id}` / `GET /v1/analyze` / `POST .../ack` 三个 pull 接口 | 2.5 d |
| **P2a** | `media_analysis` 接 Gemini（默认）+ Zod schema + KV 去重 + Queue + callback | 3 d |
| **P2b** | `media_analysis` 接 xAI（备）+ provider router + 熔断 | 1 d |
| **P3** | `media_intro` 接入（xAI 主）+ Zod schema | 2 d |
| **P4** | Admin UI：apps 编辑加 `analyze_biz_types` / `delivery_mode` / `callback_max_concurrency`；prompts 列表分类；stats 加 analyze 视图；**新增 analyze 调用记录视图**（按 biz_id / 时间 / app 检索 + 看完整 input/result） | 2.5 d |
| **P5** | IRC 端 `AiGuardClient` 适配 + feature flag + 三处调用切换 | 2 d |
| **P6** | 灰度 1 周（IRC 端按资源类型 / 比例切换），对比 result 一致性、延迟、成本 | 1 周 |
| **P7** | 全量切换 + IRC `vrc_prompts` 中 media 系 prompt 归档；IRC `XAI/GEMINI_API_KEY` 在三条线上下线（小说线保留） | 0.5 d |

**MVP（P0–P7）总计**：~3 工作周 + 1 灰度周（含 pull 接口与调用记录视图）。

并行可选：**审核线**（[IRC-feasibility.md](../apps/IRC-feasibility.md) §4.1 / §5）由不同人推进，互不阻塞。

---

## 12. 评审 / 决策点（请确认）

| # | 议题 | 推荐 | 备选 |
|---|------|------|------|
| 1 | 端点设计 | 新增 `/v1/analyze`（§3.1） | 扩展 `/v1/moderate`（§3.2） / `/v1/content/*`（§3.3） |
| 2 | biz_type 命名 | `media_analysis` + `media_intro` | `image_analyze` + `video_intro` / `content_analyze` + `content_intro` |
| 3 | 第一批范围 | `media_analysis` + `media_intro` 双 biz_type 同期 | 仅 `media_analysis` 先验证再加 |
| 4 | 输出 schema 锚定 | 直接采用 IRC `normalize_video_ai_response` 结构 | 从 0 重新设计 |
| 5 | Provider 路由默认 | media_analysis→gemini / media_intro→xai | 反过来 / 一律 auto |
| 6 | Prompt fragment 模型 | P2 先单 string，P4+ 再切片化 | 一上来就切片化 |
| 7 | callback 契约文档 | 新建 `13-callback-spec-analyze.md`，`04-callback-spec.md` 不动；`schema_version` 升 1.1 | 把 04 拆成 `04-callback-moderate.md` + `04-callback-analyze.md`（破坏现有链接） |
| 8 | 审核线（IRC-feasibility §4.1）与本期是否并行 | 并行（不同人推进） | 串行（本期先做完） |
| 9 | `media_analysis` 视频/图片合并方式 | A 合 superset，video 专属字段 optional | B 拆 biz_type / C polymorphic |
| 10 | 留存策略 | moderate 短 TTL / analyze 长保留 `input_json`+`result_json` | 全部短 TTL / 全部长保留 |
| 11 | 交付模式 | callback + pull 双轨，默认 `both` | 仅 callback / 仅 pull |

---

## 13. 不在本次规划内

- [Batch API](batch-api.md)（独立优化项）
- [Edge Prefilter](edge-prefilter.md)（独立优化项）
- [Physical Server](physical-server.md)（独立优化项）
- [CSAM Plan A](csam-plan-a.md) / [CSAM Scan](csam-scan-setup.md)
- 通用 chat / instruct 中转
- IRC 小说分析 / 人脸识别 / 向量检索 / OCR / ASR / faster-whisper —— 由 IRC 内部继续承担
- IRC 上游业务方（同趣 / 一起看 / 采集软件）的 callback 协议统一（短期不动）

---

## 14. 附录

### 14.1 锚定参考（IRC 现有代码 / 文档）

- 视频帧 normalize：[`python/app/pipeline/ai_analyzer.py`](../../../irc/python/app/pipeline/ai_analyzer.py) `normalize_video_ai_response` 及之后所有 `normalize_*` 函数
- 简介生成：[`python/app/pipeline/intro_generator.py`](../../../irc/python/app/pipeline/intro_generator.py)
- AI client 抽象：[`python/app/services/ai_client.py`](../../../irc/python/app/services/ai_client.py)
- Prompt 服务：`python/app/services/prompt_service.py`
- IRC AI 链路全景：[apps/IRC-feasibility.md](../apps/IRC-feasibility.md) §2 / §8.1

### 14.2 ai-guard 现有参考

- [00-overview.md](../00-overview.md) / [01-architecture.md](../01-architecture.md)
- [02-api-public.md](../02-api-public.md) / [04-callback-spec.md](../04-callback-spec.md)
- [05-prompts.md](../05-prompts.md) / [06-stats.md](../06-stats.md)
- [.claude/skills/add-biz-type/](../../.claude/skills/add-biz-type/) ← 本规划落地时复用此 skill 流程

— END v1.1 —
（v1.0 → v1.1 修订：方案 A schema 合并 / 长保留 input_json / callback+pull 双轨；2026-05-20）
