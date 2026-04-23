import { useState } from "react";
import { getApiBase, setApiBase, setToken, api } from "../lib/api";

export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const [token, setTok] = useState("");
  const [base, setBase] = useState(getApiBase());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    setApiBase(base.trim().replace(/\/+$/, ""));
    setToken(token.trim());
    try {
      // Verify by hitting a lightweight admin endpoint
      await api("/admin/apps");
      onAuthed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-box">
      <h1>🛡 ai-guard</h1>
      <p className="sub">粘贴 ADMIN_TOKEN 登录管理后台</p>
      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="base">API Base</label>
          <input id="base" value={base} onChange={(e) => setBase(e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor="token">ADMIN_TOKEN</label>
          <input id="token" type="password" value={token}
                 onChange={(e) => setTok(e.target.value)}
                 placeholder="64 hex chars" autoFocus autoComplete="off" />
        </div>
        {err && <div className="error mt8">{err}</div>}
        <div className="mt16">
          <button className="btn" disabled={!token || busy} type="submit">
            {busy ? "验证中…" : "登录"}
          </button>
        </div>
      </form>
      <p className="muted mt16" style={{ fontSize: 12 }}>
        Token 存在浏览器 localStorage。不共享电脑的话安全；共享请登出。
      </p>
    </div>
  );
}
