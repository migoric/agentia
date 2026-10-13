import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalSupervisor } from '../../src/transport/approval-supervisor.js';
import { ResumeScanner } from '../../src/transport/resume-scanner.js';
import type { ResumeScannerDeps } from '../../src/transport/resume-scanner.js';
import type { TaskRecord, TaskStore } from '../../src/store/store.js';

/**
 * 恢复路径的落库失败防护（2026-10-13 ⑩⑪）：
 * ① resumePending 的认领 save 对**同步抛错**无防护（同文件 wakeDue 有）—— FileTaskStore
 *    磁盘失败时异常逃出 resumePending，引用语义 store 下「queued + 本进程 ownerId」的变异
 *    已进内存 ⇒ 后续扫描按 own-process 跳过 ⇒ 任务搁死到重启；
 * ② 两处恢复（审批超时 / 到期唤醒）落库失败**静默**留尸 —— catch 裸 return，无 warn。
 *
 * 直接构造监督件（stub store + spy dispatch），不走完整 runner：
 * 这些判据是局部可回答的，过宿主只会把「哪里红了」藏起来。
 */

function rec(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task_x',
    status: 'queued',
    spec: { messages: [{ role: 'user', content: '活' }] },
    createdAt: 1_000,
    ...overrides,
  };
}

/** 捕获 console.warn；返回读数与还原函数 */
function captureWarn(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  return { warns, restore: () => (console.warn = orig) };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** 组装一个 ResumeScanner：store 行为由参数定制，dispatch 是 spy */
function makeScanner(
  store: Partial<TaskStore>,
  cancelInflight?: () => Promise<unknown>,
): {
  scanner: ResumeScanner;
  approvals: ApprovalSupervisor;
  dispatched: TaskRecord[];
} {
  const dispatched: TaskRecord[] = [];
  const full: TaskStore = {
    save: () => {},
    get: () => undefined,
    byIdempotency: () => undefined,
    list: () => [],
    clear: () => {},
    ...store,
  };
  const approvals = new ApprovalSupervisor({
    store: full,
    ownerId: 'p1@h-self',
    approvalTimeoutMs: 0,
    dispatch: (r) => dispatched.push(r),
  });
  const deps: ResumeScannerDeps = {
    store: full,
    ownerId: 'p1@h-self',
    host: 'h',
    approvals,
    dispatch: (r) => dispatched.push(r),
    isDraining: () => false,
    ...(cancelInflight !== undefined ? { cancelInflight } : {}),
  };
  return { scanner: new ResumeScanner(deps), approvals, dispatched };
}

describe('resumePending 认领落库失败（B3：同步抛错防护）', () => {
  it('认领 save 同步抛错：不逃出 resumePending、不派发、warn 出来、不计入推进数', () => {
    const orphan = rec({ taskId: 'task_orphan', ownerId: 'p9@h-other' }); // 他进程孤儿 ⇒ 可认领
    const { scanner, dispatched } = makeScanner({
      list: () => [orphan],
      save: () => {
        throw new Error('disk full');
      },
    });
    const { warns, restore } = captureWarn();
    try {
      // 修复前：同步抛出逃出 resumePending（宿主启动路径直接崩）
      const n = scanner.resumePending();
      assert.equal(n, 0, '没落库 = 没推进（返回值是「推进了几条」的承诺）');
      assert.equal(dispatched.length, 0, '先落库再派发：落不了库绝不派发');
      assert.ok(
        warns.some((w) => w.includes('认领落库失败') && w.includes('task_orphan')),
        `静默留尸不可接受（#dispatch 的停机拒绝都有一次性 warn）—— 实际 warns: ${JSON.stringify(warns)}`,
      );
    } finally {
      restore();
    }
  });

  it('认领 save 异步 reject：resumePending 照常 resolve（不整批炸）、不派发、warn', async () => {
    const orphan = rec({ taskId: 'task_orphan', ownerId: 'p9@h-other' });
    const { scanner, dispatched } = makeScanner({
      list: () => Promise.resolve([orphan]),
      save: () => Promise.reject(new Error('connection reset')),
    });
    const { warns, restore } = captureWarn();
    try {
      const n = await scanner.resumePending();
      assert.equal(n, 0);
      assert.equal(dispatched.length, 0);
      assert.ok(warns.some((w) => w.includes('认领落库失败')));
    } finally {
      restore();
    }
  });

  it('阳性对照：save 正常时认领 → 派发照常（防「防护把正路也焊死」）', () => {
    const saved: TaskRecord[] = [];
    const orphan = rec({ taskId: 'task_orphan', ownerId: 'p9@h-other' });
    const { scanner, dispatched } = makeScanner({
      list: () => [orphan],
      save: (r) => void saved.push(r),
    });
    assert.equal(scanner.resumePending(), 1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.ownerId, 'p1@h-self', '认领落库的是本进程 ownerId');
  });
});

describe('到期唤醒 / 审批超时的落库失败：不静默留尸（低等项补 warn）', () => {
  const sleeping = (): TaskRecord =>
    rec({
      taskId: 'task_sleep',
      status: 'suspended',
      suspendedReason: 'timer',
      suspendedSince: 500,
      wakeAt: 900, // 早已到点
    });

  it('wakeDue 落库同步抛错：不派发、warn 出来、记录不装醒', async () => {
    const recs = sleeping();
    const { scanner, dispatched } = makeScanner({
      get: () => recs,
      save: () => {
        throw new Error('disk full');
      },
    });
    const { warns, restore } = captureWarn();
    try {
      assert.equal(scanner.wakeDue(sleeping(), 1_000), true, '接管了这次唤醒（进闸了）');
      await flush();
      assert.equal(dispatched.length, 0, '落不了库就不派发');
      assert.ok(warns.some((w) => w.includes('到期唤醒落库失败') && w.includes('task_sleep')));
    } finally {
      restore();
    }
  });

  it('wakeDue 落库异步 reject：同样 warn + 不派发（两个分支各钉一个）', async () => {
    const { scanner, dispatched } = makeScanner({
      get: () => sleeping(),
      save: () => Promise.reject(new Error('connection reset')),
    });
    const { warns, restore } = captureWarn();
    try {
      scanner.wakeDue(sleeping(), 1_000);
      await flush();
      assert.equal(dispatched.length, 0);
      assert.ok(warns.some((w) => w.includes('到期唤醒落库失败')));
    } finally {
      restore();
    }
  });

  it('审批超时恢复落库失败：不派发、warn 出来', async () => {
    const awaiting = rec({
      taskId: 'task_hitl',
      status: 'suspended',
      suspendedReason: 'approval',
      suspendedSince: 100,
      pendingApprovals: ['tu1'],
    });
    const dispatched: TaskRecord[] = [];
    const store: TaskStore = {
      get: () => awaiting,
      save: () => {
        throw new Error('disk full');
      },
      byIdempotency: () => undefined,
      list: () => [],
      clear: () => {},
    };
    const supervisor = new ApprovalSupervisor({
      store,
      ownerId: 'p1@h-self',
      approvalTimeoutMs: 1, // 任何 awaiting 都立刻过期
      dispatch: (r) => dispatched.push(r),
    });
    const { warns, restore } = captureWarn();
    try {
      assert.equal(supervisor.expireIfExpired(awaiting, 1_000), true, '命中了超时判定');
      await flush();
      assert.equal(dispatched.length, 0, '落不了库就不派发（先落库再派发）');
      assert.ok(warns.some((w) => w.includes('审批超时恢复落库失败') && w.includes('task_hitl')));
    } finally {
      restore();
    }
  });
});

describe('cancel 在飞时，惰性推进路径跳过本轮（cancel × 推进互斥的那一侧）', () => {
  const sleeping = (): TaskRecord =>
    rec({
      taskId: 'task_sleep',
      status: 'suspended',
      suspendedReason: 'timer',
      suspendedSince: 500,
      wakeAt: 900,
    });

  it('wakeDue：cancelInflight 在场 ⇒ 返回 false（没接管），不进闸不派发；无 cancel 在飞 ⇒ 照常接管（阳性对照）', () => {
    const withCancel = makeScanner({ get: () => sleeping() }, () => Promise.resolve());
    const without = makeScanner({ get: () => sleeping() });
    assert.equal(
      withCancel.scanner.wakeDue(sleeping(), 1_000),
      false,
      'cancel 在飞 ⇒ 跳过本轮（惰性路径下轮再判）',
    );
    assert.equal(withCancel.dispatched.length, 0);
    assert.equal(without.scanner.wakeDue(sleeping(), 1_000), true, '无 cancel 在飞 ⇒ 照常接管');
  });

  it('expireIfExpired：cancelInflight 在场 ⇒ 返回 false，不进闸', async () => {
    const awaiting = rec({
      taskId: 'task_hitl',
      status: 'suspended',
      suspendedReason: 'approval',
      suspendedSince: 100,
      pendingApprovals: ['tu1'],
    });
    const dispatched: TaskRecord[] = [];
    const supervisor = new ApprovalSupervisor({
      store: {
        get: () => awaiting,
        save: () => {},
        byIdempotency: () => undefined,
        list: () => [],
        clear: () => {},
      },
      ownerId: 'p1@h-self',
      approvalTimeoutMs: 1,
      dispatch: (r) => dispatched.push(r),
      cancelInflight: () => Promise.resolve(),
    });
    assert.equal(supervisor.expireIfExpired(awaiting, 1_000), false, 'cancel 在飞 ⇒ 跳过本轮');
    await flush();
    assert.equal(dispatched.length, 0);
  });
});
