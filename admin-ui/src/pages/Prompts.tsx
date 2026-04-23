import { useEffect, useState } from "react";
import { Prompts, type PromptRow } from "../lib/api";

const BIZ = ["comment", "nickname", "bio", "avatar"];
const PROV = ["grok", "gemini"];

export default function PromptsPage() {
  const [biz, setBiz] = useState("comment");
  const [prov, setProv] = useState("grok");
  const [items, setItems] = useState<PromptRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [dryRun, setDryRun] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await Prompts.list(biz, prov);
      setItems(r.items);
    } catch (e) { setErr(String(e)); }
  }
  useEffect(() => { load(); }, [biz, prov]);

  async function rollback(id: number) {
    if (!window.confirm(`确认回滚到这个版本？当前 active 版本会被替换。`)) return;
    try {
      await Prompts.rollback(id);
      load();
    } catch (e) { setErr(String(e)); }
  }

  const active = items.find(x => x.is_active);

  return (
    <>
      <h1 className="page-title">指令（Prompt）管理</h1>
      <p className="page-sub">
        热更新 prompt，无需重新部署。同 biz_type × provider 同时只有一个 active；旧缓存因 key 含 prompt_version 自动失效。
      </p>
      {err && <div className="error">{err}</div>}
      <div className="toolbar">
        <div>
          <label>biz_type</label>
          <select value={biz} onChange={(e) => setBiz(e.target.value)}>
            {BIZ.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label>provider</label>
          <select value={prov} onChange={(e) => setProv(e.target.value)}>
            {PROV.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="grow"></div>
        <button className="btn" onClick={() => setShowNew(true)}>+ 发布新版本</button>
        <button className="btn secondary" onClick={() => setDryRun(active?.content ?? "")}>
          干跑测试
        </button>
      </div>

      {active && (
        <div className="card">
          <h3>当前 active（v{active.version}）· by {active.created_by ?? "system"} · {new Date(active.created_at).toLocaleString()}</h3>
          <pre>{active.content}</pre>
        </div>
      )}

      <div className="card">
        <h3>历史版本</h3>
        <table>
          <thead>
            <tr>
              <th>版本</th><th>状态</th><th>作者</th><th>时间</th><th>长度</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map(x => (
              <tr key={x.id}>
                <td><code>v{x.version}</code></td>
                <td>{x.is_active ? <span className="pill pass">active</span> : <span className="pill pending">inactive</span>}</td>
                <td className="muted">{x.created_by ?? "—"}</td>
                <td className="muted monospace">{new Date(x.created_at).toLocaleString()}</td>
                <td>{x.content.length} 字</td>
                <td className="right">
                  <button className="btn small secondary" onClick={() => navigator.clipboard.writeText(x.content)}>复制</button>{" "}
                  {!x.is_active && <button className="btn small" onClick={() => rollback(x.id)}>回滚到此</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <NewPromptDialog
          biz={biz} prov={prov}
          initial={active?.content ?? ""}
          onClose={() => setShowNew(false)}
          onPublished={() => { setShowNew(false); load(); }}
        />
      )}
      {dryRun !== null && (
        <DryRunDialog
          biz={biz} prov={prov} content={dryRun}
          onClose={() => setDryRun(null)}
        />
      )}
    </>
  );
}

function NewPromptDialog({ biz, prov, initial, onClose, onPublished }: {
  biz: string; prov: string; initial: string; onClose: () => void; onPublished: () => void;
}) {
  const [content, setContent] = useState(initial);
  const [by, setBy] = useState("admin");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!window.confirm("确认发布？旧版本立即被替换为 inactive，下次请求起全线生效。")) return;
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
        <h3>发布新 prompt · {biz} × {prov}</h3>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>Prompt 正文</label>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} required style={{ minHeight: 360 }} />
          </div>
          <div className="form-row">
            <label>发布人（便于追踪）</label>
            <input value={by} onChange={(e) => setBy(e.target.value)} maxLength={64} />
          </div>
          {err && <div className="error">{err}</div>}
          <div className="mt16">
            <button className="btn" disabled={busy || !content}>发布</button>{" "}
            <button className="btn secondary" type="button" onClick={onClose}>取消</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DryRunDialog({ biz, prov, content, onClose }: {
  biz: string; prov: string; content: string; onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(content);
  const [samples, setSamples] = useState("测试样本1\n测试样本2");
  const [results, setResults] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true); setResults(null);
    try {
      const r = await Prompts.dryRun({
        biz_type: biz, provider: prov, content: prompt,
        samples: samples.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 20),
      });
      setResults(r.results as any[]);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{maxWidth: 900}}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>干跑 · {biz} × {prov}</h3>
        <p className="muted">用临时 prompt 对一组样本做预览，不影响线上 active 版本。</p>
        <form onSubmit={run}>
          <div className="form-row">
            <label>Prompt（可编辑）</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 200 }} />
          </div>
          <div className="form-row">
            <label>样本（每行一个，最多 20）</label>
            <textarea value={samples} onChange={(e) => setSamples(e.target.value)} style={{ minHeight: 120 }} />
          </div>
          {err && <div className="error">{err}</div>}
          <div className="mt8">
            <button className="btn" disabled={busy || !prompt}>{busy ? "运行中…" : "运行"}</button>{" "}
            <button className="btn secondary" type="button" onClick={onClose}>关闭</button>
          </div>
        </form>
        {results && (
          <div className="mt16">
            <h3>结果</h3>
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
                      <span className="k">schema_ok</span>
                      <span className="v">{r.schema_ok ? "✓" : <span className="error">×</span>}</span>
                      <span className="k">parsed</span>
                      <pre className="v" style={{ margin: 0 }}>{JSON.stringify(r.parsed, null, 2)}</pre>
                      <span className="k">tokens</span>
                      <span className="v">in={r.tokens?.input ?? 0} out={r.tokens?.output ?? 0} · {r.latency_ms ?? 0}ms</span>
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
