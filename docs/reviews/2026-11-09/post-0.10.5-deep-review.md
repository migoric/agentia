# 0.10.5 之后的深度评审（项目面 + 11-07 修复批）

> 范围：`main` @ `add44aa`（v0.10.5 之后 10 笔提交，其中 4 笔内核修复约 2,059 行）。
> 判据一律走仓库定位（`AGENTS.md` 硬约定 / `docs/spec.md` §10 `2026-11-07 ref-deep-review-2026-11-07`）。
> **只评审已提交内容**（AGENTS.md「结论一律钉到 commit」）。

一句话结论：**这一批修复的判定方向全部正确，三处最危险的静默失效（唤醒双派发、审批作用域、
失败 usage 漏账）都收口了，且没有为了修一处而改坏另一处；问题集中在「跨进程恢复时哪些进程内
引用被剥掉了」这一条上 —— 剥掉的清单比文档承诺的多两项（主 `client` 与 `tools`），而恢复路径
无从区分「本来没传」与「被剥掉了」。**

> 2026-11-09 追加：P1-1 与 P2-2 已按最小改动面落地（`ref-resume-dropped-refs`，公共 API 零变化），
> 见 §3 各条标题后的 ✅ 与 §4 的落地标记。**本轮清单已全部收口**（P1-1 / P2-1 / P2-2 / P2-3 / P3 六条）。

---

## 0. 验证基线（本机实跑，不是推断）

| 项 | 结果 | 备注 |
|---|---|---|
| `tsc -p tsconfig.json` + `copy-assets` | ✅ | `npm run build` 的 `clean-dist` 被宿主 safe-delete 拦下（`dist` 355 文件 > 阈值 50），改用不删目录的等价编译 |
| `verify-all.sh rapid` | ✅ 3/3 | typecheck + `biome ci --error-on-warnings`、`typecheck:types`、`typecheck:tests` |
| 框架套件 | ✅ **1913 用例 / 0 失败** | 覆盖率 **97.99 / 92.17 / 98.84 / 97.99**（门禁 95 / 89 / 95 / 95） |
| CLI 套件 / trace-view 套件 | ✅ | |
| `npm test` 整体 | ⚠️ 本机报框架套件 `exit 1` | **环境噪音**：c8 清 `coverage/tmp`（219 文件）被 safe-delete shim 拦下。换 `--temp-directory` 重跑即 `EXIT=0`。CI 无该 shim |
| `verify-all.sh`（8 步全链，含 e2e / website） | ⏸ 未跑 | 推送前应补 |

---

## 1. 项目面判断

| 维度 | 判断 | 判据 |
|---|---|---|
| 分层 | 🟢 严格单向，且有**可执行**断言 | `tests/architecture/layering.test.ts` 的 ALLOWED 表；`core`/`container` 是叶子 |
| 运行时依赖 | 🟢 真的零依赖 | 三个包 `dependencies` 为空 + `no-runtime-deps.test.ts`；SDK 退到 devDependencies 只做类型门禁 |
| 类型严格度 | 🟢 `exactOptionalPropertyTypes` 承重且在守卫里 | `tsconfig-strictness.test.ts` 钉住；本次新增的可选字段一律 `...(cond ? {k:v} : {})` |
| 文档单源 | 🟢 一处写、四处消费 | `docs/usage-guide.md` → 两包 `dist/AGENTS.md` + `llms-full.txt` + 人类速查；`usage-guide.test.ts` 拿表格逐项对源码 |
| 测试密度 | 🟢 1913 用例 / 26k 行源码 | 但**新件**的故障分支覆盖不齐（见 P2-3） |
| 规模约束 | 🟢 有体量闸且这次是**显式**抬阈值 | `source-size` 750→800、`agentLoop` 240→260，理由写进 spec §10，不是偷偷改 |
| 发布面 | 🟢 单一份清单 + 逐项计数断言 | `scripts/release-surface.mjs` / `check-release.mjs` 挂在 `prepublishOnly` |

整体形态是「**框架薄、边界厚**」：公共 API 只增不改，代价都写在文档里（`LIMIT_SEMANTICS` 真源表、
`§7 已知边界`），这在同类项目里少见。

---

## 2. 11-07 修复批逐笔

### 2.1 `2ed5fcc` fix(transport) —— 唤醒互斥 + 停机/流生命周期

**做法**：新增纯件 `TaskWakeGate`（per-task Promise 串行），四路唤醒（approve / signalTask /
审批超时 / 到期唤醒）共用；`stream-janitor` 兜跨进程 SSE 收口。

**评价**：`TaskWakeGate` 是这次质量最高的一件 —— 62 行、100% 行/分支/函数覆盖，语义只有一句话
（「最后一个登记的 tail 在它及之前所有路径收口后才 resolve」），而且这个语义同时解决了两个问题：
互斥 + `cancel` 的等待句柄（`#advanceInflight` 优先读 tail，见 `async.ts:838`）。`run()` 里
「只摘自己」的 delete 守卫和 `prev.catch(() => undefined)` 的链接都写对了。

**两处值得记的细节**：
- `gracefulShutdown` 的二次信号（`serve.ts:152`）：Node 的默认终止动作在信号投递那一刻按
  「当时有没有监听者」决定，所以在 handler 里摘监听不会补做默认动作 —— 必须重新投递。这个
  修法是对的，且注释把机理写清了。
- `/run` 读完 body 后重判 draining（`http-endpoints.ts:349`）：读 body 的 await 窗口里
  `inFlightRuns` 仍是 0，drain 会返回 true；不重判就会在「已排空」之后起一条新 run。判据和
  修复位置都准确。

**发现**：P2-2（每连接一个定时器）、P3-5（二次信号的注释断言过强）。

### 2.2 `67bf996` fix(engine) —— 审批作用域 + 失败尝试记账

**做法**：`approvalEpoch`（只认 `requestedAt === 本次 suspendedSince` 的决定）+ 每段
`consumedApprovals`（同一 id 只批一次）+ `fillTimeoutDenials` 的 stale 覆盖；适配器把流中断前
已收到的计量挂到错误上，引擎记进失败 turn span 与 `usage.partial`。

**评价**：这是四笔里**最容易改出洞**的一笔，因为审批正确性靠三处判定互相咬合，任何一处口径
不一致都会重新打开绕过面。逐处核对的结果是自洽的：

| 位置 | 判定 | 与另两处是否一致 |
|---|---|---|
| `turn.ts:617-631` `approvalDecisionFor` | `requestedAt !== epoch` ⇒ 不认 | ✅ 与写入端同源 |
| `approval-supervisor.ts:232-244` 写决定 | `requestedAt = rec.suspendedSince` | ✅ epoch 就是这个值 |
| `approval-policy.ts:40-56` 超时兜底 | 旧 epoch 的决定不挡本次 deny | ✅ 同一判据 |
| `approval-policy.ts:63-69` `approvalsComplete(rec, since)` | 旧 epoch 的决定不算齐 | ✅ 同一判据 |
| `run-outcome.ts:105-124` F2 `sameWait` | 只保留「纯事件唤醒、一个决定都没做」的时钟 | ✅ 不刷新时钟 ⇒ 超时仍能到点，且不会复用已消费的决定 |

`sameWait` 那条尤其值得记：它把「事件投递把审批超时无限推迟」和「沿用 since 导致旧决定被复用」
两个相反方向的错同时避开了，判据写成「旧决定必须一个都没做过」才保留时钟 —— 这是对的。

**发现**：P3-6（`stop-reason` 的空转外层 if）、P3-7（`metricsSink` 负数）。

### 2.3 `60c48cd` fix(integrations) —— 出站边界 + MCP 流

**做法**：三处适配器 + MCP 两处（POST / DELETE）全部 `redirect: 'manual'`；MCP SSE 改增量读；
反向桥默认不暴露 `approval:'required'` 工具。

**评价**：`redirect: 'manual'` 是全仓一致性最好的一笔 —— 五个出站 fetch 一个不漏，且注释把
「307/308 会把 x-api-key 与整段对话 body 发到另一个 origin」这个具体后果写明，而不是笼统写
「安全加固」。MCP SSE 从 `res.text()` 改增量读也修在了根因上（规范只说 server **SHOULD** 关流，
保活的 server 会让 `text()` 永不 resolve）。

**发现**：P3-4（`sse.ts` 的上限检查判据）、P3-1（`jsonlTraceSink` 缓存键）。

### 2.4 `5ea8dd2` fix(store) —— 持久化恢复 + 记忆回写

**做法**：`serializeTaskRecord`（拷一份再删进程内引用）、FileTaskStore 降级态禁 compact +
append 失败回滚、SQLite 迁移事务化 + `healRow` 拆两步 + json CAS、Redis `list` 去重 + 单 key 容错、
Memory 水合失败禁回写。

**评价**：`serializeTaskRecord` 的**写法**是对的（`cloneTaskRecord` 先拷、不碰调用方记录、
返回新对象），`healRow` 拆两步（派生列先拉正、json 用旧值 CAS）也是对的 —— 合并成一条会让
`WHERE json=旧值` 因为「写进去的是新 json」而永不命中，这个坑避开了。

**但这一笔引入了本次唯一一条 P1**：删掉的清单比文档承诺的多（见 P1-1）。

---

## 3. 问题清单

### P1-1（✅ 已修，2026-11-09 `ref-resume-dropped-refs`）恢复段的主 `client` 与 `tools` 被静默剥离，恢复路径无从区分

**位置**：`src/store/record.ts:86-100`（`delete rest.client` / `delete rest.tools`）、
`src/transport/run-call-options.ts:86-90`。

**事实**：
1. `serializeTaskRecord` 删了 `signal` / `client` / `onText` / `onTraceEvent` / `tools`。
2. `record.ts:83` 的注释只解释了 **fallback 环**（「只保留 `model`，client 由 runner/应用级
   配置兜住，与文档口径一致」），`spec.ts:86` 的文档口径同样只讲 fallback 链。
3. 但 `delete rest.client` 删的是**主 client**，`run-call-options.ts:86` 的第一优先级分支正是
   `rec.spec.options.client`；`delete rest.tools` 删的也是主菜单（`spec.ts:75` 的
   `tools?: AgentTool[]`）。

**后果**：提交时用 per-task 自定义 client（典型：OpenAI 兼容端点）或自定义工具菜单的任务，
跨进程恢复/重启续跑时会**静默**退回 runner 级 client 与装配菜单。两条都不会报错：
- client 退回后在 `run-config.ts` 的鸭子校验能过（runner client 是合法的），只是打到了另一个
  端点/厂商；
- 工具菜单退回后模型看到的是装配菜单，恢复段可能执行与原任务不同的工具集。

**为什么这比改之前更危险**：改之前 client 被 JSON 成 `{messages:{}}` 空壳，会在
`assertModelClient` 响亮失败 —— **响亮但错误**。改之后是**安静但可能错**。修复方向没错，
缺的是「被剥掉了」这个信号。

**最小改动**（不动公共 API）：`serializeTaskRecord` 在剥离时留一行标记，例如
`options.__dropped: ['client','tools']`（或 `spec.droppedRuntimeRefs`），
`buildRunCallOptions` 见到就在**恢复段第一次** `console.warn` 一次，写明「原任务带了 X，
本段已退回 Y，跨重启要成立请把 X 放到 runner 级」。这与仓库既有的
「不静默降级」纪律（`sessionId` 那条 `ref-session-id-warn`）同款。

**落地**：`record.ts` 新增内部键 `DROPPED_REFS_KEY`（`__agentiaDroppedRefs`，刻意不进
`RunInvocationOptions` 公共类型面）与读侧 `droppedRuntimeRefsOf`；`run-call-options.ts` 在
`buildRunCallOptions` 入口判一次（**不分是不是续跑段** —— 重启后认领的 `queued` 任务同样丢
per-task client，而 `isResume` 对那种记录为 false），按 taskId 去重告警、上限 1000，装配前
把键剔除。零 API 变化。

### P2-1（✅ 已修，2026-11-09 `ref-stream-janitor-singleton`）`streamTask` 每连接一个定时器做跨进程兜底

**位置**：`src/transport/async.ts:320`（5s 常量）、`665-735`（每连接 `createStreamJanitor`）。

**事实**：`createStreamJanitor` 在 `streamTask` 内**每个订阅**建一个 `setInterval`，每拍
`store.get(taskId)` 一次。`timer.unref()` 只保证不挂住进程，不减少读放大。

**后果**：N 个并发 SSE 连接 = N 个定时器 + N/5 次/秒的 store 读，无合并、无上限、无退避。
SQLite 单写者场景下这是读锁压力，Redis 场景下是 N/5 QPS。跨进程收口是低频事件，不值得
按连接付这份成本。

**最小改动**：runner 级一个扫描器（一个 timer，遍历 `#streams` 的活跃 taskId 集合），
单连接仍是「登记/注销」。`stream-janitor` 纯件可原样复用，只是把 `pollMs` 的持有者从
「每个连接」提到 runner。

**落地**：`stream-janitor.ts` 改成 `createStreamJanitorGroup`（`add(taskId, target)` /
`close()`）：一拍里每个**任务**只读一次 `store`，再分发到该任务的各个订阅；定时器**有登记
才存在**，最后一条注销即停。`streamTask` 的 `pollMs` 从此是开关（`<= 0` = 这条流不参与
兜底），间隔只有一个来源。`async.ts` 749 → 755 代码行（抽掉的每连接 janitor 被单例取代）。

### P2-2（✅ 已修，2026-11-09 `ref-resume-dropped-refs`）`expireIfExpired` 的返回值与实际行为不一致

**位置**：`src/transport/approval-supervisor.ts:136-143`，配合 `:284` 的
`if (this.#wakeGate.busy(rec.taskId)) return;`。

**事实**：`#expireAndResume` 因 `wakeGate.busy` 跳过时是**静默 return**，但
`expireIfExpired` 仍返回 `true`；`resume-scanner.ts:202` 据此 `expired++`。

**后果**：① `resumePending` 的返回计数虚高（说「处理了 N 条」，实际跳过了一部分）；
② 若宿主只在启动时调一次 `resumePending`，这次跳过就等于这条任务的审批超时兜底丢了 ——
注释说「下一轮还会再判」，但下一轮的触发者只有 `poll`（`awaitTask` / 读任务状态）或
新的 janitor 轮询，宿主若不读状态就没有下一轮。

**最小改动**：`#expireAndResume` 返回 `boolean`（跳过 = false），`expireIfExpired` 透传；
`resumePending` 只在 true 时计数。这样「说了做了」与「真做了」对齐。

**落地**：`#expireAndResume` 两处跳过改为 `return false`、接管分支 `return true`，
`expireIfExpired` 直接 `return this.#expireAndResume(...)`。新增一条用例（闸被占 ⇒ false，
闸空出来 ⇒ true，含阳性对照），`record.ts` 与本次改动均有直接单测。

### P2-3（✅ 已修，2026-11-09 `ref-stream-janitor-singleton`）新件的故障分支覆盖不齐

| 文件 | 行 | 分支 | 未覆盖行 |
|---|---|---|---|
| `stream-janitor.ts` | 88.31 | **68.75** | 37-38、46-48、53-56 |
| `resume-scanner.ts` | 98.14 | 88.57 | 122-127 |
| `approval-policy.ts` | 100 | 96.42 | 68 |

`stream-janitor` 未覆盖的三处**恰好都是故障路径**：`safe()` 的 catch、同步 `poll` 抛、
`rec === undefined` 的 `onClosed` 收口。整体阈值（89）挡住了全局退化，但挡不住「新件的
故障分支没测」。这类分支的价值就在于出事时那一跳 —— 建议补三条小用例（65 行的现有测试
文件里加即可）。

**落地**：重构后该件的故障面变成六条，全部有用例：异步 reject、**同步 throw**、记录消失、
换主、`ownerId` 缺失、收口回调自己抛错；另加两条结构性不变量（同任务 N 个订阅一拍只读
一次、注销幂等 + 最后一条注销后停止轮询）。行覆盖 88.31 → **100**，分支 68.75 → **89.36**
（剩下的分支是「poll 进行中订阅被摘」这类需要精确插桩的窗口，已由 `live.has(target)`
的二次检查兜住，但不值得为它造时序夹具）。

### P3 级（✅ 全部已修，2026-11-09 `ref-stream-janitor-singleton`）可读性 / 边界口径

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P3-1 | `src/integrations/file-sink.ts:37,64` | 进程内缓存只按 `path` 做键 ⇒ `{path, fsync:true}` 与 `{path}` 拿到**同一个** sink，后者的 `fsync` 被静默忽略 | 键带 `fsync`，或第二次请求与既有 sink 不一致时出声 |
| P3-2 | `src/core/sse.ts:27` | 8M 上限检查在**按行切分之前**，判的是整个 `buf`。一个 9MB 但每行都很短的 chunk 会被误判成「单行超限」 | 判据落在「切片后剩余的末行长度」上（undici 单次 read 通常 64KB，实际难触发，但逻辑上是假阳性） |
| P3-3 | `src/engine/stop-reason.ts:40-55` | 外层 `if (max_tokens \|\| model_context_window_exceeded)` 里只对后者 return，`max_tokens` 那半空转，下面还有一条独立分支 | 收成 `if (stop_reason === 'model_context_window_exceeded')` |
| P3-4 | `src/integrations/metrics.ts:285` | `intervalMs` 只挡 `NaN` 与 `>2^31-1`，**负数放行**（走 `<=0` 立即导出、不设 timer，行为等同 0） | 要么挡负数，要么在 `LIMIT_SEMANTICS` 里把负数读法写成 `0` |
| P3-5 | `src/transport/serve.ts:152` | 注释断言「此时已无监听者」—— 那只对本件的监听成立；宿主若也注册了同信号 handler，二次投递会被宿主吞掉，仍不终止 | 注释收窄成「本件的监听已摘」，或改成 `process.exit(128+n)` 兜底 |
| P3-6 | `src/engine/turn.ts:361` 附近 | `const any = ...`（局部变量名遮蔽全局工具类型名） | 改名 `hasUsage` |

**落地**：P3-1 键仍按路径（键带 `fsync` 会让同一文件有两个写者 ⇒ 一次 run 落两行），改为
不一致时 `console.warn` 一次；P3-2 判据换成**切出来的那一帧**（顺带加了「一帧 9M 连换行
一起到达仍要拒」的对照，防修 P3-2 把 OOM 守卫换掉）；P3-3 收成单条件；P3-4 写进
`LIMIT_SEMANTICS`（`zeroClause` = `0 = 立即导出，负数同 0`）并补负数用例；P3-5 注释收窄为
「本件的监听已摘」并把「保证必死」指到 `onSecondSignal`；P3-6 改名 `hasUsage`。

### 待确认（不算缺陷，但是设计取舍该记一条）

`TaskWakeGate.run` 的等待链**没有超时**：若某条唤醒路径的 `fn` 永不 settle（例如宿主 store 的
`save` 挂住），同任务后续所有唤醒会永久排队，且 `cancel` 的 `await tail` 也会一起挂住。
当前 `fn` 只碰 store，属于「宿主必须最终 settle」的隐含前提。建议在 `task-wake-gate.ts`
的文件头补一句这个前提（零代码改动）。

---

## 4. 建议的最小改动面

按投入产出排序（**全部已落地**，见 `docs/spec.md` §10 的 `ref-resume-dropped-refs` 与
`ref-stream-janitor-singleton` 两条）：

1. **P1-1**：`serializeTaskRecord` 留剥离标记 + `buildRunCallOptions` 警告一次。**✅ 已落地**
2. **P2-2**：`#expireAndResume` 返回 `boolean`，让计数与事实对齐。**✅ 已落地**
3. **P2-3**：`stream-janitor` 补故障路径用例。**✅ 已落地** —— 实际补了 6 条（四类故障 +
   两条结构性不变量），因为重构后这个件换成了「组」的形状，故障面跟着多出「注销 / close」。
4. **P2-1**：janitor 提到 runner 级单例。**✅ 已落地** —— 与 P2-3 同一笔做（不变量与被测对象
   是同一个件，分开做等于先把用例写在一个即将被替换的形状上）。
5. P3 六条。**✅ 全部已落地**（P3-4 选了「写进表」而不是「挡负数」：`<= 0` 的读法在代码里
   一直成立，缺的是把它登记成口径）。

---

## 5. 没有问题的部分（避免误伤）

这几处我按「可能改坏」的怀疑重点核过，结论是**对的**，不要再动：

- `TaskWakeGate.busy()` 与 `run()` 之间的 TOCTOU：两个调用在**同一个同步段**（中间无 await），
  先登记者赢的语义成立。
- 三条路径（signal / wakeDue / expire）在 gate 内不互相 `await` 对方的 gate（`signalInner`
  只碰 `store` 与 `unmarkSuspended`；`wakeDueInner` 同样），没有互等死锁。
- `consumedApprovals` 在 `executeOneTool` 里**采用即消费**（`turn.ts:726`），不是在
  `executeTurnTools` 的悬停判定里消费 —— 顺序正确，否则并行批里同一 id 会被重复采用。
- `serializeTaskRecord` 用 `cloneTaskRecord` 先深拷，不改调用方记录。
- `healRow` 拆两步 + json CAS：合并会让 CAS 永不命中，拆开是对的。
- `redirect: 'manual'` 覆盖了全部五个出站 fetch，无遗漏。
- `retryAfterMsOf` 同时支持秒数与 HTTP-date，且经 `clampTimerDelay` 夹到可兑现区间。
- `TaskWakeGate` 的等待链**没有超时**（见 §3「待确认」）：这不是缺陷，是隐含契约 ——
  「`fn` 必须最终 settle」。已写进 `task-wake-gate.ts` 的头注（零代码改动）：超时语义
  （「超时后放行」= 互斥失效）比挂住更危险，所以选择写明前提而不是加计时器。
