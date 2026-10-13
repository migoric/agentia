/**
 * `agentia diff <a.jsonl> <b.jsonl>` —— 两条 trace 的调用树 A/B 比对。
 *
 * 两个文件各取第一条可提取的 trace（裸 Trace 或含 result.trace / trace 的记录，
 * 同 `agentia report` 的输入），跑 diffTraces 后人读输出：run 级 summary + 按 span
 * 分组的字段级差异。diff(1) 语义：**有差异时退出码 1**（等价 0），便于脚本串接；
 * 用法/文件错误照旧抛错走受理模式。
 *
 * ⚠️ 本文件是 src/engine/trace-diff.ts 的**去类型移植副本** —— CLI 零运行时依赖、
 * 不能 import 框架，此处是逐行移植（本地保留同名 interface 使函数体逐字同形）；
 * 逐字对拍守护在 packages/cli/test/diff.test.mjs，**改算法必须两边同步**。
 */
import { readFile } from 'node:fs/promises';
import { extractTrace } from './report.js';

/* ── 以下是 src/engine/trace-diff.ts 的去类型移植（保持逐字同形）────────────────── */

/* core/json.ts 两个小工具的移植（diff 依赖它们） */

/** 任意值 → 字符串：string 原样，其余 JSON.stringify，循环引用等异常回落 String()。 */
function stringifySafe(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

/** 截断到上限字符、超长加省略标记 `…(+N)`。trace 展示（engine/loop）与 replay 共用同一格式。 */
function truncateWithMark(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}

/* core/trace.ts 相关形状的本地镜像（同名，使下方函数体与框架侧逐字同形） */

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costEstimate?: number;
}

interface SpanError {
  type: string;
  message: string;
  retryable: boolean;
}

interface SpanEvent {
  time: number;
  name: string;
  body: unknown;
}

interface Span {
  spanId: string;
  parentSpanId: string | null;
  kind: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  error?: SpanError;
  usage?: Usage;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

interface Trace {
  traceId: string;
  rootSpanId: string;
  spans: Span[];
  status: string;
  totalUsage: Usage;
}

export interface TraceDiffOptions {
  /** 忽略墙钟字段（span startedAt/endedAt、event time），缺省 true —— A/B 比对不关心时序；
   *  false 时改比 span 时长（endedAt-startedAt，未结束为 undefined），绝对时间戳永不比 */
  ignoreTiming?: boolean;
}

export interface DiffEntry {
  /** 字段路径：'status' / 'name' / 'usage.inputTokens' / 'attributes.<key>' /
   *  'events[2].name' / 'events[2].body' / 'events'（计数不等或截断说明） / 'duration' */
  field: string;
  /** 该侧无此值用 undefined */
  a: unknown;
  b: unknown;
}

export interface SpanDiff {
  /** 从根到该 span 的配对路径（人读 + 稳定锚），规则见框架侧文件头 */
  path: string;
  /** 缺侧 = 该侧调用树无此位置（与框架侧同为必填 `| undefined`：结果记录的角色纪律） */
  a: Span | undefined;
  b: Span | undefined;
  /** 两侧都在时的字段级差异；缺侧时为空数组 */
  fields: DiffEntry[];
}

export interface TraceDiff {
  /** 应用 DiffOptions 后是否无差异（summary 与 spans 全空差异） */
  equal: boolean;
  /** run 级差异：status、totalUsage.* 各字段、根 span attributes.<key>
   *  （model/system.version/prompts.versions/session.id 都在这里 —— A/B 模型第一眼就看它）。
   *  traceId 是身份不是行为，永不比 */
  summary: DiffEntry[];
  /** 逐 span 差异（只收有字段差或缺侧的 span；配平且全同的 span 不出现） */
  spans: SpanDiff[];
}

/**
 * `--json` 的输出形状（人类输出的机器可读等价物）。
 * span 只带 `path` / `missing` / `fields` —— 与人类输出展示的信息一致：要看「哪一侧没有这个
 * span」用 `missing`，要看「差在哪个字段」用 `fields`（差异值都在 `fields[].a/b` 里）。
 * 不塞整棵 span（含 events 正文，可能很大）。字段增补是兼容的，改名/删字段是破坏性变更。
 */
export interface DiffJson {
  a: { file: string; traceId: string | null; skippedLines: number };
  b: { file: string; traceId: string | null; skippedLines: number };
  equal: boolean;
  summary: DiffEntry[];
  spans: Array<{ path: string; missing: 'a' | 'b' | null; fields: DiffEntry[] }>;
}

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costEstimate',
] as const;

/** 每个 span 的事件差异最多报 20 条，超出记一条 `events` 截断说明 */
const EVENT_DIFF_LIMIT = 20;
/** 事件 body 差异值截断上限（body 可能很大，防爆） */
const DIFF_VALUE_CHARS = 200;

export function diffTraces(a: Trace, b: Trace, opts: TraceDiffOptions = {}): TraceDiff {
  const ignoreTiming = opts.ignoreTiming ?? true;

  const summary: DiffEntry[] = [];
  if (a.status !== b.status) summary.push({ field: 'status', a: a.status, b: b.status });
  pushUsageDiffs(summary, 'totalUsage', a.totalUsage, b.totalUsage);

  const aRoot = a.spans.find((s) => s.spanId === a.rootSpanId);
  const bRoot = b.spans.find((s) => s.spanId === b.rootSpanId);
  if (aRoot && bRoot) pushAttrDiffs(summary, aRoot.attributes, bRoot.attributes);

  const spans: SpanDiff[] = [];
  const ctx: WalkCtx = {
    aChildren: childrenMap(a),
    bChildren: childrenMap(b),
    ignoreTiming,
    out: spans,
  };
  // 根与根无条件配对（一侧连根都没有时记缺侧）
  if (aRoot || bRoot) {
    walk(aRoot, bRoot, `run:${(aRoot ?? bRoot)!.name}`, ctx);
  }

  return { equal: summary.length === 0 && spans.length === 0, summary, spans };
}

interface WalkCtx {
  aChildren: Map<string, Span[]>;
  bChildren: Map<string, Span[]>;
  ignoreTiming: boolean;
  out: SpanDiff[];
}

/** parentSpanId → 直接子 span（保 spans 数组插入序，供稳定排序前的同刻次序） */
function childrenMap(trace: Trace): Map<string, Span[]> {
  const map = new Map<string, Span[]>();
  for (const s of trace.spans) {
    if (s.parentSpanId === null) continue;
    const kids = map.get(s.parentSpanId);
    if (kids) kids.push(s);
    else map.set(s.parentSpanId, [s]);
  }
  return map;
}

function walk(aSpan: Span | undefined, bSpan: Span | undefined, path: string, ctx: WalkCtx): void {
  const fields = aSpan && bSpan ? diffSpanFields(aSpan, bSpan, ctx.ignoreTiming) : [];
  // 只收有差异的节点：字段差，或缺侧（整棵子树缺失，一条记录代表整支，不再下钻）
  if (fields.length > 0 || !aSpan || !bSpan) {
    ctx.out.push({ path, a: aSpan, b: bSpan, fields });
  }
  if (!aSpan || !bSpan) return;

  const aKids = ctx.aChildren.get(aSpan.spanId) ?? [];
  const bKids = ctx.bChildren.get(bSpan.spanId) ?? [];
  for (const pair of pairChildren(aKids, bKids)) {
    walk(pair.a, pair.b, `${path}/${pair.seg}`, ctx);
  }
}

interface ChildPair {
  a?: Span;
  b?: Span;
  seg: string;
}

/**
 * 配对键：llm.turn 只有 kind（忽略 name —— name 是模型 id，「换模型重跑」是 A/B 主用例，
 * 按 name 配对会把两侧 turn 全报成缺失；模型差异降格为配对 turn 的 name 字段差）；
 * 其余 span 按 `kind:name`（skill:foo vs skill:bar 是不同能力，不该配上）。
 */
function pairKey(s: Span): string {
  return s.kind === 'llm.turn' ? 'llm.turn' : `${s.kind}:${s.name}`;
}

function pairChildren(aKids: Span[], bKids: Span[]): ChildPair[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const s of [...aKids, ...bKids]) {
    const k = pairKey(s);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }

  const pairs: ChildPair[] = [];
  for (const key of keys) {
    // 同键孩子按 startedAt 稳定排序（同刻保插入序）后按下标一一配对
    const as = aKids.filter((s) => pairKey(s) === key).sort((x, y) => x.startedAt - y.startedAt);
    const bs = bKids.filter((s) => pairKey(s) === key).sort((x, y) => x.startedAt - y.startedAt);
    const n = Math.max(as.length, bs.length);
    for (let i = 0; i < n; i++) {
      const sample = as[i] ?? bs[i]!;
      let seg: string;
      if (sample.kind === 'llm.turn') {
        seg = `llm.turn#${i}`;
      } else {
        seg = `${sample.kind}:${sample.name}`;
        if (n > 1) seg += `#${i}`; // 同键重复时加下标区分
      }
      pairs.push({ a: as[i], b: bs[i], seg });
    }
  }
  return pairs;
}

/** 两侧都在时的字段级差异（顺序：status / name / error / usage.* / attributes.* / duration / events） */
function diffSpanFields(a: Span, b: Span, ignoreTiming: boolean): DiffEntry[] {
  const fields: DiffEntry[] = [];
  if (a.status !== b.status) fields.push({ field: 'status', a: a.status, b: b.status });
  if (a.name !== b.name) fields.push({ field: 'name', a: a.name, b: b.name });
  if (!errorEqual(a.error, b.error)) fields.push({ field: 'error', a: a.error, b: b.error });
  pushUsageDiffs(fields, 'usage', a.usage, b.usage);
  pushAttrDiffs(fields, a.attributes, b.attributes);
  if (!ignoreTiming) {
    // 比时长而非绝对时间戳（未结束为 undefined，与已结束也是差异）
    const da = a.endedAt === undefined ? undefined : a.endedAt - a.startedAt;
    const db = b.endedAt === undefined ? undefined : b.endedAt - b.startedAt;
    if (da !== db) fields.push({ field: 'duration', a: da, b: db });
  }
  pushEventDiffs(fields, a.events, b.events);
  return fields;
}

/** error 比 type + message + retryable 三元组 */
function errorEqual(x: SpanError | undefined, y: SpanError | undefined): boolean {
  if (!x || !y) return x === y;
  return x.type === y.type && x.message === y.message && x.retryable === y.retryable;
}

/** usage 逐字段比；缺省（undefined）与 0 是不同语义 —— 一侧有一侧无也是差异 */
function pushUsageDiffs(
  out: DiffEntry[],
  prefix: string,
  x: Usage | undefined,
  y: Usage | undefined,
): void {
  for (const f of USAGE_FIELDS) {
    const xv = x?.[f];
    const yv = y?.[f];
    if (xv !== yv) out.push({ field: `${prefix}.${f}`, a: xv, b: yv });
  }
}

/** attributes 并集逐键比（键序排序，输出确定） */
function pushAttrDiffs(out: DiffEntry[], x: Span['attributes'], y: Span['attributes']): void {
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  for (const k of keys) {
    if (x[k] !== y[k]) out.push({ field: `attributes.${k}`, a: x[k], b: y[k] });
  }
}

/**
 * events 序列比：长度不等记一条 `events` 计数差；逐下标比 name 与 body
 * （body 用 stringifySafe 序列化后比字符串，差异值截断到 200 字符防爆）。
 * 每个 span 最多报 EVENT_DIFF_LIMIT 条，超出记一条 `events` 截断说明。
 * event.time 是墙钟字段，永不比。
 */
function pushEventDiffs(out: DiffEntry[], x: SpanEvent[], y: SpanEvent[]): void {
  let budget = EVENT_DIFF_LIMIT;
  let omitted = 0;
  const push = (entry: DiffEntry): void => {
    if (budget > 0) {
      out.push(entry);
      budget--;
    } else {
      omitted++;
    }
  };

  if (x.length !== y.length) push({ field: 'events', a: x.length, b: y.length });

  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i].name !== y[i].name) {
      push({ field: `events[${i}].name`, a: x[i].name, b: y[i].name });
    }
    const bx = stringifySafe(x[i].body);
    const by = stringifySafe(y[i].body);
    if (bx !== by) {
      push({
        field: `events[${i}].body`,
        a: truncateWithMark(bx, DIFF_VALUE_CHARS),
        b: truncateWithMark(by, DIFF_VALUE_CHARS),
      });
    }
  }

  if (omitted > 0) {
    const note = `（事件差异超过 ${EVENT_DIFF_LIMIT} 条，另有 ${omitted} 条未列出）`;
    out.push({ field: 'events', a: note, b: note });
  }
}

/* ── 命令本体：两个 JSONL 各取第一条 trace → diff → 人读输出 ──────────────────── */

/** 用法串（cli.ts 的子命令 `--help` 也从这里取，避免两处各写一份） */
export const USAGE = '用法：agentia diff <a.jsonl> <b.jsonl> [--json]';

/** 逐行 JSON.parse + extractTrace（同 harvest），取第一条可提取的 trace；坏行跳过计数 */
async function readFirstTrace(file: string): Promise<{ trace: Trace; badLines: number }> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到文件 ${file}（${(e as Error).message}）`);
  }
  let badLines = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const t = extractTrace(JSON.parse(s));
      if (t) return { trace: t as unknown as Trace, badLines };
      badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  throw new Error(
    `${file} 里没有可识别的 trace（支持裸 Trace 或含 result.trace / trace 的记录）` +
      (badLines > 0 ? `；另有 ${badLines} 行无法解析` : ''),
  );
}

/** 差异值 → 展示串：stringifySafe 序列化（短串直接放），长串截断 200 字符（同 DIFF_VALUE_CHARS） */
function fmtValue(v: unknown): string {
  return truncateWithMark(stringifySafe(v), DIFF_VALUE_CHARS);
}

function fmtEntry(e: DiffEntry): string {
  return `  ${e.field}: ${fmtValue(e.a)} → ${fmtValue(e.b)}`;
}

/** 失败一律**抛错**（同 report/harvest 的受理模式）；「有差异」不是错误，就地设 exitCode = 1 */
export async function diffCommand(args: string[]): Promise<number> {
  // `--json`：机器可读输出（stdout 只有一个 JSON 文档，无任何人类装饰）；退出码语义不变 ——
  // 有差异仍退出 1（脚本照旧可拿退出码当门禁，`--json` 只是让「差在哪」也能被读）。
  const json = args.includes('--json');
  const files: string[] = [];
  for (const a of args) {
    if (a === '--json') continue;
    if (a.startsWith('--')) throw new Error(`未知参数：${a}\n${USAGE}`);
    files.push(a);
  }
  if (files.length !== 2) throw new Error(USAGE);
  const [fileA, fileB] = files;

  const ra = await readFirstTrace(fileA);
  const rb = await readFirstTrace(fileB);
  const d = diffTraces(ra.trace, rb.trace);

  if (json) {
    const payload: DiffJson = {
      a: { file: fileA, traceId: ra.trace.traceId ?? null, skippedLines: ra.badLines },
      b: { file: fileB, traceId: rb.trace.traceId ?? null, skippedLines: rb.badLines },
      equal: d.equal,
      summary: d.summary,
      spans: d.spans.map((s) => ({
        path: s.path,
        missing: s.a === undefined ? ('a' as const) : s.b === undefined ? ('b' as const) : null,
        fields: s.fields,
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (!d.equal) process.exitCode = 1;
    return 0;
  }

  const badNote = (n: number): string => (n > 0 ? `（跳过无法解析 ${n} 行）` : '');
  const lines: string[] = [
    `trace a  ${fileA}（${ra.trace.traceId ?? '(无 traceId)'}）${badNote(ra.badLines)}`,
    `trace b  ${fileB}（${rb.trace.traceId ?? '(无 traceId)'}）${badNote(rb.badLines)}`,
  ];

  if (d.equal) {
    lines.push('两条 trace 等价（无结构与字段差异）');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  lines.push('');
  if (d.summary.length > 0) {
    lines.push('run 级差异：');
    for (const e of d.summary) lines.push(fmtEntry(e));
  }
  if (d.spans.length > 0) {
    if (d.summary.length > 0) lines.push('');
    lines.push('span 差异：');
    for (const s of d.spans) {
      const side = s.a === undefined ? ' (仅存在于 b)' : s.b === undefined ? ' (仅存在于 a)' : '';
      lines.push(`${s.path}${side}`);
      for (const e of s.fields) lines.push(fmtEntry(e));
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  // diff(1) 语义：不同即 1。此刻 cli.ts 末尾的 `process.exitCode = main(...)` 已同步执行完，
  // 这里的赋值在其后（await 之后），不会被覆盖。
  process.exitCode = 1;
  return 0;
}
