import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AnalyzeRecords,
  Apps,
  type AnalyzeRecordDetail,
  type AnalyzeRecordRow,
  type AppConfig,
} from "../lib/api";
import { BoolPill, ProviderPill, StatusPill } from "../components/common";

const BIZ = ["", "media_analysis", "media_intro"];
const STATUS = ["", "pending", "ok", "error"];
const DELIVERY = ["", "callback", "pull", "both"];
const PERIODS = ["1h", "24h", "7d"] as const;
type Period = typeof PERIODS[number];

export default function AnalyzeRecordsPage() {
  const location = useLocation();
  const [apps, setApps] = useState<AppConfig[]>([]);
  const [appId, setAppId] = useState("");
  const [biz, setBiz] = useState("");
  const [bizId, setBizId] = useState("");
  const [status, setStatus] = useState("");
  const [delivery, setDelivery] = useState("");
  const [period, setPeriod] = useState<Period>("24h");
  const [limit, setLimit] = useState(100);
  const [items, setItems] = useState<AnalyzeRecordRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => { Apps.list().then((r) => setApps(r.items)).catch(() => {}); }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const nextPeriod = params.get("period");
    setAppId(params.get("app_id") ?? "");
    setBiz(params.get("biz_type") ?? "");
    setBizId(params.get("biz_id") ?? "");
    setStatus(params.get("status") ?? "");
    setDelivery(params.get("delivery_mode") ?? "");
    if (nextPeriod === "1h" || nextPeriod === "24h" || nextPeriod === "7d") {
      setPeriod(nextPeriod);
    }
  }, [location.search]);
  useEffect(() => { load(); }, [appId, biz, status, delivery, period, limit]);

  async function load() {
    setErr(null); setLoading(true); setCursor(null);
    const range = periodRange(period);
    try {
      const r = await AnalyzeRecords.list({
        app_id: appId || undefined,
        biz_type: biz || undefined,
        biz_id: bizId || undefined,
        status: status || undefined,
        delivery_mode: delivery || undefined,
        ...range,
        limit,
      });
      setItems(r.items);
      setCursor(r.next_cursor);
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setErr(null); setLoadingMore(true);
    const range = periodRange(period);
    try {
      const r = await AnalyzeRecords.list({
        app_id: appId || undefined,
        biz_type: biz || undefined,
        biz_id: bizId || undefined,
        status: status || undefined,
        delivery_mode: delivery || undefined,
        ...range,
        limit,
        cursor,
      });
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.next_cursor);
    } catch (e) { setErr(String(e)); }
    finally { setLoadingMore(false); }
  }

  return (
    <>
      <h1 className="page-title">Analyze Records</h1>
      <p className="page-sub">Long-retained analyze input and result records.</p>
      {err && <div className="error">{err}</div>}

      <div className="toolbar">
        <div>
          <label>app</label>
          <select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">all</option>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
          </select>
        </div>
        <div>
          <label>biz_type</label>
          <select value={biz} onChange={(e) => setBiz(e.target.value)}>
            {BIZ.map((b) => <option key={b} value={b}>{b || "all"}</option>)}
          </select>
        </div>
        <div>
          <label>status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS.map((s) => <option key={s} value={s}>{s || "all"}</option>)}
          </select>
        </div>
        <div>
          <label>delivery</label>
          <select value={delivery} onChange={(e) => setDelivery(e.target.value)}>
            {DELIVERY.map((d) => <option key={d} value={d}>{d || "all"}</option>)}
          </select>
        </div>
        <div>
          <label>window</label>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label>biz_id</label>
          <input value={bizId} onChange={(e) => setBizId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
        </div>
        <div>
          <label>limit</label>
          <select value={limit} onChange={(e) => setLimit(parseInt(e.target.value))}>
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button className="btn small secondary" onClick={load}>Refresh</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Biz</th><th>Status</th><th>Provider</th><th>Cached</th>
              <th>Delivery</th><th>Latency</th><th>Error</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8}><div className="loading">Loading</div></td></tr>}
            {!loading && items.length === 0 && <tr><td colSpan={8}><div className="empty">No records</div></td></tr>}
            {!loading && items.map((r) => (
              <tr key={r.request_id} className="clickable" onClick={() => setDetailId(r.request_id)}>
                <td className="monospace">{new Date(r.created_at).toLocaleString()}</td>
                <td>
                  <div>{r.biz_type}</div>
                  <div className="muted monospace" style={{ fontSize: 11 }}>{r.biz_id}</div>
                </td>
                <td><StatusPill v={r.status} /></td>
                <td><ProviderPill v={r.provider} /></td>
                <td><BoolPill v={r.cached} /></td>
                <td>
                  <span className="pill">{r.delivery_mode}</span>
                  <div className="muted" style={{ fontSize: 11 }}>
                    ack {r.acked_at ? "yes" : "-"} · cb {r.delivered_at ? "yes" : "-"}
                  </div>
                </td>
                <td className="monospace">{r.latency_ms}ms</td>
                <td>{r.error_code ?? <span className="muted">-</span>}</td>
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
      {detailId && <AnalyzeDetail id={detailId} onClose={() => setDetailId(null)} />}
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

function AnalyzeDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [row, setRow] = useState<AnalyzeRecordDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    AnalyzeRecords.get(id).then(setRow).catch((e) => setErr(String(e)));
  }, [id]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980 }}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>Analyze detail</h3>
        {err && <div className="error">{err}</div>}
        {!row && !err && <div className="loading">Loading</div>}
        {row && (
          <>
            <div className="kv-grid">
              <span className="k">request_id</span><code className="v">{row.request_id}</code>
              <span className="k">app_id</span><code className="v">{row.app_id}</code>
              <span className="k">biz</span><span className="v">{row.biz_type} / <code>{row.biz_id}</code></span>
              <span className="k">mode / status</span><span className="v">{row.mode} / <StatusPill v={row.status} /></span>
              <span className="k">delivery</span><span className="v">{row.delivery_mode} · ack={row.acked_at ?? "-"} · callback={row.delivered_at ?? "-"}</span>
              <span className="k">provider / model</span><span className="v"><ProviderPill v={row.provider} /> <code>{row.model ?? "-"}</code></span>
              <span className="k">prompt_version</span><span className="v">{row.prompt_version ?? "-"}</span>
              <span className="k">tokens</span><span className="v">{row.tokens.input} / {row.tokens.output}</span>
              <span className="k">input_hash</span><code className="v">{row.input_hash}</code>
              <span className="k">callback_url</span><code className="v wrap">{row.callback_url ?? "-"}</code>
              <span className="k">created_at</span><span className="v">{new Date(row.created_at).toLocaleString()}</span>
              <span className="k">completed_at</span><span className="v">{row.completed_at ? new Date(row.completed_at).toLocaleString() : "-"}</span>
            </div>
            <JsonBlock title="input_json" value={row.input} />
            <JsonBlock title="result_json" value={row.result} />
            <JsonBlock title="extra_json" value={row.extra} />
          </>
        )}
      </div>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (!value) return null;
  return (
    <>
      <h3 style={{ marginTop: 22 }}>{title}</h3>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </>
  );
}
