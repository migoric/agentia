import type { Trace, TraceSink } from '../core/trace.js';
import { zeroClauseOf } from '../core/limits.js';
import { MetricsState } from './metrics-state.js';
import type { MetricsSnapshot } from './metrics-state.js';
import { renderOpenMetrics, renderPrometheus } from './metrics-render.js';
import { flushOtlpMetrics } from './metrics-otlp.js';

// 结构拆分（2026-09-20）：累加/快照在 `metrics-state.ts`（MetricsState），
// 文本渲染在 `metrics-render.ts`（renderPrometheus / renderOpenMetrics），
// OTLP 组装与导出在 `metrics-otlp.ts`（buildOtlpPayload / flushOtlpMetrics / MetricsExportError）。
// 均为同层 module 级 export，不进公共面；本文件只留选项校验、定时器与组装。
export type {
  CapabilityMetrics,
  ExemplarSnapshot,
  ModelMetrics,
  ScoreMetrics,
  RunLabelMetrics,
  MetricsSnapshot,
} from './metrics-state.js';
export { MetricsExportError } from './metrics-otlp.js';

/**
 * Agentia —— 指标（D3 → 可观测下沉 E2/E3/E4/E5）。
 *
 * `MetricsSink` **天然满足** `TraceSink` → `createApp({ sinks: [metricsSink()] })` 即接入，
 * **零新出口**（与 `createOtlpExporter` 同款）。全部数值从 `Trace` 派生，宿主不需要
 * 在业务代码里埋点。
 *
 * 三个维度（都是**进程内累加**，不是分布式聚合）：
 * - **run 级**：总数 / 失败数 / token 四类 / 成本 / 时长；
 * - **能力级**（E2）：`tool` 来自 turn 上的 `tool.output` 事件（E1 补的 `durationMs`/`ok`），
 *   `skill` / `subagent` 来自 `capability` span（tracer 已把子孙 llm.turn 的 usage 聚合上去）；
 *   `@Prompt` 不建 span、无独立耗时，**不产出**能力指标（如实缺省，不硬凑）；
 * - **模型级**（E3）：来自 `llm.turn` span（其 `name` 即模型 id）。
 * - **评分级**（R7 质量闭环）：来自 run 根 span 的 `score` 事件（`attachScore` 写入）——
 *   gauge 记**最近一次**值（分数不是累加量），counter 记条数；label 为 `name` × `source`。
 *
 * 时长同时给两种口径（histogram 与分位 gauge 必须用**不同指标名**，见 `render()` 注释）：
 * - **histogram**（`*_bucket` / `*_sum` / `*_count`，累积语义）—— 抓取端可跨实例任意聚合；
 * - **窗口内精确分位**（`*_last{quantile=...}` gauge）—— 单实例排障时更好读。
 *
 * **exemplars**（指标 → trace 的桥）：记账时跟踪两个槽位 —— 失败 counter 挂「最近一次失败
 * run」、run 时长 histogram 挂「迄今最慢的一次 run」（口径见 `MetricsSnapshot.exemplars`）。
 * 出口：`'openmetrics'` 文本模式（样本行尾 `# {trace_id=…}`）与 OTLP（数据点原生
 * exemplars 字段）；缺省 `'prometheus'` 文本**不支持** exemplar，输出不含它。
 *
 * 零依赖：Prometheus/OpenMetrics 文本与 OTLP/JSON 都手写（纯文本 / JSON，不值得为此引客户端库）。
 */

export interface MetricsSinkOptions {
  /**
   * 输出形态：
   * - `'prometheus'`（缺省）—— `render()` 出 Prometheus 文本，宿主挂到 `GET /metrics`；
   * - `'openmetrics'` —— 同为拉取式，但 `render()` 出 **OpenMetrics 文本**（样本行尾挂
   *   exemplar `# {trace_id="…"}`、文件以 `# EOF` 收尾）—— 「指标尖峰 → 那条 trace」的桥。
   *   宿主需以 `application/openmetrics-text` 提供该端点（Prometheus 按 0.0.4 抓取会丢掉 exemplar）；
   * - `'otlp'` —— 用全局 `fetch` POST 到 `${endpoint}/v1/metrics`（OTLP/JSON，零依赖；
   *   exemplar 是 OTLP 的原生字段，随数据点一并发出）。
   *   必须给 `endpoint`（不给就构造期抛错，比"静默不导出"好）。
   */
  export?: 'prometheus' | 'openmetrics' | 'otlp';
  /** `export:'otlp'` 的采集端基地址，例如 http://localhost:4318（尾部斜杠会被去掉） */
  endpoint?: string;
  /**
   * `export:'otlp'` 的导出间隔（毫秒），缺省 60000。
   * `0` = 每次 `export(trace)` 后立即导出（由框架 await，会拖慢收尾，仅测试/低流量用）。
   * 定时器已 `unref()`，不会阻止进程退出。
   */
  intervalMs?: number;
  /** `export:'otlp'` 的 resource 属性（除自动加的 `service.name`） */
  resourceAttributes?: Record<string, string>;
  /** `export:'otlp'` 的 service.name，缺省 'agentia' */
  serviceName?: string;
  /**
   * 单次导出请求超时（毫秒），缺省 10000；非正数 = 不限。
   * 裸 fetch 没有超时：collector 半开连接（accept 后永不回包）会让 `intervalMs:0` 模式
   * 的 run 收尾永久挂起。超时按导出失败处理（交 onExportError）——观测失败不击穿业务。
   */
  timeoutMs?: number;
  /** 导出失败回调（缺省每次失败落一条 console.warn —— 与 traces 侧 flushSinks 同款；失败不抛出，观测不得击穿业务） */
  onExportError?: (err: unknown) => void;
  /**
   * 时长分位保留的样本数（环形窗口，缺省 1024，**run / 能力 / 模型各自独立**）。
   * 分位是**窗口内精确值**而非全历史近似 —— 长跑宿主不会被无界数组拖住内存，
   * 代价是分位只反映最近这么多条样本（这也是监控想要的）。
   *
   * 注意：每个能力/模型各持一个窗口，所以 windowSize 只是**系数**；真正封住内存的是
   * 三个基数上限（`maxCapabilities` / `maxModels` / `maxScores`）—— 上限 **×** 窗口
   * 才是常驻内存的上界，缺一个都是无界（见 `maxModels` 的注释）。
   */
  windowSize?: number;
  /** 指标名前缀，缺省 `agentia_` */
  prefix?: string;
  /**
   * 能力标签粒度（E2）：
   * - `'capability'`（缺省）—— 按 `kind:name`（如 `tool:search`）；
   * - `'kind'` —— 只按类型（`tool` / `skill` / `subagent`），基数极小；
   * - `'none'` —— 完全不产出能力指标。
   */
  labelMode?: 'capability' | 'kind' | 'none';
  /**
   * 能力标签基数上限（缺省 200，仅 `labelMode:'capability'` 生效）。
   * 超出后新能力归入 `capability="__other__"` —— 用户可定义任意多工具，裸打标签会打爆 Prometheus。
   */
  maxCapabilities?: number;
  /**
   * 模型维度基数上限（缺省 50）。超出后新模型归入 `"__other__"`
   * —— `model` 是 per-run 可覆盖的（`app.run(m, { model })`），
   * 上游把版本号/日期拼进模型 id（`claude-x-20260101`）时键会无界增长；
   * 而每个模型键都持一个 `windowSize` 环形窗口 + 一个直方图 → **无上限 = 无界内存**。
   *
   * 折叠**只丢标签粒度，不丢量**：`__other__` 桶照常累加 turn / token / 成本，
   * `snapshot().models` 的总量仍然对得上。被折叠的不同模型数见 `snapshot().droppedModels`。
   */
  maxModels?: number;
  /**
   * 评分维度基数上限（缺省 200）。评分键是 `name@source`（`attachScore` 的 name × source），
   * eval 名若由调用方拼出来（带时间戳/用例名）同样是无界键 → 同上折叠进 `"__other__"`。
   * 折叠后 gauge 语义（最近一次值）保留，只是不再区分是哪个评分维度；
   * 条数 / 总和照常累加，被折叠的不同评分维度数见 `snapshot().droppedScores`。
   */
  maxScores?: number;
  /**
   * 归因标签维度（R8-P4）：**显式点名** run 根 `labels.<key>` 里的哪些键上指标标签，
   * 缺省 `[]`（一个都不上 —— run 根属性照样记，只是不进指标）。
   * 键必须是合法的 Prometheus 标签名（`/^[a-zA-Z_][a-zA-Z0-9_]*$/`），否则构造期抛错。
   *
   * 出口形态：`runs_total` / `runs_failed_total` / `tokens_total` / `cost_usd_total`
   * 四个家族在全局样本之外**追加**带标签的样本（如 `runs_total{tenant="acme"}`）——
   * 全局样本仍在（不带标签的那行就是总量）。⚠️ 查询侧注意：开了 labelKeys 后
   * `sum(agentia_runs_total)` 会把全局行与分行**重复计数**，总量用不带标签的序列。
   *
   * ⚠️ 每个键的相异**值**数受 `maxLabelValues` 封顶，超出归入 `__other__`（折叠只丢
   * 标签粒度不丢量，与 maxModels 同款）。光 opt-in 挡不住「我知道有几千租户、
   * 我偏要上」—— sink 的内存不变量（上限 × 窗口 = 常驻内存上界）要求每个新基数
   * 维度都有 cap，所以这道上限不可关。
   */
  labelKeys?: readonly string[];
  /**
   * 每个 labelKey 的相异值数上限（缺省 100，**必须为正数**）。
   * 超出后新值归入 `__other__`；被折叠的不同值数见 `snapshot().droppedLabelValues`。
   */
  maxLabelValues?: number;
  /**
   * **标签组合数**上限（缺省 200，**必须为正数**）。
   *
   * 为什么需要它：`maxLabelValues` 封的是**每个键的值域**，而进内存的是键的组合 ——
   * 组合数是叉乘（`(maxLabelValues+1)^labelKeys.length`），缺省值域 100 配 3 个键就是
   * 一百万条常驻条目，且 `droppedLabelValues` 只报每键的折叠数、看不出组合已经爆了
   * （2026-09-27 ⑧ 实测的静默失效）。这道上限与 `maxCapabilities` / `maxModels` /
   * `maxScores` 同款：超限后**新的组合**折叠进一个全 `__other__` 的桶（量照收，只丢
   * 标签粒度），被折叠的组合数见 `snapshot().droppedLabelCombos` 与
   * `agentia_dropped_keys{kind="label:combos"}`。**不可关** —— 内存不变量要求每个新
   * 基数维度都有 cap，opt-in 挡不住「明知有几千租户偏要上」。
   *
   * 单键配置（最常见）下组合数 ≈ 值数，这道上限不改变行为。
   */
  maxLabelCombos?: number;
  /** 时长直方图的桶边界（毫秒，升序）；缺省见 DEFAULT_BUCKETS */
  buckets?: readonly number[];
}

export interface MetricsSink extends TraceSink {
  snapshot(): MetricsSnapshot;
  /**
   * 文本格式渲染（零依赖手写）：`export:'prometheus'`（缺省）出 `text/plain; version=0.0.4`，
   * `export:'openmetrics'` 出 OpenMetrics 文本（带 exemplar、以 `# EOF` 收尾）。
   * 宿主端点直接读 `contentType` 当响应头即可（框架内置的 `/metrics` 路由就是这么做的）。
   */
  render(): string;
  /**
   * `render()` 产物的 Content-Type（随 `export` 模式走）：内置 `/metrics` 路由读它发响应头，
   * 自己挂端点时也该读它而不是写死 —— 0.0.4 与 OpenMetrics 不是可互换的两种写法，
   * 拿 0.0.4 的头去发带 exemplar 的文本，严格的抓取端会解析失败。
   * （可选是为了向后兼容手写的 MetricsSink 实现；本工厂返回的一定带。）
   */
  readonly contentType?: string;
  /** 主动导出一次（`export:'otlp'` 时有意义；prometheus/openmetrics 拉取式为空操作）。失败按 onExportError 处理 */
  flush(): Promise<void>;
  /** 停掉定时导出（进程收尾 / 测试用） */
  stop(): void;
  /** 清空累计（测试 / 多租户轮换用） */
  reset(): void;
}

const DEFAULT_WINDOW = 1024;
const DEFAULT_MAX_CAPABILITIES = 200;
/** 模型 id 实际就那么几个，默认给 50 已经很宽（够覆盖多版本并存的灰度期） */
const DEFAULT_MAX_MODELS = 50;
/** 评分维度 = `name@source`，一个应用的 eval 个数是有限的，默认与能力同宽 */
const DEFAULT_MAX_SCORES = 200;
/**
 * 归因标签每个键的相异值上限缺省 100（R8-P4）：比模型键宽（租户天然比模型多），
 * 又足够小 —— 真有几千租户的部署应该靠 `__other__` 折叠 + droppedLabelValues 报警发现，
 * 而不是把 Prometheus 与 sink 内存一起打爆
 */
const DEFAULT_MAX_LABEL_VALUES = 100;
/**
 * 标签**组合数**缺省上限。取 200 而不是与 `maxLabelValues` 同值（100）：单键配置下
 * 组合数 ≈ 值数（100 < 200，行为不变），多键配置才是它的用武之地 —— 上限是
 * 「上限 × 窗口 = 常驻内存」这条不变量里缺的那一角，宁可给够正常用量也不要紧到误折。
 */
const DEFAULT_MAX_LABEL_COMBOS = 200;
/** Prometheus 标签名的合法形状（labelKeys 的构造期校验按它） */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** 缺省时长桶（毫秒）：覆盖"工具几十毫秒 → run 几十秒"的常见区间 */
export const DEFAULT_BUCKETS: readonly number[] = [
  25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
];

export function metricsSink(opts: MetricsSinkOptions = {}): MetricsSink {
  const format = opts.export ?? 'prometheus';
  if (format !== 'prometheus' && format !== 'openmetrics' && format !== 'otlp') {
    throw new Error(
      `metricsSink: export 只支持 'prometheus' | 'openmetrics' | 'otlp'，收到 ${String(format)}`,
    );
  }
  const otlpEndpoint = opts.endpoint?.replace(/\/+$/, '');
  if (format === 'otlp' && !otlpEndpoint) {
    throw new Error(`metricsSink: export:'otlp' 必须给 endpoint（如 http://localhost:4318）`);
  }
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW;
  if (!(windowSize > 0)) {
    throw new Error(
      `metricsSink: windowSize 必须为正数（${zeroClauseOf('metricsSink.windowSize')}），收到 ${opts.windowSize}`,
    );
  }
  const maxCapabilities = opts.maxCapabilities ?? DEFAULT_MAX_CAPABILITIES;
  if (!(maxCapabilities > 0)) {
    throw new Error(
      `metricsSink: maxCapabilities 必须为正数（${zeroClauseOf('metricsSink.maxCapabilities')}），收到 ${opts.maxCapabilities}`,
    );
  }
  const maxModels = opts.maxModels ?? DEFAULT_MAX_MODELS;
  if (!(maxModels > 0)) {
    throw new Error(
      `metricsSink: maxModels 必须为正数（${zeroClauseOf('metricsSink.maxModels')}），收到 ${opts.maxModels}`,
    );
  }
  const maxScores = opts.maxScores ?? DEFAULT_MAX_SCORES;
  if (!(maxScores > 0)) {
    throw new Error(
      `metricsSink: maxScores 必须为正数（${zeroClauseOf('metricsSink.maxScores')}），收到 ${opts.maxScores}`,
    );
  }
  const maxLabelValues = opts.maxLabelValues ?? DEFAULT_MAX_LABEL_VALUES;
  if (!(maxLabelValues > 0)) {
    throw new Error(
      `metricsSink: maxLabelValues 必须为正数（${zeroClauseOf('metricsSink.maxLabelValues')}），收到 ${opts.maxLabelValues}`,
    );
  }
  const maxLabelCombos = opts.maxLabelCombos ?? DEFAULT_MAX_LABEL_COMBOS;
  if (!(maxLabelCombos > 0)) {
    throw new Error(
      `metricsSink: maxLabelCombos 必须为正数（${zeroClauseOf('metricsSink.maxLabelCombos')}），收到 ${opts.maxLabelCombos}`,
    );
  }
  const labelKeys: string[] = [];
  for (const k of opts.labelKeys ?? []) {
    if (typeof k !== 'string' || !LABEL_NAME_RE.test(k)) {
      throw new Error(
        `metricsSink: labelKeys 必须是合法的 Prometheus 标签名（/^[a-zA-Z_][a-zA-Z0-9_]*$/），收到 ${JSON.stringify(k)}`,
      );
    }
    if (labelKeys.includes(k)) {
      throw new Error(`metricsSink: labelKeys 有重复的键 ${JSON.stringify(k)}`);
    }
    labelKeys.push(k);
  }
  const labelMode = opts.labelMode ?? 'capability';
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]! <= buckets[i - 1]!) {
      throw new Error(`metricsSink: buckets 必须严格升序，收到 [${buckets.join(', ')}]`);
    }
  }
  const p = opts.prefix ?? 'agentia_';
  const intervalMs = opts.intervalMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const serviceName = opts.serviceName ?? 'agentia';

  const state = new MetricsState({
    windowSize,
    maxCapabilities,
    maxModels,
    maxScores,
    labelMode,
    buckets,
    labelKeys,
    maxLabelValues,
    maxLabelCombos,
  });

  const snapshot = (): MetricsSnapshot => state.snapshot();

  const render = (): string =>
    format === 'openmetrics' ? renderOpenMetrics(state, p) : renderPrometheus(state, p);

  const flush = async (): Promise<void> => {
    if (format !== 'otlp') return; // prometheus 模式：拉取式，无主动导出
    await flushOtlpMetrics(state, {
      prefix: p,
      serviceName,
      // 数据点的 startTimeUnixNano 取**当前累计窗口**的起点（不是 sink 创建时刻的常量）：
      // reset() 会前移窗口起点，这里必须跟着走，否则 CUMULATIVE 指标会在同一区间倒退。
      startedAtMs: state.windowStartedAt,
      // 构造期校验保证 otlp 模式下 endpoint 必填
      endpoint: otlpEndpoint!,
      timeoutMs,
      // exactOptionalPropertyTypes：可选字段不能赋 undefined，只能条件展开
      ...(opts.resourceAttributes !== undefined
        ? { resourceAttributes: opts.resourceAttributes }
        : {}),
      ...(opts.onExportError !== undefined ? { onExportError: opts.onExportError } : {}),
    });
  };

  const timer =
    format === 'otlp' && intervalMs > 0
      ? setInterval(() => {
          void flush();
        }, intervalMs)
      : undefined;
  // 定时导出不该把进程吊住
  timer?.unref?.();

  return {
    export(trace: Trace): void | Promise<void> {
      state.accumulate(trace);
      // intervalMs=0：立即导出并由框架 await；否则只累加，定时器负责导出
      if (format === 'otlp' && intervalMs === 0) return flush();
      return undefined;
    },

    snapshot,
    render,
    // 与 render() 同源：0.0.4 与 OpenMetrics 不可互换（后者带 exemplar、以 # EOF 收尾），
    // 内置 /metrics 路由与本对象自带的 contentType 必须永远一致 ⇒ 只在这里写一次。
    contentType:
      format === 'openmetrics'
        ? 'application/openmetrics-text; version=1.0.0; charset=utf-8'
        : 'text/plain; version=0.0.4; charset=utf-8',
    flush,

    stop(): void {
      if (timer) clearInterval(timer);
    },

    reset(): void {
      state.reset();
    },
  };
}
