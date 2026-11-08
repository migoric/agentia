import { isTerminalStatus } from '../core/run.js';
import { parseTaskRecord, serializeTaskRecord } from './record.js';
import type { TaskRecord, TaskStore } from './store.js';

/**
 * Agentia —— Redis 宿主 TaskStore（spec §6.6：异步耐久 = 换宿主不换语义，roadmap R6）。
 *
 * duck-typed 客户端：框架不 import 任何 redis 包，用户传 ioredis / node-redis /
 * 任何满足 RedisLike 结构面的客户端（含测试 fake）。TaskStore 方法已放宽为
 * MaybePromise（见 store.ts），本实现全部异步。
 *
 * 存储模型（prefix 缺省 'agentia:'）：
 * - `${prefix}task:<taskId>` → 整行记录 JSON（save = SET 覆写，last-wins）；
 * - `${prefix}idem:<idempotencyKey>` → taskId（同键重提覆写，byIdempotency last-wins）。
 * 两者都按 `ttlSeconds`（若设）过期（SET 覆写 + EXPIRE 刷新窗口），见该选项 ——
 * 但**只有终态记录真的拿到窗口**：非终态覆写会把窗口抹掉（挂起中的任务不能被 TTL 吃掉，
 * 见 `save` 的注释）。
 *
 * 语义对照 FileTaskStore / SqliteTaskStore：save 覆写、byIdempotency 取最近、
 * clear 清空本前缀全部 key。差异在 list 序：Redis 本身无序，按 createdAt
 * （同刻按 taskId）排序 —— 「写入顺序」语义的确定性近似（FileTaskStore 保插入位、
 * SqliteTaskStore 覆写后移到末尾，三者本就不逐字一致，排序给出稳定契约）。
 *
 * 前提：**单宿主写者**。save 是两次 SET（记录 + 幂等索引），未走 MULTI 事务；
 * 多写者并发下同键写可能交错，跨进程协调属部署层职责（与 FileTaskStore 一致）。
 *
 * 注意（load-bearing）：AsyncRunner 的延迟幂等去重依赖本实现「先 SET 记录、
 * await 后再 SET idem 索引」的写入顺序（见 async.ts #execute 注释）——若改为
 * 先写索引或 MULTI 事务，需同步复核该去重路径。
 */
/**
 * @deprecated 本 store 已不再使用它。历史：这是「对象形态 SET 选项」，对象形态是
 * node-redis 独有（ioredis 会把对象字符串化成 "[object Object]" 发给服务端，报语法错）；
 * 0.4.1 曾改用「位置参数形态」想当两家客户端的交集，**但那是错的** —— node-redis 的
 * SET 只声明 `(key, value, options)` 三个形参，多出来的位置参数被 JS **静默丢弃**，
 * TTL 会无声失效（见 `RedisLike.expire`）。保留导出仅为不破坏既有公共面。
 */
export interface RedisSetOptions {
  /** 过期秒数（EX）；<= 0 视为不过期 */
  EX?: number;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  /**
   * 覆写一个键。**只传两参** —— 这是 ioredis 与 node-redis 唯一无歧义的公共形态：
   * 尾参的「选项形状」两家相反（ioredis 认位置参数 `('EX', n)`、node-redis 认对象
   * `{ EX: n }`），取任何一种写法都会在另一家上静默失效或报语法错。
   * 所以 **TTL 不走这里**，改由 `expire` 单独施加（见 `RedisTaskStore`）。
   * 另：显式补一个 undefined 尾参会让 ioredis 发出 `SET k v ""` → 语法错。
   */
  set(key: string, value: string): Promise<unknown>;
  /**
   * 设置过期秒数 —— ioredis / node-redis **同名同形**的公共面（`expire(key, seconds)`）。
   * `RedisTaskStore` 的 `ttlSeconds > 0` 时**必需**：构造期校验，缺失即抛错（静默丢掉
   * TTL 会让键永不过期、`list()` 无界增长，比启动期报错难查得多）。
   */
  expire?(key: string, seconds: number): Promise<unknown>;
  /** 单键删除（ioredis / node-redis 的公共最小面；批量清理由多次单删组成） */
  del(key: string): Promise<unknown>;
  /** 模式枚举（node-redis / ioredis 均有）；与 scanIterator 至少提供其一 */
  keys?(pattern: string): Promise<string[]>;
  /**
   * 增量枚举（node-redis v4+ 形态，生产友好不阻塞）；yield 单键或一批键均可。
   * 提供时优先于 keys 使用。
   */
  scanIterator?(opts?: { MATCH?: string; COUNT?: number }): AsyncIterable<string | string[]>;
  /**
   * 关闭连接（可选）—— `RedisTaskStore.close()` 用它。对应 ioredis / node-redis 的 `quit()`。
   *
   * ⚠️ 取 `quit` 而不是 `close` / `destroy`：它是**三家共名**的成员（ioredis ✓、node-redis v4 ✓、
   * v5 有但已 `@deprecated`）—— 与既有的 `expire` 同档判据（取公共面，不追任何一家的新写法）。
   * 2026-09-29 查 node-redis master 源码：`quit()` 已标 `@deprecated`（后继 `close()`），但
   * 本仓要同时兼容 ioredis，故暂留 `quit`；将来只支持 node-redis v5+ 时再换 `close`。
   * 返回类型放宽为 `Promise<unknown>`：ioredis 返 `'OK'`、node-redis 返 `void` / 字符串。
   */
  quit?(): Promise<unknown>;
}

export interface RedisTaskStoreOptions {
  /** key 前缀，缺省 'agentia:' */
  prefix?: string;
  /**
   * 每条记录的过期秒数；缺省不设（永不过期）。
   *
   * 不设时任务记录（含完整 trace，可能很大）永久驻留，`list()` 的全库 SCAN 也
   * 无界增长。设了之后**任务的查询窗口就是 TTL**：过期即 404，调用方需在窗口内
   * 取走结果。<= 0 视为不设。
   */
  ttlSeconds?: number;
}

export class RedisTaskStore implements TaskStore {
  private readonly prefix: string;
  /**
   * TTL 施加函数（`ttlSeconds > 0` 时构造期已确保存在）。TTL 不走 `SET` 的尾参 ——
   * 两家客户端的尾参形状相反，取任何一种都会在另一家上失败（详见 `RedisLike.set`）。
   */
  private readonly applyTtl?: (key: string) => Promise<unknown>;

  constructor(
    private readonly client: RedisLike,
    opts: RedisTaskStoreOptions = {},
  ) {
    if (!client.scanIterator && !client.keys) {
      throw new Error(
        'RedisTaskStore 需要 client 提供 scanIterator 或 keys 之一（list/clear 依赖按键枚举）',
      );
    }
    const prefix = opts.prefix ?? 'agentia:';
    if (!prefix) {
      // 空前缀 = 无命名空间：clear() 的 `${prefix}*` 会 SCAN/DEL 整个库
      throw new Error('RedisTaskStore 的 prefix 不能为空串（clear 会清空整个库）');
    }
    this.prefix = prefix;
    const ttl = opts.ttlSeconds ?? 0;
    if (!(ttl >= 0)) {
      // !(ttl >= 0) 同时拦 NaN —— NaN 会让 `ttl > 0` 恒假，静默把 TTL 关掉
      throw new Error(
        `RedisTaskStore 的 ttlSeconds 必须为 ≥ 0 的数（0 = 不设 TTL），收到 ${opts.ttlSeconds}`,
      );
    }
    if (ttl > 0) {
      const expire = client.expire;
      if (typeof expire !== 'function') {
        // 静默失效比启动期报错难查得多：键永不过期，list() 无界增长，且没有任何信号
        throw new Error(
          'RedisTaskStore 设了 ttlSeconds > 0，但 client 没有 expire(key, seconds) —— ' +
            'TTL 会静默失效（键永不过期）。请用 ioredis / node-redis 客户端，或补一个 expire 实现。',
        );
      }
      this.applyTtl = (key) => expire.call(client, key, ttl);
    }
  }

  private taskKey(taskId: string): string {
    return `${this.prefix}task:${taskId}`;
  }

  private idemKey(key: string): string {
    return `${this.prefix}idem:${key}`;
  }

  async save(rec: TaskRecord): Promise<void> {
    const json = serializeTaskRecord(rec);
    // TTL 只加在**终态**记录上（2026-09-28 外部深评 S1）。此前无条件加：一条在等审批的
    // 任务，TTL 一到记录就没了 —— 那条「批了它」的决定无家可归（`InMemoryTaskStore.evict`
    // 里那句「suspended 不可淘汰」是同一条道理，两处此前读数相反）。
    // ⚠️ 机制是 `SET` 的语义：不带选项的 `SET` **清除**既有 TTL ⇒ 非终态的每次覆写都把
    // 先前那条窗口抹掉、记录回到「永不过期」，直到进终态才第一次拿到窗口。
    // 代价如实记：一条**永远等不到**审批的挂起记录会永久驻留（批不批是人的事，
    // store 无从判死）—— 与内存 store 同款取舍，清理属部署层职责。
    const expires = isTerminalStatus(rec.status);
    // 写入顺序是 load-bearing（AsyncRunner 的延迟幂等去重依赖它）：先记录、后幂等索引
    await this.write(this.taskKey(rec.taskId), json, expires);
    if (rec.idempotencyKey) {
      // 幂等索引与记录**同生共死**：非终态时索引若先过期，同一键重提会绕过去重、
      // 把一条在跑的任务再跑一遍（比「记录丢了」更坏的后果）
      await this.write(this.idemKey(rec.idempotencyKey), rec.taskId, expires);
    }
  }

  /**
   * 写一次（`SET` 覆写 + 设了 `ttlSeconds` 时 `EXPIRE` 刷新窗口）。
   *
   * **为什么 TTL 不走 `SET ... EX`**：两家客户端的尾参形状**相反** —— ioredis 认位置参数
   * `('EX', n)`（给对象会被字符串化成 "[object Object]"、服务端报语法错），而 node-redis
   * 的 SET 只声明 `(key, value, options)` **三个形参**，位置参数被 JS **静默丢弃**
   * （v4.7.1 / v6.2.1 实跑其命令定义确认：`transformArguments('k','v','EX',60)` →
   * `['SET','k','v']`）。`expire(key, seconds)` 是两家**同名同形**的公共面，没有歧义。
   *
   * 代价（如实记）：`SET` 与 `EXPIRE` 两条命令、**非原子** —— 两步之间进程被杀会留下一个
   * **没有 TTL 的键**（多活一条本该到期的记录），不会损坏数据。TTL 只是查询窗口，用这个
   * 窗口换「两家客户端都真的生效」，是本 store 有意的取舍（见 spec §10）。
   */
  private async write(key: string, value: string, expires: boolean): Promise<void> {
    await this.client.set(key, value);
    // 只有终态记录拿到查询窗口（非终态：无选项的 SET 已把既有 TTL 清掉 ⇒ 永不过期）。
    // 窗口从**进入终态那次写**起算 —— 既不是创建时刻，也不是每次状态推进（见 save）。
    if (expires && this.applyTtl) await this.applyTtl(key);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    return parseRecord(await this.client.get(this.taskKey(taskId)));
  }

  async byIdempotency(key: string): Promise<TaskRecord | undefined> {
    const taskId = await this.client.get(this.idemKey(key));
    return taskId ? this.get(taskId) : undefined;
  }

  async list(): Promise<TaskRecord[]> {
    // Redis SCAN 契约允许同一个 key 返回多次（rehash / 过期时真实发生）。不去重会让
    // `resumePending` 把同一条记录认领两次并派发两次（2026-11-07 深评）。
    const keys = [...new Set(await this.enumerate(this.taskPattern()))];
    const recs: TaskRecord[] = [];
    for (const k of keys) {
      let raw: string | null;
      try {
        raw = await this.client.get(k);
      } catch (e) {
        // 单 key 读失败不该让整次 resume 扫描 reject（扫描会因此完全停摆）。
        console.warn(
          `[agentia] RedisTaskStore.list 读取 ${k} 失败，跳过该条：`,
          e instanceof Error ? e.message : e,
        );
        continue;
      }
      const rec = parseRecord(raw);
      if (rec) recs.push(rec);
    }
    recs.sort(
      (a, b) =>
        a.createdAt - b.createdAt || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    );
    return recs;
  }

  async clear(): Promise<void> {
    const keys = await this.enumerate(`${escapeGlob(this.prefix)}*`);
    for (const k of keys) await this.client.del(k);
  }

  /**
   * 关闭底层连接（`TaskStore.close?()` 的实现 —— 外部深评 C1：唯一真正握着外部连接的 store 此前
   * 没有关闭出口，因为 `RedisLike` 上没有 `quit`）。
   *
   * ⚠️ 框架**不主动调**它：`drain` 不关 store（store 可能在多条 run / 宿主之间共享，见 `store.ts`
   * 对 `close?()` 的说明）。这是给宿主在「确认不再用这个 store」时的手动出口。
   *
   * **幂等**：客户端没有 `quit`（只读桩 / fake）⇒ 直接返回；已关过 / 连接已断时 ioredis 的
   * `quit` 会 reject ⇒ 吞掉 —— 关闭是尽力而为，重复关闭不该打断宿主的 shutdown 路径。
   */
  async close(): Promise<void> {
    const quit = this.client.quit;
    if (typeof quit !== 'function') return;
    try {
      await quit.call(this.client);
    } catch {
      /* 幂等：已关闭 / 连接已断 —— 关闭语义是「尽力而为」，不抛 */
    }
  }

  /** `${prefix}task:*` —— prefix 里的 glob 元字符必须转义，否则会被当模式解释 */
  private taskPattern(): string {
    return `${escapeGlob(this.prefix)}task:*`;
  }

  /** 按键枚举：优先 scanIterator，缺则退回 keys(pattern) */
  private async enumerate(pattern: string): Promise<string[]> {
    if (this.client.scanIterator) {
      const out: string[] = [];
      for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (Array.isArray(batch)) out.push(...batch);
        else out.push(batch);
      }
      return out;
    }
    return this.client.keys!(pattern);
  }
}

/**
 * 转义 Redis glob 元字符（`\ * ? [ ]`）—— 用于把**字面前缀**拼进 MATCH 模式。
 * 不转义时，prefix 含 `[` 等字符会让模式被解释成字符类（如 `app[1]:*` 匹配不到
 * 字面 `app[1]:`），list/clear 静默查错 key。
 */
function escapeGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, '\\$&');
}

/** 解析整行 JSON；单条损坏按缺失处理，不整库崩（与 FileTaskStore 对齐） */
function parseRecord(raw: string | null): TaskRecord | undefined {
  if (!raw) return undefined;
  try {
    // 解析 + 旧形状读时归一都在唯一入口里（src/store/record.ts）；本函数只负责
    // 「坏了就跳过」这条取舍
    return parseTaskRecord(raw);
  } catch {
    return undefined;
  }
}
