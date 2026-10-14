/**
 * 到期唤醒的**纯判定** + 挂起读数 —— durable timer（2026-09-28 ref-suspend-state-reason 的 timer 侧）。
 *
 * 从 AsyncRunner 里抽出来的第五个协作件（slot-pool → approval-policy → drain-gate →
 * resume-policy → 这里），与 `approval-policy.ts` 是**明确的一对**：挂起的两个原因各有一套闸，
 * 各自一个纯文件。为什么非要分开写：C 之前「挂起」是一个状态兼职两件事
 * （`awaiting_approval` 既等人也等时刻），于是 `approvalTimeoutMs` 会去叫醒一条在等时刻的 run
 * （而且 `#expireAndResume` 紧接着就重派 —— 补不出任何决定也照样开跑）。
 * 两个原因的判据分开成两个具名函数之后，「谁管谁」在调用点一眼可见，也各有单测。
 *
 * 纯的边界：入参不变则结果不变；不碰 store、不改 rec、不派发、不起定时器。
 */
import type { SuspendedReason } from '../core/run.js';
import type { TaskRecord } from '../store/store.js';

/**
 * 到点了吗（时间挂起）。
 *
 * - 两条判据缺一不可：状态是 `suspended` **且**原因是 `timer`（原因那一半是 C 定的口径 ——
 *   没有它，等审批的挂起会被到期扫描按「`wakeAt` 缺失」判成不到点，看着像对，其实是
 *   **恰好**躲过；等时刻的挂起则会被审批那条闸叫醒）；
 * - `wakeAt` 缺失 ⇒ 永远不到点：**不**拿 `createdAt` / `startedAt` 之类退化（与
 *   `approvalExpired` 的取舍相反）—— 「不知道它什么时候醒」和「现在就该醒」是两件事，
 *   猜错的方向是**提前开跑**，代价是真实副作用；
 * - 边界是**不晚于现在**（`wakeAt <= now`）：到点即可唤醒。与 `approvalExpired` 的严格大于
 *   相反，两个闸的语义本来就不同 —— 超时是「等够了没」（恰好等于还没够），
 *   到期是「到点了没」（恰好等于就到了）。
 */
export function timerDue(rec: TaskRecord, now: number): boolean {
  return (
    rec.status === 'suspended' &&
    rec.suspendedReason === 'timer' &&
    rec.wakeAt !== undefined &&
    rec.wakeAt <= now
  );
}

/** 一条挂起记录的读数 —— AsyncRunner 只留「原因 + 目标时刻」，不持有整条记录 */
export interface SuspendedEntry {
  reason: SuspendedReason;
  wakeAt: number | undefined;
}

/** `/healthz` 的 `suspended` 段 */
export interface SuspendedSummary {
  /** 等人工决定的条数 */
  approval: number;
  /** 等一个时刻的条数 */
  timer: number;
  /** 最早的目标时刻（epoch ms）；一条时间挂起都没有 ⇒ **`null`**（不是 `0`） */
  nextWakeAt: number | null;
}

/**
 * 把挂起的条目收成读数。口径写在调用方（`AsyncRunner.suspendedSummary`）：只数**本进程**
 * 看得见的记录 —— 与 `inFlight` 同一张表，不假装是全局面（跨进程合并看板是聚合方的事）。
 *
 * `nextWakeAt` 给 `null` 而不是 `0`：`0` 在 JSON 里是一个**合法时刻**（1970 年），
 * 监控端拿它算 `nextWakeAt - now` 会得到一个巨大的负数，看着像「早就该醒却没人醒」。
 */
export function summarizeSuspended(entries: Iterable<SuspendedEntry>): SuspendedSummary {
  let approval = 0;
  let timer = 0;
  let nextWakeAt: number | null = null;
  for (const e of entries) {
    if (e.reason === 'approval') {
      approval++;
      continue;
    }
    timer++;
    if (e.wakeAt !== undefined && (nextWakeAt === null || e.wakeAt < nextWakeAt)) {
      nextWakeAt = e.wakeAt;
    }
  }
  return { approval, timer, nextWakeAt };
}
