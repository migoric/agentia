# observability-mcp —— 让 agent 自己查「我上一轮慢在哪」

把框架的调优报告（`buildRunReport` / `diffTraces`）包成两个 **MCP 只读工具**，任何 MCP 宿主
（编辑器、桌面客户端、另一个 agent）接上来就能问：

- *「上一轮哪个能力最慢 / 最贵 / 最爱失败？」*
- *「换了模型重跑一遍，到底哪里变了？」*

## 这是什么（以及不是什么）

**是**：一条「观测面 → agent」的接线 —— 复用框架现成的反向桥 `createMcpServer`，
`tools/call` 的协议面（含 SEP-414 的 `_meta.traceparent` 入站缝合）一行都不用重写。

**不是**：新能力。trace 落盘、报告、diff 早就有（`agentia report` / `agentia diff`）；
这里补的是**分发面** —— 让不具备 shell 的 agent 也能调到同一份结论。所以它的验收标准是
「外部客户端接上能拿到正确数字」，不是「新增了多少功能」。

## 跑起来

```bash
cd examples/observability-mcp && npm install     # 依赖指向本仓库（见文末）
npm run build

# StreamableHTTP（缺省 127.0.0.1:7717）
AGENTIA_TRACE_ROOT=/path/to/traces npm start
#  · 起完会打印实际 endpoint，如 http://127.0.0.1:7717/mcp

# 或 stdio（给父进程 spawn 的那种宿主）
AGENTIA_TRACE_ROOT=/path/to/traces npm run stdio
```

接入宿主的配置按各宿主写法填：HTTP 类填 URL，stdio 类填 `node <本目录>/dist/main.js --stdio`。

## 两个工具

| 工具 | 入参 | 出参 |
|---|---|---|
| `report_trace` | `file`（trace 文件路径） | `runs` / `succeeded` / `failed` / `skippedLines`、能力排行（`report.capabilities`：`kind:name`、调用数、错误数、总耗时与最大耗时、token、成本）、模型归因、**两类「成本像 0」的清单**（`unpricedModels` 要换模型 / `usageMissingModels` 要查端点）、`sessions`（按会话归组的成功率与「每成功任务成本」，最多 40 组，`sessionGroups` / `sessionsTruncated` 如实报出截断） |
| `diff_traces` | `before` / `after`（两条 run）、可选 `beforeRun` / `afterRun` 指定第几条 | `equal`、`summary`（run 级差异）、`spans`（逐 span 字段差异 + 缺侧标记，截断与真实条数如实报出） |

两者都吃 `jsonlTraceSink` 写出的 JSONL（一行一条裸 Trace；TaskRecord 那种带
`result.trace` / `trace` 的记录也收）。

## 三条口径（都不是装饰）

1. **只读 trace 根底下的文件**。工具入参由模型给、返回内容直接进模型上下文 ⇒ 不设边界就等于
   对外发了一个「任意文件读取」原语。判据是 **realpath 后比前缀**（符号链接一并拦住），不是
   字符串 `startsWith` —— 后者能被 `root/../../etc/passwd` 与「同前缀的兄弟目录」（`/data` 对
   `/data-evil`）绕过。根由 `AGENTIA_TRACE_ROOT` 指定，缺省 `cwd`。
2. **进模型上下文的东西必须有天花板**。`diff_traces` 一次最多返回 40 条差异 span
   （`SpanDiff` 里的 `a` / `b` 是**完整 span**，原样返回一次就能顶掉整轮预算）；截掉多少在
   `truncated` 里如实报出。`report_trace` 的 `sessions` 同款：最多 40 组（按总耗时降序留头部），
   截掉多少在 `sessionsTruncated`（与总数 `sessionGroups`）里如实报出 —— 长寿 trace 文件
   （几千个不同会话）不会把几千行灌进模型上下文。
3. **读不出就说读不出**。文件一条 trace 都认不出 ⇒ 工具报错（不是空表 —— 空表会被读成
   「零开销」）；成本取 `totalUsage.costEstimate`，读不出给 `null`；`succeeded === 0` 时
   「每成功任务成本」给 `null` 而不是 0。

## 验收

```bash
npm run build && npm run verify
```

`verify` 是**端到端**的：真起一个 StreamableHTTP server，用出厂的连接器 + `mcpTools` 连回去，
跑 **10 组 / 26 条** check —— ② `tools/list` 握手拿到两个工具；③ `report` 的 run 计数、会话归组、
能力表与成本；④ `diff` 看到「第二回合换了能力」；⑤ 一侧少一个回合时的**缺侧标记**；
⑥ 45 个回合被截到上限且 `truncated` 如实；⑦ trace 根之外的路径被拒并点名理由；
⑧ 会话分组键的**三级回退**（`session.id` → wrapper 顶层 `taskId` → `(无会话)`，与 CLI 同口径）；
⑨ `AGENTIA_TRACE_ROOT=/` 的特判（根下文件不被误拒）；⑩ `sessions` 超 40 组被截断且
`sessionsTruncated` 如实。
被查的 trace 由 `scriptedClient` 剧本真跑出来 —— 零 API key、零网络，任何机器上结果一致。
同一条链也跑在仓库的示例门禁里（`scripts/e2e-examples.ts`，断言 `✗` 计数为 0）。

## 依赖说明

⚠️ **这个包没有发布到 registry** —— `npm i @migor/agentia-observability-mcp` 会 **404**
（`"private": true`）。要拿到它：拷走 `examples/observability-mcp/` 整个目录。

`"@migor/agentia": "file:../.."` 是**刻意**的：示例要跑工作区里刚构建的那份框架，而不是 npm 上的
发布版（全仓示例同一约定，见 `examples/README.md`）。要用发布版就把这一行换成 `"^0.10.2"`。

## 顺带：本 server 自己也是可观测的

`OBS_MCP_TRACE_FILE=/path/to/server-trace.jsonl npm start` ⇒ 每次 `tools/call` 的 trace
追加落盘（同一个 `TraceSink` 出口，没有为「观测观测台」新开任何口子）。

## 边界（如实标注）

- 只读：没有写文件、没有改 trace、没有触发 run 的能力。
- 不做聚合之外的加工：报告与差异的**口径**全部来自框架公共面，本示例只补了「读 JSONL」与
  「会话归组」两段（口径与 CLI `agentia report` 一致，理由写在 `src/traces.ts` 头部）。
- **已知边界：TOCTOU**（与 `examples/patrol` 同款自知）：realpath 校验与实际 `readFile`
  之间存在时间窗 —— 校验时被放行、读之前路径被换成指向根外的软链，这一层示例不防；
  生产上靠挂载层（`:ro`、独立 uid）兜底。
- **入站 `traceparent` 缝合（SEP-414）是引擎层白得的**（`createMcpServer` 认
  `params._meta.traceparent`，合法即记成 run 根的一条 `links`）—— 本示例**没有**为它做
  端到端断言；那条链路由框架自己的测试与 `e2e:mcp:server` 守着。
- 不内建存储 / 索引 / 鉴权策略：HTTP 侧要鉴权请用 `createMcpServer` 的 `auth` 钩子自己接；
  本示例不做，是因为「只给缝不给策略」是本仓的定位（`docs/spec.md` §9.3）。
