import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunReport, metricsSink, runAgent } from '../../src/index.js';
import type { AgentRunResult, AgentTool } from '../../src/index.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

type ResumeMode = 'approval' | 'timer';

/** 真跑一段挂起与一段恢复，返回恢复段的 trace（工具事件在这段没有 llm.turn）。 */
async function runResumedTool(mode: ResumeMode, fail: boolean): Promise<AgentRunResult> {
  let calls = 0;
  let defer = mode === 'timer';
  const tool: AgentTool = {
    name: 'danger',
    description: '恢复后执行的工具',
    inputSchema: OBJ,
    ...(mode === 'approval' ? { approval: 'required' as const } : {}),
    run: (_input, ctx) => {
      calls++;
      if (defer) {
        defer = false;
        ctx!.deferUntil!(Date.now() + 60_000);
        return 'deferred';
      }
      if (fail) throw new Error('tool failed');
      return 'executed';
    },
  };
  const first = mockClient([toolUseMsg('danger', {}, 'tu1')]);
  const suspended = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    client: first.client,
    tools: [tool],
  });
  assert.equal(suspended.stopReason, 'suspended');
  assert.equal(suspended.suspendedReason, mode);

  const second = mockClient([endTurnMsg('done')]);
  const resumed = await runAgent({
    messages: suspended.suspendedMessages!,
    client: second.client,
    tools: [tool],
    ...(mode === 'approval' ? { approvals: { tu1: { approved: true } } } : {}),
  });
  assert.equal(resumed.stopReason, 'end_turn');
  assert.equal(calls, mode === 'timer' ? 2 : 1);
  const root = resumed.trace.spans.find((s) => s.spanId === resumed.trace.rootSpanId)!;
  const outputs = root.events.filter((e) => e.name === 'tool.output');
  assert.equal(outputs.length, 1, '恢复工具事件应落在 run 根，测试必须打到这次漏账的形状');
  assert.equal((outputs[0]!.body as { ok: boolean }).ok, !fail);
  return resumed;
}

describe('恢复段工具的能力记账', () => {
  for (const mode of ['approval', 'timer'] as const) {
    it(`${mode} 恢复后的成功 / 失败工具都进 metrics 与 buildRunReport`, async () => {
      for (const fail of [false, true]) {
        const resumed = await runResumedTool(mode, fail);
        const sink = metricsSink();
        await sink.export(resumed.trace);
        const metric = sink.snapshot().capabilities['tool:danger'];
        assert.ok(metric, `${mode} / fail=${fail}：metrics 不得漏掉恢复工具`);
        assert.equal(metric.calls, 1);
        assert.equal(metric.errors, fail ? 1 : 0);

        const row = buildRunReport(resumed.trace).capabilities.find(
          (c) => c.capability === 'tool:danger',
        );
        assert.ok(row, `${mode} / fail=${fail}：报告不得漏掉恢复工具`);
        assert.equal(row.calls, 1);
        assert.equal(row.errors, fail ? 1 : 0);
        assert.ok(row.durationMs.total >= 0);
      }
    });
  }
});
