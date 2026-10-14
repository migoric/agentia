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
