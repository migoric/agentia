// biome-ignore-all lint/suspicious/noExplicitAny: E5 段的 OTLP/JSON 断言是逐字段探针 —— 写全 envelope 类型等于把协议抄一遍，抄错时测试反而失去意义；这些 any 只活在 bodies / Record<string, any> / .map((d: any)) 三处形态上，作用域限本文件
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachScore, createApp, metricsSink, SystemPrompt } from '../../src/index.js';
import type { Span, Trace } from '../../src/index.js';
import { MetricsState } from '../../src/integrations/metrics-state.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/** 造一条只有根 span 的 trace：durationMs=undefined 表示根未收尾 */
function traceOf(opts: {
  status?: 'ok' | 'error';
  durationMs?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  costEstimate?: number;
  /** 归因标签（R8-P4）：写成 run 根的 `labels.<k>` 属性（与 loop.ts 的写入位置一致） */
  labels?: Record<string, string>;
}): Trace {
  const rootSpanId = 'root-1';
  const ended = opts.durationMs === undefined;
  return {
    traceId: 't-1',
    rootSpanId,
    status: opts.status ?? 'ok',
    totalUsage: {
      inputTokens: opts.input ?? 0,
      outputTokens: opts.output ?? 0,
      cacheReadTokens: opts.cacheRead ?? 0,
      cacheCreationTokens: opts.cacheCreation ?? 0,
      ...(opts.costEstimate === undefined ? {} : { costEstimate: opts.costEstimate }),
    },
    spans: [
      {
        spanId: rootSpanId,
        traceId: 't-1',
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt: 1000,
        ...(ended ? {} : { endedAt: 1000 + opts.durationMs! }),
        status: opts.status ?? 'ok',
        attributes: Object.fromEntries(
          Object.entries(opts.labels ?? {}).map(([k, v]) => [`labels.${k}`, v]),
        ),
        events: [],
      },
    ],
  };
}

/** 造一条**含能力与模型**的 trace：两次 llm.turn（带 tool.output 事件）+ 一个 subagent capability span */
function richTrace(): Trace {
  const root = 'root-1';
  const spans: Span[] = [
    {
      spanId: root,
      traceId: 't-rich',
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: 1000,
      endedAt: 1300,
      status: 'ok',
      attributes: {},
      events: [],
    },
    {
      spanId: 'turn-1',
      traceId: 't-rich',
      parentSpanId: root,
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 1010,
      endedAt: 1100,
      status: 'ok',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        costEstimate: 0.01,
      },
      attributes: {},
      events: [
        { time: 1050, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 42 } },
      ],
    },
    {
      spanId: 'turn-2',
      traceId: 't-rich',
      parentSpanId: root,
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 1110,
      endedAt: 1200,
      status: 'ok',
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0.002,
      },
      attributes: {},
      events: [
        {
          time: 1150,
          name: 'tool.output',
          body: { tool: 'search', ok: false, durationMs: 8, errorKind: 'threw' },
        },
        { time: 1160, name: 'tool.output', body: { tool: 'fetch', ok: true, durationMs: 100 } },
      ],
    },
    {
      spanId: 'capability-1',
      traceId: 't-rich',
      parentSpanId: root,
      kind: 'capability',
      name: 'researcher',
      startedAt: 1210,
      endedAt: 1280,
      status: 'ok',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0.012,
      },
      attributes: { subagent: 'researcher' },
      events: [],
    },
  ];
  return {
    traceId: 't-rich',
    rootSpanId: root,
    status: 'ok',
    totalUsage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      costEstimate: 0.012,
    },
    spans,
  };
}

describe('metricsSink（D3 基础：run 级）', () => {
  it('export 是 TraceSink 形状：createApp({ sinks }) 即接入，零新出口', async () => {
    const metrics = metricsSink();
    const app = createApp({
      name: 'metric-app',
      system: new SystemPrompt().add('role', 'r'),
      sinks: [metrics],
    });
    const { client } = mockClient([endTurnMsg('a'), endTurnMsg('b')]);
    await app.run([{ role: 'user', content: 'x' }], { client });
    await app.run([{ role: 'user', content: 'y' }], { client });
    const snap = metrics.snapshot();
    assert.equal(snap.runs, 2);
    assert.equal(snap.failed, 0);
    assert.equal(snap.tokens, 30, '两次 run（各 10+5）共 30 token');
  });

  it('token 口径 = 四类之和；costEstimate 缺失时不计成本（而不记 NaN）', () => {
    const m = metricsSink();
    m.export(traceOf({ input: 10, output: 5, cacheRead: 100, cacheCreation: 20 }));
    m.export(traceOf({ input: 1, output: 1, costEstimate: 0.5 }));
    const s = m.snapshot();
    assert.equal(s.tokens, 137, '10+5+100+20 + 1+1');
    assert.equal(s.costUsd, 0.5, '缺 costEstimate 的 run 计 0，不会污染总数');
  });

  it('failed 按 trace.status 计（budget_exceeded / aborted 收尾的 run 都是 error 态）', () => {
    const m = metricsSink();
    m.export(traceOf({ status: 'ok' }));
    m.export(traceOf({ status: 'error' }));
    m.export(traceOf({ status: 'error' }));
    assert.deepEqual([m.snapshot().runs, m.snapshot().failed], [3, 2]);
  });

  it('分位是窗口内精确值（最近 rank 法），根未收尾的 run 不进延迟样本', () => {
    const m = metricsSink();
    for (const d of [10, 20, 30, 40]) m.export(traceOf({ durationMs: d }));
    m.export(traceOf({})); // 根没 endedAt → 不计延迟
    const s = m.snapshot();
    assert.equal(s.latencyP50, 20, '4 个样本 → ceil(0.5·4)=2 → 第 2 个');
    assert.equal(s.latencyP95, 40, 'ceil(0.95·4)=4 → 第 4 个');
  });

  it('windowSize 只约束**分位样本**；histogram 计数是累积的（Prometheus 语义）', () => {
    const m = metricsSink({ windowSize: 3 });
    for (const d of [10, 20, 30, 40]) m.export(traceOf({ durationMs: d }));
    const txt = m.render();
    assert.match(txt, /agentia_run_duration_ms_count 4/, '直方图 count 记全部观测（可跨实例聚合）');
    assert.equal(m.snapshot().latencyP50, 30, '窗口内是 [40,20,30] → 排序 [20,30,40] → 中位 30');
  });

  it('render：Prometheus 文本（HELP/TYPE + label 分项 + 分位 gauge）', () => {
    const m = metricsSink();
    m.export(
      traceOf({
        status: 'error',
        durationMs: 7,
        input: 3,
        output: 4,
        cacheRead: 5,
        cacheCreation: 6,
        costEstimate: 0.25,
      }),
    );
    const txt = m.render();
    assert.match(txt, /# TYPE agentia_runs_total counter/);
    assert.match(txt, /# HELP agentia_runs_total /);
    assert.match(txt, /^agentia_runs_total 1$/m);
    assert.match(txt, /^agentia_runs_failed_total 1$/m);
    assert.match(txt, /^agentia_tokens_total\{kind="input"\} 3$/m);
    assert.match(txt, /^agentia_tokens_total\{kind="cache_creation"\} 6$/m);
    assert.match(txt, /^agentia_cost_usd_total 0.25$/m);
    assert.match(txt, /^agentia_run_duration_ms_last\{quantile="0.5"\} 7$/m);
    assert.match(txt, /^agentia_run_duration_ms_count 1$/m);
  });

  it('prefix 可换；reset 清空累计（含能力/模型维度）', () => {
    const m = metricsSink({ prefix: 'myapp_' });
    m.export(traceOf({ durationMs: 1, input: 9 }));
    m.export(richTrace());
    assert.match(m.render(), /^myapp_runs_total 2$/m);
    m.reset();
    const s = m.snapshot();
    assert.deepEqual([s.runs, s.failed, s.tokens, s.costUsd], [0, 0, 0, 0]);
    assert.deepEqual(s.capabilities, {});
    assert.deepEqual(s.models, {});
    assert.match(m.render(), /^myapp_run_duration_ms_count 0$/m);
  });

  it('windowSize / maxCapabilities / buckets 非法 → 构造期抛错', () => {
    assert.throws(() => metricsSink({ windowSize: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ maxCapabilities: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ buckets: [10, 5] }), /严格升序/);
    assert.throws(() => metricsSink({ export: 'nope' as never }), /只支持/);
  });
});

describe('E4 histogram（可聚合的分位）', () => {
  it('cumulative bucket + sum + count，le 用 +Inf 收口', () => {
    const m = metricsSink({ buckets: [50, 100] });
    for (const d of [10, 60, 500]) m.export(traceOf({ durationMs: d }));
    const txt = m.render();
    assert.match(txt, /^agentia_run_duration_ms_bucket\{le="50"\} 1$/m, '≤50 的只有 10');
    assert.match(txt, /^agentia_run_duration_ms_bucket\{le="100"\} 2$/m, '≤100：10 与 60');
    assert.match(txt, /^agentia_run_duration_ms_bucket\{le="\+Inf"\} 3$/m, '总和');
    assert.match(txt, /^agentia_run_duration_ms_sum 570$/m);
    assert.match(txt, /^agentia_run_duration_ms_count 3$/m);
  });
});

describe('Prometheus 文本合法性（expfmt 硬约束）', () => {
  it('每个指标名至多一条 HELP、一条 TYPE，且同名不混用类型（第二条 HELP/TYPE 会让整次 scrape 失败）', () => {
    const m = metricsSink();
    m.export(traceOf({ durationMs: 7, input: 3, costEstimate: 0.25 }));
    m.export(richTrace()); // 带上能力/模型维度，让所有家族都出现
    const txt = m.render();

    const helpCount = new Map<string, number>();
    const typeOf = new Map<string, string>();
    for (const raw of txt.split('\n')) {
      const help = /^# HELP (\S+) /.exec(raw);
      if (help) helpCount.set(help[1]!, (helpCount.get(help[1]!) ?? 0) + 1);
      const type = /^# TYPE (\S+) (\S+)$/.exec(raw);
      if (type) {
        const prev = typeOf.get(type[1]!);
        assert.equal(
          prev,
          undefined,
          `指标 ${type[1]} 出现第二条 TYPE（${prev} 之后又见 ${type[2]}）—— expfmt 硬错误`,
        );
        typeOf.set(type[1]!, type[2]!);
      }
    }
    assert.ok(helpCount.size > 0, '应当至少有一个指标家族');
    for (const [name, count] of helpCount) {
      assert.equal(count, 1, `指标 ${name} 的 HELP 出现了 ${count} 次`);
    }
    for (const name of helpCount.keys()) {
      assert.ok(typeOf.has(name), `${name} 有 HELP 无 TYPE`);
    }
    for (const name of typeOf.keys()) {
      assert.ok(helpCount.has(name), `${name} 有 TYPE 无 HELP`);
    }
    // tokens_total 有 4 条样本但家族头只发一次
    assert.equal(typeOf.get('agentia_tokens_total'), 'counter');
    // 时长的两种口径拆成两个名字：histogram 与 gauge 不得同名
    assert.equal(typeOf.get('agentia_run_duration_ms'), 'histogram');
    assert.equal(typeOf.get('agentia_run_duration_ms_last'), 'gauge');
    assert.equal(typeOf.get('agentia_capability_duration_ms'), 'histogram');
    assert.equal(typeOf.get('agentia_capability_duration_ms_last'), 'gauge');
    assert.equal(typeOf.get('agentia_model_duration_ms'), 'histogram');
    assert.equal(typeOf.get('agentia_model_duration_ms_last'), 'gauge');
  });

  it('label 值转义：含引号/反斜杠/换行的能力名与模型名不得损坏 exposition', () => {
    const m = metricsSink();
    const evil = richTrace();
    evil.spans[3]!.name = 'a"b\\c\nd'; // capability span
    evil.spans[1]!.name = 'm"x'; // llm.turn → model label
    m.export(evil);
    const txt = m.render();
    // 原始引号/换行不得原样出现在 label 里（那会把一行样本劈成两行/提前闭合引号）
    assert.ok(!txt.includes('capability="a"b'), '未转义的引号会破坏 label');
    assert.match(txt, /capability="subagent:a\\"b\\\\c\\nd"/);
    assert.match(txt, /model="m\\"x"/);
    // 转义后每个 label 仍落在单行内（剥掉 \" 转义后引号成对）
    for (const line of txt.split('\n')) {
      if (line.includes('capability=')) {
        assert.equal((line.replace(/\\"/g, '').match(/"/g) ?? []).length % 2, 0);
      }
    }
  });
});

describe('E2 能力级指标', () => {
  it('工具来自 tool.output 事件；skill/subagent 来自 capability span（带 token/成本）', () => {
    const m = metricsSink();
    m.export(richTrace());
    const txt = m.render();
    assert.match(txt, /^agentia_capability_calls_total\{capability="tool:search"\} 2$/m);
    assert.match(txt, /^agentia_capability_errors_total\{capability="tool:search"\} 1$/m);
    assert.match(
      txt,
      /^agentia_capability_duration_ms_last\{capability="tool:search",quantile="0.5"\} 8$/m,
      '窗口内 [42,8] 排序 [8,42] → ceil(0.5·2)=1 → 8',
    );
    assert.match(
      txt,
      /^agentia_capability_duration_ms_last\{capability="tool:search",quantile="0.95"\} 42$/m,
    );
    assert.match(txt, /^agentia_capability_calls_total\{capability="tool:fetch"\} 1$/m);
    assert.match(txt, /^agentia_capability_calls_total\{capability="subagent:researcher"\} 1$/m);
    assert.match(
      txt,
      /^agentia_capability_tokens_total\{capability="subagent:researcher"\} 150$/m,
      '120+30',
    );
    assert.match(
      txt,
      /^agentia_capability_cost_usd_total\{capability="subagent:researcher"\} 0.012$/m,
    );
    // 工具没有 token 语义 → 不产出 token/cost 行
    assert.equal(/agentia_capability_tokens_total\{capability="tool:search"\}/.test(txt), false);
    // 每个能力的调用耗时直方图都在
    assert.match(txt, /^agentia_capability_duration_ms_count\{capability="tool:fetch"\} 1$/m);
  });

  it('snapshot().capabilities 给排序无关的键值视图；工具 tokens/costUsd 为 null', () => {
    const m = metricsSink();
    m.export(richTrace());
    const { capabilities } = m.snapshot();
    assert.deepEqual(Object.keys(capabilities).sort(), [
      'subagent:researcher',
      'tool:fetch',
      'tool:search',
    ]);
    assert.equal(capabilities['tool:search']!.calls, 2);
    assert.equal(capabilities['tool:search']!.errors, 1);
    assert.equal(capabilities['tool:search']!.tokens, null);
    assert.equal(capabilities['tool:search']!.costUsd, null);
    assert.equal(capabilities['subagent:researcher']!.tokens, 150);
    assert.equal(capabilities['subagent:researcher']!.costUsd, 0.012);
    assert.equal(capabilities['tool:fetch']!.latencyP50, 100, '单样本 → 分位即它自己');
  });

  it('labelMode:"none" 不产出任何能力指标', () => {
    const m = metricsSink({ labelMode: 'none' });
    m.export(richTrace());
    assert.deepEqual(m.snapshot().capabilities, {});
    assert.equal(/agentia_unit_/.test(m.render()), false);
  });

  it('labelMode:"kind" 只按类型打标签（基数极小）', () => {
    const m = metricsSink({ labelMode: 'kind' });
    m.export(richTrace());
    const { capabilities } = m.snapshot();
    assert.deepEqual(Object.keys(capabilities).sort(), ['subagent', 'tool']);
    assert.equal(capabilities.tool!.calls, 3, '两次 search + 一次 fetch');
    assert.equal(capabilities.subagent!.calls, 1);
  });

  it('maxCapabilities 上限：新能力归 __other__，droppedCapabilities 记被归并的不同能力数', () => {
    const m = metricsSink({ maxCapabilities: 1 });
    m.export(richTrace());
    const s = m.snapshot();
    assert.equal(s.capabilities['tool:search']!.calls, 2, '首个能力保住自己的标签');
    assert.equal(s.capabilities.__other__!.calls, 2, 'fetch 与 subagent 被归并');
    assert.equal(s.droppedCapabilities, 2);
  });
});

describe('E3 模型级指标', () => {
  it('按 llm.turn 的 span.name（模型 id）归因 token/成本/延迟/turn 数', () => {
    const m = metricsSink();
    m.export(richTrace());
    const txt = m.render();
    assert.match(txt, /^agentia_model_turns_total\{model="claude-opus-5"\} 2$/m);
    assert.match(
      txt,
      /^agentia_model_tokens_total\{model="claude-opus-5"\} 155$/m,
      '100+20+5 + 20+10',
    );
    assert.match(
      txt,
      /^agentia_model_cost_usd_total\{model="claude-opus-5"\} 0.012$/m,
      '0.01+0.002',
    );
    assert.match(txt, /^agentia_model_duration_ms_count\{model="claude-opus-5"\} 2$/m);
    const s = m.snapshot();
    assert.equal(s.models['claude-opus-5']!.unpricedTurns, 0);
    assert.equal(s.models['claude-opus-5']!.latencyP50, 90);
  });

  it('未定价 turn 计入 unpricedTurns（成本护栏失效的显式信号）', () => {
    const t = richTrace();
    delete (t.spans[1]!.usage as { costEstimate?: number }).costEstimate;
    const m = metricsSink();
    m.export(t);
    const txt = m.render();
    assert.match(txt, /^agentia_model_unpriced_turns_total\{model="claude-opus-5"\} 1$/m);
    assert.equal(m.snapshot().models['claude-opus-5']!.unpricedTurns, 1);
    assert.equal(m.snapshot().models['claude-opus-5']!.costUsd, 0.002);
  });
});

describe('E5 OTLP/JSON 指标导出', () => {
  async function startCollector(
    statusCode: number,
    responseBody = statusCode === 200 ? '{}' : 'collector exploded',
  ): Promise<{ server: Server; base: string; bodies: any[] }> {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push({
          url: req.url,
          contentType: req.headers['content-type'],
          body: JSON.parse(raw),
        });
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(responseBody);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return { server, base: `http://127.0.0.1:${port}`, bodies };
  }
  const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

  it('export:"otlp" 必须给 endpoint（不给就构造期抛错，不静默不导出）', () => {
    assert.throws(() => metricsSink({ export: 'otlp' }), /必须给 endpoint/);
  });

  it('collector 半开连接（accept 不回包）时 flush 受 timeoutMs 兜底，不挂死', async () => {
    // 永不回包的假 collector
    const server = createServer(() => {
      /* 故意不响应 */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const errors: unknown[] = [];
      const m = metricsSink({
        export: 'otlp',
        endpoint: `http://127.0.0.1:${port}`,
        intervalMs: 0,
        timeoutMs: 100,
        onExportError: (e) => errors.push(e),
      });
      await m.export(traceOf({ durationMs: 5 })); // intervalMs:0 → flush 被 await，不得卡住
      m.stop();
      assert.equal(errors.length, 1);
      assert.equal((errors[0] as Error).name, 'TimeoutError');
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  /*
   * reset() 必须**前移窗口起点**（2026-09-21 外部复核实测的缺陷）：它此前只清计数器，
   * 起点仍是 sink 创建时刻 ⇒ 同一 `startTimeUnixNano` 下 counter 从 2 退回 1。
   * 对 OTLP CUMULATIVE 指标来说这是「同一区间里单调 counter 倒退」，后端会算负增量或丢样本。
   */
  it('reset 之后导出：值回到 1，且窗口起点严格前移（CUMULATIVE 不得倒退）', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({ export: 'otlp', endpoint: base, intervalMs: 0 });
      const runsTotal = (i: number): { startTimeUnixNano: string; asInt: string } => {
        const metrics = bodies[i].body.resourceMetrics[0].scopeMetrics[0].metrics;
        const mt = metrics.find((x: { name: string }) => x.name === 'agentia_runs_total');
        return mt.sum.dataPoints[0];
      };

      await m.export(traceOf({ durationMs: 5 }));
      const first = runsTotal(0);
      assert.equal(first.asInt, '1');

      await m.export(traceOf({ durationMs: 5 }));
      const second = runsTotal(1);
      assert.equal(second.asInt, '2');
      assert.equal(
        second.startTimeUnixNano,
        first.startTimeUnixNano,
        '同一窗口内 startTime 必须不变（否则不是累计窗口）',
      );

      m.reset();
      await m.export(traceOf({ durationMs: 5 }));
      const after = runsTotal(2);
      assert.equal(after.asInt, '1', 'reset 就是开新窗口，值从头计');
      assert.ok(
        BigInt(after.startTimeUnixNano) > BigInt(first.startTimeUnixNano),
        'reset 后起点必须严格前移 —— 否则后端在同一区间看到 2→1 的倒退：' +
          `before=${first.startTimeUnixNano} after=${after.startTimeUnixNano}`,
      );
    } finally {
      await close(server);
    }
  });

  /*
   * 上一条用例走真实时钟：两次 reset 之间隔了网络往返，起点必然前进 —— 它守不住
   * 「**同一毫秒**内连按两次 reset」这个角落。那时裸 `Date.now()` 会让两个新窗口共用
   * 同一个 startTime，后端看到的仍是同一区间内 counter 倒退（metrics-state.ts 的
   * `Math.max(now, 前值 + 1)` 就是为这个角落存在的）。这里冻结时钟把它钉死。
   */
  it('同一毫秒内连按两次 reset：窗口起点仍严格前进（靠前值+1，不靠时钟）', () => {
    const realNow = Date.now;
    // 冻结时钟：构造与两次 reset 全部落在同一毫秒
    Date.now = () => 1_000_000;
    try {
      const state = new MetricsState({
        windowSize: 8,
        maxCapabilities: 8,
        maxModels: 8,
        maxScores: 8,
        labelMode: 'capability',
        buckets: [10],
        labelKeys: [],
        maxLabelValues: 8,
        maxLabelCombos: 8,
      });
      state.reset();
      const first = state.windowStartedAt;
      state.reset();
      assert.ok(
        state.windowStartedAt > first,
        '同毫秒连按两次 reset，第二个窗口的起点必须严格大于第一个：' +
          `first=${first} second=${state.windowStartedAt}`,
      );
    } finally {
      Date.now = realNow;
    }
  });

  /*
   * 200 **不等于「全部接收」**（metrics 侧与 traces 侧同一处缺陷、同一个修法）：
   * collector 可以回 200 + `partialSuccess`（部分数据点被丢）。原先只查 `res.ok` ⇒
   * 「指标少了一半而框架说一切正常」。metrics 侧的失败通道是 `onExportError`（缺省落
   * console.warn，见下一条用例）。
   */
  it('HTTP 200 + partialSuccess 真拒收 → 走 onExportError，不再当全成功', async () => {
    const { server, base } = await startCollector(
      200,
      JSON.stringify({ partialSuccess: { rejectedDataPoints: 2 } }),
    );
    try {
      const seen: unknown[] = [];
      const m = metricsSink({
        export: 'otlp',
        endpoint: base,
        intervalMs: 0,
        onExportError: (e) => seen.push(e),
      });
      await m.export(traceOf({ durationMs: 5 }));
      assert.equal(seen.length, 1, '部分接收必须能被宿主收到');
      assert.match(String((seen[0] as Error).message), /部分接收/);
      assert.match(String((seen[0] as Error).message), /rejected_dataPoints=2/);
    } finally {
      await close(server);
    }
  });

  it('flush 真发 POST /v1/metrics，结构是合法 OTLP（resourceMetrics→scopeMetrics→metrics）', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({
        export: 'otlp',
        endpoint: `${base}/`,
        intervalMs: 0,
        serviceName: 'svc-x',
      });
      await m.export(richTrace());
      m.stop();
      assert.equal(bodies.length, 1, 'intervalMs:0 → 每次 export 立即导出');
      assert.equal(bodies[0].url, '/v1/metrics');
      assert.match(bodies[0].contentType ?? '', /application\/json/);

      const rm = bodies[0].body.resourceMetrics[0];
      assert.deepEqual(rm.resource.attributes, [
        { key: 'service.name', value: { stringValue: 'svc-x' } },
      ]);
      const metrics = rm.scopeMetrics[0].metrics as Array<Record<string, any>>;
      const byName = (n: string) => metrics.filter((x) => x.name === n);
      assert.equal(byName('agentia_runs_total')[0].sum.dataPoints[0].asInt, '1');
      assert.equal(byName('agentia_runs_total')[0].sum.aggregationTemporality, 2);
      const hist = byName('agentia_run_duration_ms')[0].histogram.dataPoints[0];
      assert.equal(hist.count, 1);
      assert.equal(hist.sum, 300);
      assert.equal(hist.explicitBounds.length, hist.bucketCounts.length - 1);
      // 能力维度带 attributes（同名指标聚合后按 dataPoint 的 label 区分）
      const capabilityCalls = byName('agentia_capability_calls_total')[0].sum.dataPoints.find(
        (d: any) => d.attributes[0].value.stringValue === 'tool:search',
      );
      assert.equal(capabilityCalls.asInt, '2');
    } finally {
      await close(server);
    }
  });

  it('OTLP payload 结构：浮点走 asDouble、histogram 的 bucketCounts 是每桶非累积计数、纳秒时间戳不丢精度', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({
        export: 'otlp',
        endpoint: base,
        intervalMs: 0,
        buckets: [50, 100],
      });
      await m.export(traceOf({ durationMs: 60, costEstimate: 0.25 }));
      m.stop();
      const metrics = bodies[0].body.resourceMetrics[0].scopeMetrics[0].metrics as Array<
        Record<string, any>
      >;
      const byName = (n: string) => metrics.find((x) => x.name === n)!;

      // 成本是浮点：OTLP 的 asInt 是 string 编码 int64，塞浮点 collector 会拒收
      const cost = byName('agentia_cost_usd_total').sum.dataPoints[0];
      assert.equal(cost.asDouble, 0.25);
      assert.equal('asInt' in cost, false, '浮点指标不得走 asInt');
      // 整型计数仍走 asInt
      assert.equal(byName('agentia_runs_total').sum.dataPoints[0].asInt, '1');

      // duration=60、buckets=[50,100]：非累积 = [0,1,0]（累积语义会是 [0,1,1]）
      const hist = byName('agentia_run_duration_ms').histogram.dataPoints[0];
      assert.deepEqual(hist.bucketCounts, [0, 1, 0], 'OTLP bucketCounts 是每桶非累积计数');
      assert.equal(hist.count, 1);

      // epoch 毫秒 ×1e6 超 2^53：纳秒时间戳必须是 1e6 的整数倍（BigInt 计算的结果必然满足，
      // double 直接乘的结果几乎必然不满足 —— 低精度位被舍掉）
      const dp = byName('agentia_runs_total').sum.dataPoints[0];
      assert.equal(BigInt(dp.startTimeUnixNano) % 1_000_000n, 0n);
      assert.equal(BigInt(dp.timeUnixNano) % 1_000_000n, 0n);
    } finally {
      await close(server);
    }
  });

  it('导出失败被吞并走 onExportError（观测不得击穿业务）', async () => {
    const { server, base } = await startCollector(500);
    try {
      const errs: unknown[] = [];
      const m = metricsSink({
        export: 'otlp',
        endpoint: base,
        intervalMs: 0,
        onExportError: (e) => errs.push(e),
      });
      await m.export(richTrace()); // 不应抛出
      m.stop();
      assert.equal(errs.length, 1);
      assert.match(String(errs[0]), /HTTP 500/);
    } finally {
      await close(server);
    }
  });

  it('缺省（无 onExportError）时导出失败落 console.warn —— 不零信号（与 traces 侧 flushSinks 同款）', async () => {
    // 反向验证：把 flushOtlpMetrics 的缺省回调退化回 `opts.onExportError?.(e)` ⇒
    // 失败被 `?.` 吞掉连 warn 都没有，本用例红在 warns 为空。
    const { server, base } = await startCollector(500);
    const origWarn = console.warn;
    const warns: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      const m = metricsSink({ export: 'otlp', endpoint: base, intervalMs: 0 });
      await m.export(traceOf({ durationMs: 5 })); // 不应抛出（观测不击穿业务）
      m.stop();
    } finally {
      console.warn = origWarn;
      await close(server);
    }
    assert.equal(warns.length, 1, '缺省必须有 warn，不能零信号');
    assert.match(String(warns[0]![0]), /OTLP metrics 导出失败/);
    assert.match(String(warns[0]![1]), /HTTP 500/);
  });

  it('prometheus 模式下 flush 是空操作（拉取式，无主动导出）', async () => {
    const m = metricsSink();
    await m.flush();
    m.stop();
    assert.match(m.render(), /agentia_runs_total 0/);
  });

  it('OTLP payload 带 score gauge（asDouble）与 score_total counter（asInt）', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({ export: 'otlp', endpoint: base, intervalMs: 0 });
      const t = traceOf({});
      attachScore(t, { name: 'faithfulness', value: 0.8, source: 'eval-x' });
      attachScore(t, { name: 'faithfulness', value: 0.6, source: 'eval-x' });
      await m.export(t);
      m.stop();

      const metrics = bodies[0].body.resourceMetrics[0].scopeMetrics[0].metrics as Array<
        Record<string, any>
      >;
      const byName = (n: string) => metrics.find((x) => x.name === n)!;

      const gauge = byName('agentia_score').gauge.dataPoints[0];
      assert.equal(gauge.asDouble, 0.6);
      assert.deepEqual(gauge.attributes, [
        { key: 'name', value: { stringValue: 'faithfulness' } },
        { key: 'source', value: { stringValue: 'eval-x' } },
      ]);

      const counter = byName('agentia_score_total').sum.dataPoints[0];
      assert.equal(counter.asInt, '2');
      assert.equal(byName('agentia_score_total').sum.aggregationTemporality, 2);
    } finally {
      await close(server);
    }
  });

  it('同名指标聚合成一个 Metric 的多个 dataPoints（OTLP 数据模型：同名多 Metric 是 semantic error）', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({ export: 'otlp', endpoint: base, intervalMs: 0 });
      const t = richTrace(); // 三个能力标签 + 一个模型；再补一个模型与两个评分键
      t.spans.push({
        spanId: 'turn-3',
        traceId: 't-rich',
        parentSpanId: 'root-1',
        kind: 'llm.turn',
        name: 'gpt-5',
        startedAt: 1210,
        endedAt: 1290,
        status: 'ok',
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.001,
        },
        attributes: {},
        events: [],
      });
      attachScore(t, { name: 'faithfulness', value: 0.8, source: 'eval-x' });
      attachScore(t, { name: 'helpfulness', value: 1 });
      await m.export(t);
      m.stop();

      const metrics = bodies[0].body.resourceMetrics[0].scopeMetrics[0].metrics as Array<
        Record<string, any>
      >;
      // 每个 name 恰好一个 Metric 对象 —— 同名多 Metric 在 OTLP 规范里是 semantic error，
      // consumer 可以拒收整批
      const names = metrics.map((x) => x.name as string);
      const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      assert.deepEqual(
        dupes,
        [],
        `同名指标被拆成了多个 Metric 对象（OTLP semantic error）: ${dupes.join(', ')}`,
      );
      const one = (n: string) => {
        const found = metrics.filter((x) => x.name === n);
        assert.equal(found.length, 1, `${n} 应恰好一个 Metric`);
        return found[0]!;
      };

      // tokens_total：四类 kind 收进同一个 sum，attribute label 不丢
      const tok = one('agentia_tokens_total');
      assert.equal(tok.sum.dataPoints.length, 4, '四个 kind 应是同一 Metric 的四个 dataPoint');
      assert.deepEqual(
        tok.sum.dataPoints.map((d: any) => [d.attributes[0].value.stringValue, d.asInt]),
        [
          ['input', '120'],
          ['output', '30'],
          ['cache_read', '5'],
          ['cache_creation', '0'],
        ],
      );
      // 同名只保留一份 description，且与 Prometheus 侧 family() 的总述文案一致
      assert.equal(
        tok.description,
        'token 累计（kind 分项：input / output / cache_read / cache_creation）',
      );

      // capability 维度：三个能力标签收进同一 Metric（排序键：subagent < tool:fetch < tool:search）
      const capCalls = one('agentia_capability_calls_total');
      assert.deepEqual(
        capCalls.sum.dataPoints.map((d: any) => [
          d.attributes[0].key,
          d.attributes[0].value.stringValue,
          d.asInt,
        ]),
        [
          ['capability', 'subagent:researcher', '1'],
          ['capability', 'tool:fetch', '1'],
          ['capability', 'tool:search', '2'],
        ],
      );
      // histogram 同理：一个 Metric，三个 dataPoint
      assert.equal(one('agentia_capability_duration_ms').histogram.dataPoints.length, 3);

      // model 维度：两个模型收进同一 Metric
      const turns = one('agentia_model_turns_total');
      assert.deepEqual(
        turns.sum.dataPoints.map((d: any) => [d.attributes[0].value.stringValue, d.asInt]),
        [
          ['claude-opus-5', '2'],
          ['gpt-5', '1'],
        ],
      );

      // dropped_keys：三个 kind 收进同一个 gauge
      const dropped = one('agentia_dropped_keys');
      assert.deepEqual(
        dropped.gauge.dataPoints.map((d: any) => d.attributes[0].value.stringValue),
        ['capability', 'model', 'score'],
      );

      // score / score_total：两个评分键收进各自一个 Metric
      assert.equal(one('agentia_score').gauge.dataPoints.length, 2);
      assert.equal(one('agentia_score_total').sum.dataPoints.length, 2);
    } finally {
      await close(server);
    }
  });
});

describe('R7 评分（score 事件）聚合', () => {
  it('gauge 记最近一次值、counter 记条数；snapshot 暴露 scores 汇总', () => {
    const m = metricsSink();
    const t = traceOf({ durationMs: 5 });
    attachScore(t, { name: 'faithfulness', value: 0.8, source: 'eval-x' });
    attachScore(t, { name: 'faithfulness', value: 0.6, source: 'eval-x' });
    attachScore(t, { name: 'helpfulness', value: 1 });
    m.export(t);

    const txt = m.render();
    assert.match(txt, /# TYPE agentia_score gauge/);
    assert.match(txt, /# TYPE agentia_score_total counter/);
    assert.match(
      txt,
      /^agentia_score\{name="faithfulness",source="eval-x"\} 0.6$/m,
      'gauge = 最近一次值（0.8 被 0.6 覆盖）',
    );
    assert.match(txt, /^agentia_score_total\{name="faithfulness",source="eval-x"\} 2$/m);
    assert.match(txt, /^agentia_score\{name="helpfulness",source=""\} 1$/m, 'source 缺省为空串');
    assert.match(txt, /^agentia_score_total\{name="helpfulness",source=""\} 1$/m);

    const { scores } = m.snapshot();
    assert.deepEqual(scores['faithfulness@eval-x'], { value: 0.6, count: 2, sum: 1.4 });
    assert.deepEqual(scores.helpfulness, { value: 1, count: 1, sum: 1 });
  });

  it('无 score 事件的 trace 不产出 score 家族；畸形 body 跳过', () => {
    const m = metricsSink();
    m.export(traceOf({}));
    m.export(richTrace());
    let txt = m.render();
    assert.equal(/agentia_score/.test(txt), false);
    assert.deepEqual(m.snapshot().scores, {});

    // 畸形 body：缺 value / value 非 number / body 不是对象 —— 全部跳过
    const t = traceOf({});
    t.spans[0]!.events.push(
      { time: 1, name: 'score', body: { name: 'x' } },
      { time: 2, name: 'score', body: { name: 'y', value: 'high' } },
      { time: 3, name: 'score', body: 'junk' },
    );
    m.export(t);
    txt = m.render();
    assert.equal(/agentia_score/.test(txt), false, '三条畸形 score 都不计入');
    assert.deepEqual(m.snapshot().scores, {});
  });

  it('评分名带引号走 escLabel 转义；reset 清空评分', () => {
    const m = metricsSink();
    const t = traceOf({});
    attachScore(t, { name: 'a"b', value: 0.5, source: 'eval' });
    m.export(t);
    assert.match(m.render(), /agentia_score\{name="a\\"b",source="eval"\} 0.5/);

    m.reset();
    assert.deepEqual(m.snapshot().scores, {});
    assert.equal(/agentia_score/.test(m.render()), false);
  });
});

describe('基数上限（内存上界：三个维度的键空间都得封住）', () => {
  /** 造一个 llm.turn span —— 凑模型键空间用 */
  function turnSpan(spanId: string, model: string, inputTokens: number): Span {
    return {
      spanId,
      traceId: 't-rich',
      parentSpanId: 'root-1',
      kind: 'llm.turn',
      name: model,
      startedAt: 1000,
      endedAt: 1010,
      status: 'ok',
      usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      attributes: {},
      events: [],
    };
  }

  it('maxModels：超限模型归 __other__，**turn 与 token 不丢账**（丢的只是标签粒度）', () => {
    const m = metricsSink({ maxModels: 1 });
    const t = richTrace(); // claude-opus-5：2 turns / 155 tokens
    t.spans.push(turnSpan('turn-3', 'gpt-5', 7), turnSpan('turn-4', 'gpt-5-mini', 11));
    m.export(t);

    const s = m.snapshot();
    assert.equal(s.models['claude-opus-5']!.turns, 2, '首个模型保住自己的标签');
    assert.equal(s.models.__other__!.turns, 2, '后两个模型折进同一桶');
    assert.equal(s.droppedModels, 2, '记「多少个不同的模型被折叠了」');
    // 上限是给内存封顶的，不是给账本封顶的：总量必须对得上
    const turns = Object.values(s.models).reduce((a, x) => a + x.turns, 0);
    assert.equal(turns, 4, '折叠后 turn 总数不变');
    assert.match(m.render(), /^agentia_model_turns_total\{model="__other__"\} 2$/m);
  });

  it('maxScores：超限评分键归 __other__，条数照记；标签不得被切成乱码', () => {
    const m = metricsSink({ maxScores: 1 });
    const t = traceOf({ durationMs: 5 });
    attachScore(t, { name: 'a', value: 1, source: 's1' }); // 唯一分到标签的
    attachScore(t, { name: 'b', value: 1, source: 's2' });
    attachScore(t, { name: 'c', value: 0 }); // 无 source：折叠后也不该与前面混同
    m.export(t);

    const s = m.snapshot();
    assert.equal(s.scores['a@s1']!.count, 1);
    assert.equal(s.scores.__other__!.count, 2, '被折叠的两条照记');
    assert.equal(s.scores.__other__!.value, 0, 'gauge 语义保留：最近一次的值');
    assert.equal(s.droppedScores, 2);
    // 折叠桶键里没有 \t，按 `name\tsource` 硬切会切出 `__other_` / 整键 —— 两个出口都得解码对
    assert.match(m.render(), /^agentia_score\{name="__other__",source=""\} 0$/m);
  });

  it('未超限时折叠桶不出现（上限不是「一定要用满」）', () => {
    const m = metricsSink();
    m.export(richTrace());
    const s = m.snapshot();
    assert.equal('__other__' in s.models, false);
    assert.equal('__other__' in s.scores, false);
    assert.deepEqual(
      [s.droppedCapabilities, s.droppedModels, s.droppedScores],
      [0, 0, 0],
      '未折叠时三个计数都是 0',
    );
  });

  it('reset 一并清掉配额与折叠计数（否则上限算「用过了」，下一轮全被折叠）', () => {
    const m = metricsSink({ maxModels: 1 });
    const t = richTrace();
    t.spans.push(turnSpan('turn-3', 'gpt-5', 7));
    m.export(t);
    assert.equal(m.snapshot().droppedModels, 1);

    m.reset();
    const s = m.snapshot();
    assert.deepEqual(s.models, {});
    assert.equal(s.droppedModels, 0);

    // 配额也一并归零：重置后同一个模型键仍能分到自己的标签
    m.export(t);
    assert.equal(m.snapshot().models['claude-opus-5']!.turns, 2);
    assert.equal(m.snapshot().droppedModels, 1);
  });

  it('非法上限（0 / 负数 / NaN）构造期抛错 —— 归零会让所有键都进折叠桶', () => {
    assert.throws(() => metricsSink({ maxModels: 0 }), /maxModels/);
    assert.throws(() => metricsSink({ maxScores: -1 }), /maxScores/);
    assert.throws(() => metricsSink({ maxScores: Number.NaN }), /maxScores/);
  });
});

/**
 * D（2026-09-18 第七轮复审）：基数上限折叠必须**在 /metrics 上可见**。
 *
 * 此前 `droppedCapabilities/Models/Scores` 只存在于 `snapshot()`，`render()` 一个都没有 ——
 * 而文档让用户把 `metricsSink()` 接到 `GET /metrics`（只消费 `render()`），
 * 于是 Prometheus-only 的部署**完全看不见折叠发生**（静默丢失）。
 * 对照：同一份文件对「算不出成本的 turn」专门发了 `model_unpriced_turns_total`。
 */
function traceWithModel(model: string): Trace {
  const traceId = `t-${model}`;
  const rootSpanId = `r-${model}`;
  return {
    traceId,
    rootSpanId,
    status: 'ok',
    totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: rootSpanId,
        traceId,
        parentSpanId: null,
        kind: 'run',
        name: 'app',
        startedAt: 1,
        endedAt: 2,
        status: 'ok',
        attributes: {},
        events: [],
      },
      {
        spanId: `s-${model}`,
        traceId,
        parentSpanId: rootSpanId,
        kind: 'llm.turn',
        name: model,
        startedAt: 1,
        endedAt: 2,
        status: 'ok',
        attributes: {},
        events: [],
      },
    ],
  };
}

describe('D：基数折叠在 render() / Prometheus 面可见', () => {
  it('maxModels=1 + 3 个模型 → 三个 *_dropped_keys gauge，且折叠数对得上 snapshot', () => {
    const sink = metricsSink({ maxModels: 1 });
    for (const m of ['m-a', 'm-b', 'm-c']) sink.export(traceWithModel(m));

    assert.equal(sink.snapshot().droppedModels, 2, '两条被折叠（这是 snapshot 侧的既有口径）');
    const text = sink.render();
    assert.match(text, /# TYPE agentia_dropped_keys gauge/);
    assert.match(text, /agentia_dropped_keys\{kind="model"\} 2/);
  });

  it('恒定发三个（即使为 0）—— 「0 → N」本身就是要告警的信号', () => {
    const sink = metricsSink();
    sink.export(traceWithModel('m-a'));
    const text = sink.render();
    for (const k of ['capability', 'model', 'score']) {
      assert.match(text, new RegExp(`agentia_dropped_keys\\{kind="${k}"\\} 0`));
    }
  });
});

/**
 * exemplars（指标 ↔ trace 互跳）：失败 counter 挂「最近一次失败 run」、
 * run 时长 histogram 挂「迄今最慢的一次 run」。
 * 出口三路各验一遍：snapshot() / OpenMetrics 文本 / OTLP 数据点；
 * 外加一条回归护栏 —— 缺省 prometheus 输出必须**逐字节不变**（exemplar 不可泄漏进 0.0.4 文本）。
 */
describe('exemplars：指标尖峰 → 那条 trace', () => {
  const A = 'a'.repeat(32); // 已是 32-hex，wireTraceId 投影后是恒等
  const B = 'b'.repeat(32);

  /** traceOf 的可换 id 版：exemplar 断言要按 traceId 区分是哪条 run */
  function tracedRun(traceId: string, opts: Parameters<typeof traceOf>[0]): Trace {
    const t = traceOf(opts);
    t.traceId = traceId;
    t.spans[0]!.traceId = traceId;
    return t;
  }

  it('失败 run 之后：snapshot 的 failed exemplar 指向它的 traceId（覆盖式，取最近一次）', () => {
    const m = metricsSink();
    m.export(tracedRun(A, { durationMs: 10 }));
    assert.equal(m.snapshot().exemplars.failed, undefined, '尚无失败时不得有 exemplar');

    m.export(tracedRun(B, { status: 'error', durationMs: 5 }));
    assert.equal(m.snapshot().exemplars.failed?.traceId, B);

    m.export(tracedRun(A, { status: 'error', durationMs: 5 }));
    assert.equal(m.snapshot().exemplars.failed?.traceId, A, '后到的失败覆盖前一个');
  });

  it('更慢的 run 取代旧的 slowest exemplar；等值不替换（「最慢」是稳定锚点）', () => {
    const m = metricsSink();
    m.export(tracedRun(A, { durationMs: 50 }));
    m.export(tracedRun(B, { durationMs: 20 }));
    assert.equal(m.snapshot().exemplars.slowest?.traceId, A, '更慢的 B（20ms）没有取代 A');
    assert.equal(m.snapshot().exemplars.slowest?.durationMs, 50);

    m.export(tracedRun(B, { durationMs: 50 }));
    assert.equal(m.snapshot().exemplars.slowest?.traceId, A, '等值（50ms）不替换');

    m.export(tracedRun(B, { durationMs: 80 }));
    assert.equal(m.snapshot().exemplars.slowest?.traceId, B, '破纪录（80ms）才换');
    assert.equal(m.snapshot().exemplars.slowest?.durationMs, 80);
  });

  it('根未收尾（无时长）的 run 不进 slowest exemplar；reset 清空两个槽位', () => {
    const m = metricsSink();
    m.export(tracedRun(A, {})); // 根没收尾
    assert.equal(m.snapshot().exemplars.slowest, undefined);

    m.export(tracedRun(A, { status: 'error', durationMs: 5 }));
    m.reset();
    assert.deepEqual(m.snapshot().exemplars, { failed: undefined, slowest: undefined });
  });

  /*
   * 回归护栏：缺省 prometheus 输出**逐字节**不含 exemplar（0.0.4 文本没有 exemplar 语法，
   * 泄漏进去会让 expfmt 解析整页失败）。期望值抄自引入 exemplars 之前的渲染结果；
   * 场景里**刻意带**一条失败 run 与一个时长样本（两个 exemplar 槽位都已记账），
   * 它们一个字符都不许出现在输出里。
   */
  it('缺省 prometheus 输出与改动前逐字节一致（exemplar 已记账但不出现在 0.0.4 文本里）', () => {
    const m = metricsSink({ buckets: [100] });
    m.export(
      traceOf({
        status: 'error',
        durationMs: 50,
        input: 3,
        output: 4,
        cacheRead: 5,
        cacheCreation: 6,
        costEstimate: 0.25,
      }),
    );
    assert.equal(m.snapshot().exemplars.failed?.traceId, 't-1', 'exemplar 确实记了账');
    assert.equal(m.snapshot().exemplars.slowest?.traceId, 't-1');
    const expected = [
      '# HELP agentia_runs_total run 总数（成功 + 失败）',
      '# TYPE agentia_runs_total counter',
      'agentia_runs_total 1',
      '# HELP agentia_runs_failed_total 失败的 run 数（trace.status=error）',
      '# TYPE agentia_runs_failed_total counter',
      'agentia_runs_failed_total 1',
      '# HELP agentia_tokens_total token 累计（kind 分项：input / output / cache_read / cache_creation）',
      '# TYPE agentia_tokens_total counter',
      'agentia_tokens_total{kind="input"} 3',
      'agentia_tokens_total{kind="output"} 4',
      'agentia_tokens_total{kind="cache_read"} 5',
      'agentia_tokens_total{kind="cache_creation"} 6',
      '# HELP agentia_cost_usd_total 累计成本估算（美元）',
      '# TYPE agentia_cost_usd_total counter',
      'agentia_cost_usd_total 0.25',
      '# HELP agentia_dropped_keys 因基数上限被折叠的不同键数（kind 分项）',
      '# TYPE agentia_dropped_keys gauge',
      'agentia_dropped_keys{kind="capability"} 0',
      'agentia_dropped_keys{kind="model"} 0',
      'agentia_dropped_keys{kind="score"} 0',
      '# HELP agentia_run_duration_ms run 时长（毫秒）',
      '# TYPE agentia_run_duration_ms histogram',
      'agentia_run_duration_ms_bucket{le="100"} 1',
      'agentia_run_duration_ms_bucket{le="+Inf"} 1',
      'agentia_run_duration_ms_sum 50',
      'agentia_run_duration_ms_count 1',
      '# HELP agentia_run_duration_ms_last run 时长分位（毫秒，滑动窗口内精确值）',
      '# TYPE agentia_run_duration_ms_last gauge',
      'agentia_run_duration_ms_last{quantile="0.5"} 50',
      'agentia_run_duration_ms_last{quantile="0.95"} 50',
      '',
    ].join('\n');
    assert.equal(m.render(), expected);
  });

  it('openmetrics：样本行尾挂 # {trace_id=…}，histogram exemplar 落在它所属 bucket，# EOF 收尾', () => {
    const m = metricsSink({ export: 'openmetrics', buckets: [100] });
    m.export(tracedRun(A, { durationMs: 50 }));
    m.export(tracedRun(B, { status: 'error', durationMs: 10 }));
    const txt = m.render();

    assert.ok(txt.endsWith('# EOF\n'), 'OpenMetrics 必须以 # EOF 收尾');
    // counter：exemplar 值 = 该次增量 1，行尾带时间戳（秒）
    assert.match(
      txt,
      new RegExp(`^agentia_runs_failed_total 1 # \\{trace_id="${B}"\\} 1 \\d+(\\.\\d+)?$`, 'm'),
    );
    // histogram：最慢那次是 A 的 50ms，落在 le="100" 桶；exemplar 值 = 观测时长
    assert.match(
      txt,
      new RegExp(
        `^agentia_run_duration_ms_bucket\\{le="100"\\} 2 # \\{trace_id="${A}"\\} 50 \\d+(\\.\\d+)?$`,
        'm',
      ),
    );
    // 其余样本行不得带 exemplar（+Inf 桶没有、sum/count 没有、runs_total 没有）
    assert.match(txt, /^agentia_run_duration_ms_bucket\{le="\+Inf"\} 2$/m);
    assert.match(txt, /^agentia_runs_total 2$/m);
    // 除 exemplar 与 EOF 外与 prometheus 渲染同源：去掉两处尾巴与 EOF 后应逐字节相等
    const stripped = txt.replace(/ # \{trace_id="[^"]+"\} [^\n]+/g, '').replace('# EOF\n', '');
    const p = metricsSink({ buckets: [100] });
    p.export(tracedRun(A, { durationMs: 50 }));
    p.export(tracedRun(B, { status: 'error', durationMs: 10 }));
    assert.equal(stripped, p.render());
  });

  it('openmetrics：最慢那次越过所有桶边界时，exemplar 挂在 +Inf 桶行上', () => {
    const m = metricsSink({ export: 'openmetrics', buckets: [100] });
    m.export(tracedRun(A, { durationMs: 5000 }));
    assert.match(
      m.render(),
      new RegExp(
        `^agentia_run_duration_ms_bucket\\{le="\\+Inf"\\} 1 # \\{trace_id="${A}"\\} 5000 `,
        'm',
      ),
    );
  });

  it('openmetrics：无失败/无时长样本时不挂 exemplar（只有 # EOF 这一个新增）', () => {
    const m = metricsSink({ export: 'openmetrics' });
    m.export(traceOf({})); // 根未收尾 + 无失败
    const txt = m.render();
    assert.ok(txt.endsWith('# EOF\n'));
    assert.equal(txt.includes('# {trace_id='), false);
  });

  it('OTLP：runs_failed_total 与 run_duration_ms 的数据点带 exemplars（hex 投影 + 根 spanId）', async () => {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const m = metricsSink({
        export: 'otlp',
        endpoint: `http://127.0.0.1:${port}`,
        intervalMs: 0,
      });
      await m.export(tracedRun(A, { durationMs: 50 }));
      await m.export(tracedRun(B, { status: 'error', durationMs: 10 }));
      m.stop();

      const metrics = bodies.at(-1).resourceMetrics[0].scopeMetrics[0].metrics as Array<
        Record<string, any>
      >;
      const byName = (n: string) => metrics.find((x) => x.name === n)!;

      const failed = byName('agentia_runs_failed_total').sum.dataPoints[0];
      assert.equal(failed.exemplars.length, 1);
      assert.equal(failed.exemplars[0].traceId, B, '已是 hex 形态（wireTraceId 恒等投影）');
      assert.equal(failed.exemplars[0].spanId, 'root1', 'wireSpanId：去横线截 16 位');
      assert.equal(failed.exemplars[0].asInt, '1', 'counter exemplar 值 = 该次增量');
      assert.equal(BigInt(failed.exemplars[0].timeUnixNano) % 1_000_000n, 0n);

      const hist = byName('agentia_run_duration_ms').histogram.dataPoints[0];
      assert.equal(hist.exemplars.length, 1);
      assert.equal(hist.exemplars[0].traceId, A, '最慢那次（50ms）');
      assert.equal(hist.exemplars[0].asDouble, 50, 'histogram exemplar 值 = 观测时长');

      // 不挂 exemplar 的数据点不得有 exemplars 键
      assert.equal('exemplars' in byName('agentia_runs_total').sum.dataPoints[0], false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/**
 * R8-P4 归因标签（run 根 `labels.*` → 指标标签）：`metricsSink({ labelKeys })` 显式点名的键
 * 才上指标（缺省一个都不上），每个键的相异值数受 `maxLabelValues` 封顶（超出折叠进
 * `__other__`，只丢标签粒度不丢量）。trace 侧写入见 tests/engine/run-labels.test.ts。
 */
describe('R8-P4 归因标签（labelKeys → 指标标签）', () => {
  it('labelKeys 生效：runLabels 按 combo 分账，四个计数口径与全局对得上', () => {
    const sink = metricsSink({ labelKeys: ['tenant'] });
    sink.export(
      traceOf({
        durationMs: 5,
        input: 10,
        output: 5,
        costEstimate: 0.01,
        labels: { tenant: 'acme' },
      }),
    );
    sink.export(traceOf({ durationMs: 5, input: 4, output: 1, labels: { tenant: 'acme' } }));
    sink.export(
      traceOf({
        durationMs: 5,
        status: 'error',
        output: 2,
        costEstimate: 0.02,
        labels: { tenant: 'globex' },
      }),
    );

    const s = sink.snapshot();
    assert.equal(s.runs, 3);
    assert.deepEqual(s.runLabels['tenant=acme'], {
      runs: 2,
      failed: 0,
      tokens: 15 + 5,
      costUsd: 0.01,
    });
    assert.deepEqual(s.runLabels['tenant=globex'], {
      runs: 1,
      failed: 1,
      tokens: 2,
      costUsd: 0.02,
    });
    const sum = Object.values(s.runLabels).reduce((n, a) => n + a.runs, 0);
    assert.equal(sum, s.runs, '带标签分账之和必须等于全局总量（折叠只丢粒度不丢量）');
    assert.deepEqual(s.droppedLabelValues, { tenant: 0 });
  });

  it('缺省不配 labelKeys：run 根有 labels.* 也一个标签都不上', () => {
    const sink = metricsSink();
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'acme' } }));
    assert.deepEqual(sink.snapshot().runLabels, {});
    assert.deepEqual(sink.snapshot().droppedLabelValues, {});
    const text = sink.render();
    assert.equal(text.includes('tenant'), false, 'render 里不该出现任何归因标签');
  });

  it('maxLabelValues=1：第二个相异值折叠进 __other__，droppedLabelValues 计数，render 可见', () => {
    const sink = metricsSink({ labelKeys: ['tenant'], maxLabelValues: 1 });
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'acme' } }));
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'globex' } }));
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'initech' } }));

    const s = sink.snapshot();
    assert.equal(s.runLabels['tenant=acme']!.runs, 1, '第一个值认下自己');
    assert.equal(s.runLabels['tenant=__other__']!.runs, 2, '超出的两个值折叠同桶（量不丢）');
    assert.equal(s.droppedLabelValues.tenant, 2, '被折叠的不同值数');
    const text = sink.render();
    assert.match(text, /agentia_runs_total\{tenant="acme"\} 1/);
    assert.match(text, /agentia_runs_total\{tenant="__other__"\} 2/);
    assert.match(text, /agentia_dropped_keys\{kind="label:tenant"\} 2/);
  });

  it('maxLabelCombos：组合数（叉乘）也封顶 —— 折叠可见、量不丢、render 露头', () => {
    // 反向验证：摘掉 accumulate 里 comboBudget 那一跳 ⇒ 本用例红在「组合数 = 每键折叠桶
    // 的叉乘」（此前实测 maxLabelValues=2 + 2 键 = 9 条常驻）与 droppedLabelCombos 恒 0。
    const sink = metricsSink({ labelKeys: ['a', 'b'], maxLabelValues: 2, maxLabelCombos: 3 });
    for (const a of ['a1', 'a2', 'a3']) {
      for (const b of ['b1', 'b2', 'b3']) {
        sink.export(traceOf({ durationMs: 1, input: 1, labels: { a, b } }));
      }
    }
    const s = sink.snapshot();
    assert.equal(Object.keys(s.runLabels).length, 4, '3 个组合认自己 + 1 个折叠桶（未封顶是 9）');
    assert.equal(s.droppedLabelCombos, 6, '被折叠的**不同组合**数（这是此前完全看不见的那一项）');
    assert.equal(
      Object.values(s.runLabels).reduce((n, x) => n + x.runs, 0),
      s.runs,
      '折叠只丢标签粒度，不丢量',
    );
    assert.match(sink.render(), /agentia_dropped_keys\{kind="label:combos"\} 6/);
  });

  it('值里含 `,`/`=` 不许并账：两个不同标签集各记各的（combo 身份不是裸拼接）', () => {
    // 2026-09-27 ref-menu-drift-signals 实测：裸拼接时这两条都拼成 `a=x,b=y,b=z` ⇒ 并成一本账、且按第一条的
    // 标签渲染（第二条的量被错配）。
    const sink = metricsSink({ labelKeys: ['a', 'b'] });
    sink.export(traceOf({ durationMs: 1, input: 10, labels: { a: 'x,b=y', b: 'z' } }));
    sink.export(traceOf({ durationMs: 1, input: 20, labels: { a: 'x', b: 'y,b=z' } }));

    const s = sink.snapshot();
    assert.equal(Object.keys(s.runLabels).length, 2, '两个不同标签集必须是两条账');
    assert.equal(
      Object.values(s.runLabels).reduce((n, x) => n + x.runs, 0),
      2,
      '各 1 条 run（并账会变成一条 2）',
    );
    const text = sink.render();
    assert.match(text, /agentia_runs_total\{a="x,b=y",b="z"\} 1/);
    assert.match(text, /agentia_runs_total\{a="x",b="y,b=z"\} 1/, '第二条必须是自己的标签');
  });

  it('缺键 / 空串值按 "" 计（观测宽容读取，不击穿业务）', () => {
    const sink = metricsSink({ labelKeys: ['tenant', 'plan'] });
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'acme' } })); // plan 缺
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'acme', plan: '' } })); // 空串值
    const s = sink.snapshot();
    assert.equal(s.runLabels['tenant=acme,plan=']!.runs, 2, '缺键与空串值归同一个 combo');
  });

  it('render：四个 run 级家族追加带标签样本，全局行仍在（不带标签那行是总量）', () => {
    const sink = metricsSink({ labelKeys: ['tenant'] });
    sink.export(
      traceOf({
        durationMs: 5,
        input: 3,
        output: 2,
        costEstimate: 0.5,
        status: 'error',
        labels: { tenant: 'acme' },
      }),
    );
    const text = sink.render();
    assert.match(text, /agentia_runs_total 1\n/);
    assert.match(text, /agentia_runs_total\{tenant="acme"\} 1/);
    assert.match(text, /agentia_runs_failed_total\{tenant="acme"\} 1/);
    assert.match(text, /agentia_tokens_total\{tenant="acme"\} 5/);
    assert.match(text, /agentia_cost_usd_total\{tenant="acme"\} 0\.5/);
  });

  it('OTLP：同四家族追加带 attributes 的 dataPoint（全局点无 attributes）', async () => {
    const { buildOtlpPayload } = await import('../../src/integrations/metrics-otlp.js');
    // buildOtlpPayload 读的是 MetricsState（sink 的内部件），直接造一个真 state
    const st = new MetricsState({
      windowSize: 8,
      maxCapabilities: 8,
      maxModels: 8,
      maxScores: 8,
      labelMode: 'capability',
      buckets: [10],
      labelKeys: ['tenant'],
      maxLabelValues: 8,
      maxLabelCombos: 8,
    });
    st.accumulate(traceOf({ durationMs: 5, input: 3, labels: { tenant: 'acme' } }));
    const payload = buildOtlpPayload(st, {
      prefix: 'agentia_',
      serviceName: 'test',
      startedAtMs: 1000,
    }) as any;
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const byName = (n: string) => metrics.find((m: any) => m.name === n);
    const runsPoints = byName('agentia_runs_total').sum.dataPoints;
    assert.equal(runsPoints.length, 2, '全局点 + 带标签点');
    assert.deepEqual(runsPoints[0].attributes, [], '第一个是全局点');
    assert.deepEqual(runsPoints[1].attributes, [{ key: 'tenant', value: { stringValue: 'acme' } }]);
    const droppedPoints = byName('agentia_dropped_keys');
    assert.ok(
      droppedPoints.gauge.dataPoints.some(
        (d: any) => d.attributes[0]?.value.stringValue === 'label:tenant',
      ),
      'dropped_keys 要有 label:tenant 那一支',
    );
  });

  it('构造期校验：非法标签名 / 重复键 / maxLabelValues 非正 一律抛错', () => {
    assert.throws(() => metricsSink({ labelKeys: ['not a label'] }), /Prometheus 标签名/);
    assert.throws(() => metricsSink({ labelKeys: ['9lives'] }), /Prometheus 标签名/);
    assert.throws(() => metricsSink({ labelKeys: ['tenant', 'tenant'] }), /重复/);
    assert.throws(() => metricsSink({ maxLabelValues: 0 }), /必须为正数/);
    // 合法的最小配置放行
    assert.equal(typeof metricsSink({ labelKeys: ['tenant', 'plan'] }).render, 'function');
  });

  it('reset() 清空 runLabels 与每键的折叠计数', () => {
    const sink = metricsSink({ labelKeys: ['tenant'], maxLabelValues: 1 });
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'acme' } }));
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'globex' } }));
    assert.equal(sink.snapshot().droppedLabelValues.tenant, 1);
    sink.reset();
    const s = sink.snapshot();
    assert.deepEqual(s.runLabels, {});
    assert.deepEqual(s.droppedLabelValues, { tenant: 0 });
    // 配额也清了：reset 后第一个值重新认下自己
    sink.export(traceOf({ durationMs: 5, labels: { tenant: 'newco' } }));
    assert.equal(sink.snapshot().runLabels['tenant=newco']!.runs, 1);
    assert.equal(sink.snapshot().droppedLabelValues.tenant, 0);
  });
});

describe('E3：上游没回报 usage 的 turn（S2）', () => {
  it('model_usage_missing_turns_total 与 unpriced 分开出；snapshot 同名可见；没这条时一行都不发', () => {
    const t = richTrace();
    // 在 llm.turn span 上加一条引擎会记的 usage.missing 事件（`engine/turn.ts` 的出口）
    t.spans[1]!.events.push({ time: 1, name: 'usage.missing', body: { model: 'claude-opus-5' } });

    const m = metricsSink();
    m.export(t);
    const txt = m.render();
    assert.match(txt, /^agentia_model_usage_missing_turns_total\{model="claude-opus-5"\} 1$/m);
    assert.equal(m.snapshot().models['claude-opus-5']!.usageMissingTurns, 1);
    assert.equal(
      m.snapshot().models['claude-opus-5']!.unpricedTurns,
      0,
      '两条信号分开数：这个 turn 的模型有定价',
    );

    // 反向：没有 usage.missing 事件的 trace（richTrace 原样）一行都不发 ——
    // 与 dropped_keys 那种「恒定发三行」不同，这条是**有才发**
    const clean = metricsSink();
    clean.export(richTrace());
    assert.doesNotMatch(clean.render(), /usage_missing_turns_total/);
  });
});
