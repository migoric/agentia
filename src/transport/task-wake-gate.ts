/**
 * 每条任务的**唤醒互斥闸**（approve / signalTask / 审批超时 / 到期唤醒共用）。
 *
 * 为什么需要它（2026-11-07 深度评审 P1）：四条唤醒路径各自有「在飞闸」，但**互不登记、互不查看**。
 * `approve` 与 `wakeDue` 靠挂起原因天然互斥；而 `signalTask` 对两种挂起原因都放行 ⇒
 * `approve × signalTask`、`wakeDue × signalTask` 可以并发。两边都先 `get` 到同一份 suspended
 * 快照，再各自 `status='running'` + `save` + `dispatch` ⇒ 同一任务被 `#execute` 两次，
 * 后写的那份记录还可能把已完成的段覆盖回 suspended、丢掉审批决定。
 *
 * 语义：**同一 taskId 上，进入本闸的唤醒路径串行**。最后一个登记的 tail 会在它及其之前
 * 所有路径收口后才 resolve，所以 `cancel` 只要 `await gate.tail(taskId)` 就能等到
 * 「此刻已登记的全部唤醒」—— 不需要知道它具体是 approve 还是 signal。
 *
 * 与各监督件自己的 `#inflight` 的关系：那些闸仍保留（approve 的「并发重入共享同一次」
 * 语义依赖它；signal 的事件串行链也依赖它），本闸只负责**跨路径**互斥。两边在同一同步段
 * 登记，先登记者赢。
 *
 * 纯件：不碰 store、不认识记录，只做「同一 key 的 Promise 串行」。单测见
 * `tests/transport/task-wake-gate.test.ts`。
 */
export class TaskWakeGate {
  /**
   * 每个 taskId 的**队列尾**。它 resolve 的条件是「本路径之后才登记的路径也都已完成」，
   * 因此它同时可当 `cancel` 的等待句柄。
   */
  readonly #tails = new Map<string, Promise<unknown>>();

  /** 该任务上是否已有登记（排队中或执行中）——惰性路径据此跳过本轮 */
  busy(taskId: string): boolean {
    return this.#tails.has(taskId);
  }

  /** 该任务上全部已登记路径的收口 Promise；没有则为 undefined */
  tail(taskId: string): Promise<unknown> | undefined {
    return this.#tails.get(taskId);
  }

  /**
   * 串行执行：前一条（若存在）收口后才开始 `fn`。
   *
   * `fn` 的同步前段（第一个 await 之前）在**调用者的同步段**里执行 —— 与不加闸时
   * 的时序一致，既有「进闸后立刻重读」的测试不会因为多了一个微任务而变味。
   */
  async run<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(taskId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // tail 必须把 gate 串在 prev 之后：等待者拿到 tail 时，等待的是「这条路径也结束」。
    const tail = prev === undefined ? gate : prev.catch(() => undefined).then(() => gate);
    this.#tails.set(taskId, tail);
    if (prev !== undefined) await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      // 只摘自己：若后面又排了新的 tail，留给它自己摘（无条件 delete 会摘掉别人的）。
      if (this.#tails.get(taskId) === tail) this.#tails.delete(taskId);
    }
  }
}
