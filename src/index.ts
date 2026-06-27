import { Hono } from "hono";
import archHtml from "../docs/architecture.html";
import { AppError, ErrorCodes } from "./lib/errors.ts";
import { checkAndAlert, checkD1SizeAndAlert, sendTelegramAlert, sendWeeklyHeartbeat } from "./alerts/telegram.ts";
import { checkProviderHealth } from "./alerts/provider-health.ts";
import { moderateRouter } from "./routes/moderate.ts";
import { analyzeRouter } from "./routes/analyze.ts";
import { analyzeRecordsRouter } from "./routes/analyze-records.ts";
import { adminAuditRouter } from "./routes/admin-audit.ts";
import { adminAnalyzeBackpressureCanaryRouter } from "./routes/admin-analyze-backpressure-canary.ts";
import { adminAppsRouter } from "./routes/admin-apps.ts";
import { adminAnalyzeRecordsRouter } from "./routes/admin-analyze-records.ts";
import { adminPromptRegressionRouter } from "./routes/admin-prompt-regression.ts";
import { adminPromptsRouter } from "./routes/admin-prompts.ts";
import { adminProvidersRouter } from "./routes/admin-providers.ts";
import { adminStatsRouter } from "./routes/admin-stats.ts";
import { executeModeration } from "./moderation/pipeline.ts";
import {
  computeContentHash,
  dedupKey,
  getDedup,
  putDedup,
} from "./moderation/dedup.ts";
import {
  loadActivePromptCached,
  loadAppCached,
  recordCompleted,
  getModerationById,
  recordPending,
  setEvidenceKey,
} from "./db/queries.ts";
import { resolveRoute } from "./providers/router.ts";
import { CachedResult, requestIsImage } from "./moderation/schema.ts";
import { processCallback, sweepAnalyzeCallbackDeliveries } from "./callback/dispatcher.ts";
import { saveAvatarEvidence } from "./evidence/r2.ts";
import { sweepModerationPending } from "./moderation/pending-sweep.ts";
import { rollupYesterday } from "./stats/rollup.ts";
import { PENDING_COUNT_KV_KEY, PENDING_COUNT_KV_TTL_SECONDS } from "./analyze/backpressure.ts";
import { sweepAnalyzePending } from "./analyze/pending-sweep.ts";
import { dispatchAnalyzeJob } from "./analyze/pipeline/dispatcher.ts";
import type { AnalyzeJob } from "./analyze/types.ts";
import type { CallbackJob, ModerationJob } from "./moderation/types.ts";

// ==========================================================
// HTTP router
// ==========================================================
const app = new Hono<{ Bindings: Env }>({ strict: false });

// CORS for Admin UI (aicenter.gv.live) + public /v1 API
app.use("*", async (c, next): Promise<Response | void> => {
  const origin = c.req.header("origin");
  const allowed = new Set([
    "https://aicenter.1.gay",
    "https://ai-guard-admin.pages.dev",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
  const allowOrigin = origin && allowed.has(origin) ? origin : "";
  if (allowOrigin) {
    c.header("access-control-allow-origin", allowOrigin);
    c.header("access-control-allow-credentials", "true");
    c.header("vary", "origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    c.header(
      "access-control-allow-headers",
      "authorization, content-type, x-app-id, x-timestamp, x-nonce, x-signature",
    );
    c.header("access-control-max-age", "86400");
    return c.body(null, 204);
  }
  await next();
  return;
});

app.get("/", (c) => c.text("ai-guard — see /architecture\n"));
app.get("/health", (c) =>
  c.json({ ok: true, ts: new Date().toISOString(), version: "0.1.0" }),
);
app.get("/architecture", (c) =>
  c.html(archHtml, 200, {
    "cache-control": "public, max-age=300",
  }),
);

app.route("/", moderateRouter);
app.route("/", analyzeRouter);
app.route("/", analyzeRecordsRouter);
app.route("/admin/audit", adminAuditRouter);
app.route("/admin/analyze-backpressure-canary", adminAnalyzeBackpressureCanaryRouter);
app.route("/admin/apps", adminAppsRouter);
app.route("/admin/analyze-records", adminAnalyzeRecordsRouter);
app.route("/admin/prompt-regression", adminPromptRegressionRouter);
app.route("/admin/prompts", adminPromptsRouter);
app.route("/admin/providers", adminProvidersRouter);
app.route("/admin/stats", adminStatsRouter);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.status as 400 | 401 | 403 | 404 | 500);
  }
  // zod parse errors — 不把 issues（含字段路径/校验规则等实现细节）回传客户端，仅记日志
  if (err && typeof err === "object" && "issues" in err) {
    console.warn("[validation]", JSON.stringify((err as { issues: unknown }).issues));
    return c.json(
      { error_code: ErrorCodes.INVALID_REQUEST, message: "validation failed" },
      400,
    );
  }
  console.error("[unhandled]", err);
  return c.json(
    { error_code: ErrorCodes.INTERNAL, message: "internal error" },
    500,
  );
});

// ==========================================================
// Queue consumers
// ==========================================================
async function handleModerationQueue(
  batch: MessageBatch<ModerationJob>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body;
    try {
      await runAsyncModeration(env, job);
      msg.ack();
    } catch (e) {
      console.error("[moderation-queue] failed", job.request_id, e);
      msg.retry({ delaySeconds: 30 });
    }
  }
}

async function runAsyncModeration(env: Env, job: ModerationJob): Promise<void> {
  const existing = await getModerationById(env.DB, job.request_id);
  const imageUrls = job.image_urls ?? undefined;
  if (!existing) {
    await recordPending(env.DB, {
      id: job.request_id,
      app_id: job.app_id,
      biz_type: job.biz_type,
      biz_id: job.biz_id,
      user_id: job.user_id,
      content_hash: await computeContentHash(job.biz_type, job.content, imageUrls),
      content_text: job.content,
      mode: "async",
      extra: job.extra ?? null,
      callback_url: job.callback_url,
      prefiltered_by: null,
      image_urls: job.image_urls ?? null,
    });
  }

  const isImage = requestIsImage(job.biz_type, imageUrls);
  const contentHash =
    existing?.content_hash ?? (await computeContentHash(job.biz_type, job.content, imageUrls));

  // Load app config to honor provider strategy
  const app = await loadAppCached(env, job.app_id);
  const strategy = app?.provider_strategy ?? "auto";

  // Dedup check (again — KV may have populated since request acceptance)
  const route = resolveRoute(job.biz_type, strategy);
  const primaryPrompt = await loadActivePromptCached(env, job.biz_type, route.primary);
  const kvKey = primaryPrompt ? dedupKey(job.biz_type, route.primary, primaryPrompt.version, contentHash) : null;
  if (kvKey) {
    const cached = await getDedup(env.DEDUP_CACHE, kvKey);
    if (cached) {
      await recordCompleted(env.DB, {
        id: job.request_id,
        cached: true,
        status: cached.status,
        risk_level: cached.risk_level,
        categories: cached.categories,
        reason: cached.reason,
        provider: cached.provider,
        model: cached.model,
        prompt_version: cached.prompt_version,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        error_code: null,
      });
      await env.CALLBACK_QUEUE.send({ request_id: job.request_id, attempt: 0 });
      return;
    }
  }

  const timeoutMs = parseInt(env.SYNC_TIMEOUT_MS || "10000", 10);
  try {
    const result = await executeModeration(env, {
      bizType: job.biz_type,
      content: job.content,
      isImage,
      imageUrls,
      timeoutMs: Math.max(timeoutMs, 25_000), // give async a bit more
      strategy,
    });
    await recordCompleted(env.DB, {
      id: job.request_id,
      cached: false,
      status: result.status,
      risk_level: result.risk_level,
      categories: result.categories,
      reason: result.reason,
      provider: result.provider,
      model: result.model,
      prompt_version: result.prompt_version,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      latency_ms: result.latency_ms,
      error_code: result.error_code ?? null,
      labels: result.labels ?? null,
    });
    if (kvKey && result.status !== "error") {
      const cacheable = CachedResult.parse({
        status: result.status,
        risk_level: result.risk_level,
        categories: result.categories,
        reason: result.reason,
        provider: result.provider,
        model: result.model,
        prompt_version: result.prompt_version,
        labels: result.labels,
      });
      const ttl = parseInt(env.DEDUP_TTL_SECONDS || "604800", 10);
      await putDedup(env.DEDUP_CACHE, kvKey, cacheable, ttl);
    }
    // R2 evidence 保存 — 方案 A 合规策略下默认关闭（env.SAVE_EVIDENCE !== "true"）
    //   关闭：平台不在自己 CF 账号下保存头像原图，规避 CSAM 合规风险
    //   启用：配合 Dashboard 里 R2 的 CSAM 扫描使用（见 docs/optimization/csam-scan-setup.md）
    //   仅 avatar：saveAvatarEvidence 存的是单张头像 URL；post 多图/帧不走此路径。
    if (
      job.biz_type === "avatar" &&
      !existing?.evidence_key &&
      result.status !== "error" &&
      env.SAVE_EVIDENCE === "true"
    ) {
      const ev = await saveAvatarEvidence(env.EVIDENCE, job.request_id, job.content);
      if (ev) await setEvidenceKey(env.DB, job.request_id, ev.key);
    }
  } catch (e) {
    const code = e instanceof AppError ? e.code : ErrorCodes.INTERNAL;
    const msg = e instanceof Error ? e.message : String(e);
    await recordCompleted(env.DB, {
      id: job.request_id,
      cached: false,
      status: "error",
      risk_level: null,
      categories: [],
      reason: msg.slice(0, 256),
      provider: null,
      model: null,
      prompt_version: null,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      error_code: code,
    });
  }

  await env.CALLBACK_QUEUE.send({ request_id: job.request_id, attempt: 0 });
}

async function handleCallbackQueue(
  batch: MessageBatch<CallbackJob>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processCallback(env, msg.body);
      msg.ack();
    } catch (e) {
      console.warn("[callback-queue] failed", msg.body.request_id, e);
      msg.ack(); // dispatcher already re-enqueues with delay; don't double-retry
    }
  }
}

async function handleAnalyzeQueue(
  batch: MessageBatch<AnalyzeJob>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await dispatchAnalyzeJob(env, msg.body);
      msg.ack();
    } catch (e) {
      console.error("[analyze-queue] failed", msg.body.request_id, e);
      msg.retry({ delaySeconds: 30 });
    }
  }
}

// ==========================================================
// Scheduled (MVP: simple hourly KV cleanup — stats rollup to be added)
// ==========================================================
async function scheduled(ev: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const cron = ev.cron;

  // provider-health 每 5 分钟跑一次 —— team_blocked / key disabled 这种根因故障
  // 越早暴露越好，以前 xx:00 hourly 的方案有 26 min 检测盲区（事故 2026-05-26）。
  // dedup 由 sendTelegramAlert 自身的 dedupKey/TTL 控制，5min 节奏不会刷屏。
  if (cron === "*/5 * * * *") {
    try {
      const r = await checkProviderHealth(env);
      console.log("[scheduled] provider health:", JSON.stringify({ grok: r.grok.ok, grokReason: r.grok.reason, grokDetail: r.grok.detail, gemini: r.gemini.ok, fired: r.fired }));
    } catch (e) {
      console.warn("[scheduled] provider health failed", e);
    }
  }

  // 每 5 分钟扫尾：把 > 5 分钟仍 pending 的行标为 error
  // （防止 Worker 被意外终止留下残单）
  if (cron === "*/5 * * * *") {
    try {
      const r = await sweepModerationPending(env);
      if (r.swept > 0) {
        console.log(
          `[scheduled] sweep: marked ${r.swept} pending rows as error, ` +
          `callback_enqueued=${r.callbackEnqueued}, alert_sent=${r.alertSent}`,
        );
      }
    } catch (e) {
      console.warn("[scheduled] sweep failed", e);
    }

    try {
      const r = await sweepAnalyzePending(env);
      if (r.enqueued > 0 || r.failed > 0 || r.expired > 0) {
        console.log(
          `[scheduled] analyze pending sweep: scanned=${r.scanned}, ` +
          `enqueued=${r.enqueued}, expired=${r.expired}, failed=${r.failed}`,
        );
      }
    } catch (e) {
      console.warn("[scheduled] analyze pending sweep failed", e);
    }

    try {
      const r = await sweepAnalyzeCallbackDeliveries(env);
      if (r.enqueued > 0 || r.failed > 0) {
        console.log(
          `[scheduled] analyze callback sweep: scanned=${r.scanned}, ` +
          `enqueued=${r.enqueued}, failed=${r.failed}`,
        );
      }
    } catch (e) {
      console.warn("[scheduled] analyze callback sweep failed", e);
    }

    // M3: pending pool count → NONCE KV，入口背压用。
    //   每 5min 刷一次，避免每请求 SELECT COUNT(*) 拉延迟。TTL 稍长于 cron 节奏，容忍调度抖动。
    try {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM analyze_requests WHERE status = 'pending'`,
      ).first<{ n: number }>();
      const n = row?.n ?? 0;
      await env.NONCE.put(PENDING_COUNT_KV_KEY, String(n), {
        expirationTtl: PENDING_COUNT_KV_TTL_SECONDS,
      });
      console.log(`[scheduled] analyze pending count = ${n}`);
    } catch (e) {
      console.warn("[scheduled] analyze pending count write failed", e);
    }
  }

  // "5 0 * * *" — daily cleanup + rollup
  if (cron === "5 0 * * *") {
    // Cleanup old records. 每步独立 try/catch——D1 大表 DELETE 偶发 timeout/transient
    // 不能把后续 rollup + heartbeat 一起拖死（事故 2026-05-31：stats_rollup 缺两天）。
    //
    // 保留策略（2026-06-15 起）：
    // - moderation_requests / callback_deliveries：90d（运维排查需要较长窗口）
    // - analyze_requests：60d（IRC 单日 9k-43k 条、avg 2.9KB/行，大字段拖 D1 增速 80MB/day）
    //   IRC 业务侧持久任务表已自行保留，60d 足够 ai-guard 侧追溯
    const cutoff90d = Date.now() - 90 * 24 * 3600 * 1000;
    const cutoffAnalyze = Date.now() - 60 * 24 * 3600 * 1000;
    try {
      await env.DB.prepare(`DELETE FROM moderation_requests WHERE created_at < ?`).bind(cutoff90d).run();
    } catch (e) {
      console.warn("[scheduled] cleanup moderation_requests failed", e);
    }
    try {
      await env.DB.prepare(`DELETE FROM callback_deliveries WHERE created_at < ?`).bind(cutoff90d).run();
    } catch (e) {
      console.warn("[scheduled] cleanup callback_deliveries failed", e);
    }
    try {
      await env.DB.prepare(`DELETE FROM analyze_requests WHERE created_at < ?`).bind(cutoffAnalyze).run();
    } catch (e) {
      console.warn("[scheduled] cleanup analyze_requests failed", e);
    }
    // Aggregate yesterday into stats_rollup
    try {
      const r = await rollupYesterday(env.DB);
      console.log("[scheduled] rollup:", JSON.stringify(r));
    } catch (e) {
      console.warn("[scheduled] rollup failed", e);
    }
    try {
      const ok = await sendWeeklyHeartbeat(env);
      if (ok) console.log("[scheduled] weekly heartbeat sent");
    } catch (e) {
      console.warn("[scheduled] heartbeat failed", e);
    }
    // M28: 监控 D1 size 24h 涨速。首次跑只记 snapshot，第二次起开始对比告警。
    try {
      const r = await checkD1SizeAndAlert(env);
      console.log("[scheduled] d1 size:", r.checks.join(" | "), "fired:", r.fired.join(","));
    } catch (e) {
      console.warn("[scheduled] d1 size check failed", e);
    }
    return;
  }

  // "*/5 * * * *" — periodic alert check
  try {
    const r = await checkAndAlert(env);
    console.log("[scheduled] alert check:", r.checks.join(" | "), "fired:", r.fired.join(","));
  } catch (e) {
    console.warn("[scheduled] alert check failed", e);
  }
}

// Expose a manual "test alert" endpoint for admins
app.post("/admin/alerts/test", async (c) => {
  const { verifyAdmin } = await import("./auth/hmac.ts");
  verifyAdmin(c.env, c.req.raw.headers);
  const ok = await sendTelegramAlert(
    c.env,
    {
      title: "ai-guard · 告警自检",
      level: "info",
      lines: [
        "这是一条手动触发的测试消息。",
        "如果你收到此消息，说明 Telegram 告警已配置成功。",
      ],
      dedupKey: `test-${Math.floor(Date.now() / 60000)}`,
    },
    c.env.DEDUP_CACHE,
  );
  return c.json({
    sent: ok,
    bot_configured: !!c.env.TELEGRAM_BOT_TOKEN,
    chat_configured: !!c.env.TELEGRAM_CHAT_ID,
  });
});

app.post("/admin/alerts/check", async (c) => {
  const { verifyAdmin } = await import("./auth/hmac.ts");
  verifyAdmin(c.env, c.req.raw.headers);
  await sweepAnalyzePending(c.env);
  await sweepAnalyzeCallbackDeliveries(c.env);
  const r = await checkAndAlert(c.env);
  return c.json(r);
});

app.post("/admin/alerts/provider-health", async (c) => {
  const { verifyAdmin } = await import("./auth/hmac.ts");
  verifyAdmin(c.env, c.req.raw.headers);
  const r = await checkProviderHealth(c.env);
  return c.json(r);
});

// ==========================================================
// Worker export
// ==========================================================
const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  async queue(batch, env) {
    if (batch.queue.endsWith("moderation")) {
      await handleModerationQueue(batch as unknown as MessageBatch<ModerationJob>, env);
    } else if (batch.queue.endsWith("analyze")) {
      await handleAnalyzeQueue(batch as unknown as MessageBatch<AnalyzeJob>, env);
    } else if (batch.queue.endsWith("callback")) {
      await handleCallbackQueue(batch as unknown as MessageBatch<CallbackJob>, env);
    } else {
      console.warn("[queue] unknown queue", batch.queue);
    }
  },
  scheduled,
};

export default handler;
