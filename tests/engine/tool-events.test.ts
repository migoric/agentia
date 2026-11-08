import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolUseBlock } from '../../src/core/message.js';
import {
  DEFAULT_ERROR_EVENT_CHARS,
  DEFAULT_EVENT_CHARS,
  toolInputPayload,
  toolOutputPayload,
  toolResultBlock,
} from '../../src/engine/tool-events.js';

const use = {
  type: 'tool_use',
  id: 'tu1',
  name: 'echo',
  input: { a: 1 },
} as unknown as ToolUseBlock;
const long = (n: number): string => 'x'.repeat(n);
const base = { use, ok: true, startedAt: 1_000, now: 1_050, content: 'ok' };

describe('tool-events —— 单工具执行的记账面（从 executeOneTool 抽出）', () => {
  it('tool.input：缺省按 2000 截断并带省略标记；tool / tool_use_id 原样', () => {
    const p = toolInputPayload({ ...use, input: long(5_000) } as unknown as ToolUseBlock);
    assert.equal(p.tool, 'echo');
    assert.equal(p.tool_use_id, 'tu1');
    assert.ok(p.input.startsWith('x'.repeat(DEFAULT_EVENT_CHARS)), '保留前 N 个字符');
    assert.match(p.input, /…\(\+3000\)$/, '超出的部分以「…(+N)」标记，不静默丢');
  });

  it('tool.input：maxEventChars=false ⇒ **不截断**（调试期开全文，不许回落默认）', () => {
    const p = toolInputPayload({ ...use, input: long(5_000) } as unknown as ToolUseBlock, false);
    assert.equal(p.input.length, 5_000);
    assert.equal(p.input.includes('…'), false);
  });

  it('tool.output：**截断上限不对称** —— 成功 2000 / 失败 1000（同一份内容）', () => {
    const content = long(5_000);
    const ok = toolOutputPayload({ ...base, ok: true, content });
    const bad = toolOutputPayload({ ...base, ok: false, content });
    assert.ok(ok.content.startsWith('x'.repeat(DEFAULT_EVENT_CHARS)), '成功：留 2000');
    assert.ok(bad.content.startsWith('x'.repeat(DEFAULT_ERROR_EVENT_CHARS)), '失败：只留 1000');
    assert.ok(
      bad.content.length < ok.content.length,
      '失败事件的正文更短 —— 「哪个工具老超时」要一行看得完',
    );
  });

  it('tool.output：maxEventChars 显式给出时**压过**成功/失败两套缺省', () => {
    const content = long(5_000);
    for (const ok of [true, false]) {
      const p = toolOutputPayload({ ...base, ok, content, maxEventChars: 10 });
      assert.ok(p.content.startsWith('x'.repeat(10)));
    }
    const raw = toolOutputPayload({ ...base, ok: true, content, maxEventChars: false });
    assert.equal(raw.content.length, 5_000, 'false = 不截断');
  });

  it('tool.output：durationMs 非负（时钟回拨钳到 0），且四条路径共用同一算法', () => {
    assert.equal(toolOutputPayload({ ...base }).durationMs, 50);
    assert.equal(
      toolOutputPayload({ ...base, startedAt: 2_000, now: 1_000 }).durationMs,
      0,
      '时钟回拨不许出负数',
    );
  });

  it('tool.output：errorKind 有值才在场（成功事件不带 undefined 键）', () => {
    assert.equal('errorKind' in toolOutputPayload({ ...base, ok: true }), false);
    assert.equal(
      toolOutputPayload({ ...base, ok: false, errorKind: 'timeout' }).errorKind,
      'timeout',
    );
    assert.equal(
      'errorKind' in toolOutputPayload({ ...base, ok: true, errorKind: undefined }),
      false,
    );
  });

  it('tool_result 块：is_error 与 ok 互为反；对象内容走 stringifySafe', () => {
    const okBlock = toolResultBlock(use, true, { nested: [1, 2] });
    assert.equal(okBlock.type, 'tool_result');
    assert.equal(okBlock.tool_use_id, 'tu1');
    assert.equal(okBlock.is_error, false);
    assert.equal(okBlock.content, '{"nested":[1,2]}', '对象要序列化成字符串再回给模型');
    assert.equal(toolResultBlock(use, false, 'boom').is_error, true);
  });

  it('tool_result 上限只裁回模型的正文，并明确标出丢弃字符数；false / 缺省不裁', () => {
    assert.equal(toolResultBlock(use, true, 'abcdefghij', 4).content, 'abcd…(+6)');
    assert.equal(toolResultBlock(use, true, 'abcdefghij', 0).content, '', '0 = 截到零长度');
    assert.equal(toolResultBlock(use, true, 'abcdefghij', false).content, 'abcdefghij');
    assert.equal(toolResultBlock(use, true, 'abcdefghij').content, 'abcdefghij');
    assert.equal(toolResultBlock(use, true, { a: 1 }, 4).content, '{"a"…(+3)');
  });
});
