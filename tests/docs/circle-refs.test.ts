/*
 * 圈号引用守卫 —— 「引了 spec §10 的哪个号」这件事必须可解析。
 *
 * ## 为什么要有它
 *
 * `spec.md` §10 用「日期 + 圈号」给每条决策定锚（`### 2026-10-13 ⑨：…`），全仓各处就靠
 * `（2026-10-13 ⑨）` 这种写法指回决策原文。这个写法**没有任何东西守着**：
 *
 * - 圈号是**按天**编的，且同一条决策会被**重排**（串行合并时，批次二自己的分支把四件事编成
 *   ⑨⑩⑪⑫，同一分支的 tests 仍写 ①②③④ ⇒ 偏差恒为 +8，**落地当天就是自相矛盾的**）；
 * - 还有一类是**从写下那天起就不存在**的号：九月底的两条 src 注释引了该日 ⑧ 之后的号，
 *   而该日只有 ①–⑧（用 `git log -S` 限 `docs/spec.md` 查过，从来没有过）；`spec.md` 内
 *   另有一处把 2026-09-11 的条目号写成了圈号，而**该日的 §10 条目用字母编号（R1–R6）**——
 *   **同一个提交**里另一处已经写着「见 §10 2026-09-11 R1 条」，两处自相矛盾。
 *
 * 三类共同的后果一样：**读者按号去查，查到的不是你指的那件事**（或者什么都查不到）。
 * 这与本仓反复收口的「文档承诺了、代码没有」是同一族病，只是发生在引用层面。
 *
 * ## 守什么（一条规则，两档射程）
 *
 * 规则：**若某个 `(日期 圈号)` 的「日期」在 §10 里「有条目」，则那个「圈号」必须真的存在。**
 *
 * 「有条目」按**行首形态**判、与有没有编号无关：`### 日期 …`、`**日期 …`、`- 日期：…`。
 * **取「有条目」而不是「有圈号锚点」是有意的** —— 后者会把「日期有条目、但条目用字母编号」
 * 那一整类（2026-09-11 的 R1–R6）整体漏出射程，而给这种日期加圈号**一定是错的**。
 *
 * - **档 A（全查引用）**：`AGENTS.md` / `docs/` 下的 md 与 astro / `src` / `tests` / `scripts` /
 *   `examples` / 两个附属包的 `src` 与 `test` —— 这些地方的 `(日期 圈号)` 一律是 spec 引用。
 * - **档 B（只查带标记的）**：根 `CHANGELOG.md` 与 `packages/cli/CHANGELOG.md`。它们的标题里
 *   也用 `（日期 圈号）` 这个形状，但**含义随版本节而变，两节两种惯例**：`[0.10.0]` 那节照抄
 *   §10 的号（证据：该节 ⑳ 的标题与 §10 同号条目几乎逐字相同），而 `[0.10.2]` 那节用的是
 *   **该节自己的条目序号**（证据：该节「④ 脚手架默认入口」对应 spec 的 ②）⇒ 全查会误报。
 *
 * ## 定点不咬的两类（都是**规则的自然结果**，不是豁免名单）
 *
 * 1. **日期在 §10 里没有条目** —— 它只在**别的条目的正文**里被提到（如 2026-10-11）⇒ 那个号
 *    指的是**别的文档自己的编号**（如 `docs/plans/2026-10-11-execute-inner-debt.md` 的条目号），
 *    规则第一条就不成立。实测射程内这一档共 8 处，形态一致。
 * 2. **同日首条没编号**（如 `### 2026-09-20：第九轮复审收口`）⇒ 它没有锚点可引，
 *    全仓也确实没人引它。这是编号风格，不是缺陷。
 *
 * ## 本守卫判不了的（只能人读）
 *
 * 它只判「**号在不在**」，判不了「**号指得对不对**」：指错了主题、但那个号本身是该日真实存在的
 * 号 —— 例如把当日的 ⑩⑪ 写成 ②③，而 ②③ 也是同一天的号 —— 机器判不了，因为要判「指得对不对」
 * 就得理解主题。⚠️ 本仓**最大的一类错引（重排后未同步）全部属于这一类**（它们的号当时都存在于
 * 该日）⇒ **那一批从来不是本守卫的功劳，是人逐条读出来的**。别把本守卫的存在当成
 * 「引用已经安全了」—— 它挡的是「查不到」，不挡「查错了」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚';
const DATE = '20\\d\\d-\\d\\d-\\d\\d';
/**
 * 引用：日期 + **紧跟的一整串**圈号。
 *
 * ⚠️ 吃「一串」而不是「一个」是有实测理由的：`（2026-10-13 ②③）` 这种写法指该日的**两条**决策
 * （本仓历史上真有一行是这个形状，`tests/transport/resume-scanner.test.ts` 里那处），
 * 而「只认第一个」的版本对第二个及以后**完全不校验** ⇒ 那半个引用是裸的。
 * 实测：改成一串后射程内多校验 14 处、**新增违规 0**（即零误报，纯增量）。
 */
const REF = new RegExp(`(${DATE})\\s*([${CIRCLED}]+)`, 'g');

/** 锚点**定义行**只认这两种形态：`### 日期 圈号…` 与 `**日期 圈号 —— 标题**`。 */
const ANCHOR = new RegExp(`^(?:#{3,6}\\s*|\\*\\*\\s*)(${DATE})\\s*([${CIRCLED}])`);

/**
 * **条目行**的判据：行首（可带缩进）是 `#` / `**` / `- ` / `* `，紧跟日期。**不看有没有圈号**。
 *
 * 为什么需要它：`2026-09-11` 在 §10 有**条目**（`- 2026-09-11：**R1–R5 一轮落地**`），
 * 但条目里用的是**字母编号**（R1–R6）⇒ 它不产生任何圈号锚点，于是所有「该日 + 圈号」的引用
 * 会被下面的 `dates.has()` 直接跳过。而那种引用**一定是错的** —— 该日根本没有圈号可引。
 * ⚠️ 判据取「有条目」而非「有锚点」正是为了把这一类收进射程。实测：收进来后射程内只多出
 * **1** 处（`docs/spec.md` 里那处），`2026-10-11` 那 8 处仍正确留在射程外（它在 §10 里
 * 只被**别的条目的正文**提到、自己不构成条目行）。
 */
const ENTRY = new RegExp(`^\\s*(?:#{3,6}\\s*|\\*\\*\\s*|[-*]\\s+)(${DATE})`);

/**
 * 建 §10 的锚点集合（只取 `## 10.` 到下一个 `## `）。
 *
 * ⚠️ 刻意**不**把「以日期+圈号开头的普通行」当锚点：全文件这种行只有 5 处，逐行读全是**引用**
 * （如 `2026-10-13 ① 起它还是…` 是段落续行 —— 注意这里没有可引的号，它自己就是一句引用），
 * 把它们收成锚点会**伪造**标题：第一版解析器就这么错过一次，把段落续行当成了某条决策的标题。
 * **收紧比放宽重要** —— 假锚点会让错引用被算成「合法」，而漏一个真锚点只会报一次假红。
 */
function specAnchors(): {
  anchors: Map<string, number>;
  dates: Set<string>;
  anchorDates: Set<string>;
} {
  const lines = readFileSync(join(repoRoot, 'docs', 'spec.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^##\s*10\./.test(l));
  assert.ok(start >= 0, '没找到 `## 10.`（决策记录）标题 —— 守卫已失效');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const anchors = new Map<string, number>();
  const entryDates = new Set<string>();
  for (let i = start; i < end; i++) {
    const m = ANCHOR.exec(lines[i]);
    if (m) {
      const key = `${m[1]} ${m[2]}`;
      if (!anchors.has(key)) anchors.set(key, i + 1); // 同日重号（本仓有 1 处）：先到先得
      continue;
    }
    const e = ENTRY.exec(lines[i]);
    if (e) entryDates.add(e[1]);
  }
  const anchorDates = new Set([...anchors.keys()].map((k) => k.slice(0, 10)));
  return { anchors, dates: new Set([...anchorDates, ...entryDates]), anchorDates };
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.astro',
  '.workbuddy',
  'tmp',
  '.workbuddy-ai',
]);
const EXTS = new Set([
  '.md',
  '.astro',
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.yml',
  '.yaml',
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(p, acc);
    } else if (EXTS.has(extname(entry.name))) {
      acc.push(p);
    }
  }
  return acc;
}

/** 档 A 的射程（目录）。顶层文件与 CHANGELOG 单独列出。 */
const SCOPE_DIRS = [
  'src',
  'tests',
  'scripts',
  'examples',
  'docs',
  'packages/cli/src',
  'packages/cli/test',
  'packages/trace-view/src',
  'packages/trace-view/test',
];
const TOP_FILES = ['AGENTS.md', 'CONTRIBUTING.md'];
/** 档 B：**版本节之间惯例不同**（见头注），故只查带 `§10` / `spec.md` 标记的引用。 */
const MARKER_ONLY = ['CHANGELOG.md', 'packages/cli/CHANGELOG.md'];
const MARKER = /§\s*10|spec\.md/;

test('spec §10 的圈号引用必须可解析：日期有条目 ⇒ 圈号必须存在', () => {
  const { anchors, dates, anchorDates } = specAnchors();

  // 真空护栏 ①：锚点表本身不许空（解析器退化 ⇒ 下面的断言会 vacuously 全绿）
  assert.ok(
    anchors.size >= 100 && dates.size >= 15,
    `只解析出 ${anchors.size} 个锚点 / ${dates.size} 个日期段 —— 远低于预期（§10 现有 100+ 个锚点），解析器已失效`,
  );

  // 真空护栏 ②：**「有条目但无圈号锚点」那一类必须真的还在**。它才是本守卫与「只认锚点」的分野；
  // ENTRY 判据一旦退化，这一类整片消失，而它的错引用（下面射程内的那一处）会**静默变绿**。
  const unnumbered = [...dates].filter((d) => !anchorDates.has(d));
  assert.ok(
    unnumbered.length >= 3,
    `只解析出 ${unnumbered.length} 个「在 §10 有条目、但条目无圈号锚点」的日期（预期 ≥ 3，实测 5）` +
      ` —— ENTRY 判据退化了：给字母编号的日期硬加圈号这一类会整片漏出射程`,
  );

  const files = [
    ...TOP_FILES.map((f) => join(repoRoot, f)),
    ...SCOPE_DIRS.flatMap((d) => walk(join(repoRoot, d))),
    ...MARKER_ONLY.map((f) => join(repoRoot, f)),
  ];
  const markerOnly = new Set(MARKER_ONLY.map((f) => join(repoRoot, f)));

  let checked = 0;
  const bad: string[] = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(REF)) {
        if (markerOnly.has(file)) {
          const before = line.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
          if (!MARKER.test(before)) continue;
        }
        const date = m[1];
        if (!dates.has(date)) continue; // 规则不成立：该日期在 §10 没有条目（只在别的条目正文里被提到）
        // ⚠️ 逐个校验 —— `m[2]` 是一**串**圈号（见 `REF` 的说明），只查第一个会让后面那些变裸的。
        for (const circ of m[2]) {
          checked += 1;
          if (!anchors.has(`${date} ${circ}`)) {
            const total = [...anchors.keys()].filter((k) => k.startsWith(`${date} `)).length;
            const why =
              total === 0
                ? '该日在 §10 有条目、但条目**没有圈号**（用的是字母等别的编号）⇒ 圈号在这里无号可指'
                : `该日共 ${total} 个锚点`;
            bad.push(
              `${rel}:${i + 1}  引了 ${date} ${circ}，但 §10 没有这个锚点（${why}）` +
                `\n        ${line.trim().slice(0, 120)}`,
            );
          }
        }
      }
    });
  }

  // 真空护栏 ③：真扫到了引用（否则「一条都没查」也会绿）
  assert.ok(checked >= 200, `只检查到 ${checked} 处引用（预期 200+）—— 射程或正则坏了`);

  assert.deepEqual(
    bad,
    [],
    '有引用指向 §10 里不存在的锚点 —— 读者按号去查会查不到（或查到别的决策）。' +
      '改法：把号改成该日真实存在的那个（先读 §10 的锚点表认主题，别按位置猜）；' +
      '若该日在 §10 根本没有圈号（条目用字母编号），就**不要用圈号去引它**。',
  );
});
