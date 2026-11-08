/**
 * 单工具执行的**记账面**（纯）：`tool.input` / `tool.output` 两个事件体 + 回给模型的 tool_result 块。
 *
 * 从 turn.ts 的 executeOneTool 里外移（2026-09-20，turn 拆分第四步）。这里的每一条都是**口径**，
 * 混在执行流程里只能透过 trace 的观感去猜：
 * - **截断上限不对称**：失败出参用更小的上限（1000 vs 2000）—— 理由见常量注释；
 * - **`maxEventChars: false` = 不截断**（调试期开全文），必须原样透传而不是回落默认；
 * - **`durationMs` 覆盖四条路径**（成功 / 失败 / 超时 / 入参被拒）且**非负** —— 时钟回拨时不出现负数；
 * - **`errorKind` 只在有值时在场**：成功事件不该带一个 `undefined` 的键。
 *
 * 纯的边界：只拼装数据，不读 ctx、不碰 recorder、不执行工具。
 */
import { stringifySafe, truncateWithMark } from '../core/json.js';
import { zeroClauseOf } from '../core/limits.js';
import type { ToolResultBlockParam, ToolUseBlock } from '../core/message.js';

/**
 * 事件正文（tool.input / tool.output 的 body）缺省截断上限（字符）。
 *
 * 与「入参」/「成功出参」/「失败出参」三类一一对应：失败出参减半是为了让
 * 「哪个工具老超时」这类判断在**一行**里看得完（正文本身多为一句错误摘要，
 * 1000 已远超常见长度，只有工具把异常里的长上下文一起吐回来时才会触发）。
 */
export const DEFAULT_EVENT_CHARS = 2_000;
export const DEFAULT_ERROR_EVENT_CHARS = 1_000;

/** 工具失败归类（进 `tool.output` 事件）。`denied` 是**人**的决定，不是工具故障，故单列一类账 */
export type ToolErrorKind = 'invalid_input' | 'timeout' | 'threw' | 'unknown_tool' | 'denied';

/**
 * 截断到上限字符，超长加省略标记（标记格式由 core/json.ts 的 truncateWithMark 单一提供）。
 * `n === false` 表示**不截断**（`RunAgentOptions.maxEventChars: false`）——
 * 传数字时三类事件共用同一个上限，缺省值由调用点给出。
 */
function limit(x: unknown, n: number | false): string {
  const s = stringifySafe(x);
  return n === false ? s : truncateWithMark(s, n);
}

export interface ToolInputPayload {
  tool: string;
  tool_use_id: string;
  input: string;
}

/** `tool.input` 事件体：入参按 `maxEventChars`（缺省 2000）截断 */
export function toolInputPayload(
  use: ToolUseBlock,
  maxEventChars?: number | false,
): ToolInputPayload {
  return {
    tool: use.name,
    tool_use_id: use.id,
    input: limit(use.input, maxEventChars ?? DEFAULT_EVENT_CHARS),
  };
}

export interface ToolOutputPayload {
  tool: string;
  tool_use_id: string;
  ok: boolean;
  durationMs: number;
  errorKind?: ToolErrorKind;
  content: string;
}

/**
 * `tool.output` 事件体：耗时四路径都记、失败出参用**更小**的截断上限、`errorKind` 有值才在场。
 * `now` 由调用点传入（便于单测固定时钟；时钟回拨时 durationMs 钳到 0）。
 */
export function toolOutputPayload(opts: {
  use: ToolUseBlock;
  ok: boolean;
  errorKind?: ToolErrorKind | undefined;
  startedAt: number;
  now: number;
  content: unknown;
  maxEventChars?: number | false | undefined;
}): ToolOutputPayload {
  const { use, ok, errorKind, startedAt, now, content, maxEventChars } = opts;
  return {
    tool: use.name,
    tool_use_id: use.id,
    ok,
    durationMs: Math.max(0, now - startedAt),
    ...(errorKind ? { errorKind } : {}),
    content: limit(
      content,
      maxEventChars ?? (ok ? DEFAULT_EVENT_CHARS : DEFAULT_ERROR_EVENT_CHARS),
    ),
  };
}

export function validateMaxEventChars(value: number | false | undefined): void {
  if (value === undefined || value === false) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `maxEventChars 必须是非负安全整数或 false（不截断；${zeroClauseOf('maxEventChars')}），收到 ${String(value)}`,
    );
  }
}

export function validateMaxToolResultChars(value: number | false | undefined): void {
  if (value === undefined || value === false) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `maxToolResultChars 必须是非负安全整数或 false（不截断；${zeroClauseOf('maxToolResultChars')}），收到 ${String(value)}`,
    );
  }
}

/**
 * 回给模型的 tool_result 块。`maxToolResultChars` 与 trace 的 maxEventChars 正交：
 * 前者保护下一次模型请求，后者只保护记账体积；缺省/false 都是不截断。
 */
export function toolResultBlock(
  use: ToolUseBlock,
  ok: boolean,
  content: unknown,
  maxToolResultChars?: number | false,
): ToolResultBlockParam {
  const text = stringifySafe(content);
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content:
      maxToolResultChars === undefined || maxToolResultChars === false
        ? text
        : truncateWithMark(text, maxToolResultChars),
    is_error: !ok,
  };
}
