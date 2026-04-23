import { useState } from "react";
import { Stats, type ModerationRow } from "../lib/api";
import RequestDetail from "./RequestDetail";

export function StatusPill({ v }: { v: string | null | undefined }) {
  if (!v) return <span className="muted">—</span>;
  return <span className={`pill ${v}`}>{v}</span>;
}

export function RiskPill({ v }: { v: string | null | undefined }) {
  if (!v) return <span className="muted">—</span>;
  return <span className={`pill ${v}`}>{v}</span>;
}

export function ProviderPill({ v }: { v: string | null | undefined }) {
  if (!v) return <span className="muted">—</span>;
  return <span className={`pill ${v}`}>{v}</span>;
}

export function BoolPill({ v, trueLabel = "是" }: { v: boolean; trueLabel?: string }) {
  if (!v) return <span className="muted">—</span>;
  return <span className="pill cached">{trueLabel}</span>;
}

export function RequestRow({ r }: { r: ModerationRow }) {
  const [showId, setShowId] = useState<string | null>(null);
  return (
    <>
      <tr className="clickable" onClick={() => setShowId(r.id)}>
        <td className="monospace">{new Date(r.created_at).toLocaleString()}</td>
        <td>
          <div>{r.biz_type}</div>
          <div className="muted monospace" style={{ fontSize: 11 }}>{r.biz_id}</div>
        </td>
        <td><StatusPill v={r.status} /></td>
        <td><RiskPill v={r.risk_level} /></td>
        <td><ProviderPill v={r.provider} /></td>
        <td><BoolPill v={r.cached} /></td>
        <td className="monospace">{r.latency_ms}ms</td>
        <td style={{ maxWidth: 300 }} className="wrap">{r.reason || <span className="muted">—</span>}</td>
      </tr>
      {showId === r.id && (
        <RequestDetail id={showId} onClose={() => setShowId(null)} />
      )}
    </>
  );
}

export function formatBytes(n?: number): string {
  if (!n) return "0";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export async function toastError(e: unknown, setErr: (s: string | null) => void) {
  setErr(e instanceof Error ? e.message : String(e));
  setTimeout(() => setErr(null), 5000);
}

export function useConfirm() {
  return (msg: string): boolean => window.confirm(msg);
}

export { Stats };
