import type { AgentApp, AsyncRunner, ModelClient, TaskRecord } from '@migor/agentia';
import { TICKETS_SCHEMA } from './agents.js';
import type { Ticket } from './agents.js';

/**
 * 编排核心 —— 这个示例唯一「聪明」的地方，全部集中在**一个文件**里。
 *
 * 形状（对应 Super-agent 的 Router / Worker 双层）：
 *
 *   Router（一次短 run）
 *     └─ submit × N ──→ AsyncRunner 的任务队列
 *                          ├─ Worker A ─┐
 *                          ├─ Worker B ─┤ 各自一个独立 run、独立上下文、独立并发槽
 *                          └─ Worker C ─┘（其中需要写操作的会挂起等人批）
 *     └─ 等全部落地 → 汇总阅读 TaskRecord.result
 *
 * 三条**结构性**选择，写在这里是因为它们决定「算不算 Super-agent」：
 *
 * ① **Worker 走 task，不走 `@SubAgent`。**
 *    `@SubAgent` 是同步工具调用：主 agent 阻塞等它、跟着主 run 的取消走、报告回流主上下文，
 *    且**不受** `contextPolicy` 管（长跑必撞上下文上限）、**不支持**审批挂起、崩溃后没有
 *    `TaskRecord` 可捡。这四条正好是 Worker 的四条刚需 ⇒ 拿子 agent 当 Worker 是这套架构
 *    唯一的结构性陷阱。
 *
 * ② **汇总要自己写，因为 `suspended` 不是终态。**
 *    `awaitTask` 等的是终态；一个挂起等人批的任务永远是 `suspended` ⇒ 直接 await 会一路等到
 *    超时（缺省 30s），然后你得到「超时」而不是「在等人」。所以下面用一个**看得见状态的**
 *    轮询：终态就收、挂起就找人批、其余继续等。
 *
 * ③ **多棵树靠 `traceContext` 连成链。**
 *    Router 与每个 Worker 各自一棵（`traceId == runId`），Worker 的 run 根带一条 link 指回
 *    Router —— 于是观测后端上「一个目标」是一串相关的链，而不是 N 条孤立的 run。
 *    挂起/恢复又是两棵（恢复段 link 到挂起段），所以一个 fix 工单最终会看到 3 棵树。
 */

/** 任务的终态集合 —— **`suspended` 不在里面**（它在等人，不是终态） */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export interface RunGoalOptions {
  /** 用户那句话 */
  goal: string;
  /**
   * 这条消息的 id —— 幂等键的前缀。
   * 同一条消息被重投（网关重试 / 双击）时用它去重，不会重复开工。
   */
  goalId: string;
  router: AgentApp;
  /**
   * 工单类型 → 承载它的 runner。
   *
   * 为什么是**两个 runner 而不是一个**：`AsyncRunner` 在构造期绑定一个 app，
   * 而 repro / fix 是两个菜单不同的 app（隔离写工具）。两个 runner **共用一个 store**
   * 就够了 —— 框架按 `ownerId` 区分任务归属，同进程多 runner 共库是受支持的形状
   * （也是「按工单类型给不同并发/超时」的自然落点）。
   *
   * ⚠️ 别想着用一个 runner + 一个「什么都装」的 app 来省事：那等于把写工具暴露给
   * 只该读的工单，菜单隔离就没了。
   */
  runners: Record<Ticket['kind'], AsyncRunner>;
  /** demo 用：Router 自己的 scriptedClient（真跑不传，走 app 的模型名） */
  routerClient?: ModelClient;
  /**
   * 给每个工单指定 model client。
   * **只给离线 demo 用**（scriptedClient 是有状态的，并行任务必须各持一份）。
   * 真跑别传这个：`client` 是进程内对象，随 `TaskRecord` 落库会丢（见 usage-guide §4 的 fallbacks 说明）。
   */
  clientFor?: (ticket: Ticket) => ModelClient | undefined;
  /**
   * 工单挂起时的审批回调：返回 true 批准、false 拒绝。
   * **不给 = 一律拒绝** —— 不可逆动作没人批就不做，这是安全侧的缺省。
   */
  onApproval?: (args: {
    ticket: Ticket;
    taskId: string;
    pending: string[];
  }) => Promise<{ approved: boolean; reason?: string; decidedBy?: string }>;
  /** 单个工单从派发到终态的预算；超了以 `failed` 记（不无限等） */
  ticketTimeoutMs?: number;
  /** 轮询间隔（生产 250ms 起；demo 会调小） */
  pollIntervalMs?: number;
}

export interface TicketOutcome {
  ticket: Ticket;
  taskId: string;
  status: TaskRecord['status'];
  /** Worker 的最终报告（隔离报告：中间往返不进 Router 上下文，只有这一段回流） */
  summary: string;
  /** 这个工单涉及的所有 runId —— 挂起 + 恢复各一段，故可能不止一个 */
  runIds: string[];
}

export interface GoalOutcome {
  /** Router 那棵树的 id —— Worker 的 link 都指向它 */
  routerRunId: string;
  /** Router 拆出来的工单（已经过业务校验） */
  plan: Ticket[];
  outcomes: TicketOutcome[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 工单 → 交给 Worker 的那段任务说明。
 *
 * ⚠️ `runner.submit` 的入参**只接受** `string` / `MessageParam[]` /
 * `{ prompt? text? messages? }`（`normalizeMessages` 的口径）—— 直接塞一个对象会被
 * `TaskInputError` 拒掉（`submit` 是同步的，错误当场抛）。所以工单信息要**写成人话**，
 * 这也正好是对的：Worker 拿到的应该是「一份任务说明」，不是「一个内部数据结构」。
 */
function formatTicket(ticket: Ticket): string {
  const kind = ticket.kind === 'repro' ? '只读排查' : '需要改代码（写操作会走人工审批）';
  return [`工单 ${ticket.id}（${kind}）`, `目标：${ticket.goal}`].join('\n');
}

/**
 * 业务校验 —— **结构化结果仍然要自己校**。
 *
 * `resultSchema` 只保证「形状符合 JSON Schema」（字段在、类型对、enum 合法），
 * 它管不到「id 是否唯一」「tickets 是否为空」这类**业务不变量**。
 * 少了这一步，一个把两个工单都叫 T1 的模型会静默覆盖幂等键 —— 两单合一，你只会看到「少跑了一个」。
 */
function validatePlan(raw: unknown): Ticket[] {
  const tickets = (raw as { tickets?: unknown })?.tickets;
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error('Router 没有拆出任何工单（tickets 为空）');
  }
  const seen = new Set<string>();
  return tickets.map((t, i) => {
    const ticket = t as Partial<Ticket>;
    if (typeof ticket.id !== 'string' || ticket.id.length === 0) {
      throw new Error(`第 ${i + 1} 个工单缺少 id`);
    }
    if (ticket.kind !== 'repro' && ticket.kind !== 'fix') {
      throw new Error(`工单 ${ticket.id} 的 kind 非法：${String(ticket.kind)}`);
    }
    if (typeof ticket.goal !== 'string' || ticket.goal.length === 0) {
      throw new Error(`工单 ${ticket.id} 缺少 goal`);
    }
    if (seen.has(ticket.id)) throw new Error(`工单 id 重复：${ticket.id}`);
    seen.add(ticket.id);
    return { id: ticket.id, kind: ticket.kind, goal: ticket.goal };
  });
}

/**
 * 派发一个工单 → 等它**落地**（终态，或挂起后被人批完再落地）。
 *
 * 这里就是选择 ② 的落点：不用 `awaitTask`，因为它不认识 `suspended`。
 */
async function settle(
  runner: AsyncRunner,
  opts: RunGoalOptions,
  ticket: Ticket,
  taskId: string,
): Promise<TaskRecord> {
  const deadline = Date.now() + (opts.ticketTimeoutMs ?? 10 * 60_000);
  const interval = opts.pollIntervalMs ?? 250;
  for (;;) {
    const rec = await runner.poll(taskId);
    if (!rec) throw new Error(`任务不存在：${taskId}`);
    if (TERMINAL.has(rec.status)) return rec;

    if (rec.status === 'suspended') {
      const pending = rec.pendingApprovals ?? [];
      const decision = opts.onApproval
        ? await opts.onApproval({ ticket, taskId, pending })
        : { approved: false, reason: '没有配置审批人（不可逆动作默认拒绝）' };
      // 待决清单必须**给齐**：多给一个 key 会被整批拒（400），少给则继续挂起
      await runner.approve(
        taskId,
        Object.fromEntries(
          pending.map((id) => [
            id,
            {
              approved: decision.approved,
              ...(decision.reason ? { reason: decision.reason } : {}),
            },
          ]),
        ),
        decision.decidedBy ? { decidedBy: decision.decidedBy } : {},
      );
      continue; // 恢复段重新派发 ⇒ 回到轮询
    }

    if (Date.now() > deadline) {
      throw new Error(
        `工单 ${ticket.id} 等待超时（当前状态 ${rec.status}，已等 ${opts.ticketTimeoutMs ?? 600_000}ms）`,
      );
    }
    await sleep(interval);
  }
}

export interface DispatchedTicket {
  ticket: Ticket;
  taskId: string;
  /** 该工单归属哪个 runner（审批时必须找回同一个 runner，见 README「坑 5」） */
  runner: AsyncRunner;
}

export interface DispatchOutcome {
  routerRunId: string;
  plan: Ticket[];
  dispatched: DispatchedTicket[];
}

/**
 * 只**派发**，不等结果 —— 真服务（`npm start`）用这个：HTTP 请求立刻 202 返回，
 * 工单在后台跑，客户端轮询 `GET /goal/:id` 或各自的 `/tasks/:id`。
 *
 * `runGoal` = 这个 + settle，demo 用后者（它要在一次进程里跑完并断言）。
 */
export async function dispatchGoal(opts: RunGoalOptions): Promise<DispatchOutcome> {
  // —— ① Router：一次短 run，产出可校验的工单清单 ——
  const planned = await opts.router.run([{ role: 'user', content: opts.goal }], {
    resultSchema: TICKETS_SCHEMA,
    labels: { stage: 'router', goal: opts.goalId },
    ...(opts.routerClient ? { client: opts.routerClient } : {}),
  });
  if (planned.result.error) {
    throw new Error(`Router 失败（${planned.result.stopReason}）：${planned.result.error.message}`);
  }
  const plan = validatePlan(planned.result.typed);
  const routerRunId = planned.run.runId;

  // —— ② 派发：一单一 task，幂等键防重投，trace 挂到 Router 那棵树下 ——
  const dispatched = plan.map((ticket) => {
    const runner = opts.runners[ticket.kind];
    const rec = runner.submit(
      { prompt: formatTicket(ticket) },
      {
        idempotencyKey: `${opts.goalId}:${ticket.id}`,
        options: {
          // ⚠️ 这里**刻意不传 sessionId**：Worker 是一次性工单，不需要跨轮记忆。
          // 真需要时不给 runner 配 `sessionStore` 会被当场拒 —— 「任务带了 options.sessionId，
          // 但本 runner 未配 sessionStore」（submit 是同步的，错误立刻抛，不会静默丢历史）。
          // 需要会话的只有 Router 那条「用户视角的线」，它走 app.run 的 session 选项。
          labels: { stage: 'worker', goal: opts.goalId, ticket: ticket.id, kind: ticket.kind },
          // 关键：把 Worker 的 run 根 link 回 Router 那棵树（跨 run 关联的唯一通道）
          traceContext: { traceId: routerRunId },
          ...(opts.clientFor?.(ticket) ? { client: opts.clientFor(ticket) as ModelClient } : {}),
        },
      },
    );
    return { ticket, taskId: rec.taskId, runner };
  });

  return { routerRunId, plan, dispatched };
}

/**
 * 跑完一个目标：拆单 → 派发 → 等落地 → 汇总。
 *
 * `runner` 的 `concurrency` 决定了同时真正在跑几个 Worker —— 这里**不自己造并发控制**，
 * 那是 AsyncRunner 的 slot-pool 已经管好的事（`concurrency` 管在跑、`maxQueued` 管排队段）。
 */
export async function runGoal(opts: RunGoalOptions): Promise<GoalOutcome> {
  const { routerRunId, plan, dispatched } = await dispatchGoal(opts);

  // —— ③ 并行等落地（并发由 runner 的 concurrency 管，这里只是「等」）——
  const settled = await Promise.all(
    dispatched.map(async ({ ticket, taskId, runner }) => ({
      ticket,
      taskId,
      record: await settle(runner, opts, ticket, taskId),
    })),
  );

  // —— ④ 汇总：Worker 的隔离报告是唯一回流的东西 ——
  return {
    routerRunId,
    plan,
    outcomes: settled.map(({ ticket, taskId, record }) => ({
      ticket,
      taskId,
      status: record.status,
      summary: record.result?.finalText ?? '',
      runIds: collectRunIds(record),
    })),
  };
}

/**
 * 收集一个任务涉及的全部 runId（挂起段 + 恢复段）。
 *
 * `TaskRecord.result` 只保留**最后一段**的 trace；前面挂起段的 id 在 `runId` 历史里 ——
 * 这里退化用最后一段（示例只关心「有哪些链」），真要做链路分析请把每段的 `traceId`
 * 随 `sink` 落库（`traceId == runId`）。
 */
function collectRunIds(record: TaskRecord): string[] {
  return record.runId ? [record.runId] : [];
}
