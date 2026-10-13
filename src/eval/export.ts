import type { MessageParam } from '../core/message.js';
import type { Span, Trace } from '../core/trace.js';
import { TOOL_INPUT_EVENT, TOOL_OUTPUT_EVENT, type ToolIoEventName } from '../core/trace.js';
import { stringifySafe } from '../core/json.js';

/**
 * Agentia —— trace → 训练数据导出（R8-P3b，质量闭环的另一半）。
 *
 * `exportRun` 把一条完成的 trace 翻成一份**训练数据记录**（`{ messages, meta }`），
 * CLI `agentia export` 在它的外面包文件读写与过滤（--min-score / --ok-only / --out）。
 * 纯函数：不写文件、不联网。
 *
 * ⚠️ module 级 export，刻意不进 src/index.ts 公共面（与 harvestEvalCase 同款纪律，
 * 见 AGENTS.md「内部工具不进公共面」；CLI 侧是去类型移植副本，逐字对拍守护）。
 *
 * 诚实边界（缺席一律进 `meta.incomplete`，不静默）：
 * - trace 不记 run 的**原始输入** ⇒ messages 首条 user 是占位，标 `incomplete: ['input']`；
 * - assistant 文本只在 run 开了 `traceContent: 'full'`（R8-P3a）时有真值
 *   （llm.turn 的 `output.text` 属性）；缺了**不造占位文本**（占位文本进训练数据是
 *   投毒）—— 该回合的 assistant 消息只剩 tool_use 块，并标 `incomplete`；
 * - 只重建**直属 run 根**的主循环回合（子 agent 嵌套回合不进主线 —— 它们的能力出参
 *   已在主线里；数量记在 `meta.nestedTurns`，与 harvest 同口径）；
 * - tool_use ↔ tool_result 按 `tool_use_id` 配对；缺输出的补 is_error 占位（协议要求
 *   配对合法），有输出没配对的跳过并计数（`meta.droppedOutputs`）—— 都不静默。
 */

export interface ExportRecordMeta {
  traceId: string;
  /** run 根的 model / stop_reason（attributes；没有则 undefined） */
  model: string | undefined;
  stopReason: string | undefined;
  /** trace.status（'ok' / 'error'） */
  status: string;
  /** run 根的 score 事件（attachScore；可能多条 —— 不同维度各记各的） */
  scores: Array<{ name: string; value: number }>;
  /** 略去的子 agent 嵌套回合数（它们不进主线） */
  nestedTurns: number;
  /** 有 tool.output 事件但没配上本回合 tool_use 的条数（被跳过，见文件头） */
  droppedOutputs: number;
  /** 完整性缺口清单（空数组 = 无已知缺口）；值是机器可 grep 的固定词 */
  incomplete: string[];
}

export interface ExportRecord {
  /** Anthropic Messages 形状（MessageParam[]）：首条 user 是占位（见 incomplete） */
  messages: MessageParam[];
  meta: ExportRecordMeta;
}

/** 原始输入占位（trace 不记 run 的原始输入 —— 与 harvest 的占位同一性质，但词不同便于区分来源） */
const INPUT_PLACEHOLDER = '[export] 原始输入未入 trace —— 训练前请补写真实用户输入';

/** tool.input / tool.output 事件体的宽容读取形状（body 是 unknown；与 engine/replay.ts 同源） */
interface ToolIoEvent {
  tool: string;
  toolUseId: string | undefined;
  input: string | undefined;
  ok: boolean | undefined;
  content: string | undefined;
}

function toolEvents(turn: Span, name: ToolIoEventName): ToolIoEvent[] {
  const out: ToolIoEvent[] = [];
  for (const e of turn.events) {
    if (e.name !== name) continue;
    const b = (e.body ?? {}) as Record<string, unknown>;
    // 缺 `tool` 的事件跳过、不回填占位名（伪造的 'unknown' 会变成一个断言必然通过 /
    // 训练必然「学会」的假工具调用 —— 与 harvest 同一条纪律）
    if (typeof b.tool !== 'string') continue;
    out.push({
      tool: b.tool,
      toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
      input: b.input === undefined ? undefined : stringifySafe(b.input),
      ok: typeof b.ok === 'boolean' ? b.ok : undefined,
      content: b.content === undefined ? undefined : stringifySafe(b.content),
    });
  }
  return out;
}

/** 入参还原：尝试 JSON.parse 回对象，失败（或非 object）包 {_raw}（tool_use.input 必须是 object） */
function parseToolInput(raw: string | undefined): Record<string, unknown> {
  const s = raw ?? '';
  try {
    const parsed = JSON.parse(s) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { _raw: s };
  } catch {
    return { _raw: s };
  }
}

/** 导出一条 trace 为训练数据记录（形状与纪律见文件头）。 */
export function exportRun(trace: Trace): ExportRecord {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  const mainTurns = trace.spans
    .filter((s) => s.kind === 'llm.turn' && s.parentSpanId === trace.rootSpanId)
    .sort((a, b) => a.startedAt - b.startedAt);
  const nestedTurns = trace.spans.filter(
    (s) => s.kind === 'llm.turn' && s.parentSpanId !== trace.rootSpanId,
  ).length;

  const incomplete: string[] = ['input']; // 首条 user 恒为占位（trace 不记原始输入）
  let droppedOutputs = 0;
  let tuSeq = 0;
  // 「本 run 压根没开 traceContent」是 run 根上的 ground truth（loop.ts 写入）。它不能直接
  // 用来标缺口（合成 / 老 trace 可能没有这个属性，却真的有正文），只在**收尾**时与
  // 「整棵 trace 一行正文都没有」合取使用，见下面那段。
  const textRecorded = root?.attributes['config.traceContent'] === 'full';
  let anyTextRecorded = false;

  const messages: MessageParam[] = [{ role: 'user', content: INPUT_PLACEHOLDER }];

  for (const turn of mainTurns) {
    const content: Array<Record<string, unknown>> = [];
    // assistant 文本：只记真值（output.text，R8-P3a）；缺了不造占位（占位文本进训练数据是投毒）。
    // 缺口判定：纯 tool_use 回合**本来就没文本**（引擎只在文本非空时记 output.text），
    // 不算缺口；没有 tool_use 又没有文本的回合（终端回合）缺文本才是真缺口。
    const inputs = toolEvents(turn, TOOL_INPUT_EVENT);
    // ⚠️ 宽容读取（`?.`）：trace 经 JSONL / 手搓对象回来时可能没有 `attributes`
    // 字段（类型上说必填、运行时不是）—— CLI 那份移植副本一直这么读，两侧产物必须一致。
    const text = turn.attributes?.['output.text'];
    if (typeof text === 'string' && text !== '') {
      anyTextRecorded = true;
      content.push({ type: 'text', text });
    } else if (inputs.length === 0 && !incomplete.includes('assistant-text')) {
      incomplete.push('assistant-text');
    }
    const usedIds: string[] = [];
    for (const e of inputs) {
      const id = e.toolUseId ?? `export_tu_${++tuSeq}`; // 老 trace 无 id 时合成（replay 同款）
      usedIds.push(id);
      content.push({ type: 'tool_use', id, name: e.tool, input: parseToolInput(e.input) });
    }
    if (content.length > 0) messages.push({ role: 'assistant', content: content as never });

    // tool_result 配对：按 tool_use_id 配本回合的 tool.output；缺输出的补 is_error 占位
    // （协议要求每个 tool_use 都有配对 tool_result —— 残缺历史喂训练是静音投毒）
    if (usedIds.length > 0) {
      const outputs = toolEvents(turn, TOOL_OUTPUT_EVENT);
      const byId = new Map(outputs.map((o) => [o.toolUseId, o]));
      const results: Array<Record<string, unknown>> = [];
      for (const [i, id] of usedIds.entries()) {
        const out = byId.get(id) ?? (outputs[i]?.toolUseId === undefined ? outputs[i] : undefined);
        if (out === undefined) {
          results.push({
            type: 'tool_result',
            tool_use_id: id,
            is_error: true,
            content: '[export] 该 tool_use 的输出未入 trace（失败/截断的 run 段）',
          });
          continue;
        }
        results.push({
          type: 'tool_result',
          tool_use_id: id,
          ...(out.ok === false ? { is_error: true } : {}),
          content: out.content ?? '',
        });
      }
      // 有输出却没配上本回合任何 tool_use（id 对不上）：跳过并计数，不静默丢
      droppedOutputs += outputs.filter(
        (o) => o.toolUseId !== undefined && !usedIds.includes(o.toolUseId),
      ).length;
      messages.push({ role: 'user', content: results as never });
    }
  }

  // 收尾判定（2026-09-27 ⑤）：整棵 trace 一行正文都没有、且本 run 没开 traceContent
  // ⇒ 缺的不只是「终端回合那句话」：**混合回合**（模型先说一句再调工具）的真实正文同样
  // 不在 trace 里，而只看「本回合有没有 tool_use」是判不出来的（那种回合按定义就是
  // 「本来没文本」）。两条合取才成立：有正文就不标（合成 / 老 trace 也照顾到），
  // 开了 traceContent 而没正文也不标（那是模型确实没说话，不是记录缺口）。
  if (!anyTextRecorded && !textRecorded && !incomplete.includes('assistant-text')) {
    incomplete.push('assistant-text');
  }
  // SFT 形状（2026-09-27 ⑤）：末条是 user ⇒ 这条样本**没有 loss 目标**（训练器会静默
  // 丢掉它），而它恰恰是「run 没有终答」的形状（半截 run / 只剩工具往返）。标注出来，
  // 别让下游以为每条都能直接用：`--ok-only` 挡不住它 —— status ok ≠ 有终答。
  if (
    messages[messages.length - 1]?.role === 'user' &&
    !incomplete.includes('no-final-assistant')
  ) {
    incomplete.push('no-final-assistant');
  }

  const scores: ExportRecordMeta['scores'] = [];
  for (const e of root?.events ?? []) {
    if (e.name !== 'score') continue;
    const b = (e.body ?? {}) as Record<string, unknown>;
    if (typeof b.name === 'string' && typeof b.value === 'number') {
      scores.push({ name: b.name, value: b.value });
    }
  }

  return {
    messages,
    meta: {
      traceId: trace.traceId,
      model: typeof root?.attributes.model === 'string' ? root.attributes.model : undefined,
      stopReason:
        typeof root?.attributes.stop_reason === 'string' ? root.attributes.stop_reason : undefined,
      // `?? ''` 与 CLI 副本同款：trace 缺 status 时两侧产物必须逐字一致（对拍守着）
      status: trace.status ?? '',
      scores,
      nestedTurns,
      droppedOutputs,
      incomplete,
    },
  };
}
