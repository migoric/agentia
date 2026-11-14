/** 任务终态回调与落库故障上报：都只给快照，观测器自己的异常不得改变任务结果。 */
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
