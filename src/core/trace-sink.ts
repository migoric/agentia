import type { Trace, TraceSink } from './trace.js';
import { TIMED_OUT, withTimeout } from './timeout.js';

/** 单个 sink 的默认等待上限；超时只放弃等待，不取消底层导出。 */
export const TRACE_SINK_TIMEOUT_MS = 10_000;

/**
 * 顺序投递 trace。抛错与超时都只告警，不击穿业务；后续 sink 仍照常接收。
 * module 级 export 供 runtime / MCP 反向桥共用，刻意不进公共导出面。
 */
export async function flushTraceSinks(
  sinks: readonly TraceSink[] | undefined,
  trace: Trace,
  timeoutMs = TRACE_SINK_TIMEOUT_MS,
): Promise<void> {
  if (!sinks || sinks.length === 0) return;
  for (const sink of sinks) {
    try {
      const delivery = Promise.resolve().then(() => sink.export(trace));
      const outcome = await withTimeout(delivery, timeoutMs);
      if (outcome === TIMED_OUT) {
        console.warn(
          `[agentia] trace sink 投递超时（${timeoutMs}ms），已放弃等待（不取消底层导出）`,
        );
      }
    } catch (e) {
      console.warn('[agentia] trace sink 投递失败:', e instanceof Error ? e.message : e);
    }
  }
}
