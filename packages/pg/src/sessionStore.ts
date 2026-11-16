/**
 * Agentia-PG —— PostgreSQL 宿主 SessionStore（对话历史）。
 *
 * 与 `RedisSessionStore` 是**兄弟**，但两处实现形状不同，都是 PG 的能力换来的：
 *
 * ① **一次 `INSERT ... SELECT ... unnest($n::text[])` 写完一批**，不需要 RPUSH 分片。
 *    分片是为了绕 Redis 的实参上限与单命令大小；但那套做法有个代价 Redis 版如实地
 *    留着（见其注释）：分片之间不原子，第 2 片失败会留下半截历史。这里用**数组参数**
 *    把整批放进一条语句 —— 单语句即事务，参数上限（65535）也不再是约束
 *    （无论多少条消息，占位符始终是 3 个）。
 *
 * ② **按轮次裁剪，而不是按条数**。Redis 版 `maxMessages` 的注释写着它的缺陷：
 *    按条数切不知道轮次边界，N 取奇数会让历史以 assistant 开头，下一轮撞厂商的
 *    角色交替校验（400）。PG 能用 `payload->>'role'`（jsonb 操作符）定位"倒数第 N 条
 *    user 消息"，于是 `maxTurns` 的语义就是"保留最后 N 轮"，边界永远落在 user 上。
 *
 * ⚠️ **PG 没有原生 TTL**。Redis 版靠 `EXPIRE` 让键自己消失；PG 里等价物是定时 `DELETE`
 *    （`pg_cron` 或宿主自己的清理任务），所以这里只提供**显式**的 `prune()` ——
 *    不提供"看起来像 TTL 但其实什么都没做"的选项。
 */

import type { MessageParam, SessionStore } from '@migor/agentia';
import { type PgClient, assertPgClient } from './client.js';
import {
  type PgSchemaNames,
  type PgSchemaOptions,
  ensureSchema,
  resolveSchemaNames,
} from './schema.js';

export interface PgSessionStoreOptions extends PgSchemaOptions {
  /**
   * 只保留**最后 N 轮**；缺省 0 = 不裁。
   *
   * 轮次以 `user` 消息为界：保留"倒数第 N 条 user 消息"及其之后的全部行。
   * 不足 N 轮时什么都不删（子查询取不到值 ⇒ 条件为 NULL ⇒ 零行受影响）。
   */
  maxTurns?: number;
  /** 时钟注入（测试用）。缺省 `Date.now`。它只影响 `created_at`，不参与裁剪判定。 */
  now?: () => number;
}

/** 一行的读回形状 */
interface PayloadRow {
  payload: unknown;
}

/** 合法 JSONB 不等于合法 MessageParam：标量 / 缺 role 的行会让引擎在很远的地方炸。 */
function messageOf(raw: unknown, sessionId: string, index: number): MessageParam {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(
      `PgSessionStore：会话 ${sessionId} 的第 ${index} 行 payload 不是消息对象（得到 ${
        raw === null ? 'null' : typeof raw
      }）—— 历史已损坏，请人工确认后修复或删掉该行`,
    );
  }
  const m = raw as { role?: unknown; content?: unknown };
  if ((m.role !== 'user' && m.role !== 'assistant') || !('content' in m)) {
    throw new TypeError(
      `PgSessionStore：会话 ${sessionId} 的第 ${index} 行 payload 不是合法 MessageParam` +
        '（role/content 缺失或非法）—— 历史已损坏，请人工确认后修复或删掉该行',
    );
  }
  return raw as MessageParam;
}

export class PgSessionStore implements SessionStore {
  private readonly client: PgClient;
  private readonly names: PgSchemaNames;
  /** 时钟（`created_at` 与 `prune` 的基准） */
  private readonly now: () => number;
  /** 每批 append 之后要跑的裁剪语句；`maxTurns` 为 0 时为 undefined */
  private readonly trimSql: string | undefined;
  private readonly maxTurns: number;
  private readonly sql: {
    load: string;
    append: string;
    prune: string;
  };

  constructor(client: PgClient, opts: PgSessionStoreOptions = {}) {
    this.client = assertPgClient(client, 'PgSessionStore');
    this.names = resolveSchemaNames(opts);
    this.now = opts.now ?? Date.now;

    const max = opts.maxTurns ?? 0;
    // !(max >= 0) 同时拦 NaN —— NaN 会让 `max > 0` 恒假，裁剪静默失效（同 RedisSessionStore）
    if (!(max >= 0) || (max > 0 && !Number.isInteger(max))) {
      throw new TypeError(
        `PgSessionStore 的 maxTurns 必须为 ≥ 0 的整数（0 = 不裁），收到 ${String(opts.maxTurns)}`,
      );
    }
    this.maxTurns = max;

    const t = this.names.sessionMessages;
    this.sql = {
      load: `SELECT payload FROM ${t} WHERE session_id = $1 ORDER BY seq`,
      // 数组参数：整批一条语句、一次网络往返、一次事务。`p::jsonb` 的 cast 是必需的 ——
      // `jsonb[]` 的数组字面量转义在驱动之间不一致，一律按 `text[]` 传、由 PG 转。
      // 空数组是合法的 no-op（`unnest` 出 0 行），但调用方已在更上层提前返回，
      // 省掉一次无意义的往返。
      append: `INSERT INTO ${t} (session_id, created_at, payload)
        SELECT $1, $2, p::jsonb FROM unnest($3::text[]) AS p`,
      // 全局清理：删掉**整段都过期**的会话（`max(created_at) < cutoff`）。PG 没有 TTL，
      // 这是它的替代品 —— 由宿主的定时任务调（pg_cron / 自己的 cron / 部署脚本）。
      //
      // ⚠️ 刻意**不**按行删（`WHERE created_at < $1`）。按行删会切在轮次中间：
      // 某轮的 user 落在 cutoff 之前、assistant 落在之后时，保留下来的历史以
      // assistant 开头 —— 下一轮 `load` 出来直接撞厂商的角色交替校验（400），
      // 而删除本身是"成功"的，没有任何信号。这与本类按轮次裁 `maxTurns` 的口径
      // 必须一致：能删的地方只有轮次边界，而**会话的边界**是唯一在 SQL 里
      // 不需要额外状态就能找准的轮次边界。
      //
      // 代价是 O(全表) 聚合（`GROUP BY session_id` + `max`）：这是夜间运维任务的
      // 成本，不是请求路径上的。要"只保留最近 N 天的消息、不管会话死活"，
      // 得自己做轮次对齐（见 README 的替代写法），本包不提供那个不安全版本。
      prune: `DELETE FROM ${t}
        WHERE session_id IN (
          SELECT session_id FROM ${t}
           GROUP BY session_id
          HAVING max(created_at) < $1
        )`,
    };

    if (max > 0) {
      // `COALESCE(..., 0)`：user 消息不足 N 条时子查询返回 NULL，`seq < NULL` 是 NULL
      // ⇒ 一行都不删。显式写成 0 而不是依赖 NULL 语义，是为了让"不删"这件事读得出来。
      this.trimSql = `DELETE FROM ${t}
        WHERE session_id = $1
          AND seq < COALESCE((
            SELECT seq FROM ${t}
             WHERE session_id = $1 AND payload->>'role' = 'user'
             ORDER BY seq DESC
             OFFSET $2 LIMIT 1
          ), 0)`;
    }
  }

  /** 建表 + 构造（幂等；并发首启由 `ensureSchema` 的重试兜住，见 `schema.ts`） */
  static async create(client: PgClient, opts: PgSessionStoreOptions = {}): Promise<PgSessionStore> {
    await ensureSchema(client, opts);
    return new PgSessionStore(client, opts);
  }

  /**
   * 读整段历史。
   *
   * `payload` 通常是驱动解析好的对象（node-postgres / PGlite 都这样），但也兼容返回
   * 字符串的驱动。**坏数据不静默跳过**（与 `RedisSessionStore.load` 同一口径）：
   * 少一条 assistant 会让历史变成"连续两条 user"，下一轮直接撞厂商的角色交替校验 ——
   * 跳过等于把数据损坏伪装成"这轮看起来正常"。
   */
  async load(sessionId: string): Promise<MessageParam[]> {
    const res = await this.client.query(this.sql.load, [sessionId]);
    const out: MessageParam[] = [];
    for (let i = 0; i < res.rows.length; i++) {
      const raw = (res.rows[i] as PayloadRow | undefined)?.payload;
      if (typeof raw === 'string') {
        try {
          out.push(messageOf(JSON.parse(raw), sessionId, i));
        } catch (err) {
          if (err instanceof TypeError && err.message.includes('第')) throw err;
          // 驱动可能已经解析过 jsonb（对象）或返回字符串原文；字符串既可能是
          // JSON 文本，也可能是「JSON 字符串」解码后的值。两种都按**消息形状**报错，
          // 不要把「合法 JSONB 里的标量」误报成「不是合法 JSON」。
          throw messageOf(raw, sessionId, i);
        }
        continue;
      }
      out.push(messageOf(raw, sessionId, i));
    }
    return out;
  }

  /**
   * 追加消息（append-only）。整批一次写入；`maxTurns > 0` 时紧接着裁剪。
   *
   * 顺序是"先追加、再裁"：裁失败时结果是"历史没裁"而不是"历史丢了这一轮"。
   */
  async append(sessionId: string, messages: MessageParam[]): Promise<void> {
    if (messages.length === 0) return;
    const payload = messages.map((m) => JSON.stringify(m));
    const at = this.now();
    try {
      await this.client.query(this.sql.append, [sessionId, at, payload]);
    } catch (err) {
      // jsonb 存不下 NUL（真实边界，不是防御性代码）：`JSON.stringify` 会把内容里的
      // `\u0000` 写成转义序列，PG 解析时直接拒绝，报 "unsupported Unicode escape sequence"。
      // 那句错误指不到"是哪条消息的问题"，所以在这里补上位置并给出可操作的解法。
      // LLM 输出里出现空字节不算罕见（二进制内容被当文本、PDF 抽取的残留）。
      const msg = err instanceof Error ? err.message : String(err);
      if (/unsupported Unicode escape sequence|\\u0000/i.test(msg)) {
        throw new TypeError(
          `PgSessionStore：会话 ${sessionId} 的这批消息里有内容含 NUL 字符（\\u0000），` +
            'jsonb 无法存储它。请在入库前清洗（例如把二进制内容转 base64 或剔除空字节）。',
          { cause: err },
        );
      }
      throw err;
    }
    if (this.trimSql !== undefined) {
      // OFFSET = maxTurns - 1：倒数第 N 条 user 消息。`-1` 会让"保留 1 轮"变成
      // "保留最后 0 轮之后的全部"—— 即从最后一条 user 起，正确。
      await this.client.query(this.trimSql, [sessionId, this.maxTurns - 1]);
    }
  }

  /**
   * 清理**整段都过期**的会话，返回删除行数。
   *
   * 判据是「该会话的**最后一条**消息早于 `now - olderThanMs`」—— 一直在用的会话
   * 不会被删，哪怕它的开头很旧。这条语义与 Redis 的 `EXPIRE` 对齐（过期以键为单位，
   * 不以元素为单位），也与本类按轮次裁的口径一致：删除只发生在轮次边界上。
   *
   * 这是 PG 版的"TTL"：没有 `EXPIRE`，只有 DELETE。建议由宿主的定时任务调用；
   * 若要用 `pg_cron`，直接执行等价的 SQL（本包不创建 SQL 函数，避免表前缀/函数名
   * 变成第二份需要迁移的契约）：
   * `DELETE FROM agentia_session_messages WHERE session_id IN (SELECT session_id FROM
   * agentia_session_messages GROUP BY session_id HAVING max(created_at) < <cutoff_ms>);`
   * 不能简化成 `WHERE created_at < <cutoff_ms>`：那是按行删，会切在轮次中间。
   *
   * ⚠️ 它是 O(全表) 聚合（`GROUP BY session_id` + `max(created_at)`），别放在请求路径上。
   * 单会话长度由构造期的 `maxTurns` 管，两者分工不同：`maxTurns` 管"一个会话内部留多少"，
   * 本方法管"多久没动的会话整段回收"。
   *
   * 返回值取 `rowCount ?? affectedRows ?? 0`：不清零、不编数 ——
   * 清理是否真的删了东西，用一句 `SELECT count(*)` 复核比信任一个猜出来的数字好。
   */
  async prune(olderThanMs: number): Promise<number> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new TypeError(
        `PgSessionStore.prune 需要 ≥ 0 的有限毫秒数，收到 ${String(olderThanMs)}`,
      );
    }
    const res = await this.client.query(this.sql.prune, [this.now() - olderThanMs]);
    return res.rowCount ?? res.affectedRows ?? 0;
  }
}
