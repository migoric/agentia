# Agentia 完整示例

一个「可上线」的 agent 服务该有的样子 —— 把框架的**完整表面**接在一起，而不是最小可运行。

> 只要最小可交付骨架（一个工具 + HTTP + 存储 + 优雅停机）？看 [`../deploy/`](../deploy/)。
> 只要观测 sink 的现成实现？看 [`../observability/`](../observability/) 与
> [`docs/observability.md`](../../docs/observability.md)。

## 覆盖了什么

| 面 | 用到的 |
|---|---|
| **四类能力** | `@Tool`（`echo`）· `@Skill`（`outline-writer`，代码控流程）· `@SubAgent`（`researcher`，独立上下文）· `@Prompt`（`house-style`，文本资产） |
| **装配** | 显式注册表 `src/registry.ts`（形状与 `agentia g` 一致；也可换 `discover`） |
| **观测** | 指标 + 采样 + **脱敏** + **落库（按 runId 检索）** + 结构化日志 —— 五件套接线见 `src/observability.ts` |
| **触发** | `POST /run`（同步 / SSE）· `POST /tasks`（异步 + 幂等键）· `Scheduler.every`（定时） |
| **宿主** | 鉴权缝（`authenticate`）· 并发闸门 · 成本硬管控（`maxTotalTokens`）· `/healthz` · `/metrics` · 优雅停机 · 重启续跑 |
| **部署** | 多阶段 `Dockerfile` + `docker-compose.yml`（从源码构建框架） |

## 目录

```
src/
├── main.ts               # 宿主：装配 / 三种触发 / 鉴权 / 停机
├── observability.ts      # 观测栈组装（引用 @migor/agentia-observability）
├── registry.ts           # 显式注册表
├── tools/echo/           # @Tool
├── skills/outline-writer/    # @Skill
├── subagents/researcher/     # @SubAgent（+ system.md）
└── prompts/house-style/      # @Prompt（+ asset.md）
scripts/copy-assets.mjs   # 把 .md 资产拷进 dist（asset() 按文件位置解析）
```

## 跑起来

依赖走 `file:../..` 指向本仓库 —— **刻意的**：跑的就是工作区里刚构建的那份框架，而不是 npm
发布版（想用发布版就把这一行换成 `^0.10.3`）：

```bash
cd ..                      # 仓库根
npm install && npm run build      # 先把框架构建到 dist/

cd examples/complete
npm install                       # file:../.. → 装上刚构建的框架
ANTHROPIC_API_KEY=sk-ant-... npm start
```

### 换成 OpenAI 兼容端点（DeepSeek / vLLM / Ollama…）

```bash
OPENAI_BASE_URL=https://api.deepseek.com OPENAI_API_KEY=sk-... \
  AGENTIA_MODEL=deepseek-chat npm start
```

原理（值得一看，也是框架的一个缝）：**HTTP 宿主不持有 model client** —— 同步 `/run` 走的是
`app.run(messages, opts)`，而 `AppCallable` 就是 `{ name, run }`。所以换 provider 靠**包一层**把
client 补进 opts（`src/main.ts` 的「注入 model client」段，约 10 行）；异步侧另可直接给
`AsyncRunner` 传 `client`。这也是「框架只给缝、组合优于内建」的一个具体例子。

> 另一种不用改代码的走法：任何**Anthropic 协议兼容**的端点都可以直接用
> `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` 顶上（DeepSeek 也提供 `https://api.deepseek.com/anthropic`）。

### Docker

构建上下文是**仓库根**（镜像里先从源码构建框架）：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build                 # 在本目录执行
# 或：docker build -f examples/complete/Dockerfile -t agentia-complete .
```

想改用 npm 发布版，把 `package.json` 的 `"@migor/agentia": "file:../.."` 改成 `"^0.10.3"`，
Dockerfile 即可退回常规单包写法。

## 试试端点

```bash
# 同步 run（会走 主 agent → 选能力 → 出结果）
curl -s -X POST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"用 house_style 的规范，为「新手引导」写三条要点"}' | head -c 400

# SSE 流式
curl -N -X POST localhost:3000/run -H 'content-type: application/json' \
  -H 'accept: text/event-stream' -d '{"prompt":"回显 hi"}'

# 异步任务 + 幂等键（同键未失败则去重，直接返回既有记录）
curl -s -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"input":"调研：SSE 与 WebSocket 的取舍","idempotencyKey":"demo-1"}'
curl -s localhost:3000/tasks/<taskId>

# 健康检查与指标
curl -s localhost:3000/healthz
curl -s localhost:3000/metrics | head

# 开了鉴权（API_KEY=...）时
curl -s -X POST localhost:3000/run -H 'x-api-key: <API_KEY>' \
  -H 'content-type: application/json' -d '{"prompt":"hi"}'
```

## 观测怎么用

`src/observability.ts` 把四条配方接成一条链：

```
metrics（全量 —— 指标要准，不吃采样）
└ sampleSink（采样；错误 run 一律保留）
  └ redactSink（先脱敏，下游都拿不到原文）
    ├ sqliteTraceSink（落库；与 SqliteTaskStore 同一个库文件）
    └ jsonLogSink（一 run 一行 JSON，runId 贯穿）
```

于是出问题时：**日志里 grep `runId` → 查库拿完整调用树**。

```bash
sqlite3 agentia.db \
  "SELECT name, kind, ended_at - started_at AS ms FROM spans
    WHERE run_id = '<runId>' ORDER BY ms DESC LIMIT 10;"
```

（表结构与更多查法见 [`docs/observability.md`](../../docs/observability.md) §2.1。）

## 与真实生产的差距（本示例故意没做）

- **入口鉴权策略**：示例用固定 `x-api-key` 演示缝的位置；生产走 JWT / 签名 / 反代。
- **密钥管理**：示例读 env；生产用密钥服务。
- **多副本跨机**：示例的 SQLite 适合单机多进程共库；跨机换 `RedisTaskStore` 或自实现 `TaskStore`。
- **定时任务**：`Scheduler` 是进程内定时；需要跨副本唯一触发请在队列/调度平台侧做。
