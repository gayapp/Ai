/**
 * Edge pre-filter funnel — P1.1 实现
 *
 * 在 HMAC 校验通过后、provider 调用前执行，分三层：
 *   L1 低信噪 (short-circuit pass)：纯 emoji / 字符数 <= 2 / 空 -> 直接 pass，不打模型
 *   L2 高置信广告黑名单 (short-circuit reject)：明确的联系方式 -> reject "ad"
 *   L3 内容 SHA-256 dedup 命中（由 pipeline 里的 dedup 逻辑负责）
 *
 * 每条命中都会 log 到 D1 moderation_requests.prefiltered_by 字段。
 */

import type { BizType, ExecutionResult } from "./schema.ts";

// ---- L1: 低信噪内容剥离 + 统计 ----
// 零宽/双向控制字符：U+200B-200F, U+2028-202F, U+2060-206F, U+180E, U+FEFF
const ZERO_WIDTH_RE =
  /[\u{200B}-\u{200F}\u{2028}-\u{202F}\u{2060}-\u{206F}\u{180E}\u{FEFF}]/gu;
// Emoji（含 skin-tone modifier + ZWJ (U+200D) 组合序列 + flag）
const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:\u{200D}[\p{Extended_Pictographic}\p{Emoji_Presentation}])*(?:\p{Emoji_Modifier})?|[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const MARKS_RE = /\p{M}/gu;
const PUNCT_RE = /[\p{P}\p{S}\s]/gu;

export interface StripStats {
  original: string;
  strippedText: string;
  significantChars: number;
  hadZeroWidth: boolean;
  wasEffectivelyEmojiOnly: boolean;
}

export function stripContent(s: string): StripStats {
  const noZW = s.replace(ZERO_WIDTH_RE, "");
  const hadZW = noZW !== s;
  const noEmoji = noZW.replace(EMOJI_RE, "");
  const clean = noEmoji.replace(MARKS_RE, "").trim();
  const significant = clean.replace(PUNCT_RE, "").length;
  const wasEmojiOnly = noZW !== noEmoji && significant === 0;
  return {
    original: s,
    strippedText: clean,
    significantChars: significant,
    hadZeroWidth: hadZW,
    wasEffectivelyEmojiOnly: wasEmojiOnly,
  };
}

// ---- L2: 高置信广告黑名单正则 ----
interface AdRule {
  name: string;
  re: RegExp;
}

export const AD_RULES: AdRule[] = [
  // 微信号：微/v/威 + 信/芯/x (+号/群/名 等) + 5+ 位字母开头账号
  {
    name: "wechat_v_signal",
    re: /(微|威|[vV][iI]?)\s*[信芯xX]+[\s一-鿿:：]{0,6}[a-zA-Z][\w\-]{4,}/u,
  },
  // 加V/加微 + 账号
  {
    name: "add_wechat",
    re: /(加|私|聊).{0,4}(微|v|V|威|VX|vx)[信芯xX]?\s*[a-zA-Z0-9\-_]{5,}/iu,
  },
  // QQ 号（5-12 位数字，前有 QQ/扣扣/企鹅/🐧 标识）
  {
    name: "qq_number",
    re: /(QQ|qq|扣扣|企鹅|\u{1F427})\s*[:：]?\s*[1-9]\d{4,11}/u,
  },
  // 手机号（11 位，1 开头，常见运营商号段）
  { name: "phone_cn", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  // Telegram/电报 + ID
  {
    name: "telegram",
    re: /(tg|TG|telegram|Telegram|电报)\s*[@:：]?\s*[a-zA-Z][\w]{4,}/u,
  },
  // 高风险 TLD
  {
    name: "sus_tld",
    re: /https?:\/\/[^\s]+\.(top|xyz|tk|ml|cc|ga|cf)(\/|$|\s|[^a-z])/iu,
  },
  // 明确商业意图词（针对昵称/简介常见）
  {
    name: "business_intent",
    re: /(加\s*V|加\s*威|看\s*主\s*页|门\s*槛|出\s*肉|接\s*单|见\s*面\s*费|见\s*m|上\s*门|包\s*夜|包\s*天)/u,
  },
  // 外部平台 + 引流动作
  {
    name: "platform_lead",
    re: /(推特|twitter|Twitter|ins|Ins|INS|小红书|B站|抖音|O站|onlyfans|OnlyFans)\s*(同名|关注|搜我|账号|ID|id)/u,
  },
];

export interface PrefilterOutcome {
  kind: "pass_lowsignal" | "reject_ad" | "skip";
  result: ExecutionResult | null;
  tag: string | null;
}

/** 对单条请求跑前置漏斗。不命中则返回 skip，继续走 pipeline。 */
export function applyPrefilter(biz: BizType, content: string): PrefilterOutcome {
  // 头像不过 L1 / L2（图片审核不适用文本正则）
  if (biz === "avatar") return { kind: "skip", result: null, tag: null };

  // ---- L1 ----
  const s = stripContent(content);
  const lowSigThreshold = biz === "nickname" ? 0 : 2;
  if (s.wasEffectivelyEmojiOnly || s.significantChars <= lowSigThreshold) {
    return {
      kind: "pass_lowsignal",
      result: {
        status: "pass",
        risk_level: "safe",
        categories: [],
        reason: s.wasEffectivelyEmojiOnly
          ? "纯表情，无语义审核价值"
          : "内容过短/为空，无语义审核价值",
        provider: null,
        model: null,
        prompt_version: null,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
      },
      tag: "low_signal",
    };
  }

  // ---- L2 ----
  for (const rule of AD_RULES) {
    if (rule.re.test(content)) {
      return {
        kind: "reject_ad",
        result: {
          status: "reject",
          risk_level: "high",
          categories: ["ad"],
          reason: `前置规则命中：${rule.name}（可疑引流/广告）`,
          provider: null,
          model: null,
          prompt_version: null,
          input_tokens: 0,
          output_tokens: 0,
          latency_ms: 0,
        },
        tag: `ad:${rule.name}`,
      };
    }
  }

  return { kind: "skip", result: null, tag: null };
}
