import type { ContentBlockParam, MessageParam } from '../core/message.js';
import type { Span, SpanId, Trace } from '../core/trace.js';
import { TOOL_INPUT_EVENT, TOOL_OUTPUT_EVENT } from '../core/trace.js';
import { stringifySafe, truncateWithMark } from '../core/json.js';

/**
 * Agentia —— trace 重放基底（spec §9.4 开放问题落地，roadmap R6）。
 *
 * 把一条完成的 trace 还原成可喂回模型的对话（MessageParam[]），用途：
 * 把完成的 run 喂回模型做调试 / 复盘（「这次 run 发生了什么、哪里可以改进」）。
 * 纯函数：不发起请求、不改 trace。
 *
 * 还原规则：
 * - 全部 llm.turn 按 startedAt 时序线性展开（稳定排序，同刻保插入序）——
 *   子 agent 的嵌套回合与主 agent 回合交错进同一序列，每回合以 text 块标注
 *   来源（model / 所属 capability span 名 / spanId）；
 * - 每回合 → 一条 assistant 消息：标注文本 + 各 tool.input 事件还原的 tool_use 块
 *   （id 由重放合成 `replay_tu_<n>`，trace 不记原始 id）；
 * - tool.output 事件 → 紧随其后一条 user 消息里的 tool_result 块，与 tool_use
 *   配对：优先按 tool_use_id 精确匹配（同名工具并行是本框架的常态 —— 完成序 ≠
 *   发起序，只有 id 能把入参出参对上），老 trace 无 id 时回落到「同名最早未配对」，
 *   再兜底「最早未配对」；缺失输出的 tool_use 补一条 is_error 占位 ——
 *   保证 role 交替与配对合法；
 * - 事件负载（工具入参/出参）已是 engine 截断后的字符串；入参尝试 JSON.parse
 *   还原为对象，失败（或非 object）包 `{ _raw }` —— tool_use.input 必须是 object；
 *   所有串按 maxEventChars 再截断（缺省 2000）；
 * - 产出经 normalizeForApi 规整：连续同 role 合并、首尾都确保为 user ——
 *   可直接作为 Messages API 的 messages 喂回模型（末条为 user 是硬要求：
 *   以 assistant 收尾即 prefill，缺省模型上 400）。
 *
 * 注意：trace **缺省**不记录 assistant 文本（llm.turn 只记 usage/事件；opt-in 例外见
 * `RunAgentOptions.traceContent: 'full'`，R8-P3a），还原的
 * assistant 消息以标注文本占位，非逐字原文。trace 同样不记 run 的原始输入，
 * 故重放的首尾说明性 user 均为合成（这一有损边界对 forkMessages 同样成立）。
 *
 * forkMessages —— 分叉重放：在主循环第 N 回合之前截断，只重放分叉点前的历史，
 * 再拼上调用方给的新消息（通常是改写过的新 user 消息）。定位：A/B 实验与
 * 「从中间某步换个说法重跑」的基底 —— trace 已完整记录分叉点前发生的 tool
 * 往返与子 agent 嵌套回合，模型可沿着真实历史继续，而非从零重放。
 */

export interface ReplayOptions {
  /** 是否还原 tool_use/tool_result 对（缺省 true）；false 时只留每回合的标注文本 */
  includeToolIO?: boolean;
  /** 单段事件负载（工具入参/出参）的最大字符数，超长截断（缺省 2000） */
  maxEventChars?: number;
}

export interface ForkReplayOptions extends ReplayOptions {
  /** 在主循环第 N 回合（0-based）之前截断：该回合及其后全部丢弃，从这点分叉。
   *  主循环回合 = parentSpanId === rootSpanId 的 llm.turn（子 agent 嵌套回合不算，与
   *  harvest 的口径一致）；合法范围 0 .. 主循环回合数-1，越界抛可读错误（带回合总数） */
  atTurn: number;
  /** 分叉点之后追加的消息（通常是改写过的新 user 消息）；缺省不追加 */
  append?: MessageParam[];
}

const DEFAULT_MAX_EVENT_CHARS = 2000;

/** tool.input / tool.output 事件体的规整形态（body 为 unknown，宽容读取） */
interface ToolEventIO {
  tool: string;
  /** 原始 tool_use id（engine 记账；老 trace 无此字段 → 回落按名配对） */
  toolUseId: string | undefined;
  input: string | undefined;
  ok: boolean | undefined;
  content: string | undefined;
}

export function traceToMessages(trace: Trace, opts: ReplayOptions = {}): MessageParam[] {
  const includeToolIO = opts.includeToolIO ?? true;
  const maxChars = opts.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;

  const byId = new Map<SpanId, Span>(trace.spans.map((s) => [s.spanId, s]));
  const turns = sortTurns(trace);

  return normalizeForApi(
    [
      ...resumeToolMessages(trace, includeToolIO, maxChars),
      ...expandTurns(turns, byId, includeToolIO, maxChars),
    ],
    REPLAY_HEAD,
    REPLAY_TAIL,
  );
}

export function forkMessages(trace: Trace, opts: ForkReplayOptions): MessageParam[] {
  const includeToolIO = opts.includeToolIO ?? true;
  const maxChars = opts.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;

  const byId = new Map<SpanId, Span>(trace.spans.map((s) => [s.spanId, s]));
  const turns = sortTurns(trace);

  // 主循环回合 = 直属 run 根的 llm.turn；记录它们在全量时序里的位置
  const mainPositions: number[] = [];
  turns.forEach((t, i) => {
    if (t.parentSpanId === trace.rootSpanId) mainPositions.push(i);
  });
  const total = mainPositions.length;
  const { atTurn } = opts;
  if (!Number.isInteger(atTurn) || atTurn < 0 || atTurn >= total) {
    throw new Error(
      total === 0
        ? `forkMessages: atTurn=${atTurn} 越界 —— 该 trace 主循环共 0 回合，无可分叉点`
        : `forkMessages: atTurn=${atTurn} 越界 —— 该 trace 主循环共 ${total} 回合` +
            `（合法范围 0..${total - 1}）`,
    );
  }

  // 截断点 = 第 atTurn 个主循环回合在时序中的位置：该位置起（含）的回合不展开；
  // 位置之前的子 agent 嵌套回合保留（它们是分叉点前历史的一部分）
  const kept = turns.slice(0, mainPositions[atTurn]);

  const head =
    `[fork] 以下来自已完成 run ${trace.traceId} 的前 ${atTurn}/${total} 回合 trace 重放` +
    `（assistant 文本为标注占位，非逐字原文），请从分叉点继续。`;

  const messages: MessageParam[] = [
    // fork 头无条件在最前（溯源信息必须存在，不能像 replay 头那样「首条已是 user 就省」）
    { role: 'user', content: head },
    ...resumeToolMessages(trace, includeToolIO, maxChars),
    ...expandTurns(kept, byId, includeToolIO, maxChars),
    ...(opts.append ?? []),
  ];
  return normalizeForApi(messages, head, FORK_TAIL);
}

/**
 * 续跑段的工具往返（2026-11-07 深评）：HITL / timer 恢复段在**没有 llm.turn** 的情况下
 * 执行上一段留下的 tool_use，事件记在 run 根上（见 engine/loop.ts 的续跑入口）。
 * `expandTurns` 只读 llm.turn，于是这些 tool_use/tool_result 在重放里完全消失。
 * 这里把 run 根上的 tool.input/output 合成一条 assistant + user 对，插在最前面
 * （续跑段的工具执行发生在该段第一个模型回合之前）。
 */
function resumeToolMessages(
  trace: Trace,
  includeToolIO: boolean,
  maxChars: number,
): MessageParam[] {
  if (!includeToolIO) return [];
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  if (!root) return [];
  const inputs = eventsOf(root, TOOL_INPUT_EVENT);
  if (inputs.length === 0) return [];
  const outputs = eventsOf(root, TOOL_OUTPUT_EVENT);
  const used = new Set<number>();
  const pairs: Array<{ id: string; output: ToolEventIO | undefined }> = [];
  const content: ContentBlockParam[] = [
    { type: 'text', text: '[replay] 续跑段在无 llm.turn 的情况下执行的未决工具' },
  ];
  let seq = 0;
  for (const input of inputs) {
    let idx =
      input.toolUseId === undefined
        ? -1
        : outputs.findIndex((o, j) => !used.has(j) && o.toolUseId === input.toolUseId);
    if (idx < 0) idx = outputs.findIndex((o, j) => !used.has(j) && o.tool === input.tool);
    if (idx < 0) idx = outputs.findIndex((_, j) => !used.has(j));
    const output = idx >= 0 ? outputs[idx] : undefined;
    if (idx >= 0) used.add(idx);
    const id = `replay_resume_${++seq}`;
    pairs.push({ id, output });
    content.push({
      type: 'tool_use',
      id,
      name: input.tool,
      input: parseInput(input.input, maxChars),
    });
  }
  return [
    { role: 'assistant', content },
    {
      role: 'user',
      content: pairs.map(({ id, output }) => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: output
          ? truncateWithMark(output.content ?? '', maxChars)
          : '[replay] trace 中缺失对应 tool.output 事件',
        is_error: output ? output.ok === false : true,
      })),
    },
  ];
}

/** 全部 llm.turn 按 startedAt 时序排列（稳定排序：同刻保 spans 数组插入序） */
function sortTurns(trace: Trace): Span[] {
  return trace.spans.filter((s) => s.kind === 'llm.turn').sort((a, b) => a.startedAt - b.startedAt);
}

/** 回合 → 消息展开（traceToMessages / forkMessages 共用；不含 normalize 与头尾合成） */
function expandTurns(
  turns: Span[],
  byId: Map<SpanId, Span>,
  includeToolIO: boolean,
  maxChars: number,
): MessageParam[] {
  const messages: MessageParam[] = [];
  let seq = 0;

  turns.forEach((turn, i) => {
    const capability = nearestCapabilityName(turn, byId);
    const note =
      `[replay turn ${i + 1}/${turns.length}] model=${turn.name} ` +
      `capability=${capability ?? '(主 agent run)'} span=${turn.spanId}`;

    const content: ContentBlockParam[] = [{ type: 'text', text: note }];
    const pairs: Array<{ id: string; output: ToolEventIO | undefined }> = [];

    if (includeToolIO) {
      const inputs = eventsOf(turn, TOOL_INPUT_EVENT);
      const outputs = eventsOf(turn, TOOL_OUTPUT_EVENT);
      const used = new Set<number>();
      for (const input of inputs) {
        // 配对优先级：同 id 精确匹配 > 同名最早未配对 > 最早未配对。
        // 同名工具并行时同名的那个回落会把入参出参张冠李戴，id 才是唯一可靠的锚。
        let idx =
          input.toolUseId === undefined
            ? -1
            : outputs.findIndex((o, j) => !used.has(j) && o.toolUseId === input.toolUseId);
        if (idx < 0) idx = outputs.findIndex((o, j) => !used.has(j) && o.tool === input.tool);
        if (idx < 0) idx = outputs.findIndex((_, j) => !used.has(j));
        const output = idx >= 0 ? outputs[idx] : undefined;
        if (idx >= 0) used.add(idx);

        const id = `replay_tu_${++seq}`;
        pairs.push({ id, output });
        content.push({
          type: 'tool_use',
          id,
          name: input.tool,
          input: parseInput(input.input, maxChars),
        });
      }
    }

    messages.push({ role: 'assistant', content });

    if (pairs.length > 0) {
      // tool_use 后必须紧跟含对应 tool_result 的 user 消息（role 交替合法）
      messages.push({
        role: 'user',
        content: pairs.map(({ id, output }) => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: output
            ? truncateWithMark(output.content ?? '', maxChars)
            : '[replay] trace 中缺失对应 tool.output 事件',
          is_error: output ? output.ok === false : true,
        })),
      });
    }
  });

  return messages;
}

/** 前置 user 说明（API 要求首条为 user；trace 不含 run 的原始输入） */
const REPLAY_HEAD =
  '[replay] 以下是一次已完成 run 的 trace 重放（assistant 文本为标注占位，非逐字原文）。';
/** 收尾 user 请求：末条为 assistant 会被 API 当作 prefill */
const REPLAY_TAIL = '[replay] 以上是全部回合，请分析这次 run 的过程与结果。';
/** fork 收尾：仅在末条非 user 时补一条简短的「请继续」user */
const FORK_TAIL = '[fork] 以上是分叉点前的全部回合，请继续。';

/**
 * 规整为可直接喂回 Messages API 的形态：
 * - 连续同 role 消息合并（无 tool 对的连续 assistant 会合流，交替保持合法；
 *   带 tool_use 的 assistant 之后必有其 tool_result user，配对不受影响）；
 * - 首条确保为 user（API 硬要求）——trace 不含 run 的原始输入，前置一条说明性 user（head）；
 * - **末条也确保为 user**：多数 run 以 `end_turn` 的 assistant 回合收尾，直接喂回就是
 *   assistant prefill —— 缺省模型（claude-opus-5 / claude-sonnet-5）上会 400。
 *   空 trace（无 llm.turn）返回的也是这条前置 user，而非 `[]`（空 messages 同样非法）。
 * head/tail 文案由调用方给（replay 与 fork 语义不同），规整逻辑两者一致。
 */
function normalizeForApi(messages: MessageParam[], head: string, tail: string): MessageParam[] {
  const merged: MessageParam[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
    } else {
      merged.push({ role: m.role, content: toBlocks(m.content) });
    }
  }
  if (merged[0]?.role !== 'user') merged.unshift({ role: 'user', content: head });
  if (merged[merged.length - 1]!.role !== 'user') {
    merged.push({ role: 'user', content: tail });
  }
  return merged;
}

function toBlocks(content: MessageParam['content']): ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
}

/** 向上找最近的 capability span 名（子 agent 嵌套回合的来源标注）；直属 run 根则 null */
function nearestCapabilityName(span: Span, byId: Map<SpanId, Span>): string | null {
  let cur = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
  while (cur) {
    if (cur.kind === 'capability') return cur.name;
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
  }
  return null;
}

/** 取某回合的指定事件并规整为 ToolEventIO（body 是 unknown，宽容读取） */
function eventsOf(turn: Span, name: string): ToolEventIO[] {
  return turn.events
    .filter((e) => e.name === name)
    .map((e) => {
      const b = (e.body ?? {}) as Record<string, unknown>;
      return {
        tool: typeof b.tool === 'string' ? b.tool : 'unknown',
        toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
        input: asString(b.input),
        ok: typeof b.ok === 'boolean' ? b.ok : undefined,
        content: asString(b.content),
      };
    });
}

function asString(x: unknown): string | undefined {
  // 与 core/json.ts 的 stringifySafe 同源；仅额外把 undefined 视作「无值」
  return x === undefined ? undefined : stringifySafe(x);
}

/** 入参还原：截断后尝试 JSON.parse 回对象，失败包 {_raw}（tool_use.input 必须是 object，否则 API 400） */
function parseInput(raw: string | undefined, maxChars: number): unknown {
  const s = truncateWithMark(raw ?? '', maxChars);
  try {
    const parsed = JSON.parse(s) as unknown;
    // 数组也是 object，但 tool_use.input 必须是**对象**（API 侧会 400）—— 与自述一致地挡掉
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : { _raw: s };
  } catch {
    return { _raw: s };
  }
}
