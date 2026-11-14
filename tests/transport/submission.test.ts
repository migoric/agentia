import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { AsyncRunner } from '../../src/index.js';
import type { AgentRunResult, AppCallable, TaskRecord, TaskStore } from '../../src/index.js';
import { cloneTaskRecord } from '../../src/store/store.js';
import { formatOwnerId } from '../../src/transport/owner-id.js';
import { waitFor } from '../helpers.js';

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 单 JS 线程里的原子能力模型；闸门保证两个 runner 都已拿到旧快照。 */
class AtomicStore implements TaskStore {
  protected readonly byTask = new Map<string, TaskRecord>();
  private claimBarrier: { need: number; seen: number; gate: Promise<void> } | undefined;
  private listBarrier: { need: number; seen: number; gate: Promise<void> } | undefined;

  /** 模拟真库的一次写入往返（PG / Redis 的 save 都不是同步完成的） */
  saveDelayMs = 0;
  async save(rec: TaskRecord): Promise<void> {
    if (this.saveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.saveDelayMs));
    this.byTask.set(rec.taskId, cloneTaskRecord(rec));
  }
  async get(taskId: string): Promise<TaskRecord | undefined> {
    const rec = this.byTask.get(taskId);
    return rec ? cloneTaskRecord(rec) : undefined;
  }
  async byIdempotency(key: string): Promise<TaskRecord | undefined> {
    const rec = [...this.byTask.values()].filter((r) => r.idempotencyKey === key).at(-1);
    return rec ? cloneTaskRecord(rec) : undefined;
  }
  async list(): Promise<TaskRecord[]> {
    const snapshot = [...this.byTask.values()].map(cloneTaskRecord);
    if (this.listBarrier && ++this.listBarrier.seen === this.listBarrier.need) {
      this.listBarrier = undefined;
      this.releaseLists();
    }
    const gate = this.listBarrier?.gate;
    if (gate) await gate;
    return snapshot;
  }
  async clear(): Promise<void> {
    this.byTask.clear();
  }
  async claimSubmission(rec: TaskRecord): Promise<boolean> {
    const currentBarrier = this.claimBarrier;
    if (currentBarrier && ++currentBarrier.seen === currentBarrier.need) {
      this.claimBarrier = undefined;
      this.releaseClaims();
    }
    if (currentBarrier) await currentBarrier.gate;
    const old = this.byTask.get(rec.taskId);
    if (old && old.idempotencyKey !== rec.idempotencyKey) return false;
    if (old && old.status !== 'failed' && old.status !== 'cancelled') return false;
    this.byTask.set(rec.taskId, cloneTaskRecord(rec));
    return true;
  }
  async compareAndSave(rec: TaskRecord, expected: TaskRecord): Promise<boolean> {
    const current = this.byTask.get(rec.taskId);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
    this.byTask.set(rec.taskId, cloneTaskRecord(rec));
    return true;
  }
  seed(rec: TaskRecord): void {
    this.byTask.set(rec.taskId, cloneTaskRecord(rec));
  }
  /** 模拟 TTL / prune 把记录回收掉（跟随者据此必须放手，否则永远等不到终态） */
  remove(taskId: string): void {
    this.byTask.delete(taskId);
  }
  armClaims(need: number, gate: Promise<void>): void {
    this.claimBarrier = { need, seen: 0, gate };
  }
  armLists(need: number, gate: Promise<void>): void {
    this.listBarrier = { need, seen: 0, gate };
  }
  releaseClaims(): void {}
  releaseLists(): void {}
}

/** 用外部释放函数连接类里的闸门，避免把 Promise 执行器散进每个用例。 */
class GatedAtomicStore extends AtomicStore {
  claims = deferred();
  lists = deferred();
  override releaseClaims(): void {
    this.claims.release();
  }
  override releaseLists(): void {
    this.lists.release();
  }
}

function countingApp(calls: { n: number }, gate?: Promise<void>): AppCallable {
  return {
    name: 'atomic-test',
    async run() {
      calls.n++;
      await gate;
      return {
        run: { runId: `run_${calls.n}`, status: 'succeeded' as const },
        result: { finalText: `ok_${calls.n}` } as AgentRunResult,
      };
    },
  };
}

function orphan(taskId = 'task_orphan', idempotencyKey?: string): TaskRecord {
  return {
    taskId,
    status: 'running',
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ownerId: 'previous-process@another-host',
    spec: { messages: [{ role: 'user', content: 'recover' }] },
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 60_000,
  };
}

describe('原子提交能力：跨 runner 的同键首次提交', () => {
  it('同一主键只有一个认领者执行；另一边得到同一结果且不重复发 sink', async () => {
    const store = new GatedAtomicStore();
    store.armClaims(2, store.claims.promise);
    const runGate = deferred();
    const calls = { n: 0 };
    let sinkCalls = 0;
    const sink = {
      onFinished: () => {
        sinkCalls++;
      },
    };
    const a = new AsyncRunner(countingApp(calls, runGate.promise), {
      store,
      taskSinks: [sink],
    });
    const b = new AsyncRunner(countingApp(calls, runGate.promise), {
      store,
      taskSinks: [sink],
    });

    const first = a.submit('same', { idempotencyKey: 'same-key' });
    const second = b.submit('same', { idempotencyKey: 'same-key' });
    assert.equal(first.taskId, second.taskId, '确定性 taskId 才能让两个进程争同一主键');
    await waitFor(() => calls.n === 1, '唯一认领者应已开跑');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.n, 1, '输掉认领的执行趟不得进入 app.run');
    runGate.release();

    const [left, right] = await Promise.all([
      a.awaitTask(first.taskId, { intervalMs: 5 }),
      b.awaitTask(second.taskId, { intervalMs: 5 }),
    ]);
    assert.equal(left.status, 'succeeded');
    assert.equal(right.status, 'succeeded');
    assert.equal(right.runId, left.runId);
    assert.equal(sinkCalls, 1, '观察者不是完成者，不得重复发 TaskSink');
    assert.equal(await a.drain({ timeoutMs: 1_000 }), true);
    assert.equal(await b.drain({ timeoutMs: 1_000 }), true);
  });

  it('失败后的同键重试复用确定性 taskId，但确实再执行一次', async () => {
    const store = new AtomicStore();
    let calls = 0;
    const app: AppCallable = {
      name: 'retry',
      async run() {
        calls++;
        if (calls === 1) throw new Error('first failed');
        return {
          run: { runId: 'run_retry', status: 'succeeded' as const },
          result: { finalText: 'retried' } as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, { store });
    const first = runner.submit('x', { idempotencyKey: 'retry-key' });
    assert.equal((await runner.awaitTask(first.taskId)).status, 'failed');
    const second = runner.submit('x', { idempotencyKey: 'retry-key' });
    assert.equal(second.taskId, first.taskId);
    const settled = await runner.awaitTask(second.taskId);
    assert.equal(settled.status, 'succeeded');
    assert.equal(settled.result?.finalText, 'retried');
    assert.equal(calls, 2);
  });

  it('升级前的随机 taskId 活跃记录：跟随终态并映射回本次提交，不再执行', async () => {
    const store = new AtomicStore();
    store.seed(orphan('task_legacy_random', 'legacy-key'));
    const calls = { n: 0 };
    let sinkCalls = 0;
    const runner = new AsyncRunner(countingApp(calls), {
      store,
      taskSinks: [
        {
          onFinished: () => {
            sinkCalls++;
          },
        },
      ],
    });
    const submitted = runner.submit('new request', { idempotencyKey: 'legacy-key' });
    assert.notEqual(submitted.taskId, 'task_legacy_random');
    const waiting = runner.awaitTask(submitted.taskId, { intervalMs: 5, timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const old = await store.get('task_legacy_random');
    await store.save({
      ...old!,
      status: 'succeeded',
      runId: 'run_legacy',
      result: { finalText: 'from old owner' } as AgentRunResult,
      finishedAt: Date.now(),
    });
    const settled = await waiting;
    assert.equal(settled.status, 'succeeded');
    assert.equal(settled.runId, 'run_legacy');
    assert.equal(settled.result?.finalText, 'from old owner');
    assert.equal(calls.n, 0);
    assert.equal(sinkCalls, 0);
    assert.equal((await store.get(submitted.taskId))?.runId, 'run_legacy');
    assert.equal(await runner.drain({ timeoutMs: 1_000 }), true);
  });

  it('claim 已提交但客户端收到错误：只用 CAS 纠正自己的 queued，不启动 app', async () => {
    class CommittedThenThrowStore extends AtomicStore {
      override async claimSubmission(rec: TaskRecord): Promise<boolean> {
        await super.claimSubmission(rec);
        throw new Error('response lost');
      }
    }
    const store = new CommittedThenThrowStore();
    const calls = { n: 0 };
    const reported: unknown[] = [];
    const runner = new AsyncRunner(countingApp(calls), {
      store,
      onPersistError: (info) => reported.push(info),
    });
    const submitted = runner.submit('x', { idempotencyKey: 'lost-response' });
    const settled = await runner.awaitTask(submitted.taskId);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error?.message ?? '', /response lost/);
    assert.equal((await store.get(submitted.taskId))?.status, 'failed');
    assert.equal(calls.n, 0);
    assert.equal(reported.length, 1);
  });

  it('claim 报错且库里已是另一认领者：不得用 failed 覆盖它', async () => {
    class OtherOwnerThenThrowStore extends AtomicStore {
      override async claimSubmission(rec: TaskRecord): Promise<boolean> {
        this.seed({ ...rec, status: 'running', ownerId: 'other-owner', runId: undefined });
        throw new Error('ambiguous transport error');
      }
    }
    const store = new OtherOwnerThenThrowStore();
    const calls = { n: 0 };
    let sinkCalls = 0;
    const runner = new AsyncRunner(countingApp(calls), {
      store,
      taskSinks: [
        {
          onFinished: () => {
            sinkCalls++;
          },
        },
      ],
    });
    const submitted = runner.submit('x', { idempotencyKey: 'other-owner' });
    const waiting = runner.awaitTask(submitted.taskId, { intervalMs: 5, timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const active = await store.get(submitted.taskId);
    assert.equal(active?.status, 'running', '歧义错误不得覆盖另一认领者的 running');
    await store.save({
      ...active!,
      status: 'succeeded',
      runId: 'run_other',
      result: { finalText: 'other result' } as AgentRunResult,
      finishedAt: Date.now(),
    });
    const settled = await waiting;
    assert.equal(settled.status, 'succeeded');
    assert.equal(settled.runId, 'run_other');
    assert.equal(calls.n, 0);
    assert.equal(sinkCalls, 0);
  });

  it('claim 失败且数据库没有记录：本地响亮失败，不伪造已落库', async () => {
    class ThrowStore extends AtomicStore {
      override async claimSubmission(): Promise<boolean> {
        throw new Error('database unavailable');
      }
    }
    const store = new ThrowStore();
    const calls = { n: 0 };
    const runner = new AsyncRunner(countingApp(calls), { store });
    const submitted = runner.submit('x', { idempotencyKey: 'no-row' });
    const settled = await runner.awaitTask(submitted.taskId);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error?.message ?? '', /database unavailable/);
    assert.equal(await store.get(submitted.taskId), undefined);
    assert.equal(calls.n, 0);
  });
});

describe('跟随他进程认领：主人已死时有界退出（不按时间猜）', () => {
  /** 一条「别人在跑」的记录：同键、不同 taskId（升级前的随机 id 形态） */
  function ownedBy(taskId: string, key: string, ownerId: string): TaskRecord {
    return {
      taskId,
      status: 'running',
      idempotencyKey: key,
      ownerId,
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 1_000,
    };
  }

  it('认领者进程明确已死：放弃跟随，本趟退出且一个字节都不改别人的记录', async () => {
    // 真 pid + 同主机：`spawnSync` 返回时那个进程已被收尸 ⇒ 探针必然 ESRCH
    const deadPid = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 }).pid;
    assert.ok(typeof deadPid === 'number' && deadPid > 0, '拿不到已死进程的 pid，用例无法成立');
    const store = new AtomicStore();
    store.seed(
      ownedBy('task_dead_owner', 'dead-key', formatOwnerId(deadPid, hostname(), 'deadbeef')),
    );
    const calls = { n: 0 };
    let sinkCalls = 0;
    const runner = new AsyncRunner(countingApp(calls), {
      store,
      taskSinks: [
        {
          onFinished: () => {
            sinkCalls++;
          },
        },
      ],
    });

    const submitted = runner.submit('x', { idempotencyKey: 'dead-key' });
    await waitFor(
      () => runner.inFlight === 0,
      '主人已死 ⇒ 跟随必须退出（否则 active 永占、drain 永不结算）',
    );
    assert.equal(
      (await store.get('task_dead_owner'))?.status,
      'running',
      '别人的记录一个字节都不该改',
    );
    assert.equal(await store.get(submitted.taskId), undefined, '本进程不得伪造一条已落库的记录');
    assert.equal(calls.n, 0, '跟随趟不得进入 app.run');
    assert.equal(sinkCalls, 0, '观察者不发 TaskSink');
    assert.equal(await runner.drain({ timeoutMs: 1_000 }), true);
  });

  it('主人还活着（同主机、pid 在）：继续跟随到终态，不误判放弃', async () => {
    const store = new AtomicStore();
    store.seed(
      ownedBy('task_live_owner', 'live-key', formatOwnerId(process.pid, hostname(), 'cafebabe')),
    );
    const calls = { n: 0 };
    let sinkCalls = 0;
    const runner = new AsyncRunner(countingApp(calls), {
      store,
      taskSinks: [
        {
          onFinished: () => {
            sinkCalls++;
          },
        },
      ],
    });
    const submitted = runner.submit('x', { idempotencyKey: 'live-key' });
    // 跨过至少一轮判据（跟随循环的 250ms 兜底间隔）后仍在跟随
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(runner.inFlight > 0, '主人在时不得放弃跟随（那会把正常任务变成一次假的 404）');

    const live = await store.get('task_live_owner');
    await store.save({
      ...live!,
      status: 'succeeded',
      runId: 'run_live',
      result: { finalText: 'from live owner' } as AgentRunResult,
      finishedAt: Date.now(),
    });
    await waitFor(() => runner.inFlight === 0, '终态后跟随应自行收口');
    const mapped = await store.get(submitted.taskId);
    assert.equal(mapped?.status, 'succeeded', '升级前的随机 id 要映射回本次提交');
    assert.equal(mapped?.runId, 'run_live');
    assert.equal(calls.n, 0);
    assert.equal(sinkCalls, 0);
    assert.equal(await runner.drain({ timeoutMs: 1_000 }), true);
  });

  it('目标记录被 TTL / prune 回收：容忍几次抖动后放弃，不永远等一条不存在的记录', async () => {
    const store = new AtomicStore();
    store.seed(
      ownedBy('task_doomed', 'doomed-key', formatOwnerId(process.pid, hostname(), '0123abcd')),
    );
    const calls = { n: 0 };
    const runner = new AsyncRunner(countingApp(calls), { store });
    runner.submit('x', { idempotencyKey: 'doomed-key' });
    await waitFor(() => runner.inFlight > 0, '先进入跟随');
    store.remove('task_doomed');
    await waitFor(() => runner.inFlight === 0, '记录确认不存在后，跟随趟必须退出（约 3 次抖动）');
    assert.equal(calls.n, 0);
    assert.equal(await store.get('task_doomed'), undefined);
    assert.equal(await runner.drain({ timeoutMs: 1_000 }), true);
  });
});

describe('恢复快照 CAS：两个 runner 同时读到同一孤儿', () => {
  it('只有一个 compareAndSave 成功并派发；返回值与 sink 都只对账一次', async () => {
    const store = new GatedAtomicStore();
    store.seed(orphan());
    store.armLists(2, store.lists.promise);
    const runGate = deferred();
    const calls = { n: 0 };
    let sinkCalls = 0;
    const sink = {
      onFinished: () => {
        sinkCalls++;
      },
    };
    const a = new AsyncRunner(countingApp(calls, runGate.promise), {
      store,
      taskSinks: [sink],
    });
    const b = new AsyncRunner(countingApp(calls, runGate.promise), {
      store,
      taskSinks: [sink],
    });
    const [ra, rb] = await Promise.all([a.resumePending(), b.resumePending()]);
    assert.deepEqual([ra, rb].sort(), [0, 1], 'CAS 失败者必须报告 0，不得派发');
    await waitFor(() => calls.n === 1, '唯一恢复者应已开跑');
    runGate.release();
    const [left, right] = await Promise.all([
      a.awaitTask('task_orphan', { intervalMs: 5 }),
      b.awaitTask('task_orphan', { intervalMs: 5 }),
    ]);
    assert.equal(left.runId, right.runId);
    assert.equal(calls.n, 1);
    assert.equal(sinkCalls, 1);
    assert.equal(await a.drain({ timeoutMs: 1_000 }), true);
    assert.equal(await b.drain({ timeoutMs: 1_000 }), true);
  });
});

describe('异步 store 的首次落库窗口：submit 全同步、save 不 await', () => {
  it('首存永不落地时按 deadline 报超时，不得永久挂起', async () => {
    const store = new AtomicStore();
    // 连接池耗尽 / 网络黑洞的形态：promise 永远不 settle
    store.save = () => new Promise<void>(() => {});
    const runner = new AsyncRunner(countingApp({ n: 0 }), { store });
    const rec = runner.submit('你好');
    await assert.rejects(
      () => runner.awaitTask(rec.taskId, { intervalMs: 5, timeoutMs: 100 }),
      /等待超时（首次落库未完成）/,
    );
    await runner.drain({ timeoutMs: 200 });
  });

  it('save 有真库量级延迟时，submit 之后立刻 awaitTask 仍能等到终态', async () => {
    const store = new AtomicStore();
    store.saveDelayMs = 20; // 一次网络往返的量级；不修的话这里必然读到「task 不存在」
    const calls = { n: 0 };
    const runner = new AsyncRunner(countingApp(calls), { store });
    const rec = runner.submit('你好');
    const done = await runner.awaitTask(rec.taskId, { intervalMs: 5, timeoutMs: 2_000 });
    assert.equal(done.status, 'succeeded');
    assert.equal(calls.n, 1);
    assert.equal(await runner.drain({ timeoutMs: 1_000 }), true);
  });
});
