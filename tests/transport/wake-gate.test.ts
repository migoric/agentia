import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskWakeGate } from '../../src/transport/task-wake-gate.js';
import { AsyncRunner } from '../../src/transport/async.js';
import { InMemoryTaskStore } from '../../src/store/store.js';
import type { TaskRecord, TaskStore } from '../../src/store/store.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 异步 store（模拟 Redis 往返）：get/save 各 5ms，足以撑开「两边都读到旧快照」的窗口 */
class SlowStore implements TaskStore {
  readonly inner = new InMemoryTaskStore();
  async get(id: string): Promise<TaskRecord | undefined> {
    await sleep(5);
    return this.inner.get(id);
  }
  async save(rec: TaskRecord): Promise<void> {
    await sleep(5);
    this.inner.save(rec);
  }
  async byIdempotency(key: string): Promise<TaskRecord | undefined> {
    return this.inner.byIdempotency(key);
  }
  async list(): Promise<TaskRecord[]> {
    return this.inner.list();
  }
  async clear(): Promise<void> {
    this.inner.clear();
  }
}

describe('TaskWakeGate —— 同一 taskId 的唤醒路径串行', () => {
  it('前一条收口前，后一条不开始；busy / tail 可见', async () => {
    const gate = new TaskWakeGate();
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const p1 = gate.run('t', async () => {
      order.push('a-start');
      await hold;
      order.push('a-end');
    });
    const p2 = gate.run('t', async () => {
      order.push('b-start');
    });
    await sleep(10);
    assert.deepEqual(order, ['a-start'], 'b 必须等 a');
    assert.equal(gate.busy('t'), true);
    assert.ok(gate.tail('t') !== undefined);
    release();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
    assert.equal(gate.busy('t'), false);
  });

  it('不同 taskId 互不阻塞', async () => {
    const gate = new TaskWakeGate();
    const started: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const p1 = gate.run('a', async () => {
      started.push('a');
      await hold;
    });
    const p2 = gate.run('b', async () => {
      started.push('b');
    });
    await p2;
    assert.deepEqual(started, ['a', 'b']);
    release();
    await p1;
  });
});

describe('跨唤醒路径互斥（P1 回归）', () => {
  it('approve × signalTask 并发：只跑一次 app.run，后到的事件 409', async () => {
    let runs = 0;
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const app = {
      name: 'app',
      async run() {
        runs++;
        await hold;
        return {
          run: { runId: 'r' + runs, status: 'succeeded' as const },
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
    const store = new SlowStore();
    const now = Date.now();
    store.save({
      taskId: 't1',
      status: 'suspended',
      spec: {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'x', input: {} }] },
        ],
      },
      createdAt: now,
      suspendedSince: now,
      suspendedReason: 'approval',
      pendingApprovals: ['tu1'],
    } as TaskRecord);
    const runner = new AsyncRunner(app as never, { store, concurrency: 10 });

    const [approved, signalled] = await Promise.allSettled([
      runner.approve('t1', { tu1: { approved: true } }),
      runner.signalTask('t1', { type: 'ping', payload: 'p' }),
    ]);
    assert.equal(approved.status, 'fulfilled');
    assert.equal(signalled.status, 'rejected', '后到的信号看到 running，必须如实 409');
    await sleep(30);
    assert.equal(runs, 1, '同一任务只能被派发一次（修复前这里是 2）');
    release();
    await sleep(20);
  });
});
