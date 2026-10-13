import { randomUUID } from 'node:crypto';
import type { AgentRunResult } from '../engine/types.js';
import type { SpanError } from '../core/trace.js';
import type { RunStatus, SuspendedReason, TaskEvent } from '../core/run.js';
import type { ApprovalDecision } from '../core/tool.js';
import type { RunSpec } from '../engine/spec.js';

/**
 * Agentia —— run 存储（spec §6.6：异步耐久 = 换宿主不换语义）。
 * 宿主接口：队列/DB 版只需实现 TaskStore，AsyncRunner/调度逻辑不变。
 * v1 交付 InMemoryTaskStore；trace 随 result 一同落记录（§9.3 v1：随 run 结果返回）。
 *
 * 方法返回 MaybePromise（R6）：同步实现（InMemory/File/Sqlite）原样返回同步值；
 * 异步实现（如 RedisTaskStore —— 网络客户端天然异步）返回 Promise。
 * 调用方用 await 兼容两种；AsyncRunner 的同步门面（submit/poll 等）面向同步 store，
 * 异步 store 下它们的行为见 async.ts 注释。
 */

/** 同步或异步返回值：await 化后两种实现统一（同步值 await 即自身） */
export type MaybePromise<T> = T | Promise<T>;

/** store 返回值可能是同步值或 Promise —— 区分用（同步门面只在同步值上工作） */
export function isThenable<T>(x: MaybePromise<T>): x is Promise<T> {
  return !!x && typeof (x as Promise<T>).then === 'function';
}

/** 生成任务 id（与具体 store 实现无关；AsyncRunner 等统一从这里取） */
export function nextTaskId(): string {
  return `task_${randomUUID()}`;
}

export interface TaskRecord {
  taskId: string;
  status: RunStatus;
  idempotencyKey?: string | undefined;
  spec: RunSpec;
  /** 执行完成后回填 runId（runId == traceId） */
  runId?: string | undefined;
  createdAt: number;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  /**
   * 认领该任务的进程标识（AsyncRunner 在 submit/重派时写入）。
   * 多进程共用一个 store 时，`resumePending` 靠它跳过「自己进程的记录」——
   * 本进程的记录一定还在内存里跑，重派只会让它跑两遍。
   */
  ownerId?: string | undefined;
  result?: AgentRunResult | undefined;
  error?: SpanError | undefined;
  /**
   * HITL：已收到的审批决定（tool_use_id → 决定）。**随任务落库**（进程重启不丢）；
   * 逐 id 幂等（第一次决定赢，见 `AsyncRunner.approve`）。
   */
  approvals?: Record<string, ApprovalDecision> | undefined;
  /**
   * HITL：当前**待决**的 tool_use_id 列表（挂起时由引擎写进结果、宿主落库）。
   * 审批方据此知道该批哪些 id；决定齐了之后宿主把任务恢复执行。
   * ⚠️ 时间挂起（`suspendedReason === 'timer'`）也写这个位 —— 装的是**请求延后**的那几条
   * （它们是「在等」的那批；醒来重跑的是整个回合，见 `core/tool.ts` 的 `deferUntil` 契约②）。
   */
  pendingApprovals?: string[] | undefined;
  /**
   * HITL：进入挂起的时刻（epoch ms）。`approvalTimeoutMs` 的**惰性**判定与
   * `approval.decided` 事件的 `waitedMs` 都以它为基准。
   */
  suspendedSince?: number | undefined;
  /**
   * 挂起原因（2026-09-28 ①）：`approval` = 等人工决定、`timer` = 等一个时刻。
   * **随记录落库**（与 `suspendedSince` 同批）：进程重启后靠它决定用哪条闸 ——
   * 审批超时只对 `approval` 成立，到期唤醒只对 `timer` 成立。
   */
  suspendedReason?: SuspendedReason | undefined;
  /**
   * 时间挂起的目标时刻（epoch ms，2026-09-28 ① 的 timer 侧）：到点由到期扫描唤醒
   * （`resumePending` / `poll` 的惰性路径，判据见 `transport/wake-policy.ts`）。
   * **随记录落库** —— 「睡到后天下午三点接着跑」这件事只有它活得比进程久。
   *
   * 恒缺省的有两类：等审批的挂起（人什么时候批就是什么时候）与一切非挂起记录；
   * 记录离开挂起态时一并清掉（`#executeInner` 的终态分支与两条恢复路径）。
   */
  wakeAt?: number | undefined;
  /**
   * 挂起期间投递、**尚未注入消息历史**的事件（2026-09-28 ⑥，run 事件投入口）。
   * **随记录落库**（重启不丢；先落库再派发那条纪律的载体）。续跑段由引擎在未决
   * tool_use 解决之后渲染成 user 文本消息注入（见 `engine/loop.ts` 的注入点纪律），
   * 跑通（不再挂起）后由宿主清掉 —— 它们已进历史；再次挂起则**保留**（那次续跑
   * 没有注入它们，清掉就是丢事件）。
   */
  pendingEvents?: TaskEvent[] | undefined;
  /**
   * 已投递事件的 eventId 簿记（幂等去重依据；**随记录落库** ⇒ 跨进程/重启不丢）。
   * 有界：最多保留 `MAX_DELIVERED_EVENT_IDS`（`transport/signal-supervisor.ts`）条，超出 FIFO 裁
   * 最旧 —— 它是去重簿记，不是审计日志；超出上限后同 id 重投会再进一次历史（如实：
   * 簿记有界，恰好一次的承诺也就有界）。
   */
  deliveredEventIds?: string[] | undefined;
}

export interface TaskStore {
  /**
   * 落库。存进去的必须是**副本**而不是调用方的活引用（2026-10-13 ①）——
   * 调用方的纪律是「改 rec → save → 继续改 rec → 再 save」，存活引用会让
   * 「两次 save 之间的中间态」对其他读者可见，且某次 save 失败时污染已留在库里。
   */
  save(rec: TaskRecord): MaybePromise<void>;
  /**
   * 取任务记录。返回的必须是**反序列化副本 / 快照，不是内部活引用** ——
   * engine/transport 的纪律是「先变异 rec、再 `await save` 落库」（如 resume-scanner /
   * approval-supervisor 的「重读 → 改 status → 先落库再派发」）：若 `get` 交出活引用，
   * 变异会在 `save` 之前就被其他读者看见，「未落库的中间态」直接对外可见；
   * save 失败时那些变异就**留在库里**（落不了库的决定却改了记录）。
   * `byIdempotency` / `list` / `listDue` 同一纪律（2026-10-13 ① 坐实：内建实现
   * 统一走 `cloneTaskRecord`，下方）。
   */
  get(taskId: string): MaybePromise<TaskRecord | undefined>;
  /** 幂等键 → 最近一次任务（last-wins）。返回副本，纪律同 `get` */
  byIdempotency(key: string): MaybePromise<TaskRecord | undefined>;
  /** 全表快照。每条都是副本，纪律同 `get` */
  list(): MaybePromise<TaskRecord[]>;
  /**
   * **可选**：到期索引（2026-09-28 ⑤ 落地）—— 只回「`suspended` 且 `wakeAt <= before`」
   * 的记录（`wakeAt` 缺失的不回）。`AsyncRunner` 的扫描在**到期唤醒那一半**用它替代全表
   * 过滤（`listDue?.(now) ?? list()` 的输入），没有实现的 store 回退全表，语义不变。
   *
   * 实现与否的分判（spec §10 2026-09-28 ⑤ 的实测）：`list()` 是**真查询**的 store
   * （sqlite：10k 记录一轮 ~105ms 线性增长）值得实现；记录本就在内存的（InMemory /
   * File —— list 只是返回 Map snapshot）**不实现**，回退路径就是它们的现状。
   *
   * ⚠️ 它**不能**替代 `list()` 本身：`resumePending` 的扫描还干别的事（挂起读数重建 /
   * 审批超时 / 孤儿认领），那些职责的输入仍是全表。
   */
  listDue?(before: number): MaybePromise<TaskRecord[]>;
  clear(): MaybePromise<void>;
  /**
   * **可选**：压实底层存储（`FileTaskStore` 的 JSONL 压实：一 task 一行、丢掉历史覆写行）。
   *
   * 为什么进接口（2026-09-28 外部深评 S5）：它此前只活在具体类上 —— 而宿主拿到的通常是
   * **接口类型**（DI 注入、工厂返回、配置驱动地选 store 三种都是这形态），想周期性压实
   * 只能 `as FileTaskStore` 强转；强转在换 store 时**不会报错**（sqlite 没有 compact），
   * 要到运行期才炸。放进接口（保持**可选**）之后，调用点写 `store.compact?.()`：
   * 「可能有、可能没有」在类型上就是显式的，每个实现「有没有」也一目了然。
   */
  compact?(): MaybePromise<void>;
  /**
   * **可选**：释放底层资源（`SqliteTaskStore` 的 `db.close()`）。
   *
   * 同样是为「宿主能多态调用」而进接口（S5），**不是**让框架自动调：
   * `AsyncRunner.drain()` 刻意**不**关 store —— 同一个 store 可能被调度器 / 另一个宿主
   * 共用，关掉它是**宿主的生命周期决定**（框架替它关 = 把别人还在用的东西关了）。
   */
  close?(): MaybePromise<void>;
}

/**
 * TaskRecord 的深拷贝（2026-10-13 ①，副本契约的唯一落点：`save` 入库与
 * `get` / `byIdempotency` / `list` 出站都走它）。
 *
 * 递归克隆数组与**纯对象**（原型为 `Object.prototype` 或 null）；函数与类实例
 * 按引用保留 —— `spec.options` 里合法地装着 `AbortSignal` / `ModelClient` /
 * 工具的 `run` 等进程内对象，它们不是「会被调用方变异的数据」，而 `structuredClone`
 * 遇上它们直接抛 `DataCloneError`（sqlite/redis 序列化时本来也会丢它们，见
 * `RunInvocationOptions.fallbacks` 的序列化边界注释）。
 */
export function cloneTaskRecord(rec: TaskRecord): TaskRecord {
  return cloneData(rec);
}

function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneData) as T;
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    // 类实例（AbortSignal 等）按引用保留：克隆它没有意义，也克隆不了
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneData(v);
    return out as T;
  }
  return value;
}

export class InMemoryTaskStore implements TaskStore {
  // 刻意**不实现** `listDue`（到期索引）：记录本就在内存 Map 里，`list()` 只是返回 snapshot ——
  // 到期过滤的成本与全表相同，索引无利可省（实测与触发条件见 spec §10 2026-09-28 ⑤）。
  // AsyncRunner 的扫描对缺失的 listDue 回退全表过滤，语义不变。
  private readonly byTask = new Map<string, TaskRecord>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey → taskId
  /** 记录条数上限；Infinity = 不限（缺省，保持旧行为） */
  private readonly maxRecords: number;

  /**
   * `maxRecords` 给长期运行的宿主一个内存闸门：超过上限时从最旧的**已终态**记录起
   * 淘汰（queued/running 在飞的记录永不淘汰）。缺省 Infinity = 不淘汰 ——
   * 每条记录含完整 trace（可能很大），长跑宿主（尤其 createHttpHandler 的缺省
   * runner）应显式设一个上限或换耐久 store。
   */
  constructor(opts: { maxRecords?: number } = {}) {
    const max = opts.maxRecords ?? Number.POSITIVE_INFINITY;
    if (max !== Number.POSITIVE_INFINITY && !(max > 0)) {
      throw new Error(
        `InMemoryTaskStore 的 maxRecords 必须为正数或 Infinity，收到 ${opts.maxRecords}`,
      );
    }
    this.maxRecords = max;
  }

  save(rec: TaskRecord): void {
    // 存副本（契约见 TaskStore.save）：调用方此后对 rec 的推进不得绕过 save 直接可见
    this.byTask.set(rec.taskId, cloneTaskRecord(rec));
    if (rec.idempotencyKey) this.byKey.set(rec.idempotencyKey, rec.taskId);
    if (this.byTask.size > this.maxRecords) this.evict();
  }

  /** 超过上限时按插入序淘汰已终态记录（在飞/挂起记录跳过，避免丢正在跑或等人的任务） */
  private evict(): void {
    for (const [taskId, rec] of this.byTask) {
      if (this.byTask.size <= this.maxRecords) break;
      // suspended 同样不可淘汰：它不在跑、但也没完 —— 淘汰了审批决定就无家可归
      if (rec.status === 'queued' || rec.status === 'running' || rec.status === 'suspended')
        continue;
      this.byTask.delete(taskId);
      if (rec.idempotencyKey && this.byKey.get(rec.idempotencyKey) === taskId) {
        this.byKey.delete(rec.idempotencyKey);
      }
    }
  }

  get(taskId: string): TaskRecord | undefined {
    const rec = this.byTask.get(taskId);
    return rec === undefined ? undefined : cloneTaskRecord(rec);
  }
  byIdempotency(key: string): TaskRecord | undefined {
    const taskId = this.byKey.get(key);
    const rec = taskId ? this.byTask.get(taskId) : undefined;
    return rec === undefined ? undefined : cloneTaskRecord(rec);
  }
  list(): TaskRecord[] {
    return [...this.byTask.values()].map(cloneTaskRecord);
  }
  clear(): void {
    this.byTask.clear();
    this.byKey.clear();
  }
}
