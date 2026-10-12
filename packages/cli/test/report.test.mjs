import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错）。`report` 依赖构建期拷进
 * dist/inspector/ 的 trace-view 聚合实现，所以只有 build:cli 之后才有意义。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SUMMARY = fileURLToPath(new URL('../dist/inspector/summary.js', import.meta.url));
const SKIP =
  !existsSync(CLI) || !existsSync(SUMMARY)
    ? '未构建 packages/cli/dist —— 先跑 npm run build:cli'
    : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) {
  distReadyOrLoud(CLI, 'CLI 构建产物');
  distReadyOrLoud(SUMMARY, 'trace-view 聚合产物');
}

const trace = {
  traceId: 'run-1',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    {
      spanId: 's0',
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: 0,
      endedAt: 500,
      status: 'ok',
      attributes: {},
      events: [],
    },
    {
      spanId: 's1',
      parentSpanId: 's0',
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 10,
      endedAt: 200,
      status: 'ok',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0.01,
      },
      attributes: {},
      events: [
        { time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 300 } },
        { time: 60, name: 'tool.output', body: { tool: 'flaky', ok: false, durationMs: 12 } },
      ],
    },
    {
      spanId: 's2',
      parentSpanId: 's0',
      kind: 'capability',
      name: 'researcher',
      startedAt: 300,
      endedAt: 400,
      status: 'ok',
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0.004,
      },
      attributes: { subagent: 'researcher' },
      events: [],
    },
  ],
};

function withFile(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-report-'));
  const file = join(dir, 'traces.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  try {
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('agentia report', { skip: SKIP }, () => {
  it('裸 Trace：打印按总耗时降序的能力排行', () => {
    withFile([JSON.stringify(trace)], (file) => {
      const out = run(['report', file]);
      assert.match(out, /runs {7}1（失败 0）/);
      assert.match(out, /subagent:researcher/);
      assert.match(out, /tool:search/);
      assert.match(out, /tool:flaky/);
      // 排序：researcher 100ms > search 300ms？—— search 是 300ms，应排第一
      assert.ok(
        out.indexOf('tool:search') < out.indexOf('subagent:researcher'),
        '总耗时大的排前面',
      );
      // 未定价的工具在 tokens/cost 列显式给 '-'
      assert.match(out, /tool:flaky\s+1\s+1\s+12ms/);
      assert.match(out, /合计耗时/);
    });
  });

  it('TaskRecord（含 result.trace）也能解出来', () => {
    withFile([JSON.stringify({ ok: true, runId: 'run-1', result: { trace } })], (file) => {
      const out = run(['report', file]);
      assert.match(out, /runs {7}1/);
      assert.match(out, /tool:search/);
    });
  });

  it('多条记录按能力合并（calls/total 累加，max 取大）', () => {
    withFile([JSON.stringify(trace), JSON.stringify(trace)], (file) => {
      const out = run(['report', file]);
      assert.match(out, /runs {7}2/);
      assert.match(out, /tool:search\s+2\s+0\s+600ms\s+300ms/);
    });
  });

  it('无法解析的行被跳过并计数，不炸', () => {
    withFile([JSON.stringify(trace), 'oops', '{bad json'], (file) => {
      const out = run(['report', file]);
      assert.match(out, /跳过无法解析 2 行/);
      assert.match(out, /tool:search/);
    });
  });

  it('文件里没有可识别的 trace → 非零退出 + 说明', () => {
    withFile(['{"nope":1}'], (file) => {
      assert.throws(
        () => run(['report', file]),
        (e) => {
          assert.equal(e.status, 1);
          assert.match(String(e.stderr), /没有可识别的 trace/);
          return true;
        },
      );
    });
  });

  it('缺参数 / 文件不存在 → 非零退出', () => {
    assert.throws(
      () => run(['report']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /用法：agentia report/);
        return true;
      },
    );
    assert.throws(
      () => run(['report', '/tmp/definitely-not-here.jsonl']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /读不到文件/);
        return true;
      },
    );
  });

  it('--help 里列出 report', () => {
    assert.match(run(['--help']), /agentia report <trace\.jsonl>/);
  });

  // ---------- G6：会话 / 任务维度 ----------
  /* 造一条可控的 run：session 属性 / 成本 / 成败 / 根耗时都能指定。
   * `cost === undefined` ⇒ **不写** `totalUsage`（模拟手工 trace / 未定价），
   * 这是「成本读不出」那条用例的病灶形状。 */
  const runTrace = ({ traceId, session, status = 'ok', cost, ms = 1000 }) => ({
    traceId,
    rootSpanId: 's0',
    status,
    ...(cost === undefined ? {} : { totalUsage: { costEstimate: cost } }),
    spans: [
      {
        spanId: 's0',
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt: 0,
        endedAt: ms,
        status,
        attributes: session === undefined ? {} : { 'session.id': session },
        events: [],
      },
      {
        spanId: 's1',
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 0,
        endedAt: 10,
        status: 'ok',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate: 0.001,
        },
        attributes: {},
        events: [],
      },
    ],
  });

  it('会话维度：按 run 根 session.id 归组，成本按成功数摊（成功率带分母）', () => {
    withFile(
      [
        JSON.stringify(runTrace({ traceId: 'a', session: 'S', cost: 0.02, ms: 2000 })),
        JSON.stringify(
          runTrace({ traceId: 'b', session: 'S', status: 'error', cost: 0.03, ms: 500 }),
        ),
      ],
      (file) => {
        const p = JSON.parse(run(['report', file, '--json']));
        assert.equal(p.sessions.length, 1);
        const s = p.sessions[0];
        assert.equal(s.session, 'S');
        // runs / succeeded / failed 三个数都在 ⇒ 「成功 1 条」不是孤立百分比
        assert.deepEqual([s.runs, s.succeeded, s.failed], [2, 1, 1]);
        assert.equal(s.totalMs, 2500);
        assert.equal(s.costUsd, 0.05);
        assert.equal(s.costPerSuccess, 0.05); // 0.05 / 1 成功条
      },
    );
  });

  it('无会话的 run 落 (无会话) 桶；TaskRecord 的 taskId 作回退键（两者不混排）', async () => {
    // 桶名从源码取常量，不在测试里重写一遍字面量 —— 否则改名时两边一起漂移。
    // 动态 import 放在用例内：dist 缺席时整个用例已被 skip（顶层 import 会连累整份文件）。
    const { NO_SESSION } = await import(new URL('../dist/report.js', import.meta.url).href);
    withFile(
      [
        JSON.stringify(runTrace({ traceId: 'a' })),
        JSON.stringify({ taskId: 'T-1', result: { trace: runTrace({ traceId: 'b' }) } }),
      ],
      (file) => {
        const p = JSON.parse(run(['report', file, '--json']));
        assert.deepEqual(p.sessions.map((s) => s.session).sort(), [NO_SESSION, 'T-1']);
      },
    );
  });

  it('总耗时降序：会话表也按 total 排（与人读的顺序一致）', () => {
    withFile(
      [
        JSON.stringify(runTrace({ traceId: 'a', session: 'small', ms: 100 })),
        JSON.stringify(runTrace({ traceId: 'b', session: 'big', ms: 900 })),
      ],
      (file) => {
        const p = JSON.parse(run(['report', file, '--json']));
        assert.deepEqual(
          p.sessions.map((s) => s.session),
          ['big', 'small'],
        );
      },
    );
  });

  // ⚠️ **反向断言**：这一条是 G6 的存在理由 —— 「成功率」最容易写成一笔假账。
  it('成功数为 0 的组：cost/ok 是 `-`（null），**不是 0、也不是 Infinity**', () => {
    withFile(
      [JSON.stringify(runTrace({ traceId: 'a', session: 'F', status: 'error', cost: 0.07 }))],
      (file) => {
        const p = JSON.parse(run(['report', file, '--json']));
        const s = p.sessions[0];
        assert.equal(s.costUsd, 0.07); // 成本照记（它确实花了钱）
        assert.equal(s.costPerSuccess, null); // ← 除不了就是 null，不伪装
        assert.equal(JSON.stringify(s.costPerSuccess), 'null'); // 不能是 0 / Infinity / NaN
        const out = run(['report', file]);
        assert.match(out, /^F\s+1\s+0\s+1\s+1\.00s\s+0\.070000\s+-/m);
      },
    );
  });

  it('成本读不出（无 totalUsage）：cost 与 cost/ok 都给 `-`，不伪装成 0', () => {
    withFile([JSON.stringify(runTrace({ traceId: 'a', session: 'N' }))], (file) => {
      const p = JSON.parse(run(['report', file, '--json']));
      assert.equal(p.sessions[0].costUsd, null);
      assert.equal(p.sessions[0].costPerSuccess, null);
      assert.match(run(['report', file]), /^N\s+1\s+1\s+0\s+1\.00s\s+-\s+-/m);
    });
  });

  it('没配会话时如实给一行 (无会话)（不隐藏、不折叠）', () => {
    withFile([JSON.stringify(trace)], (file) => {
      const out = run(['report', file]);
      assert.match(out, /^session\s+runs\s+ok\s+fail\s+total/m);
      assert.match(out, /^\(无会话\)\s+1\s+1\s+0\s+500ms/m);
    });
  });
});
