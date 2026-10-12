import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrace, renderSummary } from '../src/summary.js';

/** 造一条含 capability span 与 tool.output 事件的 trace（形状与框架一致） */
function trace() {
  return {
    traceId: 't1',
    rootSpanId: 's0',
    status: 'ok',
    spans: [
      {
        spanId: 's0',
        parentSpanId: null,
        kind: 'run',
        name: 'run',
        startedAt: 0,
        endedAt: 500,
        status: 'ok',
        attributes: {},
        events: [],
      },
      {
        spanId: 's1',
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 10,
        endedAt: 100,
        status: 'ok',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.01,
        },
        attributes: {},
        events: [
          { time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 200 } },
          { time: 60, name: 'tool.output', body: { tool: 'fetch', ok: false, durationMs: 10 } },
        ],
      },
      {
        spanId: 's2',
        parentSpanId: 's0',
        kind: 'capability',
        name: 'researcher',
        startedAt: 110,
        endedAt: 400,
        status: 'ok',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.002,
        },
        attributes: { subagent: 'researcher' },
        events: [],
      },
      // skill：另一类 capability
      {
        spanId: 's3',
        parentSpanId: 's0',
        kind: 'capability',
        name: 'summarize',
        startedAt: 410,
        endedAt: 430,
        status: 'error',
        attributes: { skill: 'summarize' },
        events: [],
      },
    ],
  };
}

describe('trace-view summarizeTrace（G2 能力排行）', () => {
  it('工具来自 tool.output 事件；capability span 带 tokens/cost；按总耗时降序', () => {
    const rows = summarizeTrace(trace());
    assert.deepEqual(
      rows.map((r) => r.capability),
      ['subagent:researcher', 'tool:search', 'skill:summarize', 'tool:fetch'],
      '290 / 200 / 20 / 10',
    );
    const search = rows[1];
    assert.deepEqual(
      { calls: search.calls, errors: search.errors, max: search.maxMs },
      { calls: 1, errors: 0, max: 200 },
    );
    assert.equal(search.tokens, null, '工具没有 token 语义');
    assert.equal(search.costUsd, null);
    const researcher = rows[0];
    assert.deepEqual(
      { calls: researcher.calls, tokens: researcher.tokens, costUsd: researcher.costUsd },
      { calls: 1, tokens: 15, costUsd: 0.002 },
    );
    assert.equal(rows[3].errors, 1, 'fetch 失败一次');
    assert.equal(rows[2].errors, 1, 'skill span status=error');
  });

  it('空/畸形输入不抛错', () => {
    assert.deepEqual(summarizeTrace({}), []);
    assert.deepEqual(summarizeTrace(null), []);
    assert.deepEqual(
      summarizeTrace({
        spans: [{ kind: 'llm.turn', events: [{ name: 'tool.output', body: null }] }],
      }),
      [],
      'body 非法的事件被跳过',
    );
  });

  it('renderSummary 出表格；空排行给人话说明；能力名做 HTML 转义', () => {
    const html = renderSummary(summarizeTrace(trace()));
    assert.match(html, /<table class="tv-sum">/);
    assert.match(html, /subagent:researcher/);
    assert.match(html, /tv-sum-err/);
    assert.match(renderSummary([]), /没有可归因的能力/);
    assert.match(
      renderSummary([
        {
          capability: '<img>',
          calls: 1,
          errors: 0,
          totalMs: 1,
          maxMs: 1,
          tokens: null,
          costUsd: null,
        },
      ]),
      /&lt;img&gt;/,
    );
  });

  it('无 tokens/cost 的能力渲染为 -（不显示 undefined）', () => {
    const html = renderSummary(summarizeTrace(trace()));
    assert.equal(/undefined/.test(html), false);
  });
});

describe('trace-view summarizeTrace（G7 护栏行）', () => {
  /** 一条带审批决定的 llm.turn —— 审批**不建 span**，所以只能从事件聚 */
  function approvalTrace() {
    return {
      traceId: 't-g',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        {
          spanId: 's0',
          parentSpanId: null,
          kind: 'run',
          name: 'run',
          startedAt: 0,
          endedAt: 100,
          status: 'ok',
          attributes: {},
          events: [],
        },
        {
          spanId: 's1',
          parentSpanId: 's0',
          kind: 'llm.turn',
          name: 'm',
          startedAt: 0,
          endedAt: 100,
          status: 'ok',
          attributes: {},
          events: [
            {
              time: 1,
              name: 'approval.requested',
              body: { tool_use_ids: ['u1'], tools: ['deploy'] },
            },
            {
              time: 2,
              name: 'approval.decided',
              body: { tool: 'deploy', tool_use_id: 'u1', approved: true, waitedMs: 1200 },
            },
            {
              time: 3,
              name: 'approval.decided',
              body: { tool: 'deploy', tool_use_id: 'u2', approved: false },
            },
            // ⚠️ 这一条是**反例样本**，不能删：只有「一真一假」时，把判据写成
            // `approved === true` 会得到**同样的 1** ⇒ 断言对判据的取反免疫（变异验证实测
            // 第一版就是这么漏的）。再加一条「批准」，取反后才会变成 2 而咬住。
            {
              time: 4,
              name: 'approval.decided',
              body: { tool: 'deploy', tool_use_id: 'u3', approved: true },
            },
          ],
        },
      ],
    };
  }

  it('审批只出 `guardrail:<工具>` 行：calls=决定次数、errors=被拒次数、total=等审批时长（缺 waitedMs 记 0）', () => {
    const rows = summarizeTrace(approvalTrace());
    assert.equal(rows.length, 1, '护栏不与工具行混排（前缀不同、各聚各的）');
    const g = rows[0];
    assert.equal(g.capability, 'guardrail:deploy');
    assert.equal(g.calls, 3);
    assert.equal(g.errors, 1, '被拒一次（另两次是批准）—— 不是系统错误，但那次工具确实没执行');
    assert.equal(g.totalMs, 1200, '后两次没有 waitedMs ⇒ 各记 0，不编造');
    assert.equal(g.maxMs, 1200);
    assert.equal(g.tokens, null, '护栏没有 token 语义');
    assert.equal(g.costUsd, null);
  });

  it('只有 `approval.requested` 而没有决定不产出行（没结论、也没时长，硬记一格等于编账）', () => {
    const t = approvalTrace();
    t.spans[1].events = [t.spans[1].events[0]];
    assert.deepEqual(summarizeTrace(t), []);
  });

  it('畸形 body（null / 缺 tool）跳过，不炸', () => {
    const t = approvalTrace();
    t.spans[1].events = [
      { time: 1, name: 'approval.decided', body: null },
      { time: 2, name: 'approval.decided', body: { approved: true } },
      { time: 3, name: 'approval.decided', body: { tool: 'deploy', approved: true } },
    ];
    const rows = summarizeTrace(t);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].calls, 1);
  });
});
