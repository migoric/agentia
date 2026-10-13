/**
 * Agentia —— 恢复扫描：`resumePending()` 的那一次扫描全流程。
 *
 * 一次扫描按顺序干四件事（顺序是有语义的，不是巧合）：
 *   ① **重建挂起读数**（`approvals.rebuild`）—— 扫描本来就 `list()` 了全表，顺手对齐；
 *   ② **催审批超时**（`approvals.expireIfExpired`）—— 到点的 awaiting 自动全拒 + 重派；
 *   ③ **唤醒到期**（`wakeDue`）—— 在睡且到点的 timer 挂起 ⇒ 认领 + 重派；
 *   ④ **认领重投**（`#redispatch` 尾部）—— 孤儿记录（他进程留下的 / 本进程上一世的）续跑。
 *
 * 从 `async.ts` 的 `AsyncRunner` 抽出的方向正交的一块（外部深评结构体检的建议④「恢复重投」）。
 * 它管的是「**谁在等 · 等到了没 · 该不该由我来捡**」，与「认领之后怎么跑」（`#execute`/
 * `#executeInner`）和「跑起来怎么派发」（`#dispatch`）都不是一个方向。
 *
 * **零行为变化**：逐字搬迁 + 依赖改为构造注入。判据、分支顺序、返回值语义、副作用次序
 * （先落库再派发）一字未改。
 *
 * 为什么 `dispatch` / `isDraining` 用**回调注入**而不是 import `async.ts`：见
 * `approval-supervisor.ts` 头注（`#dispatch` 与 drain 闸都归 `AsyncRunner`，本件只消费它们，
 * 不该拥有、也不该复制一份）。
 *
 * ⚠️ `ResumePendingOptions` 随本簇迁到这里；`async.ts` 仍 **re-export** 它 ⇒
 * `src/index.ts` 的公共导出面不变。
 */
import { isThenable } from '../store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../store/store.js';
import { timerDue } from './wake-policy.js';
import { resumeSkipReason } from './resume-policy.js';
import { ownerAlive } from './owner-liveness.js';
import type { ApprovalSupervisor } from './approval-supervisor.js';

/** resumePending 的启动扫描选项 */
export interface ResumePendingOptions {
  /**
   * 他进程任务的判定开关；缺省 0 = 不判断，一律重派（重启即续跑，单进程旧语义）。
   *
   * `> 0` 时按**两档**判他进程的记录（判据在 `resume-policy.ts`，这里只说取舍）：
   * ① 记录里的主机名是本机 ⇒ **问 pid 还在不在**（`owner-liveness.ts`）——
   *    「主人在」的直接证据：**在的绝不抢**（不管它起跑多久），**不在的立刻可抢**
   *    （不等保鲜期，崩溃孤儿不会饿死）；
   * ② 判不了（异主机 / 升级前写下的旧格式 ownerId / 自定义串）⇒ 退回本参数名义上的
   *    那件事：`startedAt`（退化到 `createdAt`）距今不足该值就当他还在跑、先别抢。
   *
   * ⚠️ ②只是**启发式**（「记录看起来还新」），不是租约：单进程部署建议 0；多进程共库
   * 时它只是「问不到 pid」时的兜底，别再指望它单独把「重复执行」挡住。
   * 阈值取值要大于「一个进程从启动到跑满一条记录」的合理时间，否则长跑会被抢。
   */
  staleAfterMs?: number;
}

/** `ResumeScanner` 的注入依赖（全部由 `AsyncRunner` 构造时提供） */
export interface ResumeScannerDeps {
  store: TaskStore;
  /** 认领时写进记录的宿主标识（`resumePending` 靠它区分他我） */
  ownerId: string;
  /** 本机主机名（`ownerAlive` 判 pid 存活时用；见 `owner-liveness.ts`） */
  host: string;
  /** 挂起登记簿（扫描第①②步：重建读数、催审批超时） */
  approvals: ApprovalSupervisor;
  /** 派发入口（`AsyncRunner.#dispatch`：停机闸 + 唯一派发点 + 停机窗口里的一次告警） */
  dispatch(rec: TaskRecord): void;
  /** 停机闸读数（`wakeDue` 的配套 5：drain 之后不唤醒，见 `drain-gate.ts`） */
  isDraining(): boolean;
  /**
   * cancel 的 per-task 在飞闸读数（2026-10-13 ②）：到期唤醒见它即**跳过本轮**
   * （惰性路径下一轮还会再判；cancel 会把任务落终态，唤醒就是「取消后照常执行」）。
   */
  cancelInflight?(taskId: string): Promise<unknown> | undefined;
}

export class ResumeScanner {
  /**
   * 在飞的 `resumePending`（重入闸，见 `resumePending` 的注释）。
   * 不用 boolean 而用 Promise：重入方要拿到**同一次扫描**的结果，而不是一个「你等着」的空数。
   */
  #inflightResume: Promise<number> | null = null;

  /** 在飞的到期唤醒（同一任务的重入闸，理由与审批那条同款 —— 见 `approval-supervisor.ts` 的 `#inflight`：两条路径都「落库 + 派发」）。 */
  readonly #inflightWakes = new Map<string, Promise<TaskRecord>>();

  readonly #deps: ResumeScannerDeps;

  constructor(deps: ResumeScannerDeps) {
    this.#deps = deps;
  }

  resumePending(opts: ResumePendingOptions = {}): number | Promise<number> {
    // 重入闸：**并发**调用共享同一次扫描的结果，而不是各自再扫一遍。
    //
    // 为什么必须（2026-09-18 补）：「先落库再派发」只堵住了**串行**重扫 —— 认领是异步的
    // （异步 store 的 `list()` 返回反序列化的**新对象**），两个并发调用都在任一 `save`
    // 落地前 `list()` 到旧快照，`ownerId === this.ownerId` 的过滤对两份旧快照**双双失效**
    // ⇒ 同一个任务被派发两次（`app.run` 重复执行，副作用与花费翻倍）。
    //
    // 语义：闸门期间返回**在飞那次的 Promise**（同一个数），而不是 0 —— 0 会谎称
    // 「没派发任何东西」，而实际上派发了。调用方拿到的始终是本次扫描的真实结果。
    if (this.#inflightResume) return this.#inflightResume;
    const listed = this.#deps.store.list();
    const staleAfterMs = opts.staleAfterMs ?? 0;
    // 到期索引（2026-09-28 ⑤ 落地）：store 实现了 `listDue` 时，「到期唤醒」那一半的
    // 输入走索引（只回到期的记录），否则回退全表过滤 —— 语义不变，只是扫描规模不同。
    // ⚠️ 它**只**替代那一半的输入：挂起读数重建 / 审批超时 / 孤儿认领的职责
    // 仍是全表 `list()`（它们要的不只是「到期的」），别把整个扫描的输入源换掉。
    const dueListed =
      this.#deps.store.listDue === undefined ? undefined : this.#deps.store.listDue(Date.now());
    if (isThenable(listed) || (dueListed !== undefined && isThenable(dueListed))) {
      const run = Promise.all([listed, dueListed])
        .then(([recs, due]) => this.#redispatch(recs, staleAfterMs, due))
        .finally(() => {
          this.#inflightResume = null;
        });
      this.#inflightResume = run;
      return run;
    }
    const dispatched = this.#redispatch(listed, staleAfterMs, dueListed);
    if (isThenable(dispatched)) {
      const run = Promise.resolve(dispatched).finally(() => {
        this.#inflightResume = null;
      });
      this.#inflightResume = run;
      return run;
    }
    return dispatched;
  }

  /**
   * 到期唤醒（durable timer）：读到一条**在睡且到点**的挂起 ⇒ 认领 + 重派，醒来后重跑那一批。
   *
   * 与 `approval-supervisor.ts` 的 `#expireAndResume` 逐条同形（进在飞闸、重读一遍、先落库再派发），
   * 理由一字不差；三处不同，都写在下面：drain 之后不唤（配套 5）、不填任何决定（时间挂起没有待决项）、
   * 以及**返回值**（见下）。
   *
   * 公开而非私有：**两个调用点**都要用它 —— 全表扫描（`resumePending` 的 `#redispatch`）与
   * 读路径（`AsyncRunner.#lazyGates`，`poll()` 的惰性闸）。
   *
   * @returns 是否真的接管了这次唤醒 —— decline 时 `false`。`resumePending` 的返回值是
   * 「我推进了几条」，把没推进的算进去就是谎报（drain 之后每次扫描都报「唤醒了 N 条」，
   * 而它们一条都没动）。⚠️ 审批那条（`approval-supervisor.ts` 的 `#expireAndResume`）计数口径略宽（在飞也计入），
   * 那是既有行为、本批不动它。
   */
  wakeDue(rec: TaskRecord, now: number): boolean {
    // 配套 5（drain 后不唤醒）：停机是「不再往前推」，与 submit 在 drain 后回 503 同一条纪律。
    // 不设这道闸，一条天级的 sleeping run 会在停机窗口里被叫起来接着跑 —— 部署卡在它身上。
    // （重启后由新进程的首次 resumePending 唤醒：那时停机窗口早过去了。）
    if (this.#deps.isDraining()) return false;
    // cancel 在飞 ⇒ 跳过本轮（2026-10-13 ②）：它马上把任务落终态，唤醒就是「取消后照常执行」。
    // 惰性路径跳过不丢事：下一轮读还会再判（若取消没成）。
    if (this.#deps.cancelInflight?.(rec.taskId)) return false;
    if (this.#inflightWakes.has(rec.taskId)) return false;
    const run = this.#wakeDueInner(rec, now).finally(() => {
      this.#inflightWakes.delete(rec.taskId);
    });
    this.#inflightWakes.set(rec.taskId, run);
    // poll / resumePending 路径没有调用方接 reject —— 订阅掉，不得逃逸成 unhandled rejection
    run.catch(() => undefined);
    return true;
  }

  /** 该任务上在飞的到期唤醒（cancel 的等待依据，2026-10-13 ②） */
  inflightWakeFor(taskId: string): Promise<TaskRecord> | undefined {
    return this.#inflightWakes.get(taskId);
  }

  /**
   * 重新派发前**必须**先把 `ownerId` 认领落库 —— 否则「认领」只是内存里的一个记号。
   *
   * 病灶：此前这里只改内存里的 `status`/`ownerId` 就 `void #execute(rec)`，真正的 save
   * 要等到 `#executeInner`（还在 `#acquireSlot` 之后）。对 sqlite/redis 这类 `list()`
   * 返回**反序列化新对象**的 store，这段窗口里再调一次 `resumePending()` 读到的仍是旧
   * ownerId，`:305` 的过滤失效 → 同一个任务被再派发一次 → `app.run` 重复执行，副作用
   * 与花费翻倍。`InMemoryTaskStore` 存的是对象引用，恰好掩盖了这个问题。
   *
   * 返回类型刻意保持 `number | Promise<number>`：同步 store 的 save 是同步的，认领当场
   * 落地，返回数字（`submit`/`list` 那套「同步 store 保持同步门面」的约定不变）；只有
   * 真出现 thenable 才升级成 Promise，等所有认领落库后再统一派发。
   */
  #redispatch(
    recs: TaskRecord[],
    staleAfterMs: number,
    due?: TaskRecord[] | undefined,
  ): number | Promise<number> {
    const now = Date.now();
    // 挂起读数的对齐（读数纪律③）：扫描本来就拿到了全表，顺手把 `/healthz` 的读数
    // 按 store 重建一遍 —— 于是「漏了某个除名出口」只是下一次扫描前的偏差，不会永久漂移。
    // 顺带把**他进程**（或本进程上一世）留下的挂起也算进本进程可见的那些（口径见
    // `approvals.summary` 的注释：本进程看得见的记录，不假装是全局面）。
    this.#deps.approvals.rebuild(recs);
    // 惰性审批超时扫描（HITL）：suspended **不捡走续跑**（它在等人，不是
    // 孤儿 —— 崩溃续跑语义不适用于「等审批」），但读到它时顺手判超时：
    // 到点自动全拒并重派（框架补的 deny 决定先进 store，再进引擎）。
    let expired = 0;
    for (const rec of recs) {
      if (this.#deps.approvals.expireIfExpired(rec, now)) expired++;
    }
    // 到期唤醒（durable timer）：在睡且到点的 timer 挂起 ⇒ 认领 + 重派（醒来重跑那一批）。
    // 与上面那条循环并列而不是合并：两条闸的**原因判据互斥**，各读各的一眼可见；
    // 合并成一个循环会让「谁的责任」藏进条件里。drain 之后不唤（`wakeDue` 里那道闸）。
    // 输入（2026-09-28 ⑤）：store 提供到期索引时 `due` 是「只回到期的」那一半 ——
    // 仍过 `timerDue` 复核（索引口径是 status+wakeAt，原因那一半由这里兜，且
    // `#wakeDueInner` 进闸后还会重读再判一次）。
    let woken = 0;
    for (const rec of due ?? recs) {
      if (!timerDue(rec, now)) continue;
      // 只算**真接管**的那些（drain / 已在飞 ⇒ 不算）—— 返回值是「推进了几条」的承诺
      if (this.wakeDue(rec, now)) woken++;
    }
    // 认领判定外移到 resume-policy.ts：跳过原因具名化（terminal / suspended / own-process /
    // owner-alive / too-fresh），每条规则与边界都由那份纯函数的单测钉住
    const alive = (id: string): boolean | undefined => this.#ownerLiveness(id);
    const pending = recs.filter(
      (r) =>
        resumeSkipReason(r, {
          ownerId: this.#deps.ownerId,
          staleAfterMs,
          now,
          ownerAlive: alive,
        }) === undefined,
    );

    const claims: Promise<boolean>[] = [];
    let claimed = 0;
    for (const rec of pending) {
      rec.status = 'queued'; // 重新入队，由 #execute 统一推进
      rec.ownerId = this.#deps.ownerId; // 认领：此后本进程的记录不再被（自己）重派
      // 同步抛错防护（2026-10-13 ③，与 #wakeDueInner 同款）：FileTaskStore 磁盘失败在这里
      // 同步抛出 —— 不接住就逃出 resumePending（宿主启动路径直接崩）。落不了库 = 没推进：
      // 不派发、不计入返回值；warn 出来（静默留尸的话任务搁死到重启都没人知道）。
      let saved: MaybePromise<void>;
      try {
        saved = this.#deps.store.save(rec);
      } catch (err) {
        console.warn(
          `[agentia] 认领落库失败（task ${rec.taskId}），本次不重投:`,
          (err as Error)?.message ?? err,
        );
        continue;
      }
      if (isThenable(saved)) {
        // 落库失败则**不派发**：认领没落地，派发等于把上面那个重复执行的窗口重新打开
        claims.push(
          Promise.resolve(saved).then(
            () => {
              this.#deps.dispatch(rec);
              return true;
            },
            (err: unknown) => {
              console.warn(
                `[agentia] 认领落库失败（task ${rec.taskId}），本次不重投:`,
                (err as Error)?.message ?? err,
              );
              return false;
            },
          ),
        );
      } else {
        // 派发走唯一入口（闸在 #dispatch 里）—— 外部深评 P2-1：认领循环以前绕过了那道闸。
        this.#deps.dispatch(rec);
        claimed++;
      }
    }
    const settled = Promise.all(claims).then((oks) => oks.filter(Boolean).length);
    if (claims.length === 0) return claimed + expired + woken;
    return settled.then((n) => claimed + n + expired + woken);
  }

  async #wakeDueInner(rec: TaskRecord, now: number): Promise<TaskRecord> {
    // 进闸后**重读一遍**再判（与 approval-supervisor.ts 的 #expireAndResumeInner 同因）：闸只互斥「进入」，
    // 挡不住「进闸前已取到的旧副本」——异步 store 的 get 有往返，凭陈旧快照放行会重复派发。
    const fresh = await this.#deps.store.get(rec.taskId);
    const target = fresh ?? rec;
    if (!timerDue(target, now)) return target;
    target.status = 'running';
    target.ownerId = this.#deps.ownerId;
    let saved: MaybePromise<void>;
    try {
      saved = this.#deps.store.save(target);
    } catch (err) {
      // 同步落库失败则不派发（先落库再派发）—— 但不静默：留尸到下一次惰性判定
      // 之前，至少日志里要有这一笔（与 #dispatch 停机拒绝的 warn 同一条纪律）。
      console.warn(
        `[agentia] 到期唤醒落库失败（task ${target.taskId}），本次不派发:`,
        (err as Error)?.message ?? err,
      );
      return target;
    }
    if (isThenable(saved)) {
      try {
        await saved;
      } catch (err) {
        console.warn(
          `[agentia] 到期唤醒落库失败（task ${target.taskId}），本次不派发:`,
          (err as Error)?.message ?? err,
        );
        return target;
      }
    }
    // 离开挂起态（读数纪律②）—— 落库成功之后才算醒来
    this.#deps.approvals.unmarkSuspended(target.taskId);
    // 派发走唯一入口（闸在 #dispatch 里判一次 —— 它同时盖住「进入时」与「窗口里刚进入停机」
    // 两个时点，这里不必再判一遍）。
    this.#deps.dispatch(target);
    return target;
  }

  /**
   * 「这条记录的主人还活着吗」—— 绑上本机主机名后的 pid 存活判定（见 `owner-liveness.ts`）。
   *
   * 只被 `#redispatch` 用，且只在 `staleAfterMs > 0` 时真正被问到（那道闸在 resume-policy
   * 里，单源；缺省 0 = 不看他进程，与升级前逐字一致）。判定不写库、不改状态 —— 纯读数。
   */
  #ownerLiveness(ownerId: string): boolean | undefined {
    return ownerAlive(ownerId, this.#deps.host);
  }
}
