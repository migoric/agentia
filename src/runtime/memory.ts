/**
 * MemoryStore —— 跨 run 记忆（R4）。
 *
 * blackboard（RunContext）随单次 run 释放；MemoryStore 在 run 边界做
 * 水合/回写：run 开始时把 load(keys) 注入 blackboard，run 结束时把
 * 这些 key 的当前值 save 回 store —— 同一份 store 跨多次 executeRun
 * 复用即得跨 run 记忆。接线见 runtime/run.ts 的 ExecuteRunOptions.memory。
 *
 * ⚠️ **同 keys 的并发 run 会丢写（默认）**：只有 `load` / `save` 的 store 是
 * **last-write-wins** —— 两条 run 都在「读 → 改写 → 写」之间交错时，后写的那条
 * 会把先写那条改的键整片覆盖回去，而**它自己看不出任何异常**。要能发现这件事，
 * 实现下面那对**可选**成员（`loadWithRev` + `saveIfRev`，CAS）：框架会在冲突时
 * **不写 + 出声**。不实现 = 保持旧行为，但框架也**检测不到**覆盖（版本号是检测的
 * 唯一依据，不是可选的优化）。完整配方见 docs/usage-guide.md「并发 run 共用同一 keys」。
 */

/** 一次带版本号的读 —— `MemoryStore.loadWithRev` 的返回（`values` 同 `load`，另加一个版本句柄） */
export interface MemorySnapshot {
  values: Record<string, unknown>;
  /**
   * 不透明版本句柄：框架**不解释它**（不认识、也不比较），只在回写时原样递给 `saveIfRev`。
   * 内容由 store 决定：整店单调计数、逐键 hash、数据库的 row version 都行 ——
   * **粒度越细误报越少**（粗粒度会把「别人写了别的键」也报成冲突，方向是宁可多报）。
   *
   * ⚠️ 契约（实现方的义务）：**水合成功时 rev 不得为 `undefined`** —— `undefined` 是保留值，
   * 只表示「没读到 / 读失败」。`run.ts` 的 `flushMemory` 正是用 `rev === undefined` 判
   * 「水合失败 ⇒ 跳过 CAS 回写」：若 store 水合**成功**却回了 undefined，那一次本可成功的
   * 回写会被跳过，且收到一条归因错误的 warn（被说成「水合失败」，实际是 store 违约）。
   */
  rev: unknown;
}

/**
 * `MemoryStore.saveIfRev` 的结果 —— 只有**真写进去了**才 `committed: true`。
 *
 * ⚠️ 实现方的义务：`committed: false` 时**一个字都不许写**（半写比不写更坏：
 * 调用方拿到的账是「没提交」，而 store 里已经是新旧混合）。
 */
export interface MemoryWriteResult {
  committed: boolean;
  /** 没提交的原因。目前只有 `'conflict'`（store 上的版本已不是传入的 rev） */
  reason?: 'conflict';
}

export interface MemoryStore {
  load(keys: string[]): Record<string, unknown> | Promise<Record<string, unknown>>;
  save(entries: Record<string, unknown>): void | Promise<void>;
  /**
   * **可选**：带版本号的读 —— 语义同 `load`，额外回一个**不透明版本句柄**（`rev`），
   * 框架在本 run 回写时用它做 CAS 依据（见 `saveIfRev`）。
   *
   * **与 `saveIfRev` 成对**：只实现一个是**写错了**，不是「支持一半能力」——
   * `executeRun` 入口当场抛 `TypeError`（半对 CAS 会让「回写有没有被覆盖」看起来
   * 有据可查、其实没有：只读版本不校验，与 last-write-wins 完全等效，还白多一次读）。
   */
  loadWithRev?(keys: string[]): MemorySnapshot | Promise<MemorySnapshot>;
  /**
   * **可选**：CAS 回写 —— 仅当 store 上的版本仍等于传入的 `rev` 时写入；
   * 否则**一个字都不写**并回 `{ committed: false, reason: 'conflict' }`。
   *
   * 语义要点（**框架不替你猜合并**）：冲突时既不合并也不重试 —— 「后写赢 / 逐键赢 /
   * 按时间戳赢」都是策略，属于 store 与宿主的决定。框架做的是**不写 + 出声**
   * （`console.warn`，含 keys 与冲突事实），让「丢了一条写」不再无声无息；
   * 重试配方见 docs/usage-guide.md「并发 run 共用同一 keys」。
   */
  saveIfRev?(
    entries: Record<string, unknown>,
    rev: unknown,
  ): MemoryWriteResult | Promise<MemoryWriteResult>;
}

/**
 * Map 实现：测试与缺省场景用（进程内，无持久化）。
 *
 * 带版本号能力：`loadWithRev` / `saveIfRev` 都实现了 —— 版本是**整个 store 一个单调计数**
 * （任何一次 `save` / `saveIfRev` 成功都 +1）。粒度很粗：并发 run 只要在对方之后写过
 * **任何**键，这边就会报冲突。这是有意的方向选择（宁可多报「可能覆盖了」，
 * 也不漏报「真的覆盖了」），代价是同一份 store 上的**无关写**也会报警。
 */
/** 纯数据深拷（数组 / 普通对象）；类实例与函数按引用保留（AbortSignal 等不能拷也无需拷） */
function cloneMemoryValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneMemoryValue) as T;
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: cloneMemoryValue(v),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly data = new Map<string, unknown>();
  /** 单调版本：任何成功写入 +1（读不改）。粗粒度见类注释 */
  private revision = 0;

  load(keys: string[]): Record<string, unknown> {
    return this.read(keys).values;
  }

  loadWithRev(keys: string[]): MemorySnapshot {
    return { values: this.read(keys).values, rev: this.revision };
  }

  save(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) {
      // 入库也拷一份：否则调用方后续就地改黑板对象会绕过 save 直接改库（CAS 也发现不了）。
      this.data.set(key, cloneMemoryValue(value));
    }
    this.revision += 1;
  }

  saveIfRev(entries: Record<string, unknown>, rev: unknown): MemoryWriteResult {
    // 判据用 `!==`：版本是不透明值，实现方（本类）知道自己给的是 number，
    // 而调用方可能是从别的实现上串来的值 —— 类型不对就是「不是同一个版本」，不抛。
    if (rev !== this.revision) return { committed: false, reason: 'conflict' };
    this.save(entries);
    return { committed: true };
  }

  /** 读的公共部分（`load` 与 `loadWithRev` 只差要不要版本号） */
  private read(keys: string[]): { values: Record<string, unknown> } {
    // 无原型对象：`out['__proto__'] = v` 在 {} 上会走原型 setter（改原型而非建属性），
    // 该 key 会静默丢失 —— 与 run.ts 的 flushMemory 保持对称。
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (this.data.has(key)) out[key] = cloneMemoryValue(this.data.get(key));
    }
    return { values: out };
  }
}
