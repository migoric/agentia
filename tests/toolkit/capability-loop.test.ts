import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder, runCapabilityLoop } from '../../src/index.js';
import type { AgentTool, ContextPolicy, JsonSchema, ToolRunContext } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * `runCapabilityLoop` = 「代码定顺序、但活不过这次请求」那一格的公共原语。
 *
 * 钉三件事，都是使用方真正依赖的语义（不是实现细节）：
 * ① **同树**：子循环挂在调用点的 capability span 下，**不**自开 run 根（traceId 不变）；
 * ② **结构化结果**：`resultSchema` 的校验结果从 `typed` 出来，不混进文本；
 * ③ **contextPolicy 真的进子循环** —— 这正是它与 `@SubAgent` / `@Skill` 的差别所在
 *    （那两行的子循环不吃应用级裁剪策略，见 usage-guide §7）。
 */
const RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

const echoTool: AgentTool = {
  name: 'lookup',
  description: '查一条记录',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  run: () => ({ ok: true }),
};

function makeCtx(client: ToolRunContext['client']): {
  ctx: ToolRunContext;
  recorder: TraceRecorder;
  rootId: string;
} {
  const recorder = new TraceRecorder();
  const rootId = recorder.begin('run', 'test.run', null);
  return { ctx: { client, recorder, parentSpanId: rootId }, recorder, rootId };
}

describe('runCapabilityLoop：代码控制顺序的子循环', () => {
  it('子循环挂在调用点的 capability span 下，且不自开 run 根', async () => {
    const { client } = mockClient([endTurnMsg('子循环的报告')]);
    const { ctx, recorder, rootId } = makeCtx(client);

    const out = await runCapabilityLoop(ctx, { name: 'ledger', input: '核对这三条账目' });
    recorder.end(rootId, { status: 'ok' });
    const trace = recorder.snapshot('ok');

    assert.equal(out.text, '子循环的报告');
    assert.equal(out.stopReason, 'end_turn');
    assert.equal(out.spanId, trace.spans.find((s) => s.name === 'ledger')?.spanId);

    // 同一条树：只有一个 run 根，capability 挂在调用方给的父 span 下
    assert.equal(trace.spans.filter((s) => s.kind === 'run').length, 1);
    const cap = trace.spans.find((s) => s.name === 'ledger');
    assert.ok(cap, 'capability span 必须在树里');
    assert.equal(cap.kind, 'capability');
    assert.equal(cap.parentSpanId, rootId);
    // 子循环自己的 llm.turn 是 capability 的子孙（不是和它平级）
    const turn = trace.spans.find((s) => s.kind === 'llm.turn');
    assert.ok(turn, '子循环必须有 llm.turn');
    assert.equal(turn.parentSpanId, cap.spanId);
    assert.equal(cap.status, 'ok');
  });

  it('resultSchema 的结构化结果从 typed 出来（文本仍是模型最终回复）', async () => {
    const { client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: '42', confidence: 0.9 }, 'tu1'),
        content: [
          { type: 'text', text: '查到 42' },
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'submit_result',
            input: { answer: '42', confidence: 0.9 },
          },
        ],
      },
    ]);
    const { ctx } = makeCtx(client);

    const out = await runCapabilityLoop(ctx, {
      name: 'lookup-loop',
      input: '查一下答案',
      tools: [echoTool],
      resultSchema: RESULT_SCHEMA,
    });

    assert.deepEqual(out.typed, { answer: '42', confidence: 0.9 });
    assert.equal(out.stopReason, 'end_turn');
  });

  it('contextPolicy 进子循环（@SubAgent / @Skill 做不到的那半）', async () => {
    const { client } = mockClient([endTurnMsg('裁剪过的一轮')]);
    const { ctx } = makeCtx(client);
    const seen: number[] = [];
    const policy: ContextPolicy = {
      beforeTurn: async (messages, info) => {
        seen.push(info.iteration);
        return messages;
      },
    };

    await runCapabilityLoop(ctx, { name: 'trimmed', input: '长跑', contextPolicy: policy });
    assert.deepEqual(seen, [0], 'contextPolicy.beforeTurn 必须在子循环的回合里被调用');
  });

  it('预算护栏经 ctx 透传进子循环（漏转发 ⇒ 护栏在子循环期间离线）', async () => {
    const { client } = mockClient([toolUseMsg('lookup', { id: 'a' }), endTurnMsg('不该跑到这里')]);
    const { ctx } = makeCtx(client);

    const out = await runCapabilityLoop(
      { ...ctx, maxTotalTokens: 12 },
      { name: 'budgeted', input: '跑两回合', tools: [echoTool] },
    );
    assert.equal(out.stopReason, 'budget_exceeded', '子循环必须在第二回合入口被预算闸拦住');
  });

  it('工具清单只含本次传入的（不会继承主菜单）', async () => {
    const { seen, client } = mockClient([endTurnMsg('ok'), endTurnMsg('ok')]);
    const { ctx } = makeCtx(client);

    await runCapabilityLoop(ctx, { name: 'no-tools', input: '纯文本' });
    const params = seen[0] as { tools?: Array<{ name: string }> };
    assert.deepEqual(params.tools ?? [], [], '没传 tools 时子循环必须空菜单');

    await runCapabilityLoop(ctx, { name: 'with-tool', input: '带一个', tools: [echoTool] });
    const withTool = seen[1] as { tools?: Array<{ name: string }> };
    assert.deepEqual(
      (withTool.tools ?? []).map((t) => t.name),
      ['lookup'],
    );
  });
});
