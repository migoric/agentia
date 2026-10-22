# Changelog

本仓库两包（`@migor/agentia` 与 `@migor/cli`）版本同步发布。
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 SemVer
（0.x 阶段：minor 可含破坏性变更，每个破坏性变更都在对应版本的「迁移」小节里写明）。
决策的完整证据链在 `docs/spec.md` §10（带时间线的决策日志）。

## [Unreleased]

### 文档：接数据库（新增 `docs/database.md` + MySQL `TaskStore` 骨架）

宿主问的是「我要连 mysql，是不是得再写个数据库的包」—— 答案是不用，但这个答案此前**没有落点**：
`TaskStore` 的注释写着「队列 / DB 版只需实现 `TaskStore`」，而宿主从零实现时要自己摸清
「哪份数据归框架、哪份归自己」「`listDue` 为什么值得实现」「多实例为什么会双跑」。

- **落库**：[`docs/database.md`](docs/database.md) —— 三件事分治表（业务数据 / 任务状态 / 会话记忆）、
  业务数据的构造注入写法（provider + `@Tool`，框架零改动）、`TaskStore` 的 6 必需 + 3 可选契约、
  可照抄的 MySQL 骨架（建表 DDL、`ON DUPLICATE KEY UPDATE`、`(status, wake_at)` 到期索引）、
  三个真坑（幂等键 last-wins 不能靠插入序 / `listDue` 写成 `JSON_EXTRACT` 等于白实现 /
  **跨进程认领不是原子的**：靠 `ownerId` + pid 存活 + 新鲜度启发式，要真原子得在 store 内部加锁，
  而那不是接口的一部分）、以及「别把业务事务和 run 记录塞进一个事务」。
- **不做什么**：不新增 `@migor/*-mysql` 包（拆包判据是**真有第二个使用方**，而 `TaskStore` 接口已冻结
  ⇒ 将来提取只是剪切粘贴，成本不随时间涨）；不把驱动放进核心（`dependencies` 仍为空 ——
  `SqliteTaskStore` 能进核只因为 `node:sqlite` 随 Node 发行）。
- **记录一个缺口**（不改公共面）：`src/store/record.ts` 的 `parseTaskRecord`（含旧形状归一）**没导出**，
  而它是读回记录的**唯一入口**；外部实现 `TaskStore` 只能 `JSON.parse(...) as TaskRecord`，
  正是那个 `as` 在讲的东西（旧记录带着已不存在的状态值被读回来）。文档里给了「自己补归一」的
  临时写法，并把导出这件事留给后续决策。
- **守卫**：`docs/database.md` 纳入 `tests/docs/code-fences.test.ts` 取样面（骨架是宿主会逐字复制的，
  必须真编译）；`docs/guards.md` 的取样面描述同步。变异 2 条各咬住预期用例：删掉 `clear()` ⇒
  `docs/database.md:124（块内第 26 行）TS2420`；把 `pool.execute` 改成 `pool.exec` ⇒
  `docs/database.md:29（块内第 13 行）TS2339`。README 中英两版补索引行。
- **§7 回答「要不要出包 / NestJS 式接入」**（同一问题问了两次 ⇒ 判据落纸）：拆包的判据是
  **真有第二个使用方**，而 `TaskStore` 接口已冻结 ⇒ 提取成本不随时间涨，提前出包反而要认领
  驱动版本 / 变体语义 / 表结构迁移；真出包时形态是**收 pool 不 import 驱动**（照 `RedisTaskStore`
  的 `RedisLike` 先例，仍是零运行时依赖）。NestJS 四部件对照：DI + token 有（但 `Token = string`，
  拼错只在首次 `resolve` 才抛）、模块化靠返回 `Provider[]` 的函数拆、**生命周期刻意没有**
  （判据是**进程级决策归宿主**：不读 env / 不订阅信号 / 不关 store / `createHttpHandler` 不 listen
  ⇒ 关池是宿主的 `SIGTERM` 钩子；⚠️ 唯一例外是 MCP 反向桥，那里它自己就是服务端）、实体 → Repository 不做。

### 新增：`serve()` / `gracefulShutdown()` —— 起服务 + 优雅停机的两个宿主原语（2026-10-22 ref-serve-graceful-shutdown）

宿主反馈「server 这块让用户写的好麻烦」。对照 `examples/deploy/src/main.ts`：108 行里约 35 行是与
业务无关的 server 样板，而那 35 行藏着四个**静默错** —— 写错没人报，只在 K8s 滚动更新那天发作：

- **新增导出**（`src/transport/serve.ts`，决策见 `docs/spec.md` §10）：
  `serve(handler, { port, host?, backlog? })` → `{ server, port, close() }`；
  `gracefulShutdown({ server, drain, signals?, timeoutMs?, onSecondSignal?, onShutdown? })` → 幂等 `stop()`。
  宿主侧从 ~35 行降到 ~8 行（两份参考示例已改用，`e2e-deploy` 仍报 `shutdownExitCode: 0`）。
- **收进实现的四条**：① 连接收干净 —— ⚠️ 版本有关：Node **19.0.0** 起 `close()` 自己会收空闲连接
  （nodejs/node#43522），只有 18.x 必须显式 `closeIdleConnections()`；而「已连接但没发过请求」的裸
  TCP **任何版本都收不掉** ⇒ 预算是必需品；② **先 drain 再 close**（反过来切断在飞请求）；
  ③ 第二次信号**不吞** —— `if (stopping) return` 是反例：信号**已被拦截**，Node 默认行为不会发生
  ⇒ 运维强杀杀不掉（两份示例当时都这么写）；④ `onShutdown(clean)` 把结论交回宿主。
- **边界**：`signals` **不传 = 一个信号都不订阅**；本原语**不调 `process.exit`**（退出码与
  「关池 / 冲 sink 之后再退」是宿主的编排）。判据是**谁发起** —— 与 Nest 的 `app.listen()` /
  `enableShutdownHooks()` 同构（那边信号订阅**默认也是关的**）。不做 `serve(app, {...})` 一体化：
  那会把 `createApp` / `AsyncRunner` / `createHttpHandler` 焊死，挂进已有 Express 的宿主反而用不上。
- **验证**：`tests/transport/serve.test.ts` 15 例（真实 http server + 真实 socket），**变异 8/8**
  各咬住预期用例后还原。⚠️ `closeIdleConnections` 那条**只能用调用断言钉**（当前运行时 Node 22
  自带该行为 ⇒ 行为断言抓不到），期望次数按运行时算 ⇒ 18 与 ≥19 上删掉它都红。
- **同步**：`docs/usage-guide.md` 优雅停机小节、`docs/deployment.md` §5（含那四个坑的清单）、
  `docs/database.md` §7（`pool.end()` 接在 `onShutdown`）、`docs/guards.md` 登记行。

### 修复：`view` 取最近 N 条、`harvest` 接 opt-in 文本、bundle 加构建期语法闸（2026-10-21 ① ref-view-limit-harvest-text）

对最近 45 个提交复评后的一批修复（评审记录 `docs/reviews/2026-10-21/recent-code-review.md`）。
四条都是「两边各自自洽、中间那条缝没人负责」的同族失效：

- **`agentia view --limit` 缺省取「最近」N 条（P1，主场景失效）**：`.agentia/traces.jsonl` 只增不减
  （`dev-runner.ts` 明写不轮转），最新在文件末尾，而原实现 `slice(0, cap)` 取**最早** N 条 ——
  长跑 dev 环里「想复盘刚才那次」拿到的是今早第一批。实测：4 行文件 `--limit 2` 出
  `t1-old` / `t2`，最新的 `t3` 不在页里；注释还自称「与 dev 面板 ring 50 对齐」（ring 保留最新，
  方向正好相反）。同一条纪律下沉到去重：位置跟着**最后一行**（`Map` 原地 `set` 不移动位置）。
  新增 `--head` 保留「从头看」，截断文案按方向说（`只含最近 N 条` / `只含最早 N 条`）。
- **`harvest` 读 `output.text`（P2，与 2026-10-16 ① 同族）**：框架早有 `traceContent: 'full'`
  这条 opt-in 缝（`turn.ts` 写 `output.text`，`export.ts` 已接），`harvest` 仍硬编码占位
  `'[harvest] assistant 文本未入 trace'` ⇒ 用户付了体积与脱敏的代价，产出的回归用例仍跑不起来。
  现在有文本就用真值；**纯 tool_use 回合不补占位**（占位 = 一条「模型说过这句话」的假事实），
  只有「既没文本又没工具」的终端回合才占位；骨架头注按这一次的实际情况二选一（开没开开关、
  几个回合没文本）。框架与 CLI 两份移植同步（七组夹具逐字对拍，新增含 `output.text` 一组）。
- **bundle 构建期按 classic script 编译一次（P2，静默白屏）**：`view` 把 bundle 内联进普通
  `<script>`，而 `bundle.test.js` 用 **ESM import** 验产物 —— 后者的语法集更宽 ⇒
  `export default` / `export *` / 残留副作用 `import './x.js'` 三种形态**构建绿、测试绿、页面白屏**，
  而 CLI 已经打印了「已生成」（2026-10-21 用真实 `dist/` + 真实 CLI 逐一实测）。
  现在 `buildBundle` 末尾用 `vm.Script` 编译整段 body（按 script 而非 function body 解析），
  报错还能定位回具体 `src/` 模块；`view` 侧 `stripExports` 同时补查残留 `import`。
- **产物落点 / 覆盖 / `--open`**：缺省产物避开点目录（输入在 `.agentia/` 时上跳到最近的可见目录，
  否则 Finder 里看不见、也容易被 `.gitignore` 吞掉）；产物路径等于输入文件本身直接报错；
  覆盖同名文件在 stdout 出声（**不引入** `--force` —— HTML 是派生物、重跑是常态，与 harvest
  「产物里有你改过的断言」不是同一种风险）；`--open` 在 Windows 改走 `cmd /c start "" <file>`
  （`start` 是 cmd 内建命令，直接 spawn 必 ENOENT）。
- **空 `spans` 的 trace 残留上一条树（P3）**：`playTrace` 原先直接 `return`，切换 trace 后页面
  还留着**上一条的树**（下拉里选中的是这一条）。现在空树也 `reset`，并用它自己的 traceId 作标题。
- **文档**：`usage-guide` 的「CLI 四件套」改五件套（含 `jsonlTraceSink` 的输入方列表）；
  harvest 的「trace 不记 assistant 文本」改成条件式表述；`view` 节补 `--limit` 方向与产物落点。

**棘轮**：CLI 实测 10060 → 10135（+75），基线之和 10574 → 10653（+79，5% 缓冲口径）；
`packages/trace-view` 的 `fromTrace.js` 173 → 181（空树 reset）。两处都写了「为什么」。
决策登记：`docs/spec.md` §10 2026-10-21 ref-view-limit-harvest-text。

### 文档：框架兼容性实测结论落库（新增 docs/frameworks.md + README / 边界表同步）（2026-10-17 ⑨ ref-frameworks-compat）

- **病灶**：README 与 `usage-guide.md` §7 都写着「未对 Deno / edge 做验证」—— 今天它已是**假话**：
  Node 22.13.1 / Bun 1.4.3 / Deno 2.9.6 三运行时跑过「导入 → 装配 → HTTP → 副作用」**四步**判定；
  NestJS 12.1.3（CJS + ESM）/ Egg 4.0.10 两个 Web 框架宿主**只验到第三步**（导入 / 装配 / HTTP），
  **副作用未验** —— 那两个宿主用 `scriptedClient`，且 cluster 那次真请求拿到的是 Anthropic 403、
  run 未成功。而结论只活在会话里，仓库零记录。
- **落库**：新增 [`docs/frameworks.md`](docs/frameworks.md) —— 判定标准（四步，缺一步不算「可用」）、
  实测环境、运行时轴 / Web 框架轴两张结论表、各宿主最小接入代码、**Egg 的三个坑**
  （CSRF 拦 POST 回 403；bodyParser 提前消费请求流 ⇒ POST 挂死而 GET 仍 200；cluster 下每 worker
  各持一份内存 store ⇒ 同一 taskId 轮询 `404 200` 完美交替 ⇒ 必须换共享 store）。
- **同步**：README 中英两版的「运行时」bullet、稳定性边界表「运行环境」行、集成节补宿主表；
  `usage-guide.md` §7「运行时是 Node」行改为「Node 承诺，Bun / Deno 实测」
  （`boundary-table.test.ts` 登记表 key 同步改，双向比对绿）。
- **宣传面**：`docs/promotion.md` 劝退节「Deno / Bun / edge 未验证」改如实表述；中文主稿补
  **「增量、不侵入」主打条**（五条同向的设计决定 + git 证据：示例 49 行业务文件全 git 史
  只有一个 commit）与**「支持的宿主」列表**（刻意不写版本号 —— 防腐烂，指回
  `docs/frameworks.md`）；短版 / X 线程 / Product Hunt 中英 / awesome / 30 秒视频旁白 /
  评论区竞品应答同步。另有两篇对外宣传文章（不在本仓库）结尾同步精确化：punchline 之外补
  「结构性原因」与「边界」——「一个文件」是 `node:http` 基线的下限，不是普适上限。
- **如实标注**：Bun / Deno 是**实测**不是**承诺** —— 不在 `engines` 内、不在 CI 上；
  Express / Fastify / Koa 作为独立宿主未逐一实测；Node 18 / 20 未跑（「`require(ESM)` 在 22.12
  前不可用」是按发布时间线的推断，按 `await import()` 写可避开）；edge 仍未验证。
- **更正（同日，⑨ 合并后 review 发现）**：⑨ 初稿写的是「四宿主都跑过四步判定」—— **过度承诺**，
  NestJS / Egg 只到第三步。已修：`docs/frameworks.md` 的 Web 框架轴表加「副作用」列（那两行标
  **未验**），判定标准那节补射程说明（四步全过是对**运行时**的要求）；`docs/spec.md` §10 ⑨ 同款
  措辞就地更正（**追加**不改写 —— 决策日志只增不改）。同批还修了两处：官网 6 处「Deno / Bun /
  edge 未验证」与两个 README 的新表述**公开矛盾**（中英各 3 处，已同步）；
  `docs/frameworks.md` 里「一等公民」与 trace 那句「一等公民」同词不同指（已消歧义），
  cluster store 表补上 `deployment.md` 的「单宿主写者」前提。另给 `stability.test.ts` 补了一条
  镜像锚点 —— 它此前只钉 5 条承诺锚点，**钉不住「排除面」**，所以三面各说各话也能全绿
  （变异验证：摘掉官网那句的 Bun ⇒ 守卫红；还原 ⇒ 绿）。
- **验证**：`docs/frameworks.md` 的三个 ts 块按 `code-fences` 守卫同手法（`paths` → `src/index.ts`，
  不依赖 build）真编译通过 —— 其中 CJS 片段第一稿写了顶层 `await`，探针当场报
  `TS1309`（CommonJS 里不合法），已改成包一层；这正是实测时踩过的同一个坑，
  也是把 `docs/frameworks.md` 纳入 `code-fences` 取样面的理由（该页承诺「照抄可跑」）。
  `boundary-table` / `stability` / `code-fences` / `scoreboard` 等文档守卫全绿，
  `bash scripts/verify-all.sh` 八步通过。

### 文档：README 精简（中文 451 → 314 行，英文同步）（2026-10-17 ⑧ ref-readme-slim）

- **病灶**：中文 README 是英文版的**两倍**（451 vs 229 行），差额几乎全在三节：
  四类能力 62 vs 10、运行时特性 68 vs 10、集成 59 vs 13。这三节把
  `docs/usage-guide.md`（1923 行）的完整示例抄了一遍 —— README 在替参考手册干活。
- **删掉的是「探索过程」而非信息**：
  ① `.env` 为什么放在装配模块而非入口的 3 行论证（压成一句括号）；
  ② `examples/` 用 `file:../..` 的理由（`examples/README.md` 已有）；
  ③ Node 版本矩阵的细节（压成一句）；
  ④ 四类能力的三个完整类定义 + 装配示例（已指向 `usage-guide` §3）；
  ⑤ 长上下文 / 结构化结果 / 中间件三块完整示例（压成三条 bullet + 指向 §6.3 / §5.3 / §6.6）；
  ⑥ 迁移纪律「逐步收紧」的历史（`0.7.1` 怎么样、`0.8.1`~`0.8.3` 怎么样）—— 只留「这条命令是下限」；
  ⑦ 「本仓的老病」「为此吃过教训」这类自嘲；
  ⑧ 性能节后半段「定下处置的计划文档路径」。
- **一条没动的**：所有**承诺**与**边界**（稳定性承诺表、1.0 门槛、未验证 Deno/edge、
  零依赖由守卫守着）—— 压缩的是叙述，不是承诺。
- **被迫保留的**：README 的骨架被 5 个守卫钉着（记分牌四个数字、`## 性能量级` 的五个复跑命令、
  `## 稳定性与版本策略`、代码块**真编译**且块数 ≥ 20 的防假绿下限）。删掉四类能力的代码块后
  触发了「只抽到 19 个块」，故把多模型示例恢复成代码块（它有信息量，不是凑数）。
- **边界**：压缩的是叙述，不是承诺；删的是重复示例，不是 API 信息（详细示例的住址写清楚了）。
- **英文版同步**：229 → 240 行 —— 补了「API at a glance」表（中文有、英文此前缺），删了同类
  探索过程（`.env` 论证、`0.7.1` 的迁移史、性能节的计划文档路径）。顺带修正一处**事实错误**：
  `.env` 由 `src/app.ts` 读取，英文原文写的是 `src/main.ts`。
- **一处回滚**：中文版第一稿把「路线 C：已有服务」整节删掉了（只在页尾留了链接）——
  那是 #266 给 `examples/agent-endpoint/` 的正文入口，不该在精简中丢失，已恢复。

### 元数据：包描述英文化 + keywords 补全（2026-10-17 ⑦ ref-discovery-metadata）

- **病灶**：两个发布包的 `description` 是纯中文 —— npm 搜索按英文 token 匹配，该字段对英文
  查询的贡献为 **0**。实测五个查询（`agent framework` / `typescript agent` / `ai agent typescript` /
  `llm agent node` / `mcp framework`），`@migor/agentia` **全部在前 15 名之外**；唯一命中的是
  搜 `agentia` 排第 **9**，而前 5 里 4 个是另一家公司的 `@copado/agentia-*`。
  `keywords` 只有 7 个，缺 `typescript` / `nodejs` / `ai-agent` / `agent-framework` /
  `model-context-protocol` 这批高频检索词。
- **改了什么**：`@migor/agentia` 的 description 改英文（中文原文**移进 `README.md` 首屏**，
  一个字没丢），keywords 7 → 20；`@migor/cli` 同样处理（description 英文化，keywords 4 → 12）。
  `README.md` 首屏在中文段前加一句英文定位句 —— npm 包页首屏就是它。
- **刻意不做**：keywords 里**不放 `nestjs`**。本包没有 NestJS 集成，放进去是蹭词，
  会让人以为存在官方适配。「NestJS 场景」靠文档与落地页命中，不靠元数据误导。
- **生效时机**：npm 元数据**要等下一次发版**才进搜索索引（本地改 `package.json` 不改变线上排名）；
  GitHub 的 `about` 是即时生效的字段，但当前令牌无 Administration 权限，本轮未改。
- **边界**：这是消除明显错误，不是增长手段 —— keywords 影响「能命中哪些长尾查询」，
  不改变「在泛词里排第几」（那由下载量与 star 决定）。「改完排名上升」**未验证**。

### 文档：补「本地怎么调」—— 四条路径 + 可直接复制的 curl（2026-10-16）

- **为什么**：`docs/usage-guide.md` 的 HTTP 端点契约表是完整的，但**一个可直接复制的命令都没有**
  （全文 0 处 `curl`）；更要紧的是没写那句「**这里没有『一个业务一个 URL』的接口层**」——
  照别的框架的经验来找，会一直找错东西：加一个 `@Tool` **不会**多出一条路，
  **调哪个能力由模型决定、不在 URL 里**。
- **加了什么**：① 不起服务跑一次（`start:batch`）；② curl 四句（`/healthz` / `/run` / `/run` + SSE /
  `/tasks`）；③ `agentia dev` 面板；④ **想单挑某一个工具**走 `createMcpServer`（每个 `@Tool`
  变成一个标准 MCP tool —— 这才是「一个能力一个接口」的形态，只是它长在 MCP 层，不是 HTTP 路由层）。
- **两个写进去的判据**（都是「只看 curl 退出码就会误判」的那类）：`POST /run`
  **失败也回 200**（硬失败在响应体的 `status:"failed"` + `error` 字段里，脚本要判 `status`
  不是判 `$?`）；SSE 那条必须加 `curl -N`，否则是 curl 自己在缓冲、看着像服务没吐东西。
- **落在**：`docs/usage-guide.md`（= 项目内 `AGENTS.md` 的单源）§6.2 新增一小节 +
  模板 `README.md` 新增「本地怎么调」。文档字数闸对 `usage-guide` **刻意不设上限**
  （参考手册按需查，见 `doc-budget.test.ts`），故无需调数。

### 新增：`agentia view <trace.jsonl>` —— 落盘 trace 的可视化出口（2026-10-16 ⑤ ref-view-single-file-html）

- **缺什么**：`agentia dev` 的面板是**在飞**的（run 列表是内存 ring，重启即空）；落盘 / 生产的
  trace 此前只有文本侧（`report` 排行 / `diff` 差异 / `harvest` / `export`）—— **没有任何一处
  能把它画出来**。「数据没丢但看不见」，且**不能转发**。
- **形态**：单文件自包含 HTML（CSS 与渲染器 bundle **全部内联**、零外链、离线可开、可转发）。
  业界 2026 已收敛到这一形态（agentskit / telltrace / claude-tap / AgentCanvas 四家不约而同，
  且都默认 redact）⇒ 这不是「多一个选项」，是「别再自己发明」。方案对比见
  `docs/plans/2026-10-16-trace-view-local-file.md`（取它而非「起服务」的关键理由：一次性看文件
  不该再付一遍 inspector 的 D0 鉴权税）。
- **flag**：`-o <out.html>` / `--open` / `--raw` / `--limit N`（默认 50，超了明说）/
  `--trace-id <id>` / `--redact-key <字段名>`。
- **默认脱敏**（`--raw` 关闭，且 stderr 出声 + 产物打水印）：`src/core/trace.ts:79` 划的是
  「脱敏在 sink 缝外 = **宿主职责**」，**CLI 正是宿主** ⇒ 这条是执行既定缝，`src/` 零改动。
  实现是 `examples/observability` 那份 `redactSink` 的去类型移植（正文逐行同形，源码级对拍守着）。
  ⚠️ **best-effort**：6 类预设覆盖值内凭证形态（bearer / jwt / aws-access-key / llm-api-key /
  email / phone-cn），**`password=` 这类不在内**（实测确认）；`--redact-key` 是**按字段名**整字段
  抹平，与前一种是两种机制 ⇒ 产物 banner 把两档各自能干什么都写出来，不暗示「加了 key 就都解决了」。
- **安全**：trace 内联进 `<script>` 前把 `<` 转义成 `\u003c` —— trace 含**模型输出 = 不可信输入**，
  一个 `</script>` 就能提前闭合脚本块、注入任意脚本，而产物的默认命运正是被转发。
- **配置**：`@migor/trace-view` 多一个产物 `dist/trace-view.bundle.js`，由
  `scripts/bundle.mjs` 从 `src/` **自动派生**（依赖拓扑 + 导出名都现场解析；撞名 / 环 / 引用
  不存在的模块 ⇒ 构建期响亮报错）。它是**运行形态**不是第二份实现：面板与官网仍用分文件，
  同源由 `test/bundle.test.js` 钉住。
- **验证**：`packages/cli/test/view.test.mjs` 15 条 + `packages/trace-view/test/bundle.test.js`
  7 条；**变异 9 条**各自咬住预期那条（摘 `<` 转义 / 摘 export 剥离 / 摘默认脱敏 / 改截断措辞 /
  摘去重 / 摘撞名检测 / 摘环检测 / 只拼一个模块 / 少导出一个符号）。
  ⚠️ 其中一条变异起初**不红**：同源那条断言读的是 `dist/`（构建产物），改 `bundle.mjs` 不会重建
  dist ⇒ 拿着旧产物一路变绿。已改为 import `buildBundle()` 的当次产出。

### 修复：会话（对话历史）读写失败零信号（2026-10-16 ① ref-session-failure-loud）

- **病灶**：`loadSession` / `appendSession` 两个「辅助动作失败不得击穿 run」的 `catch` 是**裸吞**
  —— 不抛、不 warn、不进 trace。而这一处失败的**形状最坏**：读失败 ⇒ 本次 run 表现成「这是第一轮」；
  写失败 ⇒ 这一轮白聊；下一次 `append` 把坏的那份覆盖掉 ⇒ **整段对话历史无声消失**，
  使用者只会觉得「它忘了」。`TraceSink` 也拿不到它，唯一可见性出口是 dev runner **启动期**的探测。
- **修法**：吞之前落一条 `console.warn`（与 `flushSinks` / memory 回写 / metrics 导出同款纪律）。
  **不抛、不改 run 结果** —— 变的只是有没有声音。
- **边界**：只到 `console.warn`，**不进 trace**（要挂得先定「会话维 span」，本轮不做）。
- **验证**：`tests/runtime/session.test.ts` +2 条（读 + 写各告警一次 / 正常路径零告警）；
  两条 `catch` **各自**做过反向验证（摘掉告警 ⇒ 恰好那条红）。

### 新增：能力类自带依赖声明（`static deps`）+ 显式侧 DI 重名出声（2026-10-16 ② ref-di-dup-loud）

- **病灶**：`discover` 对「default export 是类」只产 `{ useClass }`（没有 deps）⇒ 需要注入的能力
  只能**挪出 discover**、在装配文件里**再注册一遍** ⇒ 同一 token 出现两份（一份无 deps、一份有），
  靠「后注册覆盖先注册」碰巧成立 —— 顺序一变就静默失效，且框架零信号。真实形态：脚手架里
  `WORKDIR` 被 `discover` 与 `registry.ts` 各声明一遍、值还不同。
- **修法①**：能力类写 `static readonly deps = ['WORKDIR']` ⇒ `discover` 带上 deps（形状不是
  字符串数组则**响亮报错**，不当成「没有依赖」去无参构造）。
- **修法②**：`AgentApp` 装配期对**显式 providers** 的同 token 重复注册给一条 `console.warn`
  （覆盖语义不变）；模块级 → 应用级那条**刻意不告警**（那是设计好的覆盖，不该吵）。
- **验证**：`tests/toolkit/discover.test.ts` +3（含「真的注入」端到端 + 坏形状报错 + 普通类行为不变）、
  `tests/toolkit/module.test.ts` +3（重名告警 / 模块覆盖不告警 / 无重复零告警）；
  两处各做过反向验证。

### 脚手架：默认接 trace 出口 + `AGENTS.md` 版本标记 + 模板编译级对拍（2026-10-16 ③ ref-scaffold-observability-gap）

三件都在**脚手架侧**（框架核心刻意不内建 trace 出口这件事没变，见 `docs/spec.md` §9.3）：

- **① 模板默认接一条 `jsonlTraceSink`**（落 `.agentia/traces.jsonl`，已 gitignore，删一行即关）：
  此前不接 ⇒ 同步 `/run` 的 trace 随响应回去了，而**异步 `/tasks` 的 trace 落进任务库里没有任何人导出**
  ——「这个任务为什么慢」要查时它正好不在。接上后 `agentia report` / `diff` / `harvest` / `export` 开箱可读。
  ⚠️ 落的是完整 trace（含 prompt 与工具出入参）⇒ 模板注释写明「上线前按你的合规要求处置」。
- **② `agentia doctor` 两条新检查**：未配 `sinks` ⇒ 警告；项目内 `AGENTS.md` 无版本标记
  （或标记与当前 CLI 不同版）⇒ 警告。`create` 写 `AGENTS.md` 时插一行
  `<!-- agentia-guide-version: x.y.z -->`；CLI 版本号抽成 `packages/cli/src/version.ts` **单源**
  （`cli` / `create` / `doctor` 三处共用）。→ 这份说明是 `docs/usage-guide.md` 的**快照**，
  而 CLI 没有任何命令更新它，它恰恰是「AI 辅助编码的权威入口」⇒ 升级后不能再静默过期。
- **③ 新增 `packages/cli/test/templates-typecheck.test.mjs`**：用模板真建一个工程 → 真跑
  `tsc --noEmit`。此前模板只有**文本级**守卫，没人证明「建出来的工程编译得过」。
- **顺带**：模板 `read-file` 改用 `static deps`、`app.ts` 删掉那条冗余注册、`registry.ts` 的
  `WORKDIR` 改为按文件位置解析（与 `app.ts` **逐字同值**）；`docs/usage-guide.md`
  （= 项目内 `AGENTS.md` 的单源）补形态说明。

### 修复：同一落盘文件被两条 sink 对口 ⇒ 一条 trace 落两行（2026-10-16 ④ ref-sink-exactly-once）

- **病灶（CI 真现场，不是推定）**：③ 给脚手架接上 `sinks` 之后，`e2e-dev` 立刻红 ——
  脚手架的 `createApp({ sinks })` 与 `agentia dev` 的 `registerDefaultTraceSink` **都**往
  `.agentia/traces.jsonl` 写（两边各自都合理），于是同一个 traceId 落**两行**。而
  `report` / `diff` / `harvest` 的前提是「一行 = 一次 run」⇒ 一次 run 被**数两次**
  （成本翻倍、错误率减半），**且全程不报错** —— 不落盘是「没数据」，重复落盘是
  「数据看着正常但错了」。
- **修法**：`jsonlTraceSink` 对同一路径**进程内幂等**（两次调用返回同一个 sink 对象），
  `AgentApp` 收 `sinks` 时对 sink **对象**去重（`new Set`）—— 两处都要：只幂等不 set ⇒
  数组里仍有两个条目、收尾还是调两次；只 set 不幂等 ⇒ 两个不同对象，set 去不掉。
  「两处都接」从此退化成「恰好一次」。
- **验证**：`tests/integrations/sink-exactly-once.test.ts`（真跑一次 run ⇒ 恰好一行 +
  不同文件各写各的）+ `tests/integrations/file-sink.test.ts` 的幂等条（含「不同路径仍是
  两个 sink」的反向钉）。**两条变异各自亲跑**：摘 `new Set` ⇒ 恰好端到端那条红；
  摘工厂幂等 ⇒ 两条红。
- **边界**：幂等是**进程内**按解析后的绝对路径；跨进程仍受「单进程写者」前提约束。
  两份**不同实现**的 sink 写同一文件不在射程内（去重只认对象同一性）。

### 仓库自身 · 测试判据：与墙钟赛跑的计时器族换成「等真实事件」（2026-10-17 ① ref-flaky-timer-tests）

- **为什么**：完整套件连跑 7 次 **5 次红**，且每次红的是**不同**用例 —— 全是计时器/超时族。
  共用假设是「毫秒级余量够用」（`timeout: 30` 配下界 `dt >= 20`、`sleep(40)` 配 5ms tick），
  而满载 runner 上一次事件循环饿住就能吃掉它。⚠️ **4 个 CPU burner 复现不出，必须饱和**
  （32 核起 32 个 burner）。
- **改了什么**：5 处判据 —— 能等的换成 `waitFor`（仓内既有工具），**否定断言**（「不得再发生」）
  改成按 tick 间隔的倍数给窗口；`mcpConnector` 那条的慢调用改用**测试掌控的闸门**
  （抬预算会同时削弱区分力，闸门不会）。**`src/` 一行未动**。
- **验证**：定向对照（`git show HEAD:` 取原版）—— 旧版在饱和负载下 **5 次红 4 次**，
  新版 **5 次全绿**；修后完整套件连跑 **6 次全绿**；`verify-all.sh` 八步全绿。
- **边界**：`withTimeout` 的硬超时判据（实测耗时）是**有意**语义，改的是用例预算量级
  （50ms → 1000ms）不是源码；不引入假时钟（跨进程握手 / 真实 SSE / 子进程 spawn 依赖真时序）。

### 仓库自身 · 验证链：`rapid` 分片补前置检查（2026-10-17 ② ref-rapid-requires-dist）

- **为什么**：`rapid` 声明「不需要构建产物」，但它选的 `types` / `tests-types` 两步被测文件
  从 `../../dist/index.js` 导入。干净克隆实测：缺产物 ⇒ **1/3**、**30 条 TS 错误**
  （全是 `TS2307` 级联，**没有一条是真缺陷**）；`build` 之后 ⇒ 3/3。
  而 `.githooks/pre-push` 用 `rapid` ⇒ 干净克隆上必红、红的还是假信号。
- **改了什么**：缺 `dist/index.js` 时**响亮失败**并给下一步（exit 2）；注释里的假承诺一并改掉。
  步骤数仍是 8（`ci.yml` 的 job 名不用动）。
- **验证**：缺产物 ⇒ 明确报错 + 提示；有产物 ⇒ `rapid` 3/3（与改前一致）。

### 仓库自身 · 结构：装配期纯件与大体量函数三处外移（2026-10-17 ③ ref-assembly-pure-extract）

- **为什么**：方法级体量闸（阈值 240）的两处余量只剩 **4 / 5 行**（`module.ts` 构造 236、
  `mcp-stdio.ts` 工厂 235）——「加一个分支就可能顶线」，那是下一次改动替这次付账。
- **改了什么**：纯搬移、零行为变化 —— 成环检测与菜单重名查重抽成装配期纯件；
  `mcp-stdio` 的 stdout 分帧抽成 `attachResponseReader`；`renderPrometheus` 的四个 run 级家族
  抽成 `appendRunFamilies`。抽后分别 236→**195**、235→**206**、224→**187**，
  全仓最大体 **218**（余量 22）。
- **验证**：`toolkit` / `mcpConnector` / `metrics` 套件全绿（180 + 48 + 59）；八步全绿。
- **边界**：**未**继续拆 `agentLoop`（218 行 —— 主循环一气呵成，余量不抵可读性损失）。
  ⚠️ 本笔**没有**腾出 CLI 棘轮余量（`TOTAL_BUDGET` 余量仍为 0）：实证表明**搬移不降总量**
  （零死导出、重复已被 `duplicated-blocks` 守卫覆盖），真降需要删减/精简，另案。

### 仓库自身 · 治理：CLI 规模棘轮改为「每文件 5% 缓冲」（2026-10-17 ⑤ ref-ratchet-headroom）

- **为什么**：此前的基线 = 当前实测、**余量 0** ⇒ 任何增行当场红，每次改代码都要顺手改基线。
  而「真腾余量」经本轮实证**走不通**：190 个导出里零死代码、201 个顶层函数里只有 1 组逐字
  重复（抽出来净减 5 行）、249 行 CSS 零死样式 ⇒ **可榨取空间本身约为零**，不是「没做」。
- **改了什么**：`LINE_BUDGET` 全部改为 `ceil(实测 × 1.05)`，`TOTAL_BUDGET` 9560 → **10049**
  （取单文件新基线之和 —— 否则会「单文件都没超、总量先红」）。总缓冲 **489 行（5.1%）**。
- **语义**：**不是**「认可披露器」—— 闸门仍挡增长（单文件涨过 5% 就红）；缓冲是**预留给下个
  功能的额度**，吃完只有两条路：降回去，或显式提基线并写理由。缓冲不许再整体上调。
- **验证**：W1 断言逻辑未改；反向验证 —— 给 `version.ts`（36 行 / 新基线 38）加 3 行 ⇒
  当场红（`version.ts 超了：40 行 > 基线 38`），还原后复绿 ⇒ **缓冲是真的，闸门仍咬**。
- **边界**：这是一次**提高**基线（违反「只许往下调」的旧纪律），故在注释里写明是**一次性政策
  调整**并附实证，不让它看起来像悄悄抬价；单体文件的绝对膨胀仍无闸（缓冲就是这个意思）。

### 示例：存量服务增量加 agent 端点（2026-10-17 ⑥ ref-agent-endpoint-example）

- **为什么**：现有 9 个示例全是「从零建」，而目标用户（已经在写 Node 后端、要把 agent 塞进
  现有服务的团队）的真实场景是**增量改造**。这一格此前空着。
- **加了什么**：`examples/agent-endpoint/` —— 一个已在跑的订单服务（`GET /api/orders/:id`），
  加上 `/run` + `/tasks`；**`src/orders.ts` 一行未改**。改造清单 6 步、全部改动集中在一个文件：
  装包 → 把已有函数包成 `@Tool`（约 20 行）→ **复用**同一份鉴权 → 加**一条分支** →
  `drain()` 接进已有 SIGTERM → 四个预算旋钮。
- **顺带明确**：**不做 RAG 适配器**。`@Tool` 已能包任何检索，内置会撞「零运行时依赖」与
  「只给缝不给策略」两条硬约定 —— 示例里用内存订单表，就是要说清「RAG 是你的工具」。
- **验证**：`typecheck:tests` 通过（已加入 `tsconfig.tests.json`）；
  `examples-table` 守卫绿（表格集合 ↔ 目录集合一致）。
- **边界**：**不进** `e2e-examples`（要真 API key 才有意义），保证是编译级；
  `InMemoryTaskStore`（重启即丢），README 写明换持久 store 的路径。

## [0.10.3] - 2026-10-14

> 本版主题（窗口 `0.10.2 → 0.10.3`）：**把「可观测」从「能导出」推进到「跨进程接得上、agent 自己查得到」**，
> 外加五轮深评的静默项收口与一轮门禁加固。三块 —— ① **链路**：MCP 桥按 SEP-414 出入站携带
> `traceparent`（跨进程 trace 第一次接得上；载体是 `params._meta` 的**裸键**，缺失/畸形静默降级）、
> OTLP 导出对齐 semconv（三个缓存/压缩键 + 可选的 `execute_tool` 投影，**默认关**）；
> ② **可读面**：CLI `agentia report` 加会话 / 任务维度、交接与护栏四个 `agentia.*` 属性
> （**additive**，不造新 span kind）、两个 MCP 只读工具 —— 让 agent 自己查「上一轮慢在哪」；
> ③ **缺陷与门禁**：深评静默项收口（retry 坏值不再谎报「用户取消」、嵌套能力重复计数、护栏行在真实
> HITL 流程零产出、`sessionId` 静默失效改为出声）+ 门禁加固（文档预算闸 / 副本闸 / verify-all 分片 /
> pre-push 钩子）+ 决策引用从「日期 + 圈号」迁到「日期 + slug」（302 处，守卫只认 slug）。
>
> **无破坏性变更 ⇒ 既有使用者不需要任何动作、无需迁移**：公共导出面**零增删改**（`src/index.ts`
> 本版只动版本常量那一行）；`McpClientLike.callTool` 第三参与 `TaskStore` 的新方法都是
> **可选 / 有默认实现**的加法。
> ⚠️ **但有三条读数会变（变小），升级后看到数字变小不是坏了**：① 嵌套 capability 的 tokens / cost
> 此前在**外层与内层各计一次**（列不可加总），现在**只认顶层**、内层显示 `-` —— 影响
> `buildRunReport`、`@migor/trace-view` 能力排行、CLI `agentia report`、`agentia dev` 面板与官网
> playground（五处共用同一份实现）；② `agentia report` 按 `traceId` 去重，append-only 导出里
> 同一棵 trace 的多行不再翻倍；③ `retry` 的配置坏值不再被归类成「用户取消」。

### 修复：retry 配置坏值被误报成「用户取消」+ 入口段抛错时 run 根 span 不合拢（2026-10-13 ①②）

- **病灶①（深评 A1）**：`retry: { baseDelayMs: NaN }` + 一次 429 ⇒ 退避算出 NaN ⇒
  `sleep` 抛 RangeError ⇒ `turn.ts` 的裸 `catch` 吞成 `stopReason: 'aborted'`（配置错被
  谎报成用户取消）；`maxAttempts: NaN` 则让重试被**静默关闭**（`!(NaN >= 1)` 成立）。
- **修法①**：`RetryOptions` 四个数值旋钮登记进 `core/limits.ts` 真源表并加构造期校验
  （`resolveRetry` 抛 `TypeError`，报错文案插 `zeroClauseOf`；`runAgent` 入口同款校验，
  与 labels / fallbacks 同落点 —— 配置错响亮抛，不收成失败的 run）；退避处 catch 只认
  AbortError，其他错误原样抛出归类；`backoffDelay` 上界夹在 `MAX_TIMER_DELAY_MS`
  （正向抖动曾能把它推过 Node 定时器上限）。0 的读法：`maxAttempts: 0` = 关闭重试、
  `baseDelayMs: 0` = 不退避、`maxDelayMs: 0` = 封顶为零、`jitter: 0` = 不加抖动。
- **病灶②（深评 A2）**：`runAgent` 入口段（菜单摘要 / 模型链 / 标签校验）抛错时 run 根
  span 已开却永不 end —— 交付 sink 的 trace 里 `status='error'` 而根 span 是 ok、无
  endedAt、无结构化 error，违反「非正常收尾必带结构化 error」。
- **修法②**：入口段包 try/catch，catch 给根 span 收尾（error 状态 + 结构化 error）
  后原样 rethrow —— 对外行为不变（照样抛），trace 不再说谎。
- **验证**：`tests/engine/retry.test.ts` +6 条（含深评实测路径的入口校验用例与 catch 判别
  用例）、`tests/engine/loop.test.ts` +1 条（两个真实触发点的 trace 形状）、
  `tests/limits.test.ts` +4 探针 + 4 文案对账 case。
### 装配期静默缺口收口：静态方法装饰期拒 + 子菜单重名查重（2026-10-13 ③④）

- **③ @Tool/@SubAgent/@Skill 装饰静态方法 → 装饰期即抛**（此前能力静默从菜单消失：
  装饰器正常登记、装配零报错，但收集只扫实例原型链，静态方法挂在构造函数上永远扫不到）。
  与私有方法守卫同款落点（`assertMethodTarget` 加 `context.static` 判定）；`@Prompt` 是唯一
  例外（纯文本资产，静态收集是它的文档化形态，经 `allowStatic` 显式放行）。**非破坏性**：
  静态装饰这三类此前本就是死资产，现在只是从「静默失踪」变成「类定义期响亮报错」。
- **④ 子菜单重名查重**：主菜单的「菜单能力重名」查重此前管不到 @SubAgent/@Skill 的
  `tools` 引用展开结果（运行期展开）—— 两个 provider 各有同名能力被同一能力整片引用时
  装配全绿、第一次模型调用才由 API 400 暴露。现在装配期逐引用片展开查重，报错指到
  「哪个能力的哪几片引用」（`子菜单能力重名：@SubAgent "x" 的 tools 引用展开后 "search"
  （来自 "a" + "b"）`），修法引导（能力级路径收窄 / 改名）写进文案。
- **依据**：`docs/spec.md` §10 2026-10-13 ref-reject-static-methods ref-submenu-name-check；usage-guide §3（装饰器只接实例方法）、
  §4 `tools` 行与 §8 常见错误行（重名查重口径补「主菜单+子菜单」）同步。

### 四处低等静默/口径收口：报告去重下沉、握手簿记回收、metrics 失败出声、Span.name 注释（2026-10-13 ⑤⑥）

- **`mergeRunReports` 按 `traceId` 去重下沉到框架公共面**：2026-10-12 ⑧ 的去重落在 CLI 层，
  框架公共 API 喂同样的 append-only 导出照样翻倍计数。现在框架函数自身去重（同口径：
  只留最后一份、保序；`merged(n runs)` 是合成 id 不参与去重）。CLI 侧不动 —— 它作用在
  原始 trace 行上，与框架函数不是同一份代码。
- **stdio 连接器握手 / tools/list 超时后 pending 簿记回收**：guard 只是「放弃等待」，
  超时的 initialize 条目此前永远留在 pending（server 活着但不回包时每超时一次泄漏一条）。
  握手与 list 各持一个 AbortController，失败分支 abort 复用 `send` 里既有的 abandoned 清理。
- **metrics OTLP 导出失败缺省落 `console.warn`**（此前无 `onExportError` 时被 `?.` 吞掉、
  零信号），与 traces 侧 `flushSinks` 同款（每次失败一条）。
- **`core/trace.ts` 的 `Span.name` 注释对齐实现**：capability span 的 name 是**裸能力名**
  （无 `subagent:` 前缀；区分类型看 attributes，见 `capabilityKindOf`）—— 旧注释的
  `${capabilityType}:${capabilityName}` 口径曾让 otlp.ts 按前缀判、生产上一条 gen_ai.* 都没发出去。
- **依据**：`docs/spec.md` §10 2026-10-13 ref-merge-reports-dedupe ref-stdio-metrics-silent；usage-guide（metricsSink `onExportError` 行 /
  已知边界行 / §6 `mergeRunReports` 速查行）同步。
### 守卫射程轮：CLI 纳入 exactOptionalPropertyTypes、e2e:mcp:server 进 CI、三处货架补齐（2026-10-13 ⑦）

- **D2（CLI 类型收紧）**：`packages/cli` 的 `tsconfig.json` 与 `tsconfig.templates.json`
  此前**没开** `exactOptionalPropertyTypes`（根包 2026-09-18 起就开着），「显式 undefined
  覆盖缺省」那类防线在 CLI 代码上无声缺位。现两份配置（连同发给用户的模板
  `templates/tsconfig.json`）全部开启，并修掉暴露的 6 处类型错：结果记录型
  （`SpanDiff` / `ToolIoEvent` / `ExportRecordMeta`）改必填 `T | undefined`（与框架侧
  移植真源逐字对齐）、内部管道 `HarvestRow.messages` 改 `?: T | undefined`、公共入参
  `harvestEvalCase` 签名不动、调用点条件展开。`tsconfig-strictness` 守卫射程扩到四份配置。
- **D1（e2e:mcp:server 进 CI）**：MCP 反向桥端到端此前全仓零自动化；现为 CI 独立
  **必需检查** job `e2e-mcp-server`（离线零网络、不需要 uv），并登记进 `verify-all.sh`
  的 `ci_only` 与 CONTRIBUTING / AGENTS.md 的对应抄写。verify-all 仍是 8 步（不加第 9 步）。
- **E2（inspector 白名单门禁）**：新增 W5 守卫 —— `dist/inspector` 里每个 `.js`/`.css`
  都必须在 STATIC 白名单里（双向集合相等），trace-view 拆出新文件而白名单没跟上时
  构建即红（此前表现为面板 404 白屏）。白名单本身保持显式人批。
- **低等三项**：CI 各 job 补 `timeout-minutes`；guards-registry 货架补 `tests/scripts`；
  `layering.test.ts` 的 import 解析改走 `lib/source-scan.ts` 遮蔽器（注释 / 模板里的
  `from './x.js'` 不再造假依赖边）。
- 依据与逐项核对结论见 `docs/spec.md` §10 2026-10-13 ref-guard-scope-round4。
### 修复：engine 非正常路径口径对齐（深度评审 2026-10-13 低等项五件）（spec §10 2026-10-13 ref-deep-review-minor）

- **`max_iterations` 出口保留已产出文本**：循环耗尽时 `finalText` 此前恒为 `''`，与
  `max_tokens` / `refusal` / `budget_exceeded` 的「文本不丢」口径不一致；现在耗尽出口
  带上最后一回合的模型文本。
- **「消息已收、工具未跑」窗口内取消不再执行工具**：`streamTurn` 成功返回后、
  `executeTurnTools` 之前补 `signal.aborted` 检查 —— abort 落在该窗口时整批工具的副作用
  一个都不发生（与续跑入口「已取消不执行任何工具」同口径），run 以 `aborted` 收尾。
- **trace 截断摘要多源漂移修复**：`snapshot()` 的收尾摘要（`trace.truncated` 的
  `{ droppedEvents, limit }` 那笔）此前每次调用都新建时间戳，多次 snapshot 互不一致、
  也都与增量流里那一条对不上；现在只生成一次、同一对象复用于两条缝
  （「按 seq 折回 == snapshot」的折叠契约在截断场景重新成立）。
- **stdio 反向桥监听器泄漏修复**：`process.stdout` 的 EPIPE 吞错监听随 `close()` 摘除
  （此前只挂不摘，多次 `createMcpServer` 累积进程级监听器）。
- **MCP 反向桥补 trace 闸**：`createMcpServer` 的选项新增 `traceLimits`（每次
  `tools/call` 那棵 trace 的事件数上限，构造期校验、坏值抛 TypeError）与
  `maxEventChars`（事件正文截断上限，`false` = 不截断）—— 缺省与引擎缺省逐字一致，
  子 agent 类工具在桥内长跑时 trace 体积不再无界。
### 修复：TaskStore 副本契约坐实 + cancel 与推进路径互斥（五路深评批次二，2026-10-13 ⑨–⑫）

- **B2 · store 副本契约（⑨）**：`InMemoryTaskStore` / `FileTaskStore` 的 `save` 入库与
  `get` / `byIdempotency` / `list` 出站统一走 `cloneTaskRecord`（深拷纯数据、AbortSignal /
  函数等进程内对象按引用保留）。此前契约注释要求副本、实现交活引用 —— 「改 rec →
  `await save`」的纪律下，save 失败时变异已污染内存（approve 重试撞 409、任务搁死）。
  **行为变化**：终态落库失败时库里诚实停在最后一次落库成功的状态（此前被引用语义
  原地推进遮掉）；`submit` / 幂等去重返回从浅拷贝升级为深拷贝（HITL 挂起会整体替换
  `spec.messages`，浅拷贝快照照样被穿透）。
- **B1 · cancel 互斥闸（⑩）**：新增 per-task `#cancelInflight`，与 approve / signalTask /
  到期唤醒 / 审批超时四条推进路径互为对侧（先登记者赢，无死锁）；cancel 临界段落库改
  **当场发生**（不再经微任务延迟）；`#executeInner` 起跑前加**取消意图闸**（意图在场
  ⇒ 绝不起跑，记账归 cancel），`#cancelSettled` 覆盖面随之补齐。修掉两扇真实竞态窗：
  cancel×approve 并发「取消后照常执行 + onFinished 双发」、cancel×槽位释放并发打破
  「被取消的排队任务绝不起跑」。
- **B3 + 低等 · 恢复路径落库失败（⑪）**：`resumePending` 认领 save 接同步抛错（不再逃出
  启动路径；不派发、不计入推进数、warn）；认领 / 审批超时 / 到期唤醒三处落库失败的
  catch 不再静默留尸，各补 `console.warn`。
- **低等 · Scheduler drain 感知（⑫）**：runner 停机后 tick 静默跳过（此前每 tick 刷一条
  `console.error`）。
- **依据与取舍**（含副本克隆的成本评估）：`docs/spec.md` §10 2026-10-13 ref-taskstore-copy-contract ref-cancel-mutex ref-resume-save-guard ref-scheduler-aware-drain。
- **验证**：新增 `tests/store/taskStore-copy.test.ts` / `tests/transport/cancel-race.test.ts` /
  `tests/transport/resume-scanner.test.ts` 三份套件 + scheduler drain 用例；既有依赖
  「改 poll 返回值即生效」的三处用例改为显式 `save`（副本契约的推论）。
### 修复：能力排行嵌套能力重复计数（E1）+ 文档 drift 收口（2026-10-13 ⑬）

- **病灶**：`@migor/trace-view` 的 `summarizeTrace` 对每个 capability span 累加 usage，
  而框架侧 capability.usage 是其**子孙 llm.turn 的聚合** ⇒ `@SubAgent` 套 `@Skill` 时
  同一批 token 在外层与内层行**各计一次**，tokens / costUsd 列不可加总（与
  `core/trace.ts`「capability 聚合不进 totalUsage」的纪律冲突）。CLI `agentia report`、
  `agentia dev` 面板、官网 playground 三处共用同一份实现，同漏。
- **修法**：能力排行的 usage **只认顶层 capability**（没有 capability 祖先的）；内层行仍计
  calls / errors / 耗时（那是它自己这次调用的真账），tokens / cost 显示 `-` ⇒ 各行可加总。
  引擎与 tracer 行为不动。依据见 `docs/spec.md` §10 2026-10-13 ref-ranking-top-capability。
- **同批修复**：`examples/deploy` 补上脚手架模板同款的 PORT 校验（`PORT=''` 空串曾被
  `Number('')` 静默变成 0 = 随机端口）；usage-guide 的「CLI 三件套」统一为四件套口径
  （补 `export`），能力排行补「嵌套只认顶层」口径说明。
- **同批守护**：doctor 的 `ENTRY_CANDIDATES`（CLI 侧双写）与框架 `discover.ts` 加源码级
  逐字对拍；AGENTS.md 十条 drift 对账修正（数字改为指向真源）；trace-view 结构棘轮
  summary.js 130 → 153。
- **验证**：嵌套夹具 + 变异验证（去掉顶层判定 ⇒ 新用例红）；`verify-all.sh` 8/8。

### 修复：`buildRunReport` 的嵌套能力重复计数（2026-10-13 ⑭）

- **病灶**：⑬ 修的是 trace-view 展示层；框架公共 API `buildRunReport`
  （`src/integrations/report.ts`）有同款嵌套累加 —— `@SubAgent` 套 `@Skill` 时同一批
  token 在外层与内层行各计一次，能力排行的 tokens/costUsd 不可加总。消费方
  `examples/observability-mcp` 的 `report_trace` 工具同漏。
- **修法**：与 ⑬ 完全同款 —— 沿 `parentSpanId` 上爬判 capability 祖先（带防环），
  嵌套行的 usage 不累加（`tokens`/`tokensTotal`/`costUsd` 为 `null`），calls/errors/耗时
  照计 ⇒ 各行可加总。依据见 `docs/spec.md` §10 2026-10-13 ref-build-report-dedupe。
- **验证**：`tests/integrations/report.test.ts` 新增嵌套夹具（去掉顶层判定即红）。

### 工程：引用完整性轮 —— 22 个圈号归位 + 体量闸头注表自审 + 圈号引用守卫（2026-10-14）

- **病灶①（引用层）**：全仓指回 `docs/spec.md` §10 的 `（日期 圈号）` 写法**没有任何守卫**。
  实测三类真实形态共 **22 行 / 23 处引用**：**(a) 重排后未同步（14 行 / 15 处）** —— 批次二自己的
  分支已把四件事编成 ⑨⑩⑪⑫，**同一分支**的 `tests/**` 与 `AGENTS.md` 仍写 ①②③④（偏差恒为
  +8，**落地当天就自相矛盾**，与合并无关）；另一轮同理，`spec.md` 内一处 ① 应作 ⑧。
  **(b) 幽灵锚点（7 处）** —— `src/` 的注释与 `export` 的移植副本引该日 ⑧ 之后的号，而该日
  只有 ①–⑧（`git log -S` 限 `docs/spec.md` 查过：从来没有过）；另一处在本文件里 ——
  有个已发布的版本节标题引了该日的 ⑲，而 ⑲ 在 §10 **从未存在过**（还做过正对照：`-S` 搜
  同一日的 ⑳ 能命中发版提交，搜 ⑲ 为空）。
  **(c) 给字母编号的日子硬加圈号（1 处）** —— `spec.md` 内一处引该日条目号时写成了圈号形式，
  而**2026-09-11 的 §10 条目用 R1–R6**（不是圈号）；**同一个提交**（#40）里另一处已经写着
  「见 §10 2026-09-11 R1 条」⇒ 两处自相矛盾，从写下那天起就不成立。
- **病灶②（读数层）**：`source-size.test.ts` 头注表写 `async.ts` **627** 代码行，实测 **680**；
  而 `AGENTS.md` 的导览图明确写着「当前真值以这张表为准、别在这里数」。根因**不是**「抄了旧纸」：
  改这张表的那个 PR 落地时，**它自己分支上的 `async.ts` 已经是 680**（另一批先合）——
  **答案就在磁盘上**。这是「假账」的典型形状：语义上没撒谎，数字没现算。
- **修法**：① 22 行圈号按**主题**认锚点归位（不按位置猜：幽灵号分别落到当日的反向桥条目、
  导出条目；字母编号那处改写成 `R1`；CHANGELOG 那处**删掉幽灵括号**）；② 头注表按实测重算
  （680 / 524 / 493），「留多少余量」不再在正文另记一份数；
  `AGENTS.md` 那行**去掉读数、只留指针**（它烂过两次：行数差一、代码行被同日抽件改掉）。
  ⚠️ 本轮**零语义改动**（全部落在注释 / 文档 / 测试），故不写 §10。
- **新守卫（两条，都做过反向验证）**：
  - **头注表自审**（`tests/architecture/source-size.test.ts`）：实测与表里的数逐行对拍、口径复用
    同一个 `codeLineCount`。变异：表里 680→679 ⇒ **恰好那条红**（体量闸本体仍绿 ⇒ 两条断言
    **独立**）；表行去掉反引号 ⇒ 真空护栏红（`只从表里解析到 2 行`）。
  - **圈号引用**（`tests/docs/circle-refs.test.ts`，新）：射程内「日期在 §10 **有条目** ⇒ 圈号必须
    存在」。「条目」看**行首形态**（`### 日期` / `**日期` / `- 日期：`）、**不看有没有编号** ——
    取「有条目」而非「有圈号锚点」是有意的：后者会把「日期有条目、但条目用字母编号」那一类
    （即上面 (c)）整片漏出射程。引用按「日期 + **紧跟的一整串**圈号」吃（`（日期 ②③）` 指两条
    决策，只认第一个会让后面那些**变裸的**；实测多校验 14 处、新增违规 0）。变异 5 轮：源码注释
    改回幽灵号 ⇒ 恰好报出该行（`该日共 8 个锚点`）；把锚点正则打瞎 ⇒ 真空护栏红（`只解析出
    6 个锚点`）；`spec.md` 那处改回圈号 ⇒ **恰好只报 `docs/spec.md:1236` 一行**；把「条目」判据的
    列表项分支打瞎 ⇒ 真空护栏红（`只解析出 1 个「有条目但无圈号锚点」的日期`）；把 `resume-scanner`
    那串的**第二个**号改成不存在的（`⑩⑱`）⇒ 恰好报出 `resume-scanner.test.ts:9` 那处的 `⑱`
    （只认第一个的版本对它是瞎的）。⚠️ 它只判「**号在不在**」、判不了「**号指得对不对**」
    —— 指向错主题但号存在的（如把 ⑩⑪ 写成 ②③，而 ②③ 也是该日的号）机器判不了 ⇒ **本仓
    最大的一类错引（14 行）从来不是本守卫的功劳**，是人逐条读出来的。CHANGELOG 只查带 `§10`
    标记的引用：其裸标签**两节两种惯例**（`[0.10.0]` 照抄 §10 的号、`[0.10.2]` 用本节自己的
    条目序号），全查会在后者误报。已登记 `docs/guards.md` §1.4。
- **顺带记录**：§10 同日编号有 9 处不连续 —— 3 处是「同日首条不编号」的风格、
  4 处是 09-18 的 ③–⑥ 跳号，另有 09-14 缺 ①、09-29 缺 ⑲（成因未定）。其中 **09-29 缺 ⑲ 只被
  CHANGELOG 引过一次**（PR #203 把「推广稿重写成定稿」那条按 §10 圈号写成了 ⑲，而 §10 从未
  为它立条目）⇒ 本轮**删掉那个幽灵括号**（该条日期由所属版本节标题 `[0.10.0] - 2026-09-29`
  给出，不丢信息）。**不做「同日编号必须连续」这条更硬的闸**：它要求回头给这些段补号，
  而补号本身会撞死引用（本轮修的正是这类撞伤）——收益抵不过风险，登记为已知边界。
- **验证**：`verify-all.sh` 8/8；两条新守卫共 7 轮变异逐条咬中后 `sha256` 逐字节还原。

### 工程：门禁加固轮 —— 文档预算闸 + 副本闸 + verify-all 分片 + pre-push 钩子（2026-10-14）

- **出发点**是一个方法论问题：多模型参与后守卫的**数量**在涨，但守卫的**有效性**没涨。归纳出三个
  病根：**① 守卫声称的「理由」没人守** —— 活证据是 `circle-refs.test.ts` 的「档 B」原写着「CHANGELOG
  的圈号是它自己的条目序号」，实测是错的（`[0.10.0]` 那一节的 15 条与 §10 逐条对得上）；**写错的
  理由，守卫照样绿**。**② 同一事实多处副本**（本轮三个实例：`source-size.test.ts` 头注表读数 /
  `CHANGELOG` 两节圈号惯例 / `spec.md` 里同一天两种编号写法），此前**零守卫**。**③ 编号是「位置号」，
  位置会变** —— 上一轮修的 14 行错引**全部**由「按天编号 + 合并重排」产生（偏差恒为 +8），**落地
  当天即自相矛盾**。下面 ①–⑤ 对治前两条，⑥ 是 ③ 的根因消除。
- **① 常驻文档预算闸**（`tests/docs/doc-budget.test.ts`，新）—— 对标业界做法里的 `verify-doc-budgets`。
  口径是**码点**而不是字节、也不是行：中文一字三字节 ⇒ 按字节设闸读数没有可比性；而按**行**设闸对
  `docs/guards.md` 完全无效（504 行里躺着 125KB，平均 250 字符/行、最长一行 3423）。两个维度：
  `AGENTS.md` / `CONTRIBUTING.md` **整份**设上限（它们是散文、必须从头读到尾 ⇒ 总长就是读取成本），
  `guards.md` 这类**注册表的单行**设上限（行数随守卫数增长是**设计**，只有单条长度才是病灶）。
  头注明写**三类刻意不设上限**：`spec.md`（决策日志，只增不改）/ `usage-guide.md`（完备性已由
  `boundary-table.test.ts` 守）/ `docs/plans`·`docs/reviews`（带日期的快照）—— 三者共有的性质是
  「它们的长度不是读取成本，而是完备性」。超了有两条路且**必须显式**：精简（首选）或提上限（改的
  就是本文件里那个数字 ⇒ review 时一定看得见）。
- **②+③ 副本闸**（`tests/architecture/duplicated-blocks.test.ts`，新）—— 滚窗找**生产源码**里的
  成段逐字重复。归一化丢空行与整行注释、**折缩进**（跨文件副本常因所在层级不同整块差一级，不折就
  对「抄了一个方法到另一个类里」完全瞎）。`WINDOW = 12` 是**量出来的**不是拍的：同一量具在
  N = 8 / 12 / 16 / 20 各跑一遍 —— N=8 得 7 对（多出 `skill.ts ↔ subagent.ts`、`mcp-http.ts ↔
  mcp-stdio.ts` 这类**结构性同形**）、**N=12 得 5 对**（全是**真会一起改**的那种：三份移植副本 +
  两份共享样板）、N=16 得 4、N=20 得 3（`store.ts ↔ fsStore.ts` 那份 12 行的同源实现会漏出去）。
  `KNOWN` 表 5 条各带 `why`（≥ 30 字）+ 可选的 `syncedBy × symbol` **联合核对** —— 点**符号名**
  而不是文件名（本仓移植副本的守卫文件点的是 `exportRun` / `diffTraces` 这类导出名；第一版按文件名
  判，两条都误红）。三条护栏防「闸变哑」（文件数下限 / 已知的 diff 移植副本必须在探测结果里 /
  重复对数下限），外加一条**幽灵豁免**（登记了但实际已不重复 ⇒ 红）与「未登记重复 ⇒ 红」互为对侧。
- **④ verify-all 分片**（`scripts/verify-all.sh`）—— 加 `shard="${1:-all}"` + 新增 `step_names`
  数组与 `steps` 一一对应（条数不等即 exit 2），**按名字选步、不按下标**（下标会在插入/重排时
  **静默错位**，而分片照样打印「全绿」）。`rapid` 片 16–20 秒（全链约 18 分钟，卡在 `npm test`）。
  ⚠️ **`steps=(` 数组形状逐字未动** —— 它既是 `verify-all-wiring.test.ts` 的解析锚点，也是 CI job 名
  （分支保护的必需状态检查）里那 8 步的来源。两条自证：未知分片 exit 2；**选到 0 步也 exit 2**
  （「它会跑完什么都不做然后报绿」，正是 pre-push 钩子最坏的失效形态）。分片**不打印「N/N 全绿」**
  那个形状（本仓多处文档抄写的就是它），改打「分片 rapid：3/8 步全绿（其余 5 步未跑）」。
- **⑤ pre-push 钩子**（`.githooks/pre-push`，新，约 20 秒）—— 调 `rapid` 片；`SKIP_VERIFY=1` 逃生门；
  `node_modules` 缺失时**响亮警告后放行**（不静默 skip）。已在本仓用 `git config core.hooksPath
  .githooks` 启用，`CONTRIBUTING.md` 写了怎么开（git **不会**自动启用仓库里的钩子，不写出来别人
  克隆下来永远不会跑它）。
- **⑥ 编号脱位设计稿**（`docs/plans/2026-10-14-ref-slug-migration.md`，新，**P1 未开工**）——
  `（日期 圈号）` → `（日期 + slug）`：圈号是**位置号**，重排即腐烂；slug 由标题派生、可校验。
  射程实测 **119 个锚点 / 508 处引用 / 500+ 行跨约 40 文件**，分 P1（加名）/ P2（换引用）/ P3（收口）
  三步走。⚠️ 设计稿里**刻意用占位符** —— 论证「位置号会腐烂」的文档，自己不该先写一个位置号。
- **三处登记同步**：`docs/guards.md` §1.1 加副本闸行、§1.4 加文档预算闸行、§2 待守加一行
  （`cli/harvest.ts ↔ cli/export.ts` 的样板重复**尚无同步机制** —— 免得「登记过」被读成「已经安全」）。
- **验证**：`verify-all.sh` 8/8；四个守卫 `doc-budget` 3/3 · `guards-registry` 3/3 ·
  `duplicated-blocks` 5/5 · `verify-all-wiring` 15/15，`biome` 全仓 514 文件 0 error；
  **15 项变异逐条咬中**（每个新断言各一：必读集超预算 / 注册表单行超限 / 注册表变空 / 删登记项 /
  加幽灵项 / `symbol` 写错一个字母 / `WINDOW` 放宽到 8 / 射程清空 / 两处清单条数不等 / 分片名写错 /
  文档删掉「怎么开钩子」那条 / 钩子去掉可执行位 / 未知分片 / 选到 0 步 / `steps` 与 `step_names`
  条数不等），恢复后 `sha256` 逐字节一致、钩子权限回到 755。
- ⚠️ **如实标注射程**：副本闸只判**逐字**重复，判不了**语义副本**（本仓三次实例那种「同一事实两种
  写法」一行都不重复 ⇒ 它挡不住）；分片**不是门禁**（`rapid` 全绿 ≠ 可以推 PR，它只覆盖静态三步）。

### 工程：决策锚点加 slug（P1 加名）—— 把「位置号」换成稳定地址（2026-10-14）

- **接上一条的 ⑥**：`（日期 + 圈号）` → `（日期 + slug）` 的迁移，**P1（加名）已落地**。设计稿里
  那 4 个开放问题在它的 §7.1 逐条定稿，锚点形态定在 §7.2。
- **改了什么**：§10 的 **120 行**带圈号锚点行，各在「日期 + 圈号」之后插一个 `ref-` 前缀的 slug
  （形态 `### <日期> <圈号> ref-<名>：<标题>`）；**引用一处未动**（P1 的铁律）。加上本条目自己在 §10
  的那一行也带 slug ⇒ 落地后共 **121 行**有 slug。§10 章节头加了一段
  读者指引，它自带全仓**第一条**真 slug 引用。`docs/spec.md` §10 另加本决策条目 —— 引用形态是对外
  约定的一部分（`AGENTS.md` 与 PR 模板里都出现过），按 `CONTRIBUTING.md` 的判据这是**语义变更** ⇒ 要写。
- **守卫**（`tests/docs/circle-refs.test.ts`）**同时放宽与收紧**。放宽：引用键接受「一串圈号」或
  「一个 slug」。收紧四条：**有圈号必有 slug**（挡「只加 slug、圈号被误删」的半迁移）、**slug 全局
  唯一**、**slug 锚点数下界**（119 —— 是**量级**护栏、**不是**逐条计数；单条丢失改由另两条路咬，
  见守卫注释）、**射程内 slug 引用 ≥ 1**（后者是「新形态真的通了」的活证据 —— 掉了就说明新支路成了
  死代码）。**退出条件（P3 删掉圈号那一支）写在代码里**，不靠谁记得。
- **实测**：带圈号的锚点**定义行 121 行**、圈号**唯一键 120** —— 差的那一个正是 `2026-09-14 ②` 的
  **同日重号**（slug 能区分它、圈号不能，这本身就是位置号失效的一个具体证据；该重号在射程内的引用
  数 = **0** ⇒ 不产生 P2 换引用的歧义）。§10 另有 **4 条无编号锚点**与 **45 条** `- 日期：…` 条目行
  **不在 P1 射程**（无圈号 ⇒ 无锚点可引 ⇒ 不给它起名）。
- **验证**：`circle-refs` 2/2（新增一条锚点侧用例）；**6 项变异逐条咬中** —— 改某条锚点的 slug 名 ⇒
  **恰好**引用它的那两行红；造重名 slug ⇒ 唯一性红；打瞎 `SLUG_ANCHOR` 正则 ⇒ 真空护栏红（**不是**
  「全绿」）；把 3 处 slug 引用全打瞎 ⇒ 「新形态通了」红；删某条锚点的 slug ⇒ 半迁移红；删某条锚点
  的圈号 ⇒ 那一行滑出锚点射程、自己成了一条查不到的 slug 引用 ⇒ `bad` 红。恢复后 `sha256` 逐字节一致。
- ⚠️ **自审逮到一处「守卫理由腐烂」**（正是本轮要防的病根 1）：下界一开始写成「取紧值 120 ⇒ 能挡住
  『有人删掉某条锚点的圈号』」——**这句话在本轮内就过期了**：我随后往 §10 加了一条决策（它自己也带
  圈号 + slug），实测变 121，下界于是有了 1 的余量，那句理由不再成立。⇒ 已改成**量级**下界（119）
  并明写「它**挡不住**单条丢失，那由 `bad` / `anchorNoSlug` 咬」。教训：**紧值型断言会把「理由」一起
  钉死**，加一条数据就失效，而失效时**没有任何东西会响**。
- ⚠️ **落地过程本身踩了三次同一个坑**（如实记）：守卫头注 → 设计稿 §3.2 的示例 → §10 条目的示例，
  都因为**把示例写成「具体日期 + 具体 slug」**而变成一条指向不存在锚点的**真引用**，被守卫当场咬红。
  ⇒ 规矩：这类**形态示例一律用占位符**（`<日期>` / `ref-<名>`），本守卫**自己也在射程内**。
- ⚠️ **射程边界**：slug 只解决「地址会漂」，**不解决「地址指错了」** —— 键存在但指错主题的仍然只能
  人读（守卫挡的是「查不到」，不挡「查错了」）。**P2（换引用）与 P3（守卫只认 slug）均未开工**；
  P2 的射程**现算**（`circle-refs` 守卫口径、逐圈号、**只算 git 跟踪文件**）：
  **483 处引用 / 473 行 / 100 个文件**（P1 落地前是 474 / 464 / 99）。⚠️ 设计稿 §4 原记的
  「508 处 / 约 40 个文件」**用任何探针都复现不出来**（守卫口径在写稿那棵树上是 474 / 464 / 99，
  其标注出处的探针是 412）⇒ 已在设计稿标为「不可复现」并以守卫口径为准。
  ⚠️ **同一份读数必须连口径一起写**：射程里混着 `packages/cli/CHANGELOG.md`（48 处）等
  **gitignored 生成物**，它们只在**本机**存在（CI / 新克隆 / `git worktree` 里都没有）⇒ 拿「本机读数」
  与「对照树读数」相减会凭空多出 48 处，**看起来正好像引用被改了**（本轮据此差点把对的判成错的）。

### 修复：护栏行在真实 HITL 主流程完全不产出（trace-view summary 的扫面不限 span kind）（2026-10-12 ⑨）

- **病灶**：真实审批流是「挂起 → 人批 → 带 approvals 恢复」；恢复段的工具执行走续跑入口
  （`loop.ts` 把 **run 根 id 当 turnId**），`approval.decided` 记在 **run 根** span 上。
  而 summary 聚它时只扫 `kind === 'llm.turn'` ⇒ 所有真实审批用法下 `guardrail:*` 行
  **一行都没有**，只有「首段同步带 approvals」（基本只有测试这么干）才出行。
  CLI `agentia report` 与 `agentia dev` 面板与 summary 同源，同样漏。
- **修法**：`approval.decided` 的聚合**不限 span kind**（`tool.output` 仍限 `llm.turn`）。
  落点因段而异是记账事实不是缺陷（与 `tool.input` / `tool.output` 同一纪律），事件体自带
  `tool`；**一次决定只记一笔**（记账点只有 `executeOneTool` 一处，跨段是另一条 trace），
  扫面放大不会双计。引擎行为不动。
- **顺带订正文档口径**：`usage-guide.md` 的 `agentia.guardrail.*` 属性表原写「发起它的
  `llm.turn` span」⇒ 与续跑再挂起场景矛盾，改为「与 `approval.requested` 同 span：首段
  `llm.turn`、续跑段 run 根」。依据与「为什么不该限 kind」见 `docs/spec.md` §10 ⑨。
- **验证**：`packages/trace-view/test/summary.test.js` 保留首段形状用例、补恢复段形状
  （decided 在 run 根 ⇒ 行在场且数值对）与「两处都聚」；**变异验证**（恢复 kind 限制
  ⇒ 两条新用例红；复原绿）。summary.js 棘轮 126 → 130（净 +4 全是注释，代码行零增长）。
### observability-mcp 示例复审收口：分组键对齐 CLI、root=`/` 特判、sessions 截断（2026-10-12 ⑩）

- **是什么**：`examples/observability-mcp/` 的三处低危修复（框架与 CLI **零改动**）：
  ① 会话归组从两级补成**三级回退**（run 根 `session.id` → 外层记录的 `TaskRecord.taskId` →
  `(无会话)`），与 CLI `agentia report` 逐字同口径 —— 此前 `readTraceFile` 丢掉外层 wrapper，
  FileTaskStore / SqliteTaskStore 导出的记录在示例侧全坍进 `(无会话)`；
  ② 只读边界的 root=`/` 特判（`root + sep` 变成 `//` 曾把根下**所有**文件误拒）；
  ③ `report_trace` 的 `sessions` 加截断天花板（`MAX_SESSION_ROWS = 40`，与 diff 侧同档），
  新增 `sessionGroups` / `sessionsTruncated` 两个字段如实报出截断（**加法**，兼容）。
- **守护形态**：这份移植（本仓第四份）配的是**源码级双钉**
  （`tests/observability-mcp-parity.test.ts`：三段 canonical 行在两份源码里逐字都在场），
  而不是前三份的运行时逐字对拍 —— 示例必须可整目录拷走单用、且示例 dist 在 `npm test`
  时未构建，两个对拍落点都不成立（理由见 `docs/spec.md` §10 2026-10-12 ref-g8-example-closeout）。
- **验证**：示例 `npm run verify` 17 → 26 条 check（新增 §8 三级回退 / §9 root=`/` /
  §10 截断）；**3 条变异各咬住预期断言**（去 taskId 层 / 去特判 / 去截断，各红）。
  README 边界节补两条如实标注（TOCTOU 时间窗；入站 `traceparent` 缝合是引擎层白得的、
  本示例未做端到端断言）。

### 观测面给 agent 的入口：两个 MCP 只读工具（G8）（2026-10-12 ⑦）

- **是什么**：新示例 `examples/observability-mcp/`（本地小包，`private`）用现成的反向桥
  `createMcpServer` 把调优报告包成两个只读工具：`report_trace`（能力排行 + 会话维度的成功率
  与「每成功任务成本」）与 `diff_traces`（两条 run 的结构化差异）。任何 MCP 宿主（编辑器 /
  桌面客户端 / 另一个 agent）接上来，agent 就能自己查「我上一轮慢在哪 / 贵在哪」。
  **核心零改动**：两个工具是 `buildRunReport` / `mergeRunReports` / `diffTraces` 的薄壳。
- ⚠️ **这是分发面，不是功能面**（本仓瓶颈在产品面 / 分发面）：验收标准是「外部客户端接得上」，
  不是「新增了多少能力」。`npm run verify` 起真 HTTP server + 出厂连接器 + `mcpTools`
  连回去跑通 17 条 check（report / diff / 缺侧 / 截断 / 越界拒绝）。
- **三条口径**：① 只读 **trace 根**（`AGENTIA_TRACE_ROOT`，缺省 cwd）**内**的文件 —— 工具参数
  由模型给 ⇒ 不设边界等于对外发一个任意文件读原语，判据是 realpath 比前缀（不是 `startsWith`，
  后者挡不住 `../` 与同前缀兄弟目录）；② 进模型上下文的东西有天花板（差异 span 最多 40 条，
  截掉多少如实报出）；③ 读不出就说读不出（一条 trace 都认不出 ⇒ 报错而不是空表；成本给
  `null` 而不是 0）。
- **门禁**：示例进了 `tsconfig.tests.json`（按仓库根那套严格开关类型检查，含
  `exactOptionalPropertyTypes`）与 `e2e:examples` 第 10 轮；`examples/README.md` 表行由
  `examples-table` 守卫双向核。

### 交接与护栏：四个 `agentia.*` 属性 + 护栏进能力排行（G7）（2026-10-12 ⑥）

- **是什么**：交接（agent → agent）在这个框架里就是一条 capability span 本身，护栏（审批）则
  **只是事件**（`approval.requested` / `approval.decided`）—— 两者对外部 OTLP 消费者都要解析
  trace 才看得见。现在各补一个 additive 属性当入口（**不造 span kind**，核心零改动）：
  `agentia.handoff.from` / `.to` 写在被调 `@SubAgent` 的 capability span 上；
  `agentia.guardrail.name`（待决的**首个**工具名）/ `.triggered`（`true`）写在发起审批的
  `llm.turn` span 上。名字来源：run 根用 `runName`（与 OTLP 的 `gen_ai.agent.name` 同源）、
  子 agent 用它注册的 `name`；嵌套交接**逐层换名**。
- **视图**：`@migor/trace-view` 的 summary（CLI `agentia report` 与 `agentia dev` 面板同源）把
  `approval.decided` 聚成 `guardrail:<工具名>` 一行 —— `calls` = 走到决定的次数、`err` =
  **被拒**次数、`total` / `max` = 等审批时长。此前「哪个工具卡在审批上、被拒了几次」在排行上
  **完全看不见**。
- ⚠️ **只发一半是口径不是遗漏**：`guardrail.*` **只在触发时发**，不设 `false`（与
  `gen_ai.conversation.compacted` 同款）；`handoff.*` 拿不到调用方身份时（宿主手搓 recorder +
  ctx 直调 `subagentToTool`）**两个键都不发**。⚠️ 护栏行**只聚 `decided`**：只有
  `approval.requested` 而始终没恢复的挂起不产出行；缺 `waitedMs` 记 0 不编造。
- ⭐ **一处实现上的补空（设计稿没说清）**：「调用方 agent 名」在调用点**拿不到** ——
  `RecorderBackend` **只写不读**（查不了 span 树）、`ctx.parentSpanId` 反查不出名字。唯一来源是
  「当前调用期」作用域 ⇒ `SpanScope` 加可选 `agentName`，并把 `withCurrentSpan` 从**整条替换**
  改成**合并**（夹在中间的 `llm.turn` 谁都不知道身份，替换会把名字抹掉）。收窄语义逐字不变。
- **影响面**：`src/engine/{span-scope,loop,turn}.ts`、`src/toolkit/subagent.ts`、
  `packages/trace-view/src/summary.js`（棘轮 106 → 126）。公共导出面 `src/index.ts` **零变化**。
  约定与读法写进 `docs/usage-guide.md` §6.4「交接与护栏」。
- **验证**：`tests/toolkit/subagent.test.ts`（嵌套逐层换名 / 无作用域时不发）、
  `tests/engine/approval.test.ts`（在场 + 不在场两态）、`packages/trace-view/test/summary.test.js`
  （护栏行三态）。**变异 4 条：3 条当场咬住，第 4 条先没咬住 → 抓出的是我自己的自证样本**
  （`approved` 一真一假时，把判据取反仍是 1）⇒ 补样本后才咬住，已写进用例注释。

### CLI `agentia report` 加会话 / 任务维度（G6）（2026-10-12 ⑤）

- **是什么**：`agentia report` 此前只有**能力维度**（`capabilities[]`）+ run 级**计数**
  （`runs` / `failed`），而 `failed` 是**次数不是分母** ⇒ 「这一段跑得好不好」的第一问
  （成功率）在输出上**根本算不出来**。现在另打一张按**分组键**归组的表，`--json` 里是
  `sessions: SessionRow[]`（**加法**，兼容）。
- **分组键三选一、不混排**（一条 run 只进一个组）：run 根 span 的 `session.id`
  （宿主传 `session: { store, id }` 才写）→ 记录里的 `TaskRecord.taskId` → `(无会话)` 桶。
  ⚠️ 会话一般聚多条 run，而 `taskId` **逐任务唯一** ⇒ 后一路通常是「一组一条」，它是给单任务
  批跑逐条标成本，**不是**多轮聚合。
- **口径**：`runs` / `ok` / `fail` 三个数**一起出列**（只报百分比在小组成上是噪声）；
  ⚠️ **成功数为 0 时 `cost-ok` 是 `-`（JSON 里 `null`），不是 0** —— 「除不了」不等于「不花钱」。
  成本取该 run 的 `totalUsage.costEstimate`（= 各 `llm.turn` 之和、**不含** capability 聚合
  ⇒ `@SubAgent` 里套 `@Skill` 不会把同一批 token 数两遍）。⚠️ 设计稿原写「该组各能力行
  `costUsd` 相加」，落地时**改掉**了 —— 理由见 `docs/spec.md` §10 2026-10-12 ref-report-session-dimension。
- **影响面**：`packages/cli/src/report.ts`（194 → 339 行，棘轮账 LINE/TOTAL 同步）；
  `docs/usage-guide.md` §6.4 的 `--json` 形状列表加 `sessions`。**框架侧 `src/` 零改动。**
- **验证**：`report.test.mjs` +6 条（归组 / `(无会话)` 桶 / `taskId` 回退键 / 降序 /
  **「成功数为 0 ⇒ `-`」的反向断言** / 成本读不出 ⇒ `-`）；**变异 4 条各咬住预期的那一条**
  （`> 0` → `>= 0` / 丢掉 `taskId` 回退 / 把「读不出」写成 `0` / `session.id` 读成 `sessionId`）。

### OTLP 导出：三个缓存/压缩 semconv 键 + 可选的 execute_tool span 投影（2026-10-12 ②）

- **G3（additive、双发不替换）**：`llm.turn` 缓存读数 > 0 时另发
  `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_write.input_tokens`
  （0 = 没走缓存 ⇒ 不留键）；父 span 上有早于本回合开始的 `context.budget` 事件 ⇒ 发
  `gen_ai.conversation.compacted: true`（上游口径：只在能可靠判定时置真，不设 false）。
  键名逐字核自 `semantic-conventions-genai @ 6fd0d763` 的 `client-inference.md`。
- **G2（`OtlpExporterOptions.projectToolSpans`，默认关）**：开启后把 span 上按 `tool_use_id`
  配对的 `tool.input` / `tool.output` 事件投影成 `execute_tool <工具名>` child span
  （`gen_ai.operation.name=execute_tool` + `gen_ai.tool.name`；start/end 取两事件的真实记账时刻；
  `ok:false` → status Error + `error.type`）。**导出侧投影**：engine 记账点不动、本地 trace
  形状不变、原事件保留在父 span 上；关闭时导出产物与既往一致。孤儿 input
  （`traceLimits.maxEvents` 截断可造出）→ 不写 `endTimeUnixNano` / status +
  `agentia.projection.orphan: true`，不编零时长。
- 顺带：`context.budget` 事件名上移为 `core/trace.ts` 的 `CONTEXT_BUDGET_EVENT` 单源常量
  （第一次有了跨层消费方）。

### run 级 `sessionId` 的静默失效改成出声（2026-10-12 ③）

- **是什么**：程序内 `app.run(messages, { sessionId })`（不带 `session`）此前**静默丢弃** ——
  run 根没有 `session.id`（OTLP 的 `gen_ai.conversation.id` 也就不会有）、会话历史接不上、
  零信号（可观测深钻 §2 行 7）。现在 `AgentApp.run` 入口 `console.warn` 一次，文案指出正确写法：
  要会话维度 + 历史用 `session: { store, id }`；只要 trace 标记不要历史，直连
  `executeRun` / `runAgent` 的引擎级 `sessionId`（那一层本就生效）。
- **内部链路不误伤**：`AsyncRunner` 的续跑段刻意不注入 `session`，`buildRunCallOptions`
  不再把任务里的 `sessionId` 透传进 `app.run`（它在本层已被消费 —— 换成 `session` 注入，
  或没配 `sessionStore` 时在 submit 已响亮报错）。
- **无破坏性变更**：行为面只多一条告警；`sessionId` 的类型与异步宿主语义逐字未变。
  依据与备选方案（为什么不是「让 `app.run` 转发它」）见 `docs/spec.md` §10 2026-10-12 ref-session-id-warn。

### MCP 桥接 SEP-414 trace 上下文（`params._meta` 裸键）（2026-10-12 ④）

- **出站**：run 内经 MCP 桥调 `tools/call` 时，两个出厂连接器自动把当前 span 的 W3C
  `traceparent` 放进 `params._meta`（SEP-414 定的载体：裸键、不加前缀、**不进 `arguments`**）——
  认出它的 server（MCP Python SDK、agentia 反向桥等）就能把这次调用链回你的 trace。
  不在 run 内（桥脱离引擎单用）则不带：不造空上下文。
- **入站**：`createMcpServer` 认 `tools/call` 的 `params._meta.traceparent`，合法即记成该次
  trace run 根的一条 `links`（与 HTTP `traceparent` 头同款缝合）；缺失 / 畸形静默当作
  没有上游 —— 不报错、不影响调用成败。
- **无破坏性变更**：`McpClientLike.callTool` 第三参新增可选 `traceparent` 字段（鸭子类型，
  只实现两个参数的旧客户端照常兼容，只是链路断在它的传输上）；公共导出面零变化。
  决策与三条纪律（静默降级 / 不动 `arguments` / 不造空上下文）见 `docs/spec.md` §10 2026-10-12 ref-sep414-trace-context。

### 可观测文档：四条「缝外配方」类缺口收口（2026-10-12）

依据 `docs/reviews/2026-10-12/observability-deep-dive.md` 的 G9 / G10 / G4 / G5，**纯文档**，`src/` 一行未动：

- `docs/observability.md` 新增四节：**§6 投递纪律**（sink 内攒批 + 定时 flush 的骨架、关停时
  先 `handler.drain()` 再 `sink.drain()`、后端不可达就丢遥测不丢可用性；并明说**为什么不把
  `flushSinks` 改成 fire-and-forget** —— sink 的语义是「有兜底、会投递」，改了等于删掉一条
  已有承诺）；**§7 OTLP 只发 JSON ⇒ 直打 Phoenix 会 415**（已知边界 + collector 转码配方，
  含最小可用配置；为什么不内建 protobuf 编码器）；**§8 步数与环**（纯 trace 函数配方：
  数 `llm.turn` span、按回合归属成本、`tool_use_id` 配对、识别「同一工具同参数连调 N 次」）；
  **§9 轨迹评测**（确定性检查优先 —— 签名相等 / 步数上限，`agentia diff` / `harvest` /
  `defineEval` 拼合，LLM-judge 殿后）。
- **顺带订正一处事实错误**：§2.6 原把 Arize Phoenix 列进「平台支持 OTLP ⇒ 用内置导出器即可」
  —— Phoenix 只收 `application/x-protobuf`，内置导出器（只发 `application/json`）打不进去。
- `docs/usage-guide.md` §7 已知边界表新增一行（OTLP trace 导出只发 JSON ⇒ 直打 Phoenix 会 415，
  按 choice 登记）；`tests/docs/boundary-table.test.ts` 登记表同步（93 条：pin 57 / choice 11 /
  gap 25）。

### `agentia report` 按 `traceId` 去重：append-only 导出不再翻倍计数（2026-10-12 ⑧）

- **修什么**：`FileTaskStore` 是 append-only（每次 save 追加一行），审批流任务的导出里同一棵
  挂起段 trace 会出现多行（挂起 / approve / 接管各 save 一次），而 `report` 按行计 ⇒
  runs / 成功数 / 成本全部翻倍（实测实际 2 段 0.02 的任务报出 runs=3、cost=0.03）。
  现在按 **`traceId` 去重、只留最后一行**（append-only 里后面的是新状态）；能力表与 runs 总计
  也走同一份去重后的输入（存量问题一并修）。去重键是 traceId 而不是 taskId：一个任务可跨多段
  run，每段一棵新 trace —— 按 taskId 去重会把不同段错并成一条。
- **无破坏性变更**：`ReportJson` 形状未动，只有计数口径修正（同 traceId 的重复行此前本就是
  同一棵 trace 的重复书写）；无 traceId 的行（手写 trace）照原样全保留。
- **文档同步**：usage-guide §6.4 的 FileTaskStore 段落点明去重口径；会话维度段落点名
  「**挂起计入 ok**」（与引擎「挂起不是失败」同口径 ⇒ 全挂审批上会报成功率 100%，刻意取舍
  但需写明）。决策依据见 `docs/spec.md` §10 2026-10-12 ref-report-dedupe-traceid。

### 工程：决策引用换成 slug + 守卫收口（P2 / P3）（2026-10-14）

- **接上一条的 ①**：`（日期 + 圈号）` → `（日期 + slug）` 的三步迁移**已走完**（设计稿
  `docs/plans/2026-10-14-ref-slug-migration.md`）：上一轮 P1 给 §10 的每条锚点加了 slug（引用一处未动），
  本轮 P2 把引用换成 slug、P3 把守卫收成只认 slug。
- **P2 换引用**：射程 = 守卫射程 − 带日期的**快照**（`docs/plans/**` · `docs/reviews/**`，写于迁移之前
  = 历史）− §10 **锚点定义行**（圈号在那里是显示编号）− **日期在 §10 无条目**的引用（那个号指别的文档
  自己的编号）⇒ **302 处 / 84 个文件**，按文件分 5 批提交（便于 review 与单独 revert）。替换**按内容
  不按行号**（§10 加了章节头，其后行号全漂过）。脚本带一条硬规则：**同日重号拒绝自动选**（源序先到
  先得 = 脚本替引用挑一个含义，正是本设计要消灭的东西）⇒ 源头给一行显式覆盖表。
- **守恒验证**：84 个文件**归一化后逐字节相同** ⇒ 除引用形态之外**一个字符都没动**；另有按
  `(文件, 日期, 键串)` 的前后对拍（P1 的「引用一处未动」也这么验）。
- **P3 收口**：守卫从「圈号**或** slug 都能解析」（P1 起的**有期限**放宽）收成**只认 slug**，并新增
  判据「射程内（**除定义行、除快照、日期有条目**）的『日期 + 圈号』引用数 == 0」。**这不是新决定** ——
  它是 P1 时就写在代码里的退出条件到期执行。三项排除写成**减法**（各自指向另一条已写明的规则），
  而不是「给 `isDefLine` 加个开关」：读判据的人要能顺着三项去查。
- **一处口径修正（如实记）**：`packages/cli/CHANGELOG.md` **移出射程** —— 它是构建产物、只在**本机
  磁盘**存在（CI / 新克隆 / `git worktree` 里没有）。P3 首跑报「49 处残留」，其中 **46 处来自它**
  ⇒ 校验它的后果就是**本机红、CI 绿**。去掉它不丢覆盖（根 `CHANGELOG.md` 那一档覆盖同一份内容）。
- **另登记一条待守缺口（本轮量出、不在本轮做）**：**不带日期的引用**（`§10 ⑧` / `同日 ⑧` —— 日期写在
  上一句里）**从来不在守卫射程**（它的形态要求日期**紧邻**键）。实测 **35 处**（探针
  `.workbuddy/probes/2026-10-14-dateless-circ.mjs`，git 跟踪文件口径、可复跑）⇒ 已登记进
  `docs/guards.md` §2 的「待守」表（含「为什么还没有守卫」与两种可能的守卫形状）。
  「引用已全换成 slug」这句只对**带日期**的那一类成立 —— 这行缺口就是它的射程注脚。
- **「怎么写引用」到 P3 才写**（设计稿 §7.1 第 4 问的定稿）：`AGENTS.md` 的「设计决策」与
  `CONTRIBUTING.md` 的坑表各补一句。P1 期两种写法并存，那时教谁都是半对。
- **验证**：`circle-refs` 3/3；**P3 变异 8/8 逐条咬中** —— 改锚点 slug 名 ⇒ **恰好**引它的那几行红；
  造重名 slug ⇒ 唯一性红；把引用 / 锚点正则**分别**打瞎 ⇒ **真空护栏**红（**不是**「全绿」）；塞一处
  「日期 + 圈号」⇒ 残留判据红；把引用的日期改错 ⇒ 「该 slug 属于」红；删 slug 留圈号 ⇒ 半迁移红；
  **正对照**（M6）：「圈号是**可去掉**的显示编号」这条设计**真的生效** —— 删掉某条锚点的显示圈号后
  锚点仍可引、守卫仍绿。每项都在输出里点到名，恢复后 `sha256` 逐字节一致。
- **无使用者面变更**：本轮只动文档与一个守卫（`src/` 一个文件都没碰）⇒ 既有使用者不需要任何动作。

## [0.10.2] - 2026-10-11

> 本版主题（窗口 `0.10.1 → 0.10.2`）：**对外那一面各做实一格 —— 一个人能不能找到它、
> 能不能 5 分钟跑起来**；对内把框架最深的两块体积债还清。三块 —— ① **交付面**：脚手架生成的
> 新工程默认入口就是**可上线的 HTTP 服务**（`npm start` 直接起服务，不再是需要自己接线的批处理
> 样例）；② **分发面**：官网全站**英文版**（`/en`，五页逐节对译 + 英文 404 + 语言自动检测与手动
> 切换）—— 对外检索面第一次有英文落点；③ **内部债**：两轮**纯结构**重构（方法级体量闸与三处巨型体
> 外移；`#executeInner` 的结果记账外移 + 补 14 条直接单测），顺带把 c8 分支覆盖率棘轮从 88 收到 89。
> **无破坏性变更**：脚手架是**生成物**，已生成的工程有自己的 `package.json` / `src/`，不会被本版动到
> ⇒ 既有使用者**不需要任何动作**；`@migor/agentia` 的公共 API 与 `exports` **逐字未变**（本版唯一
> 碰 `src/index.ts` 的是版本常量那一行）。

### 官网 · 全站英文版（`/en`）+ 语言自动检测与手动切换（2026-10-08 ①）

- **是什么**：站点从中文单语扩成中 / 英两版 —— `index / docs / api / playground / tradeoffs`
  五页**逐节对译** + 英文 404，挂在 `/en/*`（中文仍在根路径，是默认入口）。此前整站只有中文
  （`fragments/` 下没有 `en/`、也没有 `/en` 路由）⇒ 对外检索面**没有英文落点**，而这正是本仓
  「瓶颈在产品面 / 分发面」那句话里最直接的一格。
- **语言怎么定**：`<head>` 最前的一段 `is:inline` 脚本，三条判据 —— ① 先读
  `localStorage['agentia-lang']`（用户**显式**切过）；② 否则看 `navigator.languages` 里有没有
  中文；③ 拿不到语言信息就**不跳**（宁可停在默认的中文版，也不猜）。⚠️ 自动跳转**只读不写**
  localStorage —— 写了就等于把「自动」记成「用户选择」，用户之后手动点回中文会被**立刻弹走**；
  只有 Nav 的切换控件才写。手动切换在导航右侧（`中 / EN`），指向**同页**的另一种语言。
- **URL 形态**：`build.format: 'file'` 下英文首页的产物是**扁平的 `en.html`** ⇒ 首页地址是
  `/en`（无尾斜杠）；`public/_worker.js` 加一条 `/en/` → `/en` 的 308 收敛（访客看到
  `/en/docs` 会顺手猜 `/en/`）。站点地址一律干净形态（`.html` 会被 Cloudflare Pages 308）。
- **SEO / agent 面**：两版各自 canonical 指自身，`hreflang` 三处互指（`x-default` 指中文版）；
  `sitemap.xml.ts` 增 5 条 `/en/*`；`llms.txt.ts` 加「Documentation (English)」节；
  `scripts/check-website-agent-readiness.mjs` 与 `scripts/build-md-variants.mjs` 的页面枚举改成
  **递归** —— 不改则英文页**全部在产物守卫射程外**，且拿不到 `.md` 变体（GEO 档 C/D 直接退化）。
- **英文 docs 页不摆第二份「已知边界」表**：那张表是构建期从**中文** `docs/usage-guide.md` §7
  抠的，英文页手写第二份必然漂移 ⇒ 改成「一句说明 + 指回单源」；`llms-full.txt` 保持中文单源不动。
- **客户端脚本文案**（首屏 trace 自播 / 回放面板 / BYOK 真实模式）是**运行期**插进 DOM 的，
  构建期无从替换 ⇒ 新增 `packages/website/src/scripts/lang.js` 的 `pt(zh, en)` 接缝，中英**贴在一起写**
  （不抽两份平行数组 —— 那会漂移，而且没有任何东西看得出来）；语言取 `<html lang>`
  （服务端已经定下的事实），**不读 `localStorage`**（否则「服务端渲了英文页、脚本文案出中文」
  这种错配就有了可能）。
- **守卫 `tests/docs/website-i18n.test.ts`**：页面集合一一对应 / 中英 fragment 的 `id` 集合逐页
  相等 + 剧本骨架（span id / 事件类型 / 顺序 / `usage`）逐例相等 / 英文面 0 CJK（fragment **与
  真跑客户端脚本**）/ `<html lang>` 映射与三处 `hreflang` / 检测脚本**只读不写** localStorage /
  五条 `/en` 路由已登记进 sitemap + llms.txt + `_worker.js`。**反向验证过 19 条**（各恰好点名
  那条，复原后 `sha256` 逐字节一致）—— 其中第一版有一条**假守卫**（裸正则被文件头注释里的
  `lang='en'` 满足），是变异验证当场抓出来的。
- ⚠️ 两处如实标注的**射程**：① 该守卫**不看 `dist/`** —— `npm test` 在 `verify-all` 里早于官网
  构建（步 6 vs 步 8）；产物侧仍由步 8 的 `scripts/check-website-agent-readiness.mjs` 守。
  ② 「英文面 0 CJK」走**行为断言**（子进程喂假 DOM + 假 `fetch` 真跑，见
  `tests/fixtures/website-i18n-harness.mjs`）而非源码扫描：本仓 `typescript` 是 7.x（tsgo），
  主入口已不再导出经典 parser API，而手写扫描器会被 `playground.js` 里**带反引号 / 引号的正则**
  （`/^\s*```/`、`/[&<>"']/g`）带偏（实测 24 处假命中）⇒ 它能抓「新增一段没包 `pt()` 的中文」，
  抓不到「**永远跑不到的死分支**」里漏包。
- 官网**不随包发布**（`packages/website` 是 `private: true`）⇒ 本版**无包的对外面变更**，
  既有使用者不需要任何动作。

### 官网 · 手机版重点特性卡的 `Core` 徽章压住标题（2026-10-08 ②）

- **病例**：390px 手机截图 —— 英文首页「Built for production」那张重点卡的 `Core` 徽章叠在
  标题 `Observable: trace as a first-class citizen` 的首行上（暗色小字下像两个字叠印）。
- **根因**：`.feature-flag` 是 `position: absolute; top: 16px; right: 18px`。桌面端这张卡
  `grid-column: span 2` 跨两列、标题一侧有富余，撞不上；**单列窄屏下标题换行**，首行末端
  直接钻进徽章底下。中英共用同一套 CSS ⇒ 不是「英文站专有」，标题一长就复现。
- **修法**：在**已有的单列断点**（`@media (max-width: 560px)`，即那条把 `.feature--key` 的
  `grid-column` 收回 `auto` 的地方）把徽章放回正常流：`position: static` +
  `display: inline-block` + `margin-bottom`。⚠️ **只写 `position: static` 不够** ——
  `<span>` 默认 `display: inline`，内联元素的 `padding` / `border` 不参与行高计算，
  徽章框照样会叠到下一行去。
- **守卫**：`tests/docs/website-css.test.ts` 增两条 —— ①「单列断点里 `.feature-flag` 必须
  收回正常流（且不是内联）」；②「该断点须覆盖手机宽度（≥480px）」。**反向验证过 4 条**
  （删掉整条规则 / `static`→`absolute` / 去掉 `display` / 断点 `560→360`），各点名对应断言，
  复原后 `sha256` 逐字节一致。⚠️ 断言前**先剥注释**：本仓踩过「守卫被同文件注释满足」的假绿。
- 顺手把 `docs/guards.md` §1 里 `website-css.test.ts` 那行补准：**2026-09-30 加的
  「折叠菜单 CTA 边框」守卫一直没登记**（那行仍写着「反向验证过 3 条」）。本次给它补做
  4 条变异验证，该行一并更新。同样**不涉及包**（改的是 `packages/website` 的样式与网站守卫）。

### 官网 · 部署后的 agent 打分不再在半传播状态下跑；`/en/` 的 308 补缓存头（2026-10-08 ③）

- **修掉一条腐烂的判据（真缺陷，非本次引入）**：`ci.yml` 的 `deploy-website` 在打分前要「等新
  版本真上线」，而那条判据是「`robots.txt` 里出现 `Sitemap: ` 行」—— 注释写着「它是本轮新增的
  产物，只有新版才可能有」。**那一行自 PR #119 起每一版都有** ⇒ 条件恒为真、从不等待。实测当场
  中了：第 1 次探测就报「已在线上」，而 AFDocs 读到的是**上一版的 sitemap**，据此刷出两条 **假
  FAIL**（`llms-txt-links-resolve` 报「2 条坏链」、`llms-txt-coverage` 报「5 links not in
  sitemap」—— 而 11 条链接逐条复测全是 200）。
  ⇒ 判据换成「**本次运行的提交**」：站点侧由 `packages/website/src/pages/robots.txt.ts` 在构建期
  写下 `# build: <GITHUB_SHA>`（本地构建**不写** —— 「这一行在不在」本身就是「这份产物是不是 CI
  构建的」的判据，不给它编假缺省值），CI 侧轮询等线上出现**同一个 SHA**。等不到不再静默：轮询
  超时留 `::warning::`，而构建产物里没有该行则 `::error::` 并**跳过打分**。
  ⚠️ **教训（写进 `ci.yml` 与 `robots.txt.ts` 的注释）**：判据不能是「某个只有新版才有的字面量」
  —— 它会随版本变旧、然后恒真；只能是「本次运行自己的身份」。
- **`/en/` 的 308 补上缓存头**：`public/_worker.js` 原先用 `Response.redirect()`，它只给一个
  `location`、**不带任何 cache 头**（Pages 自己那条尾斜杠 308 同样不带）—— 而这条规则由我们接手
  的理由**正是响应头**（否则没有任何地方能补）。改成显式 `new Response(...)` 并带上与站内其余响应
  同一档的 `public, max-age=0, must-revalidate`。行为用例增 3 条（`/en/` ⇒ 308 + 目标 + **缓存头**
  + 不劳烦 `ASSETS`；带 `Accept: text/markdown` 仍 308；`/en` 本体不拦），**反向验证 2 条**
  各点名对应断言。
  ⚠️ 两处更正：① 那条注释原先写着「Pages 对 `/en/` 只会回 404」，**是错的**（实测 Pages 会把
  `/docs/`、`/en/docs/` 这类「产物里存在 `x.html`」的目录形态自己 308 到干净形态）；② 上一轮我曾把
  那次 `cache-header-hygiene` FAIL 的账算在**这条 308** 头上 —— **也不是它**（AFDocs 会跟随重定向，
  逐端点复测静态资源 / `.md` / llms / sitemap 全合格）。那次的真因就是上面那条**腐烂的判据**。
  补这个头是显式的**卫生**，不是那次红的解药。
- **守卫加固（并更正一处误判）**：`tests/docs/website-i18n.test.ts` 里「检测脚本用了
  `location.replace`」这条断言原先直接匹配脚本原文 —— 一条**写着同样字面量的注释**就能把它喂绿。
  现在先剥**整行注释**再断言，并给剥壳器加了自证断言。⚠️ 上一轮我把风险说成「靠那段 HTML 注释
  用了全角括号才没爆」—— **不对**：那段注释在 `<script>` 块**之外**、根本不在被断言的字符串里；
  真实（也较窄）的风险是**脚本块内**的注释。同一守卫里另一条「`_worker.js` 的 `/en/` 规范化必须是
  308」原先钉死了整条 `Response.redirect(...)` 表达式 ⇒ 上面那次**行为等价**的改写把它打红了；已改成
  只核**登记**（分支在场 + 是 308），行为交给真跑用例 —— **钉实现的字面量会把「等价改写」判成回归**。
- **新增元守卫**：`tests/scripts/verify-all-wiring.test.ts` 增一条 —— 把「等新版上线」判据的
  **两端契约**钉住（`ci.yml` 侧必须按本次提交比；生产侧**真跑** `robots.txt.ts`，按打桩的
  `GITHUB_SHA` 核**渲染出来的产物**，并钉住「没给 SHA 时不输出这一行」）。写这条守卫时**我自己先
  写出两条假守卫**（判据侧匹配整个 job body ⇒ 被同一 job 里另一处同样的串满足；生产侧核源码文本
  ⇒ 被文件自己的注释满足），都是变异验证当场抓到的，已收紧。
- 同样**不涉及包**（改的是 `.github/workflows/ci.yml`、`packages/website` 与 `tests/`）。

### 官网 · 语言跳转从客户端 JS 搬到服务端 302（2026-10-09 ①）

- **病例（真 FAIL，非判据抖动）**：AFDocs（`agentdocsspec.com` 的 0.20.0 打分器）的
  `redirect-behavior` **逐页**判 `js-redirect` 而 FAIL —— 这是 CI 上唯一一条**真** FAIL
  （`cache-header-hygiene` 那条是部署半传播的连带假红，早前已排除）。根因：语言自动检测是
  `Base.astro` 里一段 `is:inline` 脚本（`location.replace`），而它**留在每一页 HTML 里**
  （英文页也有，只是运行期不触发）；AFDocs 判的是「这份 HTML 里有没有 JS 跳转」，不区分它会不会真跑。
- **搬到服务端**：`packages/website/public/_worker.js`（Pages **advanced mode** worker，源码 ==
  线上行为）按 `Accept-Language` 对**中文页面路径**回 **302** 到 `/en` 等价路径，并带
  **`Vary: Accept-Language`**（少了它 CDN 会把中文那份 200 回给英文访客 —— 跳转直接失效）。
  客户端那段脚本连同 `localStorage['agentia-lang']` 一起下线。⚠️ 设计稿
  `docs/plans/2026-10-08-website-i18n.md` §7 那条「静态托管没有服务端、JS 是唯一手段」当场被推翻
  （它没把 `_worker.js` 算进去），已在原处划掉并补 §9。
- **显式选择优先于自动检测（防循环的那把锁）**：`Nav.astro` 的中 / EN 切换控件改写成
  **`hl=zh` / `hl=en` cookie**（`path=/`、一年有效）；`/` 见到 `hl=zh` 就**不跳** —— 没有它，
  英文浏览器点「中」落回 `/` 后会被自动检测再次弹回 `/en`，用户**出不来**。
- **四条刻意边界**（写进 `_worker.js` 注释 + 设计稿 §9.3）：① 只从中文路径跳到 `/en`、**不反向**
  （`/en` 是本体、永不拦；代价如实标注：中文偏好访客循外链落到 `/en` 时**不会**被送回 `/`，
  旧 JS 会 —— 有意收窄）；② **只在非 markdown 请求上做**（带 `Accept: text/markdown` 的 agent
  要它请求的那个 URL 的 `.md`）；③ 只处理 `GET` / `HEAD`；④ 302 **不给长 `max-age`**
  （与站内其余响应同档 `public, max-age=0, must-revalidate`）。
- **守卫**：新增 `tests/docs/website-lang-negotiation.test.ts`（**真跑** `_worker.js`，喂假
  `env.ASSETS`）11 条 —— 用户点名的五条（`hl=zh` 不跳 / 无 cookie + `Accept-Language: en` ⇒
  302 到 `/en` / `zh-CN` 不跳 / `/en` 本体不被拦 / **手动切回中文后不再被弹回**）外加 `Vary` +
  缓存头、深层页 query 保留、`POST` 与 markdown 不跳、`/en/` 308 与内容协商**不回归**。
  `tests/docs/website-i18n.test.ts` 两条改写（客户端跳转**已下线**：断言打在**两层剥壳**后的源码上；
  Nav 改核 **`hl` cookie**、且只认真实 `onclick` 处理器里的写入 —— Nav 注释里就写着 `localStorage`）。
  **反向验证过 8 条**（各恰好点名那条，复原后 `sha256` 逐字节一致）：整段停用 ⇒ **4 条** /
  忽略 cookie ⇒ **2 条** / `Vary` 换成 `Accept`、去掉 `/en` 排除、去掉「非 markdown」闸、
  去掉方法闸 ⇒ **各 1 条**（服务端）；Nav 退回 `localStorage`、Base 加回客户端脚本 ⇒ **各 1 条**。
- **验收读数（本地真跑，8 页 curated 样本）**：`redirect-behavior` 由 **FAIL（js-redirect，逐页）
  翻成 PASS**（「No redirects detected across 8 pages」），`URL Stability and Redirects` 100/100；
  同一份产物在**退回旧实现**时该检查重新 FAIL —— 红→绿两向都实测过。
- ⚠️ **一处自己踩到的坑（顺手记下）**：第一版把「已下线」的说明写在 `<head>` 的 **HTML 注释**里，
  而 Astro 会把它**渲进每一页**（`location.replace` 字面量又回到了产物 HTML 里 —— 正是这条检查
  在看的字面量）；已把说明移进**构建期才执行的 frontmatter** 注释，`<head>` 只留一句不含该字面量的短注。
- 官网**不随包发布**（`packages/website` 是 `private: true`）⇒ 本版**无包的对外面变更**，
  既有使用者不需要任何动作。

### 深度评审收口：框架记账 / patrol 软链边界 / soak 假红假绿 / i18n 守卫记录面（2026-10-09 ②）

> 对 0.9.5 → 0.10.1 全窗口 + 在制品做了三轮深度评审（框架内核 / CLI / exports / soak /
> terminal-bench / patrol / 官网 i18n / CI），本节是发现的修复批次。每处修法都带变异验证
> （改坏 → 点名断言红 → 复原核 diff）。

- **`createOpenAIClient` 接 DeepSeek 缓存计量**（`src/integrations/openai.ts`）：DeepSeek 的
  `prompt_cache_hit_tokens` 此前被整个丢弃且 cache 恒记 0 —— agent loop 前缀缓存命中率常达
  80–95%，成本读数系统性高估数倍。现映射进 `cache_read_input_tokens`，且因 DeepSeek 口径
  `prompt_tokens` **已含**命中部分（与 Anthropic 相反），`input_tokens` 拆出未命中部分防双计；
  无这两个字段的端点行为逐字不变。决策依据见 spec §10 2026-10-09 ref-deepseek-cache-usage。
  **对包的对外面**：DeepSeek 端点的记账口径变准（原先恒 0）—— 修正而非破坏；其余无公共 API 变更。
- **patrol 示例的边界校验补上 realpath**（`examples/patrol/src/workspace.ts`）：原实现只有词法判定，
  根内指向外部的符号链接可读出界（数据外泄给模型）、`quarantine_path` 可把界外真文件移进隔离区
  （审批人只见 benign 相对路径）；头注却声称「软链逃逸一律抛错」。现为词法 + 真身两道校验，
  walk 不跟随软链，注释/README 与实现对齐。
- **terminal-bench 适配器五处**：基础设施错误（限流/5xx/超时/连接/上下文超长）不再落进能力分母
  （新增 exit 4 桶）；bash 哨兵锚定整行（`set -x` 不再污染）；`harbor_agent.py` 版本从真值派生
  （不再硬编码）；任务转换不再静默丢 `docker-compose.yaml`（单服务提取 ENV/WORKDIR/ENTRYPOINT，
  做不到的响亮告警）与原版 `run-tests.sh`（保留原文 + 尾部接 reward 落盘，测试依赖安装不再丢失）；
  容器内静态 node 包补 SHASUMS256 校验。
- **soak 验证工具**：`e2e-soak-suspend` 看门狗余量从真实预算逐轮派生（旧写死 +30s 在长档必假红）、
  approve 臂补「人工批落地 ≥1」闸（微档不再空转恒绿）、续跑段 link 校验从「存在」升级为
  「指向上一段」；`e2e-soak-app` 头注改为如实表述（假端点只回 echo，subagent/skill 链路本档未压到）。
- **官网 i18n 守卫补记录面**（`tests/fixtures/website-i18n-harness.mjs`）：`placeholder`/`value`/
  `title`/`aria-label`/`setAttribute` 通道此前不被记录 —— 英文页漏包 `pt()` 直接显示中文也全绿；
  假 fetch 剧本补 429 与网络错误分支。`_worker.js` 的 `/en/` → 308 补上 query/hash 保留。
  ⚠️ 本批另有两条**在 rebase 时被 ①（服务端 302）吸收**：客户端检测脚本已删除 ⇒
  「404 页跳过跳转」与「只读 localStorage 断言加强」两条随之失效（对象不存在了）；
  404 形态的残留（坏路径被 302 到 `/en/<坏路径>` 再 404）记为已知边界，见 PR #222 描述。
- 契约注释两条（不改行为）：`MemorySnapshot.rev` 声明「水合成功时不得为 undefined」；
  `TaskStore.get` 声明「必须返回副本而非内部活引用」（transport 的「先落库再派发」纪律依赖它）。

### 脚手架 README：「`npm start` 部署/Docker 用这条」的误导表述（2026-10-09 ③）

- **病例**：`agentia create` 生成的 README 写「`npm start` ……（部署/Docker 用这条）」，但脚手架的
  `main.ts` 是**一次性批处理入口**（`app.run` → 打印 → 退出：无端口、无 `/healthz`、无 drain）——
  那句话会读成「脚手架能直接上线」。全仓此前没有一处明说「脚手架给的是 CLI 形态，服务看
  `examples/deploy/`」。
- **修法**：模板 README 的「构建与生产运行」节把 `npm start` 如实标为 Job 形态（适合 cron / CI /
  容器一次性任务），并给出服务化的三个指引：`createHttpHandler` + `AsyncRunner` 的配方在
  `examples/deploy/`、上线清单在 `docs/deployment.md`、API 见项目内 `AGENTS.md` 的「触发与宿主」节。
- 只改文案，不改生成逻辑与脚本。CLI 套件 210/210 绿。

### 脚手架默认入口 = 可上线的 HTTP 服务（`npm start`）（2026-10-09 ④）

- **病例**：`agentia create` 生成的项目只有 **Job 形态**（`npm start` = 跑一次就退出的
  `main.ts`），而框架的交付承诺是「build 产物可以直接上线当服务」—— 上一版
  （2026-10-09 ③）只把 README 那句误导文案改诚实了，服务化仍要用户自己去
  `examples/deploy/` 抄配方再接线。
- **形态（对齐 NestJS 口径）**：`npm run build && npm start` 起来的就是**一个在监听的 HTTP
  服务**。为此把两个入口调了个个儿 —— **`src/main.ts` = 服务**（NestJS 的 `main.ts` 就是那个
  在 `listen` 的入口），原来的薄入口挪成 **`src/batch.ts`**（`npm run start:batch -- "你的问题"`）。
  脚本表：`start` / `start:prod`（**同物**，显式生产名）/ `start:batch`；**不再有 `start:server`**
  —— 它的角色被 `start` 吸收，留一个同物的旧名只会让人以为服务还有另一种起法。
  决策记录（含「换骨 vs 换皮」「SQLite vs FileTaskStore」两个取舍）见
  `docs/plans/2026-10-09-scaffold-default-service.md` 与 `docs/spec.md` §10 2026-10-09 ref-scaffold-default-service。
- **服务面**：`src/main.ts` 复用 `src/app.ts` 的 `createAgentApp()` 工厂（dev 环与生产共享
  同一份装配，旁路会被 `templates.test.mjs` 的形状断言挡住），接上 `createHttpHandler` +
  `AsyncRunner` + `SqliteTaskStore`：`/healthz`、同步 `POST /run`（含 SSE）、异步
  `POST /tasks`、**崩溃续跑**（`resumePending`）、**优雅停机**（SIGTERM/SIGINT →
  `drain({ timeoutMs: 15_000 })` → `server.close`，二次信号直接退出）。配套：模板
  `package.json` / `.gitignore` / README 三节重写、`create` 的后续步骤文案、
  `docs/usage-guide.md` §2.1 文件分工表两行。
- **鉴权取舍**：可选，不强制 —— 设了 `AGENTIA_TOKEN` 就启用 Bearer 校验（`/healthz`
  除外）；**不设则启动时打一条响亮警告**（「HTTP 面无任何鉴权，仅应监听回环/内网」）。
  与 `examples/deploy` 同档：框架「鉴权只是缝」（策略是宿主/反代的事），patrol 那种
  强制模式对第一天的新工程太重。
- **两处顺手修掉的静默**（评审实报，都不是新功能）：① `AGENTIA_DB` 的缺省从 **cwd 相对**
  改成按本文件位置落**工程根** —— 服务形态常换工作目录启动（systemd / 容器 `-w`），
  cwd 相对会让同一个工程用上两个库，而 `resumePending()` 静默找不到上一个进程的任务
  （表面看像「任务丢了」）；② `PORT=`（空串）此前经 `Number('')` ⇒ `0` ⇒ **静默随机端口**，
  现在显式当缺省，非整数 / 越界则响亮报错（⚠️ **不能**改成 `|| 3000` —— 那会把冒烟测试
  依赖的 `PORT=0` 一起吃掉）。另把 `PORT` / `AGENTIA_DB` / `AGENTIA_TOKEN` 补进 `.env.example`
  的变量清单。
- **Node ≥ 22.5 边界如实标注**：`SqliteTaskStore` 用 `node:sqlite`，更低版本**起服务时**
  构造期抛可读报错（框架对它延迟加载）。默认入口变成服务之后，这条从「只有 `start:server`
  需要」变成「**脚手架默认路径就需要**」—— README、`docs/usage-guide.md` 与上线清单
  `docs/deployment.md` §1 三处都写明，并给出 `FileTaskStore` 这条 Node 18 的退路（同一套
  API，代价是单写者前提）。框架**库**的 `engines: >=18` 与 `import-floor` job **不变**
  —— 抬起来的是脚手架默认路径的下限，不是包的下限。
- **只影响新建工程**：脚手架是**生成物**（`agentia create` 的那一刻写出去），
  已生成的工程有自己的 `package.json` / `src/`，不会被这一版动到 ⇒ **既有使用者不需要任何动作**
  （不构成破坏性变更）。
- **交付面同步（补做）**：这次翻转改的是「哪个文件是默认入口」，而**散文面当时没跟着改** ——
  官网中英两版 docs 页、仓库根 `README.md` 与 `packages/cli/README.md`（**随 npm 发布**）
  都还写着翻转前的说法，而 `tsc`、单测与八步门禁**全绿**：它们扫源码与产物，不看散文。
  已补齐，并加了 `tests/docs/scaffold-entry-contract.test.ts`（四层判据 + 三条防真空下限，
  12 条变异验证）。⚠️ **射程如实写在该文件头**：目录树里「一行只写一个文件」的列举、以及
  散文把两个入口名折到相邻两行的写法**不在射程内** —— 硬判会误红，而误报的门禁会被关掉。
  ⚠️ 这次漂移此前**零守卫**：`check-website-agent-readiness.mjs` 只核 `llms-full.txt` 与单源
  `docs/usage-guide.md` 逐字节相等，**官网 fragments 整片不在它的射程内**。
- **同一类病的第二例（顺手修掉）**：2026-09-22 把装配拆成 `src/app.ts` 时，官网两版 api 参考
  仍把读 `.env` 说成由默认入口 `src/main.ts` 首行做（它实际在 `src/app.ts`）—— 比本次翻转还早，
  停了半个月。已一并改掉，并给上面那条守卫补了第 ④ 层判据（同一行不得把读 `.env` 的 API
  挂在默认入口上、却不提装配模块）。⚠️ 这次也**零守卫**：`templates.test.mjs` 的同一条
  不变量只守模板源码，守不到散文面。
- **验证**：`templates.test.mjs` 的服务面形状断言改钉 `main.ts`（从 `./app.js` 取工厂、不许
  旁路 `createApp`、AsyncRunner + createHttpHandler + SqliteTaskStore + resumePending +
  `drain({` + SIGTERM、缺省无 token 必须有警告文案），原 `main.ts` 那两条**平移**到 `batch.ts`
  （薄入口 + `result.error` 非零退出）；`scripts/e2e-cli.ts` 一步真起 `node dist/main.js`
  （PORT=0、临时 DB、假 Anthropic 端点）—— `/healthz` 200、无 token `POST /run` 401、
  带 token 真跑一轮 200、SIGTERM 干净退出，另一条从**两个 cwd** 真跑 `dist/batch.js`。
  零 `src/` 框架改动。

### 重构（纯结构，零行为变化）· 方法级体量闸 + 三处巨型体外移（2026-10-11 ①）

来源：一轮框架深度评审的 §8 建议 ①②③。**零语义变更**（下游行为一字未改）⇒ 按
`CONTRIBUTING.md:59` 的判据**不写 `docs/spec.md` §10**；决策留档在
`docs/plans/2026-10-11-method-size-guard-and-debt.md`。

- **新增方法级体量闸 `tests/architecture/method-size.test.ts`**（`src/**` 单个可调用体 ≤
  **240** 行）+ 自带扫描器 `tests/architecture/lib/callable-spans.ts`。文件级已有闸
  （`source-size`，单文件「含代码行」≤ 750），但**方法级没有** —— 而文件级闸的盲区正好是
  最大那一档的生长方式：一个工厂把周边全吞进自己的花括号，**文件总行数几乎不变**。
  ⚠️ **判据是行数、不是比例** —— 评审报告建议的「比例」判据经**实测后否掉**：抽件在减分子的
  同时也减分母（`mcp-http.ts` 抽走 74 行后仍在 78%），比例的下限被文件的脚手架行数顶住，
  要当时就咬只能落在离阈值 1~4pt 处 ⇒ 常态化误报（违 `guards.md` §3 纪律①）。
  扫描器**刻意不是 AST**：`typescript` 7.0.2 是 tsgo、**已无经典 compiler API**（实测
  `import * as ts` 只剩 `{default, version, versionMajorMinor}`）⇒ 走文本，并与结构体检技能
  的独立尺对拍（13 行读数**逐字相等**）。
- **三笔债按新闸的射程外移**（判据：这段代码能不能**局部问答**，能才搬）：
  - `integrations/mcp-http.ts` 的 `createStreamableHttpMcpConnector` **265 → 191 行**
    （文件 316 → 245）—— 两个连接器**各自抄了一份**的协议面（JSON-RPC 结果提取 / HTTP 错误
    包装 / `tools` 清单校验 / `isError` 拒绝 / 会话自愈判定，共 7 个）收进既有的
    `mcp-protocol.ts`（158 → 294）。同一条错误文案曾存在两份，**改一处漏一处没有用例看得见**。
  - `integrations/mcp-stdio.ts` 的 `createStdioMcpConnector` **252 → 213 行** —— 子进程退出
    观察面（`trackChildExit`）与收尾（`reapChild`）提出去；stdout 分帧派发提出 `dispatchLine`。
  - `engine/mcp-server-http.ts` 的 `startHttpTransport` **192 → 145 行** —— 五个纯件
    （`sendJson` / `readBody` / `jsonRpcIdOf` / `startListening` / `closeOwnServer`）提到
    **同文件模块级**；`mcp-server-stdio.ts` 同款提出 `dispatchLine`（那个体本来就在 240 以下，
    属顺手对齐，不是欠债）。
  - `transport/async.ts` 的 `#executeInner` **257 → 217 行**（文件 1460 → 1419）—— 42 行 run
    选项装配 + 幂等去重的终态采纳搬到**新文件** `transport/run-call-options.ts`。⚠️ 搬迁
    **逐字**：那些 `...(cond ? {k: v} : {})` 的形状是承重的（本仓开着
    `exactOptionalPropertyTypes`，「没这个键」与「键是 undefined」下游语义不同）。
- ⚠️ **反直觉读数，写明免得下次误判**：外移让这七个文件的**总行数上升**（2569 → 2801，
  **+232**）。原因不是多写了代码，而是**注释是证据载体** —— 搬走的每一块都带着自己的
  「为什么外移」。这个方向**没有守卫会被触发**（`source-size` 是单文件闸，没有全仓总量闸）。
- ⚠️ **本轮自己踩到并修掉的两个「守卫骗人」**：① 第一版自证样本把花括号放在**单独一行**，
  而收尾判据**对整体深度平移是免疫的** ⇒ **摘掉遮蔽照样绿**（假守卫）—— 已换成「花括号与体的
  开括号**同一行**」的真病灶形态。② 外移时漏掉**第三个写者**：基线 `markExited` 挂在
  `error` / `exit` / `close` **三个**监听器上，只搬两个 ⇒ 表现为「关不掉」或「多等一个宽限期」，
  **用例全绿、`tsc` 全绿、67 个 MCP 用例全过**。这正是 `guards.md` 附 B.3 第 1 条问的东西，
  它是**被机械对拍（字面量 `'exit'` 计数 1→2）带出来的线索**，已补回并保持 1:1 映射。
- **验证**：变异电池六条（4 条扫描器口径 + 棘轮 + 真空护栏）**咬住 6 / 漏网 0 / 还原异常 0**，
  每条都是精确字面替换（命中数 ≠ 1 即中断）、备份先于一切变异、还原后 `sha256` 逐字节回到基线；
  其中最强的一条是**把 `mcp-http.ts` 用 `git show HEAD` 退回拆分前** ⇒ 断言原文点名
  `mcp-http.ts:52 createStreamableHttpMcpConnector = 265 行（占文件 84%，该文件可调用体 1 个）`
  —— 即**本闸本来就能在拆分前咬住那笔债**。另按附 B.3 第 2 条做**字符串字面量机械对拍**
  （163 种 / 300 处 → 164 种 / 302 处，5 处丢失逐条核过，只有三条 MCP 错误文案 2→1，
  而那是本次的**目的**）。`guards.md` §1.1 补登记行（含两条已知偏离：**比例盲区** 与
  「多行调用传对象字面量实参 `foo({` 会被判成一个体」——全量实测 538 个体里 4 个、最大 9 行）。

### 重构（纯结构，零行为变化）· ③ 做全：`#executeInner` 的结果记账外移 + 直接单测（2026-10-11 ②）

- **先更正上一份评审的口径**：它把 ③ 写成「`async.ts` 的 **drain 协调**（`#executeInner` 257 行含
  **4 个嵌套 `try`**）」—— **两半都不准**。① drain 的**等待闸**早已抽成 `src/transport/drain-gate.ts`
  （**在飞计数刻意不搬**：它同时是 `/healthz` 的 `inFlight` 口径、由任务生命周期加减）；
  ② 现测是 **6 个 `try {`**（`catch` 只有 3 个，另 3 个是 `finally`；缩进 profile 4/6/8/8/10/8）
  ⇒ **最深四级 `try` 嵌套**，不是 4 个。**根因是 `AGENTS.md` 自相矛盾**：`transport/`
  导览一处写「只剩 drain 协调未抽」，几行之后就是 `drain-gate.ts` 的说明。⇒ 本轮**就地更正那句话**
  并留下后果说明（正是它让人把已完成的抽件报成未偿的债）。
- **做了什么**：抽 `src/transport/run-outcome.ts`（同族的第五件，前四件是 slot-pool →
  approval-policy → drain-gate → run-call-options）——`readClaimed`（认领前重读；**读失败不升级成
  「任务起不来」**，这条分支此前只能透过 runner 行为间接观察）+ `applySuspendedOutcome` /
  `applyTerminalOutcome`（挂起与终态两支的**记录映射**）。逐字搬迁，判据与注释一并搬走。
- **纯的边界**：实例副作用以**返回值**交回调用点。其中「用户输入快照必须在 `rec.spec` 被覆盖
  **之前**取」是**承重的顺序事实** —— 取错时刻是**静默的错**（会话历史翻倍、token 复利），
  所以它必须是一条类型上看得见的返回值，而不是藏在函数体里的回调。
- **读数**：`#executeInner` **217 → 176 行**；其中的 `try` **6 → 5**、`catch` **3 → 2**
  （`readClaimed` 摘掉一个 `try`+`catch`）。⚠️ **最深 `try` 嵌套没变，仍是四级** —— 去掉的那个与
  run 段**平级**，不在 4→6→8→10 那条最深链上。⇒ 本轮降的是**体量与 `try` 个数**，不是嵌套深度；
  `async.ts` **1419 → 1379 行**。⚠️ **剩下的 5 个各有不同语义**（最外层挡「异步 store 任何一处
  reject 逃逸成 unhandled rejection」/ 认领终态闸 / run 段错误映射（`cancelIntent` 必须声明在
  `try` **外**才能被 catch 看见）/ 收尾摘监听器 / 落库失败也要释放槽位）⇒ **抽平它们只会改变语义
  或把 `try` 搬个地方**。所以本轮的判据是「**能抽的抽干净 + 把剩下的为什么不能抽写下来**」，
  不是「把 `try` 数降到 1」。另**如实记一条**：本轮抽件**没有降低嵌套深度**（4 级 → 4 级），
  降的是**体量与 `try`/`catch` 个数**；「抽走了一个 `try`」≠「嵌套浅了一层」。
- **新增单测 `tests/transport/run-outcome.test.ts`**（14 个 `it`）：快照的三条判据**各缺一条都拿不到
  快照**、`eventsDelivered` **两档都断**（只断一档的话「无条件清」也能绿）、终态 5 个挂起痕迹字段
  + 返回值 3 组合（`isResume × run.status`，且非取消那支**用 `failed` 试**——只用 `succeeded`
  的话两种写法都绿）、「取消但已有 error ⇒ 不覆盖」、以及**异步 store**（`get` 返回 Promise）那一支。
  fixture **逐字段给值**、不用 `{} as AgentRunResult` —— 本件真正读的就是那几个字段，空对象 cast
  会让「字段名写错」在 `tsc` 下全绿、运行时读成 `undefined`（本仓第 5 条踩过的原样形态）。
  transport 套件 **353 → 367** 全绿（零行为变化的行为侧判据）。
- **变异电池 16 条**（`.workbuddy/probes/2026-10-11-run-outcome-mutation-battery.py`）：咬住 **16** /
  漏网 **0**。⚠️ 被改的文件是**本轮新增、尚未入库**的（`git status` 里是 `??`）⇒ 脚本按本仓第 15 条
  **第四形态**写：备份先于一切变异、**开跑就把恢复点打印出来**、装 SIGTERM/SIGINT 处理器先还原再退
  （`try/finally` 挡不住 SIGTERM：默认处置是立即终止、不展开栈）。
- **覆盖率棘轮：分支阈值 88 → 89**。阈值按 `docs/guards.md` 附 B.2 那条推 —— **阈值 = 水位 − ~3pt**。
  **改前基线**（在 `HEAD`（`303c870`）上开独立 `git worktree` 跑，里面只有改前那 353 条用例）：
  `All files` 行 98.57 / **分支 92.82** / 函数 98.44，其中 `transport/async.ts` 分支 **94.91**；
  **改后现测**（367 条用例）：行 98.58 / **分支 92.85** / 函数 98.45，`transport/async.ts` 分支
  **95.08**，新件 `run-outcome.ts` **100/100/100/100**（那 14 条单测确实把它的分支走遍了）。
  ⇒ 88 的余量 4.85pt 超出「~3pt」的必要范围，收口到 **89（余量 3.85pt）**；⚠️ **收 90 只剩 2.85pt
  （低于 3pt）故不取** —— 阈值离水位太远会放掉一整个模块的测试，太近会把正常抖动当退化报。
  **行 / 函数刻意不动** —— 行 95 的余量 3.58pt、函数 95 的余量 3.45pt，本来就在 ~3pt 上。
  ⚠️ 基线那次跑有 2 条红，**与代码无关**，如实记下：`worktree` 里没有 `dist/` ⇒ `tests/docs` 的
  记分牌量不了**发布体积**（`dist/index.js 不在场`）。那两条不执行 `src/` 代码、也不影响覆盖率读数。
- **忠实性按 `docs/guards.md` 附 B.3 六条复核过**：字面量多重集对拍 `async.ts` **72 种 → 72 种**
  （少的 3 处是 `'cancelled'` / `'suspended'` / `'succeeded'` 各 1 处，**都落在新件里**；多的 1 处是
  `'./run-outcome.js'` 这条 import）⇒ **1:1**；新件**零模块级状态**；依赖单向（新件不 import `async.ts`，
  `RunSettled` 是**结构镜像**，真类型漂移时调用点直接报错）。

### 依赖

- 开发依赖：`@anthropic-ai/sdk` → 0.132.0、`@types/node` → 26.6.4 —— **不影响运行时面**：
  两个都在 devDependencies（根 `dependencies` 是 `{}`）。SDK 只在
  `tests/types/message-compat.types.ts` 做「自有公共消息类型族 ↔ SDK 类型」的结构兼容门禁，
  另在 `tests/engine/errors.test.ts` / `tests/engine/loop.test.ts` 里真 `new` 出 SDK 的错误类
  断言引擎映射 ⇒ 两道都在 `verify-all` 射程内（第 4 步 / 第 5 步），本版是绿的。
- 官网（不随包发布）：`astro` → 7.3.7。构建与产物形状由 `verify-all` 第 8 步
  （`build:website` + 按产物形状核 404 / robots / sitemap / llms.txt）在 PR 阶段验证，
  真实部署只在 main 上跑 —— 本版已随 main 的 CI 部署通过。
## [0.10.1] - 2026-10-05

> 本版主题（窗口 `0.10.0 → 0.10.1`）：**从「看得见一次 run」到「留得下、比得出」**，外加给两块
> 长期没有闸门的地方补上闸门。三块 —— ① dev 面板：每次 run 收尾把 trace 落盘，成为
> `report` / `diff` / `harvest` / `export` 四个命令的现成输入，并支持**并排比两条 run**
> （含「改一句 prompt 立刻重跑对照」的自动补对）；② `packages/trace-view`：补规模棘轮 +
> 三条最该有的行为断言（树形状 / 错误行 / usage 汇总）；③ `docs/usage-guide.md` §7 补登记
> 两条**有病例、可复现**的长跑边界。
> **无破坏性变更**；`@migor/agentia` 框架代码**零改动**（本轮发布面里唯一碰到 `src/` 的是
> 版本常量那一行）⇒ 既有使用者**不需要任何动作**。
> ⚠️ **一处新增的用户可见文件**：跑 `agentia dev` 会往工程根的 `.agentia/` 追加
> `traces.jsonl`，**只增不减**（`.agentia/` 已 gitignore；要清是用户自己 `rm`）。

### dev 调试工作台：trace 落盘 + 并排 A/B（2026-10-05）

- **是什么**：`agentia dev` 的本地面板从「看一条 run 的调用树」扩成「**比两条 run 差在哪**」。
  两件事：① 每次 run 收尾把 trace 追加落盘到 `.agentia/traces.jsonl`；② run 列表支持
  **⌘/Ctrl + 单击**选两条，右栏切**双栏**并排两棵调用树，顶部一条差异摘要
  （run 级 summary + 逐 span 字段级差异）。设计稿 `docs/plans/2026-10-05-dev-workbench.md`。
- **落盘换来什么**：那个文件的格式**恰好就是** `agentia report` / `diff` / `harvest` /
  `export` 四个命令的输入（`jsonlTraceSink` 的契约）⇒ 面板里跑过的每一次 run，
  立刻变成「哪个能力慢/贵/爱失败」「改 prompt 后轨迹漂没漂」的现成输入。
  开发期最贵的一件事是「拿不到刚才那次 run 的数据」，这一行就解决它。
- **并排 A/B 的判据（三档，显式不静默）**：能力选择与工作目录是 **app 级**的
  （换它们要重启进程）⇒ 两条跨了能力选择的 run，`runConfigSnapshot` 整个变了，
  diff 出来的差异**多半与「我改的那句话」无关**。所以跨能力 / 跨目录 / 元信息缺失
  都给**显式降级提示**（含可执行的出路），而不是静默给一份没意义的 diff。
  可比时**不显示**提示条 —— 每次都飘噪声等于没有提示。
- **三条如实标注的边界**：① `traces.jsonl` **只增不减**（`.agentia/` 已 gitignore；
  要清是用户自己 `rm`）；② 落盘是**同步写**（`appendFileSync`），大 trace 会占 runner
  事件循环 —— dev 场景单条以百 KB 计，且 `traceLimits.maxEvents` 本来兜上限；
  ③ **并排是「事后回看」，不是「同时跑」** —— 单飞闸没解除（解除会连带改变
  「文件变更延后重启」的语义，而那条判据是刻意单源化的），真并发另议。
- **守卫**：compare 路由三态（顺序 / 可比性 / 归一化）与判据六条都有单测，且做过
  **变异反向验证**（路由顺序反了、判据写死、`rootSpanId` 缺失 —— 三个变异都被咬住）。
  另给 e2e 加了落盘断言（逐行可解析 + **traceId 不重复**：重复行 = sink 被注册两次）。
- **一处自认的债**：`normalizeForDiff` 存在只因 `diffTraces` 的 `pushAttrDiffs` /
  `pushEventDiffs` 不接受 `undefined`，而 `packages/cli/src/diff.ts` 是框架
  `src/engine/trace-diff.ts` 的**逐字同形移植副本** ⇒ 根治要框架侧一起改
  （`?? {}` / `?? []`），属 `src/` 语义变更。本次取「消费侧归一化」的零核心改动解。
  **零 `src/` 改动** ⇒ 按 `CONTRIBUTING.md` 的判据不写 spec §10。
- **顺带补的面板测试债**：上面这批面板代码里**能单测的判断已从 HTML 搬进
  `panel-logic`**（`compareView` 三态视图 / `diffSideLabel` 缺侧标签 /
  `diffValueText` 取值 / `diffFetchErrorText` 失败文案）—— 搬**不是**新写，
  是把已存在的行为从「无测试区」挪进 `panel-logic.test.mjs` 的射程。
  ⚠️ **剩下的 DOM 接线补不了**（本仓无 jsdom，硬加会引入 DOM 依赖）⇒ 只有
  `scripts/e2e-dev.ts` 间接兜。如实标注，不假装已覆盖。
- **入库前评审修掉三处**：① **并排态下普通单击切 run 时不复位 DOM** —— 只清了选择，
  右栏与差异摘要**留在屏幕上**（内容还是上一对的）而选中标记已经消失，用户按看到的读
  会张冠李戴。这是本档**唯一用户可见**的缺陷；修法 = 清空必须走 `exitCompare()`，
  并抽出 `resetCompareDom()` 消掉三处逐字重复的复位序列；**另补一条文本层守卫 W4**
  （`state.compare = []` 只许出现在 `exitCompare` 里）—— 面板无 jsdom 单测，
  这是唯一能防它回归的机制。② `refreshCompare` 读不到某条 run 时**静默留白**
  （看起来像「这条没有调用树」，真相是它已被内存 ring 淘汰）⇒ 改为显式说出来。
  ③ 删掉只写不读的 `state.diff` 字段 —— 它的注释还承诺了一个**并不存在**的「读取中…」
  渲染。另修：`comparability` 的长 JSDoc 错挂到 `capsKey` 头上（它自己反而没有注释）、
  一条与上一条**同一对 run 同一断言**的死断言（`bothFull`）。
- **A/B 闭环补最后一跳**：上面那条「改一句 prompt 就能**立刻重跑对照**」此前要手动
  ⌘ 点两条才进并排（三步）。现在 —— **已选一条、还没选第二条**时，新 run 一收尾
  就自动补上第二条并进双栏，**并播一条 notice** 说清屏幕为什么变了。判定
  `autoPairTarget` 在 `panel-logic`（6 个断言 + 变异验证），三种情况**刻意不自动**：
  空选择（替用户决定）、已选两条（会挤掉刚选的）、同一条。⚠️ 这是「事后回看」的
  自动化，**单飞闸仍未解除**（真并发要改「文件变更延后重启」那条单源化判据，
  见设计稿 §8）。DOM 接线本身**无自动化覆盖**（无 jsdom），只有 e2e 间接兜。

### `packages/trace-view`：补规模守卫 + 补三条最该有的行为断言（2026-10-05）

- **规模棘轮**（新增 `test/structure.test.js`）：逐文件 `LINE_BUDGET` + **反向**检查
  （表里有、盘上没了 ⇒ 基线该调低，否则登记项失效后守卫「看起来在管」而实际不管）+
  一条「基线表不许有重复键」的自检。**这道守卫买的不是「今天的健康」**（实测
  `src/` 846 行、测试 904 行、体量完全健康），**是「它开始变大时有人被叫醒」** ——
  2026-09-23 刚在 CLI 上治过一模一样的病（`dev.ts` 长到 1148 行、长出隐式状态机，
  靠人工回看才发现）。
- **三条行为断言**（新增 `test/tree.test.js`，9 个用例）：补的是 `renderTrace`
  里**注释最密、却一直没有断言**的三块 ——
  ① **树形状**：三层嵌套的树形前缀（`└─` / `├─` / 竖线缩进）与「事件与子 span 按发生
  顺序混排」（拍平成「先全部事件、再全部子 span」会让用户看到因果倒置）；
  ② **错误行**：失败 span 的类名 / `meta` 带 `error.type` / **原文单独起一行**（只塞
  `title` 等于没显示 —— 首次运行最常见的「没配 API key」就靠这一行定位）、run 根失败
  时根行也标红（已修过的缺陷，防回退）、**正常 span 不加 error 类**（防「三态塌两态」
  导致满屏红）；
  ③ **usage 汇总**：**只累加 `llm.turn`**（capability span 的 usage 是子 span 聚合，
  重复计入会双算，而页面上看不出异常 —— 最坏的静默错），且**成对**钉「两个 turn 累加成
  两倍」（否则「压根不累加」也能绿）；另钉「每行显示自己那份 usage」与「根未结束不收尾」。
- ⚠️ **新写的断言里三条是我自己写错的**（都被现有代码正确地打红、查证后是断言错不是代码错）：
  ① 以为 `m1` 是根的独子（实际它还有兄弟 `sibling` ⇒ 只能是 `├─`）；
  ② 以为「混排」是事件行插到**别的** span 行之间（实际混排发生在**同一个父节点的孩子
  列表**里，事件是所属 span 的子节点）；③ 根失败的 status 写在了 trace 顶层
  （渲染器读的是**根 span 自己**的 `status`）。⇒ 三条都已写进注释，说明读的是哪个字段。
- **两处变异反向验证**（都被咬住）：usage 去掉 `llm.turn` 判据 ⇒ 双算 200 被抓到；
  树形缩进恒空 ⇒ 平铺被抓到。**零 `src/` 改动。**
- **同批复核又修掉两处**：① 结构守卫里那条关于重复键的注释**事实错误** ——
  原文说「本文件是 `.mjs`（ESM 严格模式）⇒ 重复键是 SyntaxError、import 就炸」，
  **实测证伪**：`{ a: 1, a: 2 }` 写进 `.mjs` 是 exit 0、输出 `{ a: 2 }`（ES6 起对象
  字面量的重复键是合法的）。⇒ 那条自检**不是备份，是唯一防线** —— 变异实测：把重复键
  补在**表尾**时「单文件不超基线」那条**照样绿**（后写的值覆盖前者，反而更宽松），
  只有它红。② `tree.test.js` 里一条断言消息夹着**两个 U+FFFD 替换字符** ——
  assert 失败时唯一给线索的那句话是乱码。

### 文档 · `§7 已知边界` 补登记两条长跑边界（2026-10-02）

- **是什么**：`docs/usage-guide.md` §7 补两行 —— ① 缺省**不裁剪**上下文：不注入 `contextPolicy`
  就一个回合都不裁，长跑成本随**回合数平方增长**（框架给了缝与参考实现 `createBudgetPolicy`，
  但**不替你决定**，因为裁剪有损）；② 回给模型的 `tool_result` **不截断、也没有大小闸**
  （`maxEventChars` / `traceContent` 只管**记账侧**），长跑需要一个**宿主侧的输出上限**，
  否则下一回合以 api 错误收尾。
- **为什么该补**：§7 是「使用者判断『我能不能用这个框架』的唯一依据」，这两条**有病例、
  可复现、可量化**却没登记。更糟的是第 ② 条**已登记了一半**（「`contextPolicy` 不进子循环 ⇒
  撞上限以 api 错误收尾」）—— **一半的边界比没有更危险**：读表的人会推出「那主循环是安全的」。
- **病例（TB 4.0 实跑，286 个 trial）**：① 上下文**一次都没被裁剪过**（发生过回落的
  trial = **0 / 286**）；单次请求的输入 token 从 ~1000 涨到 **619,119**，且
  `sum(steps.prompt_tokens) == final_metrics.total_prompt_tokens` ⇒ 每回合把整段历史**重发**一遍。
  ② 有一条 PTY 回显洪水在 trace 里落了 **1.69 亿字符**（单条 `tool_result` 的 content；
  JSON 序列化后 1.84 亿、整个 `trajectory.json` **184 MB**）—— 该 trial 共 **9 步**、
  总输入仅 **10252 token**，洪水恰好在收尾前，**下一步没有真实请求**才侥幸过关。
- ⚠️ **这两个数不是一回事**（本次差点读错）：**trace 里记了多少 ≠ 模型看到了多少**。
  `maxEventChars` / `traceContent` 都在**记账侧**。拿 trace 体积推断上下文之前，先与 usage 对账。
- **登记形态是 1 pin + 1 gap**：`tool_result` 那条有真门禁 —— `tests/engine/eventChars.test.ts`
  的用例「回给模型的 tool_result 不受截断影响（截断只在记账侧）」正是为它立的 ⇒ `pin`；
  缺省不裁剪那条只有**配置读数**（`run-config.test.ts` 钉 `config.contextPolicy === false`），
  把 `turn.ts` 里的判据改掉它**照旧绿** ⇒ `gap`（「变假时没有用例会红」就是 gap 的定义）。
- **刻意不做两件事**：① **不写**独立的「工具输出截断配方」—— 目前只有一个使用方（TB），
  且它的诉求恰恰是「**不要**截断」（评测要原始输出）；此刻写配方必然是两边折中的空话
  （本仓判据：先有病例，再有设备）。② **不改**「缺省不裁剪」的行为 —— 改缺省 = 替宿主做
  **有损**决策 + 逼核心变厚，与「只给缝、不给策略」冲突。框架这里是对的，欠的只是说明书。
- **顺手订正一处长期没人发现的读数**：`docs/guards.md` §1.4 的登记行写着「§7 的 **88 行**」，
  而它当时就是错的（实际 90）⇒ 改为 **92**。`guards-registry.test.ts` 只查「清单里的路径
  真实存在」+ 条目密度下限，**不查数字** —— 这类读数没有守卫盯。
- **去掉一个会腐烂的数**：`examples/terminal-bench/README.md` 原写「`cat` 大文件会让 trace 到
  **几 MB**」，实测上界 **184 MB**（差两个数量级）⇒ 改成**定性 + 现算路径**，
  而不是换一个新的会腐烂的数。
- **零语义变更 ⇒ 不新增 `docs/spec.md` §10 节**：按 `CONTRIBUTING.md`「**语义变更**要同步 §10」，
  本轮只补登记**既存事实**、未改任何行为（`src/` 零改动）⇒ 不写决策条目。
- 影响面：`docs/usage-guide.md` §7、`tests/docs/boundary-table.test.ts`（`REGISTRY` +2 条 +
  5 处写死读数）、`docs/guards.md` §1.4、`examples/terminal-bench/README.md`、本节。
  **框架代码零改动。**

### 依赖

- 开发依赖：`@anthropic-ai/sdk` → 0.131.0 —— **不影响运行时面**：`src/` 不 import 它，
  它只在 devDependencies 里做「core 消息类型族 ↔ SDK 结构兼容」那道门禁（`src/index.ts`
  有说明），而那道门禁在本版是绿的。
- 官网（不随包发布）：`astro` → 7.3.5。构建与产物形状由 `verify-all` 第 8 步
  （`build:website` + 按产物形状核 404 / robots / sitemap / llms.txt）在 PR 阶段验证，
  真实部署只在 main 上跑 —— 本版已随 main 的 CI 部署通过。

## [0.10.0] - 2026-09-29

> 本版主题（窗口 `0.9.5 → 0.10.0`）：**从「跑得起来」到「敢上线、也找得到」**。
> 两条主线 —— ① **把对外承诺从「文档上的一句话」改成「断言」**：稳定性策略 / 三个不发布的包 /
> CI 运行环境全都写代码核实，README 顶部每一个数字由脚本现算，公开 API 边界由 `exports` 字段
> （而不是一句承诺）封住；② **补两处对外空白**：「从 demo 到生产」的 `docs/deployment.md`、
> 官网第一次写出「什么场景该选别人」的 `/tradeoffs` 页。
> ⚠️ **本版有破坏性变更**：`exports` 收窄后深路径导入会被拒 —— 只有 import 过
> `@migor/agentia/dist/**` 的使用者需要动手，动作写在下面 ⑭ 那条的「**迁移**」小节。
> 其余 15 条条目**都不改变既有使用者的行为**。

### 工程 · 发版闸门「骨架未填」的判据改成精确锚（2026-09-29 ⑳）

- **是什么**：`scripts/release-surface.mjs` 判断「本版 CHANGELOG 是不是还停在 bump 插的骨架」时，
  用的是粗判据 `sec.body.includes('TODO')`。**本次发版当场被它拦下 —— 而且是误伤**：本版 ⑫ 那条的
  正文里合法地写着「发版流程文档里的两个必填 TODO、四步顺序」（它描述的正是 `docs/CONTRIBUTING.md`
  里那两个必填标记）⇒ 一个**已经写完**的版本节被判成「没写」，`check-release` 直接 `exit 1`。
- **改法**：锚改成 bump **真正插入的那串**标记（`TODO` 紧跟 `(发版)`）—— 它由 `release.mjs` 的 `INSERT_OPS`
  集中生成，永远带 `(发版)`。同文件里 `--allow-pending` 的降级判据一并改：否则 bump 后的自检会把
  「正文里正常提到 TODO」当成 pending 警告。
- 这是本仓反复出现的那个形态：**守卫测的东西 ≠ 它想测的东西**。粗判据在「正文恰好提到 TODO」时红，
  而它想拦的只有一种情况 —— bump 插的骨架还没被人填。
- **反向验证 2 条**：① 往 `[0.10.0]` 一节插回那段骨架标记 ⇒ 严格闸门**恰好点名**这一条（`exit 1`）；
  ② 同一状态下加 `--allow-pending` ⇒ 降级为 ⚠ 警告（`exit 0`，bump 后的预期行为）。
  还原后 `sha256` 逐字节一致。
- 影响面：`scripts/release-surface.mjs`（两处判据 + 为什么不能用裸 `TODO` 的注释）、本节。
  `tests/scripts/release-scripts.test.ts` **10/10 仍绿** —— 它的两条断言锚的本就是那段骨架标记
  与「输出含 TODO」，精确化之后照样成立。

### 文档 · 推广稿重写成「可直接发出去的定稿」

- **是什么**：`docs/promotion.md` 此前是**素材清单**（Product Hunt / X / 短版 / awesome 条目 /
  视频旁白，各一段），且口径是「配合 30 秒演示视频」的草稿 ⇒ 真要发的人还得自己组织成文。
  重写为**八节定稿**：发之前自检 / 中文主稿（长文，可整段粘贴）/ 短版 / X 英文线程 /
  Product Hunt / awesome PR 条目 / 视频旁白 / **评论区预设应答（7 条）**。
- 补上此前**缺的两块**：① 中文长稿 —— 旧稿只有英文 PH + 中文短版，中文社区**没有可直接发的长文**；
  ② 评论区预设应答 —— 发出去后必然被问的七个问题（零依赖怎么调模型 / 与 LangGraph·Mastra·
  Vercel AI SDK 的区别 / `0.x` 敢不敢用 / RAG 怎么办 / 为什么不做日志与存储 / 附属包为什么 404 /
  性能），每条都**指回仓内真源**，不替框架总结立场。
- **诚实段落进正文**：主稿第六节就是「我劝退你的部分」，并指向官网 `/tradeoffs` —— 与本节
  ⑱ 那条同源：选型时最有用的不是优点清单，而是作者愿意把劝退条件写在哪、写多细。
- **数字纪律**：稿里**只写**与记分牌同源的下限（三处）与结构性事实（4 个装饰器 / Node 18+）；
  **体积刻意不写** —— 解包体积每次发布都会小幅变，抄进稿里就是第二个会腐烂的副本
  （需要时报 npm 页上的值，或抄 README 顶部那行 —— 那行由守卫现算）。
- **代码块真编译过**：`promotion.md` 不在 `code-fences` 守卫的取样面里（取样面是「对外阅读面」的
  固定清单），但它是**被照抄概率最高**的文档，复制出去后没有任何东西盯着它 ⇒ 用一次性探针
  `.workbuddy/probes/verify-promotion-blocks.mjs` 按同一套 tsconfig（`paths` 指向 `src/index.ts`，
  `strict` + `exactOptionalPropertyTypes`）把两个 `ts` 块（装配 / HTTP 宿主）真编译一遍，全过。
- **反向验证 2 条**：稿里中文、英文各改一处守卫条数 ⇒ 各**恰好点名** `scoreboard` 那条
  （另外两条 README 断言不受影响），还原后 `sha256` 逐字节一致。
- 影响面：`docs/promotion.md`（重写）、本节。

### 官网 · 加一页「取舍对照」（2026-09-29 ⑱，评审 P1-1）

- **是什么**：新页面 `/tradeoffs`（`packages/website/src/pages/tradeoffs.astro` + 片段
  `src/fragments/tradeoffs.html`）。评审要的是「**取舍对照**」而不是「**优势对照**」——
  明写**不做什么**、代价是什么、以及**什么场景该选别人**。
- 六节：定位（刻意只占「运行时 + 可观测」两层）/ **不适用场景** / 刻意不做的事（空白由谁填）/
  代价清单 / 什么时候该选它 / 怎么自己核实。
- **此前对外表达面从来没有「不适用场景」**（实测 `grep -rn "不适用" packages/website/src
  README.md` ⇒ 0 命中）⇒ 读者只能从「它有什么」反推边界，而**反推出来的边界必然比真实边界宽松**。
- 页面里每一条「不做」都**指回仓内真源**（`spec.md` §9.3「已锁定」/ `usage-guide.md` 的判据 /
  `no-runtime-deps.test.ts` / `examples/grpc-host/`），不替框架总结立场 —— 与 `deployment.md`
  同一条口径：**决定清单 + 指回真源**，每多抄一份正文就多一处会分叉的口径。
- **守卫** `tests/docs/tradeoffs-page.test.ts`：页面与片段在 / 含「不适用场景」节（评审验收点）/
  导航 + sitemap + llms.txt **三处都登记**（Nav 要求 ≥2 —— 首页与非首页分支各一个）/
  正文站内锚点真实存在 + 自证。**反向验证 4 条，各恰好点名**，还原后 `sha256` 逐字节一致。
- 影响面：新增 2 个页面文件、`Nav.astro`、`sitemap.xml.ts`、`llms.txt.ts`、
  `tests/docs/tradeoffs-page.test.ts`（新）、`docs/guards.md` §1.4、本节。

### 文档 · 推广稿的「50+ 条守卫」改成现算值并纳入守卫（2026-09-29 ⑰，评审 P1-2）

- **是什么**：`docs/promotion.md` 三处写着「50+ invariants / 50+ registered invariants /
  50+ 条守卫」，而 `docs/guards.md` §1 实际是 **99 条** ⇒ **自贬**，而且是那种**没人会发现**
  的自贬（推广稿不是测试、没有门禁）。改成与 README 记分牌同源的下限 `90+`。
- **光改一次不够** ⇒ 一并纳入 `tests/docs/scoreboard.test.ts`（推广稿是最容易「抄一次就
  再也不更新」的文本：发完就没人回头核）。只钉「守卫条数」这一个数 —— 推广稿里其余数字
  （4 个装饰器 / Node 18+）是**结构性事实**，改了就是产品变了、不是腐烂。
- 文件头加了一句「这个数别手改 + 发之前跑 `npm test`」，且**刻意不写那个数**（多写一处就
  多一处要同步，而它恰恰是会被守卫点名的字面量 —— 这条是被变异验证逼出来的，见 guards.md）。
- **反向验证 7 条**（原 4 条 + 推广稿三处各改一处，各恰好点名），还原后 `sha256` 逐字节一致。
- ⚠️ 评审 P1-2 的另一半是「**执行** promotion.md（发到 Product Hunt / X / V2EX 等）」——
  那一步要账号与发布时机，**不是代码能做的**，留给仓库所有者。
- 影响面：`docs/promotion.md`、`tests/docs/scoreboard.test.ts`、`docs/guards.md` §1.4、本节。

### 文档 · 五个 bench 的数字对外 + 三面守卫（2026-09-29 ⑯）

- **是什么**：`README.md` / `README.en.md` / 官网 docs 页各加一节「性能量级」，把仓里五个
  基准（`scripts/bench-*.ts`）的读数搬出来 —— 此前对外文档面**一个性能数字都没有**。
  每个数都配了**形状结论**（差多少倍 / 往返几次 / 哪一笔跟什么成正比）与**复跑命令**。
- ⚠️ **这一节的射程要如实说清**：五个基准是**计时类**的，本仓早就定了「不进 verify-all / CI，
  要看时跑」（`docs/plans/2026-09-22-dev-debug-loop.md`）⇒ **毫秒数守不住**（机器一换就变、
  且零信号），守卫也**刻意不去跑基准**。所以表格里明确写着「**毫秒不是承诺**」。
  真正恒定的是**形状**（常驻 runner 换能力选择只付 ≈8 ms 而非 ≈4 s ⇒ ~500×；MCP 冷 280 ms /
  热 0.3 ms ⇒ ~900×；sqlite 到期索引 0.1 ms vs 全表 62 ms ⇒ ~600×；trace 不截断是大出参档的
  13.6×、小出参档只差 1.0× ⇒ 代价**按出参字节**计）。
- **守卫守的是「读者能不能自己复算出那一列」**：五个基准每个都有可跑的复跑命令且脚本真实
  存在 + 三面都写了「不是承诺」+ 三面都写了「刻意不进 CI」+ `BENCH_SCRIPTS` 与 `scripts/` 目录
  双向相等。**反向验证过 5 条，各恰好点名**，还原后 `sha256` 逐字节一致。
- 影响面：`README.md`、`README.en.md`、`packages/website/src/fragments/docs.html`（+ 侧栏锚点）、
  `tests/docs/bench-numbers.test.ts`（新）、`docs/guards.md` §1.4。**框架代码零改动。**

### 文档 · `docs/deployment.md` 上线清单 + 守卫（2026-09-29 ⑮）

- **是什么**：从「跑通 demo」到「推上生产」之间那篇文档 —— store 选型（含「单宿主写者」前提）、
  鉴权边界（`/healthz` 与 `/metrics` 不鉴权）、优雅停机的四步顺序（宽限 > drain 超时 > store 后关）、
  预算旋钮、多副本写路径协调、回滚（含「旧代码读新数据不保证」的如实口径）、§10 上线自检复选框。
- **三条口径**：只做「决定清单 + 指回真源」，不重复 usage-guide §7 与 `examples/deploy`；
  每条来自已核实的仓内事实（`redisStore.ts` 头注 / `record.ts` 读时归一层），不是通用模板；
  完备性由 `tests/docs/deployment.test.ts` 守（节骨架 / 路径真实 / 五个事故级机制词 /
  「不鉴权」如实锚 / 复选框下限；5 条变异反向验证）。

### 变更 · 加 `exports` 字段：公开 API 边界从「文档承诺」变成「机制」（2026-09-29 ⑭）

**可观测面变更**（`0.x` 期间 minor 可含破坏性变更 —— 你要做的动作写在下面「迁移」一节）。

**起因**：「上生产 × 推广」评审的 `P2-2`。`README.md` / 官网的「稳定性与版本策略」节早就写明
「**不**承诺深路径导入（`dist/**`）」—— 但两个**已发布**包的 `package.json` 里**没有 `exports`
字段**，于是那句话是一句**没有机制的话**：2026-09-29 实测 `import('@migor/agentia/dist/index.js')`
**真的能进**（`require('@migor/agentia')` 也照常拿到 81 个导出）。任何一个这么写的使用者都会把
内部模块路径当成 API —— 一次重构就把他打碎，而且**没有任何信号**。这正是本仓反复记的那个形态：
**承诺写在文档里、没有门禁**（`docs/guards.md` 头注）。

**改动**：

- `@migor/agentia` 新增 `exports`：根入口 `{"types" → ./dist/index.d.ts, "default" → ./dist/index.js}`
  （`types` **排第一** —— TS 按书写顺序匹配条件）+ `"./package.json"`；
- `@migor/cli` 新增 `exports`，**只放开 `"./package.json"`**。

**为什么用 `default` 而不是 `import` / `require` 两条**：本包**只有 ESM 一种产物** —— 写两条会暗示
存在 CJS 构建。`default` 同时接住 `import` 与 `require`（后者靠 Node 的 `require(esm)`），
**行为与改动前逐字一致**（Node 18 上照样是 `ERR_REQUIRE_ESM`）。

**为什么 `@migor/cli` 的 `exports` 只留 manifest**：它的公共面是**可执行文件**（`bin.agentia`），
不是模块 —— 入口 `packages/cli/src/cli.ts` 末尾是 `process.exitCode = main(process.argv.slice(2))`
（**顶层副作用，没有 main 守卫**）⇒ 给 `"."` 等于承诺「import 这个包会直接跑 CLI」。只留 manifest
（工具读清单的常规请求），其余封死。

**守卫** `tests/architecture/package-exports.test.ts`（登记 `docs/guards.md` §1.4）：四类判据 ——
① 两个已发布包都声明 `exports` 且放开 `./package.json`；② 根入口 `types` 排第一、目标与顶层
`main`/`types` 指向同一文件（`./` 前缀归一后比较 —— 两侧写法天然不同）；③ 除根入口与 manifest 外
**不开放任何子路径**，且目标都在 `./dist/**`（源码不进 tarball）+ `files` 含 `dist` 的自证；
④ **真解析**：自建临时夹具（真 manifest 的逐字拷贝 + 占位文件）用 `require.resolve` 跑一遍 Node
的解析算法 —— 根入口/manifest 必须解析成功、深路径必须报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
⚠️ 刻意**不用符号链接指向仓库**（那会让夹具依赖 `dist/` 已构建，且批量删会被环境的安全删除垫片拦下）。

**反向验证 5 条（各恰好点名，还原后 `sha256` 逐字节一致）**：摘掉根包 `exports` ⇒ 四条全红；
`types` 挪到 `default` 之后 ⇒ 只红「types 排第一」那条；加一条 `"./dist/*"` ⇒ 红「不开放子路径」+
「真解析」；CLI 摘掉 `./package.json` ⇒ 红 ①③④；把 `default` 指到别的文件 ⇒ 红 ②④。
（①②③ 是**文本**判据、④ 是**行为**判据 —— 后者是前者的兜底：`exports` 的错法有一半是形态对、
指向错。）

**实测（真发布形态：真 pack → 真装进空项目 → 真跑）**：`import`/`require` 根入口各 **81 个导出**
（与改动前**同数** ⇒ 导出面零变化）；`require.resolve('@migor/agentia')` → `dist/index.js`；
`@migor/agentia/package.json` 与 `@migor/cli/package.json` 可解析；`@migor/agentia/dist/index.js`、
`@migor/agentia/dist/engine/loop.js`、`@migor/cli`、`@migor/cli/dist/cli.js` **四条全被拒**
（`ERR_PACKAGE_PATH_NOT_EXPORTED`）；装出来的 CLI `cli.js --version` 与 PATH 上的 `agentia --version`
都是 `0.9.5`（bin 解析不经过 `exports`）。CI 的 `scripts/e2e-cli.ts` 第 9 步本来就在跑这条链。

**迁移**

只有一种情况需要你动手：**你 import 过 `@migor/agentia` 的深路径**（例如
`import … from '@migor/agentia/dist/engine/loop.js'`）。改成从根入口导入 ——
公开面一直是 `src/index.ts` 的具名导出，深路径**从来不在承诺范围内**，只是此前没被封。

```ts
// 改前（现在会抛 ERR_PACKAGE_PATH_NOT_EXPORTED）
import { runAgent } from '@migor/agentia/dist/engine/loop.js';
// 改后
import { runAgent } from '@migor/agentia';
```

`@migor/cli` 是**命令行工具**，不受影响。读清单的 `…/@migor/*/package.json` 也照旧可用。

**登记**：`docs/guards.md` §1.4、`docs/spec.md` §10 ⑭。

### 文档 · README 顶部加「实测记分牌」——数字一律脚本现算（2026-09-29 ⑬）

**使用者可见行为零变更**（README 顶部一行 + 一条新守卫）：框架代码**零改动**。

**起因**：「上生产 × 推广」评审的 `P0-2` 与它引用的那条外部判据 —— 当前最大的选型陷阱是
**GitHub star bias**（「为了 50 行的问题上一个重型多层框架」）。本仓的答案正是
「**1 个包 / 0 运行时依赖 / ≈2 MB**」，而这个数字 `grep -nE "2\.7|1 个包" README.md` ⇒ **0 命中**：
README 里只有形容词「零依赖」。**形容词不参与比较，数字才参与。**

**改动**：`README.md` 与 `README.en.md` 的品牌句之后各加一行记分牌
（`**1 个包 · ≈2 MB · 0 运行时依赖 · 90+ 条守卫**`），并新增 `tests/docs/scoreboard.test.ts`
（登记在 `docs/guards.md` §1.4）把它钉住 —— 评审原文要求「**必须脚本现算，不许手写**」。

**三条口径（都不是随手定的）**：

1. **「会涨的数」用下限**（`90+ 条守卫`，断言 `count >= 90`）—— 精确值会让「每加一条守卫都要改
   README」成为绕开守卫的理由（本仓已知的失效模式）；下限是可机械复算的，且只在**掉下来**时咬人。
2. **体积按「四舍五入到整数 MB」判定**，让数字**自带精度**：`≈2 MB` 覆盖 1.5–2.5 MB；
   写 `2.1 MB` 会因几十 KB 的正常增长而红 —— 那不是信号，是噪声。
3. **不把 `usage-guide §7` 的已知边界条数搬上来**：那个数已有专属守卫（`boundary-table.test.ts`
   的行集合对拍 + 三处读数断言），再放一份 = 造**第二个会腐烂的副本**，且两处口径必然分叉
   （§7 首列是散文，归一化规则只为那张表定义）。

⚠️ **先定口径再写数**：评审里那个「2.7 MB」量的是 `du -sh node_modules`（含文件系统块分配），
而 npm 页上显示的是 `dist.unpackedSize`（`npm pack --dry-run --json` 现算 = **2.10 MB**）。
两者差 ~30% ⇒ 数字落纸之前**必须先选口径**，否则记分牌自己就是一句不可比的假话。

**代价如实标注**：`npm pack` 在本机约 **11s**（I/O 为主，`--offline` / 关 notifier 都压不动）
⇒ 守卫里**记忆化**，整轮只真跑一次。**不用自己遍历 `dist` 加字节**：实测差 ~1.5%
（自己数 2.08 MB vs npm 2.10 MB），而复刻 npm 的选文件规则（`files` 与 `.npmignore` 的交互）
是一件会静默失准的事。

**登记**：`docs/guards.md` §1.4、`docs/spec.md` §10 ⑬。
### 工程 · CI 的 Node 上沿跟到当前 LTS + 补上发版流程文档（2026-09-29 ⑫）

**使用者可见行为零变更**（CI 配置 + 文档）：框架代码**零改动**。

**起因**：「上生产 × 推广」评审里那条 `A2` —— **CI 的上沿停在 Node 22，而当前 LTS 已经是 24**。
当时的 README / README.en / CONTRIBUTING / `usage-guide.md` 四处都写着「CI 在 18/20/22 上守」：
**那句话是真的**，问题是①上沿没跟 LTS 走；②**没有任何东西盯着这四处散文**（矩阵一改就静默腐烂）。

**改动**：`.github/workflows/ci.yml` 里四个主 job（`verify` / `lint` / `e2e-mcp` / `deploy-website`）
的 `node-version` 由 `'22'` 改成 **`'24'`**，并把**覆盖规则**写进 ci.yml 顶部：
`import-floor` 的 matrix 只覆盖 `engines` 声明的**下限**，其余 job 跟**当前 LTS** 走
⇒ 覆盖集合 = **18 / 20 / 24**；四处散文同步改成这句（`docs/usage-guide.md` 的已知边界表也复述了一处）。

> ⚠️ **为什么不顺手把 24 加进 `import-floor` 的 matrix**：**matrix 取值会进必需检查名**
> （分支保护里现在钉的是「导入下限（Node 18）」与「（Node 20）」）。增删取值 = 改仓库的分支保护配置，
> 否则新取值那条不是必需检查、旧取值那条永远等不到。所以「跑下限」与「跟上沿」**刻意分成两件事**，
> 并把这条坑写在 ci.yml 顶部（此前只写在 `AGENTS.md` 的会话记录里）。

另：`publish` 目前仍是**本机手动**两条命令（顺序「发布 → 合并 → 打 tag」，理由见 `release.mjs` 头注）。
`npm publish --provenance` 只支持在 CI 里生成 ⇒ 本轮**没有动它**，作为独立议题留下（要动就要在
GitHub Actions 里加发布工作流 + 一个仓库 secret，那是仓库所有者的运维决定）。

**补文档**：`CONTRIBUTING.md` 新增「**发版流程**」一节（`release.mjs bump/tag` 两条命令、
两个必填 TODO、四步顺序与**为什么不能换**、以及几条纪律）。此前 CONTRIBUTING 里
`grep -niE "release|发布流程|version"` ⇒ **0 命中** —— 一条对外可见的流程却没在任何面向人的文档里。

**登记**：`docs/spec.md` §10 ⑫。
### 文档与守卫 · 把「对外承诺」变成可执行的断言（稳定性策略 / 三个不发布的包 / CI 运行环境）（2026-09-29 ⑪）

**使用者可见行为零变更**（纯文档 + 一条新守卫）：框架代码**零改动、零新依赖**。

**先说结论（三次误报的定性收口）**：`@migor/trace-view`、`@migor/agentia-observability`、
`@migor/agentia-eval-gate` **三个都不发布到 registry** —— 三个 `package.json` 都是
`"private": true`，**这是机制、是刻意的**（`roadmap.md` 早已写明「不进 npm，不是待修项」；
`eval-gate/README.md` 写明「这是宿主的发布流程，框架不内建」）。⇒ 正确动作不是「发布它们」，
而是**把文档口径补齐、再用守卫钉住**。

**新增 `README.md`「稳定性与版本策略」节**（+ `README.en.md` 对应节 + 官网 docs 页 `id="versioning"` 一节）：

- **`0.x` 的变更策略**：minor 可以含破坏性变更，但**必须留痕** —— `CHANGELOG.md` 对应版本里
  至少要有一段专门写它（小节标题含「迁移」或「破坏性变更」），写清「你要改什么」。
  ⚠️ **如实标注**：这条纪律是**逐步收紧**的 —— 同一个意思历史上有三种形态（`### 迁移` /
  `### 破坏性变更 · …`（`0.9.0` 脚手架模板）/ 行内 `**迁移**：无`（`0.8.1`~`0.8.3`）），
  所以文档给的枚举命令是**下限**而非全集。
- **承诺范围的四行表**：公共 API（`src/index.ts` 的具名导出 / CLI 命令行面）· 行为（以「迁移」小节为界）·
  运行环境（`engines.node` + CI 覆盖的每个版本）· 依赖（运行时零第三方依赖，有守卫）——
  各自对应「**不**承诺什么」（深路径导入 / `examples/*` / Deno·Bun·edge / devDependencies）。
- **1.0 的三条门槛**：`spec.md` §11 开放项逐条落地或明确划掉 · `guards.md` §2「待守」清空 ·
  公共导出面连续 3 个 minor 无破坏性变更。
- **刻意不写死数字**：不用「N 个版本里只有 M 个带迁移小节」这种会腐烂的读数，改为给
  **现数命令**；而**那条命令本身也由守卫自证**（必须真在 `CHANGELOG.md` 上跑得出结果 ——
  文档给一条零命中的命令，效果与写错数字一样）。

⚠️ **落地前回源核对抓到的真错**（写下来是因为它就是「为什么会有那条命令自证」的由来）：初稿写的是
「**没有「迁移」小节的版本，就是不需要你改代码的版本**」，配 `grep -nE '^#{3,4} .*迁移'` ——
**这句话是假的**：同一个意思历史上有三种形态（`### 迁移` / `### 破坏性变更 · …`（`0.9.0`）/
行内 `**迁移**：无`（`0.8.1`~`0.8.3`）），只认第一种会漏掉 `0.9.0`（**它真的有破坏性变更**）
与 `0.8.2` 那句「唯一需要动作的是 `maxRetries`」。⇒ 改成「至少要有一段专门写它」+ 如实标注
「这条纪律是逐步收紧的、那条命令是下限」，并顺手把**命令的非空**也钉成断言。

**补齐「怎么拿到它」（此前只有 observability 一支写全）**：`examples/eval-gate/README.md` 与
`docs/eval-gate.md` 现在都明写「**没发布到 registry，`npm i` 会 404**；把目录拷进工程、以
`"file:…"` 引入，或直接照 `src/gate.ts` 抄走」；`examples/observability/README.md` 也在自己的
文档里复述了 404（此前只说「沿用 `trace-view` 的同一套办法」）。

**新增守卫** `tests/docs/stability.test.ts`（登记在 `docs/guards.md` §1.4）：

1. **不发布的包不得漏写口径** —— 扫 `根 + packages/* + examples/*` 的 `@migor/*` 包，
   `private: true` 的集合与文件内的登记表**双向相等**（幽灵与漏登都报；`@migor/website` 走
   带理由的豁免），再逐包断言 `private === true` + 入口文档写了「不发 npm」+ 写了「怎么拿到」；
2. **稳定性承诺三面互为镜像** —— `README.md` / `README.en.md` / 官网 docs 页各抽节，断言同一组
   承诺锚点与 1.0 的三条门槛都在（三面**刻意各写一份**，代价由这条守卫兜底）；
3. **CI 的 Node 集合 == 四份文档写的集合** —— 从 `ci.yml` 抽实际值（matrix + 各 job 的
   `node-version`），与 `README.md` / `README.en.md` / `CONTRIBUTING.md` / `docs/usage-guide.md`
   里复述的那串版本号**集合相等**，并断言 `engines.node` 的下限**真在 CI 里被跑到**；
   `usage-guide.md` 是权威文档，它的 §7 已知边界表复述了同一句话 ⇒ 射程覆盖它才算数；
4. **文档里那条「数一数」命令必须真跑得出结果** —— 给一条零命中的命令，效果与写错数字一样。

**反向验证 6 条**（各恰好点名）：版本句改 `18/20` ⇒ 只剩集合相等那条红；eval-gate 摘
`private` ⇒ 集合相等 + 机读 private 两条红；官网节改名 ⇒ 三面镜像三条红；eval-gate README
**整段**摘掉「先看这条」⇒ 只红「入口文档说了不发 npm」那条；那条「数一数」命令改成零命中
⇒ 只红命令自证那条；`usage-guide.md` 的复述处改成 `18/20/21` ⇒ 红「四份文档 == ci.yml」
那条（把射程从三处扩到四处时补做的 —— 扩射程必须配一次变异）。

⚠️ **一条教训**：④ 的**第一版变异只删掉一句、结果全绿** —— 同一件事在那一节里出现不止一次
（「不发布的包」/「别 `npm i`」）。**变异要摘干净**，否则测的是「这个词还在不在」，
不是「这件事还说没说」。

**登记**：`docs/guards.md` §1.4、`docs/spec.md` §10 ⑪。

### 测试与工具 · 补上「完整装配 × 时间维度」这一格 + examples 清单守卫（2026-09-29 ⑩）

**使用者可见行为零变更**（新增一个手跑脚本 + 一条新守卫 + 一处文档订正）：框架代码**零改动**。

**起因**：竞争力评审里那句「没有一个基于框架的复杂 demo 长期运行验证」，查下来**一半对** ——
长期运行验证**有**（`scripts/e2e-soak.ts`，2 小时档实测 811 万请求、内存有界与否皆有断言），
完整装配的 demo 也**有**（`examples/complete`），但**两者的射程不重叠**：`e2e-soak` 的 import 面
只有 `createOpenAIClient` / `metricsSink` / `runAgent` / `AgentTool`（**无** createApp / 容器 /
store / scheduler / AsyncRunner / 恢复扫描）⇒ 压的是**无状态单点**；而跑完整装配的
`e2e-examples` 是**线性脚本、只跑一轮**。⇒ **「完整装配 × 时间维度」这一格是空的。**

**新增 `scripts/e2e-soak-app.ts`**（`npm run e2e:soak:app`；黑盒——只走 HTTP 与子进程，
不 import 框架）：起 `examples/complete` 的 dist + 本地假 OpenAI 端点（五类故障注入），
中途用假端点**闸门**把任务精确停在 running 再 SIGKILL。七条断言：不丢（全到终态）/ 不重
（幂等簿记）/ 猝死续跑（同库重启真把活干完）/ 故障按比例落地 / 定时触发真在派 / 干净退出 /
DB 每任务字节数有界。

**读数**（30s × 6 并发）：4452 个任务**全部终态**（succeeded=4286 / failed=166）、**零 stuck**、
幂等簿记准、猝死续跑 5 个且都跑完、故障对账 **335 vs 336**、DB **39.1MB**（≈ 9.0KB/任务）。
8s 短档**重复跑 3 次**同样全绿 —— 参见下面那条关于「抖动」的说明。

⚠️ **一条比判据更值得记的事：变异验证全过，也不等于断言可靠。**
初次落盘时 5 条变异全部「各恰好点名那条」，看着已经足够扎实；但其中 ③（闸门任务续跑后
必须 `succeeded`）是**概率性**的 —— 续跑那次模型调用仍走故障注入，3% 的不可重试 400 抽中就
假红（30s 首跑绿是运气）。**8s 档重复跑**时才抓到。⇒ 修法：给假端点加 `pauseFaults()` /
`resumeFaults()`，**只**在「等闸门任务跑完」那一小段关掉注入（判的是恢复，不是运气），并补一条
**自证**：窗口之后注入数必须高于窗口前读数，否则「忘了重开」会让阶段 B 静默变成无故障负载。
阶段 A / B 的几千个请求照旧吃满注入，④ 在那里对账 —— **注入机制的存活性没有因此放松**。

⚠️ **两条判据上的新认识**（都写进脚本头注；依据不同，别混写）：
① 装配层里「一个不可重试故障**恰好**杀死一个 run」**不成立**——依据是**代码语义**（子能力的失败
由能力层包成 `is_error` 回主循环、**不杀 run**，见 `src/engine/loop.ts` / `src/engine/spec.ts`；
本例装配里真有子 agent 与 skill，而假端点服务的**所有**模型调用都可能是 400），再加上猝死窗口内
被续跑成功的任务会把那次失败洗掉 ⇒ 本脚本用量级判据，**不是** `e2e-soak` 那种逐笔对账
（实测 335 vs 336 已经很接近，但**接近不等于恒等**，不该断言恒等式）；
② 故障注入是**按请求**的，而请求同时来自同步 `/run` 与异步任务 ⇒ **两边都要统计**——这条是
**实测**出来的：只对账异步那一半会得出「注入数 > 失败数」的假结论（首跑 129 vs 267 就是这么来的）。

**顺带修掉一处腐烂读数**：`examples/README.md` 那张表**此前零守卫**，已烂成三个互不相同的
读数——文案写「四个示例」、表 5 行、目录 6 个（`eval-gate` 整行缺席）；依赖说明那段的
「三个应用示例」也对不上实况（六个**全部**在用 `file:../..`）。已补齐，并**不再写死数字**。

**新增守卫** `tests/docs/examples-table.test.ts`：表 ↔ 目录**双向相等** + 每行链接指向真实目录
+ 条目密度下限（解析器退化成 0 行时红）。反向验证 2 条（删掉 `eval-gate` 那一行 / 加一行幽灵
目录），各恰好点名那条。

**登记**：`docs/guards.md` §1.4 两行（含反向验证读数）、`docs/spec.md` §10 ⑩。

### 测试与文档 · 文档围栏代码块真编译（竞评收官：换尺子）+ 三处「照抄会坏」的片段修正（2026-09-29 ⑨）

**使用者可见行为零变更**（纯文档 + 一条新守卫）：框架代码**零改动**。

**发现方式**：产品竞争力评审走到「说不出还有什么缺口」时换的尺子 —— 不再问「缺什么」，
改问「**已经写下来的东西是不是真的**」，取样对象取**代码围栏块**（读者会逐字照抄），
因为它**恰好不在既有守卫面上**（`usage-guide.test.ts` 只收表格行、`run-output-shape.test.ts`
只钉 `.finalText` 一种形状）。实测：88 个围栏块 / 22 个含具名导入的 ts 块 ⇒ **3 个照抄坏掉**，
且**没有任何一条是新引入的 —— 是从未被检查过**：

1. `README.md` 的 `scheduler.every(60_000, '巡检一次', { idempotencyKey: 'patrol' })` ——
   `ScheduleEveryOptions` 里没这个键，真名是 **`idempotencyPrefix`**。TS 报 `TS2353`；
   **JS 用户静默无幂等**，而示例上方那句注释正写着「幂等键去重」。⚠️ 同一块上一行的
   `runner.submit(…, { idempotencyKey })` 是**对的** —— 两个同名旋钮，一个在一个不在。
2. `docs/usage-guide.md` 的 `ctx!.deferUntil(due)` —— `ToolRunContext.deferUntil` 是**可选成员**，
   `!` 只消掉了 `ctx` 的 null ⇒ `TS2722`；改为 `ctx?.deferUntil?.(due)`。
3. `docs/usage-guide.md` 的出站传播片段是**裸方法**（`@Tool` 挂在函数声明上 + 漏必填 `schema`）
   ⇒ **不是合法 TS、无法被任何编译器检查**；补成完整的 `class OrderTools { … }`。

**新增守卫** `tests/docs/code-fences.test.ts`：把「含 `@migor/agentia` 具名导入」的 ts 块落成文件、
**一次性交给 `tsc`**（`paths` 指向 `src/`，不依赖先 build，约 0.3s）。三条反假阳性机制缺一不可 ——
① **语法错会连坐**：实测 `tsc 7`（tsgo）只要程序里存在语法错误就**整体跳过语义阶段**（22 个块只报
3 条语法错、其余全被吞 ⇒ 守卫会变成静默全绿），故迭代摘出语法错的块并**断言摘掉数为 0**；
② **省略垫片**（吃掉「名字不存在」、吃不掉「类型形状不对」）；③ **省略记号归一成展开 any**
而不是空容器（后者会造出守卫自己的假阳性）。另有**金丝雀**（故意写错的块必须被报出来）与
**取样下限 20** 两条自证。

**验证**：4 条变异各恰好点名那条（两条真错各 1 条 + 裸方法 1 条 + 金丝雀自证 1 条），
还原后 `sha256` 逐字节一致。`docs/guards.md` §1.4 登记一行、`docs/spec.md` §10 ⑨ 记决策。

**顺带订正一处腐烂读数**：`docs/observability.md` 的日志层那格原写「2026-09-15 实测 9 处
`console.error/warn`」，现测 **22 处（散在 12 个文件）** ⇒ 不再写死数字，改为给现数命令
`grep -rn "console\." src/`。

**如实记**：`usage-guide.md` 里 `from '@migor/agentia-observability'` 的块首次对拍曾报 `TS2307`，
但它是**按设计的配方**（`docs/observability.md` 已明写「`npm i` 会 404，这是本地小包」，
`examples/observability` 真有那些导出）⇒ **不计为缺口**，守卫按 `tsconfig.tests.json` 的
`paths` 映射过去，不再误报。

### 测试与文档 · 时钟回拨下三条时间判据的退化方向（`DEEP-AUDIT` §3.4 的 L0 补栏）（2026-09-29 ④）

**使用者可见行为零变更**（纯测试 + 文档）：`tests/transport/{approval-policy,wake-policy,resume-policy}.test.ts`
各补一组「NTP 回拨」用例（共 6 条），钉住三条时间判据在回拨下的**退化方向**；`docs/guards.md` §1.2
登记一行；`docs/spec.md` §10 ④ 记决策。同轮把 `docs/reviews/2026-09-28/README.md` §4 原来那句
「它是本仓**质量门禁**的下一步来源」**订正为「测试策略」**（那两节盘点的是测试覆盖缺口，不是闸门待办），
并把四栏逐栏判过：L0 补用例（本轮）、L1 已由抽件红利覆盖、**L2 定时器注入缝记为「有意不做」**、
L3 是「运维化」而不是「门禁化」。

- **为什么值得记**：三条判据里 `resumeSkipReason` 的**新鲜度档**是回拨下**唯一一条让系统更不安全的
  方向** —— `too-fresh` 变长 ⇒ 判不了主人（异主机 / 升级前旧格式 ownerId）的崩溃孤儿**饿死窗口
  ≈ 回拨幅度**（扫描是惰性的，扫不到就再没人扫）；而 `approvalExpired` / `timerDue` 只是**推迟**
  （等更久 / 睡更久）。另一条纪律被钉住：`fillTimeoutDenials` 的 `decidedAt` **可以早于**
  `requestedAt` —— 判据层**不许**把负差值钳掉，钳掉回拨就从 trace 上消失了。
- **验证**：6 条用例 + **5 条变异**逐条亲跑点名（`git checkout --` 还原后 `sha256` 逐字节一致）。
  ⚠️ 其中两条新用例**如实记为不独立**（会同时打红既有用例），已写进用例头注与 `guards.md`。
- **有意不做**：`AsyncRunnerOptions` 上的 `now()` / `timers` 注入缝 —— ① 半假时钟比不注入更坏；
  ② 整链可注入是一次跨编排层的时钟抽象（全仓 `Date.now()` 39 处），不是加个可选参数；
  ③ 判据是「先有病例，再有设备」。

### 测试与工具 · soak 的错误分类判据改成穷尽表（2026-09-29 ⑤）

**使用者可见行为零变更**（判据 + 新导出常量）：`src/engine/errors.ts` 新增
`ERROR_TYPES` / `ErrorType`（`classifyError` 的返回类型收窄成 `ClassifiedError`，**不改运行期
行为**；`SpanError.type` 仍是公共类型上的 `string` —— 收紧它才是破坏性变更，没做）。

**这一条是「把 2 小时 soak 真跑起来」拿到的第一份结果，而且那轮是红的** —— 红的是**判据**：

```
AssertionError: 存在未知错误分类：connection
run：total=7189536 failed=325235（4.52%）thrown=0，吞吐 998.5 run/s
端点：requests=8114503 …  内存：heap 61.6MB → 69.6MB，rss 峰值 204.7MB（27 个采样）
```

`e2e-soak.ts` 的断言里手写着一份三名字白名单（`api` / `server` / `rate_limit`），漏了框架
自己的合法类 `connection` —— 719 万 run 里它出现 **1 次**，默认 60 秒的跑法永远撞不到。
现在判据单源化：`scripts/soak-error-posture.ts` 的 `SOAK_ERROR_POSTURE` 是
`Record<ErrorType, 规则>` 穷尽表（加一类不表态 ⇒ `TS2741`，每条必须写 `why`），
`soakErrorVerdict` 对**表外一切**判 `hard-red`；`unknown` / `aborted` / `timeout` 判红，
注入的四类允许但**分类计数打印出来**（允许 ≠ 不看）。

- **验证**：9 条用例（`tests/scripts/soak-error-posture.test.ts`，**不跑 soak 本体**）+ **6 条
  变异**逐条亲跑点名，还原后 `sha256` 逐字节一致；短档 20s 实测全过且新打印行在场。
- ⚠️ **一条命令教训**：处置表在 `scripts/`，而根 `tsconfig.json` 只 include `src` ⇒ 守它的是
  `npm run typecheck:tests`。第一次跑变异拿 `typecheck` 验，结果是**假绿** —— 已写进头注并补
  承重条件用例。

### 修复 · 外部深评施工收口（7 条 + 施工中新发现的第 8 条）+ §7 边界表回填 + 官网注入已知边界表（2026-09-29 ⑥）

**来源与性质**：`FIX-READINESS-2026-09-29.md` 给出的施工顺序 1–7（A1 / D1 / B1 / C1 / F1 / F2 / F3
+ 结构建议① + 官网建议①③），外加施工中**实测发现的第 8 条 C5b**。本轮的共同点仍是前几轮那条：
**把静默换成有声，把判据换成真能咬人的那种**。结构建议②（`async.ts` 抽审批监督簇 + 行数上限闸）
按该报告 §8「各自独立 PR」另起一轮，**未随本批**。

**使用者可见行为变更（4 处，均为「静默 → 有声」或判据更准）**：

- **构造期拒 `NaN` 上限（施工中新发现，C5b）**：`src/core/limits.ts` 的 `BadValuePolicy` 新增第 5 类
  `'rejects-nan'`，`BudgetGuardOptions.maxTotalTokens` / `maxCostUsd` 由 `'none'` 改用它；
  `src/engine/budget.ts` 加 `assertNotNaN`（抛 `RangeError`）。**为什么必须**：闸的判据是 `used > max`，
  而 `x > NaN` 恒为 `false` ⇒ 传了 `NaN` 的闸**静默失效**，方向与「设了个上限」正好相反。
  0 / 负数 / `±Infinity` 仍照旧放行（各有语义），**只拒 `NaN`**。
- **容器注入判据从「有 `then`」改为「`instanceof Promise`」（D1）**：`src/container/container.ts`。
  原判据会**误伤** knex / mongoose 的 query builder —— 实证两者的 builder **同时**带 `then` 与 `catch`
  （knex `builder-interface-augmenter.js`；mongoose 官方文档明列 `Query.prototype.catch()`），
  所以「`then` 且 `catch`」这个加固方向**无效**；而「忘了 `await`」的产物恒为原生 Promise ⇒
  `instanceof` 精确命中且不误伤。**如实边界**：跨 realm 的 Promise（vm 产物）会漏，已写进注释；
  逃逸口 `useValue: { promise }` 保留。
- **`RedisTaskStore.close()`（C1）**：`src/store/redisStore.ts` 的 `RedisLike` 加 `quit?(): Promise<unknown>`，
  `RedisTaskStore` 新增**幂等** `close()`（无 `quit` 则 no-op；重复关闭 / 已断连时的 reject 都吞掉）。
  取 `quit` 的理由：它是 ioredis / node-redis **唯一共名**的关闭出口（node-redis v5 起标 deprecated、
  后继 `close()`，已写进接口注释）。**框架仍不主动替你调**（store 可能共享，drain 不关 store）。
- **记忆水合失败的两条 warn（A1）**：`src/runtime/run.ts`。① 水合 `load` 抛错不再无声吞
  （`catch {}` → `console.warn`）；② `flushMemory` 的 CAS 分支开头判 `rev === undefined` ⇒
  **跳过 CAS 回写**并说真话（「这一次读失败了」≠「并发抢写」）。**为什么**：能走到该分支的 store 必有
  `loadWithRev`（成对性由 `assertMemoryStoreShape` 入口保证），所以此处 `rev === undefined` ⟺
  水合失败；旧代码把它夹带到几十行之后的 CAS 回写、归因成并发 —— **查错会一开始就查错方向**。

**测试与文档（使用者可见行为零变更）**：

- **F3**：删 `tests/toolkit/capability-slice.test.ts` 的恒真断言（源码里 `CAPABILITY_KINDS = Object.keys(KIND_SPEC)`，
  那句是 `x === x`）；保留精确键序断言与 #184 的 `TS2741` 穷尽护栏 —— 删了不降低任何防线强度。
- **F2**：`AGENTS.md` 的 toolkit 段补 `capability-cycles.ts`（`841f2ac` / #170 引入、地图漏了）；
  新建 `tests/architecture/toolkit-map.test.ts` —— 判据是**「露名或显式豁免」**（实证「全量穷尽」不可行：
  `src/toolkit/` 13 个文件里 9 个用**概念词**覆盖而非文件名词，属正常）；两条用例（未登记集合必须为空 +
  F2 当事人必须被点名），已登记 `docs/guards.md` §1.1。
- **`AGENTS.md` 结构数字**：`:66` 区域「910 行的类」→ **1554 行**，并注「计划写于 09-20（当时 895 行），
  后续三步一步没走，类反长 115%」—— 这类**写死的读数会腐烂且无守卫**，改到结构时顺手改真值。
- **B1**：`src/transport/task-events.ts` 两处注释订正（零行为变化）—— `:204` 那句「**不会**回收刚 push
  的这条」是**假的**（单热流场景下若真跳过它，候选集恒空 ⇒ 配额完全失效 ⇒ 无界增长，比现状更坏；
  故取「改注释」而非「改行为」）；`#recycleNonTerminal` 补第 3 条代价（退订不触发回收 ⇒
  配额真实上界 = `nonTerminalBuffers + 曾有订阅者的流数`）。
- **F1**：`tests/docs/boundary-table.test.ts` 的 31 条 `gap` 逐条回源核对 ⇒ **7 条回填为 `pin`**、
  1 条订正理由（读数 **pin 49→56 / gap 31→24**，§7 仍 **90 行**）；三处写死的行数读数一并同步
  （文件头注 88→90、A4 断言文案 89→90、登记表注释）；`docs/guards.md §2 待守` 登记一行
  「`gap` 表需随每轮盘点复核」—— `gap` 表一旦写下就再没人复算，09-29 抽样 3 条**3 条全过期**。
- **官网（建议①③）**：`packages/website/src/pages/docs.astro` 在**构建期**从单源
  `docs/usage-guide.md?raw` 抠出 §7 表，注入 `docs.html` 新增的 `#limits` 段（占位符找不到 / 行数 < 70
  都**硬失败**，仿 `llms-full.txt.ts` 的 `?raw` 手法，单源不漂移）；`docs.html` 两处「去看
  `/llms-full.txt`」的指路改成 `#limits` 锚点。产物实测 **90 行表 + `href="#limits"`×2**。

**验证**：本轮累计 **5 条变异**逐条亲跑点名（F2 守卫改名 ⇒ 两条同时红；C5b `assertNotNaN` 判据失效 ⇒
恰好那条红；D1 判据退回 `typeof then` ⇒ 恰好新用例红；C1 `quit` 未被调 ⇒ 恰好那条红；A1 跳过分支失效 ⇒
恰好那条红），`git checkout --` 还原后全绿。门禁三件套全绿（`typecheck` / `typecheck:tests` /
`lint` 443 文件零告警）；相关套件：runtime 56 · engine 404 · container 11 · store 56 · transport 352 ·
toolkit 142 · architecture 57 · limits 32 · boundary-table 6 · 各 docs/官网守卫 —— 全绿。

**有意不做（留独立一轮）**：`async.ts` 抽「审批监督」簇 + 行数上限闸。回源实测其真实跨度**大于**报告描述
（`#suspended` Map 还被恢复簇的 `#resyncSuspended` 重建、6 处 `#unmarkSuspended` 调用点、对外 getter
`suspendedSummary`、`#dispatch` 是私有方法需回调注入）—— 这是**零行为变化的纯结构重构**，与前面
「修缺陷」性质不同，报告 §8 自己也标「各自独立 PR」；仓促混进本批会让「零行为变化」难以严格保证。

### 重构 · `AsyncRunner` 的审批监督簇抽成独立件（结构体检建议②）（2026-09-29 ⑦）

**使用者可见行为零变更**（纯结构重构：逐字搬迁 + 依赖改构造注入）。

`src/transport/async.ts` 里 `AsyncRunner` 的**审批监督簇** —— 挂起登记簿（`#suspended`，即
`/healthz` 的 `suspended` 读数）+ 在飞审批闸（`#inflightApprovals`）+ `approve` / `#approveInner`
+ 审批超时恢复（`#expireAndResume` / `#expireAndResumeInner`）—— 抽到新件
`src/transport/approval-supervisor.ts`（`ApprovalSupervisor`）。`async.ts` **1929 → 1756 行**。

- **为什么是这一簇**：结构体检（`STRUCTURE-INVENTORY-2026-09-29.md` 建议②）指出它的方向与
  「认领 / 槽位 / 派发」**正交** —— 它管的是「谁挂着、谁在等审批、超时了没」。抽之前它被私字段
  与私有方法缝在主类里，横跨 **5 处外部调用点**（`cancel` / `signalTask` / 到期唤醒 /
  `resumePending` 扫描 / `#executeInner` 的挂起与终态出口）+ 对外 getter。
- **依赖怎么解**：构造注入 `store` / `ownerId` / `approvalTimeoutMs` / **`dispatch` 回调**。
  `#dispatch` 仍归 `AsyncRunner`（停机闸 + 唯一派发口 + 一次性告警），审批簇只**消费**它 ⇒
  依赖单向，也不会出现两模块互相 `import`。`TaskApproveError` / `ApprovalDecisions` 随簇迁走，
  `async.ts` 顶部 **re-export** ⇒ 一切 `from './async.js'` 的既有 import 路径不变。
- **一处有意的等价简化**：`#redispatch` 的超时扫描原写作
  `rec.status !== 'suspended' || !approvalExpired(...)`，而 `approvalExpired` 内部**已经**判
  `status === 'suspended'` 与 `reason === 'approval'`（见 `approval-policy.ts`）⇒ 那句短路是
  **冗余的**，合并进 `expireIfExpired` 不改变任何可观测行为（字面量多重集对拍已证：唯一
  「消失」的字面量就是它）。
- **一处随之而变的守卫**：`tests/transport/dispatch-guard.test.ts` 的「`#dispatch(` 调用点下限」
  射程**扩到两个文件**（两条恢复路径的派发点形如 `this.#deps.dispatch(`）—— 否则这次搬迁会把
  计数从 7 掉到 6 而无谓判红。⚠️ **该守卫在改动中真的先红了**（先见红、再改守卫，不是反过来）。
- **验证**：3 条变异逐条亲跑 —— ① `expireIfExpired` 恒不触发 ⇒ 恰好 3 条红；② `approve` 的 409
  判据退回只看 `status` ⇒ 恰好 1 条红；③ `rebuild` 的 reason 判据摘掉 ⇒ **全绿**（如实记为
  **既存**覆盖缺口，已登记 `guards.md §2`）。三条还原后 `sha256` 逐字节一致。另跑 B.3「纯结构
  拆分复核清单」第 2 条要求的**字符串字面量多重集对拍**（无丢失）。门禁三件套 + transport 352 /
  architecture 57 / toolkit 142 / runtime 56 / engine 404 / container 11 / store 56 —— 全绿。
- **顺带登记**（`guards.md §2`）：上面那条覆盖缺口，以及**行数上限闸为何暂不做**（口径未定、
  易误报，与 §3「宁可窄，不要误报」有张力；替代形状见那一行）。

### 重构 · `AsyncRunner` 再抽两簇（信号投递 / 恢复扫描）+ **源码体量闸**（结构体检建议③）（2026-09-29 ⑧）

**使用者可见行为零变更**（纯结构重构：逐字搬迁 + 依赖改构造注入）。

⑦ 抽走审批簇后 `async.ts` 仍有 1756 行。本轮把剩下两个方向正交的簇也抽走：

- **信号投递**（`SignalSupervisor`，`src/transport/signal-supervisor.ts`，182 行 / **74 含代码行**）：
  `signalTask` / `#signalInner` / 在飞信号闸 + `TaskEventError` + 两个上限常量
  （`MAX_DELIVERED_EVENT_IDS` 256 / `MAX_PENDING_EVENTS` 64）。它与 `ApprovalSupervisor.approve`
  是**同一族**（挂起任务的外部唤醒入口；形状逐条对应：读记录 → 校验挂起 → 改状态 → 先落库再
  派发 → `unmarkSuspended` → `dispatch`），两处真实差异：① 并发闸不同款（`approve` 共享在飞那次；
  事件**串行成链**）；② 多一道容量闸（到上限 409，不静默丢）。
- **恢复扫描与接管**（`ResumeScanner`，`src/transport/resume-scanner.ts`，261 行 / **126 含代码行**）：
  `resumePending` / `#redispatch` / `#ownerLiveness` / `wakeDue` / `#wakeDueInner` + 两把在飞闸。
  一次扫描**按序**干四件事（顺序有语义）：① `approvals.rebuild` ② `approvals.expireIfExpired`
  ③ `wakeDue` ④ `#redispatch` 认领重投（`wakeDue` 由私有改公开，两个调用点）。

`src/transport/async.ts` **1756 → 1460 行**（**664 含代码行**）。依赖仍走**构造注入**：两个监督件都只
**消费** `AsyncRunner.#dispatch`（停机闸 + 唯一派发口 + 一次性告警）⇒ 依赖单向、无模块环。
`TaskEventError` / `ResumePendingOptions` 随簇迁走 + `async.ts` 顶部 **re-export** ⇒ 一切
`from './async.js'` 的既有 import 路径不变。

**新增防回涨的闸**：`tests/architecture/source-size.test.ts` —— `src/**` 单文件**含代码行** ≤ 750。

- ⚠️ **口径与报告建议刻意不一致**：报告写「`async.ts ≤ 1600` **行**」，但本仓注释占 29~55%
  （`async.ts` **55%**）、注释是证据载体（记着「判据只挡终态，别写成 `!== 'queued'`」这类踩坑）⇒
  按**行数**设闸的第一个作用是**逼人删注释**（静默、且删的是最贵的资产）；且按行数 `1460 < 1600`
  **当下根本不触发**（事后不疼）。⇒ 与注释解耦：整行注释与空行一律不计入。
- **上限 750 的由来**：`async.ts` 664 与第二名 `turn.ts` 521 之间隔着一大截（143 行）—— 750 落在这段
  空档里，给 `async.ts` 留约 13% 正常迭代余量，又远离合法长文件那一档（报告 §2 那批「不该拆」的
  最长只有 260 行代码）⇒ 不误伤。
- **超了只有两条路、都必须显式**：① 抽件（本仓既有做法）；② 改 `MAX_CODE_LINES`（改动落在这个
  文件里 ⇒ review 时一定看得见，而不是悄悄长过去）。
- ⚠️ **刻意不用「剥掉注释再数非空行」**：本仓多处 URL 字面量与含 `//` 的字符串，朴素剥离会**吃掉
  真实的代码行** ⇒ 读数偏低 ⇒ 闸静默失效。逐行只问「这一行是不是从头到尾都是注释」。
- **变异验证过**：上限压到 500 ⇒ 精确点名 `transport/async.ts: 664` / `engine/turn.ts: 521`
  （当下越线的确实只有这两个）；还原后复绿。

**两条随之而变 / 补上的守卫**：

- `tests/transport/dispatch-guard.test.ts` 的「`#dispatch(` 调用点」射程从**两个文件扩到四个**
  （三条恢复路径的派发点形如 `this.#deps.dispatch(`），并**钉住每个监督件的精确数**
  （approval 2 / signal 1 / scanner 3）+ 真空护栏。⚠️ 与 ⑦ 同款：**这条守卫每次搬件都会先掉一格
  判红** —— 修法是**扩射程**、不是放宽下限（「路径总数」这一事实没变）。
- **补一条既存覆盖缺口**：变异「把 `signalTask` 的串行闸摘掉」⇒ **全绿**，说明这条闸**此前没有
  任何用例钉住**（搬迁前内联在 `async.ts` 里时就没有）⇒ 补 `tests/transport/task-events-input.test.ts`
  的「两条并发事件串行成链 ⇒ 只唤醒一次」（用**有往返的异步 store** 让并发窗口真实存在）。

**验证**：5 条变异逐条亲跑 —— ① `wakeDue` 的 drain 闸失效 ⇒ 恰 2 条红（`drain-race` + `durable-timer`）；
② 认领后异步派发摘掉 ⇒ 恰 3 条红（`async.test`）；③ 串行闸摘掉 ⇒ **全绿（既存缺口，已补用例）**；
④ 容量闸失效 ⇒ 恰 3 条红（`event-buffer-cap`）；⑤ 补用例后重跑串行闸 ⇒ **恰好那条新用例红**。
全部 `cp` 还原后 `sha256` 逐字节一致。另跑 B.3「纯结构拆分复核清单」第 2 条的**字符串字面量多重集
对拍**（可复跑探针 `.workbuddy/probes/literal-multiset-diff.mjs`，逐字符状态机剥注释）：旧（`async.ts`
+ `approval-supervisor.ts`）**81 种 / 142 个** vs 新（四文件）**83 种 / 154 个** —— **丢失 0 项**，
新增 6 项**全是 import 路径** ⇒ 纯搬迁。门禁三件套 + 套件：transport 353 / architecture 57 /
toolkit 142 / runtime 55 / engine 403 / container 10 / store 55 —— 全绿。

**顺带**：`guards.md §2` 那条「`async.ts` 没有行数上限闸」**闭环**（划掉、移入 §1.1）；
`AGENTS.md` 的 `transport/` 段补登记三个监督件，并订正那句已过时的「910 行的类 / 后续抽块三步一步
没走」（抽块其实已走了三步）。

## [0.9.5] - 2026-09-29

> 本版主题（窗口 `0.9.4 → 0.9.5`）：**外部深评 P2 表的最后三条收口（K5 / T4 / K2）+ 两处「报告的判据要订正」**。
> 三块的共同点都是**把静默换成有声**：① 记忆回写从此**能发现**并发丢写（可选 CAS：冲突时**不写 + 出声**，
> 不替你合并）；② 挂着的任务不再各占一份 ≈1 MB 的事件缓冲（新旋钮按**条数**配额，回收的是**缓冲**、
> 留表项与序号 ⇒ 读者先收一帧 `stream.truncated` 再转实时，而不是被谎报成「别的进程」）；
> ③ 加第五类能力从「改五处按类分支、漏一处不报错」变成「给注册表加一行，不表态就 `tsc` 报 `TS2741`」。
> **无破坏性变更**：新加的两个能力都是**可选**的（不实现 ⇒ 行为与 0.9.4 逐字相同），
> `AsyncRunner.streamNonTerminalBuffers` 的缺省值只影响「回放看不全」那一档（且看得见）。
> 既有使用者**不需要任何动作**。

### 重构 · 四类能力的装配差异收进一张注册表（外部深评 K2）（2026-09-29 ③）

来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md` 的 P2 表 `K2`。性质不是「代码不好看」：加第五类能力
此前要在 `toolkit/module.ts` 改**五处按类分支**（收集 / 可用名单 / `buildSlice` 展开 /
`@Prompt` 版本表 / 孤儿能力计数），漏一处只表现为「那类能力静默不进菜单 / 不进版本表 /
不计入孤儿告警」—— 构建与全部用例照样全绿。

- **新增 `src/toolkit/capability-slice.ts`**：`CapabilityPayloads` 定义「一类能力」是什么，
  `KIND_SPEC` 的类型是映射类型 `{[K in CapabilityKind]: CapabilityKindSpec<K>}` ⇒
  **加了 payload 成员却不给表项，`tsc` 报 `TS2741`**（与 `SUCCESS_STOP_REASON` /
  `TERMINAL_STATUS` 同款护栏）；`CAPABILITY_KINDS` **从表的键派生** ⇒ 五处遍历自动覆盖。
- **`module.ts` 的五处按类分支换成对表的遍历**（`collectCapabilities` / `capabilityToolNames` /
  `buildCapabilitySlice` / `capabilityCount` / `capabilityVersions`）—— 行为零变更
  （既有 toolkit 用例 142 条 + 全套件 1597 / 195 / 27 全绿即证据）。
- **两处刻意留在表外并写明理由**：菜单重名校验（跑在合并后的工具列表上，与类别无关）、
  能力引用图（只有 `@SubAgent` / `@Skill` 有 `tools` 引用 —— 语义不对称，不是漏项）。
- 唯一的类型擦除集中在 `specOf()`（相关联合，TS#30581 的已知限制），安全性由「每行在定义处
  逐个收窄 + 键集从表派生 + 逐类驱动用例」共同兜住 —— 不是靠这一句断言。

### 修复 · 非终态流的缓冲配额（外部深评 T4）（2026-09-29 ②）

来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md` 的 P2 表 `T4`。报告当日判据不完整（单流**条数**上限
从 #115 起就在），**仍然成立**的是那半：**非终态流的缓冲只增不减** —— 每任务 ≤`streamBufferEvents`
(500) 条 ≈ 1 MB，而等审批 / 等事件 / 等定时器的任务**永远走不到终态** ⇒ 挂着的任务越多内存越大。

- **`TaskEventStreams` 新增 `nonTerminalBuffers`（缺省 32 条流）**，并经
  **`AsyncRunner.streamNonTerminalBuffers`** 暴露给宿主（`0` = 不为没人读的非终态流留回放缓冲）。
  超出配额即从**最旧且无订阅者**的非终态流开始**回收缓冲**。
- **回收的是缓冲，不是表项**（这是本次对报告判据的订正）：表项留着当**桩**（`has()` 仍为真、
  `nextIndex` 接着走），只把回放历史丢掉并用 `firstAvailable` 明示缺口 ⇒ 连上来的读者先收到
  一帧 `stream.truncated` 再转实时，**不会**被谎报成 `stream.unavailable`（那是「别的进程」的台词，
  而任务就在本进程跑着）。删表项会**静默破坏**「序号是流自己的」那条设计约束：恢复段重开
  `nextIndex = 1` 的流，拿 `Last-Event-ID` 续订的读者从此永远筛不出东西。
- **代价如实**：① 正在被订阅的流**不受配额约束**（不抽走正在读的数据）⇒ 同时被读的流很多时
  缓冲总量仍会超配额；② 每条非终态任务留一个桩（约百字节），桩本身不设上限（同因）；
  ③ 「回放看不全」是**看得见**的降级（`stream.truncated` + `droppedBefore`），不是静默丢事件。
- `0` 语义登记进 `core/limits.ts`（`disabled`），探针在 `tests/limits.test.ts`（走公共旋钮，
  两处接线一起驱动）。

### 变更 · 记忆回写的 CAS（可选、成对、冲突出声）（2026-09-29 ①）

来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md` 的 P2 表 `K5`（**未做**那三条之一）。
病灶：`flushMemory` 是无条件**全量读改写** —— 同 keys 的并发 run 之间是 last-write-wins，
后写的那条把先写的改动整片覆盖，**双方都看不出异常**。

- **`MemoryStore` 新增两个可选成员**（`runtime/memory.ts`）：`loadWithRev(keys) → { values, rev }`
  与 `saveIfRev(entries, rev) → { committed, reason? }`（`rev` 是**不透明**版本句柄，框架不解释、
  只在本 run 回写时原样递回）。**成对实现**：只实现一个是装配错误 ⇒ `executeRun` **入口**抛
  `TypeError`（半个 CAS 与「不支持」等效，却让「有没有被覆盖」看起来有据可查）。类型级守卫在
  `tests/types/memory-surface.types.ts`（两个成员必须在**接口上**且**可选**）。
- **冲突时：不写 + 出声**（`runtime/run.ts`）：`saveIfRev` 回 `committed !== true`（含忘返回
  `undefined` —— 不知道写没写就不许记成写成功）⇒ 该 key 集**一个字都不写**并打一条
  `console.warn`（含 keys 与 `conflict`）。**框架不合并、不重试** —— 「后写赢 / 逐键赢 / 按时间戳赢」
  都是策略，属 store 与宿主；框架只负责把「丢了一条写」变成有声。回写被拒**不改 run 结局**
  （仍 `succeeded`，与 sink 抛错同款）。代价如实：这一轮记忆**没落库**，重试配方见 `usage-guide` §6.5。
- **不支持 CAS 的 store：出声降级**。只有 `load` / `save` 时行为**一字不改**（照旧 last-write-wins），
  但**第一次**用这个 store 实例时打一条**一次性**提示（按实例去重，不是每轮刷屏）。
  框架**检测不了**没有版本号的覆盖 —— 版本号是唯一依据，写进 `usage-guide` §7 边界表。
- `InMemoryMemoryStore` 顺带实现这一对：版本是**整店一个单调计数**（粒度粗 ⇒ 宁可多报冲突，
  也不漏报真实覆盖；`loadWithRev` 的返回形状 = `MemorySnapshot`）。

### 变更 · store 的可选能力进接口（S5）+ 两处如实口径（K1 / T6）（2026-09-28 ㉓）

- **`TaskStore` 增加两个可选成员**（`store/store.ts`）：`compact?()` 与 `close?()`。
  `FileTaskStore.compact()` / `SqliteTaskStore.close()` 此前只活在具体类上，宿主拿到接口类型时
  只能 `as` 强转（换 store 后运行期才炸）。现在调用点写 `store.compact?.()` 即可。
  **框架不替你调**：`drain()` 不关 store（可能是共享的，关掉是宿主的生命周期决定），压实同理归宿主。
  类型级守卫在 `tests/types/store-surface.types.ts`（`npm run typecheck:types`）。
- **文档写明「嵌套能力共用一块黑板、不隔离」**（`usage-guide` §5.1，零代码改动）：
  `@SubAgent` / `@Skill` 与父 run 是同一份 `RunContext`（`withRunContext` 全仓单点调用），
  子 agent 写的键父 run 看得见（有意）；并发子 agent 写同一键是 last-wins（与 `flushMemory` 同款取舍），
  要隔离请自己命名空间。「按子树隔离」保留为 `spec.md` §11 开放项。
- **初始 `save` 不 await：定案不改**（外部深评 T6，报告已自行降级 P3）：
  `submit` 是**同步门面**（await 会把它变成 async = 破坏性变更，只换来「多等一个网络往返」）；
  「静默吞错」这一半已有处置（迟到的 reject 转成任务 failed，且只在任务未被推进时改判）并用例守着
  （`tests/transport/async.test.ts`）。判据与承重理由写进 `spec.md` §10 ㉓。


### 修复 · 四条「静默失效」收口（2026-09-28 ㉒）

来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md` 的 P2 表（`S1` / `S2` / `S3` / `S6`），
逐条在当前 `main` 上复核后动刀。四条同一族：**错了 / 算不出 / 超限了，却没有任何信号**。

- **redis store 的 TTL 不再吃掉非终态记录**（`store/redisStore.ts`，**行为变更**）：
  此前 `applyTtl` 不看状态，一条**等审批中**（`suspended`）的任务会在 TTL 到点时从 redis 里消失 ——
  「批了它」的决定无家可归（`approve` 404）；而内存 store 的淘汰逻辑里明写着 `suspended` 不可淘汰
  （同一事实的两处读数方向相反）。现在「终态」判定单源到 `core/run.ts` 的 `isTerminalStatus`
  （穷尽分类表：加成员不表态 ⇒ `tsc` 报缺属性），只有**终态**记录才拿到查询窗口（非终态覆写靠不带选项的
  `SET` 清除既有 TTL），幂等索引与记录同生共死。**代价如实**：永远等不到审批的挂起记录会永久驻留
  （批不批是人的事，store 无从判死）—— 与内存 store 同款取舍，清理属部署层职责。
- **上游没回报 usage 时不再静默填 0**（`integrations/anthropic.ts` / `integrations/openai.ts` /
  `engine/turn.ts`）：`?? 0` 让「端点不回 usage」（或忽略 `stream_options.include_usage`）与
  「真的只花了 0」在数值上无法区分，于是 `maxCostUsd` 这条成本护栏**静默失效**。现在四条响应路径
  （流式 / 非流式 × 两条适配器）都标 `MessageUsage.unreported`，引擎在 llm.turn span 上记
  `usage.missing` 事件，报告出 `usageMissingTurns` / `usageMissingModels`、指标出
  `agentia_model_usage_missing_turns_total`（render + OTLP 两出口）。与 `usage.unpriced`（模型不在
  价格表里）**分开计数**：后果都是「成本看起来是 0」，但一个要换模型、一个要查端点/网关。
- **`statusOfStreamError` 收成一份**（`integrations/adapter-options.ts`）：原本两条适配器各写一份、
  靠注释互相喊话对齐 —— 合并时发现它们**早就不一致**（`not_found_error` 一侧 400 另一侧 500，
  等于把「模型名错了」记成 `server`）。新增 `tests/integrations/stream-error-parity.test.ts`：
  一张表跑两条真适配器 + 真 SSE，两行 `wasDivergent` 标出分歧点。
- **两条 MCP 桥的分帧缓冲加上限**（`core/line-framing.ts`，`MAX_FRAME_CHARS` = 8M 码元）：
  `buf += chunk` 遇到「不带换行的巨型行」就是无界增长（先 OOM 再谈协议；MCP server 往 stdout
  混日志本来就常见）。连接器侧超限即拒绝全部在途请求并终止子进程；反向桥侧回一条协议错、
  丢弃到下一个换行**重新对齐**（其后的帧照常派发）。


### 文档 · 外部深评的 5 份报告入库 + 逐条落地盘点（2026-09-28 ⑲）

**改了「复核报告不随仓提交」这个惯例**：那轮外部深评产出的 5 份报告**原文逐字入库**到
`docs/reviews/2026-09-28/`（入库前后逐份 `shasum -a 256` 比对，**逐字节一致**），
配一份索引 `docs/reviews/2026-09-28/README.md`，里面是**逐条落地状态表**。

- **为什么改**：① 剩余条目是真实的待办来源（P2 表还有 **14 条**未做 + 1 条「有意为之」），
  不入库 ⇒ 只有当天在场的人知道还剩什么；② 本仓文档有 **7 处**引用这些报告，
  而它们此前**指向一个不在仓里的文件** —— 「指向一个读不到的东西」本身就是坏引用。
- **代价如实**（写进索引 §0）：入库即意味着这些文字会随代码**漂移**。所以正文逐字保留、
  「现在还剩什么」一律以索引表为准、**每落地一条回来更新那张表**（本目录唯一要维护的地方）。
- **盘点结论**（逐条按其自报位置在当前 `main` 上重跑定点 `grep` / 读源码，不采信报告自述）：
  P1 表 9 条 **8 条已落地**（`C1`/`C2`/`T1` → #169，`E1`/`E2`/`T2`/`T3`/`J1` → #170）；
  P2 表 26 条 **11 条已落地**（`C6` → #171，`C3`/`C4`/`C5` → #172，`E3` → #170，`E8` → #174，
  `T5` → #173，`S4` → #176），**14 条未做**，`T7` 为「有意为之」；
  `DEEP-REVIEW` / `PR-164-REVIEW` / `SRC-STRUCTURE` 三份的残留项除两条「定案不做」外全部已落地。
- **顺带校正报告一处判据**（`T4`）：报告说「非终态流的缓冲永不淘汰」，而**单流条数上限**
  （500、丢最旧）在审计当时就已存在（#115 起）—— 报告漏看；仍成立的是「非终态流的**表项**
  不被回收」。**判据不同、修法就不同**，所以这条保留为「未做」但把判据写准。
- **7 处引用**：`spec.md:4224`/`:4256`/`:4438`/`:4489` 与 `CHANGELOG.md:12` 原文里的
  「（**未随本仓提交**）」自本条起不再成立 —— 按 spec 的**只增不改**纪律原文一字未动，
  权威更正是 `docs/spec.md` §10 ⑲，逐条对照在索引 §3。
  另一处（`CHANGELOG.md:315` 指向「**仓库根** `SRC-STRUCTURE-2026-09-28.md`」）是**坏引用**
  （那个路径从来没存在过），已**就地修成真实路径** —— 修的是坏引用，不是历史事实。

### 修复 · 外部深评五条 P1 收口（2026-09-28 ⑫）

来源同上：`DEEP-AUDIT-VERIFIED-2026-09-28.md`（**未随本仓提交**）里「本轮复核方未覆盖、保留原判」
的其余五条 P1，**逐条实证后**才动刀（含一条被自己的诊断否掉的原判，见 spec §10 ⑫）。

- **上下文策略抛错不再判死整条 run**（`engine/turn.ts`）：`ContextPolicy.beforeTurn` 里可能**走网络**
  （compaction 的 `summarize` 是模型调用），一次 429 / 超时就会让整条 run 以「请求失败」收尾 ——
  而上下文压缩对一条 run 是**尽力而为**的优化，不是前置条件。现在降级成「本回合原样放行」，
  **且出声**：run 根上记一条 `context.policy_failed { iteration, message }` + 一条 `console.warn`
  ——否则「历史一直很长、token 慢慢涨」没人知道为什么。
- **压缩失败的滞回额度不再被烧掉**（`engine/policy.ts`）：`lastCompactAt` 原先在
  `compactMessages(...)` **之前**就写 —— 摘要器失败时额度已经用掉，于是「这一回合没压成」
  还连带让后面 `compactEvery - 1` 个回合都不再尝试。现在记的是「上次**成功**压缩的回合」，
  失败不记账、下一回合自然重试。⚠️ 代价说明：摘要器**持续**失败时每回合都会再调一次
  （每次多一次失败的模型往返）—— 要抑制请在 `summarize` 里自己退避，别指望滞回额度兜。
- **MCP HTTP 传输的意外不再带走宿主**（`engine/mcp-server-http.ts`）：请求处理那层 `try` 此前
  **只有 `finally`** ⇒ 协议面之外的异常（例如某条 `inputSchema` 是带 getter 的对象，
  `validateJsonSchema` 一读就抛）冒泡出 async handler = unhandled rejection = Node ≥15 默认
  **终止进程**。同文件的鉴权钩子、`JSON.parse`、stdio 那条传输都有兜底，只有这里漏了 ⇒
  「同一份协议面在两条传输上一条活着、一条把宿主带走」。现在回 **200 + JSON-RPC `-32603`**
  （协议面的错误是 200 里的错误对象，不是进程级 5xx），响应头已发时只收口。
- **`drain()` 不再可能等一个永远不结束的等待**（`transport/http.ts` + `http-endpoints.ts`）：
  唯一能结束一条「自己不结束的 SSE」的机制（收口）原先排在等待**之后**，而缺省 `timeoutMs = 0`
  是**不限** ⇒ 死锁。现在**活连接不享受无限窗口**：没有 deadline 时先收口再等，有 deadline 时
  保持既有的优雅等待。返回值也**如实分两种收口**：切过在飞的 run ⇒ `false`（工作是被 abort 收尾的，
  回 `true` 等于把「切了」说成「等干净了」）；只关掉旁观者长连（`/tasks/<id>/stream`）
  ⇒ 不损失任何工作，不参与这个判断（把它算成没排干净是另一种说错话）。
- **能力引用成环在装配期即拒**（新增 `toolkit/capability-cycles.ts` + `module.ts` 接线）：
  `subagentToTool` 的第二参是**延迟求值 thunk**、装配期把引用全建满 ⇒ 环是**纯运行期**递归，
  而 `maxIterations` 只限**宽度**、深度没有任何闸 ⇒ 模型一次自我调用就是无限递归
  （树按 `宽度^深度` 炸开）。现在装配期 DFS 找环并抛错，错误信息给出**环上的节点序列**。
  全仓 grep 确认**没有任何既有用例**写自引用 ⇒ 不误伤既有装配。
- **续跑认领从「新鲜度启发式」升级成「租约」**（新增 `transport/owner-id.ts`、`owner-liveness.ts`，
  改 `resume-policy.ts` / `async.ts`）：`staleAfterMs` 只回答「记录起跑多久了」，不回答
  「主人还在不在」，两个方向都会错 —— ① 单段 run 跑超窗口 ⇒ 他进程当孤儿抢走 ⇒
  **同一任务跑两遍**（真·重复执行）；② 崩溃进程留下的记录**仍带 ownerId**（`submit` 恒写）
  ⇒ 落在保鲜期内没人捡 ⇒ **饿死**（扫描是**惰性**的，扫完就没人再扫）。
  现在 `ownerId` 形状为 `p<pid>@<host>-<8 位十六进制>`，`staleAfterMs > 0` 时**同主机直接问
  「那个 pid 还在不在」**（`process.kill(pid, 0)`）：**在的绝不抢**（不管记录多老）、
  **不在的立刻可抢**（= 崩溃孤儿，不等保鲜期）；**判不了**（异主机 / 升级前写下的旧格式 /
  自定义标识）才退回新鲜度启发式 ≡ 升级前行为。
  - ⚠️ **`ownerId` 是内部标识，宿主别解析它**（格式本次变了）。混版本部署安全：旧进程写下的
    无 `@host` 记录一律走「判不了 ⇒ 新鲜度」，行为与升级前一致。
  - 残留风险如实记（两种都只会「**晚一点**才捡」，不会「抢错」）：**PID 复用**与**僵尸进程**
    （父进程未收尸）都会被判成「主人在」，要等那个 pid 真的消失才可捡。刻意**不加时间硬上限**
    兜它们 —— 加上限 = 把租约换回新鲜度启发式，「长跑被抢」那个 bug 原样回来。

### 修复 · 定时器上限单源（2026-09-28 ⑪）

- **超过 `2^31-1`ms（≈24.86 天）的定时器延迟不再是「配置合法、行为相反」**：Node 不会遵守它
  （只在 stderr 留一行 `TimeoutOverflowWarning`，随后把延迟钳到 **1ms**），于是「配 30 天超时」
  会变成「每个调用立即超时」、「退避到限流窗口之后」会变成「热重试打风暴」。此前防线只在
  `Scheduler.every` / `at`，而**派生出来的等待**（`withTimeout` ← 引擎 `toolTimeoutMs`；
  `interruptibleSleep` ← 重试退避；`AsyncRunner.runTimeoutMs`；`createAnthropicClient.timeout`；
  `DrainGate.waitForIdle` ← `drain` 的等待预算）一律只查「非负 / 有限」。现在上限单源在
  `core/timeout.ts`（`MAX_TIMER_DELAY_MS`），五处站点在**构造期 / 入口**一并拒绝。
- **`NaN` 也拒**（同一处校验）：`withTimeout(p, NaN)` 此前被那句 `!(x > 0)` 静默读成
  「不设超时」（与「我设了个预算」正好相反，桥还会因此起自己的 60s 兜底 ⇒ 双计时器、双账本）；
  `interruptibleSleep(NaN)` 此前穿透「非正」判直落 `setTimeout(NaN)`（同样被钳到 1ms）。
- **上游的 `Retry-After` 走「夹」不走「拒」**：`Retry-After: 99999999` 不是使用者的错，
  为它把一次 429 升级成硬失败是错的；现在被夹到上限，不再静默变成「1ms 后立刻重试」。
- **`cancel` 的 409 文案分成两种说法**（`AsyncRunner`）：原先一律说「正在运行但**不在本进程**」，
  而同一判据还覆盖「**已在本进程受理、正在等并发槽位**」（四条恢复路径先置 `running` 再派发，
  句柄要到拿到槽位才登记）—— 对它说反话。现在两支分开措辞。**闸不放开**（放开会让
  `onFinished` 双发）。
- ⚠️ **`limits` 表的 `withTimeout.ms` / `interruptibleSleep.ms` 的 `badValue` 由 `none` 改 `throws`**：
  传给 `RunAgentOptions.toolTimeoutMs` 的 `NaN`、或任何超过上限的超时值，现在会**抛错**。
  这两种值此前的行为都与配置意图相反（一个静默变「立即超时」，一个静默变「不设超时」）。

### 修复 · 复审收口（外部深评 2026-09-28）

- **schema 的环与深度护栏**（C6）：`validateJsonSchema` 按 properties / items 递归，
  **环 + 深值**会钻到 V8 的 `RangeError: Maximum call stack size exceeded` —— 症状没有辨识度
  （看着像「校验不了」，而不是「schema 有环」）。现在两道闸：`assertNoSchemaCycle()` **前置**抓环
  （与值深度无关，点名路径；用祖先集，**共享子树不算环**）+ `MAX_SCHEMA_DEPTH = 256` 兜
  「合法但深到失控」。⚠️ 只加深度闸是**不够的**：递归深度 = min(schema 深度, 值深度)，
  所以「环 + 浅值」根本不会爆栈（我也正是这么写出第一版红用例的）。
- **limits 表的对账收口**（C4 + C5 家族）：`LIMIT_SEMANTICS` 里声明「坏值抛错」的旋钮有 18 个，
  而「报错文案真的取自同一张表」的对账 case 只覆盖 10 个，且那个清单是个 `Array` ——
  新增一个 throws 旋钮却忘了对账，**不会有任何东西红**（「表说它有构造期校验」与「文案真同源」
  之间没有机器守着）。现在：**A4 单向穷尽断言**（每个 throws 旋钮都必须有 case）+ 补齐 8 条
  case + 把实现侧的文案接上 `zeroClauseOf`（7 处此前是手写或被通用文案盖掉）。
  另补登 **5 个**从未进表的旋钮：`BudgetGuardOptions.maxTotalTokens` / `maxCostUsd`
  （v0.5.0 起就存在）与 `metricsSink.maxCapabilities` / `maxModels` / `maxScores`。
  顺带修 8 条 `zeroClause` 的**双层括号**（表里自带「必须为正数（…）」而实现又加一层），
  并把 `withTimeout` 的 **async 站点**（坏值表现为 rejection 而非同步 throw）纳入对账。
- **排队段的上限 `AsyncRunnerOptions.maxQueued`**（T5，缺省 0 = 不限）：`concurrency` 只约束
  「同时在跑几个」，而「跑不上、排在后面」那一段**此前没有任何上限** —— `submit` 永远收单、
  `POST /tasks` 永远 202，排队段随调用方灌入无界增长（每条排队任务 = 一条记录 + 一棵悬挂的
  `#execute` promise + 一个槽位等待者，全在内存）。现在超限 `submit` 抛 `TaskQueueFullError`
  （带 `status: 503` 自陈字段），HTTP 宿主回 **503 + `Retry-After`**（与 `maxConcurrentRuns`
  同款，**不是 400** —— 排队满不是调用方的错）。
  ① **判据不是「已受理未持槽的条数」**，而是「**真正在排队的深度** = `max(0, 已受理未持槽数
  − 空槽位数)`」：前者把「池子还空着、马上就能跑」的也算成排队的，`concurrency: 1` +
  `maxQueued: 1` 下会把第 2 条**合法**提交误拒（第一版就是这么写的，被用例当场抓出来）。
  ② 为此把「出排队段」挪到 `await acquire()` **之前**做一次快照判断（`inUse < concurrency`
  就当场出集合）：只走 acquire 的连续体时，「占槽」（`running++`）是同步的、「出排队段」却要
  等一个微任务，同一条任务在那一瞬被算两遍 ⇒ 深度虚高一格。
  ⚠️ 刻意**不**把它做成「同步快路径替代 acquire」：那会顺带少掉一次微任务，把「置 running」
  相对引擎推进的时刻**提前**，踩到既有用例里「等到 `running` 就当工具已挂在飞」的隐含假设
  （`cancel.test.ts` 的前置断言当场红，实测踩到过）—— **记账改原子，时序一个字不改**。
  ③ **只在 `submit` 判**：恢复路径（approve / 到期唤醒 / 崩溃重投）推进的是**已受理**的任务，
  拦下来等于把它搁死在 store 里。④ 幂等键命中的重复提交**不吃** 503（闸在去重之后）。
  ⑤ `get queued` 与闸**同用** `#queueDepth`：读数即判据，不会各说各话。
  顺带把 `SlotPool.inUse` 的「测试用」自述改成真话（它从此是闸的一半）。
- **工具 I/O 事件名单源到 `core/trace.ts`**（E8）：`tool.input` / `tool.output` 跨
  **engine → eval → integrations** 三层被手写（**12 处**取值 —— 报告写「7 处」偏小，我逐条点数是 12）。
  漏一处的后果不是「少记一条事件」，是**静默归零**：`integrations/report.ts` 与
  `metrics-state.ts` 都按名字过滤，改名漏一处 ⇒ 报表说「没有工具调用」而 trace 里明明有。
  现在常量 + `ToolIoEventName` 类型落在 **`core/trace.ts`**（⚠️ 报告建议的落点
  `engine/tool-events.ts` **不可行**：`integrations` 只许依赖 `core`，够不着 engine —— 那样
  integrations 侧只能再手写一份，等于把单源补成两处）；11 处取值 + 6 处 import 改引常量。
  `eval/harvest.ts` 里**生成出去的用例源码文本**保留字面量：生成的脚本不 import 本仓常量，
  改了会得到一个引用不存在标识符的脚本（跑起来才炸）。
  配**源码级守卫** `tests/architecture/tool-event-names.test.ts`（自带遮蔽器，与
  `lib/source-scan.ts` 相反 —— 那个按设计遮蔽字符串）：三条自证样本 + 白名单按「文件 + 恰好
  条数」+ 射程钉 + 走查下限；变异三条全部具名复红（含「守卫自身的守卫」：遮蔽器退化）。
- **删掉内部死方法 `TaskEventStreams.forget`**（外部深评「forget(taskId) 未处理」那条的收口）：
  全仓**零调用点**（`grep -rn 'forget(' src/ tests/ packages/ examples/ scripts/` 命中的
  `scheduler.ts` 那 4 处是它自己的**局部函数** `const forget = (taskId) => inFlight.delete(taskId)`，
  操作的是 `inFlight`，与事件流无关）。§10 上一轮已如实登记它「不该为它写测试 —— 那等于锁死
  死代码」，本轮直接把它**删掉**：淘汰这件事唯一的真实机制就是 `#evictTerminal`（按 LRU 丢终态流、
  有订阅者的不丢）。原地留一段注释说明「它曾经在、为什么删、真要再加回来该怎么设计」。
  ⚠️ 这一条**不是**「补文档」：删掉公开方法会让它的名字从 API 面消失，对使用者是**无感**的
  （它从未从 `src/index.ts` 导出），但少一个「代码里有、文档里承诺、实际永不发生」的错位。
- **OTLP 导出不再每次 flush 白算分位**（S4）：`metrics-otlp.ts` 原来每次 flush 调一次
  `state.snapshot()`，却只从结果里读 `runs` / `failed` / `costUsd` **三个标量** —— 而这三个
  **本来就是 `MetricsState` 的公开字段**；它对 capabilities / models / runLabels 全是**直接遍历公开 map**
  （`grep latencyP50\|latencyP95 src/integrations/metrics-otlp.ts` → 空），一个分位字段都不读。
  而 `snapshot()` 会为**每个**组合各算 p50 + p95，`percentile()` 的实现是 `[...ring].sort()`。
  实测（`npm run bench:otlp`，满 1024 窗口 / 30 个组合）：单个 p50+p95 **233.8 µs**、
  `snapshot()` 整体 **5929.6 µs**、而 `buildOtlpPayload()` 只要 **41.6 µs** ⇒ 白算 **99.3%**，
  且**每个 flush 都付一次**（拉取式 Prometheus 侧无此问题：那里确实要分位）。
  修法**不是**报告建议的「让 `snapshot()` 的分位可选 / 另给一个不算分位的视图」—— 那是给一个
  本不该存在的调用加开关。OTLP 只需要三个公开字段，**删掉这次调用**即可，依赖面同时变诚实：
  它不再依赖 `MetricsSnapshot`（Prometheus 侧渲染的产物）这个形状。**无行为变更**（payload 逐字段不变，
  1322 条框架用例全绿）。配**行为级**守卫 `tests/architecture/otlp-no-snapshot.test.ts`：
  把 `state.snapshot` 换成会抛的桩再跑导出路径（⚠️ 不用源码扫描 —— 被守的源码注释里**本来就写着
  `state.snapshot()`**，靠遮蔽器区分注释与代码等于把守卫的成败押在遮蔽器上）；含阳性对照
  「这枚雷真的会炸」防真空 + 「改字段 payload 跟着变」防读副本。变异两条具名复红：
  ① 把 `snapshot()` 加回去；② 三个标量改读错来源。
  新增 `npm run bench:otlp`（`scripts/bench-otlp-snapshot.ts`，与 `bench:trace` 同档、不进 CI）。
- **engine 层的四处「如实性」收口**（外部深评 E4 / E5 / E6 / E7）：
  - **E4 · 请求失败出口不再硬写 `eventsDelivered: false`**：那条出口在 `loop.ts` 的 catch 里，
    而 `eventsDelivered` 原先只挂在**内层** `LoopContext` 上 —— 外层够不到，于是只能硬写。
    现在它挪到**跨段共享**的 `progress` 对象上（`turn.ts:233` 的注释本来就写着「抛错时调用方仍读得到」），
    由 catch 按事实传入。**零行为变更**（`pendingEvents` 在终态分支本来就无条件清），
    但**对外字段不再说谎**：它随 `rec.result` 落库、在导出面上，报错方向会让宿主以为该重投。
    配回归用例（事件已注入 → 续跑段请求失败 ⇒ `eventsDelivered === true`）：**变异撤回传参即红**。
  - **E5 · `stop reason` 的成败分类改成穷尽表**：`isSuccessStopReason` 的
    `reason === 'end_turn' || …` 换成 `Record<AgentStopReason, boolean>` 表 ——
    「往联合里加一个成员而没在表里表态」**在类型上写不出来**（实测 `TS2741: Property 'brand_new_reason'
    is missing`），三处消费者（run 状态 / trace 状态 / 子 agent 交回判定）因此不可能各说各话。
    ⚠️ 比原判要求的 `never` 断言更强：**编译期**就拦，且新增成员时逼你补一行语义。
    配 `tests/types/stop-reason.types.ts`（类型级）：`@ts-expect-error` 是**正控** ——
    谁把表放宽成 `Partial<Record<…>>` / 加 `?? false` 兜底，那条指令就变成未使用 ⇒ 类型检查红。
  - **E6 · `budgetTokens` 的口径文案改准**：它**只估 `messages`** —— system prompt 与 tools schema
    不在这个数里（`policy.ts` 只把 `messages` 喂给 `countTokens`），所以它是「对话历史多大」的尺子、
    不是「这次请求多大」的尺子（真实 input tokens 恒 ≥ 它）。`types.ts` 与该行 `usage-guide` 同改。
  - **E7 · `setAttribute` 的闸口径改准（只改口径，代码未动）**：报告写「无闸」，逐行复核后更准的说法是
    「**不过 `maxEvents` 那道数量闸**、值**不截断**」；有界的部分写清楚（正文受 `maxEventChars` 截断、
    条数受调用点上限约束）。⚠️ 并写明**为什么不顺手加截断**：属性是交付 trace 与增量流**共用的同一份载荷**，
    而 `core/trace.ts` 那条折叠契约（按 `seq` 折回**逐字等于** `snapshot()`）的两端就是它们 ——
    只截一侧就当场毁约（`tests/engine/trace-events.test.ts` 钉着它）。要收就收 run 入口那几条的入参大小。
    ⚠️ **本批顺带订正上一批（#177 / ⑲）的两处计数错**：⑲ 写「P2 表 26 条：11 已落地 / 14 未做」是
    **我的算术错**（逐行数出来是 8 / 17+1），且 ⑲ 的索引表**漏了整行 `K6`**（三态 `system` 的差异）。
    索引表已补齐并逐行改成可数的状态，详见 `spec.md` §10 ⑳ 的订正段。**本批之后的 P2 账：
    26 行 = 12 已落地 / 13 未做 / 1 有意为之。**
- **runtime / container / 文档三处「静默给错东西」收口**（外部深评 K3 / K4 / K6，⛔ **行为变更**）：
  - **K3 · `Run.finish()` 补守卫**：`start()` / `suspend()` 都有守卫，`finish()` 没有 ⇒
    对一条**挂起中**的 run 调它会**静默翻成终态**（挂起带着 `suspendedMessages` 等审批/唤醒，
    翻掉之后宿主的恢复路径再也接不上，零信号）。`Run` 是公开导出 ⇒ 这是对外承诺。
    顺带把 `cancelled` 的**可达性**写进类型注：进程内 `Run` 到不了它（取消表现为
    `stopReason: 'aborted'` ⇒ 记 `failed`），它由宿主（`TaskRecord.status`）落 ——
    同一份联合类型两个消费者、可达集不同，是有意的，但此前没写在类型上。
  - **K4 · async 工厂不再被静默当成值**：容器**同步**解析，`useFactory` 写成 `async` ⇒
    返回的 Promise 被**原样缓存成「值」**，下游注入到 Promise 本身（首次属性访问全 `undefined`、
    零报错、`tsc` 看不出）。现在在 `cache.set` **之前**检测 thenable 并抛 `TypeError`，
    文案给出两条出路（装配前 await 好再用 `useValue`；或包一层 `useValue: { promise }`）。
    检测器**就地写**（`container` 是纯叶子，`layering.test.ts` 里 `container: []`）、
    **覆盖三个分支**（只查工厂等于把同类错留在另两处）。逃逸口配了测试。
  - **K6 · 三态 `system` 的差异进 `usage-guide`**（纯文档）：`string` / `SystemPrompt` 两形态
    会自动追加 `REPORT_HINT`，**函数形态不追加**（有意 —— 返回值由使用者全权决定），
    但使用者此前读不到这个差异。


- **停机窗口里的派发收成唯一入口**（P1-1 / P2-1）：所有「先落库再派发」的路径（`submit` /
  `approve` / `signalTask` / 到期唤醒 / **审批超时兜底** / **`resumePending` 的认领**）形状相同，
  而停机闸原先散在各支里 ⇒ 「覆盖几条路径」成了**靠人记**的清单：上一批修了三支，第四支
  （审批超时兜底，由 `GET /tasks/:id` 的惰性闸驱动，而「停机中照常可轮询」是宿主的明确承诺）
  与第五支（认领循环）漏了 —— 两处都在 `drain()` 返回 `true`（「排空干净」是 SIGTERM 决策依据）
  之后**又起了新 run**。现在闸只在 `#dispatch()` 里判一次；配**源码级穷尽守卫**
  （`this.#execute(` 与 `this.#executeInner(` 各只许出现在自己的那一个家里）⇒ 新增恢复路径而
  绕过派发口时构建红，不靠记性。实证：`tests/transport/drain-race.test.ts`（五条路径各一条
  用例 + 阳性对照）。
- **`approve` 只许批本任务待决的 id**（P1-2）：原先 `decisions` 里多出来的键照样写进
  `rec.approvals`（随每次 `save` 全文重写、并随任务**永久保留** —— 终态也不清），一次调用就能把
  记录从 246 字节撑到 419 KB（实证），反复调用可无限叠加。现在多出任何一个 id ⇒
  **400 + 整批拒 + 记录一字不动**（与 `parseApproveBody`「全有或全无」、`parseEventBody`
  「多一个字段即拒」同一纪律）。**不加常量上限**：单次 approve 能写的键被钉在当前
  `pendingApprovals` 里，跨轮累计也只随真实挂起轮次增长 —— 单次输入无法放大体积。
- 缓冲满的 409 文案按挂起原因分两种说法（`approval`：唯一触发源是 approve、不在投递方手里；
  `timer`：到点自己醒来，approve 对它不适用）。
- **trace 截断在两条缝上都看得见**（P3-1）：`traceLimits.maxEvents` 超限后，run 根上会留**两笔**
  `trace.truncated` —— **起点标记** `{ limit }`（第一笔丢弃那一刻，标「从这里起有缺」）与
  **收尾摘要** `{ droppedEvents, limit }`（交付时的最终计数）。两笔**同时**进交付的 trace 与
  `onTraceEvent` / `subscribe` 增量流 ⇒ 「按 `seq` 折回**逐字等于** `snapshot()`」那条折叠契约
  在截断下**无例外地**成立（此前它在设了上限且真截断时是假的：摘要从不出现在增量流里，
  只是默认不设上限所以没人碰到）。两笔簿记**不占** `maxEvents` 配额（截断时事件数上限是
  `maxEvents + 2`）。⚠️ 起点标记会进交付的 trace —— 有意的：让制品自己标出「从这里断的」。
- **`task.event` 留痕的 `delivered` 改名 `injected`**（P3-2，**可观测面变更**）：口径修正为
  「注入进本段消息流」—— 原名超前于事实（该段若在首个模型请求前中止/失败，事件不进
  持久化历史，但 trace 上已写着 delivered）。消费这条 trace 事件的下游请同步改字段名。

### 修复 · PR #164 复核收口（2026-09-28 ⑨）

- **停机窗口的拒绝不再静默**：`#dispatch()` 在停机中拒掉一条派发时，会打**一条**
  `[agentia] 停机中：…` 的 `console.warn`（说清「谁、什么状态、谁来认领、宿主该做什么」；
  只报一条 —— 窗口里所有记录的原因完全相同）。此前是一条裸 `return`，运维只看到一个停在
  `running` 的任务，无从解释。
- **`drain()` 的契约写全了**：它是**单向闩**（置位后没有复位路径）⇒ 返回 `false`（排空超时）
  同样意味着**宿主必须退出**。否则停机窗口里已落库的记录（`running`/`queued` + 本进程 ownerId）
  在本进程内**没有自愈路径**：`resumePending` 按 `own-process` 跳过、`submit` 已关闭 ⇒
  只能等下一次启动认领（探针实证：认领数 0、`awaitTask` 不返回）。订正 `drain-gate.ts` 里
  「false 不改任何共享状态」那句（`draining` 恰恰是保持置位的），并给 usage-guide §7 加一行
  「`drain()` 之后有些任务停在 `running` 不动」。
- **守卫补上 `#executeInner` 这个旁路**：只钉 `this.#execute(` 拦不住它 —— 绕过它会**同时**
  绕过停机闸与 `active++` / `#streams.open`（`drain()` 会在一条 run 真在跑时返回 `true`）。
- **文案订正**：`submit` 的「进闸与派发之间刚开始停机的窄窗口」**不存在**（`submit` 全同步，
  没有插入点 —— 走 `#dispatch` 是结构一致性，不是行为依赖）；`sse-frames.test.ts` 把
  `trace.truncated` 说成「run 根的 attribute」（它是**事件**）；`api.html` 的
  `createHttpHandler` 行补上 ⑦ 新增的语义级 400。

### 新增

- **run 事件投入口（spec §10 2026-09-28 ref-run-event-input，定案 A3+B1）**：外部系统可以把一条**事件**
  投给一条**挂起**的 run —— `AsyncRunner.signalTask(taskId, event)` 与
  `POST /tasks/:id/events`（与 approve/cancel 对称），醒来时事件进消息历史。
  - 🔒 **投毒面焊成窄的**：事件体是白名单 `{ eventId?, type, payload }`（全是字符串，
    多一个字段 → 400；`payload` 上限与 `maxBodyBytes` 同口径 → 413）—— 外部永远不能
    构造消息块，引擎把它渲染成**一条 user 文本消息**，在未决 tool_use 解决之后注入
    （直接追加到历史末尾会破坏续跑判定：`tailToolUses` 只认末尾一条）。
  - **只对挂起生效**：不存在 → 404；非 `suspended`（含已终态）→ 409；先落库再派发
    （崩在窗口里不丢事件）；timer 挂起收到事件**提前醒**且不沿旧 `wakeAt`。
  - **幂等**：给 `eventId` 就按它去重（`TaskRecord.deliveredEventIds`，随记录落库、
    有界 FIFO）—— 重复投递 → 409；不给则重复投递 = 重复进历史（如实，不假装恰好一次）。
  - **待注入缓冲也有上限（64 条）**：满了 → 409，且**不收下**（文案说清「本次事件没有被
    记录」）—— 定案 B「说出来，不静默」。**不选「丢最旧」**：丢缓冲若不同时摘
    `deliveredEventIds`，发件方重投会拿到「已投递」的 409 而事件其实已经没了（静默丢事件）。
  - **留痕**：续跑段 run 根记 `task.event { injected, event_type, event_id? }`（口径是
    「注入进本段消息流」—— 本轮改名，见上方 [Unreleased] 的 P3-2 条目）；
    离开挂起态时挂起读数照常除名。
  - 新增导出：`TaskEvent`（类型）；`RunInvocationOptions.events` / `TaskRecord.pendingEvents`
    / `TaskRecord.deliveredEventIds` / `AgentRunResult.eventsDelivered`（全部加法，无破坏性）。
    `eventsDelivered` 是引擎对「本段把事件真注入了没有」的如实报告 —— 宿主据此清簿记，
    保证注入后再次挂起也不会在下次续跑**重复注入**（复审探针抓出的缝，已闭合）。
- **sqlite 到期索引（spec §10 2026-09-28 ref-due-index-measure 落地）**：`TaskStore` 新增**可选**方法
  `listDue?(before)`（接口加法，不破自定义 store），`SqliteTaskStore` 实现它
  （派生列 `wake_at` + `(status, wake_at)` 索引；存量库构造期就地迁移并回填，
  列漂移读时自愈）。`AsyncRunner` 的「到期唤醒」那一半扫描有索引走索引
  （10k 记录：全表 list ~38ms → listDue ~0.1ms），没有回退全表、语义不变。
  InMemory / File store **不实现**（它们的 list 本来就在内存里）。
  ⚠️ `resumePending` 的其余三条职责（挂起读数重建 / 审批超时 / 孤儿认领）仍以全表
  `list()` 为输入 —— listDue 只替代到期唤醒那一半。

- **时间挂起（durable timer，spec §10 2026-09-28 ref-defer-until）**：工具可以在**执行期**调
  `ctx.deferUntil(at)` 说「现在还不是时候，T 之后再问我」—— 引擎把该回合收尾成挂起
  （`stopReason: 'suspended'` + `suspendedReason: 'timer'` + 目标时刻 `wakeAt`），
  到点由宿主续跑并**重跑这一批**工具。用途：等批处理作业、等限流窗口、等外部系统回填。
  - ⏱️ **时刻必须是将来**：非有限数或 `at <= now` 当场抛 `TypeError`（该条 `tool_result`
    记 is_error、run 照常往前走，**不**挂起）—— 允许过去时刻会让「醒来 → 再请求同一个过去
    时刻」自己打转。同回合多条请求取**最早**的那个。
  - ⚠️ **整批语义**：挂起是回合级的（协议要求每个 `tool_use` 都有配对 `tool_result`），
    所以同回合**已经执行完**的其他工具会在醒来后**重跑**（副作用重复）。框架把它变成看得见的：
    trace 记 `defer.requested { wake_at, tool_use_ids, discarded }`，真有兄弟工具被作废时
    落一条 `console.warn`。要精确控制就让模型单独调它，或把它做成幂等读。
  - 🩺 **可见性**：`GET /healthz` 新增 `suspended: { approval, timer, nextWakeAt }`
    （本进程口径，与 `inFlight` 同一张表；无时间挂起时 `nextWakeAt` 是 `null` 不是 `0`），
    另有 `AsyncRunner.suspendedSummary`。
  - 🛑 **停机**：`drain()` 之后**不再唤醒**睡着的 run（停机 = 不再往前推）；重启后由新进程的
    首次 `resumePending` 唤醒。取消用 `AsyncRunner.cancel` / `POST /tasks/<id>/cancel`
    （见下「取消 API」）—— 对睡着的 run 它就是「不再醒」的合法出路。
    ⚠️ 这道闸（2026-09-28 复审第二轮补齐）覆盖**三条**把挂起任务推进起来的路径：
    到期唤醒 / `approve` / `signalTask` —— 三者形状相同（先落库成 `running`、再派发），
    落库与派发之间隔着 store 往返的窗口，`drain()` 若在窗口里完成，那条任务会在
    **停机完成之后**才开跑。窗口过后若已在停机：不派发，记录留给下次启动的
    `resumePending` 认领（决定 / 事件都在记录里，不丢）。此前只有到期唤醒那一支有闸。
  - ⛔ **abort 优先于延后**：同回合里工具请求了延后、而 run 又被中止（`runTimeoutMs` 到点 /
    `cancel`），run 以 `aborted` 收尾、**不**挂成 timer —— 否则会到点自己醒来接着跑，
    等于把取消/超时吃掉。
  - 新增字段（**全部加法，无破坏性**）：`ToolRunContext.deferUntil`、`AgentRunResult.wakeAt`、
    `RunMeta.wakeAt`、`TaskRecord.wakeAt`、`HealthResponse.suspended`。另顺手修两处：
    `resumePending` 跳过挂起记录时的原因不再是 `'terminal'` 而是 `'suspended'`（诊断不说错话）；
    时间挂起醒来时的续跑段**不再**重复注入会话历史、且 trace 会 link 上一段 run。
- **旧任务记录的读时归一（迁移垫片，spec §10 2026-09-28 ref-read-normalize-shim）**：store 读回记录时会把 0.9.5 之前
  落库的旧形状归一 —— 状态值 `awaiting_approval` → `suspended` 并补 `suspendedReason: 'approval'`，
  挂起时刻 `approvalPendingSince` → `suspendedSince`（旧键删掉）。**升级不再需要宿主手工改库**：
  此前那种记录读回来会被 `isTerminalTask` 判成终态、`resumePending` 按 `'terminal'` 跳过 ⇒
  一条在等审批的 run 成孤儿（既不续跑、也无法再被审批）。
  - 六个「bytes → 记录」点（`FileTaskStore` 全量扫 + 残行探测、`SqliteTaskStore` 的
    get / byIdempotency / list、`RedisTaskStore` 单键读）收成**唯一入口** `src/store/record.ts`；
    静态守卫：`src/store/*.ts` 里除它之外不得直接 `JSON.parse`。
  - `SqliteTaskStore` 额外把派生列 `status` 拉回与 json 一致 —— 否则外部/DBA 的
    `SELECT status, count(*) FROM tasks GROUP BY status` 会**继续**报旧值。
  - 归一失败/坏 JSON 的取舍与各 store 既有口径一致；本改动**无公共 API 变化**。
- **取消 API（spec §10 2026-09-28 ref-cancel-api）**：`AsyncRunner.cancel(taskId)` 与 `POST /tasks/<id>/cancel`
  —— 在跑的**真中断**、在睡的**不再醒**、在排队的**绝不起跑**，落库 `status: 'cancelled'`
  （**新状态**，与 `failed` 分开：取消不是失败）。
  - 机制是同一条 abort signal，差别在**意图**：`runTimeoutMs` 超时仍然落 `failed`
    （`error.type === 'timeout'`）；取消带 `error.type === 'aborted'`。
  - **不假装**：在跑的 run 不在本进程、或宿主不认 `signal`（2s 宽限内没收尾）⇒
    `TaskCancelError(409)`，记录一个字节不动。
  - 顺带补一个洞：排队期间被取消的任务原先**照样会跑**（认领处不重判状态）。
  - 复审再补两格：abort 后 **reject** 的宿主（包 fetch 类客户端的常见写法）也按意图落
    `cancelled`（不落 `failed`）；同幂等键重提一条被取消的任务会**真跑**
    （去重不再把 `cancelled` 当「已有」）。
  - 另：`awaitTask` 的终态集合改成 `isTerminalTask`（原先手写两值 ⇒ 新终态被漏掉，
    症状是「取消后一直等到超时」）。
- **菜单漂移不再静默（R8 候选 3，spec §10 2026-09-27 ref-menu-drift-signals）**：挂起段之后**续跑**时，未决
  tool_use 引用的工具若已不在当前菜单（删了 / 改名了），框架把这件事记成**三处信号** ——
  `menu.drift` 事件（`{ missing, tool_use_ids, menu_size }`；时间线与
  `GET /tasks/:id/stream` 都看得到）、父 span 的 `menu.drift` attribute（如 `missing:danger`）、
  一条 `console.warn`。⚠️ **run 照常收尾**（不判失败：挂起是合法态、改代码是发布常态 ——
  理由与「严格模式为什么不给」见 spec §10 2026-09-27 ref-menu-drift-signals）。另新增 run 根 attribute
  `tools.names` / `tools.menuHash`（装配后菜单的名字清单 + 名字与**输入 schema** 的摘要，
  与 `prompts.versions` 同动机：质量回归能定位到具体菜单版本）。口径：判据只看名字；签名与
  菜单顺序、schema 键序无关，`description` **不参与**。**公共 API 零变化**。
- **MCP 反向桥（`createMcpServer`，R8-P5）**：把 app 的能力菜单（装配后、过中间件的那份）
  暴露成 MCP server —— Claude Code / Cursor / 任何 MCP 宿主能直接调你的 `@Tool`。
  传输二选一（都只用标准库）：`stdio`（换行分隔 JSON-RPC，日志只去 stderr）与
  StreamableHTTP（POST 收报文回 `application/json`；`initialize` 铸 `mcp-session-id`
  头但**不校验**（无状态 server，宽容是有意的）；GET → 405、DELETE → 200；客户端断连
  中止该次调用的 signal；`auth` 钩子只给缝 —— 读 body 之前、抛错即 401，与
  `createHttpHandler` 同纪律）。协议范围只到 tools（initialize / tools/list / tools/call
  + ping）。**trace 叙事不破**：每次 tools/call 造一棵 trace（run 根 `mcp.tools/call` +
  capability span + 与引擎同形状的 `tool.input`/`tool.output` 事件）投递 `opts.sinks`；
  结果映射与正向桥方向对称（抛错 → 协议层成功 + `isError: true`）。公共面新增
  `createMcpServer` 与 `McpServerApp` / `McpServerOptions` / `McpServer` 类型。
  决策见 spec §10 2026-09-27 ref-mcp-reverse-bridge。
- **租户归因 labels（`labels: Record<string, string>`，R8-P4）**：`createApp` 缺省 +
  `app.run` 单次覆盖（**整体替换**不合并）+ `runAgent` 直连三层同语义。落 run 根的
  `labels.<key>` 属性（trace 侧无基数问题；与框架自写的 `source` 触发来源审计正交）；
  可序列化，异步任务随 TaskRecord 落库、续跑不丢；键空 / 值非字符串在 run 入口抛
  TypeError。进 metrics 是**另一个开关**：`metricsSink({ labelKeys, maxLabelValues? })`
  显式点名哪些键上指标标签（缺省一个都不上），每键相异值数封顶（缺省 100、
  必须为正数），超出折叠进 `__other__`（只丢粒度不丢量），被折叠数见
  `snapshot().droppedLabelValues` 与 `dropped_keys{kind="label:<key>"}`；四个 run 级
  家族（`runs_total` / `runs_failed_total` / `tokens_total` / `cost_usd_total`）在全局
  样本外追加带标签样本（⚠️ 开了以后 `sum(agentia_runs_total)` 会重复计数，总量用
  不带标签的序列）。公共面新增 `RunLabelMetrics` 类型。决策见 spec §10 2026-09-27 ref-tenant-labels。
- **CLI `agentia export`：trace 落盘文件 → 训练数据集**（JSONL，一行一份
  `{ messages, meta }`；R8-P3b）—— harvest（产回归用例）的孪生。开了
  `traceContent: 'full'` 的 run 导出带真 assistant 文本的完整对话；没开的导出工具
  轨迹，缺文本**不造占位**（占位文本进训练数据是投毒），缺口进 `meta.incomplete`。
  过滤：`--ok-only` / `--min-score n`（没带分数的 run 被排除：没判过 ≠ 及格）；
  `--out` 落盘（stdout 是产物的纪律同 harvest）。框架侧 `src/eval/export.ts` 的
  `exportRun` 是 module 级（不进公共面，同 harvestEvalCase 纪律），CLI 侧为去类型
  移植副本 + 逐字对拍守护。决策见 spec §10 2026-09-27 ref-export-training-data。
- **opt-in 记录 assistant 文本进 trace（`traceContent: 'full'`）**：每回合的模型文本落
  该 llm.turn span 的 `output.text` 属性（多块 `\n` 连接；过 `maxEventChars` 同一道
  截断闸 —— 它管「多长」，`traceContent` 管「记不记」）。缺省不记，现状逐字不变；
  纯 tool_use 回合不记。透传子 agent / skill 子循环（`forwarded.ts` 同树同口径）。
  run 根快照记 `config.traceContent`。⚠️ 实测代价：3 回合、每回合约 1600 字符输出的
  run，trace 体积 5 564 → 11 010 字节（约 2×）；且模型输出从此进入要脱敏的面 ——
  出库前走 `docs/observability.md` 配方 2.4。这是「trace → 训练数据导出」（R8-P3b）
  的引擎侧前提。决策见 spec §10 2026-09-27 ref-trace-content-full。
- **模型 fallback 链（引擎级，`fallbacks: [{ model, client? }]`）**：`createApp` 缺省 +
  `app.run` 单次覆盖 + `runAgent` 直连三层同语义。主模型本回合最终失败（含其
  `maxRetries` 用尽）且错误可换（`classifyError` 的 retryable 类：rate_limit / server /
  timeout / connection）时按序换环重试本回合 —— **每一环开自己的 llm.turn span**
  （model 名正确 ⇒ 成本归因与 `usage.unpriced` 探测天然对），切换在新 span 记
  `llm.fallback { from, to, errorType }` 事件，run 根快照记 `config.fallbacks`。
  护栏：`aborted` 永不换（用户取消不是故障）、本回合吐过字不换（与 retry 的
  `!emitted` 同一护栏）、每回合从主环重新起；子 agent / skill 子循环不继承。
  链环 `client` 缺省复用本次 run 的 client（同端点换模型是主用例）；run 入口校验
  坏环/死 client（持久化反序列化空壳）响亮抛 TypeError。决策见 spec §10 2026-09-27 ref-model-fallback-engine。
- **`jsonlTraceSink({ path })`：JSONL 文件 sink 进框架** —— CLI 三件套（`agentia report` /
  `diff` / `harvest`）消费 `trace.jsonl`，而产出侧此前要用户手写 `appendFileSync`（usage-guide
  曾这么教）。现在一行接入：`createApp({ sinks: [jsonlTraceSink({ path: 'trace.jsonl' })] })`。
- **metrics exemplars（指标 ↔ trace 互跳）**：`metricsSink` 记账时跟踪两个代表性现场 ——
  `runs_failed_total` 挂**最近一次失败** run、`run_duration_ms` histogram 挂**迄今最慢** run
  的 traceId/spanId（`snapshot().exemplars` 可见；`export: 'openmetrics'` 与 `'otlp'`
  两个出口会挂上，缺省 `prometheus` 输出逐字节不变）。Grafana 配好 exemplar 跳转后，
  指标尖峰可以一键跳到那条 trace（配置见 `docs/observability.md` §4）。
  内置 `GET /metrics` 路由的 Content-Type 跟 sink 的 `contentType` 走 —— openmetrics 模式
  直接喂给 `createHttpHandler({ metrics })` 即可，不用自己挂路由。
- **摘要渲染折叠纯载荷长串**（#147）：长上下文摘要器此前有三条封顶（图片占位 / 未知块 /
  参数截断），但工具把 base64 这类载荷当**字符串**返回时整段进摘要器。现在连续 ≥4000
  字符的载荷串折成 `⟨载荷 N 字符已折叠⟩` —— 只影响摘要渲染，trace 本体与 token 估算不变。
  （PEM 折行载荷够不着下限，已知边界已在文档声明。）

### 变更

- **挂起改成「一个状态 + 一个原因」：`awaiting_approval` → `suspended` + `suspendedReason`**
  （spec §10 2026-09-28 ref-suspend-state-reason；为 durable timer 铺路）：`RunStatus` 与 `AgentStopReason` 的成员名
  都改成 `'suspended'`，「为什么挂起」由新字段承载 —— `'approval'`（等人工决定）/
  `'timer'`（等一个时刻）。两条判据因此落在**原因**上：`approvalTimeoutMs` 只对 `approval`
  成立、`approve` 对 `timer` 挂起一律 409 —— 否则一条等时刻的 run 会被「审批超时」提前叫醒
  并重派。`TaskRecord.approvalPendingSince` 改名 `suspendedSince`（它本来就是挂起时刻）。
  新增导出 `SuspendedReason`（`api.html` 计数 224 → 225）。**破坏性** —— 迁移见下。
- **脱敏配方 2.4 升级**（`examples/observability` 的 `redactSink`，框架 `src/` 零改动）：
  新增内置正则预设（Bearer / JWT / AWS access key / LLM `sk-` key / 邮箱 / 手机号），
  **缺省全开**（拷走即用），`presets` 可开子集或 `false` 全关；预设命中的替换文案带类别
  标签（`[REDACTED:email]`），自定义 `patterns` 与 `keys` 命中的仍是裸 `[REDACTED]`。
  脱敏不内建进框架是已锁定决策（spec §9.3 / §10 2026-09-14 ref-event-truncation），这是配方层的升级。
- **sink 投递失败不再完全静默**：`flushSinks` 吞掉 sink 异常的纪律不变（观测不击穿业务），
  但吞之前现在会落一条 `console.warn`（文案含「trace sink」，可 grep）——「观测的观测」
  此前是零信号：sink 天天挂、面板一切如常。决策见 `docs/spec.md` §10 2026-09-27 ref-sink-failure-warn。

### 重构（纯结构，零行为变化）· 结构收口（2026-09-28，底盘见 `docs/reviews/2026-09-28/SRC-STRUCTURE-2026-09-28.md` 的落地顺序 1–4）

- **HTTP 宿主拆成三件 —— `http.ts` 拆分第三步**：`src/transport/http.ts` **840 → 306 行**，
  最大单函数 `createHttpHandler` **489 → 123 行**（拆分前这一个函数占全文 58%）。
  同系列前两步（#99 外移形状口径 → `http-shapes.ts`、#100 外移路由判定 → `http-route.ts`）
  移走的都是**纯件**，占大头的那一半（九条路由的**体**）原地不动 —— 于是文件从 533 行又长回
  840。这一步把它搬走：
  - `http-endpoints.ts`（新）= **端点体**：派发表 `handleRoute` + 九条 `handleXxx`
    （读 body → 调 runner → 写响应 → 选状态码）。免鉴权组（`/healthz` / `/metrics`）连同
    它们自己的 405 也在这张表里 —— 表**不认识鉴权**，闸在宿主侧（`handler` 里那两行否定
    条件：「不是免鉴权组才过闸」）。
  - `http-io.ts`（新）= **收发原语**：`sendJson` / `readBody` / `parseJsonBody` / 405 / 413 /
    503 / 500 的机械动作。**零内部依赖**（只 import `node:http` 的类型）⇒ 宿主与端点都引它
    而**不可能**成环 —— 无环是构造性的，不是碰巧。
  - `http.ts` = 宿主契约 + 宿主状态 + 准入/停机。原先散在闭包里的三个 `let`（在飞 run 计数 /
    停机态 / SSE 收口表）收成一个**有名字的对象** `HttpState`，按引用交给每个请求 ——
    「健康检查与停机判断看的是同一个数」这条承诺从此有个明主。
  - **行为零变化**：既有 HTTP 套件 146/146 未改一字全过；公开面（`src/index.ts`）一行未改
    （`HealthResponse` 随实现搬走并在 `http.ts` 转出，与 #99 转出两个形状类型同款）。
  - **配源码级守卫** `tests/transport/http-boundary-guard.test.ts`：端点体绕不开的五个记号
    （`route.kind` / `sse.event(` / 三个形状解析器）必须在端点文件、必须不在宿主文件；准入
    判定只许留在宿主；原语层不许长内部依赖；派发表的穷尽断言必须在场。反向验证过三条
    （放回拆分前的文件 / 删掉穷尽断言 / 给原语层加内部依赖 —— 各恰好一条红）。
  - 顺带修好一条**盯着实现排布而非契约**的守卫：`tests/docs/sse-frames.test.ts` 原先写死扫
    `src/transport/http.ts` 的 `sse.event('…')`，帧一搬家就误红（帧一条没少）—— 改成扫整个
    `src/transport/` 目录。断言方向是「文档提到的 ⊆ 实现 emit 的」，所以扫宽不会假绿。

- **MCP 反向桥拆成三件 —— `createMcpServer` 441 → 47 行**：`src/engine/mcp-server.ts`
  **564 → 409 行**，最大单函数 `createMcpServer` **441 → 47 行**（拆分前占全文 78%）。
  先例是正向桥按传输分文件，于是：
  - `mcp-server.ts` = **协议 + 执行 + 装配**：顶层的 `rpcError` / `rpcResult` / `dispatch`
    （报文分派，两传输共用）/ `callTool`（执行一次 `tools/call`、造一棵 trace）—— 拆前它们是
    441 行闭包里的无名块。`createMcpServer` 只余「读选项 → 造 core → 按 `opts.transport` 挑传输」。
  - `mcp-server-stdio.ts`（新，72 行）= stdio 传输：stdin/stdout 换行分隔 JSON-RPC，
    `process.stdout` 的 EPIPE 必须吞（对端走了的次生现象）。
  - `mcp-server-http.ts`（新，199 行）= StreamableHTTP 传输：POST 收 JSON-RPC、GET→405、
    DELETE→200、`initialize` 发 `mcp-session-id`、客户端断连中止本次工具调用的 `signal`。
  - **无环是构造性的（不照抄正向桥）**：协议与执行经 `McpCore` **注入**给传输，传输只从
    `mcp-server.ts` 取**类型**。正向桥的 `mcp.ts ↔ mcp-stdio.ts` 是**真实的值环**（靠 ESM 函数
    提升侥幸无恙）；反向桥刻意做成注入式单向。
  - **「为什么留在 engine」复核仍成立**：本文件需 engine 侧 4 个值 + integrations 侧 2 个值，
    而 integrations 只许依赖 core ⇒ engine 是唯一能同时够到两边的层（搬走会造出越权边与环）。
  - **不再往下拆传输**（反例）：`startHttpTransport` 172 行 / `startStdioTransport` 57 行属
    「一个宿主的生命周期」，该是一个协作者，且比正向桥同位函数（265 / 235 行）更瘦。
  - **行为零变化**：MCP 反向桥单测 22/22 全过，`npm run e2e:mcp:server` 全绿。

- **`#executeInner`（247 行）的编排归属 = 定案「不拆」**（**零代码改动**，产出是一份有依据的裁定）：
  `async.ts` 最大可调用体 247 ÷ 总行 1690 = **14.6%**、可调用体 **40** 个 ⇒ 按判据属「**大类**」病
  （抽协作者，**别切方法**），而纯协作者已抽过六轮（`slot-pool` / `approval-policy` / `drain-gate` /
  `resume-policy` / `task-waiters` / `task-events`）。它触及 **14 个 runner 内部成员**，外移编排
  等于重建 `AsyncRunner`；且调用结构**早已被** `tests/transport/dispatch-guard.test.ts` **钉死**
  （`#dispatch` = 派发口 / `#execute` = 计数与开流包裹层 / `#executeInner` = 状态机主体）。
  唯一成块的纯件 `callOpts` 装配（~42 行）因「单调用者 + 不产生可守卫边界」也判为不外移。

- **文件级无环守卫 + 断开 MCP 正向桥的**真实值环** —— 第 4 件**：
  - 新增 `tests/architecture/file-cycles.test.ts`：`layering.test.ts` 的 `layerOf()` 取路径第一段，
    **层内环是盲区**；本守卫建**文件级值边图**（Tarjan SCC）断言**运行期无环**。口径只算**值边** ——
    `import type` 运行期擦除、不构成环（`runtime/context ↔ run`、`engine/mcp-server ↔
    mcp-server-{stdio,http}` 两条 type-only 环**留着**）。两条变异反向验证过（注入值边 / 把真实
    `import type` 改成值导入 ⇒ 各恰好 1 条红）；另加「注释里的导入字面量不算边」自证。
  - 断环：桥（`integrations/mcp.ts`）与两个连接器**共用**的协议面（7 helper + 4 结构类型）
    抽到新文件 `src/integrations/mcp-protocol.ts` —— 此前 `mcp.ts` re-export 连接器（值）+
    连接器反向取 helper（值）是一条**真实的值环**（靠 ESM 函数提升侥幸无恙）。抽后成单向 DAG，
    **公共面不变**（`src/index.ts` 未改；`mcp.ts` 继续转出这些符号）。
  - ⚠️ 盘点报告初稿写「两条环的回边都是 `import type`」**是错的** —— 实测 `mcp.ts:350/352` 是
    **re-export 值**。结论与修法见 `docs/spec.md` §10 2026-09-28 ref-structure-closeout 第 4 条。

### 迁移

- **升级前停在 `awaiting_approval` 的任务记录**（`FileTaskStore` / `SqliteTaskStore` /
  `RedisTaskStore` 里已写好的 JSON）：**本版内置兼容读，宿主不需要做任何动作** —— store 读回记录
  时会把旧形状归一（`awaiting_approval` → `suspended` 并补 `suspendedReason: 'approval'`；
  `approvalPendingSince` → `suspendedSince`，旧键删掉），`SqliteTaskStore` 还会把派生列 `status`
  一并拉正。细节与门禁见 `docs/spec.md` §10 2026-09-28 ref-read-normalize-shim。
  ⚠️ 本小节此前写的是「框架**不**内置兼容读、请宿主在升级前手工改库」—— 垫片落地后那段要求
  **已作废**（手工处置仍可行，但不再是必须；在等审批的 run 不会再被判成终态）。
  `SuspendedReason` 仍然是**类型**而不是别名：不为旧值引入第二个运行时名字。

## [0.9.4] - 2026-09-26

> 本版主题（窗口 `0.9.3 → 0.9.4`）：**成本与限制的账本对齐 + 「能不能发」有了判据**。
> 四块内容：① 成本口径补齐（缓存读/写单价，含 1h 档 = 2×；图片按**尺寸上界**估）；
> ② 三个「旋钮设成 0 就静默失效」的洞改成**构造期响亮失败**；③ 大载荷不再灌进摘要器
> （`tool_result` **内嵌**图片块与 `tool_use` 参数两处，实测一张 200 000 字符 base64 的截图
> 此前渲染出 200 086 字符、估算 50 022 token ⇒ 修后 32 字符 / 3 139 token）；
> ④ 评测即发布闸门（配方 + 可拷走的实现 + 守卫）。另含官网的 agent 可读面（每页 `.md` 变体 +
> `Accept: text/markdown` 内容协商）。
> **无破坏性变更**：框架公共 API 与脚手架模板形态逐字未变 —— 三个旋钮的 `0` 原本就
> 「静默不派发 / 拒掉一切 / 流活不过一帧」，现在改成启动期报错，**没有任何本来能工作的配置
> 会因此变坏**；既有使用者不需要任何动作。

### 修复 · 大载荷不再灌进摘要器

- **`tool_result` **内嵌**图片块按尺寸上界估、只给占位**：工具返回截图是生产里最常见的入图路径，
  而此前的「渲染 / 摘要侧只给 `[image …]` 占位、不展开 base64」只覆盖**顶层**图片块。
  实测一张 200 000 字符 base64 的截图：渲染出 200 086 字符（含原始 base64）、估算 **50 022 token**
  —— 修后 **32 字符 / 3 139 token**，与顶层图片同一条口径（内嵌与顶层的估算差 ≤ 3 token）。
- **`tool_use` 的参数同样有界**：同一类「大载荷灌进摘要器」的洞，两处各配回归用例
  （含「小参数不许被截断」的阳性对照），变异验证 4/4 咬人。

### 变更 · 复审收口（2026-09-27，九条「测试没覆盖的缝」）

> 来源：对 R8 五项实现（P1–P5）的逐条复审 —— 单测全绿、全链 8/8，问题全在用例之外。
> 每条的取证与复现读数记在各自提交里；下面按模块列**行为变化**。

- **MCP 反向桥三处**：① `tools/call` 现在走引擎**同一份** `inputSchema` 校验器，入参不合法
  回 `-32602` 且方法体零调用（此前缺必填项被当成功调用，实测返回 `你好，undefined`）；
  ② `auth` 钩子提到方法/路径判定**之前**（此前未鉴权能拿到 `405 allow: POST, DELETE` 与
  `DELETE → 200`，与 `createHttpHandler` 的「其余先鉴权」纪律不符）；③ stdio 的 stdout
  挂了 `error` 守卫吞 EPIPE（此前宿主先关读端会把 server 打成栈回溯 + exit 1；正向连接器
  对子进程 stdin 一直是这么吞的）。
- **`metricsSink` 归因标签补上第四道基数上限 `maxLabelCombos`**（缺省 200，进 limits 真源表）：
  `maxLabelValues` 只封每个键的**值域**，而进内存的是键的**组合**（叉乘）—— 缺省 100 值域
  配 3 个键 = 1,030,301 条常驻，且 `droppedLabelValues` 看不见它。超限的**新组合**折进一个
  全 `__other__` 的桶（量不丢），折叠数经 `snapshot().droppedLabelCombos` 与
  `dropped_keys{kind="label:combos"}` 可见。**单键配置（最常见）组合数 ≈ 值数 ⇒ 行为不变。**
- **标签 combo 身份不再裸拼接**：值里出现 `,`/`=`/`\` 时会给 `\` 前缀转义 —— 此前两个不同
  标签集能拼出同一个键（实测 `a="x,b=y",b="z"` 与 `a="x",b="y,b=z"` 并成一本账、且按前者
  的标签渲染，后者的量被错配）。正常值（不含这三个字符）的键与展示形**逐字不变**。
- **`agentia export` / `exportRun` 三处**：① 汇总现在**也**在 stdout 模式打（走 stderr）——
  此前 `agentia export x.jsonl > dataset.jsonl` 静默丢坏行、而 `--out` 形态与 `report` 都会报；
  ② `incomplete` 新增 `assistant-text` 的**整棵 trace 无正文**判据（混合回合的真文本此前静默
  缺席却不当缺口）与 `no-final-assistant`（末条 user ⇒ 无 loss 目标）；③ 侧产物与 CLI 移植
  副本在「trace 缺 `status` / span 缺 `attributes`」的裸 trace 上不再分叉（框架侧此前会抛）。
  **⚠️ 迁移注意**：`meta.incomplete` 会多出 `no-final-assistant` 这个词 —— 按等值断言
  `incomplete` 的消费方要放宽成「包含」或补上这个词。

### 变更 · 三个旋钮的 `0` 从「静默失效」改成构造期报错

- **`Scheduler.every.maxInFlight: 0`**：闸门判据是 `inFlight.size >= maxInFlight`，`0` / 负数时
  **恒真** ⇒ 每次 tick 都跳过，周期任务**永不派发且不报错**（实测 60 ms 内派发 0 次、无任何日志）。
  现在与 `AsyncRunner.concurrency` 同款在构造期抛 `TypeError`；`Infinity`（关闸门）与缺省 `1` 不受影响。
- **`HttpHandlerOptions.maxBodyBytes: 0`**：实测「每个带 body 的请求都 413」（3 条 POST 全部 413）。
- **`SseWriterOptions.maxBufferedBytes: 0`**：实测「流活不过一帧」。
- 三处都判 `invalid` + 构造期抛错，并接上 `limits.ts`（「限制旋钮的 0 是什么」的单一真源）的
  `zeroClauseOf` 文案单源。⚠️ 还挡一类事故：`Number('') === 0` —— 空的环境变量会静默变成「拒绝一切」。

### 新增 · 成本口径

- **`ModelPricing` 新增 `cacheRead` / `cacheWrite`**（缺省读 0.1×、写 1.25×；**1h 档写 2×** 由
  `priceOverrides` 表达），非法乘数（负数 / NaN）同样构造期抛错。
- ~~未定价模型会「响」~~ **（订正 2026-09-27：这条不是本版新增，发布时误记）**：
  `usage.unpriced` 事件 / 指标 `model_unpriced_turns_total` / `onUnpricedModel` 回调自
  **v0.6.0** 起就在（#75），本窗口对它们零改动。本版真实的成本口径改动只有上面那条
  cache 乘数与下面的图片估算。条目不删、留痕。
- **图片块的 token 按尺寸上界估**：官方按**尺寸**计费（28×28 像素 = 1 visual token），与文件字节数
  无关；框架取「长边缩到 1568px」的上界 3136 token/块 —— 宁可高估（`maxTotalTokens` 提前拦）
  也不低估（护栏迟触发）。

### 新增 · 评测即发布闸门（`docs/eval-gate.md` + `examples/eval-gate/`）

- 把「这一版能不能发」收成一条判据：**回归**（基线通过 → 这次失败）与**删用例**（基线里有 → 这次没跑）
  判不通过；「基线里本来就失败」**放行**（已知债不拦发布）；退出码 `1`（回归）与 `2`（基线坏了）分两档。
- 配方文档 + 可直接拷走的实现 + 守卫（9 条纯函数断言 + 文档↔示例导出面双向覆盖 + e2e 真喂三份
  被改坏的基线）。**`src/` 零改动** —— 框架的职责到「产出结论」为止。

### 新增 · 官网的 agent 可读面（GEO 档 C/D）

- **每页 `.md` 变体**：`packages/website/scripts/build-md-variants.mjs` 在构建末尾从**产物**
  `dist/*.html`（与打分器同源）生成同名 `.md`，正文一个字不丢、剥壳集合与打分器一致。
- **`Accept: text/markdown` 内容协商**：`packages/website/public/_worker.js`（Cloudflare Pages
  advanced mode）只改写带该头的**无扩展名页面路径**，其余（`/llms.txt`、`/robots.txt`、
  `/sitemap.xml`、`/_astro/*`）原样透传，且**任何异常都退回 `env.ASSETS.fetch(request)`**
  —— advanced mode 下所有请求都过它，兜底必须是最外层的那一个。

### 仓库自身（不面向使用者）

- **补两份「口径单测」**（`tests/integrations/mcp-protocol.test.ts` + `tests/transport/http-io.test.ts`，
  2026-09-28，结构收口的尾巴）：这两组 helper 是「桥 + 两个连接器」与「宿主 + 端点」的**共用面**，
  抽成独立文件（断值环 / 拆路由体）后**没有同名单测** —— 行覆盖靠既有套件就够（都是 100% 行），
  但**口径**从没被正面钉过。按 `http-shapes.test.ts` / `http-route.test.ts` 的先例补两份、共 35 条。
  **不追覆盖率**：纯防御分支**刻意不补** —— 典型是 `readBody` 的 `if (done) return`
  （Promise 二次 `resolve` 是 no-op，少这行行为完全一样），为它写断言就是真空变绿。
  ⚠️ 同一轮查清一个会误导人的读数：`src/engine/mcp-server-stdio.ts` 报 **22.22% 行覆盖**不是缺口，
  是**采集假象**（用例走真子进程，c8 只采父进程；实测该用例 22/22 全过），且该数字拆分前就存在。
  变异验证 17/17 逐条咬人。详见 `docs/spec.md` §10 2026-09-28 ref-structure-closeout 第 5 条。

- **补 7 条「正常输入下可达、却从没走过」的功能分支**（2026-09-28，同轮尾巴；跨 3 个测试文件 +8 条用例）：
  先纠正一个读法 —— c8 的 branch **不是 if/else 两条臂**，而是「**代码块**」（全仓条目**全是
  1 个 location**，`b[id]` = 该块被进入的次数，`0` = 这条路径**从未走到**），所以它比语句覆盖细。
  据此排查后补：`toolkit/subagent.ts` 的 **`spec.system` 函数形态**（三态联合里唯一「框架不追加
  REPORT_HINT、作者全权」的一态）；`engine/trace-diff.ts` 的 **status / error 差异**三条判定
  （顺带带出 `errorEqual` 里那句从未执行过的三元组比较，并钉住「比内容不比对象引用」）；
  `transport/async.ts` 的**缓冲溢出** `truncated` 帧与「**已终态后**才连上来」的 `end` 收口；
  `transport/http-endpoints.ts` 的 SSE `stream.truncated` 帧。
  **分母不变大的前提下**：语句 295 → **287** 未覆盖、块 347 → **338**、分支 91.82% → **92.04%**，
  用例 1465 → **1473**。函数那一档**刻意不动**（那 11 个「从未被调用的函数」全是只读访问器，
  另有一个 `TaskEventStreams.forget` 是**未导出的内部死方法** —— 为它写测试等于锁死死代码）。
  变异验证 7/7 逐条咬人。详见 `docs/spec.md` §10 2026-09-28 ref-structure-closeout 第 6 条。

- **`packages/cli/test/inspector.test.mjs` 新增 ⑫「选完文件夹 → 透传给 run 的就是所选目录」**：
  2026-09-24 真用户反馈「选完之后透传给 agent 的不是所选文件夹」，逐环核实后**链路是通的**
  （`createApp` 把显式 `providers` 拼在 discover 结果**之后** ⇒ 模板的 `WORKDIR = opts.workdir`
  赢过目录里扫出来的无 deps 版本；面板 `readControls` 读 DOM 单源，重画只填空值不覆盖已选），
  但**当时没有任何守卫钉着这条链** —— `scripts/e2e-dev.ts` 第 15-ter 步只覆盖 `POST /run`
  **直带** workdir，选择器那一跳（返回值 → 控件 → 请求体）全靠人读码。新用例钉两端接线：
  ① **页面接线**：`/api/fs/pick` 的返回值必须写进工作目录控件，且 `readControls` 从**控件**
  取值（不是镜像 `state`）；② **服务端接线**：把返回值原样喂给 `/run` ⇒ 钩子收到的 `workdir`
  就是它（且不是回落 `defaultWorkdir`）。反向验证三条各自变红（摘页面接线 / 摘
  `parseRunRequest` 的 workdir 转发 / 把 `readControls` 换成镜像 `state`）。

- **`§7 已知边界`（77 行）立守卫**（`tests/docs/boundary-table.test.ts`）：§7 是使用者判断
  「我能不能用这个框架」的唯一依据，此前**零守卫**且被 `usage-guide.test.ts` 的解析器结构性排除
  （那条规则只收「首列恰好是一个反引号标识符」的行，§7 首列是散文 ⇒ 整表零采集）。四条判据：
  标识符不悬空 / 行集合↔登记表双向 / `pin={file,marker}` 可证伪 / 三态（`pin` 38 · `choice` 9 ·
  `gap` 30）+ 下限。`gap` 的语义是「这句话今天为真、明天可能为假而没人会发现」，**不是功能缺失**。
  反向验证 8/8 咬人 —— 变异电池当场抓出第一版 A3 是**假守卫**（子串判定，标题加一个字照样绿）。
- **`killTree` 的平台分派抽成可注入的纯函数**（`packages/cli/src/dev-child.ts` 的 `killPlanFor`）：
  win32 那条 `taskkill /T /F` 此前**在任何平台都跑不到**（直接读 `process.platform`，而 CI 是
  ubuntu、macOS 走 POSIX）。行为逐字不变，新增 6 条用例、变异 4/4 咬人。
- **守卫注册表补登记**：`packages/cli/test/native-pick.test.mjs` 此前没进 `guards.md §1`
  （守卫在、登记缺），已登记并补两条实测反向验证读数。守卫注册表 §1 逐行审计修掉 3 个「假守卫」。
- **工具链自我描述 ↔ `ci.yml` 互为真值**（`tests/scripts/verify-all-wiring.test.ts`）：步骤数 ==
  CI job 名里写死的数字（那是分支保护依赖的必需检查）、每个 job 都被交代、副本不许各说各话。
- **CI 新增 `docker-image` job（非必需检查）**：`examples/deploy` 的镜像此前**没有任何门禁构建过**
  （docker 在本仓 CI 出现 0 次、本机无 docker）⇒ 「服务有门禁、镜像只有这一次构建」如实写进
  `examples/deploy/README.md` 与 `AGENTS.md`。
- **对外文章** `docs/articles/trace-first.md`：把核心卖点讲成一条可核对的故事（每个数字都是仓库
  自己能核对的事实：测试全绿数、三个包 dependencies 全空、8 步验证链、镜像只有一次构建）。
- **推广文案与仓库事实对齐**：修掉 6 类不符（指向别人包的安装命令、会腐烂的时长、硬编码计数、
  写错 scope 的 npm 链接、连不上的域名、**描述了不存在的功能**）。

## [0.9.3] - 2026-09-23

> 本版主题（窗口 `0.9.2 → 0.9.3`）：**dev 面板两个真用户反馈的落地** —— 原生文件夹选择器
> （浏览器拿不到所选目录的绝对路径 ⇒ 走 CLI 本机进程拉 OS 原生对话框）、模板 `read_file`
> 能力的 `list_files`（模型终于「知道自己在哪、里面有什么」）；另含 **CLI 内部结构治理**
> （`dev.ts` 隐式状态机 → 显式状态机、`inspector.ts` 路由表外移）与 **四条仓库守卫**。
> **无破坏性变更**：框架公共 API 与脚手架模板形态逐字未变 —— 新增的是工具与端点，
> 既有使用者不需要任何动作（老宿主不认识的响应字段照旧忽略）。

### 新增 · 原生文件夹选择器 + 模板的 `list_files`

- **模板 read-file 能力新增 `list_files` 工具**（与 `read_file` 同一个类、同一个 provider）：
  真用户反馈「面板上换了文件夹，agent 行为好像没变」—— 链路本身是通的（workdir 确实注入），
  缺口在**模型感知**：run 的 prompt 不变、菜单里没有「列目录」的工具，模型不知道自己在哪个
  目录、里面有什么，只能瞎猜文件名。`list_files` 输出的**第一行就是工作目录的绝对路径**
  （模型「知道自己在哪」的通道），目录名带 `/` 后缀，输出有上限（200 条）且截断**明示**；
  越界判定与 `read_file` 共用同一道闸（`safeResolve`）。零框架改动。
- **dev 面板新增「系统选择…」原生文件夹选择器**：浏览器拿不到所选目录的绝对路径，
  所以走 CLI 本机进程拉 OS 原生对话框（契约 `POST /api/fs/pick`），与既有的 `浏览…`
  文本/列表选择并存。客户端断开（刷新 / 关标签页）会收掉在飞的选择框（不留下
  「之后每次都 409」的后遗症）；macOS 的取消判定认错误码 `-128`（不随系统语言本地化），
  不认英文文案。

### 修复

- **面板刷新 / 关标签页后，「系统选择…」不再永久 409**：原来只靠连接断开（`res.on('close')`）
  收掉在飞的原生选择框，而实测（带插桩的产物副本 + 真浏览器）**刷新页面时那条连接还开着**
  —— 服务端收不到 close ⇒ 选择框留在桌面上没人看、之后每次点都报「已有一个文件夹选择框在等」。
  现在面板在 `pagehide` 时显式通知服务端（新端点 `POST /api/fs/pick/cancel`，`sendBeacon` 发的
  **一次新请求**，与服务端看不看得见断开无关），连接断开那条路**保留**作为兜底（进程直接没了 /
  非浏览器客户端断开仍走它）。两条路互补，各有一条确定性用例守着（`packages/cli/test/inspector.test.mjs`）。
- **复核残留修复一组**（无破坏性变更）：`refreshDev` / `refreshSession` 的失败不再静默
  （进可见通道）、徽标过滤失效 token、折叠键混入 sessionId 防张冠李戴、import 反向全覆盖
  扩到 trace-view 产物、`multiTurn` 笔误进 warning 通道、watcher 错误告警、
  `lastError` 不再被通用文案覆盖、也不再**跨代复用**（spawn 时记基线，只有这一代没写出
  新原因才用通用文案；run 成功即把旧错误从告警条摘下）、双 WORKDIR（registry.ts 与 app.ts）
  混用顺序写进注释（同 token 后注册覆盖先注册，拼错顺序会让面板喂的 workdir 被
  `process.cwd()` 静默顶掉）、模板 `safeResolve` 注明不解 realpath 的已知边界等。

### 重构（纯结构，零行为变化）

- **`packages/cli/src/dev.ts` 1148 → 776 行**：治理前 `devServer()` 是**735 行一个函数、15 个可变
  `let`、40 处写入点、15 个入口**的**隐式**状态机 —— 本轮四条真缺陷（F1 / F4 / G1 / G2）全是它的
  直接后果。现在拆成四件，其中 `dev-machine.ts` 是显式状态机：
  - `dev-logic.ts`（58 行）六个纯判定**单源**（受理闸 / 延后重启 / 退出原因 / 中止幂等 / 能力比较 /
    选择器串行）。判据不再复制 —— `shouldDeferRestart` 直接委托 `canAcceptRun`，
    「两处各写一份 `running || launching`」就是 F1 的复现。
  - `dev-machine.ts`（703 行）`update(state, ev) → { state, effects[] }` **纯函数**（零副作用、
    零 `node:*`）：**26 个事件 / 17 种效果 / 28 条事件矩阵单测**。`child`（runner 在不在）与
    `run`（run 在不在飞）建为**两个正交相位**；`run: 'launching'` 进类型 ⇒ 受理闸写成「非 idle 即拒」，
    F1 那种「漏看一个布尔」**结构上写不出来**；effects 是**判别联合对象**（不是闭包）⇒ F4 那种
    「同一条错误广播两帧」也写不出来；进程句柄不进状态（不可序列化，由接线层持有）。
  - `dev-watch.ts`（224 行）/ `dev-child.ts`（82 行）：监视件与子进程无状态原语各归各家；
    spawn / stop / restart 三个**执行器**留在接线层 —— 它们要读写机器状态、判进程身份归属。
- **`packages/cli/src/inspector.ts` 818 → 413，路由表切到新增 `inspector-routes.ts`（545 行）**：
  14 条路由各抽成命名函数。**纯搬移** —— 路由条件与应答状态码分布（`json` 200×8 / 202×3 / 400×8 /
  403×5 / 404×2 / 503×4、`text` 200×2）与拆前**逐条一致**（机械 diff）。三条边界刻意不动：
  `HttpError` 留在服务侧（跟着路由走会让两个模块互相 import **值** ⇒ 运行期成环）、三道鉴权闸
  （Host / Origin / token）留在服务侧（路由只被已放行的请求调用，写进 `RouteCtx` 头注）、
  `DevHooks` 留在 `inspector.ts`（它的形状被另一条用例当文本断言，路由侧的断言改读新文件）。
- **清掉 `http.ts` 里一条无用的 `case 'notFound':`**（它与 `default:` 之间没有任何语句 ⇒ 等价于
  没有这个 case）：全仓 `biome ci` 输出的最后一条 info 归零 —— 留着它，将来新增的 info 就不显眼了。

### 仓库自身（不面向使用者）

- **四条守卫**把三句「策略声明」变成可执行，`docs/guards.md` §2「待守」随之**清空**（最后一行就是它）：
  - **零运行时依赖**（`tests/architecture/no-runtime-deps.test.ts`）：断言三个面 —— 源码层
    （三个包的 `src/**` 只 import 相对路径 / `node:` 内置）、元数据层（三个 `package.json` 无非空
    `dependencies`）、范围层（`packages/` 下每个包必须登记）。扫描器在说明符位置**把字符串读出来**
    （只遮蔽则说明符自己被吞、只读取则注释与模板里的假阳性全进来），配防真空护栏 + 5 处真实假阳性
    站点的回归钉。
  - **CLI 结构**（`packages/cli/test/structure.test.mjs`）：CLI 是扁平结构、`layering.test.ts` 不适用。
    守 W1 规模棘轮（单文件 / 总量 / 每个文件都登记）、W2 下发浏览器的产物**运行期零 import**、
    W3 源码侧只许 `import type`。⚠️ 面板白屏有**两类**成因、守的是两处 —— W2/W3 守「多了一条依赖」，
    `inspector.test.mjs` 的⑦守「页面 import 了产物里**不存在**的名字」（2026-09-23 真发生：
    `panel-logic.ts` 少四个函数，而 `tsc` 与 `e2e-dev` 全绿 —— 后者走 HTTP API、不加载页面）。
  - **`docs/**` 引用的提交必须真在主干上**（配 CI `fetch-depth: 0`）：2026-09-23 真踩过 —— 计划文档
    写了一个**分支提交**的哈希，那批走 squash 合并 ⇒ 它不在 `main` 的祖先链上，在 `main` 的全新克隆里
    `git show` 直接报未知修订，而这条引用一路合进了 `main`（当时 `docs/**` 的提交引用不受任何守卫）。
    判据两道、缺一不可：只认**真能解析成 commit 对象**的反引号 token（`deadbeef` 这类十六进制词
    硬判会误报），再要求它落在主干的祖先链上。
  - **「0 反射」**（官网首屏 `<b>0</b> 反射` / 特性卡「零反射装饰器」）：拆三面 —— 全仓 12 个
    `tsconfig*.json` 无一打开 `experimentalDecorators` / `emitDecoratorMetadata`（**根闸**：不开它
    `tsc` 根本不发射 `design:*`）、四个发布面根不把 `reflect-metadata` 当模块说明符、源码不出现
    `Reflect.*Metadata` 那 9 个 API；射程 138 个文件（`src/` + `packages/cli/src/` +
    `packages/cli/templates/` + `packages/trace-view/src/`）。刻意**不禁** `Reflect.ownKeys` /
    `Reflect.apply`（框架在用）与 `Symbol.metadata`（标准装饰器提案自己发射它）—— §2 原先猜的守卫
    形状会当场误判 3 处正当用法。
- **`docs/plans/2026-09-23-cli-structure.md` 订正四处失效陈述**：① 引用分支提交哈希 → 改合入提交
  （同一条现在由上面的元守卫守着）；② 「本机**只能**报 4/8」+「绕法本次**没有**使用」→
  「**默认**报 4/8」，绕法写成正面指引（含「别全局设」这条边界）；③ 「在无 shim 的环境跑一次…
  **预期** 8/8」→ **已实测** 8/8（含第 2 / 5 步真的 `clean-dist` 清空重建）；④ 绕法里的「**唯一**」
  —— 实测有两条、射程不同（`CODEBUDDY_SAFE_DELETE_ENABLED=0` 只关 safe-delete 这一路 hook、
  **最窄**；`env -u NODE_OPTIONS` 摘掉整个 composer、更宽）。另：§1 加**快照标记**（那一节是治理
  开工前的事实，故意不改写，但点名路由表与 `STATIC` 白名单现在住在 `inspector-routes.ts` ——
  否则读者会去 `inspector.ts` 找一个已经不在那里的东西）。
- `docs/guards.md`：四条新守卫登记进 §1，文件数 20 → 26（该行是**活的**登记，不是历史记录）；
  `AGENTS.md` / `docs/spec.md` §10 / `docs/usage-guide.md` 同源面同步。

## [0.9.2] - 2026-09-22

> 本版主题（窗口 `0.9.1 → 0.9.2`）：**dev 面板的可读性** —— 模型正文按 Markdown 渲染、
> 滚动分层（整页不滚、只滚该滚的那块）、长正文默认折叠。
> **无破坏性变更**：框架公共 API 与脚手架模板形态逐字未变。

### 新增 · dev 面板的正文 Markdown 渲染

- **模型正文按 Markdown 渲染**（最终回复 + 对话视图的助手轮）：标题 / 粗斜体 / 行内码 /
  围栏码（带语言标注）/ 列表 / 引用 / 分隔线 / 链接。此前是一整块 `<pre>` 纯文本，
  长回复里的列表与代码块糊成一坨。
- 解析器是**自己写的**（`packages/cli/src/markdown.ts`，纯逻辑、零依赖、带单测）：
  引 `marked` + `DOMPurify` 等于把两份第三方产物塞进 dev 链路，而且它们**没法被本仓单测验证**；
  这套子集不到 200 行，每条规则都有用例。安全前提是**按构造不产生 HTML** —— 解析器只产出
  token 树（没有「HTML 透传」这一类），渲染层只准用 `createElement` / `textContent`
  ⇒ 模型输出里的 `<script>` 只会是字面文本。链接协议过白名单（`http` / `https` / `mailto`），
  不合法（`javascript:` 等）**整条降级成字面文本**（连 `[]()` 一起显示）。用户轮保持字面 ——
  那是「我打的字」，按 Markdown 重排会像面板改过我的输入。

### 变更 · 面板滚动分层：整页不滚，只滚该滚的那块

- 此前右栏没有高度上限 ⇒ 内容一长就是**整页滚动**，而 `footer` 还粘在底部盖住内容。
  现在改成应用外壳：`html/body` 卡 100vh、`body` 不滚；左栏页签固定、列表自己滚；
  右栏**只有调用树是滚动区**（它随 span 数无界增长），回复 / 能力排行 / 用量固定在下方、
  各有上限（回复很长时在**它自己那块**里滚，而不是把树推出屏幕）。
- 窄屏（≤860px）回落成单列 + 整页滚动 —— 两栏并排在那个宽度下都不可用。

### 变更 · 长消息折叠：明确的「展开 / 收起」

- 超过 12 行或 1200 字符的正文默认折叠（卡 216px + 底部渐隐），下方左对齐一个
  「展开全文（共 N 行）▾」按钮，展开后变「收起 ▴」。**短正文不挂控件**（挂一个是噪声）。
- 判定走纯逻辑 `collapseDecision`（带单测）：按**行数 + 字符数**，不量像素 —— 像素阈值在
  字体 / 缩放 / 窄屏下会漂，同一个回复在不同机器上折叠与否都不一样。展开态活在渲染之外
  （面板每次全量重画，状态留在 DOM 里会被下一次重画合上）。

### 修复

- **CLI 套件里两条文件监视用例在全链下稳定假红**（`packages/cli/test/panel-logic.test.mjs`）：
  夹具原来「**写一次**、然后轮询等满 15 秒」，而真 fs 的监视器**建立是异步的**（`fs.watch`
  返回 ≠ 底下 FSEvents 流已开始投递）—— 那一次写整个漏掉时，**等多久都没用**。复现条件最后
  定位到 **stdout 被管道捕获**（`verify-all.sh` 的 `out=$(bash -c …)` 与 CI 都是这么跑的）：
  管道下稳定红、重定向到文件稳定绿；单跑套件也是绿的。改成 `writeUntilSeen`（反复写、直到
  回调真的来，上限 15 秒）—— **断言没放宽**（那个路径仍必须触发一次回调，只是不再要求
  「第一次写就被看见」），四条「不该触发」的负向用例一条未动。
  ⚠️ **仅测试侧，无使用者可见行为**：生产里 dev 环**先建立监视、再对外服务**，不存在
  「`watchTree()` 一返回用户就改文件」这个窗口。

### 文档

- `docs/usage-guide.md` §2.2：按使用者口吻补三段 —— Markdown 渲染口径（含协议白名单与
  「用户轮保持字面」）、滚动三层各管一段、长正文折叠阈值与展开控件位置。
- `docs/guards.md` §1.4：新增 `markdown.test.mjs` 一行（两条安全断言：按构造不产生 HTML、
  链接协议白名单 + 两条反向验证），并把 `inspector.test.mjs` 那行的反向全覆盖**扩面**记上
  （覆盖所有自建模块 + 四条页面级不变量）—— 是**扩面**，别读成「多了五条守卫」。
- `docs/spec.md` §10 2026-09-22 **⑨**：本轮三处可读性改动的现场证据与修法，外加两条踩坑
  （反向验证的变异体**必须能编译**，否则构建先失败、门禁空跑；对被格式化过的文件做 patch
  时 `old_string` 用了格式化**前**的版本，靠「改完立刻回读」才发现）。
- `docs/plans/2026-09-22-dev-debug-loop.md`：补本轮三处的落地记录。

## [0.9.1] - 2026-09-22

### 新增 · dev 面板的实时右栏（在飞就看得到调用树）

- **右栏从「收尾才有」变成「一个个长出来」**：runner 订阅框架的增量记账出口
  （`onTraceEvent`，0.8.3 已落地）逐笔 `POST /ingest-event` → 父进程**原样**广播
  （SSE 的 `dev` 命名事件多一类 `trace-event`）→ 面板按 `seq` 折回一棵**临时**的树。
  收尾那份整棵 trace 回来时**覆盖**它（缺的 span 由那份补齐）。纪律与框架同名出口一致：
  **不保证送达**，所以刷新页面之后早先那些 span 不会回来（收尾那份会补）。
  计划 §D7 的评审补充点名要求的那条（P1b 面板侧工作）这轮落地。
  折回逻辑是**纯逻辑 + 单测**（`panel-logic.ts` 的 `applyTraceEvent`），e2e-dev 另有一条
  「帧必须先于 run-done 到达，且折回逐字等于收尾的整棵 trace」的真进程断言。

### 变更 · 工作目录选择器：文件可选、隐藏目录可达、`浏览…` 不再是开关

- **文件也能选**：`GET /api/fs` 现在分三类回（`dirs` / `dotDirs` / `files`；文件有上限，
  超限时回 `filesTruncated`）。点文件名 = 工作目录取它**所在的**目录 + prompt 为空时填文件名
  （你已经写好的 prompt **一个字不动**）。旧形态只列目录 ⇒「让 agent 看某个文件」只能靠自己打名字。
- **隐藏目录单列**（不再整批过滤）：`.git` / `~/x/.y` 这类目录以前**根本点不进去**
  （`..` 只能退到它上面，进不去）。
- **`浏览…` 不再当开关**：以前面板开着时再点一次只是把它关掉，于是「在输入框敲了路径 → 点浏览」
  这个最自然的动作是**把面板关掉**。现在点它**总是**按输入框里的路径打开，点面板外面收起。

### 修复

- **跑完的回复被面板自己擦掉（端到端实测 17 ms）**：`run-done` 与「这条 trace 的收尾帧」
  几乎同毫秒到达，而 `open()`（收尾帧触发的自动打开）**无条件**清回复 ⇒ 刚写上去的那句立刻没了，
  表现是「run 完成了，但面板上没有回复」。现在按「这条 trace 是不是这段回复的主人」判
  （`panel-logic.replyBelongsTo`）：打开**别的** run 的 trace 照样清（防张冠李戴），
  打开**刚跑完那一轮**的不清。
- **在飞的树被收尾帧骗成「已完成」**：`playTrace` 以前对根 span 没有 `endedAt` 的树也调
  `finish()`（根被标成 `●` + 耗时），而在飞时那是**假事实**。现在根没结束就不收尾（留 `◌`）——
  该分支只对「在飞 / 截断」的树生效，收尾的整棵 trace 行为逐字未变。

### 文档

- `docs/usage-guide.md` §2.2：补「右栏是实时的」（含两条边界）与工作目录的三个点击语义。
- `docs/guards.md` §1.4：本轮在**既有三行**登记上扩面（`panel-logic.test.mjs` 增四组折回 / 归属 /
  浏览目标 / 选文件后的 prompt，`inspector.test.mjs` 增三项 HTTP 面，`e2e-dev.ts` 增第 7-bis 步），
  见该节 —— 是**扩面**不是新增行，别把它读成「多了五条守卫」。
- `docs/plans/2026-09-22-dev-debug-loop.md`：§D7 那条评审补充标注 **P1b 已落地**（增量出口接线）。
- `docs/spec.md` §10 2026-09-22 **⑧**：本轮三处体验缺陷的现场证据与修法（右栏实时 / 回复被擦 /
  选择器），外加一条发版流程教训（反向验证脚本必须先 commit）。

## [0.9.0] - 2026-09-22

> 本版主题（窗口 `0.8.3 → 0.9.0`）：**dev 调试环落地** —— `agentia dev` 从「`tsx watch` 跑你的
> `main.ts`」变成「**常驻 runner 子进程 + 本地 inspector 面板**驱动你的 `src/app.ts`」，
> 四个控件（能力选择 / 工作目录 / 多轮 / prompt）都在面板上；顺带补上「**中止在飞 run**」与
> 「**清空对话**」两个操作，以及一轮复核修复（9 条，含 5 条严重：窄窗口竞态、收尾路径、
> 同一事实两个表面口径不一致）。
>
> ⚠️ **含破坏性变更，但只在脚手架模板形态上**（下面的迁移小节写了要做什么动作）：
> 模板把「装配」与「启动」拆成两个文件（新增 `src/app.ts` 工厂），老工程不迁移的话
> `agentia dev` 会**明确报错**（不是静默降级成一个驱动不了任何东西的空壳）。
> **框架本体的公共 API 无破坏性变更**：没有删签名、没有改默认行为 —— 已有工程照常
> `npm start`；受影响的是「在工程里敲 `agentia dev`」这条开发期路径。

### 破坏性变更 · 脚手架模板：装配与启动拆开（新增 `src/app.ts`）

**要做的动作**：把老工程 `src/main.ts` 里的 `createApp({...})` 整段搬进新的 `src/app.ts`，
包成一个**工厂函数**；`main.ts` 只留「读 `.env` → 调工厂 → `app.run` → 处理 `result.error`」。

**为什么**：`agentia dev` 的调试环要把「这次调哪个能力 / 工作目录是哪个」喂进 `createApp`，
而**只有调用者能设这些选项**。拆出工厂之后 CLI 才是调用者 ⇒ **工程里一个 dev 文件都不需要**
（只多一个**数据**文件 `src/dev.config.ts`）。不迁移的后果是**明确报错**，不是静默降级：
`agentia dev` 会指出 `src/app.ts` 缺失并打印迁移说明。

**最小迁移**（对着 `agentia create` 新生成的工程看最省事）：

1. 新建 `src/app.ts`：把 `main.ts` 里的 `CAPABILITY_DIRS` + `discover` + `createApp({...})` 搬进去，
   改成 `export async function createAgentApp(opts: CreateAgentAppOptions = {})`。老的那段可以**原样**搬
   —— 第 3 步不做也能跑，只是面板上的「工作目录」旋钮不生效。
2. `src/main.ts` 改薄入口：`import { createAgentApp } from './app.js'`（**注意 `.js` 后缀**）→
   `const app = await createAgentApp();`，删掉 `createApp` 的 import 与 `CAPABILITY_DIRS`。
3. （要「工作目录」真生效就得做）在 `providers` 里加 `{ provide: 'WORKDIR', useValue: opts.workdir ?? <项目根> }`，
   并把需要工作目录的能力从 `discover` 挪到显式 `providers` 声明 `deps: ['WORKDIR']`
   —— **`discover` 自动注册的 provider 没有 `deps`**，拿不到注入值。
4. （可选）新建 `src/dev.config.ts` 声明多轮（`export default { multiTurn: ['trip-planner'] }`），
   并给 `.gitignore` 补一行 `.agentia/`（dev 环的对话历史落盘处）。

### 新增

- **面板的「中止」按钮：中止在飞的 run（`POST /run/abort`）。** 此前只做了「在飞时拒绝第二次
  `POST /run`（409）」这一半 —— 后果不是小事：**一个卡住的 run 会让面板永久锁死**，
  此后每次运行都 409，而面板**没有任何办法**解开它。
  实现走 IPC 让 runner 自己 `abort()`，**不是**父进程杀子进程 —— 理由是 **trace**：
  `RunInvocationOptions.signal` 是契约字段（原样送进引擎），中止后在回合边界以
  `stopReason='aborted'` **正常返回**（`engine/loop-result.ts` 的 `abortedResult()`）
  ⇒ **trace 照常落盘**。杀进程那条路会把这次 run 的 trace 整个丢掉。
  ⚠️ signal 是**协作式**的：工具不读它就没人理（「MCP 在途中止 ⇒ Promise 永不 settle」正是这一类），
  `running` 会永远为 `true` ⇒ 所以补一条兜底：**5 s（`ABORT_GRACE_MS`）后仍没结束就重启进程**，
  此时这次 run 的 trace 会丢，面板**明说**这一点（不静默）。
- **面板的「清空对话」按钮（`POST /session/clear`）。** 清空 = **换一个 `sessionId`**，
  **不删** `session.json` —— 后者是 `SessionStore` 的账，面板对它**只读**（写它会造出
  「面板显示的对话」与「模型真正看到的对话」不一致）。旧对话仍在盘上、run 列表里也还指得到，
  只是模型不再带着它跑。当前 id 落盘到 `.agentia/dev-session-id`（**不是** `session.json` 的一部分）：
  只放内存的话，重启 `npm run dev` 之后刚清空的对话会**自己回来**；该路径已在监视排除清单里，
  写它不触发重启。id 由**父进程**决定并经 IPC 下传 —— 它是面板级状态，必须跨 runner 重启稳定。

### 变更

- **`agentia dev` 从「看 trace」补上「驱动 run」**：面板上多四组输入 —— prompt 输入框（带 `↑`/`↓` 历史）、
  能力多选（缺省全选；收窄的是**菜单**，主 agent 仍在环里 —— 别的能力 `tools` 里的显式引用仍能调到
  被排除的那个）、工作目录选择器、多轮开关（按能力声明，混选取 **OR** 且面板**标出来源**）。
  `npm run dev -- "你的问题"` 仍可直接带上第一句。
- **文件监视收编进 CLI**：`agentia dev` 不再叠一层 `tsx watch`（旧形态有**两个重启主人**，保存的瞬间
  恰好点运行会双双 spawn），自己按**允许清单**看文件 —— **`.md` 必须在里面**：文本资产
  （`@Prompt` 拉的 `.md`、子 agent 的 `system.md`）不在 tsx 的 import 图里，旧实现改它们
  **静默无感**（改了没反应、也不提示）。排除 `node_modules` / `dist` / `.git` / `.agentia` / `coverage`
  —— `.agentia` 那条不是洁癖：它是 dev 环自己的对话历史，看它就变成「每次 run 重启一次」的自噬循环。
- **重启与不重启的边界**：改代码或改**能力选择** ⇒ 重启子进程；改**工作目录** / prompt / 多轮 ⇒ 不重启。
  在飞 run 期间的重启**延后**到它结束。⚠️ 重启能力选择的理由**不是贵**（进程内重建实测 **2.6 ms**，
  初稿的「几秒」高估约两个数量级），而是**回收口**：框架没有 `AgentApp.close()`，MCP 连接器由用户代码
  持有 ⇒ 进程内反复重建会攒孤儿 MCP 子进程。配套硬约定（写进模板注释）：**进程外资源一律在模块作用域
  创建并注入**，不许在 provider 构造函数里建。
- **dev 环鉴权（两层，零依赖）**：`Origin` 校验（**缺失放行** / `Origin: null` **拒绝** / 跨源拒绝）
  + **每次启动生成的一次性 token**（首帧 `?t=` → `HttpOnly; SameSite=Strict` cookie；脚本走
  `x-agentia-token` 头；`timingSafeEqual` 比较），**每个端点**都校验。token 挡的是**本机其它进程**
  （它们能 `curl`、不受 `Origin` 约束），**别把它当网络边界** —— 面板只绑 `127.0.0.1`。
- **dev 环缺省预算护栏**：面板上「点一下 = 一次**真** run」⇒ 缺省套
  `{ maxCostUsd: 1, maxTotalTokens: 200_000 }`（可用 `dev.config.ts` 的 `budget` 覆盖）。
- **模板 `@SubAgent` 的 `system` 改函数形态**（`() => asset(...)`）：值形态在**类定义时**求值 ⇒
  `system.md` 要重启进程才生效，而 `.md` 不在 tsx 的 import 图里 ⇒ 静默失效。
  通则：**模块加载期读 = 冻；调用期读 = 热**。
- **去掉 `NODE_OPTIONS=--import` 注入**：子进程改跑 CLI 自己的 `dev-runner.js`，
  连带那条 Node ≥ 20.6 / ≥ 18.19 的版本闸与字符串拼接一起删掉。
  ⚠️ 代价是顺序变成**承重的**：必须在 import 用户 `app.ts` **之前** `await registerTraceSink()`
  —— `createApp` 在构造时就把 `defaultSinks` 快照下来了。
- **脚手架自带 `read-file` 工具**：读**工作目录**下的文本文件，根由 DI 注入（`WORKDIR`）——
  它是「面板上那个文件夹选择器真的生效」的接线。越界**响亮报错**，不静默截断。
- **脚手架自带 `src/session-store.ts`**（`FileSessionStore`，**原子写**：临时文件 + rename）
  与 `src/dev.config.ts`（**数据**，不是逻辑）。

### 修复（dev 环真跑一次抓出来的 —— 上面那些改动全绿时它们照样在）

- **`agentia dev` 起不来：`npx` 吞掉了 IPC 通道。** 子进程原本是 `spawn('npx', ['tsx', runner])`，
  而 `npx` 是包装器、**不给孙进程转发 fd 3** ⇒ runner 里 `process.send` 是 `undefined`，
  代码写的是 `process.send?.()`（可选链）⇒ 所有协议消息**静默丢弃**：面板等不到 `ready`、
  `POST /run` 永远不回来，且进程会以 `code=0` **干净退出**（看起来像「用户代码跑完了」）。
  改成 `node <tsx/cli>` 直起（`resolveTsxCli()`：用户工程优先，退到 CLI 自身；不走
  `node_modules/.bin/tsx` —— Windows 上那是 `.cmd` shim，会绕回 CVE-2024-27980 那个坑）。
- **`npm run dev` 读不到 `.env`（`npm start` 读得到）。** 上一节把模板拆成 `app.ts` / `main.ts` 时，
  `loadEnvFile()` 留在了 `main.ts`，而 dev 环只 import `app.ts`、**从不执行 `main.ts`**。
  失败形状是静默的：用户看到「没配 key」，然后去怀疑框架。已挪进 `src/app.ts`。
  ⚠️ 当时**两处**断言都钉着这件事，但都指着 `main.ts` —— 断言存在 ≠ 钉对了位置，现已改成成对断言。
- **面板能力选择器空着且无解释。** `DevEvent` 有 restart / error / run-start / run-done，
  **唯独没有「就绪」**；而面板加载时只查一次 `/api/dev`，那时 runner 还没装配完
  （拿到的是父进程初值 `[]`）⇒ 菜单要等用户先跑一次才填上。新增 `{ kind: 'runner-ready' }` 广播。
- **「runner 没起来就退出」广播了一句更没用的原因。** `exit` 处理器先 `fail()`（reject）再同步
  `emit`，而那时 `lastError` 还是 `null` ⇒ 面板收到笼统的「意外退出」，真正的原因只进了终端
  （reject 要到下一个微任务才被 catch 接住）。改成先写 `lastError` 再 reject。
- **新增 `scripts/e2e-dev.ts`**：`agentia dev` 整条链真跑（此前**零覆盖**），四条行为断言
  （IPC 就绪 / `.env` 生效 / 能力收窄真的收窄了请求体 / 改 `.md` 触发重启且能恢复）。
  折进 `verify-all.sh` 第 7 步（`npm run e2e`），不加步骤。
- **中止的 run 被三个地方各自当成「失败」（同一个事实的三个影子）。** 引擎的 `abortedResult()`
  **刻意**给已取消的 run 带上结构化 `error`（取消不是失败，但原因要可查），而 runner 的
  `ok` 定义是 `!result.error` ⇒ **中止时 `ok` 也是 `false`**。于是：
  ① 面板把「我按的中止」显示成「run 失败（aborted）：run 已被取消」；
  ② `dev.ts` 把它写进 `lastError` ⇒ 告警条上永远挂一条红字、且不会再消；
  ③ 终端打成「run 失败（stopReason=aborted）」。
  三处统一为「**先认 `stopReason` 再认 `ok`**」，并把面板那一处的判别抽进 `panel-logic.ts`
  （顺序是**语义**，不是渲染 —— 面板那份没有单测）。
  判别口径此前只活在注释里，且**写错了**（写成「中止是正常返回、`ok` 两者都是 true」——
  那是把「不抛异常」误当成「不设 `error`」）。
- **`watchTree` 的目录跳过判据是「半实现」的**（追一次**瞬时红**追出来的 —— 一次完整门禁里
  CLI 套件红过一次、重跑又绿，没当噪声放过，连跑三次复现后隔离到 watch 用例）。
  `WATCH_SKIP` / 点开头此前**只在「初始递归」那一个调用点**执行，而 watcher 回调里发现新目录时
  调 `addDir` 走的是**另一条路**、那条路上一次判据都没有 ⇒ 行为是「启动时就存在的 `dist/` 不看、
  **启动后才出现**的 `dist/` 看」。判据已收进 `addDir` **内部**（唯一一处），`root` 由调用方
  显式豁免 —— 判据只看**目录名**、不看路径段（项目根本身就叫 `dist` / `.foo` 是合法的；
  用绝对路径段去认 `dist` 会把整个项目判成「不该看」）。
  ⚠️ 真跑时的**第一层**防护是**监视根**：`devServer` 只 `watchTree(<projectRoot>/src)`，
  而 `.agentia/` 与 `dist/` 在项目根、根本不在范围内。`WATCH_SKIP` 是**第二层**，两层都要有 ——
  只靠根的话，哪天有人把根改成项目根，`.agentia/session.json` 会立刻变成
  「每次多轮 run 重启一次子进程」的自噬循环。
  ⚠️ **这一轮最值钱的不是修好，而是照出一条「假守卫」**：我给 e2e 加了一条「重启次数总账 +
  理由里不许出现 `.agentia` / `dist/`」的断言，反向验证时**单测红了、e2e 照样绿** ——
  逐条排除后确认不是「修复没生效」也不是「断言写错」，而是这条缺陷在 e2e 里**不可达**
  （监视根是 `src/`）。也就是说那条断言真正守的是「**监视根保持 `src/`**」，它**碰不到**
  `WATCH_SKIP` 那条路。断言是真的、绿的、也是对的，只是它守的是**另一件事** ——
  所以 dev.ts 与 e2e 两处的注释都已照实改准（说清哪条守哪件、以及它**不守**什么）。
- **改 `.env` 不会重启（文档承诺了、代码够不着）。** `WATCH_NAMES` 把 `.env` / `.env.local`
  列进允许清单、`usage-guide` 也把 `.env` 写进「看什么」，但 `watchTree` 的根是
  `<项目根>/src`，而这两份文件在**项目根** ⇒ 这条判据**没有任何一个 watch 够得着**，
  改 `.env` 静默无感。与上面那条是同一类的两个面：**判据认得它**（`shouldWatch` 有单测、
  写得也对）≠ **有人够得着它**（根在调用点决定）。
  新增 `watchRootEnvFiles()` 单开一个 watch：**不递归**、且**只认名字**（不认扩展名 ——
  项目根的 `package.json` 也不该由它管）。刻意**不**把 `watchTree` 的根抬到项目根：
  那会把 `README.md` / `docs/` / `examples/` 全收进来，「改代码要重启」就变成「改任何文档也重启」。
  两处 watch 共用抽出来的去抖器（各写一份会漂 —— 比如只有一处清理 `timer`，停机后仍会回调一次）。
  ⚠️ **这条只有真跑能守**：根是**调用点**决定的，`watchTree` 自己无从知道该看哪儿 ——
  所以钉它的是 `scripts/e2e-dev.ts` 第 9-bis 步（真改一次项目根的 `.env`）。

### 修复（复核轮：四条窄窗口 / 口径缺陷 + 两条顺手抓出的）

同一天对这轮 dev 环改动做了一次逐条回读代码的复核（决策链见 `docs/spec.md` §10 2026-09-22 ref-review-round-fixes）。
下面每条都补了**反向验证**（把修复摘掉 ⇒ 新加的门禁真的会红）：

- **并发闸没盖住「换能力选择 ⇒ 重启」那条路径**（双击运行会真并发两次）。受理到 run 真正发出去之间
  有 `await restart(...)`，而 `running` 只在 run 发进通道之后才置位 ⇒ 两个请求双双通过检查，
  runner 里两个 run 并发、`currentAbort` 被覆盖、CLI 侧记账挂到别人的 traceId 上。
  现在多了个只给闸看的 `launching` 占位（刻意不并进 `running`：「中止」按钮据此仍只在真在飞时出现）。
- **Ctrl+C 会丢掉 SIGKILL 兜底 ⇒ 不响应 SIGTERM 的子进程树活成孤儿**。旧的 SIGINT 处理器固定
  50 ms 就 `process.exit(0)`，而 `stopChild()` 给子进程的宽限期是 3 s（SIGTERM 后等满才补 SIGKILL）——
  父进程先没，那段宽限连同兜底一起消失，`process.on('exit')` 那条也已空转。现在等收尾真的做完再退
  （另有 5 s 硬上限兜「面板连接没关掉」这类卡死，再按一次 Ctrl+C 立即硬退）。
- **「中止」落在装配窗口里会被静默丢弃**。`runOnce` 是先 `await ensureApp(...)` 再建 AbortController，
  窗口内到达的中止只能看到「没有在飞的 controller」⇒ run 照跑，而父进程 5 s 后把这次**健康的** run
  升级成重启兜底（trace 丢掉、原因还写成「工具不响应 signal」）。现在窗口内的中止会被记住并立即补上。
- **被中止的 run 在面板上被标成「失败」**（通知条已修好，但 run 列表的红点与对话视图的红边走的是
  `ok` —— 中止的 `ok` 同样是 `false`）。判别统一到 `panel-logic.runIsFailure`（先 `stopReason` 后 `ok`），
  且**中止轮仍留在对话视图里**（框架只在成功路径回写会话，排除它会显示一份少了一轮的对话）。
- **会话文件损坏时只在 dev 环告警**（`FileSessionStore` 自己会响亮抛错，但框架在 load / append 里
  刻意吞掉会话侧异常 —— 既定口径「辅助动作不击穿 run」）⇒ 历史被当成「第一轮」且新历史写不进去，
  全程无声。现在 runner 在**启动期**探测一次，把原因送进既有的 warning 通道（面板告警条）。
- **`agentia dev -- "你的问题"`**：裸 CLI 形状会把分隔符 `--` 当成 prompt 传给模型
  （`npm run dev -- "…"` 那条因为 npm 吃掉 `--` 而一直是对的，两条形状都文档化了）。现在两者都取到真 prompt。
- **模板 `read-file` 未归一化工作目录**：工作目录带尾斜杠时（面板输入框 / `dev.config.ts` / 从 Finder
  粘过来都常见），越界判定 `abs.startsWith(root + '/')` 恒为假 ⇒ **每一次**调用都报「路径越出工作目录」。
  那不是误报，是工具整个变坏，且错误归因会把模型带偏。
- **模板 subagent 的 `system.md` 补上「你的回复就是报告」约定**：模板这轮把 `system` 改成了**函数形态**
  （改 `.md` 立刻生效），而框架只对**值形态**追加 `REPORT_HINT` ⇒ 函数形态下子代理不知道自己的最终回复
  就是交回主 agent 的交付物，措辞差异没有任何测试看得见。约定现在写在模板自己那份 `system.md` 里。

### 修复（#121 第十一轮复核收口 —— **发布时漏记，2026-09-23 补记**）

- **`GET /tasks/:id/stream` 新增 `stream.closed` 帧（流级收尾，API 面）**：任务在**别的进程**
  跑、且还**没到终态**时，旧实现发一帧 `stream.unavailable` 之后没人关流 —— 心跳照打、
  连接永挂。现在紧跟一帧 `stream.closed` 并关闭连接。刻意**不**发 `task.end`：
  那是「任务终态」的语义，拿来收尾等于伪造终态。
- **MCP stdio 连接器：请求在途中被中止时 Promise 永不 settle**（旧实现只删簿记不 reject，
  响应帧按 id 找不到人）⇒ 直接 `await` 连接器 API 的宿主**永久挂起**。现在中止即 reject
  `AbortError`，与 HTTP 连接器同口径。
- **`AsyncRunner.streamBufferEvents` / `TaskEventStreams.retainTerminal` 的坏值不再静默**：
  `0` / 负数 / 小数 / `NaN` / `±Infinity` 一律**构造期抛 `TypeError`**。旧实现里 `NaN`
  在两条链上失效方向相反且都静默：前者是「每任务内存闸整条不拦」，后者是「无订阅者的
  终态流全被清空」。`0` 的读法两者刻意不同：`streamBufferEvents` = invalid（配置错误），
  `retainTerminal` = disabled（「不留终态流」是有意义的设定）。
- **指标**：同毫秒连按两次 `reset()`，窗口起点也**严格前进**（`windowStart` 收为 `private`，
  唯一写者是 `reset()`）；`dropped()` / `onDrop` 补了可测面（丢弃计数与回调同口径，
  错误 run 永不丢且不计）。
- 内部：e2e 端口 TOCTOU 修根因（删 `freePort`，改 `PORT=0` + 解析就绪日志，顺带拆掉
  上一轮的 `startExampleRetrying()` 症状补丁）；官网守卫把 `og:url` 纳入 URL 口径、
  llms.txt 链接从前缀匹配改为链接目标集合精确比对（旧判定下删掉首页链接照样绿）。

### 文档

- `docs/usage-guide.md` §2.1 / §2.2（新）：脚手架文件分工 + `agentia dev` 的四组输入 / 监视规则 /
  重启边界 / 鉴权 / 成本 / 会话历史；§6.4 补「对话历史从哪来」与**两层「历史」**的区别
  （prompt 回显模型看不见；对话历史真的进上下文，且只在开了多轮时出现）。
  §2.2 另补一条「**看哪里**」—— 此前只写了「看什么扩展名」，没写监视根（`<项目根>/src` 整棵树
  ＋ 项目根单独的 `.env` / `.env.local`）⇒ 读者无从知道「改项目根的 `README.md` 不触发重启」。
- `docs/spec.md` §10 2026-09-22 ref-dev-loop-drive-run：本轮决策记录，含「**P0–P2 全程零框架改动**」的逐项核对。
  §10 2026-09-22 ref-dev-loop-real-run：真跑探针抓出的两个缺陷与三条修复（含反向验证记录）。
  §10 2026-09-22 ref-doc-vs-code-audit：拿功能文档逐项对照做审计 —— 又抓出两处「文档里有、代码里没有」，
  以及「同一条事实的第三个影子」（中止的 `ok` 是 `false`）。
  §10 2026-09-22 ref-watch-skip-half：追一次瞬时红 → `WATCH_SKIP` 的半实现 + 那条「守了另一件事」的假守卫。
  §10 2026-09-22 ref-dotenv-unreachable：拿 ⑤ 的「监视根」去核每条判据 → `.env` 是一条**够不着**的判据
  （含「判据的正确性 vs 可达性」与「探针别用写死序号」两条可复用的教训）。
- `docs/guards.md` §1.4：新增五条守卫登记（面板纯逻辑 + watch 允许清单 / dev 环鉴权与 HTTP 面 /
  生成物能力名一致性 / `agentia dev` 整链真跑 / `.env` 接线成对断言），并随 ④ 扩面
  （`nextSessionId` / `runDoneNotice` / `POST /run/abort` / `POST /session/clear` /
  面板 import 名单反向全覆盖 / e2e 第 10-11 步）、随 ⑤ 再扩面（`watchTree` 的**动态新增目录**
  用例 + e2e 第 12 步重启总账，并注明 e2e 第 12 步**不守**什么）、随 ⑥ 三度扩面
  （`watchRootEnvFiles` 的名字过滤用例 + e2e 第 9-bis 步改项目根 `.env`）。
  §2 尾注补三条可复用的自查问。
- `docs/plans/2026-09-11-dev-inspector.md`：非目标清单修订 —— **`run 重放执行` 仍然不做**，
  面板做的是「发一次**新的** run」，两者相邻但不同。

## [0.8.3] - 2026-09-21

### 变更

> 本版主题（窗口 `0.8.2 → 0.8.3`，含 #115 与 #116）：**增量 trace 出口落地**。记账与交付之间
> 此前**没有缝** —— `TraceRecorder` 的唯一出口是收尾的 `snapshot()`，所以「等不了 run 收尾」
> 的消费者（终端面板 / SSE 前端 / 异步任务进度流）拿不到任何东西。本版补上那条缝，顺手把
> spec §7 F3 的两条后置项与 §9.4 的记录成本问题同日收口。
> **框架 API 无破坏性变更**：只新增（`onTraceEvent` / `traceLimits.maxEvents` /
> `AsyncRunner.streamBufferEvents` / `GET /tasks/:id/stream` / `/run` SSE 的 `trace.event` 帧），
> **既有签名、既有三帧 SSE、既有默认行为逐字不变** —— 不认识新帧的老客户端行为零变化。
> #116 全部落在**仓库自身**（守卫 + 一次行为等价的重构），不含任何运行时行为变更。

### 新增

- **`onTraceEvent`：run 进行中逐笔拿记账事件**。`RunInvocationOptions.onTraceEvent`（单次）与
  `AppOptions.onTraceEvent`（应用级缺省）**叠加**（应用级在前）而不是覆盖 —— 观察者是注册不是
  值覆盖，覆盖会让「某次 run 顺手传了个面板回调」把应用级那条静默顶掉。载荷是
  `TraceRecordEvent`（`span.begin` / `span.end` / `span.event` / `span.attribute` / `span.link`，
  **增量 + 此刻的拷贝**）。
  四条纪律：同步派发不 await（订阅者是观察者，不该把 run 变成它的调度）、抛错被吞（与
  `flushSinks` 同款）、无订阅者零派发、**seq 每次记账动作都占号**（与有没有订阅者无关 ——
  否则「订阅晚的人」看到的序号会与一直订阅的人不一致，重放与去重都会错位）。
  它与 `TraceSink` **不互相替代**：sink 是收尾拿整棵、不保证运行期可见；这条是运行期逐笔、
  不保证送达。要「收尾的整棵」继续用 sink。
- **`POST /run` 的 SSE 新增一族 `trace.event` 帧**。帧名取**一族** + body 里带 `type`，而不是
  每类型一帧：将来加新事件类型时，老客户端只是漏掉一种 `type`，而不是漏掉一种**帧名**（后者
  更隐蔽）。既有三帧（`text.delta` / `run.end` / `error`）逐字未变。
- **`GET /tasks/:id/stream`：异步任务的进度流**。从头重放 → 转实时 → 终态以 `task.end` 收口关流；
  `Last-Event-ID` / `?from=` 指**流自己的序号**（一个任务可能跨多个 run 段 —— HITL 挂起→恢复、
  崩溃重投，每段是独立的一次 run、`seq` 从 1 重来，而流的读者要的是一条**连续的**流）。
  四条边界：`awaiting_approval` **不是终态**（流继续开着 —— 关掉的话「等审批结果的前端」正好在
  最需要的时候断线）；这条流的读者是**旁观者**，背压 / 断开**不 abort 任务**（与 `/run` 的 SSE
  刻意相反：那里的下游是 run 的所有者，背压等于「别继续烧 token 了」）；跨进程（别的 runner 跑的
  任务、同一个 store）→ 一帧 `stream.unavailable` + 终态 `task.end`，**不假装实时**；缓冲超限 →
  丢最旧并先发一帧 `stream.truncated`（**不静默**）。缓冲用 `AsyncRunner` 的
  `streamBufferEvents` 调（缺省每任务 500 条；终态流只留最近 16 条）。事件**不落 store** 是有意
  的：实测事件数 = 2 × 工具调用、正文 KB 级 ⇒ 每条工具调用要把 KB 级正文写库两次（写放大），而
  宿主本来就有自己的总线（`onTraceEvent` 就是给它的缝）。
- **`traceLimits.maxEvents`：整条 trace 的事件总数上限**。超限即**停止记账**，交付时在 run 根写
  一笔 `trace.truncated{droppedEvents, limit}` —— 缺口位置可预测（尾巴）且**有计数**。
  刻意**不做**环形缓冲（丢最旧、留最近）：那会让 trace 中间出现空洞，而空洞比「尾巴截断」难解释
  得多（「这一回合怎么没有工具事件」）。`0` = 一条都不记（**有意义的值**，仍有计数）；不设 = 不限。
  坏值（NaN / ±Infinity / 负数 / 小数）在 run 入口抛 `TypeError` —— 静默接受会让闸门**形同不存在**
  （`NaN` 让 `>=` 恒假），而使用者以为自己设了上限。
  与既有的 `maxEventChars` **正交**：一个管「单个事件正文多长」、一个管「多少」。

### 文档

- `docs/usage-guide.md`：`onTraceEvent` / `traceLimits` / `streamBufferEvents` 与
  `GET /tasks/:id/stream` 的用法；§7 边界表补任务进度流的边界（内存 / 跨进程）。
- `docs/observability.md`：采样在「不内建」之外补上**可算 + 可数** —— §2.3 新增采样率换算表，
  示例 `sampleSink` 增加丢弃计数（`dropped()` / `onDrop`）。**框架仍然不内建采样器**（既有决策
  不变：采样是配方 2.3，`examples/observability` 已有成品；再造一个就是同一件事的两份实现）。
- `docs/spec.md` §9.4 从「唯一剩下的开放问题」变为**决定**：默认全量、截断默认开、采样不内建，
  框架侧只新增「数量上限 + 丢弃计数」这一件 —— 让「少记了数据」可数。
- **一处面向使用者的说明被更正**：`formatTraceparent` 的 flags 继续恒 `00`，但理由从「本框架
  不采样」改为**「运行期不可知」** —— 记录 / 导出决策发生在**收尾之后**，出站调用发生在
  **运行期**，那时没有答案。所以它**不会**跟随采样率变成 `01`：原理由在采样成为推荐配法后已不
  严谨，若照它改成「跟随采样」反而是错的。

### 仓库自身（不面向使用者）

- **`docs/guards.md` §2 从 4 行清到 1 行** —— 三条待守形状建成了机器守卫（`0` 的语义真源 /
  穷尽转发 / 队列消费者配方门禁），细节见该文件 §1.2 / §1.3。顺带登记了两个此前无人写明的事实：
  `intervalMs` 在 `Scheduler.every`（必须 > 0）与 `metricsSink`（`0` = 立即导出）里**同名反义**；
  数量类旋钮里只有 `mapWithConcurrency` 把 `0` 读作「不限」（`maxRetries` / `maxEvents` /
  `maxIterations` 都是「就是不做」）。
- `scripts/verify-all.sh` 与 CI 的**步数不变**：新增检查一律折进已有步骤（步骤数写在 CI 的必需
  状态检查名里，加一步就要同时改 workflow 与分支保护）。

**迁移**：无（框架 API 无破坏性变更，既有代码不需要任何改动）。若你的宿主自己解析 `/run` 的 SSE，
它**不需要**认识新的 `trace.event` 帧 —— 不认识就忽略，行为与升级前逐字一致。要消费增量事件，
新接 `onTraceEvent`（程序内）或 `GET /tasks/:id/stream`（远程看进度）即可。

## [0.8.2] - 2026-09-21

### 变更

> 本版主题（窗口 `0.8.1 → 0.8.2`，含 #112）：**外部双模型复核逐条复现收口** —— 9 条真缺陷
> （7 条复核成立 + 改的过程中照出的 2 条），全部落在「不报错地不干活」这一类：静默丢观测数据、
> 静默无限重试、无声永久挂起、生成出来的工程一跑就崩。
> **框架 API 无破坏性变更**：只新增一个选项（`createOtlpExporter({ onExportError })`），
> 既有签名与行为在「你没传坏值 / 没按 200 当全部成功」的前提下逐字不变。
> **一处需要你确认的收紧**：`maxRetries` 的坏值改在**构造期抛错**（见「修复」与「迁移」）。

### 修复（观测出口 —— 三条都属于「看板少数据而框架说一切正常」）

- **OTLP 导出的 `status.code` 从名字符串改成整数**（`'STATUS_CODE_OK'` / `'STATUS_CODE_ERROR'`
  → `1` / `2`）。OTLP 规范对此是**明文 MUST**，而且专门点出它与 protobuf 的通用 JSON 映射不同：

  > *Values of enum fields MUST be encoded as integer values.*
  > *Unlike the standard Protobuf JSON Mapping, which allows values of enum fields to be encoded as
  > either integer values or as enum name strings, only integer enum values are allowed in OTLP JSON
  > Protobuf Encoding; the enum name strings MUST NOT be used.*
  > —— [OTLP 规范 · JSON Protobuf Encoding](https://opentelemetry.io/docs/specs/otlp/)

  （同期 `kind` 一直是整数 1，只有 `status` 漏了。）**后果取决于你那侧 collector 的宽容度**：
  照规范校验的实现会判非法并**整批拒收**（也就说这些 span 在采集端**根本没落库**，而框架侧只看得到
  「HTTP 200」）；按通用 protobuf JSON 映射的宽容实现（enum 名与整数都收）能落库。
  受影响范围：**`v0.2.2` → `v0.8.1`**（`createOtlpExporter` 自 `v0.2.2` 起就带这个错）。
  动作：升级即可，不需要改代码。**但请顺手去采集端确认一眼**这期间（用严格 collector 的话）
  的 trace 是否为空 —— 你的实现属于哪一档，看那里比看本文档准；丢掉的**历史数据补不回来**。
- **HTTP 200 不再等于「全部接收」**：collector 可以回 `200 + partialSuccess` 表示「收了一部分」。
  此前 `res.ok` 为真就算成功 ⇒ 少了一半数据也没人知道。现在「**真拒收**（键在场且值 > 0）
  **或**非空 `errorMessage`」判为导出失败；`{}` 与 `rejectedSpans: 0` 仍算全部接收
  （有 collector 恒发这种形状，不能反着误报）。
- **新增 `createOtlpExporter({ onExportError })`**（与 `metricsSink` 的同名选项对称）：
  不给，维持既有行为（抛出 → `flushSinks` 吞掉，观测失败不击穿业务）；给了，**所有**导出失败
  （非 2xx / 超时 / **HTTP 200 但部分接收**）都交给它。存在的理由：`TraceSink` 的失败缺省是
  **静默**的，「导出其实少了一半数据」这类消息得有人能收到 —— 否则它和「一切正常」在监控上
  看不出区别。
- **`metricsSink` 的 `reset()` 语义明确为「开启新窗口」**：计数清零**且**数据点起点前移。
  此前 `reset()` 只清计数、而数据点的 `startTimeUnixNano` 取自 sink **创建时刻的常量** ⇒
  同一 `startTime` 下 counter 从 2 退到 1（CUMULATIVE 指标的契约是「同一区间单调不减」，
  后端会算出负增量或直接丢样本）。同一毫秒内连按两次 `reset()` 时起点也**严格**前进。

### 修复（其余）

- **`maxRetries` 的坏值改在构造期抛 `TypeError`**（`createAnthropicClient` /
  `createOpenAIClient`，两条适配器共用一份判定）。重试判定是 `attempt >= maxRetries`，于是
  四类坏值此前被**静默接受**、后果各不相同：`NaN` ⇒ 比较恒假 ⇒ **无限重试**；`Infinity` ⇒
  永不达到 ⇒ **无限重试**；`-1` ⇒ 静默变成「不重试」；`1.5` ⇒ 实际只允许 1 次（读数上看不出来）。
  使用者以为自己设了上限，实际没有 —— 429 场景下每多一次重试都是真金白银。
  **`0` 与不传仍然合法**（`0` = 不重试，是有意义的值；缺省 2）；坏的是「非整数 / 负数 / 非有限」。
- **已中止的 MCP 调用不再发请求、不再永久挂起**：此前的写法是「把 pending 条目删掉、然后照样
  `write`」⇒ ① 副作用请求**仍然送达** server（取消在传输层是无效的）；② 返回的 Promise
  **永远不 settle**（条目已删，没人能 resolve/reject）⇒ 调用方**永久挂起**
  （引擎侧靠 `toolTimeoutMs` 兜底才没炸）。现在判据在 `write()` **之前**，以 `AbortError` 收场
  （取消不是超时，记账仍归 `aborted`）。发送**之后**才中止的，请求已在路上、取消不了 ——
  那是「不等了」，与 `toolTimeoutMs` 同口径。
- **异步 store 下同键并发提交不再重复执行**：`submit` 是**同步门面**、无法 await 异步 store 的
  `byIdempotency`，而 `#executeInner` 只采纳已 `succeeded` 的既有记录 ⇒ 「同时提交两个相同
  `idempotencyKey`」在异步 store（Redis / SQLite）下**两次都执行**（文档承诺的同键去重实际只对
  同步 store 成立）。现在补一张**进程内认领表**：认领在同步前段完成（两次连续 `submit` 之间
  没有窗口），且**只在终态释放**（挂起还在等人，放了会让同键另起一个任务）。
  **边界（同时写进 `usage-guide` §7）**：修的是「同进程内并发提交」这一档；**跨进程并发**与
  **终态之后重提同键**仍是 at-least-once（store 的 idem 索引 last-wins）。
- **`@migor/cli`：模板漏写 `scripts/clean.mjs`**。本版首次给脚手架模板加「构建前先清 dist」，
  并在发布前发现 `create.ts` 忘了把该脚本写出去 —— 生成的新工程 `npm run build` **第一步就
  `MODULE_NOT_FOUND`**。**已发布版本（≤0.8.1）的模板不含这一步，你此前生成的工程不受影响**，
  也不需要改；本版发布的是修好的形态。仓库自身与模板的构建现在都先清 dist（`tsc` 不会删除
  它不再产出的文件 —— 目录重构后旧产物会原样进包），并新增「模板目录 ↔ 源码双向引用」守卫
  （模板文件必须被引用、每个 accessor 必须有调用方）与 e2e 的**真删能力再重建**对照。

### 仓库自身（不面向使用者）

- e2e-cli 的构建步骤从「测试复刻 `clean → tsc → copy-assets` 三步」改成**字面跑产物自己的
  `npm run typecheck` / `npm run build`** —— 这条改法当场照出上面那条真缺陷（测试复刻命令的
  版本照不出来）。同时删掉一条会在合法重构时误报的字面量断言。
- `docs/guards.md` §1 增补五条守卫（OTLP enum + partialSuccess、CUMULATIVE 窗口起点、模板重建
  清 dist、幂等键进程内认领、模板 ↔ 源码双向引用）；`docs/spec.md` §10 ⑤ 记逐条定性、
  反向验证与「报告自称已证伪」的抽查范围。
- `tests/docs/usage-guide.test.ts` 把 `OtlpExporterOptions` 登记进成员表校验 —— 新增选项自此
  被文档守卫钉住（注入假成员验证过会红）。

**迁移**：无（框架 API 无破坏性变更，既有代码不需要任何改动）。唯一需要动作的是 `maxRetries`：
如果你此前给它传过 `NaN` / `±Infinity` / 负数 / 小数，升级后**构造期会抛 `TypeError`** ——
这是有意的（它此前是静默失效），改成非负整数即可；传 `0` 或不传的代码不受影响。

## [0.8.1] - 2026-09-21

### 变更

> 本版主题（窗口 `0.8.0 → 0.8.1`，含 #107–#110）：**出站链路传播** —— spec §9.2 那条
> 「出站传播仍开放」的项收口。**无破坏性变更**：只新增一个公开函数；既有 API、trace 形状、
> OTLP 导出值与 id 生成本身全部逐字不变（id 投影只是从 `integrations/otlp.ts` 的私有函数
> **上移到** `core/trace.ts` 成为单一真源，取值一字未改）。

### 新增

- **`currentTraceparent(): string | undefined`**（出站链路传播）：给出**当前调用期** span 的
  W3C `traceparent`（`00-<32位trace>-<16位span>-00`），自己带在出站请求上（`fetch` 头 / gRPC
  metadata）。下游若也是 agentia（或任何认 `traceparent` 的服务），就能把「谁触发了这次调用」
  关联到**具体 span**，而不是只到 run 粒度：

  ```ts
  import { currentTraceparent } from '@migor/agentia';

  const tp = currentTraceparent();
  await fetch(url, { headers: { ...(tp ? { traceparent: tp } : {}) } });
  ```

  粒度：普通工具与 `@Prompt` **不建 span**，取到的是发起它们的那次 `llm.turn`；`@Skill` /
  `@SubAgent` 方法体内取到的是自己的 `capability` span（内层覆盖外层）。入站那一半
  （`traceparent` 头 → run 根 `links`）已随 0.6.2 落地，本版把出站补上，跨服务关联从此双向。

### 已知边界（同时写进 `usage-guide` §7）

- **只给读取器，不替你做注入** —— 框架不创建出站请求，注入那一行是宿主的（与「webhook 用
  sink + 你自己的 `fetch`」同一条既有决策）。
- `run` 根 span 由 `runAgent` 打开 ⇒ 更早的 `contextInit` / 记忆水合取到 `undefined` —— 那时
  确实还没有 span 可指，不编造。
- flags 位恒 `00`：本框架不采样（每次 run 全量记账），不替下游声明「已采样」。
- id 宽度：内部 id 是 UUID，出站与 OTLP 共用**同一份**投影（trace 去横线 32-hex、span 截
  16-hex）⇒ 下游收到的 span id 与 collector 里那个**是同一个数**（各写一份会让同一次调用在
  两个系统里出现两个 span id）。

### 仓库自身（不面向使用者）

- 第七 / 第八轮复审散件沉淀进 `docs/guards.md` 附录 B，并立「多 agent 同仓作业」三条纪律
  （结论钉 commit / 门禁跑隔离导出树 / 不碰别人的未提交改动）。
- 出处链更正：spec §10 的「132 条直接用例」→ **127**（逐文件计数，独立复核不可复现 132），
  全仓口径改引「+140 条（`tests/` 增量）」；覆盖率棘轮分支 85→88 / 函数 92→95。
- 新增两条守卫并入册：id 投影**单源**（OTLP 与出站必须同一个数）、出站**调用期作用域**
  （并行不串 / 内层不外泄），两条都做过承重性反向验证。
- 发布面清单的 lock 项改为**按包名锚定**：裸 `"version"` 计数会被**恰好同版本号的第三方
  依赖**撞网（本次真发生：`@grpc/proto-loader` 恰好 @0.8.1 ⇒ 闸门报「4 处应为 0.8.1，实际
  命中 5 处」，读起来像漏项）。夹具同步加了同版本诱饵，断言它既不被替换、也不进网。

**迁移**：无。既有代码不需要任何改动；要开始用出站传播，就在出站请求上加一行 `traceparent`。

## [0.8.0] - 2026-09-21

### 变更

> 本版主题（窗口 `0.7.2 → 0.8.0`，含 #83–#105）：**CLI 机器可读面 + 脚手架生产路径修复**。
> 框架运行时 API 零变化；窗口内 23 个提交里 13 个是纯结构拆分（AsyncRunner / turn / loop /
> http 外移判定面，零行为变化），其余大多是仓库自身的门禁与测试加固。
> **一条必须看的修复**：用 ≤0.7.2 的 `agentia create` 生成过工程的，
> `npm run build && npm start` 一跑就崩（discover 目录是 cwd 相对写法，生产形态下会去加载
> `src/` 的 `.ts` 源码）。缺陷在**生成出来的工程里**，升级 CLI 不会自动修好已有工程 ——
> 迁移办法见下方「迁移」。

### 新增（CLI）

- **`agentia --version` / `-v`**：打印 CLI 版本（读包自身 `package.json`）。
- **`report` / `diff` / `doctor` 支持 `--json`**：stdout 只输出一个 JSON 文档，可直接进
  管道与 CI；出错仍走 stderr + 退出码 1，且 stdout 保持空。`harvest` 刻意不加
  （它的 stdout 本身就是产物）；`dev` 额外参数原样透传给用户脚本。
- **脚手架把 `@migor/cli` 写进生成工程的 devDependencies**（与框架同 `^` 版本），`dev`
  script 改为 `agentia dev`：`npx agentia …` 走本地 bin —— 离线可用，且版本被 pin 住与
  框架同批（不 pin 的话老工程会被 npx 拉到最新 CLI）。

### 修复

- **脚手架生成工程的 discover 目录按本文件位置解析，不再是 cwd 相对字符串**（本版最高
  优先级）：旧模板生成的工程 `npm run build && npm start` 必崩
  "Invalid or unexpected token"（生产形态下去加载 `src/` 的 `.ts` 源码，而装饰器不是
  可擦除语法），换个 cwd 启动连目录都找不到。**0.7.2 及之前所有版本生成的工程都带此
  缺陷。** 新写法按 `import.meta.url` 相对本文件解析（开发态 `src/`、构建后 `dist/` 都
  成立），并过滤不存在的分类目录（空分类 tsc 不产出 `dist/<分类>/`，「这类暂时没有能力」
  不该让启动失败）。

### 迁移

- **用 ≤0.7.2 的 `agentia create` 生成过工程的**：把工程 `src/main.ts` 的 discover 段
  换成新模板的写法（重新 `agentia create` 一个同名工程对照抄过来即可 —— 核心是目录按
  `new URL(d + '/', import.meta.url)` 解析 + `existsSync` 过滤这两处）。
  框架 API 本身无破坏性变更，`@migor/agentia` 与 `@migor/cli` 升到 `^0.8.0` 即可。

### 内部（不影响使用者）

- 纯结构拆分 13 件：AsyncRunner 五步（SlotPool / approval-policy / DrainGate /
  resume-policy / TaskWaiters）、`turn.ts` 四步、`loop.ts` 三步、`http.ts` 两步 ——
  判定面有名字、编排留在原处，零行为变化（#85–#100）。
- Biome 零告警闸门：93 warnings + 12 infos → 0，verify-all 第 1 步与 CI lint job 翻
  `--error-on-warnings`（#84）。
- 计时断言不再卡预算边界、改用单调时钟量（#102 / #103）。
- 覆盖率棘轮门禁（c8：行 95 / 分支 85 / 函数 92）+ e2e-cli 折入「npm pack → 离线安装 →
  装出来的包真跑最小 run」（#104）。
- CLI 模板从字符串升级为真文件（`packages/cli/templates/`，生成产物逐字节不变）（#105）。

## [0.7.2] - 2026-09-20

### 变更

> 本版主题（窗口 `0.7.1 → 0.7.2`，含 #77–#81）：**第九轮评审收口** —— 一条高优先级的
> **HITL × `sessionStore` 组合破口**（挂起任务恢复后历史翻倍、成功后又把坏会话写回去），
> 外加六条中/低优先级的静默失效修复；其余是纯结构重构、回归测试补课与依赖升级。
> **无破坏性变更，不需要改代码**：所有修复都是「旧行为本来就不该那样」。
> **两处错误归类收紧（记账口径，不是行为变更）**：Anthropic 流内 4xx 不再落成可重试的
> `server`，异步宿主的 `runTimeoutMs` 超时不再落 `unknown`。宿主若按 `error.type` /
> `errorKind` / `retryable` 分支（重试、告警、看板），取值会更准 —— 见下方两条。
> 本条目的多数内容**是在本次发版时回填的**：窗口内 5 个 PR 都没写 CHANGELOG，
> 条目按各提交正文重建。

### 修复（第九轮评审收口）

- **HITL × `sessionStore`：挂起任务恢复后会话历史翻倍 + 成功后毒化会话**（本版最高优先级）：
  恢复段曾把 session 再注入 `app.run`，而挂起段落库的 `suspendedMessages` 已含完整历史 ⇒
  run 层 `loadSession` 又 prepend 一遍（历史翻倍、token 复利）；且成功后 `appendSession`
  会把含未决 `tool_use` 的整段扩展历史写回会话 —— 该会话**下一轮直接撞 API 400**
  （孤立 `tool_use` + 连续 assistant）。现在恢复段不再注入 session，会话回写改由
  `AsyncRunner` 按「本轮用户输入 + 最终回复」补，口径与 `run.ts` 的三条不变量一致。
- **惰性审批超时 `#expireAndResume` 补重入闸 + 进闸后重读 store**：异步 store 下两个并发
  `poll` 各拿到一份 `awaiting` 副本 ⇒ 双双填超时拒绝、**双双派发**（同一任务跑两遍）。
  现在与 `approve` 共用同一把 per-taskId 在飞闸。
- **MCP StreamableHTTP 连接器不再丢弃 `abandoned`**：`tools/call` 把引擎的「放弃等待」
  信号透传到在飞 `fetch`（含会话 404 自愈那次重试）—— 裁判放弃后真能掐掉请求，
  而不是继续在后台烧。stdio 侧 #75 的 `pending` 出簿修复这次补上了回归用例。
- **Anthropic 流内 `error` 事件的 status 反推补 4xx 档**：`invalid_request_error` /
  `authentication_error` / `permission_error` / `not_found_error` → 400（归 `api`、
  **不可重试**），与 `openai.ts` 同口径。此前这些确定性病因落 500 + `retryable:true`，
  引擎会白重试 3 次（3 次网络请求 + 3 倍等待）。
- **异步宿主 `runTimeoutMs` 的超时错误不再落 `unknown`**：改用 `core/timeout.ts` 的
  `TimeoutError`（`code='timeout'`），与引擎工具超时 / MCP 桥兜底同口径。归类由
  `unknown`（`retryable:false`）变为 `timeout`（`retryable:true`）—— 这只是**记账口径**：
  超时按定义属可重试故障，框架**不会**因此自动重跑整个 run，要不要重试仍由宿主决定。
- **`FileTaskStore.save` 改为先落盘、成功后再更新内存**：落盘失败时内存不再推进，
  避免内存与磁盘两本账、重启后静默回退（`get` / `byIdempotency` 查不到未落盘的记录）。
- **Anthropic SSE 组装拦畸形 `content_block_start.index`**：超大 index（如 `1e9`）会造出
  稀疏数组、后续 `for...of` / `reduce` 按 `length` 空转；现在畸形 index（负数 / 非整数 /
  超上限）响亮抛 `AnthropicApiError(500)`。

### 重构（纯结构，零行为变化）

- `integrations/metrics.ts`（1050 行）→ `metrics-state.ts` / `metrics-render.ts` /
  `metrics-otlp.ts` / `metrics.ts`（只留选项校验、定时器与组装）；
  `integrations/mcp.ts`（897 行）→ `mcp-stdio.ts` / `mcp-http.ts` / `mcp.ts`
  （桥 + 共享 helper + re-export 两个连接器工厂）。**公共面与运行时行为不变**。

### 测试

- 补上 #75 遗留的回归用例：stdio MCP 连接器「裁判放弃等待 ⇒ `pending` 记账出簿」的防泄漏
  修复此前**没有任何用例守着**（夹具新增 `silentcall` 模式：握手 / `tools/list` 正常、
  `tools/call` 永不回包）。

### 依赖

- 开发依赖：`@anthropic-ai/sdk` → 0.126.0、`@biomejs/biome` → 2.5.14、
  `@types/node` → 26.6.1、`zod` → 4.6.5（均不影响运行时面）。
- 官网（不随包发布）：`astro` → 7.3.3。

## [0.7.1] - 2026-09-19

### 变更

> 本版主题（窗口 `0.7.0 → 0.7.1`，含 #71–#75）：**HITL 人工审批**（挂起 / 恢复、跨进程耐久）、
> **gRPC 宿主配方与可跑示例**，以及**连续四轮复审收口**（第八轮「时间维度」、外部四路复审、
> 外部复核的复核）。这批改动绝大多数是同一族病灶 —— **「不报错地不干活」**：超时不清簿记、
> 重试不排空响应体、非流式回落零校验、回调通道缺失、幂等键赢家跨重启易主、门禁被 `&&`
> 短路静默跳过。
> **两处使用者会遇到的行为变更**：① OpenAI 兼容端点返回 legacy `function_call` 形态时，
> 不再静默以 `end_turn` 收尾，而是抛 400（确定性不兼容 ⇒ 不重试），见下方
> 「legacy `function_call` 形态响亮失败」；② MCP / 预算护栏 / 异步宿主的若干语义收紧
> （会话过期自愈加互斥、`close()` 超时不挂死、未配 `sessionStore` 时 `submit` 响亮失败），
> **都不需要改代码**。
> **一处破坏性变更（仅类型面，运行时行为不变）**：`RecorderBackend` 新增必填成员 `usage()`；
> `BudgetGuard.check` 入参由 `Trace` 收窄为 `{ readonly totalUsage: Usage }` ——
> 迁移写法见本节末的「迁移」小节。

### 修复（外部四路复审收口：文档承诺了代码没做的事）

- **`AsyncRunner.approve` 补并发重入闸 + 真落库再派发**（HITL 补丁）：并发 approve
  （双击「批准」/两个审批人同时批）曾在 store 往返窗口内各自判「决定齐了」、
  **各派发一次**（同一任务重复执行）；且它用着吞错的 `#safeSave` 却在注释里承诺
  「先落库再派发」。现在并发调用共享在飞那次（第一次决定赢），落库失败 ⇒
  调用方收到 reject、**绝不派发**。
- **MCP StreamableHTTP 连接器：`tools/call` 不再起第二个计时器**（`timeoutMs` 只管
  装配期的握手/`tools/list`，与 stdio 侧对称；工具调用的裁判仍是引擎的
  `toolTimeoutMs`）。顺带修复：非 SSE 响应的 id 改为**等值配对**（原只验「id 是
  number」，串包时会把别的请求的结果当本次的返回）。
- **gRPC 示例 `getTask` 补 try/catch**：grpc-js 不接管 async handler 的 Promise，
  store 抛错会以 unhandledRejection 终止进程。
- **soak 脚本两处假绿**：采样不足时「跳过内存断言」却照打「内存有界」⇒ 采样间隔
  随时长缩放、样本不足硬失败；宽区间失败率断言换成**逐笔对账**（每个不可重试故障
  恰好杀死一个 run：`failed ≥ 注入数` 且超出部分 ≤ 请求的 0.1%）。
- 文档对齐：usage-guide 曾写同步 `/run` 返回「含 `suspendedMessages`」（响应体没有
  该字段）—— 改文档：要审批请走 `POST /tasks` 异步宿主。

### 修复（第八轮复审：时间维度的三处破口）

- **子 agent / skill 被 `toolTimeoutMs` 超时后，capability span 在交付的 trace 里永不收尾，
  且后台继续烧的 token 不进任何观测面**。新增 `ToolRunContext.abandoned`：引擎「放弃等待」
  时 abort 它 —— @SubAgent / @Skill 收到信号即中止子循环（在飞请求被掐掉），capability
  span 立刻以 `error`（`timeout`）收尾（trace 是浅拷交付的，等子循环自己 settle 再关
  就进不了已交付的那份）。自定义工具要「真停」同样监听它。
- **Scheduler 的 `at()` / `every()` 挡 32 位定时器溢出**：超过 2³¹-1ms（约 24.86 天）的
  延迟会被 Node **静默**钳到 1ms —— `at(30 天后)` 变成立即触发、`every(34 天)` 退化成
  每毫秒空转。现在构造期抛错（与 `runTimeoutMs` 同款防线）。
- **skill 方法体 `try/catch` 掉 `ctx.llm()` 失败并降级时，capability span 不再被误标
  error**（旧实现把「子运行失败」提前烙进 span，幂等守卫让整体成功的调用翻不了案）。

### 新增（HITL 人工审批：挂起/恢复，跨进程耐久）

- **审批 = 异步 tool_result**：`@Tool({ approval: 'required' })`（或裸 `AgentTool` 的 `approval`
  字段）声明后，模型每次调用该工具都会把任务**挂起**：run 状态变为 `awaiting_approval`，
  **整个回合一个工具都不执行**（回合级全有或全无 —— 协议要求每个 tool_use 配对 tool_result）；
  完整消息历史（末尾是含未决 tool_use 的 assistant 消息）与待决清单（`pendingApprovals`）
  随 `TaskRecord` 落库，进程重启不丢。
- **恢复**：`runner.approve(taskId, decisions, { decidedBy? })` 或
  `POST /tasks/:id/approve`（body `{ decisions: { <tool_use_id>: { approved, reason? } }, decidedBy? }`）。
  **逐 tool_use_id 幂等**（第一次决定赢）；决定齐了整个回合恢复执行：批准的工具正常执行
  （工具体内经 `ToolRunContext.approval` 读到决定），拒绝的得 `tool_result(is_error,
  '审批被拒绝：…')`（理由回给模型，可自行换路）。恢复后再遇未决审批 ⇒ 再次挂起（可等多轮）。
  引擎侧的恢复是**通用**的：任何「assistant 结尾带 tool_use」的消息历史喂给
  `runAgent` / `app.run` 都会先解决这些 tool_use 再调模型。
- **状态语义**：`awaiting_approval` 是**非终态**（`awaitTask` 继续等）、不占并发槽、
  不触发 `TaskSink.onFinished`、`resumePending` 不捡（它不是孤儿，是在等人）、
  InMemory 淘汰跳过、同幂等键重复 submit 返回等待中的任务。挂起段的 trace **照常投递
  sinks**；恢复段是一棵新树，经根 span 的 `links` 挂到上一段 runId。
- **审批超时兜底**：`new AsyncRunner(app, { approvalTimeoutMs })`（缺省 0 = 一直等）。
  **惰性判定、不起定时器**：`approve` / `poll` / `resumePending` 读到过期挂起任务时，
  自动把全部待决项写成「拒绝：审批超时」并恢复执行。
- 新公共面：`ApprovalDecision` 类型；`RunAgentOptions.approvals` / `RunInvocationOptions.approvals`；
  `AgentRunResult.suspendedMessages` / `pendingApprovals`（字段恒在场，未挂起为 `undefined`）；
  `AgentStopReason` 与 `RunStatus` 各增 `'awaiting_approval'`；`AsyncRunner.approve` /
  `approvalTimeoutMs`；trace 事件 `approval.requested` / `approval.decided`（带 waitedMs）。
- 已知边界（详见 usage-guide §7）：超时惰性判定；指标按段计；批准后崩溃 ⇒ at-least-once
  重执行；预算口径在恢复段重新起算；嵌套能力（子 agent / skill 子循环）内的审批工具
  不支持挂起整个 run；同步 `POST /run` 撞上审批会带 `awaiting_approval` 返回（要审批请走
  `/tasks`）。

### 修复（外部复核的复核 + 三条一致性缺口收口）

对上一轮「四路复审」的修复（31 个文件）逐条复核并实测通过；另补三条「守卫没覆盖自己
声称范围」的缺口与一处护栏开销：

- **MCP HTTP `close()` 的 DELETE 现在过 `guard`**：此前直接 `await fetchImpl(...)`，外层
  `catch` 只兜得住**抛错**、兜不住**挂死** —— server 接受连接后不回（半开 / 卡在代理后面），
  `close()` 就永久挂住，而调用方是**宿主停机路径**（挂住比失败更糟）。fetch 与 body 排空
  一起进 guard（只护住响应头，`readText` 照样能卡）。摘掉修复 ⇒ 新用例在 8s 测试预算下
  被 `cancelledByParent` 取消。
- **`asset()` 拦绝对路径**：守卫此前只拦带 scheme 的 `rel`，但 `/etc/passwd` 与
  `file:///etc/passwd` 是同一类（`new URL` 会把 base 的路径部分整个丢掉）——
  「以为读了能力目录里的文件，实际读了别处」（macOS 上**真能读到**）。`../` 仍放行
  （它是相对 base 解析的，base 没被忽略）。
- **预算护栏改走廉价 usage**：新增 `TraceRecorder.usage()`（只扫 spans 求和、不拷
  attributes/events），`snapshot().totalUsage` 改为调它 ⇒ 两条路不可能漂移。护栏每回合
  要判**两次**（回合入口 + 回合末，是不同决策点，**刻意不合并**），此前每次都全量
  `snapshot()` ⇒ O(回合 × 累计事件量) 的白拷。
- 测试基建：`mcpConnector` 的 stdio 握手缺省预算 5s → 20s（`node --test` 按文件并行，
  重负载下**子进程启动**本身就可能吃掉数秒；断超时行为的那条用例自带 `timeoutMs`）。
- 复核结论一条「查过但不改」：`interruptibleSleep(0, 已中止的 signal)` 仍 **resolve** ——
  它与 `withTimeout(p, 0)` 的「非正数 = 机制关掉」是同一口径，不是缺口（本轮曾误改，
  被既有用例拦下后回退；那条用例的断言已从隐式 `await` 改成显式 `assert.doesNotReject`
  并写明理由，见 spec §10 2026-09-19 ref-budget-guard-cheap-usage）。

**迁移（自己实现这两个结构面时）**

- `BudgetGuard.check` 的入参由 `Trace` 收窄为 `{ readonly totalUsage: Usage }`。
  **传整份 `Trace` 的调用方不受影响**（结构上满足）；自己实现 `BudgetGuard` 的代码需把
  签名改宽，且**不得再读 `spans`**（类型上已读不到 —— 「只看 totalUsage」由注释变成约束）。
- `RecorderBackend` 新增必填成员 `usage(): Usage`。自己实现该结构面（或自建 recorder
  替身）的代码需补上。

### 新增（gRPC 宿主配方与可跑示例）

- **不对 Kafka / gRPC 做「服务包」**，但把真缺的那一块做成配方 + 可跑示例：gRPC 宿主必须
  自己接上的**四处**（deadline / 取消 → `signal`、`metadata` 的 `traceparent` → `traceContext`、
  框架错误 → gRPC 状态码、trace → sink），四处漏掉**都不报错**。判别规则只有一条 ——
  客户端是不是标准库（MCP 用 `spawn` + `fetch` 所以能内置，gRPC / Kafka 要引第三方客户端），
  决策见 spec §10 2026-09-18 ref-host-integration-recipe。
- `docs/usage-guide.md` §6.2 新增「gRPC 宿主」配方；`examples/grpc-host/` 给了 proto + 宿主 +
  客户端 + README（一元 / 服务端流 / 异步投递 / 查任务，`PORT=0` 自报端口、无抢占窗口）；
  `scripts/e2e-grpc.ts` 真构建真起宿主、用它自带的客户端跑四个 RPC，并入 `npm run e2e` 第四步。

### 修复（OpenAI 兼容端点：legacy `function_call` 形态响亮失败）

- 兼容端点把工具调用放在 `message.function_call` 时，适配器只读 `tool_calls` ⇒ 此前落进
  `default: return 'end_turn'`，**模型要调的工具被丢掉、run 却以成功收尾**（模块头写的正是
  「上游故障绝不映射成成功」）。现在 `function_call` 抛 `OpenAICompatApiError(400)`：这是
  **确定性不兼容** ⇒ 落 `classifyError` 的 `api` / 不可重试（用 500 会被引擎重试三次，每次
  都重复丢弃同一个调用）；也**不做 legacy 兼容**——请求侧只发 `tool_calls`，回灌的
  `role:'tool'` legacy-only 端点同样吃不下，半吊子支持比不支持更糟。`default` 仍是有意的
  `end_turn`（未知值**且有正文**），并补 `eos_token` 用例把这个有意默认钉住，防后人顺手改成抛错。

## [0.7.0] - 2026-09-18

### 变更

> 本版两个主题：**MCP 连接器出厂自带**（新增公共 API：`createStdioMcpConnector` /
> `createStreamableHttpMcpConnector` / `McpConnector` / `MCP_CLOSE_GRACE_MS`），
> 以及一轮复审与「已知边界」收口。**两处行为变更，都不需要使用者改代码**：
> ① StreamableHTTP 会话过期从「抛错、需重建连接器」变成**自愈**（多了个可选的
> `onSessionExpired` 钩子）；② `close()` 从「到点即返回」变成「返回即子进程已终止」。
> **无破坏性变更** ⇒ 不需要迁移动作。

### 修复（MCP 连接器两条「已知边界」收掉）

- **StreamableHTTP 会话过期不再需要人工重建连接器**（`404` 自愈）。带会话 id 收到 `404` 的语义是
  「这个会话我不认识」⇒ **该请求没有被 server 执行** ⇒ 连接器丢会话、重新握手、把**这一次**重试一次
  （**只一次**，第二次再 404 直接抛，不循环）—— 这也是 MCP 规范对客户端的要求。
  此前按不可重试的 `api` 错抛出，长跑宿主的会话一过期就得**重建整个连接器**。
  自愈本身是静默的，所以给了 **`onSessionExpired`** 钩子：不挂它就没人知道恢复发生过 ——
  「静默恢复」和「静默失效」在监控上看不出区别。
- **`close()` 现在保证返回时子进程已终止**（stdio）。此前「到点即 resolve」：SIGTERM → 等
  `MCP_CLOSE_GRACE_MS` → SIGKILL **并立刻返回**，此刻子进程往往还在（未回收）—— 调用方以为
  进程没了，实际留下一个孤儿。现在 SIGKILL 之后**继续等真正的 `'exit'`**（SIGKILL 不可被捕获，
  该事件必达）。
- 验证：`tests/integrations/mcpConnector.test.ts` 27 → 31 例；
  **变异电池 6/6 全部被抓到、0 漏网**（删自愈分支 / 丢掉 `sessionId !== null` 前置 / 重试透传
  `allowReinit`（无限重试）/ 去掉 `onSessionExpired` / `close()` 恢复不等 reap / 夹具不再忽略
  SIGTERM ⇒ 证明那条用例真在测 SIGKILL 路径）。

### 修复（官网手写数字：补上真正没被守的那几个）

- `api.html` 的 `0 个运行时依赖` / `4 类能力` 与 `index.html` 首屏的 `4 类能力` / `0 个运行时依赖` /
  `3 类触发` **此前没有任何断言** —— 加一个运行时依赖、增删一类能力或触发宿主，页面会继续写旧数字
  而没人拦。现在逐条对源码核（`package.json` 的 `dependencies` 数 / 四个能力装饰器 / 三个传输宿主）。
  变异电池 3/3 会咬（改成 1 / 5 / 4 各判红一次）。
  ⚠️ 顺带**更正一处过度声明**：`210 个导出` 与 `9 个层次` **本来就有守卫**
  （`api-page.test.ts` 已有：前者对 `src/index.ts` 导出数、后者对页面 section 数）——
  它们从来不是缺口。首屏 `1:1 run ↔ trace`（真守卫在 `traceLink.test.ts`）与 `0 反射`
  （策略声明，无法从源码计数推导）**刻意不推导**，已在 `guards.md` §2「待守」登记。

### 新增（MCP 连接器**出厂自带**：stdio + StreamableHTTP）

- **`createStdioMcpConnector(cmd, opts?)`** / **`createStreamableHttpMcpConnector(url, opts?)`**
  —— MCP 的两种传输现在随框架发布。此前只有 `mcpTools()` 那条 duck-typed 桥，**连接器要自己写**：
  官方示例只有 `scripts/e2e-mcp.ts` 里一份 94 行的最小参考（还是内联在脚本里的私有副本）。
  公共面另加 `McpConnector`（`McpClientLike` + `close()`）与 `MCP_CLOSE_GRACE_MS`。
  **只用标准库**（`node:child_process` + 全局 `fetch`）⇒ 不新增任何第三方依赖，「零运行时依赖」不变；
  也**没有**放宽「第三方 SDK 对用户不可见」—— 一个 MCP SDK 都没 import，`McpClientLike` 这条缝原样保留
  （接官方 SDK / 远程 server / 自研传输照旧走它）。
- **本条反转了 2026-09-11 的 F7**（「连接器放独立可选包 `@migor/mcp`」）。那个包**从未发布**，
  而仓库里有 5 处注释把它当既成事实引用（含 `src/index.ts` 的公共面注释）—— 现在全部改正。
  为什么反：F7 的理由「守住零运行时依赖」不成立（该口径 = 不依赖**第三方包**；`spawn` / `fetch` 都是
  标准库），且 `store/` 的三层形状里「只用标准库的平台能力」一律内置（`FileTaskStore` / `SqliteTaskStore` /
  HTTP 宿主），独立包才是那个例外。完整论证与可逆性判据见 `docs/spec.md` §10 **2026-09-18 ref-mcp-builtin**。
- **连接器替你兜住三件只有它能做的事**（此前只活在 `scripts/e2e-mcp.ts` 那段内联副本里，无门禁守着）：
  ① spawn 失败的 `'error'` 是**异步事件**，不接住就是未捕获异常（真实宿主进程直接崩，没有 try/catch
  接得住）；② stdout 必须按 `\n` **攒包**（一条报文可能跨多个 chunk）；③ **协议层 `isError: true`
  转成抛错** —— 否则模型收到一条「成功」的结果、trace 也把这次失败的调用记成成功。
- **连接器的 `timeoutMs` 只管装配期**（握手 + `tools/list`）：那两步此前**没有任何裁判**，server 卡住会让
  `createApp` 永久挂起；`callTool` 的裁判仍是引擎 / 桥（延续「一次调用只有一个裁判」）。
- **已知边界**：StreamableHTTP 会话过期（带会话 id 收到 `404`）**不自动重握手**，按不可重试的 `api` 错抛出；
  `close()` 幂等且**有界**（SIGTERM → 2000 ms 后 SIGKILL），但**不保证等到子进程被 reap**。
- 验证：新增 `tests/integrations/mcpConnector.test.ts` 27 例（stdio 侧起**真子进程**）；
  **变异电池 9/9 全部被抓到、0 漏网**；`npm run e2e:mcp` 改为走出厂连接器后真第三方 server 全绿 ——
  此前那条端到端证明测的是它自己那份私有副本，现在测的是用户拿到的东西。

### 修复（第七轮复审收口：三处「不报错地不干活」）

- **Anthropic 适配器：流被截断 / 空流现在抛带 `status` 的错误**（`AnthropicApiError(500)`）。
  此前两处抛裸 `Error` ⇒ `classifyError` 判 `unknown` + `retryable:false`：上游故障被记成「模型的
  协议问题」（排障方向被带偏），且**引擎层重试一次都不会发生**。更糟的是「已吐出半句之后断流」——
  内容非空使旧判据（`!started`）不触发，`stop_reason: null` 落 `unknown_stop_reason`（同样不可重试）。
  现在按 openai 侧同款判据：**既无 `message_stop`、也无 `message_delta` 的 `stop_reason` ⇒ 抛 500 可重试**。
- **OpenAI 适配器：流内 error 分片的 status 反推分三档**（此前只把限流判 429、其余一律 500 + 可重试）。
  `invalid_request_error` / `context_length_exceeded` / `model_not_found` / 鉴权 / `content_filter` 这类
  **改配置才有救**的 4xx 病因现在判 400 且**不可重试**（此前白重试 3 次、trace 记成 `server` 而非 `api`）。
- **OpenAI 适配器：非流式路径的「200 + 空补全」不再记成成功**。`choices[0].message.content = null`
  + `finish_reason: 'stop'` 此前映射成「空文本 + end_turn」成功收尾，而同一响应在**流式**路径上会被判
  失败 —— 两条路径结论相反，且与模块头「上游故障绝不映射成成功」相反。`content_filter` 的合法空回复
  仍豁免（与流式同款例外）。
- **`AsyncRunner.resumePending` 补重入闸**：并发/重入调用现在**共享同一次扫描的结果**（返回在飞那个
  Promise，而不是谎报 0）。「先落库再派发」只堵住了**串行**重扫 —— 认领是异步的，两个并发调用都在任一
  `save` 落地前 `list()` 到旧快照，`ownerId` 过滤双双失效 ⇒ 同一任务被派发两次（副作用与花费翻倍）。
- **`metricsSink`：基数折叠在 `/metrics` 上可见** —— 新增 gauge 家族
  `agentia_dropped_keys{kind="capability"|"model"|"score"}`（Prometheus 与 OTLP 两侧都出，恒定发三个样本）。
  此前 `droppedCapabilities/Models/Scores` 只存在于 `snapshot()`，而文档让用户把 `metricsSink()` 接到
  `GET /metrics`（只消费 `render()`）⇒ Prometheus-only 的部署**完全看不见折叠发生**（静默丢失）；
  对照：同一份文件对「算不出成本的 turn」专门发了 `model_unpriced_turns_total`。
- **`metrics.ts` 的 OTLP 导出失败改抛 `MetricsExportError`（带数值 `status`）**：裸 `Error` 被判
  `unknown`，宿主在 `onExportError` 里拿不到 status，无法区分「collector 拒收（4xx，改配置）」与
  「collector 挂了（5xx，等它回来）」。

### 修复（守卫自身的洞 —— 本版主题是「把没门禁的约定收口」，而守卫自己有洞）

- **`tests/architecture/transport-errors.test.ts` 的注释剥离会瘫痪整份文件的扫描**（严重）：
  旧实现把每行「截到 `//` 为止」，而 `//` 会出现在**字符串里**（最典型是 URL）。截断会切掉该行闭合的
  `)` 与反引号 ⇒ `bareErrorThrows` 的括号配平一路吃到文件末尾 ⇒ **那一行之后的每一处抛错都再也扫不到、
  且全程不报错**。实测 `src/integrations/metrics.ts`：8 处裸抛错只剩 2 处可见，被吞掉的正好包括
  `OTLP metrics 导出失败: HTTP ${res.status}`（本守卫存在的理由）。改为「整行丢弃注释行」，
  并以合成样本复现该机制作回归钉（旧实现下会红）。
- `tests/docs/guards-registry.test.ts` 的**条目密度下限由 8 提到 24**（实测 32）：旧下限意味着删掉
  注册表 §1.1–§1.3 整整三节仍会绿 —— 防「抽词器退化」的护栏同时替「整节被删」放了行。

### 仍未做（如实标注，下一轮）

- `tests/integrations/adapter-parity.test.ts` 的矩阵**结构上测不到「缺省 `maxRetries` 对称」**：
  `make(maxRetries: number)` 是必填、所有场景都显式 `a.make(2)` ⇒ 把 openai 的缺省改成 0 仍全绿。
  而该矩阵被造出来正是为守这件事（修法：加一条走缺省的场景）。
- `maxToolConcurrency` 是否该随 `ToolRunContext` 透传给嵌套能力（`docs/guards.md` §2 已登记的
  「手写转发列表不得漏字段」形状，历史事故 = `runAgentScoped` 漏 `toolTimeoutMs`）—— 待口径判定：
  转发，或在 `types.ts` 注明「只作用本层循环」。


## [0.6.3] - 2026-09-18

> 本版主题：把第六轮 16 条的共同根因（「约定写在文档里、但没有门禁」）收口 ——
> 守卫注册表 + 三个新架构守卫 + 适配器对拍矩阵；`exactOptionalPropertyTypes` 全量迁移；
> OpenAI 适配器补齐客户端内层重试（与 anthropic 对称）。**无破坏性变更**。

### 新增（守卫基建 + 适配器对齐）

- **守卫注册表 `docs/guards.md`**：「哪类危险由谁守」的单源清单（§1 已挂守卫 → 保护的
  不变量 → 退化后果；§2 待守缺口；§3 写法纪律），配套 PR 模板的「危险类自查 5 问」。
- **两个新架构守卫**：`tests/architecture/transport-errors.test.ts`（`integrations` 的
  传输抛错必须带数值 `status`，否则 `classifyError` 判 unknown、重试层静默失效 ——
  上线当天即抓到 `otlp.ts` 的同形漏网）与 `tests/architecture/tsconfig-strictness.test.ts`
  （`exactOptionalPropertyTypes` / `strict` / `types:["node"]` 三个承重开关不得被关）。
  另有元守卫 `tests/docs/guards-registry.test.ts` 防注册表本身腐化。
- **`OpenAIClientOptions.maxRetries`（缺省 2）**：OpenAI 适配器补齐**客户端内层重试**
  （408/409/429/5xx + `retry-after` 尊重，与 `createAnthropicClient` 逐字对齐）——
  此前同一个 429 在 anthropic 打 3 次网络请求、在 openai 只打 1 次（引擎层那一次）。
  对称性由 `tests/integrations/adapter-parity.test.ts` 守住（一份场景表跑两侧 + 跨侧
  对称断言）。
- **`exactOptionalPropertyTypes` 开启并完成迁移**（39 处 `error TS` 全清）：结果/状态
  记录改必填 `T | undefined`、内部管道 `?: T | undefined`、**公共入参签名不动**（调用点
  条件展开或 `omitUndefined`）。「显式 undefined ≠ 不传」从此是类型级约束 ——
  `retry: { maxAttempts: undefined }` 静默关重试这类写法在编译期就写不出来。

### 修复

- **`createOtlpExporter` 非 2xx 改抛 `OtlpExportError`**（带数值 `status`）：此前裸
  `Error` 会被 `classifyError` 判 `unknown` + 不可重试（与 OpenAI 适配器同形的病，
  由新守卫抓到）。

### 重构

- 两条适配器的 client 层退避（`backoffMs` / `interruptibleSleep`）单源收进
  `core/timeout.ts` —— 此前曾短暂存在 anthropic / openai 两份逐字副本；「不与引擎层
  `backoffDelay` 合并」的例外仍在（±25%+retry-after vs ±20%，策略不同）。

## [0.6.2] - 2026-09-18

> 本版主题：第六轮全量 review 收口 —— 16 条「不报错地不干活」修复（含两处**语义变更**，见下）、
> eval 分数进指标的 `beforeFlush` 时序缝、metrics 三维度基数封顶、trace 跨进程入站关联。
> **无破坏性变更**：两处语义变更（OpenAI 流式截断判据、MCP 桥对显式 `toolTimeoutMs: 0` 的裁判）
> 都是「此前错误的行为被改正」，正常用法不受影响。

### 修复（第六轮全量 review：「不报错地不干活」一次收口）

- **OpenAI 兼容端点的引擎重试此前整体失效**：非 2xx 抛的是裸 `Error`（无结构化 `status`），
  `classifyError` 一律归 `unknown + 不可重试` —— 兼容端点吃一个 429 就整轮 run 失败。
  现在抛 `OpenAICompatApiError`（带数值 `status`，与 `AnthropicApiError` 同形；module 级导出，
  不进公共面），429 → `rate_limit` 可重试；流内 `error` 分片（塞进 200 的流里的故障）按
  `type`/`code` 反推 status（`rate_limit` / `insufficient_quota` / `too_many` → 429）。
- **OpenAI 流式截断不再被记成成功**（**语义变更**）：终止判据从「累积为空」换成
  「既无 `[DONE]` 也无 `finish_reason` ⇒ 上游故障」—— 此前截断发生在已吐出半句之后时，
  半截输出被 `end_turn` 收尾上报。反向也对齐：正常终止但空的流若 `finish_reason=content_filter`
  不再误抛，与非流式路径同样记 `refusal`。
- **Anthropic 适配器的 usage 合并不再被显式 `null` 清零**：网关型端点的 `message_delta`
  带 `input_tokens: null` 时，浅合并会把 `message_start` 的真实计量抹掉，该回合 input/cache
  token 与 `costEstimate` 归零（`maxCostUsd` 护栏随之失效）。现在 `mergeUsage` 跳过
  `null`/`undefined` —— 缺值的语义是「保持已有值」，不是「清空已有值」。
- **`maxToolConcurrency` 的 (0,1) 小数不再静默丢弃全部工具**：`Math.floor(0.5) = 0` 曾意味着
  零 worker、工具一次都不执行。现在正数一律至少 1 个 worker；run 根快照记**生效的整数**
  （不限记 `'off'`，不再把 `NaN` / `-1` 写进 trace）。
- **`.env` 引号值 + 行内注释不再把字面引号写进值**：`A="sk-..." # prod` 曾被解析成含引号的
  `"sk-..."`（每个请求 401，文件看上去完全正确）。引号判定改为「扫到闭合引号为止，其后只允许
  空白或 `#` 注释」；未闭合 / 有残留回退未加引号分支，不猜。
- **`toolTimeoutMs` 现在透传给子 agent / skill 的子循环**：此前嵌套 run 里工具**永不超时**，
  且 MCP 桥找不到引擎预算会另起 60s 兜底 —— 双计时器 + 双账本。
- **MCP 桥裁判判据改为 `!= null`**（**语义变更**）：显式 `toolTimeoutMs: 0`（引擎表态「不限」）
  时桥不再自作主张判 60s —— 说了不限就该不限。
- **异步任务的崩溃恢复不再可能重复派发**：`resumePending` 认领时**先落库再派发** —— 此前认领
  只改内存，对 `list()` 返回反序列化新对象的 store（sqlite/redis），窗口内第二次扫描会把
  同进程正在跑的任务再派发一遍（重复执行、重复副作用、重复花费）。
- **优雅停机不再可能永不返回**：`handler.drain({ timeoutMs })` 在 deadline 已过时直接返回
  `false`，不再把「已到点」透传给 `0 = 不限` 的语义（SIGTERM 容器被强杀、在飞任务硬切）。
- **显式 `undefined` 不再覆盖重试缺省**：`{ maxAttempts: undefined }` 这类透传组装曾把重试
  静默关闭（快照记 0，像用户主动关的）/ 让退避算出 `NaN`。现在显式 `undefined` 回落缺省。
- **静态 `@Prompt` 不再被同名实例方法静默撞掉**：静态扫描改为按**解析后的菜单名**去重，
  实例↔静态真重名交给装配期抛「菜单能力重名」（对齐 spec §7「重名即抛」）。
- **`tool_use_no_blocks` 收尾现在带结构化 `error`**（`type:'agent_error'`）—— 此前该分支
  `status:'failed'` 但 `result.error` 是 `undefined`，HTTP body / 任务记录里看不出为什么失败。
- **`POST /tasks` 的 store 落库故障不再回 400 + 内部原文**：新增 `TaskInputError`（module 级，
  不进公共面）区分「调用方参数错」（400 + 原因）与「服务端故障」（500 + 走 `exposeErrors`
  策略）；读 body 期间开始停机的竞态回 503。
- **长上下文压缩不再切出孤儿 `tool_result`**：`compactMessages` 的切点校验换成「保留段工具
  自洽」—— 非相邻工具对（tool_use 与 tool_result 中间隔着普通消息）此前会切出孤儿块、下一次
  请求被 API 400；退无可退时照 `trimToolPairs` 先例整体放弃本次压缩。

### 新增（质量闭环收尾 + 指标基数封顶）

- **`beforeFlush(trace, result)`**（`RunAppOptions` / `ExecuteRunOptions`，可选）：sinks 冲刷
  **之前**的最后一笔 —— 「拿到 run 结果才判得出的结论」（典型是 `defineEval` 的 score）在这个
  时点挂上，`metricsSink` 才聚合得到。**此前 eval 的 score 挂在冲刷之后，永远进不了
  `agentia_score` 指标族**（usage-guide / roadmap 承诺的「eval → trace → 监控」链路是断的）。
  宿主漏透传该字段时 `defineEval` 退回「跑完再断言」：断言照做，不误报全挂，只是分数进不了指标。
- **`metricsSink` 三个维度的键空间都封顶**：新增 `maxModels`（缺省 50）/ `maxScores`（缺省 200），
  与 `maxCapabilities` 同口径 —— 超限键折叠进 `__other__`（**量不丢，只丢标签粒度**），
  snapshot 新增 `droppedModels` / `droppedScores`（各自最多记账 1024 个不同键，满了以后是下界）。
  此前 `models` / `scores` 无上限，与 usage-guide 承诺的内存上界不符。

### 重构（内部去重下沉 core，公共面不变）

- `sseLines` / `percentile` / `capabilityKindOf` / `textOf` / 可中断 `sleep` 各只剩一份
  （`src/core/{sse,stats,trace,text,timeout}.ts`）—— `integrations` 只准依赖 `core`，core 是让
  两处重复合一的唯一合法落点。`textOf(message, separator)` 三个调用点各传各的原值，行为零变化；
  两份 backoff（引擎 ±20% 均匀抖动 vs client ±25% 且尊重 `retry-after`）**刻意不合并** ——
  合并即改行为。

### 新增（trace 跨进程关联：`traceparent` → run 根 span links）

- **入站链路上下文**：`RunInvocationOptions.traceContext`（`{ traceId, spanId? }`）与 HTTP 请求头
  `traceparent`（W3C）现在会记成 run 根 span 的一条 **`links`**（新类型 `SpanLink`），
  `createOtlpExporter` 映射为 OTLP **span links** —— 于是「这条 run 是被谁触发的」在跨进程 / 跨服务
  时也可查。**不改 `traceId == runId` 的 1:1 不变量**：run 仍是自洽的一棵新树，上游是被**链接**
  而不是被**继承**成父 span（理由与取舍见 `docs/spec.md` §10 2026-09-17 ref-cross-process-links）。
- 新增 `parseTraceparent(value)` 导出：把 `traceparent` 头解析成 `TraceContext`。
  **非法 / 缺失 / 版本 `ff` / 全零 id / 位宽不符一律返回 `undefined`**（不抛）——
  链路是观测行为，不该把业务请求打成 400。`createHttpHandler` 在 `POST /run` 与 `POST /tasks`
  上自动用它；`POST /tasks` 的 body 里显式给的 `options.traceContext` 优先于该头。
- **异步宿主零改动即继承**：`traceContext` 随 `spec.options` 落进 `TaskRecord`，所以另一个进程
  `resumePending` 续跑的那次 run 也带得上（队列消费者场景）。
- `TraceRecorder.addLink()` 记为公共能力；没记 link 的 span **没有 `links` 键**（不是空数组）。
- **已知边界（如实标注）**：只做**入站** —— 框架不生成出站 `traceparent`（运行中没有「当前 span」
  可导出，硬造会给出假 spanId）；link 只落 run 根，不自动跨进程传播（队列场景由调用方把
  `traceContext` 传下去）。

### 文档

- `docs/usage-guide.md`：新增「跨进程关联」小节（含队列消费者配方与「只做入站」的边界）、
  `app.run` 选项表补 `traceContext`、已知边界补一条；官网 API 页补 `TraceContext` / `SpanLink` /
  `parseTraceparent` 三行并把 `Span.links` 写进签名。

## [0.6.1] - 2026-09-17

### 文档（对外文案不再暴露内部流程；使用说明按用途重排）

> 随包发布的 `dist/AGENTS.md`（单源即 `docs/usage-guide.md`，也是 `agentia create` 写进新项目的
> 那份）一并更新 —— 装上本版即可看到，不必等下一次发版。

- **删掉讲本仓库自身流程的内容**：`§9 提交前自检`（它列的是本仓库门禁 —— `typecheck:tests` /
  `test` / `e2e` 三步链 —— 而脚手架生成的项目并没有这些 script，照抄必然失败）、前言里
  「文中 API 名由框架仓库的测试对着源码校验」句，以及散在正文里的内部路线图代号（`（R7）`）。
- **相对上一版的措辞改成陈述句**：「不再混进 connection」「不再静默映射成成功」这类只有用过旧版
  才读得懂的写法，改为直接陈述现状。
- **结构**：加顶层目录；「运行时 API」的 33 个子节按用途拆成六组（运行时上下文与装配 / 触发与宿主 /
  上下文预算与成本 / 观测与调优 / 集成 / 横切缝）；「框架只给缝、不建子系统」的口径集中到一处讲，
  不再逐个标题辩白。
- 官网（不随 npm 包发布）：API 页 `classifyError` 措辞、docs 页侧栏按用途分组、以及**滚到页面底部时
  末条导航不高亮**的修复。
- `@migor/trace-view`（不单独发布，随 CLI 构建期拷贝）README 补齐漏写的 `rawArg` 导出，
  并加一份「README 必须覆盖导出面」的守卫防再漏。


### 变更（超时有了自己的 `errorType`：`connection` → `timeout`）

- `classifyError` 对超时（内建 `DOMException('TimeoutError')` —— `AbortSignal.timeout()` 与默认 client 的
  超时合成信号；以及任何 `code === 'timeout'` 的错误）现在返回 **`type: 'timeout'`**，不再归进 `connection`。
  **`retryable` 保持 `true`** ⇒ **自动重试行为不变**（超时本来就是可重试故障）；变的是**记账**：
  按 `span.error.type` 分流的看板 / 告警会把超时类从 `connection` 挪到 `timeout`，`trace-diff` 比对旧 trace
  时超时会显示为「类型变了」。取证与决策见 `docs/spec.md` §10 2026-09-17 ref-timeout-error-type。
- 顺带把 `isTimeoutError` 的契约写清（三条判据，全鸭子类型）：框架 `TimeoutError` 实例 /
  `code === 'timeout'` / `name === 'TimeoutError'`；引擎的工具级 catch 用它 ⇒ 工具自判的超时与引擎判的
  超时记同一类账（`errorKind='timeout'`）。
- ⚠️ **更正**：此前一版说明里「模型调用超时在 `span.error` 上是 `type:'unknown'`（不可重试）」是**错的** ——
  它一直判 `connection` + 可重试（`engine/errors.ts` 的 `isConnectionError` 专门认 `name === 'TimeoutError'`）。
  该错误说明已从 `docs/spec.md` 删除，以 2026-09-17 ref-timeout-error-type 为准。

### 变更（MCP 超时单源化 —— 一次调用只有一个裁判）

- **原语单源**：`TIMED_OUT` / `withTimeout` 下沉到 `src/core/timeout.ts`，`engine/concurrency.ts`
  原样再导出（`import` 路径与名字对使用者与测试都不变）。MCP 桥的 `withDeadline` 改为它的**薄封装** ——
  此前桥自带一份**纯竞速**实现，于是 2026-09-14 的「超时是硬的」收紧只落进引擎，桥能把**超预算**的
  MCP 调用记成成功（确定性可复现；取证与决策见 `docs/spec.md` §10 2026-09-17 ref-mcp-timeout-single-source）。
- **⚠️ 行为变更（迁移注意）**：引擎设了 `toolTimeoutMs` 时，`mcpTools({ timeoutMs })` **不再参与判定**
  （即使桥的 `timeoutMs` 更短）—— 一次调用只有一个裁判，此前「谁短谁生效」让同一件事在 trace 里
  落成两种账。要收紧某个 MCP server 的时限，请设 `toolTimeoutMs`（或把该工具单独包一层）。
  桥的 `timeoutMs`（缺省 `MCP_DEFAULT_TIMEOUT_MS` = 60000）只在「桥脱离引擎单用」或
  「引擎没设 `toolTimeoutMs`」时作为兜底，且兜底同样走**实测耗时**判定。
- **超时归一类账**：工具自判的超时（抛 `code === 'timeout'` 的错误，桥的兜底超时即是）从
  `errorKind='threw'` + `error(unknown)` 变为 `errorKind='timeout'` + `error(timeout): …`，
  与引擎判的超时同类、同样**不杀 run**。按 `errorKind` 分流看板的查询请知悉这一变化。

### 修复（第五轮 review：三条「功能静默失效」+ 一批边界）

- **`app.run` 丢掉 `signal`（取消全线失效）**：运行期入参是逐字段手抄进 `executeRun` 的，
  唯独漏了从 `RunInvocationOptions` 继承来的 `signal`（TS 不报错）。后果是**三处宿主与三份文档
  都假设的取消全都不生效**：HTTP 客户端断开不中止、`drain` 收口只关流不灭 run、
  `AsyncRunner.runTimeoutMs` 只 race 掉结果而在飞请求继续烧 token。已补上转发 +
  真 `AgentApp` 路径的回归用例（宿主侧测试用的是**假 app**，正好绕过了这一跳）。
- **OTLP 的 `spanId` 宽度错**（`otlp.ts`）：内部 UUID（32 hex）被原样当作 span id，
  而 OTLP 契约里 span id 是 8 字节（**16 hex**，trace id 才是 32）—— 真 collector 会判
  `invalid span_id` 拒收或截断。已按两种宽度分开转换。
- **OTLP 对能力 span 一条 `gen_ai.*` 都不发**：`genAiAttributes` 按 `span.name.startsWith('subagent:')`
  判类型，而生产代码写的是**裸能力名 + `attributes.subagent` / `skill`**（metrics / report /
  trace-view 三个消费者都读 attributes，只有这里读前缀）⇒ 子 agent 的 `gen_ai.agent.name`、
  skill 的 `gen_ai.tool.name` 在生产里从未发出。已改为读 attributes，并把测试夹具改成生产形状。
- **`gen_ai.evaluation.score.name` 不是 semconv 键**（真实 key 是 `gen_ai.evaluation.name`）——
  已修正并同步文档（实测 `@opentelemetry/semantic-conventions` 全量键名里无前者）。
- **`costEstimate` 命中原型链 → NaN**：模型名恰为 `constructor` / `toString` 时
  `pricing[model]` 拿到函数（真值）而 `.in` 为 undefined ⇒ 成本 NaN，`maxCostUsd` 的
  `NaN > x` 恒 false 而静默失效，NaN 还会进 trace / OTLP。改为 `Object.hasOwn` 查找。
- **`mcpTools` 两处**：外部 server 的 `description` 不是 string 时装配期崩 `TypeError`
  （同循环里 name / inputSchema 都有类型防御）；`mcp.tool` 单值 attribute 在同回合并行调多个
  MCP 工具时互相覆盖 ⇒ 新增 `mcp.tool.<菜单名>`，审计 / 回放不再丢原名。
- **`combineSignals` 同源重复时残留监听器**（去重后走单源快路径）；
  **`session.append` 展开传参的 12 万项 RangeError**（同 `replaceMessages` 已规避过的坑）；
  **`harvest` 把缺 `tool` 的事件回填成 `'unknown'`**（会在生成物里造出一个真的、且断言必然
  通过的工具调用 —— 骨架自我自洽、永不报错）与**注释行裸插 name / source**（含换行即破产物）；
  **`replay` 放行数组型 `tool_use.input`**（API 要求对象）。

### 新增

- **脚手架补齐生产构建链**：`agentia create` 生成的项目此前只有 `dev`/`typecheck`，没有
  打包工具（连模板自己的 .env 注释都引用了不存在的 `npm start`）。现在生成
  `build`（tsc → `dist/` + `scripts/copy-assets.mjs` 跟随拷贝 .md 文本资产）与
  `start`（`node dist/main.js`），tsconfig 带 `rootDir`/`outDir`；e2e-cli 新增 4d 步
  真跑这条链（emit + 资产拷贝 + dist 产物断言）。

### 修复（第四轮 review：文档面错到「照抄就坏」+ 边界条件）

- **`app.run` 支持 `memory`（新增选项，非破坏）**：官网手写页与单源指南一直用
  `app.run(messages, { memory })` 演示跨 run 记忆，但 `RunAppOptions` 里**没有**这个字段
  —— 照抄的代码 TS 直接报「对象字面量只能指定已知属性」，硬绕过去则运行期**静默不生效**
  （记忆从不水合、也不回写）。现在与 `session` 完全对称：`app.run` 也水合/回写，
  边界同样只在程序内（store 不可序列化，不进 transport 的 `RunInvocationOptions`）。
- **`compactMessages` 不再劈开「工具对在索引 0」的历史**：回退循环的 `cut > 1` 让它停在 1
  时，`tool_use` 被折进摘要、尾部留下**孤立 `tool_result`**（并与摘要构成连续两条 `user`）
  —— 正是该函数 docstring 明说不产出的两种形态，下一次请求会被 API 400 拒。
  现在回退到 1 仍落在 `tool_result` 上就**放弃本次压缩**（原样返回）。
- **`agentia create` 撞同名普通文件**：此前 `readdirSync` 抛原始 `ENOTDIR` 栈（栈里全是
  `node:fs` 内部帧），那句「目录已存在且非空」的友好文案根本轮不到；现在先判路径类型。
- **子命令 `--help`**：`agentia report --help` 此前把 `--help` 当文件名去读，报
  `读不到文件 --help（ENOENT）`；现在 8 个子命令都回自己的用法串（与 `fail()` 共用同一份常量）。
- **`agentia harvest --out` 默认不覆盖**：产物是「人工核对后再进 CI」的脚手架，重跑一次会
  静默抹掉你手改过的断言与 input；目标已存在时报错，要覆盖显式加 `--force`。
- **`agentia report` 缺 CLI 资源时的报错**：`dist/inspector/summary.js` 缺失时给出人话 +
  补救动作（此前是原始 `ERR_MODULE_NOT_FOUND`，路径全在 dist 内部，用户读不出该做什么）。
- **文档面形状**：官网 `docs.html` 与单源 `usage-guide.md` 的「出参护栏」示例读的是
  `out.finalText`，而 run 输出是 `{ run, result }` —— 判断恒为 `undefined`、**护栏恒不触发**，
  页面上却像在生效；改为 `out.result.finalText`，并新增定向守卫
  `tests/docs/run-output-shape.test.ts`（手写片段此前没有任何东西在编译它）。
  `tests/docs/api-page.test.ts` 的行匹配器同时放宽（`<tr class="…">` 此前整行静默跳过）。

### 修复（发布面与证据可核性）

- **CHANGELOG 进 npm 包**：npm 的「总是包含」只覆盖 README/LICENSE（实测 `npm pack` 不含
  CHANGELOG）——根包 `files` 登记 + CLI 包构建期拷贝到包根，`e2e-cli` 新增两包 pack 内容断言。
- **bump 闸门**：`check-release.mjs` 新增「要发的版本必须高于 npm 已发布版本」（查官方
  registry，E404 首发放行）——此前只验四处一致、不验高低。
- **code-review 证据签入**：真跑 trace 与报告落 `examples/code-review/evidence/`（此前 `out/`
  被 gitignore，README 的数字无从核）；README 表格数字全部改为可从产物复核的值。

## [0.6.0] - 2026-09-17

### 破坏性变更与迁移

- **公共消息类型自有化**：框架不再从 `@anthropic-ai/sdk` 导出/引用类型，`ModelClient` 契约、
  `RunAgentOptions.messages`、`traceToMessages` / `forkMessages` 的入出参等全部改用
  `@migor/agentia` 自有类型（`MessageParam` / `ContentBlockParam` / `Message` / `ToolParam` /
  `MessageUsage` 等 15 个，见 `src/core/message.ts`）。
  **迁移**：代码里写 `import type Anthropic from '@anthropic-ai/sdk'` 并标注
  `Anthropic.MessageParam` 的，改从 `'@migor/agentia'` import 同名类型（`Tool` → `ToolParam`、
  响应 usage → `MessageUsage`）。只传对象字面量（`{ role: 'user', content: '…' }`）的代码**无需改动**——
  自有类型与 SDK 结构兼容（有 `tests/types/message-compat.types.ts` 双向 assignability 门禁），
  SDK 类型的值可直接喂进来。
- **默认 client 自研化（fetch + SSE 手写，不再实例化 SDK）**：
  `AnthropicClientOptions` 的索引签名保留（旧代码编译不炸），但 SDK 构造参数**不再被消费**，
  只有 `apiKey` / `baseURL` / `maxRetries` / `timeout` 四个已知名生效，多余键静默忽略。
  module 级的 `splitSignal` 随 SDK 包装层删除（它从未进公共导出面）。
  **行为对齐 SDK 缺省**：重试 408/409/429/5xx、缺省 `maxRetries=2`、指数退避 + 抖动、尊重
  `retry-after`；`signal` 直传 fetch（中止语义不变）。
  **迁移**：依赖「SDK 特有的构造参数」（如 `authToken`、`defaultHeaders`）的，改用
  `baseURL` 指向网关或自带 `client`（`RunAgentOptions.client`，契约见 usage-guide「多模型」节）。
- **错误分类改鸭子类型**（`classifyError` 不再 `instanceof` SDK 错误类）：带数值 `status` 的
  错误按 HTTP 语义归类（429→rate_limit、5xx→server，可重试；其余 4xx→api 不可重试）。
  **已知边界**：使用者自装 SDK 并让它把 `APIConnectionError` 抛到引擎时，该错误无 status 可判，
  归类退化为 `unknown`（不可重试）——默认 client 不产生此类错误，仅影响自装 SDK 的场景。

### 新增

- **trace diff**：`diffTraces(a, b)` —— 两条 run 调用树的 A/B 比对（run 级 summary + 逐 span
  字段差；llm.turn 配对忽略模型名，capability 按 `kind:name`；缺省忽略墙钟）。
  CLI `agentia diff a.jsonl b.jsonl`（差异非空 exit 1，可进 CI 挡轨迹漂移）。
- **分叉重放**：`forkMessages(trace, { atTurn, append? })` —— 主循环第 N 回合前截断重放历史、
  拼新消息喂回 `app.run`（新 run，不是续跑；trace 不记 assistant 文本与原始输入）。
- **canCall 能力级能力边**：`@SubAgent` / `@Skill` 的 `tools` 在 provider token 之外接受
  `'token/能力名'` 路径（只引单个能力，装配期校验 + 可用名单报错）。
- **零运行时依赖达成**：`@anthropic-ai/sdk` 退出 dependencies（留 devDependencies 只为类型
  兼容门禁）；`npm i @migor/agentia` 不再连带任何运行时依赖。
- 官网文档站新增「场景指南」区（HTTP 服务上线 / 监控 / 离线评测与回流 / A/B / HITL）。
- **`examples/code-review/` 真实案例**：代码评审 agent 服务（四类能力 + 能力级 tools 路径 +
  预算护栏 + 自定义 file sink 产 trace.jsonl），离线 demo（scriptedClient）与真模型两种跑法；
  已用真端点实跑并在 README 记录真实 token/成本/trace 数据（验证证据）。

### 修复

- CLI Windows：`npmBin` 只加 `.cmd` 后缀在 CVE-2024-27980 后裸 spawn 必 EINVAL —— 改
  `npmSpawn`（cmd.exe 包装 + 逐参数脱敏，不用 `shell:true`）。
- CLI doctor 的 import 识别只认 default import（named/namespace/别名/跨行形态的悬空条目
  静默漏检）——已全形态支持。
- 脚手架模板纳入真 `tsc` 检查（e2e-cli 第 4 步）；CLI 对拍测试在产物缺失时不再静默跳过
  （CI 判失败，本地醒目横幅）。
- 引擎 `agentLoop` 拆分（433 行循环体 → 8 个有名字的函数 + `turn.ts` 独立成文件），纯重构
  零语义变更。
- 官网 playground 单价对齐框架内置价格表；正文链接色统一主题色。

## [0.5.0] - 2026-09-16

### 新增（R7 质量闭环）

- **score 一等公民**：`Score` + `attachScore`（评分挂 run 根 span 的 `score` 事件）；
  `defineEval` 结论自动落 score；metricsSink 聚合 `agentia_score` / `agentia_score_total` 指标族。
- **OTLP 对齐 OTel GenAI semconv v1.37**（additive 保留旧 `usage.*` 键；score 译
  `gen_ai.evaluation.result`）。
- `session.id` 提升为 trace 根属性（OTLP 映射 `gen_ai.conversation.id`）；
  `PromptSpec.version` → run 根 `prompts.versions`。
- **线上 trace 回流 eval**：CLI `agentia harvest <file.jsonl> [--failed] [--limit N] [--out]`。
- `examples/observability/grafana-dashboard.json` 随仓库发布。

## [0.4.2] - 2026-09-15

### 修复（发布后更正）

- `RedisTaskStore` 的 TTL 在 node-redis 上完全不生效（0.4.1 把 TTL 挪到 `SET` 位置参数，
  node-redis 只声明三个形参、多余参数被静默丢弃）—— `set` 只传两参，TTL 一律走
  `expire(key, seconds)`；设了 `ttlSeconds` 却没给 `expire` 时构造期抛错。
- `e2e-deploy` 端口 TOCTOU flake（`EADDRINUSE` 曾被误报为「示例进程启动即退出」）。

## [0.4.1] - 2026-09-15

### 修复（深度审查修复轮，40+ 处，无新公开 API）

- metricsSink 的 Prometheus 文本每个家族只发一次 HELP/TYPE（重复即整次 scrape 硬失败）。
- 预算护栏（`maxTotalTokens` / `maxCostUsd`）经 `ToolRunContext` 真透传到子 agent / skill 循环。
- CLI inspector：SSE 路径 `innerHTML` → `textContent`（XSS）+ Host 头校验。
- `drain` 强制关 SSE 现在真 abort 对应 run；示例 Dockerfile 补 `COPY docs`；新增
  `scripts/e2e-deploy.ts`（崩溃续跑验证）。

## [0.4.0] - 2026-09-14

### 新增

- trace 事件正文可展开：`maxEventChars` opt-in 开关（缺省截断值逐字不变，`false` = 不截断），
  CLI inspector 与官网 playground 两个宿主都真展开。

### 修复

- 默认 client 从不转发 `signal`（中止在飞 run 失效、超时 run 继续烧 token）——
  `splitSignal` 把 signal 搬到 SDK RequestOptions；门禁为本地假端点测试。
- `withTimeout` 收紧为硬保证（只看实测耗时）；截止计时器不得 `unref()`（四处）。
- CI 抖动根因修复（toolTiming 计时器赛跑改确定性形态）。

## [0.3.0] - 2026-09-14

### 新增

- `.env` 一等配置入口：显式 `loadEnvFile()`（框架不自动读），零依赖手写解析，真实环境变量
  优先；脚手架生成 `.env` / `.env.example` 并 gitignore。

## [0.2.2] - 2026-09-14

首个公开发布：`@migor/agentia` + `@migor/cli`（scope `@migor/*`），两包版本同步。
框架本体单包；CLI 独立成包（workspaces）。

[Unreleased]: https://github.com/migoric/agentia/compare/v0.10.3...HEAD
[0.10.3]: https://github.com/migoric/agentia/releases/tag/v0.10.3
[0.10.2]: https://github.com/migoric/agentia/releases/tag/v0.10.2
[0.10.1]: https://github.com/migoric/agentia/releases/tag/v0.10.1
[0.10.0]: https://github.com/migoric/agentia/releases/tag/v0.10.0
[0.9.5]: https://github.com/migoric/agentia/releases/tag/v0.9.5
[0.9.4]: https://github.com/migoric/agentia/releases/tag/v0.9.4
[0.9.3]: https://github.com/migoric/agentia/releases/tag/v0.9.3
[0.9.2]: https://github.com/migoric/agentia/releases/tag/v0.9.2
[0.9.1]: https://github.com/migoric/agentia/releases/tag/v0.9.1
[0.9.0]: https://github.com/migoric/agentia/releases/tag/v0.9.0
[0.8.3]: https://github.com/migoric/agentia/releases/tag/v0.8.3
[0.8.2]: https://github.com/migoric/agentia/releases/tag/v0.8.2
[0.8.1]: https://github.com/migoric/agentia/releases/tag/v0.8.1
[0.8.0]: https://github.com/migoric/agentia/releases/tag/v0.8.0
[0.7.2]: https://github.com/migoric/agentia/releases/tag/v0.7.2
[0.7.1]: https://github.com/migoric/agentia/releases/tag/v0.7.1
[0.7.0]: https://github.com/migoric/agentia/releases/tag/v0.7.0
[0.6.3]: https://github.com/migoric/agentia/releases/tag/v0.6.3
[0.6.2]: https://github.com/migoric/agentia/releases/tag/v0.6.2
[0.6.1]: https://github.com/migoric/agentia/releases/tag/v0.6.1
[0.6.0]: https://github.com/migoric/agentia/releases/tag/v0.6.0
[0.5.0]: https://github.com/migoric/agentia/releases/tag/v0.5.0
[0.4.2]: https://github.com/migoric/agentia/releases/tag/v0.4.2
[0.4.1]: https://github.com/migoric/agentia/releases/tag/v0.4.1
[0.4.0]: https://github.com/migoric/agentia/releases/tag/v0.4.0
[0.3.0]: https://github.com/migoric/agentia/releases/tag/v0.3.0
[0.2.2]: https://github.com/migoric/agentia/releases/tag/v0.2.2
