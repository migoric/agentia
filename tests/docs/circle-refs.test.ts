/*
 * 圈号 / slug 引用守卫 —— 「引了 spec §10 的哪条决策」这件事必须可解析。
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
 * ## P1 放宽期（2026-10-14 起；**退出条件 = P3**）
 *
 * 锚点正在从「日期 + 位置号」迁到「日期 + slug」（设计稿见
 * `docs/plans/2026-10-14-ref-slug-migration.md`）。P1 只给锚点**加名**、**不动任何一条引用**，
 * 所以本守卫此刻接受**两种**引用形态：
 *
 *   `（2026-10-13 ⑨）`                     ← 圈号（P1 期全仓现状，仍是仅有的形态）
 *   `（2026-10-13 ref-guard-scope-round4）` ← slug（新形态；本行即是全仓第一条 slug 引用）
 *
 * ⚠️ **这是一次有期限的放宽，不是放松**：
 *
 * 1. **退出条件写在代码里** —— P3 收口时删掉 `REF` 里的 `[CIRCLED]+` 那一支（以及随之退休的
 *    `anchors` 表）。写在这里是为了让「哪天该收」有据可查，而不是靠谁记得；
 * 2. **另一头同时收紧** —— `anchors` 有几行，slug 锚点就必须有几行（下面的 `anchorRows` /
 *    `slugRows` 相等断言）。**不允许「只加了 slug、同日圈号被误删」这种半迁移状态** ——
 *    否则 P3 收口时锚点会对不齐，而那时引用已经全改完了；
 * 3. **放宽的那一支要能自证** —— 断言 slug 锚点数下界（`slugs.size >= 119`），否则解析器退化成 0
 *    也没人知道（放宽的代码最容易变成死代码）。
 *
 * ## 守什么（一条规则，两档射程）
 *
 * 规则：**若某个 `(日期 + 引用键)` 的「日期」在 §10 里「有条目」，则那个引用键必须真的存在。**
 * 「引用键」在 P1 期 = 一串圈号 **或** 一个 slug。
 *
 * 「有条目」按**行首形态**判、与有没有编号无关：`### 日期 …`、`**日期 …`、`- 日期：…`。
 * **取「有条目」而不是「有圈号锚点」是有意的** —— 后者会把「日期有条目、但条目用字母编号」
 * 那一整类（2026-09-11 的 R1–R6）整体漏出射程，而给这种日期加圈号**一定是错的**。
 *
 * - **档 A（全查引用）**：`AGENTS.md` / `docs/` 下的 md 与 astro / `src` / `tests` / `scripts` /
 *   `examples` / 两个附属包的 `src` 与 `test` —— 这些地方的 `(日期 键)` 一律是 spec 引用。
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
 *    全仓也确实没人引它。这是编号风格，不是缺陷。⚠️ 这一类**因此也没有 slug**（P1 射程只含
 *    「带圈号的锚点定义行」）—— 它既不该被引，就不需要一个名字。
 *
 * ## 本守卫判不了的（只能人读）
 *
 * 它只判「**键在不在**」，判不了「**键指得对不对**」：指错了主题、但那个键本身是该日真实存在的
 * 键 —— 例如把当日的 ⑩⑪ 写成 ②③，而 ②③ 也是同一天的号 —— 机器判不了，因为要判「指得对不对」
 * 就得理解主题。⚠️ 本仓**最大的一类错引（重排后未同步）全部属于这一类**（它们的号当时都存在于
 * 该日）⇒ **那一批从来不是本守卫的功劳，是人逐条读出来的**。别把本守卫的存在当成
 * 「引用已经安全了」—— 它挡的是「查不到」，不挡「查错了」。
 *
 * ⚠️ 还有一条**本文件自己踩得上的坑**：本文件在档 A 射程内（`tests/` 下），所以
 * **头注里举例写的 `（日期 键）` 也是真引用**，那个键必须真的存在于 §10 —— 否则守卫会被自己的
 * 注释咬红（上面 P1 段举的 `（2026-10-13 ref-guard-scope-round4）` 是实测存在的真锚点，
 * 不是随手编的例子）。
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
 * P1 的 slug：**强制 `ref-` 前缀** + kebab-case。
 *
 * 前缀是有用的，不只是好看：它让「数字开头」这种形态**构造不出来**（`ref-2fa` 以 `r` 起头），
 * 于是「slug 会不会与圈号在解析时混淆」这个问题直接不成立 —— 设计稿 §7 曾把它列为待做负向
 * 实验的开放问题（见设计稿 §7.1 的定稿结论）。
 */
const SLUG = 'ref-[a-z0-9]+(?:-[a-z0-9]+)*';
/**
 * 引用：日期 + **紧跟的一个引用键**（P1 期：一串圈号 **或** 一个 slug）。
 *
 * ⚠️ 圈号那一支是**有实测理由**才吃「一整串」的：`（2026-10-13 ②③）` 这种写法指该日的**两条**
 * 决策（本仓历史上真有一行是这个形状，`tests/transport/resume-scanner.test.ts` 里那处），
 * 而「只认第一个」的版本对第二个及以后**完全不校验** ⇒ 那半个引用是裸的。
 * 实测：改成一串后射程内多校验 14 处、**新增违规 0**（即零误报，纯增量）。
 *
 * ⚠️ slug 那一支**刻意不吃「空格分隔的多个 slug」**：P1/P2 期迁移脚本逐个替换，
 * 一次一个；要支持 `（日期 ref-a ref-b）` 的话请同时也把校验改成逐个 —— 别只放宽正则。
 */
const REF = new RegExp(`(${DATE})\\s*([${CIRCLED}]+|${SLUG})`, 'g');

/** 锚点**定义行**只认这两种形态：`### 日期 圈号…` 与 `**日期 圈号 —— 标题**`。 */
const ANCHOR = new RegExp(`^(?:#{3,6}\\s*|\\*\\*\\s*)(${DATE})\\s*([${CIRCLED}])`);

/**
 * **P1 的锚点形态**：`### 日期 圈号 <slug>…`（slug 插在圈号之后、其余原样）。
 *
 * ⚠️ 难点在 P3：那时圈号会从「地址」退化成「显示编号」，本正则要跟着改成 slug 可选在圈号前后
 * 两种位置 —— 现在只认一种（本仓现状），是因为 P1 的写入形态只有一种。
 */
const SLUG_ANCHOR = new RegExp(
  `^(?:#{3,6}\\s*|\\*\\*\\s*)(${DATE})\\s*([${CIRCLED}])\\s+(${SLUG})`,
);

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
 *
 * 返回三个口径，**它们的数量关系本身就是 P1 的断言**：
 * - `anchorRows`：带圈号的锚点**定义行数**（同日重号算两行 —— 本仓有 1 处）
 * - `anchors`：`日期+圈号` 的**唯一键**表（同日重号先到先得 ⇒ 比 `anchorRows` 少）
 * - `slugRows` / `slugs`：同上，键换成 slug（slug 全局唯一 ⇒ 两者应当相等）
 */
function specAnchors(): {
  anchors: Map<string, number>;
  dates: Set<string>;
  anchorDates: Set<string>;
  slugs: Map<string, { date: string; circ: string; line: number }>;
  anchorRows: number;
  slugRows: number;
  /** 有圈号但（没有 slug / slug 形态不合法）的行号 —— P1 的「半迁移」证据 */
  anchorNoSlug: number[];
  /** 同一天里重复的圈号（`日期 圈号` → 出现的行号列表）—— 只报，不咬（见头注「定点不咬」） */
  sameDayRepeats: string[];
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
  const slugs = new Map<string, { date: string; circ: string; line: number }>();
  const entryDates = new Set<string>();
  const anchorNoSlug: number[] = [];
  const circRows = new Map<string, number[]>();
  let anchorRows = 0;
  let slugRows = 0;
  for (let i = start; i < end; i++) {
    const m = ANCHOR.exec(lines[i]);
    if (m) {
      anchorRows += 1;
      const key = `${m[1]} ${m[2]}`;
      if (!anchors.has(key)) anchors.set(key, i + 1); // 同日重号（本仓有 1 处）：先到先得
      const rows = circRows.get(key) ?? [];
      rows.push(i + 1);
      circRows.set(key, rows);

      const s = SLUG_ANCHOR.exec(lines[i]);
      if (s) {
        slugRows += 1;
        // 同名 slug 只留第一条，重复的那条由 `slugs.size < slugRows` 的断言报出来
        if (!slugs.has(s[3])) slugs.set(s[3], { date: s[1], circ: s[2], line: i + 1 });
      } else {
        anchorNoSlug.push(i + 1);
      }
      continue;
    }
    const e = ENTRY.exec(lines[i]);
    if (e) entryDates.add(e[1]);
  }
  const sameDayRepeats = [...circRows.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => `${k}（行 ${v.join(' / ')}）`);
  const anchorDates = new Set([...anchors.keys()].map((k) => k.slice(0, 10)));
  return {
    anchors,
    dates: new Set([...anchorDates, ...entryDates]),
    anchorDates,
    slugs,
    anchorRows,
    slugRows,
    anchorNoSlug,
    sameDayRepeats,
  };
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

test('spec §10 的引用必须可解析：日期有条目 ⇒ 引用键（圈号或 P1 期 slug）必须存在', () => {
  const { anchors, dates, slugs, anchorRows, slugRows } = specAnchors();

  // 真空护栏 ①：锚点表本身不许空（解析器退化 ⇒ 下面的断言会 vacuously 全绿）
  assert.ok(
    anchors.size >= 100 && dates.size >= 15,
    `只解析出 ${anchors.size} 个锚点 / ${dates.size} 个日期段 —— 远低于预期（§10 现有 100+ 个锚点），解析器已失效`,
  );

  // 真空护栏 ②：**「有条目但无圈号锚点」那一类必须真的还在**。它才是本守卫与「只认锚点」的分野；
  // ENTRY 判据一旦退化，这一类整片消失，而它的错引用（下面射程内的那一处）会**静默变绿**。
  const unnumbered = [...dates].filter(
    (d) => !new Set([...anchors.keys()].map((k) => k.slice(0, 10))).has(d),
  );
  assert.ok(
    unnumbered.length >= 3,
    `只解析出 ${unnumbered.length} 个「在 §10 有条目、但条目无圈号锚点」的日期（预期 ≥ 3，实测 5）` +
      ` —— ENTRY 判据退化了：给字母编号的日期硬加圈号这一类会整片漏出射程`,
  );

  // 真空护栏 ③（P1 新增，设计稿 §3.4 第 3 条）：放宽的那一支要能自证存在。
  // 没有它就退化成死代码 —— 「放宽」与「放弃校验」在输出上长得一样。
  //
  // ⚠️ **下界是「量级」护栏，不是逐条精确计数**（119 = 落地当日的量级；实测 121）。
  // 它挡的是**崩塌**：解析器退化成个位数、或有人批量回退锚点。
  // 它**挡不住**下面两种**单条**退化 —— 别把它当成「锚点数被钉住了」：
  //   · 「删掉某条锚点的**圈号**」⇒ 那行整条滑出 ANCHOR 射程，但它同时落成一条
  //     `### 日期 slug：…` 的形态而**被 `REF` 当成引用**，slug 表里又没有它 ⇒ 本测试末尾的
  //     `bad` 报「引了 slug 但 §10 没有这个锚点」（这条路比数字下界更硬：它说的是「有人查不到」）；
  //   · 「删掉 slug、留住圈号」⇒ 第二个测试的 `anchorNoSlug` 报半迁移。
  //
  // ⚠️ 上一版本这里写的是「下界取紧值 120 ⇒ 能挡住删圈号」，**那句话只在我还没往 §10 加决策
  // 之前成立** —— 加一条决策它就松了一档，而注释还留着旧理由（守卫病根 1：写死的理由会腐烂）。
  // 现在的写法只声称它真能做的事。
  assert.ok(
    slugs.size >= 119,
    `只解析出 ${slugs.size} 个 slug 锚点（量级下界 119，2026-10-14 实测 121）—— P1 的 slug 支路已崩塌：` +
      `要么锚点被批量回退了，要么 SLUG_ANCHOR 正则失效（注意它要求「日期 + 圈号 + slug」三段齐全）`,
  );

  const files = [
    ...TOP_FILES.map((f) => join(repoRoot, f)),
    ...SCOPE_DIRS.flatMap((d) => walk(join(repoRoot, d))),
    ...MARKER_ONLY.map((f) => join(repoRoot, f)),
  ];
  const markerOnly = new Set(MARKER_ONLY.map((f) => join(repoRoot, f)));

  let checked = 0;
  let slugRefs = 0;
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
        const key = m[2];

        // --- P1 的 slug 支路（⚠️ P3 收口时删掉本支与上面的 `[CIRCLED]+` 相反的一支）---
        if (key.startsWith('ref-')) {
          checked += 1;
          slugRefs += 1;
          const hit = slugs.get(key);
          if (!hit) {
            bad.push(
              `${rel}:${i + 1}  引了 slug ${key}，但 §10 没有这个锚点` +
                `\n        ${line.trim().slice(0, 120)}`,
            );
          } else if (hit.date !== date) {
            // slug 全局唯一 ⇒ 日期写错就是错，不存在「换个日期仍指得通」的余地
            bad.push(
              `${rel}:${i + 1}  引了 ${date} ${key}，但该 slug 属于 ${hit.date}（锚点在 spec.md:${hit.line}）` +
                `\n        ${line.trim().slice(0, 120)}`,
            );
          }
          continue;
        }

        // --- 圈号支路（P1 期仍是仅有的形态；P3 之后它整体退休）---
        if (!dates.has(date)) continue; // 规则不成立：该日期在 §10 没有条目（只在别的条目正文里被提到）
        // ⚠️ 逐个校验 —— `m[2]` 是一**串**圈号（见 `REF` 的说明），只查第一个会让后面那些变裸的。
        for (const circ of key) {
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

  // 真空护栏 ④：真扫到了引用（否则「一条都没查」也会绿）
  assert.ok(checked >= 200, `只检查到 ${checked} 处引用（预期 200+）—— 射程或正则坏了`);

  // P1 判据（设计稿 §6.1 判据 1）：**新形态真的通了** —— 射程内至少有一条 slug 引用可解析。
  // P1 不动引用，所以这一条只由「锚点侧 + 新增的活样本」共同满足；它掉了就说明
  // slug 支路没人走过（死代码），而 P2 会在没有活样本的状态下开始批量替换。
  assert.ok(
    slugRefs >= 1,
    '射程内一条 slug 引用都没有 —— P1 的「新形态通了」没有活证据（见设计稿 §6.1 判据 1）',
  );

  assert.deepEqual(
    bad,
    [],
    '有引用指向 §10 里不存在的锚点 —— 读者按它去查会查不到（或查到别的决策）。' +
      '改法：把键改成该日真实存在的那个（先读 §10 的锚点表认主题，别按位置猜）；' +
      '若该日在 §10 根本没有圈号（条目用字母编号），就**不要用圈号去引它**。',
  );

  // 顺带把两个口径打在输出里 —— 它们变了（比如锚点被删）时，从日志里一眼能看出
  assert.ok(
    anchorRows >= slugRows,
    `slug 锚点行(${slugRows}) 多于圈号锚点行(${anchorRows})，不可能`,
  );
});

test('P1 锚点侧：有圈号必有 slug、slug 唯一、形态合法（放宽期的「另一头收紧」）', () => {
  const { anchorRows, slugRows, slugs, anchorNoSlug, sameDayRepeats } = specAnchors();

  // ① 「有圈号 ⇒ 有 slug」：不允许半迁移（设计稿 §3.4 第 2 条）。
  //    这一条与「幽灵豁免」互为对侧：它挡的是「加了名但圈号丢了」，而 P3 收口时才发现就晚了。
  assert.deepEqual(
    anchorNoSlug,
    [],
    `以下锚点行有圈号却没有合法 slug（半迁移状态）：行 ${anchorNoSlug.join(', ')}\n` +
      `        P1 要求 slug 与圈号**同时存在**——加 slug 时别动圈号，改形态时别只改一半。`,
  );
  assert.equal(
    slugRows,
    anchorRows,
    `圈号锚点行 ${anchorRows} 行，带 slug 的 ${slugRows} 行 —— 两者必须相等`,
  );

  // ② slug 全局唯一。**取「全局」而不是设计稿说的「同日唯一」**：实测 121 个名字本就互不相同，
  //    而全局唯一换来的是一条更强的性质 —— 引用里那个「日期」写错时也能被咬住（见上一条测试）。
  assert.equal(
    slugs.size,
    slugRows,
    `slug 锚点 ${slugRows} 行但只有 ${slugs.size} 个不同的名字 —— 有重名 slug。` +
      `重名会让引用解析「查到别的那条」，正是本设计要消灭的状态。`,
  );

  // ③ 形态与长度（正则已在解析时把关，这里给长度一个明确上界，防「一句话当名字」）
  const tooLong = [...slugs.entries()].filter(([s]) => s.length > 48);
  assert.deepEqual(
    tooLong.map(([s, v]) => `${s}（spec.md:${v.line}）`),
    [],
    'slug 长度超过 48 —— slug 是地址，不是标题；太长会在引用里喧宾夺主',
  );

  // ④ 同日重号：**只报不咬**（本仓有 1 处，是真历史，P1 不改历史）。
  //    但它必须被打印出来 —— 「同一天有两个 ②」正是位置号失效的活证据，也是 slug 的收益点。
  if (sameDayRepeats.length > 0) {
    console.log(`  ℹ️ §10 同日重号 ${sameDayRepeats.length} 处（slug 能区分它们，圈号不能）：`);
    for (const r of sameDayRepeats) console.log(`     ${r}`);
  }
});
