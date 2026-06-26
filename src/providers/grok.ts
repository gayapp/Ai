import { AppError, ErrorCodes } from "../lib/errors.ts";
import type { ProviderAdapter, ProviderCallArgs, ProviderResult } from "./router.ts";

const GROK_URL = "https://api.x.ai/v1/chat/completions";

const STRUCTURE_SUFFIX =
  `请严格以 JSON 返回：{"status":"pass|reject|review","risk_level":"safe|low|medium|high","categories":["politics"|"porn"|"abuse"|"ad"|"spam"|"violence"|"other"],"reason":"简短原因"}`;

// post 多图/视频帧：在 verdict 之外要求模型逐类产出 labels（是否有X + 是什么）。
// 6 类零容忍(csam/ad/drug/gambling/politics) + minor_face + 描述性 nsfw。
const POST_STRUCTURE_SUFFIX =
  `这是社区帖子（标题/正文 + 多张图片或视频抽帧），请综合全部文字与图片给出一个整体结论。\n` +
  `请严格以 JSON 返回：{"status":"pass|reject|review","risk_level":"safe|low|medium|high","categories":["politics"|"porn"|"abuse"|"ad"|"spam"|"violence"|"other"],"reason":"简短中文原因",` +
  `"labels":[{"category":"minor_face|csam|ad|drug|gambling|politics|id_document|nsfw","detected":true|false,"confidence":0~1,"evidence":"中文说明命中位置/是什么，未命中留空"}]}\n` +
  `labels 必须覆盖全部 8 个 category 各一条。`;

export function createGrokAdapter(env: Env): ProviderAdapter {
  return {
    id: "grok",
    async moderate(args: ProviderCallArgs): Promise<ProviderResult> {
      const apiKey = env.GROK_API_KEY;
      if (!apiKey) {
        throw new AppError(ErrorCodes.PROVIDER_ERROR, 500, "GROK_API_KEY not configured");
      }
      // 文本 biz_type 走 fast-non-reasoning；avatar/image 走 vision-capable 模型（默认 grok-4）。
      // GROK_VISION_MODEL 单独配置允许独立调整。
      const textModel = env.GROK_MODEL || "grok-4-fast-non-reasoning";
      const visionModel = (env as { GROK_VISION_MODEL?: string }).GROK_VISION_MODEL || "grok-4";
      const hasMultiImage = !!args.imageUrls && args.imageUrls.length > 0;
      // 带图（avatar 单图 / post 多图）走 vision 模型；纯文字走快模型。
      const model = args.isImage || hasMultiImage ? visionModel : textModel;
      const startedAt = Date.now();
      let userContent: unknown;
      let structureSuffix: string;
      if (hasMultiImage) {
        // post：文字(可选) + N 张图 + 审核指令；整组综合一个结论 + labels。
        const blocks: unknown[] = [];
        if (args.content.trim().length > 0) {
          blocks.push({ type: "text", text: args.content });
        }
        for (const url of args.imageUrls!) {
          blocks.push({ type: "image_url", image_url: { url, detail: "high" } });
        }
        blocks.push({ type: "text", text: "请综合以上帖子的文字与全部图片，按规则审核。" });
        userContent = blocks;
        structureSuffix = POST_STRUCTURE_SUFFIX;
      } else if (args.isImage) {
        // avatar：单张图片 URL 即 content。
        userContent = [
          { type: "image_url", image_url: { url: args.content, detail: "high" } },
          { type: "text", text: "Moderate this image per the rules above." },
        ];
        structureSuffix = STRUCTURE_SUFFIX;
      } else {
        userContent = args.content;
        structureSuffix = STRUCTURE_SUFFIX;
      }
      const body = {
        model,
        messages: [
          { role: "system", content: `${args.systemPrompt}\n\n${structureSuffix}` },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      };

      let res: Response;
      try {
        res = await fetch(GROK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(args.timeoutMs),
        });
      } catch (e) {
        if (e instanceof Error && e.name === "TimeoutError") {
          throw new AppError(ErrorCodes.PROVIDER_TIMEOUT, 504, "grok timeout");
        }
        throw new AppError(
          ErrorCodes.PROVIDER_ERROR,
          502,
          `grok fetch: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const text = await safeText(res);
        // xAI 对「输入内容」做安全前置检查；命中(如 CSAM)直接 403 permission-denied，
        //   body 含 "Failed check: SAFETY_CHECK_TYPE_*"，且**不返回**模型结论。
        //   这是「内容违规」而非「鉴权失败」：必须 fail-closed 判 reject，且绝不能走
        //   AUTH_FAILED——否则一条 CSAM 评论就会被误判成 key 失效，触发凭证告警 + 熔断拉闸全站。
        const block = classifyXaiSafetyBlock(res.status, text);
        if (block) {
          const verdict: Record<string, unknown> = {
            status: "reject",
            risk_level: "high",
            categories: [block.category],
            reason: block.reason,
          };
          // post/avatar 走 labels 契约时补一条命中标签（仅已知类型，如 csam）。
          if (block.labelCategory && (args.isImage || hasMultiImage)) {
            verdict.labels = [
              { category: block.labelCategory, detected: true, confidence: 1, evidence: block.reason },
            ];
          }
          return {
            rawText: JSON.stringify(verdict),
            model,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs,
          };
        }
        // 401/403 = key 无效 / 被禁 / 没权限 — 升级为 AUTH_FAILED。
        // xAI 还会把「无效 API key」返成 400 invalid-argument（body 含 "Incorrect API key"），
        // 同样视为鉴权失败，否则 key 真失效时只标 PROVIDER_ERROR、不触发凭证告警 + 熔断。
        const isAuthFail =
          res.status === 401 ||
          res.status === 403 ||
          (res.status === 400 && /api key/i.test(text));
        if (isAuthFail) {
          throw new AppError(
            ErrorCodes.PROVIDER_AUTH_FAILED,
            502,
            `grok auth failed (http ${res.status})`,
            text.slice(0, 500),
          );
        }
        throw new AppError(
          ErrorCodes.PROVIDER_ERROR,
          502,
          `grok http ${res.status}`,
          text.slice(0, 500),
        );
      }
      const data = (await res.json()) as GrokResponse;
      const rawText = data.choices?.[0]?.message?.content ?? "";
      return {
        rawText,
        model: data.model ?? model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs,
      };
    },
  };
}

interface GrokResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * 识别 xAI 输入安全检查拦截（403 permission-denied，body 含 SAFETY_CHECK_TYPE_*）。
 * 与鉴权失败区分：命中返回 fail-closed reject 的分类；未命中返回 null（交回原 auth/error 分类）。
 * 实测 body 形如：{"code":"permission-denied","error":"Content violates usage guidelines. ...
 *   Failed check: SAFETY_CHECK_TYPE_CSAM"}
 * `category` 取 schema 的 Category 值，`labelCategory` 取 LabelCategory 值（无对应则 null）。
 */
export function classifyXaiSafetyBlock(
  status: number,
  body: string,
): { category: string; labelCategory: string | null; reason: string } | null {
  if (status !== 403) return null;
  if (!/permission-denied|content violates usage guidelines|SAFETY_CHECK_TYPE/i.test(body)) {
    return null;
  }
  const type = body.match(/SAFETY_CHECK_TYPE_([A-Z_]+)/)?.[1] ?? "UNKNOWN";
  if (type === "CSAM") {
    return { category: "porn", labelCategory: "csam", reason: "上游安全检查拦截：疑似 CSAM（未成年性化）" };
  }
  return { category: "other", labelCategory: null, reason: `上游安全检查拦截：${type}` };
}
