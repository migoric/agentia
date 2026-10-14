import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, executeRun, InMemoryTaskStore } from '../../src/index.js';
import type { AgentTool, AppCallable, AgentRunResult, TaskRecord } from '../../src/index.js';
import { TaskCancelError } from '../../src/transport/async.js';
import { endTurnMsg, mockClient, toolUseMsg, waitFor } from '../helpers.js';

/**
 * cancel × 推进路径的互斥（2026-10-13 ref-cancel-mutex，spec §10）。
 *
 * 修复前两扇窗都真实存在（五路深评 B1）：
 * ① cancel(suspended) × approve 并发：两边各凭旧快照读-改-写，后写的把 cancelled
 *    覆盖成 running ⇒ 任务取消后照常执行、onFinished 双发；
 * ② cancel(queued) × 槽位释放并发：等槽位那趟 #executeInner 的 readClaimed 读到
 *    cancel 落库前的快照，照常置 running 落库 ⇒ 「被取消的排队任务绝不起跑」被打破。
 *
 * 修法（这里钉的是它们）：
 * - cancel 与三条推进路径（approve / signalTask / 到期唤醒 + 审批超时）互为对侧闸：
 *   cancel 等在飞推进收口后**重读**再判；推进路径进入前同步看 cancel 的在飞闸；
 * - `#executeInner` 起跑前的**取消意图闸**：意图在场 ⇒ 绝不起跑，记账归 cancel。
 */

const OBJ = { type: 'object', properties: {} } as const;

function hitlTool(spy: { calls: number }): AgentTool {
  return {
    name: 'danger',
    description: '需审批',
    inputSchema: OBJ,
    approval: 'required',
    run: () => {
      spy.calls++;
      return 'done';
    },
  };
}

/** 双路 app：「慢」走占槽工具（挂在 gate 上），其余走 HITL 工具 */
function multiApp(gate: Promise<void>, hitlSpy: { calls: number }): AppCallable {
  const { client: slowClient } = mockClient([toolUseMsg('slow', {}, 's1'), endTurnMsg('慢完了')]);
  const { client: hitlClient } = mockClient([
    toolUseMsg('danger', {}, 'tu1'),
    endTurnMsg('批完继续'),
  ]);
  const slowTool: AgentTool = {
    name: 'slow',
    description: '占住唯一槽位',
    inputSchema: OBJ,
    run: async () => {
      await gate;
      return 'ok';
    },
  };
  return {
    name: 'multi',
    run: (messages, opts) =>
      JSON.stringify(messages[0] ?? '').includes('慢')
        ? executeRun({ messages, client: slowClient, tools: [slowTool], ...opts })
        : executeRun({ messages, client: hitlClient, tools: [hitlTool(hitlSpy)], ...opts }),
  };
}

async function waitStatus(runner: AsyncRunner, taskId: string, status: string): Promise<void> {
  await waitFor(async2syncPolling(runner, taskId, status), `等任务 ${taskId} 进入 ${status}`);
}

/** waitFor 只收同步判据 —— poll 的取值在闭包里滚动更新 */
function async2syncPolling(runner: AsyncRunner, taskId: string, status: string): () => boolean {
  let hit = false;
  void (async () => {
    for (;;) {
      const rec = await runner.poll(taskId);
      if (rec?.status === status) {
        hit = true;
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return () => hit;
}

describe('cancel × approve 并发（互斥闸：先在飞者赢，后到者等+重读）', () => {
  it('approve 先登记 ⇒ cancel 等它收口、重读看到 running（未起跑）⇒ 409；任务照常跑完、onFinished 恰好一次', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hitlSpy = { calls: 0 };
    const sinkCalls: Array<{ taskId: string; status: string }> = [];
    const runner = new AsyncRunner(multiApp(gate, hitlSpy), {
      concurrency: 1,
      taskSinks: [
        {
          onFinished: (rec) => {
            sinkCalls.push({ taskId: rec.taskId, status: rec.status });
          },
        },
      ],
    });
    const hitl = runner.submit('等我批');
    await waitStatus(runner, hitl.taskId, 'suspended');
    const slow = runner.submit('慢任务'); // 占住唯一槽位 ⇒ 恢复段拿到 running 也起不了跑
    await waitStatus(runner, slow.taskId, 'running');

    // 同一拍：approve 先调用（同步段登记在飞闸）、cancel 紧随其后 ⇒ cancel 必须进异步等闸路径
    const approveP = runner.approve(hitl.taskId, { tu1: { approved: true } });
    const cancelP = Promise.resolve(runner.cancel(hitl.taskId));

    const approved = await approveP;
    assert.equal(approved.status, 'running', 'approve 自己的语义不变：决定齐了 ⇒ 恢复');
    await assert.rejects(
      cancelP,
      (e: unknown) => {
        assert.ok(e instanceof TaskCancelError && e.status === 409);
        assert.match((e as Error).message, /已在本进程受理/, '重读后看到的是「受理未起跑」');
        return true;
      },
      'cancel 等在飞 approve 收口、重读 ⇒ 如实 409，而不是凭旧快照落 cancelled',
    );

    release();
    const done = await runner.awaitTask(hitl.taskId);
    assert.equal(done.status, 'succeeded', 'approve 赢 ⇒ 任务照常跑完（没人把它偷偷取消）');
    assert.equal(hitlSpy.calls, 1, '恢复段恰好执行一次');
    assert.deepEqual(
      sinkCalls.filter((s) => s.taskId === hitl.taskId).map((s) => s.status),
      ['succeeded'],
      'onFinished 恰好一次、且从没有人对它说过 cancelled',
    );
  });

  it('cancel 先落地 ⇒ approve 重读看到 cancelled ⇒ 409；任务不再被审批推进', async () => {
    const hitlSpy = { calls: 0 };
    const { client } = mockClient([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('不该走到')]);
    const app: AppCallable = {
      name: 'hitl',
      run: (messages, opts) =>
        executeRun({ messages, client, tools: [hitlTool(hitlSpy)], ...opts }),
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
    const t = runner.submit('等我批');
    await waitStatus(runner, t.taskId, 'suspended');

    // 同一拍：cancel 先调用（同步 store + 无在飞推进 ⇒ 临界段原子落库）、approve 紧随其后
    const cancelP = Promise.resolve(runner.cancel(t.taskId));
    const approveP = runner.approve(t.taskId, { tu1: { approved: true } });

    assert.equal((await cancelP).status, 'cancelled');
    await assert.rejects(
      approveP,
      /状态为 cancelled/,
      'approve 的进闸重读看到 cancelled ⇒ 409（决定不落库、不派发）',
    );
    assert.equal(hitlSpy.calls, 0, '没有被审批放行');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(sinkCalls, ['cancelled'], 'onFinished 恰好一次（cancel 的那一笔）');
    assert.equal((await runner.poll(t.taskId))?.status, 'cancelled', '没人把它覆盖回去');
  });
});

describe('cancel × 槽位释放（起跑前的取消意图闸）', () => {
  /**
   * 让 readClaimed 读到**过期快照**的夹具：下一次 get 返回预先种下的旧记录。
   * 同步 store 下 cancel 的临界段是原子的，竞态窗口只能靠「读过期」复现 ——
   * 这正是异步 store（网络往返）下天然成立的形态。
   */
  class StaleOnceStore extends InMemoryTaskStore {
    readonly #stale = new Map<string, TaskRecord>();
    plantStale(rec: TaskRecord): void {
      this.#stale.set(rec.taskId, rec);
    }
    override get(taskId: string): TaskRecord | undefined {
      const s = this.#stale.get(taskId);
      if (s) {
        this.#stale.delete(taskId);
        return s;
      }
      return super.get(taskId);
    }
  }

  it('readClaimed 读到取消前的旧快照 ⇒ 意图闸拦下：绝不起跑、记账不双发、终态不被覆盖', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ran: string[] = [];
    const app: AppCallable = {
      name: 'gated',
      async run(messages) {
        const tag = typeof messages[0]?.content === 'string' ? messages[0].content : '';
        ran.push(tag);
        if (tag === '占位') await gate; // 占住唯一槽位
        return {
          run: { runId: `r-${tag}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const store = new StaleOnceStore();
    const sinkCalls: string[] = [];
    const runner = new AsyncRunner(app, {
      store,
      concurrency: 1,
      taskSinks: [
        {
          onFinished: (rec) => {
            sinkCalls.push(rec.status);
          },
        },
      ],
    });
    const holder = runner.submit('占位');
    await waitStatus(runner, holder.taskId, 'running');
    const b = runner.submit('正事');
    await waitStatus(runner, b.taskId, 'queued');
    // 种下「取消前」的旧快照（等槽位那趟的 readClaimed 将读到它）
    const staleSnapshot = await store.get(b.taskId);
    assert.equal(staleSnapshot?.status, 'queued');

    const cancelled = await runner.cancel(b.taskId);
    assert.equal(cancelled.status, 'cancelled');
    store.plantStale(staleSnapshot!);

    release(); // 槽位空出 ⇒ 等槽位那趟 #executeInner 起跑判定：读到旧快照也必须不起跑
    await runner.awaitTask(holder.taskId);
    await new Promise((r) => setTimeout(r, 50)); // 给「万一真起跑了」的推进留足时间
    assert.deepEqual(ran, ['占位'], '被取消的那条一次都没跑（意图闸拦下）');
    assert.equal(
      sinkCalls.filter((s) => s === 'cancelled').length,
      1,
      'onFinished 恰好一次（cancel 记的那笔；那趟 #execute 只走低层清理）',
    );
    assert.equal(
      (await runner.poll(b.taskId))?.status,
      'cancelled',
      '终态没被覆盖回 running/queued',
    );
  });
});
