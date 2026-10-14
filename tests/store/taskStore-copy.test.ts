import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTaskStore, cloneTaskRecord } from '../../src/store/store.js';
import { FileTaskStore } from '../../src/store/fsStore.js';
import type { TaskRecord, TaskStore } from '../../src/store/store.js';

/**
 * TaskStore 副本契约（2026-10-13 ref-taskstore-copy-contract，spec §10）：`save` 存副本、
 * `get` / `byIdempotency` / `list` 交副本 —— 任何一条破了，「先变异 rec、再 await save」
 * 的纪律就整体塌方（变异在落库前被其他读者看见；save 失败时变异留在库里）。
 *
 * 本文件钉两个内建实现（InMemory / File）。sqlite / redis 走序列化，天然满足。
 */

function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${Math.random().toString(36).slice(2)}`,
    status: 'queued',
    spec: { messages: [{ role: 'user', content: '活' }], options: { maxTokens: 100 } },
    createdAt: 1000,
    ...overrides,
  };
}

/** 两个实现各跑一遍同一组契约断言 */
const impls: Array<{
  name: string;
  make: () => { store: TaskStore; cleanup: () => void };
}> = [
  {
    name: 'InMemoryTaskStore',
    make: () => ({ store: new InMemoryTaskStore(), cleanup: () => {} }),
  },
  {
    name: 'FileTaskStore',
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentia-copy-'));
      return {
        store: new FileTaskStore(join(dir, 'tasks.jsonl')),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
];

for (const { name, make } of impls) {
  describe(`副本契约 —— ${name}`, () => {
    it('get 交出副本：改返回值（含嵌套）不影响库里的记录', async () => {
      const { store, cleanup } = make();
      try {
        const a = rec({ result: { finalText: '原文' } as TaskRecord['result'] });
        await store.save(a);
        const got = (await store.get(a.taskId))!;
        got.status = 'cancelled';
        got.spec.messages.push({ role: 'user', content: '篡改' });
        (got.result as { finalText: string }).finalText = '改写';
        const again = (await store.get(a.taskId))!;
        assert.equal(again.status, 'queued');
        assert.equal(again.spec.messages.length, 1, '嵌套数组也不共享');
        assert.equal(again.result?.finalText, '原文', '嵌套对象也不共享');
        assert.notEqual(got, again, '两次 get 不是同一个对象');
      } finally {
        cleanup();
      }
    });

    it('save 存副本：入库后改调用方手里的 rec，库里不动', async () => {
      const { store, cleanup } = make();
      try {
        const a = rec();
        await store.save(a);
        a.status = 'failed';
        a.spec.messages.push({ role: 'user', content: '篡改' });
        const got = (await store.get(a.taskId))!;
        assert.equal(got.status, 'queued', '内存推进只许由 save 驱动');
        assert.equal(got.spec.messages.length, 1);
      } finally {
        cleanup();
      }
    });

    it('byIdempotency / list 同一纪律（同一批读者的入口不止 get）', async () => {
      const { store, cleanup } = make();
      try {
        const a = rec({ idempotencyKey: 'k' });
        await store.save(a);
        const byKey = (await store.byIdempotency('k'))!;
        byKey.status = 'failed';
        const listed = (await store.list())[0]!;
        listed.status = 'cancelled';
        assert.equal((await store.get(a.taskId))!.status, 'queued');
      } finally {
        cleanup();
      }
    });

    it('进程内对象按引用保留（AbortSignal / 函数）—— 副本不是序列化往返', async () => {
      const { store, cleanup } = make();
      try {
        const ac = new AbortController();
        const onText = (): void => {};
        const a = rec({
          spec: {
            messages: [{ role: 'user', content: 'x' }],
            options: { signal: ac.signal, onText },
          },
        });
        await store.save(a);
        const got = (await store.get(a.taskId))!;
        assert.equal(
          got.spec.options?.signal,
          ac.signal,
          'signal 必须按引用保留（克隆不了也不该克隆）',
        );
        assert.equal(got.spec.options?.onText, onText);
      } finally {
        cleanup();
      }
    });
  });
}

describe('副本契约 —— FileTaskStore 的「先落盘」不变量在活记录上同样成立', () => {
  it('改活记录后 append 失败：内存不推进（fsStore.test.ts 只用新记录，恰好测不到这一格）', () => {
    // 反向验证（2026-10-13 ref-taskstore-copy-contract 的病根）：get 交出活引用时，`rec.status = 'running'` 这一改
    // 在 save 抛错之前就已经进了内存 Map —— 下面两个断言会红（库里已是 running）。
    const dir = mkdtempSync(join(tmpdir(), 'agentia-copy-'));
    try {
      const file = join(dir, 'tasks.jsonl');
      const store = new FileTaskStore(file);
      const a = rec();
      store.save(a);

      // 改一条**已在库里的**记录（approve/恢复路径的标准动作：get → 变异 → save）
      const live = store.get(a.taskId)!;
      live.status = 'running';
      live.ownerId = 'p1@h-x';

      // 让 append 必败（磁盘满 / 目录被摘除的同族形态）
      rmSync(dir, { recursive: true, force: true });
      assert.throws(() => store.save(live));

      const after = store.get(a.taskId)!;
      assert.equal(after.status, 'queued', '落盘失败 ⇒ 内存不得推进到 running');
      assert.equal(after.ownerId, undefined, '认领标记同样不得泄漏进内存');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cloneTaskRecord —— 克隆件本身', () => {
  it('深拷贝纯数据、按引用保留类实例；输入不被改动', () => {
    const ac = new AbortController();
    const a = rec({
      pendingEvents: [{ eventId: 'e1', type: 't', payload: 'p' }],
      spec: { messages: [{ role: 'user', content: 'x' }], options: { signal: ac.signal } },
    });
    // 可序列化面 = JSON 往返（signal 不可序列化，统一直接比 JSON 文本）
    const asJson = (r: TaskRecord): string =>
      JSON.stringify(r, (_k, v: unknown) => (v instanceof AbortSignal ? undefined : v));
    const snapshot = asJson(a);
    const copy = cloneTaskRecord(a);
    assert.equal(asJson(copy), snapshot, '可序列化面逐字节一致');
    copy.pendingEvents![0]!.payload = '改写';
    assert.equal(a.pendingEvents![0]!.payload, 'p', '嵌套事件数组不共享');
    assert.equal(copy.spec.options?.signal, ac.signal, 'AbortSignal 按引用');
    assert.equal(asJson(a), snapshot, '输入对象一个字节都没被动过');
  });
});
