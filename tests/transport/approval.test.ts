import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncRunner, FileTaskStore, InMemoryTaskStore, executeRun } from '../../src/index.js';
import type {
  AgentRunResult,
  AgentTool,
  AppCallable,
  TaskRecord,
  TaskSink,
} from '../../src/index.js';
import type { TaskStore } from '../../src/index.js';
import { TaskApproveError } from '../../src/transport/async.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * HITL（人工审批）宿主侧：submit → 挂起落库 → approve → 恢复 → 终态。
 * 应用侧走**真引擎**（executeRun + mockClient）—— 「宿主测试用假 app」的边界
 * 已经咬过人（spec §10 第五轮 review 的教训），这里的断言都要穿过真循环。
 */

const OBJ = { type: 'object', properties: {} } as const;

interface Spy {
  calls: Array<{ input: unknown; approval: unknown }>;
}

/** 真路径 app：executeRun + mockClient；spy 记录每次工具执行与它的审批决定 */
function hitlApp(script: Array<Record<string, unknown>>, spy: Spy, extraTools: AgentTool[] = []) {
  const { client, seen } = mockClient(script);
  const tools: AgentTool[] = [
    {
      name: 'danger',
      description: '危险操作',
      inputSchema: OBJ,
      approval: 'required',
      run: (input, ctx) => {
        spy.calls.push({ input, approval: ctx?.approval });
        return 'done';
      },
    },
    ...extraTools,
  ];
  const app: AppCallable = {
    name: 'hitl',
    run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
  };
  return { app, seen };
}

async function waitStatus(
  runner: AsyncRunner,
  taskId: string,
  status: string,
): Promise<TaskRecord> {
  // ⚠️ helpers 的 waitFor 只收**同步**条件（传 async 函数会让 Promise 恒 truthy、
  // 立即放行）—— 这里要 await store，所以自己写循环（预算同 waitFor 的 10s）。
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = await runner.poll(taskId);
    if (rec?.status === status) return rec;
    if (Date.now() > deadline) {
      throw new Error(`等任务 ${taskId} 进入 ${status} 超时（当前 ${rec?.status}）`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('AsyncRunner HITL（审批挂起/恢复）', () => {
  it('submit → 挂起落库：状态/待决清单/扩展历史落库，槽位释放（不占并发），onFinished 不开火', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp(
      [toolUseMsg('danger', {}, 'tu1'), endTurnMsg('t2 ok'), endTurnMsg('t1 done')],
      spy,
    );
    const sinkCalls: string[] = [];
    const sink: TaskSink = {
      onFinished: (rec) => {
        sinkCalls.push(`${rec.taskId}:${rec.status}`);
      },
    };
    // concurrency=1：挂起若占槽位，第二个任务永远排不到
    const runner = new AsyncRunner(app, { concurrency: 1, taskSinks: [sink] });
    const t1 = runner.submit('任务1');
    const t1Suspended = await waitStatus(runner, t1.taskId, 'suspended');

    assert.equal(spy.calls.length, 0, '未决审批 ⇒ 工具一次都没执行');
    assert.deepEqual(t1Suspended.pendingApprovals, ['tu1'], '待决清单落库');
    assert.equal(t1Suspended.finishedAt, undefined, '挂起不是终态：finishedAt 不置');
    assert.equal(typeof t1Suspended.suspendedSince, 'number', '挂起时刻落库（超时/审计的基准）');
    const tail = t1Suspended.spec.messages[t1Suspended.spec.messages.length - 1];
    assert.equal(tail.role, 'assistant', '扩展历史以含未决 tool_use 的 assistant 结尾');
    assert.ok(Array.isArray(tail.content));
    assert.equal(runner.inFlight, 0, '挂起不占在飞计数（槽位已释放）');
    assert.deepEqual(sinkCalls, [], '挂起不触发 onFinished（它不是终态）');

    // 槽位真的空出来了：第二个任务在 concurrency=1 下照常跑完
    const t2 = runner.submit('任务2');
    const t2Done = await runner.awaitTask(t2.taskId);
    assert.equal(t2Done.status, 'succeeded');
    assert.deepEqual(sinkCalls, [`${t2.taskId}:succeeded`], 't2 终态正常回调；t1 挂起仍没开火');

    // 收尾：批了 t1，它恢复并跑完；onFinished 恰好这时才对它开火
    await runner.approve(t1.taskId, { tu1: { approved: true } });
    const t1Done = await runner.awaitTask(t1.taskId);
    assert.equal(t1Done.status, 'succeeded');
    assert.deepEqual(sinkCalls, [`${t2.taskId}:succeeded`, `${t1.taskId}:succeeded`]);
  });

  it('approve → 恢复 → 成功：框架回填 decidedAt/requestedAt；恢复段 trace 经 link 挂到上一段', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('完成')], spy);
    const runner = new AsyncRunner(app);
    const t = runner.submit('活');
    const suspended = await waitStatus(runner, t.taskId, 'suspended');
    const firstRunId = suspended.runId!;

    const rec = await runner.approve(
      t.taskId,
      { tu1: { approved: true, reason: '确认过' } },
      { decidedBy: 'alice' },
    );
    const decision = rec.approvals!.tu1;
    assert.equal(decision.approved, true);
    assert.equal(decision.decidedBy, 'alice');
    assert.equal(typeof decision.decidedAt, 'number', 'decidedAt 缺省由框架填');
    assert.equal(
      decision.requestedAt,
      suspended.suspendedSince,
      'requestedAt 回填为挂起时刻（waitedMs 的基准）',
    );

    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result!.finalText, '完成');
    assert.equal(spy.calls.length, 1);
    assert.equal(
      (spy.calls[0].approval as { decidedBy?: string }).decidedBy,
      'alice',
      '工具体内经 ToolRunContext.approval 读到自己的决定',
    );
    // 恢复段是新树，经 traceContext link 挂到挂起段
    const root = done.result!.trace.spans.find((s) => s.kind === 'run')!;
    assert.notEqual(done.runId, firstRunId, '恢复段是新的 runId（新树）');
    assert.deepEqual(root.links, [{ traceId: firstRunId }], '恢复段 link 上一段 runId');
    // 终态后挂起痕迹清掉，决定保留（审计）
    assert.equal(done.pendingApprovals, undefined);
    assert.equal(done.approvals!.tu1.approved, true);
  });

  it('逐 tool_use_id 幂等：第一次决定赢；决定不齐只落库不恢复', async () => {
    const spy: Spy = { calls: [] };
    const deploy: AgentTool = {
      name: 'deploy',
      description: '部署',
      inputSchema: OBJ,
      approval: 'required',
      run: (input) => {
        spy.calls.push({ input, approval: undefined });
        return 'deployed';
      },
    };
    const twoPending = {
      id: 'm2',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'tool_use', id: 'tu1', name: 'danger', input: {} },
        { type: 'tool_use', id: 'tu2', name: 'deploy', input: {} },
      ],
    };
    const { app } = hitlApp([twoPending, endTurnMsg('完成')], spy, [deploy]);
    const runner = new AsyncRunner(app);
    const t = runner.submit('活');
    await waitStatus(runner, t.taskId, 'suspended');

    // 第一批：只批 tu1 —— 决定不齐，不恢复
    const afterFirst = await runner.approve(t.taskId, {
      tu1: { approved: true, reason: '第一次' },
    });
    assert.equal(afterFirst.status, 'suspended', '决定不齐 ⇒ 继续等');
    assert.equal(spy.calls.length, 0);

    // 第二批：试图推翻 tu1（应被忽略）+ 批 tu2 —— 齐了，恢复
    const afterSecond = await runner.approve(t.taskId, {
      tu1: { approved: false, reason: '反悔' },
      tu2: { approved: true },
    });
    assert.equal(afterSecond.approvals!.tu1.approved, true, '第一次决定赢（逐 id 幂等）');
    assert.equal(afterSecond.approvals!.tu1.reason, '第一次');
    assert.equal(afterSecond.approvals!.tu2.approved, true);
    assert.equal(afterSecond.status, 'running');

    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(spy.calls.length, 2, '两个工具各执行恰好一次');
  });

  it('非 awaiting 状态 approve 抛 409 语义；任务不存在抛 404 语义', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([endTurnMsg('ok')], spy);
    const runner = new AsyncRunner(app);
    const t = runner.submit('活');
    await runner.awaitTask(t.taskId); // succeeded
    await assert.rejects(runner.approve(t.taskId, { tu1: { approved: true } }), (e: unknown) => {
      assert.ok(e instanceof TaskApproveError);
      assert.equal(e.status, 409);
      assert.match(e.message, /succeeded/);
      return true;
    });
    await assert.rejects(runner.approve('task_不存在', {}), (e: unknown) => {
      assert.ok(e instanceof TaskApproveError);
      assert.equal(e.status, 404);
      return true;
    });
  });

  it('approvalTimeoutMs：惰性判定 —— 读到一个已超时的挂起任务 ⇒ 自动全拒并重派', async () => {
    const spy: Spy = { calls: [] };
    let denialSeen = '';
    const script: Array<Record<string, unknown>> = [
      toolUseMsg('danger', {}, 'tu1'),
      {
        onParams: (p: unknown) => {
          const msgs = (p as { messages: Array<{ content: unknown }> }).messages;
          const last = msgs[msgs.length - 1];
          denialSeen = (last.content as Array<{ content: string }>)[0].content;
        },
        message: endTurnMsg('好吧'),
      } as unknown as Record<string, unknown>,
    ];
    const { app } = hitlApp(script, spy);
    const runner = new AsyncRunner(app, { approvalTimeoutMs: 60_000 });
    const t = runner.submit('活');
    await waitStatus(runner, t.taskId, 'suspended');

    // 把挂起时刻拨到很久以前（副本契约：改完要落库才算数）—— 不起定时器，
    // 超时只在「有人读它」时生效（惰性判定）
    const rec = (await runner.poll(t.taskId))!;
    assert.equal(rec.status, 'suspended', '没到点不动作');
    rec.suspendedSince = 0;
    await runner.store.save(rec);

    // 下一次读到（poll） ⇒ 自动全拒 + 重派
    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.approvals!.tu1.approved, false);
    assert.equal(done.approvals!.tu1.reason, '审批超时');
    assert.equal(done.approvals!.tu1.decidedBy, 'system');
    assert.equal(spy.calls.length, 0, '超时全拒 ⇒ 工具不执行');
    assert.equal(denialSeen, '审批被拒绝：审批超时', '模型看得到超时拒绝的理由');
  });

  it('resumePending 不捡 awaiting（不是孤儿）；配 approvalTimeoutMs 的过期任务被惰性判拒重派', async () => {
    const spy: Spy = { calls: [] };
    const store = new InMemoryTaskStore();
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('好')], spy);
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('活');
    await waitStatus(runner, t.taskId, 'suspended');

    // 模拟另一个进程重启：新 runner（不同 ownerId）扫描同一 store
    const spy2: Spy = { calls: [] };
    const { app: app2 } = hitlApp([endTurnMsg('好')], spy2);
    const runner2 = new AsyncRunner(app2, { store });
    const dispatched = await runner2.resumePending();
    assert.equal(dispatched, 0, 'suspended 不是孤儿，resumePending 不捡');
    assert.equal((await runner2.poll(t.taskId))!.status, 'suspended');

    // 配了 approvalTimeoutMs 且已过期 ⇒ resumePending 顺手判掉（惰性）并重派
    // （副本契约：poll 交出的是快照，拨时刻后要落库才算数）
    const rec = (await runner2.poll(t.taskId))!;
    rec.suspendedSince = 0;
    await runner2.store.save(rec);
    const runner3 = new AsyncRunner(app2, { store, approvalTimeoutMs: 1000 });
    const expired = await runner3.resumePending();
    assert.equal(expired, 1, '过期的挂起任务被自动判拒重派（计入重派数）');
    const done = await runner3.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.approvals!.tu1.reason, '审批超时');
  });

  it('进程重启（FileTaskStore）：挂起状态/消息历史/决定不丢，新进程 approve 后续跑成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-hitl-'));
    try {
      const file = join(dir, 'tasks.jsonl');
      const spy1: Spy = { calls: [] };
      const { app: app1 } = hitlApp([toolUseMsg('danger', {}, 'tu1')], spy1);
      const runner1 = new AsyncRunner(app1, { store: new FileTaskStore(file) });
      const t = runner1.submit('活');
      await waitStatus(runner1, t.taskId, 'suspended');

      // 「重启」：新 FileTaskStore（读盘还原）+ 新 runner + 新模型脚本
      const spy2: Spy = { calls: [] };
      const { app: app2 } = hitlApp([endTurnMsg('重启后完成')], spy2);
      const runner2 = new AsyncRunner(app2, { store: new FileTaskStore(file) });
      const loaded = await runner2.poll(t.taskId);
      assert.equal(loaded!.status, 'suspended', '挂起状态跨进程可见');
      assert.deepEqual(loaded!.pendingApprovals, ['tu1'], '待决清单跨进程不丢');

      const rec = await runner2.approve(t.taskId, { tu1: { approved: true } });
      assert.equal(typeof rec.approvals!.tu1.requestedAt, 'number', '挂起时刻也随记录还原');
      const done = await runner2.awaitTask(t.taskId);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.result!.finalText, '重启后完成');
      assert.equal(spy2.calls.length, 1);

      // 再「重启」一次：决定仍落在盘上
      const store3 = new FileTaskStore(file);
      const persisted = await store3.get(t.taskId);
      assert.equal(persisted!.approvals!.tu1.approved, true, '决定随任务落盘，重启不丢');
      assert.equal(persisted!.status, 'succeeded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('幂等键复用：同键重复 submit 返回等待中的任务（不新起任务）', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1')], spy);
    const runner = new AsyncRunner(app);
    const t1 = runner.submit('活', { idempotencyKey: 'k1' });
    await waitStatus(runner, t1.taskId, 'suspended');
    const t2 = runner.submit('活', { idempotencyKey: 'k1' });
    assert.equal(t2.taskId, t1.taskId, 'suspended 同键去重：返回等待中的任务');
    assert.equal((await runner.list()).length, 1);
  });
});

describe('approve 的并发与落库纪律（第八轮复审补缺）', () => {
  /**
   * 反序列化 + 可闸门 save 的异步 store：get/list 返回副本（与 Redis 等同形），
   * save 可挂住 —— 用来把「两个并发 approve 都在对方落库前读到 awaiting」的窗口撑开。
   */
  class GatedCopyStore {
    readonly #byTask = new Map<string, TaskRecord>();
    private gate: Promise<void> | null = null;
    private release: (() => void) | null = null;
    saveCalls = 0;
    failNextSave = false;

    holdNextSave(): void {
      this.gate = new Promise<void>((r) => {
        this.release = r;
      });
    }
    releaseSave(): void {
      this.release?.();
      this.gate = null;
      this.release = null;
    }
    async save(rec: TaskRecord): Promise<void> {
      this.saveCalls++;
      if (this.failNextSave) {
        this.failNextSave = false;
        throw new Error('store 抖动（测试注入）');
      }
      if (this.gate) await this.gate;
      this.#byTask.set(rec.taskId, JSON.parse(JSON.stringify(rec)) as TaskRecord);
    }
    async get(taskId: string): Promise<TaskRecord | undefined> {
      const r = this.#byTask.get(taskId);
      return r ? (JSON.parse(JSON.stringify(r)) as TaskRecord) : undefined;
    }
    async byIdempotency(): Promise<undefined> {
      return undefined;
    }
    async list(): Promise<TaskRecord[]> {
      return [...this.#byTask.values()];
    }
    async clear(): Promise<void> {
      this.#byTask.clear();
    }
  }

  it('并发 approve 共享在飞那次：恢复只派发一次（不重复执行）', async () => {
    // 反向验证：摘掉 approve 的重入闸（两个并发调用都落到各自 get→save→派发）⇒
    // spy 会记到 2 次执行（同一任务跑两遍，副作用与花费翻倍）。
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('收尾')], spy);
    const store = new GatedCopyStore();
    const runner = new AsyncRunner(app, { store });
    const { taskId } = runner.submit('任务');
    await waitStatus(runner, taskId, 'suspended');

    // 撑开窗口：第一个 approve 的 save 挂住，此时第二个 approve 进来
    store.holdNextSave();
    const p1 = runner.approve(taskId, { tu1: { approved: true } }, { decidedBy: 'alice' });
    // 让 p1 推进到 save 挂起点
    await new Promise((r) => setTimeout(r, 20));
    const p2 = runner.approve(
      taskId,
      { tu1: { approved: false, reason: '我是后来的' } },
      { decidedBy: 'bob' },
    );
    store.releaseSave();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.status, r2.status, '两个并发调用拿到同一次审批的结果');
    assert.equal(r2.approvals?.tu1?.decidedBy, 'alice', '第一次决定赢（后到的不覆盖）');
    const done = await waitStatus(runner, taskId, 'succeeded');
    assert.equal(done.status, 'succeeded');
    assert.equal(spy.calls.length, 1, '恢复只派发一次 —— 重复执行会是 2');
  });

  it('approve 落库失败：调用方收到 reject，且绝不派发（先落库再派发是真纪律）', async () => {
    // 反向验证：改回 #safeSave（吞错）⇒ 本用例红在「approve 竟然 resolve 了」
    // 且 spy 会记到 1 次执行（决定没落库、run 却恢复了）。
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('收尾')], spy);
    const store = new GatedCopyStore();
    const runner = new AsyncRunner(app, { store });
    const { taskId } = runner.submit('任务');
    await waitStatus(runner, taskId, 'suspended');

    store.failNextSave = true;
    await assert.rejects(
      () => runner.approve(taskId, { tu1: { approved: true } }),
      /store 抖动/,
      '落库失败必须让调用方知道（approve 是写操作，不是观测）',
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(spy.calls.length, 0, '落库失败就绝不派发 —— 决定没落库的恢复不算数');
    const rec = await store.get(taskId);
    assert.equal(rec?.status, 'suspended', '任务仍在等待，重试 approve 可恢复');
  });
});

describe('惰性审批超时的重入闸（#expireAndResume 与 approve 同一把闸）', () => {
  /**
   * 「返回拷贝 + 微延迟」的异步 store —— 与 Redis 等同形：get 交出的副本与库内记录
   * 不共享引用，且每次读写都有网络往返。两个并发 poll 会各自拿到 awaiting 副本，
   * 这正是 #expireAndResume 旧实现双派发的必要条件。
   */
  class DelayedCopyStore implements TaskStore {
    readonly #byTask = new Map<string, TaskRecord>();
    async save(rec: TaskRecord): Promise<void> {
      await new Promise((r) => setTimeout(r, 5));
      this.#byTask.set(rec.taskId, JSON.parse(JSON.stringify(rec)) as TaskRecord);
    }
    async get(taskId: string): Promise<TaskRecord | undefined> {
      await new Promise((r) => setTimeout(r, 5));
      const r = this.#byTask.get(taskId);
      return r ? (JSON.parse(JSON.stringify(r)) as TaskRecord) : undefined;
    }
    async byIdempotency(): Promise<undefined> {
      return undefined;
    }
    async list(): Promise<TaskRecord[]> {
      return [...this.#byTask.values()].map((r) => JSON.parse(JSON.stringify(r)) as TaskRecord);
    }
    async clear(): Promise<void> {
      this.#byTask.clear();
    }
    /** 测试用：直接塞一条初始记录（不走 save） */
    seed(rec: TaskRecord): void {
      this.#byTask.set(rec.taskId, JSON.parse(JSON.stringify(rec)) as TaskRecord);
    }
  }

  it('并发 poll 各自读到 awaiting 副本 ⇒ 超时恢复只派发一次', async () => {
    // 反向验证：摘掉 #expireAndResume 的重入闸 ⇒ 两个 poll 各自 fill denials + 各自
    // #execute，runs 会是 2（同一任务跑两遍，副作用与花费翻倍）。
    const store = new DelayedCopyStore();
    let runs = 0;
    const app: AppCallable = {
      name: 'counting',
      async run() {
        runs++;
        return {
          run: { runId: `r-${runs}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    store.seed({
      taskId: 'task_expired',
      status: 'suspended',
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: Date.now() - 120_000,
      suspendedSince: 0, // 早已超时：任何一次读都会触发惰性判定
      suspendedReason: 'approval', // 2026-09-28 ①：超时闸只对 approval 成立
      pendingApprovals: ['tu1'],
      ownerId: 'p999-otherproc',
    });
    const runner = new AsyncRunner(app, { store, approvalTimeoutMs: 1000 });

    // 两个并发 poll：两个 get 都在任一 save 落地前返回 awaiting 副本
    await Promise.all([runner.poll('task_expired'), runner.poll('task_expired')]);
    const done = await runner.awaitTask('task_expired');
    assert.equal(done.status, 'succeeded');
    assert.equal(runs, 1, '并发惰性恢复只能派发一次 —— 重复执行会是 2');
    const rec = await store.get('task_expired');
    assert.equal(rec?.approvals?.tu1?.reason, '审批超时', '超时决定照常落库');
  });

  it('timer 挂起的任务：approve 一律 409（原因闸），且不派发、状态不动', async () => {
    // 反向验证：把闸退回「只看 status」⇒ 这条红 —— approve 会把这台「睡眠机」当审批任务
    // 恢复，而 approvalsComplete(空待决) === true ⇒ 它被**直接重派续跑**（提前叫醒 + 真实开销）。
    const store = new InMemoryTaskStore();
    let runs = 0;
    const app: AppCallable = {
      name: 'counting',
      async run() {
        runs++;
        return {
          run: { runId: `r-${runs}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    await store.save({
      taskId: 'task_sleeping',
      status: 'suspended',
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: Date.now(),
      suspendedSince: Date.now(),
      suspendedReason: 'timer',
      ownerId: 'p1-thisproc',
    });
    const runner = new AsyncRunner(app, { store, approvalTimeoutMs: 1000 });

    await assert.rejects(
      () => runner.approve('task_sleeping', {}),
      (e: unknown) => {
        assert.ok(e instanceof TaskApproveError, '应是 409 的 TaskApproveError');
        assert.equal(e.status, 409);
        assert.match(e.message, /timer/, '文案要点明挂起原因，不能只说「状态不对」');
        return true;
      },
    );
    assert.equal(runs, 0, '被拒的审批不许派发');
    const after = await store.get('task_sleeping');
    assert.equal(after?.status, 'suspended', '状态不动');
    assert.equal(after?.suspendedReason, 'timer', '原因不动');
    assert.equal(
      after?.suspendedSince !== undefined,
      true,
      '挂起时刻不动（超时基准不能被这次调用重置）',
    );
  });
});
