import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, executeRun, SystemPrompt } from '../../src/index.js';
import type { AgentTool } from '../../src/index.js';
import { RunContext } from '../../src/index.js';
import { InMemoryMemoryStore } from '../../src/runtime/memory.js';
import type { MemoryStore } from '../../src/runtime/memory.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const SCHEMA = { type: 'object', properties: {} };

/** 读 blackboard 指定 key 并返回的工具 */
function readTool(key: string): AgentTool {
  return {
    name: 'read_key',
    description: 'd',
    inputSchema: SCHEMA,
    run: () => String(RunContext.current()?.get(key) ?? 'none'),
  };
}

/** 写 blackboard 指定 key 的工具 */
function writeTool(key: string, value: unknown): AgentTool {
  return {
    name: 'write_key',
    description: 'd',
    inputSchema: SCHEMA,
    run: () => {
      RunContext.current()!.set(key, value);
      return 'written';
    },
  };
}

describe('MemoryStore 跨 run 记忆', () => {
  it('run 开始水合进 blackboard：工具内 RunContext.current().get 可读', async () => {
    const store = new InMemoryMemoryStore();
    store.save({ city: '北京' });

    const { client, seen } = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    const { run } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('city')],
      client,
      memory: { store, keys: ['city'] },
    });

    assert.equal(run.status, 'succeeded');
    assert.ok(JSON.stringify(seen[1]).includes('北京'), '工具读到了水合的记忆值');
  });

  it('app.run 同一条缝：memory 选项在 run 前水合、收尾回写（与 session 一致的程序内边界）', async () => {
    // 官网手写文档一直用 `app.run(messages, { memory })` 演示记忆 —— 这条用例把那个承诺
    // 变成可执行的：`memory` 与 `session` 一样要能经 app.run 传下去（此前 app.run 只转发
    // session，memory 在 RunAppOptions 里根本不存在，文档里的写法静默失效）。
    const store = new InMemoryMemoryStore();
    store.save({ city: '上海' });
    const app = createApp({
      name: 'mem-app',
      system: new SystemPrompt().add('role', 'r', true),
      tools: [readTool('city'), writeTool('count', 7)],
    });

    // 水合：工具经 RunContext 读到 store 里的值
    const hydrated = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await app.run([{ role: 'user', content: 'go' }], {
      client: hydrated.client,
      memory: { store, keys: ['city'] },
    });
    assert.ok(JSON.stringify(hydrated.seen[1]).includes('上海'), 'app.run 的水合生效');

    // 回写：run 收尾把 blackboard 当前值 save 回 store
    const flushing = mockClient([toolUseMsg('write_key', {}), endTurnMsg('ok')]);
    await app.run([{ role: 'user', content: 'go' }], {
      client: flushing.client,
      memory: { store, keys: ['count'] },
    });
    assert.deepEqual({ ...store.load(['count']) }, { count: 7 }, 'app.run 的回写生效');
  });

  it('run 结束回写：blackboard 当前值 save 回 store，下一次 run 可读到', async () => {
    const store = new InMemoryMemoryStore();

    // 第一次 run：工具写入 count=41
    const first = mockClient([toolUseMsg('write_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeTool('count', 41)],
      client: first.client,
      memory: { store, keys: ['count'] },
    });
    assert.deepEqual({ ...store.load(['count']) }, { count: 41 });

    // 第二次 run（同 store）：水合进 blackboard，工具读到上次的值
    const second = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('count')],
      client: second.client,
      memory: { store, keys: ['count'] },
    });
    assert.ok(JSON.stringify(second.seen[1]).includes('41'), '跨 run 读到了上次回写的值');
  });

  it('contextInit 优先于 memory：不覆盖用户种子', async () => {
    const store = new InMemoryMemoryStore();
    store.save({ k: 'fromStore' });

    const { client, seen } = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('k')],
      client,
      contextInit: (ctx) => ctx.set('k', 'seed'),
      memory: { store, keys: ['k'] },
    });

    assert.ok(JSON.stringify(seen[1]).includes('seed'), 'blackboard 保留 contextInit 种子');
    assert.ok(!JSON.stringify(seen[1]).includes('fromStore'), 'memory 未覆盖同名 key');
    // 回写的是 blackboard 当前值（即种子）；load 返回无原型对象，展开成普通对象再比对
    assert.deepEqual({ ...store.load(['k']) }, { k: 'seed' });
  });

  it('失败 run 也回写', async () => {
    const store = new InMemoryMemoryStore();
    // 第一回合工具写值，第二回合 client 抛错 → run 失败
    const failing = {
      messages: {
        stream: (() => {
          let n = 0;
          return () => {
            n++;
            return {
              on() {},
              finalMessage: async () => {
                if (n === 1) return toolUseMsg('write_key', {});
                throw new Error('api boom');
              },
            };
          };
        })(),
      },
    };

    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeTool('progress', 'half')],
      client: failing as never,
      memory: { store, keys: ['progress'] },
      rethrow: false,
    });

    assert.equal(run.status, 'failed');
    assert.match(result.error?.message ?? '', /api boom/);
    assert.deepEqual({ ...store.load(['progress']) }, { progress: 'half' });
  });

  it('水合只认自有键：key 撞 Object.prototype 属性（toString）不被当记忆值灌进黑板', async () => {
    const store: MemoryStore = { load: () => ({}), save: () => {} }; // 自有键为空
    const { client, seen } = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('toString')], // `'toString' in {}` 为 true（继承属性）
      client,
      memory: { store, keys: ['toString'] },
    });
    assert.ok(
      JSON.stringify(seen[1]).includes('none'),
      '未水合的 key 应读到 none，而不是原型上的函数',
    );
  });

  it('回写键名 __proto__ 不被吞（entries 用无原型对象）', async () => {
    const saved: Record<string, unknown>[] = [];
    const store: MemoryStore = {
      load: () => ({}),
      save: (entries) => {
        saved.push({ ...entries });
      },
    };
    const { client } = mockClient([toolUseMsg('write_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeTool('__proto__', 'v42')],
      client,
      memory: { store, keys: ['__proto__'] },
    });
    assert.equal(saved.length, 1);
    // {} 字面量上赋 __proto__ 会走原型 setter（改原型而非建属性）→ 值静默丢失
    assert.equal(Object.getOwnPropertyDescriptor(saved[0], '__proto__')?.value, 'v42');
  });

  it('成功 run 的回写失败不翻状态：仍是 succeeded，结果与 trace 都在', async () => {
    const store: MemoryStore = {
      load: () => ({}),
      save: () => {
        throw new Error('disk full'); // 同步抛：fs 写失败的真实现形态
      },
    };
    const { client } = mockClient([endTurnMsg('ok')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('k')],
      client,
      memory: { store, keys: ['k'] },
    });

    assert.equal(run.status, 'succeeded', '回写失败不得把成功的 run 翻成 failed');
    assert.equal(result.finalText, 'ok');
    assert.equal(result.error, undefined);
    assert.ok(result.trace.spans.length > 0, 'trace 不因回写失败而丢');
  });

  it('异步 store（Promise 形态 load/save）同样接线', async () => {
    const data = new Map<string, unknown>([['k', 'async-v']]);
    const saved: Record<string, unknown>[] = [];
    const store: MemoryStore = {
      load: async (keys) =>
        Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)])),
      save: async (entries) => {
        saved.push(entries);
        Object.assign(data, entries);
      },
    };

    const { client, seen } = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('k')],
      client,
      memory: { store, keys: ['k'] },
    });

    assert.ok(JSON.stringify(seen[1]).includes('async-v'));
    // save 收到的是**无原型对象**（见 flushMemory）——展开成普通对象再比对
    assert.deepEqual(
      saved.map((e) => ({ ...e })),
      [{ k: 'async-v' }],
    );
  });

  it('水合 load 失败：不杀死 run（当无记忆继续），但**不回写**（避免覆盖没读到的记忆）', async () => {
    const saved: Record<string, unknown>[] = [];
    const store: MemoryStore = {
      load: () => {
        throw new Error('redis down'); // 水合是辅助动作：store 故障不得击穿主路径
      },
      save: (entries) => {
        saved.push({ ...entries });
      },
    };
    const { client } = mockClient([toolUseMsg('write_key', {}), endTurnMsg('ok')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeTool('k', 'v')],
      client,
      memory: { store, keys: ['k'] },
    });

    assert.equal(run.status, 'succeeded', '水合失败不得把 run 打成 failed');
    assert.equal(result.finalText, 'ok');
    assert.equal(result.error, undefined);
    // 读失败 ⇒ 没有基线，禁止回写：否则本次 run 的默认值会覆盖库里没读到的真实记忆
    assert.deepEqual(saved, []);
  });

  it('load 用无原型对象：__proto__ 键不被吞（与 flushMemory 对称）', () => {
    const store = new InMemoryMemoryStore();
    // 字面量 { __proto__: x } 会设原型而非自有键 —— 显式造一个自有 __proto__ 键
    const entries: Record<string, unknown> = {};
    Object.defineProperty(entries, '__proto__', {
      value: 'kept',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    store.save(entries);

    const loaded = store.load(['__proto__']);
    assert.ok(
      Object.hasOwn(loaded, '__proto__'),
      'load 结果必须含自有 __proto__ 键（不能静默丢失）',
    );
    // biome-ignore lint/suspicious/noProto lint/complexity/useLiteralKeys: 本条就是在钉 __proto__ 污染防护，必须显式写出该字面量（点访问写法反而看不出测的是什么）
    assert.equal((loaded as Record<string, unknown>)['__proto__'], 'kept');
    assert.equal(Object.getPrototypeOf(loaded), null, '无原型，绝不污染 Object.prototype');
  });
});

describe('MemoryStore 版本号（CAS）—— 并发丢写不再无声', () => {
  /** 捕获 console.warn（包住一段 await）：断言「出声」这件事真的发生了，而不是只写在注释里 */
  async function captureWarn<T>(fn: () => Promise<T>): Promise<{ warnings: string[]; value: T }> {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      return { warnings, value: await fn() };
    } finally {
      console.warn = orig;
    }
  }

  /** 写某 key 的 run（用 writeTool：run 内改黑板，收尾回写） */
  function runOnce(store: MemoryStore, keys: string[], key: string, value: unknown) {
    return executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeTool(key, value)],
      client: mockClient([toolUseMsg('write_key', {}), endTurnMsg('ok')]).client,
      memory: { store, keys },
    });
  }

  it('带版本号的 store：回写走 CAS（saveIfRev），不再走无版本号的 save；提交成功不出声', async () => {
    const plain = new InMemoryMemoryStore();
    plain.save({ k: 'seed' });
    const viaCas: unknown[] = [];
    const store: MemoryStore = {
      load: (keys) => plain.load(keys),
      save: (entries) => {
        viaCas.push('save'); // 走到这里 = 回写没走 CAS
        plain.save(entries);
      },
      loadWithRev: (keys) => plain.loadWithRev(keys),
      saveIfRev: (entries, rev) => plain.saveIfRev(entries, rev),
    };

    const { warnings, value } = await captureWarn(() => runOnce(store, ['k'], 'k', 'v'));
    assert.equal(value.run.status, 'succeeded');
    assert.deepEqual({ ...plain.load(['k']) }, { k: 'v' }, 'CAS 提交成功 ⇒ 值落库');
    assert.deepEqual(viaCas, [], '有版本号就不该退回无版本号的 save');
    assert.deepEqual(warnings, [], '提交成功是常态，不该出声');
  });

  it('CAS store 水合失败：跳过 CAS 回写（saveIfRev 零调用）+ 归因说「读失败」而非「并发」（外部深评 A1）', async () => {
    let saveIfRevCalls = 0;
    let saveCalls = 0;
    // 有 saveIfRev ⇒ 框架走 CAS 分支（对齐上面「带版本号的 store」那条：不走无版本号的 save）。
    // load/save 是接口必需成员，此处只作占位 —— 断言它们**不被调用**才是有意义的。
    const store: MemoryStore = {
      load: () => ({}),
      save: () => {
        saveCalls++;
      },
      loadWithRev: () => {
        throw new Error('redis down'); // 水合失败是辅助动作：不击穿 run
      },
      saveIfRev: () => {
        saveIfRevCalls++;
        return { committed: true };
      },
    };
    const { warnings, value } = await captureWarn(() => runOnce(store, ['k'], 'k', 'v'));
    assert.equal(value.run.status, 'succeeded', '水合失败不得打死 run（辅助动作）');
    assert.equal(saveIfRevCalls, 0, '水合失败 ⇒ 不做 CAS 回写（读都没成功，CAS 没有意义）');
    assert.equal(saveCalls, 0, '有 saveIfRev 的 store 不许退回无版本号的 save（跳过 ≠ 降级）');
    const all = warnings.join('\n');
    assert.match(all, /水合.*失败/, '要留下「水合失败」这个第一因（此前完全无声）');
    assert.match(all, /不是.*并发/, '归因必须说「读失败」，不许说成「并发抢写」');
    assert.doesNotMatch(all, /并发的 run 在你读之后写过/, '旧的假归因文案不许再出现');
  });

  it('并发丢写被抓：读之后别人写过同一份 store ⇒ 本次回写被拒、一个字都不写、并出声', async () => {
    const store = new InMemoryMemoryStore();
    store.save({ memo: 'old' }); // 水合读到的版本 = 1

    // 「另一条并发 run」：在本 run 的水合之后、回写之前提交（工具执行期就是这么个窗口）
    const concurrentWriter: AgentTool = {
      name: 'other_run',
      description: 'd',
      inputSchema: SCHEMA,
      run: () => {
        store.save({ memo: 'other-run' }); // 版本 1 → 2：本条 run 手上的 rev 就此过期
        return 'ok';
      },
    };
    const { warnings, value } = await captureWarn(() =>
      executeRun({
        messages: [{ role: 'user', content: 'go' }],
        tools: [writeTool('memo', 'mine'), concurrentWriter],
        client: mockClient([
          toolUseMsg('write_key', {}),
          toolUseMsg('other_run', {}),
          endTurnMsg('ok'),
        ]).client,
        memory: { store, keys: ['memo'] },
      }),
    );

    assert.equal(value.run.status, 'succeeded', '回写被拒是辅助动作失败，不改 run 状态');
    assert.equal(
      Object.assign({}, store.load(['memo'])).memo,
      'other-run',
      '冲突时一个字都不写：别人的值原样在，不合并、不覆盖',
    );
    assert.equal(warnings.length, 1, '冲突 = 恰好一条告警');
    assert.match(warnings[0]!, /记忆回写被拒绝/);
    assert.match(warnings[0]!, /conflict/);
    assert.match(warnings[0]!, /memo/, '告警要能看出是哪些 keys 丢了回写');
  });

  it('无版本号的 store：出声降级（每个实例只说一次，连跑两条 run 也只一条提示）', async () => {
    const saves: Record<string, unknown>[] = [];
    const store: MemoryStore = {
      load: () => ({}),
      save: (entries) => {
        saves.push({ ...entries });
      },
    };

    const { warnings, value } = await captureWarn(async () => {
      const first = await runOnce(store, ['k'], 'k', 'v1');
      const second = await runOnce(store, ['k'], 'k', 'v2');
      return { first, second };
    });

    assert.equal(value.first.run.status, 'succeeded');
    assert.equal(value.second.run.status, 'succeeded');
    assert.equal(saves.length, 2, '不支持版本号 = 保持旧行为（照旧 save）');
    assert.equal(warnings.length, 1, '提示按**实例**去重：不是每轮 run 都吵');
    assert.match(warnings[0]!, /last-write-wins/);
    assert.match(warnings[0]!, /loadWithRev/, '提示要给出路：实现哪两个成员');
  });

  it('半个 CAS 一律入口拒：只实现 loadWithRev 抛 TypeError（不被「辅助动作」吞掉）', async () => {
    const store: MemoryStore = {
      load: () => ({}),
      save: () => {},
      loadWithRev: () => ({ values: {}, rev: 1 }),
    };
    await assert.rejects(
      () => runOnce(store, ['k'], 'k', 'v'),
      /必须成对实现.*只实现了 loadWithRev/s,
    );
  });

  it('半个 CAS 一律入口拒：只实现 saveIfRev 同样抛（反方向）', async () => {
    const store: MemoryStore = {
      load: () => ({}),
      save: () => {},
      saveIfRev: () => ({ committed: true }),
    };
    await assert.rejects(
      () => runOnce(store, ['k'], 'k', 'v'),
      /必须成对实现.*只实现了 saveIfRev/s,
    );
  });

  it('saveIfRev 忘返回结果（undefined）⇒ 按「未提交」处理并出声（宁可多报，不记成写成功）', async () => {
    const store: MemoryStore = {
      load: () => ({}),
      save: () => {},
      loadWithRev: () => ({ values: {}, rev: 1 }),
      // 半成品实现：写了但没回结果 —— 契约要求 `{ committed }`，这里模拟「没遵守」
      // 断言用 NonNullable：`MemoryStore['saveIfRev']` 含 `| undefined`（可选成员），
      // 本对象字面量在 exactOptionalPropertyTypes 下不允许把可能 undefined 的值赋给可选属性
      saveIfRev: (() => undefined) as unknown as NonNullable<MemoryStore['saveIfRev']>,
    };
    const { warnings, value } = await captureWarn(() => runOnce(store, ['k'], 'k', 'v'));
    assert.equal(value.run.status, 'succeeded');
    assert.equal(warnings.length, 1, '「不知道写没写」也要出声');
    assert.match(warnings[0]!, /未确认/);
  });
});
