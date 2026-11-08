import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamJanitor } from '../../src/transport/stream-janitor.js';
import { waitFor } from '../helpers.js';

describe('createStreamJanitor —— 跨进程 SSE 兜底收口（2026-11-07 深评 F5）', () => {
  it('终态 ⇒ onTerminal 一次；之后不再轮询', async () => {
    let calls = 0;
    let terminals = 0;
    const cleanup = createStreamJanitor({
      poll: async () => {
        calls++;
        return { ownerId: 'me' };
      },
      isTerminal: () => true,
      ownerId: 'me',
      onTerminal: () => terminals++,
      onClosed: () => assert.fail('不应发 closed'),
      pollMs: 5,
    });
    await waitFor(() => terminals === 1, 'janitor 看到终态');
    const n = calls;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, n, '收口后停止轮询');
    cleanup();
  });

  it('记录消失 / 换主 ⇒ closed；读失败不炸（下一拍再试）', async () => {
    let closed = 0;
    let n = 0;
    const cleanup = createStreamJanitor({
      poll: async () => {
        n++;
        if (n === 1) throw new Error('store 抖动');
        return { ownerId: 'other' };
      },
      isTerminal: () => false,
      ownerId: 'me',
      onTerminal: () => assert.fail('不应发 terminal'),
      onClosed: () => closed++,
      pollMs: 5,
    });
    await waitFor(() => closed === 1, '换主后收口');
    cleanup();
  });

  it('cleanup 幂等且停止轮询', async () => {
    let n = 0;
    const cleanup = createStreamJanitor({
      poll: async () => {
        n++;
        return undefined;
      },
      isTerminal: () => false,
      ownerId: 'me',
      onTerminal: () => {},
      onClosed: () => {},
      pollMs: 5,
    });
    cleanup();
    cleanup();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 0, 'cleanup 之后不再 poll');
  });
});
