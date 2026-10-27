import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Trace } from '../../src/index.js';
import { flushTraceSinks } from '../../src/core/trace-sink.js';

function trace(): Trace {
  return {
    traceId: 'trace-1',
    rootSpanId: 'root-1',
    spans: [],
    status: 'ok',
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

describe('flushTraceSinks', () => {
  it('永不 resolve 的 sink 到点放弃，后续 sink 仍收到 trace 且有告警', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const received: Trace[] = [];
    const value = trace();

    await flushTraceSinks(
      [{ export: () => new Promise<void>(() => {}) }, { export: (t) => void received.push(t) }],
      value,
      20,
    );

    assert.deepEqual(received, [value]);
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(String(warnings.mock.calls[0]!.arguments[0]), /投递超时.*20ms/);
  });

  it('同步抛错与异步拒绝都不阻断后续 sink，并各自告警', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const received: Trace[] = [];
    const value = trace();

    await flushTraceSinks(
      [
        {
          export: () => {
            throw new Error('sync boom');
          },
        },
        { export: () => Promise.reject(new Error('async boom')) },
        { export: (t) => void received.push(t) },
      ],
      value,
      20,
    );

    assert.deepEqual(received, [value]);
    assert.equal(warnings.mock.callCount(), 2);
    assert.match(String(warnings.mock.calls[0]!.arguments[1]), /sync boom/);
    assert.match(String(warnings.mock.calls[1]!.arguments[1]), /async boom/);
  });

  it('正常 sink 保持顺序投递且无告警', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const calls: string[] = [];
    const value = trace();

    await flushTraceSinks(
      [
        {
          export: async () => {
            calls.push('first');
          },
        },
        {
          export: () => {
            calls.push('second');
          },
        },
      ],
      value,
      20,
    );

    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(warnings.mock.callCount(), 0);
  });
});
