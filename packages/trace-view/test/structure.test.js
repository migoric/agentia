import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `packages/trace-view` 结构守卫 —— 规模棘轮（本仓 `packages/cli/test/structure.test.mjs`
 * 同款纪律，**独立一份**而不是共用：两个包的形状/门槛不同，合并会让其中一边的
 * 基线被另一边的文件数拖着走）。
 *
 * ⚠️ **为什么这道守卫在本仓是必需的**（不是「体量大所以要管」）：
 * 2026-10-05 实测 `packages/trace-view/src/` = 846 行、测试 904 行 —— **体量完全健康**，
 * 当时完全可以不管它。但**缺这道守卫**意味着「它开始变大时没人会知道」——
 * 而 2026-09-23 刚在 CLI 上治过一模一样的病（`dev.ts` 长到 1148 行、长出隐式状态机，
 * 靠人工回看才发现）。⇒ **这条守卫买的不是「今天的健康」，是「变大的那一刻有人被叫醒」。**
 *
 * 与框架侧 `tests/architecture/source-size.test.ts` 的分工：那份钉 `src/`（框架内核），
 * 本份钉 `packages/`（附属渲染器与 CLI）—— **互不覆盖，别以为对方在管这个目录。**
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

describe('trace-view 结构守卫（W1 规模棘轮）', () => {
  // 基线 = 2026-10-05 实测（`wc -l packages/trace-view/src/*`）。纪律与 CLI 那份一致：
  // 存量条目只能**往下**调（拆分真做完了才调），新增文件**必须**在这里登记
  //（不登记 ⇒ 下面「每个文件都在表里」那条断言会红）。
  const LINE_BUDGET = {
    /**
     * 2026-11-11（**新功能：结构化展开正文**）：五个数字一起动，构成本笔一次说清 ——
     * 目的只有一个，把「展开是一大坨无缩进的 JSON」换成有层级、有着色、可复制的块。
     *
     * - `view.js` 334 → **349**（+15）：展开分支拆两档（`structured` 判定 3 行、结构化块挂载
     *   3 行、`full` 双形态的 import 与头注 9 行）。**没有把渲染逻辑塞进来** —— 那部分在
     *   新文件里，这里只留「什么时候挂」的判定，这正是 `renderTrace` 该管的事。
     * - `fromTrace.js` 181 → **190**（+9）：`eventFull` 从「返回序列化字符串」改成「返回原值」
     *   （代码 4 行、口径注 5 行）。不改这条路的话，渲染器永远只看到字符串，结构化就无从发生。
     * - `trace-view.css` 219 → **283**（+64）：`.tr-full` 整组规则（块容器 / 头部 / 行 / 缩进 /
     *   四类值的着色）+ `tr-structured` 隐藏 `.tr-io` 那一条。零新增选择器层级技巧
     *   （不用 `:has()`，靠 JS 打 class），因为要同时活在三处宿主里。
     * - `index.js` 14 → **19**（+5）：`createFullView` 进公共面。**不是导出面在乱长** ——
     *   bundle 的导出面必须与这里逐字一致（`test/bundle.test.js`），所以被渲染器内部调用、
     *   又确实可独立使用的这一件必须登记；其余三个内部件已刻意不导出。
     * - `full-view.js` **184**（新增）：结构化正文渲染器本体（纯 DOM 构造、零依赖）。
     *
     * 判据是「能否抽出独立职责」而不是「行数好看」：这个件与树的构建/状态机无关，入参是任意值、
     * 出参是一个元素，抽出去之后 `view.js` 的闭包状态没有变复杂 —— 所以抽，而不是抬 view.js 的顶。
     *
     * 2026-11-11 晚（**第二档：折叠 / 成表 / 路径**，同一笔功能的续做）：三个数字再动一次 ——
     * `view.js` 349 → **360**（+11）、`trace-view.css` 283 → **363**（+80）、
     * `full-view.js` 182 → **369**（+187）。逐项对账：
     *
     * - `view.js` +11 = `folds` 表与其「为什么必须活在渲染之外」的注（+3）、挂块处的取/建
     *   （+7）、`reset` 里的 `folds.clear()`（+2）、删掉上一轮重复的一行注释（-1）。
     *   **仍然只做「什么时候挂」的判定，没有把块内渲染搬进来。**
     * - `trace-view.css` +80 = 表格整组（表头/单元格/hover/5 档 `data-depth` 缩进，约 45）、
     *   `⧉` 与折叠 caret/hint 的样式（约 30）。表格缩进只能靠属性选择器：列数是动态的，
     *   没有能写死的 inline style（测试用的 DOM stub 也没有 `style` 字段）。
     * - `full-view.js` +187（369 行里代码 231、注释 101、空行 37）：`pathOf` + `copyInto` +
     *   `pathBtn`（约 45）、`tableColsOf` + `renderTable`（约 60）、折叠分支与 `isOpen`
     *   （约 35）、头部「第二档要解决什么 / 五条边界」的口径注（约 35）。
     *   **没有拆成两个文件**：成表那部分要用 `fvEl` / `primitive` / `pathOf` / `pathBtn` 四件，
     *   拆出去就得把三件提成公共件、或当参数传 —— 换来的是两个文件互相 import，
     *   而职责并没有真的分开（都是「任意值 → DOM」这一件事）。
     */
    /**
     * 334 行。里面 `createTraceView` 的**闭包方法群**占大头（最大一块是
     * `renderTrace` **88 行**，`view.js:108-195`）—— 一棵树的状态机，**天然会长**。
     *
     * 拆分的判据不是行数而是「能否抽出纯判定」。⚠️ 这里原先写的是「`renderTrace` 里
     * 真正纯的那块（行元数据计算）**已抽出**」—— **实测证伪**（2026-10-05）：树形前缀
     * 计算（`:115-128`）与行元数据组装（`:156-196`）**目前仍是内联的**，纯函数只有
     * `capabilityTypeOf` / `fmtNum` / `fmtMs` / `fmtArg` / `rawArg` 那一组（`:23-65`）。
     * ⇒ 「把 `renderTrace` 的纯判定抽出去」这件事**没做**（体检时列的收益最小项，
     * 刻意后放）；真要抽，先说清哪些是状态、哪些能算纯函数，别为了减行数而搬。
     * 而 `test/tree.test.js` 已经能**直接跑真实渲染器**验这三条行为 ⇒ 抽纯判定的
     * 边际价值进一步下降（行为覆盖不靠它）。
     *
     * 2026-11-12 晚（**宿主注入的正文 / Markdown**）：360 → 385（+25）。构成：`opts.textBody`
     * 的取用与「为什么必须是注入」的头注（+5）、`textBodyOf` 包装（只在展开时调用 + 宿主
     * 抛错回落原文，+11）、事件分支里 `mdBody` / `blocked` 两行与口径注（+9）。
     * ⚠️ 这里**仍然没有解析器**：多出来的每一行都是「哪种正文走哪条路」的判定。
     */
    'view.js': 385,
    /**
     * 375 行纯 CSS（2026-11-11 晚：283 → 363，表格与折叠/路径的样式，对账见上；
     * 2026-11-12：363 → 375，`.tr-full-json` 标记，12 行；同一日晚：375 → 386，
     * `.tr-full-md` 标记 11 行 —— 与 `str→json` 同一套外观，样式分叉会让人以为它们是
     * 不同性质的东西）。
     * 它有**自己**的不变量门禁（`test/style.test.js`：窄缝压扁、
     * caret 藏进 hover 这两处**只存在于 CSS** 的已发布缺陷），但那守的是**规则存在**、
     * 不守体量 ⇒ 行数这道还得另设。
     */
    'trace-view.css': 386,
    /**
     * 173 行。`playTrace` 81 行**不该按行数判大**：它是「把线性 span 事件序列应用成
     * 一棵树」的状态机式回放，行数来自分支（start/end/event × 类型识别 × usage 归一），
     * 不是来自耦合。
     *
     * 2026-10-21（ref-view-single-file-html 的**修复**）：173 → 181（+8）。
     * 空 spans 也要 `reset`（早先直接 `return`，切换 trace 时旧树留在页面上 → 用户看到
     * 别人的 trace）。净 +8 里 6 行是「为什么空树也要清」的注（口径类注，与 summary.js
     * 那几笔同类），2 行是代码（取 label + reset）。**行为修复，不是新功能**；基线随之抬到
     * 181，没有留下松弛（实测 181 = 基线）。
     */
    'fromTrace.js': 190,
    /**
     * 2026-10-12（G7 护栏行 —— **新功能**）：106 → 126（+20）。
     * 实测构成（`git diff -U0` 数的）：新增 21 行、改写 1 行 ⇒ 净 +20；新增里 12 行是注释或
     * 空行、9 行是代码。那 9 行 = `approval.decided` 的聚合分支（取体 / 计数 / 判拒绝 / 计时）+
     * 文件头数据来源补一行；剩下 12 行全是**口径边界**的注（只聚 decided 不聚 requested、
     * 缺 waitedMs 记 0 不编造、被拒算 errors 但不是系统错误）。
     * ⚠️ 这一笔的性质：新功能，但**改动面很小**（审批不建 span ⇒ 只能从事件聚，反而省了）。
     *
     * 2026-10-12 ref-guardrail-hitl-scan（护栏行在真实 HITL 主流程零产出的**修复**）：126 → 130（+4）。
     * `approval.decided` 的扫面从「限 llm.turn」放宽为不限 kind —— 恢复段把它记在 run 根
     * （续跑入口把 run 根 id 当 turnId）。净 +4 全是**注释**（头注 +2、循环内判据注 +2）：
     * 代码行数**零增长**（`const isTurn` 换掉 `if (span.kind !== 'llm.turn') continue;`，
     * 工具分支的判据内移成 `!isTurn || e.name !== 'tool.output'`）。
     *
     * 2026-10-13 ref-reject-static-methods（E1 嵌套 capability 重复计数的**修复**）：130 → 153（+23）。
     * usage 只认顶层 capability（没有 capability 祖先的）：spanId 索引 + 上爬判定
     * `hasCapabilityAncestor`（约 12 行代码），其余是头注口径说明。棘轮上调是**显式**的
     * —— 判据本身需要一张 parent 表，没有更省的写法。
     */
    'summary.js': 153,
    /** 纯 re-export（5 个导出面，2026-11-12 加 `hasStructuredBody`），本就该极小 ——
     *  它一变大就是导出面在乱长。 */
    'index.js': 20,
    /**
     * 结构化正文渲染件，纯 DOM 构造、零依赖、无状态。
     *
     * 2026-11-11：新增 369（第一档结构化 + 折叠 / 成表 / 路径复制）。
     * 2026-11-12：369 → 449（+80）—— 「字符串里套着 JSON」按容器铺开。构成：判据
     * `jsonInString`（首尾字符 + 长度上限 + parse 容错，约 20 行）、`str→json` 标记
     * （约 8 行）、`hasStructuredBody` 谓词与头注、`renderInto` 的 `allowParse` 一档
     * （「只解析一层」的实现）、`createFullView` 的字符串根分支（头部写「string · N 字符
     * → object · M 项」、复制取原文）。代码约 45 行，其余是口径注 —— 这一段每个判据都
     * 对应一类会被读错的事实，删注释比删代码更容易出事故。
     *
     * 2026-11-12 晚（**宿主注入的正文 / Markdown**）：449 → 478（+29）。构成：`opts.body`
     * 一档（注入就原样挂、**不再铺树**，+10）、`mdBadge`「你看到的不是原样」的告示（+7）、
     * 头部第三档「string · N 字符」与复制取原文（+6）、头注第 5 条与边界（+6）。
     * ⚠️ 本文件**没有 Markdown 解析器**，也永远不该有：解析器只有一份（在宿主里），
     * 这里多出来的行只做「把宿主节点挂上去」+「标出来它被渲染过」。
     */
    'full-view.js': 478,
  };

  it('W1 规模棘轮：单文件不超基线、每个文件都登记在表', () => {
    const files = readdirSync(SRC);
    const problems = [];
    for (const f of files) {
      // 与 `wc -l` 同口径：数换行符（文件末的尾换行使 `split('\n').length` 会多 1）
      const lines = (
        readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').match(/\n/g) ?? []
      ).length;
      const budget = LINE_BUDGET[f];
      if (budget === undefined) {
        problems.push(`新文件 ${f} 没在 LINE_BUDGET 里登记（新增文件必须显式登记基线）`);
      } else if (lines > budget) {
        problems.push(`${f} 超了：${lines} 行 > 基线 ${budget}（棘轮只许降不许升）`);
      }
    }
    // 反向：表里有、盘上没了 ⇒ 基线该调低（登记项失效后守卫会「看起来在管」而实际不管）
    for (const f of Object.keys(LINE_BUDGET)) {
      if (!files.includes(f))
        problems.push(`LINE_BUDGET 里的 ${f} 不存在了（文件被删/ 改名 ⇒ 调低或删该条）`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('本守卫自己别腐化：基线表不许出现重复键', () => {
    // ⚠️ 抄CLI 那份的同款教训（`structure.test.mjs` 踩过）：JS 对象字面量里**重复键后者
    // 覆盖前者且静默** —— 插一行「新的 334」而旧的还在，上面那条断言照样绿，但基线已不是
    // 你以为的那个。⚠️ **别指望 ESM 替你挡住**：ES6 起对象字面量的重复键是**合法**的
    //（只有严格模式下重复 `__proto__` 才是 SyntaxError）—— 实测 `{ a: 1, a: 2 }` 放进
    // `.mjs` 是 exit 0、输出 `{ a: 2 }`。⇒ **这条断言是重复键的唯一防线**，不是备份：
    // 变异实测（在表尾补一行重复键）时「单文件不超基线」那条**照样绿**（后写的值覆盖前者，
    // 反而更宽松），只有这里会红。
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // ⚠️ 原先按 `+ 2000` 字符切窗口：表一长，尾部条目就滑出射程而这条断言照样绿 ——
    // 那正是「守卫看起来在管、实际不管」。按对象字面量的结束位置切，与表长解耦。
    const start = src.indexOf('const LINE_BUDGET = {');
    const body = src.slice(start, src.indexOf('};', start));
    const keys = [...body.matchAll(/^\s*'([^']+)':\s*\d+/gm)].map((m) => m[1]);
    assert.equal(new Set(keys).size, keys.length, `LINE_BUDGET 有重复键：${keys.join(', ')}`);
  });
});
