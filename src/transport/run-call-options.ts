import type { MessageParam } from '../core/message.js';
import type { ModelClient } from '../core/tool.js';
import type { TraceRecordEvent } from '../core/trace.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import type { TaskRecord } from '../store/store.js';

/**
 * Agentia —— **一次 run 调用的选项装配**（2026-10-11 自 `transport/async.ts` 的
 * `#executeInner` 里切出，与 `slot-pool` / `drain-gate` / `resume-policy` 同一批做法）。
 *
 * 为什么抽：那 42 行是 `#executeInner` 里**唯一与状态机无关**的一块 —— 它只是把「这条任务
 * 的记录 + runner 持有的实例」翻译成引擎要的 `RunInvocationOptions`，判据全是**局部可回答**
 * 的（本段是不是续跑段、有没有幂等键、有没有上一段 runId）。留在状态机里的代价是它把
 * 那个方法顶到了 257 行（`tests/architecture/method-size.test.ts` 的射程内）。
 *
 * ⚠️ **这是逐字搬迁**：每一条 `...(cond ? {k: v} : {})` 的**形状**都是承重的 ——
 * 不能「顺手」改成 `{k: cond ? v : undefined}`：本仓开着 `exactOptionalPropertyTypes`
 * （显式 undefined ≠ 不传），而下游那些字段的语义正是「**没这个键**才走缺省」。
 * 判据见 `docs/spec.md` §10 里 `exactOptionalPropertyTypes` 那一轮。
 */

/**
 * 会话历史 store 的**结构面**（类型单源；旋钮本身的文档在 `AsyncRunnerOptions.sessionStore`）。
 * `load` / `append` 都可以是异步的 —— 异步 store 下续跑段要 await。
 */
export type RunSessionStore = {
  load(sessionId: string): MessageParam[] | Promise<MessageParam[]>;
  append(sessionId: string, messages: MessageParam[]): void | Promise<void>;
};

/** 「记账事件 → 本任务流」的桥 + 调用方自带的那个 sink，已由 `composeTraceEvents` 合成一个 */
export type TraceEventBridge = (e: TraceRecordEvent) => void;

/** 引擎侧调用选项 + 本层补上的 `session`（见 `buildRunCallOptions` 的注释） */
export type RunCallOptions = RunInvocationOptions & {
  session?: { store: RunSessionStore; id: string };
};

export interface RunCallOptionsInput {
  /** 任务记录（读 `spec.options` / `idempotencyKey` / `approvals` / `pendingEvents` / `runId`） */
  rec: TaskRecord;
  /**
   * 本段是不是**续跑段**（不只是 HITL：时间挂起醒来也是续跑）。
   * 判据在调用方（`rec.approvals !== undefined || rec.suspendedSince !== undefined`）——
   * 它同时决定会话注入、链路关联与会话回写三条口径的走向，见 `async.ts` 的注释。
   */
  isResume: boolean;
  /** runner 持有的会话 store；未配置则 `undefined` */
  sessionStore: RunSessionStore | undefined;
  /** runner 的缺省 client（任务自己带 `options.client` 时被它盖掉） */
  client: ModelClient | undefined;
  /** 已合成的中止信号（调用方 signal / 超时 / 取消三条来源合一） */
  signal: AbortSignal;
  /** 记账事件 → 本任务流的桥；没订阅流时为 `undefined` */
  bridgeTraceEvents: TraceEventBridge | undefined;
}

/**
 * 装配交给 `app.run(messages, opts)` 的选项。
 *
 * 三条口径在这里落地（每条的**为什么**见下方逐条注释，搬迁时一字未改）：
 * ① 续跑段**不注入 session**；② `exactOptionalPropertyTypes` 下「无值就不落键」；
 * ③ 续跑段的 trace 挂到上一段的 runId 上（`traceContext`）。
 */
export function buildRunCallOptions(input: RunCallOptionsInput): RunCallOptions {
  const { rec, isResume, sessionStore, client, signal, bridgeTraceEvents } = input;
  // sessionId 在本层**已被消费**（下面换成 session 注入；没配 sessionStore 的在 submit /
  // 派发处已响亮失败），**不随选项透传**：续跑段刻意不注入 session（见下），若让它原样
  // 进 app.run，会撞上那边「程序内直传 sessionId 不生效」的告警 —— 那是给外部调用方的
  // 出声闸（toolkit/module.ts），内部路径不该踩。
  const { sessionId, ...restOptions } = rec.spec.options ?? {};
  return {
    ...restOptions,
    // HITL 恢复段**不注入 session**（2026-09-20，spec §10 当日条）：恢复段的
    // rec.spec.messages 是挂起段落库的 suspendedMessages —— 已含 loadSession
    // 拼入的完整会话历史，再注入会让 run 层把 store 历史**再 prepend 一遍**
    // （历史翻倍、token 复利）；且成功后 appendSession 会把整段扩展历史
    // （含未决 tool_use 的 assistant）写进会话 —— 违反「只存对话轮次」不变量，
    // 留下孤立 tool_use + 连续两条 assistant，下一轮该会话直接撞 API 400。
    // 恢复段的会话回写由 AsyncRunner 在成功后补写（见 #appendResumedSession）。
    ...(!isResume && sessionId !== undefined && sessionStore !== undefined
      ? { session: { store: sessionStore, id: sessionId } }
      : {}),
    // 显式 undefined ≠ 不传（exactOptionalPropertyTypes）：无幂等键时不落这个键
    ...(rec.idempotencyKey !== undefined ? { idempotencyKey: rec.idempotencyKey } : {}),
    ...(rec.spec.options?.client !== undefined
      ? { client: rec.spec.options.client }
      : client !== undefined
        ? { client }
        : {}),
    // HITL 恢复段：审批决定随任务落库，重跑时原样进引擎（进程重启不丢）
    ...(rec.approvals !== undefined ? { approvals: rec.approvals } : {}),
    // 事件投入口（2026-09-28 ref-run-event-input）：挂起期间投递的事件随记录进引擎，由它在
    // 未决 tool_use 解决之后注入消息流（为什么不能由宿主直接追加进
    // spec.messages 的末尾：见 signalTask 与 engine/loop.ts 的注入点纪律）
    ...(rec.pendingEvents !== undefined && rec.pendingEvents.length > 0
      ? { events: rec.pendingEvents }
      : {}),
    // 恢复段的 trace 是一棵**新树**，经 traceContext link 挂到上一段 runId
    // （spec §9.2 的入站关联机制）——「挂起段 → 恢复段 → …」在观测后端连成一条链。
    // 判定依据：本段是续跑段（isResume）且已有上一段 runId；首次执行两者皆无。
    ...(isResume && rec.runId !== undefined ? { traceContext: { traceId: rec.runId } } : {}),
    rethrow: false, // 硬失败也以 failed 记录落库
    signal,
    // 记账事件 → 本任务的流
    ...(bridgeTraceEvents !== undefined ? { onTraceEvent: bridgeTraceEvents } : {}),
  };
}

/**
 * 异步 store 的**幂等去重**在派发处的补齐（`submit` 的同步门面无法 await，所以这里再来一次）：
 * 同键已有 `succeeded` 记录 ⇒ **采纳它的结果**，不重复执行。
 *
 * 适用范围（判据三条缺一不可）：存在既有记录、**不是自己**（同步 store 下查到的一般就是
 * `rec` 自身，taskId 相同 ⇒ 放行）、且状态是 `succeeded`。`queued` / `running` 一律不采纳
 * —— 重复执行本就是 at-least-once 允许的行为。
 *
 * ⚠️ **load-bearing**：该去重依赖 `store.save` **先写记录、后写 idem 索引**的顺序
 * （见 `redisStore` 头注释）—— 索引指向自身时靠上面的 taskId 相等判断放行。
 *
 * 返回 `true` 表示已把既有结果搬到 `rec` 上（调用方负责落库；**落库失败也不该把一次已知
 * 成功的任务翻成 failed**，那是调用方那层的口径）。
 */
export function adoptSucceededOutcome(rec: TaskRecord, existing: TaskRecord | undefined): boolean {
  if (!existing || existing.taskId === rec.taskId || existing.status !== 'succeeded') return false;
  rec.status = 'succeeded';
  rec.runId = existing.runId;
  rec.result = existing.result;
  rec.error = existing.error;
  rec.finishedAt = Date.now();
  return true;
}
