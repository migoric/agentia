/**
 * Agentia —— 信号监督：挂起任务的**事件投递**入口（`signalTask`）。
 *
 * 从 `async.ts` 的 `AsyncRunner` 抽出的**方向正交**的一块（外部深评结构体检的建议④
 * 「恢复重投」那一族里、与原「审批监督」同形的另一半）。
 *
 * ⚠️ 它与 {@link ApprovalSupervisor} 的 `approve` 是**同一族** —— 都是「挂起任务的外部
 * 唤醒入口」，形状逐条对应：
 *   读记录 → 校验挂起 → 改状态 → **先落库再派发** → `unmarkSuspended` → `dispatch`
 * 两处不同，且都是真实的语义差别（不是待收拾的重复）：
 *   ① **并发闸不同款**：`approve` 共享在飞那次（决定是幂等合并，重入返回同一个 Promise）；
 *      事件**串行成链** —— 两条并发事件是两条不同的输入，共享就是静默丢掉一条。
 *   ② **多一道容量闸**：事件要进 `rec.pendingEvents`（有界），审批决定直接合并进 `rec.approvals`。
 *
 * 分成两个文件而不是合成一个「挂起中心」：两者的领域词不同（决定 / 事件），文件名要能说准。
 * 若将来长出**第三个**唤醒通路，那些公共形状就该抽出来 —— 现在抽是过早。
 *
 * **零行为变化**：逐字搬迁 + 依赖改为构造注入。判据次序（状态 ⇒ 幂等 ⇒ 容量）、错误类型、
 * 副作用次序一字未改。
 *
 * 为什么 `dispatch` 用**回调注入**而不是 import `async.ts`：见 `approval-supervisor.ts` 头注
 * （同一条理由 —— `#dispatch` 归 `AsyncRunner`，本件只消费它）。
 *
 * ⚠️ `TaskEventError` 随本簇迁到这里；`async.ts` 仍 **re-export** 它 ⇒
 * `http-endpoints.ts` 与既有用例的 `from './async.js'` 导入路径不变。
 */
import type { TaskEvent } from '../core/run.js';
import type { TaskRecord, TaskStore } from '../store/store.js';
import type { ApprovalSupervisor } from './approval-supervisor.js';

/**
 * `signalTask` 的失败：带 HTTP 语义的状态码（404 = 任务不存在，409 = 任务当前不在
 * `suspended` 状态 / 同 eventId 已投递）。形状与 `async.ts` 的 `TaskCancelError` 同款
 * （module 级 export，不进公共导出面）。
 */
export class TaskEventError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'TaskEventError';
    this.status = status;
  }
}

/**
 * `deliveredEventIds` 簿记的条数上限（FIFO 裁最旧）。它是**去重簿记**不是审计日志：
 * 256 条对「webhook 重试窗口」绰绰有余，而无界增长会让每条 TaskRecord 随事件量膨胀
 * （记录随 trace 一起落库，每次 save 全文重写）。「数量有界」不是用户旋钮，不进
 * `core/limits.ts` 的 0 语义表。
 */
const MAX_DELIVERED_EVENT_IDS = 256;

/**
 * `pendingEvents`（待注入事件缓冲）的**条数上限**（2026-09-28 复审第三轮，定案 **B**）。
 *
 * 为什么要有：`deliveredEventIds` 那侧是有界的（256），缓冲这侧原先没有 —— 而它不需要攻击者
 * 就能长：投方每次投一条、这条 run 每次都在恢复段**再次挂起**（再挂起出口刻意不注入事件，
 * 见 spec §10 ⑥ 第 4 条）⇒ 每条都留在记录上，而记录随 trace 一起落库、每次 save 全文重写。
 *
 * 为什么是「满了拒绝」而不是「丢最旧」（A 的反面）：缓冲**在下次跑通时就注入并清空**，所以
 * 上限只管「一个挂起窗口里能攒多少」。丢最旧必须**同时**把该 id 从 `deliveredEventIds` 摘掉，
 * 否则发件方重投会拿到「已投递」的 409 而事件其实已经没了 —— 那是最坏的一种谎。宁可不收下
 * 并说出来（调用方拿到 409 就能改主意：先让这条 run 真走起来）。
 *
 * 为什么是 64：一个挂起窗口里等到的输入，量级与 `deliveredEventIds` 的重试窗口（256）同类，
 * 取它的 1/4 —— 容得下真实的 webhook 突发（一次重试窗口里几十条），又不足以把挂起任务当队列灌。
 * **数量有界不是用户旋钮**（与 MAX_DELIVERED_EVENT_IDS 同档），不进 `core/limits.ts` 的 0 语义表。
 */
const MAX_PENDING_EVENTS = 64;

/** `SignalSupervisor` 的注入依赖（全部由 `AsyncRunner` 构造时提供） */
export interface SignalSupervisorDeps {
  store: TaskStore;
  /** 恢复执行时写进记录的宿主标识（投递成功要 `rec.ownerId = ownerId`） */
  ownerId: string;
  /** 挂起读数的除名口（投递成功 = 「醒来」那一刻，读数纪律②） */
  approvals: ApprovalSupervisor;
  /** 派发入口（`AsyncRunner.#dispatch`：停机闸 + 唯一派发点 + 停机窗口里的一次告警） */
  dispatch(rec: TaskRecord): void;
  /**
   * cancel 的 per-task 在飞闸读数（2026-10-13 ref-run-root-close）：投递进入前等它收口再重判
   * （否则事件落库与 cancelled 落库互相覆盖，两边都说了假话）。
   * ⚠️ 必须在**入链之前**等：链尾一旦被 cancel 当成「在飞推进」等下去就是死等。
   */
  cancelInflight?(taskId: string): Promise<unknown> | undefined;
}

export class SignalSupervisor {
  /** 同一任务的在飞事件投递（`signalTask` 的重入闸，见下） */
  readonly #inflight = new Map<string, Promise<TaskRecord>>();

  readonly #deps: SignalSupervisorDeps;

  constructor(deps: SignalSupervisorDeps) {
    this.#deps = deps;
  }

  /**
   * 投递一个事件给**挂起**的任务（2026-09-28 ref-run-event-input，run 事件投入口；
   * `POST /tasks/:id/events` 的宿主方法侧，与 approve/cancel 对称）。
   *
   * 语义（设计稿 §3 逐条的落点）：
   * - **只对 `suspended` 生效**：不存在 ⇒ 404；其余状态（含已终态）⇒ 409
   *   （「不唤醒已终态」是这条状态闸的推论，与 approve 同款「状态不对要说出来」）；
   * - **幂等**：`eventId` 给定时按 `rec.deliveredEventIds` 去重，重复 ⇒ 409
   *   （簿记随记录落库，重启不丢；有界 FIFO，见 MAX_DELIVERED_EVENT_IDS）。
   *   不给 `eventId` 就**没有恰好一次**：重复投递 = 重复进历史（如实，不假装）；
   * - **投完即续跑**（两种挂起原因都算 —— 对 timer 挂起这就是「提前醒」）：
   *   事件进 `rec.pendingEvents`、状态回 `running`，**先落库再派发**
   *   （与 approve / 到期唤醒同一条纪律：崩在窗口里不能丢事件）。
   *   事件**不**直接追加进 `rec.spec.messages` —— 续跑判定只认历史末尾一条
   *   （`tailToolUses`），追加 user 消息会把续跑判成新对话；注入由引擎在
   *   未决 tool_use 解决之后做（见 engine/loop.ts 的 deliverTaskEvents）；
   * - **不沿旧 wakeAt**：记录上的旧目标时刻不动（闸都 gate 在 suspended 上，
   *   状态一翻它就失效）；醒来重跑那一批时工具若再次 `deferUntil`，
   *   `wakeAt` 由新回合重新落定；
   * - drain 期间**仍允许**（与 approve 同理由：挂起的任务只有外部输入能推进）。
   *
   * 并发闸与 approve **不同款**：approve 共享在飞那次（决定是幂等合并），事件**串行成链**
   * （两条并发事件是两条不同的输入，共享 = 静默丢一条）。与其它恢复路径
   * （approve / 到期唤醒，各有自己的闸）的竞速：进闸后重读再判挡住绝大多数；
   * 剩下的窄窗口与既有「approve × wakeDue 分闸」同类（那两条按挂起原因天然互斥，
   * 事件两种原因都适用，是这个闸新盖的缝 —— 已记在 spec §10 2026-09-28 ref-run-event-input）。
   */
  signalTask(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    // cancel 在飞 ⇒ 等它收口再重走一遍（2026-10-13 ref-run-root-close）。**入链之前**等：
    // 链尾会同步登记进 `#inflight`，cancel 侧的「等在飞推进」正等它 —— 进了链再等
    // cancel，就是两边互等的死锁。
    const settling = this.#deps.cancelInflight?.(taskId);
    if (settling) {
      return Promise.resolve(settling)
        .catch(() => undefined)
        .then(() => this.signalTask(taskId, event));
    }
    // 串行化（**不是** approve 那种「共享在飞那次」）：两个并发事件是**两条不同的输入**，
    // 共享在飞那次 = 后一条被静默丢掉；各自读-改-写而不互斥 = 双派发（与 resumePending
    // 的重入闸同一个 bug 类）。排成链：前一次落库完，这一次进闸后重读再判
    // （那时若已派发则状态是 running ⇒ 409 如实说出来，调用方可重试）。
    const prev = this.#inflight.get(taskId);
    const run = Promise.resolve(prev)
      .catch(() => undefined) // 前一次的 reject 已由它自己的调用方接走，这里只排队
      .then(() => this.#signalInner(taskId, event))
      .finally(() => {
        // 只摘自己：链上可能已有更新的节点（无条件 delete 会摘掉别人的）
        if (this.#inflight.get(taskId) === run) this.#inflight.delete(taskId);
      });
    this.#inflight.set(taskId, run);
    return run;
  }

  /** 该任务上在飞的事件投递链尾（cancel 的等待依据，2026-10-13 ref-run-root-close） */
  inflightFor(taskId: string): Promise<TaskRecord> | undefined {
    return this.#inflight.get(taskId);
  }

  async #signalInner(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    const rec = await this.#deps.store.get(taskId);
    if (!rec) throw new TaskEventError(404, `task 不存在: ${taskId}`);
    if (rec.status !== 'suspended') {
      throw new TaskEventError(
        409,
        `task ${taskId} 当前状态为 ${rec.status}，只有挂起的任务能接收事件`,
      );
    }
    // 幂等去重（先判再改）：重复 ⇒ 409，记录一个字节不动（与 cancel 的「已终态」同款）
    if (event.eventId !== undefined && rec.deliveredEventIds?.includes(event.eventId)) {
      throw new TaskEventError(409, `事件 ${event.eventId} 已投递给 task ${taskId}（重复投递）`);
    }
    // 缓冲上限（2026-09-28 复审第三轮，定案 B：满了**说出来**，不静默丢）。
    // 判据次序 状态 ⇒ 幂等 ⇒ 容量：重复投递的那条本来就在缓冲里，报「重复投递」比报「满了」有用;
    // 两种 409 的**区别必须让调用方看得见** —— 重复投递是「已经在里面了」，满了是「没收下」。
    if ((rec.pendingEvents?.length ?? 0) >= MAX_PENDING_EVENTS) {
      throw new TaskEventError(
        409,
        `task ${taskId} 的待注入事件已达上限（${MAX_PENDING_EVENTS} 条）—— ${
          rec.suspendedReason === 'approval'
            ? '这条在等人工审批，而让它跑起来的唯一触发源是 approve（不在投递方手里）⇒ 要么等人批，要么 cancel 后重新提交'
            : '这条在等定时到点（approve 对它不适用）—— 到点它会自己醒来，缓冲里的事件在醒来那段注入；等不了就 cancel 后重新提交'
        }；本次事件**没有**被记录。`,
      );
    }
    rec.pendingEvents = [...(rec.pendingEvents ?? []), event];
    if (event.eventId !== undefined) {
      const ids = [...(rec.deliveredEventIds ?? []), event.eventId];
      rec.deliveredEventIds =
        ids.length > MAX_DELIVERED_EVENT_IDS
          ? ids.slice(ids.length - MAX_DELIVERED_EVENT_IDS)
          : ids;
    }
    rec.status = 'running'; // 由 #executeInner 接管（acquireSlot → 恢复执行）
    rec.ownerId = this.#deps.ownerId;
    // 先落库再派发 —— 与 approve 同一条真纪律：save 失败就绝不恢复执行
    // （落不了库的事件不算投递：崩在窗口里会丢事件）。调用方拿到 reject，重试即可。
    await this.#deps.store.save(rec);
    // 离开挂起态（读数纪律②）：事件到了这就是「醒来」那一刻 —— 与 approve 的决定齐了同形
    this.#deps.approvals.unmarkSuspended(taskId);
    // 派发走唯一入口（闸在 #dispatch 里）：停机窗口里不派发，事件留在 pendingEvents 上，
    // 下次启动的 resumePending 认领时注入。
    this.#deps.dispatch(rec);
    return { ...rec };
  }
}
