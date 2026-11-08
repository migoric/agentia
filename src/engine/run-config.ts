import type { JsonSchema, ModelClient } from '../core/tool.js';
import { resolveRetry } from './retry.js';
import type { ContextPolicy, ModelFallbackLink, RunAgentOptions } from './types.js';
import type { TraceLimits } from './tracer.js';

/**
 * Agentia —— run 生效旋钮：**缺省解析 + 快照编码**（spec §5 / §9 G3）。
 *
 * 本文件回答两件事，而且是同一件事的两面：
 *   ① 跑一条 run 时各项旋钮**实际取到什么值**（显式传入 / env / 缺省）；
 *   ② 这些值**怎么记进 run 根**（`config.*` attributes）。
 * 认下缺省值的人必须是把它写进 trace 的人 —— 否则「记录的」与「生效的」会漂移。
 *
 * 文件分工：本文件只做**纯映射**（读 options 与 env，不碰 recorder / 网络 / 时钟，
 * 不构造 span，不写属性）；开 run 根、把快照写进去、循环编排都在 engine/loop.ts。
 */

/**
 * 缺省模型解析：显式传入 > AGENTIA_MODEL env > 'claude-opus-5'。
 * 不把端点私有模型写死在代码里 —— 走 Anthropic 兼容网关（如 DeepSeek 端点）时
 * export AGENTIA_MODEL=deepseek-… 即可全局覆盖，无需逐处传 model。
 */
export function resolveDefaultModel(over?: string): string {
  if (over) return over;
  return process.env.AGENTIA_MODEL?.trim() || 'claude-opus-5';
}

/** 缺省单次 maxTokens / 循环上限：runAgent 与 runAgentScoped 共用，避免两处各写一遍漂移。 */
export const DEFAULT_MAX_TOKENS = 64_000;
export const DEFAULT_MAX_ITERATIONS = 40;

/** fallback 链的已解析形态（每环的 client 已就位） */
export interface ResolvedModelLink {
  model: string;
  client: ModelClient;
}

/**
 * 解析本 run 的模型链（R8-P2）：主环 + `fallbacks` 逐环（环的 client 缺省复用主环的）。
 *
 * 校验在**这里**（run 入口，每次 run 都过 —— 含崩溃续跑读回的那份 options）：
 * - 环必须是对象、`model` 必须是非空字符串 —— 否则 TypeError（响亮失败，不静默跳过坏环）；
 * - 环的 `client`（若给）必须鸭子类型满足 `messages.stream` 是函数 —— 持久化 store
 *   反序列化回来的空壳（`{}`）在这里变成可读报错，而不是发请求时才爆。
 */
export function resolveModelChain(args: {
  model: string;
  client: ModelClient;
  fallbacks?: ModelFallbackLink[] | undefined;
}): ResolvedModelLink[] {
  assertModelClient(args.client, 'client');
  const chain: ResolvedModelLink[] = [{ model: args.model, client: args.client }];
  for (const [i, link] of (args.fallbacks ?? []).entries()) {
    const where = `fallbacks[${i}]`;
    if (typeof link !== 'object' || link === null) {
      throw new TypeError(`${where} 必须是 { model, client? } 对象，收到 ${String(link)}`);
    }
    if (typeof link.model !== 'string' || link.model.trim() === '') {
      throw new TypeError(`${where}.model 必须是非空字符串，收到 ${JSON.stringify(link.model)}`);
    }
    const client = link.client ?? args.client;
    assertModelClient(client, `${where}.client`);
    chain.push({ model: link.model, client });
  }
  return chain;
}

/**
 * ModelClient 的**运行时鸭子校验**（2026-11-07 深评）：主环与 fallback 环都必须过。
 * 此前只校验 fallback 环的 client，主 `options.client` 是空壳（持久化 JSON 往返后的 `{}`）
 * 时要到 `messages.stream` 才炸，错误会被 classifyError 记成 unknown。
 */
export function assertModelClient(client: unknown, where: string): asserts client is ModelClient {
  const stream = (client as { messages?: { stream?: unknown } } | undefined)?.messages?.stream;
  if (typeof stream !== 'function') {
    throw new TypeError(
      `${where} 不满足 ModelClient 契约（messages.stream 不是函数）—— ` +
        '常见原因：异步任务的 options 经持久化 store JSON 往返后 client 变成空壳；' +
        '跨重启仍成立的链请只写 model（client 由 runner/应用级配置兜住）',
    );
  }
}

/**
 * 校验归因标签（R8-P4）：键必须非空、值必须是字符串（**允许空串** —— 「租户未知」
 * 是有意义的值）。坏值在 run 入口抛 TypeError（与 resolveModelChain 同一个
 * 「配置错响亮失败」的落点），不静默丢键。
 */
export function validateLabels(labels: Record<string, string> | undefined): void {
  if (labels === undefined) return;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    throw new TypeError(`labels 必须是 Record<string, string>，收到 ${JSON.stringify(labels)}`);
  }
  for (const [k, v] of Object.entries(labels)) {
    if (k.trim() === '') throw new TypeError('labels 的键不能为空字符串');
    if (typeof v !== 'string') {
      throw new TypeError(`labels.${k} 必须是字符串，收到 ${JSON.stringify(v)}`);
    }
  }
}

/**
 * 生效配置快照（G3）：把本 run 实际生效的旋钮整理成 run 根的 `config.*` attributes。
 * 只放标量（OTLP/日志/看板都能直接吃）；缺省值也记，这样"没配"与"配了缺省值"可区分于
 * "该项不存在"。函数型选项只记"配没配"，不记函数体。
 */
export function runConfigSnapshot(
  // traceLimits 不在 RunAgentOptions 上：它是 run 层（ExecuteRunOptions /
  // RunInvocationOptions）的旋钮 —— executeRun 在 run 入口用 resolveTraceLimits
  // 校验后交给 recorder（见 runtime/run.ts），再把**同一份** options 透传到本函数，
  // 所以这里读到的就是生效值（「认下缺省值的人就是写进 trace 的人」）。
  options: RunAgentOptions<JsonSchema> & { traceLimits?: TraceLimits },
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    'config.model': resolveDefaultModel(options.model),
    'config.maxTokens': options.maxTokens ?? DEFAULT_MAX_TOKENS,
    'config.maxIterations': options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  };
  if (options.maxTotalTokens != null) out['config.maxTotalTokens'] = options.maxTotalTokens;
  if (options.maxCostUsd != null) out['config.maxCostUsd'] = options.maxCostUsd;
  if (options.toolTimeoutMs != null) out['config.toolTimeoutMs'] = options.toolTimeoutMs;
  // 非正 / 非有限值在 `mapWithConcurrency` 里一律等于「不限并发」，但原样记进 trace 会写成
  // `NaN`（过不了 JSON/OTLP 序列化，到看板上是 null）或 `-1`（读起来像「卡在负数个并发」）。
  // 记**生效的**整数（`floor` 且至少 1，见 `concurrency.ts`），不限则同 `maxEventChars` 记 'off'。
  if (options.maxToolConcurrency != null)
    out['config.maxToolConcurrency'] =
      Number.isFinite(options.maxToolConcurrency) && options.maxToolConcurrency > 0
        ? Math.max(1, Math.floor(options.maxToolConcurrency))
        : 'off';
  // 事件截断关掉时记 'off' 而不是 false：`maxEventChars: false` 在日志/看板里
  // 容易被读成「上限为 0」，'off' 一句话说清是**没有上限**
  if (options.maxEventChars != null)
    out['config.maxEventChars'] = options.maxEventChars === false ? 'off' : options.maxEventChars;
  if (options.maxToolResultChars != null)
    out['config.maxToolResultChars'] =
      options.maxToolResultChars === false ? 'off' : options.maxToolResultChars;
  // 记账数量闸：与 maxEventChars（管「多长」）正交，这个管「多少」。键名镜像选项路径
  //（同 config.retry.maxAttempts / config.contextPolicy.budgetTokens 的口径）。
  // 0 = 「一条都不记」是有意义的值，原样记 0 —— 不记成 'off'（本文件里 'off' = 不设上限，
  // 与上限为 0 是两回事）。坏值（NaN / 负数 / 小数）在 run 入口已被 resolveTraceLimits
  // 拦下（抛 TypeError），走不到这里，所以不需要 maxToolConcurrency 那样的净化分支。
  const maxEvents = options.traceLimits?.maxEvents;
  if (maxEvents != null) out['config.traceLimits.maxEvents'] = maxEvents;
  // 重试：记生效的 maxAttempts（0 = 关闭）—— 比记 "custom/default" 更有信息量
  const retryCfg = resolveRetry(options.retry);
  out['config.retry.maxAttempts'] = retryCfg ? retryCfg.maxAttempts : 0;
  const policy: ContextPolicy | undefined = options.contextPolicy;
  if (policy) {
    out['config.contextPolicy'] = true;
    if (policy.budgetTokens != null) out['config.contextPolicy.budgetTokens'] = policy.budgetTokens;
  } else {
    out['config.contextPolicy'] = false;
  }
  // 价格覆盖：只记覆盖了哪几个模型（不记单价 —— 单价在价格表里，重复记会漂移）
  const overridden = options.priceOverrides ? Object.keys(options.priceOverrides) : [];
  if (overridden.length > 0) out['config.priceOverrides'] = overridden.sort().join(',');
  // fallback 链（R8-P2）：只记备用模型名（client 是对象，不可序列化；主模型在 config.model）
  if (options.fallbacks && options.fallbacks.length > 0) {
    out['config.fallbacks'] = options.fallbacks.map((l) => l.model).join(',');
  }
  // assistant 文本记录（R8-P3a）：只在显式开启时记（缺省不记 = 没有这个键）
  if (options.traceContent === 'full') out['config.traceContent'] = 'full';
  // 归因标签（R8-P4）：只记**键名**（值可能含租户标识，配置快照不该复制它 ——
  // 值本体在 labels.* 属性里，想看的人去看那里）
  if (options.labels && Object.keys(options.labels).length > 0) {
    out['config.labels'] = Object.keys(options.labels).sort().join(',');
  }
  if (options.resultSchema) out['config.resultSchema'] = true;
  return out;
}
