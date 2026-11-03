# 业务接入侧的摩擦力诊断（网关 / 登录态 / 鉴权 / 主子 agent）

> 起因：使用者反馈「在业务里用 agentia 复杂度比较高 —— 要接网关、登录态、鉴权，另外主子 agent 的调度比较繁琐」。
>
> 本文把这句话拆成四条，逐条对代码核实「哪些是刻意的定位、哪些是真缺口」，并给出**最小改动面**。
> 判据一律走仓库定位（AGENTS.md / `docs/spec.md` §1）：**只给缝不给策略**；**会不会逼核心变厚**。
>
> 一句话结论：**接网关与鉴权本来就是宿主职责（且成本很低）；登录态那条不是「繁琐」而是「不可信」——
> 目前没有任何一条可信通道把请求身份送到工具里，而唯一能到的那条是客户端自己填的；主子 agent 属于半缺口，
> 声明层很薄，缺的是代码侧确定性编排的原语，但那条不该进核心。**

---

## 1. 四条定性

| 痛点 | 定性 | 判据 |
|---|---|---|
| 接网关 | **定位**，且成本已很低 | `examples/agent-endpoint/src/main.ts` 全文件 110 行即完成「复用业务鉴权 + 一条路由分支 + drain 接进 SIGTERM」，业务文件一行未动 |
| 鉴权 | **定位**，契约清楚 | `authenticate` 只承诺「拦在入口、读 body 之前」；策略（token / JWT / 签名）刻意不做 |
| 登录态 | 🔴 **真缺口，且是可信边界问题** | 权威身份无路可达工具；唯一可达的那条由客户端控制（§2） |
| 主子 agent | 🟡 **半缺口** | 声明层 22 行（`examples/complete/src/subagents/researcher/index.ts`）；缺「代码侧确定性编排」原语（§3） |

---

## 2. 登录态：不是繁琐，是不可信

### 2.1 三个事实

**事实一：`ToolRunContext` 里没有「请求身份」这个位置。**

`src/core/tool.ts:140-231` 共 14 个字段 —— `client` / `recorder` / `parentSpanId` / `signal` /
`priceOverrides` / `onUnpricedModel` / `toolTimeoutMs` / `maxEventChars` / `traceContent` /
`maxTotalTokens` / `maxCostUsd` / `approval` / `deferUntil` / `abandoned`。
没有 userId / tenant / requestId，也没有「自定义袋」。工具想区分「谁在问」只能去读黑板
（`RunContext.current().get(...)`），而黑板的值从哪来，是下一节的问题。

**事实二：鉴权钩子的返回值被显式丢弃。**

`src/transport/http.ts:324` 是 `await authenticate(req);` —— **不是 `const who = await ...`**。
`HttpHandlerOptions.authenticate` 的注释把这件事写得很清楚：

> 正常返回（任意值）→ 视为通过。返回值框架不转交：要 per-request 上下文请在钩子自己的闭包里存
> （避免为「暂时没有消费点」的东西发明传递通道）

问题在于「闭包里存」这条路也走不通：钩子执行时 run 还没开始，run 执行时（工具体内）没有 requestId
可以与闭包里的 Map 对账 —— 除非宿主自己发明一条「请求 → runId」的关联，而 runId 是 run 开始后才有的。

**事实三：`createApp` 不暴露 `contextInit`。**

`src/toolkit/module.ts:609` 的 `contextInit` 是内部实现，唯一职责是把 `opts.blackboard` 的键灌进黑板
（`:540` 的 `const seed = opts.blackboard`）。应用层没有 `createApp({ contextInit })` 这种入口，
所以「run 开始前按请求塞身份」在应用层无路可走。

### 2.2 唯一能到的那条路，其值由客户端决定（已实测）

传递链是通的，但**起点在客户端**：

```
POST /tasks  body.options.blackboard
   → http-endpoints.ts:389  {...submitBody.options}      （只对 traceContext 做合并，其余整体透传）
   → TaskRecord.spec.options                              （随任务落库）
   → run-call-options.ts:71-73  const { sessionId, ...restOptions } = rec.spec.options; return { ...restOptions, … }
   → app.run(msgs, { blackboard })
   → module.ts:540 seed → contextInit 注入 RunContext
   → 工具体内 RunContext.current().get('tenant') 读得到
```

实测（临时脚本，未入仓，复现步骤见附录）三个结果：

```
A. 工具内读到 user = "client-supplied"          ← app.run({ blackboard }) 直达工具体
B1. toTaskSubmitBody 后的 options = {"blackboard":{"tenant":"evil-tenant"},"maxCostUsd":0}
B2. 交给 app.run 的 blackboard = {"tenant":"evil-tenant"}
```

即：**任何能调用 `POST /tasks` 的人，都能在 body 里自填 `blackboard: { tenant: '别人的租户' }`，
并让这个值出现在每一个工具方法体内。** 而 `docs/usage-guide.md` §6.6「多租户配额」配方的第一步
就是「用黑板存 tenant」—— 照抄那段代码，配额记账（`billing` sink 读 `RunContext.current()?.get('tenant')`）
记到别人头上、配额闸放行的也是别人的余额。

### 2.3 两条路的不对称（这才是最刺眼的地方）

| 宿主 | 身份能进 run 吗 | 可信吗 |
|---|---|---|
| `POST /run`（同步 / SSE） | ❌ 完全不能。两处 `app.run`（`http-endpoints.ts:326` / `:349`）只给 `rethrow` / `signal` / `onText` / `traceContext` | — |
| `POST /tasks`（异步） | ✅ 能，经 `options.blackboard` | ❌ 客户端自填，无签名、无白名单、无服务端覆盖 |

也就是说：**需要身份的路径拿不到，拿得到的路径不可信。** 这不是「接入麻烦」，是「按文档接会接出漏洞」。

### 2.4 已有的替代品为什么不够

| 机制 | 能否承载身份 | 为什么不够 |
|---|---|---|
| `labels`（`RunInvocationOptions.labels`） | ❌ 工具读不到 | 只落 trace 根 attribute 与指标维度，run 内部无读取口 |
| `sessionId` / `SessionStore` | ❌ 语义不同 | 它是「对话维度」，不是身份；且客户端同样可自填 |
| `spec.options.<自定义字段>` | ❌ 无消费点 | 未在 `RunInvocationOptions` 里的键不会被任何一层读取 |
| `middleware` | ⚠️ 能读黑板，但不能造身份 | 中间件在 run 内部执行，读到的仍是同一个不可信黑板 |
| `authenticate` 闭包 | ❌ 无法与 run 关联 | 见事实二 |

---

## 3. 主子 agent：声明很薄，编排没有原语

**声明层已经很轻**，这点如实说清，不是缺口：

```ts
@SubAgent({ description, schema, system, tools: ['researcher', 'search/web'] })
researcher(_input: { question: string }): void {}
```

装配期校验引用存在性 + 成环（`capability-cycles.ts`），运行期隔离上下文、只回最终报告，
trace 上是一条 `capability` span 挂在发起它的 `llm.turn` 下，带 `agentia.handoff.from/to`。

**缺的是另一半**：想在**代码里**确定性地「先 A 后 B 再汇总」（不是交给模型碰运气），没有原语。

| 想做的事 | 现在只能 | 代价 |
|---|---|---|
| 顺序跑两个子 agent 并传结果 | `app.run` 串接两次 | 两棵独立的 trace 根，`traceId` 不同 ⇒ 调用树断开，而 trace 是本框架的一等公民 |
| 并行 fan-out + 汇总 | `Promise.all(app.run...)` | 同上，且预算闸各算各的（超支上限变成「每个分支各一份」） |
| 直接拉起一个「子 agent」但不建工具 | `runAgent` + 手动共享 `recorder` | 能做对（共享 `recorder` 时多个 run 根落在同一 trace），但「挂到当前 span 下」靠使用者自觉；`runAgentScoped` 没导出 |
| 运行时按条件选一个子 agent | 写一个 `@Tool` 自己判断 | 相当于把编排策略写进工具，可观察性靠人 |

**但这条不该进核心。** 按定位判据：编排是策略（顺序 / 并行 / 汇总 / 失败回退 语义千差万别），
且目前没有第二个使用方 —— 进核心就是核心变厚。它更该是 `examples/` 一个 orchestrator + `docs/` 一条 recipe。
`docs/spec.md` 也已有同向表态：「要可视化编排 ⇒ 那边是 LangGraph / Mastra 的主场」。

---

## 4. 最小改动面（两个方案，各自评估「核心变厚了吗」）

### 方案 A：给一条**可信**的身份缝（建议做）

三处小改动，都不实现任何策略：

1. **`/tasks` 的 `options` 白名单化**。现在整体透传等于把引擎内部旋钮（`blackboard` / `tools` /
   `fallbacks` / `maxCostUsd` / `contextPolicy`…）全交给客户端 —— 这是个**独立于本文**的攻击面
   （`tools` 能让客户端换掉整个工具菜单）。改成「只接受客户端该有的那几个」（`model` / `maxTokens` /
   `maxIterations` / `labels` / `idempotencyKey` / `traceContext`），其余**静默丢弃或 400**（选哪个要定，
   建议 400 + 列出允许的键：静默丢弃会让人以为生效了）。
2. **`tools` 一定要挡住**。它现在是「覆盖整份工具菜单」—— 客户端传一个自己的 `run` 就等于在服务端
   执行任意函数？不，函数没法序列化，所以实际只是「替换成空菜单」把工具废掉。**射程如实标注：
   这条不是 RCE，是「客户端能把 agent 的能力废掉」** —— 仍不该开放。
3. **加 `resolveRunOptions` 缝**，与 `traceContext` 同款「宿主给、框架透传」：

```ts
createHttpHandler(app, {
  authenticate: (req) => verify(req),        // 策略照旧是宿主的
  resolveRunOptions: (req) => ({             // 新增：鉴权**之后**调用
    blackboard: { tenant: req.user.tenant }, // 服务端值
    labels: { user: req.user.id },
  }),
});
```

语义三条（写成契约，别留解释空间）：
- 在 `authenticate` 通过**之后**、读 body **之前或之后**调用（建议之后，因为它可能要看 body）；
- **服务端值的键覆盖客户端同名键**（方向只有一个：服务端赢）—— 这是本方案的安全支点；
- 抛错 ⇒ 按 `HttpException` 处理（与 `authenticate` 同款），不给「半套身份」进入 run 的机会。

**核心变厚了吗？** 没有：加的是一个回调类型 + 一次合并，零策略、零依赖。
`/run` 与 `/tasks` 两条路同时受益，正好消掉 §2.3 的不对称。

### 方案 B：只补示例与 recipe（成本最低，治标）

不改 `src/`，只在 `examples/` 加一个 `authenticated-service`（网关透传 `x-user-id` → 自写 handler
→ 自己把身份塞进 `app.run({ blackboard })`），再补一条「代码侧编排」recipe。

**问题**：内置的 `createHttpHandler` 仍是不安全的默认值。示例教人「别用内置 handler，自己写」，
等于承认内置那条不可用于多租户 —— 这是把一个**默认不安全**留在公开面里。

**结论：A 是修缺口，B 是补文档。先 A 后 B，不要用 B 代替 A。**

---

## 5. 射程与未验证项

- 本文所有代码结论均已对 `src/` 复核，行号取自 2026-11-03 的 HEAD；**行号会腐烂，判据是文件+函数名**。
- 实测只覆盖「黑板透传链」这一条（附录脚本）。**未验证**：真实 HTTP 端到端（`POST /tasks` 带
  `options.blackboard` 打到真 server）—— 中间只差 `parseJsonBody` 一层，风险低但没跑。
- **未验证**：`options.tools` 里带一个「函数体」经 HTTP JSON 传输后的真实行为（JSON 里函数必然丢失），
  所以 §4 第 2 条标为「能力被废掉」而非 RCE —— 若要写进安全说明，需补一次实测。
- 多租户配方的作者未必按「黑板存 tenant」实现（可能自己 decode JWT 后关在中间件闭包里）。
  但 §6.6 那段代码是**唯一可抄的官方配方**，本文批评的是「抄了就不可信」这件事，不是批评某个用户实现。

---

## 6. 建议的处置顺序

1. **先定一条口径**：身份属于「宿主给、框架透传」还是「框架不管，宿主全权」？现在事实上是后者，
   但文档在 §6.6 又示范了「用黑板存 tenant」，两边不一致 —— 这是本问题的根，不是缺功能。
2. 口径定了再谈改动：若是前者 ⇒ 方案 A；若是后者 ⇒ 至少让 `/tasks` 白名单化（安全洞与口径无关）。
3. 主子 agent 编排：**不进核心**，走 `examples/` + `docs/`。

---

## 附录：PoC 复现

临时脚本（未入仓）`/tmp/poc-blackboard.mts`，核心三段：

```ts
// A. 工具体内能不能读到 per-run 黑板
const app = await createApp({ name: 'poc', providers: [], system: 'probe' });
const { client } = mockClient([toolUseMsg('read_user', {}), endTurnMsg('done')]);
let seen = 'UNSET';
const probe = {
  name: 'read_user', description: '', inputSchema: { type: 'object', properties: {} },
  run: () => { seen = String(RunContext.current()?.get('user')); return seen; },
};
await app.run([{ role: 'user', content: 'go' }], { client, tools: [probe], blackboard: { user: 'client-supplied' } });

// B. HTTP 提交体 → app.run 入参 的黑板透传（调真实纯函数，不跑循环）
const submit = toTaskSubmitBody({ input: { x: 1 }, options: { blackboard: { tenant: 'evil-tenant' } } });
const call = buildRunCallOptions({ rec: { taskId: 't1', spec: { messages: [], options: submit.options } }, … });
```

跑法（脚本放 `/tmp` 必须用 `.mts`，否则 tsx 按 CJS 编译、顶层 await 直接报错）：

```bash
cd /Users/migor/Documents/development/agentia && npx tsx /tmp/poc-blackboard.mts
```

输出（2026-11-03 实测）：

```
A. 工具内读到 user = "client-supplied"
B1. toTaskSubmitBody 后的 options = {"blackboard":{"tenant":"evil-tenant"},"maxCostUsd":0}
B2. 交给 app.run 的 blackboard = {"tenant":"evil-tenant"}
```
