import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema } from '../dist/index.js';
import { newClient, withLiveSchema } from './helpers.mjs';

describe('真实 PostgreSQL：多连接并发首启', () => {
  it('4 条真实连接 × 8 个全新 schema 同时建表：重试竞态码后全部收敛', {
    timeout: 90_000,
  }, async () => {
    await withLiveSchema(async ({ admin }) => {
      for (let round = 0; round < 8; round++) {
        const schema = `race_${round}`;
        await admin.query(`CREATE SCHEMA ${schema}`);
        const clients = Array.from({ length: 4 }, () => newClient());
        try {
          await Promise.all(clients.map((client) => client.connect()));
          // 同一道起跑闸；每个 Client 都是一条真实 TCP 会话，不是 PGlite 的单连接队列。
          const start = Promise.withResolvers();
          const armed = Promise.withResolvers();
          let ready = 0;
          const running = clients.map(async (client) => {
            ready++;
            if (ready === clients.length) armed.resolve();
            await start.promise;
            await ensureSchema(client, { schema });
          });
          await armed.promise;
          start.resolve();
          // allSettled 是承重清理：任一连接失败后也要等其余连接退出 DDL，再关连接/删 schema，
          // 否则次生的 Connection terminated 会盖住第一条真实错误，并留下 unhandledRejection。
          const settled = await Promise.allSettled(running);
          const failures = settled
            .filter((result) => result.status === 'rejected')
            .map((result) => ({
              code: result.reason?.code,
              message: result.reason?.message ?? String(result.reason),
            }));
          assert.deepEqual(failures, [], `第 ${round} 轮并发首启必须全部收敛`);
        } finally {
          await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        }
      }
    });
  });
});
