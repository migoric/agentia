import { randomUUID } from 'node:crypto';
import type { AsyncRunner } from './async.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import { isThenable } from '../store/store.js';
import { zeroClauseOf } from '../core/limits.js';
import { MAX_TIMER_DELAY_MS } from '../core/timeout.js';

/**
 * Agentia —— 定时触发（spec §6.3 定时事件）。
 * 依赖 AsyncRunner：每次触发 = submit 一次异步任务。
 *
 * 周期任务去重：幂等键按 interval 窗口分片（同一片只算一次）；
 * 即便上一片还没跑完，下一片仍会重新 submit —— 同步 store 下若上一任务的同窗口键
 * 还在 queued/running/succeeded，AsyncRunner 的 at-least-once 去重会直接返回既有记录，
 * 同窗口不并发跑两遍；**异步 store 下该保证减弱**：submit 即时去重让位于执行前去重
 * （只采纳 succeeded），上一片仍 running 时新片可能并发执行 —— at-least-once 语义允许，
 * 窗口推进后新键正常执行。
 *
 * v1 提供 everyMs / at；cron 表达式解析后置（宿主可用队列 cron 替换语义）。
 */

/**
 * Node 定时器延迟的上限（`2^31-1`ms ≈ 24.86 天）**单源在 `core/timeout.ts`**。
 * 2026-09-28 上提：此前是这里自备一份而其余五处直喂 `setTimeout` 的站点无防线，
 * 于是「旋钮设了防、派生出来的等待没设防」。现在本文件的 every/at 与那五处
 * 共用同一常量与同一校验（`assertTimerDelay`）。
 */

interface Job {
  id: string;
  kind: 'every' | 'at';
  timer: ReturnType<typeof setTimeout>;
  intervalMs?: number | undefined;
  input: unknown;
  options?: RunInvocationOptions | undefined;
  source?: string | undefined;
  prefix?: string | undefined;
  /** 未到终态的已派发任务（仅 'every'）：用于 maxInFlight 闸门 */
  inFlight?: Set<string> | undefined;
  maxInFlight?: number | undefined;
}

export interface ScheduleEveryOptions {
  /** 任务级调用参数 */
  options?: RunInvocationOptions;
  /** 幂等键前缀；周期任务按 interval 窗口分片去重 */
  idempotencyPrefix?: string;
  /** 覆盖触发来源标记 */
  source?: string;
  /**
   * 同时未终态的任务数上限；缺省 1（上一片没跑完就跳过本次 tick）。
   * 没有它时 `every(1000)` + 60s 任务会每个 tick 都 submit 一次，任务无上限堆积。
   * 传 `Infinity` 关闭闸门（旧行为）。'at' 单发天然不受影响。
   */
  maxInFlight?: number;
}

export interface ScheduleHandle {
  id: string;
  cancel(): void;
}

export class Scheduler {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly runner: AsyncRunner) {}

  /** 周期触发（毫秒间隔）。首次触发在 intervalMs 之后。 */
  every(intervalMs: number, input: unknown, opts: ScheduleEveryOptions = {}): ScheduleHandle {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      // setInterval(0) 会退化成「尽快重复」的空转循环，把事件循环打满（Node 会把
      // 0 钳到 1ms 但仍是每毫秒一次的忙轮询）。这是配置错误，直接报错。
      // 文案里那句「0 = …」取自 limits 表（单一真源），不在这里各写一份。
      throw new Error(
        `Scheduler.every 的 intervalMs 必须为正有限数（${zeroClauseOf('Scheduler.every.intervalMs')}），收到 ${intervalMs}`,
      );
    }
    if (intervalMs > MAX_TIMER_DELAY_MS) {
      // Node 的定时器延迟是 32 位有符号整数：超过 2^31-1ms（约 24.86 天）**不会被遵守** ——
      // Node 只在 stderr 留一行 TimeoutOverflowWarning，随后把延迟钳到 1ms，周期任务退化成
      // 每毫秒空转（每个 tick 都对 store 打一轮）。这是配置错误，与上面的 0 同款处理。
      // （此前的注释写「runTimeoutMs 在 async.ts 有同款防线」—— 与当时的实现不符；
      // 2026-09-28 把那道防线真的补上了，五处站点现在都走 assertTimerDelay。）
      throw new Error(
        `Scheduler.every 的 intervalMs 超过定时器上限（约 24.86 天），收到 ${intervalMs}`,
      );
    }
    if (opts.maxInFlight !== undefined) {
      const m = opts.maxInFlight;
      // 闸门判据是 `inFlight.size >= maxInFlight`（dispatch 里），0 / 负数会让它**恒真**
      // ⇒ 每次 tick 都跳过，周期任务**既不跑也不失败**（实测 60ms 内派发 0 次、无任何
      // 报错/日志）。与 `AsyncRunner.concurrency` 同族，同款在构造期响亮失败。
      // ⚠️ 也**不能**在这里把它抬成 1：那等于替使用者改配置（旧 `Math.max(1, …)` 的教训）。
      // Infinity 合法（`Infinity > 0`）：闸门关闭（旧行为），见 ScheduleEveryOptions。
      if (typeof m !== 'number' || Number.isNaN(m) || m <= 0) {
        throw new TypeError(
          `maxInFlight 必须为正数（${zeroClauseOf('Scheduler.every.maxInFlight')}），收到 ${String(m)}`,
        );
      }
    }
    const id = randomUUID();
    const timer = setInterval(() => {
      const job = this.jobs.get(id);
      if (job) this.dispatch(job);
    }, intervalMs);
    if (typeof timer === 'object' && 'unref' in timer)
      (timer as ReturnType<typeof setTimeout>).unref?.();
    this.jobs.set(id, {
      id,
      kind: 'every',
      timer,
      intervalMs,
      input,
      options: opts.options,
      source: opts.source,
      prefix: opts.idempotencyPrefix,
      inFlight: new Set<string>(),
      maxInFlight: opts.maxInFlight ?? 1,
    });
    return { id, cancel: () => this.cancel(id) };
  }

  /** 单次触发（指定时刻）。 */
  at(when: Date, input: unknown, opts: ScheduleEveryOptions = {}): ScheduleHandle {
    if (!(when instanceof Date) || !Number.isFinite(when.getTime())) {
      // 非法日期 → delay 为 NaN → setTimeout(fn, NaN) 会立即触发且无任何提示
      throw new Error(`Scheduler.at 需要一个合法 Date（非 Invalid Date），收到 ${String(when)}`);
    }
    const id = randomUUID();
    const delay = Math.max(0, when.getTime() - Date.now());
    if (delay > MAX_TIMER_DELAY_MS) {
      // 与 every() 同款防线：超 2^31-1ms 的延迟**不会被遵守**（Node 只在 stderr 留一行
      // TimeoutOverflowWarning，然后把延迟钳到 1ms）⇒「30 天后」变成「立即触发」，
      // 定时语义直接作废。远期单发请拆成多次自检（或落库后由宿主自己的 cron 驱动）。
      throw new Error(
        `Scheduler.at 的目标时刻超过定时器上限（约 24.86 天后），收到 ${when.toISOString()}`,
      );
    }
    const timer = setTimeout(() => {
      const job = this.jobs.get(id);
      this.jobs.delete(id);
      if (job) this.dispatch(job);
    }, delay);
    // 与 every() 一致：定时器不阻止进程退出（宿主 stop() 仍可显式取消）
    if (typeof timer === 'object' && 'unref' in timer)
      (timer as ReturnType<typeof setTimeout>).unref?.();
    this.jobs.set(id, {
      id,
      kind: 'at',
      timer,
      input,
      options: opts.options,
      source: opts.source,
      prefix: opts.idempotencyPrefix,
    });
    return { id, cancel: () => this.cancel(id) };
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer as ReturnType<typeof setTimeout>);
    this.jobs.delete(id);
  }

  stop(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  get active(): number {
    return this.jobs.size;
  }

  /** 清掉已到终态的追踪项（异步 store 下 poll 返回 Promise，到货后再清） */
  private pruneInFlight(inFlight: Set<string>): void {
    const forget = (taskId: string) => inFlight.delete(taskId);
    for (const taskId of inFlight) {
      let rec: ReturnType<AsyncRunner['poll']>;
      try {
        rec = this.runner.poll(taskId);
      } catch (e) {
        // 同步 store 的 poll 可能**同步抛错**（如已 close 的 SqliteTaskStore ——
        // 停机顺序 store.close() 先于 scheduler.stop() 时）。这里逃出即定时器回调里的
        // uncaughtException → 崩宿主进程。与异步路径的 .catch 同口径：查不动就别再
        // 挡住后续 tick（否则闸门永久自锁）。
        forget(taskId);
        console.error(
          `[agentia:scheduler] 在飞任务 ${taskId} 状态查询失败`,
          (e as Error)?.message ?? e,
        );
        continue;
      }
      if (isThenable(rec)) {
        void rec
          .then((r) => {
            // suspended 也算「不再占执行资源」（在等人，不在跑）——
            // 不放手会让 maxInFlight 闸门永久自闭（人可能几小时后才批）
            if (!r || (r.status !== 'queued' && r.status !== 'running')) forget(taskId);
          })
          .catch(() => forget(taskId)); // 查不到就别再挡住后续 tick
        continue;
      }
      const r = rec as { status?: string } | undefined;
      if (!r || (r.status !== 'queued' && r.status !== 'running')) forget(taskId);
    }
  }

  private dispatch(job: Job): void {
    // drain 感知（2026-10-13 ref-submenu-name-check）：runner 停机后 submit 必抛「正在优雅停机」—— 不设这道闸，
    // 停机窗口里每个 tick 都换一条 console.error（纯刷屏；停机语义本来就是「不再往前推」，
    // 跳过 tick 不是故障，不报）。
    if (this.runner.isDraining) return;
    // maxInFlight 闸门（仅周期任务）：上一片还在跑就跳过本次 tick —— 否则
    // every(1000) + 60s 任务会每个 tick 都派发，任务无上限堆积。
    // Infinity = 闸门关闭：也不追踪（否则 inFlight 集合随 tick 无界增长）。
    const maxInFlight = job.maxInFlight ?? 1;
    const track = maxInFlight === Number.POSITIVE_INFINITY ? undefined : job.inFlight;
    if (track) {
      this.pruneInFlight(track);
      if (track.size >= maxInFlight) return;
    }
    // 'at' 单发：有 prefix 则用固定键（同次重复提交去重）；周期任务用窗口键
    const idempotencyKey = job.prefix
      ? job.kind === 'every'
        ? `${job.prefix}:${Math.floor(Date.now() / (job.intervalMs ?? 1))}`
        : job.prefix
      : undefined;
    try {
      const rec = this.runner.submit(job.input, {
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(job.options !== undefined ? { options: job.options } : {}),
        source: job.source ?? `schedule:${job.id.slice(0, 8)}`,
      });
      // 追踪未终态的派发（去重命中已有终态记录时不计入）
      if (track && (rec.status === 'queued' || rec.status === 'running')) {
        track.add(rec.taskId);
      }
    } catch (e) {
      // 调度触发不应崩掉宿主进程：入参非法等以 console 形式暴露
      console.error(`[agentia:scheduler] ${job.id} 触发失败`, (e as Error)?.message ?? e);
    }
  }
}
