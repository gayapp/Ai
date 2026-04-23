import { useEffect, useState } from "react";
import { Apps, type AppConfig, type ProviderStrategy } from "../lib/api";

const BIZ_TYPES = ["comment", "nickname", "bio", "avatar"] as const;
const STRATEGIES: Array<{ value: ProviderStrategy; label: string; hint: string }> = [
  { value: "auto",        label: "auto（默认）",      hint: "文本→Grok, 头像→Gemini" },
  { value: "grok",        label: "grok",             hint: "文本用 Grok（头像仍 Gemini）" },
  { value: "gemini",      label: "gemini",           hint: "文本用 Gemini" },
  { value: "round_robin", label: "round_robin（轮流）", hint: "文本 Grok/Gemini 每秒切换" },
];

const STRATEGY_PILL_COLOR: Record<ProviderStrategy, string> = {
  auto: "", grok: "grok", gemini: "gemini", round_robin: "cached",
};

export default function AppsPage() {
  const [items, setItems] = useState<AppConfig[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [justCreated, setJustCreated] = useState<{ id: string; secret: string } | null>(null);
  const [rotated, setRotated] = useState<{ id: string; secret: string } | null>(null);
  const [editingStrategy, setEditingStrategy] = useState<AppConfig | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await Apps.list();
      setItems(r.items);
    } catch (e) { setErr(String(e)); }
  }
  useEffect(() => { load(); }, []);

  async function rotate(id: string) {
    if (!window.confirm(`确认轮换 ${id} 的 secret？旧 secret 会立即失效。`)) return;
    try {
      const r = await Apps.rotate(id);
      setRotated(r);
    } catch (e) { setErr(String(e)); }
  }

  async function toggleDisable(app: AppConfig) {
    if (!window.confirm(`确认${app.disabled ? "启用" : "禁用"} ${app.id}？`)) return;
    try {
      await Apps.patch(app.id, { disabled: !app.disabled });
      load();
    } catch (e) { setErr(String(e)); }
  }

  return (
    <>
      <h1 className="page-title">应用管理</h1>
      <p className="page-sub">为每个业务应用签发 app_id + secret；应用用 HMAC 调用 /v1/moderate。</p>
      {err && <div className="error">{err}</div>}
      <div className="toolbar">
        <button className="btn" onClick={() => setShowNew(true)}>+ 新建应用</button>
        <button className="btn secondary small" onClick={load}>刷新</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>app_id</th><th>名称</th><th>AI 策略</th><th>回调 URL</th><th>biz_types</th>
            <th>QPS</th><th>状态</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={8}><div className="empty">暂无应用</div></td></tr>
          ) : items.map(a => (
            <tr key={a.id}>
              <td><code>{a.id}</code></td>
              <td>{a.name}</td>
              <td>
                <span className={`pill ${STRATEGY_PILL_COLOR[a.provider_strategy]}`}>{a.provider_strategy}</span>
                {" "}
                <button className="btn small secondary" onClick={() => setEditingStrategy(a)}>改</button>
              </td>
              <td style={{ maxWidth: 240 }} className="wrap"><code>{a.callback_url ?? "—"}</code></td>
              <td>{a.biz_types.map(b => <span key={b} className="pill" style={{marginRight:4}}>{b}</span>)}</td>
              <td>{a.rate_limit_qps}</td>
              <td>{a.disabled ? <span className="pill reject">disabled</span> : <span className="pill pass">active</span>}</td>
              <td className="right">
                <button className="btn small secondary" onClick={() => rotate(a.id)}>轮换 secret</button>{" "}
                <button className="btn small secondary" onClick={() => toggleDisable(a)}>{a.disabled ? "启用" : "禁用"}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showNew && <NewAppDialog onClose={() => setShowNew(false)} onCreated={(r) => { setShowNew(false); setJustCreated(r); load(); }} />}
      {justCreated && <SecretDialog title="应用已创建 — 请立即保存 secret" data={justCreated} onClose={() => setJustCreated(null)} />}
      {rotated && <SecretDialog title="Secret 已轮换 — 请立即保存新 secret" data={rotated} onClose={() => setRotated(null)} />}
      {editingStrategy && (
        <StrategyDialog app={editingStrategy}
          onClose={() => setEditingStrategy(null)}
          onSaved={() => { setEditingStrategy(null); load(); }} />
      )}
    </>
  );
}

function StrategyDialog({ app, onClose, onSaved }: {
  app: AppConfig; onClose: () => void; onSaved: () => void;
}) {
  const [v, setV] = useState<ProviderStrategy>(app.provider_strategy);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      await Apps.patch(app.id, { provider_strategy: v });
      onSaved();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{maxWidth:520}}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>修改 AI 策略 · {app.name}</h3>
        <p className="muted" style={{fontSize:12}}>
          策略控制文本类审核用哪家模型；头像（avatar）无论如何都走 Gemini（Grok 无 Vision）。
          更换策略不影响历史缓存，仅对后续请求生效。
        </p>
        <div className="form-row">
          {STRATEGIES.map(s => (
            <label key={s.value}
              style={{display:"block",padding:"10px 12px",marginBottom:8,
                      background: v===s.value?"var(--panel-2)":"transparent",
                      border: `1px solid ${v===s.value?"var(--accent)":"var(--border)"}`,
                      borderRadius:6,cursor:"pointer",textTransform:"none"}}>
              <input type="radio" name="strategy" checked={v===s.value} onChange={()=>setV(s.value)} style={{width:"auto",marginRight:8}} />
              <strong>{s.label}</strong>
              <div className="muted" style={{fontSize:12,marginTop:2,marginLeft:22}}>{s.hint}</div>
            </label>
          ))}
        </div>
        {err && <div className="error">{err}</div>}
        <div className="mt8">
          <button className="btn" disabled={busy||v===app.provider_strategy} onClick={save}>保存</button>{" "}
          <button className="btn secondary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

function NewAppDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { id: string; secret: string }) => void }) {
  const [name, setName] = useState("");
  const [cb, setCb] = useState("");
  const [biz, setBiz] = useState<Set<string>>(new Set(["comment", "nickname", "bio"]));
  const [qps, setQps] = useState(50);
  const [strategy, setStrategy] = useState<ProviderStrategy>("auto");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await Apps.create({
        name,
        callback_url: cb || undefined,
        biz_types: Array.from(biz),
        rate_limit_qps: qps,
        provider_strategy: strategy,
      });
      onCreated({ id: r.id, secret: r.secret });
    } catch (e) {
      setErr(String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>新建应用</h3>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
          </div>
          <div className="form-row">
            <label>默认回调 URL（可留空，请求里再指定）</label>
            <input type="url" value={cb} onChange={(e) => setCb(e.target.value)} placeholder="https://your-app.com/hooks/moderate" />
          </div>
          <div className="form-row">
            <label>启用的业务类型</label>
            <div>
              {BIZ_TYPES.map(b => (
                <label key={b} style={{ display: "inline-flex", gap: 4, marginRight: 16, textTransform: "none" }}>
                  <input type="checkbox" checked={biz.has(b)} style={{ width: "auto" }}
                    onChange={(e) => {
                      const n = new Set(biz);
                      e.target.checked ? n.add(b) : n.delete(b);
                      setBiz(n);
                    }} /> {b}
                </label>
              ))}
            </div>
          </div>
          <div className="form-row">
            <label>Rate Limit (QPS)</label>
            <input type="number" value={qps} onChange={(e) => setQps(parseInt(e.target.value) || 50)} min={1} max={10000} />
          </div>
          <div className="form-row">
            <label>AI 策略</label>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as ProviderStrategy)}>
              {STRATEGIES.map(s => (
                <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>
              ))}
            </select>
          </div>
          {err && <div className="error">{err}</div>}
          <div className="mt16">
            <button className="btn" type="submit" disabled={busy || !name || biz.size === 0}>创建</button>{" "}
            <button className="btn secondary" type="button" onClick={onClose}>取消</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SecretDialog({ title, data, onClose }: { title: string; data: { id: string; secret: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(data.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>{title}</h3>
        <div className="error">⚠️ 此 secret 仅此一次可见。一旦关闭，只能通过轮换生成新的。</div>
        <div className="kv-grid mt16">
          <span className="k">app_id</span><code className="v">{data.id}</code>
          <span className="k">secret</span><code className="v wrap">{data.secret}</code>
        </div>
        <div className="mt16">
          <button className="btn" onClick={copy}>{copied ? "已复制 ✓" : "复制 secret"}</button>{" "}
          <button className="btn secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
