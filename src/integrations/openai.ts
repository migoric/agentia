import type {
  ContentBlock,
  ContentBlockParam,
  ImageBlockParam,
  Message,
  MessageParam,
  StopReason,
  TextBlock,
  TextBlockParam,
  ToolParam,
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from '../core/message.js';
import { resolveMaxRetries, statusOfStreamError } from './adapter-options.js';
import { textOf } from '../core/text.js';
import type { Usage } from '../core/trace.js';
import { sseLines } from '../core/sse.js';
import { backoffMs, interruptibleSleep, retryAfterMsOf } from '../core/timeout.js';
import type { ModelClient } from '../core/tool.js';

/**
 * OpenAI 兼容端点适配器（R4 多模型）。
 *
 * 把 engine 的 Anthropic 形态请求翻译成 OpenAI chat.completions 请求，
 * 响应再翻译回 Message —— 产出的 ModelClient 可直接喂给
 * executeRun / runAgent 的 client 选项。兼容端点（DeepSeek 等）换 baseURL 即可。
 *
 * 剩余边界（**协议层面无法对齐**，不是没做）：
 * - cache_creation 恒 0：OpenAI 形态没有「缓存写」计量字段；
 *   但 DeepSeek 的 `prompt_cache_hit_tokens` 会映射进 `cache_read_input_tokens`
 *   （且从 input_tokens 里**拆出**，不双计 —— 见 `inputUsageOf`）；纯 OpenAI 端点
 *   没有这两个字段，cache_read 仍恒 0；
 * - refusal 为近似：finish_reason=content_filter 近似映射为 'refusal'，
 *   语义上接近但不等同 Anthropic 的流式分类器干预。
 *
 * 流式（C3）：默认 `stream: true`，逐 token 触发 `on('text')`；`tool_calls` 的
 * 分片按 `index` 累积后再汇成完整 `tool_use`。带 `stream_options.include_usage`
 * 取 token 计量 —— 个别端点不认这个字段，可设 `stream: false` 退回一次性响应。
 */
export interface OpenAIClientOptions {
  /** 缺省读 env OPENAI_API_KEY */
  apiKey?: string;
  /** 缺省 https://api.openai.com；兼容端点直接替换（如 https://api.deepseek.com） */
  baseURL?: string;
  /**
   * 是否用流式（缺省 true，逐 token 回调）。设 false 退回一次性响应：
   * 兼容端点若不支持 `stream_options` 而报 400，用它兜底。
   */
  stream?: boolean;
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
  /**
   * 单次请求的**客户端内层**重试次数（不含首次；408 / 409 / 429 / 5xx / 连接错误）。
   * 缺省 2 —— 与 `anthropic.ts` 的 `createAnthropicClient` **逐字对齐**：两条适配器
   * 必须对同一故障给出同样的尝试次数，否则「同一个 429」在 anthropic 上打 3 次网络
   * 请求、在 openai 上只打 2 次（引擎层那一次），成本与延迟随厂商而异却没人发现。
   * 引擎层另有一层重试（`RunAgentOptions.retry`），两层叠加；建议二选一调。
   */
  maxRetries?: number;
}

/**
 * OpenAI 兼容端点错误：非 2xx 响应，或 200 流内嵌的 error 分片、被截断的流。
 *
 * **带数值 `status` 不是装饰** —— `engine/errors.ts` 的错误分类是鸭子类型，只认数值
 * `status`（429 → rate_limit、5xx → server、其余 4xx → api）。此前本文件一律抛裸
 * `Error`，于是所有失败都落 `unknown` + `retryable:false`，引擎层那 3 次重试
 * **一次都不会发生**：DeepSeek 这类兼容端点吃一个 429 就整轮 run 失败。
 * 与 `anthropic.ts` 的 `AnthropicApiError` 同形（那边一直是对的）。
 */
export class OpenAICompatApiError extends Error {
  readonly status: number;
  /** 流中途失败时已收到的计量（2026-11-07 深评；语义见 anthropic.ts 同名字段） */
  readonly partialUsage?: Usage;
  /** 上游 `Retry-After`（毫秒，已夹到定时器可兑现区间） */
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, partialUsage?: Usage, retryAfterMs?: number) {
    super(message);
    this.name = 'OpenAICompatApiError';
    this.status = status;
    if (partialUsage !== undefined) this.partialUsage = partialUsage;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export function createOpenAIClient(opts: OpenAIClientOptions = {}): ModelClient {
  const baseURL = (opts.baseURL ?? 'https://api.openai.com').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const useStream = opts.stream ?? true;
  // 与 anthropic 对齐的缺省（见 OpenAIClientOptions.maxRetries 的注释：两条适配器
  // 对同一故障必须给出同样的尝试次数，否则同一个 429 在两边的网络请求数不同）+
  // 同一份构造期校验（NaN / Infinity / 负数 / 小数一律响亮失败）。
  const maxRetries = resolveMaxRetries(opts.maxRetries, 'createOpenAIClient');

  return {
    messages: {
      stream(params) {
        const textCallbacks: Array<(delta: string) => void> = [];
        return {
          on(event: 'text', cb: (delta: string) => void) {
            if (event === 'text') textCallbacks.push(cb);
          },
          async finalMessage(): Promise<Message> {
            const req = toOpenAIRequest(params);
            const res = await postWithRetries(
              fetchImpl,
              `${baseURL}/v1/chat/completions`,
              {
                method: 'POST',
                // 不跟随重定向：307/308 会把 prompt body 发到另一个 origin（authorization
                // 会被 undici 剥掉，但 body 不会）。
                redirect: 'manual',
                headers: {
                  'content-type': 'application/json',
                  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
                },
                // signal 必须转发：否则调用方（含 A1 的取消 / 超时）无法中止在飞请求
                ...(params.signal ? { signal: params.signal } : {}),
                body: useStream
                  ? JSON.stringify({
                      ...req,
                      stream: true,
                      stream_options: { include_usage: true },
                    })
                  : JSON.stringify(req),
              },
              params.signal,
              maxRetries,
            );
            if (!res.ok) {
              // 走到这里只可能是**不可重试**的失败（可重试状态已在 postWithRetries 内
              // 重试过，且是最后一次仍失败才返回）—— 4xx 里除 408/409/429 都在此列。
              const body = await res.text();
              throw new OpenAICompatApiError(
                res.status,
                `OpenAI 请求失败 ${res.status}: ${body.slice(0, 200)}`,
                undefined,
                retryAfterMsOf(res.headers.get('retry-after')),
              );
            }

            // 内容协商：**按响应实际形态**决定怎么解析，而不是按我们请求了什么 ——
            // 部分兼容端点会忽略 `stream: true` 直接回一整份 JSON（此时退回 JSON 路径，
            // 行为与旧版本一致，只是没有逐 token 的「打字机」效果）。
            const ctype = res.headers.get('content-type') ?? '';
            const isSse = ctype.includes('event-stream');
            if (!useStream || !isSse) {
              const rawBody = res.clone();
              let data: OpenAIChatResponse;
              try {
                data = (await res.json()) as OpenAIChatResponse;
              } catch {
                throw new OpenAICompatApiError(
                  500,
                  `OpenAI 兼容端点返回了非 JSON 响应（content-type=${ctype}）：` +
                    (await rawBody.text().catch(() => '')).slice(0, 200),
                );
              }
              const message = toAnthropicMessage(data, params.model);
              // 非流式：完整文本一次性交给回调（与流式的最终结果一致）
              // 分隔符 `''`：回落的原文本来就是一整段，拼回去要与流式累积的文本逐字一致
              const full = textOf(message, '');
              if (full) for (const cb of textCallbacks) cb(full);
              return message;
            }

            if (!res.body) {
              throw new OpenAICompatApiError(
                500,
                'OpenAI 流式响应没有 body（端点声明了 event-stream 却没给流）',
              );
            }
            return await readStream(res.body, params.model, textCallbacks);
          },
        };
      },
    },
  };
}

// —— OpenAI 形态（手写最小子集，零依赖）——

interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 多模态内容分片（C3）：文本块与图片块各自对应一种 part */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChatRequest {
  model: string;
  max_tokens: number;
  messages: OpenAIMessage[];
  tools?: Array<{ type: 'function'; function: OpenAIToolFunction }>;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /**
   * DeepSeek 等兼容端点的上下文缓存计量（纯 OpenAI 端点没有这两个字段）。
   * 口径与 Anthropic **相反**：`prompt_tokens = hit + miss`，hit **已含在** prompt_tokens
   * 里（Anthropic 的 input_tokens 则不含 cache_read）——映射时必须拆开，见 `inputUsageOf`。
   */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** 流式分片（`data:` 行的 payload） */
interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  /** 只有带 stream_options.include_usage 时，最后一个 chunk 才带 usage */
  usage?: OpenAIUsage;
  /**
   * 上游把故障塞进 200 的流里时的形态（`data: {"error":{...}}` 然后 [DONE]）——
   * 兼容端点（DeepSeek 等）限流/内部错误常这么回，而不是非 2xx。
   */
  error?: { message?: string; type?: string; code?: string | null };
}

type StreamParams = {
  model: string;
  max_tokens: number;
  system?: string | TextBlockParam[];
  tools?: ToolParam[];
  messages: MessageParam[];
  signal?: AbortSignal;
};

// —— 请求与重试（与 anthropic 的 postWithRetries 同语义；函数体独立是有意的）——
//
// 为什么不共用一份 postWithRetries：`integrations` 只能依赖 core，而两者的**响应消费**
// 不同（这里返回 Response 后自己要按 content-type 分流，anthropic 那边直接读 SSE），
// 抽到 core 只会得到「参数比逻辑多」的壳子。真正必须一致的是**语义**：可重试状态码集合、
// 退避曲线、retry-after 的尊重 —— 退避与可中断 sleep 的实现单源在 `core/timeout.ts`
// （两条适配器 import 同一份），状态码集合与尝试次数由
// `tests/integrations/adapter-parity.test.ts` 的场景矩阵对拍守着。

/** 可重试的 HTTP 状态：408 / 409 / 429 / 5xx（与 anthropic 逐字对齐） */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * 带重试的 POST。返回首个非「可重试失败」的响应（含 4xx —— 交给调用方转成结构化错误）。
 * 可重试状态耗尽 / 网络失败耗尽时返回或抛出最后一次的结果。
 * abort 由 `signal` 传播：fetch reject 的 AbortError 与退避期间的中止都原样向上。
 */
async function postWithRetries(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  maxRetries: number,
): Promise<Response> {
  let retryAfter: string | null = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await interruptibleSleep(backoffMs(attempt, retryAfter), signal);
    retryAfter = null;
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      // abort 原样向上（引擎靠 name === 'AbortError' 判）；其余是网络失败
      if ((e as { name?: unknown })?.name === 'AbortError' || signal?.aborted) throw e;
      if (attempt >= maxRetries) throw e;
      continue;
    }
    if (res.ok || !isRetryableStatus(res.status) || attempt >= maxRetries) return res;
    // 重试前排空响应体（与 anthropic.ts 的 postWithRetries 对齐）：不读的话这次失败的
    // 诊断体直接丢在 socket 缓冲区。实测 Node 的 undici 会后台丢弃未消费的 body
    // （连接复用不受影响），所以这是对齐 + 不丢诊断体，**不是**堵连接泄漏。
    await res.text().catch(() => '');
    retryAfter = res.headers.get('retry-after');
  }
}

/** Anthropic 请求形态 → OpenAI chat.completions 请求 */
function toOpenAIRequest(params: StreamParams): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  if (params.system) {
    messages.push({
      role: 'system',
      content:
        typeof params.system === 'string'
          ? params.system
          : params.system.map((b) => b.text).join('\n'),
    });
  }

  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'user') {
      // tool_result blocks：每个 block 一条 role=tool 消息；其余合成一条 user
      const blocks = m.content as ContentBlockParam[];
      const toolResults = blocks.filter((b): b is ToolResultBlockParam => b.type === 'tool_result');
      const rest = blocks.filter((b) => b.type !== 'tool_result');
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content:
            tr.content === undefined
              ? ''
              : typeof tr.content === 'string'
                ? tr.content
                : JSON.stringify(tr.content),
        });
      }
      if (rest.length > 0) messages.push({ role: 'user', content: renderUserContent(rest) });
    } else {
      // assistant：文本部分进 content（无则 null），tool_use → tool_calls
      const blocks = m.content as ContentBlockParam[];
      const text = blocks
        .filter((b): b is TextBlockParam => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const toolUses = blocks.filter((b): b is ToolUseBlockParam => b.type === 'tool_use');
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((tu) => ({
                id: tu.id,
                type: 'function' as const,
                function: { name: tu.name, arguments: JSON.stringify(tu.input) },
              })),
            }
          : {}),
      });
    }
  }

  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages,
    ...(params.tools && params.tools.length > 0
      ? {
          tools: params.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              parameters: t.input_schema,
            },
          })),
        }
      : {}),
  };
}

/**
 * user 消息的非 tool_result 块 → OpenAI content（C3 多模态）。
 *
 * - 文本块 → `{type:'text'}`；
 * - 图片块 → `{type:'image_url'}`，base64 源编成 data URL，url 源直接透传；
 * - **没有图片时回落成纯字符串** —— 部分兼容端点只接受 string content，
 *   无脑上数组会把原本能跑的通路弄坏（旧行为就是纯字符串）。
 */
function renderUserContent(blocks: ContentBlockParam[]): string | OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  let hasImage = false;
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push({ type: 'text', text: (b as TextBlockParam).text });
      continue;
    }
    if (b.type === 'image') {
      const url = imageUrlOf(b as ImageBlockParam);
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
        hasImage = true;
        continue;
      }
    }
    // 其余块类型 JSON 兜底：宁可把原文交给模型，也不静默丢内容
    parts.push({ type: 'text', text: JSON.stringify(b) });
  }
  if (!hasImage) {
    return parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }
  return parts;
}

/** Anthropic image block → OpenAI 能吃的 URL（base64 编 data URL；url 源透传） */
function imageUrlOf(b: ImageBlockParam): string | null {
  const src = b.source as { type?: string; media_type?: string; data?: string; url?: string };
  if (src.type === 'base64' && src.data) {
    return `data:${src.media_type ?? 'image/png'};base64,${src.data}`;
  }
  if (src.type === 'url' && src.url) return src.url;
  return null;
}

/** 流式累积器：文本拼接 + tool_calls 按 index 分片累积 */
interface StreamAccumulator {
  id?: string;
  model?: string;
  text: string;
  /** index → 半成品（`arguments` 是分片拼接的，这正是「易错」的那一步） */
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finish?: string | null;
  usage?: OpenAIUsage;
}

// 「流内 error 分片 → HTTP status」的判定在 `adapter-options.ts`（与 anthropic.ts
// **共用一份**，2026-09-28 外部深评 S3：此前两份实现靠注释互相喊话对齐）——
// 别在这里再写一份。

/**
 * 消费 `text/event-stream` 并组装成 Message。
 *
 * 关键点（每条都有对应单测）：
 * - **`id` / `name` 取首次出现的值**（OpenAI 在第一个分片给全），
 *   **`arguments` 按分片拼接** —— 一次调用的 JSON 参数会被拆成多片；
 * - 多个工具并行调用时**必须按 `index` 归并**，不能按到达顺序新建；
 * - `usage` 在**最后一个 chunk**（choices 为空的那条）才出现；
 * - `[DONE]` 是结束哨兵，之后不再有数据；
 * - 流内 `error` 分片（上游把故障塞进 200 的流）与「流空了」都**抛错** ——
 *   与非流式 `toAnthropicMessage` 的空 choices 守卫同款，不静默映射成成功空回复。
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  textCallbacks: Array<(delta: string) => void>,
): Promise<Message> {
  const acc: StreamAccumulator = { text: '', toolCalls: new Map() };
  let sawDone = false;
  for await (const line of sseLines(body)) {
    if (!line.startsWith('data:')) continue; // 忽略 event: / id: / 注释 / 空行
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      sawDone = true;
      break;
    }
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIStreamChunk;
    } catch {
      continue; // 半截/畸形分片不该毁掉整个流（后面还有正常数据）
    }
    if (chunk.error) {
      // 上游故障以错误分片下发（HTTP 仍是 200）—— 不抛出就会被组装成
      // 「stop_reason=end_turn、content=[]、usage 全 0」的假成功，run 结论与真实相反。
      // status 由分片的 type/code 反推：限流要让引擎认出来才谈得上重试。
      throw new OpenAICompatApiError(
        statusOfStreamError(chunk.error),
        `OpenAI 流式响应携带错误分片: ${chunk.error.message ?? JSON.stringify(chunk.error)}` +
          (chunk.error.code ? `（code=${chunk.error.code}）` : ''),
        streamUsageOf(acc),
      );
    }
    applyChunk(acc, chunk, textCallbacks);
  }
  // 终止证据：收到 `[DONE]`，或拿到 finish_reason。二者皆无 = 流在上游/代理侧被提前关闭。
  //
  // 这一条**不能**挂在「累积为空」上（旧实现就是这么写的）：截断发生在已吐出半句话之后时，
  // acc.text 非空 → 旧守卫不触发 → accumulatorToMessage 把 finish=undefined 映射成
  // `end_turn` → **被截断的输出被当作正常收尾上报**，与模块头「上游故障绝不映射成成功」相反。
  if (!sawDone && acc.finish == null) {
    throw new OpenAICompatApiError(
      500,
      `OpenAI 流式响应被截断（未收到 [DONE]，也未收到 finish_reason；` +
        `已累积 ${acc.text.length} 字符文本、${acc.toolCalls.size} 个工具调用）；` +
        '响应不完整，按上游故障处理',
      streamUsageOf(acc),
    );
  }
  if (!acc.text && acc.toolCalls.size === 0 && mapStopReason(acc.finish, false) !== 'refusal') {
    // 正常终止却什么都没累积到：与非流式 toAnthropicMessage 的空 choices 守卫同款 ——
    // 上游故障（网关截断、协议不兼容）不得静默映射成成功空回复，抛出交 engine 按 error 收尾。
    //
    // 例外是 content_filter/refusal：那是**合法**的空回复（模型拒绝作答），非流式路径
    // 同一个响应返回的是 stop_reason='refusal' —— 同一个响应不该在两条路径上两种结论。
    throw new OpenAICompatApiError(
      500,
      `OpenAI 流式响应为空（无 content、无 tool_calls，finish=${acc.finish ?? '缺失'}）；` +
        '响应无可用补全，按上游故障处理',
    );
  }
  return accumulatorToMessage(acc, fallbackModel);
}

/** 把一条流式分片并进累积器 */
function applyChunk(
  acc: StreamAccumulator,
  chunk: OpenAIStreamChunk,
  textCallbacks: Array<(delta: string) => void>,
): void {
  if (chunk.id) acc.id ??= chunk.id;
  if (chunk.model) acc.model ??= chunk.model;
  if (chunk.usage) acc.usage = chunk.usage;

  const choice = chunk.choices?.[0];
  if (!choice) return; // 带 usage 的收尾 chunk 没有 choices
  const delta = choice.delta;
  if (delta?.content) {
    acc.text += delta.content;
    // 逐 token 下发 —— 这就是「打字机」效果的全部来源
    for (const cb of textCallbacks) cb(delta.content);
  }
  for (const tc of delta?.tool_calls ?? []) {
    const index = tc.index ?? 0;
    const entry = acc.toolCalls.get(index) ?? { id: '', name: '', args: '' };
    // id / name 只在首次给全（`??=`）；arguments 必须拼接
    if (tc.id) entry.id ||= tc.id;
    if (tc.function?.name) entry.name ||= tc.function.name;
    if (tc.function?.arguments) entry.args += tc.function.arguments;
    acc.toolCalls.set(index, entry);
  }
  if (choice.finish_reason) acc.finish = choice.finish_reason;
}

/**
 * OpenAI usage → `Message.usage` 输入侧口径对齐（DeepSeek 缓存计量，2026-10-09 外部审查）。
 *
 * DeepSeek 在 usage 里多回 `prompt_cache_hit_tokens`（agent loop 场景前缀缓存命中率常达
 * 80–95%），此前被整个丢弃、cache_read 恒 0 ⇒ 成本/记账系统性失真。映射时的关键口径：
 * **`prompt_tokens` 已含命中部分**（官方口径 `prompt_tokens = hit + miss`），而 Anthropic 形态的
 * `input_tokens` **不含** cache_read、`costEstimate` 对两者分别计价 —— 直接透传会让命中部分
 * 被计两次（一次全价 in、一次 0.1× cache_read）。所以拆出来：`input_tokens` 只留未命中部分
 * （= prompt_tokens − hit，与 miss 同值），`cache_read_input_tokens` 记命中数。
 * 纯 OpenAI 端点没有这两个字段 ⇒ hit 取 0，行为与旧版逐字一致。
 */
function inputUsageOf(u: OpenAIUsage | undefined): {
  inputTokens: number;
  cacheReadTokens: number;
} {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  const prompt = num(u?.prompt_tokens);
  const hit = num(u?.prompt_cache_hit_tokens);
  // Math.max 只兜畸形回报（hit > prompt_tokens）：宁可不拆，也别把 input_tokens 弄成负数
  return { inputTokens: Math.max(0, prompt - hit), cacheReadTokens: hit };
}

/** 累积器里已收到的 usage（失败路径用；没收到则 undefined） */
function streamUsageOf(acc: StreamAccumulator): Usage | undefined {
  if (acc.usage === undefined) return undefined;
  const { inputTokens, cacheReadTokens } = inputUsageOf(acc.usage);
  return {
    inputTokens,
    outputTokens:
      typeof acc.usage.completion_tokens === 'number' &&
      Number.isFinite(acc.usage.completion_tokens) &&
      acc.usage.completion_tokens >= 0
        ? acc.usage.completion_tokens
        : 0,
    cacheReadTokens,
    // OpenAI 形态无缓存写计量
    cacheCreationTokens: 0,
  };
}

/** 累积器 → Message */
function accumulatorToMessage(acc: StreamAccumulator, fallbackModel: string): Message {
  const content: ContentBlock[] = [];
  if (acc.text) content.push({ type: 'text', text: acc.text } as TextBlock);

  // 按 index 升序还原调用顺序（Map 保留插入序，但 index 可能乱序到达）
  const calls = [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  let n = 0;
  for (const [, tc] of calls) {
    n++;
    content.push({
      // 端点没给 id 时补一个：engine 会把它当 tool_use_id 回传，空 id 会让配对失败
      id: tc.id || `call_${n}`,
      type: 'tool_use',
      name: tc.name,
      input: parseToolArgs(tc.args),
    } as ToolUseBlock);
  }

  const hasToolCalls = calls.length > 0;
  const { inputTokens, cacheReadTokens } = inputUsageOf(acc.usage);
  return {
    id: acc.id ?? 'chatcmpl-unknown',
    type: 'message',
    role: 'assistant',
    model: acc.model ?? fallbackModel,
    content,
    stop_reason: mapStopReason(acc.finish, hasToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: acc.usage?.completion_tokens ?? 0,
      // OpenAI 形态无「缓存写」计量：恒 0；缓存读见 inputUsageOf（DeepSeek 命中数）
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      // 端点忽略了 stream_options.include_usage（或压根没回）⇒ 上面是**替身 0**，
      // 如实标出来让「成本恒 0」有信号（2026-09-28 外部深评 S2）
      ...(acc.usage ? {} : { unreported: true as const }),
    },
  } as Message;
}

/** tool_call 的 arguments 是模型生成的 JSON 字符串；非法时原样交给下游 schema 校验 */
function parseToolArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** OpenAI chat.completions 响应 → Message */
function toAnthropicMessage(data: OpenAIChatResponse, model: string): Message {
  const choice = data.choices?.[0];
  if (!choice) {
    // 200 但 choices 为空/缺失：上游故障（兼容端点 bug、被网关截断）。
    // 不得静默映射成「成功」——空文本 + usage 全 0 + end_turn 会把一次上游故障
    // 记成正常收尾，run 结论与真实情况相反。抛出交 engine 按 error 收尾。
    throw new OpenAICompatApiError(
      500,
      `OpenAI 兼容端点返回空 choices（id=${data.id ?? 'unknown'}）；响应无可用补全，按上游故障处理`,
    );
  }
  const msg = choice.message ?? {};

  const content: ContentBlock[] = [];
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content } as TextBlock);
  }
  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: parseToolArgs(tc.function.arguments),
    } as ToolUseBlock);
  }

  // 空补全守卫（**非流式**）：与流式路径 accumulatorToMessage 的同款判据对齐。
  // 200 + `message.content = null` + `finish_reason: 'stop'` 是上游故障（网关截断、
  // 兼容端点 bug；`stream:false` 正是文档给的兜底形态），映射成「空文本 + end_turn」
  // 会被记成正常收尾 —— 与模块头「上游故障绝不映射成成功」相反，且同一个响应在流式路径上
  // 会被判失败。例外同流式：`content_filter`（refusal）是**合法**的空回复。
  if (content.length === 0 && mapStopReason(choice?.finish_reason, false) !== 'refusal') {
    throw new OpenAICompatApiError(
      500,
      `OpenAI 兼容端点返回空补全（id=${data.id ?? 'unknown'}，finish=${choice?.finish_reason ?? '缺失'}）；` +
        '响应无可用补全，按上游故障处理',
    );
  }

  const { inputTokens, cacheReadTokens } = inputUsageOf(data.usage);
  return {
    id: data.id ?? 'chatcmpl-unknown',
    type: 'message',
    role: 'assistant',
    model: data.model ?? model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason, (msg.tool_calls?.length ?? 0) > 0),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: data.usage?.completion_tokens ?? 0,
      // OpenAI 形态无「缓存写」计量：恒 0；缓存读见 inputUsageOf（DeepSeek 命中数）
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      // 非流式同理：没回 usage 时不静默填 0（2026-09-28 外部深评 S2）
      ...(data.usage ? {} : { unreported: true as const }),
    },
  } as Message;
}

/**
 * finish_reason → Anthropic stop_reason（content_filter→refusal 为近似映射）。
 *
 * hasToolCalls：**只要响应带 tool_calls 就必须是 tool_use**，不看 finish_reason ——
 * DeepSeek / vLLM / Ollama 等兼容端点在带工具调用时回的是 `stop`；若映射成 end_turn，
 * engine 会在提取工具块之前就收尾（loop 的 end_turn 即终态），工具调用被静默丢弃。
 */
function mapStopReason(finish: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  switch (finish) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      return 'end_turn';
    case 'function_call':
      // legacy `functions` 形态（OpenAI 2023 已废弃）：调用在 `message.function_call` 里，
      // 而本适配器只读现代 `tool_calls` ⇒ **这次调用的名称与入参读不出来**。
      // 绝不能让它落到 default 报 end_turn ——「模型要调工具、工具却没执行」会以成功收尾
      // （本仓库最贵的一类故障，同上面 hasToolCalls 那条注释的病）。
      //
      // 为什么**不做** legacy 兼容：请求侧我们只发 `tool_calls`（见 buildMessages），回灌的
      // `role:'tool'` 消息 legacy-only 端点同样吃不下 ⇒ 半吊子支持比不支持更糟。
      //
      // 为什么是 400 而不是相邻空补全那条 500：这是**确定性不兼容**（换不了结论），
      // 落 classifyError 的 `api`/不可重试；用 500 会被引擎重试三次，每次都重复丢弃同一个调用。
      throw new OpenAICompatApiError(
        400,
        `上游返回 legacy \`function_call\` 形态（finish_reason=function_call）——本适配器只认现代 ` +
          '`tool_calls`，这次调用的名称与入参读不出来。按 end_turn 收尾会把「工具没执行」记成成功，' +
          '故此处响亮失败：请换用支持 tool_calls 的端点或模型。',
      );
    default:
      // 未知 finish_reason **且有正文** ⇒ 按正常收尾（上游只保证它「结束了」）。
      // 空正文那条已在两个调用点各自拦住（流式/非流式），不会走到这里变成「成功空回复」。
      return 'end_turn';
  }
}
