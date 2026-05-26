# 12 · 内容服务总览

> 本文档描述 **analyze 系内容服务**。现有 UGC 审核仍由 `/v1/moderate` 承载，契约见 [02-api-public.md](02-api-public.md) 与 [04-callback-spec.md](04-callback-spec.md)。
>
> 上游决策来源：[optimization/content-services-expansion.md](optimization/content-services-expansion.md)（RFC v1.1 · APPROVED）。

## 1. 定位

ai-guard 从单一「UGC 审核中转」扩展为双轨平台：

| 轨道 | 端点 | 目标 | 输出形态 | 留存 |
|------|------|------|----------|------|
| moderate | `/v1/moderate` | 评论 / 昵称 / 简介 / 头像审核 | 固定审核判定字段 | 不长期留存用户原始数据 |
| analyze | `/v1/analyze` | 图片 / 视频帧分析、视频简介生成 | 按 biz_type 返回结构化 `result` | `input_json` + `result_json` 长保留 |

两条轨道共享 HMAC 鉴权、app 配置、限流、provider 路由、prompt 管理、KV 去重、Queue 和 callback 基础设施；端点、业务类型、D1 表和 callback 契约保持独立。

## 2. 第一批内容服务

| biz_type | 场景 | 默认 provider | 输入 |
|----------|------|---------------|------|
| `media_analysis` | 图片 / 视频帧多模态分析 | `auto`: Gemini，xAI 兜底；`provider_strategy=grok`: xAI only，不 fallback Gemini | 1..16 张 `https://` 图片 URL + 可选上下文 |
| `media_intro` | 视频简介生成 | `auto`: xAI，Gemini 兜底；`provider_strategy=grok`: xAI only，不 fallback Gemini | 标题、标签、帧摘要、OCR、字幕等结构化文本 |

不在本期范围：

- 小说分析：未来可独立增加 `novel_analyze`
- IRC 文本审核：继续走 `/v1/moderate`
- 通用 chat / instruct 中转
- OCR、ASR、人脸识别、embedding 等物理服务器本地能力

## 3. 与 moderate 线的关系

`/v1/moderate` 的 4 个既有 biz_type 一字不改：

- `comment`
- `nickname`
- `bio`
- `avatar`

新增内容服务必须走 `/v1/analyze`。不得把 `media_analysis` / `media_intro` 挂到 `/v1/moderate`，也不得修改 [04-callback-spec.md](04-callback-spec.md) 来承载 analyze 结果。

callback 规则：

- moderate 系继续遵守 [04-callback-spec.md](04-callback-spec.md)，字段集不新增 `result`
- analyze 系使用 [13-callback-spec-analyze.md](13-callback-spec-analyze.md)，`schema_version="1.1"`，`status` 仅为 `ok | error`

## 4. Public API 概览

提交内容服务任务：

```http
POST /v1/analyze
Headers: X-App-Id / X-Timestamp / X-Nonce / X-Signature
Content-Type: application/json
```

```json
{
  "biz_type": "media_analysis",
  "biz_id": "video-12345",
  "input": {
    "image_urls": ["https://cdn.example.com/frame-1.jpg"],
    "title": "sample title",
    "duration_seconds": 632
  },
  "mode": "async",
  "callback_url": "https://consumer.example.com/hooks/analyze",
  "delivery_mode": "both",
  "user_id": "u_88991",
  "extra": { "trace_id": "irc-001" }
}
```

响应模式：

| biz_type | 默认 mode | 约束 |
|----------|-----------|------|
| `media_analysis` | `async` | 不允许强制同步；`auto` 会降级为异步 |
| `media_intro` | `auto` | 允许同步；超时后降级异步 |

pull 接口：

- `GET /v1/analyze/{request_id}`：单次查询
- `GET /v1/analyze`：cursor 拉取 `ok` / `error` 结果
- `POST /v1/analyze/{request_id}/ack`：显式确认已消费

完整契约见 [02-api-public.md](02-api-public.md#post-v1analyze--提交内容服务任务) 与 [14-analyze-records.md](14-analyze-records.md)。

## 5. `media_analysis` schema

### Input

```ts
{
  image_urls: string[];              // 必填，1..16 张 https:// URL
  title?: string;                    // 资源标题 hint，最大 2048 字符
  duration_seconds?: number;         // 视频时长，仅视频时填
  frame_metadata?: {
    timestamp_seconds: number;
    quality_score: number;           // 非负质量分；可为 0..1 归一化分或 IRC 原始质量分
    scene_id?: number;
  }[];
  region_hint?: string;
}
```

### Output

`media_analysis` 合并图片与视频帧分析，使用同一个 biz_type。输出是 IRC `normalize_video_ai_response` 与 `normalize_image_analysis_response` 的 superset。

字段规则：

- 始终返回：`moderation` / `tags` / `ad_detection` / `region` / `face_coordinates`
- `image_urls.length === 1`：返回 `description` / `score` / `scoring_breakdown`
- `image_urls.length > 1`：返回 `cover_candidates` / `trial` / `frame_notes`
- 不适用字段省略，不返回 `null` 或空占位

```ts
{
  moderation: {
    decision: "approve" | "reject" | "review";
    confidence: number;
    summary: string;
    violations: {
      category: string;
      detected: boolean;
      confidence: number;
      evidence: string;
      frame_index?: number;
      timestamp_seconds?: number;
    }[];
  };
  tags: {
    tag_names: string[];
    extra_tag_names: string[];
    categories: {
      meta: Record<string, unknown>;
      appearance: Record<string, unknown>;
      context: Record<string, unknown>;
      production: Record<string, unknown>;
    };
    summary: string;
    status: "ready" | "pending";
  };
  ad_detection: {
    is_ad: boolean;
    categories: string[];
    elements: string[];
    contacts: string[];
    urls: string[];
    reason: string;
  };
  face_coordinates: {
    frame_index?: number;
    timestamp_seconds?: number;
    box: { x: number; y: number; width: number; height: number };
    orientation: string;
    confidence: number;
  }[];
  region: {
    code: string;
    requested_code: string;
    confidence: number;
    reasoning: string;
    signals: Record<string, unknown>;
  };
  description?: string;
  score?: number;
  scoring_breakdown?: Record<string, number>;
  cover_candidates?: {
    frame_index: number;
    timestamp_seconds: number;
    score: number;
    scoring_breakdown: Record<string, number>;
    reason: string;
    is_recommended: boolean;
  }[];
  trial?: {
    trial_start_seconds: number;
    trial_end_seconds: number;
    trial_score: number;
    reason: string;
    status: "ready" | "pending";
  };
  frame_notes?: {
    frame_index: number;
    timestamp_seconds: number;
    summary: string;
  }[];
}
```

## 6. `media_intro` schema

### Input

```ts
{
  title: string;                      // 最大 2048 字符
  duration_seconds?: number;
  tags?: string[];
  frame_notes?: { timestamp_seconds: number; summary: string }[];
  ocr_lines?: string[];
  subtitle_text?: string;
  trial_excerpt?: string;
  style_hint?: "concise" | "narrative" | "marketing";
  max_length?: number;
}
```

### Output

```ts
{
  intro: string;
  title_suggestions?: string[];
  beats?: { timestamp_seconds: number; summary: string }[];
}
```

## 7. 数据与交付

analyze 线使用独立 D1 表 `analyze_requests`：

- 必须保存完整 `input_json`
- 必须保存完整 `result_json`
- 不参与 moderate 线 TTL 清理
- 支持按 app / biz_type / biz_id / 时间查询历史调用

每个 app 可配置 `delivery_mode`：

| delivery_mode | 行为 |
|---------------|------|
| `callback` | 完成后只投递 callback，不支持 ack |
| `pull` | 不投递 callback，只等待消费方拉取并 ack |
| `both` | callback + pull 兜底，默认值 |

详情见 [14-analyze-records.md](14-analyze-records.md)。

## 8. IRC 迁移映射

| IRC 现状 | ai-guard analyze 方案 |
|----------|-----------------------|
| `ai_client.analyze_video_frames` | `POST /v1/analyze` + `biz_type="media_analysis"` |
| `image_analyzer.py` 中 AI 分析部分 | `POST /v1/analyze` + `biz_type="media_analysis"`，单图传 `image_urls.length=1` |
| `intro_generator.py` | `POST /v1/analyze` + `biz_type="media_intro"` |
| `text_moderator.py` | 继续走 `/v1/moderate` |
| `novel_analyzer.py` | 本期不迁移 |

IRC 端推荐 `delivery_mode="both"`：callback 做实时推进，cron pull 做兜底恢复。
