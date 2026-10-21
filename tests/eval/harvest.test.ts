import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Tool, createApp, scriptedClient, SystemPrompt } from '../../src/index.js';
import type { JsonSchema, Span, Trace } from '../../src/index.js';
import { harvestEvalCase } from '../../src/eval/harvest.js';

/**
 * harvest（R7：线上 trace 回流 eval 数据集）的框架侧测试。
 *
 * 两条主线：
 * ① 生成物内容：只含主循环回合、tool_use id/input 重建正确、占位文本与注释在；
 * ② 生成物**可解析且可真跑**：`new Function` eval 出用例对象后，拿它的
 *    scriptedClient 真跑一轮，骨架里的轨迹断言（expect）对新 trace 不抛。
 */

const OBJ: JsonSchema = { type: 'object', properties: {} };

function span(partial: Partial<Span> & Pick<Span, 'spanId' | 'kind'>): Span {
  return {
    traceId: 'run-online-1',
    parentSpanId: 's0',
    name: 'x',
    startedAt: 0,
    status: 'ok',
    attributes: {},
    events: [],
    ...partial,
  };
}

/** 两回合主循环（首回合两个 tool_use，其中一个缺 tool_use_id）+ 一条子 agent 嵌套回合 */
function makeTrace(): Trace {
  return {
    traceId: 'run-online-1',
    rootSpanId: 's0',
    status: 'ok',
    totalUsage: { inputTokens: 30, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      span({ spanId: 's0', kind: 'run', name: 'agent.run', parentSpanId: null }),
      span({
        spanId: 't1',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 10,
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
        events: [
          {
            time: 11,
            name: 'tool.input',
            body: { tool: 'search', tool_use_id: 'tu_a1', input: '{"q":"北京天气"}' },
          },
          // 老 trace 缺 tool_use_id → 骨架里要合成 id；input 非 JSON → 包 {_raw}
          { time: 12, name: 'tool.input', body: { tool: 'translate', input: 'not-json{' } },
        ],
      }),
      span({ spanId: 't2', kind: 'llm.turn', name: 'claude-opus-5', startedAt: 20 }),
      // 子 agent 的嵌套回合：挂在 capability span 下，不进主循环脚本
      span({ spanId: 'c1', kind: 'capability', name: 'subagent:researcher', startedAt: 15 }),
      span({
        spanId: 't3',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        parentSpanId: 'c1',
        startedAt: 16,
        events: [
          { time: 17, name: 'tool.input', body: { tool: 'internal_tool', tool_use_id: 'tu_z9' } },
        ],
      }),
    ],
  };
}

describe('harvestEvalCase（R7 回流）', () => {
  it('生成物只含主循环回合；tool_use id/input 重建正确；占位文本与提示注释在', () => {
    const code = harvestEvalCase({
      trace: makeTrace(),
      messages: [{ role: 'user', content: '帮我查下北京天气' }],
      source: 'online.jsonl',
    });

    // 只含主循环两步（t3 是子 agent 回合）
    assert.equal(code.match(/"id": "harvest_m_/g)?.length, 2);
    assert.ok(!code.includes('internal_tool'), '子 agent 的嵌合回合不进骨架');
    assert.ok(!code.includes('tu_z9'));
    assert.match(code, /1 个子 agent 嵌套回合已略去/);

    // tool_use 重建：有 id 的保留原 id、input 还原成对象；缺 id 的合成、非 JSON 包 _raw
    assert.ok(code.includes('"id": "tu_a1"'));
    assert.ok(code.includes('"id": "harvest_tu_1"'));
    assert.match(code, /"name": "search"/);
    assert.match(code, /"q": "北京天气"/);
    assert.match(code, /"_raw": "not-json\{"/);

    // 占位与提示
    assert.ok(code.includes('[harvest] assistant 文本未入 trace'));
    assert.match(code, /脚手架，不是成品/);
    assert.match(code, /EvalCase 没有 expect 字段/);

    // 元信息：缺省用例名 / 来源 / 用户输入 / 轨迹断言里的工具序列
    assert.match(
      code,
      /harvest 用例骨架：harvest-run-online-1（trace run-online-1，来源 online\.jsonl）/,
    );
    assert.ok(code.includes('name: "harvest-run-online-1",'));
    assert.ok(code.includes('input: "帮我查下北京天气",'));
    assert.ok(code.includes('assert.deepEqual(tools, ["search","translate"]);'));
  });

  it('trace 记了 output.text ⇒ 用真文本；纯 tool_use 回合不加占位', () => {
    const trace = makeTrace();
    const t1 = trace.spans.find((s) => s.spanId === 't1') as { attributes: object };
    t1.attributes = { 'output.text': '我先查一下北京的天气。' };
    const code = harvestEvalCase({ trace });

    assert.ok(code.includes('"text": "我先查一下北京的天气。"'), '真文本应进脚本（不是占位）');
    // t1 有文本、t2（无文本无工具）是终端回合 ⇒ 占位只应出现 1 次（t2 那条）
    assert.equal(
      (code.match(/assistant 文本未入 trace/g) ?? []).length,
      1,
      '纯 tool_use 回合补占位会变成「模型说过这句话」的假事实',
    );
    assert.match(code, /assistant 文本取自 trace 的 output\.text/);
    assert.match(code, /1 个回合没有文本/);
  });

  it('没开 traceContent ⇒ 头注如实说「没有 assistant 文本」并给开关名', () => {
    const code = harvestEvalCase({ trace: makeTrace() });
    assert.match(code, /trace 里没有 assistant 文本（该 run 未开 traceContent/);
    assert.ok(!code.includes('assistant 文本取自 trace 的 output.text'));
  });

  it('生成物可 eval，且按骨架真跑一轮：轨迹断言对新 trace 不抛', async () => {
    const code = harvestEvalCase({
      trace: makeTrace(),
      messages: [{ role: 'user', content: '帮我查下北京天气' }],
    });
    // 零依赖约束下的「生成物可解析」验证：直接 eval 出用例对象
    // （生成物是纯 JS 语法表达式，assert/scriptedClient 由调用处注入）
    const evalCase = new Function('scriptedClient', 'assert', `return (${code});`)(
      scriptedClient,
      assert,
    ) as {
      name: string;
      input: string;
      client: ReturnType<typeof scriptedClient>;
      expect: (r: unknown, ctx: { trace: Trace }) => void;
    };
    assert.equal(evalCase.input, '帮我查下北京天气');

    class Tools {
      @Tool({ name: 'search', description: '搜一下', schema: OBJ })
      search(): string {
        return '命中 3 条';
      }
      @Tool({ name: 'translate', description: '译一下', schema: OBJ })
      translate(): string {
        return '译好了';
      }
    }
    const app = createApp({
      name: 'harvest-replay',
      system: new SystemPrompt().add('role', 'r'),
      providers: [{ provide: 'tools', useClass: Tools }],
    });
    const { result } = await app.run([{ role: 'user', content: evalCase.input }], {
      client: evalCase.client,
    });
    assert.equal(result.stopReason, 'end_turn');
    // 骨架里的 expect 是对新 trace 的轨迹断言 —— 不抛即「重放轨迹与抄录一致」
    evalCase.expect(result, { trace: result.trace });
  });

  it('messages 缺失 → input 占位 + 注释提醒；name 显式给出时覆盖缺省', () => {
    const code = harvestEvalCase({ trace: makeTrace(), name: 'weather-case' });
    assert.match(code, /未提供原始输入（TaskRecord 的 spec\.messages）—— input 是占位/);
    assert.ok(code.includes(`input: '[harvest] 原始输入未知，请人工补写',`));
    assert.ok(code.includes('name: "weather-case",'));
  });

  it('input 取 messages 里最后一条非空 user 文本（多轮输入 / 块形态内容）', () => {
    const code = harvestEvalCase({
      trace: makeTrace(),
      messages: [
        { role: 'user', content: '第一句话' },
        { role: 'assistant', content: '嗯' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '最后一句' },
            { type: 'text', text: '分两行' },
          ],
        },
      ],
    });
    assert.ok(code.includes('input: "最后一句\\n分两行",'));
    assert.ok(!code.includes('第一句话'));
  });

  it('没有主循环回合 → 空脚本 + 注释提醒（仍可 eval）', () => {
    const trace: Trace = {
      traceId: 'empty-run',
      rootSpanId: 's0',
      status: 'ok',
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      spans: [span({ spanId: 's0', kind: 'run', name: 'agent.run', parentSpanId: null })],
    };
    const code = harvestEvalCase({ trace, messages: [{ role: 'user', content: 'go' }] });
    assert.match(code, /trace 里没有主循环 llm\.turn/);
    assert.ok(code.includes('client: scriptedClient([]),'));
    assert.ok(code.includes('assert.deepEqual(tools, []);'));
    const evalCase = new Function('scriptedClient', 'assert', `return (${code});`)(
      scriptedClient,
      assert,
    );
    assert.equal(evalCase.name, 'harvest-empty-run');
  });

  it('嵌入值含反引号与 ${ 时生成物语法不被击穿（走 JSON.stringify）', () => {
    const trace = makeTrace();
    trace.spans[1].events[0].body = {
      tool: 'search',
      tool_use_id: 'tu_a1',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 故意用 ${ 字面量验证生成物转义
      input: JSON.stringify({ q: '模板`串${x}' }),
    };
    const code = harvestEvalCase({
      trace,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上
      messages: [{ role: 'user', content: '含`反引号`与${dollar}' }],
    });
    const evalCase = new Function('scriptedClient', 'assert', `return (${code});`)(
      scriptedClient,
      assert,
    ) as { input: string };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上
    assert.equal(evalCase.input, '含`反引号`与${dollar}');
  });
});

describe('harvest 对畸形 tool.input 的处理', () => {
  it('缺 tool 字段的事件整条跳过，不伪造一个叫 unknown 的调用', () => {
    // 回填 'unknown' 会在生成的脚本里变成一个真的、且断言必然通过的工具调用 ——
    // 骨架自我自洽、永不报错，比缺一条更坏。
    const trace = makeTrace();
    const mainTurn = trace.spans.find((s) => s.spanId === 't1')!;
    mainTurn.events.push({ time: 13, name: 'tool.input', body: { tool_use_id: 'tu_orphan' } });
    const code = harvestEvalCase({ trace, name: 'missing-tool' });
    assert.ok(!code.includes('"unknown"'), '不得伪造 unknown 工具名');
    assert.ok(!code.includes('tu_orphan'), '缺 tool 的事件连 id 也不该进脚本');
  });

  it('name 含换行也不击穿生成物语法（注释行只放单行）', () => {
    const code = harvestEvalCase({ trace: makeTrace(), name: 'evil\n// }, injected: 1' });
    const lines = code.split('\n');
    // 关键词只出现在第一行（不净化时注入内容会自成一行 —— 按行首判，别只数含关键词的行）
    assert.equal(lines.filter((l) => l.includes('harvest 用例骨架')).length, 1);
    assert.ok(
      !lines.some((l) => l.trimStart().startsWith('// }, injected')),
      '注入内容不得自成一行',
    );
    assert.ok(lines[0]!.includes('evil'), '折叠后仍保留可读前缀');
    assert.doesNotThrow(() => new Function(`return (${code})`), '折叠后生成物仍可解析');
  });
});
