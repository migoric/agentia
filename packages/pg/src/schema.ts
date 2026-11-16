/**
 * Agentia-PG —— 表结构与幂等建表。
 *
 * 三条设计决策（都与「PG 和 SQLite/Redis 不一样在哪」直接相关）：
 *
 * ① **迁移不需要事务，但不能只靠 `IF NOT EXISTS`**。PG 原生支持
 *    `CREATE TABLE / INDEX IF NOT EXISTS`，**单线程**重复执行是幂等的；可是两个连接
 *    **同时**首启时仍会撞 `42P07`（对象已存在）/ `42710` / `23505` —— "检查不存在 → 创建"
 *    不是原子的，DDL 锁只保证不并发写 catalog，不保证第二个连接会看到第一个的提交。
 *    （2026-11-13 复核收回了原先「DDL 锁会替你串行化」的说法：那是错的。）
 *    所以 `ensureSchema` 对这几类竞态码做短退避重试。
 *
 *    不把整串 SQL 包进 `BEGIN`：`PgClient` 可以是 `Pool`，连续两条语句**不保证落在
 *    同一条连接**上，跨连接事务是假的。要真锁请宿主自己用单 `Client` 包。
 *    SQLite 版那套 `BEGIN IMMEDIATE` + 捕获 "duplicate column" 在这里也不适用。
 *
 * ② **`save_seq` 是必需的派生列**，不是优化。`TaskStore.byIdempotency` 的语义是
 *    "last-wins"，`SqliteTaskStore` 靠 `INSERT OR REPLACE` 删除重插后的 `rowid` 单调
 *    来白送这个序。PG 里 `task_id` 是主键，UPSERT 走 UPDATE 路径时**不产生新的物理序**：
 *    `ctid` 会变但不单调、`xmin` 会回绕。没有显式序列，"同一个幂等键重提两次"可能返回
 *    第一次的结果 —— 而这个错误的表现是"任务看起来没重跑"，不会报错。
 *
 * ③ **任务用 `text`，会话消息用 `jsonb`**。任务查询全走派生列，不需要 JSON 操作符；
 *    纯文本能无损保存含 `\u0000` 的合法任务内容。会话则要用 `payload->>'role'` 按轮次裁剪，
 *    所以保留 jsonb，并显式包装它无法存 NUL 的边界（见 sessionStore.ts 与 README）。
 */

import type { PgClient } from './client.js';

/** 标识符白名单：小写字母/数字/下划线，且不以数字开头。刻意**不含**引号与 Unicode —— */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export interface PgSchemaOptions {
  /**
   * 表所在 schema（如 `'public'` / `'agentia'`）。缺省不限定，跟随连接的 `search_path`。
   *
   * 只接受小写标识符：给 `'MySchema'` 会抛错而不是悄悄拼成 `"MySchema"` ——
   * PG 对未加引号的标识符做小写折叠，静默折叠会让"我配的 schema 和实际用的不是同一个"。
   */
  schema?: string;
  /**
   * 表名前缀，缺省 `'agentia_'`。多套 Agentia 共用一个库时用它分命名空间
   * （如 `'prod_'` / `'staging_'`）。
   */
  tablePrefix?: string;
}

/** 解析后的物理名（已带 schema 限定，可直接拼进 SQL） */
export interface PgSchemaNames {
  /** schema 限定前缀（`'public.'` 或空串）—— 只拼在表名/序列名前；索引名不能带它 */
  qualifier: string;
  tasks: string;
  sessionMessages: string;
  taskSaveSeq: string;
  idxTasksIdem: string;
  idxTasksDue: string;
  idxTasksCreated: string;
  idxSessionCreated: string;
}

function assertIdent(value: string, what: string): string {
  if (!IDENT_RE.test(value)) {
    throw new TypeError(
      `${what} 必须匹配 ${IDENT_RE}（小写字母/数字/下划线，不以数字开头），收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 把选项解析成物理名。**纯函数**，不碰连接 —— 构造期就能校验配置，
 * 让"前缀写错了"在 `new` 的那一刻炸，而不是在第一次 `save` 时。
 */
export function resolveSchemaNames(opts: PgSchemaOptions = {}): PgSchemaNames {
  const prefix = assertIdent(opts.tablePrefix ?? 'agentia_', 'tablePrefix');
  const qualifier = opts.schema === undefined ? '' : `${assertIdent(opts.schema, 'schema')}.`;
  return {
    qualifier,
    tasks: `${qualifier}${prefix}tasks`,
    sessionMessages: `${qualifier}${prefix}session_messages`,
    taskSaveSeq: `${qualifier}${prefix}task_save_seq`,
    // 索引名在 PG 里是**同一个 schema 内全局**的（不像 MySQL 按表分组），
    // 所以每个索引都带前缀，否则两套 Agentia 建在同一 schema 会撞名。
    //
    // ⚠️ 索引名**不能带 schema 限定**：PostgreSQL 的 CREATE INDEX 明确要求索引名
    // 是一个裸 name（索引自动落在父表所在 schema）—— 写成 `public.xxx` 会直接
    // `syntax error at or near "."`。表名/序列名可以带 schema，索引名不行。
    idxTasksIdem: `${prefix}tasks_idem_idx`,
    idxTasksDue: `${prefix}tasks_due_idx`,
    idxTasksCreated: `${prefix}tasks_created_idx`,
    idxSessionCreated: `${prefix}session_messages_created_idx`,
  };
}

/**
 * 生成建表语句（按依赖顺序）。**导出它的用途**：宿主可能跑在**没有 DDL 权限**的
 * 托管实例上（RDS/Aurora 只给应用账号 DML 权限是常见配置），那时把这段 SQL 交给
 * DBA 一次性执行，应用侧改用 `new PgTaskStore(client)`（**构造不建表**）而不是
 * `create()`（建表 + 构造）即可 —— 没有 `migrate: false` 这种旋钮，分叉点就在这两个入口。
 */
export function schemaDdl(opts: PgSchemaOptions = {}): string[] {
  const n = resolveSchemaNames(opts);
  return [
    // 先建序列：`DEFAULT nextval(...)` 建表时不校验序列存在，但第一条 INSERT 会。
    `CREATE SEQUENCE IF NOT EXISTS ${n.taskSaveSeq}`,

    // `status` / `wake_at` / `created_at` 都是 json 内字段的反规范化副本 ——
    // 与 SqliteTaskStore 同一个理由：`json->>'wakeAt'` 要对扫到的每一行解析 JSON，
    // 派生列 + 索引才是 O(到期数)。
    //
    // 真源仍是 `json`：这三个列只由 `save` 一处维护，读路径不写它们
    // （SQLite 有读时自愈，PG 不需要 —— 见 `PgTaskStore` 的注释）。
    `CREATE TABLE IF NOT EXISTS ${n.tasks} (
      task_id         text        PRIMARY KEY,
      idempotency_key text,
      status          text        NOT NULL,
      wake_at         bigint,
      created_at      bigint      NOT NULL,
      save_seq        bigint      NOT NULL DEFAULT nextval('${n.taskSaveSeq}'),
      json            text        NOT NULL
    )`,

    // byIdempotency 的取数索引：`(key, save_seq DESC)` 直接给出 last-wins 的第一行。
    // 部分索引（`WHERE idempotency_key IS NOT NULL`）—— 多数任务没有幂等键，
    // 把它们排除在索引外能显著压小索引体积。
    `CREATE INDEX IF NOT EXISTS ${n.idxTasksIdem}
      ON ${n.tasks} (idempotency_key, save_seq DESC)
      WHERE idempotency_key IS NOT NULL`,

    // listDue 的取数索引：只索引"在睡"的行。
    `CREATE INDEX IF NOT EXISTS ${n.idxTasksDue}
      ON ${n.tasks} (status, wake_at)
      WHERE wake_at IS NOT NULL`,

    // list() 的排序索引。⚠️ 它**不**让 list() 变快多少 —— list 仍要读全表
    // （TaskStore 的接口就是全表），这个索引只是把排序从 sort 换成 index scan。
    `CREATE INDEX IF NOT EXISTS ${n.idxTasksCreated}
      ON ${n.tasks} (created_at, task_id)`,

    // 会话消息。`PRIMARY KEY (session_id, seq)` 同时提供「按会话取、按 seq 排序」的索引，
    // 一箭双雕；`seq` 全局递增（bigserial），跨会话也能排出先后。
    //
    // 为什么不用一条 JSON 数组的宽行：append 是并发的（多 pod 各自收尾各写一轮），
    // 宽行的写法是「读整段 → 拼 → 写回」，两个副本同时写会丢一轮。多值 INSERT 是原子的。
    `CREATE TABLE IF NOT EXISTS ${n.sessionMessages} (
      session_id text    NOT NULL,
      seq        bigserial,
      created_at bigint  NOT NULL,
      payload    jsonb   NOT NULL,
      PRIMARY KEY (session_id, seq)
    )`,

    // prune() 按**会话**回收（`GROUP BY session_id` + `max(created_at)`），所以索引列
    // 是 `(session_id, created_at)` 而不是 `(created_at)`：前者能让分组聚合走 index-only
    // scan，后者在这个形状下帮不上忙（PG 的实测差异不大，但方向对）。
    // 大表上真正的解法是分区/归档，不是加索引 —— prune 本来就是夜间任务。
    `CREATE INDEX IF NOT EXISTS ${n.idxSessionCreated}
      ON ${n.sessionMessages} (session_id, created_at)`,
  ];
}

/**
 * 幂等建表。可重复调用（每次进程启动都调是正常用法），也可被多个 pod 同时调用。
 *
 * ⚠️ **不能依赖 `IF NOT EXISTS` 自己挡并发**：PostgreSQL 的 `CREATE TABLE IF NOT EXISTS`
 * / `CREATE INDEX IF NOT EXISTS` 在两个连接同时首启时仍可能撞唯一索引（`42P07` /
 * `42710` / `23505`），不是「后到者安静跳过」。旧实现明确没做事务/advisory lock，
 * 却宣称多 pod 首启安全 —— 2026-11-13 复核把这个承诺收回来：
 * - 每个 DDL 单独重试这几类并发竞态（最多 5 次、短退避）；
 * - 不把 SQL 包进 `BEGIN`：这里的 `PgClient` 可能是 `Pool`，`Pool.query` 不保证
 *   连续两条语句落在同一个连接上，跨连接事务是假的；要真锁请宿主用单 `Client` 自己包。
 * - `CREATE SCHEMA` 仍不做（需要建库权限）；schema 不存在时让 PG 原样报错。
 *
 * 失败时**不吞**：表建不起来后续每一步都会以更难懂的方式失败（"relation does not exist"
 * 要等到第一次 save），在这里冒泡是最省事的信息。
 */
const MAX_DDL_RETRIES = 5;
const DDL_RACE_CODES = new Set(['42P07', '42710', '23505']);

/** 并发首启时 PG 可能给出的「另一个连接刚建了同名对象」错误码 */
function isDdlRace(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DDL_RACE_CODES.has(code);
}

export async function ensureSchema(client: PgClient, opts: PgSchemaOptions = {}): Promise<void> {
  for (const stmt of schemaDdl(opts)) {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query(stmt);
        break;
      } catch (err) {
        if (!isDdlRace(err) || attempt >= MAX_DDL_RETRIES - 1) throw err;
        // 另一个 pod 正在建同名对象：等它提交后再试，`IF NOT EXISTS` 就会命中。
        // 退避很小；首启窗口短，且这里不在请求热路径上。
        await new Promise<void>((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
}
