# 多副本部署参考架构

> 本文是 [`deployment.md`](deployment.md) §8「多副本」那一屏的展开：**同库多副本时哪些东西会坏、
> 坏成什么样、宿主怎么兜**。它不新增框架能力，也不改框架行为 —— 只把 `src/` 里已经成立的语义
> 编排成一份可执行的部署契约。
>
> 读之前请先接受一句话：**框架提供的是「单宿主写者 + 归属认领」，不是「分布式协调」。**
> 认领（`ownerId` + 活性判定）是**尽力而为**的：宁可偶尔晚捡，不可偶尔抢跑。所以「多副本同时写」
> 这件事必须在部署层解决，而不是指望框架替你锁住。

## 0. 先划清责任：框架给了什么、没给什么

| 事情 | 框架 | 真源 |
|---|---|---|
| 任务记录耐久 | 给了（File / Sqlite / Redis 三种 store） | `src/store/` |
| 单键写（last-wins 覆写） | 给了 | `src/store/redisStore.ts` 头注 |
| **多写者并发安全** | **没有**：`save` 是两次 SET（记录 + 幂等索引），**未走 MULTI** | 同上 |
| 任务归属标记 | 给了：`ownerId` = `p<pid>@<host>-<8 位十六进制>` | `src/transport/owner-id.ts` |
| 归属**活性**判定 | **部分**：同主机能问 pid，异主机只能退回「记录新鲜不新鲜」 | `src/transport/resume-policy.ts` |
| 跨进程互斥（审批 / 取消 / 唤醒） | **没有**：互斥靠**进程内** Map | `src/transport/approval-supervisor.ts` |
| 选主 / 租约续约 | **没有** | 本文 |
| 跨进程实时流（SSE） | **没有**：给一帧 `unavailable` 让客户端转轮询 | `src/transport/async.ts` |
| 会话历史（对话轮次） | **给了两个实现**：`InMemorySessionStore`（进程内）/ `RedisSessionStore`（多副本共享） | `src/runtime/session.ts` |
| 指标聚合 | **没有**：进程内累加，重启清零 | usage-guide §7 |
| 全局背压 | **没有**：`maxQueued` 只算本进程 | usage-guide §7 |

结论：**能横向扩展的只有「同步 `/run`」那一半**（无状态，每次请求独立）。异步任务那一半
（`/tasks`、审批、取消、流）是**有状态**的，它的扩展方式是「分片」或「收敛到单写者」，
不是「多加几个副本」。

## 1. 第一个陷阱：不传 `runner` 的副本会静默拥有一份内存任务表

`createHttpHandler` 的 `runner` 是**可选**的，缺省时会**自动造一个**：

- `src/transport/http.ts`：`const runner = opts.runner ?? new AsyncRunner(app)`
- `src/transport/async.ts`：`this.store = opts.store ?? new InMemoryTaskStore()`

于是「忘了接线」的副本行为是这样的：`POST /tasks` 打到 A ⇒ 记录进 A 的**进程内存**；
`GET /tasks/:id` 打到 B ⇒ **404**。它不会报错，也不会有告警 —— 只表现为「任务时有时无」，
而且负载均衡轮询下大约每 N 次出现一次。

⇒ **规则：每个副本都必须显式构造 `AsyncRunner({ store: 同一个 store })` 并传进 handler。**
反过来说，只要你计划多副本，`InMemoryTaskStore` 就自动出局（它不是「性能选项」，是「单进程选项」）。

## 2. 三种拓扑与选型判据

| 拓扑 | 配置 | 能挡什么 | 挡不住什么 | 什么时候选 |
|---|---|---|---|---|
| A. 单副本 | `SqliteTaskStore` / `FileTaskStore` | 进程崩溃后重启续跑 | 机器挂、滚动升级中断 | 内部工具、单团队、量小 |
| B. 单机多进程 | `SqliteTaskStore`（WAL + `busy_timeout`，共享卷） | 单机内的进程级故障 | 跨机；写并发仍需收敛 | 一台机器够用的业务 |
| C. 单写者 + 只读副本 | 共享 `RedisTaskStore`，`/tasks*` 全部路由到写者 | 读流量水平扩展 + 写路径唯一 | 写者本身是单点 | **推荐起点**：先能扩读，再谈扩写 |
| D. 按 `taskId` 分片 | 共享 Redis + 一致性哈希路由 | 写也水平扩 | 分片迁移要搬状态 | 任务量大到单写者 CPU 打满 |

三条判据（按顺序问）：

1. 「挂一台机器，在跑的任务能不能丢？」—— 不能丢 ⇒ 必须 C 或 D（A / B 都活不过机器故障）。
2. 「滚动升级期间要中断吗？」—— 不能中断 ⇒ C（写者交接）或 D（分片逐个滚动）。
3. 「单写者的 CPU 打满了吗？」—— 没有 ⇒ 停在 C。**D 是为量付的复杂度，不是为「看起来更像分布式」付的。**

## 3. 六个会坏的地方（按踩到的概率排序）

### 3.1 写路径交错：同一任务的两次 `save` 互相覆盖

**现象**：记录字段半新半旧；幂等索引指向的任务 id 与记录对不上；最坏情况是「审批决定丢了」。

**真因**：`RedisTaskStore.save` 是**两次 SET**（先记录、await 后幂等索引），文档写明了**未走 MULTI**。
这条顺序现在只服务**恢复派发**的去重可见性；初始异步提交已在首次落库前查询旧成功结果，
不再依赖它。调整顺序或引入事务时必须复核恢复路径，但「原子化必然破坏去重」不是当前实现的边界。

**兜法**：让写路径**只有一个写者**。三条路：路由收敛（拓扑 C）、按 key 分片（拓扑 D）、
或写路径走一个专门的单点服务（见 §7 第三种实现）。即使把两条 SET 做成原子，也只消除记录与索引
撕裂，不会给 `list() → 改 ownerId → save() → 派发` 的认领链补上 CAS，更不会变成跨进程恰好一次。

### 3.2 同一挂起任务被两个副本各恢复一次

**现象**：工具副作用执行两遍、模型花费翻倍、`onFinished` 的 webhook 双发。

**真因**：`approve` 只做两件校验 —— 记录存在、状态是 `suspended` 且原因是 `approval`
（`src/transport/approval-supervisor.ts` 的 `#approveInner`），**没有 ownerId 校验**。
它防并发靠的是**进程内**的 `#inflight` Map（同一任务在本进程的并发 approve 会共享同一个 Promise）。
跨进程时那两个 Map 互相看不见 ⇒ 两个副本都读到 `suspended`、各自判「决定齐了」、各自派发一次。

**兜法**：审批请求必须落到**该任务的 owner 副本**上（见 §7）。这是「粘性路由」存在的第一理由。

### 3.3 唤醒（`signalTask`）会**移交所有权**，而它不判断原主死活

**真因**：投递成功后直接把 `rec.ownerId` 改成本进程（`src/transport/signal-supervisor.ts`）。
这是**有意**的 —— 唤醒本来就是把任务从「在等」拉回「在跑」，谁唤醒谁负责。

**后果**：两个副本同时投递同一个 `eventId`，第二个会被 409 挡（重复投递检查）；
但**不同 `eventId` 的两条事件**同时到达两个副本时，两个副本都会认为自己拥有它。

**兜法**：同 3.2 —— 事件投递也按 `taskId` 粘到 owner。

### 3.4 `cancel` 打不到 owner（这是唯一会**响亮**失败的一条）

`cancel` 在目标 run 不在本进程时直接 409，文案写得很清楚：

> task xxx 正在运行但不在本进程，本进程无法中断它（多进程部署见 spec §10 2026-09-28 ref-cancel-api）

**好消息**：它不静默，客户端能区分「稍后重试」和「得去找那个进程」。
**兜法**：按 `taskId` 路由；或把这个 409 原样暴露给上游，让调用方带 `taskId` 重试。

### 3.5 跨进程的 SSE：给一帧 `unavailable` 就收口

连到**非 owner** 副本时（`src/transport/async.ts`）：

- 先发 `{ type: 'unavailable', reason: 'not-in-this-process' }`；
- 任务已终态 ⇒ 补一帧 `end`（带记录）；
- 非终态 ⇒ 补一帧 `closed`（**流级收尾，不是伪造终态**），然后关连接。

**客户端应对**：收到 `unavailable` 就转 `GET /tasks/:id` 轮询。不要试图「重连到别的副本」——
客户端无从知道 owner 是谁。

**要跨进程实时**：用 `onTraceEvent` 把增量事件转发到你自己的总线（Redis Streams / Kafka），
别指望 `GET /tasks/:id/stream` 在多副本下还能连续。

### 3.6 定时任务会在每个副本各触发一次

`Scheduler` **没有选主**。它靠「幂等键按 interval 窗口分片」去重，而 `src/transport/scheduler.ts` 的头注写明了
这个保证的档位：**同步 store 下**同窗口不会并发跑两遍；**异步 store（Redis / SQLite）下保证减弱** ——
上一片还在 `running` 时，新片仍会提交并**并发执行**（at-least-once 允许）。

⇒ **规则：`Scheduler` 只在**一个**副本上启动**（拓扑 C 的写者，或单独一个 cron 副本），
其余副本不要 `scheduler.start()`。要跨副本安全，就在你自己的队列里做 cron。

### 3.7 恢复扫描是**全表** `list()`

`resumePending` 每趟都 `store.list()` 全表再过滤（`src/transport/resume-scanner.ts`），
因为它要顺手重建挂起读数、判断到期唤醒。

**含义**：调用频率 × 表规模 = 你的启动/巡检开销。大表上不要「每秒扫一次」；终态记录要有
清理策略（Redis 用 `ttlSeconds`，File / Sqlite 自行 `compact()` 或定期删）。

### 3.8 会话历史跟着 pod 走：换一台就「第一次见面」

**现象**：多轮对话第一句正常，第二句忽然「忘了上文」——而且**不报错**，看起来像模型没理解。
负载均衡轮询下大约每 N 次出现一次。

**真因**：`SessionStore` 是**宿主注入**的（`session: { store, id }`），而缺省只有
`InMemorySessionStore`（`src/runtime/session.ts`）——进程内 Map。A 写入、B 读取 ⇒ B 读到空数组
⇒ 这一轮就当「首轮」处理。

**兜法**：换成 `RedisSessionStore`（同一份 Redis、同一个 `prefix`）：

```ts
import { RedisSessionStore } from '@migor/agentia';

const sessions = new RedisSessionStore(redis, {
  prefix: 'app:',
  ttlSeconds: 7 * 24 * 3600, // 语义是「最后一次 append 之后 N 秒」，每次 append 刷新
  maxMessages: 200,          // 0 = 不裁；按条数切，未知轮次边界
});
// 每个副本都用它，且 sessionId 由你的身份体系给出（不要用客户端可自填的值）
```

三条边界，都要知道：

- **它只解决「跨副本可见」，不解决「同一 session 并发」**。`append` 是 append-only：
  不互相覆盖、不丢数据，但**不保证角色交替** —— 两个并发 run 各自追加 `[user, assistant]`，
  交错成「连续两条 user」后，下一轮 `load` 出来直接撞厂商的角色交替校验（400）。
  同一 session 的并发请按 session 排队（每 session 一把锁 / 一条队列）——
  那是锁，框架不提供。
- **`maxMessages` 按条数切，不知道轮次边界**：取奇数可能让历史以 `assistant` 开头，同样撞
  角色交替。要按轮次裁就自己管，或取偶数并接受「切在被截断的一轮中间」。
- **坏数据响亮抛错**（与服务端 `FileSessionStore` 同一口径）：某一条不是合法 JSON 时 `load`
  抛 `TypeError`（带键名与序号）。框架的 `executeRun` 会把它降级成一行 warn + 「当作没有历史」
  —— run 不击穿，但这一轮上下文**确实丢了**，日志里能看到。

⚠️ 反过来说：`sessionId` 必须由身份体系给出。用客户端传上来的值等于让任意租户读别人的对话
（同 `resolveRunOptions` 那条纪律，见 `deployment.md` §3）。

### 3.9 两个写者同时扫描：没有快照 CAS 的 store 会重复认领孤儿

**现象（未实现 `compareAndSave` 的 store）**：同一个 `taskId` 跑两遍，工具副作用与模型花费翻倍；
两边各写一份结果，最后落库的是后到的那份。

**原因与能力分档**：认领输入仍是 `list()` 的全表快照。进程内有重入闸（`#inflightResume`）；
跨进程时，未实现 `compareAndSave` 的 store 走 `改 ownerId → save() → 派发`，两个写者可以拿着
同一份旧快照各自认领。实现该可选能力的 store 则把**变异前完整任务快照**作为比较条件：
只有一个写者能保存并派发，竞争失败者返回 `false`，不派发也不计入恢复数。`PgTaskStore`
已实现这条路径；Redis 与核心内建 store 仍走原路径。

为什么不能靠 `staleAfterMs` 兜：它是**新鲜度**，不是租约 —— 而且**跨主机时判不了活**
（`ownerId` 里的 pid 只在本机能问），恰好退回这个启发式。`src/transport/resume-scanner.ts`
的 `ResumePendingOptions` 注释逐字写着「别再指望它单独把『重复执行』挡住」。CAS 也不是租约：
误判原 owner 已死后，旧执行者仍可能继续产生副作用。

**兜法**：

1. 多写者扫描要关掉「同一旧快照双重认领」这个窗口，使用实现了 `compareAndSave` 的 store
   （现成实现是 `PgTaskStore`）。其他 store 仍须任何时刻只有一个写者调 `resumePending()`，
   或按 `taskId` 分片，让分片之间不共享扫描目标。
2. **混合新旧版本的滚动窗口一律按 at-least-once**：旧进程不认识原子能力。要严格避免重叠，
   先让旧写者 `drain()` 并从 LB 摘除、**确认进程已退出**，再让新写者接流量并扫描。
3. 即使原子认领成功，也要把工具副作用做成幂等（业务侧），或在 `onFinished` 的 webhook 里
   按 `runId` 去重：CAS 管不到「副作用已发生、终态没落库」这类崩溃窗口。

⚠️ Redis 的「先记录、后幂等索引」顺序只服务恢复派发的去重可见性（见 §3.1）；改动它时
必须跑恢复去重回归。给两条 SET 加事务不等于给认领加快照 CAS，仍不能替代单写者、分片或
部署层互斥。

### 3.10 用了 Postgres 之后：首提与孤儿恢复可原子认领，其他推进路径不变

`@migor/agentia-pg` 的 `PgTaskStore` 让 §3.1 那条「两次 `save` 互相覆盖」**变温和**：
记录与幂等键在**同一行**，`save` 是一条 UPSERT 语句 ⇒ 单语句即事务，不存在「记录写了、索引没写」
的中间态。它还实现了两条独立能力，不需要新增表或迁移 schema：

- **首次同键提交：`claimSubmission`**。各进程从幂等键派生同一个确定性 `taskId`，由任务主键的
  单条 `INSERT ... ON CONFLICT ... RETURNING` 仲裁。活跃或成功记录让认领失败者跟随原任务，
  不再调用 `app.run`，也不重复发 `TaskSink`；失败／取消记录可原子重置后重试。升级前已经存在的
  随机 `taskId` 记录仍可跟随，终态会映射回本次确定性 id。
- **孤儿恢复：`compareAndSave`**。比较完整 JSON 快照而不是只比 `status` / `ownerId`，避免 ABA；
  同一旧快照的两个恢复者只有一个能认领并派发。PG advisory lock 因此只是可选的扫描互斥手段，
  不再是关闭这个窗口的前提。

**射程必须说清**：审批、事件投递、到期唤醒、取消并没有因此获得跨进程 CAS，仍按 §3.2～§3.4
粘到 owner；普通 `save` 也仍是后写赢。确定性 `taskId` 只是幂等标识，**不是鉴权边界或租户隔离**，
HTTP 控制面仍须配置 `authorizeTask`，不能靠「对方猜不到 id」授权。

整体语义仍是 **at-least-once**：外部副作用后崩溃、误判 owner 已死、终态落库失败都可能让副作用
重复发生；混合新旧版本时也保留旧窗口。真实双进程测试覆盖首提与孤儿恢复的单认领，以及可选
advisory lock 的扫描互斥；它不是多机故障切换或分布式 exactly-once 证据。

> 同一个判据也适用于会话：`PgSessionStore.append` 是一条语句（整批原子），但 `SessionStore`
> 的 `append` 契约本来就**不管角色交替**——同一 `sessionId` 的并发 run 仍需调用侧串行化，
> 与 Redis 版同一条边界。

## 4. 拓扑 C：单写者 + 只读副本（推荐起点）

**核心**：把「同步 `/run`」（无状态）与「异步 `/tasks`」（有状态）**分别扩**。

```text
                   ┌──────────────────────────────┐
   client ────────▶│  LB：按路径分流                │
                   │  /run、/healthz → 任意副本     │
                   │  /tasks*        → 写者         │
                   └───────┬──────────────┬───────┘
                           │              │
              ┌────────────▼───┐   ┌──────▼─────────────┐
              │ 只读副本 ×N     │   │ 写者 ×1             │
              │ handler(runner)│   │ handler(runner)     │
              │ 不调 resumePending│ │ 调 resumePending    │
              └────────┬───────┘   └──────┬─────────────┘
                       │                  │
                       └────────┬─────────┘
                                ▼
                     RedisTaskStore（同一个前缀）
```

要点：

- **每个副本都要传 `runner`**（见 §1），但只有写者调 `resumePending()` / 开 `Scheduler`。
  只读副本的 runner 平时不会碰任务 —— 认领只发生在 `resumePending`、以及「停机时拒绝已受理记录」
  这两条路径上。
- 只读副本上的 `POST /tasks` 必须被**路由掉**，不能只是「不常见」：它一旦落到只读副本，
  记录照样会写进共享库，但派发在只读副本上发生（那条 run 的 ownerId 就是只读副本）——
  之后审批和取消都得找到它。
- `/metrics` 与 `/healthz` 的 `inFlight` / `suspended` 都是**本进程**读数（`src/transport/http-endpoints.ts`
  的 `HealthResponse` 注释写明了「多进程部署要合并看板请自己聚合」）⇒ 采集端按副本打标签，
  不要拿单副本读数当全局。

**升级路径**：写者从「单副本」变成「写者 + 备」，备平时不接 `/tasks` 流量、不调 `resumePending`；
转移时（见 §6）再由备接流量并调一次 `resumePending()`。

## 5. 拓扑 D：按 `taskId` 分片（写者水平扩）

适用：单写者的 CPU 或事件循环已经被任务量打满，且 §4 的读扩展已经做过。

- **分片键就是 `taskId`**：`/tasks/:id`、`/tasks/:id/approve`、`/tasks/:id/stream`、
  `/tasks/:id/cancel`、`/tasks/:id/signal` 都能从**路径**里直接取到它 ⇒ LB 的一致性哈希只需
  解析路径，不需要读 body。
- **`submit` 是唯一的例外**：创建时还没有 `taskId`。两种做法：让 LB 随机派发（记录落在哪个分片
  就归哪个分片），或者先在一个「ID 铸造」服务上生成 id 再按 id 路由。前者简单，代价是分片不均。
- **`resumePending` 仍会 `list()` 全表**（§3.7）。分片并不减少这个开销，除非你给每个分片
  独立的 Redis 前缀 —— 那时**不要**开 `staleAfterMs > 0`，否则跨前缀的孤儿没人捡。
  这个取舍要显式写进运维文档。
- 分片迁移（扩缩容）会改哈希 ⇒ 一段时间内「任务在 A、请求到 B」。迁移期间要么冻结新任务，
  要么接受 §3.2 / §3.4 的症状，按那个窗口的告警去兜。

## 6. 故障转移 runbook（写者挂了怎么办）

**判据先摆正**：不要拿 `staleAfterMs` 当「故障转移判据」。它是**新鲜度猜测**，
只在「判不了主人在不在」时才用 —— 而异主机部署**恰好**就是判不了的情况。

两条路，按你能接受的中断时长选：

| 路线 | 做法 | 代价 |
|---|---|---|
| 保守（不抢跑） | `staleAfterMs` 设为**大于你系统里最长任务的典型时长** | 转移慢：孤儿要等那么久才可捡 |
| 激进（快，但要求外部确认） | 编排平台确认原 Pod / 机器**已终止**（不是「不健康」），再让新写者 `resumePending({ staleAfterMs: 很小 })` | 依赖编排层给出「确定死亡」的信号 |

⚠️ **容器的坑**：同一台机器上重启（不进容器、共享 pid 空间）时，`ownerId` 里的 pid 可能被新进程
复用；僵尸进程也会让「那个 pid 还在」为真。这两种情况都会让孤儿记录**等到那个 pid 真的消失**
才可捡 —— 框架刻意不加时间硬上限兜它们（加上限就把租约换回新鲜度猜测，「长跑被抢」那个 bug 会原样回来）。
⇒ 同机重启后「任务没被捡回来」是**已知行为**，不是 bug；换机器或等 pid 消失。

标准步骤：

1. 让写者 `drain({ timeoutMs })`（能优雅停就别硬杀），确认 `draining: true` 后从 LB 摘除；
2. 编排层确认旧写者进程**已退出**；
3. 备成为写者：接 `/tasks*` 流量 → 构造 `AsyncRunner({ store })` → 调一次 `resumePending({ staleAfterMs })`；
4. 核对三个读数：`GET /healthz` 的 `suspended`（挂起读数被重建）、`GET /tasks?status=running`
   （孤儿被认领）、`runner.queued`（排队段没有被重复灌）；
5. 挂起中的任务**不需要**人工干预：等审批的等决定、等时刻的等到点，`resumePending` 会把到期的那批叫醒。

⚠️ `drain()` 是**单向闩**：置位后没有复位路径，`false`（排空超时）也意味着**宿主必须退出**。
停机窗口里被拒掉的记录已经带本进程的 `ownerId` 落库，只能等**下一次启动**认领
（`resumePending` 会按 `own-process` 跳过它们 —— 新进程的 ownerId 不同，所以能捡）。
⇒ **别指望「同一个进程里先 drain 再恢复服务」**。

**跟随者也在 drain 时放手**：同键并发提交里输掉认领（`claimSubmission` 返回 `false`）的那一趟
不执行任务，只跟着别人的记录等终态。它不是「本进程在执行的任务」——drain 一开始它就退出，
不落库、不发 `TaskSink`。没有这条出口时，一个幽灵跟随者就能让 `drain()` 永不返回（SIGTERM 之后
被编排层硬杀），同时把 `inFlight` 读数与 `maxConcurrentRuns` 的 503 闸一起顶住。
另一条同样的出口是**主人进程明确已死**（同主机、`process.kill(pid, 0)` 给出 `ESRCH`）：
跟随者据此收手，孤儿交给上面第 3 步的 `resumePending` 跑完。⚠️ 跨主机判不了活（返回
`undefined`），那种情况**没有**这条出口 —— 所以多副本部署仍然必须真的接 `resumePending`，
它不是可选项。

## 7. 跨副本粘性路由的三种实现

三处请求**必须**落到 owner：`approve`（§3.2）、`signal`（§3.3）、`cancel`（§3.4）；
`stream`（§3.5）落到别处不会错，但会退化。三者都能从路径取到 `taskId`。

1. **LB 一致性哈希**（最省事）：按路径里的 `taskId` 哈希到副本。要求副本集合稳定
   （扩缩容会改哈希），且 `submit` 是例外（§5）。
2. **路由表**（最可控）：写者把 `taskId → 副本` 写进 Redis / 服务发现；网关查表转发，查不到就
   广播或落到默认写者。多一跳延迟，换来扩缩容不搬数据。
3. **队列化**（最彻底）：副本只做 API + `submit`，执行交给**单一 worker 池**；
   审批 / 取消 / 唤醒都变成「往队列里发一条命令」，由持有任务的 worker 消费。
   SSE 改为轮询或用外部总线（`onTraceEvent` 转发）。
   这条路的代价是你自己造了一套任务队列 —— 到那一步通常该问「是不是不该自己写编排层了」。

**判据**：副本数固定且 ≤ 4 ⇒ 选 1；会频繁扩缩容 ⇒ 选 2；已经在用队列（Kafka / SQS / Redis Streams）⇒ 选 3。

## 8. 升级、混版本与回滚

- **混版本安全**：升级前写下的 `ownerId` 没有 `@host` 段 ⇒ 判定退化为「新鲜度」，
  行为与升级前逐字一致（`src/transport/owner-id.ts` 头注）。所以「先升一半副本」不会因为
  读不懂别人的 ownerId 而抢跑。
- **记录的旧形状**由 `parseTaskRecord` 读时归一，但那是**逐案维护的垫片清单**，不是通用兼容承诺。
- **回滚方向**：新代码读旧数据 OK；**旧代码读新数据不保证**（`deployment.md` §9）。
- **滚动升级的前提**：任一时刻只有一个写者（否则回到 §3.1）。用 §4 的拓扑，滚的是只读副本，
  写者单独做一次「交接」而不是「滚动」。

## 9. 多副本自检清单

- [ ] 每个副本都**显式**传了 `runner`，且用的是**同一个** store（没触发 `http.ts` 的缺省内存库）
- [ ] 除 PG 已明确关闭的首提／孤儿恢复窗口外，其余写路径只有一个写者，或按 `taskId` 分片
- [ ] `approve` / `signal` / `cancel` 三条请求**按 `taskId` 粘到 owner**（PG 的两条原子能力不覆盖它们）
- [ ] `stream` 的客户端实现了 `unavailable → 轮询` 降级
- [ ] `Scheduler` 只在**一个**副本上 `start()`
- [ ] 没有 `compareAndSave` 的 store：`resumePending()` 只在**写者**上接线；`staleAfterMs` 的值与
      **为什么是这个值**写进了运维文档（新鲜度不是租约）
- [ ] 多轮对话型能力用的是 `RedisSessionStore` / `PgSessionStore`（或你自己的跨进程实现），
      **不是**内建的 `InMemorySessionStore`；`sessionId` 来自身份体系而不是请求体
- [ ] 用 PG（`@migor/agentia-pg`）时确认过：首提与孤儿恢复已有原子认领，但其他推进路径仍需
      owner 路由（见 §3.10）；`PgSessionStore.prune()` 已挂到 `pg_cron` 之类的定时任务上
      （PG 没有 TTL，不挂就无界增长；它是**按会话**回收，不是按行）
- [ ] 多 pod 都接 `resumePending()` 时，如需减少重复全表扫描，或处于新旧版本混跑窗口，
      用 PG advisory lock 做「同一时刻只有一个在扫」的互斥；全新 PG 路径不把它当成认领前提
      （配方与三个坑见 `packages/pg/README.md`「多 pod 时谁跑 resumePending」）
- [ ] 同一 `sessionId` 的并发 run 已串行化（每 session 一把锁 / 一条队列），或已确认业务上不会并发
- [ ] 滚动升级的新旧混跑窗口仍按 at-least-once；要严格避免两个写者重叠就走**交接**
- [ ] 故障转移演练做过：杀写者 → 起备 → 同库 → 挂起任务被捡回（`/healthz` 的 `suspended` 对得上）
- [ ] `/metrics` 与 `/healthz` 的聚合在**采集端**做（不假设单进程读数）
- [ ] 已确认**不会**在 `drain()` 之后试图恢复服务（单向闩，必须退出进程）
