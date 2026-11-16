import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PgSessionStore, PgTaskStore, ensureSchema } from '../dist/index.js';
import { liveUrl, withLiveSchema } from './helpers.mjs';

describe('真实 PostgreSQL：node-postgres Pool 与数据边界', () => {
  it('任务 NUL 逐字往返；会话 jsonb 的 NUL 明确报错', async () => {
    await withLiveSchema(async ({ schema }) => {
      const pool = new Pool({ connectionString: liveUrl });
      try {
        await ensureSchema(pool, { schema });
        const tasks = new PgTaskStore(pool, { schema });
        const original = {
          taskId: 'task_nul',
          status: 'queued',
          spec: { messages: [{ role: 'user', content: 'before\u0000after' }] },
          createdAt: 1,
        };
        await tasks.save(original);
        assert.deepEqual(await tasks.get(original.taskId), original);

        const sessions = new PgSessionStore(pool, { schema });
        await sessions.append('s1', [{ role: 'user', content: 'ordinary text' }]);
        assert.deepEqual(await sessions.load('s1'), [{ role: 'user', content: 'ordinary text' }]);
        await assert.rejects(
          () => sessions.append('s1', [{ role: 'user', content: 'bad\u0000text' }]),
          (error) => {
            assert.ok(error instanceof TypeError);
            assert.match(error.message, /NUL|u0000/);
            return true;
          },
        );
      } finally {
        await pool.end();
      }
    });
  });
});
