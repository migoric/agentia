/**
 * `agentia report <file.jsonl>` —— 从 trace 落盘文件生成**调优报告**（G1 的 CLI 薄壳）。
 *
 * 回答的是调优第一步的问题：「**哪个能力慢 / 贵 / 爱失败**」—— 有了它才知道该拧哪个旋钮
 * （budgetTokens / keepToolPairs / maxCostUsd / toolTimeoutMs …）。
 *
 * 输入格式（每行一个 JSON，两种都收）：
 * - 裸 Trace（含 `spans`）—— 如 `createOtlpExporter` 之外的本地落盘、或自己 writeFile 的记录；
 * - TaskRecord（含 `result.trace` 或 `trace`）—— 如 `FileTaskStore` / `SqliteTaskStore` 的导出。
 *
 * ⚠️ TaskRecord 导出是 **append-only**（FileTaskStore 每次 save 追加一行）：审批流里同一棵
 * 挂起段 trace 会被写多次（挂起 save / approve 落库 / 接管再 save，各行的 `result.trace`
 * 是同一份）⇒ 按行计会把 runs / 成功率 / 成本全部翻倍。因此解析后按 **`traceId` 去重，
 * 同一 traceId 只留最后一行**（append-only 里后面的是新状态），能力表与会话表共用这份输入。
 *
 * 聚合实现**不在这里** —— 复用 `@migor/trace-view` 的 `summarizeTrace`
 * （构建期由 scripts/copy-assets.mjs 拷进 dist/inspector/）。CLI 因此保持零 npm 运行时依赖，
 * 且与 inspector 面板/官网 playground 共用同一份聚合口径（避免两处漂移）。
 */
import { readFile } from 'node:fs/promises';

interface SummaryRow {
  capability: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  tokens: number | null;
  costUsd: number | null;
}

interface TraceLike {
  traceId?: string;
  status?: string;
  spans?: unknown[];
  /**
   * run 汇总用量（框架侧 `Trace.totalUsage`）。会话/任务维度的成本口径取它的
   * `costEstimate` —— 那是**各 `llm.turn` 之和**，且**不含** capability 聚合，所以天然不重复计数。
   */
  totalUsage?: { costEstimate?: number } | undefined;
}

/** 会话 / 任务维度的一行（G6）—— 「同一批 trace 里，哪一组跑得贵、哪一组爱失败」 */
export interface SessionRow {
  /**
   * 分组键，按优先级三选一：
   * 1. run 根 span 的 `session.id` —— 多轮会话的锚点（宿主传 `session: { store, id }` 才写）；
   * 2. 记录里 TaskRecord 的 `taskId` —— 逐任务落库、没开会话时用它；
   * 3. 都没有 ⇒ `(无会话)`。
   * ⚠️ 会话**一般**聚多条 run，而 `TaskRecord.taskId` **逐任务唯一** ⇒ 后一路通常一组一条，
   * 它是「单任务批跑里逐条标成本」，不是多轮聚合。两者不混排（一条 run 只进一个组）。
   */
  session: string;
  runs: number;
  succeeded: number;
  failed: number;
  totalMs: number;
  /** 该组各 run 的 `totalUsage.costEstimate` 之和；**全读不出时为 null**（渲染成 `-`） */
  costUsd: number | null;
  /** `costUsd / succeeded`；`succeeded === 0` 时 **null** —— 「除不了」不是 0 */
  costPerSuccess: number | null;
}

/** 机器可读输出的形状（`--json`）—— 字段增补是兼容的，改名/删字段是破坏性变更 */
export interface ReportJson {
  file: string;
  /** 去重后的 run 数（同一 traceId 多行只算最后一行，见文件头注）；`failed` 同口径 */
  runs: number;
  failed: number;
  skippedLines: number;
  failures: Array<{ traceId: string | null; message: string | null }>;
  capabilities: SummaryRow[];
  /** G6：会话 / 任务维度（按分组键归组，与能力表互补） */
  sessions: SessionRow[];
  totals: { totalMs: number; errors: number; capabilities: number };
}

/** 从一行 JSON 里把 trace 抠出来（裸 Trace 或包在记录里的 Trace）。harvest 命令也复用它。 */
export function extractTrace(v: unknown): TraceLike | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.spans)) return o as TraceLike;
  const result = o.result as Record<string, unknown> | undefined;
  const rt = result?.trace as Record<string, unknown> | undefined;
  if (rt && Array.isArray(rt.spans)) return rt as TraceLike;
  const trace = o.trace as Record<string, unknown> | undefined;
  if (trace && Array.isArray(trace.spans)) return trace as TraceLike;
  return null;
}

/** TaskRecord 的任务键（`FileTaskStore` / `SqliteTaskStore` 导出的顶层 `taskId`）。裸 Trace 没有它。 */
function taskKeyOf(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const id = (v as Record<string, unknown>).taskId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * run 根 span —— 优先 `kind === 'run'`，跑挂的 trace 没有就退到第一个 span。
 * 与 `inspector-routes.ts` 的 `summarize` 同款取法（两处都在读 run 根的 attribute，口径要一致）。
 */
function rootSpanOf(t: TraceLike): Record<string, unknown> | null {
  const spans = (t.spans ?? []) as Array<Record<string, unknown> | undefined>;
  return spans.find((s) => s?.kind === 'run') ?? spans[0] ?? null;
}

/** 「没有会话」桶的名字 —— 常量而非字面量：断言与渲染必须指同一个东西 */
export const NO_SESSION = '(无会话)';

/** 分组键：会话优先，其次任务，最后落「无会话」桶 */
function groupKeyOf(t: TraceLike, taskKey: string | null): string {
  const attrs = rootSpanOf(t)?.attributes as Record<string, unknown> | undefined;
  const sid = attrs?.['session.id'];
  if (typeof sid === 'string' && sid.length > 0) return sid;
  return taskKey ?? NO_SESSION;
}

/** 单条 run 的根 span 耗时（`endedAt - startedAt`）；读不出计 0 */
function runMs(t: TraceLike): number {
  const root = rootSpanOf(t);
  const s = Number(root?.startedAt);
  const e = Number(root?.endedAt);
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : 0;
}

/**
 * 单条 run 的成本（美元）。
 *
 * ⚠️ **刻意不从 `summarizeTrace` 的能力行反加**：能力行只覆盖进了 capability 的
 * `llm.turn`，run 根直属的回合（主 agent 自己问的）不在任何能力行里 ⇒ 反加会**漏**。
 * `Trace.totalUsage` 才是权威口径（各 `llm.turn` 之和，刻意不含 capability 聚合以免
 * 重复计数，`src/core/trace.ts`）。读不出（手工写的 trace / 未定价模型）⇒ null
 * （渲染成 `-`），**不伪装成 0**。
 */
function runCostUsd(t: TraceLike): number | null {
  const c = t.totalUsage?.costEstimate;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** 打印一张按总耗时降序的能力排行（跨多行记录时按能力合并） */
/** 用法串（cli.ts 的子命令 `--help` 也从这里取，避免两处各写一份） */
export const USAGE = '用法：agentia report <trace.jsonl> [--json]';

export async function reportCommand(args: string[]): Promise<number> {
  // `--json`：机器可读输出（stdout 只有一个 JSON 文档，无任何人类装饰）—— 便于脚本/CI 串接。
  // 出错仍走 stderr 的 `错误：…` + 退出码 1、stdout 为空，脚本据此区分「有结果」与「没跑成」。
  const json = args.includes('--json');
  const positional = args.filter((a) => a !== '--json');
  const file = positional[0];
  // 失败一律**抛错**（而不是就地设 process.exitCode）—— 本命令是异步的，
  // 就地设的 exitCode 会被 cli.ts 末尾那句 `process.exitCode = main(...)` 覆盖成 0。
  if (file === undefined || positional.length > 1 || file.startsWith('--')) {
    throw new Error(USAGE);
  }

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到文件 ${file}（${(e as Error).message}）`);
  }

  // 解析时同时留下**外层记录**的任务键（TaskRecord 的 `taskId`）—— 它与 trace 本体不同源
  // （在 wrapper 上，不在 `spans` 里），故在解析处一并取出。
  // ⚠️ 「一行 = 一条 run」对 append-only 导出不成立（同一棵 trace 可能占多行），
  // 去重在解析**之后**统一做（见下），别在循环里顺手去重 —— 坏行计数会被带歪。
  const entries: Array<{ trace: TraceLike; taskKey: string | null }> = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      const t = extractTrace(v);
      if (t) entries.push({ trace: t, taskKey: taskKeyOf(v) });
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  if (entries.length === 0) {
    throw new Error(
      `${file} 里没有可识别的 trace（支持裸 Trace 或含 result.trace / trace 的记录）` +
        (badLines > 0 ? `；另有 ${badLines} 行无法解析` : ''),
    );
  }

  // **按 traceId 去重，同一 traceId 只留最后一行**。FileTaskStore 是 append-only：审批流里
  // 同一棵挂起段 trace 会被写多次（挂起 save / approve 落库 / 接管再 save），各行的
  // `result.trace` 是同一份 —— 不去重则 runs / 成功率 / 成本按行数翻倍。
  // - 取**最后**一行：append-only 里后面的是新状态（接管后的记录才是终态）；
  // - 键是 traceId 而不是 taskId：一个任务可以跨**多段** run（挂起 → 恢复 → 再挂起），
  //   每段一棵新 trace（traceId == runId），按 taskId 去重会把不同段错并成一条；
  // - 无 traceId 的行（手写 trace）无从判同，全部保留；
  // - 过滤保序：留下的是各 traceId 在文件里**最后一次出现的位置**，输出顺序与直觉一致。
  //   能力表、runs 总计、会话表**共用**这份去重后的输入（两处各算各的必然漂移）。
  const lastByTraceId = new Map<string, number>();
  entries.forEach((e, i) => {
    const id = e.trace.traceId;
    if (typeof id === 'string' && id.length > 0) lastByTraceId.set(id, i);
  });
  const deduped = entries.filter((e, i) => {
    const id = e.trace.traceId;
    return typeof id !== 'string' || id.length === 0 || lastByTraceId.get(id) === i;
  });
  const traces = deduped.map((e) => e.trace);

  // 聚合口径与 inspector 面板 / 官网 playground 同源（构建期拷进来的 trace-view 产物）
  // 这份聚合实现由 packages/cli/scripts/copy-assets.mjs 在构建期从 trace-view 产物拷进来。
  // 缺它只可能是「装坏了」或「直接跑未构建的源码」—— 原始 ERR_MODULE_NOT_FOUND 里全是
  // dist 内部路径，用户读不出该做什么，故换成带补救动作的报错。
  let summarizeTrace: (t: unknown) => SummaryRow[];
  try {
    ({ summarizeTrace } = (await import(
      new URL('./inspector/summary.js', import.meta.url).href
    )) as { summarizeTrace: (t: unknown) => SummaryRow[] });
  } catch (e) {
    throw new Error(
      `缺少 CLI 资源（inspector/summary.js）：${(e as Error).message}；` +
        '请重装 @migor/cli 或重新构建（npm run build:cli）',
    );
  }

  const merged = new Map<string, SummaryRow>();
  let okRuns = 0;
  for (const t of traces) {
    if (t.status !== 'error') okRuns += 1;
    for (const row of summarizeTrace(t)) {
      const cur = merged.get(row.capability);
      if (!cur) merged.set(row.capability, { ...row });
      else {
        cur.calls += row.calls;
        cur.errors += row.errors;
        cur.totalMs += row.totalMs;
        cur.maxMs = Math.max(cur.maxMs, row.maxMs);
        if (row.tokens != null) cur.tokens = (cur.tokens ?? 0) + row.tokens;
        if (row.costUsd != null) cur.costUsd = (cur.costUsd ?? 0) + row.costUsd;
      }
    }
  }
  const rows = [...merged.values()].sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls);

  // G6：会话 / 任务维度 —— 与上面的能力表**互补**：能力表看单个能力，这里看一整段会话/任务
  // （多轮 run 的合计 + 成功率）。成功率**必须带分母**：只报百分比在小组上是噪声。
  const byGroup = new Map<string, SessionRow>();
  for (const e of deduped) {
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
    // 成败判据与上面的 `okRuns` **同一条**（`status !== 'error'`）—— 两处各写一份会漂移。
    if (e.trace.status !== 'error') row.succeeded += 1;
    else row.failed += 1;
    row.totalMs += runMs(e.trace);
    const c = runCostUsd(e.trace);
    if (c != null) row.costUsd = (row.costUsd ?? 0) + c;
  }
  for (const row of byGroup.values()) {
    // ⚠️ 成功数为 0 ⇒ null（渲染成 `-`）。写成 0 是把「除不了」伪装成「每个成功任务不花钱」，
    // 正好说反 —— 这正是本项要防的那笔假账。
    row.costPerSuccess =
      row.costUsd != null && row.succeeded > 0 ? row.costUsd / row.succeeded : null;
  }
  const sessions = [...byGroup.values()].sort(
    (a, b) => b.totalMs - a.totalMs || b.runs - a.runs || a.session.localeCompare(b.session),
  );

  const failRows = traces
    .filter((t) => t.status === 'error')
    .map((t) => {
      const spans = (t.spans ?? []) as Array<{ error?: { message?: string } }>;
      return {
        traceId: t.traceId ?? null,
        message: spans.find((s) => s?.error?.message)?.error?.message ?? null,
      };
    });
  const totalMs = rows.reduce((n, r) => n + r.totalMs, 0);
  const errTotal = rows.reduce((n, r) => n + r.errors, 0);

  if (json) {
    const payload: ReportJson = {
      file,
      runs: traces.length,
      failed: traces.length - okRuns,
      skippedLines: badLines,
      failures: failRows,
      capabilities: rows,
      sessions,
      totals: { totalMs, errors: errTotal, capabilities: rows.length },
    };
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  // 按**显示宽度**补齐：`(无会话)` 里的汉字占 2 列而 `String.length` 只算 1 ⇒ 用字符数补齐
  // 会把那一行整体右推 3 格。而它偏偏是「宿主没开会话」时的**唯一**一行，歪得很显眼。
  // 判据是启发式（≥ U+2E80 记 2 列）：覆盖 CJK 与全角标点；`…`（U+2026）等仍是 1 列。
  const dispWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
    return w;
  };
  const pad = (s: string, n: number): string => {
    const w = dispWidth(s);
    return w >= n ? s : s + ' '.repeat(n - w);
  };
  const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
  console.log(`trace 文件  ${file}`);
  console.log(
    `runs       ${traces.length}（失败 ${traces.length - okRuns}）${badLines > 0 ? `  ·  跳过无法解析 ${badLines} 行` : ''}`,
  );
  // 失败 run 要说清原因：只报「失败 N」而不给理由，对调优没用。而且首次运行最常见的失败
  // （没配 API key）恰恰不产出任何 capability 行 —— 会走到下面「没有可归因的能力」提前返回。
  for (const f of failRows.slice(0, 3)) {
    console.log(`  ✗ ${f.traceId ?? '(无 traceId)'}${f.message ? `  ${f.message}` : ''}`);
  }
  if (failRows.length > 3) console.log(`  …另有 ${failRows.length - 3} 条失败 run`);
  console.log('');
  // G6 区块：**无论有没有会话都打**。没配 `session: { store, id }` 时只会有一行
  // `(无会话)` —— 那是**如实呈现**（说明宿主没开会话），不是缺陷（见设计稿 §6）。
  console.log(
    `${pad('session', 34)} ${pad('runs', 6)} ${pad('ok', 5)} ${pad('fail', 6)} ${pad('total', 9)} ${pad('cost', 12)} ${pad('cost/ok', 12)}`,
  );
  for (const r of sessions) {
    console.log(
      `${pad(r.session, 34)} ${pad(String(r.runs), 6)} ${pad(String(r.succeeded), 5)} ` +
        `${pad(String(r.failed), 6)} ${pad(fmtMs(r.totalMs), 9)} ` +
        `${pad(r.costUsd != null ? r.costUsd.toFixed(6) : '-', 12)} ` +
        // `costPerSuccess` 为 null 有两种来路（没成本 / 没成功），两者都只能给 `-` ——
        // 区别在 ok 列上写着（ok = 0 时就是后者）。
        `${pad(r.costPerSuccess != null ? r.costPerSuccess.toFixed(6) : '-', 12)}`,
    );
  }
  console.log('');
  if (rows.length === 0) {
    console.log(
      '（没有可归因的能力：这些 trace 里既没有 capability span，也没有 tool.output 事件）',
    );
    return 0;
  }
  console.log(
    `${pad('capability', 34)} ${pad('calls', 6)} ${pad('err', 5)} ${pad('total', 9)} ${pad('max', 9)} ${pad('tokens', 9)} ${pad('cost', 12)}`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.capability, 34)} ${pad(String(r.calls), 6)} ${pad(String(r.errors), 5)} ` +
        `${pad(fmtMs(r.totalMs), 9)} ${pad(fmtMs(r.maxMs), 9)} ` +
        `${pad(r.tokens != null ? String(r.tokens) : '-', 9)} ` +
        `${pad(r.costUsd != null ? r.costUsd.toFixed(6) : '-', 12)}`,
    );
  }
  console.log('');
  console.log(`合计耗时 ${fmtMs(totalMs)}  ·  失败 ${errTotal} 次  ·  能力 ${rows.length} 个`);
  return 0;
}
