# Agentia

[中文](./README.md) · [English](./README.en.md)

[![CI](https://github.com/migoric/agentia/actions/workflows/ci.yml/badge.svg)](https://github.com/migoric/agentia/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@migor/agentia)](https://www.npmjs.com/package/@migor/agentia) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A declarative framework for building production agent services in TypeScript.** Declare four kinds of
capability with decorators + DI; a main agent orchestrates them; every run yields structured output and an
observable call tree (trace, cost, metrics).

面向应用开发的声明式 agent 服务开发框架：装饰器 + DI 声明四类能力，主 agent 编排执行；每次 run 产出结构化结果与可观测调用树（trace、成本、指标），交付可直接上线的服务。

**1 个包 · ≈2 MB · 0 运行时依赖 · 90+ 条守卫** —— 由 `tests/docs/scoreboard.test.ts` 每次现场复算。

- [安装与配置](#安装与配置)
- [快速开始](#快速开始)
- [四类能力](#四类能力)
- [运行时特性](#运行时特性)
- [可观测性与成本](#可观测性与成本)
- [集成](#集成)
- [API 速查](#api-速查)
- [稳定性与版本策略](#稳定性与版本策略)
- [性能量级](#性能量级)
- [开发本仓库](#开发本仓库)
- [延伸阅读](#延伸阅读)

## 安装与配置

```bash
npx @migor/cli create my-app         # 脚手架（含 .env / .env.example）
cd my-app && npm install
$EDITOR .env                         # 填 ANTHROPIC_API_KEY（也可直接 export，真实环境变量优先）
npm run dev                          # = agentia dev：本地 inspector 面板
```

- **首次创建必须带 scope** —— npm 上另有一个别人的 `agentia` 包，短名会装错东西。
- 可选：`ANTHROPIC_BASE_URL`（兼容端点）、`AGENTIA_MODEL`（缺省 `claude-opus-5`）。
- 框架**不自动**读 `.env`：脚手架 `src/app.ts` 的 `loadEnvFile()` 负责把它读进 `process.env`
  （放在装配模块而非入口，因为 `agentia dev` 只 import app.ts、从不执行入口）。
- **运行时**：Node ≥ 18（`engines` 唯一要求），CI 覆盖 18 / 20 / 24。按 Node 设计并测试；
  **Bun / Deno 已实测可跑**（四步判定 + 各宿主最小代码 + 实测版本见 [`docs/frameworks.md`](docs/frameworks.md)，
  门面上不写版本号 —— 会腐烂）；**edge 仍未验证**。
  `SqliteTaskStore` 需 Node ≥ 22.5 的 `node:sqlite`，未提供时构造期给可读报错。
- 工程内命令：`npx agentia g tool fetch-weather` / `npx agentia doctor` / `npx agentia --version`；
  想全局装：`npm i -g @migor/cli`。

> **版本**：`0.10.3`（`@migor/agentia` 与 `@migor/cli` 均已发布到 npm）。

## 快速开始

### 路线 A：CLI 脚手架

```bash
agentia create my-app
cd my-app && npm install
agentia g tool weather                 # 生成 src/tools/weather/index.ts 并登记 src/registry.ts
agentia g subagent doc-reviewer        # 生成 src/subagents/doc-reviewer/{index.ts,system.md}
agentia g skill note-writer            # 生成 src/skills/note-writer/index.ts
agentia g prompt style-guide           # 生成 src/prompts/style-guide/{index.ts,asset.md}
agentia dev                            # 本地 inspector：输入 prompt 驱动一次 run + 看 trace
```

**目录约定**：四分类目录，一能力一文件夹 —— `src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/`。
目录名就是类型；每个文件夹的 `index.ts` default export 一个 provider 类，DI token 缺省 = 文件夹名；
长文本放文件夹内 `.md`，用 `asset(import.meta.url, './system.md')` 读取。

### 路线 B：手写装配

不依赖 CLI，直接声明能力并装配（与路线 A 可混用）：

```ts
import { Tool, createApp, SystemPrompt, RunContext } from '@migor/agentia';

class WeatherTools {
  @Tool({
    description: '查询城市天气',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
  })
  get_weather(input: { city: string }): string {
    // 方法体内可读本次 run 的上下文（blackboard）；键的类型补全见 usage-guide §5.1
    const token = RunContext.current()?.get('authToken') as string | undefined;
    return `city=${input.city};token=${token ?? 'none'}`;
  }
}

const app = createApp({
  name: 'weather-app',
  providers: [{ provide: 'weather', useClass: WeatherTools }],
  system: new SystemPrompt().add('role', '你是天气助手。', true),
});

const { run, result } = await app.run(
  [{ role: 'user', content: '上海天气如何?' }],
  { blackboard: { authToken: 'sk-...' } },
);
console.log(result.finalText); // 最终文本
console.log(result.trace);     // 调用树 + 每步 token/成本（traceId == runId）
```

也可以按目录扫描（与显式注册表混用）：

```ts
const app = await createApp({
  name: 'my-app',
  discover: ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'],
  system,
});
```

### 路线 C：已有服务

不新建项目，也不重写现有服务。把已有函数包成 `@Tool`，在 `createServer` 里加**一条分支** ——
业务路由优先（行为不变），其余交给 `createHttpHandler`；鉴权复用同一个函数，`drain()` 接进已有的 SIGTERM。

六步、约 30 行胶水。可跑示例：[`examples/agent-endpoint/`](examples/agent-endpoint/) ——
一个已在跑的订单服务（`src/orders.ts` 一行未改），旁边加了 `/run` + `/tasks`。

> 三个刻意的决定：**一条鉴权路径**（框架给缝，不给策略）；**RAG 是你的工具**（用 `@Tool` 包自己的
> 检索，框架不内置）；**不设预算旋钮 = 没有保险丝**。

## 四类能力

主 agent 按 `description` 从同一张「能力菜单」自选；装饰器只决定**谁控制流程**：

| 能力 | 装饰器 | 谁决定流程 | 典型用途 |
|---|---|---|---|
| 工具 | `@Tool` | 你的代码（一次调用 = 一个函数） | 确定性操作：查库、算数、调 API |
| 技能 | `@Skill` | 你的代码（脚本式，显式 `ctx.llm()`） | 「先取数 → 再让模型写 → 再加工」的固定流程 |
| 子 agent | `@SubAgent` | **模型自己**（独立循环 + 裁剪上下文） | 自主多步、且中间过程不该污染主上下文 |
| 提示资产 | `@Prompt` | 模型拉取（按需注入的文本） | 长文规范/模板，平时不进上下文 |

`@Tool` 见上方路线 B；其余三类的完整写法与 spec 字段见
[`docs/usage-guide.md` §3](docs/usage-guide.md)（四类可同时装配，token 即子 agent / 技能引用工具的菜单名）。

## 运行时特性

同一份应用，三种触发任选：

```ts
import { AsyncRunner, FileTaskStore, Scheduler } from '@migor/agentia';

// 同步 RPC
const { run, result } = await app.run(messages);

// 异步任务（幂等键去重，失败可重提，可落盘续跑）
const runner = new AsyncRunner(app, { store: new FileTaskStore('./tasks.jsonl'), concurrency: 4 });
const task = runner.submit('总结一下今天的新闻', { idempotencyKey: 'daily-2026-09-10' });
await runner.awaitTask(task.taskId);

// 定时
const scheduler = new Scheduler(runner);
scheduler.every(60_000, '巡检一次', { idempotencyPrefix: 'patrol' });
```

另外三处，按需查 [`docs/usage-guide.md`](docs/usage-guide.md)：

- **长上下文预算** `createBudgetPolicy({ budgetTokens, summarize })` —— 超预算先丢旧工具对，仍超且有 `summarize` 才压缩（§6.3）
- **结构化结果** `run(..., { resultSchema })` → `result.typed`，schema 也可来自 zod：`fromZod(z.toJSONSchema(S), S)`（§5.3）
- **中间件** `middleware: [(call, next) => ...]` —— 能力调用前后的洋葱链，鉴权/限流/缓存/审计都走这里（§6.6）

## 可观测性与成本

一次 run == 一条 trace（`traceId === runId`），**Turn 0 起内建**，不是外挂的第三方追踪 SDK：

```ts
const { result } = await app.run(messages);
result.trace.spans;       // 调用树：llm.turn / 能力 span / 事件
result.trace.totalUsage;  // token 汇总（只累加 llm.turn）
```

- **每步记账**：span 属性带 model、input/output/cache tokens、成本估计、状态、错误类型
- **一条缝**：`TraceSink { export(trace) }` —— run 收尾（成功/失败）都投递，sink 抛错不影响 run；落库/采样/脱敏在缝外用 sink 组合（`docs/observability.md`）
- **指标**：`metricsSink` 满足 `TraceSink` 即可接入（Prometheus 文本 / OTLP metrics），零依赖
- **成本**：`priceOverrides` 注入价目表；未定价模型发 `usage.unpriced` 事件；`createBudgetGuard` 做硬管控（超限以 `budget_exceeded` 收尾、算失败）
- **调优闭环**：`buildRunReport` 出「能力 / 模型的耗时·token·成本·错误率排行」，`agentia report <trace.jsonl>` 直接渲染
- **回放**：`traceToMessages` 把已完成的 trace 线性化喂回模型

## 集成

**HTTP 宿主**（`POST /run` 同步 / `POST /tasks` 异步 / `GET /tasks/:id` 轮询）：

```ts
import { createServer } from 'node:http';
import { createHttpHandler } from '@migor/agentia';

createServer(createHttpHandler(app, { runner })).listen(8080);
```

**Web 框架宿主** —— `createHttpHandler` 返回的就是 `(req, res) => void`，任何能挂原始 node handler 的地方都能挂，不需要适配层：

| 宿主 | 最小接入 | 必须配的 |
|---|---|---|
| `node:http` | `createServer(createHttpHandler(app, { runner }))` | 无 |
| NestJS 12（CJS / ESM） | `nestApp.use('/agent', handler)` 三行 | CJS 模式需 Node ≥ 22.12（或 `await import()`） |
| Egg 4 | 中间件 + `ctx.respond = false` | CSRF / bodyParser 两条 ignore（字符串写法会让 worker 启动即崩） |
| Bun / Deno | 与 `node:http` 相同，零改动 | Deno 的 `--allow-net/read/write/run` |

cluster / 多实例下 task store **必须共享** —— 每 worker 一份内存 store，同一个 taskId 轮询会 `404 200` 交替。
结论表、最小代码与 Egg 的三个坑见 [`docs/frameworks.md`](docs/frameworks.md)。

**MCP** —— 连接器（stdio / StreamableHTTP）随框架发布，只用标准库，不新增第三方依赖：

```ts
import { createApp, createStdioMcpConnector, createStreamableHttpMcpConnector, mcpTools } from '@migor/agentia';

// stdio：spawn 一个 MCP server 子进程
const mcp = createStdioMcpConnector(['uvx', 'mcp-server-time']);
const tools = await mcpTools(mcp, { server: 'time' }); // → mcp_time_get_current_time …

// 远程 server：StreamableHTTP（一个 endpoint，鉴权走 headers）
const remote = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
  headers: { authorization: 'Bearer …' },
});

// 与本地 @Tool 同池：同过中间件链、同进重名查重
createApp({ system, providers: [...], tools });
```

`McpClientLike` 这条缝仍然在：接官方 SDK / 自研传输时实现 `listTools()` + `callTool()` 两个方法即可（框架**不 import** MCP SDK）。

**多模型（OpenAI 兼容端点）**：

```ts
import { createOpenAIClient } from '@migor/agentia';

const { result } = await app.run(messages, {
  client: createOpenAIClient({ baseURL: 'https://api.deepseek.com' }),
  model: 'deepseek-chat',
});
```

Ollama 等本地模型同样走这个适配器（`baseURL: 'http://localhost:11434/v1'`），不需要新代码或新依赖。

## API 速查

| 导出 | 用途 |
|---|---|
| `createApp` / `discoverProviders` | 装配应用 / 扫描能力目录 |
| `defineModule` | 能力包（providers + middleware 打包分发） |
| `Tool` / `Skill` / `SubAgent` / `Prompt` | 四类能力装饰器 |
| `CapabilityMiddleware`（`middleware` 选项） | 能力调用拦截器链 |
| `asset` | 读能力文件夹内的文本资产 |
| `SystemPrompt` | 拼装系统提示（自动打缓存 breakpoint） |
| `RunContext.current()` | 取本次 run 的 blackboard / runId |
| `AsyncRunner` / `Scheduler` / `runSync` / `createHttpHandler` | 异步 / 定时 / 同步 / HTTP 触发 |
| `FileTaskStore` / `SqliteTaskStore` / `RedisTaskStore` / `InMemoryTaskStore` | 任务记录存储 |
| `createBudgetPolicy` | 长上下文预算护栏 |
| `createAnthropicClient` | 默认 ModelClient（Anthropic）：自定义只传 `apiKey` / `baseURL` |
| `createOpenAIClient` | OpenAI 兼容端点适配（多模型） |
| `InMemoryMemoryStore`（`memory` 选项） | 跨 run 记忆水合/回写 |
| `createOtlpExporter` | trace 导出 OTLP |
| `traceToMessages` | trace 重放基底 |
| `fromZod` | zod schema 接入（peer 可选） |
| `runAgent` / `executeRun` | 裸引擎入口（不走装配） |

## 稳定性与版本策略

**`0.x` 的含义**：版本号按 SemVer，但 `0.x` 期间 **minor 版本可以包含破坏性变更**。
规矩只有一条 —— **破坏性变更必须留痕**：`CHANGELOG.md` 对应版本里有一段专门写它
（小节标题含「迁移」或「破坏性变更」），写清「**你要改什么**」。

```bash
grep -nE '^#{3,4} .*(迁移|破坏性)' CHANGELOG.md    # 列出所有「要你做动作」的小节
```

> 这条命令是**下限而非全集**：早期版本没按这个格式写，要读全就通读该版本条目。
> 版本数、迁移次数这类读数刻意不写死 —— 写死的读数会腐烂，所以给命令、不给数字。

**承诺的范围**：

| 面 | 承诺 | **不**承诺 |
|---|---|---|
| 公共 API | `@migor/agentia` 的**具名导出**（真源 `src/index.ts`）+ `@migor/cli` 的命令行面 | 深路径导入（`dist/**`）、`src/**` 内部模块、`packages/*`、`examples/*` —— 由 `package.json` 的 `exports` 封着 |
| 行为 | 该版本条目里写明的**迁移动作** | 没写进迁移说明的任何行为变化 |
| 运行环境 | `engines.node` 声明的区间；CI 在区间内每个版本跑完整条链 | edge（**未验证**）；已 EOL 的 Node。Bun / Deno 已实测但**不在 `engines` 承诺内**（[`docs/frameworks.md`](docs/frameworks.md)） |
| 依赖 | **运行时零第三方依赖**（`no-runtime-deps.test.ts` 守着，非口头承诺） | `devDependencies` 与 `examples/*` 的依赖面 |

**1.0 的门槛**（三条都可核验）：

1. `docs/spec.md` §11「开放项」每一条要么落地、要么被明确划掉（写清为什么不阻塞）；
2. `docs/guards.md` §2「待守」为空 —— 已声明的边界由机器守着，不靠人记得；
3. 公共导出面连续 3 个 minor 无破坏性变更。

## 性能量级

框架自带五个基准（`scripts/bench-*.ts`）。它们回答的是**形状**问题（哪笔钱在什么条件下付），不是 SLA：

| 你想问的 | 本机读数（macOS / Node 24，**量级**） | 形状结论（**不会随机器变**的那部分） | 复跑 |
| --- | --- | --- | --- |
| 装配一次 app 多贵 | 纯装配 `0.4 ms`；发现+装配 `8.1 ms`；整进程启动+装配 `4040 ms` | 常驻 runner 里换一次能力选择只付 `S2`（≈8 ms），不需要付整进程启动（≈4 s）⇒ 差 **~500×** | `npm run bench:assembly` |
| MCP 连接器什么时候付钱 | 冷（spawn + initialize + list）`279.5 ms`；热（复用，仅 `tools/list`）`0.3 ms` | 只有**重建连接器**才付冷的那一笔 ⇒ 差 **~900×**；是否值得重建取决于连接器跟谁同寿 | `npm run bench:assembly` |
| trace 记不记内容，差多少 | 大出参（≈37 KB/次）5 次：缺省 `17.2 KB` / 不截断 `233.9 KB`（**13.6×**）/ 截断 200 `6.2 KB` | 缺省**已经截断**；`traceContent:'full'` 是按出参字节付费的开关，代价与出参多大成正比 | `PAYLOAD_ROWS=1000 CALLS='[5,20]' npm run bench:trace` |
| 指标快照 / OTLP flush | `snapshot()` `6.56 ms`；`buildOtlpPayload()` `0.073 ms` | flush 成本几乎全在 `snapshot()` ⇒ 与 flush 频率成正比，与是否被消费无关 | `npm run bench:otlp` |
| 挂起任务的到期扫描 | sqlite N=10000：全表 `61.9 ms` / 到期索引 `0.1 ms`；file store：`load` `69.5 ms` | **有没有索引**是结构性的（差 **~600×**），不是调优问题 | `npx tsx scripts/bench-resume-scan.ts 10000` |
| redis store 的 `list()` 形状 | N=10000：往返 **10001** 次、解析 **42.1 MB**；有辅助 ZSET ⇒ 往返 **1001** | 往返次数是结构量；本机无 redis 实例，延迟只做外推 | `npx tsx scripts/bench-redis-due.ts 10000` |

> ⚠️ **毫秒数不是承诺**：随机器 / Node 版本 / 负载而变，抄走当 SLA 会错。恒定的是**形状**。
>
> 五个基准**刻意不进 CI**（计时类基准在 CI 上只会制造抖动）⇒ 上表的数没有守卫盯着，要看就按「复跑」那列自己跑。

## 开发本仓库

```bash
npm install
npm run build        # 编译框架（dist/）
npm run typecheck    # 类型检查
npm run lint         # lint + 格式检查（Biome）
npm test             # 单元测试（node:test）
npm run e2e          # 端到端：CLI 脚手架 → 装配 mock run；再真跑 examples/complete 与 examples/deploy
```

> 本仓库的 `npm run dev`（tsx）前需先 `npm approve-scripts` 批准 esbuild/tsx 的 postinstall；脚手架项目不受此限。

## 延伸阅读

- **使用者向完整说明**（API / 类型链路 / 已知边界 / 反例）：[`docs/usage-guide.md`](docs/usage-guide.md)
- 完整导出清单：[`src/index.ts`](src/index.ts)
- 设计规格：[`docs/spec.md`](docs/spec.md)
- 生产可观测配方：[`docs/observability.md`](docs/observability.md)
- 上线清单（store 选型 / 鉴权边界 / 优雅停机 / 预算 / 回滚）：[`docs/deployment.md`](docs/deployment.md)
- 接数据库（业务数据构造注入 / 自建 `TaskStore` 的 MySQL 骨架 / 别把业务事务和 run 混一个事务）：[`docs/database.md`](docs/database.md)
- 框架兼容性实测（NestJS / Egg / Bun / Deno 结论表 + 最小代码 + Egg 三坑）：[`docs/frameworks.md`](docs/frameworks.md)
- 完整示例：[`examples/complete/`](examples/complete/) · 最小部署：[`examples/deploy/`](examples/deploy/) · 存量改造：[`examples/agent-endpoint/`](examples/agent-endpoint/)
- 官网：[agentia-web.pages.dev](https://agentia-web.pages.dev)（[Playground](https://agentia-web.pages.dev/playground) · [文档](https://agentia-web.pages.dev/docs) · [取舍对照](https://agentia-web.pages.dev/tradeoffs)）
