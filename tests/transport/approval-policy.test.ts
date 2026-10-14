import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalExpired,
  approvalsComplete,
  fillTimeoutDenials,
} from '../../src/transport/approval-policy.js';
import type { TaskRecord } from '../../src/store/store.js';

/**
 * 夹具：纯判定只读 status / approvals / pendingApprovals / 三个时间戳与 timeoutMs，
 * **不读 spec** —— 所以这里用最小形状（不必造一条合法 RunSpec 送进引擎）。
 * 这条 `as unknown as` 是夹具的边界，不是被测面上的口子。
 */
const rec = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    taskId: 't1',
    status: 'suspended',
    // 2026-09-28 ref-suspend-state-reason：挂起记录**必须带原因**（它是状态的一部分，不是可选装饰）——
    // 夹具缺省给 'approval'，因为本文件测的就是审批这条闸
    suspendedReason: 'approval',
    spec: {},
    createdAt: 1_000,
    ...over,
  }) as unknown as TaskRecord;

describe('approval-policy —— 审批的纯判定（从 AsyncRunner 抽出）', () => {
  it('approvalExpired：timeoutMs <= 0 表示不启用（再老的挂起也不算过期）', () => {
    const r = rec({ suspendedSince: 0 });
    assert.equal(approvalExpired(r, 10 ** 12, 0), false);
    assert.equal(approvalExpired(r, 10 ** 12, -1), false);
  });

  it('approvalExpired：只在 suspended 上成立（在跑 / 终态都不算）', () => {
    for (const status of ['queued', 'running', 'succeeded', 'failed'] as const) {
      assert.equal(
        approvalExpired(rec({ status, suspendedSince: 0 }), 10 ** 12, 1_000),
        false,
        status,
      );
    }
    assert.equal(approvalExpired(rec({ suspendedSince: 0 }), 10 ** 12, 1_000), true);
  });

  it('approvalExpired：**原因**必须是 approval（时间挂起不许被审批超时提前叫醒）', () => {
    // 2026-09-28 ref-suspend-state-reason 的原因闸：`approvalTimeoutMs` 是「等人工」的闸。若只看状态，
    // 一条 reason='timer' 的睡眠 run 会被判「审批超时」，而 `#expireAndResume`
    // 紧接着就重派 —— 提前叫醒 + 花掉一次真实 run 的开销。
    const sleeping = rec({ suspendedReason: 'timer', suspendedSince: 0 });
    assert.equal(approvalExpired(sleeping, 10 ** 12, 1_000), false, 'timer 挂起永不因审批超时过期');
    // 阳性对照：同一时间戳、只把原因换成 approval ⇒ 立刻过期（证明上面那条不是真空变绿）
    assert.equal(
      approvalExpired(rec({ ...sleeping, suspendedReason: 'approval' }), 10 ** 12, 1_000),
      true,
    );
  });

  it('approvalExpired：基准链 suspendedSince → startedAt → createdAt；边界是严格大于', () => {
    const both = { suspendedSince: 5_000, startedAt: 1, createdAt: 0 };
    assert.equal(approvalExpired(rec(both), 6_000, 1_000), false, '恰好等于不叫过期（严格大于）');
    assert.equal(approvalExpired(rec(both), 6_001, 1_000), true);
    assert.equal(
      approvalExpired(rec({ startedAt: 5_000, createdAt: 0 }), 6_001, 1_000),
      true,
      '缺挂起时刻 ⇒ 退到 startedAt',
    );
    // 夹具默认 createdAt=1000：要证明「退到 createdAt」，now 得比它多出**超过** timeoutMs
    assert.equal(
      approvalExpired(rec({}), 2_000, 1_000),
      false,
      '恰好超时量不算过期（退到 createdAt）',
    );
    assert.equal(approvalExpired(rec({}), 2_001, 1_000), true, '两个都缺 ⇒ 退到 createdAt');
  });

  it('fillTimeoutDenials：只补空着的待决项，人工决定一律保留（第一次决定赢）', () => {
    const r = rec({
      suspendedSince: 7_000,
      pendingApprovals: ['a', 'b'],
      approvals: {
        a: { approved: true, decidedBy: 'alice', decidedAt: 7_500, requestedAt: 7_000 },
      },
    });
    fillTimeoutDenials(r, 9_000);
    assert.deepEqual(
      r.approvals?.a,
      { approved: true, decidedBy: 'alice', decidedAt: 7_500, requestedAt: 7_000 },
      '人工「批准」绝不能被超时兜底翻成 deny',
    );
    assert.deepEqual(r.approvals?.b, {
      approved: false,
      reason: '审批超时',
      decidedBy: 'system',
      decidedAt: 9_000,
      requestedAt: 7_000,
    });
  });

  it('fillTimeoutDenials：approvals 缺失时建表；无挂起时刻则不写 requestedAt；无待决项是空操作', () => {
    const r = rec({ pendingApprovals: ['x'] });
    fillTimeoutDenials(r, 100);
    assert.deepEqual(r.approvals, {
      x: { approved: false, reason: '审批超时', decidedBy: 'system', decidedAt: 100 },
    });
    const empty = rec({});
    fillTimeoutDenials(empty, 100);
    assert.deepEqual(empty.approvals, {});
  });

  it('approvalsComplete：每个待决 id 都要有决定；空集为真（与抽取前的行内写法一致）', () => {
    assert.equal(
      approvalsComplete(
        rec({ pendingApprovals: ['a'], approvals: { a: { approved: false, decidedAt: 1 } } }),
      ),
      true,
    );
    assert.equal(
      approvalsComplete(
        rec({ pendingApprovals: ['a', 'b'], approvals: { a: { approved: false, decidedAt: 1 } } }),
      ),
      false,
      '缺一个就是没齐',
    );
    assert.equal(
      approvalsComplete(rec({ pendingApprovals: ['a'] })),
      false,
      'approvals 缺失 ⇒ 未齐',
    );
    assert.equal(approvalsComplete(rec({})), true, '没有待决项 ⇒ 齐（空集真值）');
  });
});

/**
 * **时钟回拨**（NTP 回拨 / 手动校时）—— 2026-09-29。
 *
 * 为什么单独成块：全仓对回拨**已有一条成文纪律，但它是局部的** —— 只在「算耗时的暴露面」
 * 钳到 0（`engine/turn.ts` 的 `waitedMs = Math.max(0, decidedAt - requestedAt)`、
 * `engine/tool-events.ts` 的 `durationMs` 非负、`core/timeout.ts` 用 `performance.now` 量耗时）。
 * 而**比时刻**的三个纯判定（`approvalExpired` / `timerDue` / `resumeSkipReason` 的新鲜度）
 * **不做**单调兜底，也不该在这里做：它们手里只有墙钟，单调兜底要有时钟来源，那是编排层的事
 * （= 被记为「有意不做」的定时器注入缝，见 `docs/reviews/2026-09-28/README.md` §4 第 2 条）。
 *
 * 所以本块钉的是**方向**，不是修法：回拨把已过期的挂起判回「未过期」= **推迟**方向
 * （与「提前自动拒绝 + 重派」相反），且这个事实**必须留在数据里**。方向被「顺手修」反了、
 * 或回拨的事实被抹掉，这里就红。
 */
describe('approval-policy —— 时钟回拨（NTP 回拨 / 跳变）', () => {
  it('回拨把**已过期**判回**未过期**：退化方向是「推迟」，不是「提前拒绝」', () => {
    const r = rec({ suspendedSince: 10 ** 12 });
    assert.equal(approvalExpired(r, 10 ** 12 + 2_000, 1_000), true, '正常时钟：早已过期');
    assert.equal(
      approvalExpired(r, 10 ** 12 - 3_600_000, 1_000),
      false,
      '往回跳 1 小时 ⇒ 判回未过期（那条挂起多等一段，而不是被提前自动拒绝 + 重派）',
    );
  });

  it('回拨把 now 落到挂起时刻**之前**：差值变负，结论仍然只是「未过期」', () => {
    assert.equal(approvalExpired(rec({ suspendedSince: 10 ** 12 }), 10 ** 12 - 1, 1_000), false);
  });

  it('`fillTimeoutDenials` **如实记下**回拨（decidedAt 可以早于 requestedAt）—— 判据层不许钳', () => {
    // 若在这里「顺手」把 decidedAt 抬到 requestedAt（`Math.max(now, suspendedSince)`），
    // 回拨这件事就从数据里消失了：trace 上那次审批看着像「瞬间决定」，
    // 而下游 `waitedMs` 的 `Math.max(0, …)` 本来就兜得住负数 ⇒ 钳在判据层纯属抹掉证据。
    const rolledBack = 10 ** 12 - 3_600_000;
    const r = rec({ suspendedSince: 10 ** 12, pendingApprovals: ['a'] });
    fillTimeoutDenials(r, rolledBack);
    assert.equal(r.approvals?.a?.decidedAt, rolledBack, '记当时读到的 now（回拨后的值）');
    assert.equal(
      r.approvals?.a?.requestedAt,
      10 ** 12,
      'requestedAt 是事实（挂起时刻），不许被改小',
    );
    assert.ok(
      (r.approvals?.a?.decidedAt ?? 0) < (r.approvals?.a?.requestedAt ?? 0),
      '负差值留在数据里：decidedAt < requestedAt（下游钳 0，见 engine/turn.ts 的 approval.decided）',
    );
  });
});
