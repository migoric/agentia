import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resumeSkipReason } from '../../src/transport/resume-policy.js';
import type { TaskRecord } from '../../src/store/store.js';

/** 认领判定只读 status / ownerId / startedAt / createdAt —— 不读 spec，夹具用最小形状 */
const rec = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    taskId: 't1',
    status: 'running',
    createdAt: 1_000,
    ...over,
  }) as unknown as TaskRecord;

const ME = 'proc-me';
const OTHER = 'proc-other';

describe('resume-policy —— 崩溃恢复的认领判定（从 AsyncRunner 抽出）', () => {
  it('状态不合法 ⇒ terminal；且状态**先判**（终态记录即便 ownerId 是自己也不是 own-process）', () => {
    for (const status of ['succeeded', 'failed'] as const) {
      assert.equal(
        resumeSkipReason(rec({ status }), { ownerId: ME, staleAfterMs: 0, now: 9e9 }),
        'terminal',
        status,
      );
    }
    // 挂起单列一档（2026-09-28 ref-suspend-state-reason）：一条在睡的 run **不是**终态 —— 把它报成 'terminal'
    // 是静默说错话（这个字段的全部用途就是诊断）。它的唤醒归各自那条闸管，不归崩溃续跑。
    assert.equal(
      resumeSkipReason(rec({ status: 'suspended' }), { ownerId: ME, staleAfterMs: 0, now: 9e9 }),
      'suspended',
    );
    assert.equal(
      resumeSkipReason(rec({ status: 'suspended', ownerId: ME }), {
        ownerId: ME,
        staleAfterMs: 0,
        now: 9e9,
      }),
      'suspended',
      '顺序：挂起最优先摘出（连归属都不看 —— 它根本不是我的活）',
    );
    assert.equal(
      resumeSkipReason(rec({ status: 'succeeded', ownerId: ME }), {
        ownerId: ME,
        staleAfterMs: 0,
        now: 9e9,
      }),
      'terminal',
      '顺序：先判状态再判归属',
    );
  });

  it('本进程的记录一律不碰（它一定还活着）—— 这条就是「重复执行」那个 bug 的闸', () => {
    assert.equal(
      resumeSkipReason(rec({ ownerId: ME }), { ownerId: ME, staleAfterMs: 0, now: 9e9 }),
      'own-process',
    );
    assert.equal(
      resumeSkipReason(rec({ ownerId: ME, startedAt: 0 }), {
        ownerId: ME,
        staleAfterMs: 10 ** 12,
        now: 1,
      }),
      'own-process',
      '保鲜期开了也不影响：自己的记录永远不抢',
    );
  });

  it('他进程刚起的别抢；边界是严格小于（恰好到期即可抢）', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000 };
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt: 6_000 }), opts),
      'too-fresh',
      '距今 4000ms < 5000ms',
    );
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt: 5_000 }), opts),
      undefined,
      '恰好 5000ms = 到期，可抢（严格小于）',
    );
  });

  it('起跑时间退化链 startedAt → createdAt（容忍手工塞进来的记录）', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000 };
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, createdAt: 9_000 }), opts),
      'too-fresh',
      '缺 startedAt ⇒ 退到 createdAt',
    );
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, createdAt: 1_000 }), opts), undefined);
  });

  it('staleAfterMs = 0：不看他进程的起跑时间，立刻可抢', () => {
    const opts = { ownerId: ME, staleAfterMs: 0, now: 10_000 };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 9_999 }), opts), undefined);
  });

  it('无主记录（ownerId 缺失）永远可抢 —— 否则崩溃留下的孤儿会「看起来太新」而无人捡', () => {
    const opts = { ownerId: ME, staleAfterMs: 10 ** 9, now: 10 };
    assert.equal(resumeSkipReason(rec({ createdAt: 10 }), opts), undefined);
  });

  it('可抢的常规情形：queued/running + 他进程 + 已过保鲜期', () => {
    for (const status of ['queued', 'running'] as const) {
      assert.equal(
        resumeSkipReason(rec({ status, ownerId: OTHER, startedAt: 0 }), {
          ownerId: ME,
          staleAfterMs: 1_000,
          now: 10_000,
        }),
        undefined,
        status,
      );
    }
  });
});

/**
 * 租约档（2026-09-28 T2）：`too-fresh` 是**新鲜度**（记录起跑多久了），不是**租约**
 * （主人还在不在）—— 上面对它的每条用例都过不了「主人其实死了 / 其实还在」这一层。
 * 本块钉的是：**能问到 pid 就问 pid，问不到才看时间**。
 */
describe('租约判定：同主机能问到 pid 就不看时间', () => {
  it('ownerAlive === true ⇒ owner-alive：**记录再老也不抢**（长跑被抢 = 真重复执行）', () => {
    // 回归：修复前只有新鲜度这一档。`now - startedAt` 早就超过 staleAfterMs ⇒ 返回 undefined
    // ⇒ 一条正在别的进程里老老实实跑着的长任务被本进程接手再跑一遍（副作用与花费翻倍）。
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10 ** 9, ownerAlive: () => true };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 0 }), opts), 'owner-alive');
  });

  it('ownerAlive === false ⇒ 立刻可抢：崩溃孤儿**不等保鲜期**（等就饿死）', () => {
    // 回归：修复前这条「刚起」的记录被 'too-fresh' 挡下。而前任已崩、继任启动即扫一次，
    // 扫描是**惰性**的（框架不养定时器）⇒ 扫完就再没人扫，那条记录永远停在 running。
    const opts = { ownerId: ME, staleAfterMs: 10 ** 9, now: 10, ownerAlive: () => false };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 10 }), opts), undefined);
  });

  it('ownerAlive === undefined（异主机 / 旧格式）⇒ 退回新鲜度，逐字 ≡ 升级前', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000, ownerAlive: () => undefined };
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt: 6_000 }), opts),
      'too-fresh',
      '判不了 ⇒ 还是「看起来太新」这一档',
    );
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 5_000 }), opts), undefined);
  });

  it('没接 ownerAlive（宿主不给缝）与「判不了」同义：只看保鲜期', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000 };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 6_000 }), opts), 'too-fresh');
  });

  it('staleAfterMs = 0 ⇒ **根本不问探针**（缺省语义与升级前逐字一致）', () => {
    let asked = 0;
    const opts = {
      ownerId: ME,
      staleAfterMs: 0,
      now: 10,
      ownerAlive: () => {
        asked++;
        return true;
      },
    };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 9 }), opts), undefined);
    assert.equal(asked, 0, '不看他进程就别去惊动进程表 —— 「缺省 0」得是免费的那条路');
  });

  it('无主记录不问探针：没有主人可问，它永远可抢', () => {
    let asked = 0;
    const opts = {
      ownerId: ME,
      staleAfterMs: 10 ** 9,
      now: 10,
      ownerAlive: () => {
        asked++;
        return true;
      },
    };
    assert.equal(resumeSkipReason(rec({ createdAt: 10 }), opts), undefined);
    assert.equal(asked, 0);
  });

  it('顺序：own-process 先于 owner-alive（自己的记录不该被说成「主人在」）', () => {
    // 两档的**处置一样**（都不抢），但诊断名不一样 —— 而这个字段的全部用途就是诊断。
    // 「本进程」是比「同主机某进程活着」更精确的答案，不能被更弱的判据抢答。
    assert.equal(
      resumeSkipReason(rec({ ownerId: ME, startedAt: 0 }), {
        ownerId: ME,
        staleAfterMs: 5_000,
        now: 10 ** 9,
        ownerAlive: () => true,
      }),
      'own-process',
    );
  });
});

/**
 * **时钟回拨** —— 三条时间判据里**唯一一条回拨会让系统更不安全的方向**（2026-09-29）。
 *
 * `approvalExpired` / `timerDue` 回拨后的退化都是「推迟」（等更久 / 睡更久，最坏是**变慢**）。
 * 这里不同：`now - since < staleAfterMs` 在回拨后**差值变小** ⇒ `too-fresh` **持续更久**
 * ⇒ 一个**已经崩掉的主人**留下的记录看起来「还新」⇒ **没人认领 ⇒ 孤儿饿死**。
 * 为什么饿死而不是「晚点捡起来」：`resumePending` 的扫描是**惰性**的（框架不养定时器），
 * 启动扫一次就再没人扫（这条写在 `resume-policy.ts` 头注里，也是 2026-09-28 T2 那批的靶心）。
 *
 * 缺口的精确位置：2026-09-28 加的 `owner-alive`（同主机直接问 pid）能兜住这条，
 * 但它只在 `alive !== undefined` 时参与 —— **异主机 / 升级前写下的旧格式 ownerId**
 * 仍然退回新鲜度，那就是回拨**没有兜底**的角落。两档并排钉住。
 *
 * ⚠️ **诚实标注：下面第二条（同主机那一档）不构成独立哨兵** —— 变异实测（⑤「主人已死也退回
 * 新鲜度」）会**同时**打红既有的 `ownerAlive === false ⇒ 立刻可抢` 那条。它在这里的作用是
 * **对照**（证明缺口精确地只在「判不了主人」的角落），不是多一道防线。
 */
describe('时钟回拨：新鲜度那一档的退化是「孤儿饿死」，不是「变慢」', () => {
  it('判不了主人（异主机 / 旧格式）+ 回拨 ⇒ 仍然 too-fresh（本该可抢的记录没人捡）', () => {
    const startedAt = 10 ** 12; // 主人起跑时刻
    const staleAfterMs = 5_000;
    const opts = (now: number) => ({
      ownerId: ME,
      staleAfterMs,
      now,
      ownerAlive: () => undefined, // 异主机 / 旧格式：问不出「主人还活着吗」
    });
    // 阳性对照：顺时钟、恰好到期 ⇒ 可抢。没有它，下面那句可能是「恒 too-fresh」蒙对的
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt }), opts(startedAt + staleAfterMs)),
      undefined,
      '正常时钟：恰好到期即可抢（边界是严格小于）',
    );
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt }), opts(startedAt - 3_600_000)),
      'too-fresh',
      '往回跳 1 小时 ⇒ 崩溃孤儿被保鲜期继续挡着（饿死窗口 ≈ 回拨幅度）',
    );
  });

  it('**同主机**那一档不受回拨影响：问得到 pid 就问 pid（回拨只咬「判不了」的角落）', () => {
    const startedAt = 10 ** 12;
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt }), {
        ownerId: ME,
        staleAfterMs: 5_000,
        now: startedAt - 3_600_000,
        ownerAlive: () => false, // 主人已死：**直接证据**，与记录看起来多新无关
      }),
      undefined,
      '主人死了就立刻可抢 —— 这正是「能问到 pid 就别看时间」那条纪律在回拨下的价值',
    );
  });
});
