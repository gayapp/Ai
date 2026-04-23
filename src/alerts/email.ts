/**
 * Email 告警（Resend 集成，可选）
 *
 * 仅当 env.RESEND_API_KEY + env.ALERT_EMAIL 都配置时激活；否则 no-op。
 * Resend 免费档：100 封/月，对告警场景绰绰有余。
 * 注册 → https://resend.com → API Keys → 拿 key
 * 然后 wrangler secret put RESEND_API_KEY / ALERT_EMAIL
 */

export interface EmailAlert {
  subject: string;
  text: string;      // plain-text body
  html?: string;     // optional rich body
}

export async function sendAlertEmail(env: Env, alert: EmailAlert): Promise<boolean> {
  const key = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL;
  if (!key || !to) return false;
  const from = env.ALERT_EMAIL_FROM || "ai-guard <alerts@resend.dev>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: alert.subject,
        text: alert.text,
        ...(alert.html ? { html: alert.html } : {}),
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.warn("[email] resend http", res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[email] failed", e instanceof Error ? e.message : e);
    return false;
  }
}
