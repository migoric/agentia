import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceRecordEvent } from '../../src/core/trace.js';
import type { TaskRecord } from '../../src/store/store.js';
import { TaskEventStreams } from '../../src/transport/task-events.js';
import type {
  StreamJanitorGroup,
  StreamJanitorTarget,
} from '../../src/transport/stream-janitor.js';
import {
  serveTaskStream,
  TaskStreamError,
  type TaskStreamFrame,
  type TaskStreamSource,
} from '../../src/transport/task-stream.js';

/**
 * `serveTaskStream` 的**直接**单测（2026-11-22 抽出 `task-stream.ts` 时补）。
 *
 * 为什么值得单独一份：端到端那条（`taskStream.test.ts` 走 HTTP）能守住「重放 / 实时 / 收口」
 * 三条主语义，但守不住**防御分支** —— 终态那一刻 `poll` reject、`listener` 自己抛错、
 * 扫描器判据抛错这几种，线上是「宿主进程被 unhandledRejection 杀掉」或「静默不告警」，
 * 而端到端要造出来得让 store 客户端在恰好那一拍抖动。抽件的收益就在这里：**判据能直接打**。
 *
 * 假件只三样（记账缓冲是真件、扫描器与 poll 是假的）—— 这正是 `TaskStreamSource` 的形状，
 * 它没有第四个参数，也不需要 `AsyncRunner` 在场。
 */

const ev = (n: number): TraceRecordEvent => ({
  type: 'span.attribute',
  seq: n,
  spanId: 's',
  key: 'k',
  value: n,
});

/** 一条记录只需要 `status` 与 `taskId`（本件只判终态、不读别的字段） */
const rec = (taskId: string, status: TaskRecord['status']): TaskRecord =>
  ({ taskId, status }) as TaskRecord;

interface FakeJanitors extends StreamJanitorGroup {
  readonly added: Array<{ taskId: string; target: StreamJanitorTarget }>;
  readonly removed: number;
}

function fakeJanitors(): FakeJanitors {
  const added: Array<{ taskId: string; target: StreamJanitorTarget }> = [];
  const box = {
    added,
    removed: 0,
    add(taskId: string, target: StreamJanitorTarget): () => void {
      added.push({ taskId, target });
      return () => {
        box.removed += 1;
      };
    },
    close(): void {},
  };
  return box;
}

function sourceOf(
  poll: TaskStreamSource['poll'],
  janitors: StreamJanitorGroup = fakeJanitors(),
  streams = new TaskEventStreams(),
): TaskStreamSource {
  return { streams, janitors, poll };
}

describe('serveTaskStream —— 三帧形状的判据直接打在这里', () => {
  it('本进程没有这条流 + 任务不存在 ⇒ 404（不是一条永远挂着的空流）', async () => {
    const src = sourceOf(() => undefined);
    await assert.rejects(
      () => serveTaskStream(src, 'nope', () => {}),
      (e: unknown) => e instanceof TaskStreamError && e.status === 404,
    );
  });

  it('本进程没有这条流 + 已终态 ⇒ unavailable 后补 end（能收口的谎不能说）', async () => {
    const frames: TaskStreamFrame[] = [];
    const src = sourceOf(() => rec('t1', 'succeeded'));
    const off = await serveTaskStream(src, 't1', (f) => frames.push(f));
    assert.deepEqual(
      frames.map((f) => f.type),
      ['unavailable', 'end'],
    );
    off(); // 返回 noop —— 但必须可调用（调用方无条件会调它）
  });

  it('本进程没有这条流 + 非终态 ⇒ unavailable 后补 closed，**不伪造** end', async () => {
    const frames: TaskStreamFrame[] = [];
    const src = sourceOf(() => rec('t1', 'running'));
    await serveTaskStream(src, 't1', (f) => frames.push(f));
    assert.deepEqual(
      frames.map((f) => f.type),
      ['unavailable', 'closed'],
    );
  });

  it('挂起不是终态：suspended 记录走 closed（流级收尾），不走 end', async () => {
    const frames: TaskStreamFrame[] = [];
    const src = sourceOf(() => rec('t1', 'suspended'));
    await serveTaskStream(src, 't1', (f) => frames.push(f));
    assert.deepEqual(
      frames.map((f) => f.type),
      ['unavailable', 'closed'],
    );
  });

  it('重放：from 之后的事件才补；终态流补完立刻 end（不留鬼流）', async () => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    for (let i = 1; i <= 3; i++) streams.push('t1', ev(i));
    streams.markDone('t1');
    const frames: TaskStreamFrame[] = [];
    const src = sourceOf(() => rec('t1', 'succeeded'), fakeJanitors(), streams);
    const off = await serveTaskStream(src, 't1', (f) => frames.push(f), { from: 1 });
    assert.deepEqual(
      frames.map((f) => (f.type === 'trace' ? f.index : f.type)),
      [2, 3, 'end'],
    );
    off();
  });

  it('终态但记录被清（TTL / 外部删除）⇒ 仍补一帧 closed，不能一帧都不发', async () => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    streams.push('t1', ev(1));
    streams.markDone('t1');
    const frames: TaskStreamFrame[] = [];
    const src = sourceOf(() => undefined, fakeJanitors(), streams);
    await serveTaskStream(src, 't1', (f) => frames.push(f));
    assert.deepEqual(
      frames.map((f) => (f.type === 'trace' ? f.index : f.type)),
      [1, 'closed'],
    );
  });
});

describe('终态那一刻的收口（onDone）—— 防御分支，端到端造不出来', () => {
  it('markDone 触发补发 end（记录已在库里）', async () => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    streams.push('t1', ev(1));
    const frames: TaskStreamFrame[] = [];
    const src = sourceOf(() => rec('t1', 'succeeded'), fakeJanitors(), streams);
    await serveTaskStream(src, 't1', (f) => frames.push(f), { pollMs: 0 });
    streams.markDone('t1');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(
      frames.map((f) => (f.type === 'trace' ? f.index : f.type)),
      [1, 'end'],
    );
  });

  it('markDone 那一刻 poll 抛错（store 抖动）⇒ 补 closed 而不是炸进程', async () => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    const frames: TaskStreamFrame[] = [];
    const src = sourceOf(() => Promise.reject(new Error('redis blip')), fakeJanitors(), streams);
    await serveTaskStream(src, 't1', (f) => frames.push(f), { pollMs: 0 });
    streams.markDone('t1');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(
      frames.map((f) => f.type),
      ['closed'],
    );
  });

  it('listener 自己在 onDone 里抛错也不得变成 unhandled（宿主记账，不击穿）', async () => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    const src = sourceOf(() => rec('t1', 'succeeded'), fakeJanitors(), streams);
    let calls = 0;
    await serveTaskStream(
      src,
      't1',
      () => {
        calls += 1;
        throw new Error('listener 坏了');
      },
      { pollMs: 0 },
    );
    streams.markDone('t1');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 1, 'end 帧没发（抛错发生在发帧时，调用次数应为 1）');
  });
});

describe('跨进程兜底登记的接线（扫描器是假件，只验配对与告警一次）', () => {
  it('pollMs > 0 ⇒ 登记；退订时扫描器也被注销（否则定时器跟着流泄漏）', async () => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    const janitors = fakeJanitors();
    const src = sourceOf(() => rec('t1', 'running'), janitors, streams);
    const off = await serveTaskStream(src, 't1', () => {});
    assert.equal(janitors.added.length, 1);
    assert.equal(janitors.added[0]?.taskId, 't1');
    off();
    assert.equal(janitors.removed, 1, '退订没把扫描器登记摘掉');
  });

  it('pollMs <= 0 ⇒ 这条流不参与兜底（不登记）', async () => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    const janitors = fakeJanitors();
    const src = sourceOf(() => rec('t1', 'running'), janitors, streams);
    const off = await serveTaskStream(src, 't1', () => {}, { pollMs: 0 });
    assert.equal(janitors.added.length, 0);
    off();
  });

  it('扫描器判据抛错：onError 只告警一次（停机窗口里不刷屏）', async (t) => {
    const streams = new TaskEventStreams();
    streams.open('t1');
    const janitors = fakeJanitors();
    const warns: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    });
    const src = sourceOf(() => rec('t1', 'running'), janitors, streams);
    await serveTaskStream(src, 't1', () => {});
    const target = janitors.added[0]?.target;
    assert.ok(target?.onError, '登记时没带 onError —— 判据抛错会静默吞成「这一拍什么都没做」');
    target.onError(new Error('boom'));
    target.onError(new Error('boom again'));
    assert.equal(warns.length, 1, '同一条流只该告警一次');
    assert.match(warns[0] ?? '', /boom/);
  });
});
