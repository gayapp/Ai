import { useEffect, useState } from "react";
import {
  Stats,
  type AnalyzeSummaryData,
  type ModerationRow,
  type SummaryData,
} from "../lib/api";
import { formatBytes, RequestRow, StatusPill } from "../components/common";

export default function Dashboard() {
  const [track, setTrack] = useState<"moderate" | "analyze">("moderate");
  const [period, setPeriod] = useState<"1h" | "24h" | "7d">("24h");
  const [sum, setSum] = useState<SummaryData | null>(null);
  const [analyzeSum, setAnalyzeSum] = useState<AnalyzeSummaryData | null>(null);
  const [recent, setRecent] = useState<ModerationRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { load(); }, [period, track]);

  async function load() {
    setErr(null);
    const now = Date.now();
    const hours = period === "1h" ? 1 : period === "24h" ? 24 : 24 * 7;
    const from = new Date(now - hours * 3600 * 1000).toISOString();
    const to = new Date(now).toISOString();
    try {
      if (track === "analyze") {
        setAnalyzeSum(await Stats.analyzeSummary({ from, to }));
        return;
      }
      const [s, r] = await Promise.all([
        Stats.summary({ from, to }),
        Stats.requests({ from, to, limit: 20 }),
      ]);
      setSum(s);
      setRecent(r.items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">
        <button className={"btn small " + (track === "moderate" ? "" : "secondary")} onClick={() => setTrack("moderate")}>moderate</button>{" "}
        <button className={"btn small " + (track === "analyze" ? "" : "secondary")} onClick={() => setTrack("analyze")}>analyze</button>{" "}
        <button className={"btn small " + (period === "1h" ? "" : "secondary")} onClick={() => setPeriod("1h")}>1h</button>{" "}
        <button className={"btn small " + (period === "24h" ? "" : "secondary")} onClick={() => setPeriod("24h")}>24h</button>{" "}
        <button className={"btn small " + (period === "7d" ? "" : "secondary")} onClick={() => setPeriod("7d")}>7d</button>
      </p>

      {err && <div className="error">{err}</div>}
      {track === "analyze" ? <AnalyzePanel sum={analyzeSum} /> : <ModeratePanel sum={sum} recent={recent} />}
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

function Metric({ label, value, color }: { label: string; value: React.ReactNode; color?: "bad" | "warn" | "good" }) {
  const style = color === "bad" ? { color: "var(--bad)" }
              : color === "warn" ? { color: "var(--warn)" }
              : color === "good" ? { color: "var(--good)" } : undefined;
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value" style={style}>{value}</div>
    </div>
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

function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(1) + "M";
}
