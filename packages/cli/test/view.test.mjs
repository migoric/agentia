import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/**
 * `agentia view` —— 落盘 trace → 单文件自包含 HTML（2026-10-16 ref-view-single-file-html）。
 *
 * 钉的是这个**形态**的三条硬约束，缺一条就不是「单文件自包含」：
 *   ① 零外链（内联 bundle + CSS，双击可开、转发即完整）
 *   ② 无残留 `export`（普通 `<script>` 里有 export 是 SyntaxError ⇒ 整页白屏）
 *   ③ trace 内联必须转义 `<`（否则 trace 里一个 `</script>` 就能注入脚本 —— trace 含模型
 *      输出，等于不可信输入）
 * 外加「默认脱敏」与「截断必须明说」两条：前者是产物的默认命运（被转发）决定的，
 * 后者是本仓对「静默少给」的一贯红线。
 */

const DIST = fileURLToPath(new URL('../dist/view.js', import.meta.url));
let viewCommand = null;
let redactTrace = null;
let REDACT_PRESETS = null;
if (distReadyOrLoud(DIST, 'packages/cli/dist/view.js ')) {
  ({ viewCommand } = await import(new URL('../dist/view.js', import.meta.url).href));
  ({ redactTrace, REDACT_PRESETS } = await import(
    new URL('../dist/redact.js', import.meta.url).href
  ));
}
const SKIP = !viewCommand ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

/** 捕获 console.log / console.error（本命令的产物是文件，提示都在 stdout/stderr） */
function captureConsole() {
  const logs = [];
  const errs = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  return {
    logs,
    errs,
    restore() {
      console.log = ol;
      console.error = oe;
    },
  };
}

/** 一条够用的 trace：run 根 + 一个 llm.turn，事件体里塞敏感串与注入串 */
function makeTrace(id, tail = '') {
  return {
    traceId: id,
    rootSpanId: 's0',
    status: 'succeeded',
    totalUsage: { inputTokens: 10, outputTokens: 5 },
    spans: [
      {
        spanId: 's0',
        kind: 'run',
        name: `demo${tail}`,
        startedAt: 1,
        endedAt: 3,
        attributes: {},
        events: [],
      },
      {
        spanId: 's1',
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 1,
        endedAt: 2,
        attributes: {},
        events: [
          {
            name: 'tool.output',
            body: {
              content:
                'Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAA password=hunter2 ' +
                '</script><script>alert(1)</script>',
              secret: 'field-level-should-vanish',
            },
          },
        ],
      },
    ],
  };
}

/** ⚠️ 必须 async 且 await 回调：同步 `finally` 会在 async 回调 resolve **之前** rmSync，
 *  于是命令读文件时目录已被删（ENOENT），而且报的是「读不到文件」—— 极像被测代码的 bug。 */
async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-view-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('view 形态闸（单文件自包含）', { skip: SKIP }, () => {
  it('产物零外链 + 内联了 CSS 与 bundle', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(src, `${JSON.stringify(makeTrace('t-1'))}\n`);
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out]);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      // 零外链：不许有任何 http(s) 引用、<link>、外链 <script src>
      assert.equal(
        /(?:src|href)\s*=\s*["']https?:/.test(html),
        false,
        '产物出现外链引用 ⇒ 不是自包含（离线打不开 / 转发后残缺）',
      );
      assert.equal(/<link[^>]+href/.test(html), false, '产物不该有 <link>（CSS 必须内联）');
      assert.equal(
        /<script[^>]+src=/.test(html),
        false,
        '产物不该有外链 <script>（bundle 必须内联）',
      );
      // 内联真的发生了（防真空变绿：不是因为没找到可内联的东西）
      assert.ok(html.includes('.tr-row') || html.includes('tr-row'), 'CSS 没内联进来');
      assert.ok(html.includes('createTraceView'), 'bundle 没内联进来');
      assert.ok(
        cap.logs.some((l) => /单文件自包含/.test(l)),
        `stdout 应说明产物形态，实际：${cap.logs}`,
      );
    });
  });

  it('内联的 bundle 里没有残留 export（普通 <script> 里有 export = 整页白屏）', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(src, `${JSON.stringify(makeTrace('t-1'))}\n`);
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out]);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.equal(
        /^\s*export\s*\{/m.test(html),
        false,
        'bundle 的 export 没剥干净 —— 普通 <script> 里 export 是 SyntaxError（整页白屏）',
      );
    });
  });
});

describe('view 防注入闸', { skip: SKIP }, () => {
  it('trace 里的 </script> 被转义，不能闭合脚本块', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(src, `${JSON.stringify(makeTrace('t-1'))}\n`);
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out, '--raw']); // --raw：连脱敏都不改原文，单测转义本身
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.equal(
        html.includes('</script><script>alert(1)</script>'),
        false,
        'trace 里的 </script> 未转义 ⇒ 提前闭合脚本块，其后内容按 HTML 解析（任意脚本注入）',
      );
      assert.ok(html.includes('\\u003c/script>'), '`<` 应被转义成 \\u003c（JSON 解析后仍是 `<`）');
    });
  });
});

describe('view 脱敏闸', { skip: SKIP }, () => {
  it('默认脱敏：值内凭证被替换，且 banner 说清覆盖什么', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(src, `${JSON.stringify(makeTrace('t-1'))}\n`);
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out]);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.ok(/REDACTED:/.test(html), '默认应脱敏（凭证形态被替换成带类别标签的文案）');
      assert.equal(
        /sk-ant-api03-AAAAAAAAAAAAAAAAAAAA/.test(html),
        false,
        '默认产物里不该有 API key 原文',
      );
      assert.ok(/已脱敏/.test(html), '产物应可见地标「已脱敏」');
      assert.ok(/best-effort/.test(html), '必须明说是 best-effort');
      // 「已脱敏」不能写成一句空话：要把覆盖的类名摆出来，否则读者无从判断自己的字段在不在内
      assert.ok(/bearer/.test(html), 'banner 应列出实际覆盖的预设名');
    });
  });

  it('--raw 不脱敏，且 stderr 出声 + 产物打水印', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(src, `${JSON.stringify(makeTrace('t-1'))}\n`);
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out, '--raw']);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.ok(/sk-ant-api03-AAAAAAAAAAAAAAAAAAAA/.test(html), '--raw 应保留原文');
      assert.ok(
        cap.errs.some((l) => /未脱敏/.test(l)),
        `--raw 必须在 stderr 出声（转发前警告），实际 stderr：${cap.errs}`,
      );
      assert.ok(/未脱敏/.test(html), '--raw 产物要打水印');
    });
  });

  it('--redact-key 按字段名整字段抹平（不看值）', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(src, `${JSON.stringify(makeTrace('t-1'))}\n`);
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out, '--redact-key', 'secret']);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.equal(
        html.includes('field-level-should-vanish'),
        false,
        '--redact-key 命中的字段应整字段抹成 [REDACTED]',
      );
      assert.ok(/\[REDACTED\]/.test(html) || /\[REDACTED:/.test(html));
    });
  });
});

describe('view 截断 / 过滤闸', { skip: SKIP }, () => {
  it('--limit 截断必须明说（stdout + 产物各一处）', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(
        src,
        `${JSON.stringify(makeTrace('t-1'))}\n${JSON.stringify(makeTrace('t-2'))}\n${JSON.stringify(makeTrace('t-3'))}\n`,
      );
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out, '--limit', '1']);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.ok(
        cap.logs.some((l) => /只含前 1 条/.test(l)),
        `截断必须在 stdout 明说（静默少给是本仓红线），实际：${cap.logs}`,
      );
      assert.ok(/只含前 1 条/.test(html), '产物里也要标（看报告的人只看 HTML）');
      assert.equal(/t-2/.test(html), false, '超出的 trace 不该进产物');
    });
  });

  it('--trace-id 只留命中的那条；不存在就报错', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(
        src,
        `${JSON.stringify(makeTrace('t-1'))}\n${JSON.stringify(makeTrace('t-2'))}\n`,
      );
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out, '--trace-id', 't-2']);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.equal(/t-1/.test(html), false, '不该含未选中的 trace');
      assert.ok(/t-2/.test(html));

      await assert.rejects(
        viewCommand([src, '-o', out, '--trace-id', 'nope']),
        /没有 traceId 为 nope/,
        '选了不存在的 id 要响亮报错，不能静默产出空页面',
      );
    });
  });

  it('同一 traceId 多行（append-only 落盘）只算一条', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 't.jsonl');
      const out = join(dir, 'o.html');
      writeFileSync(
        src,
        `${JSON.stringify(makeTrace('same'))}\n${JSON.stringify(makeTrace('same', '-v2'))}\n`,
      );
      const cap = captureConsole();
      try {
        await viewCommand([src, '-o', out]);
      } finally {
        cap.restore();
      }
      const html = readFileSync(out, 'utf8');
      assert.ok(/1 条 trace/.test(cap.logs.join('\n')), `应去重成 1 条，实际：${cap.logs}`);
      assert.ok(/demo-v2/.test(html), '去重留最后一行（与 report 同口径）');
    });
  });
});

describe('view 入参闸', { skip: SKIP }, () => {
  it('缺文件 / 文件不存在 / 无 trace / 未知参数 → 报错', async () => {
    await assert.rejects(viewCommand([]), /用法/, '不给文件要打用法');
    await assert.rejects(viewCommand(['/nope/x.jsonl']), /读不到文件/);
    await assert.rejects(viewCommand(['--bogus', 'x.jsonl']), /未知参数/);
    await withTmp(async (dir) => {
      const src = join(dir, 'empty.jsonl');
      writeFileSync(src, 'not json\n');
      await assert.rejects(viewCommand([src, '-o', join(dir, 'o.html')]), /没有可识别的 trace/);
    });
  });

  it('无 -o 时默认写到 <输入名去扩展名>.html', async () => {
    await withTmp(async (dir) => {
      const src = join(dir, 'traces.jsonl');
      writeFileSync(src, `${JSON.stringify(makeTrace('t-1'))}\n`);
      const cap = captureConsole();
      try {
        await viewCommand([src]);
      } finally {
        cap.restore();
      }
      assert.ok(
        cap.logs.some((l) => /traces\.html/.test(l)),
        `默认产物名应基于输入文件名，实际：${cap.logs}`,
      );
    });
  });
});

describe('CLI 脱敏预设与 examples/observability 同源（源码级对拍，不进 SKIP 闸）', () => {
  it('REDACT_PRESETS 数组字面量逐字相等', () => {
    const cliSrc = readFileSync(new URL('../src/redact.ts', import.meta.url), 'utf8');
    const exSrc = readFileSync(
      new URL('../../../examples/observability/src/index.ts', import.meta.url),
      'utf8',
    );
    const pick = (s) => s.match(/REDACT_PRESETS = \[[\s\S]*?\] as const/)?.[0];
    const a = pick(cliSrc);
    const b = pick(exSrc);
    assert.ok(a, 'packages/cli/src/redact.ts 里没找到 REDACT_PRESETS（防真空变绿）');
    assert.ok(b, 'examples/observability/src/index.ts 里没找到 REDACT_PRESETS（防真空变绿）');
    assert.equal(
      a,
      b,
      'CLI 的脱敏预设与 examples/observability 漂移了 —— 两边必须同步（脱敏覆盖面不一致 = 说不清哪边是真口径）',
    );
  });
});

describe('redactTrace 单元（纯函数）', { skip: SKIP }, () => {
  it('返回副本，不改入参（其余消费者仍拿得到原文）', () => {
    const t = makeTrace('t-1');
    const snapshot = JSON.stringify(t);
    redactTrace(t);
    assert.equal(JSON.stringify(t), snapshot, 'redactTrace 不得改动入参');
  });

  it('presets: false ⇒ 一个预设都不用（原样返回）', () => {
    const out = redactTrace(makeTrace('t-1'), { presets: false });
    assert.ok(JSON.stringify(out).includes('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'));
  });

  it('REDACT_PRESETS 仍是 6 类（新增/删除预设要同步 examples 与文档）', () => {
    assert.equal(REDACT_PRESETS.length, 6);
  });
});
