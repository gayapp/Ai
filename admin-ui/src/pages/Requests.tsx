import { useEffect, useState } from "react";
import { Apps, Stats, type AppConfig, type ModerationRow } from "../lib/api";
import { RequestRow } from "../components/common";

const BIZ = ["", "comment", "nickname", "bio", "avatar"];
const STATUS = ["", "pass", "reject", "review", "error", "pending"];

export default function RequestsPage() {
  const [apps, setApps] = useState<AppConfig[]>([]);
  const [appId, setAppId] = useState("");
  const [biz, setBiz] = useState("");
  const [status, setStatus] = useState("");
  const [limit, setLimit] = useState(100);
  const [items, setItems] = useState<ModerationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => { Apps.list().then(r => setApps(r.items)).catch(() => {}); }, []);
  useEffect(() => { load(); }, [appId, biz, status, limit]);

  async function load() {
    setErr(null); setLoading(true); setCursor(null);
    try {
      const r = await Stats.requests({
        app_id: appId || undefined,
        biz_type: biz || undefined,
        status: status || undefined,
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
    try {
      const r = await Stats.requests({
        app_id: appId || undefined,
        biz_type: biz || undefined,
        status: status || undefined,
        limit,
        cursor,
      });
      setItems(prev => [...prev, ...r.items]);
      setCursor(r.next_cursor);
    } catch (e) { setErr(String(e)); }
    finally { setLoadingMore(false); }
  }

  return (
    <>
      <h1 className="page-title">审核记录</h1>
      <p className="page-sub">每条请求都可点击查看完整详情（含 token、prompt 版本、回调状态、extra 原文等）。</p>
      {err && <div className="error">{err}</div>}

      <div className="toolbar">
        <div>
          <label>app</label>
          <select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">全部</option>
            {apps.map(a => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
          </select>
        </div>
        <div>
          <label>biz_type</label>
          <select value={biz} onChange={(e) => setBiz(e.target.value)}>
            {BIZ.map(b => <option key={b} value={b}>{b || "全部"}</option>)}
          </select>
        </div>
        <div>
          <label>status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS.map(s => <option key={s} value={s}>{s || "全部"}</option>)}
          </select>
        </div>
        <div>
          <label>limit</label>
          <select value={limit} onChange={(e) => setLimit(parseInt(e.target.value))}>
            {[50, 100, 200, 500].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button className="btn small secondary" onClick={load}>刷新</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>时间</th><th>业务</th><th>状态</th><th>风险</th><th>Provider</th>
              <th>缓存</th><th>延迟</th><th>说明</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8}><div className="loading">加载中…</div></td></tr>}
            {!loading && items.length === 0 && <tr><td colSpan={8}><div className="empty">暂无记录</div></td></tr>}
            {!loading && items.map(r => <RequestRow key={r.id} r={r} />)}
          </tbody>
        </table>
        {!loading && cursor && (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <button className="btn secondary" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "加载中…" : "加载更多（当前已展示 " + items.length + " 条）"}
            </button>
          </div>
        )}
        {!loading && !cursor && items.length > 0 && (
          <div style={{ textAlign: "center", padding: "12px 0", color: "var(--muted)", fontSize: 12 }}>
            已到末尾（共 {items.length} 条）
          </div>
        )}
      </div>
    </>
  );
}
