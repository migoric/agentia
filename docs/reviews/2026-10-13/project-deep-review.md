# 整体项目深度评审（2026-10-13）

> 基准：main @ `09cb225`（v0.10.2 发布后，#243/#244/#245 已合）。工作区干净，无在制品。
> 方法：五路并行深读（引擎内核 / 运行时与宿主 / 装配与集成 / 守卫体系 / agent 面向的面），
> 全部结论带 `文件:行号`；量化快照：src 111 个 ts / 23,153 行，测试 170 个文件，近 30 提交全绿。

## 总评

**工程质量在全仓维度属上游，且「防静默」的主基调执行得罕见地彻底**：纯判定件抽出、
单源化、表驱动穷尽、守卫自带防真空护栏、注释即事故记录——这些不是口号，五路评审各自独立
验证了这一点。残余风险有一个清晰的共同形状：**正常路径密不透风，非正常路径（坏配置、
并发竞态、落库失败窗口、装配期静默吞）的守卫还没跟上自己的 invariant**。

「agent 的情况」两面都健康：对 coding agent 的友好度（AGENTS.md 抽查十余处硬事实几乎全部
属实、文档单源链、llms.txt、对拍守护）是标杆级；框架自身的 agent 能力模型（四类能力 +
subagent 编排 + trace）自洽完整。最大的慢性问题是 **AGENTS.md 写死数字的腐烂**——而这个
仓库自己最清楚药方（「计数算出来，不写死」）。

---

## 中等问题（12 项，建议分批修）

### A. 引擎内核

**A1. retry 坏值被吞成「用户取消」；RetryOptions 无校验、未进 limits 真源表**
`src/engine/turn.ts:426-431` 裸 `catch { aborted = true }` 假设 sleep 只抛 AbortError，
但 `sleep → interruptibleSleep → assertTimerDelay` 对 NaN / 超上限抛 RangeError，
`backoffDelay` 能把配置坏值算成这种延迟。实测：`retry: { baseDelayMs: NaN }` + 一次 429
→ `stopReason: 'aborted'`，error 是「run 已被取消」——配置错误被误报成用户取消。
同族：`maxAttempts: NaN` 时重试被静默关闭（`retry.ts:70`），而 client 层对坏值是响亮抛错的。
RetryOptions 四个数值旋钮未登记进 `core/limits.ts`、无入口校验、无测试。

**A2. runAgent 入口段抛错时 run 根 span 永不合拢**
`loop.ts:394-398` 之前（menuSignature 的 JSON.stringify、resolveModelChain、validateLabels）
抛错时，run 根已在 `loop.ts:345` 打开但永不 end；`runtime/run.ts:100-109` 的 fail() 只在根
未开时补记。交付给 sink 的 trace：`status='error'` 而根 span 是 ok、无 endedAt、无结构化
error——违反本仓自己「非正常收尾必带结构化 error」的不变量。无测试钉这条路径的 trace 形状。

### B. 运行时与宿主

**B1. cancel 与所有推进路径之间没有互斥闸——「绝不起跑」承诺在异步 store 竞态窗口下不成立**
`async.ts:737-801`。approve 有 inflight 闸、signalTask 串行链、wakeDue 有闸、槽位获得后有
readClaimed 重读——`#cancel` 一个都不共享。两个后果：cancel×approve 并发可致任务照常执行
且 webhook 双发（`#cancelSettled` 只对 queued 分支登记，`async.ts:786`）；cancel(queued)×槽位
释放并发时 readClaimed 读到旧状态照常起跑，打破 `async.ts:711` 的承诺。25 条 cancel 用例
全部串行时序，零并发覆盖。

**B2. `TaskStore.get` 契约（必须返回副本）与 InMemory/File 实现（活引用）直接矛盾**
契约：`src/store/store.ts:101-107`；实现：`store.ts:190-192`、`fsStore.ts:112-114`。
CHANGELOG:190 自述「契约注释两条（不改行为）」——声明写下去了实现没跟上。真实后果：
FileTaskStore save 同步抛错（磁盘满）时变异已进内存 Map ⇒ approve 重试撞 409（
`approval-supervisor.ts:195-216`），任务搁死到重启；signal-supervisor 同款。
守卫空档：`fsStore.test.ts:272-291` 恰好用新记录测不到「改活记录+append 抛错」这一格。

**B3. resume-scanner 认领 save 对同步抛错无防护（同文件 wakeDue 有，这里没有）**
`resume-scanner.ts:210`。FileTaskStore 磁盘失败时 resumePending 同步抛出、活引用记录已被
改成 queued+本进程 ownerId ⇒ 后续扫描按 own-process 跳过 ⇒ 任务搁死到重启。零测试覆盖。

### C. 装配与集成

**C1. `@Tool`/`@SubAgent`/`@Skill` 装饰静态方法 → 能力静默从菜单消失**
`src/toolkit/collect.ts:29-53, 69-76`：`assertMethodTarget` 只拦 private 不拦 static；
`scanDecoratedMethods` 只扫实例原型链（四类里只有 @Prompt 单独扫了构造函数链）。
实证：装饰器正常登记、装配零报错、菜单里就是没有——与私有方法守卫防的是同一类
「能力静默消失」。修法二选一：装饰期拒 static（响亮失败），或收静态。零测试覆盖。

**C2. 子菜单（subagent/skill 的 tools 引用展开结果）没有重名查重**
`src/toolkit/module.ts:434-442`：「菜单统一查重」只跑在主菜单上。两个 provider 各有同名
能力被同一 subagent 整片引用时，装配期全绿，运行时 Anthropic/OpenAI 直接 400
（tool names must be unique）。usage-guide.md:324 的「重名查重」未写明只管主菜单。

### D. 守卫体系

**D1. `e2e:mcp:server` 全仓零自动化执行**
不在 verify-all 8 步、不在 CI 六个 job、不在 ci_only 清单。AGENTS.md 的「动了
engine/mcp-server.ts 就要跑」是纯文字约定；正向桥 e2e:mcp 有独立 CI job，反向桥没有。

**D2. `exactOptionalPropertyTypes` 守卫射程只有根包**
`tsconfig-strictness.test.ts:31-51` 只读根 tsconfig.json；`packages/cli` 的两份 tsconfig
**实际就没开这个开关**——CLI 包里「显式 undefined 覆盖缺省」一类缺陷重新是合法代码。

**D3. 下限 Node 版本只有导入冒烟，无行为覆盖**
engines 承诺 >=18，全量测试只在 Node 24 跑；`check-import-floor.mjs` 只验可导入。
新代码引入 Node 20+ 运行期 API 时，typecheck、全量测试、import-floor 三路全绿。

### E. agent 面向的面

**E1. `summarizeTrace` 嵌套能力重复计数，与框架口径冲突**
`packages/trace-view/src/summary.js:55-64` 对每个 capability span 累加 usage，而框架侧
capability.usage 是子孙 llm.turn 的聚合（`tracer.ts:196-211`），@SubAgent 可套 @Skill
⇒ 同一批 token 在 subagent 行与 skill 行各计一次，tokens/costUsd 列不可加总。与
`src/core/trace.ts:199-211`「不含 capability 聚合，避免重复计数」直接冲突。
CLI report、dev 面板、官网 playground 三处同源同漏。`summary.test.js` 无嵌套夹具。

**E2. inspector 静态资源白名单是手工登记的漂移缝**
`packages/cli/src/inspector-routes.ts:178-188` 硬编码 trace-view 模块文件名；
copy-assets 是整树递归拷贝，trace-view 拆出新文件时拷贝带上、HTTP 404——现有测试只钉
index.js 与 css 两个名字，没有任何门禁能抓住，要等到浏览器白屏。

---

## 低等问题（精选）

- `max_iterations` 出口丢 finalText（`loop.ts:316-325`），其他出口都保留已产出文本，口径不一致。
- 主循环「消息已收、工具未跑」窗口内不查 signal（`loop.ts:254-265`），与续跑入口的拒绝口径不对称。
- `snapshot()` 截断摘要每次调用生成新时间戳（`tracer.ts:390-403`），多次调用与增量流不一致。
- stdio 反向桥 stdout error 监听器只挂不摘（`mcp-server-stdio.ts:57`），多次创建累积监听器。
- MCP 反向桥不暴露 traceLimits/maxEventChars，子 agent 类工具长跑时 trace 体积无闸。
- `#expireAndResumeInner`/`#wakeDueInner` 落库失败在活引用 store 下静默留尸，无 warn。
- submit/poll/`#claims` 返回浅拷贝，嵌套对象与库内活记录共享（`async.ts:554` 等）。
- Scheduler 无 drain 感知，drain 后每 tick console.error 刷屏（`scheduler.ts:234-237`）。
- `mergeRunReports` 不按 traceId 去重（`src/integrations/report.ts:240`），与 CLI 刚修的去重不对齐。
- stdio 连接器握手超时后 pending 条目残留（`mcp-stdio.ts:287-296`）。
- metrics OTLP 导出失败缺省全静默（`metrics-otlp.ts:312-314`），与 traces 侧的 console.warn 不一致。
- `Span.name` 注释是已造成过一次生产 bug 的旧口径（`src/core/trace.ts:184`）。
- examples/deploy 带着模板已修掉的 PORT 空串坑（`examples/deploy/src/main.ts:26`）。
- doctor 的 ENTRY_CANDIDATES 双写无对拍（`doctor.ts:8` vs `discover.ts:26`）。
- usage-guide.md 内部口径打架：「三件套」vs「四个命令」（line 204/823/1097）。
- CI 无 timeout-minutes；biome.jsonc 内容与 wrangler 钉版无守卫；source-size 计数器不识字符串上下文。

## AGENTS.md 漂移清单（文档腐烂，一批修）

1. async.ts「1460 行/664 代码行」→ 实测 1380/627（source-size.test.ts:28 头注表格同样过期）。
2. tool-context.ts「八处条件展开」→ 实测 10 处。
3. loop-result.ts「7 个字段必在场」→ 实为 10（loop-result.ts:11 自述）。
4. 「engine 依赖 integrations 仅为取默认 ModelClient」→ mcp-server.ts 还用 DEFAULT_PROTOCOL_VERSION。
5. 发布面「18 项替换面」→ `release-surface.mjs --list` 实为 19 项。
6. 「验证顺序」行的 `npx biome ci .` 缺 `--error-on-warnings`。
7. 「typecheck:tests + 四份示例」→ 实为 9 份示例 + drill.ts。
8. CLI 命令清单漏 `export`；scripts 地图漏 `e2e:soak:suspend` / `bench:otlp` 等。
9. 官网段未提 `/en` 英文站与两个 i18n 守卫。
10. `packages/cli/src/templates.ts:7` 头注与 biome.jsonc 矛盾（templates 关了 formatter）。

## 优势（五路汇总，各取代表）

- 引擎：不变量做成可执行约束（映射类型必填转发、ERROR_TYPES 闭合联合）；重试/换环护栏
  测试密度高；tracer seq 占号与截断簿记两缝同源；超时原语单源化。
- 宿主：「先落库再派发」六条路径有结构性守卫（dispatch-guard 源码级穷尽 + drain-race
  端到端）；三种并发闸差异化设计各带反向验证；HTTP 安全面干净（鉴权先于 body）。
- 装配：capability-slice 表驱动封死漏项面（TS2741 兜底）；成环检测纯件+穷尽测试；
  MCP 双向桥协议纪律硬；anthropic.ts SSE 边界完备（1068 行测试对真实传输行为）。
- 守卫：防真空是一等公民（每个闸带解析计数下限+阳性对照+射程钉）；verify-all-wiring
  元守卫闭环罕见地彻底；发布面真单源。
- agent 面：AGENTS.md 抽查十余处硬事实全部属实；模板注释每条指向真实事故；trace-view
  共用防线完整（对拍守护×3）；spec §10 与提交严格同步。

## 建议的修复批次

1. **批一（引擎非正常路径）**：A1 retry 坏值校验进 limits 表 + A2 入口抛错合拢根 span。
2. **批二（宿主竞态与契约）**：B1 cancel 接 per-task 闸 + B2 store get 拷贝语义（或改契约）+ B3 认领 save 防护。
3. **批三（装配期静默吞）**：C1 静态方法装饰器 + C2 子菜单重名查重。
4. **批四（守卫射程）**：D1 e2e:mcp:server 进 CI + D2 CLI tsconfig 开承重开关 + E2 inspector 白名单门禁。
5. **批五（计数口径与文档）**：E1 summarizeTrace 嵌套去重 + AGENTS.md 漂移十条 + 低等项里便宜的（PORT 坑、三件套口径、Span.name 注释）。
