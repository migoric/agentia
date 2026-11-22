import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './lib/source-scan.js';

/*
 * 架构守卫 —— **文件级「运行期无环」**（2026-09-28，第 4 件「结构收口」）。
 *
 * 为什么需要它：`layering.test.ts` 只守**层间**（`layerOf()` 取路径第一段），
 * **层内环是盲区** —— 同一个 `src/<layer>/` 里两个文件互相 import 它一条边都看不见。
 * 实测 src 有**三条**文件级 SCC，全在层内：`runtime/context ↔ run`、`engine/mcp-server
 * ↔ mcp-server-{stdio,http}`（两者回边都是 `import type`，运行期擦除 ⇒ 无害），
 * 以及 `integrations/mcp ↔ mcp-{stdio,http}`（**真实的值环**，靠 ESM 函数提升侥幸无恙，
 * 已由本次抽出 `mcp-protocol.ts` 断开）。
 *
 * 口径（**为什么只算「值边」**）：类型导入运行期擦除，**不构成运行期环** ——
 * 别把「编译期有一条 `import type` 回边」报成「循环依赖」（`docs/guards.md` 同款纪律）。
 * 所以本守卫只统计**值边**（会留在产物里的运行期依赖），断言其**无环**。它同时兜住两件事：
 *   ① 新增一条**运行期**环 ⇒ 红；
 *   ② 把某条 `import type` 回边**改成值导入**（真实值环就此产生）⇒ 红。
 *
 * 说明符的读取**复用 `lib/source-scan.ts` 的 `scan()`**（它逐字遮蔽注释 / 字符串 / 模板 /
 * 正则）—— 千万别换成裸正则：文档注释里写出 `from './x.js'` 会**凭空造一条边**
 * （2026-09-28 实际踩过，见 `mcp-protocol.ts` 头注）。
 *
 * ⚠️ **类型级环不在这条断言的射程里，但不是没人管**（2026-11-22 补）：上面只算值边 ⇒
 * `import type` 的环可以随便长，而两个文件互相 `import type` 正是本仓最省事的写法。
 * 它们由文件末那条「**清单预算**」断言单独看着 —— 全边图（含 `import type`）的每个
 * 强连通分量都必须登记在 `TYPE_ONLY_CYCLES` 里并写明为什么无害；新增一对要表态、
 * 删掉一对也要改表（表不许变成假账）。两套口径**各自都有自证**，别把其中一条删掉。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(repoRoot, 'src');

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/**
 * 这条说明符所属语句是不是 **type-only**（`import type …` / `export type …` /
 * `import { type A, type B } …`）。
 *
 * `masked` 是 `scan()` 遮蔽过注释与字符串的文本 —— 可以安全地按正则找语句头。
 * `quoteIdx` = 说明符**开引号**的下标。
 */
function isTypeOnlyStatement(masked: string, quoteIdx: number): boolean {
  // 最近的、位于行/语句边界的 `import` / `export` 关键字 —— 取**最后**一次匹配
  // （用无 `$` 的正则逐条推进；带 `[\s\S]*$` 的话第一次匹配就吞到末尾，永远只剩第一条）
  const headRe = /(?:^|[\n;])\s*(?:import|export)\b/g;
  let bodyStart = -1;
  for (const mm of masked.slice(0, quoteIdx).matchAll(headRe)) {
    bodyStart = (mm.index ?? 0) + mm[0].length;
  }
  if (bodyStart < 0) return false;
  const body = masked.slice(bodyStart, quoteIdx);
  if (/^\s+type\b/.test(body)) return true; // import type / export type
  const brace = body.match(/\{([\s\S]*)\}/); // import { type A, type B }
  if (brace) {
    const names = brace[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length > 0 && names.every((n) => /^type\b/.test(n))) return true;
  }
  return false;
}

/**
 * 相对导入里**运行期会真的发生**的说明符（值边）。type-only 一律排除。
 *
 * 形态与 `source-scan.ts` 的说明符判定对齐（它已排除注释 / 字符串里的假 `from 'x'`）：
 *   ① `from './x.js'`（含 `export … from`）—— 非 `type` 才算值边；
 *   ② 副作用 `import './x.js'` —— 值边；
 *   ③ `import('./x.js')` —— `import('./x').T` 是**内联类型**（后随 `.`）⇒ 排除；
 *      `await import('./x')` 是运行期动态导入 ⇒ 值边。
 */
function relativeSpecs(src: string, includeTypeOnly: boolean): string[] {
  const { masked, specs } = scan(src);
  const out: string[] = [];
  for (const { spec, index } of specs) {
    if (!spec.startsWith('.')) continue;
    const quoteIdx = index - 1;
    if (quoteIdx < 0) continue;
    // 开引号前最近的非空白字符
    let k = quoteIdx - 1;
    while (k >= 0 && /\s/.test(masked[k] as string)) k -= 1;
    const prev = k >= 0 ? (masked[k] as string) : '';
    if (prev === '(') {
      // 动态 / 内联：闭引号后有 `)`，再后随 `.` ⇒ 内联类型（类型边）
      const afterParen = index + spec.length + 2;
      if (masked[afterParen] === '.') continue;
      out.push(spec);
      continue;
    }
    if (!includeTypeOnly && isTypeOnlyStatement(masked, quoteIdx)) continue;
    out.push(spec);
  }
  return out;
}

/** 值边（运行期真的会发生的依赖）—— 无环断言用 */
function valueSpecs(src: string): string[] {
  return relativeSpecs(src, false);
}

/** 全边（含 `import type`）—— 类型级环的**清单**断言用（见文件末那个 describe） */
function allSpecs(src: string): string[] {
  return relativeSpecs(src, true);
}

/** 相对来源 → src 内实际文件（补 .js→.ts、index.ts）；解析不到返回 null */
function resolveTarget(fromAbs: string, spec: string): string | null {
  let t = resolve(dirname(fromAbs), spec);
  if (t.endsWith('.js')) t = `${t.slice(0, -3)}.ts`;
  for (const c of [t, `${t}.ts`, join(t, 'index.ts')]) if (existsSync(c)) return c;
  return null;
}

const files = walkTs(SRC);

/** 文件 → 它的**值边**邻居（仅 src 内） */
const valueEdges = new Map<string, Set<string>>();
/** 文件 → 它的**全边**邻居（值边 + `import type`；仅 src 内） */
const allEdges = new Map<string, Set<string>>();
/** `解析不到` 的相对值边（指向 src 之外 —— 与 layering 守卫的红线一致） */
const outside: string[] = [];
let valueEdgeCount = 0;

/** 说明符 → src 内目标（解析不到的只对值边记账：类型边指向 src 外不算「层内环」的输入） */
function targetsOf(fromAbs: string, specs: string[]): { tos: Set<string>; missing: string[] } {
  const tos = new Set<string>();
  const missing: string[] = [];
  for (const spec of specs) {
    const tgt = resolveTarget(fromAbs, spec);
    if (tgt === null) {
      missing.push(spec);
      continue;
    }
    if (tgt !== fromAbs) tos.add(tgt);
  }
  return { tos, missing };
}

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const all = targetsOf(f, allSpecs(src));
  allEdges.set(f, all.tos);
  // 只有**值边**才把「解析不到」报成红线：类型边指向 src 外（如 tests 里的类型）不构成环的输入
  const val = targetsOf(f, valueSpecs(src));
  for (const spec of val.missing) outside.push(`${relative(repoRoot, f)}  →  ${spec}`);
  valueEdges.set(f, val.tos);
  valueEdgeCount += val.tos.size;
}

/** Tarjan：返回节点数 > 1 的强连通分量（= 环）。图由调用方给 —— 值边与全边共用一份实现 */
function cyclesOf(graph: Map<string, Set<string>>): string[][] {
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongConnect = (v: string): void => {
    idx.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop() as string;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) sccs.push(comp);
    }
  };

  for (const v of graph.keys()) if (!idx.has(v)) strongConnect(v);
  return sccs;
}

const found = cyclesOf(valueEdges);

test('真空护栏：真扫到了 src 与足量值边（否则下面的断言全是假绿）', () => {
  assert.ok(files.length >= 90, `只扫到 ${files.length} 个 .ts 文件 —— 路径或 walk 失效`);
  assert.ok(
    valueEdgeCount >= 150,
    `只解析到 ${valueEdgeCount} 条文件内值边 —— 解析器大概率漏了某种形态（无环断言在空转）`,
  );
});

test('文件级**值边**依赖图无环（关掉 layering 的层内环盲区）', () => {
  const report = found.map((comp) => {
    const sorted = comp.map((p) => relative(repoRoot, p)).sort();
    const inner = sorted.map((p) => `      ${p}`).join('\n');
    return `  [${comp.length} 个文件]\n${inner}`;
  });
  assert.deepEqual(
    found,
    [],
    '文件级出现了**运行期**依赖环（type-only 的 import type 回边不算，此处是真值边）——\n' +
      '要么断开（把共享件抽到第三个文件，参照 integrations/mcp-protocol.ts），\n' +
      `要么确认它确实是 import type（本案不该出现在这里）：\n${report.join('\n')}`,
  );
});

test('src 里的相对值边不得跑到 src 之外', () => {
  assert.deepEqual(
    outside,
    [],
    `src 里有相对导入指向 src 之外（分层与打包都会破）：\n${outside.join('\n')}`,
  );
});

test('分类器自证：type-only 回边不算值边，值回边算（合成样本）', () => {
  const sample = `
import { a } from './val.js';
import type { B } from './typ.js';
export { c } from './reexport.js';
export type { D } from './typ-reexport.js';
import { type E, type F } from './all-inline-type.js';
import { G, type H } from './mixed.js';
import './sideeffect.js';
type R = import('./inline-type.js').R;
const dyn = await import('./dynamic.js');
`;
  const got = valueSpecs(sample);
  assert.deepEqual(
    [...new Set(got)].sort(),
    ['./dynamic.js', './mixed.js', './reexport.js', './sideeffect.js', './val.js'],
    'type-only（import type / export type / 全内联 type / 内联类型 import(…)）都不该进值边',
  );
});

test('分类器自证：注释里的导入字面量不算边（scan 遮蔽注释）', () => {
  const sample = `
// 说明：这条 from './ghost.js' 在注释里，不是依赖
/* 块注释里也有 from './ghost2.js' */
import { real } from './real.js';
`;
  assert.deepEqual(
    [...new Set(valueSpecs(sample))],
    ['./real.js'],
    '注释里的导入字面量必须被遮蔽 —— 否则文档会凭空造边',
  );
});

/**
 * ## 类型级环的**清单预算**（2026-11-22）
 *
 * 上面那条断言只算值边 —— 那是**有意**的（`import type` 运行期擦除，不构成运行期环，
 * 报成「循环依赖」是假警）。但口径一窄就留了一条没人看着的缝：**类型级环可以随便长**。
 * 而这正是本仓最容易长出来的一类环 —— 两个文件互相 `import type` 最省事（不用抽第三件），
 * 单次无害，长到几十对之后「谁依赖谁」就说不清了，而那时候想把它们分开成本已经很高。
 *
 * 所以这里给它们一份**清单**而不是一句「允许」：每一对都要登记（文件组合 + 为什么无害），
 * 新增一对 ⇒ 红（必须表态），删掉一对 ⇒ 也红（表要跟着改，否则表会慢慢变成假账）。
 *
 * ⚠️ 判据是**强连通分量的成员集合**，不是边数：同两个文件之间再加一条 `import type`
 * 不改变成员 ⇒ 不红（那是同一对环的加厚，不是新的环）。
 *
 * 登记时的自查两问（现有三条都是这么过的）：① 环上每条边都是 `import type` 吗
 * （有一条值边就该被上面那条断言抓住）？② 它是不是「同一个知识被两个文件各拿一半」——
 * 是的话优先抽第三件，而不是登记在这里。
 */
const TYPE_ONLY_CYCLES: readonly (readonly string[])[] = [
  // 引擎的 MCP 服务端：入口与两个传输实现互相只借类型（工具/会话的形状），运行期靠构造函数注入
  ['engine/mcp-server-http.ts', 'engine/mcp-server-stdio.ts', 'engine/mcp-server.ts'],
  // run 与 context：run 的签名需要 Context 类型，context 的工厂需要 Run 类型（同一个概念的两半）
  ['runtime/context.ts', 'runtime/run.ts'],
  // HTTP 宿主：路由表与端点体互借类型（Route 判定 / HttpCtx），值依赖是单向的
  ['transport/http-endpoints.ts', 'transport/http.ts'],
];

/** 把 SCC 变成可比对的键：文件名排序后拼起来（同一条环的两种遍历顺序必须等价） */
function fingerprintOf(comp: readonly string[]): string {
  return comp
    .map((p) => relative(SRC, p))
    .sort()
    .join(' + ');
}

test('真空护栏：全边图真的比值边图多（否则「类型级环」这条断言在拿同一张图自证）', () => {
  const allCount = [...allEdges.values()].reduce((n, s) => n + s.size, 0);
  assert.ok(
    allCount > valueEdgeCount,
    `全边 ${allCount} 条 ≤ 值边 ${valueEdgeCount} 条 —— 类型边没吃到，下面的清单断言会假绿`,
  );
});

test('类型级环（含 import type 的全边图）只能长成登记过的那几条', () => {
  const actual = cyclesOf(allEdges).map(fingerprintOf).sort();
  const declared = TYPE_ONLY_CYCLES.map((c) => [...c].sort().join(' + ')).sort();
  assert.deepEqual(
    actual,
    declared,
    '类型级环的成员变了。三条路，必须显式选一条：\n' +
      '  ① 断开 —— 把共享的那半抽到第三个文件（本仓做法，见 integrations/mcp-protocol.ts）；\n' +
      '  ② 登记 —— 确认环上每条边都是 `import type`，加进本文件的 TYPE_ONLY_CYCLES 并写一句为什么无害；\n' +
      '  ③ 删掉已不存在的条目 —— 表比实测多也是假账，会让人以为那里还有环。\n' +
      `实测：${JSON.stringify(actual)}\n登记：${JSON.stringify(declared)}`,
  );
});

test('分类器自证：同一段样本里，值边图看不见那条 `import type` 回边、全边图看得见', () => {
  const sample = `
import { run } from './a.js';
import type { B } from './b.js';
export type { C } from './c.js';
`;
  assert.deepEqual(relativeSpecs(sample, false), ['./a.js'], '值边不该含 import type');
  assert.deepEqual(
    [...new Set(relativeSpecs(sample, true))].sort(),
    ['./a.js', './b.js', './c.js'],
    '全边必须含 import type / export type —— 否则类型级环永远扫不出来',
  );
});
