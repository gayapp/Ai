import { useEffect, useState } from "react";
import { Stats, type SummaryData, type ModerationRow } from "../lib/api";
import { RequestRow, StatusPill } from "../components/common";

export default function Dashboard() {
  const [sum, setSum] = useState<SummaryData | null>(null);
  const [recent, setRecent] = useState<ModerationRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [period, setPeriod] = useState<"1h" | "24h" | "7d">("24h");

  useEffect(() => { load(); }, [period]);

  async function load() {
    setErr(null);
    const now = Date.now();
    const hours = period === "1h" ? 1 : period === "24h" ? 24 : 24 * 7;
    const from = new Date(now - hours * 3600 * 1000).toISOString();
    const to = new Date(now).toISOString();
    try {
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
      <h1 className="page-title">总览</h1>
      <p className="page-sub">
        <button className={"btn small " + (period==="1h"?"":"secondary")} onClick={() => setPeriod("1h")}>最近 1h</button>{" "}
        <button className={"btn small " + (period==="24h"?"":"secondary")} onClick={() => setPeriod("24h")}>最近 24h</button>{" "}
        <button className={"btn small " + (period==="7d"?"":"secondary")} onClick={() => setPeriod("7d")}>最近 7d</button>
      </p>

      {err && <div className="error">{err}</div>}

      <div className="metric-grid">
        <Metric label="总请求" value={sum?.total ?? 0} />
        <Metric label="缓存命中率" value={pct(sum?.cache_hit_rate ?? 0)} />
        <Metric label="通过率（排除错误）" value={pct(sum?.pass_rate ?? 0)} />
        <Metric label="错误数" value={sum?.by_status.error ?? 0}
                color={(sum?.by_status.error ?? 0) > 0 ? "bad" : undefined} />
        <Metric label="Token 输入" value={fmtNum(sum?.tokens.input ?? 0)} />
        <Metric label="Token 输出" value={fmtNum(sum?.tokens.output ?? 0)} />
      </div>

      {sum && (
        <div className="card">
          <h3>状态分布</h3>
          <StatusBar by={sum.by_status} />
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{margin:0}}>最近 20 条请求</h3>
          <a href="#/requests">查看全部 →</a>
        </div>
        <div className="mt8">
          {recent.length === 0 ? (
            <div className="empty">暂无请求</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>时间</th><th>业务</th><th>状态</th><th>风险</th><th>Provider</th>
                  <th>缓存</th><th>延迟</th><th>说明</th>
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
  if (total === 0) return <div className="muted">无数据</div>;
  const seg = (k: keyof typeof by, color: string) => (
    <div
      title={`${k}: ${by[k]} (${((by[k]/total)*100).toFixed(1)}%)`}
      style={{ width: `${(by[k]/total)*100}%`, background: color, height: "100%" }}
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

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(1) + "M";
}
