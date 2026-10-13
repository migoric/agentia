import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AsyncRunner,
  InMemorySessionStore,
  InMemoryTaskStore,
  executeRun,
} from '../../src/index.js';
import type { AgentTool, AppCallable, MessageParam, TaskRecord } from '../../src/index.js';
import { createHttpHandler } from '../../src/transport/http.js';
import { endTurnMsg, mockClient, toolUseMsg, waitFor } from '../helpers.js';

/**
 * 时间挂起（durable timer）**宿主侧**：submit → 睡到某时刻 → 到期唤醒 → 重跑那一批。
 *
 * 三件事是本文件存在的理由（都是「不写用例就永远不知道它成立」的那类）：
 * ① 到期唤醒与审批超时是**两条互斥的闸**（原因不同）—— 互相不许越界；
 * ② `drain()` 之后不许唤醒（配套 5）：停机窗口等一条天级 run = 部署卡死；
 * ③ `/healthz` 的挂起读数（配套 6）与它的**口径**（本进程；按原因分组；空给 null 不给 0）。
 *
 * 应用侧走**真引擎**（executeRun + mockClient），与 approval.test.ts 同一条纪律：
 * 宿主测试用假 app 会漏掉「引擎与宿主的交界」，那边已经咬过人。
 */

const OBJ = { type: 'object', properties: {} } as const;

/** 等时刻的工具开关（`at === null` = 时刻到了，本次不再请求延后） */
interface Gate {
  at: number | null;
}

function timerApp(
  script: Array<Record<string, unknown>>,
  spy: { calls: number },
  gate: Gate,
): { app: AppCallable; seen: unknown[] } {
  const { client, seen } = mockClient(script);
  const tools: AgentTool[] = [
    {
      name: 'wait_for_batch',
      description: '等批处理作业',
      inputSchema: OBJ,
      run: (_input, ctx) => {
        spy.calls++;
        if (gate.at !== null) {
          ctx!.deferUntil!(gate.at);
          return 'deferred';
        }
        return 'ready';
      },
    },
  ];
  return {
    app: {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
    },
    seen,
  };
}

async function waitStatus(
  runner: AsyncRunner,
  taskId: string,
  status: string,
): Promise<TaskRecord> {
  // ⚠️ helpers 的 waitFor 只收**同步**条件（传 async 函数会让 Promise 恒 truthy、立即放行）
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

/**
 * 把记录的目标时刻**倒填**到过去 = 确定性地模拟「时间到了」。
 * 不睡墙钟：这类用例要验的是「到点这条判据成不成立」，不是「时钟走得多准」——
 * 真睡 30ms 会把「调度慢」误判成「唤醒坏了」（CI 满载下最难查的那类红）。
 */
async function backdate(runner: AsyncRunner, taskId: string, deltaMs = 1): Promise<void> {
  const rec = await runner.store.get(taskId);
  assert.ok(rec, `任务应存在：${taskId}`);
  rec.wakeAt = Date.now() - deltaMs;
  await runner.store.save(rec);
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

describe('AsyncRunner 时间挂起（durable timer）', () => {
  it('submit → 睡下：原因/目标时刻/在等的那条 tool_use 落库，不占在飞，读数进位', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const sinkCalls: string[] = [];
    // concurrency=1：挂起若占槽位，第二个任务永远排不到
    const runner = new AsyncRunner(app, {
      concurrency: 1,
      // 块体（不是表达式体）：`push` 返回 number，表达式体会让返回类型不合 TaskSink 的 `void | Promise<void>`
      taskSinks: [
        {
          onFinished: (rec) => {
            sinkCalls.push(rec.status);
          },
        },
      ],
    });

    const t1 = runner.submit('睡到明天');
    const rec = await waitStatus(runner, t1.taskId, 'suspended');
    assert.equal(rec.suspendedReason, 'timer', '挂起原因是「等一个时刻」');
    assert.equal(rec.wakeAt, gate.at, '目标时刻随记录落库（它要活得比进程久）');
    assert.deepEqual(rec.pendingApprovals, ['tu1'], '在等的是这条 tool_use');
    assert.equal(typeof rec.suspendedSince, 'number', '挂起时刻照旧落库（两条闸都用得上）');
    assert.equal(rec.finishedAt, undefined, '挂起不是终态：finishedAt 不置');
    assert.equal(runner.inFlight, 0, '挂起不占在飞计数（槽位已释放）');
    assert.deepEqual(sinkCalls, [], '挂起不触发 onFinished（它不是终态）');
    assert.deepEqual(runner.suspendedSummary, {
      approval: 0,
      timer: 1,
      nextWakeAt: gate.at,
    });

    // 槽位真空出来了：第二件事在 concurrency=1 下照常跑完
    const t2 = runner.submit('另一件');
    assert.equal((await runner.awaitTask(t2.taskId)).status, 'succeeded');
    assert.deepEqual(sinkCalls, ['succeeded'], '只有 t2 开火；t1 还在睡');
  });

  it('未到点不捡；到点唤醒并**重跑那一批**，收尾清掉挂起痕迹与读数', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const runner = new AsyncRunner(app);
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    assert.equal(runner.resumePending(), 0, '还没到点：扫描不捡它（它是「在等」，不是孤儿）');
    assert.equal((await runner.poll(t.taskId))!.status, 'suspended', '惰性路径同样不叫醒');

    await backdate(runner, t.taskId); // 时间到了
    gate.at = null; // 条件也成熟了（gate 是「批处理作业跑完了没」的替身）
    assert.equal(runner.resumePending(), 1, '到点：这一次扫描唤醒并重派');
    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(spy.calls, 2, '醒来**重跑**了那一批（gate 已放开 ⇒ 拿到真结果接着走）');
    assert.equal(done.wakeAt, undefined, '醒来后目标时刻清掉');
    assert.equal(done.suspendedReason, undefined, '挂起痕迹一并清掉');
    assert.deepEqual(
      runner.suspendedSummary,
      { approval: 0, timer: 0, nextWakeAt: null },
      '读数除名（空队列给 null 不给 0）',
    );
  });

  it('`poll()`（`GET /tasks/:id` 的读路径）自己会叫醒到点的任务 —— 惰性闸，**不经过** resumePending', async () => {
    // 为什么单独一条：到期判定有**两个**调用点 —— 全表扫描（`resumePending`）与读路径
    // （`poll` → `#lazyGates`，与审批超时那条并列）。上一条只钉了扫描那个调用点，
    // 于是「读路径也判一次」这件事在本用例之前**没有任何用例碰到**（摘掉那半行全绿）。
    // 语义上它不能省：宿主可能几小时才扫一次全表，而 `GET /tasks/:id` 是秒级的 ——
    // 到点的 run 该在**被读到时**就醒，不该等到下一次扫描。
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const runner = new AsyncRunner(app);
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    await backdate(runner, t.taskId); // 时间到了
    gate.at = null;

    // ⚠️ 本用例**一次都不调** `resumePending()`：醒来的唯一通路必须是读路径。
    // 没有它，下面这句会走满 5s 超时抛错（红），而不是断言失败。
    const done = await runner.awaitTask(t.taskId, { timeoutMs: 5_000 });
    assert.equal(done.status, 'succeeded', '读路径把到点的挂起唤醒并续跑');
    assert.equal(spy.calls, 2, '醒来重跑那一批（与扫描那条同形）');
    assert.equal(done.wakeAt, undefined, '醒来后目标时刻清掉');
    assert.deepEqual(
      runner.suspendedSummary,
      { approval: 0, timer: 0, nextWakeAt: null },
      '读数一并除名',
    );
  });

  it('drain 之后不唤醒（配套 5）；换一个进程/新 runner 扫同一份 store 则**必须**唤醒', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const store = new InMemoryTaskStore();
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '睡着的任务不挡排空（它不占在飞）');
    await backdate(runner, t.taskId, 1_000);
    assert.equal(runner.resumePending(), 0, '停机窗口里到点也不叫醒 —— 部署不该卡在天级 run 上');
    assert.equal((await runner.poll(t.taskId))!.status, 'suspended', '惰性路径也守这道闸');
    assert.equal(spy.calls, 1, '工具没有被叫起来第二遍');

    // 阳性对照（否则上面那三句可能是靠「这任务本来就醒不了」蒙对的）：
    // 新 runner + 同一个 store = 重启后新进程的首次扫描，它必须唤醒并续跑
    gate.at = null; // 条件成熟（模拟那条批处理作业终于跑完）
    const revived = new AsyncRunner(app, { store });
    assert.equal(revived.resumePending(), 1, '新进程照常唤醒（停机窗口早过去了）');
    const done = await revived.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(spy.calls, 2, '重跑那一批');
  });

  it('审批超时不误伤时间挂起（runner 级：不重派、工具不再执行）；对照：换成 approval 原因就会被兜底', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    // approvalTimeoutMs=1ms：任何「等人工」的挂起都会立刻被判超时
    const runner = new AsyncRunner(app, { approvalTimeoutMs: 1 });
    const t = runner.submit('睡到明天');
    const rec = await waitStatus(runner, t.taskId, 'suspended');
    await runner.store.save({ ...rec, suspendedSince: Date.now() - 3_600_000 }); // 挂了一小时

    const after = await runner.poll(t.taskId);
    assert.equal(after!.status, 'suspended', '配了审批超时也不许提前叫醒它');
    assert.equal(after!.wakeAt, gate.at, '目标时刻没被动过');
    assert.equal(spy.calls, 1, '没有被重派（工具不会再跑一遍）');

    // 对照：同一条记录只把**原因**换成 approval ⇒ 同一把闸立刻生效（补 deny + 重派）。
    // 恢复是异步的：触发的这一读只保证「兜底已启动」，断言要等它真落地。
    await runner.store.save({ ...after!, suspendedReason: 'approval' });
    await runner.poll(t.taskId);
    // 「被兜底重派了」的实证：timer 挂起的恢复语义是「醒来重跑那一批」⇒ 工具真再跑一次
    // （它会再次 deferUntil 睡回去 —— 终态不是本用例的对象，本用例管的是闸有没有越界/兜底）。
    await waitFor(() => spy.calls === 2, '换成 approval 原因 ⇒ 超时兜底重派，恢复段真跑了一次');
    const expired = (await runner.store.get(t.taskId))!;
    assert.equal(expired.approvals?.tu1?.approved, false, '框架兜底的拒绝（人没来）');
    assert.equal(expired.approvals?.tu1?.reason, '审批超时');
    assert.equal(expired.approvals?.tu1?.decidedBy, 'system');
  });

  it('/healthz 的 suspended 段：空载给 null；按原因分组；读数由扫描按 store 对齐', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const store = new InMemoryTaskStore();
    const runner = new AsyncRunner(app, { store });
    const { server, base } = await listen(app, { runner });
    try {
      const empty = await readJson(await fetch(`${base}/healthz`));
      assert.deepEqual(
        empty.suspended,
        { approval: 0, timer: 0, nextWakeAt: null },
        '空队列：三个位都在，nextWakeAt 是 null（**不是 0**）',
      );
      assert.equal(empty.inFlight, 0);

      const t = runner.submit('睡到明天');
      await waitStatus(runner, t.taskId, 'suspended');
      const one = await readJson(await fetch(`${base}/healthz`));
      assert.equal(one.suspended.timer, 1);
      assert.equal(one.suspended.approval, 0);
      assert.equal(one.suspended.nextWakeAt, gate.at, '/healthz 报得出「最早什么时候醒」');
      assert.equal(one.inFlight, 0, '在飞与在等是两个数（挂起不占在飞）');

      // 直接往 store 塞一条**等人工**的挂起（本用例测的是读数，不是审批路径）：
      // 读数只按本进程经手的挂起 + 每次扫描按 store 对齐 —— 所以扫描之前它**不**计入。
      store.save({
        taskId: 'task_seeded',
        status: 'suspended',
        suspendedReason: 'approval',
        pendingApprovals: ['tu-x'],
        spec: { messages: [], options: {}, source: 'async' },
        createdAt: Date.now(),
      } as unknown as TaskRecord);
      assert.equal(
        runner.suspendedSummary.approval,
        0,
        '扫描之前：读数还没对齐（口径写在 suspendedSummary）',
      );
      runner.resumePending();
      const two = await readJson(await fetch(`${base}/healthz`));
      assert.equal(
        two.suspended.approval,
        1,
        '扫描按 store 重建 ⇒ 他进程/上一世留下的挂起也进读数',
      );
      assert.equal(two.suspended.timer, 1);
      assert.equal(two.suspended.nextWakeAt, gate.at, '等审批的不参与 nextWakeAt（它没有时刻）');
    } finally {
      await runner.drain({ timeoutMs: 500 });
      await close(server);
    }
  });

  it('与候选 3 的交界：**睡着的这段时间**里工具被删掉 ⇒ 醒来时漂移信号照出（复用同一条判据）', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('醒来后收尾')],
      spy,
      gate,
    );
    const store = new InMemoryTaskStore();
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    // 睡着的这段时间里发了一次版：那个工具没了（新 runner 用空菜单 + 同一个 store）
    // 脚本给一步：重跑那一批会拿到 unknown tool 的 tool_result，模型据此收尾（第二回合）
    const { client } = mockClient([endTurnMsg('醒来后收尾')]);
    const deployed: AppCallable = {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools: [], ...opts }),
    };
    await backdate(runner, t.taskId);
    const next = new AsyncRunner(deployed, { store });
    assert.equal(next.resumePending(), 1, '到点照常唤醒');
    const done = await next.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded', '菜单漂移不改 run 的成败（既有取舍，见 spec §10 ⑧）');

    // 三处信号里的两处可机读（第三处是 console.warn，见 menu-drift.test.ts）。
    // 本用例钉的是**复用**：醒来走的是同一条续跑入口 ⇒ 同一套漂移判据自动生效，不另起一套。
    const trace = done.result!.trace;
    const drift = trace.spans.flatMap((s) => s.events.filter((e) => e.name === 'menu.drift'));
    assert.equal(drift.length, 1, '恰好一条 menu.drift 事件');
    assert.deepEqual((drift[0]!.body as { missing: string[] }).missing, ['wait_for_batch']);
    const root = trace.spans.find((s) => s.kind === 'run')!;
    assert.equal(root.attributes['menu.drift'], 'missing:wait_for_batch', 'run 根属性也在');
    assert.equal(spy.calls, 1, '工具已不在菜单里 ⇒ 一次都没再执行（unknown tool 回给模型）');
  });

  it('带 session 的任务睡下 → 醒来：会话只一份、链路续上、会话不被工具块毒化', async () => {
    // 这条钉的是 `isResume` 的判据：它原先只看 `approvals`，而**时间挂起醒来时没有任何决定** ——
    // 只认 approvals 的话，恢复段会被当成「首次执行」：① 会话历史再 prepend 一遍（token 复利、
    // 历史翻倍）；② 恢复段 trace 不 link 上一段（观测上断链）；③ 成功后把整段扩展历史
    // （含未决 tool_use）写回会话（留下孤立 tool_use，下一轮直接撞 API 400）。
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app, seen } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('最终回复')],
      spy,
      gate,
    );
    const sessionStore = new InMemorySessionStore();
    sessionStore.append('s1', [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧答复' },
    ]);
    const runner = new AsyncRunner(app, { sessionStore });
    const t = runner.submit('新指令', { options: { sessionId: 's1' } });
    const sleeping = await waitStatus(runner, t.taskId, 'suspended');
    const firstRunId = sleeping.runId!;

    await backdate(runner, t.taskId);
    gate.at = null;
    assert.equal(runner.resumePending(), 1);
    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result?.finalText, '最终回复');

    // ① 恢复段发给模型的 messages：会话历史恰好一份（翻倍就是 token 复利）
    assert.equal(seen.length, 2, '挂起段 + 恢复段各一次模型调用');
    const resumeMsgs = (seen[1] as { messages: MessageParam[] }).messages;
    assert.equal(
      resumeMsgs.filter((m) => m.content === '旧问题').length,
      1,
      '恢复段不得重复 prepend 会话历史',
    );

    // ② 链路：恢复段是一棵新 trace，经 link 挂到上一段 runId（「挂起段 → 恢复段」连成一条链）
    const root = done.result!.trace.spans.find((s) => s.kind === 'run')!;
    assert.equal(root.links?.[0]?.traceId, firstRunId, '恢复段要 link 上一段（否则观测上断链）');

    // ③ 会话 = 旧历史 + 本轮输入 + 最终回复：无 tool 块残留
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
  });
});

/**
 * drain 竞态收口（2026-09-28 复审发现）：`#wakeDue` 的 drain 闸判在「进入」时，
 * 而 `#wakeDueInner` 落库与派发之间还有两个 store 往返的窗口 —— drain 若在这窗口内
 * 完成（active===0 返回 true），被唤醒的任务会在停机**完成之后**才开跑。
 * 本条用可控闸把窗口撑开，钉住「落库之后、派发之前再判一次」。
 */
describe('drain 与到期唤醒的竞态窗口', () => {
  it('drain 在唤醒落库的窗口内完成 ⇒ 不派发（记录留 running，给下次启动的 resumePending 认领）', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const inner = new InMemoryTaskStore();
    // 可控闸：唤醒路径那一步 save（suspended → running、且 wakeAt 还在）挂起，等我们放开。
    // 其它 save（queued / 挂起时的 suspended）照常过 —— 闸只卡「唤醒落库」这一步。
    let saveHeld = false;
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((r) => {
      releaseSave = r;
    });
    const store: import('../../src/index.js').TaskStore = {
      save: (rec) => {
        if (rec.status === 'running' && rec.wakeAt !== undefined && !saveHeld) {
          saveHeld = true;
          return saveGate.then(() => inner.save(rec));
        }
        return inner.save(rec);
      },
      get: (id) => inner.get(id),
      list: () => inner.list(),
      byIdempotency: (key) => inner.byIdempotency(key),
      clear: () => inner.clear(),
    };
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');
    await backdate(runner, t.taskId, 1_000);

    assert.equal(runner.resumePending(), 1, '唤醒被接管（派发异步进行，此刻卡在 save 闸上）');
    const pollDeadline = Date.now() + 2_000;
    while (!saveHeld && Date.now() < pollDeadline) await new Promise((r) => setTimeout(r, 5));
    assert.ok(saveHeld, '前置：唤醒路径真的走到了「落库 running」这一步');

    assert.equal(
      await runner.drain({ timeoutMs: 500 }),
      true,
      '在飞为零（唤醒还卡在闸上）⇒ drain 完成',
    );
    releaseSave();
    await new Promise((r) => setTimeout(r, 50)); // 给 #wakeDueInner 走完「闸后那一段」

    assert.equal(spy.calls, 1, 'drain 完成之后不许再派发（工具没被叫第二遍）');
    const rec = await runner.store.get(t.taskId);
    assert.equal(
      rec?.status,
      'running',
      '状态已落库成 running：不派发不是丢任务 —— 下次启动的 resumePending 会认领它',
    );
  });
});

/**
 * 到期索引（2026-09-28 ⑤ 落地）：store 提供 `listDue` 时，「到期唤醒」那一半的输入
 * 走索引而不是全表过滤。这条用探针 store 钉两件事：
 * ① `listDue` 真的被用了（回退到全表 = 优化静默失效，扫描成本回到 O(全表)）；
 * ② `list()` **也**照常被调 —— 读数重建 / 审批超时 / 孤儿认领的输入仍是全表
 *    （listDue 只替代到期唤醒那一半，换掉整个输入源是另一批职责的静默退化）。
 */
describe('resumePending × listDue（到期索引接线）', () => {
  it('有 listDue 的 store：到期唤醒走它（探针断言），其余职责仍读全表', async () => {
    const inner = new InMemoryTaskStore();
    // 直接塞一条「在睡且到点」的记录（本用例测接线，不测引擎 —— 假 app 即可）
    inner.save({
      taskId: 'task_due',
      status: 'suspended',
      suspendedReason: 'timer',
      suspendedSince: Date.now() - 60_000,
      wakeAt: Date.now() - 1_000,
      pendingApprovals: ['tu1'],
      spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
      createdAt: Date.now() - 60_000,
    });
    inner.save({
      taskId: 'task_done',
      status: 'succeeded',
      spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
      createdAt: Date.now() - 60_000,
      finishedAt: Date.now() - 1_000,
    });
    const calls = { list: 0, listDue: 0 };
    const store: import('../../src/index.js').TaskStore = {
      save: (rec) => inner.save(rec),
      get: (id) => inner.get(id),
      byIdempotency: (key) => inner.byIdempotency(key),
      list: () => {
        calls.list++;
        return inner.list();
      },
      listDue: (before) => {
        calls.listDue++;
        return inner
          .list()
          .filter((r) => r.status === 'suspended' && r.wakeAt !== undefined && r.wakeAt <= before);
      },
      clear: () => inner.clear(),
    };
    let runs = 0;
    const app: AppCallable = {
      name: 'probe',
      async run() {
        runs++;
        return {
          run: { runId: 'r1', status: 'succeeded' as const },
          result: {} as import('../../src/index.js').AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, { store });

    assert.equal(runner.resumePending(), 1, '到期的那条被唤醒重派');
    assert.deepEqual(calls, { list: 1, listDue: 1 }, '到期唤醒走索引；其余职责仍走全表');
    await runner.awaitTask('task_due');
    assert.equal(runs, 1, '到期记录被真派发');
  });
});

it('listDue 的结果是到期唤醒那一半的**唯一**输入源（不是「调了它但还看全表」）', async () => {
  // 变异验证抓出来的洞：只断言「listDue 被调过」钉不住接线 —— 实现回退成 `recs`
  // （无视 listDue 的结果）时那条探针照样绿。这里的 store 刻意让 listDue 回**空**
  // （索引说「没有到期的」），而全表里明明有一条到点的 —— 接线正确 ⇒ 不捡它。
  const inner = new InMemoryTaskStore();
  inner.save({
    taskId: 'task_due',
    status: 'suspended',
    suspendedReason: 'timer',
    suspendedSince: Date.now() - 60_000,
    wakeAt: Date.now() - 1_000,
    pendingApprovals: ['tu1'],
    spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
    createdAt: Date.now() - 60_000,
  });
  let runs = 0;
  const store: import('../../src/index.js').TaskStore = {
    save: (rec) => inner.save(rec),
    get: (id) => inner.get(id),
    byIdempotency: (key) => inner.byIdempotency(key),
    list: () => inner.list(),
    listDue: () => [], // 索引说：没有到期的
    clear: () => inner.clear(),
  };
  const app: AppCallable = {
    name: 'probe',
    async run() {
      runs++;
      return {
        run: { runId: 'r1', status: 'succeeded' as const },
        result: {} as import('../../src/index.js').AgentRunResult,
      };
    },
  };
  const runner = new AsyncRunner(app, { store });
  assert.equal(runner.resumePending(), 0, '索引说没有到期的 ⇒ 一条都不捡（哪怕全表里有）');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 0, '没有派发');
  // 读记录走 store.get 而不是 poll：poll 的读路径有自己的**逐条**惰性闸（#lazyGates），
  // 它不经过 listDue（单条记录谈不上索引）—— 用 poll 断言等于亲手把它叫醒
  assert.equal(inner.get('task_due')?.status, 'suspended');
});
