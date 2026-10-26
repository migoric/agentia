import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTaskStore } from '../../src/index.js';
import type { TaskRecord } from '../../src/index.js';

let n = 0;
function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${++n}`,
    status: 'queued',
    spec: { messages: [{ role: 'user', content: 'a' }] },
    createdAt: 1000 + n,
    ...over,
  };
}

describe('InMemoryTaskStore 内存闸门（maxRecords）', () => {
  it('超限时淘汰最旧的**已终态**记录，在飞（queued/running）记录永不淘汰', () => {
    const store = new InMemoryTaskStore({ maxRecords: 2 });
    const running = rec({ status: 'running' });
    store.save(running);
    const a = rec({ status: 'succeeded', idempotencyKey: 'ka' });
    store.save(a);
    const b = rec({ status: 'succeeded' });
    store.save(b); // size 3 > 2 → 淘汰最旧的已终态（a）

    assert.equal(store.get(a.taskId), undefined, '最旧的已终态被淘汰');
    assert.ok(store.get(running.taskId), '在飞记录保留');
    assert.ok(store.get(b.taskId), '最新记录保留');
    assert.equal(store.list().length, 2);
    assert.equal(store.byIdempotency('ka'), undefined, '被淘汰记录的幂等索引一并清掉');
  });

  it('全是在飞记录时不淘汰（宁可不腾空间也不丢正在跑的任务）', () => {
    const store = new InMemoryTaskStore({ maxRecords: 1 });
    const r1 = rec({ status: 'running' });
    const r2 = rec({ status: 'queued' });
    store.save(r1);
    store.save(r2);
    assert.equal(store.list().length, 2, '在飞记录不得被淘汰');
  });

  it('缺省不限（旧行为）：不淘汰', () => {
    const store = new InMemoryTaskStore();
    for (let i = 0; i < 50; i++) store.save(rec({ status: 'succeeded' }));
    assert.equal(store.list().length, 50);
  });

  it('suspended（HITL 挂起）同样不可淘汰：它不在跑、但也没完', () => {
    const store = new InMemoryTaskStore({ maxRecords: 2 });
    const awaiting = rec({ status: 'suspended' });
    store.save(awaiting);
    store.save(rec({ status: 'succeeded' }));
    store.save(rec({ status: 'succeeded' })); // size 3 > 2 → 触发淘汰
    assert.ok(store.get(awaiting.taskId), '挂起记录不淘汰（淘汰了审批决定就无家可归）');
    assert.equal(store.list().length, 2);
  });

  it('maxRecords 非法值（0 / 负数）抛错', () => {
    assert.throws(() => new InMemoryTaskStore({ maxRecords: 0 }), /maxRecords/);
    assert.throws(() => new InMemoryTaskStore({ maxRecords: -1 }), /maxRecords/);
  });

  it('副本保留 __proto__ 自有键，不改原型，也不与库内记录共享可变数据', () => {
    const store = new InMemoryTaskStore();
    const original = rec({
      spec: {
        messages: [{ role: 'user', content: 'a' }],
        options: { labels: JSON.parse('{"__proto__":{"tenant":"acme"}}') },
      },
    });
    store.save(original);

    const out = store.get(original.taskId)!;
    const labels = out.spec.options?.labels as unknown as Record<string, { tenant: string }>;
    assert.equal(Object.hasOwn(labels, '__proto__'), true);
    const special = Object.getOwnPropertyDescriptor(labels, '__proto__')!;
    assert.deepEqual(special.value, { tenant: 'acme' });
    assert.equal(Object.getPrototypeOf(labels), Object.prototype);

    (special.value as { tenant: string }).tenant = 'changed';
    const reread = store.get(original.taskId)!;
    const stored = reread.spec.options?.labels as unknown as Record<string, { tenant: string }>;
    const storedSpecial = Object.getOwnPropertyDescriptor(stored, '__proto__')!;
    assert.equal((storedSpecial.value as { tenant: string }).tenant, 'acme');
  });
});
