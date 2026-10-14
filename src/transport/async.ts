import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { MessageParam } from '../core/message.js';
import type { ModelClient } from '../core/tool.js';
import type { AgentRunResult } from '../engine/types.js';
import { classifyError } from '../engine/errors.js';
import type { RunStatus, TaskEvent } from '../core/run.js';
import { isTerminalStatus } from '../core/run.js';
import { normalizeMessages, TaskInputError } from '../engine/spec.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import { InMemoryTaskStore, cloneTaskRecord, isThenable, nextTaskId } from '../store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../store/store.js';
import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import { abortedError } from '../engine/turn.js';
import { assertTimerDelay, TimeoutError } from '../core/timeout.js';
import { zeroClauseOf } from '../core/limits.js';
import { composeTraceEvents } from '../core/trace.js';
import type { TraceRecordEvent } from '../core/trace.js';
import { SlotPool } from './slot-pool.js';
import { ApprovalSupervisor } from './approval-supervisor.js';
import type { ApprovalDecisions } from './approval-supervisor.js';
import { SignalSupervisor } from './signal-supervisor.js';
import { ResumeScanner } from './resume-scanner.js';
import type { ResumePendingOptions } from './resume-scanner.js';
import { timerDue } from './wake-policy.js';
import type { SuspendedSummary } from './wake-policy.js';
import { DrainGate } from './drain-gate.js';
import { formatOwnerId } from './owner-id.js';
import { TaskWaiters } from './task-waiters.js';
import { TaskEventStreams } from './task-events.js';
import type { TaskStreamEvent } from './task-events.js';
import { adoptSucceededOutcome, buildRunCallOptions } from './run-call-options.js';
import type { RunSessionStore } from './run-call-options.js';
import { applySuspendedOutcome, applyTerminalOutcome, readClaimed } from './run-outcome.js';

// 三个监督件（2026-09-29 抽出）的实现与类型现在各自在文件里 —— 审批（approval-supervisor.ts）、
// 事件投递（signal-supervisor.ts）、恢复扫描（resume-scanner.ts）。下面 **re-export** 它们的
// 对外符号 ⇒ 一切 `from './async.js'` 的既有 import 路径不变。
export { TaskApproveError } from './approval-supervisor.js';
export type { ApprovalDecisions } from './approval-supervisor.js';
export { TaskEventError } from './signal-supervisor.js';
export type { ResumePendingOptions } from './resume-scanner.js';

/**
 * Agentia —— 异步任务宿主（spec §6.3 异步 / §6.5 确定性 / §6.6 换宿主不换语义）。
 *
 * - submit 即回（queued），后台驱动状态机 queued → running → succeeded/failed；
 *   工具标了 `approval: 'required'` 时 run 可在回合间挂起为 **suspended**
 *   （HITL：非终态、不占并发槽、不触发 TaskSink.onFinished），`approve()` 给齐决定后恢复；
 *   工具调 `ctx.deferUntil(t)` 时同样挂起（durable timer：`suspendedReason: 'timer'`），
 *   到点由 `resumePending` / `poll` 的**惰性**扫描唤醒（不起定时器，见 wake-policy.ts）；
 *   两条挂起路径的**闸按原因分开**（等谁的决定 vs 等到点了没）；
 * - **at-least-once 去重**：同一 idempotencyKey 重复 submit，若上一任务仍在
 *   queued/running/succeeded 则直接返回既有记录，不重复执行（失败可重试新任务）；
 * - run 记录落 TaskStore（v1 InMemoryTaskStore），trace 随 result 一同保留；
 *   DB/队列宿主只需实现 TaskStore。
 *
 * 异步 TaskStore（R6，TaskStore 方法返回 MaybePromise）：
 * - 内部执行路径（#execute / awaitTask / resumePending）全部 await 化，两种 store 通吃；
 * - submit/poll/byIdempotency/list 是**同步门面**，为同步 store 保持原有用法与返回类型
 *   （http/scheduler/既有调用方零改动）。接异步 store 时：submit 的即时去重无法进行
 *   （推迟到 #execute：同键已有 succeeded 记录则采纳其结果、不重复执行），poll 等
 *   返回 Promise 需调用方自行 await。
 */

/**
 * 任务完成回调（C5）。任务达终态、记录已落库后调用。
 * **抛错被吞**，绝不影响任务状态（与 trace sink / memory 回写同款防护）。
 *
 * webhook 故意**不做进框架**：用本接口 + 你自己的 `fetch` 就能搭（含签名与重试策略），
 * 而那会引入「出站请求 + 重试 + 签名」一整套复杂度。
 */
export interface TaskSink {
  onFinished(rec: TaskRecord): void | Promise<void>;
}

/**
 * 落库失败的形状（`AsyncRunnerOptions.onPersistError` 的入参）。
 *
 * ⚠️ 回调只在「**这次写出本身**失败」时 firing —— `error` 永远是**这次**写出的错。
 * `phase` 区分两次**都曾静默**的写出：
 * - `'initial'` —— 提交时那次 `save` 迟到 reject 之后的**补偿性重存**（把任务改判为
 *   `failed` 再写）也失败了。注意：原始那次 reject 本身**不触发**本回调（它只触发
 *   补偿路径），这里拿到的 `error` 是**重存**的错，不是原始 save 的。
 *   同步 store 当场抛走的也不是这条路（那条按 `TaskInputError` 处理，本来就响亮）。
 * - `'outcome'` —— 终态（或挂起态）那次写出失败。**这条最贵**：库里停在 `running`，
 *   而它其实已经跑完了（副作用已发生）—— 重启后 `resumePending` 会把它当孤儿**再跑一遍**。
 */
export interface PersistFailureInfo {
  record: TaskRecord;
  error: unknown;
  phase: 'initial' | 'outcome';
}

/**
 * 任务事件流的一帧（`GET /tasks/:id/stream` 的帧形状，与 SSE 帧名一一对应）。
 *
 * 为什么帧里带 `index`：SSE 的 `Last-Event-ID` / `?from=` 指的是**流自己的序号**
 * （不是 recorder 的 `seq` —— 一个任务可能跨多个 run 段，每段 `seq` 从 1 重来，
 * 见 `task-events.ts` 的设计约束 1）。
 */
export type TaskStreamFrame =
  /** 一条记账事件（帧名 `trace.event`，SSE `id:` = index） */
  | { type: 'trace'; index: number; event: TraceRecordEvent }
  /** 缓冲超限、最前面的一段没了（帧名 `stream.truncated`，只发一次、在重放之前） */
  | { type: 'truncated'; droppedBefore: number }
  /** 任务到终态，流到此为止（帧名 `task.end`，随后服务端关闭连接） */
  | { type: 'end'; record: TaskRecord }
  /**
   * 本进程没有这条任务的实时流（帧名 `stream.unavailable`）——跨进程宿主（队列消费者在
   * 别的进程里跑）或任务早于本进程启动。**不假装实时**：发完它就收口
   * （终态补一帧 `end`，非终态补一帧 `closed` —— 见下）。
   */
  | { type: 'unavailable'; reason: 'not-in-this-process' }
  /**
   * **流级**收尾（帧名 `stream.closed`，随后服务端关闭连接）：流到此处为止，但任务
   * **不是**终态（还在别的进程里跑）。与 `end` 严格区分 —— `end` 的语义是「任务终态」，
   * 非终态发 `end` 是伪造终态；没有这一帧，跨进程 + 非终态的 SSE 只剩心跳永远挂着，
   * 按「读到流结束」写法的客户端永远等不到。客户端收到它应转去轮询 `GET /tasks/:id`。
   */
  | { type: 'closed'; reason: 'not-in-this-process' };

/**
 * `streamTask` 的失败：带 HTTP 语义的状态码（404 = 任务不存在），HTTP 宿主据此回对应响应。
 * 形状与 `TaskApproveError` 同款（module 级 export，不进公共导出面）。
 */
export class TaskStreamError extends Error {
  readonly status: 404;
  constructor(message: string) {
    super(message);
    this.name = 'TaskStreamError';
    this.status = 404;
  }
}

/**
 * 任务是否**已到终态**（流可以收口了）。
 *
 * ⚠️ 与 `resume-policy.ts` 那个「可续跑」的判定**刻意不同**：那里 `suspended`
 * 算「不可续跑」（重启扫描不该去动它），这里是**非终态** —— 挂起在等人，人批了它会接着跑，
 * 流必须**继续开着**（关掉的话「等审批结果的前端」正好在最需要的时候断线）。
 */
function isTerminalTask(rec: TaskRecord): boolean {
  // 判定外移到 core/run.ts 的 `isTerminalStatus`（单一真源，2026-09-28 外部深评 S1）：
  // 这里原本是负向枚举（`status !== 'queued' && …`），而 Redis store 那边压根没判 ——
  // 同一事实两份读数，写法还不一样。那两处现在都调同一个函数。
  return isTerminalStatus(rec.status);
}

/**
 * `TaskApproveError`（`approve` 的失败，带 HTTP 语义状态码）已随审批监督簇迁到
 * `approval-supervisor.ts`，本文件顶部 re-export 保持导出面不变（定义与理由见那里）。
 */

/**
 * `cancel` 的失败：带 HTTP 语义的状态码（404 = 任务不存在，409 = 已终态 / 在飞 run 不在本进程）。
 * 形状与 `TaskApproveError` 同款（module 级 export，不进公共导出面）。
 */
export class TaskCancelError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'TaskCancelError';
    this.status = status;
  }
}

/**
 * `submit` 在**排队段已满**时的失败（`AsyncRunnerOptions.maxQueued`，2026-09-28 外部深评 T5）。
 *
 * 为什么单独一个类型、而不是复用 `TaskInputError`：两者在 HTTP 上的**含义不同** ——
 * 入参不合法是 **400**（调用方改请求就能过），排队满**不是调用方的错**，是 **503
 * + `Retry-After`**（同一次请求稍后重发就该过）。宿主若把它们混成一支，运维看到的就是
 * 「你的请求有问题」，而实际是「服务该扩容 / 该退避」—— 与 `maxConcurrentRuns` 的 503
 * 那支刻意分开的理由同款。
 *
 * `status` 是自陈字段（本仓 `TaskApproveError` 起的惯例）：宿主按它选状态码，不靠
 * `instanceof` 猜；本类目前只有 503 一种。
 *
 * module 级 export —— 不进公共导出面（与 TaskApproveError / TaskCancelError / TaskEventError 同档）。
 */
export class TaskQueueFullError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'TaskQueueFullError';
  }
}

/**
 * 取消的**宽限**：取消请求发出后，留给那次 run 自己收尾的时间。
 *
 * 尊重 signal 的 client 是毫秒级收尾（SDK 一收到 abort 就 reject，run 随即以 `stopReason:
 * 'aborted'` 收尾 —— 那条路连 `result` 与 trace 都保得住，本常量对它只是余量：一次网络往返 +
 * trace 落盘）。不认 signal 的宿主**永远**不会自己收尾 —— 等多久都是白等，所以到点就撤回意图、
 * 如实抛 409（见 `#awaitCancelled`），不假装取消成功。
 */
const CANCEL_GRACE_MS = 2_000;

export interface AsyncRunnerOptions {
  client?: ModelClient;
  store?: TaskStore;
  /**
   * 会话历史 store（C4）：配上之后，任务 `options.sessionId`（可序列化的会话引用）
   * 在执行前被换成 `RunAppOptions.session`（store 实例 + id）注入 run ——
   * 这是异步宿主上会话的**正式通道**（store 实例不可序列化，所以任务里只带 id、
   * 实例由 runner 持有；同步宿主没有这一步，会话走程序内 `RunAppOptions.session`）。
   *
   * 不配它而任务带了 `sessionId` ⇒ submit 当场抛 `TaskInputError`（响亮失败，
   * 不静默降级成「没有会话」）。
   */
  sessionStore?: RunSessionStore;
  /** 同时执行的任务上限；缺省不限。超出部分排队等槽位（状态保持 queued） */
  concurrency?: number;
  /**
   * **在等槽位的任务数**上限（`concurrency` 之外的那一段）；缺省 0 = 不限。
   *
   * 为什么需要它（2026-09-28 外部深评 T5）：`concurrency` 只约束**同时在跑**几个，
   * 而「跑不上、排在后面」的那一段**没有任何上限** —— `submit` 永远收单（POST /tasks
   * 永远 202），排队段因此随调用方灌入无界增长：每条排队任务都是一条 `TaskRecord` +
   * 一棵 `#execute` 的悬挂 promise + 一个 `#slots` 等待者，**全部在内存里**。
   * `concurrency: 1` 挡不住它 —— 那只是让排队段更长。
   *
   * 语义：**「在等槽位」= 已受理（落库 + `#execute` 同步前段已计数）、尚未拿到槽位**。
   * 拿到槽位即离开本计数（此后归 `concurrency` 管），所以两个旋钮管的是两段、可加：
   * 进程内最多 `concurrency + maxQueued` 条任务同时在推进。
   *
   * ⚠️ 两个刻意的口径：
   * - **只在 `submit`（新活入口）判**：恢复路径（approve / 到期唤醒 / 崩溃重投）**不受闸**
   *   —— 它们推进的是**已受理**的任务，拦下来等于把任务永久搁死在 store 里。
   * - **超限是 503 不是 400**：这不是调用方把参数写错了，是「现在排不下、稍后再来」。
   *   HTTP 宿主回 503 + `Retry-After`（与 `maxConcurrentRuns` 同款），错误类型
   *   `TaskQueueFullError` 让宿主能把它与「入参不合法」分开。
   */
  maxQueued?: number;
  /** 任务完成回调（进程内）；见 TaskSink */
  taskSinks?: TaskSink[];
  /**
   * **落库失败回调**（观测 / 对账用）。缺省不给 = 静默，与加本选项之前**逐字一致**。
   *
   * 为什么需要它：`docs/usage-guide.md` §7 那条边界（「终态落库失败无告警」）写着
   * 「store 抖动时任务可能永远停在 `running`，重启后 `resumePending` 会重跑一个**实际已成功**
   * （副作用已发生）的任务 —— **耐久 store 的故障告警是宿主的事**」。但在本选项出现之前，
   * 框架把这个失败**吞掉且不留任何出口**（`#safeSave`）—— 宿主**做不到**它被要求做的事：
   * 它拿不到失败、也不该靠轮询 store 去猜。
   *
   * 本仓同因、同形、只差一个名字的先例：`createOtlpExporter({ onExportError })`
   * （「`TraceSink` 的失败缺省是静默的，这类消息得有人能收到」）。
   *
   * ⚠️ 它**不能补救**落库失败（写不进去就是写不进去）。它的职责是两件：
   * ① 让你能对账（哪条记录、哪一次写出、什么错）；② 让「记录无声丢失」不再是默认行为。
   * 回调抛错被吞（观测是辅助动作，不影响 run；与 `onUnpricedModel` / `onExportError` 同口径）。
   */
  onPersistError?: (info: PersistFailureInfo) => void;
  /**
   * 单任务执行超时（毫秒）；缺省 0 = 不限。必须为非负**有限**数（NaN/Infinity 会被
   * setTimeout 钳到 1ms，等同每个任务立即超时 —— 构造期直接报配置错误）。
   *
   * **超时即中止**：到点会 abort 本次 run 的 signal —— 对尊重 signal 的模型客户端
   * （框架自带的 Anthropic / OpenAI 适配器都转发 signal）是**真中止**，token 不再继续烧；
   * 不尊重 signal 的自定义 client 则仍等价于「放弃等待」（run 在后台跑完、产物丢弃）。
   * 槽位无论如何立即回收；被放弃且仍在跑的任务会让实际并发短暂高于 concurrency。
   */
  runTimeoutMs?: number;
  /**
   * 审批等待超时（毫秒，HITL）；缺省 0 = 不限（一直等人）。
   *
   * **惰性判定，不起定时器**：`approve` / `poll` / `resumePending` 读到一个
   * `suspended` 任务时，若它挂起已超过该值，框架自动把**全部待决项**写成
   * 「denied，reason: '审批超时'」并恢复执行（模型收到拒绝理由，可自行换路）。
   * 也就是说超时只在「有人读它」时生效 —— 没人读的任务不会自己动（进程里不养定时器，
   * 崩溃/重启也不依赖任何在飞回调）。
   */
  approvalTimeoutMs?: number;
  /**
   * 每任务**记账事件缓冲**的条数上限（`GET /tasks/:id/stream` 用）；缺省 500。
   *
   * 必须是**正**安全整数：NaN / Infinity / 负数 / 小数 / 0 一律在构造期抛 TypeError ——
   * NaN 会让「超出条数上限」的判定恒假（内存闸静默失效）；0 没有「缓冲几条」的读法
   * （既不是「关掉流」也不是「不限」），0 语义归类见 `core/limits.ts`。
   *
   * 内存量级：单条事件正文受 `maxEventChars` 约束（入参/成功出参缺省 2000 字符），
   * 故 500 条 ≈ 1 MB/任务；终态流的保留条数是代码里的常量（最近 16 条），
   * **非终态**流的缓冲配额见 `streamNonTerminalBuffers`（缺省 32 条流）。
   * 超出条数上限时丢**最旧**的，并向订阅方发一帧 `stream.truncated`（**不静默**）。
   */
  streamBufferEvents?: number;
  /**
   * **非终态**流的**缓冲**配额（条数，不是事件数）：本进程最多为多少条**还没跑完**的流
   * 保留「可回放的事件缓冲」；缺省 32。超出即从最旧、**无订阅者**的流开始回收缓冲。
   *
   * 为什么需要它：`streamBufferEvents` 只钉住**每任务**的量，而「挂着的任务」（等审批 /
   * 等事件 / 等定时器）永远走不到终态 ⇒ 表项与缓冲只增不减（2026-09-28 外部深评 T4）。
   * 回收的是**回放历史**，不是流本身：表项与序号都留着，连上来的读者先收到一帧
   * `stream.truncated`（明示缺口）再转实时推送 —— 所以「回放看不全」是**看得见**的降级。
   *
   * `0` = 不为**没人读的**非终态流留回放缓冲（只有实时转发）。必须是非负安全整数，坏值构造期抛 TypeError。
   * ⚠️ **有订阅者的流不受配额约束**（不抽走正在读的东西）；终态流的**表项**保留数仍是
   * 内部常量（最近 16 条）—— 它本来就是有界的，没走旋钮。
   */
  streamNonTerminalBuffers?: number;
}

/** 应用最小调用面（agent 装配无关，避免 run 层向上依赖 toolkit） */
export interface AppCallable {
  readonly name: string;
  run(
    messages: MessageParam[],
    opts?: RunInvocationOptions,
  ): Promise<{ run: { runId: string; status: RunStatus }; result: AgentRunResult }>;
}

export class AsyncRunner {
  readonly store: TaskStore;
  /**
   * 本进程标识：写进认领的 `TaskRecord.ownerId`，供 resumePending 区分他我。
   *
   * 形状 `p<pid>@<host>-<8位十六进制>`（真源见 `owner-id.ts`）。为什么带主机名与 pid：
   * 光有时间判不出「主人还在不在」（`staleAfterMs` 是**新鲜度**不是**租约**），
   * 而「同主机 + pid 还在」是能直接问操作系统的**直接证据**（见 `owner-liveness.ts`）。
   */
  readonly ownerId: string;
  /**
   * 本机主机名（构造期取一次）。**同一个值**既写进 `ownerId`、也用于「同主机吗」的判定 ——
   * 两处各自取一次就可能不一致（hostname 在进程存活期间是可能被改的），判定会因此静默失效。
   */
  readonly #host = hostname();
  private readonly client: ModelClient | undefined;
  private readonly sessionStore: AsyncRunnerOptions['sessionStore'];
  private readonly concurrency: number;
  private readonly maxQueued: number;
  /**
   * 当前**在等槽位**的任务 id 集合（已受理、尚未拿到槽位）—— `maxQueued` 的判据，
   * 也是 `queued` 读数。
   *
   * 为什么是**集合**而不是计数器：入口只有一处（`#execute` 的**同步前段**、第一个 await
   * 之前 `add`），出口有两处（`#executeInner` 里**拿到槽位**那一刻 `delete`，`#execute`
   * 的外层 finally 再 `delete` 一次兜底 —— 覆盖「幂等去重早退 / 中途抛错」）。`add` /
   * `delete` 的语义**天然幂等**，所以多重释放无害、漏放不可能（兜底那道闸在 finally 里）。
   * 用整数计数器要做到同一件事，得自己再造一个「只减一次」的闸 —— 那正是最容易写漏的东西
   * （第一版就是这么写的，而释放点根本不在同一个函数作用域里，闭包跨不过去）。
   *
   * ⚠️ 同一 taskId 的两次 `#execute` 并发不在设计内（在飞闸挡着）；万一发生，先退出那一趟
   * 的 finally 会把仍在等槽位的那趟从集合里删掉 ⇒ 读数**偏小**（闸更宽松）。偏小是安全的
   * 方向：它不会把服务永久锁在 503 上，而「多收一条」只是回到加本旋钮之前的行为。
   *
   * ⚠️ **它本身不是排队深度**：队列长度要减掉「马上就能拿到空槽位的那些」，见 `#queueDepth`
   * —— 一个 `submit` 循环里同步灌进来的每一条都会先落进本集合，而此时池子还空着，
   * 直接拿 `size` 当深度会把「立刻就能跑的」也算成排队的（`concurrency: 1` + `maxQueued: 1`
   * 下连灌两条就会把第 2 条误拒 —— 第一版就是这么写的，被用例当场抓出来）。
   */
  readonly #waiting = new Set<string>();

  /**
   * **真正在排队的深度**（`maxQueued` 的判据，也是 `queued` 读数）。
   *
   * 公式：`max(0, 已受理未持槽的任务数 + adding − 当前空槽位数)`。
   *
   * 为什么不能只用等待队列长度、也不能只用 `#waiting.size`：
   * - `#waiting` 里混了「刚 submit、还没走到 acquire」的任务 —— 池子空着时它们**不会排队**，
   *   只是还没轮到执行那一刻。`adding` 就是给「正在提交的这一条」留的位置。
   * - 空槽位数 = `concurrency − #slots.inUse`。于是「同步灌 N 条」时：先到的 N 条一边进
   *   `#waiting`、一边还算着同样的空槽位，两个量相抵 ⇒ 判据正好落在
   *   「最多 `concurrency + maxQueued` 条在推进」这条对外口径上（见 `AsyncRunnerOptions.maxQueued`）。
   * - `concurrency` 为 `Infinity`（缺省）时空槽位数是 `Infinity` ⇒ 深度恒为 0 ⇒ 闸天然不起作用，
   *   与「缺省行为与加本旋钮之前逐字一致」对齐。
   */
  #queueDepth(adding = 0): number {
    const freeSlots = Math.max(0, this.concurrency - this.#slots.inUse);
    return Math.max(0, this.#waiting.size + adding - freeSlots);
  }
  private readonly runTimeoutMs: number;
  private readonly approvalTimeoutMs: number;

  /**
   * 审批监督簇（挂起登记 + 在飞闸 + `approve` + 超时恢复）—— 实现见 approval-supervisor.ts。
   * 依赖（store / ownerId / approvalTimeoutMs / dispatch 回调）在构造函数末尾注入。
   */
  readonly #approvals: ApprovalSupervisor;
  /**
   * 事件投递簇（`signalTask` + 串行闸 + 两个事件容量常量）—— 实现见 signal-supervisor.ts。
   * 与 `#approvals` 同族（都是「挂起任务的外部唤醒入口」），故紧邻声明。
   */
  readonly #signals: SignalSupervisor;
  /**
   * 恢复扫描簇（`resumePending` 的四步扫描 + 到期唤醒）—— 实现见 resume-scanner.ts。
   * 依赖 `#approvals`（读数重建 / 催超时）与 drain 读数（唤醒闸），构造时排在它之后。
   */
  readonly #scanner: ResumeScanner;
  /** 并发槽位池（见 slot-pool.ts）：本类不再自管 running/waitQueue */
  readonly #slots: SlotPool;
  /** 已受理但未达终态的任务数（queued + running）—— /healthz 与 drain 共用 */
  private active = 0;
  /** 停机等待闸（见 drain-gate.ts）：停机态标志与等待者一并外移 */
  readonly #drain = new DrainGate();
  /** 任务终态等待表（见 task-waiters.ts）：仅覆盖本进程写终态，他进程写靠兜底轮询 */
  readonly #taskWaiters = new TaskWaiters();
  /**
   * 本进程**已受理并正在推进**的任务（= `#execute` 的存活区间）。
   *
   * 只为 `cancel` 的文案存在：命中「`status === 'running'` 但在飞句柄表里没有」时，
   * 区分「**本进程排队未起跑**」与「**真不在本进程**」——
   * - 四条恢复路径（approve / 到期唤醒 / 事件投递 / 崩溃重投）都**先**把状态置 `running`
   *   再 `#dispatch`，而 `#runAborts` 要到 `#slots.acquire()` 之后才登记 ⇒ 中间整个窗口
   *   里 `status` 已是 running、句柄却还没有。原文案一律说「不在本进程」，
   *   对同进程排队的那条是**说反话**（2026-09-28 外部复核抓到）。
   * - 本集合与 `#runAborts` 的**差集**恰好就是「已受理、未起跑」（见 `#cancel`）。
   *
   * ⚠️ **纯诊断**：不参与任何正确性判定，也不影响 409 闸本身（那道闸不放开 ——
   * 放开会让等槽位那趟 `#execute` 的 finally 双发 `onFinished`，正是 spec §10 的变异 M23）。
   */
  readonly #executions = new Set<string>();
  /**
   * 每任务的记账事件流（见 task-events.ts）：`GET /tasks/:id/stream` 的重放 + 实时推送。
   * 纯记账件，独立于 store / 槽位 —— 所以在 855 行的类里单独抽一个文件。
   */
  readonly #streams: TaskEventStreams;
  /**
   * **同进程内的幂等键认领表**（idempotencyKey → 在飞记录）。
   *
   * 为什么必须有它（2026-09-21 外部复核实测）：`submit` 是同步门面，**无法 await** 异步 store 的
   * `byIdempotency`；而 `#executeInner` 只采纳已 `succeeded` 的既有记录。于是「同时提交两个
   * 相同 idempotencyKey」在异步 store 下**两次都执行**（实测 appRunCalls=2）——
   * 文档承诺的「同键未失败直接返回既有记录」实际只对同步 store 成立。
   *
   * 这里把那条承诺补回到「**同进程内**并发提交」这一档：认领在 `#execute` 的同步前段完成，
   * 所以两次连续的 `submit` 之间没有窗口。跨进程仍是 at-least-once（诚实边界，见 usage-guide §7）。
   */
  readonly #claims = new Map<string, TaskRecord>();
  private readonly taskSinks: TaskSink[];
  private readonly onPersistError: AsyncRunnerOptions['onPersistError'];
  /**
   * HITL 挂起时快照的「本轮用户输入」（taskId → messages）—— 恢复段成功后做会话回写用
   * （恢复段不把 session 交给 run 层，见 #executeInner 的 callOpts 注释）。
   * 只在首个挂起段快照；任务达终态时清掉（#execute 的出口）。
   *
   * **刻意只放内存**：进程崩在「挂起 → 重启 → approve」之间会丢这一次会话回写 ——
   * 会话少一轮，但绝写不进坏历史（孤立 tool_use / 历史翻倍），审批决定本身已落库、
   * 不受影响。快照若落库就要动 TaskRecord 的序列化 schema（sqlite / redis），
   * 而它相对审批决定只是锦上添花 —— 这个取舍是有意的。
   */
  private readonly sessionInputs = new Map<string, MessageParam[]>();

  constructor(
    private readonly app: AppCallable,
    opts: AsyncRunnerOptions = {},
  ) {
    this.store = opts.store ?? new InMemoryTaskStore();
    this.client = opts.client;
    this.sessionStore = opts.sessionStore;
    this.taskSinks = opts.taskSinks ?? [];
    this.onPersistError = opts.onPersistError;
    this.#streams = new TaskEventStreams({
      ...(opts.streamBufferEvents === undefined ? {} : { maxEvents: opts.streamBufferEvents }),
      ...(opts.streamNonTerminalBuffers === undefined
        ? {}
        : { nonTerminalBuffers: opts.streamNonTerminalBuffers }),
    });
    this.concurrency = opts.concurrency ?? Number.POSITIVE_INFINITY;
    if (!(this.concurrency > 0)) {
      throw new Error(
        `concurrency 必须为正数（${zeroClauseOf('AsyncRunner.concurrency')}），收到 ${opts.concurrency}`,
      );
    }
    // 放在校验之后：字段初始化式在构造函数体之前求值，那时 concurrency 还是 undefined
    this.#slots = new SlotPool(this.concurrency);
    this.maxQueued = opts.maxQueued ?? 0;
    if (!Number.isInteger(this.maxQueued) || this.maxQueued < 0) {
      // 与 concurrency 同族：`0` 本身**合法**（= 不限），坏的是「负数 / 小数 / NaN / Infinity」。
      // 负数的读法无解（「最多排 -1 个」是什么），小数会让比较变成「有时收有时不收」——
      // 都不是「配置宽一点」而是「配置说了另一件事」，所以构造期响亮失败。
      throw new Error(
        `maxQueued 必须为 ≥ 0 的整数（${zeroClauseOf('AsyncRunner.maxQueued')}），收到 ${opts.maxQueued}`,
      );
    }
    this.runTimeoutMs = opts.runTimeoutMs ?? 0;
    if (!Number.isFinite(this.runTimeoutMs) || this.runTimeoutMs < 0) {
      // NaN/Infinity 都不能放给 setTimeout：两者都会被钳到 1ms，每个任务立即「超时」失败
      // （且 NaN 会绕过 `< 0` 检查静默通过）。要「不限」请传 0（缺省）。
      // 文案里的「0 = 不限」取自 core/limits.ts 的表 —— 口径与实现同一处，不可能各说各话。
      throw new Error(
        `runTimeoutMs 必须为 ≥ 0 的有限数（${zeroClauseOf('AsyncRunner.runTimeoutMs')}），收到 ${opts.runTimeoutMs}`,
      );
    }
    // 上界（2026-09-28）：「≥0 且有限」还不够 —— 超过 2^31-1ms（约 24.86 天）的延迟
    // Node **不会遵守**（stderr 一行 TimeoutOverflowWarning + 钳到 1ms），于是「配 30 天
    // 超时」变成「每个任务立即超时失败」，静默且与配置相反。上限单源与五处站点共用：
    // 这一句就是 scheduler.ts 注释里承诺过的「async.ts 同款防线」（此前那句话与实现不符）。
    assertTimerDelay(this.runTimeoutMs, 'AsyncRunner 的 runTimeoutMs');
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0;
    if (!Number.isFinite(this.approvalTimeoutMs) || this.approvalTimeoutMs < 0) {
      // 同 runTimeoutMs：非有限数会让「已挂起多久」的比较静默失效或立即超时
      throw new Error(
        `approvalTimeoutMs 必须为 ≥ 0 的有限数（${zeroClauseOf('AsyncRunner.approvalTimeoutMs')}），收到 ${opts.approvalTimeoutMs}`,
      );
    }
    this.ownerId = formatOwnerId(process.pid, this.#host, randomUUID().slice(0, 8));
    // 审批监督簇在 ownerId 就位后构造（它要用 store 与 ownerId）。`dispatch` 用**回调**
    // 注入而不是 import：派发入口 `#dispatch` 仍归本类（停机闸 + 唯一派发点 + 一次性告警），
    // 依赖保持单向（审批 → 派发），也避免两个模块互相 import。
    this.#approvals = new ApprovalSupervisor({
      store: this.store,
      ownerId: this.ownerId,
      approvalTimeoutMs: this.approvalTimeoutMs,
      dispatch: (rec) => this.#dispatch(rec),
      cancelInflight: (taskId) => this.#cancelInflight.get(taskId),
    });
    // 事件投递与恢复扫描同样在 ownerId 就位后构造。两处**回调注入**的理由与 `#approvals` 一致：
    // `#dispatch`（停机闸 + 唯一派发点 + 一次性告警）与 drain 读数都归本类，两个监督件只**消费**它们
    // ⇒ 依赖保持单向（监督件 → 派发），也避免三个模块互相 import。
    this.#signals = new SignalSupervisor({
      store: this.store,
      ownerId: this.ownerId,
      approvals: this.#approvals,
      dispatch: (rec) => this.#dispatch(rec),
      cancelInflight: (taskId) => this.#cancelInflight.get(taskId),
    });
    this.#scanner = new ResumeScanner({
      store: this.store,
      ownerId: this.ownerId,
      host: this.#host,
      approvals: this.#approvals,
      dispatch: (rec) => this.#dispatch(rec),
      isDraining: () => this.#drain.isDraining,
      cancelInflight: (taskId) => this.#cancelInflight.get(taskId),
    });
  }

  /**
   * 提交一次异步任务。入参可为 string / messages / {prompt|text|messages}。
   * 幂等键存在且上一任务未失败 → 直接返回既有记录（去重）；失败的同键可产生新任务。
   * 同步门面：同步 store 下立即去重并返回快照；异步 store 下 save 在后台完成、
   * 去重推迟到执行前（见 #execute），返回新建任务的提交时刻快照。
   */
  submit(
    input: unknown,
    opts: { idempotencyKey?: string; source?: string; options?: RunInvocationOptions } = {},
  ): TaskRecord {
    // 停机中不接单（drain 之后）；宿主据此回 503。放在最前：连入参规整都省了。
    if (this.#drain.isDraining) {
      throw new Error('runner 正在优雅停机，不再接受新任务');
    }
    const messages = normalizeMessages(input);
    if (opts.options?.sessionId !== undefined && this.sessionStore === undefined) {
      // 响亮失败：调用方明着要会话语义，静默降级成「没有会话」是最难查的那种错。
      // 注意 import 的是 spec.js 的 TaskInputError —— HTTP 宿主据此回 400（调用方的错）。
      throw new TaskInputError(
        '任务带了 options.sessionId，但本 runner 未配 sessionStore —— 会话历史接不上；' +
          '给 AsyncRunner 传 sessionStore，或去掉 sessionId',
      );
    }
    if (opts.idempotencyKey) {
      // 同步快路径：**同进程内已有同键在飞** → 直接返回它。异步 store 下 byIdempotency 是
      // Promise，同步门面等不了；而 #executeInner 只采纳已 succeeded 的记录 ⇒ 不认领这条，
      // 「同时提交两个同键任务」会两次都执行（见 #claims 的注释）。
      const inFlight = this.#claims.get(opts.idempotencyKey);
      if (inFlight) return cloneTaskRecord(inFlight);
      const existing = this.store.byIdempotency(opts.idempotencyKey);
      if (isThenable(existing)) {
        // 异步 store 返回 Promise —— 同步门面无法 await，去重交给 #execute。
        // 但**必须订阅它**：byIdempotency 的 reject（Redis 抖动等）若无人处理就是
        // unhandledRejection（Node ≥15 默认终止宿主进程）。这里只做「查不到既有记录」
        // 处理，拒绝即视为无记录，交 #execute 的去重兜底。
        existing.catch(() => undefined);
      } else if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
        // at-least-once 去重：不重复执行。`failed` 被刻意排除（失败后同键重提要真跑）；
        // `cancelled` 同理 —— 排队被取消的任务**一次都没跑过**，同键再提交若直接认回
        // 那条 cancelled 记录，这次提交就被静默吞掉（且与 #executeInner 只采纳
        // `succeeded` 的异步路径不一致：同一件事两种 store 两种结局）。
        return { ...existing };
      }
    }
    // 排队段闸（2026-09-28 外部深评 T5）：放在**去重之后** —— 幂等键命中既有记录时
    // 本次提交既不产生新活也不排队，不该吃 503（否则「重试同一个键」会变成看运气）。
    // 读 `#waiting` 是**同步准确**的：别的 submit 在它自己的 `#execute` 同步前段就入过集合
    // （`#dispatch` 是 submit 的最后一行，`void this.#execute(rec)` 的 body 到第一个 await
    // 之前全同步）⇒ 「一个循环里同步灌 N 条」不可能绕过这道闸，不靠人记得 await。
    // 判据是**真正在排队的深度**（`#queueDepth`），不是「已受理未持槽」的集合大小：
    // 后者把「池子还空着、马上就能跑」的那些也算成排队的，会把第 2 条合法提交误拒。
    // `(1)` = 把正在提交的这一条算进去 —— 闸要拦的是「这条交了以后会溢出」。
    const queueDepth = this.#queueDepth(1);
    if (this.maxQueued > 0 && queueDepth > this.maxQueued) {
      throw new TaskQueueFullError(
        `排队已满：这条提交会让 ${queueDepth} 条任务排在槽位后` +
          `（上限 maxQueued=${this.maxQueued}，concurrency=${this.concurrency}）` +
          '—— 请退避重试，或调大 concurrency / maxQueued',
      );
    }
    const rec: TaskRecord = {
      taskId: nextTaskId(),
      status: 'queued',
      idempotencyKey: opts.idempotencyKey,
      spec: { messages, options: opts.options, source: opts.source ?? 'async' },
      createdAt: Date.now(),
      ownerId: this.ownerId,
    };
    const saved = this.store.save(rec);
    if (isThenable(saved)) {
      // 异步落库失败：尽力把任务标记为 failed 重存，避免静默吞错 / unhandled rejection。
      // 但只在任务**尚未被 #execute 推进**时改判：初始 save 的 reject 可能迟到，
      // 那时 run 已跑完并写了成功终态，无条件覆写会把成功翻成失败（落库终态与真实结果相反）。
      saved.catch((e) => {
        if (rec.status !== 'queued' || rec.finishedAt !== undefined) return;
        rec.status = 'failed';
        rec.error = classifyError(e);
        rec.finishedAt = Date.now();
        void this.#safeSave(rec, 'initial');
      });
    }
    // 派发走唯一入口（闸在 #dispatch 里）—— ⚠️ 这里是**结构一致性**，不是行为依赖：
    // 本方法开头那道 `isDraining` 检查（拒绝语义：对调用方的承诺是抛错 / 503，不是静默排期）
    // 与这一行之间**没有 await** —— `submit` 是**全同步**的（异步 store 的 `save` 也只是挂个
    // `.catch`，不 await）⇒ JS 不可能在中间插入 drain 的置位 ⇒ `#dispatch` 那道闸在**本方法内
    // 永远不触发**。（2026-09-28 PR #164 复核 §3：此前的注释与提交信息把它说成「挡进闸与派发
    // 之间刚开始停机的窄窗口」，那是个不存在的窗口。）
    // 仍然走它：**「派发一律走唯一入口」这条纪律不该有例外** —— 少一个例外，就少一处将来
    // 新增恢复路径时会漏的枚举。
    this.#dispatch(rec);
    // 返回深拷贝（2026-10-13 ref-reject-static-methods 收口）：记录会被后台状态机原地推进，浅拷贝只隔顶层 ——
    // `spec.messages` 等嵌套对象此前与 runner 的活记录共享（HITL 挂起会换 spec.messages）。
    return cloneTaskRecord(rec);
  }

  /** 查任务当前记录（异步 store 下返回 Promise，调用方 await） */
  poll(taskId: string): MaybePromise<TaskRecord | undefined> {
    const rec = this.store.get(taskId);
    // 惰性挂起闸（HITL 超时 + 到期唤醒）：读到挂起记录时顺手判定，到点就恢复并重派
    if (isThenable(rec)) return rec.then((r) => this.#lazyGates(r));
    return this.#lazyGates(rec);
  }

  /**
   * 订阅某任务的**记账事件流**（`GET /tasks/:id/stream` 的引擎侧）。
   *
   * 三条语义（与 docs/plans/2026-09-21-incremental-trace-export-and-sampling.md §3 Phase A3 对齐）：
   * 1. **先重放、后实时**：`opts.from`（= SSE 的 `Last-Event-ID` / `?from=`）之后的事件先补发，
   *    再挂实时订阅 —— 「连上时已经跑了一半」的客户端因此也能拿到完整前缀。
   * 2. **终态收口**：任务已终态 ⇒ 补发完缓冲 + 一帧 `end`，**不留**一条永远不会再产出事件的流。
   *    挂起（`suspended`）**不是**终态：批了（或睡到点了）会接着跑，流必须开着（见 isTerminalTask）。
   * 3. **跨进程不假装**：本进程没有这条流时（别的进程在跑 / 任务早于本进程），发一帧
   *    `unavailable` 后**立即收口**：终态补 `end`，非终态补 `closed`（流级收尾，不是
   *    伪造终态）—— 非终态只发 `unavailable` 就返回的话，这条 SSE 只剩心跳永远挂着。
   *    事件**不落 store** 是有意的：实测事件数
   *    = 2 × 工具调用、正文 KB 级 ⇒ 每条工具调用要把 KB 级正文写库两次（写放大），
   *    而宿主本来就有自己的总线（`onTraceEvent` 就是给它的缝）。
   *
   * 返回退订函数（连接关掉时必须调，否则订阅者挂在表里）。任务不存在 ⇒ `TaskStreamError`（404）。
   */
  async streamTask(
    taskId: string,
    listener: (frame: TaskStreamFrame) => void,
    opts: { from?: number } = {},
  ): Promise<() => void> {
    const noop = (): void => {};
    if (this.#streams.has(taskId)) {
      const replayed = this.#streams.replay(taskId, opts.from);
      // 截断明示放在重放之前：下游先知道「前面缺了一段」，再读数据
      if (replayed.droppedBefore !== undefined) {
        listener({ type: 'truncated', droppedBefore: replayed.droppedBefore });
      }
      for (const item of replayed.events) {
        listener({ type: 'trace', index: item.index, event: item.event });
      }
      if (replayed.done) {
        const rec = await this.poll(taskId);
        if (rec) listener({ type: 'end', record: rec });
        return noop;
      }
      // 实时订阅：`onDone` 里补发 `end` 帧 —— 终态是流的一部分
      //（没有它，这条 SSE 会在任务跑完之后一直挂着，客户端以为它还在跑）
      return this.#streams.subscribe(
        taskId,
        (item: TaskStreamEvent) =>
          listener({ type: 'trace', index: item.index, event: item.event }),
        () => {
          // poll 可能是异步 store ⇒ 用 then 补发（此刻任务已终态、记录已落库）
          void Promise.resolve(this.poll(taskId)).then((rec) => {
            if (rec) listener({ type: 'end', record: rec });
          });
        },
      );
    }
    const rec = await this.poll(taskId);
    if (!rec) throw new TaskStreamError(`task 不存在: ${taskId}`);
    listener({ type: 'unavailable', reason: 'not-in-this-process' });
    // unavailable 之后**必须立即收口**：返回的 noop 意味着没有退订通道，不收口这条
    // 流就只剩心跳永远挂着（客户端按「读到流结束」写法永远等不到）。
    // 终态补 `end`；非终态不能伪造终态帧 —— 发流级收尾帧 `closed`（客户端转轮询）。
    if (isTerminalTask(rec)) {
      listener({ type: 'end', record: rec });
    } else {
      listener({ type: 'closed', reason: 'not-in-this-process' });
    }
    return noop;
  }

  byIdempotency(key: string): MaybePromise<TaskRecord | undefined> {
    return this.store.byIdempotency(key);
  }

  list(): MaybePromise<TaskRecord[]> {
    return this.store.list();
  }

  /**
   * cancel 的 per-task 在飞闸（2026-10-13 ref-run-root-close）—— cancel 与四条推进路径（approve /
   * 事件投递 / 到期唤醒 / 审批超时恢复）之间的**互斥**靠它合上：
   * - cancel 进入前：先等该任务的在飞推进收口、**重读**记录再判（凭进闸前的旧快照落
   *   cancelled，会被对方随后的 running 落库覆盖回去 —— 任务取消后照常执行）；
   * - 推进路径进入前：同步看一眼本闸（approve / signalTask 等它收口后重试；
   *   到期唤醒 / 审批超时是**惰性**路径，跳过本轮、下一轮再判）。
   * 两侧的「检查对方闸 + 登记自己闸」都在**同一个同步段**里 ⇒ 先登记者赢，没有缝隙。
   * 同步 store 的 cancel 临界段（get → 落库）本身原子，不走本闸。
   */
  readonly #cancelInflight = new Map<string, Promise<TaskRecord>>();

  /**
   * 取消一个任务（durable 配套 5 的另一半；设计稿 `docs/plans/2026-09-28-cancel-api.md`）。
   *
   * 三种「在服」状态各自的语义 —— 都落在这一处，不分散：
   * - **running**：中止在飞 signal ⇒ 引擎以 `stopReason: 'aborted'` 收尾（尊重 signal 的
   *   client 是**真中断**，token 不再烧；不尊重者等价「放弃等待」—— 与 `runTimeoutMs`
   *   同一份契约）。等它真落库再返回：不等的话调用方拿到的是 `status` 仍为 running 的快照，
   *   「取消了但状态还在跑」比不返回更误导。
   * - **queued**（还没起跑）：落终态；`#executeInner` 拿到槽位后会**重读**再判，
   *   所以被取消的排队任务**绝不起跑**（这条是本次实现顺带补上的洞）。记账由本方法
   *   自己做；那一趟还活着的 `#execute`（在等槽位）靠 `#cancelSettled` 在 finally 里
   *   跳过它那一份（否则 onFinished 两次）。
   * - **suspended**（两种原因都算）：落终态 —— 两条唤醒闸都 gate 在 `status === 'suspended'`
   *   上，「不唤醒」因此是翻转状态的**推论**，不需要第二处标志。它没有活着的 `#execute`
   *   （挂起时那趟就走完了），所以记账（sinks / 事件流 / 认领释放 / 等待者 / 会话清理）
   *   由本方法自己做 —— 也因此它**不进** `#cancelSettled`（没有消费者，加了就是泄漏）。
   *
   * 状态按**意图**落，不按机制落：超时的收尾语义**不变**（仍是 `failed` + `error.type` 为
   * `'timeout'`），取消带 `error = abortedError()`（取消不是失败，但原因要可查）。
   *
   * 不做静默 no-op：已终态 ⇒ `TaskCancelError(409)`（状态不对要说出来），不存在 ⇒ 404。
   * 边界（如实写在这里）：`running` 的 run **不在本进程**（多进程部署 / 上一世留下的 running）
   * 时抛 409 —— 本进程没有句柄可中断，改状态假装取消只会在那条 run 跑完时被覆盖回去。
   *
   * ⚠️ 同一个 409 判据下还有**第二种**情形（2026-09-28 外部复核）：任务已在本进程受理、
   * 但还没走到 `#runAborts` 登记（在等并发槽位，或恢复路径刚写完 `running` 尚未派发完）。
   * 它**不是**「不在本进程」—— 原文案一律那么说，对这一类是说反话。两种情形分开措辞
   * （见 `#cancel` 的判据），但**闸不放开**：放开会让等槽位那趟 `#execute` 的 finally
   * 双发 `onFinished`（spec §10 的变异 M23）。
   *
   * 与推进路径的互斥（2026-10-13 ref-run-root-close）：见 `#cancelInflight` 的注释。并发 cancel 同任务
   * 串行：第二个等第一个收尾后重读再判（多半撞上「已终态 ⇒ 409」）。
   */
  cancel(taskId: string): MaybePromise<TaskRecord> {
    // 并发 cancel 串行（2026-10-13 ref-run-root-close）：两个并发 cancel 各自读-改-写会双记账（webhook 双发）
    const own = this.#cancelInflight.get(taskId);
    if (own)
      return own.then(
        () => this.cancel(taskId),
        () => this.cancel(taskId),
      );
    const advance = this.#advanceInflight(taskId);
    const found = this.store.get(taskId);
    if (advance !== undefined || isThenable(found)) {
      // 异步路径：先入闸（后续推进路径会看到它并等待/跳过），等在飞推进收口后**重读**再判
      const run = (async (): Promise<TaskRecord> => {
        if (advance !== undefined) await advance.catch(() => undefined);
        // 意图先立（等闸窗口里就要可见）：等槽位那趟 #executeInner 可能正好放行 ——
        // 意图在场它才不会起跑（见 #executeInner 的取消意图闸）
        this.#cancels.add(taskId);
        try {
          const rec = advance !== undefined ? await this.store.get(taskId) : await found;
          return await this.#cancel(rec, taskId);
        } catch (e) {
          this.#cancels.delete(taskId); // 没走到收尾（404/409）⇒ 意图撤回
          throw e;
        }
      })();
      const tracked = run.finally(() => {
        this.#cancelInflight.delete(taskId);
      });
      this.#cancelInflight.set(taskId, tracked);
      return tracked;
    }
    // 同步快路径：同步 store 且无任何推进在飞 ⇒ 临界段（get → 落库）原子，无需入闸
    return this.#cancel(found, taskId);
  }

  /** 三条推进路径（审批 / 事件投递 / 到期唤醒）在该任务上的在飞 Promise（无则 undefined） */
  #advanceInflight(taskId: string): Promise<unknown> | undefined {
    return (
      this.#approvals.inflightFor(taskId) ??
      this.#signals.inflightFor(taskId) ??
      this.#scanner.inflightWakeFor(taskId)
    );
  }

  #cancel(rec: TaskRecord | undefined, taskId: string): MaybePromise<TaskRecord> {
    if (!rec) throw new TaskCancelError(404, `task 不存在: ${taskId}`);
    if (isTerminalTask(rec)) {
      throw new TaskCancelError(409, `task ${taskId} 已终态（${rec.status}），不能取消`);
    }
    const inflight = this.#runAborts.get(taskId);
    if (rec.status === 'running' && !inflight) {
      // 「假装取消」是这里最坏的选项：那条 run 还活着，跑完会把状态覆盖回去
      // （调用方以为成功了，实际什么都没发生）。要说出来。
      // ⚠️ 但这两类情形**必须分开说**（2026-09-28 外部复核）：`#executions` 是
      // 「本进程已受理并正在推进」的集合，与 `#runAborts`（已登记在飞句柄）的差集
      // 就是「**已受理、未起跑**」。四条恢复路径先置 `running` 再 `#dispatch`、
      // 而句柄要到拿到槽位才登记 ⇒ 中间整个窗口都会落进这个差集 —— 对它说
      // 「不在本进程」是反话。调用方据此区分「稍后重试」与「得去找那个进程」。
      const acceptedHere = this.#executions.has(taskId);
      throw new TaskCancelError(
        409,
        acceptedHere
          ? `task ${taskId} 已在本进程受理，但尚未起跑（正在等并发槽位 / 走恢复前置）—— ` +
              `此刻取消无法与那条在等槽位的执行路径安全收口（会重复记账），暂不支持；` +
              `请待它起跑后再取消，或先降低并发压力`
          : `task ${taskId} 正在运行但不在本进程，本进程无法中断它（多进程部署见 spec §10 2026-09-28 ref-cancel-api）`,
      );
    }
    // 意图先记下：在飞那条路要靠它把 aborted 的收尾落成 cancelled（否则落成 failed）
    this.#cancels.add(taskId);
    if (inflight) {
      inflight.abort();
      return this.#awaitCancelled(taskId);
    }
    // queued / suspended：没有在飞 run（或它还没起跑），直接落终态 —— 记账由本方法做完，
    // 等槽位那趟 #execute 的 finally 靠 `#cancelSettled` 跳过它那一份（否则 onFinished 两次）。
    // ⚠️ cancel 自己只为 **queued** 登记（它有活着的、在等槽位的 #execute 来消费）；
    // suspended 的那趟 #execute 早在挂起时就走完了，cancel 直接登记会永远没人摘（泄漏）。
    // 第二个生产者是 `#executeInner` 的取消意图闸（2026-10-13 ref-run-root-close）：被并发恢复路径派发出
    // 来的那趟自己登记、自己的 finally 消费 —— 覆盖面带消费者一起补，仍不泄漏。
    // 既知边界（多进程）：他进程取消本进程**排队中**的任务时，本进程的 execute finally
    // 在自己的 `#cancelSettled` 里查不到 ⇒ onFinished 会双发（cancel 进程一次 + owner 一次）。
    const wasQueued = rec.status === 'queued';
    rec.status = 'cancelled';
    rec.error = abortedError();
    rec.finishedAt = Date.now();
    // 挂起痕迹清掉（`pendingApprovals` 与 `approvals` 的区别与既有终态口径一致：
    // 未决清单清掉、**已做出的决定**保留 —— 那是审计的一部分，随任务走）
    rec.pendingApprovals = undefined;
    rec.suspendedSince = undefined;
    rec.suspendedReason = undefined;
    rec.wakeAt = undefined;
    this.#approvals.unmarkSuspended(taskId);
    // ⚠️ 落库**当场发生**（2026-10-13 ref-run-root-close）：不走 `#safeSave` 的微任务延迟 —— cancel 的临界段
    // 必须原子。落库推迟一个微任务，「重读再判」那几条路（readClaimed / 恢复路径的进闸重读）
    // 就会在这个缝里读到取消前的旧状态、照常起跑/派发（「绝不起跑」承诺就是这样被破的）。
    // 失败口径与 #safeSave 相同：不遮罩（记账继续），但必须可观测（onPersistError）。
    let saved: MaybePromise<void>;
    try {
      saved = this.store.save(rec);
    } catch (error) {
      this.#reportPersistError(rec, error, 'outcome');
      saved = undefined;
    }
    if (wasQueued) this.#cancelSettled.add(taskId);
    const finish = (): TaskRecord => {
      // 取消意图的终点（2026-10-13 ref-run-root-close）：还有活着的 #execute 时留给它消费 —— 它靠这个意图
      // 判「绝不起跑」（等槽位那趟的 readClaimed 可能读到的是落库前的旧快照）；
      // 没有活着的（suspended 取消 / 它已先走完全程）由这里摘掉，不得滞留。
      if (!this.#executions.has(taskId)) this.#cancels.delete(taskId);
      this.#taskWaiters.notify(taskId);
      this.#streams.markDone(taskId);
      this.sessionInputs.delete(taskId);
      const key = rec.idempotencyKey;
      if (key !== undefined && this.#claims.get(key)?.taskId === taskId) this.#claims.delete(key);
      this.#notifyDrained();
      // 深拷贝在此**不需要**（与 submit 的 cloneTaskRecord 不同档）：rec 是 cancel 自己的
      // 入站快照（store 契约保证不是库内活引用），且任务已终态 —— 之后没有任何路径再推进它
      return { ...rec };
    };
    return isThenable(saved)
      ? Promise.resolve(saved)
          .catch((error) => this.#reportPersistError(rec, error, 'outcome'))
          .then(() => this.#notifySinks(rec))
          .then(finish)
      : this.#notifySinks(rec).then(finish);
  }

  /**
   * 等一条**已请求取消**的在飞任务真收尾（宽限见 `CANCEL_GRACE_MS`）。
   *
   * 终态判据用 `isTerminalTask`（单一真源）—— 手写两值会让 `cancelled` 在这里被漏掉，
   * 等待就变成「等到超时」，症状是「取消没生效」。
   *
   * ⚠️ 宽限内没收尾 ⇒ **撤回意图 + 抛 409**，不假装：敢说「取消了」而那条 run 还活着的话，
   * 它跑完会把状态覆盖回去（调用方以为成功、实际什么都没发生）。不认 `signal` 的宿主正是
   * 这一类；`runTimeoutMs` 那条老路对同样情形是「放弃等待」（记录落 failed、槽位释放、
   * 底层执行照样跑完）—— 两者**刻意不同**：超时是宿主自己定的预算，取消是人手按的动作，
   * 骗人的代价不一样。
   */
  async #awaitCancelled(taskId: string): Promise<TaskRecord> {
    const deadline = Date.now() + CANCEL_GRACE_MS;
    for (;;) {
      const rec = await this.store.get(taskId);
      if (rec && isTerminalTask(rec)) return rec;
      const left = deadline - Date.now();
      if (left <= 0) {
        // 撤回意图（不删 `#runAborts`：那条 run 还在本进程里活着，句柄留给它自己的 finally 摘）
        this.#cancels.delete(taskId);
        throw new TaskCancelError(
          409,
          `task ${taskId} 的中断没有在 ${CANCEL_GRACE_MS}ms 内生效（宿主不认 signal？）—— 取消未发生`,
        );
      }
      await this.#taskWaiters.wait(taskId, Math.min(250, left));
    }
  }

  /**
   * 审批一个处于 `suspended` 的任务（HITL）。
   *
   * 实现已外移到 `approval-supervisor.ts`（**逐字搬迁**，含四条语义与它们的理由：
   * 逐 tool_use_id 幂等 / 并发重入共享在飞那次 / 决定齐了先落库再派发 / 状态不对抛
   * `TaskApproveError`）。这里只留薄壳 —— `approve` 是 `AsyncRunner` 的公开 API，
   * 签名与返回类型不变。
   */
  async approve(
    taskId: string,
    decisions: ApprovalDecisions,
    opts: { decidedBy?: string } = {},
  ): Promise<TaskRecord> {
    return this.#approvals.approve(taskId, decisions, opts);
  }
  /**
   * 投递一个事件给**挂起**的任务（HITL 与 durable timer 两种挂起都适用）。
   *
   * 实现已外移到 `signal-supervisor.ts`（**逐字搬迁**，含完整语义清单与并发闸的理由：
   * 只对 `suspended` 生效 / 按 `eventId` 幂等 / 缓冲满了拒收并说出来 / 投完即续跑且
   * **先落库再派发** / 并发时**串行成链**而不是像 approve 那样共享在飞那次）。
   * 这里只留薄壳 —— `signalTask` 是 `AsyncRunner` 的公开 API，签名与返回类型不变。
   */
  signalTask(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    return this.#signals.signalTask(taskId, event);
  }

  /** 已受理但未达终态的任务数（queued + running）—— 健康检查与 drain 共用同一口径 */
  get inFlight(): number {
    return this.active;
  }

  /**
   * **本进程可见的挂起读数**（`/healthz` 的 `suspended` 段，配套 6）。
   *
   * 口径与三条维护纪律（挂起时登记 / 离开时除名 / 每次扫描按 store 重建）已随审批监督簇
   * 迁到 `approval-supervisor.ts` 的 `#suspended`（那张注释就写在那里）；这里只留对外 getter。
   */
  get suspendedSummary(): SuspendedSummary {
    return this.#approvals.summary;
  }

  /** 是否已进入优雅停机（drain 之后为 true）—— HTTP 宿主据此对新单回 503 */
  get isDraining(): boolean {
    return this.#drain.isDraining;
  }

  /**
   * 优雅停机：停止接单（此后 `submit` 抛错），等待已受理任务排空（或超时）。
   *
   * 返回是否排空干净：超时仍返回 `false`，**未完成的任务留在 store 里**，下次启动由
   * `resumePending` 续跑（所以 drain 不是「丢弃」，是「不再往前推」）。
   * - `timeoutMs` 缺省 0 = 一直等。
   * - 等待的是**所有已受理**的任务（queued 的也在内），不只是正在占槽位的那些。
   *
   * ⚠️ **这是一道单向闩：置位之后本进程不再推进任何任务，且没有复位路径**（`DrainGate` 只有
   * 置位，没有复位）。所以 `false`（排空超时）的含义不只是「还有在飞的」——它同时给宿主
   * 加了一条义务：**必须让进程退出**。理由（2026-09-28 PR #164 复核 §1，有探针实证）：
   * 停机窗口里被 `#dispatch` 拒掉的记录**已经落库**（`running`/`queued` + **本进程的 ownerId**），
   * 而本进程的 `resumePending` 会按 `own-process` 跳过它们（见 resume-policy.ts），`submit` 又
   * 已整体关闭 ⇒ 本进程内**没有任何自愈路径**。宿主若在 `false` 之后继续服务，这些记录会永远
   * 停在 `running`：`awaitTask` 不返回，`GET /tasks/:id/stream` 还会告诉客户端
   * `not-in-this-process`（说不对话：记录里的 ownerId 正是本进程）。只有**下一次进程启动**
   * 才会有人认领它们（ownerId 含 pid）。参考宿主（`examples/` 各示例的 `src/main.ts`）都是
   * `await drain(...)` 之后 `process.exit(...)`，与本条契约一致。
   */
  async drain(opts: { timeoutMs?: number } = {}): Promise<boolean> {
    // 实现已外移到 drain-gate.ts（写前保留的契约注释仍在本方法上）
    return this.#drain.waitForIdle(() => this.active === 0, opts.timeoutMs ?? 0);
  }

  /**
   * poll 的读路径钩子：两条**惰性**的挂起闸各判一次（都不起定时器 —— 没人读的挂起不会自己动，
   * 与审批超时同一条纪律；崩溃/重启也不依赖任何在飞回调）。
   *
   * 审批那一半已外移到 `#approvals.expireIfExpired`（判据与副作用逐字等价，见
   * approval-supervisor.ts）；这里保留「命中审批就返回、不再判 timer」的形状 ——
   * 两条闸的原因判据本来就互斥（`approval` / `timer`，`approvalExpired` 内部也卡原因），
   * 排他在这里是**写出来的**而不是「两个函数各自恰好正确」—— C 之前正是「一个状态
   * 兼职两件事」让审批那条闸去叫醒了等时刻的 run。
   */
  #lazyGates(rec: TaskRecord | undefined): TaskRecord | undefined {
    if (!rec) return rec;
    const now = Date.now();
    if (this.#approvals.expireIfExpired(rec, now)) return rec;
    if (timerDue(rec, now)) this.#scanner.wakeDue(rec, now);
    return rec;
  }

  /**
   * 取消的**意图**（2026-09-28 ref-cancel-api）。落库状态按意图判、不从 signal 反推 ——
   * 同一条 signal 有三个来源（调用方传入 / `runTimeoutMs` / 取消），反推不出「谁按的」。
   *
   * 生命周期（2026-10-13 ref-run-root-close 收紧）：登记在 cancel 的临界段**入口**（异步路径在等闸之前
   * 就立上 —— 它同时是 `#executeInner` 取消意图闸的判据），摘除在四处：run 收尾
   * （`cancelIntent` 取值处）、`#executeInner` 的意图闸、cancel 自己的 `finish`
   * （仅当没有活着的 `#execute` 会消费它时）、`#execute` 的 finally（兜底）。
   */
  readonly #cancels = new Set<string>();

  /** 在飞 run 的中止句柄（**每任务一个**，同时服务超时与取消 —— 机制相同、意图不同）。 */
  readonly #runAborts = new Map<string, AbortController>();

  /**
   * 已由 `cancel` **自己**收尾过的任务。那趟等槽位的 `#execute` 还活着，它的 finally 会再记一遍账
   * （onFinished 触发两次 / 流被关两次）—— 用这个集合把「谁负责记账」说定：cancel 收尾了，
   * finally 就只做它自己那份（在飞递减、通知等待者、排空通知）。
   *
   * 两个生产者（2026-10-13 ref-run-root-close 补齐）：① cancel 的 queued 分支（老的那条）；② `#executeInner`
   * 的取消意图闸 —— 被并发恢复路径派发出来的 suspended 取消也有一条活着的 `#execute`，
   * 它在意图闸拦下起跑、同样要把「记账归 cancel」说定。两个生产者都保证有消费者
   * （那趟 `#execute` 自己的 finally），不会滞留。
   */
  readonly #cancelSettled = new Set<string>();

  /**
   * **唯一的派发口**（2026-09-28 外部深评 P1-1 / P2-1 的结构性修法）。
   *
   * 为什么要有它：所有「先把状态落库成 `running`/`queued`、再派发 `#execute`」的路径
   * （`submit` / `approve` / `signalTask` / 到期唤醒 / 审批超时兜底 / `resumePending` 的认领）
   * **形状相同**，而停机闸原先散在各支里 —— 于是「这道闸覆盖几条路径」变成一份**靠人记**的清单：
   * 第二批修了三支、第四支（审批超时兜底，走 `poll()`）与第五支（认领循环）漏了，两处都在
   * `drain()` 返回 `true`（「排空干净」）之后**又起了新 run**（实证：`drain-race.test.ts`）。
   *
   * 修法：闸**只在这里判一次**，各支只管「先落库」的顺序（那条纪律不变）。
   * 源码级穷尽守卫在 `tests/transport/dispatch-guard.test.ts`：`this.#execute(` 与
   * `this.#executeInner(` 都只许出现在自己的那一个家里 —— 第五次新增恢复路径时构建就红，
   * 不靠记性。（钉两个而不是一个：`#executeInner` 是同一个旁路的另一半，绕过它还会连带
   * 绕过 `active++` 与 `#streams.open`，见那份用例的注释。）
   *
   * 语义：停机窗口里**不派发**。记录已落库（`running`/`queued` + 本进程 ownerId），
   * 留给下次启动的 `resumePending` 认领（ownerId 含 pid ⇒ 新进程必认领）—— at-least-once 兜底，
   * 与「先落库再派发」的崩窗同形；决定 / 事件都在记录里，不丢。
   * ⚠️ 「留给下次启动」成立的前提是**宿主真的退出**（见 `drain()` 的契约：单向闩 + 本进程内
   * 无自愈路径）。所以这里的拒绝**不静默**：首次拒绝打一条 `console.warn` 说清「谁、什么状态、
   * 谁来认领、宿主该做什么」—— 否则运维只看到一个停在 `running` 的任务，无从解释。
   * ⚠️ 对调用方**不抛错**（`submit` 的「停机中不接单 ⇒ 503」在那之前的早返回里，不在这一层）。
   */
  #dispatch(rec: TaskRecord): void {
    if (this.#drain.isDraining) {
      // **不静默**（2026-09-28 PR #164 复核 §1）：这里的拒绝等于「本进程此后不再推进任何任务」，
      // 而它此前是一条裸 `return` —— 运维只会看到一个停在 `running` 的任务，无从解释它为什么不跑
      // （`drain()` 的契约见上：宿主此刻必须退出，记录留给下次启动认领）。
      // 只报一次：停机窗口里每条被拒记录各报一条会把日志刷满，而它们的原因完全相同。
      if (!this.#dispatchRefusedWarned) {
        this.#dispatchRefusedWarned = true;
        console.warn(
          `[agentia] 停机中：已拒绝派发 task ${rec.taskId}（记录已落库成 ${rec.status}）—— ` +
            '本进程此后不再推进任何任务，它留给下次启动的 resumePending 认领；' +
            '宿主必须在 drain() 之后退出，否则这条记录会一直停在 running（见 usage-guide §7）',
        );
      }
      return;
    }
    void this.#execute(rec);
  }

  /** 「停机窗口里拒绝派发」的告警是否已出过（每次停机只报一条，见 `#dispatch`） */
  #dispatchRefusedWarned = false;

  /**
   * 当前**真正在排队**的任务数（`maxQueued` 的实时读数，诊断用）—— 与闸用的是**同一个**
   * `#queueDepth`，所以「看到的数」就是「判据的数」，不会各说各话。
   * 与 `inFlight` 的分工：`inFlight` 是「本进程已受理、未达终态」的全量（含在跑、含挂起），
   * 本读数是其中「排不上、在等槽位」的那一段。
   */
  get queued(): number {
    return this.#queueDepth();
  }

  /** 任务终态唤醒与等待：实现见 task-waiters.ts（`notify` / `wait`） */
  /** 排空通知：只在确无在飞任务时唤醒等待者（drain 的唯一出口）—— 判定在 drain-gate.ts */
  #notifyDrained(): void {
    this.#drain.signalIdle(() => this.active === 0);
  }

  /** 等到任务终态；超时抛错。`suspended` 不是终态 —— 继续等（人在路上 / 时刻未到）。 */
  async awaitTask(
    taskId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<TaskRecord> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // intervalMs 现在只是**兜底轮询**间隔，不是主路径：本进程把任务写到终态会主动唤醒
    // （见 task-waiters.ts 的 notify）。默认从 5ms 放宽到 250ms —— 旧实现每 5ms 读一次 store，
    // 等 30s 就是约 6000 次读（SQLite/Redis 下是 6000 次往返）。用异步 store 且终态由
    // **他进程**写入时唤不醒，才靠这个间隔兜底。
    const intervalMs = opts.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // 走 poll 而不是裸 store.get：惰性审批超时的判定挂在那里（HITL）
      const rec = await this.poll(taskId);
      if (!rec) throw new Error(`task 不存在: ${taskId}`);
      // ⚠️ 终态集合走 `isTerminalTask` 这个**单一真源**：手写枚举会让新加的终态（`cancelled`）
      // 在这里被漏掉 —— 表现为「取消了但 awaitTask 一直等到超时」，看起来像取消没生效
      if (isTerminalTask(rec)) return rec;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`task ${taskId} 等待超时（${rec.status}）`);
      await this.#taskWaiters.wait(taskId, Math.min(intervalMs, left));
    }
  }

  /**
   * 宿主重启续跑：把 store 里 queued | running 的记录重新派发执行
   * （running 视为进程中断）。返回重派数量（异步 store 下返回 Promise<number>）。
   * 幂等键去重照常生效。
   *
   * 实现在 `resume-scanner.ts`（**逐字搬迁**，含那四步扫描的**顺序**与各自理由、重入闸、
   * 到期索引接线、多进程 `ownerId` 的判定分级）。这里只留薄壳 —— `resumePending` 是
   * `AsyncRunner` 的公开 API，签名与返回类型不变。
   *
   * 一句话提要（细节见实现）：`suspended` **不捡**（它在等人、不是孤儿），但读到它会做
   * 惰性判定 —— 审批超时自动全拒并重派、`wakeAt` 已到的唤醒并重派（`drain()` 之后不唤，
   * 配套 5）；认领**先落库再派发**；多进程靠 `ownerId` 区分他我（`staleAfterMs > 0` 时问 pid）。
   */
  resumePending(opts: ResumePendingOptions = {}): number | Promise<number> {
    return this.#scanner.resumePending(opts);
  }

  /**
   * 在飞计数包裹层：#executeInner 是状态机主体，这里只负责 active 计数与排空通知。
   * 计数在**同步段**（第一个 await 之前）自增 —— 所以 `void this.#execute(rec)` 一返回，
   * 该任务就已经计入了，drain 不会漏掉「刚 submit、还没开始跑」的任务。
   */
  async #execute(rec: TaskRecord): Promise<void> {
    // 同步认领（在任何 await 之前）：同键并发提交的第二个 submit 立刻能看见它。
    // 挂起（suspended）**不释放** —— 那是「等人工」，不是终态；放了会让同键再起一个新任务。
    const key = rec.idempotencyKey;
    if (key !== undefined && !this.#claims.has(key)) this.#claims.set(key, rec);
    // 同步开流（在任何 await 之前）：`GET /tasks/:id/stream` 从这一刻起可以订阅。
    // 复用语义见 task-events.ts —— HITL 恢复 / 崩溃重投是**同一个任务**，序号接着走。
    this.#streams.open(rec.taskId);
    // 「本进程已受理」的起点（同步段，与 #streams.open 同处）：cancel 的 409 文案据此
    // 区分「排队未起跑」与「真不在本进程」。终点是整个 #execute 退出的 finally。
    this.#executions.add(rec.taskId);
    this.active++;
    // **在等槽位**的入口（同步段，与 `active++` 同处）—— 只看 id，出集合在「拿到槽位」
    // 那一刻（`#executeInner`）与本节 finally 两处，`add`/`delete` 幂等所以两处都安全。
    // 同步段入集合是这道闸**挡得住同步突发**的前提：`#dispatch` 是 submit 的最后一行，
    // `void this.#execute(rec)` 的 body 到第一个 await 之前全同步 ⇒ 一个循环里连续 submit
    // 时，每次读到的都是已含前几条的**准确**读数。
    this.#waiting.add(rec.taskId);
    try {
      await this.#executeInner(rec);
    } finally {
      this.#waiting.delete(rec.taskId);
      // 通知在飞递减**之前**：drain() 返回时保证「任务已终态 + 回调已发完」。
      // 内层 finally 保证回调万一抛错（理论上被吞掉）也不泄漏在飞计数。
      try {
        // HITL：挂起不是终态 —— onFinished 的承诺是「任务达终态」，对它不开火。
        // 已由 `cancel` 自己收尾过的那一条也不开火（`#cancelSettled`）：两处都记会触发两次
        if (rec.status !== 'suspended' && !this.#cancelSettled.has(rec.taskId)) {
          await this.#notifySinks(rec);
        }
      } finally {
        this.active--;
        // 记账的归属：cancel 收尾过的那一份已经做过（流收口 / 会话清理 / 认领释放），
        // 这里只消费掉标记，不重复 —— 在飞递减、等待者、排空通知照旧必达
        if (!this.#cancelSettled.delete(rec.taskId)) {
          // 终态即清理 HITL 会话回写快照（挂起则保留 —— 恢复段成功后还要用它）
          if (rec.status !== 'suspended') this.sessionInputs.delete(rec.taskId);
          // 任务流收口（挂起不算终态 —— 见 isTerminalTask 的注释：批了会接着跑，流得开着）。
          if (isTerminalTask(rec)) this.#streams.markDone(rec.taskId);
          // 释放同键认领：**只有终态才释放**（挂起仍在等人，同键提交不该另起一个任务）。
          // 判据用 taskId 比对而非 `claimed`：HITL 的恢复段是**另一次** #execute 调用
          // （approve / 超时兜底 / 崩溃恢复都会重派，且异步 store 交出的常是新副本对象），
          // 那次 `claimed` 必为 false —— 只看 `claimed` 会让挂起过的键**永不释放**（认领表泄漏，
          // 同键从此永远命中那条老记录）。
          if (
            key !== undefined &&
            rec.status !== 'suspended' &&
            this.#claims.get(key)?.taskId === rec.taskId
          ) {
            this.#claims.delete(key);
          }
        }
        // 任务已达终态并落库 → 唤醒 awaitTask 的等待者（放在递减之后，语义与 drain 一致）。
        // 挂起也唤醒：等待者看一眼状态继续等（suspended 不是终态），无副作用。
        this.#taskWaiters.notify(rec.taskId);
        this.#notifyDrained();
        // 「本进程已受理」的终点（与 #execute 同寿）。删在最后：此前若 cancel 挤进来，
        // 它看到的仍是「本进程在推进这条」，文案不会突然改口。
        this.#executions.delete(rec.taskId);
        // 取消意图的兜底摘除（2026-10-13 ref-run-root-close）：正常路径里它已被各自的出口消费
        // （run 收尾 / 意图闸 / cancel 自己的 finish），这里是「早退路径没走到任何出口」的
        // 兜底 —— 意图滞留会让一条**后来**的同任务取消记录误导收尾判定（意图只认 taskId）。
        this.#cancels.delete(rec.taskId);
      }
    }
  }

  /** 通知任务完成回调。逐个 await，**sink 抛错被吞** —— 回调失败不得影响任务状态。 */
  async #notifySinks(rec: TaskRecord): Promise<void> {
    if (this.taskSinks.length === 0) return;
    // 传快照：回调拿到的是「此刻的终态」，之后记录再被改动不会串进回调持有的引用
    const snapshot = { ...rec };
    for (const sink of this.taskSinks) {
      try {
        await sink.onFinished(snapshot);
      } catch {
        /* 回调失败不影响任务状态（同 trace sink / memory 回写的防护） */
      }
    }
  }

  async #executeInner(rec: TaskRecord): Promise<void> {
    // 顶层容错：异步 store（网络客户端）任何一处 reject 都不得逃逸成
    // unhandled rejection（Node ≥15 默认终止进程）——任务标记失败尽力落库。
    try {
      // 异步 store 的幂等去重在此补齐（submit 同步门面无法 await）。三条判据（存在既有记录 /
      // 不是自己 / 状态是 succeeded）与那条 load-bearing 的顺序依赖（`store.save` 先写记录、
      // 后写 idem 索引）都搬进了 `adoptSucceededOutcome` 的注释里 —— 一字未改。
      if (rec.idempotencyKey) {
        const existing = await this.store.byIdempotency(rec.idempotencyKey);
        if (adoptSucceededOutcome(rec, existing)) {
          // 采纳既有结果：落库失败也不该把一次已知成功的任务翻成 failed
          await this.#safeSave(rec, 'outcome');
          return;
        }
      }

      // 「出排队段」必须与「占槽」落在**同一次同步执行**里：`await acquire()` 的连续体要等
      // 一次微任务，而 `acquire` 内部的 `running++` 是同步的 —— 同一条任务在那一瞬被算两遍
      // ⇒ 排队深度虚高一格（`concurrency: 1` + `maxQueued: 1` 下第 2 条合法提交被误拒）。
      // 所以：**有空位就趁 await 之前出集合**（判据是快照 —— 判断与 acquire 之间没有 await，
      // 池子状态不会变）；排队等到的那些，则在 acquire 兑现后出集合（同一个 delete，幂等）。
      // ⚠️ 刻意**不**把 acquire 换成同步快路径：那会顺带少掉一次微任务，把「置 running」
      // 相对引擎推进的时刻提前，踩到既有用例里「等到 running 就当工具已挂在飞」的隐含假设
      // （`tests/transport/cancel.test.ts` 的前置断言当场红）。记账改原子，时序一个字不改。
      if (this.#slots.inUse < this.concurrency) this.#waiting.delete(rec.taskId);
      await this.#slots.acquire();
      this.#waiting.delete(rec.taskId); // 拿到槽位 = 离开排队段（此后归 concurrency 管）
      try {
        // 认领前**重读一遍**再判 —— 为什么要重读、以及「读失败不改变既有行为」那条边界，
        // 都搬进了 `run-outcome.ts` 的 `readClaimed`（具名件才能被直接单测）。
        // ⚠️ 判据**只挡终态**，别写成 `!== 'queued'`：恢复那几条路（approve / 到期唤醒 /
        // 崩溃重投）都**先**把状态置成 `running` 再派发 —— 那样写会把它们全挡死，
        // 症状是「恢复了但任务没跑」（本实现第一版就是这么错的，transport 套件当场挂住）。
        const claimed = await readClaimed(this.store, rec);
        if (claimed && isTerminalTask(claimed)) {
          // 与 store 对齐再返回：外层 finally 会拿 `rec` 落一次 outcome，
          // 不同步的话会用**陈旧副本**把取消覆盖回 queued（任务从此既不起跑也不终态）。
          // 记账（sinks / 事件流 / 认领释放 / 等待者）交给**还活着**的那次 #execute 的 finally
          // ——它正是此刻在等槽位的这一条。
          Object.assign(rec, claimed);
          return;
        }
        // 取消意图闸（2026-10-13 ref-run-root-close）：cancel 已在收尾这条任务（意图先于落库可见、且
        // 在还有活着的 #execute 时不会被摘除）⇒ **绝不起跑**。没有它时这条缝真实存在：
        // 上面的 readClaimed 读到的是 cancel 落库前的快照，这里照常置 running 落库，
        // 就把 cancelled 覆盖回去 —— 任务取消后照常执行、webhook 双发。
        // 记账归 cancel：登记 #cancelSettled（覆盖面从 queued 补齐到这一支 —— 被并发
        // 恢复路径派发出来的 suspended 取消也走这里），本趟 finally 只走低层清理。
        if (this.#cancels.has(rec.taskId)) {
          this.#cancelSettled.add(rec.taskId);
          this.#cancels.delete(rec.taskId);
          rec.status = 'cancelled';
          rec.error = abortedError();
          return;
        }
        // 在飞句柄**先**登记（在任何 await 与状态写之前）：cancel 的中断窗口从这里闭合
        this.#runAborts.set(rec.taskId, new AbortController());
        rec.status = 'running';
        rec.startedAt = Date.now();
        await this.store.save(rec);

        // 取消意图在收尾判定里要用两次：正常出口（`#cancels.has`）与**异常出口**
        // （拒绝式认 signal 的宿主 —— abort 后 reject，包 fetch 类客户端的常见写法）。
        // ⚠️ 必须声明在 try **之外**：`let` 是块级作用域，写在 try 里 catch 看不到它。
        let cancelIntent = false;
        try {
          // 会话注入（C4 的异步通道）：sessionId 是可序列化的引用，store 实例由
          // runner 持有 —— 执行前在这里换成 RunAppOptions.session。resumed 记录
          // 绕过 submit 的入口检查，所以「带了 sessionId 却没配 sessionStore」
          // 在本路径也要响亮失败（不静默降级成「没有会话」）。
          if (rec.spec.options?.sessionId !== undefined && this.sessionStore === undefined) {
            throw new Error(
              `任务 ${rec.taskId} 带了 options.sessionId，但本 runner 未配 sessionStore`,
            );
          }
          // **续跑段**的判定（不只是 HITL：时间挂起醒来也是续跑）—— 决定会话注入、
          // 链路关联与会话回写三条口径的走向（见下）。判据**不能**只看 `approvals`：
          // timer 挂起醒来时没有任何决定（approvals 是空的），但 `rec.spec.messages` 同样是
          // 挂起段落库的**扩展历史**（末尾是含未决 tool_use 的 assistant）—— 那三条口径
          // 一字不差地适用（`suspendedSince` 是「这条记录挂起过」的痕迹：挂起时写、终态才清）。
          const isResume = rec.approvals !== undefined || rec.suspendedSince !== undefined;
          // runTimeoutMs 到点即 abort（对尊重 signal 的客户端是真中止）；与调用方
          // 可能传入的 signal 合成，任一触发都中止本次 run。
          // 每任务**一个** controller，同时服务超时与取消（机制是同一条 signal，差别在意图）：
          // 它在认领处就登记进了 #runAborts，所以 cancel 找得到它
          const runAc = this.#runAborts.get(rec.taskId) ?? new AbortController();
          this.#runAborts.set(rec.taskId, runAc);
          const combined = combineSignals(rec.spec.options?.signal, runAc.signal);
          // 记账事件 → 本任务的流（`GET /tasks/:id/stream` 的数据源）。
          // 与任务 spec 里可能自带的那个**叠加**而不是覆盖（composeTraceEvents 的同一份理由）：
          // 两边都要收到 —— 覆盖会让其中一条静默失聪。
          const bridgeTraceEvents = composeTraceEvents(
            (e) => this.#streams.push(rec.taskId, e),
            rec.spec.options?.onTraceEvent,
          );
          // 装配交给引擎的选项（三条口径：续跑段不注入 session / 无值不落键 /
          // 续跑段的 trace 挂到上一段 runId）—— 逐条理由在 `run-call-options.ts` 里
          const callOpts = buildRunCallOptions({
            rec,
            isResume,
            sessionStore: this.sessionStore,
            client: this.client,
            signal: combined,
            bridgeTraceEvents,
          });
          try {
            const out = await this.#raceTimeout(
              this.app.run(rec.spec.messages, callOpts),
              rec.taskId,
              () => runAc.abort(),
            );
            rec.runId = out.run.runId;
            rec.result = out.result;
            rec.error = out.result.error;
            if (out.result.stopReason === 'suspended' && out.result.suspendedMessages) {
              // HITL 挂起：记录怎么改、事件簿记按 `eventsDelivered` 分档、以及「用户输入快照
              // 必须在 `rec.spec` 被覆盖**之前**取」那条顺序事实 —— 全在 `run-outcome.ts`。
              // 槽位照常释放（finally）、onFinished 不触发（#execute 的出口判断）、
              // finishedAt 不置（下面 finally 里按状态跳过）：它不是终态。
              const snapshot = applySuspendedOutcome(
                rec,
                out.result,
                out.result.suspendedMessages,
                {
                  isResume,
                  hasSessionStore: this.sessionStore !== undefined,
                  now: Date.now(),
                },
              );
              // 顺序承重：快照先落地，`markSuspended` 再登记（后者读 status / suspendedReason /
              // wakeAt —— 三样都刚被上一行写好；挂起读数纪律①：与落库同一个分支登记）
              if (snapshot !== undefined) this.sessionInputs.set(rec.taskId, snapshot);
              this.#approvals.markSuspended(rec);
            } else {
              // 取消：机制与 `runTimeoutMs` 一字不差（同一条 abort signal），**意图**不同 ——
              // 意图从 `#cancels` 取，不从 signal 反推：同一条 signal 有三个来源
              // （调用方 / 超时 / 取消）。记录的改法与「事件簿记在终态无条件清」那条（以及它
              // 与挂起分支刻意不同的理由）都在 `run-outcome.ts` 的 `applyTerminalOutcome` 里。
              const cancelled = this.#cancels.has(rec.taskId);
              const settled = applyTerminalOutcome(rec, out, { cancelled, isResume });
              // 离开挂起态（读数纪律②）：两处恢复路径负责「还没跑到终态」的那一半，
              // 这一支负责「跑到了终态」的那一半（兜底：恢复失败也会落到这里）。
              // ⚠️ 顺序承重：先改记录（上一行按 `run.status` 落状态），再除名。
              this.#approvals.unmarkSuspended(rec.taskId);
              if (settled) {
                // HITL 恢复段 + 会话：本段没把 session 交给 run 层（见上面 callOpts 注释），
                // 会话回写由 runner 自己补 —— 口径与 run.ts 的 appendSession 一致。
                await this.#appendResumedSession(rec, out.result.finalText);
              }
            }
          } finally {
            // 正常收尾（没有源中止）时主动摘除挂在各源上的监听器 —— 宿主级共享
            // signal 是长寿的，不摘会按任务数累积（MaxListenersExceededWarning）
            releaseCombinedSignal(combined);
            // 在飞句柄与取消意图一起摘掉：意图只在**这次 run** 的收尾判定里有用（见下面那处）。
            // ⚠️ 意图的取值要留给 catch（`Set.delete` 返回布尔）：拒绝式认 signal 的宿主
            // 走的就是 catch —— 在这里丢掉意图，取消就会被记成 failed（正是要治的病）。
            this.#runAborts.delete(rec.taskId);
            cancelIntent = this.#cancels.delete(rec.taskId);
          }
        } catch (e) {
          // 意图先到 ⇒ cancelled（与「结果说成功、取消先到」同一条「意图赢」规则）——
          // 覆盖「abort 后 reject」的宿主路径；无意图的异常照旧是 failed。
          if (cancelIntent) {
            rec.status = 'cancelled';
            rec.error = abortedError();
          } else {
            rec.error = classifyError(e);
            rec.status = 'failed';
          }
        }
      } finally {
        // HITL：挂起不是「完成」—— finishedAt 不置（等待中的任务没有结束时刻）
        if (rec.status !== 'suspended') rec.finishedAt = Date.now();
        // 落库失败不遮罩、槽位必须释放：释放放在内层 finally，即便落库实现抛错也必达
        try {
          await this.#safeSave(rec, 'outcome');
        } finally {
          this.#slots.release();
        }
      }
    } catch (e) {
      rec.status = 'failed';
      rec.error = classifyError(e);
      rec.finishedAt = Date.now();
      await this.#safeSave(rec, 'outcome');
      console.error(`[agentia] task ${rec.taskId} 执行异常:`, e);
    }
  }

  /**
   * 尽力落库：**先包成 Promise 再挂 catch**。
   *
   * 同步 store（FileTaskStore 的 writeFileSync、node:sqlite）的 save 是**同步抛错**的。
   * 若写成 `Promise.resolve(this.store.save(rec)).catch(...)`，`this.store.save(rec)`
   * 会在 `Promise.resolve` 之前求值并同步抛出 —— 异常逃出 finally（跳过 #releaseSlot，
   * 并发槽位永久泄漏），再被外层 catch 里同一写法抛第二次，最终逃出 #execute 变成
   * unhandled rejection（Node ≥15 默认终止宿主进程）。
   */
  async #safeSave(rec: TaskRecord, phase: PersistFailureInfo['phase']): Promise<void> {
    try {
      await Promise.resolve().then(() => this.store.save(rec));
    } catch (error) {
      this.#reportPersistError(rec, error, phase);
    }
  }

  /**
   * 落库失败的上报口（`#safeSave` 与 `cancel` 的临界段共用，2026-10-13 ref-run-root-close 抽出）。
   * 落库失败不遮罩主流程：任务结果仍在内存记录里可见。
   * 但它**必须有人能收到** —— 宿主无法自己发现这件事（见 onPersistError 的注释）。
   */
  #reportPersistError(rec: TaskRecord, error: unknown, phase: PersistFailureInfo['phase']): void {
    if (this.onPersistError) {
      try {
        // 传快照（与 #notifySinks 同纪律）：回调拿到的是「此刻的记录」，之后记录
        // 再被推进不会串进回调持有的引用
        this.onPersistError({ record: { ...rec }, error, phase });
      } catch {
        /* 观测是辅助动作：回调抛错不得影响 run（与 onUnpricedModel 同口径） */
      }
    }
  }

  /**
   * 超时竞速（runTimeoutMs > 0 时）：超时先 `onTimeout()`（abort 在飞请求）再 reject
   * → 任务按 failed 落库、槽位回收。尊重 signal 的客户端会被真中止；不尊重者只是
   * 停止等待（race 已订阅该 Promise，其后续 reject 不会变成 unhandled rejection）。
   * timer 必须 clear（否则每次任务都留一个定时器）。
   */
  async #raceTimeout<T>(p: Promise<T>, taskId: string, onTimeout?: () => void): Promise<T> {
    if (this.runTimeoutMs <= 0) return p;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            // TimeoutError（code='timeout'）：classifyError 归 `timeout` 一类账 ——
            // 与引擎工具超时 / MCP 桥兜底同口径（spec §10 2026-09-17 ref-timeout-error-type「超时自成一类」）。
            // 此前这里是裸 Error → 落 unknown，同一件事在异步宿主这条路径上记成另一本账。
            reject(new TimeoutError(`task ${taskId} 执行超时（${this.runTimeoutMs}ms）`));
          }, this.runTimeoutMs);
          // ⚠️ 不 unref：这个 reject 是 `awaitTask` / 调用方 await 的终点（spec §10 ④）。
          // 见 `tests/timeoutLiveness.test.ts`。
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * HITL 恢复段的会话回写（run 层 `appendSession` 的替身 —— 恢复段刻意不注入 session，
   * 见 #executeInner 的 callOpts 注释）。同 run.ts 的三条不变量：只在成功路径调用、
   * 只写「本轮用户输入 + 最终回复」（run 内部 tool 往返不进历史）、历史以 assistant
   * 结尾（无文本补占位）。回写失败吞掉 —— 辅助动作不得击穿任务（同 memory 回写防护）。
   *
   * 无快照（进程在挂起期间重启过）时**跳过**：宁可少一轮历史，也不凭猜测写。
   */
  async #appendResumedSession(rec: TaskRecord, finalText: string): Promise<void> {
    const sessionId = rec.spec.options?.sessionId;
    const input = this.sessionInputs.get(rec.taskId);
    if (sessionId === undefined || this.sessionStore === undefined || input === undefined) return;
    try {
      await this.sessionStore.append(sessionId, [
        ...input,
        // 占位文案与 runtime/run.ts 的 EMPTY_REPLY_MARK 保持同文（同一条会话不变量）
        { role: 'assistant', content: finalText || '（本次无文本输出）' },
      ]);
    } catch {
      /* 辅助动作失败不影响任务 */
    }
  }
}
