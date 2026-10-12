/*
 * 对外承诺面的守卫 —— 「版本稳定性策略」「运行环境声明」「不发布的包」。
 *
 * ## 为什么需要它
 *
 * 这三类东西有同一个形态：**它们不是代码，所以没有编译期保护；但它们是对使用者的承诺，
 * 而承诺会腐烂**（本仓的常见病，见 `docs/guards.md` 头注）。具体到本轮：
 *
 * ① **三个不发布的包被反复当成缺口上报**（评审里已经出现三次：`@migor/trace-view` /
 *    `@migor/agentia-observability` / `@migor/agentia-eval-gate`）。三个 `package.json` 都是
 *    `private: true`（有意），但**口径不齐** —— 只有 observability 那一支把「`npm i` 会 404、
 *    怎么拿到」写进了文档，另外两支要么散落在 `roadmap.md` 一句里、要么压根没写。
 *    ⇒ 下一个人照旧会去 npm 搜、拿到 E404、再报一次「缺口」。
 *    ⚠️ **登记表不止那三个**：扫描面是「盘上**所有** `private: true` 的 `@migor/*` 包」——
 *    本仓的示例包也带 `@migor/` 作用域（同样会 404）⇒ 加包就得加行。
 *    （2026-09-30 补的是 `examples/terminal-bench/`：同一类漏登记**第二次**发生，
 *    与 `examples-table` 那条守卫记的 `eval-gate` 事故同根。）
 * ② **稳定性承诺在三个面上各写一份**（仓库 `README.md`、`README.en.md`、官网 docs 页）——
 *    为什么不用单源注入：README 是 npm 页的第一阅读面、站点读者也不该跳去 GitHub，
 *    所以「两处都写」是刻意的。**代价是可能各说各话，所以必须由守卫兜底。**
 * ③ **CI 的 Node 覆盖范围散在 `ci.yml` 的多处**（matrix 的 `node: [...]` + 各 job 自己的
 *    `node-version:`），又被**四份文档**的散文复述（README / README.en / CONTRIBUTING /
 *    `docs/usage-guide.md`）。上一轮评审实测到：那句话**是真的**，但**没有任何东西盯着它**
 *    —— 矩阵一改，那四处复述立刻变成假话（且没有任何信号）。
 *    ⚠️ `usage-guide.md` 是后来扩进来的：它是**权威文档**，§7 已知边界表里复述了同一句话。
 *    射程扩到这里是**扩展**不是收紧（原本只查三处「面向 npm 读者」的面）。
 *
 * ## 反向验证（2026-09-29，逐条摘掉，各恰好点名那条）
 *
 *   ① `README.md` 的「CI 在 18/20/22 上守」改成 `18/20` ⇒ 只剩「Node 版本集合」那条红；
 *   ② `examples/eval-gate/package.json` 摘掉 `private: true` ⇒ 「集合相等」+「机读 private」两条红
 *      （同一次变异的两面：登记表里成了幽灵、盘上成了漏登）；
 *   ③ 官网把 `<section id="versioning">` 改名 ⇒ 「三处都有这一节」+「承诺锚点」+「1.0 门槛」三条红；
 *   ④ `examples/eval-gate/README.md` **整段**摘掉「先看这条」⇒ 「入口文档说了不发 npm」那条红。
 *   ⑤ 把文档里那条「数一数」命令改成零命中的模式 ⇒ 只红「命令必须真跑得出结果」那条。
 *   ⑥ `docs/usage-guide.md` 的**复述处**改成 `18/20/21` ⇒ 红「四份文档 == ci.yml」那条
 *      （把射程从三处扩到四处时补做的 —— 扩射程必须配一次变异，否则新加的那一格是**没证据**的）。
 *   ⚠️ ④ 是**先做错了一次才做对**的：第一版只删掉其中「会 404」一句，结果**全绿** —— 因为同一件事
 *   在那一节里出现了不止一次（「不发布的包」「别 `npm i`」）。**变异要摘干净**，否则测的是
 *   「这个词还在不在」，不是「这件事还说没说」。六条还原后 `git diff` 与哈希逐字节一致。
 *
 * ## 一条被守卫逼出来的真发现（写在这里，因为它是「为什么要有 ⑤」的由来）
 *
 * 起草稳定性一节时写的原话是「**没有「迁移」小节的版本，就是不需要你改代码的版本**」，
 * 配的枚举命令是 `grep -nE '^#{3,4} .*迁移'`。落地前回源核对 `CHANGELOG.md` 才发现**那句话是假的**：
 * 同一个意思在历史上有**三种形态** —— ① `### 迁移` 小节；② `### 破坏性变更 · …` 小节
 * （`0.9.0` 的脚手架模板变更）；③ **行内** `**迁移**：无（…）`（`0.8.1`~`0.8.3`）。
 * 只认 ① 的命令会**漏掉 0.9.0**（它真的有破坏性变更），也会漏掉 `0.8.2` 那句
 * 「唯一需要动作的是 `maxRetries`」。⇒ 口径改成「至少要有一段专门写它」+ **如实标注**
 * 「这条纪律是逐步收紧的、那条命令是**下限**」，并把「给命令不给数字」的理由一起写上。
 * **教训**：`grep` 的形态假设与「有没有命中」都要当场验 —— 这正是 ⑤ 存在的理由。
 *
 * ## 射程（刻意不做的部分）
 *
 * 守卫只钉**锚点是否存在**，不评价承诺写得好不好、也不检查散文的其余部分换了说法 ——
 * 换个措辞就静默失效，所以它防的是**回归与漏登记**，不是「新写错的散文」（同
 * `api-page.test.ts` 那条散文守卫的自述）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

/**
 * 从 `## <标题>` 抠到下一个同级标题（或文末）。找不到标题就抛 —— 锚点丢了必须响亮失败，
 * 返回空串会让下面所有 `includes` 断言**静默通过**（本仓吃过「空转的守卫」的亏）。
 */
function section(md: string, headingPrefix: string): string {
  const start = md.indexOf(headingPrefix);
  assert.notEqual(start, -1, `找不到标题「${headingPrefix}」—— 守卫的解析锚点没了`);
  const rest = md.slice(start + headingPrefix.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// ───────── ① 不发布的包（框架附属三包 + 带 @migor/ 作用域的示例包） ─────────

/**
 * `@migor/*` 里 `private: true` 的包 —— 机制上是「**看起来像可分发的库、实际不发**」。
 * 每一个都必须在下面 `UNPUBLISHED` 表里登记「入口文档」与「怎么拿到它」的所在，
 * 否则下一个人会去 npm 搜、拿到 E404，然后把「没发包」当成缺口报上来（已发生三次）。
 */
const UNPUBLISHED: Array<{ name: string; pkg: string; entry: string; howTo: string[] }> = [
  {
    name: '@migor/trace-view',
    pkg: 'packages/trace-view/package.json',
    entry: 'packages/trace-view/README.md',
    // 它不是「拷给你用」，而是随 CLI 一起交付（构建期拷进 CLI 的 dist/inspector/）——
    // 所以「怎么拿到它」这句话的家在 roadmap 的发布决策里。
    howTo: ['docs/roadmap.md'],
  },
  {
    name: '@migor/agentia-observability',
    pkg: 'examples/observability/package.json',
    entry: 'examples/observability/README.md',
    howTo: ['docs/observability.md'],
  },
  {
    name: '@migor/agentia-observability-mcp',
    pkg: 'examples/observability-mcp/package.json',
    entry: 'examples/observability-mcp/README.md',
    // 与上面那条同族：可观测面的示例包，靠拷目录拿到；「示例一律 `file:../..`」这条约定的家
    // 在 examples/README.md（与 terminal-bench 同款）。
    howTo: ['examples/README.md'],
  },
  {
    name: '@migor/agentia-eval-gate',
    pkg: 'examples/eval-gate/package.json',
    entry: 'examples/eval-gate/README.md',
    howTo: ['docs/eval-gate.md'],
  },
  {
    name: '@migor/agentia-terminal-bench',
    pkg: 'examples/terminal-bench/package.json',
    entry: 'examples/terminal-bench/README.md',
    // 「怎么拿到它」= 拷走整个示例目录；那条约定的家是 examples/README.md 的依赖一节
    // （示例一律 `file:../..` 指向本仓，刻意跑工作区里刚构建的那份）。
    howTo: ['examples/README.md'],
  },
];

/**
 * 私有但**不是可分发的库**的包：它们没有「怎么拿到」这回事，所以不进上面那张表。
 * 豁免必须给理由（同 `guards-registry.test.ts` 的 SHELF_EXEMPT 纪律）。
 */
const NOT_A_LIBRARY: Array<{ name: string; why: string }> = [
  {
    name: '@migor/website',
    why: '本仓库的官网站点（Cloudflare Pages 的产物），不是给别人安装的库 —— 没有「怎么拿到」这回事',
  },
];

/** 扫描仓库里所有 `@migor/*` 包（根 + `packages/*` + `examples/*`），返回 [{name, dir, isPrivate}] */
function scopedPackages(): Array<{ name: string; dir: string; isPrivate: boolean }> {
  // ⚠️ 只取**目录**：`packages/` 与 `examples/` 下还有 README.md / .gitkeep 这类文件，
  // 不筛会让 `read('<file>/package.json')` 抛 ENOTDIR（实测踩过）。
  const subdirs = (base: string) =>
    readdirSync(join(repoRoot, base), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${base}/${e.name}`);
  const dirs = ['.', ...subdirs('packages'), ...subdirs('examples')];
  const out: Array<{ name: string; dir: string; isPrivate: boolean }> = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(read(`${dir}/package.json`)) as { name?: string; private?: boolean };
    if (pkg.name?.startsWith('@migor/')) {
      out.push({ name: pkg.name, dir, isPrivate: pkg.private === true });
    }
  }
  return out;
}

describe('不发布的包：`private: true` 是机制，文档口径是承诺', () => {
  it('扫描器至少看到两个已发布包 + 一个私有包（防「扫了个空」的假绿）', () => {
    const all = scopedPackages();
    assert.ok(all.length >= 6, `只扫到 ${all.length} 个 @migor/* 包 —— 目录扫描坏了`);
    assert.ok(
      all.some((p) => !p.isPrivate),
      '一个已发布包都没扫到 —— 扫描器大概率读错了目录',
    );
  });

  it('盘上「私有 @migor/* 包」的集合 == 登记表（双向：不许有幽灵，也不许漏登）', () => {
    const exempt = new Set(NOT_A_LIBRARY.map((e) => e.name));
    for (const e of NOT_A_LIBRARY) {
      assert.ok(e.why.length > 10, `NOT_A_LIBRARY 里 '${e.name}' 的豁免理由太短，等于没写`);
    }
    const onDisk = new Set(
      scopedPackages()
        .filter((p) => p.isPrivate && !exempt.has(p.name))
        .map((p) => p.name),
    );
    const listed = new Set(UNPUBLISHED.map((u) => u.name));
    const unlisted = [...onDisk].filter((n) => !listed.has(n));
    const invented = [...listed].filter((n) => !onDisk.has(n));
    assert.deepEqual(
      unlisted,
      [],
      `这些 @migor/* 包是 private（不发 npm），却不在本文件的 UNPUBLISHED 表里：\n  ${unlisted.join('\n  ')}\n` +
        '  ⇒ 要么把它的「入口文档 / 怎么拿到它」补进表里，要么加进 NOT_A_LIBRARY（并写清为什么它不是可分发的库）。',
    );
    assert.deepEqual(
      invented,
      [],
      `UNPUBLISHED 表里的这些包已经不存在或已经发布：${invented.join(', ')} —— 幽灵登记，请删掉`,
    );
  });

  it('每个不发布的包都标注了 `private: true`（机读事实，不是散文）', () => {
    for (const u of UNPUBLISHED) {
      const pkg = JSON.parse(read(u.pkg)) as { private?: boolean; name?: string };
      assert.equal(pkg.name, u.name, `${u.pkg} 的 name 是 ${pkg.name}，与表里对不上`);
      assert.equal(
        pkg.private,
        true,
        `${u.pkg} 没有 private: true —— 它会被 publish 出去，而文档里说它不发布（两处必须同向）`,
      );
    }
  });

  it('每个不发布的包的**入口文档**都说了「不发 npm / 会 404」', () => {
    for (const u of UNPUBLISHED) {
      const doc = read(u.entry);
      assert.match(
        doc,
        /不发布|不单独发布|没有发布到 registry|会 \*\*404\*\*|404/,
        `${u.entry} 没有说清「${u.name} 不发 npm」—— 这就是它被反复当成缺口上报的原因`,
      );
    }
  });

  it('每个不发布的包都写了「怎么拿到它」（拷目录 / `file:` / 随 CLI 交付）', () => {
    for (const u of UNPUBLISHED) {
      const text = [u.entry, ...u.howTo].map(read).join('\n');
      assert.match(
        text,
        /file:|拷贝|拷走|拷进|拷/,
        `${u.entry} 与 ${u.howTo.join(' / ')} 都没写「怎么拿到 ${u.name}」—— ` +
          '只说「不发布」会把使用者留在死路上',
      );
    }
  });
});

// ───────────────────────── ② 稳定性承诺：三个面互为镜像 ─────────────────────────

/** 三个面上都必须出现的承诺锚点（换了说法就说明有人在改承诺，那时应该改这一行，而不是静默放行） */
const COMMON_ANCHORS: Array<{ label: string; re: RegExp }> = [
  { label: '破坏性变更必须留痕（「迁移」小节）', re: /迁移|migration/ },
  { label: 'CHANGELOG 是迁移的唯一住所', re: /CHANGELOG\.md/ },
  { label: '公共 API 的真源', re: /src\/index\.ts/ },
  { label: '运行环境声明', re: /engines\.node/ },
  { label: '零运行时依赖的守卫', re: /no-runtime-deps\.test\.ts/ },
];

/** 1.0 的三条门槛（中英各一份措辞 —— 英文 README 是摘要，用词天然不同） */
const GATES: Array<{ label: string; re: RegExp }> = [
  { label: 'spec §11 开放项清零', re: /§11/ },
  { label: 'guards §2 待守清零', re: /§2/ },
  { label: '连续 3 个 minor 无破坏性变更', re: /3 个 minor|three consecutive minors/ },
];

function promiseSurfaces(): Array<[string, string]> {
  return [
    ['README.md', section(read('README.md'), '## 稳定性与版本策略')],
    ['README.en.md', section(read('README.en.md'), '## Stability & versioning')],
    [
      '官网 docs 页',
      section(read('packages/website/src/fragments/docs.html'), '<section id="versioning">'),
    ],
  ];
}

describe('稳定性承诺在 README / README.en / 官网三处互为镜像', () => {
  it('三处都有这一节（少一处 = 有一类读者看不到承诺）', () => {
    assert.match(read('README.md'), /^## 稳定性与版本策略$/m, 'README.md 缺「稳定性与版本策略」节');
    assert.match(
      read('README.en.md'),
      /^## Stability & versioning$/m,
      'README.en.md 缺「Stability & versioning」节 —— 英文读者拿不到同一份承诺',
    );
    assert.match(
      read('packages/website/src/fragments/docs.html'),
      /<section id="versioning">/,
      '官网 docs 页缺 id="versioning" 那一节',
    );
  });

  it('承诺锚点三处都在（抽段锚点坏了会先在这里红）', () => {
    for (const [label, body] of promiseSurfaces()) {
      assert.ok(body.length > 400, `${label} 的稳定性一节只有 ${body.length} 字符 —— 抽段锚点坏了`);
      for (const anchor of COMMON_ANCHORS) {
        assert.match(
          body,
          anchor.re,
          `${label} 的稳定性一节里缺「${anchor.label}」—— 三个面开始各说各话`,
        );
      }
    }
  });

  it('1.0 的三条门槛三处都在（不是只在 README 里）', () => {
    for (const [label, body] of promiseSurfaces()) {
      for (const gate of GATES) {
        assert.match(body, gate.re, `${label} 里缺 1.0 门槛「${gate.label}」`);
      }
    }
  });

  it('官网的侧栏导航里有这一节的锚点（加了节不加导航 = 读者找不到）', () => {
    const html = read('packages/website/src/fragments/docs.html');
    assert.ok(
      html.includes('href="#versioning"'),
      '官网 docs 侧栏没有 href="#versioning" —— 节在、入口不在',
    );
  });

  it('三个面给的那条「数一数」命令必须真跑得出结果（zero 命中的命令 = 变相撒谎）', () => {
    // 为什么不只是「命令写在那里」：本仓的旧账里**最贵的一类**就是静默零命中（BSD grep 不支持
    // `\|` 交替，被当字面量 ⇒ 看着像「不存在」）。文档给一条**匹配不到任何东西**的命令，
    // 效果与写错数字一样：读者照着敲、看到空、以为「一次迁移都没有」。
    const changelog = read('CHANGELOG.md');
    for (const [label, body] of promiseSurfaces()) {
      const m = /-nE[^']*'([^']+)'/.exec(body);
      assert.ok(
        m,
        `${label} 里找不到那条「数一数」命令（\`grep -nE '…' CHANGELOG.md\`）—— 解析锚点坏了`,
      );
      const hits = changelog.match(new RegExp(m[1], 'gm')) ?? [];
      assert.ok(
        hits.length >= 1,
        `${label} 给的命令 \`grep -nE '${m[1]}'\` 在 CHANGELOG.md 上**零命中** —— ` +
          '读者会以为「一次要做动作的迁移都没有」，而那是命令写错了',
      );
    }
  });
});

// ───────────────────────── ③ CI 的 Node 覆盖范围 ─────────────────────────

/** 从散文里抠出 `CI 在 18/20/22 上守` / `CI runs 18 / 20 / 22` 那串版本号 */
function docNodeVersions(where: string): string[] {
  // ⚠️ 逐行扫、**收集全部命中并要求它们一致**：这几处都是长文档，同一件事会在多处被复述
  // （`usage-guide.md` 的已知边界表就复述了一次），只取「第一个匹配」会在复述处先说漏嘴时静默放行。
  const found = new Set<string>();
  for (const line of read(where).split('\n')) {
    const m = /CI[^\n]{0,24}?(\d+(?:\s*\/\s*\d+)+)/.exec(line);
    if (m)
      found.add(
        m[1]
          .split('/')
          .map((s) => s.trim())
          .join('/'),
      );
  }
  assert.ok(
    found.size >= 1,
    `${where} 里找不到「CI 在 18/20/22 上守」这类句子 —— ` +
      '这句话是给使用者的运行环境承诺，别把它删了；要改写就同步改本守卫的解析锚点',
  );
  assert.equal(
    found.size,
    1,
    `${where} 里有 ${found.size} 处**互相矛盾**的 CI 版本号：${[...found].join(' | ')} —— 复述之处必须一起改`,
  );
  return [...found][0].split('/');
}

/** 从 ci.yml 抠出实际会被 CI 跑到的所有 Node 版本（matrix + 各 job 的 node-version） */
function ciNodeVersions(): string[] {
  const yml = read('.github/workflows/ci.yml');
  const out = new Set<string>();
  for (const m of yml.matchAll(/node-version:\s*'?(\d+)'?/g)) out.add(m[1]);
  for (const m of yml.matchAll(/node:\s*\[([^\]]*)\]/g)) {
    for (const v of m[1].split(',')) {
      const n = v.trim().replace(/['"]/g, '');
      if (/^\d+$/.test(n)) out.add(n);
    }
  }
  return [...out].sort();
}

describe('运行环境承诺：四份文档与 ci.yml 一致', () => {
  it('ci.yml 里读得到版本集合（防「抽词器退化」的假绿）', () => {
    const versions = ciNodeVersions();
    assert.ok(
      versions.length >= 2,
      `ci.yml 只解析到 ${versions.length} 个 Node 版本 —— 解析锚点坏了`,
    );
  });

  it('四份文档写的 CI 版本集合 == ci.yml 实际跑的集合', () => {
    const actual = ciNodeVersions();
    // ⚠️ `docs/usage-guide.md` 也在射程内：它是**权威文档**，§7 已知边界表里复述了同一句话。
    //    把它纳进来是**扩展**射程、不是收紧（名单与理由见文件头注 ③）。
    for (const where of ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'docs/usage-guide.md']) {
      const claimed = docNodeVersions(where);
      assert.deepEqual(
        claimed.slice().sort(),
        actual,
        `${where} 说 CI 在 ${claimed.join('/')} 上守，而 ci.yml 实际是 ${actual.join('/')} —— ` +
          '改矩阵时漏改了这句话（此前**没有任何东西盯着它**，所以它静默腐烂过一次）',
      );
    }
  });

  it('engines.node 的下限必须真的在 CI 里被跑到', () => {
    const min = /"node":\s*">=\s*(\d+)"/.exec(read('package.json'))?.[1];
    assert.ok(min, 'package.json 的 engines.node 读不出下限 —— 解析锚点坏了');
    assert.ok(
      ciNodeVersions().includes(min),
      `engines 声明支持 Node >= ${min}，但 CI 从没在那个版本上跑过 —— ` +
        '「声明支持」与「验证过」不能是两回事（EOL 的版本还留在 engines 里就是这一类）',
    );
  });
});
