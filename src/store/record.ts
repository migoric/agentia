/**
 * 任务记录的**读回唯一入口**（bytes → `TaskRecord`）：JSON 解析 + 旧版本形状的读时归一。
 *
 * 为什么单独成件：**落盘的数据不受类型系统保护**。`JSON.parse(raw) as TaskRecord` 里那个 `as`
 * 是一句「我保证它是」—— TS 只检查你**写进**类型的值，不检查**盘上**的值。于是改名这类破坏性
 * 变更（2026-09-28 ref-suspend-state-reason：`awaiting_approval` → `suspended` + `suspendedReason`、
 * `approvalPendingSince` → `suspendedSince`）在这条接缝上会**静默失效**：旧记录带着一个
 * `RunStatus` 里**已经不存在**的值被读回来，而每一处判断都按新语义去读它。
 *
 * 失效的具体后果（一条在等审批的 run 成孤儿，四个角度同时错）：
 * - `isTerminalTask` 认它**终态**（不是 queued / running / suspended）⇒ 事件流早关、`resumePending` 不捡；
 * - `resume-policy` 给出的 skip 原因正是 `'terminal'`（静默说错话）；
 * - `/healthz` 的 `suspended` 读数不计数（原因缺）；
 * - `approve` 回 409「状态不对」—— 人想批也批不了。
 *
 * 所以本文件是那六个「bytes → 记录」的**唯一入口**：三条 store、六处调用
 * （`fsStore` 的全量扫 + 残行探测、`sqliteStore` 的 get / byIdempotency / list、
 * `redisStore` 的单键读）。将来加第七处也用同一个函数 —— `tests/store/record.test.ts` 里那条
 * 「`src/store/*.ts` 中除本文件外不得出现 `JSON.parse`」的守卫会盯着。
 *
 * 边界：本函数**不吞坏 JSON**。三条 store 对「单条损坏」的取舍各不相同（文件与 Redis 跳过该条、
 * SQLite 照旧抛），异常留给调用方按各自口径处理 —— 归一层不越权决定「坏了怎么办」。
 */
import type { TaskRecord } from './store.js';
import { cloneTaskRecord } from './store.js';

/**
 * ① 之前的状态值。它在本版的 `RunStatus` 联合类型里**不存在**，所以下面那处比较只能走字符串
 * （`rec.status === 'awaiting_approval'` 根本编译不过）—— 这本身就说明问题：类型看不见盘上的数据。
 */
const LEGACY_STATUS = 'awaiting_approval';
/** 同一次改名之前的挂起时刻字段（当时叫 `approvalPendingSince`） */
const LEGACY_SINCE_KEY = 'approvalPendingSince';

/**
 * 把一条记录里的旧版本形状**就地**归一，返回「有没有动过」。
 *
 * 目前只认 2026-09-28 ref-suspend-state-reason 那一批改名（状态值 + 挂起时刻字段）。原则：**只搬运盘上真有的东西**，
 * 不凭空补造 —— 新形状的记录若缺 `suspendedReason`，本函数不动它（那是另一个缺陷，
 * 不该由垫片掩盖成「看起来正常」）。
 *
 * 返回值留给需要自己决定要不要回写的调用方（`sqliteStore` 的派生列）。
 */
export function normalizeLegacyRecord(rec: TaskRecord): boolean {
  const raw = rec as unknown as Record<string, unknown>;
  let changed = false;

  if (raw.status === LEGACY_STATUS) {
    raw.status = 'suspended';
    // 原因必须**一起**补：两条闸（`approvalExpired` / `approve`）都按 `suspendedReason` 判，
    // 只改状态的话这条记录会被两条闸**都**漏掉 —— 比不归一更坏（状态看着对了、原因空着，
    // 再也说不出它在等谁）。
    if (raw.suspendedReason === undefined) raw.suspendedReason = 'approval';
    changed = true;
  }

  // 挂起时刻：旧字段搬过来之后**删掉**。留着就是半新半旧的两个键，任何读者都可能读到错的那个
  // （而「等多久了」这个数会直接进审批超时判定）。缺了不影响超时判定的正确性（基准链本来就退到
  // `startedAt` / `createdAt`），所以这一条是**修正**而不是修复：不搬会让「已经等了 3 天」
  // 从头重新计时。
  if (typeof raw[LEGACY_SINCE_KEY] === 'number') {
    if (raw.suspendedSince === undefined) raw.suspendedSince = raw[LEGACY_SINCE_KEY];
    delete raw[LEGACY_SINCE_KEY];
    changed = true;
  }

  return changed;
}

/**
 * 「哪些进程内引用在落库时被剥掉了」的键。
 *
 * ⚠️ **内部键，刻意不进 `RunInvocationOptions` 公共类型面**（AGENTS.md「内部工具不进公共面」）：
 * 它只在一条记录自「save」到「恢复段读回」之间活着，是给恢复路径的一句提示，不是使用者该
 * 配置的东西。读侧一律走 `droppedRuntimeRefsOf`，别在别处直接摸这个键名。
 */
export const DROPPED_REFS_KEY = '__agentiaDroppedRefs';

/** 被剥掉的进程内引用（只有 `true` 的那些有意义；键名对应 `RunInvocationOptions` 上的位置） */
export interface DroppedRuntimeRefs {
  /** 主 `client`：恢复段会退回 runner 级 / 默认 client */
  client: boolean;
  /** `tools` 菜单：恢复段会退回装配菜单（`app.tools`） */
  tools: boolean;
  /** fallback 环里的 `client`：只保留 `model`，client 由 runner/应用级配置兜住 */
  fallbacks: boolean;
}

/**
 * 读一条落库记录上的剥离标记（2026-11-09 深评 P1）。
 *
 * 为什么需要标记：`serializeTaskRecord` 会剥掉主 `client` 与 `tools`，而恢复段的
 * `buildRunCallOptions` 无从区分「提交时本来没传」与「传了但落库时被剥掉了」—— 两种情况下
 * `rec.spec.options.client` 都是 `undefined`。没有这个标记，per-task 自定义 client（典型是
 * OpenAI 兼容端点）的任务重启续跑时会**静默**打到 runner 的端点，自定义工具菜单也会静默
 * 换回装配菜单。标记只用来让恢复段**出声**，不改变任何装配结果。
 */
export function droppedRuntimeRefsOf(options: object | undefined): DroppedRuntimeRefs | undefined {
  if (options === undefined) return undefined;
  const raw = (options as Record<string, unknown>)[DROPPED_REFS_KEY];
  if (!Array.isArray(raw)) return undefined;
  return {
    client: raw.includes('client'),
    tools: raw.includes('tools'),
    fallbacks: raw.includes('fallbacks[].client'),
  };
}

/**
 * 落库前的**可序列化清洗**（2026-11-07 深评）：`JSON.stringify` 会把 `AbortSignal` 变成
 * `{}`、把 `ModelClient` 变成 `{messages:{}}`、把 `tools` 里的 run 函数丢掉。读回后这些
 * 空壳会在恢复段被当成真对象使用（`combineSignals({})` 直接 TypeError / 工具菜单半残）。
 *
 * 因此三条 JSON store 统一走这里：
 * - 去掉 `signal` / `client` / 回调 / `tools`（它们属于提交进程，不能跨重启）；
 * - fallback 环只保留 `model`（client 由 runner/应用级配置兜住，与文档口径一致）；
 * - 剥掉的「主 client / tools / fallback client」记进 `DROPPED_REFS_KEY`，让恢复段能出声
 *   （2026-11-09 深评 P1：此前剥得比文档承诺的多，且恢复路径看不到这件事）。
 * 返回的是**新对象**，不改调用方记录。
 */
export function serializeTaskRecord(rec: TaskRecord): string {
  const copy = cloneTaskRecord(rec);
  const options = copy.spec.options;
  if (options !== undefined) {
    const rest = { ...options };
    // 剥之前先记：这几样是「提交进程的运行时引用」，恢复段只能退回配置兜底
    const dropped: string[] = [];
    if (options.client !== undefined) dropped.push('client');
    if (options.tools !== undefined && options.tools.length > 0) dropped.push('tools');
    if (options.fallbacks?.some((link) => link.client !== undefined)) {
      dropped.push('fallbacks[].client');
    }
    // 只摘「进程内对象」；纯数据（approvals / events / blackboard / 预算 / labels）保留。
    delete rest.signal;
    delete rest.client;
    delete rest.onText;
    delete rest.onTraceEvent;
    delete rest.tools;
    if (rest.fallbacks !== undefined) {
      rest.fallbacks = rest.fallbacks.map((link) => ({ model: link.model }));
    }
    if (dropped.length > 0) {
      (rest as unknown as Record<string, unknown>)[DROPPED_REFS_KEY] = dropped;
    }
    copy.spec = { ...copy.spec, options: rest };
  }
  return JSON.stringify(copy);
}

/**
 * bytes → 记录（**唯一入口**）：解析 + 形状守卫 + 读时归一。
 *
 * - 坏 JSON 照旧抛（调用方按自己的口径吞或冒泡，见文件头的边界）；
 * - 形状不合格（不是对象 / 没有 `taskId`）⇒ `undefined`（「这条不是记录」，与「解析失败」分开）。
 */
export function parseTaskRecord(raw: string): TaskRecord | undefined {
  const rec = JSON.parse(raw) as TaskRecord;
  if (!rec || typeof rec.taskId !== 'string') return undefined;
  normalizeLegacyRecord(rec);
  return rec;
}
