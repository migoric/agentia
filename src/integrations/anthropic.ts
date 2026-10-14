import type {
  ContentBlock,
  Message,
  StopReason,
  TextBlock,
  ToolUseBlock,
} from '../core/message.js';
import { textOf } from '../core/text.js';
import { resolveMaxRetries, statusOfStreamError } from './adapter-options.js';
import { sseLines } from '../core/sse.js';
import { assertTimerDelay, backoffMs, interruptibleSleep } from '../core/timeout.js';
import type { ModelClient } from '../core/tool.js';
import { zeroClauseOf } from '../core/limits.js';

/**
 * Agentia —— 默认 ModelClient：Anthropic Messages API（手写 fetch + SSE，不再包装厂商 SDK）。
 *
 * 引擎（`engine/loop.ts`）只经由此处取默认 client。使用者自定义只传
 * `apiKey` / `baseURL`（或环境变量 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`），
 * **不必接触厂商 SDK**。工程形态与 `integrations/openai.ts` 同款：手写 fetch、
 * 逐行读 SSE、按分片组装成 `Message`。
 *
 * signal 直接进 fetch（这正是 2026-09-14 那个 bug 的根治 —— 当时 SDK 只在
 * RequestOptions 里认 signal，放 body 里会被静默丢弃，在飞 run 中止失效、
 * 超时后继续烧 token；实测对照见 docs/spec.md §10 的 2026-09-14 ref-real-api-signal）。
 *
 * 重试语义与 SDK 缺省对齐（maxRetries=2：408 / 409 / 429 / 5xx / 连接错误，
 * 指数退避，尊重 `retry-after` 响应头）。引擎层另有一层重试兜底
 * （`engine/retry.ts`），两层关系与 SDK 时代一致。
 *
 * 兼容端点（如 DeepSeek 的 Anthropic 兼容端点）换 baseURL 即可；非官方端点的
 * 兼容性靠调用方保证，本实现不发明额外的鉴权形态。
 */

export interface AnthropicClientOptions {
  /** 缺省读环境变量 `ANTHROPIC_API_KEY` */
  apiKey?: string;
  /** 缺省读环境变量 `ANTHROPIC_BASE_URL`，再缺省 `https://api.anthropic.com`（兼容端点 / 网关） */
  baseURL?: string;
  /**
   * 单次请求的重试次数（不含首次尝试；408 / 409 / 429 / 5xx / 连接错误）。缺省 2，与 SDK 缺省一致。
   * 引擎层另有外层重试（`RunAgentOptions.retry`），两层叠加最多
   * `(1 + maxRetries) × maxAttempts` 次请求 —— 建议二选一调。
   */
  maxRetries?: number;
  /**
   * 单次请求超时（毫秒）。缺省不给（中止由引擎的 signal 管，见 `ModelClient` 契约）；
   * 给了就用超时信号与 params.signal 合成（任一触发即中止）。超时按连接错误处理（可重试）。
   *
   * 必须为**正的有限数、且不超过 Node 定时器上限**（构造期校验，与 AsyncRunner 对
   * `runTimeoutMs` 的校验同款）：NaN / Infinity / 超过 `2^31-1`ms 的延迟都会被 `setTimeout`
   * 钳到 1ms（Node 只在 stderr 留一行 `TimeoutOverflowWarning`，没人会看到）——
   * 于是每个请求立即「超时」，看起来像上游全挂。
   * ⚠️ 校验只挡非法配置，**不改超时的既有行为**：client 层超时经合成信号中止请求、
   * 自身不再重试，抛出的 `TimeoutError`（DOMException）由引擎归 `timeout` 一类账。
   */
  timeout?: number;
  /**
   * 历史遗留：SDK 时代其余键原样透传给 SDK 构造参数；自研化后**不再消费**，
   * 保留索引签名只为旧代码编译不炸。多余键静默忽略。
   * 此处的索引签名是**有意**的 —— 与 `core/message.ts` 兜底成员「绝不加索引签名」
   * 方向相反但场景不同：那是会被赋值/收窄的公共消息类型（带索引签名会让 SDK 的
   * interface 块类型赋不进来），这里是构造参数对象，不存在被赋值侧的
   * assignability 问题。别照着一边去改另一边。
   */
  [key: string]: unknown;
}

/**
 * Anthropic API 错误：非 2xx 响应（读响应体截断进 message）或 200 流内嵌 error 事件。
 * 带数值 `status` —— `engine/errors.ts` 的鸭子类型分类靠它（429 → rate_limit、
 * 5xx → server、其余 4xx → api）。
 */
export class AnthropicApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AnthropicApiError';
    this.status = status;
  }
}

/** 创建默认 ModelClient（Anthropic）。不传则完全走环境变量 + 官方端点。 */
export function createAnthropicClient(options: AnthropicClientOptions = {}): ModelClient {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseURL = (
    options.baseURL ??
    process.env.ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com'
  ).replace(/\/+$/, '');
  // 构造期校验（与下面 timeout 同款纪律）：NaN / Infinity / 负数 / 小数一律响亮失败 ——
  // `attempt >= maxRetries` 对 NaN 恒假、对 Infinity 永不成立 ⇒ 那是无限重试。
  const maxRetries = resolveMaxRetries(options.maxRetries, 'createAnthropicClient');
  const timeoutMs = typeof options.timeout === 'number' ? options.timeout : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    // NaN / Infinity 会被 setTimeout 钳到 1ms（每个请求立即「超时」），0 / 负数同理无意义 ——
    // 响亮抛错，不静默生效（与 AsyncRunner 对 runTimeoutMs 的构造期校验同款）。
    throw new Error(
      `createAnthropicClient：timeout 必须为正的有限毫秒数（${zeroClauseOf('createAnthropicClient.timeout')}），收到 ${String(options.timeout)}`,
    );
  }
  // 上界（2026-09-28）：「正的有限数」还不够 —— 超过 2^31-1ms（约 24.86 天）的延迟
  // Node 不会遵守（stderr 一行警告 + 钳到 1ms）⇒「30 天超时」变成「每个请求立即超时」。
  // 上限单源在 core/timeout.ts（composeSignal 直喂 setTimeout 的正是这个值）。
  if (timeoutMs !== undefined) assertTimerDelay(timeoutMs, 'createAnthropicClient 的 timeout');

  return {
    messages: {
      stream(params) {
        const textCallbacks: Array<(delta: string) => void> = [];
        // **立即发起请求**（eager，与 SDK 的 stream() 语义一致）：调用方可以先等
        // on('text') 分片、后 await finalMessage()（scripts/e2e-live.ts 步骤 ⑤
        // 就是这个形态）—— 若惰性到 finalMessage() 才发请求，那种形态永远等不到
        // 第一个分片。同步注册的回调不会漏分片：网络 I/O 不可能同步完成。
        const work = (async (): Promise<Message> => {
          // signal 是契约字段，不是 API 字段：摘出后 body 才序列化（残留会污染请求体）
          const { signal: paramsSignal, ...bodyParams } = params;
          const { signal, cleanup } = composeSignal(paramsSignal, timeoutMs);
          try {
            const res = await postWithRetries(
              `${baseURL}/v1/messages`,
              {
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01',
                ...(apiKey ? { 'x-api-key': apiKey } : {}),
              },
              JSON.stringify({ ...bodyParams, stream: true }),
              signal,
              maxRetries,
            );

            // 内容协商（与 openai.ts 同款）：个别兼容端点会忽略 stream:true 直接回整份 JSON
            const ctype = res.headers.get('content-type') ?? '';
            if (!ctype.includes('event-stream')) {
              const body = (await res.json()) as Message & {
                error?: { type?: string; message?: string };
              };
              // 回落路径不能强转了事：「HTTP 200 裹错误」在非流式形态下同样存在
              // （流式路径由下方 readAnthropicStream 的 error 事件分支处理）。此前这里
              // 直接强转 Message：body 是 {"error":{...}} 时 content 为 undefined，
              // textOf 的 .filter() 抛裸 TypeError → classifyError 判 unknown/不可重试
              // —— 同一事件走流式路径却是带 status 的可重试错误，两本账。
              if (body.error) {
                throw new AnthropicApiError(
                  statusOfStreamError({ type: body.error.type }),
                  `Anthropic 非流式响应携带错误（${body.error.type ?? 'unknown'}）：` +
                    (body.error.message ?? JSON.stringify(body).slice(0, 300)),
                );
              }
              // content 不是数组 = 200 但没给可用补全（网关截断 / 兼容端点 bug）：
              // 与流式「未见 message_start」同款，按上游故障抛出而不是让 textOf 炸 TypeError。
              // stop_reason 缺失**不拦**：引擎 turn.ts 有 unknown_stop_reason 兜底按失败收尾。
              if (!Array.isArray(body.content)) {
                throw new AnthropicApiError(
                  500,
                  'Anthropic 非流式响应缺 content 数组；响应无可用补全，按上游故障处理',
                );
              }
              // usage 缺失（端点没回计量）也要如实标出来 —— 别让 0 冒充读数（S2）
              const message: Message = body.usage
                ? body
                : { ...body, usage: { input_tokens: 0, output_tokens: 0, unreported: true } };
              // 分隔符 `''`：回落的原文本来就是一整段，拼回去要与流式累积的文本逐字一致
              const full = textOf(message, '');
              if (full) for (const cb of textCallbacks) cb(full);
              return message;
            }

            if (!res.body) {
              throw new AnthropicApiError(
                500,
                'Anthropic 流式响应没有 body（端点声明了 event-stream 却没给流）',
              );
            }
            return await readAnthropicStream(res.body, params.model, textCallbacks);
          } finally {
            cleanup();
          }
        })();
        // 调用方可能只收分片、从不 await finalMessage()：挂个空 catch 防 unhandled rejection
        // （finalMessage 返回的仍是原 promise，await 它的调用方照常拿到 rejection）
        work.catch(() => {});
        return {
          on(event: 'text', cb: (delta: string) => void) {
            if (event === 'text') textCallbacks.push(cb);
          },
          finalMessage: () => work,
        };
      },
    },
  };
}

// —— 请求与重试（SDK 缺省语义的手写等价）——

/**
 * 可重试的 HTTP 状态：408 / 409 / 429 / 5xx —— 与 SDK 缺省一致。
 * 注意这是 **client 内重试**这一层；重试耗尽（或本就不重试）后抛出的
 * `AnthropicApiError` 由 `engine/errors.ts` 的鸭子分类另行归类（408/409 落
 * api/不可重试、429 落 rate_limit、5xx 落 server）—— 那是「这次失败怎么记账、
 * 引擎外层要不要再来一轮」的语义，两层各司其职，不互相替代。
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * 带重试的 POST。返回首个 2xx 响应；不可重试错误与重试耗尽都抛
 * `AnthropicApiError`（HTTP 错误）或原始网络错误（fetch reject）。
 * abort（外部 signal 或 timeout 合成信号）原样向上 —— 引擎靠 `name === 'AbortError'` 判。
 */
async function postWithRetries(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal | undefined,
  maxRetries: number,
): Promise<Response> {
  let retryAfter: string | null = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      // 退避期间被中止：以 AbortError 收场（与引擎的 sleep 同语义）
      await interruptibleSleep(backoffMs(attempt, retryAfter), signal, '请求已被取消');
      retryAfter = null;
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      // abort 原样向上；signal 已中止时 fetch 的 reject 必为 abort 语义
      if ((e as { name?: unknown })?.name === 'AbortError' || signal?.aborted) throw e;
      // 其余 reject 是网络失败（undici 的 TypeError: fetch failed，cause 带 errno）
      if (attempt >= maxRetries) throw e;
      continue;
    }
    if (res.ok) return res;
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (isRetryableStatus(res.status) && attempt < maxRetries) {
      // 429 的 retry-after 尤其要尊重（限流窗口是上游说了算）
      retryAfter = res.headers.get('retry-after');
      continue;
    }
    throw new AnthropicApiError(res.status, `Anthropic 请求失败（HTTP ${res.status}）：${text}`);
  }
}

// 退避计算器（backoffMs）与 interruptibleSleep 的单源都在 `core/timeout.ts` ——
// 引擎层那份 ±20% 的 backoffDelay 与这里的 ±25% + retry-after 是**两种策略**，
// 刻意不合并（合并即改行为，理由写在 core/timeout.ts 的 backoffMs 注释里）。

/**
 * 合成 params.signal 与 timeout（任一触发即中止）。
 * 不用 `AbortSignal.any`：它 Node 20+ 才有，本包 `engines` 承诺 >=18。
 * cleanup 由调用方在请求结束后调用（清计时器与监听器，防泄漏）。
 */
function composeSignal(
  paramsSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs == null) return { signal: paramsSignal, cleanup: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    // 超时以 TimeoutError 收场：分类按连接错误（可重试），与 SDK 的
    // APIConnectionTimeoutError → connection 同语义
    controller.abort(new DOMException(`Anthropic 请求超过 ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  timer.unref(); // 兜底计时器不得拽住进程（spec 2026-09-14 ref-deadline-timer 同条教训）
  const onAbort = (): void => controller.abort(paramsSignal?.reason);
  if (paramsSignal) {
    if (paramsSignal.aborted) controller.abort(paramsSignal.reason);
    else paramsSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      paramsSignal?.removeEventListener('abort', onAbort);
    },
  };
}

// —— SSE 消费与 Message 组装 ——

/**
 * message_start / message_delta 携带的 usage（字段按端点回报透传，缺省 0 在组装时补）。
 *
 * 四个字段都建模成 `number | null` **是有意的**，与 `core/message.ts` 的 `MessageUsage`
 * （input/output 必填非 null）不矛盾：这里是**线路形态**（厂商/网关可能显式回 null，
 * 表示「这次不报」），那边是**归一后的产物**（`?? 0` 已兜过底）。两层语义不同，
 * 别把它们「拉齐」—— 拉齐会同时弄错一头。
 */
interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * 并入 message_delta 的累计 usage：**跳过 null/undefined**。
 *
 * `{ ...base, ...delta }` 在这里是错的：RawUsage 的字段允许显式 `null`，
 * 浅合并会让 delta 里的 null **覆盖** base 已经拿到的真实数字。真实场景（网关/代理型
 * 端点）：message_start 报 `input_tokens: 7 / cache_read: 3`，随后的 message_delta 只带
 * `{ output_tokens: 9, input_tokens: null, cache_*: null }` —— 浅合并把四项全清成 null，
 * 末尾的 `?? 0` 再归零，于是该回合 input/cache token 与 costEstimate 一起塌成 0，
 * trace 汇总、buildRunReport、maxCostUsd 护栏跟着一起少算。
 *
 * 缺值的正确语义是「保持已有值」，不是「清空已有值」。
 */
function mergeUsage(base: RawUsage, delta: RawUsage): RawUsage {
  const out: RawUsage = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** 流式分片（`data:` 行的 payload；事件类型在 payload 的 `type` 字段，不在 `event:` 行） */
interface StreamEvent {
  type?: string;
  index?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: RawUsage;
  };
  content_block?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    id?: string;
    name?: string;
    /** redacted_thinking 块的数据载体（不透明字符串，原样透传，不解读） */
    data?: string;
    /** 未知块型的其余字段：原样保留进累积器，随 finalMessage 透出（不丢） */
    [key: string]: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  usage?: RawUsage;
  /** 上游把故障塞进 200 的流里时的形态（与 openai.ts 处理的同款） */
  error?: { type?: string; message?: string };
}

/**
 * content_block `index` 的合法上限。官方端点的块数是个位数；index 是**外部输入**，
 * `blocks[index] = acc` 对超大 index 会造出稀疏数组 —— 之后 `for (const b of blocks)` 与
 * `reduce` 都按 length 迭代（含空洞），index=1e9 就是十亿次空转（畸形/恶意端点的 DoS 面）。
 */
const MAX_STREAM_BLOCK_INDEX = 1024;

/** 每个 content block 的累积器（文本/思考/工具入参都是分片拼接的） */
interface BlockAcc {
  type: string;
  text: string;
  thinking: string;
  signature: string;
  id: string;
  name: string;
  /** tool_use 的 input：JSON 字符串分片，stop 后整体 parse */
  partialJson: string;
  /**
   * content_block_start 内联的 tool_use.input（对象形态）。
   * 官方端点这里恒为 `{}`（完整入参走 input_json_delta 分片）；个别兼容端点会把
   * 完整 input 内联在 start 事件且不发 delta —— 不收下它，工具会拿 `{}` 静默执行。
   * 取舍规则（组装处兑现）：**delta 累积非空则以 delta 为准**（官方形态不受影响，
   * 内联 `{}` + 分片维持旧语义），否则回落到内联值。
   */
  inlineInput?: unknown;
  /**
   * 非 text/tool_use/thinking 的块（redacted_thinking 与一切未知块型）：
   * content_block_start 的原始块对象原样携带，finalMessage 原样透出 ——
   * 正是 `core/message.ts` 的 UnknownContentBlock 兜底成员的设计用途。
   */
  raw?: Record<string, unknown>;
}

/**
 * 消费 `text/event-stream` 并组装成 Message。事件处理：
 *
 * | 事件 | 动作 |
 * |---|---|
 * | message_start | 拿 id / model / 初始 usage |
 * | content_block_start | 按 index 建块累积器：text / tool_use / thinking 收拼；redacted_thinking 与未知块型原样携带（透出时不丢） |
 * | content_block_delta | text_delta → 拼文本并触发 on('text')；input_json_delta → 拼 partialJson；thinking_delta → 拼 thinking；signature_delta → 累积进 thinking 块的 signature |
 * | content_block_stop | 无动作（块按 index 累积，无需收尾） |
 * | message_delta | stop_reason / stop_sequence + 累计 usage 合并（后者覆盖前者出现的字段） |
 * | message_stop / ping | 结束 / 忽略 |
 * | error | 抛 AnthropicApiError（类型映射 status：rate_limit→429、overloaded→529、请求/鉴权类→400、其余→500） |
 *
 * thinking 块只做「收拼 + signature 累积 + redacted/未知块原样透传」——
 * 框架**从不主动请求 extended thinking**，这些是端点自己开了之后的兜底不丢。
 * 与非流式 `toAnthropicMessage`（openai.ts）的空 choices 守卫同款：
 * 整条流走完都没见 message_start = 上游故障，**抛出**而不是组装成
 * 「stop_reason=null、content=[]、usage 全 0」的假成功。
 */
async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  textCallbacks: Array<(delta: string) => void>,
): Promise<Message> {
  const blocks: BlockAcc[] = [];
  let started = false;
  /** 是否见到 `message_stop`（流的终止标记）—— 截断判据的一半，见循环后的说明 */
  let sawStop = false;
  let id = '';
  let model = '';
  let stopReason: string | null = null;
  let stopSequence: string | null = null;
  let usage: RawUsage = {};
  // 上游**到底报没报** usage：空对象（没报）与「报了全 0」是两回事 ——
  // 前者要如实标 `unreported`，别让 0 冒充读数（2026-09-28 外部深评 S2）
  let sawUsage = false;

  for await (const line of sseLines(body)) {
    if (!line.startsWith('data:')) continue; // 忽略 event: / 注释 / 空行
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      continue; // 半截/畸形分片不该毁掉整个流（与 openai.ts 同款）
    }
    switch (event.type) {
      case 'message_start': {
        started = true;
        id = event.message?.id ?? '';
        model = event.message?.model ?? '';
        if (event.message?.usage) sawUsage = true;
        usage = { ...event.message?.usage };
        break;
      }
      case 'content_block_start': {
        const cb = event.content_block ?? {};
        const index = event.index ?? blocks.length;
        // index 是外部输入：超大 / 负数 / 非整数会把 blocks 造成稀疏数组（见
        // MAX_STREAM_BLOCK_INDEX 注释）—— 畸形输入响亮抛错，不静默拖垮组装
        if (!Number.isInteger(index) || index < 0 || index > MAX_STREAM_BLOCK_INDEX) {
          throw new AnthropicApiError(
            500,
            `Anthropic 流式响应的 content_block index 非法（${String(event.index)}）：` +
              `必须是 0..${MAX_STREAM_BLOCK_INDEX} 的整数，按上游故障处理`,
          );
        }
        const type = cb.type ?? 'text';
        const acc: BlockAcc = {
          type,
          text: typeof cb.text === 'string' ? cb.text : '',
          thinking: typeof cb.thinking === 'string' ? cb.thinking : '',
          signature: typeof cb.signature === 'string' ? cb.signature : '',
          id: typeof cb.id === 'string' ? cb.id : '',
          name: typeof cb.name === 'string' ? cb.name : '',
          partialJson: '',
        };
        // tool_use 块若内联对象形态 input（兼容端点形态），收下做初值 ——
        // 官方端点恒给 `{}` 且后续 input_json_delta 会覆盖（delta 非空以 delta 为准）
        if (
          type === 'tool_use' &&
          cb.input &&
          typeof cb.input === 'object' &&
          !Array.isArray(cb.input)
        ) {
          acc.inlineInput = cb.input;
        }
        // redacted_thinking（数据在 `data` 字段）与一切未知块型：原始块对象
        // 原样携带 —— 不丢成空文本块，finalMessage 原样透出
        if (type !== 'text' && type !== 'tool_use' && type !== 'thinking') {
          acc.raw = { ...cb, type };
        }
        blocks[index] = acc;
        break;
      }
      case 'content_block_delta': {
        const b = blocks[event.index ?? -1];
        const d = event.delta;
        if (!b || !d) break;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          b.text += d.text;
          // 逐 token 下发 —— 「打字机」效果的全部来源
          for (const cb of textCallbacks) cb(d.text);
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          b.partialJson += d.partial_json;
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.thinking += d.thinking;
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          b.signature += d.signature;
        }
        break;
      }
      case 'message_delta': {
        const d = event.delta;
        if (d?.stop_reason) stopReason = d.stop_reason;
        if (d?.stop_sequence !== undefined) stopSequence = d.stop_sequence;
        // message_delta 的 usage 是累计口径（output_tokens 为累计值，cache 计量在此回报）。
        // 走 mergeUsage 而非浅合并：显式 null 不得清掉 message_start 已拿到的真实值。
        if (event.usage) {
          sawUsage = true;
          usage = mergeUsage(usage, event.usage);
        }
        break;
      }
      case 'error': {
        // 上游故障以错误事件下发（HTTP 仍是 200）—— 不抛出就会被组装成假成功，
        // run 结论与真实相反（openai.ts 处理过同款形态）
        const err = event.error ?? {};
        throw new AnthropicApiError(
          statusOfStreamError({ type: err.type }),
          `Anthropic 流内错误（${err.type ?? 'unknown'}）：${err.message ?? payload.slice(0, 300)}`,
        );
      }
      case 'message_stop': {
        sawStop = true;
        break;
      }
      default:
        break; // content_block_stop / ping 及未知事件：忽略
    }
  }

  if (!started) {
    throw new AnthropicApiError(
      500,
      'Anthropic 流式响应为空（未见 message_start）；响应无可用补全，按上游故障处理',
    );
  }
  // 终止证据：收到 `message_stop`，或拿到 `stop_reason`（由 message_delta 携带）。二者皆无
  // = 流在上游 / 代理侧被提前关闭 —— **必须抛出**。
  //
  // 这一条**不能**挂在「累积为空」上（openai.ts 踩过同一个坑）：截断发生在已吐出半句话之后时
  // 内容非空 ⇒ 判据不触发 ⇒ `stop_reason: null` 被 resolveStopReason 判成
  // `unknown_stop_reason`（那是 stop-reason 解析分支，**不是重试判据**）⇒ 引擎的重试一次都
  // 不会发生，且 trace 把它记成「模型返回了未识别的 stop_reason」—— 把「上游被截断」
  // 误诊成「模型协议异常」，排障方向被带偏。
  if (!sawStop && stopReason === null) {
    const chars = blocks.reduce((n, b) => n + b.text.length, 0);
    throw new AnthropicApiError(
      500,
      `Anthropic 流式响应被截断（未收到 message_stop，也未收到 message_delta 的 stop_reason；` +
        `已累积 ${blocks.length} 个内容块、${chars} 字符文本）；响应不完整，按上游故障处理`,
    );
  }

  const content: ContentBlock[] = [];
  for (const b of blocks) {
    if (!b) continue; // index 跳号留的洞
    if (b.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        // delta 分片非空以分片为准（官方形态：start 内联 `{}` + input_json_delta 累积）；
        // 一个 delta 都没来时回落到 start 事件内联的 input（兼容端点形态），再缺省 {}
        input: b.partialJson ? parseToolInput(b.partialJson) : (b.inlineInput ?? {}),
      } as ToolUseBlock);
    } else if (b.type === 'thinking') {
      content.push({
        type: 'thinking',
        thinking: b.thinking,
        signature: b.signature,
      } as unknown as ContentBlock);
    } else if (b.raw) {
      // redacted_thinking / 未知块型：原样透出（UnknownContentBlock 兜底成员承载，
      // 无需为它新增具体类型 —— `data` 等字段跟着原始对象走，消费方自行收窄读取）
      content.push(b.raw as unknown as ContentBlock);
    } else {
      content.push({ type: 'text', text: b.text } as TextBlock);
    }
  }

  return {
    id: id || 'msg-unknown',
    type: 'message',
    role: 'assistant',
    model: model || fallbackModel,
    content,
    stop_reason: stopReason as StopReason,
    stop_sequence: stopSequence,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      // 上游全程没给 usage ⇒ 上面四个 0 是**替身值**，如实标出来（S2）
      ...(sawUsage ? {} : { unreported: true as const }),
    },
  } as Message;
}

// 「流内 error → HTTP status」的判定在 `adapter-options.ts`（与 openai.ts **共用一份**，
// 2026-09-28 外部深评 S3：此前两份实现靠注释互相喊话对齐）—— 别在这里再写一份。

/** tool_use 的 input 是分片拼出的 JSON 字符串；非法时原样交给下游 schema 校验（同 openai.ts） */
function parseToolInput(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
