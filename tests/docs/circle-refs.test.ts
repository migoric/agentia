/*
 * 引用守卫 —— 「引了 spec §10 的哪条决策」这件事必须可解析。
 *
 * ## 为什么要有它
 *
 * `spec.md` §10 给每条决策定锚，全仓各处靠 `（日期 + 引用键）` 指回决策原文。这个写法
 * 过去**没有任何东西守着**，实测暴露过三类真实的坏引用：
 *
 * - **位置号会漂**：圈号是**按天**编的，且同一条决策会被**重排**（串行合并时，批次二自己的分支把
 *   四件事编成 ⑨⑩⑪⑫，同一分支的 tests 仍写 ①②③④ ⇒ 偏差恒为 +8，**落地当天就是自相矛盾的**）；
 * - **从写下那天起就不存在的号**：九月底的两条 src 注释引了该日 ⑧ 之后的号，而该日只有 ①–⑧
 *   （用 `git log -S` 限 `docs/spec.md` 查过，从来没有过）；`spec.md` 内另有一处把 2026-09-11 的
 *   条目号写成了圈号，而**该日的 §10 条目用字母编号（R1–R6）**——**同一个提交**里另一处已经写着
 *   「见 §10 2026-09-11 R1 条」，两处自相矛盾。
 *
 * 三类共同的后果一样：**读者按号去查，查到的不是你指的那件事**（或者什么都查不到）。
 *
 * ## 形态：引用键 = **slug**（2026-10-14 起）
 *
 * 锚点从「日期 + 位置号」迁到「日期 + 名字」（设计稿
 * `docs/plans/2026-10-14-ref-slug-migration.md`）：
 *
 * ```
 *   锚点  ### <日期> ⑨ ref-<名>：<标题>
 *   引用  （<日期> ref-<名>）
 * ```
 *
 * ⚠️ 上面**刻意用占位符**（`<日期>` / `<名>`）。写一个真日期 + 真圈号进来，它就成了一条
 * **「日期 + 圈号」形态的残留**，会被下面第 3 个用例咬红 —— 实测踩过：本版头注初稿从旧头注
 * 抄了一句 `（如 <日期> ① 起它还是…）`（那是**段落续行**的例子），当场被自己的判据报出来。
 *
 * ⚠️ **圈号留在锚点行上，但已降级为「显示编号」，不再是地址** —— 它不随「同一天插一条」而稳定，
 * 那正是这次迁移要消灭的性质。所以本守卫**只认 slug**：`（日期 圈号）` 不再是引用形态，
 * 写下去**匹配不到任何东西**，也就不会被校验（见下面第 3 个用例：射程内它会直接红）。
 *
 * ### 迁移三步与本文件的对应
 *
 * | 阶段 | 动作 | 守卫形态 |
 * |---|---|---|
 * | P1 加名 | 给每条锚点补 slug，**引用一处不动** | 放宽：接受「一串圈号」**或**「一个/slug 串」 |
 * | P2 换引用 | 脚本批量把 `（日期 圈号）` 换成 `（日期 slug）` | 同上（混用期） |
 * | **P3 收口** | 圈号成为显示编号 | **只认 slug**（← 本文件当前状态） |
 *
 * ⚠️ P1/P2 期的那条放宽**不是放松，是有期限的**，且**退出条件写在代码里**（P1 时就写明了
 * 「P3 收口时删掉 `REF` 里的 `[CIRCLED]+` 那一支」）—— 这不是新决定，是执行既定退出条件。
 *
 * ## 守什么（一条规则，两档射程）
 *
 * 规则：**若某个 `(日期 + 引用键)` 的「日期」在 §10 里「有条目」，则那个引用键必须真的存在。**
 * 「引用键」= **一串空格分隔的 slug**（与迁移前「一串圈号」对称：`（日期 ②③）` 指该日两条决策，
 * 迁移后是 `（日期 ref-a ref-b）`；实测本仓有 5 处这种形态，另有 1 处范围写法 `⑨–⑫` 在 P2
 * 已**展开**成逐个 slug —— 范围语义依赖序号连续，slug 无序，故不保留范围写法）。
 *
 * 「有条目」按**行首形态**判、与有没有编号无关：`### 日期 …`、`**日期 …`、`- 日期：…`。
 *
 * - **档 A（全查引用）**：`AGENTS.md` / `docs/` 下的 md 与 astro / `src` / `tests` / `scripts` /
 *   `examples` / 两个附属包的 `src` 与 `test` —— 这些地方的 `(日期 键)` 一律是 spec 引用。
 * - **档 B（只查带标记的）**：根 `CHANGELOG.md` 与 `packages/cli/CHANGELOG.md`。它们的标题里
 *   也用 `（日期 圈号）` 这个形状，但**含义随版本节而变，两节两种惯例**：`[0.10.0]` 那节照抄
 *   §10 的号（证据：该节 ⑳ 的标题与 §10 同号条目几乎逐字相同），而 `[0.10.2]` 那节用的是
 *   **该节自己的条目序号**（证据：该节「④ 脚手架默认入口」对应 spec 的 ②）⇒ 全查会误报。
 *   ⚠️ 这条**在 P3 之后依然必要**，而且理由更强了：那些「本节序号」的标题**永远**不会变成 slug，
 *   所以档 B 若无标记过滤，第 3 个用例（零圈号）会把它们全报成残留。
 *
 * ## 定点不咬的三类（都是**规则的自然结果**，不是豁免名单）
 *
 * 1. **日期在 §10 里没有条目** —— 它只在**别的条目的正文**里被提到（如 2026-10-11）⇒ 那个号
 *    指的是**别的文档自己的编号**（如 `docs/plans/2026-10-11-execute-inner-debt.md` 的条目号），
 *    规则第一条就不成立。实测射程内 3 处，形态一致。
 * 2. **同日首条没编号**（如 `### 2026-09-20：第九轮复审收口`）⇒ 它没有锚点可引，全仓也确实没人引它。
 *    ⚠️ 它**因此也没有 slug**（P1/P2 射程只含「带圈号的锚点定义行」）—— 它既不该被引，就不需要名字。
 * 3. **`docs/plans/**` 与 `docs/reviews/**`**（第 3 个用例显式排除）—— 它们是**带日期的快照**，
 *    里面的圈号引用写于迁移之前，那就是历史（改了反而是伪造）。⚠️ 这个「不咬」是**刻意的**，
 *    所以它在代码里写成一个具名常量 `SNAPSHOT`，而不是靠「正则刚好没匹配到」。
 *
 * ## 本守卫判不了的（只能人读）
 *
 * 它只判「**键在不在**」，判不了「**键指得对不对**」：指错了主题、但那个键本身真实存在 ——
 * 例如把当日的 ⑩⑪ 写成 ②③，而 ②③ 也是同一天的号 —— 机器判不了，因为要判「指得对不对」
 * 就得理解主题。⚠️ 本仓**最大的一类错引（重排后未同步）全部属于这一类**（它们的号当时都存在于
 * 该日）⇒ **那一批从来不是本守卫的功劳，是人逐条读出来的**。别把本守卫的存在当成
 * 「引用已经安全了」—— 它挡的是「查不到」，不挡「查错了」。
 * ⚠️ 另有一类**从来不在射程**：**不带日期的引用**（`§10 ⑧` / `同日 ⑧` / `spec §10 ④` —— 日期写在
 * 上一句里）。它们形态上就匹配不到 `REF`（那要求日期**紧邻**键）⇒ P2/P3 的「引用已全换成 slug」
 * 只对**带日期**的那一类成立。实测 35 处，已登记进 `docs/guards.md` §2（含「为什么还没有守卫」）——
 * 它不是 P3 漏掉的，是另一条规则的事。
 * ⚠️ 迁移（P2）同理：**slug 解决的是「地址会漂」，不解决「地址指错了」**。P2 的机械替换把
 * 「位置号」翻成了「名字」，但它翻的**是同一个指代** —— 原来指错主题的，换完仍然指错主题。
 *
 * ## 本文件自己踩得上的两个坑
 *
 * 1. **头注里举例写的 `（日期 键）` 也是真引用**（本文件在档 A 射程内，`tests/` 下）—— 那个键
 *    必须真的存在于 §10，否则守卫会被自己的注释咬红（下面举的 `（2026-10-13 ref-guard-scope-round4）`
 *    是实测存在的真锚点，不是随手编的例子）。
 * 2. **写头注时别用「真日期 + 真圈号」**（哪怕是在描述历史）—— 这个坑**先后踩了三次**：
 *    P1 时在设计稿与 §10 条目里用真锚点举例（成了真引用，当场被咬）；P2 的替换脚本把一句
 *    「`日期 ②③`」的说明文字当引用一并换掉（结果对、但**方向是反的**：说明文字本该豁免，
 *    却跟着被改写）；P3 本版头注又从旧头注抄了一句段落续行的例子（`日期 ① 起它还是…`），
 *    当场被第 3 个用例报成残留。⇒ 规则：**描述引用形态的句子一律用占位符**；
 *    只有**不带日期**的圈号串（`⑨⑩⑪⑫`）才能裸写 —— 它匹配不到任何正则。
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
 * slug：**强制 `ref-` 前缀** + kebab-case。
 *
 * 前缀是有用的，不只是好看：它让「数字开头」这种形态**构造不出来**（`ref-2fa` 以 `r` 起头），
 * 于是「slug 会不会与圈号在解析时混淆」这个问题直接不成立（设计稿 §7 曾把它列为待做负向
 * 实验的开放问题，见 §7.1 的定稿结论）。
 */
const SLUG = 'ref-[a-z0-9]+(?:-[a-z0-9]+)*';
/**
 * 引用键：**一串空格分隔的 slug**。
 *
 * ⚠️ 吃「一串」不是可选的宽松：`（日期 ②③）` 这种「一条引用指该日两条决策」的写法在本仓真实存在
 * （P2 实测 5 处），迁移后就是 `（日期 ref-a ref-b）`。**只认第一个 slug 的版本对第二个及以后
 * 完全不校验** ⇒ 那半个引用是裸的。
 */
const SLUG_SEQ = `${SLUG}(?:\\s+${SLUG})*`;
/** 引用：日期 + 紧跟的一串 slug。**圈号不在此列** —— 它已不是地址（见头注「形态」）。 */
const REF = new RegExp(`(${DATE})\\s*(${SLUG_SEQ})`, 'g');

/**
 * 锚点**定义行**：`### 日期 [圈号] slug…`。
 *
 * ⚠️ 圈号写成**可选**是有意的 —— 它已降级为显示编号，将来若有人把它去掉，锚点仍然合法、仍然可引。
 * 而 slug **必在**：没有 slug 的定义行不构成锚点（它不是地址）。
 */
const SLUG_ANCHOR = new RegExp(
  `^(?:#{3,6}\\s*|\\*\\*\\s*)(${DATE})\\s*(?:([${CIRCLED}])\\s+)?(${SLUG})`,
);
/** 带圈号的定义行 —— 只用于「有圈号必有 slug」（防半迁移）与「定义行排除」。 */
const ANCHOR = new RegExp(`^(?:#{3,6}\\s*|\\*\\*\\s*)(${DATE})\\s*([${CIRCLED}])`);
/**
 * **「日期 + 圈号」形态** —— P3 的**残留计数**专用（不是引用形态，平时不该出现）。
 *
 * 吃「范围连接符」是为了**发现**它：`（日期 ⑨–⑫）` 指该日四条决策，若替换脚本只吃 `⑨`
 * 会留下孤儿的 `–⑫`。P2 已经把它展开成逐个 slug，所以本正则在这里的作用是**把这种形态也
 * 算进残留** —— 它同样是「位置号地址」，同样不该再出现。
 */
const CIRC_REF = new RegExp(
  `(${DATE})\\s*[${CIRCLED}]+(?:\\s*[–—−~〜∼至-]\\s*[${CIRCLED}]+)*`,
  'g',
);

/**
 * **条目行**的判据：行首（可带缩进）是 `#` / `**` / `- ` / `* `，紧跟日期。**不看有没有圈号**。
 *
 * 为什么需要它：`2026-09-11` 在 §10 有**条目**（`- 2026-09-11：**R1–R5 一轮落地**`），
 * 但条目里用的是**字母编号**（R1–R6）⇒ 它不产生任何圈号锚点，于是所有「该日 + 圈号」的引用
 * 会被下面的 `dates.has()` 直接跳过。而那种引用**一定是错的** —— 该日根本没有圈号可引。
 */
const ENTRY = new RegExp(`^\\s*(?:#{3,6}\\s*|\\*\\*\\s*|[-*]\\s+)(${DATE})`);

/**
 * 建 §10 的锚点集合（只取 `## 10.` 到下一个 `## `）。
 *
 * ⚠️ 刻意**不**把「以日期+圈号开头的普通行」当锚点：全文件这种行只有 5 处，逐行读全是**引用**
 * （如 `<日期> ① 起它还是…` 是段落续行 —— 这里刻意写占位符，理由见下面「本文件自己踩得上的坑」），
 * 把它们收成锚点会**伪造**标题：
 * 第一版解析器就这么错过一次，把段落续行当成了某条决策的标题。
 * **收紧比放宽重要** —— 假锚点会让错引用被算成「合法」，而漏一个真锚点只会报一次假红。
 *
 * 返回的口径，**它们的数量关系本身就是断言**：
 * - `anchorRows`：带圈号的锚点**定义行数**（同日重号算两行 —— 本仓有 1 处）
 * - `slugs`：slug → `{ date, circ, line }`（slug 全局唯一 ⇒ 它天然是地址）
 * - `anchorNoSlug`：有圈号但**没有合法 slug** 的行号 —— 「半迁移」证据
 * - `sameDayRepeats` / `defLines`：同日重号（只报不咬）、定义行行号（第 3 个用例排除用）
 */
function specAnchors(): {
  dates: Set<string>;
  slugs: Map<string, { date: string; circ: string; line: number }>;
  anchorRows: number;
  slugRows: number;
  anchorNoSlug: number[];
  sameDayRepeats: string[];
  defLines: Set<number>;
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

  const slugs = new Map<string, { date: string; circ: string; line: number }>();
  const anchorDates = new Set<string>();
  const entryDates = new Set<string>();
  const anchorNoSlug: number[] = [];
  const defLines = new Set<number>();
  const circRows = new Map<string, number[]>();
  let anchorRows = 0;
  let slugRows = 0;
  for (let i = start; i < end; i++) {
    const s = SLUG_ANCHOR.exec(lines[i]);
    if (s) {
      slugRows += 1;
      anchorDates.add(s[1]);
      // 同名 slug 只留第一条，重复的那条由 `slugs.size < slugRows` 的断言报出来
      if (!slugs.has(s[3])) slugs.set(s[3], { date: s[1], circ: s[2] ?? '', line: i + 1 });
    }
    const a = ANCHOR.exec(lines[i]);
    if (a) {
      defLines.add(i + 1);
      anchorRows += 1;
      const key = `${a[1]} ${a[2]}`;
      const rows = circRows.get(key) ?? [];
      rows.push(i + 1);
      circRows.set(key, rows);
      if (!s) anchorNoSlug.push(i + 1);
      continue;
    }
    if (s) continue; // 无圈号但有 slug 的锚点行：合法（圈号是可选的显示编号）
    const e = ENTRY.exec(lines[i]);
    if (e) entryDates.add(e[1]);
  }
  const sameDayRepeats = [...circRows.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => `${k}（行 ${v.join(' / ')}）`);
  return {
    dates: new Set([...anchorDates, ...entryDates]),
    slugs,
    anchorRows,
    slugRows,
    anchorNoSlug,
    sameDayRepeats,
    defLines,
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
/**
 * 档 B：**版本节之间惯例不同**（见头注），故只查带 `§10` / `spec.md` 标记的引用。
 *
 * ⚠️ **刻意不含 `packages/cli/CHANGELOG.md`** —— 它是**构建产物**（`.gitignore` 里写着：
 * 「copy-assets 从仓库根拷贝，随包发布」）⇒ 它**不在版本控制里**，只在**本机磁盘**上存在。
 * 校验它的后果是实测过的（P2 落地时踩到）：本机那份还是迁移前的旧副本 ⇒ 本机跑守卫
 * **红 46 处**，而 CI / 新克隆 / `git worktree` 里**根本没有这个文件** ⇒ CI 全绿。
 * 这正是「本机读数 ≠ CI 读数」的典型来源 —— **产物一律不进射程**，它的内容由根
 * `CHANGELOG.md` 那一档覆盖，去掉它不丢覆盖。
 */
const MARKER_ONLY = ['CHANGELOG.md'];
const MARKER = /§\s*10|spec\.md/;
/**
 * **刻意的例外（具名，不靠「正则刚好没匹配到」）**：`docs/plans/**` 与 `docs/reviews/**` 是
 * 带日期的**快照**（设计稿 §2 的非目标：不改历史）⇒ 第 3 个用例（零圈号引用）不看它们。
 */
const SNAPSHOT = [/^docs\/plans\//, /^docs\/reviews\//];

const SPEC = join(repoRoot, 'docs', 'spec.md');
const FILES = [
  ...TOP_FILES.map((f) => join(repoRoot, f)),
  ...SCOPE_DIRS.flatMap((d) => walk(join(repoRoot, d))),
  ...MARKER_ONLY.map((f) => join(repoRoot, f)),
];
const MARKER_ONLY_SET = new Set(MARKER_ONLY.map((f) => join(repoRoot, f)));

test('spec §10 的引用必须可解析：引用键（一律是 slug）必须存在于 §10', () => {
  const { slugs, anchorRows, slugRows } = specAnchors();

  // 真空护栏 ①：锚点表本身不许空（解析器退化 ⇒ 下面的断言会 vacuously 全绿）
  assert.ok(
    slugs.size >= 100,
    `只解析出 ${slugs.size} 个 slug 锚点（量级下界 100，2026-10-14 实测 121）—— 解析器已失效：` +
      `要么锚点被批量回退了，要么 SLUG_ANCHOR 正则坏了（它要求「日期 [+ 圈号] + slug」）`,
  );

  // 真空护栏 ②：**「有条目但无圈号锚点」那一类必须真的还在**。它才是本守卫与「只认锚点」的分野；
  // ENTRY 判据一旦退化，这一类整片消失，而它的错引用会**静默变绿**。
  const { dates } = specAnchors();
  const unnumbered = [...dates].filter(
    (d) => !new Set([...slugs.values()].map((v) => v.date)).has(d),
  );
  assert.ok(
    unnumbered.length >= 3,
    `只解析出 ${unnumbered.length} 个「在 §10 有条目、但条目无 slug 锚点」的日期（预期 ≥ 3）` +
      ` —— ENTRY 判据退化了：给字母编号的日期硬加圈号这一类会整片漏出射程`,
  );

  let checked = 0;
  const bad: string[] = [];
  for (const file of FILES) {
    const rel = relative(repoRoot, file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(REF)) {
        if (MARKER_ONLY_SET.has(file)) {
          const before = line.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
          if (!MARKER.test(before)) continue;
        }
        checked += 1;
        const date = m[1];
        // ⚠️ 逐个校验 —— `m[2]` 是一**串** slug（见 `REF` 的说明），只查第一个会让后面那些变裸的。
        for (const key of m[2].split(/\s+/)) {
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
        }
      }
    });
  }

  // 真空护栏 ③：真扫到了引用（否则「一条都没查」也会绿）
  assert.ok(checked >= 200, `只检查到 ${checked} 处引用（预期 200+）—— 射程或正则坏了`);

  assert.deepEqual(
    bad,
    [],
    '有引用指向 §10 里不存在的锚点 —— 读者按它去查会查不到（或查到别的决策）。' +
      '改法：改成该条决策真实存在的那个 slug（先读 §10 的锚点表认主题，别按位置猜）。',
  );

  // 顺带把两个口径打在输出里 —— 它们变了（比如锚点被删）时，从日志里一眼能看出
  assert.ok(
    slugRows >= anchorRows,
    `带 slug 的锚点行(${slugRows}) 少于带圈号的锚点行(${anchorRows})，不可能（圈号行必须都有 slug）`,
  );
});

test('锚点侧：有圈号必有 slug、slug 唯一、形态合法', () => {
  const { anchorRows, slugRows, slugs, anchorNoSlug, sameDayRepeats } = specAnchors();

  // ① 「有圈号 ⇒ 有 slug」：不允许半迁移 —— 迁移已收口，但这条断言**现在反而更重要**：
  //    它挡的是「改锚点形态时只改一半」（例如想删掉显示用的圈号，结果把 slug 也删了）。
  assert.deepEqual(
    anchorNoSlug,
    [],
    `以下锚点行有圈号却没有合法 slug（半迁移状态）：行 ${anchorNoSlug.join(', ')}\n` +
      `        圈号是显示编号、slug 才是地址 —— 两个可以同时在，但**不能只有圈号**。`,
  );
  // ⚠️ P1 期这里写的是 `slugRows === anchorRows` —— 那时「有 slug 必有圈号」与「有圈号必有 slug」
  //    是同一条事实的两面。**P3 之后不再成立**：圈号已降级为**可去掉的显示编号** ⇒
  //    `slugRows > anchorRows` 是**合法**状态（锚点仍然可引，只是不再显示当天的序号）。
  //    故只保留单向的那一条（下面 ① 的 `anchorNoSlug` 为空），量级方向由 `slugRows >= anchorRows` 兜。
  assert.ok(
    slugRows >= anchorRows,
    `带 slug 的锚点行 ${slugRows} 行、带圈号的 ${anchorRows} 行 —— 前者不该更少：` +
      `有圈号的锚点行都必须有 slug（少的那一行会把一个真锚点变成不可引）`,
  );

  // ② slug 全局唯一。**取「全局」而不是设计稿说的「同日唯一」**：实测 121 个名字本就互不相同，
  //    而全局唯一换来的是一条更强的性质 —— 引用里那个「日期」写错时也能被咬住（见上一条测试）。
  assert.equal(
    slugs.size,
    slugRows,
    `带 slug 的锚点 ${slugRows} 行但只有 ${slugs.size} 个不同的名字 —— 有重名 slug。` +
      `重名会让引用解析「查到别的那条」，正是本设计要消灭的状态。`,
  );

  // ③ 形态与长度（正则已在解析时把关，这里给长度一个明确上界，防「一句话当名字」）
  const tooLong = [...slugs.entries()].filter(([s]) => s.length > 48);
  assert.deepEqual(
    tooLong.map(([s, v]) => `${s}（spec.md:${v.line}）`),
    [],
    'slug 长度超过 48 —— slug 是地址，不是标题；太长会在引用里喧宾夺主',
  );

  // ④ 同日重号：**只报不咬**（本仓有 1 处，是真历史，不改历史）。
  //    但它必须被打印出来 —— 「同一天有两个 ②」正是位置号失效的活证据，也是 slug 的收益点。
  if (sameDayRepeats.length > 0) {
    console.log(`  ℹ️ §10 同日重号 ${sameDayRepeats.length} 处（slug 能区分它们，圈号不能）：`);
    for (const r of sameDayRepeats) console.log(`     ${r}`);
  }
});

/**
 * **P3 的核心判据**：射程内（除定义行、快照、日期无条目）不许再有「日期 + 圈号」形态。
 *
 * 它守的不是「写得对不对」，而是「**这个写法还在不在**」—— 迁移的完成态应当是可机械判的，
 * 否则「改完了没有」只能靠人扫。⚠️ 三项排除都是**减法**，各自有出处（见头注「定点不咬的三类」），
 * 写成显式的三类而不是「给 `isDefLine` 加个开关」，是为了**读判据的人能顺着三项去查**。
 */
test('P3 收口：射程内（非定义行、非快照、日期有条目）不许再有「日期 + 圈号」引用', () => {
  const { dates, defLines } = specAnchors();
  const leftovers: string[] = [];
  let scanned = 0;
  for (const file of FILES) {
    const rel = relative(repoRoot, file);
    if (SNAPSHOT.some((re) => re.test(rel))) continue; // ① 快照：设计稿 §2 明说不动
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(CIRC_REF)) {
        // ② §10 的定义行：圈号在那里是**显示编号**（这是它唯一合法存在的地方）
        if (file === SPEC && defLines.has(i + 1)) continue;
        // ③ 档 B 同口径：CHANGELOG 里没带 `§10` / `spec.md` 标记的圈号指的是**本节序号**
        if (MARKER_ONLY_SET.has(file)) {
          const before = line.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
          if (!MARKER.test(before)) continue;
        }
        // ④ 该日期在 §10 没有条目 ⇒ 那个号指别的文档自己的编号（规则第一条不成立）
        if (!dates.has(m[1])) continue;
        scanned += 1;
        leftovers.push(`${rel}:${i + 1}  ${m[0]}\n        ${line.trim().slice(0, 120)}`);
      }
    });
  }

  // 真空护栏：扫到的「该被换掉的」位置数不许是 0 以外的假值 —— 这里反过来：
  // 射程里**本来就不该有**，所以没有下限护栏，但要有「真的扫过东西」的证据
  assert.ok(
    defLines.size >= 100,
    `§10 定义行只解析出 ${defLines.size} 行 —— 排除项②退化成 0 ⇒ 本用例会把定义行全报成残留`,
  );

  assert.deepEqual(
    leftovers,
    [],
    `射程内还有 ${leftovers.length} 处「日期 + 圈号」引用（P2 的替换射程口径见设计稿 §7.3）。\n` +
      `        圈号已不再是地址 ⇒ 这种写法**匹配不到任何锚点**，读者按它去查什么也查不到。\n` +
      `        改法：换成该条决策的 slug（读 §10 的锚点表；` +
      `若是「一条引用指该日多条」，用空格分隔多个 slug）。\n` +
      `        ⚠️ 若这一处是在**描述编号机制本身**（不是引用某条决策），正确的改法是**改写这句话**，\n` +
      `        而不是给它套一个 slug —— 套上去会变成一条指向错误主题的引用。`,
  );
  console.log(`  ℹ️ 残留判据：射程内扫过 ${scanned} 处「日期 + 圈号」（该值恒为 0 才通过）`);
});
