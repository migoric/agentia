import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunReport, mergeRunReports, renderRunReport } from '../../src/index.js';
import type { Span, Trace } from '../../src/index.js';

/**
 * G1 调优报告 —— 「哪个能力慢 / 贵 / 爱失败」。
 * 没有它，面对 budgetTokens / keepToolPairs / maxCostUsd 一堆旋钮不知道该拧哪个。
 */

function span(over: Partial<Span> & Pick<Span, 'spanId' | 'kind' | 'name'>): Span {
  return {
    traceId: 't-1',
    parentSpanId: 'root',
    startedAt: 1000,
    endedAt: 1100,
    status: 'ok',
    attributes: {},
    events: [],
    ...over,
  };
}

function traceWith(spans: Span[], over: Partial<Trace> = {}): Trace {
  return {
    traceId: 't-1',
    rootSpanId: 'root',
    status: 'ok',
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      span({
        spanId: 'root',
        kind: 'run',
        name: 'agent.run',
        parentSpanId: null,
        startedAt: 0,
        endedAt: 500,
      }),
      ...spans,
    ],
    ...over,
  };
}

describe('G1 buildRunReport', () => {
  it('能力按总耗时降序；错误计数、tokens/cost 各归各位', () => {
    const trace = traceWith([
      span({
        spanId: 'turn-1',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 10,
        endedAt: 110,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.01,
        },
        events: [
          { time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 200 } },
          {
            time: 60,
            name: 'tool.output',
            body: { tool: 'fetch', ok: false, durationMs: 10, errorKind: 'threw' },
          },
        ],
      }),
      span({
        spanId: 'capability-1',
        kind: 'capability',
        name: 'researcher',
        attributes: { subagent: 'researcher' },
        startedAt: 200,
        endedAt: 400,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.002,
        },
      }),
    ]);
    const r = buildRunReport(trace);
    assert.equal(r.traceId, 't-1');
    assert.equal(r.status, 'ok');
    assert.equal(r.durationMs, 500, '根 span 起止');
    assert.equal(r.runs, 1);
    assert.deepEqual(
      r.capabilities.map((u) => u.capability),
      ['tool:search', 'subagent:researcher', 'tool:fetch'],
      '按总耗时降序（200 / 100 / 10）',
    );
    const search = r.capabilities[0]!;
    assert.deepEqual(
      {
        calls: search.calls,
        errors: search.errors,
        total: search.durationMs.total,
        max: search.durationMs.max,
      },
      { calls: 1, errors: 0, total: 200, max: 200 },
    );
    assert.equal(search.tokens, null, '工具没有 token 语义');
    const researcher = r.capabilities[1]!;
    assert.equal(researcher.tokensTotal, 15);
    assert.equal(researcher.costUsd, 0.002);
    assert.equal(r.capabilities[2]!.errors, 1, 'fetch 失败一次');
    assert.equal(r.models[0]!.model, 'claude-opus-5');
    assert.equal(r.models[0]!.turns, 1);
    assert.equal(r.models[0]!.tokensTotal, 120);
    assert.equal(r.models[0]!.costUsd, 0.01);
    assert.deepEqual(r.unpricedModels, []);
  });

  it('未定价模型进 unpricedModels（成本护栏失效的显式信号）', () => {
    const trace = traceWith([
      span({
        spanId: 'turn-1',
        kind: 'llm.turn',
        name: 'deepseek-chat',
        usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    ]);
    const r = buildRunReport(trace);
    assert.deepEqual(r.unpricedModels, ['deepseek-chat']);
    assert.equal(r.models[0]!.unpricedTurns, 1);
    assert.equal(r.models[0]!.costUsd, null);
  });

  it('空 trace（只有根）→ 空排行，不抛错', () => {
    const r = buildRunReport(traceWith([]));
    assert.deepEqual(r.capabilities, []);
    assert.deepEqual(r.models, []);
    assert.equal(r.durationMs, 500);
  });

  it('嵌套能力（@SubAgent 套 @Skill）：usage 只计顶层行，各行 tokens/cost 可加总', () => {
    // capability.usage 是子孙 llm.turn 的聚合 ⇒ 嵌套时外层与内层带着同一批 token，
    // 逐行累加会重复计数（与 trace-view summarizeTrace 同款口径）。
    const trace = traceWith([
      span({
        spanId: 'cap-outer',
        kind: 'capability',
        name: 'researcher',
        attributes: { subagent: 'researcher' },
        startedAt: 100,
        endedAt: 400,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.002,
        },
      }),
      span({
        spanId: 'cap-inner',
        kind: 'capability',
        name: 'writer',
        attributes: { skill: 'writer' },
        parentSpanId: 'cap-outer',
        startedAt: 150,
        endedAt: 300,
        // 框架语义：这是外层那笔的子集（同一批 token 的再聚合）
        usage: {
          inputTokens: 4,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.001,
        },
      }),
    ]);
    const r = buildRunReport(trace);
    const outer = r.capabilities.find((c) => c.capability === 'subagent:researcher')!;
    const inner = r.capabilities.find((c) => c.capability === 'skill:writer')!;
    assert.equal(outer.tokensTotal, 15, '顶层行带上自己的聚合');
    assert.equal(outer.costUsd, 0.002);
    assert.equal(inner.calls, 1, '嵌套行仍计调用次数（它自己这次调用的真账）');
    assert.equal(inner.tokens, null, '嵌套行的 usage 不重复计（去掉顶层判定则此处红）');
    assert.equal(inner.tokensTotal, null);
    assert.equal(inner.costUsd, null);
    const sum = r.capabilities.reduce((acc, c) => acc + (c.tokensTotal ?? 0), 0);
    assert.equal(sum, 15, '各行 tokensTotal 可加总、且不双计');
  });
});

describe('G1 mergeRunReports', () => {
  it('跨 run 累加 calls/errors/durations，并按新的总耗时重排', () => {
    const a = buildRunReport(
      traceWith(
        [
          span({
            spanId: 't',
            kind: 'llm.turn',
            name: 'm',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
            events: [
              { time: 1, name: 'tool.output', body: { tool: 'slow', ok: true, durationMs: 300 } },
            ],
          }),
        ],
        { traceId: 't-a' },
      ),
    );
    const b = buildRunReport(
      traceWith(
        [
          span({
            spanId: 't',
            kind: 'llm.turn',
            name: 'm',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
            events: [
              { time: 1, name: 'tool.output', body: { tool: 'slow', ok: false, durationMs: 50 } },
              { time: 2, name: 'tool.output', body: { tool: 'fast', ok: true, durationMs: 1 } },
            ],
          }),
        ],
        { traceId: 't-b' },
      ),
    );
    const merged = mergeRunReports([a, b]);
    assert.equal(merged.runs, 2);
    assert.equal(merged.traceId, 'merged(2 runs)');
    assert.equal(merged.durationMs, 1000, '两条各 500');
    const slow = merged.capabilities.find((u) => u.capability === 'tool:slow')!;
    assert.equal(slow.calls, 2);
    assert.equal(slow.errors, 1);
    assert.equal(slow.durationMs.total, 350);
    assert.equal(slow.durationMs.max, 300);
    assert.equal(merged.capabilities[0]!.capability, 'tool:slow', '总耗时最大的排最前');
    assert.equal(merged.models[0]!.turns, 2);
  });

  it('任一 run 失败 → 合并报告 status=error；未定价模型取并集', () => {
    const ok = buildRunReport(traceWith([], { traceId: 't-ok' }));
    const bad = buildRunReport(traceWith([], { traceId: 't-bad', status: 'error' }));
    const unpriced = buildRunReport(
      traceWith(
        [
          span({
            spanId: 't',
            kind: 'llm.turn',
            name: 'x',
            usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          }),
        ],
        { traceId: 't-unpriced' },
      ),
    );
    const merged = mergeRunReports([ok, bad, unpriced]);
    assert.equal(merged.status, 'error');
    assert.deepEqual(merged.unpricedModels, ['x']);
  });

  it('按 traceId 去重、只留最后一份（append-only 导出里同一棵 trace 占多行）', () => {
    // FileTaskStore 是 append-only：挂起 save / approve 落库 / 接管再 save 写出同一棵 trace
    // 多份 ⇒ 按行计会把 runs / 成本翻倍（CLI report 已于 2026-10-12 ref-report-dedupe-traceid 修，本用例钉框架侧同口径）
    const mk = (turns: number) =>
      buildRunReport(
        traceWith(
          Array.from({ length: turns }, (_, i) =>
            span({
              spanId: `t-${i}`,
              kind: 'llm.turn',
              name: 'm',
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
            }),
          ),
          { traceId: 'same-trace' },
        ),
      );
    const merged = mergeRunReports([mk(1), mk(1), mk(1)]);
    assert.equal(merged.runs, 1, '同一 traceId 三份只算一份');
    assert.equal(merged.traceId, 'merged(1 runs)');
    assert.equal(merged.models[0]!.turns, 1, '模型 turn 数不翻倍（留下的是最后一份）');
  });

  it('合并报告自身不参与去重（merged(...) 是合成 id 不是身份）', () => {
    const a = mergeRunReports([buildRunReport(traceWith([], { traceId: 't-1' }))]);
    const b = mergeRunReports([buildRunReport(traceWith([], { traceId: 't-1' }))]);
    const merged = mergeRunReports([a, b]);
    assert.equal(a.traceId, 'merged(1 runs)');
    assert.equal(merged.runs, 2, '两个 merged(1 runs) 报告撞 id 也不得互相吞掉');
  });

  it('空数组 → 空报告（runs=0，不抛错）', () => {
    const merged = mergeRunReports([]);
    assert.equal(merged.runs, 0);
    assert.equal(merged.status, 'ok');
    assert.equal(merged.durationMs, 0);
  });
});

describe('G1 renderRunReport（CLI / 日志用）', () => {
  it('打印排行与未定价告警', () => {
    const trace = traceWith([
      span({
        spanId: 'turn-1',
        kind: 'llm.turn',
        name: 'deepseek-chat',
        startedAt: 10,
        endedAt: 210,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        events: [
          { time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 200 } },
        ],
      }),
    ]);
    const text = renderRunReport(buildRunReport(trace));
    assert.match(text, /run {6}t-1 {2}\[ok\]/);
    assert.match(text, /total {4}500ms/);
    assert.match(text, /未定价模型：deepseek-chat/);
    assert.match(text, /deepseek-chat/);
    assert.match(text, /tool:search/);
    assert.match(text, /未定价/, '未定价模型在 cost 列显式标出');
  });

  it('无能力/模型时给出人话说明（不输出空表头）', () => {
    const text = renderRunReport(buildRunReport(traceWith([])));
    assert.match(text, /没有可归因的能力\/模型/);
  });
});

describe('G1 mergeRunReports：capability 的 tokens 合并分支（report.ts 271-273）', () => {
  it('同一 capability 跨 run 的 usage 逐字段累加（含 costUsd），不是覆盖也不是丢', () => {
    // 反向验证：把 `addUsage(acc.tokens, u.tokens)` 改成赋值 ⇒ 只剩最后一个 run 的量，
    // 本用例红在各字段的合计上。构造两个 run 各自的 skill span 都带 usage。
    const cap = (input: number, output: number, cost: number) =>
      span({
        spanId: 'capability-1',
        kind: 'capability',
        name: 'writer',
        attributes: { skill: 'writer' },
        startedAt: 100,
        endedAt: 200,
        usage: {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          costEstimate: cost,
        },
      });
    const a = buildRunReport(traceWith([cap(10, 5, 0.001)], { traceId: 't-a' }));
    const b = buildRunReport(traceWith([cap(20, 7, 0.002)], { traceId: 't-b' }));

    const merged = mergeRunReports([a, b]);
    const writer = merged.capabilities.find((c) => c.capability === 'skill:writer')!;
    assert.deepEqual(
      writer.tokens,
      {
        inputTokens: 30,
        outputTokens: 12,
        cacheReadTokens: 6,
        cacheCreationTokens: 8,
        costEstimate: 0.003,
      },
      'tokens 必须逐字段累加（costEstimate 也并进 tokens，见 addUsage）',
    );
    assert.equal(writer.tokensTotal, 56, 'tokensTotal 只算四类 token，不含成本');
    assert.equal(writer.costUsd, 0.003, 'costUsd 独立累加');
    assert.equal(writer.calls, 2);
  });
});

describe('S2：上游没回报 usage 的 turn 单独计数（与 unpriced 分开）', () => {
  /** 有计量、成本算得出（0），但上游**没给读数** —— 记了 usage.missing 事件的那一档 */
  const missingSpan = () =>
    span({
      spanId: 'llm-missing',
      kind: 'llm.turn',
      name: 'm-unreported',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0,
      },
      events: [{ time: 1, name: 'usage.missing', body: { model: 'm-unreported' } }],
    });

  it('buildRunReport：usageMissingTurns 与 usageMissingModels 都记上，且**不**混进 unpriced', () => {
    const r = buildRunReport(traceWith([missingSpan()]));
    const m = r.models.find((x) => x.model === 'm-unreported');
    assert.ok(m, '模型归因必须在');
    assert.equal(m.usageMissingTurns, 1, '上游没给读数 ⇒ 单独一档');
    assert.equal(m.unpricedTurns, 0, '模型有定价，不该记成未定价（两条排障方向不许搅在一起）');
    assert.deepEqual(r.usageMissingModels, ['m-unreported']);
    assert.deepEqual(r.unpricedModels, [], 'unpricedModels 必须是空的 —— 它是另一本账');
  });

  it('mergeRunReports：跨 run 累加、模型取并集', () => {
    const merged = mergeRunReports([
      buildRunReport(traceWith([missingSpan()], { traceId: 't-a' })),
      buildRunReport(traceWith([missingSpan()], { traceId: 't-b' })),
    ]);
    assert.equal(merged.models.find((x) => x.model === 'm-unreported')!.usageMissingTurns, 2);
    assert.deepEqual(merged.usageMissingModels, ['m-unreported']);
  });
});
