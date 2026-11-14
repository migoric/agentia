/**
 * 异步 store 的首次提交协调。
 *
 * 无原子能力的 store 保留「查旧 succeeded → save 新记录」的旧路径；有 claimSubmission 的
 * store 则由同一个确定性 taskId 的主键仲裁。输掉认领的执行趟只观察既有任务，不进槽位、
 * 不调用 app，也不重复发 TaskSink。数据库错误可能发生在服务端提交之后，因此绝不能再用
 * 一次无条件 save 把失败快照盖到真正的认领者上。
 */
import { isTerminalStatus } from '../core/run.js';
import { classifyError } from '../engine/errors.js';
import { cloneTaskRecord } from '../store/store.js';
import type { TaskRecord, TaskStore } from '../store/store.js';
import { ownerAlive } from './owner-liveness.js';
import { adoptSucceededOutcome } from './run-call-options.js';

export type SubmissionInit =
  | { action: 'execute'; record: TaskRecord }
  | { action: 'follow'; record: TaskRecord; targetId: string }
  | { action: 'done'; record: TaskRecord };

export interface SubmissionContext {
  store: TaskStore;
  rec: TaskRecord;
  existing: Promise<TaskRecord | undefined>;
  safeSave(rec: TaskRecord, phase: 'initial' | 'outcome'): Promise<void>;
  report(rec: TaskRecord, error: unknown, phase: 'initial' | 'outcome'): void;
}

/**
 * 跟随期间「目标记录连续读不到」的容忍次数（约 750ms）。
 *
 * 为什么不是一读到就放弃：跨副本读可能落后于认领者的写入（只读副本 / Redis 从节点），
 * 一次读空不等于记录不存在。为什么不是无限容忍：记录真的被 TTL / prune 回收之后，
 * 「等终态」这件事永远不会有结果 —— 那又是一个占着 `active` 的幽灵。
 */
const MISSING_TOLERANCE = 3;

const done = (record: TaskRecord): SubmissionInit => ({ action: 'done', record });
const follow = (record: TaskRecord, targetId: string): SubmissionInit => ({
  action: 'follow',
  record,
  targetId,
});

export async function initializeSubmission(ctx: SubmissionContext): Promise<SubmissionInit> {
  const { rec, store } = ctx;
  if (store.claimSubmission === undefined) return initializeLegacy(ctx);
  const expected = cloneTaskRecord(rec);
  try {
    const existing = await ctx.existing;
    if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
      if (existing.status === 'succeeded') {
        // 同确定性 taskId 就直接对齐整份终态；升级前的随机 taskId 保留旧的结果映射。
        if (existing.taskId === rec.taskId) Object.assign(rec, cloneTaskRecord(existing));
        else adoptSucceededOutcome(rec, existing);
        await ctx.safeSave(rec, 'outcome');
        return done(rec);
      }
      return follow(rec, existing.taskId);
    }
    return (await store.claimSubmission(rec))
      ? { action: 'execute', record: rec }
      : follow(rec, rec.taskId);
  } catch (error) {
    return reconcileClaimError(ctx, expected, error);
  }
}

/** 旧 store 的语义原样保留：失败时允许尽力落一条 failed，不启动可能重复的 run。 */
async function initializeLegacy(ctx: SubmissionContext): Promise<SubmissionInit> {
  const { rec } = ctx;
  try {
    if (adoptSucceededOutcome(rec, await ctx.existing)) {
      await ctx.safeSave(rec, 'outcome');
      return done(rec);
    }
    await ctx.store.save(rec);
    return { action: 'execute', record: rec };
  } catch (error) {
    if (rec.status === 'queued' && rec.finishedAt === undefined) {
      rec.status = 'failed';
      rec.error = classifyError(error);
      rec.finishedAt = Date.now();
      await ctx.safeSave(rec, 'initial');
    }
    return done(rec);
  }
}

/**
 * claim 抛错不代表没写入。先用「认领前完整快照」做 CAS：只有本进程那条 queued 真已落库时，
 * 才能把它改成 failed；CAS 失败说明记录已被别人推进，转为观察。无条件 save 在这里是禁止项。
 */
async function reconcileClaimError(
  ctx: SubmissionContext,
  expected: TaskRecord,
  error: unknown,
): Promise<SubmissionInit> {
  const { rec, store } = ctx;
  rec.status = 'failed';
  rec.error = classifyError(error);
  rec.finishedAt = Date.now();
  let current: TaskRecord | undefined;
  try {
    current = await store.get(rec.taskId);
  } catch (readError) {
    ctx.report(rec, readError, 'initial');
    return done(rec);
  }
  if (current !== undefined && store.compareAndSave !== undefined) {
    try {
      if (await store.compareAndSave(rec, expected)) {
        ctx.report(rec, error, 'initial');
        return done(rec);
      }
      return follow(rec, current.taskId);
    } catch (saveError) {
      ctx.report(rec, saveError, 'initial');
      return done(rec);
    }
  }
  // 读不到记录，或 store 没有安全纠正这次歧义写入的 CAS：只给本次等待者返回本地失败，
  // 不伪造一条可能覆盖其他认领者的耐久记录。
  ctx.report(rec, error, 'initial');
  return done(rec);
}

/**
 * 跟随其他进程的任务；读抖动只上报并重试，不升级成一次可能覆盖它的失败写入。
 *
 * **有界退出**（2026-11-14 复核）：这个循环此前是纯粹的无上限轮询 —— 认领者进程崩掉、
 * 又没人调 `resumePending` 时，跟随趟会永久占着 `active`：`drain()` 永不结算（SIGTERM 后
 * 被编排层硬杀），`inFlight` 读数虚高（`maxConcurrentRuns` 的 503 闸被幽灵任务占着）。
 * `shouldStop` 是那个出口：返回**原因**字符串即放弃跟随（返回 `undefined` 表示继续等）。
 *
 * 判据必须来自**直接证据**，不能来自时间：任务可以在别的进程正常跑几个小时（HITL 审批），
 * 「等太久」不是「没人推进」。调用方给的两条判据都是这种性质 —— 主人进程明确已死
 * （`owner-liveness` 的 `ESRCH`）、或本进程正在 drain。跨主机判不了活，那种场景仍靠
 * `resumePending` 解套（`docs/multi-replica.md` 的部署前提）。
 *
 * ⚠️ 放弃**不等于失败**：目标任务仍归认领者，本进程既不落库也不发 TaskSink
 * （调用方负责把它登记进「别处的活」），只把本地这一趟收干净。伪造一条 failed
 * 会覆盖真正的认领者（同确定性 taskId 时是同一条记录）。
 */
export async function waitForObserved(
  ctx: Pick<SubmissionContext, 'store' | 'rec' | 'report'>,
  targetId: string,
  wait: (taskId: string, ms: number) => Promise<void>,
  shouldStop?: (current: TaskRecord) => string | undefined,
): Promise<TaskRecord | undefined> {
  let readFailed = false;
  /** 连续读到「记录不存在」的次数（判据见下面那一支） */
  let missing = 0;
  for (;;) {
    let current: TaskRecord | undefined;
    try {
      current = await ctx.store.get(targetId);
    } catch (error) {
      if (!readFailed) ctx.report(ctx.rec, error, 'outcome');
      readFailed = true;
      await wait(targetId, 250);
      continue;
    }
    readFailed = false;
    if (current === undefined) {
      // 记录**明确不存在**（`get` 没抛错）：等不到终态了 —— 它可能被 TTL / prune 回收，
      // 也可能从来没落库。留 3 次（约 750ms）容忍「认领者刚提交、本进程读的是只读副本」
      // 的复制延迟；再读不到就放弃，否则这又是一个永久挂着的跟随趟。
      if (++missing >= MISSING_TOLERANCE) {
        console.warn(`[agentia] 放弃跟随任务 ${targetId}：记录已不存在（被清理，或从未落库）`);
        return undefined;
      }
      await wait(targetId, 250);
      continue;
    }
    missing = 0;
    if (isTerminalStatus(current.status)) return current;
    const reason = shouldStop?.(current);
    if (reason !== undefined) {
      console.warn(`[agentia] 放弃跟随任务 ${targetId}：${reason}`);
      return undefined;
    }
    await wait(targetId, 250);
  }
}

/** 把观察到的终态映射回本次提交；升级前的随机 taskId 不改写本次输入与创建时间。 */
export function adoptObservedOutcome(rec: TaskRecord, observed: TaskRecord): TaskRecord {
  if (observed.taskId === rec.taskId) {
    Object.assign(rec, cloneTaskRecord(observed));
    return rec;
  }
  rec.status = observed.status;
  rec.runId = observed.runId;
  rec.result = observed.result;
  rec.usageTotal = observed.usageTotal;
  rec.error = observed.error;
  rec.finishedAt = observed.finishedAt ?? Date.now();
  return rec;
}

/** 跟随一趟需要的宿主能力（AsyncRunner 提供；本文件不碰 runner 内部状态） */
export interface FollowDeps {
  store: TaskStore;
  wait: (taskId: string, ms: number) => Promise<void>;
  report: (rec: TaskRecord, error: unknown, phase: 'initial' | 'outcome') => void;
  saveOutcome: (rec: TaskRecord) => Promise<void>;
  /** 登记为「别处的活」：本进程此后不为它发 TaskSink（两种结局都要登记） */
  observed: (rec: TaskRecord) => void;
  /** 放弃跟随后的流回收（空桩才能删，见 `TaskEventStreams.releaseUnwatched`） */
  abandonStream: (taskId: string) => void;
  /** 放弃判据，见 `followStopReason` */
  stopReason: (current: TaskRecord) => string | undefined;
}

/**
 * 一趟「跟随他进程认领」的完整收尾：等到终态 → 映射回本次提交；或按直接证据放弃。
 *
 * 两种结局都不发 TaskSink、不伪造 failed：任务归认领者，本进程只是一个观察窗口。
 */
export async function followClaim(
  rec: TaskRecord,
  deps: FollowDeps,
  targetId: string,
): Promise<void> {
  const terminal = await waitForObserved(
    { store: deps.store, rec, report: deps.report },
    targetId,
    deps.wait,
    deps.stopReason,
  );
  deps.observed(rec);
  if (terminal === undefined) {
    // 放弃：**不落库**（同确定性 taskId 时那是同一条记录，写 failed 就覆盖真正的认领者）
    deps.abandonStream(rec.taskId);
    return;
  }
  adoptObservedOutcome(rec, terminal);
  if (terminal.taskId !== rec.taskId) await deps.saveOutcome(rec);
}

/**
 * 放弃跟随的默认判据。两条都是**直接证据**，没有一条是「等太久了」——任务可以在别的
 * 进程正常跑几小时（HITL 审批），时间不是「没人推进」的证据。
 *
 * - 本进程正在 drain：不再替别人等（否则 SIGTERM 后的 drain 永不结算）；
 * - 同主机且那个 pid 已不在（`owner-liveness` ⇒ `false`）：认领者进程崩了，跨主机判不了
 *   活（`undefined`）时继续等 —— 那类孤儿归部署层的 `resumePending`。
 */
export function followStopReason(
  current: TaskRecord,
  env: { host: string; draining: boolean; probe?: typeof ownerAlive },
): string | undefined {
  if (env.draining) return '本 runner 已进入 drain，不再替别的进程等';
  if (current.ownerId === undefined) return undefined;
  const alive = (env.probe ?? ownerAlive)(current.ownerId, env.host);
  return alive === false
    ? `认领者进程已不在（${current.ownerId}），需要 resumePending 重新派发`
    : undefined;
}
