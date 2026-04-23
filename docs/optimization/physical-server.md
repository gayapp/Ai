# P1.3 · 物理服务器辅助（Python 后端）+ Admin 开关

> **核心原则**：Worker 是主链路，物理服务器是辅助。绝不让物理服务器出现在 `/v1/moderate` 的同步请求链路上。

## 分工

| 能力 | Worker（主） | Python 物理服务器（辅助） |
|------|-----------|------------------------|
| 实时审核 API（`/v1/moderate`） | ✅ 独占 | ❌ 不触碰 |
| HMAC 鉴权 | ✅ | ❌ |
| 同步 Grok 调用 | ✅ | ❌ |
| 头像 Gemini Vision | ✅（queue 消费） | ❌ |
| **Grok Batch API**（异步 50% 折扣） | ❌ | ✅ |
| **pHash / dHash / wHash**（OpenCV 依赖） | ❌（JS 生态做不了） | ✅ |
| **人工复审工作台**（`status=review` 的条目） | ❌ | ✅（运营用） |
| **回放 / prompt 调优**（replay 全量历史） | ❌（跑一次 30 分钟太贵） | ✅ |
| **长期数据 Dashboard**（跨月统计、图表） | ❌（D1 扫描慢） | ✅（读 D1 导出 Postgres/BigQuery） |

## 管理开关

每个 app 新增字段 `use_physical_server`，Admin UI 的 Apps 页加 toggle。默认 `false`。

```
ALTER TABLE apps ADD COLUMN use_physical_server INTEGER NOT NULL DEFAULT 0;
```

对 app 设置 `use_physical_server=1` 后：
- 头像审核完成后，Python 服务器额外计算 pHash 并写回 D1
- 异步审核请求（`mode=async`）可路由到 Batch API（50% 折扣）
- 复审队列 `status=review` 的条目被 Python 工作台消费

`use_physical_server=0` 的 app 完全不触发物理服务器逻辑——相当于没它。

---

## 架构

```
┌──────────────────┐   ┌──────────────────┐
│  Cloudflare      │   │  Python Server   │
│  Worker (edge)   │   │  (单机/VM)        │
│                  │   │                  │
│  /v1/moderate ─┬─┤   │  /internal/...   │
│  Admin API     │ │   │  独立端口         │
└────────────────┼─┘   └────────┬─────────┘
                 │              │
                 ▼              │
         ┌─────────────┐         │
         │  D1 / KV    │◀────────┘ 读写共享数据
         │  (CF 存储)  │
         └─────────────┘
                 ▲
                 │
         Python 通过 HMAC 签名 + 特殊 app_id
         调用平台自己的 Admin API 写回结果
```

### 通信方式

**Python → Worker**：使用平台自己的 Admin API，Python 服务器持有 ADMIN_TOKEN（独立 token，隔离权限），通过 HTTPS 调用：
- `POST /admin/evidence/:request_id/phash`（新端点，写入 phash）
- `PATCH /admin/stats/requests/:id/phash`
- `POST /admin/batch/submit`（新端点，交给 Python 打 Batch）

**Worker → Python**：通过 HTTP webhook 或 Queue
- Worker 的 Callback Queue 允许某些条目转发给 Python 服务器一份（额外路由）
- Python 订阅 webhook，异步拉取 `status=review` 的条目

---

## 部署形态

### 选项 A：小 VPS（$5/月，推荐起步）
- 1 vCPU / 1 GB RAM / 20 GB SSD
- Python 3.11 + FastAPI + Redis（本地队列）+ OpenCV + ImageHash
- 跑 `uvicorn` + `supervisord` 常驻
- 每小时 Cron 拉 D1 数据跑 pHash batch

### 选项 B：Kubernetes（量大再做）
- 不建议初期做

### 选项 C：Self-hosted on-prem 服务器
- 内网机器，只用于离线 batch 任务；不暴露 API
- Worker 通过"拉"的方式读 batch 结果（Python 写 Cloudflare Queue）

---

## 目录规划

```
c:\code\ai\server\                  # 新建
├── pyproject.toml                  # ruff / mypy / pytest config
├── requirements.txt                # FastAPI / httpx / imagehash / opencv-python
├── src/
│   ├── main.py                     # FastAPI 入口
│   ├── config.py                   # 从 env 读 CF Admin token / D1 wrangler API
│   ├── tasks/
│   │   ├── phash.py                # 拉 R2 图片 → 计算 3 种哈希
│   │   ├── batch_grok.py           # 维护一个 JSONL 缓冲，定时 flush 到 Grok Batch API
│   │   └── review_queue.py         # status=review 数据导出给运营工作台
│   └── api/
│       └── webhook.py              # 接收 Worker 推送
├── Dockerfile
├── docker-compose.yml              # 本地开发用
└── README.md
```

---

## 实现分期

### Phase A（最小可用）· 1 天
只做 **Grok Batch API 提交 + 轮询**：
1. Python 服务器起 FastAPI，开放 `/healthz`
2. Cron 每 10 分钟调 Admin API 拉近 10 分钟的 `status=pending` 异步请求
3. 构造 JSONL，调 xAI Batch API
4. 另一个 Cron 每 5 分钟轮询 Batch 状态，完成后拉结果，通过 Admin API 写回 Worker

**收益**：异步审核 50% 折扣

### Phase B · 半天
加 **pHash 计算**：
1. 订阅 D1 中 `evidence_key NOT NULL AND phash IS NULL` 的记录
2. 从 R2 拉图 → OpenCV 算 pHash/dHash/wHash
3. 写回 D1

**收益**：头像 cache 命中率从 ~10% 提升到 ~40%（相似图复用）

### Phase C · 1 天
加 **复审工作台**（Python + 简单 Vue / htmx）：
- 列出当日 `status=review` 记录
- 运营一键改判 pass/reject，写入 D1
- 自动加入 prompt 调优训练集

---

## 管理后台页面（Admin UI 侧）

新增 `/physical-server` 页：
- 服务器状态：健康 / 离线 / 最后心跳
- 队列深度：pHash 待处理 / Batch 待提交 / 复审待处理
- 当前 Batch ID + 进度（xAI 官方状态）
- 每个 app 的 `use_physical_server` toggle
- 手动触发按钮：立即 flush Batch、立即跑一次 pHash 补全

新增 KV `physical_server:heartbeat`，Python 每分钟写入自己 IP + 版本；Admin UI 读取后判断在线。

---

## 成本分析

| 方案 | 前置成本 | 月成本 | 省下 |
|------|---------|--------|------|
| 无物理服务器 | $0 | Grok 全价 | — |
| A. $5 VPS + Batch | $5/月 | $5 + Grok 半价 | Grok × 50% × async 比例 |
| B. 自建 on-prem | $0（闲置机器） | $0 | 同上 |

**建议触发点**：每月 Grok 账单超过 **$50** 或日均请求 > 50K 时启用。

---

## 代码骨架

```python
# server/src/tasks/batch_grok.py
import httpx
import json
import os
from datetime import datetime

BASE = os.environ["AI_GUARD_API_BASE"]
ADMIN_TOKEN = os.environ["AI_GUARD_ADMIN_TOKEN"]
XAI_KEY = os.environ["XAI_API_KEY"]

async def flush_batch():
    # 1. 拉 Admin API 中待处理的 batch 候选
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{BASE}/admin/stats/requests?status=pending&batch_candidate=1&limit=100",
            headers={"authorization": f"Bearer {ADMIN_TOKEN}"},
        )
        items = r.json()["items"]
    if not items:
        return

    # 2. 写 JSONL
    path = f"/tmp/batch-{datetime.utcnow().isoformat()}.jsonl"
    with open(path, "w") as f:
        for it in items:
            f.write(json.dumps({
                "custom_id": it["id"],
                "method": "POST",
                "url": "/v1/chat/completions",
                "body": {...}  # same as sync path
            }) + "\n")

    # 3. 上传到 xAI Batch API
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.x.ai/v1/batches",
            headers={"authorization": f"Bearer {XAI_KEY}"},
            files={"file": open(path, "rb")},
        )
        batch_id = r.json()["id"]

    # 4. 记录 batch_id 到 D1
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{BASE}/admin/batch/submitted",
            headers={"authorization": f"Bearer {ADMIN_TOKEN}"},
            json={"batch_id": batch_id, "request_ids": [it["id"] for it in items]},
        )
```

---

## 部署清单（未来真做时按此执行）

- [ ] 买 $5 Vultr / Linode / DigitalOcean VPS
- [ ] `apt install python3.11 python3-pip docker docker-compose`
- [ ] `git clone https://github.com/gayapp/Ai && cd Ai/server`
- [ ] `docker-compose up -d`
- [ ] 生成 Python 专用 ADMIN_TOKEN（从 prod 再生成一个，只给 Python 用）
- [ ] wrangler secret put 新增：`AI_GUARD_PY_ADMIN_TOKEN`（如果 worker 也要验证 Python 身份）
- [ ] Admin UI "/physical-server" 页上线
- [ ] 选 1-2 个 app 开启 `use_physical_server`，观察 1 周
- [ ] 通过后推广到其他 app

---

## 未做的决策（等需求触发）

- Batch 粒度：每 app 一个 batch？还是全平台混 batch？（混 batch 省 prompt 但出问题难定位）
- Python 仓库：单独开一个 repo，还是本 repo 的 server/ 子目录？（推荐同 repo，easier CI）
- Heartbeat 丢失时：是否自动切回全部走 Worker？（建议是，避免 Python 宕机影响头像 pHash）
