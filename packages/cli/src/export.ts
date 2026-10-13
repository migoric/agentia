/**
 * `agentia export <file.jsonl>` —— trace 落盘文件 → 训练数据集（JSONL，一行一份
 * `{ messages, meta }`）（R8-P3b：质量闭环的另一半 —— harvest 产 eval 用例，这里产训练数据）。
 *
 * 读 trace 落盘文件（裸 Trace 或含 result.trace / trace 的记录，同 `agentia report` 的
 * 输入），每条翻成一份 Anthropic Messages 形状的训练记录。缺省写 stdout（它**就是**产物，
 * 与 harvest 同款 —— 刻意没有 --json）；`--out <file>` 落盘并在 stderr 打一行汇总。
 *
 * 过滤：`--ok-only`（只要 status ok 的 run）；`--min-score <n>`（run 根 score 事件的
 * 最大值 ≥ n 才保留 —— 没带分数的 run 在此过滤下**被排除**：它们是没判过的，不是及格）。
 *
 * ⚠️ 生成器与框架侧 `src/eval/export.ts` 的 `exportRun` **同源同形** —— CLI 零运行时
 * 依赖、不能 import 框架，此处是去类型移植（正文逐行相同；本地镜像类型用可选字段 +
 * `?? []` / `?? ''` 兜底，与 harvest 移植同款）。**产物**逐字一致由
 * packages/cli/test/export.test.mjs 的对拍守着（改生成格式必须两边同步）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { extractTrace } from './report.js';

/* ── 以下是 src/eval/export.ts 的去类型移植（保持逐字同形）────────────────── */

interface SpanLike {
  spanId?: string;
  parentSpanId?: string | null;
  kind?: string;
  startedAt?: number;
  attributes?: Record<string, unknown>;
  events?: Array<{ name?: string; body?: unknown }>;
}

interface ExportTraceLike {
  traceId?: string;
  rootSpanId?: string;
  status?: string;
  spans?: SpanLike[];
}

/** 原始输入占位（trace 不记 run 的原始输入 —— 与框架侧同一个词） */
const INPUT_PLACEHOLDER = '[export] 原始输入未入 trace —— 训练前请补写真实用户输入';

/** 任意值 → 字符串（core/json.ts stringifySafe 的移植） */
function stringifySafe(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

interface ToolIoEvent {
  tool: string;
  toolUseId: string | undefined;
  input: string | undefined;
  ok: boolean | undefined;
  content: string | undefined;
}

function toolEvents(turn: SpanLike, name: 'tool.input' | 'tool.output'): ToolIoEvent[] {
  const out: ToolIoEvent[] = [];
  for (const e of turn.events ?? []) {
    if (e.name !== name) continue;
    const b = (e.body ?? {}) as Record<string, unknown>;
    // 缺 `tool` 的事件跳过、不回填占位名（与框架侧 src/eval/export.ts 逐字同步）：
    // 伪造的 'unknown' 会变成一个训练必然「学会」的假工具调用。
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

interface ExportRecordMeta {
  traceId: string;
  model: string | undefined;
  stopReason: string | undefined;
  status: string;
  scores: Array<{ name: string; value: number }>;
  nestedTurns: number;
  droppedOutputs: number;
  incomplete: string[];
}

interface ExportRecord {
  messages: Array<{ role: string; content: unknown }>;
  meta: ExportRecordMeta;
}

/** 导出一条 trace 为训练数据记录（与框架侧 exportRun 逐字同形；形状与纪律见其文件头）。 */
export function exportRun(trace: ExportTraceLike): ExportRecord {
  const spans = trace.spans ?? [];
  const root = spans.find((s) => s.spanId === trace.rootSpanId);
  const mainTurns = spans
    .filter((s) => s.kind === 'llm.turn' && s.parentSpanId === trace.rootSpanId)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const nestedTurns = spans.filter(
    (s) => s.kind === 'llm.turn' && s.parentSpanId !== trace.rootSpanId,
  ).length;

  const incomplete: string[] = ['input']; // 首条 user 恒为占位（trace 不记原始输入）
  let droppedOutputs = 0;
  let tuSeq = 0;
  // 「本 run 压根没开 traceContent」是 run 根上的 ground truth（loop.ts 写入）。它不能直接
  // 用来标缺口（合成 / 老 trace 可能没有这个属性，却真的有正文），只在**收尾**时与
  // 「整棵 trace 一行正文都没有」合取使用，见下面那段。
  const textRecorded = root?.attributes?.['config.traceContent'] === 'full';
  let anyTextRecorded = false;

  const messages: ExportRecord['messages'] = [{ role: 'user', content: INPUT_PLACEHOLDER }];

  for (const turn of mainTurns) {
    const content: Array<Record<string, unknown>> = [];
    // assistant 文本：只记真值（output.text，R8-P3a）；缺了不造占位（占位文本进训练数据是投毒）。
    // 缺口判定：纯 tool_use 回合**本来就没文本**（引擎只在文本非空时记 output.text），
    // 不算缺口；没有 tool_use 又没有文本的回合（终端回合）缺文本才是真缺口。
    const inputs = toolEvents(turn, 'tool.input');
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
    if (content.length > 0) messages.push({ role: 'assistant', content });

    // tool_result 配对：按 tool_use_id 配本回合的 tool.output；缺输出的补 is_error 占位
    // （协议要求每个 tool_use 都有配对 tool_result —— 残缺历史喂训练是静音投毒）
    if (usedIds.length > 0) {
      const outputs = toolEvents(turn, 'tool.output');
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
      messages.push({ role: 'user', content: results });
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
      traceId: trace.traceId ?? '',
      model: typeof root?.attributes?.model === 'string' ? root.attributes.model : undefined,
      stopReason:
        typeof root?.attributes?.stop_reason === 'string' ? root.attributes.stop_reason : undefined,
      status: trace.status ?? '',
      scores,
      nestedTurns,
      droppedOutputs,
      incomplete,
    },
  };
}

/* ── CLI 薄壳（框架侧没有对应物：文件读写与过滤是宿主动作）────────────────── */

/** 用法串（cli.ts 的子命令 `--help` 也从这里取，避免两处各写一份） */
export const USAGE =
  '用法：agentia export <trace.jsonl> [--out <file>] [--ok-only] [--min-score <n>]';

/** score 过滤：run 根 score 事件的最大值 >= min 才保留（没带分数的 run 被排除 —— 没判过 ≠ 及格） */
function passScore(rec: ExportRecord, min: number | undefined): boolean {
  if (min === undefined) return true;
  if (rec.meta.scores.length === 0) return false;
  return Math.max(...rec.meta.scores.map((s) => s.value)) >= min;
}

export async function exportCommand(args: string[]): Promise<number> {
  let file: string | undefined;
  let out: string | undefined;
  let okOnly = false;
  let minScore: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--ok-only') {
      okOnly = true;
    } else if (a === '--out') {
      out = args[i + 1];
      if (out === undefined) throw new Error(`--out 需要一个文件参数\n${USAGE}`);
      i += 1;
    } else if (a === '--min-score') {
      const raw = args[i + 1];
      minScore = Number(raw);
      if (raw === undefined || !Number.isFinite(minScore)) {
        throw new Error(`--min-score 需要一个数值\n${USAGE}`);
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

  const records: ExportRecord[] = [];
  let badLines = 0;
  let filtered = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const t = extractTrace(JSON.parse(s)) as ExportTraceLike | null;
      if (!t) {
        badLines += 1;
        continue;
      }
      const rec = exportRun(t);
      if (okOnly && rec.meta.status !== 'ok') {
        filtered += 1;
        continue;
      }
      if (!passScore(rec, minScore)) {
        filtered += 1;
        continue;
      }
      records.push(rec);
    } catch {
      badLines += 1;
    }
  }
  if (records.length === 0) {
    throw new Error(
      `${file} 里没有符合过滤条件的 run` +
        (filtered > 0 ? `（${filtered} 条被过滤）` : '') +
        (badLines > 0 ? `；另有 ${badLines} 行无法解析` : ''),
    );
  }

  const body = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  if (out !== undefined) {
    await writeFile(out, body, 'utf8');
    // 汇总走 stderr：stdout 是产物的纪律在 --out 形态下同样成立（管道里不混人读文本）
    console.error(
      `已写出 ${records.length} 条训练记录 → ${out}` +
        (filtered > 0 ? `（过滤掉 ${filtered} 条）` : '') +
        (badLines > 0 ? `；跳过无法解析 ${badLines} 行` : ''),
    );
  } else {
    process.stdout.write(body);
    // 汇总**也**走 stderr：stdout 是产物的纪律没变，但「跳过了几行」不许静默 ——
    // `--out` 形态会报、既有的 `report` 在 stdout 形态也报，只有这里此前一声不吭
    // ⇒  `agentia export x.jsonl > dataset.jsonl` 静默丢数据（2026-09-27 实测）。
    console.error(
      `已写出 ${records.length} 条训练记录 → stdout` +
        (filtered > 0 ? `（过滤掉 ${filtered} 条）` : '') +
        (badLines > 0 ? `；跳过无法解析 ${badLines} 行` : ''),
    );
  }
  return 0;
}
