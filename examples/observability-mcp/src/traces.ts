/**
 * 只读 trace 视图：把**落盘的** trace 文件变成两个 agent 消费得动的结果（报告 / 差异）。
 *
 * 建在框架**公共面**上（`buildRunReport` / `mergeRunReports` / `diffTraces`）—— 不改核心、
 * 不引第三方依赖。本文件手写的只有两段，两段都**有单一来源、但那个来源不是公共面**：
 *
 * - **行格式** = `jsonlTraceSink` 写出的形状（裸 Trace / `{trace}` / `{result:{trace}}`）。
 *   `agentia report` 收的是同一批（`packages/cli/src/report.ts` 的 `extractTrace`）。
 * - **会话归组口径** = 同一文件的 `SessionRow`。跟着它走的三条：成功 = `status !== 'error'`；
 *   成本取 `totalUsage.costEstimate`（**不是** capability 行 `costUsd` 相加 —— capability span
 *   的 usage 是其子孙 `llm.turn` 的聚合，嵌套能力上相加会重复计数）；`succeeded === 0` 时
 *   每成功成本给 `null` 而不是 0（「除不了」不伪装成 0）。
 *
 * ⚠️ 这两处口径若变，**两处一起改** —— CLI 那份不对外导出，没有守卫替你盯。
 */
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { buildRunReport, diffTraces, mergeRunReports } from '@migor/agentia';
import type { DiffEntry, RunReport, Trace, TraceDiff } from '@migor/agentia';

/** 一个 trace 文件的解析结果；`skippedLines` = 认不出的行数（如实回报，不当 0） */
export interface TraceFile {
  file: string;
  traces: Trace[];
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

/** 读一个 JSONL 文件里的全部 run。一条都认不出时抛错（**不返回空表** —— 空表会被下游读成「零开销」）。 */
export async function readTraceFile(file: string): Promise<TraceFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到 trace 文件 ${file}（${(e as Error).message}）`);
  }
  const traces: Trace[] = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const t = extractTrace(JSON.parse(s));
      if (t) traces.push(t);
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  if (traces.length === 0) {
    throw new Error(
      `${file} 里没有可识别的 trace（支持裸 Trace 或含 result.trace / trace 的记录）` +
        (skippedLines > 0 ? `；另有 ${skippedLines} 行无法解析` : ''),
    );
  }
  return { file, traces, skippedLines };
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

/** 按 run 根 span 的 `session.id` 归组；`session.id` 缺席归入 `(无会话)` 桶 */
export function sessionRows(traces: readonly Trace[]): SessionRow[] {
  const byGroup = new Map<string, SessionRow>();
  for (const t of traces) {
    const attrs = rootSpanOf(t)?.attributes as Record<string, unknown> | undefined;
    const sid = attrs?.['session.id'];
    const key = typeof sid === 'string' && sid.length > 0 ? sid : NO_SESSION;
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
    if (t.status !== 'error') row.succeeded += 1;
    else row.failed += 1;
    row.totalMs += runMs(t);
    const c = runCostUsd(t);
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

/** `report_trace` 的结果：能力表（框架算的）+ 会话表（本文件算的）+ 如实回报的坏行数 */
export interface TraceReport {
  file: string;
  runs: number;
  succeeded: number;
  failed: number;
  skippedLines: number;
  report: RunReport;
  sessions: SessionRow[];
}

/** 一个文件里的全部 run 合成一份报告（跨 run 合并由框架的 `mergeRunReports` 负责） */
export async function reportOf(file: string): Promise<TraceReport> {
  const { traces, skippedLines } = await readTraceFile(file);
  const failed = traces.filter((t) => t.status === 'error').length;
  return {
    file,
    runs: traces.length,
    succeeded: traces.length - failed,
    failed,
    skippedLines,
    report: mergeRunReports(traces.map((t) => buildRunReport(t))),
    sessions: sessionRows(traces),
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
  const t = index === undefined ? file.traces[file.traces.length - 1] : file.traces[index - 1];
  if (!t) {
    throw new Error(
      `${file.file} 里没有第 ${String(index)} 条 run（该文件共 ${file.traces.length} 条）`,
    );
  }
  return t;
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
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(
      `拒绝读取 trace 根之外的路径：${p}；根 = ${root}（要放宽请设 AGENTIA_TRACE_ROOT）`,
    );
  }
  return abs;
}
