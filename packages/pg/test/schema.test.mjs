/**
 * schema —— 命名解析、标识符校验、幂等建表。
 *
 * 标识符校验那几条不是形式主义：表名前缀是**唯一**被拼进 SQL 文本的用户输入
 * （其余一律走占位符），漏掉校验就是一个注入口子。所以这里连
 * `'x; DROP TABLE tasks; --'` 也当输入验一遍。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshClient } from './helpers.mjs';
import { ensureSchema, resolveSchemaNames, schemaDdl } from '../dist/index.js';

const { db, client } = await freshClient();

after(async () => {
  await db.close();
});

describe('resolveSchemaNames', () => {
  it('缺省：agentia_ 前缀、不限定 schema', () => {
    const n = resolveSchemaNames();
    assert.equal(n.qualifier, '');
    assert.equal(n.tasks, 'agentia_tasks');
    assert.equal(n.sessionMessages, 'agentia_session_messages');
    assert.equal(n.taskSaveSeq, 'agentia_task_save_seq');
  });

  it('自定义前缀与 schema', () => {
    const n = resolveSchemaNames({ tablePrefix: 'staging_', schema: 'public' });
    assert.equal(n.qualifier, 'public.');
    assert.equal(n.tasks, 'public.staging_tasks');
    // 索引名不能带 schema 限定（PostgreSQL CREATE INDEX 的要求）；
    // schema 由父表决定，写成 public.staging_tasks_due_idx 会 syntax error。
    assert.equal(n.idxTasksDue, 'staging_tasks_due_idx');
  });

  it('前缀必须合法，否则抛错（唯一拼进 SQL 的用户输入）', () => {
    const bad = ['Bad-Case', '1abc', '', 'a b', 'a;drop', "x'--", '中文'];
    for (const p of bad) {
      assert.throws(() => resolveSchemaNames({ tablePrefix: p }), /tablePrefix/, `应拒绝 ${p}`);
    }
  });

  it('schema 名同样校验（防"配的和我实际用的不是同一个"）', () => {
    assert.throws(() => resolveSchemaNames({ schema: 'MySchema' }), /schema/);
    assert.throws(() => resolveSchemaNames({ schema: 'a.b' }), /schema/);
  });
});

describe('schemaDdl', () => {
  it('包含两张表、一条序列、四个索引，且顺序满足依赖（序列在建表前）', () => {
    const ddl = schemaDdl();
    const joined = ddl.join('\n');
    assert.match(joined, /CREATE SEQUENCE IF NOT EXISTS agentia_task_save_seq/);
    assert.match(joined, /CREATE TABLE IF NOT EXISTS agentia_tasks/);
    assert.match(joined, /CREATE TABLE IF NOT EXISTS agentia_session_messages/);
    assert.equal(ddl.filter((s) => s.includes('CREATE INDEX IF NOT EXISTS')).length, 4);

    const seqAt = ddl.findIndex((s) => s.includes('CREATE SEQUENCE'));
    const tableAt = ddl.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS agentia_tasks'));
    assert.ok(seqAt < tableAt, '序列必须先建，否则第一条 INSERT 的 nextval 会找不到它');
  });

  it('每条语句自身幂等（都带 IF NOT EXISTS）', () => {
    for (const stmt of schemaDdl()) {
      assert.match(stmt, /IF NOT EXISTS/, `非幂等语句：${stmt.slice(0, 60)}…`);
    }
  });
});

describe('ensureSchema', () => {
  it('可重复执行（进程每次启动都调是正常用法）', async () => {
    await ensureSchema(client);
    await ensureSchema(client);
    await ensureSchema(client);
  });

  it('带 schema 选项也能真正执行（回归：索引名曾带 schema 前缀而 syntax error）', async () => {
    await ensureSchema(client, { schema: 'public' });
    const idx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('agentia_tasks', 'agentia_session_messages')
        ORDER BY indexname`,
    );
    const names = idx.rows.map((r) => r.indexname);
    assert.ok(names.includes('agentia_tasks_due_idx'));
    assert.ok(names.includes('agentia_session_messages_created_idx'));
    assert.ok(
      names.every((n) => !n.includes('.')),
      '索引名不能被 schema 限定',
    );
  });

  it('并发首启竞态（42P07/42710/23505）会重试而不是直接失败', async () => {
    let calls = 0;
    const fake = {
      async query() {
        calls++;
        if (calls === 1) {
          const e = new Error('duplicate key value violates unique constraint');
          e.code = '42P07';
          throw e;
        }
        return { rows: [] };
      },
    };
    await ensureSchema(fake);
    assert.equal(calls, schemaDdl().length + 1, '第一条 DDL 应重试一次，其余各一次');
  });

  it('建出来的表真的有那几列（含 save_seq —— last-wins 的载体）', async () => {
    await ensureSchema(client);
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agentia_tasks' ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    assert.deepEqual(names, [
      'task_id',
      'idempotency_key',
      'status',
      'wake_at',
      'created_at',
      'save_seq',
      'json',
    ]);
  });

  it('save_seq 的缺省值来自序列（新插入不需要显式给）', async () => {
    await ensureSchema(client);
    await client.query('TRUNCATE agentia_tasks');
    await client.query(
      `INSERT INTO agentia_tasks (task_id, status, created_at, json)
       VALUES ('t1', 'queued', 1, '{"taskId":"t1"}'::text)`,
    );
    const r = await client.query('SELECT save_seq FROM agentia_tasks WHERE task_id = $1', ['t1']);
    assert.ok(Number(r.rows[0].save_seq) > 0, '缺省值应当来自 nextval，而不是 0/NULL');
  });
});
