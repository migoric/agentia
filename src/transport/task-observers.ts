/** 任务终态回调与落库故障上报：都只给快照，观测器自己的异常不得改变任务结果。 */
import { classifyError } from '../engine/errors.js';
import { isThenable } from '../store/store.js';
import type { TaskRecord, TaskStore } from '../store/store.js';

export interface FinishSink {
  onFinished(rec: TaskRecord): void | Promise<void>;
}

export async function notifyTaskSinks(
  sinks: readonly FinishSink[],
  rec: TaskRecord,
): Promise<void> {
  if (sinks.length === 0) return;
  const snapshot = { ...rec };
  for (const sink of sinks) {
    try {
      await sink.onFinished(snapshot);
    } catch {
      /* 回调失败不影响任务状态 */
    }
  }
}

export function reportPersistError(
  onError:
    | ((info: { record: TaskRecord; error: unknown; phase: 'initial' | 'outcome' }) => void)
    | undefined,
  rec: TaskRecord,
  error: unknown,
  phase: 'initial' | 'outcome',
): void {
  if (!onError) return;
  try {
    onError({ record: { ...rec }, error, phase });
  } catch {
    /* 观测回调不得击穿 run */
  }
}

/** 同步抛错与异步 reject 都进同一上报口；Promise.resolve().then 把求值也纳入 try。 */
export async function saveTaskRecord(
  store: TaskStore,
  onError: Parameters<typeof reportPersistError>[0],
  rec: TaskRecord,
  phase: 'initial' | 'outcome',
): Promise<void> {
  try {
    await Promise.resolve().then(() => store.save(rec));
  } catch (error) {
    reportPersistError(onError, rec, error, phase);
  }
}

/**
 * 登记「这次提交的首次落库还没完成」，让 `awaitTask` 排在它后面。
 *
 * 为什么必需：`submit` 是**全同步**的（异步 store 的 `save` 只挂 `.catch`，不 await），
 * 所以对 PG / Redis 这类 store，「刚提交、还没落地」与「这个 taskId 根本不存在」在
 * `awaitTask` 的第一次 `poll` 里长得完全一样 —— 一个纯网络往返的竞态就会让调用方看到
 * 「task 不存在」（实测：PG 上同一份代码时通时不通）。`waitForTask` 拿到这条 promise
 * 先等它落地再开始轮询，两个状态就不再混淆。
 *
 * 顺带保留原有语义：初始 save 的**迟到** reject 不得覆写已经成功的终态（只把仍处于
 * `queued` 的记录改写成本地 `failed` 并重存一次）。
 */
export function trackFirstSave(
  registry: Map<string, Promise<void>>,
  store: TaskStore,
  onError: Parameters<typeof reportPersistError>[0],
  rec: TaskRecord,
): void {
  // 同步抛错**继续向 submit 的调用方冒泡**（HTTP 宿主据此回 500，而不是 202 一个
  // 永远查不到的任务）—— 这一层只接管异步落库的迟到结果，不改变同步失败的语义。
  const saved = store.save(rec);
  if (!isThenable(saved)) return;
  const landed = saved.then(
    () => undefined,
    (error: unknown) => {
      if (rec.status !== 'queued' || rec.finishedAt !== undefined) return;
      rec.status = 'failed';
      rec.error = classifyError(error);
      rec.finishedAt = Date.now();
      void saveTaskRecord(store, onError, rec, 'initial');
    },
  );
  registry.set(rec.taskId, landed);
  void landed.then(() => registry.delete(rec.taskId));
}
