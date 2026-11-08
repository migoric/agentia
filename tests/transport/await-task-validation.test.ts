import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner } from '../../src/transport/async.js';
import { InMemoryTaskStore } from '../../src/store/store.js';
import type { TaskRecord } from '../../src/store/store.js';

const app = {
  name: 'app',
  async run() {
    return {
      run: { runId: 'r', status: 'succeeded' as const },
      result: {
        stopReason: 'end_turn' as const,
        finalText: 'ok',
        iterations: 1,
        error: undefined,
        typed: undefined,
        suspendedMessages: undefined,
        pendingApprovals: undefined,
        suspendedReason: undefined,
        wakeAt: undefined,
        eventsDelivered: false,
      },
    };
  },
};

function runner(): AsyncRunner {
  const store = new InMemoryTaskStore();
  store.save({
    taskId: 't1',
    status: 'running',
    spec: { messages: [{ role: 'user', content: 'go' }] },
    createdAt: Date.now(),
  } as TaskRecord);
  return new AsyncRunner(app as never, { store });
}

describe('awaitTask 的坏值防线（2026-11-07 深评 F6）', () => {
  it('timeoutMs: NaN ⇒ 立刻抛配置错，不进 1ms 忙轮询', async () => {
    await assert.rejects(runner().awaitTask('t1', { timeoutMs: Number.NaN }), /不能是 NaN/);
  });

  it('timeoutMs: Infinity ⇒ 立刻抛配置错（setTimeout 会钳到 1ms）', async () => {
    await assert.rejects(runner().awaitTask('t1', { timeoutMs: Number.POSITIVE_INFINITY }), /上限/);
  });

  it('intervalMs: 0 / NaN ⇒ 抛配置错，不忙轮询', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        runner().awaitTask('t1', { timeoutMs: 1000, intervalMs: bad }),
        /intervalMs 必须是正的有限数/,
        `坏值没拦住：${String(bad)}`,
      );
    }
  });
});
