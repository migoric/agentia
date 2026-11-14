/** awaitTask 的纯协调件：初始化结果、跨进程观察与终态等待不占用状态机主文件的体量。 */
import { isTerminalStatus } from '../core/run.js';
import { assertTimerDelay } from '../core/timeout.js';
import { cloneTaskRecord } from '../store/store.js';
import type { MaybePromise, TaskRecord } from '../store/store.js';
import { adoptObservedOutcome } from './submission.js';
import type { SubmissionInit } from './submission.js';

export interface AwaitTaskDeps {
  submissions: ReadonlyMap<string, Promise<SubmissionInit>>;
  poll(taskId: string): MaybePromise<TaskRecord | undefined>;
  wait(taskId: string, ms: number): Promise<void>;
}

export async function waitForTask(
  deps: AwaitTaskDeps,
  taskId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TaskRecord> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // NaN 会让 deadline 失效；intervalMs 也必须有限且为正，否则会退化成毫秒级轮询。
  assertTimerDelay(timeoutMs, 'AsyncRunner.awaitTask 的 timeoutMs');
  const intervalMs = opts.intervalMs ?? 250;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError(
      `AsyncRunner.awaitTask 的 intervalMs 必须是正的有限数（毫秒），收到 ${String(opts.intervalMs)}`,
    );
  }
  // 初始化可能决定本地终态，或改为跟随升级前那条随机 taskId 的活跃记录。
  const initializing = deps.submissions.get(taskId);
  let waitingId = taskId;
  let observed: TaskRecord | undefined;
  if (initializing) {
    const outcome = await initializing;
    if (outcome.action === 'done') return cloneTaskRecord(outcome.record);
    if (outcome.action === 'follow') {
      waitingId = outcome.targetId;
      observed = outcome.record;
    }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // poll 保留惰性审批超时 / 到期唤醒；事件唤醒为主，间隔只是跨进程兜底。
    const rec = await deps.poll(waitingId);
    if (!rec) throw new Error(`task 不存在: ${waitingId}`);
    if (isTerminalStatus(rec.status)) {
      if (observed && waitingId !== taskId) {
        // 旧随机 id 已终态，还要等观察趟把映射后的本次记录落库。
        const mapped = await deps.poll(taskId);
        if (mapped && isTerminalStatus(mapped.status)) return mapped;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`task ${taskId} 等待超时（映射落库中）`);
        await deps.wait(taskId, Math.min(intervalMs, left));
        continue;
      }
      return observed ? cloneTaskRecord(adoptObservedOutcome(observed, rec)) : rec;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`task ${taskId} 等待超时（${rec.status}）`);
    await deps.wait(waitingId, Math.min(intervalMs, left));
  }
}
