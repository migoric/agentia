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
 * 报告原话是「`async.ts ≤ 1600`（行数）」。本仓**注释占比很高**（2026-09-29 实测：跨 `src/**`
 * 29%~55%，`async.ts` 55%），注释是证据载体（记着「判据只挡终态，别写成 `!== 'queued'`，
 * 第一版就是这么错的」这类踩坑）。按「行数」设闸的话，第一个作用是**逼人删注释** ——
 * 那是最贵的资产、而且是**静默**的（删掉注释不影响任何用例）。所以口径必须与注释解耦：
 * **整行注释与空行都不计入**。
 *
 * 顺带一个读数（**2026-09-29 写下时**）：按行数 1460 < 1600 ⇒ 报告那道闸**当下根本不触发**
 * （是事后不疼的）；按代码行 664 才是它真正管着的量。
 *
 * ⚠️ **本头注里除下表之外的数字都是「写下时的快照」**（都带日期），真值只有下表 ——
 * 而那张表**是自审的**：文件末的「头注表自审」用例拿实测与它逐行对拍，表里的数 ≠ 实测即红。
 *
 * ## 上限 750 是怎么来的
 *
 * | 文件 | 代码行 | 备注 |
 * |---|---:|---|
 * | `transport/async.ts` | **680** | 抽走三个监督件（审批 / 事件投递 / 恢复扫描）+ run-outcome 之后（2026-10-14 复算） |
 * | `engine/turn.ts` | 524 | 全仓第二 |
 * | `integrations/openai.ts` | 493 | |
 *
 * 680 与第二名 524 之间隔着一大截 —— 750 是「单文件明显异常」的线：它给 `async.ts`
 * 留的余量**已不足一成**（按上表现算，不在正文另记一份），同时**远离**合法长文件那一档
 * （报告 §2 那批「不该拆」的大函数，最长 `metrics-render.ts` 也只有 260 行代码）⇒ 不会误伤。
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

/**
 * **头注表自审**：上面那张表不是「说明」，是**被引用的事实**。
 *
 * `AGENTS.md` 的导览图里明确写着「当前真值以 `tests/architecture/source-size.test.ts` 头注表为准，
 * 别在这里数」—— 于是一个人（或一个 agent）想报 `async.ts` 的体量时，**唯一**该读的就是这张表。
 * 那么这张表自己不能先烂。2026-10-13 的实例：表里写 `async.ts` **627** 代码行，而当天
 * `#250` 已经把它改到 **680**；`#251` 改这张表时声称「复算」，却把评审报告里的旧数照抄了进来
 * —— **答案就在它自己的树里**。这是「假账」的典型形状：语义上没撒谎，数字没现算。
 *
 * 所以这条断言只做一件事：**拿实测与表里的数逐行对拍**。口径复用上面那个 `codeLineCount`
 * （同一个函数，不另造一份 —— 两处口径分岔本身就是 bug 源）。
 */
describe('头注表自审：表里登记的数字必须等于实测（口径复用上面的 codeLineCount）', () => {
  // 只取头注（文件顶部到第一个声明为止），避免误抓下文里可能的别的表格
  const headnote = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('const SRC_ROOT')[0];
  const rows = [
    ...headnote.matchAll(/^\s*\*\s*\|\s*`([^`]+)`\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/gm),
  ].map((m) => ({ file: m[1], declared: Number(m[2]) }));

  it('真空护栏：头注表真的解析到了（否则下面的断言是假绿）', () => {
    assert.ok(
      rows.length >= 3,
      `只从表里解析到 ${rows.length} 行（预期 ≥ 3）—— 表格格式变了，或者解析器退化了`,
    );
    // 承重：这张表存在的理由就是给 async.ts 定预算
    assert.ok(
      rows.some((r) => r.file === 'transport/async.ts'),
      '表里没有 `transport/async.ts` 那一行 —— 这个表最主要的对象漏了',
    );
  });

  it('表里的每个数字都等于实测「含代码行」', () => {
    const drifted = rows
      .map((r) => ({ ...r, measured: codeLineCount(readFileSync(join(SRC_ROOT, r.file), 'utf8')) }))
      .filter((r) => r.measured !== r.declared)
      .map((r) => `${r.file}: 表里 ${r.declared}，实测 ${r.measured}`);

    assert.deepEqual(
      drifted,
      [],
      '头注表里的数字与实测不符 —— 这张表是 AGENTS.md 指定的真值来源，别让它先烂。' +
        '改法：先把表改成实测；若这次改动本身就让体量变了（抽件 / 加代码），' +
        '在同一 PR 里说明「变化来自哪一块」—— 别只改表不改代码、也别只改代码不改表。',
    );
  });
});
