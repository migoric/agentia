import type { MessageParam } from '../core/message.js';
import type { RunStatus } from '../core/run.js';
import type { AgentRunResult } from '../engine/types.js';
import { abortedError } from '../engine/turn.js';
import type { TaskRecord, TaskStore } from '../store/store.js';

/**
 * Agentia —— **一次 run 的结果记账**（2026-10-11 自 `transport/async.ts` 的 `#executeInner`
 * 里切出，与 `slot-pool` → `approval-policy` → `drain-gate` → `run-call-options` 同一批做法）。
 *
 * 为什么单独成件：`#executeInner` 里体量最大、也只有这里**不与在飞状态机耦合**的是三件事 ——
 *   ① **认领前重读**（`readClaimed`）：读一次 store、把「明知已终态」这一格判掉；
 *   ② **挂起出口**（`applySuspendedOutcome`）：把引擎的挂起结果搬到 `TaskRecord` 上；
 *   ③ **终态出口**（`applyTerminalOutcome`）：把终态结果搬到 `TaskRecord` 上。
 * 三件事的判据全是**局部可回答**的（只看 rec + 引擎结果），却混在一个 6 层 `try` 的 217 行方法里
 * —— 只能透过宿主行为间接观察。抽出来之后每条口径能被直接单测（挂起 × 续跑段 × 会话三档、
 * 取消 × 已有 error、事件簿记按 `eventsDelivered` 分档）。
 *
 * ## 纯的边界（照 `approval-policy.ts` 的口径）
 *
 * 入参不变则结果不变：② ③ 只改传进来的那个 `rec`，**不碰 `AsyncRunner` 的任何实例状态**。
 * 实例副作用一律**交回调用点**，且以返回值表达 —— 这不是风格偏好，见 ② 的 `sessionInputs`：
 * 「本轮用户输入」的快照必须在 `rec.spec` 被覆盖**之前**取，**取错时刻就是一个静默的错**，
 * 所以它必须是一条**类型上看得见**的返回值，而不是藏在函数体里的一个回调。
 *
 * ## ⚠️ 没搬的两样（刻意，别当漏了）
 *
 * - **`#approvals.markSuspended` / `unmarkSuspended` 不搬**：那两个是审批监督簇的读数纪律
 *   （登记 / 除名 / 按全表重建），搬过来会让本件反向依赖 `approval-supervisor.ts`。
 *   调用点紧挨着放，顺序事实写在调用点注释里。
 * - **`rec.runId` / `rec.result` / `rec.error` 的落位不搬**：那一行在两支**共用**（挂起与终态
 *   都要记），搬进任一支出身都不对，留在调用点那三行更好读。
 */

/**
 * 引擎一次 run 的落点（`{ run, result }`）—— **结构镜像** `AppCallable.run` 的返回类型。
 *
 * 为什么不 `import type { AppCallable } from './async.js'`：① 本件是被 `async.ts` 导入的，
 * 反向 import 会把依赖方向搞成环（哪怕 `import type` 运行期被擦除、数不出值环）；② 更重要的是
 * **结构镜像本身是自检的** —— 真类型一旦漂移（引擎结果换形状），`#executeInner` 的调用点立刻
 * 类型报错，不靠注释盯着。所以这里不复制任何**字段名以外**的知识：只声明本件真正读的那两处
 * （`run.status` 决定终态口径、`result` 供 `applySuspendedOutcome` 取字段）。
 */
export interface RunSettled {
  run: { runId: string; status: RunStatus };
  result: AgentRunResult;
}

/**
 * 认领前**重读一遍**再判（异步 store 交出的是副本：拿 submit 时那个对象判不出「排队期间被
 * 取消了没有」——与 `wake-policy` 的「进闸后重读」同因）。
 *
 * 不判的后果：cancel 只把状态改了，任务**照跑**（记录说 cancelled、副作用真发生 —— 最坏的
 * 一种谎）。**判据是「明知已终态就别跑」**，判定本身由调用点用 `isTerminalStatus` 做
 * （单一真源在 `core/run.ts`，本件不重复那份枚举）。
 *
 * ⚠️ 读失败**不改变既有行为**：这道闸只负责「明知已终态就别跑」，不负责把 store 读取故障
 * 升级成「任务起不来」（停机窗口里 store 已 close 是既有场景，那条路径的行为由 scheduler 的
 * 用例钉着）⇒ 返回 `undefined`，调用点**照常往下跑**。这条分支此前只存在于行内 `catch` 里，
 * 没有直接单测 —— 抽成具名件之后它有了。
 */
export async function readClaimed(
  store: TaskStore,
  rec: TaskRecord,
): Promise<TaskRecord | undefined> {
  try {
    return (await store.get(rec.taskId)) ?? rec;
  } catch {
    return undefined;
  }
}

/** `applySuspendedOutcome` 的两个环境读数 + 时钟（时钟注入的理由同 `approvalExpired`） */
export interface SuspendedOutcomeContext {
  /**
   * 本段是不是**续跑段**（不只是 HITL：时间挂起醒来也是续跑）。判据在调用方
   * （`rec.approvals !== undefined || rec.suspendedSince !== undefined`）。
   */
  isResume: boolean;
  /** 本 runner 有没有配 `sessionStore`（没有则连 `sessionId` 都不该带 —— 调用点会响亮失败） */
  hasSessionStore: boolean;
  /** 挂起时刻（`Date.now()`）—— 注入以便单测断言这个字段真的落了 */
  now: number;
}

/**
 * 挂起出口：把引擎的挂起结果搬到 `TaskRecord` 上（**逐字搬迁**，判据与注释一并搬走）。
 *
 * 返回**「本轮用户输入」的快照**（没有则 `undefined`），由调用点写进自己的
 * `sessionInputs` —— 见本文件头注：这个值必须在 `rec.spec` 被覆盖**之前**取到，所以它只能
 * 是返回值。快照的适用面三条缺一不可：只在**首个挂起段**（`!isResume`；恢复段再挂起时
 * `spec.messages` 已是扩展历史，拿它当「用户输入」就错了）、带了 `sessionId`、且 runner 真有
 * `sessionStore`。
 *
 * ⚠️ 调用点在 `await` 之后、**同一个分支里**还要做两件本件不做的事：
 * ① 把快照写进 `sessionInputs`；② `#approvals.markSuspended(rec)`（它读 `status` /
 * `suspendedReason` / `wakeAt`，所以必须在本件**之后**调用 —— 顺序是承重的）。
 */
export function applySuspendedOutcome(
  rec: TaskRecord,
  result: AgentRunResult,
  suspendedMessages: MessageParam[],
  ctx: SuspendedOutcomeContext,
): MessageParam[] | undefined {
  // HITL 挂起不是终态：槽位照常释放、onFinished 不触发、finishedAt 不置 —— 那三件事各自
  // 在自己的出口判（`#execute` 的 finally），这里只负责把记录改成「在等」的样子。
  rec.status = 'suspended';
  // 「本轮用户输入」快照必须在 overwrite **之前**取 —— 此刻 rec.spec.messages 还是原始输入；
  // 恢复段成功后由调用点的 #appendResumedSession 拿它 + finalText 补写会话。
  // 只在首个挂起段快照（!isResume）：恢复段再挂起时 spec.messages 已是扩展历史
  // （含会话前缀），拿它当「用户输入」就错了 —— 原快照仍在，不能丢。
  const snapshot =
    !ctx.isResume && rec.spec.options?.sessionId !== undefined && ctx.hasSessionStore
      ? rec.spec.messages
      : undefined;
  // 扩展后的消息历史（末尾是含未决 tool_use 的 assistant 消息）与待决清单、挂起时刻一起落库
  // —— approve / 惰性超时 / 重启后都靠它们。
  rec.spec = { ...rec.spec, messages: suspendedMessages };
  rec.pendingApprovals = result.pendingApprovals;
  rec.suspendedSince = ctx.now;
  // 挂起原因：从结果形状里取，**不写死** —— 写死成 'approval' 会让将来新增的挂起原因在落库
  // 这一步被悄悄改写成审批。
  rec.suspendedReason = result.suspendedReason;
  // 目标时刻（时间挂起才有）—— 同上，从结果形状里取，不按原因反推
  rec.wakeAt = result.wakeAt;
  // 事件簿记：**注入过**就清 —— 事件已在挂起历史里（suspendedMessages 含注入的 user 消息），
  // 簿记留着会让下次续跑**重复注入**（真探针实证过：模型看到同一事件两次）。没注入（续跑入口
  // 的再挂起出口在注入点之前返回）则必须留住 —— 清掉就是丢事件。判据是结果上的
  // `eventsDelivered` 位，不是「是不是挂起」这个粗粒度。
  if (result.eventsDelivered) rec.pendingEvents = undefined;
  return snapshot;
}

/** `applyTerminalOutcome` 的两个意图读数（都从调用点取，不在本件反推） */
export interface TerminalOutcomeContext {
  /**
   * 是否**人取消**。⚠️ 从调用点的 `#cancels` 取，**不从 signal 反推** —— 同一条 signal 有
   * 三个来源（调用方 / `runTimeoutMs` / 取消）。
   */
  cancelled: boolean;
  /** 本段是不是续跑段（决定跑成之后要不要由宿主补写会话） */
  isResume: boolean;
}

/**
 * 终态出口：把终态结果搬到 `TaskRecord` 上（**逐字搬迁**）。
 *
 * 返回**是否需要调用点补写会话**（`isResume && run.status === 'succeeded'`）—— HITL 恢复段
 * 没把 session 交给 run 层（见 `run-call-options.ts` 的注释），会话回写由宿主自己补，
 * 口径与 `runtime/run.ts` 的 `appendSession` 一致。写成返回值而不是在本件里 `await`，是为了
 * 让「本件不碰 store / 不碰实例」这条边界在类型上成立。
 *
 * ⚠️ 调用点必须在调用本件**之前**已经落好 `rec.runId` / `rec.result` / `rec.error`
 * （那三行是挂起与终态**共用**的）。
 */
export function applyTerminalOutcome(
  rec: TaskRecord,
  out: RunSettled,
  ctx: TerminalOutcomeContext,
): boolean {
  // 状态按**意图**落（超时 = failed、人取消 = cancelled）：机制与 runTimeoutMs 一字不差
  // （同一条 abort signal），差别只在意图。
  rec.status = ctx.cancelled ? 'cancelled' : out.run.status;
  // 取消必须带**结构化原因**（「取消不是失败，但原因要可查」）：宿主自定义的 AppCallable 若不认
  // signal，它照旧返回一个正常结果 ⇒ `result.error` 是空的，那时记录里也得说清「这条是被取消
  // 的」（与超时那条的账一类）。
  if (ctx.cancelled && rec.error === undefined) rec.error = abortedError();
  // 终态后清掉挂起痕迹（决定保留：审批记录是审计的一部分，随任务走）
  rec.pendingApprovals = undefined;
  rec.suspendedSince = undefined;
  rec.suspendedReason = undefined;
  rec.wakeAt = undefined;
  // 事件簿记：**终态没有第二次机会** —— 这条记录不会再被续跑，事件留着也没有注入点，清掉。
  // ⚠️ 判据与挂起分支**刻意不同**（复审第二轮把这里的注释改成真话，原先写的是「跑通到非挂起
  // 出口 ⇒ 引擎已把它们注入消息流」—— 那句在注入点**之前**就被中止/失败的出口上不成立）：
  // 挂起分支按 `eventsDelivered` 判（注入过才清、没注入要留 —— 下次续跑补上），这里无条件清。
  // 于是「恢复段在注入之前就 abort（取消 / runTimeoutMs）或整段失败」的那些终态，其事件
  // **不会**进历史 —— 既成事实，不假装「已注入」；发件方从记录的终态与 error 看得到这条 run
  // 的下场（要重试就重新提交一次：事件不跨终态重放）。
  rec.pendingEvents = undefined;
  return ctx.isResume && out.run.status === 'succeeded';
}
