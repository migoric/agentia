/**
 * Agentia-PG —— PostgreSQL 宿主 TaskStore。
 *
 * 与 `FileTaskStore` / `SqliteTaskStore` / `RedisTaskStore` 是**兄弟**（同一个
 * `TaskStore` 接口、同一套 `AsyncRunner` 调度），差别只在写入媒介。但有三处与
 * SQLite 版的实现形状**必须不同**，每一处都有具体后果：
 *
 * ① **`byIdempotency` 的 last-wins 靠显式 `save_seq`**（见 `schema.ts` 注释②）。
 *    SQLite 的 `INSERT OR REPLACE` 会删旧行重插，`rowid` 单调白送这个序；
 *    PG 的 `ON CONFLICT DO UPDATE` 走 UPDATE 路径，没有新的物理序可言。
 *
 * ② **没有读时自愈**。`SqliteTaskStore` 有一整套 `healRow`：它的 `status` / `wake_at`
 *    派生列可能被外部工具改脏，而 `listDue` 的过滤直接读列 —— 不自愈会让"该醒的任务
 *    永远醒不来"。PG 版不做的理由是**写路径只有 `save` 一处**：没有第二个写者去改这三列
 *    （DBA 手改不是我们要兜的场景，且自愈要靠 UPDATE 才能做，那是一条会在读路径上
 *    引入写放大与锁竞争的隐形成本）。真源仍是 `json` 列这一条不变。
 *
 * ③ **`list()` 在全表上跑**。这是接口本身的问题（`TaskStore.list()` 没有分页参数），
 *    而 `resumePending` 的扫描依赖它的完整性 —— 加 `LIMIT` 会让恢复扫描漏记录，
 *    症状是"任务静默不恢复"。所以这里**不加**上限，代价在 README 里写明：
 *    任务表涨到百万级时该做归档，而不是给它加 `LIMIT`。
 */

import {
  type TaskRecord,
  type TaskStore,
  parseTaskRecord,
  serializeTaskRecord,
} from '@migor/agentia';
import { type PgClient, assertPgClient } from './client.js';
import {
  type PgSchemaNames,
  type PgSchemaOptions,
  ensureSchema,
  resolveSchemaNames,
} from './schema.js';

export interface PgTaskStoreOptions extends PgSchemaOptions {}

/** 一行里我们只读 `json` —— 其余列是查询用的派生列，SQL 里用，不进 JS。 */
interface JsonRow {
  json: unknown;
}

/**
 * 任务 JSON 以 `text` 存储，正常读回就是字符串；保留对象分支只是为了兼容手工迁移
 * 或旧试验 schema 的 jsonb 行，不让读回路径悄悄分叉。
 *
 * 为什么绕一圈 `JSON.stringify` 再交给 `parseTaskRecord`：`src/store/record.ts` 是
 * "bytes → 记录"的唯一入口（旧版本形状归一、形状守卫都在那里），而 `tests/store/record.test.ts`
 * 有一条守卫禁止其他 store 文件出现 `JSON.parse`。多付一次序列化，换归一逻辑**不分叉** ——
 * 分叉的代价是某个未来版本的改名垫片只在本仓的 store 上生效，第三方 store 静默读到旧形状。
 */
function recordOf(raw: unknown): TaskRecord | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return parseTaskRecord(text);
}

export class PgTaskStore implements TaskStore {
  private readonly client: PgClient;
  private readonly names: PgSchemaNames;
  /** 全部语句在构造期拼好：表名拼接只有一处（注入面），调用路径上不再拼字符串 */
  private readonly sql: {
    save: string;
    claim: string;
    compare: string;
    get: string;
    byIdem: string;
    list: string;
    listDue: string;
    clear: string;
  };

  /**
   * 同步构造：只校验配置、拼 SQL，**不建表**。
   *
   * 想"建表 + 拿到 store"一步到位请用 `PgTaskStore.create()`；已经由 DBA 建过表、
   * 或要复用同一个连接做别的初始化时，直接 `new` 更可控（建表是宿主的运维决定，
   * 不该在每次 DI 装配时隐式发生）。
   */
  constructor(client: PgClient, opts: PgTaskStoreOptions = {}) {
    this.client = assertPgClient(client, 'PgTaskStore');
    this.names = resolveSchemaNames(opts);

    const t = this.names.tasks;
    const seq = this.names.taskSaveSeq;
    const update = `idempotency_key = EXCLUDED.idempotency_key,
          status          = EXCLUDED.status,
          wake_at         = EXCLUDED.wake_at,
          created_at      = EXCLUDED.created_at,
          save_seq        = nextval('${seq}'),
          json            = EXCLUDED.json`;
    this.sql = {
      // 单语句 UPSERT：记录本身与幂等索引在**同一行**，所以写入天然原子。
      save: `INSERT INTO ${t}
          (task_id, idempotency_key, status, wake_at, created_at, json)
        VALUES ($1, $2, $3, $4, $5, $6::text)
        ON CONFLICT (task_id) DO UPDATE SET ${update}`,
      // 同键各进程使用同一个确定性 taskId。主键冲突只允许重置失败/取消的旧行；
      // 活跃与成功行返回 0 行，调用方跟随原任务，绝不另起一次 app.run。
      claim: `INSERT INTO ${t}
          (task_id, idempotency_key, status, wake_at, created_at, json)
        VALUES ($1, $2, $3, $4, $5, $6::text)
        ON CONFLICT (task_id) DO UPDATE SET ${update}
        WHERE ${t}.status IN ('failed', 'cancelled')
          AND ${t}.idempotency_key = EXCLUDED.idempotency_key
        RETURNING task_id`,
      // 整份 JSON 快照做乐观锁：只改 status/ownerId 的比较会有 ABA 窗口。
      compare: `UPDATE ${t} SET
          idempotency_key = $2,
          status          = $3,
          wake_at         = $4,
          created_at      = $5,
          save_seq        = nextval('${seq}'),
          json            = $6::text
        WHERE task_id = $1 AND json = $7::text
        RETURNING task_id`,
      get: `SELECT json FROM ${t} WHERE task_id = $1`,
      byIdem: `SELECT json FROM ${t}
        WHERE idempotency_key = $1
        ORDER BY save_seq DESC, task_id DESC
        LIMIT 1`,
      list: `SELECT json FROM ${t} ORDER BY created_at, task_id`,
      listDue: `SELECT json FROM ${t}
        WHERE status = 'suspended' AND wake_at IS NOT NULL AND wake_at <= $1
        ORDER BY created_at, task_id`,
      clear: `DELETE FROM ${t}`,
    };
  }

  /**
   * 建表 + 构造（幂等）。多个 pod 同时首启是正常用法 —— `ensureSchema` 对
   * `42P07`/`42710`/`23505` 这类并发竞态做了短退避重试（见 `schema.ts` 注释①；
   * 只靠 `IF NOT EXISTS` 挡不住并发，那一点已被复核纠正）。
   */
  static async create(client: PgClient, opts: PgTaskStoreOptions = {}): Promise<PgTaskStore> {
    await ensureSchema(client, opts);
    return new PgTaskStore(client, opts);
  }

  async save(rec: TaskRecord): Promise<void> {
    await this.client.query(this.sql.save, paramsOf(rec));
  }

  async claimSubmission(rec: TaskRecord): Promise<boolean> {
    const res = await this.client.query(this.sql.claim, paramsOf(rec));
    return res.rows.length === 1;
  }

  async compareAndSave(rec: TaskRecord, expected: TaskRecord): Promise<boolean> {
    const res = await this.client.query(this.sql.compare, [
      ...paramsOf(rec),
      serializeTaskRecord(expected),
    ]);
    return res.rows.length === 1;
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    const res = await this.client.query(this.sql.get, [taskId]);
    return recordOf((res.rows[0] as JsonRow | undefined)?.json);
  }

  async byIdempotency(key: string): Promise<TaskRecord | undefined> {
    const res = await this.client.query(this.sql.byIdem, [key]);
    return recordOf((res.rows[0] as JsonRow | undefined)?.json);
  }

  async list(): Promise<TaskRecord[]> {
    const res = await this.client.query(this.sql.list);
    return collect(res.rows as readonly JsonRow[]);
  }

  /**
   * 到期索引（`TaskStore` 的可选成员）。实现了它，`resumePending` 的到期唤醒那一半
   * 就是 O(到期数) 而不是 O(全表) —— 走 `(status, wake_at)` 部分索引。
   *
   * ⚠️ 它不替代 `list()`：恢复扫描还干别的（挂起读数重建 / 审批超时 / 孤儿认领），
   * 那些职责的输入仍是全表（见 `store.ts` 的接口注释）。
   */
  async listDue(before: number): Promise<TaskRecord[]> {
    const res = await this.client.query(this.sql.listDue, [before]);
    return collect(res.rows as readonly JsonRow[]);
  }

  async clear(): Promise<void> {
    await this.client.query(this.sql.clear);
  }

  // 刻意**不实现** close()：连接/连接池由宿主持有，store 关掉它等于把别人还在用的
  // 东西关了（`TaskStore.close` 的注释写的是同一条）。要 end() 请宿主自己调。
}

/** 六种写入共用同一份参数顺序；任务正文统一经公共序列化入口。 */
function paramsOf(rec: TaskRecord): [string, string | null, string, number | null, number, string] {
  return [
    rec.taskId,
    rec.idempotencyKey ?? null,
    rec.status,
    rec.wakeAt ?? null,
    rec.createdAt,
    serializeTaskRecord(rec),
  ];
}

/** 行 → 记录；形状不合格的**跳过**（不是记录），与 SqliteTaskStore.list 同口径 */
function collect(rows: readonly JsonRow[]): TaskRecord[] {
  const out: TaskRecord[] = [];
  for (const r of rows) {
    const rec = recordOf(r.json);
    if (rec !== undefined) out.push(rec);
  }
  return out;
}
