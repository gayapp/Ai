import { useEffect, useMemo, useState } from "react";
import {
  PromptRegression,
  Prompts,
  type PromptRegressionRunResult,
  type PromptRegressionSample,
  type PromptRegressionSet,
  type PromptRegressionSetSummary,
} from "../lib/api";

const BIZ_TYPES = ["media_analysis", "media_intro", "comment", "nickname", "bio", "avatar"] as const;
const ANALYZE_BIZ_TYPES = new Set(["media_analysis", "media_intro"]);

export default function PromptRegressionPage() {
  const [bizType, setBizType] = useState("media_analysis");
  const [provider, setProvider] = useState("xai");
  const [sets, setSets] = useState<PromptRegressionSetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState("IRC media_analysis regression");
  const [samplesText, setSamplesText] = useState(exampleSamples("media_analysis"));
  const [draftContent, setDraftContent] = useState("");
  const [result, setResult] = useState<PromptRegressionRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const providerOptions = useMemo(
    () => ANALYZE_BIZ_TYPES.has(bizType) ? ["xai", "gemini"] : ["grok", "gemini"],
    [bizType],
  );

  useEffect(() => {
    if (!providerOptions.includes(provider)) setProvider(providerOptions[0]);
  }, [provider, providerOptions]);

  useEffect(() => { loadSets(); loadActivePrompt(); }, [bizType, provider]);

  async function loadSets() {
    setErr(null);
    setLoading(true);
    try {
      const r = await PromptRegression.list({ biz_type: bizType, provider, limit: 50 });
      setSets(r.items);
      if (!r.items.some((item) => item.id === selectedId)) setSelectedId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadActivePrompt() {
    try {
      const r = await Prompts.list(bizType, provider);
      const active = r.items.find((item) => item.is_active);
      if (active) setDraftContent(active.content);
    } catch {
      setDraftContent("");
    }
  }

  async function selectSet(id: number) {
    setErr(null);
    setResult(null);
    try {
      const row = await PromptRegression.get(id);
      applySet(row);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function startNew() {
    setSelectedId(null);
    setName(`${bizType} regression`);
    setSamplesText(exampleSamples(bizType));
    setResult(null);
  }

  async function saveSet() {
    setErr(null);
    setSaving(true);
    try {
      const samples = parseSamplesText(samplesText);
      const row = selectedId
        ? await PromptRegression.patch(selectedId, { name, samples })
        : await PromptRegression.create({ name, biz_type: bizType, provider, samples });
      applySet(row);
      await loadSets();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function runSet() {
    if (!selectedId) return;
    setErr(null);
    setRunning(true);
    setResult(null);
    try {
      const r = await PromptRegression.run(selectedId, { draft_content: draftContent });
      setResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function applySet(row: PromptRegressionSet) {
    setSelectedId(row.id);
    setBizType(row.biz_type);
    setProvider(row.provider);
    setName(row.name);
    setSamplesText(JSON.stringify(samplesForEdit(row.samples), null, 2));
  }

  return (
    <>
      <h1 className="page-title">Prompt regression</h1>
      <p className="page-sub">Save sample sets, then compare draft prompt output with the active prompt before publishing.</p>
      {err && <div className="error">{err}</div>}

      <div className="toolbar">
        <div>
          <label>biz_type</label>
          <select value={bizType} onChange={(e) => setBizType(e.target.value)}>
            {BIZ_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label>provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <button className="btn small secondary" disabled={loading} onClick={loadSets}>
          {loading ? "Loading" : "Refresh"}
        </button>
        <button className="btn small secondary" onClick={startNew}>New set</button>
      </div>

      <div className="metric-grid">
        <div className="card">
          <h3>Sets</h3>
          <table>
            <thead>
              <tr><th>Name</th><th>Samples</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {sets.length === 0 && <tr><td colSpan={3}><div className="empty">No sets</div></td></tr>}
              {sets.map((set) => (
                <tr
                  key={set.id}
                  className="clickable"
                  onClick={() => selectSet(set.id)}
                  style={set.id === selectedId ? { background: "var(--panel-2)" } : undefined}
                >
                  <td>
                    <div>{set.name}</div>
                    <code>{set.id}</code>
                  </td>
                  <td className="monospace">{set.sample_count}</td>
                  <td className="monospace">{new Date(set.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Summary</h3>
          {result ? (
            <div className="kv-grid">
              <span className="k">active_version</span><span className="v">{result.active_version}</span>
              <span className="k">samples</span><span className="v">{result.sample_count}</span>
              <span className="k">changed</span><span className="v">{result.summary.changed ?? 0}</span>
              <span className="k">draft schema failures</span><span className="v">{result.summary.draft_schema_failures ?? 0}</span>
              <span className="k">expected failures</span><span className="v">{result.summary.draft_expected_failures ?? 0}</span>
            </div>
          ) : (
            <div className="empty">No run result</div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Set editor</h3>
        <div className="form-row">
          <label>name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-row">
          <label>samples JSON</label>
          <textarea value={samplesText} onChange={(e) => setSamplesText(e.target.value)} />
        </div>
        <div className="row">
          <button className="btn secondary" disabled={saving} onClick={saveSet}>
            {saving ? "Saving" : selectedId ? "Save changes" : "Create set"}
          </button>
          {selectedId && <code>set_id={selectedId}</code>}
        </div>
      </div>

      <div className="card">
        <h3>Draft compare</h3>
        <div className="form-row">
          <label>draft prompt</label>
          <textarea value={draftContent} onChange={(e) => setDraftContent(e.target.value)} />
        </div>
        <button className="btn" disabled={!selectedId || running || !draftContent.trim()} onClick={runSet}>
          {running ? "Running" : "Run draft vs active"}
        </button>
      </div>

      {result && (
        <div className="card">
          <h3>Results</h3>
          <table>
            <thead>
              <tr><th>Sample</th><th>Status</th><th>Active</th><th>Draft</th></tr>
            </thead>
            <tbody>
              {result.results.map((row) => (
                <tr key={row.name}>
                  <td>
                    <div>{row.name}</div>
                    <code>{row.changed ? "changed" : "same"}</code>
                  </td>
                  <td>
                    <div>{row.active_schema_ok ? <span className="pill pass">active ok</span> : <span className="pill reject">active fail</span>}</div>
                    <div className="mt8">{row.draft_schema_ok ? <span className="pill pass">draft ok</span> : <span className="pill reject">draft fail</span>}</div>
                    {row.draft_expected_match !== null && (
                      <div className="mt8">
                        {row.draft_expected_match ? <span className="pill pass">expected</span> : <span className="pill review">expected diff</span>}
                      </div>
                    )}
                  </td>
                  <td style={{ maxWidth: 420 }}><pre>{JSON.stringify(compactResult(row.active), null, 2)}</pre></td>
                  <td style={{ maxWidth: 420 }}><pre>{JSON.stringify(compactResult(row.draft), null, 2)}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function parseSamplesText(raw: string): PromptRegressionSample[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("samples JSON must be an array");
  return parsed.map((item, idx) => {
    if (!item || typeof item !== "object") throw new Error(`sample ${idx + 1} must be an object`);
    const row = item as Record<string, unknown>;
    const input = row.input;
    if (!row.name || typeof row.name !== "string") throw new Error(`sample ${idx + 1} needs name`);
    if (input === undefined) throw new Error(`sample ${idx + 1} needs input`);
    return {
      name: row.name,
      input: typeof input === "string" ? input : JSON.stringify(input),
      ...(Object.prototype.hasOwnProperty.call(row, "expected") ? { expected: row.expected } : {}),
    };
  });
}

function samplesForEdit(samples: PromptRegressionSample[]): Array<Record<string, unknown>> {
  return samples.map((sample) => ({
    name: sample.name,
    input: parseJsonOrString(sample.input),
    ...(Object.prototype.hasOwnProperty.call(sample, "expected") ? { expected: sample.expected } : {}),
  }));
}

function parseJsonOrString(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function compactResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(result.dry_run_mode ? { dry_run_mode: result.dry_run_mode } : {}),
    ...(Object.prototype.hasOwnProperty.call(result, "schema_ok") ? { schema_ok: result.schema_ok } : {}),
    ...(Object.prototype.hasOwnProperty.call(result, "input_schema_ok") ? { input_schema_ok: result.input_schema_ok } : {}),
    ...(result.parsed ? { parsed: result.parsed } : {}),
    ...(result.prompt_preview ? { prompt_preview: result.prompt_preview } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.tokens ? { tokens: result.tokens } : {}),
    ...(result.latency_ms ? { latency_ms: result.latency_ms } : {}),
    ...(result.model ? { model: result.model } : {}),
  };
}

function exampleSamples(bizType: string): string {
  if (bizType === "media_intro") {
    return JSON.stringify([
      {
        name: "short clip",
        input: {
          title: "Sample clip",
          duration_seconds: 45,
          style_hint: "concise",
        },
      },
    ], null, 2);
  }
  if (bizType === "media_analysis") {
    return JSON.stringify([
      {
        name: "single image",
        input: {
          image_urls: ["https://example.com/frame.jpg"],
          title: "Sample clip",
          frame_metadata: [{ timestamp_seconds: 0, quality_score: 0.9 }],
        },
      },
    ], null, 2);
  }
  return JSON.stringify([
    { name: "plain text", input: "hello world" },
  ], null, 2);
}
