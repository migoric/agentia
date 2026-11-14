import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureSchema, PgTaskStore } from '../dist/index.js';
import { withLiveSchema } from './helpers.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function launch(config) {
  const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const handle = {
    child,
    messages: [],
    exited: new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        handle.exit = { code, signal };
        resolve(handle.exit);
      });
    }),
  };
  child.on('message', (message) => handle.messages.push(message));
  child.send({ type: 'config', ...config });
  return handle;
}

function release(handles, type) {
  for (const { child } of handles) {
    if (child.connected) child.send({ type }, () => undefined);
  }
}

function waitForMessages(handles, type, count, timeoutMs = 15_000) {
  const matches = () =>
    handles.flatMap((handle) =>
      handle.messages
        .filter((message) => message.type === type)
        .map((message) => ({ handle, message })),
    );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `等待 ${count} 条 ${type} 超时；实际消息：${JSON.stringify(handles.map((h) => h.messages))}`,
        ),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      for (const { child } of handles) child.off('message', check);
    };
    const check = () => {
      const error = handles.flatMap((h) => h.messages).find((m) => m.type === 'error');
      if (error) {
        cleanup();
        reject(new Error(error.message));
        return;
      }
      const found = matches();
      if (found.length >= count) {
        cleanup();
        resolve(found.slice(0, count));
      }
    };
    for (const { child } of handles) child.on('message', check);
    check();
  });
}

async function stopWorkers(handles) {
  release(handles, 'releaseList');
  release(handles, 'releaseRun');
  await Promise.race([
    Promise.all(handles.map((h) => h.exited)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  for (const { child } of handles) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await Promise.all(handles.map((h) => h.exited));
}

/** 每个场景都等真实子进程退出；失败也先开闸再杀，绝不留后台 worker。 */
async function runWorkers(t, configs, body) {
  const handles = configs.map(launch);
  t.after(() => stopWorkers(handles));
  try {
    await body(handles);
    const exits = await Promise.all(handles.map((h) => h.exited));
    assert.deepEqual(
      exits.map((exit) => exit.code),
      configs.map(() => 0),
      '每个真实 worker 都必须干净退出',
    );
  } finally {
    await stopWorkers(handles);
  }
}

const configFor = (schema, extra = {}) => ({ schema, ...extra });

async function seedOrphan(admin, schema, taskId) {
  const store = new PgTaskStore(admin, { schema });
  await store.save({
    taskId,
    status: 'running',
    ownerId: 'previous-process@another-host',
    spec: { messages: [{ role: 'user', content: 'recover me' }] },
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 60_000,
  });
}

describe('真实 PostgreSQL：两个独立 OS 进程的多写者语义', () => {
  it('首次同键并发提交：主键只认领一次，另一进程跟随同一结果', {
    timeout: 30_000,
  }, async (t) => {
    await withLiveSchema(async ({ admin, schema }) => {
      await ensureSchema(admin, { schema });
      const config = configFor(schema, {
        mode: 'submit',
        idempotencyKey: 'same-first-submission',
        hold: true,
      });
      await runWorkers(t, [config, config], async (workers) => {
        // 唯一认领者进入 app.run 后先不放行，确保另一进程只能观察而不能采纳旧成功。
        await waitForMessages(workers, 'started', 1);
        release(workers, 'releaseRun');
        const done = await waitForMessages(workers, 'done', 2);
        assert.deepEqual(
          done.map(({ message }) => message.calls).sort(),
          [0, 1],
          '同一主键只有一个认领者执行，另一进程不进入 app.run',
        );
        assert.ok(done.every(({ message }) => message.status === 'succeeded'));
        assert.equal(new Set(done.map(({ message }) => message.runId)).size, 1);
      });
    });
  });

  it('另一进程已有 succeeded：新进程采纳旧结果，不再执行', { timeout: 30_000 }, async (t) => {
    await withLiveSchema(async ({ admin, schema }) => {
      await ensureSchema(admin, { schema });
      const config = configFor(schema, {
        mode: 'submit',
        idempotencyKey: 'already-succeeded',
        hold: false,
      });
      let first;
      await runWorkers(t, [config], async ([worker]) => {
        [{ message: first }] = await waitForMessages([worker], 'done', 1);
        assert.equal(first.calls, 1);
      });
      await runWorkers(t, [config], async ([worker]) => {
        const [{ message: second }] = await waitForMessages([worker], 'done', 1);
        assert.equal(second.calls, 0, '新进程也必须采纳数据库里的旧成功结果');
        assert.equal(second.runId, first.runId);
        assert.equal(second.finalText, first.finalText);
      });
    });
  });

  it('两个进程同时读到旧 ownerId：快照 CAS 只允许一个恢复者执行', {
    timeout: 30_000,
  }, async (t) => {
    await withLiveSchema(async ({ admin, schema }) => {
      await ensureSchema(admin, { schema });
      await seedOrphan(admin, schema, 'orphan_without_lock');
      const config = configFor(schema, {
        mode: 'resume',
        taskId: 'orphan_without_lock',
        hold: true,
        barrierList: true,
      });
      await runWorkers(t, [config, config], async (workers) => {
        // 两个进程都已完成 list()、都拿着旧 ownerId 快照，再同时认领。
        await waitForMessages(workers, 'listed', 2);
        release(workers, 'releaseList');
        await waitForMessages(workers, 'started', 1);
        release(workers, 'releaseRun');
        const done = await waitForMessages(workers, 'done', 2);
        assert.deepEqual(done.map(({ message }) => message.calls).sort(), [0, 1]);
        assert.deepEqual(done.map(({ message }) => message.resumed).sort(), [0, 1]);
        assert.equal(
          (await new PgTaskStore(admin, { schema }).get('orphan_without_lock'))?.status,
          'succeeded',
        );
      });
    });
  });

  it('README 的专用连接 advisory lock：同一窗口只有一个进程认领', {
    timeout: 30_000,
  }, async (t) => {
    await withLiveSchema(async ({ admin, schema }) => {
      await ensureSchema(admin, { schema });
      await seedOrphan(admin, schema, 'orphan_with_lock');
      const config = configFor(schema, {
        mode: 'resume',
        taskId: 'orphan_with_lock',
        hold: true,
        barrierList: true,
        lockKey: 1 + Math.floor(Math.random() * 2_000_000_000),
      });
      await runWorkers(t, [config, config], async (workers) => {
        const listed = waitForMessages(workers, 'listed', 1);
        const attempts = waitForMessages(workers, 'lockAttempt', 2);
        await listed;
        // 等另一方也尝试过锁再放行持锁者：排除“第二进程晚到，锁已释放”的假阳性。
        await attempts;
        release(workers, 'releaseList');
        await waitForMessages(workers, 'started', 1);
        release(workers, 'releaseRun');
        const done = await waitForMessages(workers, 'done', 2);
        assert.equal(
          done.reduce((sum, { message }) => sum + message.calls, 0),
          1,
          'advisory lock 必须把这次恢复扫描互斥成一次副作用',
        );
        assert.equal(done.filter(({ message }) => message.skipped).length, 1);
        assert.equal(done.filter(({ message }) => message.resumed === 1).length, 1);
        assert.equal(
          (await new PgTaskStore(admin, { schema }).get('orphan_with_lock'))?.status,
          'succeeded',
        );
      });
    });
  });
});
