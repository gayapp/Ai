import { completeAnalyze, getAnalyzeById } from "../../db/analyze-requests.ts";
import { ErrorCodes } from "../../lib/errors.ts";
import type { AnalyzeJob } from "../types.ts";
import { executeMediaAnalysis } from "./media-analysis.ts";
import { executeMediaIntro } from "./media-intro.ts";

export async function dispatchAnalyzeJob(env: Env, job: AnalyzeJob): Promise<void> {
  const row = await getAnalyzeById(env.DB, job.request_id);
  if (!row) {
    console.warn("[analyze-queue] request not found", job.request_id);
    return;
  }
  if (row.status !== "pending") {
    return;
  }

  if (row.biz_type === "media_analysis") {
    await executeMediaAnalysis(env, row);
  } else if (row.biz_type === "media_intro") {
    await executeMediaIntro(env, row);
  } else {
    await completeAnalyze(env.DB, {
      id: job.request_id,
      cached: false,
      status: "error",
      result_json: null,
      provider: null,
      model: null,
      prompt_version: null,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      error_code: "not_implemented",
    });
  }

  if (row.delivery_mode === "callback" || row.delivery_mode === "both") {
    await env.CALLBACK_QUEUE.send({ request_id: job.request_id, attempt: 0 });
  }
}

export function analyzeErrorMessage(errorCode: string | null): string {
  switch (errorCode) {
    case "not_implemented":
      return "Analyze biz_type is not implemented yet.";
    case ErrorCodes.INVALID_REQUEST:
      return "Analyze request is invalid.";
    case ErrorCodes.UNSUPPORTED_CONTENT:
      return "Analyze input content is unsupported.";
    case ErrorCodes.PROVIDER_ERROR:
      return "Analyze provider returned an error.";
    case ErrorCodes.PROVIDER_TIMEOUT:
      return "Analyze provider timed out.";
    case ErrorCodes.PROVIDER_AUTH_FAILED:
      return "Analyze provider authentication failed.";
    case ErrorCodes.SYNC_TIMEOUT:
      return "Analyze synchronous request timed out and should be retried asynchronously.";
    case ErrorCodes.SCHEMA_VALIDATION_FAILED:
      return "Analyze provider returned data that failed schema validation.";
    default:
      return errorCode ? `Analyze failed: ${errorCode}` : "Analyze failed.";
  }
}
