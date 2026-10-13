import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseTaskRecord } from './record.js';
import { cloneTaskRecord } from './store.js';
import type { TaskRecord, TaskStore } from './store.js';

/**
 * Agentia —— 文件宿主 TaskStore（spec §6.6：异步耐久 = 换宿主不换语义）。
 *
 * InMemoryTaskStore 在进程重启即丢；FileTaskStore 用 JSONL 把任务记录落到磁盘，
 * AsyncRunner/Scheduler/触发层**零改动** —— 证明耐久只是换个 store 实现。
 *
 * 语义：
 * - 一行一条记录快照；save 先 append 落盘、成功后才覆写内存 Map（boot 重读时 last-wins，无顺序依赖）；
 * - 构造即 load：文件不存在则从空开始，写入自动建目录；
 * - 宿主重启后：new FileTaskStore(path) 读回记录 → AsyncRunner.resumePending() 续跑
 *   queued/running（running 视为中断）。幂等键去重照常生效（失败可重提）。
 *
 * 前提：**单宿主写者**。append 用同步写保证进程内串行；多进程写同一文件会交错，
 * 跨进程协调（锁/队列）属于部署层职责，不在本实现内。
 */
export class FileTaskStore implements TaskStore {
  // 刻意**不实现** `listDue`（到期索引）：记录常驻内存 Map（构造期 load 之后 `list()` 只是
  // snapshot），每轮扫描本来就便宜 —— 它真正贵的全表读在构造期，索引管不到那里
  // （实测读数见 spec §10 2026-09-28 ⑤）。runner 对缺失的 listDue 回退全表，语义不变。
  private readonly byTask = new Map<string, TaskRecord>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey → taskId

  constructor(
    private readonly file: string,
    private readonly onLoadError?: (err: unknown) => void,
  ) {
    // 目录在构造期建一次（原在每次 append 时 mkdirSync recursive —— save 是高频路径，
    // 每次都做一次递归 mkdir 是无谓的系统调用）
    mkdirSync(dirname(this.file), { recursive: true });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      // 读失败按空宿主启动：观测不击穿业务，缺省仍吞；宿主要告警就传 onLoadError
      this.onLoadError?.(err);
      return;
    }
    this.healTail(raw);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        // 解析 + 旧形状读时归一都在唯一入口里（src/store/record.ts）
        const rec = parseTaskRecord(line);
        if (!rec) continue;
        this.byTask.set(rec.taskId, rec);
        if (rec.idempotencyKey) this.byKey.set(rec.idempotencyKey, rec.taskId);
      } catch {
        // 单条损坏跳过，不整库崩
      }
    }
  }

  /**
   * 尾部残行自愈：文件不以 `\n` 结尾说明最后一次 append 写残了（进程被杀、磁盘满、断电）。
   * 不处理的话后续 append 会把新记录**粘在残行尾部**——两行并一行，重启后两条一起丢。
   * - 残行本身是完整记录（只是丢了换行）→ 补一个换行，记录不丢；
   * - 残行是半截 JSON → 截到最后一个换行处，之后 append 从干净的边界开始。
   */
  private healTail(raw: string): void {
    if (!raw || raw.endsWith('\n')) return;
    const cut = raw.lastIndexOf('\n') + 1; // 最后一个完整行的末尾（字符下标）
    const tail = raw.slice(cut);
    let complete = false;
    try {
      // 只探「这半截是不是一条完整记录」：解析结果丢掉（归一由上面的 load 循环做，
      // 那才是记录真正入内存的地方）
      complete = parseTaskRecord(tail) !== undefined;
    } catch {
      complete = false;
    }
    try {
      if (complete)
        appendFileSync(this.file, '\n'); // 记录是完整的，只差换行
      else truncateSync(this.file, Buffer.byteLength(raw.slice(0, cut), 'utf8'));
    } catch {
      // 修不了就照旧读：能解析的行照常入内存，损坏行由下面的 parse 守卫跳过
    }
  }

  private append(rec: TaskRecord): void {
    writeFileSync(this.file, `${JSON.stringify(rec)}\n`, { flag: 'a' });
  }

  save(rec: TaskRecord): void {
    // **先落盘、后更新内存**（2026-09-20）：落盘抛错时内存不得先推进 —— 否则内存说
    // 「已存」而磁盘没有（append-only 日志里也没这一笔），进程重启后记录静默回退，
    // 任务状态与持久层两本账。顺序反过来时抛错点在内存推进之后，丢的就是这个不变量。
    this.append(rec);
    // 内存同样只存副本（2026-10-13 ①）：调用方此后对 rec 的推进不得绕过 save 直接可见
    this.byTask.set(rec.taskId, cloneTaskRecord(rec));
    if (rec.idempotencyKey) this.byKey.set(rec.idempotencyKey, rec.taskId);
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
    if (existsSync(this.file)) rmSync(this.file);
  }

  /**
   * 压实日志：把「一 task 一行」的最新快照整体重写回文件，丢弃同一 task 的历史覆写行。
   *
   * append-only 的 JSONL 每 save 一次就追加一行，**容量随 save 次数线性增长**（构造期
   * load 也全量读回）——长期运行的宿主迟早要压。本方法是 TaskStore 接口之外的能力，
   * 由宿主按需周期性调用（如低频 cron）；压实经临时文件 + rename 原子替换（写崩了
   * 旧文件也完整），内存态不受影响。
   */
  compact(): void {
    // 赢家殿后：内存语义是「同幂等键最后 save 的 taskId 赢」（save 覆写 byKey），
    // 而 load 回放按行序 last-wins。直接按 Map 首次插入序写盘会丢掉「最后 save」
    // 信息 —— 同键重提的新任务插入在后，旧任务又被 save 赢回时，插入序恰与赢家
    // 属主相反，重启后赢家易主。把当前赢家排到文件末尾（load last-wins ⇒ 赢家
    // 殿后即等价内存语义）；Array.prototype.sort 稳定，同组内仍按插入序。
    const winners = new Set(this.byKey.values());
    const rows = [...this.byTask.values()].sort(
      (a, b) => Number(winners.has(a.taskId)) - Number(winners.has(b.taskId)),
    );
    const body = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
    // 原子重写：先写临时文件再 rename。直接 writeFileSync 截断重写，中途被杀会留下
    // 半截文件、丢掉全部记录；同目录 rename 是原子的，旧文件在新文件就位前保持完整。
    // 临时文件名固定（单写者前提，见头注释）—— 上次被杀留下的残临时文件会被本次覆写。
    const tmp = `${this.file}.compact.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, this.file);
  }
}
