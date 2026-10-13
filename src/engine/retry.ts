import type { SpanError } from '../core/trace.js';
import { zeroClauseOf } from '../core/limits.js';
import { MAX_TIMER_DELAY_MS, interruptibleSleep } from '../core/timeout.js';
import { classifyError } from './errors.js';

/**
 * Agentia —— 模型请求的重试与退避（spec §6.5 确定性工程）。
 *
 * 消费 `classifyError().retryable`（此前该标记只产出、无人消费）：429 / 5xx /
 * 连接失败自动重试，400 一类的确定性错误立即失败。
 *
 * **只重试尚未产出任何文本的尝试** —— 已流出一半的文本无法撤回，重试会造成
 * 重复输出。这条约束由 engine/loop.ts 保证（它才知道有没有吐过文本）。
 *
 * ⚠️ 与默认 client 内置重试叠加：默认 client（integrations/anthropic.ts）自己会对
 * 429/5xx/连接错误重试（缺省 2 次，与 SDK 缺省语义对齐）。框架层是更外层的兜底
 * （覆盖 client 层放弃后、以及 OpenAI 兼容客户端）。两层同时开最多会打
 * `(1+clientRetries) × maxAttempts` 次请求 —— 建议二选一调（把这里设
 * `maxAttempts: 1`，或把 client 的 `maxRetries` 设小）。
 */
export interface RetryOptions {
  /** 最大尝试次数（含首次）；1 = 关闭。缺省 3 */
  maxAttempts?: number;
  /** 首次退避毫秒，指数增长；缺省 500 */
  baseDelayMs?: number;
  /** 退避上限毫秒；缺省 8000 */
  maxDelayMs?: number;
  /** 抖动比例 0~1（避免并发 run 同时重试打爆上游）；缺省 0.2 */
  jitter?: number;
  /** 判定是否可重试；缺省 `(e) => classifyError(e).retryable` */
  isRetryable?: (err: unknown) => boolean;
  /** 重试前回调（观测用；trace 里另有 `llm.retry` 事件） */
  onRetry?: (info: { attempt: number; delayMs: number; error: SpanError }) => void;
}

/** 缺省重试参数（不含两个函数字段 —— 它们在 resolveRetry 里注入） */
export const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: 0.2,
} as const;

export type ResolvedRetry = Required<RetryOptions>;

/**
 * 剔除**显式 `undefined`** 的键。
 *
 * `{ ...DEFAULTS, ...o }` 里，`o` 上值为 `undefined` 的键会**照常覆盖**默认值 ——
 * 它不是「没给」，而是「给了一个 undefined」。tsconfig 未开
 * `exactOptionalPropertyTypes`，所以 `{ maxAttempts: cfg.retries }` 这类
 * spread/透传组装出来的配置能带着 undefined 过类型检查，一路抵达 resolveRetry。
 */
function definedOnly(o: RetryOptions | undefined): RetryOptions {
  const out: RetryOptions = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * 校验 `RetryOptions` 的四个数值旋钮 —— **响亮抛 TypeError**，与 client 层
 * `resolveMaxRetries`（integrations/adapter-options.ts）同一条纪律。
 *
 * 坏值的真实后果（2026-10-13 深评 A1，实测）：
 * - `maxAttempts: NaN` ⇒ `!(NaN >= 1)` 成立 ⇒ **重试被静默关闭**（run 根快照记
 *   `config.retry.maxAttempts: 0`，看着像用户主动关的）；
 * - `baseDelayMs: NaN` ⇒ `backoffDelay` 算出 NaN ⇒ `sleep` 的 `assertTimerDelay` 抛
 *   RangeError —— 它曾被 turn.ts 退避处的裸 catch 吞成「用户取消」（配置错被谎报）；
 * - 延迟超 2^31-1ms ⇒ 被 Node 静默钳到 1ms（远期退避变热重试，单源上限见 core/timeout.ts）。
 *
 * `0` 各有合法读法（`maxAttempts: 0` = 关闭、`baseDelayMs: 0` = 不退避、`jitter: 0` =
 * 不加抖动），不在被拒之列 —— 各旋钮的 0 语义登记在 `core/limits.ts`。
 */
export function validateRetryOptions(o: RetryOptions | false | undefined): void {
  if (o === false || o === undefined) return;
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = o;
  if (maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)) {
    throw new TypeError(
      `retry.maxAttempts 必须是非负安全整数（${zeroClauseOf('RetryOptions.maxAttempts')}），收到 ${String(maxAttempts)} —— ` +
        'NaN / Infinity / 负数 / 小数都会让「重试几次」变成猜的（`!(NaN >= 1)` 成立 ⇒ 重试被静默关闭）',
    );
  }
  for (const [name, v] of [
    ['retry.baseDelayMs', baseDelayMs],
    ['retry.maxDelayMs', maxDelayMs],
  ] as const) {
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TIMER_DELAY_MS) {
      throw new TypeError(
        `${name} 必须是 0 ~ ${MAX_TIMER_DELAY_MS}ms 的有限数` +
          `（${zeroClauseOf(name === 'retry.baseDelayMs' ? 'RetryOptions.baseDelayMs' : 'RetryOptions.maxDelayMs')}），` +
          `收到 ${String(v)} —— NaN 会让退避算成 NaN，超上限会被 Node 钳到 1ms（远期变热重试）`,
      );
    }
  }
  if (
    jitter !== undefined &&
    (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1)
  ) {
    throw new TypeError(
      `retry.jitter 必须是 0 ~ 1 的有限数（${zeroClauseOf('RetryOptions.jitter')}），收到 ${String(jitter)} —— ` +
        '>1 会把退避拉成负数再被静默钳回 0（抖动与退避一起失效）',
    );
  }
}

/** 归一重试配置：`undefined` → 缺省策略（**缺省开启**）；`false` → null（关闭）。 */
export function resolveRetry(o: RetryOptions | false | undefined): ResolvedRetry | null {
  if (o === false) return null;
  // 数值旋钮坏值响亮失败（见 validateRetryOptions 头注）。runAgent 入口另有一次同款
  // 校验（配置错不收成「失败的 run」）；这里保留是因为直连 agentLoop / runAgentScoped
  // 的路径不经过 run 入口。
  validateRetryOptions(o);
  // 用 definedOnly 兜住显式 undefined，否则旧写法会把缺省覆盖掉：
  // `maxAttempts: undefined` → `!(undefined >= 1)` 成立 → **重试被静默关闭**，
  // 而 run 根快照记的是 config.retry.maxAttempts: 0（看起来像用户主动关的）；
  // `baseDelayMs: undefined` → backoffDelay 每次算出 NaN，退避失效且 trace 里
  // `llm.retry.delayMs` 记 NaN。两者都与「undefined → 缺省策略」的文档相反。
  const merged = { ...DEFAULT_RETRY, ...definedOnly(o) };
  if (!(merged.maxAttempts >= 1)) return null; // maxAttempts < 1 等同关闭
  return {
    ...merged,
    isRetryable: o?.isRetryable ?? ((e: unknown) => classifyError(e).retryable),
    onRetry: o?.onRetry ?? ((): void => {}),
  };
}

/**
 * 指数退避 + 上限 + 抖动：attempt 从 1 起，`base * 2^(attempt-1)` 封顶 maxDelayMs。
 *
 * ⚠️ **不要**与 `integrations/anthropic.ts` 的 `backoffMs` 合并（2026-09-17 去重时
 * 明确留下的例外）。两者形似而策略不同，合一就是改行为：
 * - 本函数：抖动**均匀分布** ±jitter（缺省 ±20%），底数/上限来自 `RetryOptions`；
 * - 那个：±25% 固定抖动，且**优先尊重 `retry-after`**（秒数或 HTTP-date）——
 *   限流窗口是上游说了算，框架不该拿自己的指数曲线去猜。它只在 client 层有意义。
 * 层也不同：本函数是引擎的兜底重试（覆盖 client 放弃之后的场景），那个在 client 内部。
 */
export function backoffDelay(attempt: number, r: ResolvedRetry): number {
  const exp = r.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, r.maxDelayMs);
  const jitter = r.jitter > 0 ? capped * r.jitter * (Math.random() * 2 - 1) : 0;
  // 上界再封一道：`capped ≤ maxDelayMs ≤ 2^31-1` 由入口校验保证，但正向抖动还能把它
  // 推过 Node 定时器的物理上限（maxDelayMs 贴上限 + jitter=1 ⇒ 最多 2 倍）——超上限
  // 的 setTimeout 会被钳到 1ms（远期退避变热重试），这里在交付给 sleep 之前夹住。
  // ⚠️ 用 Math.min 而不是 clampTimerDelay：后者会把 NaN 读成 0，而 NaN 是必须响亮的坏值。
  return Math.min(Math.max(0, Math.round(capped + jitter)), MAX_TIMER_DELAY_MS);
}

/**
 * 可被 signal 中断的 sleep（退避期间收到取消就不必再等）。
 *
 * 实现单源在 `core/timeout.ts`（2026-09-17 去重）：`integrations/anthropic.ts` 的
 * client 层退避需要**逐字相同**的语义，而它只能依赖 core —— 那份重复是被分层约束
 * 逼出来的，所以合一的落点只能是 core。这里只钉住本层的取消文案。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return interruptibleSleep(ms, signal, 'run 已被取消');
}

/**
 * 本次失败能否重试：**四项合取** —— 配置在场 + 次数未尽 + 判定可重试 + 本次尝试**未产出任何文本**。
 *
 * 从 turn.ts 的 streamTurn 行内抽出（2026-09-20，turn 拆分第二步）。最后一项是护栏，不是优化：
 * **已经吐出去的字收不回来**，重试会重复输出 —— 所以吐过就一律不重试，哪怕错误本身可重试、
 * 次数也还有余量。这四条此前只能透过整条 run 的行为间接观察。
 */
export function retryAllowed(
  cfg: ResolvedRetry | null,
  attempt: number,
  error: unknown,
  emitted: boolean,
): boolean {
  return cfg !== null && attempt < cfg.maxAttempts && cfg.isRetryable(error) && !emitted;
}
