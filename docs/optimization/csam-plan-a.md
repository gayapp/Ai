# 方案 A · CSAM 合规：不保存头像原图（当前策略）· 2026-04-24

> ⚠️ 本策略替代了原 P0.2（Cloudflare CSAM Scanning Tool 启用）。
>
> 核心思路：不把风险数据放在自己账号下 → 从根本上消除"平台违法持有"维度的风险。

## 决策摘要

| | 原 P0.2 方案 | **当前方案 A** |
|-|---|---|
| R2 `ai-guard-evidence` 保存头像原图 | ✅ 保存 | ❌ **不保存**（默认关闭） |
| Cloudflare CSAM Scanner | ✅ 启用 | ➖ 不依赖（无数据可扫） |
| 单一防线 | NCMEC 哈希 + AI 语义 | **仅 AI 语义**（Gemini Vision prompt 里"疑似 < 18 一律 reject") |
| CSAM 漏网风险 | 极低 | 低-中（取决于 AI 判定） |
| 平台"持有违法数据"风险 | 中（CF 代理，但仍在账号内） | **接近零**（无存储） |

## 代码层实现

### 全局开关

`wrangler.toml`（prod + dev 都设）：
```toml
[vars]
SAVE_EVIDENCE = "false"   # 默认关闭；改 "true" 即启用 R2 存证
```

### 调用点

`src/index.ts` queue consumer 里：
```ts
if (isImage && ... && env.SAVE_EVIDENCE === "true") {
  const ev = await saveAvatarEvidence(env.EVIDENCE, job.request_id, job.content);
  if (ev) await setEvidenceKey(env.DB, job.request_id, ev.key);
}
```

关闭状态下：
- Avatar 审核结果只写 D1（status / reason / tokens 等）
- **不拉图片 / 不上传 R2**（saveAvatarEvidence 根本不被调用，省带宽 + 省 CPU）
- `moderation_requests.evidence_key` 始终 null
- Admin UI 头像详情只显示"原始 URL 那一张"（外部 CDN），"R2 存证"那一列会是空

### 已做的清理

- ✅ prod R2 `ai-guard-evidence` 已清空（1 个历史对象删除）
- ✅ dev R2 `ai-guard-dev-evidence` 原本即为空
- ✅ prod D1 `moderation_requests.evidence_key` 全部置 null
- ✅ dev 同上

## 保留部分

- **R2 bucket 仍然存在**（`ai-guard-evidence` / `ai-guard-dev-evidence`），不删除，方便未来一键复用
- **wrangler.toml 里 R2 binding 仍保留**，代码里 `saveAvatarEvidence` 函数仍在，只是不被调用
- **Admin API `/admin/stats/evidence/:id`** 仍可用（历史残留时返回 null 即可）

## 当前实际的 CSAM 防线

1. **prompt 层**（avatar-gemini.md v3）：
   > 必 reject：CSAM 绝对红线 — 图中人物面相/体型疑似 < 18 岁 + 任何裸露或性暗示 → 立即 reject（宁可错杀）。即便只是怀疑，也判 review → 不确定时倾向更严。
2. **schema 层**：Zod 锁定 `categories ∈ {politics, porn, abuse, ad, spam, violence, other}`，模型即使自创"csam"也会被规范化
3. **结构层**：不保留原图 → 即使 AI 漏判，平台也不构成"持有"

## 剩余风险与缓解

| 风险 | 缓解 |
|------|------|
| Gemini 把疑似未成年判成 pass（AI 误判） | prompt 里明文"宁可错杀"；定期抽检头像统计 |
| 业务侧（一起看 App）保存了自己的原图副本 | 业务方自行承担；ai-guard 不再在自身侧复制 |
| 将来需要真的证据时没图可查 | 需要时临时开 `SAVE_EVIDENCE=true` + Dashboard 开 CSAM Scan，再做一次部署 |
| 反复被抽样判 review 的图片增加运营成本 | 正常代价；人工复审队列已有（status=review） |

## 启用方式（未来如需切换到原 P0.2）

```bash
# 1. CF Dashboard 开启 R2 bucket 的 CSAM Scanning（见 csam-scan-setup.md）

# 2. 改 env var
wrangler secret put SAVE_EVIDENCE        # prod, 输入 "true"
wrangler secret put SAVE_EVIDENCE --env dev

# 或改 wrangler.toml 的 [vars] SAVE_EVIDENCE = "true" 后重部署

# 3. wrangler deploy
```

代码本身无需任何改动，直接可恢复。
