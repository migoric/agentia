/**
 * **常驻文档预算闸**（2026-10-14，对标业界做法里的 `verify-doc-budgets`）。
 *
 * ## 为什么要有它
 *
 * 本仓的「必读集」是**每个贡献者（含 agent）动手前必须读完**的那几份。它此前**只增不减**，
 * 而且没有任何东西拦着 —— 2026-10-14 实测：`AGENTS.md` + `CONTRIBUTING.md` 合计 **45,141
 * 字符**，`docs/guards.md` 一份 **125,310 字符**。上下文预算是**硬的**：必读集每涨一截，
 * 后面的注意力就少一截，症状不是「某条测试红了」，而是「读了却没照做」。
 *
 * ## 两个维度，两个单位（都是「码点」，不是字节）
 *
 * | 维度 | 目标 | 上限 | 口径为什么是它 |
 * |---|---|---|---|
 * | **整份读得完** | `AGENTS.md` / `CONTRIBUTING.md` | 见下表 | 它们是散文，**必须从头读到尾** ⇒ 总长就是成本 |
 * | **单条别写成论文** | `docs/guards.md` 的**表格行** | `MAX_ROW` | 它是注册表，**行数随守卫数增长是设计**（每加一条守卫就该多一行）⇒ 只有**单条**长度才是病灶 |
 *
 * ⚠️ **单位是码点（`[...text].length`），不是字节、也不是行**：
 * 中文一字三字节 ⇒ 按字节设闸会把「多写一行中文」判成「多写三倍内容」，读数没有可比性；
 * 而按**行**设闸对 `docs/guards.md` 完全无效 —— 它 504 行里躺着 125KB，**平均 250 字符/行**，
 * 最长的一行 **3423 字符**（2026-10-14 实测：134 个表格行里 18 行 > 1500）。
 * 换成行数口径的话，把一段证据从「一行」改成「十行」就能白拿九行预算。
 *
 * ## 超了怎么办（两条路，都必须显式）
 *
 * ① **精简 / 指回真源** —— 这是首选。`docs/guards.md` 的行里大量内容与**守卫文件自己的头注**
 *    重复（同一份事实两处副本），删掉那一半、留个指针即可。
 * ② **提上限** —— 可以，改的就是本文件里那个数字 ⇒ review 时一定看得见，而不是悄悄长过去。
 *    提的时候请把**为什么这次值得**写进 PR（本仓纪律：不做「事后不疼」的闸）。
 *
 * ## 刻意不设上限的三类（都不是遗漏）
 *
 * - `docs/spec.md`（**决策日志，只增不改**）：给它设上限等于逼人删历史；
 * - `docs/usage-guide.md`（**参考手册，按需查**，且完备性已由 `boundary-table.test.ts` 守）：给它
 *   设总长天花板会把「补一条已知边界」变成预算审批；
 * - `docs/plans/**` · `docs/reviews/**`（**带日期的快照**，只增不改）：同上。
 *
 * ⇒ 这三类共有的性质是「**它们的长度不是读取成本，而是完备性**」。设闸前先分清这一点，
 * 否则守卫会开始惩罚「把文档写全」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const chars = (text: string): number => [...text].length;

const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * 整份上限（码点）。上限 = 2026-10-14 实测值 + **不足一成**的余量 ——
 * 余量刻意留得小：它是「再来一轮正常迭代就摸到顶」的位置，而摸到顶这件事本身就该有人看一眼。
 * 表格里的**实测值**是「写下时的快照」（会腐烂，别当权威读数用）；判据只用 `max`。
 */
const TOTAL_BUDGET: Array<{ file: string; max: number; measured: string }> = [
  { file: 'AGENTS.md', max: 44000, measured: '41,411（2026-10-14）' },
  { file: 'CONTRIBUTING.md', max: 4200, measured: '3,730（2026-10-14）' },
];

/** `docs/guards.md` 的**单行**上限（码点）。它不设总量上限：行数增长是注册表的设计。 */
const REGISTRY = 'docs/guards.md';
const MAX_ROW = 3600; // 2026-10-14 实测最长 3423 ⇒ 余量不足一成

describe('常驻文档预算：必读集整份读得完，注册表单条别写成论文', () => {
  it('真空护栏：目标文档真的读到了（否则下面的断言全是假绿）', () => {
    assert.ok(
      TOTAL_BUDGET.length >= 2,
      `只登记了 ${TOTAL_BUDGET.length} 份必读文档 —— 必读集被掏空了，或者这张表退化了`,
    );
    for (const { file, measured } of TOTAL_BUDGET) {
      assert.ok(
        chars(read(file)) >= 1000,
        `${file} 只有 ${chars(read(file))} 码点（实测快照写着 ${measured}）—— 要么文件被掏空，要么路径错了`,
      );
    }
    // 承重：注册表那种「一行一份证据」的形状必须在场，否则单行那条断言会空转
    const rows = read(REGISTRY)
      .split('\n')
      .filter((l) => l.startsWith('|'));
    assert.ok(
      rows.length >= 50,
      `从 ${REGISTRY} 只解析到 ${rows.length} 个表格行（预期 ≥ 50）—— 表格形状变了，单行上限已空转`,
    );
  });

  it('必读集整份不得超过预算', () => {
    const over = TOTAL_BUDGET.filter(({ file, max }) => chars(read(file)) > max).map(
      ({ file, max, measured }) =>
        `${file}: ${chars(read(file))} 码点 > 上限 ${max}（实测快照 ${measured}）`,
    );
    assert.deepEqual(
      over,
      [],
      `必读集超出了预算：\n  ${over.join('\n  ')}\n` +
        '  ⇒ 两条路，二选一、**必须显式**：\n' +
        '     ① 精简 —— 首选。这两份是「动手前必须读完」的文档：把细节挪进它指向的那份文档/守卫头注，' +
        '这里只留判据与指针（本仓纪律：能查单源的就别抄）。\n' +
        '     ② 提上限 —— 改本文件里那个数字，并在 PR 里说明这次为什么值得。',
    );
  });

  it(`注册表的单行不得超过 ${MAX_ROW} 码点（一行一份证据，不是一行一篇论文）`, () => {
    const lines = read(REGISTRY).split('\n');
    const over = lines
      .map((l, i) => ({ line: i + 1, len: chars(l) }))
      .filter((r) => r.len > MAX_ROW)
      .sort((a, b) => b.len - a.len);
    assert.deepEqual(
      over.map((r) => `${REGISTRY}:${r.line}  ${r.len} 码点`),
      [],
      `注册表里有行超过了 ${MAX_ROW} 码点 —— 一行写成论文有两个后果：` +
        '（a）读它的人得先读半天才知道这条守什么；（b）它多半把守卫文件自己头注里的话又抄了一遍' +
        '（同一份事实两处副本，正是注册表最该避免的）。\n' +
        '  ⇒ 两条路：① 把长证据留在守卫自己的头注里，这里只写「守什么 / 退化了会怎样」两句；' +
        '② 真的需要这么长时提 MAX_ROW（改本文件），并在 PR 里说明。',
    );
  });
});
