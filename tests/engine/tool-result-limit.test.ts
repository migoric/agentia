import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type AgentTool } from '../../src/index.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

const schema = { type: 'object', properties: {}, additionalProperties: false } as const;

describe('maxToolResultChars', () => {
  it('裁的是回给模型的 tool_result；trace 记账仍由 maxEventChars 独立决定', async () => {
    let seen = '';
    const { client } = mockClient([
      toolUseMsg('big', {}, 'tu1'),
      {
        onParams: (params: unknown) => {
          const messages = (params as { messages: Array<{ content: unknown }> }).messages;
          const last = messages[messages.length - 1];
          seen = (last.content as Array<{ content: string }>)[0]!.content;
        },
        message: endTurnMsg('done'),
      } as unknown as Record<string, unknown>,
    ]);
    const tools: AgentTool[] = [
      {
        name: 'big',
        description: '大结果',
        inputSchema: schema,
        run: () => 'x'.repeat(50),
      },
    ];
    const out = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools,
      maxToolResultChars: 5,
      maxEventChars: false,
    });
    assert.equal(out.stopReason, 'end_turn');
    assert.equal(seen, 'xxxxx…(+45)');
    const event = out.trace.spans.flatMap((s) => s.events).find((e) => e.name === 'tool.output');
    assert.ok(event);
    assert.equal((event.body as { content: string }).content, 'x'.repeat(50));
  });

  it('非法上限在第一次模型调用前以结构化错误收尾', async () => {
    const { client, seen } = mockClient([endTurnMsg('不该调用')]);
    const out = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      maxToolResultChars: Number.NaN,
    });
    assert.equal(out.stopReason, 'error');
    assert.match(out.error?.message ?? '', /maxToolResultChars/);
    assert.equal(seen.length, 0);
  });
});
