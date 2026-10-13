/**
 * **副本闸**（2026-10-14）：生产源码里**跨文件的成段重复**必须被登记。
 *
 * ## 为什么要有它
 *
 * 本仓反复踩的同一个形态是「**同一份事实在两处各写一遍**」，而它此前**没有任何守卫** ——
 * 三次实例都靠人读出来：`tests/architecture/source-size.test.ts` 头注表里的读数、
 * `CHANGELOG.md` 两个版本节的圈号惯例、`docs/spec.md` 里同一天条目两种写法（见
 * `docs/guards.md` §1.4 的圈号引用那一行）。**逐条修实例 ≠ 关掉这一类**。
 *
 * 同一类里**最贵的一支**是代码副本：改了 `src/` 的一份、忘了 `packages/` 的另一份 ——
 * 产物层面看起来全绿（CLI 跑的是它自己那份），直到使用者拿到两份行为不同的东西。
 * 本仓对这支已有一条成熟解法（**去类型移植副本 + 逐字对拍**，见下面 `KNOWN` 里那三条），
 * 但解法**只覆盖已经记得住的那几对**；新写一对时没人会告诉你。
 *
 * ## 口径（先落口径，再落数）
 *
 * - **单位 = 归一化之后的「代码行」**：丢空行、丢整行注释、折掉缩进与行内多余空白。
 *   折缩进是必须的 —— 跨文件副本常因层级不同而整块缩进差一级，那是同一份代码。
 * - **块 = 连续 `WINDOW` 行**。`WINDOW` 是这条闸唯一的旋钮，取值来历见下。
 * - **射程 = 生产源码**（框架的 `src/`，以及每个附属包自己的 `src/`；后缀取 `.ts` / `.tsx` /
 *   `.mjs` / `.js`）。
 *   **刻意不含 `tests/**`**：用例里天然有大量重复的断言样板，收进来只有噪声，而没有信号。
 *   **也刻意不含 `scripts/**`**：那是开发期夹具与 e2e 样板（2026-10-14 实测 10 对重复、最大一片
 *   46 段 —— 同款假端点 / HTTP 样板），重复是它们的**写法**，而不是「改一处就得看另一处」的事实。
 *
 * ## `WINDOW = 12` 是怎么定的（2026-10-14 实测，不是拍的）
 *
 * 用同一量具在 N = 8 / 12 / 16 / 20 各跑一遍，看**生产源码**里的文件对数量与构成：
 *
 * | N | 生产源码里的重复对 | 读法 |
 * |---|---|---|
 * | 8 | 7 对（多出 `skill.ts ↔ subagent.ts`、`mcp-http.ts ↔ mcp-stdio.ts` 这类**结构性同形**） | 太松：把「两个能力包装器长得像」也算进来 |
 * | 12 | **5 对**（全部是**真会一起改**的那种：三份移植副本 + 两份共享样板） | 取它 |
 * | 16 | 4 对 | |
 * | 20 | 3 对（只剩那三份已声明的移植副本） | 太紧：`store.ts ↔ fsStore.ts` 那份 12 行的同源实现会漏出去 |
 *
 * ⇒ 12 行是「同形」与「同源」的分界：N = 8 收进来的是形状相似，N = 12 收进来的是**改一处
 * 就该看另一处**的那种。**收紧与放宽各只有一个后果**：收紧（调大 N）会让真副本静默漏出射程，
 * 放宽（调小 N）会把结构性同形报成违规 —— 那时正解是登记 + 写清理由，不是把 N 调回去。
 *
 * ## 登记不是免检：`KNOWN` 表要过三关
 *
 * 表里每一对都必须**仍被探测到**（否则是**幽灵豁免** —— 有人把它们去重了却忘了删表项），
 * 且 `why` 必须写清「为什么这份重复可以接受」。有 `syncedBy` 的，那个文件必须真实存在、
 * 且**提到了这一对里的某一个文件名**（指向一个跟这件事无关的文件不算数）。
 *
 * ⚠️ **如实标注射程**：`syncedBy` 那一条只判「那个文件提到了这一对里的某个名字」，
 * **判不了「那条断言真的守着同步」**。真正的证据在那个守卫文件自己身上
 * （本仓的移植副本对拍都带变异验证记录，见 `docs/guards.md` §1.4 对应行）。
 *
 * ⚠️ **本闸只判「有没有成段的逐字重复」**，判不了**语义副本**：同一个事实用两种写法各讲一遍
 * （本仓最常见的那一类，三次实例全是这种）**一行都不重复** ⇒ 它挡不住。别因为「有副本闸了」
 * 就跳过「这句话在别处是不是也写了一份」的人工核对。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 连续多少行归一化代码算一个「块」。来历见头注那张实测表。 */
const WINDOW = 12;

/** 防真空：射程里的文件数下限（2026-10-14 实测 150+，取一个保守的大数） */
const MIN_FILES = 100;

const CODE_EXTS = new Set(['.ts', '.tsx', '.mjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', 'coverage', 'templates']);

/**
 * 归一化成「代码行」：丢空行与**整行注释**，折掉缩进与行内空白。
 *
 * ⚠️ 折缩进是**必须**的：跨文件副本常因所在层级不同而整块差一级缩进 —— 那是同一份代码，
 * 不折的话这条闸对「抄了一个方法到另一个类里」这种最常见的形态完全瞎。
 * 折行内空白同时消掉对齐式排版带来的假差异。
 */
function codeLines(text: string): string[] {
  const out: string[] = [];
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
    out.push(s.replace(/\s+/g, ' '));
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(p, acc);
    } else if (CODE_EXTS.has(extname(entry.name))) {
      acc.push(p);
    }
  }
  return acc;
}

/** 射程 = 框架的 `src/` + 每个附属包自己的 `src/`（发现式：新包自动进射程）。 */
function scopedFiles(): string[] {
  const roots = [join(repoRoot, 'src')];
  for (const entry of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(join(repoRoot, 'packages', entry.name, 'src'));
  }
  const files: string[] = [];
  for (const root of roots) {
    try {
      files.push(...walk(root));
    } catch {
      // 该包没有 src/（纯资源包）⇒ 不是错误，跳过
    }
  }
  return files;
}

/**
 * 登记表：生产源码里**已知**的成段重复。每一对都要写清「为什么可以接受」；
 * 有机器同步机制的，把那个文件写进 `syncedBy`、并声明它盯的是哪个 `symbol`。
 *
 * ⚠️ 用**符号名**而不是文件名来指认：本仓的守卫文件点的是 `exportRun` / `diffTraces`
 * 这类**导出名**，而不是 `export.ts` 这种路径 —— 第一版按文件名判，两条都误红。
 */
const KNOWN: Array<{ a: string; b: string; syncedBy?: string; symbol?: string; why: string }> = [
  {
    a: 'src/engine/trace-diff.ts',
    b: 'packages/cli/src/diff.ts',
    syncedBy: 'packages/cli/test/diff.test.mjs',
    symbol: 'diffTraces',
    why:
      '**去类型移植副本**：CLI 零运行时依赖、不能 import 框架，所以把 diff 算法整份抄了一份。' +
      '这是本仓**有意选定**的做法（不是失手），配套的是产物逐字对拍 + 变异验证，' +
      '见 docs/guards.md §1.4 与 packages/cli/test/diff.test.mjs。',
  },
  {
    a: 'src/eval/harvest.ts',
    b: 'packages/cli/src/harvest.ts',
    syncedBy: 'packages/cli/test/harvest.test.mjs',
    symbol: 'harvestEvalCase',
    why:
      '同上：`harvestEvalCase` 的去类型移植副本（六组夹具逐字对拍）。' +
      '两侧必须一起改，改生成格式只改一边会被对拍当场咬住。',
  },
  {
    a: 'src/eval/export.ts',
    b: 'packages/cli/src/export.ts',
    syncedBy: 'packages/cli/test/export.test.mjs',
    symbol: 'exportRun',
    why:
      '同上：`exportRun` 的去类型移植副本（产物逐字对拍）。' +
      '它的头注自己就写着「正文逐行相同」，本行的作用是让那句话**被机器盯着**而不是靠读。',
  },
  {
    a: 'packages/cli/src/harvest.ts',
    b: 'packages/cli/src/export.ts',
    why:
      '两份 CLI 命令共享的**入参解析 + 读文件样板**（同一个作者同一天写的两条命令：' +
      '「未知参数 → 抛带 USAGE 的错」「读不到文件 → 换成人话」）。' +
      '**尚无同步机制**，也**刻意先不去重**：抽成公共件要动 packages/cli 的规模棘轮账' +
      '（`packages/cli/test/structure.test.mjs` 的 LINE_BUDGET），值得单独一轮 —— ' +
      '已同时登记进 `docs/guards.md` §2 待守，免得「登记过」被读成「已经安全」。',
  },
  {
    a: 'src/store/store.ts',
    b: 'src/store/fsStore.ts',
    syncedBy: 'tests/store/taskStore-copy.test.ts',
    symbol: 'byIdempotency',
    why:
      '两份内存索引各写一遍同样的 `get` / `byIdempotency` / `list` / `clear`（都落在 ' +
      '`byTask` / `byKey` 两张表上）。**同步机制在行为层而不在文本层**：副本契约用例' +
      '按实现名遍历（`InMemoryTaskStore` 与 `FileTaskStore` 各跑一遍），改坏任一侧都会红。',
  },
];

describe('副本闸：生产源码里跨文件的成段重复必须登记（口径与旋钮来历见头注）', () => {
  const files = scopedFiles();

  /** key = 一整块归一化代码 → 出现在哪些文件（带首次行号，便于报错定位） */
  const blocks = new Map<string, Array<{ file: string; line: number }>>();
  for (const abs of files) {
    const lines = codeLines(readFileSync(abs, 'utf8'));
    const file = abs.slice(repoRoot.length + 1);
    for (let i = 0; i + WINDOW <= lines.length; i++) {
      const key = lines.slice(i, i + WINDOW).join('\n');
      const hits = blocks.get(key) ?? [];
      hits.push({ file, line: i + 1 });
      blocks.set(key, hits);
    }
  }

  /** 文件对（字典序，`|` 连接）→ 共享块数 */
  const pairs = new Map<string, number>();
  for (const hits of blocks.values()) {
    const distinct = [...new Set(hits.map((h) => h.file))].sort();
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const key = `${distinct[i]}|${distinct[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  it('真空护栏：射程真扫到了，且探测真的看得见重复（否则下面全是假绿）', () => {
    assert.ok(
      files.length >= MIN_FILES,
      `只扫到 ${files.length} 个源文件（预期 ≥ ${MIN_FILES}）—— 递归或后缀判据坏了，闸已失效`,
    );
    // 承重：本仓**已知存在**的移植副本必须在探测结果里 —— 这一条同时证明「归一化没有
    // 把所有东西都抹成一样」（真抹平的话那份副本也会消失，那就该改量具而不是改这里）
    assert.ok(
      pairs.has('packages/cli/src/diff.ts|src/engine/trace-diff.ts'),
      '探测不到已知的 diff 移植副本 —— 要么归一化坏了，要么这两个文件不再重复（后者请同步改 KNOWN）',
    );
    assert.ok(
      pairs.size >= 3,
      `只探测到 ${pairs.size} 个重复文件对（预期 ≥ 3）—— 阈值或量具退化了`,
    );
  });

  it('未登记的重复文件对 ⇒ 红（新写一对副本时，必须做一次判断）', () => {
    const known = new Set(KNOWN.map((e) => [e.a, e.b].sort().join('|')));
    const unregistered = [...pairs.keys()].filter((k) => !known.has(k)).sort();
    assert.deepEqual(
      unregistered,
      [],
      `这些文件对出现了 ≥ ${WINDOW} 行逐字重复，但没人登记过：\n${unregistered
        .map((k) => `    ${k}（共享块 ${pairs.get(k)} 段）`)
        .join('\n')}\n` +
        '  ⇒ 二选一，**必须显式**：\n' +
        `     ① 去重 —— 抽成公共件（本仓既有做法：mcp-protocol.ts / http-io.ts / source-scan.ts）；\n` +
        '     ② 登记 —— 在 tests/architecture/duplicated-blocks.test.ts 的 KNOWN 里加一行，' +
        '写清「为什么这份重复可以接受」，有机器同步机制的把那个文件写进 `syncedBy`。\n' +
        '  ⚠️ 别把 WINDOW 调大来消掉它 —— 那会让**别的**真副本一起静默漏出射程。',
    );
  });

  it('登记表不是免检：每一项都必须仍被探测到（幽灵豁免要删）', () => {
    const stale = KNOWN.filter((e) => !pairs.has([e.a, e.b].sort().join('|'))).map(
      (e) => `${e.a} ↔ ${e.b}`,
    );
    assert.deepEqual(
      stale,
      [],
      `这些登记项已经探测不到重复了 —— 要么有人把它们去重了（好事，请删掉这一行），` +
        `要么文件名改了（请改成新名）：\n  ${stale.join('\n  ')}`,
    );
  });

  it('登记项的理由要写清楚（太短等于没写）', () => {
    const thin = KNOWN.filter((e) => e.why.trim().length < 30).map((e) => `${e.a} ↔ ${e.b}`);
    assert.deepEqual(thin, [], `这些登记项的理由太短，等于没写：\n  ${thin.join('\n  ')}`);
  });

  it('`syncedBy` 声明的同步机制必须成立：文件在、且那个符号真的被它盯着', () => {
    const read = (p: string): string | undefined => {
      try {
        return readFileSync(join(repoRoot, p), 'utf8');
      } catch {
        return undefined;
      }
    };
    const bad: string[] = [];
    for (const e of KNOWN) {
      const pair = `${e.a} ↔ ${e.b}`;
      if (e.syncedBy === undefined) {
        if (e.symbol !== undefined) bad.push(`${pair}：声明了 symbol 却没有 syncedBy`);
        continue; // 无同步机制的重复：允许登记，但理由必须写清它的风险（长度下限见上一条用例）
      }
      if (e.symbol === undefined) {
        bad.push(`${pair}：有 syncedBy 就必须同时声明它盯的是哪个符号（symbol）`);
        continue;
      }
      // ⚠️ 必须**取出来存成常量**再用：`e.symbol` 的收窄在下面的**回调**里会失效
      //（tsc 看不到「闭包执行时它一定不是 undefined」）⇒ 直接用它会被 typecheck:tests 拦下。
      const symbol = e.symbol;
      const guard = read(e.syncedBy);
      if (guard === undefined) {
        bad.push(`${pair}：syncedBy 指向的 ${e.syncedBy} 不存在`);
        continue;
      }
      // ① 那个文件必须真的在盯这个符号 —— 否则它是被随手填进来的
      if (!guard.includes(symbol)) {
        bad.push(`${pair}：${e.syncedBy} 里找不到 ${symbol} —— 它并没有在盯这一对`);
      }
      // ② 那个符号必须真的活在这一对里（至少一侧） —— 否则这条登记指错了对象
      const inPair = [e.a, e.b].filter((p) => read(p)?.includes(symbol) === true);
      if (inPair.length === 0) {
        bad.push(`${pair}：符号 ${symbol} 在两侧都不存在 —— 这条登记指错了对象`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      `登记表里的「同步机制」有一项不成立：\n  ${bad.join('\n  ')}\n` +
        '  ⚠️ 本断言判的是「那个文件提到了这个符号」。它**判不了**「那条断言真的守着同步」' +
        '（符号在场不等于断言有效）—— 那要靠守卫文件自己的变异验证记录，别把本条当地一份。',
    );
  });
});
