import type { IncomingMessage } from 'node:http';
import type { RunInvocationOptions } from '../engine/spec.js';

/**
 * Agentia —— HTTP 入口的 **run 选项可信边界**（spec §10 2026-11-04 run-options-trust-boundary）。
 *
 * ## 这个文件解决的两个不对称
 *
 * `POST /tasks` 的 body 里有一个 `options`，此前**整体透传**给 `runner.submit`（`...body.options`），
 * 而 `options` 是引擎的**全部旋钮**（`RunInvocationOptions`：`blackboard` / `tools` /
 * `fallbacks` / `maxIterations` / `priceOverrides` …）。后果不是"繁琐"，是**能冒充**：
 *
 * - `blackboard: { tenant: '别人的租户' }` ⇒ 工具方法体里读到的就是别人的租户。
 *   usage-guide §6.6 的多租户配额配方第一步正是「用黑板存 tenant」—— 照抄即被绕过；
 * - `tools: [...]` ⇒ 客户端能把整个工具菜单换掉；
 * - `priceOverrides: { '<模型>': { in: 0, out: 0 } }` ⇒ 成本恒 0，`maxCostUsd` 静默失效。
 *
 * 另一头，`POST /run` **完全不收 options**（连 `traceContext` 都只认 header）—— 需要身份的那条
 * 拿不到，拿得到的那条不可信。这就是那个不对称。
 *
 * ## 两半各自的职责
 *
 * | 谁 | 管什么 | 为什么 |
 * |---|---|---|
 * | `pickClientRunOptions` | **白名单**：客户端只能设这几个键 | 外部输入不配拥有引擎旋钮（与 `parseEventBody` 的「多一个字段即拒」同一条纪律） |
 * | `ResolveRunOptionsHook` | **可信注入**：宿主按请求给的 `blackboard` / `labels` / 预算封顶 | 身份只能来自宿主（鉴权结果），不能来自 body |
 *
 * 客户端**仍然可以**设 `maxCostUsd` / `maxTotalTokens`（给自己这单设个花钱上限是合理诉求），
 * 但合取时取**更严的那一个** —— 「上限」不能由不受信的一方放宽。这不是策略，是「上限」的
 * 定义本身：能被叫价方抬高的上限不叫上限。
 */

/**
 * 客户端可自填的键（`POST /tasks` 的 `body.options`）。
 *
 * 加键的判据：**这个键被客户端设错时，损失只落在他自己这一单上**。
 * - `traceContext`：链路关联（他愿意把自己的请求挂到哪棵树上是他的事）；
 * - `maxCostUsd` / `maxTotalTokens`：愿意花多少。
 *
 * 反例（永远不该进来）：`blackboard`（身份）/ `labels`（归因与配额）/
 * `tools`（换菜单）/ `model` + `fallbacks`（替服务端选厂商与价目）/
 * `priceOverrides`（改账本口径 ⇒ 让预算闸失效）/ `client` / `signal`（进程内对象）。
 */
export const CLIENT_RUN_OPTION_KEYS = ['traceContext', 'maxCostUsd', 'maxTotalTokens'] as const;

export type ClientRunOptionKey = (typeof CLIENT_RUN_OPTION_KEYS)[number];

/**
 * 客户端能设的那几个选项的**类型面**（`TaskSubmitBody.options`）。
 *
 * 它刻意是 `Pick` 出来的窄类型而不是 `RunInvocationOptions`：后者会让「写 `blackboard`
 * 能通过编译、到运行期才 400」—— 把一次编译期就能说清的事推到线上。
 */
export type ClientRunOptions = Pick<RunInvocationOptions, ClientRunOptionKey>;

/**
 * 宿主按请求注入的选项（`HttpHandlerOptions.resolveRunOptions` 的返回值）。
 *
 * 刻意**窄**：只放「客户端不该有能力决定、而宿主一定知道」的三样。
 * 想调 `model` / `tools` 这类就说明它该在应用配置里，不该跟着某个用户走。
 */
export interface RunOptionOverrides {
  /** 请求身份 / 租户等（**整体替换**客户端的同名值 —— 客户端本来就设不了它） */
  blackboard?: RunInvocationOptions['blackboard'];
  /** 归因标签（与客户端同名键**合并**，服务端键胜出） */
  labels?: Record<string, string>;
  /** 服务端封顶：与客户端值取**更严**者（防止客户端把上限抬高） */
  maxCostUsd?: number;
  /** 同 `maxCostUsd` */
  maxTotalTokens?: number;
}

/**
 * per-request run 选项的来源（宿主给、框架透传）。与 `authenticate` 配对：
 * 后者的返回值作为 `principal` 传进来 —— 身份只走这一条，别去读 body。
 *
 * 抛 `HttpException` ⇒ 按其 `status` / `body` 回响应（校验失败想回 403 就抛它）；
 * 抛别的错误 ⇒ 走 500 路径（与其它内部异常同一个出口）。
 */
export type ResolveRunOptionsHook = (
  req: IncomingMessage,
  info: { route: 'run' | 'tasks'; principal: unknown },
) => RunOptionOverrides | undefined | Promise<RunOptionOverrides | undefined>;

export type ClientRunOptionsResult =
  | { ok: true; options: RunInvocationOptions }
  | { ok: false; error: string };

const ALLOWED = CLIENT_RUN_OPTION_KEYS.join(' / ');

/** 是不是「有限、非负」的数（`NaN` / `Infinity` / 负数都不是合法上限） */
function isLimit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * 校验并取出客户端选项。**未知键即拒**（不是静默丢弃）：一个拼错的 `maxCostUSD`
 * 被悄悄忽略，使用方会以为花销已被封顶 —— 静默降级比 400 危险。
 */
export function pickClientRunOptions(raw: unknown): ClientRunOptionsResult {
  if (raw === undefined || raw === null) return { ok: true, options: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'options 必须是对象' };
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(CLIENT_RUN_OPTION_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `options 不接受 "${key}"（可用：${ALLOWED}）` };
    }
  }
  const options: RunInvocationOptions = {};
  if (o.maxCostUsd !== undefined) {
    if (!isLimit(o.maxCostUsd)) return { ok: false, error: 'options.maxCostUsd 必须是非负有限数' };
    options.maxCostUsd = o.maxCostUsd;
  }
  if (o.maxTotalTokens !== undefined) {
    if (!isLimit(o.maxTotalTokens)) {
      return { ok: false, error: 'options.maxTotalTokens 必须是非负有限数' };
    }
    options.maxTotalTokens = o.maxTotalTokens;
  }
  if (o.traceContext !== undefined) {
    const t = o.traceContext;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return { ok: false, error: 'options.traceContext 必须是 { traceId, spanId? }' };
    }
    const { traceId, spanId } = t as { traceId?: unknown; spanId?: unknown };
    if (typeof traceId !== 'string' || traceId === '') {
      return { ok: false, error: 'options.traceContext.traceId 必须是非空字符串' };
    }
    if (spanId !== undefined && (typeof spanId !== 'string' || spanId === '')) {
      return { ok: false, error: 'options.traceContext.spanId 必须是非空字符串' };
    }
    options.traceContext = { traceId, ...(spanId !== undefined ? { spanId } : {}) };
  }
  return { ok: true, options };
}

/** 两个上限取更严者（缺席即「这边没设」，另一边说了算） */
function tighter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * 把宿主注入的选项叠加到（已过白名单的）客户端选项上。
 *
 * 三条合并语义各不相同，各有理由：
 * - `blackboard`：**整体替换** —— 它是身份载体，允许客户端键与宿主键"合并"就等于允许覆盖；
 * - `labels`：**按键盘合并、宿主胜** —— 归因是多维度的，宿主只想补自己关心的维度；
 * - 预算：**取更严者** —— 见文件头「上限的定义」。
 */
export function mergeRunOptions(
  client: RunInvocationOptions,
  overrides: RunOptionOverrides | undefined,
): RunInvocationOptions {
  if (!overrides) return client;
  const maxCostUsd = tighter(client.maxCostUsd, overrides.maxCostUsd);
  const maxTotalTokens = tighter(client.maxTotalTokens, overrides.maxTotalTokens);
  return {
    ...client,
    ...(overrides.blackboard !== undefined ? { blackboard: overrides.blackboard } : {}),
    ...(overrides.labels !== undefined
      ? { labels: { ...(client.labels ?? {}), ...overrides.labels } }
      : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
  };
}
