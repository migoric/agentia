import type { SpanError } from '../core/trace.js';
import { isTimeoutError } from '../core/timeout.js';

/**
 * Agentia —— 异常分类（engine 对厂商 SDK 零运行时 import）。
 *
 * 分类是**鸭子类型**：默认 client（`integrations/anthropic.ts`）自研化后抛的是
 * 带数值 `status` 的 `AnthropicApiError` 与 fetch 的原生网络错误（TypeError 带 cause），
 * 不再是 SDK 错误类。同套判法对第三方 SDK 错误同样适用（它们的错误类也带 `status`）。
 *
 * 历史教训（2026-09-13 实测，当时因此保留 instanceof）：厂商 SDK 的错误类
 * `name` 恒为 `'Error'`、`type` 为 null，鸭子类型只能靠 `constructor.name` ——
 * **压缩即失效**。所以这里只认**数据属性**（`status` 数值 / `cause` / errno `code` /
 * 内建 DOMException 的 `name`），一概不碰构造函数名。
 */

/** 是否中断异常（DOMException / 普通 Error 都可能是，靠 name 判定） */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/**
 * 分类器**能产出的全部类别** —— 单一真源（2026-09-29 ref-soak-error-taxonomy）。
 *
 * 为什么需要这个常量：在此之前「到底有哪几类」只活在 `classifyError` 的字面量里，
 * 任何想按类别表态的地方（浸泡验证的判据、看板、`trace-diff`）都只能**再手写一份清单**，
 * 而漏一类的表现是**静默**的。实测过一次（就是加这个常量的原因）：
 * `scripts/e2e-soak.ts` 里手写的 `['api','server','rate_limit']` 漏了 `connection`，
 * 默认 60 秒的跑法永远撞不到 —— 而 2 小时那轮（719 万 run / 811 万请求）撞到 **1 次**
 * 就让整轮报红，红的是判据、不是被测的代码（spec §10 2026-09-29 ref-soak-error-taxonomy）。
 *
 * 消费方式：`Record<ErrorType, …>` 的**穷尽表** —— 加一类而不表态 ⇒ `TS2741`
 * （与 `SUCCESS_STOP_REASON` / `KIND_SPEC` 同款护栏，见 `docs/guards.md`）。
 * ⚠️ 本常量只收窄**分类器的输出**；`SpanError.type` 仍然是公共类型上的 `string`
 * （收紧它是对使用者的破坏性变更，不做）。
 */
export const ERROR_TYPES = [
  'aborted',
  'rate_limit',
  'server',
  'api',
  'timeout',
  'connection',
  'unknown',
] as const;

/** 分类器能产出的类别（`ERROR_TYPES` 的成员） */
export type ErrorType = (typeof ERROR_TYPES)[number];

/** `classifyError` 的产出：`SpanError` 的收窄版（`type` 是闭合联合，不是裸 `string`） */
export interface ClassifiedError extends SpanError {
  type: ErrorType;
}

/** 取错误的可读 message（Error 取 .message，其余 String 兜底） */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** errno 形态的连接错误码（Node 网络层稳定产出，不靠 message 文案） */
const CONNECTION_CODES =
  /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)$/;

/**
 * 无 status 的网络型错误 → connection。
 * 稳的判法（不过拟合 message 字符串）：
 * - fetch 的网络失败是 `TypeError` 且带 `cause`（undici 保证，cause 里常有 errno）；
 * - 带 errno `code` 属性的 Error（Node 网络层直接抛的形态）。
 *
 * ⚠️ `name === 'TimeoutError'` 的 DOMException **曾在这里被判成 connection**（2026-09-14 的写法）——
 * 2026-09-17 起它有自己的 `type: 'timeout'`（见 `classifyError` 里的分支 + spec §10 同日 ②），
 * 本函数不再管它：超时混在「连不上」里，看板与 `trace-diff` 就分不出两者。
 */
function isConnectionError(e: object): boolean {
  if (e instanceof TypeError && (e as { cause?: unknown }).cause != null) return true;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_CODES.test(code)) return true;
  return false;
}

/** 把任意异常分类成 trace 可用的 SpanError（可重试 vs 不可重试）。 */
export function classifyError(e: unknown): ClassifiedError {
  if (isAbortError(e)) {
    return { type: 'aborted', message: 'run 已被取消', retryable: false };
  }
  if (typeof e === 'object' && e !== null) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      if (status === 429) return { type: 'rate_limit', message: messageOf(e), retryable: true };
      if (status >= 500) return { type: 'server', message: messageOf(e), retryable: true };
      return { type: 'api', message: messageOf(e), retryable: false };
    }
    // 超时是**自己一类**（2026-09-17，spec §10 同日 ②）：此前它靠 `name === 'TimeoutError'`
    // 被归进 connection，与「连不上」混在一起。`retryable` **保持 true** —— 超时一直是可重试故障，
    // 这里只改记账口径（`span.error.type` / `trace-diff` / 看板的取值），不改重试行为。
    // 放在 status 分支**之后**：带数值 status 的错误仍优先按状态归类（优先级与改动前一致）。
    if (isTimeoutError(e)) {
      return { type: 'timeout', message: messageOf(e), retryable: true };
    }
    if (isConnectionError(e)) {
      return { type: 'connection', message: messageOf(e), retryable: true };
    }
  }
  if (e instanceof Error) {
    return { type: 'unknown', message: e.message, retryable: false };
  }
  return { type: 'unknown', message: String(e), retryable: false };
}
