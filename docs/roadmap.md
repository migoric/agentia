# Agentia —— Roadmap

状态：v0.10.2 已发布（`@migor/agentia` + `@migor/cli`），R1–R6 已全部落地；本轮完成全量评审修复 + `src/` 目录重构 + 官网响应式 + **官网迁移到 Astro 构建型静态站** + 分层守卫测试 + 官网正式化与动效 + **性能深度审计**（token 估算超线性 / SSE 背压 / `awaitTask` 事件化）+ **工具超时收紧为硬保证** + **真 API 集成验证**（并修掉默认 client 从不转发 `signal`）+ **`.env` 一等配置入口**（`loadEnvFile`，脚手架生成 `.env`）+ **trace 事件正文可展开**（`maxEventChars` 开关 + 两个宿主都真展开）+ **深度审查修复轮**（40+ 处：可观测出口 / 异构环境 / 预算透传子 agent / CLI inspector XSS / 部署 e2e）+ **发布后更正**（Redis 的 TTL 在 node-redis 上静默失效、e2e-deploy 端口 TOCTOU flake）+ **v0.6.1**（超时归一类账 / MCP 超时单源化 / 对外文档面清理）+ **v0.6.2**（第六轮全量 review 收口：16 条「静默失效」修复 / `beforeFlush` 时序缝 / metrics 三维度基数封顶 / traceparent 入站关联）+ **v0.6.3**（守卫注册表 + `exactOptionalPropertyTypes` 迁移 / OpenAI 适配器内层重试对齐） + **v0.7.0**（**MCP 连接器出厂自带**：stdio / StreamableHTTP 只用标准库、不新增第三方依赖；第七轮复审收口；StreamableHTTP 会话过期自愈 + `close()` 保证子进程已终止；官网手写数字守卫）+ **v0.7.1**（**HITL 人工审批**：挂起/恢复、跨进程耐久；gRPC 宿主配方与可跑示例；连续四轮复审收口：11 条「不报错地不干活」/ 预算护栏走廉价 usage / 异步会话正式通道 / 测试基建不再被 `&&` 静默跳过 / MCP `pending` 泄漏与 `close()` 挂死；**类型面破坏性变更**见 CHANGELOG 迁移小节）+ **v0.7.2**（**第九轮评审收口**：HITL × `sessionStore` 组合破口（挂起恢复段历史翻倍 / 成功后毒化会话）+ 六条静默失效修复（惰性审批超时无重入闸 / StreamableHTTP 丢 `abandoned` / Anthropic 流内 4xx 落 500 白重试 / `runTimeoutMs` 落 `unknown` / `FileTaskStore.save` 先写内存 / SSE 稀疏数组）+ `metrics.ts` 与 `mcp.ts` 纯结构拆分 + stdio `pending` 回归补课；**无破坏性变更**）+ **v0.8.0**（**CLI 机器可读面**：`--version` / `report·diff·doctor --json`；**脚手架 discover 生产路径修复**（≤0.7.2 生成的工程 `npm start` 必崩，老工程需按新模板改 `src/main.ts`）；脚手架 pin 住 CLI 进 devDependencies；AsyncRunner / turn / loop / http 纯结构拆分 13 件 + Biome 零告警闸门 + 覆盖率棘轮门禁 + 模板真文件化；**框架 API 无破坏性变更**）+ **v0.8.1**（**出站链路传播**：`currentTraceparent()` 补上跨服务关联的出站方向；id 投影上移 `core/trace.ts` 成单一真源）+ **v0.8.2**（**外部双模型复核逐条复现收口**：9 条真缺陷 —— OTLP enum 整数化（严格 collector 整批拒收，观测全丢却报正常）/ 200 + `partialSuccess` 按失败处理 / 新增 `OtlpExporter` 的 `onExportError` / `metricsSink.reset()` 前移 CUMULATIVE 窗口起点 / `maxRetries` 坏值构造期抛错 / 已中止的 MCP 调用不再发请求也不再永不 settle / 异步 store 下同键并发提交不再重复执行 / 模板漏写 `clean.mjs` 发布前拦下）。另：**v0.9.0**（dev 调试环：常驻 runner + 面板驱动 `src/app.ts`，四个控件全在面板上；装配/启动拆分，迁移见 CHANGELOG）+ **v0.9.1**（面板三处体验修复：右栏在飞期间就长出调用树 / 刚跑完的回复不再被自己擦掉 / 工作目录选择器能选文件）+ **v0.9.2**（面板可读性三处：模型正文按 Markdown 渲染（自写零依赖解析器，按构造不产生 HTML）/ 滚动分层 / 长正文默认折叠）+ **v0.9.3**（原生文件夹选择器（取消判定认错误码 `-128`）+ 模板 `list_files` + CLI 内部结构治理（`dev.ts` 1148→776、`inspector.ts` 818→413））+ **v0.9.4**（成本口径补齐（`cacheRead`/`cacheWrite` + 图片按尺寸上界估）+ 三个「旋钮设成 0 就静默失效」的洞改成构造期响亮失败 + 大载荷不再灌进摘要器 + 评测即发布闸门 + 官网 agent 可读面（每页 `.md` 变体 + `Accept: text/markdown` 内容协商）+ `§7 已知边界` 立守卫；**无破坏性变更**）+ **v0.9.5**（**外部深评 P2 表最后三条收口**：记忆回写可选 CAS（冲突时不写 + 出声）/ 非终态流缓冲配额（回收缓冲、留表项与序号）/ 四类能力注册表（加一类不表态就 `TS2741`）+ 两处判据订正（T4 收缓冲不收表项、K2 的「7 处」实为 5 处）；**无破坏性变更**）+ **v0.10.0**（**对外承诺从「文档上的一句话」改成可执行的断言**（稳定性策略 / 三个不发布的包 / CI 运行环境 / README 数字现算）+ `exports` 收窄 —— **有破坏性变更**：深路径导入会被拒，迁移见 CHANGELOG + `docs/deployment.md` 上线清单 + 官网 `/tradeoffs` 取舍页 + 五个 bench 数字对外 + 推广稿定稿）+ **v0.10.1**（**从「看得见一次 run」到「留得下、比得出」**：dev 面板每次 run 收尾落盘 `.agentia/traces.jsonl`（恰好是 `report` / `diff` / `harvest` / `export` 四个命令的输入）+ 并排比两条 run（含「改一句 prompt 立刻重跑对照」的自动补对）+ `packages/trace-view` 补规模棘轮与三条行为断言 + `§7 已知边界` 补登记两条长跑边界 + `examples/patrol` 纳入 `typecheck:tests` 门禁；**无破坏性变更**，框架代码零改动，新增一处用户可见文件 `traces.jsonl`（只增不减））+ **v0.10.2**（**对外那一面各做实一格 ——「能不能被找到、能不能 5 分钟跑起来」**：脚手架默认入口翻成可上线的 HTTP 服务（`npm start` 直接起服务，一次性挪去 `batch.ts`）+ 官网全站英文版（`/en`，五页逐节对译 + 英文 404 + 语言自动检测与手动切换）+ 两轮**纯结构**重构（方法级体量闸与三处巨型体外移；`#executeInner` 结果记账外移 + 14 条直接单测）+ c8 分支覆盖率棘轮 88 → 89；**无破坏性变更**，框架公共 API 与 `exports` 逐字未变（本版唯一碰 `src/index.ts` 的是版本常量那一行），脚手架是**生成物** ⇒ 既有使用者不需要任何动作）。本文档记录规划与落地状态，后续方向见文末「R7」。原文如下（各 R 标题后的 ✅ 为对应版本落地标记）。
与 `docs/spec.md`（已锁定决策）互补：spec 记录"已经怎么定的"，本文记录"接下来往哪走"。

## R1 —— 中间件（拦截器链）✅

**中间件是下一个大块的框架能力**（拦截链落在装配层，spec §9.2）。

- **能力调用拦截器链**：`createApp({ middleware: [(call, next) => …] })`，在每次能力（tool/skill/subagent/prompt）
  调用前后执行。~~框架自带的 trace 记账从 engine 硬编码改写成第一个内置拦截器~~ —— 该 dogfooding
  设想经评审**放弃**（capability span 生命周期与模型调用纠缠在 loop 内，强行外置反而割裂）：
  trace 记账**有意留在 engine 层**，中间件只承担能力调用层的拦截（见 spec §10 2026-09-11 R1 条；
  是否二次评估列为 R7 候选）。
- 用户场景：鉴权（按 blackboard 拒绝调用）、限流（按能力计数）、结果缓存
  （幂等工具直接短路）、调用日志/审计、超时包装。
- 设计约束：链式 `next()` 语义；顺序 = 注册顺序；拦截器只见 `ToolRunContext` +
  能力描述，不碰 engine 内部；异步安全（ALS 上下文天然透传）。

## R2 —— 结构化结果 + 类型打通 ✅

- **typed 结果一等化**（spec §6.2 欠账）：run 收尾产出符合 schema 的结构化结果
  （engine 内部追加隐藏 `submit_result` 工具，见 spec §10 R2），`result.typed<T>()` 取代纯文本猜解析。
- **schema ↔ TS 类型打通**：可选 zod 接入（`@Tool({ schema: z.object(...) })`，
  从 zod 推导 JSON Schema + 入参类型），裸 JSON Schema 写法保留；不改现有 API。

## R3 —— 宿主与传输 ✅

- **HTTP 宿主**：`createHttpHandler(app)` 一行接入任意 Node HTTP 框架（同步 RPC + 异步任务
  端点契约固化，与 AsyncRunner/FileTaskStore 语义一致）。
- **队列宿主**：TaskStore 的 Redis/SQLite 参考实现，验证"换宿主不换语义"跨进程成立
  （顺带解掉 FileTaskStore 单写者限制）。
- **OTLP 导出**：trace 接 OpenTelemetry 收集器（spec §9.3 生产方向）。

## R4 —— 多模型 + 记忆 ✅

- **provider 抽象**：engine 目前绑死 Anthropic SDK 的 stream 形态，抽一层
  `ModelClient`（stream/finalMessage 结构面，定义在 core，Anthropic SDK 天然满足），
  先适配 OpenAI 兼容端点（`createOpenAIClient`）；换 provider 靠**注入 client**，
  `AGENTIA_MODEL` 仍只管模型名（不做 `provider:model` 路由）。
- **跨 run 记忆**：blackboard 是 run 级；加可选的 `MemoryStore`（按 session/租户键控），
  run 启动时水合、结束时回写——明确"记忆是次级问题"的边界，只做键值与检索两个钩子。

## R5 —— 生态与体验 ✅

- **CLI**：`agentia dev`（watch + 热重装配）、`agentia add <pkg>`（第三方能力包安装
  并登记）、`agentia doctor`（装配体检：未登记 / 悬空能力 / 命名规范 / 重复条目）。
- **模块系统**：`defineModule` 能力包（能力 + providers + 拦截器打包分发），
  spec §4 草图的正式落地；property-injection 便利写法（spec §11 待定项）。
- **官网**：文档站（指南 + API 参考），从单页宣传站演进。

## R6（v0.2.0 已落地 ✅）

- 子 agent typed 结果（runAgentScoped 透传 resultSchema，子 agent 交回 `{ report, result }`）；
- RedisTaskStore（duck-typed RedisLike 客户端，TaskStore 接口放宽为 MaybePromise）；
- trace 重放基底（traceToMessages，spec §9.4 落地）；
- 文档站演进：docs.html + api.html（API 参考）；
- 真实 LLM playground：BYOK 模式（key 只存 localStorage，浏览器直连 Anthropic）。

## 评审修复轮（v0.2.2）

对 v0.2.1 做了一轮全量评审（三个子系统深读 + 官网审计 + 耦合图），结论：**主干质量高，问题全集中在佐助路径**——
落库失败会杀进程、记忆回写失败会毁掉成功的 run、子 agent 绕过鉴权、trace 重放在缺省模型上是 400。

- **`src/` 目录重构**：`run/` 按职责拆为 `runtime/` + `transport/` + `store/` + `integrations/`，
  `engine/context.ts` → `engine/trimming.ts`；`src/index.ts` 导出面逐字不变，与 §11 的包拆分方向对齐；
- **发布阻塞 7 条**：AsyncRunner 落库/槽位容错、`readBody` 限流与中断兜底、`traceToMessages` 末条补 user、
  `@Skill`/`@Prompt` override 动态查表、成功路径 memory 回写不翻 run 状态、OpenAI 兼容端点 `stop`+`tool_calls`；
- **新增公开选项**：HTTP 并发闸门（默认 32）+ body 上限 + `exposeErrors`、AsyncRunner 超时与
  `resumePending` 认领过滤（`ownerId`）、Redis TTL、Scheduler `maxInFlight`；
- **官网全面响应式**：窄机断点（≤420px）+ 汉堡导航，20 组「页面×宽度」零横向溢出；
- 许可证补齐 MIT；测试 142 → 182 例。

### 第二轮回评（并入 v0.2.2）

第一轮修的缝里还有漏的，且新增一处安全缺陷：**子 agent 内部工具调用整体绕过中间件**（`tools` 引用解析的是中间件包装前的菜单）；
另有「同一函数内一防一漏」（`AsyncRunner` 订阅了 `save` 的 rejection 却丢弃 `byIdempotency` 的）、
异步落库迟到 reject 把成功 run 覆写成 failed、`submit_result` 校验未包 try（畸形 schema 掀翻整次 run）、
水合失败杀死 run（回写却有防护）、`totalUsage` 对 capability 聚合用量双算的口径矛盾、SQLite 只有 WAL 没有 busy_timeout、
`every(0)` 空转、Redis prefix 未转义 glob、`keepRecent` 在编辑与压缩间单位混用、`trimToolPairs` 对畸形历史切出孤立块、
容器重注册不传递失效、`discover` 覆盖显式 provider、OpenAI 空 `choices` 静默记成成功。全部修复，各带回归用例（190 → 210 例）。

- **安全**：嵌套能力 `tools` 引用改从中间件包装后的菜单解析（关闭 spec 记档的既知缺陷）；
- **正确性**：`submit_result` 校验入 try、水合失败不杀 run、迟到 reject 不覆写终态、空 `choices` 抛错；
- **契约**：`Trace.totalUsage` 只累加 `llm.turn`；`createBudgetPolicy.keepToolPairs` 与 `keepRecent` 解耦；
  `discover` 与显式 providers 同 token 时显式优先；`Container.register` 传递失效；`Scheduler.every` 拒绝非正有限数；
- **资源**：`FileTaskStore.compact()`、`InMemoryTaskStore({ maxRecords })`、`SqliteTaskStore` 补 `busy_timeout`；
- **文档**：删掉与代码不符的承诺（roadmap R1「静态校验补全」、spec §7 未实现的检查清单、CLI doctor 的 canCall 环、
  `ToolSpec.strict` 的合规要求、`AgentApp.container` 的「生命周期回调」）。

### DX 与 AI 可编码性（并入 v0.2.2）

起因是一个真问题：**用框架时编辑器给不给级联提示**。实测（用类型系统把解析结果打进诊断）结论是
「框架 API 的补全没问题，但**你自定义的东西**没有类型链路」—— 黑板键是裸 `string`、`result.typed` 是 `unknown`、
schema 与方法签名双写且默认互不校验。这三点既是人「记不住 API」的原因，也是 AI 猜错 API 的根源。

- **类型链路**（详见 spec §10）：`Blackboard` 声明合并给黑板键补全 + 拼写检查；`fromZod<T>` 让 schema 成为单一事实
  来源并**校验方法签名**；`resultSchema` 自动推导 `typed`。三条都是**可选开启**，不声明则与旧行为逐字一致。
- **顺带修**：`FactoryProvider.useFactory` 的形参逆变 bug（`unknown[]` → `never[]`）—— 旧写法连框架自带测试里
  那种正常工厂都编译不过；`app.run` 补上 `resultSchema`（此前根本传不了结构化结果 schema）。
- **AI 可编码性**：`docs/usage-guide.md` 作为**使用者向唯一说明**，三处消费 —— CLI 脚手架写进新项目的 `AGENTS.md`
  （Claude Code / Cursor / Copilot 会自动读）、官网 `/llms-full.txt` 与 `/llms.txt`、人类速查。
- **验证基建**：`tests/docs/usage-guide.test.ts` 把说明里的表格**逐项对源码核**（改名即失败，防「文档承诺了、代码没有」）；
  新增 `typecheck:tests`（此前**测试目录从未被类型检查**，首跑 50 个错误已全修）与 `typecheck:types`
  （`@ts-expect-error` 断言「应当报错」的场景真报错，针对构建产物 dist 编译）。测试 210 → 215 例。

## Dev Inspector（本地调试面板）✅ 已落地

`agentia dev` 内置本地 inspector：左栏 run 列表 + 右栏调用树，展示每个能力（tool/skill/prompt/subagent）
的入参 / 出参 / 耗时 / token / cache / 错误状态（环形缓冲最近 50 条）。

- **框架**：trace 出口缝 `TraceSink` + `AppOptions.sinks` + `registerDefaultTraceSink()`（构造期快照合并）；
  run 成功 / 失败两条路径均投递，sink 抛错吞掉不影响 run。`createOtlpExporter()` 返回值天然满足该接口。
- **共享渲染器** `@migor/trace-view`（零依赖 ESM）：`createTraceView` + `playTrace(真实 Trace)`；
  官网 playground 与 CLI 面板共用同一份 —— **官网自此不再维护第二套渲染**（原 680 行的 playground.js
  收敛到 517 行）。
- **dev 注入**：CLI 侧 `NODE_OPTIONS=--import` preload，从用户项目解析框架并注册 sink；
  **框架不读 env、不含 dev 逻辑**。
- 四项测试基线与验证：框架 190 + trace-view 6 + CLI 3 例；真浏览器实测（本地面板 + 线上 playground）。
- 计划见 `docs/plans/2026-09-11-dev-inspector.md`。

## Agent 服务能力补全（四期）✅ 全部落地

设计见 `docs/plans/2026-09-11-agent-service-hardening.md`（四期 8 个分叉全部按建议 A 拍板）。

- **Phase A（稳定性）** ✅ 取消传播（`AbortSignal` 贯穿到模型请求）/ 重试退避（缺省开启）/ SSE 流式下发。
- **Phase B（宿主硬化）** ✅ 鉴权缝（拦在入口、读 body 之前）/ 优雅停机 `drain()` / `GET /healthz`。
- **Phase C（能力成色）** ✅ 成本硬管控 / 工具超时 + 并发闸门 / OpenAI 真流式 + 多模态 / 会话持久化 / 完成回调。
- **Phase D（生态）** ✅ MCP 桥（duck-typed，框架零依赖；接入点是 `AppOptions.tools` 裸工具缝）/
  evals（`scriptedClient` + `defineEval`）/ 指标（`metricsSink`，天然满足 `TraceSink`，零新出口）/
  提示词版本化 + 多租户配额范式（组合既有缝，不做子系统）。
  真端到端证明 = `npm run e2e:mcp`：真接第三方 MCP server（`uvx mcp-server-time`）走完「映射 → 菜单 → run」，
  无网机器自动回落 `scripts/mcp-fixture-server.py`。

## 可观测 · 可调优（E / F / G 三期）✅ 全部落地（2026-09-13）

设计见 `docs/plans/2026-09-13-observability-tunability.md`（8 个设计分叉全部按建议 A 拍板，落地时的四处修正见 spec §10）。
起因：观测当时只到 **run 级**，答不出「哪个能力慢/贵/爱失败」；调优旋钮虽齐，却有**两处「看着有、实际不生效」**。

- **E 观测下沉** ✅ E1 工具级时序（`tool.output` 事件补 `durationMs` / `errorKind`，普通工具仍不建 span）/
  E2 能力级指标（per-capability 调用数、失败数、耗时、token、成本；`labelMode` + `maxCapabilities` 防标签爆炸）/
  E3 模型级指标（按模型归因；`model_unpriced_turns_total` 显式暴露"成本算不出来"）/
  E4 Prometheus 原生 histogram（可跨实例聚合）+ 窗口精确分位并存 / E5 OTLP metrics 导出（零依赖手写 JSON，`flush()` / `intervalMs`）。
- **F 成本可调优** ✅ F1 价格表可注入（`priceOverrides` + `buildPricing`，**透传进子循环**）/
  F2 未定价模型显式（`usage.unpriced` 事件 + `onUnpricedModel` 回调 + 指标，**不改变 run 结局**）/ F3 成本归因。
- **G 调优闭环** ✅ G1 `buildRunReport` / `mergeRunReports` / `renderRunReport` + CLI `agentia report <trace.jsonl>` /
  G2 `@migor/trace-view` 能力排行（`summarizeTrace` / `renderSummary`）接进 `agentia dev` 面板 /
  G3 run 根 `config.*` 生效配置快照 / G4 `createHttpHandler({ metrics })` 内建 `GET /metrics`。
- **顺带修的 doc-vs-code 漂移**：`core/trace.ts` 声明已久的「`capability.usage` = 子孙 `llm.turn` 聚合」此前**从未写入** ——
  已在 `TraceRecorder.end()` 补上，能力级 token/成本才有数据来源。
- 测试：框架 414 → 462，CLI 6 → 13，trace-view 6 → 10。

## 目录约定去伞形词（四类分置）✅ 落地（2026-09-13）

设计见 `docs/plans/2026-09-13-typed-unit-dirs.md`（6 个分叉：F1=A · F4=B · 其余 A · F6=A+B）。决策记录见 spec §10。
起因：`agentia create` 产出的 `units/` 被指出「命名不太好」—— 核实后发现仓库里**同时跑着两套目录约定**且无验证覆盖，
外加脚手架 tsconfig **漏 include 能力目录**（未登记的能力静默不参与类型检查）。

- **① 四分类目录，放 `src/` 下** ✅ `src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/` —— 目录名就是类型
  （对齐 MCP / OpenAI Agents SDK / LangChain 的惯例：不用伞形词）；注册表改 `src/registry.ts`。副作用是三处漂移一次自愈：
  示例的 `rootDir:"src"` 不用动、脚手架 `include` 收缩为 `['src']`、示例与新约定自动一致。`create` 建出四目录（`.gitkeep`）。
- **② `discover` 放宽为 `string | string[]`** ✅ 数组顺序即装配顺序；任一路径不存在报错；跨目录重名 token 发现期告警 +
  `g` 生成期拦截 + `doctor` 报错兜底。
- **③ 伞形术语整体替换为 `capability`** ✅ 类型 / 字段 / 指标名 / `unit=` 标签 / **trace span kind** / trace-view 前缀；
  中文「单元」改称「能力」（与既有「能力包」同族）。运行时零破坏，刻意破坏的只有观测面命名（已逐条列进 spec §10）。
- 测试：框架 462 → **468**（+6：`discover` 数组 / 跨目录重名 3 条 + 术语守卫 `no-legacy-terms` 3 条），
  CLI 13 → **20**（+7：跨目录同名体检 + 目录约定守卫 + 老布局迁移提示），trace-view 10（仅改名，无新增）。

## 示例真跑纳入门禁 ✅ 落地（2026-09-14）

起因：`examples/complete` 被 usage-guide 与项目 README 指着说「完整可跑写法见这里」，但它此前只被
`typecheck:tests` 覆盖 —— **全仓没有一条脚本执行过它**（`examples/` 下 0 个测试）。

- **`scripts/e2e-examples.ts`** ✅ 并入 `npm run e2e`（第二步），另有 `npm run e2e:examples` 单跑。
  按示例**自己的构建脚本**真构建 → `node dist/main.js` 真起服务 → 按它 README 逐条打端点：
  `/healthz` · 无凭据 401（鉴权缝）· 同步 `/run` · SSE 流式 · 异步 `/tasks` + 幂等键去重 + 轮询终态 ·
  `/metrics`（含能力级非零样本）· SIGTERM 优雅停机（断言 exit 0 + 排空日志）。
- **不联网、不需要 key**：模型侧是脚本内置的假 OpenAI 兼容端点（真 SSE；`tool_calls` 的 `arguments`
  **拆两片**下发，顺带把框架的分片累积逻辑放进真实链路跑一遍）。
- **断言的关键不在响应文本**：假端点必须**真的收到 `echo: ping` 这条 tool_result** —— 证明四类能力
  （`echo` / `house_style` / `outline_writer` / `researcher`）真装配进菜单且能力真被执行过。
- 顺带修掉两个会骗人的坑（详见 spec §10）：`tsx` 起进程时 SIGTERM 打在包装进程上（应用收不到）→ 改跑 dist；
  本地 `file:../..` 被 npm 装成**快照拷贝** → 示例跑的是安装那天的框架，脚本改为指向仓库根的链接。

## R7（下一轮）

> 状态（2026-09-17）：质量闭环 / trace diff 与分叉重放 / canCall 能力级能力边 / 文档站内容扩充 /
> 默认 client 自研化 + 公共类型自有化**均已落地**（各条内标 ✅ 或删除线 + 落地日期），
> 仍为候选的只剩：中间件二次评估、~~HITL 跨进程挂起~~（✅ 2026-09-19 落地）、Workers 代理版 playground。
>
> **2026-09-21 补记**：**出站链路传播**（`currentTraceparent()`，spec §9.2 那条「仍开放」的项）
> 已落地 —— 它是弱方向审计点出的「唯一语义已定、只差实现」的开放项；决策与被否方案见
> spec §10 2026-09-21 ③，设计文档 `docs/plans/2026-09-21-outbound-trace-propagation.md`。
> 同轮「增量 trace 出口」（支撑 `GET /tasks/:id/stream`）判定为**内核级**、另立项，未顺手做。

- trace 改写为内置中间件的二次评估（v0.1.0 评审放弃的理由见 spec §10）；
- ~~**HITL 跨进程挂起 / 续跑**（`awaiting_approval` 状态机 + 循环位置落库）~~ **✅ 已落地
  （2026-09-19，决策见 spec §10 当日条）**：关键解锁是「审批 = 异步 tool_result」—— 不落
  「循环位置」、落**消息历史**（assistant 结尾的未决 tool_use 即断点），恢复 = 引擎见到这种
  输入先解决这些 tool_use 再调模型；`@Tool({ approval: 'required' })` + `AsyncRunner.approve` /
  `POST /tasks/:id/approve`，回合级全有或全无、决定随任务落库、惰性超时兜底；
  ⚠️ **状态值 2026-09-28 改名**：`awaiting_approval` → **`suspended` + `suspendedReason`**
  （本条正文保留当年的写法；映射与理由见 spec §10 2026-09-28 ①）；
- ~~**默认 client 自研化 + 公共类型自有化**（让 `@anthropic-ai/sdk` 真正可选）~~ **✅ 已落地
  （2026-09-17，两个 PR：#42 自研 client + 本条类型自有化）** —— 前者 = 用 fetch 重实现
  Anthropic Messages（SSE / `cache_control` 缓存断点 / `tool_use` / `strict` / thinking），
  后者 = `src/core/message.ts` 自有消息类型族（`MessageParam` / `Message` / 块联合 + 兜底成员，
  与 SDK 结构兼容、双向门禁在 `tests/types/message-compat.types.ts`），SDK 退入 devDependencies
  只做兼容门禁，**运行时零依赖达成**（决策见 spec §10 当日条）。
- Workers 代理版 playground（免 BYOK 的托管演示）；
- ~~文档站内容扩充（指南按场景组织）~~ **已落地（2026-09-16）**：docs 页新增「场景指南」区
  （`packages/website/src/fragments/docs.html` 的 `#scenarios`，快速开始之后）——上线 HTTP 服务 /
  监控 / 评测回流 / A/B / HITL 五张场景卡，CLI 表补 `agentia diff`，观测区补评分指标与 `gen_ai.*` 对齐；
- ~~canCall 能力级能力边~~ **已落地（2026-09-16，决策见 spec §10 当日条）**：`tools` 元素
  在 provider token 之外新增 `'<token>/<能力名>'` 路径语法（只引单个能力，装配期校验 +
  可用名单报错，解析走中间件包装后的菜单）。
- **质量闭环（score / 回流 / 标准对齐）✅ 主体已落地（2026-09-16，决策见 spec §10 当日条）**：
  对照 Langfuse / LangSmith / OTel GenAI 后的取舍不变（框架内建 trace + 零后端导出，不学它们建看板/CMS）。
  **已落地**：
  - **score 一等公民**：`Score` + `attachScore`（run 根 `score` 事件，公共导出）；
    `defineEval` 结论自动落 score（`{ name:'eval', value:0/1, source: eval 名, comment: 失败原因 }`）；
    metricsSink 聚合出 `agentia_score` / `agentia_score_total` 指标族 —— eval → trace → 监控一次打通；
  - **OTLP 属性对齐 OTel GenAI semconv v1.37**（additive 保留旧 `usage.*` 键；映射集中
    `integrations/otlp.ts` 单模块并钉住基准版本；score 译为 `gen_ai.evaluation.result`）；
  - **sessionId 提升为 trace 根属性**（`session.id`，OTLP 映射 `gen_ai.conversation.id`，thread 维度）；
  - **prompt 版本进 trace**：`PromptSpec.version` → run 根 `prompts.versions`（对照 `system.version`）；
  - **线上 trace 回流 eval 数据集**：`agentia harvest <file.jsonl> [--failed] [--limit N] [--out]`
    （框架侧 `harvestEvalCase` 刻意 module 级不进公共面；CLI 为去类型移植副本，逐字对拍守护）；
  - **在线评估采样**：以 recipe 形态落地（usage-guide §6，sampleSink + LLM-judge + attachScore
    + metricsSink 拼装）—— 是配方不是框架功能；
  - **Grafana dashboard JSON 随仓库发布**：`examples/observability/grafana-dashboard.json`，
    对着 metricsSink 指标族（导入方式见其 README「Grafana 看板」）。
  **trace diff / 分叉重放 ✅ 已落地（2026-09-16，决策见 spec §10 当日条）**：
  - **trace diff**：`diffTraces(a, b)`（engine，纯函数，公共导出）—— run 级 summary + 逐 span
    字段级差异，支撑 prompt / 模型 A/B；llm.turn 的配对键**忽略 name**（name 是模型 id，
    「换模型重跑」正是 A/B 主用例，按 name 配对会把两侧全报缺失 —— 模型差降格为配对 turn 的
    `name` 字段差），capability 按 `kind:name`；缺省忽略墙钟，绝对时间戳永不比；
  - **分叉重放**：`forkMessages(trace, { atTurn, append? })`（公共导出）—— 锚点是**主循环回合**
    （直属 run 根的 llm.turn，与 harvest 同口径），截断后拼新消息喂回 `app.run`；
    与 replay 同源有损（trace 不记 assistant 文本 / 原始输入 / blackboard），是「新 run」不是续跑；
  - **CLI `agentia diff`**（与上面同批落地）：trace.jsonl 直比（输入形态同 `agentia report`），
    打印 run 级 summary + 逐 span 差异，差异非空 exit 1；框架 `diffTraces` 的去类型移植副本 +
    逐字对拍守护（同 harvest 模式，改算法必须两边同步）。图形 diff / UI 不做（对照 R7 调研结论：
    不建看板，给数据与 CLI）。
  ~~HITL 耐用审批门由上面既有候选（`awaiting_approval` 状态机）覆盖，不重复列。~~
  ⇒ 该候选已于 2026-09-19 落地（见上）。
- **维护：CI 抖动 —— 已定位并修掉（`toolTiming` 的「工具超时」，见 spec §10 2026-09-14）**。
  v0.2.2 窗口内 main 曾红一次（PR #8 那棵树），同树**重跑即绿** ⇒ 抖动而非回归。
  具体用例当时**无法定位**：`verify-all.sh` 把步骤输出捕获后只 `tail -30`，恰好冲掉 node:test 的 `✖ <名字>` 标记行，
  CI 上只剩一个 exit 1。已修诊断可达性（PR #9：失败分支先 grep 标记行再补尾部上下文）——**这次就是靠它一眼定位的**。
  **本轮结论**：真凶是 `tests/engine/toolTiming.test.ts` 的「工具超时」用例（原形态靠「60ms 工具 vs 20ms 超时」
  的计时器赛跑定输赢，只有 3 倍余量）：8 倍 CPU 超订下单文件 **29 次挂 1 次**，PR #19 的 CI 也红了同一条。
  已改成确定性形态（工具挂在只由测试释放的闸门上，断言前不可能 settle）。
  原记的三个嫌疑里 `sqliteStore` 抢锁与 `transport` drain 经核查确实不成立。
- **已做：`withTimeout` 收紧为硬保证**（同一条用例暴露的引擎级问题，见 spec §10 2026-09-14 ②）。
  判定改为**只看实测耗时**：工具 settle 之后若 `settledAt - startedAt >= timeoutMs`，即便竞速把工具的
  返回值交回来了也记 `TIMED_OUT`。**确定性复现**（不靠调度运气）：工具在自己的回调里 `resolve` 之后
  同步阻塞越过截止 ⇒ 旧实现返回 `'late'`（`ok: true`）、硬化后返回 `TIMED_OUT`。
  代价是**语义收紧**（「21ms 完成 / 20ms 预算」由成功变超时），既有用例一条没改。
  门禁：`concurrency.test.ts` 直测 5 条 + `toolTiming.test.ts` 引擎级 1 条；
  **承重性已反向验证**（回退实现 ⇒ 恰好这 2 条挂）。
- **已做：真 API 集成验证（`npm run e2e:live`）+ 修掉它挖出的 signal bug**（spec §10 2026-09-14 ③）。
  新增 `scripts/e2e-live.ts`：拿真实端点跑框架主路径六个步骤（SSE 分片 / `tool_use` / `tool_result` 回灌 /
  `cache_control` / signal 中止 / `runAgent` 全链）。**不进 verify-all、不进 CI**（会花 token），
  无凭据时跳过并打横幅。走 `ANTHROPIC_BASE_URL`，用 DeepSeek 的 Anthropic 兼容端点即可，
  **不需要 Anthropic key**。
  **第一轮就红在 step ⑤**：在飞请求 `abort()` 后仍跑完（599 个分片 / 7.6s）。根因是
  `ModelClient` 契约把 `signal` 放在 **params 内部**，而默认实现 `createAnthropicClient` 只是
  `return new Anthropic(...)` ⇒ signal 进 body、被 SDK **静默丢弃**（SDK 只认 `RequestOptions`）。
  最小对照：body 内 **599 分片跑完** vs options 里 **2 分片 / 1ms 断**。
  影响面：`transport/async.ts` 承诺 `runTimeoutMs` 到点「真中止、token 不再继续烧」——
  旧实现下**继续烧**。已修（`splitSignal()` 把 signal 搬到 options），
  门禁是 `tests/integrations/anthropic.test.ts` 的**本地假端点**（零 key 零外网，CI 可跑），
  承重性同样反向验证过。
- **已发布 v0.2.2**（2026-09-14）：`@migor/agentia` + `@migor/cli` 同步发到 npm，
  `AGENTIA_VERSION` 同步为 `'0.2.2'`（`check-release.mjs` 四处一致）。
  **决策：`examples/` 的 `file:../..` 保持不变**（不去追 npm 版本）—— 示例与 `e2e-examples`
  要验的是**工作区里刚构建的那份框架**，换成 `^0.2.2` 会让「改框架 → 必须发版 → 才能验它」，
  把最该守住的一条链变成发布依赖。几条 README 里「因为没发布所以用 file:」的旧叙事已改写为
  「刻意跑工作区代码」，并保留「想用发布版就换 `^0.2.2`」的一句话。
  另：`packages/trace-view` 的 `private: true` 是**有意**的（产物随 CLI `create` 拷进用户项目，
  不进 npm），不是待修项。
- **已发布 v0.4.2**（2026-09-15）：**发布后更正版** —— 0.4.1 发出后查到一处会让使用者
  静默丢数据的缺陷并修掉。`RedisTaskStore` 的 TTL 此前在 **node-redis** 上**完全不生效**
  （0.4.1 把 TTL 挪到 `SET` 的位置参数上，而 node-redis 的 `SET` 只声明三个形参、多出的
  参数被 JS 静默丢弃）—— 键永不过期、`list()` 无界增长，且没有任何报错。现在 `set` 只传两参、
  TTL 一律走 `expire(key, seconds)`（两家客户端同名同形），设了 `ttlSeconds` 却没给 `expire`
  时**构造期抛错**。同轮修掉本轮跑全链时撞上的 `e2e-deploy` 端口 TOCTOU flake
  （`EADDRINUSE` 曾被报成「示例进程启动即退出」）。证据与决策见 `spec.md` §10 的
  2026-09-15（发布后更正）记录。
- **已发布 v0.4.1**（2026-09-15）：**深度审查修复版** —— 40+ 处，**无新公开 API**，修的是既有
  承诺没兑现的地方。要点：`metricsSink` 的 Prometheus 文本每个家族只发一次 HELP/TYPE（重复即整次
  scrape 硬失败）；预算护栏（`maxTotalTokens` / `maxCostUsd`）经 `ToolRunContext` 真透传到子
  agent / skill 循环；CLI inspector 的 SSE 路径 `innerHTML` → `textContent`（XSS）并加 Host 头校验；
  `drain` 强制关 SSE 现在真 abort 对应 run；示例 Dockerfile 补 `COPY docs`（此前构建必失败）、
  新增 `scripts/e2e-deploy.ts`（崩溃续跑）。决策与假绿记录见 `spec.md` §10 的 2026-09-15 记录。
- **已发布 v0.4.0**（2026-09-14）：trace 事件行可**展开看完整正文**。补上框架侧缺失的
  `maxEventChars` opt-in 开关（缺省截断值逐字不变，`false` = 不截断），渲染器加展开态
  （caret 常显且满不透明度达 3:1、正文默认与标签同一行、窄面板放不下才整段换行），
  并修掉官网 playground 的「假展开」（第二个宿主此前只喂 `fmtArg` 摘要）。
  实测与决策见 `spec.md` §10 的两条 2026-09-14 记录。
- **已发布 v0.3.0**（2026-09-14）：`.env` 成为一等配置入口 —— 框架不**自动**读，改为显式
  `loadEnvFile()`（脚手架 `app.ts` 调用；2026-09-22 从 `main.ts` 挪过来，理由见 `spec.md` §10 ③），
  零依赖手写解析，真实环境变量优先。
  决策与假绿记录见 `spec.md` §10 ⑤；`examples/` 的 `file:../..` 决策不变（同上）。
- **已修：截止计时器不得 `unref()`**（发布 PR 的 CI 红法逼出来的，见 spec §10 2026-09-14 ④）。
  CI 红得没有断言失败：`# fail 0 / # cancelled 4`，runner 自陈 `cancelledByParent` +
  `Promise resolution is still pending but the event loop has already resolved`。
  根因：`toolTimeoutMs` 的截止计时器 `unref` 过 —— 它的**触发就是「那个 await 得以结束」的条件**，
  作为唯一把手时进程先退出，调用方什么都拿不到。判定实验：unref → 进程退出（exit 13）；
  不 unref → `TIMED_OUT`（Node 22/26 一个样，与版本无关）。
  四处「等待的终点」全部去掉 unref（工具级超时 / MCP 调用超时 / 停机 `drain` / `runTimeoutMs`）；
  scheduler 下一拍、SSE 心跳、metrics 刷盘三处 unref **保留**（没人 await 它们）。
  门禁 `tests/timeoutLiveness.test.ts`：**干净子进程**+空事件循环验三个往返（承重性反向验证 3/3 红）；
  `runTimeoutMs` 那处如实标为未覆盖（`awaitTask` 的兜底轮询掩盖了活性差异）。
  顺带把 verify-all 的失败抽取补上 cancel 类标记行（原因行此前一条都没抓）。

## R8（演化候选，2026-09-27 立项）

> 来源：同日三视角分析（业界成熟产品对照 / AI 演化方向 / 产品化路径），用户授权逐项实施。
> **设计稿与逐项验收口径在 `docs/plans/2026-09-27-evolution-r8.md`**（单一真源，含定位筛子
> 与实施纪律），这里只登记清单与状态。

- P1 trace 脱敏 —— ✅ 已落地（2026-09-27）：配方 2.4 升级（内置预设缺省全开 +
  带类别标签的替换文案），**src/ 零改动**（不内建是已锁定决策，spec §9.3 / §10 2026-09-14 ⑥）
- P2 模型 fallback —— ✅ 已落地（2026-09-27）：引擎级 fallback 链，每环独立 llm.turn
  （成本归因正确）+ `llm.fallback` 事件 + run 入口校验；决策见 spec §10 2026-09-27 ③
- P3 trace → SFT 导出 —— ✅ 全部落地（2026-09-27）：P3a `traceContent: 'full'`（spec §10
  当日 ④）+ P3b `agentia export`（trace → 训练数据 JSONL，spec §10 当日 ⑤）
- P4 租户归因 labels —— ✅ 已落地（2026-09-27）：run 根 `labels.*` 属性（三层同语义）
  + metrics 侧 `labelKeys` opt-in + `maxLabelValues` 基数上限（limits 真源表登记）；
  决策见 spec §10 2026-09-27 ⑥
- P5 MCP 反向桥（@Tool 集合暴露成 MCP server）—— ✅ 已落地（2026-09-27）：`createMcpServer`
  （stdio / StreamableHTTP，只用标准库；每次 tools/call 一棵 trace 进 sinks）；
  决策见 spec §10 2026-09-27 ⑦
- P6 durable 长时程 —— ✅ 调研交付（2026-09-27）：`docs/plans/2026-09-27-durable-execution-research.md`
  （Temporal/Restate/DBOS 对照 + 差距清单 G1-G5 + 最小语义增量候选四条；**不写实现**，
  动代码前回 spec §10 立项）
  - **候选 1（`wakeAt` 时间挂起）+ 配套 5/6 —— ✅ 已落地（2026-09-28 ②）**：工具侧
    `ctx.deferUntil(at)` 请求延后、到点唤醒并重跑那一批、`drain()` 后不唤醒、
    `/healthz` 的 `suspended` 读数（按原因分组 + 最早到期时刻）。决策与门禁见
    spec §10 2026-09-28 ②；设计稿 `docs/plans/2026-09-27-durable-wake-at.md`。
  - **候选 2（事件唤醒）/ 候选 3（取消 API）/ 候选 7②（到期索引）—— 仍未做**：
    前两条各有独立立项前提（事件入口 / 公共面与中止语义），候选 7② 的触发条件见调研
    §6 与设计稿 §6（`#redispatch` 目前仍是 O(全表)，挂起量上量后再做 store 侧 `listDue`）。
- 缓：A2A 协议适配（协议漂移中）；拒：后端看板 / DAG 编辑器 / swarm 编排（定位）

## 原则（约束所有 R）

1. 运行时核心（core/engine/run）语义稳定，新能力走 toolkit/新层接入；
2. 每块能力落地必带：单测 + e2e + spec 决策记录更新；
3. 不引入重依赖——可选能力（zod、OTLP、队列）全部 peer/可选接入。
