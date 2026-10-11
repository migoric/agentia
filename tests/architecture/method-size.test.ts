import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { filePicture } from './lib/callable-spans.js';

/**
 * **方法级体量闸**（2026-10-11，框架深度 review 建议①；兄弟闸 `source-size.test.ts` 管文件级）。
 *
 * ## 为什么要有它
 *
 * 文件级已经有闸（单文件「含代码行」≤ 750），但**方法级没有**：实测 `src/` 里有 47 个
 * 可调用体 ≥ 60 行、7 个 ≥ 200 行，而闸只看得见文件。文件级闸的盲区正好是最大那一档的
 * 生长方式 —— 一个工厂/状态机把周边所有东西都吞进自己的花括号里，**文件总行数几乎不变**。
 *
 * ## 判据怎么定下来的（⚠️ 先跑真实读数，再落笔 —— 这是本仓纪律）
 *
 * 下面这张表是**定阈值那一次的读数**（2026-10-11，`main` @ `a263ba0`，即**修之前**的形状；
 * **两把尺对拍**：`lib/callable-spans.ts` 与结构体检技能的 `method-size.py` 在全部 13 行上
 * **逐字相等** ⇒ 读数可信）。⚠️ **别拿它当当期读数** —— 表中 265 / 257 / 252 三个数在本闸
 * 落地时已被修掉。
 *
 * **要当期读数**（无需任何额外脚本，本仓内自足）：把下面 `MAX_CALLABLE_LINES` 临时改成 `0`
 * 再跑本文件 ⇒ 断言报错里逐文件列出它的**最大体行数与占文件比例**、按行数降序 —— 那就是当期全表。
 *
 * | 体行数 | 文件 | 体占文件 | 备注 |
 * |---:|---|---:|---|
 * | **265** | `integrations/mcp-http.ts` | 84% | 一个工厂包住 12 个共享闭包状态的闭包 |
 * | **257** | `transport/async.ts` | 18% | `#executeInner`，含 4 个嵌套 `try`（253/214/169/86） |
 * | **252** | `integrations/mcp-stdio.ts` | 81% | 同上形态（spawn 子进程那条） |
 * | 224 | `integrations/metrics-render.ts` | 69% | `renderPrometheus`，**不该拆**（纯格式化器） |
 * | 215 | `toolkit/module.ts` | 37% | `constructor`，7 个可调用体之一 |
 * | 212 | `integrations/metrics-otlp.ts` | 67% | `buildOtlpPayload`，同「不该拆」 |
 * | 205 | `engine/loop.ts` | 39% | `agentLoop`，内聚编排骨架 |
 * | 192 | `engine/mcp-server-http.ts` | 87% | ⚠️ **不在本闸射程**（体不过线），见下 |
 * | 192 | `integrations/anthropic.ts` | 31% | `readAnthropicStream`，一个 SSE 状态机 |
 * | 159 | `engine/turn.ts` | 20% | |
 * | 156 | `transport/http.ts` | 46% | |
 * | 143 | `integrations/metrics.ts` | 41% | |
 * | 140 | `integrations/metrics-state.ts` | 20% | |
 *
 * **240 是怎么来的**：越线的三个（265 / 257 / 252）与合法那一档的**上界**（224，
 * `renderPrometheus`）之间只有 28 行；240 落在中间，给合法档留 16 行（7%）余量、
 * 同时把三个越线者全部点出来。它是「**单个可调用体明显异常**」的线，不是「该不该拆」的判据
 * —— 拆不拆要看形状（`docs/guards.md` §1.1 那条 `source-size` 的「退化了会怎样」列记着
 * 为什么 `renderPrometheus` / `agentLoop` / `readAnthropicStream` 属于**不该拆**那一档）。
 *
 * ## ⚠️ 射程（别外推）
 *
 * - 本闸管的是**体的行数**，不是形状。**盲区的形状**是「文件基本等于一个函数的壳」——
 *   体不到 240 行、却占文件很高比例的那种（例如 240 行体装在 260 行文件里 = 92%）。
 *   触发本闸的那个**实例**是 `engine/mcp-server-http.ts` 的 `startHttpTransport`
 *   （**修前** 192 行占文件 **87%**，是定阈值当天的全仓最高比例），而**比例才看得见它** ——
 *   比例判据本次被否掉了：
 *   实测「比例」对闭包工厂**结构上降不下来**（抽走 R 行时分子分母同减，比例下限被文件的
 *   脚手架行数顶住），要让它当时就咬，修完只能落在 76~79%，离阈值 1~4pt ⇒ 常态化误报。
 *   ⚠️ 注意区分**实例**与**类**：本次外移已把那个实例降到 **145 行**（**仍不过线、
 *   仍不受本闸管**）；**类的盲区一格没补** —— 别因为「那个文件已经不刺眼了」就当补上了。
 *   两个判据看得见的东西也不同：今天全仓比例最高的那个（`integrations/mcp-http.ts` 的工厂，
 *   **体 191 行**）**是行数看得见的**（只是还没到线，真长过 240 本闸会红）；
 *   **只有「体本来就小、比例却极高」那一格是彻底的盲区**。
 *   ⇒ 记在 `docs/guards.md` §1.1 的「退化了会怎样」列里作为**已知盲区**。
 * - 口径：**原始行**（含空行与体内注释），与 `source-size` 的「含代码行」口径**刻意不同** ——
 *   那边按代码行是为了不逼人删注释，这边量的是「这个体吞了多少行」，注释同样是它吞的。
 */

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/** 单个可调用体的行数上限（口径见头注：原始行，含签名行、体内注释行与收尾 `}`） */
const MAX_CALLABLE_LINES = 240;

/** 防真空：`src/**` 的 `.ts` 文件数下限（2026-10-11 实测 110；这个数会随文件增减漂移，别照着调） */
const MIN_FILES = 100;
/** 防真空：识别出的可调用体个数下限（2026-10-11 实测 538）—— 解析崩了会变成一个空表 */
const MIN_CALLABLES = 400;
/** 防真空：**最大体 ≥ 120 的文件个数**下限（2026-10-11 实测 13）—— 只挡「解析器只认出小体」这种退化 */
const MIN_BIG_FILES = 8;

function allTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) allTsFiles(p, acc);
    else if (entry.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('方法级体量闸：src/** 的单个可调用体不得越过预算（口径见头注）', () => {
  const files = allTsFiles(SRC_ROOT).sort();
  const pictures = files.map((f) => ({ file: f, pic: filePicture(readFileSync(f, 'utf8'), f) }));

  it('真空护栏：文件与可调用体真扫到了（否则下面的断言全是假绿）', () => {
    assert.ok(
      files.length >= MIN_FILES,
      `只扫到 ${files.length} 个 .ts 文件（预期 ≥ ${MIN_FILES}）—— 递归或后缀判据坏了，守卫已失效`,
    );
    const callables = pictures.reduce((s, p) => s + p.pic.count, 0);
    assert.ok(
      callables >= MIN_CALLABLES,
      `只识别出 ${callables} 个可调用体（预期 ≥ ${MIN_CALLABLES}）—— 解析器退化成空表了`,
    );
    const big = pictures.filter((p) => (p.pic.max?.lines ?? 0) >= 120);
    assert.ok(
      big.length >= MIN_BIG_FILES,
      `只有 ${big.length} 个文件的最大体 ≥ 120 行（预期 ≥ ${MIN_BIG_FILES}）—— ` +
        '解析器只认出了小体，本闸已在空转',
    );
    // 承重：本闸最主要的对象必须在射程里（它被删 / 改名当天就该有人看一眼）
    assert.ok(
      pictures.some((p) => p.file.endsWith('/integrations/mcp-http.ts')),
      'mcp-http.ts 不在扫描结果里 —— 本闸最主要的对象漏了',
    );
  });

  /**
   * 解析器自证。⚠️ 按 `guards.md` §3 第 4 条：合成样本要**照抄真实病灶的形状**，
   * 而且必须钉**精确行数** —— 写「差不多」的断言（`> 0`）退回坏实现照样绿。
   */
  describe('扫描器自证（把 `lib/callable-spans.ts` 的每一条口径钉在合成样本上）', () => {
    it('① 识别到一个体就跳过整个体：包在里面的两个闭包不算独立体', () => {
      const src = [
        'function makeCounter(seed: number): Counter {', // 1
        '  let n = seed;', // 2
        '  // 注释行也算进体里（与「文件总行数」同口径）', // 3
        '  const bump = (): number => {', // 4
        '    n += 1;', // 5
        '    return n;', // 6
        '  };', // 7
        '  const reset = (): void => {', // 8
        '    n = seed;', // 9
        '  };', // 10
        '  return { bump, reset };', // 11
        '}', // 12
      ].join('\n');
      const pic = filePicture(src, '<sample>');
      assert.equal(pic.max?.name, 'makeCounter', '最大体的名字不对 —— 签名回溯或名字正则坏了');
      assert.equal(pic.max?.lines, 12, '体行数不等 12（含签名行、体内注释行、收尾 `}`）');
      assert.equal(pic.max?.start, 1, '起始行不对');
      assert.equal(pic.count, 1, '嵌套的两个箭头函数被当成了独立体（跳过整条体那条规则坏了）');
    });

    it('② class 自身不算体、方法算：只前进一行继续扫体内', () => {
      const src = [
        'class Box {', // 1
        '  value = 1;', // 2
        '  constructor(v: number) {', // 3
        '    this.value = v;', // 4
        '  }', // 5
        '  get size(): number {', // 6
        '    return this.value;', // 7
        '  }', // 8
        '}', // 9
      ].join('\n');
      const pic = filePicture(src, '<sample>');
      assert.equal(pic.count, 2, '应恰好认出 constructor 与 getter 两个方法');
      assert.equal(pic.max?.lines, 3, '每个方法体各 3 行');
      assert.equal(pic.max?.kind, 'method', '缩进 2 的应归类为 method');
    });

    it('③ 字符串 / 注释里的花括号不参与深度 —— 否则整个体消失（假阴性）', () => {
      // ⚠️ 这一条是**变异电池逼出来的**：第一版样本把花括号放在**单独一行**里，
      // 而 `after === before + 1` 这个判据对**整体深度平移是免疫的** ⇒ 摘掉遮蔽照样绿（假守卫）。
      // 真实病灶的形状是「花括号与体的开括号**同一行**」：那里遮蔽与否直接决定这一行
      // 算不算「净开一层」，进而决定收尾行找不找得到 —— 找不到就是**体凭空消失**，
      // 而那看起来与「体量健康」一模一样（2026-10-11 三个 MCP 连接器正是这么消失的）。
      const src = [
        'function braceInString(): string {', // 1
        "  return '{';", // 2 ← 不遮蔽时这里多算一层
        '}', // 3
      ].join('\n');
      const pic = filePicture(src, '<sample>');
      assert.equal(pic.count, 1, '字符串里的 `{` 被算进深度 ⇒ 收尾行找不到 ⇒ 体整体消失（假阴性）');
      assert.equal(pic.max?.name, 'braceInString', '解析出的体不对 —— 体已经没了或者认错了');
      assert.equal(pic.max?.lines, 3, '体应是 1~3 共 3 行');

      // 注释里的花括号同形（同一个病灶、另一种载体）
      const comment = [
        'function braceInComment(): void { // 只写一个 {', // 1
        '  return;', // 2
        '}', // 3
      ].join('\n');
      const pic2 = filePicture(comment, '<sample>');
      assert.equal(pic2.count, 1, '注释里的 `{` 被算进深度 ⇒ 体整体消失');
      assert.equal(pic2.max?.lines, 3, '注释形态的体行数不对');
    });

    it('④ 模板串里的插值与花括号都要正确匹配，行号不失真', () => {
      const src = [
        'const s = "}{";', // 1
        '/** { 注释里的花括号 */', // 2
        // `${` 写成 \u0024{ —— 直接写会触发 biome 的 noTemplateCurlyInString
        // （「字符串里不该有模板占位」）。运行时字符串仍是 `const t = `a${x}{b`;`
        // 这一行测的是两件事：模板里的 `{b` 要被遮蔽，且 `${…}` 的 `}` 不能多算一次深度。
        'const t = `a\u0024{x}{b`;', // 3
        'function after(): void {', // 4
        '  return;', // 5
        '}', // 6
      ].join('\n');
      const pic = filePicture(src, '<sample>');
      assert.equal(pic.count, 1, '前三行的花括号被算进深度了 —— 遮蔽没生效');
      assert.equal(pic.max?.name, 'after', '解析出的体不对');
      assert.equal(pic.max?.start, 4, '行号被遮蔽弄偏了');
      assert.equal(pic.max?.lines, 3, '体应是 4~6 共 3 行');
    });

    it('⑤ 非可调用体不进榜：控制流块与对象字面量赋值', () => {
      const src = [
        'const map = {', // 1
        '  a: 1,', // 2
        '};', // 3
        'if (map.a) {', // 4
        '  map.a += 1;', // 5
        '}', // 6
      ].join('\n');
      assert.equal(filePicture(src, '<sample>').count, 0, '控制流块 / 对象字面量被当成可调用体了');
    });
  });

  it(`每个可调用体都 ≤ ${MAX_CALLABLE_LINES} 行`, () => {
    const over = pictures
      .flatMap(({ file, pic }) =>
        pic.max && pic.max.lines > MAX_CALLABLE_LINES ? [{ file, pic, span: pic.max }] : [],
      )
      .sort((a, b) => b.span.lines - a.span.lines);

    assert.deepEqual(
      over.map(
        ({ file, pic, span }) =>
          `${relative(SRC_ROOT, file)}:${span.start} ${span.name} = ${span.lines} 行` +
          `（占文件 ${((span.lines / pic.totalLines) * 100).toFixed(0)}%，该文件可调用体 ${pic.count} 个）`,
      ),
      [],
      `有单个可调用体越过了 ${MAX_CALLABLE_LINES} 行的预算。两条路（都必须显式）：` +
        '① 抽件 —— 把方向正交的一块移出去（本仓既有做法：`mcp-protocol.ts` 的协议面共享件、' +
        '`async.ts` 的四个监督件、`http.ts` 的端点表）；' +
        '② 提上限 —— 改这个文件里的 MAX_CALLABLE_LINES，并在 PR 里说明为什么。' +
        '⚠️ 判据是**行数**，不是「该不该拆」：内聚长函数（`renderPrometheus` / `agentLoop` / ' +
        '`readAnthropicStream`）本来就在合法档，别为了让它变绿把一份自成一体的东西打散。',
    );
  });
});
