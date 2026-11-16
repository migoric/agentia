import { Client, Pool } from 'pg';
import { AsyncRunner } from '@migor/agentia';
import { PgTaskStore } from '../dist/index.js';

const gates = {
  releaseList: Promise.withResolvers(),
  releaseRun: Promise.withResolvers(),
};
process.on('message', (message) => {
  if (message?.type === 'releaseList') gates.releaseList.resolve();
  if (message?.type === 'releaseRun') gates.releaseRun.resolve();
});

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return resolve();
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function execute(config) {
  const pool = new Pool({ connectionString: process.env.AGENTIA_PG_TEST_URL });
  const base = new PgTaskStore(pool, { schema: config.schema });
  const store = {
    save: (rec) => base.save(rec),
    claimSubmission: (rec) => base.claimSubmission(rec),
    compareAndSave: (rec, expected) => base.compareAndSave(rec, expected),
    get: (id) => base.get(id),
    byIdempotency: (key) => base.byIdempotency(key),
    list: async () => {
      const records = await base.list();
      if (config.barrierList) {
        // 已拿到真实数据库快照，但尚未认领。父进程等另一进程也停在这里，
        // 因而复现的是两个 OS 进程都读到旧 ownerId，而不是碰巧同时调用。
        await send({ type: 'listed', pid: process.pid });
        await gates.releaseList.promise;
      }
      return records;
    },
    listDue: (before) => base.listDue(before),
    clear: () => base.clear(),
  };
  const app = {
    name: `live-worker-${process.pid}`,
    calls: 0,
    async run() {
      this.calls++;
      const runId = `run_${process.pid}_${this.calls}`;
      await send({ type: 'started', pid: process.pid, runId });
      if (config.hold) await gates.releaseRun.promise;
      return {
        run: { runId, status: 'succeeded' },
        result: { finalText: runId, stopReason: 'end_turn' },
      };
    },
  };
  const runner = new AsyncRunner(app, { store });
  let lockClient;
  let locked = false;
  try {
    if (config.mode === 'resume' && config.lockKey !== undefined) {
      // 与 README 配方一致：锁固定在一条专用会话上，不能用 Pool.query 随处执行。
      lockClient = new Client({ connectionString: process.env.AGENTIA_PG_TEST_URL });
      await lockClient.connect();
      const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [
        config.lockKey,
      ]);
      locked = rows[0]?.ok === true;
      await send({ type: 'lockAttempt', pid: process.pid, acquired: locked });
      if (!locked) return { calls: 0, resumed: 0, skipped: true, pid: process.pid };
    }

    if (config.mode === 'submit') {
      const submitted = runner.submit('from live worker', {
        idempotencyKey: config.idempotencyKey,
      });
      const record = await runner.awaitTask(submitted.taskId, {
        timeoutMs: 20_000,
        intervalMs: 10,
      });
      if (!(await runner.drain({ timeoutMs: 20_000 }))) throw new Error('submit worker 未排空');
      return {
        calls: app.calls,
        pid: process.pid,
        status: record.status,
        runId: record.runId,
        finalText: record.result?.finalText,
      };
    }

    const resumed = await runner.resumePending();
    const record = await runner.awaitTask(config.taskId, { timeoutMs: 20_000, intervalMs: 10 });
    // 两个恢复者等的是同一个 taskId：awaitTask 可能先看到另一进程的终态。
    // 必须再排空自己的 active，才能关 pool；否则本进程那次 run 可能仍在写结果。
    if (!(await runner.drain({ timeoutMs: 20_000 }))) throw new Error('resume worker 未排空');
    return {
      calls: app.calls,
      resumed,
      pid: process.pid,
      status: record.status,
      runId: record.runId,
    };
  } finally {
    if (lockClient && locked) {
      await lockClient
        .query('SELECT pg_advisory_unlock($1)', [config.lockKey])
        .catch(() => undefined);
    }
    await lockClient?.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

let started = false;
process.on('message', async (config) => {
  if (config?.type !== 'config' || started) return;
  started = true;
  try {
    const outcome = await execute(config);
    await send({ type: 'done', ...outcome });
    process.disconnect();
  } catch (error) {
    await send({ type: 'error', pid: process.pid, message: error?.stack ?? String(error) }).catch(
      () => undefined,
    );
    process.exitCode = 1;
    process.disconnect();
  }
});
