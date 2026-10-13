/**
 * Agentia —— 审批监督：HITL 挂起登记簿（读数）+ 在飞闸 + `approve` + 审批超时恢复。
 *
 * 从 `async.ts` 的 `AsyncRunner` 抽出的**方向正交**的一块（外部深评结构体检的建议②）。
 * 它管的是「谁挂着、谁在等审批、审批超时了没」，与「认领 / 槽位 / 派发 / 执行」不是
 * 一个方向 —— 而抽之前它被私字段（`#suspended` / `#inflightApprovals`）与私有方法缝在
 * 1554 行的 `AsyncRunner` 里，横跨 5 处外部调用点（`cancel` / `signalTask` / 到期唤醒 /
 * `resumePending` 扫描 / `#executeInner` 的挂起与终态出口）+ 对外 getter。
 *
 * **零行为变化**：本文件是对原成员的**逐字搬迁** + 依赖改为构造注入。判据、分支顺序、
 * 错误类型、副作用次序（先落库再派发）一字未改。
 *
 * 为什么 `dispatch` 用**回调注入**而不是 import `async.ts`：`#dispatch` 是 `AsyncRunner`
 * 的私有方法（停机闸 + 唯一派发入口 + 一次性告警），审批簇只**消费**它，不该拥有它、
 * 也不该复制一份。注入让依赖保持单向（审批 → 派发），同时避免模块循环。
 *
 * ⚠️ `TaskApproveError` / `ApprovalDecisions` 随本簇迁到这里；`async.ts` 仍 **re-export**
 * 它们 ⇒ `http-endpoints.ts` / `http-shapes.ts` 的 import 路径不变。
 */
import { approvalExpired, approvalsComplete, fillTimeoutDenials } from './approval-policy.js';
import { summarizeSuspended } from './wake-policy.js';
import type { SuspendedEntry, SuspendedSummary } from './wake-policy.js';
import { isThenable } from '../store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../store/store.js';

/** `approve` 的入参：一批 tool_use_id → 批准/拒绝（理由可选） */
export type ApprovalDecisions = Record<string, { approved: boolean; reason?: string }>;

/**
 * `approve` 的失败：带 HTTP 语义的状态码（404 = 任务不存在，409 = 任务当前不在
 * `suspended` 状态），HTTP 宿主据此回对应响应。
 * module 级 export —— 不进公共导出面（纯宿主内部实现细节）。
 */
export class TaskApproveError extends Error {
  /** 400 = 入参语义不合法（decisions 里有本任务待决之外的 id，2026-09-28 深评 P1-2） */
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'TaskApproveError';
    this.status = status;
  }
}

/** `ApprovalSupervisor` 的注入依赖（全部由 `AsyncRunner` 构造时提供） */
export interface ApprovalSupervisorDeps {
  store: TaskStore;
  /** 恢复执行时写进记录的宿主标识（`approve` / 超时恢复都要 `rec.ownerId = ownerId`） */
  ownerId: string;
  /** 审批超时的毫秒数（0 = 不限）。已由 `AsyncRunner` 构造期校验为「≥ 0 的有限数」 */
  approvalTimeoutMs: number;
  /** 派发入口（`AsyncRunner.#dispatch`：停机闸 + 唯一派发点 + 停机窗口里的一次告警） */
  dispatch(rec: TaskRecord): void;
  /**
   * cancel 的 per-task 在飞闸读数（2026-10-13 ②）：approve 进入前等它收口再重判；
   * 惰性超时恢复见它即**跳过本轮**（惰性路径下一轮还会再判，跳过不丢）。
   * 与 `#inflight` 互为对侧：两侧的「查对方闸 + 登记自己闸」在同一个同步段 ⇒ 先登记者赢。
   */
  cancelInflight?(taskId: string): Promise<unknown> | undefined;
}

export class ApprovalSupervisor {
  /**
   * **本进程可见的挂起读数**（`/healthz` 的 `suspended` 段，配套 6）。
   *
   * 口径与 `inFlight` 同一张表：只数**本进程**经手的挂起 —— 跨进程要合并看板请自己聚合，
   * 不假装是全局面（别的进程挂起的记录这里看不见，重启后由首次扫描对齐，见下）。
   *
   * 三条维护纪律（这条读数的唯一风险是**漂移**，所以每条出口都要写清）：
   * ① 进挂起时登记（`#executeInner` 的挂起分支，与落库同一个分支）；
   * ② 离开挂起时除名（`approve` / 两条恢复路径 / 终态分支）；
   * ③ **每次 `resumePending` 扫描按 store 重建**（`rebuild`）—— 扫描本来就 `list()` 了全表，
   *    顺手对齐即可，把「漏了某个出口」从永久漂移降级成「下一次扫描前的偏差」。
   *
   * 为什么不留成 store 查询（每次 /healthz 扫全表）：`/healthz` 是探针端点（秒级频率），
   * 而 `list()` 要把**每条记录的完整 trace**取出来（sqlite/redis 下是全部反序列化）——
   * 拿它当健康检查的代价比它回答的问题大得多。
   */
  readonly #suspended = new Map<string, SuspendedEntry>();

  /** 同一任务的在飞审批（`approve` 的重入闸）。**与惰性超时恢复共用同一把闸** ——
   *  `approve` 与超时恢复都会「填决定 + 落库 + 派发」，不互斥就是同一任务跑两遍。 */
  readonly #inflight = new Map<string, Promise<TaskRecord>>();

  readonly #deps: ApprovalSupervisorDeps;

  constructor(deps: ApprovalSupervisorDeps) {
    this.#deps = deps;
  }

  /** 挂起读数：按原因分组的条数 + 最早的目标时刻（无时间挂起时为 `null`） */
  get summary(): SuspendedSummary {
    return summarizeSuspended(this.#suspended.values());
  }

  /** 登记一条挂起（纪律①）。原因缺失的记录不进表 —— 分不了组，宁可少数也不猜一个原因出来 */
  markSuspended(rec: TaskRecord): void {
    if (rec.status !== 'suspended' || rec.suspendedReason === undefined) return;
    this.#suspended.set(rec.taskId, { reason: rec.suspendedReason, wakeAt: rec.wakeAt });
  }

  /** 除名（纪律②）：任务离开挂起态时调用（恢复、终态都算） */
  unmarkSuspended(taskId: string): void {
    this.#suspended.delete(taskId);
  }

  /**
   * 按 store 的**全表**重建挂起集（读数纪律③）—— `resumePending` 扫描时调用。
   * 扫描本来就 `list()` 了全表，顺手把读数对齐一遍；顺带把**他进程**（或本进程上一世）
   * 留下的挂起也算进本进程可见的那些（口径见 `summary` 的注释）。
   */
  rebuild(recs: TaskRecord[]): void {
    this.#suspended.clear();
    for (const rec of recs) {
      if (rec.status !== 'suspended' || rec.suspendedReason === undefined) continue;
      this.#suspended.set(rec.taskId, { reason: rec.suspendedReason, wakeAt: rec.wakeAt });
    }
  }

  /**
   * 惰性审批超时：`approvalExpired` 为真 ⇒ 进在飞闸 + 自动全拒 + 落库 + 派发。返回是否命中。
   *
   * 与原 `#lazyGates` / `#redispatch` 里那两句 `if (approvalExpired(...)) #expireAndResume(...)`
   * **逐字等价** —— `approvalExpired` 内部已判 `status === 'suspended'` 与
   * `reason === 'approval'`（见 approval-policy.ts），所以 `#redispatch` 原写法里那句额外的
   * `rec.status !== 'suspended'` 短路是冗余的，合并到本方法不改变任何可观测行为。
   */
  expireIfExpired(rec: TaskRecord, now: number): boolean {
    if (!approvalExpired(rec, now, this.#deps.approvalTimeoutMs)) return false;
    // cancel 在飞 ⇒ 跳过本轮（2026-10-13 ②）：它马上把任务落成终态，超时恢复再来一脚
    // 就是「取消后照常执行」那条竞态。惰性路径不丢事：下一轮读还会再判（若取消没成）。
    if (this.#deps.cancelInflight?.(rec.taskId)) return false;
    this.#expireAndResume(rec, now);
    return true;
  }

  /**
   * 审批一个处于 `suspended` 的任务（HITL）。
   *
   * - **逐 tool_use_id 幂等**：已存在的决定不覆盖（第一次决定赢）—— 重复提交 /
   *   并发点击不会推翻已有决定，也不会让恢复段重复执行；
   * - **并发重入共享在飞那次**：同一任务的并发 approve（双击「批准」/两个审批人
   *   同时批）返回同一个 Promise —— 否则两个调用都在对方落库前读到
   *   `suspended`、各自判「决定齐了」、**各派发一次**（同一任务重复执行，
   *   与 resumePending 的闸门同一 bug 类）。被共享的那次覆盖不到的决定不丢：
   *   调用方从返回的记录看到任务仍在等待，重试即并入；
   * - 决定齐了就恢复：`status` 回 `running`、**先落库再派发**（与 `#redispatch`
   *   同一条纪律 —— 没落库就恢复，进程崩在窗口里会丢决定）；恢复段带着
   *   `rec.approvals` 与扩展后的消息历史（`rec.spec.messages`，末尾是含未决
   *   tool_use 的那条 assistant 消息）重进引擎循环；
   * - 决定**没**齐：只把本批决定落库，任务继续等（可能多轮审批）；
   * - 返回当前 TaskRecord（快照）。任务不存在抛 404 语义、状态不对抛 409 语义
   *   的 `TaskApproveError`。
   */
  async approve(
    taskId: string,
    decisions: ApprovalDecisions,
    opts: { decidedBy?: string } = {},
  ): Promise<TaskRecord> {
    // cancel 在飞 ⇒ 等它收口再重走一遍（2026-10-13 ②）：否则两边各凭旧快照落库，
    // 后写的那一份把 cancelled 覆盖成 running —— 任务取消后照常执行、webhook 双发。
    // 检查必须在登记自己闸**之前**、且两者在同一同步段：先看对方、再登记，先登记者赢。
    const settling = this.#deps.cancelInflight?.(taskId);
    if (settling) {
      await settling.catch(() => undefined);
      return this.approve(taskId, decisions, opts);
    }
    const inflight = this.#inflight.get(taskId);
    if (inflight) return inflight;
    const run = this.#approveInner(taskId, decisions, opts).finally(() => {
      this.#inflight.delete(taskId);
    });
    this.#inflight.set(taskId, run);
    return run;
  }

  /** 该任务上在飞的审批/超时恢复（cancel 的等待依据，2026-10-13 ②） */
  inflightFor(taskId: string): Promise<TaskRecord> | undefined {
    return this.#inflight.get(taskId);
  }

  async #approveInner(
    taskId: string,
    decisions: ApprovalDecisions,
    opts: { decidedBy?: string },
  ): Promise<TaskRecord> {
    const rec = await this.#deps.store.get(taskId);
    if (!rec) throw new TaskApproveError(404, `task 不存在: ${taskId}`);
    if (rec.status !== 'suspended' || rec.suspendedReason !== 'approval') {
      throw new TaskApproveError(
        409,
        rec.status === 'suspended'
          ? `task ${taskId} 的挂起原因是 ${rec.suspendedReason ?? '未知'}，只有等人工审批的挂起能审批`
          : `task ${taskId} 当前状态为 ${rec.status}，只有挂起在等审批的任务才能审批`,
      );
    }
    const now = Date.now();
    // 入参校验（2026-09-28 外部深评 P1-2）：本批只许批**本任务待决的** id。
    // 不校验会怎样（实证：一次 approve 塞 5000 个无关键 ⇒ 记录从 246 字节撑到 419 KB）：
    // 多出来的键照样写进 `rec.approvals`、随每次 save 全文重写落库、并随任务**永久保留**
    // （终态也不清：审批记录是审计的一部分）⇒ 一个**认证调用方**单次请求就能把记录撑大，
    // 反复调用可无限叠加。拒整批而不是挑着收：与 `parseApproveBody`（形状全有或全无）、
    // `parseEventBody`（多一个字段即拒）同一条纪律 —— 调用方本来就该从记录的 `pendingApprovals`
    // 里读要批哪些 id。
    // ⚠️ 为什么**不需要**再给 `rec.approvals` 加常量上限：单次 approve 能新写的键 ⊆ 当前
    // `pendingApprovals`（挂起那一刻固定）。跨多轮挂起它会累计**历次**待决的并集
    // （决定是审计，终态也保留），但每一轮都对应真跑出来的模型回合与 tool_use ——
    // 调用方的单次输入无法放大体积，增长只能随真实运行发生。再加常量上限是一段
    // 永远触发不到的死代码（那不是护栏，是噪音）。
    const pendingIds = new Set(rec.pendingApprovals ?? []);
    const unknownIds = Object.keys(decisions).filter((id) => !pendingIds.has(id));
    if (unknownIds.length > 0) {
      throw new TaskApproveError(
        400,
        `decisions 里有 ${unknownIds.length} 个 id 不在本任务的待决列表里（如 ${unknownIds[0]}）—— 整批拒掉，记录不动`,
      );
    }
    rec.approvals ??= {};
    for (const [id, d] of Object.entries(decisions)) {
      if (rec.approvals[id]) continue; // 逐 id 幂等：第一次决定赢
      rec.approvals[id] = {
        approved: d.approved,
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
        ...(opts.decidedBy !== undefined ? { decidedBy: opts.decidedBy } : {}),
        decidedAt: now,
        ...(rec.suspendedSince !== undefined ? { requestedAt: rec.suspendedSince } : {}),
      };
    }
    // 惰性审批超时：人的决定先并入（先到先赢），仍空着的待决项由超时兜底成 deny
    if (approvalExpired(rec, now, this.#deps.approvalTimeoutMs)) fillTimeoutDenials(rec, now);
    const complete = approvalsComplete(rec);
    if (complete) {
      rec.status = 'running'; // 由 #executeInner 接管（acquireSlot → 恢复执行）
      rec.ownerId = this.#deps.ownerId;
    }
    // 先落库再派发 —— **真纪律，不是注释**：save 失败（同步抛 / 异步 reject）就
    // 绝不恢复执行（落不了库的决定不算决定：进程崩在窗口里会丢决定，重启后把
    // 同一件事再判一次、可能改判）。调用方拿到 reject，重试即可。
    await this.#deps.store.save(rec);
    if (complete) {
      // 离开挂起态（读数纪律②）：决定齐了这就是「醒来」那一刻
      this.unmarkSuspended(taskId);
      // 派发走**唯一入口**（闸在 #dispatch 里判一次 —— 2026-09-28 外部深评 P1-1 的结构性修法）：
      // 决定已经在记录里，停机窗口里放行的是「重新排期」（下次启动认领），不是「吞掉」。
      this.#deps.dispatch(rec);
    }
    return { ...rec };
  }

  /**
   * 惰性超时扫描（HITL）：读到一个已超时的 awaiting 任务 ⇒ 自动全拒 + 落库 + 重派。
   * 与 #redispatch 同一条纪律：**先落库再派发**（没落库就恢复，进程崩在窗口里会
   * 丢掉超时决定、把同一件事再判一次）。
   *
   * 重入闸（2026-09-20，见 spec §10 当日条）：与 `approve` **共用同一把** per-taskId
   * 闸（`#inflight`）。异步 store 的 `get` 返回**新副本**且有网络往返 —— 两个
   * 并发 poll（或 poll 与 approve）各自看到 awaiting 快照 ⇒ 双双填超时拒绝 + 双双
   * `#execute`（同一任务跑两遍）。在飞即跳过：另一路径自己会兜底（`#approveInner`
   * 里也有 approvalExpired 判定，见 approval-policy.ts），决定逐 id 幂等（第一次决定赢）。
   * 反之 approve 撞上在飞的超时恢复时共享其结果 —— 与人的决定竞速，先到先得。
   */
  #expireAndResume(rec: TaskRecord, now: number): void {
    if (this.#inflight.has(rec.taskId)) return;
    const run = this.#expireAndResumeInner(rec, now).finally(() => {
      this.#inflight.delete(rec.taskId);
    });
    this.#inflight.set(rec.taskId, run);
    // poll / resumePending 路径没有调用方接 reject —— 订阅掉，不得逃逸成 unhandled rejection
    run.catch(() => undefined);
  }

  async #expireAndResumeInner(rec: TaskRecord, now: number): Promise<TaskRecord> {
    // 进闸后**重读一遍**再判：闸只互斥「进入」，挡不住「进闸前已取到的旧副本」——
    // 本记录的快照可能是在另一次恢复落库**之前**取的（异步 store 的 get 有往返），
    // 凭陈旧快照放行会把同一任务再派发一次。
    const fresh = await this.#deps.store.get(rec.taskId);
    const target = fresh ?? rec;
    if (
      target.status !== 'suspended' ||
      !approvalExpired(target, now, this.#deps.approvalTimeoutMs)
    ) {
      return target;
    }
    fillTimeoutDenials(target, now);
    target.status = 'running';
    target.ownerId = this.#deps.ownerId;
    let saved: MaybePromise<void>;
    try {
      saved = this.#deps.store.save(target);
    } catch (err) {
      // 同步落库失败则不派发（先落库再派发）—— 但绝不能**静默**留尸：
      // 任务会停在 suspended 直到下一次惰性判定，没人知道它失败过。
      console.warn(
        `[agentia] 审批超时恢复落库失败（task ${target.taskId}），本次不派发:`,
        (err as Error)?.message ?? err,
      );
      return target;
    }
    if (isThenable(saved)) {
      // 落库失败则不派发（认领没落地就派发 = 重新打开重复执行窗口）
      try {
        await saved;
      } catch (err) {
        console.warn(
          `[agentia] 审批超时恢复落库失败（task ${target.taskId}），本次不派发:`,
          (err as Error)?.message ?? err,
        );
        return target;
      }
    }
    // 离开挂起态（读数纪律②）—— 落在**落库成功之后**：落不了库就不算恢复（没派发，读数也不动）
    this.unmarkSuspended(target.taskId);
    // 派发走唯一入口（闸在 #dispatch 里）。⚠️ **这一条正是外部深评抓到的第四条路径**：
    // `#expireAndResume`（审批超时自动全拒并恢复）与 `approve` 不同触发源、同一形状，
    // 由 `poll()` 的惰性闸驱动 —— 而「停机中照常可轮询」是 HTTP 宿主的明确承诺
    // （LB / K8s preStop / 前端轮询）⇒ 停机后照样能起新 run。
    this.#deps.dispatch(target);
    return target;
  }
}
