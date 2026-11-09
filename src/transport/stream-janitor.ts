/**
 * 跨进程 SSE 流的**兜底收口**（2026-11-07 深评 F5；2026-11-09 深评 P2-1 提到 runner 级）。
 *
 * 本进程的 `TaskEventStreams.markDone` 只覆盖「本进程把任务写到终态」；任务在**别的进程**
 * 被 approve / 到期唤醒并跑完时，本进程那条流既没有 `push` 也没有 `markDone`，只剩心跳。
 * 这个纯件做低频 store 轮询：终态 → 交给调用方 markDone（由 onDone 发 end）；
 * 记录消失 / 已换主 → 发流级 closed。
 *
 * **为什么是「一组」而不是「一条流一个 janitor」**（P2-1）：此前每个 SSE 订阅各建一个
 * `setInterval`、每拍各 `store.get` 一次 —— N 个并发连接就是 N 个定时器 + N/5 QPS（SQLite 下
 * 是 N/5 次读锁），而 `unref()` 只保证不挂住进程、不减少读放大。同一个 taskId 的多个订阅
 * 本来该看**同一份**记录，现在由 runner 持有一个扫描器：一拍里每个**任务**只读一次 store，
 * 再把结论分发给该任务的各个订阅。单连接仍是「登记 / 注销」。
 *
 * 不碰 store、不认识 trace：poll / isTerminal / 收口都以回调注入，单测可直接驱动
 * （喂一个假 poll + 假计时，不碰真 store）。
 */

/** 轮询只需要这两个字段：本进程归属 + 是否终态（由 `isTerminal` 判） */
export interface StreamJanitorRecord {
  ownerId?: string | undefined;
}

/** 一条流的收口回调（同一任务的多个订阅各有一份） */
export interface StreamJanitorTarget {
  isTerminal: (rec: StreamJanitorRecord) => boolean;
  /** 任务已终态：调用方负责 markDone（终态帧由既有 onDone 发） */
  onTerminal: () => void;
  /** 任务记录消失 / 后续段在别的进程：发流级 closed 并收口 */
  onClosed: () => void;
}

export interface StreamJanitorGroupDeps {
  /** 读一条记录；同步 store 抛错、异步 store reject 都按「这一拍读不动，下一拍再试」处理 */
  poll: (taskId: string) => Promise<StreamJanitorRecord | undefined>;
  /** 本进程 ownerId */
  ownerId: string;
  /** 扫描间隔（毫秒）；<= 0 = 不启动定时器 */
  pollMs: number;
}

export interface StreamJanitorGroup {
  /** 登记一条流；返回注销函数（幂等） */
  add(taskId: string, target: StreamJanitorTarget): () => void;
  /** 停掉定时器并清空登记（runner 停机 / 测试收尾） */
  close(): void;
}

/** 启动（或复用）扫描器。定时器**有登记才存在**：没有订阅时零成本。 */
export function createStreamJanitorGroup(deps: StreamJanitorGroupDeps): StreamJanitorGroup {
  const targets = new Map<string, Set<StreamJanitorTarget>>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let ticking = false;

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const ensureTimer = (): void => {
    if (closed || timer !== undefined || deps.pollMs <= 0) return;
    timer = setInterval(() => void tick(), deps.pollMs);
    timer.unref?.();
  };

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* 收口回调自己的错不得变成 unhandled（观测不击穿业务） */
    }
  };

  /** 一拍只读一次 store：同任务的多个订阅共用这次结果 */
  const checkOne = async (taskId: string): Promise<void> => {
    const first = targets.get(taskId);
    if (first === undefined) return;
    let rec: StreamJanitorRecord | undefined;
    try {
      rec = await deps.poll(taskId);
    } catch {
      // 同步 store（已 close）的 poll 可能同步抛、异步 store 可能 reject：
      // 两种都按「这一拍读不动」处理 —— 定时器回调里逃出去就是 uncaughtException。
      return;
    }
    if (closed) return;
    // poll 期间流可能已经关掉 / 换主：重新取一次，别拿过期快照去调回调
    const live = targets.get(taskId);
    if (live === undefined) return;
    for (const target of [...live]) {
      if (!live.has(target)) continue;
      if (rec === undefined) {
        live.delete(target);
        safe(target.onClosed);
        continue;
      }
      if (target.isTerminal(rec)) {
        live.delete(target);
        safe(target.onTerminal);
        continue;
      }
      if (rec.ownerId !== undefined && rec.ownerId !== deps.ownerId) {
        live.delete(target);
        safe(target.onClosed);
      }
    }
    if (live.size === 0) targets.delete(taskId);
  };

  /** 扫描一拍。上一拍还没跑完（poll 慢）⇒ 跳过，不叠请求 */
  const tick = async (): Promise<void> => {
    if (closed || ticking || targets.size === 0) return;
    ticking = true;
    try {
      await Promise.all([...targets.keys()].map((taskId) => checkOne(taskId)));
    } catch {
      // 一拍里的意外不得外逃：`setInterval` 回调里的 rejection 就是 unhandledRejection
      // （Node ≥15 终止宿主）—— 观测路径不允许有这种出口。下一拍照常继续。
    } finally {
      ticking = false;
      if (targets.size === 0) stopTimer();
    }
  };

  return {
    add(taskId, target) {
      if (closed) return () => {};
      let set = targets.get(taskId);
      if (set === undefined) {
        set = new Set();
        targets.set(taskId, set);
      }
      set.add(target);
      ensureTimer();
      let removed = false;
      return () => {
        if (removed) return; // 幂等：调用方可能在连接关闭路径上重复调
        removed = true;
        const live = targets.get(taskId);
        if (live === undefined) return;
        live.delete(target);
        if (live.size === 0) targets.delete(taskId);
        // 最后一条流也走了 ⇒ 定时器不必再跑（下一个订阅到来时重新起）
        if (targets.size === 0) stopTimer();
      };
    },
    close() {
      closed = true;
      targets.clear();
      stopTimer();
    },
  };
}
