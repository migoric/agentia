/**
 * 离线确定性 demo（`npm run demo`）—— 零 API key、零网络、零副作用。
 *
 * 用框架公共面 `scriptedClient` 把每个 agent 的回合写成剧本，于是**编排路径本身**成了断言对象：
 * 谁先跑、拆了几单、哪一单挂起等人批、批完之后有没有真落地 —— 都能在这一份输出里看到。
 *
 * 想看的四件事（输出里逐条标了序号）：
 *   ① Router 一次短 run 拆出 N 个工单（结构化结果，不是从自由文本里抠）
 *   ② N 个 Worker 各自一个 task、并行执行（不是主 agent 同步等子 agent）
 *   ③ 写操作的工单**挂起**等人批，批完才落到沙箱 —— 不批就不写
 *   ④ Router 与每个 Worker 是各自的 trace，Worker 的根 span 带 link 指回 Router
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncRunner, InMemoryTaskStore, scriptedClient } from '@migor/agentia';
import type { SpanLink, Trace, TraceSink } from '@migor/agentia';
import { createRouterApp, createWorkerApp } from './agents.js';
import { DEFAULT_GOAL, MODEL, SEED_FILES } from './config.js';
import { runGoal } from './orchestrator.js';
import { Sandbox } from './sandbox.js';

// ─────────────────────────── 剧本工具 ───────────────────────────

const usage = (inputTokens: number, outputTokens: number) => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

let seq = 0;

/** 「调工具」回合（可多个 tool_use 并行） */
function toolTurn(
  inputTokens: number,
  outputTokens: number,
  calls: Array<{ name: string; input: unknown }>,
) {
  const id = ++seq;
  return {
    id: `m${id}`,
    model: MODEL,
    stop_reason: 'tool_use' as const,
    usage: usage(inputTokens, outputTokens),
    content: calls.map((c, i) => ({ type: 'tool_use', id: `tu${id}_${i}`, ...c })),
  };
}

/** 「纯文本收尾」回合 */
function textTurn(inputTokens: number, outputTokens: number, text: string) {
  const id = ++seq;
  return {
    id: `m${id}`,
    model: MODEL,
    stop_reason: 'end_turn' as const,
    usage: usage(inputTokens, outputTokens),
    content: [{ type: 'text', text }],
  };
}

/** 修复后的 pricing.ts —— 只改了 `sum += item.price * item.quantity;` 这一行 */
const FIXED_PRICING = [
  'export interface Item {',
  '  price: number;',
  '  quantity: number;',
  '}',
  '',
  'export function total(items: Item[]): number {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price * item.quantity;',
  '  }',
  '  return sum;',
  '}',
  '',
].join('\n');

// ─────────────────────────── 断言 ───────────────────────────

/** 断言计数：结尾那行印「N 条断言全中」用**实际**计数，改断言时不会留下一句会腐烂的硬编码 */
let asserted = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`DEMO FAIL: ${msg}`);
  asserted++;
};

/**
 * 从一条 trace 沿根 span 的 links 回溯到目标，返回跳数（到不了返回 null）。
 *
 * 为什么不直接比「link 的 traceId == Router 的 runId」：**挂起/恢复是两棵树** ——
 * 恢复段 link 的是**挂起段**，不是 Router。所以一个需要审批的工单回家要走**两跳**：
 *   Router ← fix 挂起段 ← fix 恢复段
 * 断言写成「一跳」会把框架的正确行为判成失败（这个 demo 第一版就是这么写错的）。
 */
function hopsTo(
  traceId: string,
  all: Trace[],
  target: string,
  seen: Set<string> = new Set(),
): number | null {
  if (traceId === target) return 0;
  if (seen.has(traceId)) return null;
  seen.add(traceId);
  const trace = all.find((t) => t.traceId === traceId);
  if (!trace) return null;
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  for (const link of root?.links ?? []) {
    const sub = hopsTo(link.traceId, all, target, seen);
    if (sub !== null) return sub + 1;
  }
  return null;
}

// ─────────────────────────── 装配 ───────────────────────────

const traces: Trace[] = [];
/** 三个 app 各挂一份 sink：**这是唯一能同时看到三棵树的视角**（每棵树的 traceId == 那个 run 的 runId） */
const collect: TraceSink = {
  export(trace) {
    traces.push(trace);
  },
};

const sandbox = new Sandbox(SEED_FILES);
const routerApp = createRouterApp({ sinks: [collect] });
const reproApp = createWorkerApp('repro', sandbox, { sinks: [collect] });
const fixApp = createWorkerApp('fix', sandbox, { sinks: [collect] });

/** 两个 runner **共用一个 store** —— 菜单不同所以 app 不同，但任务记录在同一本账上 */
const store = new InMemoryTaskStore();
const runners = {
  repro: new AsyncRunner(reproApp, { store, concurrency: 2 }),
  fix: new AsyncRunner(fixApp, { store, concurrency: 1 }),
};

// ─────────────────────────── 剧本 ───────────────────────────

/** Router：一回合，直接调隐藏的 submit_result 交工单清单 */
const routerClient = scriptedClient([
  toolTurn(1_200, 180, [
    {
      name: 'submit_result',
      input: {
        tickets: [
          { id: 'T1', kind: 'repro', goal: '定位订单总额计算错误的根因，给出文件与行号' },
          { id: 'T2', kind: 'fix', goal: '修复 total() 忽略 quantity 的缺陷并写回文件' },
        ],
      },
    },
  ]),
]);

/** T1（只读复现）：搜一下 → 出结论。两回合。 */
const reproClient = scriptedClient([
  toolTurn(900, 60, [{ name: 'search_text', input: { query: 'sum +=' } }]),
  textTurn(
    1_100,
    220,
    '根因在 src/pricing.ts 第 9 行：`sum += item.price;` 只累加了单价，漏掉了 item.quantity。' +
      '因此 2 件 × 50 元被算成 50 元。正确行为应为 sum += item.price * item.quantity。',
  ),
]);

/** T2（要改代码）：读 → 写（挂起待批）→ 恢复后收尾。三回合。 */
const fixClient = scriptedClient([
  toolTurn(950, 70, [{ name: 'read_file', input: { path: 'src/pricing.ts' } }]),
  toolTurn(1_300, 420, [
    {
      name: 'write_file',
      input: {
        path: 'src/pricing.ts',
        content: FIXED_PRICING,
        reason: '把 sum += item.price 改为 sum += item.price * item.quantity，修复总额漏乘数量',
      },
    },
  ]),
  textTurn(
    1_400,
    160,
    '已修复 src/pricing.ts 第 9 行：金额改为按 单价 × 数量 累加，两件 50 元现在合计 100。',
  ),
]);

// ─────────────────────────── 跑 ───────────────────────────

const START = Date.now();

const outcome = await runGoal({
  goal: DEFAULT_GOAL,
  goalId: 'msg-2026-11-03-001',
  router: routerApp,
  runners,
  routerClient,
  clientFor: (ticket) => (ticket.kind === 'fix' ? fixClient : reproClient),
  pollIntervalMs: 10, // demo 里缩短轮询；生产 250ms 起
  ticketTimeoutMs: 30_000,
  onApproval: async ({ ticket, taskId, pending }) => {
    console.log(
      `\n⚠️  工单 ${ticket.id} 挂起等人批：task=${taskId}，待决 tool_use=${pending.join(', ')}`,
    );
    console.log('    （不可逆动作必须先过这道闸 —— 这里扮演「人」，批了它）');
    return { approved: true, decidedBy: 'demo-human', reason: '改动符合预期，批准' };
  },
});

// ─────────────────────────── 输出 ───────────────────────────

const line = '─'.repeat(72);

console.log(`\n${line}\n① 拆单（Router 一次短 run，结构化结果）\n${line}`);
console.log(`   goal      : ${DEFAULT_GOAL}`);
console.log(`   routerRun : ${outcome.routerRunId}`);
for (const t of outcome.plan) console.log(`   - ${t.id} [${t.kind}] ${t.goal}`);

console.log(`\n${line}\n② 工单执行（各自一个 task，并行）\n${line}`);
for (const o of outcome.outcomes) {
  console.log(`   - ${o.ticket.id} [${o.ticket.kind}] status=${o.status} task=${o.taskId}`);
  console.log(`     runIds: ${o.runIds.join(', ') || '(无)'}`);
  console.log(`     报告  : ${o.summary}`);
}

console.log(`\n${line}\n③ 写操作只在批准之后才落地\n${line}`);
const after = sandbox.snapshot();
console.log(
  `   src/pricing.ts 含 "item.quantity" : ${String(after['src/pricing.ts'].includes('item.quantity'))}`,
);
console.log(
  `   修复后的第 9 行                  : ${after['src/pricing.ts'].split('\n')[8]?.trim()}`,
);

console.log(`\n${line}\n④ 观测：一棵树变成一串链\n${line}`);
console.log(`   共 ${traces.length} 棵 trace —— 这不是缺陷，是「挂起/恢复各是一段」的必然结果：`);
console.log('   Router 1 棵 + 每个工单 1 棵；fix 那个因为要审批，挂起段与恢复段各一棵。');
for (const trace of traces) {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  const name = root?.name ?? '(no root)';
  const links: SpanLink[] = root?.links ?? [];
  const hops = hopsTo(trace.traceId, traces, outcome.routerRunId);
  const indent = hops === null ? '   ' : `${'   '}${'      '.repeat(hops)}`;
  const tail =
    hops === 0 ? '  （Router 根）' : hops === null ? '  ⚠️ 链路断了' : `  ← ${hops} 跳回 Router`;
  const via =
    links.length > 0 ? `  links=${links.map((l) => l.traceId.slice(0, 8)).join(',')}` : '';
  console.log(
    `${indent}- ${trace.traceId.slice(0, 8)}  root=${name}  spans=${trace.spans.length}${tail}${via}`,
  );
}

// ─────────────────────────── 断言（demo 也是回归测试）───────────────────────────

assert(outcome.plan.length === 2, 'Router 应拆出 2 个工单');
assert(
  outcome.outcomes.every((o) => o.status === 'succeeded'),
  '所有工单都应 succeeded（含被批准后恢复的那一单）',
);
assert(
  after['src/pricing.ts'].includes('item.price * item.quantity'),
  '写操作应在批准后真正落地到沙箱',
);
assert(
  outcome.outcomes.find((o) => o.ticket.kind === 'fix')?.summary.length !== 0,
  '恢复段应产出最终报告',
);
const workerTraces = traces.filter((t) => t.traceId !== outcome.routerRunId);
assert(workerTraces.length >= 3, 'repro 一棵 + fix 的挂起段/恢复段各一棵');
assert(
  workerTraces.every((t) => hopsTo(t.traceId, traces, outcome.routerRunId) !== null),
  '每条 Worker trace 都应能沿 links 回到 Router（需要审批的那单是两跳）',
);
const fixSegments = traces.filter((t) => {
  const root = t.spans.find((s) => s.spanId === t.rootSpanId);
  return root?.name === 'worker-fix';
});
assert(fixSegments.length === 2, '要审批的工单应产生两棵 trace：挂起段 + 恢复段');

// ─────────────────── 产物（给门禁用；不给就什么都不写）───────────────────

/**
 * `SUPERAGENT_DEMO_OUT=<file>` 时落一份 JSON —— 交互式 `npm run demo` 保持零副作用。
 *
 * 门禁（`scripts/e2e-examples.ts` 的 `verifySuperAgent`）拿走的是**原始结构**，自己重新算
 * 「谁能沿 links 回到 Router、要几跳」—— 断言不转发本文件里的 `hopsTo` 结论，否则把
 * demo 的判据改坏（或改成恒真）时门禁会跟着一起绿。
 *
 * 放在断言之后写：文件存在 ⇒ demo 自己那一轮是绿的。
 */
const outPath = process.env.SUPERAGENT_DEMO_OUT;
if (outPath) {
  const plan = outcome.plan;
  const outcomes = outcome.outcomes.map((o) => ({
    id: o.ticket.id,
    kind: o.ticket.kind,
    taskId: o.taskId,
    status: o.status,
    summary: o.summary,
    runIds: o.runIds,
  }));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      { routerRunId: outcome.routerRunId, plan, outcomes, files: sandbox.snapshot(), traces },
      null,
      1,
    ),
  );
  console.log(`   产物: ${outPath}（门禁用）`);
}

console.log(`\n${line}`);
console.log(`✅ demo 通过（${Date.now() - START}ms，零网络）—— ${asserted} 条断言全中`);
console.log(line);
