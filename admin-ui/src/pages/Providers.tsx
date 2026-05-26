import { useEffect, useState } from "react";
import {
  Alerts,
  Providers,
  type ProviderHealthData,
  type ProviderStatusData,
} from "../lib/api";
import { ProviderPill, StatusPill } from "../components/common";

export default function ProvidersPage() {
  const [status, setStatus] = useState<ProviderStatusData | null>(null);
  const [health, setHealth] = useState<ProviderHealthData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [geminiModel, setGeminiModel] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setErr(null);
    setLoading(true);
    try {
      const next = await Providers.status();
      setStatus(next);
      setGeminiModel(next.models.gemini);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runHealthCheck() {
    if (!window.confirm("Run provider health check? It may send Telegram alerts if a provider is unhealthy.")) return;
    setErr(null);
    setChecking(true);
    setHealth(null);
    try {
      setHealth(await Alerts.providerHealth());
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  async function saveModel() {
    setErr(null);
    setSavingModel(true);
    try {
      const next = await Providers.updateModels({ gemini: geminiModel });
      setStatus((current) => current ? { ...current, ...next } : current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingModel(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Provider 状态</h1>
      <p className="page-sub">只读查看模型配置与熔断状态；手动 health check 会真实请求上游，并可能触发告警。</p>
      {err && <div className="error">{err}</div>}

      <div className="toolbar">
        <button className="btn small secondary" disabled={loading} onClick={load}>
          {loading ? "Loading" : "Refresh"}
        </button>
        <button className="btn small" disabled={checking} onClick={runHealthCheck}>
          {checking ? "Checking" : "Run health check"}
        </button>
      </div>

      {status && (
        <>
          <div className="metric-grid">
            <Metric label="Grok key" value={status.secrets.grok_configured ? "configured" : "missing"} color={status.secrets.grok_configured ? "good" : "bad"} />
            <Metric label="Gemini key" value={status.secrets.gemini_configured ? "configured" : "missing"} color={status.secrets.gemini_configured ? "good" : "bad"} />
            <Metric label="Grok model" value={<code>{status.models.grok}</code>} />
            <Metric label="Gemini model" value={<code>{status.models.gemini}</code>} color={status.model_source.gemini === "kv" ? "good" : undefined} />
          </div>

          <div className="card">
            <h3>Model settings</h3>
            <div className="form-grid two">
              <label>
                Gemini model
                <select value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)}>
                  {status.model_options.gemini.map((model) => (
                    <option key={model} value={model}>
                      {model === "gemini-2.5-flash-lite" ? `${model} (recommended)` : model}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Source
                <input value={status.model_source.gemini} disabled />
              </label>
            </div>
            <div className="toolbar mt8">
              <button className="btn small" disabled={savingModel || !geminiModel || geminiModel === status.models.gemini} onClick={saveModel}>
                {savingModel ? "Saving" : "Save model"}
              </button>
            </div>
            <div className="muted mt8" style={{ fontSize: 12 }}>
              The saved Gemini model is stored in KV and takes effect immediately for dry-runs, moderate fallback, and analyze fallback.
            </div>
          </div>

          <div className="card">
            <h3>Circuit breakers</h3>
            <table>
              <thead>
                <tr><th>Provider</th><th>Scope</th><th>State</th><th>Failures</th><th>Open until</th><th>Last failure</th></tr>
              </thead>
              <tbody>
                {status.circuits.map((c) => (
                  <tr key={`${c.provider}:${c.biz_type ?? "global"}`}>
                    <td><ProviderPill v={c.provider} /></td>
                    <td>{c.biz_type ? <code>{c.biz_type}</code> : <span className="muted">global</span>}</td>
                    <td>
                      <span className={`pill ${c.state === "closed" ? "pass" : c.state === "half_open" ? "review" : "reject"}`}>
                        {c.state}
                      </span>
                      {c.seconds_to_close > 0 && <span className="muted"> {c.seconds_to_close}s</span>}
                    </td>
                    <td className="monospace">{c.failures}</td>
                    <td className="monospace">{c.open_until ? new Date(c.open_until).toLocaleString() : "-"}</td>
                    <td className="monospace">{c.last_failure_at ? new Date(c.last_failure_at).toLocaleString() : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted mt8" style={{ fontSize: 12 }}>
              Global scopes cover moderate routing. media_analysis / media_intro scopes cover analyze fallback routing.
            </div>
          </div>
        </>
      )}

      {health && (
        <div className="card">
          <h3>Last health check</h3>
          <div className="kv-grid">
            <span className="k">grok</span>
            <span className="v"><StatusPill v={health.grok.ok ? "ok" : "error"} /> {health.grok.reason ?? ""}</span>
            <span className="k">gemini</span>
            <span className="v"><StatusPill v={health.gemini.ok ? "ok" : "error"} /> {health.gemini.reason ?? ""}</span>
            <span className="k">alerts fired</span>
            <span className="v">{health.fired.length ? health.fired.join(", ") : "-"}</span>
          </div>
          <pre className="mt16">{JSON.stringify(health, null, 2)}</pre>
        </div>
      )}
    </>
  );
}

function Metric({ label, value, color }: { label: string; value: React.ReactNode; color?: "bad" | "warn" | "good" }) {
  const style = color === "bad" ? { color: "var(--bad)" }
              : color === "warn" ? { color: "var(--warn)" }
              : color === "good" ? { color: "var(--good)" } : undefined;
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value" style={style}>{value}</div>
    </div>
  );
}
