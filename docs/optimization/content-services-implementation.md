# Content Services Expansion · 实施任务清单 v1.0

> 上游 RFC：[content-services-expansion.md](content-services-expansion.md) v1.1 · APPROVED 2026-05-20
> 实施前必读：上游 RFC §3–§9 + 本文件 §0「工作规则」
> 任务编号体系：T-001 ~ T-009，对应 RFC §11 的 P0 ~ P7
>
> **当前进度**：全部 TODO

---

## 0. 工作规则（开始动手前必读）

1. **任务粒度**：每个 T-XXX 完成开一个 PR，PR 描述引用任务编号，逐项勾选验收清单
2. **质量门禁**（每个 PR 都跑）：
   - `pnpm -s typecheck && pnpm -s test`
   - dev 环境冒烟：`pnpm dev` 起本地 wrangler，关键接口 curl 通
   - 涉及 D1：`wrangler d1 execute --local` 跑 migration 不报错
3. **不可破坏的契约**：
   - **`/v1/moderate` 4 个 biz_type 的 Request / Response / Callback 字段集一字不改**（[CLAUDE.md](../../CLAUDE.md) 铁律 §1）
   - 已发布的 `migrations/0001_*` ~ `0005_*` 不得修改（只追加新文件）
   - 现有 4 biz_type 的回归测试 100% 保留
4. **schema_version 升 1.1**：
   - moderate 系回调字段集完全不变（新 schema_version 不引入新字段到 moderate 回调）
   - analyze 系回调在 envelope 末尾追加 `result: object`
   - moderate 接入方升到 1.1 不应崩溃
5. **设计模糊点**：先翻 RFC §3–§9，仍模糊就开 ADR / 找用户对齐；**不要即兴决定影响契约的细节**
6. **现有 skill 协同**：
   - 新增 biz_type 走 `.claude/skills/add-biz-type/SKILL.md`（T-001 阶段会更新该 skill 的双轨说明）
   - 调 prompt 走 `.claude/skills/tune-prompt/SKILL.md`（不变）
   - 部署走 `.claude/skills/deploy-worker/SKILL.md`（**先 dev 再 prod**）
7. **破坏性操作需人工确认**（沿用 CLAUDE.md §7）：D1 drop / KV key delete / 任何 `rm -rf`

---

## 1. 任务总览

| 任务 | RFC 阶段 | 标题 | 工时 | 依赖 | 状态 |
|------|----------|------|------|------|------|
| **T-001** | P0 | 文档转正 + 契约定稿 | 2d | — | TODO |
| **T-002** | P1 | 基础设施：D1 + Queue + `/v1/analyze` 路由壳 | 2d | T-001 | TODO |
| **T-003** | P2a | `media_analysis` · Gemini 主路径 | 3d | T-002 | TODO |
| **T-004** | P2b | `media_analysis` · xAI 备路径 + 熔断 | 1d | T-003 | TODO |
| **T-005** | P3 | `media_intro` 实现 | 2d | T-002 | TODO |
| **T-006** | P4 | Admin UI 双轨化 | 2d | T-003、T-005 | TODO |
| **T-007** | P5 | IRC 端适配（外部）| 2d | T-003、T-005 | EXT |
| **T-008** | P6 | 灰度 1 周 | 1w | T-007 | TODO |
| **T-009** | P7 | 全量切换 + 收尾 | 0.5d | T-008 | TODO |

ai-guard 仓库内任务工时合计：**约 12.5 工作日**（不含 T-007 IRC 外部 + T-008 灰度等待）。

---

## T-001 · P0 文档转正 + 契约定稿

### 范围
把 RFC content-services-expansion.md 的内容**拆分**为正式文档，与现有 0X 编号体系融合。

### 文件清单

| 操作 | 文件 | 内容 |
|------|------|------|
| 新建 | `docs/12-content-service.md` | 总览 + 业务定位 + 与 moderate 线的关系。从 RFC §1 / §2 / §9 提炼 |
| 新建 | `docs/13-callback-spec-analyze.md` | analyze 系 callback 契约：envelope 字段集（沿用 04 + 加 `result: object`）、`status ∈ {ok, error}`、各 biz_type 的 result schema 链接、`schema_version=1.1` 兼容承诺 |
| 新建 | `docs/14-analyze-records.md` | analyze 线对外说明：留存策略 / pull 接口契约 / IRC 推荐用法 / 三接口端到端示例。直接 copy RFC §5.4 + §8.2 内容扩写 |
| 修改 | `docs/02-api-public.md` | 末尾加 §「`POST /v1/analyze` — 提交内容服务任务」，结构对齐 §「`POST /v1/moderate`」 |
| 修改 | `docs/00-overview.md` | "支持的业务类型" 表加 `media_analysis` / `media_intro` 行；新增 §「双轨：moderate + analyze」简介 |
| 修改 | `README.md` | "支持的业务类型" 同步双轨；"在线访问"节加 `/v1/analyze` |
| 修改 | `docs/01-architecture.md` | 总体架构 ASCII 图加 `ANALYZE_QUEUE` 与 `analyze_requests` 表 |
| 修改 | `.claude/skills/add-biz-type/SKILL.md` | 显式区分"moderate 系 biz_type"和"analyze 系 biz_type"两条分支，明确各自需要改哪些文件 |
| **不动** | `docs/04-callback-spec.md` | 铁律保护，moderate 系契约完全不变 |
| **不动** | `migrations/0001_*` ~ `0005_*` | 已发布 migration 不改 |

### 验收清单
- [ ] `pnpm -s typecheck` 通过（文档型改动通常不影响，但要确认无 import 断链）
- [ ] 新文档相互引用不缺链；执行 `grep -rE '\]\([^)]+\)' docs/12-* docs/13-*` 抽查
- [ ] `docs/04-callback-spec.md` `git diff` 应为 0 字节变化
- [ ] `README.md` 在线访问节包含 `/v1/analyze` 路径（即使后端是 501）
- [ ] `.claude/skills/add-biz-type/SKILL.md` 末尾增加 "Choose track" 决策树

---

## T-002 · P1 基础设施

### 范围
铺好 analyze 线的"管道工程"：D1 表、Queue 绑定、`/v1/analyze` 路由壳（返 501 + 完整链路打通）。

### 文件清单

| 操作 | 文件 | 关键内容 |
|------|------|----------|
| 新建 | `migrations/0006_analyze_requests.sql` | 见下「DDL」（含 input_json / delivered_at / acked_at / delivery_mode 字段） |
| 新建 | `migrations/0007_apps_add_analyze_columns.sql` | `apps` 表加 `analyze_biz_types` + `delivery_mode`（默认 `'both'`）+ `callback_max_concurrency`（默认 10） |
| 新建 | `migrations/0008_stats_rollup_add_output_bytes.sql` | `ALTER TABLE stats_rollup ADD COLUMN output_bytes_total INTEGER NOT NULL DEFAULT 0` |
| 修改 | `wrangler.toml` | 加 `[[queues.producers]]`（binding=`ANALYZE_QUEUE`, queue=`ai-guard-analyze`）+ `[[queues.consumers]]` |
| 修改 | `src/env.d.ts` | `ANALYZE_QUEUE: Queue<AnalyzeJob>` |
| 新建 | `src/analyze/types.ts` | `AnalyzeJob` / `AnalyzeRequest` / `AnalyzeStatus` / `DeliveryMode` 等类型 |
| 新建 | `src/analyze/schema/envelope.ts` | analyze 通用 Input envelope（biz_type / biz_id / input / mode / callback_url / user_id / extra）的 Zod |
| 新建 | `src/routes/analyze.ts` | `POST /v1/analyze` 路由：HMAC（复用）→ rate-limit（复用）→ Zod parse envelope → 落 `analyze_requests` pending（含 input_json）→ 入 `ANALYZE_QUEUE` → 返 202 |
| 新建 | `src/routes/analyze-records.ts` | **pull 接口三件套**：`GET /v1/analyze/{id}` 单查 / `GET /v1/analyze` cursor 列表 / `POST /v1/analyze/{id}/ack` 确认。详细契约 RFC §8.2 + docs/14 |
| 新建 | `src/analyze/pipeline/dispatcher.ts` | `ANALYZE_QUEUE` consumer：按 `biz_type` 派发；本期所有 biz_type 暂走 stub → 标 `error_code=not_implemented` + 按 `delivery_mode` 决定是否入 `CALLBACK_QUEUE` |
| 新建 | `src/db/analyze-requests.ts` | analyze_requests CRUD（insert pending / update result / 按 since_id cursor 查询 unacked / ack 更新 acked_at） |
| 修改 | `src/index.ts` | 注册 analyze 路由（POST + GET 三件套） + queue handler 分支 |
| 修改 | `src/callback/dispatcher.ts` | callback envelope 加 `schema_version=1.1` 切换；按 `delivery_mode ∈ {callback, both}` 决定是否投递；投递成功写 `delivered_at`；尊重 `callback_max_concurrency` |

### DDL · `migrations/0006_analyze_requests.sql`

```sql
-- 内容服务请求表（与 moderation_requests 分离）
-- 留存策略：input_json 与 result_json 长保留，不参与 TTL（见 RFC §5.4）
CREATE TABLE analyze_requests (
  id               TEXT PRIMARY KEY,         -- UUIDv7
  app_id           TEXT NOT NULL,
  biz_type         TEXT NOT NULL,            -- media_analysis | media_intro | ...
  biz_id           TEXT NOT NULL,
  user_id          TEXT,
  input_hash       TEXT NOT NULL,            -- canonical JSON sha256
  input_json       TEXT NOT NULL,            -- 完整规整化 input（长保留）
  prompt_version   INTEGER,
  provider         TEXT,
  model            TEXT,
  mode             TEXT NOT NULL,            -- sync|async|auto-downgraded
  cached           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,            -- pending|ok|error
  result_json      TEXT,                     -- 完整 result（可能 10KB+，长保留）
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  error_code       TEXT,
  delivery_mode    TEXT,                     -- 'callback' | 'pull' | 'both'（请求级，可覆盖 app 级）
  delivered_at     INTEGER,                  -- callback 投递成功时间；pull-only 不写
  acked_at         INTEGER,                  -- pull 模式 ack 时间；callback-only 不写
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_analyze_app_time ON analyze_requests(app_id, created_at);
CREATE INDEX idx_analyze_hash     ON analyze_requests(input_hash, biz_type);
-- 加速 GET /v1/analyze?app_id=...&status=ok&since_id=... cursor 拉取
CREATE INDEX idx_analyze_app_pull ON analyze_requests(app_id, status, acked_at, id);
```

### DDL · `migrations/0007_apps_add_analyze_columns.sql`

```sql
ALTER TABLE apps ADD COLUMN analyze_biz_types         TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN delivery_mode             TEXT    NOT NULL DEFAULT 'both';
ALTER TABLE apps ADD COLUMN callback_max_concurrency  INTEGER NOT NULL DEFAULT 10;
```

### Request envelope Zod 草稿（`src/analyze/schema/envelope.ts`）

```ts
import { z } from "zod";

export const ANALYZE_BIZ_TYPES = ["media_analysis", "media_intro"] as const;
export const ANALYZE_MODE = ["sync", "async", "auto"] as const;

export const AnalyzeRequestEnvelope = z.object({
  biz_type:     z.enum(ANALYZE_BIZ_TYPES),
  biz_id:       z.string().min(1).max(128),
  input:        z.record(z.unknown()),       // 各 biz_type 在 dispatcher 内二次 parse
  mode:         z.enum(ANALYZE_MODE).optional().default("auto"),
  callback_url: z.string().url().optional(),
  user_id:      z.string().max(128).optional(),
  extra:        z.record(z.unknown()).optional(),
});
export type AnalyzeRequestEnvelopeT = z.infer<typeof AnalyzeRequestEnvelope>;
```

### 验收清单
- [ ] `pnpm -s typecheck && pnpm -s test` 通过（test 应有最少 1 个 analyze route 鉴权 / 入队测试）
- [ ] `wrangler d1 execute --local --file=migrations/0006_*.sql` 成功；之后 `SELECT * FROM analyze_requests` 表存在，含 input_json / delivered_at / acked_at / delivery_mode 列
- [ ] `curl POST http://127.0.0.1:8787/v1/analyze` 用合法 HMAC 应得 `202 + request_id`，且 D1 行 `input_json` 字段完整
- [ ] 数据库 `analyze_requests` 行写入：status=pending；consumer 跑完 status=error / error_code=`not_implemented`
- [ ] `delivery_mode='callback'` 或 `'both'` 时回调到 `callback_url` 收到 `{schema_version:"1.1", status:"error", error_code:"not_implemented"}`，且 `delivered_at` 被写入
- [ ] `delivery_mode='pull'` 时不发 callback，`delivered_at` 保持 null
- [ ] **moderate 系回归**：跑现有 `pnpm test` 21/21 全过；手动 curl `/v1/moderate` 收到的 callback 不含 `result` 字段（向后兼容）

---

## T-002b · P1 拉取接口端到端测试

### 范围
T-002 的 pull 接口（三件套）独立验收，确保 cursor 分页 / ack 幂等 / 鉴权隔离 / unacked 过滤无歧义。

### 测试矩阵

| 场景 | 步骤 | 预期 |
|------|------|------|
| 单次查询 | POST 提交 → 等 consumer 完成 → `GET /v1/analyze/{id}` | 200 + 完整 result（与 callback body 一致） |
| 单次查询跨 app | app A 提交 → app B HMAC 查 app A 的 id | 404 |
| cursor 续拉 | 连续提交 5 条 → consumer 完成 → `GET /v1/analyze?status=ok&limit=2` 三轮（带 since_id） | 三轮分别拿 2/2/1 条；第四轮 `next_since_id=null` |
| unacked 过滤 | 提交 3 条 → ack 中间那条 → `GET /v1/analyze?include=unacked` | 仅返 2 条（未 ack 的） |
| include=all | 同上 → `GET /v1/analyze?include=all` | 返 3 条 |
| ack 幂等 | 同一 id 连 ack 两次 | 都返 200；`acked_at` 不刷新 |
| ack callback-only 请求 | app `delivery_mode=callback` 的请求被 ack | 409 conflict |
| 大批量（200 条）cursor | 提交 200 条 → cursor `limit=50` 4 轮 | 4 轮拿完，无重复无遗漏 |

### 文件清单
- 新建 `test/analyze-pull.test.ts`：覆盖上述场景
- 修改 `src/db/analyze-requests.ts`：确保 cursor query 用 `(app_id, status, acked_at, id)` 索引（EXPLAIN QUERY PLAN 验证）

### 验收清单
- [ ] 上表 8 个场景全部通过
- [ ] ack 幂等：D1 `acked_at` 第二次 ack 不被覆盖（用 `acked_at IS NULL` 守卫）
- [ ] cursor 性能：200 条数据每轮 cursor query < 50ms（开 D1 explain）
- [ ] 跨 app 隔离：HMAC 解析的 app_id 与 query 的 app_id 必须一致（中间件强制）

---

## T-003 · P2a `media_analysis` · Gemini 主路径

### 范围
落地第一个真正能跑的 analyze biz_type。

### 文件清单

| 操作 | 文件 | 关键内容 |
|------|------|----------|
| 新建 | `src/analyze/schema/media-analysis.ts` | 完整 Input + Output Zod schema（见下） |
| 新建 | `src/analyze/pipeline/media-analysis.ts` | input 校验 → canonicalize → hash → KV dedup 查 → miss → 取 prompt → call provider → Zod parse output → 写 D1 + KV → enqueue CALLBACK_QUEUE |
| 新建 | `src/analyze/providers/gemini-media.ts` | 用 Gemini Vision 多模态 + `responseMimeType: application/json` + `responseSchema`（从 IRC 现成 JSON Schema 移植）+ `safetySettings: BLOCK_NONE` |
| 修改 | `src/analyze/pipeline/dispatcher.ts` | `media_analysis` → 调 `media-analysis.ts` |
| 修改 | `src/providers/router.ts` | 路由表加 `(media_analysis, gemini, xai)` 条目；熔断 key 改为 `${provider}:${biz_type}` |
| 新建 | `migrations/0009_seed_media_analysis_prompt.sql` | seed prompts 表，v1 内容用拼好的字符串（见下「Prompt seed」） |
| 修改 | `src/analyze/dedup.ts`（如复用现有则不新建） | canonicalize：键排序 + UTF-8 + image_urls 改用 byte sha256（而非 URL 字符串），避免 CDN 缓存破坏 dedup |

### Input / Output Zod（`src/analyze/schema/media-analysis.ts`）

```ts
import { z } from "zod";

// Input
export const MediaAnalysisInput = z.object({
  image_urls: z.array(z.string().url().startsWith("https://")).min(1).max(16),
  title: z.string().max(512).optional(),
  duration_seconds: z.number().int().nonnegative().optional(),
  frame_metadata: z.array(z.object({
    timestamp_seconds: z.number().nonnegative(),
    quality_score:     z.number().min(0).max(1),
    scene_id:          z.number().int().optional(),
  })).optional(),
  region_hint: z.string().optional(),
});

// Output —— 锚定 IRC normalize_video_ai_response + normalize_image_analysis_response superset
// N=1 vs N>1 字段规则见 RFC §4.1
const ViolationSchema = z.object({
  category:          z.string(),
  detected:          z.boolean(),
  confidence:        z.number().min(0).max(1),
  evidence:          z.string(),
  frame_index:       z.number().int().optional(),         // N=1 时省略
  timestamp_seconds: z.number().nonnegative().optional(), // N=1 时省略
});

const ModerationSchema = z.object({
  decision:   z.enum(["approve", "reject", "review"]),
  confidence: z.number().min(0).max(1),
  summary:    z.string(),
  violations: z.array(ViolationSchema),
});

const TagsSchema = z.object({
  tag_names:       z.array(z.string()),
  extra_tag_names: z.array(z.string()),
  categories: z.object({
    meta:       z.record(z.unknown()),
    appearance: z.record(z.unknown()),
    context:    z.record(z.unknown()),
    production: z.record(z.unknown()),
  }),
  summary: z.string(),
  status:  z.enum(["ready", "pending"]),
});

const AdDetectionSchema = z.object({
  is_ad:      z.boolean(),
  categories: z.array(z.string()),
  elements:   z.array(z.string()),
  contacts:   z.array(z.string()),
  urls:       z.array(z.string()),
  reason:     z.string(),
});

const FaceCoordSchema = z.object({
  frame_index:       z.number().int().optional(),         // N=1 时省略
  timestamp_seconds: z.number().nonnegative().optional(), // N=1 时省略
  box: z.object({
    x:      z.number().int(),
    y:      z.number().int(),
    width:  z.number().int(),
    height: z.number().int(),
  }),
  orientation: z.string(),
  confidence:  z.number().min(0).max(1),
});

const CoverCandidateSchema = z.object({
  frame_index:       z.number().int(),
  timestamp_seconds: z.number().nonnegative(),
  score:             z.number().int().min(0).max(100),
  scoring_breakdown: z.record(z.number()),
  reason:            z.string(),
  is_recommended:    z.boolean(),
});

const TrialSchema = z.object({
  trial_start_seconds: z.number().int().nonnegative(),
  trial_end_seconds:   z.number().int().nonnegative(),
  trial_score:         z.number().min(0).max(1),
  reason:              z.string(),
  status:              z.enum(["ready", "pending"]),
});

export const REGION_CODES = [
  "japan","china","taiwan","thailand","vietnam","usa","czech","brazil",
  "uk","germany","france","canada","australia","southeast_asia","russia","other",
] as const;

const RegionSchema = z.object({
  code:           z.enum(REGION_CODES),
  requested_code: z.string(),
  confidence:     z.number().min(0).max(1),
  reasoning:      z.string(),
  signals:        z.record(z.unknown()),
});

const FrameNoteSchema = z.object({
  frame_index:       z.number().int(),
  timestamp_seconds: z.number().nonnegative(),
  summary:           z.string(),
});

export const MediaAnalysisOutput = z.object({
  // 始终填
  moderation:       ModerationSchema,
  tags:             TagsSchema,
  ad_detection:     AdDetectionSchema,
  face_coordinates: z.array(FaceCoordSchema),
  region:           RegionSchema,

  // N=1 单图专属（image_urls.length === 1 时填）
  description:       z.string().optional(),
  score:             z.number().int().min(0).max(100).optional(),
  scoring_breakdown: z.record(z.number()).optional(),

  // N>1 视频帧专属（image_urls.length > 1 时填）
  cover_candidates: z.array(CoverCandidateSchema).max(5).optional(),
  trial:            TrialSchema.optional(),
  frame_notes:      z.array(FrameNoteSchema).optional(),
});

export type MediaAnalysisInputT  = z.infer<typeof MediaAnalysisInput>;
export type MediaAnalysisOutputT = z.infer<typeof MediaAnalysisOutput>;
```

> **prompt 引导**：T-003 阶段写 prompt 时，根据 input 的 `image_urls.length` 在 prompt 末尾追加 "Since N=1, return description/score/scoring_breakdown and omit cover_candidates/trial/frame_notes." 或反之；prompt seed 见 §「Prompt seed」。

### Prompt seed（`migrations/0009_seed_media_analysis_prompt.sql`）

prompt v1 用 IRC 现有 `prompt_fragments.py` 拼好的字符串（adult_gay_platform_policy('video') + compact_video_response_contract 全文，逐字 copy 即可）。下例为 placeholder，**实施时按 IRC 现行 prompt 逐字搬运**：

```sql
INSERT INTO prompts (biz_type, provider, version, content, is_active, created_by, created_at)
VALUES
  ('media_analysis', 'gemini', 1,
   'You are the moderation and metadata extraction model for an adult gay male content platform.
Consensual adult gay male explicit content is allowed; nudity or pornography alone is not a violation.
Use only visible evidence from sampled frames. Do not invent unsupported details.
Escalate minors, coercion, gore, bestiality, offsite ads, QR/contact info, or clearly non-gay-male content.
Return exactly one JSON object without markdown.

Response fields:
- moderation: decision approve|reject|review, confidence, summary, violations only when present.
- tags: tag_names, extra_tag_names, categories, summary, status ready|pending.
- ad_detection: is_ad, categories/elements/contacts/urls only when present, reason.
- faceCoordinates: frame_index, timestamp, box{x,y,width,height}, orientation, confidence.
- cover_candidates: frame_index, timestamp, score 0-100, scoring_breakdown, reason, is_recommended.
- trial: trial_start, trial_end, trial_score, reason, status ready|pending.
- region: code one of japan,china,taiwan,thailand,vietnam,usa,czech,brazil,uk,germany,france,canada,australia,southeast_asia,russia,other, confidence, reasoning, signals.
- frame_notes: frame_index, timestamp, summary.
Region: choose one supported code; prefer studio/watermark, then language, then visual/scene clues; use "other" for weak or conflicting evidence.',
   1, 'system', unixepoch());

INSERT INTO prompts (biz_type, provider, version, content, is_active, created_by, created_at)
VALUES
  ('media_analysis', 'xai', 1,
   '...同上...',
   1, 'system', unixepoch());
```

参考实现：[`c:\code\irc\python\app\pipeline\prompt_fragments.py`](../../../irc/python/app/pipeline/prompt_fragments.py)（`adult_gay_platform_policy('video')` + `compact_video_response_contract()` + `compact_region_rules()`）。

### Gemini 调用关键约束（`src/analyze/providers/gemini-media.ts`）

- **不要在 Worker 内 base64 图片**（CPU + 内存限额）；用 Gemini `inlineData` 时让 Gemini API 自己拉 URL。Gemini `generateContent` 支持 `fileData: { fileUri, mimeType }` 给 https URL
- `generationConfig.responseMimeType = "application/json"`
- `generationConfig.responseSchema` = MediaAnalysisOutput 的 JSON Schema 表达（用 Zod 转 JSON Schema 库，或手写）
- `safetySettings`：全部 `BLOCK_NONE`（成人平台铁律）
- 超时 90s；失败 retry 2 次（指数退避）

### 验收清单
- [ ] `pnpm -s typecheck && pnpm -s test` 通过
- [ ] 单测：MediaAnalysisInput / Output Zod 边界 case（image_urls 上下限 / 区域代码白名单 / score 范围）
- [ ] E2E：mock Gemini 返回标准 IRC 视频帧分析输出 → ai-guard parse 后写 D1 / 入 callback → 回放给应用端
- [ ] KV dedup 命中：相同 input_hash 第二次返 `cached=true`，无 token 消耗
- [ ] 错误路径：URL 不可达 / 图片非图片 / Gemini 5xx 各自正确 error_code
- [ ] moderate 系回归 21/21 通过不变
- [ ] dev 环境真实 Gemini 跑通一次（IRC 提供一组真实视频帧 URL 做 smoke）

---

## T-004 · P2b `media_analysis` · xAI 备路径 + 熔断

### 范围
xAI（Grok）作为 Gemini 失败时的备路径；熔断按 `(provider, biz_type)` 隔离。

### 文件清单

| 操作 | 文件 | 关键内容 |
|------|------|----------|
| 新建 | `src/analyze/providers/xai-media.ts` | xAI vision API，对照 `src/providers/grok.ts` 模板 |
| 修改 | `src/providers/circuit.ts` | 熔断 key 从 `provider` 改为 `${provider}:${biz_type}`；moderate 系沿用现有 key 不影响 |
| 修改 | `src/providers/router.ts` | router 在 gemini 熔断 / 失败时切 xai-media |
| 修改 | `src/analyze/pipeline/media-analysis.ts` | provider router 接入 |

### 验收清单
- [ ] 单测：模拟 gemini 5xx 5 次 → 熔断 → 自动切 xai-media → 30s 后探测恢复
- [ ] moderate 系熔断（avatar→gemini）不被新逻辑影响（隔离测试）
- [ ] dev 真实跑通一次 xAI 主路径

---

## T-005 · P3 `media_intro` 实现

### 范围
视频简介生成 biz_type。

### 文件清单

| 操作 | 文件 | 关键内容 |
|------|------|----------|
| 新建 | `src/analyze/schema/media-intro.ts` | Input + Output Zod（见下） |
| 新建 | `src/analyze/pipeline/media-intro.ts` | 同 media-analysis 套路 |
| 新建 | `src/analyze/providers/xai-text.ts`（如复用 `src/providers/grok.ts` 则不新建） | xAI text-only 调用 |
| 修改 | `src/analyze/pipeline/dispatcher.ts` | `media_intro` 派发 |
| 修改 | `src/providers/router.ts` | 加 `(media_intro, xai, gemini)` |
| 新建 | `migrations/0010_seed_media_intro_prompt.sql` | seed prompts v1（参考 IRC `intro_generator.py` 现行 prompt） |

### Schema 草稿（`src/analyze/schema/media-intro.ts`）

```ts
import { z } from "zod";

export const MediaIntroInput = z.object({
  title:             z.string().min(1).max(512),
  duration_seconds:  z.number().int().nonnegative().optional(),
  tags:              z.array(z.string()).optional(),
  frame_notes:       z.array(z.object({
    timestamp_seconds: z.number().nonnegative(),
    summary:           z.string(),
  })).optional(),
  ocr_lines:         z.array(z.string()).optional(),
  subtitle_text:     z.string().optional(),
  trial_excerpt:     z.string().optional(),
  style_hint:        z.enum(["concise", "narrative", "marketing"]).optional(),
  max_length:        z.number().int().min(50).max(2000).optional(),
});

export const MediaIntroOutput = z.object({
  intro:              z.string().min(1),
  title_suggestions:  z.array(z.string()).max(3).optional(),
  beats: z.array(z.object({
    timestamp_seconds: z.number().nonnegative(),
    summary:           z.string(),
  })).optional(),
});
```

### 验收清单
- [ ] typecheck + test 通过
- [ ] dev 真实跑通一次（IRC 提供一份 video frame_notes / OCR / 字幕样本）
- [ ] auto mode：<10s 同步返；>10s 降级 async 并回调（写测试 mock 慢路径）

---

## T-006 · P4 Admin UI 双轨化

### 范围
Admin UI 支持双轨业务的可视化管理。

### 文件清单

| 操作 | 文件 | 关键内容 |
|------|------|----------|
| 修改 | `admin-ui/src/views/apps.vue`（或对应 React tsx） | apps 编辑器加：`analyze_biz_types` 多选 / `delivery_mode` 单选 callback\|pull\|both / `callback_max_concurrency` 数字输入 |
| 修改 | `src/routes/admin-apps.ts` | `PATCH /admin/apps/:id` 接受新三字段 |
| 修改 | `admin-ui/src/views/prompts.vue` | prompts 列表按 `track ∈ {moderate, analyze}` 分两个 tab；biz_type 归属由代码常量决定 |
| 修改 | `admin-ui/src/views/stats.vue` | 新增 "Analyze" tab：拉 analyze_requests 维度的 stats_rollup 数据 |
| 修改 | `src/routes/admin-stats.ts` | 加 analyze 维度查询（沿用 stats_rollup） |
| 修改 | `src/stats/rollup.ts` | cron 汇总加 analyze_requests 来源；output_bytes_total 累加 |
| **新建** | `admin-ui/src/views/analyze-records.vue` | **analyze 调用记录视图**：按 app / biz_type / biz_id / 时间范围 / status / delivery 状态 检索；列表展示元数据；点击展开看完整 `input_json` + `result_json`（JSON tree viewer + 复制按钮） |
| 新建 | `src/routes/admin-analyze-records.ts` | `GET /admin/analyze-records` 列表 + `GET /admin/analyze-records/:id` 详情；管理 token 鉴权（沿用） |
| 新建 | `src/db/admin-analyze-queries.ts` | 分页查询 + JSON 字段返回 |

### 验收清单
- [ ] Apps 页能编辑 analyze_biz_types / delivery_mode / callback_max_concurrency，保存后 D1 行 / KV 缓存同步刷新
- [ ] Prompts 页能区分两条线，编辑互不串
- [ ] Stats 页 Analyze tab 数据为零时不报错（接入前自然为零）
- [ ] **调用记录页**：能筛 `biz_id="video-12345"` 并看到该资源所有历史 analyze 调用；点开能看完整 input_json / result_json；分页正常；管理 token 鉴权生效

---

## T-007 · P5 IRC 端适配（外部 / EXT）

**不在本仓库实施。** IRC 团队按以下范围在 `c:\code\irc\` 推进：

| IRC 改动点 | 说明 |
|-----------|------|
| `python/app/services/ai_client.py` | 加 `AiGuardClient` 适配层（HMAC + /v1/analyze） |
| `python/app/pipeline/ai_analyzer.py` | backend 切 ai-guard biz_type=`media_analysis`，等 callback 而非同步返回 |
| `python/app/pipeline/image_analyzer.py` | 同上（单图入 image_urls 长度 1） |
| `python/app/pipeline/intro_generator.py` | backend 切 ai-guard biz_type=`media_intro` |
| IRC pipeline | 从同步推进改为「发请求 → 标 waiting_ai → callback 触发推进」状态机 |
| IRC `secrets-hub` | 注册 `ai_guard_secret`；ai-guard 通过安全渠道交付 |
| IRC feature flag | `AI_BACKEND=internal\|ai_guard`，按资源类型 / 比例灰度 |

ai-guard 端配合：管理员在 Admin UI 注册 `app_irc`，启用 `analyze_biz_types=['media_analysis','media_intro']`，secret 通过安全渠道交付。

---

## T-008 · P6 灰度 1 周

### 范围
真实流量灰度，监控指标。

### 灰度比例
10% → 25% → 50% → 100%（每档观察 24h，无显著回归才升档）

### 监控指标
- `analyze_requests.status` 分布（pending / ok / error 占比）
- `latency_ms` p50 / p95 / p99
- `tokens.output` 分布（识别 prompt 跑飞）
- `error_code` 分布（识别瓶颈：unsupported_content / provider_error / sync_timeout）
- KV dedup 命中率（应 > 30% 才划算）
- IRC 端 result schema 兼容性测试通过率（IRC 自家做 schema diff 工具）

### 回滚
- IRC 端 `AI_BACKEND=internal` 一键切回
- ai-guard 端无需回滚（不影响 moderate 线）
- 灰度期间发现重大问题 → 停档 → 修 → 重新从 10% 起

### 验收清单
- [ ] 100% 切完后 24h 错误率 < 1%
- [ ] p95 latency 不超过 IRC 原 internal backend 的 1.5×
- [ ] dedup 命中率达预期
- [ ] 无 moderate 线性能 / 错误率回归

---

## T-009 · P7 全量切换 + 收尾

### 文件清单
| 操作 | 范围 |
|------|------|
| ai-guard `README.md` / `00-overview.md` | 状态从 "MVP" 更新为 "MVP + Content Services GA" |
| ai-guard Admin UI | 灰度 toggle 隐藏（保留代码备用） |
| IRC `vrc_prompts` | media 系条目标 `deprecated_at`（不删，保留 90 天审计窗） |
| IRC `python/.env*` | `XAI_API_KEY` / `GEMINI_API_KEY` 在 `ai_analyzer / image_analyzer / intro_generator` 三处下线（**小说线保留**） |
| IRC `token_metrics` | media 系暂停采集（统计转看 ai-guard Admin） |
| ai-guard | 关闭 IRC 灰度 feature flag |

### 验收清单
- [ ] IRC 三条 AI 链路 100% 走 ai-guard，无 fallback 残留
- [ ] IRC 小说线、文本审核线不受影响（不下线对应 key）
- [ ] ai-guard 文档状态更新到 GA
- [ ] 灰度期间所有问题闭环

---

## 附录

### A. 与现有 skill 的协同

| skill | 何时用 |
|-------|--------|
| `.claude/skills/add-biz-type/SKILL.md` | T-003 / T-005 新增 biz_type 时走该 skill（T-001 阶段会扩 skill 支持双轨） |
| `.claude/skills/tune-prompt/SKILL.md` | T-003 / T-005 / T-008 调 prompt 时走该 skill（不变） |
| `.claude/skills/add-provider/SKILL.md` | 本期 Gemini / xAI 已接入，不用 |
| `.claude/skills/deploy-worker/SKILL.md` | 每个 PR 后 dev 冒烟；T-009 全量 prod 部署 |

### B. ADR 触发点

如下场景必须开 ADR（`docs/adr/` 目录如果不存在则新建）：
- 偏离 RFC §3 端点设计（如：决定还是合到 `/v1/moderate`）
- 偏离 RFC §5 表设计（如：决定合表到 moderation_requests）
- 增加新 provider / 新 biz_type 超出 RFC §2.1 范围
- callback envelope 字段名变更（**铁律**——理论上不应发生）

### C. 风险预案

| 风险 | 处理 |
|------|------|
| T-002 D1 migration 在 prod 卡住 | 先 dev 跑足，prod 用 `wrangler d1 execute --remote --file=...` 单步执行；卡住先 `--preview-database-id` 试 |
| T-003 Gemini responseSchema 与 Zod schema 漂移 | Gemini responseSchema 用 `Zod schema → JSON Schema` 工具生成（zod-to-json-schema），单一源真值 |
| T-007 IRC 端工作量超预期 | 不阻塞 ai-guard 侧 GA；ai-guard 端可以先开放给其他潜在用户 |
| T-008 灰度发现 result schema 与 IRC 期待不一致 | 走 ADR 调 schema（**注意契约稳定性**），优先调 prompt 而不是改 callback contract |

— END v1.0 —
