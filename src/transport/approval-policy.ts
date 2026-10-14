/**
 * HITL 审批的**纯判定** —— 从 AsyncRunner 里抽出的第二个协作件（第一步是 slot-pool.ts）。
 *
 * 为什么单独成件：审批这一带是 0.7.1 → 0.7.2 连续竞态的发生地，而它混着两类东西 ——
 *   ① **纯判定**（超时了吗 / 把空着的待决项补成拒绝 / 决定齐了没）：只吃 rec + now + timeoutMs，
 *      不碰 store、不起定时器、不认识引擎回调；
 *   ② **编排**（进在飞闸、重读一遍、先落库再派发）：留在 AsyncRunner（`#expireAndResume` 等）。
 * 把①抽出来，是为了让「判错就出事」的规则能被直接单测，而不是只能透过宿主行为间接观察。
 * ②的那几条纪律（与 approve 共用同一把在飞闸、先落库再派发）**一字未改**。
 *
 * 纯的边界：入参不变则结果不变；`fillTimeoutDenials` 只改传进来的那个 rec（落库由调用方负责）。
 */
import type { TaskRecord } from '../store/store.js';

/**
 * 审批超时判定（HITL，**惰性**：不起定时器，只在 approve / poll / resumePending 读到
 * awaiting 记录时判）。基准是 `suspendedSince`（挂起时刻，挂起时落库）；缺失时按
 * startedAt → createdAt 退化（容忍手工塞进来的记录）。`timeoutMs <= 0` = 不启用超时；
 * 边界是**严格大于**（恰好等于不算过期）。
 */
export function approvalExpired(rec: TaskRecord, now: number, timeoutMs: number): boolean {
  return (
    timeoutMs > 0 &&
    rec.status === 'suspended' &&
    // ⚠️ 必须再卡**原因**（2026-09-28 ref-suspend-state-reason）：`approvalTimeoutMs` 是「等人工」的闸，
    // 拿它去判一条在等时刻的 run（reason='timer'）＝ 提前叫醒它，而且
    // `#expireAndResume` 紧接着就重派（补不出任何 deny 决定，因为它没有待决项）。
    rec.suspendedReason === 'approval' &&
    now - (rec.suspendedSince ?? rec.startedAt ?? rec.createdAt) > timeoutMs
  );
}

/**
 * 超时自动拒绝：**仍空着的**待决项补上 deny（已有人工决定的不覆盖 —— 第一次决定赢）。
 * 决定写进 `rec.approvals`，由调用方负责落库与重派。
 */
export function fillTimeoutDenials(rec: TaskRecord, now: number): void {
  rec.approvals ??= {};
  for (const id of rec.pendingApprovals ?? []) {
    if (rec.approvals[id]) continue;
    rec.approvals[id] = {
      approved: false,
      reason: '审批超时',
      decidedBy: 'system',
      decidedAt: now,
      ...(rec.suspendedSince !== undefined ? { requestedAt: rec.suspendedSince } : {}),
    };
  }
}

/**
 * 决定齐了没：**每个**待决 id 都有决定（人工或超时兜底）。没有待决项时返回 true
 * （空集真值）—— 与抽取前的行内写法逐字一致。
 */
export function approvalsComplete(rec: TaskRecord): boolean {
  return (rec.pendingApprovals ?? []).every((id) => rec.approvals?.[id] !== undefined);
}
