# 生产可观测栈（配方）

面向「把 agentia 服务**交付上线**」的人 —— 定位见 [spec §1](./spec.md)（交付物是可上线的 Agent 服务，
不是对话助手）。本文只讲**观测落地**：框架给什么、不给什么，以及四条开箱即用的 sink 配方。

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
- **为什么不内建进框架**：spec §9.3 把脱敏划在 sink 缝外（宿主职责），§10 2026-09-14 ⑥
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

// ① 平台支持 OTLP（Langfuse / Arize Phoenix / Grafana Tempo …）→ 用内置导出器即可
//    它本身就是一个 TraceSink（{ export(trace) }），直接挂进 sinks。
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
- **部署示例未含自动扩缩 / 密钥管理 / 反代鉴权** —— 见 `examples/deploy/README.md` 的标注。
