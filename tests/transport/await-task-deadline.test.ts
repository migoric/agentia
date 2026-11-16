import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForTask } from '../../src/transport/task-awaiter.js';
import type { AwaitTaskDeps } from '../../src/transport/task-awaiter.js';
import type { SubmissionInit } from '../../src/transport/submission.js';

function deps(over: Partial<AwaitTaskDeps>): AwaitTaskDeps {
  return {
    submissions: new Map(),
    firstSave: new Map(),
    poll: () => {
      throw new Error('本用例不应进入 poll');
    },
    wait: () => Promise.resolve(),
    ...over,
  };
}

describe('awaitTask 的 deadline 覆盖远端初始化与状态读取', () => {
  it('提交初始化永不 settle：仍按 timeoutMs 拒绝，而不是永久等待', { timeout: 500 }, async () => {
    const initializing = new Promise<SubmissionInit>(() => {});
    await assert.rejects(
      waitForTask(deps({ submissions: new Map([['task-1', initializing]]) }), 'task-1', {
        timeoutMs: 20,
      }),
      /等待超时（提交初始化未完成）/,
    );
  });

  it('store poll 永不 settle：仍按 timeoutMs 拒绝，而不是永久等待', { timeout: 500 }, async () => {
    await assert.rejects(
      waitForTask(deps({ poll: () => new Promise(() => {}) }), 'task-1', { timeoutMs: 20 }),
      /等待超时（状态读取未完成）/,
    );
  });
});
