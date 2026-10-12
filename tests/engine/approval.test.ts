import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, runAgent } from '../../src/index.js';
import type { AgentTool, JsonSchema, Span, TraceSink } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * HITL（人工审批）引擎侧：审批 = 异步 tool_result。
 * - 无决定 ⇒ 回合级挂起（全有或全无：整回合一个工具都不执行、不推任何 tool_result）；
 * - 恢复 = 带着 approvals 把挂起的消息历史喂回来（末尾 assistant 含 tool_use ⇒ 先解决它们）；
 * - 拒绝 ⇒ 该条 tool_result 记 is_error（理由回给模型）；批准 ⇒ 正常执行且
 *   工具体内经 ToolRunContext.approval 读到决定。
 */

const OBJ = { type: 'object', properties: {} } as const;
const RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

function approvalTool(spy: { calls: unknown[]; ctxs: unknown[] }): AgentTool {
  return {
    name: 'danger',
    description: '危险操作',
    inputSchema: OBJ,
    approval: 'required',
    run: (input, ctx) => {
      spy.calls.push(input);
      spy.ctxs.push(ctx);
      return '已执行';
    },
  };
}

function normalTool(spy: { calls: unknown[] }): AgentTool {
  return {
    name: 'safe',
    description: '安全操作',
    inputSchema: OBJ,
    run: (input) => {
      spy.calls.push(input);
      return 'safe-ok';
    },
  };
}

/** 同回合两个 tool_use 的 assistant 响应 */
function twoToolUseMsg(): Record<string, unknown> {
  return {
    id: 'm-multi',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      { type: 'tool_use', id: 'tu-danger', name: 'danger', input: {} },
      { type: 'tool_use', id: 'tu-safe', name: 'safe', input: {} },
    ],
  };
}

const eventsOf = (spans: Span[], name: string) =>
  spans.flatMap((s) => s.events.filter((e) => e.name === name));

describe('HITL 审批（引擎）', () => {
  it('无决定 ⇒ 挂起：工具零执行、suspendedMessages 以那条 assistant 结尾、trace 记 approval.requested', async () => {
    const spy = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const { client } = mockClient([toolUseMsg('danger', {}, 'tu1')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [approvalTool(spy)],
    });
    assert.equal(result.stopReason, 'suspended');
    assert.equal(run.status, 'suspended', 'Run 状态机：挂起不是成功也不是失败');
    assert.equal(run.finishedAt, undefined, '挂起不是终态：finishedAt 不置');
    assert.equal(result.error, undefined, '挂起不带 error（不是失败）');
    assert.equal(result.trace.status, 'ok', '挂起段执行无误，trace 不算失败');
    assert.equal(spy.calls.length, 0, '未决审批 ⇒ 工具一次都不能执行');
    // suspendedMessages：原 user + 那条含未决 tool_use 的 assistant（不推任何 tool_result）
    const sm = result.suspendedMessages!;
    assert.equal(sm.length, 2);
    assert.equal(sm[0].role, 'user');
    assert.equal(sm[1].role, 'assistant');
    const blocks = sm[1].content as Array<{ type: string; id?: string }>;
    assert.deepEqual(
      blocks.map((b) => b.type),
      ['tool_use'],
      '不推 tool_result —— 历史以 assistant 结尾',
    );
    assert.deepEqual(result.pendingApprovals, ['tu1']);
    // 审计账：approval.requested 记在发起回合的 turn span 上，带待决 id 列表
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const requested = turn.events.filter((e) => e.name === 'approval.requested');
    assert.equal(requested.length, 1);
    assert.deepEqual((requested[0].body as { tool_use_ids: string[] }).tool_use_ids, ['tu1']);
    // 挂起的回合不记 tool.input / tool.output（工具根本没执行）
    assert.equal(eventsOf(result.trace.spans, 'tool.input').length, 0);
    assert.equal(eventsOf(result.trace.spans, 'tool.output').length, 0);
  });

  it('G7 护栏属性：挂起时在发起回合的 span 上写 name/triggered；不需要审批的回合两个键都不出现', async () => {
    // 在场态：审批闸拦下 ⇒ 同一条 turn span 上除事件外还多了两个 additive 属性
    const spy = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const { client } = mockClient([toolUseMsg('danger', {}, 'tu1')]);
    const suspended = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [approvalTool(spy)],
    });
    const gTurn = suspended.result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    assert.equal(gTurn.attributes['agentia.guardrail.name'], 'danger');
    assert.equal(gTurn.attributes['agentia.guardrail.triggered'], true);
    // 属性是「入口」、事件是权威明细：待决 id 列表只在事件里
    assert.deepEqual(suspended.result.pendingApprovals, ['tu1']);
    // 「审批不建 span」这条既有口径继续钉住：整条 trace 只有 run + llm.turn
    assert.deepEqual([...new Set(suspended.result.trace.spans.map((s) => s.kind))].sort(), [
      'llm.turn',
      'run',
    ]);

    // 不在场态：同一批工具、模型没点名那个要审批的 ⇒ 两个键**一个都不发**（不设 false）
    const spy2 = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const ok = mockClient([toolUseMsg('safe', {}, 'tu2'), endTurnMsg('done')]);
    const ran = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client: ok.client,
      tools: [approvalTool(spy2), normalTool(spy2)],
    });
    assert.equal(ran.result.stopReason, 'end_turn');
    for (const s of ran.result.trace.spans) {
      assert.equal('agentia.guardrail.name' in s.attributes, false, `${s.kind} 不该带护栏名`);
      assert.equal(
        'agentia.guardrail.triggered' in s.attributes,
        false,
        `${s.kind} 不该带 triggered`,
      );
    }
  });

  it('挂起照常 flushSinks（挂起段的 trace 必须可观测）；但记忆/会话维持「只成功才写」', async () => {
    const spy = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const { client } = mockClient([toolUseMsg('danger', {}, 'tu1')]);
    const exported: string[] = [];
    const sink: TraceSink = {
      export: (trace) => {
        exported.push(trace.status);
      },
    };
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [approvalTool(spy)],
      sinks: [sink],
    });
    assert.deepEqual(exported, ['ok'], '挂起段的 trace 也要投递给 sink');
  });

  it('恢复（approved）：工具带着 ctx.approval 执行，approval.decided 带 waitedMs，不重复 push assistant', async () => {
    const spy = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const first = mockClient([toolUseMsg('danger', {}, 'tu1')]);
    const r1 = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client: first.client,
      tools: [approvalTool(spy)],
    });
    assert.equal(r1.stopReason, 'suspended');

    // 恢复：挂起的消息历史 + 决定喂回来；模型在工具结果之后收尾。
    // ⚠️ mock 存的是 params 引用（messages 数组会被引擎继续原地 push），
    // 必须在 onParams 回调里当场快照 —— 事后读看到的是收尾后的完整历史。
    let sentRoles: string[] = [];
    let sentResults: Array<{ type: string; tool_use_id: string; is_error?: boolean }> = [];
    const second = mockClient([
      {
        onParams: (p) => {
          const m = (p as { messages: Array<{ role: string; content: unknown }> }).messages;
          sentRoles = m.map((x) => x.role);
          sentResults = m[2].content as typeof sentResults;
        },
        message: endTurnMsg('做完了'),
      },
    ]);
    const r2 = await runAgent({
      messages: r1.suspendedMessages!,
      client: second.client,
      tools: [approvalTool(spy)],
      approvals: {
        tu1: { approved: true, decidedBy: 'alice', decidedAt: 2000, requestedAt: 1000 },
      },
    });
    assert.equal(r2.stopReason, 'end_turn');
    assert.equal(r2.finalText, '做完了');
    assert.equal(spy.calls.length, 1, '批准后工具执行且只执行一次');
    const ctx = spy.ctxs[0] as { approval?: { approved: boolean; decidedBy?: string } };
    assert.equal(ctx.approval?.approved, true, '工具体内读得到自己的审批决定');
    assert.equal(ctx.approval?.decidedBy, 'alice');

    // 发给模型的第一个请求：历史末尾是 [assistant(tool_use), user(tool_result)] ——
    // 恢复没有重复 push 那条 assistant 消息（它已在历史里）
    assert.deepEqual(sentRoles, ['user', 'assistant', 'user']);
    assert.deepEqual(
      sentResults.map((r) => [r.type, r.tool_use_id, r.is_error ?? false]),
      [['tool_result', 'tu1', false]],
    );

    // 审计账：approval.decided 带 waitedMs（= decidedAt - requestedAt）
    const decided = eventsOf(r2.trace.spans, 'approval.decided');
    assert.equal(decided.length, 1);
    const body = decided[0].body as Record<string, unknown>;
    assert.equal(body.tool_use_id, 'tu1');
    assert.equal(body.approved, true);
    assert.equal(body.decidedBy, 'alice');
    assert.equal(body.waitedMs, 1000);
  });

  it('恢复（denied）：工具不执行，tool_result 记 is_error + 理由回给模型', async () => {
    const spy = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const first = mockClient([toolUseMsg('danger', {}, 'tu1')]);
    const r1 = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client: first.client,
      tools: [approvalTool(spy)],
    });

    let toolResultSeen: { is_error?: boolean; content: string } | undefined;
    const second = mockClient([
      {
        onParams: (p) => {
          const m = (p as { messages: Array<{ content: unknown }> }).messages;
          toolResultSeen = (m[2].content as Array<{ is_error?: boolean; content: string }>)[0];
        },
        message: endTurnMsg('那我换个做法'),
      },
    ]);
    const r2 = await runAgent({
      messages: r1.suspendedMessages!,
      client: second.client,
      tools: [approvalTool(spy)],
      approvals: { tu1: { approved: false, reason: '金额太大' } },
    });
    assert.equal(r2.stopReason, 'end_turn');
    assert.equal(spy.calls.length, 0, '被拒绝的工具不执行（副作用不发生）');
    assert.equal(toolResultSeen?.is_error, true);
    assert.equal(toolResultSeen?.content, '审批被拒绝：金额太大', '拒绝理由回给模型（可自行换路）');
    const out = eventsOf(r2.trace.spans, 'tool.output')[0].body as Record<string, unknown>;
    assert.equal(out.ok, false);
    assert.equal(out.errorKind, 'denied', '拒绝是人的决定，单列一类账');
  });

  it('混合回合全有或全无：同一回合的普通工具也不提前执行', async () => {
    const danger = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const safe = { calls: [] as unknown[] };
    const tools = [approvalTool(danger), normalTool(safe)];
    const first = mockClient([twoToolUseMsg()]);
    const r1 = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client: first.client,
      tools,
    });
    assert.equal(r1.stopReason, 'suspended');
    assert.equal(danger.calls.length, 0);
    assert.equal(
      safe.calls.length,
      0,
      '普通工具同样不提前执行（协议：tool_use 必须配对 tool_result）',
    );
    assert.deepEqual(r1.pendingApprovals, ['tu-danger'], '待决清单只含需审批的那个');

    const second = mockClient([endTurnMsg('done')]);
    const r2 = await runAgent({
      messages: r1.suspendedMessages!,
      client: second.client,
      tools,
      approvals: { 'tu-danger': { approved: true } },
    });
    assert.equal(r2.stopReason, 'end_turn');
    assert.equal(danger.calls.length, 1);
    assert.equal(safe.calls.length, 1, '决定齐了之后整回合（含普通工具）一起执行');
    // 恢复后发给模型的 user 消息带**两条** tool_result（协议配平）
    const sent = (second.seen[0] as { messages: Array<{ content: unknown }> }).messages;
    assert.equal((sent[2].content as unknown[]).length, 2);
  });

  it('恢复后再遇未决 ⇒ 二次挂起（可等多轮）', async () => {
    const spy = { calls: [] as unknown[], ctxs: [] as unknown[] };
    const tools = [approvalTool(spy)];
    const first = mockClient([toolUseMsg('danger', {}, 'tu1')]);
    const r1 = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client: first.client,
      tools,
    });
    // 恢复段：tu1 批了，但模型下一回合又要调一个（tu2）没批的
    const second = mockClient([toolUseMsg('danger', {}, 'tu2')]);
    const r2 = await runAgent({
      messages: r1.suspendedMessages!,
      client: second.client,
      tools,
      approvals: { tu1: { approved: true } },
    });
    assert.equal(r2.stopReason, 'suspended');
    assert.deepEqual(r2.pendingApprovals, ['tu2']);
    assert.equal(spy.calls.length, 1, 'tu1 执行了；tu2 没有');
    // 二次挂起的消息历史：…user(tool_result: tu1 的结果), assistant(tool_use: tu2)
    const sm = r2.suspendedMessages!;
    assert.equal(sm.length, 4);
    assert.equal(sm[3].role, 'assistant');
  });

  it('submit_result 永不需审批：纯提交回合不挂起；与未决审批同回合时一起等（全有或全无）', async () => {
    const spy = { calls: [] as unknown[], ctxs: [] as unknown[] };
    // 纯 submit_result 回合：不需要任何审批
    const only = mockClient([toolUseMsg('submit_result', { answer: '42' }, 'tu-sub')]);
    const r0 = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client: only.client,
      tools: [approvalTool(spy)],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(r0.stopReason, 'end_turn');
    assert.deepEqual(r0.typed, { answer: '42' });

    // submit_result + 未决审批同回合：整回合挂起，submit_result 也不提前生效
    const mixedMsg = {
      id: 'm-mix',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'tool_use', id: 'tu-sub', name: 'submit_result', input: { answer: '42' } },
        { type: 'tool_use', id: 'tu-danger', name: 'danger', input: {} },
      ],
    };
    const first = mockClient([mixedMsg]);
    const r1 = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client: first.client,
      tools: [approvalTool(spy)],
      resultSchema: RESULT_SCHEMA,
    });
    assert.equal(r1.stopReason, 'suspended');
    assert.equal(r1.typed, undefined, 'submit_result 也没提前生效');
    assert.deepEqual(r1.pendingApprovals, ['tu-danger']);

    const second = mockClient([]);
    const r2 = await runAgent({
      messages: r1.suspendedMessages!,
      client: second.client,
      tools: [approvalTool(spy)],
      resultSchema: RESULT_SCHEMA,
      approvals: { 'tu-danger': { approved: true } },
    });
    assert.equal(r2.stopReason, 'end_turn');
    assert.deepEqual(r2.typed, { answer: '42' }, '恢复后同一回合的 submit_result 生效');
    assert.equal(spy.calls.length, 1);
  });

  it('通用恢复入口：直接喂「assistant 结尾带 tool_use」的消息（无审批语义）也先解决工具再调模型', async () => {
    const safe = { calls: [] as unknown[] };
    let sentLen = 0;
    const { client, seen } = mockClient([
      {
        onParams: (p) => {
          sentLen = (p as { messages: unknown[] }).messages.length;
        },
        message: endTurnMsg('ok'),
      },
    ]);
    const result = await runAgent({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu9', name: 'safe', input: {} }],
        },
      ],
      client,
      tools: [normalTool(safe)],
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(safe.calls.length, 1, '普通工具的未决 tool_use 直接执行，不挂起');
    assert.equal(seen.length, 1, '恢复只发起一次模型请求（解决完工具才调）');
    assert.equal(sentLen, 3, 'assistant 不重复 push，只追加 tool_result 的 user 消息');
  });

  it('恢复入口尊重 signal：已取消时不执行任何工具', async () => {
    const safe = { calls: [] as unknown[] };
    const ac = new AbortController();
    ac.abort();
    const { client, seen } = mockClient([]);
    const result = await runAgent({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu9', name: 'safe', input: {} }],
        },
      ],
      client,
      tools: [normalTool(safe)],
      signal: ac.signal,
    });
    assert.equal(result.stopReason, 'aborted');
    assert.equal(safe.calls.length, 0, '取消后副作用不该发生');
    assert.equal(seen.length, 0);
  });
});
