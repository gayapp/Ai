# 18 · Prompt Regression Sets

> 更新日期：2026-05-22  
> 范围：管理后台的 prompt 回归样本集，用于在发布 prompt 前比较 `draft` 与当前 `active` 的输出差异。本文不包含任何 secret。

## 目标

Prompt regression set 是一组固定样本，按 `(biz_type, provider)` 保存。运营或开发在发布 prompt 前，可以把新 prompt 作为 draft 跑一遍，并与当前 active prompt 的 dry-run 结果对比。

目标：

- 降低 prompt 发布回归风险。
- 让 `media_analysis` / `media_intro` 接入前有固定样本可重复验证。
- 不改变 `/v1/moderate`、`/v1/analyze`、callback、pull 的公开契约。

## 支持范围

| biz_type | provider | 回归执行方式 |
| --- | --- | --- |
| `comment` / `nickname` / `bio` / `avatar` | `grok` / `gemini` | 复用 moderate dry-run，真实请求 provider，并校验 moderate 输出 schema |
| `media_intro` | `xai` / `gemini` | 复用 analyze text dry-run，真实请求 provider，并校验 `MediaIntroOutput` |
| `media_analysis` | `xai` / `gemini` | 校验 `MediaAnalysisInput`，生成 prompt preview；不下载图片、不请求多模态 provider |

`media_analysis` 当前保持轻量回归：它验证输入 schema 与 prompt 构造是否符合 RFC 规则；真实多模态 provider 行为仍通过 `/v1/analyze` smoke 与灰度门禁验证。

## D1 表

迁移：`migrations/0013_prompt_regression_sets.sql`

```sql
CREATE TABLE IF NOT EXISTS prompt_regression_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  biz_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  samples_json TEXT NOT NULL CHECK (json_valid(samples_json)),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

保留策略：

- 样本集长期保留，不做 TTL。
- 样本内容由管理员维护；不要写入 secret、access token、app secret 或用户隐私原文。
- 回归运行结果当前不持久化，只在接口响应和管理台页面展示。

## 样本格式

管理台保存时使用 JSON array：

```json
[
  {
    "name": "single image",
    "input": {
      "image_urls": ["https://example.com/frame.jpg"],
      "title": "Sample clip",
      "frame_metadata": [{ "timestamp_seconds": 0, "quality_score": 0.9 }]
    }
  }
]
```

后端持久化时会把 `input` 规范成 string：

- moderate：普通文本或图片 URL。
- `media_intro` / `media_analysis`：compact JSON input object。
- `expected` 可选。存在时，回归结果会给出 `active_expected_match` / `draft_expected_match`。

## Admin API

所有接口都走 `Authorization: Bearer <ADMIN_TOKEN>`。

### `GET /admin/prompt-regression`

Query：

- `biz_type`
- `provider`
- `limit`

返回样本集摘要：

```json
{
  "items": [
    {
      "id": 1,
      "name": "IRC media_analysis regression",
      "biz_type": "media_analysis",
      "provider": "xai",
      "sample_count": 3,
      "created_by": "admin",
      "created_at": 1780000000000,
      "updated_at": 1780000000000
    }
  ]
}
```

### `POST /admin/prompt-regression`

创建样本集。

```json
{
  "name": "IRC media_analysis regression",
  "biz_type": "media_analysis",
  "provider": "xai",
  "samples": [
    {
      "name": "single image",
      "input": "{\"image_urls\":[\"https://example.com/frame.jpg\"]}"
    }
  ]
}
```

### `GET /admin/prompt-regression/{id}`

返回样本集详情，包含 `samples`。

### `PATCH /admin/prompt-regression/{id}`

可更新：

- `name`
- `samples`

### `POST /admin/prompt-regression/{id}/run`

用当前 active prompt 与请求中的 draft prompt 分别跑同一组样本。

Request：

```json
{
  "draft_content": "完整 draft prompt"
}
```

Response：

```json
{
  "set_id": 1,
  "name": "IRC media_analysis regression",
  "biz_type": "media_analysis",
  "provider": "xai",
  "active_version": 3,
  "sample_count": 1,
  "summary": {
    "changed": 1,
    "unchanged": 0,
    "active_schema_failures": 0,
    "draft_schema_failures": 0,
    "active_expected_failures": 0,
    "draft_expected_failures": 0
  },
  "results": [
    {
      "name": "single image",
      "changed": true,
      "active_schema_ok": true,
      "draft_schema_ok": true,
      "active_expected_match": null,
      "draft_expected_match": null,
      "active": {},
      "draft": {}
    }
  ]
}
```

## 管理台

入口：`#/prompt-regression`

能力：

- 按 `biz_type` / `provider` 过滤样本集。
- 新建或编辑样本集。
- 从当前 active prompt 自动填入 draft 编辑区。
- 运行 `draft vs active`。
- 显示 changed、schema failure、expected failure 与每条样本的 active/draft 摘要。

## 审计

以下动作会写入 `admin_audit_logs`：

- `prompt_regression.create`
- `prompt_regression.update`
- `prompt_regression.run`

审计 metadata 只记录样本集名称、路由、样本数量、active version、draft 长度等摘要，不记录样本内容和 prompt 内容。

## 边界

- 不改 `/v1/moderate` 四个 biz_type 请求字段。
- 不改 moderate callback schema。
- 不改 `docs/04-callback-spec.md`。
- 不引入权限分级；当前继续使用统一 `ADMIN_TOKEN`。
- 不自动发布 prompt；回归通过后仍需在 `/prompts` 手动发布。
