/**
 * 基准：**挂起量 → `resumePending()` 的扫描成本**（研究稿 §6 第 7 条 ②「到期索引」要不要做）。
 *
 * 为什么要有这个文件：那条候选的原文是「上量之后才现形」，而**「上量」是个数字**——
 * 没有数字就只会在两个错之间摇摆（提前长一层平时没人走的索引，或者等到线上真卡住才发现）。
 * 这个脚本把那个数字量出来，并把**触发条件**写进 spec §10 2026-09-28 ref-due-index-measure。
 *
 * 测什么：N 条记录（其中 1/10 是 `suspended` 且 `wakeAt` 在未来 —— 不该被唤醒的那一类）
 * 下，`store.list()` 与 `runner.resumePending()` 各耗多少。
 * 三种口径都打出来，因为它们的差就是「索引能省掉的那部分」：
 *   list    = 全表读（JSON 解析 + 反序列化）
 *   resume  = list + 逐条判定（到期 / 审批超时 / 孤儿 / 挂起读数重建）
 *   差额     = 判定本身；索引能省掉的是**扫描**，不是判定。
 *
 * 跑法：`npx tsx scripts/bench-resume-scan.ts [N...]`（缺省 100 1000 10000）
 * 口径：单机、空载；数字随机器与 Node 版本变，**只用来定「量级」与触发条件**，不当常量。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncRunner, FileTaskStore } from '../src/index.js';
import type { AppCallable, TaskRecord } from '../src/index.js';

const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const SIZES = sizes.length > 0 ? sizes : [100, 1_000, 10_000];

/** 一次不产生任何 run 的 app（本基准只测扫描，不测执行） */
const noopApp: AppCallable = {
  name: 'bench',
  async run() {
    throw new Error('bench 不该派发任何 run');
  },
};

function rec(i: number, suspended: boolean): TaskRecord {
  const base: TaskRecord = {
    taskId: `task_${String(i).padStart(6, '0')}`,
    status: suspended ? 'suspended' : 'succeeded',
    // 挂起记录形状：原因 + 目标时刻 + 在等的那条 tool_use（与真实落库形状一致）
    ...(suspended
      ? {
          suspendedReason: 'timer' as const,
          suspendedSince: Date.now() - 60_000,
          wakeAt: Date.now() + 3_600_000, // 未来 ⇒ 不该被唤醒
          pendingApprovals: ['tu1'],
          spec: {
            messages: [{ role: 'user', content: 'x'.repeat(200) }],
            options: {},
            source: 'async' as const,
          },
        }
      : {
          spec: {
            messages: [{ role: 'user', content: 'x'.repeat(200) }],
            options: {},
            source: 'async' as const,
          },
          finishedAt: Date.now() - 1_000,
        }),
    createdAt: Date.now() - 3_600_000,
  };
  return base;
}

function timeIt(fn: () => number): { ms: number; value: number } {
  const t0 = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, value };
}

/**
 * `resumePending()` 的返回类型是 `number | Promise<number>`（异步 store 下是 Promise），
 * 而本基准只喂同步 store ⇒ 现场归一。用 `timeIt` 包不住它（那里的 fn 必须同步出数）。
 */
async function timeResume(runner: AsyncRunner): Promise<{ ms: number; value: number }> {
  const t0 = process.hrtime.bigint();
  const r = runner.resumePending();
  const value = typeof r === 'number' ? r : await r;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, value };
}

const dir = mkdtempSync(join(tmpdir(), 'agentia-bench-scan-'));
try {
  console.log('挂起量 → resumePending 扫描成本（file store；单次读数，看量级不看小数）');
  console.log(
    '⚠️ 读数口径：FileTaskStore 的记录**在内存里**（load 之后 list 只是返回 Map 的 snapshot）',
  );
  console.log('   ⇒ 它真正贵的「全表读」是**构造期的 load**（逐行 JSON.parse）。');
  console.log(
    '   所以下面 load 列才是「重启后首次扫描」的代价；sqlite / redis 那边 list 每次都是真查询。',
  );
  console.log('     N    挂起  load(ms)  list(ms)  resume(ms)   磁盘(MB)');
  for (const n of SIZES) {
    const file = join(dir, `tasks-${n}.jsonl`);
    const seed = new FileTaskStore(file);
    const suspended = Math.max(1, Math.floor(n / 10));
    for (let i = 0; i < n; i++) seed.save(rec(i, i < suspended));
    // 重新构造：让 load()（全表 JSON 解析）进被测路径 —— 重启后的首次扫描正是这个形状
    const load = timeIt(() => {
      new FileTaskStore(file);
      return 1;
    });
    const loaded = new FileTaskStore(file);
    const runner = new AsyncRunner(noopApp, { store: loaded });

    const list = timeIt(() => loaded.list().length);
    const resume = await timeResume(runner);
    if (resume.value !== 0) throw new Error(`不该唤醒任何记录，实际 ${resume.value}`);
    const mb = statSync(file).size / (1024 * 1024);
    console.log(
      `${String(n).padStart(6)}  ${String(suspended).padStart(5)}  ${load.ms
        .toFixed(1)
        .padStart(8)}  ${list.ms.toFixed(1).padStart(8)}  ${resume.ms
        .toFixed(1)
        .padStart(10)}  ${mb.toFixed(1).padStart(9)}`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── sqlite：这里 `list()` **每次都是真查询**（不像 file store 从内存 Map 返回）─────────────
// 用 :memory:（省掉磁盘抖动；形状与 file store 一列之差：status 是列 + json）。
// ⚠️ 读写同一进程、单连接 —— 多进程共库时的锁等待不在本基准范围内。
//
// 2026-09-28 ref-due-index-measure 落地后补的 `due` 列：`store.listDue(now)`（到期索引，派生列 + (status, wake_at)
// 索引）的代价 —— 它是 O(到期数) 而不是 O(全表)。⚠️ 但 `resume` **不会**因此显著下降：
// resumePending 的扫描还干别的事（挂起读数重建 / 审批超时 / 孤儿认领），那些职责的输入
// 仍是全表 list() —— listDue 只替代「到期唤醒」那一半的输入（见 async.ts #redispatch）。
// 这列数字回答的是「如果只扫到期的，要多少钱」（= 将来拆扫描职责时能省下的那笔）。
const { SqliteTaskStore } = await import('../src/store/sqliteStore.js');
console.log('\nsqlite（:memory:；list 每次真查询；due = listDue 到期索引）');
console.log('     N    挂起  list(ms)   due(ms)  resume(ms)');
for (const n of SIZES) {
  const store = new SqliteTaskStore(':memory:');
  const suspended = Math.max(1, Math.floor(n / 10));
  for (let i = 0; i < n; i++) store.save(rec(i, i < suspended));
  const list = timeIt(() => store.list().length);
  const due = timeIt(() => store.listDue(Date.now()).length);
  const runner = new AsyncRunner(noopApp, { store });
  const resume = await timeResume(runner);
  if (resume.value !== 0) throw new Error(`不该唤醒任何记录，实际 ${resume.value}`);
  console.log(
    `${String(n).padStart(6)}  ${String(suspended).padStart(5)}  ${list.ms
      .toFixed(1)
      .padStart(8)}  ${due.ms.toFixed(1).padStart(8)}  ${resume.ms.toFixed(1).padStart(10)}`,
  );
}
