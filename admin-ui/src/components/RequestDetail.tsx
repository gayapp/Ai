import { useEffect, useState } from "react";
import { Stats, evidenceUrl, type ModerationDetail, type ReplayResult } from "../lib/api";
import { ProviderPill, RiskPill, StatusPill } from "./common";

export default function RequestDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [row, setRow] = useState<ModerationDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayErr, setReplayErr] = useState<string | null>(null);

  useEffect(() => {
    Stats.request(id).then(setRow).catch((e) => setErr(String(e)));
  }, [id]);

  async function doReplay() {
    setReplayErr(null); setReplay(null); setReplayBusy(true);
    try {
      setReplay(await Stats.replay(id));
    } catch (e) { setReplayErr(String(e)); }
    finally { setReplayBusy(false); }
  }

  return (
    <tr onClick={(e) => e.stopPropagation()}>
      <td colSpan={8} style={{ padding: 0 }}>
        <div className="dialog-backdrop" onClick={onClose}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
            <span className="dialog-close" onClick={onClose}>×</span>
            <h3>审核详情</h3>
            {err && <div className="error">{err}</div>}
            {!row && !err && <div className="loading">加载中…</div>}
            {row && (
              <>
                {/* TOP: decision banner */}
                <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16, padding: "10px 14px", background: "var(--panel-2)", borderRadius: 6 }}>
                  <StatusPill v={row.status} />
                  <RiskPill v={row.risk_level} />
                  {row.categories?.map((c) => <span key={c} className="pill">{c}</span>)}
                  <span style={{ flex: 1, color: "var(--fg)" }}>{row.reason ?? <span className="muted">—</span>}</span>
                </div>

                {/* CONTENT — 用户原文 / 图片 */}
                <ContentBlock row={row} />

                {/* 元信息 */}
                <h3 style={{ marginTop: 22 }}>元信息</h3>
                <div className="kv-grid">
                  <span className="k">request_id</span><code className="v">{row.id}</code>
                  <span className="k">app_id</span><code className="v">{row.app_id}</code>
                  <span className="k">biz_type / biz_id</span>
                  <span className="v">{row.biz_type} / <code>{row.biz_id}</code></span>
                  <span className="k">user_id</span><code className="v">{row.user_id ?? "—"}</code>
                  <span className="k">mode</span><span className="v">{row.mode}</span>
                  <span className="k">cached</span><span className="v">{row.cached ? "✓（未调模型）" : "—"}</span>
                  <span className="k">provider / model</span>
                  <span className="v"><ProviderPill v={row.provider} /> <code>{row.model ?? "—"}</code></span>
                  <span className="k">prompt_version</span><span className="v">{row.prompt_version ?? "—"}</span>
                  <span className="k">tokens (in/out)</span>
                  <span className="v">{row.tokens?.input ?? 0} / {row.tokens?.output ?? 0}</span>
                  <span className="k">延迟</span><span className="v">{row.latency_ms ?? 0} ms</span>
                  <span className="k">error_code</span><span className="v">{row.error_code ?? "—"}</span>
                  <span className="k">content_hash</span>
                  <code className="v" style={{ fontSize: 11 }}>{row.content_hash}</code>
                  {row.evidence_key && (
                    <>
                      <span className="k">R2 evidence</span>
                      <code className="v" style={{ fontSize: 11 }}>{row.evidence_key}</code>
                    </>
                  )}
                  <span className="k">callback_url</span>
                  <code className="v wrap">{row.callback_url ?? "—"}</code>
                  <span className="k">created_at</span>
                  <span className="v">{new Date(row.created_at).toLocaleString()}</span>
                  <span className="k">completed_at</span>
                  <span className="v">{row.completed_at ? new Date(row.completed_at).toLocaleString() : "—"}</span>
                </div>

                {row.extra && (
                  <>
                    <h3 style={{ marginTop: 22 }}>extra（应用回传）</h3>
                    <pre>{JSON.stringify(row.extra, null, 2)}</pre>
                  </>
                )}

                {/* REPLAY */}
                <h3 style={{ marginTop: 22 }}>
                  Replay（用当前 active prompt 重跑）
                  <button className="btn small" style={{ marginLeft: 12 }}
                          disabled={replayBusy || !row.content_text}
                          onClick={doReplay}>
                    {replayBusy ? "运行中…" : "Run"}
                  </button>
                </h3>
                {!row.content_text && <p className="muted">此记录早于 migration 0003，无 content 可回放</p>}
                {replayErr && <div className="error">{replayErr}</div>}
                {replay && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <CompareCard title="原始（历史）" v={replay.original} />
                    <CompareCard title={`当前 prompt v${replay.replayed.prompt_version} 的结果`} v={replay.replayed} highlight={replay.changed} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function ContentBlock({ row }: { row: ModerationDetail }) {
  if (!row.content_text) {
    return (
      <div className="card">
        <h3 style={{ margin: 0, marginBottom: 6 }}>原文</h3>
        <p className="muted">此记录早于 migration 0003，未存内容</p>
      </div>
    );
  }
  if (row.biz_type === "avatar") {
    return (
      <div className="card">
        <h3 style={{ margin: 0, marginBottom: 6 }}>图片</h3>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>原始 URL（可能已失效）</div>
            <img
              src={row.content_text}
              alt="avatar source"
              style={{ maxWidth: 280, maxHeight: 280, borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
              onError={(e) => { (e.currentTarget.style.display = "none"); }}
            />
            <a className="monospace" style={{ fontSize: 11, wordBreak: "break-all", display: "block", marginTop: 6, maxWidth: 320 }}
               href={row.content_text} target="_blank" rel="noreferrer">{row.content_text}</a>
          </div>
          {row.evidence_key && (
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>R2 存证（审核当时快照）</div>
              <img
                src={evidenceUrl(row.id)}
                alt="evidence"
                style={{ maxWidth: 280, maxHeight: 280, borderRadius: 6, border: "1px solid var(--accent)", display: "block" }}
              />
              <code style={{ fontSize: 11 }}>{row.evidence_key}</code>
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <h3 style={{ margin: 0, marginBottom: 6 }}>原文 <span className="muted" style={{ fontSize: 12 }}>{row.content_text.length} 字</span></h3>
      <div className="wrap" style={{ padding: "10px 12px", background: "var(--panel-2)", borderRadius: 6, border: "1px solid var(--border)", fontSize: 14, lineHeight: 1.6 }}>
        {row.content_text}
      </div>
    </div>
  );
}

function CompareCard({ title, v, highlight }: {
  title: string;
  v: { status: string; risk_level: string | null; categories: string[]; reason: string };
  highlight?: boolean;
}) {
  return (
    <div className="card" style={highlight ? { borderColor: "var(--warn)" } : undefined}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <StatusPill v={v.status} />
        <RiskPill v={v.risk_level} />
        {v.categories.map((c) => <span key={c} className="pill">{c}</span>)}
      </div>
      <div className="wrap" style={{ fontSize: 13 }}>{v.reason}</div>
    </div>
  );
}
