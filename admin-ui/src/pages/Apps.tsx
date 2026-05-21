import { useEffect, useState } from "react";
import {
  Apps,
  type AppConfig,
  type DeliveryMode,
  type ProviderStrategy,
} from "../lib/api";

const MODERATE_BIZ = ["comment", "nickname", "bio", "avatar"];
const ANALYZE_BIZ = ["media_analysis", "media_intro"];
const DELIVERY: DeliveryMode[] = ["callback", "pull", "both"];
const STRATEGIES: ProviderStrategy[] = ["auto", "grok", "gemini", "round_robin"];

const BIZ_LABELS: Record<string, string> = {
  comment: "comment moderation",
  nickname: "nickname moderation",
  bio: "profile bio moderation",
  avatar: "avatar moderation",
  media_analysis: "IRC image/video frame analysis",
  media_intro: "IRC intro generation",
};

const STRATEGY_PILL_COLOR: Record<ProviderStrategy, string> = {
  auto: "",
  grok: "grok",
  gemini: "gemini",
  round_robin: "cached",
};

export default function AppsPage() {
  const [items, setItems] = useState<AppConfig[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<AppConfig | null>(null);
  const [justCreated, setJustCreated] = useState<{ id: string; secret: string } | null>(null);
  const [rotated, setRotated] = useState<{ id: string; secret: string } | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await Apps.list();
      setItems(r.items);
    } catch (e) { setErr(String(e)); }
  }
  useEffect(() => { load(); }, []);

  async function rotate(id: string) {
    if (!window.confirm(`Rotate secret for ${id}?`)) return;
    try {
      setRotated(await Apps.rotate(id));
    } catch (e) { setErr(String(e)); }
  }

  async function toggleDisable(app: AppConfig) {
    if (!window.confirm(`${app.disabled ? "Enable" : "Disable"} ${app.id}?`)) return;
    try {
      await Apps.patch(app.id, { disabled: !app.disabled });
      load();
    } catch (e) { setErr(String(e)); }
  }

  return (
    <>
      <h1 className="page-title">Apps</h1>
      <p className="page-sub">Manage moderate and analyze access for each application.</p>
      {err && <div className="error">{err}</div>}
      <div className="toolbar">
        <button className="btn" onClick={() => setShowNew(true)}>New app</button>
        <button className="btn secondary small" onClick={load}>Refresh</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>app_id</th><th>Name</th><th>Provider</th><th>moderate</th><th>analyze</th>
            <th>Delivery</th><th>Callback</th><th>QPS</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={10}><div className="empty">No apps</div></td></tr>
          ) : items.map((a) => (
            <tr key={a.id}>
              <td><code>{a.id}</code></td>
              <td>{a.name}</td>
              <td><span className={`pill ${STRATEGY_PILL_COLOR[a.provider_strategy]}`}>{a.provider_strategy}</span></td>
              <td>{a.biz_types.map((b) => <span key={b} className="pill" style={{ marginRight: 4 }}>{b}</span>)}</td>
              <td>{a.analyze_biz_types.map((b) => <span key={b} className="pill cached" style={{ marginRight: 4 }}>{b}</span>)}</td>
              <td>
                <span className="pill">{a.delivery_mode}</span>
                <div className="muted monospace" style={{ fontSize: 11 }}>max {a.callback_max_concurrency}</div>
              </td>
              <td style={{ maxWidth: 220 }} className="wrap"><code>{a.callback_url ?? "-"}</code></td>
              <td>{a.rate_limit_qps}</td>
              <td>{a.disabled ? <span className="pill reject">disabled</span> : <span className="pill pass">active</span>}</td>
              <td className="right">
                <button className="btn small secondary" onClick={() => setEditing(a)}>Edit</button>{" "}
                <button className="btn small secondary" onClick={() => rotate(a.id)}>Rotate</button>{" "}
                <button className="btn small secondary" onClick={() => toggleDisable(a)}>{a.disabled ? "Enable" : "Disable"}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showNew && <AppDialog onClose={() => setShowNew(false)} onCreated={(r) => { setShowNew(false); setJustCreated(r); load(); }} />}
      {editing && <AppDialog app={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {justCreated && <SecretDialog title="App created" data={justCreated} onClose={() => setJustCreated(null)} />}
      {rotated && <SecretDialog title="Secret rotated" data={rotated} onClose={() => setRotated(null)} />}
    </>
  );
}

function AppDialog({ app, onClose, onCreated, onSaved }: {
  app?: AppConfig;
  onClose: () => void;
  onCreated?: (r: { id: string; secret: string }) => void;
  onSaved?: () => void;
}) {
  const [name, setName] = useState(app?.name ?? "");
  const [cb, setCb] = useState(app?.callback_url ?? "");
  const [moderateBiz, setModerateBiz] = useState<Set<string>>(new Set(app?.biz_types ?? ["comment", "nickname", "bio"]));
  const [analyzeBiz, setAnalyzeBiz] = useState<Set<string>>(new Set(app?.analyze_biz_types ?? []));
  const [delivery, setDelivery] = useState<DeliveryMode>(app?.delivery_mode ?? "both");
  const [callbackMax, setCallbackMax] = useState(app?.callback_max_concurrency ?? 10);
  const [qps, setQps] = useState(app?.rate_limit_qps ?? 50);
  const [strategy, setStrategy] = useState<ProviderStrategy>(app?.provider_strategy ?? "auto");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const body = {
        name,
        callback_url: cb || undefined,
        biz_types: Array.from(moderateBiz),
        analyze_biz_types: Array.from(analyzeBiz),
        delivery_mode: delivery,
        callback_max_concurrency: callbackMax,
        rate_limit_qps: qps,
        provider_strategy: strategy,
      };
      if (app) {
        await Apps.patch(app.id, { ...body, callback_url: cb || null });
        onSaved?.();
      } else {
        const r = await Apps.create(body);
        onCreated?.({ id: r.id, secret: r.secret });
      }
    } catch (e) {
      setErr(String(e));
    } finally { setBusy(false); }
  }

  function applyModeratePreset() {
    setModerateBiz(new Set(["comment", "nickname", "bio", "avatar"]));
    setAnalyzeBiz(new Set());
    setDelivery("callback");
  }

  function applyIrcAnalyzePreset() {
    setName((current) => current || "IRC");
    setModerateBiz(new Set());
    setAnalyzeBiz(new Set(ANALYZE_BIZ));
    setDelivery("both");
    setCallbackMax(10);
    setQps(500);
    setStrategy("auto");
  }

  const hasAnyBiz = moderateBiz.size + analyzeBiz.size > 0;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <span className="dialog-close" onClick={onClose}>×</span>
        <h3>{app ? `Edit ${app.id}` : "New app"}</h3>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
          </div>
          <div className="form-row">
            <label>Default callback URL</label>
            <input type="url" value={cb} onChange={(e) => setCb(e.target.value)} placeholder="https://your-app.example/hook" />
          </div>
          <div className="form-row">
            <label>Presets</label>
            <div>
              <button className="btn small secondary" type="button" onClick={applyIrcAnalyzePreset}>IRC analyze</button>{" "}
              <button className="btn small secondary" type="button" onClick={applyModeratePreset}>moderate default</button>
              <div className="muted" style={{ marginTop: 6 }}>
                IRC analyze selects media_analysis + media_intro and uses delivery_mode=both.
              </div>
            </div>
          </div>
          <CheckboxGroup title="moderate biz_types" values={MODERATE_BIZ} selected={moderateBiz} onChange={setModerateBiz} />
          <CheckboxGroup title="analyze biz_types" values={ANALYZE_BIZ} selected={analyzeBiz} onChange={setAnalyzeBiz} />
          <div className="form-row-inline">
            <div>
              <label>delivery_mode</label>
              <select value={delivery} onChange={(e) => setDelivery(e.target.value as DeliveryMode)}>
                {DELIVERY.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label>callback max concurrency</label>
              <input type="number" value={callbackMax} onChange={(e) => setCallbackMax(parseInt(e.target.value) || 10)} min={1} max={100} />
            </div>
            <div>
              <label>Rate limit QPS</label>
              <input type="number" value={qps} onChange={(e) => setQps(parseInt(e.target.value) || 50)} min={1} max={10000} />
            </div>
          </div>
          <div className="form-row">
            <label>provider strategy</label>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as ProviderStrategy)}>
              {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {err && <div className="error">{err}</div>}
          <div className="mt16">
            <button className="btn" type="submit" disabled={busy || !name || !hasAnyBiz}>{app ? "Save" : "Create"}</button>{" "}
            <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CheckboxGroup({ title, values, selected, onChange }: {
  title: string;
  values: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <div className="form-row">
      <label>{title}</label>
      <div>
        {values.map((b) => (
          <label key={b} style={{ display: "inline-flex", gap: 6, marginRight: 16, textTransform: "none", alignItems: "baseline" }}>
            <input type="checkbox" checked={selected.has(b)} style={{ width: "auto" }}
              onChange={(e) => {
                const n = new Set(selected);
                e.target.checked ? n.add(b) : n.delete(b);
                onChange(n);
              }} />
            <code>{b}</code>
            <span className="muted">{BIZ_LABELS[b] ?? ""}</span>
          </label>
        ))}
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
        <div className="error">This secret is only visible once.</div>
        <div className="kv-grid mt16">
          <span className="k">app_id</span><code className="v">{data.id}</code>
          <span className="k">secret</span><code className="v wrap">{data.secret}</code>
        </div>
        <div className="mt16">
          <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy secret"}</button>{" "}
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
