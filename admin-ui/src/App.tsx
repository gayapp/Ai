import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Apps from "./pages/Apps";
import Prompts from "./pages/Prompts";
import Requests from "./pages/Requests";
import Callbacks from "./pages/Callbacks";
import AlertsPage from "./pages/Alerts";
import { clearToken, getApiBase, getToken } from "./lib/api";

export default function App() {
  const [authed, setAuthed] = useState<boolean>(!!getToken());
  if (!authed) {
    return (
      <Routes>
        <Route path="*" element={<Login onAuthed={() => setAuthed(true)} />} />
      </Routes>
    );
  }
  return (
    <Layout onLogout={() => { clearToken(); setAuthed(false); }}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/apps" element={<Apps />} />
        <Route path="/prompts" element={<Prompts />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/callbacks" element={<Callbacks />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}

function Layout({ children, onLogout }: { children: React.ReactNode; onLogout: () => void }) {
  const loc = useLocation();
  const nav = useNavigate();
  return (
    <div className="layout">
      <header>
        <div className="brand"><span className="logo">🛡</span> ai-guard · Admin</div>
        <div className="header-right">
          <span className="muted">{getApiBase()}</span>
          <button className="btn small secondary" onClick={() => { onLogout(); nav("/"); }}>
            退出
          </button>
        </div>
      </header>
      <aside>
        <div className="nav-section">监控</div>
        <NavLink className={({isActive}) => "nav-item" + (isActive ? " active" : "")} to="/dashboard">
          📊 总览
        </NavLink>
        <NavLink className={({isActive}) => "nav-item" + (isActive ? " active" : "")} to="/requests">
          📝 审核记录
        </NavLink>
        <NavLink className={({isActive}) => "nav-item" + (isActive ? " active" : "")} to="/callbacks">
          📮 回调投递
        </NavLink>

        <div className="nav-section">配置</div>
        <NavLink className={({isActive}) => "nav-item" + (isActive ? " active" : "")} to="/apps">
          📦 应用管理
        </NavLink>
        <NavLink className={({isActive}) => "nav-item" + (isActive ? " active" : "")} to="/prompts">
          💬 指令管理
        </NavLink>
        <NavLink className={({isActive}) => "nav-item" + (isActive ? " active" : "")} to="/alerts">
          🔔 告警
        </NavLink>

        <div className="nav-section">链接</div>
        <a className="nav-item" href="https://aicenter-api.1.gay/architecture" target="_blank" rel="noreferrer">
          📐 架构文档
        </a>
        <a className="nav-item" href="https://github.com/gayapp/Ai" target="_blank" rel="noreferrer">
          💾 GitHub
        </a>
      </aside>
      <main key={loc.pathname}>{children}</main>
    </div>
  );
}
