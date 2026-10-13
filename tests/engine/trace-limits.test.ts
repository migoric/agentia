import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder, createApp, SystemPrompt, scriptedClient, Tool } from '../../src/index.js';
// 模块级件（不进公共导出面，与 transport/task-events 同款）：用例直接引模块
import { resolveTraceLimits } from '../../src/engine/tracer.js';

/**
 * 记账的数量闸（`traceLimits.maxEvents`，spec §9.4 的答案里「让少记了数据可数」那一半）。
 *
 * 守两件事：**上限真的生效**（不是设了没用），且**少记的部分可数**（不是静默丢）。
 * 坏值那条守的是「设了但没生效」这个具体事故形态（NaN 会让 `>=` 恒假 ⇒ 闸门形同不存在）。
 */

/** 直接对 recorder 造事件：本文件关心的是闸门与计数，不关心事件语义 */
function fill(r: TraceRecorder, n: number): void {
  const root = r.begin('run', 'app', null);
  for (let i = 0; i < n; i++) r.event(root, 'x', i);
}

describe('traceLimits.maxEvents（事件总量闸）', () => {
  it('缺省（不设）= 不限：全量记账（本框架的承诺）', () => {
    const r = new TraceRecorder();
    fill(r, 50);
    const trace = r.snapshot('ok');
    const events = trace.spans[0]!.events;
    assert.equal(events.length, 50);
    assert.equal(
      events.some((e) => e.name === 'trace.truncated'),
      false,
      '没超限却写了截断摘要 —— 会让人以为数据不全',
    );
  });

  it('超限即停止记账，并在 run 根留两笔 trace.truncated（起点标记 + 收尾摘要，不静默）', () => {
    const r = new TraceRecorder({ maxEvents: 3 });
    fill(r, 10);
    const trace = r.snapshot('ok');
    const events = trace.spans[0]!.events;
    const marks = events.filter((e) => e.name === 'trace.truncated');
    assert.equal(marks.length, 2, '截断该留两笔：起点标记（位置）+ 收尾摘要（计数）');
    assert.deepEqual(marks[0]!.body, { limit: 3 }, '起点标记只带上限 —— 断点在这里');
    assert.deepEqual(marks[1]!.body, { droppedEvents: 7, limit: 3 }, '收尾摘要带最终计数');
    assert.equal(events.filter((e) => e.name === 'x').length, 3, '上限没生效');
    assert.equal(events.length, 5, 'maxEvents 管的是**记录**事件（3 条 x）—— 两笔簿记不占配额');
  });

  it('增量出口：截断在两条缝上都看得见（起点标记 + 收尾摘要，P3-1 / 复核 §4）', () => {
    const r = new TraceRecorder({ maxEvents: 3 });
    const seen: Array<{ seq: number; name?: string; body?: unknown }> = [];
    r.subscribe((e) => {
      seen.push({
        seq: e.seq,
        ...(e.type === 'span.event' ? { name: e.event.name, body: e.event.body } : {}),
      });
    });
    fill(r, 10); // 第 4 条起丢弃
    // 交付（收尾摘要在这一刻派出去）—— 先交付再断言，否则看到的是「还没派摘要」的中途状态
    const root = r.snapshot('ok').spans[0]!;

    const marks = seen.filter((e) => e.name === 'trace.truncated');
    assert.equal(
      marks.length,
      2,
      '起点标记与收尾摘要各派一次（逐笔派 = 用事件洪水汇报「事件太多」）',
    );
    // seq 纪律：起点标记是一次记账动作，占号 —— begin(1) + 3 条 x ⇒ 它落在 seq 5
    assert.equal(
      marks[0]!.seq,
      5,
      '起点标记没落在第一笔丢弃那一刻（或没占号 ⇒ 订阅早晚会序号错位）',
    );
    assert.deepEqual(marks[0]!.body, { limit: 3 }, '起点标记带的是上限（位置信号）');
    assert.equal(
      seen.filter((e) => e.name === 'x' && e.seq > marks[0]!.seq).length,
      0,
      '起点标记之后仍有记录事件流出 —— 「停止记账」在增量出口没生效',
    );
    // 收尾摘要（最终计数）**也要派**：此前它只写在交付的 trace 上 ⇒ 折回的树会少一笔
    // （只要设了 maxEvents 且真截断，「按 seq 折回逐字等于 snapshot」就是假的）
    assert.deepEqual(marks[1]!.body, { droppedEvents: 7, limit: 3 }, '收尾摘要没走增量出口');
    assert.ok(marks[1]!.seq > marks[0]!.seq, '收尾摘要必须晚于起点标记（顺序即折回的顺序）');
    // 两条缝同一份载荷：交付的 trace 上也是这两笔
    assert.deepEqual(
      root.events.filter((e) => e.name === 'trace.truncated').map((e) => e.body),
      [{ limit: 3 }, { droppedEvents: 7, limit: 3 }],
    );
  });

  it('收尾摘要只生成一次：多次 snapshot 逐字一致，且与增量流那一条是同一个对象', () => {
    const r = new TraceRecorder({ maxEvents: 1 });
    const seen: Array<{ name?: string; event?: unknown }> = [];
    r.subscribe((e) => {
      if (e.type === 'span.event') seen.push({ name: e.event.name, event: e.event });
    });
    fill(r, 5);
    const first = r.snapshot('ok');
    const second = r.snapshot('ok');
    const summaryOf = (t: typeof first) =>
      t.spans[0]!.events.filter(
        (e) => e.name === 'trace.truncated' && 'droppedEvents' in (e.body as object),
      );
    const s1 = summaryOf(first);
    const s2 = summaryOf(second);
    assert.equal(s1.length, 1, '每次 snapshot 恰有一条收尾摘要');
    assert.equal(s2.length, 1, '重复 snapshot 不得累积出第二条摘要');
    assert.deepEqual(s2, s1, '多次调用的摘要必须逐字一致（含 time —— 增量流里只有那一份）');
    // 折叠契约：增量流收到的摘要与 snapshot 里的是同一份（同 time 同 body）
    const emitted = seen.filter((e) => e.name === 'trace.truncated').map((e) => e.event);
    assert.equal(emitted.length, 2, '起点标记 + 收尾摘要各一条');
    assert.deepEqual(emitted[1], s1[0], '增量流的摘要与 snapshot 的摘要必须逐字一致');
  });

  it('maxEvents: 0 = 一条都不记，但计数是全部（0 是有意义的值）', () => {
    const r = new TraceRecorder({ maxEvents: 0 });
    fill(r, 4);
    const events = r.snapshot('ok').spans[0]!.events;
    assert.equal(events.filter((e) => e.name === 'x').length, 0);
    assert.deepEqual(
      events.filter((e) => e.name === 'trace.truncated').map((e) => e.body),
      [{ limit: 0 }, { droppedEvents: 4, limit: 0 }],
    );
  });

  it('闸门只影响事件，不影响 span 与 usage 记账（token 计量走 span 字段）', () => {
    const r = new TraceRecorder({ maxEvents: 0 });
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'm', root);
    r.event(turn, 'tool.output', 'x'.repeat(9999));
    r.end(turn, {
      usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    r.end(root, { status: 'ok' });
    const trace = r.snapshot('ok');
    assert.equal(trace.spans.length, 2, 'span 记账被闸门影响了');
    assert.equal(trace.totalUsage.inputTokens, 7, 'usage 记账被闸门影响了');
  });

  it('坏值在 run 入口抛 TypeError（NaN 会让 `>=` 恒假 ⇒ 闸门形同不存在）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '3', null]) {
      assert.throws(
        () => resolveTraceLimits({ maxEvents: bad }, 'agentia'),
        TypeError,
        `坏值没拦住：${String(bad)}`,
      );
    }
    assert.throws(() => resolveTraceLimits('nope', 'agentia'), TypeError);
    assert.equal(resolveTraceLimits(undefined, 'agentia'), undefined, '不传 = 不限');
    assert.deepEqual(resolveTraceLimits({}, 'agentia'), {}, '空对象 = 不限');
    assert.deepEqual(resolveTraceLimits({ maxEvents: 0 }, 'agentia'), { maxEvents: 0 });
  });

  it('端到端：app.run 的 traceLimits 生效（走 createApp 的选项链）', async () => {
    const obj = { type: 'object', properties: {}, additionalProperties: false } as const;
    class T {
      @Tool({ description: '甲', schema: obj })
      alpha(): string {
        return 'a';
      }
    }
    const app = await createApp({
      name: 'limits-e2e',
      system: new SystemPrompt().add('role', '助手。', true),
      providers: [{ provide: 't', useClass: T }],
      toolSources: ['t'],
      traceLimits: { maxEvents: 1 },
    });
    const { result } = await app.run([{ role: 'user', content: '跑' }], {
      client: scriptedClient([
        {
          id: 's1',
          model: 'claude-opus-5',
          stop_reason: 'tool_use' as const,
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tu1', name: 'alpha', input: {} }],
        },
        {
          id: 's2',
          model: 'claude-opus-5',
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: '完' }],
        },
      ] as never),
    });
    assert.equal(result.stopReason, 'end_turn');
    const all = result.trace!.spans.flatMap((s) => s.events);
    const marks = all.filter((e) => e.name === 'trace.truncated');
    assert.equal(marks.length, 2, '应用级 traceLimits 没生效（事件一个都没被挡住）');
    const summary = marks.find((e) => 'droppedEvents' in (e.body as Record<string, unknown>))!;
    assert.ok(
      (summary.body as { droppedEvents: number }).droppedEvents > 0,
      '收尾摘要的丢弃计数为 0 —— 计数与实际不符',
    );
  });
});
