import type { MessageUsage } from '../core/message.js';
import type { ModelPricing } from '../core/tool.js';
import type { Usage } from '../core/trace.js';

/**
 * Agentia —— 模型用量与成本估算（spec §6.4 成本硬管控的地基）。
 *
 * **成本是"可调优"的一部分，但历史实现有两处硬伤**（可观测·可调优设计 F1/F2）：
 * 1. 价格表是模块内常量 → 走 OpenAI 兼容端点（DeepSeek / 自建）的宿主**永远算不出成本**；
 * 2. 未定价模型返回 `undefined` → 成本恒 0 → `maxCostUsd` 这条护栏**静默失效**、且无任何提示。
 *
 * 现在：价格表可经 `priceOverrides` 覆盖/追加（`buildPricing`），未定价模型会在该回合的
 * llm.turn span 记 `usage.unpriced` 事件并有 `agentia_model_unpriced_turns_total` 指标 ——
 * 护栏是否真的生效**看得见**。
 */

/** 内置价格表（$/1M tokens）。宿主用 `priceOverrides` 覆盖同名项或追加新模型。 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
});

/** 官方标准缓存乘数（相对 `in`）：读 0.1×、**5 分钟** 写 1.25×。逐模型/逐 TTL 覆盖见 `ModelPricing`。 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * 错误文案里的值渲染。`JSON.stringify(NaN)` 印出来是 `null` —— 而宿主传的确实是 `NaN`，
 * 印成 `null` 会让人去找一个不存在的 `null`（本仓库对「可读错误」的要求同样适用于此）。
 */
function showValue(v: unknown): string {
  return typeof v === 'number' ? String(v) : (JSON.stringify(v) ?? String(v));
}

/** 整对象渲染：JSON 没有 `NaN` 字面量，非有限数印成 `"NaN"` 而不是 `null`。 */
function showObject(v: unknown): string {
  return (
    JSON.stringify(v, (_k, x) =>
      typeof x === 'number' && !Number.isFinite(x) ? String(x) : (x as unknown),
    ) ?? String(v)
  );
}

/**
 * 合并内置表与宿主覆盖（**覆盖优先**）；返回合并后的表。
 * 不给覆盖时直接复用内置表（同一引用，零拷贝）。
 *
 * 非法单价（非有限数 / 负数）在**解析价格表时就抛错**（本函数内，`engine/turn.ts` 的循环入口调用）
 * —— 与其让它算出 NaN 成本、再让 `maxCostUsd` 拿 NaN 去比较（永远 false，护栏静默失效），
 * 不如立刻响亮失败。
 * ⚠️ 别把它读成「`createApp` 构造期」：`buildPricing` 只在**每次 run 的循环入口**被调用，
 * 所以它是「第一次 llm 调用之前」而不是「应用构造时」（api.html 那句「构造期抛错」由此而来，
 * 已订正）。
 * 两个缓存乘数同属这一条：**只校验一半等于没校验**（乘数写错照样出 NaN）。
 *
 * ⚠️ 口径（实测钉在 `tests/engine/pricing.test.ts`）：这个错**不会抛给调用方** ——
 * 本函数只在 `engine/turn.ts` 的循环入口被调用，`runAgent` 会把它收成
 * `{status:'error', stopReason:'error'}` 的 result（错误记在 run 根 span），
 * 关键是它发生在**第一次 llm 调用之前**（client 一次都不被调用，不烧 token）。
 */
export function buildPricing(
  overrides?: Record<string, ModelPricing>,
): Record<string, ModelPricing> {
  if (!overrides) return DEFAULT_PRICING as Record<string, ModelPricing>;
  for (const [model, p] of Object.entries(overrides)) {
    const ok = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!p || !ok(p.in) || !ok(p.out)) {
      throw new Error(
        `priceOverrides["${model}"] 非法：需要 { in, out } 两个非负有限数（$/1M tokens），收到 ${showObject(p)}`,
      );
    }
    for (const [k, v] of [
      ['cacheRead', p.cacheRead],
      ['cacheWrite', p.cacheWrite],
    ] as const) {
      if (v !== undefined && !ok(v)) {
        throw new Error(
          `priceOverrides["${model}"].${k} 非法：需要非负有限数（相对 in 的乘数），收到 ${showValue(v)}`,
        );
      }
    }
  }
  return { ...DEFAULT_PRICING, ...overrides };
}

/**
 * 计量数值的运行时防线（2026-11-07 深评）：`MessageUsage` 是线缆形状，兼容端点可能把
 * int64 回成字符串、或回 null/NaN。`?? 0` 只挡 null/undefined；字符串会一路进
 * metrics 的 `+=` 变成字符串拼接、NaN 会让 OTLP 的 int64 非法。非有限/负数一律归 0。
 */
function countOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function usageFromAnthropic(u: MessageUsage): Usage {
  return {
    inputTokens: countOf(u.input_tokens),
    outputTokens: countOf(u.output_tokens),
    cacheReadTokens: countOf(u.cache_read_input_tokens),
    cacheCreationTokens: countOf(u.cache_creation_input_tokens),
  };
}

/**
 * 近似成本估计：缓存读 0.1×输入、缓存写 1.25×输入（官方标准乘数）。
 *
 * 两个乘数都可**逐模型覆盖**（`ModelPricing.cacheRead` / `cacheWrite`）：
 * - 缓存写：默认 1.25× 是 **5 分钟** 档。宿主在块上用了 `cache_control: { ttl: '1h' }` 时，
 *   那一档官方是 **2×**；而 `Usage` 是四项聚合的、分不出 TTL，所以必须在价格表里显式写
 *   `cacheWrite: 2`，否则低估 37.5%（方向上让 `maxCostUsd` 迟触发）。
 * - 缓存读：官方有逐模型例外（Opus 5.5 = 0.05×、Fable 5.1 / Mythos 5.1 = 0.025×），同理。
 *
 * 乘数逐项钉在 `tests/engine/pricing.test.ts`。
 *
 * 模型不在传入的价格表内时返回 `undefined` —— 调用方须把"未定价"**显式**表达出来
 * （记 `usage.unpriced` 事件 / 计数），不要当成"成本 0"。
 */
export function costEstimate(
  model: string,
  usage: Usage,
  pricing: Record<string, ModelPricing> = DEFAULT_PRICING as Record<string, ModelPricing>,
): number | undefined {
  // Object.hasOwn：`pricing[model]` 会命中原型链 —— 模型名恰为 'constructor' / 'toString'
  // 时 p 是个函数（真值）而 p.in/p.out 为 undefined ⇒ 成本算出 NaN，NaN 会进 trace/OTLP，
  // 且 `NaN > maxCostUsd` 恒 false ⇒ 成本护栏静默失效。与 memory/schema 处的防法一致。
  const p = Object.hasOwn(pricing, model) ? pricing[model] : undefined;
  if (!p) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = usage;
  const cost =
    (inputTokens / 1e6) * p.in +
    (outputTokens / 1e6) * p.out +
    (cacheReadTokens / 1e6) * p.in * (p.cacheRead ?? CACHE_READ_MULTIPLIER) +
    (cacheCreationTokens / 1e6) * p.in * (p.cacheWrite ?? CACHE_WRITE_MULTIPLIER);
  return Math.round(cost * 1e6) / 1e6;
}
