// 内部 id → 线缆形态的投射**单一真源**在 core/trace.ts（与 parseTraceparent 同处）——
// 出站 traceparent 用的是同一份，改这里就等于同时改出站（见 core/trace.ts 的注释）。
import { type Span, type SpanEvent, type Trace, wireSpanId, wireTraceId } from '../core/trace.js';
import { otlpPartialSuccess, readOtlpResponseBody } from './otlp-partial.js';

/**
 * Agentia —— OTLP trace 导出（spec §9.3 生产方向，roadmap R3）。
 *
 * 把一次 run 的 Trace 映射为 OTLP/JSON（resourceSpans → scopeSpans → spans），
 * 用全局 fetch POST 到 `${endpoint}/v1/traces`，零外部依赖：
 * - traceId/spanId/parentSpanId：内部用 UUID，OTLP 要求 hex —— 去掉 '-' 即 32 位 hex；
 * - kind 固定 SPAN_KIND_INTERNAL(1)；时间 ms × 1e6 转 string 纳秒；
 * - status：ok → `{code: 1}`，error → `{code: 2, message}`（**整数** —— OTLP/JSON 的 enum
 *   必须整数编码，禁止 enum 名；`kind` 同理走整数 1）；
 * - attributes 展平 span.attributes + usage（usage.* 前缀）；
 * - events → OTLP events（body 的原始类型字段进 attributes，其余 JSON 化）。
 *
 * GenAI 语义约定（R7 质量闭环，**additive** —— 只追加 gen_ai.* 键，既有键一律保留）：
 * - 对齐基准：**`open-telemetry/semantic-conventions-genai` @ `6fd0d763`（2026-10-09）**。
 *   GenAI 约定自 **v1.42（2026-06-12）移出语义约定主线**到该独立仓；该仓**全篇 Development、
 *   无 tag、未版本化**，所以基准只能钉 commit（官方口径也是「记录你 instrument 的 commit/日期」）。
 *   ⚠️ 2026-10-12 更正：此前这里写「v1.37 时 `gen_ai.client` 侧已 stable」——**回源核为假**
 *   （v1.37 的 `docs/gen-ai/spans.md` / `metrics.md` 文首均为 `Status: [Development]`），已删。
 *   决策链与证据见 `docs/spec.md` §10 2026-10-12。
 * - **全部映射集中在 `genAiAttributes` / `mapEvent` 两处**，升级基准时只改本模块；
 *   键前缀冲突不存在（自有键一律 `agentia.*` 或无前缀），所以 additive 是安全的。
 * - 保留 `usage.inputTokens` 等旧键：既有看板/告警已消费它们，双发成本极低。
 *
 * 非 2xx 抛 `OtlpExportError`（带**数值** status 与响应前 200 字符）。导出失败不影响 run
 * 本身 —— 调用方自行取舍；但对「要不要重试」的判定必须可判：状态码只写进文案、对象没有
 * `status` 的话，`classifyError` 会把 429/5xx 也判成 `unknown` + 不可重试（与 anthropic /
 * openai 适配器同款教训，见 docs/spec.md §10 2026-09-18，守卫 `tests/architecture/
 * transport-errors.test.ts`）。
 */

export interface OtlpExporterOptions {
  /** collector 基地址，例如 http://localhost:4318（尾部斜杠会被去掉） */
  endpoint: string;
  /** 额外请求头（鉴权等） */
  headers?: Record<string, string>;
  /** resource 的 service.name，缺省 'agentia' */
  serviceName?: string;
  /**
   * 单次导出请求超时（毫秒），缺省 10000；非正数 = 不限。
   * 裸 fetch 没有超时：collector 半开连接（accept 后永不回包）会让 run 收尾永久挂起。
   * 超时按导出失败处理（export reject 一个 name=TimeoutError 的错误），
   * 上层 flushSinks 的 catch 会吞掉它 —— 观测失败不击穿业务。
   */
  timeoutMs?: number;
  /**
   * 导出失败回调（与 `metricsSink` 的同名选项对称）。
   *
   * 给了它，**所有**导出失败（非 2xx / 超时 / **HTTP 200 但 collector 报部分接收**）都走这里、
   * 不再向 `TraceSink` 调用方抛出；不给则保持既有行为（抛出，由 `flushSinks` 吞掉并落 console.warn）。
   * 存在的理由：`TraceSink` 的失败缺省只有一条泛化的 warn（观测失败不得击穿业务），
   * 「导出其实少了一半数据」这类**带分类的**消息要有人能收到。
   */
  onExportError?: (err: unknown) => void;
}

export interface OtlpExporter {
  export(trace: Trace): Promise<void>;
}

/**
 * OTLP 导出失败（非 2xx 或流内失败）。带**数值 `status`** —— 不是装饰：
 * `engine/errors.ts` 的错误分类是鸭子类型，只认这个字段；丢了它，429/5xx 也会被
 * 判成 `unknown` + 不可重试，与 anthropic / openai 适配器曾经踩过的坑同形。
 */
export class OtlpExportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OtlpExportError';
    this.status = status;
  }
}

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

function toValue(v: string | number | boolean): OtlpValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  // OTLP int64 走 string；小数用 double
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

/**
 * 内部 UUID → OTLP hex 的投射**已上移到 `core/trace.ts`**（`wireTraceId` / `wireSpanId`）。
 *
 * 为什么上移：出站 W3C `traceparent` 需要**同一份**投射 —— 两种 id 宽度不同（trace 16 字节
 * / span 8 字节），各写一份的后果是同一次调用在 collector 里与下游收到的是**两个 span id**。
 * 这里只留取向，实现只有一处。
 */

/** ms → string 纳秒（epoch 毫秒 ×1e6 > 2^53，必须 BigInt，double 直接乘会丢精度） */
function nanos(ms: number): string {
  return String(BigInt(Math.round(ms)) * 1_000_000n);
}

/**
 * GenAI semconv 追加属性（additive，见模块头注释）。
 * 返回的键与 span.attributes 自有键不同名（gen_ai.* 前缀），直接 push 不查重。
 */
function genAiAttributes(span: Span): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];
  const str = (key: string, v: string): OtlpAttribute => ({ key, value: { stringValue: v } });
  if (span.kind === 'run') {
    // 一次 run = 一次 agent 调用；span.name 即应用名，正好填 agent.name
    attrs.push(str('gen_ai.operation.name', 'invoke_agent'), str('gen_ai.agent.name', span.name));
    const sessionId = span.attributes['session.id'];
    if (typeof sessionId === 'string') attrs.push(str('gen_ai.conversation.id', sessionId));
  } else if (span.kind === 'llm.turn') {
    // llm.turn 的 span.name 就是模型 id（core 契约）；token 口径与 usage.* 旧键一致
    attrs.push(str('gen_ai.operation.name', 'chat'), str('gen_ai.request.model', span.name));
    if (span.usage) {
      attrs.push(
        { key: 'gen_ai.usage.input_tokens', value: toValue(span.usage.inputTokens) },
        { key: 'gen_ai.usage.output_tokens', value: toValue(span.usage.outputTokens) },
      );
    }
  } else if (span.kind === 'capability') {
    // subagent 是一次嵌套 agent 调用（invoke_agent）；skill 对外语义是「执行一件工具」（execute_tool）。
    // ⚠️ 类型与名字都从 **attributes** 取（`subagent` / `skill`，见 toolkit/subagent.ts:119、
    // skill.ts:128），**不要**按 span.name 的前缀判 —— 生产里 capability span 的 name 是**裸能力名**
    // （`recorder.begin('capability', name, …)`），而 metrics.ts / report.ts / trace-view 三个消费者
    // 全部读 attributes。此前这里判 `name.startsWith('subagent:')`，于是**生产环境一条 gen_ai.* 都
    // 没发出去**（子 agent 的 agent.name / skill 的 tool.name 全缺），而单测夹具自己造了带前缀的
    // 形状、把这个错藏了好几轮。
    const subagent = span.attributes.subagent;
    const skill = span.attributes.skill;
    if (typeof subagent === 'string') {
      attrs.push(str('gen_ai.operation.name', 'invoke_agent'), str('gen_ai.agent.name', subagent));
    } else if (typeof skill === 'string') {
      attrs.push(str('gen_ai.operation.name', 'execute_tool'), str('gen_ai.tool.name', skill));
    }
  }
  return attrs;
}

function spanAttributes(span: Span): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = Object.entries(span.attributes).map(([key, v]) => ({
    key,
    value: toValue(v),
  }));
  attrs.push(...genAiAttributes(span));
  if (span.usage) {
    const u = span.usage;
    attrs.push(
      { key: 'usage.inputTokens', value: toValue(u.inputTokens) },
      { key: 'usage.outputTokens', value: toValue(u.outputTokens) },
      { key: 'usage.cacheReadTokens', value: toValue(u.cacheReadTokens) },
      { key: 'usage.cacheCreationTokens', value: toValue(u.cacheCreationTokens) },
    );
    if (u.costEstimate !== undefined) {
      attrs.push({ key: 'usage.costEstimate', value: toValue(u.costEstimate) });
    }
  }
  return attrs;
}

function eventAttributes(body: unknown): OtlpAttribute[] {
  if (body === undefined) return [];
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const attrs: OtlpAttribute[] = [];
    for (const [key, v] of Object.entries(body as Record<string, unknown>)) {
      // 显式 undefined 不是合法 AnyValue：走兜底分支会得到 {stringValue: JSON.stringify(undefined)}
      // = {stringValue: undefined}，序列化成 {"key":"x","value":{}}，collector 判非法。
      // 与 spanAttributes 的口径一致（span.attributes 的类型不允许 undefined）：跳过。
      if (v === undefined) continue;
      attrs.push({
        key,
        value:
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? toValue(v)
            : { stringValue: JSON.stringify(v) },
      });
    }
    return attrs;
  }
  return [{ key: 'body', value: { stringValue: JSON.stringify(body) } }];
}

function mapEvent(e: SpanEvent) {
  // score 事件（R7 质量闭环）→ gen_ai.evaluation.result（semconv 仍是 experimental，
  // 故 source/comment 这类 semconv 未定义的维度走自有 agentia.* 键，不占用 gen_ai.* 命名空间）。
  // body 宽容读取：name/value 类型不对就只发事件名，观测不击穿业务。
  if (e.name === 'score') {
    const body =
      e.body && typeof e.body === 'object' && !Array.isArray(e.body)
        ? (e.body as Record<string, unknown>)
        : {};
    const attributes: OtlpAttribute[] = [];
    if (typeof body.name === 'string') {
      // semconv 里「评分维度名」是 `gen_ai.evaluation.name`（与 .score.value/.score.label 配对）；
      // `gen_ai.evaluation.score.name` **不存在**（实测 @opentelemetry/semantic-conventions 全量键名里没有）。
      attributes.push({ key: 'gen_ai.evaluation.name', value: { stringValue: body.name } });
    }
    if (typeof body.value === 'number' && Number.isFinite(body.value)) {
      // 语义是 double：整型分也发 doubleValue，避免后端按 int64 解析丢掉「分数」类型
      attributes.push({
        key: 'gen_ai.evaluation.score.value',
        value: { doubleValue: body.value },
      });
    }
    if (typeof body.source === 'string') {
      attributes.push({ key: 'agentia.score.source', value: { stringValue: body.source } });
    }
    if (typeof body.comment === 'string') {
      attributes.push({ key: 'agentia.score.comment', value: { stringValue: body.comment } });
    }
    return { timeUnixNano: nanos(e.time), name: 'gen_ai.evaluation.result', attributes };
  }
  return {
    timeUnixNano: nanos(e.time),
    name: e.name,
    attributes: eventAttributes(e.body),
  };
}

function mapSpan(span: Span) {
  return {
    traceId: wireTraceId(span.traceId),
    spanId: wireSpanId(span.spanId),
    ...(span.parentSpanId ? { parentSpanId: wireSpanId(span.parentSpanId) } : {}),
    // 跨 trace 链路（spec §9.2）：触发本次 run 的上游 span 映射成 OTLP span links。
    // 宽度规则与 parentSpanId 同一条：OTLP 的 span_id 是 8 字节（16 位 hex），
    // 内部 UUID 必须截断，否则 collector 判 invalid span_id 整条拒收。
    // 没有 link 时**不发这个键**（空数组会让部分后端把 span 标成「有链路」）。
    ...(span.links && span.links.length > 0
      ? {
          links: span.links.map((l) => ({
            traceId: wireTraceId(l.traceId),
            ...(l.spanId ? { spanId: wireSpanId(l.spanId) } : {}),
          })),
        }
      : {}),
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(span.startedAt),
    ...(span.endedAt !== undefined ? { endTimeUnixNano: nanos(span.endedAt) } : {}),
    attributes: spanAttributes(span),
    events: span.events.map(mapEvent),
    status:
      span.status === 'error'
        ? {
            // ⚠️ OTLP/JSON 的 **enum 必须编码为整数**（规范原文：enum 字段用整数值编码，
            // 禁止 enum 名字符串）—— 2 = STATUS_CODE_ERROR / 1 = STATUS_CODE_OK。
            // 曾经发的是 'STATUS_CODE_OK' 这种字符串：本地假 collector 只做 JSON.parse，
            // 所以 CI 一直绿；严格的 collector 会判非法并**整批拒收**。
            code: 2,
            ...(span.error ? { message: span.error.message } : {}),
          }
        : { code: 1 },
  };
}

export function createOtlpExporter(opts: OtlpExporterOptions): OtlpExporter {
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  const serviceName = opts.serviceName ?? 'agentia';
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // 真正发请求的那条路径：一切失败都**抛**（非 2xx / 超时 / 200 但部分接收）。
  // 外面那层 `export` 决定抛给谁：有 onExportError 就交给它，否则保持既有行为（抛出去，
  // 由 flushSinks 吞掉 —— 观测失败不得击穿业务）。
  const send = async (trace: Trace): Promise<void> => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: 'agentia' },
              spans: trace.spans.map(mapSpan),
            },
          ],
        },
      ],
    };
    const res = await fetch(`${endpoint}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...opts.headers,
      },
      body: JSON.stringify(payload),
      // 半开连接防护：超时后 fetch reject（TimeoutError），由上层按导出失败处理
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new OtlpExportError(res.status, `OTLP 导出失败: HTTP ${res.status} ${text}`);
    }
    // HTTP 200 **不等于全部接收**：collector 可以用 200 + `partialSuccess` 说「收了一部分」。
    // 静默读成成功就是「看板少数据而框架说一切正常」。判据见 otlp-partial.ts（在场 ≠ 拒收）。
    const partial = otlpPartialSuccess(await readOtlpResponseBody(res), 'spans');
    if (partial !== undefined) {
      throw new OtlpExportError(200, `OTLP 导出被部分接收（HTTP 200）: ${partial}`);
    }
  };

  return {
    async export(trace: Trace): Promise<void> {
      if (opts.onExportError === undefined) return send(trace);
      try {
        await send(trace);
      } catch (e) {
        opts.onExportError(e);
      }
    },
  };
}
