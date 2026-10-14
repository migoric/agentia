import type { Message, MessageParam, TextBlockParam, ToolParam } from './message.js';
import type { SpanError, SpanId, SpanKind, SpanStatus, Trace, Usage } from './trace.js';

/**
 * Agentia —— 工具定义。
 * v1 用裸 JSON Schema，不引 zod。
 * run 执行体可接收第二参 ctx（ToolRunContext），供子 agent/嵌套能力把
 * 自己的 llm.turn 递归挂进当前 trace（capability span 的父由 engine 给定）。
 */

/** JSON Schema 对象子集，供工具的 input_schema */
export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/**
 * 泛型 schema：在普通 JSON Schema 上挂一个**纯类型**的幻影字段，把「校验通过后的
 * 结果类型」带进类型系统 —— 框架据此推导 `AgentRunResult.typed` 与 `@Tool` 方法的
 * 入参类型。运行时**不存在**该字段（见 toolkit/zod.ts 的 fromZod）。
 *
 * 不是必须的：直接给裸 JsonSchema（旧写法）时回落 unknown/any，行为与之前逐字一致。
 */
export interface TypedSchema<T> extends JsonSchema {
  /** 幻影字段（永不在运行时出现）：仅用于类型推导，勿读取 */
  readonly __typed?: T;
}

/**
 * 从 schema 提取「结果类型」：`TypedSchema<T>` → `T`；普通 `JsonSchema` → `unknown`
 * （与 typed 字段旧语义一致）。用于 `runAgent` / `executeRun` / `app.run` 的返回值。
 */
export type SchemaType<S> = S extends TypedSchema<infer T> ? T : unknown;

/**
 * 装饰器方法入参类型：与 SchemaType 同源，但**未给出具体类型时回落 any** ——
 * 这样「裸 JsonSchema」与「fromZod(...) 没写 <T>」两种既有写法都不被破坏
 * （不校验方法签名），只有 `fromZod<T>()` 明确了 T 后才开始校验
 * 「方法签名 vs schema」的一致性。
 */
// biome-ignore lint/suspicious/noExplicitAny: 上面那段注释就是理由 —— 裸 schema / 未写 <T> 时必须回落 any 才不破坏既有写法
export type SchemaInput<S> = S extends TypedSchema<infer T> ? (unknown extends T ? any : T) : any;

/**
 * engine 的 TraceRecorder 面向子能力的最小结构面（core 不依赖 engine）。
 * 需要开嵌套 span 的能力（如 @SubAgent）通过 ctx.recorder 记账，
 * 其余工具可完全忽略它。
 */
export interface RecorderBackend {
  readonly traceId: string;
  begin(kind: SpanKind, name: string, parentSpanId: SpanId | null): SpanId;
  end(
    id: SpanId,
    patch?: {
      status?: SpanStatus | undefined;
      error?: SpanError | undefined;
      usage?: Usage | undefined;
    },
  ): void;
  event(id: SpanId, name: string, body: unknown): void;
  setAttribute(id: SpanId, key: string, value: string | number | boolean): void;
  snapshot(status: SpanStatus): Trace;
  /**
   * 整条 run 的累计 usage（只算 `llm.turn` 的**自身**计量，子 agent 的往返也在内）。
   *
   * 与 `snapshot(status).totalUsage` **同一口径**，但不拷 spans / attributes / events ——
   * 预算护栏每回合要判两次（回合入口 + 回合末），走 `snapshot()` 会白拷全部 span 的
   * attributes/events（O(回合 × 累计事件量)）。**只看总量**的消费者该走这里。
   */
  usage(): Usage;
}

/**
 * engine 对模型端的最小结构面（R4 多模型）：消息形态由 core/message.js 的自有类型族
 * 定义（与 Anthropic Messages API 逐字对齐），其他 provider（OpenAI 兼容端点等）
 * 只需适配出同一形态。
 */
export interface ModelClient {
  messages: {
    stream(params: {
      model: string;
      max_tokens: number;
      system?: string | TextBlockParam[];
      tools?: ToolParam[];
      messages: MessageParam[];
      /**
       * 中断信号（可选）：实现须转发给底层请求，否则调用方无法中止在飞 run。
       *
       * ⚠️ **自定义 client 的常见坑**：`signal` 在**本契约里是 params 的一个字段**，但多数厂商
       * SDK 把「传输层的 signal」放在**请求选项**里（如 `@anthropic-ai/sdk` 的
       * `stream(body, options?)` —— `signal` 只在 `RequestOptions` 里认）。若把本 params 原样
       * 交给 SDK，signal 会被**静默丢弃**，中止失效且**没有任何报错**。
       * 参考实现：`integrations/anthropic.ts`（手写 fetch，signal 摘出 body 直接传给 fetch），
       * 以及 `integrations/openai.ts`（同款）。
       * 门禁：`tests/integrations/anthropic.test.ts`（零 key 本地假端点，abort 后必须断开）。
       */
      signal?: AbortSignal;
    }): {
      on(event: 'text', cb: (delta: string) => void): void;
      finalMessage(): Promise<Message>;
    };
  };
}

/**
 * 模型单价（美元 / 1M tokens）。内置表见 `engine/usage.ts`；宿主可用
 * `priceOverrides` 覆盖或追加（非 Anthropic 端点也能算成成本）。
 * 定义在 core 是为了让 `ToolRunContext` 能带上它 —— core 不能依赖 engine。
 */
export interface ModelPricing {
  in: number;
  out: number;
  /**
   * 缓存**读**乘数（相对 `in`）；缺省 `0.1`（官方标准档）。
   * 官方有逐模型例外：Opus 5.5 是 `0.05`、Fable 5.1 / Mythos 5.1 是 `0.025` ——
   * 这些型号不在内置表里，用 `priceOverrides` 追加时把准数写在这里，成本才不偏。
   */
  cacheRead?: number;
  /**
   * 缓存**写**乘数（相对 `in`）；缺省 `1.25`（官方 **5 分钟** 档）。
   * ⚠️ 官方 **1 小时** 档是 `2`。而框架的 `Usage` 是四项**聚合**的，分不出这一回合的
   * 缓存写是 5m 还是 1h（SDK 的 `Usage.cache_creation` 有拆分，但本框架没把它带上）——
   * 所以宿主若在自己的块上用了 `cache_control: { ttl: '1h' }`，就在这里显式写 `2`，
   * 否则成本会被低估、`maxCostUsd` 会迟触发。
   */
  cacheWrite?: number;
}

/**
 * engine 在调用每个工具时注入的执行上下文（spec §9.2：当前 span 句柄随调用传播，
 * 不用全局单例，保证并行工具调用父子关系准确）。
 * - recorder：整条 run 共享的 recorder（新子能力/子 agent 的 span 写它下面）；
 * - parentSpanId：发起本次调用的上层 span —— 子能力 span 应挂它下面；
 * - client：与主循环同一注入（子 agent 独立循环复用它）。
 */
export interface ToolRunContext {
  client: ModelClient;
  recorder: RecorderBackend;
  parentSpanId: SpanId;
  /**
   * 本次 run 的中断信号。工具**自行决定**是否尊重（如传给 fetch）；框架不会
   * 强制中断工具 —— 工具副作用无法回滚，强行中止只会留下不一致的中间态。
   */
  signal?: AbortSignal;
  /**
   * 宿主的价格覆盖表（见 `engine/usage.ts` 的 `buildPricing`）。嵌套能力
   * （@SubAgent / @Skill）拉起自己的 llm 循环时必须原样传下去，否则自定义定价的
   * 模型在子循环里会退化成"未定价"（成本恒 0，`maxCostUsd` 静默失效）。
   */
  priceOverrides?: Record<string, ModelPricing>;
  /**
   * 宿主的未定价告警回调（F2，见 `RunAgentOptions.onUnpricedModel`）：模型不在价格表、
   * 成本算不出时每模型回调一次。嵌套能力（@SubAgent / @Skill）拉起自己的 llm 循环时
   * 必须原样传下去 —— 否则子循环里的「算不出成本」只有 `usage.unpriced` 事件、
   * 宿主的告警回调静默缺席（`maxCostUsd` 在子循环里失效了却没人知道）。
   */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
  /**
   * 本次工具调用的**引擎侧预算**（毫秒）= 本次 run 的 `RunAgentOptions.toolTimeoutMs`；
   * undefined / 非正 = 引擎不设超时。
   *
   * 存在的意义是**划定裁判权**：工具（尤其带自己计时器的桥，见 `integrations/mcp.ts`）
   * 据此知道「这次调用的超时由引擎判」，从而不再启动第二个计时器 —— 两个计时器判同一件事，
   * 只会得到两种账（桥那份曾被记成 `error(unknown)` + `errorKind=threw`，见 spec §10 2026-09-17 ref-mcp-timeout-single-source）。
   *
   * ⚠️ 它是本次调用的**配置值**，不是「剩余时间」。
   */
  toolTimeoutMs?: number;
  /**
   * trace 事件正文的截断上限（见 `RunAgentOptions.maxEventChars`）。嵌套能力
   * （@SubAgent / @Skill）拉起自己的 llm 循环时必须原样传下去，否则**同一棵调用树
   * 上会出现两种截断口径** —— 主 agent 的工具结果看得见全文、子 agent 的却被截断，
   * 而「子 agent 里的工具为什么失败」恰恰是最需要看全文的地方。
   *
   * 不设（undefined）= 子循环用各自缺省（不是"不截断"）。
   */
  maxEventChars?: number | false;
  /**
   * 本 run 是否记录 assistant 文本进 llm.turn span（`RunAgentOptions.traceContent`，R8-P3a）。
   * 嵌套能力（@SubAgent / @Skill）拉起自己的 llm 循环时必须原样传下去 —— 否则同一棵
   * 调用树上主 agent 的回合有 `output.text`、子 agent 的没有（与 maxEventChars 同理由）。
   *
   * 不设（undefined）= 子循环不记录（缺省行为）。
   */
  traceContent?: 'full';
  /**
   * 成本硬管控（C1）透传：整条 run 累计 token 上限（见 `RunAgentOptions.maxTotalTokens`）。
   * 嵌套能力（@SubAgent / @Skill）拉起自己的 llm 循环时必须原样传下去 —— 预算是
   * **整条 run（含各级子 agent）** 的口径，子循环不拿到它就等于护栏在子循环期间离线
   * （最坏可超一整个子 run 的用量）。各级循环共享同一 recorder，按同一份累计账单判断。
   */
  maxTotalTokens?: number;
  /** 成本硬管控（C1）透传：累计成本（美元）上限；同 maxTotalTokens 的透传语义 */
  maxCostUsd?: number;
  /**
   * 本工具的审批决定（HITL）：仅当该工具声明了 `approval: 'required'` 且本次调用的
   * 决定已到达时在场 —— 工具体内可据此读到自己「被谁、什么时候、以什么理由」
   * 批准/拒绝（审计日志、按 decidedBy 分级授权等）。
   */
  approval?: ApprovalDecision;
  /**
   * 「现在还不是时候，T 之后再问我」（durable timer，2026-09-28 ref-suspend-state-reason 的 timer 侧）。
   * 工具在执行期调用它 = 请求**本回合到此为止**：引擎丢弃本回合这批工具的结果、
   * 把整批 tool_use 挂起（`stopReason: 'suspended'` + `suspendedReason: 'timer'` +
   * 目标时刻 `wakeAt`），到点后由宿主续跑并**重跑这一批**（与审批续跑的形态一致）。
   * 真实用途：等批处理作业、等限流窗口、等收盘、等外部系统回填。
   *
   * ⚠️ 两条契约（都是「说错就静默出事」的位置，细则见 `engine/defer.ts`）：
   * ① **必须传将来的时刻**：T ≤ 现在（或非有限数）**当场抛 TypeError** —— 那次工具调用以
   *    is_error 的 tool_result 回给模型、run 照常往前走（不挂起）。否则到期扫描会立刻
   *    唤醒、重跑、工具再请求同一个过去时刻＝一条自己打转的 run。
   * ② **整批语义**：挂起是回合级的（协议要求每个 tool_use 都有配对 tool_result），
   *    所以同回合**已经执行完**的其他工具会在醒来后重跑（副作用重复）—— 要精确控制就让
   *    模型单独调它，或把它做成幂等读。本回合多个请求取**最早**的那个时刻。
   */
  deferUntil?: (at: number | Date) => void;
  /**
   * 工具执行被引擎**放弃等待**的信号（`toolTimeoutMs` 超时触发）。
   *
   * 放弃 ≠ 取消：超时的语义是「不等了」，没有它时工具在后台继续跑、副作用与花费
   * 都不进任何 trace。想「真停」的工具监听它自行收尾 —— 框架自带的
   * @SubAgent / @Skill 就是这么做的：收到信号即中止子循环（在飞请求被 signal
   * 中止，不再烧 token），capability span 立刻以 error 收尾（交付的 trace 里不留
   * 永不闭合的半截 span）。
   */
  abandoned?: AbortSignal;
}

/**
 * 人工审批决定（HITL）：一条 tool_use 的批准/拒绝结论。
 * 以 **tool_use_id 为键**传给引擎（`RunAgentOptions.approvals`）或随任务落库
 * （`TaskRecord.approvals` —— 进程重启不丢）。
 */
export interface ApprovalDecision {
  /** true = 批准执行；false = 拒绝（该条 tool_result 记 is_error，理由回给模型） */
  approved: boolean;
  /** 拒绝理由 / 备注（回给模型，模型可据此换路） */
  reason?: string;
  /** 审批人标识（审计用） */
  decidedBy?: string;
  /** 决定时刻（epoch ms）；缺省由框架在收到决定时填 `Date.now()` */
  decidedAt?: number;
  /**
   * 审批请求挂起的时刻（epoch ms）—— 框架回填，调用方不必设置。
   * trace 的 `approval.decided` 事件里 `waitedMs = decidedAt - requestedAt` 靠它算出；
   * 缺省（如手工给 `runAgent` 传 approvals）时该事件不带 waitedMs。
   */
  requestedAt?: number;
}

export interface AgentTool<I = unknown, O = unknown> {
  /** 模型可见的唯一名（建议 snake_case） */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 开启严格参数校验（schema 需 additionalProperties:false + required） */
  strict?: boolean;
  /**
   * 人工审批闸（HITL）：`'required'` 时模型发起的该工具调用**不直接执行** ——
   * 该回合挂起（`stopReason: 'suspended'`，回合级全有或全无：同一回合的
   * 其他工具也一并等待，因为协议要求每个 tool_use 都有配对 tool_result），
   * 等宿主把决定（`ApprovalDecision`，按 tool_use_id）喂回来后恢复：
   * 批准 → 正常执行（工具体内经 `ToolRunContext.approval` 读到自己的决定）；
   * 拒绝 → 该条 tool_result 记 `is_error: true`（理由回给模型，可自行换路）。
   */
  approval?: 'required';
  /**
   * 执行体。入参 = 模型按 schema 解析的结构化 input；
   * ctx 由 engine 注入（含 recorder/父 span），需要开嵌套 span 的能力（子 agent）用，
   * 普通工具可忽略。抛错会被包成 is_error 的 tool_result 回给模型，不中断 run。
   */
  run: (input: I, ctx?: ToolRunContext) => Promise<O> | O;
}
