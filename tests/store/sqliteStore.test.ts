import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTaskStore } from '../../src/store/sqliteStore.js';
import { FileTaskStore } from '../../src/store/fsStore.js';
import type { TaskRecord, TaskStore } from '../../src/store/store.js';

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

function tmpFile(name: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-sqlite-'));
  return { dir, file: join(dir, name) };
}

describe('SqliteTaskStore', () => {
  it(':memory: —— save/get/byIdempotency/list/clear 全语义', () => {
    const store = new SqliteTaskStore(':memory:');
    try {
      assert.equal(store.get('nope'), undefined);
      assert.equal(store.byIdempotency('k'), undefined);
      assert.deepEqual(store.list(), []);

      const a = rec({ idempotencyKey: 'k' });
      const b = rec();
      store.save(a);
      store.save(b);
      assert.deepEqual(store.get(a.taskId), a);
      assert.deepEqual(store.byIdempotency('k'), a);
      assert.equal(store.list().length, 2);

      // save 覆写（last-wins）：同 taskId 推进状态
      const a2 = { ...a, status: 'succeeded' as const };
      store.save(a2);
      assert.equal(store.get(a.taskId)?.status, 'succeeded');
      assert.equal(store.list().length, 2);

      store.clear();
      assert.deepEqual(store.list(), []);
      assert.equal(store.get(a.taskId), undefined);
      assert.equal(store.byIdempotency('k'), undefined);
    } finally {
      store.close();
    }
  });

  it('byIdempotency last-wins：失败重提的新任务覆盖旧记录', () => {
    const store = new SqliteTaskStore(':memory:');
    try {
      const failed = rec({ idempotencyKey: 'k', status: 'failed' });
      store.save(failed);
      const retried = rec({ idempotencyKey: 'k' });
      store.save(retried);
      assert.equal(store.byIdempotency('k')?.taskId, retried.taskId);
    } finally {
      store.close();
    }
  });

  it('临时文件：重开续读（模拟宿主重启）', () => {
    const { dir, file } = tmpFile('tasks.db');
    try {
      const s1 = new SqliteTaskStore(file);
      const a = rec({ idempotencyKey: 'k', status: 'running' });
      s1.save(a);
      s1.save(rec({ status: 'succeeded' }));
      s1.close();

      // “重启”后新实例读回全部记录（running 残留交给 resumePending 续跑）
      const s2 = new SqliteTaskStore(file);
      try {
        assert.equal(s2.list().length, 2);
        assert.deepEqual(s2.get(a.taskId), a);
        assert.equal(s2.byIdempotency('k')?.taskId, a.taskId);
      } finally {
        s2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('与 FileTaskStore 语义对照：同一操作序列结果一致', () => {
    const { dir, file } = tmpFile('ref.jsonl');
    const fileStore: TaskStore = new FileTaskStore(file);
    // 用具体类型而非 TaskStore：本用例要同步访问 list/byIdempotency（MaybePromise 下是 Union）
    const sqliteStore = new SqliteTaskStore(':memory:');
    try {
      // 两 store 用同一批记录对象走同一序列（含同键重提）
      const records = [rec({ idempotencyKey: 'k1' }), rec({ idempotencyKey: 'k2' })];
      const retried = rec({ idempotencyKey: 'k1', status: 'failed' });
      for (const s of [fileStore, sqliteStore]) {
        for (const r of [...records, retried]) s.save(r);
      }

      assert.deepEqual(sqliteStore.list(), fileStore.list());
      assert.deepEqual(sqliteStore.byIdempotency('k1'), fileStore.byIdempotency('k1'));
      assert.equal(sqliteStore.byIdempotency('k1')?.taskId, retried.taskId);
      for (const r of records) {
        assert.deepEqual(sqliteStore.get(r.taskId), fileStore.get(r.taskId));
      }

      fileStore.clear();
      sqliteStore.clear();
      assert.deepEqual(sqliteStore.list(), fileStore.list());
    } finally {
      (sqliteStore as SqliteTaskStore).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('busy_timeout：他进程占住写锁时等锁重试，而非立即 SQLITE_BUSY', async () => {
    // 多进程共库的承诺靠 WAL + busy_timeout 兑现；只设 WAL 时第二个写者立即
    // SQLITE_BUSY，而 AsyncRunner 的 #safeSave 会把失败静默吞掉 → 记录无声丢失。
    // 用 worker 线程持锁（同进程不同连接，等价于另一个宿主进程）。
    const { dir, file } = tmpFile('busy.db');
    const store = new SqliteTaskStore(file);
    const holder = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.file);
       db.exec('PRAGMA journal_mode = WAL');
       db.exec('BEGIN IMMEDIATE');
       parentPort.postMessage('locked');
       setTimeout(() => {
         try { db.exec('COMMIT'); } catch {}
         parentPort.postMessage('released');
       }, 200);`,
      { eval: true, workerData: { file } },
    );
    let locked!: () => void;
    let released!: () => void;
    const gotLocked = new Promise<void>((r) => (locked = r));
    const gotReleased = new Promise<void>((r) => (released = r));
    holder.on('message', (m) => {
      if (m === 'locked') locked();
      else if (m === 'released') released();
    });
    try {
      await gotLocked; // 写锁已被他进程占住
      const a = rec();
      store.save(a); // 无 busy_timeout 会在此立即抛 SQLITE_BUSY
      await gotReleased;
      assert.deepEqual(store.get(a.taskId), a, '等锁后写入成功');
    } finally {
      await holder.terminate();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('busy_timeout 先于 WAL 生效：构造期遭遇写锁时等锁而非立即 SQLITE_BUSY', async () => {
    // WAL 转换本身要拿写锁。若 busy_timeout 设在 WAL 之后，多进程同时首启时先到者
    // 持锁，后到者在「PRAGMA journal_mode = WAL」上立即抛 database is locked
    // （busy_timeout 尚未生效）。本用例让另一连接（worker，等价另一宿主进程）先
    // BEGIN EXCLUSIVE 持锁 200ms，再构造 store：busy_timeout 先生效 ⇒ 构造等锁成功；
    // 顺序反过来则构造即抛。构造是同步阻塞调用（sqlite busy handler 不让出事件循环），
    // 所以持锁方必须放 worker 里，主线程 setTimeout 释放锁来不及触发。
    const { dir, file } = tmpFile('busy-init.db');
    const holder = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.file);
       db.exec('BEGIN EXCLUSIVE');
       parentPort.postMessage('locked');
       setTimeout(() => {
         try { db.exec('COMMIT'); } catch {}
         parentPort.postMessage('released');
       }, 200);`,
      { eval: true, workerData: { file } },
    );
    let locked!: () => void;
    let released!: () => void;
    const gotLocked = new Promise<void>((r) => (locked = r));
    const gotReleased = new Promise<void>((r) => (released = r));
    holder.on('message', (m) => {
      if (m === 'locked') locked();
      else if (m === 'released') released();
    });
    try {
      await gotLocked; // 写锁已被他进程占住
      const store = new SqliteTaskStore(file); // busy_timeout 先于 WAL：等锁；反之立即抛
      try {
        const a = rec();
        store.save(a);
        assert.deepEqual(store.get(a.taskId), a, '等锁后构造与写入都成功');
      } finally {
        store.close();
      }
      await gotReleased;
    } finally {
      await holder.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteTaskStore.listDue（到期索引，2026-09-28 ref-due-index-measure 落地）', () => {
  /** 一条在睡（或不在睡）的记录 */
  const sleeping = (
    id: string,
    wakeAt: number | undefined,
    status: 'suspended' | 'succeeded' = 'suspended',
  ): TaskRecord =>
    rec({
      taskId: id,
      status,
      suspendedReason: status === 'suspended' ? ('timer' as const) : undefined,
      ...(wakeAt !== undefined ? { wakeAt } : {}),
    });

  it('只回「在睡且到点」的：未来 wakeAt / 无 wakeAt / 终态都不回', () => {
    const store = new SqliteTaskStore(':memory:');
    try {
      const now = Date.now();
      store.save(sleeping('due-1', now - 1_000)); // 到点 ⇒ 回
      store.save(sleeping('due-2', now)); // 恰好等于 ⇒ 也回（边界是「不晚于现在」，见 wake-policy）
      store.save(sleeping('future', now + 3_600_000)); // 没到点 ⇒ 不回
      store.save(sleeping('approval-waiting', undefined)); // 等审批（无 wakeAt）⇒ 不回
      store.save(sleeping('done', now - 1_000, 'succeeded')); // 终态 ⇒ 不回
      const due = store.listDue(now);
      assert.deepEqual(
        due.map((r) => r.taskId),
        ['due-1', 'due-2'],
        '恰好回到期的两条（按写入顺序）',
      );
      assert.equal(due[0]?.wakeAt, now - 1_000, '记录完整读出（含 wakeAt）');
    } finally {
      store.close();
    }
  });

  it('存量库就地迁移：旧表（无 wake_at 列）构造期补列 + 从 json 回填，旧的在睡任务能醒', () => {
    const { dir, file } = tmpFile('legacy.db');
    try {
      // 造一座「上一个版本」的库：四列旧 schema，wakeAt 只在 json 里
      const require_ = createRequire(import.meta.url);
      const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite');
      const raw = new DatabaseSync(file);
      const legacy = rec({
        taskId: 'legacy-sleeper',
        status: 'suspended',
        suspendedReason: 'timer',
        wakeAt: Date.now() - 1_000,
      });
      raw.exec(
        'CREATE TABLE tasks (task_id TEXT PRIMARY KEY, idempotency_key TEXT, status TEXT, json TEXT)',
      );
      raw
        .prepare('INSERT INTO tasks (task_id, idempotency_key, status, json) VALUES (?, ?, ?, ?)')
        .run(legacy.taskId, null, 'suspended', JSON.stringify(legacy));
      raw.close();

      const store = new SqliteTaskStore(file); // 构造期迁移：补列 + 回填
      try {
        assert.deepEqual(
          store.listDue(Date.now()).map((r) => r.taskId),
          ['legacy-sleeper'],
          '旧库里在睡的任务不补回填就再也醒不来 —— 迁移必须带上它',
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('派生列漂移在读时自愈：外部把 wake_at 改掉 ⇒ get 之后 listDue 恢复一致', () => {
    const { dir, file } = tmpFile('drift.db');
    try {
      const store = new SqliteTaskStore(file);
      const recDue = rec({
        taskId: 'drifted',
        status: 'suspended',
        suspendedReason: 'timer',
        wakeAt: Date.now() - 1_000,
      });
      store.save(recDue);
      // 外部（DBA / 手改）把派生列改了：json 与列不一致
      const require_ = createRequire(import.meta.url);
      const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite');
      const raw = new DatabaseSync(file);
      raw.prepare('UPDATE tasks SET wake_at = NULL WHERE task_id = ?').run('drifted');
      raw.close();

      assert.deepEqual(store.listDue(Date.now()), [], '漂移期间：列说不醒（索引口径）');
      store.get('drifted'); // 读时自愈（与 status 列同一条纪律：判据是「列 ≠ json」）
      assert.deepEqual(
        store.listDue(Date.now()).map((r) => r.taskId),
        ['drifted'],
        '自愈后索引口径与 json 重新一致',
      );
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
