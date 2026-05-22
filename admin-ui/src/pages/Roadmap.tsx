type Status = "Done" | "Next" | "Planned" | "Needs input" | "Deferred";

interface Task {
  id: string;
  priority: string;
  title: string;
  status: Status;
  reason: string;
  acceptance: string;
}

const TASKS: Task[] = [
  {
    id: "ADM-001",
    priority: "P0",
    title: "Apps 双轨配置",
    status: "Done",
    reason: "同时支持 moderate 与 analyze app 能力。",
    acceptance: "app 支持 biz_types 与 analyze_biz_types。",
  },
  {
    id: "ADM-002",
    priority: "P0",
    title: "IRC analyze 预设",
    status: "Done",
    reason: "降低 IRC 创建 app 时选错字段的风险。",
    acceptance: "New app 可一键选择 media_analysis / media_intro / both。",
  },
  {
    id: "ADM-003",
    priority: "P0",
    title: "Analyze records 页面",
    status: "Done",
    reason: "支持 IRC 按 biz_id / request_id 对账。",
    acceptance: "可按 app / biz / status / delivery / biz_id / window 查询。",
  },
  {
    id: "ADM-004",
    priority: "P0",
    title: "Analyze 灰度页",
    status: "Done",
    reason: "IRC 升档前需要可视化 gate。",
    acceptance: "展示 ready gate、错误率、P95、dedup、交付状态。",
  },
  {
    id: "ADM-005",
    priority: "P0",
    title: "Analyze backlog",
    status: "Done",
    reason: "排查 pending、pull 未 ack、callback 未投递。",
    acceptance: "展示 pending / pull_unacked / callback_undelivered 年龄桶。",
  },
  {
    id: "ADM-006",
    priority: "P0",
    title: "Provider 状态页",
    status: "Done",
    reason: "不触发上游请求也能看熔断和配置。",
    acceptance: "展示模型、secret 配置、global/analyze circuit。",
  },
  {
    id: "ADM-007",
    priority: "P0",
    title: "App onboarding",
    status: "Done",
    reason: "创建 app 后直接给 IRC 可用配置。",
    acceptance: "创建/轮换 secret 后展示 IRC env、pull/ack、HMAC。",
  },
  {
    id: "ADM-008",
    priority: "P0",
    title: "Analyze prompt dry-run",
    status: "Done",
    reason: "发布 prompt 前至少能做轻量校验。",
    acceptance: "media_intro provider 干跑；media_analysis schema + prompt preview。",
  },
  {
    id: "ADM-009",
    priority: "P0",
    title: "审计日志",
    status: "Done",
    reason: "记录后台高影响操作。",
    acceptance: "记录 app create/update/rotate-secret 与 prompt publish/rollback。",
  },
  {
    id: "ADM-010",
    priority: "P1",
    title: "Roadmap / 任务清单页面",
    status: "Next",
    reason: "让后续开发计划在后台可见。",
    acceptance: "Admin UI 有 /roadmap，文档有任务清单。",
  },
  {
    id: "ADM-011",
    priority: "P1",
    title: "Analyze 灰度报告复制",
    status: "Next",
    reason: "IRC 升档需要把 gate 结果贴到群或 issue。",
    acceptance: "/analyze-ops 支持复制 Markdown 报告。",
  },
  {
    id: "ADM-012",
    priority: "P1",
    title: "审计日志 CSV 导出",
    status: "Next",
    reason: "方便安全审查和留档。",
    acceptance: "/audit 支持导出当前过滤结果。",
  },
  {
    id: "ADM-013",
    priority: "P1",
    title: "Prompt regression set 设计",
    status: "Next",
    reason: "发布 prompt 前需要固定样本集比对。",
    acceptance: "文档定义样本集格式、保存策略和对比口径。",
  },
  {
    id: "ADM-014",
    priority: "P2",
    title: "Prompt regression set 实现",
    status: "Planned",
    reason: "降低 prompt 发布回归风险。",
    acceptance: "可保存样本集、运行 draft vs active、展示差异。",
  },
  {
    id: "ADM-015",
    priority: "P2",
    title: "多环境明显标识",
    status: "Planned",
    reason: "防止 dev/prod 操作混淆。",
    acceptance: "Header 明确显示 API Base 环境和危险提示。",
  },
  {
    id: "ADM-016",
    priority: "P2",
    title: "灰度 runbook 内嵌",
    status: "Planned",
    reason: "失败 gate 直接展示处置建议。",
    acceptance: "/analyze-ops 每个失败 gate 展示对应步骤。",
  },
  {
    id: "INP-001",
    priority: "Input",
    title: "IRC 独立 app 是否创建",
    status: "Needs input",
    reason: "如果需要隔离“一起看”，应创建独立 IRC app。",
    acceptance: "用户或 IRC 决定是否切到独立 app_id。",
  },
  {
    id: "INP-002",
    priority: "Input",
    title: "IRC baseline P95",
    status: "Needs input",
    reason: "灰度 gate 需要原内部方案 P95。",
    acceptance: "IRC 提供 baseline p95 ms。",
  },
  {
    id: "INP-003",
    priority: "Input",
    title: "IRC 灰度开始时间",
    status: "Needs input",
    reason: "避免 24h 窗口混入早期 smoke 失败样本。",
    acceptance: "IRC 提供明确灰度开始时间。",
  },
  {
    id: "DEF-001",
    priority: "Later",
    title: "完整 RBAC",
    status: "Deferred",
    reason: "当前仍以 ADMIN_TOKEN + 可选 Cloudflare Access 为主。",
    acceptance: "明确只读、运营、管理员权限模型后再做。",
  },
];

const STATUS_ORDER: Status[] = ["Next", "Needs input", "Planned", "Done", "Deferred"];

export default function RoadmapPage() {
  return (
    <>
      <h1 className="page-title">任务清单</h1>
      <p className="page-sub">管理后台后续开发看板。继续开发前先看这里，完成后同步文档。</p>

      <div className="metric-grid">
        <Metric label="Next" value={count("Next")} />
        <Metric label="Needs input" value={count("Needs input")} color="warn" />
        <Metric label="Planned" value={count("Planned")} />
        <Metric label="Done" value={count("Done")} color="good" />
      </div>

      <div className="card">
        <h3>下一步建议</h3>
        <ol>
          <li>ADM-011 Analyze 灰度报告复制。</li>
          <li>ADM-012 审计日志 CSV 导出。</li>
          <li>ADM-013 Prompt regression set 设计。</li>
        </ol>
        <div className="muted" style={{ fontSize: 12 }}>
          如果 IRC 灰度已经开始，优先 ADM-011。若还在准备接入，优先 ADM-013。
        </div>
      </div>

      {STATUS_ORDER.map((status) => {
        const rows = TASKS.filter((task) => task.status === status);
        if (rows.length === 0) return null;
        return (
          <div className="card" key={status}>
            <h3>{status}</h3>
            <table>
              <thead>
                <tr><th>ID</th><th>Priority</th><th>Task</th><th>Why</th><th>Acceptance</th></tr>
              </thead>
              <tbody>
                {rows.map((task) => (
                  <tr key={task.id}>
                    <td><code>{task.id}</code></td>
                    <td><span className="pill cached">{task.priority}</span></td>
                    <td>{task.title}</td>
                    <td className="wrap" style={{ maxWidth: 280 }}>{task.reason}</td>
                    <td className="wrap" style={{ maxWidth: 360 }}>{task.acceptance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function count(status: Status): number {
  return TASKS.filter((task) => task.status === status).length;
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
