import { randomUUID } from 'node:crypto';
import type {
  Span,
  SpanError,
  SpanId,
  SpanKind,
  SpanLink,
  SpanStatus,
  Trace,
  TraceId,
  TraceRecordEvent,
  TraceRecordEventPayload,
  Usage,
} from '../core/trace.js';
import { zeroClauseOf } from '../core/limits.js';

/**
 * 记账的**数量上限**（spec §9.4 的答案里「让少记了数据可数」那一半）。
 *
 * 只有 `maxEvents` 一个旋钮，而且它管的是**整条 trace 的记录事件数**
 * （`tool.input` / `tool.output` / `score` / … 都算，截断簿记那两笔不算）
 * —— 因为成本就是整条 trace 的量。
 * 与 `maxEventChars`（**单个事件正文长度**）是两个正交的旋钮，各有各的家：
 * 一个管「多长」，一个管「多少」；两个都「不设 = 不限」。
 *
 * 超限后：**停止记账**（记录事件不再进 trace），并在 run 根上留**两笔**同名 `trace.truncated`
 * 簿记 —— 按 body 区分（两笔都同时出现在交付的 trace 与增量流里，见下）：
 * - **起点标记** `{ limit }`：第一笔丢弃那一刻写下，标「从这里起有缺」（位置信号）；
 * - **收尾摘要** `{ droppedEvents, limit }`：`snapshot()` 交付时才写得出的最终计数。
 * 缺口位置可预测（尾巴），且有计数 ⇒ 可解释。
 *
 * ⚠️ 两笔都**必须**进 `span.events`（而不是只派给增量订阅者）：`core/trace.ts` 那条
 * **折叠规则**（按 `seq` 折回逐字等于 `snapshot()`）是钉住的契约，只在一条缝上出现的事件
 * 会让它在「设了上限且真截断」的 run 上变成假话。纯 `onTraceEvent` 的消费者因此也不再
 * 面对一个静默的洞（2026-09-28 外部深评 P3-1；落点由 PR #164 复核 §4 定为「两缝同源」）。
 *
 * 刻意**不做**环形缓冲（丢最旧、留最近）：那会让 trace 中间出现空洞，
 * 而空洞比「尾巴截断」难解释得多（「这一回合怎么没有工具事件」）。
 */
export interface TraceLimits {
  /**
   * **记录事件**的条数上限；`0` = 一条都不记（有意义的值，仍有计数）；不设 = 不限。
   * ⚠️ 这个计数**不含**上面那两笔 `trace.truncated` 簿记（它们是「关于记账」的簿记，不是被
   * 记录的事实）⇒ 真截断时这条 trace 的事件数最多 `maxEvents + 2`。
   */
  maxEvents?: number;
}

/**
 * 解析并校验 `traceLimits.maxEvents` —— **构造期**（run 入口）响亮失败。
 *
 * 坏值不静默的理由与 `integrations/adapter-options.ts` 的 `resolveMaxRetries` 同款：
 * `NaN` / 负数 / 小数会让「记多少条」变成猜的（`>=` 对 NaN 恒假 ⇒ 上限**根本不生效**，
 * 而使用者以为自己设了闸），这类「设了但没生效」正是本仓在收的债。
 */
export function resolveTraceLimits(raw: unknown, owner: string): TraceLimits | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(
      `${owner}：traceLimits 必须是对象（如 { maxEvents: 500 }），收到 ${String(raw)}`,
    );
  }
  const maxEvents = (raw as { maxEvents?: unknown }).maxEvents;
  if (maxEvents === undefined) return {};
  if (typeof maxEvents !== 'number' || !Number.isSafeInteger(maxEvents) || maxEvents < 0) {
    throw new TypeError(
      `${owner}：traceLimits.maxEvents 必须是非负安全整数（${zeroClauseOf('traceLimits.maxEvents')}），收到 ${String(maxEvents)} —— ` +
        'NaN / Infinity / 负数 / 小数都会让「记多少条」变成猜的',
    );
  }
  return { maxEvents };
}

/** TraceRecorder 的构造选项（`maxEvents` 来自 `TraceLimits`） */
export interface TraceRecorderOptions {
  /** 事件总数上限；不设 = 不限。见 `TraceLimits` */
  maxEvents?: number;
}

/**
 * 内存 TraceRecorder —— v1 实现（spec §9.3）。
 * 显式传 parentSpanId 而非内部栈，保证并行工具调用时父子关系准确。
 * 一次 run 一个 recorder；run 与 trace 1:1。
 */
export class TraceRecorder {
  readonly traceId: TraceId = randomUUID();
  private readonly spans: Span[] = [];
  private readonly index = new Map<SpanId, Span>();
  /** parentSpanId → 直接子 span（增量维护，供 capability 结束时就地聚合子孙 usage，O(子孙) 而非每次重建） */
  private readonly children = new Map<SpanId | null, Span[]>();
  private rootSpanId: SpanId | null = null;
  /** 事件总量闸（`traceLimits.maxEvents`）；undefined = 不限 */
  private readonly maxEvents: number | undefined;
  /** 已入 trace 的事件数（受 `maxEvents` 约束的那个计数） */
  private recordedEvents = 0;
  /** 因超限被丢弃的事件数（交付时写进 run 根的 `trace.truncated`） */
  private droppedEvents = 0;
  /**
   * 截断收尾摘要（`trace.truncated { droppedEvents, limit }`），**只生成一次**。
   *
   * 它是「交付时才写得出的结论」，由 `snapshot()` 首次调用时生成：同一个对象既进
   * `span.events`（此后每次 snapshot 都带它）、也走增量出口（见 snapshot 的注释）。
   * ⚠️ 不可每次调用都新建 —— 那样摘要的 `time` 每次不同，增量流里的那一条与
   * 任何一次 snapshot 都对不上（`core/trace.ts` 的折叠契约当场变假），且多次
   * snapshot 彼此也不一致。
   */
  private truncationSummary: {
    time: number;
    name: 'trace.truncated';
    body: { droppedEvents: number; limit: number | undefined };
  } | null = null;
  /** 记账事件订阅者（增量出口，见 `core/trace.ts` 的 `TraceRecordEvent`） */
  private readonly listeners: Array<(e: TraceRecordEvent) => void> = [];
  /**
   * 记账事件序号。**每次记账动作都自增，与当时有没有订阅者无关** —— 这样「订阅早」与
   * 「订阅晚」看到的同一个事件拿到同一个 `seq`（SSE 的 `Last-Event-ID` 重放靠它）。
   * 只增一个数字，不算成本。
   */
  private seq = 0;

  constructor(opts: TraceRecorderOptions = {}) {
    this.maxEvents = opts.maxEvents;
  }

  /**
   * 订阅记账事件（增量出口）；返回退订函数。
   *
   * 与 `TraceSink` 是**两条缝**：sink 收尾拿整棵，这里 run 进行中就逐笔拿。
   * 纪律：**同步派发**（不 await —— 订阅者是观察者，不该把 run 变成它的调度）、
   * 订阅者抛错**被吞**（观测失败不击穿业务，与 `flushSinks` 同款）、
   * 无订阅者时**不派发**（「不订阅不付钱」）。
   *
   * 注意「不付钱」保的是**不派发**，不是零分配：`begin` / `end` / `event` /
   * `setAttribute` / `addLink` 在调 `emit` **之前**就各自构造了载荷字面量
   * （`begin` 那份还含一次 span 浅拷）；零分配只在 `emit` 内部的
   * `listeners.length === 0` 短路之后成立。不把构造挪进 emit（载荷改 thunk）
   * 的原因：thunk 闭包本身也是每次记账一次分配，省不掉，只是换了形态。
   */
  subscribe(listener: (e: TraceRecordEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * 派发一条记账事件。
   *
   * ⚠️ 顺序要紧：**先自增 `seq` 再判有没有订阅者** —— 若在无订阅者时不计数，
   * 「订阅晚的人」看到的序号就会与「一直订阅的人」不一致（重放与去重都会错位）。
   */
  private emit(payload: TraceRecordEventPayload): void {
    const seq = ++this.seq;
    if (this.listeners.length === 0) return;
    const event = { ...payload, seq } as TraceRecordEvent;
    // 先拷一份订阅者列表：允许订阅者在回调里退订/新增（否则会漏发或边遍历边改）
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* 观测不击穿业务（与 flushSinks 同款） */
      }
    }
  }

  begin(kind: SpanKind, name: string, parentSpanId: SpanId | null): SpanId {
    if (kind === 'run') {
      if (this.rootSpanId) throw new Error('run root already started');
      this.rootSpanId = randomUUID();
    }
    const id = kind === 'run' ? this.rootSpanId! : randomUUID();
    const span: Span = {
      spanId: id,
      traceId: this.traceId,
      parentSpanId,
      kind,
      name,
      status: 'ok',
      startedAt: Date.now(),
      attributes: {},
      events: [],
    };
    this.spans.push(span);
    this.index.set(id, span);
    const siblings = this.children.get(parentSpanId);
    if (siblings) siblings.push(span);
    else this.children.set(parentSpanId, [span]);
    // 此刻的拷贝（空 attributes/events）—— 之后的属性/事件各走自己的事件类型，
    // 订阅者拿到的对象此后不再变异（与 snapshot 同纪律）
    this.emit({ type: 'span.begin', span: { ...span, attributes: {}, events: [] } });
    return id;
  }

  get rootStarted(): boolean {
    return this.rootSpanId !== null;
  }

  /**
   * 结束 span。容错策略：未知 span id 抛错（程序员错误要响亮）；
   * 对已结束的 span 幂等忽略（重复 end 视为无害）。event/setAttribute 对未知
   * span 静默忽略 —— 观测不应中断业务，与 end 的严格性刻意区分。
   *
   * `capability` span 收尾时若调用方**未**显式给 usage，就地聚合其**子孙 llm.turn** 的
   * usage 写回该 span —— 兑现 `core/trace.ts` 里「capability.usage = 其子孙聚合，仅供展示」
   * 的已声明语义（此前该字段从不写入，指标/报告拿不到「某个子 agent 花了多少」）。
   * 只累加 llm.turn，故层层嵌套也不会重复计数。
   */
  end(id: SpanId, patch: { status?: SpanStatus; error?: SpanError; usage?: Usage } = {}): void {
    const span = this.index.get(id);
    if (!span) throw new Error(`span not found: ${id}`);
    if (span.endedAt !== undefined) return; // 幂等：重复 end 忽略
    span.endedAt = Date.now();
    if (patch.status) span.status = patch.status;
    if (patch.error) span.error = patch.error;
    if (patch.usage) span.usage = patch.usage;
    else if (span.kind === 'capability') {
      const aggregated = this.aggregateDescendantUsage(id);
      if (aggregated) span.usage = aggregated;
    }
    // 增量出口：收尾字段以**增量**形态派出（不带 attributes/events —— 那些各走自己的事件），
    // 且取的是**聚合之后**的最终值（capability 的 usage 在此刻才算得出来）
    this.emit({
      type: 'span.end',
      spanId: id,
      endedAt: span.endedAt,
      status: span.status,
      ...(span.error ? { error: span.error } : {}),
      ...(span.usage ? { usage: span.usage } : {}),
    });
  }

  /** 子孙里所有 `llm.turn` 的 usage 之和（不含自身）；无任何计量时返回 undefined */
  private aggregateDescendantUsage(id: SpanId): Usage | undefined {
    const total: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let cost = 0;
    let priced = false;
    let any = false;
    const stack = [...(this.children.get(id) ?? [])];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (s.kind === 'llm.turn' && s.usage) {
        any = true;
        total.inputTokens += s.usage.inputTokens;
        total.outputTokens += s.usage.outputTokens;
        total.cacheReadTokens += s.usage.cacheReadTokens;
        total.cacheCreationTokens += s.usage.cacheCreationTokens;
        if (s.usage.costEstimate != null) {
          priced = true;
          cost += s.usage.costEstimate;
        }
      }
      const kids = this.children.get(s.spanId);
      if (kids) stack.push(...kids);
    }
    if (!any) return undefined;
    // 与 usage.ts 的取整口径一致（1e-6 美元），避免浮点尾差进 trace/OTLP
    if (priced) total.costEstimate = Math.round(cost * 1e6) / 1e6;
    return total;
  }

  event(id: SpanId, name: string, body: unknown): void {
    const span = this.index.get(id);
    if (!span) return; // 未知 span 静默忽略（见类注释的容错策略）—— 增量出口同样不派发
    // 数量闸（traceLimits.maxEvents）：超限即**停止记账**（记录事件不再进 trace）——
    // 但「缺口」本身要**在两条缝上都看得见**（2026-09-28 外部深评 P3-1；PR #164 复核 §4 改了落点）。
    if (this.maxEvents !== undefined && this.recordedEvents >= this.maxEvents) {
      if (this.droppedEvents === 0) this.#markTruncationStart();
      this.droppedEvents += 1;
      return;
    }
    this.recordedEvents += 1;
    const event = { time: Date.now(), name, body };
    span.events.push(event);
    this.emit({ type: 'span.event', spanId: id, event: { ...event } });
  }

  /**
   * 截断**开始**那一刻的簿记（只在第一笔丢弃时调一次）：在 run 根上记一条
   * `trace.truncated { limit }` —— 它**同时进 `span.events` 与增量流**（两处同一份载荷）。
   *
   * 为什么要进 `span.events`（而不是「只派给增量订阅者」）：`core/trace.ts` 那条**折叠规则**
   * 是钉住的契约 —— 「按 `seq` 折回必须逐字等于 `snapshot()`」。只要有一笔只出现在增量流里、
   * 不出现在交付的 trace 里（或反过来），那条契约在**设了 `maxEvents` 且真截断**的 run 上就是假的。
   * 这个 bug 的形态很隐蔽：默认不设上限 ⇒ 折叠用例永远碰不到 ⇒ 全绿。
   *
   * 两条纪律：
   * - **不占** `recordedEvents` 配额（那是「被记录的事实」的上限；本事件是**关于**记账的簿记）
   *   ⇒ 截断时 trace 的事件数最多 `maxEvents + 2`（本条 + 收尾摘要）；
   * - 落在 **run 根**，不是「当时正在记的那条 span」：配额是**整条 trace 的**，「从哪里断」
   *   因此是 trace 级的陈述，不是某条 span 的属性。
   *
   * 与收尾摘要的分工（两者同名 `trace.truncated`，按 body 区分，见 `TraceLimits` 的注释）：
   * 这条是**位置**信号（`{ limit }`，断点在这里），收尾摘要是**计数**（`{ droppedEvents, limit }`）。
   */
  #markTruncationStart(): void {
    const rootId = this.rootSpanId;
    if (!rootId) return; // 没有 run 根（不该发生）：与收尾摘要的 `root?` 同款，不记也不派
    const root = this.index.get(rootId);
    if (!root) return;
    const marker = { time: Date.now(), name: 'trace.truncated', body: { limit: this.maxEvents } };
    root.events.push(marker);
    this.emit({ type: 'span.event', spanId: rootId, event: { ...marker } });
  }

  /**
   * 给 span 记一条属性（`key` 自由、`value` 三态）。
   *
   * ⚠️ **口径如实（2026-09-28 外部深评 E7）**：本方法**不过** `maxEvents` 那道数量闸
   * （上面 `event()` 才过），属性值也**不做** `maxEventChars` 截断。所以「超限即停记」这句话
   * 的射程是**事件**（`span.events`），不是属性（`span.attributes`）。
   *
   * 实际有界的部分（别把它读成「无界」）：`turn.ts` 的 `traceContent:'full'` 正文**确实**按
   * `maxEventChars` 截断；属性**条数**受调用点上限约束（turns ≤ `maxIterations`、
   * 一次工具调用 ≤ 2 条、run 根的 `tools.names` / `labels.*` 由调用方在 run 入口给）。
   * 真正「由调用方决定大小」的是 run 入口那几条（`labels.*` 的值、`tools.names` 的拼接结果）。
   *
   * ⚠️ **别顺手给它加截断**：属性是**交付的 trace** 与增量流共用的同一份载荷，
   * 而 `core/trace.ts` 那条折叠契约（按 `seq` 折回**逐字等于** `snapshot()`）的两端就是它们 ——
   * 只截一侧就当场毁掉那条契约（`tests/engine/trace-events.test.ts` 钉着它）。
   * 要收就收「run 入口那几条的入参大小」，见 §10 ⑳ 的取舍。
   */
  setAttribute(id: SpanId, key: string, value: string | number | boolean): void {
    const span = this.index.get(id);
    if (!span) return;
    span.attributes[key] = value;
    this.emit({ type: 'span.attribute', spanId: id, key, value });
  }

  /**
   * 给 span 记一条跨 trace 的链路引用（入站触发来源，见 `core/trace.ts` 的 `TraceContext`）。
   * 未知 span 静默忽略 —— 与 `event` / `setAttribute` 同一条容错规则（观测不击穿业务）。
   */
  addLink(id: SpanId, link: SpanLink): void {
    const span = this.index.get(id);
    if (!span) return;
    if (!span.links) span.links = [];
    span.links.push(link);
    this.emit({ type: 'span.link', spanId: id, link: { ...link } });
  }

  /**
   * 整条 run 的累计 usage（**只算 `llm.turn` 的自身计量**，子 agent 的往返也在内）。
   *
   * 廉价：只扫 `this.spans` 求和，**不拷** attributes / events / links。
   * `snapshot().totalUsage` 就是调它 —— 两者口径不可能漂移。
   *
   * 为什么单拎出来：预算护栏每回合要判**两次**（回合入口 + 回合末），而 `snapshot()`
   * 会拷全部 span 的 attributes/events ⇒ 白花 O(回合 × 累计事件量)（长 run 下可观）。
   * 护栏只看这一项，就只给它这一项（见 `engine/budget.ts` 的 `BudgetGuard.check` 入参）。
   */
  usage(): Usage {
    const total: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    // 只累加「自身计量」的 span（llm.turn 是唯一 token 来源）。
    // capability span 的 usage 语义是**其子孙的聚合**（见 core/trace.ts Span.usage），
    // 若一并求和，skill/subagent 一旦写入聚合值就会把同一批 token 计两遍。
    for (const s of this.spans) {
      if (!s.usage || s.kind !== 'llm.turn') continue;
      total.inputTokens += s.usage.inputTokens;
      total.outputTokens += s.usage.outputTokens;
      total.cacheReadTokens += s.usage.cacheReadTokens;
      total.cacheCreationTokens += s.usage.cacheCreationTokens;
      if (s.usage.costEstimate != null) {
        total.costEstimate = (total.costEstimate ?? 0) + s.usage.costEstimate;
      }
    }
    // 与 capability 聚合（end() 内）同一取整口径（1e-6 美元）：浮点连加的尾差
    // （0.1+0.2=0.30000000000000004）不该进 trace/OTLP
    if (total.costEstimate != null) {
      total.costEstimate = Math.round(total.costEstimate * 1e6) / 1e6;
    }
    return total;
  }

  snapshot(status: SpanStatus): Trace {
    if (!this.rootSpanId) throw new Error('run root not started');
    const spans = this.spans.map((s) => ({
      ...s,
      attributes: { ...s.attributes },
      events: [...s.events],
      ...(s.links ? { links: [...s.links] } : {}),
    }));
    // 截断摘要：**交付时**才写得出的结论（与 totalUsage 同族），写在 run 根上。
    // 只生成一次（`this.truncationSummary` 缓存）：同一个对象既进 span.events、也走增量出口 ——
    // 否则「按 seq 折回的那棵树」会少这一笔 / 每次 snapshot 的摘要时间戳互不相同，
    // `core/trace.ts` 那条折叠规则就是**假的**。
    // 增量出口只派一次 ⇒ 重复交付不会让增量流里多出一条。
    if (this.droppedEvents > 0) {
      const root = spans.find((s) => s.spanId === this.rootSpanId);
      if (root) {
        if (this.truncationSummary === null) {
          this.truncationSummary = {
            time: Date.now(),
            name: 'trace.truncated',
            body: { droppedEvents: this.droppedEvents, limit: this.maxEvents },
          };
          this.emit({
            type: 'span.event',
            spanId: this.rootSpanId,
            event: { ...this.truncationSummary },
          });
        }
        root.events.push(this.truncationSummary);
      }
    }
    return {
      traceId: this.traceId,
      rootSpanId: this.rootSpanId,
      // （spans 的浅拷 + attributes/events/links 拷一层见函数开头：快照交付后仍在记账的
      // 残尾会继续 push 进 recorder 持有的数组，不拷贝就会事后变异已交付的 trace。
      // 不递归深拷：事件 body 与 link 记账后不再被框架改写。links 用「有才拷」——
      // 见 core/trace.ts 的注释：缺席与空数组是同一件事，别制造第三种形态。）
      spans,
      status,
      totalUsage: this.usage(),
    };
  }
}
