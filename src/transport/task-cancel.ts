import { abortedError } from '../engine/turn.js';
import { isThenable } from '../store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../store/store.js';
import { taskNotFound } from './task-not-found.js';
import { isTerminalTask } from './task-stream.js';

/**
 * 取消一个任务 —— 判定、意图、等待与收尾（`docs/plans/2026-09-28-cancel-api.md`）。
 *
 * 为什么单独一件：取消是**写侧**的一整条决策链（三种在服状态各自的语义 → 意图 → 中止 /
 * 落终态 → 宽限等待），而它要读的四样东西（在飞推进、中止句柄、「本进程已受理」、挂起读数）
 * 与要做的收尾（sinks / 等待者 / 流 / 认领 / 排空）**都属于宿主**。所以这里持有取消自己的账本
 * （意图 / 已由 cancel 收尾 / 并发串行），宿主用 `CancelPeers` 把读数与收尾借进来 ——
 * 依赖单向（取消 → 宿主回调），不做反向 import，也避免把执行状态机拖进来。
 *
 * ## 取消账本（执行状态机也要读写，这是两者的**全部**耦合面）
 *
 * - **意图**（`#intent`）：落库状态按意图判、不从 signal 反推 —— 同一条 signal 有三个来源
 *   （调用方传入 / `runTimeoutMs` / 取消），反推不出「谁按的」。登记在取消临界段的**入口**
 *   （异步路径在等闸之前就立上 —— 它同时是执行状态机「绝不起跑」的判据）；摘除四处：
 *   run 收尾取值处、执行侧意图闸、cancel 自己的收尾（仅当没有活着的执行趟会消费它）、
 *   执行趟的 finally（兜底）。
 * - **已由 cancel 收尾**（`#settled`）：等槽位那趟执行还活着，它的 finally 会再记一遍账
 *   （onFinished 两次 / 流被关两次）—— 用这个集合把「谁负责记账」说定。两个生产者
 *   （cancel 的 queued 分支、执行侧的意图闸）都保证有消费者（那趟执行自己的 finally）。
 * - **并发串行**（`#inflight`）：两个并发 cancel 各自读-改-写会双记账（webhook 双发）。
 */
export interface CancelPeers {
  /** 任务库（取消要读现场、写终态） */
  readonly store: TaskStore;
  /**
   * 三条推进路径（审批 / 事件投递 / 到期唤醒）在该任务上的在飞 Promise（无则 undefined）。
   * 取消进入前先等它收口、**重读**记录再判（凭进闸前的旧快照落 cancelled，会被对方随后的
   * running 落库覆盖回去 —— 任务取消后照常执行）。
   */
  advanceOf(taskId: string): Promise<unknown> | undefined;
  /** 在飞 run 的中止句柄（缺 = 本进程没有可中断的句柄） */
  abortOf(taskId: string): AbortController | undefined;
  /**
   * 本进程是否**已受理并正在推进**这条任务。只为 409 的文案存在：命中
   * 「`status === 'running'` 但在飞句柄表里没有」时，区分「本进程排队未起跑」
   * 与「真不在本进程」—— 四条恢复路径都**先**置 running 再派发，句柄要到拿到槽位才登记，
   * 中间整个窗口都落在这个差集里；对它说「不在本进程」是**说反话**。
   */
  acceptedHere(taskId: string): boolean;
  /** 挂起读数除名（`approval-supervisor.ts` 的 `#suspended`：离开 suspended 态的三条纪律之一） */
  forgetSuspended(taskId: string): void;
  /** 落库失败的观测口（不遮罩，但必须可观测；与 `saveTaskRecord` 同一口径） */
  report(rec: TaskRecord, error: unknown): void;
  /**
   * 终态收尾记账（**一处**，两个调用方）：通知 TaskSink → 唤醒等待者 → 流收口 →
   * 会话快照清理 → 同键认领释放 → 排空通知，返回给调用方的快照。
   */
  settle(rec: TaskRecord): Promise<TaskRecord>;
  /** 等一条任务被唤醒（终态 / 宽限到点；到期 resolve，不是 reject） */
  wait(taskId: string, ms: number): Promise<void>;
}

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
 * 取消的**宽限**：取消请求发出后，留给那次 run 自己收尾的时间。
 *
 * 尊重 signal 的 client 是毫秒级收尾（SDK 一收到 abort 就 reject，run 随即以 `stopReason:
 * 'aborted'` 收尾 —— 那条路连 `result` 与 trace 都保得住，本常量对它只是余量：一次网络往返 +
 * trace 落盘）。不认 signal 的宿主**永远**不会自己收尾 —— 等多久都是白等，所以到点就撤回意图、
 * 如实抛 409（见 `#awaitCancelled`），不假装取消成功。
 */
const CANCEL_GRACE_MS = 2_000;

export class TaskCanceller {
  readonly #peers: CancelPeers;
  readonly #intent = new Set<string>();
  readonly #settledByCancel = new Set<string>();
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
  readonly #inflight = new Map<string, Promise<TaskRecord>>();

  constructor(peers: CancelPeers) {
    this.#peers = peers;
  }

  /** 这条任务上**有取消意图**吗（执行侧「绝不起跑」的判据） */
  intended(taskId: string): boolean {
    return this.#intent.has(taskId);
  }

  /**
   * 该任务上正在收尾的 cancel（推进路径进闸前等它收口，见 `#inflight`）；无则 undefined。
   * 这是取消账本对**监督件**的唯一读数。
   */
  inflightOf(taskId: string): Promise<TaskRecord> | undefined {
    return this.#inflight.get(taskId);
  }

  /**
   * 取走取消意图（`Set.delete` 的返回值就是「此前有意图吗」）。
   *
   * ⚠️ 拒绝式认 signal 的宿主**必须**用返回值而不是再查一次：run 的 finally 里摘掉句柄与
   * 意图是同一句，catch 靠这个布尔把「abort 后 reject」落成 cancelled 而不是 failed。
   */
  takeIntent(taskId: string): boolean {
    return this.#intent.delete(taskId);
  }

  /** 无条件摘除意图（执行趟 finally 的兜底：早退路径没走到任何出口时不得滞留） */
  dropIntent(taskId: string): void {
    this.#intent.delete(taskId);
  }

  /** 声明「这条任务的终态记账归 cancel」—— 那趟等槽位的执行会在 finally 里消费它 */
  markSettledByCancel(taskId: string): void {
    this.#settledByCancel.add(taskId);
  }

  /**
   * 这条任务的终态记账是否**已经归 cancel**（只读，不消费）。
   *
   * 与下一条是**两步**、不能合并：执行趟先按它决定「要不要发 TaskSink」，再在 finally 的
   * 清理段消费掉。若第一步就消费，第二步会读到 false ⇒ 把「已归 cancel」误判成「没人记过」，
   * 于是同一份记账做两遍（onFinished 两次 / 流关两次）。
   */
  settledByCancel(taskId: string): boolean {
    return this.#settledByCancel.has(taskId);
  }

  /** 消费「已由 cancel 收尾」标记；返回此前是否登记过（= 本次该跳过自己那份记账） */
  takeSettledByCancel(taskId: string): boolean {
    return this.#settledByCancel.delete(taskId);
  }

  /**
   * 取消一个任务（durable 配套 5 的另一半）。
   *
   * 三种「在服」状态各自的语义 —— 都落在这一处，不分散：
   * - **running**：中止在飞 signal ⇒ 引擎以 `stopReason: 'aborted'` 收尾（尊重 signal 的
   *   client 是**真中断**，token 不再烧；不尊重者等价「放弃等待」—— 与 `runTimeoutMs`
   *   同一份契约）。等它真落库再返回：不等的话调用方拿到的是 `status` 仍为 running 的快照，
   *   「取消了但状态还在跑」比不返回更误导。
   * - **queued**（还没起跑）：落终态；执行侧拿到槽位后会**重读**再判，
   *   所以被取消的排队任务**绝不起跑**。记账由本方法自己做；那一趟还活着的执行（在等槽位）
   *   靠 `markSettledByCancel` 在 finally 里跳过它那一份（否则 onFinished 两次）。
   * - **suspended**（两种原因都算）：落终态 —— 两条唤醒闸都 gate 在 `status === 'suspended'`
   *   上，「不唤醒」因此是翻转状态的**推论**，不需要第二处标志。它没有活着的执行趟
   *   （挂起时那趟就走完了），所以记账（sinks / 事件流 / 认领释放 / 等待者 / 会话清理）
   *   由本方法自己做 —— 也因此它**不登记** `#settledByCancel`（没有消费者，加了就是泄漏）。
   *
   * 状态按**意图**落，不按机制落：超时的收尾语义**不变**（仍是 `failed` + `error.type` 为
   * `'timeout'`），取消带 `error = abortedError()`（取消不是失败，但原因要可查）。
   *
   * 不做静默 no-op：已终态 ⇒ `TaskCancelError(409)`（状态不对要说出来），不存在 ⇒ 404。
   * 边界（如实写在这里）：`running` 的 run **不在本进程**（多进程部署 / 上一世留下的 running）
   * 时抛 409 —— 本进程没有句柄可中断，改状态假装取消只会在那条 run 跑完时被覆盖回去。
   *
   * 并发 cancel 同任务串行：第二个等第一个收尾后重读再判（多半撞上「已终态 ⇒ 409」）。
   */
  cancel(taskId: string): MaybePromise<TaskRecord> {
    // 并发 cancel 串行（2026-10-13 ref-run-root-close）：两个并发 cancel 各自读-改-写会双记账（webhook 双发）
    const own = this.#inflight.get(taskId);
    if (own)
      return own.then(
        () => this.cancel(taskId),
        () => this.cancel(taskId),
      );
    const advance = this.#peers.advanceOf(taskId);
    const found = this.#peers.store.get(taskId);
    if (advance !== undefined || isThenable(found)) {
      // 异步路径：先入闸（后续推进路径会看到它并等待/跳过），等在飞推进收口后**重读**再判
      const run = (async (): Promise<TaskRecord> => {
        // 意图先立（等闸窗口里就要可见）：等槽位那趟执行可能正好放行 ——
        // 意图在场它才不会起跑（见执行侧的取消意图闸）。
        // ⚠️ 必须在 `await advance` **之前**登记：此前写在等待之后，与注释相反，
        // 让「等 approve 收口」的窗口里新起的执行趟看不到意图（2026-11-07 深评）。
        this.#intent.add(taskId);
        if (advance !== undefined) await advance.catch(() => undefined);
        try {
          const rec = advance !== undefined ? await this.#peers.store.get(taskId) : await found;
          return await this.#cancel(rec, taskId);
        } catch (e) {
          this.#intent.delete(taskId); // 没走到收尾（404/409）⇒ 意图撤回
          throw e;
        }
      })();
      const tracked = run.finally(() => {
        this.#inflight.delete(taskId);
      });
      this.#inflight.set(taskId, tracked);
      return tracked;
    }
    // 同步快路径：同步 store 且无任何推进在飞 ⇒ 临界段（get → 落库）原子，无需入闸
    return this.#cancel(found, taskId);
  }

  #cancel(rec: TaskRecord | undefined, taskId: string): MaybePromise<TaskRecord> {
    const { store, abortOf, acceptedHere, forgetSuspended, report, settle } = this.#peers;
    if (!rec) throw new TaskCancelError(404, taskNotFound(taskId));
    if (isTerminalTask(rec)) {
      throw new TaskCancelError(409, `task ${taskId} 已终态（${rec.status}），不能取消`);
    }
    const inflight = abortOf(taskId);
    if (rec.status === 'running' && !inflight) {
      // 「假装取消」是这里最坏的选项：那条 run 还活着，跑完会把状态覆盖回去
      // （调用方以为成功了，实际什么都没发生）。要说出来。
      // ⚠️ 但这两类情形**必须分开说**（2026-09-28 外部复核）：`acceptedHere` 是
      // 「本进程已受理并正在推进」的读数，与在飞句柄的差集就是「**已受理、未起跑**」。
      // 四条恢复路径先置 `running` 再派发、而句柄要到拿到槽位才登记 ⇒ 中间整个窗口
      // 都会落进这个差集 —— 对它说「不在本进程」是反话。调用方据此区分「稍后重试」
      // 与「得去找那个进程」。
      const accepted = acceptedHere(taskId);
      throw new TaskCancelError(
        409,
        accepted
          ? `task ${taskId} 已在本进程受理，但尚未起跑（正在等并发槽位 / 走恢复前置）—— ` +
              `此刻取消无法与那条在等槽位的执行路径安全收口（会重复记账），暂不支持；` +
              `请待它起跑后再取消，或先降低并发压力`
          : `task ${taskId} 正在运行但不在本进程，本进程无法中断它（多进程部署见 spec §10 2026-09-28 ref-cancel-api）`,
      );
    }
    // 意图先记下：在飞那条路要靠它把 aborted 的收尾落成 cancelled（否则落成 failed）
    this.#intent.add(taskId);
    if (inflight) {
      inflight.abort();
      return this.#awaitCancelled(taskId);
    }
    // queued / suspended：没有在飞 run（或它还没起跑），直接落终态 —— 记账由本方法做完，
    // 等槽位那趟执行的 finally 靠 `#settledByCancel` 跳过它那一份（否则 onFinished 两次）。
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
    forgetSuspended(taskId);
    // ⚠️ 落库**当场发生**（2026-10-13 ref-run-root-close）：不走 `saveTaskRecord` 的微任务延迟 —— cancel 的临界段
    // 必须原子。落库推迟一个微任务，「重读再判」那几条路（readClaimed / 恢复路径的进闸重读）
    // 就会在这个缝里读到取消前的旧状态、照常起跑/派发（「绝不起跑」承诺就是这样被破的）。
    // 失败口径与 saveTaskRecord 相同：不遮罩（记账继续），但必须可观测（peers.report）。
    let saved: MaybePromise<void>;
    try {
      saved = store.save(rec);
    } catch (error) {
      report(rec, error);
      saved = undefined;
    }
    // 只有「确实有一趟活着的执行会消费这个标记」才登记；`queued` 但本进程没有
    // 对应执行趟（resumePending 认领后被停机拒派 / 上一进程崩溃留下的记录）时登记
    // 会永远没人摘（2026-11-07 深评 F8）。
    if (wasQueued && acceptedHere(taskId)) this.#settledByCancel.add(taskId);
    const finish = (): Promise<TaskRecord> => {
      // 取消意图的终点（2026-10-13 ref-run-root-close）：还有活着的执行趟时留给它消费 —— 它靠这个意图
      // 判「绝不起跑」（等槽位那趟的 readClaimed 可能读到的是落库前的旧快照）；
      // 没有活着的（suspended 取消 / 它已先走完全程）由这里摘掉，不得滞留。
      if (!acceptedHere(taskId)) this.#intent.delete(taskId);
      // 深拷贝在此**不需要**（与 submit 的 cloneTaskRecord 不同档）：rec 是 cancel 自己的
      // 入站快照（store 契约保证不是库内活引用），且任务已终态 —— 之后没有任何路径再推进它
      return settle(rec);
    };
    return isThenable(saved)
      ? Promise.resolve(saved)
          .catch((error) => report(rec, error))
          .then(finish)
      : finish();
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
      const rec = await this.#peers.store.get(taskId);
      if (rec && isTerminalTask(rec)) return rec;
      const left = deadline - Date.now();
      if (left <= 0) {
        // 撤回意图（不删在飞句柄：那条 run 还在本进程里活着，句柄留给它自己的 finally 摘）
        this.#intent.delete(taskId);
        throw new TaskCancelError(
          409,
          `task ${taskId} 的中断没有在 ${CANCEL_GRACE_MS}ms 内生效（宿主不认 signal？）—— 取消未发生`,
        );
      }
      await this.#peers.wait(taskId, Math.min(250, left));
    }
  }
}
