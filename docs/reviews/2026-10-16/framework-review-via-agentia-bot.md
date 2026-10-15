# 框架深度评审：以 agentia-bot 的真实消费面为镜（2026-10-16）

> 基准：main @ `1fe84c9`（v0.10.3 + #258）。工作树干净。
> 方法：**不靠通读源码提意见** —— 拿一个真实消费者当探针：`~/Documents/projects/agentia-bot`
> （`@migor/agentia ^0.10.3`，即刚发布的版本；CLI 脚手架工程，1 次提交，843 行 TS / 12 源文件，
> 6 个演示能力，两个宿主）。它把框架的每条对外缝都走了一遍：四类能力、两条装配路线、
> Node 服务宿主、边缘宿主、dev 环、CLI 生成/体检。
> 判据 = 「框架承诺」↔「消费者实际得到的」的对拍；每条结论带 `文件:行号` 或实测输出。
> 量化快照（现算）：框架 src **111 文件 / 23,733 行**、约 **80 个公共导出**、**186 个测试文件**。

## 总评

框架的**内核与文档质量仍然上游**，但它有一条清晰的裂缝：**卖点在核心层兑现了，却在「用户
拿到的第一份工程」（脚手架）上缺席**。核心层刻意不内建可观测（spec §9.3，有意为之，正确）；
可脚手架 `createApp` 没配 `sinks` ⇒ `npm start` 起的服务**一条 trace 也不导出**，而 README 只把
metrics/OTLP 写成「要就抄 examples/deploy」。「trace 决定它敢不敢上线」这句话，在默认路径上
还**不成立**。

同形的第二条：框架对「异常」的主基调是「响亮」（`sessionId` 不生效会 warn、`asset()` 绝对路径
会抛、DI 重名在工具名层会报错），但**会话（对话历史）那一侧留了两个完全无声的 `catch`** ——
会话后端故障表现为「这是第一轮」，整段历史无声消失，且 `TraceSink` 拿不到它。

其余是「缝的形状不够」：没有应用级 `client` ⇒ 每个换端点的消费者手抄一份包装类型（本项目抄了
两份）；DI token 重名静默覆盖（顺序承重）；190KB 的 `AGENTS.md` 是一次性快照、无版本标记、
无刷新命令——**今天三方 shasum 一致（无漂移），但机制上必然腐烂**。

---

## 发现

### P0-1 核心卖点在默认脚手架上缺席：默认服务一条 trace 也不导出

**现象**：脚手架 `src/app.ts` 的 `createApp({...})` 只有 `name / discover / providers / system`
（+ 可选 `toolSources`），**没有 `sinks`**。服务（`src/main.ts`）也没挂任何 sink。

**证据**：
- 框架侧：trace 出口只有 `sinks`（收尾整棵）与 `onTraceEvent`（运行期逐笔），
  `AppOptions.sinks`（`src/toolkit/module.ts:184-185`）；**刻意不内建**（spec §9.3）。
- 落库侧：`TaskRecord.result`（`src/store/store.ts:48`）会把含 trace 的 `AgentRunResult` 一起
  存进 SQLite ⇒ 异步任务的 trace **在库里，但没人导出、没人看**。
- 文档侧：项目 README「更完整的生产配方」节把 metrics / OTLP 归为「直接抄 `examples/deploy/`」，
  **没有说「默认服务不导 trace」**。

**后果**：用户 `npm start` 起一个「能用的服务」，但既没有 trace 落盘、没有 `/metrics`、
也没有 OTLP。框架的差异化卖点降级成「选配项」，而用户多半在第一次要排查「这个任务为什么慢」
时才发现——那正是 trace 该在而它不在的时刻。

**建议**（不违反「只给缝不给策略」——给的是**默认件**，不是策略）：脚手架默认挂一个文件 sink
（一行，`FileTraceSink`），或退一步：`agentia doctor` 加一条「未配 sinks」警告 + README 明写
「默认服务不导 trace」。成本极低。

### P0-2 会话侧两个完全静默的 `catch`（可观测性的盲区）

**证据**：
- `src/runtime/run.ts:303-314` `loadSession`：`try { store.load(...) } catch { return incoming }`
  —— **无 warn、无事件、无 trace 标记**，失败即当「没有历史」。
- `src/runtime/run.ts:330-344` `appendSession`：`catch { /* ignore */ }` —— 回写失败同样无声。

**后果**：会话文件损坏（或后端故障）⇒ 表现为「这是第一轮」；下一轮 `append` 会把坏的那份
覆盖掉 ⇒ **整段对话历史无声消失**。模板注释已如实承认这一点
（`agentia-bot/src/session-store.ts:48-51`：「框架在 run 期间会刻意吞掉会话侧的异常……
不会把 run 打崩、也不会直接可见」），唯一出口是 dev runner 启动期那次探测。

**为什么这条重**：框架对同族问题做对过 —— `sessionId` 在 `app.run` 不生效时给的是
**响亮 warn**（`module.ts:560-566`）。同一条「辅助动作失败不得击穿 run」的纪律，
在 memory 回写上可以理解（黑板状态丢了影响小），在**对话历史**上不成立：
丢的是用户唯一能看见的上下文。

**建议**：至少 `console.warn` + 写一条 span 事件（或给一个 `onSessionError` 回调）。
两行代码，把「静默失效」变成「有人被叫醒」。

### P1-3 DI token 同 token 重复注册 ⇒ 静默覆盖（顺序承重）

**证据**：`AppOptions.providers` 注释明写「同 token 后者覆盖」（`module.ts:121`），代码无警告。
真实工程里 `WORKDIR` 出现两份，且**值不同**：
- 模板 `registry.ts:21` = `process.cwd()`
- 模板 `app.ts:104` = `opts.workdir ?? PROJECT_ROOT`

一旦混用两条装配路线，谁赢取决于 `providers` 的拼接顺序，且**没有任何声音**。
模板自己在两处注释里警告了它（`app.ts:101-103`、`registry.ts:17-20`）——
**靠注释守着的坑，等于没守**（本仓最忌的同一类）。

**对照**：框架对「子菜单能力重名」有响亮报错（`module.ts:103-113`）。同一类问题
（名字撞了）在**工具名**层守住了，在 **DI token** 层没守。

**建议**：同 token 重复注册时 warn（区分「discover 与 providers 撞」和「用户显式重复」）。

### P1-4 没有应用级 `client` ⇒ 换端点的消费者必须手抄一份包装类型

**证据**：`AppOptions`（`module.ts:118-208`，逐字段核对）**没有 `client`**；
`client` 只在 run 级（`module.ts:594` `client: opts.client`，且无 `?? this.base.client`）。
框架导出的 `AppCallable`（`async.ts:305`）只有 `{ name, run }`，而 dev 环还要读 `container` / `tools`
⇒ 消费者只能手搓。

**实测**：`agentia-bot` 里这个 `Pick<AgentApp, 'name'|'tools'|'container'|'run'>` **抄了两份**
（`src/app.ts:57` 与 `worker/index.ts:8`），后者还注明「不能引 app.ts 的类型（会把 `node:fs`
那条链拖进来）」。这正是本仓「同一事实多处副本」的病，只是发生在**用户工程**里。

**建议**：给 `createApp` 加应用级 `client` 缺省（run 级优先，与 `model` / `maxIterations` 同款），
包装件整个消失；或至少导出「dev 需要的那个形状」的类型。**成本小、收益是消掉一类样板。**

### P1-5 190KB 的 `AGENTS.md` 是一次性快照：无版本标记、无刷新命令、doctor 不查

**证据**：
- 由 CLI 在 `create` 时从 `docs/usage-guide.md` 拷进工程（`packages/cli/src/create.ts:117`）。
- CLI 子命令全集（`packages/cli/src/cli.ts:50-61`）：create / g / dev / doctor / report /
  harvest / diff / export / add —— **没有 docs / update / sync**。
- `doctor` 只体检「注册表 ↔ 能力目录」与老布局（`packages/cli/src/doctor.ts`），**不查 AGENTS.md**。

**实测（今天无漂移，如实说）**：项目内 `AGENTS.md`、`docs/usage-guide.md`、`dist/AGENTS.md`
三方 **shasum 完全一致**（`dac9c9f6…`，1,892 行 / 112,473 码点）。⇒ **问题不在今天，在机制**：
框架升级后这份「AI 辅助编码的权威入口」会静默过期，而 AI 恰恰是照它写代码的。

**建议**：写文件时插一行版本标记；`doctor` 比对 installed 版本，不一致给提示（或提供
`agentia docs` 重写命令）。这是「文档 drift 第一嫌疑不是文档」那条教训的**预防版**。

### P2-6 双装配路线 ⇒ 两本账，且默认路径只读其中一本

`discover`（扫目录，运行态真值）与 `registry.ts`（CLI `agentia g` 维护）并行。
脚手架默认路径（`app.ts`）**不读 `registry.ts`** ⇒ CLI 维护的注册表在默认路径下是一本
**没人读的账**；两本账还各有一份 `WORKDIR`（值不同）⇒ 混用即 P1-3。
README「两者二选一或混用」没点破「默认是哪条、混用代价是什么」。

### P2-7 `discover` 其实支持能力自带 deps，但模板示范了更脆的那种

**证据**：`src/toolkit/discover.ts:127-133` —— default export 可以是 **Provider 对象 / 数组**，
所以能力文件夹完全可以自导出 `{ provide: 'read-file', useClass: ReadFileTool, deps: ['WORKDIR'] }`，
依赖声明就在能力旁边（一能力一文件夹，账只一本）。

**现状**：模板选了「在 `app.ts` 再注册一遍带 deps 的 provider」⇒ 同一 token 出现两次
（discover 的无 deps 版 + app.ts 的有 deps 版），靠「后者覆盖」成立 ⇒ 模板注释自己承认脆
（`agentia-bot/src/tools/read-file/index.ts:26-34`）。CLI 侧也承认（`create.ts:120-123`）。

**建议**：模板改成能力文件夹自导出带 deps 的 Provider。**修在脚手架，不在框架。**

### P2-8 模板与框架之间只有文本级守卫，没有编译级对拍

`packages/cli/test/templates.test.mjs` 断言模板文本的约定（且讲究地先剥注释再匹配，质量高），
但**没有任何测试「用模板建个工程再 typecheck」**。这次是我手动实测的：
`agentia-bot` 的 `src` 对 v0.10.3 **类型检查干净**（`npx tsc --noEmit -p tsconfig.json` 零输出）。
⇒ 框架改 API 时，模板形状对不上只能等真实用户踩到。

**建议**：加一条 e2e —— `create` 到临时目录，用已构建的 `dist` 类型跑 `tsc --noEmit`。
（成本：一条 CI 步，换「模板永远编译得过」这一保证。）

### P2-9 Node 下限口径分裂（已如实标注，属可接受）

框架 **Node ≥ 18**（CI 有两条导入下限 job）；脚手架默认服务用 `SqliteTaskStore`（`node:sqlite`）
⇒ **Node ≥ 22.5**（项目 README 与 CLI 输出都写明了，诚实）。两条下限并存容易误会，
建议主 README 一处说清「框架 18 / 默认服务模板 22.5」。

---

## 做对的地方（别动）

- **零运行时依赖 + 只给缝不给策略**：鉴权是 `authenticate` 钩子、store 可换
  （File / Sqlite / **Redis** —— 已核验 `src/index.ts:183` 真导出，项目 README 那条断言属实）。
- **可观测刻意不内建**、四配方在 `docs/observability.md`：定位正确，P0-1 的问题在脚手架不在它。
- **装配与启动分离 + dev 环复用工厂**：让「工程里一个 dev 文件都不需要」，是很干净的设计。
- **`sessionId` 不生效给响亮 warn**（`module.ts:560`）：同族问题做对了，反衬 P0-2。
- **模板注释质量**：`safeResolve` 的归一化教训、`asset()` 值/函数形态（改 `.md` 要重启的静默失效）、
  原子写会话文件、以及 templates.test 里那条「只看代码不看注释」的自律——**不是凑数注释**。
- **消费者实测**：脚手架工程对着刚发布的框架**类型检查干净**，且 `AGENTS.md` 与单源**逐字节一致**。

---

## 建议优先级（ROI 排序）

| # | 建议 | 改哪儿 | 成本 | 收益 |
|---|---|---|---|---|
| 1 | 会话两个静默 `catch` 出声（warn + 事件） | `src/runtime/run.ts` | 极小 | 把「历史无声消失」变成有人被叫醒 |
| 2 | 应用级 `client` 缺省 | `AppOptions` + `module.ts` | 小 | 消掉用户工程里手抄的包装类型（本项目 2 份） |
| 3 | 脚手架默认挂 sink / 或 doctor 警告 | CLI 模板 + doctor | 小 | 把卖点接回默认路径 |
| 4 | DI token 重名 warn | `module.ts` 装配期 | 小 | 与工具名重名同档 |
| 5 | `AGENTS.md` 版本标记 + doctor 检查 | CLI create + doctor | 中 | 防「权威入口静默腐烂」 |
| 6 | 模板能力自导出带 deps 的 Provider | CLI 模板 | 中 | 账只一本，去掉顺序承重 |
| 7 | 模板工程 typecheck e2e | CI + CLI 测试 | 中 | 「模板永远编译得过」 |

---

## 验证边界（如实）

**实测过的**：框架源码逐条定位（每条 `文件:行号`）；消费者工程全量阅读（843 行）；
消费者 `src` 对 v0.10.3 的 `tsc --noEmit`（干净）；`AGENTS.md` 三方 shasum 对拍；
`RedisTaskStore` / `AppCallable` / `AppOptions` 字段的存伪核验。

**没测的（别当成已验）**：
- **没有真跑 run**（无 API key）⇒ 「会话静默失效」「trace 不导出」是按源码与接线推定的，
  不是抓到的现场；要坐实需起一次带 file sink + 坏会话文件的 run。
- `agentia dev` 面板、`agentia doctor`、Cloudflare 部署路径均未实跑。
- `AGENTS.md` 只做了整体 shasum，**未逐条核其中 API 描述**是否属实（190KB 全核不现实）。
