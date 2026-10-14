import type { SpanError } from './trace.js';

/**
 * Agentia —— run 生命周期数据模型（spec §6.1）。
 *
 * 放在 core 的理由：`RunStatus` / `RunMeta` 是纯数据，只依赖 `core/trace`。
 * store / transport / runtime 都要读它，下沉 core 后三者都不必再向上引 runtime
 * （此前 `store → runtime` 是未声明的兄弟层依赖，见 AGENTS.md 分层约定）。
 *
 * `suspended`：run **挂起了** —— **非终态**（awaitTask 继续轮询）、不占并发槽（执行段落已
 * 收尾释放）、`resumePending` 不捡走（它不是孤儿，崩溃续跑语义不适用于「在等」）；
 * 消息历史（含未决 tool_use）与待决清单随 TaskRecord 落库。
 *
 * 「挂起」是**一个状态 + 一个原因**（2026-09-28 ref-suspend-state-reason：从前 `awaiting_approval` 一个状态兼职
 * 两件事）：状态只说「它在等」，等什么由 `SuspendedReason` 说 —— 判据（审批超时 / 能否
 * 审批）落在**原因**上，于是「时间挂起被审批超时提前叫醒」这类误伤在类型上就写不出来。
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  /**
   * 被**取消**（宿主调 `runner.cancel`）—— 终态，但与 `failed` **分开**：
   * 取消不是失败（引擎侧 `abortedResult` 的注释早就这么写），运维读数不该把
   * 「人按的」与「跑挂的」混成一类（`GROUP BY status` 是第一读者）。
   * 机制上是 `abort signal`（与 `runTimeoutMs` 同一条），差别在**意图** ——
   * 状态按意图落：超时仍是 `failed`。
   *
   * ⚠️ **可达性如实（外部深评 K3）**：这个成员**由宿主落**（`TaskRecord.status`），
   * 进程内 `Run` **到不了它** —— 引擎侧的取消表现为 `stopReason: 'aborted'`，
   * `Run.finish()` 按 `isSuccessStopReason` 判 ⇒ 记 `failed`（带结构化
   * `error.type: 'aborted'`）。同一份联合类型有**两个消费者、可达集不同**，这是有意的：
   * `TaskRecord` 是运维读数（「人按的」与「跑挂的」必须分得开，`GROUP BY status` 是第一读者），
   * 而 `Run` 是进程内状态机（只关心跑没跑完）。要加状态时**先想清是给谁的**。
   */
  | 'cancelled';

/**
 * 挂起原因 —— 「等人工审批」与「等一个时刻」是两种挂起，判据必须分开：
 *   approval —— 等人工决定（HITL）：`approve()` 能叫醒它，`approvalTimeoutMs` 管它；
 *   timer    —— 等一个时刻（durable timer）：只有到点能叫醒它。
 * ⚠️ 拿 timer 挂起去撞 `approvalTimeoutMs` = **提前叫醒一条在睡的 run** ——
 * 那两条闸（`approvalExpired` / `approve` 的 409）因此都 gate 在原因上，不 gate 在状态上。
 */
export type SuspendedReason = 'approval' | 'timer';

/**
 * `RunStatus` → 「是不是终态」的**唯一真源**（2026-09-28 外部深评 S1）。
 *
 * 为什么要有它：这个判定此前**散在三处各写一遍**，而且写法不同——
 * `transport/async.ts` 的 `isTerminalTask` 是 `status !== 'queued' && …`（负向枚举
 * 非终态），`store/redisStore.ts` 施加 TTL 时压根判都不判（于是**挂起中也照样过期**：
 * 一条在等审批的任务，TTL 一到记录就没了，「批了它」的决定无家可归 —— 与
 * `InMemoryTaskStore.evict` 里那句「suspended 不可淘汰」正好相反）。谁都没错，
 * 合起来是错的：**同一事实的两份读数**。
 *
 * 形状取**穷尽的分类表**而不是负向枚举：往 `RunStatus` 加成员而不在这里表态 ⇒
 * `tsc` 报缺属性（`TS2741`，与 `stop-reason.ts` 的分类表同款）。负向枚举会让新成员
 * **静默变成「终态」**——那正是「挂起中的任务被当成跑完了」那类 bug 的来源。
 */
const TERMINAL_STATUS: Record<RunStatus, boolean> = {
  queued: false,
  running: false,
  // 挂起**不是**终态：批了（或睡到点）它会接着跑
  suspended: false,
  succeeded: true,
  failed: true,
  cancelled: true,
};

/** 该状态是否已到终态（不会再变）。判定只此一处 —— 别在调用点重写。 */
export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUS[status];
}

/**
 * run 事件（2026-09-28 ref-run-event-input，run 事件投入口）：外部系统投给一条**挂起** run 的一条输入
 * （`AsyncRunner.signalTask` / `POST /tasks/:id/events`；审批是它的特例）。
 *
 * 白名单形状（设计稿 B1）：**全是字符串** —— 外部永远不能构造消息块，投毒面只到
 * 「内容注入」为止（任意 `MessageParam` 透传 = 把伪造 assistant / tool_use 块的能力
 * 交给外部，那是协议注入，明确不做）。续跑段由引擎把它渲染成**一条 user 文本消息**
 * 注入消息流（见 `engine/resume-input.ts` 的 `renderTaskEvent` 与 `engine/loop.ts`）。
 *
 * 与 `transport/task-events.ts` 的 `TaskStreamEvent` 不是一回事：那个是**记账事件流**
 * 的一帧（出站，`GET /tasks/:id/stream`），这个是**入站**输入。
 */
export interface TaskEvent {
  /**
   * 幂等键（可选）：给了就按它去重 —— 同一任务重复投递同一个 eventId ⇒ 409
   * （与 cancel 的「已终态」同款：说出来，不静默）。去重簿记随 TaskRecord 落库
   * （`deliveredEventIds`，有界 FIFO），跨进程/重启不丢。
   * **不给则没有恰好一次**：重复投递 = 重复进消息历史（如实文档化，不假装）。
   */
  eventId?: string | undefined;
  /** 事件类型（非空字符串，如 `payment.settled`）—— 进渲染文本与 trace 留痕 */
  type: string;
  /** 事件正文（字符串）。HTTP 侧的字节上限与 `maxBodyBytes` 同口径（整个 body 那一道闸） */
  payload: string;
}

/**
 * run 的运行记录（供持久化 / 读取）。字段**必填但可为 undefined**：它们是框架在 run
 * 生命周期各阶段**总是写进对象**的状态（`toMeta()` 一次构造全量），「缺省」在这里不是
 * 一个有意义的语义 —— 与「可选入参」不同。这条区分由 tsconfig 的
 * `exactOptionalPropertyTypes` 强制：可选入参保持 `?: T`（调用点不许显式传 undefined），
 * 而状态/结果记录写成必填 `T | undefined`（字段在场、值可能没有）。
 */
export interface RunMeta {
  runId: string;
  status: RunStatus;
  idempotencyKey: string | undefined;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  error: SpanError | undefined;
  /**
   * 挂起原因（仅 `status === 'suspended'` 时非空）—— 「字段在场」约定同 `error`：
   * 它是 run 生命周期里**总会写进对象**的状态位，缺省在这里没有语义。
   */
  suspendedReason: SuspendedReason | undefined;
  /**
   * 时间挂起的目标时刻（epoch ms，仅 `suspendedReason === 'timer'` 时非空；字段在场约定同上）
   * —— 「这条 run 什么时候该醒」是运行记录的一部分，与「在等什么」并列。
   */
  wakeAt: number | undefined;
}
