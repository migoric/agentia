import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncRunner, InMemoryTaskStore } from '../../src/index.js';
import { FileTaskStore, InMemorySessionStore, executeRun } from '../../src/index.js';
import type { AppCallable, RunInvocationOptions } from '../../src/index.js';
import type { AgentRunResult, AgentTool, MessageParam } from '../../src/index.js';
import type { TaskRecord, TaskStore } from '../../src/index.js';
import type { PersistFailureInfo } from '../../src/index.js';
import { TaskInputError } from '../../src/engine/spec.js';
import { MAX_TIMER_DELAY_MS } from '../../src/core/timeout.js';
import { formatOwnerId, parseOwnerId } from '../../src/transport/owner-id.js';
import { mockClient, toolUseMsg, endTurnMsg, waitFor } from '../helpers.js';

/** 模拟 fsStore/sqliteStore 这类**同步** store：终态落库时同步抛错（磁盘满、库锁） */
class SyncThrowOnTerminalStore extends InMemoryTaskStore {
  override save(rec: TaskRecord): void {
    if (rec.status === 'succeeded') throw new Error('disk full');
    super.save(rec);
  }
}

/**
 * 模拟 sqlite/redisStore 这类**异步** store：方法返回 Promise，且 `list()` 交出的
 * 是**反序列化后的新对象**（改它不入库）。这正是 `#redispatch` 那个重复执行窗口的
 * 必要条件 —— 当年 `InMemoryTaskStore` 存对象引用恰好把问题掩盖了
 * （2026-10-13 ref-taskstore-copy-contract 起内建 store 也全部走副本，这个夹具仍管「异步」那一半）。
 */
class AsyncCopyStore implements TaskStore {
  readonly #byTask = new Map<string, TaskRecord>();
  readonly #byKey = new Map<string, string>();

  async save(rec: TaskRecord): Promise<void> {
    this.#byTask.set(rec.taskId, { ...rec });
    if (rec.idempotencyKey) this.#byKey.set(rec.idempotencyKey, rec.taskId);
  }
  async get(taskId: string): Promise<TaskRecord | undefined> {
    const r = this.#byTask.get(taskId);
    return r ? { ...r } : undefined;
  }
  async byIdempotency(key: string): Promise<TaskRecord | undefined> {
    const id = this.#byKey.get(key);
    return id ? this.get(id) : undefined;
  }
  async list(): Promise<TaskRecord[]> {
    return [...this.#byTask.values()].map((r) => ({ ...r }));
  }
  async clear(): Promise<void> {
    this.#byTask.clear();
    this.#byKey.clear();
  }
  /** 测试用：直接塞一条初始记录（不走 save） */
  seed(rec: TaskRecord): void {
    this.#byTask.set(rec.taskId, { ...rec });
  }
}

function fakeApp(fn?: () => Promise<void>): AppCallable & { calls: number } {
  const app = {
    name: 'fake',
    calls: 0,
    async run() {
      app.calls++;
      await fn?.();
      return {
        run: { runId: `r-${app.calls}`, status: 'succeeded' as const },
        result: {} as AgentRunResult,
      };
    },
  };
  return app;
}

/**
 * 异步 store 下 `poll` 返回 Promise，而 `waitFor` 只吃同步谓词 —— 这里是它的 await 版。
 * 超时自陈实测状态（照 waitFor 的三条约定）。
 */
async function waitStatus(
  runner: AsyncRunner,
  taskId: string,
  want: TaskRecord['status'],
  budgetMs = 10_000,
): Promise<TaskRecord> {
  const t0 = Date.now();
  for (;;) {
    const rec = await runner.poll(taskId);
    if (rec?.status === want) return rec;
    const elapsed = Date.now() - t0;
    if (elapsed >= budgetMs) {
      throw new Error(
        `waitStatus 超时：等了 ${elapsed}ms，${taskId} 仍是 ${rec?.status}（想要 ${want}）`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('AsyncRunner', () => {
  it('幂等键去重：未失败的同键返回既有记录，失败的同键可重提', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const t1 = runner.submit('a', { idempotencyKey: 'k' });
    await runner.awaitTask(t1.taskId);
    const t2 = runner.submit('a', { idempotencyKey: 'k' }); // succeeded → 去重
    assert.equal(t2.taskId, t1.taskId);
    assert.equal(app.calls, 1);

    // failed → 允许新任务
    const failApp: AppCallable = {
      name: 'f',
      run: async () => ({
        run: { runId: 'x', status: 'failed' as const },
        result: { error: { type: 'api', message: 'm', retryable: false } } as AgentRunResult,
      }),
    };
    const r2 = new AsyncRunner(failApp);
    const f1 = r2.submit('a', { idempotencyKey: 'k' });
    await r2.awaitTask(f1.taskId);
    assert.equal((await r2.poll(f1.taskId))?.status, 'failed');
    const f2 = r2.submit('a', { idempotencyKey: 'k' });
    assert.notEqual(f2.taskId, f1.taskId);
  });

  it('幂等键去重（异步 store）：同键在飞时并发提交只执行一次', async () => {
    // 重现 2026-09-21 外部复核 P1：`submit` 是**同步门面**，无法 await 异步 store 的
    // `byIdempotency`；而 `#executeInner` 只采纳已 succeeded 的既有记录 ⇒ 「同时提交两个
    // 同键任务」两次都执行（实测 app.run 调了 2 次）。修复=在 `#execute` 的同步前段认领。
    const store = new AsyncCopyStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp(() => gate);
    const runner = new AsyncRunner(app, { store });

    const t1 = runner.submit('a', { idempotencyKey: 'k' });
    const t2 = runner.submit('a', { idempotencyKey: 'k' }); // 前一个还在飞
    assert.equal(t2.taskId, t1.taskId, '同键在飞时必须返回同一条记录，不得另起任务');

    release();
    await runner.awaitTask(t1.taskId);
    await runner.awaitTask(t2.taskId); // 认领返回的既然是同一任务，也必须能等到它的终态
    assert.equal(app.calls, 1, '同键并发提交只准执行一次');
    assert.equal((await store.list()).length, 1, 'store 里只应有一条同键记录');
  });

  it('幂等键去重（异步 store）：恢复派发的同键任务达终态后释放认领', async () => {
    // 走「他进程留下的 running 记录 → 本进程 resumePending 认领执行」这条续跑路径：
    // 认领在**第一次** #execute 里建立，终态必须把它释放，否则该键被永久钉死。
    const store = new AsyncCopyStore();
    const app = fakeApp();
    const runner = new AsyncRunner(app, { store });
    store.seed({
      taskId: 'task_stale',
      status: 'running', // 他进程死在半路
      idempotencyKey: 'k',
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: Date.now(),
      ownerId: 'p999-otherproc',
    });
    assert.equal(await runner.resumePending(), 1);
    await runner.awaitTask('task_stale');
    assert.equal(app.calls, 1, '续跑执行一次');

    const t2 = runner.submit('a', { idempotencyKey: 'k' });
    assert.notEqual(t2.taskId, 'task_stale', '终态后认领必须已释放，不得命中老记录');
    await runner.awaitTask(t2.taskId);
    assert.equal((await runner.poll(t2.taskId))?.status, 'succeeded');
    // 异步 store 的 idem 索引是 **last-wins**（redisStore / fsStore / sqliteStore 头注释同口径），
    // 而 submit 的同步快路走不了 thenable ⇒ 终态后重提同键按设计就是**新任务、真执行**。
    // 这里把它钉住：这是「同进程并发」之外的 at-least-once 边界（usage-guide §7 已写明）。
    assert.equal(app.calls, 2, '终态后重提同键在异步 store 下会真执行（at-least-once 边界）');
  });

  it('幂等键去重（异步 store）：HITL 挂起恢复后再提同键不得命中老记录', async () => {
    // **认领释放的承重用例**：挂起时认领**不释放**（等人工≠终态），而恢复段是
    // approve 重新从 store 读出**另一个对象**后再进 #execute —— 那次 `claimed` 必为 false。
    // 释放判据若只看 `claimed`（或比对象同一性），这个键就永久留在认领表里：
    // 挂起过的同键从此只能拿回那条老记录、再也不执行（认领表泄漏 + 同键静默失效）。
    const { client } = mockClient([
      toolUseMsg('danger', {}, 'tu1'),
      endTurnMsg('第一次'),
      endTurnMsg('第二次'),
    ]);
    const OBJ = { type: 'object', properties: {} } as const;
    const tools: AgentTool[] = [
      {
        name: 'danger',
        description: '危险操作',
        inputSchema: OBJ,
        approval: 'required',
        run: () => 'done',
      },
    ];
    let calls = 0;
    const app: AppCallable = {
      name: 'hitl-idem',
      run: (messages, opts) => {
        calls++;
        return executeRun({ messages, client, tools, ...opts });
      },
    };
    const store = new AsyncCopyStore();
    const runner = new AsyncRunner(app, { store });

    const t = runner.submit('x', { idempotencyKey: 'k' });
    await waitStatus(runner, t.taskId, 'suspended');
    await runner.approve(t.taskId, { tu1: { approved: true } });
    assert.equal((await runner.awaitTask(t.taskId)).status, 'succeeded');

    const before = calls; // 挂起段 + 恢复段各一次 app.run（HITL 恢复是重跑）
    const t2 = runner.submit('x', { idempotencyKey: 'k' });
    assert.notEqual(t2.taskId, t.taskId, '挂起过的同键在终态后必须已释放认领');
    await runner.awaitTask(t2.taskId);
    assert.equal(calls - before, 1, '第二个任务必须真跑一次（老记录被永久命中的话这里是 0）');
  });

  it('concurrency=1：第二个任务在槽位释放前保持 queued；submit 返回快照不被原地改', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp(() => gate);
    const runner = new AsyncRunner(app, { concurrency: 1 });
    const t1 = runner.submit('a');
    const t2 = runner.submit('b');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(app.calls, 1);
    assert.equal((await runner.poll(t2.taskId))?.status, 'queued');
    assert.equal(t1.status, 'queued', 'submit 返回的是提交时刻快照');
    release();
    await runner.awaitTask(t1.taskId);
    await runner.awaitTask(t2.taskId);
    assert.equal(app.calls, 2);
  });

  it('同步 store 落库抛错：不逃逸成 unhandled rejection，槽位照常释放', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const store = new SyncThrowOnTerminalStore();
      const app = fakeApp();
      const runner = new AsyncRunner(app, { store, concurrency: 1 });
      runner.submit('a');
      runner.submit('b');
      await waitFor(() => app.calls === 2, '落库抛错后槽位必须仍被释放（第二条也跑得到）');
      await new Promise((r) => setTimeout(r, 20)); // 给潜在的 unhandled rejection 落地机会
      assert.deepEqual(rejections, []);
      // 副本契约（2026-10-13 ref-taskstore-copy-contract）坐实后，终态 save 抛错 ⇒ 内存**不再**被原地推进：
      // 库里诚实地停在 running（最后一次落库成功的状态）—— 这正是 onPersistError
      // 要对账的那一格，不再被引用语义遮掉。
      const left = (store.list() as TaskRecord[]).map((r) => r.status);
      assert.ok(
        left.every((s) => s === 'running'),
        `终态没落库 ⇒ 两条都停在 running，实际 ${left}`,
      );
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('非法 concurrency 抛错', () => {
    assert.throws(() => new AsyncRunner(fakeApp(), { concurrency: 0 }), /concurrency/);
  });

  /**
   * 耐久 store 的**异步 + 可控失败**形态（每次交出浅副本、save 可按谓词抖动）。
   *
   * 为什么必须要它：此前 `InMemoryTaskStore` 存**对象引用**，runner 就地改写 `rec` ⇒ 即便
   * `save` 抛错，库里那条也已经是终态 —— 「终态落库失败」当时根本看不见。
   * 2026-10-13 ref-taskstore-copy-contract 起内建 store 全部坐实副本契约（`cloneTaskRecord`），这个测试夹具
   * 仍在的理由是另两样：**异步**（Promise 分支）与**按谓词失败**（jitter 注入）。
   */
  class CopyStoreOnSave implements TaskStore {
    readonly #byTask = new Map<string, TaskRecord>();
    readonly #byKey = new Map<string, string>();
    #failLeft: number;
    constructor(
      private readonly failWhen: (r: TaskRecord) => boolean,
      failTimes = Number.POSITIVE_INFINITY,
    ) {
      this.#failLeft = failTimes;
    }
    async save(rec: TaskRecord): Promise<void> {
      if (this.#failLeft > 0 && this.failWhen(rec)) {
        this.#failLeft -= 1;
        throw new Error('store jitter');
      }
      this.#byTask.set(rec.taskId, { ...rec });
      if (rec.idempotencyKey) this.#byKey.set(rec.idempotencyKey, rec.taskId);
    }
    async get(taskId: string): Promise<TaskRecord | undefined> {
      const r = this.#byTask.get(taskId);
      return r ? { ...r } : undefined;
    }
    async byIdempotency(key: string): Promise<TaskRecord | undefined> {
      const id = this.#byKey.get(key);
      return id ? this.get(id) : undefined;
    }
    async list(): Promise<TaskRecord[]> {
      return [...this.#byTask.values()].map((r) => ({ ...r }));
    }
    async clear(): Promise<void> {
      this.#byTask.clear();
      this.#byKey.clear();
    }
  }

  it('终态落库失败：onPersistError 必须收到（不再静默），且库里确实停在 running', async () => {
    const seen: PersistFailureInfo[] = [];
    let resolveFirst: ((i: PersistFailureInfo) => void) | undefined;
    const first = new Promise<PersistFailureInfo>((res) => {
      resolveFirst = res;
    });
    const store = new CopyStoreOnSave((r) => r.status === 'succeeded');
    const runner = new AsyncRunner(fakeApp(), {
      store,
      onPersistError: (info) => {
        seen.push(info);
        resolveFirst?.(info);
      },
    });

    const t = runner.submit('a');
    // 不靠 awaitTask：store 永远到不了终态，那条路只会等到超时 —— 等回调本身
    const info = await Promise.race([
      first,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('等 onPersistError 超时')), 3_000),
      ),
    ]);

    assert.equal(info.phase, 'outcome', `应是终态那次写出失败，实际 ${info.phase}`);
    assert.equal(info.record.taskId, t.taskId);
    assert.match(String((info.error as Error).message), /store jitter/);
    assert.equal(seen.length, 1, '应恰好报一次（终态那次）');
    // ⚠️ 全部危险都在这条：耐久 store 里它是 running ⇒ 重启后 resumePending 会当孤儿**重跑**，
    // 而这次 run 其实已经跑完（副作用已发生）。旧用例看不见这一层（InMemory 存引用）。
    assert.equal(
      (await store.get(t.taskId))?.status,
      'running',
      '终态写出失败 ⇒ 库里停在 running（这就是「重启会重跑」的前提）',
    );
  });

  it('onPersistError 收到的是快照：回调改写它不得串进库里的记录（与 notifySinks 同纪律）', async () => {
    // 反向验证：#safeSave 改回传活引用 `rec` ⇒ 下面的改写直接落进回调持有者与
    // 「库里的记录」之间任一共享处，断言立刻红。
    const store = new SyncThrowOnTerminalStore(); // 终态 save 抛错
    const seen: PersistFailureInfo[] = [];
    const runner = new AsyncRunner(fakeApp(), {
      store,
      onPersistError: (info) => {
        seen.push(info);
        // 恶意/手滑的回调：改写自己拿到的 record —— 快照语义下这不该有任何外部影响
        info.record.status = 'queued';
      },
    });
    const t = runner.submit('a');
    await waitFor(() => seen.length > 0, 'onPersistError 应被调到');

    assert.equal(
      store.get(t.taskId)?.status,
      'running',
      '终态那次 save 抛了 ⇒ 库里停在最后一次落库成功的状态（副本契约 2026-10-13 ref-taskstore-copy-contract：' +
        '既不被回调的改写污染，也不再被 runner 的活引用原地推进）',
    );
    assert.equal(seen[0]!.phase, 'outcome');
  });

  it('onPersistError 自己抛错不得影响 run（槽位照常释放、不逃逸成 unhandled rejection）', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const store = new CopyStoreOnSave((r) => r.status === 'succeeded');
      let calls = 0;
      const runner = new AsyncRunner(fakeApp(), {
        store,
        concurrency: 1,
        onPersistError: () => {
          calls += 1;
          throw new Error('宿主自己的回调炸了');
        },
      });
      const t1 = runner.submit('a');
      const t2 = runner.submit('b'); // 槽位泄漏时这个永远排不上
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(calls >= 1, '回调应被调用到（否则这条用例什么都没测）');
      assert.equal(
        (await store.get(t2.taskId))?.status,
        'running',
        '第二个任务仍应拿到槽位并跑到 running',
      );
      assert.notEqual(t1.taskId, t2.taskId);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(rejections, [], '回调抛错不得变成 unhandled rejection');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('awaitTask 超时抛错', async () => {
    let never!: () => void;
    const gate = new Promise<void>(() => {
      never = () => {};
    });
    const app = fakeApp(() => gate);
    const runner = new AsyncRunner(app);
    const t = runner.submit('a');
    await assert.rejects(runner.awaitTask(t.taskId, { timeoutMs: 50 }), /等待超时/);
    void never;
  });

  it('awaitTask 靠事件唤醒：兜底轮询间隔拉大到 10s 也能在任务完成时立刻返回', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = new AsyncRunner(fakeApp(() => gate));
    const t = runner.submit('a');
    await new Promise((r) => setTimeout(r, 30)); // 先确保任务已在跑、尚未终态

    const t0 = Date.now();
    const waiting = runner.awaitTask(t.taskId, { timeoutMs: 5_000, intervalMs: 10_000 });
    setTimeout(release, 20); // 20ms 后放行
    const rec = await waiting;

    assert.equal(rec.status, 'succeeded');
    const waited = Date.now() - t0;
    // 旧实现按 intervalMs 轮询 → 这里会一直等到 5s 超时抛错；事件唤醒则 ~20ms 返回
    assert.ok(waited < 1_000, `应被终态事件唤醒，实际等了 ${waited}ms`);
  });

  it('resumePending：认领他进程的残留记录，跳过本进程的自己（一定还活着）', async () => {
    const store = new InMemoryTaskStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hang = fakeApp(() => gate); // 进程 A：认领后卡住（模拟中断）
    const a = new AsyncRunner(hang, { store, concurrency: 1 });
    const t = a.submit('a');
    await waitFor(
      () => store.get(t.taskId)?.status === 'running',
      'submit 后任务应进入 running（并登记 ownerId）',
    );
    assert.equal(store.get(t.taskId)!.ownerId, a.ownerId);

    // 同一进程 resumePending：自己的记录还在内存里跑，重派就是跑两遍
    assert.equal(a.resumePending(), 0);
    assert.equal(hang.calls, 1);

    // 新进程（同 store）：把他进程的残留认领过来执行
    const b = fakeApp();
    const rb = new AsyncRunner(b, { store });
    assert.equal(rb.resumePending(), 1);
    assert.equal(store.get(t.taskId)!.ownerId, rb.ownerId, '认领时改写 ownerId');
    await rb.awaitTask(t.taskId);
    assert.equal(store.get(t.taskId)!.status, 'succeeded');
    assert.equal(b.calls, 1);
    release(); // 放掉 A 那次挂起的执行（其残留写入不再断言）
  });

  it('resumePending({staleAfterMs})：跳过刚起的他进程记录，超保鲜期的才抢', async () => {
    const store = new InMemoryTaskStore();
    const app = fakeApp();
    const runner = new AsyncRunner(app, { store });
    const mk = (taskId: string, startedAt: number): TaskRecord => ({
      taskId,
      status: 'running',
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: startedAt,
      startedAt,
      ownerId: 'p999-otherproc', // 他进程（可能仍在跑）
    });
    const now = Date.now();
    store.save(mk('task_fresh', now));
    store.save(mk('task_old', now - 10 * 60_000));

    // 缺省 0 = 不判断，一律重派（单进程旧语义）
    assert.equal(runner.resumePending(), 2);

    // 保鲜期 5 分钟：刚起的那个不抢（大概正被那个进程执行），超期的照抢
    const store2 = new InMemoryTaskStore();
    const runner2 = new AsyncRunner(fakeApp(), { store: store2 });
    store2.save(mk('task_fresh', now));
    store2.save(mk('task_old', now - 10 * 60_000));
    assert.equal(runner2.resumePending({ staleAfterMs: 5 * 60_000 }), 1);
    assert.equal(store2.get('task_old')!.status, 'queued');
    assert.equal(store2.get('task_fresh')!.status, 'running', '不动的记录保持原状');
    await runner2.awaitTask('task_old');
  });

  it('resumePending({staleAfterMs})：同主机按 **pid 存活**判租约 —— 主人活着的不抢、主人没了的立刻抢', async () => {
    // 这一条是 T2「too-fresh 是新鲜度不是租约」的端到端回归。两个方向都得走真 pid：
    // 两条记录的 startedAt **都是「现在」**（都在保鲜期内）—— 只看时间的旧判据会把两条都放过。
    const store = new InMemoryTaskStore();
    const host = hostname();
    const now = Date.now();
    // 主人「还在」：一个真在跑的子进程（同主机、异进程）
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    // 主人「不在」：起一个立刻退出的子进程，spawnSync 会替我们收尸 ⇒ 那个 pid 已经消失
    const reaped = spawnSync(process.execPath, ['-e', '']);
    assert.equal(typeof live.pid, 'number');
    assert.equal(typeof reaped.pid, 'number');
    const mk = (taskId: string, ownerId: string): TaskRecord => ({
      taskId,
      status: 'running',
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: now,
      startedAt: now,
      ownerId,
    });
    store.save(mk('task_owned', formatOwnerId(live.pid as number, host, 'aaaaaaaa')));
    store.save(mk('task_orphan', formatOwnerId(reaped.pid as number, host, 'bbbbbbbb')));
    const runner = new AsyncRunner(fakeApp(), { store });
    try {
      // 前提：本进程写下的标识必须是**可解析的**那一套（解析不出来的话，整套租约判定
      // 会静默退回新鲜度 —— 不报错，只是那条硬判据没了，所以在这里钉住）
      assert.deepEqual(parseOwnerId(runner.ownerId), { pid: process.pid, host });
      assert.equal(runner.resumePending({ staleAfterMs: 5 * 60_000 }), 1, '只认领主人不在的那条');
      assert.equal(store.get('task_orphan')!.status, 'queued', '孤儿立刻可抢，不等保鲜期');
      assert.equal(store.get('task_owned')!.status, 'running', '主人在 ⇒ 一条都不许动');
      await runner.awaitTask('task_orphan');
    } finally {
      live.kill('SIGKILL');
    }
  });

  it('resumePending({staleAfterMs})：异主机的记录判不了 pid ⇒ 退回保鲜期启发式', async () => {
    // 「判不了」必须与「不在」分开：把别的机器上的记录当孤儿抢，等于每个宿主进程
    // 都去捡同一批任务。异主机只能退回「看起来还新吗」这一档。
    const store = new InMemoryTaskStore();
    const now = Date.now();
    const ownerId = formatOwnerId(process.pid, 'some-other-host.local', 'cccccccc');
    const mk = (taskId: string, startedAt: number): TaskRecord => ({
      taskId,
      status: 'running',
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: startedAt,
      startedAt,
      ownerId,
    });
    store.save(mk('task_fresh', now));
    store.save(mk('task_stale', now - 10 * 60_000));
    const runner = new AsyncRunner(fakeApp(), { store });
    assert.equal(runner.resumePending({ staleAfterMs: 5 * 60_000 }), 1);
    assert.equal(store.get('task_fresh')!.status, 'running', '判不了 ⇒ 还是按保鲜期放过它');
    assert.equal(store.get('task_stale')!.status, 'queued');
    await runner.awaitTask('task_stale');
  });

  it('resumePending：认领先落库再派发 —— 异步 store 下重复扫不会重复执行', async () => {
    const store = new AsyncCopyStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp(() => gate);
    // concurrency=1 + 先占住槽位：认领的任务会停在 queued，重复派发的窗口因此可确定复现
    const runner = new AsyncRunner(app, { store, concurrency: 1 });
    runner.submit('block');
    await waitFor(() => app.calls === 1, '占位任务应已开跑');

    store.seed({
      taskId: 'task_other',
      status: 'running', // 他进程死在半路，留给本进程续跑
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: Date.now(),
      ownerId: 'p999-otherproc',
    });

    assert.equal(await runner.resumePending(), 1);
    // ⚠️ 认领必须**此刻已落库** —— 那是「第二次扫不再认领」的唯一依据
    // （修复前只在内存改 ownerId，store 里仍是 p999-otherproc）
    assert.equal((await store.get('task_other'))!.ownerId, runner.ownerId);
    assert.equal((await store.get('task_other'))!.status, 'queued');

    // 窗口内再扫一次：认领已落地 → 不重派（修复前返回 1 → app.run 被跑第二遍）
    assert.equal(await runner.resumePending(), 0);

    release();
    await runner.awaitTask('task_other');
    assert.equal(app.calls, 2, '占位 1 次 + 续跑 1 次；重复派发会是 3 次');
  });

  it('runTimeoutMs：超时任务标 failed 并回收槽位（底层执行无法真正取消）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const app: AppCallable = {
      name: 'fake',
      async run() {
        call++;
        if (call === 1) await gate; // 第一个任务永不返回
        return {
          run: { runId: `r-${call}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, { concurrency: 1, runTimeoutMs: 30 });
    const t1 = runner.submit('a');
    const rec = await runner.awaitTask(t1.taskId, { timeoutMs: 2_000 });
    assert.equal(rec.status, 'failed');
    assert.match(rec.error?.message ?? '', /执行超时/);
    // 超时自成一类（spec §10 2026-09-17 ref-timeout-error-type）：异步宿主这条路径也不得落 unknown
    assert.equal(rec.error?.type, 'timeout', 'runTimeoutMs 超时必须归 timeout 一类账');

    // 槽位已回收：concurrency=1 下第二个任务仍能起跑（不被超时任务永久占住）
    const t2 = runner.submit('b');
    const rec2 = await runner.awaitTask(t2.taskId, { timeoutMs: 2_000 });
    assert.equal(rec2.status, 'succeeded');
    assert.equal(call, 2);
    release(); // 放掉第一次被放弃的执行（其结果无人接收）
  });

  it('runTimeoutMs 校验：负数 / NaN / Infinity / 超 2^31-1ms 抛错（都会被 setTimeout 钳到 1ms，每任务立即「超时」）', () => {
    assert.throws(() => new AsyncRunner(fakeApp(), { runTimeoutMs: -1 }), /runTimeoutMs/);
    assert.throws(() => new AsyncRunner(fakeApp(), { runTimeoutMs: Number.NaN }), /runTimeoutMs/);
    assert.throws(
      () => new AsyncRunner(fakeApp(), { runTimeoutMs: Number.POSITIVE_INFINITY }),
      /runTimeoutMs/,
    );
    // 上界（2026-09-28）：此前只查「非负有限」，于是「配 30 天超时」这种**完全合法**的配置
    // 会让每个任务立即超时失败；现在构造期就拒（上限单源在 core/timeout.ts）。
    assert.throws(
      () => new AsyncRunner(fakeApp(), { runTimeoutMs: MAX_TIMER_DELAY_MS + 1 }),
      /超过 Node 定时器延迟上限/,
    );
    // 阳性对照：边界内（恰好 2^31-1）合法
    assert.doesNotThrow(() => new AsyncRunner(fakeApp(), { runTimeoutMs: MAX_TIMER_DELAY_MS }));
  });

  it('异步 store 的 byIdempotency reject：同步门面必须订阅，不得逃逸成 unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const map = new Map<string, TaskRecord>();
      let lookups = 0;
      const store: TaskStore = {
        save: (rec) => {
          map.set(rec.taskId, { ...rec });
        },
        get: (id) => map.get(id),
        // 异步 store：**submit 的即时去重**这一次 lookup 直接 reject（Redis 抖动）。
        // submit 的同步门面无法 await，但必须订阅该 Promise —— 否则就是
        // unhandledRejection（Node ≥15 终止宿主）。后续 #execute 的 lookup 正常。
        byIdempotency: () => {
          lookups++;
          return lookups === 1 ? Promise.reject(new Error('redis down')) : undefined;
        },
        list: () => [...map.values()],
        clear: () => map.clear(),
      };
      const runner = new AsyncRunner(fakeApp(), { store });
      const t = runner.submit('a', { idempotencyKey: 'k' });
      const rec = await runner.awaitTask(t.taskId, { timeoutMs: 2_000 });
      assert.equal(rec.status, 'succeeded', '即时去重的 lookup 失败不得影响任务执行');
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(rejections, [], '被拒的 Promise 必须已订阅，不得逃逸');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('初始 save 迟到 reject：不得把已成功的 run 覆写成 failed', async () => {
    let rejectInitial!: (e: unknown) => void;
    const initialSave = new Promise<void>((_, rej) => {
      rejectInitial = rej;
    });
    let saveCalls = 0;
    const map = new Map<string, TaskRecord>();
    const store: TaskStore = {
      save: (rec) => {
        saveCalls++;
        map.set(rec.taskId, { ...rec }); // 本地已落，但**初始 save 的 Promise 稍后 reject**
        return saveCalls === 1 ? initialSave : undefined;
      },
      get: (id) => map.get(id),
      byIdempotency: () => undefined,
      list: () => [...map.values()],
      clear: () => map.clear(),
    };
    const runner = new AsyncRunner(fakeApp(), { store });
    const t = runner.submit('a');
    const rec = await runner.awaitTask(t.taskId, { timeoutMs: 2_000 });
    assert.equal(rec.status, 'succeeded');

    // 此刻 run 已成功落库；初始 save 的 reject 迟到 —— 不得改判为 failed
    rejectInitial(new Error('disk full'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(map.get(t.taskId)?.status, 'succeeded', '落库终态必须与真实结果一致');
  });

  it('runTimeoutMs 到点 → abort 在飞 run 的 signal，任务标 failed', async () => {
    let received: AbortSignal | undefined;
    const app: AppCallable = {
      name: 'slow',
      async run(_messages, opts) {
        received = opts?.signal;
        // 尊重 signal：一直等到被中止为止
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener('abort', () => resolve());
        });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    };
    const runner = new AsyncRunner(app, { runTimeoutMs: 20 });
    const t = runner.submit('go');
    const rec = await runner.awaitTask(t.taskId, { timeoutMs: 2_000 });
    assert.equal(rec.status, 'failed');
    assert.equal(
      received?.aborted,
      true,
      '超时应 abort 传给 app 的 signal（真中止，不再白烧 token）',
    );
  });

  it('resumePending：并发重入共享同一次扫描 —— 不再各扫一遍、重复派发', async () => {
    const store = new AsyncCopyStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp(() => gate);
    // concurrency=1 + 先占住槽位：认领的任务停在 queued，重入窗口因此可确定复现
    const runner = new AsyncRunner(app, { store, concurrency: 1 });
    runner.submit('block');
    await waitFor(() => app.calls === 1, '占位任务应已开跑');

    store.seed({
      taskId: 'task_other',
      status: 'running', // 他进程死在半路，留给本进程续跑
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: Date.now(),
      ownerId: 'p999-otherproc',
    });

    // ⚠️ 关键是**不 await 第一次**：两个调用都在任一 save 落地前 list()，
    // 两份「旧快照」的 ownerId 都不是自己 ⇒「先落库再派发」挡不住它们（那是串行才有效的判据）。
    const first = runner.resumePending();
    const second = runner.resumePending();
    const [a, b] = await Promise.all([Promise.resolve(first), Promise.resolve(second)]);
    assert.equal(a, 1);
    assert.equal(b, 1, '重入方共享同一次扫描的结果（不是 0，也不是再派一遍）');

    release();
    await runner.awaitTask('task_other');
    assert.equal(app.calls, 2, '占位 1 次 + 续跑 1 次；重复派发会是 3 次');
  });
});

describe('AsyncRunner 的 session 正式通道（sessionId + sessionStore）', () => {
  /** 捕获 run 收到的 session 注入的假 app */
  function captureApp(): AppCallable & {
    seenSession: { store: unknown; id: string } | undefined;
  } {
    const app = {
      name: 'capture',
      seenSession: undefined as { store: unknown; id: string } | undefined,
      // 参数必须收得下 AsyncRunner 实际传进来的类型（RunInvocationOptions 与
      // `{ session }` 的交集）—— 只写 `{ session }` 与 RunInvocationOptions
      // 「无共同属性」，两个方向都不可赋值。
      async run(
        _messages: unknown,
        opts?: RunInvocationOptions & { session?: { store: unknown; id: string } },
      ) {
        app.seenSession = opts?.session;
        return {
          run: { runId: 'r-1', status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    return app;
  }

  it('sessionId 在执行前被换成 session（store 实例 + id）注入 run', async () => {
    const app = captureApp();
    const store = new InMemorySessionStore();
    const runner = new AsyncRunner(app, { sessionStore: store });
    const t = runner.submit('hi', { options: { sessionId: 's1' } });
    await runner.awaitTask(t.taskId);
    assert.equal(app.seenSession?.id, 's1');
    assert.equal(app.seenSession?.store, store, '注入的必须是 runner 持有的那个实例');
    assert.equal((await runner.poll(t.taskId))?.status, 'succeeded');
  });

  it('传了 sessionId 但没配 sessionStore ⇒ submit 当场 TaskInputError（不静默降级）', () => {
    const runner = new AsyncRunner(fakeApp());
    assert.throws(
      () => runner.submit('hi', { options: { sessionId: 's1' } }),
      (e: unknown) => e instanceof TaskInputError && /sessionStore/.test((e as Error).message),
    );
  });

  it('sessionId 随 TaskRecord 序列化往返不丢（FileTaskStore 重载后仍在）', async () => {
    // 这是「正式通道」与旧逃逸 hatch 的分界：session 实例经 JSON 序列化会变成 {}，
    // sessionId 是纯字符串。反向验证：旧写法（session 塞进 options）reload 后
    // store 字段即空对象，本断言的 sessionId 必须原样回来。
    const dir = mkdtempSync(join(tmpdir(), 'agentia-session-'));
    const file = join(dir, 'tasks.jsonl');
    const app = captureApp();
    const runner = new AsyncRunner(app, {
      store: new FileTaskStore(file),
      sessionStore: new InMemorySessionStore(),
    });
    const t = runner.submit('hi', { options: { sessionId: 's-persist' } });
    await runner.awaitTask(t.taskId);

    const reloaded = new FileTaskStore(file);
    const rec = reloaded.get(t.taskId);
    assert.equal(rec?.spec.options?.sessionId, 's-persist', '重启后续跑还得接得上会话');
  });
});

describe('HITL × sessionStore：恢复段不重拼历史、不毒化会话', () => {
  const OBJ = { type: 'object', properties: {} } as const;

  it('带 session 的任务挂起 → 批准 → 成功：恢复段 messages 无重复历史；会话只多一轮对话', async () => {
    // 反向验证：恢复段重新注入 session（旧行为）⇒ ① 恢复段 messages 里
    // 「旧问题」出现 2 次（suspendedMessages 已含历史，loadSession 又 prepend 一遍）；
    // ② 成功后整段 suspendedMessages 被 append 进会话（含孤立 tool_use），
    // 本用例两条断言都红。
    const { client, seen } = mockClient([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('最终回复')]);
    const tools: AgentTool[] = [
      {
        name: 'danger',
        description: '危险操作',
        inputSchema: OBJ,
        approval: 'required',
        run: () => 'done',
      },
    ];
    const app: AppCallable = {
      name: 'hitl-session',
      run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
    };
    const sessionStore = new InMemorySessionStore();
    sessionStore.append('s1', [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧答复' },
    ]);
    const runner = new AsyncRunner(app, { sessionStore });
    const t = runner.submit('新指令', { options: { sessionId: 's1' } });

    // 等挂起（InMemoryTaskStore 的 poll 是同步返回，可直接用 waitFor）
    await waitFor(
      () => (runner.poll(t.taskId) as TaskRecord | undefined)?.status === 'suspended',
      '任务应挂起等审批',
    );
    await runner.approve(t.taskId, { tu1: { approved: true } });
    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result?.finalText, '最终回复');

    // ① 恢复段发给模型的 messages：会话历史恰好一份（翻倍 = token 复利）
    assert.equal(seen.length, 2, '挂起段 + 恢复段各一次模型调用');
    const resumeMsgs = (seen[1] as { messages: MessageParam[] }).messages;
    assert.equal(
      resumeMsgs.filter((m) => m.content === '旧问题').length,
      1,
      '恢复段不得重复 prepend 会话历史',
    );

    // ② 成功后的会话 = 旧历史 + 本轮用户输入 + 最终回复：
    //    无 tool_use / tool_result 残留、不以 tool_use 结尾（否则下一轮撞 API 400）
    const history = sessionStore.load('s1');
    assert.deepEqual(history, [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧答复' },
      { role: 'user', content: '新指令' },
      { role: 'assistant', content: '最终回复' },
    ]);
    for (const m of history) {
      assert.equal(typeof m.content, 'string', '会话历史只存对话轮次（不得混入 tool 块）');
    }
    assert.equal(history[history.length - 1]?.role, 'assistant', '历史必须以 assistant 结尾');
  });
});

describe('HITL 续跑时的菜单漂移（R8 候选 3 / spec §10 2026-09-27 ref-menu-drift-signals）', () => {
  const OBJ = { type: 'object', properties: {} } as const;

  it('approve 续跑时那个工具已被这次发布删掉：三处信号 + run 照常收尾（不判失败）', async () => {
    // 生产路径真跑：两个 AppCallable 代表**两次发布**的同一应用（菜单不同），共用一个 store
    // ⇒ 第二个 runner 就是「重启 + 发布之后」的那个进程。
    // 与 `tests/engine/menu-drift.test.ts` 的分工：那边钉引擎的判定口径，这边钉
    // **toolkit/宿主接线**（谁能把当前菜单交到引擎手上）—— 只动一侧不会两边都绿。
    const danger: AgentTool = {
      name: 'danger',
      description: '危险操作',
      inputSchema: OBJ,
      approval: 'required',
      run: () => 'done',
    };
    const safe: AgentTool = {
      name: 'safe',
      description: '安全操作',
      inputSchema: OBJ,
      run: () => 'safe-ok',
    };
    const clientA = mockClient([toolUseMsg('danger', {}, 'tu-1')]).client;
    const clientB = mockClient([endTurnMsg('（模型自己编了个结果）')]).client;
    const appA: AppCallable = {
      name: 'app',
      run: (messages, opts) => executeRun({ messages, client: clientA, tools: [danger], ...opts }),
    };
    const appB: AppCallable = {
      name: 'app',
      run: (messages, opts) => executeRun({ messages, client: clientB, tools: [safe], ...opts }),
    };

    const store = new InMemoryTaskStore();
    const runnerA = new AsyncRunner(appA, { store });
    const t = runnerA.submit([{ role: 'user', content: '帮我做那件危险的事' }]);
    await waitFor(
      () => (runnerA.poll(t.taskId) as TaskRecord | undefined)?.status === 'suspended',
      '任务应挂起等审批',
    );
    // 挂起段的签名（老菜单）—— 后面拿它与新段比：这就是「跨段比对菜单版本」的用法
    const recA = (await runnerA.poll(t.taskId))!;
    const rootA = recA.result!.trace.spans.find((s) => s.spanId === recA.result!.trace.rootSpanId)!;
    assert.equal(rootA.attributes['tools.names'], 'danger');

    const runnerB = new AsyncRunner(appB, { store });
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '));
    let done: TaskRecord | undefined;
    try {
      await runnerB.approve(t.taskId, { 'tu-1': { approved: true } });
      done = await runnerB.awaitTask(t.taskId);
    } finally {
      console.warn = origWarn;
    }

    assert.equal(done?.status, 'succeeded');
    const trace = done!.result!.trace;
    const events = trace.spans.flatMap((s) => s.events);
    // ① 事件（时间线 / 任务流）
    assert.deepEqual(
      events.filter((e) => e.name === 'menu.drift').map((e) => e.body),
      [{ missing: ['danger'], tool_use_ids: ['tu-1'], menu_size: 1 }],
    );
    // ② 父 span 属性（可查询：TaskRecord.result.trace 里带得到）
    const rootB = trace.spans.find((s) => s.spanId === trace.rootSpanId)!;
    assert.equal(rootB.attributes['menu.drift'], 'missing:danger');
    // 新段的签名 = 新菜单（与上面 rootA 的 'danger' 一比就知道菜单动过）
    assert.equal(rootB.attributes['tools.names'], 'safe');
    assert.notEqual(rootB.attributes['tools.menuHash'], rootA.attributes['tools.menuHash']);
    // ③ console.warn（运维面立即看见）
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /菜单漂移/);
    assert.match(warns[0]!, /danger/);

    // 本轮取舍：**不判失败** —— run 照常收尾，那个 tool_use 走既有 unknown_tool
    assert.equal(done!.result!.stopReason, 'end_turn');
    assert.equal(done!.result!.error, undefined);
    const out = events
      .filter((e) => e.name === 'tool.output')
      .map((e) => e.body as { errorKind?: string });
    assert.deepEqual(
      out.map((o) => o.errorKind),
      ['unknown_tool'],
    );
  });
});
