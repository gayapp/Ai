# 优化开发任务清单（面向成人男同平台）

> 本项目定位：**成人男同性恋社交 APP 的审核中间平台**
>
> 对照外部架构文档《基于 Cloudflare 与 Grok 的高并发内容审核中间层架构与 Token 优化深度解析》整理。
>
> **核心原则**：合法的成人男同 NSFW 内容 = **pass**；仅对 CSAM / 广告引流 / 毒品违禁 / 赌博 / 政治敏感采取零容忍。
>
> 更新时间：2026-04-23

---

## 对照现状

| 文档建议 | 我们当前状态 | 结论 |
|---------|-------------|------|
| SHA-256 hash dedup + Cache | ✅ 已实现（KV DEDUP_CACHE，key 含 `biz_type:provider:prompt_version:hash`） | 可升级到 pHash 图像去重 |
| 结构化 JSON 输出 (`response_format`) | ✅ 已实现（Grok `json_object` + Gemini `application/json`；Zod 锁 schema） | 完善 |
| Provider 熔断 + 降级 | ✅ 已实现（KV 持久化，5 次连败 open 30s） | 完善 |
| 速率限制 | ✅ 已实现（KV 软滑动窗口，per-app QPS） | 完善 |
| 告警观测 | ✅ 部分（Telegram 告警 + Admin UI 统计 + stats_rollup） | 补"漏斗拦截率"指标 |
| ⚠️ **默认 prompt 把色情一律 reject** | **现状错误**——对成人男同平台会造成大面积误伤 | **P0 必改** |
| 边缘前置过滤漏斗（emoji/regex/域名） | ❌ 未实现 | **P0 建议** |
| 批处理 Batch API（25–100 条合并 + 50% 折扣） | ❌ 未实现 | **P1 重要** |
| Workers AI Llama Guard 前置分类 | ❌ 未实现 | P2 可选 |
| CSAM 扫描 + NCMEC 报告 | ❌ 未实现 | **P0 合规刚需** |
| pHash 图像指纹去重 | ❌ 未实现（当前只 URL+content_hash） | P1 |
| Python 物理服务器异步后端 | ❌ 未实现 | **P1 但作为辅助，带管理开关** |
| 优雅降级 / 待复审标记 | 部分（`status=review`） | 补"极简模式" |

---

## 任务清单（按优先级）

### 🔴 P0 — 立即做（合规 / 业务正确性）

#### P0.1 · 改写默认 prompt 匹配成人男同平台定位 · ⏱ 1h
- **问题**：migration 0002 的 prompt 把"露骨性描写/性邀约/色情资源"一律 reject → 成人男同内容大面积误伤
- **做法**：按文档第五部分的系统指令规范改写。详见 [prompts-adult-platform.md](prompts-adult-platform.md)
- **交付**：migration 0005，4 个 biz_type × 2 provider = 8 条 v3 prompt，激活后自动失效旧缓存（key 含 prompt_version）
- **评估**：prompt 热更，零部署，立即生效

#### P0.2 · Cloudflare CSAM 扫描集成 · ⏱ 半天
- **问题**：儿童色情的合规红线必须在头像/图片写入 R2 前阻断；当前依赖 Gemini Vision 的软判定不够硬
- **做法**：启用 Cloudflare 内建 CSAM Scanning Tool，在头像写入 `ai-guard-evidence` R2 前做硬核对（NCMEC 哈希库）
- **交付**：
  - R2 bucket 开启 CSAM scanner（Dashboard 设置）
  - 头像 pipeline 收到扫描命中时 → `status=reject, category=csam`，记录事件并自动触发 NCMEC 报告（Cloudflare 代办）
  - 本地代码不处理任何 CSAM 数据
- **评估**：合规刚需；Cloudflare 零额外成本，单点启用即可

---

### 🟡 P1 — 近期做（成本优化 + 架构升级）

#### P1.1 · 边缘前置过滤漏斗 · ⏱ 1 天
在 Worker 入口做 3 层廉价过滤，**在打模型前**拦掉 30-50% 的无效请求：

1. **空/短内容快速放行**：
   - 剥离 Unicode emoji (`\p{Emoji_Presentation}`、`\p{Extended_Pictographic}`)
   - 剥离零宽字符 `[​-‍﻿]`
   - 剥离变音符号 `\p{M}`
   - 剩余有效字符数 ≤ 2 → 直接 pass（无语义，无价值审核）

2. **高置信度正则黑名单快速拒绝**：
   - `微信/v信/vx/威信 + 5+ 位字母数字`
   - `QQ/扣扣 + 5+ 位数字`
   - `https?://[^\s]+\.(top|xyz|cc|tk|ml)`（已知黑产 TLD）
   - 命中 → `status=reject, category=ad, reason="包含联系方式/外部链接"`，不打模型

3. **重复内容 SHA-256 查缓存**（当前有，但只在 pipeline 内部；要前移到 route 入口最早）

详见 [edge-prefilter.md](edge-prefilter.md)。
- **交付**：`src/moderation/prefilter.ts`，在 HMAC 校验通过后、provider 调用前执行；新增字段 `prefiltered_by` 进入 D1（观测用）
- **预期收益**：Token 下降 30-50%，延迟下降 50%（命中前置即 < 50ms 返回）

#### P1.2 · Grok Batch API 异步通道 · ⏱ 1 天
- **现状**：每条请求独占一次 API 调用，系统 prompt token 完全未均摊
- **做法**：利用 xAI 官方 Batch API，把"非实时"类请求（比如 `mode=async` + app 开启 `use_batch=true` 的）攒到 JSONL 文件批量投递，**50% 折扣 + 不占实时并发**
- **交付**：
  - 新 Queue `ai-guard-batch` 积攒请求
  - Cron `*/10 * * * *` 或达到 50 条时触发 flush
  - flush 时生成 JSONL → 调 xAI Batch API → 写 batch_id 到 D1
  - 新 Cron `0 * * * *` 轮询 Batch 完成 → 拉取结果 → 回写 `moderation_requests` → 触发回调
- **评估**：头像审核（已经是异步）天然适合；文本类若用户不 care 延迟，也可以走
- **管理开关**：app 配置 `use_batch: boolean`（默认 false，实时；开启后至多 1h 延迟但半价）

详见 [batch-api.md](batch-api.md)（待细化）。

#### P1.3 · 物理服务器辅助（Python 后端） · ⏱ 2-3 天
**按用户需求：物理服务器仅作辅助，管理后台控制开关。**

- **定位**：CF Worker 仍是主链路（实时、低延迟、全球边缘）；Python 物理服务器是**离线重算力**辅助，通过管理后台开关启用
- **做什么（只做 Worker 不擅长的）**：
  1. **pHash / dHash / wHash 图像指纹**：Python 的 `ImageHash` + `OpenCV`，Worker 做不了
  2. **Grok Batch API 提交/轮询** 的长任务执行者（可做 CF Cron 做，但 Python 更稳）
  3. **人工复审队列消费者**（`status=review` 的数据推到这边给运营工具）
  4. **历史数据再训练 prompt**（跑 replay 脚本在全量数据上评估新 prompt）
- **不做什么**：实时 `/v1/moderate` 接入（延迟高、不便 HMAC 集成）
- **交付**：
  - 新建 `server/` 目录（Python），独立仓库或同仓子包
  - Admin UI Apps 页新增 `use_physical_server: boolean`（默认 false）
  - Admin UI 新增"服务器"页：看当前服务器是否活跃、队列深度、批任务状态
  - Worker 侧新 KV `PHYSICAL_SERVER_ENABLED` 全局开关，管理后台"告警"页旁边加"物理服务器"页
  - Python 服务器通过 Admin API 的特殊 app scope 回写结果

详见 [physical-server.md](physical-server.md)。
- **评估**：工作量大但灵活性高；建议在 Token 成本超过每月 50 USD 或日均请求 > 10 万时启用

#### P1.4 · pHash 图像指纹 · ⏱ 半天（需 P1.3 物理服务器）
- **问题**：当前图像审核只看 URL 和 content_hash（URL 字符串哈希）；用户稍微改图（加水印/裁切/旋转）就会 miss cache
- **做法**：物理服务器启用后，审核结果写入 R2 同时计算 pHash，存 D1 `moderation_requests.phash`；下次头像审核先查 pHash 邻近（汉明距离 ≤ 6）命中即复用
- **交付**：migration 加 phash 列；Python 服务器计算后写入；Worker 侧查询逻辑
- **评估**：Worker 独立实现太难，所以依赖 P1.3；不做也不致命（当前按 URL/内容字节哈希命中率 ~10%）

---

### 🟢 P2 — 按需再做（观测完善 + 可选加速）

#### P2.1 · Workers AI Llama Guard 前置分类 · ⏱ 半天
- **做法**：在 Grok 调用前先过 Cloudflare Workers AI 的 `@cf/meta/llama-guard-3-8b`（或类似），**仅用于极简判定**：
  - 高置信判定"safe" → 直接 pass，不打 Grok
  - 高置信判定"unsafe"且类别命中 `politics/terrorism` → 直接 reject
  - 其他情况 → 正常走 Grok
- **评估**：**对本项目可能价值不大**——Workers AI 的安全模型不理解成人男同语境，容易错判合法 NSFW 为 unsafe；需要做实测再决定是否启用
- **建议**：先不做，等 Grok Token 成本成为瓶颈再评估

#### P2.2 · 漏斗观测指标 · ⏱ 半天
在 Admin Stats 页新增：
- **Pre-filter 拦截率**：多少请求被边缘规则 pass/reject，没进模型
- **Cache 命中率**：多少请求命中 dedup cache（分 content-hash / pHash）
- **Token 效能**：平均每次审核的 input+output token（减去均摊的 prompt）
- **误判召回率**：通过人工标注流水随机抽检，记录误伤率
- **交付**：D1 加字段统计 `prefiltered_by TEXT`，stats/summary 展开

#### P2.3 · 极简降级模式 · ⏱ 2-4h
- **问题**：Grok + Gemini 双死时，当前直接返 502 阻塞业务
- **做法**：app 配置新增 `degrade_mode: block | pass_with_review`
  - `block`（默认）：现状
  - `pass_with_review`：返回 `status=review, reason="模型不可用，放行待复审"`，业务可选择展示
- **评估**：对用户体验敏感的 app 有价值

---

### ⚪ P3 — 清理 / 低优先

#### P3.1 · Batch Grok 模型支持思考式（reasoning） · 小
- 高风险疑似 CSAM 边界图片用 `grok-4.20-multi-agent` 或 `grok-4-fast-reasoning` 替代，提高精度。仅对 `risk_level=medium/high` 复查。

#### P3.2 · 平台一致性：所有对外 prompt 文档标注成人语境
- README 顶部加"本平台为成人社交场景，审核规则与泛 UGC 平台不同"
- "一起看"等 app 对接文档标明这一点，避免对方误解

---

## 推荐执行顺序

**第 1 周**：
- P0.1（改 prompt）— 立刻生效，消除误伤
- P0.2（启用 CSAM scan）— 合规刚需，Dashboard 点一下即可
- P1.1（边缘前置过滤）— 最大 Token 优化收益

**第 2 周**：
- P2.2（漏斗指标）— 先看数据才能指导后续优化
- P1.2（Batch API）— 拿到数据后知道是否值得做

**第 3 周+**（按业务需要）：
- P1.3 / P1.4（物理服务器 + pHash）— 传图量大时启用
- P2.3（降级模式）—"一起看"等业务方提出需求时加
- P2.1（Llama Guard）— 仅当前三个都做完还想继续压 Token 时再评估

---

## 单任务详细设计

- 🔴 [prompts-adult-platform.md](prompts-adult-platform.md) — 新 prompt 正文（可直接通过 Admin UI 发布）
- 🟡 [edge-prefilter.md](edge-prefilter.md) — 前置漏斗代码设计
- 🟡 [physical-server.md](physical-server.md) — Python 辅助服务器架构与 Admin 开关
- 🟡 [batch-api.md](batch-api.md) — 待补
