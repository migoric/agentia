import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, RedisSessionStore } from '../../src/index.js';
import type { MessageParam, RedisSessionClient } from '../../src/index.js';
import { endTurnMsg } from '../helpers.js';

const user = (text: string): MessageParam => ({ role: 'user', content: text });

/**
 * 内存版 Redis 假客户端：只实现会话这一层用到的四条命令，**命令语义按 Redis 抄**
 * （`lrange` 的 -1 = 末尾、`ltrim` 的负起点由服务端钳位）——
 * 假客户端把语义实现松了，用例就只是在测自己。
 */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  /** 每次 rpush 的键与**实参个数**：分片与 key 形状都靠它断言 */
  const pushes: Array<{ key: string; args: number }> = [];
  const expiries: Array<{ key: string; seconds: number }> = [];
  const trims: string[] = [];

  const resolve = (start: number, len: number): number =>
    start < 0 ? Math.max(len + start, 0) : start;

  const client: RedisSessionClient = {
    async rpush(key, ...values) {
      if (values.length === 0) throw new Error('ERR wrong number of arguments for "rpush"');
      pushes.push({ key, args: values.length });
      const cur = lists.get(key) ?? [];
      for (const v of values) cur.push(v);
      lists.set(key, cur);
      return cur.length;
    },
    async lrange(key, start, stop) {
      const cur = lists.get(key) ?? [];
      const from = resolve(start, cur.length);
      const to = stop < 0 ? cur.length + stop : stop;
      return cur.slice(from, to + 1);
    },
    async ltrim(key, start, stop) {
      const cur = lists.get(key) ?? [];
      const from = resolve(start, cur.length);
      const to = stop < 0 ? cur.length + stop : stop;
      trims.push(key);
      lists.set(key, cur.slice(from, to + 1));
      return 'OK';
    },
    async expire(key, seconds) {
      expiries.push({ key, seconds });
      return 1;
    },
  };

  return { client, lists, pushes, expiries, trims };
}

/** 只提供读写的客户端（用来验「设了旋钮但客户端不支持」的构造期报错） */
function bareClient(): RedisSessionClient {
  return {
    async rpush() {
      return 0;
    },
    async lrange() {
      return [];
    },
  };
}

describe('RedisSessionStore：多副本共享同一段对话历史', () => {
  it('两个实例（模拟两个 pod）读到同一段历史 —— 这条就是它存在的理由', async () => {
    const { client } = fakeRedis();
    const podA = new RedisSessionStore(client);
    const podB = new RedisSessionStore(client);

    await podA.append('s1', [user('第一问'), { role: 'assistant', content: '第一答' }]);
    assert.deepEqual(await podB.load('s1'), [
      user('第一问'),
      { role: 'assistant', content: '第一答' },
    ]);
  });

  it('key 形状：`<prefix>session:<id>`，缺省前缀 agentia:', async () => {
    const { client, pushes } = fakeRedis();
    await new RedisSessionStore(client).append('s1', [user('x')]);
    assert.equal(pushes[0]!.key, 'agentia:session:s1');
    await new RedisSessionStore(client, { prefix: 't:' }).append('s1', [user('x')]);
    assert.equal(pushes[1]!.key, 't:session:s1');
  });

  it('append 是追加而不是覆盖（两次调用顺序保留）', async () => {
    const { client } = fakeRedis();
    const store = new RedisSessionStore(client);
    await store.append('s1', [user('1')]);
    await store.append('s1', [user('2')]);
    assert.deepEqual(await store.load('s1'), [user('1'), user('2')]);
  });

  it('空数组不碰 Redis（不创建空键、也不刷新 TTL）', async () => {
    const { client, pushes, expiries } = fakeRedis();
    const store = new RedisSessionStore(client, { ttlSeconds: 60 });
    await store.append('s1', []);
    assert.equal(pushes.length, 0);
    assert.equal(expiries.length, 0, '「什么都没写」不该把 TTL 续上');
  });

  it('十几万条也分片发送：单次 rpush 实参不超过 512，且不抛 RangeError', async () => {
    // 不分片的话 `rpush(key, ...payload)` 在约 13 万实参时抛 RangeError，
    // 而 executeRun 的 appendSession 会把异常吞成一行 warn ⇒ 那一轮对话白聊。
    const { client, pushes } = fakeRedis();
    const store = new RedisSessionStore(client);
    const many: MessageParam[] = Array.from({ length: 130_000 }, (_, i) => user(`m${i}`));
    await store.append('s1', many);
    assert.ok(pushes.length > 1, '必须真的分了多次');
    assert.ok(
      pushes.every((p) => p.args <= 512),
      `单次实参过多：${Math.max(...pushes.map((p) => p.args))}`,
    );
    assert.equal((await store.load('s1')).length, 130_000);
  });

  it('maxMessages 只留最后 N 条；缺省 0 = 不裁（一次 ltrim 都不调）', async () => {
    const { client, trims } = fakeRedis();
    const plain = new RedisSessionStore(client);
    await plain.append('s1', [user('1'), user('2'), user('3')]);
    assert.equal(trims.length, 0, '缺省不该裁');

    const capped = new RedisSessionStore(client, { maxMessages: 2 });
    await capped.append('s1', [user('4')]);
    assert.deepEqual(await capped.load('s1'), [user('3'), user('4')]);
    assert.equal(trims.length, 1);
  });

  it('列表短于 maxMessages 时不裁坏（-N 起点由服务端钳位，不必先问长度）', async () => {
    const { client } = fakeRedis();
    const store = new RedisSessionStore(client, { maxMessages: 10 });
    await store.append('s1', [user('1'), user('2')]);
    assert.deepEqual(await store.load('s1'), [user('1'), user('2')]);
  });

  it('每次 append 都刷新 TTL（语义是「多久没动静就回收」）', async () => {
    const { client, expiries } = fakeRedis();
    const store = new RedisSessionStore(client, { ttlSeconds: 30 });
    await store.append('s1', [user('1')]);
    await store.append('s1', [user('2')]);
    assert.equal(expiries.length, 2);
    assert.deepEqual(expiries[0], { key: 'agentia:session:s1', seconds: 30 });
  });

  it('损坏元素**响亮抛错**（带上键名与序号），不静默跳过', async () => {
    const { client, lists } = fakeRedis();
    const store = new RedisSessionStore(client);
    await store.append('s1', [user('1'), user('2')]);
    const cur = lists.get('agentia:session:s1')!;
    cur[1] = '{"role":"user","content":'; // 半条 JSON

    await assert.rejects(
      () => store.load('s1'),
      (err: Error) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /agentia:session:s1/, '要能一眼定位是哪个键');
        assert.match(err.message, /第 1 项/, '要指出是哪一项');
        return true;
      },
    );
  });
});

describe('RedisSessionStore 的构造期校验（坏值不许静默失效）', () => {
  const build = (opts: Record<string, unknown>, client = bareClient()): (() => unknown) => {
    return () => new RedisSessionStore(client, opts);
  };

  it('prefix 空串拒绝（会与其他命名空间混用）', () => {
    assert.throws(build({ prefix: '' }), /prefix 不能为空串/);
  });

  it('ttlSeconds：NaN / 负数 / 小数 一律拒绝（NaN 会让 TTL 静默失效）', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => build({ ttlSeconds: bad })(),
        /ttlSeconds 必须为 ≥ 0 的整数/,
        String(bad),
      );
    }
  });

  it('maxMessages：负数 / 小数 / NaN 一律拒绝', () => {
    for (const bad of [-1, 2.5, Number.NaN]) {
      assert.throws(
        () => build({ maxMessages: bad })(),
        /maxMessages 必须为 ≥ 0 的安全整数/,
        String(bad),
      );
    }
  });

  it('设了 ttlSeconds > 0 但客户端没有 expire ⇒ 构造期抛（否则键永不过期）', () => {
    assert.throws(build({ ttlSeconds: 60 }), /没有 expire/);
  });

  it('设了 maxMessages > 0 但客户端没有 ltrim ⇒ 构造期抛（否则列表无界增长）', () => {
    assert.throws(build({ maxMessages: 5 }), /没有 ltrim/);
  });

  it('客户端缺 rpush / lrange ⇒ 构造期抛', () => {
    const broken = { lrange: async () => [] } as unknown as RedisSessionClient;
    assert.throws(() => new RedisSessionStore(broken), /需要 client 提供 rpush \/ lrange/);
  });
});

describe('RedisSessionStore 接进 executeRun（换 pod 不丢上文）', () => {
  /** 记录**发送时刻**快照的 client（同 session.test.ts 的理由：mockClient 存的是引用） */
  function capturingClient(script: Array<Record<string, unknown>>) {
    const sent: MessageParam[][] = [];
    let i = 0;
    return {
      sent,
      client: {
        messages: {
          stream: (params: { messages: MessageParam[] }) => {
            sent.push(structuredClone(params.messages));
            return {
              on() {},
              finalMessage: async () => {
                const step = script[i++];
                if (!step) throw new Error(`mock 脚本耗尽（第 ${i} 次调用）`);
                return step;
              },
            };
          },
        },
      } as never,
    };
  }

  it('第一轮在 pod A、第二轮在 pod B：历史仍然接得上', async () => {
    const { client: redis } = fakeRedis();
    const podA = new RedisSessionStore(redis);
    const podB = new RedisSessionStore(redis);

    const c1 = capturingClient([endTurnMsg('第一答')]);
    await executeRun({
      messages: [user('第一问')],
      client: c1.client,
      session: { store: podA, id: 'u1' },
    });

    const c2 = capturingClient([endTurnMsg('第二答')]);
    await executeRun({
      messages: [user('第二问')],
      client: c2.client,
      session: { store: podB, id: 'u1' },
    });

    assert.deepEqual(
      c2.sent[0],
      [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ],
      'pod B 必须看到 pod A 写下的那一轮（否则就是「第一次见面」）',
    );
  });

  it('不同 sessionId 互不干扰（同一 Redis、同一前缀）', async () => {
    const { client: redis } = fakeRedis();
    const store = new RedisSessionStore(redis);
    const c1 = capturingClient([endTurnMsg('A 的答')]);
    await executeRun({ messages: [user('A')], client: c1.client, session: { store, id: 'a' } });
    const c2 = capturingClient([endTurnMsg('B 的答')]);
    await executeRun({ messages: [user('B')], client: c2.client, session: { store, id: 'b' } });
    assert.deepEqual(c2.sent[0], [user('B')], 'b 会话不该看到 a 的历史');
  });
});
