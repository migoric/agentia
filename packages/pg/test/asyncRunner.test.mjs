/**
 * AsyncRunner × PgTaskStore：真实 PG 引擎上的提交顺序与确定性 taskId 回归。
 *
 * 同键各进程争同一个主键；旧 succeeded 仍先读取并直接采纳，失败后重试则原子重置同一行。
 * 这里打的是两边真实的 dist 产物。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner } from '@migor/agentia';
import { freshClient } from './helpers.mjs';
import { PgTaskStore, ensureSchema } from '../dist/index.js';

const { db, client } = await freshClient();
await ensureSchema(client);
const store = new PgTaskStore(client);

after(async () => {
  await db.close();
});

function countingApp({ failFirst = false } = {}) {
  return {
    name: 'pg-idempotency',
    calls: 0,
    async run() {
      this.calls++;
      if (failFirst && this.calls === 1) throw new Error('first attempt failed');
      return {
        run: { runId: `run_${this.calls}`, status: 'succeeded' },
        result: { finalText: `ok_${this.calls}`, stopReason: 'end_turn' },
      };
    },
  };
}

describe('AsyncRunner + PgTaskStore 幂等提交', () => {
  it('成功后同键顺序提交：采纳首次结果，不重复执行', async () => {
    const app = countingApp();
    const runner = new AsyncRunner(app, { store });
    const first = runner.submit('a', { idempotencyKey: 'pg-success' });
    const firstDone = await runner.awaitTask(first.taskId);
    assert.equal(firstDone.status, 'succeeded');

    const second = runner.submit('a', { idempotencyKey: 'pg-success' });
    assert.equal(second.taskId, first.taskId, 'PG 原子能力使用同键的确定性 taskId');
    const secondDone = await runner.awaitTask(second.taskId);
    assert.equal(secondDone.status, 'succeeded');
    assert.equal(app.calls, 1, '新 queued 不得抢先遮住旧 succeeded');
    assert.equal(firstDone.result.finalText, 'ok_1');
    assert.equal(secondDone.result.finalText, 'ok_1');
    assert.equal(secondDone.runId, firstDone.runId);
  });

  it('失败后同键可重试：不能把旧 failed 当成成功去重', async () => {
    const app = countingApp({ failFirst: true });
    const runner = new AsyncRunner(app, { store });
    const first = runner.submit('a', { idempotencyKey: 'pg-retry' });
    assert.equal((await runner.awaitTask(first.taskId)).status, 'failed');

    const second = runner.submit('a', { idempotencyKey: 'pg-retry' });
    assert.equal(second.taskId, first.taskId, '失败后原子重置同一行，不再增加随机任务');
    const secondDone = await runner.awaitTask(second.taskId);
    assert.equal(secondDone.status, 'succeeded');
    assert.equal(secondDone.result.finalText, 'ok_2');
    assert.equal(app.calls, 2);
  });
});
