/**
 * 单工具执行的**上下文装配**（纯）：把引擎侧的取值摊成交给工具的 `ToolRunContext`。
 *
 * 从 turn.ts 的 executeOneTool 里外移（2026-09-20，turn 拆分第三步）。这段全部是搬运，但它
 * **不是无害的样板**：这些条件展开各自对应一个「漏了就静默降级」的守卫 ——
 * 价格覆盖漏了 ⇒ 子 agent 用同一模型退化成「未定价」、`maxCostUsd` 静默失效；预算/超时上限
 * 漏了 ⇒ 护栏在子循环里离线；`abandoned` 漏了 ⇒ 超时后没人通知工具「别等了」；
 * `deferUntil` 漏了 ⇒ 工具调用它当场 TypeError（工具契约里它有值，不是可选装饰）。
 *
 * 判定用哪一种是**语义**，不是风格，单测逐项钉住：
 * - `signal` / `priceOverrides` / `onUnpricedModel` 用**真值**判定；
 * - `maxEventChars` / `traceContent` / `maxTotalTokens` / `maxCostUsd` / `toolTimeoutMs`
 *   用**非空**判定 —— 因为 `false`（不截断）与 `0`（不限/不超时）都是**有意义的值**，
 *   真值判定会把它们吃掉；
 * - `approval` 用 `!== undefined`：批/拒的决定要原样带给工具体（审计与分级授权用）；
 * - `deferUntil` 用真值判定：它是函数，没有「`false` = 有意义」这一档。
 *
 * 纯的边界：只做取值搬运，不读 ctx、不碰 recorder、不执行工具。
 */
import type { SpanId } from '../core/trace.js';
import type { RecorderBackend, ToolRunContext } from '../core/tool.js';

export function buildToolRunContext(opts: {
  client: ToolRunContext['client'];
  recorder: RecorderBackend;
  parentSpanId: SpanId;
  abandoned: AbortSignal;
  signal?: ToolRunContext['signal'];
  priceOverrides?: ToolRunContext['priceOverrides'];
  onUnpricedModel?: ToolRunContext['onUnpricedModel'];
  maxEventChars?: ToolRunContext['maxEventChars'];
  maxToolResultChars?: ToolRunContext['maxToolResultChars'];
  traceContent?: ToolRunContext['traceContent'];
  usageOffset?: ToolRunContext['usageOffset'];
  maxTotalTokens?: ToolRunContext['maxTotalTokens'];
  maxCostUsd?: ToolRunContext['maxCostUsd'];
  toolTimeoutMs?: ToolRunContext['toolTimeoutMs'];
  approval?: ToolRunContext['approval'];
  deferUntil?: ToolRunContext['deferUntil'];
}): ToolRunContext {
  const {
    client,
    recorder,
    parentSpanId,
    abandoned,
    signal,
    priceOverrides,
    onUnpricedModel,
    maxEventChars,
    maxToolResultChars,
    traceContent,
    usageOffset,
    maxTotalTokens,
    maxCostUsd,
    toolTimeoutMs,
    approval,
    deferUntil,
  } = opts;
  return {
    client,
    recorder,
    parentSpanId,
    abandoned,
    ...(signal ? { signal } : {}),
    ...(priceOverrides ? { priceOverrides } : {}),
    ...(onUnpricedModel ? { onUnpricedModel } : {}),
    ...(maxEventChars != null ? { maxEventChars } : {}),
    ...(maxToolResultChars != null ? { maxToolResultChars } : {}),
    ...(traceContent != null ? { traceContent } : {}),
    ...(usageOffset !== undefined ? { usageOffset } : {}),
    ...(maxTotalTokens != null ? { maxTotalTokens } : {}),
    ...(maxCostUsd != null ? { maxCostUsd } : {}),
    ...(toolTimeoutMs != null ? { toolTimeoutMs } : {}),
    ...(approval !== undefined ? { approval } : {}),
    // 真值判定：它是个函数，没有 `false` / `0` 这类有意义的值（与上面那批「非空判定」的
    // 旋钮不同类）；装配点永远给一份，缺它只可能是「这条路径不走回合」（如 MCP 反向桥）
    ...(deferUntil ? { deferUntil } : {}),
  };
}
