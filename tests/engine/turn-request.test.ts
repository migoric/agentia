import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageParam } from '../../src/core/message.js';
import { buildTurnRequest } from '../../src/engine/turn-request.js';

const base = { model: 'claude-opus-5', maxTokens: 16, apiTools: [], messages: [] };

describe('turn-request —— 回合请求装配（从 streamTurn 抽出）', () => {
  it('三个可选键缺省时**不带该键**（不是 undefined、也不是空数组）', () => {
    const p = buildTurnRequest({ ...base });
    assert.deepEqual(Object.keys(p).sort(), ['max_tokens', 'messages', 'model']);
    assert.equal('system' in p, false, 'system 键在场与否是语义，不能传 undefined 充数');
    assert.equal('tools' in p, false, '空数组会被某些端点读成「声明了零个工具」');
    assert.equal('signal' in p, false);
  });

  it('给了就原样带上（含 system / tools / signal）', () => {
    const ac = new AbortController();
    const tools = [{ name: 'echo', description: 'd', input_schema: { type: 'object' } }] as never;
    const p = buildTurnRequest({ ...base, system: 'SYS', apiTools: tools, signal: ac.signal });
    assert.equal(p.system, 'SYS');
    assert.deepEqual(p.tools, tools);
    assert.equal(p.signal, ac.signal, 'signal 必须转发 —— 否则中止在飞 run 会静默失效');
  });

  it('model / max_tokens 原样透传，messages 以**快照**交出', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const p = buildTurnRequest({ ...base, messages });
    assert.equal(p.model, 'claude-opus-5');
    assert.equal(p.max_tokens, 16);
    assert.deepEqual(p.messages, messages);
    // `ctx.messages` 是同一条活历史：本轮之后 loop 还会往里 push（assistant / 工具结果 /
    // 审批事件）。交出引用 = 让客户端在不知情的情况下看到「未来」的消息 —— 任何把 params
    // 排队、缓存或录制的实现都会读到被后续轮次污染的数组（实测：调用时 3 条，同引用事后 4 条）。
    messages.push({ role: 'assistant', content: 'later' });
    assert.equal(p.messages.length, 1, '已交出的请求不得随活历史增长');
  });

  it('system 为空串同样不带该键（`!system` 判定，与抽取前逐字一致）', () => {
    const p = buildTurnRequest({ ...base, system: '' });
    assert.equal('system' in p, false);
  });
});
