/*
 * 架构守卫 —— AGENTS.md「硬约定 · 分层单向」的**可执行版本**。
 *
 * 为什么需要它：分层约定此前只写在 AGENTS.md 里、没有测试兜底，于是
 * `store → runtime`（未声明的兄弟层依赖）能悄悄存在很久。这里把约定变成断言：
 *
 *   ① 层的依赖边必须落在允许集合内（越权/反向立刻失败）；
 *   ② 依赖图必须无环；
 *   ③ src 不得 import 到 src 之外（tests / packages / examples / scripts）。
 *
 * 新增分层、或有意改变依赖方向时，必须同步改本文件的 ALLOWED 与 AGENTS.md ——
 * 两边不一致会在这里失败（这是设计意图，不是障碍）。
 *
 * 只统计**相对导入**（'./x'、'../y'）。包名（@anthropic-ai/sdk 等）是外部依赖，
 * 不参与分层；类型导入（import type）同样计入 —— 它虽在运行期擦除，但仍是编译期
 * 依赖边，而分层约定管的是编译期依赖。覆盖 `from` / 副作用 / `import('...')` 字面量
 * 三种形式（见 relativeImports），并有「解析计数下限」护栏防止解析器空转时全套断言
 * vacuously 变绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './lib/source-scan.js';

// 本文件在 tests/architecture/ —— 回退两层才是仓库根
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(repoRoot, 'src');

/** src 根下的 index.ts 是公共唯一出口，允许引用任意层 */
const BARREL = 'index';

/**
 * 每层**允许**依赖的下游层（不含自身）。
 * 与 AGENTS.md「分层单向」一字对应：core ← engine ← { runtime, store }，
 * store ← transport，runtime ← toolkit；integrations 只依赖 core；
 * container 与 core 是叶子。
 */
const ALLOWED: Record<string, readonly string[]> = {
  core: [],
  engine: ['core', 'integrations'],
  runtime: ['core', 'engine'],
  store: ['core', 'engine'],
  transport: ['core', 'engine', 'store'],
  integrations: ['core'],
  container: [],
  toolkit: ['container', 'core', 'engine', 'runtime'],
  // AGENTS.md 对 eval 的表述是「依赖 toolkit 与公共面」—— 公共面即 BARREL（src/index.ts）
  eval: ['core', 'engine', 'toolkit', BARREL],
};

const ALL_LAYERS = Object.keys(ALLOWED);

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/**
 * 文件所属层：src/<layer>/x.ts → <layer>；src/index.ts → 'index'（BARREL）。
 * src 根下的**其他**文件不属于任何层 —— 返回文件名本身：它不在 ALLOWED 里，
 * test ① 会按「未登记」挡下。此前任何根下新文件都白嫖 BARREL 豁免（可随意 import
 * 各层、又不必被 index.ts 导出），这条缝已堵上。
 */
function layerOf(abs: string): string {
  const rel = relative(SRC, abs);
  if (rel.includes(sep)) return rel.split(sep)[0];
  return rel === 'index.ts' ? BARREL : rel;
}

/**
 * 相对导入的来源串（'./x.js' / '../y.js'），外部包名不计。覆盖三种形式：
 * ① from 形式：`import ... from './x.js'` / `export ... from './x.js'`；
 * ② 副作用导入：`import './x.js'`（无 from，① 漏它）；
 * ③ 内联类型导入与动态导入的**字面量**：`import('./x.js')` —— 类型位置的
 *    `import('./x.js').T` 与运行时的 `await import('./x.js')` 同形。
 *    只统计相对路径字面量；变量/表达式（如 `import(pathToFileURL(f).href)`）不算 ——
 *    那是运行期拼出来的路径，不是编译期依赖边。
 *
 * 2026-10-13 起改走 `lib/source-scan.ts` 的遮蔽器（与 file-cycles / no-runtime-deps
 * 同一个扫描器）：此前这里是三条裸正则读原始文本，注释 / 模板字符串里写一句
 * `from './x.js'` 就会造出一条假依赖边。
 */
function relativeImports(text: string): string[] {
  return scan(text)
    .specs.map((s) => s.spec)
    .filter((s) => s.startsWith('.'));
}

/** 把相对来源解析成 src 内实际文件（补 .js→.ts、index.ts），解析不到返回 null */
function resolveTarget(fromAbs: string, spec: string): string | null {
  let t = resolve(dirname(fromAbs), spec);
  if (t.endsWith('.js')) t = `${t.slice(0, -3)}.ts`;
  for (const c of [t, `${t}.ts`, join(t, 'index.ts')]) if (existsSync(c)) return c;
  return null;
}

const files = walkTs(SRC);

/** layer → 依赖的层集合 */
const layerEdges: Record<string, Set<string>> = {};
/** 「越界」明细，用于失败信息 */
const outside: string[] = [];
/** 解析到的相对导入总数 —— 「防真空变绿」护栏断言用（见下方测试） */
let parsedCount = 0;

for (const p of files) {
  const from = layerOf(p);
  layerEdges[from] ??= new Set();
  const specs = relativeImports(readFileSync(p, 'utf8'));
  parsedCount += specs.length;
  for (const spec of specs) {
    const tgt = resolveTarget(p, spec);
    if (tgt === null) {
      // 相对导入却解析不到 src 内文件 → 说明指向了 src 之外
      outside.push(`${relative(repoRoot, p)}  →  ${spec}`);
      continue;
    }
    const to = layerOf(tgt);
    if (to !== from) layerEdges[from].add(to);
  }
}

test('出现的每一层都在 AGENTS.md 约定内（新增层必须同步登记）', () => {
  const unknown: string[] = [];
  for (const p of files) {
    const l = layerOf(p);
    if (l === BARREL || l in ALLOWED) continue;
    unknown.push(
      l.endsWith('.ts')
        ? // layerOf 对根下非 index.ts 文件返回文件名 —— 它没有所属层，不能白嫖 BARREL 豁免
          `src/${l}：src 根下只允许 index.ts（公共出口），新文件必须归入某个层目录`
        : `src/${l}/ 是未知层 —— 请在 tests/architecture/layering.test.ts 的 ALLOWED 与 AGENTS.md 里登记它`,
    );
  }
  assert.deepEqual(unknown, [], `发现未登记的分层：\n${unknown.join('\n')}`);
});

test('层间依赖不得越权：每条边都落在允许集合内', () => {
  const violations: string[] = [];
  for (const [from, tos] of Object.entries(layerEdges)) {
    if (from === BARREL) continue; // 出口层允许引用全部
    const allowed = new Set(ALLOWED[from] ?? []);
    for (const to of tos) {
      if (!allowed.has(to))
        violations.push(`${from} → ${to}（${from} 只允许 → {${[...allowed].join(', ')} }）`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `发现未声明的分层依赖（要么改代码，要么同步更新 AGENTS.md 与本测试的 ALLOWED）：\n${violations.join('\n')}`,
  );
});

test('依赖图无环', () => {
  const state = new Map<string, 'gray' | 'black'>();
  const cycles: string[] = [];
  const dfs = (u: string, path: string[]): void => {
    state.set(u, 'gray');
    for (const v of layerEdges[u] ?? []) {
      if (state.get(v) === 'gray') cycles.push([...path, u, v].join(' → '));
      else if (!state.has(v)) dfs(v, [...path, u]);
    }
    state.set(u, 'black');
  };
  for (const n of Object.keys(layerEdges)) if (!state.has(n)) dfs(n, []);
  assert.deepEqual(cycles, [], `分层必须是有向无环图，发现环：\n${cycles.join('\n')}`);
});

test('src 不得 import 到 src 之外（tests / packages / examples / scripts）', () => {
  assert.deepEqual(
    outside,
    [],
    `src 里的相对导入跑到了 src 之外（分层与打包都会破）：\n${outside.join('\n')}`,
  );
});

test('约定表非空且与 src 实际分层一致（防 ALLOWED 写到一半）', () => {
  assert.ok(ALL_LAYERS.length >= 9, 'ALLOWED 少于 9 层 —— 大概率漏登记');
  for (const l of ALL_LAYERS)
    assert.ok(existsSync(join(SRC, l)), `ALLOWED 里的层 src/${l}/ 不存在`);
});

test('解析器真的吃到了足够多的边（防「真空变绿」护栏）', () => {
  // ⚠️ 这是护栏，不是指标：relativeImports 若退化成返回空，上面五条断言会
  // **vacuously 全绿**（没有边 → 没有越权、没有环、没有越界）。当前 src 有 230+
  // 处相对导入；改解析器（或大规模改导入写法）时必须同步核对这个下限 ——
  // 跌破它说明「解析器漏了某种形式」，而不是「代码没有导入了」。
  assert.ok(
    parsedCount >= 100,
    `只解析到 ${parsedCount} 处相对导入 —— 解析器大概率漏了某种导入形式（分层断言在空转）`,
  );
});

test('解析器覆盖副作用导入与动态/内联导入字面量（合成样本）', () => {
  const specs = relativeImports(`
import './polyfill.js';
import def from './a.js';
export { x } from './b.js';
const m = await import('./c.js');
type T = import('./d.js').T;
const u = await import(pathToFileURL(entry).href);
const v = await import(spec);
`);
  assert.deepEqual(
    [...new Set(specs)].sort(),
    ['./a.js', './b.js', './c.js', './d.js', './polyfill.js'],
    'from / 副作用 / 动态与内联字面量都要解析到；变量形式的动态 import 不算',
  );
});

test('现存的内联类型导入实例被看见且判合法（回归钉）', () => {
  // src/engine/types.ts —— import('./tracer.js').TraceRecorder（engine → engine 同层，无跨层边）
  const engineTypes = relativeImports(readFileSync(join(SRC, 'engine', 'types.ts'), 'utf8'));
  assert.ok(engineTypes.includes('./tracer.js'), 'engine/types.ts 的内联类型导入必须被解析到');
  // src/toolkit/module.ts —— import('../runtime/run.js').Run（toolkit → runtime 是允许边）
  const moduleSpecs = relativeImports(readFileSync(join(SRC, 'toolkit', 'module.ts'), 'utf8'));
  assert.ok(
    moduleSpecs.includes('../runtime/run.js'),
    'toolkit/module.ts 的内联类型导入必须被解析到',
  );
  assert.ok(
    ALLOWED.toolkit.includes('runtime'),
    'toolkit → runtime 是 AGENTS.md 声明的允许边（此处失败说明 ALLOWED 被改了）',
  );
});

test('动态 import 的 file URL（变量）不被误记为依赖边', () => {
  // src/toolkit/discover.ts —— await import(pathToFileURL(entry).href)：
  // 目录发现的入口路径是运行期拼出来的，不是编译期依赖边，解析器必须放它过去
  const discoverSpecs = relativeImports(readFileSync(join(SRC, 'toolkit', 'discover.ts'), 'utf8'));
  assert.ok(
    !discoverSpecs.some((s) => s.includes('href') || s.includes('pathToFileURL')),
    `file URL 形式的动态 import 不应被统计：${discoverSpecs.join(', ')}`,
  );
});

test('BARREL 只认 src/index.ts 本身；src 根下其他文件不得白嫖豁免', () => {
  assert.equal(layerOf(join(SRC, 'index.ts')), BARREL);
  const stray = layerOf(join(SRC, 'helper.ts'));
  assert.notEqual(stray, BARREL, 'src 根下的新文件不应落入 BARREL 豁免');
  assert.ok(!(stray in ALLOWED), '它也不在 ALLOWED 里 —— test ① 会按「未登记」挡下');
  assert.equal(layerOf(join(SRC, 'engine', 'loop.ts')), 'engine');
});
