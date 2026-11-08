/**
 * Agentia —— 中断信号合成（零依赖）。
 *
 * 一条 run 的中断可能来自多个源头：调用方显式传入、HTTP 客户端断开、
 * AsyncRunner 的 runTimeoutMs 超时、宿主停机。任一触发都应中止本次 run。
 *
 * Node 18 没有 `AbortSignal.any`，这里手写兜底（Node 20.3+ 才有）。
 */

/** 合成 signal → 其「摘除全部源监听器」的清理函数（仅 combineSignals 多源分支的产物在表内） */
const cleanups = new WeakMap<AbortSignal, () => void>();

/** 合成多个中断源：任一已中止 / 后中止即中止；忽略 undefined；全空返回**永不中止**的 signal。 */
export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  // 去重：同一个源被传两次时，下面的 listeners Map 按源建（后者覆盖前者），
  // 却对同一源挂了两个同名监听 ⇒ 摘除只摘掉一个，另一个（连闭包）滞留在宿主级
  // 长寿 signal 上 —— 正是这段代码要防的累积。Set 保序，行为不变。
  // 结构守卫（2026-11-07 深评）：持久化 store 反序列化回来的 signal 可能是 `{}`（旧记录），
  // 只判 undefined 会在 `s.addEventListener` 处抛 TypeError。不是合法 AbortSignal 就当没给。
  const real = [
    ...new Set(
      signals.filter(
        (s): s is AbortSignal =>
          s !== undefined &&
          typeof (s as { addEventListener?: unknown }).addEventListener === 'function',
      ),
    ),
  ];
  // 单源直接复用，避免多包一层 listener
  if (real.length === 1) return real[0];

  const ac = new AbortController();
  for (const s of real) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
  }
  if (!ac.signal.aborted) {
    // 每个源一个具名监听（存进 map 供摘除）：合成 signal 中止后，其余源上的监听器
    // 就再也没用 —— 不摘掉的话，宿主级共享 signal（长寿）每跑一条 run 多挂一个，
    // 累积 >10 触发 MaxListenersExceededWarning，闭包也跟着滞留。
    const listeners = new Map<AbortSignal, () => void>();
    const detach = (): void => {
      for (const [s, l] of listeners) s.removeEventListener('abort', l);
      listeners.clear();
      cleanups.delete(ac.signal);
    };
    for (const s of real) {
      const l = (): void => ac.abort(s.reason);
      listeners.set(s, l);
      s.addEventListener('abort', l, { once: true });
    }
    ac.signal.addEventListener('abort', detach, { once: true });
    cleanups.set(ac.signal, detach);
  }
  return ac.signal;
}

/**
 * run 正常收尾（没有任何源中止）时主动摘除 combineSignals 挂在各源上的监听器。
 * 对非 combineSignals 产物 / 已清理的 signal 幂等空操作。
 *
 * 模块级 export（不进公共面）：调用方（如 transport/async）在 run settle 后调用。
 */
export function releaseCombinedSignal(signal: AbortSignal): void {
  cleanups.get(signal)?.();
}
