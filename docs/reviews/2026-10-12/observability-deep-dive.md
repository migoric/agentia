# 可观测深钻（二）：按 2026 主流 agent 框架的现状，再看 agentia 还能做什么

> **与 `docs/reviews/2026-10-11/framework-review-v0.10.2.md` 的关系**：那份的 §5 只把可观测分成了
> A/B/C/D 四块方向，没落地。这份把它推到「外部现状 → 本仓读数 → 能补 / 只该写配方 / 不该做」三档。
>
> **阅读约定**：凡「本仓事实」都带现查命令（附录 A）；凡「外部事实」都带来源，**没回源的集中在 §6**。
> ⚠️ 本文不含任何**性能数字**（基准刻意不进 CI，见 `tests/docs/bench-numbers.test.ts`）。

---

## 0. 结论先说

2026 的主流框架在「agent 可观测」上收敛成了三件事：

1. **三套 span 词汇表在互相翻译** —— OTel GenAI semconv / OpenInference（Arize）/ 各框架自家。
2. **协议自己把跨进程的 trace 载体定死了** —— MCP SEP-414 把 `traceparent` 钉进 `params._meta` 的**裸键**。
3. **评测的判据从「答案对不对」变成「轨迹对不对」** —— 而轨迹的判据，**大多是 trace 的纯函数**。

本仓在这三件上的位置：

| 面 | 位置 | 依据 |
|---|---|---|
| 轨迹评测 / 可重放（第 3 件） | 🟢 **先天占优** | trace 与 `Score` 都是一等公民；`traceToMessages` / `forkMessages(trace,{atTurn})` 已可重放；增量事件缝已存在 |
| 跨进程 MCP（第 2 件） | 🔴 **零命中** | MCP 桥（**客户端 4 文件 + 服务端 3 文件**，共 7 个）里 `_meta` / `traceparent` **一个都没有**（现查，见 §3 G1）；而 **MCP Python SDK 已经在照 SEP-414 注入**（§1.2）。⚠️ 2026-10-12 追记：**#235 已合入主干**（`ad402e8`；落地状态见 §4 末尾） |
| span 词汇（第 1 件） | 🟡 **落后半步** | 普通 `@Tool` 与审批**只发事件、不建 span**；上游把 `execute_tool` 当**一等 span** —— 2026-10-12 抽查 6 家框架**六中六**都发（§1.7） |

> 另有一条**已知边界**不属于上面三件事：本仓 OTLP **只发 JSON** ⇒ 打不过只收 binary 的接收端
> （已回源到反例：**Phoenix 会 415**）。处置是**配方**不是改核心，见 §6.5b / §3 G10。

**一句话**：本仓不缺可观测，缺的是两样 —— ①**把已有的记账换个投影发出去**（导出侧的事，不用动 engine）；
②**把 trace 当评测基底的几条配方**（缝外的事，不用动核心）。

---

## 1. 外部现状（2026-10 现查）

### 1.1 三套词汇表，和一张翻译表

| 发生了什么 | OTel GenAI（semconv） | OpenInference（Arize） | OpenAI Agents SDK 默认 span |
|---|---|---|---|
| 一次 run 协调多个 agent | `invoke_workflow` | `CHAIN` | `trace()` + `task_span()` |
| 一个 agent 在干活 | `invoke_agent` | `AGENT` | `agent_span()` |
| 一次模型往返 | `chat` / `generate_content` / `text_completion` | `LLM` | `generation_span()` + `turn_span()` |
| 一次工具调用 | `execute_tool` | `TOOL` | `function_span()` |
| **交接（handoff）** | **没有专门 operation** | **没有专门 kind** | `handoff_span()` |
| **护栏检查（guardrail）** | **没有专门 operation** | `GUARDRAIL` | `guardrail_span()` |

**⭐ 关键观察在最后两行。** 「交接」与「护栏」是**标准没管、每家自己造**的两格 ——
而这两件事**恰好是本仓领域模型里最重的两件**：`@SubAgent` 的交接、`@Tool({ approval: 'required' })` 的审批闸。

⇒ 这一格不是「本仓落后」，是**自由地带**。本仓可以**先定义、再对齐**（而不是等标准）。
   本仓的优势是：这两件事**已经是本仓的一等概念**，而不是事后从别人的框架里猜出来的。

OpenInference 的 span kind —— 初稿写「9 个」，**2026-10-12 回源后是 11 个**：
`LLM` `EMBEDDING` `CHAIN` `RETRIEVER` `RERANKER` `TOOL` `AGENT` `GUARDRAIL` `EVALUATOR` `PROMPT`
`DECISION`（`spec/semantic_conventions.md` 的 Span Kinds 表；代码枚举 `OpenInferenceSpanKindValues`
另有一个 `UNKNOWN` 占位 ⇒ 12 项）。
⚠️ **规范仓自己就不一致**：`spec/traces.md` 的散文只列 **10 个**（漏 `DECISION`）——
同一份规范的正文与属性表各说各话，这是「拿散文当基准」的又一个样本。

**2026 年它已经不只是 Arize 的方言** —— 微软把开放信任栈（ASSERT 评测 + Agent Control Specification
运行时控制）建在它上面，作为「评测 / 运行时控制 / 可观测共用的 trace 契约」。

### 1.2 MCP 把跨进程的 trace 载体定死了（这是本轮最具体的一条）

MCP **SEP-414**（`seps/414-request-meta.md`，**Status: Final**，Standards Track，Created 2025-04-25，
Author @codefromthecrypt —— **原文已取，不是转述**；落地证据见下）：

- `traceparent` / `tracestate` / `baggage` 放在 **JSON-RPC 请求的 `params._meta`** 里，**用裸键**。
- **不许加命名空间前缀** —— 原文：*「differing interpretations could materialize, such as namespacing
  traceparent like `io.modelcontextprotocol.traceparent`, **which will break traces and log correlation**」*；
  SEP 的 Abstract 明写这是个 *「exception to the DNS prefixing convention for keys in `_meta`」*。
- 位置是 `params` 里、与 `name` / `arguments` **平级** —— 不是塞进 `arguments`（原文的非规范示例逐字如此）。
- **为什么在消息体而不是 HTTP 头**：① **stdio 根本没有头**（本地 MCP server 是子进程，stdin/stdout 走 JSON-RPC）；
  ② Streamable HTTP 的头**描述的是错误的层**（一次连接复用多条消息、一次调用可能跨多个 HTTP 请求）
  —— 在 HTTP 层埋点，得到的是「传输的 trace」，不是「工作的 trace」。
  ⚠️ 后半条是**本文的解释**，SEP 原文只写了「stdio 无 header」与「保持与既有实现和 OTel 约定兼容」；
  别把解释当引用。

**「已进 2026-07-28 规范」这条是回源证的**：`docs/specification/2026-07-28/` 目录存在，其 `changelog.mdx`
的 Minor changes 第 2 条逐字写着 *「Document OpenTelemetry trace context propagation conventions for
`_meta` keys (`traceparent`, `tracestate`, `baggage`) ([SEP-414](.../pull/414))」*。
同一份 changelog 里另外两条也在：第 4 条 SEP-2243、Deprecated 第 1 条 SEP-2577。

同一批规范里还有两件相关的：

- **SEP-2243**：`Mcp-Method` / `Mcp-Name` 成为 Streamable HTTP 的**必需头**（给网关 / 限流器按操作路由用，
  不用解 JSON-RPC 体）。原文：*「These headers are **required** for compliance」*，且 *「Servers … MUST
  reject requests where the values specified in the headers do not match the values in the request body」*；
  另附一个 `x-mcp-header` 扩展（服务端把工具参数镜像进头，**客户端 MUST 支持**）。
- **MCP 自己的 logging capability 被废弃**（SEP-2577，与 Roots / Sampling 同批），规范**点名 OpenTelemetry**：
  原文的迁移建议逐字是 *「log to `stderr` (stdio) or **use OpenTelemetry** instead of Logging」*，
  理由写的是「**Standard logging mechanisms … OpenTelemetry for structured observability) are mature,
  widely adopted**」。⇒ 协议没自己发明一套追踪，而是**采纳了企业已经跑着的那套**。

**已经落地的实现**（SEP-414 自己列的 Reference Implementation，逐条都在原文里）：MCP 的 C# SDK、
Python SDK、OpenInference 的 MCP 埋点（Python / TypeScript）、Envoy AI Gateway、Logfire、ToolHive。

**本轮把其中三个 SDK 逐份回源了源码**（初稿这里只做到 Logfire 一句注释）：

| 实现 | 回源结论 | 证据 |
|---|---|---|
| **MCP Python SDK** | ✅ **真做了注入** —— 发请求时在 **CLIENT span** 里把 W3C 上下文注入 `_meta`；服务端建 **SERVER span** 并在其上提取 | `src/mcp/shared/jsonrpc_dispatcher.py:386-395`：`with otel_span(..., kind=SpanKind.CLIENT)` 内 `# SEP-414: inject W3C trace context.` → `inject_trace_context(out_meta)`；`src/mcp/shared/_otel.py` 里 `inject_trace_context(meta)` 的**函数体就是 `inject(meta)`** —— **`_meta` 字典本身即 carrier**，无前缀 |
| **MCP TypeScript SDK** | 🟡 **只做「常量 + 透传」，不注入** | 导出 `TRACEPARENT_META_KEY` / `TRACESTATE_META_KEY` / `BAGGAGE_META_KEY`（值即裸键）＋ 一组 `SEP-414 trace context \`_meta\` passthrough` 回归测试（覆盖 request / response / notification）。改动说明逐字写「the SDK **passes them through untouched**」；全仓 `src/` 里这三个常量**没有别的使用点** |
| **MCP C# SDK** | ⚠️ **未见 trace 键** | `Protocol/MetaKeys.cs` 自述是「well-known `_meta` field keys defined by the MCP protocol and its extensions」，列了 **6 个**键（`protocolVersion` / `clientInfo` / `serverInfo` / `clientCapabilities` / `logLevel` / `subscriptionId`，全部 `io.modelcontextprotocol/…` 前缀）—— **`traceparent` 一族不在其中** |

⚠️ **一个很容易读反的点**：Logfire 那句注释（*「The MCP SDK now emits OpenTelemetry spans and propagates
trace context via `_meta` **by itself**」*）写在一个 `ModuleNotFoundError` 分支里，指的是 **`mcp` 2 / `fastmcp` 4**。
逐 SDK 看：**「发 span」三家都在做**（Python 最完整，见下），**但「注入 `_meta`」目前只有 Python SDK 确定在做。**
⇒ 对上一条的含义不变（协议定了载体，且**已有官方实现照着做**），但**不能把「SDK 会自己搞定」当免做的理由**。

同一个 Python SDK 还留下一条**失败语义**（初稿完全没提，但对写 G1 很关键）：
`extract_trace_context()` 在 carrier 缺失 / 畸形 / 没有有效 `traceparent` 时**返回 `None`**，让调用方
**回落到「环境里的当前 span」**；docstring 明写理由 —— *「an explicit empty `Context` would **orphan the span**
instead of nesting under the current one」*。⇒ **缺上下文时不要造一个空上下文**，那会把 span 变成孤儿。

⇒ **对本仓的意义**：这不是「要不要做」的问题，是**协议已经定死了载体**，并且**有一个官方 SDK 正在照这个形状发**。
   而本仓**恰好已经有同一份投影**（`core/trace.ts` 的 `parseTraceparent` / `formatTraceparent` / `wireSpanId`）——
   缺的只是「把这份投影装进 `params._meta` / 从 `params._meta` 拆出来」这一步（见 §3 G1）。

### 1.3 评测：三层，且确定性检查优先

**三层**：final-answer（答案对不对）/ **trajectory**（路径对不对）/ **per-turn**（每一轮的意思对不对）。

**轨迹判据**（行业收敛的六项）：任务完成度 / 工具调用准确度（对工具 + 对参数）/ 步数与环 /
轨迹匹配（对参考轨迹，strict 或 superset）/ 每任务成本与延迟 / groundedness。

**纪律（这条最重要）**：**确定性检查先，LLM-as-judge 后**。

- 确定性那一批全是「代码判得了」的：schema 校验、正则、**工具调用签名相等**、延迟阈值、token 上限、
  以及**「幻觉金丝雀」**（= 答案里回显的单号，在工具返回里**真的出现过吗**）。
- judge 只补主观项（语气、忠实度、开放式质量）。在线评测跑不起 judge（太慢太贵），
  要么毫秒级分类器，要么按采样率跑。

⚠️ **一条容易被忽略的**：「步数 / 环」在 trace **总量**里**看不见** ——
一个 20 步的回合和一个 3 步的回合，都只返回一个答案、都只给一个总成本。
**只有把成本按步归属，环才显形**（「agent 花在同一个问题上问了三遍」）。

### 1.4 成本单位 = 每成功任务（不是每 token）

多家一致地把主指标定在 **cost per successful task**：per-session 成本上限、per-task 成本，
以及把「每回合工具调用数」直接当**断路器**（常见阈值写在 6 左右）。

⚠️ 注意「按 token 优化」是**优化错的那部分**：token 分布很不均，链上一个 agent 可能因为拿到臃肿
上下文、用了过大的模型、或重复调工具而独占整条链的成本。

### 1.5 三条投递纪律

1. **非阻塞**：工具执行不该等一次同步 POST；用批量导出器 + 定期 flush；关停时 drain；
   **后端不可达就丢遥测、绝不丢可用性**（「能拖垮调用方的可观测，比没有更糟」）。
2. **载荷别进 span**：prompt / 输出放受控存储，span 只放**引用** ——
   否则遥测后端会**悄悄地变成你最大的客户数据仓库**。
3. **先建可重放路径**：出事时能从某一步重跑、或换模型重跑。

### 1.6 新出现的一格：观测面自己变成 MCP server

Pydantic Logfire 出了**自己的 MCP server** —— 让**编码 agent 去查遥测**（而不是人要开三个窗口点点点）。
这是个新出现的形态：**可观测产品的消费者，本身也可以是 agent。**

### 1.7 框架一览

| 框架 / 产品 | 可观测做法 | 值得抄 / 不该抄 |
|---|---|---|
| **OpenAI Agents SDK** | 自带 trace/span 树（**13 个 span data 类**，见下）+ `group_id` 把多次 run 串成一条会话 | 抄：span 种类划分 + 会话串接；不抄：默认外送 |
| **LangGraph / LangSmith** | 平台化（trace + eval + monitor + 自动聚类失败 + 提议修复）；自研 trace 数据库 | **不抄**：§9.3 已锁死「不建看板 / CMS」 |
| **Mastra** | 原生 OTel：LLM 调用 / 工具调用 / **memory 检索**都是 span；工具 span 发 `gen_ai.operation.name: execute_tool`（另有 `MCP_TOOL_CALL` 一格） | 抄：工具与 memory 都值得有 span |
| **Pydantic AI / Logfire** | OTel 全栈；25+ 框架的适配表；**scrub / sample 在离开进程前**；SQL 工作台；**自家 MCP server** | 抄：MCP 作为观测消费面；不抄：平台 |
| **Arize Phoenix / OpenInference** | **11 种** span kind（见 §1.1）；被微软的开放信任栈选作 trace 契约 | 抄：`GUARDRAIL` / `EVALUATOR` 当一等 kind 的思路 |
| **Vercel AI SDK** | OTel 遥测（Mastra 建在它上面）；工具 span 名 `execute_tool {toolName}`，带 `'gen_ai.operation.name': 'execute_tool'` | 抄：一次工具执行一个 span、**嵌在 step span 下** |
| **CrewAI / AutoGen / Google ADK / Semantic Kernel** | ⚠️ **这条初稿写反了方向**：它们**不是**靠第三方埋点接入，而是**自己就发 `gen_ai.*`** —— 四家**全部**发 `execute_tool` | 映证：`execute_tool` 已是**事实标准**（详见下） |

⚠️ **本表的回源程度**（如实）：OpenAI Agents SDK 已回源到 `src/agents/tracing/span_data.py` 与
`create.py`；OpenInference 已回源到 `spec/semantic_conventions.md` + 代码枚举；Logfire 的 MCP 传播已看代码；
MCP 三个官方 SDK 已逐份回源（§1.2）；**Mastra / Vercel AI SDK / CrewAI / AutoGen / Google ADK /
Semantic Kernel 六家已按「是否真发 `execute_tool`」逐家检索过源码**（2026-10-12，见下）。

🔴 **六家六中六** —— `execute_tool` 的证据（这一条把 G2 的上游判据从「某家的选择」提到「事实标准」）：

| 框架 | 证据 |
|---|---|
| Mastra | `observability/sentry/src/tracing.ts`：`[SpanType.TOOL_CALL, { opType: 'gen_ai.execute_tool', opName: 'execute_tool' }]`，另有 `SpanType.MCP_TOOL_CALL` |
| Vercel AI SDK（`vercel/ai` 仓） | `packages/otel/src/open-telemetry.ts:1006`：span 名 `` `execute_tool ${part.toolName}` ``；`:1010` `'gen_ai.operation.name': 'execute_tool'`、`:1011` `'gen_ai.tool.name'`（`:1072` 另一条路径同形） |
| CrewAI | `lib/crewai/src/crewai/telemetry/tracing/handlers.py`：`operation_name="execute_tool"`（旁有 `"invoke_agent"`）；`semantic_conventions.py` 发 `"gen_ai.tool.name"` |
| AutoGen | `python/packages/autogen-core/src/autogen_core/_telemetry/_genai.py`：`EXECUTE_TOOL = "execute_tool"` |
| Google ADK | `tests/unittests/telemetry/test_spans.py`：`mock.call('gen_ai.operation.name', 'execute_tool')`（另用 `invoke_workflow` / `invoke_node` / `invoke_agent`） |
| Semantic Kernel | Python `function_tracer.py` 与 .NET `KernelFunction.cs` **两边**都是 `OPERATION_NAME = "execute_tool"` |

⚠️ **下表「证据」列里的路径全部指各自上游仓库，不是本仓** —— 本仓 `packages/` 下只有 `cli` / `trace-view` /
`website`；像 `packages/otel/src/…`、`tests/unittests/…` 这种形状**看着像本仓，其实都在上游仓里**。
（2026-10-12 自审时被这条差点误到：查本仓找不到该文件。）

⚠️ 检索口径：`gh search code --repo <repo> "execute_tool"` + 命中处**必须落在 span 命名 / operation name 上**
才算（CrewAI 一开始只命中 `_execute_tool_with_timeout` 这类**方法名**，那是不同的一件事 —— 换关键词
`operation_name` 才落到真证据）。

**OpenAI Agents SDK 的 13 类**（`span_data.py` 的类 ↔ `create.py` 的工厂一一对应）：
`Agent` `Task` `Turn` `Function` `Generation` `Response` `Handoff` `Custom` `Guardrail`
`Transcription` `Speech` `SpeechGroup` `MCPListTools`（另有基类 `SpanData`）。
其中三条**直接对着本仓的两个缺口**：
- **`Task`**（"one top-level Runner run"，带 `usage`）与 **`Turn`**（"one agent loop turn"，带 `turn` /
  `agent_name` / `usage`）⇒ 上游把 **task 级成本**当一等公民，正是 §3 的 **G6**；
- **`MCPListTools`**（带 `server` / `result`）⇒ 上游给 MCP 交互**专门开了一格**，呼应 **G1**。
- `Handoff` 的全部载荷只有 `from_agent` / `to_agent`；`Guardrail` 只有 `name` / `triggered`
  ⇒ **这两格的词汇量极小**（G7 的一句「别过度设计」由此有了量化依据）。

---

## 2. 本仓现状（全部现查，命令见附录 A）

| # | 事实 | 出处 |
|---|---|---|
| 1 | span 树只有三层：`run` / `capability`（**只由 skill / subagent 创建**）/ `llm.turn`；**普通 `@Tool` 与 `@Prompt` 不建 span** | `src/core/trace.ts:9-13` |
| 2 | 事件词汇表（现查 `recorder.event(` 全量）：`budget.exceeded` `context.policy_failed` `context.budget` `llm.fallback` `llm.retry` `usage.missing` `usage.unpriced` **`approval.requested`** **`approval.decided`** `defer.requested` `tool.input` `tool.output` `task.event` `menu.drift` `trace.truncated` | `engine/turn.ts`、`engine/loop.ts` |
| 3 | **审批有两笔事件**（requested + decided），**记在发起它的 `llm.turn` span 上**，不是独立 span | `engine/turn.ts:543,622` |
| 4 | 出口两条缝：`TraceSink`（收尾拿整棵、**有兜底语义**）+ `onTraceEvent`（运行期逐笔、**不保证送达**、带单调 `seq`） | `core/trace.ts:253-298` |
| 5 | OTLP 导出：`POST ${endpoint}/v1/traces`、`content-type: application/json`（**HTTP + JSON**） | `integrations/otlp.ts:292-295` |
| 6 | 已映射的 semconv 键：`gen_ai.operation.name`（`invoke_agent` / `chat` / `execute_tool`）、`gen_ai.agent.name`、`gen_ai.request.model`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.tool.name`、`gen_ai.conversation.id`；score 事件 → `gen_ai.evaluation.result` | `integrations/otlp.ts:120-145,195-222` |
| 7 | 会话维度**已有，但有前置**：`session.id` attribute → 导出为 `gen_ai.conversation.id`。⚠️ 触发条件是 **`session: { store, id }`**（要配 `SessionStore`），**不是** run 级的 `sessionId`（那是内部字段，直接传它**不生效且不报错**）；没配 sessionStore 时 run 根**没有会话维度** | `runtime/run.ts:147,213,244-245`、`engine/types.ts:314-318`、`otlp.ts:121-122`；**2026-10-12 实测**（附录 B） |
| 8 | 跨进程**入站**已有：HTTP `traceparent` 头 → run 根 `SpanLink`；**出站**已有：`currentTraceparent()` 给宿主带 | `transport/http-endpoints.ts:298-301`、`engine/span-scope.ts:61` |
| 9 | **MCP 桥不带 trace 上下文**：`_meta` / `traceparent` / `tracestate` / `baggage` 在 **7 个** MCP 文件里**零命中**（客户端 4 + 服务端 3） | 现查（附录 A 第 3 条） |
| 10 | 可重放**已有**：`traceToMessages(trace)` + `forkMessages(trace,{atTurn})` | `engine/replay.ts:70,84` |
| 11 | 投递是**串行 `await`**：`await flushSinks(...)` 在 `app.run()` 返回前（sink 抛错被吞 + `console.warn`） | `runtime/run.ts:253,275,287,368-376` |
| 12 | 载荷**内联**：工具入参 / 成功出参默认截 2000 字符、失败出参 1000；完整正文需 `maxEventChars: false` 显式开 | `docs/spec.md` §9.1、`engine/tool-events.ts:23-24` |
| 13 | 已有 `trace-diff`（trace 对比）与 CLI `report` / `diff` / `export` / `harvest`；`trace-view` 本地面板。⚠️ CLI `report` 的维度**只有能力（skill/subagent）与模型** —— **没有会话 / 任务维度** | `engine/trace-diff.ts`、`packages/cli/src/report.ts:57,192` |
| 14 | **工具事件是「按 `tool_use_id` 配对」而不是靠位置**：两笔都记在**发起它的 `llm.turn` span** 上，`tool.output` 带 `durationMs`（四条路径都记且非负）+ `ok` + 有值才在场的 `errorKind` | `engine/turn.ts:600,617,747`、`engine/tool-events.ts:39-91`；**实测见附录 B** |
| 15 | ⚠️ **配对可以被截断打破**：开 `traceLimits.maxEvents` 后，交付的 trace 里**出现过只有 `tool.input`、没有配对的 `tool.output`**（`maxEvents: 1` 实测复现） | **2026-10-12 实测**（附录 B） |

---

## 3. 缺口表

判据栏一律是「**上游/协议已明确要求，还是我们自己的选择**」——
只有前者才适合当待办（后者要先问「这条建议会不会逼核心变厚」）。

| # | 缺口 | 上游判据 | 落点 | 成本 | 逼核心变厚？ | 性质 |
|---|---|---|---|---|---|---|
| **G1** | **MCP 桥不带 trace 上下文** | SEP-414 已把载体定死（`params._meta` 裸键，**Final**）；**MCP Python SDK 已在注入**（可直接照抄，含失败语义）；本仓 7 个 MCP 文件零命中 | 2 处客户端调用点 + 1 处服务端分支（见下） | **低~中** | 否（都在 integrations / engine 边缘） | 协议对齐 |
| **G2** | 普通 `@Tool` 没有 span | 上游 `execute_tool` 是一等 span / `TOOL` kind —— **2026-10-12 抽查 6 家框架六中六**都发它（§1.7）⇒ 已从「某家的选择」升格为**事实标准** | **导出侧投影**（见下） | 低~中 | **否**（不动 engine 记账点） | 词汇对齐 |
| **G3** | 没有 `gen_ai.client.inference.operation.details` 事件；另有 **3 个「本仓已有信号、却没发出去」的 `Recommended` 键**（见下） | 该事件的 `**Requirement level:** Recommended`（原文），但 `Status: [Development]`；载体是 **event** 不是 span | `integrations/otlp.ts` | 低 | 否（additive） | 词汇对齐 |
| **G4** | 没有**环 / 步数**信号 | 「步数在 trace 总量里看不见」 | 缝外配方 / `examples/` | 低 | 否 | 评测配方 |
| **G5** | 没有 **trajectory eval 配方**（确定性优先） | 三层评测里的第二层 | 缝外，复用 `trace-diff` + 已有 `Score` | 低 | 否 | 评测配方 |
| **G6** | 没有 **task / 会话级**成本与成功率视图 | `cost per successful task` 是 2026 主指标；会话维度行业用 `group_id` / thread | CLI / 配方 | 低 | 否 | 视图 |
| **G7** | 交接 / 护栏**没有可查的约定与视图** | 这两格**上游无标准**（自由地带） | 属性 + `trace-view` / CLI | 低~中 | 否（additive 属性） | 差异化 |
| **G8** | 观测面**没有给 agent 消费的入口** | Logfire 已有自家 MCP server | 复用 `createMcpServer` + `report` / `diff` | 低~中 | 否（示例 / 附属包） | 差异化 |
| **G9** | 投递纪律与载荷策略**没写进配方** | 三条投递纪律（§1.5） | `docs/observability.md` | **极低** | 否（只写文档） | 文档 |
| **G10** | **OTLP 导出只有 JSON 一种编码** ⇒ 打不过只收 binary 的接收端（**Phoenix 会 415**） | 规范是 **SHOULD**（*receiver SHOULD accept binary **and** JSON on the same port*），**而 Phoenix 只收 `application/x-protobuf`**（源码级，非实测）；本仓 `OtlpExporterOptions` **无编码选项**（§6.5b） | **缝外配方**（中间加一层 collector 转码）/ 内建 protobuf 编码器 | 零（配方）/ **高**（内测那条要手写 protobuf） | **是**（仅内建那条） | 已知边界 |

⚠️ **这十项在 2026-10-12 的落地状态**（五个 PR，**已全部合入主干**）见 **§4 末尾** —— 缺口表本身记的是
交付当日的事实，**不随 PR 状态改动**。

### G1 的落点（**2026-10-12 逐行现查**，不是估的）

**出站（本仓当 MCP 客户端 → 调别人的工具）**：注入点**只有两行**，两处形状完全一致：

| 传输 | 位置 | 现在的样子 |
|---|---|---|
| stdio | `integrations/mcp-stdio.ts:316` | `request('tools/call', { name, arguments: args }, …)` |
| Streamable HTTP | `integrations/mcp-http.ts:203` | `rpc('tools/call', { name, arguments: args }, true, true, …)` |

两处的 `params` 都直接来自调用点，底层信封是 `{ jsonrpc, id, method, params }`（`mcp-http.ts:143`）
⇒ **加 `_meta` 就是在 `params` 上加一个兄弟键**，不碰 `arguments`、不碰任何工具签名。

**出站那个 traceparent 已经现成**：`engine/span-scope.ts` 的 `currentTraceparent()` 是**公共 API**，
注释写明「普通工具与 `@Prompt` 刻意不建 span，它们的『当前 span』就是发起它的那个回合」——
**与 `ToolRunContext.parentSpanId` 是同一个值**。所以这一环用的是本仓自己的投影，
不需要新造任何东西。

**入站（本仓当 MCP 服务端 → 别人调本仓的工具）**：`engine/mcp-server.ts:314` 的 `case 'tools/call'`
现在只从 `m.params` 里取 `name` / `arguments`，**多余的键被静静地忽略**（不报错、也不消费）。
`callTool` 起的是一棵**全新的树**（`recorder.begin('run', 'mcp.tools/call', null)`），
**没有 `traceContext` 入口** ⇒ 今天跨进程进来时，本仓这棵树是**孤立的根**，与调用方断链。
而框架的**入站缝合早就有**（`TraceContext` → run 根 `SpanLink`，`transport/http-endpoints.ts:298-301`
已经在 HTTP 那层这么干了）⇒ 缺的只是「从 `params._meta` 取出来、传进 `callTool`」这一步。

⚠️ **三条纪律写在这里免得出错**：① 注入 / 提取失败必须**静默降级**（桥现在是无状态、宽容的，
不能因为对端不认 `_meta` 就把调用打挂）；② **不改 `arguments`** —— trace 上下文一旦进工具签名，
模型就会看到它、schema 也会被污染；③ **缺上下文时不要造一个空的 `TraceContext`**，要**回落到「当前环境」**
—— 这条不是我推的，是 MCP Python SDK 在 `extract_trace_context()` 的 docstring 里写下的理由：
*「an explicit empty `Context` would **orphan the span** instead of nesting under the current one」*
（§1.2）。本仓入站那一处尤其要照这条做：`params._meta` 里没有 `traceparent` 时，
**保持今天「孤立根」的行为**，而不是塞一个空 parent。

### G3 的落点（**2026-10-12 回源 `client-inference.md` 属性表后新增**）

`gen_ai.client.inference.operation.details` 的 `Requirement level` 原文是 `Recommended`
（`Status` 仍 `[Development]`，所以是「推荐但未定版」）。而逐条比对它的属性表与本仓现有记账，
发现**三条本仓已经有信号、只是没发出去的 `Recommended` 键** —— 这比「补一个事件」更值得先做：

| 上游键 | 上游级别 | 本仓已有的信号 | 现在发了吗 |
|---|---|---|---|
| `gen_ai.usage.cache_read.input_tokens` | `Recommended` | `Usage.cacheReadTokens` | ❌ 只发自有键 `usage.cacheReadTokens` |
| `gen_ai.usage.cache_write.input_tokens` | `Recommended` | `Usage.cacheCreationTokens` | ❌ 同上 |
| `gen_ai.conversation.compacted` | `Recommended when available` | **`context.budget` 事件**（`engine/turn.ts:311`，带 `{from,to,model}` ⇒ 压缩真的发生了且可判） | ❌ |

⚠️ 也就是说：本仓**每次 run 都算出了缓存 token**、**每次压缩都记了前后条数**，
却都没有以 semconv 的键名出境 —— 外部看板只能看到自有键。三条都是 additive、都在 `otlp.ts` 一个文件。

（`gen_ai.response.time_to_first_chunk` 也是 `Recommended`，**但本仓确实没有这个信号**
—— `onText` 只转发增量、不记首块时刻，所以这条**得先有量具**，不在本轮清单里。）

### G2 值得单独说：**span 可以是「导出侧的概念」，不必是「记账侧的概念」**

本仓刻意让普通工具不建 capability span（`core/trace.ts:9-13` 的注释 + `guards.md` 有登记）。
现在生态变了，但**不必推翻这个 trade-off**。

**承重事实（2026-10-12 逐条现查 + 端到端实测，见附录 B）**：

1. **父 span 是隐含的，不需要 `spanId`。** ⚠️ 初稿这里写错过一次：`SpanEvent` 的形状是
   `{ time, name, body }`（`core/trace.ts:71-80`）——**没有 `spanId` 字段**。带 `spanId` 的是**另一条缝**
   （增量流的 `TraceRecordEvent`，`core/trace.ts:284-298`）。而 OTLP 导出器吃的是 `Trace`，
   事件按**所属 span 分好组**地挂在 `span.events` 里 ⇒ 父 span 就是"装它的那个 span"，
   **比查 id 更硬**。
2. **配对键是 `tool_use_id`，不是位置。** 两笔事件体都带 `tool_use_id`（`engine/tool-events.ts:39-64`），
   且都记在**发起它的 `llm.turn` span** 上（`engine/turn.ts:600` 的注释就是这条口径）。
   ⇒ 同名工具并行也不会配错。
3. **投影出来的是真 span，不是空壳**：`tool.output` 带 `durationMs`（成功 / 失败 / 超时 / 入参被拒
   **四条路径都记且非负**）、`ok`（→ `status.code`）、有值才在场的 `errorKind`（→ 错误分类）。
   ⇒ 导出的 child span 有**真实时长、真实成败、真实错误类**。
4. **实测：这对事件真的出现在 OTLP payload 里**（附录 B 的 debug exporter 输出逐字可见
   `tool.input` / `tool.output` 两个 SpanEvent，带 `tool_use_id: Str(tu0)`、`ok: Bool(true)`、
   `durationMs: Int(0)`）。

⇒ 在 **OTLP 导出侧**把这组事件**投影**成 child span（`execute_tool` + `gen_ai.tool.name` + 真实时长），
就能让 Datadog / Langfuse / Phoenix 的「按 span 查工具」正常工作 ——
**engine 记账点一行不动、本地 trace 形状不变、体量闸不参与**。

⚠️ **两条必须先定的口径**：

- **投影默认开还是默认关**。建议**默认关**（与本节其余各条同款：不改既有产物、不悄悄改变导出体积），
  并写一条用例钉「两种模式各自导出的 span 数」。
- **必须处理「孤儿 input」** —— 这不是理论风险，是**实测复现过的**：开 `traceLimits.maxEvents` 之后，
  交付的 trace 里出现过**只有 `tool.input`、没有配对 `tool.output`**（`maxEvents: 1` 时复现）。
  投影遇到孤儿时的选择只有三种（**别默认「补一个零时长 span」**，那是编账）：
  ① 不投影（保守，但工具就没 span 了）；② 投影但**不写 `endTimeUnixNano`**（OTLP 允许，语义诚实：
  「开始了、没等到结束」）；③ 投影并在属性上标 `agentia.projection.orphan: true`。
  **建议 ②+③**，并把这条口径钉成用例。

---

## 4. ROI 排序（前五 + 两条差异化）

| 序 | 做什么 | 为什么排这 | 风险 |
|---|---|---|---|
| **1** | **G3 那 3 个「已有信号、没发出去」的键**（§3 G3 表） | **极低**：纯 additive、都在 `otlp.ts`；零新逻辑（信号都在，只是换个键名出境） | 无 |
| **2** | **G4 环 / 步数配方** | 极低成本；**纯 trace 函数**，正是本仓最强的那一面；直击行业公认的「看不见的失败」 | 无（缝外） |
| **3** | **G2 + G3 事件的其余部分** | 都是 additive、都在 `otlp.ts` 一个文件；不动 engine ⇒ 不碰体量闸与记账点。⭐ 上游判据本轮被抬到**事实标准**：抽查 6 家框架**六中六**都发 `execute_tool`（§1.7） | 要定「默认关」+ 定孤儿 input 的口径 |
| **4** | **G6 会话 / 任务成本视图** | ⚠️ 属性**不是「已经有了」**（要配 `SessionStore` 才有 `session.id`，实测过）；缺的是**视图** | 无 |
| **5** | **G5 trajectory eval 配方** | 复用 `trace-diff` + 已有 `Score` / `harvest`；把「轨迹评测」从概念变成能跑的配方 | 无（缝外） |
| **6** | **G1 MCP `_meta`** | 协议已定死；本仓 7 文件零命中 ⇒ **跨进程那一环是断的**。落点已查实：**客户端 2 行 + 服务端 1 处** | 注入/提取失败必须**静默降级**（桥现在是无状态、宽容的） |
| ★ | **G7 交接 / 护栏约定** | 上游这两格**无标准** —— 定义权可争。OpenAI 那两份载荷只有 `from_agent`/`to_agent` 与 `name`/`triggered` ⇒ 词汇量极小 | 别过度设计：先用 additive 属性 |
| ★ | **G8 可观测 MCP server** | 复用已有反向桥；Logfire 已示范；让 agent 自己能被 agent 调试 | 要判「这是分发面不是功能面」 |

**如果只做一件**：G3 的三个键（改三行的事）。**如果做一轮**：G3+G4+G2+G6（都在「不动核心」这一侧）。

### 落地状态（2026-10-12 追记：五个 PR **已全部合入**）

> 本文交付后，四个 open PR 先后声明「来自本文」；本文档自身补成第五个（#237）。
> 逐条对拍如下。**已按序全部合入主干**：`#237` → `#234` → `#233` → `#235` → `#236`。

| # | 缺口 | PR | 状态 |
|---|---|---|---|
| **G1** | MCP 桥不带 trace 上下文 | **#235** `feat/mcp-trace-context` | ✅ 出站注入 `params._meta.traceparent`、入站照 HTTP 同款在 run 根缝 `SpanLink`；三条纪律（静默降级 / 不碰 `arguments` / 缺上下文保持孤立根）都在 |
| **G2** | 普通 `@Tool` 没有 span | **#233** `fix/otlp-semconv-align` | ✅ 导出侧投影 `execute_tool <名>`（`projectToolSpans`，**默认关**；关时产物逐字节等于现状；孤儿 input 不编 endTime / status） |
| **G3** | 三个「已有信号、没发出去」的键 | **#233** | ✅ `cache_read.input_tokens` / `cache_write.input_tokens` / `conversation.compacted`（>0 才发、双发不替换） |
| **G3** | `gen_ai.client.inference.operation.details` **事件** | — | ❌ **没做**。⚠️ **不是假账**：#233 的标题、正文、CHANGELOG、spec 四处**都只声明「三个键」** ⇒ 这是**半项没人领**，不是「声称做了却没做」 |
| **G4** | 环 / 步数信号 | **#236** `docs/observability-recipes` | ✅ 配方（`docs/observability.md` §8，纯 trace 函数） |
| **G5** | trajectory eval 配方 | **#236** | ✅ 配方（§9：`harvest` → `diff` → `defineEval`） |
| **G6** | task / 会话级成本与成功率视图 | — | ❌ **没做**（本文 ROI 第 4 位） |
| **G7** | 交接 / 护栏约定与视图 | — | ❌ **没做**（★ 差异化） |
| **G8** | 观测面给 agent 消费的入口 | — | ❌ **没做**（★ 差异化） |
| **G9** | 投递纪律写进配方 | **#236** | ✅ §6 三条 + 专列「为什么不把 `flushSinks` 改成 fire-and-forget」（守住了 §5 的「别做」） |
| **G10** | OTLP 只发 JSON ⇒ Phoenix 415 | **#236** | ✅ 已知边界 + 最小 collector 转码配方（§7），并按 choice 进 usage-guide §7 边界表 |

**不在缺口表里的第五个**：**#234** `fix/sessionid-silent-noop` 落的是 §2 行 7 记的**核实发现**，
而且查得比本文更深 —— 同一个 `sessionId` 有**两层语义**：**引擎级**（`loop.ts` 真读它，直连
`runAgent` 时**生效**）与**契约级**（异步宿主的可序列化引用，`AsyncRunner` 执行前换成
`session:{store,id}`）。真正静默的只有 `AgentApp.run` 那一条转发链。

**覆盖率**：缺口表 **10 项里做完 7 项**（G1 / G2 / G4 / G5 / G9 / G10 + G3 的三键）、**没做 3 项**
（G6 / G7 / G8）、**半做 1 项**（G3 缺事件）。对着本文的 ROI 排序看：**第 1（G3 三键）、2（G4）、
5（G5）、6（G1）都落了，唯独第 4 位（G6）没落**，两条 ★ 差异化（G7 / G8）也没落 ——
与「先做低风险 additive、不动核心」的排序一致。

⚠️ **合并前查出的两条隐患 —— 事后来看都成了真，也都解掉了**：

1. **5 处引用指向一份尚未入库的文档。** #233 / #234 / #236 在**仓库内文件**里写了完整路径
   `docs/reviews/2026-10-12/observability-deep-dive.md` —— `docs/spec.md`（#233、#234 各一处）、
   `CHANGELOG.md`（#236）、`src/integrations/otlp.ts` 的注释（#233）、
   `tests/docs/boundary-table.test.ts` 的注释（#236）；而**这份文档不在任何一个 PR 的文件清单里**。
   ⇒ **本文档得先入库**，否则主干上会出现 5 处死链。
   ⚠️ 实测**没有守卫会咬这个**：`tests/` 里 `docs/reviews` 只出现在注释文本中，全仓没有
   「跨文件引用的路径是否存在」这类检查 ⇒ 只能靠人守（`commit-refs.test.ts` 管的是 hex SHA，不是路径）。
   （#235 用的是裸名 `observability-deep-dive §1.2 / §3 G1`，不构成路径死链，但读者定位不到。）
2. **四个 PR 互相冲突，只能串行合。** 四个**全部**往 `CHANGELOG.md` 的同一个 hunk（`@@ -1110`，
   即 `[Unreleased]` 段尾）插；**#233 / #234 / #235 三个**往 `docs/spec.md` 的同一个锚点
   （`@@ -6147`）插；`docs/usage-guide.md` **4/4 全改**；`AGENTS.md` 与
   `packages/website/src/fragments{,/en}/api.html` 各被 2 个 PR 改。⇒ 每合一个，后一个必须 rebase。
   现在的 `mergeStateStatus=CLEAN` **只对当前 base 有效**。
   ⚠️ 上表引到的 `docs/spec.md` / `CHANGELOG.md` / `otlp.ts` / `boundary-table.test.ts` **行号都在各 PR
   分支内**（`main` 上还没有这些行 —— 例：`otlp.ts` 在 `main` 是 324 行，#233 里那些注释落在 362 行）
   ⇒ 复现要先 `gh pr checkout <n>`，别在 `main` 上找。

**两条隐患的实际处置**（2026-10-12 收尾记录）：

1. **文档先入库**：#237（本文档本体，纯新增）**第一个合**（`a07d321`）—— 随后那 4 处完整路径引用
   落进主干时，目标已经在了。⚠️ 顺序不是可选的：若先合 #233 / #234 / #236，在 #237 落下之前
   主干上就有死链，而**没有守卫会红**（见上）。
2. **串行解冲突，全用 merge 不用 rebase**：分支保护是 **strict**（要求 head 与 base 同步），所以
   `gh pr merge` 直接报 *the head branch is not up to date with the base branch*；
   `update-branch` API 在 #233 / #235 / #236 上全返回 **422 merge conflict**。逐个
   `git merge origin/main` 解冲突后**普通 push**（快进，不用 force push —— 四个分支已静止 4.5 小时、
   无并行会话）。
   冲突**只出现在两个文件**：`CHANGELOG.md`（`[Unreleased]` 段尾，同 hunk）与 `docs/spec.md`
   （§10 的同一锚点）—— 两边都是**新增段落**，所以「解冲突」= **按圈号重排**（②→③→④，纯文档条目
   最后），不需要取舍内容。`docs/usage-guide.md` / `AGENTS.md` / 两个 `api.html` /
   `tests/docs/boundary-table.test.ts` 都**自动合并成功**。
   ⚠️ 自动合并过的文件仍要**逐份复核**：`boundary-table.test.ts` 被 #235 与 #236 同时改，合并后
   跑该守卫确认 93 条与 §7 行数一致（**6 pass**）—— 不是看 diff 就算过。
3. **合并后核对**：5 个 squash 提交逐条对上（`a07d321` / `b8f9fb2` / `c3a81a7` / `ad402e8` /
   `ab45bd9`）；用 **PR 的 `mergeCommit`** 而非分支 tip 校验在主干上（squash ⇒ tip **不是** main 的
   祖先）；远端分支按本仓探针回收（7 个，含 2 个早前遗留）⇒ 远端只剩 `main`。

---

## 5. 刻意不做（引原文，别当待办）

**`docs/spec.md` §9.3 已锁死**：「框架**只保证出口**，落库 / 采样 / 脱敏 / 按 runId 检索都由宿主用 sink 组合」
⇒ 不内建日志层 / 采样 / 脱敏 / 存储 / 看板 / CMS。

**§9.4「未采纳」已列明**：框架内建 `samplingSink`、**事件落 store 的真跨进程实时流**、动态采样率、**OTEL SDK 兼容层**。

**本文新增的两条也别做**：

- ❌ **别把 `flushSinks` 改成「不等待」**。§9.3 给 sink 的语义就是「**有兜底 / 会投递**」，
  改成 fire-and-forget 会把这个语义削弱成「和增量事件一样不保证送达」—— 那是**删掉一条已有承诺**。
  §1.5 的第 1 条纪律应该落在**配方**（批量 sink / 排队 sink）上，不是改核心。
- ❌ **别把载荷改成「只存引用」**。本仓是**本地优先**：`trace-view` 直接读 trace 文件、
  `forkMessages` 直接从 trace 重放。载荷引用化会**拆掉这两条已有的路**。
  正确处置是把它写成**已知的 trade-off**（§1.5 第 2 条的那句风险，本仓是**主动接受**的），
  并把「外置 + 脱敏」留在 sink 侧配方里（`docs/observability.md` 2.4 已有脱敏配方）。

---

## 6. 核实记录（2026-10-12，**四轮核实 + 一轮自检**）：初稿「没能核实」的那 6 条，逐条打掉

### 6.1 已核实

| 初稿的说法 | 核实结论 | 证据 |
|---|---|---|
| OTLP/HTTP + JSON 收不收 | ✅ **收**。拿**真** OTel Collector 0.162.0 打了本仓**真实**导出的 payload：`HTTP 200 {"partialSuccess":{}}`，并在 debug exporter 里逐字看到 3 个 span / 全部属性 / `tool.input`+`tool.output` 两个事件 | 附录 B |
| 「OTLP 规范里 HTTP 传输**二进制 protobuf 是必须的、JSON 是可选**」 | ❌ **这句是错的**（**我初稿的前提就错**）。现行规范原文：*「OTLP/HTTP uses Protobuf payloads encoded **either in binary format or in JSON format**」*，两种编码**对称定义**（binary → MUST `application/x-protobuf`；JSON → MUST `application/json`），**没有**「JSON 可选」这句。真正带 `MAY` 的是 **SDK exporter 规范**：*「SDKs SHOULD support both `grpc` and `http/protobuf` … They also **MAY** support `http/json`」* —— 那是**客户端**的能力分级，**不是接收端的** | `opentelemetry-proto/docs/specification.md` §OTLP/HTTP §JSON Protobuf Encoding；`opentelemetry-specification/specification/protocol/exporter.md:177-181` |
| 「Datadog 需要 OTel SDK/Collector v1.37+」 | ❌ **撤回**（第三方博客的唯一来源，与已证伪的「v1.37 已 stable」同形）。且 **Datadog 明写支持 JSON**：serverless intake 的协议栏是 *「**http/protobuf or http/json**」*；Datadog Agent 的 OTLP 接收端文档明写「与 Collector 的 OTLP receiver **同一套**（版本看 Agent 的 `go.mod`）」⇒ 上面那次实测**直接覆盖**它 | Datadog 官方文档（OTLP Intake for Serverless / OTLP Ingestion by the Datadog Agent） |
| MCP SEP 条款原文 | ✅ **SEP-414 原文全文已取**（`seps/414-request-meta.md`，Final / Standards Track / 2025-04-25）；「加前缀会弄坏 trace」是**原文逐字**。落地证据 = `docs/specification/2026-07-28/changelog.mdx` 的 Minor changes 第 2 条**点名 SEP-414**；同页还有 SEP-2243（必需头）与 SEP-2577（废弃 logging、**点名 OTel**） | `modelcontextprotocol/modelcontextprotocol` @ `main` |
| **「MCP 官方 SDK 已内建 `_meta` 传播」**（初稿只凭 Logfire 一句注释） | ✅ **已回源到三个 SDK 的源码**，结论比初稿更细：**Python SDK 确实在注入**（`jsonrpc_dispatcher.py:392` 逐字注释 `# SEP-414: inject W3C trace context.` → `inject_trace_context(out_meta)`，且实现体就是 `inject(meta)`）；**TS SDK 只做常量 + 透传，不注入**；**C# SDK 的 `MetaKeys.cs` 里没有 trace 键** | `mcp-py-sdk-jsonrpc_dispatcher.py` / `mcp-py-sdk-_otel.py` / `mcp-ts-sdk-traceContextMeta.test.ts` / `mcp-cs-sdk-MetaKeys.cs`（§1.2 有对照表） |
| 框架一览表 | ✅ **已逐家回源**（第四轮补齐）：OpenAI Agents SDK（`span_data.py` + `create.py`，**13 类**）、OpenInference（属性表 **11**）、Logfire MCP；**Mastra / Vercel / CrewAI / AutoGen / Google ADK / Semantic Kernel 六家检索源码 —— 六家全发 `execute_tool`** | §1.7 / §6.4(c) |
| OpenInference「9 个 kind」 | ❌ **11 个**（且规范仓自己不一致：`traces.md` 散文只列 10，属性表 11；代码枚举另加 `UNKNOWN`） | `spec/semantic_conventions.md` / `spec/traces.md` / `token.py` 侧枚举 |
| 覆盖率与用例数未重跑 | ✅ **本轮重跑**：`npm test` exit 0，三套件 **1728 + 214 + 38 = 1980 pass / 0 fail**；覆盖率 **98.58 语句 / 92.85 分支 / 98.45 函数**，与 2026-10-11 那次**逐位相同** ⇒ 「本轮未动 `src/`」这个判断被证实 | `.workbuddy/reports/2026-10-12/coverage-rerun.log` |

### 6.2 本轮**顺手抓到的**：本仓自己的源码注释里有两条假理由

这两条都是**判据被实测证伪**，但结论（发整数 / 跳过 `undefined`）本身仍然正确 ——
**动作对、理由假**，与本仓 2026-10-11 那次「数字对、理由假」是同一形状。

| 位置 | 注释断言 | 实测 |
|---|---|---|
| `src/integrations/otlp.ts:257-261` | 「曾是 `'STATUS_CODE_OK'` 这种字符串……**严格的 collector 会判非法并整批拒收**」 | ❌ **collector 0.162.0 收下了**（`"code":"STATUS_CODE_OK"` → POST **200** 且解析成 `Ok`）。**发整数仍然对**（规范原文确写 enum MUST 用整数），但「否则会被拒收」不成立 |
| `src/integrations/otlp.ts:177-179` | 「`{"key":"x","value":{}}` …**collector 判非法**」 | ❌ **收下了**（POST 200，且该属性在 debug exporter 里**在场**） |

⚠️ 反过来，**会让整批 400 的只有两类形状**：① **id 不是 hex**（`spanId` / `traceId` 带横杠 ⇒
`HTTP 400` + `ID.UnmarshalJSONIter: encoding/hex: invalid byte: U+002D`）；② **hex 但长度不对**
（第三轮补测，见 §6.4(a) / 附录 B.7）。
⇒ `otlp.ts:236-238` 那条「内部 UUID 必须截断成 8 字节 hex，否则整条拒收」的注释**方向是对的**。

⚠️ **但上面两行的「被收下」不等于「这个 collector 特别宽容」** —— 第四轮回源规范后定论：
接受 proto 原名 / enum 名是 **proto3 JSON Mapping 明写的**（*"Parsers accept **both** … and the
original proto field name"*）；忽略未知字段更是 **OTLP 对接收端的 MUST**，不是宽容。详见 **§6.5**。

### 6.3 仍然没能核实的（如实保留 —— 收敛到 **1 条**）

**「本仓打 Phoenix 会 415」是回源源码得到的，不是跑出来的。** 本机的实测设备只有 OTel Collector
那一个（要起 Phoenix 得 Python 服务 + Postgres）。源码级证据足以判「默认配置打不过去」，
但**没有实测到的那个 HTTP 状态码**（源码见**附录 B.8**）。（Docker 通道本轮试过：能起 daemon，但拉镜像卡死 ⇒ 改走
GitHub 直连二进制；起 Phoenix 的成本比这更高，没做。）

⚠️ 原本在这张单子上的另一条 ——「接收端到底该多严」—— **第四轮已有定论，问题本身问错了**（§6.5）：

| 曾被列为「没查清」 | 现在的定论 |
|---|---|
| 「规范说 enum MUST 整数 / 原名不许作 key，实现却放行 ⇒ 是实现宽松还是规范允许？」 | ❌ **前提错**。那两条禁令**只约束编码方**；解码方走 proto3 JSON Mapping，规范**明写两种形式都接受**（§6.5a） |
| 「不能据此推断别家也这么宽」 | ✅ 对，但**结论更糟**：不是「别家更严」，是 **Phoenix 连 JSON 都不收**（§6.5b） |

### 6.4 第三轮：又把三条从「未核实」里打掉了

**(a) id 的边界**（原 §6.3 第 3 条）—— 用同一套设备补了 8 个 case（附录 B.7）：

| 形状 | HTTP | collector 里长什么样 |
|---|---|---|
| `traceId` 30 位 / `spanId` 14 位 / 两者长度互换 | **400** | `ID.UnmarshalJSONIter: length mismatch` |
| `spanId` = 16 个 `0` | **200** | 收下，但渲染成**空 ID** |
| `traceId` = 32 个 `0` | **200** | 收下，但渲染成**空 Trace ID** |
| `spanId` = 空串 `""` | **200** | 收下，渲染成**空 ID** |
| 大小写混合的 hex | **200** | 收下，**归一化成小写**（证实规范说的 case-insensitive） |

⇒ 补出的判据：**「非 hex」与「长度不对」会整批 400；但「全 0 / 空串」这种语义上无效的 id 会被收下、
并被静默地变成「没有 id」** —— 接收端**不替你把关语义**。这条比初稿那句「只验了非 hex」有用得多：
**下游对不上号时，上游不会有任何错误可看。**
⚠️ 顺带修正 §6.2 那句小结：会让整批 400 的**不止**「id 不是 hex」，还有「hex 但长度不对」。

**(b) MCP 官方 SDK 到底内建了没有**（原 §6.3 第 5 条）—— 三个 SDK 逐份回源，
结论与对照表见 **§1.2**：Python SDK **真注入**（`# SEP-414: inject W3C trace context.`），
TS SDK **只透传**，C# SDK 的 `MetaKeys.cs` 里**没有** trace 键。
⇒ 原话「官方 SDK 已内建」**方向对、范围说大了**；已按 SDK 逐家改准。

**(c) 框架一览表**（原 §6.3 第 3 条）—— Mastra / Vercel AI SDK / CrewAI / AutoGen / Google ADK /
Semantic Kernel **六家逐家检索源码**，**六家全部**发 `execute_tool`（证据表见 §1.7）。
⇒ 这条不只补上了出处，还**改掉了一处方向性错误**：初稿说这四家「自己不造规范，靠第三方埋点接入」，
实际它们**自己就发 `gen_ai.*`**。

### 6.5 第四轮：两条「没查清」其实是问题问错了；而且抓到一个 **415**

**(a) 「实现宽松 vs 规范允许」→ 回源 proto3 JSON Mapping，定论是「规范分层」**

OTLP 规范自己声明：JSON 编码 =「proto3 标准 [JSON Mapping]」，**with the following deviations**。
那两条禁令的原文是：

> *…the enum name strings **MUST NOT** be used.* / *Original field names are **not valid** to use as keys…*

⚠️ 但**受约束的主语**很关键 —— 这两条写在 **JSON Protobuf Encoding**（=*发出去的报文长什么样*）那一节，
约束的是**编码方**，不是「接收端要不要接受」。接收端那边，OTLP 只立了一条 MUST：

> *OTLP/JSON receivers **MUST ignore** message fields with unknown names…*
> *（后面那句紧跟着给理由：so that adding new fields … does not break existing receivers）*

至于「解码端认不认别名」—— OTLP 没另立规矩，于是落回它自己声明的基础：**proto3 JSON Mapping**。
回源 protobuf 官方文档（`protobuf.dev/programming-guides/json`）原文：

> *Parsers accept **both** the lowerCamelCase name (or the one specified by the json_name option)
> **and** the original proto field name. This allows for a serializer option to choose to print using
> the original field name and have the resulting output **still be parsed back by all spec parsers**.*
>
> *Parsers accept **both** enum names and integer values.*

⇒ **本仓注释说的「严格的 collector 会判非法并整批拒收」在任何合规接收端上都不成立** ——
不是「这个 collector 宽容」，是**规范要求所有合规解析器都接受**（原文 "**all spec parsers**"）。
⇒ 反过来，**`case-09`（未知字段被收下）也不是宽容，是 MUST** —— 为的是 schema 能演进。
⇒ 这条与 2026-10-11 那次「**数字对、理由假**」同形，但更该记：`otlp.ts:257-261` 会**诱导后来者
以为「发整数是为了迁就某个挑食的 collector」**，而真实原因是「**报文按规范写法**」（编码方义务），
**与接收端无关**。

> 引文行号说明：禁令在原文件 `opentelemetry-proto/docs/specification.md`，本文落盘副本为
> `.workbuddy/reports/2026-10-12/semconv-verify/otlp-specification.md`（**下述行号是副本的**）。

**(b) 「只有 1 个接收端被测」→ 直接回源 3 个真实接收端，抓到一个反例**

| 接收端 | 解析实现 | 收 JSON？ | 收 binary？ | 证据 |
|---|---|---|---|---|
| **OTel Collector 0.162.0** | Go `protojson` | ✅ **实测 200** | ✅ | 本轮实测（附录 B） |
| **Langfuse** | TS，按 `content-type` 分派 | ✅ `JSON.parse(body).resourceSpans` | ✅ | `web/src/server/otel/processOtelIngestion.ts:53-101` |
| **Phoenix** | Python protobuf | ❌ **415** | ✅ | `src/phoenix/server/api/routers/v1/traces.py:477-481` |

Phoenix 那段逐字：

```python
if content_type != "application/x-protobuf":
    raise HTTPException(detail=f"Unsupported content type: {content_type}", status_code=415)
```

⇒ 而**本仓只能发 JSON**：`OtlpExporterOptions`（`otlp.ts:37-60`）里**没有编码选项**，
`'content-type': 'application/json'` 写死在 `:295`。
**⇒ 本仓默认配置打 Phoenix 会 415 —— 不是「可能有兼容问题」，是「一定进不去」。**

规范对此的口径是 **SHOULD**（不是 MUST）：

> *Server implementations **SHOULD accept** OTLP/HTTP with binary-encoded Protobuf payload **and**
> OTLP/HTTP with JSON-encoded Protobuf payload requests **on the same port** and multiplex the requests
> to the corresponding payload decoder based on the "Content-Type" request header.*

⇒ Phoenix 是「**未遵循推荐**」，不是「违规」；**但这不改变本仓打不过去的事实**。

**处置（⚠️ 别顺手给 `otlp.ts` 加 protobuf）**：本仓**零运行时依赖**，手写 protobuf 二进制编码器
（varint / length-delimited / field number）是**几百行**，直接撞 §四 第 ① 条判据
（「进核心 = 引不引第三方依赖」）。正规解法**在缝外**：宿主在中间放一层 OTLP Collector，
**收 JSON、转 binary** 发给 Phoenix —— `docs/observability.md` 的四配方里已有「加一层 collector」。
**本仓一行不用改**，只需把这条写成**已知边界**（已登记为 §3 的 G10）。

### 6.6 本文的自检（2026-10-12，收尾时做的对抗性复核）

一份「核实报告」自己也得被核实 —— 下面三类**可机械判**的断言全部现查过一遍：

| 类别 | 条数 | 结果 |
|---|---|---|
| **本仓 `文件:行号` 断言** | 30 | ✅ **全准**（逐条打印该行原文比对；`engine/types.ts:314-318` 是范围、含 `sessionId?` 那行） |
| **上游 `文件:行号` 断言**（Phoenix `:477-481`、Langfuse `:88`/`:208`、Python SDK `:392`、规范 `:465`/`:469`/`:475`/`:699`） | 7 | ✅ **全准** |
| **附录 A 的文件字节数** | 23 | ⚠️ **2 处口径错，已修**：Langfuse `10,492→10,504`、Phoenix `34,968→34,972` |
| **引用的仓库路径是否存在** | 19 | ⚠️ **1 处歧义，已修**（见下） |

**修掉的两类问题**：

1. **数字口径没落**（本仓第 2 条的老坑）：抓取时用 `len(text)` 打印**字符数**，表格却标 `B`（字节数）⇒
   非 ASCII 文件上差几个字节。已按字节数校正，并在表下补了口径注。
2. **路径歧义（差一点误导读者的地方）**：§1.7 表里 Vercel 那行写 `packages/otel/src/open-telemetry.ts`
   —— 本仓 `packages/` 下**只有 `cli` / `trace-view` / `website`**，这个形状**看着像本仓、其实是上游仓的**。
   已加 `vercel/ai` 限定、补行号（`:1006` / `:1010`），并在表前加了一句「下表路径全部指上游仓库」。

**顺带记一个方法论陷阱**（差点让我**误报**自己有假断言）：用
`gh api … | base64 -d | grep -E "execute_tool|gen_ai\." | head -15` 复核 Vercel 那条时，
**`gen_ai.` 的命中行号小、把 15 个名额占满，第 1006 行的 `execute_tool` 被截掉了** ⇒ 看起来像「文件里没有」。
⚠️ **多模式混用时 `grep | head -N` 会按行号先后挤掉后面的模式** —— 这是「静默零命中」的变体，
判别法 = 去掉 `head` 或按模式分开数。

---

## 附录 A：本文所有本仓读数的复算命令

```bash
# 1. span 层级与「普通工具不建 span」的口径
sed -n '9,13p' src/core/trace.ts

# 2. 全量事件词汇表（谁在记账）
grep -rn "recorder\.event(" src/engine/ | sed 's/.*event(\([^,]*\), *//'

# 3. ⭐ MCP 桥是否带 trace 上下文（预期：零命中）
grep -rn "_meta\|traceparent\|tracestate\|baggage" src/integrations/mcp*.ts src/engine/mcp-server*.ts
#   ⚠️ BSD grep 的 `|` 需转义且常静默零命中 ⇒ 用 `grep -E` 或专用搜索工具复核

# 4. OTLP 导出形态（HTTP + JSON）
grep -n "v1/traces\|content-type" src/integrations/otlp.ts

# 5. 已映射的 semconv 键
grep -n "gen_ai\." src/integrations/otlp.ts

# 6. 投递是否阻塞（预期：串行 await）
grep -n "flushSinks" src/runtime/run.ts

# 7. 可重放的两个入口
grep -n "export function \(traceToMessages\|forkMessages\)" src/engine/replay.ts
```

**外部来源**

**① 回源到的原文**（本机缓存 `.workbuddy/reports/2026-10-12/semconv-verify/`，gitignore）
—— **本文的判据只用这一组**；凡是只出现在 ② 里的说法，本文一律当「待核」处理。

| 来源 | 文件 | 大小 |
|---|---|---|
| MCP SEP-414（`params._meta` 裸键携带 trace context） | `mcp-sep-414.md` | 4,358 B |
| MCP SEP-2243（`Mcp-Method` / `Mcp-Name` 必需头） | `mcp-sep-2243.md` | 45,208 B |
| MCP SEP-2577（废弃 Roots/Sampling/Logging，**点名 OTel**） | `mcp-sep-2577.md` | 13,686 B |
| MCP `2026-07-28` changelog（Minor changes 逐条点名上述 SEP） | `mcp-changelog-2026-07-28.mdx` | 11,719 B |
| MCP `2026-07-28` schema（**反例**：三个载体词 0 命中） | `mcp-schema-2026-07-28.mdx` | 726,080 B |
| MCP **Python SDK** —— SEP-414 的真注入点（`# SEP-414: inject W3C trace context.`） | `mcp-py-sdk-jsonrpc_dispatcher.py` | 39,053 B |
| MCP **Python SDK** —— `inject_trace_context` / `extract_trace_context` 实现（含「缺上下文别造空 Context」的失败语义） | `mcp-py-sdk-_otel.py` | 1,748 B |
| MCP **Python SDK** —— 服务端 span 形状断言（`tools/call mytool`、`gen_ai.operation.name=execute_tool`） | `mcp-py-sdk-test_otel-server.py` | 15,251 B |
| MCP **TypeScript SDK** —— `SEP-414 trace context \`_meta\` passthrough` 回归测试（证明**只透传**） | `mcp-ts-sdk-traceContextMeta.test.ts` | 4,514 B |
| MCP **C# SDK** —— `MetaKeys.cs`（**反例**：6 个 well-known 键里没有 trace 一族） | `mcp-cs-sdk-MetaKeys.cs` | 3,229 B |
| OTLP 传输规范 —— **现行位置** | `otlp-specification.md` | 39,546 B |
| protobuf 官方 **JSON Mapping** —— 「Parsers accept **both** …」的出处 | `protobuf-json-mapping.txt` | 29,329 B |
| OTLP 传输规范 —— 旧位置（只剩重定向桩） | `otel-otlp-spec.md` | 253 B |
| SDK 导出器规范（「`MAY` support `http/json`」的**真出处**） | `otel-exporter-spec.md` | 14,899 B |
| OTEP-0122（OTLP/HTTP+JSON 原始提案；id 用 base64） | `otep-0122-otlp-http-json.md` | 6,651 B |
| OpenInference `spec/traces.md`（散文列 **10**） | `openinference-traces.md` | 9,537 B |
| OpenInference `spec/semantic_conventions.md`（表列 **11**） | `openinference-semconv.md` | 77,207 B |
| OpenInference 代码枚举（**12** 项，含 `UNKNOWN`） | `openinference-trace-init.py` | 23,756 B |
| OpenAI Agents SDK `span_data.py`（**13** 个 span data 类） | `openai-agents-span_data.py` | 11,024 B |
| OpenAI Agents SDK `create.py`（13 个工厂，与上面一一对应） | `openai-agents-create.py` | 19,086 B |
| Logfire MCP 集成（装/拆 `_meta` 的**代码**证据） | `logfire-mcp.py` | 8,725 B |
| **Langfuse** OTLP 摄取（按 `content-type` 分派；**收 JSON**） | `langfuse-processOtelIngestion.ts` | 10,504 B |
| **Phoenix** OTLP 收端（⚠️ **只收 `application/x-protobuf`，JSON 回 415**） | `phoenix-v1-traces.py` | 34,972 B |

> 口径：「大小」= 落盘文件的**字节数**。⚠️ 含非 ASCII 的文件上，字节数 ≠ 字符数
> （抓取时若用 `len(text)` 打印，会差几个字节）—— 上表两个接收端源码就是这种情况，已按字节数校正。
| OTel GenAI 约定（钉 commit `6fd0d763`） | `genai@6fd0d763-*.md` ×5 | — |
| OTel semconv v1.37 / v1.41.1 / v1.42 对照（用于**证伪**「v1.37 已 stable」） | `v1.37.0-*.md` ×4、`v1.41.1-README.md`、`v1.42.0-README.md` | — |

**② 只用于「发现候选」的转述来源** —— ⚠️ **不作为判据**。§6.1 里那条 Datadog 断言就是被这一组坑掉的：
- OTel GenAI 词汇表对照 —— `worldprogramming.org`「AI Agent Tracing: Spans, Tool Calls and OpenTelemetry」
- MCP `_meta` 载体 —— `codingprotocols.com`「Trace MCP Tool Calls With OpenTelemetry」、
  `davidparry.com`「MCP: Enterprise Trust Through Traceability」、`niteagent.com` GenAI 语义约定 2026 实地指南
- OpenInference span kind —— Arize 文档转述 / `aiwiki.ai` Arize Phoenix 条目 / 微软开放信任栈
- 评测三层与轨迹判据 —— `langfuse.com`「AI agent evaluation」、`morphllm.com`「AI Agent Evaluation (2026)」、
  `reactify-solutions.com`「agent evaluation and observability 2026」
- 投递纪律与成本单位 —— `bex.co`「You Can't Debug What You Can't See」、
  `agenticspulse.com`「Agent Observability Patterns」、`agentmag.dev`「production tax」
- Datadog 的 OTLP 版本门槛 —— 第三方博客（**已撤回**）；**官方文档另查**（见 §6.1）

---

## 附录 B：端到端实测记录（2026-10-12）

**为什么有这个附录**：§6.1 那条「OTLP/HTTP + JSON 到底收不收」此前**只是推断**。本附录把「拿真 collector 打
**本仓真 payload**」的每一步、每个读数、以及**这次实测证明不了什么**都摊开。产物全部落在
`.workbuddy/reports/2026-10-12/otlp-live/`（gitignore，不入库）。

### B.1 设备：真 collector（不是 mock）

| 项 | 值 |
|---|---|
| 二进制 | `otelcol` **v0.162.0**（darwin/amd64，OTel Collector **core** 发行版） |
| 取法 | GitHub Release **直连**：`opentelemetry-collector-releases` v0.162.0 的 `otelcol_0.162.0_darwin_amd64.tar.gz`（38,227,828 B） |
| sha256 | `7292fdb7673283b5fa4422c33703b846011426f79ac7b0505ed9c314a256870d`（与 Release 附带的 `.sha256` 对拍通过） |
| 接收端 | `receivers.otlp.protocols.http.endpoint: 127.0.0.1:4318` |
| 出口 | `exporters.debug.verbosity: detailed`（逐字段打印，供人眼核对，不做二次解析） |

⚠️ 三个坑记在这里，因为**它们会再咬人**：
1. **`otelcol-otlp` 那个发行版根本没有 `debug` 导出器** —— 配了会报
   `'exporters' unknown type: "debug" (valid values: [otlphttp otlp_grpc otlp otlp_http])`。**要用 core 版。**
2. `docker pull otel/opentelemetry-collector:latest` 在本机**卡死**（只完成 `aeff903166bb`），换镜像源卡在另一层
   ⇒ 放弃 Docker，改 GitHub 直连二进制（先 `curl -r 0-1000` 探到 `http=206` 才敢下全量）。
3. tarball 解出来的文件名两个发行版**不统一**（core = `otelcol`，otlp = `otelcol-otlp`）⇒ 脚本显式指路径，
   别写 `chmod +x otelcol && ./otelcol`。

### B.2 被测物：本仓**真实**导出的 payload

不是手搓 JSON —— 是拿 `scriptedClient` **离线跑一次真 `run`**（含一次真工具调用 ⇒ 才有 `tool.input`/`tool.output`），
把 `createOtlpExporter()` 经 `globalThis.fetch` **真正吐出去的 body** 落盘。

```bash
env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR \
  node --import tsx .workbuddy/probes/otlp-live-probe.ts http://127.0.0.1:4318
```

```json
{ "spans": 3,
  "spanNames": ["otlp-live-probe", "claude-opus-5", "claude-opus-5"],
  "spanKinds": [1, 1, 1],
  "spanIdsHexLen": [16, 16, 16],
  "eventsTotal": 2,
  "eventNames": ["tool.input", "tool.output"],
  "statusCodes": [1, 1, 1],
  "bytes": 3787 }
```

响应：**`HTTP 200` + body `{"partialSuccess":{}}`** —— 这就是那条「未核实」的答案：**收。**

### B.3 结果矩阵：10 个形状 case（每个只改**一处**）

⚠️ 关键设计：每个 case 打**不同的 `resource.service.name`**（`probe-case-NN`），这样能从 collector 日志里
**精确反查**哪些 case 真的到达了解码器 —— 只看 HTTP 码会被「200 但字段被静默丢掉」骗过。

| case | 只改了哪一处 | HTTP | 落进 debug exporter |
|---|---|---|---|
| `00-baseline` | 逐字不改 | **200** | ✅ |
| `01-status-enum-name` | `status.code` = `"STATUS_CODE_OK"`（enum **名**） | **200** | ✅ |
| `02-kind-enum-name` | `kind` = `"SPAN_KIND_INTERNAL"` | **200** | ✅ |
| `03-status-enum-bogus` | `status.code` = `"NOPE"`（值**非法**） | **400** | ❌ |
| `04-spanid-dashes` | `spanId` 插一个 `-` | **400** | ❌ |
| `05-traceid-dashes` | `traceId` 插一个 `-` | **400** | ❌ |
| `06-parent-snakecase` | `parentSpanId` → `parent_span_id`（proto **原名**） | **200** | ✅ |
| `07-empty-anyvalue` | 属性 `{"key":"agentia.probe.empty","value":{}}` | **200** | ✅ 且该属性**在场** |
| `08-nanos-as-number` | 纳秒时间戳写成 JSON number（规范要十进制字符串） | **200** | ✅ |
| `09-unknown-field` | 顶层塞一个规范里没有的字段 | **200** | ✅ |

三条 400 的原文（逐字）：

```
03  {"code":3,"message":"ReadEnumValue: unknown string value, ...  \"NOPE\" ...}
04  {"code":3,"message":"ID.UnmarshalJSONIter: encoding/hex: invalid byte: U+002D '-', ...  \"-468642f5\" ...}
05  {"code":3,"message":"ID.UnmarshalJSONIter: encoding/hex: invalid byte: U+002D '-', ...  \"a04ebca5e\" ...}
```

**读法：只有两类形状会让整批 400 ——「id 不是 hex」与「enum 值彻底非法」。**
枚举名、proto 原名、空 AnyValue、数字纳秒、未知字段**全被收下**。

⚠️ 这条同时**证伪了本仓自己的两条注释**（见 §6.2）：结论对、理由不成立。

### B.4 debug exporter 逐字段摘录（本仓真路径，不是重放的 case）

```
Span #0
    Trace ID       : 3101d13a0ae844dfb898df4ee43fcf26
    Parent ID      :
    ID             : d03565755b1b4fbc
    Name           : otlp-live-probe
    Kind           : Internal
    Status code    : Ok
    Attributes:
     -> session.id: Str(sess-live-1)
     -> stop_reason: Str(end_turn)
     -> gen_ai.operation.name: Str(invoke_agent)
     -> gen_ai.agent.name: Str(otlp-live-probe)
     -> gen_ai.conversation.id: Str(sess-live-1)
Span #1
    Parent ID      : d03565755b1b4fbc
    ID             : 8bbed3c398064d5d
    Name           : claude-opus-5
    Kind           : Internal
    Attributes:
     -> gen_ai.operation.name: Str(chat)
     -> gen_ai.request.model: Str(claude-opus-5)
     -> gen_ai.usage.input_tokens: Int(11)
     -> gen_ai.usage.output_tokens: Int(5)
     -> usage.inputTokens: Int(11)              <- 自有键，与上面「双发」
     -> usage.cacheReadTokens: Int(0)           <- 只有自有键，没有对应的 gen_ai. 键
     -> usage.cacheCreationTokens: Int(0)
     -> usage.costEstimate: Double(0.00018)
    Events:
      SpanEvent #0  Name: tool.input
          -> tool: Str(echo)   -> tool_use_id: Str(tu0)   -> input: Str({"q":"hi"})
      SpanEvent #1  Name: tool.output
          -> tool: Str(echo)   -> tool_use_id: Str(tu0)   -> ok: Bool(true)
          -> durationMs: Int(1)   -> content: Str(hello-from-tool)
```

三个读数值得单独指出：

1. **`session.id` → `gen_ai.conversation.id` 真的落地了** —— 但触发条件是 `session: { store, id }`
   （`runtime/run.ts:147`），**不是** run 上的 `sessionId`。传错字段**既不生效也不报错**（见 §2 行 7）。
2. **`usage.*` 与 `gen_ai.usage.*` 双发**：同一份 token 数挂在两套键名下。而**没有**
   `gen_ai.usage.cache_read.input_tokens` / `cache_write` —— 正是 §3「G3 的落点」那三键之一。
3. **`tool.input`/`tool.output` 是 span event，不是 span**，且两笔都挂在**发起它的那个 `llm.turn`**
   （这里是 Span #1，**不是** run 根）⇒ 「按 span 数统计工具调用恒 0」在这里被**直接看见**。

### B.5 「孤儿 `tool.input`」的复现（不是推演）

`traceLimits.maxEvents` 是全局事件预算。把预算调小，同一个 run 的真实 payload 变成：

```bash
PROBE_MAX_EVENTS=1 node --import tsx .workbuddy/probes/otlp-live-probe.ts <endpoint>
```

| `maxEvents` | 逐 span 事件归属 | 解读 |
|---|---|---|
| 不设（默认） | `otlp-live-probe` → `[]`；`claude-opus-5` #1 → `[tool.input, tool.output]`；#2 → `[]` | 成对 |
| **1** | run 根 → `[trace.truncated, trace.truncated]`；`claude-opus-5` #1 → **`[tool.input]`**；#2 → `[]` | ⚠️ **孤儿 input** |
| **0** | run 根 → `[trace.truncated, trace.truncated]`；两个 `llm.turn` → `[]` | 事件全没了 |

⇒ 两条结论：
1. **「截断可以打破 `tool.input`/`tool.output` 配对」是实测现象，不是理论风险。**
2. `trace.truncated` 这两笔**不吃预算**（`maxEvents=0` 时照样出现 2 笔）—— 它是「预算之外的记账」。

### B.6 这次实测**证明不了**什么（射程 —— 别外推）

- **只有一个接收端**（Collector 0.162.0 的 Go JSON 解码器），且它**偏宽容**：连 `parent_span_id` 这种 proto 原名都收。
  **换后端必须重测** —— Tempo / Jaeger / Langfuse / Phoenix / Datadog **都没测**。
- **规范写「enum MUST 用整数」「proto 原名不许用作 JSON key」，而实现两条都放行** —— 这到底是「实现宽松」
  还是「protojson 本来就允许两种字段名」，本轮**没追到定论**。⚠️ 所以**别把「200 就代表合规」当结论**。
- **id 只验到「非 hex / 长度不对会 400」这一层**（见 B.7）；「id 语义是否正确」**接收端根本不管**（那是下游的事）。

### B.7 第三轮：id 边界矩阵（8 个 case）

脚本 `round3.sh` + `make-cases-id.py`，同样每个 case 打不同 `service.name`（`idprobe-NN`）。

| case | 改了什么 | HTTP | collector 里的读数 |
|---|---|---|---|
| `00-baseline` | 逐字不改 | **200** | `traceId` 32 位、`spanId` 16 位 |
| `10-traceid-short` | `traceId` 截到 30 位 | **400** | `ID.UnmarshalJSONIter: length mismatch` |
| `11-spanid-short` | `spanId` 截到 14 位 | **400** | 同上 |
| `12-lengths-swapped` | 两个长度互换 | **400** | 同上 |
| `13-all-zero-spanid` | `spanId` = 16 个 `0` | **200** | 收下，渲染成**空 `ID`** |
| `14-all-zero-traceid` | `traceId` = 32 个 `0` | **200** | 收下，渲染成**空 `Trace ID`** |
| `15-uppercase-ids` | 两个 id 转大写 | **200** | 收下，**归一化成小写** |
| `16-empty-spanid` | `spanId` = `""` | **200** | 收下，渲染成**空 `ID`** |

⇒ 结论：**400 只由「不是 hex」与「长度不对」触发**；而**全 0 / 空串这类语义上无效的 id 会被静默接受**，
变成「没有 id」。**接收端不替你把关 id 的语义** —— 下游对不上号时，上游没有任何错误可看。

### B.8 第四轮：三个接收端的 JSON 支持（⚠️ **源码级，不是实测** —— 方法与 B.1–B.7 不同）

B.1–B.7 是「起真服务、打真 payload」；**B.8 只回源了源码、没跑起来** ⇒ 下表的状态码是
**从代码里读出来的**，不是观测到的。这也是 §6.3 那唯一一条「仍没能核实」的由来。

| 接收端 | 收到 OTLP/JSON 会怎样 | 依据 |
|---|---|---|
| **OTel Collector 0.162.0** | ✅ 收（`HTTP 200`） | **实测**，见 B.3 |
| **Langfuse** | ✅ 收 | `web/src/server/otel/processOtelIngestion.ts:53-101`：先校验 `content-type` 必须是 `application/json` 或 `application/x-protobuf`（否则 400），再按类型分派；**JSON 分支就是 `JSON.parse(body.toString()).resourceSpans`** |
| **Phoenix** | ❌ **415** | `src/phoenix/server/api/routers/v1/traces.py:477-481`：`if content_type != "application/x-protobuf": raise HTTPException(status_code=415)`；同一函数的 `openapi_extra` 里 `content` **只声明了 `application/x-protobuf`** |

**顺带两条旁证**（来自 Langfuse 那份源码的注释，正好印证本仓发出的形状是对的）：

- `:88` —— *「OTLP JSON encodes int64 fields as decimal strings.」*（本仓也是这么发的）
- `:208` —— *「attributes are a list of `{key, value}` entries, **not a JSON object**.」*
  ⇒ 这是 Langfuse 碰到的**真实**兼容投诉（有人把 `attributes` 写成了 JSON 对象）。
  本仓发的是 `[{key, value}]` 列表（`otlp.ts:191`）**⇒ 踩不到这个坑**。

⚠️ **Phoenix 不是「不懂规范」**：它同一函数里留着注释 *「The server MUST use the same Content-Type
in the response as it received in the request」* —— **它读的是 OTLP 规范原文**，只是**选择只实现 binary**。

**Phoenix 的复算命令**（只读源码）：

```bash
gh api "repos/Arize-ai/phoenix/contents/src/phoenix/server/api/routers/v1/traces.py?ref=main" \
  --jq '.content' | base64 -d | sed -n '440,510p'
```
