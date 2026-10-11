import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySuspendedOutcome,
  applyTerminalOutcome,
  readClaimed,
} from '../../src/transport/run-outcome.js';
import type { RunSettled } from '../../src/transport/run-outcome.js';
import { InMemoryTaskStore } from '../../src/store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../../src/store/store.js';
import type { AgentRunResult } from '../../src/engine/types.js';
import type { TaskEvent } from '../../src/core/run.js';
import type { MessageParam } from '../../src/core/message.js';

/**
 * `run-outcome.ts` 的单测 —— 2026-10-11 自 `async.ts` 的 `#executeInner` 抽出三件后的直接验证。
 *
 * 为什么值得单独写：这三件事此前只能**透过宿主行为间接观察**（`tests/transport/*.test.ts`
 * 里那些跑真 runner 的用例），于是「快照取的时刻」「终态要不要清挂起痕迹」「store 读失败怎么算」
 * 这些口径全都没有**直接**断言。抽成具名件之后这里逐条钉住。
 */

const user = (text: string): MessageParam => ({ role: 'user', content: text });
/** 一个待注入事件（`TaskRecord.pendingEvents` 的元素）—— 形状照 `core/run.ts` 的 `TaskEvent` */
const taskEvent = (payload: string): TaskEvent => ({ type: 'test.event', payload });

/** 造一条最小但**字段齐全**的 TaskRecord（可选项逐条覆盖） */
function mkRec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 't1',
    status: 'running',
    spec: { messages: [user('原始输入')] },
    createdAt: 1_000,
    ...over,
  };
}

/**
 * 造一份**字段齐全**的 AgentRunResult（形状与 `http.test.ts` 的 `fakeResult` 同源，
 * 这里多一个逐字段覆盖的口子 —— 因为本件要断言的正是那几个字段本身）。
 *
 * ⚠️ 刻意**不**用 `{} as AgentRunResult` 的省事写法（本仓别处有）：本件真正读的就是
 * `pendingApprovals` / `suspendedReason` / `wakeAt` / `eventsDelivered`，用空对象 cast 会让
 * **字段名写错在 `tsc` 下全绿、运行时读成 undefined**（本仓第 5 条踩过的原样形态）。
 * 只有 `trace` 用 cast 占位 —— 本件一个字段都不读它。两份 fixture 的重复是**自检的**
 * （接口加字段时两处都会红），所以不留共享工厂。
 */
function mkResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    trace: {} as AgentRunResult['trace'],
    stopReason: 'end_turn',
    finalText: '最终文本',
    iterations: 1,
    error: undefined,
    typed: undefined,
    suspendedMessages: undefined,
    pendingApprovals: undefined,
    suspendedReason: undefined,
    wakeAt: undefined,
    eventsDelivered: false,
    ...over,
  };
}

/** get 必抛的 store（模拟「停机窗口里 store 已 close」这条既有场景） */
class ThrowingStore extends InMemoryTaskStore {
  override get(): TaskRecord | undefined {
    throw new Error('store 已 close');
  }
}

/**
 * `get` 走 Promise 的 store（异步 store 的形态）。
 *
 * 为什么不 `extends InMemoryTaskStore` 覆盖 `get`：TS 的方法返回类型只能**收窄**不能放宽，
 * 而 `InMemoryTaskStore` 把接口上的 `MaybePromise` 收窄成了同步返回 ⇒ 子类改不回异步。
 * 所以这里直接 `implements TaskStore` 并**逐条委托**给真 store —— 好处是 `TaskStore` 一旦
 * 加方法，这份替身会编译报错，不会悄悄落后。
 */
class AsyncGetStore implements TaskStore {
  readonly #inner = new InMemoryTaskStore();
  save(rec: TaskRecord): MaybePromise<void> {
    return this.#inner.save(rec);
  }
  get(taskId: string): Promise<TaskRecord | undefined> {
    return Promise.resolve(this.#inner.get(taskId));
  }
  byIdempotency(key: string): MaybePromise<TaskRecord | undefined> {
    return this.#inner.byIdempotency(key);
  }
  list(): MaybePromise<TaskRecord[]> {
    return this.#inner.list();
  }
  clear(): MaybePromise<void> {
    return this.#inner.clear();
  }
}

describe('readClaimed —— 认领前重读（自 #executeInner 抽出）', () => {
  it('store 里有该任务：返回 store 的那一份（不是 rec 本身）', async () => {
    const store = new InMemoryTaskStore();
    const stored = mkRec({ taskId: 't9', status: 'cancelled' });
    await store.save(stored);
    const claimed = await readClaimed(store, mkRec({ taskId: 't9', status: 'running' }));
    assert.equal(claimed, stored, '必须把 store 的真相交出来 —— 拿 submit 时那个对象判不出取消');
  });

  it('store 里没有：**回落 rec**（不是 undefined —— 那会让正常任务被这道闸吞掉）', async () => {
    const store = new InMemoryTaskStore();
    const rec = mkRec({ taskId: 't-not-stored' });
    const claimed = await readClaimed(store, rec);
    assert.equal(claimed, rec);
  });

  it('store 读失败：返回 undefined —— 读故障不升级成「任务起不来」', async () => {
    const rec = mkRec();
    const claimed = await readClaimed(new ThrowingStore(), rec);
    assert.equal(
      claimed,
      undefined,
      '停机窗口里 store 已 close 是既有场景：这道闸只负责「明知已终态就别跑」，' +
        '不负责把读取故障变成「任务起不来」（那条路径的行为由 scheduler 的用例钉着）',
    );
  });

  it('异步 store（get 返回 Promise）同样等得到 —— 别只测同步那一支', async () => {
    const store = new AsyncGetStore();
    const stored = mkRec({ taskId: 't-async', status: 'succeeded' });
    await store.save(stored);
    assert.equal(await readClaimed(store, mkRec({ taskId: 't-async' })), stored);
    assert.equal((await readClaimed(store, mkRec({ taskId: 't-absent' })))?.taskId, 't-absent');
  });
});

describe('applySuspendedOutcome —— 挂起出口的记录映射', () => {
  const extended = [user('原始输入'), user('工具结果'), user('继续')];

  it('首段挂起 + 带 sessionId + 有 store：快照取到的是**覆盖之前**的那个数组', () => {
    const original = [user('原始输入')];
    const rec = mkRec({ spec: { messages: original, options: { sessionId: 's1' } } });
    const snapshot = applySuspendedOutcome(rec, mkResult(), extended, {
      isResume: false,
      hasSessionStore: true,
      now: 5_000,
    });
    assert.equal(
      snapshot,
      original,
      '必须是原始输入那个**数组本身**（不是它的副本、更不是扩展历史）',
    );
    assert.equal(rec.spec.messages, extended, 'rec.spec.messages 换成扩展历史');
    assert.notEqual(snapshot, rec.spec.messages, '快照若与挂起历史同一个引用，等于没在覆盖前取');
  });

  it('保存快照的三条判据各缺一条都拿不到快照（逐条反向）', () => {
    const ctxOf = (isResume: boolean, hasSessionStore: boolean) => ({
      isResume,
      hasSessionStore,
      now: 5_000,
    });
    // ① 有 sessionId + 有 store，但是**恢复段** ⇒ 不取（spec.messages 已是扩展历史）
    const resume = mkRec({ spec: { messages: [user('扩展历史')], options: { sessionId: 's1' } } });
    assert.equal(
      applySuspendedOutcome(resume, mkResult(), extended, ctxOf(true, true)),
      undefined,
      '恢复段再挂起时拿扩展历史当「用户输入」就错了 —— 原快照仍在，不能覆盖',
    );
    // ② 首段 + 有 store，但没有 sessionId ⇒ 无从写会话
    const noSid = mkRec({ spec: { messages: [user('x')] } });
    assert.equal(applySuspendedOutcome(noSid, mkResult(), extended, ctxOf(false, true)), undefined);
    // ③ 首段 + 有 sessionId，但 runner 没配 sessionStore ⇒ 写不进任何地方
    const noStore = mkRec({ spec: { messages: [user('x')], options: { sessionId: 's1' } } });
    assert.equal(
      applySuspendedOutcome(noStore, mkResult(), extended, ctxOf(false, false)),
      undefined,
    );
  });

  it('记录落位：状态 / 挂起时刻 / 待决清单 / 原因 / 目标时刻，且 spec 的其余字段不丢', () => {
    const rec = mkRec({ spec: { messages: [user('原始输入')], source: 'sync' } });
    applySuspendedOutcome(
      rec,
      mkResult({
        stopReason: 'suspended',
        pendingApprovals: ['toolu_1', 'toolu_2'],
        suspendedReason: 'approval',
        wakeAt: undefined,
      }),
      extended,
      { isResume: false, hasSessionStore: false, now: 7_777 },
    );
    assert.equal(rec.status, 'suspended');
    assert.equal(rec.suspendedSince, 7_777, '挂起时刻取注入的 now（approvalTimeoutMs 的基准）');
    assert.deepEqual(rec.pendingApprovals, ['toolu_1', 'toolu_2']);
    assert.equal(rec.suspendedReason, 'approval', '原因**从结果形状取**，不许写死成 approval');
    assert.equal(rec.wakeAt, undefined, '时间挂起才有 wakeAt，等审批的恒为 undefined');
    assert.equal(rec.spec.source, 'sync', '展开 rec.spec 时其余字段不能被吞掉');
  });

  it('时间挂起：原因与目标时刻原样落库（不是「按原因反推时刻」）', () => {
    const rec = mkRec();
    applySuspendedOutcome(
      rec,
      mkResult({ stopReason: 'suspended', suspendedReason: 'timer', wakeAt: 12_345 }),
      extended,
      { isResume: false, hasSessionStore: false, now: 1 },
    );
    assert.equal(rec.suspendedReason, 'timer');
    assert.equal(rec.wakeAt, 12_345);
  });

  it('事件簿记只在**注入过**时清：eventsDelivered 两档都要断（否则「无条件清」也绿）', () => {
    const delivered = mkRec({ pendingEvents: [taskEvent('外部事件')] });
    applySuspendedOutcome(delivered, mkResult({ eventsDelivered: true }), extended, {
      isResume: false,
      hasSessionStore: false,
      now: 1,
    });
    assert.equal(
      delivered.pendingEvents,
      undefined,
      '注入过 ⇒ 事件已在挂起历史里，簿记留着会重复注入',
    );

    const notDelivered = mkRec({ pendingEvents: [taskEvent('外部事件')] });
    applySuspendedOutcome(notDelivered, mkResult({ eventsDelivered: false }), extended, {
      isResume: false,
      hasSessionStore: false,
      now: 1,
    });
    assert.notEqual(
      notDelivered.pendingEvents,
      undefined,
      '没注入 ⇒ 必须留住（清掉就是丢事件）—— 这条与终态分支的无条件清是**刻意不同**的',
    );
  });
});

describe('applyTerminalOutcome —— 终态出口的记录映射', () => {
  const settled = (status: 'succeeded' | 'failed'): RunSettled => ({
    run: { runId: 'r1', status },
    result: mkResult(),
  });

  it('人取消：状态落 cancelled，且**补上**结构化原因（结果里 error 为空时）', () => {
    const rec = mkRec({ status: 'running' });
    applyTerminalOutcome(rec, settled('succeeded'), { cancelled: true, isResume: false });
    assert.equal(rec.status, 'cancelled', '取消的机制是超时那条 signal，差别只在意图');
    assert.notEqual(
      rec.error,
      undefined,
      '宿主自定义 AppCallable 不认 signal 时 result.error 是空的 ⇒ 记录里也得说清「这条被取消了」',
    );
  });

  it('人取消但有现成的 error：**不覆盖**（意图赢不等于改写已有的账）', () => {
    const existing = { type: 'provider', message: '既有原因', retryable: true };
    const rec = mkRec({ error: existing });
    applyTerminalOutcome(rec, settled('failed'), { cancelled: true, isResume: false });
    assert.equal(rec.error, existing);
  });

  it('非取消：状态取**引擎的** run.status（用 failed 试，别只用 succeeded）', () => {
    const rec = mkRec();
    applyTerminalOutcome(rec, settled('failed'), { cancelled: false, isResume: false });
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error, undefined, '这条路径不补原因 —— error 由调用点从 result.error 落好');
  });

  it('终态清挂起痕迹：五个字段全清，且事件簿记**无条件**清（与挂起分支刻意不同）', () => {
    const rec = mkRec({
      status: 'suspended',
      pendingApprovals: ['toolu_1'],
      suspendedSince: 100,
      suspendedReason: 'approval',
      wakeAt: 200,
      pendingEvents: [taskEvent('e')],
    });
    applyTerminalOutcome(rec, settled('failed'), { cancelled: false, isResume: false });
    assert.equal(rec.pendingApprovals, undefined);
    assert.equal(rec.suspendedSince, undefined);
    assert.equal(rec.suspendedReason, undefined);
    assert.equal(rec.wakeAt, undefined);
    assert.equal(
      rec.pendingEvents,
      undefined,
      '终态没有第二次机会：事件不跨终态重放 ⇒ 无条件清（挂起分支才按 eventsDelivered 分档）',
    );
  });

  it('返回值=是否补写会话：三个组合逐条断（isResume × run.status）', () => {
    const a = mkRec();
    assert.equal(
      applyTerminalOutcome(a, settled('succeeded'), { cancelled: false, isResume: true }),
      true,
      '恢复段跑成 ⇒ 本段没把 session 交给 run 层，宿主必须补写会话历史',
    );
    const b = mkRec();
    assert.equal(
      applyTerminalOutcome(b, settled('succeeded'), { cancelled: false, isResume: false }),
      false,
      '首段由 run 层自己 appendSession，宿主不能再写一遍（历史会翻倍）',
    );
    const c = mkRec();
    assert.equal(
      applyTerminalOutcome(c, settled('failed'), { cancelled: false, isResume: true }),
      false,
      '恢复段但没跑成 ⇒ 没有「这一轮回答」可写',
    );
  });
});
