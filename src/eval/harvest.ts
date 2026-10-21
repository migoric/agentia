import type { MessageParam, TextBlockParam } from '../core/message.js';
import type { Span, Trace } from '../core/trace.js';
import { TOOL_INPUT_EVENT } from '../core/trace.js';
import { stringifySafe } from '../core/json.js';

/**
 * Agentia —— 线上 trace 回流 eval 数据集（R7 质量闭环）。
 *
 * `harvestEvalCase` 把一条线上 trace（+ 可选的原始输入）翻成一段 **TS 源码字符串**：
 * 一个可粘贴进 eval 文件的用例字面量骨架 —— `client: scriptedClient([...])` 的脚本
 * 按 trace 的 llm.turn 逐回合重建，`expect` 预填「主循环工具序列」的轨迹断言。
 * 纯函数：不写文件、不联网（CLI `agentia harvest` 在它的外面包文件读写）。
 *
 * ⚠️ module 级 export，刻意不进 src/index.ts 公共面（见 AGENTS.md「内部工具不进公共面」）。
 *
 * 已知边界（生成物顶部注释也会如实写明，不靠用的人自己发现）：
 * - assistant 文本**要看 run 开没开 `traceContent: 'full'`**（R8-P3a，opt-in）：开了就取
 *   llm.turn 的 `output.text` 真值，没开则只含工具调用、终端回合的 text 是占位
 *   （早先这里写死「trace 不记文本」—— 开关开了照样给占位，等于让付了体积与脱敏代价的
 *   用户拿到跑不起来的用例；2026-10-21 修）；
 * - 只重建**直属 run 根**的主循环回合 —— 子 agent 的嵌套回合不走主循环脚本
 *   （scriptedClient 驱动的是主 agent 的模型往返）；
 * - `expect` 是从该 trace **抄录的实际轨迹**：发生过 ≠ 应该发生，人工核对后再进 CI；
 * - EvalCase 没有 expect 字段，粘贴时把它搬进 defineEval 的 expect（骨架注释会教）。
 */

export interface HarvestEvalCaseInput {
  /** 一条完成的线上 trace（run 根 + llm.turn + 事件） */
  trace: Trace;
  /** 原始输入（TaskRecord 的 spec.messages）；没有则 input 用占位并注释提醒 */
  messages?: MessageParam[];
  /** 用例名；缺省 `harvest-<traceId>` */
  name?: string;
  /** 来源标注（只写进注释，如 jsonl 文件名） */
  source?: string;
}

/** trace 没开 `traceContent`（或该回合确实没说话）时，脚本 text 块的统一占位（两侧同一个词） */
const ASSISTANT_TEXT_PLACEHOLDER = '[harvest] assistant 文本未入 trace';

/**
 * 取本回合的真实 assistant 文本 —— 只认 opt-in 的 `output.text`（R8-P3a，`turn.ts` 写入）。
 * ⚠️ 与 `src/eval/export.ts` 同一条读法（含 `?.` 宽容读取）：trace 经 JSONL 回来后
 * `attributes` 可能不在（类型上说必填、运行时不是），硬取会抛在「读一条老 trace」上。
 */
function assistantTextOf(turn: Span): string | null {
  const text = turn.attributes?.['output.text'];
  return typeof text === 'string' && text !== '' ? text : null;
}

/** tool.input 事件体的宽容读取形状（body 是 unknown；与 engine/replay.ts 同源） */
interface ToolInputEvent {
  tool: string;
  toolUseId?: string | undefined;
  input?: string | undefined;
}

/** 取某回合的 tool.input 事件并规整（engine 记账：input 已是截断后的字符串） */
function toolInputsOf(turn: Span): ToolInputEvent[] {
  const out: ToolInputEvent[] = [];
  for (const e of turn.events) {
    if (e.name !== TOOL_INPUT_EVENT) continue;
    const b = (e.body ?? {}) as Record<string, unknown>;
    // 缺 `tool` 的事件**跳过**，不回填占位名：伪造的 'unknown' 会在生成的脚本里变成一个
    // 真的（且断言必然通过的）工具调用 —— 骨架自我自洽、永不报错，比缺一条更坏。
    // 引擎在 turn.ts 里恒写 `tool: use.name`，所以这条只对手写/外来 trace 生效。
    if (typeof b.tool !== 'string') continue;
    out.push({
      tool: b.tool,
      toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
      input: b.input === undefined ? undefined : stringifySafe(b.input),
    });
  }
  return out;
}

/** 入参还原：尝试 JSON.parse 回对象，失败（或非 object）包 {_raw}（tool_use.input 必须是 object） */
function parseToolInput(raw: string | undefined): unknown {
  const s = raw ?? '';
  try {
    const parsed = JSON.parse(s) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : { _raw: s };
  } catch {
    return { _raw: s };
  }
}

/** trace 的 Usage（camelCase）→ Anthropic.Message 的 usage（snake_case），缺省补零 */
function toMessageUsage(u: Span['usage']): Record<string, number> {
  return {
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    cache_read_input_tokens: u?.cacheReadTokens ?? 0,
    cache_creation_input_tokens: u?.cacheCreationTokens ?? 0,
  };
}

/** 取 messages 里最后一条非空 user 文本（string 或 text 块拼接）；没有则 null */
function lastUserText(messages: MessageParam[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as TextBlockParam).text)
            .join('\n');
    if (text.trim()) return text;
  }
  return null;
}

/**
 * 生成一个可粘贴进 eval 文件的用例字面量骨架（TS 源码字符串）。
 *
 * 产出是**纯 JS 语法的表达式**（无 TS 类型标注）—— 于是可以被 `new Function` 直接
 * eval 做「生成物可解析」验证，也可以原样粘进 .ts 文件。所有嵌入值一律走
 * JSON.stringify（入参里可能有反引号 / `${`，不能让它们击穿生成物语法）。
 */
/** 注释里只放单行：外来 trace 的 name/source/traceId 含换行会击穿生成物的注释语法 */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

export function harvestEvalCase(input: HarvestEvalCaseInput): string {
  const { trace } = input;
  const name = oneLine(input.name ?? `harvest-${trace.traceId}`);

  // 只取直属 run 根的 llm.turn（子 agent 的嵌套回合挂在 capability span 下，不走主循环脚本）
  const mainTurns = trace.spans
    .filter((s) => s.kind === 'llm.turn' && s.parentSpanId === trace.rootSpanId)
    .sort((a, b) => a.startedAt - b.startedAt);
  const nestedCount = trace.spans.filter(
    (s) => s.kind === 'llm.turn' && s.parentSpanId !== trace.rootSpanId,
  ).length;

  // 每回合 → 一个 assistant 消息：真文本（若 trace 记了）+ 按 tool.input 事件重建的 tool_use 块
  let tuSeq = 0;
  const steps = mainTurns.map((turn, i) => {
    const inputs = toolInputsOf(turn);
    const text = assistantTextOf(turn);
    const content: Array<Record<string, unknown>> = [];
    if (text !== null) {
      content.push({ type: 'text', text });
    } else if (inputs.length === 0) {
      // 只有「既没文本又没工具」的终端回合才放占位：空 content 不是合法的 assistant
      // 消息。⚠️ 纯 tool_use 回合**本来就没文本**（引擎只在文本非空时记 output.text）
      // ⇒ 绝不能补占位，那会变成一条「模型说过这句话」的假事实。
      content.push({ type: 'text', text: ASSISTANT_TEXT_PLACEHOLDER });
    }
    for (const e of inputs) {
      content.push({
        type: 'tool_use',
        id: e.toolUseId ?? `harvest_tu_${++tuSeq}`,
        name: e.tool,
        input: parseToolInput(e.input),
      });
    }
    return {
      id: `harvest_m_${i + 1}`,
      model: turn.name,
      stop_reason: inputs.length > 0 ? 'tool_use' : 'end_turn',
      usage: toMessageUsage(turn.usage),
      content,
    };
  });
  const toolSeq = mainTurns.flatMap((t) => toolInputsOf(t).map((e) => e.tool));
  const userText = lastUserText(input.messages);
  const textTurns = mainTurns.filter((t) => assistantTextOf(t) !== null).length;

  const head: string[] = [
    `// ┄┄ harvest 用例骨架：${name}（trace ${oneLine(trace.traceId)}${input.source ? `，来源 ${oneLine(input.source)}` : ''}）┄┄`,
    '// ⚠️ 脚手架，不是成品 —— 人工核对后再进 CI：',
  ];
  if (textTurns > 0) {
    head.push(
      `//   · assistant 文本取自 trace 的 output.text（该 run 开了 traceContent: 'full'）` +
        (textTurns < mainTurns.length
          ? `；${mainTurns.length - textTurns} 个回合没有文本（纯 tool_use 回合本来就没文本）；`
          : '；'),
    );
  } else {
    head.push(
      "//   · trace 里没有 assistant 文本（该 run 未开 traceContent: 'full'）—— 脚本只含工具调用，",
      '//     终端回合的 text 是占位；要真文本请在 app 里开 traceContent 后重跑再 harvest；',
    );
  }
  if (nestedCount > 0) {
    head.push(
      `//   · 只含主循环 ${mainTurns.length} 个回合；${nestedCount} 个子 agent 嵌套回合已略去`,
      '//     （嵌套回合不走主循环脚本，scriptedClient 驱动不了它们；要覆盖子 agent 请单独写 eval）；',
    );
  } else {
    head.push(`//   · 含主循环全部 ${mainTurns.length} 个回合（无子 agent 嵌套回合）；`);
  }
  head.push(
    '//   · EvalCase 没有 expect 字段：下面的 expect 是草稿，粘贴时把它搬进',
    '//     defineEval({ expect })。其中的工具序列是从原 trace 抄录的「实际轨迹」——',
    '//     发生过 ≠ 应该发生，核对过再留作断言。',
  );

  const body: string[] = ['{', `  name: ${JSON.stringify(name)},`];
  if (userText === null) {
    body.push(
      '  // ⚠️ 未提供原始输入（TaskRecord 的 spec.messages）—— input 是占位，请人工补写：',
      `  input: '[harvest] 原始输入未知，请人工补写',`,
    );
  } else {
    body.push(`  input: ${JSON.stringify(userText)},`);
  }
  if (steps.length === 0) {
    body.push('  // ⚠️ trace 里没有主循环 llm.turn —— 脚本为空，请人工补写：');
    body.push('  client: scriptedClient([]),');
  } else {
    body.push('  client: scriptedClient([');
    body.push(
      steps
        .map((s) =>
          JSON.stringify(s, null, 2)
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n'),
        )
        .join(',\n'),
    );
    body.push('  ]),');
  }
  body.push(
    '  expect: (result, { trace }) => {',
    '    // 主循环实际调用过的工具名序列（直属 run 根的 llm.turn 上的 tool.input 事件）',
    '    const tools = trace.spans',
    "      .filter((s) => s.kind === 'llm.turn' && s.parentSpanId === trace.rootSpanId)",
    '      .sort((a, b) => a.startedAt - b.startedAt)',
    '      .flatMap((s) =>',
    // ⚠️ 这一行是**生成出去的代码文本**（写进 harvested 用例的源码），不是本仓的取值 ——
    // 所以它保留字面量：生成的脚本不 import 本仓常量，改成 `TOOL_INPUT_EVENT` 会得到一个
    // 引用了不存在标识符的脚本（跑起来才炸）。源码级守卫正是按这个理由给它白名单。
    "        s.events.filter((e) => e.name === 'tool.input').map((e) => (e.body || {}).tool),",
    '      );',
    `    assert.deepEqual(tools, ${JSON.stringify(toolSeq)});`,
    '  },',
    '}',
  );

  return `${head.join('\n')}\n${body.join('\n')}\n`;
}
