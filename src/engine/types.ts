import type { CacheControl, MessageParam } from '../core/message.js';
import type {
  AgentTool,
  ApprovalDecision,
  JsonSchema,
  ModelClient,
  ModelPricing,
} from '../core/tool.js';
import type { SpanError, Trace, TraceContext } from '../core/trace.js';
import type { RetryOptions } from './retry.js';
import type { SuspendedReason, TaskEvent } from '../core/run.js';

/**
 * engine 对模型端的最小结构面（R4 多模型）：消息形态见 core/message.js 的自有类型族，
 * 其他 provider（OpenAI 兼容端点等）只需适配出同一形态。
 * 定义在 core/tool.js 并从此处转导出。
 */
export type { ModelClient } from '../core/tool.js';

/**
 * 模型 fallback 链的一环（R8-P2）：主环节失败且可换时，按数组序落下一环。
 *
 * - `client` 缺省 = 本次 run 的 client（**同端点换模型**是主用例：主模型 429/超时 →
 *   备用模型）；要给别的厂商才显式传另一个 `ModelClient`。
 * - 换环判定与重试判定共用 `classifyError` 的 `retryable` 位（rate_limit / server /
 *   timeout / connection 才换；api/unknown 是请求本身有病，换了也没用；aborted 永不换）。
 * - ⚠️ `client` 是进程内对象：走持久化 store 的异步任务在崩溃续跑后读回的是
 *   反序列化空壳 —— run 入口会响亮抛 TypeError（鸭子类型校验），不静默拿死 client 发请求。
 *   要跨重启仍成立的链请只写 `model`（client 由宿主/runner 级配置兜住）。
 */
export interface ModelFallbackLink {
  /** 备用模型 id（必填，空字符串在 run 入口抛 TypeError） */
  model: string;
  /** 该环用的 client；缺省复用本次 run 的 client */
  client?: ModelClient;
}

export type AgentStopReason =
  /** 模型自然结束（含 stop_sequence：命中 stop 序列同样是正常收尾） */
  | 'end_turn'
  | 'stop_sequence'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'max_iterations'
  /** 声明了 resultSchema，但模型自然收尾时仍未提交合法结构化结果 */
  | 'result_missing'
  /** 调用方主动取消（AbortSignal）：run 未跑完，按失败收尾 */
  | 'aborted'
  /**
   * 成本硬管控触发（C1）：累计 token/成本超限，记账后主动停 run。
   * **算失败**（run 没跑完）—— 与 `max_iterations` 同类：是护栏拦下的，不是正常收尾。
   */
  | 'budget_exceeded'
  /** stop_reason=tool_use 但回合里没有可执行块（畸形响应），防死循环直接停 */
  | 'tool_use_no_blocks'
  /**
   * 人工审批挂起（HITL）：回合里有需审批的 tool_use 还没有决定 ⇒ 整回合一个工具
   * 都没执行（协议要求每个 tool_use 配对 tool_result，见 turn.ts 的审批闸），
   * run 带着完整消息历史（`suspendedMessages`）挂起等待。
   * **不是成功也不是失败**：`isSuccessStopReason` 不含它；trace 状态记 ok
   * （挂起段本身执行无误，「等人」不该被看板算成失败）；宿主据此落库而非收尾。
   */
  | 'suspended'
  /** 模型/网关返回了本框架未识别的 stop_reason：保留文本，但按失败收尾 */
  | 'unknown_stop_reason'
  | 'error';

/**
 * 「是否算正常收尾」的**分类表**（外部深评 E5）。
 *
 * 为什么是 `Record<AgentStopReason, boolean>` 而不是 `reason === 'end_turn' || …`：
 * `Record` 要求**每个成员都在表里表态**，所以「往联合里加一个新的 stop reason」这件事
 * 会让 `tsc` 当场报缺属性 —— **新增原因而漏改分类**在类型上写不出来。
 * 原先的二值 `||` 链没有任何这种约束：加一个成员，它默认落进「失败」，
 * 而三处消费者（`runtime/run.ts` 的 run 状态、`engine/loop.ts` 的 trace 状态、
 * `toolkit/subagent.ts` 的交回判定）会**各说各话**——`stop_sequence` 落地时就真踩过
 * （loop 判成功、Run 判失败；见 `isSuccessStopReason` 的下游注释）。
 *
 * ⚠️ 别把它改成 `Partial<Record<…>>` / 加 `?? false` 兜底：那样这个守卫就废了
 * （缺的成员会被静默当成 false）。`tests/types/stop-reason.types.ts` 用 `@ts-expect-error`
 * 把「表必须是完整的」这一点钉住 —— 谁把它放宽，那条指令就变成未使用 ⇒ 类型检查红。
 *
 * 语义提醒：这里的「成功」只回答**看板算不算成功**。`suspended` 既不算成功也不算失败
 * （挂起段本身执行无误），所以它在表里是 `false` —— 「不是成功」不等于「失败」，
 * 两种「非成功」的区分由 `stopReason` 自己承担。
 */
const SUCCESS_STOP_REASON: Record<AgentStopReason, boolean> = {
  // —— 正常收尾 ——
  end_turn: true,
  stop_sequence: true, // 命中 stop 序列同样是正常收尾
  // —— 非正常收尾（都带结构化 error，见 engine/stop-reason.ts）——
  max_tokens: false,
  refusal: false,
  pause_turn: false,
  max_iterations: false,
  result_missing: false,
  aborted: false,
  budget_exceeded: false, // 护栏拦下的，不是正常收尾
  tool_use_no_blocks: false,
  unknown_stop_reason: false,
  error: false,
  // —— 既不是成功也不是失败 ——
  suspended: false,
};

/**
 * 是否「正常收尾」：end_turn（自然结束）与 stop_sequence（命中 stop 序列）都算。
 * run 状态机 / trace 状态 / 子 agent 交回判定共用这一把尺子 —— 三处各写各的
 * `=== 'end_turn'` 时，新增一个正常收尾原因就会漏改其中一处（stop_sequence 落地时
 * 就出现过：loop 判成功、Run 判失败）。判据在 `SUCCESS_STOP_REASON` 表里（表是穷尽式的）。
 */
export function isSuccessStopReason(reason: AgentStopReason): boolean {
  return SUCCESS_STOP_REASON[reason];
}

/** 可携带 cache_control 的 system 文本块（见 runtime/systemPrompt.ts） */
export interface SystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}
/** system 参数：纯文本，或可缓存块数组（稳定段带 breakpoint，volatile 段放其后不带） */
export type SystemParam = string | SystemTextBlock[];

/**
 * 上下文预算策略（spec §5/§6 —— compaction / context editing）。
 * 引擎在每个 llm 回合发送前调用 beforeTurn；返回的 messages 即本回合发送内容。
 * 实现见 engine/policy.ts 的 createBudgetPolicy，或自实现（如每次用 /count_tokens）。
 *
 * ⚠️ **per-run 状态**：策略可能被配置成应用级单例（`AppOptions.contextPolicy`）被所有
 * run 复用。带状态的实现（滞回计数、token 缓存等）应实现 `forRun` 让每条 run 拿到
 * 独立实例，否则状态跨 run 泄漏（见 forRun 说明）。
 */
export interface ContextPolicy {
  /**
   * 预算（**估算 messages 的** tokens）；超预算的回合触发降级。供观测/文档用。
   *
   * ⚠️ 口径如实（外部深评 E6）：估的**只有 `messages`** —— system prompt 与 tools schema
   * 不在这个数里，而它们同样进请求（`policy.ts` 只把 `messages` 喂给 `countTokens`）。
   * 所以它是「对话历史多大」的尺子，不是「这次请求多大」的尺子：真实 input tokens
   * 恒 ≥ 这个数。改口径要连 `usage-guide` 那一行一起改（两边说的必须是同一件事）。
   */
  readonly budgetTokens?: number;
  beforeTurn(
    messages: MessageParam[],
    info: { iteration: number; model: string },
  ): Promise<MessageParam[]>;
  /**
   * 每条 run 开始时由引擎调用一次，返回**本 run 专用**的策略实例（隔离滞回/缓存等
   * per-run 状态）。缺省（不实现）= 复用自身 —— 只适合无状态策略；有状态又不实现
   * forRun 时，状态会跨 run（含并发 run）共享，行为自己负责。
   */
  forRun?(): ContextPolicy;
}

export interface RunAgentOptions<S extends JsonSchema = JsonSchema> {
  /** 顶层 system（SystemPrompt 产物）。稳定内容应放在 tools 之后、第一个 breakpoint 前 */
  system?: SystemParam;
  /** 初始消息；由调用方给 user 起始消息 */
  messages: MessageParam[];
  /** 主 agent 可调工具（v1 裸 JSON schema） */
  tools?: AgentTool[];
  model?: string;
  /** 流式请求的 max_tokens，给足避免中途截断 */
  maxTokens?: number;
  /** 循环安全上限，防止无限 tool 往返 */
  maxIterations?: number;
  /** 注入 client（缺省经 createAnthropicClient() 创建，读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL env）；多模型见 ModelClient */
  client?: ModelClient;
  /**
   * 模型 fallback 链（R8-P2）：主模型本回合**最终**失败（含其 maxRetries 用尽）且错误
   * 可换（`classifyError` 的 retryable 类：rate_limit / server / timeout / connection）时，
   * 按数组序换下一环重试本回合。每一环开自己的 llm.turn span（model 名正确 ⇒ 成本归因
   * 与 `usage.unpriced` 探测天然对），切换在新 span 上记 `llm.fallback` 事件
   * `{ from, to, errorType }`。三条护栏：`aborted` 永不换（用户取消不是故障）；
   * 本回合**吐过字不换**（与 retry 的「吐过字不重试」同一护栏，否则会拼出两段回答）；
   * **每回合从主环重新起**（fallback 是单回合韧性，不把后续回合钉在备用模型上）。
   * 子 agent / skill 子循环**不继承**本链（它们的 model/client 由能力层显式给）。
   */
  fallbacks?: ModelFallbackLink[];
  /**
   * 记录 assistant 文本进 trace（R8-P3a）：`'full'` = 每回合的模型文本落 llm.turn span 的
   * `output.text` 属性（引擎文本口径：多块 `\n` 连接；过 `maxEventChars` 同一道截断闸 ——
   * 那个管「多长」，这个管「记不记」）。缺省不记（现状逐字不变：llm.turn 只记
   * usage/事件，见 `engine/replay.ts` 的有损边界声明）。纯 tool_use 回合不记（无文本块）。
   *
   * ⚠️ 两个代价，开了就要认：① trace 体积显著增大（模型正文进树）；
   * ② 模型输出从此进入「要脱敏的面」—— 出库前走脱敏配方（`docs/observability.md` §2.4）。
   * 主要消费者：trace → 训练数据导出与逐字复盘。透传给子 agent / skill 子循环
   * （与 `maxEventChars` 同一条转发纪律：同一棵调用树上口径一致）。
   */
  traceContent?: 'full';
  /**
   * 租户/业务维度归因标签（R8-P4）：落 run 根的 `labels.<key>` 属性（trace 侧无基数问题）。
   * 与 `RunSpec.source` 正交不动：source 是框架自己写的**触发来源**审计（sync / async /
   * schedule:<id>），labels 是宿主写的**业务维度**（tenant / plan / …）。
   * 键值都必须是字符串（键非空），否则 run 入口抛 TypeError；可序列化（异步任务随
   * TaskRecord 落库、续跑不丢）。
   * ⚠️ 进 metrics 是**另一个开关**：`metricsSink({ labelKeys })` 显式点名哪些 key 上指标
   * 标签（缺省一个都不上）—— Prometheus 标签基数爆炸是真实事故类，见该选项的注释。
   */
  labels?: Record<string, string>;
  /** 注入 recorder（run 层复用；不注入则内部新建，traceId 即 runId） */
  recorder?: import('./tracer.js').TraceRecorder;
  /** 文本增量回调（终端/SSE 用） */
  onText?: (delta: string) => void;
  /** 中断信号：中止则本回合结束后以 stopReason='aborted' 收尾（不抛异常） */
  signal?: AbortSignal;
  runName?: string;
  /**
   * 入站链路上下文（spec §9.2 跨进程关联）：触发本次 run 的上游 span 记成 run 根的
   * 一条 `links` —— 队列消费者 / HTTP 网关 / 上游服务据此把两个系统的 trace 接起来。
   * 不改 `traceId == runId`，run 仍是自己的新树（见 `core/trace.ts` 的 `TraceContext`）。
   */
  traceContext?: TraceContext;
  /** 上下文预算策略：每回合发送前可编辑/压缩消息（compaction / context editing） */
  contextPolicy?: ContextPolicy;
  /**
   * 模型请求的重试策略（spec §6.5 确定性工程）。缺省**开启**
   * （maxAttempts=3、指数退避 + 抖动）；`false` 关闭。
   * 只重试「尚未产出文本」的可重试失败（429 / 5xx / 连接失败）。
   *
   * 注意：子 agent / skill 内部的 llm 调用走各自的缺省策略，不受单次 run 的 `false` 影响。
   */
  retry?: RetryOptions | false;
  /**
   * 结构化结果 schema（R2）：给出后 engine 追加隐藏工具 submit_result，
   * 模型调用它提交符合 schema 的最终结果，校验通过即结束循环并写入 AgentRunResult.typed；
   * 模型自然收尾却始终未提交则以 stopReason='result_missing' 失败，typed 为 undefined。
   *
   * 泛型 S：传 `fromZod<T>(...)`（TypedSchema<T>）时，返回值 `typed` 自动是 `T | undefined`；
   * 传裸 JsonSchema 时回落 `unknown`。
   */
  resultSchema?: S;
  /**
   * 成本硬管控（C1）：整条 run（**含子 agent**）累计 token 上限。每回合记账后判断
   * （主循环与各级子循环各自判断 —— 预算约束经 `ToolRunContext` 透传，各级共享同一
   * recorder 的累计账单），超限即停，run 以 `stopReason='budget_exceeded'` 收尾（**算失败**）。
   * 与 `contextPolicy`（发送前的上下文裁剪）分工不同 —— 见 `createBudgetGuard`。
   *
   * 口径：input + output + cacheRead + cacheCreation。**不是硬实时**：一回合跑完才判，
   * 所以实际用量可能略超上限（最多超一次回合的量；子循环超限后主循环最多再带出一个
   * 回合入口判断，不会发出新请求）。
   */
  maxTotalTokens?: number;
  /**
   * 成本硬管控（C1）：累计成本（美元）上限。**依赖模型在价格表内**
   * （`engine/usage.ts` 的 DEFAULT_PRICING，或本 run 的 `priceOverrides`）——
   * 不在表里时成本恒为 0，此护栏不触发；要无条件兜底用 maxTotalTokens。
   * 未定价模型会在该回合的 llm.turn span 记 `usage.unpriced` 事件（见 `onUnpricedModel`），
   * 所以"护栏到底有没有生效"是**看得见**的。
   */
  maxCostUsd?: number;
  /**
   * 价格表覆盖/追加（$/1M tokens）：覆盖内置同名项，或给非 Anthropic 模型定价
   * （如 `{ 'deepseek-chat': { in: 0.27, out: 1.10 } }`）。见 `buildPricing`。
   *
   * 会**透传给嵌套能力**（@SubAgent / @Skill 的子循环），所以子 agent 用同一个模型
   * 也能算成本 —— 不会出现「主 agent 有成本、子 agent 恒 0」的割裂。
   * 非法单价在 run 开始时抛错（不静默算出 NaN）。
   */
  priceOverrides?: Record<string, ModelPricing>;
  /**
   * 遇到不在价格表内的模型时的回调（**每个循环作用域内每模型一次**，去重后调用；
   * 主 agent 与每个子 agent 各算一个作用域）。框架同时在该 turn span 上记
   * `usage.unpriced` 事件 —— 成本护栏的失效不再静默。
   *
   * 回调抛错被吞掉（观测是辅助动作，不影响 run）。**不会**改变 run 结局：
   * 定价缺失是宿主配置问题，不该把一次成功的 run 打成失败。
   */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
  /**
   * 单个工具执行的超时（毫秒）；缺省 0 = 不限。超时**不杀 run**：
   * 该条 tool_result 记 `is_error` 回给模型（与「工具抛错不中断 run」同语义，模型可自行换路）。
   *
   * ⚠️ 超时 = **放弃等待**，不是取消工具：`AgentTool.run` 没有 signal 参数，
   * 副作用可能已经发生。想真停的工具请自行读 `ToolRunContext.signal`。
   */
  toolTimeoutMs?: number;
  /**
   * 同一回合内并行工具调用的上限；缺省 `Infinity`（= 旧行为，全部并行）。
   * 工具会打外部系统（DB/HTTP）时设个位数，避免一个回合把下游打爆。
   */
  maxToolConcurrency?: number;
  /**
   * trace 事件正文（`tool.input` 的入参、`tool.output` 的 content）的最大字符数。
   *
   * 缺省按事件类型分别收敛：入参 2000、成功出参 2000、失败出参 1000 ——
   * 调用树里一行看个大概即可，不必把整份工具结果搬进 trace（sink 落库 / OTLP
   * 导出同样按这个体积走）。传**数字**则三类统一用该上限；传 **`false`** 表示
   * **不截断**：完整正文进 trace，供 `agentia dev` 面板 / playground 展开查看
   * （折叠态仍是一行摘要，展开是**客户端**行为，不影响 trace 体积口径）。
   *
   * 同样**透传给嵌套能力**（@SubAgent / @Skill 的子循环）—— 否则调试期开了全文，
   * 子 agent 里的工具事件还是被截断的，「开没开」在同一棵树上会出现两种口径。
   *
   * ⚠️ `false` 不设上限：工具返回多大就记多大，trace 会随之膨胀。调试期开、生产期关。
   * 截断只在**记账**时发生，不影响回给模型的 tool_result（那条永远完整）。
   */
  maxEventChars?: number | false;
  /**
   * 提示词版本号（D4）：写进 run 根 span 的 `system.version` attribute，
   * trace 里据此可查「哪个版本的提示词产出的结果」。
   *
   * 走 `AgentApp.run` 时**不用手填** —— `system` 给 `SystemPrompt({ version })` 实例
   * 就自动带上（见 runtime/systemPrompt.ts）。
   */
  systemVersion?: string;
  /**
   * 菜单内 @Prompt 能力的版本表（`{ 能力名: 版本 }`）：写进 run 根 span 的
   * `prompts.versions` attribute（`name@ver` 逗号拼接），回答「质量退化是不是换了
   * 某个 prompt 资产导致的」。走 `AgentApp.run` 时自动收集（@Prompt 的 `version` 字段）。
   */
  promptVersions?: Record<string, string>;
  /**
   * 会话标识（**引擎级**旋钮）：写进 run 根 span 的 `session.id` attribute（OTLP 导出时映射
   * `gen_ai.conversation.id`），多轮对话的 run 由此可按会话聚合（thread 维度）。
   * 走 `AgentApp.run` / `executeRun` 时给了 `session` 就自动带上，不用手填。
   *
   * ⚠️ 生效范围只到本层（`runAgent` / `executeRun`）：`AgentApp.run` **不转发**它 ——
   * `RunAppOptions` 里那个同名字段继承自 `RunInvocationOptions.sessionId`（**异步宿主**的
   * 可序列化会话引用，语义见 engine/spec.ts），直传给 `app.run` 会 `console.warn` 一次且
   * 不生效（2026-10-12 ref-session-id-warn；此前是静默丢弃）。
   */
  sessionId?: string;
  /**
   * 人工审批决定（HITL）：以 **tool_use_id** 为键。恢复挂起的 run 时由宿主
   * （`AsyncRunner.approve` → 恢复段）传入；手工续跑「assistant 结尾带 tool_use」
   * 的消息历史时也可直接给。菜单里标了 `approval: 'required'` 的工具，
   * 其 tool_use 在这里**没有**决定 ⇒ 该回合整体挂起（见 AgentTool.approval）。
   */
  approvals?: Record<string, ApprovalDecision>;
  /**
   * 挂起期间投递的事件（2026-09-28 ref-run-event-input；语义见 `RunInvocationOptions.events`）：
   * 续跑段在未决 tool_use 解决之后渲染成 user 文本消息注入消息流，并在 run 根
   * 记 `task.event` 事件留痕（`{ injected, event_type, event_id? }` —— `injected`
   * 的口径是「注入进本段消息流」，不等于「模型已看到」）。
   */
  events?: TaskEvent[];
}

export interface AgentRunResult<T = unknown> {
  /** 本次 run 的完整调用树 + usage（traceId == runId） */
  trace: Trace;
  stopReason: AgentStopReason;
  /** 最终文本（提交结构化结果的回合若带文本则取之，可空） */
  finalText: string;
  iterations: number;
  /** 非正常收尾时的结构化原因；正常收尾为 undefined（**字段在场**，见 RunMeta 的说明） */
  error: SpanError | undefined;
  /**
   * resultSchema 校验通过的结构化结果；未设 resultSchema 时为 undefined。
   * 已设 schema 却没提交会以 result_missing 失败，此时同样为 undefined。
   * 类型由 resultSchema 推导（见 RunAgentOptions.resultSchema 的泛型说明）。
   */
  typed: T | undefined;
  /**
   * HITL 挂起时的**完整消息历史**（末尾是含未决 tool_use 的那条 assistant 消息）；
   * 未挂起为 undefined（**字段在场**，与 `error` 同一条结果记录约定）。
   * 恢复 = 把它连同 `approvals` 决定一起喂回 `runAgent` / `app.run`（引擎见到
   * 「assistant 结尾带 tool_use」的输入会先解决这些 tool_use 再调模型）。
   */
  suspendedMessages: MessageParam[] | undefined;
  /**
   * HITL 挂起时**待决的 tool_use_id 列表**（本次挂起缺决定的那些）；未挂起为 undefined。
   * 宿主（`AsyncRunner`）据此持久化「该批哪些 id」，HTTP 轮询方据此知道该审批什么。
   */
  pendingApprovals: string[] | undefined;
  /**
   * 挂起原因（`stopReason === 'suspended'` 时非空）：`approval` = 等人工决定、
   * `timer` = 等一个时刻。宿主据此选闸（审批超时 / 到期唤醒）并落 TaskRecord。
   */
  suspendedReason: SuspendedReason | undefined;
  /**
   * 时间挂起的目标时刻（epoch ms）：`suspendedReason === 'timer'` 时在场，其余为 undefined
   * （**字段在场**，与 `error` 同一条结果记录约定）。
   *
   * 宿主（`AsyncRunner`）把它落成 `TaskRecord.wakeAt` —— 进程重启后「这条在睡的 run 什么时候
   * 该醒」只靠它（`wake-policy.ts` 的 `timerDue`）。等审批的挂起没有这个时刻（人什么时候
   * 批就是什么时候），所以它恒为 undefined。
   */
  wakeAt: number | undefined;
  /**
   * 本段是否把传入的 `events`（run 事件投入口，2026-09-28 ref-run-event-input）**真注入了消息历史**
   * （字段在场）。宿主（`AsyncRunner`）据此清 `TaskRecord.pendingEvents`：注入过 ⇒ 事件
   * 已在历史里，簿记清掉（否则注入后再次挂起的场景会在下次续跑**重复注入**）；
   * 续跑入口的再挂起出口在注入点之前返回（false），簿记留住等跑通的那次。
   */
  eventsDelivered: boolean;
}
