import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错），同 report.test.mjs 的约定。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SKIP = !existsSync(CLI) ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(CLI, 'CLI 构建产物');
/* 对拍用产物：CLI 移植副本（dist 缺失时整个 describe 已 skip）与框架真源 */
const CLI_HARVEST = fileURLToPath(new URL('../dist/harvest.js', import.meta.url));
const FW_HARVEST = fileURLToPath(new URL('../../../dist/eval/harvest.js', import.meta.url));

const turn1 = {
  spanId: 't1',
  parentSpanId: 's0',
  kind: 'llm.turn',
  name: 'claude-opus-5',
  startedAt: 10,
  status: 'ok',
  attributes: {},
  events: [
    {
      time: 11,
      name: 'tool.input',
      body: { tool: 'search', tool_use_id: 'tu_a1', input: '{"q":"北京天气"}' },
    },
  ],
};
const turn2 = {
  spanId: 't2',
  parentSpanId: 's0',
  kind: 'llm.turn',
  name: 'claude-opus-5',
  startedAt: 20,
  status: 'ok',
  attributes: {},
  events: [],
};

function traceOf(traceId, status) {
  return {
    traceId,
    rootSpanId: 's0',
    status,
    spans: [
      {
        spanId: 's0',
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt: 0,
        status: 'ok',
        attributes: {},
        events: [],
      },
      { ...turn1 },
      { ...turn2 },
    ],
  };
}

/** TaskRecord 形态：spec.messages 是原始输入、result.trace 是完整 trace、status 是终态 */
function recordOf({ taskId, status, traceId, input }) {
  return {
    taskId,
    status,
    spec: { messages: [{ role: 'user', content: input }] },
    runId: traceId,
    result: { trace: traceOf(traceId, status === 'failed' ? 'error' : 'ok') },
  };
}

const okRecord = recordOf({
  taskId: 'task_1',
  status: 'succeeded',
  traceId: 'run-ok',
  input: '帮我查下北京天气',
});
const failedRecord = recordOf({
  taskId: 'task_2',
  status: 'failed',
  traceId: 'run-bad',
  input: '这一步挂了',
});
const bareTrace = traceOf('run-bare', 'ok');

/* ── 对拍夹具（与 diff.test.mjs 同款：多组形态、逐字相等断言）────────────────── */

const U1 = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** span 简写：只列 harvestEvalCase 会读的字段，其余给缺省 */
function spanOf(partial) {
  return {
    spanId: 'sx',
    parentSpanId: 's0',
    kind: 'llm.turn',
    name: 'claude-opus-5',
    startedAt: 0,
    status: 'ok',
    attributes: {},
    events: [],
    ...partial,
  };
}

function runRoot(partial = {}) {
  return {
    spanId: 's0',
    parentSpanId: null,
    kind: 'run',
    name: 'agent.run',
    startedAt: 0,
    status: 'ok',
    attributes: {},
    events: [],
    ...partial,
  };
}

/** ① 无子 agent 的单工具 run：一次 tool.input + 纯文本收尾 */
const traceSingleTool = {
  traceId: 'run-single',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    runRoot(),
    spanOf({
      spanId: 't1',
      startedAt: 10,
      usage: U1,
      events: [
        {
          time: 11,
          name: 'tool.input',
          body: { tool: 'search', tool_use_id: 'tu_a1', input: '{"q":"北京天气"}' },
        },
      ],
    }),
    spanOf({ spanId: 't2', startedAt: 20, usage: U1 }),
  ],
};

/** ② 子 agent 嵌套回合：c1 capability 下挂的 t3 只进注释、不进主循环脚本 */
const traceNested = {
  traceId: 'run-nested',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    runRoot(),
    spanOf({
      spanId: 't1',
      startedAt: 10,
      usage: U1,
      events: [
        {
          time: 11,
          name: 'tool.input',
          body: { tool: 'search', tool_use_id: 'tu_a1', input: '{"q":"竞品"}' },
        },
      ],
    }),
    spanOf({ spanId: 'c1', kind: 'capability', name: 'subagent:researcher', startedAt: 15 }),
    spanOf({
      spanId: 't3',
      parentSpanId: 'c1',
      startedAt: 16,
      usage: U1,
      events: [
        { time: 17, name: 'tool.input', body: { tool: 'internal_tool', tool_use_id: 'tu_z9' } },
      ],
    }),
    spanOf({ spanId: 't2', startedAt: 20, usage: U1 }),
  ],
};

/** ③ 失败 run：trace.status = error（harvestEvalCase 不看它，但输入形态要覆盖到） */
const traceFailed = {
  traceId: 'run-failed',
  rootSpanId: 's0',
  status: 'error',
  spans: [
    runRoot({ status: 'error', error: { type: 'api', message: 'boom', retryable: false } }),
    spanOf({
      spanId: 't1',
      startedAt: 10,
      status: 'error',
      usage: U1,
      events: [
        {
          time: 11,
          name: 'tool.input',
          body: { tool: 'pay', tool_use_id: 'tu_p1', input: '{"amount":12}' },
        },
      ],
    }),
  ],
};

/** ④ 多回合交替：tool / 无 tool / 双 tool / 无 tool */
const traceMulti = {
  traceId: 'run-multi',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    runRoot(),
    spanOf({
      spanId: 't1',
      startedAt: 10,
      usage: U1,
      events: [
        {
          time: 11,
          name: 'tool.input',
          body: { tool: 'search', tool_use_id: 'tu_m1', input: '{"q":"a"}' },
        },
      ],
    }),
    spanOf({ spanId: 't2', startedAt: 20, usage: U1 }),
    spanOf({
      spanId: 't3',
      startedAt: 30,
      usage: U1,
      events: [
        {
          time: 31,
          name: 'tool.input',
          body: { tool: 'translate', tool_use_id: 'tu_m2', input: '{"text":"你好"}' },
        },
        {
          time: 32,
          name: 'tool.input',
          body: { tool: 'search', tool_use_id: 'tu_m3', input: '{"q":"b"}' },
        },
      ],
    }),
    spanOf({ spanId: 't4', startedAt: 40, usage: U1 }),
  ],
};

/** ⑤ 老 trace 边界：缺 tool_use_id（合成 id）、非 JSON input（包 _raw）、input 缺省 */
const traceLegacy = {
  traceId: 'run-legacy',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    runRoot(),
    spanOf({
      spanId: 't1',
      startedAt: 10,
      events: [
        { time: 11, name: 'tool.input', body: { tool: 'translate', input: 'not-json{' } },
        { time: 12, name: 'tool.input', body: { tool: 'search' } },
        // 缺 tool 字段：两边都必须**跳过**这条（回填 'unknown' 会造出一个真的、
        // 且断言必然通过的工具调用 —— 骨架自我自洽、永不报错）
        { time: 13, name: 'tool.input', body: { tool_use_id: 'tu_orphan' } },
      ],
    }),
  ],
};

/** ⑥ 无主循环回合：空脚本分支 */
const traceNoTurns = {
  traceId: 'run-empty',
  rootSpanId: 's0',
  status: 'ok',
  spans: [runRoot()],
};

function withFile(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-harvest-'));
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

describe('agentia harvest', { skip: SKIP }, () => {
  it('默认收全部记录：汇总成含 import 骨架与 defineEval 指引的 eval 脚手架', () => {
    withFile(
      [JSON.stringify(okRecord), JSON.stringify(failedRecord), JSON.stringify(bareTrace)],
      (file) => {
        const out = run(['harvest', file]);
        // 文件骨架
        assert.match(out, /import assert from 'node:assert\/strict';/);
        assert.match(out, /import \{ defineEval, scriptedClient \} from '@migor\/agentia';/);
        assert.match(out, /export const harvestedCases = \[/);
        assert.match(out, /EvalCase 没有 expect 字段/);
        // 三条记录 → 三个用例骨架；TaskRecord 的 spec.messages 进 input
        assert.equal(out.match(/client: scriptedClient\(\[/g).length, 3);
        assert.ok(out.includes('name: "harvest-run-ok",'));
        assert.ok(out.includes('name: "harvest-run-bad",'));
        assert.ok(out.includes('name: "harvest-run-bare",'));
        assert.ok(out.includes('input: "帮我查下北京天气",'));
        assert.ok(out.includes('input: "这一步挂了",'));
        // 裸 Trace 没有 spec.messages → input 占位 + 注释
        assert.match(out, /未提供原始输入（TaskRecord 的 spec\.messages）/);
        // tool_use 重建（原 id 保留）与轨迹断言
        assert.ok(out.includes('"id": "tu_a1"'));
        assert.ok(out.includes('assert.deepEqual(tools, ["search"]);'));
      },
    );
  });

  it('--failed 只收失败记录（TaskRecord status=failed；裸 trace status=error）', () => {
    withFile(
      [JSON.stringify(okRecord), JSON.stringify(failedRecord), JSON.stringify(bareTrace)],
      (file) => {
        const out = run(['harvest', file, '--failed']);
        assert.equal(out.match(/client: scriptedClient\(\[/g).length, 1);
        assert.ok(out.includes('name: "harvest-run-bad",'));
        assert.match(out, /仅失败/);
      },
    );
  });

  it('--limit 限制条数（先过滤再截断）', () => {
    withFile(
      [JSON.stringify(okRecord), JSON.stringify(failedRecord), JSON.stringify(bareTrace)],
      (file) => {
        const out = run(['harvest', file, '--limit', '2']);
        assert.equal(out.match(/client: scriptedClient\(\[/g).length, 2);
        assert.ok(out.includes('harvest-run-ok'));
        assert.ok(out.includes('harvest-run-bad'));
        assert.ok(!out.includes('harvest-run-bare'));
      },
    );
  });

  it('--out 写文件（stdout 只给摘要）；文件内容关键片段齐全', () => {
    withFile([JSON.stringify(okRecord)], (file, dir) => {
      const target = join(dir, 'harvested.eval.ts');
      const out = run(['harvest', file, '--out', target]);
      assert.match(out, /已写出 .+harvested\.eval\.ts：1 个用例骨架/);
      const content = readFileSync(target, 'utf8');
      assert.match(content, /import \{ defineEval, scriptedClient \} from '@migor\/agentia';/);
      assert.ok(content.includes('name: "harvest-run-ok",'));
      assert.ok(content.includes('"id": "tu_a1"'));
    });
  });

  it('无法解析的行被跳过并在头部注释计数，不炸', () => {
    withFile([JSON.stringify(okRecord), 'oops'], (file) => {
      const out = run(['harvest', file]);
      assert.match(out, /跳过无法解析 1 行/);
      assert.ok(out.includes('harvest-run-ok'));
    });
  });

  it('缺参数 / 文件不存在 / 没有可识别 trace / 坏 flag → 非零退出 + 说明', () => {
    assert.throws(
      () => run(['harvest']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /用法：agentia harvest/);
        return true;
      },
    );
    assert.throws(
      () => run(['harvest', '/tmp/definitely-not-here.jsonl']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /读不到文件/);
        return true;
      },
    );
    withFile(['{"nope":1}'], (file) => {
      assert.throws(
        () => run(['harvest', file]),
        (e) => {
          assert.equal(e.status, 1);
          assert.match(String(e.stderr), /没有可识别的 trace/);
          return true;
        },
      );
    });
    withFile([JSON.stringify(okRecord)], (file) => {
      assert.throws(
        () => run(['harvest', file, '--limit', '0']),
        (e) => {
          assert.equal(e.status, 1);
          assert.match(String(e.stderr), /--limit 需要一个正整数/);
          return true;
        },
      );
    });
  });

  it('--help 里列出 harvest', () => {
    assert.match(run(['--help']), /agentia harvest <trace\.jsonl>/);
  });

  it('CLI 生成器与框架 harvestEvalCase 逐字相等（移植漂移对拍，七组夹具）', async () => {
    if (!distReadyOrLoud(FW_HARVEST, '框架构建产物')) return; // 本地未 build：醒目警告后跳过
    const { harvestEvalCase: fwHarvest } = await import(FW_HARVEST);
    const { harvestEvalCase: cliHarvest } = await import(CLI_HARVEST);
    const cases = [
      [
        '无子 agent 的单工具 run',
        {
          trace: traceSingleTool,
          messages: [{ role: 'user', content: '帮我查下北京天气' }],
          name: 'harvest-run-single',
          source: 'online.jsonl',
        },
      ],
      [
        '子 agent 嵌套回合（嵌套回合只进注释不进脚本）',
        {
          trace: traceNested,
          messages: [{ role: 'user', content: '调研一下竞品' }],
          name: 'harvest-run-nested',
          source: 'online.jsonl',
        },
      ],
      [
        '失败 run（无 messages → input 占位分支）',
        { trace: traceFailed, name: 'harvest-run-failed', source: 'online.jsonl' },
      ],
      [
        '多回合交替（块形态 messages）',
        {
          trace: traceMulti,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '第一句' },
                { type: 'text', text: '第二句' },
              ],
            },
          ],
          name: 'harvest-run-multi',
        },
      ],
      [
        '缺 tool_use_id / 非 JSON input 的老 trace',
        {
          trace: traceLegacy,
          messages: [{ role: 'user', content: '老输入' }],
          name: 'harvest-run-legacy',
        },
      ],
      [
        '无主循环回合（空脚本分支）',
        {
          trace: traceNoTurns,
          messages: [{ role: 'user', content: 'go' }],
          name: 'harvest-run-empty',
        },
      ],
      [
        '开了 traceContent 的 run（assistant 文本取 output.text 真值）',
        {
          trace: {
            traceId: 'run-text',
            rootSpanId: 's0',
            status: 'ok',
            spans: [
              {
                spanId: 's0',
                parentSpanId: null,
                kind: 'run',
                name: 'agent.run',
                startedAt: 0,
                endedAt: 30,
                status: 'ok',
                attributes: {},
                events: [],
              },
              {
                spanId: 't1',
                parentSpanId: 's0',
                kind: 'llm.turn',
                name: 'claude-opus-5',
                startedAt: 10,
                status: 'ok',
                attributes: { 'output.text': '我先查一下。' },
                events: [
                  {
                    time: 11,
                    name: 'tool.input',
                    body: { tool: 'search', tool_use_id: 'tu_1', input: '{"q":"x"}' },
                  },
                ],
              },
              {
                spanId: 't2',
                parentSpanId: 's0',
                kind: 'llm.turn',
                name: 'claude-opus-5',
                startedAt: 20,
                status: 'ok',
                attributes: { 'output.text': '查到了：晴。' },
                events: [],
              },
            ],
          },
          messages: [{ role: 'user', content: '查天气' }],
          name: 'harvest-run-text',
        },
      ],
    ];
    for (const [label, args] of cases) {
      assert.equal(
        cliHarvest(args),
        fwHarvest(args),
        `夹具「${label}」：CLI 移植副本与框架 harvestEvalCase 漂移了 —— packages/cli/src/harvest.ts 是逐行移植，改生成格式要两边同步`,
      );
    }
  });
});
