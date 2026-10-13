# AGENTS.md —— 仓库结构与协作约定

> **定位**：面向应用开发的声明式 agent 服务开发框架 —— 装饰器 + DI 声明四类能力，主 agent 编排执行；
> 每次 run 产出结构化结果与**可观测调用树**（trace、成本、指标），交付可直接上线的服务。
>
> **可观测是一等公民、与能力声明同级**，「四类能力决定它能做什么，trace 决定它敢不敢上线」（`docs/spec.md` §1）。
> 改这个仓库时**不要把 trace 当可选外挂**：它是本框架的核心卖点与对外承诺 ——
> 新增能力/宿主/集成的 PR，若绕开了 trace 记账或 `TraceSink` 出口，就是倒退。

## 布局

```
agentia/                     # npm 包 @migor/agentia（框架本体，单包）
├── src/
│   ├── core/                # 数据模型与结构接口（Trace/AgentTool/ModelClient/校验、
│   │                        #   RunStatus/RunMeta、Blackboard 类型族、Message 消息类型族、
│   │                        #   超时原语 timeout.ts —— 引擎与 MCP 桥**共用一份**，见 §10 2026-09-17 ①；
│   │                        #   `MAX_TIMER_DELAY_MS`（≈24.86 天）也在这里单源 —— 超过它的 setTimeout
│   │                        #   会被 Node 静默钳到 1ms，所以旋钮走 `assertTimerDelay`（拒）、
│   │                        #   外部数据（`Retry-After`）走 `clampTimerDelay`（夹），见 §10 2026-09-28 ⑪），零依赖
│   │                        #   limits.ts = **「限制旋钮的 0 是什么」的单一真源**（guards §1.2）：每个旋钮
│   │                        #   各属「不限 / 就是不做 / 立即 / 非法」四类之一，表是可执行数据；
│   │                        #   构造期报错文案里那句「（0 = …）」插的就是表里的 zeroClause。
│   │                        #   对账用例在 tests/limits.test.ts（穷尽表驱动，逐条驱动真实站点）——
│   │                        #   改任何一处 0 的读法而没改表 ⇒ 构建红，不是文档过期。
│   ├── engine/              # 运行时内核：agent loop、trace 记账、长上下文裁剪(trimming)、
│   │                        #   预算策略(policy)、错误分类、replay、run 调用契约
│   │                        #   turn.ts = 回合执行机（自 loop.ts 拆出）；它的纯判定继续外移：
│   │                        #   text.ts（引擎文本口径：多块 `\n` 连接）、stop-reason.ts（stop_reason
│   │                        #   → 收尾结论的映射表；「非正常收尾必须带结构化 error」的唯一落点）、
│   │                        #   turn-request.ts（回合请求装配）、tool-context.ts（工具上下文透传装配 ——
│   │                        #   八处条件展开各自是一个「漏了就静默降级」的守卫；false/0 是有意义的值）、
│   │                        #   tool-events.ts（单工具执行的记账面：两个事件体 + tool_result 块；
│   │                        #   失败出参的截断上限**更小** —— 「哪个工具老超时」要一行看得完）
│   │                        #   retry.ts 的 retryAllowed（重试闸四项合取，含「吐过字不重试」护栏）
│   │                        #   loop.ts 同样在往外移纯件：run-config.ts（run 生效旋钮的缺省解析 +
│   │                        #   快照编码 —— 认下缺省值的人就是写进 trace 的人，NaN/-1 一律记 'off'）、
│   │                        #   loop-result.ts（循环出口的结果形状：7 个字段必在场 + 四个具名出口 ——
│   │                        #   挂起不是失败、取消也带结构化 error、抛出必被 classifyError 翻译）、
│   │                        #   resume-input.ts（续跑入口的读取件：末尾未决 tool_use 的识别只看**末尾一条** ——
│   │                        #   漏判就是把续跑当新对话，同一批工具再跑一遍、花费翻倍）
│   │                        #   (RunSpec/RunInput/RunInvocationOptions/normalizeMessages)
│   │                        #   tracer.ts = span 记账器；**唯一出口曾是收尾的 snapshot()**，2026-09-21 起多了
│   │                        #   `subscribe()`（增量记账事件 —— onTraceEvent 的底座；与 sink 是**两条缝**：运行期逐笔、
│   │                        #   不保证送达）与 `traceLimits.maxEvents`（度量闸：超限停记，交付时于 run 根写
│   │                        #   trace.truncated{droppedEvents}）。⚠️ seq **每次记账动作都占号**（与有没有订阅者无关）
│   │                        #   —— 否则「订阅晚的人」的序号会错位（重放全乱）
│   │                        #   mcp-server.ts = MCP 反向桥（R8-P5：app 菜单暴露成 MCP server，
│   │                        #   stdio + StreamableHTTP 只用标准库；落 engine 是因为 integrations 只许
│   │                        #   依赖 core 装不下 TraceRecorder。每次 tools/call 一棵 trace 进 sinks，
│   │                        #   抛错 → isError，与正向桥方向对称；入站认 SEP-414 的
│   │                        #   params._meta.traceparent（合法 → run 根一条 link；缺失/畸形静默当孤立根）。
│   │                        #   **两个传输各居其文件**
│   │                        #   （2026-09-28，与正向桥同款排布）：本文件留**协议 + 执行 + 装配**
│   │                        #   （顶层的 rpcError/rpcResult/dispatch/callTool；createMcpServer 只做装配，
│   │                        #   441 → 47 行）；传输构造（宿主生命周期）在 mcp-server-stdio.ts /
│   │                        #   mcp-server-http.ts。⚠️ 协议与执行经 `McpCore` **注入**给传输 ——
│   │                        #   传输只从本文件取**类型**，所以无环是**构造性**的（正向桥那条
│   │                        #   `mcp.ts ↔ mcp-stdio.ts` 是**真实的值环**，靠 ESM 函数提升侥幸无恙，别照搬）
│   │                        #   mcp-server-stdio.ts = stdio 传输：stdin/stdout 换行分隔 JSON-RPC，
│   │                        #   `process.stdout` 的 EPIPE 必须吞（对端走了的次生现象，不是根因）
│   │                        #   mcp-server-http.ts = StreamableHTTP 传输：POST 收 JSON-RPC、GET→405、
│   │                        #   DELETE→200、`initialize` 发 mcp-session-id、客户端断连中止本次 signal
│   ├── runtime/             # run 生命周期：run 状态机、上下文(ALS)、
│   │                        #   SystemPrompt、跨 run 记忆(MemoryStore 水合/回写)
│   ├── transport/           # 触发宿主：HTTP handler、异步任务(AsyncRunner)、定时(Scheduler)、同步 RPC
│   │                        #   slot-pool.ts = 并发槽位原语（纯依赖、带单测）—— AsyncRunner 拆分的第一步：
│   │                        #   先抽它（唯一不碰 store/引擎的一块）+ 配 FIFO/移交语义的回归用例，
│   │                        #   后续抽块（审批监督 / 信号投递 / 恢复扫描 / drain 协调）才有基线
│   │                        #   ⚠️ 2026-09-29 复算：09-20 写下时 895 行，**「后续三步」当时一步没走**，
│   │                        #   类反长到 **1554 行**（文件 375→1929）；同日下午抽出审批监督 / 信号投递 /
│   │                        #   恢复扫描三簇 ⇒ 文件 **1460 行**（含代码行 664）
│   │                        #   ⚠️ **原句「只剩 drain 协调未抽」是错的，2026-10-11 更正**（它让我把
│   │                        #   已完成的抽件当成未偿的债报进评审）：drain 的**等待闸**早已抽成
│   │                        #   `drain-gate.ts`（就在下面几行）；**在飞计数刻意不搬**（它同时是 /healthz 的
│   │                        #   `inFlight` 口径、由任务生命周期加减）。⇒ 当时真正剩的是 `#executeInner`
│   │                        #   那个体的**体积**；同轮已治（抽 `run-outcome.ts`，见下几行）。⚠️ 它体内
│   │                        #   剩的 5 个 `try` 逐条盘过「各有语义、抽平会改语义」⇒ **嵌套深度保持
│   │                        #   4 级不变**：本轮降的是体量与 `try`/`catch` 个数，**不是嵌套浅了一层**。
│   │                        #   文件行数现由 `tests/architecture/source-size.test.ts` 钉住含代码行上限（750）
│   │                        #   approval-policy.ts = 审批的**纯判定**（超时判定 / 超时兜底拒绝 / 决定齐没齐）：
│   │                        #   编排（在飞闸、重读、先落库再派发）仍留在 AsyncRunner，纪律一字未改
│   │                        #   drain-gate.ts = 优雅停机的等待闸（停机态标志 / 排空等待 / 超时竞速）；
│   │                        #   在飞计数不搬（它同时是 /healthz 的 inFlight 口径），以谓词传入
│   │                        #   resume-policy.ts = 崩溃恢复的**认领判定**（跳过原因具名化：terminal /
│   │                        #   own-process / too-fresh）—— 「同一任务重复执行」那个 bug 就出在这几条规则上
│   │                        #   approval-supervisor.ts = 审批监督簇（2026-09-29 抽）：挂起登记簿
│   │                        #   （/healthz 的 suspended 读数）+ 在飞审批闸 + approve + 审批超时恢复；
│   │                        #   只**消费** AsyncRunner 注入的 dispatch 回调 ⇒ 依赖单向（不是 import）
│   │                        #   signal-supervisor.ts = 信号投递簇（同日抽）：挂起任务的外部唤醒入口，
│   │                        #   与 approve 同族（读记录 → 校验挂起 → 改状态 → 先落库再派发）；并发闸不同款 ——
│   │                        #   事件**串行成链**（不共享在飞那次），且多一道容量闸（上限 64）
│   │                        #   resume-scanner.ts = 恢复扫描与接管（同日抽）：resumePending 一次扫描
│   │                        #   按序干四件事（顺序有语义）—— rebuild → expireIfExpired → wakeDue → 认领重投；
│   │                        #   #dispatch 仍归 AsyncRunner，以回调注入（依赖单向）；
│   │                        #   认领 save 带同步抛错防护、三处落库失败有 warn（2026-10-13 ③）
│   │                        #   ⚠️ cancel × 推进路径互斥（2026-10-13 ②）：AsyncRunner 的
│   │                        #   #cancelInflight 与三个监督件互为对侧闸（各经 cancelInflight 回调
│   │                        #   读对方、以 inflightFor/inflightWakeFor 被对方读）；#executeInner
│   │                        #   起跑前还有一道取消意图闸 —— 「被取消的排队任务绝不起跑」靠它合上
│   │                        #   task-waiters.ts = 任务终态等待表（事件唤醒 + 兜底定时器）；**只覆盖本进程写终态**，
│   │                        #   他进程写终态唤不醒 —— 那是 awaitTask 里 intervalMs 兜底轮询存在的原因（不是缺陷）
│   │                        #   task-events.ts = 每任务的**记账事件缓冲 + 订阅表**（GET /tasks/:id/stream 的底座：
│   │                        #   重放 / 实时 / 终态收口三件事，纯记账、不碰 store 所以单独成件）。三条约束：
│   │                        #   序号是**流自己的**（一个任务可跨多个 run 段，每段 recorder 的 seq 从 1 重来）、
│   │                        #   有界 + 丢最旧 + 明示（stream.truncated，不静默）、终态流只留最近 16 条
│   │                        #   http-shapes.ts = HTTP 宿主的**出入站形状口径**（响应体 / 任务提交体 / 审批体 /
│   │                        #   事件体）：纯形状判定（不合法一律回 undefined，由路由选状态码）；审批体**全有或全无**，
│   │                        #   空 decisions 集合法 —— 「决定齐没齐」是 AsyncRunner 的判断，不是形状问题；
│   │                        #   事件体（2026-09-28 ⑥）是**白名单** `{ eventId?, type, payload }`（全是字符串，
│   │                        #   多一个字段即拒 —— 外部永远不能构造消息块）
│   │                        #   http-route.ts = 路由判定（pathname × method × 有无 metrics → 分支）：
│   │                        #   纯函数；三条顺序是全部内容 —— 免鉴权组的 405 先于鉴权、其余先鉴权再判
│   │                        #   方法/路径（未鉴权不泄露路径是否存在）、approve / cancel / events 与 stream 都先于
│   │                        #   通用 id 且「方法不对」压过「id 坏了」（DELETE /tasks/%zz/approve = 405，不是 400）
│   │                        #   http-endpoints.ts = **端点体**（http.ts 拆分第三步）：走到一条路上
│   │                        #   做什么 —— 派发表 handleRoute（穷尽性断言是 `const _never: never = route`；
│   │                        #   免鉴权组也在这张表里，表**不认识鉴权**，闸在宿主侧）+ 九条 handleXxx
│   │                        #   （读 body → 调 runner → 写响应 → 选状态码）。判据：`route.kind` /
│   │                        #   `sse.event(` / 三个形状解析器都只许出现在本文件 —— 源码级钉在
│   │                        #   tests/transport/http-boundary-guard.test.ts（连同「准入判定留在宿主」「派发表
│   │                        #   穷尽断言在场」），退化时构建红
│   │                        #   http-io.ts = **收发原语**（同一步的另半边）：sendJson / readBody /
│   │                        #   parseJsonBody / 405 / 413 / 503 / 500 的机械动作，**零内部依赖**
│   │                        #   （只 import node:http 的类型）—— 宿主与端点都引它 ⇒ 不可能成环是**构造性**的
│   │                        #   （`HttpException` 刻意不在这里：它是宿主契约，搬过去会让原语层反向依赖宿主）
│   │                        #   run-call-options.ts = run 选项的**装配件**（2026-10-11 自 async.ts 抽出）：
│   │                        #   buildRunCallOptions 把「按 isResume / sessionId / signal / trace 桥」拼出
│   │                        #   一套 RunCallOptions 的那 42 行收成一处，adoptSucceededOutcome 收「幂等去重的
│   │                        #   终态采纳」；RunSessionStore 是会话 store 的**结构面单源**（旋钮本身的文档仍在
│   │                        #   AsyncRunnerOptions.sessionStore）。抽的是纯件 ⇒ 不含任何 await 竞态。
│   │                        #   ⚠️ sessionId 在本层**被消费后不透传**（2026-10-12 ③）：续跑段不注入 session，
│   │                        #   原样带进去会误踩 app.run 的「直传 sessionId 不生效」告警闸（toolkit/module.ts）
│   │                        #   run-outcome.ts = 一次 run 的**结果记账**（同日抽，同族的第五件）：
│   │                        #   readClaimed 收「认领前重读」（读失败不升级成「任务起不来」）；
│   │                        #   applySuspendedOutcome / applyTerminalOutcome 收挂起与终态两支的**记录映射**。
│   │                        #   纯件 ⇒ 实例副作用（快照写 sessionInputs、审批登记簿除名）以**返回值**
│   │                        #   交回调用点；「用户输入快照必须在 rec.spec 被覆盖**之前**取」是承重的顺序事实
│   ├── store/               # 任务记录存储：memory / file(JSONL) / sqlite / redis
│   │                        #   **副本契约**（spec §10 2026-10-13 ①）：save 入库与
│   │                        #   get/byIdempotency/list 出站一律走 cloneTaskRecord
│   │                        #   （深拷纯数据、AbortSignal/函数按引用保留）—— 内存推进只许由
│   │                        #   save 驱动，「改 rec 就改了库」是契约违规
│   ├── integrations/        # 外部系统适配：OpenAI 兼容端点(ModelClient)、OTLP 导出、
│   │                        #   MCP 桥(duck-typed) + 出厂连接器(stdio/StreamableHTTP，只用标准库)、
│   │                        #   指标(metricsSink，满足 TraceSink)
│   │                        #   mcp-protocol.ts = 桥与两个连接器**共用**的协议面（13 helper + 3 常量 + 5 结构类型）：
│   │                        #   2026-09-28 自 mcp.ts 抽出，为断开 `mcp.ts ↔ mcp-stdio.ts` 那条**真实值环**
│   │                        #   （「层内也运行期无环」现由 tests/architecture/file-cycles.test.ts 钉住）。
│   │                        #   2026-10-11 再收 7 个（5 → 12）：两个连接器**各自抄了一份**的 JSON-RPC 结果
│   │                        #   提取 / HTTP 错误包装 / tools 清单校验 / isError 拒绝 / 会话自愈判定 ——
│   │                        #   同一条错误文案曾存在两份，改一处漏一处**没有任何用例看得见**。
│   │                        #   2026-10-12 再收 2 个（12 → 13 helper、4 → 5 类型）：SEP-414 出站的
│   │                        #   `McpCallOptions.traceparent` 与 params 装配 `toolsCallParams`
│   │                        #   （`_meta` 裸键形状只许一处）；traceparent 的值由**桥**（mcp.ts）从
│   │                        #   ToolRunContext 投影 —— integrations 够不到 engine 的
│   │                        #   `currentTraceparent`，而 ctx 里的 traceId+parentSpanId 与它同源同格式
│   ├── container/           # 最小显式 DI（useValue/useClass/useFactory+deps），叶子无依赖
│   ├── toolkit/             # 声明式表面：装饰器×4、collect 内核、装配(createApp/defineModule)、
│   │                        #   中间件、目录发现(discover)、文本资产(asset)、env 引导(loadEnvFile)、zod 桥
│   │                        #   capability-slice.ts = **四类能力在装配期的全部差异只在这张表里**（§10 2026-09-29 ③）：
│   │                        #   CapabilityPayloads 就是「一类能力」的定义，KIND_SPEC 是映射类型
│   │                        #   （加一类能力不给表项 ⇒ `tsc` 报 TS2741），CAPABILITY_KINDS 从表的键派生
│   │                        #   ⇒ 收集 / 可用名单 / 切片 / 版本表 / 孤儿计数五处**遍历**它，
│   │                        #   module.ts 里不再有按类分支。⚠️ 两处**刻意不在表里**（别为整齐搬进来）：
│   │                        #   菜单重名校验（跑在合并后的工具列表上，与类别无关）、能力引用图
│   │                        #   （只有 @SubAgent / @Skill 有 tools 引用 —— 语义不对称，不是漏项）
│   │                        #   capability-cycles.ts = **能力引用图的成环检测**（装配期纯件，2026-09-28 ⑫）：
│   │                        #   环只在运行期成立（引用是延迟求值 thunk）、`maxIterations` 限不了深度 ⇒
│   │                        #   装配期即拒（刻意不走「递归深度上限」那条路，理由见文件头注）
│   ├── eval/                # evals（D2）：scriptedClient + defineEval + harvest(trace → eval 用例骨架) ——
│   │                        #   **叶子消费模块**，只依赖公共面、零反向依赖（谁都不 import 它）
│   └── index.ts             # 公共 API 唯一出口（新增导出必须在此登记）
├── tests/                   # node:test 单测，目录镜像 src（tests/transport/x → src/transport/x）
│   ├── helpers.ts           # 共用 mock client（**忽略 on('text')**；要「真吐字」用 src/eval 的
│   │                        #   scriptedClient —— 两者定位不同，改 helpers 影响全部套件，谨慎）
│   ├── fixtures/            # discover/asset 测试夹具
│   ├── architecture/        # 分层守卫：解析 src 的 import 图（覆盖 from / 副作用 / 动态 import
│   │                        #   字面量三种形式，带解析计数下限护栏防真空变绿；BARREL 豁免只认
│   │                        #   src/index.ts 本身），断言「允许边集合 + 无环 + src 不引 src 之外」——
│   │                        #   AGENTS.md「分层单向」的可执行版本
│   ├── types/               # **类型断言测试**（*.types.ts，只被 typecheck:types 编译、不被 node:test 收）
│   └── docs/                # 文档校验（usage-guide.md 的表格逐项对源码核；api.html 的导出表
│                            #   正向核 + **反向全覆盖**：导出面的每个导出都必须在页面上出现；
│                            #   website-css.test.ts 钉官网表格版式不变量，见 packages/website 段；
│                            #   no-legacy-terms.test.ts 钉「面向使用者的表面不得出现旧伞形术语」——
│                            #   覆盖文档 / 官网 / npm 包 README 与 description / CLI 的 --help 与报错文本；
│                            #   仅 `<!-- no-legacy-terms: allow -->` 标记块内可豁免，且有行数上限）
├── scripts/e2e-cli.ts       # CLI 端到端（npm run e2e 第一步：脚手架→生成→装配→mock run
│                            #   + **字面跑产物自己的 `npm run typecheck` / `npm run build`**
│                            #   （'@migor/agentia'、@types、.bin/tsc 经 node_modules 软链解析 ——
│                            #   即发布形态；测试不复刻脚本里的命令）+ 第 4d-bis 步真删一个能力
│                            #   再重建，断言旧产物消失；第 9 步 pack → 离线安装 → 真跑最小 run，
│                            #   并用**装出来的** CLI 真建一个工程点验文件 —— 「模板没进 tarball」
│                            #   这类问题 `--version` 抓不到，只在用户 `agentia create` 时才炸）
├── scripts/e2e-dev.ts       # dev 环端到端（npm run e2e 第二步：`agentia create` 建工程 →
│                            #   真起 `agentia dev` → 真跑 run。守的是一整块**没有单测能覆盖**的
│                            #   东西：IPC 就绪（菜单非空）/ 工程 `.env` 真被读 / 能力收窄后请求体
│                            #   真变窄 / 改 `.md` 与项目根 `.env` 真触发重启 / 中止在飞 run 且 trace
│                            #   落盘 / 清空对话换 id 且落盘 / 重启总账无自噬 / 换能力选择的重启
│                            #   窗口内第二个 POST /run 必须 409 / 坏会话文件必须进 warning 通道 /
│                            #   `dev -- "问题"` 的 prompt 真到模型手上 / 右栏实时（增量帧先于
│                            #   run-done，折回 == 收尾整棵 trace）/ 工作目录真到工具（假端点驱动
│                            #   tool_use，A/B 两目录的 marker 各读各的）/ lastError 不跨代复用
│                            #   （runner 一句话没说就死时，告警条不能挂上一代 run 的旧错误）/
│                            #   Ctrl+C 后不留孤儿进程。
│                            #   模型侧是本进程里的假 Anthropic 端点，零网络零 token）
├── scripts/e2e-examples.ts  # 示例端到端（npm run e2e 第三步：examples/complete 真构建、真起服务，
│                            #   按它 README 跑完 /healthz · 鉴权 401 · 同步 /run · SSE · 异步 /tasks ·
│                            #   /metrics · 优雅停机；模型侧是内置假 OpenAI 兼容端点，不联网）
├── scripts/e2e-deploy.ts    # 部署示例端到端（npm run e2e 第四步：examples/deploy 真构建、真起服务，
│                            #   跑 /healthz · 同步 /run · /metrics · 优雅停机 + **崩溃续跑**
│                            #   （SIGKILL 后同库重启 resumePending 续跑）；假 Anthropic 端点，不联网）
├── scripts/e2e-grpc.ts      # gRPC 宿主端到端（npm run e2e 第五步：examples/grpc-host 真构建、真起宿主，
│                            #   用**示例自带的客户端**跑四个 RPC —— 一元 / 服务端流 / 异步投递 / 查任务；
│                            #   守四处语义：deadline 到期服务端 run 真被 abort、metadata traceparent →
│                            #   run 根 link、同 session_id 共享历史、同 idempotency-key 不重复执行；
│                            #   假 Anthropic 端点 + tempdir trace，不联网、不留产物）
├── scripts/e2e-mcp.ts       # MCP 端到端（npm run e2e:mcp：真第三方 server → 桥 → 菜单 → 真跑一轮）
├── scripts/e2e-mcp-server.ts  # MCP 反向桥端到端（npm run e2e:mcp:server：带 @Tool 的 app →
│                            #   createMcpServer（stdio 真子进程 + HTTP 真端口）⇐ 出厂连接器当真协议
│                            #   客户端打回去；trace 经 jsonlTraceSink 落盘逐条对账。离线零网络）
├── scripts/e2e-live.ts      # 真 API 集成验证（npm run e2e:live：真实厂商端点跑框架主路径 ——
│                            #   SSE 分片 / tool_use / tool_result 回灌 / cache_control / signal 中止 /
│                            #   runAgent 全链。走 ANTHROPIC_BASE_URL，用 DeepSeek 的 Anthropic 兼容端点
│                            #   即可，**不需要 Anthropic key**。⚠️ 会真花 token ⇒ 不进 verify-all / CI）
├── scripts/e2e-soak.ts      # 浸泡/压力验证（npm run e2e:soak：本地假端点 + 种子固定的故障注入
│                            #   （429/截断/400/流内错误）+ N 并发长跑 ⇒ 断言失败率≈注入率、
│                            #   错误分类无 unknown、metrics 与实测对账、内存有界、干净退出。
│                            #   零网络零 token；SOAK_DURATION_MS / SOAK_CONCURRENCY / SOAK_SEED 可调）
├── scripts/e2e-soak-app.ts  # 「完整装配 × 时间维度」（npm run e2e:soak:app：**黑盒**起 examples/complete
│                            #   的 dist + 假端点故障注入，中途用闸门把任务精确停在 running 再 SIGKILL ⇒
│                            #   断言不丢 / 不重（幂等簿记）/ 猝死续跑真把活干完 / 注入按比例落地 /
│                            #   定时触发真在派 / 干净退出 / DB 每任务字节数有界。
│                            #   零网络零 token；SOAK_APP_DURATION_MS / SOAK_APP_CONCURRENCY 可调）
├── scripts/bench-trace-cost.ts  # trace 记录成本基准（npm run bench:trace：量「一条 run 的 trace 多大」——
│                            #   缺省 / 不截断 / 截断 200 三种口径 × 工具调用数；实测大出参下「不截断」是
│                            #   缺省的 13.7× ⇒ spec §9.4「全量记录成本 vs 采样阈值」的答案来源。
│                            #   零网络零 token；PAYLOAD_ROWS / CALLS 可调；不进 verify-all（与 e2e:live 同档））
├── scripts/bench-app-assembly.ts  # 装配税基准（npm run bench:assembly：D8「换一次能力选择 = 重建一次 app」
│                            #   的真实代价 —— S1 纯装配 / S2 发现+装配（热 import）/ S6a 进程启动 /
│                            #   S6b 进程启动+装配 / S6c 走 dist 的对照 / S4-S5 MCP 握手的冷热两档。
│                            #   零网络零 token（MCP 侧是本地夹具）；CAPS / RUNS / BOOT_DIST 可调；
│                            #   与 bench:trace 同档，不进 verify-all / CI）
├── scripts/mcp-fixture-server.py  # 离线夹具 MCP server（stdlib，e2e:mcp 的兜底）
├── scripts/copy-assets.mjs  # 把 docs/usage-guide.md 拷成 dist/AGENTS.md（随框架包发布，见「文档单源」）
├── scripts/release-surface.mjs  # **发布面清单（单源）**：一次发版要动哪些文件的哪个值 ——
│                            #   18 项替换面（每项带 count 期望值 + 「漏了会怎样」）+ 3 项结构面；
│                            #   闸门与 bump 共用这一份。`--list` 给人看、`--json` 给测试
├── scripts/check-release.mjs  # 发版闸门：逐项断言「发布面 == 包版本」+「高于 npm 已发布版本」，
│                            #   挂在**两包的 prepublishOnly**（不进 verify-all：未发布窗口内
│                            #   AGENTIA_VERSION 有意落后）。`--offline` 跳网络、`--allow-pending` 降级骨架
├── scripts/release.mjs      # 发版工具：`bump <x.y.z>`（逐项替换，带计数断言，不符即中止且不写盘）
│                            #   / `tag <x.y.z>`（核对 registry 产物 ↔ 仓库树后打 **annotated** tag
│                            #   + 建 Release）/ `retag <x.y.z>`（lightweight → annotated，默认只演练）
├── packages/
│   ├── cli/                 # npm 包 @migor/cli（agentia create/g/dev/doctor/report/harvest/diff/add），零运行时依赖
│   │                        #   report = trace.jsonl → 调优报告；harvest = trace.jsonl → eval 用例骨架
│   │                        #   （harvest 的用例生成器是框架 src/eval/harvest.ts 的去类型移植副本，
│   │                        #   packages/cli/test 有逐字对拍守护，改生成格式必须两边同步）；
│   │                        #   diff = 两条 trace.jsonl 的调用树 A/B 比对（有差异退出码 1），
│   │                        #   其 diffTraces 是框架 src/engine/trace-diff.ts 的去类型移植副本，
│   │                        #   同样有逐字对拍守护，改算法必须两边同步
│   │                        #   机器可读面：report / diff / doctor 支持 --json（stdout 只一个 JSON
│   │                        #   文档、无人类装饰；出错仍 stderr + 退出码 1，stdout 保持空）；harvest
│   │                        #   刻意没有 —— 它的 stdout 就是产物（生成的 eval 源码）。
│   │                        #   --version / -v 读**包自身 package.json**（不另存常量，免得漂）。
│   │                        #   脚手架的 `dev` script 指向 `agentia dev`（与 npx 同一条路、带面板），
│   │                        #   所以 dev 必须把额外参数透传给用户脚本（`npm run dev -- "问题"`）。
│   │                        #   脚手架还把 CLI 自己写进新工程的 devDependencies（走本地 bin、离线可用、
│   │                        #   版本与框架同批 pin）⇒ templates/package.json 因此有**两条**版本发布面。
│   │                        #   脚手架模板是 templates/ 下的**真文件**（占位符替换渲染，token 只许在
│   │                        #   字符串/注释/标识符位置），被仓库自己的 tsc（tsconfig.templates.json，
│   │                        #   '@migor/agentia' paths 映射到框架 src）与 Biome 全程照看 —— 不再是
│   │                        #   不过编译器的字符串（「生产必崩」缺陷曾这么漏出去）；构建时整树拷进
│   │                        #   dist/templates/，运行时从 dist 读。点文件以无点文件名存放
│   │                        #   （gitignore/env/env.example）：.env 会被根 .gitignore 吞掉、
│   │                        #   .gitignore 会被 npm pack 剥掉。Biome 对 templates/** 只关 formatter
│   │                        #   （生成物字节是兼容契约），lint 照常。
│   │                        #   dev = 本地 inspector 面板 + CLI 自己管的 runner 子进程（不用 tsx watch：
│   │                        #   watch 由 dev.ts 收编，允许清单含 .md；面板带 Origin 校验 + per-session token，
│   │                        #   非 localhost 的 Host 头仍 403；trace-view 产物拷进 dist/inspector）；
│   │                        #   dev/add 支持 Windows
│   │                        #   （npmSpawn：win32 走 cmd.exe /d /s /c 包装 + 逐参数脱敏 ——
│   │                        #   CVE-2024-27980 后裸 spawn .cmd 会 EINVAL，shell:true 不转义
│   │                        #   参数、add 的包名是用户输入有注入面）；build 自给自足（copy-assets 在 trace-view
│   │                        #   未构建时就地补跑其构建，prepublishOnly 只跑 build，无需根 build:cli 预热）
│   ├── trace-view/          # trace 调用树渲染器（零依赖 ESM）：createTraceView + playTrace(真实 Trace)
│   │                        #   官网 playground 与 CLI inspector 共用同一份，避免两处渲染漂移
│   │                        #   test/ 用 node:test，**已并入根 `npm test`** —— 这份共用的渲染器
│   │                        #   此前没有任何门禁在跑，等于「两边都靠它、却谁都不守它」
│   └── website/             # 官网（Astro 静态站，构建产物 dist/ 部署 Cloudflare Pages）
│                            #   src/layouts/Base.astro 全站外壳、src/components/ 共享组件
│                            #   src/fragments/*.html 页面正文（?raw 注入）、src/scripts/ 客户端脚本
└── docs/                # spec.md（锁定决策）、roadmap.md（方向与状态）、
                         # usage-guide.md（**使用者向唯一说明**：CLI 项目 AGENTS.md 与官网 llms.txt 的单源）
                         # 根目录 CHANGELOG.md 是发布史与迁移指南（npm 的「总是包含」不含它：
                         #   根包靠 files 登记，CLI 包靠构建期拷贝到包根 —— e2e-cli 有 pack 断言守着）
```

## 硬约定

- **分层单向**（`tests/architecture/layering.test.ts` 强制；改依赖方向必须同步改该测试的 ALLOWED）：
  core ← engine ← { runtime, store }；store ← transport；runtime ← toolkit；
  `integrations` 只依赖 core（模型/trace 适配器），**engine 依赖 integrations**（仅为取默认
  ModelClient，见下条）；`container` 与 core 是叶子
  （不 import 任何东西），container 仅被 toolkit 依赖。core 不依赖任何上层。
  `index.ts` 是公共唯一出口，允许引用全部层。
  `eval/` 是**叶子消费模块**（依赖 toolkit 与公共面）：它 import 别人，别人不 import 它。
  - `RunStatus`/`RunMeta` 落在 `core/`、run 调用契约落在 `engine/`：它们本是 store/transport
    与 runtime **共用**的类型，早先放在 runtime 逼出了 `store → runtime` 这条未声明的兄弟层
    依赖 —— 已按「纯数据去 core、共用入参契约去 engine」下沉（类型导入也计入分层，虽运行期擦除）。
- **内部工具不进公共面**：跨模块/测试要用的 helper 可以做 **module 级 export**（如 `engine/trimming.ts` 的
  `createTokenCounter`、`engine/turn.ts` 的 `replaceMessages`），但**不要**加进 `src/index.ts` ——
  一旦进了公共导出面，`tests/docs/api-page.test.ts` 的反向全覆盖就会要求官网 API 页同步，
  而那些是纯内部实现细节。
- **零运行时依赖（2026-09-17 达成；`tests/architecture/no-runtime-deps.test.ts` 强制）**：
  三个包的 `src/**`（`@migor/agentia` / `@migor/cli` / `@migor/trace-view`）运行时只能 import
  **相对路径**与 **`node:` 内置模块**，且这三个 `package.json` 不得有非空 `dependencies`
  （依赖只能进 devDependencies）。`packages/website` 是私有 Astro 站点、不进 npm 产物，在该测试里
  以 EXCLUDED 显式豁免。**开例外要同时改该测试的 ALLOWLIST 与本节** —— 两边不一致会失败。
  源码层干净即产物层干净，依据是**全仓无打包器**（三个包分别是 `tsc` 1:1 转译 / 纯文件拷贝）；
  哪天引入打包器，必须补一条扫 `dist/**` 的守卫。
  `@anthropic-ai/sdk` 已退入 devDependencies —— 公共消息类型
  自有（`src/core/message.ts`，`MessageParam` / `Message` / 块联合 + `{ type: string }` 兜底成员，
  命名避让：`ToolParam` ≠ @Tool 装饰器、`MessageUsage` ≠ trace 的 `Usage`），SDK 只留下做
  类型兼容门禁（`tests/types/message-compat.types.ts` 钉双向/单向 assignability）。
  可选能力（zod、redis 客户端）一律 duck-typed / peer。
  ⚠️ 兜底成员**绝不可加索引签名**：SDK 的块类型全是 interface（无隐式索引签名），
  带 `[key: string]: unknown` 会让「SDK 类型整体赋给自有类型」编译失败（方向一破产，见 spec §10 当日条）。
  ⚠️ `tsconfig.json` 的 `"types": ["node"]` **不可删**：全仓 @types/node 此前是靠
  「import SDK 类型 → undici-types → `/// <reference types="node" />`」的传递链偶然进编译程序的，
  SDK import 移除后只能靠显式声明。
- **宿主 / 集成接入不打包**（判别规则只有一条：**客户端是不是标准库**）：只用标准库的平台能力
  （MCP stdio 的 `spawn` + 全局 `fetch`）直接内置；要引第三方客户端的（gRPC 的 `@grpc/grpc-js`、
  Kafka 的 `kafkajs`）**只留 duck-typed 缝 + 配方 / 示例**，框架永不 import —— 这就是
  `examples/grpc-host/` 是示例而不是包的原因。真到该拆包时，粒度是**一个第三方客户端一个包**，
  不是把所有集成塞进一个「服务包」；理由与升级触发条件见 spec §10 2026-09-18 ⑪。
- **默认 client 是自研 fetch + SSE 实现**：`src/integrations/anthropic.ts` 手写
  `POST {baseURL}/v1/messages` + 逐行 SSE 组装，**不再实例化 `@anthropic-ai/sdk`**；
  引擎经 `createAnthropicClient()` 取默认 client。使用者自定义只需
  `createAnthropicClient({ apiKey, baseURL })`，**不必直接依赖该 SDK**。
  ⚠️ 错误分类随之改为**鸭子类型**：`engine/errors.ts` 不再 `instanceof` SDK 错误类，
  改认数值 `status`（429→rate_limit、5xx→server、其余 4xx→api）、带 `cause` 的
  TypeError / errno `code`（→connection）。历史教训：该 SDK 的错误类 `name` 恒为
  `'Error'`、`type` 为 null，鸭子类型若靠 `constructor.name` 则压缩即失效 ——
  所以只认数据属性。已知边界：SDK 的 `APIConnectionError` 无 status/code 可判，
  若使用者自装 SDK 并让它抛到引擎，该类错误会落 unknown（该重试的不再重试）。
- **lint / format**：Biome 单工具二合一（`biome.jsonc`）。`npm run lint` 检查、`npm run lint:fix` 写回；
  CI 有独立 `lint` job，**并且已折进 `scripts/verify-all.sh` 的第 1 步**（本地这条链与 CI 是同一条，
  「本地全绿、CI 挂 Biome」曾经真的发生过 —— 加检查要折进已有步骤，理由见「验证顺序」）。规则基线刻意关掉三条与既有风格冲突的（理由写在 `biome.jsonc` 注释里）；
  `.astro` 与独立 `.svg` **不在 lint 面**（Biome 对 Astro 语法支持不全，会误报）。
  ⚠️ **`src/core/blackboard.ts` 的空 `interface Blackboard {}` 是声明合并锚点，绝不可改成 `type` 别名** ——
  Biome 的 `noEmptyInterface` 自动修复会这么干，已用 `biome-ignore` 注释钉住（改了就废掉「扩展黑板键获得补全」）。
- **Node 下限靠延迟加载守护**：`node:sqlite`（≥22.5）等内置模块**不可顶层静态 import** ——
  `src/index.ts` 的导出是 eager 的，静态 import 会让**整包**在旧 Node 上加载即崩（而 `engines` 写着 `>=18`）。
  一律延迟加载 + 可读报错，并由 CI 的 `import-floor` job 在 Node 18/20 上实跑验证。
- **ESM NodeNext**：相对 import 必须带 `.js` 后缀；注释用中文。
- **`exactOptionalPropertyTypes` 是承重开关（2026-09-18 起，勿关）**：它让
  `{foo: x}`（`x: T | undefined`）**不再是**合法的 `foo?: T` —— 「不传这个键」与「传了个
  undefined」被区分开。关掉 = 39 处防线无声消失（`retry.ts` 的「显式 undefined 覆盖缺省」
  重新变成合法代码）。由 `tests/architecture/tsconfig-strictness.test.ts` 钉住。
  **改类型时按角色分三类**（改错类别 = 把开关的价值自己放掉）：
  ① **结果/状态记录**（总是写进对象字面量）→ 必填 `T | undefined`（`AgentRunResult` /
  `RunMeta` / `TurnOutcome` …）；② **内部管道**（缺省与 undefined 等价）→ 可选 `?: T | undefined`
  （`AgentLoopArgs` / `Job` / `TaskRecord` …）；③ **公共入参**（「不提供 = 用缺省」有意义）
  → **签名不动**，在调用点条件展开 `...(x !== undefined ? { x } : {})`，或一次转交多字段时用
  `omitUndefined({...})`（`src/core/object.ts`）。理由与实测见 spec §10 2026-09-18 ⑦、`docs/guards.md` 附录。
- **测试**：`npm test`（node:test）；新行为必须带测试，断言按真实语义写（先读实现）。
- **多 agent 同仓作业**：本机可能有多个 agent 同时在这个仓里改代码。三条纪律：
  ① **结论一律钉到 commit**（commit 不可变才可复现），未提交的在制品不评审（评草稿 = 白评）；
  ② **门禁/测试跑在隔离导出树**（`git archive <sha> | tar -x -C <tmp>` + 软链 `node_modules`），
  不在共享工作区跑 —— 那里读到的是别人改到一半的中间态，结论随对方下一次保存失效；
  ③ **遇到不属于自己的未提交改动：不提交、不修改、不还原**；commit 只 add 自己动过的文件。
- **承诺过的 script 必须真跑，且测产物要用产物自己的输入**：脚手架/模板在 package.json 里
  承诺的每个 script（dev / build / start …），e2e 至少**真执行一次**（「产物存在」≠「产物能跑」——
  只断言 dist/main.js 存在的那版门禁全绿时，`node dist/main.js` 一跑就崩）；凡「测产物 X」必须用
  **X 自己的输入/代码路径**（如模板生成的入口文件、模板里那句路径表达式），禁止测试脚本另算一份
  等价输入绕过产物 —— discover「生产必崩」（#83）就是这么漏的：测试脚本自己 `join(proj, 'src/tools')`，
  模板里有病的 cwd 相对路径从未被执行。
- **验证顺序**：`npm run typecheck && npx biome ci . && npm run build && npm run typecheck:types && npm run typecheck:tests && npm run build:cli && npm test && npm run e2e && npm run build:website && node scripts/check-website-agent-readiness.mjs` 全绿才算完
  （在仓库里就是 `bash scripts/verify-all.sh`，8 步 —— 第 1 步同时管类型检查与 lint）。
  - **要加检查，折进已有步骤，不要加第 9 步**：`verify` job 的 name 是分支保护的必需状态检查，
    而它写死了步数（「全链验证（verify-all 8 步）」）。加一步这名就成了假话；改名则 PR 会卡死
    等一个永不出现的检查。折进已有步骤还有个好处 —— 新检查直接落进**必需**检查里。
    lint 就是这么进来的：它原本只在 CI 的独立 job 里，本地链不跑它，于是「本地 8/8 全绿、
    CI 挂 Biome」是可能的（2026-09-14 真发生了一次）。
  - `typecheck` = src；`typecheck:tests` = src+tests（含测试目录的类型错误）**+ `examples/` 四份示例的 `src`**
    —— 示例此前被 tsconfig 排除在外，等于「文档指着它说『完整可跑写法』、却没有任何门禁守着」；
    靠 `paths` 映射指到框架 `src` 与 `examples/observability` 源码，因此**无需在示例目录里 install** 即可检查；
  - `typecheck:types` = **针对构建产物 dist 的类型断言测试**（`tests/types/`，用 `@ts-expect-error`
    断言「应当报错」的场景真的报错）—— 必须先 `build`。它与 src 分开编译是**必须**的：模块增强
    （`declare module '…' { interface Blackboard }`）在同一编译程序内全局生效，混在一起会污染 src。
  - 另有 `npm run e2e:mcp`（真接第三方 MCP server，需要网络 / uv；离线自动回落
    `scripts/mcp-fixture-server.py`）。它**不并入**上面 8 步，但动了 `integrations/mcp.ts` 就要跑。
  - 另有 `npm run e2e:mcp:server`（MCP **反向**桥：app 菜单暴露成 MCP server，两个传输都真跑，
    客户端是我们自己的出厂连接器；离线零网络）。**不并入**上面 8 步，但已是 CI 的独立必需检查
    `e2e-mcp-server`（与 e2e:mcp 同档 —— 唯一区别是它不需要 uv，CI 与本机跑同一条路），动了
    `engine/mcp-server.ts` 就要跑。
  - 另有 `npm run e2e:live`（真 API 集成验证）。**不并入**上面 8 步、**不进 CI**（会真花 token），
    无凭据时跳过并打横幅（静默跳过 = 假装验过）。动了 `integrations/anthropic.ts` 或
    `core/tool.ts` 的 `ModelClient` 契约就要跑它 —— **mock 全绿发现不了「SDK 真实行为与我们的假设不符」**：
    2026-09-14 靠它挖出「默认 client 从不转发 `signal`」（中止在飞 run 失效，见 spec §10）。
    那次也留下一条更省的教训：这类「契约有没有真落到传输层」的断言，**本地假端点**就能在 CI 里零成本守住
    （`tests/integrations/anthropic.test.ts` 就是这么做的），不必依赖真端点。
  - 另有 `npm run e2e:soak`（浸泡/压力：本地假端点 + 故障注入 + 并发长跑，零网络零 token）。
    **不并入**上面 8 步（它是「跑多久」而不是「对不对」的验证）。默认 60s×16 并发；
    排「内存/句柄随时间泄漏」或「高并发下重试与背压行为」这类**时间维度**的疑点时跑它
    （`SOAK_DURATION_MS=7200000` 即真两小时）。
  - 另有 `npm run e2e:soak:app`（**完整装配 × 时间维度**：`e2e:soak` 压的是**无状态单点**
    （import 面只有 `runAgent` 那几个），跑完整装配的 `e2e:examples` 又是**只跑一轮**的线性脚本 ⇒
    这一格原本空着）。**不并入**上面 8 步，理由同 `e2e:soak`：默认 30s×6 并发，是「跑久了对不对」。
    改了 `transport/` 的异步任务面（store 认领 / resumePending / scheduler）值得跑它。
  - **CI**：`.github/workflows/ci.yml` —— 七个 job：① `verify`（`bash scripts/verify-all.sh`，与本地**同一条链**，
    不新增检查项）；② `lint`（`npx biome ci .`）；③ `import-floor`（在 Node 18/20 上验证「包可导入」——
    守住 `engines: >=18` 的声明，见 `scripts/check-import-floor.mjs`）；④ `e2e:mcp`（runner 无 uvx ⇒ 必走回落分支，
    同时当回落守卫）；⑤ `e2e:mcp:server`（MCP 反向桥端到端，离线零网络，CI 与本机同一条路）；
    ⑥ `deploy-website`（**发布**，只在 `main` 上跑：`needs: [verify, lint]` + `npm run deploy:website`
    推 Cloudflare Pages。PR 上 skip。**它不是必需状态检查，不要加进分支保护** —— 同下面 `verify` 的坑）；
    ⑦ `docker-image`（**构建 `examples/deploy` 的镜像**：本机没有 docker、本地链跑不了它，于是「镜像建不建得起来」
    此前只活在文档的示例命令里。**同样不是必需状态检查**，但它把那一跳变成 CI 侧的真实构建 —— 首次绿就是它的验证）。
    **`verify` 的 job name 是分支保护的必需状态检查，改名 = PR 永远等不到该检查 → 卡死**；
    同理**不要给 `verify` 加 matrix**（matrix 会给检查名加后缀）。要挡更低 Node 版本请另开 job。
    发布 job 需要仓库 secret `CLOUDFLARE_API_TOKEN`（Account → Cloudflare Pages → Edit）与
    `CLOUDFLARE_ACCOUNT_ID`；**缺 secret 时它响亮失败，不静默跳过** —— 静默跳过正是「以为部署了、
    其实没有」的病根（2026-09-13 官网合并了却仍跑旧版，就是这么来的）。
    `verify-all.sh` 用 `cd "$(dirname "$0")/.."` 自推仓库根 —— **别再往里写绝对路径**（本地能跑、CI 必挂）。
    失败分支**必须先用 `grep` 抽失败标记行**（`✖` / `not ok` / `AssertionError` / `error TS`）再 `tail` ——
    整段输出被捕获进 `$out`，只 `tail -30` 恰好会把「哪条测试挂了」冲掉，CI 上就只剩一个 exit 1，谁也查不出是谁。
  - 文档改完记得重建派生产物：`npm run build`（→ 框架包 `dist/AGENTS.md`）、
    `npm run build:cli`（→ CLI `dist/AGENTS.md`）与 `npm run build:website`
    （→ `llms.txt` / `llms-full.txt`），否则线上与实际说明漂移。
- **设计决策**：改语义的决定要同步 `docs/spec.md` §10 决策记录；方向性工作更新 `docs/roadmap.md`。
- **使用者向文档单源**：`docs/usage-guide.md` 是**唯一**的框架使用说明（API 速查 + 类型链路 + 已知边界 + 反例）。
  它被四处消费：① 框架包构建时拷成 `dist/AGENTS.md`（`scripts/copy-assets.mjs`，随 `@migor/agentia` 发布）；
  ② `packages/cli` 构建时拷成 `dist/AGENTS.md`，`agentia create` 写进新项目的 `AGENTS.md`；
  ③ 官网 `/llms-full.txt`（整篇）与 `/llms.txt`（索引，导出清单也从同一份里抠）；④ 人类速查。
  **不要另写第二份**：`tests/docs/usage-guide.test.ts` 会拿它里面的表格逐项对源码校验，改名/删字段立刻失败。
  三份副本都是**构建产物**（落在各自 `dist/`，已 gitignore），只拷不手写，因此不存在漂移。
- **发布**：两包版本同步（@migor/agentia 与 @migor/cli），CLI 模板里的框架依赖版本跟着走。
  ⚠️ **发布面不是「两个 package.json」，也不是「四处」** —— 一次 bump 真实动到十几个文件：
  `examples/` 的 `^旧版` pin（含两个 Dockerfile **注释**里那份）、`.github/ISSUE_TEMPLATE/*.yml`
  的版本占位、README 版本行、`docs/roadmap.md` 状态行、`docs/spec.md` §11 进度链、CHANGELOG 的
  compare 基线与链接引用、`package-lock.json` 的 version 字段、官网对渲染器的精确 pin。
  清单**只有一份**：`scripts/release-surface.mjs`（`--list` 可查）。闸门 `scripts/check-release.mjs`
  逐项断言「== 包版本」，bump `scripts/release.mjs bump` 逐项替换且**每项带计数断言**
  （不符即中止、一个字节都不写）。闸门挂在**两包的 `prepublishOnly`** —— **不**进 `verify-all`：
  未发布窗口内 `AGENTIA_VERSION` 是**有意落后**的（包版本先行），只有真发时才要求一致；
  不一致 `npm publish` 当场失败。同处还有一条 **bump 闸门**：要发的版本必须高于 npm 已发布版本
  （查官方 registry，E404 放行）—— 只验一致不验高低时，破坏性变更可能压在旧版本号上发出去。
  - **发版步骤（顺序不能换）**：`node scripts/release.mjs bump <x.y.z>` → 填掉它标出的两个
    `TODO(发版)`（CHANGELOG 正文 / spec §11 链说明）→ `bash scripts/verify-all.sh` → 开 PR 等必需
    检查绿 → **先发布**（两包分别 `npm publish`；`prepublishOnly` 会先自检再 build）→ 合并 PR →
    `node scripts/release.mjs tag <x.y.z> --title '一句话'`。**发布必须在合并之前**：反过来的话
    main 上会挂着「已发布」而 registry 还没有，这个谎会一直挂到发出去为止。
  - **tag 一律 annotated**（`release.mjs tag` 负责）。**不要用 `git tag -a … -m "<消息>"`**：
    消息里全是反引号，shell 会把反引号内容当**命令替换**执行 —— 消息里的词当场消失、bash 先打一行
    “No such file or directory”，而 tag 照样创建成功（本仓库真踩过）。脚本的做法是消息写文件 +
    `-F` 传入，建完 `git cat-file tag` 回读。存量 lightweight tag（v0.5.0 / v0.6.0 / v0.6.1）要转
    annotated 用 `node scripts/release.mjs retag <x.y.z>`（**默认只演练**，`--apply` 才真改；
    它按哈希判据确认这个 tag 确实是当初发出去那版才动，force-push 已推送的 tag 是外部可见动作）。
  - **打 tag 前会核对「registry 产物 ↔ 仓库树」**：单源文档 `docs/usage-guide.md` 与 tarball 内
    `dist/AGENTS.md` 的 sha256 必须相等，另加产物里的 `AGENTIA_VERSION`、CLI 包零 `@migor/*` 依赖、
    `dist/inspector/` 在场。不等就是「这棵树不是发出去那版」，直接拒绝打 tag。
- **官网（Astro）**：`packages/website` 是独立私有包，只影响官网，与框架本体和两个 npm 包无关。
  构建 `npm run build:website`（产物 `dist/`，已 gitignore），部署 `npm run deploy:website`（构建后上传）。
  - **wrangler 钉死 `4.131.0`，不要改回裸 `npx wrangler`**：`latest`（4.131.1）依赖的 workerd 二进制
    `@cloudflare/workerd-darwin-64@1.20260911.1` 从未发布（registry 最大 `1.20260910.1`），裸 `npx`
    会去拉 latest → workerd 装不上 → 挂死。`4.131.0` 是当前能装的最新版。
  - 客户端脚本必须写在 `<script>` 标签里：**frontmatter 里的 import 只在构建期（Node）执行，不会下发到浏览器**。
  - 页面正文经 `?raw` 片段 + `set:html` 注入——模板里 `{` 会被当表达式解析，而正文含大量 TS 代码块。
  - `build.format: 'file'` 保持 `*.html` 既有 URL；`build/`、`dist/`、`.astro/` 不进版本库。
  - **agent 可读性（AFDocs 口径）**：官网的读者**包括 agent**（Claude Code / Cursor / Codex 会直接读
    `/docs.html`、`/api.html` 再写 agentia 代码），所以「产物形状」也是被守卫的面：
    `/404.html`（缺它 Cloudflare Pages 会把**任意**未匹配路径回 **200 + 首页 HTML** —— soft 404，
    agent 因此拿不到「这里没有」这个信号，只会把首页当正文解析）、`/robots.txt` + `/sitemap.xml`、
    `llms.txt` 里的**绝对**链接（AFDocs 的 `llms-txt-links-resolve` 只统计 `http(s)://` 开头的链接，
    根相对链接会被整条丢弃 —— ⚠️ 别和「页面发现」混为一谈：发现阶段相对链接**是**能解析的）、
    `llms-full.txt` 与单源 `docs/usage-guide.md` 逐字节相等，以及每页 `<body>` 最前的
    `<div class="llms-hint">`（视觉隐藏只能用 `clip` / `clip-path`，**不能**用 `display:none`
    —— 后者会被解析器剥离，而这条指引正是要能被「HTML→Markdown 的 agent」读到；URL 写**纯文本**
    不套 `<a>`，转换器会丢链接标签）。
    这一整套由 `scripts/check-website-agent-readiness.mjs` 按**产物形状**核，折在 verify-all 第 8 步里。
    线上分数可用 `npx --yes afdocs@0.20.0 check https://agentia-web.pages.dev --format scorecard` 复现。
  - **URL 一律干净形态 + 绝对路径**：站内链接写 `/docs`，**不要**写 `./docs.html` 或 `/docs.html`。
    两个理由都有实测后果：① Cloudflare Pages 对产物里存在的 `x.html` 一律 **308** 跳到 `/x`
    （实测 `/index.html` → `/`、`/docs.html` → `/docs`、`/404.html` → `/404`）—— 所以
    `og:url` / sitemap / llms.txt 里写 `.html` 等于声明**跳转前的地址**，站内写它则每次点击多一跳；
    ② **相对路径在 404 页上是错的** —— 404 页会以**任意**请求路径被送出（`/foo/bar/baz` 也回它），
    浏览器按 `/foo/bar/` 解析 `./docs` ⇒ 又落回 404。favicon 同理（走绝对路径）。
    ⚠️ **别把「产物文件名」当「站点 URL 的真值」**：文件名是构建产物，URL 形态由平台重写规则决定
    —— 这里判反过一次（第一版守卫拿 `readdirSync` 的文件名比对声明，把 `.html` 口径锁成了绿灯）。
  - **每页都有 markdown 变体 + 内容协商（GEO 档 C/D，2026-09-26 落地）**：编码 agent 默认带
    `Accept: text/markdown`，而纯静态托管只认路径 —— 所以两层各自成件：
    ① **构建末尾**跑 `packages/website/scripts/build-md-variants.mjs`（已串进 `npm run build:website`），
       把 `dist/<page>.html` 转出 `dist/<page>.md`（首页落 `index.md` —— 打分器给根路径的候选是
       `/.md` 与 `/index.md`）。转换器**输入是产物**（与打分器同源）、**剥壳集合与打分器一致**、
       **正文一个字不许丢**：打分器的 parity 判定按「HTML 正文片段是否出现在 markdown 里」逐段算，
       缺失 ≥5% 就降级。两条刻意选择写进了脚本注释 —— 表格转「一行一条」而非 GFM 表格（api 页有
       28 个单元格含 `|`，转义成 `\|` 会让 parity 的片段判定整条对不上）；`.md` 首行的 llms 指引
       用**链接**形态（HTML 侧相反：那里必须纯文本，HTML→MD 的转换器会丢锚标签）。
    ② `packages/website/public/_worker.js` → `dist/_worker.js`，Cloudflare Pages **advanced mode**：
       带 `Accept: text/markdown` 的请求改写到 `.md`，其余**原样透传**。⚠️ advanced mode 下**所有**
       请求都过它 ⇒ **兜底必须是总的**（任何异常都退回 `env.ASSETS.fetch(request)`），否则一个转换
       瑕疵能把整站打成 500。平台自带的「Markdown for Agents」用不了（zone 级 + Pro 起，本站
       canonical 是 `agentia-web.pages.dev`，属 Cloudflare 自己的 zone）。
    守卫：`scripts/check-website-agent-readiness.mjs` 的第 ⑩–⑬ 类（`.md` 齐备 / 首行指引 /
    与页面结构对账 / `_worker.js` 在场）；行为由 `tests/docs/website-md-variants.test.ts` 与
    `tests/docs/website-markdown-negotiation.test.ts` **真跑**守住（后者喂假 `env.ASSETS`）。
  - **新增页面时**：`sitemap.xml.ts` 的清单要加、`llms.txt` 的「文档」节要加。守卫会交叉核对 ——
    sitemap 的 `<loc>` 集合必须**等于** dist 里实际的 `*.html` 集合（排除 404）**映射到干净路径后**，
    且每条都出现在 llms.txt 里，两处任缺其一即红。脚本里**刻意不另抄一份页面清单**：
    那样加页面时守卫会跟着一起漏。`.md` 变体**不需要手工登记**（构建末尾从产物自动生成，
    守卫按 dist 的页面集合自动核对）。
  - **`src/fragments/api.html` 是手写的导出速查**（不像 `llms.txt` 从 usage-guide 派生）：新增 / 改名
    导出必须同步补进它 —— `tests/docs/api-page.test.ts` 做反向全覆盖校验，漏写即失败。`docs.html` /
    `index.html` 的正文与统计数字同样要跟着改，它们没有自动校验。
  - **表格版式三条不变量**（`tests/docs/website-css.test.ts` 钉住，改 CSS 前先读它）：
    ① API 页签名列**只能用 `overflow-wrap: break-word`，绝不能用 `anywhere`** —— `anywhere`
       会参与**固有尺寸**计算，把该列 min-content 压成 1 个字，表格最小宽度锁死 ~764px，
       中列无论容器多宽都只分到 55px（长签名竖成一列字，一行表高 1294px）。
    ② 三列都要有 `min-width` 下限，否则容器一窄就牺牲某一列。
    ③ ≤768px 必须卡片化（行变 block、`thead` 隐藏、表格 `min-width:0`）——
       列宽下限只能救「不至于逐字竖排」，救不了「一屏放不下 490px 的首列」。
  - **只验「页面不横向溢出」是不够的**：那次签名列被挤死时页面**没有**横向溢出（表在
    `.table-wrap` 里滚），所以溢出检查全绿而内容已经烂了。要看**列宽与折行数**：
    `td:nth-child(2)` 的宽度、签名代码块的渲染行数，在 360 / 390 / 641 / 768 / 1024 / 1600
    各档都要量。
