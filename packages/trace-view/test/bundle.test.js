import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from '../scripts/bundle.mjs';

/**
 * 单文件 bundle 的守卫（2026-10-16，配合 `agentia view` 的单文件自包含 HTML）。
 *
 * 钉的是一件**概念**上的事：bundle **不是第二份渲染器**。
 * 当初把 trace-view 抽成独立包，全部意义就是「官网 playground 与 CLI 面板共用同一份渲染」；
 * 现在多了第三个消费形态（内联进 HTML），如果它是手写的第二份，那份意义就没了。
 * 所以这里守三条：
 *   ① **同源**：导出面与分文件入口逐字一致、每个 src 模块都被拼进来（不许漏）；
 *   ② **确定性**：同样输入两次构建字节相同（产物可被构建重现 ⇒ 不是手改的）；
 *   ③ **可用**：拼完的产物真能被 import、真能渲出一棵树（不是「语法合法」就算过）。
 * 外加两条构建期自检（撞名 / 环）本身也要被验 —— 它们是「别静默产出坏 bundle」的闸。
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** 极简 DOM stub（与 view.test.js 同款思路：只补渲染器真用到的面） */
function makeNode() {
  return {
    className: '',
    textContent: '',
    dataset: {},
    style: {},
    children: [],
    addEventListener() {},
    set innerHTML(v) {
      if (v === '') this.children = [];
    },
    get innerHTML() {
      return '';
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
}

function tempSrc(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tv-bundle-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/**
 * ⚠️ 把 `buildBundle()` 的**当次产出**写成临时文件再 import —— 不能去读 `dist/`：
 * dist 是构建产物，改了 `scripts/bundle.mjs` 不会自动重建它 ⇒ 断言会拿着旧产物
 * 一路变绿（变异验证时实测：摘掉一个导出名，全组 7/0 全绿 —— 守卫是真空的）。
 */
async function importFreshBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'tv-bundle-out-'));
  const file = join(dir, 'bundle.mjs');
  writeFileSync(file, buildBundle(SRC));
  const mod = await import(pathToFileURL(file).href);
  return { mod, dir };
}

const TRACE = {
  traceId: 't1',
  spans: [
    {
      spanId: 's0',
      kind: 'run',
      name: 'demo',
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
      // summary.js 的口径：工具行读 `tool.output` 事件的 body.durationMs / body.ok，
      // 能力名来自 **body.tool**（不是事件顶层）—— 与框架真实落盘同形，缺一项就算出 0 行
      events: [
        { name: 'tool.output', body: { tool: 'mytool', ok: true, durationMs: 5, content: 'ok' } },
      ],
    },
  ],
};

describe('bundle 同源（不是第二份渲染器）', () => {
  it('导出面与分文件入口 src/index.js 逐字一致', async () => {
    const { mod, dir } = await importFreshBundle();
    try {
      const entry = await import(new URL('../src/index.js', import.meta.url).href);
      assert.deepEqual(
        Object.keys(mod).sort(),
        Object.keys(entry).sort(),
        'bundle 的导出面与 src/index.js 不一致 —— 内联 HTML 那一路会拿到不同的渲染器契约',
      );
      assert.ok(Object.keys(mod).length > 0, 'bundle 一个导出都没有（防真空变绿）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('每个 src 模块的顶层声明都进了 bundle（不许漏模块）', () => {
    const bundle = buildBundle(SRC);
    const files = readdirSync(SRC).filter((f) => f.endsWith('.js'));
    assert.ok(files.length >= 4, `src/ 里 .js 模块少于 4 个（${files.length}）—— 断言本身可能失灵`);
    for (const f of files) {
      const code = readFileSync(join(SRC, f), 'utf8');
      const names = [
        ...code.matchAll(
          /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm,
        ),
      ].map((m) => m[1]);
      for (const n of names) {
        assert.ok(
          bundle.includes(n),
          `src/${f} 声明的 "${n}" 没出现在 bundle 里 —— 该模块被漏拼（HTML 里会 ReferenceError）`,
        );
      }
    }
  });

  it('确定性：同样输入两次构建字节相同', () => {
    assert.equal(
      buildBundle(SRC),
      buildBundle(SRC),
      'bundle 构建不确定 —— 产物无法由 src 重现，就谈不上同源',
    );
  });
});

describe('bundle 可用（拼完真能渲）', () => {
  it('真 import bundle 并用 playTrace 渲出一棵树', async () => {
    globalThis.document = { createElement: () => makeNode() };
    globalThis.getSelection = () => '';
    const { mod, dir } = await importFreshBundle();
    try {
      const root = makeNode();
      const view = mod.createTraceView(root, {});
      mod.playTrace(view, TRACE);
      const count = (n) => 1 + n.children.reduce((s, c) => s + count(c), 0);
      assert.ok(count(root) > 3, `渲染出的节点太少（${count(root)}）—— bundle 可能没真跑起来`);
      const rows = mod.summarizeTrace(TRACE);
      assert.ok(rows.length >= 1, `summarizeTrace 应算出能力行，实际 ${rows.length} 行`);
      assert.equal(rows[0].capability, 'tool:mytool', '能力行应来自 body.tool（口径与面板一致）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.document;
      delete globalThis.getSelection;
    }
  });
});

describe('bundle 构建期自检', () => {
  it('顶层撞名 ⇒ 响亮报错（拼进同一作用域是 SyntaxError）', () => {
    const dir = tempSrc({
      'a.js': 'export const dup = 1;\n',
      'b.js': 'export const dup = 2;\n',
    });
    try {
      assert.throws(
        () => buildBundle(dir),
        /dup/,
        '撞名必须报错：否则产物是一整页 SyntaxError（白屏）',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('循环依赖 ⇒ 响亮报错（拼出来会引用到未声明的 const）', () => {
    const dir = tempSrc({
      'a.js': "import { b } from './b.js';\nexport const a = b;\n",
      'b.js': "import { a } from './a.js';\nexport const b = a;\n",
    });
    try {
      assert.throws(() => buildBundle(dir), /循环依赖/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('引用了不存在的模块 ⇒ 报错（别静默产出缺东西的 bundle）', () => {
    const dir = tempSrc({ 'a.js': "import { x } from './nope.js';\nexport const a = x;\n" });
    try {
      assert.throws(() => buildBundle(dir), /不存在的模块/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 「合法 ESM、非法 classic script」整族 —— 2026-10-21 实测：这三种形态**构建成功、
   * ESM import 也通过**（`export default` / `import` 在 ESM 里都是合法语法），而
   * `agentia view` 内联进普通 `<script>` 时整页白屏、CLI 还照样打印「已生成」。
   * 构建期按 classic script 编译一次，把这一族在产物出生前就拦下。
   */
  it('残留 export default ⇒ 构建期报错（内联进普通 <script> 是白屏）', () => {
    const dir = tempSrc({ 'index.js': "export default { name: 'root' };\n" });
    try {
      assert.throws(() => buildBundle(dir), /classic script/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('副作用 import ⇒ 构建期报错（stripModuleSyntax 不剥它，页面会白屏）', () => {
    const dir = tempSrc({
      'index.js': "import './sidecar.js';\nexport const a = 1;\n",
      'sidecar.js': 'globalThis.__side = 1;\n',
    });
    try {
      assert.throws(() => buildBundle(dir), /classic script/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('export * ⇒ 构建期报错（与 export default 同族，同样不剥）', () => {
    const dir = tempSrc({
      'index.js': "export * from './a.js';\n",
      'a.js': 'export const a = 1;\n',
    });
    try {
      assert.throws(() => buildBundle(dir), /classic script/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('真实 src/ 拼出来必须是合法 classic script（防误报：闸不能把正常产物判红）', () => {
    // 构建不抛就是答案 —— 上面三条说明这个闸会咬，这一条说明它不乱咬
    assert.doesNotThrow(() => buildBundle(SRC), '真实 src/ 被闸误判 ⇒ 整个 build 会红（假红）');
  });
});
