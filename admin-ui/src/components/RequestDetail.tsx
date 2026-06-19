import { useEffect, useState } from "react";
import { Stats, evidenceUrl, type ModerationDetail, type ModerationLabel, type ReplayResult } from "../lib/api";
import { ProviderPill, RiskPill, StatusPill } from "./common";

// 6 类零容忍 + minor_face(复核) + nsfw(描述性)
const ZERO_TOLERANCE = new Set(["csam", "ad", "drug", "gambling", "politics"]);

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

                {/* 结构化标签（post） */}
                {row.labels && row.labels.length > 0 && <LabelsTable labels={row.labels} />}

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
  if (row.biz_type === "post" && row.image_urls && row.image_urls.length > 0) {
    return (
      <div className="card">
        <h3 style={{ margin: 0, marginBottom: 6 }}>
          帖子图片 / 视频帧 <span className="muted" style={{ fontSize: 12 }}>{row.image_urls.length} 张</span>
        </h3>
        {row.content_text && (
          <div className="wrap" style={{ padding: "8px 12px", background: "var(--panel-2)", borderRadius: 6, border: "1px solid var(--border)", fontSize: 14, lineHeight: 1.6, marginBottom: 10 }}>
            {row.content_text}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {row.image_urls.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noreferrer" title={`第 ${i + 1} 张`}
               style={{ position: "relative", display: "block" }}>
              <img
                src={url}
                alt={`frame ${i + 1}`}
                style={{ width: 150, height: 150, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                onError={(e) => { (e.currentTarget.style.opacity = "0.25"); }}
              />
              <span style={{ position: "absolute", left: 4, top: 4, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 11, padding: "1px 6px", borderRadius: 4 }}>{i + 1}</span>
            </a>
          ))}
        </div>
      </div>
    );
  }
  if (row.biz_type === "avatar" && row.content_text) {
    const avatarUrl = row.content_text;
    return (
      <div className="card">
        <h3 style={{ margin: 0, marginBottom: 6 }}>图片</h3>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>原始 URL（可能已失效）</div>
            <img
              src={avatarUrl}
              alt="avatar source"
              style={{ maxWidth: 280, maxHeight: 280, borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
              onError={(e) => { (e.currentTarget.style.display = "none"); }}
            />
            <a className="monospace" style={{ fontSize: 11, wordBreak: "break-all", display: "block", marginTop: 6, maxWidth: 320 }}
               href={avatarUrl} target="_blank" rel="noreferrer">{avatarUrl}</a>
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
  if (!row.content_text) {
    return (
      <div className="card">
        <h3 style={{ margin: 0, marginBottom: 6 }}>原文</h3>
        <p className="muted">此记录早于 migration 0003，未存内容</p>
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

function LabelsTable({ labels }: { labels: ModerationLabel[] }) {
  return (
    <>
      <h3 style={{ marginTop: 22 }}>结构化标签</h3>
      <table className="data" style={{ width: "100%", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>category</th>
            <th style={{ textAlign: "left" }}>detected</th>
            <th style={{ textAlign: "left" }}>confidence</th>
            <th style={{ textAlign: "left" }}>evidence（是什么）</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((l) => {
            const hit = l.detected && ZERO_TOLERANCE.has(l.category);
            return (
              <tr key={l.category} style={hit ? { background: "rgba(220,38,38,.12)" } : undefined}>
                <td>
                  <code>{l.category}</code>
                  {ZERO_TOLERANCE.has(l.category) && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>零容忍</span>}
                  {l.category === "minor_face" && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>复核</span>}
                  {l.category === "nsfw" && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>描述性</span>}
                </td>
                <td style={{ color: l.detected ? (hit ? "var(--danger, #dc2626)" : "var(--warn, #d97706)") : "var(--ok, #16a34a)", fontWeight: 600 }}>
                  {l.detected ? "✓ 是" : "—"}
                </td>
                <td>{l.detected ? l.confidence.toFixed(2) : "—"}</td>
                <td className="wrap">{l.evidence || <span className="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
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
