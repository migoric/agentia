# 接数据库（MySQL / Postgres / 你的库）

面向「要把 agent 接到自己的业务库」的宿主。**框架不认识任何数据库** —— 根 `package.json` 的
`dependencies` 是空的，`src/` 里唯一碰持久化的是四个 `TaskStore` 实现（内存 `Map` / `node:fs` /
`node:sqlite` / 一个**结构化的 Redis 接口**）。

这不是「还没做」，是定位（[spec §1](./spec.md)）：核心只给**缝**，不给**策略**。连哪个库、
用哪个驱动、连接池多大，都是宿主的策略。

> 本文的 TypeScript 围栏块由 `tests/docs/code-fences.test.ts` **真编译**（真源 = `src/index.ts`），
> 照抄不会出现「文档承诺了、源码里没有」。

## 0. 先分清三件事（答案完全不同）

| 你要存的东西 | 谁拥有 | 框架默认给什么 | 你要写什么 |
|---|---|---|---|
| **业务数据**（订单 / 客户 / 工单 / SKU） | 你的应用 | **什么都不给**，也不该给 | 一个 provider + 若干 `@Tool` |
| **agent 任务状态**（队列 / 挂起 / 审批决定 / 事件簿记） | 你的任务宿主 | `InMemoryTaskStore` / `FileTaskStore` / `SqliteTaskStore` / `RedisTaskStore`；PG 用 `@migor/agentia-pg` 的 `PgTaskStore` | 只在「多实例共用一个队列」时：一个 `TaskStore` 实现（已有 PG 的宿主不必写） |
| **会话历史 / 记忆** | 你的宿主 | `SessionStore`：`InMemorySessionStore` / `RedisSessionStore` / `PgSessionStore`（多副本共享）；`MemoryStore` 只有内存版 | 多实例且既不用 Redis 也不用 PG 时：自己写一个实现 |

三者可以放在**同一个 mysql** 里（一个库、不同表），但**不要塞进同一个事务** —— 见 §3.4。

## 1. 业务数据：构造注入，框架零改动

数据库在你的应用里。框架只负责把「模型的一次调用」导到你的方法上，接法是显式的 provider
注册表（同一个形状，`examples/patrol/src/registry.ts` 用的是文件工作区）。

```ts
import { Tool, createApp } from '@migor/agentia';

/** 只用到 execute —— mysql2 的 Pool / pg 的 Pool 结构上都满足（换驱动不改下面的代码） */
interface SqlPool {
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

/** 宿主自己的数据边界：SQL 留在这一层，不必进模型的手 */
class OrderRepo {
  constructor(private readonly pool: SqlPool) {}

  async findOrder(id: string) {
    const [rows] = await this.pool.execute(
      'SELECT id, status, updated_at FROM orders WHERE id = ?',
      [id], // 参数化，永不拼串
    );
    return rows;
  }
}

class FindOrder {
  constructor(private readonly repo: OrderRepo) {}

  @Tool({
    description: '按订单号查状态。只读；查不到就说查不到，不要猜。',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '订单号' } },
      required: ['id'],
      additionalProperties: false,
    },
    strict: true,
  })
  async findOrder(input: { id: string }) {
    return this.repo.findOrder(input.id);
  }
}

const pool: SqlPool = await connect(); // ← 你的驱动：mysql2 的 createPool / pg 的 new Pool

createApp({
  providers: [
    { provide: 'sql', useValue: pool },
    { provide: 'orders', useClass: OrderRepo, deps: ['sql'] },
    { provide: 'find_order', useClass: FindOrder, deps: ['orders'] },
  ],
  /* … */
});
```

（CJS 宿主：把 `pool` 的创建挪进 `async function main()` —— 顶层 `await` 在 CJS 里不合法，
`frameworks.md` 记过这个坑。）

三条纪律（工具方法返回 `Promise` 是支持的，`src/core/tool.ts` 的 `run` 签名就是 `Promise<O> | O`）：

1. **只读账号**：查询工具用单独的只读连接池。模型能传的只有 schema 里的参数，但「能写」这件事
   本身不该给出去。
2. **写操作走人工审批**：`@Tool({ approval: 'required' })` 让每次调用先挂起（审批决定随任务落库，
   进程重启不丢），批准后由宿主恢复执行。范例是 `examples/patrol` 的 `quarantine_path`。
3. **参数化 + 幂等键**：SQL 用占位符；会改数据的动作带业务幂等键（`AsyncRunner.submit` 的
   `idempotencyKey` 管「同一个任务不重复提交」，业务侧的「同一个订单不重复退款」要自己的
   唯一索引兜）。

## 2. 什么时候真的需要实现 `TaskStore`

任务状态是**框架自己的**数据（谁能跑、跑到哪、在等谁批）。先看是否必须自建：

| 场景 | 用什么 | 为什么够 |
|---|---|---|
| 单进程 / dev | `InMemoryTaskStore` | 进程没了任务就没了；长跑宿主记得给 `maxRecords`（每条记录含完整 trace） |
| 单进程 + 重启要续跑 | `FileTaskStore` / `SqliteTaskStore` | 重启后 `resumePending()` 捡回挂起与孤儿；`File` 是**单写者**（JSONL 追加），`Sqlite` 靠 WAL + 写事务支持多进程共库 |
| 多实例 + 已有 Redis | `RedisTaskStore` | 它就是「结构接口 + 不引驱动」的先例：`RedisLike` 只要求几个方法 |
| **多实例 + 已有 Postgres** | **`@migor/agentia-pg` 的 `PgTaskStore`** | 单语句 UPSERT（记录与幂等索引同一行，写入天然原子）+ `listDue` 走部分索引。见 §2.1 |
| **多实例 + 只有 mysql** | **自己实现** | 没有内置实现，也不该有 —— 见 §3 的骨架与 §7 |

为什么 mysql 版不内置：`node:sqlite` 是**随 Node 发行**的，所以 `SqliteTaskStore` 能进核心而不破
「零运行时依赖」；`mysql2` 是要装的东西，进核心 = 所有用户被绑到你选的驱动和版本上（还有
MariaDB / PlanetScale HTTP / 连接池语义的差异，全得核心替你选）。

### 2.1 为什么 PG 单独有包，而 mysql 没有

PG 走的是**独立包**（`@migor/agentia-pg`），不进核心也不绑驱动：客户端仍是 duck-typed
（只要 `query(text, params)`），第三方运行时依赖为零，`@migor/agentia` 是 `peerDependency`。
所以"装 mysql2 会绑死驱动"那条理由对它不成立。

它带来两条核心实现给不了的东西，且这两条**只有 PG 的语义能干净地给**：

- **`ON CONFLICT DO UPDATE` + 显式 `save_seq` 序列** ⇒ `byIdempotency` 的 last-wins 有唯一正解。
  MySQL 的 `ON DUPLICATE KEY UPDATE` 在自增主键上会**跳号**，同一份实现放到 MySQL 上
  "最后 save 的赢"要靠另一种技巧，两种行为不该共用一套文档。
- **jsonb 操作符 `payload->>'role'`** ⇒ 会话能按**轮次**裁（以 user 消息为界），而
  `RedisSessionStore` 的 `maxMessages` 只能按条数裁。

## 3. 实现 `TaskStore`（MySQL 骨架）

### 3.1 接口：5 个必需 + 5 个可选

| 方法 | 契约要点 |
|---|---|
| `save(rec)` | **存副本**，不是调用方的活引用（调用方的纪律是「改 rec → save → 继续改 rec → 再 save」） |
| `get(taskId)` | **返回副本**，不是内部活引用（否则「未落库的中间态」对外可见） |
| `byIdempotency(key)` | 同一幂等键的**最近一次**任务（last-wins） |
| `list()` | 全表快照，每条都是副本 |
| `clear()` | 清空 |
| `listDue?(before)` | 只回「`suspended` 且 `wakeAt <= before`」；不实现则回退全表，语义不变 |
| `claimSubmission?(rec)` | 以 `submissionTaskId(key)` 派生的主键原子认领一次幂等提交；`true` 才执行，活跃／成功记录返回 `false` 并跟随，失败／取消可重置重试 |
| `compareAndSave?(rec, expected)` | 仅当库中记录仍逐字等于**变异前完整快照** `expected` 时保存；否则不改库并返回 `false`。用于孤儿恢复的单认领，不能只比较状态或 owner |
| `compact?()` / `close?()` | 压实 / 释放资源；**框架刻意不替你调**（同一个 store 可能被别的宿主共用） |

`store.ts` 的注释写的是「队列 / DB 版**只需实现 `TaskStore`**，`AsyncRunner` / 调度逻辑不变」——
这个承诺是真的：只实现 5 个必需方法仍可运行，下面这份骨架不碰框架任何内部；两个原子能力不实现时，
明确保持原来的跨进程 at-least-once 边界。`PgTaskStore` 已实现这两个可选方法。

### 3.2 骨架

```ts
import { parseTaskRecord, type TaskRecord, type TaskStore } from '@migor/agentia';

/** 只依赖 execute / query —— 换驱动不改下面的逻辑 */
interface SqlPool {
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * 建表（宿主执行一次）：
 *
 *   CREATE TABLE agent_tasks (
 *     task_id    VARCHAR(64)  NOT NULL PRIMARY KEY,
 *     idem_key   VARCHAR(255) NULL,
 *     status     VARCHAR(32)  NOT NULL,
 *     wake_at    BIGINT       NULL,
 *     updated_at BIGINT       NOT NULL,
 *     json       LONGTEXT     NOT NULL,
 *     INDEX idx_idem (idem_key, updated_at),
 *     INDEX idx_due  (status, wake_at)
 *   ) ENGINE=InnoDB;
 *
 * json 用 LONGTEXT 而不是 JSON 列：记录里装着完整 trace（可能很大），JSON 列会做
 * 规范化与键重排，既费 CPU 又不省空间；本 store 从不按 json 内部字段查询。
 */
class MySQLTaskStore implements TaskStore {
  constructor(private readonly pool: SqlPool) {}

  async save(rec: TaskRecord): Promise<void> {
    // 覆写时 updated_at 必须跟着变：byIdempotency 的 last-wins 全靠它排序
    await this.pool.execute(
      `INSERT INTO agent_tasks (task_id, idem_key, status, wake_at, updated_at, json)
       VALUES (?, ?, ?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         idem_key = new.idem_key, status = new.status, wake_at = new.wake_at,
         updated_at = new.updated_at, json = new.json`,
      [
        rec.taskId,
        rec.idempotencyKey ?? null,
        rec.status,
        rec.wakeAt ?? null,
        Date.now(),
        JSON.stringify(rec),
      ],
    );
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    const rows = await this.pool.query<{ json: string }>(
      'SELECT json FROM agent_tasks WHERE task_id = ?',
      [taskId],
    );
    return rows[0] ? this.parse(rows[0].json) : undefined;
  }

  async byIdempotency(key: string): Promise<TaskRecord | undefined> {
    const rows = await this.pool.query<{ json: string }>(
      `SELECT json FROM agent_tasks WHERE idem_key = ?
        ORDER BY updated_at DESC, task_id DESC LIMIT 1`,
      [key],
    );
    return rows[0] ? this.parse(rows[0].json) : undefined;
  }

  async list(): Promise<TaskRecord[]> {
    const rows = await this.pool.query<{ json: string }>(
      'SELECT json FROM agent_tasks ORDER BY updated_at ASC, task_id ASC',
    );
    return this.toRecords(rows);
  }

  /** 到期索引：走 (status, wake_at)，别写成 JSON_EXTRACT —— 那会退化成全表扫 */
  async listDue(before: number): Promise<TaskRecord[]> {
    const rows = await this.pool.query<{ json: string }>(
      `SELECT json FROM agent_tasks
        WHERE status = 'suspended' AND wake_at IS NOT NULL AND wake_at <= ?
        ORDER BY wake_at ASC`,
      [before],
    );
    return this.toRecords(rows);
  }

  async clear(): Promise<void> {
    await this.pool.execute('DELETE FROM agent_tasks');
  }

  private toRecords(rows: Array<{ json: string }>): TaskRecord[] {
    return rows.flatMap((r) => {
      const rec = this.parse(r.json);
      return rec ? [rec] : [];
    });
  }

  /** 公共入口负责 JSON 解析、形状守卫与旧形状归一；JSON 往返也天然满足副本契约。 */
  private parse(raw: string): TaskRecord | undefined {
    return parseTaskRecord(raw);
  }
}
```

`AS new` 需要 MySQL **8.0.19+**（更早的版本用 `VALUES(col)`，8.0.20 起被弃用）。

### 3.3 三个真坑

**① 幂等键的 last-wins 不能靠「插入顺序」。** mysql 覆写不改行位，`ORDER BY` 必须有一个跟着每次
`save` 都变的列（上面的 `updated_at`）。同一毫秒内的两次提交排序不保证 —— 幂等要的是「同一个 key
只跑一次」，那件事靠**提交前查 `byIdempotency` + 业务侧唯一索引**，别指望排序。

**② `listDue` 必须走索引。** 这个可选接口存在的唯一理由就是省掉全表（`list()` 是真查询的 store
值得实现它；记录本就在内存的 `InMemoryTaskStore` / `FileTaskStore` 刻意不实现）。写成
`WHERE JSON_EXTRACT(json, '$.wakeAt') <= ?` 就等于白实现。

**③ 跨进程认领是否原子，取决于可选能力。** 上面的 MySQL 骨架只实现必需方法，因此
`resumePending` 仍是 `list() → 改 ownerId → save() → 派发`，多写者要收敛成单写者或分片。
`AsyncRunner` 写 `ownerId`（`p<pid>@<host>-<8位十六进制>`），`resumePending({ staleAfterMs })`
靠它区分他我：同主机就问那个 pid 还在不在（在的绝不抢、不在的立刻可抢），判不了
（异主机 / 旧格式）才退回新鲜度启发式；`staleAfterMs` 本身不是租约。

要关闭「同一旧快照被两个恢复者认领」的窗口，在 store 内实现 `compareAndSave`，以完整旧快照做
原子比较写入（PG 是 `UPDATE ... WHERE json = expected`，其他库也可用短事务 +
`SELECT … FOR UPDATE` 实现）；首次同键提交则实现 `claimSubmission`，不能用「先查再 save」模拟。
`PgTaskStore` 已提供两者。即使都实现，崩溃、owner 误判和终态落库失败仍保持 at-least-once，
业务副作用仍须幂等。

⚠️ **异步 store 下 `submit` 返回的 taskId 有一个短暂的「还查不到」窗口**（如实记录，不打算消掉）：
首次提交要先用幂等键问一次旧记录（旧版本留下的是随机 taskId，必须先查、否则会各写一条并重复
执行）、再认领，这两次往返完成之前记录还没落库 ⇒ 这期间的 `GET /tasks/:id` 是 404。
不把它做成「`poll` 返回内存里的 queued」是因为那会对外声称一个**尚未耐久**的任务确实存在
（进程此刻崩掉，客户端手里的 id 就永远查不到）—— at-least-once 的诚实口径是「落库了才存在」。
调用方要结果请用 `runner.awaitTask()`（或 `GET /tasks/:id` 带重试），不要拿 submit 的返回值
当「记录已可读」。

### 3.4 别把业务事务和 run 记录塞进一个事务

run 的持久化边界是「一次 `save`」，业务事务是你自己的。想让「扣库存 + agent 记录已执行」
原子提交，就是分布式事务 —— 框架不给，也不该给（定位判据：只给缝不给策略）。正确做法是
**业务侧幂等**：业务表上的唯一索引 + 请求带的幂等键，让重复执行没有副作用。

## 4. 会话与记忆

`SessionStore` 有三个实现：`InMemorySessionStore`（进程内，缺省/测试）、
`RedisSessionStore`（多副本共享同一段历史；`prefix` 分命名空间、`ttlSeconds` 按「最后一次
append 之后 N 秒」回收、`maxMessages` 按条数裁），以及 `@migor/agentia-pg` 的
`PgSessionStore`（`maxTurns` 按**轮次**裁 —— 以 user 消息为界，边界永远落在 user 上；
PG 没有原生 TTL，回收靠显式 `prune()` + `pg_cron`，且**以会话为单位**回收：按行删会切在轮次
中间，让历史以 assistant 开头）。`MemoryStore` **只有内存版**，需要持久化时
自己写一个实现，接口很小（`MemoryStore` 的 CAS 必须**成对**实现 `loadWithRev` + `saveIfRev`），
签名见 [usage-guide](./usage-guide.md) 的 store 小节。

⚠️ **`RedisSessionStore` 不解决并发顺序**：`append` 是 append-only，不覆盖、不丢数据，但两个
并发 run 的 `[user, assistant]` 可能交错成「连续两条 user」，下一轮 `load` 出来撞角色交替校验
（400）。同一 session 的并发 run 要自己串行化（每 session 一把锁 / 一条队列）——
框架给的是存储，不是锁。多副本下还会多一层：`sessionId` 必须来自身份体系，
别用请求体里客户端可自填的值（否则任意租户可读别人的对话）。

⚠️ **会话历史只收 `user` / `assistant`，`append` 会在写入点拒绝 `system`**：`MessageParam['role']`
含 `'system'` 是为了与 SDK 类型逐字对齐，而 `load` 的守卫与 Messages API 都只接受前两者 ——
一条 system 消息落进列表，之后的**每一次** `load` 都会响亮抛错，而 `executeRun` 把它降级成
「当作没有历史」⇒ 会话永久失忆，写入那一刻却没有任何信号。所以 `append` 先全量校验、再分片写
（第 N 条非法 ⇒ 一条都不落库，不留半批）。system prompt 请走 `RunInvocationOptions.system`
（或客户端装配），不要塞进 SessionStore。

## 5. 另一条路：数据库 MCP server

不写工具，直接把一个 mysql MCP server 接给 agent（`src/integrations/mcp.ts`），模型就多了一套
SQL 工具。省事，但**把 SQL 的执行权交给了模型**：

- 只读账号 + 视图白名单（别给 `information_schema`）、结果行数上限、`statement_timeout`；
- **写操作不要给**这条路 —— 一次提示注入就能改数据，而 `@Tool` 封装的写操作能带审批闸；
- 适合探索型问题（「这批订单为什么退款多」），不适合动作型（下单 / 退款 / 改状态）—— 后者封成
  `@Tool`，参数由 schema 约束。

## 6. 记录解析与迁移

`parseTaskRecord(raw)` 是公共导出的读回入口：JSON 解析 + 最小形状守卫 + 旧版本形状归一。
外部 TaskStore 不要再写 `JSON.parse(raw) as TaskRecord`；那只会断言「盘上数据符合今天的类型」，
不会迁移昨天的记录。坏 JSON 会抛错，由 store 按自身策略决定跳过还是上抛；非记录形状返回 undefined。

## 7. 要不要出一个 `@migor/agentia-mysql` 包？NestJS 那种接入方式呢？

**MySQL 现在不出；PG 已经出了**（`@migor/agentia-pg`，见 §2.1）。两者的判据不同，别把 PG 那次当成先例照抄。

PG 出的理由：它的 SQL 语义让两条契约**有唯一正解** —— `ON CONFLICT DO UPDATE` + 显式序列
给出 last-wins；`payload->>'role'` 给出按轮次的会话裁剪。而这两条**写错了都是静默的**
（前者表现为"任务看起来没重跑"，后者表现为"下一轮撞 400"）。把正确实现固化进一个可测的包
（`packages/pg` 有 44 条用例跑在真 PG 引擎上），比让每个宿主各自踩一遍便宜。

MySQL 不出的理由仍是原判据：`ON DUPLICATE KEY UPDATE` 在自增主键上会**跳号**，last-wins 得换
一种技巧；MariaDB 与 PlanetScale（HTTP、无长连接）的语义差异更大。一份实现要么只覆盖其中一种，
要么在文档里挂三条分支 —— 那不如让宿主按 §3 的骨架自己写。

其余判据不变：`TaskStore` 接口是**冻结**的 ⇒ 将来提取就是剪切粘贴 + 挪测试，**成本不随时间上涨**；
提前出的收益是负的 —— 多一个包就要认领「跟哪个驱动版本、表结构变更怎么通知宿主」。

真到那天，形态照 `@migor/agentia-pg` 与 `RedisTaskStore` 的先例（两个包都**不 import 驱动**，
只要求一个结构接口）：

- **包收 pool，不 import 驱动**：对外只要求 `{ execute, query }`，宿主把自己 mysql2 / pg 的池子传进来
  ⇒ 包仍是**零运行时依赖**，也不被驱动版本绑死。
- **带上 DDL 与迁移**：出包就等于认领「表结构变了怎么通知宿主」。现在这条成本在本文 §3.2
  （宿主跑一次 `CREATE TABLE`）；出包后它是你的兼容性负担。
- **不绑 ORM**：`@nestjs/typeorm` 那类包的价值在「实体元数据 → 自动 token → 自动迁移」，前提是
  框架理解 ORM。本仓零运行时依赖 + 只给缝，做这层等于把 ORM 的版本政策变成自己的。

### NestJS 式接入在 agentia 里对应什么

| NestJS 的部件 | agentia 的对应物 | 差异 |
|---|---|---|
| DI 容器 + token 注入（`@InjectRepository(User)`） | `Provider`：`useValue` / `useClass` / `useFactory` + `deps: Token[]` | 有。但 `Token = string`，拼错**没有编译期保护**，要到第一次 `resolve` 才抛「未注册的 provider」——被工具引用的会在装配期炸，没人引用的则永远不报 |
| 按领域分模块（`forFeature([User])`） | 返回 `Provider[]` 的函数，几个函数 spread 进 `providers` | `examples/patrol/src/registry.ts` 的 `buildProviders(ws)` 就是这种；框架没有「模块」概念 |
| 连接生命周期（`OnModuleInit` / `OnModuleDestroy` / `enableShutdownHooks`） | **没有，且刻意没有** | 见下 |
| 实体 → Repository（自动 CRUD） | **没有，也不该有** | 框架不知道你的表 |

**为什么生命周期是刻意缺的**：不是因为「agentia 比 NestJS 小」，而是**进程级决策归谁**这条边界
（spec 里成文的说法是「不读 env、**不做进程级决策**」）。NestJS 的默认路径是 `NestFactory.create()`
→ `listen()`：进程的启动与关闭都在它手里，`enableShutdownHooks()` 才有意义。

agentia 的同族纪律是一整排：**不读 env**（[deployment](./deployment.md) §1）、**不订阅信号**
（[usage-guide](./usage-guide.md) 的优雅停机小节）、**不关 store**（`TaskStore.close?` 的注释）、
**`createHttpHandler` 只返回 handler 不 listen**（`src/transport/http.ts` 的注释写的就是「宿主自己
`http.createServer(createHttpHandler(app)).listen(...)`」）。`createApp` 返回纯对象 ⇒ 它不知道、
也不打算知道你的进程何时关。

⚠️ 这条边界有**一个例外**：MCP 反向桥（`src/engine/mcp-server-http.ts`）会 `listen` —— 那里 agentia
自己**就是**被外部客户端连的服务端。例外不改变主宿主路径：不自持进程。

⇒ 「替宿主关池」在这里是**越权**，不只是「没必要」—— 同一个池可能还被调度器或另一个宿主共用。
`AsyncRunner.drain()` 明确**不**关 store（`TaskStore.close?` 的注释写了为什么），
`process.on('SIGTERM', …)` 是宿主的事（[usage-guide](./usage-guide.md) 的优雅停机小节）。

⇒ 接法就是把它挂在你自己的停机序列末尾（完整序列 `drain` → `sink.drain` → `sink.close`
见 [observability](./observability.md) 的停机配方）：

```ts
// 手写版：注意别写成 `if (stopping) return` —— 那样信号**已被拦截**而默认行为不会发生，
// 运维第二次想强杀时杀不掉（同一族坑共四个，清单见 deployment.md §5）。
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) process.exit(1); // 第二次信号要**放行**，不是忽略
  stopping = true;
  void (async () => {
    await handler.drain({ timeoutMs: 15_000 }); // 拒新单 → 等在飞 run 收尾
    await sink.drain();                         // 攒批 sink 发完
    await pool.end();                           // ← 你的池，你关（框架不会碰它）
    process.exit(0);
  })();
});
```

不想自己扛那四个坑就用 `gracefulShutdown()`（2026-10-22 ref-serve-graceful-shutdown，与 `serve()` 配套）：池的 `end()`
排在 `onShutdown` 里，仍是**你**关它 —— 框架只负责把「停机已到底」这个时刻告诉你。

```ts
import { gracefulShutdown } from '@migor/agentia';

gracefulShutdown({
  server,
  drain: async () => {
    await handler.drain({ timeoutMs: 15_000 });
    await sink.drain();
  },
  signals: ['SIGTERM', 'SIGINT'],
  onSecondSignal: () => process.exit(1),
  onShutdown: async (clean) => { await pool.end(); process.exit(clean ? 0 : 1); },
});
```

