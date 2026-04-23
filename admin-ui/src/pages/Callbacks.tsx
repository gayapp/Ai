import { useEffect, useState } from "react";
import { Stats, type CallbackRow } from "../lib/api";

export default function CallbacksPage() {
  const [items, setItems] = useState<CallbackRow[]>([]);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await Stats.callbacks({ failed: onlyFailed ? "1" : undefined, limit: 100 });
      setItems(r.items);
    } catch (e) { setErr(String(e)); }
  }
  useEffect(() => { load(); }, [onlyFailed]);

  return (
    <>
      <h1 className="page-title">回调投递</h1>
      <p className="page-sub">每条请求完成后会 POST 到应用的 callback_url；失败按 1/5/30/120/720 分钟重试 5 次。</p>
      {err && <div className="error">{err}</div>}

      <div className="toolbar">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, textTransform: "none" }}>
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} style={{ width: "auto" }} />
          仅失败 / 未投递
        </label>
        <button className="btn small secondary" onClick={load}>刷新</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>request_id</th><th>callback_url</th><th>HTTP</th>
              <th>尝试</th><th>投递时间 / 最后错误</th><th>下次重试</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={6}><div className="empty">暂无回调记录</div></td></tr>
            ) : items.map(c => (
              <tr key={c.request_id}>
                <td><code>{c.request_id.slice(0, 20)}…</code></td>
                <td className="wrap monospace" style={{maxWidth: 280}}>{c.url}</td>
                <td>{c.status_code ?? <span className="muted">—</span>}</td>
                <td>{c.attempts}</td>
                <td className="wrap" style={{maxWidth: 260}}>
                  {c.delivered_at ? (
                    <span className="pill pass">{new Date(c.delivered_at).toLocaleString()}</span>
                  ) : c.last_error ? (
                    <span className="wrap" style={{color: "var(--bad)"}}>{c.last_error}</span>
                  ) : <span className="pill pending">pending</span>}
                </td>
                <td className="muted monospace">{c.next_retry_at ? new Date(c.next_retry_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
