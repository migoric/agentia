/**
 * PgTaskStore —— 用真 PostgreSQL 引擎（PGlite/WASM）验证 SQL 语义。
 *
 * 重点不在"方法能调通"，而在三条**只有真库才能证伪**的契约：
 * ① 幂等键的 last-wins 靠 `save_seq`，不是靠插入序；
 * ② `listDue` 的过滤口径（status + wake_at）与 `wake-policy.ts` 对齐；
 * ③ 落库走 `serializeTaskRecord`，进程内引用真的被剥掉了。
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshClient, rec } from './helpers.mjs';
import { PgTaskStore, ensureSchema, resolveSchemaNames } from '../dist/index.js';

const { db, client } = await freshClient();
// 构造期不建表（那是宿主的运维决定），所以显式 ensureSchema 一次 —— 与宿主用法一致
await ensureSchema(client);
const store = new PgTaskStore(client);
const names = resolveSchemaNames();

beforeEach(async () => {
  await db.exec(`TRUNCATE ${names.tasks}`);
});

after(async () => {
  await db.close();
});

describe('PgTaskStore.save / get', () => {
  it('往返：写进去什么读出什么', async () => {
    const r = rec({ idempotencyKey: 'k1', wakeAt: 5000, status: 'suspended' });
    await store.save(r);
    const got = await store.get(r.taskId);
    assert.equal(got.taskId, r.taskId);
    assert.equal(got.status, 'suspended');
    assert.equal(got.wakeAt, 5000);
    assert.equal(got.idempotencyKey, 'k1');
  });

  it('任务文本含 NUL（\\u0000）也逐字往返，不静默清洗', async () => {
    const text = '前\u0000后';
    const r = rec({
      spec: { messages: [{ role: 'user', content: text }] },
      result: { finalText: text },
    });
    await store.save(r);
    const got = await store.get(r.taskId);
    assert.equal(got.spec.messages[0].content, text);
    assert.equal(got.result.finalText, text);
    const raw = await client.query('SELECT json FROM agentia_tasks WHERE task_id = $1', [r.taskId]);
    assert.equal(typeof raw.rows[0].json, 'string', '任务正文按 text 存，不经 jsonb 规范化');
  });

  it('get 不存在 → undefined（不是抛错）', async () => {
    assert.equal(await store.get('task_nope'), undefined);
  });

  it('副本语义：改读回来的对象不影响下一次读（TaskStore.get 的纪律）', async () => {
    const r = rec();
    await store.save(r);
    const a = await store.get(r.taskId);
    a.status = 'failed';
    a.spec.messages.push({ role: 'user', content: '污染' });
    const b = await store.get(r.taskId);
    assert.equal(b.status, 'queued', '读回的记录必须是快照，不是库内活引用');
    assert.equal(b.spec.messages.length, 1);
  });

  it('save 存的是副本：调用方此后改 rec 不会绕过 save 落库', async () => {
    const r = rec();
    await store.save(r);
    r.status = 'running';
    const got = await store.get(r.taskId);
    assert.equal(got.status, 'queued');
  });

  it('进程内引用被剥掉（serializeTaskRecord 生效）', async () => {
    const r = rec({
      spec: {
        messages: [{ role: 'user', content: 'a' }],
        options: {
          signal: new AbortController().signal,
          client: { messages: {} },
          tools: [{ name: 't', run: () => 1 }],
        },
      },
    });
    await store.save(r);
    const got = await store.get(r.taskId);
    assert.equal(got.spec.options.signal, undefined, 'AbortSignal 不能落库（会变成 {}）');
    assert.equal(got.spec.options.client, undefined);
    assert.equal(got.spec.options.tools, undefined);
    assert.deepEqual(
      got.spec.options.__agentiaDroppedRefs,
      ['client', 'tools'],
      '剥掉了什么必须留痕，恢复段才知道该退回配置兜底',
    );
  });
});

describe('PgTaskStore.byIdempotency（last-wins 靠 save_seq）', () => {
  it('同键重提：后写的赢', async () => {
    const first = rec({ idempotencyKey: 'same', status: 'failed' });
    await store.save(first);
    const second = rec({ idempotencyKey: 'same', status: 'queued' });
    await store.save(second);

    const got = await store.byIdempotency('same');
    assert.equal(got.taskId, second.taskId, '失败后同键重提，必须取到新任务而不是旧记录');
    assert.equal(got.status, 'queued');
  });

  it('同一 taskId 覆写多次，仍取最新快照', async () => {
    const r = rec({ idempotencyKey: 'k' });
    await store.save(r);
    await store.save({ ...r, status: 'running' });
    await store.save({ ...r, status: 'succeeded' });
    const got = await store.byIdempotency('k');
    assert.equal(got.status, 'succeeded');
  });

  /**
   * 这条是 `save_seq` 的**唯一区分性断言**。
   *
   * 上面两条走的都是 INSERT 路径（不同 taskId 或只覆写同一条），列上的
   * `DEFAULT nextval(...)` 就能给出正确的序 —— 把 UPDATE 分支里的
   * `save_seq = nextval(...)` 删掉，它们**照样全绿**（已实测）。
   *
   * 能分开两者的场景是：A、B 同键先后保存，之后**又保存了一次 A**。
   * 契约是"最后一次 save 的记录赢"（SqliteTaskStore 的 `INSERT OR REPLACE` 就是
   * 这个语义：删旧行重插、rowid 最大者赢）。此时 A 的 taskId 更小、物理位置更靠前，
   * 只有 save_seq 被 UPDATE 刷新过，它才会赢。
   */
  it('最后 save 的记录赢 —— 即使它先被插入过（UPDATE 分支必须刷新 save_seq）', async () => {
    const first = rec({ idempotencyKey: 'k2', status: 'queued' });
    const second = rec({ idempotencyKey: 'k2', status: 'queued' });
    await store.save(first);
    await store.save(second);
    // 再次推进 first：此刻它才是"最近一次 save"的那条
    await store.save({ ...first, status: 'running' });

    const got = await store.byIdempotency('k2');
    assert.equal(
      got.taskId,
      first.taskId,
      'last-save-wins 必须由 save_seq 保证；靠物理插入序会在并发下选错',
    );
    assert.equal(got.status, 'running');
  });

  it('不存在的键 → undefined', async () => {
    assert.equal(await store.byIdempotency('nope'), undefined);
  });

  it('不同键互不干扰', async () => {
    const a = rec({ idempotencyKey: 'a' });
    const b = rec({ idempotencyKey: 'b' });
    await store.save(a);
    await store.save(b);
    assert.equal((await store.byIdempotency('a')).taskId, a.taskId);
    assert.equal((await store.byIdempotency('b')).taskId, b.taskId);
  });
});

describe('PgTaskStore.list / listDue', () => {
  it('list 按 createdAt 升序（稳定、有语义，不是插入序）', async () => {
    await store.save(rec({ createdAt: 300 }));
    await store.save(rec({ createdAt: 100 }));
    await store.save(rec({ createdAt: 200 }));
    const all = await store.list();
    assert.deepEqual(
      all.map((r) => r.createdAt),
      [100, 200, 300],
    );
  });

  it('listDue 只回「在睡且到点」', async () => {
    const due = rec({ status: 'suspended', wakeAt: 1000, suspendedReason: 'timer' });
    const notYet = rec({ status: 'suspended', wakeAt: 9000, suspendedReason: 'timer' });
    const noWake = rec({ status: 'suspended', suspendedReason: 'approval' });
    const running = rec({ status: 'running', wakeAt: 1000 });
    for (const r of [due, notYet, noWake, running]) await store.save(r);

    const hit = await store.listDue(5000);
    assert.deepEqual(
      hit.map((r) => r.taskId),
      [due.taskId],
      '只有 suspended 且 wake_at <= before 的算到期；缺 wakeAt 的、在跑的一律不回',
    );
  });

  it('listDue 边界：wake_at 恰好等于 before 也算到期', async () => {
    const edge = rec({ status: 'suspended', wakeAt: 5000, suspendedReason: 'timer' });
    await store.save(edge);
    assert.equal((await store.listDue(5000)).length, 1);
    assert.equal((await store.listDue(4999)).length, 0);
  });

  it('clear 清空', async () => {
    await store.save(rec());
    await store.clear();
    assert.deepEqual(await store.list(), []);
  });
});

describe('PgTaskStore 原子提交与快照 CAS', () => {
  it('同一 taskId 并发 claim 只有一个 true；另一调用不得改变认领者', async () => {
    const first = rec({ taskId: 'task_atomic', idempotencyKey: 'atomic', ownerId: 'first' });
    const second = { ...first, ownerId: 'second' };
    const claims = await Promise.all([store.claimSubmission(first), store.claimSubmission(second)]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal((await store.get(first.taskId)).ownerId, 'first');
  });

  it('failed / cancelled 可重新认领；active / succeeded 不可', async () => {
    for (const [status, expected] of [
      ['queued', false],
      ['running', false],
      ['suspended', false],
      ['succeeded', false],
      ['failed', true],
      ['cancelled', true],
    ]) {
      const taskId = `task_${status}`;
      await store.save(rec({ taskId, idempotencyKey: status, status, ownerId: 'old' }));
      const next = rec({ taskId, idempotencyKey: status, status: 'queued', ownerId: 'new' });
      assert.equal(await store.claimSubmission(next), expected, status);
      assert.equal((await store.get(taskId)).ownerId, expected ? 'new' : 'old');
    }
  });

  it('同 taskId 但幂等键不同：不允许借失败重试覆盖另一条任务', async () => {
    await store.save(rec({ taskId: 'task_collision', idempotencyKey: 'old', status: 'failed' }));
    const other = rec({ taskId: 'task_collision', idempotencyKey: 'other' });
    assert.equal(await store.claimSubmission(other), false);
    assert.equal((await store.get('task_collision')).idempotencyKey, 'old');
  });

  it('CAS 匹配完整旧快照才写入；陈旧快照 false 且不改库', async () => {
    const original = rec({ taskId: 'task_cas', status: 'running', ownerId: 'old' });
    await store.save(original);
    const claimed = { ...original, status: 'queued', ownerId: 'new' };
    assert.equal(await store.compareAndSave(claimed, original), true);
    assert.equal((await store.get(original.taskId)).ownerId, 'new');

    const staleResult = { ...claimed, status: 'succeeded', runId: 'stale' };
    assert.equal(await store.compareAndSave(staleResult, original), false);
    const current = await store.get(original.taskId);
    assert.equal(current.status, 'queued');
    assert.equal(current.runId, undefined);
  });

  it('CAS 比较任务正文而非只比较状态：其他字段变了同样拒绝', async () => {
    const original = rec({ taskId: 'task_cas_body', status: 'running', ownerId: 'old' });
    await store.save(original);
    const expected = structuredClone(original);
    await store.save({ ...original, result: { finalText: 'meanwhile' } });
    assert.equal(await store.compareAndSave({ ...original, status: 'queued' }, expected), false);
    assert.equal((await store.get(original.taskId)).result.finalText, 'meanwhile');
  });
});

describe('PgTaskStore 构造期校验', () => {
  it('没有 query 的客户端 → 响亮失败', () => {
    assert.throws(() => new PgTaskStore({}), /缺少 query/);
    assert.throws(() => new PgTaskStore(null), /需要一个 PG 客户端对象/);
  });

  it('非法表前缀 → 响亮失败（不做字符串拼接的静默容错）', () => {
    assert.throws(() => new PgTaskStore(client, { tablePrefix: 'Bad-Name' }), /tablePrefix/);
    assert.throws(
      () => new PgTaskStore(client, { tablePrefix: 'x; DROP TABLE tasks; --' }),
      /tablePrefix/,
    );
  });
});
