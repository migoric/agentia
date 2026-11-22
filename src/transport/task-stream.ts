import { isTerminalStatus } from '../core/run.js';
import type { TraceRecordEvent } from '../core/trace.js';
import type { MaybePromise, TaskRecord } from '../store/store.js';
import type { StreamJanitorGroup } from './stream-janitor.js';
import { taskNotFound } from './task-not-found.js';
import type { TaskEventStreams, TaskStreamEvent } from './task-events.js';

/**
 * 任务流的**读出面**（`GET /tasks/:id/stream` 的引擎侧）—— 与 `AsyncRunner` 的状态机正交的一块。
 *
 * 为什么单独一件：`streamTask` 要同时表达三件事（先重放后实时 / 终态收口 / 跨进程不假装），
 * 每件都带一条「不这么做就对客户端说反话」的理由；它们与 store / 槽位 / 执行状态机**没有**
 * 交集，留在宿主里只是把两种知识混在一处。宿主持有的只是三个部件（记账缓冲、跨进程扫描器、
 * 读记录的 `poll`），所以注入的就是这三样 —— 没有第四个参数，也没有一个 `runner` 反向引用。
 *
 * ⚠️ `poll` 必须是**宿主那个** `poll`（带惰性挂起闸），不要换成裸 `store.get`：
 * 审批超时 / 到期唤醒的重判入口搭在这条轮询上，换掉会让两条兜底少一个触发点。
 */
export interface TaskStreamSource {
  /** 每任务的记账事件缓冲（见 `task-events.ts`） */
  readonly streams: TaskEventStreams;
  /** 跨进程收口的单例扫描器（见 `stream-janitor.ts`） */
  readonly janitors: StreamJanitorGroup;
  /** 读一条记录（同步 store 同步返回，异步 store 返回 Promise） */
  poll: (taskId: string) => MaybePromise<TaskRecord | undefined>;
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
 * 订阅的失败：带 HTTP 语义的状态码（404 = 任务不存在），HTTP 宿主据此回对应响应。
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
 *
 * 谓词放在本文件而不是执行状态机里：**流收口**是它最严格的消费者（猜错就是「流开着没事干」
 * 或「挂在等人却被关掉」）。状态机侧的清理也用它，两边因此不可能各有一套判据 —— 判据本体
 * 仍是 `core/run.ts` 的 `isTerminalStatus`（同一条事实只有一份读数）。
 */
export function isTerminalTask(rec: TaskRecord): boolean {
  return isTerminalStatus(rec.status);
}

/**
 * 跨进程流的兜底轮询间隔（2026-11-07 深评 F5）：本进程的 `markDone` 只覆盖本进程写终态，
 * 后续段在别的进程完成时只能靠读 store 收口。5s 是「连接不挂死」与「store 读放大」的折中；
 * 0 可关闭（内部/测试用）。
 *
 * ⚠️ 这是**一个**决策，两个读者：本文件的单流缺省值，与宿主构造扫描器时的 `pollMs`
 * （扫描器是 runner 级的单例，见 `stream-janitor.ts`）。所以由本文件 export、宿主 import ——
 * 各写一份 5_000 的话，改一处另一处会静默留在旧节奏上。
 */
export const STREAM_CROSS_PROCESS_POLL_MS = 5_000;

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
export async function serveTaskStream(
  source: TaskStreamSource,
  taskId: string,
  listener: (frame: TaskStreamFrame) => void,
  opts: { from?: number; pollMs?: number } = {},
): Promise<() => void> {
  const { streams, janitors } = source;
  const noop = (): void => {};
  if (streams.has(taskId)) {
    const replayed = streams.replay(taskId, opts.from);
    // 截断明示放在重放之前：下游先知道「前面缺了一段」，再读数据
    if (replayed.droppedBefore !== undefined) {
      listener({ type: 'truncated', droppedBefore: replayed.droppedBefore });
    }
    for (const item of replayed.events) {
      listener({ type: 'trace', index: item.index, event: item.event });
    }
    if (replayed.done) {
      const rec = await source.poll(taskId);
      if (rec) listener({ type: 'end', record: rec });
      // 终态但记录被清（TTL / 外部删除）也不能静默：客户端需要一个收口帧。
      else listener({ type: 'closed', reason: 'not-in-this-process' });
      return noop;
    }
    // 实时订阅：`onDone` 里补发 `end` 帧 —— 终态是流的一部分
    //（没有它，这条 SSE 会在任务跑完之后一直挂着，客户端以为它还在跑）
    const off = streams.subscribe(
      taskId,
      (item: TaskStreamEvent) => listener({ type: 'trace', index: item.index, event: item.event }),
      () => {
        // poll 可能是异步 store ⇒ 用 then 补发（此刻任务已终态、记录已落库）。
        // ⚠️ 必须有 rejection 处理（2026-11-07 深评）：`poll` 在 Redis 抖动时 reject，
        // 没有第二个参数的 `.then` 会产生 unhandledRejection ⇒ Node ≥15 终止宿主进程。
        void Promise.resolve(source.poll(taskId)).then(
          (rec) => {
            try {
              if (rec) listener({ type: 'end', record: rec });
              // 记录被清（TTL / 外部删除）时也不能一帧都不发：`end` 是唯一会
              // closeStream 的帧，不发就是永远只有心跳。
              else listener({ type: 'closed', reason: 'not-in-this-process' });
            } catch {
              /* listener 自己的错由宿主记账，不得再变成 unhandled */
            }
          },
          () => {
            try {
              listener({ type: 'closed', reason: 'not-in-this-process' });
            } catch {
              /* 同上 */
            }
          },
        );
      },
    );
    // 跨进程收口（2026-11-07 深评 F5；2026-11-09 P2-1 提到 runner 级）：登记到单例扫描器，
    // 本流关闭时注销。`pollMs <= 0` = 这条流不参与兜底（真正的时间间隔只有一个来源，
    // 即 runner 上那个扫描器 —— 单连接不再各建定时器）。
    let janitorCleanup: () => void = noop;
    const cleanup = (): void => {
      off();
      janitorCleanup();
    };
    if ((opts.pollMs ?? STREAM_CROSS_PROCESS_POLL_MS) > 0) {
      const onError = (() => {
        let warned = false;
        return (err: unknown): void => {
          if (warned) return;
          warned = true;
          console.warn(
            `[agentia:stream] 任务 ${taskId} 的跨进程收口判据抛错，本流继续轮询:`,
            err instanceof Error ? err.message : String(err),
          );
        };
      })();
      janitorCleanup = janitors.add(taskId, {
        isTerminal: (rec) => isTerminalTask(rec as TaskRecord),
        onTerminal: () => streams.markDone(taskId),
        onClosed: () => listener({ type: 'closed', reason: 'not-in-this-process' }),
        onError,
      });
    }
    return cleanup;
  }
  const rec = await source.poll(taskId);
  if (!rec) throw new TaskStreamError(taskNotFound(taskId));
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
