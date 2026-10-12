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
     */
    'view.js': 334,
    /**
     * 219 行纯 CSS。它有**自己**的不变量门禁（`test/style.test.js`：窄缝压扁、
     * caret 藏进 hover 这两处**只存在于 CSS** 的已发布缺陷），但那守的是**规则存在**、
     * 不守体量 ⇒ 行数这道还得另设。
     */
    'trace-view.css': 219,
    /**
     * 173 行。`playTrace` 81 行**不该按行数判大**：它是「把线性 span 事件序列应用成
     * 一棵树」的状态机式回放，行数来自分支（start/end/event × 类型识别 × usage 归一），
     * 不是来自耦合。
     */
    'fromTrace.js': 173,
    /**
     * 2026-10-12（G7 护栏行 —— **新功能**）：106 → 126（+20）。
     * 实测构成（`git diff -U0` 数的）：新增 21 行、改写 1 行 ⇒ 净 +20；新增里 12 行是注释或
     * 空行、9 行是代码。那 9 行 = `approval.decided` 的聚合分支（取体 / 计数 / 判拒绝 / 计时）+
     * 文件头数据来源补一行；剩下 12 行全是**口径边界**的注（只聚 decided 不聚 requested、
     * 缺 waitedMs 记 0 不编造、被拒算 errors 但不是系统错误）。
     * ⚠️ 这一笔的性质：新功能，但**改动面很小**（审批不建 span ⇒ 只能从事件聚，反而省了）。
     */
    'summary.js': 126,
    /** 纯 re-export（4 个导出面），本就该极小 —— 它一变大就是导出面在乱长。 */
    'index.js': 14,
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
    const body = src.slice(
      src.indexOf('const LINE_BUDGET = {'),
      src.indexOf('const LINE_BUDGET = {') + 2000,
    );
    const keys = [...body.matchAll(/^\s*'([^']+)':\s*\d+/gm)].map((m) => m[1]);
    assert.equal(new Set(keys).size, keys.length, `LINE_BUDGET 有重复键：${keys.join(', ')}`);
  });
});
