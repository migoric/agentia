/**
 * PgSessionStore —— 真 PostgreSQL 引擎（PGlite/WASM）驱动。
 *
 * 核心那条用例是「按轮次裁 vs 按条数裁」的**区分性**断言：拿一个
 * 3 轮半（u,a,u,a,u）的历史，`maxTurns: 2` 必须裁出 `u2,a2,u3`；
 * 若实现退化成"保留最后 N 条"（RedisSessionStore 的 `maxMessages` 就是这么干的），
 * 结果会是 `a1,u2,a2,u3` —— 以 assistant 开头，下一轮直接撞厂商的角色交替校验。
 * 两条路的输出不同，所以这条测试真的能守住实现，不是摆设。
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshClient } from './helpers.mjs';
import { PgSessionStore, ensureSchema, resolveSchemaNames } from '../dist/index.js';

const { db, client } = await freshClient();
await ensureSchema(client);
const names = resolveSchemaNames();

const u = (t) => ({ role: 'user', content: t });
const a = (t) => ({ role: 'assistant', content: t });

beforeEach(async () => {
  await db.exec(`TRUNCATE ${names.sessionMessages}`);
});

after(async () => {
  await db.close();
});

describe('PgSessionStore 基本往返', () => {
  it('append 后 load 顺序一致', async () => {
    const s = new PgSessionStore(client);
    await s.append('s1', [u('1'), a('2')]);
    await s.append('s1', [u('3')]);
    const got = await s.load('s1');
    assert.deepEqual(
      got.map((m) => m.content),
      ['1', '2', '3'],
    );
    assert.deepEqual(
      got.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
  });

  it('没有历史 → 空数组（不是 undefined）', async () => {
    assert.deepEqual(await new PgSessionStore(client).load('nope'), []);
  });

  it('空数组 append 是 no-op（不写行、不报错）', async () => {
    const s = new PgSessionStore(client);
    await s.append('s1', []);
    assert.deepEqual(await s.load('s1'), []);
  });

  it('特殊字符保真：引号 / 逗号 / 花括号 / 换行 / 中文', async () => {
    const content = 'He said "hi", then {a:1}, 换行\n与中文 —— 还有 \\ 反斜杠';
    const s = new PgSessionStore(client);
    await s.append('s1', [u(content)]);
    const got = await s.load('s1');
    assert.equal(got[0].content, content);
  });

  it('多个会话互不干扰', async () => {
    const s = new PgSessionStore(client);
    await s.append('s1', [u('A')]);
    await s.append('s2', [u('B')]);
    assert.deepEqual(
      (await s.load('s1')).map((m) => m.content),
      ['A'],
    );
    assert.deepEqual(
      (await s.load('s2')).map((m) => m.content),
      ['B'],
    );
  });

  it('一批 2000 条也能一次写完（数组参数，不是逐条 INSERT）', async () => {
    const s = new PgSessionStore(client);
    const batch = Array.from({ length: 2000 }, (_, i) => u(`m${i}`));
    await s.append('big', batch);
    const got = await s.load('big');
    assert.equal(got.length, 2000);
    assert.equal(got[1999].content, 'm1999');
  });
});

describe('PgSessionStore.maxTurns（按轮次裁，不是按条数）', () => {
  it('3 轮半的历史 + maxTurns 2 ⇒ 从倒数第 2 条 user 起保留', async () => {
    const s = new PgSessionStore(client, { maxTurns: 2 });
    await s.append('s1', [u('u1'), a('a1')]);
    await s.append('s1', [u('u2'), a('a2')]);
    await s.append('s1', [u('u3')]);

    const got = await s.load('s1');
    assert.deepEqual(
      got.map((m) => m.content),
      ['u2', 'a2', 'u3'],
      '按条数裁会得到 a1,u2,a2,u3（以 assistant 开头）—— 那正是这条测试要挡住的事',
    );
    assert.equal(got[0].role, 'user', '裁剪后的第一条必须仍是 user');
  });

  it('不足 N 轮时一条都不删', async () => {
    const s = new PgSessionStore(client, { maxTurns: 5 });
    await s.append('s1', [u('u1'), a('a1')]);
    assert.equal((await s.load('s1')).length, 2);
  });

  it('完全没有 user 消息时不删（轮次以 user 为界，无从下手）', async () => {
    const s = new PgSessionStore(client, { maxTurns: 1 });
    // 三条而不是一条：一条时 `maxTurns:1` 下"按轮次"与"按条数"的输出相同，
    // 这条测试就咬不住变异。三条时按条数会砍掉 2 条、按轮次一条不动。
    await s.append('s1', [a('孤 1'), a('孤 2'), a('孤 3')]);
    assert.equal((await s.load('s1')).length, 3, '没有 user 就没有轮界，不该删任何东西');
  });

  it('maxTurns 0 = 不裁', async () => {
    const s = new PgSessionStore(client, { maxTurns: 0 });
    for (let i = 1; i <= 5; i++) await s.append('s1', [u(`u${i}`), a(`a${i}`)]);
    assert.equal((await s.load('s1')).length, 10);
  });

  it('构造期拒绝负数 / 小数 / NaN', () => {
    assert.throws(() => new PgSessionStore(client, { maxTurns: -1 }), /maxTurns/);
    assert.throws(() => new PgSessionStore(client, { maxTurns: 1.5 }), /maxTurns/);
    assert.throws(() => new PgSessionStore(client, { maxTurns: Number.NaN }), /maxTurns/);
  });
});

describe('PgSessionStore 的真实边界', () => {
  it('内容含 NUL（\\u0000）→ 可操作的 TypeError，不是 PG 的裸报错', async () => {
    const s = new PgSessionStore(client);
    await assert.rejects(
      () => s.append('s1', [u('前\u0000后')]),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /NUL/);
        assert.match(err.message, /base64|空字节/, '要给出可操作的解法，不能只说存不了');
        return true;
      },
      'jsonb 存不下 \\u0000 —— 这是真边界（PG 报 unsupported Unicode escape sequence）',
    );
  });

  it('prune 删掉整段过期的会话、留下还在活动的，并返回删除条数', async () => {
    let clock = 10_000;
    const s = new PgSessionStore(client, { now: () => clock });
    await s.append('old', [u('x')]);
    clock = 20_000;
    await s.append('new', [u('y')]);

    // cutoff = 20000 - 5000 = 15000 ⇒ old（最后活动 10000）该删，new（20000）该留
    const deleted = await s.prune(5000);
    assert.equal(deleted, 1, 'rowCount 要如实反映删了几行');
    assert.deepEqual(await s.load('old'), []);
    assert.equal((await s.load('new')).length, 1);
  });

  it('prune 不在轮次中间切：跨 cutoff 的那一轮整段保留', async () => {
    // 这是按行删会静默损坏数据的那条边界：某轮的 user 落在 cutoff 之前、
    // assistant 落在之后。按行删 ⇒ 保留下来的历史以 assistant 开头 ⇒ 下一轮 400。
    let clock = 69_000;
    const s = new PgSessionStore(client, { now: () => clock });
    await s.append('s', [u('很久以前的提问')]);
    clock = 71_000; // 同一轮，晚一步写完（长任务 / 时钟差）
    await s.append('s', [a('迟到的回答')]);

    clock = 100_000; // cutoff = 100000 - 30000 = 70000
    const deleted = await s.prune(30_000);

    assert.equal(deleted, 0, '整段没到 cutoff 的会话不该被碰（70_000 之后还有活动）');
    const msgs = await s.load('s');
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant'],
      '整轮都要在 —— 少一半就撞角色交替校验',
    );
  });

  it('prune 不删还在活动的长会话（哪怕开头很旧）', async () => {
    // README 的口径是「删掉 30 天没动过的会话」，不是「删掉 30 天前的消息」。
    let clock = 10_000;
    const s = new PgSessionStore(client, { now: () => clock });
    await s.append('长期会话', [u('第1轮问'), a('第1轮答')]);
    clock = 99_000; // 89_000ms 之后还在聊
    await s.append('长期会话', [u('第2轮问'), a('第2轮答')]);

    clock = 100_000;
    await s.prune(30_000); // cutoff = 70_000：第 1 轮在它之前，但这个会话是活的
    const msgs = await s.load('长期会话');
    assert.equal(msgs.length, 4, '会话整体还活着 ⇒ 一行都不该删');
    assert.equal(msgs[0].role, 'user', '历史开头仍是 user');
  });

  it('合法 JSON 但不是 MessageParam（标量 / null）也响亮抛错', async () => {
    await client.query(
      `INSERT INTO ${names.sessionMessages} (session_id, created_at, payload)
       VALUES ('bad', 1, '"not-a-message"'::jsonb), ('bad', 2, 'null'::jsonb)`,
    );
    const s = new PgSessionStore(client);
    await assert.rejects(() => s.load('bad'), /不是消息对象/);
  });

  it('prune 参数非法 → 响亮失败', async () => {
    const s = new PgSessionStore(client);
    await assert.rejects(() => s.prune(-1), /prune/);
    await assert.rejects(() => s.prune(Number.POSITIVE_INFINITY), /prune/);
  });
});
