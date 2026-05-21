import { useEffect, useState } from "react";
import { Audit, type AuditLogRow } from "../lib/api";

const ACTIONS = [
  "",
  "app.create",
  "app.update",
  "app.rotate_secret",
  "prompt.publish",
  "prompt.rollback",
];
const TARGET_TYPES = ["", "app", "prompt"];
const PERIODS = ["1h", "24h", "7d"] as const;
type Period = typeof PERIODS[number];

export default function AuditLogsPage() {
  const [period, setPeriod] = useState<Period>("24h");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const [limit, setLimit] = useState(100);
  const [items, setItems] = useState<AuditLogRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => { load(); }, [period, action, targetType, limit]);

  async function load() {
    setErr(null);
    setLoading(true);
    setCursor(null);
    const range = periodRange(period);
    try {
      const r = await Audit.list({
        actor: actor || undefined,
        action: action || undefined,
        target_type: targetType || undefined,
        target_id: targetId || undefined,
        ...range,
        limit,
      });
      setItems(r.items);
      setCursor(r.next_cursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setErr(null);
    setLoadingMore(true);
    const range = periodRange(period);
    try {
      const r = await Audit.list({
        actor: actor || undefined,
        action: action || undefined,
        target_type: targetType || undefined,
        target_id: targetId || undefined,
        ...range,
        limit,
        cursor,
      });
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.next_cursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <h1 className="page-title">审计日志</h1>
      <p className="page-sub">记录 app 与 prompt 的高影响管理动作，不展示 app secret。</p>
      {err && <div className="error">{err}</div>}

      <div className="toolbar">
        <div>
          <label>window</label>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label>action</label>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTIONS.map((a) => <option key={a} value={a}>{a || "all"}</option>)}
          </select>
        </div>
        <div>
          <label>target_type</label>
          <select value={targetType} onChange={(e) => setTargetType(e.target.value)}>
            {TARGET_TYPES.map((t) => <option key={t} value={t}>{t || "all"}</option>)}
          </select>
        </div>
        <div>
          <label>target_id</label>
          <input value={targetId} onChange={(e) => setTargetId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
        </div>
        <div>
          <label>actor</label>
          <input value={actor} onChange={(e) => setActor(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
        </div>
        <div>
          <label>limit</label>
          <select value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10))}>
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button className="btn small secondary" onClick={load}>Refresh</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5}><div className="loading">Loading</div></td></tr>}
            {!loading && items.length === 0 && <tr><td colSpan={5}><div className="empty">No audit logs</div></td></tr>}
            {!loading && items.map((row) => (
              <tr key={row.id}>
                <td className="monospace">{new Date(row.created_at).toLocaleString()}</td>
                <td><code>{row.actor}</code></td>
                <td><span className="pill cached">{row.action}</span></td>
                <td>
                  <div>{row.target_type}</div>
                  <code>{row.target_id}</code>
                </td>
                <td style={{ maxWidth: 520 }}>
                  {row.metadata ? <pre style={{ margin: 0 }}>{JSON.stringify(row.metadata, null, 2)}</pre> : <span className="muted">-</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && cursor && (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <button className="btn secondary" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Loading" : `Load more (${items.length})`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function periodRange(period: Period): { from: string; to: string } {
  const hours = period === "1h" ? 1 : period === "24h" ? 24 : 24 * 7;
  const now = Date.now();
  return {
    from: new Date(now - hours * 3600 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  };
}
