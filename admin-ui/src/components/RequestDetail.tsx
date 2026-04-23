import { useEffect, useState } from "react";
import { Stats } from "../lib/api";
import { ProviderPill, RiskPill, StatusPill } from "./common";

export default function RequestDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [row, setRow] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Stats.request(id).then(setRow).catch((e) => setErr(String(e)));
  }, [id]);

  return (
    <tr onClick={(e) => e.stopPropagation()}>
      <td colSpan={8} style={{ padding: 0 }}>
        <div className="dialog-backdrop" onClick={onClose}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <span className="dialog-close" onClick={onClose}>×</span>
            <h3>审核详情</h3>
            {err && <div className="error">{err}</div>}
            {!row && !err && <div className="loading">加载中…</div>}
            {row && (
              <>
                <div className="kv-grid">
                  <span className="k">request_id</span><code className="v">{row.id}</code>
                  <span className="k">app_id</span><code className="v">{row.app_id}</code>
                  <span className="k">biz_type / biz_id</span>
                  <span className="v">{row.biz_type} / <code>{row.biz_id}</code></span>
                  <span className="k">user_id</span><code className="v">{row.user_id ?? "—"}</code>
                  <span className="k">mode</span><span className="v">{row.mode}</span>
                  <span className="k">cached</span><span className="v">{row.cached ? "✓" : "—"}</span>

                  <span className="k">status</span><span className="v"><StatusPill v={row.status} /></span>
                  <span className="k">risk_level</span><span className="v"><RiskPill v={row.risk_level} /></span>
                  <span className="k">categories</span><span className="v">
                    {row.categories?.length ? row.categories.map((c: string) => <span key={c} className="pill" style={{marginRight:4}}>{c}</span>) : <span className="muted">—</span>}
                  </span>
                  <span className="k">reason</span><span className="v wrap">{row.reason ?? "—"}</span>

                  <span className="k">provider / model</span>
                  <span className="v"><ProviderPill v={row.provider} /> <code>{row.model ?? "—"}</code></span>
                  <span className="k">prompt_version</span><span className="v">{row.prompt_version ?? "—"}</span>
                  <span className="k">tokens (in/out)</span>
                  <span className="v">{row.tokens?.input ?? 0} / {row.tokens?.output ?? 0}</span>
                  <span className="k">latency_ms</span><span className="v">{row.latency_ms ?? 0}ms</span>
                  <span className="k">error_code</span><span className="v">{row.error_code ?? "—"}</span>

                  <span className="k">content_hash</span>
                  <code className="v" style={{fontSize:11}}>{row.content_hash}</code>
                  <span className="k">callback_url</span>
                  <code className="v wrap">{row.callback_url ?? "—"}</code>
                  <span className="k">created_at</span><span className="v">{new Date(row.created_at).toLocaleString()}</span>
                  <span className="k">completed_at</span>
                  <span className="v">{row.completed_at ? new Date(row.completed_at).toLocaleString() : "—"}</span>
                </div>
                {row.extra && (
                  <>
                    <h3 className="mt16">应用回传 extra</h3>
                    <pre>{JSON.stringify(row.extra, null, 2)}</pre>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
