import { assertTimerDelay } from '../core/timeout.js';

/**
 * 优雅停机的**等待闸** —— 从 AsyncRunner 里抽出的第三个协作件（slot-pool → approval-policy → 这里）。
 *
 * 为什么单独成件：drain 是「不再往前推」而不是「丢弃」——它有三条独立语义，混在 900 行的类里
 * 只能透过宿主行为间接观察：
 *   ① **进停机态必须最先发生**：标志一置，`submit` 立刻拒绝（宿主回 503），不能等到排空之后；
 *   ② **等待的预算**：`timeoutMs <= 0` = 一直等；超时返回 `false` —— 此时**不动在飞计数、
 *      不唤醒等待者**，但 `draining` **保持置位**（它是一次性闩，没有复位路径）。所以 `false`
 *      的含义是「本进程此后不再推进任何任务 ⇒ 宿主必须退出」，未完成的任务留在 store、
 *      下次启动 `resumePending` 续跑。⚠️ 别把这条读成「`false` 之后还能继续服务」——
 *      那样停机窗口里已落库的记录会停在 `running` 且**本进程内没有自愈路径**
 *      （`own-process` 跳过认领 / `submit` 已关），PR #164 复核 §1 有探针实证；
 *   ③ **唤醒只由归零触发**：非空闲时调用是空操作，归零时唤醒**所有**等待者。
 *
 * 「在飞计数」本身**不搬**：它同时是 `/healthz` 的 `inFlight` 口径、由任务生命周期加减，
 * 不属于等待闸 —— 所以这里以谓词 `idle: () => boolean` 传入，闸只负责「等 / 唤醒 / 超时」。
 */
export class DrainGate {
  private draining = false;
  private readonly waiters: Array<() => void> = [];

  /** 是否已进入停机态（HTTP 宿主据此对新单回 503） */
  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * 进入停机态并等排空：`idle()` 已为真立刻返回 true；否则挂起，直到 `signalIdle(idle)`
   * 唤醒（true）或预算耗尽（false）。`timeoutMs <= 0` = 一直等。
   */
  async waitForIdle(idle: () => boolean, timeoutMs: number): Promise<boolean> {
    this.draining = true; // 必须最先置位：新单要立刻被挡住，而不是等到排空之后
    // 等待预算的坏值先挡（NaN / 超 2^31-1ms，见 core/timeout.ts 的 assertTimerDelay）。
    // 为什么这里必须挡：超上限的预算 Node **不会遵守**（stderr 一行警告后钳到 1ms），
    // 于是「等 30 天排空」变成「1ms 后返回 false」—— 而 `false` 对宿主的语义是
    // 「本进程此后不再推进任何任务、必须退出」（见类头注释与 AsyncRunner.drain 的契约），
    // 静默地拿到它代价很高。非正数不在此列：`<= 0` = 「一直等」是既有合法读法。
    // 置于 draining 置位**之后**：校验抛错也要先把停机态立住，否则新单还会被接进来。
    assertTimerDelay(timeoutMs, 'DrainGate.waitForIdle 的 timeoutMs（drain 等待预算）');
    if (idle()) return true;
    let waiter: (() => void) | undefined;
    const drained = new Promise<boolean>((resolve) => {
      waiter = () => resolve(true);
      this.waiters.push(waiter);
    });
    if (timeoutMs <= 0) return drained;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        drained,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          // ⚠️ 不 unref：`drain()` 返回的正是这个 false —— 计时器的触发就是「调用方的 await 得以结束」
          // 的条件。unref 过它 ⇒ 空事件循环下进程先退出，停机等待没有任何结论
          // （见 `tests/timeoutLiveness.test.ts` 与 spec §10 ④）。
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // 超时返回后把等待者摘掉（与 TaskWaiters.wait 的 finish 同款）：否则每次
      // `drain({timeoutMs})` 超时都留下一个永不 resolve 的闭包（2026-11-07 深评 F9）。
      // 已由 signalIdle 唤醒的 waiter 已被 splice 掉，这里按引用 indexOf 幂等。
      if (waiter !== undefined) {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      }
    }
  }

  /** 计数归零时调用：唤醒**所有**等待者。非空闲或无人等待时是空操作（可无脑调用） */
  signalIdle(idle: () => boolean): void {
    if (!idle() || this.waiters.length === 0) return;
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const w of waiters) w();
  }

  /** 当前在等排空的调用方数量（单测与诊断用） */
  get waiterCount(): number {
    return this.waiters.length;
  }
}
