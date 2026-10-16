# __PROJECT_NAME__

基于 [Agentia](https://github.com/migoric/agentia) 框架的 agent 应用。

## 目录约定

四分类目录，一能力一文件夹，每个能力是一个 default export 的类，用装饰器声明：

- `src/tools/<name>/` —— `@Tool` 工具：主 agent 可调用（input → value）
- `src/skills/<name>/` —— `@Skill` 技能：方法体内通过 `ctx.llm()` 调 LLM
- `src/subagents/<name>/` —— `@SubAgent` 子代理：按 system 角色设定独立跑一轮
- `src/prompts/<name>/` —— `@Prompt` 文本资产：.md 文件，按需拉取进上下文

目录名就是类型，不用记别名。

## 两条装配路线

1. **目录扫描**：`createApp({ discover: [...] })` 启动期按给定顺序扫各目录下的 `<name>/index.ts`，default export 为类时以文件夹名为 DI token 注册（见 `src/app.ts`）。
2. **显式装配**：`createApp({ providers, system })`，providers 来自 `src/registry.ts` 注册表（由 `agentia g` 自动维护，也可手工编辑）。

两者二选一或混用。

## 文件分工（**装配与启动是分开的**）

| 文件 | 作用 |
|---|---|
| `src/app.ts` | **装配**：导出 `createAgentApp({ toolSources?, workdir? })` 工厂 + `CAPABILITY_DIRS` + `createSessionStore()`；`.env` 也在这里读 |
| `src/main.ts` | **默认入口 = 服务**：调同一个工厂 → `createHttpHandler` + `AsyncRunner` + `SqliteTaskStore`（崩溃续跑）→ drain 优雅停机。`npm start` 跑的就是它 |
| `src/batch.ts` | **一次性入口（Job）**：薄入口 —— 调工厂 → `app.run(...)` → 处理 `result.error`。`npm run start:batch` 跑的是它 |
| `src/dev.config.ts` | 开发期**数据**声明（`multiTurn` / `budget` / `workdir`）；只有 `agentia dev` 读它 |
| `src/session-store.ts` | 多轮的会话后端（`FileSessionStore`，落盘 `.agentia/session.json`） |
| `src/registry.ts` | 显式注册表（`agentia g` 自动维护） |

**为什么拆**：`agentia dev` 要**复用同一个工厂**才能把「这次调哪个能力 / 工作目录是哪个」喂进
`createApp`。所以装配必须以**函数**形态待在 `app.ts` 里 —— 别把 `createApp(...)` 搬回 `main.ts`：
搬回去 dev 环就起不来（`agentia dev` 会直接报错并给出迁移方法，不会静默降级成一个「面板能用但
什么都驱动不了」的空壳）。

## 生成能力

```bash
agentia g tool my-tool        # → src/tools/my-tool/
agentia g skill my-skill      # → src/skills/my-skill/
agentia g prompt my-prompt    # → src/prompts/my-prompt/（含 asset.md）
agentia g subagent my-agent   # → src/subagents/my-agent/（含 system.md）
```

生成的能力自动登记到 `src/registry.ts`。

## 运行

需要 Anthropic API key —— 填进脚手架已生成的 `.env` 即可（本文件在 `.gitignore` 里）：

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm run dev -- "你的问题"
```

## 构建与运行

```bash
npm run build   # tsc → dist/ + .md 文本资产跟随拷贝（asset() 按文件位置解析，必须跟着 .js 走）
npm start       # 起 HTTP 服务（= node dist/main.js）
```

**`npm start` 起来的就是一个在监听的服务**（NestJS 的 `main.ts` 那条口径）：build 完 run 起来
就是能用的东西，不是跑一次就退出。`npm run start:prod` 与它同物，是显式的生产名。

端点：

- `GET /healthz` —— 健康检查（探针用，不鉴权）
- `POST /run` —— 同步 run（请求带 `Accept: text/event-stream` → SSE 逐帧）
- `POST /tasks` —— 异步任务（轮询 `GET /tasks/:id`，或 SSE 订阅 `GET /tasks/:id/stream`）

服务侧给到的另外三件事：任务落 SQLite（`AGENTIA_DB` 指定路径，缺省**工程根**下的
`./agentia.db` —— 不是 cwd 相对，换工作目录启动不会静默换库）、**崩溃续跑**（重启后上次
未完成的任务接着跑）、**优雅停机**（SIGTERM/SIGINT → 拒新单、等在飞收尾、15s 超时收口；
超时没跑完的任务下次启动续跑）。

**鉴权**：设了环境变量 `AGENTIA_TOKEN` 就启用 Bearer 校验（`Authorization: Bearer <token>`，
`/healthz` 除外）；**不设则无任何鉴权**，启动时会打一条响亮警告 —— 此时只应监听
回环 / 内网（或放到有鉴权的反代后面）。框架**不实现** token/JWT 策略，更复杂的
鉴权自己改 `src/main.ts` 里的 `authenticate` 钩子。

环境变量：`PORT`（缺省 3000）· `AGENTIA_DB`（缺省工程根下的 `./agentia.db`）· `AGENTIA_TOKEN`（可选）。

⚠️ **Node ≥ 22.5**：任务存储 `SqliteTaskStore` 用 `node:sqlite`，更低版本起服务时**构造期**
会抛可读报错。想让这个服务跑在 Node 18 上：把 `src/main.ts` 里那行换成 `FileTaskStore`
（`@migor/agentia` 同样导出、同一套 API，代价是单写者前提）。`npm run dev` 与
`npm run start:batch` 不碰它，它们的 Node 下限仍是 18。

## trace 出口（默认开着）

每次 run 的调用树默认落盘到 `.agentia/traces.jsonl`（已进 `.gitignore`）—— 接的是
`src/app.ts` 里那一行 `sinks: [jsonlTraceSink({ path: TRACE_FILE })]`。dev 面板、同步
`/run`、异步 `/tasks` 三条路都经 `app.run` ⇒ 一处接入、三条全覆盖：

```bash
agentia report .agentia/traces.jsonl   # 哪个能力慢 / 贵 / 爱失败
agentia diff   a.jsonl b.jsonl         # 两次 run 的调用树 A/B
```

⚠️ 落的是**完整 trace**（含 prompt 与工具出入参）⇒ 上线前按你的合规要求处置。删掉 `sinks`
那一行即关闭 —— **关掉之后异步 `/tasks` 的 trace 会落进任务库而没有任何人导出**（同步
`/run` 的 trace 仍随响应回去，所以「好像也没什么区别」正是这个坑的形状）。
不确定自己关没关：`agentia doctor` 会查 `src/app.ts` 里这一行。

## 一次性任务（Job 形态）

cron / CI / 容器里「跑一次就退出」的那种，用 `batch.ts`：

```bash
npm run build && npm run start:batch -- "你的问题"   # = node dist/batch.js <问题>
```

它没有端口、没有 `/healthz`、没有停机流程 —— 只跑一轮、打印结果、退出（失败置非零退出码）。

## 更完整的生产配方

要 metrics（`/metrics`）/ OTLP 导出 / Dockerfile / compose 编排，直接抄框架仓库的
[`examples/deploy/`](https://github.com/migoric/agentia/tree/main/examples/deploy)
与 `docs/deployment.md` —— `src/main.ts` 是它的精简版，两者同一套 API；上线前的决定清单
也在那份 `docs/deployment.md` 里。API 细节见本项目 `AGENTS.md` 的「触发与宿主」节。

也可以用环境变量（适合 CI / 容器）——**真实环境变量优先，不会被 `.env` 覆盖**：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev -- "你的问题"
```

`.env` 由 `src/app.ts` 的 `loadEnvFile()` 读取（放在装配模块里，`npm run dev` 与 `npm start`
两个入口才都会读到）。框架**不会自动读**它 ——
读哪个文件、什么时候读由你的启动代码决定（这样「换目录跑」不会悄悄改变行为）。
