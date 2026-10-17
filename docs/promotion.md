# Agentia 推广稿（可直接发出去的版本）

> 2026-09-29 定稿。**每一节都是可整段复制的成品**，复制时只改方括号里的部分。

> ⚠️ **本稿里「守卫条数」出现三处**（英文两处、中文一处），它与 README 顶部记分牌同源，
> 由 `tests/docs/scoreboard.test.ts` **每次测试现场复算**（实际条数只会涨，所以稿里写的是下限）。
> 写旧了 `npm test` 会红 —— 本仓的老病就是手写读数会腐烂，**发之前跑一遍 `npm test` 比核对文案更快**。
> （本注释**刻意不写那个数**：多写一处就多一处要同步，而它恰恰是会被守卫点名的字面量 ——
> 上一版就是这么把变异测废的。）

> ⚠️ **体积数字刻意不写**：解包体积会随每次发布小幅增长，抄进稿里就是第二个会腐烂的副本。
> 需要报体积时**去 npm 页看**（或抄 README 顶部那行 —— 那行由守卫现算，当天是对的）。

---

## 〇、发之前做三件事（30 秒）

1. `npm test` —— 稿里的守卫条数、安装面积都由它现场复算；红了说明文案已经过期。
2. 版本号 —— 以 README 顶部「版本」行与 npm 页为准（`0.x` 期间**锁精确版本**，别在稿里写 `^`）。
3. 三件套链接（全文统一，别混用）：
   - 仓库：`https://github.com/migoric/agentia`
   - npm：`https://www.npmjs.com/package/@migor/agentia`
   - 官网：`https://agentia-web.pages.dev`（文档 `/docs`、取舍 `/tradeoffs`）

> 一句话定位（各平台通用，可直接抄）：
> **面向应用开发的声明式 agent 服务开发框架** —— 装饰器 + DI 声明四类能力，主 agent 编排；
> 每次 run 产出结构化结果与可观测调用树，交付**可直接上线的服务**。

---

## 一、中文主稿（V2EX / 掘金 / 知乎 / 公众号，可直接粘贴）

### 标题三选一

1. 《我们给每条不变量建了一份「守卫注册表」，然后抓到 3 个永远绿的测试》
2. 《一个零运行时依赖的 TypeScript Agent 框架：为什么我连 zod 都不装》
3. 《不是「能跑 demo」，是「能上线」：一份写清了劝退条件的 Agent 框架取舍清单》

### 正文

我写了一个 TypeScript 的 Agent 框架，叫 Agentia。这篇不讲愿景，只讲三件事：它长什么样、它刻意不做什么、以及我们怎么防止自己写出假的测试。

#### 1. 30 秒跑起来

```bash
npx @migor/cli create my-app     # 脚手架（含 .env / .env.example）
cd my-app && npm install
$EDITOR .env                     # 填 ANTHROPIC_API_KEY
npm run dev                      # = agentia dev：本地 inspector 面板
```

> npm 上另有一个同名的 `agentia` 包，**首次创建必须带 scope**，装错会拿到别人的东西。

不想要脚手架就手写装配，一个装饰器声明能力，`createApp` 装配完就能跑：

```ts
import { Tool, createApp, SystemPrompt } from '@migor/agentia';

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
    return `city=${input.city}`;
  }
}

const app = createApp({
  name: 'weather-app',
  providers: [{ provide: 'weather', useClass: WeatherTools }],
  system: new SystemPrompt().add('role', '你是天气助手。', true),
});

const { result } = await app.run([{ role: 'user', content: '上海天气如何?' }]);
console.log(result.finalText);
```

整个 API 面就是四个装饰器：`@Tool`、`@Skill`、`@SubAgent`、`@Prompt`。

#### 2. 四个装饰器划分的不是「能做什么」，而是「谁控制流程」

| 能力 | 装饰器 | 谁决定流程 | 典型用途 |
|---|---|---|---|
| 工具 | `@Tool` | 你的代码（一次调用 = 一个函数） | 查库、算数、调 API |
| 技能 | `@Skill` | 你的代码（脚本式，显式 `ctx.llm()`） | 「取数 → 让模型写 → 再加工」的固定流程 |
| 子 agent | `@SubAgent` | **模型自己**（独立循环 + 裁剪上下文） | 自主多步、中间过程不该污染主上下文 |
| 提示资产 | `@Prompt` | 模型按需拉取 | 长文规范 / 模板，平时不进上下文 |

这一条是四类划分的判据：**装饰器只决定流程归谁**，能力本身都进同一张菜单、由主 agent 按 `description` 自选。

#### 3. trace 是一等公民

一次 run == 一条 trace（`traceId === runId`），从 Turn 0 就内建 —— 不是外挂一个第三方追踪 SDK：

```ts
const { result } = await app.run(messages);
result.trace.spans;       // 调用树：llm.turn / 能力 span / 事件
result.trace.totalUsage;  // token 汇总
```

- **每步记账**：span 属性带 model、input/output/cache tokens、成本估计、状态、错误类型；
- **出口只有一条缝**：`TraceSink { export(trace) }` —— 落库 / 采样 / 脱敏都在缝外用 sink 组合；
- **成本硬管控**：`createBudgetGuard` 超限直接以 `budget_exceeded` 收尾并算失败；
- **调优闭环**：`agentia report <trace.jsonl>` 直接渲染「能力 / 模型的耗时·token·成本·错误率排行」。

一句话：**四类能力决定它能做什么，trace 决定它敢不敢上线。**

#### 4. 交付的是「可直接上线的服务」，不是 demo

```ts
import { createServer } from 'node:http';
import { createHttpHandler } from '@migor/agentia';

createServer(createHttpHandler(app, { runner })).listen(8080);  // POST /run · POST /tasks · GET /tasks/:id
```

- **异步任务**：`AsyncRunner` + `FileTaskStore` / `SqliteTaskStore` / `RedisTaskStore`，幂等键去重、失败可重提，`runner.resumePending()` 做重启续跑（e2e 里有 SIGKILL 后同库重启续跑这一档）；
- **中间件**：能力调用前后的洋葱链，鉴权 / 限流 / 审计短路在 `next()` 之前；
- **结构化结果**：传 `resultSchema` 直接拿校验过的 `result.typed`，不用从文本里猜 JSON；
- **上线清单**：`docs/deployment.md` 写的是「哪些事框架**不替你**做」（比如 `/metrics` 不鉴权，生产要由反代限制可达性）。
- **宿主不挑**：`createHttpHandler` 返回的就是 `(req, res) => void` —— 实测同一个 handler 能挂进 `node:http` / NestJS / Egg，Bun / Deno 下**同一份代码零改动**（结论表 + 最小代码 + Egg 的三个坑见 `docs/frameworks.md`）。

#### 5. 安装面积：`npm i` 只放**一个**包，运行时**零**第三方依赖

不装任何厂商 SDK（这条由 `tests/architecture/no-runtime-deps.test.ts` 守着，不是口头承诺）。
MCP stdio 连接器是**内置**的 —— 因为它只用 Node 标准库（spawn + 全局 fetch）。

#### 6. 我劝退你的部分

- 要**可视化编排 / 低代码**：它是库，编排写在代码里，没有编辑器，也没有这个计划；
- 要**Python**：TypeScript only；edge 运行时**未验证**（Bun / Deno 已实测可跑，但不在 `engines` 承诺内、也不在 CI 上，见 `docs/frameworks.md`）；
- 要**托管平台 / 开箱即用的向量检索 / 评估平台**：它交付你自己能上线的服务，不是替你跑的平台；
- 要**前端流式 UI 绑定**（`useChat` 那类）：没有客户端 SDK，服务端是它唯一的形态；
- 要 **1.0 级别的稳定性**：现在是 `0.x`，**minor 可以包含破坏性变更** —— 规矩是「必须留痕」（CHANGELOG 带迁移小节），不是「不会发生」。

完整的「什么情况别选它」我写在了官网 `/tradeoffs`。选型时最有用的往往不是优点清单，而是作者愿意把劝退条件写在哪、写多细。

#### 7. 「测试永远绿」也是一种 bug

我们给每条不变量在 `docs/guards.md` 登记一条守卫，并要求**变异验证**：改坏代码，确认测试真的变红；还是绿的，就是「假守卫」，当作 bug 处理。

现在有 90+ 条守卫，抓到过三种假守卫：

1. **自我比较** —— `deepEqual(x, x.snapshot())`，永远相等；
2. **没被读的对照组** —— 基线监听器注册了，但从未断言它非零；
3. **咬不住的取样** —— 用的是合成的回归样本，不是真实缺陷的形态。

三个的代码都写得「对」，也确实一直绿着 —— 但绿的那一刻，bug 就在那儿。

---

开源，MIT。`npx @migor/cli create my-app` 就能试。

- 仓库：https://github.com/migoric/agentia
- npm：https://www.npmjs.com/package/@migor/agentia
- 文档：https://agentia-web.pages.dev/docs　·　取舍：https://agentia-web.pages.dev/tradeoffs

最欢迎的不是「看起来不错」，是「这里你判断错了」—— 尤其是取舍页上那些我自认为想清楚了的地方。

---

## 二、短版（即刻 / 微博 / 朋友圈 / 小红书）

Agentia：一个零运行时依赖的 TypeScript Agent 框架，`npm i` 只往 `node_modules` 放一个包。

- 4 个装饰器就是全部 API：`@Tool` / `@Skill` / `@SubAgent` / `@Prompt`（划分的是「谁控制流程」，不是「能做什么」）
- 一次 run == 一条 trace（`traceId === runId`），每步记 token 和成本，成本可硬管控
- 交付的是能上线的服务：HTTP 宿主、异步任务 + 落盘续跑、中间件鉴权、结构化结果
- 劝退条件写在官网 `/tradeoffs`：要低代码 / Python / 托管平台 / React hook / 1.0 稳定性的，别选

最奇怪的一条经验：「测试永远绿」是 bug。每条不变量登记一条守卫，改坏代码确认它真的变红，抓到过 3 个假守卫 —— 代码对、绿也对，守的是另一件事。

开源 MIT：`npx @migor/cli create my-app`
仓库 github.com/migoric/agentia

---

## 三、X / Twitter 线程（英文）

**1/**
We built a TypeScript agent framework. The weirdest thing we learned along the way:

"Tests that always pass" are bugs.

Here's how we caught 3 of them — and why your suite probably has some too. 🧵

**2/**
Agentia is declarative: 4 decorators — `@Tool`, `@Skill`, `@SubAgent`, `@Prompt`.

The split is not "what can it do" but **who controls the flow**: your code, or the model.

Zero runtime dependencies. `npm i` puts exactly **one** package in `node_modules`.

**3/**
Traces are first-class, not a third-party add-on.

One run == one trace (`traceId === runId`), built in from turn 0.
Per-step tokens and cost, a single export seam (`TraceSink`), and hard budget enforcement.

Capabilities decide what it *can* do. Traces decide whether you *dare* ship it.

**4/**
It ships as a service, not a demo:
- `createHttpHandler(app, { runner })` — HTTP host in one line
- async tasks on file / sqlite / redis stores, with resume-after-crash
- middleware for auth, rate limit, audit
- typed results (`resultSchema`), no JSON-guessing

**5/**
We keep 90+ registered invariants in `docs/guards.md`.

Every guard must be mutation-batteried: break the code on purpose, confirm the test goes red. If it stays green, it's a fake guard — and we treat that as a bug.

**6/**
3 shapes of fake guards we found:
1. Self-comparison (`deepEqual(x, x.snapshot())`)
2. A control group that's never asserted non-zero
3. Samples that don't bite (synthetic ≠ real defect)

All 3 had "correct" code. All 3 stayed green while the bug was live.

**7/**
We also publish what it's *not* for — a whole page of disqualifiers: low-code editors, Python, hosted platforms, React hooks, 1.0-grade stability.

Selection advice is worth more when the author tells you when to walk away.

**8/**
MIT licensed. `npx @migor/cli create my-app`

Repo: github.com/migoric/agentia
Docs: agentia-web.pages.dev

Feedback welcome — especially on what we got wrong.

---

## 四、Product Hunt

### 英文

**Tagline:** A declarative TypeScript agent framework with zero runtime dependencies

**Description:**

Agentia is a declarative agent framework for TypeScript. You declare capabilities with **4 decorators** — `@Tool`, `@Skill`, `@SubAgent`, `@Prompt` — wire them with dependency injection, and ship a **service**, not a demo.

What's different:

- **Zero runtime dependencies** — `npm i @migor/agentia` puts exactly one package in `node_modules`. No vendor SDKs, ever (enforced by a test, not a promise).
- **Traces are first-class** — one run == one trace (`traceId === runId`), built in from turn 0. Per-step tokens and cost, a single export seam, and hard budget enforcement.
- **Ships as a service** — HTTP host in one line, async tasks on file/sqlite/redis stores with resume-after-crash, middleware for auth and rate limiting, typed results via `resultSchema`.
- **Honest about the edges** — we publish a full page of disqualifiers: low-code editors, Python, hosted platforms, React hooks, 1.0-grade stability. `/tradeoffs`
- **Guard-driven development** — 90+ invariants, each registered and mutation-batteried. We treat "tests that always pass" as bugs.

**Status:** Open source, MIT. Try it: `npx @migor/cli create my-app`

### 中文（PH 评论 / 回复用）

一句话：**零运行时依赖的 TypeScript 声明式 Agent 框架**。

- 4 个装饰器 = 全部 API 面；划分依据是「谁控制流程」（你的代码还是模型）
- 一次 run == 一条 trace，每步记 token/成本，出口只有一条缝 `TraceSink`
- 交付可直接上线的服务：HTTP 宿主、异步任务落盘续跑、中间件、结构化结果
- 劝退条件单独写了一页：低代码 / Python / 托管平台 / React hook / 1.0 稳定性，别选
- 90+ 条守卫登记在 `docs/guards.md`，每条都要过变异验证

MIT，`npx @migor/cli create my-app`。

---

## 五、awesome 列表 PR 条目

提交目标：`https://github.com/e2b-dev/awesome-ai-sdks`（插入到 E2B 之后、AgentOps 之前，按字母序）

```markdown
## [Agentia](https://github.com/migoric/agentia)
A zero-runtime-dependency declarative agent framework in TypeScript. Declare capabilities with 4 decorators (`@Tool`, `@Skill`, `@SubAgent`, `@Prompt`), wire them with dependency injection, and ship a service with built-in tracing, cost accounting, and async task stores.

<details>

### Description
- **Declarative capabilities** — 4 decorators; the split is *who controls the flow* (your code vs. the model), not what's possible
- **Zero runtime dependencies** — `npm i` puts exactly one package in `node_modules`; no vendor SDKs (guarded by a test, not a promise)
- **Traces are first-class** — one run == one trace (`traceId === runId`) from turn 0; per-step tokens/cost, single `TraceSink` export seam, hard budget enforcement
- **Ships as a service** — HTTP host, async tasks on file/sqlite/redis stores with resume-after-crash, middleware, typed results
- **Honest disqualifiers** — publishes a page of "when not to choose this" (low-code, Python, hosted platforms, client SDKs, 1.0 stability)
- **Guard-driven development** — 90+ invariants registered and mutation-batteried; "tests that always pass" are treated as bugs

### Links
- [GitHub](https://github.com/migoric/agentia)
- [Documentation](https://agentia-web.pages.dev)
- [Tradeoffs / when not to use](https://agentia-web.pages.dev/tradeoffs)
- [npm](https://www.npmjs.com/package/@migor/agentia)
</details>
```

---

## 六、30 秒视频旁白

### 英文

[0:00] Agentia. A declarative agent framework with zero runtime dependencies.
[0:03] One command creates a project.
[0:07] Built-in dev panel.
[0:10] `agentia dev` starts the inspector.
[0:14] Type a prompt. Run.
[0:20] Watch every tool call and every trace event, in real time.
[0:24] Four decorators — that's the entire API surface.
[0:27] Per-step tokens and cost, built in from turn zero.
[0:29] Zero deps. Try it: `npx @migor/cli create my-app`

### 中文

[0:00] Agentia。零运行时依赖的声明式 Agent 框架。
[0:03] 一行命令，创建项目。
[0:07] 内置调试面板。
[0:10] `agentia dev` 启动 inspector。
[0:14] 输入一句话，运行。
[0:20] 实时看到每一次工具调用、每一条 trace 事件。
[0:24] 四个装饰器，就是全部 API。
[0:27] 每一步的 token 和成本，从第一轮就开始记。
[0:29] 零依赖。现在就试：`npx @migor/cli create my-app`

---

## 七、评论区预设应答（发出去之后大概率被问到的）

**Q：零依赖怎么调各家模型？**
A：手写适配器 + 全局 `fetch`，不 import 厂商 SDK。换端点用 `ANTHROPIC_BASE_URL` 指向兼容端点；
OpenAI 兼容的（DeepSeek、本地 Ollama 等）走 `createOpenAIClient({ baseURL })`，**不需要新代码或新依赖**。
代价是：厂商 SDK 里那些高级特性没有 —— 这是取舍，不是遗漏。

**Q：跟 LangGraph / Mastra / Vercel AI SDK 比呢？**
A：别比优劣，比形态。要可视化编排选 LangGraph 的图；要「框架 + 托管平台」选 Mastra；
要前端 `useChat` 绑定选 Vercel AI SDK。Agentia 只在两层里：**运行时 + 可观测**，交付你自己上线的服务。
完整对照在官网 `/tradeoffs`。

**Q：0.x 敢用吗？**
A：规矩只有一条 —— **破坏性变更必须留痕**：CHANGELOG 对应版本要有「迁移」小节，写清你要改什么。
现数命令：`grep -nE '^#{3,4} .*(迁移|破坏性)' CHANGELOG.md`。
`0.x` 期间请**锁精确版本号**，别用 `^`。1.0 的三条门槛也写在 README 里（都是可核验的，不是口号）。

**Q：RAG / 向量检索怎么办？**
A：不内建，但形状已经在那：`@Prompt` 就是「模型可调用、先拉资产再注入」，把 `asset()` 换成
`search(query)` 即可，`src/` 零改动。所以这是**配方缺口，不是功能缺口** —— `src/` 里
`grep -rniE "embedding|vector|retriev"` 是 0 命中，刻意的。

**Q：日志 / 采样 / 脱敏 / 存储为什么不做？**
A：出口只有一条缝 `TraceSink { export(trace) }`，其余都是缝外的选择（策略留给使用者）。
配方在 `docs/observability.md` 与 `examples/observability/`，还有一份 `grafana-dashboard.json`。
判据写在仓里：**引第三方依赖的一律不进核心**（MCP stdio 连接器内置，因为它只用标准库）。

**Q：三个 `@migor/*` 附属包为什么 npm 上 404？**
A：是决定不是疏漏 —— `private: true`，机制上就不发。要用就拷目录或 `file:` 引入。

**Q：性能怎么样？**
A：仓库自带五个基准（`npm run bench:*`），但**毫秒数不是承诺**（随机器 / Node 版本变），
恒定的是**形状**（哪笔钱在什么条件下付、差多少倍）。它们刻意不进 CI（计时类在 CI 只制造抖动），
要看就自己跑 —— README「性能量级」那一节给了每条的复跑命令。

---

## 八、这一稿刻意没做的事

- **不写「50+ / 100+ 条守卫」这类精确读数** —— 会腐烂，且没人会回头核；只写与记分牌同源的下限。
- **不写体积数字** —— 每次发布都会小幅变；需要时报 npm 页上的值。
- **不写「比 XX 快 N 倍」** —— 没有对拍基准的对比句都是营销。
- **不写路线图** —— 稿子发完没人更新；想看方向去 `docs/roadmap.md`。
