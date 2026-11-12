import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextPolicy, MessageParam } from '../../src/index.js';
import { createBudgetPolicy, runAgent } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/** 4 条普通消息（> keepRecent=2，保证压缩真的会调 summarize） */
function fourMessages(): MessageParam[] {
  return [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
  ];
}

describe('createBudgetPolicy 的 per-run 状态隔离（ContextPolicy.forRun）', () => {
  it('同一策略实例连跑两条 run：压缩滞回不跨 run 泄漏（两条 run 都照常压缩）', async () => {
    let summarizeCalls = 0;
    // 应用级单例的典型形态：同一个策略实例被所有 run 复用（AppOptions.contextPolicy）
    const shared = createBudgetPolicy({
      budgetTokens: 1, // 永远超预算 → 每回合都走降级分支
      keepRecent: 2,
      compactEvery: 10, // 滞回窗口刻意拉大：不隔离的话第二条 run 前 10 回合永不压缩
      summarize: () => {
        summarizeCalls++;
        return '摘要';
      },
    });

    const first = await runAgent({
      client: mockClient([endTurnMsg('done')]).client,
      messages: fourMessages(),
      contextPolicy: shared,
    });
    assert.equal(first.stopReason, 'end_turn');
    assert.equal(summarizeCalls, 1, '第一条 run 的回合 0 即压缩（lastCompactAt 初始 -∞）');

    const second = await runAgent({
      client: mockClient([endTurnMsg('done')]).client,
      messages: fourMessages(),
      contextPolicy: shared,
    });
    assert.equal(second.stopReason, 'end_turn');
    assert.equal(
      summarizeCalls,
      2,
      '第二条 run 必须同样能在自己的回合 0 压缩 —— 不被上一条 run 的 lastCompactAt 卡住',
    );
  });

  it('forRun 产物互不影响：fork 出的实例压缩过，不影响下一次 forRun 的滞回起点', async () => {
    let summarizeCalls = 0;
    const policy = createBudgetPolicy({
      budgetTokens: 1,
      keepRecent: 2,
      compactEvery: 10,
      summarize: () => {
        summarizeCalls++;
        return '摘要';
      },
    });
    const msgs1 = fourMessages();
    const fork1 = policy.forRun!();
    await fork1.beforeTurn(msgs1, { iteration: 0, model: 'm' });
    assert.equal(summarizeCalls, 1);
    // 同一 fork 内滞回生效：iteration 1 距上次压缩 1 < 10 → 不再压缩
    const msgs1b = fourMessages();
    await fork1.beforeTurn(msgs1b, { iteration: 1, model: 'm' });
    assert.equal(summarizeCalls, 1, '滞回在**同一 run 内**仍然生效');
    // 新 fork（= 新 run）滞回从零开始
    const fork2 = policy.forRun!();
    await fork2.beforeTurn(fourMessages(), { iteration: 0, model: 'm' });
    assert.equal(summarizeCalls, 2, '新 run 的滞回起点必须独立');
  });

  it('未实现 forRun 的自定义策略：原样复用（向后兼容），beforeTurn 正常被调', async () => {
    let calls = 0;
    const custom = {
      budgetTokens: 100,
      async beforeTurn(messages: MessageParam[]): Promise<MessageParam[]> {
        calls++;
        return messages;
      },
    };
    const result = await runAgent({
      client: mockClient([endTurnMsg('done')]).client,
      messages: [{ role: 'user', content: 'go' }],
      contextPolicy: custom,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(calls, 1, '无状态自定义策略不需要 forRun 也能用');
  });
});

describe('beforeTurn 失败降级（2026-09-28）', () => {
  it('策略抛错 → run 照常跑完，且 run 根留下 context.policy_failed（出声不静默）', async () => {
    // 为什么必须降级：`beforeTurn` 里可能**走网络**（compaction 的 summarize 是模型调用），
    // 一次 429 / 超时不该把整条 run 判死 —— 上下文压缩是尽力而为的优化，不是 run 的前置条件。
    let calls = 0;
    const boom: ContextPolicy = {
      async beforeTurn(): Promise<MessageParam[]> {
        calls++;
        throw new Error('summarize 429');
      },
    };
    const result = await runAgent({
      client: mockClient([endTurnMsg('done')]).client,
      messages: [{ role: 'user', content: 'go' }],
      contextPolicy: boom,
    });

    assert.equal(result.stopReason, 'end_turn', '压缩失败不得改判 run 的收尾方式');
    assert.equal(result.finalText, 'done', '消息照原样发出（降级 = 本回合不压缩）');
    assert.equal(calls, 1, '降级的是「失败处理」，不是调用点 —— 每回合仍照调');
    const root = result.trace.spans.find((s) => s.kind === 'run');
    const ev = root?.events.find((e) => e.name === 'context.policy_failed');
    assert.ok(ev, '失败必须出声（run 根事件），否则「历史一直很长」没人知道为什么');
    assert.deepEqual(ev.body, { iteration: 0, message: 'summarize 429' });
  });

  it('压缩失败不烧滞回额度：下一回合仍会重试（滞回记的是「上次成功」）', async () => {
    let calls = 0;
    const policy = createBudgetPolicy({
      budgetTokens: 1, // 永远超预算 ⇒ 每回合都走降级分支
      keepRecent: 2,
      compactEvery: 10, // 滞回窗口刻意拉大：把「失败」记成「上次压缩」的话，后面 9 回合都不再试
      summarize: () => {
        calls++;
        if (calls === 1) throw new Error('429 from summarizer');
        return '摘要';
      },
    });
    const perRun = policy.forRun!();

    await assert.rejects(
      () => perRun.beforeTurn(fourMessages(), { iteration: 0, model: 'm' }),
      /429 from summarizer/,
    );
    assert.equal(calls, 1);
    const out = await perRun.beforeTurn(fourMessages(), { iteration: 1, model: 'm' });
    assert.equal(calls, 2, '失败不记额度 ⇒ 下一回合重试（旧实现在这里会跳过）');
    assert.ok(JSON.stringify(out).includes('摘要'), '第二回合真的压成了');
  });
});

/** 5 对相邻的 tool_use / tool_result（trimToolPairs 的标准输入） */
function tenToolMessages(): MessageParam[] {
  const out: MessageParam[] = [];
  for (let i = 0; i < 5; i++) {
    out.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }],
    });
    out.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r' }],
    });
  }
  return out;
}

describe('createBudgetPolicy 的坏值与摘要失败回退（2026-11-13 ref-checklist-four）', () => {
  it('四个数量旋钮的坏值构造期抛 TypeError；0 与缺省仍按存量读法放行', () => {
    const keys = ['budgetTokens', 'keepRecent', 'keepToolPairs', 'compactEvery'] as const;
    const bad = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
      '2',
      null,
    ];
    for (const key of keys) {
      for (const value of bad) {
        assert.throws(
          () => createBudgetPolicy({ [key]: value } as never),
          (e: unknown) => e instanceof TypeError && /非负安全整数/.test((e as Error).message),
          `${key}=${String(value)} 必须响亮失败（NaN 会让预算/滞回判据恒假）`,
        );
      }
      // 0 不是坏值：本轮刻意不改它的读法（Math.max 钳位是存量行为）
      assert.doesNotThrow(() => createBudgetPolicy({ [key]: 0 } as never));
    }
    assert.doesNotThrow(() => createBudgetPolicy());
  });

  it('没有引擎降级出口时，摘要失败照旧抛（向后兼容单测 / 自定义宿主）', async () => {
    const policy = createBudgetPolicy({
      budgetTokens: 0,
      keepToolPairs: 3,
      keepRecent: 2,
      summarize: () => {
        throw new Error('429 from summarizer');
      },
    });
    await assert.rejects(
      () => policy.beforeTurn(tenToolMessages(), { iteration: 0, model: 'm' }),
      /429 from summarizer/,
    );
  });

  it('有引擎降级出口时，摘要失败只丢压缩、不丢已做完的 context editing', async () => {
    const failures: string[] = [];
    const policy = createBudgetPolicy({
      budgetTokens: 0, // 永远超预算，保证走到 compaction
      keepToolPairs: 3, // 10 条 → 6 条（留 3 对）
      keepRecent: 2, // 6 > 2 ⇒ 真的会调 summarize
      summarize: () => {
        throw new Error('429 from summarizer');
      },
    });
    const messages = tenToolMessages();
    const out = await policy.beforeTurn(messages, {
      iteration: 0,
      model: 'm',
      onCompactionFailure: (m) => failures.push(m),
    });
    assert.deepEqual(failures, ['429 from summarizer'], '失败必须上报，不能静默');
    assert.equal(messages.length, 10);
    assert.equal(
      out.length,
      6,
      '旧行为会把 next 留在 undefined ⇒ 连 10→6 的编辑结果一起丢；现在必须留住',
    );
  });

  it('集成：run 照常跑完、run 根仍留 context.policy_failed、请求里是裁剪后的消息', async () => {
    const { client, seen } = mockClient([endTurnMsg('done')]);
    const warn = console.warn;
    console.warn = () => {}; // 降级必然 warn，测试里不刷屏
    try {
      const result = await runAgent({
        client,
        messages: tenToolMessages(),
        contextPolicy: createBudgetPolicy({
          budgetTokens: 0,
          keepToolPairs: 3,
          keepRecent: 2,
          summarize: () => {
            throw new Error('429 from summarizer');
          },
        }),
      });
      assert.equal(result.stopReason, 'end_turn');
      const root = result.trace.spans.find((s) => s.kind === 'run');
      const ev = root?.events.find((e) => e.name === 'context.policy_failed');
      assert.ok(ev, '两条降级路径共用同一个出声出口，事件不能丢');
      assert.match(String((ev.body as { message?: string }).message), /429/);
      // ⚠️ `mockClient` 的 seen 存的是 params **引用**，请求返回后引擎还会往同一个
      // messages 数组里 push 本轮 assistant 消息 ⇒ 事后读长度会多 1。用「旧工具对在不在」
      // 这个内容判据，既不受引用共享影响，也直接证明编辑真的生效了。
      const sent = (seen[0] as { messages: unknown[] }).messages;
      assert.ok(sent.length <= 7, `请求里的消息应已被裁剪，实际 ${sent.length} 条`);
      const raw = JSON.stringify(sent);
      assert.ok(!raw.includes('t0') && !raw.includes('t1'), '被裁掉的旧工具对不该再发出去');
      assert.ok(raw.includes('t4'), '最近的工具对仍在');
    } finally {
      console.warn = warn;
    }
  });
});
