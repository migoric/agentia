# Agentia

[中文](./README.md) · [English](./README.en.md)

[![CI](https://github.com/migoric/agentia/actions/workflows/ci.yml/badge.svg)](https://github.com/migoric/agentia/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@migor/agentia)](https://www.npmjs.com/package/@migor/agentia) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

面向应用开发的声明式 agent 服务开发框架：装饰器 + DI 声明四类能力，主 agent 编排执行；每次 run 产出结构化结果与可观测调用树（trace、成本、指标），交付可直接上线的服务。

**1 个包 · ≈2 MB · 0 运行时依赖 · 90+ 条守卫** —— 这一组数是选型第一个问题（安装面有多大）的答案：
`npm i @migor/agentia` 只往 `node_modules` 放**一个**包，不装任何厂商 SDK。
数字由 `tests/docs/scoreboard.test.ts` 每次现场复算，**手写的读数会腐烂**（本仓的老病）。

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
cd my-app && npm install             # 框架与 CLI 都装进工程
$EDITOR .env                         # 填 ANTHROPIC_API_KEY（也可直接 export，真实环境变量优先）
npm run dev                          # = agentia dev：本地 inspector 面板（输入 prompt / 选能力 / 选工作目录）
# 可选：ANTHROPIC_BASE_URL（兼容端点）、AGENTIA_MODEL（缺省 claude-opus-5）

# 工程内直接用：npx agentia g tool fetch-weather / npx agentia doctor / npx agentia --version
#   （脚手架把 @migor/cli 装进 devDependencies ⇒ 走本地 bin，离线可用、版本与工程一同 pin）
# 首次创建必须带 scope —— npm 上另有一个别人的 `agentia` 包，短名会装错东西。
# 想全局装（到处都能敲 agentia）：npm i -g @migor/cli
```

> 框架**不自动**读 `.env`：脚手架 `src/app.ts` 的 `loadEnvFile()` 负责把它读进 `process.env`。
> 放在**装配模块**（app.ts）而不是任一个入口（`main.ts` / `batch.ts`），是因为 `agentia dev`
> 只 import app.ts、从不执行入口 —— 写错一侧会让 `npm run dev` 静默读不到 `.env` 而 `npm start` 读得到。
> 真实环境变量优先（CI / docker / 命令行永远赢过文件），`loadEnvFile({ override: true })` 才反过来。

> **版本**：`0.10.3`（`@migor/agentia` 与 `@migor/cli` 均已发布到 npm）。`examples/` **刻意**用
> `file:../..` 指向本仓库而不是 npm 版本 —— 跑的是**工作区代码**，理由见
> [`examples/README.md`](examples/README.md) 的「依赖说明」。

> **运行时**：Node ≥ 18（`engines` 唯一要求）。CI 覆盖 **18 / 20 / 24** —— `import-floor` 矩阵跑
> `engines` 声明的**下限**，其余 job 跟**当前 LTS** 走。按 Node 设计并测试，
> **未对 Deno / edge 做验证**。唯一碰内置模块的 store 是 `SqliteTaskStore`（需 Node ≥ 22.5 的
> `node:sqlite`）—— 未提供时**构造期给可读报错**，不影响包本身被导入。


## 快速开始

两条路线，按需选一即可（也可混用）。

### 路线 A：CLI 脚手架

```bash
agentia create my-app                  # 脚手架新项目（依赖 @migor/agentia）
cd my-app && npm install
agentia g tool weather                 # 生成 src/tools/weather/index.ts 并登记 src/registry.ts
agentia g subagent doc-reviewer        # 生成 src/subagents/doc-reviewer/{index.ts,system.md}
agentia g skill note-writer            # 生成 src/skills/note-writer/index.ts
agentia g prompt style-guide           # 生成 src/prompts/style-guide/{index.ts,asset.md}
agentia dev                            # 本地 inspector 面板：输入 prompt 驱动一次 run + 看 trace
```

**目录约定**：四分类目录，一能力一文件夹 —— `src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/`。
目录名就是类型，不用记别名。每个文件夹的 `index.ts` default export 一个 provider 类，DI token 缺省 = 文件夹名；
长文本放文件夹内 `.md`，代码里用 `asset(import.meta.url, './system.md')` 读取。

### 路线 B：手写装配

不依赖 CLI，直接声明能力并装配成应用：

```ts
import { Tool, createApp, SystemPrompt, RunContext } from '@migor/agentia';

class WeatherTools {
  // 工具名缺省取方法名（建议 snake_case）；入参 = 模型按 schema 解析的结构化 input
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
    // 方法体内随时可读本次 run 的上下文（blackboard）。
    // 想让键有补全/校验：在一次 declare module 里合并 Blackboard（见 docs/usage-guide.md §5.1）；
    // 未声明时键为 string、值为 unknown，这里按需断言。
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
  { blackboard: { authToken: 'sk-...' } }, // 预置本次 run 的上下文
);
console.log(result.finalText); // 最终文本
console.log(result.trace);     // 调用树 + 每步 token/成本（traceId == runId）
```

装配还有**目录扫描**这条路（与显式注册表可混用）：

```ts
// 按给定顺序扫各目录（返回 Promise）；也可用 CLI 维护的 src/registry.ts 显式注册
const app = await createApp({
  name: 'my-app',
  discover: ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'],
  system,
});
```

## 四类能力

主 agent 按 `description` 从同一张「能力菜单」自选；装饰器只决定**谁控制流程**：

| 能力 | 装饰器 | 谁决定流程 | 典型用途 |
|---|---|---|---|
| 工具 | `@Tool` | 你的代码（一次调用 = 一个函数） | 确定性操作：查库、算数、调 API |
| 技能 | `@Skill` | 你的代码（脚本式，显式 `ctx.llm()`） | 「先取数 → 再让模型写 → 再加工」的固定流程 |
| 子 agent | `@SubAgent` | **模型自己**（独立循环 + 裁剪上下文） | 自主多步、且中间过程不该污染主上下文 |
| 提示资产 | `@Prompt` | 模型拉取（按需注入的文本） | 长文规范/模板，平时不进上下文 |

`@Tool` 的写法见上方路线 B；其余三类：

```ts
import { Skill, SubAgent, Prompt, asset, type SkillContext } from '@migor/agentia';

// @Skill：代码控制的流程，模型调用只发生在显式 ctx.llm()
class Notes {
  @Skill({ description: '按主题整理要点' })
  async note_writer(input: { topic: string }, ctx: SkillContext): Promise<string> {
    const r = await ctx.llm({ prompt: `就「${input.topic}」给出三个要点` });
    return r.text; // 返回值即产物，以 tool_result 交回主 agent
  }
}

// @SubAgent：独立循环 + 裁剪上下文，只有最终报告回流主上下文（方法体不执行）
class Pipeline {
  @SubAgent({
    name: 'reviewer',
    description: '审查给定文档并输出书面评审意见',
    schema: { type: 'object', properties: { doc: { type: 'string' } }, required: ['doc'], additionalProperties: false },
    system: '你是评审 agent。结论必须以“审查通过/不通过”开头。',
    tools: ['weather'], // 子 agent 自己的工具菜单（provider token）
  })
  reviewer(_input: { doc: string }): void {}
}

// @Prompt：纯文本资产，模型判定需要时拉取进上下文
class Assets {
  @Prompt({ description: '品牌基调文案规范' })
  style_guide(): string {
    return asset(import.meta.url, './asset.md'); // 从能力文件夹读 .md
  }
}
```

四类一起装配（`providers` 里逐个登记；token 即子 agent / 技能引用工具的菜单名）：

```ts
import { createApp, SystemPrompt } from '@migor/agentia';

const app = createApp({
  name: 'weather-app',
  providers: [
    { provide: 'weather', useClass: WeatherTools },
    { provide: 'notes', useClass: Notes },
    { provide: 'pipeline', useClass: Pipeline },
    { provide: 'assets', useClass: Assets },
  ],
  system: new SystemPrompt().add('role', '你是天气助手。', true),
});
```

## 运行时特性

### 触发方式

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

### 长上下文预算

```ts
import { createBudgetPolicy } from '@migor/agentia';

const app = createApp({
  // ...
  contextPolicy: createBudgetPolicy({
    budgetTokens: 60_000,    // 超预算先丢旧工具对，仍超且有 summarize 才压缩
    summarize: (text) => mySummarizer(text), // 可选，框架不替你调模型
  }),
});
```

### 结构化结果

```ts
const { result } = await app.run(messages, {
  resultSchema: {
    type: 'object',
    properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['pass', 'reason'],
    additionalProperties: false,
  },
});
console.log(result.typed); // 校验过的结构化结果，不再从文本里猜 JSON
// schema 也可来自 zod（peer 可选）：fromZod(z.toJSONSchema(S), S)
```

### 中间件

挂在每一次能力调用前后的洋葱链——鉴权、限流、缓存、审计都走这里：

```ts
const app = createApp({
  // ...
  middleware: [
    async (call, next) => {
      if (call.capability.name === 'danger_op' && !RunContext.current()?.get('isAdmin')) {
        return 'forbidden'; // 短路，不调 next 即拦截
      }
      return next(); // next(newInput) 还可改写入参
    },
  ],
});
```

## 可观测性与成本

一次 run == 一条 trace（`traceId === runId`），**Turn 0 起内建** —— 不是外挂的第三方追踪 SDK 集成：

```ts
const { run, result } = await app.run(messages);
result.trace.spans;       // 调用树：llm.turn / 能力 span / 事件
result.trace.totalUsage;  // token 汇总（只累加 llm.turn；能力 span 是子孙聚合，不参与求和）
```

- **每步记账**：span 属性带 model、input/output/cache tokens、成本估计、状态、错误类型
- **出口是一条缝**：`TraceSink { export(trace) }` —— run 收尾（成功/失败两条路径）都投递，sink 抛错不影响 run。落库 / 采样 / 脱敏都在缝外用 sink 组合（实码见 `examples/observability/`，说明见 `docs/observability.md`）
- **指标**：`metricsSink` 满足 `TraceSink` 即可接入（Prometheus 文本 / OTLP metrics），零依赖
- **成本**：`priceOverrides` 注入价目表；未定价模型显式发 `usage.unpriced` 事件；`createBudgetGuard` 做**硬管控**（超限 run 以 `budget_exceeded` 收尾、算失败）
- **调优闭环**：`buildRunReport` 出「能力 / 模型的耗时·token·成本·错误率排行」，CLI `agentia report <trace.jsonl>` 直接渲染
- **回放**：`traceToMessages` 把已完成的 trace 线性化喂回模型（调试基底）
- **本地开发**：`agentia dev` 的 inspector 面板与 `@migor/trace-view` 共用同一份渲染器（避免两处漂移）
- **导出 OTLP**：

```ts
import { createOtlpExporter } from '@migor/agentia';

await createOtlpExporter({ endpoint: 'http://localhost:4318' }).export(result.trace);
```

> 权威口径见 `docs/usage-guide.md` 的「观测」与「成本硬管控」两节。

## 集成

### HTTP 宿主

```ts
import { createServer } from 'node:http';
import { createHttpHandler } from '@migor/agentia';

// POST /run（同步） POST /tasks（异步） GET /tasks/:id（轮询）
createServer(createHttpHandler(app, { runner })).listen(8080);
```

### MCP（连接器出厂自带）

MCP server 的工具映射成菜单项 —— 连接器（stdio / StreamableHTTP）**随框架发布**，只用标准库（`node:child_process` + 全局 `fetch`），不新增第三方依赖：

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

`McpClientLike` 这条缝仍然在：接官方 SDK / 远程 server / 自研传输时实现 `listTools()` + `callTool()` 两个方法即可（框架**不 import** MCP SDK）。

### 多模型（OpenAI 兼容端点）

```ts
import { createOpenAIClient } from '@migor/agentia';

const { result } = await app.run(messages, {
  client: createOpenAIClient({ baseURL: 'https://api.deepseek.com' }),
  model: 'deepseek-chat',
});
```

> **本地模型（Ollama 等）**：Ollama 暴露 OpenAI 兼容端点，用同一个适配器即可 ——
> `createOpenAIClient({ baseURL: 'http://localhost:11434/v1' })` + `model: 'qwen3'`，
> **不需要任何新代码或新依赖**。


### 跨 run 记忆

```ts
import { InMemoryMemoryStore } from '@migor/agentia';

const { result } = await app.run(messages, {
  memory: { store: new InMemoryMemoryStore(), keys: ['profile'] },
});
```

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
| `createAnthropicClient` | 默认 ModelClient（Anthropic）：自定义只传 `apiKey` / `baseURL`，不必直接依赖厂商 SDK |
| `createOpenAIClient` | OpenAI 兼容端点适配（多模型） |
| `InMemoryMemoryStore`（`memory` 选项） | 跨 run 记忆水合/回写 |
| `createOtlpExporter` | trace 导出 OTLP |
| `traceToMessages` | trace 重放基底：把完成的 run 还原成消息喂回模型调试 |
| `fromZod` | zod schema 接入（peer 可选） |
| `runAgent` / `executeRun` | 裸引擎入口（不走装配） |

## 稳定性与版本策略

**`0.x` 的含义**：版本号按 SemVer，但 `0.x` 期间 **minor 版本可以包含破坏性变更**。
规矩只有一条 —— **破坏性变更必须留痕**：`CHANGELOG.md` 对应的那个版本里要有一段专门写它
（小节标题含「迁移」或「破坏性变更」），写清「**你要改什么**」。

```bash
grep -nE '^#{3,4} .*(迁移|破坏性)' CHANGELOG.md    # 列出所有「要你做动作」的小节
```

> ⚠️ **如实标注**：这条纪律是**逐步收紧**的 —— 早期的 `0.7.1`（类型面变更）把动作写在版本条目
> 开头的引用块里、没有独立小节，`0.8.1`~`0.8.3` 用一行「**迁移**：无」表态。⇒ 上面那条命令是
> **下限**而非全集，要读全就通读该版本的条目。
> **「N 个版本 / M 次迁移」这类读数本 README 刻意不写死** —— 写死的读数会腐烂（本仓为此吃过教训），
> 所以给命令、不给数字。

**承诺的范围**：

| 面 | 承诺 | **不**承诺 |
|---|---|---|
| 公共 API | `@migor/agentia` 的**具名导出**（真源 `src/index.ts`；官网 API 页有反向全覆盖守卫）+ `@migor/cli` 的命令行面 | 深路径导入（`dist/**`）、`src/**` 内部模块路径、`packages/*`、`examples/*` —— 这条边界**由 `package.json` 的 `exports` 字段封着**（`tests/architecture/package-exports.test.ts` 守；加 `exports` 之前 `dist/**` 真的导得进来） |
| 行为 | 该版本条目里写明的**迁移动作** | 没写进迁移说明的任何行为变化 |
| 运行环境 | `engines.node` 声明的区间；CI 在**该区间内每个版本**上跑完整条链 | Deno / Bun / edge runtime（**未验证**）；已 EOL 的 Node（会随 minor 去掉） |
| 依赖 | **运行时零第三方依赖**（`tests/architecture/no-runtime-deps.test.ts` 守着，非口头承诺） | `devDependencies` 与 `examples/*` 的依赖面 |

**1.0 的门槛**（三条都是可核验的，不是口号）：

1. `docs/spec.md` §11「开放项」里每一条要么落地、要么被**明确划掉**（写清为什么不阻塞）；
2. `docs/guards.md` §2「待守」为空 —— 已声明的边界都由机器守着，而不是靠人记得；
3. 公共导出面**连续 3 个 minor 无破坏性变更**。

在此之前，请把每个 minor 当成「**这次修的可能是某个承诺没兑现的地方**」——这正是 `0.x` 的含义，
也是 `CHANGELOG.md` 每条都写「为什么」而不是「做了什么」的原因。

## 性能量级

框架自带五个基准（`scripts/bench-*.ts`）。它们要回答的是**形状**问题（哪笔钱在什么条件下付、
换实现能省掉的是什么），不是给你一个 SLA：

| 你想问的 | 本机读数（macOS / Node 24，**量级**） | 形状结论（**不会随机器变**的那部分） | 复跑 |
| --- | --- | --- | --- |
| 装配一次 app 多贵 | 纯装配 `0.4 ms`；发现+装配 `8.1 ms`；整进程启动+装配 `4040 ms`（其中「冷装配」≈2963 ms，整进程启动本身就 1077 ms） | 「换一次能力选择」在**常驻 runner** 里只付 `S2`（≈8 ms），**不需要**付 `S6b`（≈4 s）⇒ 差 **~500×**。那 4 s 里 ~1.1 s 是 `tsx` 解释器启动，与框架无关 | `npm run bench:assembly` |
| MCP 连接器什么时候付钱 | 冷（spawn + initialize + list）`279.5 ms`；热（复用连接器，仅一次 `tools/list`）`0.3 ms` | 只有**重建连接器**才付冷的那一笔 ⇒ 差 **~900×**。所以「重建 app 含 MCP 握手」成不成立，**取决于连接器跟谁同寿** | `npm run bench:assembly` |
| trace 记不记内容，差多少 | 大出参（≈37 KB/次）5 次调用：缺省 `17.2 KB` / 不截断 `233.9 KB`（**13.6×**）/ 截断 200 `6.2 KB`；20 次：`65 KB → 932 KB`（14.3×） | 缺省**已经截断**（≈14× 的量级差来自关掉截断）。`traceContent:'full'` 是**按出参字节付费**的开关 —— 小出参档实测只差 1.0× ⇒ 代价与你的出参多大成正比 | `PAYLOAD_ROWS=1000 CALLS='[5,20]' npm run bench:trace` |
| 指标快照 / OTLP flush 的成本 | `snapshot()` `6.56 ms`（30 个组合 × 2 次分位）；`buildOtlpPayload()` `0.073 ms` | flush 的成本**几乎全在 `snapshot()`** ⇒ 省掉它 ≈ 每次 flush 省 6.5 ms，**与 flush 频率成正比**，与 OTLP 是否被消费无关 | `npm run bench:otlp` |
| 挂起任务的到期扫描 | sqlite N=10000：全表 `list()` `61.9 ms` / 走到期索引 `listDue` `0.1 ms`；file store N=10000：`load` `69.5 ms`、`list` `0.0 ms` | **有没有索引**是结构性的（差 **~600×**），不是调优问题。file store 的记录在内存里 ⇒ 它贵的那笔是**构造期的全表 `load`** | `npx tsx scripts/bench-resume-scan.ts 10000` |
| redis store 的 `list()` 形状 | N=10000：往返 **10001** 次、解析 **42.1 MB**、纯 CPU `104.1 ms`；有辅助 ZSET（`score = wakeAt`）⇒ 往返 **1001** | 往返次数是**结构量**（换实现能省掉的就是它）；本机无 redis 实例，延迟只做外推（RTT 0.2ms ⇒ 2 s） | `npx tsx scripts/bench-redis-due.ts 10000` |

> ⚠️ **毫秒数不是承诺**：它们随机器 / Node 版本 / 负载而变，抄走当 SLA 会错。
> 真正恒定的是**形状**（差多少倍、往返几次、哪一笔跟什么成正比）—— 那才是这五个基准要说的东西。
>
> 五个基准**刻意不进 CI**（计时类基准在 CI 机器上只会制造抖动；`docs/plans/2026-09-22-dev-debug-loop.md`
> 定下的处置是「要看时跑」）⇒ 上表的数**没有守卫帮你盯着**，要看就按「复跑」那一列自己跑一遍。

## 开发本仓库

```bash
npm install
npm run build        # 编译框架（dist/）
npm run typecheck    # 类型检查
npm run lint         # lint + 格式检查（Biome）
npm test             # 单元测试（node:test）
npm run e2e          # 端到端：CLI 脚手架 → 装配 mock run；再真跑 examples/complete 与 examples/deploy（含崩溃续跑）
```

> 注：本仓库的 `npm run dev`（tsx）前需先 `npm approve-scripts` 批准 esbuild/tsx 的 postinstall；
> 脚手架项目里的 `agentia dev` 不受此限。

## 延伸阅读

- **使用者向完整说明**（API 速查 / 类型链路 / 已知边界 / 反例）：[`docs/usage-guide.md`](docs/usage-guide.md)
- 完整导出清单：[`src/index.ts`](src/index.ts)
- 设计规格：[`docs/spec.md`](docs/spec.md)
- 生产可观测配方（落库检索 / 日志关联 / 采样 / 脱敏）：[`docs/observability.md`](docs/observability.md)
- 上线清单（store 选型 / 鉴权边界 / 优雅停机 / 预算 / 回滚 / 上线自检）：[`docs/deployment.md`](docs/deployment.md)
- 完整示例（四类能力 + 三种触发 + 全观测栈）：[`examples/complete/`](examples/complete/)
- 最小部署示例：[`examples/deploy/`](examples/deploy/)
- 官网：[agentia-web.pages.dev](https://agentia-web.pages.dev)（[在线 Playground](https://agentia-web.pages.dev/playground) · [文档](https://agentia-web.pages.dev/docs) · [取舍对照：不做什么 / 什么场景该选别人](https://agentia-web.pages.dev/tradeoffs)）
  · **英文版** [agentia-web.pages.dev/en](https://agentia-web.pages.dev/en)（导航右侧可切换；首次访问会按浏览器语言自动落到中文或英文）
