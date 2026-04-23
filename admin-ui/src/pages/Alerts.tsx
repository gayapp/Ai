import { useState } from "react";
import { Alerts } from "../lib/api";

export default function AlertsPage() {
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(kind: "test" | "check") {
    setErr(null); setBusy(true); setResult(null);
    try {
      const r = kind === "test" ? await Alerts.test() : await Alerts.check();
      setResult(r);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <h1 className="page-title">告警</h1>
      <p className="page-sub">错误率 &gt; 5% 或延迟异常时，Cron 每 5 分钟自动推送到 Telegram。</p>

      <div className="card">
        <h3>配置步骤</h3>
        <ol>
          <li>
            找 <code>@BotFather</code> 创建 Bot，拿到 <code>TELEGRAM_BOT_TOKEN</code>（<code>123456:ABC-DEF...</code>）
          </li>
          <li>
            发消息给你的 Bot，访问 <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> 拿 <code>TELEGRAM_CHAT_ID</code>
            （或把 Bot 拉进群组，群组 ID 一般是负数）
          </li>
          <li>
            <pre>{`wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID`}</pre>
          </li>
          <li>
            点下面"测试"按钮；如果收到消息 = OK。
          </li>
        </ol>
      </div>

      <div className="card">
        <h3>当前阈值（写在代码里 src/alerts/telegram.ts）</h3>
        <ul>
          <li>时间窗口：最近 5 分钟</li>
          <li>最小样本：≥ 20 条请求才判定</li>
          <li>错误率告警：<code>errorRatePct &gt;= 5%</code>（≥20% 升级为 crit）</li>
          <li>延迟告警：<code>maxLatencyMs &gt;= 15000</code></li>
          <li>去重窗口：5 分钟（防刷屏）</li>
        </ul>
      </div>

      <div className="card">
        <h3>操作</h3>
        <button className="btn" disabled={busy} onClick={() => send("test")}>发送测试消息</button>{" "}
        <button className="btn secondary" disabled={busy} onClick={() => send("check")}>立即跑一次阈值检查</button>
        {err && <div className="error mt16">{err}</div>}
        {result && (
          <pre className="mt16">{JSON.stringify(result, null, 2)}</pre>
        )}
      </div>
    </>
  );
}
