import type { DurationStat, MetricsState } from './metrics-state.js';
import { scoreLabels } from './metrics-state.js';
import { wireTraceId } from '../core/trace.js';

/**
 * metricsSink 的 **Prometheus 文本渲染**（`text/plain; version=0.0.4`，零依赖手写）
 * 与 **OpenMetrics 渲染**（exemplars 的唯一文本出口）。只读 `MetricsState`，不改账。
 * module 级 export，不进公共面（`src/index.ts`）。
 */

/**
 * 一个指标家族的完整块：HELP/TYPE 各**恰好一行**，后接全部样本行。
 * expfmt 对同名指标的第二条 HELP/TYPE 是**硬错误**（整次 scrape 失败），
 * 所以家族头必须集中在这里发一次，绝不能让每条样本自带；同名指标也只能有一种 TYPE
 * （histogram 与分位 gauge 因此拆成 `*_duration_ms` 与 `*_duration_ms_last` 两个名字）。
 */
const family = (
  name: string,
  type: 'counter' | 'gauge' | 'histogram',
  help: string,
  samples: string[],
): string => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${samples.join('\n')}\n`;

/** Prometheus label 值转义：\、"、换行必须转义，否则一个含引号的能力名/模型名就损坏整页 exposition */
const escLabel = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** 一个 stat 的 histogram 样本（bucket 累积 + sum + count），labels 形如 `{k="v"}` */
const histogramSamples = (name: string, stat: DurationStat, labels = ''): string[] => {
  const inner = labels ? labels.slice(1, -1) + ',' : ''; // 去掉外层 {} 再补逗号
  const at = (extra: string): string => `{${inner}${extra}}`;
  const out: string[] = [];
  const cum = stat.cumulative();
  for (let i = 0; i < stat.boundsList.length; i++) {
    out.push(`${name}_bucket${at(`le="${stat.boundsList[i]}"`)} ${cum[i]}`);
  }
  out.push(`${name}_bucket${at(`le="+Inf"`)} ${stat.count}`);
  out.push(`${name}_sum${labels} ${stat.sumMs}`);
  out.push(`${name}_count${labels} ${stat.count}`);
  return out;
};

/**
 * 归因标签对的 label 文本（`{tenant="acme",plan="pro"}`）。键已过 Prometheus 标签名
 * 校验（metrics.ts 构造期），只需转义**值**。不从 combo 键反解 —— 值里含 `,`/`=` 时反解会碎。
 */
const labelPairsText = (pairs: readonly (readonly [string, string])[]): string =>
  `{${pairs.map(([k, v]) => `${k}="${escLabel(v)}"`).join(',')}}`;

/** 归因标签维度的样本（按 combo 键排序，确定性输出）；未配置 labelKeys 时为空表 */
const labeledSamples = (
  state: MetricsState,
  pick: (acc: { runs: number; failed: number; tokens: number; costUsd: number }) => number,
): { text: string; value: number }[] => {
  const out: { text: string; value: number }[] = [];
  for (const combo of [...state.runLabels.keys()].sort()) {
    const acc = state.runLabels.get(combo)!;
    out.push({ text: labelPairsText(acc.pairs), value: pick(acc) });
  }
  return out;
};

/**
 * 四个 **run 级家族**（`runs_total` / `runs_failed_total` / `tokens_total` / `cost_usd_total`）：
 * 全局样本在前，紧跟其后的是**归因标签**（R8-P4）样本。
 *
 * ⚠️ 全局那行（无 label）必须保持**第一个** —— `renderOpenMetrics` 靠精确匹配它挂 exemplar。
 * ⚠️ 带标签的 token 样本是**四类之和**（combo 标签不再拆 kind —— 两类标签叉乘会把序列数打飞）。
 *
 * 抽出来的原因：这四块是同一件事（「全局 + 每类标签」的并列展开），与 `renderPrometheus`
 * 其余部分不同源；抽前它是全仓最大的可调用体（224 行 / 方法级阈值 240，余量 16）。
 */
function appendRunFamilies(out: string[], state: MetricsState, p: string): void {
  const labelRuns = labeledSamples(state, (a) => a.runs);
  out.push(
    family(`${p}runs_total`, 'counter', 'run 总数（成功 + 失败）', [
      `${p}runs_total ${state.runs}`,
      ...labelRuns.map((s) => `${p}runs_total${s.text} ${s.value}`),
    ]),
  );
  const labelFailed = labeledSamples(state, (a) => a.failed);
  out.push(
    family(`${p}runs_failed_total`, 'counter', '失败的 run 数（trace.status=error）', [
      `${p}runs_failed_total ${state.failed}`,
      ...labelFailed.map((s) => `${p}runs_failed_total${s.text} ${s.value}`),
    ]),
  );
  const labelTokens = labeledSamples(state, (a) => a.tokens);
  out.push(
    family(
      `${p}tokens_total`,
      'counter',
      'token 累计（kind 分项：input / output / cache_read / cache_creation）',
      [
        `${p}tokens_total{kind="input"} ${state.tokens.input}`,
        `${p}tokens_total{kind="output"} ${state.tokens.output}`,
        `${p}tokens_total{kind="cache_read"} ${state.tokens.cacheRead}`,
        `${p}tokens_total{kind="cache_creation"} ${state.tokens.cacheCreation}`,
        ...labelTokens.map((s) => `${p}tokens_total${s.text} ${s.value}`),
      ],
    ),
  );
  const labelCost = labeledSamples(state, (a) => a.costUsd);
  out.push(
    family(`${p}cost_usd_total`, 'counter', '累计成本估算（美元）', [
      `${p}cost_usd_total ${state.costUsd}`,
      ...labelCost.map((s) => `${p}cost_usd_total${s.text} ${s.value}`),
    ]),
  );
}

export function renderPrometheus(state: MetricsState, p: string): string {
  const out: string[] = [];
  // 四个 run 级家族（全局样本 + 归因标签样本）⇒ 抽成 `appendRunFamilies`（见其定义处）
  appendRunFamilies(out, state, p);
  // 基数上限的**可见性**：被折叠掉的不同键数。与 `snapshot()` 的同名字段一一对应 ——
  // 此前只有 snapshot() 有、render() 没有，于是「按文档把 metricsSink 接到 /metrics」的部署
  // **完全看不见折叠发生**（静默丢失）；而同一份文件对「算不出成本的 turn」专门发了
  // `model_unpriced_turns_total`，口径不一致。
  // 与 unpriced 不同：**恒定发三行**（不是 >0 才发）—— 「0 → N」这个变化本身就是要告警的信号。
  out.push(
    family(`${p}dropped_keys`, 'gauge', '因基数上限被折叠的不同键数（kind 分项）', [
      `${p}dropped_keys{kind="capability"} ${state.capBudget.dropped}`,
      `${p}dropped_keys{kind="model"} ${state.modelBudget.dropped}`,
      `${p}dropped_keys{kind="score"} ${state.scoreBudget.dropped}`,
      // 归因标签每键一行（kind 取 `label:<key>`，与能力标签的 `kind:name` 同款拼法）；
      // 未配置 labelKeys 时一行都没有（不是 0 —— 那个维度压根没开）
      ...[...state.labelBudgets.entries()].map(
        ([key, budget]) => `${p}dropped_keys{kind="label:${key}"} ${budget.dropped}`,
      ),
      // 组合数有自己的上限（`maxLabelCombos`）：每键折叠数是**看不见**叉乘爆炸的
      // （2026-09-27 ref-menu-drift-signals），所以这一行与上面每键那几行并存、单列一个 kind
      ...(state.labelBudgets.size > 0
        ? [`${p}dropped_keys{kind="label:combos"} ${state.comboBudget.dropped}`]
        : []),
    ]),
  );
  // 时长：histogram（可跨实例聚合）+ 窗口内精确分位（单实例好读），两种口径并存。
  // 分位 gauge 必须用另一个名字 `*_last` —— 同名指标只允许一种 TYPE，
  // 先发 histogram 再发 gauge 会被 expfmt 判硬错误，整次 scrape 失败。
  out.push(
    family(`${p}run_duration_ms`, 'histogram', 'run 时长（毫秒）', [
      ...histogramSamples(`${p}run_duration_ms`, state.runStat),
    ]),
  );
  out.push(
    family(`${p}run_duration_ms_last`, 'gauge', 'run 时长分位（毫秒，滑动窗口内精确值）', [
      `${p}run_duration_ms_last{quantile="0.5"} ${state.runStat.percentile(0.5)}`,
      `${p}run_duration_ms_last{quantile="0.95"} ${state.runStat.percentile(0.95)}`,
    ]),
  );

  // —— 能力维度（E2）：同一家族的样本跨 label 聚合，家族头只发一次 ——
  const capLabels = [...state.capabilities.keys()].sort();
  if (capLabels.length > 0) {
    const calls: string[] = [];
    const errors: string[] = [];
    const durations: string[] = [];
    const durationQuantiles: string[] = [];
    const capabilityTokens: string[] = [];
    const capabilityCosts: string[] = [];
    for (const label of capLabels) {
      const acc = state.capabilities.get(label)!;
      const lv = escLabel(label);
      const l = `{capability="${lv}"}`;
      calls.push(`${p}capability_calls_total${l} ${acc.calls}`);
      errors.push(`${p}capability_errors_total${l} ${acc.errors}`);
      durations.push(...histogramSamples(`${p}capability_duration_ms`, acc.stat, l));
      durationQuantiles.push(
        `${p}capability_duration_ms_last{capability="${lv}",quantile="0.5"} ${acc.stat.percentile(0.5)}`,
        `${p}capability_duration_ms_last{capability="${lv}",quantile="0.95"} ${acc.stat.percentile(0.95)}`,
      );
      if (acc.tokens !== null)
        capabilityTokens.push(`${p}capability_tokens_total${l} ${acc.tokens}`);
      if (acc.costUsd !== null)
        capabilityCosts.push(`${p}capability_cost_usd_total${l} ${acc.costUsd}`);
    }
    out.push(family(`${p}capability_calls_total`, 'counter', '能力调用次数', calls));
    out.push(family(`${p}capability_errors_total`, 'counter', '能力失败次数', errors));
    out.push(family(`${p}capability_duration_ms`, 'histogram', '能力调用耗时（毫秒）', durations));
    out.push(
      family(
        `${p}capability_duration_ms_last`,
        'gauge',
        '能力调用耗时分位（窗口内精确值）',
        durationQuantiles,
      ),
    );
    if (capabilityTokens.length > 0) {
      out.push(
        family(
          `${p}capability_tokens_total`,
          'counter',
          'skill/subagent 的子孙 token 合计',
          capabilityTokens,
        ),
      );
    }
    if (capabilityCosts.length > 0) {
      out.push(
        family(
          `${p}capability_cost_usd_total`,
          'counter',
          'skill/subagent 的估算成本（美元）',
          capabilityCosts,
        ),
      );
    }
  }

  // —— 模型维度（E3）——
  const modelNames = [...state.models.keys()].sort();
  if (modelNames.length > 0) {
    const turns: string[] = [];
    const modelTokens: string[] = [];
    const modelCosts: string[] = [];
    const unpriced: string[] = [];
    const usageMissing: string[] = [];
    const durations: string[] = [];
    const durationQuantiles: string[] = [];
    for (const model of modelNames) {
      const acc = state.models.get(model)!;
      const mv = escLabel(model);
      const l = `{model="${mv}"}`;
      turns.push(`${p}model_turns_total${l} ${acc.turns}`);
      modelTokens.push(`${p}model_tokens_total${l} ${acc.tokens}`);
      modelCosts.push(`${p}model_cost_usd_total${l} ${acc.costUsd}`);
      if (acc.unpricedTurns > 0)
        unpriced.push(`${p}model_unpriced_turns_total${l} ${acc.unpricedTurns}`);
      if (acc.usageMissingTurns > 0)
        usageMissing.push(`${p}model_usage_missing_turns_total${l} ${acc.usageMissingTurns}`);
      durations.push(...histogramSamples(`${p}model_duration_ms`, acc.stat, l));
      durationQuantiles.push(
        `${p}model_duration_ms_last{model="${mv}",quantile="0.5"} ${acc.stat.percentile(0.5)}`,
        `${p}model_duration_ms_last{model="${mv}",quantile="0.95"} ${acc.stat.percentile(0.95)}`,
      );
    }
    out.push(family(`${p}model_turns_total`, 'counter', '模型往返次数', turns));
    out.push(
      family(`${p}model_tokens_total`, 'counter', '模型 token 合计（四类之和）', modelTokens),
    );
    out.push(
      family(
        `${p}model_cost_usd_total`,
        'counter',
        '模型估算成本（美元，仅已定价部分）',
        modelCosts,
      ),
    );
    if (unpriced.length > 0) {
      out.push(
        family(
          `${p}model_unpriced_turns_total`,
          'counter',
          '算不出成本的 turn 数（模型不在价格表内）',
          unpriced,
        ),
      );
    }
    // S2：上游没回报 usage ⇒ 成本看起来是 0（`maxCostUsd` 静默失效）。这条与 unpriced
    // **分开**发：两者都让成本像 0，但一个是换模型、一个是查端点/网关。
    if (usageMissing.length > 0) {
      out.push(
        family(
          `${p}model_usage_missing_turns_total`,
          'counter',
          '上游未回报 usage 的 turn 数（成本会看起来是 0，护栏因此不可用）',
          usageMissing,
        ),
      );
    }
    out.push(family(`${p}model_duration_ms`, 'histogram', '模型往返耗时（毫秒）', durations));
    out.push(
      family(
        `${p}model_duration_ms_last`,
        'gauge',
        '模型往返耗时分位（窗口内精确值）',
        durationQuantiles,
      ),
    );
  }

  // —— 评分维度（R7）：gauge 记最近一次值、counter 记条数，label 为 name × source ——
  if (state.scores.size > 0) {
    const gaugeSamples: string[] = [];
    const counterSamples: string[] = [];
    for (const key of [...state.scores.keys()].sort()) {
      const acc = state.scores.get(key)!;
      const { name, source } = scoreLabels(key);
      const l = `{name="${escLabel(name)}",source="${escLabel(source)}"}`;
      gaugeSamples.push(`${p}score${l} ${acc.value}`);
      counterSamples.push(`${p}score_total${l} ${acc.count}`);
    }
    out.push(family(`${p}score`, 'gauge', '最近一次评分（label 为评分维度与来源）', gaugeSamples));
    out.push(family(`${p}score_total`, 'counter', '评分条数', counterSamples));
  }
  return out.join('');
}

/**
 * **OpenMetrics 文本渲染**（`application/openmetrics-text`）—— exemplars 的出口。
 *
 * Prometheus 原文格式（0.0.4）**不支持** exemplar（样本行尾 `# {…}` 那段语法只有
 * OpenMetrics 有），所以要「指标尖峰 → 那条 trace」就必须换这一个格式。
 *
 * 实现 = `renderPrometheus` 的输出 + 两处样本行尾追加 exemplar + `# EOF` 收尾，
 * 其余内容**逐字节同源**（两条输出共用同一份渲染，永远不会漂）。三个编辑点：
 * - `runs_failed_total` 样本行尾挂最近一次失败 run（counter 的 exemplar 值 = 该次增量 1）；
 * - `run_duration_ms` 的 exemplar 挂在**最慢那次落入的 bucket** 行上
 *   （OpenMetrics 规定 histogram 的 exemplar 必须挂 bucket，不能挂 sum/count）；
 * - 文件末尾 `# EOF`（OpenMetrics 的强制收尾）。
 * trace_id 走 `wireTraceId` 投影（hex，Tempo/Grafana 的 exemplar 跳转按它查）。
 */
export function renderOpenMetrics(state: MetricsState, p: string): string {
  let text = renderPrometheus(state, p);

  const failed = state.failedExemplar;
  if (failed) {
    const plain = `${p}runs_failed_total ${state.failed}\n`;
    // renderPrometheus 恒定输出这行（failed ≥ 1 是 failedExemplar 存在的前提）
    text = text.replace(
      plain,
      `${plain.trimEnd()} # {trace_id="${wireTraceId(failed.traceId)}"} 1 ${failed.at / 1000}\n`,
    );
  }

  const slowest = state.slowestExemplar;
  if (slowest) {
    const le = state.runStat.boundsList.find((b) => slowest.durationMs <= b);
    const head = `${p}run_duration_ms_bucket{le="${le === undefined ? '+Inf' : le}"} `;
    const i = text.indexOf(head);
    if (i >= 0) {
      const eol = text.indexOf('\n', i);
      text = `${text.slice(0, eol)} # {trace_id="${wireTraceId(slowest.traceId)}"} ${slowest.durationMs} ${slowest.at / 1000}${text.slice(eol)}`;
    }
  }

  return `${text}# EOF\n`;
}
