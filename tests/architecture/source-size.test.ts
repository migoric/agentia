import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/**
 * **源码体量闸**（2026-09-29，结构体检 `STRUCTURE-INVENTORY-2026-09-29` 建议③）。
 *
 * 为什么要有它：建议①②（改真值 / 抽审批簇）都已落地，但**没有任何东西拦着长回去** ——
 * 结构体检记下的那个斜率是真的：`async.ts` 从 09-20 的 895 行涨到 09-29 的 1929 行
 * （**9 天 +115%**，两天 +525 行），期间「后续抽块」三步一步没走。
 *
 * ## ⚠️ 与报告建议的一处刻意分歧：口径用**代码行**，不是行数
 *
 * 报告原话是「`async.ts ≤ 1600`（行数）」。本仓**注释占 29%~55%**（`async.ts` 55%），
 * 注释是证据载体（记着「判据只挡终态，别写成 `!== 'queued'`，第一版就是这么错的」这类踩坑）。
 * 按「行数」设闸的话，第一个作用是**逼人删注释** —— 那是最贵的资产、而且是**静默**的
 * （删掉注释不影响任何用例）。所以口径必须与注释解耦：**整行注释与空行都不计入**。
 *
 * 顺带一个读数：按行数 1460 < 1600 ⇒ 报告那道闸**当下根本不触发**（是事后不疼的）；
 * 按代码行 664 才是它真正管着的量。
 *
 * ## 上限 750 是怎么来的
 *
 * | 文件 | 代码行 | 备注 |
 * |---|---:|---|
 * | `transport/async.ts` | **627** | 抽走三个监督件（审批 / 事件投递 / 恢复扫描）+ run-outcome 之后（2026-10-13 复算） |
 * | `engine/turn.ts` | 523 | 全仓第二 |
 * | `integrations/openai.ts` | 493 | |
 *
 * 627 与第二名 523 之间隔着一大截 —— 750 是「单文件明显异常」的线：它给 `async.ts`
 * 留约 16% 的正常迭代余量，同时**远离**合法长文件那一档（报告 §2 那批「不该拆」的
 * 大函数，最长 `metrics-render.ts` 也只有 260 行代码）⇒ 不会误伤。
 *
 * 超了怎么办（**只有两条路，都必须显式**）：
 * ① 抽件 —— 把方向正交的一块移出去（本仓既有做法：`slot-pool` / `approval-policy` /
 *    `drain-gate` / `resume-policy` / `task-waiters` / `task-events`，以及 2026-09-29 的
 *    审批监督 / 事件投递 / 恢复扫描三个监督件）；
 * ② 提上限 —— 可以，但改动落在**这个文件**里 ⇒ review 时一定看得见，
 *    而不是悄悄长过去。
 *
 * ## 只量 `src/**`（框架本体）
 *
 * 不含 `tests/**`（用例天然长，且它们不是「被读的代码」）、`scripts/**`、`docs/**`。
 */

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/** 单个源文件的「含代码行」上限（口径见头注：整行注释与空行都不计入） */
const MAX_CODE_LINES = 750;

/** 防真空：`src/**` 的 `.ts` 文件数下限（真值 100+，这里取一个保守的大数） */
const MIN_FILES = 60;

/**
 * 数「含代码的行」：**空行**与**整行注释**不算，其余都算。
 *
 * ⚠️ 刻意**不**用「剥掉注释再数非空行」那种写法（`dispatch-guard.test.ts` 的 `codeOf` 是那种）：
 * 本仓多处有 URL 字面量（`'https://…'`）与含 `//` 的字符串，朴素剥离会**吃掉真实的代码行**
 * ⇒ 读数偏低 ⇒ 闸静默失效。逐行判定只问「这一行是不是从头到尾都是注释」，与行内出现什么无关。
 */
function codeLineCount(text: string): number {
  let n = 0;
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (inBlock) {
      if (s.includes('*/')) inBlock = false;
      continue;
    }
    if (s.startsWith('/*')) {
      if (!s.includes('*/')) inBlock = true;
      continue;
    }
    if (s === '' || s.startsWith('//')) continue;
    n++;
  }
  return n;
}

function allTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) allTsFiles(p, acc);
    else if (entry.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('源码体量闸：src/** 的单文件「含代码行」不得越过预算（口径见头注）', () => {
  const files = allTsFiles(SRC_ROOT);

  it('真空护栏：src/** 真扫到了（否则下面的断言全是假绿）', () => {
    assert.ok(
      files.length >= MIN_FILES,
      `只扫到 ${files.length} 个 .ts 文件（预期 ≥ ${MIN_FILES}）—— 递归或后缀判据坏了，守卫已失效`,
    );
    // 承重：这个闸的主要对象必须在射程里（它被删/改名的当天就该有人看一眼，而不是闸悄悄空转）
    assert.ok(
      files.some((f) => f.endsWith('/transport/async.ts')),
      'async.ts 不在扫描结果里 —— 这个闸最主要的对象漏了',
    );
  });

  it(`每个文件的含代码行都 ≤ ${MAX_CODE_LINES}`, () => {
    const measured = files
      .map((f) => ({ file: relative(SRC_ROOT, f), lines: codeLineCount(readFileSync(f, 'utf8')) }))
      .filter((m) => m.lines > MAX_CODE_LINES)
      .sort((a, b) => b.lines - a.lines);

    assert.deepEqual(
      measured.map((m) => `${m.file}: ${m.lines}`),
      [],
      `有文件越过了 ${MAX_CODE_LINES} 行「含代码行」的预算。两条路（都必须显式）：` +
        '① 抽件 —— 把方向正交的一块移出去（见 docs/spec.md §10 2026-09-29 那三次抽离）；' +
        '② 提上限 —— 改这个文件里的 MAX_CODE_LINES，并在 PR 里说明为什么。' +
        `注意口径是**代码行**（整行注释与空行不计入）—— 删注释并不能让这个断言变绿。`,
    );
  });
});
