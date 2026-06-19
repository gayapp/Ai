import { useEffect, useMemo, useState } from "react";
import { Prompts, type PromptRow } from "../lib/api";

const MODERATE_BIZ = ["comment", "nickname", "bio", "avatar", "post"];
const ANALYZE_BIZ = ["media_analysis", "media_intro"];
const MODERATE_PROVIDERS = ["grok", "gemini"];
const ANALYZE_PROVIDERS = ["xai", "gemini"];

export default function PromptsPage() {
  const [track, setTrack] = useState<"moderate" | "analyze">("moderate");
  const [biz, setBiz] = useState("comment");
  const [prov, setProv] = useState("grok");
  const [items, setItems] = useState<PromptRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [dryRun, setDryRun] = useState<string | null>(null);

  const bizOptions = track === "analyze" ? ANALYZE_BIZ : MODERATE_BIZ;
  const providerOptions = track === "analyze" ? ANALYZE_PROVIDERS : MODERATE_PROVIDERS;
  const active = useMemo(() => items.find((x) => x.is_active), [items]);

  useEffect(() => {
    const nextBiz = track === "analyze" ? "media_analysis" : "comment";
    const nextProvider = track === "analyze" ? "xai" : "grok";
    setBiz(nextBiz);
    setProv(nextProvider);
  }, [track]);

  useEffect(() => { load(); }, [biz, prov]);

  async function load() {
    setErr(null);
    try {
      const r = await Prompts.list(biz, prov);
      setItems(r.items);
    } catch (e) { setErr(String(e)); }
  }

  async function rollback(id: number) {
    if (!window.confirm("Rollback to this prompt version?")) return;
    try {
      await Prompts.rollback(id);
      load();
    } catch (e) { setErr(String(e)); }
  }

  return (
    <>
      <h1 className="page-title">Prompts</h1>
      <p className="page-sub">
        <button className={"btn small " + (track === "moderate" ? "" : "secondary")} onClick={() => setTrack("moderate")}>moderate</button>{" "}
        <button className={"btn small " + (track === "analyze" ? "" : "secondary")} onClick={() => setTrack("analyze")}>analyze</button>
      </p>
      {err && <div className="error">{err}</div>}
      <div className="toolbar">
        <div>
          <label>biz_type</label>
          <select value={biz} onChange={(e) => setBiz(e.target.value)}>
            {bizOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label>provider</label>
          <select value={prov} onChange={(e) => setProv(e.target.value)}>
            {providerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="grow"></div>
        <button className="btn" onClick={() => setShowNew(true)}>Publish version</button>
        <button className="btn secondary" onClick={() => setDryRun(active?.content ?? "")}>
          Dry run
        </button>
      </div>

      {active && (
        <div className="card">
          <h3>Active v{active.version} · {active.created_by ?? "system"} · {new Date(active.created_at).toLocaleString()}</h3>
          <pre>{active.content}</pre>
        </div>
      )}

      <div className="card">
        <h3>History</h3>
        <table>
          <thead>
            <tr>
              <th>Version</th><th>Status</th><th>Author</th><th>Time</th><th>Length</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={6}><div className="empty">No prompts</div></td></tr>}
            {items.map((x) => (
              <tr key={x.id}>
                <td><code>v{x.version}</code></td>
                <td>{x.is_active ? <span className="pill pass">active</span> : <span className="pill pending">inactive</span>}</td>
                <td className="muted">{x.created_by ?? "-"}</td>
                <td className="muted monospace">{new Date(x.created_at).toLocaleString()}</td>
                <td>{x.content.length}</td>
                <td className="right">
                  <button className="btn small secondary" onClick={() => navigator.clipboard.writeText(x.content)}>Copy</button>{" "}
                  {!x.is_active && <button className="btn small" onClick={() => rollback(x.id)}>Rollback</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <NewPromptDialog
          biz={biz}
          prov={prov}
          initial={active?.content ?? ""}
          onClose={() => setShowNew(false)}
          onPublished={() => { setShowNew(false); load(); }}
        />
      )}
      {dryRun !== null && (
        <DryRunDialog biz={biz} prov={prov} content={dryRun} onClose={() => setDryRun(null)} />
      )}
    </>
  );
}

function NewPromptDialog({ biz, prov, initial, onClose, onPublished }: {
  biz: string;
  prov: string;
  initial: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [content, setContent] = useState(initial);
  const [by, setBy] = useState("admin");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!window.confirm("Publish this prompt version?")) return;
    setErr(null); setBusy(true);
    try {
      await Prompts.publish({ biz_type: biz, provider: prov, content, created_by: by });
      onPublished();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>Publish · {biz} × {prov}</h3>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>Prompt</label>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} required style={{ minHeight: 360 }} />
          </div>
          <div className="form-row">
            <label>Author</label>
            <input value={by} onChange={(e) => setBy(e.target.value)} maxLength={64} />
          </div>
          {err && <div className="error">{err}</div>}
          <div className="mt16">
            <button className="btn" disabled={busy || !content}>Publish</button>{" "}
            <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DryRunDialog({ biz, prov, content, onClose }: {
  biz: string;
  prov: string;
  content: string;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(content);
  const [samples, setSamples] = useState(defaultDryRunSamples(biz));
  const [results, setResults] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true); setResults(null);
    try {
      const r = await Prompts.dryRun({
        biz_type: biz,
        provider: prov,
        content: prompt,
        samples: samples.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20),
      });
      setResults(r.results as any[]);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900 }}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>Dry run · {biz} × {prov}</h3>
        <form onSubmit={run}>
          <div className="form-row">
            <label>Prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 200 }} />
          </div>
          <div className="form-row">
            <label>Samples</label>
            <textarea value={samples} onChange={(e) => setSamples(e.target.value)} style={{ minHeight: 120 }} />
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              {isAnalyzeBiz(biz)
                ? "Analyze dry-run expects one compact JSON input object per line."
                : "Moderate dry-run expects one text or image URL sample per line."}
            </div>
          </div>
          {err && <div className="error">{err}</div>}
          <div className="mt8">
            <button className="btn" disabled={busy || !prompt}>{busy ? "Running" : "Run"}</button>{" "}
            <button className="btn secondary" type="button" onClick={onClose}>Close</button>
          </div>
        </form>
        {results && (
          <div className="mt16">
            <h3>Results</h3>
            {results.map((r, i) => (
              <div className="card" key={i}>
                <div className="kv-grid">
                  <span className="k">sample</span><span className="v wrap">{r.sample}</span>
                  {r.error ? (
                    <>
                      <span className="k">error</span>
                      <span className="v error wrap">{r.error}</span>
                    </>
                  ) : (
                    <>
                      {r.dry_run_mode && (
                        <>
                          <span className="k">mode</span>
                          <span className="v"><code>{r.dry_run_mode}</code></span>
                        </>
                      )}
                      <span className="k">schema_ok</span>
                      <span className="v">
                        {r.schema_ok ?? r.input_schema_ok ? "yes" : <span className="error">no</span>}
                        {r.schema_error && <span className="muted"> {r.schema_error}</span>}
                      </span>
                      {r.parsed && (
                        <>
                          <span className="k">parsed</span>
                          <pre className="v" style={{ margin: 0 }}>{JSON.stringify(r.parsed, null, 2)}</pre>
                        </>
                      )}
                      {r.prompt_preview && (
                        <>
                          <span className="k">prompt_preview</span>
                          <pre className="v" style={{ margin: 0 }}>{r.prompt_preview}</pre>
                        </>
                      )}
                      {r.note && (
                        <>
                          <span className="k">note</span>
                          <span className="v wrap">{r.note}</span>
                        </>
                      )}
                      {(r.tokens || r.latency_ms !== undefined) && (
                        <>
                          <span className="k">tokens</span>
                          <span className="v">in={r.tokens?.input ?? 0} out={r.tokens?.output ?? 0} · {r.latency_ms ?? 0}ms</span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function isAnalyzeBiz(biz: string): boolean {
  return biz === "media_analysis" || biz === "media_intro";
}

function defaultDryRunSamples(biz: string): string {
  if (biz === "media_intro") {
    return JSON.stringify({
      title: "Sample clip",
      duration_seconds: 120,
      tags: ["travel", "night"],
      frame_notes: [
        { timestamp_seconds: 12, summary: "Opening city shot" },
        { timestamp_seconds: 74, summary: "Main action sequence" },
      ],
      style_hint: "concise",
      max_length: 160,
    });
  }
  if (biz === "media_analysis") {
    return JSON.stringify({
      image_urls: ["https://example.com/frame.jpg"],
      title: "Sample media",
      duration_seconds: 120,
      frame_metadata: [
        { timestamp_seconds: 0, quality_score: 0.9 },
      ],
      region_hint: "japan",
    });
  }
  return "sample 1\nsample 2";
}
