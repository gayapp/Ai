import { useEffect, useState } from "react";
import {
  Stats,
  type AnalyzeSummaryData,
  type ModerationRow,
  type SummaryData,
} from "../lib/api";
import { formatBytes, RequestRow, StatusPill } from "../components/common";

type Track = "overview" | "moderate" | "analyze";

export default function Dashboard() {
  const [track, setTrack] = useState<Track>("overview");
  const [period, setPeriod] = useState<"1h" | "24h" | "7d">("24h");
  const [sum, setSum] = useState<SummaryData | null>(null);
  const [analyzeSum, setAnalyzeSum] = useState<AnalyzeSummaryData | null>(null);
  const [recent, setRecent] = useState<ModerationRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { load(); }, [period]);

  async function load() {
    setErr(null);
    const now = Date.now();
    const hours = period === "1h" ? 1 : period === "24h" ? 24 : 24 * 7;
    const from = new Date(now - hours * 3600 * 1000).toISOString();
    const to = new Date(now).toISOString();
    try {
      const [s, a, r] = await Promise.all([
        Stats.summary({ from, to }),
        Stats.analyzeSummary({ from, to }),
        Stats.requests({ from, to, limit: 20 }),
      ]);
      setSum(s);
      setAnalyzeSum(a);
      setRecent(r.items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">
        <button className={"btn small " + (track === "overview" ? "" : "secondary")} onClick={() => setTrack("overview")}>overview</button>{" "}
        <button className={"btn small " + (track === "moderate" ? "" : "secondary")} onClick={() => setTrack("moderate")}>moderate</button>{" "}
        <button className={"btn small " + (track === "analyze" ? "" : "secondary")} onClick={() => setTrack("analyze")}>content service</button>{" "}
        <button className={"btn small " + (period === "1h" ? "" : "secondary")} onClick={() => setPeriod("1h")}>1h</button>{" "}
        <button className={"btn small " + (period === "24h" ? "" : "secondary")} onClick={() => setPeriod("24h")}>24h</button>{" "}
        <button className={"btn small " + (period === "7d" ? "" : "secondary")} onClick={() => setPeriod("7d")}>7d</button>
      </p>

      {err && <div className="error">{err}</div>}
      {track === "overview" && <OverviewPanel sum={sum} analyzeSum={analyzeSum} />}
      {track === "moderate" && <ModeratePanel sum={sum} recent={recent} />}
      {track === "analyze" && <AnalyzePanel sum={analyzeSum} />}
    </>
  );
}

function OverviewPanel({
  sum,
  analyzeSum,
}: {
  sum: SummaryData | null;
  analyzeSum: AnalyzeSummaryData | null;
}) {
  const moderationTotal = sum?.total ?? 0;
  const analyzeTotal = analyzeSum?.total ?? 0;
  const total = moderationTotal + analyzeTotal;
  const cached = (sum?.cached ?? 0) + (analyzeSum?.cached ?? 0);
  const errors = (sum?.by_status.error ?? 0) + (analyzeSum?.by_status.error ?? 0);
  const pending = analyzeSum?.by_status.pending ?? 0;
  const inputTokens = (sum?.tokens.input ?? 0) + (analyzeSum?.tokens.input ?? 0);
  const outputTokens = (sum?.tokens.output ?? 0) + (analyzeSum?.tokens.output ?? 0);

  return (
    <>
      <div className="metric-grid">
        <Metric label="Total requests" value={fmtNum(total)} />
        <Metric label="Moderation" value={fmtNum(moderationTotal)} hint={shareHint(moderationTotal, total)} />
        <Metric label="Content service" value={fmtNum(analyzeTotal)} hint={shareHint(analyzeTotal, total)} />
        <Metric label="Cache hit" value={pct(total ? cached / total : 0)} hint={`${fmtNum(cached)} cached`} />
        <Metric
          label="Errors"
          value={fmtNum(errors)}
          color={errors > 0 ? "bad" : undefined}
          hint={`${pct(total ? errors / total : 0)} of requests`}
        />
        <Metric
          label="Analyze pending"
          value={fmtNum(pending)}
          color={pending > 0 ? "warn" : undefined}
        />
        <Metric label="Input tokens" value={fmtNum(inputTokens)} />
        <Metric label="Output tokens" value={fmtNum(outputTokens)} />
        <Metric label="Result bytes" value={formatBytes(analyzeSum?.output_bytes_total ?? 0)} />
      </div>

      <div className="card">
        <h3>Service mix</h3>
        <ServiceSplitBar moderation={moderationTotal} analyze={analyzeTotal} />
      </div>

      <div className="metric-grid">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Moderation status</h3>
            <a href="#/requests">Open requests</a>
          </div>
          <StatusBar by={sum?.by_status ?? { pass: 0, reject: 0, review: 0, error: 0 }} />
        </div>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Content service status</h3>
            <a href="#/analyze-records">Open records</a>
          </div>
          <AnalyzeStatusBar by={analyzeSum?.by_status ?? { pending: 0, ok: 0, error: 0 }} />
        </div>
      </div>
    </>
  );
}

function AnalyzePanel({ sum }: { sum: AnalyzeSummaryData | null }) {
  return (
    <>
      <div className="metric-grid">
        <Metric label="Total" value={sum?.total ?? 0} />
        <Metric label="Cache hit" value={pct(sum?.cache_hit_rate ?? 0)} />
        <Metric label="OK rate" value={pct(sum?.ok_rate ?? 0)} />
        <Metric label="Errors" value={sum?.by_status.error ?? 0}
                color={(sum?.by_status.error ?? 0) > 0 ? "bad" : undefined} />
        <Metric label="Input tokens" value={fmtNum(sum?.tokens.input ?? 0)} />
        <Metric label="Output tokens" value={fmtNum(sum?.tokens.output ?? 0)} />
        <Metric label="Result bytes" value={formatBytes(sum?.output_bytes_total ?? 0)} />
      </div>
      <div className="card">
        <h3>Status</h3>
        <AnalyzeStatusBar by={sum?.by_status ?? { pending: 0, ok: 0, error: 0 }} />
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Analyze records</h3>
          <a href="#/analyze-records">Open records</a>
        </div>
      </div>
    </>
  );
}

function ModeratePanel({ sum, recent }: { sum: SummaryData | null; recent: ModerationRow[] }) {
  return (
    <>
      <div className="metric-grid">
        <Metric label="Total" value={sum?.total ?? 0} />
        <Metric label="Cache hit" value={pct(sum?.cache_hit_rate ?? 0)} />
        <Metric label="Pass rate" value={pct(sum?.pass_rate ?? 0)} />
        <Metric label="Errors" value={sum?.by_status.error ?? 0}
                color={(sum?.by_status.error ?? 0) > 0 ? "bad" : undefined} />
        <Metric label="Input tokens" value={fmtNum(sum?.tokens.input ?? 0)} />
        <Metric label="Output tokens" value={fmtNum(sum?.tokens.output ?? 0)} />
      </div>

      {sum && (
        <div className="card">
          <h3>Status</h3>
          <StatusBar by={sum.by_status} />
        </div>
      )}

      {sum?.funnel && (
        <div className="card">
          <h3>Prefilter funnel</h3>
          <FunnelBreakdown funnel={sum.funnel} total={sum.total} />
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Recent requests</h3>
          <a href="#/requests">Open requests</a>
        </div>
        <div className="mt8">
          {recent.length === 0 ? (
            <div className="empty">No requests</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Biz</th><th>Status</th><th>Risk</th><th>Provider</th>
                  <th>Cached</th><th>Latency</th><th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => <RequestRow key={r.id} r={r} />)}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  color?: "bad" | "warn" | "good";
  hint?: React.ReactNode;
}) {
  const style = color === "bad" ? { color: "var(--bad)" }
              : color === "warn" ? { color: "var(--warn)" }
              : color === "good" ? { color: "var(--good)" } : undefined;
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value" style={style}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function ServiceSplitBar({ moderation, analyze }: { moderation: number; analyze: number }) {
  const total = moderation + analyze;
  if (total === 0) return <div className="muted">No data</div>;
  const segment = (value: number, color: string, label: string) => (
    <div
      title={`${label}: ${value} (${((value / total) * 100).toFixed(1)}%)`}
      style={{ width: `${(value / total) * 100}%`, background: color, height: "100%" }}
    />
  );
  return (
    <>
      <div style={{ display: "flex", height: 22, borderRadius: 4, overflow: "hidden", background: "var(--panel-2)" }}>
        {moderation > 0 && segment(moderation, "var(--accent)", "moderation")}
        {analyze > 0 && segment(analyze, "var(--warn)", "content service")}
      </div>
      <div className="mt8" style={{ fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span><span className="pill cached">moderate</span> {moderation}</span>
        <span><span className="pill review">content service</span> {analyze}</span>
      </div>
    </>
  );
}

function StatusBar({ by }: { by: { pass: number; reject: number; review: number; error: number } }) {
  const total = by.pass + by.reject + by.review + by.error;
  if (total === 0) return <div className="muted">No data</div>;
  const seg = (k: keyof typeof by, color: string) => (
    <div
      title={`${k}: ${by[k]} (${((by[k] / total) * 100).toFixed(1)}%)`}
      style={{ width: `${(by[k] / total) * 100}%`, background: color, height: "100%" }}
    />
  );
  return (
    <>
      <div style={{ display: "flex", height: 22, borderRadius: 4, overflow: "hidden", background: "var(--panel-2)" }}>
        {seg("pass", "var(--good)")}
        {seg("review", "var(--warn)")}
        {seg("reject", "var(--bad)")}
        {seg("error", "var(--crit)")}
      </div>
      <div className="mt8" style={{ fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span><StatusPill v="pass" /> {by.pass}</span>
        <span><StatusPill v="review" /> {by.review}</span>
        <span><StatusPill v="reject" /> {by.reject}</span>
        <span><StatusPill v="error" /> {by.error}</span>
      </div>
    </>
  );
}

function AnalyzeStatusBar({ by }: { by: { pending: number; ok: number; error: number } }) {
  const total = by.pending + by.ok + by.error;
  if (total === 0) return <div className="muted">No data</div>;
  const seg = (k: keyof typeof by, color: string) => (
    <div
      title={`${k}: ${by[k]} (${((by[k] / total) * 100).toFixed(1)}%)`}
      style={{ width: `${(by[k] / total) * 100}%`, background: color, height: "100%" }}
    />
  );
  return (
    <>
      <div style={{ display: "flex", height: 22, borderRadius: 4, overflow: "hidden", background: "var(--panel-2)" }}>
        {seg("ok", "var(--good)")}
        {seg("pending", "var(--warn)")}
        {seg("error", "var(--crit)")}
      </div>
      <div className="mt8" style={{ fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span><StatusPill v="ok" /> {by.ok}</span>
        <span><StatusPill v="pending" /> {by.pending}</span>
        <span><StatusPill v="error" /> {by.error}</span>
      </div>
    </>
  );
}

function FunnelBreakdown({ funnel, total }: { funnel: Record<string, number>; total: number }) {
  const entries = Object.entries(funnel).sort((a, b) => b[1] - a[1]);
  const modelCount = funnel["model"] ?? 0;
  const preFilteredCount = total - modelCount;
  const saved = total > 0 ? preFilteredCount / total : 0;
  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Saved <strong style={{ color: "var(--good)" }}>{(saved * 100).toFixed(1)}%</strong> model calls ({preFilteredCount} / {total})
      </div>
      <table>
        <thead>
          <tr><th>Layer</th><th>Type</th><th>Count</th><th>Share</th></tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k === "model" ? "-" : k}</td>
              <td>{k}</td>
              <td className="monospace">{v}</td>
              <td className="monospace">{total > 0 ? ((v / total) * 100).toFixed(1) : "0.0"}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function shareHint(n: number, total: number): string {
  return total > 0 ? `${pct(n / total)} of total` : "0.0% of total";
}

function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(1) + "M";
}
