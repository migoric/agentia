/*
 * 官网双语（中 / 英）的**语言面**守卫 —— 2026-10-08 官网英文版。
 *
 * 背景：站点此前是中文单语，本轮全站对译成 `/en/*`（5 页 + 404，逐节对译）。两版**共用同一套
 * 客户端脚本**（`scrollspy` / `hero-trace` / `trace-player` / `playground*`）⇒「哪些东西必须在
 * 两版之间逐字相同」与「哪些必须不同」是本文件唯一的机器判据。设计依据
 * `docs/plans/2026-10-08-website-i18n.md` §6。
 *
 * 守四类：
 *   ① **页面集合一一对应**：5 页 + 404 在中英两侧都有，且英文页引用的是**它自己那一页**的
 *      fragment（复制粘贴最容易错的一步）。
 *   ② **结构不随语言变**：中英 fragment 的 `id` 集合逐页相等（脚本靠 `id` 找 DOM）；
 *      演示剧本的骨架（span id / parent / kind / 事件类型 / 顺序 / usage）逐例相等 ——
 *      这正是 `packages/website/src/scripts/scenarios.js` 头注里对读者承诺过的那条判据。
 *   ③ **英文面不出现中文**：英文 fragment 剥掉代码块后不含 CJK；更要紧的是**真跑**客户端脚本
 *      与 BYOK playground，断言英文下写进 DOM 的字符串一个中文字符都没有（中文下则有）。
 *   ④ **语言机制在场且方向正确**：`<html lang>` 随页；**客户端**的 `location.replace` 检测脚本
 *      **已下线**（2026-10-09 搬到服务端 `_worker.js` 的 302 —— 它留在每一页 HTML 里，会让
 *      AFDocs 的 `redirect-behavior` 逐页判 `js-redirect` FAIL）；Nav 的切换控件写 **`hl` cookie**
 *      （服务端读它，让「显式选择」优先于 `Accept-Language` 自动跳转，否则英文浏览器点「中」
 *      会被弹回 `/en` 形成循环）；`/en` 已登记进 sitemap / llms.txt / `_worker.js`。
 *      ⚠️ 302 的**行为**（目标 / `Vary` / 循环防线）不在本文件射程内，由
 *      `tests/docs/website-lang-negotiation.test.ts` **真跑** worker 守 —— 这里只问
 *      「客户端那段还在不在、cookie 有没有写上」。
 *
 * ⚠️ 为什么②③用**子进程**真跑（`tests/fixtures/website-i18n-harness.mjs`）：客户端脚本的语言在
 * **import 期**就定了（`packages/website/src/scripts/lang.js` 顶层读 `<html lang>`），而 ESM 按
 * URL 缓存模块 ⇒ 同一进程里改 `document` 再 import 第二次（换语言）拿到的是**第一次那份缓存副本**。
 * 子进程是唯一能真跑两遍的办法。
 *
 * ⚠️ **射程（如实标注）**：本守卫**不逐字面量审计** `playground*.js` 的「有没有漏包 `pt()`」——
 * 那需要 JS 解析器，而本仓 `typescript` 是 **7.x（tsgo）**，主入口 `exports["."]` 已指向
 * `lib/version.cjs`（经典 `createSourceFile` API 不再从主入口导出），`acorn` 也不在依赖里。
 * 手写扫描器在本仓**当场翻过车**：`playground.js` 里有 `/^\s*```/` 与 `/[&<>"']/g`
 * （正则里带反引号 / 引号），字符级扫描一路错位（实测 24 处假命中）。⇒ 改用**行为面**：
 * 真跑脚本，看英文下有没有中文漏出来。它能抓到「新增一段没包 `pt()` 的中文文案」（前提是那段
 *
 * ── 机制细节与变异清单（2026-10-17 从 `docs/guards.md` 的注册表行**搬回真源**：
 *    那一行曾 3423 码点、逼近 `doc-budget` 的 `MAX_ROW = 3600`；表格留摘要 + 指针，
 *    细节归这里 —— 这是 `doc-budget.test.ts` 头注写明的首选修法「精简 / 指回真源」）──
 *
 * 四类判据：① 5 页 + 英文 404 两侧都有文件，且每个英文页的 `<Base …>` 真带 `lang='en'`、import 的是**它自己那一页**的 fragment（⚠️ `lang` 必须从 `<Base …>` 标签里取：这些文件的**头注释里也写着** `lang='en'`，裸正则会被注释顶替 —— 第一版就这么假绿，变异验证当场抓到）；② 中英 fragment 的 `id` 集合逐页相等 + 剧本骨架（span id / parent / kind、事件类型与顺序、`usage`）逐例相等，且每个场景的标题**必须不同**（证明 `pt()` 真生效、不是两边贴了同一串）；③ **行为面**：英文 fragment 剥掉 `<pre>`/`<code>`/`<script>` 后 0 个 CJK，且**不含第二份「已知边界」表**（`<!--LIMITS_TABLE-->` / `limits-table` 只许在中文 fragment；英文页用「说明 + 指回 `docs/usage-guide.md` §7」替代 —— 那张表是构建期从中文单源摘的，手抄一份必然漂移）；**真跑** `scenarios.js` 与 `playground-real.js`（假 DOM + 假 `fetch` 驱动**一次工具往返 + 一次 401**），断言英文下写进 DOM 的字符串、菜单参数、请求体的 `system` 与工具 `description` **一个中文字符都没有**、中文下则 >200（双向防真空）；④ `<html lang>` 映射 + 三处 `hreflang` 互指（`x-default` 必须指中文版）+ 英文地址由**当前页**的干净路径派生（不是写死首页）+ **客户端 `location.replace` 检测脚本已下线**（2026-10-09 搬到服务端 302；断言打在**两层剥壳**后的源码上：`stripHtmlComments` + `stripJsCommentLines`，因为「已下线」这句说明本身就写在注释里、不剥会把断言按反方向骗过）且不再出现 `agentia-lang` + Nav 切换控件写 **`hl` cookie**（只在**真的 onclick 处理器**里找 —— Nav 注释里就写着 `localStorage`，整文件 grep 会被那句说明按反方向骗过） + 五条 `/en` 路由已登记进 `sitemap.xml.ts` / `llms.txt.ts` / `_worker.js`（`/en/` → `/en` 308）—— 最后一格只核**登记**（分支在场 + 是 `308`），**不核实现写法**：2026-10-08 为给那条 308 补 `cache-control` 把 `Response.redirect()` 换成显式 `new Response()`（行为等价），原先钉整条表达式的断言**红了** ⇒ 钉实现的字面量会把「等价改写」判成回归；行为（状态码 / 目标 / 缓存头 / 不动 `ASSETS`）由 `website-markdown-negotiation.test.ts` 真跑守着。**反向验证过 21 条（各恰好点名那条，复原后 `sha256` 逐字节一致）**：英文页引用错 fragment / 英文 fragment 少一个 `id` / 剧本 span id 被 `pt()` 本地化 / `playground-real.js` 一处文案漏包 `pt()` / 英文 fragment 散文里塞中文 / 英文 docs 页塞一份 `limits-table`（反向：中文页摘掉 `<!--LIMITS_TABLE-->` 注入锚点）/ 英文 system 提示换成中文 / 检测脚本改成会写 localStorage / 去掉「拿不到就不跳」的早退 / 检测脚本改用 `location.href`（留下历史条目）/ `x-default` 指英文 / 英文地址写死首页（`enPath` 不走 `cleanPath`）/ sitemap 少一条 `/en` / `llms.txt` 去掉英文节 / `_worker.js` 去掉 `/en/` 规范化 / Nav 切换不写 localStorage / 英文页 `lang` 改回 `zh`（`api` 与 `404` 各一次）；**2026-10-08 新增 2 条**：真调用删掉、换成一行写着同样字面量的**注释**（⚠️ **旧判据会被注释喂绿 —— 已实测**：变异体里未剥注释的原文含 `location.replace(`、剥掉整行注释后为 0）/ 剥壳器退化成恒等函数 ⇒ 自证断言红；**2026-10-09**：④ 那两条断言随「客户端跳转下线」重写，旧的 3 条「检测脚本」变异（改成会写 localStorage / 去掉早退 / 改用 `location.href`）已不适用，**重做 2 条**（Nav 退回 `localStorage` / Base 加回客户端脚本）各恰好点名对应断言，见下一行的服务端守卫。⚠️ 其中 ① 的第一版**是假守卫**：`assert.match(文件, /lang='en'/)` 被**头注释里的同一串**满足（同本仓记过的「同一字面量在两处出现」形态）—— 改成从 `<Base …>` 标签里取后才咬住
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(repoRoot, 'packages', 'website');
const PAGES_SRC = join(WEB, 'src', 'pages');
const FRAG_SRC = join(WEB, 'src', 'fragments');
const SCRIPT_SRC = join(WEB, 'src', 'scripts');
const HARNESS = join(repoRoot, 'tests', 'fixtures', 'website-i18n-harness.mjs');

/** 中英一一对应的页面（404 单列：它没有 fragment） */
const PAGES = ['index', 'docs', 'api', 'playground', 'tradeoffs'];

/** 中文字符（含扩展 A 区与兼容表意区） */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

const read = (p: string) => readFileSync(p, 'utf8');
const countCjk = (s: string) => (s.match(new RegExp(CJK.source, 'g')) ?? []).length;

/**
 * 两层「剥壳」，给 ④ 那组「某段代码**在不在**」的断言用（2026-10-09 从「某段代码在场」翻成
 * 「某段代码已下线」后仍需要它们）：
 *
 *   · `stripHtmlComments` 去 HTML 注释（`<!-- … -->`）—— 本仓**两个方向都踩过**：
 *     一条注释把断言喂**绿**（① 的 `lang='en'` 被头部注释满足），以及一条**说明性**注释把断言
 *     喂**红**（注释里照写那段代码的字面量，而代码已删）。
 *   · `stripJsCommentLines` 去**整行**的 `// …` 与 `/* … *\/`（Base.astro 的 frontmatter 里
 *     就有 `//` 注释）。
 *
 * 为什么必须两层都剥：正则不认识代码与注释 —— 断言 `!/location\.replace\s*\(/` 问的是
 * 「**代码里**还有没有」，而注释里同样能出现这个字面量，方向任一边都会骗人。
 *
 * ⚠️ 边界（如实标注）：**按行**判定，不处理「代码同一行尾部的 `// …`」。要触发上面那些断言，
 * 行内混合形态仍须**同一行里真有那段代码** —— 所以按行剥已经挡掉了「一条独立注释骗过断言」
 * 这个现实形态。不写字符级扫描器：本仓实测它会在正则/字符串字面量里错位（见头注「射程」那段）。
 * 「剥壳器自己是活的」由紧跟其后的**两条**自证断言负责 —— 任一层退化成恒等函数时它们会红。
 */
const stripHtmlComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');

const stripJsCommentLines = (js: string): string => {
  const out: string[] = [];
  let inBlock = false;
  for (const line of js.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
};

// 自证：拿一段含注释的样本跑一遍。少了它，剥壳器哪天退化成恒等函数也没人知道，
// 而那种「退化」不会红、只会让 ④ 那组断言悄悄回到「可被注释满足」的状态。
assert.equal(
  stripHtmlComments('a<!-- location.replace( -->b'),
  'ab',
  'stripHtmlComments 退化了（没剥掉 HTML 注释）',
);
assert.equal(
  stripJsCommentLines('a;\n// location.replace(\n/* if (!known) return; */\nc;'),
  'a;\nc;',
  'stripJsCommentLines 退化了（没剥掉整行注释）',
);

/** 剥掉代码块与 <script>，只留散文（英文页里这些位置不该有中文） */
const stripCode = (html: string) =>
  html
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<code\b[\s\S]*?<\/code>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ');

/** 抽 DOM 锚点：`id="…"`（前面必须有空白/行首，免得把 `data-id="…"` 也算进来） */
const idsOf = (html: string) =>
  [...html.matchAll(/(?:^|\s)id="([^"]+)"/g)].map((m) => m[1] as string);

interface Scenario {
  id: string;
  title: string;
  menu: Array<{ name: string }>;
  script: Array<Record<string, unknown>>;
}

/** 在指定页面语言下真跑一个客户端模块（子进程；理由见头注） */
function runScenarios(lang: string): Scenario[] {
  const out = execFileSync(
    process.execPath,
    [HARNESS, lang, pathToFileURL(join(SCRIPT_SRC, 'scenarios.js')).href, 'scenarios'],
    { encoding: 'utf8', cwd: repoRoot },
  );
  return (JSON.parse(out) as { scenarios: Scenario[] }).scenarios;
}

interface ByokRun {
  written: string[];
  menus: string[];
  systems: string[];
  tools: Array<{ name: string; description?: string }>;
}

/** 在指定语言下真跑 BYOK playground（假 DOM + 假 fetch：一次工具往返 + 一次 401） */
function runPlaygroundReal(lang: string): ByokRun {
  const out = execFileSync(
    process.execPath,
    [HARNESS, lang, pathToFileURL(join(SCRIPT_SRC, 'playground-real.js')).href, 'playground-real'],
    { encoding: 'utf8', cwd: repoRoot },
  );
  return JSON.parse(out) as ByokRun;
}

/** 剧本骨架：事件类型 + 结构 id（**不含**文案 —— 文案本来就该随语言变） */
const EVENT_KINDS = [
  'think',
  'menu',
  'spanStart',
  'spanEnd',
  'llmOpen',
  'stream',
  'tool',
  'result',
  'note',
  'finalOpen',
  'done',
];

function skeleton(script: Array<Record<string, unknown>>): string {
  return script
    .map((ev) => {
      const kind = EVENT_KINDS.find((k) => k in ev) ?? 'wait';
      if (kind === 'spanStart') {
        const s = ev.spanStart as Record<string, unknown>;
        return `${kind}|${s.id}|${s.parent}|${s.kind}|${s.name}`;
      }
      if (kind === 'spanEnd') {
        const s = ev.spanEnd as Record<string, unknown>;
        return `${kind}|${s.id}|${s.ms}|${JSON.stringify(s.usage)}`;
      }
      if (kind === 'menu') return `${kind}|${ev.menu}`;
      if (kind === 'tool') {
        const t = ev.tool as Record<string, unknown>;
        return `${kind}|${t.name}|nested=${t.nested === true}`;
      }
      if (kind === 'result') {
        const r = ev.result as Record<string, unknown>;
        return `${kind}|nested=${r.nested === true}`;
      }
      if (kind === 'llmOpen') {
        const l = ev.llmOpen as Record<string, unknown>;
        return `${kind}|nested=${l.nested === true}`;
      }
      return kind;
    })
    .join('\n');
}

describe('官网双语：路由与页面集合一一对应', () => {
  it('中英两版每页都有页面与 fragment（5 页 + 英文 404）', () => {
    for (const p of PAGES) {
      assert.ok(existsSync(join(PAGES_SRC, `${p}.astro`)), `中文页缺失：src/pages/${p}.astro`);
      assert.ok(
        existsSync(join(FRAG_SRC, `${p}.html`)),
        `中文 fragment 缺失：src/fragments/${p}.html`,
      );
      assert.ok(
        existsSync(join(PAGES_SRC, 'en', `${p}.astro`)),
        `英文页缺失：src/pages/en/${p}.astro`,
      );
      assert.ok(
        existsSync(join(FRAG_SRC, 'en', `${p}.html`)),
        `英文 fragment 缺失：src/fragments/en/${p}.html`,
      );
    }
    assert.ok(
      existsSync(join(PAGES_SRC, 'en', '404.astro')),
      '英文 404 页缺失：src/pages/en/404.astro',
    );
  });

  it('每个英文页都声明 lang="en"，且引用的是它自己那一页的 fragment', () => {
    for (const p of PAGES) {
      const s = read(join(PAGES_SRC, 'en', `${p}.astro`));
      // ⚠️ lang 必须从 `<Base …>` 标签里取：这些文件的**头注释里也写着** `lang='en'`
      // （»comes from Base.astro with lang='en'«），裸正则会被注释顶替 —— 变异验证当场抓到过。
      const baseTag = /<Base\b[\s\S]*?>/.exec(s)?.[0] ?? '';
      assert.ok(baseTag, `src/pages/en/${p}.astro 里找不到 <Base …> 标签`);
      assert.match(baseTag, /lang=['"]en['"]/, `src/pages/en/${p}.astro 的 <Base> 没有 lang='en'`);

      const imported = /import\s+content\s+from\s+['"]([^'"]+)['"]/.exec(s)?.[1];
      assert.equal(
        imported,
        `../../fragments/en/${p}.html?raw`,
        `src/pages/en/${p}.astro 引用的 fragment 不是它自己那一页（复制粘贴漏改）`,
      );
    }
    const f404 = read(join(PAGES_SRC, 'en', '404.astro'));
    assert.match(
      /<Base\b[\s\S]*?>/.exec(f404)?.[0] ?? '',
      /lang=['"]en['"]/,
      'src/pages/en/404.astro 的 <Base> 没有 lang="en"',
    );
  });
});

describe('官网双语：结构不随语言变', () => {
  it('中英 fragment 的 id 集合逐页相等（共用脚本靠 id 取 DOM）', () => {
    let total = 0;
    for (const p of PAGES) {
      const zh = idsOf(read(join(FRAG_SRC, `${p}.html`)));
      const en = idsOf(read(join(FRAG_SRC, 'en', `${p}.html`)));
      total += zh.length;
      assert.deepEqual(
        [...new Set(en)].sort(),
        [...new Set(zh)].sort(),
        `fragments/en/${p}.html 的 id 集合与中文页不一致 —— ` +
          'scrollspy / trace-player / playground 都是按 id 找 DOM 的，缺一个就是英文页那一块不动',
      );
    }
    assert.ok(total >= 70, `只抽到 ${total} 个 id —— 抽取器退化了（本守卫在空转）`);
  });

  it('演示剧本的骨架（span id / 事件类型 / 顺序 / usage）逐例相等', () => {
    const zh = runScenarios('zh-CN');
    const en = runScenarios('en');
    assert.equal(zh.length, en.length, '两种语言下场景数量不一致');
    assert.ok(zh.length >= 3, `只有 ${zh.length} 个场景 —— 抽取器退化了`);

    let events = 0;
    for (let i = 0; i < zh.length; i++) {
      const z = zh[i] as Scenario;
      const e = en[i] as Scenario;
      events += z.script.length;
      assert.equal(z.id, e.id, `第 ${i} 个场景的 id 不一致`);
      assert.equal(
        JSON.stringify(z.menu.map((m) => m.name)),
        JSON.stringify(e.menu.map((m) => m.name)),
        `场景 ${z.id} 的菜单项名字/顺序在两种语言下不一致（能力名是标识符，不该本地化）`,
      );
      assert.equal(
        skeleton(z.script),
        skeleton(e.script),
        `场景 ${z.id} 的骨架在两种语言下不一致 —— 跨语言只该换文案，不该换结构`,
      );
      assert.notEqual(
        z.title,
        e.title,
        `场景 ${z.id} 的标题在两种语言下相同 —— pt() 没生效（英文页会显示中文）`,
      );
    }
    assert.ok(events >= 50, `只对拍了 ${events} 个事件 —— 抽取器退化了`);
  });
});

describe('官网双语：英文面不出现中文散文', () => {
  it('英文 fragment 剥掉代码块后不含 CJK', () => {
    for (const p of PAGES) {
      const raw = read(join(FRAG_SRC, 'en', `${p}.html`));
      const prose = stripCode(raw);
      assert.ok(
        prose.length > 2000,
        `fragments/en/${p}.html 剥壳后只剩 ${prose.length} 字符 —— 剥多了？`,
      );
      assert.equal(
        countCjk(prose),
        0,
        `fragments/en/${p}.html 的散文里还有中文（代码块内保留原命令是允许的，散文里不行）`,
      );
    }
  });

  it('英文 docs 页不摆第二份「已知边界」表（单源承诺）', () => {
    const zh = read(join(FRAG_SRC, 'docs.html'));
    const en = read(join(FRAG_SRC, 'en', 'docs.html'));
    assert.ok(
      zh.includes('<!--LIMITS_TABLE-->'),
      '中文 docs 页的 <!--LIMITS_TABLE--> 注入锚点没了',
    );
    assert.ok(
      !en.includes('LIMITS_TABLE'),
      'fragments/en/docs.html 出现了注入锚点（英文页没有注入逻辑）',
    );
    assert.ok(
      !/limits-table/.test(en),
      '英文 docs 页摆了第二份「已知边界」表 —— 那张表是构建期从**中文**单源摘的，手抄一份必然漂移' +
        '（本仓既定纪律：站点上不出现第二份手写说明）',
    );
    assert.ok(
      en.includes('<section id="limits">') && en.includes('/llms-full.txt'),
      '英文 docs 页既没有那张表、也没有「指回单源」的说明 —— 读者拿不到边界',
    );
  });

  it('演示剧本以英文跑：一个中文字符都不出现（中文跑则有）', () => {
    const en = JSON.stringify(runScenarios('en'));
    const zh = JSON.stringify(runScenarios('zh-CN'));
    assert.equal(countCjk(en), 0, '英文页的演示剧本会显示中文 —— 有文案没走 pt()');
    assert.ok(countCjk(zh) > 200, `中文剧本只跑出 ${countCjk(zh)} 个 CJK —— 探针没跑到文案？`);
  });

  it('BYOK playground 以英文真跑（一次工具往返 + 一次 401）：写进 DOM 的字符串无中文', () => {
    const en = runPlaygroundReal('en');
    const zh = runPlaygroundReal('zh-CN');

    // 防真空：这一轮必须真跑到文案（否则「英文无中文」是空转）
    assert.ok(en.written.length >= 25, `英文只捕获到 ${en.written.length} 条写入 —— 交互没跑起来`);
    assert.ok(en.menus.length >= 1, '没捕获到 renderMenu 的参数（真实工具菜单没跑到）');
    assert.ok(en.systems.length >= 1, '没捕获到请求体（agent 循环没跑到）');
    assert.ok(en.tools.length >= 3, `只捕获到 ${en.tools.length} 个工具 schema`);

    const enText = [
      ...en.written,
      ...en.menus,
      ...en.systems,
      ...en.tools.map((t) => t.description ?? ''),
    ].join('\n');
    assert.equal(countCjk(enText), 0, '英文页的 playground 会显示中文 —— 有文案没走 pt()');

    const zhText = [...zh.written, ...zh.menus, ...zh.systems].join('\n');
    assert.ok(
      countCjk(zhText) > 200,
      `中文 playground 只跑出 ${countCjk(zhText)} 个 CJK —— 探针没跑到文案？`,
    );

    // 语言相关的 system 提示也必须是英文那份（它不渲染给访客，但决定了模型用什么语言回答）
    assert.match(
      en.systems[0] ?? '',
      /Answer in English\./,
      '英文页发出的 system 提示不是英文那份',
    );
    assert.match(zh.systems[0] ?? '', /用中文回答/, '中文页发出的 system 提示不是中文那份');
  });
});

describe('官网双语：语言机制在场且方向正确', () => {
  it('Base.astro：<html lang> 随页，三处 hreflang 互指且 x-default 指中文', () => {
    const base = read(join(WEB, 'src', 'layouts', 'Base.astro'));
    assert.match(base, /const htmlLang = isEn \? 'en' : 'zh-CN';/, '缺少 lang → html lang 的映射');
    assert.ok(base.includes('<html lang={htmlLang}>'), '<html lang> 没有接线');
    assert.ok(base.includes('hreflang="zh-CN"'), '缺少 hreflang="zh-CN"');
    assert.ok(base.includes('hreflang="en"'), '缺少 hreflang="en"');
    assert.match(
      base,
      /hreflang="x-default" href=\{zhUrl\}/,
      'x-default 必须指中文版（站点默认入口）',
    );
    // 「另一种语言」的地址必须由**当前页**的干净路径派生，而不是写死首页
    assert.match(
      base,
      /const enPath = isEn \? cleanPath :/,
      '英文地址没有从当前页派生（写死了？）',
    );
    assert.match(base, /const zhPath = isEn \? cleanPath\.replace/, '中文地址没有从当前页派生');
  });

  it('Base.astro：客户端语言跳转已下线（HTML 里不再有 JS 跳转）', () => {
    const base = read(join(WEB, 'src', 'layouts', 'Base.astro'));
    // 断在**两层剥壳之后**的源码上：本文件既有 HTML 注释也有 frontmatter 的 `//` 注释，
    // 而「已下线」这句说明本身就出现在注释里 —— 不剥壳，一条写着同样字面量的注释就能把断言
    // 按**反方向**骗过（假红 / 假绿两形态本仓都踩过，见 stripHtmlComments 的头注）。
    const code = stripJsCommentLines(stripHtmlComments(base));
    assert.ok(
      !/location\.replace\s*\(/.test(code),
      'Base.astro 里又有客户端跳转了 —— 它是 is:inline 的、留在**每一页** HTML 里，' +
        'AFDocs 的 redirect-behavior 会逐页判 js-redirect FAIL（语言协商归服务端 _worker.js）',
    );
    assert.ok(
      !base.includes('agentia-lang'),
      'Base.astro 还在用 localStorage["agentia-lang"] —— 语言记录现在只有 cookie `hl` 一处',
    );
    // 行为侧（302 的目标 / `Vary` / 循环防线）由 tests/docs/website-lang-negotiation.test.ts
    // **真跑** worker 守；这里只问「客户端那段还在不在」。
  });

  it('Nav.astro：切换控件在场，两个链接指向同页的另一种语言，且切换时写 `hl` cookie', () => {
    const nav = read(join(WEB, 'src', 'components', 'Nav.astro'));
    assert.ok(nav.includes('class="lang-switch"'), 'Nav 里没有语言切换控件');
    assert.ok(nav.includes('href={zhHref}'), '切换控件没有指向中文地址');
    assert.ok(nav.includes('href={enHref}'), '切换控件没有指向英文地址');
    // 写入的必须是**服务端读得到的** cookie（`hl`，path=/）：服务端 _worker.js 靠它把
    // 「显式选择」置于 `Accept-Language` 自动跳转之上（缺它就有循环）。
    // ⚠️ 只在**真的 onclick 处理器**里找（不看整文件）：Nav 的注释里就写着 `localStorage`
    // （说明「不再用它」），整文件 grep 会被那句说明按反方向骗过 —— 本仓两个方向都踩过。
    const handlers = [...nav.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1] as string);
    const onclick = handlers.join('\n');
    assert.equal(
      handlers.length,
      2,
      `切换控件的 onclick 处理器应有 2 个，实际 ${handlers.length} 个`,
    );
    assert.ok(
      onclick.includes("'hl=zh;path=/"),
      '点「中」没有写下 hl=zh cookie（显式选择优先的输入）—— 只写 localStorage 的话服务端读不到',
    );
    assert.ok(onclick.includes("'hl=en;path=/"), '点「EN」没有写下 hl=en cookie');
    assert.ok(
      !onclick.includes('localStorage'),
      'Nav 的切换控件仍在写 localStorage —— 语言记录现在只有 cookie `hl` 一处（服务端读它）',
    );
    assert.ok(
      nav.includes('hreflang="zh-CN"') && nav.includes('hreflang="en"'),
      '切换链接缺少 hreflang',
    );
  });

  it('/en 已登记进 sitemap、llms.txt 与 _worker.js（`/en/` → `/en` 规范化）', () => {
    const enRoutes = ['/en', '/en/docs', '/en/api', '/en/playground', '/en/tradeoffs'];

    const sitemap = read(join(PAGES_SRC, 'sitemap.xml.ts'));
    for (const r of enRoutes) {
      assert.ok(sitemap.includes(`path: '${r}'`), `sitemap.xml.ts 没有登记 ${r}`);
    }

    const llms = read(join(PAGES_SRC, 'llms.txt.ts'));
    assert.ok(llms.includes('Documentation (English)'), 'llms.txt.ts 没有英文文档节');
    for (const r of enRoutes) {
      assert.ok(llms.includes(`abs('${r}')`), `llms.txt.ts 没有登记 ${r} 的绝对链接`);
    }

    const worker = read(join(WEB, 'public', '_worker.js'));
    assert.ok(worker.includes("url.pathname === '/en/'"), '_worker.js 没有 /en/ 的规范化分支');
    // ⚠️ 这里只核**登记**（分支在场 + 是 308），**不核实现写法**。
    //    原先它钉的是 `Response.redirect(new URL('/en', url).href, 308)` 这条完整表达式 ——
    //    2026-10-08 为了给这条 308 补 `cache-control` 把它换成显式的 `new Response(...)`，
    //    实现等价、行为没变，这条断言却红了（改对的代码被一条文本钉住）。**钉实现的字面量
    //    会把「换个等价写法」判成回归** —— 与 ① 里 `lang='en'` 那条正好是同一枚硬币的两面：
    //    那条太松（被注释满足），这条太紧（被实现绑架）。
    //    行为那半边（状态码 / 目标 / 缓存头 / 不去问 ASSETS）交给
    //    `tests/docs/website-markdown-negotiation.test.ts` **真跑** worker 守 —— 文本层不重复钉。
    assert.match(
      worker,
      /status:\s*308/,
      '_worker.js 的 /en/ 规范化不是 308（扁平产物 en.html，没有 en/index.html）',
    );
  });
});
