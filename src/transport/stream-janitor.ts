/**
 * 跨进程 SSE 流的**兜底收口**（2026-11-07 深评 F5）。
 *
 * 本进程的 `TaskEventStreams.markDone` 只覆盖「本进程把任务写到终态」；任务在**别的进程**
 * 被 approve / 到期唤醒并跑完时，本进程那条流既没有 `push` 也没有 `markDone`，只剩心跳。
 * 这个纯件做低频 store 轮询：终态 → 交给调用方 markDone（由 onDone 发 end）；
 * 记录消失 / 已换主 → 发流级 closed。
 *
 * 不碰 store、不认识 trace：poll / isTerminal / markDone 都以回调注入，单测可直接驱动。
 */
export interface StreamJanitorDeps {
  poll: () => Promise<{ ownerId?: string | undefined } | undefined>;
  isTerminal: (rec: { ownerId?: string | undefined }) => boolean;
  /** 本进程 ownerId */
  ownerId: string;
  /** 任务已终态：调用方负责 markDone（终态帧由既有 onDone 发） */
  onTerminal: () => void;
  /** 任务记录消失 / 后续段在别的进程：发流级 closed 并收口 */
  onClosed: () => void;
  /** 轮询间隔（毫秒）；<= 0 = 关闭 */
  pollMs: number;
}

/** 启动轮询；返回清理函数（幂等）。 */
export function createStreamJanitor(deps: StreamJanitorDeps): () => void {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
  };
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* 收口回调自己的错不得变成 unhandled（观测不击穿业务） */
    }
  };
  const check = (): void => {
    if (closed) return;
    let polling: Promise<{ ownerId?: string | undefined } | undefined>;
    try {
      polling = Promise.resolve(deps.poll());
    } catch {
      // 同步 store（已 close）的 poll 可能同步抛：定时器回调里逃出去就是 uncaughtException。
      return;
    }
    void polling.then(
      (rec) => {
        if (closed) return;
        if (rec === undefined) {
          safe(deps.onClosed);
          cleanup();
          return;
        }
        if (deps.isTerminal(rec)) {
          safe(deps.onTerminal);
          cleanup();
          return;
        }
        if (rec.ownerId !== undefined && rec.ownerId !== deps.ownerId) {
          safe(deps.onClosed);
          cleanup();
        }
      },
      () => {
        /* store 暂时读不动：下一拍再试，不拿观测路径打死宿主 */
      },
    );
  };
  if (deps.pollMs > 0) {
    timer = setInterval(check, deps.pollMs);
    timer.unref?.();
  }
  return cleanup;
}
