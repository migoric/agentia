/*
 * 架构守卫 —— **run 缺省值的应用点只有一个**（2026-11-22，`RunPolicy` 落地时的配套）。
 *
 * 为什么需要它：`maxTokens ?? DEFAULT_MAX_TOKENS` 这类「取缺省」在改造前有两处
 * （`loop.ts` 装配引擎时一次、`run-config.ts` 记 trace 快照时又一次），`resolveDefaultModel`
 * 甚至三处。它们用的是同一个常量，所以**值不会分叉** —— 这正是它一直没人管的原因。
 * 真正会坏的是**应用点有多个**：谁给其中一处加校验（`maxTokens` 必须为正、`0` 要按
 * `core/limits.ts` 的表解释），另一处不会有，于是同一份配置在一处被拒、在另一处被静默接受。
 *
 * 现在这三条决策只在 `engine/run-config.ts` 的 `resolveRunPolicy` 里各出现一次
 * （设计见 `docs/plans/2026-11-22-runpolicy-value-object.md` §4.5 的审计表）。
 * 本守卫把「各一次」变成断言 —— 单测守不住它：把 `?? DEFAULT_MAX_TOKENS` 抄回 `loop.ts`，
 * 所有行为用例仍然全绿（两处算出同一个值）。
 *
 * ⚠️ 口径：只数**代码**里的出现。注释里写「（`maxTokens ?? DEFAULT_MAX_TOKENS` 那类）」
 * 是解释，不是第二处实现 —— 所以走 `lib/source-scan.ts` 的遮蔽器（注释 / 字符串都抹掉），
 * 而不是裸 grep。那方向与 `single-source-messages.test.ts` 相反（那份要保留字符串、抹注释），
 * 两处各自有自证，别互相借用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './lib/source-scan.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** 缺省决策的真源：每条都必须只在 `owner` 里出现**恰好一次** */
const SINGLE_SOURCE = [
  { token: '?? DEFAULT_MAX_TOKENS', owner: 'engine/run-config.ts' },
  { token: '?? DEFAULT_MAX_ITERATIONS', owner: 'engine/run-config.ts' },
] as const;

/** 只许在 `owner` 里出现的标识符（定义 + 使用都在那一处；别处出现即应用点跑出去了） */
const OWNER_ONLY = [{ token: 'resolveDefaultModel(', owner: 'engine/run-config.ts' }] as const;

const files = walk(SRC);

/** 统计 token 在**代码**里的出现次数（按文件） */
function occurrences(token: string): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  for (const f of files) {
    // masked：注释与字符串被抹成空格，代码原样 —— 注释里的举例不算第二处实现
    const { masked } = scan(readFileSync(f, 'utf8'));
    const count = masked.split(token).length - 1;
    if (count > 0) out.push({ file: relative(SRC, f), count });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

test('真空护栏：真扫到了 src 与缺省真源（否则下面的断言全是假绿）', () => {
  assert.ok(files.length >= 90, `只扫到 ${files.length} 个 .ts —— 路径或 walk 失效`);
  for (const { token, owner } of SINGLE_SOURCE) {
    assert.ok(
      occurrences(token).some((o) => o.file === owner),
      `连 ${owner} 里都没找到 ${token} —— 解析或常量名变了，守卫在空转`,
    );
  }
});

test('每个缺省决策在 src/ 里只出现一次，且落在 run-config.ts', () => {
  for (const { token, owner } of SINGLE_SOURCE) {
    assert.deepEqual(
      occurrences(token),
      [{ file: owner, count: 1 }],
      `${token} 的应用点不止一处。缺省值的解析只许在 ${owner} 的 resolveRunPolicy 里做一次 ——\n` +
        'behavioral 用例抓不到这种重复（两处算同一个值），所以由本守卫拦。\n' +
        '改法：调用方读 `policy.maxTokens` / `policy.maxIterations`，别自己再 `??` 一遍。',
    );
  }
});

test('resolveDefaultModel 只许在 run-config.ts 里被调', () => {
  for (const { token, owner } of OWNER_ONLY) {
    const hits = occurrences(token).filter((o) => o.file !== owner);
    assert.deepEqual(
      hits,
      [],
      `${token} 跑出 ${owner} 了 —— 模型缺省（显式 → env → 内置）的解析只该有一个入口，` +
        '否则某天加一段「模型名白名单校验」就只盖住其中一处。',
    );
  }
});

test('分类器自证：注释里的举例不算，代码里的第二处要算出来', () => {
  // 用 scan 的真实行为自证：同一句话在注释里、在代码里各写一次 ⇒ 只数代码那一处
  const sample = [
    '// 说明：这里以前是 `maxTokens ?? DEFAULT_MAX_TOKENS`，现在搬走了',
    'const a = opts.maxTokens ?? DEFAULT_MAX_TOKENS;',
  ].join('\n');
  const { masked } = scan(sample);
  assert.equal(
    masked.split('?? DEFAULT_MAX_TOKENS').length - 1,
    1,
    '遮蔽器把注释里的举例也算进来了 —— 守卫会误报，注释从此不能举例',
  );
  const two = `${sample}\nconst b = opts.maxTokens ?? DEFAULT_MAX_TOKENS;`;
  assert.equal(
    scan(two).masked.split('?? DEFAULT_MAX_TOKENS').length - 1,
    2,
    '第二处代码没有被数出来 —— 守卫抓不到重复，等于没有',
  );
});
