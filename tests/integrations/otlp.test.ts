import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createOtlpExporter } from '../../src/integrations/otlp.js';
// 投影**单一真源**在 core/trace.ts：断言用它而不是就地写 `replaceAll().slice(0,16)` ——
// 这样「导出的 span id 就是出站 traceparent 里那个 span id」是被钉住的，改成别的切法立刻红。
import { type Span, type Trace, wireSpanId, wireTraceId } from '../../src/core/trace.js';

function sampleTrace(): Trace {
  const traceId = randomUUID();
  const rootId = randomUUID();
  const childId = randomUUID();
  return {
    traceId,
    rootSpanId: rootId,
    status: 'error',
    totalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: rootId,
        traceId,
        parentSpanId: null,
        kind: 'run',
        name: 'run',
        startedAt: 1000,
        endedAt: 2000,
        status: 'ok',
        attributes: { 'agent.name': 'fake' },
        events: [],
      },
      {
        spanId: childId,
        traceId,
        parentSpanId: rootId,
        kind: 'capability',
        name: 'tool:search',
        startedAt: 1100,
        endedAt: 1500,
        status: 'error',
        error: { type: 'tool', message: 'boom', retryable: false },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attributes: { ok: true, score: 1.5 },
        events: [{ time: 1200, name: 'tool.input', body: { q: 'hi' } }],
      },
    ],
  };
}

interface Captured {
  url?: string | undefined;
  contentType?: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: OTLP/JSON 是外部协议信封，测试逐字段断言 —— 写全类型只是把 envelope 抄一遍，抄错反而更危险
  body: any;
}

async function startCollector(
  statusCode: number,
  responseBody = statusCode === 200 ? '{}' : 'collector exploded',
): Promise<{ server: Server; base: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured.push({
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
  return { server, base: `http://127.0.0.1:${port}`, captured };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

describe('createOtlpExporter', () => {
  it('POST /v1/traces：Trace → OTLP/JSON 结构正确', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const exporter = createOtlpExporter({
        endpoint: `${base}/`, // 尾部斜杠应被容忍
        serviceName: 'test-svc',
        headers: { 'x-api-key': 'secret' },
      });
      const trace = sampleTrace();
      await exporter.export(trace);

      assert.equal(captured.length, 1);
      const c = captured[0];
      assert.equal(c.url, '/v1/traces');
      assert.match(c.contentType ?? '', /application\/json/);

      const rs = c.body.resourceSpans[0];
      assert.deepEqual(rs.resource.attributes, [
        { key: 'service.name', value: { stringValue: 'test-svc' } },
      ]);

      const spans = rs.scopeSpans[0].spans;
      assert.equal(spans.length, 2);

      // 根 span：hex id（trace 32 位 / span 16 位 —— OTLP 契约的两种宽度）、无 parent、
      // 纳秒时间、OK 状态。内部 id 是 UUID（32 hex），span 侧必须截断。
      const root = spans[0];
      assert.equal(root.traceId, wireTraceId(trace.traceId));
      assert.equal(root.spanId, wireSpanId(trace.spans[0].spanId));
      assert.equal(root.parentSpanId, undefined);
      assert.equal(root.kind, 1);
      assert.equal(root.startTimeUnixNano, String(1000 * 1e6));
      assert.equal(root.endTimeUnixNano, String(2000 * 1e6));
      assert.deepEqual(root.status, { code: 1 });
      assert.deepEqual(root.attributes, [
        { key: 'agent.name', value: { stringValue: 'fake' } },
        { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
        { key: 'gen_ai.agent.name', value: { stringValue: 'run' } },
      ]);

      // 子 span：parent hex、ERROR 状态带 message、usage 展平、events 映射
      const child = spans[1];
      assert.equal(child.parentSpanId, wireSpanId(trace.spans[0].spanId));
      assert.equal(child.name, 'tool:search');
      assert.deepEqual(child.status, { code: 2, message: 'boom' });
      const attrByKey = Object.fromEntries(
        child.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
      );
      assert.deepEqual(attrByKey.ok, { boolValue: true });
      assert.deepEqual(attrByKey.score, { doubleValue: 1.5 });
      assert.deepEqual(attrByKey['usage.inputTokens'], { intValue: '10' });
      assert.deepEqual(attrByKey['usage.outputTokens'], { intValue: '5' });

      assert.equal(child.events.length, 1);
      assert.equal(child.events[0].timeUnixNano, String(1200 * 1e6));
      assert.equal(child.events[0].name, 'tool.input');
      assert.deepEqual(child.events[0].attributes, [{ key: 'q', value: { stringValue: 'hi' } }]);
    } finally {
      await close(server);
    }
  });

  it('serviceName 缺省为 agentia', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      await createOtlpExporter({ endpoint: base }).export(sampleTrace());
      assert.deepEqual(captured[0].body.resourceSpans[0].resource.attributes, [
        { key: 'service.name', value: { stringValue: 'agentia' } },
      ]);
    } finally {
      await close(server);
    }
  });

  it('非 2xx 抛错：含状态码与响应片段', async () => {
    const { server, base } = await startCollector(500);
    try {
      const exporter = createOtlpExporter({ endpoint: base });
      await assert.rejects(exporter.export(sampleTrace()), /HTTP 500.*collector exploded/);
    } finally {
      await close(server);
    }
  });

  it('collector 半开（accept 不回包）→ 按 timeoutMs 超时 reject，不永久挂起 run 收尾', async () => {
    // 接受连接却永不写响应 —— 裸 fetch 在这种 collector 上会永远挂起
    const server = createServer(() => {
      /* 故意不回包，模拟半开连接 */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const exporter = createOtlpExporter({
        endpoint: `http://127.0.0.1:${port}`,
        timeoutMs: 100,
      });
      // reject 后由上层 flushSinks 的 catch 吞掉（观测失败不击穿业务）
      await assert.rejects(exporter.export(sampleTrace()), (e: unknown) => {
        assert.equal((e as { name?: string }).name, 'TimeoutError');
        return true;
      });
    } finally {
      // 中止的 fetch 应已断开，但保险起见强制清掉残留连接，否则 close 会等它
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await close(server);
    }
  });

  it('纳秒时间戳走 BigInt：epoch 毫秒 ×1e6 超 2^53，double 直接乘会丢精度', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const exporter = createOtlpExporter({ endpoint: base });
      const trace = sampleTrace();
      const epochMs = 1_757_894_400_123; // 真实 epoch 毫秒量级；×1e6 ≈ 1.76e18 > 2^53
      trace.spans[0]!.startedAt = epochMs;
      trace.spans[0]!.endedAt = epochMs + 5;
      await exporter.export(trace);
      const root = captured[0].body.resourceSpans[0].scopeSpans[0].spans[0];
      assert.equal(root.startTimeUnixNano, String(BigInt(epochMs) * 1_000_000n));
      assert.equal(root.endTimeUnixNano, String(BigInt(epochMs + 5) * 1_000_000n));
    } finally {
      await close(server);
    }
  });

  it('GenAI semconv：三类 span 追加 gen_ai.* 键（既有 usage.* 保留），score 事件译为 gen_ai.evaluation.result', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const traceId = randomUUID();
      const rootId = randomUUID();
      const trace: Trace = {
        traceId,
        rootSpanId: rootId,
        status: 'ok',
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        spans: [
          {
            spanId: rootId,
            traceId,
            parentSpanId: null,
            kind: 'run',
            name: 'my-app',
            startedAt: 1000,
            endedAt: 2000,
            status: 'ok',
            attributes: { 'session.id': 'sess-1' },
            events: [
              {
                time: 1900,
                name: 'score',
                body: { name: 'faithfulness', value: 0.75, source: 'eval-x', comment: 'ok' },
              },
              { time: 1901, name: 'score', body: { name: 'pass', value: 1 } }, // 整型分、无 source/comment
              { time: 1902, name: 'compaction', body: { dropped: 3 } }, // 非 score 事件原名转发
            ],
          },
          {
            spanId: randomUUID(),
            traceId,
            parentSpanId: rootId,
            kind: 'llm.turn',
            name: 'claude-opus-5',
            startedAt: 1100,
            endedAt: 1500,
            status: 'ok',
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
            attributes: {},
            events: [],
          },
          {
            spanId: randomUUID(),
            traceId,
            parentSpanId: rootId,
            kind: 'capability',
            // ⚠️ 生产形状：capability span 的 name 是**裸能力名**，类型靠 attributes 区分
            //（toolkit/subagent.ts / skill.ts 就是这么写的）。写成 'skill:search' 会让
            // 「按名字前缀判类型」这种错实现看起来是对的 —— 这个夹具曾经如此。
            name: 'search',
            startedAt: 1500,
            endedAt: 1600,
            status: 'ok',
            attributes: { skill: 'search' },
            events: [],
          },
          {
            spanId: randomUUID(),
            traceId,
            parentSpanId: rootId,
            kind: 'capability',
            name: 'researcher', // 生产形状：裸名 + attributes.subagent
            startedAt: 1600,
            endedAt: 1800,
            status: 'ok',
            attributes: { subagent: 'researcher' },
            events: [],
          },
        ],
      };
      await createOtlpExporter({ endpoint: base }).export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;

      // OTLP 契约：trace id 16 字节（32 hex）、span id 8 字节（16 hex）。
      // 内部是 UUID（32 hex），span 侧必须截到 16 —— 发 32 位给真 collector 会被判
      // invalid span_id（拒收）或按前 16 位截断。
      assert.equal(spans[0].traceId.length, 32, 'trace id 是 32 hex');
      assert.equal(spans[0].spanId.length, 16, 'span id 必须是 16 hex');
      assert.equal(spans[1].parentSpanId.length, 16, '父 span id 同宽');
      const attrByKey = (span: { attributes: Array<{ key: string; value: unknown }> }) =>
        Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );

      // run 根 span：invoke_agent + agent.name + conversation.id（session.id 原样保留）
      const root = attrByKey(spans[0]);
      assert.deepEqual(root['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
      assert.deepEqual(root['gen_ai.agent.name'], { stringValue: 'my-app' });
      assert.deepEqual(root['gen_ai.conversation.id'], { stringValue: 'sess-1' });
      assert.deepEqual(root['session.id'], { stringValue: 'sess-1' });

      // llm.turn：chat + request.model + usage token（int），既有 usage.* 仍在
      const turn = attrByKey(spans[1]);
      assert.deepEqual(turn['gen_ai.operation.name'], { stringValue: 'chat' });
      assert.deepEqual(turn['gen_ai.request.model'], { stringValue: 'claude-opus-5' });
      assert.deepEqual(turn['gen_ai.usage.input_tokens'], { intValue: '10' });
      assert.deepEqual(turn['gen_ai.usage.output_tokens'], { intValue: '5' });
      assert.deepEqual(turn['usage.inputTokens'], { intValue: '10' });
      assert.deepEqual(turn['usage.outputTokens'], { intValue: '5' });

      // capability：skill → execute_tool + tool.name；subagent → invoke_agent + agent.name
      const skill = attrByKey(spans[2]);
      assert.deepEqual(skill['gen_ai.operation.name'], { stringValue: 'execute_tool' });
      assert.deepEqual(skill['gen_ai.tool.name'], { stringValue: 'search' });
      const sub = attrByKey(spans[3]);
      assert.deepEqual(sub['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
      assert.deepEqual(sub['gen_ai.agent.name'], { stringValue: 'researcher' });

      // score 事件 → gen_ai.evaluation.result；非 score 事件名不变
      const events = spans[0].events;
      assert.equal(events[0].name, 'gen_ai.evaluation.result');
      const scoreAttrs = Object.fromEntries(
        events[0].attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
      );
      // semconv 无 gen_ai.evaluation.score.name；维度名是 gen_ai.evaluation.name
      assert.deepEqual(scoreAttrs['gen_ai.evaluation.name'], {
        stringValue: 'faithfulness',
      });
      assert.deepEqual(scoreAttrs['gen_ai.evaluation.score.value'], { doubleValue: 0.75 });
      assert.deepEqual(scoreAttrs['agentia.score.source'], { stringValue: 'eval-x' });
      assert.deepEqual(scoreAttrs['agentia.score.comment'], { stringValue: 'ok' });

      // 整型分也发 doubleValue；无 source/comment 时这两个键不出现
      assert.equal(events[1].name, 'gen_ai.evaluation.result');
      const bare = Object.fromEntries(
        events[1].attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
      );
      assert.deepEqual(bare['gen_ai.evaluation.score.value'], { doubleValue: 1 });
      assert.equal('agentia.score.source' in bare, false);
      assert.equal('agentia.score.comment' in bare, false);

      assert.equal(events[2].name, 'compaction');
    } finally {
      await close(server);
    }
  });
  it('span links：上游链路映射成 OTLP links（宽度规则同 parentSpanId），无 link 不发键', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const exporter = createOtlpExporter({ endpoint: base });
      const trace = sampleTrace();
      const upTrace = randomUUID();
      const upSpan = randomUUID();
      // ① 完整 link（trace + span）② 只有 trace 粒度（无 spanId 键）
      trace.spans[0].links = [{ traceId: upTrace, spanId: upSpan }, { traceId: upTrace }];
      await exporter.export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      assert.deepEqual(spans[0].links, [
        {
          traceId: wireTraceId(upTrace),
          spanId: wireSpanId(upSpan),
        },
        { traceId: wireTraceId(upTrace) },
      ]);
      // 空数组会让部分后端把 span 标成「有链路」—— 没 link 的 span 不发这个键
      assert.equal('links' in spans[1], false);
    } finally {
      await close(server);
    }
  });

  it('事件 body 里的显式 undefined 不产出非法 AnyValue（与 span 属性口径一致：跳过）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const trace = sampleTrace();
      trace.spans[1]!.events.push({
        time: 1300,
        name: 'tool.partial',
        body: { a: undefined, b: 1 },
      });
      await createOtlpExporter({ endpoint: base }).export(trace);

      const ev = captured[0].body.resourceSpans[0].scopeSpans[0].spans[1].events[1];
      assert.equal(ev.name, 'tool.partial');
      // undefined 值被跳过；正常的 b 仍在
      assert.deepEqual(ev.attributes, [{ key: 'b', value: { intValue: '1' } }]);
      // {stringValue: JSON.stringify(undefined)} 会序列化成 {"key":"a","value":{}} —— 非法 AnyValue
      const raw = JSON.stringify(captured[0].body);
      assert.ok(!raw.includes('"key":"a"'), 'undefined 值不得序列化成空 AnyValue');
    } finally {
      await close(server);
    }
  });

  /**
   * OTLP/JSON 的 **enum 必须整数编码**（规范原文：enum 字段用整数值编码，禁止 enum 名）。
   * 这条守的是一个真实缺陷 + 一个假绿机制：status 曾发 `'STATUS_CODE_OK'` 字符串，而本地
   * 假 collector 只做 `JSON.parse` —— 断言跟着写成字符串，于是 CI 一直绿，严格 collector
   * 却会判非法并整批拒收。所以这里**扫整个 payload 的 enum 名**，而不是只比一个字段。
   */
  it('enum 一律整数编码：payload 里不得出现任何 OTLP enum 名（整批拒收那个坑）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      await createOtlpExporter({ endpoint: base }).export(sampleTrace());

      const raw = JSON.stringify(captured[0].body);
      const enumNames =
        raw.match(/"(?:STATUS_CODE|SPAN_KIND|SEVERITY_NUMBER|AGGREGATION_TEMPORALITY)_[A-Z_]+"/g) ??
        [];
      assert.deepEqual(
        enumNames,
        [],
        `OTLP/JSON 的 enum 必须整数编码，不得出现 enum 名：${enumNames.join(', ')}`,
      );
      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      assert.equal(typeof spans[0].kind, 'number', 'kind 必须是整数');
      assert.equal(typeof spans[0].status.code, 'number', 'status.code 必须是整数');
      assert.equal(spans[0].status.code, 1, '1 = STATUS_CODE_OK');
      assert.equal(spans[1].status.code, 2, '2 = STATUS_CODE_ERROR');
    } finally {
      await close(server);
    }
  });

  /*
   * HTTP 200 **不等于「全部接收」**：规范允许 collector 用 200 + `partialSuccess` 说
   * 「收了一部分」（例如某条 span 属性过大被丢）。原先只查 `res.ok` ⇒ 静默当成完全成功：
   * 看板少数据，而框架说一切正常。
   * 两条判据缺一不可 —— ① 200 + 真拒收 ⇒ 报错；② 200 + `partialSuccess` 在场但零拒收
   * ⇒ **是「全部接收」的另一种写法**（有 collector 恒发这个键），不得当失败。
   */
  it('HTTP 200 + partialSuccess 真拒收 → 按部分接收报错（status 仍带 200）', async () => {
    const { server, base } = await startCollector(
      200,
      JSON.stringify({ partialSuccess: { rejectedSpans: 3, errorMessage: 'attribute too large' } }),
    );
    try {
      await assert.rejects(
        () => createOtlpExporter({ endpoint: base }).export(sampleTrace()),
        (e: unknown) => {
          assert.match((e as Error).message, /部分接收/);
          assert.match((e as Error).message, /rejected_spans=3/);
          assert.match((e as Error).message, /attribute too large/);
          assert.equal(
            (e as { status?: number }).status,
            200,
            'status 带 200：宿主据此区分「collector 拒收了一部分」与「连不上」',
          );
          return true;
        },
      );

      // 给了 onExportError：交回调、不抛（宿主自己决定告警/计数后继续）——
      // 这是 TraceSink 失败缺省被吞掉时**唯一**能收到这条消息的路（见 usage-guide §7）
      const seen: unknown[] = [];
      await createOtlpExporter({
        endpoint: base,
        onExportError: (err) => seen.push(err),
      }).export(sampleTrace());
      assert.equal(seen.length, 1, '给了回调就该收到，而不是抛出去');
      assert.match(String((seen[0] as Error).message), /部分接收/);
    } finally {
      await close(server);
    }
  });

  it('partialSuccess 在场但零拒收 → 是「全部接收」，不得报错（在场 ≠ 拒收）', async () => {
    // int64 走字符串编码 + 空 errorMessage：两种「没有拒收」的写法一次覆盖
    const { server, base } = await startCollector(
      200,
      JSON.stringify({ partialSuccess: { rejectedSpans: '0', errorMessage: '' } }),
    );
    try {
      await createOtlpExporter({ endpoint: base }).export(sampleTrace());
    } finally {
      await close(server);
    }
  });
});

/** 造一条「run 根 + 若干 llm.turn」的 trace（G3/G2 用例共用的骨架） */
function traceWithTurns(turns: Array<Partial<Span> & { spanId: string }>): {
  trace: Trace;
  rootId: string;
} {
  const traceId = randomUUID();
  const rootId = randomUUID();
  const trace: Trace = {
    traceId,
    rootSpanId: rootId,
    status: 'ok',
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: rootId,
        traceId,
        parentSpanId: null,
        kind: 'run',
        name: 'my-app',
        startedAt: 1000,
        endedAt: 2000,
        status: 'ok',
        attributes: {},
        events: [],
      },
      ...turns.map(
        (t): Span => ({
          traceId,
          parentSpanId: rootId,
          kind: 'llm.turn',
          name: 'claude-opus-5',
          startedAt: 1100,
          endedAt: 1500,
          status: 'ok',
          attributes: {},
          events: [],
          ...t,
        }),
      ),
    ],
  };
  return { trace, rootId };
}

/** OTLP span 的 attributes 数组 → 按 key 取值的map（与上方用例同款读法） */
// biome-ignore lint/suspicious/noExplicitAny: OTLP/JSON 是外部协议信封，测试逐字段断言
function attrByKey(span: any): Record<string, any> {
  return Object.fromEntries(
    span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
  );
}

describe('G3：三个「已有信号、没以 semconv 键名发出去」的 Recommended 键', () => {
  it('缓存 token 双发 gen_ai.usage.cache_read/cache_write.input_tokens（>0 才发，0 不留键）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const { trace } = traceWithTurns([
        {
          spanId: randomUUID(),
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 50, cacheCreationTokens: 25 },
        },
        // 反向：没走缓存的回合（两个缓存读数都是 0）⇒ 一个 gen_ai 缓存键都不发
        {
          spanId: randomUUID(),
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        },
      ]);
      await createOtlpExporter({ endpoint: base }).export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      const hit = attrByKey(spans[1]);
      assert.deepEqual(hit['gen_ai.usage.cache_read.input_tokens'], { intValue: '50' });
      assert.deepEqual(hit['gen_ai.usage.cache_write.input_tokens'], { intValue: '25' });
      // 双发不是替换：自有键原样保留
      assert.deepEqual(hit['usage.cacheReadTokens'], { intValue: '50' });
      assert.deepEqual(hit['usage.cacheCreationTokens'], { intValue: '25' });

      const miss = attrByKey(spans[2]);
      assert.equal('gen_ai.usage.cache_read.input_tokens' in miss, false);
      assert.equal('gen_ai.usage.cache_write.input_tokens' in miss, false);
      // 0 读数的自有键照旧发（既有行为不变）
      assert.deepEqual(miss['usage.cacheReadTokens'], { intValue: '0' });
    } finally {
      await close(server);
    }
  });

  it('父 span 上有早于本回合的 context.budget ⇒ llm.turn 发 gen_ai.conversation.compacted: true（否则不设，连 false 都不发）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const { trace, rootId } = traceWithTurns([
        { spanId: randomUUID(), startedAt: 1100 }, // 压缩**之前**的回合 ⇒ 不发
        { spanId: randomUUID(), startedAt: 1300 }, // 压缩之后的回合 ⇒ true
        { spanId: randomUUID(), startedAt: 1400 }, // 再之后的回合 ⇒ 仍是压缩视图 ⇒ true
      ]);
      // 记账点的真实位置：context.budget 记在回合的**父** span 上（engine/turn.ts ——
      // 压缩发生时本回合的 llm.turn 还不存在）
      trace.spans[0]!.events.push({
        time: 1200,
        name: 'context.budget',
        body: { from: 40, to: 12, model: 'claude-opus-5' },
      });
      assert.equal(trace.spans[0]!.spanId, rootId);
      await createOtlpExporter({ endpoint: base }).export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      // run 根自己不带这个键（它是 inference span 的属性）
      assert.equal('gen_ai.conversation.compacted' in attrByKey(spans[0]), false);
      assert.equal('gen_ai.conversation.compacted' in attrByKey(spans[1]), false);
      assert.deepEqual(attrByKey(spans[2])['gen_ai.conversation.compacted'], { boolValue: true });
      assert.deepEqual(attrByKey(spans[3])['gen_ai.conversation.compacted'], { boolValue: true });
    } finally {
      await close(server);
    }
  });

  it('没有 context.budget 事件 ⇒ 任何 span 都不发 gen_ai.conversation.compacted', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const { trace } = traceWithTurns([{ spanId: randomUUID() }]);
      await createOtlpExporter({ endpoint: base }).export(trace);
      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      for (const s of spans) {
        assert.equal('gen_ai.conversation.compacted' in attrByKey(s), false);
      }
    } finally {
      await close(server);
    }
  });
});

describe('G2：projectToolSpans 把 tool.input/tool.output 事件投影成 execute_tool child span', () => {
  const input = (id: string, tool: string, time: number) => ({
    time,
    name: 'tool.input',
    body: { tool, tool_use_id: id, input: '{}' },
  });
  const output = (id: string, tool: string, time: number, ok: boolean, errorKind?: string) => ({
    time,
    name: 'tool.output',
    body: { tool, tool_use_id: id, ok, durationMs: 90, ...(errorKind ? { errorKind } : {}) },
  });

  it('默认关：不投影（span 数不变、无 execute_tool span），与显式 false 逐字节一致', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const turnId = randomUUID();
      const { trace } = traceWithTurns([
        {
          spanId: turnId,
          events: [input('tu1', 'search', 1110), output('tu1', 'search', 1200, true)],
        },
      ]);
      await createOtlpExporter({ endpoint: base }).export(trace);
      await createOtlpExporter({ endpoint: base, projectToolSpans: false }).export(trace);

      assert.equal(captured.length, 2);
      assert.deepEqual(captured[1].body, captured[0].body, '缺省与显式 false 必须一致');
      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      assert.equal(spans.length, 2, 'span 数不变：run 根 + llm.turn');
      assert.ok(
        !spans.some((s: { name: string }) => s.name.startsWith('execute_tool')),
        '默认关 ⇒ 没有 execute_tool span',
      );
    } finally {
      await close(server);
    }
  });

  it('开启：配对成功/失败各投影一条（父子关系、起止时刻、属性、status 口径）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const turnId = randomUUID();
      const { trace } = traceWithTurns([
        {
          spanId: turnId,
          events: [
            input('tu-ok', 'search', 1110),
            input('tu-bad', 'search', 1210),
            output('tu-ok', 'search', 1200, true),
            output('tu-bad', 'search', 1300, false, 'timeout'),
          ],
        },
      ]);
      await createOtlpExporter({ endpoint: base, projectToolSpans: true }).export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      assert.equal(spans.length, 4, 'run 根 + llm.turn + 2 条投影 span');
      const projected = spans.slice(2);
      // biome-ignore lint/suspicious/noExplicitAny: 同上，线缆形状逐字段断言
      const byEnd = (s: any) => s.startTimeUnixNano;
      projected.sort((a: unknown, b: unknown) => byEnd(a).localeCompare(byEnd(b)));

      const okSpan = projected[0];
      assert.equal(okSpan.name, 'execute_tool search');
      assert.equal(okSpan.traceId, wireTraceId(trace.traceId));
      assert.equal(okSpan.parentSpanId, wireSpanId(turnId), '父是发起它的 llm.turn');
      assert.match(okSpan.spanId, /^[0-9a-f]{16}$/, '投影 id 与既有 span id 同宽');
      assert.equal(okSpan.startTimeUnixNano, String(1110 * 1e6), 'start = tool.input 时刻');
      assert.equal(okSpan.endTimeUnixNano, String(1200 * 1e6), 'end = tool.output 时刻');
      assert.deepEqual(okSpan.status, { code: 1 });
      const okAttrs = attrByKey(okSpan);
      assert.deepEqual(okAttrs['gen_ai.operation.name'], { stringValue: 'execute_tool' });
      assert.deepEqual(okAttrs['gen_ai.tool.name'], { stringValue: 'search' });
      assert.equal('agentia.projection.orphan' in okAttrs, false);
      assert.equal('error.type' in okAttrs, false);

      const badSpan = projected[1];
      assert.equal(badSpan.startTimeUnixNano, String(1210 * 1e6));
      assert.equal(badSpan.endTimeUnixNano, String(1300 * 1e6));
      assert.deepEqual(badSpan.status, { code: 2, message: 'timeout' });
      assert.deepEqual(attrByKey(badSpan)['error.type'], { stringValue: 'timeout' });

      // 投影是「多出来的 span」：原事件原样留在父 span 上（事件消费方不受影响）
      assert.equal(spans[1].events.length, 4);
    } finally {
      await close(server);
    }
  });

  it('同名工具并行不配错：配对键是 tool_use_id 不是名字', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const { trace } = traceWithTurns([
        {
          spanId: randomUUID(),
          events: [
            input('tu-a', 'search', 100),
            input('tu-b', 'search', 110), // 同名并行，时间交叠
            output('tu-a', 'search', 150, true),
            output('tu-b', 'search', 165, true),
          ],
        },
      ]);
      await createOtlpExporter({ endpoint: base, projectToolSpans: true }).export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      // biome-ignore lint/suspicious/noExplicitAny: 同上
      const projected = spans.filter((s: any) => s.name === 'execute_tool search');
      assert.equal(projected.length, 2);
      assert.notEqual(projected[0].spanId, projected[1].spanId, '两次调用各是各的 span');
      const windows = projected
        // biome-ignore lint/suspicious/noExplicitAny: 同上
        .map((s: any) => [s.startTimeUnixNano, s.endTimeUnixNano])
        .sort();
      assert.deepEqual(windows, [
        [String(100 * 1e6), String(150 * 1e6)],
        [String(110 * 1e6), String(165 * 1e6)],
      ]);
    } finally {
      await close(server);
    }
  });

  it('孤儿 input ⇒ 有 span 但不写 endTimeUnixNano / status，带 agentia.projection.orphan: true（孤儿 output 跳过）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const { trace } = traceWithTurns([
        {
          spanId: randomUUID(),
          events: [
            input('tu-orphan', 'search', 1110),
            // traceLimits.maxEvents 是「超限停记」⇒ 丢的是后记的那条，孤儿 output 在记账侧
            // 不可达；防御口径：没有诚实的 start 就不投影（事件本体仍在父 span 上）
            output('tu-lonely', 'search', 1200, true),
          ],
        },
      ]);
      await createOtlpExporter({ endpoint: base, projectToolSpans: true }).export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      assert.equal(spans.length, 3, 'run 根 + llm.turn + 1 条孤儿投影（孤儿 output 不产 span）');
      const orphan = spans[2];
      assert.equal(orphan.name, 'execute_tool search');
      assert.equal(orphan.startTimeUnixNano, String(1110 * 1e6));
      assert.equal('endTimeUnixNano' in orphan, false, '不许编零时长');
      assert.equal('status' in orphan, false, '「没等到结束」不是 OK 也不是 Error');
      assert.deepEqual(attrByKey(orphan)['agentia.projection.orphan'], { boolValue: true });
    } finally {
      await close(server);
    }
  });
});
