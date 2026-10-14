# 生产可观测栈（配方）

面向「把 agentia 服务**交付上线**」的人 —— 定位见 [spec §1](./spec.md)（交付物是可上线的 Agent 服务，
不是对话助手）。本文只讲**观测落地**：框架给什么、不给什么，四条开箱即用的 sink 配方（§2），
以及投递纪律 / 已知边界处置 / trace 分析三类缝外配方（§6–§9）。

> 代码：[`examples/observability/`](./../examples/observability/)（本地小包 `@migor/agentia-observability`，
> 四个 sink 的完整实现，零依赖）。
> 该文件与本文的写法由 `tests/docs/observability.test.ts` 真跑一遍钉住 —— 仓库既有约定：
> 文档里的写法必须真能工作。

## 0. 框架给什么 / 不给什么

| | 状态 |
|---|---|
| 完整 trace（调用树，run == trace 1:1，含每步 usage） | ✅ 内建（`spec §9`） |
| sink 出口（`TraceSink`）+ 投递（成功/失败两条路径） | ✅ 内建（`spec §9.3`） |
| OTLP 导出器 / 指标累加器 | ✅ 现成（`createOtlpExporter` / `metricsSink`） |
| **日志层**（级别 / 结构化 JSON / runId 贯穿） | ❌ 框架无日志层，`src/` 内只有零星 `console.error/warn` 兜底 —— ⚠️ **这一处在长，别引用具体数字**（2026-09-15 测 9 处 → 2026-09-29 测 22 处，散在 12 个文件）；要精确值现数：`grep -rn "console\." src/` → **配方 2.2** |
| **采样**（量大时别压垮后端） | ❌ → **配方 2.3** |
| **字段级脱敏**（框架只有长度截断） | ❌ → **配方 2.4** |
| **投递纪律**（非阻塞攒批 / 关停 drain / 后端不可达怎么办） | ❌（sink 内部实现是宿主的）→ **§6** |
| **只收 binary 的 OTLP 接收端**（如 Phoenix，直打 415） | ❌ 内置导出器只发 JSON → **§7**（collector 转码） |
| **步数 / 环信号**（trace 总量里看不见） | ❌ → **§8**（纯 trace 函数，按回合归属） |
| **轨迹评测**（确定性检查优先） | ❌ → **§9**（eval 面与 CLI 已有，这里是拼法） |
| **按 runId 落库 + 检索** | ❌ → **配方 2.1** |
| **部署产物**（Dockerfile / compose） | ❌ → `examples/deploy/` |

关键点：**这些缺口都不需要改 engine**。trace 出口是缝，四条配方全是缝外的组合 ——
这正是 `spec §10` 把出口定成 `TraceSink` 的收益。

## 1. 出口：`TraceSink`

```ts
interface TraceSink {
  export(trace: Trace): void | Promise<void>;
}
```

- **投递时机**：run 收尾后，**成功与失败两条路径都投递**（`runtime/run.ts`）。失败时 trace 仍完整，只是根 span
  可能带 `status: 'error'`。
- **抛错语义**：sink 抛错被框架**吞掉**，绝不影响 run 结果（与记忆回写同款防护）；但**不再零信号** ——
  吞之前落一条 `console.warn`（文案含「trace sink」，可 grep / 接日志采集；2026-09-27 起）。
  所以每个 sink 自己负责「观测失败不能连累别的 sink」—— 见示例里的 `fanOut()`。
- **挂载点两个**：
  - `createApp({ sinks: [...] })` —— 按 app 装配（推荐，作用域清晰）。
  - `registerDefaultTraceSink(sink)` —— 全局默认（**构造期快照合并**，之后再注册不影响已建好的 app）。
- **数组 = 串联**：`sinks: [a, b]` 顺序执行 `a.export` 然后 `b.export`。需要「一个包一个」时（采样包脱敏、
  脱敏包落库）用配方里的组合参数，不用框架感知。

## 2. 四条配方

现成实现在 `examples/observability/`（本地小包）。下面给**接线**与**为什么**，实现细节读那个包。

> ⚠️ **先看这条：怎么拿到它。** 这个包**没有发布到 registry** ——
> `npm i @migor/agentia-observability` 会 **404**。它是**本地小包**：把
> `examples/observability/` 这个目录拷进你的工程，并在 `package.json` 里声明
> `"@migor/agentia-observability": "file:./observability"`（`examples/complete/package.json`
> 就是这么接的，可以直接照抄）。下面每个 `import … from '@migor/agentia-observability'`
> 指的都是它；不想要这个包也可以照源码把那四个 sink 抄进自己的文件。
> `tests/docs/observability.test.ts` 真跑的是仓库内这套接线 —— 仓库外**只有补上这一步才跑得起来**。

### 2.1 按 runId 落库检索（span 与 run 记录同库）

`spec §9.3` 承诺的「span 与 run 记录同库存储」，落地就是一个 sink：

```ts
import { DatabaseSync } from 'node:sqlite';
import { sqliteTraceSink } from '@migor/agentia-observability';

// 与 SqliteTaskStore 用**同一个库文件** —— run 记录（tasks 表）与 trace（traces/spans 表）共库
const db = new DatabaseSync('agentia.db');
const store = sqliteTraceSink({ db });

createApp({ name: 'svc', providers, sinks: [store] });
```

建表 `traces`（一 run 一行：全量 JSON + 反规范化列）与 `spans`（一 span 一行）都用 `IF NOT EXISTS`，
与 `SqliteTaskStore` 共存一库；`busy_timeout = 5000` 与它一致，多进程共库不会 `SQLITE_BUSY`。

取回一次历史 run：

```ts
store.getTrace(runId);   // → Trace | undefined（按 runId 检索，回放调试的入口）
store.getSpans(runId);   // → SpanRow[]（反规范化列：name / kind / durationMs / tokens / errorType）
store.listRecent(20);    // → 最近 N 条 run 摘要（按开始时间倒序）
```

**taskId → runId 关联**：`tasks` 表的 `run_id` 在 `json` 列里（不在列上）。两步查：

```sql
SELECT json FROM tasks WHERE task_id = ?;        -- 1) 解析出 runId（TaskRecord.runId）
SELECT * FROM traces WHERE run_id = ?;           -- 2) 取该 run 的 trace
```

直接 SQL 的常见问题（`spans` 表已反规范化，不用解析 JSON）：

```sql
-- 慢 span 排行
SELECT name, kind, ended_at - started_at AS ms FROM spans
 WHERE run_id = ? ORDER BY ms DESC LIMIT 10;
-- 错误 span
SELECT name, error_type, retryable FROM spans WHERE run_id = ? AND status = 'error';
-- token 大户（只算 llm.turn 自身计量，与 Trace.totalUsage 口径一致）
SELECT name, input_tokens + output_tokens AS tok FROM spans
 WHERE run_id = ? AND kind = 'llm.turn' ORDER BY tok DESC;
```

### 2.2 日志关联

```ts
import { jsonLogSink } from '@migor/agentia-observability';

createApp({ sinks: [jsonLogSink({ labels: { service: 'svc', env: 'prod' } })] });
```

一 run 一行 JSON 落到 stdout（容器里就是 stdout 采集），字段含 `runId` / `status` / `durationMs` /
`iterations` / `tokens` / `costUsd` / `error`。**接缝就在 `runId`**：

- 日志里看到异常 → 拿 `runId` → `SELECT * FROM traces WHERE run_id = ?`（配方 2.1）取完整调用树。
- trace 里看到异常 span → grep 同 `runId` 的日志行看当时上下文。

这是补上「框架没有日志层」那一脚的最小做法 —— 不需要引入日志库。

### 2.3 采样

```ts
import { sampleSink } from '@migor/agentia-observability';

const sink = sampleSink({ rate: 0.1, sinks: [/* 下游 */] });  // 只留 10%
```

- 判定用 **runId 的哈希**（FNV-1a）而非 `Math.random` —— 同一 run 的判定**确定**，回放/复现时一致。
- **失败 run 永不采样掉**：采样为了省钱，不能省掉最该看的那些。
- `rate: 0` = 只留错误 run；`rate: 1` = 全留。
- **丢了要数**：`sampleSink(...).dropped()` 给累计条数，`onDrop` 给回调（接告警/计数器）。
  不数的话，「被采样掉的那部分」与「本来就没跑」在监控上**无法区分** —— 同一个盲区。

**`rate` 怎么定？按容量倒推，不要拍一个数。** 一条 trace 多大是可实测的
（`npm run bench:trace`，零 token 零网络），于是：

| 每 run 的量级 | 实测来源 | 换来什么 |
|---|---|---|
| 每次工具调用 +1.3~1.8 KB（缺省截断） | `npm run bench:trace` | 20 次工具调用 ≈ **50 KB** |
| 每次工具调用 +1.3~1.8 KB（缺省截断） | 同上 | 100 次工具调用 ≈ **250 KB** |
| `maxEventChars: false` + 大出参 | `PAYLOAD_ROWS=1000 npm run bench:trace` | 同样 5 次调用从 17 KB → **234 KB（13.7×）** |
| 记账的数量上限 | `traceLimits.maxEvents` | 超限即停 + run 根两笔 `trace.truncated`（起点标记 `{limit}` + 收尾摘要 `{droppedEvents, limit}`）；两笔都**同时**进交付的 trace 与增量流。⚠️ 这道闸管的是**事件**（`span.events`）——**属性**（`span.attributes`，`setAttribute`）**不在其中**，如实口径见 `tracer.ts` 的 `setAttribute` 注与 spec §10 ⑳ |

算式：`每天 trace 量 ≈ 每天 run 数 × 每 run 字节 × rate`（再乘后端保留天数）。
先用 `rate: 1` 跑一段，量出实际每日量，再拿目标容量反推 `rate`；
**开了 `maxEventChars: false` 的宿主先把这一项算进去再谈采样率** —— 它一个开关就能放大一个数量级，
先截断（长度）再采样（条数）的收益顺序，比反过来大得多。

⚠️ 采样是**导出**决策，不是记账决策：被采样掉的 trace 在框架内**仍然完整记账**
（`TraceSink` 之前的一切都不受影响），只是没发给下游。所以别拿「有采样」当「可以少记账」。

### 2.4 脱敏

```ts
import { redactSink } from '@migor/agentia-observability';

const sink = redactSink({
  keys: ['authorization', 'api_key', 'password', 'cookie'],   // 字段名（大小写不敏感子串，整字段抹掉）
  patterns: [/(内部 ID 形态)/],                                 // 可选：预设猜不到的业务自有形态
  // presets 缺省全开（见下）；传 ['email'] 只开子集，传 false 全关
  sinks: [/* 下游 */],
});
```

- **内置正则预设缺省全开**（拷走即用、不从零开始），替换文案带类别标签：

  | 预设 | 命中形态 | 替换文案 |
  |---|---|---|
  | `bearer` | `Bearer <token>` | `[REDACTED:bearer]` |
  | `jwt` | `eyJ…`.`…`.`…` 三段式 | `[REDACTED:jwt]` |
  | `aws-access-key` | `AKIA…`（16 位） | `[REDACTED:aws-access-key]` |
  | `llm-api-key` | `sk-…`（≥16 位） | `[REDACTED:llm-api-key]` |
  | `email` | 邮箱 | `[REDACTED:email]` |
  | `phone-cn` | 手机号（+86 形态） | `[REDACTED:phone-cn]` |

  带类别标签是为了让「这里被改过、改的是哪类」在 trace 里**可见** —— 静默替换会让下游
  排查误以为数据本来如此。自定义 `patterns` 的替换文案是裸 `[REDACTED]`（无类别）；
  `keys` 命中的字段不看值、整个抹成 `[REDACTED]`（最严的一档）。
  ⚠️ 预设只是起点：你的合规清单（内部 ID 形态、业务字段）得自己补进 `keys` / `patterns`。
- 递归深拷贝 —— **原 trace 不被改动**（其余 sink 仍拿得到原文，便于「本地调试看原文、上报脱敏」并存）。
- 覆盖 `span.attributes`、`span.events[].body`、`span.error.message`。
- 放在链路上游（脱敏 → 落库/日志），保证下游拿到的都是脱敏副本。
- **为什么不内建进框架**：spec §9.3 把脱敏划在 sink 缝外（宿主职责），§10 2026-09-14 ref-event-truncation
  曾把它作为空头承诺写进文档、处理方式是删掉 —— 「删错的、不补对的」。这张配方就是
  「缝外自建」的现成答案；顶部那张「不内建表」里它仍标 ❌，不要当成待办把它搬回框架。

### 2.5 组装

数组顺序即调用顺序，最外层先看到原始 trace：

```ts
const db = new DatabaseSync('agentia.db');
const sink = sampleSink({
  rate: 0.1,
  sinks: [
    redactSink({
      keys: ['authorization', 'api_key'],
      sinks: [
        sqliteTraceSink({ db }),   // 落库（同库）
        jsonLogSink(),             // 一行 JSON 日志
      ],
    }),
  ],
});

createApp({ name: 'svc', providers, sinks: [sink] });
```

### 2.6 送进现成平台（以 Langfuse 为例）

平台基本都提供 **OTLP 端点**或**自己的 ingestion API**，两种接法都**不需要新增框架代码**：

```ts
import { createOtlpExporter, type TraceSink } from '@migor/agentia';

// ① 平台支持 OTLP 且收 JSON（Langfuse / Grafana Tempo …）→ 用内置导出器即可
//    它本身就是一个 TraceSink（{ export(trace) }），直接挂进 sinks。
//    ⚠️ Phoenix 不在此列：它只收 application/x-protobuf，直打会 415 —— 中间加一层
//    collector 转码，见 §7。
//    端点与鉴权以各平台官方文档为准（Langfuse 形如 …/api/public/otel + Basic 鉴权）。
const otlp = createOtlpExporter({
  endpoint: 'https://cloud.langfuse.com/api/public/otel',
  headers: { Authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}` },
});
createApp({ name: 'svc', providers, sinks: [otlp] });

// ② 平台只有自家 ingestion API → 自己写一个 sink（面就这么小）
const platform: TraceSink = {
  async export(trace) {
    /* 把 trace 映射成平台的事件体，POST 过去 */
  },
};
createApp({ name: 'svc', providers, sinks: [platform] });
```

> 框架**不内置任何平台 SDK**。理由：`TraceSink` 只有一个 `export(trace)`，自己写一个比引依赖更省心，
> 也不会把「平台 SDK 的版本」变成框架的维护负担。内置的只有 OTLP（协议标准、零依赖）。

### 2.7 OTLP 关联：在 Tempo / Grafana 里「从 span 找回 run」

把 `createOtlpExporter` 接进 Tempo 之后，「按 run 查 trace」卡在两个没写进线缆形态的事实上：

**① id 是投影过的 hex。** 框架内部 id 是 UUID（`runId == traceId`，带 `-`）；OTLP 要求 trace id
是 **32 位 hex**、span id 是 **16 位 hex**，导出时统一过 `wireTraceId` / `wireSpanId`
（`src/core/trace.ts` —— 与出站 `traceparent` 用的是**同一份**投影，改一处两处同步）：

- **traceId**：去掉 `-` 即 32 位 hex —— **无损**：按 8-4-4-4-12 加回横线就是 runId。
  所以在 Tempo 里查某条 run：把日志（配方 2.2）/ 落库（配方 2.1）拿到的 runId 删掉 `-`，
  直接按 trace id 查；反过来从 Tempo 的 32 位 trace id 找回 runId 也是纯加横线，**不用另建映射表**。
- **spanId**：去 `-` 后**截前 16 位**（8 字节）—— 有损，本地完整 spanId 反推不回去；
  投影幂等（已是 hex 的输入原样通过，上游转发来的 span id 不再变形）。

**② 查 run 根要按 `gen_ai.operation.name = 'invoke_agent'` 过滤，不能按「带 `gen_ai.*` 键」过滤。**
llm.turn 也带 `gen_ai.*` 键（`gen_ai.operation.name = 'chat'`），且与 run 根**共享同一 traceId** ——
只按「键存在」过滤会把每一回合的 turn 全捞进来。列出「最近的 run」（TraceQL；带点号的属性名
可直接写，点号会被并进属性名，遇解析歧义改用带引号写法 `."gen_ai.operation.name"`）：

```
{ .gen_ai.operation.name = "invoke_agent" && .gen_ai.agent.name = "你的应用名" }
```

⚠️ 子 agent 的 capability span **同样**带 `invoke_agent`（它确实是一次嵌套 agent 调用，semconv
口径如此），区别是它**有父 span**（run 根没有）。上面的查询把 `gen_ai.agent.name` 收窄成应用名后
（经 `createApp({ name })` 走的 run，根 span 的该值就是应用名；子 agent 那里是子 agent 名），
剩下的一般就是 run 根；要严格区分，再按「无父 span」过滤一道。

## 3. 与内置件的关系（别重复造）

| 内置件 | 干什么 | 和上面的关系 |
|---|---|---|
| `createOtlpExporter({ endpoint })` | OTLP/JSON → collector（Jaeger / Tempo / Grafana）；属性**对齐 `open-telemetry/semantic-conventions-genai` @ `6fd0d763`（2026-10-09；GenAI 约定自 v1.42 起移出主线，该仓无 tag）**（additive：追加 `gen_ai.*` 键、保留旧键 —— run 根 `invoke_agent` / llm.turn `chat` / score 事件译 `gen_ai.evaluation.result`，映射集中 `otlp.ts` 单模块） | **可以用内置的**：返回值天然满足 `TraceSink`，直进 `sinks` |
| `metricsSink({ prefix })` | 进程内累加 + Prometheus 文本 `/metrics`；除 run/能力/模型三维外还有**评分族** `agentia_score`（gauge，最近一次值）+ `agentia_score_total`（counter，条数）—— 来自 run 根 `score` 事件（`attachScore` 写入），label 为 `name` × `source` | **可以用内置的**：同样满足 `TraceSink` |
| 本文四条配方 | 落库 / 日志 / 采样 / 脱敏 | 内置件没有的那部分，缝外自建 |

OTLP 与本文配方**不互斥**：`sinks: [sampleSink({ rate: 0.1, sinks: [createOtlpExporter({...})] }), sqliteTraceSink({ db })]`
= OTLP 采样 10%、本地库全量留档，是常见配法。

## 4. 指标 ↔ trace 互跳（exemplars）

`metricsSink` 聚出来的指标与 trace 之间有一座桥：**exemplar** —— 数据点上挂一个代表性
traceId，在 Grafana 里从「`runs_failed_total` 的尖峰」一键跳到「那条失败 run 的调用树」。
框架记账时跟踪两个槽位（价值最高的两个「尖峰 → 现场」；各一个槽位、O(1)，无内存压力）：

| 指标 | exemplar 口径 |
|---|---|
| `<prefix>runs_failed_total`（counter） | **最近一次**失败的 run（覆盖式 —— 尖峰时要看的是最新的那条） |
| `<prefix>run_duration_ms`（histogram） | 迄今**最慢**的一次 run（破纪录才换；等值保留旧的，「最慢」是稳定锚点） |

`snapshot().exemplars` 里也能直接读到这两个槽位（`failed` / `slowest`，还没有时为 `undefined`）。
不做 per-能力 / per-模型 exemplar：那两个维度的基数上限封得住标签，封不住「每键一个槽位」的扩散。

### 怎么开

exemplar **记账恒开**（两个槽位各存一条引用，成本可忽略）；差别只在**出口**：

- 缺省 `export: 'prometheus'`：Prometheus 原文格式（0.0.4）**没有 exemplar 语法**，输出不含它（逐字节不变）。
- `export: 'openmetrics'`：`render()` 出 OpenMetrics 文本 —— 失败 counter 的样本行尾挂
  `# {trace_id="…"} 1 <时间戳>`；时长 histogram 的 exemplar 挂在**最慢那次落入的 `_bucket` 行**上
  （规范要求 histogram 的 exemplar 必须挂 bucket，不能挂 sum/count）；文件以 `# EOF` 收尾。
  端点的 Content-Type 必须是 `application/openmetrics-text; version=1.0.0`
  （否则抓取端按 0.0.4 解析、exemplar 被静默丢掉）—— 内置路由 `createHttpHandler({ metrics })`
  **自己认这个**：sink 的 `contentType` 字段随 `export` 模式走，路由直接读它发响应头，
  不用自己挂路由（自己挂端点同理：读 `sink.contentType`，别写死）。
- `export: 'otlp'`：exemplar 是 OTLP 数据点的原生字段（`exemplars[]`，含 hex 投影的
  `traceId` / `spanId` 与 `timeUnixNano`），随导出自动带上，无需任何配置。

```ts
import { metricsSink } from '@migor/agentia';

const metrics = metricsSink({ export: 'openmetrics' });
// 直接喂给内置路由即可 —— Content-Type 由 sink.contentType 声明，路由读它：
createHttpHandler(app, { metrics });
```

### Grafana 里长什么样

1. Prometheus 开 exemplar 存取（启动参数 `--enable-feature=exemplar-storage`；Grafana Mimir 原生支持）。
2. Grafana 的 **Prometheus 数据源**配置页 → **Exemplars**：加一条 internal link，指向你的
   **Tempo 数据源**，label 名填 `trace_id`（与本框架挂在样本行尾的标签同名）。
3. Explore 里查 `agentia_runs_failed_total`（或 `histogram_quantile` 包 `agentia_run_duration_ms`），
   尖峰数据点旁的 exemplar 标记点开即跳到 Tempo 里**那条** trace —— trace 侧由
   `createOtlpExporter` 送进 Tempo，两侧走同一份 `wireTraceId` hex 投影，是同一个 id。

## 5. 边界（如实标注）

- **框架不内建日志层 / 采样 / 脱敏 / 存储 / 部署产物** —— 那是宿主职责，框架只保证 trace 出口。
- **失败路径的根 span 可能未收尾**（`endedAt === undefined`）：半截 trace 仍会投递（信息比丢了好），
  但按 duration 统计时要过滤 —— `metricsSink` 就是这么做的（根没收尾的 run 不进延迟样本）。
- **采样与「错误必留」是取舍**：错误全留会让故障期的落库量反而升高；极端场景请自行收紧。
- **`costUsd` 依赖模型在价格表内**：不在表里时成本恒 0（见 `usage.ts`）。
- **OTLP 导出只发 JSON**：`createOtlpExporter` 的 `content-type: application/json` 写死、
  `OtlpExporterOptions` 无编码选项 ⇒ 只收 binary 的接收端（Phoenix 回 415）直打不进去；
  处置是中间加一层 collector 转码（§7），为什么不内建 protobuf 编码器也在那节。
- **部署示例未含自动扩缩 / 密钥管理 / 反代鉴权** —— 见 `examples/deploy/README.md` 的标注。

## 6. 投递纪律（sink 侧三条）

三条纪律，全部落在 **sink 内部或宿主侧** —— 框架侧的投递语义（§1）一个字不用改。

### ① 非阻塞投递：在 sink 内部攒批，不改 `flushSinks`

`flushSinks` 是**串行 `await`**：run 收尾时挨个等每个 sink 的 `export()` 返回（`runtime/run.ts`）。
「run 收尾不该等一次同步 POST」的正确落点是 **sink 内部攒批 + 定时 flush** —— 收尾只入队
（微秒级、不碰网络），网络在后台走：

```ts
import type { Trace, TraceSink } from '@migor/agentia';

/**
 * 批量投递 sink：export 只入队，后台按 flushMs 攒批 flush。
 * 关停前宿主自己调一次 drain()（冲完队列再退出），close() 停定时器让进程能退出。
 */
function batchingSink(
  downstream: TraceSink,
  opts: { flushMs?: number; maxQueue?: number } = {},
): TraceSink & { drain(): Promise<void>; close(): void } {
  const flushMs = opts.flushMs ?? 5_000;
  const maxQueue = opts.maxQueue ?? 1_000;
  const queue: Trace[] = [];
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    // 串行链：两轮 flush 不并发 —— 并发 POST 会让后端看到的 trace 顺序失真
    chain = chain.then(async () => {
      for (;;) {
        const trace = queue.shift();
        if (trace === undefined) break;
        try {
          await downstream.export(trace);
        } catch (err) {
          // 纪律 ③：后端不可达就丢遥测、绝不丢可用性 —— 接住、出声、继续
          console.warn('[agentia] 遥测投递失败（该条 trace 已丢弃）:', err);
        }
      }
    });
    return chain;
  };

  const timer = setInterval(() => void flush(), flushMs);
  timer.unref(); // 观测定时器不该拖住进程退出

  return {
    export(trace) {
      if (queue.length >= maxQueue) {
        // 队列满 = 后端持续不可达：丢最旧并出声（丢了要数，与配方 2.3 同一条纪律）
        queue.shift();
        console.warn('[agentia] 遥测队列已满，丢弃最旧的一条 trace');
      }
      queue.push(trace);
    },
    drain: flush,
    close: () => clearInterval(timer),
  };
}
```

**为什么不把 `flushSinks` 改成 fire-and-forget**：spec §9.3 给 sink 的语义是「收尾拿整棵、
**有兜底、会投递**」—— 与 `onTraceEvent` 的「运行期逐笔、不保证送达」是**两条不同的缝**。
把 `flushSinks` 改成不等待，等于把 sink 缝降级成事件缝：**删掉的是一条已有承诺**，而想要
「不阻塞」的人什么也没得到（trace 仍要有人投，只是没人再等它）。所以非阻塞是 sink 的实现细节，
不是框架的投递语义。

### ② 关停时 drain

攒批 sink 的队列在 run 生命周期之外，`handler.drain()` 只等在飞 run 收尾 —— 批量队列要在
**同一个信号处理器里**、退出之前自己冲一次。顺序（`examples/deploy/src/main.ts` 的信号处理器
就是模板）：SIGTERM/SIGINT → `handler.drain({ timeoutMs: 15_000 })`（等在飞 run 把各自 trace
**投进队列**）→ `sink.drain()`（把队列发完）→ `sink.close()` → 退出。

### ③ 后端不可达就丢遥测、绝不丢可用性

已有两层兜底：sink 抛错被框架吞掉（吞前落一条含「trace sink」的 `console.warn`，§1）；
`createOtlpExporter` 自带 `timeoutMs`（缺省 10s 的半开连接防护）、非 2xx 抛 `OtlpExportError`
（带数值 `status`，429 / 5xx 可分类）。**自己写 sink 时照上面骨架的 `catch`**：接住、出声、
继续 —— 「能拖垮调用方的可观测，比没有更糟」。要分类信号就给
`createOtlpExporter({ onExportError })`；别把错误重抛给框架 —— 框架只会吞掉它，分类信息就丢了。

## 7. OTLP 只发 JSON：直打 Phoenix 会 415（已知边界 + 转码配方）

**事实**（源码级核实，2026-10-12）：

- 内置导出器**只发 `application/json`**：content-type 在 `src/integrations/otlp.ts` 写死，
  `OtlpExporterOptions`（`endpoint` / `headers` / `serviceName` / `timeoutMs` / `onExportError`）
  里**没有编码选项**。
- **Arize Phoenix 只收 `application/x-protobuf`**：它的 traces 路由对别的 content-type 直接回
  **415**。OTLP 规范对接收端只是 **SHOULD** 双收（binary + JSON 同端口、按 Content-Type 分派）
  ⇒ Phoenix 是「未遵循推荐」，不是违规；**但这不改变本仓默认配置打不进去的事实**。
- 收 JSON 的一侧没问题：OTel Collector（实测 `HTTP 200`）与 Langfuse（源码级：按 content-type
  分派，JSON 分支就是 `JSON.parse`）都收。⇒ 换后端前先确认它的 OTLP/HTTP 收不收 JSON。

**处置：中间加一层 OTLP Collector 转码**（收 JSON、转 binary 发 Phoenix），本仓一行不用改：

```yaml
# collector.yaml —— 收 agentia 的 OTLP/JSON，转 binary 发给 Phoenix
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  otlphttp:
    endpoint: http://phoenix:6006  # Phoenix 的 OTLP 端点（/v1/traces 由 exporter 自己拼）
    encoding: proto                # binary protobuf（本就是缺省值，写明是省得读的人去查）
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp]
```

应用侧把 `createOtlpExporter({ endpoint })` 指向 collector（`http://localhost:4318`）即可 ——
与 §2.6「平台支持 OTLP 就直打」之间只多了这一层。

**为什么不内建 protobuf 编码器**：零运行时依赖是硬约定
（`tests/architecture/no-runtime-deps.test.ts` 强制），手写一套 varint / length-delimited /
field number 编码器是几百行进核心 —— 为「打某一个挑食的接收端」不值；collector 转码是这个
生态的标准件。

## 8. 步数与环：在 trace 上数出来

「步数 / 环」在 trace **总量**里看不见：`Trace.totalUsage` 是合计，一个 20 步的 run 和一个 3 步的
run 都只给一个总数。**只有把成本按回合（`llm.turn` span）归属，环才显形** —— 「agent 在同一个
问题上问了三遍」。这是纯 trace 函数，离线可跑、框架零改动：

```ts
import type { Trace } from '@migor/agentia';

/** 一条工具调用的签名：同名同参视为同一次（事件的 input 已是 JSON 串，直接比） */
function toolSignatures(trace: Trace): Array<{ turn: number; signature: string }> {
  const turns = trace.spans
    .filter((s) => s.kind === 'llm.turn')
    .sort((a, b) => a.startedAt - b.startedAt);
  return turns.flatMap((s, i) =>
    s.events
      .filter((e) => e.name === 'tool.input')
      .map((e) => {
        const body = e.body as { tool?: unknown; input?: unknown };
        return { turn: i + 1, signature: `${String(body.tool)}(${String(body.input)})` };
      }),
  );
}

/** 环：同一签名**连续**出现 ≥ minRepeat 次（「同一工具同参数连调 N 次」的典型形状） */
function detectLoops(
  trace: Trace,
  minRepeat = 3,
): Array<{ signature: string; count: number; fromTurn: number }> {
  const seq = toolSignatures(trace);
  const out: Array<{ signature: string; count: number; fromTurn: number }> = [];
  for (let i = 0; i < seq.length; ) {
    let j = i + 1;
    while (j < seq.length && seq[j].signature === seq[i].signature) j++;
    if (j - i >= minRepeat) {
      out.push({ signature: seq[i].signature, count: j - i, fromTurn: seq[i].turn });
    }
    i = j;
  }
  return out;
}
```

读数口径（与记账侧逐条对齐）：

- **步数** = `llm.turn` span 数；**每回合成本** = 该 span 的 `usage.costEstimate`（未定价模型缺
  这个键 —— 那种回合上有 `usage.unpriced` 事件、上游没回报计量时有 `usage.missing`，两个都可数）；
- **工具耗时与成败**按 `tool_use_id` 把 `tool.input` / `tool.output` 配对（两笔都记在发起它的
  `llm.turn` 上；`tool.output` 带 `durationMs` / `ok` / 有值才在场的 `errorKind`）；
- ⚠️ 开了 `traceLimits.maxEvents` 的 trace 可能**缺尾巴**（超限停记，run 根有 `trace.truncated`
  摘要；实测出现过「只有 `tool.input`、没有配对的 `tool.output`」）—— 这类 trace 先按不完整
  剔除或标注，别把截断读成「agent 没调工具」。

## 9. 轨迹评测：确定性检查优先

三层评测（final-answer / trajectory / per-turn）里，本仓原料最齐的是第二层（**trajectory**：
路径对不对）—— 判据大多是 trace 的纯函数，而 trace 在本仓是一等公民。拼法（全部现成件）：

- **确定性检查先进闸门**：工具调用签名相等、步数上限、成本上限 —— 都是代码判得了的
  （§8 的数法直接复用）；
- **用例从线上 trace 回流**：`agentia harvest trace.jsonl --failed --out evals/harvested.ts`
  生成骨架（`docs/usage-guide.md` §6「线上 trace 回流」），人工把断言改成确定性检查后进套件；
- **A/B 对照**：同一输入换模型 / 换 prompt 重跑，`agentia diff a.jsonl b.jsonl`（程序内是
  `diffTraces`，与 CLI 逐字同源）—— 有差异退出码 1，可直接挂 CI；
- **跑法**：`defineEval` + `scriptedClient` —— 断言在 `expect(r, { trace })` 里，trace 就在
  手边；结论由框架自动 `attachScore` 挂到 trace 根的 `score` 事件，`metricsSink` 聚合成通过率。

```ts
import assert from 'node:assert/strict';
import { defineEval, scriptedClient, type Trace } from '@migor/agentia';

/** 轨迹判据 = trace 的纯函数：工具调用签名序列（tool + 入参，顺序敏感） */
function trajectoryOf(trace: Trace): string[] {
  return trace.spans
    .filter((s) => s.kind === 'llm.turn')
    .sort((a, b) => a.startedAt - b.startedAt)
    .flatMap((s) =>
      s.events
        .filter((e) => e.name === 'tool.input')
        .map((e) => {
          const body = e.body as { tool?: unknown; input?: unknown };
          return `${String(body.tool)}:${String(body.input)}`;
        }),
    );
}

// 参考轨迹：跑一次「正确」的 run 落 jsonl，人工核对后抄进这里
const REFERENCE = ['search:{"q":"agentia"}', 'summarize:{"n":3}'];

export const trajectoryEval = defineEval({
  name: 'trajectory-first',
  app: () => app, // 既有的 createApp 产物（模型侧由用例的 client 接管）
  cases: [
    { name: '先查再总结', input: '查一下 agentia 再总结', client: scriptedClient([/* … */]) },
  ],
  expect: (r, { trace }) => {
    // ① 确定性优先：签名序列与参考轨迹逐项相等
    assert.deepEqual(trajectoryOf(trace), REFERENCE);
    // ② 步数上限：llm.turn span 数（与 §8 同一份数法）
    assert.ok(trace.spans.filter((s) => s.kind === 'llm.turn').length <= 5);
    // ③ final-answer 层照常断 r.finalText / r.typed —— 主观项才轮到 judge
  },
});
```

**LLM-judge 殿后**：judge 只补主观项（语气 / 忠实度 / 开放式质量），不进这道闸门 —— 它要花钱、
会抖，「要花钱、会抖的门禁没人敢当发布判据」（`docs/eval-gate.md` 同款理由）。要跑就单独一条
命令、按采样率跑，结论走 `attachScore` 进指标看趋势，不挡发布。「这一版能不能发」的对照闸门
（回归 / 删用例检测）见 `docs/eval-gate.md`，与本节互补。
