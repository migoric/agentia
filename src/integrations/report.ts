import { capabilityKindOf } from '../core/trace.js';
import type { Span, Trace, Usage } from '../core/trace.js';
import { TOOL_OUTPUT_EVENT, USAGE_MISSING_EVENT } from '../core/trace.js';
import { percentile } from '../core/stats.js';

/**
 * Agentia —— 调优报告（G1）。
 *
 * 把一条（或多条）`Trace` 变成「**哪个能力慢 / 贵 / 爱失败**」的排行 —— 这是"可调优"
 * 的依据：没有它，用户面对一堆旋钮（budgetTokens / keepToolPairs / maxCostUsd …）
 * 不知道该拧哪一个。
 *
 * 数据全部从既有 trace 派生，**纯函数、无副作用、不联网**：
 * - 能力级：`tool` 读 turn 上的 `tool.output` 事件（E1 补的 `durationMs`/`ok`），
 *   `skill`/`subagent` 读 `capability` span（tracer 已聚合其子孙 usage）。
 *   ⚠️ **usage 只认顶层 capability**（没有 capability 祖先的）：capability.usage 是其
 *   子孙 llm.turn 的聚合，嵌套时（@SubAgent 套 @Skill）外层与内层带着同一批 token
 *   ⇒ 逐行累加会重复计数。嵌套行仍计 calls/errors/耗时（它自己这次调用的真账），
 *   tokens/costUsd 留给顶层行 ⇒ 各行可加总。与 `core/trace.ts`「capability 聚合不进
 *   totalUsage」、trace-view `summarizeTrace` 同一条纪律（三处口径一致）。
 * - 模型级：读 `llm.turn` span（`name` 即模型 id）。
 *
 * ⚠️ **单条 run 的分位没有统计意义**（样本常 < 5）：报告以 `total` / `max` 为主，
 * `p50`/`p95` 仅作参考；要看分位请用 `mergeRunReports` 汇总多条。
 *
 * 只依赖 core（分层：integrations 只依赖 core）。
 */

export interface DurationReport {
  /** 样本总时长（毫秒） */
  total: number;
  /** 单次最长的那个（毫秒）—— 单 run 场景比 p95 更有诊断价值 */
  max: number;
  /** 窗口内精确分位（样本少时仅供参考） */
  p50: number;
  p95: number;
}

export interface CapabilityReport {
  /** `${kind}:${name}`，如 `tool:search` / `subagent:researcher` */
  capability: string;
  calls: number;
  errors: number;
  durationMs: DurationReport;
  /** 仅 skill/subagent：其子孙 llm.turn 的 token 合计；工具为 null */
  tokens: Usage | null;
  /** token 四类之和（便于排序/展示）；无 token 时为 null */
  tokensTotal: number | null;
  /** 仅 skill/subagent：估算成本（美元）；未定价或工具为 null */
  costUsd: number | null;
  /**
   * 原始耗时样本（毫秒）—— `mergeRunReports` 靠它重算跨 run 分位。
   * 报告是排障产物，保留样本比"丢掉再近似"更有用。
   */
  durations: number[];
}

export interface ModelReport {
  model: string;
  turns: number;
  tokens: Usage;
  tokensTotal: number;
  /** 已定价部分的成本；全未定价时为 null */
  costUsd: number | null;
  /** 算不出成本的 turn 数（模型不在价格表内） */
  unpricedTurns: number;
  /**
   * 上游**没回报 usage** 的 turn 数（2026-09-28 外部深评 S2）。
   * 与 `unpricedTurns` 分开记：两者都让成本像 0，但一个要换模型、一个要查端点/网关。
   */
  usageMissingTurns: number;
  durationMs: DurationReport;
  durations: number[];
}

export interface RunReport {
  /** 单条 run = traceId；合并报告为 `merged(n runs)` */
  traceId: string;
  status: 'ok' | 'error';
  /** 合并报告 = 各 run 时长之和 */
  durationMs: number;
  totalUsage: Usage;
  models: ModelReport[];
  /** 按 `durationMs.total` 降序（并列时按 calls 降序） */
  capabilities: CapabilityReport[];
  /** 价格表外、成本算不出来的模型（成本护栏失效的显式信号） */
  unpricedModels: string[];
  /** 上游没回报 usage 的模型（成本**看似**为 0 的另一来源 —— 与上面那条分开） */
  usageMissingModels: string[];
  /** 参与合并的 run 数（单条报告为 1） */
  runs: number;
}

/** 空 usage 副本（避免多处各写一遍字面量） */
function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function usageTotal(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

function durationReport(samples: readonly number[]): DurationReport {
  if (samples.length === 0) return { total: 0, max: 0, p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    total: samples.reduce((a, b) => a + b, 0),
    max: sorted[sorted.length - 1]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function addUsage(into: Usage, add: Usage): void {
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
  if (add.costEstimate != null) into.costEstimate = (into.costEstimate ?? 0) + add.costEstimate;
}

interface CapabilityAcc {
  calls: number;
  errors: number;
  durations: number[];
  tokens: Usage | null;
  costUsd: number | null;
}

/** 从一条 Trace 生成报告（纯函数） */
export function buildRunReport(trace: Trace): RunReport {
  const capabilities = new Map<string, CapabilityAcc>();
  const acc = (capability: string): CapabilityAcc => {
    let a = capabilities.get(capability);
    if (!a) {
      a = { calls: 0, errors: 0, durations: [], tokens: null, costUsd: null };
      capabilities.set(capability, a);
    }
    return a;
  };

  const models = new Map<string, ModelReport>();
  const unpriced = new Set<string>();
  const usageMissing = new Set<string>();

  // 嵌套判定（沿 parentSpanId 上爬；seen 防手写 trace 的环）——与 trace-view 的
  // summarizeTrace 同款：usage 只计顶层 capability，嵌套行的 token 是它外层祖先行那笔。
  const byId = new Map<string, Span>();
  for (const s of trace.spans) byId.set(s.spanId, s);
  const hasCapabilityAncestor = (span: Span): boolean => {
    let p = span.parentSpanId;
    const seen = new Set<string>();
    while (p != null && !seen.has(p)) {
      seen.add(p);
      const ps = byId.get(p);
      if (!ps) return false;
      if (ps.kind === 'capability') return true;
      p = ps.parentSpanId;
    }
    return false;
  };

  for (const span of trace.spans) {
    if (span.kind === 'capability') {
      const a = acc(`${capabilityKindOf(span)}:${span.name}`);
      a.calls++;
      if (span.status === 'error') a.errors++;
      if (span.endedAt !== undefined) a.durations.push(Math.max(0, span.endedAt - span.startedAt));
      if (span.usage && !hasCapabilityAncestor(span)) {
        a.tokens = a.tokens ? { ...a.tokens } : emptyUsage();
        addUsage(a.tokens, span.usage);
        if (span.usage.costEstimate != null) a.costUsd = (a.costUsd ?? 0) + span.usage.costEstimate;
      }
      continue;
    }
    if (span.kind !== 'llm.turn') continue;

    const model = span.name;
    let m = models.get(model);
    if (!m) {
      m = {
        model,
        turns: 0,
        tokens: emptyUsage(),
        tokensTotal: 0,
        costUsd: null,
        unpricedTurns: 0,
        usageMissingTurns: 0,
        durationMs: { total: 0, max: 0, p50: 0, p95: 0 },
        durations: [],
      };
      models.set(model, m);
    }
    m.turns++;
    // 上游没报 usage 的回合（S2）：成本会是 0，但那**不是**「便宜」——
    // 与 unpriced 分开数（那个是「模型不在价格表里」）
    for (const e of span.events) {
      if (e.name !== USAGE_MISSING_EVENT) continue;
      m.usageMissingTurns++;
      usageMissing.add(model);
    }
    if (span.usage) {
      addUsage(m.tokens, span.usage);
      if (span.usage.costEstimate != null) m.costUsd = (m.costUsd ?? 0) + span.usage.costEstimate;
      else {
        m.unpricedTurns++;
        unpriced.add(model);
      }
    }
    if (span.endedAt !== undefined) m.durations.push(Math.max(0, span.endedAt - span.startedAt));

    // 普通工具的耗时/成败在 turn 的 tool.output 事件上（E1）
    for (const e of span.events) {
      if (e.name !== TOOL_OUTPUT_EVENT) continue;
      const body = e.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || typeof body.tool !== 'string') continue;
      const a = acc(`tool:${body.tool}`);
      a.calls++;
      if (body.ok === false) a.errors++;
      const d = body.durationMs;
      a.durations.push(typeof d === 'number' && Number.isFinite(d) ? Math.max(0, d) : 0);
    }
  }

  const capabilityReports: CapabilityReport[] = [...capabilities.entries()].map(
    ([capability, a]) => ({
      capability,
      calls: a.calls,
      errors: a.errors,
      durationMs: durationReport(a.durations),
      tokens: a.tokens,
      tokensTotal: a.tokens ? usageTotal(a.tokens) : null,
      costUsd: a.costUsd,
      durations: [...a.durations],
    }),
  );
  // 按总耗时降序 —— 排在最前的是「最该看的那个」
  capabilityReports.sort((x, y) => y.durationMs.total - x.durationMs.total || y.calls - x.calls);

  const modelReports: ModelReport[] = [...models.values()].map((m) => ({
    ...m,
    tokensTotal: usageTotal(m.tokens),
    durationMs: durationReport(m.durations),
  }));

  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);

  return {
    traceId: trace.traceId,
    status: trace.status,
    durationMs: root && root.endedAt !== undefined ? Math.max(0, root.endedAt - root.startedAt) : 0,
    totalUsage: { ...trace.totalUsage },
    models: modelReports,
    capabilities: capabilityReports,
    unpricedModels: [...unpriced].sort(),
    usageMissingModels: [...usageMissing].sort(),
    runs: 1,
  };
}

/**
 * 汇总多条报告（跨 run 的能力排行才有统计意义）。空数组 → 空报告。
 *
 * **按 `traceId` 去重、同一 traceId 只留最后一份**（与 CLI `agentia report` 同口径，
 * 依据见 docs/spec.md §10 2026-10-12 ⑧）：append-only 的 trace 落盘（FileTaskStore 每次
 * save 追加一行）会把同一棵挂起段 trace 写多次，不去重则 runs / 成本按行数翻倍。
 * `merged(n runs)` 是合并报告的合成 id（不是身份），不参与去重。
 */
export function mergeRunReports(reports: readonly RunReport[]): RunReport {
  // 各 traceId 在输入里最后一次出现的位置；过滤保序（输出顺序与直觉一致）
  const lastByTraceId = new Map<string, number>();
  reports.forEach((r, i) => {
    if (!r.traceId.startsWith('merged(')) lastByTraceId.set(r.traceId, i);
  });
  const deduped = reports.filter(
    (r, i) => r.traceId.startsWith('merged(') || lastByTraceId.get(r.traceId) === i,
  );
  const total: RunReport = {
    traceId: `merged(${deduped.length} runs)`,
    status: deduped.some((r) => r.status === 'error') ? 'error' : 'ok',
    durationMs: 0,
    totalUsage: emptyUsage(),
    models: [],
    capabilities: [],
    unpricedModels: [],
    usageMissingModels: [],
    runs: deduped.length,
  };
  const capabilities = new Map<string, CapabilityAcc>();
  const models = new Map<string, ModelReport>();
  const unpriced = new Set<string>();
  const usageMissing = new Set<string>();

  for (const r of deduped) {
    total.durationMs += r.durationMs;
    addUsage(total.totalUsage, r.totalUsage);
    for (const m of r.models) {
      let acc = models.get(m.model);
      if (!acc) {
        acc = {
          model: m.model,
          turns: 0,
          tokens: emptyUsage(),
          tokensTotal: 0,
          costUsd: null,
          unpricedTurns: 0,
          usageMissingTurns: 0,
          durationMs: { total: 0, max: 0, p50: 0, p95: 0 },
          durations: [],
        };
        models.set(m.model, acc);
      }
      acc.turns += m.turns;
      addUsage(acc.tokens, m.tokens);
      if (m.costUsd != null) acc.costUsd = (acc.costUsd ?? 0) + m.costUsd;
      acc.unpricedTurns += m.unpricedTurns;
      acc.usageMissingTurns += m.usageMissingTurns;
      acc.durations.push(...m.durations);
    }
    for (const u of r.capabilities) {
      let acc = capabilities.get(u.capability);
      if (!acc) {
        acc = { calls: 0, errors: 0, durations: [], tokens: null, costUsd: null };
        capabilities.set(u.capability, acc);
      }
      acc.calls += u.calls;
      acc.errors += u.errors;
      acc.durations.push(...u.durations);
      if (u.tokens) {
        acc.tokens = acc.tokens ?? emptyUsage();
        addUsage(acc.tokens, u.tokens);
      }
      if (u.costUsd != null) acc.costUsd = (acc.costUsd ?? 0) + u.costUsd;
    }
    for (const m of r.unpricedModels) unpriced.add(m);
    for (const m of r.usageMissingModels) usageMissing.add(m);
  }

  total.capabilities = [...capabilities.entries()].map(([capability, a]) => ({
    capability,
    calls: a.calls,
    errors: a.errors,
    durationMs: durationReport(a.durations),
    tokens: a.tokens,
    tokensTotal: a.tokens ? usageTotal(a.tokens) : null,
    costUsd: a.costUsd,
    durations: [...a.durations],
  }));
  total.capabilities.sort((x, y) => y.durationMs.total - x.durationMs.total || y.calls - x.calls);
  total.models = [...models.values()].map((m) => ({
    ...m,
    tokensTotal: usageTotal(m.tokens),
    durationMs: durationReport(m.durations),
  }));
  total.unpricedModels = [...unpriced].sort();
  total.usageMissingModels = [...usageMissing].sort();
  return total;
}

/** 人类可读的纯文本报告（CLI `agentia report` 与日志用；零依赖手写） */
export function renderRunReport(report: RunReport): string {
  const lines: string[] = [];
  const u = report.totalUsage;
  lines.push(`run      ${report.traceId}  [${report.status}]`);
  lines.push(
    `total    ${report.durationMs}ms  ·  tokens ${usageTotal(u)} (in ${u.inputTokens} / out ${u.outputTokens} / cacheR ${u.cacheReadTokens} / cacheW ${u.cacheCreationTokens})` +
      (u.costEstimate != null ? `  ·  ~$${u.costEstimate}` : '  ·  成本：未定价'),
  );
  if (report.unpricedModels.length > 0) {
    lines.push(
      `⚠️  未定价模型：${report.unpricedModels.join(', ')} —— 这些模型的成本按 0 计，maxCostUsd 对它们不生效`,
    );
  }

  const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  if (report.models.length > 0) {
    lines.push('');
    lines.push(
      `${pad('model', 24)} ${pad('turns', 6)} ${pad('tokens', 10)} ${pad('cost', 10)} ${pad('avg ms', 8)}`,
    );
    for (const m of report.models) {
      const avg = m.turns > 0 ? Math.round(m.durationMs.total / m.turns) : 0;
      lines.push(
        `${pad(m.model, 24)} ${pad(String(m.turns), 6)} ${pad(String(m.tokensTotal), 10)} ` +
          `${pad(m.costUsd != null ? m.costUsd.toFixed(6) : '未定价', 10)} ${pad(String(avg), 8)}`,
      );
    }
  }

  if (report.capabilities.length > 0) {
    lines.push('');
    lines.push(
      `${pad('capability', 32)} ${pad('calls', 6)} ${pad('err', 5)} ${pad('total ms', 9)} ${pad('max ms', 8)} ${pad('tokens', 8)} ${pad('cost', 10)}`,
    );
    for (const x of report.capabilities) {
      lines.push(
        `${pad(x.capability, 32)} ${pad(String(x.calls), 6)} ${pad(String(x.errors), 5)} ` +
          `${pad(String(x.durationMs.total), 9)} ${pad(String(x.durationMs.max), 8)} ` +
          `${pad(x.tokensTotal != null ? String(x.tokensTotal) : '-', 8)} ` +
          `${pad(x.costUsd != null ? x.costUsd.toFixed(6) : '-', 10)}`,
      );
    }
  }
  if (report.capabilities.length === 0 && report.models.length === 0) {
    lines.push('');
    lines.push(
      '（没有可归因的能力/模型：trace 里没有 capability span、llm.turn span 或 tool.output 事件）',
    );
  }
  return lines.join('\n') + '\n';
}
