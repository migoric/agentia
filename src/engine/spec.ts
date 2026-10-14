import type { MessageParam } from '../core/message.js';
import type { AgentTool, ApprovalDecision, ModelClient, ModelPricing } from '../core/tool.js';
import type { BlackboardSeed } from '../core/blackboard.js';
import type { TaskEvent } from '../core/run.js';
import type { TraceContext, TraceRecordEvent } from '../core/trace.js';
import type { ContextPolicy, ModelFallbackLink } from './types.js';
import type { RetryOptions } from './retry.js';
import type { TraceLimits } from './tracer.js';

/**
 * Agentia —— run 调用契约（spec §6.3 三类触发共用同一份入参形态）。
 * transport 层（同步 RPC / 异步任务 / 定时）只谈 RunInput / RunSpec，
 * 与具体 agent 装配解耦 —— 换宿主（HTTP/队列/DB）不换语义（spec §6.6）。
 *
 * 放在 engine 的理由：这是 transport 与 runtime **共用**的入参契约，而 engine
 * 在两者之下。此前它在 runtime，导致 store 为了 `TaskRecord.spec` 反向依赖
 * runtime（兄弟层）—— 移到 engine 后 store/toolkit/transport 都能合法引用。
 */

/** 单次 run 透传给引擎/应用的可选调用参数（与 toolkit/module 的 RunAppOptions 子集对齐） */
export interface RunInvocationOptions {
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  client?: ModelClient;
  onText?: (delta: string) => void;
  /** 中断信号：中止则在飞请求被取消，run 以 stopReason='aborted' 收尾 */
  signal?: AbortSignal;
  /** 预置进本次 RunContext.blackboard（扩展过 Blackboard 时键有补全） */
  blackboard?: BlackboardSeed;
  /** 上下文预算策略（compaction / context editing） */
  contextPolicy?: ContextPolicy;
  /** 模型请求重试策略（覆盖应用级缺省）；见 RunAgentOptions.retry */
  retry?: RetryOptions | false;
  /** 幂等键：异步宿主的 at-least-once 去重依据 */
  idempotencyKey?: string;
  /**
   * **记账的数量上限**（spec §9.4 的答案里「让少记了数据可数」那一半）：整条 trace 的
   * 事件总数上限，超限即停止记账并在 run 根留**两笔** `trace.truncated` ——
   * 起点标记 `{ limit }`（断点在这里）+ 收尾摘要 `{ droppedEvents, limit }`（丢了多少）
   * —— 缺口位置可预测（尾巴）、且有计数 ⇒ 可解释。两笔**同时**进交付的 trace 与增量流
   * （见 `TraceLimits`：折叠契约在截断下无例外成立）。
   *
   * 与 `maxEventChars`（单个事件**正文长度**）正交：一个管「多长」、一个管「多少」，
   * 各有各的家，两个都「不设 = 不限」。缺省**不设** —— 全量记账是本框架的承诺，
   * 上限是给「长跑 + 大出参」的宿主一个显式的闸。坏值（NaN / 负数 / 小数）在 run 入口
   * 抛 `TypeError`，不静默失效。见 `TraceLimits`。
   */
  traceLimits?: TraceLimits;
  /**
   * **增量记账出口**（`docs/plans/2026-09-21-incremental-trace-export-and-sampling.md`）：
   * run **进行中**逐笔回调（span 开/合、事件、属性、链路），给「等不了收尾」的消费者 ——
   * 终端面板、SSE 前端、异步任务进度流。
   *
   * 与 `TraceSink` 是**两条缝**（不是替代）：sink 在 run 收尾拿**完整** trace，本回调在运行期逐笔给。
   * 纪律与 sink 同款：**同步调用、不 await**、抛错被吞（观测失败不击穿业务）。
   * ⚠️ 但它**不保证送达**（宿主自己的流断了就断了），也**不是** sink 的替代。
   *
   * 应用级缺省见 `AppOptions.onTraceEvent`；两者**叠加**（应用级在前），不是覆盖 ——
   * 观察者注册不该互相顶掉（per-run 传了面板回调就让应用级那条失聪，是静默回退）。
   */
  onTraceEvent?: (e: TraceRecordEvent) => void;
  /**
   * 入站链路上下文（spec §9.2 跨进程关联）：触发本次 run 的上游 span 记成 run 根的一条
   * `links`。宿主侧两种给法 —— HTTP 头 `traceparent`（W3C，`createHttpHandler` 自动解析）
   * 或直接给 `{ traceId, spanId? }`。走异步宿主时它随 `spec.options` 落进 `TaskRecord`，
   * 所以 `resumePending` 续跑的那次 run 也带得上（跨进程关联不断链）。
   *
   * 不改 `traceId == runId` —— run 仍是自己的新树，见 `core/trace.ts` 的 `TraceContext`。
   */
  traceContext?: TraceContext;
  /** 硬失败是否抛出；缺省 true（异步宿主置 false 落 failed 记录） */
  rethrow?: boolean;
  /** 覆盖整份工具菜单（裸工具同样过应用装配的中间件链 —— 不是旁路，见 toolkit/module） */
  tools?: AgentTool[];
  /** 成本硬管控：整条 run 累计 token 上限；超限以 stopReason='budget_exceeded' 收尾（算失败） */
  maxTotalTokens?: number;
  /** 成本硬管控：累计成本（美元）上限；依赖模型在价格表内，见 createBudgetGuard */
  maxCostUsd?: number;
  /**
   * 模型 fallback 链（R8-P2；语义见 `RunAgentOptions.fallbacks`）。
   * ⚠️ 序列化边界：链环里的 `client` 是进程内对象，随 `TaskRecord` 落库会丢 ——
   * 崩溃续跑读回的是空壳，run 入口会响亮抛 TypeError（鸭子类型校验）。要跨重启仍成立
   * 的链只写 `model`（client 由 runner/应用级配置兜住），或干脆只在应用/run 级配置。
   */
  fallbacks?: ModelFallbackLink[];
  /**
   * opt-in 记录 assistant 文本进 llm.turn span 的 `output.text`（R8-P3a；
   * 语义与代价见 `RunAgentOptions.traceContent`）。可序列化（字符串枚举），异步任务
   * 随 TaskRecord 落库、续跑不丢 —— 与 fallbacks 环里的 client 不同。
   */
  traceContent?: 'full';
  /**
   * 租户/业务维度归因标签（R8-P4；语义与边界见 `RunAgentOptions.labels`）。
   * 可序列化（字符串字典），异步任务随 TaskRecord 落库、续跑不丢。
   */
  labels?: Record<string, string>;
  /** 价格表覆盖/追加（$/1M tokens）；见 RunAgentOptions.priceOverrides */
  priceOverrides?: Record<string, ModelPricing>;
  /** 单个工具执行超时（毫秒）；超时该条 tool_result 记 is_error，不杀 run */
  toolTimeoutMs?: number;
  /** 同回合并行工具上限；缺省不限 */
  maxToolConcurrency?: number;
  /**
   * trace 事件正文的截断上限（字符）。缺省按事件类型分别收敛（入参/成功出参 2000、
   * 失败出参 1000）；传数字则三类统一；**`false` = 不截断**，完整工具结果进 trace，
   * 可在 `agentia dev` 面板 / playground 里展开查看。
   *
   * ⚠️ `false` 会让 trace 体积随工具返回值增长，调试期开、生产期关。
   * 截断只影响记账，回给模型的 tool_result 永远完整。见 `RunAgentOptions.maxEventChars`。
   */
  maxEventChars?: number | false;
  /**
   * 挂起期间投递的事件（2026-09-28 ref-run-event-input，run 事件投入口）：随 `TaskRecord.pendingEvents`
   * 落库（纯数据、可序列化，重启不丢），续跑段由引擎在**未决 tool_use 解决之后**
   * 渲染成 user 文本消息注入消息流（为什么不是宿主直接追加到消息末尾：续跑判定
   * 只认历史**末尾一条**，追加 user 消息会把续跑判成新对话 —— 见 engine/loop.ts）。
   * 手工续跑「assistant 结尾带 tool_use」的消息历史时也可直接给 `app.run`。
   */
  events?: TaskEvent[];
  /**
   * 人工审批决定（HITL）：以 tool_use_id 为键。恢复 `suspended` 任务时由
   * 异步宿主随记录传入（纯数据、可序列化，随 `TaskRecord` 落库）；手工续跑
   * 「assistant 结尾带 tool_use」的消息历史时也可直接给 `app.run`。
   */
  approvals?: Record<string, ApprovalDecision>;
  /**
   * 会话引用（C4 的**可序列化**形态）：会话 id 字符串，随 `TaskRecord` 落库、
   * 重启续跑不丢。只被**异步宿主**消费 —— `AsyncRunner` 配了 `sessionStore` 时，
   * 执行前把它换成 `RunAppOptions.session`（store 实例 + id）注入 run；
   * 没配 `sessionStore` 而任务带了 `sessionId` 则**响亮失败**（submit 即报
   * TaskInputError），不静默降级成「没有会话」。
   *
   * 同步宿主（HTTP `POST /run` / `runSync`）不消费它：那边没有 store 可注入，
   * 会话请走程序内的 `RunAppOptions.session`。
   *
   * ⚠️ 程序内直接 `app.run(messages, { sessionId })` 同样**不生效**（`AgentApp.run`
   * 不消费它）—— 入口会 `console.warn` 一次并指出改用 `session`（2026-10-12 ref-session-id-warn；
   * 此前是静默丢弃：run 根没有 `session.id`、历史接不上、零信号）。
   */
  sessionId?: string;
}

/** 一次任务的规范化入参：messages（已由 normalizeMessages 规整） */
export interface RunSpec {
  messages: MessageParam[];
  options?: RunInvocationOptions | undefined;
  /** 触发来源标记（sync / async / schedule:<id>），供 run 记录审计 */
  source?: string | undefined;
}

/** transport 层接受的原始入参形态 */
export type RunInput =
  | string
  | MessageParam[]
  | { prompt?: string; text?: string; messages?: MessageParam[] };

/**
 * 任务入参不合法（形状 / 空值问题）—— **调用方的错**，transport 据此回 4xx。
 *
 * 为什么要单独一个类型：`runner.submit` 是同步的，入参校验失败与 store 故障
 * （fs/sqlite/redis 抛错）从**同一个 catch** 出去。以前一律回 400 + 原始 message，
 * 于是落库故障被报成「你参数写错了」，还把内部错误消息原样回给调用方 ——
 * 绕过了 500/401 路径都遵守的 `exposeErrors` 策略。有了这个类型才分得开：
 * 它 → 400 + 原因；其余 → 500 + 按策略决定要不要吐原文。
 */
export class TaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskInputError';
  }
}

/** 把任意任务入参规范成 messages（首条缺省包成 user）。 */
export function normalizeMessages(input: RunInput | unknown): MessageParam[] {
  if (typeof input === 'string') {
    // 空串与 []、{prompt:''} 一致报错：返回 [] 会带着空 messages 去调模型
    if (!input) throw new TaskInputError('任务 messages 不能为空');
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    if (input.length === 0) throw new TaskInputError('任务 messages 不能为空');
    return input as MessageParam[];
  }
  if (input && typeof input === 'object') {
    const o = input as { prompt?: unknown; text?: unknown; messages?: unknown };
    if (Array.isArray(o.messages)) {
      if (o.messages.length === 0) throw new TaskInputError('任务 messages 不能为空');
      return o.messages as MessageParam[];
    }
    if (typeof o.prompt === 'string' && o.prompt) return [{ role: 'user', content: o.prompt }];
    if (typeof o.text === 'string' && o.text) return [{ role: 'user', content: o.text }];
  }
  throw new TaskInputError(`无法识别为任务输入: ${JSON.stringify(input)?.slice(0, 200)}`);
}
