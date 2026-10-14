import { capabilityKindOf } from '../core/trace.js';
import type { SpanId, Trace, TraceId } from '../core/trace.js';
import { TOOL_OUTPUT_EVENT, USAGE_MISSING_EVENT } from '../core/trace.js';
import { percentile } from '../core/stats.js';

/**
 * metricsSink 的**状态层**：进程内累加器 + 快照（本文件）与渲染/导出（`metrics-render.ts` /
 * `metrics-otlp.ts`）分离。本文件只管「账」，不管「怎么给人看 / 怎么发出去」。
 * module 级 export，不进公共面（`src/index.ts`）。
 */

/** 能力维度指标（`snapshot().capabilities[label]`） */
export interface CapabilityMetrics {
  /** 该能力的调用次数 */
  calls: number;
  /** 其中失败次数（工具 `ok:false`；skill/subagent 的 capability span `status:'error'`） */
  errors: number;
  /** 单次调用耗时（毫秒）的窗口内精确分位；无样本时 0 */
  latencyP50: number;
  latencyP95: number;
  /** 仅 skill/subagent：子孙 llm.turn 的 token 聚合（四类之和）；工具为 null */
  tokens: number | null;
  /** 仅 skill/subagent：估算成本（美元）；未定价或工具为 null */
  costUsd: number | null;
}

/** 模型维度指标（`snapshot().models[model]`） */
export interface ModelMetrics {
  /** 该模型的 llm.turn 次数 */
  turns: number;
  /** 四类 token 之和 */
  tokens: number;
  /** 已定价部分的成本（美元）；全未定价时为 0 */
  costUsd: number;
  /** 成本估不出来的 turn 数（模型不在价格表内，且未用 priceOverrides 覆盖）*/
  unpricedTurns: number;
  /**
   * 上游**没回报 usage** 的 turn 数（2026-09-28 外部深评 S2）。
   * 与 `unpricedTurns` 是两件事：那个是「模型不在价格表里」，这个是「上游没给计量」——
   * 两者都会让成本**看起来**是 0，但排障方向不同（换模型 vs 查端点/网关）。
   */
  usageMissingTurns: number;
  latencyP50: number;
  latencyP95: number;
}

/** 评分维度指标（`snapshot().scores[key]`，key 为 `name@source`，source 缺省时裸 name） */
export interface ScoreMetrics {
  /** 最近一次评分值（gauge 语义 —— 分数不是累加量） */
  value: number;
  /** 评分条数 */
  count: number;
  /** 评分值合计（平均 = sum / count） */
  sum: number;
}

/** 归因标签维度的 run 级指标（R8-P4；`snapshot().runLabels[key]`，key 为 `k=v` 逗号连） */
export interface RunLabelMetrics {
  runs: number;
  failed: number;
  /** 四类 token 之和（与 run 级 tokens 口径一致） */
  tokens: number;
  /** 累计成本估算（美元）；未定价的 run 不计入（与全局 costUsd 同口径） */
  costUsd: number;
}

/**
 * runLabels 的内部累加器：比快照形状多带一份 `pairs`（渲染/出口按它拼标签，
 * 不从 combo 键反解 —— 值里含 `,`/`=` 时反解会碎）。
 */
export interface RunLabelAcc extends RunLabelMetrics {
  /** 已过完各自 KeyBudget 的 `[key, value]` 对（顺序 = 配置的 labelKeys 顺序） */
  pairs: readonly (readonly [string, string])[];
}

/**
 * exemplar 槽位内容：指向「哪条 run」的最小引用（traceId + 根 spanId + 记账时刻）。
 * 内部存**原始 id**，hex 投影（`wireTraceId` / `wireSpanId`）在各自出口做（单一真源在 core/trace.ts）。
 */
export interface RunExemplar {
  traceId: TraceId;
  /** run 根 span 的 id —— OTLP exemplar 的 spanId 字段（跳到具体 span，不只是整条 trace） */
  spanId: SpanId;
  /** 记账时刻（epoch 毫秒）—— OTLP 的 timeUnixNano / OpenMetrics 行尾时间戳都从它派生 */
  at: number;
}

/** `snapshot().exemplars` 的形状 —— 「指标尖峰 → 那条 trace」的桥（只给读侧，不含 spanId 细节） */
export interface ExemplarSnapshot {
  /** `runs_failed_total` 的 exemplar：**最近一次**失败的 run；尚无失败时 undefined */
  failed: { traceId: TraceId; at: number } | undefined;
  /** `run_duration_ms` 的 exemplar：迄今**最慢**的一次 run；尚无时长样本时 undefined */
  slowest: { traceId: TraceId; durationMs: number; at: number } | undefined;
}

/** 进程内累计快照（`snapshot()` 返回） */
export interface MetricsSnapshot {
  /** 投递过 trace 的 run 总数（= `export` 被调用次数） */
  runs: number;
  /** 其中 `trace.status === 'error'` 的条数（含 budget_exceeded / aborted / error） */
  failed: number;
  /** run 时长（根 span `endedAt - startedAt`）分位，毫秒；窗口内无样本时 0 */
  latencyP50: number;
  latencyP95: number;
  /**
   * 累计 token —— 口径 = **四类之和**（input + output + cacheRead + cacheCreation），
   * 与 `BudgetGuard` 的 token 口径一致。分项在 `render()` 里以 label 给出，不会丢。
   */
  tokens: number;
  /** 累计成本估算（美元）；模型不在价格表内时该 run 不计入（见 usage.ts） */
  costUsd: number;
  /**
   * 能力维度（`labelMode:'none'` 时为空对象）。超 `maxCapabilities` 的键折叠在
   * `'__other__'` —— 该桶照常累加，所以这里的**总量**不受上限影响。
   */
  capabilities: Record<string, CapabilityMetrics>;
  /** 模型维度；超 `maxModels` 的键折叠在 `'__other__'`（同上：总量不丢） */
  models: Record<string, ModelMetrics>;
  /**
   * 评分维度（key 为 `name@source`，source 缺省时裸 name；无评分时为空对象）；
   * 超 `maxScores` 的键折叠在 `'__other__'`。
   */
  scores: Record<string, ScoreMetrics>;
  /** 因 `maxCapabilities` 上限被归入 `__other__` 的不同能力数 */
  droppedCapabilities: number;
  /** 因 `maxModels` 上限被归入 `__other__` 的不同模型数 */
  droppedModels: number;
  /** 因 `maxScores` 上限被归入 `__other__` 的不同评分维度数 */
  droppedScores: number;
  /**
   * 归因标签维度（R8-P4）：`metricsSink({ labelKeys })` 显式点名的键才有 —— 缺省为空对象
   * （一个都不上）。key 为 `k=v` 逗号连（如 `tenant=acme,plan=pro`，值里的 `,`/`=`/`\`
   * 经转义）；每个键的相异值数受 `maxLabelValues` 封顶，**组合数**受 `maxLabelCombos`
   * 封顶（超出的组合折叠进一个全 `__other__` 的桶），两处折叠都只丢标签粒度、不丢量。
   */
  runLabels: Record<string, RunLabelMetrics>;
  /** 每个已配置 labelKey 被 `maxLabelValues` 折叠的不同值数（只含配置了的键） */
  droppedLabelValues: Record<string, number>;
  /** 被 `maxLabelCombos` 折叠的不同标签组合数（未配置 labelKeys 时恒 0） */
  droppedLabelCombos: number;
  /**
   * exemplar（指标 → trace 的桥，2026-09-27）：只跟踪价值最高的两个槽位 ——
   * 失败 counter 的「最近一次」与 run 时长 histogram 的「最慢一次」。
   * 不做 per-能力/per-模型：基数上限封的是标签，挡不住「每键一个槽位」的扩散。
   */
  exemplars: ExemplarSnapshot;
  // 注：三个计数各自最多记账 1024 个不同键，满了以后是**下界**（那已是键空间失控的
  // 量级，报警够用）。要精确值就得为无界键空间留一本无界的账 —— 与设上限的初衷相反。
}

/** 超过基数上限后新键的兜底标签（能力 / 模型 / 评分 / 标签组合四个维度共用） */
const OTHER_LABEL = '__other__';

/**
 * 标签 combo 的**身份**：`k=v` 逗号连，但值里的 `,` / `=` / `\` 先转义。
 *
 * 为什么不能裸拼：这个字符串同时是 Map 的 identity（不只是展示形）。裸拼时
 * `[a='x,b=y', b='z']` 与 `[a='x', b='y,b=z']` 都拼成 `a=x,b=y,b=z` —— 两个不同的
 * 标签集并进同一本账，且 `pairs` 只留第一次那份 ⇒ 后者的量被挂在前者的标签下
 * （2026-09-27 ref-menu-drift-signals 实测）。转义之后正常值（不含这三个字符的）拼法与展示形**逐字不变**，
 * 只有病态值才多出反斜杠，而那是它唯一的无歧义写法。
 *
 * 渲染侧不复用它 —— 那边的标签逐键从 `pairs` 出来（Prometheus 只要求转义值里的
 * `"` 与 `\`），所以这里多出来的转义不会漏进指标文本。
 */
const labelCombo = (pairs: readonly (readonly [string, string])[]): string =>
  pairs.map(([k, v]) => `${k}=${escCombo(v)}`).join(',');

/** `,` / `=` / `\` 三个字符按 `\` 前缀转义（键是合法标签名，用不到，但转义对两者都做） */
const escCombo = (s: string): string => s.replace(/[\\,=]/g, (c) => `\\${c}`);

/**
 * 折叠计数最多记这么多个**不同**键（每个维度各一本）。计数只用于报警「基数爆了」，
 * 不值得为它留一本无界的账 —— 那等于把上限又拆掉一角。正常上限（50~200）下这个数
 * 远够用：真要记满，说明键空间已经失控，此时「≥1024」和精确值一样能说明问题。
 */
const MAX_DROPPED_TRACKING = 1024;

/**
 * 标签基数配额：三个维度共用的「有界键空间」。
 *
 * 键第一次出现且在额度内 → 分到自己的标签（**永远认自己**，不会时而被折叠时而不折叠）；
 * 超限 → 归入 `OTHER_LABEL`。
 *
 * 被折叠的键记进 `over`，只为回答「多少个**不同**的键被折叠了」；这本账自身也有界
 * （`MAX_DROPPED_TRACKING`），满了以后 `dropped` 是下界。
 */
export class KeyBudget {
  private readonly assigned = new Set<string>();
  private readonly over = new Set<string>();

  constructor(private readonly max: number) {}

  /** 取键的标签：额度内原样返回，超限返回 `OTHER_LABEL` */
  take(key: string): string {
    if (this.assigned.has(key)) return key;
    if (this.assigned.size < this.max) {
      this.assigned.add(key);
      return key;
    }
    if (this.over.size < MAX_DROPPED_TRACKING) this.over.add(key);
    return OTHER_LABEL;
  }

  /** 被折叠的**不同**键数（记满 `MAX_DROPPED_TRACKING` 后为下界） */
  get dropped(): number {
    return this.over.size;
  }

  /** 清空配额（`reset()` 用）—— 与 `capabilities` / `models` / `scores` 三张表同步清 */
  reset(): void {
    this.assigned.clear();
    this.over.clear();
  }
}

/**
 * 时长统计：环形窗口（算窗口内精确分位）+ 累积直方图（算可聚合的 bucket）。
 * run / 能力 / 模型共用同一个实现，保证三种粒度的口径与取整完全一致。
 */
export class DurationStat {
  private readonly ring: number[] = [];
  private cursor = 0;
  /** 每桶非累积计数：counts[i] 对应 le = bounds[i]；末位是 +Inf 桶 */
  private readonly counts: number[];
  private total = 0;
  private sum = 0;

  constructor(
    private readonly windowSize: number,
    private readonly bounds: readonly number[],
  ) {
    this.counts = new Array(bounds.length + 1).fill(0);
  }

  add(ms: number): void {
    this.total++;
    this.sum += ms;
    if (this.ring.length < this.windowSize) this.ring.push(ms);
    else {
      this.ring[this.cursor] = ms;
      this.cursor = (this.cursor + 1) % this.windowSize;
    }
    let i = 0;
    while (i < this.bounds.length && ms > this.bounds[i]!) i++;
    this.counts[i]!++;
  }

  get count(): number {
    return this.total;
  }

  get sumMs(): number {
    return this.sum;
  }

  get windowSamples(): number {
    return this.ring.length;
  }

  /**
   * 窗口内精确分位（Prometheus 的 quantile 语义：取第 ceil(q·n) 个样本）。
   * 算法单源在 `core/stats.ts` —— 与 `report.ts` 的时长 p50/p95 必须同口径，
   * 否则同一条 trace 在看板与报告里会有两个 p95。
   */
  percentile(q: number): number {
    if (this.ring.length === 0) return 0;
    const sorted = [...this.ring].sort((a, b) => a - b);
    return percentile(sorted, q);
  }

  /** 累积 bucket 计数（长度 = bounds+1，末位为 +Inf = count）—— Prometheus 文本语义 */
  cumulative(): number[] {
    const out: number[] = [];
    let running = 0;
    for (const c of this.counts) {
      running += c;
      out.push(running);
    }
    return out;
  }

  /** 每桶**非累积**计数 —— OTLP histogram 的 bucketCounts 语义（与 cumulative() 千万别混用） */
  perBucket(): number[] {
    return [...this.counts];
  }

  get boundsList(): readonly number[] {
    return this.bounds;
  }

  reset(): void {
    this.ring.length = 0;
    this.cursor = 0;
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
  }
}

/** 能力累加器：调用数 / 失败数 / 时长；skill·subagent 还带 token 与成本 */
export interface CapabilityAcc {
  calls: number;
  errors: number;
  stat: DurationStat;
  tokens: number | null;
  costUsd: number | null;
}

export interface ModelAcc {
  turns: number;
  tokens: number;
  costUsd: number;
  unpricedTurns: number;
  usageMissingTurns: number;
  stat: DurationStat;
}

/** run 时长：取根 span（`trace.rootSpanId`）的起止；根没收尾（如 sink 在失败路径拿到半截）时返回 undefined */
function runDurationMs(trace: Trace): number | undefined {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  if (!root || root.endedAt === undefined) return undefined;
  return root.endedAt - root.startedAt;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 评分键 → 指标标签。键有两种形态：**折叠桶**（`__other__`，整个键就是标签，不含 `\t`）
 * 与正常的 `name\tsource`（source 缺省为 ''）。两个出口（Prometheus 文本 / OTLP）共用一处
 * 解码 —— 各切各的必然有一处把折叠桶切成乱码。
 */
export function scoreLabels(key: string): { name: string; source: string } {
  if (key === OTHER_LABEL) return { name: OTHER_LABEL, source: '' };
  const tab = key.indexOf('\t');
  return { name: key.slice(0, tab), source: key.slice(tab + 1) };
}

/**
 * 进程内累加器：`metricsSink` 的全部可变状态（run / 能力 / 模型 / 评分四个维度 +
 * 三个基数配额）。渲染（`metrics-render.ts`）与 OTLP 导出（`metrics-otlp.ts`）只读它。
 */
export class MetricsState {
  runs = 0;
  failed = 0;
  costUsd = 0;
  readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  readonly runStat: DurationStat;
  // 私有背书字段：写只有 reset()（新窗口前移起点），外部一律经下面的 getter 只读
  private windowStart = Date.now();

  /**
   * **当前累计窗口的起点**（epoch 毫秒）—— OTLP 里所有数据点的 `startTimeUnixNano`。
   *
   * 它必须跟着 `reset()` 走：CUMULATIVE 指标的契约是「同一 startTime 下**单调不减**」。
   * `reset()` 清掉计数器却留着原起点，等于在同一时间区间里让 counter 倒退 —— 后端会算出
   * 负增量或直接丢样本（2026-09-21 外部复核实测：reset 后 2 → 1，起点没变）。
   * `reset()` 视为「开启新窗口」，所以起点推到 reset 那一刻。
   */
  get windowStartedAt(): number {
    return this.windowStart;
  }

  readonly capabilities = new Map<string, CapabilityAcc>();
  readonly models = new Map<string, ModelAcc>();
  /** 评分累加器：key = `${name}\t${source}`（source 缺省 ''；\t 不会出现在正常评分名里，做天然分隔符） */
  readonly scores = new Map<string, ScoreMetrics>();
  /**
   * exemplar 槽位（各一个，O(1)，无界风险为零）—— 「指标尖峰 → 那条 trace」的桥。
   * 失败是**覆盖式**（尖峰时要看的是最新的那条）；最慢是**破纪录才换**
   * （等值保留旧的：「最慢」是稳定锚点，不该被同速的新 run 顶来顶去）。
   */
  failedExemplar: RunExemplar | undefined;
  slowestExemplar: (RunExemplar & { durationMs: number }) | undefined;
  // 三个维度的键空间都封在这些配额里 —— 没有它们，三张 Map 与各自的时长窗口都是无界的
  readonly capBudget: KeyBudget;
  readonly modelBudget: KeyBudget;
  readonly scoreBudget: KeyBudget;
  /**
   * 归因标签维度（R8-P4）：combo 键（`k=v` 逗号连，值经转义）→ 累加器。
   * 与上面三个维度不同：这里**没有** per-combo 时长窗口（时长直方图 × 标签组合的内存
   * 是 cap × windowSize 的另一份乘法，收益不抵代价），只有四个计数。
   * ⚠️ 键是 `labelCombo()` 的产物：值里的 `,` / `=` / `\` 会被转义 —— 裸拼接会让
   * 两个不同的标签集拼出同一个键（2026-09-27 ref-menu-drift-signals 实测：`a="x,b=y",b="z"` 与
   * `a="x",b="y,b=z"` 撞成一个键 ⇒ 后者被并进前者的账、还按前者的标签渲染）。
   */
  readonly runLabels = new Map<string, RunLabelAcc>();
  /** 每个配置的 labelKey 一本基数配额（构造时按 labelKeys 建齐） */
  readonly labelBudgets = new Map<string, KeyBudget>();
  /**
   * combo 键空间的配额（R8-P4 补课，2026-09-27 ref-menu-drift-signals）：**组合数**才是真正的基数维度 ——
   * 每键一本配额只封住值域，combo 是叉乘（`(maxLabelValues+1)^labelKeys.length`），
   * 缺省 100 键域 + 3 键就是一百万条常驻条目，而 `droppedLabelValues` 一行都看不见它。
   */
  readonly comboBudget: KeyBudget;

  constructor(
    private readonly opts: {
      windowSize: number;
      maxCapabilities: number;
      maxModels: number;
      maxScores: number;
      labelMode: 'capability' | 'kind' | 'none';
      buckets: readonly number[];
      /** 归因标签键（已过 metrics.ts 的形状校验；空数组 = 维度整个关掉） */
      labelKeys: readonly string[];
      /** 每个 labelKey 的相异值上限（构造期已保证正数） */
      maxLabelValues: number;
      /** combo（标签组合）数上限（构造期已保证正数） */
      maxLabelCombos: number;
    },
  ) {
    this.runStat = new DurationStat(opts.windowSize, opts.buckets);
    this.capBudget = new KeyBudget(opts.maxCapabilities);
    this.modelBudget = new KeyBudget(opts.maxModels);
    this.scoreBudget = new KeyBudget(opts.maxScores);
    for (const key of opts.labelKeys) {
      this.labelBudgets.set(key, new KeyBudget(opts.maxLabelValues));
    }
    this.comboBudget = new KeyBudget(opts.maxLabelCombos);
  }

  private newCapability(): CapabilityAcc {
    return {
      calls: 0,
      errors: 0,
      stat: new DurationStat(this.opts.windowSize, this.opts.buckets),
      tokens: null,
      costUsd: null,
    };
  }

  /** 能力标签分配：labelMode 决定粒度，capBudget 决定基数上限 */
  private labelFor(kind: string, name: string): string | null {
    if (this.opts.labelMode === 'none') return null;
    if (this.opts.labelMode === 'kind') return kind;
    return this.capBudget.take(`${kind}:${name}`);
  }

  accumulate(trace: Trace): void {
    this.runs++;
    if (trace.status === 'error') {
      this.failed++;
      this.failedExemplar = { traceId: trace.traceId, spanId: trace.rootSpanId, at: Date.now() };
    }
    const u = trace.totalUsage;
    this.tokens.input += u.inputTokens;
    this.tokens.output += u.outputTokens;
    this.tokens.cacheRead += u.cacheReadTokens;
    this.tokens.cacheCreation += u.cacheCreationTokens;
    if (u.costEstimate != null) this.costUsd += u.costEstimate;

    const d = runDurationMs(trace);
    if (d !== undefined) {
      this.runStat.add(d);
      if (this.slowestExemplar === undefined || d > this.slowestExemplar.durationMs) {
        this.slowestExemplar = {
          traceId: trace.traceId,
          spanId: trace.rootSpanId,
          durationMs: d,
          at: Date.now(),
        };
      }
    }

    // —— 评分（R7）：只认根 span 的 score 事件（attachScore 的写入位置）；
    // body 宽容读取 —— name 不是 string / value 不是有限 number 就跳过，观测不击穿业务
    const rootSpan = trace.spans.find((s) => s.spanId === trace.rootSpanId);
    if (rootSpan) {
      for (const e of rootSpan.events) {
        if (e.name !== 'score') continue;
        const body = e.body as Record<string, unknown> | null;
        if (!body || typeof body !== 'object') continue;
        if (typeof body.name !== 'string') continue;
        if (typeof body.value !== 'number' || !Number.isFinite(body.value)) continue;
        const source = typeof body.source === 'string' ? body.source : '';
        const key = this.scoreBudget.take(`${body.name}\t${source}`);
        const acc = this.scores.get(key) ?? { value: 0, count: 0, sum: 0 };
        acc.value = body.value; // gauge 语义：覆盖为最近一次
        acc.count++;
        acc.sum += body.value;
        this.scores.set(key, acc);
      }
    }

    // —— 归因标签（R8-P4）：只在显式配置了 labelKeys 时记账。值从 run 根的
    // `labels.<key>` 属性读（loop.ts 写入），缺键/非字符串一律按 '' 计（观测宽容读取，
    // 不击穿业务）；每个值先过它那一键的 KeyBudget，超限折叠进 `__other__`。
    if (this.opts.labelKeys.length > 0 && rootSpan) {
      const perKey: [string, string][] = [];
      for (const key of this.opts.labelKeys) {
        const raw = rootSpan.attributes[`labels.${key}`];
        const value = typeof raw === 'string' ? raw : '';
        perKey.push([key, this.labelBudgets.get(key)!.take(value)]);
      }
      // combo 数上限（2026-09-27 ref-menu-drift-signals）：每键配额只封住值域，**组合数**是叉乘、才是真正的
      // 基数维度（缺省 100 值域 × 3 键 = 一百万）。超限后**新的**组合全折进一个桶，
      // 量照收、只丢标签粒度 —— 与另外三道上限同款，且折叠发生必须可见
      // （`snapshot().droppedLabelCombos` / `dropped_keys{kind="label:combos"}`）。
      const rawCombo = labelCombo(perKey);
      const kept = this.comboBudget.take(rawCombo);
      const pairs: [string, string][] =
        kept === rawCombo
          ? perKey
          : this.opts.labelKeys.map((key) => [key, OTHER_LABEL] as [string, string]);
      const combo = kept === rawCombo ? rawCombo : labelCombo(pairs);
      const acc = this.runLabels.get(combo) ?? { runs: 0, failed: 0, tokens: 0, costUsd: 0, pairs };
      acc.runs++;
      if (trace.status === 'error') acc.failed++;
      acc.tokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
      if (u.costEstimate != null) acc.costUsd += u.costEstimate;
      this.runLabels.set(combo, acc);
    }

    for (const span of trace.spans) {
      if (span.kind === 'capability') {
        const label = this.labelFor(capabilityKindOf(span), span.name);
        // 时长与错误无论哪种 labelMode 都要累计；labelMode:'none' 时整块跳过
        if (label !== null) {
          const acc = this.capabilities.get(label) ?? this.newCapability();
          acc.calls++;
          if (span.status === 'error') acc.errors++;
          if (span.endedAt !== undefined) acc.stat.add(Math.max(0, span.endedAt - span.startedAt));
          // capability.usage = 子孙 llm.turn 聚合（tracer 写入）；工具没有这个语义
          if (span.usage) {
            const sum =
              span.usage.inputTokens +
              span.usage.outputTokens +
              span.usage.cacheReadTokens +
              span.usage.cacheCreationTokens;
            acc.tokens = (acc.tokens ?? 0) + sum;
            if (span.usage.costEstimate != null)
              acc.costUsd = (acc.costUsd ?? 0) + span.usage.costEstimate;
          }
          this.capabilities.set(label, acc);
        }
        continue;
      }
      if (span.kind === 'llm.turn') {
        const model = this.modelBudget.take(span.name);
        const acc = this.models.get(model) ?? {
          turns: 0,
          tokens: 0,
          costUsd: 0,
          unpricedTurns: 0,
          usageMissingTurns: 0,
          stat: new DurationStat(this.opts.windowSize, this.opts.buckets),
        };
        acc.turns++;
        if (span.usage) {
          acc.tokens +=
            span.usage.inputTokens +
            span.usage.outputTokens +
            span.usage.cacheReadTokens +
            span.usage.cacheCreationTokens;
          if (span.usage.costEstimate != null) acc.costUsd += span.usage.costEstimate;
          else acc.unpricedTurns++; // 有计量却算不出成本 = 模型不在价格表内
        }
        if (span.endedAt !== undefined) acc.stat.add(Math.max(0, span.endedAt - span.startedAt));
        this.models.set(model, acc);
        // 普通工具的耗时/成败在 turn 的 tool.output 事件上（E1）—— 能力指标的另一路数据源
        for (const e of span.events) {
          // 上游没报计量的回合（S2）：与 unpriced **分开数** —— 那个是「模型没定价」，
          // 这个是「上游没给读数」，排障方向不同
          if (e.name === USAGE_MISSING_EVENT) acc.usageMissingTurns++;
          if (e.name !== TOOL_OUTPUT_EVENT) continue;
          const body = e.body as Record<string, unknown> | null;
          if (!body || typeof body !== 'object' || typeof body.tool !== 'string') continue;
          const label = this.labelFor('tool', body.tool);
          if (label === null) continue;
          const tacc = this.capabilities.get(label) ?? this.newCapability();
          tacc.calls++;
          if (body.ok === false) tacc.errors++;
          tacc.stat.add(Math.max(0, num(body.durationMs)));
          this.capabilities.set(label, tacc);
        }
      }
    }
  }

  snapshot(): MetricsSnapshot {
    const capabilityOut: Record<string, CapabilityMetrics> = {};
    if (this.opts.labelMode !== 'none') {
      for (const [label, acc] of this.capabilities) {
        capabilityOut[label] = {
          calls: acc.calls,
          errors: acc.errors,
          latencyP50: acc.stat.percentile(0.5),
          latencyP95: acc.stat.percentile(0.95),
          tokens: acc.tokens,
          costUsd: acc.costUsd,
        };
      }
    }
    const modelOut: Record<string, ModelMetrics> = {};
    for (const [model, acc] of this.models) {
      modelOut[model] = {
        turns: acc.turns,
        tokens: acc.tokens,
        costUsd: acc.costUsd,
        unpricedTurns: acc.unpricedTurns,
        usageMissingTurns: acc.usageMissingTurns,
        latencyP50: acc.stat.percentile(0.5),
        latencyP95: acc.stat.percentile(0.95),
      };
    }
    const scoreOut: Record<string, ScoreMetrics> = {};
    for (const [key, acc] of this.scores) {
      // 折叠桶没有 `name@source` 可黏（也不该有），原样以 `__other__` 出
      if (key === OTHER_LABEL) {
        scoreOut[OTHER_LABEL] = { ...acc };
        continue;
      }
      const { name, source } = scoreLabels(key);
      scoreOut[source === '' ? name : `${name}@${source}`] = { ...acc };
    }
    const runLabelOut: Record<string, RunLabelMetrics> = {};
    for (const [combo, acc] of this.runLabels) {
      runLabelOut[combo] = {
        runs: acc.runs,
        failed: acc.failed,
        tokens: acc.tokens,
        costUsd: acc.costUsd,
      };
    }
    const droppedLabelValues: Record<string, number> = {};
    for (const key of this.opts.labelKeys) {
      droppedLabelValues[key] = this.labelBudgets.get(key)!.dropped;
    }
    return {
      runs: this.runs,
      failed: this.failed,
      latencyP50: this.runStat.percentile(0.5),
      latencyP95: this.runStat.percentile(0.95),
      tokens:
        this.tokens.input + this.tokens.output + this.tokens.cacheRead + this.tokens.cacheCreation,
      costUsd: this.costUsd,
      capabilities: capabilityOut,
      models: modelOut,
      scores: scoreOut,
      runLabels: runLabelOut,
      droppedLabelValues,
      droppedLabelCombos: this.comboBudget.dropped,
      droppedCapabilities: this.capBudget.dropped,
      droppedModels: this.modelBudget.dropped,
      droppedScores: this.scoreBudget.dropped,
      exemplars: {
        failed: this.failedExemplar
          ? { traceId: this.failedExemplar.traceId, at: this.failedExemplar.at }
          : undefined,
        slowest: this.slowestExemplar
          ? {
              traceId: this.slowestExemplar.traceId,
              durationMs: this.slowestExemplar.durationMs,
              at: this.slowestExemplar.at,
            }
          : undefined,
      },
    };
  }

  reset(): void {
    // 新窗口：计数清零**且起点前移** —— 只清零会让 CUMULATIVE 指标在同一 startTime 下倒退。
    // 用 max(now, 上一个起点 + 1) 而不是裸 Date.now()：同一毫秒内连按两次 reset 时，
    // 起点必须**严格**前进，否则两次新窗口共用一个 startTime，后端看到的仍是倒退。
    this.windowStart = Math.max(Date.now(), this.windowStart + 1);
    this.runs = 0;
    this.failed = 0;
    this.costUsd = 0;
    this.tokens.input = 0;
    this.tokens.output = 0;
    this.tokens.cacheRead = 0;
    this.tokens.cacheCreation = 0;
    this.runStat.reset();
    this.failedExemplar = undefined;
    this.slowestExemplar = undefined;
    this.capabilities.clear();
    this.models.clear();
    this.scores.clear();
    this.runLabels.clear();
    this.capBudget.reset();
    this.modelBudget.reset();
    this.scoreBudget.reset();
    for (const budget of this.labelBudgets.values()) budget.reset();
    this.comboBudget.reset();
  }
}
