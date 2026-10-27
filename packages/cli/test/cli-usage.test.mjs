import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错），同 report.test.mjs 的约定。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SKIP = !existsSync(CLI) ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
if (SKIP) distReadyOrLoud(CLI, 'CLI 构建产物');

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

/** 一条最小可 harvest 的 trace（run 根 + 一个带 tool.input 的 llm.turn） */
const TRACE = {
  traceId: 'r1',
  rootSpanId: 's0',
  status: 'ok',
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
    {
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
    },
  ],
};

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-cli-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CLI 用法与错误路径', { skip: SKIP }, () => {
  it('子命令 --help 打出该命令的用法（此前会被当成要读的文件名）', () => {
    for (const cmd of [
      'create',
      'g',
      'dev',
      'doctor',
      'report',
      'harvest',
      'diff',
      'export',
      'add',
    ]) {
      const r = run([cmd, '--help'], tmpdir());
      assert.equal(r.status, 0, `agentia ${cmd} --help 退出码应为 0（stdout=${r.stdout}）`);
      assert.match(r.stdout, /^用法：agentia /m, `agentia ${cmd} --help 应打出用法`);
      assert.equal(r.stderr, '', `agentia ${cmd} --help 不应报错`);
    }
  });

  it('create 帮助暴露 --minimal，顶层帮助按任务分组', () => {
    const create = run(['create', '--help'], tmpdir());
    assert.equal(create.status, 0);
    assert.match(create.stdout, /\[--minimal\]/);

    const all = run(['--help'], tmpdir());
    assert.equal(all.status, 0);
    for (const group of ['核心工作流', '观测与调优', '评测与数据', '能力包与其他']) {
      assert.ok(all.stdout.includes(group), `帮助缺命令分组：${group}`);
    }
    assert.match(all.stdout, /默认完整服务；--minimal = 单文件 \+ 裸工具/);
  });

  it('create：目标路径是普通文件 → 可读报错，而不是裸 ENOTDIR 栈', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 'my-app'), 'not a directory');
      const r = run(['create', 'my-app'], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /已存在且不是目录/);
      assert.ok(!r.stderr.includes('ENOTDIR'), `不该漏出原始 ENOTDIR：${r.stderr}`);
    });
  });

  it('harvest：--out 指向已存在文件默认拒绝覆盖（--force 才写）', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 't.jsonl'), `${JSON.stringify(TRACE)}\n`);
      const kept = '// 我手改过的断言：expect(x).toBe(1)\n';
      writeFileSync(join(dir, 'cases.ts'), kept, 'utf8');

      const refused = run(['harvest', 't.jsonl', '--out', 'cases.ts'], dir);
      assert.equal(refused.status, 1, `应拒绝覆盖（stdout=${refused.stdout}）`);
      assert.match(refused.stderr, /已存在/);
      assert.equal(
        readFileSync(join(dir, 'cases.ts'), 'utf8'),
        kept,
        '人工核对过的产物必须原样保留',
      );

      const forced = run(['harvest', 't.jsonl', '--out', 'cases.ts', '--force'], dir);
      assert.equal(forced.status, 0, `--force 应放行（stderr=${forced.stderr}）`);
      assert.ok(
        !readFileSync(join(dir, 'cases.ts'), 'utf8').includes('我手改过'),
        '--force 后才是真正重写',
      );
    });
  });

  it('harvest：trace 里没有 llm.turn 时不写坏产物（保持可读报错）', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 'bad.jsonl'), 'not json\n');
      const r = run(['harvest', 'bad.jsonl', '--out', 'out.ts'], dir);
      assert.equal(r.status, 1);
      assert.ok(!existsSync(join(dir, 'out.ts')), '失败时不该留下产物文件');
    });
  });
  it('--version / -v 报出包版本（单源：读本包 package.json，不另存常量）', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    );
    for (const flag of ['--version', '-v']) {
      const r = run([flag], tmpdir());
      assert.equal(r.status, 0, `${flag} 退出码应为 0（stderr=${r.stderr}）`);
      assert.equal(r.stdout.trim(), pkg.version, `${flag} 应报出包版本`);
      assert.equal(r.stderr, '', `${flag} 不该往 stderr 写东西`);
    }
  });

  it('report --json：stdout 只有一个 JSON 文档，人类表格不再出现', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 't.jsonl'), `${JSON.stringify(TRACE)}\n`, 'utf8');

      const human = run(['report', 't.jsonl'], dir);
      assert.equal(human.status, 0);
      assert.match(human.stdout, /trace 文件/, '缺省仍是人类可读输出');

      const r = run(['report', 't.jsonl', '--json'], dir);
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      const j = JSON.parse(r.stdout); // 能整段解析 = stdout 里只有 JSON
      assert.equal(j.runs, 1);
      assert.equal(j.file, 't.jsonl');
      assert.equal(typeof j.totals.totalMs, 'number');
      assert.ok(Array.isArray(j.capabilities));
      assert.ok(!r.stdout.includes('trace 文件'), 'JSON 模式不该夹人类装饰');
    });
  });

  it('diff --json：等价退出 0、有差异退出 1（脚本仍可拿退出码当门禁），差异本身可读', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 'a.jsonl'), `${JSON.stringify(TRACE)}\n`, 'utf8');
      writeFileSync(join(dir, 'b.jsonl'), `${JSON.stringify(TRACE)}\n`, 'utf8');

      const same = run(['diff', 'a.jsonl', 'b.jsonl', '--json'], dir);
      assert.equal(same.status, 0, `等价应退出 0（stderr=${same.stderr}）`);
      assert.equal(JSON.parse(same.stdout).equal, true);

      const changed = JSON.parse(JSON.stringify(TRACE));
      changed.spans[1].status = 'error';
      writeFileSync(join(dir, 'c.jsonl'), `${JSON.stringify(changed)}\n`, 'utf8');

      const diff = run(['diff', 'a.jsonl', 'c.jsonl', '--json'], dir);
      assert.equal(diff.status, 1, '有差异必须仍是退出码 1 —— --json 只改输出形状，不改语义');
      const j = JSON.parse(diff.stdout);
      assert.equal(j.equal, false);
      assert.equal(j.spans[0].path, 'run:agent.run/llm.turn#0');
      assert.equal(j.spans[0].missing, null);
      assert.deepEqual(j.spans[0].fields, [{ field: 'status', a: 'ok', b: 'error' }]);
    });
  });

  it('doctor --json：体检结果结构化（无人类横幅），错误仍退出 1', () => {
    withTmp((dir) => {
      const empty = run(['doctor', '--json'], dir);
      assert.equal(empty.status, 0, `stderr=${empty.stderr}`);
      const j = JSON.parse(empty.stdout);
      assert.ok(Array.isArray(j.ok) && Array.isArray(j.warnings) && Array.isArray(j.errors));
      assert.equal(j.summary.warnings, j.warnings.length);
      assert.equal(j.summary.errors, j.errors.length);
      assert.ok(j.warnings.length > 0, '空目录下应有「分类目录不存在」的警告');
      assert.ok(!empty.stdout.includes('装配体检'), 'JSON 模式不该有人类横幅');
    });
  });

  it('--json 下出错仍走 stderr + 退出码 1（stdout 为空，脚本据此区分「没跑成」）', () => {
    withTmp((dir) => {
      const r = run(['report', 'nope.jsonl', '--json'], dir);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '', 'stdout 必须为空 —— 否则脚本会把错误当结果解析');
      assert.match(r.stderr, /错误：/);
    });
  });
});
