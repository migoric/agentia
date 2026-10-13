/*
 * 元守卫 —— 「守卫注册表本身不得腐化」的可执行版本。
 *
 * 为什么需要它：`docs/guards.md` 是「哪类危险由谁守」的单源清单，而它的价值**完全依赖
 * 里面引用的守卫真实存在**。清单最常见的死法是「文件被改名 / 删除 / 搬家，清单还指着旧路径」——
 * 于是下一个人照着清单去信一个已经不存在的守卫。这与本仓库反复踩的
 * 「文档承诺了、代码没有」是同一类病，只是发生在元层面。
 *
 * 守两件事：
 * ① 清单里以 `反引号` 写出、形如**路径**的 token，若指向仓库内的文件就必须存在
 *   （派生数据目录 node_modules / dist / .astro 不检查；非路径 token 一律跳过）；
 * ② 清单的**条目密度**下限 —— 解析器若退化成抽不到东西，① 会 vacuously 全绿。
 *
 * ⚠️ 反向误报的豁免方式：清单里要写「举例用的假路径」时，用 **行内代码之外的** 写法，
 * 或加 `（示例）` 之类的可读标注即可（本守卫只认纯路径样 token）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY = join(repoRoot, 'docs', 'guards.md');

/** 反引号里的内容：`…`（不跨行、非空） */
function backtickTokens(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/`([^`\n]+)`/g)) out.push(m[1].trim());
  return out;
}

/**
 * 判定：只检查**以已知仓库根前缀开头**的路径 token。
 *
 * 为什么要求前缀（而不是「含 `/` 就算路径」）：那样会把 `@anthropic-ai/sdk`（包名）、
 * `transport/`（泛称目录，真实在 `src/transport/`）也当成路径检查，既误报又含糊。
 * 窄一点更准 —— 误报的守卫会被 ignore 掉（同 `transport-errors.test.ts` 的取舍）。
 */
const REPO_PREFIXES = ['src/', 'tests/', 'docs/', 'scripts/', 'packages/', 'examples/', '.github/'];

function isRepoPath(token: string): boolean {
  if (!token.includes('/')) return false;
  if (/\s/.test(token)) return false;
  if (/[*?<>{}|]/.test(token)) return false; // 通配 / 占位符 / 管道
  if (!REPO_PREFIXES.some((p) => token.startsWith(p))) return false;
  if (token.includes('/dist/') || token.includes('/node_modules/')) return false;
  return true;
}

test('docs/guards.md 引用的仓库内路径必须真实存在（清单不得腐化）', () => {
  const md = readFileSync(REGISTRY, 'utf8');
  const missing: string[] = [];
  let checked = 0;
  for (const token of backtickTokens(md)) {
    if (!isRepoPath(token)) continue;
    checked += 1;
    if (!existsSync(join(repoRoot, token))) missing.push(token);
  }

  // 下限贴近**实测值 32**（留 ~25% 余量），不是「聊胜于无」的 8：旧值 8 意味着删掉注册表
  // §1.1–§1.3 整整三节（约 14 个 token）仍会绿 —— 防「抽词器退化」的护栏同时替「整节被删」放行了
  // （2026-09-18 第七轮复审）。改注册表时若这条跌破，先确认是「清单真变短」还是「抽词器退化」。
  assert.ok(
    checked >= 24,
    `只解析到 ${checked} 个路径 token —— 抽词器大概率退化了（本守卫在空转）`,
  );
  assert.deepEqual(
    missing,
    [],
    'docs/guards.md 引用了不存在的路径 —— 守卫被改名/删除后清单还指着旧路径，' +
      `下一个人会去信一个不存在的守卫：\n${missing.join('\n')}`,
  );
});

test('docs/guards.md 必须保留「待守缺口」一节（缺口可见是它的存在意义）', () => {
  const md = readFileSync(REGISTRY, 'utf8');
  assert.match(md, /## 2\. 待守/, '缺少 §2 待守缺口 —— 只剩「已挂守卫」的清单会假装覆盖完整');
  assert.match(md, /## 1\. 已挂守卫/, '缺少 §1 已挂守卫');
  assert.match(md, /## 3\. 守卫的写法/, '缺少 §3 写法纪律');
});

// 「守卫货架」上的文件必须都登记 —— 这是上面那条断言的反向。
//
// 上面只查「清单里写的路径存在」（清单 → 盘），查不出「盘上有守卫却没登记」。反向才是更常见
// 的那一种：新写一个守卫文件、忘了加行。本仓 2026-09-26 实测到过 5 个（见 §1.4 的 5 行新条目）。
//
// 为什么只限这几个目录：注册表的通用完整性没法机器判。实测 tests/** +
// packages/*/test 共 124 个 *.test.ts，只有 47 个在表里 —— 绝大多数是普通行为测试，
// 而且行的归属是按「不变量的家」而不是按测试文件（例：tests/transport/scheduler.test.ts
// 里那条 maxInFlight 构造期校验，登记在 src/core/limits.ts 那一行）。硬要求「每个测试文件
// 都有一行」会造出 77 条豁免 —— 那是噪音，不是守卫。
// 这几个目录不同：它们按构造就是横切守卫货架（架构不变量 / 文档↔代码 / 工具链自指），
// 货架上出现一个没登记的文件，就是真的缺口。
// （tests/scripts 是 2026-10-13 补进来的：三个文件早就都在表里，货架本身反而漏登。）
const SHELVES = ['tests/architecture', 'tests/docs', 'tests/scripts'];

// 货架上故意不登记的文件。豁免不是免检：每条都要给出「它不是守卫」的理由。
// （当前为空 —— 这正是这条守卫想保持的状态；要往这里加东西，先确认它真的不守任何不变量。）
const SHELF_EXEMPT: Array<{ file: string; why: string }> = [];

test('守卫货架（tests/architecture · tests/docs · tests/scripts）上的每个 *.test.ts 都必须在注册表里有一行', () => {
  const md = readFileSync(REGISTRY, 'utf8');
  const rows = md.split('\n').filter((l) => l.startsWith('|'));
  const files = SHELVES.flatMap((dir) =>
    readdirSync(join(repoRoot, dir))
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => `${dir}/${f}`),
  );
  assert.ok(
    files.length >= 10,
    `只扫到 ${files.length} 个货架文件 —— 目录读错了或货架被搬走了（本守卫在空转）`,
  );
  const exempt = new Set(SHELF_EXEMPT.map((e) => e.file));
  for (const e of SHELF_EXEMPT) {
    assert.ok(
      files.includes(e.file),
      `SHELF_EXEMPT 里的 '${e.file}' 不在货架上 —— 幽灵豁免，请删掉`,
    );
    assert.ok(e.why.length > 10, `'${e.file}' 的豁免理由太短，等于没写`);
  }
  const unlisted = files.filter(
    (f) => !exempt.has(f) && !rows.some((r) => r.includes(f.split('/').pop()!)),
  );
  assert.deepEqual(
    unlisted,
    [],
    '这些守卫文件在货架上，却不在 docs/guards.md 的任何表格行里：\n' +
      unlisted.join('\n') +
      '\n  ⇒ 二选一：① 在 §1 里补一行（含「保护的不变量 / 机制 / 退化了会怎样」，' +
      '并做一次反向验证把证据写进去）；\n' +
      '     ② 加进本文件的 SHELF_EXEMPT 并写清「它为什么不守任何不变量」。\n' +
      '  ⚠️ 射程：只认「表格行里点名了文件名」—— 行文里顺带提到也算数，本守卫不区分。',
  );
});
