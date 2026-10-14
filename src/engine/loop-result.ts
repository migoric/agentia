import type { MessageParam } from '../core/message.js';
import type { SpanError } from '../core/trace.js';
import type { SuspendedReason } from '../core/run.js';
import { classifyError } from './errors.js';
import { abortedError } from './turn.js';
import type { AgentStopReason } from './types.js';

/**
 * Agentia —— 循环出口的**结果形状单源**（engine/loop.ts 的拆分第二步）。
 *
 * `AgentLoopResult` 属「结果/状态记录」型（`docs/guards.md` 的类型角色表）：10 个字段
 * **必须全在场**，值可以为 undefined —— 消费方按 `result.suspendedMessages === undefined`
 * 判「没挂起」，而「字段缺席」与「字段为 undefined」在 JSON / OTLP 上是两回事。
 *
 * 此前这 7 个字段由 loop.ts 的五处对象字面量各写一遍（= 35 次「记得写」）：加一个字段
 * 要改五处，漏一处就是无声的形状漂移。现在出口只剩四个具名构造器，各自的语义写在名字上：
 *
 *   suspendedResult  挂起（等人审批 / 等一个时刻）—— 不是失败；交出的历史是**拷贝**
 *   abortedResult    已取消 —— 带结构化 error（取消不是失败，但原因要可查）
 *   failedResult     抛出被兜住 —— 由 `classifyError` 翻成结构化 error
 *   finishedResult   循环这次**结束**了 —— 成败由 stopReason 表达，error 由调用方给
 *
 * 文件分工：本文件只管「出口长什么样」；什么时候走哪个出口由 engine/loop.ts 决定。
 */

export interface AgentLoopResult<T = unknown> {
  stopReason: AgentStopReason;
  finalText: string;
  /** 非正常收尾时的结构化原因；正常收尾为 undefined（**字段在场**，见 core/run.ts 的说明） */
  error: SpanError | undefined;
  /** 本轮循环自己发起的模型往返次数 */
  iterations: number;
  /** submit_result 校验通过的结构化结果；未提交则为 undefined（类型由 resultSchema 推导） */
  typed: T | undefined;
  /**
   * HITL 挂起（stopReason === 'suspended'）时的完整消息历史
   * （末尾是含未决 tool_use 的 assistant 消息）；未挂起为 undefined（字段在场）。
   */
  suspendedMessages: MessageParam[] | undefined;
  /**
   * HITL 挂起时待决的 tool_use_id 列表；未挂起为 undefined（字段在场）
   */
  pendingApprovals: string[] | undefined;
  /**
   * 挂起原因（`stopReason === 'suspended'` 时非空，2026-09-28 ref-suspend-state-reason）：
   * `approval` = 等人工决定、`timer` = 等一个时刻。**由出口的调用方给** ——
   * 出口自己不认识「为什么挂起」，它只保证这个位一定在场。
   */
  suspendedReason: SuspendedReason | undefined;
  /**
   * 时间挂起的目标时刻（epoch ms）：`suspendedReason === 'timer'` 时在场，
   * 其余（含 `approval` 挂起与一切非挂起收尾）为 undefined（字段在场）。
   *
   * 宿主（`AsyncRunner`）据此落 `TaskRecord.wakeAt`，到期扫描靠它判「醒了没」——
   * 与「原因」同一个道理：**在哪个出口写、什么时候非空**由调用方（循环）说，
   * 出口只保证这个位一定在场。
   */
  wakeAt: number | undefined;
  /**
   * 本段是否把传入的 `events`（run 事件投入口，2026-09-28 ref-run-event-input）**真注入了消息流**
   * （字段在场）。宿主据此清 `TaskRecord.pendingEvents`：注入过 ⇒ 事件已在历史里，
   * 簿记清掉（否则下次续跑会**重复注入**）；没注入（续跑入口的再挂起出口在注入点
   * 之前返回）⇒ 簿记必须留住，等跑通的那次。
   */
  eventsDelivered: boolean;
}

/**
 * 出口的公共底座：把五个「每次都得给」的字段写全，并把两个「只有挂起才非空」的字段
 * 显式写成**在场**。唯一不经过它的是 `suspendedResult` —— 那正是它要覆盖这两个字段的原因。
 */
function loopResult<T>(f: {
  stopReason: AgentStopReason;
  finalText: string;
  error: SpanError | undefined;
  iterations: number;
  typed: T | undefined;
  /** 缺省 false（没注入过事件是绝大多数出口的真相） */
  eventsDelivered?: boolean;
}): AgentLoopResult<T> {
  return {
    stopReason: f.stopReason,
    finalText: f.finalText,
    error: f.error,
    iterations: f.iterations,
    typed: f.typed,
    suspendedMessages: undefined,
    pendingApprovals: undefined,
    suspendedReason: undefined,
    wakeAt: undefined,
    eventsDelivered: f.eventsDelivered ?? false,
  };
}

/**
 * 挂起请求：**为什么**挂起由调用方说（出口不认识业务原因），`pending` 是本批未决的 id。
 *
 * 判别联合让「说 timer 却不给时刻」在类型上写不出来（`wakeAt` 是 timer 分支的必填项）——
 * 落到结果里就成了 `suspendedReason === 'timer' ⇔ wakeAt 在场` 这条不变量，
 * 到期扫描读的就是它（`wake-policy.ts` 的 `timerDue`）。
 */
export type Suspension =
  | { reason: 'approval'; pending: string[] }
  | { reason: 'timer'; pending: string[]; wakeAt: number };

/** 挂起收尾（四处出口共用：循环中途挂起 / 恢复模式进来决定仍不齐 / 两处延后请求） */
export function suspendedResult<T>(
  ctx: {
    messages: MessageParam[];
    /**
     * 段级进度簿记。`eventsDelivered` **必须从这里读**（不是 ctx 上的独立字段）：
     * 它跨段共享、外层收尾也读同一份（见 `loop.ts` 的 catch 与外部深评 E4）。
     * ⚠️ 别把它挪回 ctx 的顶层字段 —— 那样四个挂起出口会**静默报 false**
     * （可选字段缺失不报错），2026-09-28 第一版就是这么改的，被既有用例当场抓住。
     */
    progress: { iterations: number; eventsDelivered?: boolean };
    typed: T | undefined;
  },
  suspension: Suspension,
  /** 挂起前那一回合的文本（循环中途挂起时给；恢复模式再次挂起时没有新回合，留空） */
  finalText = '',
): AgentLoopResult<T> {
  return {
    ...loopResult<T>({
      stopReason: 'suspended',
      finalText,
      // 挂起不是失败：等人不该被看板算成失败（区分由 stopReason 承担）
      error: undefined,
      iterations: ctx.progress.iterations,
      typed: ctx.typed,
    }),
    // 历史是**拷贝**：宿主落库后仍可能继续用同一条数组，挂起段的消息不能再被改
    suspendedMessages: [...ctx.messages],
    // 待决 id 列表原样交出（同一引用）—— 调用方此后不再改动它，保留原行为，不顺手加拷贝
    pendingApprovals: suspension.pending,
    suspendedReason: suspension.reason,
    // 只有时间挂起有目标时刻；判别联合让这一行不可能「说 timer 却没时刻」
    wakeAt: suspension.reason === 'timer' ? suspension.wakeAt : undefined,
    eventsDelivered: ctx.progress.eventsDelivered ?? false,
  };
}

/**
 * 已取消收尾。取消**不是失败**，但必须带结构化 error —— 否则 trace 上只看到「停了」，
 * 看不出是「人取消的」还是「上游出错的」。
 *
 * `iterations` 由调用方给实际进度：取消可能发生在第 N 回合之后，硬写 0 会谎报成「一次模型都没调」。
 */
export function abortedResult<T = never>(iterations = 0): AgentLoopResult<T> {
  return loopResult<T>({
    stopReason: 'aborted',
    finalText: '',
    error: abortedError(),
    iterations,
    typed: undefined,
  });
}

/**
 * 抛出被兜住的收尾：`cause` 是**任何**抛出来的东西（SDK 异常、类型错误、abort 信号……），
 * 出口处一律经 `classifyError` 翻成结构化 SpanError —— 「非正常收尾必带结构化 error」
 * 这条不变量落在这一处，而不是散在各 catch 里。
 *
 * ⚠️ `eventsDelivered` 必须由调用方**按事实**传入，不在这里硬写 `false`（外部深评 E4）：
 * `false` 的含义是「本段没注入过事件」，而这条出口完全可能发生在注入**之后**
 * （事件注入 → 后续回合请求失败 ⇒ 落到这里）。硬写就把「已注入」报成「未注入」——
 * 该字段随 `rec.result` **落库、在导出面上**，消费者据此判断「这批事件进没进历史」，
 * 报错方向恰好会让宿主以为该重投（重投 = 模型看到两条）。
 *
 * 当日为什么没被发现：`pendingEvents` 的清理在**终态**分支是无条件的（`async.ts`），
 * 而这条出口只走终态 ⇒ 框架内部的簿记恰好被掩盖。它坏的是**对外字段的语义**，不是内部行为 ——
 * 所以这是「如实类」修复：**零行为变更，一个字段不再说谎**。
 */
export function failedResult<T = never>(
  cause: unknown,
  iterations: number,
  eventsDelivered?: boolean,
): AgentLoopResult<T> {
  return loopResult<T>({
    stopReason: 'error',
    finalText: '',
    error: classifyError(cause),
    iterations,
    typed: undefined,
    ...(eventsDelivered !== undefined ? { eventsDelivered } : {}),
  });
}

/**
 * 循环这次结束了。名字刻意不含成败：`stopReason` 才是成败的表达
 * （`end_turn` / `stop_sequence` 成功，`budget_exceeded` / `max_iterations` / `refusal` 一类
 * 非正常收尾则由调用方把结构化 `error` 一并给出）。
 */
export function finishedResult<T>(f: {
  stopReason: AgentStopReason;
  finalText: string;
  iterations: number;
  typed: T | undefined;
  error?: SpanError | undefined;
  eventsDelivered?: boolean;
}): AgentLoopResult<T> {
  return loopResult<T>({
    stopReason: f.stopReason,
    finalText: f.finalText,
    error: f.error,
    iterations: f.iterations,
    typed: f.typed,
    ...(f.eventsDelivered !== undefined ? { eventsDelivered: f.eventsDelivered } : {}),
  });
}
