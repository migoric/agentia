/**
 * `agentia harvest <file.jsonl>` —— 线上 trace 回流 eval 用例（R7 质量闭环的 CLI 薄壳）。
 *
 * 读 trace 落盘文件（裸 Trace 或 TaskRecord，同 `agentia report` 的两种输入），每条
 * 记录翻成一个「可粘贴进 eval 文件」的用例骨架（`client: scriptedClient([...])` 按
 * trace 的 llm.turn 重建），汇总成一个 eval TS 脚手架写到 --out（缺省 stdout）。
 *
 * ⚠️ 用例骨架生成器与框架侧 `src/eval/harvest.ts` 的 `harvestEvalCase` **同源同形** ——
 * CLI 零运行时依赖、不能 import 框架，此处是去类型移植（正文逐行相同，另有 3 处空值兜底：
 * `trace.spans ?? []`、`startedAt ?? 0` ×2）。**产物**逐字一致由
 * packages/cli/test/harvest.test.mjs 的对拍守着（改生成格式必须两边同步）。
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extractTrace } from './report.js';

/* ── 以下是 src/eval/harvest.ts 的去类型移植（保持逐字同形）────────────────── */

interface SpanLike {
  spanId?: string;
  parentSpanId?: string | null;
  kind?: string;
  name?: string;
  startedAt?: number;
  attributes?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  events?: Array<{ name?: string; body?: unknown }>;
}

interface HarvestTraceLike {
  traceId?: string;
  rootSpanId?: string;
  status?: string;
  spans?: SpanLike[];
}

/** trace 没开 `traceContent`（或该回合确实没说话）时，脚本 text 块的统一占位（与框架侧同一个词） */
const ASSISTANT_TEXT_PLACEHOLDER = '[harvest] assistant 文本未入 trace';

/** 取本回合的真实 assistant 文本 —— 只认 opt-in 的 `output.text`（与框架侧逐字同形） */
function assistantTextOf(turn: SpanLike): string | null {
  const text = turn.attributes?.['output.text'];
  return typeof text === 'string' && text !== '' ? text : null;
}

/** 任意值 → 字符串（core/json.ts stringifySafe 的移植） */
function stringifySafe(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

interface ToolInputEvent {
  tool: string;
  toolUseId?: string | undefined;
  input?: string | undefined;
}

function toolInputsOf(turn: SpanLike): ToolInputEvent[] {
  const out: ToolInputEvent[] = [];
  for (const e of turn.events ?? []) {
    if (e.name !== 'tool.input') continue;
    const b = (e.body ?? {}) as Record<string, unknown>;
    // 缺 `tool` 的事件**跳过**，不回填占位名（与框架侧 src/eval/harvest.ts 逐字同步）：
    // 伪造的 'unknown' 会在生成的脚本里变成一个真的（且断言必然通过的）工具调用。
    if (typeof b.tool !== 'string') continue;
    out.push({
      tool: b.tool,
      toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
      input: b.input === undefined ? undefined : stringifySafe(b.input),
    });
  }
  return out;
}

/** 注释里只放单行：外来 trace 的 name/source/traceId 含换行会击穿生成物的注释语法 */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

function parseToolInput(raw: string | undefined): unknown {
  const s = raw ?? '';
  try {
    const parsed = JSON.parse(s) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : { _raw: s };
  } catch {
    return { _raw: s };
  }
}

function toMessageUsage(u: SpanLike['usage']): Record<string, number> {
  return {
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    cache_read_input_tokens: u?.cacheReadTokens ?? 0,
    cache_creation_input_tokens: u?.cacheCreationTokens ?? 0,
  };
}

interface MessageParamLike {
  role?: string;
  content?: unknown;
}

function lastUserText(messages: MessageParamLike[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : ((m.content as Array<{ type?: string; text?: string }>) ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n');
    if (text.trim()) return text;
  }
  return null;
}

export interface HarvestCaseArgs {
  trace: HarvestTraceLike;
  messages?: MessageParamLike[];
  name?: string;
  source?: string;
}

/** 与框架侧 harvestEvalCase 逐字同形的生成器（见文件头注释的对拍测试） */
export function harvestEvalCase(input: HarvestCaseArgs): string {
  const { trace } = input;
  const name = oneLine(input.name ?? `harvest-${trace.traceId}`);

  const spans = trace.spans ?? [];
  const mainTurns = spans
    .filter((s) => s.kind === 'llm.turn' && s.parentSpanId === trace.rootSpanId)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const nestedCount = spans.filter(
    (s) => s.kind === 'llm.turn' && s.parentSpanId !== trace.rootSpanId,
  ).length;

  let tuSeq = 0;
  const steps = mainTurns.map((turn, i) => {
    const inputs = toolInputsOf(turn);
    const text = assistantTextOf(turn);
    const content: Array<Record<string, unknown>> = [];
    if (text !== null) {
      content.push({ type: 'text', text });
    } else if (inputs.length === 0) {
      // 只有「既没文本又没工具」的终端回合才放占位（与框架侧逐字同步）
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
    `// ┄┄ harvest 用例骨架：${name}（trace ${oneLine(trace.traceId ?? '')}${input.source ? `，来源 ${oneLine(input.source)}` : ''}）┄┄`,
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
    "        s.events.filter((e) => e.name === 'tool.input').map((e) => (e.body || {}).tool),",
    '      );',
    `    assert.deepEqual(tools, ${JSON.stringify(toolSeq)});`,
    '  },',
    '}',
  );

  return `${head.join('\n')}\n${body.join('\n')}\n`;
}

/* ── 命令本体：读 JSONL → 过滤 → 汇总成一个 eval TS 脚手架 ─────────────────── */

interface HarvestRow {
  trace: HarvestTraceLike;
  messages?: MessageParamLike[] | undefined;
  failed: boolean;
  label: string;
}

/** 一行 JSON → harvest 行（裸 Trace 没有 spec.messages/status，按 trace.status 判失败） */
function toRow(v: unknown, index: number): HarvestRow | null {
  const t = extractTrace(v);
  if (!t) return null;
  const bare = (t as unknown) === v;
  const o = bare ? {} : (v as Record<string, unknown>);
  const spec = o.spec as Record<string, unknown> | undefined;
  return {
    trace: t as unknown as HarvestTraceLike,
    messages: Array.isArray(spec?.messages) ? (spec.messages as MessageParamLike[]) : undefined,
    failed: o.status === 'failed' || t.status === 'error',
    label: t.traceId ?? `row-${index + 1}`,
  };
}

/** 用法串（cli.ts 的子命令 `--help` 也从这里取，避免两处各写一份） */
export const USAGE =
  '用法：agentia harvest <trace.jsonl> [--out <file.ts>] [--force] [--failed] [--limit N]';

function renderEvalFile(opts: {
  file: string;
  cases: string[];
  onlyFailed: boolean;
  badLines: number;
}): string {
  const note =
    `来源：${opts.file}，${opts.cases.length} 条记录${opts.onlyFailed ? '（仅失败）' : ''}` +
    (opts.badLines > 0 ? `，跳过无法解析 ${opts.badLines} 行` : '');
  const cases = opts.cases.map((c) => c.replace(/\n$/, '').replace(/^/gm, '  ')).join(',\n');
  return `// 由 \`agentia harvest\` 生成的 eval 用例脚手架（${note}）
// ⚠️ 这是脚手架：assistant 文本视 trace 而定（run 开了 traceContent: 'full' 则取自
//     output.text，否则只含工具调用）；每个用例里的 expect 是
//     从原 trace 抄录的「实际轨迹」—— 发生过 ≠ 应该发生，人工核对后再进 CI。
import assert from 'node:assert/strict';
import { defineEval, scriptedClient } from '@migor/agentia';

export const harvestedCases = [
${cases}
];

// ── 跑法（核对完用例后取消注释，并按你的装配改 app）────────────────────
// import { createApp } from '@migor/agentia';
//
// defineEval({
//   name: 'harvested-regression',
//   app: () => createApp({ /* …你的装配… */ }),
//   // EvalCase 没有 expect 字段：喂进 defineEval 前先把各用例骨架里的 expect 拆掉
//   // （断言搬进下面 defineEval 的 expect 里，可按用例分支）。
//   cases: harvestedCases.map(({ expect: _draft, ...c }) => c),
//   expect: (result, { trace }) => {
//     // 例：assert.equal(result.stopReason, 'end_turn');
//   },
// })
//   .run()
//   .then((r) => {
//     console.log(r.ok ? \`✓ \${r.passed}/\${r.total} 通过\` : r);
//     if (!r.ok) process.exit(1);
//   });
`;
}

/** 失败一律**抛错**（同 report 命令：异步命令就地设 exitCode 会被 cli.ts 末尾覆盖） */
export async function harvestCommand(args: string[]): Promise<number> {
  let file: string | undefined;
  let out: string | undefined;
  let onlyFailed = false;
  let force = false;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--failed') {
      onlyFailed = true;
    } else if (a === '--force') {
      force = true;
    } else if (a === '--out') {
      out = args[i + 1];
      if (out === undefined) throw new Error(`--out 需要一个文件参数\n${USAGE}`);
      i += 1;
    } else if (a === '--limit') {
      const raw = args[i + 1];
      limit = Number(raw);
      if (raw === undefined || !Number.isInteger(limit) || limit < 1) {
        throw new Error(`--limit 需要一个正整数\n${USAGE}`);
      }
      i += 1;
    } else if (a.startsWith('--')) {
      throw new Error(`未知参数：${a}\n${USAGE}`);
    } else if (file === undefined) {
      file = a;
    } else {
      throw new Error(USAGE);
    }
  }
  if (file === undefined) throw new Error(USAGE);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到文件 ${file}（${(e as Error).message}）`);
  }

  const rows: HarvestRow[] = [];
  let badLines = 0;
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = toRow(JSON.parse(s), lineNo);
      if (row) rows.push(row);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
    lineNo += 1;
  }
  if (rows.length === 0) {
    throw new Error(
      `${file} 里没有可识别的 trace（支持裸 Trace 或含 result.trace / trace 的记录）` +
        (badLines > 0 ? `；另有 ${badLines} 行无法解析` : ''),
    );
  }

  const picked = rows.filter((r) => !onlyFailed || r.failed).slice(0, limit ?? rows.length);
  const cases = picked.map((r) =>
    // messages 是 harvestEvalCase 的公共入参（签名不动）⇒ 调用点条件展开，不把 undefined 传进去
    harvestEvalCase({
      trace: r.trace,
      ...(r.messages !== undefined ? { messages: r.messages } : {}),
      name: `harvest-${r.label}`,
      source: file,
    }),
  );
  const content = renderEvalFile({ file, cases, onlyFailed, badLines });

  if (out === undefined) {
    process.stdout.write(content);
  } else {
    // 产物是「人工核对后再进 CI」的脚手架，它的价值恰恰在用户手改过的断言与 input 上：
    // 重跑一次就静默抹掉等于毁掉那份人工成果，所以默认拒绝覆盖（要覆盖显式 --force）。
    if (!force && existsSync(out)) {
      throw new Error(`${out} 已存在（产物需人工核对，默认不覆盖）；要覆盖请加 --force\n${USAGE}`);
    }
    await writeFile(out, content, 'utf8');
    console.log(
      `已写出 ${out}：${picked.length} 个用例骨架` +
        (onlyFailed ? '（仅失败记录）' : '') +
        ` —— 核对占位文本与断言后再进 CI`,
    );
  }
  return 0;
}
