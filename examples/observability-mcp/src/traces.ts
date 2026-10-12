/**
 * 只读 trace 视图：把**落盘的** trace 文件变成两个 agent 消费得动的结果（报告 / 差异）。
 *
 * 建在框架**公共面**上（`buildRunReport` / `mergeRunReports` / `diffTraces`）—— 不改核心、
 * 不引第三方依赖。本文件手写的只有两段，两段都**有单一来源、但那个来源不是公共面**：
 *
 * - **行格式** = `jsonlTraceSink` 写出的形状（裸 Trace / `{trace}` / `{result:{trace}}`）。
 *   `agentia report` 收的是同一批（`packages/cli/src/report.ts` 的 `extractTrace`）。
 * - **会话归组口径** = CLI `report.ts` 的 `SessionRow` + **三级回退分组键**
 *   （run 根 `session.id` → 外层记录的 `TaskRecord.taskId` → `(无会话)`）。
 *   ⚠️ taskId 那层在**外层 wrapper** 上（FileTaskStore / SqliteTaskStore 导出的记录顶层），
 *   不在 `spans` 里 —— 解析时丢掉 wrapper，这层键就再也够不到（全部坍进 `(无会话)`）。
 *   跟着它走的三条：成功 = `status !== 'error'`；
 *   成本取 `totalUsage.costEstimate`（**不是** capability 行 `costUsd` 相加 —— capability span
 *   的 usage 是其子孙 `llm.turn` 的聚合，嵌套能力上相加会重复计数）；`succeeded === 0` 时
 *   每成功成本给 `null` 而不是 0（「除不了」不伪装成 0）。
 *
 * ⚠️ 这两处口径若变，**两处一起改**。CLI 那份不对外导出，运行时逐字对拍够不到它
 * （示例必须可整目录拷走单用、且示例 dist 在 `npm test` 时未构建 —— 两个对拍落点都不成立），
 * 所以守护是**源码级双钉**：`tests/observability-mcp-parity.test.ts` 断言三级回退的
 * canonical 行段在两份源码里逐字都在场；行为面两边各有断言（CLI 侧 `report.test.mjs`、
 * 本示例 `verify.ts` 的 §8）。
 */
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { buildRunReport, diffTraces, mergeRunReports } from '@migor/agentia';
import type { DiffEntry, RunReport, Trace, TraceDiff } from '@migor/agentia';

/** 一条解析出来的 run：trace 本体 + 外层记录的任务键（TaskRecord 的 `taskId`，裸 Trace 没有） */
export interface TraceEntry {
  trace: Trace;
  taskKey: string | null;
}

/** 一个 trace 文件的解析结果；`skippedLines` = 认不出的行数（如实回报，不当 0） */
export interface TraceFile {
  file: string;
  entries: TraceEntry[];
  skippedLines: number;
}

/** 从一行 JSON 里把 trace 抠出来（裸 Trace 或包在记录里的 Trace）。口径同 CLI 的 `extractTrace`。 */
export function extractTrace(v: unknown): Trace | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.spans)) return o as unknown as Trace;
  const result = o.result as Record<string, unknown> | undefined;
  const nested = result?.trace as Record<string, unknown> | undefined;
  if (nested && Array.isArray(nested.spans)) return nested as unknown as Trace;
  const direct = o.trace as Record<string, unknown> | undefined;
  if (direct && Array.isArray(direct.spans)) return direct as unknown as Trace;
  return null;
}

/** TaskRecord 的任务键（`FileTaskStore` / `SqliteTaskStore` 导出的顶层 `taskId`）。裸 Trace 没有它。 */
function taskKeyOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const id = (v as Record<string, unknown>).taskId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** 读一个 JSONL 文件里的全部 run。一条都认不出时抛错（**不返回空表** —— 空表会被下游读成「零开销」）。 */
export async function readTraceFile(file: string): Promise<TraceFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到 trace 文件 ${file}（${(e as Error).message}）`);
  }
  // 一条记录 = 一条 run，但要同时留下**外层记录**的任务键 —— 它与 trace 本体不同源
  // （在 wrapper 上，不在 `spans` 里），故在解析处一并取出（口径同 CLI `report.ts`）。
  const entries: TraceEntry[] = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      const t = extractTrace(v);
      if (t) entries.push({ trace: t, taskKey: taskKeyOf(v) });
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  if (entries.length === 0) {
    throw new Error(
      `${file} 里没有可识别的 trace（支持裸 Trace 或含 result.trace / trace 的记录）` +
        (skippedLines > 0 ? `；另有 ${skippedLines} 行无法解析` : ''),
    );
  }
  return { file, entries, skippedLines };
}

/** run 根 span —— 优先 `kind === 'run'`，跑挂的 trace 没有就退到第一个 span（口径同 CLI） */
function rootSpanOf(t: Trace): Record<string, unknown> | null {
  const spans = t.spans as unknown as Array<Record<string, unknown> | undefined>;
  return spans.find((s) => s?.kind === 'run') ?? spans[0] ?? null;
}

/** 「没有会话」桶的名字 —— 常量而非字面量：断言与渲染必须指同一个东西 */
export const NO_SESSION = '(无会话)';

/** 单条 run 的耗时（根 span 的 `endedAt - startedAt`）；读不出记 0 */
function runMs(t: Trace): number {
  const root = rootSpanOf(t);
  const s = Number(root?.startedAt);
  const e = Number(root?.endedAt);
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : 0;
}

/** 单条 run 的成本：`totalUsage.costEstimate`；读不出给 `null`（不是 0） */
function runCostUsd(t: Trace): number | null {
  const c = t.totalUsage?.costEstimate;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** 分组键（口径同 CLI `report.ts`）：会话优先，其次任务，最后落「无会话」桶 */
function groupKeyOf(t: Trace, taskKey: string | null): string {
  const attrs = rootSpanOf(t)?.attributes as Record<string, unknown> | undefined;
  const sid = attrs?.['session.id'];
  if (typeof sid === 'string' && sid.length > 0) return sid;
  return taskKey ?? NO_SESSION;
}

/** 会话维度的一行（口径同 CLI `packages/cli/src/report.ts` 的 `SessionRow`，见文件头） */
export interface SessionRow {
  session: string;
  runs: number;
  succeeded: number;
  failed: number;
  totalMs: number;
  costUsd: number | null;
  costPerSuccess: number | null;
}

/** 按分组键归组（`groupKeyOf` 的三级回退：会话 → 任务 → `(无会话)` 桶） */
export function sessionRows(entries: readonly TraceEntry[]): SessionRow[] {
  const byGroup = new Map<string, SessionRow>();
  for (const e of entries) {
    const key = groupKeyOf(e.trace, e.taskKey);
    let row = byGroup.get(key);
    if (!row) {
      row = {
        session: key,
        runs: 0,
        succeeded: 0,
        failed: 0,
        totalMs: 0,
        costUsd: null,
        costPerSuccess: null,
      };
      byGroup.set(key, row);
    }
    row.runs += 1;
    if (e.trace.status !== 'error') row.succeeded += 1;
    else row.failed += 1;
    row.totalMs += runMs(e.trace);
    const c = runCostUsd(e.trace);
    if (c !== null) row.costUsd = (row.costUsd ?? 0) + c;
  }
  for (const row of byGroup.values()) {
    row.costPerSuccess =
      row.costUsd !== null && row.succeeded > 0 ? row.costUsd / row.succeeded : null;
  }
  // 与 CLI 同序：先总耗时、再 run 数、最后按名字（保证输出可复现，便于断言）
  return [...byGroup.values()].sort(
    (a, b) => b.totalMs - a.totalMs || b.runs - a.runs || a.session.localeCompare(b.session),
  );
}

/** 单次返回的会话组数上限 —— 与 diff 侧同档（`MAX_DIFF_SPANS`）：进模型上下文的东西必须有天花板 */
export const MAX_SESSION_ROWS = 40;

/** `report_trace` 的结果：能力表（框架算的）+ 会话表（本文件算的）+ 如实回报的坏行数 */
export interface TraceReport {
  file: string;
  runs: number;
  succeeded: number;
  failed: number;
  skippedLines: number;
  report: RunReport;
  /** 会话组表（按总耗时降序，最多 `MAX_SESSION_ROWS` 行） */
  sessions: SessionRow[];
  /** 会话组总数（截断前的真实组数） */
  sessionGroups: number;
  /** 被截掉的组数（`sessionGroups - sessions.length`）；0 = 没截 */
  sessionsTruncated: number;
}

/** 一个文件里的全部 run 合成一份报告（跨 run 合并由框架的 `mergeRunReports` 负责） */
export async function reportOf(file: string): Promise<TraceReport> {
  const { entries, skippedLines } = await readTraceFile(file);
  const failed = entries.filter((e) => e.trace.status === 'error').length;
  const groups = sessionRows(entries);
  // 与 diff 侧同款截断：长寿文件几千个会话组会把几千行灌进模型上下文；截掉多少如实报出
  const kept = groups.slice(0, MAX_SESSION_ROWS);
  return {
    file,
    runs: entries.length,
    succeeded: entries.length - failed,
    failed,
    skippedLines,
    report: mergeRunReports(entries.map((e) => buildRunReport(e.trace))),
    sessions: kept,
    sessionGroups: groups.length,
    sessionsTruncated: groups.length - kept.length,
  };
}

/**
 * 差异结果 —— **刻意不是** `diffTraces` 的原样输出。
 *
 * `SpanDiff.a` / `.b` 是**完整 span**（含 events，event body 可达数百字）。原样返回等于把
 * 两条 trace 灌进模型上下文：一次 diff 就能顶掉整轮预算，而 agent 想知道的是「哪一步变了」，
 * 不是「那一步的每个字节」。所以：缺侧只留标记、`spans` 截断、保留条数如实报出。
 */
export interface CompactDiff {
  before: string;
  after: string;
  equal: boolean;
  /** run 级差异（status / usage / 根 span attributes —— 换模型第一眼就看 attributes.model） */
  summary: DiffEntry[];
  spans: Array<{ path: string; missing: 'before' | 'after' | null; fields: DiffEntry[] }>;
  /** 差异 span 总数（截断前的真实条数） */
  spanDiffs: number;
  /** 被截掉的条数（`spanDiffs - spans.length`） */
  truncated: number;
}

/** 单次返回的差异 span 上限 —— MCP 结果整段进模型上下文，必须有个天花板 */
export const MAX_DIFF_SPANS = 40;

/** 从文件里挑第 N 条 run（从 1 数）；缺省 = **最后一条**（最近一次跑的那条） */
export function pickRun(file: TraceFile, index?: number): Trace {
  const t = index === undefined ? file.entries[file.entries.length - 1] : file.entries[index - 1];
  if (!t) {
    throw new Error(
      `${file.file} 里没有第 ${String(index)} 条 run（该文件共 ${file.entries.length} 条）`,
    );
  }
  return t.trace;
}

/** 两个 run 的结构化差异（截断与塑形见 `CompactDiff`） */
export async function diffOf(
  before: string,
  after: string,
  sel: { beforeRun?: number; afterRun?: number } = {},
): Promise<CompactDiff> {
  const [fa, fb] = await Promise.all([readTraceFile(before), readTraceFile(after)]);
  const d: TraceDiff = diffTraces(
    pickRun(fa, sel.beforeRun),
    pickRun(fb, sel.afterRun),
    // ignoreTiming 缺省 true（A/B 不关心墙钟）；两条 trace 的绝对时间戳永不比
  );
  const kept = d.spans.slice(0, MAX_DIFF_SPANS);
  return {
    before,
    after,
    equal: d.equal,
    summary: d.summary,
    spans: kept.map((s) => ({
      path: s.path,
      missing: s.a === undefined ? 'before' : s.b === undefined ? 'after' : null,
      fields: s.fields,
    })),
    spanDiffs: d.spans.length,
    truncated: d.spans.length - kept.length,
  };
}

/**
 * 把模型给的路径**约束在 trace 根目录内**，返回绝对路径。
 *
 * ⚠️ 这不是装饰。MCP 工具的参数由模型给、返回内容直接进模型上下文 ⇒ 不设边界等于对外发了
 * 一个「任意文件读取」原语（`/etc/passwd`、`~/.ssh/id_*`），而且读到的内容还能反过来当注入。
 * 判据用 **realpath 后比前缀**（符号链接一并拦住），不是字符串 `startsWith` —— 后者能被
 * `root/../../etc/passwd` 与「同前缀的兄弟目录」（`/data` vs `/data-evil`）两种方式绕过。
 */
export async function resolveInsideRoot(p: string): Promise<string> {
  const root = await realpath(resolve(process.env.AGENTIA_TRACE_ROOT ?? process.cwd()));
  let abs: string;
  try {
    abs = await realpath(isAbsolute(p) ? p : resolve(root, p));
  } catch {
    throw new Error(`读不到文件 ${p}（路径不存在或不可读；trace 根 = ${root}）`);
  }
  // ⚠️ root 本身以分隔符结尾（POSIX 的 `/`、Windows 的 `C:\`）时**不能再拼一个** ——
  // `root + sep` 会变成 `//`，于是根下所有路径都被误拒（方向过紧、不泄密，但行为错）。
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new Error(
      `拒绝读取 trace 根之外的路径：${p}；根 = ${root}（要放宽请设 AGENTIA_TRACE_ROOT）`,
    );
  }
  return abs;
}
