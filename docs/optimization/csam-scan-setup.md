# P0.2 · Cloudflare 原生 CSAM 扫描（需你在 Dashboard 手动开启）

> ⚠️ **我的 API Token 没有开启 CSAM Scanning 的权限**，也无法创建 NCMEC 报告联系人。
> 这一步必须在 **Cloudflare Dashboard 内**完成，大约 5 分钟。
>
> 收益：R2 上传的头像（评分后保存的 evidence）自动匹配 NCMEC 全球哈希库，
> 命中即阻断 + 自动向 NCMEC 报告。这是**合规刚需**，而且 Cloudflare 承担全部
> 报告工作。我们自己的 Worker / 存储里从未出现任何 CSAM 数据。

## 启用步骤

### 1. 登录 Cloudflare Dashboard

<https://dash.cloudflare.com/>（用管理员账号）。

### 2. 配置 NCMEC 报告联系人（首次）

左边栏 → **Images** → **CSAM Scanning**（或直接访问
<https://dash.cloudflare.com/>?account/images/csam）。

首次使用需填"Your NCMEC reporting information"：

| 字段 | 建议填写 |
|------|---------|
| Full Name | 平台合规负责人（可写公司名） |
| Company | 运营公司法人 |
| Email | 合规邮箱（出现命中时 CF 会发送 alert） |
| Phone | 可留公司办公电话 |

> Cloudflare 会把这份信息用于 NCMEC CyberTipline 报告。

### 3. 在 R2 bucket 上启用扫描

左边栏 → **R2** → 选中 **`ai-guard-evidence`** → **Settings** 标签 →
往下翻找 **CSAM Scanning Tool** 区块 → 点 **Enable**。

（如果找不到：目前 Cloudflare R2 原生 CSAM scan 处于 public beta，
入口可能在 **Images → CSAM Scanning → Add Domain / Bucket**。
把 `ai-guard-evidence` bucket 作为扫描目标添加进去即可。）

### 4. 同样处理 dev bucket

选 **`ai-guard-dev-evidence`** 重复一次。

## 验证已启用

扫描启用后：
- Dashboard 相应 bucket 的 Settings 页会显示 **CSAM Scanning: Active**
- 任何新写入 R2 的对象会在秒级内被扫描
- 命中的 object 被自动屏蔽（API 再读会 404 且标 CSAM flag）
- Cloudflare 代表我们向 NCMEC 报告该事件
- 你的联系邮箱收到告警邮件

## 我们代码这边要做什么

**几乎不用动**。已有的头像审核流程：
1. 头像审核走 Gemini Vision 做语义初判
2. 审核完成后，我们才把图片上传到 R2 evidence bucket
3. R2 CSAM scanner 接管，命中的话 object 被 Cloudflare 拦截

**可选加强**（等真的开启后再做）：
- 在 `src/evidence/r2.ts` 的 `readEvidence` 里捕获 404 并在 UI 显示
  "⚠️ 此图被 Cloudflare CSAM scanner 拦截（已上报 NCMEC）"
- 在 Admin UI 的 Requests detail 页显示 CSAM 标识徽章

目前不加也没关系：命中的图片对象从 R2 读不到，UI 的 `<img>` 标签会显示"加载失败"，
不会误展示任何 CSAM 内容——这是我们想要的兜底行为。

## 成本

Cloudflare CSAM Scanning Tool 对所有客户**免费**。NCMEC 报告也由
Cloudflare 代理完成，不增加我们任何成本。

---

## 启用后告诉我，我帮你：
- 加 Admin UI 上的"被拦截对象"标识
- 在 Runbook / 合规文档里记录 NCMEC 联系人信息
- 补一条 D1 列 `r2_blocked` 跟踪"R2 扫描拒绝"的数量
