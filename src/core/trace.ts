/**
 * Agentia —— Trace / 调用树 类型草稿。
 * 设计见 docs/spec.md §9。一次 run == 一条 trace（v1 中 traceId == runId）。
 */

export type TraceId = string;
export type SpanId = string;

/** span 层级：run=整次运行；capability=对能力的调用；llm.turn=每次模型往返。
 *  注意 capability span 只由 skill / subagent 创建（toolkit/skill.ts、toolkit/subagent.ts 里的
 *  recorder.begin('capability', …)）；普通工具与 @Prompt 资产【不建 span】，只记 turn 上的
 *  tool.input / tool.output 事件（engine/loop.ts）。 */
export type SpanKind = 'run' | 'capability' | 'llm.turn';

export type CapabilityType = 'tool' | 'skill' | 'prompt' | 'subagent';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 估算成本(美元)，由 token × 单价算出，随模型表更新 */
  costEstimate?: number | undefined;
}

export type SpanStatus = 'ok' | 'error';

export interface SpanError {
  type: string;
  message: string;
  /** 是否可安全重试（429/5xx/网络 vs 400/400类） */
  retryable: boolean;
}

/**
 * 工具**入参**事件的 `SpanEvent.name`（`TOOL_OUTPUT_EVENT` 是它的另一半）。
 *
 * 为什么单源在 `core/`（2026-09-28 外部深评 E8）：这两个名字跨 **engine → eval →
 * integrations** 三层被手写（12 处取值）—— 改名要改三遍，而漏一处不是「少记一条」，
 * 是**静默归零**：事件在引擎里叫 A、报表按 B 过滤 ⇒ 报表说「没有工具调用」，而 trace 里
 * 明明有（`integrations/report.ts` 与 `metrics-state.ts` 那两处都按名字过滤）。
 *
 * ⚠️ 报告建议的落点（`engine/tool-events.ts`，与载荷构造器同处）**不可行**：
 * `integrations` 只许依赖 `core`（`tests/architecture/layering.test.ts`），拿不到 engine 的
 * 导出 —— 那样 integrations 侧只能再手写一份，等于把「单源」补成「两处」。
 * 所以词汇表落在最底层：**载荷构造器（engine）与名字（core）分开**，谁都能引。
 */
export const TOOL_INPUT_EVENT = 'tool.input';
export const TOOL_OUTPUT_EVENT = 'tool.output';

/**
 * 「上游**没回报 usage**」事件名（2026-09-28 外部深评 S2）。
 *
 * 为什么也单源在这里：与上面那两条同一理由 —— 名字是跨层契约。写它的是
 * `engine/turn.ts`，按名字数的是 `integrations/report.ts` 与 `metrics-state.ts`。
 * 手写三遍 ⇒ 一处改名就是**静默归零**（报表说「没有缺失」，而 trace 里明明有）。
 *
 * 语义：该回合的上游响应**没有**带 token 计量，于是 `MessageUsage` 里那几个 `0` 是
 * **替身值**（不是读数）—— 成本估算会把它读成「真的花了 0」，`maxCostUsd` 因此静默失效。
 */
export const USAGE_MISSING_EVENT = 'usage.missing';

/**
 * 「上下文策略在本回合开始前**真的压缩了**历史」事件名（body 带 `{ from, to, model }`）。
 *
 * 记账点在 `engine/turn.ts` 的回合入口检查（压缩发生时本回合的 llm.turn span 还不存在，
 * 故事件记在回合的**父** span 上）；消费方是 `integrations/otlp.ts`
 * （映射 `gen_ai.conversation.compacted`）。与 `TOOL_INPUT_EVENT` 同因单源：
 * 跨 engine → integrations 的名字各写一份就是静默归零。
 */
export const CONTEXT_BUDGET_EVENT = 'context.budget';

/** 工具 I/O 事件名的联合 —— `eval/export.ts` 的工具事件过滤器按它取参数 */
export type ToolIoEventName = typeof TOOL_INPUT_EVENT | typeof TOOL_OUTPUT_EVENT;

/**
 * 结构化事件（日志）。工具入参/出参**正文默认截断**（入参/成功出参 2000 字符、失败出参 1000），
 * 完整正文需显式开启：`RunInvocationOptions.maxEventChars: false`（缺省关）。
 * 脱敏**不在框架内** —— 那是 sink 缝外的事（spec §9.3），框架只保证出口形状。
 */
export interface SpanEvent {
  time: number;
  /**
   * 事件名。工具 I/O 的两条走 `TOOL_INPUT_EVENT` / `TOOL_OUTPUT_EVENT` 常量
   * （见上：这个名字是跨层契约，不许在别处再写一遍字面量）；
   * 其余（`'compaction'` 等）目前仍是字面量，尚未单源 —— 如实记在这里，别当已成网。
   */
  name: string;
  body: unknown;
}

/**
 * 触发来源的链路上下文（跨进程 / 跨服务关联，spec §9.2）。
 *
 * 语义是**入站**的：调用方（HTTP 网关、队列消费者、上游服务）把它自己的 span 标识
 * 传进来，本次 run 的根 span 会把它记成一条 `SpanLink` 指回去 —— 于是「这条 run 是被
 * 谁触发的」在两个系统之间可查。
 *
 * ⚠️ **不改变 `traceId == runId` 的 1:1 不变量**：run 仍是自己的一棵新树，上游只是被
 * **链接**、不是被**继承**成父 span。所以一次 run 的调用树永远自洽（不依赖上游是否
 * 还在、是否被采样掉），而因果关系仍然成立。
 */
export interface TraceContext {
  /** 上游 trace id：32 位 hex（W3C traceparent）或 UUID（带 '-'）两种形态都接受 */
  traceId: string;
  /** 上游 span id（16 位 hex）；缺省表示只知道 trace 粒度、没有具体 span */
  spanId?: string;
}

/**
 * 一条链路引用：指向**另一个** trace 里的 span（OTLP 的 span links 同语义）。
 * v1 只在 run 根 span 上写入（来源是 `RunInvocationOptions.traceContext`）。
 */
export interface SpanLink {
  traceId: TraceId;
  spanId?: SpanId;
}

/** W3C traceparent：`<2位版本>-<32位trace>-<16位span>-<2位flags>`，全小写 hex */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * 解析 W3C `traceparent` 头（spec §9.2 的「header 语义」）。这是入站唯一的字符串形态
 * —— 宿主从 HTTP 头 / 队列消息属性里取到它，直接交给 `RunInvocationOptions.traceContext`。
 *
 * **非法或缺失一律返回 `undefined`**（调用方据此当作「没有上游上下文」继续跑）：
 * 链路关联是观测行为，不该因为一个畸形头把业务请求打成 400。被拒的形态有：
 * 版本 `ff`（W3C 保留为非法）、trace/span id 全零、位宽不符、大小写之外的畸形。
 * 版本号非 `00` 时按 W3C「兼容未来」规则接受（只认前四段语义）。
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!m) return undefined;
  const [, version, traceId, spanId] = m;
  if (version === 'ff') return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

/**
 * 内部 id → **线缆形态**（W3C `traceparent` 与 OTLP 通用）。
 *
 * 内部 id 一律 UUID（去横线 32-hex），而线上两份契约都要求 trace 16 字节（32-hex）、
 * span **8 字节（16-hex）** —— 宽度不同，不能共用。原样发出去会被判 `invalid span_id`
 * （拒收）或按前 16 位截断。故 trace 侧去横线即可、span 侧必须截到 16 位。
 *
 * ⚠️ **单一真源**：OTLP 导出（`integrations/otlp.ts`）与出站 `formatTraceparent` 必须
 * 走**同一份**投影。各写一份的后果不是「风格不统一」，而是**同一次调用在两个系统里
 * 是两个 span id** —— 跨系统关联最不能出的错。要改这里，先看 `tests/integrations/otlp.test.ts`
 * 的「导出与出站同数」用例。
 *
 * 幂等：已经是 32-hex（trace）/ 16-hex（span）的输入原样通过（上游 span id 被再次转发不变形）。
 */
export function wireTraceId(id: string): string {
  return id.replaceAll('-', '');
}

export function wireSpanId(id: string): string {
  return id.replaceAll('-', '').slice(0, 16);
}

/**
 * 生成 W3C `traceparent`（`parseTraceparent` 的镜像：一个解析、一个生成）。
 *
 * flags 位恒为 `00`。**理由不是「本框架不采样」**（采样早就是明确推荐的宿主配法 ——
 * `docs/observability.md` 2.3），而是**运行期不可知**：记录/导出决策发生在 run **收尾之后**
 * （采样闸门要看完好整棵 trace 才判得出来），而出站调用发生在**运行期** ——
 * 那时「这条 trace 会不会被采样掉」还没有答案。所以恒 `00` 是唯一不撒谎的选择
 * （`00` = 不声明「已采样」）；编一个 `01` 是替下游做决定。⚠️ 别下一轮「顺手」改成跟随采样
 * （见 `docs/spec.md` §10 2026-09-21 ref-cost-sampling）。入站侧 `parseTraceparent` 也从不读 flags。
 *
 * 调用方保证给的是内部 id 或线缆 id（本函数只做投影，不做合法性判定）。
 */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${wireTraceId(traceId)}-${wireSpanId(spanId)}-00`;
}

export interface Span {
  spanId: SpanId;
  traceId: TraceId;
  parentSpanId: SpanId | null;
  kind: SpanKind;
  // capability 的 name 是**裸能力名**（如 `researcher`，无 `subagent:` 前缀 —— 三个生产点
  // toolkit/subagent.ts、skill.ts、engine/mcp-server.ts 都是 `begin('capability', name, …)`；
  // 区分 skill/subagent 看 attributes，见 capabilityKindOf。otlp.ts 曾按前缀判，生产上一条
  // gen_ai.* 都没发出去）。llm.turn 的 name 是模型 id。
  name: string;
  startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  error?: SpanError;
  /**
   * 跨 trace 的链路引用（v1 只出现在 run 根 span 上，见 `TraceContext`）。
   * 缺席（而不是空数组）表示「没有上游上下文」—— 与 links 为空的 span 是同一件事，
   * 不要据此区分「没传」和「传了但为空」。
   */
  links?: SpanLink[];
  /**
   * usage —— 语义按 kind 区分：
   * - `llm.turn`：该次模型往返的**自身计量**，是 Trace.totalUsage 的唯一来源；
   * - `capability`（skill / subagent）：其**子孙 llm.turn 的聚合**，仅供展示（看某个能力花了多少），
   *   **不**计入 totalUsage（否则与子孙重复计数）。
   */
  usage?: Usage;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface Trace {
  traceId: TraceId;
  rootSpanId: SpanId;
  spans: Span[];
  status: SpanStatus;
  totalUsage: Usage; // run 汇总 = 各 llm.turn span 求和（不含 capability 聚合，避免重复计数）
}

/**
 * 质量评分（R7 质量闭环）：LLM-judge / 人工标注 / eval 结论挂到 trace 上，
 * 让「这条 run 好不好」与「这条 run 发生了什么」同处一份数据。
 * 评分通常来自 run **之外**（跑完后才评），所以走事件而非 span 字段。
 */
export interface Score {
  /** 评分维度名（如 'faithfulness'、'eval'）—— 指标聚合的 label */
  name: string;
  /** 数值分；约定 0–1（布尔结论用 0/1） */
  value: number;
  /** 评分来源（eval 名 / 'human' / judge 模型 id 等） */
  source?: string;
  /** 备注（失败原因、评语） */
  comment?: string;
}

/**
 * 把评分挂到 trace 根 span（一条 `score` 事件，body 即 Score）。
 * trace 找不到根 span 时静默忽略（观测不击穿业务）；多次调用即多条事件（不同维度各记各的）。
 * 出口映射：OTLP 导出时译为 `gen_ai.evaluation.result` 事件，metricsSink 聚合为 score 指标族。
 */
export function attachScore(trace: Trace, score: Score): void {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  root?.events.push({ time: Date.now(), name: 'score', body: score });
}

/**
 * 能力 span 的类型标签：`attributes.skill` 有值 → `'skill'`，`attributes.subagent` 有值
 * → `'subagent'`，否则 `'capability'`（`SpanKind` 的第三个取值，也是 span 的 kind）。
 *
 * 放在本文件（而不是各出口里）：`skill` / `subagent` 这两个 attribute 名是
 * `toolkit/skill.ts`、`toolkit/subagent.ts` 与本类型之间的共同契约 —— 判定写在契约
 * 定义处，两个出口（`metrics.ts` 的指标 label、`report.ts` 的能力排行）只消费结论。
 * 此前两处各有一份同形实现，加起来是**同一件事的三个定义**。
 *
 * 返回 `string` 而非 `CapabilityType`：`'capability'` 不在 `CapabilityType`
 * （那是「菜单四类能力」的口径）里，两者刻意不混。
 */
export function capabilityKindOf(span: Span): string {
  if (span.attributes.skill !== undefined) return 'skill';
  if (span.attributes.subagent !== undefined) return 'subagent';
  return 'capability';
}

/**
 * trace 出口：run 收尾（成功或失败）后，框架把【完整 Trace】交给每个 sink。
 * sink 抛错由框架吞掉（吞之前落一条 console.warn 告警），绝不影响 run 结果（与 memory 回写同款防护）。
 * 形状与 OtlpExporter 一致 —— createOtlpExporter() 的返回值天然满足本接口。
 */
export interface TraceSink {
  export(trace: Trace): void | Promise<void>;
}

/**
 * **记账事件**（增量出口，`docs/plans/2026-09-21-incremental-trace-export-and-sampling.md`）——
 * run **进行中**就能拿到的明细。它与 `TraceSink` 是**两条缝**，不是替代关系：
 *
 * - `TraceSink`：run 收尾拿到**完整** trace（成功的 sink 该走这条）；
 * - 记账事件：**等不了收尾**的消费者 —— 终端面板、SSE 前端、异步任务进度流。
 *
 * 载荷一律是**增量 + 此刻的拷贝**（交付后框架不再变异它）：`span.begin` 只给初始形状
 * （`attributes` / `events` 为空），之后的属性 / 事件 / 链路各走自己的事件类型。
 *
 * **折叠规则**（`tests/engine/trace-events.test.ts` 钉着）：按 `seq` 升序把同一次 run 的
 * 全部事件应用到 `span.begin` 建出的 span 上，结果必须**逐字等于** `snapshot(status)`。
 * ⇒ 这条不变量一次钉住四件事：不丢、不重、顺序正确、增量与终态同源。要改记账点而不派发事件，
 * 那个用例会红。
 *
 * ⚠️ **没有例外**（2026-09-28 PR #164 复核 §4 定的口径）：截断簿记（`traceLimits.maxEvents`
 * 超限时 run 根上的 `trace.truncated`）也走**普通 `span.event` 帧**，因此同样折得出来。
 * 「只在一条缝上出现的事件」正是让这条规则变成假话的方式 —— 判据是「两处同一份载荷」，
 * 不是「哪条缝更需要它」。折叠侧的类型分派是**编译期穷尽**的（新帧类型会编译失败，
 * 而不是被当成 `span.link` 静默吞掉）。
 *
 * `seq`：recorder 内**每次记账动作都自增**（与当时有没有订阅者无关）—— 于是「订阅早」与
 * 「订阅晚」看到的同一个事件序号一致。SSE 的 `Last-Event-ID` 重放、去重、跨段对齐都靠它。
 *
 * 投放纪律与 sink 同款：**同步派发、不 await**、订阅者抛错被吞（观测失败不击穿业务）。
 * ⚠️ 但它**不保证送达**（宿主自己的流断了就断了，没有 sink 那层兜底/重试语义）。
 */
export type TraceRecordEventPayload =
  | { type: 'span.begin'; span: Span }
  | {
      type: 'span.end';
      spanId: SpanId;
      endedAt: number;
      status: SpanStatus;
      error?: SpanError;
      usage?: Usage;
    }
  | { type: 'span.event'; spanId: SpanId; event: SpanEvent }
  | { type: 'span.attribute'; spanId: SpanId; key: string; value: string | number | boolean }
  | { type: 'span.link'; spanId: SpanId; link: SpanLink };

export type TraceRecordEvent = TraceRecordEventPayload & { seq: number };

/**
 * 把两个增量记账回调**合成一个**订阅者（前者在前）。
 *
 * 为什么要合成而不是 `??` 覆盖：`onTraceEvent` 是**观察者注册**（同 `TraceSink`：
 * 应用级与全局默认一起收），不是值覆盖 —— 覆盖会让「某次 run / 某个宿主顺手传了自己的
 * 回调」把另一条静默顶掉。两个消费者都要它的场景是真实存在的：宿主自己配了一条应用级
 * 面板回调，`AsyncRunner` 还要为 `GET /tasks/:id/stream` 再挂一条按任务分的缓冲。
 *
 * 为什么内部各自 try/catch：合成后它们在 recorder 眼里是**一个**订阅者，而 recorder 只在
 * 这一层兜错 —— 不隔离的话前一个抛错会吞掉后一个（与「一条订阅者炸了不影响另一条」互为镜像）。
 */
export function composeTraceEvents(
  first: ((e: TraceRecordEvent) => void) | undefined,
  second: ((e: TraceRecordEvent) => void) | undefined,
): ((e: TraceRecordEvent) => void) | undefined {
  if (!first) return second;
  if (!second) return first;
  return (e) => {
    try {
      first(e);
    } catch {
      /* 观测不击穿业务（与 flushSinks 同款） */
    }
    try {
      second(e);
    } catch {
      /* 同上 */
    }
  };
}
