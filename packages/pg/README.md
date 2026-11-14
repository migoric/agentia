# @migor/agentia-pg

把 Agentia 的**宿主存储**落到普通 PostgreSQL 表上。两个实现，都是 `@migor/agentia` 既有接口的实现——不是新抽象：

| 导出 | 实现 | 解决什么 |
|---|---|---|
| `PgTaskStore` | `TaskStore` | 多 pod 共享同一个任务队列（含幂等键、到期索引） |
| `PgSessionStore` | `SessionStore` | 多副本共享同一段对话历史（append-only，按轮次裁剪） |
| `ensureSchema` / `schemaDdl` | — | 幂等建表；`schemaDdl()` 给没有 DDL 权限的实例导出纯 SQL |

**零第三方运行时依赖**：PG 客户端是 duck-typed 的（只要 `query(text, params)`），本包不 import `pg`。`@migor/agentia` 是 `peerDependency`，由宿主提供兼容版本，不捆进本包产物。

## 快速开始

```bash
npm i @migor/agentia @migor/agentia-pg pg
```

```ts
import { Pool } from 'pg';
import { PgTaskStore, PgSessionStore } from '@migor/agentia-pg';
import { AsyncRunner } from '@migor/agentia';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// create = 建表（幂等，并发首启有重试）+ 构造。多个 pod 同时首启是正常用法。
const store = await PgTaskStore.create(pool);
const sessionStore = await PgSessionStore.create(pool, { maxTurns: 20 });

const runner = new AsyncRunner(app, { store, sessionStore, concurrency: 4 });
```

已经由 DBA 建过表、或想把建表放在部署/迁移脚本里（推荐：建表不该在每次启动的 DI 装配里隐式发生）：

```ts
// 迁移脚本里跑一次
await ensureSchema(pool);

// 应用启动（每个 pod 都这么做；new 只校验配置 + 拼 SQL，不碰网络）
const store = new PgTaskStore(pool);
const sessionStore = new PgSessionStore(pool, { maxTurns: 20 });
```

`create()` 与 `new` 的差别只有一句：前者先跑 `ensureSchema` 再构造。没有 `migrate: false` 之类的旋钮。

### 本地与 CI：不需要起 PG 容器

`@electric-sql/pglite` 是 PostgreSQL 编译成的 WASM，实例本身就满足 `query(text, params)`：

```bash
npm i -D @electric-sql/pglite
```

```ts
import { PGlite } from '@electric-sql/pglite';
import { PgTaskStore, ensureSchema } from '@migor/agentia-pg';

const db = new PGlite();            // 内存库，零配置
await ensureSchema(db);
const store = new PgTaskStore(db);  // 直接传，不用适配器
```

宿主自己的单测可以这么跑（本包的 52 条用例就是），**但要知道它验不到什么**：PGlite 是单连接单进程，多写者并发、锁竞争、`pg` 驱动的连接池行为都测不出来（见文末「验证到什么程度」）。

### 没有 DDL 权限的实例（RDS / Aurora 只给 DML 很常见）

`ensureSchema` 里跑的就是 `schemaDdl()` 生成的语句，把它交给 DBA：

```ts
import { schemaDdl } from '@migor/agentia-pg';
console.log(schemaDdl().join(';\n\n') + ';');
```

默认建三样东西：表 `agentia_tasks`、表 `agentia_session_messages`、序列 `agentia_task_save_seq`（外加四个索引）。用 `tablePrefix` / `schema` 分命名空间：

```ts
await ensureSchema(pool, { schema: 'public', tablePrefix: 'staging_' });
```

两个值都必须是**小写标识符**（`^[a-z_][a-z0-9_]*$`）——它们是唯一被拼进 SQL 文本的输入，不合规直接抛错，不做静默容错。

⚠️ **已有大表时别在应用启动里跑 `ensureSchema`。** 语句用的是普通 `CREATE INDEX`（不带 `CONCURRENTLY`），在千万行表上会给写入加锁 —— 首次建表时无所谓，**升级到带新索引的版本**时会把线上写请求堵住。那种场景把 `schemaDdl()` 交给 DBA，用 `CREATE INDEX CONCURRENTLY` 单独建，应用侧只 `new`。

### 用 `postgres.js`（标签模板 API）

它和 `query(text, params)` 的调用形态相反，包一层就行。注意它的 `unsafe()` 返回的是**行数组本身**（带 `count` 元数据），不是 `{ rows }` —— 所以直接把返回值当 `rows` 递进去：

```ts
import postgres from 'postgres';
import type { ParameterOrJSON } from 'postgres';
import type { PgClient } from '@migor/agentia-pg';

const sql = postgres(process.env.DATABASE_URL);

const client: PgClient = {
  query: async (text, params) => {
    const rows = await sql.unsafe(text, (params ?? []) as ParameterOrJSON<never>[]);
    return { rows, rowCount: rows.count };   // count 不映射也能跑，只是 prune() 会返回 0
  },
};
const store = new PgTaskStore(client);
```

`@neondatabase/serverless` 的 HTTP 模式、`pg` 的 `Pool` / `Client`、PGlite **都不用包**，直接传。
任何中间层（加日志 / 加指标 / 测试替身）也一样，`{ query: (t, p) => ... }` 直接写 ——
`PgClient.query` **不是泛型方法**，行形状由本包内部断言，包装层不需要 `as unknown as`。

### ⚠️ 别把 `pool.query` 解构出来

```ts
new PgTaskStore({ query: pool.query });   // 类型通过、构造通过、第一次 save 炸
```

`pg` 的 `Pool.query` 依赖 `this`（内部读连接池状态）。解构后第一个 `save` 抛的是
`TypeError: Promise is not a constructor` —— 指不到"你解构了方法"这件事。构造期校验只能查
`typeof query === 'function'`，查不出 this 绑定，**这一条只能靠你知道**。

要包一层就显式转发：`{ query: (t, p) => pool.query(t, p) }`；或者干脆直接传 `pool`。

## 三条会静默出错的边界

这三条不是"待办"，是当前实现的真实形状。写在这里是因为它们的表现都是**静默**的。

### 1. `list()` 是全表

`TaskStore.list()` 的接口没有分页参数，而 `resumePending` 的恢复扫描依赖它的完整性。**加 `LIMIT` 会让恢复扫描漏记录**，症状是"任务静默不恢复"——比慢更糟。所以本实现不加。

意思是：任务表涨到百万级时该做归档（把终态老记录搬到另一张表），而不是给它加 `LIMIT`。到期唤醒那一半已经走 `listDue()`（`(status, wake_at)` 部分索引，O(到期数)），不受此影响。

### 2. 会话的 `jsonb` 存不下 `\u0000`（任务记录不受此限）

会话内容里含空字节时，PG 会报 `unsupported Unicode escape sequence`。LLM 输出里出现空字节不算罕见（二进制内容被当文本、PDF 抽取的残留）。

`PgSessionStore.append` 会把那句错误**换成**一条指得出位置的 `TypeError`（含"请在入库前清洗"的解法）。别指望它自己洗——清洗策略是业务的（转 base64 还是剔除，取决于你下游怎么用）。

`PgTaskStore` 的任务 JSON 列用 **`text`**：查询都走派生列，不需要 JSON 操作符，因此合法任务文本里的 NUL 可以逐字往返，不做静默清洗。会话仍需 `payload->>'role'` 来按轮次裁剪，所以保留 `jsonb` 与上面的明确边界。

### 3. PG 没有 TTL

Redis 版靠 `EXPIRE` 让键自己消失，PG 的等价物是定时 `DELETE`。所以只有显式的 `prune()`：

```ts
// 删掉「整段都没动过」的会话，返回删除行数
const n = await sessionStore.prune(30 * 86400 * 1000);
```

判据是**该会话最后一条消息**早于 cutoff —— 一直在用的会话不会被删，哪怕它的开头很旧。这条语义与 Redis 的 `EXPIRE` 对齐（过期以键为单位，不以元素为单位）。

**它刻意不按行删。** `DELETE ... WHERE created_at < cutoff` 会切在轮次中间：某轮的 `user` 落在 cutoff 前、`assistant` 落在后，保留下来的历史就以 `assistant` 开头，下一轮直接撞厂商的角色交替校验（400）—— 而删除本身是"成功"的，没有任何信号。要"只保留最近 N 天的消息、不管会话死活"，必须自己对齐轮次，本包不提供那个不安全版本。

⚠️ 它是 **O(全表) 聚合**（`GROUP BY session_id` + `max(created_at)`），放进夜间任务，别挂请求路径。量级参考：PGlite/WASM 上 10 万行（5000 个会话）约 70ms，真库更快；而"按行删"在这张表上**也**是全表扫（只有 `(session_id, seq)` 主键，没有 `created_at` 索引），所以这不是新引入的退化。单个会话内部留多少由构造期的 `maxTurns` 管 —— 两个旋钮分工不同，别只配一个。

挂到 `pg_cron` 上，别指望"配个数字就自动回收"——本包刻意不提供看起来像 TTL 的选项。

## 多 pod 时谁跑 `resumePending`

当前 `PgTaskStore` 已实现 `compareAndSave`：两个 pod 即使同时 `list()` 到同一份旧 `ownerId`，也只有一个能把**完整旧快照**改成自己的认领记录并派发；另一方不派发、不计入恢复数。首次同键提交则由 `claimSubmission` 在同一确定性 taskId 的主键上原子仲裁。这两条都不需要新增表或 schema 迁移，也不再以部署层互斥为前提。

如果还想让**扫描动作本身**同一时刻只在一个 pod 上跑（减少重复全表扫描，或在新旧版本混跑的滚动窗口加一道部署层互斥），可以使用 PG 的 advisory lock。它是可选的运维手段，不替代上述原子认领，也不会把审批、事件、唤醒或取消变成跨进程 CAS：

```ts
import type { Pool } from 'pg';
import type { AsyncRunner } from '@migor/agentia';

const RESUME_LOCK_KEY = 0x4147454e; // 'AGEN'；多套 Agentia 共用一个库时换不同的值

async function resumeIfLeader(pool: Pool, runner: AsyncRunner): Promise<boolean> {
  // 必须是**专用连接**：advisory lock 是会话级的，Pool.query 每次可能换一条连接
  const conn = await pool.connect();
  try {
    const { rows } = await conn.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS ok',
      [RESUME_LOCK_KEY],
    );
    if (!rows[0]?.ok) return false; // 别的 pod 正在扫
    await runner.resumePending();
    return true;
  } finally {
    // PG 的 advisory lock 在**同一会话内是计数**的：拿一次就得放一次，
    // 漏放会让锁一直挂到连接断开（连接池里的连接可能活很久）。
    await conn.query('SELECT pg_advisory_unlock($1)', [RESUME_LOCK_KEY]).catch(() => {});
    conn.release();
  }
}
```

三个必须知道的点：

- **锁是会话级的，不是事务级的。** 别用 `pg_try_advisory_xact_lock` 把整个 `resumePending` 包进一个事务：那是长时间持锁 + 与 `save` 的写路径互相等。
- **进程崩溃时锁会自动释放**（连接断开），不需要租约 / 心跳。这是它比"自建 lease 表"省事的地方，也是它唯一的强项。
- **它不是选主，只是一次扫描的互斥。** 每个 pod 都应该尝试（拿到就跑、拿不到就跳过），不要让某个 pod 成为长期 leader —— 那会把"恢复"变成单点。

启用这层可选互斥时，其他 pod 没拿到锁就照常服务，下一轮再试；不启用时则由 `compareAndSave` 仲裁孤儿认领。两条路径都不保证外部副作用恰好一次：混合新旧版本、误判 owner、外部副作用后崩溃与终态落库失败仍是 at-least-once 窗口。确定性 taskId 只是幂等标识，不是鉴权或租户隔离，HTTP 控制面仍须配置 `authorizeTask`。

## 和 Redis 版怎么选

| | `RedisTaskStore` / `RedisSessionStore` | 本包 |
|---|---|---|
| 多写者 | **前提是单宿主写者**（未走 MULTI） | PG 天然多写者，`save` 是单语句 UPSERT 原子写入 |
| 会话裁剪 | 按**条数**（`maxMessages`）：N 取奇数会让历史以 assistant 开头，下一轮撞角色交替校验 | 按**轮次**（`maxTurns`）：以 user 消息为界，边界永远落在 user 上 |
| 过期 | 原生 `EXPIRE`（整个键） | 显式 `prune()` + `pg_cron`（整个会话，语义对齐） |
| 排序语义 | 按 `createdAt` 近似（Redis 无序） | `(created_at, task_id)` 稳定有序 |
| 运维 | 又一个组件、又一套备份 | 复用已有的备份 / PITR / 审计 / RLS |

已经有了 PG 就别为了向量或队列再引一个数据库；纯高并发纯 KV 场景 Redis 仍然更轻。

## 实现上三个不显然的点

**`save_seq` 是必需的，不是优化。** `byIdempotency` 的契约是"最后一次 save 的记录赢"。SQLite 版靠 `INSERT OR REPLACE` 删旧行重插后 `rowid` 单调白送这个序；PG 的 `ON CONFLICT DO UPDATE` 走 UPDATE 路径**不产生新的物理序**（`ctid` 会变但不单调、`xmin` 会回绕）。所以有一条独立的序列列，且 UPDATE 分支必须显式 `save_seq = nextval(...)`。漏了它，同一个幂等键重提会返回旧结果——不报错，只是"任务看起来没重跑"。

**会话追加是一条语句。** `INSERT ... SELECT ... unnest($3::text[])` 把整批一次写完：一条语句即一个事务，不会出现"第 2 批失败留下半截历史"（分批 INSERT 会）。参数个数也恒定是 3 个，不受 PG 的 65535 占位符上限约束——一批 2000 条实测没问题。

**每轮对话多一次往返。** `maxTurns > 0` 时 `append` 是两条语句（写入 + 裁剪），`maxTurns: 0` 是一条。这条 RTT 没法省：把裁剪合并进写入的 CTE 不行——同一快照里 `DELETE` 看不到刚 `INSERT` 的行，合并会少裁一轮。**要按轮次裁，就得先写完再判边界。**

顺带一条并发语义：两个 pod 同时 `save` 同一 `taskId` 时，"赢"的是**后拿到行锁**的那次，不是后开始调用的那次。单条语句保证了不撕裂、不会半新半旧，但"最后一次"在并发下是锁序。这对幂等重提（同一 key 的写入通常来自同一调用方）没有实际影响，但别指望它给出跨 pod 的提交时序。

## 验证到什么程度

`test/` 里 52 条用例跑在 **PGlite**（PostgreSQL 编译成 WASM）上——真引擎、真 SQL，不是假客户端。四个变异各自被咬住（去掉 `save_seq` 的 nextval / 把按轮次裁换成按条数 / 把 `serializeTaskRecord` 换成裸 `JSON.stringify` / 把 `prune` 退回按行删）。

> 这里也记一笔已知的漏测：第一版 `schemaDdl` 把 schema 限定拼进了**索引名**（`public.agentia_tasks_idem_idx`），PG 会直接 `syntax error at or near "."` —— 而当时的测试只跑了不带 `schema` 选项的路径，全绿。现在有一条 `ensureSchema({ schema: 'public' })` 的真执行回归盯着它。

`test-live/` 另有 **6 条显式 opt-in 的真实 PostgreSQL 用例**，不进默认 `npm test`，也不随 npm 包发布。它们打的是构建后的 `dist/`，所以需要先构建，再提供一套可创建 schema 的测试库：

```bash
npm run build && npm run build:pg
AGENTIA_PG_TEST_URL='postgresql://postgres:password@127.0.0.1:5432/postgres' \
  npm run test:live -w @migor/agentia-pg
```

这个地址不限定本机：任意能从跑测试的机器连到的实例都行（远端主机、NAS 上的 Docker 容器），
只要该角色能在里面 `CREATE SCHEMA` —— 每条用例自建独立 schema 并在结束时 `DROP ... CASCADE`。

在 **PostgreSQL 18.4** 上连续验证 **3 轮，每轮 6／6（共 18／18）**，另在 **17.6** 上复跑同样
3 轮结果一致（`pg` 8.23.1）：

- **多连接首启（1 条）**：4 条真实 `Client` 连接 × 8 轮全新 schema 并发建表；实际触发过 `pg_class_relname_nsp_index` 唯一约束竞争，重试后全部收敛。
- **真实驱动与数据边界（1 条）**：`node-postgres` 的 `Pool` 能逐字往返任务 JSON 里的 NUL；会话 `jsonb` 遇 NUL 明确抛出 `TypeError`。
- **独立 OS 进程（4 条）**：两个进程首次同键并发提交时执行计数为 `[0,1]`，跟随者拿到同一 runId；另一进程已有 `succeeded` 时不执行并采纳同一结果；两个进程同时 `list()` 到旧 `ownerId` 后，恢复计数与执行计数均为 `[0,1]`，CAS 失败者不派发；使用上面那段专用连接 advisory lock 时，同一恢复窗口同样只执行一次，另一方跳过。

这些断言证明两个既定窗口内只有一个认领者，**不是**分布式 exactly-once 承诺。整体语义仍是 **at-least-once**：混合新旧版本、外部副作用后崩溃、误判 owner、终态落库失败都可能重复副作用；审批、事件、取消与到期唤醒也不在这两条能力内。advisory lock 验的是一次恢复扫描的可选互斥，不是选主。

**没验过的**（别当成已验证）：

- **完整驱动矩阵**。类型层验过 `pg` 的 `Pool` / `Client`、PGlite、`postgres.js` 包装都能直接赋给 `PgClient`（零断言）；运行时除 PGlite 外已验 `pg` 的真实 `Pool` / `Client`，但 `@neondatabase/serverless` 的 HTTP 模式仍未实测，也没有多 PG 版本矩阵。
- **多机部署与完整故障切换**。真实双进程测试是在同一台机器、同一套 PG 上做的；多机、容器滚动交接、杀写者后的备机接管，以及 PG 上的跨进程审批 / 取消 / 唤醒没有走完整部署演练。部署仍须参照 `docs/multi-replica.md`。
- **性能**。只量过 `prune` 在 PGlite 上 10 万行的量级（~70ms）。`listDue` 的部分索引、`list()` 的全表读、`save` 的吞吐都没量过。
