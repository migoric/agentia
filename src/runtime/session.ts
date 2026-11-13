import type { MessageParam } from '../core/message.js';

/**
 * SessionStore —— 会话持久化 / 对话历史（C4）。
 *
 * ⚠️ **与 `MemoryStore` 的区别（别混，文档里必须并列讲）**：
 * - `MemoryStore`（runtime/memory.ts）= 键值**黑板**：跨 run 存「状态与事实」
 *   （用户是谁、上次查到哪），run 开始水合进 `RunContext.blackboard`；
 * - `SessionStore`（本文件）= **对话历史**：存 messages 序列，run 开始拼在传入 messages
 *   **之前**，收尾时把本轮消息追加回去。
 *
 * 两者正交，可以同时用。
 */

export interface SessionStore {
  /** 读整段历史（没有则空数组） */
  load(sessionId: string): MessageParam[] | Promise<MessageParam[]>;
  /**
   * 追加消息（**append-only**）—— 不做 upsert：并发写不会互相覆盖，
   * 也便于事后审计「这段历史是怎么长出来的」。
   *
   * ⚠️ 已知边界：append-only 只保证「不互相覆盖、不丢数据」，不保证**角色交替**。
   * 两个并发 run 共用同一 sessionId 时，各自收尾 append 的 [user, ..., assistant]
   * 可能交错成「连续两条 user」，下一轮 load 出来会撞 Anthropic 的角色交替校验（400）。
   * 同一 session 的并发 run 需调用方自行串行化（如每 session 一把锁 / 一条队列）。
   */
  append(sessionId: string, messages: MessageParam[]): void | Promise<void>;
}

/**
 * Redis 客户端在**会话这一层**的最小结构面（duck-typed：框架不 import 任何 redis 包，
 * 与 `store/redisStore.ts` 的 `RedisLike` 同一条路线）。
 *
 * 只要求列表操作 —— 会话历史天然是「追加一条、整段读回」，用 list 而不是 string：
 * string 形态必须「读整段 → 拼 → 写回」，两个副本同时 append 会**丢一轮**
 * （后写的覆盖先写的），而 RPUSH 是服务端原子追加，丢不了。
 */
export interface RedisSessionClient {
  /** 原子追加（可一次多个）。ioredis / node-redis 同名同形 */
  rpush(key: string, ...values: string[]): Promise<unknown>;
  /** 区间读取（`0, -1` = 整段）。两家同名同形 */
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  /**
   * 只保留区间。设了 `maxMessages > 0` 时**必需**：不裁的列表会无界增长，
   * 而 Redis 不会替你把「太旧的历史」丢掉。
   */
  ltrim?(key: string, start: number, stop: number): Promise<unknown>;
  /** 设过期秒数。设了 `ttlSeconds > 0` 时**必需**（与 `RedisTaskStore` 同一条理由） */
  expire?(key: string, seconds: number): Promise<unknown>;
}

export interface RedisSessionStoreOptions {
  /** key 前缀，缺省 `'agentia:'`（与 `RedisTaskStore` 共用命名空间但不同前缀段：`session:`） */
  prefix?: string;
  /**
   * 整段历史的过期秒数；缺省不设（永不过期）。<= 0 视为不设。
   *
   * ⚠️ 语义是「**最后一次** append 之后 N 秒」，每次 append 都刷新窗口 ——
   * 它是「会话多久没动静就回收」，不是「从创建起 N 秒」。不设时列表永久驻留，
   * 长期多租户宿主应设一个。
   */
  ttlSeconds?: number;
  /**
   * 只保留**最后** N 条；缺省 0 = 不裁。
   *
   * ⚠️ 按**条数**切，不知道轮次边界：N 取奇数时历史可能以 assistant 开头，
   * 下一轮会撞厂商的角色交替校验（400）。要按轮次裁请宿主自己管，或取偶数
   * 并接受「可能切在被截断的一轮中间」。
   */
  maxMessages?: number;
}

/** 一次 RPUSH 的实参个数上限（V8 实参上限约 12 万，这里留足余量且避免单次命令过大） */
const RPUSH_CHUNK = 512;

/**
 * Redis 实现：**多副本共享同一段对话历史**（`InMemorySessionStore` 的进程内版本在
 * N 个 pod 下各一份 —— 同一用户下一句话落到别的 pod 就是「第一次见面」）。
 *
 * 为什么在框架里而不是让宿主自己写（`docs/database.md` 曾写「只有内存版，多实例各写一个」）：
 * 这条缝的两个坑都会**静默**发生 —— ① `rpush(key, ...messages)` 展开传参在十几万条时抛
 * RangeError，而 `executeRun` 的 appendSession 会把异常吞成一行 warn（该轮对话白聊）；
 * ② 「读整段 → 拼 → 写回」在并发下丢轮次。把这两条钉进实现并配用例，比让每个宿主
 * 各自重踩一遍便宜。
 *
 * ⚠️ **不解决**角色交替：append-only 只保证「不互相覆盖、不丢数据」。同一 sessionId 的
 * 并发 run 仍会交错（见 `SessionStore.append` 的边界注释），框架不替你加锁 ——
 * 要串行化就在调用侧按 session 排队，或用 `SET NX` 自己搭一把（那是锁，不是存储）。
 */
export class RedisSessionStore implements SessionStore {
  private readonly prefix: string;
  private readonly client: RedisSessionClient;
  /** 裁剪函数（`maxMessages > 0` 时构造期已确保存在） */
  private readonly trim?: (key: string) => Promise<unknown>;
  /** TTL 刷新函数（`ttlSeconds > 0` 时构造期已确保存在） */
  private readonly refreshTtl?: (key: string) => Promise<unknown>;

  constructor(client: RedisSessionClient, opts: RedisSessionStoreOptions = {}) {
    if (typeof client.rpush !== 'function' || typeof client.lrange !== 'function') {
      throw new TypeError(
        'RedisSessionStore 需要 client 提供 rpush / lrange（会话是 append-only 列表）',
      );
    }
    const prefix = opts.prefix ?? 'agentia:';
    if (!prefix) {
      // 空前缀 = 与其他命名空间混在一起（`session:` 键撞上别的系统的同名键）
      throw new TypeError('RedisSessionStore 的 prefix 不能为空串（会与其他命名空间混用）');
    }
    this.prefix = prefix;
    this.client = client;

    const ttl = opts.ttlSeconds ?? 0;
    // !(ttl >= 0) 同时拦 NaN —— NaN 会让 `ttl > 0` 恒假，TTL 静默失效（同 RedisTaskStore）
    if (!(ttl >= 0) || (ttl > 0 && !Number.isInteger(ttl))) {
      throw new TypeError(
        `RedisSessionStore 的 ttlSeconds 必须为 ≥ 0 的整数（0 = 不设 TTL），收到 ${String(opts.ttlSeconds)}`,
      );
    }
    if (ttl > 0) {
      const expire = client.expire;
      if (typeof expire !== 'function') {
        // 静默失效比启动期报错难查：键永不过期，会话历史无界增长且没有任何信号
        throw new TypeError(
          'RedisSessionStore 设了 ttlSeconds > 0，但 client 没有 expire(key, seconds) —— ' +
            'TTL 会静默失效（历史永不过期）。请用 ioredis / node-redis，或补一个 expire 实现。',
        );
      }
      this.refreshTtl = (key) => Promise.resolve(expire.call(client, key, ttl));
    }

    const max = opts.maxMessages ?? 0;
    if (!Number.isSafeInteger(max) || max < 0) {
      throw new TypeError(
        `RedisSessionStore 的 maxMessages 必须为 ≥ 0 的安全整数（0 = 不裁），收到 ${String(opts.maxMessages)}`,
      );
    }
    if (max > 0) {
      const ltrim = client.ltrim;
      if (typeof ltrim !== 'function') {
        throw new TypeError(
          'RedisSessionStore 设了 maxMessages > 0，但 client 没有 ltrim(key, start, stop) —— ' +
            '裁剪会静默失效（列表无界增长）。请用 ioredis / node-redis，或补一个 ltrim 实现。',
        );
      }
      // `-max` 起点由 Redis 自己钳位：列表比 max 短时等于整段，不需要先 LLEN 问长度
      this.trim = (key) => Promise.resolve(ltrim.call(client, key, -max, -1));
    }
  }

  private keyOf(sessionId: string): string {
    return `${this.prefix}session:${sessionId}`;
  }

  /**
   * 读整段。**损坏元素响亮抛错**（与脚手架 `FileSessionStore` 对坏 JSON 同一口径）：
   * 静默跳过会悄悄改变角色交替（少一条 assistant ⇒ 连续两条 user ⇒ 下一轮 400），
   * 而 `executeRun` 会把异常降级成一行 warn 并「当作没有历史」—— 声量够，代价可控。
   */
  async load(sessionId: string): Promise<MessageParam[]> {
    const key = this.keyOf(sessionId);
    const raw = await this.client.lrange(key, 0, -1);
    const out: MessageParam[] = [];
    for (let i = 0; i < raw.length; i++) {
      try {
        out.push(JSON.parse(raw[i] as string) as MessageParam);
      } catch {
        throw new TypeError(
          `RedisSessionStore：${key} 的第 ${i} 项不是合法 JSON —— 会话历史已损坏，` +
            '请人工确认后修复或删掉该键（跳过它会让角色交替错位）',
        );
      }
    }
    return out;
  }

  async append(sessionId: string, messages: MessageParam[]): Promise<void> {
    // 空数组提前返回：RPUSH 没有实参是命令错误，且不该为了「什么都没写」刷新 TTL
    if (messages.length === 0) return;
    const key = this.keyOf(sessionId);
    const payload = messages.map((m) => JSON.stringify(m));
    // 分片而不是 `rpush(key, ...payload)`：V8 实参上限约 12 万，超了抛 RangeError，
    // 而那条异常会被 appendSession 吞掉 ⇒ 这一轮对话白聊（InMemorySessionStore 的
    // 同类坑写在它的 append 注释里）。分片后单次命令也不会因为值太多被服务端拒。
    for (let i = 0; i < payload.length; i += RPUSH_CHUNK) {
      await this.client.rpush(key, ...payload.slice(i, i + RPUSH_CHUNK));
    }
    // 顺序：先追加、再裁、最后刷 TTL。裁在 TTL 之前 ⇒ 即使裁失败，历史也不会「过期但没裁」
    if (this.trim) await this.trim(key);
    if (this.refreshTtl) await this.refreshTtl(key);
  }
}

/** Map 实现：测试与缺省场景（进程内，无持久化） */
export class InMemorySessionStore implements SessionStore {
  private readonly data = new Map<string, MessageParam[]>();

  load(sessionId: string): MessageParam[] {
    // 返回浅拷贝：run 会把结果拼进自己的 messages 数组并继续 push，
    // 直接把内部数组交出去会让那些 push 反向污染 store 里的历史。
    const cur = this.data.get(sessionId);
    return cur ? [...cur] : [];
  }

  append(sessionId: string, messages: MessageParam[]): void {
    const cur = this.data.get(sessionId) ?? [];
    // 逐项 push，不用展开传参：`push(...messages)` 受 V8 实参个数上限约束，
    // 超约 12 万条会抛 RangeError（同 runtime/run.ts 的 appendSession 会把异常吞掉 ⇒ 静默丢历史）。
    // 同族坑见 engine/turn.ts 的 replaceMessages。
    for (const m of messages) cur.push(m);
    this.data.set(sessionId, cur);
  }
}
