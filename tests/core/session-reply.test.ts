import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_REPLY_MARK,
  SESSION_REPLY_MAX_CHARS,
  clipSessionReply,
  sessionReplyContent,
  sessionReplyText,
} from '../../src/index.js';

/**
 * `core/session-reply.ts` 的取值口径。
 *
 * 这些用例钉的是**判断**本身（纯函数、无 IO），不是回写路径：两条回写路径（普通 run /
 * HITL 恢复段）各自还有自己的接线用例，见 `tests/runtime/session.test.ts` 与
 * `tests/transport/async.test.ts`。分开的理由很实际 —— 接线用例要跑一次完整的 run，
 * 而「白名单键序」「空壳算不算正文」这类判据要能被逐条读、逐条改。
 */
describe('会话正文取值（sessionReplyText / sessionReplyContent）', () => {
  it('finalText 非空 ⇒ 用它，且不被 typed 顶掉', () => {
    assert.equal(
      sessionReplyText({ finalText: '巡检完成', typed: { report: '## 报告正文' } }),
      '巡检完成',
      '散文优先：模型真说过的话不该被序列化结果替换',
    );
  });

  it('finalText 为空 + typed.report ⇒ 结构化正文（这就是 0.10.15 修的那条）', () => {
    const report = '## 巡检报告\n\n- 系统：arms-front\n- 周期：2026-11-24 00:00 — 2026-11-25 00:00';
    assert.equal(sessionReplyText({ finalText: '', typed: { report } }), report);
  });

  it('finalText 纯空白 + typed.reply 带空白 ⇒ 取到的是 trim 后的值', () => {
    assert.equal(sessionReplyText({ finalText: '   ', typed: { reply: ' 转人工 ' } }), '转人工');
  });

  it('正文保留内部换行（报告是 markdown，不能压成一行）', () => {
    const text = sessionReplyText({ finalText: '', typed: { text: ' 第一行\n第二行\n' } });
    assert.equal(text, '第一行\n第二行');
  });

  it('白名单键序 report → reply → text → content → summary → answer：取第一个非空', () => {
    assert.equal(sessionReplyText({ finalText: '', typed: { reply: 'R', report: 'P' } }), 'P');
    assert.equal(
      sessionReplyText({ finalText: '', typed: { answer: 'A', summary: 'S', content: 'C' } }),
      'C',
      '长键名不该抢在键序前面的短键名之前',
    );
    assert.equal(sessionReplyText({ finalText: '', typed: { answer: 'A' } }), 'A');
  });

  it('白名单全落空 ⇒ JSON 兜底（不是占位符）', () => {
    assert.equal(
      sessionReplyText({ finalText: '', typed: { report: '', reply: '' } }),
      '{"report":"","reply":""}',
      '键在但值为空 ≠ 没内容：结构本身仍是这一轮的产出，交出去比说「没返回」有用',
    );
  });

  it('根类型是数组 ⇒ JSON 兜底，不抛错', () => {
    assert.equal(sessionReplyText({ finalText: '', typed: [{ a: 1 }] }), '[{"a":1}]');
  });

  it('根类型是字符串 ⇒ 原样返回（刻意不 JSON 化）', () => {
    // JSON.stringify('报告') = '"报告"' —— 把引号写进对话历史是噪音，不是保真
    assert.equal(sessionReplyText({ finalText: '', typed: ' 报告 ' }), '报告');
    assert.equal(sessionReplyText({ finalText: '', typed: '   ' }), undefined);
  });

  it('空壳 {} / [] 与「什么都没有」同判 ⇒ undefined（由调用方落占位）', () => {
    assert.equal(sessionReplyText({ finalText: '', typed: {} }), undefined);
    assert.equal(sessionReplyText({ finalText: '', typed: [] }), undefined);
    assert.equal(sessionReplyText({ finalText: '', typed: undefined }), undefined);
    assert.equal(sessionReplyText({ finalText: undefined, typed: undefined }), undefined);
  });

  it('循环引用不抛错（会话回写路径上抛一次 = 这一轮白聊）', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.equal(sessionReplyText({ finalText: '', typed: cyclic }), undefined);
  });

  it('sessionReplyContent 恒非空：两样都空时是占位符', () => {
    assert.equal(sessionReplyContent({ finalText: '', typed: {} }), EMPTY_REPLY_MARK);
    assert.equal(sessionReplyContent({ finalText: '', typed: undefined }), EMPTY_REPLY_MARK);
    assert.equal(sessionReplyContent({ finalText: '有话说', typed: undefined }), '有话说');
  });
});

describe('会话正文截断（clipSessionReply）', () => {
  it('不超限原样返回（含恰好等于上限）', () => {
    const exact = 'x'.repeat(SESSION_REPLY_MAX_CHARS);
    assert.equal(clipSessionReply('短'), '短');
    assert.equal(clipSessionReply(exact), exact);
  });

  it('超限截到上限内并带标记', () => {
    const clipped = clipSessionReply('x'.repeat(20_000));
    assert.ok(clipped.length <= SESSION_REPLY_MAX_CHARS, '总长（含标记）不得超过常量');
    assert.ok(clipped.endsWith('…[truncated]'), '截断必须自陈，否则读历史的人以为报告就这么多');
  });

  it('截断只影响会话正文，不改 typed 本身', () => {
    const typed = { report: 'y'.repeat(20_000) };
    const snapshot = structuredClone(typed);
    const content = sessionReplyContent({ finalText: '', typed });
    assert.ok(content.length <= SESSION_REPLY_MAX_CHARS);
    assert.deepEqual(typed, snapshot, '入参一律只读 —— 截断是「会话要不要全长」的问题，不是改结果');
  });
});
