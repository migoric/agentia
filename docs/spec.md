# Agentia —— 规范（持续修订）

状态：讨论收敛后的书面化，此后随实现持续修订（当前发布 v0.5.0）。**阅读口径**：§1–§9 是规范快照，
§10 是带时间线的决策日志 —— **两者冲突时以 §10 较新的决策为准**（快照只在新决策落地时回填，
回填滞后以日志为准）。

## 1. 定位（一句话）

面向应用开发的**声明式 agent 服务开发框架**：TS 装饰器 + DI + 模块；主 agent 作为路由器调度 tool/skill/subagent/prompt 四类能力；**每次 run 产出结构化结果与可观测调用树（trace、成本、指标）**；**交付物是可上线的服务而非对话助手**（trace 是必需品：既是调试表面也是审计记录，见 §9）；运行时自研、参考 Claude 设计，底层调用 Messages API。

> 不是“agent 聊天 SDK”，是“把 agent 做成服务的框架”。文本只是副产品，agent 执行出的活 + 结构化产物才是产品。
> 服务交付靠**事后**调试，所以可观测与能力声明同级：**四类能力决定它能做什么，trace 决定你敢不敢上线**。

## 2. 运行模型：run（一次运行）

对话助手的“会话=聊天”直觉作废。模型是：

```
触发(请求/事件/定时) → 主 agent 作为路由器编排阶段 → typed 结果 + 产物/副作用 出
```

- **run** = 一次任务实例。入参 = 任务 spec；出参 = 结构化结果。
- **run scope 上下文**：在单次运行内累积（blackboard），结束即释放。跨运行记忆是次级问题。
- **主 agent = 路由器**：不确定阶段顺序，而是自主决定调用哪些能力、什么顺序。
- 能力（tool/skill/subagent/prompt）= 服务的**组成阶段**。

## 3. 能力契约（四个装饰目标）

| 能力 | 运行时本质 | 结果回到主 agent 的形态 |
|---|---|---|
| `@Tool(zod)` | 函数调用 | `tool_result`（值或 `is_error`） |
| `@Skill` | 指令 + 脚本，受限子运行 | 产物/结论 |
| `@Prompt` | 纯文本资产（模板/宏/playbook） | 被选中时注入上下文 |
| `@SubAgent` | 独立 agent 循环 + 裁剪上下文 | 跑完的最终报告（隔离，中间产物不污染主上下文） |

统一抽象：这些能力对主 agent 都是“可调用项”，差异只在运行时执行方式。注册 = 把每个能力的 `name + description + 怎么用` 编译进主 agent 的菜单，由 LLM 决定调度谁。

## 4. 装饰器表面（已落定）

**已定决策：标准装饰器（ECMAScript Stage 3），不用 `experimentalDecorators` / `emitDecoratorMetadata` / `reflect-metadata`。** 因此不支持构造器参数反射 —— DI 采用模块内显式 `providers` + factory 装配（`useFactory` 式）。框架的元数据一律显式声明（装饰器参数即配置，外加 `WeakMap`/注册表存储），不依赖 `design:paramtypes`。

```ts
// 落定形态（见 §10 R5）：模块**不是类装饰器** —— `defineModule({ providers, middleware })`
// 返回一个 `AgentModule` 值交给 `createApp({ modules })`；没有 `main` 标记（主 agent 即 app 本身）。
export class ProjectModule {
  // 落定形态：SubAgentSpec 的字段全部声明在装饰器参数里（字段表见 usage-guide 的
  // @SubAgent 一节）；被装饰方法体**从不执行** —— 运行时拉起独立循环，方法只是登记锚点。
  //（没有 role 字段：角色走 system；能力边 = tools 引用 —— provider 整片引用，
  //  或 'token/能力名' 能力级路径，2026-09-16 落地，见 §10）
  @SubAgent({
    description: '按品牌规范评审设计稿，输出评审报告',
    schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    system: '你是苛刻的品牌设计评审员……',
    tools: ['image-tools'], // 可选：provider token 列表，或 'image-tools/resize' 能力级路径
    model: 'claude-opus-5',
  })
  reviewer() {}

  @Skill({ name: 'regenerate-logo', description: '…' })
  async regenerateLogo(ctx) { /* 指令 + 调 script */ }

  @Prompt({ name: 'brand-style', description: '品牌基调资产' })
  static brand() { return '扁平 + 水彩，禁用霓虹色…'; }  // 落定形态：方法（字段形态不可行，见 §10 Turn 6）
}

// 显式装配：token + useFactory，不读构造器参数反射
const providers = [
  ImageTools,
  { token: 'IMAGE', useFactory: (t: typeof ImageTools) => t },
];
```

## 5. 自研运行时：参考 Claude 的机制清单

- 主循环（manual loop）：`while stop_reason == "tool_use"`。
- **并行工具**：一次 assistant 消息可含多个 `tool_use`；**单条 user 消息回全部 `tool_result`**（拆分会抑制并行）；失败回 `is_error`，不丢块。
- **Prompt cache 布局**：顺序 `tools → system → messages`；稳定前缀在前；≤4 个 breakpoint；动态内容放最后；系统提示禁用 `Date.now()` 类隐形 invalidator。命中率用 `usage.cache_read_input_tokens` 验证。
- **长上下文三策略分清楚**：compaction（服务端摘要）/ context editing（清旧工具结果与 thinking）/ 客户端剪裁——三者不同，不混。
- **子 agent = 完整独立循环 + 裁剪上下文 + 报告以 `tool_result` 交回**（隔离是核心）。
- **预算/形态**：task budget、effort 档、流式、strict tools + 结构化输出（落地为 engine 内部追加的隐藏 `submit_result` 工具，见 §10 R2）。
- **别自研黑名单**：token 估算用内置启发式（CJK 感知、带增量缓存，见 §10 Turn 4 与 2026-09-13 性能审计；要精确计数由上层注入 `/messages/count_tokens`，框架不替你造 token），不用 tiktoken 近似；错误分类靠鸭子类型（数值 `status` / errno `code` / 带 `cause` 的 TypeError，见 §10 2026-09-17 —— SDK 类型化异常那套已随 client 自研化退役）；缓存验证靠 `cache_read_input_tokens`。

## 6. 服务层（agent 服务的关键，区别于对话）

1. **run 生命周期状态机**：queued → running → succeeded/failed；运行记录 + 调用树（trace，见 §9）。
2. **结构化结果是一等契约**：收尾产出符合 schema 的 typed 结果 + 明确成败（落地为 engine 内部追加的隐藏 `submit_result` 工具，见 §10 R2）。
3. **触发三类**：同步请求 / 异步任务（入队→轮询）/ 定时事件。
4. **可观测 + 成本**：每条 run 的调用树、token、超时、task budget。
5. **确定性工程**：幂等键、至少一次触发的去重、清晰失败语义。
6. **v1 边界**：同步 RPC 型；但 run 生命周期（状态机 + 幂等键）从第一天作为抽象存在，异步耐久 = 换宿主（队列 + store），不换语义。

## 7. 静态校验（元数据层的差异化）

运行时抢不过 LangGraph，静态声明 + 校验是 NestJS 路线独有的武器。

## 8. Build order

| 里程碑 | 内容 | 对应框架件 |
|---|---|---|
| Turn 0 | ✅ manual loop + 流式，单主 agent 调工具跑通 | 引擎内核 |
| Turn 1 | ✅ run 生命周期 + 系统提示拼装 + cache 布局 | 容器 / run scope |
| Turn 2 | ✅ 装饰器 → JSON Schema → tool_result 往返 + strict | `@Tool` 容器 |
| Turn 3 | ✅ 子 agent 作为 tool（裁剪上下文 + 隔离报告） | `@SubAgent` |
| Turn 4 | ✅ compaction / context editing / task budget（预算护栏） | 长上下文策略 |
| Turn 5 | ✅ 触发传输（同步 RPC / 异步任务 / 定时）+ run 存储/幂等 | transport 层 |
| Turn 6 | ✅ @Skill / @Prompt 能力 + 文件宿主耐久续跑 + AGENTIA_MODEL env 缺省 | toolkit / run store |
| Turn 7 | ✅ 目录约定（units/<name>/）+ 发现机制（扫描/注册表双形态）+ CLI（create/g） | toolkit / @migor/cli |

> Turn 7 的目录约定（`units/<name>/`）已于 2026-09-13 改为四分类目录（`src/tools` 等），见 §10 对应决策记录。

Trace 自 Turn 0 起内建（每个 LLM 往返都记账），Turn 1 后是完整形态。

## 9. Trace（调用树）—— 一等公民

Agent 服务靠**事后**调试，trace 是调试表面 + 审计记录（对话助手能现场看，trace 对服务交付是必需品）。

### 9.1 模型（对齐 OpenTelemetry 命名，便于接基础设施）

- 一次 run == 一条 trace；v1 里 `traceId == runId`，1:1。
- 树形层级：
  - `run`（根 span）= 整次运行
  - `capability` span = 对 **skill / subagent** 能力的调用（这两类才在内部开子循环、产生子 span）
  - `llm.turn` span = 每次模型往返，挂 usage（model / input / output / cache_read）
  - 普通工具与 `@Prompt` 资产**不建 span**，只记在发起它们的 `llm.turn` 上的
    `tool.input` / `tool.output` 事件（`engine/loop.ts`）
  - 子 agent = 一个 capability span，其内部能力递归成它的子孙
- span 属性：model、input/output/cache tokens、成本估计、状态、错误类型。
- 事件（logs）：工具入参/出参**正文默认截断**（入参/成功出参 2000 字符、失败出参 1000），
  完整正文由 `RunInvocationOptions.maxEventChars: false` 显式开启（缺省关）。截断只在**记账**侧，
  回给模型的 tool_result 不受影响。脱敏**不在框架内**（见 §9.3：那是 sink 缝外的事）。
- 状态：`ok` / `error` + 错误分类（可重试 vs 不可重试）。

### 9.2 上下文传播

- span 句柄**不放 RunContext**（`RunContext` 只有 blackboard）：engine 在每次能力调用时注入
  `ToolRunContext{ client, recorder, parentSpanId, signal, … }`，能力执行体（skill/subagent）
  用它把 `capability` span 挂到发起它的 `llm.turn` 下 —— 不用全局单例，
  并行 tool 调用的父子关系因此是准的。
- trace 记账**留在 engine 层**（`agentLoop` 内联记账），不包 TraceInterceptor ——
  「改写为内置拦截器」的 dogfooding 设想经评审放弃（capability span 生命周期与模型调用
  纠缠在 loop 内，强行外置反而割裂），见 §10 2026-09-11 R1 条。能力调用层的拦截由
  装配层的 `CapabilityMiddleware` 洋葱链承担，与 trace 记账是两条独立的缝。
- **跨进程关联（2026-09-17 入站 / 2026-09-21 出站，见 §10）**：入站 `traceparent` 头（W3C）或
  `RunInvocationOptions.traceContext` → run 根的一条 **span link**（`SpanLink`），OTLP 导出映射为
  span links。形态选 link 而**不是**继承上游 traceId —— `traceId == runId` 的 1:1 不变量不变，
  run 永远是自洽的一棵新树。**出站已落地（2026-09-21，决策见 §10 当日条）**：
  `currentTraceparent()` 给出当前**调用期** span 的 W3C 串（`src/engine/span-scope.ts` 的
  per-call 作用域，三层由粗到细：run 根 → 本回合 `llm.turn` → `capability`），宿主把它带在
  自己的出站请求上；框架只给读取器、不替宿主做注入（它不创建出站请求）。
  队列宿主侧已验证：`traceContext` 随 `spec.options` 落进 `TaskRecord`，所以另一个进程
  `resumePending` 续跑的那次 run 也带得上。
  ⚠️ 本节原先写的「缺的前置件是『`RunContext` 暴露当前 span』」是**错的**，与上一段自相矛盾
  （span 句柄刻意不放 `RunContext`）：run 级只存一个值，并行工具会互相覆盖；真实前置件是
  **另开一条调用期作用域**。另：出站 id 宽度走 `core/trace.ts` 的**同一份投影**
  （`wireTraceId` / `wireSpanId`，OTLP 导出也用它）—— 各写一份会让同一次调用在两个系统里
  出现两个 span id。

### 9.3 产出与导出

- v1：内存 trace store，随 run 结果/运行记录返回（结构化输出 / JSONL），便于回放调试。
- 生产：经 **sink 出口**（见下）导出 —— `createOtlpExporter` 现成、零依赖；「span 与 run 记录**同库**存储」
  只是**一种 sink 配方**（`docs/observability.md`），**不是框架内建** —— 框架只保证出口，落库 / 采样 / 脱敏 /
  按 runId 检索都由宿主用 sink 组合，零 engine 改动。
- 成本：span 级 usage 聚合自 API usage 字段（`cache_read_input_tokens` 等），run 汇总 = 各 span 求和。
- **trace 出口（sink）**：`TraceSink { export(trace) }` —— run 收尾（成功 / 失败两条路径）后框架把
  完整 trace 交给每个 sink；sink 抛错被吞（吞之前落一条 `console.warn` 告警，§10 2026-09-27 ②），
  不影响 run。
- **增量出口（2026-09-21，与 sink 并列为第二条缝）**：`onTraceEvent`（单次 run 一个 + 应用级缺省）
  在 run **进行中**逐笔回调记账事件（`span.begin` / `span.end` / `span.event` / `span.attribute` /
  `span.link`，各带单调 `seq`），消费者是**等不了收尾**的那一类（终端面板 / SSE / 异步任务流）。
  机制只有一处：`TraceRecorder.subscribe()` —— 记账点唯一，engine 零改动。
  两条缝的分工写死为：**sink = 收尾拿整棵且会投递**（有兜底语义）、**事件 = 运行期逐笔且
  `不保证送达`**（宿主自己的流断了就断了）。传输层两个出口都用它：`POST /run` 的 SSE 追加一族
  `trace.event` 帧（既有三帧逐字不变）、`GET /tasks/:id/stream`（重放 → 实时 → 终态收口）。
  不变量：把一次 run 的全部事件按 `seq` 折回，必须**逐字等于** `snapshot()`（不丢 / 不重 /
  顺序 / 同源四件事一条用例钉住）。装配层 `AppOptions.sinks` 与
  `registerDefaultTraceSink()`（全局默认，构造期快照合并）；`createOtlpExporter()` 的返回值天然满足
  该接口。`agentia dev` 的本地 inspector 即经此出口取数（框架不读 env、不含 dev 逻辑）。

### 9.4 记录成本与采样（2026-09-21 已决定，不再是开放问题）

**结论：默认全量记账 + 截断默认开 + 采样不内建（是配方）+ 代价可数。**

实测依据（`npm run bench:trace`，零 token 零网络，可复现）：

- 成本 **90%+ 是事件正文**：0 次工具调用的底噪 1.2 KB（span 骨架），
  之后每次工具调用 **+1.3~1.8 KB**（缺省截断）。
- 真正会失控的是宿主**显式打开**的两件事：`maxEventChars: false`
  （大出参下 **13.66×**：5 次 37 KB 出参 17 113 → 233 797 字节）与**长跑**
  （线性：100 次工具调用 ≈ 250 KB）。
- 因此默认值不动：`maxEventChars` 默认仍收敛（2000 / 成功出参 2000 / 失败出参 1000），
  `traceLimits` 默认**不设**（全量是我们对外的承诺）。上限是给「长跑 + 大出参」的显式闸。

三项落地（都不是「默认改小」，而是「让代价可见 / 可算」）：

1. **数量上限 + 丢弃计数**：`traceLimits.maxEvents` 超限即停止记账，并在 run 根留**两笔**
   `trace.truncated`：起点标记 `{limit}`（断点）+ 收尾摘要 `{droppedEvents, limit}`（丢弃量）
   —— 与 OTLP `partialSuccess` 那条同因：「少了一半数据」必须有人能收到。
   ⚠️ 两笔都**同时**进交付的 trace 与 `onTraceEvent` 增量流（2026-09-28 ⑨ 定的口径）：
   只在一条缝上出现的事件，会让「按 `seq` 折回逐字等于 snapshot」那条契约变成假话。
   两笔簿记**不占** `maxEvents` 配额（**不做**环形缓冲：中间空洞比尾巴截断难解释得多）。
2. **采样留在缝外**（`docs/observability.md` 2.3，实现见 `examples/observability`）：
   本轮补的是**可算**（容量换算表）与**可数**（`sampleSink(...).dropped()` + `onDrop`）——
   不数的话「被采样掉」与「本来没跑」在监控上无法区分。
3. **可复现的证据**：`scripts/bench-trace-cost.ts` 进仓（与 `e2e:live` / `e2e:soak` 同档，
   不进 verify-all）——阈值这类问题的答案必须是数字，不是印象。

**未采纳**：框架内建 `samplingSink`（与 §9.3「采样是宿主职责」冲突，且示例已有实现 ⇒
同一件事两份实现）；事件落 store 的真跨进程实时流（写放大：实测事件数 = 2 × 工具调用、
正文 KB 级）；动态采样率；OTEL SDK 兼容层。

> 「trace 作重放基底」已落地，不再是开放问题：`traceToMessages` 把 trace 线性化为 messages
> （R6 / v0.2.0，见 §10 2026-09-11），`forkMessages(trace, { atTurn, append? })` 支持在主循环
> 第 N 回合截断分叉、拼新消息喂回 `app.run`（2026-09-16，见 §10）。两者同源有损
> （trace **缺省**不记 assistant 原文 —— opt-in 例外见 §10 2026-09-27 ④ `traceContent`）：
> 产物跑的是**新 run**，不是接着原 run 续跑。

## 10. 决策记录

- 2026-09-10：TypeScript 用 7.x（native tsgo，npm latest 实测 7.0.2）。
- 2026-09-10：**装饰器走标准（Stage 3）+ 显式 DI（providers/useFactory）**，弃用 `experimentalDecorators`/`emitDecoratorMetadata`/`reflect-metadata` —— 原生编译器已在考虑移除 legacy 元数据发射，新框架不该押其上。
- 2026-09-10：**trace（调用树）为一等公民**，与 run 1:1，自 Turn 0 内建。
- 2026-09-10：**trace v1 范围 = 单次 run 链路追踪 + 每步 usage**（每步 token/成本/成败/耗时）。跨 run 账单报表、预算硬管控 → 后置，不在 trace 内做。
- 2026-09-10：Turn 2 —— **run 作用域上下文用 AsyncLocalStorage 传播**（executeRun 内建 ctx，执行体 `RunContext.current()` 直取），工具/子 agent 执行不把 ctx 作参数层层下传；`@Tool` 只登记「方法→spec」，AgentTool 由 `collectTools(instance)` 对容器解析后的实例生成（此时才绑定 this），零反射、与 tsgo/esbuild 双兼容。
- 2026-09-10：Turn 3 —— **主循环抽成 `agentLoop`（不自开 run 根，llm.turn 挂给定 parentSpanId）**；`runAgent` = 开 run 根后调它，`runAgentScoped` = 嵌套能力入口。**子 agent 复用同一循环**：开 `capability` span（挂发起它的 llm.turn 下）→ 独立 messages（只含任务 JSON，裁剪主对话）→ 内部 llm.turn 递归成 unit 子孙 → 仅最终文本以 tool_result 交回（隔离报告）。工具执行注入 `ToolRunContext{client, recorder, parentSpanId}`，recorder 用 `core/tool.ts` 的 `RecorderBackend` 结构面（core 不依赖 engine）。usage 天然跨两级聚合（同 recorder 求和）。
- 2026-09-10：Turn 4 —— **长上下文三策略分清不混**：`trimToolPairs` = **context editing**（整体丢旧 tool_use→tool_result 对，不掉内容、不额外调模型）；`compactMessages` = **compaction**（旧前缀做**服务端摘要**，摘要器由上层注入 —— 框架不替你造 token，真机可接 LLM / `/count_tokens`）；客户端剪裁 = Turn 3 子 agent 的独立上下文。预算决策用 `estimateTokens` 启发式（缺省 **CJK 感知**：CJK ≈1.5 字/token、其余 ≈4 字符/token，明确标注是估算非精确记账）。`createBudgetPolicy` 带滞回（`compactEvery` 防每回合反复压缩）；发生改写时在 run 根上记 `context.budget` 事件。触发点 = `agentLoop` 每回合发送前 `contextPolicy.beforeTurn(messages)`。
- 2026-09-10：Turn 5 —— **三类触发（同步 RPC / 异步任务 / 定时）共用同一份入参契约 `RunInput`**（string / messages / {prompt|text|messages}，`normalizeMessages` 归一），与 agent 装配解耦 —— **换宿主（HTTP/队列/DB）不换语义**。**at-least-once 幂等**：`AsyncRunner.submit` 以 `idempotencyKey` 去重，同键未失败（queued/running/succeeded）直接返回既有记录不重复跑；**失败的同键可重提新任务**。`executeRun` 增加 `rethrow:false`：异步宿主用它接住硬失败、以 `failed` 记录落库而非冒泡。异步耐久 = `TaskStore` 结构接口（v1 `InMemoryTaskStore`），队列/DB 宿主只需实现它。定时层 `Scheduler.every/.at` 依赖 AsyncRunner，周期任务幂等键按 interval 窗口分片。
- 2026-09-10：Turn 6 —— **`@Skill` = 代码控制的流程（脚本式 + `SkillContext.llm()`）**：方法体是确定性脚本，「要不要调模型 / 调几次 / 拿结果怎么算」写死在代码里；模型调用只在显式 `ctx.llm()` 时发生 —— 受限子运行复用 `runAgentScoped`（不自开 run 根），在 skill 自己的 `capability` span（attribute `skill`）下开 llm.turn 记账，中间结果不外泄，**方法返回值即产物/结论，以 tool_result 交回主 agent**。与 `@SubAgent`（模型自主循环 + 裁剪上下文）是可感知区别。**`@Prompt` = 纯文本资产**：编译成菜单里一个无副作用拉取型 AgentTool（模型判定需要时调用、文本以 tool_result 注入上下文 —— 我们现成的唯一「被选中」机制）。**标准装饰器下字段拿不到值/类引用 → `@Prompt` 只支持方法形态**（实例方法沿原型链、每次调用现算 volatile；static 方法表达常量资产），§4 草图的 `static brand = '…'` 字段形态不可行、已改方法。菜单四类能力（tool/skill/subagent/prompt）**共用命名空间**：装配期统一查重、重名即抛（§7 静态校验最小落地）。**异步耐久落地 = `FileTaskStore`（JSONL 一行一快照，last-wins 还原）**：`AsyncRunner`/Scheduler/触发层**零改动**，宿主重启 `new FileTaskStore(path)` 读回记录 + `AsyncRunner.resumePending()` 续跑 queued/running。缺省模型改 `resolveDefaultModel()`：**`AGENTIA_MODEL` env 覆盖**，无则回落 `claude-opus-5`。**确认不拆 npm 包**（core/runtime/transport 拆分后置发布阶段）。
- 2026-09-10：Turn 7 —— **目录约定 + 发现机制 + CLI 落地**。`units/<name>/` 一能力一文件夹：`index.ts` 入口 default export（类 → token=文件夹名的 useClass / Provider / Provider[]），长文本资产放文件夹内 `.md`，`asset(import.meta.url, rel)` 现读不缓存（保 @Prompt volatile 语义）。**发现机制双形态**：运行时扫描 `discoverProviders(dir)` / `createApp({ discover })`（动态 import 决定其为 Promise 返回）与 CLI 维护的 `units.ts` 显式注册表（标记行 codemod，幂等）——可混用，AgentApp 构造期同 token 去重（后注册覆盖先注册，与 Container 语义一致），装配期静态校验（查重/引用/toolSources）对两条路一视同仁。**CLI 独立成包** `@migor/cli`（npm workspaces，零运行时依赖、纯 Node 内置）：`create` 脚手架项目、`g tool|skill|prompt|subagent <name>` 生成能力文件夹并登记注册表；kebab-case 命名校验，方法名 snake、类名 Pascal。注意双实例危害：消费方必须从同一模块实例 import 框架（装饰器 WeakMap 注册表不跨实例），smoke:turn7 因此统一走 dist。
- 2026-09-11：**R1–R5 一轮落地（v0.1.0）**。**R1 中间件**：`CapabilityMiddleware` 洋葱链（链序=注册序，`next(newInput)` 可改写、不调 next 即短路），**装配期包裹整个菜单**（`applyMiddleware`），对 engine 零侵入——trace 仍留 engine 层（改写为拦截器的 dogfooding 设想经评审放弃：capability span 生命周期与模型调用纠缠在 loop 内，强行外置反而割裂）；孤儿能力告警定义为「toolSources 收窄时被排除 provider 上的能力」。**R2**：typed 结果走 hidden `submit_result` 工具（engine 内部追加，菜单同名即装配冲突；校验失败回 is_error 让模型自我修正，system 指令追加在 volatile 尾部不污染缓存前缀）；zod 接入 duck-typed（`fromZod` 挂 `__zodValidate`，框架永不 import zod，序列化时自动丢弃函数字段）。**R3**：HTTP 宿主只产 handler 不 listen（/run 同步、/tasks 异步+轮询，失败也 200 带 error 与 rethrow:false 对齐）；`SqliteTaskStore` 用 Node 内置 `node:sqlite`（WAL 天然多进程安全，解 FileTaskStore 单写者限制）；OTLP 用 OTLP/JSON + 全局 fetch，零依赖。**R4**：`ModelClient` 结构面定义在 core（Anthropic SDK 天然满足），`createOpenAIClient` 手写请求/响应双向翻译（非流式模拟、cache token 恒 0、refusal 近似——三处近似边界写入头部注释）；`MemoryStore` 只有 load/save 两个钩子，水合在 contextInit 之后（用户种子优先），成功/失败路径都回写（失败路径 save 异常吞掉防掩盖原始错误）。**R5**：`defineModule` = providers + middleware 打包（模块级在前、应用级可覆盖同 token）；CLI 补 dev（tsx watch 转发信号）/ doctor（纯静态体检，不 import 用户代码）/ add（npm install + 注册表 codemod，解析真实包名含 file: 协议）。**全量验证改为 `npm test`（node:test）+ `npm run e2e`（CLI 端到端）**，老 smoke 脚本删除，唯一盲区 SystemPrompt 缓存布局已补进单测。
- 2026-09-11：**R6 落地（v0.2.0）**。子 agent typed：`runAgentScoped` 透传 resultSchema，交回形态 `{ report, result }`（report 在前保可读性，未提交时行为逐字不变）。**TaskStore 接口放宽为 MaybePromise**：同步实现签名不变（天然子类型），AsyncRunner 内部全 await 化 + 异步 store 的幂等去重推迟到执行前（同步门面 submit 签名不变）；`RedisTaskStore` duck-typed `RedisLike`（get/set/del + keys|scanIterator，框架永不 import redis 包）。`traceToMessages` = trace 重放基底（§9.4 落地）：llm.turn 按 startedAt 稳定排序线性化（含嵌套），tool 对同名优先配对、缺失补 is_error 占位；assistant 原文 trace 未记录，以标注文本占位。**collect 扫描改 `Reflect.ownKeys`**：symbol 命名装饰方法不再被静默忽略（无显式 name 由 unitName 抛错）——修掉「注释承诺但代码不可达」。**website 移入 packages/website**（monorepo 结构统一），官网新增 BYOK 真实模型 playground（key 仅 localStorage，浏览器直连 Anthropic）与 api.html；新增 AGENTS.md 记录仓库结构与协作约定。

- 2026-09-11：**全量评审修复轮 + src 目录重构 + 官网响应式（v0.2.2）**。评审结论：**主路径有纪律，佐助路径没有**——所有问题集中在同一条缝上（落库失败杀进程、记忆回写失败毁掉成功的 run、子 agent 绕过鉴权、replay 产物在缺省模型上 400），修复原则统一为「辅助操作失败不得击穿主路径」。
  **目录重构（先做、零行为变更）**：`src/run/` 按职责拆为 `runtime/`（run 生命周期与调用契约）+ `transport/`（触发宿主）+ `store/`（任务存储）+ `integrations/`（外部系统适配）；`engine/context.ts` → `engine/trimming.ts`（消除与 `runtime/context.ts` 的同名异层）；`tests/` 同步镜像；`src/index.ts` 导出面逐字不变（仅 re-export 路径 + 新增 `isSuccessStopReason`）。
  **七条发布阻塞**：`AsyncRunner` 私有 `#safeSave`（先包再调，同步抛出也变 rejection，槽位 `try/finally` 必达）；`readBody` 加 `maxBytes`（默认 1 MiB → 413）并监听 `close` 兜底未 `end` 即中断的请求；`traceToMessages` 末条为 assistant 时补一条 user（否则是 prefill，缺省模型 400）；`@Skill`/`@Prompt` 的 override 改 `Reflect.apply` 动态查表（与 `@Tool` 对齐）；成功路径 `flushMemory` 包 try/catch（辅助回写失败不得把成功的 run 翻成 failed）；`mapStopReason(finish, hasToolCalls)` 以 `tool_calls` 非空为准（兼容 DeepSeek/vLLM/Ollama 等回 `stop` 的端点）。
  **新增公开选项（均带向后兼容默认）**：`HttpHandlerOptions.maxConcurrentRuns`（32，超限 503 + `Retry-After`，`Infinity` 复旧）/ `maxBodyBytes`（1 MiB）/ `exposeErrors`（false，500 只回通用文案）；`AsyncRunnerOptions.runTimeoutMs`（0＝不限；`Promise.race` 超时即标 failed 并回收槽位，注释写明是「放弃等待」非「终止执行」）与 `resumePending({staleAfterMs})` + `TaskRecord.ownerId`（跳本进程记录）；`RedisTaskStoreOptions.ttlSeconds`；`ScheduleEveryOptions.maxInFlight`（1）。
  **语义变更（此处锁定）**：`POST /run` 默认并发闸门 32；新增 `stop_sequence`（视为正常完成）与 `unknown_stop_reason`（保留文本但标 error）两个 `AgentStopReason`；replay 产物末条必为 user。
  **次要修复 14 处**：fsStore 载入截断残行自愈、tool 事件带 `tool_use_id` 且 replay 按 id 配对、`iterations` 就地累加、`validateJsonSchema` 移入 try、redis 空 `prefix` 抛错、`Object.hasOwn`、`normalizeMessages('')` 抛错、`decodeURIComponent` 容错、`Container.register` 清缓存、`discover` 软链、middleware `next` 守卫等。
  **许可证**：仓库根 + 两包补 MIT。**官网**：全面响应式（≤420 断点 + 汉堡导航，20 组「页面×宽度」零横向溢出）。测试 142 → 182 例。

- 2026-09-11：**官网迁移到 Astro（构建型静态站，v0.2.2）**。动机：四页纯 HTML 无模板层，`<nav>`/`<head>` 各抄四遍、改一处要动四处；playground 两脚本靠全局变量 + 标签顺序串联；GSAP/Lenis/字体全走 CDN（违背「资源本地化」）；且无构建产物，`wrangler pages deploy public` 直接传源码。选型**刻意不引 SPA 框架**——静态宣传站上 React/Vue 会带来 hydration 与 SEO/LCP 倒退，取 Astro：默认零客户端 JS，交互页按 island 挂载，现有 vanilla JS 几乎原样平移。
  **结构**：`src/layouts/Base.astro`（head/背景层/Nav/slot/Footer/共享脚本）+ `src/components/{Nav,Footer}.astro` 消除 ×4 重复；四页降为 `src/pages/*.astro`，正文抽到 `src/fragments/*.html` 经 `?raw` + `set:html` 注入；`src/scripts/` 收拢脚本（`scrollspy.js` 由 docs/api 逐字重复的内联脚本合并而来，`site.js` 的 GSAP/Lenis 由 CDN 全局改为打包 import）。
  **两处 Astro 陷阱（此处锁定）**：① frontmatter 的 import 只在构建期（Node）执行，**客户端脚本必须写在 `<script>` 标签里**才会下发；② 模板中 `{` 是表达式起始，而正文含大量 TS 代码块，故正文走 `?raw` 片段注入而非内联。
  **验证标准是零回归**：`build.format: 'file'` 保持 `*.html` 既有 URL；CDP 探针在 11 档宽度 × 4 页比对迁移前后——文档高度逐像素一致（除下述修复项）、渲染文本逐字节一致，gsap/lenis/canvas/marquee、窄屏导航折叠、docs/api scrollspy、playground 完整回放全绿，运行时零外部请求。
  **顺带修复（迁移前既有，非本次引入）**：`.table-wrap` 的 `overflow-x: auto` 原本只写在 ≤560px 断点内，导致 861–1050px 区间（侧栏仍在、内容列被压窄，而内容列是 `minmax(0,1fr)` 不会撑开）表格 min-content 直接顶破页面——900px 溢出 57px、861px 溢出 96px。提升为全局规则，并把表格纵向 margin 挪到容器上（overflow 容器会阻断子元素 margin 折叠，否则每张表多出约 36px 空隙）。副作用：≤560px 的表格间距与宽屏统一（移动端此前多出的空隙属非预期行为）。

- 2026-09-11：**trace 出口缝（Dev Inspector 前置）**。`TraceSink { export(trace) }` 升格为框架一等出口
  （形状复用 `OtlpExporter`，`createOtlpExporter()` 返回值天然满足）；`executeRun` 成功 / 失败两条路径
  均投递，sink 抛错吞掉不影响 run。装配层 `AppOptions.sinks` 与 `registerDefaultTraceSink()`
  （全局默认，构造期快照合并）。框架**不读 env、不含 dev 逻辑**——dev 注入由 CLI 侧 `--import`
  preload 完成（`registerDefaultTraceSink` 为公开扩展点）。**顺带修正 §9.1 口径**：capability span 只由
  skill / subagent 创建，普通工具与 `@Prompt` 走 turn 上的事件（此前描述为四类能力一律建 span，
  与实现不符）。

- 2026-09-11：**第二轮回评修复（并入 v0.2.2 未发布窗口）**。上一轮修的是「辅助操作失败击穿主路径」，本轮把同类缝补完并关闭一处安全缺陷。以下语义变更**在此锁定**：
  **安全 / 正确性**：① `AgentApp` 装配重构——嵌套能力（子 agent / skill）的 `tools` 引用改从**中间件包装后**的每 provider 菜单解析（`wrappedByToken`），原实现取包装前的原始菜单，导致子 agent 内部每一次工具调用整体绕过中间件（鉴权 / 限流 / 审计 / 结果缓存全失效）——spec 曾记档的既知缺陷就此关闭；主菜单仍只取 `toolSources`，被排除的 provider 仅「不进主菜单」，其能力经显式 `tools` 引用仍可调用（孤儿告警文案同步更正）。② `engine/loop.ts` 的 `submit_result` 校验移入 try——畸形 resultSchema 只废掉该次提交（回 is_error），不再让整次 run 以 error 收场而与 trace 记的该回合 ok 自相矛盾。③ `runtime/run.ts` 的 `hydrateMemory` 包 try——与 `flushMemory` 对称，store 故障不再杀死 run。
  **宿主稳定性**：④ `AsyncRunner.submit` 订阅异步 store 的 `byIdempotency` Promise（原实现丢弃返回值，reject 即 unhandledRejection → Node ≥15 终止宿主；同一函数内 `save` 本有 `.catch`，属一防一漏）。⑤ `submit` 初始 `save` 的迟到 reject 仅在任务仍 `queued` 时改判，不再把已成功的 run 覆写成 failed（落库终态与真实结果一致）。
  **契约与资源**：⑥ `Trace.totalUsage` 只累加 `llm.turn` span——capability span 的 usage 语义锁定为「子孙聚合、仅供展示」，不参与求和（否则与子孙重复计数）；`core/trace.ts` 的类型注释同步更正。⑦ `FileTaskStore.compact()` 新增（append-only JSONL 压实为每 task 一行；TaskStore 接口之外的显式能力）。⑧ `InMemoryTaskStore({ maxRecords })` 新增内存闸门：超限从最旧**已终态**记录起淘汰，在飞（queued/running）记录永不淘汰；缺省 Infinity ＝ 不淘汰（旧行为）。⑨ `SqliteTaskStore` 补 `PRAGMA busy_timeout = 5000`——原实现只设 WAL，「多进程安全」的承诺实际不成立（第二个写者立即 `SQLITE_BUSY`，而 `#safeSave` 会把失败静默吞掉 → 记录无声丢失）。
  **语义修正**：⑩ `createBudgetPolicy` 拆出 `keepToolPairs`（context editing 按「对数」），`keepRecent` 只管 compaction 的「条数」——同一值套两种单位的隐含 bug 消除。⑪ `trimToolPairs` 前置 `toolBlocksPaired` 校验：非严格交替历史（连续两条 assistant 带 tool_use 等）整体放弃裁剪，不再切出孤立 `tool_use` / `tool_result` 让后续请求 400。⑫ `createApp({ discover })` 与显式 `providers` 同 token 时**显式优先**（显式放发现结果之后）——原实现让 `units/` 下同名文件夹悄悄顶掉调用方手写的 provider。⑬ `Container.register` 传递失效缓存：依赖它的下游一并重建，不只失效 token 自身。⑭ `Scheduler.every` 拒绝非正有限数（`every(0)` 不再退化成忙轮询空转）。⑮ `RedisTaskStore` 的 MATCH 模式转义前缀 glob 元字符（前缀含 `[` 等会查错 key）。⑯ OpenAI 兼容适配器对 200 但空 / 缺 `choices` 的响应抛错（原实现静默映射成空文本 + usage 全 0 + `end_turn`，把上游故障记成成功）。
  **测试** 190 → 210 例（上述每条各带一个「移除修复即失败」的回归用例）。

- 2026-09-11：**DX（类型链路）与 AI 可编码性**。动机：框架 API 的编辑器补全本来就好（`app.` / `createApp({` /
  各 spec 对象都有字段补全、导出面都有 JSDoc），但**「你自定义的东西」没有类型链路** —— 黑板键是裸 `string`、
  `result.typed` 是 `unknown`、schema 与方法签名双写且默认互不校验。这三点正是「记不住 API」与「AI 猜错 API」的根源。
  以下语义变更**在此锁定**：
  **① 黑板类型化（可选，声明合并）**：新增导出 `Blackboard`（空接口）/ `BlackboardKey` / `BlackboardValue` / `BlackboardSeed`。
  `RunContext.get/set/has/delete/keys` 的键类型改为 `BlackboardKey`，值类型由键推导。未声明 `Blackboard` 时
  `BlackboardKey = string`、值为 `unknown`（**与旧行为逐字一致**）；声明后键有补全、拼写错误编译期报错、
  `run({ blackboard })` 种子也有键校验。**签名变更（轻微破坏）**：`get` 的第一个类型参数从「值类型」变成「键」——
  旧写法 `ctx.get<string>('k')` 在未声明 `Blackboard` 时仍能编译（键 `string`）但返回值退化为 `unknown`；
  要显式值类型改用断言 `ctx.get('k') as string | undefined`。动态键走文档逃生口 `ctx.get(key as BlackboardKey)`。
  **② schema 即单一事实来源**：新增导出 `TypedSchema<T>` / `SchemaType<S>` / `SchemaInput<S>`；`fromZod<T>()` 返回
  `TypedSchema<T>`（幻影字段，运行时不出现）；`ToolSpec<S>` / `Tool<S, O>` 的方法入参类型改为 `SchemaInput<S>` ——
  于是 `fromZod<T>` 之后**方法签名与 T 不一致直接编译期报错**，不用手写泛型。**签名变更（明显破坏）**：
  `Tool` 的第一个泛型从 `I`（入参）变成 `S`（schema），旧写法 `@Tool<{city:string}, string>` 会因 `S` 不满足
  `extends JsonSchema` 而**响亮报错**（不静默）；改用 `fromZod<T>` 或裸 schema。裸 `JsonSchema` 与
  `fromZod` 未给 `<T>` 时入参回落 `any`（不校验），保持向后兼容。
  **③ 结构化结果类型化**：`AgentRunResult<T = unknown>` / `AgentLoopResult<T = unknown>` 泛型化；新增
  `SchemaType<S>`（`unknown` 回落，与旧 `typed: unknown` 一致）；`RunAgentOptions<S>` / `ExecuteRunOptions<S>` /
  `RunAppOptions<S>` / `AgentRunOutput<T>` 随之泛型化，`app.run` / `executeRun` / `runAgent` 的返回值从 `resultSchema`
  **自动推导** `typed`。**补齐**：`RunAppOptions` 新增 `resultSchema`（此前 `app.run` 根本传不了结构化结果 schema ——
  该能力只从 `executeRun`/`runAgent` 可达，属漏接）。
  **④ 顺带修 `FactoryProvider.useFactory` 逆变 bug**：形参由 `(...deps: unknown[]) => T` 改为 `(...deps: never[]) => T` ——
  函数参数逆变，旧写法会拒掉一切带类型形参的正常工厂（`(cfg: Config) => T` 不可赋值），与 `ClassProvider.useClass`
  的 `new (...args: never[])` 对齐。
  **⑤ 文档与验证基建（本轮新增，此后是硬约定）**：`docs/usage-guide.md` 为**使用者向唯一说明**（API 速查 + 类型链路 +
  已知边界 + 反例），三处消费：`packages/cli` 构建拷成 `dist/AGENTS.md` 并由 `agentia create` 写进新项目、
  官网 `/llms-full.txt` 与 `/llms.txt`（导出清单同源派生）。`tests/docs/usage-guide.test.ts` 把说明里的**表格逐项**
  对源码核（成员容器/导出面），改名即失败。新增 `typecheck:tests`（src+tests 一起类型检查 ——此前**测试目录从未被
  类型检查**，首跑 50 个错误，已全修）与 `typecheck:types`（`tests/types/` 用 `@ts-expect-error` 断言「应当报错」的
  场景真报错，**针对构建产物 dist 编译** —— 模块增强在同一编译程序内全局生效，与 src 混编会污染框架自身）。
  测试 210 → 215 例（+ 类型断言测试与 e2e 的 AGENTS.md 内容校验）。

- 2026-09-11：**第三轮评审（聚焦 MINOR/NIT，并入 v0.2.2 未发布窗口）**。三路独立复审后逐条回读源码核实：无新增 BLOCKER/MAJOR，全是打磨项，本轮一次性修完（各带用例）。
  **语义 / 契约变更（在此锁定）**：① `TrimOptions.keepRecent` → **`keepToolPairs`**（`trimToolPairs` 的选项按「tool_use→tool_result 对数」命名，与 `createBudgetPolicy.keepToolPairs` 口径统一，彻底消除同名不同义）。② `Scheduler.at()` 校验 `when` 必须是合法 `Date` —— 非法日期原会算出 NaN 延迟并**立即触发**（无提示），现在直接抛错（与 `every()` 的间隔校验对称）。③ HTTP 方法不符的 405 文案由英文改中文（并补 `Allow` 头），与同文件其余错误统一。④ `RedisTaskStore.ttlSeconds` 校验由 `ttl < 0` 改 `!(ttl >= 0)` —— 原写法放过 `NaN`，会静默关闭 TTL。⑤ `InMemoryMemoryStore.load` 改用无原型对象（`Object.create(null)`）—— `{}` 上 `__proto__` 键会走原型 setter 被吞，与该键的 `flushMemory` 回写不对称（静默丢一条跨 run 记忆）；**行为变更**：`load()` 现返回无原型对象（与 `save()` 收到的形状一致），断言需展开后再比。⑥ `SqliteTaskStore.status` 列明确为「反规范化副本，仅供外部/DBA 按状态统计」（本 store 的 SELECT 只读 `json`）。
  **去重 / 死代码**：`core/json.ts` 新增 `truncateWithMark` 供 `engine/loop.limit` 与 `engine/replay` 共用（`asString` 改复用 `stringifySafe`）；`store.ts` 新增模块级 `nextTaskId()` / `isThenable()`（后者原在 `async.ts` 私有、`scheduler.ts` 另写一份鸭子判定）；`withRunContext` 改重载（同步 fn → `T`，async → `Promise<T>`，去掉 `as Promise<T>`）；删除 `DecoratedMethod.fn`（无消费者）、`loop.ts` 恒真的 `stopReason === 'end_turn'`、`trimming.ts` 两个不可达分支、`module.ts` 的 `_tools ?? []`、`async.ts` 的 `this.app = app`；`runAgent`/`runAgentScoped` 的缺省 `64_000`/`40` 提为模块常量；`loop.ts` 补记 `cache_creation_tokens` 属性。
  **文档一致性**：roadmap R7 删去已落地的「InMemoryTaskStore 无界增长」；spec §10 Turn 4 的「缺省字符/4」更正为 CJK 感知启发式；`runtime/memory.ts`、`container/container.ts`、`engine/types.ts` 中指向重构前 `run/*.ts` 的注释改为 `runtime/*.ts`；`usage-guide.md` 的 `g tool fetch_weather`（下划线非法）示例改 kebab-case；`engine/types.ts` 误挂在 `RunAgentOptions` 上的 `ModelClient` JSDoc 归位；`toolkit/asset.ts` 的「每次调用现读」注释澄清（当装饰器 spec 值是加载期读一次）。
  **CLI / 官网**：`doctor` 入口检查改用与框架 `ENTRY_CANDIDATES` 一致的候选集（原只认 `index.ts`，合法 `.js/.mts` 能力被误报）；`add` 的本地路径补 `file:` 协议支持（原注释承诺、代码不认）；`cli.ts` 未知命令复用 `fail()`、用法串改用 `CAPABILITY_TYPES.join`；`dev` 的 `NODE_OPTIONS --import` 路径加引号（含空格安装路径不再静默失效）；`inspector` 的 `text()` 补 `content-length`、body 超限由 500 改 413；脚手架 README 占位链接填真实仓库地址；`trace-view/fromTrace.js` 复用 `view.js` 的 `capabilityTypeOf`/`CAP_ICO`；官网 `/llms.txt` 的「已知边界」改为从单源 guide §7 表当场抠出（不再手抄，消除与单源的漂移）；`discover` 对「路径是普通文件」给出明确错误而非原始 ENOTDIR。
  测试 215 → 225 例（框架：loop 四条终止分支、trimming 两条分支、memory `__proto__` 往返、redis `ttlSeconds: NaN`、scheduler `at(Invalid Date)`、discover 非目录）+ CLI 3 → 6 例（`resolvePackageName` 的 `file:` / 版本后缀、doctor 入口候选）。

- 2026-09-11：**Phase A 落地（成本与稳定性）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md`（四期，8 个分叉全按建议 A 拍板），任务计划见同目录 `phase-a-cost-and-stability.md`。
  **① 取消传播（行为变更，在此锁定）**：`AbortSignal` 从入口贯穿到 `ModelClient.messages.stream`（`stream` 的 params 加可选 `signal`）。新增 `AgentStopReason: 'aborted'`；中断**不冒泡异常**，run 以 `aborted` 收尾（`status=failed`）。`core/abort.ts` 新增 `combineSignals`（Node 18 无 `AbortSignal.any`）。`ToolRunContext.signal` 让工具自行决定是否尊重（框架不强制中断工具 —— 副作用无法回滚）；`@SubAgent`/`@Skill` 从 `ctx.signal` 透传，取消可传播。**`AsyncRunner.runTimeoutMs` 语义升级：从「放弃等待」变「到点 abort」**（对转发 `signal` 的客户端是真中止，token 不再继续烧；不转发者仍是放弃等待）。`createHttpHandler` 的 `POST /run` 在客户端断开（`res` close 且未写完）时中止在飞 run。
  **② 重试与退避（缺省开启，在此锁定）**：消费 `classifyError().retryable`（此前只产出、无人消费）。`engine/retry.ts`：`RetryOptions` + `DEFAULT_RETRY`（maxAttempts=3、baseDelayMs=500、maxDelayMs=8000、jitter=0.2）+ `resolveRetry`/`backoffDelay`/`sleep`（可中断）。**只重试「本次尝试未产出任何文本」的失败**——已流出的文本无法撤回。每次尝试开**独立 `llm.turn` span**（失败的带 `retry.attempt` 属性 + `llm.retry` 事件），`iterations` 仍只计成功的往返。贯通 `RunAgentOptions` / `RunInvocationOptions` / `AppOptions`（应用级缺省）。⚠️ 与 SDK 内置重试叠加，文档建议二选一调。
  **③ SSE 流式下发**：`POST /run` 内容协商 —— `Accept: text/event-stream` → `text.delta` / `run.end` / `error` 三类事件（`transport/sse.ts` 零依赖写出器，含 15s 心跳注释帧、`x-accel-buffering: no`）。**流开之后的错误只能以 `error` 事件表达**（HTTP 状态已定），流开之前仍用普通状态码。不带 `Accept` 的请求**逐字保持旧行为**。
  新增导出：`combineSignals`、`isAbortError`、`DEFAULT_RETRY`、`RetryOptions`。测试 225 → 254 例。

- 2026-09-11：**Phase B 落地（宿主硬化）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md` §4。
  **① 鉴权缝（只给缝，不给策略）**：`HttpHandlerOptions.authenticate?: (req) => unknown | Promise<unknown>`。
  调用时机锁定为「**读 body 之前**、**除 `/healthz` 与 `/metrics` 外的所有路径**」（含 `GET /tasks/:id` 与未知路径 ——
  不暴露路径是否存在；`/metrics` 是 G4 后来加入的同档豁免，此处按现状表述）。返回任意值即通过（框架**不转交**返回值：per-request 上下文请在钩子自己的闭包里存，
  不为「暂时没有消费点」的东西发明传递通道）；抛 `HttpException` 按其 `status`/`body` 回（想回 403 就抛 403）；
  抛其它错误回 401 `{ error: '未通过鉴权' }`，**原文只进服务端日志**（与 `exposeErrors` 同策略，防内部拓扑外泄）。
  **框架不实现 token/JWT/签名策略、不碰凭据 env** —— 那是宿主或反代的事；不做成 middleware 的理由：
  middleware 拦的是**能力调用**（run 内部），鉴权要拦的是 **run 入口**。
  **连接语义（此处锁定）**：鉴权失败时请求 body 未被消费，故 `req.complete` 为假时显式 `connection: close`
  —— 连接不可复用（残留字节会被当成下一个请求，与 413 同理），这也是「不收 body 省资源」的落点。
  **② 优雅停机 + 健康检查**：`AsyncRunner` 新增 `drain({ timeoutMs })` / `inFlight` / `isDraining`；
  `createHttpHandler` 的返回类型由裸函数升为 `HttpHandler`（仍可直接传给 `http.createServer`）——
  额外挂 `drain(opts?)` 与 `runner`，不破坏 `(req,res)` 调用形状。`drain()` 语义：拒新单 →
  等异步任务与在飞同步 run 收尾 → **超时后强制收口仍开着的 SSE 流**（其 run 因 `res` close 中止）；
  返回是否排空干净，超时返回 `false` 且**未完成的任务留在 store 里**（下次启动 `resumePending` 续跑，不是丢弃）。
  停机后 `POST /run`、`POST /tasks` → 503 + `Retry-After: 1`，而 `GET /tasks/<id>` **仍可轮询**
  （否则调用方拿不到在飞任务的结果）。**框架不订阅 `SIGTERM`/`SIGINT`**（不读 env、不做进程级决策）——
  `process.on('SIGTERM', () => handler.drain())` 是宿主的。
  `GET /healthz` → `HealthResponse { ok, inFlight, uptimeMs, draining }`：**不鉴权**（探针带不了凭据）、
  停机中也回 200；`ok` 恒 `true`（能回响应即进程活着），就绪与否看 `draining`。
  **`inFlight` 口径（此处锁定）**：正在处理的同步 run（并发闸门计数，含 SSE 流）**+** 已受理未完成的
  异步任务（queued + running）—— 与 `drain()` 的等待范围一致，使健康检查与停机判断看同一个数。
  **`AsyncRunner.submit` 语义变更（在此锁定）**：`drain()` 之后 `submit` 抛错（此前任何时刻都可提交）。
  新增导出：`HttpException`（值）、`HttpHandler` / `HealthResponse`（类型）。测试 254 → 275 例（+21）。
  真实 HTTP 实测（非仅单测）：`/healthz` 反映在飞数、鉴权先于读 body、SIGTERM → `drain()` 等慢 run 收尾返回 `true`。

- 2026-09-11：**Phase C 落地（能力成色）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md` §5。
  **① 成本硬管控（补 §6.4 欠账）**：新增 `AgentStopReason: 'budget_exceeded'`（**算失败**，`isSuccessStopReason` 不纳入）。
  `RunAgentOptions` / `AppOptions` 加 `maxTotalTokens` / `maxCostUsd`（先到先算，tokens 优先），贯通 `RunInvocationOptions` →
  `app.run` → `executeRun`。新增 `engine/budget.ts`：`createBudgetGuard({ maxTotalTokens, maxCostUsd, onExceed })`
  → `{ check(trace) }`。触发点是**每回合记账后**（`recorder.end(turnId, {usage})` 之后），口径 = 整个 trace 的
  `totalUsage`（**含子 agent**；input+output+cacheRead+cacheCreation）。
  **两处语义取舍（在此锁定）**：(a) **自然收尾的回合超限不改判失败** —— 只记 `budget.exceeded` 事件；
  只有「循环还要继续（模型要求调工具）」时才以 `budget_exceeded` 停下。理由：那次 run 的任务已经做完了，
  不该因为「最后一回合用超了」被追认成失败（设计里 `budget_exceeded` 的注解正是「run 没跑完」）。
  (b) 超限时**连带不执行本回合的工具**（避免继续产生副作用）。
  **与 `createBudgetPolicy` 的分工（文档并列讲清）**：前者是**发送前**改 messages（防 400 / 过早压缩），
  后者是**记账后**改 run 结局（控制花钱）—— 互补，不是一回事。**不做**：把硬管控塞进 `contextPolicy.beforeTurn`。
  ⚠️ 已知边界：**不是硬实时**（一回合跑完才判，可超一个回合的量）；`maxCostUsd` 依赖模型在价格表内，
  不在表里时成本恒 0、护栏不触发。
  **② 工具级超时 + 并发闸门**：`RunAgentOptions` / `AppOptions` 加 `toolTimeoutMs` / `maxToolConcurrency`。
  新增 `engine/concurrency.ts`：`mapWithConcurrency`（**结果保序**的有界并发 map，`limit` 非正/非有限 = 不限）
  与 `withTimeout`（超时返回 `TIMED_OUT` 哨兵，区分「超时」与「工具返回 undefined」）。主循环的
  `Promise.all(toolUses.map(...))` 换成有界 map。**语义锁定**：工具超时**不杀 run**（该条 tool_result 记
  `is_error`，模型可换路 —— 与「工具抛错不中断 run」同族）；超时 = **放弃等待**，`AgentTool.run` 没有 signal
  参数（想真停的工具自行读 `ToolRunContext.signal`）。缺省 `maxToolConcurrency = Infinity`（= 旧行为）。
  **③ OpenAI 适配器：真流式 + 多模态**：默认 `stream: true` + `stream_options.include_usage`，解析 `data:` 行；
  `delta.content` 逐 token 触发 `on('text')`；`tool_calls` 按 **`index` 归并**累积后再汇成 `tool_use`
  （`id`/`name` 取**首次出现**，`arguments` **拼接** —— 分片与并行交错都是易错点，各带单测）；
  `usage` 取自最后一个 chunk；`[DONE]` 为结束哨兵；畸形分片跳过不毁流；缺 id 补 `call_N`。
  **内容协商（此处锁定）**：**按响应实际形态解析**（`content-type` 含 `event-stream` 才走流式）——
  部分兼容端点会忽略 `stream:true` 直接回 JSON，此时退回一次性（与旧行为一致）。仍保留的近似：
  cache token 恒 0、`content_filter→refusal` 近似。多模态：`renderBlocks` → 文本块 `{type:'text'}`、
  图片块 `{type:'image_url'}`（base64 编 data URL、url 源透传）；**无图时回落纯字符串**（兼容只吃 string 的端点）。
  **顺带修**：适配器此前**未转发 `signal`**（与 guide/spec 一直声称的「内置适配器都转发 signal」不符）—— 现已转发。
  新增 `OpenAIClientOptions.stream`（设 false 退回一次性）。
  **④ 会话持久化**：新增 `runtime/session.ts`：`SessionStore`（`load` / `append`，**append-only**）+
  `InMemorySessionStore`；`ExecuteRunOptions` / `RunAppOptions` 加 `session?: { store, id }`
  （**不放进 `RunInvocationOptions`** —— store 实例不可序列化，transport 不替调用方传）。
  语义：run 前 `load(id)` 拼在传入 messages **之前**；收尾 `append` 本轮消息 + 回复。**三条不变量（在此锁定）**：
  (a) **只有跑成功的轮次才回写**（判据是 run 终态而非「没抛异常」—— error/max_tokens/budget_exceeded/aborted
  同样「没跑完」）；(b) 历史**以 assistant 结尾**（无文本输出时补占位）—— 否则下一轮出现连续两条 user 撞 API 校验；
  (c) 只存**对话轮次**，run 内部 tool 往返不进历史（要完整过程用 `traceToMessages`）。
  **与 `MemoryStore` 正交**（键值黑板 vs 对话历史），可同时用。读/写失败均吞掉（同既有原则）。
  **⑤ 任务完成回调**：`transport/async.ts` 新增 `TaskSink { onFinished(rec) }` + `AsyncRunnerOptions.taskSinks`；
  在 `#execute` 的 finally 里**逐个 await**、**抛错被吞**，且**先通知 sink 再递减在飞计数**（`drain()` 返回时
  保证回调已发完）。传快照副本。webhook 后置（sink + 自家 fetch 即可，不引「出站请求 + 签名 + 重试」）。
  新增导出：`createBudgetGuard` / `mapWithConcurrency` / `InMemorySessionStore`（值）、
  `BudgetGuard` / `BudgetGuardOptions` / `BudgetSnapshot` / `SessionStore` / `TaskSink`（类型）。
  测试 275 → 322 例（+47）。真实端到端实测：本地假 OpenAI 兼容端点（真 SSE 分片）→ 适配器（真流式）
  → HTTP 宿主（A3 SSE）→ 客户端**逐帧到达**（+40/157/279/399ms）；带工具的一轮 `maxTotalTokens=100`
  → `stopReason='budget_exceeded'` 且**工具未被执行**。

- 2026-09-11：**Phase D 落地（生态）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md` §6。
  **① MCP 桥（duck-typed，框架零依赖）**：新增 `integrations/mcp.ts`（只依赖 core）：结构面
  `McpClientLike { listTools(); callTool(name, args) }` + `mcpTools(client, { prefix, server, timeoutMs }) → AgentTool[]`；
  **不 import MCP SDK、不含任何传输实现**（stdio / StreamableHTTP 归独立可选包，本仓库 `scripts/e2e-mcp.ts`
  留了一份最小连接器供参考）。
  > ⚠️ **后话（2026-09-18 ⑨）：本条后半句已作废** —— 连接器改为**内置**（那个「独立可选包」
  > 从未发布）。上文保留为当时的决策记录；理由见 §10 2026-09-18 ⑨。
  **接入点偏离设计（此处锁定）**：设计写的是「`createApp({ providers })` 里放个 `useFactory` 即可」——
  **落地时不成立**：菜单只从装饰器注册表收集（`useFactory` 的返回值根本不进菜单），且 `Container.resolve`
  是同步的（`await mcpTools(...)` 塞不进去）。零新机制的做法是给 `AppOptions` 加 **`tools?: AgentTool[]`**：
  裸工具直进主菜单，且与装饰器能力**完全同等** —— 同过中间件链、同进重名查重（**不是旁路**，两条用例分别钉住）。
  **语义**：名字 = `prefix + 归一化原名`（非 `[A-Za-z0-9_]` → `_`，连续分隔符收成一个；缺省 `mcp_<server>_`，
  没给 `server` 时 `mcp_`）；归一化后**空名 / 撞名 / 超 64 字符一律装配期抛错**（不静默改名 —— 那会得到一个
  调不回去的名字）；**原名**每次调用写进发起 turn 的 `mcp.tool.<菜单名>` attribute（每次一条，并行调用互不覆盖；另留 `mcp.tool` 记最近一次，兼容既有查询）—— 审计 / 回放要还原它才能回调 server；
  `inputSchema` 原样透传（engine 的子集校验器在 `callTool` 之前先校验）；`callTool` 抛错 → 该条 `is_error`
  且**不杀 run**；**协议层 `isError: true` 框架看不见 —— 必须由连接器转成抛错**（否则模型以为成功）。
  桥自带 `timeoutMs`（缺省 60000）= **放弃等待**（拿不到 server 侧取消句柄），但它是**兜底**、不是第二裁判：
  **引擎设了 `toolTimeoutMs` 时本项不参与判定**（一次调用只有一个裁判 —— 此前的「双重计时、谁短谁生效」
  会让同一件事在 trace 里落成两种账，2026-09-17 收口，见本文件 §10 同日 ①）。
  **不做**：`sampling`（server 反向请求模型）/ `resources` / `prompts` 原语、连接池。
  **② evals**：新增 `src/eval/`（**叶子消费模块**，只依赖公共面、无反向依赖）：`scriptedClient(steps)`
  与 `defineEval<T>({ name, app, cases, expect })`。**语义锁定**：步骤在 `finalMessage()` **成功返回后才前进**
  （用函数步骤 `throw` 模拟 429 时，重试会**重放同一步** —— 想验重试就这么写）；`scriptedClient`
  **真的把文本块经 `on('text')` 吐出去**（onText / SSE 链路在 eval 里按真实路径走；`tests/helpers` 的 mockClient
  是忽略 `on` 的，两者定位不同）；`run()` **不抛**（用例失败进报告，一次跑完能看到所有回归），只有
  「应用建不起来」才冒泡（那是环境错误不是回归）；`app()` 一轮只调一次（用例间复用装配，避免掩盖装配期状态泄漏）；
  失败 case 带 `trace`，报告含 `stopReason`。**补 `EvalCase.opts`**（透传 `app.run`）—— 没有它就**断言不了
  `result.typed`**：`resultSchema` 是 per-run 的，而 `app` 是不带它的。
  **③ 指标**：新增 `integrations/metrics.ts` 的 `metricsSink(opts)` —— **天然满足 `TraceSink`**，
  `createApp({ sinks: [metricsSink()] })` 即接入，**零新出口**（与 `createOtlpExporter` 同款）；另给
  `snapshot()` / `render()`（Prometheus 文本，手写零依赖）/ `reset()`。**口径锁定**：`tokens` = 四类之和
  （与 `BudgetGuard` 一致），分项在 `render()` 里以 label 给出（信息不丢）；分位是**窗口内精确值**
  （最近 rank 法 + 环形窗口，`windowSize` 缺省 1024）—— **不是** Prometheus 原生 histogram / summary，
  代价是只反映最近 N 条 run，收益是长跑宿主不被无界数组拖住；**根 span 未收尾**（失败路径的半截 trace）
  的 run 不进延迟样本。`export: 'otlp'` **构造期抛错**（OTLP metrics 后置，响亮失败好过给一份空指标）。
  **④ 提示词版本化**：`SystemPromptOptions.version` + 只读 `SystemPrompt.version`；`RunAgentOptions.systemVersion`
  落 **run 根 attribute `system.version`**；`AgentApp.run` 从**当次**的 `SystemPrompt` 实例自动带上
  （单次 `{ system }` 覆盖时版本跟当次走）。**不放进 `RunInvocationOptions`** —— 版本是提示词的属性，
  不该由 transport 负载指定。`system` 传已拼好的 `SystemParam` 时**不写该 attribute**（不写空串冒充实有版本）。
  **不做**：版本库 / 回滚 / A-B 实验平台。
  **⑤ 多租户配额（不做子系统，给组合范式）**：`middleware`（拦在能力调用前；超限抛错 → 该条 `is_error`、
  **被拦下的能力不执行**、run 不崩）+ `TraceSink`（收尾后按租户记账 —— sink 在 run 的 async 上下文里投递，
  **读得到黑板**）+ `BudgetGuard`（单次 run 上限）三者组合；存储（内存 / Redis / DB）与超限策略是使用者的。
  两条独立：**被拦下的 run 仍然要记账**（模型的钱已经花了）。`usage-guide §6` 里那 20 行示例被单测
  **真跑一遍**（文档的写法必须真能工作，是仓库既有约定）。
  **验证**：新增 `npm run e2e:mcp` —— 真接**第三方 server**（`uvx mcp-server-time` v1.30.0，真 stdio JSON-RPC：
  `initialize` → `notifications/initialized` → `tools/list` → `tools/call`）→ 连接器 → `mcpTools` → `createApp`
  菜单 → 真跑一轮：模型经 MCP 工具拿到**真实时区时间**并写进最终答案；`system.version` / `mcp.tool` 落 trace；
  metrics 从这次 run 派生正确；`agentia doctor` 认到 MCP 能力。无网 / 无 uv 的机器自动回落
  `scripts/mcp-fixture-server.py`（同一协议面；夹具的工具名带 `-`，顺带把归一化那条路径也验了）。
  测试 322 → 363 例（+41：MCP 13 / 指标 9 / evals 10 / 配额 4 / 提示词版本 5），另在 `tests/types/dx.types.ts`
  并入 8 处类型断言（`@ts-expect-error` 钉住「应当报错」的场景：缺 `callTool` 的结构面、`tools` 的元素形状、
  `version` 只读、`systemVersion` 类型、`export` 只认两个字面量等）。
  **顺带修官网 API 页（既有漂移，非本次引入）**：`packages/website/src/fragments/api.html` 是**手写**的导出速查
  （不像 `llms.txt` 从 `usage-guide.md` 派生），此前已漂：`SpanKind` 写成含不存在的 `'internal'`、
  `trimToolPairs` 还挂着改名前的 `keepRecent`、A/B/C 三期的导出（`createBudgetGuard` / `mapWithConcurrency` /
  `combineSignals` / `InMemorySessionStore` / `TaskSink` / `HttpException` / `HealthResponse` / `TraceSink` …）
  大量缺失 —— 而 D 期四个新的全没进。本次逐项补齐到**对导出面零缺口**，并新增守卫测试
  `tests/docs/api-page.test.ts`：① 正向（「X 选项」表首列必须是 `X` 的成员含继承链，其余表必须是 `src/index.ts`
  的导出名）；② **反向全覆盖**（导出面的每个导出都必须在页面上出现 —— 防「代码有了、文档没写」）。
  `index.html` 的 hero 数字（「140+ 例单测」）与 `docs.html`（新增「稳定性与流式 / 宿主硬化 / 成本硬管控 /
  生态与观测」四节）同步更新。测试 363 → 367。

- 2026-09-13：**可观测口径对齐 + 生产配方文档 + 部署示例**。修一处 spec 自相矛盾：§9.3 原写
  「生产：OTLP 导出 + span 与 run 记录同库存储」，读起来像框架内建「同库存储」，与本文件「trace 出口缝」
  条目锁定的**只保证出口**口径冲突（frame 只有 `TraceSink`，没有任何存储实现）。已改 §9.3 为
  「同库存储 = sink 配方之一，非内建」。
  **新增 `docs/observability.md`**：把出口边界讲清 + 四条**现成 sink 配方**（按 runId 落库检索 /
  日志关联 / 采样 / 脱敏），全部零 engine 改动、零新增依赖、零新出口 —— 正好兑现 §9.3 那句「同库存储」。
  **新增 `examples/complete/`**：完整示例（四类能力 + 显式注册表 + 三种触发 + 鉴权缝 + 全观测栈 + 优雅停机），
  并把观测栈接成真实链路（metrics 全量 → 采样 → 脱敏 → [落库, 日志]）。**`examples/observability/` 升为本地小包**
  `@migor/agentia-observability`：示例要用这四个 sink，而 `tsc` 的 `rootDir` 不允许跨目录引源码 —— 做成小包
  与仓库对 `packages/trace-view` 是同一套办法（零重复、无 rootDir 取巧）。
  **usage-guide 补「HTTP 端点速查」表**（`POST /tasks` 的 body 形状此前没写；表格格式经确认不会踩到
  `usage-guide.test.ts` 的表格校验 —— 该测试只收「首列是单个反引号标识符」的行）。
  **Docker 修正**：实测 registry 上最新只有 0.2.1，且**缺** `metricsSink` / `mcpTools` / `defineEval` /
  `createBudgetGuard` / `registerDefaultTraceSink` —— 两个示例的 Dockerfile 因此**无法**用 `npm install` 构建
  （上一版是我留下的缺陷）。改为 `dependency: file:../..` + **以仓库根为构建上下文**（镜像里先从源码构建框架），
  发布后改回 `^0.2.2` 即可退回常规单包写法。`.dockerignore` 放**仓库根**（Docker 只认上下文根上那一份）。
  **不改框架实现**（`src/` 零改动）；sink 配方的写法由 `tests/docs/observability.test.ts` 真跑一遍钉住
  （仓库既有约定：文档里的写法必须真能工作）。
  **自查补漏**：`sqliteTraceSink.getSpans()` 此前声明 `Span[]` 却只塞了 `attributes`/`events`
  （`as Span` 硬断言）—— 既骗类型、又丢掉表里全部反规范化列（name/kind/耗时/tokens/errorType）；
  改为返回 `SpanRow[]`（真实列），用例同步加强。官网 hero 单测数 `360+` → `380+`（实际 387），
  `docs.html` 的端点注释补 `/healthz`（两者都是手写、无自动校验，按 AGENTS.md 须人工同步）。
  **跑真机时发现一处没文档的缝**：HTTP 宿主**不持有 model client**（同步 `/run` 走
  `app.run(messages, opts)`，`/tasks` 才经 `AsyncRunner` 的 `client`）—— 想接 OpenAI 兼容端点
  只能靠 `ANTHROPIC_BASE_URL` 或自己包一层 `AppCallable`，而**两者都没写进文档**。已在 usage-guide
  §宿主 补「换 model client 的缝」小节（含 `AppCallable` 包一层的写法），并让 `examples/complete`
  支持 `OPENAI_BASE_URL`（本机用 DeepSeek 真跑验证：OpenAI 协议与 Anthropic 兼容协议两条路都跑通）。
  **不改框架实现**（`src/` 仍零改动 —— 这是组合缝，不是缺功能）。

- 2026-09-13：**架构自审 → 消除未声明的分层依赖 + 补分层守卫**。用脚本解析 `src/` 全量 import 图，与 AGENTS.md 的
  「分层单向」硬约定对照，发现两处不符：① `store → runtime`（`TaskRecord` 的 `spec`/`status` 需要，属未声明的**兄弟层**依赖）；
  ② 约定里写的 `transport ← toolkit` 实际不存在（toolkit 不引 transport，transport 只被 `index.ts` 转发）。
  修法为**「纯数据下沉 core、共用入参契约下沉 engine」**：`core/run.ts`（`RunStatus`/`RunMeta`）、`core/blackboard.ts`
  （`Blackboard` 类型族）、`engine/spec.ts`（`RunSpec`/`RunInput`/`RunInvocationOptions`/`normalizeMessages`），
  删除 `runtime/types.ts` 与 `runtime/spec.ts`。改完 store 与 transport 都不再引用 runtime，依赖图无环。
  **导出名零增删**（仅换来源文件），故官网导出表、`api-page.test.ts` 的反向覆盖与导出计数均不受影响。
  新增 `tests/architecture/layering.test.ts` 把该约定变成可执行断言（允许边集合 + 无环 + src 不引 src 之外；已验证注入违规会精确失败）。
  **注**：`RunSpec` 不能直接下沉 core —— 它依赖 `engine/types`（`ContextPolicy`）与 `engine/retry`（`RetryOptions`），
  硬塞进 core 会变成 core 反向依赖 engine（比原问题更糟），故落 engine；`AGENTS.md` 的链条描述同步改为实测形状。

- 2026-09-13：**性能深度审计 → 三处修复（语义变更在此锁定）**。方法上先纠正自己：读代码猜热点两次都猜错
  （先猜 `recorder.snapshot()` 的 O(n²)、再猜 `contentToText` 里的 `JSON.stringify`），改在**构建产物**上跑 CPU profile
  （tsx 下采样会被转译噪声淹没，采不到真因）才看见事实。
  ① **预算策略的 token 估算超线性**：`beforeTurn` 每回合重估整段历史 → O(回合 × 上下文)；profile 显示占框架 CPU 约 88%，
  160 回合 run 的估算净开销 399ms（10→160 回合增长 ×103）。新增 `engine/trimming.ts` 的 `createTokenCounter`
  （缓存已计前缀、只估新增消息；三重失效判据：换数组 / 长度变短 / **边界元素对象标识变化** —— 第三条覆盖
  「同数组同长度但原地覆写」，只有长度判据会漏），`createBudgetPolicy` 改用它；并把估算器自身的逐码点 `codePointAt`
  循环换成正则扫描（BMP 用 `replace` 数长度差、增补平面用 `.test()` 守卫后再 `matchAll`；**口径逐字不变**，
  6 个样例含非 BMP 汉字与 emoji 结果一致）。合计：同负载吞吐 3411 → 26946 runs/8s（7.9×），估算占比 88% → 45.3%
  且不再有单一热点。**停止点**：剩余最大单项 `stringifySafe`（约 30%）不再优化 —— 框架 CPU 本就亚毫秒级/run，
  相对模型往返是秒级，继续投入对用户零影响。
  ② **SSE 无背压控制**：`res.write()` 的返回值被忽略，下游「连得上但不读」时无界缓冲（代码级定证：下游连续 20000 次
  回报未消费，写入器仍写满 1.28MB）。`sseWriter` 改盯 `res.writableLength`，超过 `SseWriterOptions.maxBufferedBytes`
  （缺省 8 MiB）即收口并回调 `onBackpressure`；`HttpHandlerOptions.sseMaxBufferedBytes` 透出，`createHttpHandler`
  据此 `abort` 对应 run（不再为已不消费的客户端白花 token）。做的是**有界缓冲 + 超限收口**而非静默丢帧 ——
  丢帧会让客户端拿到看起来正常、实则残缺的输出；也不做「等 drain 阻塞」，因为 `onText` 是同步回调 `(delta: string) => void`，
  真阻塞要改公开签名。**保留**：断连处理（`res.once('close')` → abort）、15s 心跳、`drain()` 强制收口 SSE。
  ③ `agentLoop` 的 `messages.splice(0, n, ...next)` 受 V8 实参个数上限约束（实测 12 万项 ok、30 万项抛 `RangeError`），
  抽 `engine/loop.ts` 的 `replaceMessages()` 用循环逐项写，彻底无上限。
  另：`AsyncRunner.awaitTask` 由「每 5ms 轮询 store（等 30s ≈ 6000 次读）」改为**终态事件唤醒**（`#taskWaiters` 在
  `#execute` 的统一出口唤醒）；`intervalMs` 降级为缺省 250ms 的**兜底轮询**，只服务「终态由他进程写入的异步 store」。
  四条均带守卫测试并逐个做**变异自证**（回退修复即失败）。**`AGENTIA_VERSION` 保持 0.2.1 不变** ——
  该常量反映**已发布**版本，0.2.2 发布时再同步（官网 API 页的描述也已写明这条规则）。
  ⇒ **已于 2026-09-14 发布 v0.2.2 时同步为 `'0.2.2'`**（`check-release.mjs` 四处一致通过）。

- 2026-09-13：**官网正式化 + 动效补齐**。官网是对外产品页，清理四类「开发过程」内容：开发指标（hero 的「380+ 例单测」
  → 产品属性）、版本对比语言（「旧行为逐字不变」）、内部结构描述（「分层单向」「只依赖 core」「`src/index.ts` 是唯一出口」
  「叶子消费模块（零反向依赖）」）、实现状态与设计决策注记（「尚未实现」「不做子系统」「不加新机制」「只给缝、不给策略」）。
  **保留真实 API 语义**（如「超时是放弃等待而非取消，`AgentTool.run` 收不到 signal」），只做措辞正式化；
  并删掉 `playground.html` 里一段会随产物下发到浏览器的开发注释。动效新增：顶部滚动进度条（`Base.astro` 元素 + `nav-collapse.js` 零依赖驱动）、
  hero 终端光标、统计行错开弹入、复制按钮反馈、卡片辉光与侧栏指示条过渡 —— 全部由既有的
  `@media (prefers-reduced-motion: reduce)` 全局规则统一关闭。**CSS 动效块刻意放在 `global.css` 的「API 参考页」标记之前**
  （该标记之后整段被 `tests/docs/website-css.test.ts` 当作 API 页 CSS 校验）。
  **顺带修一个真 bug**：hero 统计行**线上一直不可见** —— `site.js` 的入场 timeline 先把所有 `[data-intro]` 置 `opacity:0`，
  再逐个点亮 5 个选择器，而 `.hero-stats` 也带 `data-intro` 却没被点亮，于是永久停在 `opacity:0 / y:26`
  （真浏览器实测确认；此前访客看不到那行统计数字）。

- 2026-09-11：**文档漂移审计 + 三处能力边界结论（HITL / 护栏 / 沙箱）**。
  **① 漂移修正** —— roadmap 的 ✅ 段声明了源码里根本不存在的东西，全部改为与源码一致：
  `ModelProvider` 抽象与「`AGENTIA_MODEL` 扩展为 `provider:model`」→ 实际是 `ModelClient`（core 结构面，
  Anthropic SDK 天然满足）且**从无 provider 路由**，换 provider 靠注入 client；`@AgentModule` 装饰器 →
  实际是 `defineModule({ providers, middleware })` 返回值（普通函数，无类装饰器、无 `main` 标记）；
  `app.use((call, next) => …)` → 实际是 `createApp({ middleware: [...] })`。改动落在 roadmap R1/R4/R5、
  spec §4/§10、官网 `docs.html`、`packages/cli/README.md`，并加全仓残留扫描。
  **② 能力边界结论**（三者同为「给缝不给子系统」）：**HITL** —— 闸门层**无需新机制**：`middleware` 返回值
  被引擎 `await`（`Promise.resolve(tool.run(...))`），故审批中间件可 `await` 决策再 `next()`；拒绝 = 不调
  `next()`（短路，副作用不发生），拒绝并让模型改道 = 抛错（记 `is_error`，不杀 run）；`toolTimeoutMs` 缺省 0
  不掐断等待。**真缺口是「跨进程挂起/续跑」**：`RunStatus` 无「待批准」态、循环位置（消息数组）不落库，
  且 `traceToMessages` 重放**有损**（assistant 原文未记录）—— 无法以重放假冒续跑，故**不做**，列为 R7 候选评估。
  > ⚠️ **后话（2026-09-19 ①）**：跨进程挂起/续跑**已落地** —— 关键解锁是「审批 = 异步 tool_result」
  > （不落「循环位置」、落**消息历史**：assistant 结尾的未决 tool_use 就是断点本身），见下。
  **护栏** —— **不做子系统**（同「配额不是框架子系统」）：入参缝（包 `app.run` / `authenticate`）、工具前缝
  （`middleware`）、出参缝（包返回值 / `sinks`）已足，策略差异过大硬编码必错。**沙箱** —— **框架不执行模型
  生成的代码**（`@Skill`/`@Tool` 均用户代码，模型输出只成文本 / `tool_result`），无沙箱可言；代码执行隔离属
  **工具实现内部**（Docker / 子进程 / 微 VM），框架不参与。配方写入 `usage-guide` §6，边界写入 §7 已知边界表。

- 2026-09-13：**可观测 · 可调优（E/F/G 三期落地，8 个设计分叉按建议 A 拍板）**。缘起是框架定位 —— 「要长期使用、
  要能被观测、要能被调优」，而当时观测只到 **run 级**（`metricsSink` 的 label 只有 `{kind}` 与 `{quantile}`，答不出
  「哪个能力慢/贵/爱失败」），调优旋钮虽齐却有**两处「看着有、实际不生效」**。设计文档见
  `docs/plans/2026-09-13-observability-tunability.md`。
  **E 期（观测下沉）** —— E1 在既有 `tool.output` 事件上补 `durationMs` + `errorKind`（普通工具**不建 span**，守住
  `26707ef` 控 trace 体积的决策）；E2/E3 把指标下沉到**能力级**（`tool` 读事件、`skill`/`subagent` 读 `capability` span，
  含 token 与成本）与**模型级**（`llm.turn` 的 span name 即模型 id，另出 `model_unpriced_turns_total`）；
  E4 补 Prometheus 原生 **histogram**（可跨实例聚合），窗口精确分位作为 gauge 并存；E5 让 `export:'otlp'`
  从「构造期抛错」变成**零依赖手写 OTLP/JSON**（与 `createOtlpExporter` 同款做法）。
  **F 期（成本可调优）** —— F1 内置价格表开放为 `priceOverrides`（覆盖/追加，非法单价构造期抛错），
  **且透传进子 agent/skill 的子循环**（`ToolRunContext.priceOverrides`），不再出现「主 agent 有成本、子 agent 恒 0」；
  F2 未定价模型**不再静默**：turn 上记 `usage.unpriced` 事件 + `onUnpricedModel` 回调（每作用域每模型一次、抛错被吞）
  + 指标计数 —— 定价缺失是宿主配置问题，**不改变 run 结局**（否决「让 run 失败」）；F3 成本归因到模型与能力。
  **G 期（调优闭环）** —— G1 `buildRunReport` / `mergeRunReports` / `renderRunReport` 纯函数报告 +
  CLI `agentia report <trace.jsonl>` 薄壳；G2 能力排行视图落在 `@migor/trace-view`（`summarizeTrace` /
  `renderSummary`），`agentia dev` 面板直接消费；G3 每个 run 的根 span 写 `config.*` **生效配置快照**
  （缺省值也记，函数型选项只记「配没配」）；G4 `createHttpHandler({ metrics })` 内建 `GET /metrics`
  （**不鉴权**，与 `/healthz` 同档）。
  **落地时对设计的四处修正**（都朝"更诚实/更少重复"）：① E1 未新增 `status` 字段 —— 既有 `ok` 已是状态，
  改成补 `errorKind`（`invalid_input` / `timeout` / `threw` / `unknown_tool`），信息量更大且无冗余；
  ② F2 的 `usage.unpriced` 事件落在**该 turn span** 而非 run 根（turn 才能准确指出"哪次往返未定价"）；
  ③ G2 的排行**无法**复用 `buildRunReport`（trace-view 零依赖、要能在浏览器里跑；CLI 又零运行时依赖），
  故落成两条口径：`trace-view.summarizeTrace`（展示层，CLI 报告与 dev 面板同源）与
  `buildRunReport`（库层，含未定价/成本语义与跨 run 合并），分工写进 usage-guide；
  ④ **指标 `_count` 语义变更**：`run_duration_ms_count` 从「窗口内样本数」改为**累积观测数**（Prometheus
  直方图语义，可聚合），窗口只再约束分位 gauge —— 旧断言按新语义同步。
  另**顺带修一处 doc-vs-code 漂移**：`core/trace.ts` 从第一天就声明「`capability.usage` = 其子孙 `llm.turn` 的聚合，
  仅供展示、不计入 `totalUsage`」，但实现里**从未写入过**该字段；本轮在 `TraceRecorder.end()` 补上就地聚合
  （只累加 `llm.turn`，层层嵌套不双算），E2/F3 的能力 token 与成本才有数据来源。测试 414 → 462（+48），
  CLI 6 → 13，trace-view 6 → 10。

- 2026-09-13：**目录约定去伞形词（四类分置）+ 伞形术语整体替换为 `capability`**。缘起是 `agentia create` 产出的
  `units/` 被指出「命名不太好」；核实后发现不只是名字 —— **仓库里同时跑着两套目录约定**（CLI / 文档 / 官网 / spec
  是项目根 `units/` + 根 `units.ts`；2026-09-13 新增的 `examples/complete`、`examples/deploy` 是 `src/units/` +
  `src/units.ts`），而 `tsconfig.tests.json` 明确 `exclude` 了那两个示例、仓库无 CI，**没有任何一步验证能发现**。
  另有一处同源 bug：脚手架 tsconfig 是 `include: ['src', 'units.ts']`，**漏了能力目录本身** —— 未登记进注册表的
  能力（discover 路线允许不登记）静默不参与类型检查（`tsc --listFiles` 实测可证）。三条一并收口：

  ① **目录约定改为四分类目录，放 `src/` 下**：`src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/` ——
  目录名就是类型（对齐 MCP 的 `tools/resources/prompts`、OpenAI Agents SDK、LangChain 的共同惯例：**不用伞形词**）。
  显式注册表改为 `src/registry.ts`。副作用是三处既存漂移**一次自愈**：示例的 `rootDir:"src"` 不用动、脚手架
  `include` 收缩为 `['src']`（漏 include 的 bug 消失）、示例与新约定自动一致。`agentia create` 会建出四个目录
  （空目录带 `.gitkeep`，让「新能力往哪放」对用户可见）。

  ② **`discover` 放宽为 `string | string[]`**：数组顺序即装配顺序；数组里任一目录不存在**报错**（显式给出的搜索
  路径不该静默落空）；跨目录重名 token 在发现期**留告警**（四个分类目录共用一套 DI token=文件夹名，装配期
  「后者覆盖」会静默吃掉一个）。`agentia g` 在**生成期**直接拦住跨目录同名，`agentia doctor` 报**错误**兜底
  （生成期 + 体检两层），装配期语义不变（不改运行时）。

  ③ **伞形术语整体替换** —— 类型：`UnitType→CapabilityType`、`UnitMiddleware→CapabilityMiddleware`、
  `UnitCall/UnitNext→CapabilityCall/CapabilityNext`、`SkillUnit/SubAgentUnit→SkillCapability/
  SubAgentCapability`、`UnitMetrics→CapabilityMetrics`、`UnitReport→CapabilityReport`、
  `UnitDecoratorContext→CapabilityDecoratorContext`；字段：`maxUnits→maxCapabilities`、
  `droppedUnits→droppedCapabilities`、`labelMode:'unit'→'capability'`、`MetricsSnapshot.units→capabilities`、
  `RunReport.units→capabilities`、`CapabilityReport.unit→capability`、`CapabilityCall.unit→capability`；
  观测面：`agentia_unit_*→agentia_capability_*`、标签 `unit="…"→capability="…"`、**trace span kind
  `'unit'→'capability'`**（`SpanKind` 成员）、trace-view 排行前缀 `unit:→capability:`、`UNIT_ICO→CAP_ICO`。
  内部标识符同步统一。中文侧「单元」一并改称「**能力**」—— 与既有的「能力包」（`defineModule` / `AgentModule`）
  **同族且语义相容**（一个能力包 = 一包能力），不引第二套词汇。

  **兼容性**：**运行时零破坏** —— `discover` 收的是路径，老项目 `discover:'units'` 照跑；只有 `create` / `g` /
  `doctor` 的**约定**变，且它们撞见根 `units/` + `units.ts`（老布局）时会明确提示迁移，不悄悄新建目录。
  **刻意破坏的只有观测面命名**（Prometheus 指标名、`unit=` 标签、trace span kind）—— 上面已逐条列出，便于对着
  改 dashboard。`src/index.ts` 的公共导出**数量不变**（仅改名），官网 api.html 的反向全覆盖计数不受影响。
  设计文档：`docs/plans/2026-09-13-typed-unit-dirs.md`（6 个分叉，F1=A · F4=B · 其余 A · F6=A+B）。

- 2026-09-13：**厂商 SDK 收敛到单一实例化点；依赖形态定为「纯依赖」**。缘起是对标业界后自问
  「`@anthropic-ai/sdk` 是否该做成 peer/optional、让用户不必感知」。三条实测事实锁死了结论：
  ① 公共类型面**直接使用** `Anthropic.MessageParam`（12 个 `.d.ts`、出现 32 次）→ 用户哪怕只走 OpenAI
  兼容端点**也必须**有它，否则类型编译不过、或（`skipLibCheck` 下）静默退化成 `any`；
  ② 既然如此，「可选」不成立，而「让用户单独再装一次」才是真正的奇怪 —— 故**依赖形态 = `dependencies`**
  （纯依赖，npm 自动装，用户零感知），**不做 peer/optional**；
  ③ 但框架内部**不再 `new Anthropic()`**：新增 `integrations/anthropic.ts` 的 `createAnthropicClient()`
  作为唯一实例化点，引擎经它取默认 client。使用者自定义只传 `apiKey` / `baseURL`，**不必直接依赖该 SDK**。
  分层随之调整：`engine` 新增对 `integrations` 的依赖（唯一用途就是取默认 client），`ALLOWED` 与 AGENTS.md 同步。
  **不做鸭子类型**：实测该 SDK 的错误类 `name` 恒为 `'Error'`、`type` 为 null，鸭子类型只能靠
  `constructor.name`（压缩即失效）—— 保留 `errors.ts` 的 `instanceof`（只做类身份判定、不做实例化），
  并把「双副本 → 分类退化为 unknown」记为已知边界。
  ⚠️ **本条结论已被 2026-09-17 决策取代**（client 自研化后 `errors.ts` 改认数据属性的鸭子类型，
  「压缩即失效」的论据反而成了**必须**鸭子类型的理由，见下）。原判断与理由保留在此，不改写。
  **未做（记入 roadmap）**：默认 client 换自研 fetch 实现 + 公共类型自有化 —— 那才是让 SDK 真正可选的正道，
  前置条件是先有「真 API 集成测试」（当前单测与 e2e 全用 mock）。
  ⇒ **两半均已于 2026-09-17 落地**（前置条件「真 API 集成测试」= `e2e:live`，2026-09-14 已就位），见下两条。

- 2026-09-14：**示例真跑纳入门禁 + 抖动可疑构造普查**。两件事的共同起因都是「文档指着说可跑/没人看清」。

  **① `examples/complete` 从「类型检查覆盖」升级为「真跑」**。此前 `examples/` 下 **0 个测试**、全仓没有一条脚本
  执行过它，而 usage-guide 与项目 README 都写着「完整可跑写法见 `examples/complete/`」。新增
  `scripts/e2e-examples.ts`（并入 `npm run e2e`，另留 `npm run e2e:examples` 单跑）：按示例**自己的构建脚本**
  真构建 → 真起服务 → 按它 README 逐条打端点（`/healthz` · 无凭据 401 · 同步 `/run` · SSE · 异步 `/tasks` +
  幂等键去重 · `/metrics` · SIGTERM 优雅停机）。模型侧是脚本内置的假 OpenAI 兼容端点（真 SSE，且把
  `tool_calls` 的 `arguments` **拆两片**下发），**不联网**、不需要任何 key。最有价值的一条断言不是响应文本，
  而是**假端点真的收到了 `echo: ping` 这条 tool_result** —— 即「四类能力真装配上、能力真被执行过」。
  过程中修掉两个会骗人的坑：(a) 用 `tsx src/main.ts` 起进程时 **SIGTERM 打在 tsx 的包装进程上**（应用收不到，
  以 143 退出）→ 改跑 `node dist/main.js`（也是部署形态，顺带把「示例能否构建」纳入门禁）；(b) 本地
  `file:../..` 被 npm 装成**快照拷贝**（实测是拷贝而非软链）→ 示例跑的是安装那天的框架，改了 dist 不生效；
  脚本把它换成指向仓库根的链接，本地与 CI 行为一致。

  **② CI 抖动：找到了，是「工具超时」那条 —— 而且根因在引擎，不在测试**。
  先纠正我自己的判断错误：一开始按 roadmap 的三个嫌疑做机制核查，认定它们**都不成立**
  （`SqliteTaskStore` 的 `busy_timeout` 是 5000ms 而测试只持锁 200ms；drain 几条的闸门由测试自己释放，
  超时不可能先到）—— 对这两个成立，但**把 `toolTiming` 一起划掉是错的**：我只看了两条 `>=` 断言
  （`Date.now()` 差值的下界，确实单调只增），漏了这条用例真正的主张是
  「20ms 超时**必须赢过** 60ms 的工具」—— 那是一场**只有 3 倍余量的计时器赛跑**。

  **复现（可重复，不是偶遇）**：8 倍 CPU 超订（64 个忙等 worker 压 8 核）下，
  `tests/engine/toolTiming.test.ts` 单文件 **29 次挂 1 次**（断言 `body.ok === false` 实际为 `true`）；
  PR #19 的 CI（Node 22、2 核 runner）也红了同一条。
  **判定实验**：绕过测试框架、单进程直接用引擎跑该场景 **1200 次 → 翻转 1 次**，样本
  `{ wallMs: 99, durationMs: 99, content: 'late' }` —— 工具那 60ms 的 sleep 实际花了 99ms，
  而 20ms 的超时**没先触发**。
  ⇒ **`withTimeout` 的超时不是硬保证**：事件循环被饿住时，它的计时器可能输给工具，
  于是**一个超出预算的工具被记成成功**（`ok: true`），超时护栏静默失效。
  （对照实验：把 `withTimeout` 单独拎出来跑同样两条 `setTimeout` 赛跑 3000 次 → **0 翻转**，
  说明裸赛跑本身在常规条件下是稳的，翻转需要引擎+验证路径的饥饿叠加。）

  **本 PR 做了什么**：把该用例改成**确定性**形态 —— 工具挂在一个只由测试释放的闸门上，
  断言前它**不可能** settle ⇒ 超时必然先生效，与调度无关（同负载下 **60/60 通过**）。
  原形态是「靠两条计时器定输赢」，改成「靠一个不可能满足的前提」，这是必要的：一个 3% 失败率的
  用例会让每次 CI 红都无从判断。

  **本 PR 没做什么（当日已补，见下条）**：**引擎那层没动**。修法方向是给 `withTimeout` 加**实测耗时兜底**
  （await 之后用 `Date.now() - startedAt >= timeoutMs` 再判一次，超时就记超时），但那是一次
  **语义收紧**——「21ms 完成的工具在 20ms 预算下会被记成超时」与当天的「记成功」不同，
  属于核心路径语义变更，要单独拍板 + 单独决策记录。⇒ **同日单独一单落地，见「2026-09-14 ②」**。

  **顺带**：同一个 PR 把四处「等到某状态」的墙钟预算等待收进 `tests/helpers.ts` 一份
  `waitFor(cond, what, budgetMs = 10_000)`（`host-hardening` 有 4 处默认 1000ms、比出过事的 scheduler
  那个还紧；四处各写各的：两份手搓 `waitFor`、两份「100×5ms 裸轮询再 assert」），超时抛
  **带条件描述 + 实测耗时**的错误，返回 `Promise<void>`（不是 boolean）。预算给足不是「加大余量」——
  这类等待验的是顺序/一致性，没有一处验延迟指标。反向验证：`tests/waitFor.test.ts` 证明条件永不满足时
  它仍会抛错自陈。

### 2026-09-14 ②：`withTimeout` 收紧为**硬保证**（工具级超时不再靠竞速定输赢）

**决定**：超时判定**不看竞速结果，只看实测耗时**。工具 settle 之后若
`settledAt - startedAt >= timeoutMs`，即便 `Promise.race` 已经把工具的返回值交回来了，也记 `TIMED_OUT`。
（`settledAt` 记在**工具 settle 的那个微任务里**，不是 `await` 恢复之后 —— 理由见下。）

**为什么必须改**：`Promise.race` **不是硬保证**。上一单已实测：8 倍 CPU 超订下，单进程直接用引擎跑
「60ms 工具 + 20ms 预算」1200 次 → **翻转 1 次**（样本 `wallMs/durationMs = 99`、`content: 'late'`），
即**一个超出预算的工具被记成 `ok: true`**，超时护栏静默失效。
护栏静默失效比没有护栏更危险 —— 使用者以为设了上限，实际上限会被调度运气吃掉。

**机制层面如实交代**：翻转的**单一起因尚未完全钉死**（「工具与截止计时器在同一毫秒内创建、又同批到期，
由计时器列表顺序决定谁先执行」是**尚未验证的假设**）。本单钉死的是**可能性本身**，且用**确定性**构造，
不靠调度运气：

> 让工具在**自己的回调里 `resolve` 之后同步阻塞**越过截止。微任务虽已排入，但要等本轮回调跑完才执行
> ⇒ 工具先被 `race` 看见，而已到期的截止计时器只能等下一轮 timers 阶段。
> 实测同一构造：**旧实现返回 `'late'`（⇒ `ok: true`）、硬化后返回 `TIMED_OUT`**。

即：竞速可以交回一个**观察时刻已越过预算**的值 —— 这一点是确定的，与成因无关。修法针对的正是这一点。

**为什么在「工具 settle 的微任务」里记时间**：若在 `await` 恢复之后再测 `Date.now() - startedAt`，
宿主在「工具完成 → 恢复」之间被饿住，会把**按时完成**的工具误判成超时（新增假阳性）。
微任务紧跟在 resolve 它那次回调之后跑，`settledAt` 最贴近工具真正完成的时刻 —— 这条差异有专门用例守着。

**代价（如实记）**：**语义收紧** —— `21ms 完成 / 20ms 预算` 由「成功」变「超时」。
判断为可接受且更正确：「预算」是对**实际耗时**的承诺，不是对调度运气的承诺。
**既有用例一条没改**（`verify-all` 8/8 全绿）⇒ 说明此前没人依赖那个边界。

**门禁（此前这条性质没有门禁，本单补上）**：

- `tests/engine/concurrency.test.ts` → `describe('withTimeout：超时是硬保证')`：超预算赢竞速必记超时 /
  预算内不误判（防假阳性）/ 截止计时器先赢 / `reject` 原样抛出 / 非正预算透传。
- `tests/engine/toolTiming.test.ts` → 「超预算才 settle 的工具必须记 timeout」：走引擎 + trace 记账全链。
- **承重性反向验证**：临时把实现回退到旧版 ⇒ **恰好这 2 条挂（18/20）**，恢复后 20/20。
  没有这一步，「新用例通过」可能只是因为它在旧实现上也过。

**顺带**：`concurrency.test.ts` 首次**直接**单测 `withTimeout` 与 `TIMED_OUT` 哨兵
（此前只有经引擎的间接覆盖）；该哨兵的表意（区分「超时」与「工具恰好返回 `undefined`」）由此有了直接门禁。

**测试写法教训（沉淀）**：`setTimeout` 有两层语义 ——「回调被排入」与「微任务被 drain」。
**靠两个计时器先后定输赢的断言都是概率门禁**（余量再大也会翻，只是概率低）。
要确定性，就让「不可能满足的前提」（闸门）或「同步阻塞越过截止」参与构造，而不是加大余量。

### 2026-09-14 ③：真 API 集成验证落地 —— 当场挖出「默认 client 从不转发 signal」

**背景**：全仓测试都走 `tests/helpers.ts` 的 `mockClient`，而 mock 只实现我们**以为** SDK 该有的形状。
于是「SDK 真可选」这件事从没被真端点验过：SDK 的真实行为若与假设不同（SSE 分片形状、`tool_use.input`
的解析、`usage` 字段名、`signal` 中转），**现有门禁全绿也发现不了**。这是「让 SDK 真可选」的前置条件。

**新增**：`scripts/e2e-live.ts`（`npm run e2e:live`）。与仓里其他 e2e 的三点不同，刻意不混：
① **会真花 token** ⇒ 不并入 `npm run e2e`、不进 verify-all、不进 CI；② 无凭据时**跳过并 exit 0**，
但打醒目横幅（静默跳过等于假装验过）；③ 断言只针对**协议契约**，厂商支持度差异**只报告不判失败**。
端点走 `ANTHROPIC_BASE_URL` —— 用 DeepSeek 的 Anthropic 协议兼容端点即可验完主路径，
**不需要 Anthropic key**（这是选择它而非 Anthropic 官方端点做本地验证的原因）。

**六个步骤 + 真端点实测结果**（`deepseek-v4-flash` @ `api.deepseek.com/anthropic`）：

- ① SSE 流式：`on('text')` 分片拼接 == `finalMessage()` 文本，`usage` 有值 ✓
- ② `tool_use`：`id` / `name` / `input`（含 schema 字段）都真解析出来 ✓
- ③ `tool_result` 回灌：模型接着收尾，`stop_reason=end_turn` ✓
- ④ `system` 用 `TextBlockParam[]` 带 `cache_control`：端点接受，且**真回报了缓存计量**
  （`cache_read_input_tokens=384`）—— 兼容端点支持度比预期好 ✓
- ⑤ **signal 转发**：见下 ✓（修好后）
- ⑥ 引擎全链：`runAgent` + 真工具 ⇒ `tool.output.ok=true`、`llm.turn` ≥2、`totalUsage` 有值 ✓

**⑤ 挖出的真 bug（这是本单最重要的产出）**：步骤 ⑤ 一开始**红了**，而且红得有信息量 ——
在飞请求 `abort()` 后**仍跑完了**（收到 599 个分片、跑满 7.6s）。

判定过程（不猜，逐层收窄）：

1. 先排除框架：`createAnthropicClient()` 返回的就是 SDK 实例本身，`signal` 是**直接**进
   `sdk.messages.stream()` 的，框架没有中转层 ⇒ 不像框架吞了它。
2. 再怀疑自己的测试构造：**预中止**的 signal 在 SDK 挂监听器之前就 abort 了，事件不会再触发 ——
   实测预中止的请求确实照常跑完。这一版构造选错了靶子（契约要的是「中止**在飞** run」），
   改成**首个分片到达后**再 abort（用分片事件当触发点，不用墙钟猜）。
3. 改完仍红 ⇒ 查 SDK 类型：`stream(body, options?)`，**`signal` 只在 `RequestOptions` 里认**
   （`internal/request-options.d.ts`），而 `MessageCreateParams` 里**没有** `signal` 字段。
4. 最小对照实验（同一请求，只改 signal 的位置）：

   | signal 位置 | 实测结果 |
   |---|---|
   | **body 内**（= `ModelClient` 契约的形状） | 分片 **599** 个，abort 被吞，请求跑完 |
   | **RequestOptions**（= SDK 0.124 真实入参） | 分片 **2** 个，**1ms** 内 `Request was aborted.` |

**根因**：框架的 `ModelClient` 契约把 `signal` 放在 **params 内部**，而默认实现 `createAnthropicClient`
只是 `return new Anthropic(...)` ⇒ signal 进了 body，被 SDK **静默丢弃**（不报错、不警告）。
即：接口注释白纸黑字写着「实现须转发给底层请求，否则调用方无法中止在飞 run」，而**框架自己的默认实现
就没做到**。`integrations/openai.ts` 是手写 fetch，本来就透传 —— 只有 Anthropic 这条（**恰好是默认路径**）坏着。

**影响面（不是「少个功能」）**：`transport/async.ts` 对 `runTimeoutMs` 的承诺是
「到点真中止、**token 不再继续烧**」，靠的就是这个 signal。旧实现下超时的 run 会在后台
**继续烧 token** 直到模型自己说完 —— 承诺与实际相反。

**修复**：`createAnthropicClient` 包一层，把契约里的 `signal` 搬到 `RequestOptions`
（拆分逻辑抽成 `splitSignal()`，单独导出只为可测）。文件头注释里留了上面那张实测对照表 —— 
这个坑不看数据很难相信。

**门禁（两处，一处在 CI、一处不用 key 也能跑）**：

- `tests/integrations/anthropic.test.ts`：`splitSignal` 的 3 条形态断言 +
  **本地假端点**测「abort 后必须断开」（零 key、零外网）。假端点**故意不响应**把请求挂在飞，
  触发点用「端点真收到请求」而非 sleep。**承重性已反向验证**：临时绕过 signal 搬运 ⇒ 该条挂 3s 后失败。
  这一条的价值在于：把「signal 有没有真到传输层」从「只有真端点能验」变成了 **CI 可跑的零成本门禁**。
- `scripts/e2e-live.ts` 步骤 ⑤（真端点确认，需凭据）。

**顺带**：`core/tool.ts` 的 `signal` 字段注释补了「自定义 client 的常见坑」与参考实现 ——
自定义 client 的同样会撞上这个坑，而它的表现是**完全静默**的。

### 2026-09-14 ④：截止计时器**不得 `unref()`** —— 「超时」是等待的终点，不是兜底 tick

**起因（`# fail 0` 却红了 CI）**：发布 PR 的 `verify` 红了，但红的形状很怪 ——
`# tests 485 / # pass 481 / # fail 0 / # cancelled 4`：**没有断言失败**，是 4 条测试被 runner
**cancel** 了，全在 `tests/engine/toolTiming.test.ts` 的 E1 套件里（第 1–3 条过，4–7 条被取消）。
日志里 runner 自己给了原因（而我们当时的失败抽取把它丢掉了，见下）：

```
failureType: 'cancelledByParent'
error: 'Promise resolution is still pending but the event loop has already resolved'
```

**复现（不是偶发，也不靠负载）**：Node 22（与 CI 同 major）跑该文件 15 轮 → **14 轮 cancel**；
同机 Node 26 跑 15 轮 → 0 轮。定向复现是唯一有效手段：**单文件 + 指定 Node，比多跑几轮全量强**。

**判定实验（剥掉所有框架代码）**：空事件循环里 await 一个「永不 settle 的 promise + 截止计时器」：

| 计时器 | Node 22.23.2 | Node 26.5.0 |
|---|---|---|
| `unref()` | **进程直接退出**（exit 13，顶层 await 未 settle） | 同左 |
| 不 unref | `settled: TIMED_OUT`，exit 0 | 同左 |

⇒ **与 Node 版本无关**，Node 22 只是让 node:test 把它报成 `cancelledByParent` 而已。

**根因**：该计时器的**触发本身就是「被 await 的 promise 得以 settle」的条件**。一旦 `unref`，
当它是事件循环里唯一的把手时，进程在它触发前就退出 —— 调用方**什么都拿不到**（不是超时值，
是整段 await 静默消失）。旧注释「兜底计时器不该让宿主为它续命」把两类计时器混为一谈：

- **兜底 tick**（scheduler 的下一拍、SSE 心跳、metrics 刷盘）：**没人 await 它们**，
  unref 是对的 —— 保留了（`transport/scheduler.ts`、`transport/http.ts`、`integrations/metrics.ts`）。
- **等待的终点**（工具级超时、MCP 调用超时、停机 `drain`、`runTimeoutMs`）：**调用方正在等它**，
  unref 等于让「等待」永远不结束。四处的 unref 全部去掉
  （`engine/concurrency.ts`、`integrations/mcp.ts`、`transport/async.ts` ×2）。

**影响面（不止测试）**：`await runAgent({ tools:[挂死的工具], toolTimeoutMs: 20 })` 在普通脚本里
**不会返回超时，而是进程静默退出**。对一个把「工具级超时」当护栏卖给使用者的框架来说，
这比「超时不硬」更严重：护栏连触发机会都没有。

**门禁**：`tests/timeoutLiveness.test.ts` + `tests/fixtures/timeoutLivenessProbe.ts` ——
拿**干净子进程**（`node --import tsx`）在空事件循环下验三个往返：工具级超时回到 `end_turn`、
MCP 调用抛出「调用超时」、`drain` 预算耗尽返回 `false`。
**必须子进程**：本性质的前提就是「进程里没有别的把手」，而同进程跑测试时**测试跑器自己持有把手**，
会把缺陷藏起来（这正是它此前只被 CI 抓到、本地永远绿的原因）。
**承重性反向验证**：把三处 `unref` 加回去 ⇒ 门禁 **3/3 全红**。
`transport/async.ts` 的 `runTimeoutMs` 一并去掉 unref，但**未进门禁**：如实说，它的活性被
`awaitTask` 的兜底轮询（另有 ref'd 计时器）掩盖，探针验不出差别 —— 不假装它被覆盖了。

**顺带补的诊断缺口**：`scripts/verify-all.sh` 的失败抽取只抓 `not ok` / `AssertionError`，
而 cancel 类失败的**原因行**（`failureType` / `event loop has already resolved` / `# cancelled`）
一条都没抓 —— 这就是为什么 CI 上只看到一个 exit 1。已把它们加进抽取清单（沿用 PR #9 的同款修法）。

**这条与 ② 的关系**：同一条用例（`toolTiming` 的「工具超时」）暴露出**两个独立缺陷** ——
② 是「竞速不是硬保证」（超预算被记成功），④ 是「计时器被 unref」（等待干脆结束不了）。
两者都在这个文件里以不同形状现形，也各自有了门禁。

### 2026-09-14 ⑤：`.env` 成为一等配置入口 —— 但框架仍**不自动**读

**起因（使用者视角的一次核对）**：核对「框架配置 AI key 要不要 `.env`」时发现两件事同时成立 ——
框架**从不读** `.env`（全仓 `grep dotenv` 零命中；`dev.ts` 的注释还钉着「框架侧不感知 dev：不读 env」），
而 `agentia create` 生成的脚手架 `.gitignore` **只有 `node_modules` / `dist`**：
用户按习惯建一份 `.env` 写 key，`git add -A` 会把它**连 key 一起提交**。
（反证：仓库自己的根 `.gitignore` 有 `.env`，`examples/*/.env.example` 还写着「`.env` 已 gitignore」——
同一个作者在自家仓库挡住了、在发给用户的模板里没挡。实测 `git check-ignore` 复现。）

**判定**：`.env` 需要被生成、也需要被读 —— 但**读的动作不进框架、也不进 CLI**，而是框架提供一个
**显式的** `loadEnvFile()`，由宿主（脚手架的 `src/main.ts` 首行）调用。

- **不塞进 `createApp` 自动读**：读 `.env` 会改 `process.env`，而 `.env` 按 cwd 找。
  隐式生效之后，「同一份代码换个目录跑结果不同」「本地多放了个 `.env`，测试行为悄悄变了」
  都会变成需要排查的悬案 —— 本仓库自己就会先中招（`e2e:live` 的开发者会在仓库根放 `.env`，
  而几乎每个单测都调 `createApp`）。
- **不放 CLI**：`agentia dev` 只是宿主之一。放 CLI 会让 `node dist/main.js`、docker、别的宿主都读不到 ——
  那才是真的「只有 dev 生效」。放在使用者的 `main.ts` 里，所有宿主一致。
- **零依赖**：Node 18 没有 `process.loadEnvFile()`（21.7+）、没有 `--env-file-if-exists`（22.9+），
  而 `--env-file`（20.6+）在 Node 18 上直接报错退出 —— `engines: >=18` 下只能自己解析（约 90 行，含注释）。

**三条语义（都刻意，且都有测试）**：

1. **文件不存在 = 静默返回 `{}`**（首次 clone / CI / 生产靠真实环境变量的正常路径），不制造假依赖；
   但**内容非法直接抛错并指出行号** —— 静默跳过等于让用户以为「配上了其实没配上」；
2. **真实环境变量优先**：`process.env` 里已定义（哪怕空串）的键不被覆盖，`override: true` 才反向。
   ⚠️ 这条的代价要写明：**本机 export 过 `ANTHROPIC_API_KEY` 的人**（如同时用 Claude Code），
   脚手架 `.env` 里的 key 会被**静默压住** —— 已写进使用说明的显眼处，否则这就是下一个「改了没生效」的悬案；
3. **想知道「生效没」看返回值**：被挡下的键不在返回对象里，不用去猜文件有没有被读。

**门禁**：`tests/toolkit/env.test.ts` 12 条（解析边界 / 优先级 / 空串 / 缺文件 / 非法内容）；
`packages/cli/test/templates.test.mjs` 钉「`.env` 三件套」契约（生成 `.env` 却不 ignore = 事故）；
`scripts/e2e-cli.ts` 两条：语法面「生成的 `main.ts` 有一句独立的 `loadEnvFile();`」+
行为面「在脚手架目录里真的把 `.env` 读进了 `process.env`」。

**反向验证抓到的假绿（如实记）**：语法面那条最初写成「文件内容里含 `loadEnvFile()`」，
结果被同文件**注释**里的说明文字满足了 —— 把调用整行删掉，门禁照样绿。改成锚定独立语句行
`^loadEnvFile\(\);$` 后反向验证才变红（另半条 `.gitignore` 断言反向验证一次就红）。
教训与 ④ 同源：**断言要锚在「行为/语句」上，不能锚在「文本里出现过」**。

**影响面**：`docs/usage-guide.md` 新增「环境变量与 `.env`」一节 + 改写两条已知边界
（原「框架不读 env」→「框架不自动读 `.env`」；停机那条去掉「不读 env」的括号理由，免得自相矛盾）；
官网 `api.html` 补 `loadEnvFile` / `LoadEnvOptions` 并把导出计数 175 → 177（反向全覆盖门禁会拦）。

### 2026-09-14 ⑥：事件正文截断开关落地 —— 顺带删掉「脱敏」这个空头承诺

**起因（使用者视角的一次核对）**：核对「调试面板里工具结果能不能展开」时，先查数据侧能不能撑起展开，
结果挖出三件事同时成立，而注释与 spec **只写了前一件**：

- `src/core/trace.ts` 与 `docs/spec.md` §9.1 都写着「工具入参/出参默认截断 + 脱敏，完整内容 opt-in」；
- **「截断」是真的**，但值**硬编码**在 `engine/loop.ts`（`limit(use.input, 2000)` /
  `ok ? 2000 : 1000`）—— **「完整内容 opt-in」零实现**：全仓 grep `opt-in | fullBody |
  captureFull` 只命中那两句措辞本身，没有任何开关；
- **「脱敏」更彻底**：`stringifySafe` 只做序列化，全仓 `redact | 脱敏 | sensitive` 在 `src/` 下
  零命中 —— 而 spec §9.3 **自己**写着脱敏是 sink 缝外的事（`usage-guide` §6「观测」同款口径）。
  也就是说 §9.1 那句是**自相矛盾**：承诺了一件它自己在别处声明不做的事。

**判定**：三件事分头处理 —— 补上缺的开关、改正错的措辞、**不实现脱敏**。

1. **补开关**：新增 `RunInvocationOptions.maxEventChars?: number | false`（`AppOptions` 同款缺省）。
   **数字** = 入参/出参统一用该上限；**`false` = 不截断**；不设 = 保持旧缺省（入参/成功出参 2000、
   失败出参 1000）。
   - **为什么是「数字 | false」而不是一个布尔 `traceFullBody`**：数字同时覆盖「想多看一点」
     与「全都要」，而布尔只能表达后者；`| false` 也延续本仓既有约定（`retry?: RetryOptions | false`
     的 `false` = 关闭）。
   - **为什么不顺手改缺省值**：trace 体积是 sink 落库 / OTLP 导出 / 看板成本的共同分母，
     改缺省等于**静默**改所有既有使用者的观测成本。要全文就显式开。
   - **`false` 的代价写进文档**：工具返回多大就记多大，调试期开、生产期关。
2. **透传给嵌套能力**（`ToolRunContext.maxEventChars` → `runAgentScoped`）。否则调试期开了全文，
   **子 agent** 里的工具事件还是被截断的 —— 同一棵调用树上两种口径，而「子 agent 里的工具
   为什么失败」恰恰最需要看全文。与 `priceOverrides` 的透传理由同源（那边是「否则子 agent 用同一
   模型退化成未定价」）。
3. **删掉「脱敏」**（而非补一个实现）：按 §9.3 的既有分工，它本就不属于框架。**删错的、不补对的** ——
   留着会让使用者以为框架替他挡了密钥泄漏。

**顺带修掉的第二个坑（真浏览器之外看不出来的那类）**：`tool.input` 的正文到得了 trace，
却到不了眼睛 —— `packages/trace-view/src/fromTrace.js` 的 `eventText()` 把入参交给 `fmtArg()`，
而后者**砍到 4 个键 / 每值 21 字符 / 整串 62 字符**。所以「给面板加展开」若只加 UI，展开出来的
仍是那 62 个字符 = **假展开**。⇒ `playTrace` 现在对事件多传一个 `full`（入参取**原文**），
渲染器的 `text` 是摘要、`full` 才是展开内容。

**交互三条（都刻意，且都有测试）**：

- **折叠态一字不变**：`text` 仍是摘要、出参仍由 CSS 省略号收敛；caret 用**绝对定位 + `opacity:0`**，
  不占 flex 宽度 ⇒ 折叠态的排版与加展开之前逐字一致（事件行「比 span 行更轻」的既定语言不破）；
- **展开态活在渲染之外**（`Set`，按事件的稳定 `key` 索引）：渲染是**每次事件全量重建 DOM**
  （`rootEl.innerHTML = ''`），状态放进 DOM 或渲染过程里，实时 run 中刚点开的行会在下一条事件
  到来时自己合上；`reset()` 显式清空（否则新树继承旧展开、且 Set 随 run 无限增长）；
- **选文本时不切换**：鼠标拖选到行外松手会补一次 `click`，不判 `getSelection()` 就会「选完自己合上」。

**合并后补的一条（窄面板挤死 —— 只有真在窄容器里看一眼才会发现）**：上面那条「行内展开」在
宽面板（CLI inspector，行宽 896px）看着没问题，**官网 Playground 的 296px 面板里却不可读**：
那一行的固定项（树前缀 + 事件类型 + 工具名）本身就要 ~280px，正文只分到 **16px**，59 个字符被压成
34 行、行高顶到 60vh 上限（386px）。⇒ 展开态改为 **`flex-wrap: wrap` + 正文 `flex-basis: 100%`**，
正文换到**独立整行**（实测窄面板 16px → 296px、行高 386 → 72）。两处已各自数值复验（窄 9 项 / 宽 9 项）。

> ⚠️ 上面这段的**后半句**（`flex-basis: 100%` = **无条件**换行）已被**下一条**决策取代：现在默认与
> 标签同一行，只在放不下时才换行（`flex-wrap: wrap` 保留）。原文照旧留着当当时的判断记录，不改写。

⚠️ **这一类缺陷任何「溢出检查」都查不出来**：两处都是 `scrollWidth === clientWidth`、
页面无横向滚动、「部署成功」也全绿 —— 只是**读不了**。判定依据必须是**几何**（正文宽度、
行高、`scrollHeight` vs `clientHeight`），不是「有没有溢出」。首轮只验了宽面板就下结论，
代价是一次合并后的返工。

**门禁**：`tests/engine/eventChars.test.ts` 6 条（缺省逐字不变 / 数字统一三类 / `false` 不截断 /
**回给模型的 tool_result 不受影响** / `config.maxEventChars` 记 `'off'` / 子 agent 透传对照）；
`packages/trace-view/test/view.test.js` 7 条（折叠态一致 / 出参切换 / **入参展开是原文而非 62 字符摘要**
/ 跨重渲染存活 / 选区保护 / reset 清理 / 空正文不可展开）。

**顺带修掉的一处测试债**：`fromTrace.test.js` 里同一段 DOM stub 抄了三份，都缺 `addEventListener` ——
渲染器一挂 click 三条用例全红。抽成一个带 `addEventListener` 的 `makeNode()` + `useDom()`，
三处重复消失。（**是 stub 缺能力，不是渲染器的问题**：浏览器里 `addEventListener` 必然存在。）

**影响面**：`docs/usage-guide.md` 两张选项表各加一行 `maxEventChars` + 新增「调用树面板」小节
（含「展开只能展开 trace 里存着的正文」这句关键前提）+ 顺带改正「生效配置快照」那句
（原文写「缺省值也记」，但可选项 `toolTimeoutMs` / `maxToolConcurrency` / `maxEventChars`
其实只在设了才记）；`core/trace.ts` 的假承诺注释与 `spec.md` §9.1 同步改为如实描述。

### 2026-09-14 ②「展开」收尾：版式回摆 + 第二宿主补齐原文 + lint 折进本地链

上一节的数字复验（只验了宽面板、窄面板漏验）之后又量出四件事。四条都是**实测**出来的，不是猜的。

**a. 版式回摆：无条件换行 → 「放不下才换行」**

上一节把展开正文改成**无条件**换到独立整行（`flex-basis: 100%`）。窄面板里这是对的，但它把宽宿主
（CLI inspector 874 / 1223px）「一行一个语义单元」的阅读节奏也一起改掉了 —— 正文明明放得下。
现在的规则：**默认与标签同一行，放不下才整段换行**。判据落在 `flex-basis: 0` + `min-width: 22ch`：

- `flex-basis: auto` ⇒ 换行判据是 **max-content**（正文动辄上百字符）⇒ 等于无条件换行；
- `flex-basis: 0` ⇒ 判据回到 `min-width` ⇒ 放得下就同排、放不下才换行。

实测（构建产物 `dist/`，`content-box` 与 `border-box` 两种宿主都覆盖）：

| 宿主容器 | 行宽 | 固定项（前缀+类型+工具名） | 展开正文宽 | 表现 |
|---|---|---|---|---|
| CLI inspector | 1223px | 246.5px | 976.5px（79.8%） | 与标签**同一行** |
| CLI inspector | 874px | 246.5px | 627.5px（71.8%） | 与标签**同一行** |
| 官网 Playground | 296px | 246.5px | 296px（100%） | **整段换行**（非窄缝） |

三处都 `ioW ≥ 100px`、面板与文档零横向溢出、零 JS 错误。`min-width` 不可省 —— 省了就回到 16px 窄缝。

**b. caret 常显 + 右端窄槽（并且：0.75 是缺陷，不是口味）**

caret 原本 hover 才淡入，「这一行能展开」只有已经知道的人发现得了。改为**常显**。
最初写成静止 `opacity: .75`、悬停 `1`，随后**量出这不能留**：caret 是交互指示器，
WCAG 1.4.11 对非文本 UI 组件要求 ≥3:1 —— 而 0.75 的 `--faint`(`#71717a`) 在官网 `#0c0c0e`
面板上实际绘制成 `#58585f`，只有 **2.77:1**（满不透明度 4.04:1）。⇒ 去掉那一档：静止即满不透明度，
hover 不再改变它（两宿主 `--faint` 同值，不是巧合地只在一个宿主上达标）。

随之必须给右端留一条 12px 内边距的窄槽：不留的话，被截断正文的省略号「…」正好落在 caret 底下，
两个字形糊在一起。判据 `caret.left ≥ io.contentRight`（两种宿主、常显与展开态都不重叠）。
**12px 没有再收紧 —— 这一格是纯取舍，与上一条不同**：caret 字形本身约 6px（10px 等宽字体），
再窄就贴住省略号，省下的 3–4px 在 600–1200px 的行宽上不值得为此冒一次回归风险。

**c. 第二个宿主只喂了摘要（「假展开」）**

`playTrace`（CLI inspector）这条路上「展开给原文」是对的；但**官网 Playground 自己组 trace** 时，
`traceEvent(id, type, tool, text, ok)` 只传了 `fmtArg(...)` 摘要、没传 `full`。渲染器从 62 字符的摘要
反推不出原文 —— 于是**同一个渲染器在一个宿主里真展开、在另一个宿主里点开什么都没多出来**，
而两处共用一份渲染器的全部意义就是不让这种漂移发生。
⇒ 原文口径收进 `view.js` 的 `rawArg`（`fmtArg` 的对偶，两个宿主都调它），
`playground.js` / `playground-real.js` 的 `tool.input` 记录点补上第 6 参。
实测（官网真实运行）：折叠态 59 字符摘要（含 `…`）→ 展开态 73 字符**完整 JSON** 且可 `JSON.parse`，
`differs / longer / parsesAsJson` 三项全 true。

**d. 门禁自身：lint 折进本地链**

`verify-all.sh` 此前**不跑 lint**（lint 只在 CI 的独立 job 里），于是「本地 8/8 全绿、CI 挂 Biome」
是可能的。这次就撞上了：本地全绿，CI 的 `lint` job 在新写的源码/测试上挂了 **3 条格式 error**
（`biome ci` 里「内容与格式化输出不一致」算 error）。
⇒ `npx biome ci .` **折进第 1 步**，不加第 9 步：`verify` job 的 name 就是分支保护的必需状态检查、
写死了「8 步」，加步骤这名成假话、改名又会让 PR 卡死等一个永不出现的检查；折进去还让 lint 落进
**必需**检查里（比另开一个非必需 job 更硬）。结尾写死的「8/8」一并改成算出来的 `${#steps[@]}/${#steps[@]}`。

失败分支**实测**（没跑过的分支就是坏的分支）：注入「真 biome 失败 + 真测试失败」，两类标记都命中，
且**能报出出问题的文件名** —— 这需要一处修正：biome 的诊断首行带 ANSI 颜色码（路径与 `format`
之间夹着 `\033[0m`），锚定「路径 format ━━」会失配，所以抽标记行前先剥色。

**为什么 `import-floor` 与 `e2e:mcp` 仍然不进本地链**（试过，结论是**不该进**，不是漏了）：
`scripts/check-import-floor.mjs` 按**运行中的 Node** 分支 —— ≥22.5 才验 SqliteTaskStore 可用，
否则验「可读报错而非崩溃」。本地（Node 26）跑它只会走「新 Node 可用」那条，对 Node 18/20 的
地板**一个字都没验到**，折进来等于**看起来有覆盖**（比没有更坏）。`e2e:mcp` 默认优先接真第三方
server（需要网络 / uv），而本地链必须离线可跑。⇒ 二者保持 CI 独有，改成在链尾**明确打一行提示**
（「本地绿 ≠ CI 绿：另有 3 个 CI 独有必需检查不在本链」），并留在 `CONTRIBUTING.md` 的坑表里 ——
静默的全绿正是这一整条 d 段要治的东西。

**门禁**（都是**源码级**就能看见的，比开浏览器便宜）：

- `packages/trace-view/test/style.test.js` 4 条：`.tr-open .tr-io` 必须有非零 `min-width`、
  `.tr-row.tr-open` 必须有 `flex-wrap: wrap`、`.tr-caret` **静止必须是满不透明度**（不许调暗，
  理由即 b 段的 2.77:1）、可展开行的正文有 `padding-right`。**逐条反向验证**（把对应那条改坏 ⇒ 各挂 1 条）。
- `tests/docs/website-playground-expand.test.ts` 2 条：两个宿主的 `tool.input` 记录点必须含
  `rawArg(...)`；`traceEvent` 包装器必须把实参**全部**转发给 `view.event`。三种改坏各挂 1 条。
- `packages/trace-view/test/view.test.js` 加 2 条：`fmtArg` 砍到 62 / `rawArg` 给完整 JSON 且两者不等；
  `rawArg` 边界（`null` → 空串、字符串原样、循环引用回落 `String()`）。

**影响面**：`docs/usage-guide.md` 面板小节两句（「该行改为换行显示」「caret 悬停才显形」）改为如实描述；
`AGENTS.md` 的验证顺序与 lint 条目；`CONTRIBUTING.md` 的「提交前必须跑」与坑表。
**已有决策记录保留原样**（上一条里 `flex-basis: 100%` 那半句已被本条 a 段取代，标注而不改写）。

### 2026-09-15（发布后更正）：RedisTaskStore 的 TTL 改走 `EXPIRE` —— 「位置参数形态两者通吃」是错的

**背景**：0.4.1 的 ⑦ 条把 `RedisLike.set` 从对象形态 `set(k, v, { EX: n })` 改成位置参数形态
`set(k, v, 'EX', n)`，理由是「位置参数是 ioredis 与 node-redis 的公共形态」。**后半句不成立**，
而它随 0.4.1 发布出去了。

**证据（拿真包跑它的命令序列化器，不是推断）**：

```
node-redis v6.2.1  @redis/client/dist/lib/commands/SET.js 的 parseCommand
  parseCommand(p,'k','v',{EX:60}) → ['SET','k','v','EX','60']   ✅ TTL 生效
  parseCommand(p,'k','v','EX',60) → ['SET','k','v']             ❌ TTL 被丢
node-redis v4.7.1  同文件 transformArguments（v4 的名字）—— 同样结果
```

**根因**：`SET` 的命令定义只声明 `(key, value, options)` **三个形参**，多出来的位置参数被 JS
直接丢弃 —— **不报错、不警告**。所以对 node-redis 用户，`ttlSeconds` 此前**完全不生效**：键永不过期、
`list()` 无锁增长，且没有任何信号。而**旧的对象形态在 node-redis 上是正常的** ⇒ 这是一次
「修好 ioredis、静默弄坏 node-redis」的回归。

**为什么没被门禁抓到（本条最值钱的一课）**：用例里那个 `NodeRedisFake` 是**照着这个信念写的**
（注释原文「对象选项与 legacy 变参**都**接受」）—— 它断言的是作者的假设，不是库的行为，于是
测试全绿。**fake 只能模拟实测过的形态，并注明出处与版本**；凡「A 与 B 都兼容」的结论，至少对
一个真包执行一次它的序列化/解析路径取 argv 证据。同一课已记入 `focused-review-fix-round` 的坑表。

**更正后的契约**：
- `RedisLike.set(key, value)` —— **只两参**，是两家唯一无歧义的公共形态（尾参形状两家相反：
  ioredis 认 `('EX', n)`、node-redis 认 `{ EX: n }`，取任何一种都会在另一家上失败）。
- `RedisLike.expire?(key, seconds)` —— 两家**同名同形**，TTL 一律走它。
- `RedisTaskStore`：`ttlSeconds > 0` 时 `expire` **必需**，构造期校验、缺失即抛错（静默失效比
  启动期报错难查得多）；不设 TTL 时不要求。
- **取舍（有意）**：`SET` + `EXPIRE` 两条命令、**非原子** —— 两步之间进程被杀会留下一个没有 TTL
  的键（多活一条本该到期的记录），不损坏数据。TTL 只是查询窗口，用这个窗口换「两家客户端都真
  生效」。
- `RedisSetOptions` 保留导出（公共面 + 官网 API 页），但已无人使用 —— 注释改为如实说明历史。
  `RedisSetArgs`（内部类型，从未进 `index.ts`）删除。

**门禁**：`NodeRedisFake` 重写为**照实测**的形态（`set` 只认 options 对象、位置参数按真实行为
丢弃，并逐条记录 argv）；新增 3 条用例（TTL 必须落在 `EXPIRE` 且 `SET` 只两参 / 无 TTL 时不发
`EXPIRE` / 缺 `expire` 时构造期抛错）。**反向验证**：去掉 `applyTtl` 调用、去掉构造期校验
—— 两次都精确挂掉对应用例。

**影响面**：`docs/usage-guide.md` 的 `RedisTaskStore` 表行（改成如实口径）、`packages/website`
的 API 页 `RedisLike` 行（结构面补 `expire?`）、`src/store/redisStore.ts` 的类注释与
`RedisSetOptions` 注释。本轮不改任何行为缺省：不设 `ttlSeconds` 时依旧只 `SET`、依旧不过期。

**附：同轮修掉 `e2e-deploy` 的端口 TOCTOU flake**（本轮跑全链时当场撞上）。
`freePort()` 是「`listen(0)` 探到端口 → `close()` → 子进程再 `bind`」，两步之间那个临时端口
可能被系统分给别的连接 —— 实测报 `EADDRINUSE: ::53174`，而症状被包成**「示例进程启动即退出」**，
读起来像示例或实现坏了。修法：新增 `startExampleRetrying()`，**只对端口争用**换端口重试（3 次），
其他启动失败原样抛出（不许被重试掩盖成「多试几次就好」），并在诊断里点明是端口占用。
**证明**：占住一个端口 + 把 `freePort()` 注入成第一次返回它 → 观察到位「端口 45999 被占用
（TOCTOU 抖动），换端口重试」→「换到端口 53242 后启动成功」→ `E2E-DEPLOY PASS`。
⚠️ 这条**没有**仓内守卫（要有就得把「制造端口冲突」的注入器写进脚本，不值），靠 e2e 自身运行覆盖。

- 2026-09-15：**全量评审修复轮（预算透传 / 策略按 run 隔离 / 装配期校验与观测面修正）**。
  本轮以「护栏要在嵌套结构里同样成立」与「启动期响亮失败」两条主线收口，语义变更**在此锁定**：
  **① 成本护栏真透传子循环**：`ToolRunContext` 新增 `maxTotalTokens` / `maxCostUsd`，
  `@SubAgent` / `@Skill` 的子循环经 `runAgentScoped` 拿到同一份上限 —— 各级循环共享同一
  recorder 的累计账单，**每回合各自检查**；子循环超限以 `budget_exceeded` 收尾（该次能力调用记
  `is_error`，capability span 上记 `budget.exceeded` 事件），主循环在下一回合**入口**再判一次、
  不再发出新请求，整条 run 以 `budget_exceeded` 收尾。旧实现子循环拿不到上限，护栏在子循环
  期间整体离线（最坏多烧一整个子 run）。**两处同轮取舍**：超预算的回合仍照常处理
  `submit_result`（纯内部的结构化提交、零副作用 —— 模型已把最终结果交出来，连同回合丢弃等于
  白烧这一回合，与「自然收尾不因超预算改判失败」同口径）；同回合**并行**多个 `submit_result`
  先到先得（首个校验通过的生效），不 guarded 则 `typed` 由并发完成顺序竞态决定。
  **② `ContextPolicy.forRun?(): ContextPolicy`（可选契约）**：引擎每条 run 开始调一次拿
  **本 run 专用**的策略实例；`createBudgetPolicy` 已实现（滞回计数与增量 token 缓存都是
  per-run 状态 —— 不隔离会让「run A 刚压缩过」卡住「run B 前 compactEvery 回合不压缩」，
  并发 run 还会互相打回计数缓存）。不实现的自定义策略按**单例复用**（状态跨 run 共享，
  注释已写明后果自负）。
  **③ per-run `tools` 覆盖过同一条中间件链**：`AgentApp.run` 对 `opts.tools` 现包一次装配期
  那条链（`wrapTools`）—— 此前是旁路，per-run 覆盖会绕开鉴权/限流/审计，与 2026-09-11 修复的
  「子 agent 绕过中间件」同族。
  **④ 能力名装配期校验**：四类装饰器能力名（`name` 或缺省的方法名）必须匹配
  `^[A-Za-z0-9_-]{1,64}$`（与 MCP 桥同口径），非法名 `createApp` 即抛错 —— 含空格/点/中文的
  名字会让模型 API 400，「首次模型调用才暴露」不如启动期拦住。
  **⑤ metricsSink 渲染修正**：分位 gauge 改名 `*_duration_ms` → `*_duration_ms_last`
  （histogram 保留原名 —— 同名指标只允许一种 TYPE，混发会被 expfmt 判硬错误、整次 scrape
  失败）；`render()` 每个指标家族只发一次 HELP/TYPE（此前同家族多 label 样本各自带家族头，
  同样是硬错误）；label 值做 `\` / `"` / 换行转义（含引号的能力名此前会损坏整页 exposition）。
  **OTLP 侧**：成本指标走 `asDouble`（asInt 是 int64 字符串编码，塞浮点会被 collector 整批
  拒收）；histogram `bucketCounts` 改**非累积**（OTLP 语义；Prometheus 文本的累积语义不变）。
  **⑥ `OtlpExporterOptions.timeoutMs`**（缺省 10000，非正数 = 不限）：裸 fetch 没有超时，
  collector 半开连接会让 run 收尾永久挂起；超时按导出失败处理（上层吞掉，不击穿 run）。
  `MetricsSinkOptions` 同款 `timeoutMs`（同缺省同语义）—— metrics 的 OTLP flush 此前也是裸
  fetch，`intervalMs: 0` 模式下会被同样吊住。
  **⑦ `RedisLike.set` 改位置参数形态** `set(key, value, 'EX', seconds)`：对象形态 `{EX}` 是
  node-redis **独有**，ioredis 会把它字符串化成 `"[object Object]"` 发给服务端（报语法错）；
  位置参数形态两者通吃（node-redis v4 保留 legacy 变参）。`RedisSetOptions` 保留导出但已
  `@deprecated`（不破坏公共面）。不设 TTL 时**只传两参**（显式 undefined 会被 ioredis 序列化
  成空串参数）。
  ⚠️ **本条判断已被更正** —— 「位置参数形态两者通吃」是**错的**：node-redis 的 `SET` 只声明
  三个形参，位置参数会被**静默丢弃**。更正与证据见下方 `### 2026-09-15（发布后更正）`。
  **原判断与理由保留在此，不改写**（谁在什么时候为什么想错了，比一个干净的结论更有用）。
  **⑧ 构造期校验补齐**：`AsyncRunner` 的 `runTimeoutMs` 必须 ≥ 0 的**有限**数（NaN/Infinity
  都会被 `setTimeout` 钳到 1ms，等于每个任务立即超时）；`createHttpHandler` 的
  `maxConcurrentRuns` 必须 > 0 或 Infinity（NaN 会让并发闸门静默失效、0/负数全部 503）。
  **⑨ drain 强制关 SSE 连带 abort run**：只 close 不 abort 时 `res.end()` 让
  `writableEnded` 同步变 true，断连守卫（`!writableEnded` 才 abort）永不触发，run 会在后台
  继续烧 token（实测复现）——收口函数现在先 abort 再 close。
  **⑩ OpenAI 流式两处假成功收口**：流中 `error` 分片（上游把故障塞进 200 的流）即抛错；
  流「正常」结束却无文本无 tool_calls 同样抛错 —— 不再静默映射成「`end_turn` + 空文本 +
  usage 全 0」的成功空回复（与非流式空 choices 守卫同口径）。
  **顺带（语义收紧，各带用例）**：`max_tokens` / `pause_turn` / `max_iterations` 收尾补结构化
  `error`（此前这类 run「失败却没有原因」）；`onText` / `onRetry` 回调抛错被吞（观测是辅助
  动作，与 `onUnpricedModel` 同口径）；`TraceRecorder.snapshot()` 浅拷 span 的
  attributes/events（交付后仍在记账的残尾不再事后变异已交付的 trace），`totalUsage.costEstimate`
  与 capability 聚合统一 1e-6 美元取整口径；schema 校验 `in` → `Object.hasOwn`（原型键
  `constructor`/`toString` 不再被当成「已声明」）；`FileTaskStore.compact()` 改临时文件 +
  rename 原子重写（写崩不丢旧文件）；`combineSignals` 补 `releaseCombinedSignal()`（run 正常
  收尾时摘掉挂在长寿源 signal 上的监听器，不再按任务数累积触发 MaxListenersExceededWarning）；
  MCP 工具名**归一化后为空**（原名不含任何 ASCII 字母/数字/下划线，如全 emoji）显式抛错
  （此前只剩前缀也能注册成功）；静态 `@Prompt` 沿构造函数原型链收集（父类静态资产不再静默
  丢失）；`.env` 的 `__proto__` 键显式抛错（会走原型 setter 被静默吞掉）；`discover` 入口
  候选按序回落（`.ts` 加载失败回落 `.js` 并 warn —— 命中的可能是陈旧编译产物）；`asset()`
  拒绝带 scheme 的 rel（`file:`/`https:` 会让 base 被整个忽略；`../` 越出能力目录有意放行）。
  **门禁**：`scripts/e2e-deploy.ts` 新增并挂进 `npm run e2e`（第三步：examples/deploy 真构建、
  真起服务、崩溃续跑）—— `examples/deploy` 此前与 complete 同款「文档说可跑、无门禁真跑」。
  CLI：`dev`/`add` 支持 Windows（`npmBin` 的 `.cmd` 处理）；CLI build 自给自足
  （copy-assets 在 trace-view 未构建时就地补跑，`prepublishOnly` 只跑 build）；
  inspector 加 Host 头校验（非 localhost 403）与 trace 入站校验。
  layering 守卫加强：解析覆盖 from/副作用/动态 import 字面量三种形式，带解析计数下限护栏
  （防解析器空转 vacuously 变绿），BARREL 豁免只认 `src/index.ts` 本身（src 根下新文件不再
  白嫖豁免），`ALLOWED.eval` 补 BARREL（与 AGENTS.md「依赖 toolkit 与公共面」对齐）。

- 2026-09-16：**R7 质量闭环落地（score 一等公民 / gen_ai 对齐 / 回流 / 版本与 session 上 trace）**。
  设计取舍**在此锁定**：
  **① Score 契约与事件形态**：`Score { name; value; source?; comment? }`（value 约定 0–1，
  布尔结论用 0/1）+ `attachScore(trace, score)`，两者公共导出。评分挂 run 根 span 的
  **`score` 事件**（body 即 Score）而**不是 span 字段** —— 评分来自 run **之外**（run 跑完
  才由 LLM-judge / 人工 / eval 产生），span 字段在收尾时已定型，事件是「事后补充事实」的
  现成通道；多次调用即多条事件（不同维度各记各的），找不到根 span 静默忽略（观测不击穿业务）。
  **② gen_ai 对齐钉 v1.37 基准、映射集中单模块**：OTLP 导出 **additive** 追加 `gen_ai.*` 键
  （旧 `usage.*` 键一律保留 —— 既有看板/告警已消费它们，双发成本极低）。选 v1.37 是因为该版
  `gen_ai.client` 侧（chat / execute_tool / request.model / usage.*）已 stable，agent 侧
  （invoke_agent / agent.name / conversation.id / evaluation 事件）仍 experimental —— stable
  键优先、experimental 键补齐 agent 语义，下游（Datadog / Axiom 等）已按 1.37+ 识别这批键。
  约定仍在漂移（此前 v1.37 就把 `gen_ai.system` 改 `gen_ai.provider.name`），故**全部映射集中在
  `otlp.ts` 的 `genAiAttributes` / `mapEvent` 两处**，升级基准版本只改本模块。`score` 事件译为
  `gen_ai.evaluation.result`（维度名用 semconv 的 `gen_ai.evaluation.name`，**不是** `gen_ai.evaluation.score.name` —— 后者不存在）；`source` / `comment` 是 semconv 未定义的维度，走自有
  `agentia.score.*` 键，不占用 gen_ai.* 命名空间。
  **③ `prompts.versions` 拼接形态**：`PromptSpec.version` 声明后，装配期沿主菜单同一条收集路径
  （`toolSources` 收窄同样生效）收集 `{ 最终菜单名: 版本 }` 表，engine 拼成 **`name@ver` 逗号串、
  按名排序**落 run 根单个 attribute（对照先例 `system.version`；排序让同一菜单的产物字节一致、
  可直接做等值筛选），**空表不记**（不写空串冒充实有版本，与 `system.version` 同口径）。
  内核 `collectPromptEntries` 收「工具 + 版本表」两份，是 **module 级 export 不进公共面**；
  `collectPrompts` 公共签名不动。
  **④ session.id 上 trace**：`executeRun` 给了 `session` 就自动把 id 写进 run 根 `session.id`
  attribute（OTLP 侧映射 `gen_ai.conversation.id`，thread 维度聚合），不用手填。
  **⑤ defineEval 自动 score**：每个用例跑完把 `{ name:'eval', value:0|1, source: eval 名,
  comment: 失败原因 }` attach 到该用例 trace —— eval → trace → 监控一次打通；`app.run` 抛错
  （环境错误）拿不到 trace 时不挂。
  **⑥ harvest 刻意不进公共面 + CLI 双实现对拍**：`harvestEvalCase`（trace → eval 用例 TS 骨架）
  是 **module 级 export**（进公共面就得为「生成代码字符串」这种工具性 API 长期背书，且
  `tests/docs/api-page.test.ts` 的反向全覆盖会逼官网同步）。CLI `agentia harvest` 侧是
  **去类型移植副本**：CLI 零运行时依赖不能 import 框架，而构建期拷贝会让 CLI build 依赖框架
  dist 的存在、复杂化 publish 流程 —— 双实现是有意决策，由 `packages/cli/test/harvest.test.mjs`
  的**逐字对拍**守护（改生成格式必须两边同步）。已知边界如实写进生成物注释：trace 不记
  assistant 文本（脚本 text 块是占位）、只重建主循环回合、预填 expect 是抄录的实际轨迹。
  **⑦ 在线评估采样**按调研结论落为 **recipe**（usage-guide §6：sampleSink + judge + attachScore
  + metricsSink 拼装），不进框架 —— 评什么、采样率多少是业务策略，与「护栏/配额只给缝」同口径。

- 2026-09-16：**trace diff 与分叉重放落地（`diffTraces` / `forkMessages`）**。
  设计取舍**在此锁定**：
  **① trace diff 落 `diffTraces(a, b, opts?)`（engine，纯函数，公共导出）**：不发起请求、
  不改 trace，产出 `TraceDiff { equal; summary; spans }` —— run 级 summary（status /
  totalUsage.* / 根 span attributes）+ 逐 span 字段级差异（`SpanDiff { path; a?; b?; fields }`，
  字段差逐条 `DiffEntry { field; a; b }`）。**配对键决策**：llm.turn 的配对键**只有 kind、
  忽略 name** —— name 是模型 id，而「换个模型重跑」正是 A/B 主用例，按 name 配对会把两侧
  所有 turn 都报成缺失；模型差异降格为配对 turn 的 `name` 字段差。capability span 按
  `kind:name` 配对（`skill:foo` vs `skill:bar` 是不同能力，不该配上）。同键孩子按 startedAt
  稳定排序后按下标一一配对；**缺侧子树不下钻** —— 一条缺侧 SpanDiff（fields 为空、path 照给）
  即代表整支。**默认忽略墙钟**（`ignoreTiming` 缺省 true：span startedAt/endedAt、event time
  缺省不比；`false` 时改比 span 时长 endedAt-startedAt，绝对时间戳永不比）；traceId 是身份
  不是行为，永不比。**根 attributes 差同时进 summary（第一眼视图）与根 SpanDiff（完整视图），
  重复是有意的** —— A/B 模型第一眼就看 `attributes.model`，而完整下钻视图不该少这一块。
  **② 分叉重放落 `forkMessages(trace, { atTurn, append? })`（公共导出）**：在主循环第 N 回合
  （0-based）之前截断，只重放分叉点前的真实历史，再拼上调用方给的新消息（通常是改写过的
  新 user 消息）。锚点 = **主循环回合**（`parentSpanId === rootSpanId` 的 llm.turn，子 agent
  嵌套回合不算 —— **与 harvest 口径一致**），越界抛可读错误（带回合总数）。**不做「真续跑」**：
  trace 不记 assistant 文本 / run 原始输入 / blackboard —— 产物是喂回 `app.run` / `runAgent`
  的 messages（assistant 文本为标注占位、首尾说明性 user 为合成），跑的是一条**新 run**，
  不是接着原 run 的循环位置；黑板的分叉种子由调用方经 `RunInvocationOptions.blackboard` 自带。
  **③ 为什么不做图形 diff / UI**：对照 R7 调研结论（不建看板 / CMS，框架内建 trace + 零后端
  导出）—— diff 给**结构化数据**（`TraceDiff`）与命令行出口即可，渲染复用既有 trace-view /
  inspector 生态，不新建 diff 看板。
  **④ CLI `agentia diff`（同批落地）**：trace.jsonl 直比，
  **有差异时 exit code 1**（diff(1) 语义，可直接进 CI 挡「换 prompt 后轨迹漂移」）；实现按
  harvest 同模式 —— CLI 零运行时依赖不能 import 框架，故为**去类型移植副本 + 逐字对拍**守护
  （改 diff 语义必须两边同步）。
- 2026-09-16：**canCall 能力级能力边落地（`token/能力名` 路径语法）**。`SubAgentSpec.tools` /
  `SkillSpec.tools` 的元素此前只能是 provider token（整片菜单引用）；现在同时接受
  `'<provider-token>/<能力名>'`，只引该 provider 菜单里的单个能力。决策：**字符串路径语法**
  （不引入对象形态）—— 类型 `string[]` 不变、向后兼容，能力名经 collect 校验不含 `/`
  （`^[A-Za-z0-9_-]{1,64}$`），按第一个 `/` 切分无歧义。校验在**装配期**（createApp 即抛）：
  token 未注册沿用原文案（既有测试锁定），能力名不存在则报错并附**排序后的可用名单**；
  可用名单与运行时菜单同口径（@Tool + 该 provider 的 skill/subagent/prompt 工具四份合集
  —— 只用 @Tool 菜单会误拒 `'skills/helper'` 这类合法点名，校验面与解析面必须一致）。
  解析从 `wrappedByToken`（**中间件包装后**的菜单）按名 filter —— 嵌套能力绕不过中间件，
  2026-09-11 R1 的防绕过教训对本路径同样成立（该日条目用字母编号，没有圈号 —— 此处原文误写
  「①」，与本文档前面「见 §10 2026-09-11 R1 条」自相矛盾）。粒度收窄全部发生在装配层产出菜单时，
  engine 分发点零改动。MCP 裸工具仍不可被引用（没有 provider token，边界不变）。

- 2026-09-17：**默认 client 自研化落地 —— fetch + SSE 手写实现，engine 对 SDK 零运行时 import**。
  `integrations/anthropic.ts` 手写 `POST {baseURL}/v1/messages` + 逐行 SSE 组装，**不再实例化
  `@anthropic-ai/sdk`**；引擎经 `createAnthropicClient()` 取默认 client，使用者自定义只传
  `apiKey` / `baseURL`，不必直接依赖该 SDK（2026-09-13「未做」两半中的前半落地）。
  **错误分类随之改为鸭子类型**：`engine/errors.ts` 不再 `instanceof` SDK 错误类，改认数值
  `status`（429→rate_limit、5xx→server、其余 4xx→api）、带 `cause` 的 TypeError / errno `code`
  （→connection）—— 反转 2026-09-13「不做鸭子类型」的结论：当日实测的「SDK 错误类 `name` 恒为
  `'Error'`、`type` 为 null、靠 `constructor.name` 压缩即失效」此时不再是拒绝鸭子类型的理由，
  反而是**必须只认数据属性**的理由（自研 client 抛的是自有 `AnthropicApiError` 与 fetch 原生
  网络错误，同套判法对第三方 SDK 错误同样适用）。已知边界：SDK 的 `APIConnectionError` 无
  status/code 可判，若使用者自装 SDK 并让它抛到引擎，该类错误落 unknown（该重试的不再重试）。

- 2026-09-17：**公共类型自有化落地，`@anthropic-ai/sdk` 退出运行时依赖（零运行时依赖达成）**。
  新增 `src/core/message.ts` 自有消息类型族（请求侧 `MessageParam` / `ContentBlockParam`
  （text / image / tool_use / tool_result + 兜底）/ `ToolParam`，响应侧 `Message` /
  `ContentBlock`（text / tool_use / thinking + 兜底）/ `MessageUsage`），字段口径与 SDK
  逐字对齐（snake_case）。**这条是 2026-09-13「依赖形态 = 纯 dependencies」结论的反转与消解**：
  当日论据①（公共类型面直接用 `Anthropic.MessageParam`，用户必须装 SDK）因类型自有化不再成立，
  SDK 随之从 `dependencies` 移入 `devDependencies` —— 留下的唯一理由是类型兼容门禁
  （`tests/types/message-compat.types.ts` 钉双向/单向 assignability：SDK 的
  `MessageParam` / `Message` / `TextBlockParam` / `ToolUseBlockParam` / `ToolResultBlockParam` /
  `Tool` / `CacheControlEphemeral` → 自有类型整体可赋；自有具体块可赋回 SDK；
  `@ts-expect-error` 钉住「兜底块不回赋 SDK 精确联合」等不该过的方向）。配套决策：
  ① **命名避让** —— `Tool` 已被 @Tool 装饰器占用、`Usage` 已被 trace 聚合用量占用，
  消息侧对应物命名 `ToolParam` / `MessageUsage`；
  ② **兜底成员是 `{ type: string }`，刻意不带索引签名** —— 实测 SDK 的块类型全是
  interface（无隐式索引签名），带 `[key: string]: unknown` 的兜底会让
  「SDK `MessageParam[]` → 自有 `MessageParam[]`」整体赋值编译失败，方向一承诺当场破产；
  只有 `type` 的最小面两个方向都通，未知块原样携带（读字段自行收窄）；
  ③ **`Role` 含 `'system'`** —— SDK 0.124 的 `MessageParam.role` 逐字如此，
  方向一要求对齐（引擎自身只产出 user/assistant）；
  ④ **`tsconfig` 显式 `"types": ["node"]`** —— 全仓 `@types/node` 此前竟是靠
  「import SDK 类型 → SDK internal/types.d.mts 引 undici-types → `/// <reference types="node" />`」
  这条传递链偶然进编译程序的，移除 SDK import 后全局类型（AbortSignal / process / setTimeout…）
  整片消失（117 个错误）；显式声明后这条隐性依赖被根除。
  实证：`npm pkg get dependencies` 输出 `{}`；`e2e:live` 真端点 6/6。
- 2026-09-17：**外部 review 驱动的修复批**（DeepSeek 通读全仓后的指认，逐条核实后修）：
  ① **CLI Windows 支持修复** —— `npmBin` 只加 `.cmd` 后缀，CVE-2024-27980 后裸 spawn `.cmd`
  直接 EINVAL（「dev/add 支持 Windows」曾是超前宣称）。改 `npmSpawn`：win32 走
  `cmd.exe /d /s /c` 包装 + 逐参数脱敏（cross-spawn 算法；不用 `shell: true`——它把参数
  空格 join 零转义，`add` 的包名/路径是用户输入，含 `&` 即成命令注入）；非 win32 原样直传。
  ② **doctor import 识别**不再只认 default import（named / namespace / 别名 / 双引号 / 跨行
  都认）——此前这些形态命中「无法定位 import，跳过」，悬空条目**漏检**（静默跳过）。
  ③ **脚手架模板纳入类型检查**：e2e-cli 新增 4c 步（生成项目在临时目录跑真 `tsc`，
  `@migor/agentia` 解析到 dist .d.ts 即发布形态）——此前模板类型错误要等用户
  install 后才暴露。折进既有 e2e 步骤，不加 verify-all 第 9 步。
  ④ **对拍守护排响**：`distReadyOrLoud` —— 产物缺失时本地醒目横幅 + skip（裸跑场景），
  CI 里（产物恒在）直接判失败；harvest 对拍升到 diff 同款（六组夹具逐字相等），
  report/templates/inspector 的静默 skip 同批消除。
  ⑤ **agentLoop 拆分（纯重构，零语义变更）**：433 行循环体拆成 8 个有名字的函数
  （编排骨架 82 行），教训注释随代码块搬迁；全部 699 例测试一行未改全绿 +
  e2e:live 6/6 复验。
  ⑥ **官网对外口径**：正文链接默认蓝 → 主题色（--ice）；playground 两处单价
  {3,15}/{0.8,4} 对齐 usage.ts 真源（{5,25}/{1,5}）；playground-real 的「trace 原样
  产物」措辞改诚实（浏览器侧按 trace 形状构造的演示数据）；docs 页补 h1。
  ⑦ **文档对账**：spec 标题去「v0.1 草案」（规范快照 vs §10 时间线的阅读口径写明）、
  §9.4 replay「不进 v1」等过期断言改写为现状、被取代条目按体例加标注不改写历史。
  未采纳项及理由：`agentLoop` 未拆新文件（动分层 ALLOWED 集合，收益不抵成本）；
  executeOneTool 的 submit_result 分支未再拆（共享局部态）。

- 2026-09-17：**第四轮 review（文档面 + 边界条件）**—— 逐条回源码核实后修，全部带回归用例：
  ① **`app.run` 补 `memory` 选项**（公共 API 增项，非破坏）：`RunAppOptions` 与实际能力不一致 ——
  官网 `docs.html` 与单源 `usage-guide.md` 都写 `app.run(messages, { memory })`，而该字段只存在于
  `ExecuteRunOptions`；`session` 早已转发、`memory` 漏了，属漏项而非设计取舍（两者同为
  「store 实例不可序列化 ⇒ 只在程序内可用」的边界）。修法 = 按 `session` 同款转发 + 用例
  `tests/runtime/memory.test.ts`（水合 + 回写两条断言，变异自证：去掉转发即红）。
  ② **`compactMessages` 回退边界差一**：`while (cut > 1 …)` 在「工具对的 `tool_use` 在索引 0、
  且 `length === keepRecent + 1`」时停于 `cut = 1` ⇒ 摘要吃掉 `tool_use`、尾部留孤立
  `tool_result`（且与摘要构成连续两条 `user`），下一次请求 400 —— 两条都违反该函数自己的
  docstring 承诺。**行为变更**：这种历史改为**放弃压缩、原样返回**（宁可少压一次）。
  ③ **CLI 错误路径三处**：`create` 撞同名普通文件从裸 `ENOTDIR` 栈改为可读报错；
  8 个子命令支持 `--help`（此前被当成文件名去读，且用法串三处重复 → 收成常量单源）；
  `harvest --out` 默认**拒绝覆盖**已存在产物（新增 `--force`）——产物是人工核对的脚手架，
  静默覆盖等于毁掉那份人工成果。
  ④ **文档面形状守卫**：新增 `tests/docs/run-output-shape.test.ts` —— `.finalText` 的接收方
  必须是 `result`（`AgentRunOutput = { run, result }`）。这类手写代码片段此前**没有任何门禁**
  （api.html 只被表格守卫盯着），两处 `out.finalText` 因此活过多轮全绿；`api-page.test.ts` 的
  行匹配器同时放宽（带属性的 `<tr>` 不再整行静默跳过）。
  证据：6 处修复各配一条回归用例，**变异电池 6/6 咬人**（逐条改坏 → 只跑对应用例 → 全红）；
  全链 `verify-all.sh` 8/8。

- 2026-09-17：**第五轮 review（全覆盖缺陷清扫）** —— 三轮子代理候选逐条回源码 / 探针核实后修，
  三条 MAJOR **同时**实证 + 修好 + 加真路径用例：
  ① **`app.run` 漏转发 `signal`**（`RunInvocationOptions` 17 个字段只漏这一个；TS 因继承不报错）：
  HTTP 断开 / `drain` / `AsyncRunner.runTimeoutMs` 三处取消静默失效。根因是**「假边界挡住真边界」**：
  三处宿主测试都用**假 app** 断言「signal 交到了 app」，真 `AgentApp` → engine 那一跳无人测。
  修法：补 `signal: opts.signal` + 用例（已中止的 signal ⇒ `aborted` 且不打模型）。
  ② **OTLP `spanId` 宽度**：两种 id 共用一个 `hexId`（32 hex），而 OTLP 要求 span id 16 hex。
  修法：`traceHex` / `spanHex` 分开；既有用例把错宽度写成了期望，一并纠正。
  ③ **OTLP 能力 span 的 `gen_ai.*` 从未发出**：按 `name.startsWith('subagent:')` 判类型，
  而生产是裸名 + `attributes.subagent` / `skill`（另三个消费者都读 attributes）。**错形状还被抄进
  四处测试夹具**（otlp / harvest / tracer / trace-diff），所以一直是绿的。修法：改读 attributes +
  夹具改生产形状。同一批还修了 `gen_ai.evaluation.score.name`（不存在，应为
  `gen_ai.evaluation.name`，以真 semconv 包取键名证据）、`costEstimate` 原型链 → NaN、
  `mcpTools` 的 description 类型防御与 `mcp.tool.<菜单名>` 并行不覆盖、
  `combineSignals` 同源去重、`session.append` 展开传参、`harvest` 缺 tool 伪造 `unknown` 与注释注入、
  `replay` 数组型 input。
  证据：13 处修复**变异电池 13/13 咬人**（含一次「M12 没咬住」→ 查出是**我的用例断言写错**，
  改成按行首判后咬人）；`verify-all.sh` 8/8；派生产物同一 sha。
  **教训（写进本仓库口径）**：凡「宿主/消费方测试用假实现」的边界，必须有一条走**真实现**的用例 ——
  三条 MAJOR 全部活在这类缝里。

### 2026-09-17 ①：MCP 超时**单源化** —— 一次调用只有一个裁判（桥不再自判）

**背景**：`engine/concurrency.ts` 的 `withTimeout` 自 2026-09-14 ②（本文件）起是「不看竞速、只看实测耗时」
的硬保证；但同一判定在 `src/integrations/mcp.ts` 里有**第二份实现**（`withDeadline`，纯 `Promise.race`），
而 ② 那次收紧只改了 engine 那一份（`git show --name-only 1ceb372` 的文件清单里**没有** `mcp.ts`）。

**取证（先证再改，三档）**：

- **确定性构造**（② 证明 `withTimeout` 有病时用的**同一个**构造：预算 20ms、工具 5ms resolve 后在同一回调里
  同步阻塞 30ms）：桥返回 `'late'`（= `ok: true`，实测 wallMs **79**）、engine 返回 `TIMED_OUT`
  ⇒ **超预算的调用被记成成功**。
- **800 次扫描（8× CPU 超订）**：`预算20/工作20` 一档 **桥 800/800 记成功**（样本 elapsed 20/21/22 > 预算），
  同档 engine 799 超时 + 1 次 19ms 合法返回；`预算20/工作21` 两实现都 800 全超时；3× 余量档 **0/800 未复现**
  （与 ② 记的 1/1200 稀有度一致）—— **不据此下结论**。
- **真引擎路径**（`runAgent` + `mcpTools`，读 trace 的 `tool.output`）：
  `引擎20/桥20/工作20` → 40/40 `errorKind=timeout`；**`引擎20/桥20/工作21` → 40/40 `threw` + `error(unknown)`**；
  `引擎5000/桥20/工作21` → 40/40 `threw`；`引擎20/桥5000/工作21` → 12/12 `timeout`；
  `引擎不限/桥20/工作20` → 40/40 `ok:true`（durationMs 21）
  ⇒ **同一个物理事件，账目取决于「谁先到」**。

**根因**：同一个承诺两份实现，且桥那份是竞速判定；engine 的 catch 又把桥的普通 `Error` 交给 `classifyError`，
而它**没有 timeout 这一类** ⇒ 同一事件裂成 `timeout` / `threw`+`unknown` 两种账。常见配置
（引擎预算 ≤ 桥预算）下 engine 的实测耗时兜底**掩盖**了桥的缺口，这正是它一直没被发现的原因。

**决定**：

1. **原语单源**：`TIMED_OUT` + `withTimeout` 下沉到 `src/core/timeout.ts`（core 是叶子、零 import，且
   `integrations` 只能依赖 core ⇒ 落点唯一）；`engine/concurrency.ts` **原样再导出**，`turn.ts` 与既有测试零改动。
2. **一次调用只有一个裁判**：`ToolRunContext` 新增 `toolTimeoutMs`（engine 在 `executeOneTool` 注入）；桥在
   「引擎设了预算」时**不再启动自己的计时器**。`McpToolsOptions.timeoutMs`（缺省 60000）退化为**兜底**，
   只在「桥脱离引擎单用」或「引擎没设 `toolTimeoutMs`」时生效。
3. **超时是一类账**：新增 `TimeoutError`（`code='timeout'`）与 `isTimeoutError`（认鸭子类型）；引擎的工具级
   catch 把任何 `code==='timeout'` 的错误记成 `errorKind='timeout'` + `error(timeout): …`。对使用者可见的
   契约是 **`code` 字段**，不需要 import 那个类。
4. **兜底路径也用硬判定**（不是只搬代码）：桥的 `withDeadline` 变成共享原语的薄封装 —— 同一条实测耗时规则
   对两条路径都成立，不存在「哪条路靠运气」。

**代价（如实记）**：

- **行为变更 1**：引擎设了 `toolTimeoutMs` 时桥的 `timeoutMs` **不再生效**（即使桥更短）。「谁短谁生效」
  作废 —— 想收紧某个 MCP server 的时限请设 `toolTimeoutMs`。
- **行为变更 2**：桥自判的超时从 `errorKind='threw'` + `error(unknown)` 变为 `errorKind='timeout'` +
  `error(timeout): MCP 工具 "x" 调用超时（超过 20ms）`。**按 `errorKind` 分流看板的查询需知悉。**
- 边界语义收紧（同 ②）：耗时刻到预算即算超时。

**门禁**（均为**确定性**构造，不拿余量赌概率）：

- `tests/core/timeout.test.ts`（新）：共享原语直接单测（哨兵区别 `undefined` / 非正预算透传 /
  `TimeoutError.code` / `isTimeoutError` 只认那一个 code）。
- `tests/integrations/mcp.test.ts`：兜底超时**记 `errorKind=timeout`**（旧断言只看了 `ok=false` 与文案）；
  「单一裁判」两条（引擎 5000 + 桥 20 ⇒ 必须成功；引擎 60 + 桥 5000 ⇒ 记引擎的账与文案）；
  **兜底路径的确定性构造**（resolve 后同步阻塞越过截止 ⇒ 必须记超时）。
- `tests/engine/toolTiming.test.ts`：工具抛 `code='timeout'` ⇒ `errorKind='timeout'`。
- **变异电池 7/7 咬人**：桥不交出裁判权 / 桥退回纯竞速 / 去掉实测耗时兜底 / `isTimeoutError` 恒 false /
  引擎不认自判超时 / 不注入 `toolTimeoutMs` / 桥丢掉 `code` —— 每条都指名了变红的用例。
- **顺序**：既有 39 条（concurrency / toolTiming / mcp / timeoutLiveness）在**单源化那一步之后**先跑一遍全绿
  ⇒ 证明「提取零行为变化」，**然后**才做行为变更（两件事分开验，免得把重构错判成回归）。

**未坐实 / 未做（如实标注）**：

- 3× 余量下的桥翻转未复现（0/800）；本条证据是确定性构造与边界档，不依赖它。
- 「同批到期、计时器表顺序决定谁先」仍是**假说**（② 同样保留）。

### 2026-09-17 ②：超时是**自己一类** —— `errorType` 由 `connection` 改为 `timeout`

**先更正记录**：① 里那条「`classifyError` 仍不认 `timeout` ⇒ 模型调用超时在 `span.error` 上是
`type:'unknown'`（不可重试）」**整条写错了，已删除**（不写修正版）。事实相反 —— `engine/errors.ts` 的
`isConnectionError` 有一条专门认 `name === 'TimeoutError'` 的判据（注释写明就是给 `AbortSignal.timeout` /
默认 client 的超时合成信号用的）⇒ 超时一直落 `type:'connection'` + `retryable: true` ⇒ **缺省就在自动重试**。

**证据（端到端，不是读判据）**：真路径 `runAgent` + 真 trace，第一次尝试抛
`DOMException('Anthropic 请求超过 100ms', 'TimeoutError')`、第二次成功：

```
calls=2   onRetry=[{attempt:1, type:'connection', retryable:true}]
turnCount=2  turnStatuses=['error','ok']   最终 end_turn + finalText='重试后成功'
firstTurnError={type:'connection', message:'Anthropic 请求超过 100ms', retryable:true}
```

**为什么误判**：只读了 `classifyError` 的 status 分支与 `instanceof Error` 兜底，漏读了下面
`isConnectionError` 的第三条；而且断言「这条行为没有用例守着」时用的 `grep … | head -12` 把
`tests/engine/errors.test.ts` 的匹配**截断**了 —— 那条断言就在那里（「无 status 的网络型错误」条目的最后
一段，钉的是 `TimeoutError → connection`）。**「我没看到」不等于「不存在」。**

**决定**：超时不再混进 `connection`，它是自己一类。

1. `core/timeout.ts` 的 `isTimeoutError` 扩成三条判据（**全是鸭子类型**）：框架 `TimeoutError` 实例 /
   `code === 'timeout'` / `name === 'TimeoutError'`（内建 DOMException 的规范 name）。分类与工具级记账
   共用同一条判据，口径一致。
2. `classifyError` 新增显式分支 → `{ type: 'timeout', retryable: true }`；`isConnectionError` 里原来的
   TimeoutError 判据**删除**。分支放在 status 分支**之后** ⇒ 带数值 status 的错误仍优先按状态归类
   （优先级与改动前逐字一致）。
3. **`retryable` 保持 `true`**：超时一直是可重试故障，本单**不改重试行为**（缺省 `maxAttempts=3` 照旧），
   只改记账口径 —— `span.error.type` / `trace-diff` / 看板现在能把「超时」与「连不上」分开。

**代价（如实记）**：**`errorType` 取值变更** —— 按 `span.error.type` 分流的看板 / 告警，超时类会从
`connection` 变成 `timeout`；`trace-diff` 比对旧 trace 时超时显示为「类型变了」。**重试行为不变。**
`tests/engine/errors.test.ts` 里那条旧期望（`TimeoutError → connection`）是**有意改掉**的（错的契约被钉成了
期望），被改坏的原断言与理由写在用例注释里。

**门禁**：`tests/engine/errors.test.ts`（超时三类形态同判 + status 优先级不变）、
`tests/engine/retry.test.ts`（缺省 `isRetryable` 认超时）、`tests/engine/loop.test.ts`（端到端：
超时 → 重试 → 成功，断言 `onRetry`、两个 turn，且失败 turn 的 `error.type='timeout'`）。

### 2026-09-17 ③：发版面**单源化** + 闸门扩到全发布面；tag 体例回到 annotated

**先更正一处错**：本仓库的发布约定一直写「这四个同步点」与「发版步骤：bump 四处」。**「四处」是错的** ——
刚发布的 v0.6.1 一次 bump 真实动了 **17 个文件**，而漏点全在「四处」之外：`examples/` 的 `^旧版` pin
（含两个 Dockerfile **注释**里那份）、`.github/ISSUE_TEMPLATE/bug_report.yml` 的版本占位、README 版本行、
`docs/roadmap.md` 状态行、`docs/spec.md` §11 进度链、CHANGELOG 的 compare 基线与链接引用、
`package-lock.json` 的 4 个 version 字段。这些不是假想风险：上一次发版就出现过「只在 README 改了 pin、
Dockerfile 注释没改」，lock 的 version 字段也整轮跳过而全链全绿。

**决定**：

1. **发布面清单单源**：`scripts/release-surface.mjs` 定义 18 项替换面（每项带 `count` 期望值与「漏了会
   怎样」）+ 3 项结构面（本版**必须新增**的：CHANGELOG 条目、CHANGELOG 链接引用、spec §11 链段）。
   `--list` 给人看、`--json` 给测试。闸门与 bump 共用这一份，免得「闸门认一套、bump 又认一套」。
2. **闸门扩到全发布面**（`scripts/check-release.mjs`，仍挂两包 `prepublishOnly`）：除原有的发布面一致性
   与「必须高于 npm 已发布版本」，新增「本版 CHANGELOG 条目存在且不是空骨架」。命中口径是「一个匹配里的
   **所有**捕获组都等于版本号才算命中」—— lock 里那 343 个第三方版本号一个都不算。
3. **`scripts/release.mjs bump`**：逐项替换，每项对着 `count` 断言；**任何一项不符即全部中止、一个字节
   都不写**（先算完所有文件的新内容，再统一落盘）。两个散文位（CHANGELOG 正文 / spec §11 链说明）只插
   骨架并带那个待填标记，由人填；未填时严格闸门会拦（`--allow-pending` 是 bump 自己复检时用的降级）。
4. **`npm publish` 不进脚本**：它是唯一不可逆的一步 —— 版本号一旦花掉收不回；把它放在「重写十几个文件」
   旁边等于放大一次笔误的爆炸半径。它仍是两条显式命令，由 `bump` 打印，且**顺序固定为 发布 → 合并 →
   打 tag**（反过来的话 main 上会挂着「已发布」而 registry 还没有）。
5. **tag 一律 annotated**，由 `scripts/release.mjs tag` 创建：消息**写文件 + `-F` 传入**，建完
   `git cat-file tag` 回读。理由是**踩过的坑**：`git tag -a v1.2.3 -m "…<反引号>@migor/agentia<反引号>…"`
   里的反引号会被 shell 当**命令替换**执行 —— 消息里的词当场消失、bash 还会先打一行
   “No such file or directory”，而 tag 照样创建成功。
6. **打 tag 前核对「产物 ↔ 树」**：单源文档 `docs/usage-guide.md` 与 registry tarball 内
   `dist/AGENTS.md` 的 sha256 必须相等；另加产物里的 `AGENTIA_VERSION`、CLI 包零 `@migor/*` 依赖、
   `dist/inspector/` 在场。判据取单源文档，是因为它串起了这份文档被消费的四个面（不是逐文件 diff）。
7. **存量 lightweight tag 用 `retag` 显式转换**（默认只演练，`--apply` 才真改）：本仓库最早五个 tag
   （v0.2.2–v0.4.2）是 annotated，v0.5.0 起退成了 lightweight —— 所以这条是**回到仓库自己的老体例**，
   不是引入新体例。脚本不自动改已推送的 tag（force-push 是外部可见动作）。

**为什么闸门仍在 `prepublishOnly` 而不进 `verify-all`**：未发布窗口内 `AGENTIA_VERSION` 是**有意落后**的
（包版本先行），放进主链会让每次本地运行与 PR 为一种有意状态变红。

**门禁**：`tests/scripts/release-scripts.test.ts` —— 夹具是**合成**的（不拿当前树做快照，否则未发布窗口会让
它假红），钉的是护栏本身：计数不符即中止且**零写盘**（用 `git status --porcelain` 为空作证）、版本号只能
往前走、lock 的第三方版本号不被改、闸门能逐项点出不同步的那一面。变异电池 4/4 咬人。

### 2026-09-17 ④：官网首屏换成**真 trace 自播**（背景 canvas 降级共存）

**先更正一条我自己给出的成本账**：评估时我把「落地页 135KB JS」和首屏那块 canvas 摆在一起说，
暗示删掉 canvas 能省流量 —— **错的**。那 135KB 是 `gsap` 73 + `ScrollTrigger` 45 + `lenis` 19，
canvas 是手写的、**一行库都不引**（删它省的是每帧全屏重绘与注意力，字节数是 0）。
账要按真实归属记，否则决策会站在一个不存在的收益上。

**问题**：落地页文案把 trace 标成「**核心**」（`02 FEATURES` 第一张卡带 `feature--flag 核心`），
但首屏此前只有一层通用节点网络 canvas（hub + 7 卫星 + 沿线脉冲 + 鼠标视差）—— 每家 AI 创业公司
首屏都有这个，它不说本框架的任何独特之处。而产品真正的证据（`runId == traceId`、每次模型往返与
能力调用逐条记账、子 agent 递归成树、token/成本/耗时逐 span 落账）只出现在文案里。

**关键前提：证据本身早就写好了。** `@migor/trace-view` 渲染器（CLI inspector 与官网 playground
共用）＋ `/playground` 的「模拟演示」回放引擎已经在演「run 长成调用树 + token/成本往上跳」。
缺的只是把它搬到首屏 —— 所以这一单**不新增渲染能力**，只做接线。

**决定**：

1. **首屏加一块只读的 trace 自播面板**（980px 宽、296→272px 高、内部滚动），复用三样既有资产：
   渲染器（`@migor/trace-view`）、场景脚本（抽到 `packages/website/src/scripts/scenarios.js`）、
   回放游标（抽到 `trace-player.js`）。**节奏与 `tool.output` 的 LIFO 配对只有一份定义** ——
   playground 的 `runScenario` 改为调用共享游标，只保留终端面板与外层状态。
2. **背景 canvas 共存而非删除**：它是 `position:absolute` 的全屏层，面板在文档流里 `z-index:2`，
   叠放不需要改层级。但**要退半步**（三项一组：`opacity` 1→0.6、脉冲生成概率 0.06→0.03、
   鼠标视差 18/14→10/8）—— 两个都在动的画面里，背景不压就变成两处动效互相抢注意力。
3. **面板标明「录制回放」**：脚本数据参照真实 trace 结构，但**不发起任何真实模型调用**；
   页面不能让它看起来像 live。
4. 沿用站内既有的三条动效约定：`prefers-reduced-motion` ⇒ 不播动画、直接把每个 `wait` 归零跑完
   （脚本一个字不改）落**完整静态终态**；自播一次就停、不无限循环；离屏 / 切后台取消
   （`IntersectionObserver` + `visibilitychange`）。

**代价与边界（如实记）**：首屏高度变成「文案 556 + 面板 358 + 间距内边距 152 ≈ 1066px」，
于是面板在 900 高的视口里只露出 208px、在 375×812 的机器上要往下滚一格才看得到。
压面板高度与首屏内边距把底边从 901 收到 1050/692（1280×900 下可见 208px ⇒ 正在长树的那段在屏内），
手机上「滚动一格」判为**正常形态**：要把它挤进一屏就得砍标题或缩字号，那是拿首屏说服力换位置。
不做「两栏（文案左 / 面板右）」变体 —— 那会改掉首屏的居中气质，留作后续选项。

**门禁**：`tests/docs/website-playground-expand.test.ts` 的「两个宿主各一处 `tool.input` 记录点」
随之更新（模拟宿主那处从 `playground.js` 挪到 `trace-player.js`，覆盖面不变、变异仍咬人）。
浏览器侧证据：控制台零错误；行数 1→10 在长；计数器 0 → `7,250 / 738 / $0.0547`；自播 ~6.5s 后静止；
9 个宽度无横向溢出；`reduced-motion` 下加载即终态；首屏内入场元素 `opacity` 全为 1；
**`/playground` 与改动前逐字对拍相同**（10 行树 / 11 个终端块 / 计数器 / 菜单高亮）；
canvas 中心区采样 `ink≈3,600`、8/8 采样值互不相同（确实在动）、backing 尺寸 == CSS 尺寸（不糊）。

**2026-09-17 ⑤ —— trace 跨进程关联：入站 `traceparent` → run 根 span links**

**要解决的问题**：定位（§1）说「**trace 决定你敢不敢上线**」，而审计的第一要求是**能追溯来源**。
此前一条 trace 是孤岛：看不到「这次 run 是被哪个网关请求 / 哪条队列消息触发的」，
审计链在服务边界上断掉。

**决策（形态）**：用 **OTLP 风格的 span link**，**不是**父 span。入站给一个
`TraceContext { traceId, spanId? }`（HTTP 宿主认 W3C `traceparent` 头），run 根记一条 `links`；
`traceId == runId` 的 1:1 不变量**不变**。三条理由：
① 继承上游 traceId 会让一次 run 的调用树**依赖上游是否还活着 / 是否被采样掉**，树就不再自洽；
② 审计要的是「可查的因果」，不是「同一个 traceId」—— `links` 正是 OTLP 为跨 trace 因果定义的；
③ 跨服务时上游通常在另一进程、另一套采样策略下，继承会把两个系统的采样决策绑死。

**决策（只做入站，出站如实不做）**：框架**不生成**出站 `traceparent`。运行中没有「当前 span」
这个概念（`RunContext` 只有 `runId` 与 blackboard），要生成就得替调用方编一个 spanId —— 那是**假数据**，
后端会据此挂出一棵错的树，比不做更糟。出站的前置件是「`RunContext` 暴露当前 span」，列为后续项。

**为什么先做这条**（同批候选 B 增量 trace 出口 / A 无损档 / D 属性面）：
只有 C 被定位**直接要求**（审计 = 可追溯来源）。B 兑现的是长任务进度可见性，属**宿主 / 服务能力**
那条线（它解锁的是被后置两次的 `GET /tasks/:id/stream`），不该当观测方向排期；A 是已发布功能
（replay / fork / harvest）的保真度债，触发条件是「有人抱怨重放结果不一致」；D 不是产品决策，
随碰到该模块的 PR 顺手补。而 spec §9.4 的开放问题里，只有这条是**连语义都没定**的
（§9.2 原文「v1 先把 header 语义定好，实现后置（仍开放）」，而全仓 `traceparent` 零命中）。

**关键实现选择**：
- `parseTraceparent` 对非法头**返回 `undefined` 而不抛、不打 400** —— 与「sink 抛错被吞」同一条口径：
  链路是观测行为，一个畸形头不该把业务请求打成 400。被拒形态：版本 `ff`、trace/span 全零、
  位宽不符、非 hex；版本非 `00` 按 W3C 前向兼容接受。
- 通道选 **HTTP 头**而非 body 字段：`POST /run` 的 body 是 `RunInput`（改形状即破坏性变更），
  且 W3C 头是既有网关 / OTel 自动化的通用形态。`POST /tasks` 另外允许 body 里的
  `options.traceContext` 显式覆盖（JSON 调用方方便），优先级：body > 头。
- HTTP 宿主**两条路径都要带**（SSE 与一元）：只给一元路径传 = SSE 场景静默丢链路
  （与仓库里 `signal` 曾静默掉那次同型的坑）。
- **`AsyncRunner` 零改动**：`traceContext` 在 `spec.options` 里，随 `TaskRecord` 落库 ——
  所以另一个进程 `resumePending` 续跑的那次 run 也带得上。这正是**队列消费者**的场景
  （`runner.submit(input, { idempotencyKey: msg.key, options: { traceContext } })`），
  也是为什么「框架内建 Kafka 集成」没必要：缝已经够。
- `snapshot()` 对 `links` 也拷一层（同 attributes / events 的既有规则），
  且「**没记 link 的 span 没有 `links` 键**」—— 不制造 `undefined` 与 `[]` 两种空形态。

**门禁**：`tests/engine/traceLink.test.ts` 5 条（link 落点 / 无 `spanId` 时不带该键 / 不传则无该字段 /
**`app.run` 透传这一跳** / 只落 run 根）、`tests/engine/tracer.test.ts` 2 条（`addLink` + snapshot 拷贝）、
`tests/transport/http.test.ts` 4 条（`/run` 头 → `app.run`、畸形头不打 400、`/tasks` 落
`TaskRecord.spec.options`、body 优先于头）、`tests/integrations/otlp.test.ts` 1 条
（links 的 hex 宽度规则 + 无 link 不发键）、`parseTraceparent` 4 组边界；
e2e：`scripts/e2e-examples.ts` 的 `/run` 步骤带真 `traceparent` 头并断言 run 根 links
（真 HTTP 栈 + 真装配，不只单测）。

### 2026-09-18 ①：第六轮全量 review —— 把「功能静默失效」一次收口

**背景**：对 `src/` 58 文件 / 11,338 行 + tests + packages 做第六轮全量 review（前五轮：`a706ded`
/ `19b33a6` / `bded0a1` / 两轮发布后更正）。产出 10 条正式发现 + 6 条超上限确认项。**病灶与第五轮
同型**：绝大多数不是「算错」而是**不报错地不干活**（配置写错、错误形态不对、超时裁判权没交接），
说明上一轮只清了症状、没除根。逐条取证后的共同形态：**失败被记账成成功，或配置被静默忽略**。

**取证（每条都跑到了「现状 → 后果」）**：

1. `integrations/openai.ts` 非 2xx 抛裸 `Error`（无 `status`）⇒ `classifyError` 的鸭子类型读不到数值
   status ⇒ 全部落 `type:'unknown'` + `retryable:false` ⇒ **引擎那 3 次重试一次都不发生**：DeepSeek
   这类兼容端点吃一个 429 就整轮 run 失败。流内错误分片（HTTP 200）同样丢 `code`。
2. `engine/concurrency.ts` 的 `Math.floor(limit)` 把 `(0,1)` 的小数压成 0 ⇒ 零 worker ⇒ `fn` 一次
   都不调、`results` 全 `undefined`，调用方却拿到「成功」的空结果 ⇒ **工具被静默丢弃**。
   `maxToolConcurrency: cpus().length / 8`（文档推荐的写法）在 <8 核机器上正落在这个区间。
3. `toolkit/env.ts` 的引号判定 `startsWith('"') && endsWith('"')` 被行内注释打断 ⇒
   `A="sk-..." # prod` 把**含字面引号**的值写进 `process.env` ⇒ 每个请求 401，而 `.env` 看着完全正确。
4. `openai.ts` 的流截断守卫挂在「累积为空」上 ⇒ 截断发生在**已吐出半句话之后**时不触发 ⇒ 半截输出
   被 `end_turn` 收尾上报；而合法的 `content_filter`（无 content）反被当成上游故障 —— 同一个响应在
   流式与非流式两条路径上得到两种结论。
5. `anthropic.ts` 的 `usage = {...usage, ...event.usage}`：`RawUsage` 允许显式 `null`，于是
   `message_delta` 的 null **覆盖** `message_start` 的真实值，末尾 `?? 0` 再归零 ⇒ 该回合
   input/cache token 与 `costEstimate` 一起塌成 0，**`maxCostUsd` 护栏随之失效**。
6. `toolkit/subagent.ts` / `skill.ts` 漏了 `toolTimeoutMs: ctx.toolTimeoutMs` —— 它是
   `ToolRunContext` 9 个字段里唯一一件「主循环注入、两个嵌套能力都没下传」的。后果不是「少一层保险」
   而是**反的**：子循环里 `withTimeout(p, 0)` 直接返回原 promise（`core/timeout.ts` 的 `!(t > 0)`）
   = 永不超时，同时 MCP 桥找不到引擎预算、又起自己的 60s 兜底 = **双计时器 + 双账本**，正是
   2026-09-17 ① 声称已消除的状态。
7. `transport/http.ts` 把 `remaining() === 0`（deadline 已过）当「不限」传给 `runner.drain`，而
   `async.ts` 的 `timeoutMs <= 0` 语义是**无限等** ⇒ 优雅停机永不返回、SIGTERM 宽限期后被强杀。
8. `transport/async.ts` 的 `#redispatch` 只在内存改 `status`/`ownerId`，真正落库晚于
   `#acquireSlot`：对 `list()` 返回**反序列化新对象**的 store（sqlite/redis），窗口内第二次
   `resumePending()` 能通过 `ownerId` 过滤、把同进程正在跑的任务再派发一遍 ⇒ 重复执行、重复副作用、
   重复花费。`InMemoryTaskStore` 因存对象引用掩盖了它（既有用例只测内存版）。
9. `engine/retry.ts` 的 `{...DEFAULT_RETRY, ...o}` 让**显式 `undefined`** 覆盖默认（tsconfig 未开
   `exactOptionalPropertyTypes`，`{ maxAttempts: cfg.retries }` 这类透传组装能带着 undefined 过类型
   检查）⇒ 重试被静默关闭（快照记成 0，看着像用户主动关的）/ `backoffDelay` 返回 NaN。
10. `toolkit/prompt.ts` 的静态 `@Prompt` 去重用**实例方法 key** 播种 ⇒ 静态资产被按 key 跳过而静默
    丢弃，且 `module.ts` 按**菜单名**查重永远看不到它（丢的正是「本来不可能重名」的那类资产）。

**决定（分四组）**：

**A. 静默失效 —— 一律改成「响亮地失败或响亮地记账」**

1. `openai.ts` 新增 `OpenAICompatApiError`（带 `readonly status`，鸭子类型即可被 `classifyError` 认），
   非 2xx 与截断响应都经它抛出；流内错误分片按 `type`/`code` 反推 status（含
   `rate_limit`/`insufficient_quota`/`too_many` → 429），并把 `code` 带进文案。
2. `mapWithConcurrency`：正数一律 `Math.max(1, Math.floor(limit))`；非正/非有限仍视为不限。公开入口
   的快照同批收口 —— `config.maxToolConcurrency` 记**生效的整数**，不限记 `'off'`（同 `maxEventChars`
   约定）：`NaN` 过不了 JSON/OTLP 序列化（到看板是 null），`-1` 读起来像「卡在负数个并发」。
3. `.env` 引号值改为「扫到闭合引号为止」：闭合引号之后只允许空白或 `#` 注释，未闭合/有残留则回退
   未加引号分支（**刻意不猜**）。
4. 流截断判据换成「既无 `[DONE]` 也无 `finish_reason` = 上游故障」；空载荷守卫加 `refusal` 豁免，
   与非流式 `mapStopReason` 对齐。**语义变更**。
5. `mergeUsage(base, delta)` 跳过 `null`/`undefined`：缺值的语义是「保持已有值」，不是「清空已有值」。
6. `toolTimeoutMs` 下传两个嵌套能力（子 agent / skill 的 `runAgentScoped`）。**裁判权**语义。
7. drain：有限 deadline 且已过 → 直接 `false`，不把「已到点」透传给「0 = 不限」。
8. `#redispatch` 认领时**先 `await store.save(rec)` 再派发**（签名保持 `number | Promise<number>`，
   它已在 `.then()` 里被调用，不必强制 async）。
9. `resolveRetry` merge 前用 `definedOnly` 剔除显式 `undefined`。
10. 静态 `@Prompt` 改为按**解析后的菜单名**去重（仅供父子类静态覆写用）；实例↔静态真重名交给
    `module.ts` 抛「菜单能力重名」—— 对齐 §3「装配期统一查重、重名即抛」。

**B. 上限、结构化 error 与那处「缝」**

11. `metrics.ts` 三个维度的**键空间都封顶**（`dropped` Set 改计数器；`maxModels`/`maxScores` 新增，
    默认 50 / 200；超限折叠进既有的 `__other__` 桶）。上限是给**内存**封顶，不是给**账本**封顶 ——
    turn/token/条数照记，只损失标签粒度；snapshot 增 `droppedModels`/`droppedScores`。
12. `turn.ts` 的 `tool_use_no_blocks` 补齐结构化 `error`（`type:'agent_error'`），兑现
    `loop.ts` 的「非正常收尾都带结构化 error」不变量 —— 此前该分支 `status:'failed'` 但
    `result.error === undefined`，HTTP body 与任务记录里看不出**为什么**失败。
13. `POST /tasks` 的 store 落库故障改走与 500 同一套 `exposeErrors` 策略（不再 400 + 内部原文）；
    并补一条「停机闸门与 `submit` 之间隔着 `await parseJsonBody`」的 503 分支（新增
    `TaskInputError` 区分「调用方参数错」与「服务端故障」）。
14. **`beforeFlush` 缝**（本轮唯一的公共面新增）：`ExecuteRunOptions` / `RunAppOptions` 增可选
    `beforeFlush(trace, result)`，在 `run.finish` 之后、`flushSinks` **之前**调一次，可 await、抛错被
    吞（同 sink / 记忆回写：收尾动作失败不得击穿 run）。理由：`flushSinks` 发生在 `executeRun` 内部，
    `defineEval` 的结论若在 `app.run()` 返回后才挂，`metricsSink` 早在 `export()` 那一刻聚完账 ——
    分数**永远进不了指标**，而 usage-guide 承诺「eval 的 trace 自带质量结论、可直接聚合通过率」。
    判官必须拿到 `result`（它存在早于冲刷），所以缝的位置只能是这里，不能是「run 之后的钩子」或
    「异步 gate」（后者会与 `app.run` 的调用栈死锁）。`defineEval` 另有鸭子类型兜底：宿主漏透传时
    断言照做（不误报「全挂」），只是分数进不了指标。
15. `compactMessages` 的 cut 校验改成「tail 内每个 `tool_result` 的 id 都能在 tail 内找到对应
    `tool_use`」—— 非相邻工具对（`tool_use(A) @k`、user 文本 `@k+1`、`tool_result(A) @k+2`）此前会切出
    孤儿 `tool_result` ⇒ API 400。退无可退时照 `trimToolPairs` 先例整体放弃压缩。
16. **去重重构**：`sseLines` → `src/core/sse.ts`；`percentile` / `capabilityKindOf` →
    `src/core/stats.ts` / `core/trace.ts`；`textOf` 三份两种语义 → `src/core/text.ts` 的
    `textOf(message, separator)`，三个调用点**各传各的原值，行为零变化**；可中断 `sleep` 下沉
    `core/timeout.ts`（abort 文案参数化，`engine` 是 `'run 已被取消'`、`anthropic` 是 `'请求已被取消'`）。
    这些下沉不是整洁度：`integrations` 只准依赖 `core`，所以 `core/` 是让那两份合一的**唯一**合法落点。
    **两份 backoff 刻意不合并**并在原地写明理由：`engine/retry.ts` 是 ±20% 均匀抖动，
    `anthropic.ts` 的 `backoffMs` 是 ±25% 且优先尊重 `retry-after`（秒数 + HTTP-date）—— 合并即改行为。
17. MCP 桥的判据由 `engineBudget > 0` 改为 `!= null`：`toolTimeoutMs: 0` 的文档语义是「引擎不设超时」，
    那同样是**引擎的表态**。用 `> 0` 的话，用户显式写下不限、桥却自作主张判 60s —— 与
    「一次调用只有一个裁判」相反，也把「说了不限」变成假的。**语义变更**。
18. `docs/roadmap.md` 的 score 形状补上 `comment` 字段（实现会条件附加，usage-guide 已写）。

**代价（如实记）**：

- **公共面新增两处**（用户已批准）：`RunAppOptions`/`ExecuteRunOptions` 的 `beforeFlush`（可选，不传
  行为不变）；metrics 的 `maxModels`/`maxScores` 与 snapshot 的 `droppedModels`/`droppedScores`
  （**新增**键，既有键的形状不变）。`docs/usage-guide.md` 与官网 `api.html` 已同步。
- **`dropped*` 计数自身封顶 1024**（`MAX_DROPPED_TRACKING`），超出后它是**下界**：计划里写的
  「零语义损失」只对上限之内的键空间成立，超出部分连「丢了多少」都只能是下界。已写进注释与
  `usage-guide` 的取值说明。
- **`tool_use_no_blocks` 现在带 `result.error`**：该分支一直是 `status:'failed'`，按
  `result.error === undefined` 分流「是不是失败」的调用方不受影响；把它当唯一判据的日志会多一行。
- **`RawUsage` 与 `MessageUsage` 没有拉齐**（原计划提到）：两者是**不同层**的语义 —— 前者是原始分片、
  允许显式 `null` 表示「这次不报」，后者是归一后的产物（`?? 0` 已兜过底）。拉齐会同时弄错一头，
  已在 `anthropic.ts` 就地写明「别把它们拉齐」。
- `#redispatch` 未强制改成 `async`；`textOf` 落在 `src/core/text.ts` 而非 `core/message.ts`
  （`message.ts` 是纯类型层，加运行时函数会把它从类型模块变成实现模块）；`TaskInputError` 是
  **module 级** export，**不**进 `src/index.ts`（进了就触发官网 API 页的反向全覆盖要求）。

**门禁**：`tests/integrations/openai.test.ts`（非 2xx 带 status → `classifyError` 分类 + 429 真触发引擎
重试的闭环）、`tests/integrations/openaiStream.test.ts`（错误分片反推 status / 截断必抛 / `refusal`
不抛）、`tests/engine/concurrency.test.ts`（`(0,1)` 小数仍有 1 个 worker + 快照记生效整数）、
`tests/toolkit/env.test.ts`（引号 + 行内注释 / 未闭合 / 残留）、`tests/integrations/anthropic.test.ts`
（`message_delta` 的 null 不清真实值）、`tests/toolkit/subagent.test.ts` 与 `skill.test.ts`
（`ctx.toolTimeoutMs` → 子循环按超时记账）、`tests/transport/host-hardening.test.ts`（截止已过 → 立即
false，时钟前跳构造，不赌毫秒）、`tests/transport/async.test.ts`（异步 store 下 `resumePending`
不重复执行）、`tests/engine/retry.test.ts`（显式 undefined 回落缺省）、`tests/toolkit/prompt-versions.test.ts`
（静态资产不丢 / 真重名交装配期抛）、`tests/integrations/metrics.test.ts`（三个维度封顶 + 折叠后账总量
不变 + 标签不被切成乱码）、`tests/engine/loop.test.ts`（`tool_use_no_blocks` 带结构化 error）、
`tests/transport/http.test.ts`（store 故障走 `exposeErrors`）、`tests/eval/defineEval.test.ts`
（score 在冲刷前落定 → `metricsSink` 真聚合得到 + 宿主漏透传的兜底）、
`tests/engine/trimming.test.ts`（非相邻工具对不切出孤儿 `tool_result`）、
`tests/integrations/mcp.test.ts`（引擎显式 `toolTimeoutMs: 0` ⇒ 桥不自判）、
`tests/core/sse-text-stats.test.ts`（下沉三件套的语义对拍）。
每条修复都用「临时把修复废掉 ⇒ 新用例必须变红」验过判别力，再从备份还原。
e2e：`npm run e2e`（CLI / EXAMPLES / DEPLOY / GRPC 四关全绿）、`npm run e2e:mcp`（真第三方 MCP server → 桥 →
菜单 → 真跑一轮，metrics 输出里可见 `droppedModels`/`droppedScores`）。

### 2026-09-18 ②：给「约定」补**守卫注册表** —— 上一条 16 条的共同缺口是「没有门禁」

**背景**：第六轮 review（上一条）的 16 条缺陷，逐条追根后是**同一个缺口的不同面貌**：
约定写在 AGENTS.md / spec / 代码注释里，但**没有任何门禁**。而已有门禁（`layering.test.ts`、
`api-page.test.ts`、`usage-guide.test.ts`、`no-legacy-terms.test.ts`）恰恰守住了它们覆盖的面 ——
说明**守卫是沿着「写过文档、写过测试的地方」长的**，没写的地方就是空白。

**决策**：把「哪类危险由谁守」变成仓库的一份**单源清单** `docs/guards.md`，并补一条新的
架构守卫。三件事：

1. **`tests/architecture/transport-errors.test.ts`（新增）** —— 扫 `src/integrations` 的裸
   `throw new Error(...)`：文案里出现 HTTP 状态痕迹（`HTTP` / `res.  status`）而对象没有数值
   `status` 即违规，因为 `classifyError` 是鸭子类型、丢了 status 就落 `unknown` + 不可重试
   （上一条第 1 条的病根）。判定**刻意做窄**：构造期配置校验（文案含「必须 / 只支持 / 收到 / 非法」）
   一律豁免 —— 宁可窄不要误报（误报的门禁最终会被人 ignore 掉）。另两条：`*ApiError` 命名即承诺
   （必须有 `readonly status: number`）、解析器合成样本 + 全覆盖计数下限（防真空变绿）。
2. **`docs/guards.md`** —— §1 列「已挂守卫 → 保护的不变量 → 退化了会怎样」，§2 列**待守缺口**
   （成对实现不对称 / 转发漏字段 / 浅合并被 null 覆盖 / 同步实现掩盖真实异步 / `0` 的双重语义…），
   §3 记三条守卫写法纪律（宁可窄、必须能反向证伪、失败信息带文件:行号）。
3. **`.github/PULL_REQUEST_TEMPLATE.md`** —— 加「危险类自查 5 问」（成对对称？转发漏字段？
   错误可分类？边界值走过？是静默失效吗？）+「新增/修改的守卫必须做反向验证」勾选 + 登记 `guards.md`。
   **问对比写规则便宜，且能覆盖规则没预见到的形状。**

**实证（守卫上线当天就抓到真货）**：新守卫第一次跑就报 `src/integrations/otlp.ts` 的
`throw new Error(\`OTLP 导出失败: HTTP ${res.status} …\`)` —— 与上一条第 1 条**完全同形**的漏网之鱼
（上一轮 16 条没覆盖到 otlp）。已修：新增 `OtlpExportError`（带数值 `status`），与
`AnthropicApiError` / `OpenAICompatApiError` 同形。**这条守卫的价值不在「守住已修的」，在「抓住没修的」。**

**未做（登记为待守，见 guards.md §2）**：`exactOptionalPropertyTypes` 实测会让现有源码报
**39 处**（TS2379 ×19 / TS2375 ×10 / TS2412 ×8 / TS2322 ×2，集中在 `transport/` 15、`engine/` 12），
是**独立的一轮迁移**而非无害开关 —— 机械修法（给每个可选属性加 `| undefined`）会放松
`RunAgentOptions` 等公共契约；正确修法是逐调用点条件展开（`...(x !== undefined ? { x } : {})`，
`loop.ts` 已在用这个形状）。实测过「只改一个类型文件只消掉 1/39」，证明它不是局部修补。
**不在本轮硬开**：实测分布与四步迁移方案记在 `docs/guards.md §2` 的专门条目。
（**后话：已由 2026-09-18 ⑦ 单独一轮完成**，该专门条目随之迁入 `guards.md` 附录。）

**同轮补齐的另一半（对拍矩阵）**：`tests/integrations/adapter-parity.test.ts` ——
「同一契约的两条适配器必须对称」的可执行版本，**一份场景表跑两遍**（不是把两侧测试写成镜像）。
**写它的当天就抓到一处真不对称**：`anthropic.ts` 有客户端内层重试（`postWithRetries`，
缺省 `maxRetries=2`），`openai.ts` **完全没有** —— 同一个 429：anthropic 打 3 次网络请求、
openai 打 1 次（引擎层那一次）。两侧各自的测试都通过，因为它们只断言「最终成功」，
**从不比较尝试次数**。已修：`openai.ts` 加同语义的 `postWithRetries`（同状态码集合、同退避曲线、
同 `retry-after` 尊重），`OpenAIClientOptions` 加 `maxRetries`（缺省 2，与 anthropic 逐字对齐）。
反向验证：把 openai 的内层重试改回 `0` ⇒ 矩阵 11 条红（含跨侧对称那条），恢复即绿。
**顺带暴露的可用性瑕疵（未修，记下）**：`anthropic.ts` **没有 `fetchImpl` 注入缝**（openai 有），
而它的索引签名让错传的参数**静默通过** —— 矩阵因此改用替换 `globalThis.fetch` 做统一注入面。

### 2026-09-18 ⑦：`exactOptionalPropertyTypes` 迁移完成 —— 「显式 undefined ≠ 不传」成为类型级约束

**背景**：上一条把这条开关登记为「待守缺口」（实测 39 处，判为独立一轮）。本轮单独做掉。

**它守什么**：`{foo: x}`（`x: T | undefined`）**不是**合法的 `foo?: T` —— 「不传这个键」与
「传了个 undefined」被区分开。`retry.ts` 的「显式 undefined 覆盖缺省」事故（重试被静默关闭、
`backoffDelay` 算出 NaN）正是这条区分缺失造成的。

**迁移规则（三类角色，后来者照此办理）**：
1. **结果/状态记录**（框架总是把字段写进对象字面量）→ **必填 `T | undefined`**：
   `AgentRunResult` / `AgentLoopResult` / `RunMeta` / `RunHttpResponse` / `TurnOutcome` /
   `ToolEventIO` / `SpanDiff`。「字段在场、值可无」是这些记录的真实语义。
2. **内部管道**（缺省与显式 undefined 等价）→ **可选 `?: T | undefined`**：
   `AgentLoopArgs` / `LoopContext` / `Job` / `TaskRecord` / `RunSpec` / `BudgetGuardOptions` /
   `SseWriterOptions` / `CapabilityCall`。
3. **公共入参**（「不提供 = 用缺省」必须有意义）→ **签名不动**，在**调用点**处理：
   条件展开 `...(x !== undefined ? { x } : {})`，或集中 `omitUndefined({...})`（新增
   `src/core/object.ts`，用于 `AgentApp.run` → `executeRun` 那种一次转交十几个字段的场景）。
   **这一条是重点**：前两类的机械修法若套到公共入参上，等于把开关要守的东西自己放掉。

**代价与结果**：39 处 `error TS` 全清（TS2379 ×19 / TS2375 ×10 / TS2412 ×8 / TS2322 ×2），
另连带修好测试/示例里的若干处（`RunSpec` 夹具补字段、`retry.test.ts` 的显式 undefined 改用
`as unknown as` 并注明「模拟动态拼装绕过类型检查」、`examples/complete` 的条件展开）。
**测试 836 例全绿**，`verify-all` 8/8。

**门禁（防止有人把开关关掉）**：`tests/architecture/tsconfig-strictness.test.ts` 断言
`exactOptionalPropertyTypes` / `strict` / `types:["node"]` 三个开关在场，各带「退化了会怎样」。
反向验证：关掉开关 ⇒ 该测试红，且 `{maxAttempts: undefined}` 赋给 `RetryOptions` 立刻从
「编译错」变回「放行」（实测 ON=1 错 / OFF=0 错）。

**未覆盖（如实记）**：`exactOptionalPropertyTypes` 堵的是「显式 undefined」这一半；
**「spread 转发时漏掉一个键」TS 结构类型仍然不报**（`{...opts}` 少字段照样过）。
该缺口留在 `docs/guards.md §2`。

**2026-09-18 ⑧ —— 第七轮复审收口：适配器错误分类对齐 / 指标面可见 / 续跑重入闸（+ 守卫自身的洞）**

**缘起**：三路并行复审 `9f1dcd8..HEAD`（第六轮那 16 条）后逐条回读源码，发现四类残留。其中最有价值的
不是任何单条 bug，而是一个模式：**这一轮的主题是「把没有门禁的约定收口」，而守卫自己有洞** ——
① `transport-errors` 的注释剥离被字符串里的 `//` 打断（见下）；② `adapter-parity` 的矩阵结构上测不到
「缺省值对称」；③ `guards-registry` 的密度下限（8）远低于实测（32），删整节仍绿。①③ 本轮修掉，
② 如实留在 CHANGELOG 的「仍未做」。

**决策（错误分类必须「同故障同结论」）**：`anthropic` 与 `openai` 在同一个上游故障上给出相反结论，
是比任何单条分类错误更坏的事（两条适配器都叫「默认 client」）。本轮统一三处：
- **截断判据两侧同款**：既无终止标记（`message_stop` / `[DONE]`）、又无 `stop_reason` / `finish_reason`
  ⇒ 抛 500 可重试。**判据不能挂在「累积为空」上**（两侧都踩过）：已吐半句后断流时内容非空，
  于是落 `unknown_stop_reason`（**不是**重试判据）⇒ 引擎一次都不重试 + trace 误诊成「模型协议异常」。
- **流内 error 分片的 status 反推不照抄**：anthropic 协议只有三种 type（默认 500 合理），
  OpenAI 兼容生态有 `invalid_request_error` / `context_length_exceeded` 这类**改配置才有救**的 4xx 病因 ——
  判 400 不可重试。照抄 anthropic 的三档会让引擎白重试 3 次。
- **非流式与流式同结论**：`content_filter` 的合法空回复两侧都豁免；其余空补全两侧都抛。

**决策（`resumePending` 重入：共享在飞那次，而不是返回 0）**：并发重入时返回 0 是**谎报**
（「本次没派发任何东西」，而实际派发了）。返回在飞那个 Promise，调用方拿到的始终是本次扫描的真实结果。
闸门用 `Promise<number> | null` 而非 boolean，正是为了让重入方拿到同一个数。

**决策（指标名刻意不嵌在既有前缀里）**：基数折叠的 gauge 定为单家族
`agentia_dropped_keys{kind="capability"|"model"|"score"}` —— 与既有 `tokens_total{kind=…}` 同形。
初版曾命名 `agentia_model_dropped_keys` 等三个家族，**被既有测试的 `agentia_score` 子串断言当场抓到**：
嵌在 `agentia_model_*` / `agentia_score_*` 前缀里会让「按前缀匹配」的看板与断言无端把折叠计数算进去。

**守卫的洞（本轮最值钱的发现，记清机制）**：`transport-errors.test.ts` 的 `stripLineComments` 把每行
「截到 `//` 为止」—— 而 `//` 会出现在**字符串里**（URL 是最常见的形态）。截断切掉该行闭合的 `)` 与
反引号 ⇒ `bareErrorThrows` 的括号配平一路吃到文件末尾 ⇒ **该行之后的每一处抛错都被并进同一个「throw」
片段，再也判不出违规，且不报错**。实测 `src/integrations/metrics.ts`：8 处裸抛错只剩 2 处可见，
被吞掉的恰好包括 `OTLP metrics 导出失败: HTTP ${res.status}`（本守卫存在的理由）。改为「整行丢弃
注释行（`//` / `*` / `/*` 开头）」两头都对：块注释说明行不误报，字符串里的 `//` 不再破坏扫描。
**反向验证**：新回归样本在旧实现下「捕获 1 处 / 判违规 0 处」、新实现「2 处 / 1 处」——断言要求 2 处 ⇒ 会红。
密度下限同时由 8 提到 24（实测 32，留 ~25% 余量）。

**门禁**：`tests/architecture/transport-errors.test.ts` 新增回归钉；`tests/integrations/anthropic.test.ts`
+3（空流 / 截断 / 正常流不误伤）、`openaiStream.test.ts` +3（4xx / 429 / 5xx 三档）、`openai.test.ts` +2
（非流式空补全 / refusal 豁免）、`metrics.test.ts` +2（折叠数对得上 snapshot / 恒定发三个）、
`tests/transport/async.test.ts` +1（并发重入）。**三处承重性反向验证**：摘掉重入闸、短路截断判据、
把注释剥离改回旧实现 —— 对应新用例分别变红。

**2026-09-18 ⑨ —— MCP 连接器改为**内置**（反转 2026-09-11 的 F7「独立可选包 `@migor/mcp`」）**

**决策（连接器内置，不发独立包）**：`src/integrations/mcp.ts` 新增 `createStdioMcpConnector` /
`createStreamableHttpMcpConnector`，公共面加 `McpConnector` 与 `MCP_CLOSE_GRACE_MS`。
**同时作废**「连接器在独立可选包 `@migor/mcp`」这个说法 —— 它出现在 `src/index.ts`、
`src/integrations/mcp.ts`、`scripts/e2e-mcp.ts`、`tests/integrations/mcp.test.ts`、
`docs/plans/2026-09-11-agent-service-hardening.md` **共 5 处**（另加 §10 里 2026-09-11 那条原始记录本身，
已就地加「后话」指针），而那个包**从未存在**
（registry 返回 404，`packages/` 下只有 cli / trace-view / website）：等于 5 处注释指向一个空落点。

**为什么反（F7 给的理由站不住，且与仓库自己的先例相反）**：
- F7 的理由是「守住零运行时依赖」。**那条口径指的是不依赖第三方包**（`package.json` 的
  dependencies / peerDependencies / optionalDependencies 三个字段全空），不是「不 import node 内建」——
  `src/` 早已直接 import 10 处 `node:` 内建（`node:http` ×2 / `node:crypto` ×4 / `node:fs` ×4 /
  `node:path` ×3 / `node:sqlite` / `node:module` / `node:async_hooks` / `node:url`）。
  `spawn`（`node:child_process`）与 `fetch`（Node 18+ 全局）都是标准库 ⇒ **内置连一个第三方依赖都没加**。
- **仓库自己的两份先例**（`store/` 的三层形状）：只用**标准库**的平台能力**直接内置**
  （`FileTaskStore` = `node:fs` / `SqliteTaskStore` = `node:sqlite` / HTTP 宿主 = `node:http`）；
  需要**第三方客户端**的才只留 duck-typed 缝（`RedisTaskStore` = `RedisLike`）。
  MCP stdio 连接器属于**前者**。⇒ 内置才是与既有形状一致的那个选择，独立包是例外。
- F7 的同文档下一节（§8 风险 D1）写的是真理由：「MCP 协议演进快 → 协议细节推给连接器包」。
  但**这个问题的答案仓库已经有了**：`integrations/otlp.ts` 同样是外部 churn 协议（OTel GenAI
  semconv，至今 experimental），它内置，对付 churn 的手法是「映射集中在单模块 + **钉住基准版本**」
  （`otlp.ts:15` 对齐 v1.37，升级只改本模块）。若 OTLP 可以内置，MCP stdio 没有原则性理由在外面。
- **可逆性**（拍板用的判据）：先内置，将来真被协议变更拖痛了，把这段挪进新包、旧路径 re-export 即可
  ——**可逆**；先发包则用户已装第二个包，再收回来是破坏性的 ——**不可逆**。

**结构面不变（本次的关键约束）**：`McpClientLike` 仍是最小缝 —— 接官方 SDK / 远程 server / 自研传输
照旧。出厂连接器只是**默认件**，与 `FileTaskStore` / `SqliteTaskStore` 之于 `TaskStore` 完全同构。
「第三方 SDK 对用户不可见」那条口径**没有**被放宽：一个 MCP SDK 都没 import。

**顺带收掉三处非显然的坑**（此前只活在 `scripts/e2e-mcp.ts` 内联的 94 行私有副本里，没有任何门禁守着）：
① spawn 失败的 `'error'` 是**异步事件**，没有监听器就是未捕获异常（真实宿主进程直接崩，没有 try/catch
接得住）；② stdout 必须按 `\n` **攒包**（一条报文可能跨多个 chunk）；③ **协议层 `isError: true` 必须
转成抛错** —— 否则模型收到一条「成功」的结果、trace 也把这次失败的调用记成成功，正好打在本框架
「trace 决定你敢不敢上线」的承诺上。

**超时口径（延续「一次调用只有一个裁判」）**：连接器的 `timeoutMs` **只作用于装配期**
（握手 + `tools/list`）—— 那两步此前**没有任何裁判**，server 卡住会让 `createApp` 永久挂起；
`callTool` 的裁判仍是引擎 / 桥，连接器**不再起第二个计时器**。实现复用 `core/timeout.ts` 的
`withDeadline`，**不用 `AbortSignal.timeout`**：后者内部 unref，正是 2026-09-14 ④ 明令禁止的形状。

**已知边界（如实标注；两条已在同日 ⑩ 收掉）**：StreamableHTTP 的会话过期（带会话 id 收到 `404`）
~~**不自动重握手**，按不可重试的 `api` 错抛出~~ ⇒ **已由 ⑩ 改为自愈**；`close()` ~~不保证等到子进程
被 reap~~ ⇒ **已由 ⑩ 改为保证**。

**覆盖升级（不只是重构）**：`scripts/e2e-mcp.ts` 此前只能 `import type` 桥的类型、自己再写一份连接器
⇒ 那条端到端证明测的是**它的私有副本**。现在它 import 出厂连接器 ⇒ 门禁测的就是用户拿到的东西。

**门禁**：新增 `tests/integrations/mcpConnector.test.ts`（27 例）。stdio 侧起**真子进程**
（夹具 `tests/fixtures/mcp/fake-server.mjs`，env 覆盖 7 种模式：normal / split / logline / noinit /
die / iserror / badtools）—— 要验的三件事只存在于真子进程世界里，用假 client 验等于没验；
HTTP 侧注入 `fetchImpl`（与 `openai.test.ts` 同款）。
**变异电池 9/9 全部被抓到、0 漏网**：摘掉 spawn 的 `'error'` 监听器、stdout 分帧丢包、
两侧 isError 不转抛错、握手不 memoize、会话 id 被后续响应清空、SSE 当 JSON 解析、
HTTP 失败不挂数值 `status`、`tools` 非数组静默成空菜单。
`npm run e2e:mcp` 改为走出厂连接器，真第三方 server（`uvx mcp-server-time`）全绿。
文档面：`usage-guide` 新增 `StdioMcpConnectorOptions` / `StreamableHttpMcpConnectorOptions` 两张选项表
（并把这两个类型登记进 `tests/docs/usage-guide.test.ts` 的 `MEMBERSHIP_TYPES`，否则会被
「标题未点名类型的表 ⇒ 首列必须是导出名」那条规则误判）；`api.html` 导出面 204 → 210；
`McpToolsOptions` 的用法示例此前还写着 `providers: [{ useFactory: … }]`（spec §10 2026-09-11 已记
那条路不成立）—— 一并改成 `AppOptions.tools`。

**2026-09-18 ⑩ —— 收掉 ⑨ 留下的两条「已知边界」：会话过期自愈 + `close()` 保证 reap**

**① StreamableHTTP 会话过期改为自愈（反转 ⑨ 的「不自动重握手」）**：带会话 id 收到 `404` ⇒
丢会话 → 重新握手 → 把**这一次**重试一次（**只一次**）。

- **为什么可重试是安全的**：`404` 在 MCP 规范里的含义是「这个会话我不认识」⇒ **该请求没有被
  server 执行**。所以重试不会重复执行副作用（这点必须先确认，否则重试一个 `tools/call` 就是赌博）。
  规范本身也要求客户端此时新建会话（不带会话 id 重新 `initialize`）。
- **⑨ 当初的理由是「自动重建会掩盖 server 侧会话策略」** —— 解决方式是**别让它静默**，而不是别修：
  新增 `onSessionExpired` 钩子（要计数 / 告警 / 打日志就挂它）。「静默恢复」与「静默失效」在监控上
  看不出区别，所以「不静默」是这条修复的**组成部分**，不是可选项。
- **只重试一次**：第二次再 `404` 说明对面不是「会话过期」，直接抛（不循环 —— 无界重试会把一次
  故障放大成请求风暴）。`404` 之外的失败仍按 `classifyError` 分流抛出，**不重试**。
- 未触发条件：`sessionId === null` 时的 `404` 不当作过期（没有会话可过期，重试毫无意义）。

**② `close()` 改为「返回即子进程已终止」（反转 ⑨ 的「不保证 reap」）**：SIGTERM → 宽限期后
SIGKILL，然后**继续等真正的 `'exit'`/`'close'`**（SIGKILL 不可被捕获，该事件必达）。
⑨ 写的是「有界返回比等到确认更值」—— 那条取舍当时图的是「close() 一定不挂」，
代价是**调用方以为进程没了、实际留一个孤儿**，且无从知晓（静默的错，正是本仓库最贵的一类）。
现在保证的是**已回收**；「close() 会不会挂」的答案变成「只有在进程不可中断（D 状态）时才会等」——
那是 OS 层面的事实，不该由 API 用一个谎去掩盖。

**验证**：`tests/integrations/mcpConnector.test.ts` +4 例（27 → 31）：自愈成功（断言新会话 id、
`onSessionExpired` 恰好一次）、只重试一次（断言 `initialize` 恰好 2 次）、无会话时不重试、
`close()` 返回即已回收（夹具新增 `stubborn` 模式忽略 SIGTERM + 写 pid 文件，断言 `kill(pid, 0)`
报 `ESRCH`）。**变异电池 6/6 全部被抓到、0 漏网** —— 其中「夹具不再忽略 SIGTERM」一条是用来证明
那条用例**真的在测 SIGKILL 路径**（而不是碰巧快）。HTTP 假端点同时改为「会话显式开启」，
免得默认路径悄悄带上会话、把「无会话」这个场景测没了（这个坑当场被一条既有用例抓到）。

**2026-09-18 ⑪ —— 宿主接入（gRPC / Kafka 这类）不打包：先配方 + 示例，升级为包要有触发条件**

**问题**：「Kafka / gRPC 要不要包成成熟的工具暴露出来让用户用，降低使用成本？」→
「是不是起一个服务包，把 grpc 和 Kafka 这几个都做了？」

**决策（不做「服务包」）**：判别规则只有一条 —— **客户端是不是标准库**。
MCP stdio 只用 `spawn`（`node:child_process`）+ 全局 `fetch` ⇒ 内置**零新增第三方依赖**；
gRPC 要 `@grpc/grpc-js`、Kafka 要 `kafkajs` ⇒ 落在「可选能力一律 duck-typed / peer」那一侧
（AGENTS.md 硬约定 + roadmap「可选能力（zod、OTLP、队列）全部 peer/可选接入」）。
所以「MCP 内置、gRPC / Kafka 不内置」**不双标**：差别只有那一条。反向的路（把协议细节推给独立包）
上一次刚被否过 —— 2026-09-18 ⑨ 反转了 F7 的「独立可选包 `@migor/mcp`」。

**决策（粒度）**：若真拆包，是**一个第三方客户端一个包**，不是一个大「服务包」。三条硬理由：
① peer/可选 变矩阵（只要 gRPC 的人也被要求配 kafkajs，或退化成一堆 dynamic import + 运行时报缺）；
② semver 取最大值（Kafka 一个 bugfix 要发一个带 gRPC 宿主的新版本）；
③ 弃用无法分离（kafkajs v3 迁移不该碰到 gRPC 用户）。发布成本本来就是 per-package 的
（`release-surface.mjs` 18 项里每包各占 package.json 版本 + lock 版本字段 + check-release 条目 +
prepublishOnly 闸门 + CHANGELOG），合成一个大包只省下一个 `package.json`，却把上面三条全买下来。
唯一可辩护的「一个包」是**瘦门面**（自身零依赖、只 re-export 那几个包），前提是 ≥2 个包已存在
且发现有测量到的「找不到」痛点 —— 现在做等于先建空壳。

**决策（Kafka 侧不做）**：配方已在（§6.4「跨进程关联」的队列消费者形态，含那条真坑 ——
**位移提交点与 run 终态不是一个时刻**）。而 consumer 包里唯一非平凡的部分（offset commit 时机、
rebalance、shutdown flush）全是**进程级决策**，正是框架声明不碰的东西（不读 env、不订阅信号）。
2026-09-17 ⑤ 已记「框架内建 Kafka 集成没必要：缝已经够」，本条不推翻它，只把理由补全。

**决策（gRPC 侧做配方 + 示例，本轮落地）**：gRPC 与 Kafka **不同类** —— 它是**第 4 个宿主**，
与 HTTP 并列的一等概念；而宿主接入里有四处是**框架语义**、不是样板：deadline / 取消 → `signal`、
metadata `traceparent` → `traceContext`、框架错误 → gRPC 状态码、trace → sink。这四处漏掉
**都不报错**（本仓库最贵的一类故障）。落点仍是 `examples/`（不随 npm 包发布），
因为 gRPC 必须引第三方客户端。交付：`examples/grpc-host/`（proto + 宿主 + 客户端 + README）
+ `docs/usage-guide.md` §6.2 配方 + `npm run e2e:grpc`。

**升级为独立包的触发条件**（写死，免得下一个人重新论证）：出现**第二个**真实使用方要同一份逻辑；
或配方在 e2e 里证明样板已压不下去（即需要框架内语义：deadline→signal、状态码映射、流式记账）。

**验证**：`npm run e2e:grpc` 真构建、真起宿主、用**示例自带的客户端**跑四个 RPC；
**变异电池 8/8 全被抓、0 漏网** —— 逐个拆掉四处翻译 + `NOT_FOUND` 分支 + trace sink + SIGTERM 处理，
每条都由**它该触发的那条断言**报红。诚实记一笔过程：第一轮里「拆掉 NOT_FOUND 分支」那条是被
**构建失败**抓住的（我的变异把类型也改坏了），不是被状态码断言抓住 —— 换成纯行为变异
（`NOT_FOUND` → `INTERNAL`）后才由断言抓住。**「被抓住」不等于「被那条断言抓住」**，
变异电池的记录必须区分这两者，否则它会高估断言的判别力。

**2026-09-18 ⑫ —— OpenAI 适配器：legacy `function_call` 形态改为**响亮失败**（原为静默 `end_turn`）**

**怎么发现的**（记下来，因为入口是一次「看着像纯风格问题」的 lint 注解）：`biome ci` 一直挂着一条
`noUselessSwitchCase`（`openai.ts:672` 的 `case 'stop':` 落进 `default`，同一个返回值 —— 纯冗余）。
顺手把这张映射表的**完整性**也核了一遍：`stop` / `length` / `tool_calls` / `content_filter` 都覆盖，
但 `default: return 'end_turn'` 会吞掉**任何**未知值 —— 其中 `function_call`（legacy `functions` 形态）
是唯一一个「吞掉就有害」的：调用在 `message.function_call` 里，而适配器只读 `tool_calls`。

**取证**（假端点喂真适配器，不改仓库）：legacy 响应 ⇒ `stop_reason = end_turn`、
`content = [{"type":"text","text":"好的，我查一下。"}]`、**工具调用没了且没有任何报错**。
即「模型要调工具、工具没执行」以成功收尾 —— 本仓库最贵的那一类（模块头写的就是
「上游故障绝不映射成成功」）。

**决策**：`case 'function_call':` **响亮失败**，不做 legacy 兼容、不静默降级。
- **不做兼容**：请求侧只发 `tool_calls`（`buildMessages`），回灌的 `role:'tool'` legacy-only 端点
  同样吃不下 ⇒ 半吊子支持比不支持更糟（与「一个第三方客户端一个包」同一条思路：要么真支持，要么明说不支持）。
- **400 而非相邻空补全那条 500**：这是**确定性不兼容**，换不了结论 ⇒ 落 `classifyError` 的
  `api`／不可重试。用 500 会被引擎重试三次，每次都重复丢弃同一个调用（把一次故障放大成三次）。
- **`default` 保持 `end_turn`**（未知 finish_reason **且有正文** ⇒ 上游只说「结束了」）：
  空正文那条已在流式/非流式两个调用点各自拦住，不会走到这里变成「成功空回复」。
  这个默认是**有意**的，已用一个 `eos_token` 用例钉住，防后人顺手改成抛错。

**验证**：`tests/integrations/openai.test.ts` +2 例（legacy 形态抛 400／`classifyError.type==='api'`／
消息里含 `function_call`；未知值 `eos_token` + 正文 ⇒ `end_turn`），该文件 15/15 绿。
**变异电池 2/2**：删掉整条分支 ⇒ 用例红在「Missing expected rejection」（本该抛错却拿到了
`end_turn`）；把 400 改回 500 ⇒ 红在状态码那条严格相等断言。⚠️ 诚实记一笔：第二条我脚本里的
`expect_marker` 写的是「状态码」而实际失败行没印这三个字，被标成「非预期断言」——
**核对失败行内容后**确认它确实是目标断言（`assert.equal(status, 400)`）。标记匹配是辅助，
**「红在哪一行」才是判据**（同 §10 ⑪ 那条：被抓住 ≠ 被那条断言抓住）。
### 2026-09-19 ①：HITL 落地 —— 审批 = 异步 tool_result（挂起/恢复），解开 2026-09-11 的「不做」

**背景**：2026-09-11 的能力边界结论把 HITL 定为「闸门层无需新机制（middleware 可 await 决策），
**跨进程挂起/续跑不做**」—— 当时的卡点原文是「`RunStatus` 无『待批准』态、循环位置（消息数组）
不落库、`traceToMessages` 重放有损」。本轮把它落地了，关键想法是：**不落「循环位置」，落消息历史**。

**① 为什么审批 = 异步 tool_result**：Anthropic 协议里一个 tool_use 的归宿只有两种 ——
执行出 tool_result，或给出 is_error 的 tool_result。「等审批」不是第三种归宿，而是
「tool_result 迟到」。于是挂起态**不需要任何断点续跑原语**：run 以「末尾是含未决 tool_use 的
assistant 消息」的消息历史落库（`TaskRecord.spec.messages`），恢复就是引擎见到这种输入时
**先解决这些 tool_use 再调模型**（`agentLoop` 入口的通用恢复检测 —— 通用化收益：任何
「assistant 结尾带 tool_use」的输入都能续跑，不只审批场景）。2026-09-11 那条卡点的三个成分
因此全部消解：状态有了（`awaiting_approval`）、落的就是消息数组本身（无损）、不走
`traceToMessages`（不经 trace 重放）。

> ⚠️ **状态值改名（2026-09-28 ①）**：本节（以及本文件其他正文）出现的 `awaiting_approval`
> 一律读作 **`suspended`**，且它的「为什么挂起」由新字段 **`suspendedReason === 'approval'`**
> 承载；引擎 `AgentStopReason` 与 `RunStatus` 的成员名同步从 `awaiting_approval` 改成
> `suspended`。旧→新映射、破坏面与理由见 **§10 2026-09-28 ①**。正文原样保留（体例：只增不改，
> 改名不重写记载它当时的判断）。

**② 为什么回合级全有或全无**：协议要求每个 tool_use 都有配对 tool_result。一个回合里
**任何一个**需审批的 tool_use 没有决定 ⇒ 整回合**一个工具都不执行**、不推任何 tool_result ——
部分执行 + 部分挂起会产出协议上残缺的历史（配不平的 tool_use），恢复时无法重放。
恢复时决定齐了：deny → `tool_result(is_error: true, content: '审批被拒绝：…')`
（**理由回给模型**，可自行换路）；approve → 正常执行且工具体内经 `ToolRunContext.approval`
读到自己的决定（审计 / 分级授权）。两个例外不参与审批：隐藏 `submit_result`（纯内部提交）
与未知工具（走既有 unknown_tool 路径）。恢复后再遇未决 ⇒ 再次挂起（可等多轮）。

**③ 为什么惰性超时（不起定时器）**：`approvalTimeoutMs` 只在 `approve` / `poll`（含
`awaitTask` 的读路径）/ `resumePending` **读到** awaiting 记录时判定 —— 到点自动把全部待决项
写成 `denied, reason: '审批超时'`（`decidedBy: 'system'`）并重派。理由与 2026-09-14 ④ 同源：
「等待的终点」类计时器在空事件循环下会让进程退不出/等待永不结束；而且挂起的任务**不占任何
在飞资源**，一个永远没人读的任务也不该被定时器推着走。代价如实标注：没人读 ⇒ 没人判
（文档写明「惰性」）。

**④ 为什么挂起也 flushSinks**：trace 是一等公民 —— 「挂起段」也是一段真实执行
（模型往返 + 审批请求），它的 trace 必须可观测，否则「任务为什么在等」无从回答。
每段执行一棵独立的新树（`traceId == runId` 不变量不破），恢复段经 `traceContext` link
挂到上一段 runId（复用 2026-09-17 ⑤ 的入站关联机制），观测后端据此把多段连成一条链。
对称地：`TaskSink.onFinished` **不**对挂起开火（它的承诺是「任务达终态」），记忆回写 /
会话追加维持「只成功才写」。

**消费点口径（`awaiting_approval` 这个新状态的全量清单）**：非终态（`awaitTask` 继续等）、
不占并发槽（挂起即释放，`#execute` 正常收尾）、`resumePending` 不捡（它不是孤儿，是在等人）、
InMemory 淘汰跳过（同「在飞永不淘汰」）、幂等键复用（同键重复 submit 返回等待中的任务）、
`Run` 状态机走新加的 `suspend()`（running → awaiting_approval，finishedAt 不置）、
trace 状态记 **ok**（挂起段执行无误，「等人」不该被看板算成失败；区分靠 stop_reason attribute）。

**已知边界（写进 usage-guide §7）**：审批超时是**惰性**判定；挂起段与恢复段是两棵
link 相连的 trace（指标按段计）；**at-least-once**：崩溃发生在「批准后、恢复执行中」时，
副作用工具会重执行（与 resumePending 同口径）；预算口径（maxTotalTokens/maxCostUsd）在
恢复段**重新起算**（新树新账，与 resumePending 续跑同口径）；嵌套能力（@SubAgent/@Skill
的子循环）里的审批工具**不支持挂起整个 run** —— 子循环挂起会以 is_error 交回主 agent
（要审批的能力请放主菜单）；同步 `POST /run` 撞上审批会带着 `awaiting_approval` 返回
（没有人可批的入口 —— 要审批就走 `/tasks` 异步宿主）。

**实现时的两处规格外补充（如实记）**：`AgentRunResult` 除 `suspendedMessages` 外还带
`pendingApprovals`（待决 tool_use_id 列表）—— 宿主必须知道「该批哪些 id」，而它从
suspendedMessages **推不出来**（runner 不知道哪些工具标了审批；待决集合是引擎算出来的）；
`TaskRecord` 除 `approvals` 外带 `approvalPendingSince`（挂起时刻）—— 否则进程重启后
惰性超时与 `approval.decided` 的 `waitedMs` 都没有基准。两者都是纯数据、可序列化、随记录落盘。

**门禁**：`tests/engine/approval.test.ts`（9：挂起形状 / flushSinks 照常 / approved 恢复 +
ctx.approval + waitedMs / denied 回模型 / 混合回合全有或全无 / 二次挂起 / submit_result
绕过与同回合等待 / 通用恢复入口 / 恢复入口尊重 signal）、`tests/transport/approval.test.ts`
（8：挂起落库 + 槽位释放（concurrency=1 证明）+ onFinished 不开火 / 恢复成功 + trace link /
逐 id 幂等（第一次赢）+ 决定不齐不恢复 / 404·409 语义 / 惰性超时自动 deny / resumePending
不捡 + 过期判拒 / FileTaskStore 跨进程 / 幂等键复用）、`tests/transport/httpApproval.test.ts`
（6：200 / 400×5 种坏 body / 404 / 409 / 401 / 拒绝路径端到端）、toolkit 透传 1 +
InMemory 淘汰 1。宿主侧全部走**真引擎**（executeRun + mockClient），不用假 app ——
「宿主测试用假实现」的边界是第五轮 review 三条 MAJOR 的共同病灶。

### 2026-09-19 ②：工具超时的「放弃等待」升级为「放弃 + 通知」——`ToolRunContext.abandoned`

**背景**：第八轮复审（engine/runtime 面）抓到观测完整性的破口：子 agent / skill 被
`toolTimeoutMs` 超时后，capability span 要等子循环自己 settle 才收尾 —— 而 trace 在 run
结束时**浅拷交付**（tracer.snapshot 的注释写明「不拷贝就会事后变异已交付的 trace」），
于是交付的那份里该 span 永远没有 `endedAt`、status 停在缺省 `ok`（与同回合
`tool.output` 事件的 `timeout` 记录自相矛盾）；更糟的是子循环在后台继续跑模型请求，
**花费不进任何观测面**（trace / metrics / report 都看不见）。「超时不取消工具」是
有意设计（副作用无法回滚），但「不取消」不等于「不通知」。

**决策**：新增 `ToolRunContext.abandoned: AbortSignal` —— 引擎 `withTimeout` 判超时的
分支里 abort 它（`executeOneTool`）。「放弃等待」的语义不变（不等、不杀 run、tool_result
记 is_error），但工具现在**收得到通知**：想真停的工具监听它自行收尾。框架自带的
@SubAgent / @Skill 已这么做 —— 收到信号即把 `abandoned` 与 `ctx.signal` 合成后透传给
子循环（在飞模型请求被掐掉，后台不再烧 token），capability span **立刻**以
`error`（type: `timeout`）收尾（不等子循环 settle —— 同步于放弃时刻，必在交付前）。
同轮顺手修掉 skill 的相邻缺陷：`ctx.llm()` 失败被用户方法体 try/catch 降级时，span
曾被提前烙成 error（幂等守卫让整体成功的调用翻不了案）—— 现在丰富错误存起来交给
外层 catch 收尾，方法体正常返回就是 ok。

**反向验证**：新用例在旧实现下必红（旧代码没有 `abandoned`，`subAborted` 永远 false，
capability span 永远没有 `endedAt`）。

同轮还修：**Scheduler 的 `at()` / `every()` 挡 32 位定时器溢出**（> 2³¹-1ms 被 Node
静默钳到 1ms ⇒「30 天后」变立即触发 / 周期任务退化成每毫秒空转；构造期抛错，与
`runTimeoutMs` 的防线同款）。其余低危发现（file store 同进程撕裂写、终态落库失败静默、
Scheduler 调度表不落库、`contextPolicy` 不进子循环、MemoryStore 无删除语义、并行子循环
下预算超限量级）**如实登记**进 usage-guide §7，不改行为。

### 2026-09-19 ③：外部复审（四路）收口 —— 这轮的病是「文档承诺了代码没做的事」

四条复审路线（HITL / MCP 连接器 / gRPC 示例 / soak 脚本）对 `be8e942..9469e91` 的指认，
逐条对代码核实后修复（每条带反向验证：摘掉修复 ⇒ 新用例必红）：

1. **`AsyncRunner.approve` 补重入闸 + 真落库再派发**：并发 approve（双击/多审批人）曾在
   store 往返窗口内各自判「决定齐了」、**各派发一次**（与 resumePending 在 2026-09-18 ⑧
   补的闸同一 bug 类，隔一个方法漏了）；且它用着 `#safeSave`（吞错）却在 docstring 里
   承诺「先落库再派发」—— 现在并发共享在飞那次（第一次决定赢，后到者拿到同一份结果），
   落库改真 `store.save`（失败 ⇒ reject 给调用方、绝不派发）。
2. **MCP StreamableHTTP 连接器去掉 `tools/call` 的第二计时器**：`rpc()` 末尾曾无条件
   `guard(...)`，把装配期的 `timeoutMs` 管进了工具调用（stdio 侧没有这层）—— 正是
   2026-09-17 ①「超时单源化」要消除的双计时器。装配期路径（initialize / initialized /
   tools/list）的 guard 不变。顺带：非 SSE 分支的响应 id 改为**等值配对**（原只验
   「id 是 number」，串包时会把别的请求的结果当本次的返回）。
3. **gRPC 示例 `getTask` 补 try/catch**：grpc-js 不接管 async handler 的 Promise，
   store 抛错 = unhandledRejection = 杀进程 —— 示例在教一个会杀进程的写法。
4. **soak 的两处假绿**：采样不足时「跳过内存断言」却照打「内存有界」（静默跳过 =
   假装验过 —— 自家病灶）⇒ 采样间隔随时长缩放、不足硬失败；宽区间失败率断言换成
   **逐笔对账**（每个不可重试故障恰好杀死一个 run ⇒ `failed ≥ 注入数`，超出部分
   ≤ 请求的 0.1% —— 实测 306 vs 306 分文不差）。
5. **文档对齐**：usage-guide 曾承诺同步 `/run` 返回「含 `suspendedMessages`」，
   `toHttpBody` 没有该字段 —— 改文档（要审批就走异步宿主，不补字段：同步路径
   补了也没有可审批的任务记录，给了是误导）。

未修、如实记下：MCP 会话过期自愈的并发互斥（双 404 → 双 initialize，窗口是毫秒级）、
`e2e-mcp.ts` 探测进程缺 try/finally、gRPC 示例 README 缺 `build` 步骤、示例把 `session`
塞进 transport 选项（靠 excess-property 逃逸生效，换 SqliteTaskStore 会翻车 ——
需要框架侧给「异步宿主带 session」的正式通道，是设计活不是顺手修）。

### 2026-09-19 ④：③ 的「未修」清单收口 + 三条一致性修补 + 预算护栏改走廉价 usage

③ 列出的「未修」由作者收口：MCP 会话过期自愈的并发互斥（`reinitialize` 互斥，双 404 共享
同一次重握手）、`e2e-mcp.ts` 探测进程的 try/finally、gRPC 示例 README 的 `build` 步骤，
以及**异步宿主带 session 的正式通道**（`RunInvocationOptions.sessionId` 可序列化引用 +
未配 `sessionStore` 时 `submit` 当场 `TaskInputError`，不再靠 excess-property 逃逸）。
测试链同时修了「框架套件一挂、CLI 与 trace-view 套件静默不跑」的 `&&` 短路
（`scripts/test-all.mjs`：三套件都跑完再汇总退出码）。

本次复审又补三条「守卫没覆盖自己声称范围」的缺口 + 一处护栏开销：

1. **MCP HTTP `close()` 的 DELETE 过 `guard`**：此前直接 `await fetchImpl(...)`，外层
   `catch` 只兜得住**抛错**、兜不住**挂死** —— server 接受连接后不回（半开 / 卡在代理后面），
   `close()` 就永久挂住，而调用方是**宿主停机路径**（挂住比失败更糟，与「best-effort、
   不抛错」的承诺相悖）。fetch 与 body 排空**一起**进 guard：只护住响应头，`readText`
   照样能卡。反向验证：摘掉修复 ⇒ 新用例在 `--test-timeout=8000` 下被
   `cancelledByParent` 取消（正是 `verify-all.sh` 专门抽取的那类非断言失败）。
2. **`asset()` 拦绝对路径**：守卫此前只拦带 scheme 的 `rel`，但 `/etc/passwd` 与
   `file:///etc/passwd` 是**同一类** —— `new URL('/etc/passwd', 'file:///…/x.js')` 解析成
   `file:///etc/passwd`，base 的路径部分被整个丢掉，于是「以为读了能力目录里的文件，
   实际读了别处」（macOS 上**真能读到**）。注释声称的那个不变量现在真的守住了。
   `../` 仍**放行** —— 它是相对 base 解析的，base 没被忽略，两者必须区分开。
3. **`interruptibleSleep` 的判定顺序 —— 查过，结论是「不改」（记下来免得下轮再改）**：
   `ms <= 0` 的早退确实排在 `signal.aborted` 检查**之前**，看着像一致性缺口，但它与
   `withTimeout(p, 0)` 的「不设超时、原样透传」是**同一口径**：预算 ≤0 ⇒ 这次机制
   **关掉**，与 signal 状态无关（取消会在下一步 —— 下一个 fetch / 下一轮循环 —— 照常浮出来）。
   本轮曾按「缺口」把它改反（让已中止的 signal 即使 `ms<=0` 也 reject），被既有用例
   `tests/core/sse-text-stats.test.ts` 当场拦下 ⇒ 已回退。该用例的断言同时从「隐式
   `await`」改成显式 `assert.doesNotReject` 并写明理由 —— 这条语义此前只有一行注释，
   太容易被下一次复核再误判成 bug（`src/core/timeout.ts` 的函数注释里也补了同样的警示）。
4. **预算护栏改走廉价 usage（含一处 API 收窄）**：护栏每回合要判**两次**（回合入口
   `checkTurnEntry` + 回合末 `loop`），而 `recorder.snapshot('ok')` 会**拷**全部 span 的
   attributes/events/links ⇒ 白花 O(回合 × 累计事件量)。现在：
   - 新增 `TraceRecorder.usage()`：只扫 spans 求和、不拷；`snapshot().totalUsage` 改为
     **调它** ⇒ 两条路不可能漂移（`tests/engine/tracer.test.ts` 用 `deepEqual` 钉住）；
   - `core/tool.ts` 的 `RecorderBackend` 加 `usage(): Usage`（引擎经这个结构面读 recorder）；
   - `BudgetGuard.check` 入参由 `Trace` **收窄**为 `{ readonly totalUsage: Usage }`。
     传整份 `Trace` 的调用方不受影响（结构上满足），收窄的附带好处是护栏**在类型上**就
     读不到 `spans` —— 「只看 totalUsage」从注释变成了结构约束。
   - **刻意不合并那两次调用**：两处是不同决策点（回合末那次的结果要交给 `executeTurnTools`
     决定循环是否继续；回合入口那次覆盖「上一回合的工具执行把额度推超」），删任一处都改语义。
     ⇒ 优化的是**每次判定的代价**，不是判定次数。

### 2026-09-20：第九轮复审收口 —— HITL×session 组合破口 + 六条小修

1. **HITL × sessionStore 组合破口（高）**：异步宿主恢复段（`rec.approvals !== undefined`）
   **不再把 `session` 注入 `app.run`** —— 挂起段落库的 `suspendedMessages` 已含
   `loadSession` 拼入的完整会话历史，再注入会让 run 层把 store 历史**再 prepend 一遍**
   （历史翻倍、token 复利）；且成功后 `appendSession` 会把整段扩展历史（含未决 tool_use
   的 assistant）写进会话 —— 违反「只存对话轮次」不变量，留下孤立 tool_use + 连续两条
   assistant，下一轮该会话直接撞 API 400。恢复段的会话回写改由 `AsyncRunner` 自己补：
   挂起时（overwrite `spec.messages` 之前）快照「本轮用户输入」到进程内 Map
   （`sessionInputs`，只在首个挂起段快照 —— 恢复段再挂起时 `spec.messages` 已是扩展历史，
   原快照不能丢），恢复成功后 append「用户输入 + 最终回复」（口径同 run.ts 的三条不变量，
   占位文案同 `EMPTY_REPLY_MARK`）。**取舍**：快照只在内存 —— 进程崩在「挂起 → 重启 →
   approve」之间会丢这一次回写（会话少一轮，但绝不写进坏历史；审批决定本身已落库）。
   快照落库要动 `TaskRecord` 的序列化 schema（sqlite/redis），相对审批决定它只是
   锦上添花，故不动 schema。
2. **惰性审批超时补重入闸**：`#expireAndResume` 与 `approve` **共用同一把** per-taskId
   在飞闸（`inflightApprovals`）—— 异步 store 的 `get` 返回新副本，两个并发 poll
   （或 poll 与 approve）各自看到 awaiting 快照 ⇒ 双双填超时拒绝 + 双双派发。进闸后
   **重读一遍** store 再判：闸只互斥「进入」，挡不住「进闸前已取到的旧副本」。
   approve 撞上在飞的超时恢复时共享其结果（与人的决定竞速，先到先得）。
3. **StreamableHTTP MCP 连接器透传 `abandoned`**：`callTool` 接第三参并透传到
   `rpc`/`post` 的 `fetchImpl(url, {...init, signal})`（含会话 404 自愈重试那次）。
   HTTP 侧没有 stdio 的 pending 簿记 —— **掐在飞 fetch 就是清簿记**。此前引擎超时后
   在飞 fetch 泄漏。
4. **Anthropic 流内 error 补 4xx 档**：`invalid_request_error` / `authentication_error` /
   `permission_error` / `not_found_error` → 400（归 api/不可重试），与 openai.ts 的
   `statusOfStreamError` **同口径**（那边 authentication/permission 也归 400，不细分
   401/403）。此前默认 500 → server/可重试：改配置才有救的病因让引擎白重试三轮。
5. **`runTimeoutMs` 超时归 timeout 一类账**：`#raceTimeout` 的裸 `Error` 换成
   `core/timeout.ts` 的 `TimeoutError`（`code='timeout'`）—— 此前落 unknown，
   与「超时自成一类」（2026-09-17 ②）在异步宿主这条路径上两本账。
6. **`FileTaskStore.save` 先落盘后写内存**：旧顺序下落盘抛错时内存已推进 ——
   内存说「已存」而磁盘没有，重启后记录静默回退。
7. **Anthropic SSE 的 content_block `index` 设上限**（1024）：index 是外部输入，
   `blocks[index] = acc` 对超大 index 造稀疏数组，组装的 `for...of`/`reduce` 按 length
   空转（反向验证实测：index=1e9 的用例摘掉守卫后单这一条就跑 30s）。畸形 index
   （超上限 / 负数 / 非整数）响亮抛 `AnthropicApiError(500)`。
8. **`createAnthropicClient` 的 `timeout` 构造期校验**：必须为正有限数（NaN/Infinity
   会被 setTimeout 钳到 1ms，每请求立即超时），与 AsyncRunner 对 `runTimeoutMs` 的
   校验同款。**不改** client 层超时的既有行为（合成信号中止 → 自身不重试 →
   引擎归 timeout 一类账）。

反向验证逐条做过（摘掉修复 ⇒ 新用例红 ⇒ 恢复 ⇒ 绿），证据在各提交的说明里。

### 2026-09-20 ②：`metrics.ts` / `mcp.ts` 纯结构拆分（零行为变化）

review 指出两个超大文件该拆：`integrations/metrics.ts`（1050 行）拆为
`metrics-state.ts`（`MetricsState` 累加/快照/重置）+ `metrics-render.ts`（Prometheus 文本）
+ `metrics-otlp.ts`（OTLP 组装与 flush）+ `metrics.ts`（只留选项校验/定时器/组装）；
`integrations/mcp.ts`（897 行）拆为 `mcp-stdio.ts` / `mcp-http.ts` 两个连接器 +
`mcp.ts`（桥 + 共享 helper + re-export）。全部新文件是同层 module 级 export、**不进公共面**；
`src/index.ts`、既有测试、官网 api.html 一行未改（公共面零漂移即验收标准）。
其余大文件（async / turn / http / module / openai / anthropic）经评审结论为**保持不动**。

### 2026-09-20 ③：CLI 接口面补齐 + **脚手架生产路径修复**（`dist/main.js` 从跑不通到跑通）

起因是「CLI 包写的是不是比较一般」的复查，落到三件事，都属**补丁位**（无破坏性变更）：

**① 脚手架的生产路径此前从未跑通 —— 这是真缺陷，不是优化。** `src/main.ts` 的
`discover` 用的是 cwd 相对字符串（`'src/tools'` 等）：dev（`tsx src/main.ts`）恰好对，
但 `npm run build && npm start` 下它解析到 **`src/` 里的 `.ts` 源码**并去动态 import ——
装饰器不是可擦除的类型语法，Node 直接抛 `Invalid or unexpected token`；换个 cwd 跑则报
「能力目录不存在」。改为**按本文件位置**解析（`fileURLToPath(new URL('<分类>/', import.meta.url))`）：
`tsconfig` 是 `rootDir: src → outDir: dist`（镜像成立），所以 dev 解析到 `src/`、构建后解析到
`dist/`，两边都对且与 cwd 无关。**必须同时过滤不存在的分类目录**：`tsc` 不为空目录产出
`dist/<分类>/`，而 `discover` 对显式给出的不存在路径是**响亮报错**的（那条锁定决定保持不动，
所以过滤放在脚手架侧）。为什么此前 8/8 全绿也没拦住：`scripts/e2e-cli.ts` 只断言 dist 产物
**存在**，从不**运行**它 —— 现补 4e 步用本地假 Anthropic 端点真跑 `node dist/main.js`
（两种 cwd 各一次）+ 断言脚手架的能力真进了模型菜单；反向验证：把模板改回 cwd 相对形态，
该断言即红（`src/tools/echo-back/index.ts: Invalid or unexpected token`）。

**② 命令行契约补齐。** `report` / `diff` / `doctor` 支持 `--json`（stdout 只有一个 JSON 文档、
无人类装饰；出错仍走 stderr + 退出码 1 且 stdout 保持为空 —— 脚本据此区分「有结果」与「没跑成」）。
`diff --json` **不改退出码语义**（有差异仍为 1），只是让「差在哪」也能被读。`harvest` 刻意**不加**：
它的 stdout 本身就是产物（生成的 eval 源码），加 `--json` 会自相矛盾。新增 `--version` / `-v`，
读**包自身 package.json**（不另存常量 —— 常量会漂）。

**③ 命令行从哪来：npx 为主、CLI 进工程。** 脚手架把 `@migor/cli` 写进新工程的
`devDependencies`（走本地 bin：离线可用、版本与框架同批 pin），`dev` script 改指 `agentia dev`
（与 npx 同一条路、带 inspector 面板）—— 为此 `dev` 必须把额外参数**透传**给用户脚本
（`npm run dev -- "问题"` 是文档化用法，不能吃掉）。**首次创建仍必须写带 scope 的
`npx @migor/cli create`**：npm 上另有一个别人的 `agentia` 包，短名会装错东西（实测
`npm view agentia` → `0.0.0`／"AI Agent generator"）。⇒ 发布面随之多一条：`templates.ts` 里的
CLI pin 与框架 pin 是**两条**版本面（漏 bump 会留下与框架漂开的旧 CLI），已进
`scripts/release-surface.mjs` 并在 bump 的计数断言里。

**明确不做**：统一参数解析框架（收益是少几处手写循环，代价是 8 个命令全线回归）；
`harvest` / `diff` 那份「去类型移植副本」的合并（要么破坏 CLI 零运行时依赖，要么动分层守卫，
是独立架构决策）；把四分类目录改成「扫描 `src/` 下所有子目录」（装配顺序是 load-bearing 的，
数组顺序即装配顺序，扫描会把它变成字母序）。

### 2026-09-21：三个 god module 的**纯结构拆分**收尾 —— 判定面有名字、有直测，编排留在原处

**背景**：0.7.1 之后连续出现的竞态都出在同类文件上 —— `transport/async.ts`、`engine/turn.ts` /
`engine/loop.ts`、`transport/http.ts` 这四个「状态机 + 并发 + 编排混住」的大文件。改一处要先在
脑袋里装下整块，出了问题也只能端到端复现。这一串拆分的目的是**把判定面拿出来单测**，而不是把
文件改小。

**纪律（每步都必须满足，否则这一步作废）**：只外移**纯判定**（读参数、回值；不碰 store / 网络 /
时钟 / 回调）；代码**逐字搬迁**，注释跟着走；一步一 PR、squash 合进 main 后下一步再从 main 切；
每步跑全链 + soak；**既有用例一条不改**（改了就不是重构）。

**账（全部当场 `wc -l` 量，不估）**：

- `transport/async.ts`：**910 → 822**（`slot-pool` 895 → `approval-policy` 872 → `drain-gate` 854
  → `resume-policy` 851 → `task-waiters` 822）。
  ⚠️ 这里有个容易记错的基线：910 是**第九轮复审收口之后**（`bfeccec`）的状态，v0.7.1 那个 tag 上是
  813 —— 收口本身把这文件写大了 97 行，拆分是拿收口后的形态当基线的。
- `engine/turn.ts`：**739 → 619**（`stop-reason` 649 → `turn-request` 654 → `tool-context` 646
  → `tool-events` 619）。**其中一步体积反而 +5** —— 抽走的是两个判定，调用点补了类型收窄条件。
  体积不是目标；那一步买的是两个此前零直测的判定（见下）。
- `engine/loop.ts`：**489 → 365**（`run-config` 436 → `loop-result` 384 → `resume-input` 365）。
- `transport/http.ts`：**701 → 630**（`http-shapes` 639 → `http-route` 630）。
  最后一步只缩 9 行 —— if 链改 `switch` 后每个 case 体多缩进两格；忽略空白看真实改动是 38+/47−，
  其余全是缩进。买的是「(路径, 方法) → 分支」这层判定第一次有了名字与 14 条表驱动断言。

**每步买到什么**（这才是这套拆分的产出）：新增 **14 个测试文件 / 127 条直接用例**
（逐文件 `^\s*it(` 计数；全仓口径 +140 条（`tests/` 增量），差额里另有别的 PR 的用例，不记在这套里）。此前只有端到端覆盖的
语义现在逐条钉住了，其中几条是「只在生产里表现」的：

- 审批超时的**基准退化链**（`approvalPendingSince` → `startedAt` → `createdAt`，边界严格大于）
  与**空集真值**；超时兜底**绝不覆盖人工决定**。
- 崩溃恢复的认领判定：**无主（孤儿）记录永远可抢**（这条守卫看着像宽松条件，实际是「崩溃后任务
  还能被捡起来」的唯一依据）。
- 重试闸的 `!emitted`：**吐出去的字收不回来**，已流字一律不重试。
- `maxEventChars: false` / `toolTimeoutMs: 0` 这类**有意义的值**不能被真值判定吃掉。
- 挂起交出的历史是**拷贝**（宿主落库后继续 push 不回写已挂起的结果）。
- HTTP 路由的**三条顺序**：免鉴权组的 405 先于鉴权；其余先鉴权再判方法/路径（不泄露路径是否存在）；
  「方法不对」压过「id 坏了」（`DELETE /tasks/%zz/approve` = 405，不是 400）。

**明确不做**（边界声明 —— 到此为止是判断，不是没做完）：

- **编排本体**：`agentLoop` 的状态机与回合间共享状态、`AsyncRunner` 的在飞闸与「先落库再派发」的
  派发顺序、`http.ts` 的 `drain` 协调。这些互相咬合，再抽一块只是把耦合换个地方放，且抽出去就等于
  把「顺序」这条保证从它原来的上下文里摘掉 —— 而顺序恰恰是它们的全部价值。
- **碰 I/O 与时钟的件**：`readBody`（流读取 + 超限/断开两道兜底）、`waitUntil`（轮询 + deadline）、
  `sseWriter`（背压 + 收口）。搬走它们就不是「纯判定外移」了；底层的等待原语此前已抽过
  （`core/timeout.ts`），这一层没有新的可抽物。
- **`loop.ts` 的 `forkPolicyPerRun` 留在原处**：2 行，per-run 隔离的语义已由 `fork.test.ts` 覆盖，
  抽出去只多一层间接。
- **不为行数继续切**：`loop.ts` 365 行 / `http.ts` 630 行里剩下的是入口 + 编排，没有第 15 块可抽的
  纯件了。

**同期附带**（不属拆分，但同批落地）：CI 在 main 上的 run 不再互相取消
（`cancel-in-progress` 只对 PR 生效 —— 「连合两条后 merge commit 显示 cancelled」是它造成的假象）；
lint 闸门从「只报 error」翻成**零告警**（93 warnings + 12 infos → 0，`info` 级规则在 `biome.jsonc`
升到 warn，因为 `--error-on-warnings` 不覆盖 info）；`@biomejs/biome` 的声明下界对齐 `^2.5.14`
（此前下界比配置与锁文件低一档，非锁文件安装会少报存量 → 「本地绿、CI 挂」）。

**怎么复核这一串**：每步 PR 都带全链 8/8 + soak 的当轮数字（`SOAK_DURATION_MS=30000
SOAK_CONCURRENCY=8 npm run e2e:soak`，报的是「失败与不可重试注入逐笔对账」那一行）；反向验证逐条
写在 commit message 里（「摘掉这条修复 ⇒ 哪条用例红」）。

### 2026-09-21 ②：CLI 脚手架模板从「字符串」升级为「真文件」（CODE-REVIEW-2026-09-21 待决策 2）

**背景**：`packages/cli/src/templates.ts` 把生成给用户项目的 `main.ts` / 能力文件 / tsconfig /
package.json 全部写成字符串模板。字符串不过编译器 —— 模板代码对仓库自己的 typecheck/lint
不可见，discover 路径「生产必崩」缺陷就是这么漏到 0.7.2 的（e2e-cli 的 4c/4d/4e 是事后补的
门禁，发现时机太晚）。

**决定**：模板变成 `packages/cli/templates/` 下的真文件（按生成物的目录结构摆放），被仓库
工具链全程照看：

- **占位符纪律**：token（`__PROJECT_NAME__` / `__NAME__` / `__CLASS_NAME__` /
  `__METHOD_NAME__`）只许出现在**字符串 / 注释 / 标识符**位置 —— 这样模板文件自身就是
  合法 TS/JSON，能过 tsc 与 Biome。标识符位置（类名/方法名）用大写下划线 token，它们本就是
  合法标识符。
- **纳入工具链**：`packages/cli/tsconfig.templates.json` 把 templates/ 纳入 tsc（挂在
  build 里，选项与生成物 tsconfig 同口径），`'@migor/agentia'` 经 paths 映射到框架 src
  （同根 tsconfig.tests.json 对 examples 的做法），无需在 templates/ 里 npm install；
  Biome lint 照常收。
- **Biome 只关 formatter**（`packages/cli/templates/**`）：生成物字节是与存量项目/e2e 断言的
  兼容契约（逐字节零漂移），而 Biome 排版与契约不一致（tsconfig 模板的多行数组来自
  JSON.stringify 的既有输出）—— 排版由「渲染产物逐字节对拍」守门，不由 formatter 重排。
- **点文件用无点文件名**（`gitignore` / `env` / `env.example`，create 写出时才补点）：
  `.env` 会被仓库根 .gitignore 吞掉（进不了版本库），`.gitignore` 会被 npm pack 静默剥掉。
- **运行时读取**：`templates.ts` 从 `dist/templates/`（构建时 copy-assets 整树拷入）读文件 +
  replaceAll 渲染；导出函数签名不变，`packages/cli/test` 一行未改全绿。
- **版本发布面搬家**：两条 pin（框架依赖 + CLI devDependency）从 templates.ts 落到
  `templates/package.json`，`scripts/release-surface.mjs` 清单的路径与正则（单引号 →
  JSON 双引号）已同步，`tests/scripts/release-scripts.test.ts` 夹具同步 —— 这是本迁移
  最容易漏的一处，漏了 bump 就改不到新版本。

**零漂移判据**：一次性对拍脚本（不进仓库）对旧字符串模板与新文件方案的全部渲染产物
（项目级 9 件 + 4 类能力 × 5 个 kebab 名）逐文件 diff —— 为空；e2e-cli 全链绿。

### 2026-09-21 ③：**出站链路传播**落地 —— 解开 spec 自己写下的一处自相矛盾

**背景**：弱方向审计把「出站 `traceparent`」点为全仓唯一「语义已定、只差实现」的开放项。
动手时发现 §9.2 的两句话互相打架：`:135` 锁定「span 句柄**不放** `RunContext`」（理由是并行的
工具调用会互相覆盖），`:146` 却把「`RunContext` 暴露当前 span」当成出站的前置件。原句写的
「硬造一个会是假的 spanId」也经不起查。

**两条实测结论（本条的实质）**：

1. **前置件不是 RunContext，是「调用期作用域」。** run 级 ALS 只有一个值 —— `withRunContext`
   是 run 作用域，往里塞「当前 span」必然被并行工具互相覆盖（这正是 `:135` 锁定的理由）。
   正确形态是**每次调用一份**的独立作用域（`src/engine/span-scope.ts`，
   `AsyncLocalStorage<SpanScope>`），三层由粗到细嵌套：run 根（`engine/loop.ts`）→ 本回合
   `llm.turn`（`engine/turn.ts` 包住每次工具执行）→ `capability`（`toolkit/skill.ts` /
   `subagent.ts` 包住自己的方法体 / 子循环）。`RunContext` / `ToolRunContext` / `Span`
   三个契约**一字未改**。
2. **「假 spanId」不成立：OTLP 早就有这条投影。** W3C 要 trace 32-hex + span **16-hex**，
   本仓 id 一律 UUID（去横线 32-hex）。`integrations/otlp.ts` 的 `spanHex` 早就做了
   `replaceAll('-','').slice(0,16)`（注释原文：「不截 collector 会判 `invalid span_id`」）。
   所以那 16-hex 就是**我们已经在发给 collector 的 span 身份** —— 出站复用同一份投影，
   下游看到的 span id 与 collector 里的是**同一个数**。反过来，出站若各写一份，同一次调用
   在两个系统里就是**两个 span id**，那是跨系统关联最不能出的错。

**决定**：

- 投影**单源化**到 `core/trace.ts`：`wireTraceId` / `wireSpanId` / `formatTraceparent`，
  与 `parseTraceparent` 同处（一个解析、一个生成）。`integrations/otlp.ts` 删掉自己的私有
  副本、改为 import（`integrations → core` 是既有边）。断言随之改为引用单源
  （`tests/integrations/otlp.test.ts`），「导出 id === 出站 id」被机器钉住。
- 公共面**只加一个**：`currentTraceparent(): string | undefined`。flags 恒 `00` ——
  本框架不采样，不替下游声明「已采样」（入站解析器也从不读 flags）。
- **只给读取器，不做自动注入**：框架不创建出站请求（模型客户端那次调用不该带我们的
  traceparent），注入是宿主 `fetch` / metadata 里的一行 —— 与「webhook 后置、用 sink + 用户
  fetch」同一条既有决策。
- **如实标注的边界**：`run` 根 span 由 `runAgent` 打开 ⇒ 更早的 `contextInit` /
  记忆水合取到 `undefined`（那时确实还没有 span 可指）。写进 usage-guide §7 边界表。

**取舍（被否方案）**：把 span 塞进 `RunContext`（并行覆盖，见上）；给 `@Tool` 加第二参
`ctx`（`toolkit/tool.ts` 现在 `Reflect.apply(…, [input])`，要改成公开签名破坏 + 违背
「ctx 不层层下传」的既有取向）；把 spanId 生成改成 W3C 原生 16-hex（会与既有投影并列成
两套口径，且历史 trace 对不上）；另发一对 W3C id 记进 attributes（一个东西两个 id）。

**门禁**：`tests/engine/spanScope.test.ts`（往返闭环 / 并行不串 / 嵌套到 capability /
run 结束不残留）+ `tests/core/trace.test.ts` 的投影组 + otlp 单源断言；反向验证见设计文档
`docs/plans/2026-09-21-outbound-trace-propagation.md` §5。**不加 verify-all 步数**。

### 2026-09-21 ④：发布面清单的 lock 项改为**按包名锚定** —— 裸 version 计数会被同版本依赖撞网

**背景**：发 0.8.1 时 `check-release.mjs` 报「package-lock.json：4 处应为 0.8.1，实际命中
5 处」。逐条查：第 5 处是 `@grpc/proto-loader`，一个**恰好也是 0.8.1** 的第三方依赖 ——
清单那条用的是裸 `/"version": "(\d+\.\d+\.\d+)"/g`，按**值**计数，所以任何依赖与本次发布
版本号相同就会撞网，且报错文案读起来像「清单漏了一项」。

**决定**：改成**按包名锚定** ——
`/"name": "@migor\/(?:agentia|cli|trace-view)",\n\s+"version": "(\d+\.\d+\.\d+)"/g`，仍是 4 处
（顶层 + 根 + `packages/cli` + `packages/trace-view`），但每处都带自己的包名。两条副产物：
① `@migor/website`（`private: true`、版本恒 `0.0.0`）本来就不该在网里，锚定后按构造被排除，
不必再靠「恰好不同版本」侥幸；② 第三方的同版本号**永远**不会进网，撞车不再假红。

**门禁**：夹具里加了同版本**诱饵**（`node_modules/@grpc/proto-loader` 写成本次发布版本），
断言 bump 既不改它、也不把它算进发布面（`tests/scripts/release-scripts.test.ts`）。这正是
「多命中 = 有不认识的东西也叫这个版本号」那条设计意图的照妖镜 —— 原夹具只放了 1.3.0 的
`left-pad`，撞不上，所以这个坑一直没被夹具照到。

### 2026-09-21 ⑤：外部双模型复核（Claude × GPT）逐条复现 —— 7 条全部成立；改的过程中又照出 2 条真缺陷

**背景**：外部把同一份仓库交给两个模型独立审查，交回一张评分表（内部工程 / 发布稳定性 /
生产就绪度）与 7 条问题（4 条 P1、3 条 P2），并自称另有 5 条「证伪」。处理口径：**不采信任何
一侧的结论，逐条自己复现定性**；成立的改成带回归用例的代码，证伪的说清理由。

**逐条定性（7/7 成立，且全部落在「静默」这一类）**

| # | 复现结论 | 修法 |
|---|---|---|
| 1 | OTLP/JSON 的 enum 发的是**名字符串**（`status.code: 'STATUS_CODE_OK'`），规范要求整数枚举 | 改整数 1 / 2；并加一条「**扫整个 payload 不得出现任何 `*_CODE_*` 字面量**」的断言 —— 堵的是「断言跟着实现一起写错」这个**假绿机制**，不只是这一次的取值 |
| 2 | 异步 store 下同键并发提交**两次都执行**（实测 `app.run` 调用数 2） | 见下「认领表」段 |
| 3 | `maxRetries` 收 NaN / Infinity / 负数 / 小数 | 新建 `src/integrations/adapter-options.ts` 的构造期判定，两条适配器**共用一份**（`0` 放行 —— 「不重试」是有意义的值） |
| 4 | 重复构建保留**已删除能力**的产物 | 模板 `build` 先清 `dist/`（`packages/cli/templates/scripts/clean.mjs`）；仓库自身 `build` 同享一份 `scripts/clean-dist.mjs`（只清本次要建的那棵树，避免踩同仓作业的别的 agent） |
| 5 | MCP 已中止的调用**照样发请求**，且返回的 Promise 永不 settle | 判据移到 `write()` **之前**，以 `AbortError` 收场（`core/timeout.ts` 新导出 `abortError`，与 `interruptibleSleep` 共用形状 —— 取消不是超时） |
| 6 | `metricsSink.reset()` 破坏 CUMULATIVE 语义（同一 startTime 下 counter 2 → 1 倒退） | `MetricsState.windowStartedAt` 成为窗口起点的单一真源，`reset()` 把它前移（`max(now, 前值 + 1)` —— 同毫秒连按两次也**严格**前进） |
| 7 | **HTTP 200 不等于全部接收**：collector 的 `partialSuccess` 被读成成功 | 新建 `src/integrations/otlp-partial.ts`：判据是「**真拒收**（键在场且值 > 0）**或**非空 errorMessage」——`{}` 与 `rejectedSpans: 0` 是「全部接收」的另一种写法（有 collector 恒发）；traces 侧新增 `onExportError` 选项（`TraceSink` 的失败缺省是**静默**的，「少了一半数据」得有出口） |

**第 2 条为什么不是「加一句 await」**：`submit` 是**同步门面**（`poll` / `byIdempotency` 同），
异步 store 交回的 `byIdempotency` 是 Promise —— 门面等不了；而 `#executeInner` 只采纳**已
succeeded** 的既有记录（queued / running 不采纳，重复执行本就是 at-least-once 允许的行为）。
所以补法是在 `#execute` 的**同步前段**加一张**进程内认领表**（`#claims`）：`submit` 先查在飞
认领并直接返回它 ⇒ 两次连续 `submit` 之间没有窗口。

**修复本身带出的新缺陷（第 8 条，本轮唯一一条不是外部报告的）**：认领**只在终态释放**
（挂起还在等人，放了会让同键另起一个任务），而 HITL 的恢复段是**另一次** `#execute`
（`approve` 从 store 读出的、异步 store 交出的还是**新副本对象**），那次 `claimed` 必为
`false` ⇒ 释放判据若只看 `claimed` 或只比对象同一性，挂起过的键就**永久钉在认领表里**
（同键再也不执行 + 表无界增长）。判据改为按 `taskId` 比对（`#claims.get(key)?.taskId === rec.taskId`）。
**反向验证**：把判据退回 `claimed` 标志或对象同一性 ⇒ `tests/transport/async.test.ts` 的
HITL 用例立刻真红（3 条红）。

**第 9 条（由「改成字面跑 `npm run build`」这个决定照出来）**：把 e2e 的构建步骤从「测试复刻
`clean → tsc → copy-assets` 三步」改成**跑产物自己的 `npm run build`** 的当场，第一步就
`MODULE_NOT_FOUND` —— 模板目录里有 `scripts/clean.mjs`、`packages/cli/templates/package.json`
的 build 脚本也引用了它，但 `create.ts` **忘了把它写出去**。也就是说：**这一轮此前给模板加的
「清 dist」在生成的项目里从未存在过**，新工程 `npm run build` 第一步就崩（而当时所有单测都是绿的
—— 它们问的是「某个模板函数返回了什么」，没人从模板目录出发反问「谁用了它」）。修法与配套：
① `create.ts` 真写 `scripts/clean.mjs`；② `e2e-cli` 第 4c/4d 步改成**字面跑产物自己的
`npm run typecheck` / `npm run build`**（依赖解析靠 `node_modules` 里的 `@types` 与 `.bin/tsc`
软链，不再由测试拼 tsc 命令、也不写 overlay tsconfig —— 这正是 AGENTS.md「测产物要用产物自己
的输入」那条硬约定）；③ 新增 `packages/cli/test/templates.test.mjs` 的**双向引用守卫**（模板文件
必须被引用 / accessor 必须有**调用方**（掐掉 import 语句后判）/ renderTemplate 路径必须存在）；
④ 去掉「build 脚本字符串里含 `clean.mjs`」那条**字面量断言** —— 它会在合法重构（换文件名/换写法）
时误报，而真删真建的行为断言不问实现细节（反向验证：摘掉模板 build 里的清 dist ⇒
`SMOKE FAIL: 重复构建后仍留着已删除能力的产物`）。

**边界（如实写进 usage-guide §7）**：本轮修的是「**同进程内**并发提交」这一档。跨进程并发、
以及终态之后重提同键，仍是 at-least-once —— store 的 idem 索引是 **last-wins**
（redisStore / fsStore / sqliteStore 头注释同口径），而异步 store 下 `submit` 的同步快路
走不了 thenable。要严格一次得靠副作用自身幂等，或在 store 上做唯一约束（那是 store 的契约面，
不在本轮）。

**门禁**：登记进 `docs/guards.md` §1 四条（OTLP enum + partialSuccess、CUMULATIVE 窗口起点、
模板重建清 dist、幂等键的进程内认领），并把 `maxRetries` 的坏值矩阵并进既有的适配器对拍行。
反向验证逐条做过：OTLP enum 退回字符串（2 条红）、去掉 MCP 早退（1 条红）、窗口起点退回常量
（1 条红）、`maxRetries` 退回 `typeof x === 'number'`（2 条红）、认领表三种退法（1–3 条红）。

**报告自称「已证伪」的 5 条**：本轮**抽查 3 条**并给出证据 —— ① `FileTaskStore.list()` 是 Map
插入序（首次见到该 task 的顺序），**确定且稳定**（无任何语义依赖它排序）；② OpenAI 适配器读
`choices[0]` 而请求恒 **n=1**（从不请求多补全），读首项即全部；③ MCP `close()` 的「返回即子进程
已终止」已有 `mcpConnector.test.ts` 的 15 条变异电池覆盖（含忽略 SIGTERM 的顽固子进程）。
另 2 条（UUID 碰撞、HITL compaction）**未独立复核** —— 不替它们背书，也不当结论引用。

### 2026-09-21 ⑥：**增量 trace 出口**落地 —— F3 两条后置项收口

**背景**：F3 当初给了两条「后置」理由 —— SSE 事件粒度只做 `text.delta` + `run.end`
（「B 需要把 trace 事件实时外推，架构代价大」），以及异步任务流式
（「需要 run 进度跨进程，属『run 内事件流』，不在本期」）。今天读代码发现**真实前置件**
不是「写一个 SSE 端点」，而是**记账面没有订阅缝**：`TraceRecorder` 唯一出口是收尾的
`snapshot()`，全仓 `onSpan|onEvent|onTrace|subscribe` 零命中 ⇒ 端点无论怎么写都只能轮询 store 猜进度。

**决定**（分叉与取舍见 `docs/plans/2026-09-21-incremental-trace-export-and-sampling.md`）：

1. **机制只动一处**：`TraceRecorder.subscribe()` 派发记账事件（5 种：span 开/合、事件、属性、链路），
   engine 零改动（记账点唯一）。四条纪律：同步派发不 await、订阅者抛错被吞、无订阅者零派发、
   **`seq` 每次记账动作都占号**（先自增再判订阅者 —— 否则「订阅晚的人」与「一直订阅的人」
   看到的序号不一致，重放/去重全错位）。
2. **两条缝，不是一个**：`TraceSink`（收尾拿整棵、会投递、有兜底）与 `onTraceEvent`
   （运行期逐笔、**不保证送达**）。不把增量塞进 sink 契约 —— 那会让既有 sink 重新理解
   「可能收到半棵树」，是纯迁移成本。
3. **单次 + 应用级 = 叠加**（应用级在前），**不是覆盖**：观察者注册不是值覆盖，
   覆盖会让「某次 run 顺手传了个面板回调」把应用级那条静默顶掉（可观测性的静默回退）。
   合成后是一个订阅者 ⇒ 合成函数内部各自 try/catch（否则前一条抛错吞掉后一条）。
4. **传输层两个出口**：`POST /run` 的 SSE 追加**一族** `trace.event` 帧（既有三帧逐字不变；
   取一族而非每类型一帧 —— 将来加类型老客户端只是漏一种 type，不是漏一种帧名）+
   新增 `GET /tasks/:id/stream`。后者的三条语义各有一个容易写错的地方：
   **流序号 ≠ recorder 的 `seq`**（一个任务可跨多个 run 段：HITL 挂起→恢复、崩溃重投，
   每段 `seq` 从 1 重来）、**`awaiting_approval` 不是终态**（与 `resume-policy` 那个
   「可续跑」判定刻意相反：批了会接着跑，流得开着）、**背压/断开不 abort 任务**
   （读者是旁观者；对照 `/run` 的 SSE —— 那里的下游就是 run 的所有者）。
5. **不变量钉成一条用例**：把一次 run 的全部事件按 `seq` 折回，必须**逐字等于** `snapshot()`
   —— 不丢 / 不重 / 顺序 / 同源，四件事一条用例。反向验证（实测）：摘掉 `setAttribute` 派发
   ⇒ 6 条红；摘掉 `end` 派发 ⇒ 5 条红；把 `seq` 自增挪到订阅者判断之后 ⇒ 那条红；
   不重放 / 不调 `markDone` / 跨进程不明示 ⇒ 各有一条红。

**实现中发现并修掉的两件事**（都不是设计里写到的）：
- **终态收口必须有广播**：`markDone` 只置标志的话，**实时**订阅者永远等不到收口
  （SSE 一直挂着，客户端以为任务还在跑）⇒ 订阅接口带 `onDone`。这是 HTTP 用例先红出来才补的。
- **端到端用例必须 `closeAllConnections()` 再关服务器**：SSE 是长连，响应结束后 socket 留在
  keep-alive 池里 ⇒ 只 `close()` 会让 `server.close()` 的回调**永远等不到**
  （用例全绿但进程不退出，表现为「跑测试的命令挂着不动」）。

**非目标**：事件落 store 的真跨进程实时流（写放大：实测事件数 = 2 × 工具调用、正文 KB 级，
宿主自己的总线是它的家）；`GET /tasks/:id/stream` 的鉴权新策略（沿用既有路由组口径）。

### 2026-09-21 ⑧：**guards §2 的三条待守形状一次清空** —— `0` 的语义真源 / 转发漏字段 / 队列配方门禁

**背景**：`docs/guards.md` §2 是「已知缺口 —— 下一次 review 从这里开始」。本轮把其中三条
（含一条伴随行）建成了机器守卫，只剩「首屏 0 反射」那一行（它要先把「反射式 DI」写成可判定
的定义，值不值得当门禁还得先定）。

**① `0` 的双重语义 → 单一真源 + 集中用例。** 新增 `src/core/limits.ts`：15 个旋钮的 0 语义
登记成**可执行的数据**（`unlimited` / `disabled` / `immediate` / `invalid` 四类），
`tests/limits.test.ts` 拿这张表**逐条驱动真实站点**对账（探针是 `Record<LimitKnob, …>` ⇒
新旋钮不归类就 `typecheck:tests` 红）。

*动手时才看清的两件事*（都是本轮新发现的，此前没人登记）：

- **`intervalMs` 是同名反义**：`Scheduler.every` 要求「必须 > 0」（0 是配置错误，`setInterval(0)`
  会退化成每毫秒空转），而 `metricsSink` 的 `intervalMs: 0` 是「关掉定时器、每次累加后立即导出」。
  两个同名旋钮两种读法，此前只活在各自的注释里。
- **「数量」类旋钮里 `mapWithConcurrency` 是唯一的例外**：它取 `0` 读作「不限」，而
  `maxRetries` / `maxEvents` / `maxIterations` 取 `0` 都读作「就是不做」。四类的划分不是为了
  整齐，是为了让「哪个词在哪读成什么」一眼可查 —— 上一个事故就是这么来的（
  `handler.drain({ timeoutMs: 1 })` 跨过 deadline 后永不返回）。

**② 转发漏字段 → 穷尽转发类型。** 新增 `src/engine/forwarded.ts`：那七个「嵌套能力必须原样
往下交」的旋钮收进**唯一取值点** `forwardToolContext(ctx)`，映射类型要求七个键全必填 ⇒
`toolkit/subagent.ts` / `skill.ts` 里两处手写清单（各处七八行 `ctx.X,`）删掉，改为
`...forwardToolContext(ctx)`，**没有可漏的地方**。另加类型层守卫：`ToolRunContext` 的每个键
必须在「转发」或「引擎自装配」里归类，否则 `tests/types/forwarding.types.ts` 编译失败。

*为什么值得单独立件*：那个历史事故（漏 `toolTimeoutMs`）的后果是**反的** —— 子循环
`withTimeout(p, 0)` 等于永不超时，同时 MCP 桥又起自己的 60s 兜底，回到双计时器双账本。
而 TS 对「少写一个可选键」不报错，`exactOptionalPropertyTypes` 只堵住「显式传 undefined」
那一半 —— 这条缝只能靠映射类型 + 归类穷尽来堵。

**③ 队列消费者配方 → 真跑的门禁。** `docs/usage-guide.md` §6.4 那条二十行样板（Kafka /
RabbitMQ / SQS 的形态）此前**没有任何 gate 真跑过**。新增 `tests/transport/queueConsumer.test.ts`：
内存版 broker（at-least-once：ack 前不删 / 未 ack 与 nack 一律重投 / `crash()` 模拟崩溃）+
真 `AsyncRunner` + 真引擎，把配方的三条承诺逐条跑出来 —— ① 同键重投不重复执行（断言的是
**副作用计数**，不只是 taskId）；② 崩在 ack 之前重投仍不重复执行；③ `traceparent` 随
`spec.options` 落库，**他进程 `resumePending` 续跑那次 run 仍带得上同一条 link**；
④ 失败不 ack ⇒ nack 重投 ⇒ 二次成功（且失败的键**允许**新任务，否则重投永远拿不到第二次执行）。

*为什么放在 `npm test` 而不是新起示例工程 + e2e 脚本*：① `scripts/verify-all.sh` 的**步骤数写在
CI 必需检查名里**（「verify-all 8 步」），加检查一律折进已有步骤，本文件落在第 6 步、零接线；
② 真 broker 要起 Kafka/RabbitMQ，而这条配方真正的风险不在协议实现，而在**提交位移与幂等的
时机** —— 那正是内存 broker 能确定性钉住的部分。gRPC 那条仍是示例 + `scripts/e2e-grpc.ts`
（它是第 4 个宿主，要验的是协议面）。

**门禁**：`tests/limits.test.ts`（16 条）· `tests/engine/forwarded.test.ts`（4 条）·
`tests/types/forwarding.types.ts`（类型层）· `tests/transport/queueConsumer.test.ts`（4 条）。
**不加 verify-all 步数**。三条形状从 guards §2 移入 §1.2 / §1.3。

### 2026-09-21 ⑦：**记录成本与采样**收口 —— §9.4 从「开放问题」变成决定；`traceparent` flags 的理由换掉

**背景**：§9.4 的唯一开放项是「全量记录成本 vs 截断/采样默认阈值」，长期只有一句
「宿主自己截断/采样」兜着。今天先量（`npm run bench:trace`，零 token 零网络，进仓可复现）：
成本 **90%+ 是事件正文**、每次工具调用 +1.3~1.8 KB；真正会失控的是宿主**显式打开**的
`maxEventChars: false`（大出参下 **13.66×**）与长跑；而**事件数量在框架侧没有任何上限或计数**。

**一个被自己推翻的初始判断（写下来免得下一轮重犯）**：原本打算在框架里加 `samplingSink`。
读代码后否掉 —— `docs/observability.md` §0/§4 早已写死「采样不内建、是配方 2.3」，
且 `examples/observability` 已有成品 `sampleSink`（确定性哈希 + 失败必留 + fanOut），
再造一个就是**同一件事的两份实现**。所以「框架缺一个采样器」是**假缺口**；
真缺口只有两条：采样率**没有依据可算**、被丢掉的那部分**没有任何计数**。

**决定**：**默认全量记账 + 截断默认开 + 采样留在缝外 + 代价可数**。
新增只有一件框架侧的东西：`traceLimits.maxEvents`（整条 trace 的事件总数闸）——
超限即**停止记账**，run 根上留**两笔** `trace.truncated`：**起点标记** `{limit}`（断点在这里，
第一笔丢弃那一刻写下）＋**收尾摘要** `{droppedEvents, limit}`（交付时的最终计数）。
两笔**同时**进交付的 trace 与 `onTraceEvent` / `subscribe` 增量流，所以「按 `seq` 折回**逐字等于**
`snapshot()`」这条折叠契约在截断下**无例外地**成立（**不静默**，与 OTLP `partialSuccess`
那条同因；定案与实证见 §10 2026-09-28 ⑨）。**不做**环形缓冲：中间空洞比「尾巴截断」难解释得多。
与 `maxEventChars` 的分工写死：**一个管「多长」、一个管「多少」**，各有各的家
（正是本仓在收的「一个词两个语义」那种债，不能再造一个）。
配套：`observability.md` 2.3 补**容量换算表**（实测数字 → 每日量 → 倒推 `rate`），
示例的 `sampleSink` 补 `dropped()` / `onDrop`（不数的话「被采样掉」与「本来没跑」
在监控上无法区分）。

**同日的连带更正（flags 口径）**：`core/trace.ts` 里 `formatTraceparent` 的注释写的是
「本框架**不采样**（每次 run 全量记账），故没有『已采样』可声明」—— 在采样成为明确推荐配法后
这句话字面上不再成立。**但不能顺手把 flags 改成跟随采样**：记录/导出决策发生在 run
**收尾之后**（采样闸门要看完好整棵 trace 才判得出来），而出站调用发生在**运行期** ——
那时还没有答案。所以恒 `00` 是唯一不撒谎的选择，理由升级为**运行期不可知**。
另写死一条：**采样采的是导出，不是记账**（被采样掉的 trace 在框架内仍完整记账），
所以别拿「有采样」当「可以少记账」。

### 2026-09-22 ①：**e2e 端口 TOCTOU 的修法被取代** —— 删 `startExampleRetrying()`，改 `PORT=0`（补 2026-09-14 那条的取代记录）

**背景**：本文件 2026-09-14 的「附」记的是 `e2e-deploy` 端口 TOCTOU 的修法 —— 新增
`startExampleRetrying()`，**只对端口争用**换端口重试（3 次），并用「占住一个端口 +
把 `freePort()` 注入成第一次返回它」证明了它。那条记录**写下时是如实的**；但它描述的修法
此后被取代，而 §10 的规矩是**追加不改写** ⇒ 缺的是**这一条取代记录**，不是去改旧条目。
（判定方法记一笔：旧段落里引用的符号去全仓 grep，若只剩历史文档提到它，那段记的就是**已死的修法**。）

**决定**：`freePort()` 与 `startExampleRetrying()` **一并删除**；两条 e2e 链
（`scripts/e2e-examples.ts` / `scripts/e2e-deploy.ts`）改 `PORT: '0'` + 解析**就绪日志**里的
实际端口（`/\[boot\] listening on :(\d+)/`，30 s deadline），示例侧打 `server.address().port`
—— 与 `e2e-grpc` 早已确立的形态同构（见 `docs/guards.md` §1.3 那条：`PORT=0` 由服务自报端口）。

*为什么「换端口重试」是错的*：它治的是**症状**。根因是「`listen(0)` 探到端口 → `close()`
→ 交给子进程 bind」**两步之间**的窗口；重试只是把撞上窗口的概率压低，还把「启动失败」
这一类**真错误**也裹进重试路径（诊断变糊、可能被掩盖成「多试几次就好」）。让**服务自己
分配端口**（`PORT=0`）是**消除**窗口，不是缩小窗口。⇒ 根因消失后，为它加的重试**一并删掉**：
留着它就是一份「没人知道为什么存在」的补丁。

**原「证明」作废**：那条证明依赖把 `freePort()` 注入成「第一次返回被占用的端口」——
`freePort()` 已不存在，实验**无法复现**。新的证据是 e2e 自身**真跑**（`npm run e2e`，
`verify-all.sh` 第 7 步；本仓既有纪律：测产物就用产物自己的输入）。

**判据**：`grep -rn 'freePort' scripts/` 应为空（仅历史文档可留引用）。

### 2026-09-22 ②：**dev 环补上「驱动 run」** —— 面板四个旋钮 + 脚手架模板破坏性拆分（`app.ts` / `main.ts`）

**背景**：`agentia dev` 此前只能「spawn 时用 argv 定死一次 run，然后看 trace」。于是开发期
真正想做的事一件都做不了：换一句 prompt 要改代码重跑；指定 agent 的工作目录**完全不可能**
（根由工具代码写死）；改文本资产（`system.md` / `asset.md`）**静默无感**；想只调一个子 agent
只能把整份菜单端上去。设计文档 `docs/plans/2026-09-22-dev-debug-loop.md` 把诉求拆成
G1–G5 并逐条实证了缺口（含探针数字），本轮按它的 P0 → P2 全部落码。

**决定一：调试面复用现有 inspector，不新建调试面。**
「面板 / Playground / `report` 的能力排行」三处共用同一份 `@migor/trace-view` 渲染层，
这条既有结论继续成立。新增的只是**输入端**：`POST /run` + 输入条。

**决定二（本轮支点）：**「**调用方**」是 CLI，不是用户工程。**
四个控件（调哪个能力 / prompt / 工作目录 / 多轮）全部落在 `createApp` 与 `app.run` 的选项上
—— 而**谁调用 app 谁就能设它们**。`agentia dev` 自己 import 用户的 `src/app.ts` 并驱动它，
⇒ CLI 就是调用方 ⇒ **用户工程里不需要任何 dev 文件**（只多一个**数据**文件 `dev.config.ts`）。
据此否掉了「往用户工程里写一个 `dev.ts`」的方案：`dev.ts` 是**逻辑**，逻辑副本会漂移
（CLI 修了 bug，各工程里的副本不会跟着修），而 `dev.config.ts` 是**数据**（声明哪个能力
该多轮），数据不会漂移。判据就是这一条 —— 与 D9 否掉「能力收集逻辑抄一份到 CLI」是同一条。

落地形状：
- `src/app.ts`：导出 `createAgentApp({ toolSources?, workdir? })` 工厂 + `CAPABILITY_DIRS`；
  `discover` 的路径按**文件位置**解析（dev 落 `src/`、build 后落 `dist/`），不依赖 cwd。
- `src/main.ts`：薄入口（`loadEnvFile()` → `createAgentApp()` → `app.run`），**不再**直接调 `createApp`。
- `packages/cli/src/dev-runner.ts`：CLI 自己的子进程，import 并驱动用户的 `app.ts`。
  ⚠️ 框架入口必须从**用户工程**解析（`createRequire(join(root,'package.json'))` + `pathToFileURL`），
  不能从 CLI 自己的安装位置解析 —— 装饰器注册表是模块级 `WeakMap`，两份模块实例 = 收集结果静默为空。

**决定三：模板结构变更 = 破坏性变更（按 minor 发）。**
`src/main.ts` 的装配段搬进 `src/app.ts` 是**机械**的，但老工程必须手动改
（不迁移则 `agentia dev` 起不来）。迁移说明进 CHANGELOG。

**决定四：鉴权分两层，零依赖。**
① `Origin` 校验：**缺失 = 放行**（同源导航 / 非浏览器客户端），`Origin: null` = **拒绝**
（沙箱 iframe / `file://` 是明确不可信的一方）；跨源 `fetch` 必带 `Origin` ⇒ 这一层是 CSRF 的那一半。
② **per-session token**：`randomBytes(16).toString('hex')`，**每个端点**都校验。
它的真正作用是挡住**本机其它被攻陷的进程**（它们能 `curl`，不受 `Origin` 约束），
**不是**在补 `Origin` 的洞。携带方式三种：首帧 `?t=` → `Set-Cookie: agentia_dev_token=…;
Path=/; HttpOnly; SameSite=Strict`；preload/脚本走 `x-agentia-token` 头；后续面板请求走 cookie。
比较用 `timingSafeEqual`。

**决定五：watch 收编进 `dev.ts`，「重启」只有一个主人。**
旧实现把「文件变 → 重跑」交给 `tsx watch`，同时面板又能触发重启 —— **两个主人**。
新形态：`tsx` **不带 `watch`** 启动 CLI 自己的 runner，重启路径**只有一条**（`dev.ts` 决定）。
判据是**允许清单**（`WATCH_EXT`）而不是排除清单：`.md` **必须在**里面 —— 文本资产不在 tsx 的
import 图里，旧实现因此对它们**静默无感**（这就是 G3b 的实测结论）。同时按目录排除
`node_modules` / `dist` / `.git` / `.agentia` / `coverage`：`.agentia` 那条不是洁癖，
dev 环自己每轮多轮对话都往 `.agentia/session.json` 写一次，一旦进 watch 范围就是
「每次 run 重启一次子进程」的自噬循环。

**重启与「不重启」的边界（刻意不对称）**：
- 改 `toolSources`（能力选择）⇒ **重启进程**。理由**不是贵** —— 实测进程内重建只要 2.6 ms，
  初稿的「几秒」高估约两个数量级；真正拦住进程内重建的是**回收口**：框架没有
  `AgentApp.close()`，MCP 连接器由用户代码持有 ⇒ 进程内反复重建会攒孤儿 MCP 子进程。
  ⇒ 配套约定（写进模板注释）：**进程外资源一律在模块作用域创建并注入**，
  不许在 provider 构造函数里建。这是把「重建 app」解锁成纯 CPU 动作的前提。
- 改**工作目录** ⇒ **不重启**，进程内重建（毫秒级 vs ~0.67 s 重启）。
- 改 prompt / 多轮 ⇒ 不重启。
- 在飞 run 期间要重启 ⇒ **延后到该 run 结束**，不杀在飞的 run。

**决定六：四个控件的口径。**
- **能力选择（D8）**：多选，默认全选；**全选传 `undefined`**（与「不传即全量」同义，
  且省掉一次白跑的孤儿能力告警）；**空集也传 `undefined`**（`toolSources: []` 会收窄到
  **空菜单**，是纯陷阱值）；顺序按**字典序**而非点击序（可复现）；不认识的名字丢弃。
  ⚠️ 许诺要写准：收窄的是**菜单**，不是「只可能调它」—— 其他能力 `tools` 里的显式引用
  仍能调到被排除的能力（`module.ts` 的孤儿告警讲的就是这条边界）。
- **多轮**：由能力**显式声明**（`src/dev.config.ts` 的 `multiTurn: [...]`，数据不是逻辑）；
  文件缺失 ⇒ 全部单轮且不告警；**格式错误 ⇒ 响亮告警**（不静默当空）。混选时初始值取
  所选能力声明的 **OR**，且面板**标出来源**（`多轮·trip-planner`）——「不静默改变行为」。
- **工作目录**：走**现成 DI `deps`** 注入 `WORKDIR`（`ClassProvider.deps` 本来就有），
  **零框架改动**。代价：per-app 而非 per-run（重启式下等价），且不进 `config.*`。
  `ToolRunContext.workdir` 推迟到会话式落地时再评估。
  ⚠️ `discover` 自动注册的 provider **没有 deps** ⇒ 需要注入的能力必须走显式 `providers`。
- **预算护栏**：面板上「点一下 = 一次真 run」⇒ runner 缺省套
  `{ maxCostUsd: 1, maxTotalTokens: 200_000 }`（用现成机制）。**面板不是无限烧 token 的入口。**

**决定七：对话历史（G4）的「两层」读法。**
- **(乙) prompt 回显**：输入框记住打过的 prompt（`↑`/`↓` 调回）。**永远有**，与多轮无关；
  它解决「手」的问题（任务型 agent 的 prompt 几乎不变，要的是 `↑` 调回 + 回车）。
- **(甲) 对话历史**：面板显示整段多轮对话。**跟多轮开关走** —— 没开多轮时**不出现**
  （一次 run = 一句输入 + 一段输出，那个东西 run 列表已经在显示了；凭空多一个对话视图
  会让人以为上个仓库的评审被带进来了）。
- ⚠️ **join 键**：`runtime/run.ts` 只在**成功**轮次回写 session ⇒ **失败的轮次在会话文件里
  根本不存在**。面板必须用 run 根 span 的 `session.id`（`attributes['session.id']`）
  把 run 列表与会话文件对上，否则显示的是**一份少了一轮的对话**。

**本轮结论：P0–P2 全程零框架改动。** 逐项核对：鉴权在 `inspector.ts`（CLI 内）；
模板拆分在模板；watch / 进程管理 / IPC 在 `dev.ts`；能力收窄用现成 `AppOptions.toolSources`；
工作目录用现成 DI `deps`。⇒ **`src/` 下没有一行改动**（`src/core/limits.ts` 那处注释是同日
另一件事）。动框架的只剩会话式那一步（`ToolRunContext.workdir`）。

**同时修掉的两处旧账**：
- **`--import` preload 消失**：子进程现在跑 CLI 自己的 `dev-runner.js`，不再需要
  `NODE_OPTIONS=--import`（连带它那条 Node ≥ 20.6 / ≥ 18.19 的版本闸与字符串拼接一起删了）。
  代价是**顺序变成承重的**：必须在 import 用户 `app.ts` **之前** `await registerTraceSink()`
  —— `createApp` 在构造时就把 `defaultSinks` 快照下来了。
- **模板 `@SubAgent` 的 `system` 改函数形态**（`() => asset(...)`）：值形态在**类定义时**求值，
  于是 `system.md` 要重启进程才生效 —— 而 `.md` 不在 tsx 的 import 图里，连「该重启了」
  都不会提示（静默失效）。通则：**模块加载期读 = 冻；调用期读 = 热。**

**判据**：`env -u NODE_OPTIONS npm test` + `npm run e2e`（`verify-all.sh` 第 6/7 步）。
新增守卫见 `docs/guards.md` §1.4：面板纯逻辑可单测（`panel-logic.ts` 零 DOM）、
`shouldWatch` 允许清单与目录递归、模板能力名 snake_case 一致性。

### 2026-09-22 ③：**dev 环真跑一次抓出两个缺陷** —— 门禁全绿不等于没洞

上一条的落码在 `verify-all.sh` 8/8 全绿的状态下收尾。但复核时注意到一件刺眼的事：
`rg -ln "agentia dev|dev-runner" scripts/*.ts` **返回空** —— 本轮改动里最大的一块
（`dev.ts` / `dev-runner.ts` / `inspector-page.html`）**一条守卫都没有**；`e2e-cli` 只断言了
生成物 `package.json` 里有 `dev` 这个 script 名。于是写了个真跑探针，一次就抓到两个真缺陷。

**缺陷一：`npx` 吞掉 IPC 通道（静默，且退出的形状像「成功」）。**
子进程原本是 `spawn('npx', ['tsx', runner])`。`npx` 是个**包装器**：它自己再 spawn 一层，
而**不给孙进程转发 fd 3 的 IPC 通道**。后果不是「启动失败」而是**静默**：runner 里
`process.send` 变成 `undefined`，而代码写的是 `process.send?.(msg)`（可选链）—— 所有协议消息
被无声丢弃：面板永远等不到 `ready`、`POST /run` 永远回不来；更坏的是没有 IPC 通道之后
事件循环无事可做，进程以 **`code=0` 干净退出**，看起来像「用户代码自己跑完了」。
三方对照（同一个 hello 脚本，实测）：

| 启动方式 | `typeof process.send` | IPC |
|---|---|---|
| `node whoami.mjs` | `function` | ✅ |
| `npx tsx whoami.mjs` | `undefined` | ❌（还多出 npx 的 spinner 噪音） |
| `node <tsx>/dist/cli.mjs whoami.mjs` | `function` | ✅ |

**修复**：`process.execPath` + 解析出的 `tsx/cli` 入口直起（`resolveTsxCli()`：**用户工程优先**
—— tsx 是脚手架声明的 devDependency，尊重他们的版本 pin；再退到 CLI 自身解析位置）。
不 spawn `node_modules/.bin/tsx` 的理由是 Windows 上它是 `.cmd` shim，会绕回 `npm-bin.ts`
专门要避开的那个 CVE-2024-27980 坑。

**缺陷二：`.env` 加载留在了 `main.ts`（两个入口两个行为）。**
P0 把模板拆成 `app.ts`（装配）+ `main.ts`（启动）时，`loadEnvFile()` 留在了 `main.ts`。
而 dev 环只 import `app.ts`、**从不执行 `main.ts`** ⇒ `npm run dev` 静默读不到 `.env`，
`npm start` 读得到。这是**静默不一致**的教科书形状：用户看到的是「没配 key」，然后去怀疑框架。
修复：`loadEnvFile()` 挪进 `app.ts`（装配模块是**两个入口都经过**的那条路）。
⚠️ 连带教训：当时 `templates.test.mjs` 与 `e2e-cli.ts` **都有一条断言钉着这件事**，但都指着
`main.ts` —— 断言存在 ≠ 断言钉对了位置。所以两处都改成**成对**写（该在 `app.ts` + 不该在 `main.ts`）。

**顺带补的第三个洞：生命周期里没有「就绪」。**
`DevEvent` 有 `runner-restart` / `runner-error` / `run-start` / `run-done`，**唯独没有 ready**；
而面板加载时只查一次 `/api/dev`，那时 runner 还没装配完（`capabilities` 是父进程的初值 `[]`）
⇒ 能力选择器**空着且没有任何解释**，要等用户先跑一次（`run-done` 才触发刷新）。
新增 `{ kind: 'runner-ready' }`，面板收到即重刷；`runner-restart` 也补了一次刷新。
（这条是写 e2e 时被自己的轮询兜底照出来的 —— **测试里的 workaround 往往是产品缺陷的影子**。）

**修复一个措辞级的误导**：`proc.on('exit')` 在「没等到 `ready` 就退出」时先 `fail()`（reject）
再同步走到 `emit`，而那时 `lastError` 还是 `null` ⇒ 面板收到的是更笼统的
「意外退出」，真正有信息量的那句只进了终端（reject 要到下一个微任务才被调用方的 catch 接住）。
改成先写 `lastError` 再 `fail`。

**新增守卫**：`scripts/e2e-dev.ts`（折进 `verify-all.sh` 第 7 步 = `npm run e2e`，
不加步骤 —— 步骤数写在 CI 必需检查的 job 名里）。四条**行为**断言：能力菜单**精确等于**
`["hello","read-file"]`（菜单是 runner 经 IPC 报回来的 ⇒ 非空才等于 IPC 通了）；run 成功且
`finalText` 来自假端点；收窄 `toolSources` 后**假端点收到的请求体真的变窄**；改 `.md` 触发重启
且能恢复。凭据**只写进工程 `.env`**、进程环境里显式 `delete` 掉 `ANTHROPIC_*`（不删的话
本机 export 过 key 的人会拿到假绿）。**三条修复各做了反向验证**：塞回 `npx` ⇒ 红；
摘掉 `loadEnvFile()` ⇒ 红（打到真端点 403）；去掉 `runner-ready` ⇒ 红。

**代价与教训**：这一轮多花的时间全部来自「改动最大的一块没有守卫」。记进 `guards.md` §2 的尾注：
**「门禁全绿」只覆盖门禁问过的形状。**

### 2026-09-22 ④：**拿功能文档逐项对照做审计** —— 又抓出两处「文档里有、代码里没有」

③ 修完缺陷之后问了一个不同的问题：**不是「测试绿不绿」，而是「文档里承诺的每一件，代码里都在不在」**。
逐条对照 `docs/plans/2026-09-22-dev-debug-loop.md` 的 §5 优先级表与 §6 待定清单，
找出两处**只写在文档里、代码里没有**的条目：

1. **§6 待定 5 的后半 —— 显式 kill 按钮。** 文档建议「拒绝并提示 **+ 显式 kill 按钮**」，
   只做了前一半（在飞时 `POST /run` 回 409）。后果不是小事：**一个卡住的 run 会让面板永久锁死**
   —— 此后每次 `POST /run` 都 409，而面板**没有任何办法**把它解开（只能去终端 Ctrl-C 整个 dev 进程）。
2. **§6 待定 3 —— 对话历史的「清空」入口。** 没有它，一份串味的对话只能手工删 `.agentia/session.json`。

两条都没有前置依赖，所以一直没进 §5 的优先级表（那张表按「依赖 / 爆炸半径」排），
也就一直没被发现「其实还没做」。**这是「按优先级表施工」这种工作方式的固有盲区**：
表外的东西不在任何人的清单上。

**① 中止在飞 run（`POST /run/abort`）。** 走 IPC 让 runner 自己 `abort()`，**不是**父进程杀子进程 ——
理由是 **trace**：`RunInvocationOptions.signal` 是 `toolkit/module.ts` 的**契约字段**（原样送进引擎），
中止后在回合边界以 `stopReason='aborted'` **正常返回**（`engine/loop-result.ts` 的 `abortedResult()`）
⇒ trace 照常落盘。杀进程那条路会把这次 run 的 trace 整个丢掉（trace 是收尾才 POST 的）。
**但 signal 是协作式的**：工具不读它就没人理（本仓已知的「MCP 在途中止 ⇒ Promise 永不 settle」正是这一类），
`running` 会永远为 `true` ⇒ 面板永远 409。所以补一条文档里**没写到**的兜底：
`ABORT_GRACE_MS = 5_000` 之后仍没结束就**重启进程**（此时这次 run 的 trace 会丢，面板明说）。
反向验证时把 runner 的 abort 处理去掉，e2e 正好报到 `escalated: true` —— 这条兜底真的在工作。

**② 清空对话（`POST /session/clear`）。** 清空 = **换一个 sessionId**，**不删** `session.json`：
后者是 `SessionStore` 的账，而面板对它是**只读**的（写它会造出「面板显示的对话」与
「模型真正看到的对话」不一致 —— 正是本仓最忌讳的那种静默不一致）。旧对话仍在盘上、
run 列表里那些 run 也还指得到，只是模型不再带着它跑。当前 id 落盘到 `.agentia/dev-session-id`
（**不是** `session.json` 的一部分）：只放内存的话，重启 `npm run dev` 之后刚清空的对话会**自己回来**；
该路径已在 `WATCH_SKIP` 里，所以写它不触发重启。id 由**父进程**决定并经 IPC 下传 ——
它是面板级状态，必须跨 runner 重启（改代码就会重启）稳定。

**③ 同一条事实的第三个影子（本轮真正的收获）。** 实现②的时候发现：中止的 run `ok` 是 **false** ——
引擎的 `abortedResult()` **刻意**给已取消的 run 带上结构化 `error`（取消不是失败，但原因要可查，
`engine/loop-result.ts` 的注释就写着这句），而 runner 的 `ok` 定义是 `!result.error`。
于是「只看 `ok`」这个写法在**三个地方**各自把用户按的中止当成了失败：

| 位置 | 错误表现 | 修法 |
|---|---|---|
| 面板的 `run-done` 反馈语 | 显示「run 失败（aborted）：run 已被取消」 | **先认 `stopReason` 再认 `ok`**，并抽进 `panel-logic.ts`（顺序是**语义**，不是渲染 —— 面板那份没有单测） |
| `dev.ts` 的 `lastError` | 告警条上永远挂一条红字「run 已被取消」，且不会再消 | `if (!msg.ok && msg.stopReason !== 'aborted')` |
| `dev-runner.ts` 的终端日志 | 打成「run 失败（stopReason=aborted）」 | 单独一句「run 已中止（面板点的中止）」 |

（②的说明原先写的「中止是正常返回、`ok` 两者都是 true」是**错的** —— 那是把
「不抛异常」误当成「不设 `error`」。它只活在注释里，正是这一轮对照审计才照出来的。）

**新增 / 扩面的守卫**（都逐条反向验证过，还原后 `git hash-object` 逐字节比对）：

- `packages/cli/test/panel-logic.test.mjs`：`nextSessionId`（轮换 / 认不出的形状兜到 `-2` /
  **base 进正则前转义**）、`runDoneNotice`（判别顺序、`error` 为空要说「未知原因」）。
- `packages/cli/test/inspector.test.mjs`：`POST /run/abort`（503 / 409 / 202 两态 / **`GET` 不落钩子**）、
  `POST /session/clear`（503 / 409 / 200）、**面板 import 名单的反向全覆盖**
  （页面 import 的每个名字都必须是 `panel-logic` 的真导出 —— 浏览器里 import 一个不存在的导出是
  **整块模块求值失败**（白屏），而 node 侧各用例各自 import 自己要用的名字，**照样全绿**）。
- `scripts/e2e-dev.ts` 第 10/11 步：假端点加「**挂住不回复**」开关（否则一次 run 只活几毫秒，
  那个窗口里插不进中止 —— 测到的其实是 409 那条分支，看着绿、什么都没验）；第 11 步断言
  会话写进**新** id 且**没写进**旧 id（这条能挡住「面板换了 id、runner 还写死旧 id」）。

**可复用的自查问**（补进 `guards.md` §2 尾注）：查完「一个值有几种写法」之后，
还要查「**它被几个地方各自判过一次**」。本轮三处错判是同一件事的三个影子，
而任何单点测试都只覆盖其中一个。

### 2026-09-22 ⑤：追一次**瞬时红** → 抓出 `WATCH_SKIP` 的**半实现**；顺带照出一条「假守卫」

**起点是一次没人解释的红。** 上一轮完整门禁里 CLI 套件红过一次，重跑又绿。没有把它当噪声
跳过，而是连跑三次复现、再隔离到 `panel-logic.test.mjs` 的 watch 用例，最后坐实：
`watchTree` 的目录跳过判据（`WATCH_SKIP` / 点开头）此前**只在「初始递归」那一个调用点执行**，
而 watcher 回调里发现新目录时调 `addDir` 走的是**另一条路**，那条路上**一次判据都没有**
⇒ 行为是「启动时就存在的 `dist/` 不看、**启动后才出现**的 `dist/` 看」。
（用临时探针坐实：启动后再 `mkdir dist` 并写 `dist/out.js` ⇒ 回调真的被触发。）

**修法**：判据收进 `addDir` **内部**（唯一一处），初始递归与动态新增两条路共用；
`root` 由调用方**显式豁免**（`isRoot`）—— 判据只看**目录名**、不看路径段，因为项目根本身
就叫 `dist` / `node_modules` / `.foo` 是合法的（用绝对路径段去认 `dist` 会把整个项目判成「不该看」）。

**本轮真正值钱的是验证侧的教训。** 补守卫时我做了两处：单测（构造「启动后才出现」的形状）
+ e2e（重启次数总账 + 理由里不许出现 `.agentia` / `dist/`）。**反向验证时：单测红了，e2e 照样绿。**
逐条排除三种解释 —— ① 修复没生效？不是（`git hash-object` 确认文件是改坏态，单测那条红了）；
② 断言写错？不是（计数与理由两条都对）；③ **缺陷在这里不可达** ← 真相：
`devServer` 的**监视根是 `<projectRoot>/src`**（`dev.ts` 的 `watchTree` 调用点），
而 `.agentia/` 与 `dist/` 都在**项目根**，从来不在范围内 ⇒ 那条 e2e 断言**碰不到** `WATCH_SKIP` 那条路。

⇒ 它真正守的是「**监视根保持 `src/`**」（这本身也值得守：哪天有人把根扩到项目根，
`.agentia/session.json` 立刻变成「每次多轮 run 重启一次子进程」的自噬循环）。
**两件事都要守，但必须说清哪条守哪件** —— 否则下一个人看到「有 e2e 钉着」就以为漏判被覆盖了。
这就是本仓一直在猎的**假守卫**：断言是真的、绿的、也是对的，只是它守的是**另一件事**。

**落地的改动**（三条注释 + 一条用例；**零行为变化**的部分只有注释）：
- `packages/cli/src/dev.ts`：`WATCH_SKIP` 的注释改写成「**第二层**」，把「第一层是**监视根**」
  写进注释（两层都要有，只靠根 = 碰巧打不到）；新增 `shouldDescend()` 并在注释里说明
  「判据必须由 `addDir` 自己执行」的原因；`addDir` 加 `isRoot` 豁免。
- `packages/cli/test/panel-logic.test.mjs`：新增一条用例，`dist/` 与 `.agentia/` **各自一轮**、
  中间等过去抖窗口 —— 因为 `flush` 只报 pending 里的**第一条**，把两件事放一起会被**事件合并**
  掩盖（上一版用例正是这么侥幸通过的，注释里写明了这一点）。
- `scripts/e2e-dev.ts` 第 12 步：断言改成「3 次重启且理由里无 `.agentia` / `dist/`」，
  **并把注释改准** —— 照实写明它抓不到 `WATCH_SKIP` 那条路、它守的是监视根。

**反向验证**：把判据还原成「只在初始递归判」⇒ 单测**恰好红那一条**（其余 15 条绿）；
再把 `isRoot` 豁免去掉 ⇒ 红「项目根自己叫 `dist` 时必须照常监视」（这条是修复**自己的**失败模式）。
两次都 `cp` 还原 + `git hash-object` 逐字节比对。
⚠️ 顺带记进 skill：**`git checkout -- <file>` 对未跟踪的新文件静默无效**（`panel-logic.ts` 是 `??`），
还原一律用 `cp` + 哈希比对 —— `git diff --stat` 对未跟踪文件恒为空，不能当证据。

**可复用的自查问**（补进 `guards.md` §2 尾注 ⑤）：写完一条守卫，问「**它在什么形状下才可能红**」；
若答案里含一个当前架构下不可达的前提，它就不是这条修复的守卫 —— 要么换个能红的形状，
要么**改名**（说清它守的那件事）并注明它不守什么。

### 2026-09-22 ⑥：**`.env` 是一条「够不着」的判据** —— 改 `.env` 静默不重启

⑤ 把「监视根是 `src/`」这条事实写进注释之后，顺手拿它去核**每一条**判据，立刻照出第二条：

`WATCH_NAMES = {'.env', '.env.local'}` 把这两份文件列进**允许清单**（`shouldWatch` 按文件名命中），
`usage-guide` 的「看什么」也把 `.env` 写进去 —— 但 `watchTree` 的根是 `<projectRoot>/src`，
而 `.env` 在**项目根** ⇒ 这条判据**没有任何一个 watch 够得着**。改 `.env` 静默无感，
与 G3b 完全同类（文档承诺了、代码够不着）。`dev.ts` 顶部那张结构图当时写的还是
`fs.watch(src/**, **.md)` —— 连图里都没有 `.env` 的位置。

**真跑坐实**：`scripts/e2e-dev.ts` 新增第 9-bis 步，真改一次**项目根**的 `.env`。
摘掉修复后帧转储里**一条事件都没有**（`等第 4 条 dev/runner-restart 超时（只收到 3 条）`）。

**修法**：单开一个 `watchRootEnvFiles(projectRoot, onFile)` —— **不递归**、且**只认名字**
（不认扩展名：项目根的 `package.json` 也不该由它管）。**不能**把 `watchTree` 的根抬到项目根：
那会把 `README.md` / `docs/` / `examples/` 全收进来，「改代码要重启」就变成「改任何文档也重启」。
两处 watch 共用一个抽出来的 `makeNotifier()` 去抖器（各写一份会漂 —— 比如只有一处清理 `timer`，
停机后仍会回调一次）。`onFileChange` 也抽成一处，重启理由的文案因此只有一种写法。

**两条可复用的教训**：

1. **「一条判据要问它有没有执行者」。** ⑤ 查的是「判据有没有在**每条路**上执行」，
   ⑥ 查的是「判据有没有**任何人**执行」—— 后者更隐蔽：`shouldWatch` 有单测、写得也对，
   但**没有任何调用点够得着**那两种情况。⇒ 判据的**正确性**（`shouldWatch` 本身）与判据的
   **可达性**（调用点的根）是两件事，各要各的守卫：前者单测，后者**只能真跑**。
2. **⚠️ 探针自身会假红 —— 断言别用写死的序号。** 第一版探针写的是
   `waitDev('runner-restart', …, 2)`（等第 3 帧）。但在这之前 `ack2` 那次 run 已经产生过一条
   `runner-restart`（回到全量菜单），于是它**立刻拿到那条旧帧** ⇒ 报错文案
   「理由里没有 `.env`」与「`.env` 根本没触发」长得一模一样，差点据此下错结论。
   改成**「先数当前帧数 N，再等第 N+1 帧」**才分辨得开。
   ⇒ 一般规则：**断言「某事件发生了」时，绝不能用与「事件总数」耦合的绝对序号** ——
   先取基线、再等增量。

### 2026-09-22 ⑦：**复核轮修复** —— 窄窗口竞态 / 收尾路径 / 两个表面口径不一致 / 登记漂移，
外加一次「假门禁」的自我纠正

⑥ 收口后 `docs/plans/2026-09-22-dev-debug-loop.md` 的需求已全部实现。这一轮**不动设计**，
是拿复核结论逐条回读代码后的边界修复。四条值得留痕：

1. **并发闸必须覆盖「受理 → 真正发出去」之间的那次 await。** `submitRun` 里换能力选择要
   `await restart(...)`（停旧进程 + spawn + 装配，几百毫秒起），而 `running` 只能等到 run **真的
   发进通道之后**才置位（它是「runner 里有个 run 在飞」的口径 —— 面板的按钮与 `abortRun` 都读它）
   ⇒ 只看 `running` 的闸在这条路径上会**放两个请求进来**：两个 `runOnce` 并发、`currentAbort`
   被覆盖、`pendingNote` 挂到别人的 traceId 上。修法是加一个**只给闸看**的 `launching` 占位。
   刻意**不**并进 `running`：那会让面板在还没 run 时就把「中止」按钮点亮，而 `abortRun` 此刻
   只能回 409 —— 一个自相矛盾的面板。
   ⇒ 一般规则：**「忙」有两种含义 ——「资源在飞」与「请求已受理」，它们的时间窗不同，
   别用一个布尔把两者盖住。**
2. **收尾必须等宽限期走完再 `exit`。** `stopChild()` SIGTERM 之后要等 `KILL_GRACE_MS`（3 s）
   才补 SIGKILL，而旧的 SIGINT 处理器是 `shutdown(); setTimeout(() => process.exit(0), 50)`：
   父进程在宽限期内就没了 ⇒ 那个计时器随它消失（SIGKILL 兜底一起丢），`process.on('exit')` 那条
   兜底此刻也已空转（`stopChild` 第一行就把 `child` 置成 null，而归属判定是 `child?.child === proc`）
   ⇒ 一个不响应 SIGTERM 的 runner（连同它自己 spawn 的 MCP 子进程）活成孤儿。
   注意 **SIGTERM 那条路径本来是好的** —— **同一个动作的两条出口口径不一致**本身就是缺陷信号。
3. **「中止」落在装配窗口里也必须生效。** `runOnce` 的顺序是 `send('run-start')` →
   `await ensureApp(...)` → 才 `new AbortController()`；窗口内到达的 `run-abort` 只能看到
   `currentAbort === null`，把它当「没在跑」静默丢掉的话 run 照跑，而父进程 5 s 后会把这次
   **健康的** run 升级成重启兜底（trace 丢掉 + `lastError` 写成「工具不响应 signal」——
   一个错误的归因）。窗口宽度取决于工程的装配开销（有 MCP 握手时是几百毫秒），
   **不能靠「窗口很窄」免修**。修法：窗口内到达的中止记在 `abortRequested` 上，建完 controller 立刻补。
4. **同一个事实的多个表面必须共用一条判别。** 「这一轮失败了吗」在面板上有三个表面
   （通知条 / run 列表红点 / 对话视图红边），而引擎的 `abortedResult()` 刻意给已取消的 run 带
   结构化 error ⇒ 中止时 `ok === false`：只修通知条那一处（先 `stopReason` 后 `ok`）等于让另外两处
   继续把「我按了中止」显示成「这一轮失败了」。⇒ 判别抽进 `panel-logic.runIsFailure`（先 stopReason
   后 ok），并在测试里钉「页面不许裸读 `r.ok`」。同时**中止轮不能从对话视图里消失**：
   框架只在成功路径回写会话 ⇒ 排除它等于显示一份**少了一轮**的对话（另一种静默不一致）。

**⚠️ 本轮的教训：我写的第一个新门禁是「假绿」，而它差点就这么进了库。** 为验第 1 条，我加了
「换能力选择后立刻再发一次 `POST /run`，必须 409」。它全绿 —— 直到**摘掉修复再跑一遍**才发现
摘掉后照样全绿：`await api('/run')` 要等 restart 走完才拿到 202，所以第二个请求是**在窗口之后**
发出去的，压根没进窗口。改成「先不等回包，等 `runner-restart` 广播帧（`restart()` 的第一行就 emit）
再发第二个请求」才真的落在窗口里。
⇒ 一般规则（⑤ 那条的升级版）：**新增门禁必须做一次「把修复摘掉、看它红不红」的反向验证。**
假绿比没有门禁更坏 —— 它把「没人验」伪装成「验过了」。本轮三条关键修复全部做了反向验证
（①摘掉后真红、②③同样真红），并顺手抓出两条复核没提的缺陷：裸 CLI `agentia dev -- "问题"`
会把分隔符 `--` 当成 prompt 传给模型（`npm run dev -- "问题"` 那条因为 npm 吃掉 `--` 而一直是对的）、
`read-file` 未归一化工作目录（带尾斜杠时**每一次**调用都误报「路径越出工作目录」——
不是误报，是工具整个变坏）。两条都补了真跑用例。

### 2026-09-22 ⑧：**dev 面板的三处体验修复** —— 右栏实时长树 / 回复被自己擦掉 / 选择器不可用

⑦ 之后拿**刚发布的 0.9.0** 起了真面板（真浏览器、真点、真发 run）逐项走查，三处现象：

1. **右栏在整轮 run 里是死的。** `playTrace` 此前唯一的调用点在 `open()`，而 `open()` 跑在 run
   **收尾之后**（trace 经 `POST /ingest` 回到面板才触发）⇒ 一次十几秒的 run 期间只在右栏看到一句
   「正在跑…」。框架的**增量出口**（`RunInvocationOptions.onTraceEvent`，0.8.3 落地）本来就是为这类
   消费者准备的，计划 §D7 的评审补充也点名要求接上（P1b），落地时漏了。修法是一条**原样转发**链：
   runner 订阅 `onTraceEvent` → 逐笔 `POST /ingest-event`（sink 自己排 **FIFO 链**：并行 fetch 会走不同
   连接，面板就可能**先收到 `span.end` 再收到 `span.begin`**，折回时那条 end 因「未知 spanId」被丢，
   树上少一个节点）→ 父进程**不做任何解释**地广播 → 面板按 `seq` 折回（`panel-logic.applyTraceEvent`）
   → rAF 合帧重画。为什么不折好再发：框架钉着一条不变量（`tests/engine/trace-events.test.ts`）——
   按 `seq` 升序把全部事件应用到 `span.begin` 建出的 span 上，结果**逐字等于**收尾的 `snapshot()`；
   照它折回就得到与收尾一致的树，父进程插一手只会多一处会漂的口径。两条纪律与框架同名出口一致：
   **不保证送达**（所以折出来的是**临时**的树，收尾那份到达时**覆盖**它并让在飞那份作废）、
   **是观察不是控制**。顺带一个语义修正：`playTrace` 对**根 span 没有 `endedAt`** 的树不再收尾 ——
   否则在飞期间根会被标成「已完成」，是个假事实。
2. **刚跑完的回复在 17 ms 后被面板自己擦掉。** `run-done` 把回复正文写上去之后，面板会**自动
   `open()` 刚跑完那一轮**（让右栏显示这轮的 trace），而 `open()` 无条件清回复区 —— 现象是「跑完了
   但没回复」。修法：把归属判定抽成 `panel-logic.replyBelongsTo(openId, replyFor)`，只有「现在打开的
   就是这条回复的主人」才保留。**不能**改成「open 一律不清」：打开一条历史 run 时若还挂着别人的回复，
   那是张冠李戴（比空白更糟）。
3. **文件夹选择器三处不好用 + 不能选文件。** ① 只列目录 ⇒ 「让 agent 看某个文件」只能靠用户把名字
   打进 prompt；② `浏览…` 是个**开关** ⇒「在输入框敲了目标路径 → 点浏览…」这个最自然的动作反而把
   面板关掉（于是以为「选不了别的目录」）；③ 隐藏目录被整批过滤 ⇒ `.git` / `.y` 这类目录**根本点不
   进去**（`..` 只能退到它上面）。修法：`/api/fs` 回 `{ path, parent, dirs, dotDirs, files, filesTruncated }`
   三组（隐藏目录单列、文件有上限且**截断明示**），点文件名 ⇒ 工作目录取它**所在的**目录、prompt
   **只在为空时**填文件名（`panel-logic.promptAfterFilePick` —— 悄悄改用户写好的输入比少填一次糟得多），
   `浏览…` 改为**总是**按输入框的值打开（`browseTarget`），点面板外面收起。

**同轮做的一件事**：`dev` 环的 e2e（`scripts/e2e-dev.ts`）加第 **7-bis** 步——真进程 + 真 HTTP + 真
SSE 下断言「在飞期间真收到增量帧」「增量帧**先于** `run-done` 到达」，并用 **CLI 自己的
`dist/panel-logic.js`** 把收到的帧折回来与 `/api/runs/:id` 的整棵 trace 做 `isDeepStrictEqual`
（不是在这里重写一遍折回规则——那样就成了「我自己和自己一致」）。⚠️ 这条要**等链路静默**再比：
收尾的整棵 trace 走 `flushSinks`（被 await），而逐笔事件走 fire-and-forget 的链，最后几笔可能还在路
上 —— 「晚到可以，最终必须一致」，所以轮询到一致为止（5 s 超时）。

⚠️ 本轮最贵的一课，写在这里当规矩：**反向验证脚本必须先 commit 再跑。** 脚本的每个变异都要在测完
之后还原源码，而还原用的是 `git checkout -- <路径>` —— 在**未提交**的工作树上，它还原的不是「变异前
的状态」而是 **HEAD** ⇒ 一步就把整份未提交的改动擦掉（本轮真发生了：`dev-runner.ts` 与
`panel-logic.ts` 两个文件的改动被擦，第三个文件上还留着变异体 `if (true) {`）。判别办法是**信测试
不信撤销**：门禁红了先看红在哪 —— 当时那条「✓ 变红」其实红在 `inspector.test.mjs` 的
「页面 import 的每个名字都真的导出」上（因为被擦文件里的导出没了），是个**假红**。
⇒ 规矩两条：**① 反向验证前先 commit（哪怕只是个本地提交）；② 反向验证的判据要能区分「红在我变异
的那条」与「红在别的地方」。**

### 2026-09-22 ⑨：**面板的三处可读性修复** —— 正文 Markdown / 滚动分层 / 长消息折叠

⑧ 之后拿真面板走查（真浏览器、真跑、真点），三处现象：

1. **模型正文是纯文本**（`#reply` 是一整块 `<pre>`，对话视图的助手轮一样）⇒ 长回复里的列表与
   代码块糊成一坨。修法：写一个**自己的**最小 Markdown 解析器（`packages/cli/src/markdown.ts`，
   纯逻辑、零依赖、带单测）。为什么不引 `marked` + `DOMPurify`：本 CLI 的**零运行时依赖**是硬承诺
   （`package.json` 里没有 `dependencies`），而两份第三方产物**没法被本仓单测验证**；这套子集不到
   200 行、每条规则都能配用例。**安全前提是「按构造不产生 HTML」**：解析器只产出 token 树
   （token 类型白名单里没有「HTML 透传」这一类），渲染层只准用 `createElement` / `textContent`
   —— 模型输出里的 `<script>` / `<img onerror>` 只会是字面文本。链接协议过白名单
   （`http` / `https` / `mailto`）；不合法**整条降级成字面文本**（连 `[]()` 一起显示，使用者看得出
   「这里有个链接我没渲染」）。用户轮保持字面 —— 那是「我打的字」。
2. **右栏一长就是整页滚**：`section` 只有 `min-height`、没有上限，而 `footer` 粘在底部 ⇒
   内容一长，「看树」与「读回复」互相把对方推走，而且三个滚动条（页面 / 树 / 展开的行）叠在一起。
   修法：应用外壳（`html/body` 100vh + `body` 不滚），左栏列表自己滚，右栏**只有 `#trace` 是滚动
   区**（它是唯一无界增长的部分），回复 / 排行 / 用量固定在下方并各自有上限；窄屏回落成单列。
3. **长消息没有明确的展开入口**：`#reply` 与聊天里的长回复只能一路读下去（trace-view 那边事件行
   有 caret，但它在**行最右端**、10px，还叠着行内滚动 —— 那是 nowrap 表格状布局的合理形态，
   正文块不是）。修法：`collapseDecision`（纯逻辑、按**行数 + 字符数**，**不量像素** —— 像素阈值在
   字体 / 缩放 / 窄屏下会漂，同一个回复在不同机器上折叠与否都不一样）判定；长正文卡 216px +
   底部渐隐，展开控件放在正文**下方、左对齐**（「展开全文（共 N 行）▾」/「收起 ▴」），
   短正文**不挂控件**。展开态活在渲染之外（面板每次全量重画，状态留在 DOM 里会被下次重画合上）。

**同轮把守卫升了一级**（都做了反向验证）：`markdown.test.mjs` 8 条（含两条安全断言与 1 万行围栏的
防回溯判据）；`inspector.test.mjs` 的「页面 import 名单反向全覆盖」从「只查 `panel-logic.js`」扩到
**所有自建模块**，并加四条页面级不变量（全页 `innerHTML` **赋值**只准一处且必须是 `renderSummary` /
`body` 必须不滚 / `#trace` 必须是滚动区 / 窄屏必须有回退）。

⚠️ 两条踩坑记录，都值得留：**① 变异体必须能编译** —— 「让解析器产出一个非白名单 token 类型」的
变异我第一版直接写 `type: 'html'`，tsc 报「不在联合里」⇒ 构建失败、门禁**根本没跑到**（空跑一次），
改用 `as unknown as 'text'` 双重断言后才真的在运行期产出非法类型。**② 对被格式化过的文件做 `patch`
时用了格式化前的 `old_string`** —— 模糊匹配插到了错位置（一份测试文件里被插出重复的 `it(...)`），
靠「改完立刻回读那一段」才发现。⇒ 教训：**改完紧接着回读**，别只信 patch 的成功返回。

### 2026-09-22 ⑩：**换文件夹模型无感** —— 模板补 `list_files`（零框架改动）+ 原生文件夹选择器

真用户反馈：dev 面板上「切换了文件夹，执行 agent 好像没变」。e2e 探针证明链路是通的
（workdir 确实经 DI 注入到工具），真正的缺口是**模型感知**：run 的 prompt 不变、菜单里
没有「列目录」的工具 ⇒ 模型不知道自己在哪个目录、里面有什么，只能瞎猜文件名 ⇒ 行为看起来
不变。修法落在**模板**（零框架改动）：read-file 能力（同一个类、同一个 provider）加
`list_files` —— 列出工作目录（或相对子目录）内容，**输出第一行写工作目录的绝对路径**
（这是模型「知道自己在哪」的通道，description 里写明），目录名带 `/` 后缀，输出有上限
（200 条）且截断**明示**；越界判定复用 `safeResolve`（读目录也是读，同一道闸）。

同轮另一件：面板工作目录选择器加「**系统选择…**」原生对话框。为什么不走浏览器的
`<input type="file" webkitdirectory>` / File System Access API：它们**拿不到所选目录的
绝对路径**（浏览器刻意不给），而 WORKDIR 注入需要绝对路径。所以由 **CLI 本机进程**拉 OS
原生对话框（契约 `POST /api/fs/pick`，面板调它、父进程弹窗、返回绝对路径）—— 面板仍是
纯浏览器页，「够得着本机」的那一层是 CLI 自己。

### 2026-09-23 ①：**「客户端断开」这条判据在浏览器刷新时够不着** —— 面板卸载改为显式通知

原生选择框的「在飞」收口此前只有一条路：`POST /api/fs/pick` 的 `res.on('close')`（G2）。
它的前提是「客户端断开 ⇒ 服务端看得见」。2026-09-23 用**带插桩的产物副本**（在 `handleFsPick`
的 close 分支与 `native-pick` 的子进程 close 处各记一行）+ 真浏览器复现，三种形态分得很清楚：

- **curl 真断连**（FIN）⇒ close 触发、0.5 s 内 `picking` 落、子进程被收 ⇒ 这条路**是好的**；
- **刷新 / 卸载体 / 等 30 s+** ⇒ **close 完全不触发**（`lsof` 上浏览器侧仍 ESTABLISHED），
  选择框一直活着、之后每次点都 409 ⇒ **这就是漏的那一格**；
- **杀掉浏览器进程** ⇒ close 触发（与第一条同路）。

最小复现（`node:http` 的 `res.on('close')` 上分别跑 `curl --max-time` 与客户端 SIGKILL）证明
Node **两种形态都会触发** ⇒ 差别在**浏览器把那条连接留着**，不是 Node 行为。

定论：**「刷新」这个动作在服务端不可观测，判据本身选错了**。修法：面板在 `pagehide` 时
`sendBeacon('POST /api/fs/pick/cancel')` —— beacon 是**一次新请求**，与「断开是否可见」无关；
服务端幂等（不在飞即空操作），所以面板可以**无条件**发它、不必维护一份会漂的页面态。
连接断开那条路**保留**：浏览器崩溃 / 被 kill / 非浏览器客户端断开仍走它（两条互补，不是替代）。
两条路各配一条确定性用例（`packages/cli/test/inspector.test.mjs`），其中「页面真的挂上了
`pagehide`、路径与服务端 `PICK_CANCEL_PATH` **逐字一致**」由一条对拍断言钉住 ——
页面 import 不到那个常量，不钉就是「页面发了、服务端 404」的静默漏。**框架侧零改动**，只在 CLI。

### 2026-09-26：成本口径三处收口 + **守卫注册表 §1 首次逐行审计**（3 个假守卫）+ PR 模板自查抓出文档漂移

这一轮由 `docs/guards.md §2` 自己写下的**起手动作**驱动（表空了之后，缺口只能靠主动问找回来）。

**起手动作①：把 §1 逐行问一遍「它退化时真会红吗」**（54 行，逐行用变异电池：改实现 → 跑 →
确认**恰好**点名那条红 → 复原，复原后 `git diff --stat src/` 逐字节一致）。净结果：

- **假守卫 3 处**（断言是真的、绿的、也是对的，只是守的是**另一件事**）：
  - `tests/engine/tracer.test.ts` —— `snapshot()` 的实现就是 `totalUsage: this.usage()`，那句
    `deepEqual(r.usage(), r.snapshot('ok').totalUsage)` 是**自我比较、恒绿**。修法：钉**委托本身**
    （子类数 `usage()` 调用次数，必须恰好 1 次），真正的对账搬到调用点
    （`tests/engine/budget.test.ts`，护栏读到的数 vs trace 交付的数）。
  - `tests/core/sse-text-stats.test.ts` —— 「带常驻监听做对照」的 `baseline` **从未被断言非零**。
    实测把 `getEventListeners` 打瞎（恒返回 `[]`）后三条断言全过、用例照样绿。已补
    `assert.equal(baseline, 1)`，把「测量工具还活着」变成判据。
  - `tests/architecture/transport-errors.test.ts` —— 回归钉的**合成样本没复现它声称要守的 bug**
    （URL 与 `throw` 不在同一行 ⇒ 退回旧实现照样绿）。样本改成真实形态后，退回旧实现才真的红。
- **归属漂移 1 处**：`sse-text-stats.test.ts` 那行把 `withTimeout(p, 0)` 的断言算在自己头上，
  实际它在 `tests/core/timeout.test.ts`。元守卫只查「路径存在」，查不出「守卫在不在那个文件里」。
- **命令指错 1 处**：`tests/types/dx.types.ts` 头注写「由 `npm run typecheck:tests` 校验」，而
  `tsconfig.tests.json` 明确 `exclude: ["tests/types"]` —— 它归 `typecheck:types`（对 `dist/`）。
  照错的命令跑，整份文件的断言（含全部 `@ts-expect-error`）一个都不会被检查。
- **未登记的守卫 1 个**：`scripts/check-website-agent-readiness.mjs` 的「`llms-full.txt` 必须与
  单源 `docs/usage-guide.md` **逐字节相等**」此前不在 §1 —— 而它正是 PR 模板「改了 usage-guide
  时已重建派生物」那句承诺的**唯一机器依据**。已登记（含反向验证：只改单源不重建 ⇒ 恰好那条红、
  exit 1）。⇒ 教训：`guards-registry.test.ts` 只查「列出的路径在不在盘上」，**查不出「盘上有守卫
  却没列」**，清单的**完整性**没有任何机器保证。
- **计数订正**：§1 是 **54 行**（中途靠印象报过 53）。「清单有多长」也要靠数。
- 其余 40+ 行逐条变异验过、都是真守卫。⇒ 结论是**假守卫不是普遍现象**，问题集中在
  「机制被写下了、但**没有一条断言能让机制本身失效**变红」那几处。

**起手动作②：拿本轮 diff 对 `.github/PULL_REQUEST_TEMPLATE.md` 的自查问**，当场抓到文档漂移：

- `packages/website/src/fragments/api.html` 的 `ModelPricing` 行写的是 `{ in: number; out: number }`，
  而源码已加 `cacheRead?` / `cacheWrite?`；同一页**三处**写「非法单价（构造期 / run 开始）抛错」，
  而实测是**被 `runAgent` 收成 `status: error` 的 result、不抛给调用方** —— 同一个口径在
  `docs/usage-guide.md` 里已订正过，**漏了 api.html**。三处均已修。
- 为什么没被守卫拦住：`tests/docs/api-page.test.ts` 只守「导出的反向全覆盖」与「页面上手写的数字
  对源码核」，**不看**表格里的类型形状、也不看散文口径。当时登记进 `docs/guards.md §2`
  （§2 自 2026-09-23 清空后**重新长出两行**）。
- **当天两条都建成守卫并移回 §1**（`§2 → 守卫 → §1` 的标准闭环）：给 `tests/docs/api-page.test.ts`
  补了两条 —— ① **第二列类型形状**对源码成员集核（「没有 `…` 的行 = 自陈穷尽 ⇒ 必须相等」），
  它**一次查出 7 行漏写字段**（`ModelPricing` / `Span` / `AppOptions` / `RunInvocationOptions` /
  `ToolRunContext` / `MetricsSinkOptions` / `ModelReport` / `SubAgentSpec`），全部补齐；
  ② **非法单价的散文口径钉**（只在踩过的那两处钉：必须说清「不抛给调用方」、不得归因到「构造期」）。
  两条各 3 条反向验证，散文钉还带**防真空**断言（触发面归零时钉子自己喊）。
  ⚠️ 射程如实标注：类型形状那条只管**表格第二列**；散文钉只管**踩过的那两处**、触发词是「非法」
  —— 它防的是**回归**，防不了新写错的散文。
- **同一次自查问还问出一条 §2 表里没有的缺口**（关键差别：拿**最终** diff 问的是**代码**，不只是
  文档）：`costEstimate` 用的是 `p.cacheRead ?? CACHE_READ_MULTIPLIER`，而 `??` 与 `||` 的差别
  **只**落在 `0` 上。把两个 `??` 改成 `||`，`tests/engine/pricing.test.ts` **19/19 全绿** ——
  因为没有任何一条用例把乘数设成 `0`。而 `0` 是**合法**值（`buildPricing` 的校验是
  `finite && >= 0`），含义是「这个模型的缓存读 / 写不要钱」；被读成「未设」就回落到
  0.1 / 1.25 ⇒ 成本虚高、`maxCostUsd` **提前**触发（账不对，方向上是误伤）。
  已补一条守卫（`cacheRead: 0` / `cacheWrite: 0` / 两者同时为 0 三条精确值断言 + 一条「不写
  乘数仍走缺省」的对照），反向验证：`?? → ||` ⇒ **恰好那条红**（`expected: 0, actual: 6.75`）。
  同一条纪律此前已在 `src/core/limits.ts`（「限制旋钮的 0 是什么」的单一真源）与
  `exactOptionalPropertyTypes` 迁移里各出现过一次 ——「显式给的 `0`」与「没给」必须分开；
  已知类**不等于**已覆盖，每一处新的 `0` 都得各自钉。
- **顺着这条缺口做同类扫描，又清掉三处**（可复用的动作：一条缺口修好之后，问「同一个形状还有几处」）：
  - **`Scheduler.every.maxInFlight`**：闸门判据是 `inFlight.size >= maxInFlight`，`0` / 负数时
    **恒真** ⇒ 每次 tick 都跳过，周期任务**永不派发且不报错**（探针实测 60ms 内派发 0 次、
    无任何日志）。与 `AsyncRunner.concurrency`（`limits.ts` 表里 `zero: 'invalid'`）**同族**，
    现在同款在构造期抛 `TypeError`；`Infinity`（关闸门）与缺省 `1` 不受影响。
    已登记进 `limits.ts` 表并补探针。⚠️ 旧读法**两个方向都在替使用者改配置**：
    `?? 1` 把 `0` 静默留下，而写成 `|| 1` 又会把它静默抬成 1（与 `streamBufferEvents` 记的
    旧 `Math.max(1, …)` 同一个反模式）。**这是一处行为变更**：`maxInFlight: 0` 从「静默不派发」
    变成「构造期响亮失败」—— 没有任何**本来能工作**的配置会因此变坏。
  - **`Scheduler.every.intervalMs` 的报错文案**此前是**手写**的，而 `limits.ts` 表里那条
    `zeroClause` 没有任何调用点 —— 表自己写着「有构造期校验的旋钮由实现代码直接插进错误消息里」，
    对它不成立（**单源断了一头**）。现已接 `zeroClauseOf`，并加了一条文案用例钉住。
  - 顺带把 `limits.ts` 文件头里那张**已经过期的 `zeroClauseOf` 用户清单**删掉（只留 grep 指针）：
    它自己就警告过「别在这里写死几处」，而这次的经验是**「列举出来的清单会和计数一样过期」**。
  - ⚠️ 同一次复核发现 `docs/guards.md` §1 那一行把旋钮数写成 **15**，而表里实际是 **17**
    （加完新的 18），且同一行的「其余 14 条」与 15 **自相矛盾**。⇒ **计数只能靠数** ——
    这条教训本仓已重复四次（53→54→55、15→18）。
  - 剩 **2 处读法定不下来**（`SseWriterOptions.maxBufferedBytes` / `HttpHandlerOptions.maxBodyBytes`
    的 `0`：两处都无校验、`0` 合法，而把 `??` 改成 `||` 后相关测试 **84/84 全绿**）⇒
    不硬判，如实登记进 `docs/guards.md §2`（含变异证据与两条候选处置）。
  - **同一天这 2 处也判定并闭环了** —— 判定用的**不是新造的标准**，而是本仓已经写在**同一个
    选项接口里**的那条：`maxConcurrentRuns` 的「0 / 负数则全部 503 —— **都是配置错误**，
    宁可在构造期响亮失败」。实测两处是同一形状：`maxBodyBytes: 0` ⇒ **每个带 body 的请求都
    413**（3 条 POST 全 413）；`maxBufferedBytes: 0` ⇒ **流活不过一帧**（判据是写入前的
    `pending > limitBytes`：第 1 帧照写、第 2 帧必收口，`closed=true` / `ended=true` /
    `onBackpressure` 回调 1 次）。⇒ 两处都判 `invalid` + **构造期抛错**（`sseWriter` 与
    `createHttpHandler` 各拦一道，后者保证透传的 `sseMaxBufferedBytes` 也在构造期响亮失败，
    而不是等第一个 SSE 请求才炸 —— 那时响应头已写出，只能回 200 再断流）。
    **这是两处行为变更**：`maxBodyBytes: 0` 从「每个请求 413」、`maxBufferedBytes: 0` 从
    「流活不过一帧」变成构造期 `Error` —— 同样，没有任何**本来能工作**的配置会因此变坏。
    ⚠️ 顺带挡掉一类事故：`Number('') === 0`，从**空的环境变量**读出来的配置会静默变成「拒绝一切」。
    三条反向验证（`maxBodyBytes` 放行 0 / `sseWriter` 放行 0 / 去掉透传那道构造期校验）
    ⇒ 各**恰好 3 / 3 / 2 条红**，不误伤。

**同轮的语义变更（`src/`，四处）** —— 都是「护栏拿到的数不对，而没有任何报错」这一类：

- **`ModelPricing` 新增 `cacheRead?` / `cacheWrite?`**（逐模型缓存乘数，相对 `in`；缺省 `0.1` / `1.25`）。
  动因：官方缓存写有 **5 分钟 1.25×** 与 **1 小时 2×** 两档，而 `Usage` 是四项**聚合**的、
  分不出 TTL（SDK 的 `Usage.cache_creation` 有拆分，本框架没把它带上）⇒ 用了
  `cache_control: { ttl: '1h' }` 的宿主成本会被低估 **37.5%**、`maxCostUsd` 迟触发。
  缓存读另有逐模型例外（Opus 5.5 = 0.05×、Fable 5.1 / Mythos 5.1 = 0.025×）。
  ⇒ **这是公开面变更**（新增两个可选字段），非破坏性。
- **`estimateMessages`：图片块按上界估**。此前 `contentToText` 只认 text / tool_use / tool_result，
  `image` 落进 `default: JSON.stringify(b)` ⇒ 一张 200KB base64 截图被估成 **50054** token
  （官方图片计费按**尺寸**：28×28 像素 = 1 visual token，与文件字节数无关）。现在按「长边缩到
  1568px」的**上界 3136 token/块**计 —— 宁可高估（`maxTotalTokens` 提前拦）也不低估（护栏迟触发）。
  未知块仍按**未截断**负载估（同向理由）。
- **`renderMessages` / 摘要路径：绝不展开 base64**。图片块只给 `[image image/png ~150000B]` 这类
  占位、未知块截断到 200 字符并留计数 —— 否则等于把整段图片 payload 当输入 token 发给宿主注入的
  compaction 摘要模型（真金白银 + 摘要质量一起毁）。
- **`buildPricing`：非法乘数也校验**（**只校验一半等于没校验** —— 乘数写错照样出 NaN 成本、
  照样让 `maxCostUsd` 变摆设）；错误文案改用 `showValue` / `showObject`，把 `NaN` 印成 `NaN`
  而不是 `JSON.stringify(NaN)` 的 `null`（宿主传的确实是 `NaN`，印成 `null` 会让人去找一个
  不存在的 `null`）。口径订正：这个错**不抛给调用方**，它发生在**第一次 llm 调用之前**
  （client 一次都不被调用）。
- **`src/transport/http.ts` 两处编译期穷尽性断言**（`TaskStreamFrame` 与 `HttpRoute`）：新增成员
  时**编译失败**，而不是被静默丢帧 / 静默吞成 404。
- 文档口径同步：`priceOverrides` 的「模型名**精确匹配**」（不带日期的别名与带日期的快照是两个键，
  照抄官方文档的带日期 id 最容易踩）；`cacheRead: 0` 的语义是「**乘数为零**」而不是「未设」
  （实现用 `??` 而非 `||`，已钉）。以上均记入 `docs/usage-guide.md` 与 §1 的守卫行。

**收尾：两条 CI 独有必需检查在冻结树上真跑了一遍 —— 顺手清掉一处「写下来的做不到」**

- `npm run e2e:mcp` ⇒ `✅ D1/D2/D3/D4 真端到端证明全绿`。本机有 `uvx` ⇒ 走的是**真**第三方
  server（`uvx mcp-server-time`，2 个工具）。⚠️ 方向与直觉**相反**：CI 的 `e2e-mcp` job
  **必定走回落夹具**（runner 上没有 uvx，见 `ci.yml` 注释）⇒ 这条是**本机覆盖更强**，
  不是「只有 CI 算数」。
- 导入下限：`npx node@18 scripts/check-import-floor.mjs` ⇒ `OK Node 18.20.8：包可导入（79 导出）`；
  `node@20` ⇒ 20.20.2 同款；本机 Node 22 ⇒ `SqliteTaskStore 可用`。三条都 exit 0（§1.4 已记）。
- 由此发现 `scripts/verify-all.sh` 的收尾注释仍在说这两个检查「**本地无法等价复现**」——
  **那句话本身没验过**；且同一段里写死的计数（「另有 3 个」）与紧随其后的清单（只列了 2 个）
  **自相矛盾**。已改成：清单 + **从清单长度算出的计数**（与同文件上一行「计数**算出来**而不是
  写死」的纪律对齐），并把两个检查的**本机跑法**直接写进输出，省得下次再有人把它读成「做不到」。
- 同类扫描（那句话还活着几处）：`scripts/verify-all.sh` 与
  `.workbuddy-ai/skills/agentia-verify/SKILL.md` 各一处，均已改。⚠️ 后者**不被 git 跟踪**、
  **没有任何守卫**。⇒ 教训补进 `docs/guards.md §2`：**把一条教训写进文档时，顺手 grep 一遍
  那句话本身** —— 文档写了 ≠ 代码改了。
- 冻结树上的门禁读数：`verify-all.sh` **8/8 全绿**、`npm test` 三套件全绿、
  `tests/limits.test.ts` **22/22**、`limits.ts` 表 **20 个旋钮**、§2 **活行 0 / 划线 3**；
  `src/` 净改动 **7 文件 / +233 −35**。
  ⚠️ §1 行数在登记完本轮那条元守卫后是 **56 行**（11+18+6+21）—— 而**第一次重数时报出 63**，
  因为那个计数脚本只按 `### ` 分组、把 `## 附：` 与 `## 2.` 的表格算进了上一个 `###`。
  ⇒ **「靠数」还要加一步：数之前先钉口径** —— 口径不同的两个脚本能在同一天给出 55 / 56 / 63
  三个都自称「算出来的」数字。

**同一轮还长出一个元守卫：工具链对自己说的话，此前没有任何东西核对**

改上面那句「本地无法等价复现」时发现一个**同族但更贵**的缺口：`scripts/verify-all.sh` 顶部
自己写着「本脚本的**步骤数**写在 CI 的 job 名里 —— 加/减一步都得同时改 workflow 的 job name
**和**分支保护，否则 PR 会卡死等一个永不出现的检查」，而这条约定**只有人记得、没有任何门禁**
（`rg` 过：`tests/` 里没有任何文件读 `verify-all.sh` 或 `ci.yml` 的 job 名）。它退化时的症状不是
「某个测试红」，而是**所有 PR 永久卡死**。

新增 `tests/scripts/verify-all-wiring.test.ts`（7 条用例）把四件事变成判据：

1. **步骤数 == CI `verify` job 名里写死的那个数字**（名字即必需检查）；
2. **`ci.yml` 的每个 job 都被交代** —— 跑本链的那个 / 脚本 `ci_only` 清单 / `EXEMPT` 表里带理由豁免，
   三者之外出现新 job 即红（新加必需检查却不登记 ⇒ 本地全绿而 CI 挂）；
3. **`ci_only` 没有幽灵 id**，且每条都是 `<job id>|说明`（`verify-all.sh` 的清单为此改成这个形状，
   打印时用 `${arr[@]#*|}` 剥掉 id 那半截，读者看到的东西不变）；
4. **收尾消息不得写死计数**（`/另有\s*\d+\s*个/` ⇒ 红）。

⚠️ 豁免不是免检：`deploy-website` 的豁免理由（「只在 main 上跑 ⇒ 不是必需检查」）本身被写成
可执行形式（`if: github.ref == 'refs/heads/main'`），理由不成立就红 —— 否则「豁免」会变成
一个越用越宽的筐。

**反向验证 11 条（M54–M64，各恰好点名那条红）**：加第 9 步 / job 名 `8`→`9` / `ci.yml` 新增 job /
幽灵 id（含**尾逗号**写法）/ 去掉 id 前缀 / `deploy-website` 去掉 `if:` / 收尾写死「另有 3 个」/
枚举注释换顺序 / 解析锚点改名 / 删掉 `lint` job / 豁免的 job 被改名。

⚠️ **第一版里有一条假守卫（M57 第一次跑是 exit 0）**：解析器只认「整行就是引号字符串」，
于是把幽灵条目写成 `'no-such-job|…',`（**尾逗号** —— bash 合法、且真的会成为数组的一个条目）
会被**静默跳过**，幽灵整条隐形而断言照样绿。⇒ 修法不是补一条特例，而是把**解析器的盲区本身**
变成判据：数组内任何非注释行只要认不出就**响亮失败**，绝不跳过（跳过的条目 = 清单里悄悄少一条）。
这条与 §2 记的三种假守卫同族，但形状是新的：**不是断言写错，是样本被解析器吃掉了**。

**同一轮里顺着「同一句话还有几处」把副本也扫了**：`verify-all.sh` 收尾那处刚修好，
「本链一共几步 / 必需检查是哪些」这句话在仓库里还有 **9 处抄写** —— `CONTRIBUTING.md` ×2
（`# 8 步验证链` / `# 8 步：typecheck + lint → …` 的**步骤枚举**）、`AGENTS.md` ×5
（`上面 8 步` ×3 + 引用的 job 名 + `，8 步 ——`）、PR 模板 ×2（`8/8 全绿` ×2），
而此前**只有 CI job 名那一份**被机器核过。全仓 `rg` 之后确认没有别的落点（`ARTICLE-*.md` /
`CODE-REVIEW-*.md` 是未入库草稿；`docs/spec.md` / `CHANGELOG` 是只增不改的记录）。

同一个文件因此扩到 **13 条用例**，新增 6 条：

- **步数的每一处抄写 == 真值**（6 种写法：`N/N 全绿` / `上面 N 步` / `verify-all N 步` /
  `N 步验证链` / `# N 步：` / `，N 步 ——`），每份文档还带**防真空**下限；
- `CONTRIBUTING.md` 的「`# N 步：…`」**步骤枚举**与脚本步骤一一对应（第三份步骤清单，
  与 `ci.yml` 那条 `→` 注释同款；⚠️ 它是**给人看的描述**，第 1 步写作 `typecheck + lint`
  而命令里没有 `lint` 这个词 ⇒ 判据放宽到「该步任一词命中」，**射程如实标注**：抓顺序错/漏项，
  抓不到措辞漂移）；
- `CONTRIBUTING.md` 的「CI 必须全绿才能合并（`verify` · `lint` · `import-floor` · `e2e:mcp`）」
  == 真实必需检查集合（**集合相等**，多一个幽灵或少一个新 job 都红）；
- 坑表那行「本地过了但 CI 挂了」要点名每一个 CI 独有检查；
- `AGENTS.md` 的 CI 段落要点名每一个 job、且**圈码数 == job 数**（这份是 agent 读的说明，
  数字过期会直接误导自动读者）；
- **兜底扫描**：任何同时点名 ≥3 个 CI job 的 markdown 必须登记进 `REQUIRED_LIST_FILES`，
  或被 `EXEMPT` 表**带理由**挡掉（`CHANGELOG` / `docs/spec.md` / `docs/guards.md` / `docs/plans/**`
  —— 全是「只增不改的记录」）。

⚠️ **第二处假守卫（M73 第一次跑也是 exit 0）**：兜底扫描第一版用 `git ls-files` 取文档，
而**新写的文档在 `git add` 之前不在索引里** ⇒ 扫不到它 ⇒ 本地绿、提交后 CI 才红。
已改成 `git ls-files --cached --others --exclude-standard`（已入库 ∪ 未入库但未被 ignore）。
⇒ 两条合起来是同一个教训：**修的是量具，不是断言**。

新增反向验证 **10 条（M65–M74）**，各恰好点名对应断言：PR 模板 `8/8`→`9/8` /
`AGENTS.md`「上面 8 步」→7 步 / `CONTRIBUTING` 步骤枚举换顺序 / `# 8 步`→`9 步` /
必需检查列表删一项 / 加一个幽灵 / 坑表那行删掉 `import-floor` / `AGENTS.md` 段落里 job 改名 /
**新建一份点名 5 个 job 的文档** / `AGENTS.md` 的 CI 段落锚点改坏。
⚠️ 第 8 条（「`# 8 步`→`9 步`」）只咬「步数」那条、**不咬**枚举那条 —— 两条断言确实独立。

**同日第四批：注册表自己的完整性 —— 「盘上有守卫却没列」**

`guards-registry.test.ts` 一直只查「清单里写的路径在不在盘上」（清单 → 盘），
查不出**反向**：盘上有守卫、清单里没登记。实测 `tests/**` + `packages/*/test` 共 124 个
`*.test.ts`，只有 47 个在表里 —— 但其余 77 个绝大多数是普通行为测试，按文件登记会造出 77 条豁免
（噪音）。精确版：**两个横切守卫货架**（`tests/architecture/` · `tests/docs/`）上的文件
必须全在表里 —— 它们按构造就是守卫，漏登记就是真缺口。2026-09-26 实测到 **5 个**：
`tests/docs/observability.test.ts` / `trace-view-readme.test.ts` / `website-css.test.ts` /
`website-playground-expand.test.ts` / `website-scrollspy.test.ts`。

同时发现两个已有守卫的**子串匹配漏洞**：`observability.test.ts` 用 `doc.includes(f)`（子串）、
`trace-view-readme.test.ts` 也用 `readme.includes(n)`（子串）。后者把 `rawArg` 改写成
`rawArgument` 时**照样绿**（M76 exit 0）—— 不是断言写错，是判据太弱。都改成
**集合相等**（源码导出名集合 vs 文档表格第一列集合，双向求差），并补了反向方向
（文档里加一个源码没有的导出 ⇒ 红）。**反向验证过 5 条**：`observability` 文档里工厂名改成超串
（`sqliteTraceSinkV2`）⇒ 红；`trace-view-readme` 改名（`rawArg`→`rawArgument`）⇒ 红、
整词删掉 `rawArg` ⇒ 红、表里加 `ghostExport` ⇒ 红；`website-css` 改回 `overflow-wrap: anywhere`
⇒ 红；`playground-expand` 游标里 `rawArg` 换 `fmtArg` ⇒ 红；`scrollspy` 底部判定改成永不成立
⇒ 红。

`guards-registry.test.ts` 新增第 3 条用例（货架完整性），3/3 绿。
`docs/guards.md` §1.4 因此加 **2 行**（文档导出表 / 官网渲染细节），§1 从 56 → **58 行**。

**复审补（同日，另一路独立复审）：`renderMessages` 的「不展开 base64」只兑现了一半**

上面那条「**`renderMessages` / 摘要路径：绝不展开 base64**」写的是「图片块只给
`[image …]` 占位」。而 `ToolResultBlockParam.content` 的联合本身给了**嵌套块数组**形态
（`string | Array<TextBlockParam | ImageBlockParam | UnknownContentBlockParam>`）——
**工具返回截图正是生产里最常见的入图路径**（浏览 / 截图 / 渲染类工具都这么回）。
那一支当时仍走 `JSON.stringify(content)`，实测：一张 200 000 字符 base64 的截图 ⇒
渲染出 **200 086 字符**（正文里就是原始 base64）、估算 **50 022 token**，与顶层图片块
（3 138）差 **16 倍**。⇒ 承诺与真路径之间只剩这一个洞，而上面四个方向的用例**全都只喂顶层
图片块**，所以全绿。（这也解释了为什么 `openaiStream.test.ts` 那两条同类分析同样没照出它：
两处分析都在看**顶层**块的走向。）

修法：`tool_result` 的正文**逐块递归** —— 渲染走 `blockToText`（图片给占位、未知块有界截断），
估算走 `blockTokens`（内嵌图片同按尺寸上界 3 136）；字符串形态与「正文缺席」的既有口径不动
（缺席仍返回 `undefined`，由调用方走有界 JSON 回退）。

新用例两个方向各一条断言（渲染 < 400 字符且不含 base64；估算 ≥ 3 136 且与顶层形状差 ≤ 3），
**两条都做过变异**：退回 `JSON.stringify` ⇒ 渲染那条红；关掉内嵌估算分支 ⇒ 估算那条红。
⚠️ **该估算断言第一版是不咬人的**：只写「< 4000」的**单边**判据，而退回实现后值回落成占位
文本的十几个 token，同样满足它 —— 「别高估」与「别低估」是两个方向，断言必须两边都写。
（与 §8.9 的「把这条修复改坏，我这条断言里哪一个字会先变？」同一条纪律。）

**同一族里还有第二个入口：`tool_use` 的**参数**（同上，已修）**

「载荷型结构」在渲染路径上一共三处：图片块（原有）、`tool_result` 的嵌套正文（上一条）、
以及**工具参数**。最后一处此前是裸 `JSON.stringify(tu.input)` —— `write_file` 的正文、
`screenshot` 的 base64、大 JSON 参数都从这里进摘要器。修法：
`TOOL_INPUT_CHARS = 2000`（比未知块的 200 宽松一个数量级，理由写在常量上：参数的前若干字符
是**调用意图**，摘要需要它；2000 字符 ≈ 500 token 够不着任何 base64 级载荷），超限截断**并留
计数**；`blockTokens` 那一侧仍按**未截断**参数估（低估 ⇒ `maxTotalTokens` 迟触发，方向相反，
两边刻意不统一）。新用例：渲染有界 + 不含 base64 + 估算 > 10 000 + **小参数原样不被截断**
（阳性对照的另一半 —— 否则「一律截断」也能满足前三条，而截掉正常调用的参数会实打实毁掉摘要）。
两条变异（渲染退回无界 / 估算改用渲染后的有界值）各恰好点名那 1 条红。

⚠️ **刻意**保留的不截断项（写进代码注释，避免下一个人把它当成漏网）：`text` 块与
`tool_result` 的**字符串正文**不封顶 —— 它们是摘要器真正要读的「话」，截断等于让 compaction
**永久丢掉**历史信息（而压缩本身不可逆）。有界化的对象是**载荷型**结构。

⇒ 本轮复审在这一族里净得 **2 个 MAJOR**（都属「承诺与真路径的缝」：承诺「绝不展开 base64 /
产物有界」，而真入口只覆盖了一个），共 4 处变异全部咬人。

**同日两件交付（同一轮复审的后续）：把「能不能发」收成一条判据（A）+ 把 deploy 镜像纳入 CI 构建（B）**

**A · 评测即发布闸门（配方 + 示例 + 守卫，`src/` 零改动）** —— 定位句里唯一**没有产物回答**的动词：
「trace 决定你敢不敢上线」目前有「看」（trace / `report` / `diff` / `harvest`），没有「判」。
`EvalReport.ok` 只回答「本次用例全过」，回答不了「比上一版好还是坏」，更防不住「把失败用例删掉」。

- 判据在 `examples/eval-gate/src/gate.ts`（**只消费公共类型面**）：**回归**（基线通过 → 这次失败）与
  **删用例**（基线里有 → 这次没跑）判不通过；**新增用例 / 修好**放行但记账；
  **基线里本来就失败 ⇒ 放行** —— 闸门拦的是**新的**坏消息，不替你把历史债一次清完。
  退出码三档：`0` 通过 / `1` 有回归或删用例 / `2` 基线坏了 —— **环境错误不该被读成「agent 退化了」**。
- 配套四件：`docs/eval-gate.md`（规则 / CI 接线 / 边界，并**如实标注它不是 roadmap 候选、是审阅读出的缺口**）、
  `examples/eval-gate/`（四套件：工具顺序 / 成本精确值 / 工具失败 / **刻意留一条已知失败**；
  全部 `scriptedClient` ⇒ 离线、确定、不烧 token —— 要花钱会抖的闸门没人敢当发布判据）、
  `tests/docs/eval-gate.test.ts`（9 条纯函数断言 + 文档 ↔ 示例导出面双向覆盖）、
  `scripts/e2e-examples.ts` 第 9 步（真构建 + 喂三份**被改坏的**基线）。
- **反向验证 3 条**：判据泄成 `EvalReport.ok` 的转发 ⇒ **3 条红**；`ok` 去掉 `removed` 条件 ⇒ 恰好 1 条；
  空基线改为静默返回 ⇒ 恰好 1 条；产物层三份坏基线的退出码实测 `1 / 1 / 2`。
  ⇒ 这条守卫守的是「**判据本身不许退化**」，而不是「用例跑没跑过」。

**B · `examples/deploy` 的镜像进 CI（非必需检查）+ 如实标注**

- 事实：`docker` 在本仓 CI 配置里**出现 0 次**，本机也没有 docker ⇒ 定位里「交付可上线的服务」那一脚的
  参考实现，**镜像从来没被任何门禁构建过**（服务本身由 `scripts/e2e-deploy.ts` 真跑守着：三种触发 +
  `SIGKILL` 后续跑；缺的只有**打包这一跳**）。
- 处置：新增 CI job `docker-image`（`docker build -f examples/deploy/Dockerfile .`，上下文 = 仓库根）。
  它**不是**必需状态检查（本机无法等价复现 ⇒ **首次绿就是它的验证**），豁免登记在
  `tests/scripts/verify-all-wiring.test.ts` 的 `EXEMPT`，且**理由写成可执行形式**
  （`mustMatch: /docker build/` + 「将来本地能等价复现就该挪进 `ci_only`」）。
- 观测口径同步三处：`AGENTS.md` 的 CI 段落（六个 job、圈码数 == job 数）、
  `examples/deploy/README.md` 新增「镜像的验证状态（如实标注）」（**服务有门禁、镜像只有这一次构建**）、
  `ci.yml` 的 job 注释（为什么不是必需检查）。
- 如实标注的未验证面：**本机跑不了这个 job**，所以「镜像能不能建起来」在本会话里**没有**本地证据 ——
  它由 CI 首次运行给出结论。

### 2026-09-26 ②：**`§7 已知边界`（77 行）立守卫** + `killTree` 平台分派可测化 —— 连同一条**误判的勘误**

**背景（先记勘误，避免下一轮复犯）**：上一轮评估「作为成熟框架还缺什么」时，我用两条读数
判「CLI 平台分支零门禁」，**两条都错了，且错在同一个方法论缺陷** —— 按「我猜的文件位置 +
我猜的扩展名」去数，而不是先读测试运行器实际收哪些 glob：

- `find packages/cli -name '*.test.ts'` ⇒ 0 ⇒ 我判「CLI 零单测」。真实：CLI 套件是
  **`packages/cli/test/*.test.mjs`（14 个文件）**，而 `scripts/test-all.mjs` 里明写着它是
  **独立一个套件**。扩展名猜错，整条结论作废。
- `grep -rn "win32\|powershell\|taskkill" tests/` ⇒ 0 ⇒ 我判「平台分支无覆盖」。真实：那只搜了
  **框架套件目录**；CLI 侧 `packages/cli/test/native-pick.test.mjs` **已有 14 条平台用例**
  （三平台分派 / 三种取消形态 / 归一化 / signal / 接线）。

**真缺口因此更小、也更难辩解**：同一目录的 `native-pick.ts` 把平台**收成参数**（`resolvePicker(platform, has)`）
所以守得住；`dev-child.ts` 的 `killTree` **直接读 `process.platform`**，于是 win32 那条
`taskkill /T /F` 分支**在任何平台都跑不到**（CI 是 ubuntu、macOS 走 POSIX）。差别不在勤奋，
在**接口形状** —— 这是本轮两条决策的由来。

**决策 1：`§7 已知边界` 立守卫（`tests/docs/boundary-table.test.ts`）。**
§7 是使用者判断「我能不能用这个框架」的唯一依据（77 行），此前**零守卫**，且是被
`usage-guide.test.ts` 的解析器**结构性**排除的 —— 那条规则只收「首列**恰好是一个反引号
标识符**」的行（服务于字段名对账），而 §7 首列是散文 ⇒ **整表零采集**。四条判据：A1 标识符
不悬空（227 个 token；纯标识符逐字、复合写法按首/末段 —— `ctx.delete` 是使用方写法，框架里
是 `RunContext.delete`）；A2 行集合 ↔ 登记表**双向**；A3 `pin={file,marker}` 可证伪；A4 三态
在场 + 下限。首版读数 **pin 38 / choice 9 / gap 30**。

**`gap` 的语义要说清**：它**不是「功能缺失」**，而是「这句话今天为真、明天可能为假，而没人
会发现」。这份 30 条清单是 §7 的「下一次 review 从这里开始」，与 `guards.md §2 待守` 同一哲学；
判成 `gap` 是**本轮的读法**（规则：该行声称的机制有没有用例 + 有没有用例钉住**这句话**），
不是仓库已声明的候选 —— 所以每条都附了最可能接上的候选文件。

**决策 2：`killTree` 的平台分派抽成 `killPlanFor(platform, pid, signal)` 纯函数**，
`killTree` 变成纯执行器（`none` / `taskkill` / `process-group` 三态与旧分支一一对应，
**行为逐字不变**）。计划里存**正** pid，取负留给执行器（「负 pid = 进程组」这条 POSIX 语义
只在一个地方出现）。CLI 侧新增 6 条用例（含「`process.platform` 在**代码**里只出现一次」
那条接线判据 —— 否则下一个人加平台分支时又会写出一个测试够不着的分支，正是本轮要修的形状）。

**被自己的变异电池抓到的假守卫（记下来）**：A3 第一版用 `titles.some(t => t.includes(marker))`
判「被引用的用例还在不在」—— 把那条用例的标题 `…只执行一次` 改成 `…只执行一次啊` 后**照样绿**。
这与本仓记过的 `rawArg` → `rawArgument`（子串匹配照样绿，M76 exit 0）**同一个坑** ⇒ 改为
**整条标题相等**（38 条 pin 里 37 条换成标题原文；`scripts/check-import-floor.mjs` 那条没有
「用例标题」概念，退回「逐字在场 + 长度 ≥ 12」，这条不对称写在代码注释里）。

**两次踩到同一条脚本纪律（写进纪律）**：变异脚本靠 `git checkout --` 复原，而它会连**未提交
的改动**一起抹掉 —— 第一次抹掉了 Phase B 的源码改动（后两条变异打在空气上，dist 里没有
`killPlanFor` ⇒ 全红，看起来像「守卫全面咬人」的假象），第二次抹掉了 A3 的判据改进（M4 因此
没打上）。**先提交，再变异。**

**反向验证**：边界守卫 **8/8**（M1 §7 加一行不登记 ⇒ 恰好 A2「文档有边界但没登记」；M2 删一行
⇒ 恰好 A2 反向；M3 `idempotencyKey`→`ZZ` ⇒ 恰好 A1 并点名第 1399 行；M4 标题加字 ⇒ 恰好 A3；
M5 pin 指向不存在文件 ⇒ A3；M6 语料清空 ⇒ A1 防真空下限；M7 gap 候选不存在 ⇒ A3b；
M8 全 38 条 pin 降级成 choice ⇒ A3 + A4）；`dev-child` **4/4**（各恰好 1 条）；`native-pick`
**2 条实测**（linux 候选顺序对调 ⇒ 恰好 1 条；darwin 去掉 `(-128)` ⇒ 2 条）。三个文件复原后
sha256 逐字节一致。

**补登记**：`native-pick.test.mjs` 此前**没进 §1**（守卫在、登记缺）—— 与本仓记过的
`check-website-agent-readiness.mjs` 同一类：`guards-registry.test.ts` 只查「列出的路径在不
在盘上」，**查不出「盘上有守卫却没列」**。已登记（含上面两条实测读数）。

**门禁**：**不加 verify-all 步数** —— 两条守卫都落进既有套件 glob（`tests/**/*.test.ts` /
`packages/cli/test/*.test.mjs`）。`structure.test.mjs` 的规模棘轮按仓库惯例补账：
`dev-child.ts` 82 → 112、总量 8290 → 8320（+30，理由写在基线注释里）。

**非目标（YAGNI）**：不加 win32 / macOS 的 CI 矩阵行 —— `§7` 与 `native-pick.test.mjs` 头注都
写着「**绝不能在 CI 真触发**」原生对话框，而进程树回收的真平台验证要真起子进程再杀；纯函数化
的目的正是**把平台分派从「需要那个平台」变成「不需要」**。真端点 `e2e:live` 同样不进常规门禁
（要真 API 凭据 + 网络 flake；触发条件已写在 §7）。

### 2026-09-27 ①：**摘要渲染折叠纯载荷长串** —— 补上「字符串正文」这个最后的载荷入口（连同一个被自己的判据否掉的初版设计）

2026-09-26 那条把「渲染有界」的清点收在**三处**：图片块（占位）、`tool_result` 的嵌套正文
（逐块递归）、`tool_use` 的参数（2000 字符）。第四处 —— `tool_result` 的**字符串正文** —— 当时
判为「刻意不封顶」，理由是「那是摘要器要读的『话』」。**这个理由被框架自己的转换路径否掉了**：
`tool-events.ts` 的 `toolResultBlock()` 对任何返回值走 `stringifySafe` ⇒ **工具把截图 base64 当
字符串返回时，正文形态就是字符串**（不是块数组），于是绕过全部三处封顶整段进摘要器。实测
（本轮，`renderMessages` / `estimateMessages` 真模块跑）：一张 200 000 字符 base64 的截图 ⇒
渲染 **200 043 字符 / 50 012 token**，而顶层图片块是 **37 字符 / 3 142 token** —— 差三个数量级，
而那整段正是 `compactMessages` 交给宿主 `summarize` 的正文（真金白银 + 摘要质量一起毁）。

**初版判据是错的，且错在判据自己身上**：第一版写的是「**无空白的**连续长串就折叠」。这条会把
摘要器**最该读**的内容折掉 —— **CJK 与英文散文没有空格也照样是散文**，一段两千字中文正文就是
一个「无空白长串」。所以判据改成**字符集**：只有落在 `[A-Za-z0-9+/=_-]` 内、且**连续** ≥ 4000
字符的串才折成 `⟨载荷 N 字符已折叠⟩`（留计数）；`{` `"` `,` `:`、空格、换行、标点、CJK 都不在
集合里 ⇒ 散文 / JSON 结构 / 代码**天然豁免**，不需要额外白名单。

**方向与另外三处一致**：折叠只在**渲染**侧（`contentToText` 是唯一收口，字符串正文与块数组都
从那里过）；**估算侧仍按未截断负载算** —— 渲染有界 ≠ 估算有界，低估会让 `maxTotalTokens`
迟触发。

⚠️ **这不是上界保证，文档照实写**：折行载荷（PEM 式每 76 字符换行）每段都够不着下限，整段
照旧进摘要器 —— 它消掉的是**最常见的那种形态**，不是全部。因此 `usage-guide.md` / `guards.md`
（**活文档**）都把「刻意不截断」改成「**不按长度截断** + 纯载荷长串折叠 + **不是上界保证**」。

⚠️ **顺带更正上一条里的绝对话**：2026-09-26 那条写着「**绝不展开 base64**」，加了折叠之后它对
折行载荷就是**假**的了。按本文件（以及 `CHANGELOG`）的**只增不改**纪律，那段原样保留 ——
`spec.md` 是记录、不是活文档，更正只出现在本条：**以本条为准**。

**反向验证 4/4**（四条各自点名**不同**的一条断言）：① 关掉折叠（收口变恒等）⇒ 恰好「字符串
正文里的纯载荷长串」那条红；② 字符集放宽成 `[\s\S]`（即退回「无空白就折」那一类判据）⇒ 恰好
「只认载荷」那条红；③ 下限 4000 → 10（几乎全折）⇒ 恰好「低于下限的短载荷不许被折」那条红；
④ 下限 4000 → **4001**（差一）⇒ 恰好同一条里的**边界双侧**断言红（3999/4000 分道扬镳那条 ——
没有它，`{4000,}` 与 `{4001,}` 在别处没有任何断言看得见）。
**第一版把四个对照例捆在一个 `it` 里，M2/M3 因此点名同一条**（分辨率不够）—— 拆成两条之后才有
上面的记录。恢复后工作树与提交逐字节一致；**先提交再变异**（2026-09-26 那条纪律）。

`src/` 净改动：**1 文件 / +30 −2**（`engine/trimming.ts`：常量 + 折叠函数 + 收口各一处）；
用例 **27 → 30 例**（+3）。

### 2026-09-27 ②：**sink 失败不再零信号** —— `flushSinks` 照吞但落 `console.warn`；JSONL 文件 sink 进框架

两件事同一个动机：**观测链路自己的故障不能隐形**。

① **「观测不击穿业务」的纪律不变，但吞掉之前要留信号。** `flushSinks` 依旧吞掉 sink 的异常
（run 结果不受影响）——这条是对的，不动。变的是此前吞得**零信号**：sink 天天挂、面板一切如常，
「trace 根本没落盘」要等下游消费（CLI 对不上账）时才发现。现在 catch 里落一条 `console.warn`
（文案含「trace sink」字样，可 grep / 接日志采集，带 sink 的错误消息）。与
`createOtlpExporter({ onExportError })` 的分工：那个是**导出器自己的**失败分类出口
（HTTP 状态 / 超时 / partialSuccess，要不要吞由它选），这个是**框架侧对任意 sink** 的兜底告警
—— 两层不冲突，一个管「导出器内部的分类」，一个管「sink 这个缝本身的故障」。

② **CLI 三件套的消费格式，产出侧收进框架。** `agentia report` / `diff` / `harvest` 消费
`trace.jsonl`（一行一个 JSON，裸 Trace）已久，而产出侧文档还在教用户手写 `appendFileSync`
的 sink —— 断了一截。新导出 `jsonlTraceSink({ path })`（`src/integrations/file-sink.ts`）：
一行一条裸 Trace 追加落盘、父目录构造期递归创建、追加不覆盖、写失败**抛给调用方**
（由 ① 的告警兜底接住）。落 integrations 层（只依赖 core + `node:fs`，零新增依赖），
与 `createOtlpExporter` 同组登记进公共面。

### 2026-09-27 ③：**模型 fallback 链落在引擎层**（不在 client 层组合）—— 换环 = 新 llm.turn，成本归因天然正确（R8-P2）

起因是规划评审（docs/plans/2026-09-27-evolution-r8.md 修订记录②）：初稿把 fallback 设计成
`ModelClient` 组合器（包装 client、静默换厂商、不记账）——两条硬伤：① span 的 model 与成本
都取自 run spec 的 `args.model`（`turn.ts` 的 begin / `costEstimate`），组合器静默换 client
后**记错账**（归错模型、按错价目表、`usage.unpriced` 不响）；② `classifyError` 实为 7 类，
初稿漏了 `timeout`（retryable: true，恰恰是最该换的那类）与 `aborted`（用户取消可能被打到
第二个厂商）。

⇒ 落地为**引擎级**链路：`fallbacks: [{ model, client? }]`（RunAgentOptions / AppOptions /
RunInvocationOptions 三层同语义，app 级缺省 + run 级覆盖）。要点：

1. **每环独立 llm.turn span**（model 名正确 ⇒ 成本/未定价探测天然归对）；切换在新 span 记
   `llm.fallback { from, to, errorType }` 事件（与既有 `llm.retry` 同级同形）；`TurnOutcome`
   带出**实际成功**的 model，`recordTurnUsage` 按它算账。
2. **换环判定与重试共用 `retryable` 位**（不是另写一份类清单）：rate_limit / server /
   timeout / connection 才换；api / unknown 是请求本身有病，原样失败收尾；
   `aborted` **永不换**。重试先于换环（同环内 maxRetries 用尽才落下一环）。
3. **「吐过字不换」**与 retryAllowed 的 `!emitted` 是同一护栏（换环重跑会让用户看到
   两段拼起来的回答）；**每回合从主环重新起**（fallback 是单回合韧性，不把后续回合
   钉在备用模型上）；子 agent / skill 子循环**不继承**主 run 的链（能力层显式给模型，
   继承会让子 agent 悄悄换厂商）。
4. 链环 `client` 缺省复用本次 run 的 client；run **入口**校验（`resolveModelChain` 在
   runAgent 的 try 之外 —— 配置错响亮抛 TypeError，不被收成「一条失败的 run」）：
   空 model / 死 client（持久化 store JSON 往返后的空壳）都在发请求前报出来。
   快照记 `config.fallbacks`（只记备用模型名，client 是对象不序列化）。

门禁 `tests/engine/fallback.test.ts`（12 条）；反向验证 4 变异各恰好咬死对应用例
（摘 `!emitted` / abort 分支失效 / retryable→true / 成本按 args.model 算）。

### 2026-09-27 ④：**opt-in 记录 assistant 文本**（`traceContent: 'full'`）—— 「trace 不记 assistant 文本」这条有损边界从「恒真」改成「缺省真」（R8-P3a）

动机：trace → 训练数据导出（P3b）需要模型正文，而 trace 历来不记（llm.turn 只有
usage/事件，replay/fork 的有损边界声明在 `engine/replay.ts`）。要点：

1. **缺省不记，现状逐字不变** —— 旋钮是 `'full'` 单值枚举（不留布尔将来加档的坑），
   只开在需要导出的 run 上。
2. **旋钮分工**：裸 `maxEventChars`（`tool-events.ts`）管「单段负载多长」—— `output.text`
   过同一道截断闸（缺省走成功出参档 2000）；`traceContent` 管「记不记」。`traceLimits`
   下只有 `maxEvents`（管「多少条」），与两者正交。不进 `limits.ts` 真源表：它是字符串
   枚举不是数值旋钮，「0 是什么」不适用。
3. **纯 tool_use 回合不记**（无文本块）—— 空串属性是「这回合说了什么」的假信号。
4. **透传子循环**：走 `forwarded.ts` 真源（ToolRunContext 新键被迫归类的机制咬住），
   同一棵调用树同口径 —— 否则导出物里子 agent 的回合全是缺口。
5. **代价写进文档**：实测 3 回合 × 约 1600 字符输出的 run，trace 5 564 → 11 010 字节
   （约 2×）；模型输出进入脱敏面，与配方 2.4（observability.md）互相指。
   §9.4 与 replay.ts 的「不记 assistant 文本」声明同步改为「缺省不记」。

门禁 `tests/engine/trace-content.test.ts`（7 条）；反向验证 3 变异（记录闸摘掉 /
不透传子循环 / 恒记）各恰好咬死对应用例。

### 2026-09-27 ⑤：**`agentia export`（trace → 训练数据）**—— 导出器对「缺席」的态度：标注，不填假内容（R8-P3b）

harvest 的孪生（它产 eval 用例骨架，这里产训练数据 JSONL）。核心决策都在
「trace 里没有什么就怎么办」上：

1. **原始输入不在 trace 里** ⇒ 首条 user 恒为占位，且 `meta.incomplete` 标 `'input'` ——
   占位要自陈（词里带「训练前请补写」），不装成真输入。
2. **assistant 文本缺口不造占位**（与 harvest 相反！harvest 的占位是给人看的脚手架注释，
   这里的占位会进训练集 = 投毒）—— 终端回合没记到文本就**整条 assistant 不产生**，
   标 `'assistant-text'`。纯 tool_use 回合本来就没文本，**不算缺口**（判定口径：
   无 tool_use 又无文本的回合缺文本才是真缺口）。
3. **tool_use ↔ tool_result 配对合法是硬要求**（残缺历史喂训练是静音投毒）：
   缺输出补 is_error 占位块；有输出配不上对的跳过并计数 `meta.droppedOutputs`。
4. **过滤语义**：`--min-score` 排除没分数的 run（没判过 ≠ 及格）；`--ok-only` 排除
   失败 run。全部滤光要报错（静默产空文件是最难查的那种错）。
5. 子 agent 嵌套回合不进主线（其能力出参已在主线 tool_result 里 —— 那是主线的合法
   视角），数量记 `meta.nestedTurns`（与 harvest 同口径）。

框架侧 `src/eval/export.ts` module 级（不进公共面，同 harvestEvalCase 纪律）；CLI 侧
去类型移植副本 + 逐字对拍（`packages/cli/test/export.test.mjs`）。门禁：框架侧
`tests/eval/export.test.ts` 6 条（夹具全是真引擎跑出来的 trace）+ CLI 侧 6 条（含对拍）。

### 2026-09-27 ⑥：**租户归因 labels**（R8-P4）—— trace 根随便记，进 metrics 走「opt-in + cap」双闸门

动机：拿框架做 SaaS 的第一张账单是「哪个客户烧了多少钱」。三层同语义
（`RunAgentOptions.labels` / `AppOptions.labels` / `RunInvocationOptions.labels`）。决策：

1. **trace 侧无基数问题**：`labels` 落 run 根的 `labels.<key>` 属性，随便加；
   配置快照只记**键名**（`config.labels`），值可能含租户标识不复制。
2. **与 `RunSpec.source` 正交不动**：source 是框架自己写的**触发来源**审计
   （sync / async / schedule:<id>，单值）；labels 是宿主写的**业务维度**（多值）。
   不合并、不互相映射。
3. **metrics 侧双闸门**：`metricsSink({ labelKeys })` 显式点名哪些键上指标标签
   （缺省 `[]` 一个都不上）—— 光 opt-in 挡不住「明知几千租户偏要上」，所以每键
   相异值数还有 `maxLabelValues`（缺省 100，**必须为正数**，limits 真源表登记），
   超出归入 `__other__`（与 `maxCapabilities` / `maxModels` / `maxScores` 同款折叠语义：
   只丢标签粒度不丢量）；被折叠数见 `snapshot().droppedLabelValues` 与
   `dropped_keys{kind="label:<key>"}`。labelKeys 要过 Prometheus 标签名校验
   （`/^[a-zA-Z_][a-zA-Z0-9_]*$/`），非法名/重复键构造期抛错。
4. **出口形态**：`runs_total` / `runs_failed_total` / `tokens_total` / `cost_usd_total`
   四个 run 级家族在全局样本（无 label，仍是总量）之外追加带标签样本
   （Prometheus 文本与 OTLP 同口径）。⚠️ 已知查询侧坑（写进 usage-guide）：开了
   labelKeys 后 `sum(agentia_runs_total)` 会把全局行与分行重复计数 —— 总量用不带
   标签的序列。带标签的 token 样本是**四类之和**（combo 标签不再叉乘 kind）。
5. **刻意不做 per-label 时长直方图**：时长维度是 cap × windowSize 的又一份乘法
   （每个 combo 一个环形窗口 + 直方图），「哪个租户慢」用 trace 侧的 `labels.*`
   属性查（那才是逐条的归处长处）；`runLabels` 累加器因此只有四个计数、O(1)。
6. **入口校验同 resolveModelChain 纪律**：labels 键空 / 值非字符串在 run 入口
   （try 之外）抛 TypeError，不收成「一条失败的 run」。空串值合法（「租户未知」
   是有意义的值）。`AppOptions.labels` 被单次 run 覆盖时是**整体替换**不是合并
   （合并会让「这次不带 plan」说不出口）。

门禁 `tests/engine/run-labels.test.ts`（7 条）+ `tests/integrations/metrics.test.ts`
的 R8-P4 块（7 条）；反向验证 2 变异各恰好咬死对应用例（摘掉 cap 折叠 ⇒
`maxLabelValues=1` 折叠用例与 reset 用例红；引擎侧摘掉 labels 落根 ⇒ run-labels
3 条红）。公共面新增 `RunLabelMetrics` 类型导出（`MetricsSnapshot.runLabels` 的值型）。

### 2026-09-27 ⑦：**MCP 反向桥**（`createMcpServer`，R8-P5）—— 把能力菜单暴露成 MCP server，trace 叙事不破

动机：生态位跃迁 —— 框架从「agent 的运行容器」变成「生态里的工具供应商」：`@Tool`
集合暴露成 MCP server 后，Claude Code / Cursor / 任何 MCP 宿主能直接调。决策：

1. **落点 `engine/mcp-server.ts`**（不是 integrations）：它只允许依赖 core
   （layering 守卫的 ALLOWED），而 server 每次 tools/call 要造一棵 trace、需要 engine 的
   `TraceRecorder`；engine → integrations 这条边已存在（取默认 ModelClient），反向即成环；
   transport 够不到 integrations。engine 是分层图上唯一能同时够到 core 与 integrations 的层。
2. **app 入参是鸭子类型** `{ tools: AgentTool[] }`（`AgentApp` 结构满足 —— `app.tools`
   就是装配后、过中间件的那份菜单）：engine 不能 import toolkit，鸭子类型让「菜单来自
   装配层」这件事不引入新依赖边。e2e 夹具刻意走 `createApp` + `@Tool` 真装配来钉这条。
3. **协议范围只到 tools**：initialize / notifications/initialized / tools/list /
   tools/call + ping；其余 method 一律 -32601，params 形状坏 -32602。不做（YAGNI，与
   正向桥同一张清单）：resources / prompts / sampling / SSE 推送 / 会话强制校验。
4. **两个传输只用标准库**：stdio = 换行分隔 JSON-RPC（stdout 是协议面，日志只去
   stderr）；StreamableHTTP = POST 收、回 application/json（简单应答不上 SSE），
   initialize 铸 `mcp-session-id` 头但**不校验**（无状态 server：带了接受、不带也
   服务 —— 宽容选择，写进 usage-guide §7）；GET → 405、DELETE → 200；客户端断连
   中止该次调用的 `signal`。`server` 选项可把 handler 挂进既有 http.Server
   （不替它 listen，close 只摘 handler）。
5. **trace 叙事不破**：每次 tools/call 造一个 TraceRecorder —— run 根
   `mcp.tools/call` + capability span（name = 工具名）+ 与引擎同形状的
   `tool.input` / `tool.output` 事件（复用 `tool-events.ts` 的载荷装配），收尾投递
   `opts.sinks`（抛错吞 + console.warn，与 flushSinks 同款）；initialize / tools/list
   不建 trace。**偏差更正一处设计稿断言**：设计稿说 metrics 的 capabilityKindOf 会把这种
   span「归为 tool」—— 读码核实后它不是：无 skill/subagent 属性的 capability span 归为
   `capability:<name>` 标签（`capabilityKindOf` 的三值里根本没有 'tool'；`tool:` 标签来自
   turn 上的 `tool.output` 事件，而 metrics 只扫 llm.turn 的事件）。「自动进能力指标」
   本身成立，只是标签名是 `capability:` 前缀。
6. **结果映射与正向桥方向对称**：string → text 块、其他 JSON 化、抛错 → 协议层成功 +
   `isError: true`（正向桥的连接器正好把 isError 转回抛错）。`toolTimeoutMs` 复用引擎
   同款语义（withTimeout 实测耗时判定 + 超时 abort `abandoned`），故不进 limits 真源表。
7. **鉴权只给缝**：http 侧 `auth` 钩子在读 body 之前、抛错即 401（原文只进服务端日志）——
   与 `createHttpHandler` 的 `authenticate` 同纪律；stdio 信任父进程。`client` 缺省
   **惰性**走 `createAnthropicClient()`（首次 tools/call 才构造 —— 纯工具 server 不需要
   API key 在场）。

门禁 `tests/engine/mcp-server.test.ts`（19 条：协议面 HTTP 真端口 + stdio 真子进程 +
trace 形状 + 断连/超时/鉴权/共享 server）；反向验证 3 变异：摘 isError 映射 ⇒ 恰好 3 条红
（isError http / 超时 isError / stdio isError）；摘 trace 投递 ⇒ 恰好 4 条红（成功/抛错/
超时/stdio 的 trace 断言）；未知 method 不回 -32601 ⇒ 恰好 1 条红；还原后 19/19。
e2e `npm run e2e:mcp:server`（与 e2e:mcp 同档，不进 verify-all）。公共面新增
`createMcpServer` + `McpServerApp` / `McpServerOptions` / `McpServer`（api.html 计数
220 → 224）。

### 2026-09-27 ⑧：**菜单漂移不再静默**（R8 候选 3 / durable 调研 §4.1）—— 续跑时未决工具没了记三处信号，但**不判失败**

动机：`docs/plans/2026-09-27-durable-execution-research.md` §4.1 实测出来的那个静默 ——
菜单变了（删 / 改工具）之后，在飞 run 续跑时未决的 tool_use 会拿到 `unknown tool: <name>`
当出参回给模型（`turn.ts:611`），run 照常收尾：调用方 `result.error === undefined`、
`stopReason='end_turn'`、`finalText` 是模型自己编的收尾，**零失败信号**。G4 因此从「中」提到
「中高（静默 ≠ 缓和）」。本条是调研文档 §6 候选 3 的落地。

决策：

1. **不判失败，只把它变成三处看得见。** 挂起是合法态（「挂起不是失败」是本仓口径）、改代码是
   发布常态 —— 判失败会让「续跑」在正常迭代节奏下频繁失败；而 §4.1 的害处是「没人知道」，
   不是「不该继续」。三处：`menu.drift` 事件（时间线；经 `onTraceEvent` 也进
   `GET /tasks/:id/stream`，见 `tracer.event()` 的 `span.event` 记录）、父 span 属性
   `menu.drift`（可查询：`TaskRecord.result.trace` 里就带得到）、`console.warn`（运维面立即
   看见，与 ②「sink 失败落 warn」同款）。**严格模式（带具名 error 的收尾）本轮不做** ——
   它要动公共选项面 + limits 真源表，记进 §11 开放项。
2. **签名口径 = 名字 + 输入 schema**（新纯件 `engine/menu-drift.ts`）：落 run 根 `tools.names`
   （排序、截断带省略标记）与 `tools.menuHash`（规范序列化后 sha1 截 12 位），与
   `prompts.versions` 同一动机（质量回归定位到具体菜单版本）。规范序列化 ⇒ 与菜单顺序、schema
   键序无关；**`description` 刻意不参与**（改文案不该让在飞 run 被标记；代价是「只改描述」我们
   看不见 —— 有意的取舍，已钉在用例里）。用 sha1 而不是自造哈希：碰撞在这里是**静默失效**
   （两段不同菜单判成同一段），不值得为省一个内置模块自造。
3. **漂移判据只看名字，且判据只有一份**：`detectMenuDrift(uses, tools, { resultSchema })`。
   ⚠️ `resultSchema` 在场时把隐藏的 `submit_result` 当**在册** —— 它从不进 `args.tools`，忘了
   这条会把**每一次**带 resultSchema 的续跑都误报成漂移（所以由本函数收 `resultSchema` 而不是
   让调用方传名字清单：口径只有一份）。**不看「输入还合不合法」** —— 那段输入在挂起时**也没**
   校验过，拿它当漂移证据是误报（模型本就可以给一份不合法的入参）。
4. **与回合内的 `unknown_tool` 刻意分开**：那个是模型幻觉（模型拿一句 unknown tool 就能自我
   修正，走既有路径，钉在 `tests/engine/toolTiming.test.ts`）；本条只管**续跑**时名字对不上 ——
   那是我们的部署动作把一条在飞 run 的意图作废了。两条阴性对照各钉一边（工具都在 ⇒ 零信号；
   回合内 ⇒ 不判漂移）。
5. **落点**：`engine/menu-drift.ts`（纯判定单源）+ `loop.ts` 两处调用（run 根记签名、续跑入口
   报漂移）。`SUBMIT_RESULT` 随之从 `turn.ts` 导出（engine 内部，**不进公共面** —— `index.ts`
   与 api.html 零变化）。

门禁两处（分工：**引擎侧钉判定口径、传输侧钉接线**，只动一侧不会两边都绿）：
`tests/engine/menu-drift.test.ts`（10 条：纯件 6 + 集成 4）与
`tests/transport/async.test.ts` 的「HITL 续跑时的菜单漂移」（1 条：两个 AppCallable 代表
**两次发布**的同一应用、共用一个 store ⇒ 第二个 runner 就是「重启 + 发布之后」的进程，走
`submit → 挂起 → approve → 续跑` 全链）。变异电池 7 条各自咬住目标（其中 3 条同时打红两侧）：
哈希材料去掉 schema ⇒ 2 条红（「schema 变了 ⇒ hash 变」+ 键序那条）/ 去掉 `submit_result` 在册
判定 ⇒ 1 条 / `description` 混进签名 ⇒ 1 条 / 信号打到空 span ⇒ **两侧各 1 条** / **无条件报
漂移 ⇒ 打红阴性对照**（这一步证明阴性对照不是真空变绿）/ 不记 `tools.names` ⇒ 1 条 /
干脆不报漂移（回到静默）⇒ **两侧各 1 条**；还原后工作区 0 改动、两侧复绿。
`npm test` 1319/1319，`menu-drift.ts` 覆盖率 100/100/100/100。

⚠️ 实测（生产路径真跑，非单测）：挂起段 run 根 `tools.names='danger'`、续跑段 `='safe'` ——
**跨段比对菜单版本**靠的就是这两个 attribute 的差。

**2026-09-28 复审补记两条**：① **次序收口** —— 续跑入口的漂移检测原先排在 abort 判定
**之前**：一条已取消的续跑（不会再跑任何工具）也照发 `menu.drift` 事件 + `console.warn`，
纯噪音。已改为 abort 判定先行；变异（次序换回）恰好咬死「已取消的续跑不发漂移信号」用例
（另有阳性对照：未取消的同款续跑照发）。② **措辞订正** —— `menuSignature` 的注释原先写
「签名覆盖 schema ⇒ 能被两段签名比出来」，易被读成续跑时**自动**比；实际比对是**离线的**
（跨段 hash 对比由人/外部工具做，代码里没有任何一处自动比两段签名），注释已点明。
「签名变了自动报」若要做，是把两段 hash 的比对接进续跑入口 —— 动公共信号面，留给后续立项。

### 2026-09-28 ①：**挂起改成「一个状态 + 一个原因」**（`awaiting_approval` → `suspended` + `suspendedReason`）—— durable timer（候选 1）的前置

背景：起草候选 1（`wakeAt` 挂起）时按 `docs/plans/2026-09-27-durable-wake-at.md` 的核证清单
逐条读码，量出「多加一种挂起」的真实成本**不在状态机骨架，而在用 `===` 逐值点名的地方** ——
`isTerminalTask`（`async.ts:123`）、`resume-policy.ts:47`（非 queued/running 一律报 skip 原因
`'terminal'` ⇒ 一条在睡的 run 会被**具名成「终态」**）、`store.ts` 的淘汰白名单，再加两条只认
`awaiting_approval` 的闸（`approvalExpired`、`approve` 的 409）。设计稿 §2 给了三个分叉
（A 复用旧状态 / B 新增 `awaiting_wake` + 谓词 / C 一个状态 + 原因字段），**用户定案 C**。

决策：

1. 「挂起」拆成**一个状态 + 一个原因**：`RunStatus.suspended` 只说「它在等」，
   `suspendedReason` 说等什么（`'approval'` 等人工决定 / `'timer'` 等一个时刻）。
2. **引擎侧同步改名**：`AgentStopReason` 的成员也从 `awaiting_approval` 改成 `suspended`，
   原因走结果字段。结果形状里本来就有 `suspendedMessages` —— 「suspended」是这层自己的词；
   留着 `awaiting_approval` 会让同一条 run 在引擎与宿主两层说两种话，正是 C 要消掉的不一致。
3. **判据落在原因上**（本条的要点，不是顺手）：`approvalExpired` 增
   `rec.suspendedReason === 'approval'`；`approve` 对非 `approval` 挂起一律 409（文案点明原因）。
   若只看状态：配了 `approvalTimeoutMs` 的宿主会把一条等时刻的 run 判成「审批超时」，而
   `#expireAndResume` 紧接着就 `fillTimeoutDenials` + 重派（它没有待决项，补不出任何决定，
   `approvalsComplete(空)` 还是 true）—— **提前叫醒 + 一次真实 run 的开销**。
4. 落库时**原因从结果形状里取，不写死**（`rec.suspendedReason = out.result.suspendedReason`）：
   写死成 `'approval'` 会让将来新增的原因在落库这步被悄悄改写。
5. 字段改名：`TaskRecord.approvalPendingSince` → **`suspendedSince`**（它本来就是「挂起时刻」，
   两个原因共用；`approval.decided` 的 `waitedMs` 与超时基准链一并沿用）。

破坏面（逐条）：

- `RunStatus` / `AgentStopReason` 的成员名（两个公共字面量联合）；
- 加法：`AgentRunResult.suspendedReason`（结果形状现在 8 个字段全在场）、`RunMeta.suspendedReason`、
  `TaskRecord.suspendedReason`、新导出 `SuspendedReason`（api.html 导出计数 224 → 225）；
- 持久化键名：`approvalPendingSince` → `suspendedSince`；
- ⚠️ **持久化里的旧状态值**：库里 `status: 'awaiting_approval'` 的记录在新代码里**既不是挂起
  态、也不被 `resumePending` 认作挂起**（`isTerminalTask` / resume-policy 都按逐值判定）⇒
  升级前停着的挂起会成**孤儿**。本版**不做兼容读**（`SuspendedReason` 是类型、不是别名），
  迁移办法写在 CHANGELOG 的「迁移」小节；要不要补垫片见 §11。

门禁（两条闸各配一个变异，都亲跑过）：

- `tests/transport/approval-policy.test.ts`：夹具缺省带 `suspendedReason: 'approval'` ——
  **挂起记录必须带原因**（夹具如实反映形状，不是可选装饰）；新增「`timer` 挂起不被审批超时
  叫醒」**+ 阳性对照**（同一时间戳只把原因换成 `approval` ⇒ 立刻过期，证明上一条不是真空变绿）。
- `tests/transport/approval.test.ts`：新增「`timer` 挂起 `approve` 一律 409，且不派发、状态与
  挂起时刻不动」。
- 变异 A（摘掉 `approvalExpired` 的原因闸）⇒ 恰好那条新用例红；变异 B（`approve` 退回只看
  `status`）⇒ 恰好那条新用例红；两次还原后 `src/` 干净且复绿（脚本 `trap` 还原 + 还原自检）。
- 文档守卫自动咬合（**不是「守卫过时」，是它按设计工作**）：`tests/docs/api-page.test.ts` 抓出
  `AgentRunResult` 漏写 `suspendedReason`（「形状自陈穷尽却漏成员」）与页头导出计数 224 ≠ 225。
- 全量 `npm test`：三套件绿（含覆盖率棘轮）。

⚠️ **本条不含 `wakeAt` 本体**：时间挂起、到期续跑、挂起期可见性、drain 后不唤醒都还没做
（`src/` 里 `timer` 目前**没有任何生产者**，只有类型与那两条闸）；本条只是候选 1 的前置。
→ **该待办已于同日 ② 补上**（见下一条）。

### 2026-09-28 ②：**时间挂起本体落地**（`ctx.deferUntil` + 到期唤醒 + 配套 5/6）—— `timer` 从此有生产者

背景：上一条（①）把「挂起」拆成「一个状态 + 一个原因」，但那条末尾如实记着「`src/` 里 `timer`
**没有任何生产者**」。本条补上生产者与它下游的三件事（设计稿 `docs/plans/2026-09-27-durable-wake-at.md`
§3 + §4 配套 5/6；**定案：状态分叉 C + 请求方形态 ①**）。

决策：

1. **请求方形态 = 工具侧请求延后**（设计稿 §3 形态 ①）：`ToolRunContext.deferUntil(at: number | Date)`。
   不做 run 级「先睡一会儿再开跑」—— 那与既有 `transport/scheduler.ts`（定时起新 run）是同一个
   东西的第二种拼法。真实用途：等批处理作业、等限流窗口、等收盘、等外部系统回填。
2. **时刻必须是将来，非法值当场抛**（`engine/defer.ts::resolveWakeAt`）：非有限数、`at <= now`
   一律 TypeError，走既有「工具抛错 ⇒ is_error 的 tool_result」路径（run 照常往前走，不挂起）。
   为什么必须响亮：让 `at <= now` 成立的话，到期扫描会立刻唤醒、重跑、工具再请求同一个过去时刻
   —— **一条自己打转的 run**（不烧钱，但 store / trace / 判据全在空转，且永不收尾）。
3. **整批语义**：挂起是回合级的（协议要求每个 tool_use 都有配对 tool_result）⇒ 延后请求
   **作废本回合这批工具的全部结果**，醒来后**重跑这一批**（与审批续跑同形）。代价是同回合
   已执行完的兄弟工具会再跑一遍（副作用重复）—— 这一条**不靠口头约定**：写进
   `ToolRunContext.deferUntil` 的契约注释、trace 的 `defer.requested{discarded}` 计数，
   并在真有兄弟工具被作废时落一条 `console.warn`。要精确控制就让模型单独调它，或做成幂等读。
4. **一个回合只能有一个时刻**：同回合多条请求取**最早**的那个（早醒可补救，晚醒白等）。
5. **两条闸按原因分开**（承接 ① 的口径）：到期判据落在新纯件 `transport/wake-policy.ts` 的
   `timerDue`（状态 + **原因** + `wakeAt <= now`）。缺 `wakeAt` 时**不**退化到 `createdAt`
   （这里与 `approvalExpired` 的取舍相反）—— 「不知道它什么时候醒」与「现在就该醒」是两件事，
   猜错的方向是**提前开跑**，代价是真实副作用。
6. **配套 5（排空）**：`drain()` 之后**不唤醒**（与「submit 在 drain 后回 503」同纪律：停机 =
   不再往前推）。不设这道闸，停机窗口里一条天级的 sleeping run 会被叫起来接着跑 —— 部署卡在
   它身上；重启后由新进程的首次 `resumePending` 唤醒（那时窗口早过去了）。
   **`cancel` API 本批不给**：它要新增公共面（`runner.cancel(taskId)`）、定义「取消一个正在跑的
   工具」的中止语义、并决定取消算不算新终态 —— 是**独立一件**，与 `wakeAt` 无因果关系。
   文档只如实写「取消靠宿主自己 abort 在飞请求 + 不唤醒」，不留一句「用户可以取消」。
7. **配套 6（可见性）**：`AsyncRunner.suspendedSummary` + `GET /healthz` 的
   `suspended: { approval, timer, nextWakeAt }`。口径 = **本进程**看得见的记录（与 `inFlight`
   同一张表 —— 不假装是全局面）；读数由三条纪律维护：进挂起登记 / 离开挂起除名 /
   **每次 `resumePending` 扫描按 store 重建**（扫描本来就 list 了全表，把「漏了某个出口」从
   永久漂移降级成下次扫描前的偏差）。`/healthz` **不查 store**：探针是秒级频率，而 `list()`
   要把每条记录的完整 trace 取出来 —— 代价比它回答的问题大。无时间挂起时 `nextWakeAt` 给
   **`null` 而不是 `0`**（`0` 在 JSON 里是合法时刻，监控端算 `nextWakeAt - now` 会得到巨大负数，
   看着像「早就该醒却没人醒」）。
8. **两处顺手修掉**（都是 ① 的核证清单点过名的）：① `resume-policy` 给挂起单列 skip 原因
   `'suspended'`（此前被报成 `'terminal'` —— 「在等」被具名成「终态」是静默说错话，而这个字段
   的全部用途就是诊断）；② `isResume` 判据补上 `suspendedSince`（原先只看 `approvals`，而
   timer 挂起醒来时**没有任何决定** ⇒ 恢复段被当成首次执行：会话历史重复 prepend、恢复段 trace
   不 link 上一段、成功后把含未决 tool_use 的扩展历史写回会话）。
9. **与候选 3 的交界**：醒来走的是**同一条续跑入口** ⇒ `detectMenuDrift` 自动生效（睡着的这段
   时间里那个工具被删掉，醒来时三处漂移信号照出），不另起一套判据。

兼容面（**全部是加法，无破坏性**）：`ToolRunContext.deferUntil`、`AgentRunResult.wakeAt`
（结果形状现在 **9 个字段**全在场）、`RunMeta.wakeAt`、`TaskRecord.wakeAt`、`HealthResponse.suspended`、
`AsyncRunner.suspendedSummary`；新 trace 事件 `defer.requested{wake_at, tool_use_ids, discarded}`。

门禁（**13 条变异逐条亲跑**，全部被**具名**用例抓住；`trap` 还原 + 还原自检 + 复绿）：

- `tests/engine/defer.test.ts`：`resolveWakeAt`（将来性 + 非有限数的响亮拒绝，带阳性对照）
  + 回合级收集器（多条取最早、同一条重复请求取更早）+ 引擎侧**五例**：整批挂起（工具**真跑过**、
  结果作废、`defer.requested` 带 `discarded`）、醒来重跑那一批（`tool_result` 真进了下一次请求）、
  醒来仍未成熟 ⇒ 以**本次**请求再挂一次、非法时刻 ⇒ is_error 不挂起（含台账 `errorKind: 'threw'`）、
  **同批有没请求延后的兄弟工具 ⇒ `discarded` 数到 2 + 恰好一条 `console.warn` + 醒来那个副作用
  真的跑第二遍**（前两件是信号、第三件才是事实；配 M12/M13 两条变异：摘掉告警 / 把 `discarded`
  改成只数请求延后的那几条 —— 两条都只打红这条用例）。
- ⚠️ **一条假 BAD 也记在这里**：变异脚本的套件白名单漏了 `defer.test.ts` 的 describe 名，
  于是 `时间挂起（引擎侧）` 这条**套件行**在失败列表里冒充「非预期红」，两条变异一度被读成
  BAD（实为 OK）。这正是「套件行与用例同名同形」那个老坑的可执行形态 —— 补白名单后复跑即 OK。
- `tests/transport/wake-policy.test.ts`：`timerDue` 三条边界（到点即醒 / 只在挂起且原因是 timer /
  缺 `wakeAt` 永不到点）+ `summarizeSuspended`（空集给 `null` 不给 `0`；只有等审批时不退化）。
- `tests/transport/durable-timer.test.ts`：宿主侧**八例** —— 睡下时落库与读数进位、未到点不捡而到点
  唤醒并重跑、**读路径的惰性唤醒**（`poll` / `GET /tasks/:id` 自己叫醒到点的任务 —— 这条用例
  **一次都不调** `resumePending`，把「到期判定挂在读路径上」单独钉住）、drain 后不唤醒（附
  「新进程照常唤醒」对照）、审批超时不误伤 timer（附「换成
  `approval` 就被兜底」对照）、`/healthz` 的 `suspended` 段、与候选 3 的交界（醒来时
  `menu.drift` 事件 + run 根属性照出）、session 与链路口径（会话只一份 / link 上一段 / 不被
  工具块毒化）。
- ⚠️ **盘点补出两处「零红的新闸」**（同日按「摘掉它有没有用例会红」逐条问出来的；两处都是
  **本批新加的**判据，却因为既有用例只覆盖了它的兄弟而无人守）：
  1. **读路径的 `#lazyGates` timer 分支**：到期判定有**两个**调用点（全表扫描 / 读路径），
     既有用例只钉了扫描那个 ⇒ 摘掉读路径那半行**全绿**。已补阳性用例（见上）+ 变异 **M10**
     （摘掉那行 ⇒ 恰好那条红）。
  2. **`deferUntil` 的不转发归类**（`engine/forwarded.ts`）：那条「引擎自装配的键一个都不许漏进来」
     的断言**手抄了五个键名**，新增的第六个键没人补 ⇒ 把它挪进转发组照样全绿。已把清单改成
     **从夹具派生 + 数量下限**（下限 6 是故意的停顿点：新增不转发键时会被迫做一次「要不要转发」
     的判断），并配变异 **M11**（清单 + 取值对象一起挪 ⇒ 恰好那条新断言红，**旧的键集断言仍绿**
     —— 这正是「新断言多守了一层」的证据）。
- **一处文档措辞订正**：设计稿 §4 写的是「`snapshot()` 与 `/healthz` 各加一段」，而本仓
  **从来没有 runner 级 `snapshot()`**（`snapshot()` 是 metrics 侧与 tracer 的名字）——
  读数实际落在 `AsyncRunner.suspendedSummary` 这个 getter 上，`/healthz` 读它。日期档正文
  一字不动，订正指针加在那份稿子的 §8（本轮只动了 §8 的**新增块**）。
- ⚠️ **一处用例自己的缺陷被变异电池抓出并当场修掉**：`timerDue` 的「原因」夹具原先写
  `suspendedReason: 'approval', wakeAt: undefined` —— 摘掉原因判据的变异**一条红都没有**
  （缺时刻那一条也在拦 ⇒ 等于没钉住原因这一半）。改成带一个过去的 `wakeAt`（宿主手写 /
  旧版本记录可能出现的形状）后立刻变红。这条记在这里是因为它正说明**变异电池不能省**：
  用例绿不等于判据被钉住。
- 一处**实现缺陷**被新用例抓出：`#wakeDue` 原先不返回「是否真接管」，`drain` 之后每次扫描都把
  没唤醒的算进 `resumePending()` 的返回值（谎报「推进了 N 条」）—— 改成返回 boolean。
  计数口径与审批那条（`#expireAndResume` 在飞也计入）**刻意不完全对齐**，差异写在方法头注里。
- 模拟「时间到了」用**倒填 `wakeAt`**，不睡墙钟：真等会把「调度慢」误判成「唤醒坏了」
  （CI 满载下最难查的那类红）。
- **同日复审补记（drain 竞态窗口）**：`#wakeDue` 的 drain 闸判在「进入」时，而
  `#wakeDueInner` 落库与派发之间还有两个 store 往返的窗口 —— drain 在这窗口内完成
  （active===0 返回 true）的话，被唤醒的任务会在停机**完成之后**才开跑。已修：落库之后、
  派发之前再判一次 `isDraining`，停机则**不派发**（状态已落库 running，留给下次启动的
  `resumePending` 认领 —— at-least-once 兜底，与「先落库再派发」的崩窗同形）。
  回归用例用可控闸把窗口撑开（save 挂起 → drain 完成 → 放开 ⇒ 不得派发）；
  变异（摘掉复判）恰好咬死该用例。
- **同日复审补记（defer 吃掉 abort）**：回合内「工具请求延后」与「run 被中止」
  （runTimeoutMs 到点 / cancel）同时成立时，原先 deferred 分支先返回 ⇒ run 挂成 timer，
  **取消/超时的意图被吃掉**（timer 到点会自己醒接着跑 —— 审批挂起要人来推、且 cancel
  能翻转 suspended，timer 没有这下一棒）。已修：deferred 分支先判 `signal.aborted`，
  abort 赢（落 `aborted` + 结构化 error，不产生挂起历史）。变异（摘掉该判定）恰好咬死
  `defer.test.ts` 的「defer × abort」用例。

### 2026-09-28 ③：**旧记录的读时归一**（迁移垫片）—— 六个读回点收成唯一入口

背景：① 的状态改名是破坏性的，而**落盘的数据不受类型系统保护** —— `JSON.parse(raw) as TaskRecord`
里那个 `as` 是对盘上数据的一句保证（TS 只检查你**写进**类型的值）。旧记录读回来带着一个
`RunStatus` 里**已经不存在**的值，而每一处判断都按新语义读它：`isTerminalTask` 认它**终态**
（事件流早关、`resumePending` 不捡）、`resume-policy` 报 `'terminal'`、`/healthz` 不计数、
`approve` 回 409「状态不对」—— 一条在等审批的 run 成孤儿，**四个角度同时错**。
此前（① 的处置）只在 CHANGELOG 里要求宿主手工改库。

决策：

1. **形态 = 读时归一 + 落库自愈**，落点是新件 `src/store/record.ts`：`parseTaskRecord`
   （解析 + 形状守卫 + 归一）成为那六个「bytes → 记录」点的**唯一入口**（`fsStore` 的全量扫 +
   残行探测、`sqliteStore` 的 get / byIdempotency / list、`redisStore` 的单键读）。
   静态守卫盯着它：`src/store/*.ts` 里除 `record.ts` 外不得出现 `JSON.parse`（带抽词器下限 +
   阳性对照）—— 将来加第七个 store 会被逼着走同一个入口，而不是又长一个漏归一的点。
2. **只搬运盘上真有的东西**：`awaiting_approval` → `suspended` **并且补**
   `suspendedReason: 'approval'`（两条闸都按原因判：只改状态会让这条记录被**两条都**漏掉 ——
   比不归一更坏）；`approvalPendingSince` → `suspendedSince` 并**删除旧键**（两个键并存时任何读者
   都可能读到错的那个；而且不删就不幂等，归一**永远**返回「动过了」）。
   新形状的记录若缺 `suspendedReason` 则**不动它** —— 那是另一个缺陷，垫片不替它打掩护。
3. **SQLite 额外回写派生列**：`status` 列是 json 的反规范化副本（专供外部/DBA 统计）。只在读时
   归一 json 的话，`SELECT status, count(*) GROUP BY status` 会**继续**报旧值 ⇒ 框架说一种事实、
   库里另一种。判据写成「列 ≠ json」而不是「刚才归一过没有」—— 任何原因（手改过、旧版本写的、
   将来又一次改名）造成的漂移都该被顺手修掉。自愈失败（只读库 / 占锁超时）**响亮说一次**
   （按 taskId 去重），不静默。fsStore / Redis 没有派生副本 ⇒ **不回写**（append-only 日志与
   单键都是 last-wins，写回时机是这条记录的下一次 save），取舍写进代码注释与用例。
4. **坏 JSON 的取舍不变**：三条 store 对「单条损坏」口径本就不同（文件与 Redis 跳过该条、
   SQLite 照旧抛），归一层只做「解析 + 形状守卫 + 归一」，不越权决定「坏了怎么办」。
5. `sqliteStore.list()` 伴随一处行为收紧：形状不合格（没有 `taskId`）的行**跳过**而不是当成记录
   返回 —— 与 get 口径对齐（本实现自己写的行不会是那个形状）。

兼容面：**无公共 API 变化**（`src/store/record.ts` 不进 `src/index.ts`，导出计数 225 不变）。

门禁与变异（**5 条变异逐条亲跑**，全部被**具名**用例抓住；`trap` 还原 + 还原自检 + 复绿）：

- `tests/store/record.test.ts`：归一函数（含**幂等**、阴性对照「新形状缺原因也不猜」、两个键都在时
  以新键为准）、唯一入口的形状守卫（坏 JSON 照旧抛 / 非记录给 `undefined`）、
  **三条 store 的读回接缝**（SQLite 那条先断言「列里确实是旧值」**再**断言被拉正 —— 否则
  「自愈生效」这句话证明不了）、外加静态守卫那条。
- 变异 M14（不补原因）/ M15（不搬挂起时刻）/ M16（SQLite 不回写列 —— **只打红 SQLite 那条**，
  另两条 store 没有派生副本）/ M17（唯一入口不归一，覆盖面最广）/ M18（旧键不删，顺带打红幂等那条）。
- ⚠️ 两条一开始被读成 BAD 的变异（M14 / M18）其实是**我的期望写漏了**：多出来的红落在同一条性质的
  另一处断言上（唯一入口那条也断言了原因；幂等那条正是「不删旧键 ⇒ 永不幂等」的证据）。
  处置是**把真红补进期望**，不是放宽期望 —— 读变异读数时「红在别处」要读进去，别直接当成锚点没选准。

### 2026-09-28 ④：**`cancel` API**（durable 配套 5 的另一半）—— 取消是一个状态，不是「失败」

背景：配套 5 当初明确「`cancel` 今天不存在，独立一件」。核证到两条关键事实：
① **引擎侧早有取消出口**（`stopReason: 'aborted'` + `abortedError()`，`loop-result.ts` 的注释
写着「已取消 —— 带结构化 error（**取消不是失败**，但原因要可查）」），但**宿主把它落成
`failed`**（`async.ts` 的 `rec.status = out.run.status`）—— 缺的不是机制，是「这个动作 +
说实话的状态」；② `awaitTask` 的终态集合是**手写两值**（`succeeded | failed`），加新终态而不改
它 ⇒ 取消后等待**静默挂到超时**（症状像「取消没生效」，且不是编译错误）。

决策：

1. **落库状态：新增 `RunStatus.cancelled`**（设计稿 §2 分叉取 B；加法变更，非破坏性）。
   状态按**意图**落、不按**机制**落 —— 同一条 abort signal 有三个来源（调用方传入 /
   `runTimeoutMs` / 取消），反推不出「谁按的」；超时的收尾语义**不变**（仍是 `failed` +
   `error.type === 'timeout'`）。`isTerminalTask` / 淘汰白名单 / `resume-policy` 三处**自动**
   正确（新状态非 queued/running/suspended ⇒ 终态），**必须一起改**的只有 `awaitTask` 那一处。
2. **三种「在服」状态的语义**都由 `AsyncRunner.cancel` 一处实现：
   `running` ⇒ 中止在飞 signal 并等它真收尾（尊重 signal 的 client 是**真中断**，token 不再烧）；
   `queued` ⇒ 落终态，且认领处**重读一遍**再判（被取消的排队任务**绝不起跑**）；
   `suspended`（两种原因）⇒ 落终态即「不唤醒」（两条唤醒闸都 gate 在 `status === 'suspended'`
   上，翻转是推论，不需要第二处标志）。
3. **顺带补一个真洞**：`#executeInner` 拿到槽位后原先**不重判状态**、直接写 `running` ⇒
   排队期间被取消的任务**照样会跑**（记录说 cancelled、副作用真发生 —— 最坏的一种谎）。
   判据**只挡终态**（写成「状态不等于 queued」会把 approve / 到期唤醒 / 崩溃重投三条**先置
   running 再派发**的恢复路径全挡死）；store 读取失败**不改变既有行为**（那道闸只负责
   「明知已终态就别跑」，不把读取故障升级成「任务起不来」）。
4. **无法真中断 ⇒ 如实说，不假装**（两种情形都抛 `TaskCancelError(409)`）：
   在跑的 run **不在本进程**（没有句柄可中断）；或宿主**不认 `signal`**（宽限 `CANCEL_GRACE_MS`
   = 2s 内没收尾 ⇒ 撤回意图 + 409）。与 `runTimeoutMs` 对同样情形的「放弃等待」**刻意不同**：
   超时是宿主自己定的预算，取消是人手按的动作，骗人的代价不一样。
5. **记账归属说定**（`#cancelSettled`）：cancel 自己收尾过的任务，那趟等槽位的 `#execute` 的
   finally 只做在飞递减 / 等待者 / 排空通知，不重复 sinks / 流收口 / 会话清理 / 认领释放 ——
   否则 `onFinished` 触发两次。
6. **路由**：`POST /tasks/<id>/cancel`（照 `approve` 那套排法：先鉴权、方法检查先于解码 ⇒
   `GET` 回 405 + `Allow: POST`、`DELETE /tasks/%zz/cancel` 回 405 而不是 400）；
   404 / 409 由 `TaskCancelError` 映射。**停机中仍可用**（停机窗口正是最想取消在飞任务的时候）。

兼容面（**加法，无破坏性**）：`RunStatus` 多一个成员（导出**计数不变**）、
`AsyncRunner.cancel`、`POST /tasks/<id>/cancel`。`TaskCancelError` 是 module 级导出
（**不进**公共导出面，与 `TaskApproveError` 同款）。

门禁与变异（**6 条变异逐条亲跑**，`tests/transport/cancel.test.ts` 11 例）：

- 用例：在跑那条走**真引擎**（工具挂在 `ctx.signal` 上，断言 `stopReason: 'aborted'` +
  `status: 'cancelled'` + `error.type: 'aborted'` + 槽位释放 + `onFinished` 恰一次）；
  排队那条钉「一次都没跑」；两种挂起各一条（timer 那条还断言读数除名 + 两条路都不唤醒）；
  409/404（且记录一个字节不动）；`awaitTask` 立刻返回；HTTP 四条路由判据（含 405 的 `Allow`）
  + 停机中受理；两条**阳性对照**（不取消照常跑 / `runTimeoutMs` 仍落 `failed`）。
- 变异 M19（落库不按意图判）/ M20（认领不重判）/ M21（终态集合退回两值）/
  M22（不补结构化原因）/ M23（sinks 那道闸失效）/ M24（路由顺序）。
- ⚠️ 三处如实记录：① 首轮 M19/M24 被判 BAD 是**我的期望写漏了**（多出来的红落在同一条性质的
  另一条用例上 —— 处理是把真红补进期望，不是放宽期望）；② 首轮 M23 变异的是 finally 里那几个
  **幂等**操作（流收口 / 认领释放 / 会话清理），它们与 cancel 自己做过的重复执行无害 ⇒
  **结构性无症状**，不红是正当的；真正有基因的是 sinks 那道闸（`onFinished` 两次），
  已改成变异它；③ 改成 sinks 之后 M23 **仍然零红**，第二层原因是**断言的时点**：重复通知发生在
  「那趟等槽位的 `#execute` 拿到槽位」时，而断言写在 cancel 返回那一刻（那时它还拿不到槽位）——
  处置是把断言挪到**收尾之后**，并在用例里写清「它为什么必须在那儿」。

**同日复审补记**（外部复核抓到，全部已修 + 各补一条回归用例）：① submit 的幂等去重白名单
漏了 `cancelled` —— 排队取消的任务一次都没跑过，同键重提却认回那条 cancelled 记录
（静默吞掉）；修为 `failed` / `cancelled` 都不挡重提。② 「拒绝式认 signal」的宿主
（abort 后 **reject**，包 fetch 类客户端的常见写法）走 catch 出口落 `failed` +
`error.type: 'unknown'` —— 正是本 API 要治的病；修为意图布尔在 finally 摘除前取出
（`Set.delete` 的返回值）、catch 里据此落 cancelled。⚠️ 实现时踩了一课：`let` 写在
try 块里 catch 看不到（块级作用域），首轮写成那样直接 ReferenceError —— 被既有阳性对照
用例当场抓住。③ `#cancelSettled` 原先对 suspended-cancel 也登记，而挂起任务没有活着的
`#execute` 来消费 ⇒ 每取消一条挂起任务漏一条（无界增长）；修为只为 queued 登记，
并在注释里登记多进程下他进程取消本进程排队任务会双发 onFinished 的既知边界。
变异复验：摘白名单 ⇒ 「同键重提」红；catch 恒 failed ⇒ 「拒绝式认 signal」红。
- 一处**用例缺口**是本轮自己盘出来的：「取消必须带结构化原因」那条兜底只在「宿主返回的
  `result` 是成功形状」时生效，而原先没有这一类宿主 ⇒ 摘掉它一条红都没有。补了那类宿主
  （「半认」signal：abort 后返回、但返回成功形状）之后 M22 才咬得住。

### 2026-09-28 ⑤：到期索引（候选 7②）的**工作量级实测** —— 先量，结论随 store 分岔

背景：候选 7② 的原话是「`resumePending` 的扫描 O(全表)，**上量之后才现形**」。既然「上量」
是个数字，本条目先把它量出来（`scripts/bench-resume-scan.ts`，可重跑）——不先长一层平时没人走的索引。

实测（单机空载、单次读数，看量级不看小数；N = 记录总数，其中 1/10 是 `suspended` 带未来 `wakeAt`）：

- **file store**：`load`（重启时的全表 JSON 解析）**0.9 / 5.5 / 54.0 ms**、`resume` **0.9 / 1.3 / 9.9 ms**
  @ N = 100 / 1k / 10k。⚠️ 读数口径：它的记录**在内存里** ⇒ `list()` 只是返回 Map 的快照，
  真正贵的是构造期 load；所以这一侧「每轮扫描」很便宜。
- **sqlite（`:memory:`，`list()` 每次是真查询）**：`list` **0.7 / 5.2 / 113.0 ms**、
  `resume` **52.4 / 8.0 / 117.1 ms** @ 同上。

结论（**分岔**，不是一刀切）：

- file store 上一轮扫描在 **10ms** 量级 ⇒ **不值得先做**（提前做等于给一条平时没人走的路径付利息）；
- sqlite / redis 这类「`list()` 是真查询」的 store，10k 记录上一轮 ~**117 ms**，且随 N 线性增长
  （100k ⇒ 秒级）⇒ 宿主把 `resumePending` 跑在秒级间隔时，这是一笔可观的固定开销 ⇒ **值得做**。
- **触发条件**（写进 §11）：store 的 `list()` 是真查询 **且** N ≳ 10k **且** 宿主扫描间隔 ≲ 1s。

形态（**未做，待定案**）：store 侧**可选** `listDue?(before)` + runner 缺省回退 `list()`（加法，不破
自定义 store）。⚠️ sqlite 那边还有一处要单独拍：`wakeAt` 今天在 **json** 里 ⇒ 要么用 `json_extract`
（不动 schema、依赖 JSON1），要么新加 `wake_at` **列** —— 后者与 ③ 刚建好的「派生列 + 读时自愈」
是同一类取舍（多一份真源，就多一处要维护一致）。

⚠️ 本基准的边界如实写：单进程单连接、`:memory:`、没有多进程锁等待；**redis 那条路没有量**
（形态与 file 同类，但 `list()` 是 SCAN）。**要拍板 7② 之前**：sqlite 的数字够了（它是最贵的一侧），
但别把 file 的数当全局证据。

**已落地（2026-09-28 ⑥ 同批）**：sqlite 侧触发了（`list()` 是真查询且线性增长），形态按上面
定案的那条走 —— `TaskStore` 加**可选** `listDue?(before)`（接口加法，不破自定义 store），
`SqliteTaskStore` 用**派生列 `wake_at` + `(status, wake_at)` 索引**实现（不选 `json_extract`：
它仍要对扫到的每一行解析 JSON，是 O（全表） 的 C 版；派生列与 `status` 列同一条「多一份真源」
取舍 —— save 单写点维护 + 读时自愈判据扩到两列 + 存量库构造期就地迁移并回填）。
InMemory / File **不实现**（注释写明为什么：它们的 list 本就在内存）。
runner 侧接线是 `#redispatch` 的到期唤醒那一半：`listDue?.(now) ?? list()` 的过滤输入 ——
⚠️ **只**那一半（挂起读数重建 / 审批超时 / 孤儿认领仍以全表为输入），探针用例
（`durable-timer.test.ts`）钉「listDue 的结果是该半的唯一输入源」。
**实测偏差如实记**：`resumePending` 的总耗时**没有**显著下降（10k 档前后都是 ~33ms）——
全表 `list()` 仍是其余三条职责的输入，它主导成本；listDue 把「到期唤醒」那半的输入降到
O（到期数）（10k 档 list 37.8ms vs listDue 0.1ms），这笔节省只有在「扫描职责被拆开 / 出现
`listActive` 式的窄查询」之后才会兑现到 `resume(ms)` 上。这是「先把缝焊对」的一批，
不是「扫描已经变快」的一批。

**同日复审第二轮补记（redis 那一支的边界）**：上面的「已落地」段只说了 InMemory / File 不实现
—— **redis 一个字没提，而它其实是触发条件最先满足的那个**：`RedisTaskStore.list()` 是「按键枚举
（`scanIterator` / `KEYS`）+ 逐条读 + `JSON.parse` + 按 `createdAt` 排序」，即 O(N) 次往返 +
O(N) 次解析（比 sqlite 那条单次真查询更贵），而基准里**redis 那条路没有量**（本条目开头已如实记）。
未做的两条理由如实写：① **没有读数**（不做没量过的优化）；② **形态要另定** —— redis 没有派生列，
得靠辅助结构（如 `wakeAt` 分桶的 ZSET，score = 毫秒时刻）或键名编码，与 sqlite 的「派生列 +
索引 + 读时自愈」不是同一套取舍。⇒ 触发条件与形态候选记进 §11，等补上 redis 那一档读数再拍。

**同日晚补记（redis 那一档的读数 —— 形状已量，不是延迟）**：本机没有 redis 服务（无
`redis-server` / 无 docker）⇒ 脚本 `scripts/bench-redis-due.ts`（可重跑）量的是**形状**：零延迟
计数夹具下 `RedisTaskStore.list()` 的往返 = **1（keys 枚举）+ N（逐条 GET）**；负载 4KB/条时纯 CPU
（parse + 排序）**10.8 / 57.2 / 901.6 ms**、解析 **4.2 / 42.1 / 420.9 MB** @ N = 1k / 10k / 100k。
延迟按 `往返 × RTT` **外推**（逐档写明外推，**不写成读数**）：N=10k 时 **0.10 / 0.20 / 1.00 s**
@ RTT 0.1 / 0.2 / 1 ms，N=100k 时 **10 / 20 / 100 s**。

**值 = 值得做**（比 sqlite 那一档更充分：sqlite 是 1 次真查询、~38ms@10k；redis 是 10k 次往返）。
形态候选（待定案）：辅助 **ZSET**（member = taskId、score = `wakeAt`），写入点与 `save` 同处
（ZADD / ZREM，与派生列同一条「多一份真源、写时维护、读时自愈」取舍）；`listDue` =
`ZRANGEBYSCORE … LIMIT` 1 往返 + 每个到期记录 1 GET ⇒ **往返 1 + 到期数**（10k 档：10001 → 1001，
且不再随 N 增长、只随到期数增长）。

⚠️ 两条边界如实写：① 本表取的是**最省的枚举形态**（单次 `KEYS`）—— 真实客户端走游标分批
（node-redis 的 `scanIterator` 一批 `COUNT` 个键）时枚举那部分的往返**只会更多**；
② 夹具零延迟 ⇒ 只有 CPU 是实测，**延迟是外推**（要真读数得有个本地 redis 实例）。

### 2026-09-28 ⑥：**run 事件投入口**（候选 2 落地，定案 A3+B1）—— 外部输入第一次进消息历史，入口焊成窄的

设计稿：`docs/plans/2026-09-28-event-input-and-due-index.md`（§3 七条语义 / §4 八条门禁逐条有
真用例 + 变异验证，见该稿「实施记录」）。决策与取舍：

1. **形态 A3**：宿主方法 `runner.signalTask(taskId, event)` + HTTP 路由
   `POST /tasks/:id/events`（与 approve/cancel 完全对称：方法承载语义、路由是它的 HTTP 皮）。
   webhook 只能走 HTTP，而同进程模块不该被迫起 HTTP 请求。
2. **事件体 B1（白名单 `{ eventId?, type, payload }`，全是字符串）**：渲染成**一条 user 文本
   消息**进历史。B2（任意 `MessageParam`）/ B3（冒充 tool_result）**明确不做** —— 那是把
   「伪造 assistant / tool_use 块」的能力交给外部，投毒面从内容注入升级成协议注入；
   approve 今天只收布尔正是同一个理由。`parseEventBody` 多一个字段即拒（400），
   `payload` 上限与 `maxBodyBytes` 同口径（413），走既有 authenticate（不是免鉴权组）。
3. **对设计稿 §1 事实 4 的偏差（如实记）**：设计稿说「事件在恢复前追加到 `rec.spec.messages`
   末尾」。**这么做会坏**：续跑判定 `tailToolUses` 只认历史**末尾一条** —— 事件消息成了末尾，
   未决 tool_use 就不在末尾，续跑被判成新对话（同一批工具再跑一遍、审批决定作废），
   且 tool_result 不再紧邻 tool_use（协议残缺）。所以事件**随 record 走**
   （`TaskRecord.pendingEvents`，与 approvals 同一通道），由引擎在 `loop.ts` 的续跑入口、
   未决 tool_use **解决之后**注入消息流（`deliverTaskEvents`）。
4. **「再挂起」出口不注入**：恢复段若又挂起（审批决定仍不齐 / 工具再次 defer），注入会把
   user 消息留在历史末尾、毁掉**下一次**续跑判定 —— 所以那两个出口不经过注入点，事件留在
   `pendingEvents` 里等真正跑通的那次续跑（不清簿记 = 不丢事件）。推论：`submit_result`
   提前落定那条路在有待注入事件时**不**直接收尾 —— 事件是新输入，让模型看到再决定。
5. **幂等口径**：给 `eventId` 按 `TaskRecord.deliveredEventIds` 去重（随记录落库 ⇒ 跨进程/
   重启不丢；有界 FIFO 256 条 —— 去重簿记不是审计日志，超界后同 id 重投会再进一次历史，
   如实）。重复 ⇒ **409**（与 cancel 的「已终态」同款：说出来，不静默）。不给 `eventId`
   就没有恰好一次：重复投递 = 重复进历史，文档如实写（webhook 场景请带 id）。
6. **并发闸与 approve 不同款**：approve 的并发是「共享在飞那次」（决定幂等合并）；事件的并发
   **串行成链**（两条并发事件是两条不同输入，共享 = 静默丢一条）。与 approve/wakeDue 的
   跨闸竞速：进闸后重读再判挡住绝大多数；残余窄窗口与既有「approve × wakeDue 分闸」同类
   （那两条按挂起原因天然互斥，事件两种原因都适用，是这个闸新盖的缝）—— 多进程下的
   同类边界同 ④ 已记的口径。
7. **trace 留痕的落点**：`task.event { injected, event_type, event_id? }` 由**引擎**在注入时
   记到续跑段 run 根（runner 不持有 recorder —— 这是与 approve 的 `approval.decided` 同款的
   分工：决定/事件的**簿记**在 record，**留痕**在引擎经 options 拿到数据后自己记）。
   `injected` 恒 true 是有意的：只在注入那一刻记，投递但尚未注入（再挂起）不记。
   ⚠️ 口径是「注入进本段消息流」，**不是**「模型已看到」：该段若在首个模型请求之前
   中止/失败，事件不进持久化历史（终态分支无条件清簿记），留痕仍成立（它记的是注入动作）。
   （原名 `delivered` —— 外部深评 P3-2 指出它超前于事实，2026-09-28 ⑧ 改名。）
8. **payload 上限不另设旋钮**：HTTP 侧就是 `maxBodyBytes` 那道闸（413 同口径）；程序侧
   （`signalTask`）的调用方是同进程代码（与 submit 的 messages 同档信任），不设第二道。
   因此 `core/limits.ts` 不新增条目（无新「0 语义」旋钮）。

**同日复审补记（重复注入缝）**：父 agent 复审时用探针实证了一处真缺陷 —— 续跑段
**注入事件后**、正常循环里再次挂起（新一轮 approval/defer）时，`suspendedMessages`
已含注入的事件消息，而 `pendingEvents` 按「再挂起就保留」留在 record 上 ⇒ 下次续跑
**同一事件再注入一次**（模型看到两条）。修法：引擎出口如实报告「我注入了没有」——
`AgentLoopResult` / `AgentRunResult` 新增 `eventsDelivered` 位（结果/状态记录类，
字段在场）；runner 清簿记的判据从「是不是挂起出口」改成「注入过没有」（挂起分支：
`eventsDelivered` 真 ⇒ 清，假 ⇒ 留）。回归用例（runner 级全链：注入 → 再挂起 →
到点唤醒 ⇒ 模型看到恰好一条）+ 变异复验（挂起分支不清 ⇒ 该用例红）。
`loop-result.ts` 的形状不变量测试随之 9 → 10 字段，api.html 的 AgentRunResult 行同步。

**同日复审第三轮补记（事件缓冲的上限：定案 B）**：第二轮把「`pendingEvents` 无界」记进 §11
（同一条记录上的 `deliveredEventIds` 有界 256，缓冲这侧没有 —— 而它不需要攻击者就能长：
投方每次投一条、run 每次在恢复段再次挂起，事件刻意不注入 ⇒ 每条都留在记录上）。本轮**定案
并落地选 B**：`#signalInner` 里判据次序 状态 ⇒ 幂等 ⇒ **容量**，到上限（`MAX_PENDING_EVENTS = 64`）
就抛 `TaskEventError(409)`，文案说清「本次事件**没有**被记录」（与「重复投递」那种
「已经在里面了」的 409 明确区分）。**不选 A（丢最旧）**：丢缓冲必须同时把该 id 从
`deliveredEventIds` 摘掉，否则发件方重投会拿到「已投递」的 409 而事件其实已经没了 ——
静默丢事件，正是本仓一贯要避免的那种谎。上限 64 的判据写在常量注释里（一个挂起窗口的
突发量级，与 deliveredEventIds 的重试窗口同类；数量有界不是用户旋钮，不进 limits 表）。
用例 `tests/transport/event-buffer-cap.test.ts`（4 条：边界 63→64、满了不动记录、
判据次序、HTTP 409 语义），变异验证见 PR。

### 2026-09-28 ⑦：**外部深评的两条 P1 收口**（派发口收成唯一入口 + `approve` 入参校验）

来源：外部深评（另一 agent 独立复核 `main@25c1983` + 本批分支，报告文件由它产出、**未随本仓
提交**）。两条我都用**探针复核过**（不是照单全收），修法上各有一处取舍：

1. **P1-1 / P2-1：停机窗口的派发散在七处 ⇒ 收成唯一入口**。事实核验：`#wakeDueInner` /
   `#approveInner` / `#signalInner` 有闸，而 `#expireAndResumeInner`（审批超时兜底，由 `poll()` →
   `#lazyGates()` 驱动 —— 而「停机中照常可轮询」是 HTTP 宿主的明确承诺）与 `#redispatch` 的认领
   循环**没有** ⇒ 两处都能在 `drain()` 返回 `true` 之后起新 run。我复现的读数与报告一致
   （`drain()`→`true` 之后 `app.run` 计数 1）。修法是结构级的：`#dispatch(rec)` 唯一入口、闸只在那里
   判一次，各支只管「先落库再派发」的顺序；`submit` **也**走它（它的早返回负责抛错/503 语义）。
   ⚠️ **订正（2026-09-28 ⑨）**：这里原写「窄窗口里宁可把任务留给下次启动认领」—— 那个窄窗口
   **不存在**：`submit` 是**全同步**的（开头那道 `isDraining` 检查与 `#dispatch` 之间没有 await，
   异步 store 的 `save` 也不 await）⇒ JS 不可能在中间插入 drain 的置位。走 `#dispatch` 是
   **结构一致性**（派发口不设例外），不是行为依赖。真会撞上这道闸的是 approve / signalTask /
   到期唤醒 / 审批超时兜底 / 认领循环那五条（它们中间隔着 store 往返）。
   配**源码级穷尽守卫**（`this.#execute(` 与 `this.#executeInner(` 各只许出现在自己的那一个家里
   + 真空护栏；⑨ 起补上第二个 —— 绕过它还会连带绕过 `active++` 与 `#streams.open`）。
   ⚠️ 洞见如实记：这不是「漏写一行」，是**枚举靠人记** —— 所以修法必须把清单变成可执行的
   （守卫用例），否则同一类失效模式会在下一次新增恢复路径时重演。
2. **P1-2：`approve` 不校验 `pendingApprovals`**。事实核验：任意 id 都写进 `rec.approvals`，
   `approvalsComplete` 只判「待决的都齐了」、对多出来的键沉默；那些键随每次 `save` 全文重写、
   且**终态也不清**。实证：一次 5000 个无关键 ⇒ 记录 246 字节 → 419 220 字节。修法两件里
   **只采纳一件**：**入参校验**（多出任何一个 ⇒ `TaskApproveError(400)` + 整批拒 + 记录一字不动，
   与 `parseEventBody`「多一个字段即拒」同纪律）；报告建议的**常量上限刻意不加** —— 单次
   approve 能新写的键被钉死在当前 `pendingApprovals`（挂起那一刻固定）里；跨多轮挂起
   `approvals` 累计的是**历次**待决的并集（审计保留），但每轮都对应真跑出来的模型回合 ——
   调用方单次输入无法放大体积，加上限会是一段永远触发不到的死代码（不是护栏，是噪音）。
   理由写在这里与代码注释里。
3. **同报告其余条目的处置**：P2-2（缓冲满的 409 对「等审批」是死路）⇒ 已改文案，按
   `suspendedReason` 分两种说法；P3-1 / P3-2 当时先收进 §11 开放项 ⇒ **同日 ⑧ 已落地**。

### 2026-09-28 ⑧：**外部深评两条 P3 收口 + ⑦ 的两处措辞订正**（父 agent 复审 f0c1eec 后补）

1. **P3-1：截断在增量出口不再是静默的洞**。`tracer` 的事件闸原先只累计数、不派出 ——
   纯 `onTraceEvent` 消费者看不见任何缺口（旧注释「增量消费者靠 droppedEvents > 0 自己判」
   是假话：增量帧里根本没有这个字段）。修法：`event()` 的闸在**第一笔丢弃**时 `emit` 一条
   一次性 marker（`span.event` / `trace.truncated` / `{ limit }`，不占 trace 本体的事件数）——
   「从哪条 seq 起缺」由 marker 自身的位置给出，最终计数仍在收尾 snapshot 的 run 根
   （派生结论不进增量流）。只派一次：逐笔派等于用事件洪水汇报「事件太多」。
   变异复验：摘掉 emit ⇒ `trace-limits.test.ts` 的 marker 用例具名复红。
2. **P3-2：`task.event.delivered` → `injected`**。原词超前于事实（记在「推进内存数组」那一刻，
   而该段可能在首个模型请求前中止 ⇒ 事件不进持久化历史、trace 却写着 delivered）。
   改名后的口径是「注入进本段消息流」—— 注入动作本身，不承诺模型已看到。
   影响面：loop.ts 注入点、types.ts 注释、usage-guide §6.6、本文件 ⑥ 第 7 条、plans 设计稿。
   变异复验：改回 delivered ⇒ `task-events-input.test.ts` 两条留痕用例复红。
3. **⑦ 的两处措辞订正**（复审 f0c1eec 抓到，都是「注释/文案说了假话」类）：
   - 「`|approvals| ≤ |pendingApprovals|`」不成立 —— 跨多轮挂起 `approvals` 累计历次待决的
     并集（审计保留），会大于**当前**待决列表。有界的真论证是「单次输入无法放大、增长只能
     随真实挂起轮次发生」。代码注释 / usage-guide §7 / §10 ⑦ 第 2 条三处同步订正。
   - 缓冲满 409 文案的 timer 分支写了「（或先 approve）」—— 但 approve 对 timer 挂起
     就是 409（原因闸），指了一条不存在的路。改为「到点自己醒来；等不了就 cancel 后重新提交」。

### 2026-09-28 ⑨：**PR #164 的复核收口**（折叠不变量 / 守卫盲区 / 停机拒绝出声 / 三处文案）

来源：PR #164 合入 main 之后（squash 合入提交 `a0b5380`）的独立复核（报告
`PR-164-REVIEW-2026-09-28.md`，**未随本仓提交**）。四件，按「会不会真咬人」排序；
每条都有读数或可复现的用例：

1. **折叠不变量在截断下是假的 ⇒ 截断簿记改成「两缝同源」**（P1，而且是个**先前就有**的洞）。
   `core/trace.ts` 那条折叠规则（按 `seq` 折回**逐字等于** `snapshot()`）在「设了 `maxEvents`
   且真截断」时**一直**不成立：收尾摘要**不**经 `emit()` 派出，⑧ 的起点标记也只派进增量流、
   不进 `span.events` ⇒ 两个视图各缺一笔、谁也不等于谁。此前没人发现，是因为**默认不设上限**
   —— 折叠用例永远碰不到截断路径。修法：起点标记**记进 run 根 span 的事件**（两处同一份载荷），
   收尾摘要**也在交付那一刻派一次**（`truncationSummary` 缓存保证只生成、只派一次 ——
   2026-10-13 ⑧ 起它还是「多次 snapshot 逐字一致」的单源）。
   ⇒ 折叠规则**无例外地**成立；`trace-events.test.ts` 补了一条「设上限 + 真截断」的折叠用例
   （这一条必须显式跑截断，默认路径必然绿）。折叠侧的帧类型分派同时改成**编译期穷尽**
   （`const _never: never = e`）—— 此前最后那支是无条件 `else`（默认按 link 处理），
   不认识的新帧会被当成 `undefined` link 塞进树里，而断言在某些 run 形状下照样绿。
   ⚠️ 取舍如实记：起点标记因此**会进交付的 trace**（截断时事件数上限是 `maxEvents + 2`）。
   这是有意的 —— 让制品自己标出「从这里断的」，比只在增量流里说一遍更有用。
2. **守卫盲区 `#executeInner`**（P2）。源码守卫只钉了 `this.#execute(`，而 `#executeInner` 是同一个
   旁路的另一半：新加一条恢复路径时若直接调它，会**同时**绕过停机闸与 `active++` / `#streams.open`
   （后果：`drain()` 会在一条 run 真在跑的时候返回 `true`）。守卫补上对应断言。
3. **停机窗口的拒绝要出声 + 写下宿主的义务**（P2）。`#dispatch` 的拒绝此前是一条裸 `return`。
   探针（`drain()` 返回 `false` 且宿主没有退出）：记录停在 `running`、`resumePending` 按
   `own-process` 跳过（认领数 0）、`submit` 已整体关闭 ⇒ 本进程内**没有自愈路径**，
   `awaitTask` 永不返回。修法：首次拒绝打一条 `[agentia] 停机中：…` 的 `console.warn`
   （只一条，用例在 `drain-race.test.ts`），并把「`drain()` 是**单向闩** ⇒ 返回之后宿主必须退出」
   写进 `drain()` 的契约、`drain-gate.ts` ② 与 usage-guide §7（新增一行「`drain()` 之后有些
   任务停在 `running` 不动」）。⚠️ 顺带订正 `drain-gate.ts` ② 那句「超时返回 false 但**不改任何
   共享状态**」—— `draining` 恰恰是保持置位的，那句话会被读成相反的意思。
4. **三处文案说了假话**（P3）：`submit` 的「窄窗口」不存在（见 ⑦ 的订正）；`sse-frames.test.ts`
   把 `trace.truncated` 说成「run 根的 **attribute**」（它是**事件**，且会作为 `trace.event`
   帧体流经 SSE）；`api.html` 的 `createHttpHandler` 行漏了 ⑦ 新增的语义级 400。

### 2026-09-28 ⑩：**结构收口四件**（`http.ts` 拆分第三步 / `mcp-server.ts` / `#executeInner` 的归属 / 文件级无环守卫）

来源：`SRC-STRUCTURE-2026-09-28.md`（**未随本仓提交**，与两份复核报告同惯例）的「落地顺序 1–4」。
那份盘点的诊断维度不是「文件几行」，而是**最大单函数 ÷ 文件总行数**：它把「超大函数」病
（比例高 ⇒ 拆这个函数）与「大类」病（比例低但可调用体几十个 ⇒ 抽协作者，别切方法）分开 ——
`http.ts` / `mcp-server.ts` 是前者，`async.ts` 是后者的典型。逐条：

1. **HTTP 宿主拆成三件 —— `http.ts` 拆分第三步**（实测量：最大单函数 489 → 123 行，
   文件 840 → 306 行）。
   这是既定系列的第三步（#99 外移形状口径、#100 外移路由判定，两次提交信息都以「拆分第一步 /
   第二步」自名）。**前两步为什么没止住增长**：它们移走的都是**纯件**（纯形状判定 / 纯路由判定），
   而占大头的那一半 —— 九条路由的**体**（读 body → 调 runner → 写响应 → 选状态码）——
   不纯、住在 `createHttpHandler` 的闭包里，原地不动；于是 `http.ts` 从 533 行又长回 840。
   第三步把它搬走，落成三条边界：`http-endpoints.ts` = 走到一条路上做什么（派发表 +
   九条 `handleXxx`）；`http-io.ts` = 怎么收发（零内部依赖的叶子）；`http.ts` = 宿主契约 +
   宿主状态 + 准入/停机。
   - **搬出闭包就得把上下文显式化**：三个散着的 `let`（在飞 run 计数 / 停机态 / SSE 收口表）
     收成 `HttpState` 一个对象、按引用交给每个请求的 `HttpCtx`。「健康检查与停机判断看的是
     同一个数」这条承诺（`HealthResponse.inFlight` 与 `drain()` 同口径）此前靠「都在同一个闭包里」
     维持 —— 现在靠**同一个对象**，是个更强也更可读的保证。
   - **顺带简化了一处安全相关的编排**：鉴权闸从「`if (isPreAuthRoute(route)) { 一大段应答 }`
     提前 return，再走 switch」改成**否定条件** `if (!isPreAuthRoute(route) && authenticate)`。
     豁免名单的真源仍只有 `http-route.ts` 一处，但 `handler` 里现在只剩「谁被豁免」可读，
     被豁免者**回什么**全在端点表里。行为逐字不变（HTTP 套件 146/146 未改一字）。
   - **穷尽性断言随之增强**：免鉴权组现在也走同一张派发表，于是末尾的
     `const residual: 'healthz' | 'metrics' | 'notFound' = route.kind` 可以换成更强的
     `const _never: never = route`（12 个 kind 全被 case 覆盖 ⇒ 收窄为 never）。
     这条形态变了，`docs/guards.md` 的旧证据（按旧形态反向验证的）**已作废重做**。
   - **留下的守卫**：`tests/transport/http-boundary-guard.test.ts`（源码级，四条断言 +
     两层防真空变绿，反向验证过三条）。它防的是**下一次**：新加端点时的默认姿势又变回
     「往 `http.ts` 里再塞一段」—— 那不是靠 AGENTS.md 的散文能拦住的。
   - ⚠️ 一条守卫是**被这次搬迁咬出来的**：`tests/docs/sse-frames.test.ts` 原先写死扫
     `src/transport/http.ts` 的 `sse.event('…')`，帧一搬家就红（帧一条没少）。它盯的是
     **实现排布**而不是**契约**（契约是「这些帧真的存在」）⇒ 改成扫整个 `src/transport/` 目录。
     断言方向是「文档提到的 ⊆ 实现 emit 的」，扫宽只会更宽松地通过，不会假绿。
     教训与 §10 ⑦ 那次同类：**守卫盯着会变的东西，就会在每次无辜的重构上误红**，
     而误红的结局通常是人去放宽它。
2. **MCP 反向桥拆成三件 —— `createMcpServer` 441 → 47 行**（文件 564 → 409 行；
   + `mcp-server-stdio.ts` 72 行 + `mcp-server-http.ts` 199 行）。
   先例是**正向桥按传输分文件**（`integrations/mcp.ts` + `mcp-stdio.ts` + `mcp-http.ts`）——
   反向桥此前把协议（`rpcError`/`rpcResult`/`dispatch`）、执行（`callTool`）、两条传输全塞进
   441 行的 `createMcpServer` 闭包。拆后本文件留**协议 + 执行 + 装配**（都是顶层函数，闭包里的
   无名块各得一名），两条传输各居其文件、各自是「一个宿主的生命周期」的一种。
   - **关键设计是「注入式单向」而不是「照抄正向桥」**：协议与执行经 `McpCore`
     （`dispatch`/`rpcError`/`trackCall`/`untrackCall`/`abortAll`）**注入**给传输，传输只从
     `mcp-server.ts` 取**类型**。正向桥那条 `mcp.ts ↔ mcp-stdio.ts` 是**真实的值环**
     （桥 re-export 连接器、连接器反向 import 桥的共享 helper），靠 ESM 函数提升与调用时机
     **侥幸**无恙；反向桥的无环是**构造性**的 —— 这恰是第 4 件（文件级无环守卫）想固化的事。
   - **「它为什么留在 engine」复核结论：仍然成立**，且这次以**真实 import 面**为据：
     本文件需要 engine 侧 4 个值（`TraceRecorder` / `classifyError` / `buildToolRunContext` /
     `tool-events` 载荷）+ integrations 侧 2 个值（`DEFAULT_PROTOCOL_VERSION` /
     `createAnthropicClient`）；而 `integrations` 只许依赖 `core`、`transport` 够不到
     `integrations` ⇒ **engine 是唯一能同时够到两边的层**。搬进 `integrations` 需要一条
     `integrations → engine`（越权），并与既有 `engine → integrations` 成环。
   - ⚠️ **顺带订正 AGENTS.md 一条失真文案**：原文说 `engine → integrations` 这条边「仅为取
     默认 ModelClient」，实测用途至少两处（`loop.ts` 取 client + `mcp-server.ts` 取
     `DEFAULT_PROTOCOL_VERSION`）。已在 `mcp-server.ts` 头注按实况改写。
   - **不再往下拆传输**（这是个**反例**，写出来防止「见大就拆」）：`startHttpTransport`
     172 行、`startStdioTransport` 57 行 —— 按判据属「一个宿主的完整生命周期」，
     **该是一个协作者**；且比正向桥的同位函数**更瘦**（`createStreamableHttpMcpConnector`
     265 行 / `createStdioMcpConnector` 235 行）。再拆只是把生命周期切碎，不产生新边界。
3. **`#executeInner`（247 行）的编排归属：定案「不拆」**（本条**零代码改动** —— 产出是一份有依据的
   裁定，因为「动之前先定归属」的答案就是「不该动」）。
   - **它是什么**：`AsyncRunner` 的**状态机主体**。四层 `try` 是一条**资源获取 + 清理阶梯**，
     每层绑定一份清理责任、且**顺序 load-bearing**：① 顶层（1367）兜「异步 store 任何 reject 都
     不逃逸成 unhandled rejection」→ failed + save；② `#slots.acquire()` 之后那条（1389）的
     finally → `finishedAt` + `safeSave` + `slots.release`；③ run 那一层（1424/1496）的
     catch/finally → 取消意图裁定 + `releaseCombinedSignal` + `#runAborts.delete`。
     **槽位必须在最内层 finally 释放**，否则落库抛错会永久泄漏并发槽位 —— 这条事实的可读性
     **来自嵌套顺序本身**。
   - **为什么这不是「超大函数」病**：`async.ts` 最大可调用体 247 ÷ 总行 1690 = **14.6%**，
     远低于 55% 阈值 ⇒ 按判据这是「**大类**」病（可调用体 **40** 个），处理方式是
     **抽协作者，别切方法**。而纯协作者**已经抽过六轮**：`slot-pool` / `approval-policy` /
     `drain-gate` / `resume-policy` / `task-waiters` / `task-events`。
   - **为什么编排搬不走**：`#executeInner` 触及 **14 个 runner 内部成员**（`store` / `app` /
     `client` / `sessionStore` + `#slots` / `#runAborts` / `#cancels` / `#streams` /
     `sessionInputs` + `#safeSave` / `#raceTimeout` / `#markSuspended` / `#unmarkSuspended` /
     `#appendResumedSession`）—— 把编排外移等于把 `AsyncRunner` 重建一遍。
   - **归属其实早已被钉死**：`tests/transport/dispatch-guard.test.ts` 就是那份判定的**可执行版本**
     —— `this.#execute(` 只许出现在唯一派发口 `#dispatch`（且停机闸在它之前）、
     `this.#executeInner(` 只许出现在 `#execute`（且 `active++` 在它之前）。即三分：
     **`#dispatch` = 派发口 / `#execute` = 计数与开流包裹层 / `#executeInner` = 状态机主体**。
     把主体的一部分搬出类，会**同时**让这条守卫失去前提。
   - **考虑过但否掉的一处外移**：`callOpts` 装配（约 42 行，确是纯函数面：六个只读入参 → 一个
     选项对象）。     否掉的理由是**单调用者**、且外移后**不产生可守卫的边界**（对比 `http-route.ts`
     外移后立刻配了「免鉴权 405 顺序」的守卫）。留着它 `#executeInner` 仍是 247 行 ——
     但那是「长度」，不是判据里的「病」。
4. **文件级无环守卫 —— 关掉层内环盲区**（`tests/architecture/file-cycles.test.ts`）。
   - **盲区是什么**：`layering.test.ts` 的 `layerOf()` 取**路径第一段**，是**层**粒度 ⇒
     **同一层里两个文件互相 import，它一条边都看不见**。实测 src 有**三条**文件级强连通分量
     （SCC），**全部在层内**，此前**没有任何守卫看得到**。
   - **先复核三条环的真实性质**（这一步推翻了盘点报告初稿的结论）：初稿写「两个环的回边都是
     `import type`」—— **错的**。逐条打开看导入语句：`integrations/mcp.ts:350/352` 是
     `export { … } from './mcp-stdio.js'`（**re-export 值**），而 `mcp-stdio.ts` 又
     **值导入**桥的 7 个 helper ⇒ 这是一条**真实的值环**（运行期环，靠 ESM 函数提升与调用
     时机**侥幸**无恙）。另两条（`runtime/context ↔ run`、`engine/mcp-server ↔
     mcp-server-{stdio,http}`）的回边才真的是 `import type`。**初稿错在没打开文件看**。
   - **真值环要断**：把桥与两个连接器**共用**的协议面（7 个 helper + 4 个结构类型）抽到
     `src/integrations/mcp-protocol.ts`，依赖成一条**单向 DAG**（桥 → 协议 ← 两个连接器；
     桥 → 连接器**仅 re-export**）。公共面不变（`src/index.ts` 未改一字；`mcp.ts` 继续
     转出这些符号）。顺带修正一处**测试夹具的注释**（`tests/engine/mcp-server.test.ts` 里
     「摘掉 `mcp-server.ts` 里那两行」随第 2 件已失真）。
   - **守卫口径是「只算值边」**：类型导入运行期擦除，**不构成运行期环** —— 别把「编译期有一条
     `import type` 回边」写成「循环依赖」（`docs/guards.md` 同款纪律）。于是两条 type-only 环
     **留着不算环**，只有真值环红。它同时兜住两件事：新增一条运行期环 ⇒ 红；把某条 `import type`
     回边**改成值导入**（真值环就此产生）⇒ 红。
   - **两条变异反向验证**：① 往 `mcp-protocol.ts` 注入一条值导入 ⇒ 红（报出 `mcp-protocol ↔
     mcp-stdio`）；② 把 `runtime/context.ts` 真实的 `import type { Run }` 改成值导入 ⇒ 红
     （报出 `context ↔ run`）—— 后者证明它读的是**真图**，不是「图是空的」侥幸全绿。
   - **顺带咬出一个解析器陷阱**：头注里写出导入字面量会被**裸正则**读成一条**假边** ——
     `mcp-protocol.ts` 初稿头注里那行 `export { … } from './mcp-stdio.js'` 就把刚断开的环
     「测」了回来（`import-graph.py` 与 `layering.test.ts` 的 `relativeImports` 都按
     `from '…'` 抓、**不剥注释**）。⇒ 本守卫**复用** `lib/source-scan.ts` 的 `scan()`（逐字
     遮蔽注释 / 字符串 / 模板 / 正则，且由 `no-runtime-deps` 守卫单独验证过），并加一条
     「注释里的导入字面量不算边」的自证用例钉死它。
   - **附带发现（未修，如实登记）**：同一个陷阱对 `layering.test.ts` 的 `relativeImports`
     也成立 —— 它只按 `from '…'` 抓。今天无害（造成假边的注释落在**同层**，而它只记跨层边），
     但一条**跨层**的导入字面量写进注释就会造成「越权」误红。修法是把该守卫也切到 `scan()`；
     因其反向验证证据是逐条按旧实现钉的，**留作后续单独一轮**，不并入本批。
5. **补「口径单测」（本轮的尾巴，纯测试、零语义变化）**：第 1、2 件各抽出几个**共用面**
   helper（`http-io.ts` / `mcp-protocol.ts`），当时没配同名单测 —— 行覆盖靠既有套件就够
   （两文件都是 100% 行），但**口径**（返回什么、抛什么、文案长什么样）从没被正面钉过。
   按先例（`http-shapes.test.ts` / `http-route.test.ts`：抽出的**纯决策/形状模块**配同名单测，
   每个 `describe` 枚举一条规则）补两份、共 35 条：
   - `tests/integrations/mcp-protocol.test.ts` —— `unwrap` 的「**键存在 ≠ 值非空**」
     （`{result: undefined}` 也算「有」；改成 `msg.result !== undefined` 会把「server 明确回了
     `undefined`」误判成 malformed）；`withDeadline` 抛的必须是**类型化** `TimeoutError`
     （抛普通 `Error` ⇒ 引擎记 `threw`/`unknown`，同一个事件两种账 —— 正是 §10 2026-09-17 ①
     单源化要消掉的那件事）；`brief` 对**循环引用**与 **`undefined`** 的退化
     （`JSON.stringify(undefined)` 返回的是 `undefined` 而非字符串 ⇒ 落到 `String(value)`）；
     `DEFAULT_CLIENT_INFO.version === '0.0.0'` 是**刻意的**（写成真版本会让
     `scripts/release-surface.mjs` 的计数断言失配）。
   - `tests/transport/http-io.test.ts` —— `parseJsonBody` 的**空 body 不算解析失败**
     （回 `undefined` 而不是 400）；`sendJson` 的 `content-length` 按**字节**
     （`.length` 遇中文会写小 ⇒ 客户端按它截断）；`readBody` settle 后**监听必须摘干净**
     （残留 = 每个半截请求漏一个 handler）；`sendInternalError(exposeErrors=false)`
     不得把内部拓扑写进响应体。
   - **「刻意不补」与「补」同等重要**：`readBody` 的 `if (done) return` 是**不可观测**的
     （Promise 二次 `resolve` 是 no-op，少这一行行为完全一样）—— 为它写断言就是
     `scripts/test-all.mjs` 注释里点名的**真空变绿**。同理 `taskStream` 的 `unsubscribe`
     缺省支、穷尽性 `default`、`taskStream` 的 `TaskStreamError` catch 一律不凑数。
   - ⚠️ **一个会误导人的覆盖率读数**：`src/engine/mcp-server-stdio.ts` 报 **22.22% 行覆盖**，
     看着像缺口，其实是**采集假象** —— 它的用例走**真子进程**（夹具在子进程里
     `createMcpServer({ transport: 'stdio' })`），c8 只采父进程。实测：单跑该测试文件仍是 22%，
     而用例 **22/22 全过**。该数字**拆分前就存在**（同一段代码内联在 `mcp-server.ts` 里）——
     别照着它去补测试。
6. **未覆盖功能分支的定向补测（同轮尾巴，纯测试、零语义变化）**。做了一轮**覆盖率复查**，
   纠正了读法，再按「可达 / 不可达」分流补测：
   - **先纠正口径**：c8（v8-to-istanbul）的 branch **不是 if/else 两条臂** —— 全仓 4244 条
     条目**全是 1 个 location**，`b[id]` 是「该块被进入的次数」，`0` = 这条路径**从未走到**。
     它比语句覆盖**更细**：抓得到 `if (done) return;` 这种「语句被算作覆盖、但那一步没走过」的守卫。
   - **基线**：语句 295 未覆盖 / 函数 11 未调用 / 块 347 未走到（用例 1465）。
   - **补掉的 7 条**（都是**正常输入下可达**、此前一次没走过的**功能**分支；跨 3 个文件 +8 条用例）：
     `toolkit/subagent.ts:92` —— `spec.system` 的**函数形态**（三态联合里唯一「框架不追加
     REPORT_HINT、作者全权」的一态，`(task) => SystemParam` 此前一次没走过）；
     `engine/trace-diff.ts:81 / 187 / 189`，并一并带出 **`:205`** —— `errorEqual` 的三元组比较
     此前所有用例两侧都没有 error，那句 `x.type === y.type && …` **从未执行过**；现在同时钉住
     「两侧 error 内容逐字相同 ⇒ 不算差异」（即**比内容不比对象引用**）；
     `transport/async.ts:498 / 504` —— 事件缓冲**溢出**时重放之前先发 `truncated` 帧；
     以及**任务已终态之后**才连上来时「重放缓冲 + 立刻补 `end` 收口」；
     `transport/http-endpoints.ts:560` —— SSE 的 `stream.truncated` 帧。
   - **订正我上一轮的错报**：`http-endpoints.ts:563` 的 `unavailable` **本来就是覆盖的**
     （`taskStream.test.ts` 的跨进程用例）。把它和 `560` 并列说成「两条都没覆盖」是错的。
   - **两条「看着像缺口、核实后不该补」**（如实登记，且它们与「补掉的」同等重要）：
     `TaskEventStreams.forget`（`task-events.ts:214`）**未从 `src/index.ts` 导出**、全仓无人
     调用（`#evictTerminal` 是自己 `streams.delete`）⇒ 它是**内部死方法**，为它写测试等于
     **锁死死代码**；`AsyncRunner.byIdempotency`（`async.ts:537`）是零文档的**纯透传**一行，
     而 store 级行为已由四套存储测试覆盖 ⇒ 断言接近**恒真**。另 8 个「从未被调用的函数」
     全是**只读访问器**（`currentSpan` / `runId` / `windowsSamples` / `toMeta` /
     `context.delete·keys` / `store.clear` / `container.registered`），无一含分支 —— 同样不凑数。
   - **结果**：语句 295 → **287**、块 347 → **338**（分支 91.82% → **92.04%**）、
     用例 1465 → **1473**；函数那一档**刻意不动**（98.28%）。
   - **7/7 变异反向验证**：逐条改坏实现（短路函数形态 / 把 status 差改名 / 把 `errorEqual`
     改成比引用 / 不发 truncated 帧 / 给 truncated 帧改名 / 不补 end 帧），每条**恰好红在对的
     那条用例**上，且还原后源文件逐字节一致。
   - ⚠️ **本轮踩到并记下的读数陷阱**：c8 `--reporter json` 落的
     `coverage/coverage-final.json` **会被定向跑（`--include` 少数文件）覆盖** —— 拿它当全量
     数据会读出「语句 71.13%」这种**完全失真**的数（实测踩到）。核对前先删该文件、重跑全量。
   - **变异反向验证 17/17**：逐条改坏实现（`content-length` 换 `.length` / 空 body 直接
     `JSON.parse` / 摘掉 `cleanup()` / `unwrap` 改值判定 / `withDeadline` 抛普通 `Error` /
     `exposeErrors=false` 泄漏 ……），每条**恰好红在对的那条用例**上，且还原后源文件逐字节一致。

### 2026-09-28 ⑪：**定时器上限单源 + 两处如实收口**（五处直喂 `setTimeout` 的站点补上界 / `cancel` 409 文案分两支）

来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md`（**未随本仓提交**，与三份复核报告同惯例）经**两轮外部复核**
并入后的 P1 收窄结果。完整审计与「逐条复核」两端都在那两份未跟踪文档里，这里只记定案。

1. **Node 定时器延迟的物理上限必须是单源**（`2^31-1`ms ≈ 24.86 天）。超上限的延迟**不会「等那么久」**：
   Node 只在 stderr 留一行 `TimeoutOverflowWarning`，随后把延迟**钳到 1ms** —— 实测（Node 22）：
   `delay = 2^31` 在 200ms 内就触发、`delay = 2^31-1`（边界内）如期不触发。于是「配 30 天超时」
   变成「每个调用立即超时」、「退避到限流窗口之后」变成「热重试打风暴」。
   - **本仓此前只防了「旋钮」**：`transport/scheduler.ts` 的 every/at 各有闸（2026-09-19 复审加的），
     而**派生出来的等待**没有 —— 五处直喂 `setTimeout` 的站点（`withTimeout` / `interruptibleSleep` /
     `#raceTimeout` 的 `runTimeoutMs` / `composeSignal` 的 client `timeout` / `DrainGate.waitForIdle`）
     一律只查「非负 / 有限」。这正是要消灭的形状：**配置完全合法、行为完全相反，且没人会看那行警告**。
   - `MAX_TIMER_DELAY_MS` 上提到 `core/timeout.ts`（`scheduler.ts` 改为 import，不再自备一份），
     配两个函数，**分工刻意分开、别合并**：`assertTimerDelay`（**拒** —— 旋钮的坏值必须响亮，
     否则修法会被写成「补一个静默语义」）；`clampTimerDelay`（**夹** —— 外部数据：
     `Retry-After: 99999999` 不是使用者的错，为它把一次 429 升级成硬失败是错的，放它直通才是真危害）。
   - **`NaN` 要单独判、且必须排在调用点的「非正」早返回之前**：`withTimeout` 的判据是 `!(x > 0)`
     ⇒ `NaN` 满足它、被静默读成「不设超时」（与「我设了个预算」正好相反，且桥会因此起自己的 60s
     兜底 ⇒ 双计时器、双账本）；`interruptibleSleep` 的判据是 `ms <= 0` ⇒ `NaN` **不**满足它、
     穿透直落 `setTimeout(NaN)`（同样被钳到 1ms）。**同一个坏值在两个原语里的落点相反** ——
     这就是它必须统一在入口挡掉的理由。
2. **`cancel` 的 409 文案分两支**（同一条判据下的两种情形，原文案一律说「不在本进程」）：
   四条恢复路径（approve / 到期唤醒 / 事件投递 / 崩溃重投）都**先**把状态置 `running`、再 `#dispatch`，
   而 `#runAborts` 要到 `#slots.acquire()` 之后才登记 ⇒ 中间整个窗口里任务「状态是 running、
   句柄还没有，但**明明在本进程**」。新增 `AsyncRunner.#executions`（**纯诊断**集合，`#execute` 的
   存活区间）与 `#runAborts` 取差集，据此换文案。
   - ⚠️ **闸不放开**（这一步只改文案 + 给可区分信号）：放开会让等槽位那趟 `#execute` 的 finally
     双发 `onFinished` —— 正是 §10 的变异 **M23**（`#cancelSettled` 只按 `wasQueued` 记账）。
3. **措辞订正：「静默」不准**。此前写「超上限会被**静默**钳到 1ms」—— 不是静默，Node 会打
   `TimeoutOverflowWarning`，准确说法是**警告落在没人看的 stderr**。已改 `scheduler.ts` 三处注释、
   `core/limits.ts` 两处 note、`anthropic.ts` 一处头注、`usage-guide.md` 一句、`scheduler.test.ts`
   一条用例名。**`CHANGELOG.md` 与本文的历史条目不动**（追加式日志）。
   顺带修掉一条**不实注释**：`scheduler.ts` 原先写着「`runTimeoutMs` 在 async.ts 有同款防线」，
   而当时那边只查「非负有限」—— 现在那句承诺才真的成立。
4. **`limits` 表同步**：`withTimeout.ms` / `interruptibleSleep.ms` 的 `badValue` 由 `none` 改 `throws`
   （`RunAgentOptions.toolTimeoutMs` 这条链上的 `NaN` 从此不再是「静默不设超时」），
   `AsyncRunner.runTimeoutMs` / `createAnthropicClient.timeout` / `AsyncRunner.drain.timeoutMs` /
   `Scheduler.every.intervalMs` 的 note 补上界。**没有新增旋钮**（`MAX_TIMER_DELAY_MS` 是常量而非旋钮）
   ⇒ `tests/limits.test.ts` 的 `PROBES` 穷尽表不动。
5. **反向验证 11/11**：逐条改坏实现（上界判断失效 / `NaN` 判断失效 / 五处站点各摘掉校验 /
   `#executions` 不登记 / 判据恒真 / 判据恒假），每条**恰好红在对的那条用例**上，还原后 4 个源文件
   逐字节一致。基线**跑 3 遍**才继续 —— 这条纪律抓到了一条我自己写的 `<= 8000` 断言
   （`backoffMs` 的 ±25% 抖动可以让结果到 10000，会把「底数封顶」误读成「结果上界」）。
6. **刻意不做**（理由与做的理由同等重要）：
   - 不给 `engine/retry.ts` 的 `RetryOptions.maxDelayMs` 加构造期上界 —— 超出本次范围；若它产出
     超限值，`interruptibleSleep` 会**响亮抛错**（而不是静默热重试），已够。
   - 不在 `RunAgentOptions` 层另加一遍 `toolTimeoutMs` 校验 —— `withTimeout` 是构造性覆盖点，
     再加一层就是两处写同一件事。
   - 不动 `backoffDelay` 的抖动公式（那是策略，不是坏值）。

### 2026-09-28 ⑫：**外部深评剩余五条 P1 收口**（上下文策略降级 / 滞回归位 / MCP-HTTP 兜底 / `drain` 的收口顺序 / 能力成环 / 续跑租约）

来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md`（**未随本仓提交**）。那份确认清单的 §0 写着：收口后的 P1
收敛为 `C1`（定时器上界，见 ⑪）与 `T1`（`cancel` 409 文案，见 ⑪）两条，**其余五条本轮复核方未覆盖、
原判保留**。本条目收的是那五条（编号沿用审计文档：`E1` / `E2` / `T2` / `T3` / `J1`，另附同族一条 `E3`）。
每条都**先回源实证再动刀** —— 其中 `T2` 的初版诊断**被自己的探针否掉一半**（第 6 条），
这正是「先实证」要防的形状。

1. **`beforeTurn` 抛错 = 降级，不是判死**（`E1`，`engine/turn.ts`）。`ContextPolicy.beforeTurn` 里
   **可能走网络**：`createBudgetPolicy({ summarize })` 的 `summarize` 是
   `(historyText) => string | Promise<string>`，把模型调用塞进去是**常规**用法（就是「用摘要换预算」），
   于是 429 / 超时是**常态**而不是边角。原文没有任何兜底 ⇒ 一次摘要失败让整条 run 以「请求失败」收尾，
   而上下文压缩对一条 run 是**尽力而为**的优化、不是前置条件（代价只是历史偏长，不该是 run 死掉）。
   - 修法：`try/catch` + **出声**（run 根记 `context.policy_failed { iteration, message }` +
     一条 `console.warn`）。为什么不悄悄吞：与 2026-09-27 ② 「sink 失败不再零信号」同一纪律 ——
     降级是一条**运维事实**，没有信号时它表现为「历史一直是满的、token 一直涨」，没人能归因。
   - 降级**不改变**本回合的消息（`next` 保持 `undefined`），也不写 `context.budget` 事件
     （那条事件的口径是「真换了历史」）。
2. **滞回额度记在「成功压缩」之后**（`E3`，`engine/policy.ts`）。`lastCompactAt` 原先在
   `await compactMessages(...)` **之前**赋值，而 `compactEvery` 的语义是「距上次**成功**压缩至少隔
   几个回合」（`info.iteration - lastCompactAt < compactEvery` 就跳过）。写在调用前 ⇒ **失败也烧额度**
   ⇒ 摘要器抖一下，后面 `compactEvery - 1` 个回合都不再尝试 —— 「这一回合没压成」被放大成
   「这一段时间都不压」。现在失败不记账，下一回合自然重试。
   - ⚠️ **代价如实记**：摘要器**持续**失败时，每回合都会再调一次（每次多一次失败的模型往返）。
     这是刻意的（失败不该被静默记成「压过了」），要抑制请在 `summarize` 里自己退避。
3. **MCP HTTP 传输的意外不再带走宿主**（`E2`，`engine/mcp-server-http.ts`）。请求处理那层 `try`
   此前**只有 `finally`**（`res.off` + `untrackCall`）—— 异常冒泡出 async handler 就是
   unhandled rejection，Node ≥15 默认**终止进程**。而同一份协议面的其他三处都有兜底：同文件的鉴权
   钩子（`:91-97`）、`JSON.parse`（`:121-126`）、stdio 那条传输的 `.catch`。⇒ 形状是
   「**同一份协议面在两条传输上一条活着、一条把宿主带走**」。
   - 真能走到这里的只有「协议面之外的意外」（工具自身抛错由 `callTool` 兜成 `isError`，不冒泡）：
     实测复现的是「工具列表里某条 `inputSchema` 是带 getter 的对象」——`validateJsonSchema`
     一读就抛（`tests/engine/mcp-server.test.ts` 用 `new Proxy` 复刻了这条）。
   - 修法：回 **200 + JSON-RPC `-32603`**（错误码与文案由 `core.rpcError` 注入，传输层不自己拼
     —— 与 stdio 侧同形状）；响应头已发（`headersSent`）时只 `res.end()` 收口。**为什么是 200**：
     JSON-RPC 的错误是**响应体里的错误对象**，回 5xx 等于对外说「这一层坏了」。
4. **`drain()` 不再可能等一个永远不结束的等待**（`T3`，`transport/http.ts` + `http-endpoints.ts`）。
   唯一的顺序陷阱：`waitUntil(() => inFlightRuns === 0, deadline)` 排在 `closeStreams()` **之前**，
   而 `timeoutMs` 缺省 0 = **不限** ⇒ `deadline = Infinity`；能结束一条「自己不结束的 SSE」
   （如一条长跑 run 的 `/run` 流）的机制恰好就是收口 ⇒ **死锁**。
   - 修法不是「一律先收口」（那会毁掉有 deadline 时的优雅停机）：**活连接不享受无限窗口** ——
     没有 deadline 时先收口再等，有 deadline 时保持既有顺序。
   - 返回值同时**如实分两种收口**：`OpenSseHandle.cutsRun` 区分「收口**连带 abort 在飞的 run**」
     （`/run` = 工作被切，回 `true` 是把「切了」说成「等干净了」⇒ 必须 `false`）与
     「只关掉旁观者长连」（`/tasks/<id>/stream` = 不损失任何工作 ⇒ 不参与判定；把它算成没排干净
     是另一种说错话）。这是本仓库一以贯之的「返回值要如实」：`drain()` 的布尔是**宿主的 SIGTERM
     决策依据**。
5. **能力引用成环：装配期即拒**（`J1`，新增 `toolkit/capability-cycles.ts` + `module.ts` 接线）。
   `subagentToTool(capability, resolveTools)` 的第二参是**延迟求值 thunk**，而装配时
   `wrappedByToken` 已把引用全建满 ⇒ 环是**纯运行期**递归，且 `maxIterations` 只限**迭代宽度**
   （一回合内并行的工具调用数），**深度没有任何闸** ⇒ 模型一次自我调用就无限递归，树按
   `宽度^深度` 炸开（花费与 token 同时炸）。
   - 纯件拆成 `buildCapabilityGraph`（把 token 引用扇出到该 provider 的每个能力）+ `findCapabilityCycle`
     （DFS 三色标记，返回**环上的节点序列**、首尾同节点；引线不进环）。节点 id 用 `\u0000` 分隔
     （token 与能力名都是任意字符串）。
   - **刻意不给深度旋钮**：加一个 `maxDepth` 就等于把「装配错误」降级成「运行到那一刻才炸」，
     且用户没有判据去配它。检测到就拒绝，错误信息给出环上的节点序列。
   - 实证不误伤：全仓 grep 确认**没有任何既有用例**写自引用（`tools: ['<自己 token>']`）。
6. **续跑认领：从「新鲜度启发式」升级成「租约」**（`T2`，新增 `transport/owner-id.ts`、
   `transport/owner-liveness.ts`，改 `resume-policy.ts` / `async.ts`）。
   `staleAfterMs` 回答的是「记录起跑多久了」，不是「主人还在不在」，**两个方向都会错**：
   ① 单段 run 跑超窗口 ⇒ 他进程当孤儿抢走 ⇒ **同一任务跑两遍**（真·重复执行、副作用翻倍）；
   ② 崩溃进程留下的记录**仍带 `ownerId`**（`submit` 恒写）⇒ 落在保鲜期内没人捡 ⇒ **饿死**
   —— 而扫描是**惰性**的（框架不养定时器），前任崩溃、继任启动即扫一次，扫完就再没人扫。
   - **初版诊断被自己的探针否掉一半**：我原以为 pid 超过 `kern.maxprocperuid` 时
     `process.kill(pid, 0)` 会抛 `EPERM`（那样就得区分「pid 太大 / 存在但无权」）。实测
     （macOS 24.x / Node 22，本机 `kern.maxprocperuid` = 2784）：pid `2784` / `2785` / `999999` /
     `4194303` / `99999999` **一律 `ESRCH`**；pid `1` 是 `EPERM`；本进程是正常返回。
     ⇒ 判定可做成三态**不需要边角分类**，`ownerAlive()` 因此能被纯化、被穷尽单测。
   - 三态而不是布尔：`true` = 同主机且进程在（**无论记录多老都不许抢**）、`false` = 同主机但进程不在
     （**立刻可抢**，不等保鲜期）、`undefined` = **判不了**（异主机 / 升级前旧格式 / 自定义串）
     ⇒ 退回新鲜度启发式 ≡ 升级前行为。**「判不了」必须与「不在」分开**：异主机搞错方向的代价是
     「每个宿主都去捡同一批任务」。
   - `ownerId` 形状改为 `p<pid>@<host>-<8 位十六进制>`；主机名段用**惰性** `.+?` + 锚定结尾的
     `-([0-9a-f]{8})$`。⚠️ **订正一处我自己写的错注释**：原先写着「主机名段必须惰性，否则贪婪匹配
     会把 `my-host-1` 的 `-1` 吃进后缀」——**实测两种写法在 28 组夹具上结果完全一致**（两端的锚 +
     定长尾巴把切分点钉死了）；撑住那条性质的是 `$` 与 `{8}`，**不是惰性**。注释已改成真话，并把
     「去掉 `$`」/「把 `{8}` 放宽成 `{1,8}`」写成该用例的变异口径。
   - **残留风险如实记**（两种都只会「**晚一点**才捡」，不会「抢错」）：**PID 复用**（撞号进程活着
     ⇒ 误判为「主人在」，那个进程退出后即自愈）与**僵尸进程**（父进程未 `wait` 收尸，pid 仍在进程表
     里 ⇒ 同前）。不探 `/proc/<pid>/stat` 的 `Z`（macOS 无 `/proc`，跨平台拿不到）；**刻意不加时间
     硬上限**兜它们 —— 加上限 = 把租约换回新鲜度启发式，「长跑被抢」原样回来。
     取舍一句话：**宁可偶尔晚捡，不可偶尔抢跑**。
   - 混版本部署安全：升级前写下的无 `@host` 记录一律走「判不了 ⇒ 新鲜度」。`ownerId` 是**内部标识**
     （`src/index.ts` 未导出 `owner-id.ts` / `owner-liveness.ts` / `capability-cycles.ts`，与
     `resume-policy.ts` / `slot-pool.ts` 同档），文档明写「宿主别解析它」。
   - `staleAfterMs = 0`（缺省）下**根本不调用探针** ⇒ 单进程部署零开销、语义与升级前逐字一致。
7. **反向验证 11/11**：本批 6 处 + 上一批 5 处，逐条改坏实现（分级判定退回纯新鲜度 / `ESRCH` 当
   「活着」/ 主机名比较反转 / 摘掉安全整数校验 / 放宽后缀长度 / 不接探针 / 去掉 `try-catch` /
   滞回归位 / 兜底回 500 / 不区分「切了在飞的 run」/ 成环放行），每条**恰好红在对的那条用例**上；
   还原后 4 个源文件逐字节一致，基线复跑全绿。另：变异过程里 `owner-id.ts` 的那句**不实注释**就是
   这么被抓出来的 —— 写用例时顺手做的那次「惰性 vs 贪婪」对照实验，证明原注释的判据根本不成立。
8. **刻意不做**：
   - 不给 `ownerAlive` 补「租约 TTL / 心跳续约」：那要动 `TaskRecord` 的 schema 与所有 store 的写
     路径，而**两个方向的错都已经消掉**（长跑不被抢、孤儿立刻可捡），心跳只会多一个必须配对的旋钮。
   - 不给成环检测加深度上限旋钮（理由见第 5 条）。
   - 不把 `ownerId` 解析器挂进公开 API —— 它是内部标识，暴露出去等于承诺格式稳定。
   - 不改 `resume-policy.ts` 的 `own-process` / `suspended` 两条既有优先级（测试已钉住）。

### 2026-09-28 ⑬：**schema 的环与深度护栏**（外部深评 C6）

事实核验：`core/schema.ts` 的 `check()` 按 `properties` / `items` 递归，**没有任何深度/环判据**
（`grep -rnE 'maxDepth|MAX_DEPTH' src/core/schema.ts` 命中 0）。自引用 schema 在 TS 里是自然的
写法（`const s = {type:'object',properties:{}; s.properties.self = s}`），而症状是
`RangeError: Maximum call stack size exceeded` —— 从**校验**里抛出来，看不出是 schema 有问题。

⚠️ **本轮修正了原报告的一个口径**：只加「深度上限」并**不够**。递归深度是
`min(schema 深度, 值深度)` ⇒ **环 + 浅值**根本不会爆栈（照常校验通过），深度闸抓不到它。
所以两个机制各管一头：

1. `assertNoSchemaCycle()`：**前置**遍历 schema 的三条边（properties.* / items /
   additionalProperties），用**祖先集**判环（共享子树 = DAG 是合法写法，不能误报），
   报错点名「哪条路径指回了它的祖先」；
2. `MAX_SCHEMA_DEPTH = 256`：递归背板，兜「合法但深到失控」（真实 tool schema 深度是个位数，
   256 不误伤；V8 栈在几千帧量级，256 足够早）。**不进 `limits.ts` 的 0 语义表**
   （数量有界不是用户旋钮，与 `MAX_DELIVERED_EVENT_IDS` / `MAX_PENDING_EVENTS` 同档）。

用例 `tests/core/schema-depth.test.ts`（4 条：环 + 浅值报环点路径 / DAG 不误报 / 60 层合法深度
不误伤 / 300 层撞背板）。红证据：第一版只带深度闸时，「环 + 浅值」用例**实证红**
（`必须抛出来（不是静默放行）`）。
### 2026-09-28 ⑭：**limits 表的对账收口**（外部深评 C4 + C5 家族）

事实核验（**我自己的读数，不是报告转述**）：`LIMIT_SEMANTICS` 里 `badValue: 'throws'` 的旋钮
**18 个**（报告写 16 —— 表长过），而「构造期报错文案取自同一张表」的对账 case 只覆盖 **10 个**；
那个清单的声明是 `Array<[LimitKnob, () => unknown, RegExp]>` ⇒ **新增一个 throws 旋钮却忘了对账，
不会有任何东西红**（与 #164 那条「枚举靠人记」是同一类失效模式）。

修法（C4）：

1. **A4 单向穷尽断言**：`filter(badValue==='throws')` 的每个旋钮都必须出现在 `cases` 里，缺一个就红；
   列表里引用不存在的 knob 也会红（clause 取空 ⇒ 文案断言失败）。
2. **补齐缺的 8 条**：`AsyncRunner.concurrency` / `withTimeout.ms` / `interruptibleSleep.ms` /
   `createAnthropicClient.timeout` / `metricsSink.windowSize` / `maxLabelValues` / `maxLabelCombos` /
   `TaskEventStreams.retainTerminal`。
3. **把实现侧文案接上 `zeroClauseOf`**（8 条里 7 条此前手写、或被 `assertTimerDelay` 的通用文案
   盖掉 —— 单源只有一头接了）。代价：`core/timeout.ts` 要 import `core/limits.js`，它「零 import」
   的自述**同步改成真话**（只 import 那张**纯数据、自身零 import** 的表 ⇒ 叶子性不变、无环）。
4. **顺手修一个真 bug（文案套两层括号）**：8 条 `zeroClause` 自带「必须为正数（…）」包装，而实现
   写的是 `必须为正数（${zeroClauseOf(...)}）` ⇒ 生成「必须为正数（必须为正数（0 = …））」。
   表统一成**裸语义**，外层由实现负责。**例外**：`HttpHandlerOptions.maxConcurrentRuns` 保留括号
   —— 它里面是「Infinity = 无上限（0 = 全部 503）」，那是真信息，不是套娃。
5. **`withTimeout` 的 async 站点**：它是 `async function` ⇒ 坏值表现为 **rejection** 而不是同步
   throw，原来的循环只 `assert.throws` 会把它记成「Missing expected exception」（那不是「没炸」，
   是「炸在另一条通道上」）。循环现在两种通道都认。

另一件（C5 家族，同一天顺手发现）：**五个旋钮从未登记进这张表** ⇒ 「改 0 的读法不改表就构建红」
这条纪律对它们曾经是空的。补登 + 配探针：`BudgetGuardOptions.maxTotalTokens` / `maxCostUsd`
（0 = 第一次记账就撞线，**刻意不抛错** —— 预算是运行期累计量，配 0 是「这次一条都别花」的合法
意图）+ `metricsSink.maxCapabilities` / `maxModels` / `maxScores`（基数封顶，0 = 全部折进一个桶
⇒ 非法配置）。

**证据**：A4 断言**第一次跑就红了**，报出我刚补登的三个 metrics 旋钮（正是它该做的事）；
补齐后 `tests/limits.test.ts` 30/30 绿，受影响套件（timeout / sse-text-stats / metrics /
task-events / anthropic / async）141/141 绿，`npm test` 三套件全过。

### 2026-09-28 ⑮：**排队段的上限 `maxQueued`**（外部深评 T5）

事实核验：`concurrency` 只约束**同时在跑**几个，而「跑不上、排在后面」的那一段**没有任何上限**
—— `submit` 永远收单、`POST /tasks` 永远 202。`concurrency: 1` 挡不住它，那只是让排队段更长：
每条排队任务 = 一条 `TaskRecord` + 一棵 `#execute` 的悬挂 promise + 一个 `SlotPool` 等待者，
**全在内存里**（报告原话「无深度上限、无背压信号」，我核到的是同一个形状）。

新旋钮 `AsyncRunnerOptions.maxQueued`（缺省 **0 = 不限** —— 与加它之前逐字一致）：

1. **超限即拒**：`submit` 抛 `TaskQueueFullError`（`status: 503` 自陈字段），HTTP 宿主回
   **503 + `Retry-After`**。为什么不复用 `TaskInputError`：入参不合法是 **400**（调用方改请求
   就能过），排队满**不是调用方的错**（同一请求稍后重发就该过）—— 混成一支会让运维去改一个
   没写错的请求（与 `maxConcurrentRuns` 的 503 那支刻意分开的理由同款）。
2. **判据 = 真正在排队的深度**：`max(0, 已受理未持槽的任务数 + 1 − 空槽位数)`。
   ⚠️ **不是**「已受理未持槽的任务数」—— 那会把「池子还空着、马上就能跑」的也算成排队的：
   `concurrency: 1` + `maxQueued: 1` 下同步连灌两条，第 2 条（正好是那 1 条合法排队）会被误拒。
   **第一版就是那么写的，被用例当场抓出来**（`tests/transport/max-queued.test.ts` 那条
   「『立刻就能跑的』不算排队」就是当时的现场）。
3. **「出排队段」挪到 `await acquire()` 之前**（`#slots.inUse < this.concurrency` 就当场出集合）：
   只走 acquire 的连续体时，「占槽」（`running++`）发生在同步段、「出排队段」却要等一个微任务，
   同一条任务在那一瞬被算两遍 ⇒ 深度虚高一格。⚠️ **没有**顺手把它做成「同步快路径替代
   `acquire`」—— 第一版正是那样写的，结果少掉一次微任务、把「置 `running`」相对引擎推进的
   时刻**提前**，踩到既有用例里「等到 `running` 就当工具已挂在飞」的隐含假设
   （`tests/transport/cancel.test.ts` 的前置断言当场红）。**记账改原子，时序一个字不改** ——
   这条边界值得记住：同步化的收益是记账自洽，代价是**所有**时序假设一起位移。
4. **闸只挡新活**：只在 `submit` 判。恢复路径（approve / 到期唤醒 / 崩溃重投）推进的是
   **已受理**的任务 —— 拦下来等于把它永久搁死在 store 里。另：幂等键命中的重复提交
   **不吃** 503（闸放在去重之后，否则「重试同一个键」会变成看服务忙不忙的运气）。
5. 额度释放走「**拿槽位就还**」（`add`/`delete` 幂等 + `#execute` 外层 finally 兜底），
   故意不写成整数计数器 —— 释放点压根不在同一个函数作用域里，自己造「只减一次」的闸最容易写漏。
6. `get queued`（诊断读数）与闸**同用** `#queueDepth`：看到的数就是判据的数。

**顺带修自述**：`SlotPool.inUse` 原注释写「测试用；对外暴露的是 active」—— 它从此是闸的一半，
那句话会让读代码的人以为改这个读数不影响行为，已改成真话。

**证据**：`tests/transport/max-queued.test.ts` 8 条全绿（含 HTTP 503 一支 + 多轮灌满/排空 soak），
`tests/limits.test.ts` 表驱动对账 30+ 条全绿（`maxQueued` 的 `zero: 'unlimited'` 与直觉的
`disabled` 正好相反，探针专门把两种读法分开）。**变异三条全部具名复红**，分别红 **8 / 2 / 6** 条
（摘掉闸 / 摘掉「拿槽位就还」/ 去掉同步出排队段 —— 中间那条只红 2 条，因为「额度泄漏」只在
「排空后再收」那一段显形；三条都含各自对应那条）；还原后 `src/transport/async.ts` 逐字节
一致、基线复跑全绿。**外加一条真回归的现场记录**：把 `acquire` 换成同步快路径时，
`cancel.test.ts` 的前置断言红了 —— 那不是 bug，是**时序位移**被既有用例抓住（见第 3 条的 ⚠️）。
### 2026-09-28 ⑯：**工具 I/O 事件名单源**（外部深评 E8）

事实核验（**我自己的读数**）：`'tool.input'` / `'tool.output'` 在 `src/` 里共 **12 处取值**
（engine 6：turn 2 / mcp-server 2 / replay 2；eval 4：export 3 / harvest 1；integrations 2），
报告写的「7 处」偏小、方向（跨三层）是对的。另有 2 处**不是**取值：`core/trace.ts` 的一行注释、
`eval/harvest.ts` 里**生成出去的用例源码文本**。

为什么这不是「重复三次的小问题」：`integrations/report.ts` 与 `metrics-state.ts` 都**按名字过滤**
`tool.output`。改名漏一处 ⇒ 那两处过滤恒空 ⇒ **报表说「没有工具调用」，而 trace 里明明有**，
且 `tsc` / `npm test` 全绿（与 `limits.ts` 头注记的「计数会过期」同族：**退化时没有东西会红**）。

修法：

1. 常量 `TOOL_INPUT_EVENT` / `TOOL_OUTPUT_EVENT` + 类型 `ToolIoEventName` 落在 **`core/trace.ts`**
   —— 它本来就是「事件名」的词汇表所在地（`SpanEvent.name` 的注释一直写着这两个名字）。
   ⚠️ **报告建议的落点（`engine/tool-events.ts`，与载荷构造器同处）不可行**：
   `integrations` 只许依赖 `core`（`tests/architecture/layering.test.ts`），拿不到 engine 的导出
   —— 那样 integrations 侧只能再手写一份，等于把「单源」补成「两处」。所以**名字（core）与
   载荷构造器（engine）分开**，代价是同一个概念分居两个文件，收益是三层都能引。
2. **11 处取值 + 6 处 import** 改引常量（turn / mcp-server / replay / export / harvest /
   metrics-state / report）。`eval/export.ts` 的过滤函数签名由字面量联合改成 `ToolIoEventName`。
3. `eval/harvest.ts` 那处**生成出去的代码文本保留字面量**：生成的脚本不 import 本仓常量，
   改成 `TOOL_INPUT_EVENT` 会得到一个引用了不存在标识符的脚本（跑起来才炸）—— 已就地写明理由。
4. 新增**源码级守卫** `tests/architecture/tool-event-names.test.ts`：自带最小遮蔽器，
   ⚠️ **刻意不复用** `lib/source-scan.ts` —— 那个扫描器按设计把字符串逐字遮蔽（它的活是读
   模块说明符），而本守卫猎的正是「代码位置的字符串字面量」，复用会把要猎的东西一起遮掉
   （假阴性，最危险的方向）。三条自证样本：代码里**必须**看见 / 行注释·块注释·模板字面量段里
   **必须**看不见 / 模板 `${ … }` 的**表达式段是代码必须**看见 —— 第三条是**第一版写错的地方**
   （整段模板一起遮 ⇒ `${'tool.input'}` 那个字面量消失），被样本当场抓出。白名单按「**文件 +
   恰好条数**」（不许静默变大），另加走查文件数下限与**射程钉**（曾经带字面量的 8 个文件必须在
   走查范围里 —— 计数下限只保证「够多」，不保证「够到了该够的那几个」）。

**证据**：守卫 4 条全绿；**变异三条全部具名复红** —— ① 往 `integrations/report.ts` 又手写一处
`'tool.output'` ⇒ 恰好「全 src 只有单源文件允许」那 1 条红；② 把 `TOOL_OUTPUT_EVENT` 的值改成
`'tool.output.v2'` ⇒ 「常量值就是那两个字符串」+ 条数那条红；③ 把遮蔽器退回「整段遮掉 `${}`」
⇒ **恰好自证样本红**（守卫自身的守卫在岗）。三条还原后 `sha256` 逐字节一致。
### 2026-09-28 ⑰：**删掉内部死方法 `TaskEventStreams.forget`**（外部深评「forget 未处理」的收口）

**接的是 §10 上一轮那条如实登记**（原文在 4418 行附近：「`TaskEventStreams.forget` 未从
`src/index.ts` 导出、全仓无人调用 ⇒ 它是**内部死方法**，为它写测试等于**锁死死代码**」）。
那一轮只做了「不补测试」的决定，方法本身**留在代码里** —— 于是留下一个更隐蔽的错位：
读代码的人看见一个叫 `forget` 的公开方法，会当它是「外部可以显式丢弃某条流」的**承诺**，
而实际没有任何调用点、也没有任何场景需要它。

本轮把它删掉。复核读数（**自己的**）：

- `grep -rn 'forget(' src/ tests/ packages/ examples/ scripts/` 的命中里，`scheduler.ts` 那 4 处
  是**同名局部函数** `const forget = (taskId) => inFlight.delete(taskId)`（操作 `inFlight` 计数，
  与事件流无关）；`task-events.ts` 那一处是**定义本身**。**真调用点：0。**
- 淘汰机制没有第二份：唯一的真实路径是 `#evictTerminal()`（终态流按 LRU 丢、**有订阅者的不丢**
  —— 那半句是它自己的判据，与 `forget` 无关）。
- `docs/` / 官网 / 用例里**没有**任何地方把它当 API 提到（已 grep 确认）。

**为什么删而不是「补一行注释说明它没用」**：留着的代价不是几行代码，是**一个会说反话的名字**
—— 它承诺「可以外部丢弃」，而实现里既没有这个入口、也没有这个需求。原地留一段注释说明
「它曾经在、为什么删、真要加回来该怎么设计」（连同调用场景一起设计），比留一个空壳诚实。

**射程如实**：这是**无行为变更**的删除（零调用点、未进公共导出面）。因此它**不配**「变异验证」
—— 没有行为可变异；对应地本条的验证只有三条：`typecheck` / `npm test` 三套件全绿
（覆盖率棘轮只降不升才红，删掉未覆盖的死代码只会让分子分母同时变好）、以及上面那组
「零调用点 + 无文档引用」的**读数**。

### 2026-09-28 ⑱：**OTLP 导出不再每次 flush 白算分位**（外部深评 S4）

**报告说的**（`DEEP-AUDIT-VERIFIED-2026-09-28.md` 的 S4 行）：`integrations/metrics-otlp.ts:78`
每次 flush 调 `snapshot()`，「为每条 run / 能力 / 模型各排一次 1024 窗口」，而 **OTLP 侧根本不用分位**；
建议「让 `snapshot()` 的分位可选，或 OTLP 用一个不算分位的视图」。

**核实结果：症状对、量级对，修法错。** 三点读数（**自己的**）：

- 报告对「OTLP 不用分位」的判据是 `grep latencyP50\|latencyP95 src/integrations/metrics-otlp.ts` 为空
  —— 复核成立。但再往前走一步读数更硬：本文件对 state 的读法**全是公开面**（`runs` / `failed` / `costUsd`
  三个标量 + `tokens` / `runStat` / `runLabels` / `capabilities` / `models` / `scores` / 两个 exemplar
  都是**直接遍历公开 map**），它调 `snapshot()` **只**为了拿那三个标量 —— 而那三个**本身就是
  `MetricsState` 的公开字段**。所以问题不是「需要一个不算分位的视图」，是**这次调用根本不该存在**。
- 报告写「200 能力 + 50 模型」是配置**上限**口径；按 `snapshot()` 自身的遍历计数（capabilities +
  models + runLabels + run 各一次）是 30 个组合 —— 与「白算约 250 次排序」同量级、方向一致（**没推翻它**，
  只是把口径说准）。
- 数字（新增 `npm run bench:otlp`，满 1024 窗口 / 30 个组合）：单个 p50+p95 **233.8 µs**、
  `snapshot()` 整体 **5929.6 µs**、`buildOtlpPayload()` **41.6 µs** ⇒ **白算 99.3%**，且**每个 flush
  都付一次**（与 flush 频率成正比、与采集端是否真的消费无关）。报告**没量化**这一步 —— 本仓的规矩是量。

**修法与它为什么不选报告的两条**：删掉那次 `state.snapshot()`，三个标量改直读 `state.runs` /
`state.failed` / `state.costUsd`。
- 不做「分位可选」：那是**给一个不该存在的调用加开关** —— 开关的每一档都要有人维护、有人测，
  而这里没有一档是需要它的（OTLP 要的分位永远是 0 个）。
- 不做「OTLP 专用的不算分位视图」：那是**同一笔依赖的第二份形状**，从此 OTLP 与 Prometheus 各有一个
  「state 读面」，漂移只是时间问题（本仓在 `limits.ts` / `tool-events.ts` 上反复吃过「两份口径」的亏）。

**依赖方向（比省下这 5.9 ms 更根本）**：删掉调用后 OTLP **不再依赖 `MetricsSnapshot`**（Prometheus 侧
渲染的产物）这个类型形状，只依赖 `MetricsState` 的公开读面。这也顺带解释了它原本「看起来」
需要 snapshot：那个形状里恰好写着这三个标量。

**守卫**：`tests/architecture/otlp-no-snapshot.test.ts`，**行为级**而非源码扫描 —— 被守的源码注释里
**本来就写着 `state.snapshot()`**（说明为什么不许调它），靠遮蔽器区分「注释里的」与「代码里的」，
等于把守卫的成败押在遮蔽器的正确性上（本仓在 `tool-event-names.test.ts` 上已为这类遮蔽器付过一次代价）。
判据只有一条：**把 `state.snapshot` 换成会抛的桩，再跑导出路径**。
- 阳性对照「这枚雷真的会炸」：没有它，「不抛」可以在桩没装上时成立（**真空变绿**）。
- 值断言 + 「改字段后 payload 跟着变」：防「不抛，但读的是自带副本 / 常量」。

**变异两条**（具名复红，还原后 `sha256` 逐字节一致）：① 把 `state.snapshot()` 加回去 ⇒
「装了桩之后照样出全量 payload」+「三个标量真的从公开字段读」两条红（文案即桩的
`OTLP 导出路径调了 state.snapshot()`）；② 把 `state.runs` 改成常量 `0` ⇒ **恰好**「三个标量真的
从公开字段读」那一条红。

**射程如实**：**无行为变更**（payload 逐字段不变）；HTTP / 宿主侧一行未动；不做分位可达性的任何改造。
基准 `scripts/bench-otlp-snapshot.ts`（`npm run bench:otlp`）与 `bench:trace` **同档、不进 CI**。

### 2026-09-28 ⑲：**外部深评的 5 份报告入库 + 逐条落地盘点**（改了「复核报告不随仓提交」这个惯例）

**决定**：把 2026-09-28 那轮外部复核产出的 5 份报告**原文逐字入库**到
`docs/reviews/2026-09-28/`，并配一份**索引**（`docs/reviews/2026-09-28/README.md`），
索引里是**逐条落地状态表**（哪些已落地 / 落地 PR / 还剩什么）。

**为什么改惯例**（此前这类报告一直以 `??` 出现在 `git status`、必要时归档进 `.workbuddy/`，
而那目录被 gitignore）：

1. **剩余条目是真实的待办来源**：盘点后 P2 表仍有 **14 条**未做 + 1 条「有意为之」。
   不入库 ⇒ 只有当天在场的人知道还剩什么，「下一轮从哪接」无从接起。
2. **本仓文档里有 7 处引用这些报告**（`spec.md` 4 处 + `CHANGELOG.md` 2 处、
   `CHANGELOG.md:315` 1 处路径引用），而它们此前**指向一个不在仓里的文件** ——
   「文档指向一个读不到的东西」本身就是坏引用（与「文档承诺了、代码没有」同一类病，
   只是发生在**引用**这一层）。

**代价如实**：入库即意味着这些文字会随代码**漂移**（它们描述的是当日代码）。
所以定三条：正文**逐字保留**（历史记录，不改写；连报告里「初稿写错了、在此订正」的订正过程
本身也原样保留）；「现在还剩什么」**一律以索引表为准**；**每落地一条回来更新那张表** ——
那是本目录唯一需要维护的地方。

**盘点是怎么做的**（读数的来源）：不采信报告自述、也不采信上一轮的归档备注 ——
对每条按它自己给的位置（文件 + 行 + 判据）在**当时的 `main`** 上重跑定点 `grep` / 读源码。
结论：

- P1 表（9 条 + 1 条澄清）：**8 条已落地**（`C1`/`C2`/`T1` → #169；`E1`/`E2`/`T2`/`T3`/`J1` → #170），
  1 条未做（`C1-附`：`awaitTask({intervalMs})` 的上界，低危 —— 实际被 `Math.min` 夹在 ≤250ms）。
- P2 表（26 条）：**11 条已落地**（`C3`/`C4`/`C5` → #172；`C6` → #171；`E3` → #170；`E8` → #174；
  `T5` → #173；`S4` → #176；另 `T4` 的当日判据**不完整**，见下），**14 条未做**，
  1 条（`T7`）性质为「有意为之，代价已认」。
- 另外三份（`DEEP-REVIEW` / `PR-164-REVIEW` / `SRC-STRUCTURE`）的残留项：
  **除两条「定案不做」外全部已落地**（`P2-1`/`P2-2` → §10 ⑨；`P3-1`/`P3-2` → ⑧；
  `#executeInner` 守卫 → ⑨、归属定案「不拆」→ ⑩；`SRC-STRUCTURE` §4 落地顺序 1–4 → ⑩，
  第 5 条「加层」定案**不做**）。

**顺带校正了报告一处判据**（`T4`）：报告写「挂起 / 长跑（非终态）流的缓冲**永不淘汰**」——
逐行读后发现**单流条数上限**（`TASK_STREAM_DEFAULT_MAX_EVENTS = 500`，丢最旧 + `NaN` 闸）
**在审计当时就已存在**（#115 起），报告漏看了这一条。**仍然成立**的是「非终态流的**表项**
不被回收」⇒ 挂起任务越多流表项越多（每个 ≤500 条 / ≈1MB）。**要收就收表项，不是收条数** ——
判据不同，修法就不同，所以这条保留为「未做」但把判据写准。

**7 处引用的更正**：前 5 处（`spec.md:4224` / `:4256` / `:4438` / `:4489`、`CHANGELOG.md:12`）
原文里的「（**未随本仓提交**）」**自本条起不再成立** —— 那些报告现在在 `docs/reviews/2026-09-28/`。
按本节的**只增不改**纪律，原文一字未动，权威更正就是这一段；索引 §3 把 7 处逐条列了出来。
第 6 处（`CHANGELOG.md:315` 指向「**仓库根** `SRC-STRUCTURE-2026-09-28.md`」）是**坏引用**
（那个文件从来没在仓库根存在过），已**就地修成入库后的真实路径** —— 修的是坏引用，不是历史事实。

**射程如实**：本节零代码改动；入库的 5 份文件入库前后逐份 `shasum -a 256` 比对，**逐字节一致**。

### 2026-09-28 ⑳：**engine 层的四处「如实性」收口**（外部深评 E4 / E5 / E6 / E7）

接的是 `docs/reviews/2026-09-28/README.md` §2.2 那四条「未做」（P2 表里 `engine/` 的全部剩余项）。
四条**不同质**，逐条先说清它是什么性质 —— 这批里**三条不改行为**，只有一条动结构：

**E4 · 请求失败出口硬写 `eventsDelivered: false`（如实类，零行为变更）**

`failedResult(e, iterations)` 只收两个参数，而 `eventsDelivered` 位只挂在**内层**
`LoopContext` 上（`agentLoop` 内部 `buildLoopContext` 造的那个），外层 `executeRun` 的 catch
**够不到**它 —— 所以那条出口只能硬写 `false`。

修法不是给它加个参数就完：**根因是「段级事实」被存在了段内对象上**。挪到 `progress` 上 ——
它不是随手挑的容器，`turn.ts:233` 的既有注释写着「就地累加，**抛错时调用方仍读得到**」，
`iterations` 与 `eventsDelivered` 是同一类事实（段级、跨函数、抛错后仍要可读），
本来就该同住一处。改动面：`AgentLoopArgs.progress` 与 `LoopContext.progress` 加可选字段、
`deliverTaskEvents` 置位改指 `ctx.progress`、catch 按事实传。

**为什么当日没能发现**：`pendingEvents` 的清理在**终态**分支是无条件的（`async.ts`），
而这条出口必走终态 ⇒ 框架内部簿记恰好被掩盖。它坏的是**对外字段**：`AgentLoopResult.eventsDelivered`
随 `rec.result` 落库、在导出面上，宿主据此判「这批事件进没进历史」，报错方向**恰好会让它以为该重投**
（重投 = 模型看到两条）。所以这是「如实类」：**内部行为一个字没变，是那个字段不再说谎**。

**E5 · `stop reason` 的成败分类不是穷尽式的（形状类，改法比报告要求的更强）**

报告要的是「加 `never` 穷尽断言」。实际做成**表**：`SUCCESS_STOP_REASON: Record<AgentStopReason, boolean>`。
两条理由：
- **`never` 断言是运行期的**（`const _never: never = reason` 只在真被调到时才红），
  而 `Record` 是**编译期**的：往联合里加成员而不表态 ⇒ `tsc` 直接 `TS2741`。**更强，且免费**。
- 表本身带语义（每一行都要写 `true/false` 并附注释），而 `never` 断言只证明「有人补了一行」。

射程也要说准：报告写「要动 4 处」是**概数**。逐处看过之后，需要穷尽性的只有**分类点**一个
（`isSuccessStopReason`），其余两处（`runtime/run.ts` 的状态、`engine/loop.ts` 的 trace 状态、
`toolkit/subagent.ts` 的交回）**都经它**。所以「三处消费者各说各话」这个历史事故
（`stop_sequence` 落地时 loop 判成功、Run 判失败）从今天起在类型上不可能重演。
`engine/stop-reason.ts` 里那条 `if` 链**不在射程**：它的输入是**模型给的字符串**（不是我们的联合类型），
穷尽性对它是错的概念。

**E6 · `budgetTokens` 的口径文案不准（文案类，零行为变更）**

`types.ts` 写「预算（估算 input tokens）」，而 `policy.ts` 只把 `messages` 喂给 `countTokens` ——
system prompt 与 tools schema 同样进请求、却不在这个数里。选**改口径**而不是「把 system/tools 也计入」：
后者是**行为变更**（更多 run 会触发压缩），而报告自己把这条列在 P2「结构性 / 一致性问题」，
不是「压缩策略不对」。改后两边（`types.ts` 与 `usage-guide` 的表格）说的是同一件事，
并写明「真实 input tokens 恒 ≥ 这个数」——这才是读它的人真正需要知道的那句话。

**E7 · `setAttribute` 到底有没有闸（文案类，代码未动 —— 并写明为什么不加闸）**

报告原判「`setAttribute` 不受 `maxEvents` 约束」，复核时它已被自己的第二轮修正为
「**属性条数/总字节**不受**条数闸**约束」。本轮把这句准确的话落到**代码注**（`tracer.ts` 的 `setAttribute`）
与 `observability.md` 那张表（原表只写「超限即停」，容易被读成「一切都不再记」）。

⚠️ **为什么不做成「给属性也加闸/加截断」**（这是本条真正的取舍）：属性是**交付的 trace 与增量流
共用的同一份载荷**，而 `core/trace.ts` 那条折叠契约 —— 「按 `seq` 折回必须**逐字等于** `snapshot()`」——
的两端就是它们。只截一侧（或只拦一侧）就当场毁掉那条契约，而它有用例钉着
（`tests/engine/trace-events.test.ts`）。要收，正确的位置是**run 入口那几条由调用方决定大小的入参**
（`labels.*` 的值、`tools.names` 的拼接结果），那是另一次设计，不在「如实性收口」这轮。

**验证**

- E4：新回归用例（事件已注入 → 续跑段请求失败 ⇒ `eventsDelivered === true`，并带阳性对照
  「工具跑过 2 次」证明真的进过续跑段）。**变异：撤回 catch 的传参 ⇒ 恰好那条红**，还原后
  `sha256` 逐字节一致。⚠️ 这条用例的**第一版夹具是错的**：工具在续跑段又请求延后 ⇒ 本段在发请求
  之前又挂起 ⇒ 脚本永远耗不尽 ⇒ 30s 超时（把「没走到出口」伪装成「用例写不出来」）。已改成只在第 1 次延后。
  ⚠️ **本批最值得记的一处自我更正：E4 的第一版修出了真回归。** `eventsDelivered` 从
  `LoopContext` 顶层搬走之后，**四个挂起出口**（`suspendedResult` 的 ctx 里那个**可选**字段
  再没人传）全部**静默变成 `false`** —— 可选字段缺失不报错，`build` / `typecheck` / `biome` **全绿**。
  抓住它的是**既有用例** `tests/transport/task-events-input.test.ts` 的「事件注入后正常循环里再挂起
  ⇒ 簿记清掉」：`rec.pendingEvents` 该是 `undefined`，实测留住了那条事件。**「改完先跑三套件」的价值
  就在这里 —— 类型检查对「漏读一个可选字段」是瞎的。** 修法：`eventsDelivered` 只留一个真源
  （`progress`），`suspendedResult` 也改从 `ctx.progress` 读，并在那处写下「别挪回顶层字段」。
- E5：**变异：往 `AgentStopReason` 加第 13 个成员 `'brand_new_reason'` ⇒ `npm run typecheck` 红**
  （`TS2741 ... is missing ... but required in type 'Record<AgentStopReason, boolean>'`），还原后逐字节一致。
  另配 `tests/types/stop-reason.types.ts` 的 `@ts-expect-error` 正控（表被放宽成 `Partial` 时它变成未使用 ⇒ 红）。
- E6 / E7：零代码行为，验证 = 三套件全绿 + 文档门禁（`usage-guide` 表格与源码对账那条也在其中）。
- 全链：`build` / `biome ci . --error-on-warnings` / `typecheck` / `typecheck:types` / `typecheck:tests` 全绿；
  `npm test` 三套件全绿。

**射程如实**：本批**不改任何运行时行为**（E4 改的是对外字段的取值来源、E5 等价重写、E6/E7 只改文字）。

**⚠️ 顺带订正 ⑲ 的两处计数错（本批自查出来的）**

⑲ 里我写「P2 表 26 条：**11 条已落地 / 14 条未做**」——**那是我的算术错**。逐行数出来是
**8 已落地 / 17 未做 + 1 有意为之**（26 行）；「11」不能从任何逐行状态里数出来。
更糟的是第二处：**⑲ 的索引表漏了整行 `K6`**（三态 `system` 的隐性差异没进使用者文档 ——
函数形态不追加 `REPORT_HINT`，另两形态追加），而汇总却按 26 行写的 —— 数字与清单**互不自洽**。

按本节的**只增不改**纪律，⑲ 的原文一字未动，订正落在两处：
- **索引表**（`docs/reviews/2026-09-28/README.md` §2.2，那是「还剩什么」的真源）：补 `K6` 行、
  逐行状态改成 `✅`/`❌` 可数、汇总改成 **12 / 13 + 1**，并在表下留一段订正说明；
- 本条目（⑳）与 `CHANGELOG` 的 ⑳ 条各记一句。

教训写下来：**汇总数字必须能从逐行状态里数出来**（`grep -c` 一次即可），
不能凭印象写 —— 这与我在这里反复强调的「读数而非印象」是同一条，只是这次犯在自己身上。
**本批之后的 P2 账**：26 行 = **12 已落地 / 13 未做 / 1 有意为之**。

### 2026-09-28 ㉑：**runtime / container / 文档三处「静默给错东西」收口**（外部深评 K3 / K4 / K6）

接 `docs/reviews/2026-09-28/README.md` §2.2 的 `K3` / `K4` / `K6`。三条同族：
**都是「出了错却没有任何信号」**——两条给出错的**值/状态**，一条给出错的**认知**（文档）。

**K3 · `Run.finish()` 没有守卫（行为变更：从静默翻转改成响亮抛错）**

`start()` 有守卫（`!== 'queued'` 抛）、`suspend()` 有守卫（`!== 'running'` 抛），
**`finish()` 没有** —— 对一条**挂起中**的 run 调它，会把 `_status` 静默改成
`isSuccessStopReason(...) ? 'succeeded' : 'failed'`。挂起**不是终态**：它带着
`suspendedMessages` 等审批/唤醒，宿主的恢复路径正是靠它接回来的；翻掉之后这条 run 在 store 里
看起来「已结束」，恢复路径**再也接不上**，而且全程零信号。
`Run` 是公开导出（`src/index.ts:95`）⇒ 这不是内部纪律，是**对外承诺**。
判据只认 `running`（`queued` 的 run 还没开跑，拿结果去收尾同样是调用方用错）。

**K3 的后半 · `cancelled` 的可达性如实（只改口径）**：`RunStatus` 有 6 个成员，而进程内
`Run` **到不了 `cancelled`** —— 引擎侧取消表现为 `stopReason: 'aborted'`，
`finish()` 按 `isSuccessStopReason` 判 ⇒ 记 `failed`（带结构化 `error.type: 'aborted'`）。
`cancelled` 由**宿主**落（`TaskRecord.status`）。同一份联合类型**两个消费者、可达集不同**，
这是**有意的**（`TaskRecord` 是运维读数：「人按的」与「跑挂的」必须分得开；`Run` 是进程内状态机），
但此前只写在实现里、没写在类型上 —— 现在写进 `core/run.ts` 的 `cancelled` 注释，
并留下判据：「要加状态时先想清是给谁的」。

**K4 · `async` 工厂被静默当成值（行为变更：解析期响亮抛错）**

容器是**同步**解析的：`useFactory` 写成 `async` ⇒ 返回的 Promise 被**原样缓存成「值」**
（`cache.set(token, value)`），下游注入到的是 Promise 本身 —— 首次属性访问全 `undefined`、
零报错、`tsc` 也看不出来（调用点把结果断言成了 `T`）。这是最坏的一类：**错的不是报错，是值**。
现在在 `cache.set` **之前**检测 thenable 并抛 `TypeError`（文案给出两条出路：装配前 await 好再
`useValue`，或包一层 `useValue: { promise }` 注入 Promise 本体）。

两条设计取舍写下来：
- **检测器就地写、不从别处 import**：`container` 是**纯叶子**（`tests/architecture/layering.test.ts`
  里 `container: []`），为两行逻辑破叶子边界不值得；`store/store.ts` 里那个 `isThenable` 够不着。
- **覆盖三个分支**（`useValue` / `useClass` 实例 / 工厂结果），不是只查工厂：三个分支的契约
  同样是「同步解析成**就绪的值**」，只查一处等于把同一类错留在另两处（本仓最贵的教训）。
  已 grep 确认全仓没有「故意注入 Promise」的用法；逃逸口**配了测试**，不是口头承诺。

**K6 · 三态 `system` 的隐性差异进使用者文档（纯文档，零代码）**

`resolveSubSystem`：`string` 与 `SystemPrompt` 两形态**自动追加** `REPORT_HINT`
（「你运行在独立上下文，全部中间过程不外传；你的最终回复将作为报告原样交回主 agent」），
而**函数形态不追加**（`return spec(task)`）。这是**有意**的（函数形态的返回值由使用者全权决定），
但使用者读 `usage-guide` 时看不到 —— 于是「我用了函数形态，为什么子 agent 不按报告格式回」成了
文档没答的问题。已在 `usage-guide` 的 `system` 行写明差异与「要提示请自己拼」。

**验证**

- K3：`tests/runtime/run.test.ts` 新用例（`suspended` 与 `queued` 两条路径都要抛，且**抛后状态不许被改**）。
  **变异：摘掉 `finish()` 的守卫 ⇒ 恰好那条红**，还原后 `sha256` 逐字节一致。
- K4：`tests/container/container.test.ts` 新用例（async 工厂抛错 + **第二次解析仍抛**
  —— 错误必须在缓存**之前**抛，不许把 Promise 留在 cache 里当「已解析」；外加逃逸口用例）。
  **变异：摘掉 thenable 检测 ⇒ 恰好那条红**，还原后逐字节一致。
- K6：纯文档，验证 = 三套件全绿 + 文档门禁。
- 全链：`build` / `biome ci . --error-on-warnings` / `typecheck` / `typecheck:types` / `typecheck:tests`
  全绿；`npm test` 三套件全绿（**1549** / 20 / 27，fail 0）。

**射程如实**：K3 / K4 是**行为变更**（都朝「响亮失败」的方向）；两者都在**用错时**才触发
（正常路径逐字未变：`finish()` 只在 `running` 后调、工厂都是同步的 —— 全仓 grep 过）。
P2 账：26 行 = **15 已落地 / 10 未做 / 1 有意为之**。

### 2026-09-28 ㉒：**四条「静默失效」收口**（外部深评 S1 / S2 / S3 / S6）

接 `docs/reviews/2026-09-28/README.md` §2.2 的 `S1` / `S2` / `S3` / `S6`。四条同族：**都是
「错了 / 算不出 / 超限了，却没有任何信号」**。修法各只有一句话：**让「不知道」与 `0` 在类型上分开**（S2）、
**让同一事实只有一份读数**（S1 / S3）、**让无界的地方有界且出口说话**（S6）。

**S1 · redis 的 TTL 不再吃掉非终态记录（⛔ 行为变更）**

`applyTtl` 此前**不看 status**：一条在等审批（`suspended`）的任务，TTL 一到记录就从 redis 里消失 ——
那条「批了它」的决定**无家可归**（`approve` 404），而 `InMemoryTaskStore.evict` 里明写着
「`suspended` 不可淘汰」（**同一事实的两处读数，方向相反**）。现在判定收进 `core/run.ts`：

- `TERMINAL_STATUS: Record<RunStatus, boolean>` + `isTerminalStatus()` —— **穷尽分类表**形状
  （与 `stop-reason.ts` 的分类表同款）：往 `RunStatus` 加成员而不表态 ⇒ `tsc` 报缺属性（`TS2741`）。
  负向枚举（原来的 `status !== 'queued' && …`）会让新成员**静默变成「终态」** ——
  那正是「挂起中的任务被当成跑完了」这类 bug 的来源。
- `redisStore.save` **只在终态**施加 TTL；非终态覆写靠 `SET`（不带选项）**清除**既有 TTL ⇒
  记录与幂等索引都活过整个等待窗口。幂等索引与记录**同生共死**（索引若先过期，同键重提会绕过去重、
  把一条在跑的任务再跑一遍 —— 比「记录丢了」更坏）。
- **代价如实**：一条**永远等不到**审批的挂起记录会永久驻留（批不批是人的事，store 无从判死）——
  与内存 store 跳过 `suspended` 是同款取舍，清理属部署层职责。

**S2 · 上游没回报 usage 不再静默恒 0**（四条里最贵的一条：它让 `maxCostUsd` 静默失效）

`acc.usage?.prompt_tokens ?? 0` —— `0` 与「不知道」在数值上无法区分，于是端点不回 usage
（或忽略流式请求里已经发出去的 `stream_options.include_usage`）时 token/成本**恒 0**，
护栏看起来一切正常。四条响应路径都改（流式 / 非流式 × 两条适配器），并把信号一路送到读得见的地方：

- `MessageUsage.unreported?: true` —— 「这几个 0 是替身值，不是读数」写进类型；
- `engine/turn.ts` 在 llm.turn span 上记 `usage.missing`；事件名**单源到 `core/trace.ts`**
  （与 `tool.input` / `tool.output` 同一条纪律：写它的层与按名字过滤的层不许各写一份字面量）；
- 报告 `usageMissingTurns` / `usageMissingModels`、指标 `agentia_model_usage_missing_turns_total`
  （**render 与 OTLP 两个出口都要有** —— 只补一个，按文档把 `metricsSink` 接到 `/metrics` 的部署
  就看不见，而「OPTL 那半有」这件事本身不会报错）；
- **与 `usage.unpriced` 刻意分开**：那个是「模型不在价格表里」（换模型），这个是「上游没给读数」
  （查端点 / 网关）。两者后果都是「成本看起来是 0」，但**排障方向不同** —— 混成一条就是把人带偏。

**S3 · `statusOfStreamError` 两份 → 一份（合并时发现它们**早就**不一致）**

判定原本在 `anthropic.ts` / `openai.ts` 各写一份，一致性靠两边注释里「与那边同口径」互相喊话 ——
注释不会在被改的那一刻失败。收进 `adapter-options.ts` 时按词表**并集**处理，并用
`tests/integrations/stream-error-parity.test.ts`（一张表跑**两条真适配器 + 真 SSE**）把结果钉住：
其中 `not_found_error` 与 `model_not_found` 两行是**合并前真实分歧**（同一病因，一侧 400、另一侧 500，
后者把「模型名错」记成 `server`，排障方向被带偏）。用例给这两行打了 `wasDivergent` 标记 ——
免得后人以为这种对称是天然的。

**S6 · 两条 MCP 桥的分帧缓冲有上限**

`buf += chunk` 之后按 `\n` 切帧 —— 对端一直吐**不带换行**的字节就是无界增长（先 OOM 再谈协议），
而这**不是罕见输入**：MCP server 往 stdout 混日志本来就常见，而「一条不换行的日志行」正是这形态。
`core/line-framing.ts` 给两侧**同一个** `MAX_FRAME_CHARS`（8M 码元，单位口径与取值理由写在注释里）：

- **连接器**（读子进程 stdout）：超限 ⇒ 丢弃缓冲、一次性拒绝全部在途请求、**终止子进程** ——
  帧边界已经丢了，再读下去既救不回那条「一行」，也答不出任何在途请求。
- **反向桥**（读宿主 stdin）：超限 ⇒ 回一条协议错**并丢弃到下一个换行重新对齐** ——
  其后的完整帧照常派发。用例把「重新同步」也钉住了：不同时守它，很容易退化成「一路丢到天荒地老」。

**验证**

- S1：`tests/store/redisStore.test.ts` 新增一档（queued / running / suspended 都**不得**带 TTL；
  suspended → succeeded 才落窗口）。**变异：把终态闸摘成 `expires = true` ⇒ 恰好那条红**，
  还原后 `sha256` 逐字节一致。
- S2：`tests/integrations/usage-missing.test.ts`（8 条 = 四条路径 × 正反）+
  `tests/engine/turn-usage-missing.test.ts`（3 条，含「未定价 + 有计量 ⇒ 只发 `usage.unpriced`」）+
  `report.test.ts` / `metrics.test.ts` 各一条聚合。**变异：摘掉 openai 流式的 `unreported` 标记 ⇒
  恰好适配器那条红；摘掉引擎的事件 ⇒ 恰好引擎那条红**（两条独立，不互相遮蔽）。
- S3：`tests/integrations/stream-error-parity.test.ts` 10 条。**变异：从词表里删掉 `not_found` ⇒
  恰好 `not_found_error → 400` 那条红**（证明那行真有牙齿，不是装饰）。
- S6：`tests/integrations/mcpConnector.test.ts` + `tests/engine/mcp-server.test.ts` 各一条
  （夹具新增 `hugeline` 模式：9 MiB 且不换行）。**变异：摘掉反向桥那条「超限回协议错」⇒ 恰好那条红**。
- 全链：`build` / `biome ci . --error-on-warnings` / `typecheck` / `typecheck:types` / `typecheck:tests`
  全绿；`npm test` 三套件全绿。
- **文档门禁当场抓到我一次**：`ModelReport` 加字段后 `tests/docs/api-page.test.ts` 报
  「形状没有「…」（= 自陈穷尽）却漏了源码里的 `usageMissingTurns`」—— 这正是它该管的事
  （源码形状 ↔ 文档自陈），修的是文档不是断言。

**射程如实**：S1 是**行为变更**（TTL 语义：查询窗口从「最后一次状态推进」改成「进入终态那一刻」）——
对**终态记录**逐字不变，变的只有非终态那一档（此前它们**不该**被 TTL 吃掉）。S2 / S3 / S6 对
正常路径逐字不变（S3 只在合并前两侧**本来就不一致**的两行上给了不同结论；S6 只在上限被越过时生效）。
P2 账：26 行 = **19 已落地 / 6 未做 / 1 有意为之**。

### 2026-09-28 ㉓：**store 可选能力进接口 / 嵌套黑板「不隔离」写明 / T6 定案**（外部深评 S5 / K1 / T6）

**S5 · `compact()` / `close()` 进 `TaskStore` 接口（可选）**

`FileTaskStore.compact()`（压实 JSONL：一 task 一行、丢历史覆写行）与 `SqliteTaskStore.close()`
（释放 db）此前只活在**具体类**上。宿主拿到的通常是**接口类型**（DI 注入 / 工厂返回 /
配置驱动选 store 三种都是这形态），想周期性压实只能 `as FileTaskStore` 强转 ——
而强转在换 store 时**不会报错**（sqlite 没有 `compact`），要到运行期才炸。
现在两个方法进 `TaskStore` 且保持**可选**：调用点写 `store.compact?.()`，
「可能有、可能没有」在类型上是显式的；只实现基本面的测试桩照常满足接口。
类型级守卫是 `tests/types/store-surface.types.ts`（含一条 `@ts-expect-error` 正控：
谁把它们改成必填，那条指令变成未使用 ⇒ `TS2578` ⇒ `typecheck:types` 红）。

**框架刻意不替你调**：`AsyncRunner.drain()` **不**关 store —— 同一个 store 可能被调度器或
另一个宿主共用，关掉它是**宿主的**生命周期决定（框架替它关 = 把别人还在用的东西关了）。
压实频率同理归宿主（建议低频，如 cron 每小时一次）。

**K1 · 嵌套能力共用一块黑板 ⇒ 写明「不隔离」（纯文档，零代码）**

`withRunContext` 全仓只有 `run.ts:214` 一个调用点 ⇒ `@SubAgent` / `@Skill` 的执行体跑在**同一个**
`RunContext` 上：子 agent 读写的就是父 run 的那块黑板（同一份 `Map`），子 agent 写的键父 run 也看得见。
这是**有意**的（「把你的发现留在黑板」正是子 agent 的用法，也是 `@Skill` 第二参能拿到 ctx 的原因），
但使用者此前只能从源码推出来。现在写进 `usage-guide` §5.1 三个部分：**有意之处** +
**代价**（并发子 agent 写同一键是 last-wins，与 `flushMemory` 同款取舍）+ **怎么办**
（自己命名空间，框架不拆键、也不深拷贝）。「要不要按子树隔离」保留为 `spec.md` §11 开放项 ——
这轮不装作已解答。

**T6 · 初始 `save` 不 await：**定案「不改」，理由与守卫一并写明**

报告自报「`async.ts:596` 仍 `const saved = this.store.save(rec)`（不 await）」，并已自行降级为 P3。
本轮定为 **有意为之**，理由是可查的：

- `submit` 是**同步门面**（它自己的注释写着「异步 store 下 save 在后台完成、去重推迟到执行前」，
  返回值是**提交时刻的快照**）。`await` 会把它变成 async ⇒ **破坏性 API 变更**，
  而买到的只是「调用方多等一个网络往返」—— 对一条 P3 不划算。
- 「不 await 就会静默吞错」这个担心**已有处置也有用例**：`isThenable` 分支把迟到的 reject
  转成「任务标记 failed 重存」，且**只在任务尚未被推进时**改判 —— 否则会把已成功的 run 覆写成 failed。
  用例在 `tests/transport/async.test.ts`（「初始 save 迟到 reject：不得把已成功的 run 覆写成 failed」）。

⇒ 结论是「**已知边界 + 已有守卫 + 承重理由**」，不是漏项。

**验证**

- S5：`tests/types/store-surface.types.ts`（`typecheck:types` 校验）。⚠️ 文件名不是 `*.test.ts`，
  `node:test` 不收它 —— 跑错命令（`typecheck:tests` 那边 `exclude` 了 `tests/types`）一个字都不会被检查。
- K1 / T6：纯文档 + 定案（零代码改动），验证 = 三套件 + 文档门禁全绿。
- 全链：`build` / `biome ci . --error-on-warnings` / 三个 typecheck / `npm test` 三套件全绿。
- P2 账：26 行 = **21 已落地 / 3 未做 / 2 有意为之**。

### 2026-09-29 ①：**记忆回写的 CAS：可选、成对、冲突出声**（外部深评 K5）

**病灶（复核过，条目原文成立）**：`runtime/run.ts` 的 `flushMemory` 是**无条件全量读改写** ——
水合 `load(keys)` 在 run 开头、回写 `save(entries)` 在收尾，中间隔着整条 run。
两条 run 拿**同一份 store + 同一批 keys** 并发跑时，后写的那条会把先写那条改过的键**整片覆盖**回去，
而**双方都看不出异常**（last-write-wins）。报告给的处置是「加版本号/CAS，或文档写明「同 keys 并发不安全」」。

**设计分叉（三条、当场排掉两条）**：

- **(a) 只回写本 run 改过的键** —— 看着最省事，实际**更坏**：判「改没改」要靠引用相等，
  而工具**原地改对象**（`ctx.get('x').n += 1`）时引用不变 ⇒ 判成「没改」⇒ **静默丢写**，
  比今天的 bug 还隐蔽。排掉。
- **(c) 只写文档** —— 等于承认不修；而这条的性质是「丢数据无声」，正是本仓一直在收口的那一类。排掉。
- **(b) 给 `MemoryStore` 加**可选** CAS 能力 + 不支持时出声降级** ⇒ **选定**。
  与同夜刚落地的 S5（`compact?()` / `close?()` 进 `TaskStore`）**同一形状**：能力进接口且可选。

**落地形态**（`runtime/memory.ts` + `runtime/run.ts`）：

- **两个可选成员，成对**：`loadWithRev(keys) → { values, rev }`（`rev` 是**不透明**句柄，框架
  不解释、不复用，只在本 run 回写时原样递回）与 `saveIfRev(entries, rev) → { committed, reason? }`。
- **半个 CAS 是装配错误**：只实现一个 ⇒ `executeRun` **入口**抛 `TypeError`（在 `try` 之外，
  不被「辅助动作失败只降级」那条吞掉）。理由：只读版本不校验**与不支持完全等效**（照旧静默覆盖），
  却给出「这件事有据可查」的错觉 —— 本仓一律把「看起来在岗、其实不在岗」当错误。
- **冲突时：不写 + 出声**。`saveIfRev` 回 `committed !== true`（**含忘返回 `undefined`** ——
  判据是 `!== true` 而不是 `=== false`：不知道写没写，就不许记成写成功）⇒ 该 key 集**一个字都不写**，
  打一条 `console.warn`（含 `keys` 与冲突事实）。**框架不合并、不重试**：后写赢 / 逐键赢 /
  按时间戳赢都是策略，属 store 与宿主；框架的职责只是把「丢了一条写」变成有声。
- **回写被拒不改 run 结局**（仍 `succeeded`）—— 与 sink 抛错、store 故障同款（辅助动作不击穿业务）。
  **代价如实**：这一轮的记忆**没落库**，重试配方（`load` → 自己合并 → `saveIfRev` 循环）写进
  `usage-guide` §6.5 新增小节「并发 run 共用同一 keys」。
- **不支持 CAS 的 store：出声降级**。只有 `load` / `save` 时行为**一字不改**（last-write-wins），
  但**第一次**用这个 store 实例时打一条**一次性**提示（`WeakSet` 去重，不是每轮刷屏）：
  「同 keys 的并发回写丢写**不会被发现**」。框架**检测不了**没有版本号的覆盖 ——
  这不是「暂不查」，是没有依据可查（如实写进 `usage-guide` §7 边界表）。
- `InMemoryMemoryStore` 顺带实现这一对：版本是**整店一个单调计数**（粗粒度 ⇒ 宁可多报冲突，
  不漏报真实覆盖；代价如实写在类注释与文档里）。

**为什么不是「加体积上限」**：报告同句还提了「无体积上限」。那条的对象是**宿主自己的 store**
（框架不拥有数据），且「多大算大」是部署问题（`usage-guide` §7 已有「记忆没有删除语义」的同款边界）；
本条目只收能收的那半 —— **覆盖能不能被发现**。

**验证**（`tests/runtime/memory.test.ts` 新增 6 条 + `tests/types/memory-surface.types.ts`）

- 正路径：带 CAS 的 store 回写走 `saveIfRev`、**不再**退回无版本号的 `save`、提交成功**不出声**。
- 冲突路径：另一条「并发 run」在工具执行期写了同一份 store ⇒ 断言 ① 本 run 仍 `succeeded`；
  ② store 上是**别人的值**（一个字都没写，不合并）；③ 恰好一条告警，含「记忆回写被拒绝」、
  `conflict` 与 keys。
- 一次性提示按**实例**去重：连跑两条 run 恰好一条提示，且两次 `save` 照旧（旧行为不变）。
- 半成品两个方向各一条 `assert.rejects(/必须成对实现/)`。
- `saveIfRev` 忘返回 ⇒ 按「未确认」出声。
- 类型级（`typecheck:types`）：两个成员是**接口上的可选**成员（最小实现仍满足接口）、
  `committed` 必填，含一条 `@ts-expect-error` 正控。
- **变异（每条都亲跑，逐条点名）**：① 冲突当成功（只有「忘返回」才出声）⇒ 恰好冲突那条红；
  ② 摘掉成对检查 ⇒ 恰好两条半成品红；③ 摘掉一次性提示 ⇒ 恰好「提示按实例去重」那条红；
  ④ 冲突分支不 `return`、落到无版本号的 `save` ⇒ **两条**红（CAS 正路径那条 + 冲突那条 ——
  退回 `save` 后既走了不该走的路径、又真的把别人的值覆盖了）。还原后 `sha256` 逐字节一致。
- 文档面：`api.html` 补 `MemorySnapshot` / `MemoryWriteResult` 两行 + 导出计数 226 → 228；
  `usage-guide` §6.5 新增小节 + §7 边界表新增一行（登记进 `boundary-table` 的 registry，
  key = 首列归一）。

**P2 账**：`K5` 从未做 → **已落地**（26 行 = **22 已落地 / 2 未做 / 2 有意为之**）。

### 2026-09-29 ②：**非终态流的缓冲配额**（外部深评 T4）—— 判据订正：收的是**缓冲**，不是**表项**

**病灶（复核过，但报告当日的判据不完整）**：报告写「非终态流的缓冲『永不淘汰』」并建议
「收**表项**」。复核结论分两半：

- **单流的条数上限早就在**（`TASK_STREAM_DEFAULT_MAX_EVENTS = 500`，丢最旧 + `NaN` 闸，
  #115 起）—— 这一半报告漏看了；
- **仍然成立**的是：终态那条 LRU（`retainTerminal`）**只管跑完的任务**，而「挂着不动的任务」
  才是真常态 —— 等审批的、等事件（`signalTask`）的、等定时器（`deferUntil`）的每条都占一份
  ≤500 条（≈1 MB）的缓冲，**且永远走不到终态** ⇒ 表项与缓冲只增不减。

**判据订正（本次改动最重要的一句）**：**不能收表项**。删掉一条非终态流的表项会**静默破坏**
本模块的设计约束 1（「序号是流自己的」）：`GET /tasks/:id/stream` 的判据是
`streams.has(taskId)`，表项不在就会走到「**本进程没有这条流**」那条路 —— 而任务明明就在本进程跑
（`stream.unavailable` 是一句**假话**）；更要命的是恢复段的 `open()` 会新建一条 `nextIndex = 1`
的流，拿 `Last-Event-ID` 续订的读者的 `replay(from = N)` 从此**永远筛不出东西**（`index > N` 恒假），
它只会等到收口帧，中间一片空白。⇒ 收**缓冲**、留**表项**（桩：`nextIndex` / `firstAvailable` /
订阅表都留着，约百字节/任务）。

**落地形态**（`transport/task-events.ts` + `transport/async.ts` + `core/limits.ts`）：

- `TaskEventStreams` 新增 `nonTerminalBuffers`（缺省 **32** 条流），经
  **`AsyncRunner.streamNonTerminalBuffers`** 暴露给宿主（`0` = 不为没人读的非终态流留回放缓冲）。
- 超出配额即从**最旧**（Map 插入序）且**无订阅者**的非终态流开始回收缓冲：
  `events = []`、`firstAvailable = nextIndex` ⇒ `replay()` 回空 + `droppedBefore`，
  HTTP 层据此**先**发一帧 `stream.truncated` 再转实时。**序号接着走**（`nextIndex` 不动）。
- **判定点只在「缓冲增长」**（`push` 让某条流从空变非空 / `open()` 把终态流拉回非终态），
  用**增量计数** `buffered` 判配额 —— 每次 push 都全表扫会把这道内存闸本身变成开销。
  代价如实：判定点之间会短暂多出**一条**的量级，不是无界累积。
- **代价三条（都写进代码注释与文档，不是遗漏）**：① 正在被订阅的流**不受配额约束**
  （不抽走正在读的数据）⇒ 同时被读的流很多时缓冲总量仍会超配额；② 每条非终态任务留一个桩，
  桩本身不设上限（同因：删桩就是上面那条静默破坏）；③ 「回放看不全」是**看得见**的降级。
- `0` 语义登记进 `core/limits.ts`（`disabled`：`0 = 不为没人读的非终态流保留回放缓冲（有订阅者的照旧留着）`）。

**为什么是旋钮而不是硬上限**：量纲是「任务数 × 每任务 ≤`maxEvents` 条」，每任务那半已被
`maxEvents` 钉住，剩下的变量就是「多少条流在占缓冲」—— 而「多少条」正是宿主按自己的任务量
唯一能判断的数（挂起队列多长只有他知道）。按字节设限反而要估正文长度（`maxEventChars` 只是缺省）。

**验证**（单测 7 条 + 传输层 1 条 + limits 探针 1 条）

- 单测：配额内保留 / 超配额回收且**表项还在、`done` 仍为 false**、缺口明示 /
  **回收后序号接着走**（`subscribe` 看到的是 2 而不是重来的 1）/ 终态流不归这个配额管 /
  有订阅者的不回收（配额可被突破，取舍被用例钉住）/ `0` 的语义（表项与序号都在、实时照常）/
  坏值构造期抛 `TypeError`。
- 传输层：`streamNonTerminalBuffers: 0` 时连上**正在跑**的任务 ⇒ **第一帧 `stream.truncated`**、
  **没有** `stream.unavailable`（正是「不许谎报别的进程」这条）、实时事件照推、`task.end` 收尾。
- limits 探针：走**公共旋钮**（`new AsyncRunner(..., { streamNonTerminalBuffers })`）驱动坏值，
  `0` 的行为与相邻读法（`invalid` / `unlimited`）区分开。
- **变异（4 条，逐条亲跑点名）**：① 摘掉「有订阅者不回收」⇒ **3 条**红（含那条取舍用例）；
  ② **连表项一起删**（= 报告当日要的形态）⇒ **7 条**红，含传输层那条
  「不许谎报 `stream.unavailable`」—— 这条证明**判据订正本身有守卫**；
  ③ 缺口不回填 `firstAvailable` ⇒ **7 条**红；④ 配额判定恒提前返回 ⇒ **7 条**红。
  还原后 `sha256` 逐字节一致。
- 文档面：`usage-guide` §7「任务进度流的边界」补上配额与降级形态；`guards.md` 的旋钮计数
  **从「21」订正为实测 30**（该行此前已记过四次「计数只能靠数」，本次又撞上 —— 2026-09-28 的
  C4/C5 补登 8 条之后那行就没再对过）。

**P2 账**：`T4` 从未做 → **已落地**（26 行 = **23 已落地 / 1 未做 / 2 有意为之**）。

### 2026-09-29 ③：**四类能力的装配差异收进一张注册表**（外部深评 K2）

**病灶（复核过，但报告的「7 处」是概数、要订正）**：加第五类能力此前要在 `toolkit/module.ts`
改**五处按类分支**：收集（四个 `Map` + 四次 `collectX`）、可用名单（四路拼接）、
`buildSlice`（四路展开）、`@Prompt` 版本表、孤儿能力计数（四路求和）。
性质不是「代码不好看」，而是**新增第五类时没有任何东西会报错**：漏改某一处只表现为
「那类能力静默不进菜单 / 不进版本表 / 不计入孤儿告警」，构建与全部用例照样全绿。

**订正报告的两个计数细节**（同 §2 的「计数会过期，清单不会」）：

- 报告列的**菜单重名校验**不用按类 —— 它跑在**合并后的工具列表**上（`this._tools`），
  与类别无关；按类拆开反而要重新拼回去；
- **能力引用图**（`capability-cycles`）只有 `@SubAgent` / `@Skill` 参与（另外两类没有
  「`tools` 引用」这回事）—— 那是**语义上的不对称**，不是漏项。本条目把这两处**显式写在
  代码注释与表头**，防止后来者「为整齐」把它们塞进遍历。

**落地形态**（新增 `src/toolkit/capability-slice.ts` + `module.ts` 消费）：

- `CapabilityPayloads`（四类的收集产物）就是**「一类能力」的定义**；
  `KIND_SPEC` 的类型是**映射类型** `{[K in CapabilityKind]: CapabilityKindSpec<K>}` ⇒
  加了 payload 成员却不给表项 ⇒ **`TS2741`（缺属性）**，与 `SUCCESS_STOP_REASON` /
  `TERMINAL_STATUS` 同款护栏（加成员不表态就构建红，而不是「下次谁发现」）。
- `CAPABILITY_KINDS` **从表的键派生**（不另写一份清单）⇒ 五处遍历自动覆盖：
  `collectCapabilities` / `capabilityToolNames` / `buildCapabilitySlice` / `capabilityCount` /
  `capabilityVersions`。`module.ts` 里不再有一行按类分支。
- **每类的差异只写在它那一行**：`toTools`（`@SubAgent` / `@Skill` 各自拼 `@SubAgent "x"` /
  `@Skill "x"` 引用提示词）、`toolNames`、`count`、以及**只有 `@Prompt` 有**的 `versions`
  （缺省 = 本类不参与版本表 —— 用可选成员表达，而不是让别的类返回空表）。
- **唯一的类型擦除集中在 `specOf()`**：TS 无法把循环变量 `kind` 与它对应的载荷类型关联
  （相关联合，TS#30581）。擦除的安全性由三件事共同兜住 —— ① 每一行在**定义处**逐个收窄
  （不是靠这句断言）；② 键集从表派生 ⇒ 擦除的覆盖面 = 表的覆盖面；③ 逐类驱动用例。
  **行为零变更**：`module.ts` 的装配顺序、解析时机、错误文案（含 `@SubAgent "x"` 提示词）
  一字未改。

**验证**（`tests/toolkit/capability-slice.test.ts` 6 条 + 编译期 + 3 条变异）

- 用**真装饰器**逐类驱动（不是手搭假载荷）：四类都在场（键集 == 表的键集）、四类都编译成
  工具（四个菜单名）、引用提示词只由那两行给出（`owners` 恰好是
  `@Skill "procedure"` / `@SubAgent "helper"`）、版本表只有 `@Prompt`（另三类的 `versions`
  **是 `undefined`**）、空 provider 四类皆空但遍历不踩 `undefined`。
- **变异（3 条，逐条亲跑点名）**：① 从 `KIND_SPEC` 摘掉 `prompt` 一整行 ⇒
  `npm run typecheck` 报 **`TS2741: Property 'prompt' is missing…`**（编译期护栏是**真的**，
  不是「应该有」）；② 某类 `toTools` 返回空（`@Prompt` 不进切片）⇒ **1 条**红；
  ③ `CAPABILITY_KINDS` 改成手写少一类 ⇒ **4 条**红（收集 / 计数 / 切片 / 版本表全塌）。
  还原后 `sha256` 逐字节一致。
- 既有 toolkit 用例 + 全套件全绿 ⇒ **零行为变更**这条是实测的。
  ⚠️ **订正（同日，本行原写「136 条 / 1591 / 195 / 27」）**：那组数字是**加
  `tests/toolkit/capability-slice.test.ts`（+6）之前**的读数 —— 拿它当「含本文件的验证结果」
  不可复现。含本文件在 `main` 上的实测是 **1597 / 195 / 27**（其中 toolkit 套件 **142 条**）。
  教训与 §2 那条同源：**验证节里的计数必须与「这次真的跑过的那棵树」对齐**，否则下一个人
  数一遍就会以为文档在说别的版本（本条只增不改，原句保留）。

**P2 账**：`K2` 从未做 → **已落地**（26 行 = **24 已落地 / 0 未做 / 2 有意为之**）。
⇒ **外部深评 P2 表的 26 行至此全部收口**（P1 表只剩 `C1-附` 那条低危澄清项，
判据与报告一致：`awaitTask({ intervalMs })` 被 `Math.min` 夹到 ≤250ms，溢出不了）。

### 2026-09-29 ④：**时钟回拨（NTP 回拨）下三条时间判据的退化方向**（`DEEP-AUDIT` §3.2 / §3.4 的 L0 补栏）

**背景**：`DEEP-AUDIT-2026-09-28.md` §3.2 / §3.4 那两节（验证手段盘点 / 四层验证策略）此前
从未被动过，`docs/reviews/2026-09-28/README.md` §4 把它记成「质量门禁的下一步来源」——
**那句话是错的，本轮订正**：那两节盘点的是**测试覆盖缺口**，不是**闸门待办**；而「加一道
必需检查」在本仓有硬代价（`scripts/verify-all.sh` 顶部：步骤数写在 CI 的 job 名里，而那个名字
就是分支保护的必需检查）。四栏逐栏判过的结果见 `docs/reviews/2026-09-28/README.md` §4 第 2 条。

**病灶（复核过）**：全仓对回拨**已有一条成文纪律，但它是局部的** —— 只在「算耗时的暴露面」
钳到 0：`engine/turn.ts` 的 `waitedMs = Math.max(0, decidedAt - requestedAt)`、
`engine/tool-events.ts` 的 `durationMs` 非负、`core/timeout.ts` 用 `performance.now` 量耗时。
而**比时刻**的三条纯判定（`approvalExpired` / `timerDue` / `resumeSkipReason` 的新鲜度档）
**一条回拨用例都没有** —— 全仓「回拨」命中 5 处：4 处在注释里、1 处是 `durationMs` 钳零。

**它是三件不同的事**（只看「推迟 / 保鲜期变长」会把最坏那条漏掉）：

- `approvalExpired` 回拨 ⇒ 差值变小 ⇒ **推迟**过期（等人工超时更久）；
- `timerDue` 回拨 ⇒ `wakeAt <= now` 更不成立 ⇒ **推迟**唤醒（睡得比预期久）；
- `resumeSkipReason` 的新鲜度档回拨 ⇒ **唯一一条让系统更不安全的方向**：`too-fresh`
  **持续更久** ⇒ 一个**已经崩掉的主人**留下的记录看起来「还新」⇒ **没人认领 ⇒ 孤儿饿死**
  （`resumePending` 的扫描是**惰性**的，框架不养定时器，启动扫一次就再没人扫）。
  缺口的精确位置：2026-09-28 的 `owner-alive`（同主机直接问 pid）能兜住这条，但它只在
  `alive !== undefined` 时参与 —— **异主机 / 升级前写下的旧格式 ownerId 仍然退回新鲜度**，
  那就是回拨**没有兜底**的角落。

**落地形态（纯测试，零源码改动）**：三条判据各一组用例（共 6 条，见 `docs/guards.md` §1.2
的新行），钉**方向**而不是修法：

- 回拨的退化方向**固定为「推迟」**：不许被「顺手修」翻成「提前自动拒绝 + 重派」（审批）
  或「提前开跑」（定时器，那是真实副作用）；
- `fillTimeoutDenials` **如实记下**回拨：`decidedAt` **可以早于** `requestedAt`，负差值留在
  数据里（下游 `Math.max(0, …)` 本来就兜得住）⇒ **判据层不许钳** —— 钳在这里会让回拨从
  trace 上消失，那次审批看着像「瞬间决定」；
- **不做**单调兜底：三条判据手里只有墙钟，单调兜底要有时钟来源，那是编排层的事 ——
  即下面记为「有意不做」的定时器注入缝。**能力在，只是用例没写**（L0 那 4 个件早已把 `now`
  做成入参），所以这一条的成本近零。

**验证**（6 条 + **5 条变异**逐条亲跑点名，`git checkout --` 还原后 `sha256` 逐字节一致）：

- ① 回拨视为「立即过期」（方向反转）⇒ 打红 **2 条**（两条新用例，既有用例不误伤）；
  ② 判据层把 `decidedAt` 抬到 `requestedAt`（钳掉回拨事实）⇒ **恰好 1 条**红；
  ④ 新鲜度改 `Math.abs(opts.now - since)`（一个很像「顺手修回拨」的写法）⇒ **恰好 1 条**红。
- ⚠️ **如实记两条不独立的**（同 `docs/guards.md` 里 `metrics.test.ts` 那行的教训）：
  ③「回拨即唤醒」**同时**打红既有的「还差 1ms：不叫醒」—— 同一条判据的两个距离量，拆不开，
  故 `timerDue` 那条回拨用例**不构成独立哨兵**；⑤「主人已死也退回新鲜度」同时打红既有的
  `ownerAlive === false ⇒ 立刻可抢` ⇒ 回拨组里「同主机档不受影响」那条 likewise 只是**对照**。
  两条都写进了用例头注：**不冒充两条防线**。

**其余三栏的判定**（不是「欠着」，是**判过了** —— 与 P1 的 `C1-附` 同一种记法）：

- **L2 定时器注入缝（`AsyncRunnerOptions` 上的 `now()` / `timers`）：有意不做。** 三条理由：
  ① **半假时钟比不注入更坏** —— 只盖一半的缝会造出「看着确定性、路上还有真定时器」的用例，
  把 flaky 藏起来还附赠「已经测过」的错觉；② 报告那句「不用改架构」**不成立**：整链可注入是
  一次跨 `AsyncRunner` 的时钟抽象（全仓 `Date.now()` 39 处），不是加个可选参数；
  ③ 判据是**先有病例，再有设备** —— 今天没有一条已知漏测的**缺陷**卡在这里。
- **L3 soak：是「运维化」，不是「门禁化」。** `e2e:soak` 不进 `verify-all` 的定位本来就是对
  （「跑多久」≠「对不对」），真问题是**谁定期真跑**（审计原话：否则它等于不存在）——
  交给定时任务，仓库里不动一行。
- **L1 的推广**：已由抽件红利覆盖（就地倒填见 `resume-policy` / `durable-timer`，配额直构见
  `task-events` / `limits`），不需要新机制。

### 2026-09-29 ⑤：**soak 的错误分类判据改成穷尽表**（`DEEP-AUDIT` §3.2/§3.4 的 L3 第一份真实证据）

**来源与性质**：这是把 2 小时 soak 真跑起来（每周定时任务，见 ④ 的 L3 判定）之后的**第一份
结果** —— 它**红了**，而红的是**判据**，不是被测的代码：

```
AssertionError: 存在未知错误分类：connection
run：total=7189536 failed=325235（4.52%）thrown=0，吞吐 998.5 run/s
端点：requests=8114503 429=162317 截断=162231 400=244141 流内错误=81093 工具路径=600420 正常=6864301
内存：heap 61.6MB → 69.6MB，rss 峰值 204.7MB（27 个采样）
```

**病灶（复核过）**：`e2e-soak.ts` 的断言 ② 里手写着一份三名字白名单 —— `api` / `server` /
`rate_limit`，漏了框架自己的合法类 `connection`（`engine/errors.ts` 的 `classifyError`，
判据是 errno 那组码 + 带 `cause` 的 `TypeError`，**可重试**）。而 soak 自己的**截断注入**
（2%：流写一半掐掉 socket）本来就会产生它。**719 万 run / 811 万请求里只出现 1 次** ——
默认 60s 的跑法永远撞不到，PR 上的 e2e 更撞不到。

所以这不是「代码坏了」，是**手写清单没跟上类型**：与 `KIND_SPEC` / `SUCCESS_STOP_REASON`
同一类形状（两处真源、漏一处静默）。外部审计报告 §3.2 那行照抄了这份白名单，同样是错的
（**报告里的清单也是记数，不是真源**）。

**落地形态（判据单源化 + 「允许」≠「不看」）**：

- `src/engine/errors.ts` 导出 **`ERROR_TYPES`**（`as const`，七类：`aborted` / `rate_limit` /
  `server` / `api` / `timeout` / `connection` / `unknown`）与 `ErrorType`；`classifyError` 的
  返回类型收窄成 `ClassifiedError`。⚠️ **只收窄分类器的输出** —— `SpanError.type` 仍是公共
  类型上的 `string`，收紧它是对使用者的**破坏性变更**，不做。
- 新增 `scripts/soak-error-posture.ts`：`SOAK_ERROR_POSTURE` 是 `Record<ErrorType, 规则>` 的
  **穷尽表**（加一类不表态 ⇒ `TS2741`），**每条必须写 `why`**；`soakErrorVerdict` 对**表外
  一切**判 `hard-red`（宁可响，不可静默放过 —— 包括契约破裂时 push 的 `THROWN:` 前缀）；
  `tallyByType` 供打印。**为什么单独成件**：判据要能被**答案驱动地**单测，而 soak 本体是
  顶层 `await main()` 的脚本 —— 测试里 import 它就是真跑一轮（60s 起步、调参后 2 小时）。
- `e2e-soak.ts` 消费它：`unknown`（分类器失手 —— 这条断言原本要抓的东西）/ `aborted`（这套
  跑法没人取消）/ `timeout`（本地假端点毫秒级应答、适配器也没有默认请求超时）三档 **hard-red**；
  注入的四类 expected，数量仍受 ① 那条**逐笔对账的 slack** 约束（不是「不管」）；
  并把失败的**分类计数打印出来**（`错误分类：api=1068`）—— 那一行正是当初缺的东西。

**验证**（9 条用例 + **6 条变异**逐条亲跑点名，`git checkout --` 还原后 `sha256` 逐字节一致）：

- **编译期两条**：摘掉 `ERROR_TYPES` 的 `connection` ⇒ `typecheck` 报 `TS2322`（处置表里
  于是多出一个键），**并连带**让测试里那条回归钉报 `TS2339`（`Property 'connection' does not
  exist on …`）—— 证明回归钉不是摆设；删掉处置表的 `unknown` ⇒ `TS2741: Property 'unknown'
  is missing…`。
- **运行期四条**：表外放行 ⇒ 恰 1 条红；`unknown` 降成 `expected` ⇒ 恰 1 条红；soak 退回手写
  白名单 ⇒ 恰 1 条红（源码级那条）；`tallyByType` 不排序 ⇒ 恰 1 条红。
- ⚠️ **一条命令教训（第一次跑变异时当场抓到的假绿）**：处置表在 `scripts/`，而**根
  `tsconfig.json` 的 include 里只有 `src`** —— 拿 `npm run typecheck` 验它**照样绿**，
  换成 `npm run typecheck:tests` 才报 `TS2741`。已写进两个文件的头注，并补了一条
  **承重条件用例**（钉住 `tsconfig.tests.json` include `scripts`、根 include 只有 `src`）——
  否则这条护栏可能在某次 tsconfig 调整后**无声消失**。**写错验证命令 = 没有护栏。**
- 短档实测：`SOAK_DURATION_MS=20000 SOAK_CONCURRENCY=16` ⇒ 22624 run 全过，新打印的两行在场
  （分类计数 + 判据清单：`认得 aborted/rate_limit/server/api/timeout/connection/unknown`）。

### 2026-09-29 ⑥：**外部深评施工收口（7 条 + 施工中新发现的第 8 条）+ §7 边界表回填 + 官网注入已知边界表**

**来源与性质**：`FIX-READINESS-2026-09-29.md` 的施工顺序 1–7。该报告的产出本就是「**建议的修法本身
是否成立**」的深验（它自己证伪了三条原建议），本轮把它**落地**，并在施工中**实测发现第 8 条 C5b**。
共同信条延续前几轮：**把静默换成有声；判据要换成真能咬人的那种，而不是看起来更严的那种。**
结构建议②（`async.ts` 抽审批监督簇 + 行数闸）按报告 §8「各自独立 PR」另起，**不在本条目内**。

**四类「静默失效 / 判据失真」的收口**：

- **C5b（施工中新发现）· `NaN` 预算上限静默失效**。闸判据是 `used > max`，而 `x > NaN` 恒 `false`
  ⇒ 传 `NaN` 让闸**整体失效**，方向与「设了上限」相反。`core/limits.ts` 的 `BadValuePolicy` 为此新增
  **第 5 类** `'rejects-nan'`（现有 `throws` / `coerced-to-unlimited` / `none` 表达不了「只拒 `NaN`、
  放行 `0`/负数/`±Infinity`」），`maxTotalTokens` / `maxCostUsd` 改用它；`engine/budget.ts` 加
  `assertNotNaN`（构造期 `RangeError`）。**为什么是构造期**：这是**配置错误**，越早越响；
  运行期才炸等于把「设了个坏上限」拖到第一笔记账。
- **D1 · 容器注入判据**。原判据「值是对象/函数且有 `then`」**误伤** knex / mongoose 的 query builder。
  实证（两家官方源码/文档）：knex `builder-interface-augmenter.js` 的
  `Target.prototype.catch = function(onReject){ return this.then().catch(onReject); }`、mongoose 官方
  API 文档明列 `Query.prototype.catch()` ⇒ 两者 builder **同时带 `then` 与 `catch`**，所以报告原建议的
  「`then` 且 `catch`」加固**方向无效**（照做等于误伤照旧）。改用 **`instanceof Promise`**：async 函数
  语义保证「忘了 `await`」的产物**恒为原生 Promise**，而 thenable builder 不是实例 ⇒ 精确命中、不误伤。
  **如实边界**：跨 realm 的 Promise（vm 上下文产物）`instanceof` 会漏 —— 装配期几乎不出现，写进注释；
  逃逸口 `useValue: { promise }` **保留**（`useValue` 注入裸 Promise 同样是「静默给错东西」）。
- **A1 · 记忆 CAS 的假归因**。水合 `load` 抛错被 `catch {}` 无声吞 ⇒ `memoryRev` 停在 `undefined`，
  几十行后 `saveIfRev(entries, undefined)` 必被 CAS 拒，warn 却把原因说成「并发 run 抢写」。
  修法**收窄**（实证：报告的「水合失败就跳过回写」会打破既有用例 `memory.test.ts:242` 的 plain-save 路径）：
  **只动 CAS 分支** —— `flushMemory` 开头判 `rev === undefined` ⇒ 跳过回写 + 说真话。此处
  `rev === undefined` ⟺ 水合失败，成对性由 `assertMemoryStoreShape` 入口保证；配套在水合 `catch` 处
  加自己的 warn，让**第一因**不再无声。
- **C1 · `RedisLike` 无关闭出口**。`RedisLike` 加 `quit?(): Promise<unknown>`，`RedisTaskStore.close()`
  **幂等**（无 `quit` 则 no-op；重复关闭 / 已断连时的 reject 都吞）。取 `quit` 的理由：三家唯一共名
  （ioredis ✓、node-redis v4 ✓、**v5 有但 deprecated** ⇒ 注释写明后继是 `close()`）。框架仍**不主动**替你调。

**测试与文档面（使用者可见行为零变更）**：**F3** 删 `capability-slice.test.ts` 的恒真断言
（`CAPABILITY_KINDS = Object.keys(KIND_SPEC)` ⇒ 那句是 `x === x`；牙齿是 `:48` 的精确键序 + #184 的 `TS2741`）；
**F2** `AGENTS.md` 补 `capability-cycles.ts` + 新建 `toolkit-map.test.ts`（判据**「露名或显式豁免」**：
「全量穷尽」已实证不可行 —— 13 个文件里 9 个用概念词覆盖）；**AGENTS.md:66** 「910 行的类」→ **1554**（真值，
后续三步未走）；**B1** `task-events.ts` 两处注释订正（`:204` 那句「不会回收刚 push 的这条」是**假的**，
且「改成跳过它」会在单热流下让配额**完全失效** ⇒ 取改注释而非改行为）；**F1** §7 边界表 31 条 `gap` 逐条
回源 ⇒ **7 条转 `pin`**（读数 pin 49→56 / gap 31→24，§7 仍 90 行），三处写死读数同步，`guards.md §2`
登记「`gap` 表需随每轮盘点复核」；**官网** `docs.astro` 构建期从单源 `usage-guide.md?raw` 抠 §7 表注入
新增的 `#limits` 段（缺占位符 / 行数 < 70 硬失败），两处 `/llms-full.txt` 指路改 `#limits` 锚点。

**验证**：**5 条变异**逐条亲跑点名（F2 改名 / C5b 判据失效 / D1 退回 `typeof then` / C1 `quit` 未被调 /
A1 跳过分支失效），各**恰好**打红目标用例，`git checkout --` 还原后全绿；门禁三件套全绿
（`lint` 443 文件零告警）；runtime 56 · engine 404 · container 11 · store 56 · transport 352 · toolkit 142 ·
architecture 57 · limits 32 · boundary-table 6 · 各 docs/官网守卫 全绿。

### 2026-09-29 ⑦：**`AsyncRunner` 的审批监督簇抽成独立件**（结构体检建议②；B.3 复核清单逐条过）

**来源与性质**：外部深评的 `STRUCTURE-INVENTORY-2026-09-29.md` 建议②。这是**零行为变化的
纯结构重构** —— 与它前后的「修缺陷」性质不同，因此判据也不同：验的不是行为，而是**忠实**。

**抽的是什么**：`AsyncRunner` 的审批监督簇 —— 挂起登记簿（`#suspended`，即 `/healthz` 的
`suspended` 读数）+ 在飞审批闸（`#inflightApprovals`）+ `approve` / `#approveInner` + 审批超时
恢复（`#expireAndResume` / `#expireAndResumeInner`）⇒ 新件 `src/transport/approval-supervisor.ts`。
`async.ts` **1929 → 1756 行**（`AsyncRunner` 单类曾 1554 行）。

**为什么能这样切**：逐行核对确认了这簇的**真实跨度** —— 横跨 5 处外部调用点（`cancel` /
`signalTask` / 到期唤醒 / `resumePending` 扫描 / `#executeInner` 的挂起与终态出口）+ 对外 getter，
且派发要经 `#dispatch`（私有方法：停机闸 + 唯一派发口 + 一次性告警）。据此选**注入**而非
`import`：审批簇只**消费** `dispatch` 回调 ⇒ 依赖单向、无模块环。`TaskApproveError` /
`ApprovalDecisions` 随簇迁走，`async.ts` 顶部 re-export ⇒ 导出面与既有 import 路径全不变。

**一处有意的等价简化**：`#redispatch` 的超时扫描原写作 `rec.status !== 'suspended' ||
!approvalExpired(...)`；而 `approvalExpired` 内部已判 `status === 'suspended'` 与
`reason === 'approval'`（见 approval-policy.ts）⇒ 那句短路**冗余**，并入 `expireIfExpired`
不改变任何可观测行为。

**忠实性证据（`guards.md` B.3 的六条逐条过）**：

1. **被搬走的状态没有别的读者** —— grep 确认 `#suspended` / `#inflight` 的**全部**读写点随簇
   迁走；`async.ts` 侧只剩 getter 转调与 4 处调用点。
2. **字符串字面量机械对拍**（多重集，脚本，不靠人眼）：旧 `async.ts` 80 种 / 135 个 vs 新
   （`async.ts` + `approval-supervisor.ts`）81 种 / 142 个 —— **唯一「丢失」的就是上面那处
   有意删除的 `'suspended'` 冗余短路**，其余差异全是两文件各自的 `import` / `re-export` 路径。
3. **没有模块级可变状态被复制成两份** —— 两个 `Map` 各只有一份，都在新件里。
4. **循环 import 的 TDZ 风险** —— 新件不 `import async.ts`（单向依赖），`file-cycles.test.ts` 绿。
5. **注入的值各调用点没传错** —— 构造处 4 个依赖逐一对上（`store` / `ownerId` /
   `approvalTimeoutMs` / `dispatch`），`typecheck` 绿。
6. **旧侧取真实父提交** —— 对拍用 `git show HEAD:src/transport/async.ts`，不是固定基线。

**验证**：3 条变异逐条亲跑（① `expireIfExpired` 恒不触发 ⇒ 恰好 3 条红；② `approve` 的 409 判据
退回只看 `status` ⇒ 恰好 1 条红；③ `rebuild` 的 reason 判据摘掉 ⇒ **全绿 = 既存覆盖缺口**，
已登记 `guards.md §2`），三条 `cp` 还原后 `sha256` 逐字节一致。门禁三件套 + transport 352 /
architecture 57 / toolkit 142 / runtime 56 / engine 404 / container 11 / store 56 —— 全绿。

**随之而变的守卫**：`tests/transport/dispatch-guard.test.ts` 的 `#dispatch(` 调用点下限**射程扩到
两个文件**（两条恢复路径的派发点形如 `this.#deps.dispatch(`）。⚠️ 该守卫在本次改动中**先红了**
（这是它的职责）—— 修法是**扩射程**而不是放宽下限，因为「路径总数」这一事实没变。

**有意不做**：`async.ts` 的**行数上限闸**（结构体检建议③）。「超多少行算超」是**口径**问题：
定低了会误伤本仓大量合法的长穷尽表 / 表格文件，定高了等于没定 —— 而 `guards.md §3` 第 1 条
纪律是「宁可窄，不要误报」。⇒ 先把形状登记进 §2，并给出与行数解耦的替代判据（钉「职责数」，
或沿用 `dispatch-guard` 的调用点计数形状）。


### 2026-09-29 ⑧：**`AsyncRunner` 再抽两簇**（信号投递 / 恢复扫描）+ **源码体量闸**（结构体检建议③ / ④）

**来源与性质**：外部深评的 `STRUCTURE-INVENTORY-2026-09-29.md` 建议③（行数闸）+ §6（剩余两簇）。
与 ⑦ 同性质：**零行为变化的纯结构重构**，判据是**忠实**而非行为。

**抽了两簇**（⑦ 抽走审批簇后 `async.ts` 仍有 1756 行，这两簇是报告 §6 点名的「抽掉后方向最正交」
的剩余两块）：

- `src/transport/signal-supervisor.ts`（`SignalSupervisor`，182 行 / 74 含代码行）—— `signalTask` /
  `#signalInner` / 在飞信号闸 + `TaskEventError` + 两个上限常量。**为什么它和 `approve` 同族**：都是
  「挂起任务的外部唤醒入口」，形状逐条对应（读记录 → 校验挂起 → 改状态 → 先落库再派发 →
  `unmarkSuspended` → `dispatch`）；**两处真实差异**：① 并发闸不同款（`approve` 共享在飞那次；事件
  **串行成链** —— 后一条链到前一条尾巴上）；② 多一道容量闸（`MAX_PENDING_EVENTS` 64，到上限 409，
  不静默丢）。
- `src/transport/resume-scanner.ts`（`ResumeScanner`，261 行 / 126 含代码行）—— `resumePending` /
  `#redispatch` / `#ownerLiveness` / `wakeDue` / `#wakeDueInner` + 两把在飞闸。**一次扫描按序干四件
  事**（顺序有语义）：① `approvals.rebuild` ② `approvals.expireIfExpired` ③ `wakeDue`
  ④ `#redispatch` 认领重投。`wakeDue` 从私有改**公开**（两个调用点：`#redispatch` 与
  `async.ts.#lazyGates`）。

**依赖怎么解**：两个监督件都只**消费** `AsyncRunner.#dispatch`（停机闸 + 唯一派发口 + 一次性告警）
⇒ 构造注入回调，保持依赖单向（监督件 → 派发），无模块环。`TaskEventError` / `ResumePendingOptions`
随簇迁走 + `async.ts` 顶部 re-export ⇒ 导出面与既有 import 路径全不变。
**`async.ts` 1756 → 1460 行 / 664 含代码行**。

**新增守卫（建议③）**：`tests/architecture/source-size.test.ts` —— `src/**` 单文件**含代码行** ≤ 750。

**口径分歧是有意的，写在测试头注里**：报告写「`async.ts ≤ 1600` **行**」。本仓注释占 29~55%
（`async.ts` 55%）、注释是证据载体 ⇒ 按**行数**设闸的第一个作用是**逼人删注释**（静默、删的是最贵
资产），且按行数 `1460 < 1600` 当下**根本不触发**（事后不疼）。⇒ 与注释解耦 = 只计「含代码行」
（整行注释与空行不计入）。**上限由来**：`async.ts` 664 与第二名 `turn.ts` 521 之间隔着 143 行 ⇒
750 落在这段空档，留约 13% 余量、远离合法长文件那一档（报告 §2 那批「不该拆」的最长 260 行代码）。
**刻意不用「剥注释再数非空行」**：本仓多处 URL 字面量（`'https://…'`）与含 `//` 的字符串会被朴素
剥离**吃掉真实代码行** ⇒ 读数偏低 ⇒ 闸静默失效。⇒ 这正是 ⑦「有意不做」那条的正解：**不是调阈值、
而是换口径**。

**忠实性证据（`guards.md` B.3 的六条逐条过）**：

1. **被搬走的状态没有别的读者** —— grep 确认信号闸 / 扫描在飞闸的全部读写点随簇迁走。
2. **字符串字面量机械对拍**（可复跑探针 `.workbuddy/probes/literal-multiset-diff.mjs`；⚠️ 必须用
   **逐字符状态机**剥注释 —— 裸正则会抓走注释里成对的 markdown 反引号，第一版据此把读数虚高到
   316 种）：旧（base 的 `async.ts` + `approval-supervisor.ts`）**81 种 / 142 个** vs 新（四文件）
   **83 种 / 154 个** —— **丢失 0 项**，新增 6 项**全是 import 路径**（`'../core/run.js'` /
   `'../store/store.js'` / `'./approval-supervisor.js'` / `'./signal-supervisor.js'` /
   `'./resume-scanner.js'` / `'./wake-policy.js'`）。
3. **没有模块级可变状态被复制成两份**。
4. **循环 import 的 TDZ 风险** —— 新件不 `import async.ts`（单向依赖），`file-cycles.test.ts` 绿。
5. **注入的值各调用点没传错** —— 构造处逐个对上，`typecheck` 绿。
6. **旧侧取真实父提交** —— 对拍用 `git show 0578769:src/transport/async.ts`（= ⑦ 的提交，本轮 base）。

**验证**：5 条变异逐条亲跑（① `wakeDue` 的 drain 闸失效 ⇒ 恰 2 条红；② 认领后异步派发摘掉 ⇒
恰 3 条红；③ 串行闸摘掉 ⇒ **全绿 = 既存覆盖缺口**，已补 `task-events-input.test.ts` 一条并发串行
用例；④ 容量闸失效 ⇒ 恰 3 条红；⑤ 补用例后重跑 ③ ⇒ **恰好那条新用例红**），全部 `cp` 还原后
`sha256` 逐字节一致。门禁三件套 + 套件：transport 353 / architecture 57 / toolkit 142 / runtime 55 /
engine 403 / container 10 / store 55 —— 全绿。

**随之而变的守卫**：`tests/transport/dispatch-guard.test.ts` 的 `#dispatch(` 调用点射程**扩到四个
文件**，并钉每个监督件的**精确数**（approval 2 / signal 1 / scanner 3）。⚠️ 与 ⑦ 同款：搬件会让它
先掉一格判红 —— 修法是**扩射程**、不是放宽下限（「路径总数」这一事实没变）。

**闭环**：`guards.md §2` 那条「`async.ts` 没有行数上限闸」划掉、移入 §1.1（建议③闭环）。
`AGENTS.md` 的 `transport/` 段补登记三个监督件 + 订正那句过时的「910 行的类 / 后续抽块三步一步没走」。
### 2026-09-29 ⑨：**文档围栏代码块真编译**（竞评收官：换尺子 —— 从「缺什么」改成「哪些承诺是假的」）

**来源与性质**：产品竞争力评审走到「**说不出还有什么缺口**」时换的尺子。前几轮一直在用
「通用 agent 框架坐标系」找缺口，而本仓在 `docs/spec.md`（4 处「只给缝、不给策略」）、
`docs/roadmap.md:281`（「不是待修项」）、`docs/usage-guide.md:540`（唯一判别规则）里**主动划走**了
通用坐标系里的高分项 ⇒ 继续挖只会把它们自己选的 trade-off 报成缺陷（已连犯三次并撤回）。

⇒ 改问一个**能被机械复算**的问题：**已经写下来的东西，是不是真的**。取样对象取「对外承诺面里
最硬的一层」——**代码围栏块**（形容词 < 表格 < 代码块：读者会**逐字照抄**），理由是它**恰好不在
既有守卫面上**：`usage-guide.test.ts` 只收「首列恰好是一个反引号标识符」的**表格行**，
`run-output-shape.test.ts` 只钉 `.finalText` **一种形状**。

**读数**（取样面 = `README*` / `usage-guide` / `observability` / `eval-gate` / `roadmap` /
`examples/*/README`；**排除** `docs/plans|reviews|articles`，那些是当日快照）：

| 量 | 值 |
|---|---|
| 围栏块总数 / ts 块 | 88 / 49 |
| **含 `@migor/agentia` 具名导入**（=「照抄可跑」候选） | **22** |
| 文档 import 的名字 vs `src/index.ts` 导出 | **0 条不符**（48 个名字全命中，API 面是干净的） |
| 真编译 | **18 通过 / 3 不过** |

**修掉的三条**（都不是新引入的 —— 是**从未被检查过**）：

1. `README.md` 的 `scheduler.every(60_000, '巡检一次', { idempotencyKey: 'patrol' })` ——
   `ScheduleEveryOptions` 里**没有**这个键（真名 `idempotencyPrefix`，`src/transport/scheduler.ts`）。
   TS 报 `TS2353`；**JS 用户静默无幂等**（`every()` 读的是 `opts.idempotencyPrefix` ⇒ `undefined`），
   而示例上方那句注释正写着「幂等键去重」。⚠️ **同一块上一行**的
   `runner.submit(…, { idempotencyKey })` 是**对的** —— 两个同名旋钮，一个在一个不在。
   为什么从没被发现：`ScheduleEveryOptions` 在 `usage-guide.md` 里 **0 命中** ⇒ 表格守卫与
   **反向穷尽**守卫都够不到它。
2. `docs/usage-guide.md` 的 `ctx!.deferUntil(due)` —— `ToolRunContext.deferUntil` 是**可选成员**，
   `!` 只消掉了 `ctx` 的 null ⇒ `TS2722`。改成 `ctx?.deferUntil?.(due)`。
3. `docs/usage-guide.md` 的**出站传播片段**是**裸方法**（`@Tool` 挂在函数声明上、且漏了必填的
   `schema`）—— 根本不是合法 TS。补成完整的 `class OrderTools { … }`。这条不是「编译报错」，
   而是**语法不自洽 ⇒ 无法被任何编译器检查**（见下）。

**新增守卫**：`tests/docs/code-fences.test.ts` —— 把 22 个块落成文件、**一次性交给 `tsc`**
（`paths` 指向 `src/`，**不依赖先 build**；单跑约 0.3s）。三条反假阳性机制**缺一不可**：

- **语法错会连坐**：实测 `tsc 7`（tsgo）**只要程序里存在语法错误就整体跳过语义阶段** ——
  不处理时 22 个块**只报 3 条语法错**、`TS2353` / `TS2722` 一条都不报 ⇒ 守卫会变成**静默全绿**
  （第一版探针就是这么被骗的）。⇒ 迭代把语法错的文件摘出 `files`，并**断言摘掉的块数为 0**。
- **省略垫片**：把「名字不存在」类（TS2304 / 2552 / 2584 / 2591 / TS18004 简写属性）收成
  `declare const X: any` 再跑 —— 垫片吃得掉「名字不存在」、**吃不掉「类型形状不对」**。
- **省略记号归一**：三种省略写法（花括号 / 方括号 / 块注释形态）归一成**展开 any** 而**不是**
  空容器 —— 后者会因缺必填项造出**守卫自己的假阳性**（`createApp({ ... })` ⇒ 归一成 `{}` 会报缺 `system`）。
- 另两条**自证**（防「守卫悄悄什么都没检查」）：**金丝雀**（程序里固定塞一个故意写错的块，
  断言 `TS2353` **必须**被报出来）+ **取样下限 20**。

**验证（4 条变异，各恰好点名那条；还原后 `sha256` 逐字节一致）**：① `README` 键名改回
`idempotencyKey` ⇒ 报 `README.md:191（块内第 13 行） TS2353`；② `ctx!.deferUntil(due)` 改回 ⇒
报 `usage-guide.md:1547（块内第 10 行） TS2722`；③ 出站片段改回裸方法 ⇒ 报 `usage-guide.md:871`
（语法不自洽）；④ 金丝雀改成对的（模拟编译链静默退化）⇒ 金丝雀那条断言红（`实际诊断：[]`）。

**如实记两处边界**：① 取样面**只到「含具名导入」的块**（无导入的片段不可判定，不硬判）；
② 垫片的存在意味着**引用了被省略名字的表达式不在射程**（如 `app.run(messages)` 的签名不会被查）。

**明确不算缺口的一条（留痕）**：`usage-guide.md` 里 `from '@migor/agentia-observability'` 的那两块
首次对拍报 `TS2307`，但它**是按设计的配方** —— `docs/observability.md` 已明写「`npm i` 会 404，
这是本地小包（`file:` 引入）」，且 `examples/observability/src/index.ts` 真有那些导出
（守卫也照 `tsconfig.tests.json` 的 `paths` 映射过去，不再误报）。评审里另有两条同款被撤回，
一并记在报告里。

**影响面**：`README.md`（1 行）、`docs/usage-guide.md`（2 处：1 行断言 + 1 个片段补全）、
`docs/observability.md`（1 行腐烂读数订正，见下）、`tests/docs/code-fences.test.ts`（新）、
`docs/guards.md` §1.4（登记 + 反向验证）。**框架代码零改动**。

**顺带订正的腐烂读数**：`docs/observability.md` 的日志层那格原写「2026-09-15 实测 9 处
`console.error/warn`」，2026-09-29 实测 **22 处（散在 12 个文件）** ⇒ 不再写死数字，改为
**给现数命令** `grep -rn "console\." src/`（与本仓其它「易腐数字给命令」的口径一致）。

### 2026-09-29 ⑩：**补上「完整装配 × 时间维度」这一格**（`e2e-soak-app`）+ `examples` 清单守卫

**触发**：竞争力评审走到「说不出还有什么缺口」之后，下一句是「没有一个基于框架的复杂 demo
长期运行验证」。先按本仓纪律做**「有意为之」筛**（把候选对象名逐个 grep `有意` / `不是待修项` /
`刻意不`）：`roadmap.md` 只有「示例真跑纳入门禁 ✅（2026-09-14）」一节（讲的是**跑一轮**），
`docs/plans/2026-09-27-durable-execution-research.md` §7 的「明确的『不做』」讲的是
**不引 Temporal / Restate 那类独立服务端** —— 与本条**无关**。⇒ 它**不是被划走的，是没被想到**。

**核查结论（一半对，而修正的那半更锋利）**：长期运行验证**有**、完整装配的 demo 也**有**，
但两者的**射程不重叠** ——

| 脚本 | 装配面 | 时间维度 |
|---|---|---|
| `scripts/e2e-soak.ts`（411 行） | **单点** `runAgent`（import 面只有 `createOpenAIClient` / `metricsSink` / `runAgent` / `AgentTool`） | ✅ 默认 60s、可到 2h；2h 档实测 811 万请求 |
| `scripts/e2e-examples.ts`（677 行，CI 每 PR） | ✅ **完整装配**（`examples/complete`：createApp + 四类能力 + 三触发 + `SqliteTaskStore` + `AsyncRunner` + `resumePending` + `Scheduler` + 鉴权 + 优雅停机） | ❌ **只跑一轮**（线性脚本，无时间循环、无故障注入） |

⇒ **「完整装配 × 时间维度」的交集为空**。而这一格空着能抓住的是**它自己承认过的洞**
（同设计稿 §6⑦：「到期检索的扩展性：每条 pending 都读一遍是 O(挂起数)，**天级挂起积攒起来
之后**每次重启/每轮扫描都要全表读」）—— 这类病**只有长时间跑才现形**。

**为什么先复用 `examples/complete` 而不是造新 demo**：本仓自己的判据是「**先有病例，再有设备**」
（见 `CHANGELOG.md` 里 2026-09-29 那条）。且 `complete` 的 `main.ts:38/64-69` **已支持
`OPENAI_BASE_URL`** ⇒ 外挂假端点**零改动**（`examples/` 一行没动）。压出病例之后，再决定要不要
专门造一个「为长期运行而生」的 demo。

**落地**：`scripts/e2e-soak-app.ts`（**黑盒**：只走 HTTP + 子进程，不 import 框架）
+ `npm run e2e:soak:app`。起 `examples/complete` 的 dist（symlink 到仓库根 ⇒ 用的是**当前** dist，
不是 npm 快照）+ 本地假 OpenAI 端点；中途用假端点**闸门**（沿 `e2e-deploy.ts` 的手法）把任务
精确停在 running 再 SIGKILL。七条断言与 6 条反向验证见 `docs/guards.md` §1.4 那一行。

**读数**（30s × 6 并发）：4452 个任务**全部终态**（succeeded=4286 / failed=166）、**零 stuck**、
幂等簿记准、猝死续跑 5 个且都跑完、故障对账 **335 vs 336**、DB 39.1MB（≈ 9.0KB/任务）、
SIGTERM 干净退出。8s 短档**重复跑 3 次**同样全绿。

**⚠️ 一条比判据更值得记的事：变异验证全过，也不等于断言可靠。** 初次落盘时 5 条变异全部
「各恰好点名那条」，看着已经够扎实；但其中 ③（闸门任务续跑后必须 `succeeded`）是**概率性**的
—— 续跑那次模型调用仍走故障注入，3% 的不可重试 400 抽中就假红（30s 首跑的绿是运气），
**8s 档重复跑**时才抓到。⇒ 修法是给假端点加 `pauseFaults()` / `resumeFaults()`，**只**在
「等闸门任务跑完」那一小段关掉注入（判的是**恢复**，不是运气），并补一条**自证**：窗口之后
注入数必须高于窗口前读数，否则「忘了重开」会让阶段 B 静默变成无故障负载而前面断言全绿。
阶段 A / B 的几千个请求照旧吃满注入、由 ④ 对账 —— **注入机制的存活性没有因此放松**。

**两条判据上的新认识**（依据不同，**别混写**）：
① **装配层里「一个不可重试故障恰好杀死一个 run」不成立** —— 依据是**代码语义**，不是从「对账已经很接近」那个读数
反推的：子能力（子 agent / skill）的失败由能力层包成 `is_error` 的 tool_result 回主
循环、**不杀 run**（`src/engine/loop.ts` 与 `src/engine/spec.ts` 都明写了这条语义），而本例装配里
**真有**子 agent 与 skill、假端点服务的又是**所有**模型调用 ⇒ 打进子流程的 400 不必然变成一次 run
失败；再加上猝死窗口内被中断、随后续跑成功的任务会把那次失败从终态里洗掉。实测 335 vs 336 已很
接近，但**接近不等于恒等** —— 它本来就没有恒等式保证 ⇒ 本脚本量**量级**、不量逐笔。
② **故障注入是按请求的，而负载有两种** ⇒ 统计必须**两边都算**：这条是**实测**出来的 —— 首跑只
对账异步任务得出 129 vs 267，看着像「故障被静默吞」，实际是同步 `/run` 的失败没进账。

**顺带修的腐烂读数**：`examples/README.md` 那张表此前**零守卫**，已烂成三个互不相同的读数
（文案「四个示例」/ 表 5 行 / 目录 6 个，`eval-gate` 缺席；依赖说明那句「三个应用示例」也错，
六个**全部**用 `file:../..`）。⇒ 修表（**不写死数字**）+ 新守卫
`tests/docs/examples-table.test.ts`（表 ↔ 目录双向相等 + 链接指向真实目录 + 密度下限），
反向验证 2 条（删 `eval-gate` 行 / 加幽灵目录行），各恰好点名那条。

**⚠️ 一个已知边界（如实记）**：本脚本与 `e2e-soak` 同档，**没有并进 `verify-all`**
（它是「跑多久」而不是「对不对」的验证，默认 30s 已明显偏慢）⇒ 它靠**手跑**。
「要不要进 CI（短档）」留作开放项。

### 2026-09-29 ⑬：**README 顶部的「实测记分牌」**（数字一律脚本现算，不许手写）

**触发**：「上生产 × 推广」评审的 `P0-2`。它引用的外部判据是：「**GitHub star bias** —— 为了 50 行
能解决的问题上一个重型多层框架」是当下最大的选型陷阱（`coderlegion.com/27481` 评论区）。
本仓的答案恰好是那个陷阱的反面：**1 个包 / 0 运行时依赖 / ≈2 MB**。而实测
`grep -nE "2\.7|1 个包" README.md` ⇒ **0 命中** —— README 里只有形容词「零依赖」。
⇒ **形容词不参与比较，数字才参与。**

**落地**：`README.md` + `README.en.md` 的品牌句之后各加一行记分牌，并新增
`tests/docs/scoreboard.test.ts`（登记在 `docs/guards.md` §1.4）。评审原文要求「必须脚本现算，
不许手写」—— 本守卫现场算三个数，再断言 README 写的就是那个值。

**先定口径，再写数（这一步比写数字更重要）**：评审里那个「2.7 MB」量的是
`du -sh node_modules`（含文件系统块分配，333 个文件每个至少占一块），而 npm 页上给使用者看的是
`dist.unpackedSize`（`npm pack --dry-run --json` 现算 = **2.10 MB**）。两者差 ~30% ⇒
数字落纸之前必须先选口径，否则记分牌自己就是一句**不可比**的假话。

**三条口径（每条都是为了「守卫不被绕开」）**：

1. **「会涨的数」用下限**：`90+ 条守卫` + 断言 `count >= 90`。写成精确值的话，每次加一条守卫都要改
   README —— 那种税会让人绕开守卫；下限可机械复算，且只在**掉下来**时咬人（那才是信号）。
2. **体积按「四舍五入到整数 MB」判定**：让数字**自带精度**。`≈2 MB` 覆盖 1.5–2.5 MB；
   写 `2.1 MB` 会因几十 KB 的正常增长而红 —— 那不是信号，是噪声。
3. **不把 `usage-guide §7` 的边界条数搬上来**：那个数已有专属守卫（`boundary-table.test.ts`
   的行集合对拍 + 三处读数断言）。再放一份 = 造**第二个会腐烂的副本**，且两处口径必然分叉
   （§7 首列是散文，归一化规则只为那张表定义）。⇒ **记分牌只放「不重复且能现算」的数。**

**代价如实标注**：`npm pack --dry-run --json` 在本机约 **11s**（`user` 只占 ~2s ⇒ I/O 为主；
`--offline` 与关 update-notifier 都压不动）⇒ 守卫里**记忆化**，整轮只真跑一次。
**不用自己遍历 `dist` 把字节加起来**：实测 2.08 MB vs npm 2.10 MB（差 ~1.5%，npm 还会捎上
package.json / README / LICENSE），而复刻 npm 的选文件规则（`files` 与 `.npmignore` 的交互）
是**会静默失准**的事 —— 权威值只留一个来源。

**如实标注的射程**：守卫只钉**这几个数字的对外一致性**，不评价记分牌该不该放、措辞好不好。
它防的是「数字腐烂」，不是「排版不好」。
### 2026-09-29 ⑫：**CI 的 Node 覆盖跟到当前 LTS**（上沿停在 22）+ 发版流程进 CONTRIBUTING

**触发**：「上生产 × 推广」评审的 `A2` 条 —— **CI 的 Node 上沿停在 22，而当前 LTS 是 24**
（`nodejs.org/dist/index.json` 现查）。四处散文（`README.md` / `README.en.md` / `CONTRIBUTING.md` /
`docs/usage-guide.md` §7 已知边界表）都写着「CI 在 18/20/22 上守」：**那句话当时是真的**，
两个问题分别是 ① 上沿没跟 LTS 走；② **没有任何东西盯着这四处** —— 矩阵一改它们就静默腐烂
（与 `docs/guards.md` 头注那条「约定写在文档里、没有门禁」同一形态）。

**为什么「跑下限」与「跟上沿」刻意分成两件事**：`import-floor` 的 **matrix 取值会进必需检查名**
（2026-09-29 实测分支保护里钉的是「导入下限（Node 18）」与「（Node 20）」）⇒ 往 matrix 里加 24
会**新增一条不是必需检查的检查**、删掉 18 则**让保护里那条永远等不到**——两者都要同时改仓库的
分支保护配置（`repos/*/branches/main/protection`）。因此本轮**只动四个主 job 的 `node-version`**
（不动 job name、不动 matrix、不动分支保护），覆盖集合由「matrix ∪ 主 job 版本」定义，
并按这条规则写进 `ci.yml` 顶部。

**落地**：`ci.yml` 四个主 job `'22'` → `'24'`（`verify` / `lint` / `e2e-mcp` / `deploy-website`）
+ 顶部写清覆盖规则与「matrix 取值进必需检查名」这条坑；四处散文同步为 **18 / 20 / 24**；
`scripts/check-import-floor.mjs` 头注里那句「CI 只跑 Node 22」订正为「主 job 只跑**一个**版本」；
`CONTRIBUTING.md` 新增「**发版流程**」一节（此前 `grep -niE "release|发布流程|version" CONTRIBUTING.md`
⇒ **0 命中**）。

**`--provenance` 为什么这轮不做**：`npm publish --provenance` 要求**在 CI 里**用 OIDC 生成，
而本仓的发布目前是**本机手动两条命令**（不是 CI 工作流）⇒ 要做就得新增一个发布工作流 + 一个仓库
secret，那是**仓库所有者的运维决定**（且会改动 `release.mjs` 头注里那条「发布 → 合并 → 打 tag」
的顺序论证）。⇒ **如实留作独立议题**，不假装做了。

**守卫**：`tests/docs/stability.test.ts`（2026-09-29 ⑪ 建的）里的「CI 版本集合相等」那条
**正好为这次改动准备**：它从 `ci.yml` 抽实际集合、与三处散文对拍 ⇒ 本轮如果只改了 ci.yml 而漏改
任何一处散文，`npm test` 会当场红。本轮同时把它的**射程扩到 `docs/usage-guide.md`**（复述面），
并改成「逐行收集全部命中、要求互相一致」——只取第一个匹配会在复述处先说漏嘴时静默放行。
### 2026-09-29 ⑪：**把「对外承诺」变成可执行的守卫**（版本稳定性策略 / 附属包交付口径 / CI 运行环境）

**触发**：换到「**作为一个要上生产、要推广的成熟项目**还差什么」这个视角做评审。结论是一句
反直觉的话：**竞品文档里那套「生产部署四件事」（检查点耐久 / 错误处理 / 可观测 / 资源上限）
本仓四件全有实现** ⇒ **能力面不缺，缺的是认知面**。缺的那一面里，最容易补、也最容易腐烂的
是**已经写下来的对外承诺**（本仓的常见病：写进文档、没有门禁）。

**先做「有意为之」筛，清掉三条误报**（同一个缺口本轮之前已被报过**三次**）：
`@migor/trace-view` / `@migor/agentia-observability` / `@migor/agentia-eval-gate`
**三个都不发布到 registry** —— 三个 `package.json` 都是 `"private": true`，**这是机制**。
文档侧已有痕迹：`roadmap.md`「`private: true` 是**有意**的（产物随 CLI `create` 拷进用户项目，
不进 npm），**不是待修项**」、`docs/observability.md` §2「`npm i` 会 404，它是本地小包」、
`eval-gate/README.md`「这是**宿主的发布流程**，框架不内建 ⇒ 可拷走的实现」。
⇒ **正确动作不是「发布它们」**（那会改变「只给缝、不给策略」的定位），而是**把口径补齐并钉住**。

**本轮实测出的口径不对称**：三支里只有 observability 那一支把「**怎么拿到它**」写进了自己的
入口文档；`examples/eval-gate/README.md` 只写了「可拷走的实现，不是一个新 API」，既没说 404、
也没给拷贝路径（`docs/eval-gate.md` 同）；`examples/observability/README.md` 只说了「沿用
`trace-view` 的同一套办法」，没在自己的文档里复述 404。⇒ 补齐三处，并把「**不发 npm**」与
「**怎么拿到**」这两件事变成**每条都要断言**的守卫。

**另一个零守卫面：CI 的 Node 覆盖范围**。它写在 `ci.yml` 的 matrix + 各 job 的 `node-version`，
又被**四份文档**的散文复述（`README.md` / `README.en.md` / `CONTRIBUTING.md`，以及权威文档
`docs/usage-guide.md` §7 已知边界表里那句「CI 在 18/20/22 上守」）。2026-09-29 实测**那句话是
真的**，但**没有任何东西盯着它** ⇒ 矩阵一改，那四处立刻变成假话且零信号。⇒ 守卫改为：从 `ci.yml`
**抽**实际集合，与四份文档里那串版本号**集合相等**，并断言 `engines.node` 的下限**真在 CI 里被
跑到**（「声明支持」与「验证过」不能是两回事）。这条守卫先于 P0-3 落地，所以「CI 加 Node 24 +
收紧 engines」那天它会**当场咬人**，而不是等人记得改那四处复述。
⚠️ `usage-guide.md` 是**后来扩进来的射程**：原本只查三处「面向 npm 读者」的面，扩到权威文档是
**扩展**不是收紧 —— 扩了射程就补一次变异（改它的复述处为 `18/20/21` ⇒ 恰好红那条），
否则新加的那一格是**没证据**的。

**落地**：`README.md` 新增「稳定性与版本策略」节（0.x 的变更策略 + 承诺范围四行表 + 1.0 的三条
门槛）、`README.en.md` 对应节、官网 docs 页新增 `id="versioning"` 一节（含侧栏锚点），
三处**刻意各写一份**——理由写在守卫头注里：README 是 npm 页的第一阅读面，站点读者也不该跳去
GitHub；**代价（可能各说各话）由守卫兜底**，断言三面出现同一组承诺锚点与同三条门槛。
外加 `examples/eval-gate/README.md`、`docs/eval-gate.md`、`examples/observability/README.md`
的「怎么拿到它」段。

**没有写死的数字，而命令本身也被守卫自证**：稳定性一节**刻意不写**「N 个版本里只有 M 个带
迁移小节」这类读数 —— 本仓为写死的读数吃过多次教训（改对一次不够，去掉比追着改省）。改为给
**现数命令** `grep -nE '^#{3,4} .*(迁移|破坏性)' CHANGELOG.md`，并把「**那条命令必须真跑得出
结果**」也钉成一条断言（给一条零命中的命令，效果与写错数字一样 —— 本仓的旧账里最贵的一类就是
**静默零命中**，见 `guards.md` 头注那条 BSD `grep` 的坑）。

⚠️ **落地前回源核对抓到一处真错（记下来，因为它是上一条断言的由来）**：初稿写的是
「**没有「迁移」小节的版本，就是不需要你改代码的版本**」，配 `grep -nE '^#{3,4} .*迁移'` ——
**这句话是假的**。同一个意思在 `CHANGELOG.md` 里历史上有**三种形态**：① `### 迁移` 小节；
② `### 破坏性变更 · …` 小节（`0.9.0` 的脚手架模板变更，标题不含「迁移」二字）；
③ **行内** `**迁移**：无（…）` 一段（`0.8.1`~`0.8.3`）。只认 ① 的命令会**漏掉 `0.9.0`**
（它**真的有破坏性变更**），也会漏掉 `0.8.2` 那句「唯一需要动作的是 `maxRetries`」。
⇒ 口径改成「**至少要有一段专门写它**」+ **如实标注**「这条纪律是逐步收紧的、那条命令是**下限**
而非全集」。**教训**：`grep` 的形态假设与「有没有命中」都要当场验 —— 与 `guards.md` 的
「变异之后还要重复跑」同族。

**守卫**：`tests/docs/stability.test.ts`（四类判据 + 5 条反向验证 + 两条教训）登记在
`docs/guards.md` §1.4。⚠️ 反向验证 ④ 是**先做错了一次才做对**的：第一版只删掉「会 404」那一句，
**全绿** —— 因为同一件事在那一节里出现不止一次（「不发布的包」/「别 `npm i`」）⇒
**变异要摘干净**，否则测的是「这个词还在不在」而不是「这件事还说没说」。

**影响面**：`README.md`、`README.en.md`、`packages/website/src/fragments/docs.html`、
`examples/{eval-gate,observability}/README.md`、`docs/eval-gate.md`、`tests/docs/stability.test.ts`（新）、
`docs/guards.md` §1.4（登记）。**框架代码零改动、使用者可见行为零变更。**

### 2026-09-29 ⑭：**给两个已发布的包加 `exports`** —— 把「不承诺深路径导入」从文档承诺变成机制

**触发**：「上生产 × 推广」评审的 `P2-2`（报告原文判据：`npm pkg get exports` 非空且含 `types`）。

**问题不是「用不了」，是「承诺与机制不一致」**：2026-09-29 实测
`import('@migor/agentia/dist/index.js')` **真的能进**、`require('@migor/agentia')` 拿到 **81 个导出**
—— 而 ⑪ 那轮刚把「**不**承诺深路径导入（`dist/**`）」写进 README / README.en / 官网三面的
承诺范围表。⇒ 一句**没有门禁的对外承诺**：任何人都可以把内部模块路径当 API，一次重构把他打碎，
**零信号**。这是本仓反复记的同一形态（`guards.md` 头注）。

**为什么这不是「加个字段」那么简单**（三处判断，都写进了守卫头注）：

1. **`@migor/agentia` 用 `default` 而不是 `import`/`require` 两条**：本包**只有 ESM 一种产物**，
   写两条等于宣称有 CJS 构建。`default` 同时接住两者（`require` 靠 Node 的 `require(esm)`）⇒
   **行为与改动前逐字一致**（Node 18 上照样 `ERR_REQUIRE_ESM`）——「加边界」不该顺手改运行时语义。
2. **`@migor/cli` 只放开 `"./package.json"`**：它的公共面是**可执行文件**，入口
   `packages/cli/src/cli.ts` 末尾是 `process.exitCode = main(process.argv.slice(2))` ——
   **顶层副作用、没有 main 守卫** ⇒ 给它 `"."` 等于承诺「import 这个包会直接跑 CLI」。
   宁可封得比「有人可能想用」更紧：**公共面是 bin 就说 bin**。
3. **`"./package.json"` 必须留**：封深路径最常见的误伤是让工具（打包器 / 类型解析器 / 脚本）
   连清单都读不到 ⇒ 那句「封住了」会变成「整包不可读」。留 manifest 是**刻意的例外**。

**落地**：两个 `package.json` + 新增 `tests/architecture/package-exports.test.ts`（四类判据，
登记 `docs/guards.md` §1.4）+ README / README.en / 官网三面的承诺表补一句「这条边界由 `exports`
封着」。**破坏性变更按本仓纪律走了「迁移」小节**（见 CHANGELOG ⑭）—— 这算是那条稳定性纪律上线后
**第一次真被自己的改动用到**。

**守卫的两层：文本 + 行为**。①②③ 是文本判据（声明在不在、`types` 排没排第一、子路径集合），
④ 是**真解析**：自建临时夹具（真 manifest 的逐字拷贝 + 占位文件）用 `require.resolve` 跑一遍
Node 的解析算法 —— 根入口/manifest 进得去、深路径必须报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
**为什么必须有 ④**：`exports` 的错法有一半是**形态对、指向错**（条件顺序、少 `./`、键名拼错），
文本断言全看不见，而它们只在真解析时现形 —— 与 `scripts/e2e-cli.ts` 第 9 步那条「真 pack →
真装 → 真跑」是同一条教训。⚠️ 夹具**刻意不用符号链接指向仓库**：那会让用例依赖 `dist/` 已构建
（没 build 的机器上会红成「守卫坏了」），且批量删会被环境的安全删除垫片按文件数拦下（本仓踩过）。

**反向验证 5 条（各恰好点名，还原后哈希逐字节一致）**：摘掉根包 `exports` ⇒ 四条全红；
`types` 挪到 `default` 之后 ⇒ 只红「types 排第一」；加一条 `"./dist/*"` ⇒ 红「不开放子路径」+「真解析」；
CLI 摘掉 `./package.json` ⇒ 红 ①③④；`default` 指到别的文件 ⇒ 红 ②④。

**实测（真发布形态）**：真 pack 两包 → `--offline` 装进空项目 → 真跑 ⇒ `import`/`require` 根入口
各 **81 个导出**（与改动前**同数**，导出面零变化）；`require.resolve` 根入口 → `dist/index.js`；
两份 manifest 可解析；四条深路径/CLI 根入口**全被拒**；装出来的 `cli.js --version` 与 PATH 上的
`agentia --version` 都是 `0.9.5`（bin 解析不经过 `exports`）。

**影响面**：`package.json`、`packages/cli/package.json`、`tests/architecture/package-exports.test.ts`（新）、
`README.md`、`README.en.md`、`packages/website/src/fragments/docs.html`、`CHANGELOG.md` ⑭、
`docs/guards.md` §1.4。**框架源码零改动**；导出面（81 个具名导出）零变化。

### 2026-09-29 ⑮：**`docs/deployment.md` 上线清单**（评审 P1-3）—— 「从 demo 到生产」之间的那篇文档

**触发**：「上生产」评审 §3.6 `A6`：`docs/*.md` 里没有 `deployment.md` —— `examples/deploy` 有了
（且被 e2e 真跑守着），但没有一篇**框架级**的「上线清单」（环境变量 / store 选择 / 健康检查 /
优雅停机 / 回滚）。挡的是「从跑通 demo 到推上生产之间那段路」的人。

**三条落地口径**（都为了不造第二个会腐烂的副本）：

1. **决定清单，不是教程副本**：每节回答「要过哪个决定 + 判据是什么 + 真源在哪」，**刻意不重复**
   usage-guide §7 的边界表（`boundary-table.test.ts` 守着）与 `examples/deploy/README.md` 的接线
   （`e2e-deploy` 真跑守着）—— 每多抄一份正文就多一处会分叉的口径。
2. **每条都来自已核实的仓内事实**，不是通用 checklist 模板：store 的「单宿主写者」前提取自
   `src/store/redisStore.ts` 头注（save 是两次 SET、未走 MULTI，跨进程协调属部署层职责）；
   「旧代码读新数据不保证」取自 `src/store/record.ts`（读时归一是**逐案维护**的垫片清单，
   不是通用兼容承诺）；「drain 不关 store」「框架不订阅信号」取自 usage-guide §6.2。
3. **完备性本身上守卫**（`tests/docs/deployment.test.ts`，五条判据 + 5 条变异）：清单的价值
   完全依赖完备性 —— 漏一格，漏的那格就是使用者的生产事故；而文档没有编译期保护。守：
   ① 十一个节标题骨架；② 反引号路径必须真实；③ 五个「漏了会出事故」级的机制词
   （`resumePending` / `drain` / `authenticate` / `budget_exceeded` / `单宿主写者`）；
   ④ 如实锚（`/healthz` 与 `/metrics` 的「不鉴权」必须说出来）；⑤ §10 复选框 ≥8 条
   （防清单退化成散文）。

**影响面**：`docs/deployment.md`（新）、`tests/docs/deployment.test.ts`（新）、`README.md`
（延伸阅读加一行）、`docs/guards.md` §1.4（登记）、本节。**框架代码零改动。**

### 2026-09-29 ⑯：**五个 bench 的数字对外**（评审 P2-1）—— 以及「这一次的腐烂不能用现算治」

**触发**：评审 §5 P2-1：仓里有五个基准（`scripts/bench-*.ts`），每个都能给出「换实现能省掉什么」
的**形状**结论，而对外文档面（README / README.en / 官网 docs 页）**一个性能数字都没有**
（`grep -nE "bench|ms" README.md` ⇒ 0 命中）。「零依赖」这类形容词不参与比较，**数字才参与**。

**而这一条与 P0-2（记分牌）的处境相反，值得单独记一笔**：记分牌那四个数能被现场复算
（`npm pack` / 数表行 / 读 `dependencies`）⇒ 用「现算 + 断言」治腐烂。bench 不行 ——

- 五个基准是**计时类**的，而本仓早就定了处置（`docs/plans/2026-09-22-dev-debug-loop.md`：
  「与 `bench:trace` 同档，不进 verify-all / CI，要看时跑」）。**跑进守卫 = 违反既定决策**，
  且计时基准在 CI 机器上只会制造抖动 ⇒ 那条路一开始就关着。
- ⇒ 于是这里有一处**必须如实承认的射程**：**毫秒数守不住**。写进 README 的那一刻起它就是
  「本机量级」，机器一换就变，且没有任何信号。

**因此这一节的落地口径是「守可复算性，不守读数」**（`tests/docs/bench-numbers.test.ts`）：
① 五个基准**每个都给复跑命令**且指向的脚本真实存在（`npm run bench:X` 要走 `package.json`
解一层 —— 只有 3 个基准注册了 script，另两个是 `npx tsx scripts/…ts`），加**自证**（解析出的
命令数 ≥ 5，否则解析器退化成 0 命中会静默全绿）；② 三面都写「**毫秒不是承诺**」（防本机量级
被抄进营销文案当 SLA）；③ 三面都写「基准**刻意不进 CI**」（防有人塞进 CI 而文档还写着
「刻意不进」，也防反过来）；④ `BENCH_SCRIPTS` 与 `scripts/bench-*.ts` **双向相等**（新增基准
⇒ 必须同步进三面）。**反向验证过 5 条，各恰好点名**，还原后 `sha256` 逐字节一致。

**顺带记一条工具性教训**：变异脚本里 `not ok` 前面有**缩进**，用 `startswith('not ok')` 过滤会
**漏掉所有子测试**、只剩外层 suite 一行 —— 输出看着「红了」，实际**没点名**，会把「没咬住」
读成「咬住了」。⇒ 一律 `line.strip()` 后再匹配。

**影响面**：`README.md`、`README.en.md`、`packages/website/src/fragments/docs.html`（各一节 +
侧栏锚点）、`tests/docs/bench-numbers.test.ts`（新）、`docs/guards.md` §1.4（登记）、本节。
**框架代码零改动。**

### 2026-09-29 ⑰：**推广稿里那个自贬的数字**（评审 P1-2）—— 以及「多写一处就多一处要同步」

**触发**：评审 §5 P1-2 的前半：「执行 `promotion.md`（已写好但未发），**先把「50+」改成现算值**」。
实测 `docs/promotion.md` 三处写着 `50+`，而 `docs/guards.md` §1 现算 **99 条** ⇒ 对外**自贬**。
形态与 P2-1 同一个：**写死的读数会腐烂**，只是这次烂的方向是「少报」。

**处置**：改成与 README 记分牌同源的下限 `90+`，并**一并纳入 `tests/docs/scoreboard.test.ts`**
—— 理由不是「多钉一个数」，而是推广稿这种文本**发完就没人回头核**（它不是测试、没有门禁），
所以「改对一次」在这里几乎等于「下次继续错」。只钉「守卫条数」这一个数：推广稿里其余数字
（4 个装饰器 / Node 18+）是**结构性事实**，改了就是产品变了、不是腐烂；把它们也钉住只会让
文案改一个字就要改测试。

**被变异验证逼出来的一条**：我在推广稿文件头加了一句「这个数别手改」的说明，**顺手把数字也
写进了那句说明** ⇒ 变异（把标题那处的 `90+` 改回 `50+`）**全绿**：断言测的是「这个词还在这
文件里」而不是「那句文案还写着它」。这与 `stability.test.ts` 那条「变异要摘干净」同源，
区别只在于这次的污染源是**我自己刚写的注释**。⇒ 说明句改成**不写数字**。

**⚠️ P1-2 的后半做不了**：「执行 promotion.md」= 真去发（Product Hunt / X / V2EX / 掘金…），
需要账号与发布时机，**不是代码能做的事**，留给仓库所有者。本节只完成「先把数字改对」那一半。

**影响面**：`docs/promotion.md`、`tests/docs/scoreboard.test.ts`、`docs/guards.md` §1.4、本节。

### 2026-09-29 ⑱：**官网「取舍对照」页**（评审 P1-1）—— 「不适用场景」此前一条都没有

**触发**：评审 §5 P1-1 —— 加一页**取舍**对照（**不是优势对照**）：明写相对 Mastra / LangGraph /
Vercel AI SDK **不做什么**、代价是什么、**什么场景该选别人**。验收两条：页面存在 + 含「不适用场景」。

**为什么这一页值得单独做**：实测 `grep -rn "不适用" packages/website/src README.md` ⇒ **0 命中**。
对外表达面从来没有说过「什么时候别选我」⇒ 读者只能从「它有什么」**反推**边界，而
**反推出来的边界必然比真实边界宽松**（读者会假定「没说不支持的都支持」）。这与 §7 已知边界表
是同一件事的另一面：§7 是**机制级**边界，这一页是**选型级**边界。

**三条落地口径**（沿用 `deployment.md` 那套，因为它们面对的是同一个风险）：

1. **每一条「不做」都指回仓内真源**，本页不替框架总结立场：`spec.md` §9.3（刻意不内建的四类，
   **已锁定**）、`usage-guide.md` 的判据原文（「引不引第三方依赖，不是用户想不想要」）、
   `no-runtime-deps.test.ts`、`examples/grpc-host/`、`tests/docs/stability.test.ts`（三个不发布的包）。
2. **竞品那一列只写「那边是谁的主场」，不写对它们的事实断言** —— 后者会腐烂且无法机器核实；
   写「要可视化编排 ⇒ 那边是 LangGraph / Mastra 的主场」是可核的（那是它们的定位），
   写「它们不支持 X」不是。
3. **完备性上守卫**（`tests/docs/tradeoffs-page.test.ts`，4 条判据 + 4 条变异）：「我们不做 X」
   这种句子**和别的承诺一样会腐烂** —— 页面在、那一节被精简掉了，零信号。守：页面+片段在 /
   含「不适用场景」节（评审验收点，也是这一页**唯一必须存在**的节 —— 没有它就退化成广告）/
   导航 + sitemap + llms.txt **三处都登记**（Nav 要求 ≥2 处：首页与非首页分支各一个，漏一个 ⇒
   一半页面到不了）/ 正文站内锚点真实存在 + 自证。

**影响面**：`packages/website/src/pages/tradeoffs.astro` + `src/fragments/tradeoffs.html`（新）、
`Nav.astro`、`sitemap.xml.ts`、`llms.txt.ts`、`tests/docs/tradeoffs-page.test.ts`（新）、
`docs/guards.md` §1.4、本节。**框架代码零改动。**

### 2026-09-29 ⑳：**发版闸门「骨架未填」的判据改成精确锚** —— 一场真实的误伤

**起因**：本次发版 `check-release` 把**已经写完**的 `[0.10.0]` 拦了下来，理由是「还是 bump 时插的
骨架（含 TODO）」。查下来是误伤 —— 判据是 `sec.body.includes('TODO')`，而本版 ⑫ 那条的正文里
合法地写着「发版流程文档里的两个必填 TODO、四步顺序」（它描述的正是 `docs/CONTRIBUTING.md` 里
那两个必填标记）。

**改动**：`scripts/release-surface.mjs` 两处判据的锚改成 bump **真正插入的那串**标记（`TODO` 紧跟 `(发版)`）
（由 `release.mjs` 的 `INSERT_OPS` 集中生成，永远带 `(发版)`）——
① 结构面「本版必须有 CHANGELOG 条目」；② `check-release --allow-pending` 的降级分支
（否则 bump 后的自检会把「正文正常提到 TODO」当成 pending 警告）。

**为什么值得记一条**：这是「**守卫测的东西 ≠ 它想测的东西**」的又一个实例 —— 粗判据在
「正文恰好提到那个词」时红，而它想拦的只有一种情况：**bump 插的骨架还没被人填**。
判据要锚在**生成方的标记**上，而不是锚在一个普通词汇上。

**反向验证 2 条**：① 往 `[0.10.0]` 插回那段骨架标记 ⇒ 严格闸门**恰好点名**这一条（`exit 1`）；
② 同一状态加 `--allow-pending` ⇒ 降级为 ⚠ 警告（`exit 0`，bump 后的预期行为）。
还原后 `sha256` 逐字节一致；`tests/scripts/release-scripts.test.ts` **10/10 仍绿**
（它的两条断言锚的本就是那段骨架标记 与「输出含 TODO」，精确化后照样成立）。

**影响面**：`scripts/release-surface.mjs`（两处判据 + 为什么不能用裸 `TODO` 的注释）、本节。
框架代码零改动。

### 2026-10-09 ①：**OpenAI 兼容端点接 DeepSeek 缓存计量** —— 两家厂商的 `input_tokens` 口径相反

**起因**：一轮对自身改动的深度评审发现 `src/integrations/openai.ts` 把 `cache_read_input_tokens`
恒记 0，DeepSeek 回报里的 `prompt_cache_hit_tokens` 被整个丢弃 —— agent loop 每轮重发不断增长的
前缀，缓存命中率常达 80–95%（命中价 ≈ 0.1×），**成本读数系统性高估数倍**，且方向一致
（terminal-bench 横向比较时永远冤枉自己）。

**关键口径差**（映射的全部难点在这）：DeepSeek 的 `prompt_tokens` **已含**命中部分
（`prompt_tokens = hit + miss`），而 Anthropic 的 `input_tokens` **不含** `cache_read_input_tokens`。
直接透传会让命中部分被 `costEstimate` 计两次（一次全价 input、一次 0.1× cache_read）。
所以映射是：`input_tokens = max(0, prompt_tokens − hit)`（只留未命中）、`cache_read = hit`；
无这两个字段的端点（纯 OpenAI）行为逐字不变。

**为什么记一条**：这是「同一字段名、两家语义相反」的记账陷阱 —— 接第三家 OpenAI 兼容端点时
必须先核「它的 prompt_tokens 含不含缓存命中」，否则总账必双计。判据写在
`src/integrations/openai.ts` 的 `inputUsageOf()` 头注里。

**影响面**：`src/integrations/openai.ts`（usage 装配两处 + `OpenAIUsage` 接口）、
tests/integrations 新增 4 条（含流式）、usage-guide.md API 速查一格。trace 的 `Usage` 结构不变，
变准的只有 DeepSeek 端点的记账值。

### 2026-10-09 ②：脚手架默认入口从 Job 翻成 HTTP 服务 —— **交付面是散文，闸门守不住它**

**起因**：用户一句话需求 ——「框架 build 之后 run 起来可以直接用，参考 NestJS 服务口径」。
当时形态（#224 刚落）是 `npm start` 仍跑**一次就退出**的批处理，**另外**给一个
`npm run start:server` 才是服务。多一个 script 不等于「直接可用」：NestJS 的口径里
`main.ts` **就是**那个在 `listen` 的入口。⇒ 把**默认值**翻过来，而不是再加一个名字。

**两个取舍都摆给用户选**（用户都取推荐项）：① 形状 —— **换骨**（`src/main.ts` = 服务、
一次性挪 `src/batch.ts`）优于换皮（只改 scripts 指向），代价是模板文件名与一路引用要一起改，
漏一处就是假绿；② 默认存储 —— 留 **`SqliteTaskStore`**（默认路径因此需 **Node ≥ 22.5**），
代价是低版本上默认路径起不来，退路是换 `FileTaskStore`（同一套 API，**单写者前提**）。

⚠️ **框架库的 `engines: >=18` 与 CI 的 `import-floor` job 刻意不动** —— 抬的是**脚手架默认路径**，
不是包本身（`node:sqlite` 在 `src/store/sqliteStore.ts` 里延迟加载，低版本上**构造**才抛可读报错）。
这条口径差必须写明，否则「`engines` 说 18、脚手架说 22.5」会被读成自相矛盾。

**顺带修掉两条静默**（都是本仓老形态）：① `AGENTIA_DB` 的缺省是 **cwd 相对** ⇒ 换个 workdir
启动（systemd / 容器 `-w`）会静默用**另一个库**，`resumePending()` 找不到上个进程的任务
（表面像「任务丢了」）⇒ 改成复用 `app.ts` 已导出的 `PROJECT_ROOT`；② `PORT=`（空串）经
`Number('')` ⇒ `0` ⇒ **静默随机端口** ⇒ 显式判空串 + `Number.isInteger` 响亮报错。
⚠️ 后者**不能**用 `|| 3000` 兜底 —— 那会把 e2e 刻意依赖的 `PORT=0` 一起吃掉。

**为什么记一条**：

1. **默认值也是对外契约**：使用者不会读完 README 才决定 `npm start` 跑什么。改默认值就是改契约，
   而它没有任何编译期保护。
2. ⭐ **交付面是散文，闸门守不住它**：这次 `tsc`、单测、八步 `verify-all` **全绿**，而仓库根 README、
   `packages/cli/README.md`（**随 npm 发布**）与官网**中英两版** docs 页**都残留着翻转前的说法**。
   已补 `tests/docs/scaffold-entry-contract.test.ts`（四层判据 + 三条防真空下限，12 条变异），并把
   **射程如实写进文件头** —— 目录树「一行只写一个文件」的列举与散文折行两类**不在射程内**
   （硬判会误红，而误报的门禁会被关掉）。与 2026-09-29 ⑧ 那句「承诺写在文档里、没有门禁」同根。
   ⭐ **同族第二例（复查时翻到，比本次翻转还早）**：2026-09-22 把装配拆成 `src/app.ts` 时，
   官网两版 **api 参考**仍把读 `.env` 说成由默认入口 `src/main.ts` 首行做 —— 停在盘上半个月，
   且此前**零守卫**（`templates.test.mjs` 的同一条不变量只守模板源码）。⇒ 这一条判据同时是
   「**散文面上还有多少条没人守的旧口径**」的第一个样本：别把「这次只漂了这几处」当成全部。
3. **它取代了 2026-09-22 那条决策的「落地形状」**里对 `src/main.ts` 的描述 —— 那条原文**保留不改**，
   因为本仓的历史决策记录如实引用当时形状是正确的；读它时请以本条为准。

**影响面**：`packages/cli/templates/src/{main,batch}.ts`（换名 + 两条 hygiene）、
模板 `package.json`（scripts 表 = `start` / `start:prod` / `start:batch`，**删** `start:server`）、
`templates/{env.example,gitignore,README.md}`、`packages/cli/src/{templates,create}.ts`、
`scripts/e2e-cli.ts`（4d/4e/4f 与两处文件表）、`packages/cli/test/{templates,structure}.test.mjs`
（棘轮账**原位**改数值）、`docs/{usage-guide,deployment,guards}.md`、根 `README.md`、
`packages/cli/README.md`、官网 `fragments/docs.html` + `fragments/en/docs.html` +
`fragments/api.html` + `fragments/en/api.html`（后者两处是**同族第二例**的修复），
新增 `docs/plans/2026-10-09-scaffold-default-service.md` 与 `tests/docs/scaffold-entry-contract.test.ts`。
**零 `src/` 框架改动**；脚手架是**生成物** ⇒ 既有使用者不需要任何动作（不构成破坏性变更）。

### 2026-10-12 ①：**OTLP 的 GenAI 基准「已 stable」是假断言，且基准本身已过期** —— 版本号也是断言

**起因**：v0.10.2 之后的全仓体检（`docs/reviews/2026-10-11/framework-review-v0.10.2.md` §1）
拿本仓的可观测栈跟 2026 生态对拍时，发现 `src/integrations/otlp.ts` 头注与
`docs/{observability,usage-guide,roadmap}.md`（**四处**）都写着「对齐 OTel GenAI semconv **v1.37**」，
（同一个字符串还在官网 `api.html` / `en/api.html` 各一处 —— 处置时才发现，见文末「影响面」）
其中头注还多一句理由：**「该版本里 `gen_ai.client` 侧已 stable，agent 侧仍 experimental，
故选 stable 键优先」**。

**回源核（v1.37.0 原文，非二手材料）——那句是假的**：

| 核什么 | 读数（`semantic-conventions` @ `v1.37.0`） |
|---|---|
| 文档状态 | `docs/gen-ai/gen-ai-spans.md` 与 `gen-ai-metrics.md` 文首**均为 `Status: [Development]`** |
| 本仓映射的键 | `gen_ai.operation.name` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` / `gen_ai.tool.name` / `gen_ai.conversation.id` / `gen_ai.agent.name` —— **逐条 `[Development]`（7/7）** |
| 徽章总数 | spans 文档 `Stable` 10 / `Development` 75；metrics 文档 `Stable` 14 / `Development` 139 |

⇒ `gen_ai.client` 侧在 v1.37 **不是 stable**。「选 stable 键优先」这个理由当时就不成立。

**第二件事：基准位置已被废弃**（同一轮现查）：
- 主仓 `docs/gen-ai/README.md` 由正文变成「Moved」跳转声明：**v1.41.1 = 2,397 字节 / 49 行 →
  v1.42.0 = 404 字节 / 11 行**（口径 = GitHub contents API 的 `size` + `wc -l`；`wc -c` / `wc -m` 同值）。
  ⇒ GenAI 约定自 **v1.42.0（2026-06-12）移出语义约定主线**。
  ⚠️ 本条初稿写的是「2,396 → 403」，**复算不出** ⇒ 换成上面可复算的口径（能现算的数字必须现算一遍）。
- 新家 `open-telemetry/semantic-conventions-genai`：建于 2026-05-05，**`GET /tags` 返回空数组**
  （真的无 tag；`RELEASING.md` + Towncrier 化的 `CHANGELOG.md` 已在，但内容**只有 `## Unreleased`**），
  `main` HEAD = `6fd0d763`（2026-10-09，写本文时**仍是该仓 HEAD**）。

⇒ 「钉 v1.37」不只是措辞错 —— 它**钉在一个不再维护的仓库位置上**。生态的官方口径正是
「pin 到某个 commit / 记下你 instrument 的日期」，因为没有版本可钉。

**处置**（按本仓「文档里的版本号也是断言」的口径）：
1. **删**掉「已 stable」那句假措辞 —— 本仓对错误主张的纪律是删，不另写一个更正版；
2. 基准改钉 **`semantic-conventions-genai` @ `6fd0d763`（2026-10-09）**，并写明「该仓无 tag、
   未版本化」，免得下一个读者去那里找一个不存在的版本号；
3. 顺手**删**掉一条**未独立核实**的断言（「下游 Datadog / Axiom / Langfuse 已按 1.37+ 识别这批键」）——
   它只出现在旧注释里、我无法验证；把没证据的话当依据，正是本仓反复收口的那类病。

**为什么记一条**：这是「**文档里的版本号也是断言**」这条纪律的最新样本，且揭示了这类断言的
**到期机制** —— 基准一旦钉在**会被废弃的仓库位置**上，上游搬仓那天它就开始腐化，
而**没有任何门禁会因此变红**（`otlp.test.ts` 验的是映射结果，不验基准措辞；官网 `api.html` 那两处同理 ——
`tests/docs/api-page.test.ts` 只钉「首列名字真实存在 + 每个导出都出现」，**表内描述文字零射程**）。
⚠️ 与 `boundary-table.test.ts` 那句「§7 每条 gap 的『今天还成不成立』仍要人读」同根：
**可机械判的只有形状，判不了「这句话今天是真是假」。**

**与历史原文的关系（只增不改，权威更正就是本条）**：§10 里**另有 2 处**引用这个已被证伪的基准，
都**保留不改**（它们如实记录了当时的决策与理由）：
- **`spec.md:1169` 起（2026-09-16 R7 的 ② 段）** —— 写「选 v1.37 是因为该版 `gen_ai.client` 侧已 stable，
  agent 侧仍 experimental」与「下游（Datadog / Axiom 等）已按 1.37+ 识别这批键」，**两句都被本条证伪**
  （前者见上表 7/7 `[Development]`；后者是**对别人行为**的断言、本仓无法独立核实）；
- **`spec.md:1857`（2026-09-18 ⑨ 段内）** —— 拿「`otlp.ts:15` 对齐 v1.37」当 MCP 连接器内置的**类比论据**：
  论证本身仍成立（改钉 commit 后**更强** —— 现在是真的「钉一个 commit」），只是**行号与值都漂了**
  （`otlp.ts` 的基准行现为 **`:19`**，写的是 `semantic-conventions-genai @ 6fd0d763`）。
以**本条**为准 —— 与 2026-10-09 ② 对 §10 的处理同款。

**影响面 = 六处**：`src/integrations/otlp.ts`（头注一处）、`docs/observability.md` §3 表一行、
`docs/usage-guide.md` §「OTLP 的 `gen_ai.*` 对齐」两处、`docs/roadmap.md` R7「已落地」一行、
**官网 `packages/website/src/fragments/api.html` 与 `en/api.html` 各一行**。
⚠️ 官网那两处是初稿**漏掉**的（初稿按「四处」写）—— 它们**没有守卫盯散文**，正是它漂移 4 个月的机制。
**零行为变更** —— 只动注释与散文，`genAiAttributes` / `mapEvent` 的映射逐字未动，
`tests/integrations/otlp.test.ts` 无需改动。

### 2026-10-12 ②：OTLP 导出侧投影 execute_tool + 三个缓存/压缩 semconv 键

**起因**：同一天的生态对拍深评（`docs/reviews/2026-10-12/observability-deep-dive.md` §3）
发现两个缺口 —— G3：三个「本仓已有信号、只是没以 semconv 键名发出去」的 Recommended 键
（每次 run 都算出了缓存 token、每次压缩都记了 `context.budget` 事件，但只发自有键）；
G2：上游 6 家框架（Mastra / Vercel AI SDK / CrewAI / AutoGen / Google ADK / Semantic Kernel，
**六中六**，逐家检索源码核过）都把 `execute_tool` 当一等 span，而本仓普通 @Tool 只有事件没有 span。

**键名拼写以钉 commit 的上游原文为准**（`semantic-conventions-genai @ 6fd0d763` 的
`client-inference.md` 属性表逐字核）：`gen_ai.usage.cache_read.input_tokens` ←
`Usage.cacheReadTokens`、`gen_ai.usage.cache_write.input_tokens` ← `Usage.cacheCreationTokens`、
`gen_ai.conversation.compacted` ← `context.budget` 事件。三条都是 additive、双发不替换。

**三个刻意口径**：

1. **投影放导出侧，engine 一行不动**。普通 @Tool 不建 span 是记账侧的刻意 trade-off
   （core/trace.ts 的 SpanKind 注释），生态变了也不必推翻它：OTLP 导出器吃的是按 span 分好组的
   `span.events`，父 span 隐含、配对键是 `tool_use_id`（不是名字 ⇒ 同名并行不配错）、
   `tool.output` 带真实 `durationMs` / `ok` / `errorKind` ⇒ **导出侧投影**即可让
   「按 span 查工具」的后端正常工作，本地 trace 形状与体量闸都不参与。事件本体保留在父 span
   上（投影是**多**出来的 span，不是搬走）。
2. **`projectToolSpans` 默认关**。与「不改既有产物、不悄悄改变导出体积」同款纪律：关闭时
   导出与既往一致（有「缺省 ≡ 显式 false 逐字节相等」的用例钉着）。
3. **孤儿 input 不编账**。开 `traceLimits.maxEvents` 后实测存在「只有 `tool.input` 没有
   `tool.output`」的对（超限停记丢的是后记那条）—— 投影成**无 `endTimeUnixNano`、无 status**
   的 span + `agentia.projection.orphan: true`（「开始了、没等到结束」，编零时长或编成败都是编账）。
   反方向的孤儿 output 记账侧不可达，防御口径是跳过（没有诚实的 start）。
   start/end 取两条事件各自的记账时刻（都是真实时刻，`durationMs` 与二者之差同源，不另发）。

**顺带一处单源**：`context.budget` 事件名此前是 turn.ts 里的字面量，本轮第一次有了跨层消费方
（otlp.ts）⇒ 按 E8 同款教训（跨 engine → integrations 的名字各写一份就是静默归零）上移到
`core/trace.ts` 的 `CONTEXT_BUDGET_EVENT`。

### 2026-10-12 ③：run 级 `sessionId` 的静默失效改成出声（`app.run` 入口告警 + 内部链路剥字段）

**起因**：可观测深钻（`docs/reviews/2026-10-12/observability-deep-dive.md` §2 行 7）记录了一处
静默失效 —— 会话维度（run 根 `session.id` attribute → OTLP `gen_ai.conversation.id`）的触发条件
是 `session: { store, id }`；而类型上还存在 run 级的 `sessionId` 字段，直传它不生效也不报错。

**调查结论（它决定修法）**：`sessionId` **不是死字段**，且有两个各自成立的语义 ——
① 引擎级（`RunAgentOptions.sessionId`）：`loop.ts` 真读它写 `session.id`，直连
`runAgent` / `executeRun` 时**生效**；② 契约级（`RunInvocationOptions.sessionId`）：
异步宿主的**可序列化会话引用**，`AsyncRunner` 在执行前把它换成 `session: { store, id }` 注入
（没配 `sessionStore` 而任务带了它 ⇒ submit 当场 `TaskInputError`，这条早已是响亮失败）。
**真正的静默点只有一处**：`RunAppOptions` 继承了 `RunInvocationOptions.sessionId`，而
`AgentApp.run` 的转发清单里没有它 —— 程序内 `app.run(messages, { sessionId })` 被静默丢弃。

**处置**（与 0.9.5 那批「把静默换成有声」同口径）：
1. `AgentApp.run` 入口：`sessionId` 在场而 `session` 不在场 ⇒ `console.warn` 一次
   （每条 run 一次，不是每回合刷），文案指出改用 `session: { store, id }`
   （要历史 + 维度）或引擎级 `sessionId`（直连 `executeRun` / `runAgent`，只要 trace 标记）。
2. **内部链路不能误伤**：`AsyncRunner` 的续跑段刻意不注入 `session`（防历史翻倍），
   若 `spec.options` 里的 `sessionId` 原样透传进 `app.run` 就会误踩闸 —— 所以
   `buildRunCallOptions` 把它**剥掉**（它在本层已被消费：换成了 `session` 注入 /
   或在 submit 时已响亮失败；`run-outcome.ts` 读的是 `rec.spec.options` 原文，不受影响）。
3. 文档对齐：`usage-guide.md` §4 选项表的 `sessionId` 行原先写「记进 run 根 `session.id`」
   —— 那只对引擎层成立，对 `app.run` 是错的，已按本条的口径改写。

**为什么不是「让 `app.run` 转发 `sessionId`」**（另一种修法：让静默失效变成生效）：
`RunInvocationOptions.sessionId` 的既定语义是「异步宿主的可序列化引用，由 runner 换 store
注入」；让 `app.run` 消费它等于给同一字段在相邻两层安两个语义（那边是「引用，待注入」，
这边是「直接当标记」），且 `app.run` 没有 store 可注入、只能给半个会话（有标记无历史）——
半生效比响亮告警更难排查。

### 2026-10-12 ④：MCP 桥接 SEP-414 trace 上下文（`params._meta` 裸键，跨进程链路从「断的」接上）

**起因**：2026-10-12 的可观测深钻评审（observability-deep-dive §1.2 / §3 G1）——
MCP **SEP-414**（Final，已进 2026-07-28 规范）把跨进程 trace 载体定死在 JSON-RPC 请求的
`params._meta` **裸键**（`traceparent` / `tracestate` / `baggage`，明说这是 `_meta` DNS 前缀
惯例的**例外**，加前缀会断跨实现的链），MCP Python SDK 官方实现已在注入；而本仓 MCP 桥
7 个文件里 `_meta` / `traceparent` **零命中** ⇒ 经 MCP 出/入的调用，trace 链是断的。

**决策**：

- **出站**（本仓当 MCP 客户端）：桥（`integrations/mcp.ts`）在 run 作用域内把
  `formatTraceparent(ctx.recorder.traceId, ctx.parentSpanId)` 交给连接器的 `callTool` 第三参
  （新增可选字段 `traceparent`，`McpCallOptions`），两个出厂连接器经共享的
  `toolsCallParams()`（`mcp-protocol.ts`，形状只许一处）放进 `params._meta.traceparent`。
  ⚠️ **通路选择是分层逼出来的**：`integrations` 只许依赖 `core`，够不到 engine 的
  `currentTraceparent()`；但 `ToolRunContext` 里**已经有同一份投影的原料** —— turn.ts 包工具
  执行的 `withCurrentSpan({ traceId: recorder.traceId, spanId: turnId })` 与
  `ToolRunContext.parentSpanId = turnId` 是同两个值 ⇒ ctx 投影与 `currentTraceparent()`
  **同源同格式**（经 core 的 `formatTraceparent` 编出同一个串），一条新边都不用加。
  粒度因此是**回合级**（指向发起调用的那个 `llm.turn` span），不是 run 级。
- **入站**（本仓当 MCP 服务端）：`engine/mcp-server.ts` 的 `tools/call` 从
  `params._meta.traceparent` 提取、`parseTraceparent` 解析，合法则作为这次 trace run 根的
  一条 `SpanLink`（与 HTTP 宿主认 `traceparent` 头**同款缝合**，形状照 loop.ts 的
  `traceContext` 接线）。
- **三条纪律**（评审定的，全部有用例钉住）：① 注入/提取失败**静默降级**（对端不认 `_meta`
  不能把调用打挂；桥保持无状态、宽容）；② **不改 `arguments`**（trace 上下文绝不进
  模型可见的工具签名）；③ 缺上下文/解析失败时**不造空 TraceContext**（保持「孤立根」
  行为 —— MCP Python SDK 的 docstring 理由：空 Context 会把 span 变成孤儿）。

**影响面**：`src/integrations/{mcp,mcp-stdio,mcp-http,mcp-protocol}.ts`、`src/engine/mcp-server.ts`；
`McpClientLike.callTool` 第三参加一个可选字段（**加法、无破坏性** —— 只实现两参的旧客户端
照常兼容，只是链路断在它的传输上）。公共导出面（`src/index.ts`）**零变化**
（`McpCallOptions` / `toolsCallParams` 是 module 级 export，不进公共面）。
测试：`tests/integrations/mcp-protocol.test.ts`（params 形状单源）/
`mcp.test.ts`（桥：在 run 内带、引擎裁判路径也带、无 ctx 不带）/
`mcpConnector.test.ts`（两个传输过真边界；stdio 侧靠夹具新 `echoparams` 模式回读）/
`tests/engine/mcp-server.test.ts`（入站：合法 → run 根 link；缺失/非对象/非字符串/畸形/
版本 ff → 孤立根、不报错、调用照常）+ `scripts/e2e-mcp-server.ts` 补「跨进程 link 真出现在
落盘 trace 里」。**变异验证 6 条全咬住**（摘 `_meta` 展开 / 桥不装配 / stdio / http 各不传
第三参 / 入站不接线 / 入站跳过解析各红在对应断言）。
另核过 `npm run e2e:mcp`（真 `uvx mcp-server-time`）：注入 `_meta` 后第三方 server 照常服务
（纪律① 的真实对端证据）。

### 2026-10-12 ⑤：`agentia report` 加会话 / 任务维度（G6）—— 「成功率」必须带分母

**起因**：2026-10-12 的可观测深钻评审（`docs/reviews/2026-10-12/observability-deep-dive.md` §3 缺口表）
列了十项缺口，四个 PR 做完七项、剩下 G6 / G7 / G8；补缺设计稿 =
`docs/plans/2026-10-12-observability-g6-g7-g8.md`。G6 的病灶很具体：`report` 只有**能力维度**
（`capabilities[]`）+ run 级**计数**（`runs` / `failed`），`failed` 是**次数不是分母**
⇒ 「成功率」在当前输出上**根本算不出来**，而它恰恰是「这一段跑得好不好」的第一问。

**决策**：

- **同文件加维度，不新开子命令**：CLI 已有 9 个子命令，而 `report` 的输入（同一批 trace 行）与
  用途（调优）和会话视图**完全重合**。`ReportJson` 增 `sessions: SessionRow[]`（**加法**，兼容）。
- **分组键三选一，不混排**（一条 run 只进一个组）：run 根 span 的 `session.id`（宿主传
  `session: { store, id }` 才写）→ 记录里的 `TaskRecord.taskId` → `(无会话)` 桶。
  ⚠️ 会话一般聚多条 run，而 `taskId` 逐任务唯一 ⇒ 后一路通常是「一组一条」，它是给单任务批跑
  逐条标成本，**不是**多轮聚合；这一层差别写在该接口的注释里，免得被当成会话维度用。
- **三个数一起给，百分比不单独出现**：`runs` / `succeeded` / `failed` 都出列 —— 只报百分比在小
  组上是噪声（与 `summarizeTrace` 头注「单条 run 样本常 < 5，不给分位」同一取向）。
- ⭐ **对设计稿的一处修正（本条最该记下来的）**：成本口径从设计稿的「该组各 run 的
  capability 行 `costUsd` 之和」改成 **`totalUsage.costEstimate`**。理由是前者**会重复计数**：
  capability span 的 `usage` 是**其子孙 `llm.turn` 的聚合**（`core/trace.ts` 的 `Span.usage` 注），
  `@SubAgent` 里套 `@Skill` 时两者带的是**同一批 token**；而 `Trace.totalUsage` 的注写明它
  刻意不含 capability 聚合，正是为免重。⇒ 设计稿那句「现成的 `summarizeTrace` 产物，不另算」
  在**嵌套能力**这个形状上是假账，落地时必须改。
- **「除不了」不给数**：成功数为 0 时 `costPerSuccess` 是 `null`（渲染成 `-`），**不是 0**
  —— 写成 0 等于说「每个成功任务不花钱」，正好说反；同时它也不能是 `Infinity`。
- 展示层顺带修一处：`pad` 改成按**显示宽度**补齐（CJK 记 2 列）—— `(无会话)` 是没配会话时的
  **唯一**一行，按 `String.length` 补齐会把整张表右推 3 格。

**影响面**：`packages/cli/src/report.ts`（194 → 339 行；棘轮账 LINE/TOTAL 同步，**为什么超了设计稿
估算的 +60~90** 记在 `packages/cli/test/structure.test.mjs` 的基线条目里）；
`docs/usage-guide.md` §6.4 的 `--json` 形状列表同步加 `sessions`。**框架侧 `src/` 零改动**。
测试：`packages/cli/test/report.test.mjs` +6 条（归组 / `(无会话)` 桶 / `taskId` 回退键 / 降序 /
**「成功数为 0 ⇒ `-`」的反向断言** / 成本读不出 ⇒ `-`）；**变异验证 4 条各咬住预期的那一条**
（`> 0` → `>= 0` ⇒ 反向断言那条例外变 `Infinity`；丢掉 `taskId` 回退；把「读不出」写成 `0`；
`session.id` 读成 `sessionId`）。

### 2026-10-12 ⑥：G7 交接 / 护栏 —— 两个「不是 span 的东西」各补一个入口

**起因**：补缺设计稿 `docs/plans/2026-10-12-observability-g6-g7-g8.md` §3（G6 见上一条）。病灶是
**可发现性**：交接（agent → agent）在这个框架里就是一条 capability span 本身；护栏（审批）则
**只是事件**（`approval.requested` / `approval.decided`）。对外部 OTLP 消费者，两者都要解析
trace 才看得见。

**决策**：

- **加 additive 属性，不造 span kind**。上游这两格本就很小（OpenAI Agents SDK 的
  `HandoffSpanData` 只有 `from_agent` / `to_agent`，`GuardrailSpanData` 只有 `name` / `triggered`），
  造 span 等于往核心词汇表加词；而 `Span.attributes` 是现成的自由 KV ⇒ **核心零改动**。
  四个键：`agentia.handoff.from` / `.to`（被调 `@SubAgent` 的 capability span）、
  `agentia.guardrail.name` / `.triggered`（发起审批的 `llm.turn` span）。约定写进
  `docs/usage-guide.md` §6.4「交接与护栏」。
- ⚠️ **审批不升级成 span**（现在是事件，与「普通 `@Tool` 只发事件」同形）；`guardrail.*`
  **只在触发时发**，不设 `false`（与 `gen_ai.conversation.compacted` 同款口径）；
  `handoff.*` 拿不到调用方身份时**两个键都不发**。
- ⭐ **落地时对设计稿的一处补空（本条最该记的）**：设计稿只写「`from` = 调用方 agent 名」，
  **没说它从哪来**。查下来调用点手上只有 `recorder`（`RecorderBackend` **只写不读**，没有任何
  查 span 树的口子）与 `ctx.parentSpanId`（一个反查不出名字的 id）⇒ 唯一拿得到它的地方是
  「当前调用期」作用域。于是给 `SpanScope` 加可选 `agentName`，并把 `withCurrentSpan` 从
  **整条替换**改成**合并**（内层同名键覆盖外层）—— 夹在中间的 `llm.turn` **谁都不知道身份**，
  用替换的话它每次包工具执行都会把 run 根写的名字抹掉。`traceId` / `spanId` 仍由每个写入点
  显式给 ⇒ 收窄语义逐字不变（`tests/engine/spanScope.test.ts` 继续钉住「并行链互不干扰、
  内层不外泄」）。
- **视图**：`@migor/trace-view` 的 summary（CLI `agentia report` 与 `agentia dev` 面板同源）把
  `approval.decided` 聚成 `guardrail:<工具名>` 一行 —— `calls` = 走到决定的次数、`errors` =
  **被拒**次数、`total` / `max` = 等审批时长（`waitedMs`）。⚠️ **只聚 `decided`**：只有
  `approval.requested` 而始终没恢复的挂起**不产出行**（没有结论也没有时长，硬记一格等于编账）；
  缺 `waitedMs`（宿主没回填 `requestedAt`）记 0 而**不编造**。

**影响面**：`src/engine/span-scope.ts`（+`agentName`、`withCurrentSpan` 改合并）、
`src/engine/loop.ts`（run 根登记应用名）、`src/engine/turn.ts`（审批处两个属性）、
`src/toolkit/subagent.ts`（交接两个属性 + 子循环作用域换名）、
`packages/trace-view/src/summary.js`（`guardrail:` 聚合，棘轮 106 → 126）。公共导出面
`src/index.ts` **零变化**（`SpanScope` 是 module 级 export，不进公共面）。
测试：`tests/toolkit/subagent.test.ts`（嵌套交接逐层换名 / 无作用域时不发）、
`tests/engine/approval.test.ts`（在场 + 不在场两态，顺带钉住「审批不建 span」）、
`packages/trace-view/test/summary.test.js`（护栏行三态：正常 / 只有 requested / 畸形 body）。
**变异验证 4 条，3 条当场咬住；第 4 条先没咬住 —— 抓出的是我自己的自证样本**：
`approved === false` 取反成 `=== true` 时，那个「一真一假」的 fixture 两边都得 **1**
（对判据的取反免疫）⇒ 补一条「批准」使取反后变 2，才咬住。⚠️ 这正是「全过 ≠ 可靠」的第
三形态，已写进用例注释留痕。

### 2026-10-12 ⑦：观测面给 agent 消费的入口（G8）—— 这是分发面，不是功能面

**起因**：补缺设计稿 `docs/plans/2026-10-12-observability-g6-g7-g8.md` §4（G6 见 ⑤、G7 见 ⑥）。
trace 落盘之后，能问「我上一轮慢在哪」的此前只有人和 CLI；本项把那两个问题变成 agent 自己
能调的**工具**。

**决策**：

- **落点是示例 + 附属包**（`examples/observability-mcp/`，`private: true`），不进核心 ——
  与「三个 `@migor/*` 附属包不发 npm」同款定位。**核心零改动**（`src/` 一个文件都没动）。
- **复用反向桥 `createMcpServer`**：`tools/call` 的协议面（含 ④ 刚落地的 `_meta.traceparent`
  入站缝合）一行都不用重写；两个工具（`report_trace` / `diff_traces`）是 `buildRunReport` /
  `mergeRunReports` / `diffTraces` 的薄壳，都不做自己的聚合。
- ⚠️ **它的价值在分发面**（§四：本仓瓶颈是产品面 / 分发面不是工程质量）⇒ 验收标准是
  「外部客户端接得上」，不是「新增了多少能力」。

**三条实证修正（本项最该记的）**：

1. ⚠️ **断言「错误发生了」不够，要断言「发生的是哪一种」**：删掉只读边界那条变异跑出来时，
   `isError` 那条断言**照样绿** —— 因为根外那个夹具当时是个**非 trace 的 JSON**，工具仍会报错
   （理由从「越界」变成「认不出 trace」）。⇒ 夹具换成**合法 trace**（复现病灶的形状：读得到、
   但不该读），并把断言钉到**拒绝理由**上；复跑变异 ⇒ 那组三条全红。
2. ⚠️ **夹具会被引擎的默认闸悄悄截断**：`maxIterations` 缺省 40（`engine/run-config.ts`），
   而截断那组夹具要 45 回合 ⇒ run 在第 40 回合收尾，`spanDiffs` 恰好**等于** `MAX_DIFF_SPANS`
   ⇒ 「截到了」那条断言看起来过了、实际什么都没验。⇒ 显式 `maxIterations: 60`。
3. **断言要照实测形状写**：普通 `@Tool` **刻意不建 capability span**（既有口径）⇒「同一位置
   换了能力」在 diff 里的落点是 `llm.turn` 的**事件体差异**，不存在 `capability:read_file`
   这种路径。形状是先跑探针（`.workbuddy/probes/g8-diff-shape.ts`）看出来的，不是猜的。

**口径**（写进示例 README 与 `usage-guide.md` §6.5）：

- **只读 trace 根内的文件**（`AGENTIA_TRACE_ROOT`，缺省 cwd）：工具参数由模型给、返回内容直接
  进模型上下文 ⇒ 不设边界等于发一个「任意文件读取」原语。判据是 **realpath 后比前缀**，不是
  字符串 `startsWith`（后者挡不住 `../` 与「同前缀的兄弟目录」）。
- **进模型上下文的东西有天花板**：`diff_traces` 一次最多 40 条差异 span（`SpanDiff.a` / `.b`
  是**完整 span**，原样返回一次就能顶掉整轮预算），截掉多少在 `truncated` 里如实报出。
- 读不出就说读不出：一条 trace 都认不出 ⇒ **报错**（不是空表 —— 空表会被读成「零开销」）；
  成本读不出给 `null`。

**影响面**：`examples/observability-mcp/`（新：4 个源文件 + README）、`tsconfig.tests.json`
（include 加该目录 ⇒ 示例的 `src/` 按**仓库根**那套严格开关编，含 `exactOptionalPropertyTypes`）、
`scripts/e2e-examples.ts`（第 10 轮 + `ensureLinks`；本链第 7 步 `npm run e2e` 会跑到它）、
`examples/README.md`（表行，`examples-table` 守卫双向核）。**验证**：`npm run verify` 17 条
check（真 HTTP server ⇐ 出厂连接器 + `mcpTools`：report / diff / 缺侧 / 截断 / 越界拒绝）；
**3 条变异各自咬住预期的断言**；`npm run e2e:examples` 全绿。

### 2026-10-12 ⑧：`agentia report` 按 `traceId` 去重（append-only 导出不再翻倍计数）

**起因**：⑤（G6）落地后的审查实测：`FileTaskStore` 是 **append-only**（`src/store/fsStore.ts`，
每次 save 追加一行），审批流任务的导出里同一棵挂起段 trace 会出现**多行**（挂起 save /
approve 落库 / 接管再 save，各行的 `result.trace` 是同一份）。`report` 按行计 ⇒
runs / succeeded / cost 全部翻倍（实测：实际 2 段 0.02 的任务报出 runs=3、succeeded=3、
cost=0.03）。

**决策**：

- **去重键是 `traceId` 而不是 `taskId`**：一个任务可以跨**多段** run（挂起 → 恢复 → 再挂起），
  每段是一棵新 trace（`traceId == runId`，§9.1 的 1:1 不变量）。按 `taskId` 去重会把同一任务的
  **不同段**错并成一条 —— 那正是审批流任务的正常形状（2 段是事实，不是重复）。
  traceId 读 trace 根的 `traceId` 字段（`TraceLike` 本就有；`Trace.traceId` 是必填）。
- **取最后一行**：append-only 里后面写的是**新状态**（接管后落库的记录才是终态），
  留着的是各 traceId 在文件里最后一次出现的位置（保序，输出顺序与直觉一致）。
- **能力表 / runs 总计 / 会话表共用同一份去重后的输入**：能力表此前就按行翻倍（存量问题，
  本次一并修）—— 两处各算各的必然漂移。
- **无 traceId 的行全保留**（手写 trace 无从判同）；去重在解析**之后**统一做，不在解析循环里
  顺手做（坏行计数 `skippedLines` 会被带歪）。
- **usage-guide 同步两处口径**：§6.4 的 FileTaskStore 段落点明「`report` 按 traceId 去重」；
  会话维度段落点名「**挂起计入 ok**」（引擎口径「挂起不是失败」，suspended 的 trace 状态是
  ok ⇒ 全挂审批上的 10 条 run 会报成功率 100% —— 刻意取舍，但要写出来免得误读）。
- 顺带补一条此前没钉的用例：**分组键优先级**（`session.id` 与 `taskId` 同带时归会话组）——
  「对调优先级」的变异此前能活。

**影响面**：`packages/cli/src/report.ts`（+30 行左右，纯解析后过滤）；
`packages/cli/test/report.test.mjs` +2 条（去重 + 优先级），另有 1 条存量用例的夹具改
**不同 traceId**（「多条记录按能力合并」此前两行同 traceId，在新口径下本就该被去重）。
**验证**：`node --test packages/cli/test/` 全绿；**变异 2 条各咬住预期用例**
（去掉去重 ⇒ 去重用例红；对调优先级 ⇒ 优先级用例红）；`verify-all.sh` 8/8。
### 2026-10-12 ⑨：护栏行在真实 HITL 主流程零产出 —— `approval.decided` 的扫面不该限 span kind

**起因**：⑥ 的评审发现主 bug —— 真实审批流是「挂起 → 人批 → 带 `approvals` 恢复」，
而恢复段的工具执行走 `loop.ts` 的续跑入口：那里把 **run 根 id 当 turnId** 传给
`executeTurnTools`（被恢复的回合属于挂起段的旧 trace，本段没有对应 `llm.turn`），于是
恢复段的 `approval.requested` / `approval.decided` 与两个 `agentia.guardrail.*` 属性
**都记在 run 根 span 上**。但 trace-view 的 summary 聚 `approval.decided` 时只扫
`kind === 'llm.turn'` 的 span ⇒ 所有真实审批用法下 `guardrail:*` 行**一行都没有**；
只有「首段同步带 approvals」（基本只有测试这么干）才出行。CLI `agentia report` 与
dev 面板与 summary 同源，同样漏。

**决策**：

- **扫面放宽为不限 span kind**（`tool.output` 仍限 `llm.turn`，那条没变）。理由分两层：
  ① **落点因段而异本来就是对的** —— `approval.decided` 记在「执行该工具的那个调用点
  收到的 turnId」上，与 `tool.input` / `tool.output` 同一纪律（`turn.ts` 头注：工具事件
  记在本回合 span 上）；首段是 `llm.turn`、恢复段没有 `llm.turn` 就落 run 根，这不是
  记账缺陷而是分段结构的事实。事件体自带 `tool`，聚合不需要靠 span kind 定位。
  ② **放大扫面不会双计**：`approval.decided` 的记账点只有一处（`executeOneTool`），
  一次决定只记一笔 —— 同段内审批闸是**全有或全无**（决定不齐就一个工具都不执行、
  一笔 decided 都不记），跨段则是**另一条 trace**（每次 `runAgent` 一个新 recorder），
  不存在「同一笔 decided 出现在两个 span」的形状。
- **引擎行为不改**：`guardrail.*` 属性跟随 `approval.requested` 的落点（首段 `llm.turn`、
  续跑段 run 根）是内部一致的；⑥ 与 `usage-guide.md` 属性表原写「发起它的 `llm.turn`
  span」⇒ 与续跑场景矛盾，**文档口径订正**为「与 `approval.requested` 同 span」。

**影响面**：`packages/trace-view/src/summary.js`（棘轮 126 → 130，净 +4 全是注释，
代码行数零增长 —— `const isTurn` 换掉 `if (kind !== 'llm.turn') continue;`，工具分支
判据内移）、`docs/usage-guide.md`（属性表 + 视图条目）。测试：
`packages/trace-view/test/summary.test.js` 保留原「首段形状」用例，另补**恢复段形状**
（decided 在 run 根 ⇒ guardrail 行在场且数值对）与「run 根 + llm.turn 两处都聚」。
**变异验证**：恢复 kind 限制 ⇒ 两条新用例红；复原复跑绿。
### 2026-10-12 ⑩：G8 示例的复审收口 —— 分组键三级回退对齐 CLI、root=`/` 特判、sessions 截断

**起因**：f37cce5（⑦）的复审发现三处低危：① `sessionRows` 自称「口径同 CLI」却只做了**两级**
回退 —— `readTraceFile` 把外层 wrapper 丢了，`TaskRecord.taskId` 那层够不到 ⇒ 对
FileTaskStore / SqliteTaskStore 导出的记录，CLI 按任务逐条分组、示例全坍进 `(无会话)`；
② `resolveInsideRoot` 的 `root + sep` 在 root=`/` 时变成 `//` ⇒ 根下所有文件被误拒
（方向过紧、不泄密，但行为错）；③ `report_trace` 的 `sessions` 无截断天花板 ——
长寿 trace 文件（几千个不同 `session.id`）会把几千行灌进模型上下文，与 diff 侧
（`MAX_DIFF_SPANS` + `truncated` 如实报出）不同款。

**决策**：

- **三级回退对齐 CLI**：`readTraceFile` 保留 wrapper 的 `taskId`（`TraceFile.traces` 改
  `entries: { trace, taskKey }`），`sessionRows` 的分组键换成与 CLI `report.ts` 逐字同体的
  `groupKeyOf`（`session.id` → `taskKey` → `(无会话)`）。
- ⚠️ **这份移植不配运行时逐字对拍，配的是源码级双钉**（`tests/observability-mcp-parity.test.ts`）。
  与前三份（harvest / diffTraces / export）不同款，两个硬约束：① 示例必须可整目录拷走单用
  （README 明写）⇒ 示例侧不能反向 import `../../packages/cli`；② 示例的 dist 在 `npm test`
  时未构建（verify-all 步序：build:cli 步 5、示例构建在步 7 的 e2e-examples 里）⇒ CLI 套件
  import 示例 dist 会在 CI 里永久 skip（真空变绿）。源码级双钉与
  `tests/transport/http-boundary-guard.test.ts` 同族：三段 canonical 行（分组键回退 /
  taskId 提取 / 桶名常量）钉成两份源码里逐字都在场；行为面两边各有断言
  （CLI 侧 `report.test.mjs`、示例侧 verify §8）。
- **root=`/` 特判**：`root.endsWith(sep) ? root : root + sep`（realpath 只有根才带尾部分隔符；
  Windows 的 `C:\` 同理被覆盖）。
- **sessions 截断同档 diff 侧**：`MAX_SESSION_ROWS = 40`（按总耗时降序留头部），`TraceReport`
  加 `sessionGroups`（截断前真实组数）/ `sessionsTruncated`（截掉的组数）—— 截断必须如实报出，
  与 `CompactDiff.truncated` 同款纪律。

**影响面**：`examples/observability-mcp/`（traces.ts / verify.ts / README；verify 17 → 26 条
check、7 → 10 组）、`tests/observability-mcp-parity.test.ts`（新）。**框架与 CLI 零改动**。
**验证**：3 条变异各咬住预期断言（去掉 taskId 层 ⇒ 双钉红 + verify §8 红；去掉 root=`/` 特判
⇒ verify §9 红；去掉截断 ⇒ verify §10 三条红）；`npm run e2e:examples` 全绿。

### 2026-10-13 ①：retry 数值旋钮入口校验 + 退避处 catch 只认 AbortError（深评 A1）

**起因**：五路深度评审实测：`retry: { baseDelayMs: NaN }` + 一次 429 ⇒ `backoffDelay` 算出
NaN ⇒ `sleep → interruptibleSleep → assertTimerDelay` 抛 RangeError ⇒ `turn.ts` 退避处的
裸 `catch { aborted = true }` 把它吞成 `stopReason: 'aborted'`（配置错被谎报成「用户取消」）。
同族：`maxAttempts: NaN` 让 `!(NaN >= 1)` 成立 ⇒ 重试被**静默关闭**（`retry.ts:70`），
run 根快照记 `config.retry.maxAttempts: 0`，看着像用户主动关的 —— 而 client 层
`maxRetries` 对同款坏值是构造期抛 TypeError 的，两层纪律不对称。

**决策**：

- **四个数值旋钮进 `core/limits.ts` 真源表 + `resolveRetry` 校验抛 TypeError**：
  `maxAttempts`（非负安全整数，`0` = 关闭重试）、`baseDelayMs` / `maxDelayMs`
  （0 ~ 2^31-1ms 有限数，`0` = 不退避 / 封顶为零）、`jitter`（0~1，`0` = 不加抖动）。
  报错文案插 `zeroClauseOf`（文案与表同源，tests/limits.test.ts 的文案对账 case 守着）。
  校验放 `resolveRetry`（单源，`runAgent` / `runAgentScoped` / 直连 `agentLoop` 都过它），
  `runAgent` 入口另调一次 `validateRetryOptions` —— 与 `validateLabels` / `resolveModelChain`
  同落点：**配置错响亮抛出，不收成「一条失败的 run」**。
- **退避处 catch 只认 `isAbortError`**，其他错误原样抛出（走 `classifyError` 的正常归类）。
  入口校验让这条路本不该走到，留它作纵深防御 —— 「sleep 只抛 AbortError」是假设不是契约。
- **`backoffDelay` 上界再封一道**：`maxDelayMs ≤ 2^31-1` 由校验保证，但正向抖动（±jitter 是
  有意的）仍能把它推过 Node 定时器上限 ⇒ `Math.min(…, MAX_TIMER_DELAY_MS)` 夹住。
  用 `Math.min` 而不用 `clampTimerDelay`：后者把 NaN 读成 0，而 NaN 是必须响亮的坏值。

**影响面**：`src/engine/retry.ts`（+validateRetryOptions / clamp）、`src/engine/turn.ts`
（catch 判别）、`src/engine/loop.ts`（入口校验）、`src/core/limits.ts`（+4 旋钮）、
`tests/limits.test.ts`（+4 探针 + 4 文案对账 case）、`tests/engine/retry.test.ts`（+6 条）、
`docs/usage-guide.md`（重试段补口径）。**验证**：旧行为逐字复现为红（去掉校验 ⇒
runAgent 入口用例红；catch 改回裸 catch ⇒ streamTurn 用例红）。

### 2026-10-13 ②：runAgent 入口段抛错时 run 根 span 必须合拢（深评 A2）

**起因**：`loop.ts` 的 `recorder.begin('run', …)` 之后、`agentLoop` 之前的入口段
（`menuSignature` 的 JSON.stringify、`resolveModelChain`、`validateLabels` 等）抛错时，
run 根 span 永不 `end` —— `runtime/run.ts` 的 `fail()` 只在**根未开**时补记，于是交付
sink 的 trace 是 `status='error'` 而根 span 是 ok、无 endedAt、无结构化 error，违反
「非正常收尾必带结构化 error」的不变量。

**决策**：入口段整体进 try/catch，catch 只做两件事 —— 给根 span 收尾
（`status:'error'` + `classifyError(e)` 的结构化 error）+ **原样 rethrow**。
对外行为不变（配置错照样响亮抛，不收成「失败的 run」），只是 trace 不再说谎。
`recorder.end` 幂等，`fail()` 不双记（根已开它只 snapshot）。

**影响面**：`src/engine/loop.ts`（入口段 try/catch）；`tests/engine/loop.test.ts` +1 条
（labels 空键 / 空壳 fallback client 两个真实触发点，断言根 span error + endedAt +
结构化 error 且模型请求零发出）。**验证**：去掉 catch 里的收尾 ⇒ 该用例红。
### 2026-10-13 ③：@Tool/@SubAgent/@Skill 装饰期拒**静态方法**（与私有方法守卫同款）

**起因**（五路深评 C1）：三类能力装饰器的目标守卫 `assertMethodTarget` 只拦
`context.private` 不拦 `context.static`，而收集器 `scanDecoratedMethods` 只扫**实例原型链**
—— 静态方法挂在构造函数上永远扫不到。于是装饰器正常登记、装配零报错、菜单里就是没有
（四类里只有 `@Prompt` 扫构造函数链，那是它的显式支持形态）。

**决策**：选「装饰期拒 static、响亮报错」，**不选**收静态 —— 静态方法没有实例 `this`，
@Tool 的调用语义（`Reflect.apply(inst[key], instance, …)`）不成立，收下必然是错的。
实现是 `assertMethodTarget(context, kind, { allowStatic })` 加第三参，`@Prompt` 传
`allowStatic: true`（纯文本资产、无实例上下文需求，静态收集是它的文档化形态，不动）。
报错文案明说「@Prompt 是唯一支持静态的能力类」，免得作者对着报错猜哪类能用。

**影响面**：`src/toolkit/collect.ts`（守卫 + `CapabilityDecoratorContext.static`）、
`src/toolkit/prompt.ts`（传 allowStatic）、`tests/toolkit/collect.test.ts`
（改「含静态照常登记」旧断言 + 三类拒绝用例 + 真实装饰器路径一条）、`docs/usage-guide.md` §3。
存量代码零命中（全仓没有静态 @Tool/@SubAgent/@Skill），非破坏性变更（此前静态装饰本就是
死资产）。

### 2026-10-13 ④：子菜单重名查重（@SubAgent/@Skill 的 tools 引用展开结果也查）

**起因**（五路深评 C2）：装配期的「菜单能力重名」查重只跑**主菜单**（sources 合并 + 裸工具），
而 @SubAgent/@Skill 的 `tools` 引用是**运行期**展开的（resolveTools 是延迟 thunk）——
两个 provider 各有同名能力被同一能力整片引用时装配全绿，第一次模型调用才由 API 400
（tool names must be unique）暴露。

**决策**：装配期在 `wrappedByToken` 填齐后、成环检测之前，对每个 subagent/skill 能力
**逐引用片**展开查重（不调用 resolveRefTools 的整体 thunk —— 报错要带引用片来源）。
报错文案指到「哪个能力的哪几片引用」：`子菜单能力重名：@SubAgent "x" 的 tools 引用展开后
"search"（来自 "a" + "b"）`。同一 provider 内部的重名（两个方法同显式 name、toolSources
收窄后逃过主菜单查重的那条缝）同样被这条网住（报成「来自 "p" + "p"」）。
修法引导写进文案：能力级路径 `<token>/<能力名>` 收窄引用，或改名。

**影响面**：`src/toolkit/module.ts`（+45 行装配期校验）、`tests/toolkit/capability-refs.test.ts`
+3 条（整片叠整片 / 能力级路径叠整片 / 收窄后放行的反向对照 + 运行时菜单断言）、
`docs/usage-guide.md`（§4 `tools` 行与 §8 常见错误行的「重名查重」口径补「主菜单+子菜单」）。

### 2026-10-13 ⑤：`mergeRunReports` 去重下沉到框架公共面

**起因**（五路深评 低等项）：2026-10-12 ⑧ 给 CLI `agentia report` 加了按 traceId 去重，
但去重落在 CLI 层（对原始 trace 行做）；框架公共 API `mergeRunReports(reports)` 喂同样的
append-only 导出照样翻倍计数。

**决策**：去重下沉到 `mergeRunReports` 本身，口径与 CLI 完全一致（按 `traceId`、同一 traceId
只留**最后一份**、保序）。⚠️ 一个刻意的例外：`merged(n runs)` 是合并报告的**合成 id 不是
身份**，不参与去重 —— 两个「merged(1 runs)」撞 id 也不得互相吞掉（合并报告的合并是合法操作）。
**CLI 侧不动**：CLI 的去重作用在**原始 trace 行**上（它不经过 `mergeRunReports`，
走 trace-view 的 `summarizeTrace`），两层不是同一份代码、不存在「因此冗余」；
`packages/cli/src/report.ts` 不是框架 `src/integrations/report.ts` 的移植副本
（逐字对拍守护只管 harvest / diffTraces / exportRun 三份），本次无需两边同步。

**影响面**：`src/integrations/report.ts`、`tests/integrations/report.test.ts`
（存量 4 条 merge 用例夹具改**不同 traceId** —— 同 traceId 多份在新口径下本就该被去重；
+2 条：同 traceId 只留最后一份 / merged 报告不参与去重）、`docs/usage-guide.md` §6 速查行。

### 2026-10-13 ⑥：两处「缺省零信号 / 簿记残留」收口（stdio 握手超时、metrics OTLP 导出失败）

**起因**（五路深评两条低等项）：
① stdio 连接器的 `guard` 超时只是「放弃等待」，`ensureReady` 的 initialize（以及
`tools/list`）没带 `abandoned` 信号 ⇒ 超时的握手条目永远留在 `pending` 里
（server「活着但不回包」时每超时一次泄漏一条，直到进程死 / close）；
② `flushOtlpMetrics` 的失败在无 `onExportError` 时被 `?.` 吞掉连 warn 都没有 ——
traces 侧缺省至少落 `console.warn`（flushSinks），metrics 侧是零信号。

**决策**：
① 握手与 `tools/list` 各自持一个 `AbortController`，`guard` 失败分支 `abort()` 之 ——
复用 `send` 里既有的 abandoned 清理纪律（删 pending 条目 + reject；已 settle 时是 no-op）。
② 缺省回调 = 每次失败落一条 `console.warn('[agentia] OTLP metrics 导出失败:', …)`，
与 traces 侧 flushSinks 同款（每次都打，不做一次性降噪 —— flushSinks 就是每次）。

**影响面**：`src/integrations/mcp-stdio.ts`、`src/integrations/metrics-otlp.ts`、
`src/integrations/metrics.ts`（选项注释）、`tests/integrations/mcpConnector.test.ts` +1
（变异验证：摘掉 abort ⇒ 新用例红）、`tests/integrations/metrics.test.ts` +1、
`docs/usage-guide.md`（metricsSink `onExportError` 行与已知边界行）。
### 2026-10-13 ⑦：守卫射程轮（批次 4）—— CLI 纳入 exactOptionalPropertyTypes、e2e:mcp:server 进 CI、三处货架补齐

**起因**：五路深度评审（`docs/reviews/2026-10-13/project-deep-review.md`）批次 4「守卫射程」，
两类中等 + 三处低等，全是**门禁的射程**问题而不是行为缺陷：

- **D2**：`exactOptionalPropertyTypes` 的守卫（`tests/architecture/tsconfig-strictness.test.ts`）
  只读根 `tsconfig.json` —— `packages/cli/tsconfig.json` 与 `tsconfig.templates.json` **没开**
  这个开关却天天在编译，等于「显式 undefined 覆盖缺省」那类防线（2026-09-18 ⑦，39 处）
  在 CLI 一半代码上**无声缺位**；
- **D1**：`scripts/e2e-mcp-server.ts`（MCP 反向桥端到端）全仓零自动化 —— 不在 verify-all
  8 步（**不能**加第 9 步：verify job 名写死步数，见 AGENTS.md），也不在 CI 六个 job 里；
- **E2**：inspector 的 STATIC 静态资源白名单硬编码文件名，而 copy-assets 是**整树递归**拷贝
  —— trace-view 拆出一个新模块文件时拷贝带上、白名单没有 ⇒ 浏览器 404、面板白屏，
  node 侧单测照样全绿（它们 import 的是 TS 源）；
- 低等三项：CI 各 job 无 `timeout-minutes`；guards-registry 的货架漏 `tests/scripts`
  （三个文件其实早已登记在表，货架本身漏登）；`layering.test.ts` 用裸正则读**原始文本**，
  注释 / 模板字符串里写一句 `from './x.js'` 就会造出一条假依赖边。

**决策**：

- **D2（本条唯一改类型的语义项）**：两份 CLI 配置开 `exactOptionalPropertyTypes`（连同
  `forceConsistentCasingInFileNames`）。对照根 tsconfig **逐项核对**的结论：
  `lib` / `esModuleInterop` 由 `target` / `module: NodeNext` 隐含（写出来是冗余，不写）；
  `declaration` / `sourceMap` 是框架包**发布产物形状**的决定（CLI 只发 bin、不发类型，不加）。
  暴露的 6 处类型错按三类角色纪律修：`SpanDiff` / `ToolIoEvent` / `ExportRecordMeta`
  是**结果记录** ⇒ 必填 `T | undefined`（这三个文件本是框架侧的移植副本，框架侧早就是
  这个形状，CLI 侧只是补齐对齐）；`HarvestRow.messages` 是**内部管道** ⇒ `?: T | undefined`；
  `harvestEvalCase` 的 `messages` 是**公共入参** ⇒ 签名不动、调用点条件展开。
  守卫射程同时扩到**发给用户**的模板 `templates/tsconfig.json`（同开关；同一份代码已在
  `tsconfig.templates.json` 下过该开关 ⇒ 生成物必过），四份配置一并钉进守卫。
- **D1**：CI 加独立 job `e2e-mcp-server`（离线零网络、不需要 uv —— 与 `e2e-mcp` 的
  「回落夹具」不同款，CI 与本机同一条路）；登记进 `verify-all.sh` 的 `ci_only`
  （必需检查），`CONTRIBUTING.md` 合并契约与坑表、`AGENTS.md` 的 CI 段落同步。
  顺手修了 wiring 守卫的一个真缺陷：job 匹配从 `\b` 换成排除连字符延续的边界 ——
  `\b` 把 `-` 当边界，`e2e-mcp` 会匹配进 `e2e-mcp-server` 里（一个 job 被数成两个，
  兜底扫描当场误报 `examples/observability-mcp/README.md`）。
- **E2**：STATIC 白名单**保持显式**（放行谁进面板是安全决定，不该由目录内容自动放行），
  新增 W5 守卫（`packages/cli/test/structure.test.mjs`）按 `dist/inspector` 的**实际文件**
  与白名单做双向集合相等 —— 计数算出来、不写死，白名单仍是人批的。
- **低等**：CI 七个 job 各补 `timeout-minutes`（verify 30 / import-floor 15 / e2e-mcp 15 /
  e2e-mcp-server 10 / lint 10 / docker-image 20 / deploy-website 20）；`SHELVES` 加
  `tests/scripts`；`layering.test.ts` 的解析改走 `lib/source-scan.ts` 遮蔽器（与
  file-cycles / no-runtime-deps 同一个扫描器）。

**验证**：wiring 守卫先红（CONTRIBUTING 列表 / 坑表 / AGENTS.md 圈码各咬住一条）后绿；
CLI 移植对拍三套件（diff / export / harvest，22 条）绿 —— 对拍比的是运行时产物，类型
标注收紧不影响；W5 变异验证（往 `dist/inspector` 丢一个白名单外的 `graph.js` ⇒ 恰该条红，
删除还原绿）；layering 换扫描器后 10 条用例全绿（含阳性对照与解析计数下限），另做反向
验证（注释 / 块注释 / 模板里的假 `from` 不再被读成依赖边）。
### 2026-10-13 ⑧：深度评审低等项收口（engine）—— 耗尽出口留文本 / 取消窗口 / 截断摘要单源 / stdio 监听摘除 / 反向桥 trace 闸


**起因**：2026-10-13 五路深度评审（`docs/reviews/2026-10-13/project-deep-review.md`）的五条
低等项，全部落在 engine 的「非正常路径口径不一致」上：

1. **`max_iterations` 出口丢 `finalText`**：循环耗尽时 `finalText` 保持 `''`，而
   `max_tokens` / `refusal` / `budget_exceeded` 都保留已产出文本。修法：主循环每回合
   先刷新 `finalText = textOf(message)`，各终态分支再按终态语义覆写 —— 耗尽出口自然带上
   最后一回合的文本，与其他出口同口径。
2. **「消息已收、工具未跑」窗口不查 signal**：`streamTurn` 成功返回后到 `executeTurnTools`
   之间没有 `signal.aborted` 检查，abort 落在窗口内整批工具副作用照跑（续跑入口同场景
   明确拒绝，两处口径不对称）。修法：进工具执行前补一次检查，已取消则按 `aborted` 收尾
   （带结构化 error），一个工具的副作用都不发生。
3. **`snapshot()` 截断摘要每次调用生成新时间戳**：多次调用彼此不一致、且都与增量流里那一条
   对不上（`core/trace.ts` 的折叠契约在「设了 maxEvents 且真截断」的 run 上变假）。修法：
   摘要在首次 `snapshot()` 时生成并缓存，同一对象复用于后续每次 snapshot 与增量出口
   （增量仍只派一次）。
4. **stdio 反向桥 stdout error 监听器只挂不摘**：监听器挂在进程级 `process.stdout` 上，
   `close()` 只摘 stdin 的 ⇒ 多次 `createMcpServer` 累积。修法：close 时一并
   `process.stdout.off('error', …)`。
5. **MCP 反向桥不暴露 `traceLimits` / `maxEventChars`**：每次 `tools/call` 一棵 trace
   无事件数闸，子 agent 类工具在桥内长跑时 trace 体积无界。修法：`McpServerOptions` 补
   这两个旋钮 —— `traceLimits` 构造期过 `resolveTraceLimits`（与 run 入口同一个判定器，
   坏值响亮抛 TypeError）、透传进桥内 `TraceRecorder`；`maxEventChars` 透传给
   `tool.input` / `tool.output` 载荷装配。缺省与引擎缺省逐字一致（不设 = 不限 /
   `DEFAULT_EVENT_CHARS`）。

**影响面**：`src/engine/`（loop.ts / tracer.ts / mcp-server.ts / mcp-server-stdio.ts）+
各自测试。无公共导出增删（只给既有 `McpServerOptions` 加字段）。
**验证**：`tests/engine/loop.test.ts`（耗尽留文本、窗口内 abort 不跑工具）、
`tests/engine/trace-limits.test.ts`（多次 snapshot 摘要逐字一致且与增量流同一份）、
`tests/engine/mcp-server.test.ts`（listenerCount 不累积 / 构造期坏值 / 闸与截断透传）；
`npm run e2e:mcp:server` 全绿。
### 2026-10-13 ⑨：TaskStore 副本契约坐实 —— 内建 store 的 `save` 入库与 `get`/`byIdempotency`/`list` 出站全走 `cloneTaskRecord`

**起因**（五路深评 B2）：`TaskStore.get` 的契约注释早就写着「返回的必须是反序列化副本 /
快照，不是内部活引用」，而 `InMemoryTaskStore` / `FileTaskStore` 两个内建实现交出的就是
活引用 —— 声明写下去了实现没跟上。真实后果：transport 的纪律是「先变异 rec、再
`await save` 落库」（approve / 恢复路径的「重读 → 改 status → 先落库再派发」），活引用下
`FileTaskStore.save` 同步抛错（磁盘满）时变异**已经进了内存 Map** ⇒ approve 重试撞 409
（状态已是 running），任务搁死到重启；`fsStore.test.ts` 那条「落盘失败内存不推进」用例
恰好只用**新记录**，测不到「改活记录 + append 抛错」这一格。

**决策**：

- **副本契约双向坐实**：`save` 存副本（内存推进只许由 save 驱动：调用方两次 save 之间的
  中间态对其他读者不可见，save 失败时污染不留在库里），`get` / `byIdempotency` / `list`
  一律交副本。唯一落点是 `store.ts` 的 `cloneTaskRecord`。
- **克隆件不是序列化往返**：递归克隆数组与**纯对象**（原型为 `Object.prototype` 或 null），
  函数与类实例**按引用保留** —— `spec.options` 里合法装着 `AbortSignal` / `ModelClient` /
  工具的 `run` 等进程内对象，`structuredClone` 遇上它们直接抛 `DataCloneError`
  （sqlite/redis 序列化时本来也丢它们，见 `RunInvocationOptions.fallbacks` 的序列化边界注释）。
- **性能取舍（如实记录）**：`get` / `list` 现在每次付出与记录体积成正比的克隆成本
  （记录含完整 trace）。接受它的理由：sqlite/redis 每次读本来就付全量反序列化，内建
  store 只是对齐到同一成本模型；「换宿主不换语义」（§6.6）的前提恰恰是各实现的行为
  一致 —— 引用语义是 InMemory/File 独有的**意外**，不是可以保留的性能特性。
  `resumePending` 的全表 `list()` 克隆是扫描量级的一次性成本，不在高频路径上。
- **行为变化（要如实说的）**：终态那次 save 抛错时，库里**诚实地停在最后一次落库成功的
  状态**（running）而不再是「引用语义下内存已被原地推进成终态」—— 这正是
  `onPersistError` 要对账的那一格，此前被引用语义遮掉了。`async.test.ts` 两条用例的
  断言随之从「库里已是 succeeded」改成「库里停在 running」。

**影响面**：`src/store/store.ts`（cloneTaskRecord + 两个实现的四个读/写点）、
`src/store/fsStore.ts`（同款四点）；`AsyncRunner.submit` / `#claims` 的去重返回从浅拷贝
升级为 `cloneTaskRecord`（低等项「浅拷贝与活记录共享嵌套对象」随本件一并收口 —— 评估结论
是**需要做**：HITL 挂起会整体替换 `rec.spec.messages`，浅拷贝的提交快照照样被穿透）。
**验证**：`tests/store/taskStore-copy.test.ts`（新：两实现 × get/save/byIdempotency+list
副本断言、AbortSignal 按引用保留、改活记录+append 失败内存不推进）；既有套件里依赖
「poll 回来改字段即生效」的三处用例改为显式 `save` 后再判（approval / durable-timer /
run-outcome）。

### 2026-10-13 ⑩：cancel 与推进路径的互斥闸 —— `#cancelInflight` 对侧闸 + `#executeInner` 取消意图闸

**起因**（五路深评 B1）：`#cancel` 不共享 approve 的在飞闸 / signalTask 的串行链 /
wakeDue 闸 / 槽位后的 readClaimed 重读 —— 25 条 cancel 用例全是串行时序。两扇窗都真实：
① cancel(suspended)×approve 并发：两边各凭旧快照读-改-写，后写的把 cancelled 覆盖回
running ⇒ 任务取消后照常执行、`onFinished` 双发（`#cancelSettled` 当时只对 queued 分支
登记）；② cancel(queued)×槽位释放并发：等槽位那趟 `#executeInner` 的 readClaimed 读到
cancel 落库前的快照，照常置 running 落库 ⇒ 「被取消的排队任务绝不起跑」不成立。

**决策**（三件合力，各有不可替代的一段）：

- **`#cancelInflight`（per-task 在飞闸）+ 互为对侧**：cancel 进入前先等该任务的在飞推进
  （approve / signalTask / wakeDue 三条，经各监督件新增的 `inflightFor` / `inflightWakeFor`
  读数）收口、**重读**记录再判；推进路径进入前同步看一眼 cancel 闸 —— approve / signalTask
  等它收口后重走（signalTask 必须**入链之前**等：链尾一旦被 cancel 当「在飞推进」等就是
  死等）；到期唤醒 / 审批超时是**惰性**路径，见闸即跳过本轮（下轮再判，不丢事）。
  两侧的「查对方闸 + 登记自己闸」都在**同一个同步段** ⇒ 先登记者赢，没有缝隙；等待方
  都不在持有自己闸的状态下等对方 ⇒ 无死锁。并发 cancel 同任务也串行（后者等前者收尾
  重读，多半撞 409）。
- **cancel 的临界段原子落库**：不再走 `#safeSave` 的微任务延迟 —— 落库推迟一个微任务，
  「重读再判」那几条路就会在缝里读到取消前的旧状态。同步 store 下 cancel 的
  get→落库因此是原子的，无在飞推进时维持同步快路径（同步抛 404/409 的既有语义不变）。
  失败口径与 `#safeSave` 相同（不遮罩 + `onPersistError`），上报逻辑抽成
  `#reportPersistError` 共用。
- **`#executeInner` 起跑前的取消意图闸**：意图（`#cancels`）在 cancel 临界段**入口**就立
  （先于落库可见），且生命周期收紧为「还有活着的 `#execute` 就不摘」（四个出口：run 收尾 /
  意图闸 / cancel 的 finish / `#execute` finally 兜底）。意图在场 ⇒ 绝不起跑，记录落
  cancelled，**记账归 cancel** —— 这是 `#cancelSettled` 的第二个生产者（覆盖面从 queued
  补齐到「被并发恢复路径派发出来的 suspended 取消」），登记者与消费者同为那趟
  `#execute`，不泄漏。

**影响面**：`async.ts`（闸 + 意图闸 + 临界段原子落库）、三个监督件各加一个
`cancelInflight` 注入读数与一个 `inflightFor` 出口（依赖仍单向：回调注入，无 import）。
**验证**：`tests/transport/cancel-race.test.ts`（新）：cancel×approve 两个方向
（approve 先赢 ⇒ cancel 409「已受理未起跑」、任务跑完、onFinished 恰好一次；cancel 先赢
⇒ approve 重读见 cancelled 409、工具零执行）；cancel×槽位用「读过期快照」夹具
（`StaleOnceStore`）复现窗口 ⇒ 意图闸拦下、绝不跑、不双发、终态不被覆盖。

### 2026-10-13 ⑪：恢复路径的落库失败防护 —— 认领 save 接同步抛错，三处 catch 不再静默留尸

**起因**（五路深评 B3 + 低等项）：`resume-scanner` 的认领循环里 `store.save(rec)` 没有
try/catch（同文件 `#wakeDueInner` 有）—— FileTaskStore 磁盘失败时异常**同步逃出
resumePending**（宿主启动路径直接崩），引用语义 store 下「queued + 本进程 ownerId」的
变异已进内存 ⇒ 后续扫描按 own-process 跳过 ⇒ 搁死到重启（⑨ 的副本契约把「污染内存」
那一半也关掉了，但同步抛出这一半必须在调用点接）。且三处恢复路径
（认领 / 审批超时 / 到期唤醒）落库失败都是 catch 后裸 return —— 静默留尸，对照
`#dispatch` 的停机拒绝都有一次性 warn。

**决策**：

- 认领 save 同步抛错 ⇒ **接住、warn、不派发、不计入推进数**（返回值是「推进了几条」的
  承诺，没落库就不是推进）；异步 reject 同款（此前它会让 `Promise.all` 整批 reject，
  resumePending 的调用方多半不接 ⇒ unhandled rejection）。
- `#wakeDueInner` / `#expireAndResumeInner` 的两个 catch 分支各补 `console.warn`
  （带 taskId 与错误消息）。不做「一次性」去重：这两处是**每任务每故障一笔**，与
  `#dispatch` 那种「同一窗口同一原因刷 N 条」不同构。
- 三条路径语义不变：落不了库 = 不派发（先落库再派发），下轮惰性扫描还会再判。

**验证**：`tests/transport/resume-scanner.test.ts`（新，直接构造监督件 + stub store）：
认领同步抛 / 异步 reject 各一条（不逃出、不派发、warn、计 0）+ 阳性对照（正常认领照常
派发）；wakeDue 两个分支的 warn；审批超时恢复的 warn；cancel 在飞时两条惰性路径跳过
本轮（含阳性对照）。

### 2026-10-13 ⑫：Scheduler 感知 drain —— 停机窗口里 tick 静默跳过

**起因**（五路深评低等项）：runner drain 之后 `submit` 必抛「正在优雅停机」，Scheduler
的 `dispatch` 没有 drain 闸 ⇒ 停机窗口里每个 tick 换一条 `console.error`（纯刷屏；
停机语义本来就是「不再往前推」，跳过 tick 不是故障）。

**决策**：`dispatch` 开头查 `runner.isDraining`，在停机即**直接返回**（静默 —— 与
`wakeDue` 的 drain 闸同口径；宿主此刻的义务是退出，见 `drain()` 契约）。选静默而非
一次性 warn：调度器的 tick 是周期事件，「停机后没再派活」由 drain 本身的语义覆盖，
再加一条 warn 是给必发生的事件造噪音。

**验证**：`scheduler.test.ts` 新增：drain 前正常派发、drain 后 ≥4 个 tick 零新增调用、
`console.error` 零调用。
### 2026-10-13 ⑬：能力排行的 usage 只认顶层 capability（嵌套去重，E1）

**起因**：2026-10-13 五路深度评审（`docs/reviews/2026-10-13/project-deep-review.md` E1）：
`packages/trace-view/src/summary.js` 对每个 capability span 累加 `span.usage`，而框架侧
capability.usage 是其**子孙 llm.turn 的聚合**（tracer 收尾时就地算，§9）⇒ `@SubAgent` 套
`@Skill`（装配期允许）时同一批 token 在外层 subagent 行与内层 skill 行**各计一次**，
tokens / costUsd 列不可加总 —— 与 `core/trace.ts`「capability 聚合不进 totalUsage，
避免重复计数」的纪律直接冲突。CLI `report`、`dev` 面板、官网 playground 三处共用同一份
实现，同漏。

**决策**：

- **聚合时跳过嵌套在其他 capability 下的 capability span 的 usage（只计顶层）**；内层行仍计
  calls / errors / 耗时 —— 那是它自己这次调用的真账，不重复。效果：每条 llm.turn 的 token
  只落在它的**顶层** capability 祖先行里 ⇒ 各行 tokens / costUsd 可加总。
- **没选「从 llm.turn 重新归账」**：手写 / 外来的 trace（`report` 明言支持的输入形态）可能
  只在 capability span 上带 usage、而没有嵌套的 llm.turn 子孙，重算会把这类成本**静默清零**。
- 引擎与 tracer 行为不动（capability.usage 的「子孙聚合、仅供展示」语义不变）—— 变的只是
  **展示层的加总口径**。
- CLI `report` 的 run 成本仍取 `totalUsage.costEstimate`，不从能力行反加（理由随本次更新：
  能力行覆盖不了 run 根直属的 llm.turn，反加会**漏**）。⚠️ `buildRunReport`
  （`src/integrations/report.ts`）有同款嵌套累加模式，本次**刻意不碰**（评审未点名，
  另行评估）。

**影响面**：`packages/trace-view/src/summary.js`（+spanId 索引与上爬判定）、
`packages/trace-view/test/summary.test.js`（+嵌套夹具）、
`packages/trace-view/test/structure.test.js`（棘轮 130 → 153）、`packages/cli/src/report.ts`
（注释更新）、`docs/usage-guide.md`（口径说明）。
**验证**：嵌套夹具断言「内层行 tokens / cost 为 null、各行可加总」；变异（去掉顶层判定）
当场咬住；`verify-all.sh` 8/8。

### 2026-10-13 ⑭：`buildRunReport` 的嵌套去重补齐 —— 与 ⑬ 同款判定下沉到框架公共面

**起因**：⑬ 修的是 trace-view 的 `summarizeTrace`（CLI report / dev 面板 / playground 三处
同源的展示层）；施工中发现 `src/integrations/report.ts` 的 `buildRunReport` 有**同款**
嵌套累加（对每个 capability span 累加 `span.usage`，而 capability.usage 是子孙 llm.turn
的聚合 ⇒ `@SubAgent` 套 `@Skill` 时同一批 token 内外层各计一次）。⑬ 当时刻意不碰它
（评审未点名、且它是 `src/index.ts` 导出的**公共 API**，改口径 = 改公共面输出形状），
本条是它的收口。

**决策**：与 ⑬ 完全同款 —— 建 spanId 索引沿 `parentSpanId` 上爬判 capability 祖先
（带防环），嵌套行的 usage 不累加（`tokens` / `tokensTotal` / `costUsd` 为 `null`），
calls / errors / 耗时照计（它自己这次调用的真账）⇒ 各行可加总。同样不选「从 llm.turn
重算」：手写 / 外来 trace 可能只在 capability span 上带 usage。消费方
`examples/observability-mcp`（`report_trace` 工具）随之得到正确口径，无需改代码。

**影响面**：`src/integrations/report.ts`（嵌套判定 + 头注口径）、
`tests/integrations/report.test.ts`（+1 嵌套夹具：去掉顶层判定即红）、
`docs/usage-guide.md`（§6 的 `buildRunReport` 行补口径）。

## 11. 开放项

- **`traceLimits.maxEvents` 的截断在增量出口没有信号**（2026-09-28 外部深评 P3-1）：
  **⇒ 同日 ⑧ 已落地**（截断开始那一刻 `emit` 一条一次性 `trace.truncated` marker，见 §10 ⑧）。
- **`task.event.delivered` 的时点超前于事实**（2026-09-28 外部深评 P3-2）：
  **⇒ 同日 ⑧ 已落地**（改名 `injected`，口径「注入进本段消息流」，见 §10 ⑧）。

- **事件缓冲 `pendingEvents` 要不要有上限**（2026-09-28 复审第二轮发现的分叉，**未做**）：
  同一条记录上的 `deliveredEventIds` 是有界 FIFO（256，理由写在 `async.ts` 那个常量的注释里：
  无界会让记录随事件量膨胀，而记录随 trace 一起落库、每次 save 全文重写），**事件缓冲本身却
  没有上限**，也没写「为什么它可以无界」。累积路径是真的：恢复段再次挂起时事件**刻意不注入**
  （§10 ⑥ 第 4 条），于是每投一次都留在记录上。两条形态：
  **A** 满了丢最旧 —— 必须**同时**把该 id 从 `deliveredEventIds` 里摘掉，否则发件方重投会拿到
  「已投递」的 409、而事件其实已经没了（**静默丢事件**，正是最坏的那种）；
  **B** 满了拒绝并说出来（409/429，与 cancel / 审批的「说出来，不静默」同款）。
  倾向 **B**（不丢 + 有信号）。**⇒ 同日下午第三轮已定案并落地：选 B**（`#signalInner` 到
  上限就 409、文案说清本次事件没有被记录；上限 64），见 §10 2026-09-28 ⑥ 复审第三轮补记。
- **redis 侧的到期索引**（§10 2026-09-28 ⑤ 复审补记）：触发条件已满足（`list()` 是 SCAN 级真查询、
  比 sqlite 更贵），但**没有读数**且形态要另定（辅助 ZSET 或键名编码）⇒ 先不做，
  等基准补上 redis 那一档读数再拍。**⇒ 读数已到**（`scripts/bench-redis-due.ts`，形状量）：
  一次 `list()` = 往返 1+N、纯 CPU 57ms@10k、外推 0.2–2 s/轮（RTT 0.1–1 ms）、N=100k 时外推
  10–100 s ⇒ **值 = 值得做**；形态候选辅助 ZSET（score = `wakeAt`），往返降到 1 + 到期数。
  实现未做，待定案（§10 2026-09-28 ⑤ 同日晚补记有全部读数与边界）。
- **菜单漂移的严格模式与结果级字段**（§10 2026-09-27 ⑧ 未做的那两件）：① `menuDrift: 'fail'`
  这类开关 —— 要动公共选项面 + `limits.ts` 真源表；② 让「续跑跑在漂移的菜单上」直接出现在
  `AgentRunResult` 上（而不是只落在 trace 属性里）—— 要动公共结果类型。现状是三处信号
  （`menu.drift` 事件 / 父 span 属性 / `console.warn`）：够「可查询」，但调用方得主动读 trace。
- npm 包拆分（core / runtime / transport）仍待做；CLI 已独立成包（workspaces），框架本体仍单包。
  **宿主 / 集成接入不拆包**（gRPC / Kafka 这类只给配方 + 示例，判别规则与升级触发条件见 §10 2026-09-18 ⑪）。
  ⇒ 发布进度：v0.2.2（2026-09-14，框架包 + CLI 包，scope 为 `@migor/*`）→ v0.3.0（`.env` 一等入口）
  → v0.4.0（trace 事件正文可展开）→ v0.4.1（深度审查修复轮，无新公开 API）
  → v0.4.2（发布后更正：Redis 的 TTL 在 node-redis 上静默失效）
  → v0.5.0（R7 质量闭环：`Score`/`attachScore`、gen_ai.* 对齐、trace 回流 eval、prompt·session 上 trace）
  → v0.6.0（trace diff / 分叉重放 / canCall 能力级路径 / 默认 client 自研化 + 公共类型自有化
  （零运行时依赖）/ examples/code-review 真实案例；**含破坏性变更，迁移指南见 CHANGELOG**）
  → v0.6.1（超时归一类账：`span.error.type` 的 `connection` → `timeout`，**重试行为不变**；
  MCP 超时单源化；对外文档面清理）；
  → v0.6.2（第六轮全量 review 收口：16 条「静默失效」修复 + `beforeFlush` 时序缝
  （eval 分数进指标）+ metrics 三维度基数封顶 + traceparent 入站关联；**无破坏性变更**，
  两处语义变更见 CHANGELOG）；
  → v0.6.3（守卫注册表 + 三个新架构守卫 + 适配器对拍矩阵；`exactOptionalPropertyTypes`
  迁移完成；OpenAI 适配器补客户端内层重试与 anthropic 对称；**无破坏性变更**）；
  → v0.7.0（**MCP 连接器出厂自带**（stdio / StreamableHTTP，只用标准库、不新增第三方依赖）
  + 第七轮复审收口 + StreamableHTTP 会话过期**自愈** + `close()` **保证子进程已终止**
  + 官网手写数字守卫；**无破坏性变更**）；
  → v0.7.1（**HITL 人工审批**（挂起/恢复、跨进程耐久）+ gRPC 宿主配方与可跑示例
  + 连续四轮复审收口：11 条「不报错地不干活」（超时不清簿记 / 重试不排空 / 非流式回落零校验 /
  回调通道缺失 / 幂等键赢家跨重启易主）+ 预算护栏走廉价 usage + 异步会话正式通道
  （`RunInvocationOptions.sessionId` + `AsyncRunner.sessionStore`）+ 测试基建不再被 `&&` 静默
  跳过；**类型面破坏性变更**：`RecorderBackend` 加必填 `usage()`、`BudgetGuard.check` 入参收窄
  —— 运行时行为不变，迁移见 CHANGELOG）；
  → v0.7.2（**第九轮评审收口**：HITL × `sessionStore` 组合破口（恢复段历史翻倍 / 成功后毒化
  会话）+ 六条静默失效修复（惰性审批超时无重入闸 / StreamableHTTP 丢 `abandoned` /
  Anthropic 流内 4xx 落 500 / `runTimeoutMs` 落 `unknown` / `FileTaskStore.save` 先写内存 /
  SSE 稀疏数组）+ `metrics.ts` 与 `mcp.ts` 纯结构拆分 + stdio `pending` 回归补课；
  **无破坏性变更**）；
  → v0.8.0（**CLI 机器可读面**（`--version` / `report·diff·doctor --json`）+ **脚手架
  discover 生产路径修复**（≤0.7.2 生成的工程 `npm start` 必崩，缺陷在产出物里，老工程需
  按新模板改 `src/main.ts`）+ 脚手架 pin 住 CLI 进 devDependencies；纯结构拆分 13 件 +
  零告警闸门 + 覆盖率棘轮门禁；**框架 API 无破坏性变更**）；
  → v0.8.1（**出站链路传播**：新增 `currentTraceparent()`，跨服务关联补上出站方向；
  id 投影上移 `core/trace.ts` 成单一真源（取值不变）；**无破坏性变更**）；
  → v0.8.2（**外部双模型复核逐条复现收口**：OTLP enum 整数化（`v0.2.2` 起 `status.code` 一
  直发的是 enum 名字符串，严格 collector 整批拒收 —— 观测全丢却报正常）/ HTTP 200 +
  `partialSuccess` 按导出失败处理 / 新增 `createOtlpExporter({ onExportError })` /
  `metricsSink.reset()` 前移 CUMULATIVE 窗口起点 / `maxRetries` 坏值构造期抛错（NaN 与
  Infinity 此前等于**无限重试**）/ 已中止的 MCP 调用不再发请求、不再永不 settle /
  异步 store 下同键并发提交不再重复执行（跨进程仍 at-least-once）/ 脚手架模板漏写 `clean.mjs`
  在发布前拦下；**框架 API 无破坏性变更**，唯一动作是 `maxRetries` 传过坏值的要改成非负整数）；
  → v0.8.3（**增量 trace 出口落地** —— 记账与交付之间补上那条缺失的缝：`onTraceEvent`
  （运行期逐笔拿记账事件，应用级与单次**叠加**）+ `GET /tasks/:id/stream`（异步任务进度流：
  重放 → 实时 → 终态 `task.end` 收口；旁观者语义，背压不 abort 任务）+ `/run` SSE 新增一族
  `trace.event` 帧（既有三帧逐字不变）+ `traceLimits.maxEvents`（数量闸 + `trace.truncated`
  丢弃计数）；spec §7 F3 的两条后置项与 §9.4 的记录成本同日收口，**采样仍不内建**（既有决策，
  改为「可算（采样率换算表）+ 可数（丢弃计数）」）；`formatTraceparent` 的 flags 继续恒 `00`，
  但理由更正为「运行期不可知」；guards §2 四条待守形状清到只剩一条（`0` 的语义真源 / 穷尽转发 /
  队列配方门禁三件建成机器守卫）；
  **框架 API 无破坏性变更**，宿主自解析 `/run` SSE 的老客户端不认识新帧即忽略、行为逐字一致）；
  → v0.9.0（dev 调试环落地：常驻 runner + inspector 面板驱动 `src/app.ts`，四个控件全在面板上；含**破坏性变更**，但只在脚手架模板形态（装配/启动拆分，迁移见 CHANGELOG）—— 框架公共 API 逐字未变）；
  → v0.9.1（dev 调试环三处体验修复：面板右栏在 run **在飞期间**就长出调用树（增量记账帧经
  `/ingest-event` 原样转发 + 面板按 `seq` 折回，收尾那份整棵 trace 覆盖它）/ 刚跑完的回复不再被
  自动 `open()` 擦掉（端到端实测 17 ms）/ 工作目录选择器能选文件、隐藏目录可达、`浏览…` 不再是
  开关；**无破坏性变更**，框架公共 API 逐字未变）；
  → v0.9.2（dev 面板可读性三处：模型正文按 Markdown 渲染（`packages/cli/src/markdown.ts`，
  自己写的零依赖解析器，**按构造不产生 HTML** —— 只产出 token 树、渲染层只准 `createElement` /
  `textContent`，链接只认 `http`/`https`/`mailto`）/ 滚动分层（整页不滚，左栏列表与右栏调用树
  各自滚，回复·排行·用量固定在下方且各有上限）/ 长正文默认折叠（`collapseDecision` 按**行数 +
  字符数**判定，不量像素）；另修掉 CLI 套件两条文件监视用例的**夹具竞态**（`writeUntilSeen`，
  纯测试侧、无使用者可见行为）；**无破坏性变更**，框架公共 API 与模板形态逐字未变）；
  → v0.9.3（dev 面板两个真用户反馈的落地 + CLI 内部结构治理：原生文件夹选择器（契约
  `POST /api/fs/pick`，取消判定认错误码 `-128` 不认英文文案；面板刷新 / 关标签页**显式通知**
  服务端收掉在飞的选择框 —— 只靠连接断开那条路在刷新时够不着，实测浏览器不关那条连接）/
  模板 `read_file` 能力新增 `list_files`（输出**首行即工作目录**、目录带 `/` 后缀、200 条上限且
  截断明示）/ `dev.ts` **1148 → 776**（隐式状态机 → `dev-machine.ts` 显式状态机：26 事件 /
  17 效果 / 28 条矩阵单测；`dev-logic.ts` 六个纯判定单源）/ `inspector.ts` **818 → 413**
  （路由表切到 `inspector-routes.ts`，14 条路由条件与状态码分布逐条一致）；另四条仓库守卫
  落地（零运行时依赖 / CLI 结构 W1-W2-W3 / `docs/**` 的提交引用必须在主干上（配 CI
  `fetch-depth: 0`）/ 0 反射），`docs/guards.md` §2「待守」随之清空；**无破坏性变更**，
  框架公共 API 与脚手架模板形态逐字未变）；
  → v0.9.4（成本口径补齐（`cacheRead`/`cacheWrite` + 图片按尺寸上界估）+ 三个「旋钮设成 0 就
  静默失效」的洞改成构造期响亮失败 + 大载荷不再灌进摘要器（`tool_result` 内嵌图片块 / `tool_use`
  参数，实测 200 086 字符 / 50 022 token ⇒ 32 字符 / 3 139 token）+ 评测即发布闸门（配方 +
  `examples/eval-gate/`）+ 官网 agent 可读面（每页 `.md` 变体 + `Accept: text/markdown` 内容协商）
  + `§7 已知边界` 立守卫与 `killPlanFor` 可测化；**无破坏性变更**，框架公共 API 与脚手架模板
  形态逐字未变（三个旋钮的 `0` 原本就静默失效，改成启动期报错 —— 没有任何本来能工作的配置会因此变坏））；
  → v0.9.5（**外部深评 P2 表最后三条收口**（K5 记忆回写可选 CAS / T4 非终态流缓冲配额 /
    K2 四类能力注册表）+ 两处判据订正；**无破坏性变更**）；
  → v0.10.0（**对外承诺从「文档上的一句话」改成可执行的断言**（稳定性策略 / 三个不发布的包 / CI 运行环境 / README 数字现算 / `exports` 收窄）+ **补齐上线与选型的对外表达面**（`docs/deployment.md` / 官网 `/tradeoffs` / 推广稿定稿）；**有破坏性变更**：深路径导入会被拒，迁移见 CHANGELOG 的迁移小节）；
  → v0.10.1（**从「看得见一次 run」到「留得下、比得出」**：dev 面板每次 run 收尾落盘
    `.agentia/traces.jsonl`（恰好是 `report` / `diff` / `harvest` / `export` 四个命令的输入）
    + 并排比两条 run（含「改一句 prompt 立刻重跑对照」的自动补对）+ `packages/trace-view`
    补规模棘轮与三条行为断言 + §7 补登记两条长跑边界；**无破坏性变更**，框架代码零改动，
    新增一处用户可见文件 `traces.jsonl`（只增不减））；
  → v0.10.2（**对外那一面各做实一格 ——「能不能被找到、能不能 5 分钟跑起来」**：脚手架默认入口翻成
    可上线的 HTTP 服务（`npm start` 直接起服务，一次性挪去 `batch.ts`）+ 官网全站英文版（`/en`，
    五页逐节对译 + 英文 404 + 语言自动检测与手动切换）+ 两轮**纯结构**重构（方法级体量闸与三处巨型体
    外移；`#executeInner` 结果记账外移 + 14 条直接单测）+ c8 分支覆盖率棘轮 88 → 89；
    **无破坏性变更**，框架公共 API 与 `exports` 逐字未变（本版唯一碰 `src/index.ts` 的是版本常量
    那一行），脚手架是**生成物** ⇒ 既有使用者不需要任何动作）；
  `AGENTIA_VERSION = '0.10.2'`。决策均见 §10。
- DI 的 property-injection 便利写法（标准装饰器下可行）待定。
- 模型缺省 `claude-opus-5`（`AGENTIA_MODEL` env 可覆盖）；两个内置客户端（Anthropic / OpenAI 兼容）默认走流式。
- CLI 剩余：注册表与扫描混用时的冲突提示策略（`dev` 已落地并内建 inspector 面板；`add` 已落地，见 §10 R5）。
