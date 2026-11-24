import type { MessageParam } from '../core/message.js';
import type { BlackboardSeed } from '../core/blackboard.js';
import type { TraceRecordEvent } from '../core/trace.js';
import type { RunPolicyInput } from './types.js';
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
/**
 * 单次 run 透传给引擎/应用的可选调用参数（与 toolkit/module 的 RunAppOptions 子集对齐）。
 *
 * 25 个共同策略字段见 `RunPolicyInput`（与 `RunAgentOptions` **同一份声明**）；
 * 本接口只留**异步宿主特有**的那 5 个。这样「同一句话写两处」不会再有第二个版本 ——
 * 设计与审计见 `docs/plans/2026-11-22-runpolicy-value-object.md`。
 */
export interface RunInvocationOptions extends RunPolicyInput {
  /** 预置进本次 RunContext.blackboard（扩展过 Blackboard 时键有补全） */
  blackboard?: BlackboardSeed;
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
  /** 硬失败是否抛出；缺省 true（异步宿主置 false 落 failed 记录） */
  rethrow?: boolean;
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
