import { useEffect, useMemo, useState } from "react";
import {
  Apps,
  Stats,
  type AnalyzeBacklogBucket,
  type AnalyzeBacklogData,
  type AnalyzeGrayData,
  type AppConfig,
  type PercentileData,
} from "../lib/api";
import { StatusPill } from "../components/common";

type Period = "1h" | "24h" | "7d";

const PERIODS: Period[] = ["1h", "24h", "7d"];

const GATE_LABELS: Record<string, string> = {
  has_samples: "有样本",
  error_rate_under_1_percent: "错误率 < 1%",
  no_pending_older_than_5m: "无超过 5 分钟 pending",
  dedup_hit_rate_at_least_30_percent: "缓存命中率 >= 30%",
  latency_within_1_5x_baseline: "P95 <= IRC 基线 1.5x",
};

export default function AnalyzeOpsPage() {
  const [apps, setApps] = useState<AppConfig[]>([]);
  const [appId, setAppId] = useState("");
  const [period, setPeriod] = useState<Period>("24h");
  const [baseline, setBaseline] = useState("15000");
  const [limit, setLimit] = useState(10000);
  const [data, setData] = useState<AnalyzeGrayData | null>(null);
  const [backlog, setBacklog] = useState<AnalyzeBacklogData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const analyzeApps = useMemo(
    () => apps.filter((app) => app.analyze_biz_types.length > 0),
    [apps],
  );
  const selectedApp = useMemo(
    () => apps.find((app) => app.id === appId) ?? null,
    [apps, appId],
  );

  useEffect(() => { Apps.list().then((r) => setApps(r.items)).catch(() => {}); }, []);
  useEffect(() => { load(); }, [appId, period]);

  async function load() {
    setErr(null);
    setLoading(true);
    const { from, to } = periodRange(period);
    const baselineNum = Number(baseline);
    try {
      const query = {
        app_id: appId || undefined,
        from,
        to,
      };
      const [gray, backlogData] = await Promise.all([
        Stats.analyzeGray({
          ...query,
          limit,
          baseline_p95_ms: Number.isFinite(baselineNum) && baselineNum > 0 ? baselineNum : undefined,
        }),
        Stats.analyzeBacklog(query),
      ]);
      setData(gray);
      setBacklog(backlogData);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const recordsHref = buildRecordsHref({ appId, period });
  const errorHref = buildRecordsHref({ appId, period, status: "error" });

  async function copyReport() {
    if (!data) return;
    const report = buildGrayReport({
      data,
      backlog,
      appName: selectedApp ? `${selectedApp.name} (${selectedApp.id})` : "all analyze apps",
      period,
      baseline,
    });
    await navigator.clipboard.writeText(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <>
      <h1 className="page-title">Analyze 灰度</h1>
      <p className="page-sub">查看内容服务灰度门禁、交付积压、延迟分位和错误分布；IRC 升档前以这里为主。</p>

      {err && <div className="error">{err}</div>}

      <div className="toolbar">
        <div>
          <label>app</label>
          <select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">全部 analyze apps</option>
            {analyzeApps.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
          </select>
        </div>
        <div>
          <label>window</label>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label>IRC baseline p95 ms</label>
          <input value={baseline} onChange={(e) => setBaseline(e.target.value)} inputMode="numeric" />
        </div>
        <div>
          <label>sample limit</label>
          <select value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10))}>
            {[1000, 5000, 10000, 50000].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button className="btn small secondary" disabled={loading} onClick={load}>
          {loading ? "Checking" : "Refresh"}
        </button>
        <button className="btn small secondary" disabled={!data} onClick={copyReport}>
          {copied ? "Copied" : "Copy report"}
        </button>
      </div>

      {data && (
        <>
          <div className="metric-grid">
            <Metric label="Ready" value={data.ready_for_next_stage ? "YES" : "NO"} color={data.ready_for_next_stage ? "good" : "bad"} />
            <Metric label="Samples" value={data.sample_size} />
            <Metric label="Error rate" value={pct(data.status.error_rate)} color={data.status.error_rate >= 0.01 ? "bad" : "good"} />
            <Metric label="OK rate" value={pct(data.status.ok_rate)} />
            <Metric label="P95 latency" value={fmtMs(data.latency_ms.p95)} color={latencyColor(data)} />
            <Metric label="Pull unacked" value={data.delivery.pull_unacked} color={data.delivery.pull_unacked > 0 ? "warn" : "good"} />
            <Metric label="Callback undelivered" value={data.delivery.callback_undelivered} color={data.delivery.callback_undelivered > 0 ? "warn" : "good"} />
            <Metric label="Dedup hit" value={pct(data.dedup.hit_rate)} color={data.dedup.hit_rate >= data.dedup.expected_min_hit_rate ? "good" : "warn"} />
          </div>

          {backlog && (
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3 style={{ margin: 0 }}>Backlog</h3>
                <a href={buildRecordsHref({ appId, period, status: "pending" })}>查看 pending</a>
              </div>
              <div className="metric-grid mt16">
                <BacklogMetric label="Pending" bucket={backlog.pending} warnAt={1} badAt={1} />
                <BacklogMetric label="Pull unacked" bucket={backlog.pull_unacked} warnAt={1} badAt={20} />
                <BacklogMetric label="Callback undelivered" bucket={backlog.callback_undelivered} warnAt={1} badAt={20} />
              </div>
              <table>
                <thead>
                  <tr><th>Queue</th><th>&lt;5m</th><th>5m-30m</th><th>30m-2h</th><th>&gt;2h</th><th>Oldest</th></tr>
                </thead>
                <tbody>
                  <BacklogRow label="pending" bucket={backlog.pending} />
                  <BacklogRow label="pull_unacked" bucket={backlog.pull_unacked} />
                  <BacklogRow label="callback_undelivered" bucket={backlog.callback_undelivered} />
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>灰度门禁</h3>
              <div className="row">
                <a href={recordsHref}>查看记录</a>
                <a href={errorHref}>只看错误</a>
              </div>
            </div>
            <div className="mt8">
              <table>
                <thead>
                  <tr><th>Gate</th><th>Status</th><th>Context</th></tr>
                </thead>
                <tbody>
                  {Object.entries(data.gates).map(([key, ok]) => (
                    <tr key={key}>
                      <td>{GATE_LABELS[key] ?? key}</td>
                      <td>{ok ? <span className="pill pass">pass</span> : <span className="pill reject">block</span>}</td>
                      <td className="muted">{gateContext(key, data)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="metric-grid">
            <Distribution title="Status" rows={data.status.by_status} />
            <Distribution title="biz_type" rows={data.by_biz_type} />
            <Distribution title="error_code" rows={data.error_codes} empty="No errors" />
          </div>

          <div className="card">
            <h3>Latency / Tokens</h3>
            <table>
              <thead>
                <tr><th>Metric</th><th>Count</th><th>P50</th><th>P95</th><th>P99</th><th>Max</th></tr>
              </thead>
              <tbody>
                <PercentileRow label="latency_ms" value={data.latency_ms} fmt={fmtMs} />
                <PercentileRow label="input_tokens" value={data.tokens.input} fmt={fmtNum} />
                <PercentileRow label="output_tokens" value={data.tokens.output} fmt={fmtNum} />
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>窗口</h3>
            <div className="kv-grid">
              <span className="k">from</span><code className="v">{data.from}</code>
              <span className="k">to</span><code className="v">{data.to}</code>
              <span className="k">app_id</span><code className="v">{data.app_id ?? "all"}</code>
              <span className="k">sample_limit</span><span className="v">{data.sample_limit}</span>
              <span className="k">baseline_p95</span><span className="v">{fmtMs(data.baseline.internal_p95_ms)}</span>
              <span className="k">allowed_p95</span><span className="v">{fmtMs(data.baseline.max_allowed_p95_ms)}</span>
              <span className="k">p95_ratio</span><span className="v">{data.baseline.p95_ratio === null ? "-" : data.baseline.p95_ratio.toFixed(2) + "x"}</span>
              <span className="k">stale pending</span><span className="v">{data.status.pending_older_than_5m}</span>
            </div>
          </div>
        </>
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

function BacklogMetric({ label, bucket, warnAt, badAt }: {
  label: string;
  bucket: AnalyzeBacklogBucket;
  warnAt: number;
  badAt: number;
}) {
  const color = bucket.older_than_5m >= badAt ? "bad" : bucket.total >= warnAt ? "warn" : "good";
  return (
    <Metric
      label={label}
      value={bucket.total}
      color={color}
    />
  );
}

function BacklogRow({ label, bucket }: { label: string; bucket: AnalyzeBacklogBucket }) {
  return (
    <tr>
      <td><code>{label}</code></td>
      <td className="monospace">{bucket.age_buckets.lt_5m}</td>
      <td className="monospace">{bucket.age_buckets.m5_30m}</td>
      <td className="monospace">{bucket.age_buckets.m30_2h}</td>
      <td className="monospace">{bucket.age_buckets.gt_2h}</td>
      <td className="monospace">{bucket.oldest_at ? new Date(bucket.oldest_at).toLocaleString() : "-"}</td>
    </tr>
  );
}

function Distribution({ title, rows, empty = "No data" }: { title: string; rows: Record<string, number>; empty?: string }) {
  const entries = Object.entries(rows).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return (
    <div className="card">
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <table>
          <thead>
            <tr><th>Type</th><th>Count</th><th>Share</th></tr>
          </thead>
          <tbody>
            {entries.map(([key, count]) => (
              <tr key={key}>
                <td><StatusOrText value={key} /></td>
                <td className="monospace">{count}</td>
                <td className="monospace">{total > 0 ? ((count / total) * 100).toFixed(1) : "0.0"}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusOrText({ value }: { value: string }) {
  if (value === "ok" || value === "pending" || value === "error") return <StatusPill v={value} />;
  return <code>{value}</code>;
}

function PercentileRow({ label, value, fmt }: { label: string; value: PercentileData; fmt: (n: number | null) => string }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="monospace">{value.count}</td>
      <td className="monospace">{fmt(value.p50)}</td>
      <td className="monospace">{fmt(value.p95)}</td>
      <td className="monospace">{fmt(value.p99)}</td>
      <td className="monospace">{fmt(value.max)}</td>
    </tr>
  );
}

function periodRange(period: Period): { from: string; to: string } {
  const hours = period === "1h" ? 1 : period === "24h" ? 24 : 24 * 7;
  const now = Date.now();
  return {
    from: new Date(now - hours * 3600 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  };
}

function buildRecordsHref(args: { appId: string; period: Period; status?: string }) {
  const params = new URLSearchParams();
  if (args.appId) params.set("app_id", args.appId);
  if (args.status) params.set("status", args.status);
  params.set("period", args.period);
  const s = params.toString();
  return `#/analyze-records${s ? `?${s}` : ""}`;
}

function gateContext(key: string, data: AnalyzeGrayData): string {
  switch (key) {
    case "has_samples":
      return `${data.sample_size} samples`;
    case "error_rate_under_1_percent":
      return `error=${pct(data.status.error_rate)}, errors=${data.status.by_status.error}`;
    case "no_pending_older_than_5m":
      return `${data.status.pending_older_than_5m} stale pending`;
    case "dedup_hit_rate_at_least_30_percent":
      return `${pct(data.dedup.hit_rate)} hit, expected >= ${pct(data.dedup.expected_min_hit_rate)}`;
    case "latency_within_1_5x_baseline":
      return `p95=${fmtMs(data.latency_ms.p95)}, allowed=${fmtMs(data.baseline.max_allowed_p95_ms)}`;
    default:
      return "";
  }
}

function latencyColor(data: AnalyzeGrayData): "bad" | "warn" | "good" | undefined {
  if (data.baseline.max_allowed_p95_ms === null || data.latency_ms.p95 === null) return undefined;
  if (data.latency_ms.p95 > data.baseline.max_allowed_p95_ms) return "bad";
  if (data.latency_ms.p95 > data.baseline.max_allowed_p95_ms * 0.8) return "warn";
  return "good";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtMs(n: number | null): string {
  return n === null ? "-" : `${Math.round(n)}ms`;
}

function fmtNum(n: number | null): string {
  if (n === null) return "-";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(1) + "M";
}

function buildGrayReport(args: {
  data: AnalyzeGrayData;
  backlog: AnalyzeBacklogData | null;
  appName: string;
  period: Period;
  baseline: string;
}): string {
  const { data, backlog } = args;
  const gates = Object.entries(data.gates)
    .map(([key, ok]) => `| ${GATE_LABELS[key] ?? key} | ${ok ? "PASS" : "BLOCK"} | ${gateContext(key, data)} |`)
    .join("\n");
  const errors = Object.entries(data.error_codes)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `| ${key} | ${count} |`)
    .join("\n") || "| - | 0 |";
  const biz = Object.entries(data.by_biz_type)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `| ${key} | ${count} |`)
    .join("\n") || "| - | 0 |";
  const backlogRows = backlog ? [
    backlogReportRow("pending", backlog.pending),
    backlogReportRow("pull_unacked", backlog.pull_unacked),
    backlogReportRow("callback_undelivered", backlog.callback_undelivered),
  ].join("\n") : "| - | - | - | - | - | - |";

  return [
    "# Analyze gray report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- App: ${args.appName}`,
    `- Window: ${args.period} (${data.from} to ${data.to})`,
    `- IRC baseline p95 ms: ${args.baseline || "-"}`,
    `- Sample size / limit: ${data.sample_size} / ${data.sample_limit}`,
    `- Ready for next stage: ${data.ready_for_next_stage ? "YES" : "NO"}`,
    "",
    "## Summary",
    "",
    `- OK rate: ${pct(data.status.ok_rate)}`,
    `- Error rate: ${pct(data.status.error_rate)} (${data.status.by_status.error} errors)`,
    `- Pending older than 5m: ${data.status.pending_older_than_5m}`,
    `- P95 latency: ${fmtMs(data.latency_ms.p95)} (allowed ${fmtMs(data.baseline.max_allowed_p95_ms)})`,
    `- Dedup hit rate: ${pct(data.dedup.hit_rate)} (expected >= ${pct(data.dedup.expected_min_hit_rate)})`,
    `- Pull unacked: ${data.delivery.pull_unacked}`,
    `- Callback undelivered: ${data.delivery.callback_undelivered}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Context |",
    "| --- | --- | --- |",
    gates,
    "",
    "## Backlog",
    "",
    "| Queue | Total | >5m | >30m | >2h | Oldest |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    backlogRows,
    "",
    "## biz_type",
    "",
    "| biz_type | Count |",
    "| --- | ---: |",
    biz,
    "",
    "## error_code",
    "",
    "| error_code | Count |",
    "| --- | ---: |",
    errors,
  ].join("\n");
}

function backlogReportRow(label: string, bucket: AnalyzeBacklogBucket): string {
  return `| ${label} | ${bucket.total} | ${bucket.older_than_5m} | ${bucket.older_than_30m} | ${bucket.older_than_2h} | ${bucket.oldest_at ?? "-"} |`;
}
