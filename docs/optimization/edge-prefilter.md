# P1.1 · 边缘前置过滤漏斗（Pre-filter Funnel）

> 目标：在 Worker 入口（HMAC 校验通过后、provider 调用前）拦掉 30-50% 的无效请求，不花 Token。

## 漏斗结构

```
request
  └─ HMAC 校验 ✓
     └─ Rate Limit ✓
        └─ 【P1.1 漏斗】
           ├─ 内容规范化 + 剥离 emoji/ZWJ/变音
           ├─ 规则 1：纯 emoji / 字符数 ≤2 / 空 → pass (cheap=true)
           ├─ 规则 2：高置信广告正则 → reject (ad)
           ├─ 规则 3：内容 SHA-256 命中 dedup cache → 复用
           └─ 没命中任何规则 → pipeline → provider → Grok/Gemini
```

每一层都是 O(μs)；Grok 调用是 O(500ms)。提前一层拦截省 1000× 时间。

---

## 规则设计

### Layer 1：低信噪内容短路（直接 pass）

```ts
export interface StripResult {
  original: string;
  stripped: string;
  significant_chars: number;
  is_pure_emoji: boolean;
  has_zero_width: boolean;
}

export function stripAndCount(s: string): StripResult {
  const zeroWidth = /[​-‏ -  -⁯﻿]/g;
  const emoji = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]\p{Emoji_Modifier}?|[\u{1F1E6}-\u{1F1FF}]{2}/gu;
  const marks = /\p{M}/gu;
  const punct = /[\p{P}\p{S}\s]/gu;

  const hasZW = zeroWidth.test(s);
  const noZW = s.replace(zeroWidth, "");
  const noEmoji = noZW.replace(emoji, "");
  const pureEmoji = noEmoji.replace(marks, "").replace(punct, "").length === 0 && noZW !== noEmoji;
  const significant = noEmoji.replace(marks, "").replace(punct, "").length;

  return {
    original: s,
    stripped: noEmoji.replace(marks, "").trim(),
    significant_chars: significant,
    is_pure_emoji: pureEmoji,
    has_zero_width: hasZW,
  };
}

/** Returns short-circuit result if content has no semantic value, null otherwise. */
export function shortcircuitLowSignal(biz: BizType, content: string): ExecutionResult | null {
  // Images handled separately
  if (biz === "avatar") return null;
  const r = stripAndCount(content);
  if (r.is_pure_emoji || r.significant_chars <= 2) {
    return {
      status: "pass",
      risk_level: "safe",
      categories: [],
      reason: "内容过短或纯表情，无语义审核价值",
      provider: null,
      model: null,
      prompt_version: null,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
    };
  }
  return null;
}
```

**业务规则**：
- comment：字数 ≤ 2 时短路
- nickname：本来就短，不启用这层（昵称 "好" 可能是正常）
- bio：同 comment

---

### Layer 2：高置信广告正则黑名单（直接 reject）

```ts
// 注意：此层只应当在"几乎 100% 确信"时 reject。
// 误伤合法内容比误过广告更恶劣。

const AD_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // 微信引流高置信
  { name: "wechat_id",   re: /(微|v|威|VX|wei)\s*[信芯x]\s*[:：]?\s*[a-zA-Z][\w\-]{4,}/iu },
  // 加 VX + 账号的高置信组合
  { name: "add_wechat",  re: /(加|私|聊).{0,6}(微|v|VX|V)信?\s*[a-zA-Z0-9\-_]{5,}/iu },
  // QQ 号
  { name: "qq_number",   re: /(QQ|扣扣|企鹅)\s*[:：]?\s*[1-9]\d{4,}/iu },
  // Telegram
  { name: "telegram",    re: /(tg|Telegram|电报)\s*@?\s*[a-zA-Z][\w]{4,}/iu },
  // 高风险 TLD
  { name: "sus_tld",     re: /https?:\/\/[^\s]+\.(top|xyz|tk|ml|cc|ga|cf)(\/|$|\s)/iu },
];

export function quickRejectAd(biz: BizType, content: string): ExecutionResult | null {
  for (const p of AD_PATTERNS) {
    if (p.re.test(content)) {
      return {
        status: "reject",
        risk_level: "high",
        categories: ["ad"],
        reason: `前置规则命中：${p.name}（可疑引流）`,
        provider: null,
        model: null,
        prompt_version: null,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
      };
    }
  }
  return null;
}
```

**注意**：这些规则要定期回顾（admin UI 加入 `prefiltered_by` 字段观测），有误伤立即下掉该条规则。

---

### Layer 3：SHA-256 dedup（当前已在 pipeline 内，前移到入口）

当前 `routes/moderate.ts` 里已实现，只是发生在"已写入 `recordPending`"之后。前移到漏斗最前（在 recordPending 之前），命中即返回，不占用 D1 写入。

```ts
// 在 HMAC 验证后、recordPending 前
const contentHash = await computeContentHash(parsed.biz_type, parsed.content);
const route = resolveRoute(parsed.biz_type, app.provider_strategy);
const primaryPrompt = await loadActivePromptCached(c.env, parsed.biz_type, route.primary);
const kvKey = primaryPrompt
  ? dedupKey(parsed.biz_type, route.primary, primaryPrompt.version, contentHash)
  : null;
if (kvKey) {
  const cached = await getDedup(c.env.DEDUP_CACHE, kvKey);
  if (cached) {
    // 仍然写一条 D1 记录，但 status 已确定；不占用 queue
    const requestId = uuidv7();
    await recordPending(c.env.DB, { ... });
    await recordCompleted(c.env.DB, {
      id: requestId, cached: true, ...cached,
      input_tokens: 0, output_tokens: 0, latency_ms: 0, error_code: null,
    });
    return c.json({ request_id: requestId, cached: true, result: ... });
  }
}
```

---

## D1 观测字段

加一列 `prefiltered_by TEXT`（nullable），值：
- `null` — 没命中漏斗，正常走了模型
- `low_signal` — Layer 1 命中
- `ad:wechat_id` / `ad:qq_number` / ... — Layer 2 命中（带规则名）
- `cache` — Layer 3 命中

Admin Stats 页新增面板：
```
前置漏斗拦截率（过去 24h）
┌──────────────┬────────┬──────────┐
│ 层             │ 命中数 │ 占比     │
├──────────────┼────────┼──────────┤
│ low_signal    │  3,214 │  12.4%  │
│ ad:wechat    │    891 │   3.4%  │
│ ad:telegram  │    103 │   0.4%  │
│ cache        │ 11,207 │  43.3%  │
│ (未命中)      │ 10,461 │  40.5%  │ ← 只有这 40% 打了 Grok
└──────────────┴────────┴──────────┘
```

---

## 实施步骤

1. 新建 `src/moderation/prefilter.ts`
2. migration 0005 加 `prefiltered_by TEXT`
3. `routes/moderate.ts` 里在 `recordPending` 之前插入漏斗
4. 头像不过 Layer 1 / 2，只过 Layer 3（dedup）
5. 单元测试：
   - 纯 emoji → pass
   - "微信 abc12345" → reject ad
   - 正常文本 → 继续 pipeline
   - "17 岁未成年" 相关 → 继续 pipeline（不在正则黑名单里，让模型判）
6. 回归测试：全量 dev 环境历史文本重放，看误伤率

---

## 节省估算

对"一起看"类平台：
- 空/短内容 ~10%
- 缓存命中 ~20-40%
- 广告正则命中 ~3-5%

合计 **33-55% 的请求无需打 Grok**。

按月 100 万次审核、Grok 单次平均 $0.0008 算：
- 之前 1M × $0.0008 = **$800/月**
- 漏斗后 500K × $0.0008 = **$400/月**

每月节省 $400，年度 $4800。
