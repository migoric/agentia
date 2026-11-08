import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun } from '../../src/runtime/run.js';
import { runAgent } from '../../src/engine/loop.js';
import { USAGE_PARTIAL_EVENT } from '../../src/core/trace.js';
import type { AgentTool, ModelClient } from '../../src/core/tool.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

describe('2026-11-07 深评的引擎修复', () => {
  it('失败尝试的部分 usage 记进失败 turn 的 span（预算不再少算）', async () => {
    let attempts = 0;
    const client: ModelClient = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            attempts++;
            const e = Object.assign(new Error('流中断'), {
              status: 500,
              partialUsage: {
                inputTokens: 100,
                outputTokens: 3,
                cacheReadTokens: 7,
                cacheCreationTokens: 0,
              },
            });
            throw e;
          },
        }),
      },
    };
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      retry: { maxAttempts: 1 },
    });
    assert.equal(attempts, 1);
    assert.equal(result.stopReason, 'error');
    assert.equal(result.trace.totalUsage.inputTokens, 100, '失败尝试的 input token 必须落账');
    assert.equal(result.trace.totalUsage.cacheReadTokens, 7);
    const events = result.trace.spans.flatMap((s) => s.events);
    assert.ok(events.some((e) => e.name === USAGE_PARTIAL_EVENT));
  });

  it('toolTimeoutMs: NaN 在 run 入口响亮失败（不再把每条工具都打成失败）', async () => {
    const { client } = mockClient([endTurnMsg('ok')]);
    await assert.rejects(
      runAgent({
        messages: [{ role: 'user', content: 'go' }],
        client,
        toolTimeoutMs: Number.NaN,
      }),
      /toolTimeoutMs 不能是 NaN/,
    );
  });

  it('end_turn 却带 tool_use：按工具执行而不是静默丢弃', async () => {
    let calls = 0;
    const tool: AgentTool = {
      name: 't',
      description: 'd',
      inputSchema: { type: 'object' },
      run: () => {
        calls++;
        return 'ok';
      },
    };
    const { client } = mockClient([
      {
        ...toolUseMsg('t', {}),
        stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'tu1', name: 't', input: {} }],
      },
      endTurnMsg('done'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [tool],
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, 'done');
  });

  it('maxEventChars: NaN 在第一次模型调用前以结构化错误收尾（不再静默不截断）', async () => {
    const { client, seen } = mockClient([endTurnMsg('不该调用')]);
    const out = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      maxEventChars: Number.NaN,
    });
    assert.equal(out.stopReason, 'error');
    assert.match(out.error?.message ?? '', /maxEventChars/);
    assert.equal(seen.length, 0);
  });
});
