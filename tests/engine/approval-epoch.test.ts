import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/engine/loop.js';
import type { AgentTool } from '../../src/core/tool.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

function dangerTool(spy: { calls: number }): AgentTool {
  return {
    name: 'danger',
    description: '需要审批',
    inputSchema: { type: 'object', properties: {} },
    approval: 'required',
    run: () => {
      spy.calls++;
      return 'done';
    },
  };
}

describe('审批决定的作用域（2026-11-07 深评）', () => {
  it('同一 run 段内同一 tool_use_id 只消费一次：第二次出现必须重新挂起', async () => {
    const spy = { calls: 0 };
    const { client } = mockClient([
      toolUseMsg('danger', {}, 'call_1'),
      // 续跑段模型再次用同一个 id（OpenAI 兼容端点会复用 call_1）
      toolUseMsg('danger', {}, 'call_1'),
      endTurnMsg('不该到这里'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [dangerTool(spy)],
      approvals: { call_1: { approved: true, requestedAt: 111 } },
    });
    assert.equal(spy.calls, 1, '第一次批准执行一次；第二次同名 id 不得复用旧决定');
    assert.equal(result.stopReason, 'suspended');
    assert.deepEqual(result.pendingApprovals, ['call_1']);
  });

  it('approvalEpoch 不匹配：旧挂起的决定不得批准新一次调用', async () => {
    const spy = { calls: 0 };
    const { client } = mockClient([toolUseMsg('danger', {}, 'call_1')]);
    const first = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [dangerTool(spy)],
    });
    assert.equal(first.stopReason, 'suspended');
    assert.equal(spy.calls, 0);
    const { client: c2 } = mockClient([endTurnMsg('不该到这里')]);
    const resumed = await runAgent({
      messages: first.suspendedMessages!,
      client: c2,
      tools: [dangerTool(spy)],
      approvals: { call_1: { approved: true, requestedAt: 111 } },
      approvalEpoch: 222,
    });
    assert.equal(spy.calls, 0, 'requestedAt≠approvalEpoch 的决定必须被忽略');
    assert.equal(resumed.stopReason, 'suspended');
    assert.deepEqual(resumed.pendingApprovals, ['call_1']);
  });

  it('approvalEpoch 匹配：决定生效；随后同 id 复用仍会再次挂起', async () => {
    const spy = { calls: 0 };
    const { client } = mockClient([toolUseMsg('danger', {}, 'call_1')]);
    const first = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [dangerTool(spy)],
    });
    const { client: c2 } = mockClient([
      toolUseMsg('danger', {}, 'call_1'),
      endTurnMsg('不该到这里'),
    ]);
    const resumed = await runAgent({
      messages: first.suspendedMessages!,
      client: c2,
      tools: [dangerTool(spy)],
      approvals: { call_1: { approved: true, requestedAt: 111 } },
      approvalEpoch: 111,
    });
    assert.equal(spy.calls, 1);
    assert.equal(resumed.stopReason, 'suspended');
    assert.deepEqual(resumed.pendingApprovals, ['call_1']);
  });
});
