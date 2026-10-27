import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, TraceRecorder } from '../../src/index.js';
import type { AgentTool, JsonSchema } from '../../src/index.js';
import { runAgentScoped } from '../../src/engine/loop.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

function echoTool(): AgentTool {
  return {
    name: 'echo',
    description: '回显',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (input) => (input as { text: string }).text,
  };
}

describe('typed 结构化结果（hidden submit_result）', () => {
  it('业务工具 → submit_result 合法 input：typed 落定、end_turn、trace 正常', async () => {
    const { seen, client } = mockClient([
      toolUseMsg('echo', { text: 'hi' }),
      {
        ...toolUseMsg('submit_result', { answer: '42', confidence: 0.9 }, 'tu2'),
        content: [
          { type: 'text', text: '已得出答案' },
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'submit_result',
            input: { answer: '42', confidence: 0.9 },
          },
        ],
      },
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [echoTool()],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.typed, { answer: '42', confidence: 0.9 });
    assert.equal(result.finalText, '已得出答案'); // 提交回合文本可空则取空串
    assert.equal(result.trace.status, 'ok');
    assert.equal(result.iterations, 2);

    // api tools 追加了隐藏 submit_result（input_schema = resultSchema）
    const tools = (seen[0] as { tools: Array<{ name: string; input_schema: unknown }> }).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['echo', 'submit_result'],
    );
    assert.equal(tools[1].input_schema, RESULT_SCHEMA);
    // system 末尾追加了指令（未给 system 时即指令本身）
    const system = (seen[0] as { system: string }).system;
    assert.ok(system.includes('submit_result'));
  });

  it('system 为缓存块数组时：指令以无 cache_control 的 text block 追加在末尾', async () => {
    const { seen, client } = mockClient([endTurnMsg('done')]);
    await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      system: [{ type: 'text', text: '稳定前缀', cache_control: { type: 'ephemeral' } }],
      resultSchema: RESULT_SCHEMA,
    });
    const system = (
      seen[0] as { system: Array<{ type: string; text: string; cache_control?: unknown }> }
    ).system;
    assert.equal(system.length, 2);
    assert.deepEqual(system[0], {
      type: 'text',
      text: '稳定前缀',
      cache_control: { type: 'ephemeral' },
    });
    assert.equal(system[1].type, 'text');
    assert.ok(system[1].text.includes('submit_result'));
    assert.equal(system[1].cache_control, undefined); // 不污染稳定前缀缓存
  });

  it('submit_result 非法 input：is_error 回模型、循环继续、下回合修正后成功', async () => {
    const { seen, client } = mockClient([
      toolUseMsg('submit_result', { answer: 42, confidence: 0.5 }, 'tu1'), // answer 应为 string
      toolUseMsg('submit_result', { answer: '42', confidence: 0.9 }, 'tu2'),
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [echoTool()],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.typed, { answer: '42', confidence: 0.9 });

    // 第一回合的 is_error tool_result 已回给模型（含路径，模型可自我修正）
    // （seen 里的 messages 是同一数组引用、随回合增长，按块找 is_error 的 tool_result）
    const msgs = (seen[1] as { messages: Array<{ role: string; content: unknown }> }).messages;
    const tr = msgs
      .flatMap(
        (m) =>
          (Array.isArray(m.content) ? m.content : []) as Array<{
            type?: string;
            is_error?: boolean;
            content: string;
          }>,
      )
      .find((b) => b.type === 'tool_result' && b.is_error)!;
    assert.ok(tr.content.includes('invalid input'), tr.content);
    assert.ok(tr.content.includes('$.answer'), tr.content);
  });

  it('submit_result 非法时同回合其他业务工具照常执行', async () => {
    let ran = 0;
    const tool: AgentTool = {
      name: 'count_up',
      description: '计数',
      inputSchema: { type: 'object', properties: {} },
      run: () => ++ran,
    };
    const { client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: 1 }, 'tu1'),
        content: [
          { type: 'tool_use', id: 'tu1', name: 'submit_result', input: { answer: 1 } },
          { type: 'tool_use', id: 'tu2', name: 'count_up', input: {} },
        ],
      },
      toolUseMsg('submit_result', { answer: 'ok', confidence: 1 }, 'tu3'),
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [tool],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(ran, 1); // 业务工具照跑
    assert.deepEqual(result.typed, { answer: 'ok', confidence: 1 });
  });

  it('模型始终未提交而正常 end_turn：以 result_missing 失败，不把契约缺口当成功', async () => {
    const { client } = mockClient([endTurnMsg('纯文本回答')]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [echoTool()],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(result.stopReason, 'result_missing');
    assert.equal(result.typed, undefined);
    assert.equal(result.finalText, '纯文本回答');
    assert.equal(result.trace.status, 'error');
    assert.deepEqual(result.error, {
      type: 'result_missing',
      message: '已声明 resultSchema，但模型自然收尾时仍未提交合法结构化结果',
      retryable: false,
    });
  });

  it('未给 resultSchema：typed 为 undefined，行为与现状一致', async () => {
    const { seen, client } = mockClient([toolUseMsg('echo', { text: 'x' }), endTurnMsg('done')]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [echoTool()],
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.typed, undefined);
    // 不追加隐藏工具，也不动 system
    const params = seen[0] as { tools: Array<{ name: string }>; system?: string };
    assert.deepEqual(
      params.tools.map((t) => t.name),
      ['echo'],
    );
    assert.equal(params.system, undefined);
  });

  it('开发者菜单已有 submit_result 同名工具：装配冲突报错', async () => {
    const { client } = mockClient([]);
    const conflict: AgentTool = {
      name: 'submit_result',
      description: '开发者自己的同名工具',
      inputSchema: { type: 'object', properties: {} },
      run: () => 'x',
    };
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [conflict],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(result.stopReason, 'error');
    // @types/node 26 把 assert.ok 的 string message 拆成了独立重载（支持 printf 风格参数），
    // 于是 `string | undefined` 落进「两个重载都不匹配」的缝里 —— 先归一为 string。
    const conflictMsg = result.error?.message ?? '';
    assert.ok(conflictMsg.includes('submit_result'), conflictMsg);
    assert.equal(result.trace.status, 'error');
  });

  it('畸形 resultSchema（required 非数组）：单次提交回 is_error，最终未提交按 result_missing 失败', async () => {
    // required: 5 会让校验器抛 TypeError（5 不可迭代）——校验本身在 try 内，
    // 只废掉这次提交并回 is_error；模型之后仍不提交合法结果时，run 不能把契约缺口记成成功。
    const brokenSchema = { type: 'object', properties: {}, required: 5 } as unknown as JsonSchema;
    const { client } = mockClient([
      toolUseMsg('submit_result', { a: 'x' }, 'tu1'),
      endTurnMsg('普通收尾'),
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [echoTool()],
      resultSchema: brokenSchema,
    });
    assert.equal(result.stopReason, 'result_missing');
    assert.equal(result.typed, undefined);
    assert.equal(result.trace.status, 'error');
    assert.equal(result.error?.type, 'result_missing');

    // 那次提交以 is_error 回给模型（含 classify 后的类型），而非掀翻整次 run
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false);
    assert.match((out.body as { content: string }).content, /^error\(/);
  });
});

describe('runAgentScoped（子 agent 嵌套入口）的 resultSchema 透传', () => {
  it('scoped 入口：submit_result 提交 → typed 直通 AgentLoopResult，llm.turn 挂在父 span 下', async () => {
    const { seen, client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: '42', confidence: 0.9 }, 'tu1'),
        content: [
          { type: 'text', text: '子 agent 报告' },
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'submit_result',
            input: { answer: '42', confidence: 0.9 },
          },
        ],
      },
    ]);
    const recorder = new TraceRecorder();
    const rootId = recorder.begin('run', 'test.run', null);
    const capabilityId = recorder.begin('capability', 'researcher', rootId); // 子 agent 的 capability span

    const loop = await runAgentScoped({
      client,
      messages: [{ role: 'user', content: 'task' }],
      tools: [echoTool()],
      resultSchema: RESULT_SCHEMA,
      recorder,
      parentSpanId: capabilityId,
    });

    assert.equal(loop.stopReason, 'end_turn');
    assert.deepEqual(loop.typed, { answer: '42', confidence: 0.9 });
    assert.equal(loop.finalText, '子 agent 报告');
    assert.equal(loop.iterations, 1);

    // 隐藏 submit_result 追加到了 api 工具菜单（input_schema = resultSchema）
    const tools = (seen[0] as { tools: Array<{ name: string; input_schema: unknown }> }).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['echo', 'submit_result'],
    );
    assert.equal(tools[1].input_schema, RESULT_SCHEMA);

    // llm.turn 记进了同一条 trace、挂在给定父 span 下（不开 run 根）
    const turns = recorder.snapshot('ok').spans.filter((s) => s.kind === 'llm.turn');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].parentSpanId, capabilityId);
  });

  it('scoped 入口未给 resultSchema：typed 为 undefined，行为不变', async () => {
    const { seen, client } = mockClient([endTurnMsg('纯文本报告')]);
    const recorder = new TraceRecorder();
    const capabilityId = recorder.begin('capability', 'researcher', null);

    const loop = await runAgentScoped({
      client,
      messages: [{ role: 'user', content: 'task' }],
      tools: [echoTool()],
      recorder,
      parentSpanId: capabilityId,
    });

    assert.equal(loop.stopReason, 'end_turn');
    assert.equal(loop.typed, undefined);
    assert.equal(loop.finalText, '纯文本报告');
    const params = seen[0] as { tools: Array<{ name: string }>; system?: string };
    assert.deepEqual(
      params.tools.map((t) => t.name),
      ['echo'],
    ); // 不追加隐藏工具
    assert.equal(params.system, undefined);
  });
});

describe('同回合并行多个 submit_result', () => {
  it('先到先得：typed 取首个（数组序）校验通过的提交，后续忽略', async () => {
    // 两个都合法的 submit_result 挤在同一回合：typed 必须由确定规则决定（首个生效），
    // 不能由并发完成顺序竞态决定 —— 否则同一输入可能产出不同结果。
    const { client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: 'first', confidence: 0.1 }, 'tu1'),
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'submit_result',
            input: { answer: 'first', confidence: 0.1 },
          },
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'submit_result',
            input: { answer: 'second', confidence: 0.9 },
          },
        ],
      },
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [echoTool()],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.typed, { answer: 'first', confidence: 0.1 }, '首个提交生效');
  });

  it('首个校验失败、第二个通过：第二个生效（“先到”指首个**校验通过**的）', async () => {
    const { client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: 42 }, 'tu1'),
        content: [
          // 缺 confidence → 校验失败（is_error 回模型）
          { type: 'tool_use', id: 'tu1', name: 'submit_result', input: { answer: 'x' } },
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'submit_result',
            input: { answer: 'ok', confidence: 0.9 },
          },
        ],
      },
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'q' }],
      tools: [echoTool()],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.typed, { answer: 'ok', confidence: 0.9 });
  });
});
