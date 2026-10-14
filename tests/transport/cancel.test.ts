import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncRunner, executeRun, InMemoryTaskStore } from '../../src/index.js';
import type { AgentTool, AppCallable, AgentRunResult } from '../../src/index.js';
import { TaskCancelError } from '../../src/transport/async.js';
import { createHttpHandler } from '../../src/transport/http.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

/**
 * `cancel` API（durable 配套 5 的另一半，spec §10 2026-09-28 ref-cancel-api）。
 *
 * 三件事是本文件存在的理由：
 * ① **三种在服状态**（running / queued / suspended）各有一条真用例 —— 它们的语义不同，
 *    一处漏了就是一处「假装取消」；
 * ② **状态按意图落、不按机制落**：超时那条老路必须仍然落 `failed`（阳性对照，防我把
 *    「加了 canceled 状态」顺手改成「所有 abort 都算取消」）；
 * ③ `awaitTask` 的终态集合（原先手写两值）—— 漏了新终态的症状是**静默等到超时**。
 *
 * 在跑那条走**真引擎**（executeRun + mockClient + 一个尊重 `ctx.signal` 的工具），
 * 与 approval/durable-timer 同一条纪律：宿主测试用假 app 会漏掉引擎与宿主的交界。
 */

const OBJ = { type: 'object', properties: {} } as const;

/** 尊重 `ctx.signal` 的慢工具：取消一到就返回（不尊重 signal 的工具会吊住整个回合） */
function abortAwareTool(spy: { calls: number }): AgentTool {
  return {
    name: 'slow',
    description: '挂在 signal 上的慢工具',
    inputSchema: OBJ,
    run: (_input, ctx) =>
      new Promise<string>((resolve) => {
        spy.calls++;
        const signal = ctx?.signal;
        if (signal?.aborted) return resolve('aborted-before-start');
        signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
      }),
  };
}

/** 真引擎的取消：一次 run 挂在工具上 ⇒ cancel ⇒ 引擎以 aborted 收尾 ⇒ 记录落 cancelled */
function engineApp(spy: { calls: number; script: Array<Record<string, unknown>> }): {
  app: AppCallable;
  seen: unknown[];
} {
  const { client, seen } = mockClient(spy.script);
  return {
    app: {
      name: 'engine',
      run: (messages, opts) =>
        executeRun({ messages, client, tools: [abortAwareTool(spy)], ...opts }),
    },
    seen,
  };
}

async function waitStatus(
  runner: AsyncRunner,
  taskId: string,
  status: string,
  budgetMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const rec = await runner.poll(taskId);
    if (rec?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`等任务 ${taskId} 进入 ${status} 超时（当前 ${rec?.status}）`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function listen(
  app: AppCallable,
  opts: { runner: AsyncRunner },
): Promise<{ server: Server; base: string }> {
  const server = createServer(createHttpHandler(app, { runner: opts.runner }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

// biome-ignore lint/suspicious/noExplicitAny: 端点回的是运行时数据，逐字段断言时不必先窄化 unknown
const readJson = (res: Response): Promise<any> => res.json();

describe('cancel —— 在跑的 run：真中断 + 按意图落状态', () => {
  it('cancel 一条在跑的：引擎以 aborted 收尾、记录落 cancelled + error.type aborted、槽位释放', async () => {
    const spy = { calls: 0, script: [toolUseMsg('slow', {}, 'tu1'), endTurnMsg('不该走到这里')] };
    const { app } = engineApp(spy);
    const sinkCalls: string[] = [];
    const runner = new AsyncRunner(app, {
      concurrency: 1,
      taskSinks: [
        {
          onFinished: (rec) => {
            sinkCalls.push(rec.status);
          },
        },
      ],
    });

    const t = runner.submit('跑起来');
    await waitStatus(runner, t.taskId, 'running');
    // 前置：工具真的挂在飞（否则后面证明不了「取消把它拽回来了」）
    await waitStatus(runner, t.taskId, 'running');
    assert.equal(spy.calls, 1, '前提：工具已进入在飞');

    const rec = await runner.cancel(t.taskId);
    assert.equal(rec.status, 'cancelled', '取消落 cancelled（不是 failed）');
    assert.equal(rec.error?.type, 'aborted', '取消带结构化原因：取消不是失败，但原因要可查');
    assert.equal(typeof rec.finishedAt, 'number', '取消是终态：finishedAt 要有');
    assert.equal(runner.inFlight, 0, '槽位释放（停机/后续任务不被它挡住）');
    assert.deepEqual(sinkCalls, ['cancelled'], 'onFinished 恰好一次、且说的是真话');
    // 落库的也是终态（不是只在返回值里）
    assert.equal((await runner.poll(t.taskId))?.status, 'cancelled');

    // 阳性对照：没被取消的任务照常跑完（防「这道闸焊死」）
    spy.script.push(endTurnMsg('正常收尾'));
    const ok = runner.submit('不取消');
    assert.equal((await runner.awaitTask(ok.taskId)).status, 'succeeded');
  });

  it('宿主不认 signal ⇒ 取消**未发生**：撤回意图 + 409（不假装成功）', async () => {
    const runner = new AsyncRunner({
      name: 'ignores-signal',
      // 故意不看 signal、也永不返回：这正是「无法真中断」的那一类宿主。
      // runTimeoutMs 那条路对同样情形是「放弃等待」（落 failed、释放槽位、底层照样跑完）——
      // 取消这条路**刻意不同**：人手按的动作不能骗人（设计稿 §6 记了取舍）。
      run: () => new Promise<never>(() => {}),
    });
    const t = runner.submit('y');
    await waitStatus(runner, t.taskId, 'running');
    await assert.rejects(
      async () => runner.cancel(t.taskId),
      (e: unknown) => e instanceof TaskCancelError && e.status === 409,
      '宽限内没收尾 ⇒ 说出来，而不是落一条会被那条 run 覆盖回去的 cancelled',
    );
    assert.equal(
      (await runner.poll(t.taskId))?.status,
      'running',
      '取消未发生 ⇒ 记录一个字节都不动（调用方拿到的 409 与记录一致）',
    );
  });

  it('宿主返回的结果**说成功**、而取消先到 ⇒ 记录仍说真话：cancelled + error 由宿主侧补', async () => {
    // 这一类宿主「半认」signal：`abort` 之后它确实返回了，但返回的是一个成功形状的结果。
    // 只按结果落库的话，记录会说 succeeded —— 而调用方刚刚明确取消了它。
    const app: AppCallable = {
      name: 'lies-about-success',
      run: (_messages, opts) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                run: { runId: 'r1', status: 'succeeded' as const },
                result: {} as AgentRunResult,
              }),
            { once: true },
          );
        }),
    };
    const runner = new AsyncRunner(app);
    const t = runner.submit('取消我');
    await waitStatus(runner, t.taskId, 'running');
    const rec = await runner.cancel(t.taskId);
    assert.equal(rec.status, 'cancelled', '结果说成功也不算数：意图是取消');
    assert.equal(rec.error?.type, 'aborted', '原因必须补上（结果里没有 error 也要有）');
  });

  it('机制 ≠ 意图：runTimeoutMs 的那条老路**仍然**落 failed + timeout（阳性对照）', async () => {
    const app: AppCallable = {
      name: 'hang',
      run: () => new Promise<never>(() => {}),
    };
    const runner = new AsyncRunner(app, { concurrency: 1, runTimeoutMs: 30 });
    const t = runner.submit('超时');
    const rec = await runner.awaitTask(t.taskId, { timeoutMs: 2_000 });
    assert.equal(rec.status, 'failed', '超时不是取消');
    assert.equal(rec.error?.type, 'timeout', '超时仍归 timeout 一类账');
  });
});

describe('cancel —— 排队的任务：绝不起跑', () => {
  it('取消一条 queued：一次都没跑，落 cancelled，onFinished 只触发一次（不重复记账）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const app: AppCallable = {
      name: 'gated',
      async run() {
        calls++;
        if (calls === 1) await gate; // 第一个占住唯一的槽位
        return {
          run: { runId: `r-${calls}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const sinkCalls: string[] = [];
    const runner = new AsyncRunner(app, {
      concurrency: 1,
      taskSinks: [
        {
          onFinished: (rec) => {
            sinkCalls.push(rec.status);
          },
        },
      ],
    });

    const first = runner.submit('占位');
    await waitStatus(runner, first.taskId, 'running');
    const queued = runner.submit('排队中'); // concurrency=1 ⇒ 它拿不到槽位，停在 queued
    await waitStatus(runner, queued.taskId, 'queued');

    const rec = await runner.cancel(queued.taskId);
    assert.equal(rec.status, 'cancelled');
    assert.equal(calls, 1, '排队的那个**一次都没跑**（这是本次顺带补上的洞）');
    assert.deepEqual(
      sinkCalls,
      ['cancelled'],
      '恰好一次（排队那支的记账交给还活着的那趟 #execute）',
    );

    release(); // 放掉占位任务
    await runner.awaitTask(first.taskId);
    // 再等一拍：即使槽位空出来，被取消的那条也**不许**起跑
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 1, '被取消的那条始终没跑（槽位空出来也不起跑）');
    assert.equal(
      (await runner.poll(queued.taskId))?.status,
      'cancelled',
      '状态没被谁覆盖回 queued',
    );
    // ⚠️ 这一条必须放在**收尾之后**：重复通知发生在「那趟 #execute 拿到槽位」时，
    // 而那时才轮到它的 finally 跑 —— 只断言 cancel 返回那一刻会漏掉它（变异电池抓到过：零红）
    assert.equal(
      sinkCalls.filter((s) => s === 'cancelled').length,
      1,
      'onFinished 对这条取消只开火一次（两处都记账就会是两次）',
    );
  });
});

describe('cancel —— 挂起的任务：不唤醒（两种原因都算）', () => {
  it('取消一条 timer 挂起：落 cancelled、目标时刻清掉、到期扫描不再捡、工具不再跑', async () => {
    const gate = { at: Date.now() + 3_600_000 };
    const spy = { calls: 0 };
    const tool: AgentTool = {
      name: 'wait_for_batch',
      description: '等批处理作业',
      inputSchema: OBJ,
      run: (_i, ctx) => {
        spy.calls++;
        if (gate.at !== null) {
          ctx!.deferUntil!(gate.at);
          return 'deferred';
        }
        return 'ready';
      },
    };
    const { client } = mockClient([toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')]);
    const app: AppCallable = {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools: [tool], ...opts }),
    };
    const runner = new AsyncRunner(app);
    const t = runner.submit('睡到明天');
    const sleeping = await waitStatusRecord(runner, t.taskId, 'suspended');
    assert.equal(sleeping.wakeAt, gate.at);
    assert.equal(runner.suspendedSummary.timer, 1, '前提：读数里有一条在睡');

    const rec = await runner.cancel(t.taskId);
    assert.equal(rec.status, 'cancelled');
    assert.equal(rec.wakeAt, undefined, '目标时刻清掉（没有「睡着的终态」这种东西）');
    assert.equal(rec.suspendedReason, undefined);
    assert.deepEqual(
      runner.suspendedSummary,
      { approval: 0, timer: 0, nextWakeAt: null },
      '读数除名',
    );

    // 不唤醒：两条路（扫描 + 读路径）都不许把它叫起来 —— 判据是状态，翻转即失效
    assert.equal(runner.resumePending(), 0, '到期扫描不捡它（它不是「在等」，是终态）');
    assert.equal((await runner.poll(t.taskId))?.status, 'cancelled', '读路径也不唤醒');
    assert.equal(spy.calls, 1, '工具没有被叫起来第二遍');
  });

  it('取消一条审批挂起：approve 之后也推不动它（409 语义由 approve 自己的闸给）', async () => {
    const spy = { calls: 0 };
    const tool: AgentTool = {
      name: 'danger',
      description: '需审批',
      inputSchema: OBJ,
      approval: 'required',
      run: () => {
        spy.calls++;
        return 'done';
      },
    };
    const { client } = mockClient([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('批了')]);
    const app: AppCallable = {
      name: 'hitl',
      run: (messages, opts) => executeRun({ messages, client, tools: [tool], ...opts }),
    };
    const runner = new AsyncRunner(app);
    const t = runner.submit('等我批');
    await waitStatusRecord(runner, t.taskId, 'suspended');

    const rec = await runner.cancel(t.taskId);
    assert.equal(rec.status, 'cancelled');
    assert.equal(spy.calls, 0, '审批挂起时工具还没跑过（与 timer 挂起不同）');
    await assert.rejects(
      () => Promise.resolve(runner.approve(t.taskId, { tu1: { approved: true } })),
      /suspended|状态/,
      '已取消的任务不能再被审批推进（approve 的 409 闸）',
    );
    assert.equal(spy.calls, 0, '没有被审批放行');
  });
});

describe('cancel —— 409 文案：区分「本进程已受理未起跑」与「真不在本进程」', () => {
  /**
   * 同一条 409 判据（`status === 'running'` 且没有在飞句柄）下藏着**两种**情形，
   * 原文案一律说「不在本进程」—— 对第一种是说反话（2026-09-28 外部复核）。
   * 两条用例各覆盖判据的一支，缺一条就会有半边永远不被执行。
   */
  it('记录在本进程之外（多进程 / 上一世遗留的 running）：说「不在本进程」', async () => {
    const store = new InMemoryTaskStore();
    const spy = { calls: 0 };
    const { client } = mockClient([toolUseMsg('slow', {}, 's1')]);
    // 挂在 signal 上的慢工具 ⇒ 任务一直停在 running，直到被取消（与上面 engineApp 同一条纪律：
    // 宿主测试走真引擎，别用假 app 漏掉引擎与宿主的交界）
    const app: AppCallable = {
      name: 'hang',
      run: (messages, opts) =>
        executeRun({ messages, client, tools: [abortAwareTool(spy)], ...opts }),
    };
    // 「进程 A」提交占住槽位 ⇒ 记录落成 running、ownerId 是 A 的
    const a = new AsyncRunner(app, { store, concurrency: 1 });
    const t = a.submit('占住');
    await waitStatus(a, t.taskId, 'running');

    // 「进程 B」共享同一 store：它手里没有 A 的句柄，也没推进过这条任务
    const b = new AsyncRunner(app, { store });
    await assert.rejects(
      async () => b.cancel(t.taskId),
      (e: unknown) => {
        assert.ok(e instanceof TaskCancelError && e.status === 409, '仍是 409（不假装成功）');
        assert.match((e as Error).message, /不在本进程/, '这一支才是真的「不在本进程」');
        return true;
      },
      'B 有记录但没有句柄 ⇒ 只能如实说「不在本进程」',
    );

    // 阳性对照：A 自己取消成功（有句柄）—— 证明上面那条 409 不是「功能没实现」
    assert.equal((await a.cancel(t.taskId)).status, 'cancelled');
  });

  it('恢复路径卡在并发槽位上（本进程已受理、尚未起跑）：说「已在本进程受理」，不说反话', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowTool: AgentTool = {
      name: 'slow',
      description: '占住唯一槽位',
      inputSchema: OBJ,
      run: async () => {
        await gate;
        return 'ok';
      },
    };
    const dangerTool: AgentTool = {
      name: 'danger',
      description: '需审批',
      inputSchema: OBJ,
      approval: 'required',
      run: () => 'done',
    };
    const { client: slowClient } = mockClient([
      toolUseMsg('slow', {}, 's1'),
      endTurnMsg('慢的做完了'),
    ]);
    const { client: hitlClient } = mockClient([
      toolUseMsg('danger', {}, 'tu1'),
      endTurnMsg('批完继续'),
    ]);
    const app: AppCallable = {
      name: 'multi',
      run: (messages, opts) =>
        JSON.stringify(messages[0] ?? '').includes('慢')
          ? executeRun({ messages, client: slowClient, tools: [slowTool], ...opts })
          : executeRun({ messages, client: hitlClient, tools: [dangerTool], ...opts }),
    };
    const runner = new AsyncRunner(app, { concurrency: 1 });

    const hitl = runner.submit('等我批');
    await waitStatus(runner, hitl.taskId, 'suspended');
    const slow = runner.submit('慢任务'); // concurrency=1 ⇒ 它占住唯一槽位
    await waitStatus(runner, slow.taskId, 'running');

    // approve ⇒ 恢复路径**先**把状态置 running、再 #dispatch；而 #runAborts 要到
    // 拿到并发槽位才登记。槽位还在慢任务手里 ⇒ 这一瞬它是「running 但没有句柄」，
    // 且**明明在本进程**。
    await runner.approve(hitl.taskId, { tu1: { approved: true } });

    await assert.rejects(
      async () => runner.cancel(hitl.taskId),
      (e: unknown) => {
        assert.ok(
          e instanceof TaskCancelError && e.status === 409,
          '闸不放开（放开会让 onFinished 双发）',
        );
        assert.match(
          (e as Error).message,
          /已在本进程受理/,
          '它在本进程排队，就该这么写 —— 说「不在本进程」是反话',
        );
        assert.doesNotMatch((e as Error).message, /不在本进程/, '不许再说反话');
        return true;
      },
    );

    release();
    await runner.awaitTask(slow.taskId, { timeoutMs: 5_000 });
    const done = await runner.awaitTask(hitl.taskId, { timeoutMs: 5_000 });
    assert.equal(done.status, 'succeeded', '槽位空出来后它照常跑完（409 没把状态弄坏）');
  });
});

describe('cancel —— 终态与参数：说出「不行」而不是假装成功', () => {
  it('已终态 ⇒ TaskCancelError(409)，且状态与 finishedAt 都不动；不存在 ⇒ 404', async () => {
    const app: AppCallable = {
      name: 'fast',
      async run() {
        return {
          run: { runId: 'r1', status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app);
    const t = runner.submit('跑完');
    const done = await runner.awaitTask(t.taskId);
    const before = { status: done.status, finishedAt: done.finishedAt };

    await assert.rejects(
      async () => runner.cancel(t.taskId),
      (e: unknown) => e instanceof TaskCancelError && e.status === 409,
      '已终态要给 409（不静默 no-op）',
    );
    const after = await runner.poll(t.taskId);
    assert.deepEqual(
      { status: after?.status, finishedAt: after?.finishedAt },
      before,
      '409 之后记录一个字节都不动',
    );

    await assert.rejects(
      async () => runner.cancel('task_nope'),
      (e: unknown) => e instanceof TaskCancelError && e.status === 404,
    );
  });

  it('awaitTask 在 cancelled 上**立刻返回**（终态集合走单一真源 —— 漏了它会静默等到超时）', async () => {
    const gate = { at: Date.now() + 3_600_000 };
    const tool: AgentTool = {
      name: 'wait_for_batch',
      description: '等批处理作业',
      inputSchema: OBJ,
      run: (_i, ctx) => {
        ctx!.deferUntil!(gate.at!);
        return 'deferred';
      },
    };
    const { client } = mockClient([toolUseMsg('wait_for_batch', {}, 'tu1')]);
    const app: AppCallable = {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools: [tool], ...opts }),
    };
    const runner = new AsyncRunner(app);
    const t = runner.submit('睡下');
    await waitStatus(runner, t.taskId, 'suspended');
    await runner.cancel(t.taskId);

    // 判据是「立刻返回」：漏掉 cancelled 这条终态的话，这里会走满 1s 超时抛错（红成挂住）
    const started = Date.now();
    const rec = await runner.awaitTask(t.taskId, { timeoutMs: 1_000 });
    assert.equal(rec.status, 'cancelled');
    assert.ok(Date.now() - started < 1_000, '不许走满超时');
  });
});

describe('cancel —— HTTP 路由', () => {
  it('POST /tasks/<id>/cancel 生效；方法不符 405（Allow: POST）；坏 id 400 仍压不过 405；404 / 409 语义', async () => {
    // 用**时间挂起**的任务做「可取消」的样本：它没有在飞 run ⇒ cancel 立刻收尾（不涉及宽限）
    const gate = { at: Date.now() + 3_600_000 };
    const tool: AgentTool = {
      name: 'wait_for_batch',
      description: '等批处理作业',
      inputSchema: OBJ,
      run: (_i, ctx) => {
        ctx!.deferUntil!(gate.at!);
        return 'deferred';
      },
    };
    const { client } = mockClient([toolUseMsg('wait_for_batch', {}, 'tu1')]);
    const app: AppCallable = {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools: [tool], ...opts }),
    };
    const runner = new AsyncRunner(app);
    const { server, base } = await listen(app, { runner });
    try {
      const t = runner.submit('睡下');
      await waitStatus(runner, t.taskId, 'suspended');

      const ok = await fetch(`${base}/tasks/${t.taskId}/cancel`, { method: 'POST' });
      assert.equal(ok.status, 200);
      assert.equal((await readJson(ok)).status, 'cancelled');

      const wrongMethod = await fetch(`${base}/tasks/${t.taskId}/cancel`, { method: 'GET' });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get('allow'), 'POST');

      const badId = await fetch(`${base}/tasks/%zz/cancel`, { method: 'DELETE' });
      assert.equal(badId.status, 405, '方法不对就轮不到判 id（与 approve 同款排法）');

      const missing = await fetch(`${base}/tasks/task_nope/cancel`, { method: 'POST' });
      assert.equal(missing.status, 404);
      const conflict = await fetch(`${base}/tasks/${t.taskId}/cancel`, { method: 'POST' });
      assert.equal(conflict.status, 409, '已终态 ⇒ 409（第二条是幂等语义上的冲突，不是 500）');
    } finally {
      await runner.drain({ timeoutMs: 1_000 });
      await close(server);
    }
  });

  it('停机中仍可用（与 approve 同理由：停机窗口正是最想取消在飞任务的时候）', async () => {
    const gate = { at: Date.now() + 3_600_000 };
    const tool: AgentTool = {
      name: 'wait_for_batch',
      description: '等',
      inputSchema: OBJ,
      run: (_i, ctx) => {
        ctx!.deferUntil!(gate.at!);
        return 'deferred';
      },
    };
    const { client } = mockClient([toolUseMsg('wait_for_batch', {}, 'tu1')]);
    const app: AppCallable = {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools: [tool], ...opts }),
    };
    const runner = new AsyncRunner(app);
    const { server, base } = await listen(app, { runner });
    try {
      const t = runner.submit('睡下');
      await waitStatus(runner, t.taskId, 'suspended');
      const draining = runner.drain({ timeoutMs: 500 });
      const res = await fetch(`${base}/tasks/${t.taskId}/cancel`, { method: 'POST' });
      assert.equal(res.status, 200, 'drain 期间取消照常受理');
      assert.equal((await readJson(res)).status, 'cancelled');
      assert.equal(await draining, true);
    } finally {
      await close(server);
    }
  });
});

/** 与 durable-timer.test.ts 同款：拿记录而不是 void */
async function waitStatusRecord(
  runner: AsyncRunner,
  taskId: string,
  status: string,
  budgetMs = 10_000,
) {
  return (async () => {
    await waitStatus(runner, taskId, status, budgetMs);
    const rec = await runner.poll(taskId);
    assert.ok(rec, `任务应存在：${taskId}`);
    return rec;
  })();
}

/**
 * 复审收口（2026-09-28 对 #157 的复审补的三格）：
 * ① 拒绝式认 signal（abort 后 **reject**，包 fetch 类客户端的常见写法）—— 意图已在，
 *    catch 出口也得按意图落 cancelled（此前这路落 failed + error.type 'unknown'）；
 * ② 幂等去重白名单漏了 `cancelled` —— 排队取消的任务一次都没跑过，同键重提却认回
 *    那条 cancelled 记录 = 这次提交被静默吞掉；
 * ③ 挂起任务取消的记账恰好一次（`#cancelSettled` 只为 queued 而存 —— suspended 没有
 *    活着的 #execute 消费它）。
 */
describe('cancel —— 复审补的三格（2026-09-28）', () => {
  it('拒绝式认 signal（abort 后 reject）⇒ 仍落 cancelled + error.type aborted，不落 failed/unknown', async () => {
    const app: AppCallable = {
      name: 'reject-on-abort',
      run: (_messages, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(new Error('This operation was aborted')),
            { once: true },
          );
        }),
    };
    const runner = new AsyncRunner(app);
    const t = runner.submit('取消我');
    await waitStatus(runner, t.taskId, 'running');
    const rec = await runner.cancel(t.taskId);
    assert.equal(rec.status, 'cancelled', 'reject 也是「认了 signal」：意图是取消');
    assert.equal(rec.error?.type, 'aborted', '取消的结构化原因（不是 classifyError 的 unknown）');
    assert.equal((await runner.poll(t.taskId))?.status, 'cancelled', '落库的也是 cancelled');
  });

  it('同键重提一条 cancelled 任务 ⇒ 是一条新任务且**真跑**（去重不把「被取消的」当「已有」）', async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((r) => {
      releaseBlocker = r;
    });
    const ran: string[] = [];
    const app: AppCallable = {
      name: 'counting',
      run: async (messages) => {
        const tag = typeof messages[0]?.content === 'string' ? messages[0].content : '';
        if (tag === '占位') await blocker; // 占住唯一槽位，让「正事」停在 queued
        ran.push(tag);
        return {
          run: { runId: `r-${tag}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, { concurrency: 1 });
    const holder = runner.submit('占位');
    await waitStatus(runner, holder.taskId, 'running');

    const x1 = runner.submit('正事', { idempotencyKey: 'k' });
    assert.equal(x1.status, 'queued', '前置：正事卡在排队（槽位被占）');
    const cancelled = await runner.cancel(x1.taskId);
    assert.equal(cancelled.status, 'cancelled');

    const x2 = runner.submit('正事', { idempotencyKey: 'k' });
    assert.notEqual(x2.taskId, x1.taskId, '同键重提必须开新任务（认回 cancelled 那条 = 静默吞掉）');
    releaseBlocker();
    const done = await runner.awaitTask(x2.taskId);
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(ran, ['占位', '正事'], '重提的那条真跑了；x1 一次都没跑');
  });

  it('取消一条 suspended：onFinished 恰好一次（记账只由 cancel 做，没有第二处）', async () => {
    const spy = { calls: 0, script: [toolUseMsg('wait', {}, 'tu1'), endTurnMsg('不该走到')] };
    const { client } = mockClient(spy.script);
    const deferTool: AgentTool = {
      name: 'wait',
      description: '睡到明天',
      inputSchema: OBJ,
      run: (_input, ctx) => {
        spy.calls++; // 工具体被调一次（run() 的调用计数没用上，用这个钉「没醒第二次」）
        ctx!.deferUntil!(Date.now() + 3_600_000);
        return 'deferred';
      },
    };
    const app: AppCallable = {
      name: 'suspender',
      run: (messages, opts) => executeRun({ messages, client, tools: [deferTool], ...opts }),
    };
    const sinkCalls: string[] = [];
    const runner = new AsyncRunner(app, {
      taskSinks: [
        {
          onFinished: (rec) => {
            sinkCalls.push(rec.status);
          },
        },
      ],
    });
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    const rec = await runner.cancel(t.taskId);
    assert.equal(rec.status, 'cancelled');
    assert.deepEqual(sinkCalls, ['cancelled'], 'onFinished 恰好一次（双发就是记账记了两份）');
    // 挂起的取消没有活着的 #execute —— 它不会再来第二笔；给事件循环一个 tick 兜底
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sinkCalls, ['cancelled']);
    assert.equal(spy.calls, 1, '取消后不会被唤醒再跑');
  });
});
