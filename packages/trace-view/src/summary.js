/* 能力排行（G2）—— 「哪个能力慢 / 贵 / 爱失败」。
 *
 * 与 trace 调用树同属**框架无关**的展示层：入参是 duck-typed 的 trace 形状，零依赖。
 * CLI inspector 与官网 playground 共用同一份实现，避免两处聚合口径漂移。
 *
 * 数据来源（与框架侧的具名约定一致）：
 * - `capability` span（skill / subagent）→ 调用耗时与子孙 usage 聚合（tokens / costUsd）；
 * - `llm.turn` span 上的 `tool.output` 事件（普通工具不建 span）→ 工具耗时与成败，
 *   读 `body.durationMs` / `body.ok`；
 * - `approval.decided` 事件（**审批不建 span**，G7 护栏）→ `guardrail:<工具名>` 一类的
 *   等审批时长与被拒次数，读 `body.tool` / `body.approved` / `body.waitedMs`。
 *   扫面**不限 span kind**：落点因段而异（首段 llm.turn、恢复段 run 根 —— 续跑入口把
 *   run 根 id 当 turnId），限 kind = 真实 HITL 主流程（挂起 → 人批 → 恢复）零产出；
 *   不双计：记账点只有一处（executeOneTool），一次决定只记一笔。
 *
 * ⚠️ 单条 run 内样本常 < 5，分位没有意义 —— 排行以 total/max 为主，不给 p50/p95
 * （要看分位请用框架的 `buildRunReport` + `mergeRunReports`）。
 */

function kindOf(span) {
  if (span.attributes && span.attributes.skill !== undefined) return 'skill';
  if (span.attributes && span.attributes.subagent !== undefined) return 'subagent';
  return 'capability';
}

/**
 * 从一条 trace 算能力排行。
 * @param {any} trace Trace 形状（spans[] / events[] / usage?）
 * @returns {Array<{capability:string,calls:number,errors:number,totalMs:number,maxMs:number,tokens:number|null,costUsd:number|null}>}
 *          按 totalMs 降序
 */
export function summarizeTrace(trace) {
  const acc = new Map();
  const get = (capability) => {
    let a = acc.get(capability);
    if (!a) {
      a = { capability, calls: 0, errors: 0, totalMs: 0, maxMs: 0, tokens: null, costUsd: null };
      acc.set(capability, a);
    }
    return a;
  };
  const addMs = (a, ms) => {
    const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
    a.totalMs += v;
    if (v > a.maxMs) a.maxMs = v;
  };

  const spans = trace?.spans || [];
  for (const span of spans) {
    if (span.kind === 'capability') {
      const a = get(`${kindOf(span)}:${span.name}`);
      a.calls += 1;
      if (span.status === 'error') a.errors += 1;
      if (span.endedAt != null) addMs(a, span.endedAt - span.startedAt);
      const u = span.usage;
      if (u) {
        a.tokens =
          (a.tokens || 0) +
          (u.inputTokens || 0) +
          (u.outputTokens || 0) +
          (u.cacheReadTokens || 0) +
          (u.cacheCreationTokens || 0);
        if (u.costEstimate != null) a.costUsd = (a.costUsd || 0) + u.costEstimate;
      }
      continue;
    }
    // approval.decided **不限 span kind**（落点因段而异：首段 llm.turn、恢复段 run 根 ——
    // 续跑入口把 run 根 id 当 turnId，见头注）；tool.output 只在 llm.turn 上。
    const isTurn = span.kind === 'llm.turn';
    for (const e of span.events || []) {
      if (e.name === 'approval.decided') {
        // G7 护栏 —— 审批**只是事件**（刻意不建 span），所以它天然不在任何 span 聚合里，
        // 此前「哪个工具卡在审批上、被拒了几次」在排行上完全看不见。这一类补上它：
        //   calls     = 走到「决定」这一步的次数（批准或被拒都算）；
        //   errors    = **被拒**次数（护栏真挡下了几次 —— 它不是系统错误，但那次工具确实没跑）；
        //   total/max = 等审批时长（事件的 `waitedMs`）。⚠️ 只有宿主回填了 `requestedAt`
        //               才有这个数 ⇒ 缺就记 0，**不编造**（框架侧刻意不记「没数据」的 0）。
        // ⚠️ 口径边界：只聚 `approval.decided`。只有 `approval.requested` 而始终没恢复的
        //   挂起**不产出** guardrail 行 —— 它没有结论、也没有时长，硬记一格等于编账。
        const b = e.body;
        if (!b || typeof b !== 'object' || typeof b.tool !== 'string') continue;
        const ga = get(`guardrail:${b.tool}`);
        ga.calls += 1;
        if (b.approved === false) ga.errors += 1;
        addMs(ga, typeof b.waitedMs === 'number' ? b.waitedMs : 0);
        continue;
      }
      if (!isTurn || e.name !== 'tool.output') continue;
      const b = e.body;
      if (!b || typeof b !== 'object' || typeof b.tool !== 'string') continue;
      const a = get(`tool:${b.tool}`);
      a.calls += 1;
      if (b.ok === false) a.errors += 1;
      addMs(a, typeof b.durationMs === 'number' ? b.durationMs : 0);
    }
  }

  return [...acc.values()].sort((x, y) => y.totalMs - x.totalMs || y.calls - x.calls);
}

/** 把排行渲染成一个小表格（返回 HTML 字符串；样式由 trace-view.css 提供） */
export function renderSummary(rows) {
  if (!rows || rows.length === 0) {
    return '<div class="tv-sum-empty">// 没有可归因的能力（没有 capability span，也没有 tool.output 事件）</div>';
  }
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms');
  const body = rows
    .map((r) => {
      const err = r.errors > 0 ? `<span class="tv-sum-err">${r.errors}</span>` : '0';
      const cost =
        r.costUsd != null
          ? r.costUsd < 0.000001
            ? r.costUsd.toExponential(2)
            : r.costUsd.toFixed(6)
          : '-';
      return `<tr><td class="tv-sum-capability">${escapeHtml(r.capability)}</td><td>${r.calls}</td><td>${err}</td><td>${fmtMs(r.totalMs)}</td><td>${fmtMs(r.maxMs)}</td><td>${r.tokens != null ? r.tokens : '-'}</td><td>${cost}</td></tr>`;
    })
    .join('');
  return (
    '<table class="tv-sum"><thead><tr><th>capability</th><th>calls</th><th>err</th><th>total</th><th>max</th><th>tokens</th><th>cost</th></tr></thead>' +
    `<tbody>${body}</tbody></table>`
  );
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
