/*
 * 「可调用体（函数 / 方法）的行跨度」扫描器 —— 被 method-size.test.ts 使用。
 *
 * **为什么单独一个文件而不是写在测试里**：扫描器本身要被**单独验证**。它的失效方向是
 * **假阴性**（没识别出体 ⇒ 表是空的 ⇒ 闸全绿），而那看起来与「体量健康」一模一样。
 * 写在 `.test.ts` 里就做不到 —— import 测试文件会直接跑测试。与 `lib/source-scan.ts`
 * 同一个理由（那边是「遮蔽错位 ⇒ 零依赖假绿」）。
 *
 * 口径（与守卫头注一字对应，改动这里必须同步改那边）：
 *   - 遮蔽复用 `source-scan.ts` 的 `scan()`：注释 / 字符串 / 模板 / 正则逐字变空格、
 *     **换行保留** ⇒ 花括号深度可信，且行号不失真；
 *   - 「可调用体」= 花括号体前面能拼出一个**签名**、签名里有 `(` 或 `=>`、
 *     且不是控制流块 / 不是 interface 等声明块 / 不是对象字面量赋值的那一档；
 *   - **识别到一个体就跳过整个体** —— 嵌套回调不算独立可调用体。这条是刻意的：
 *     本闸问的是「这个文件里最大的那个体多大」，而不是「有多少个回调」。
 *     ⚠️ `class X {` 自身不合格（无 `(`）⇒ 只前进一行、继续扫**体内**，方法才被算到。
 *   - 行跨度含签名行与收尾的 `}` 行，**含体内注释行**（与「文件总行数」同口径：都是原始行）。
 *
 * ⚠️ 这是**文本扫描器，不是 AST**。已知的偏离四类，**方向都是「读数偏小」**，除了第 4 类：
 *   1. 一行里写多个体（`{ a() {} b() {} }`）—— 本仓语料里不存在；
 *   2. 箭头函数不带花括号（`=> x + 1`）—— 本仓语料里不存在；
 *   3. `{` 出现在被遮蔽之外的怪写法 —— 本仓语料里不存在；
 *   4. ⚠️ **方向相反的一类（读数偏大）**：多行**调用**传对象字面量实参（`foo({`）的签名里带 `(`，
 *      会被判成一个体，名字取调用点的左值。2026-10-11 在 `src/**` 全量实测：538 个体里 **4 个**
 *      是这一类（最大 **9 行**：`integrations/metrics-otlp.ts:exemplarOf` / `engine/loop-result.ts`
 *      / `engine/usage.ts` / `engine/loop.ts`）。远低于本闸阈值 ⇒ **今天不产生误报**；
 *      但这是唯一能让守卫**误咬**的方向，真长起来要靠重跑那次审计（判据：收尾行形如 `})`）。
 */

import { scan } from './source-scan.js';

/** 一个可调用体（或它所在文件的诊断读数） */
export interface CallableSpan {
  /** 相对仓库根的文件路径（调用方传入的原样） */
  file: string;
  /** 签名起始行（1-based） */
  start: number;
  /** 收尾 `}` 行（1-based） */
  end: number;
  /** 跨度行数（含签名行与收尾行、含体内注释） */
  lines: number;
  /** 体名（解析不出时是签名的截断） */
  name: string;
  kind: 'top-level' | 'method' | 'closure';
}

export interface FilePicture {
  /** 该文件里**最大的**可调用体（没有可调用体时为 `undefined`） */
  max: CallableSpan | undefined;
  /** 该文件里识别到的可调用体个数 */
  count: number;
  /** 文件总行数（原始行，含空行与注释） */
  totalLines: number;
}

/** 控制流块：不算可调用体（它们是「深缩进」信号，不是函数） */
const CONTROL_FLOW = /^\s*(if|for|while|switch|catch|else|do|try|finally)\b/;
/** 这些声明块有花括号体但**不是**可调用体（interface / enum / namespace / declare / import） */
const NON_CALLABLE_DECL =
  /^\s*(export\s+)?(interface|enum|namespace|declare|import|export\s+(type|interface))\b/;
/** `type X = { … }` 与 `const x: T = { … }` 这类对象字面量赋值 */
const ASSIGN_OBJECT = /=\s*\{\s*$/;
/**
 * ⚠️ 上一条**是被下面第 4 条包含的**（`... = {` 的签名里既没有 `(` 也没有 `=>`）——
 * 也就是说**单独把它删掉不会有任何用例红**。留着是为了让「对象字面量赋值不算体」这个意图
 * 在代码里显式可读，而不是藏在 `!includes('(')` 的副作用里。按 `guards.md` §3 第 2 条，
 * 这里如实说明它不承重，**不假装它有一条自己的变异**。
 */
/** 合法缩进（顶格 / 方法 / 浅闭包）。更深的一律不认 —— 那是回调，不是「这个文件的体」 */
const LEGAL_INDENTS = new Set([0, 2, 4, 6, 8]);

/** 从「开出 `{` 的那一行」往回拼签名（多行签名要拼上前面几行，否则名字与类型都缺） */
function signatureAt(
  depths: Array<{ before: number; after: number; text: string }>,
  i: number,
  floor: number,
): { start: number; signature: string; indent: number } {
  const before = depths[i]!.before;
  let k = i;
  while (k - 1 >= floor) {
    const prev = depths[k - 1]!;
    const trimmed = prev.text.trim();
    // 遇到不同深度、空行、或上一条语句 / 上一个体的收尾 ⇒ 签名到此为止
    if (prev.before !== before || trimmed === '' || /[;}{]$/.test(trimmed)) break;
    k -= 1;
  }
  const signature = depths
    .slice(k, i + 1)
    .map((d) => d.text)
    .join(' ')
    .split(/\s+/)
    .filter((s) => s !== '')
    .join(' ');
  const first = depths[k]!.text;
  return { start: k, signature, indent: first.length - first.trimStart().length };
}

/** 量一个源文件：最大可调用体 / 可调用体个数 / 总行数 */
export function filePicture(src: string, file: string): FilePicture {
  const spans = spansOf(src, file);
  const rawLines = src.split('\n');
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();
  const max = spans.length === 0 ? undefined : spans.reduce((a, b) => (b.lines > a.lines ? b : a));
  return { max, count: spans.length, totalLines: rawLines.length };
}

/**
 * 列出全部可调用体（诊断用：守卫只取每文件最大的一个，但**偏离度**要能整体看）。
 *
 * ⚠️ 与 `filePicture` 同一个扫描器，不是第二份实现 —— 分开只为「不把诊断面塞进主返回值」。
 */
export function spansOf(src: string, file: string): CallableSpan[] {
  // 尾换行会 split 出一个空元素 ⇒ 「总行数」要摘掉它（否则比 `wc -l` 多 1）。
  // ⚠️ 但**深度数组不能摘**：收尾行的判定靠「起始深度回到开括号前」，
  // 最后一个体的收尾行恰恰要靠那个空元素的深度，摘了它 ⇒ **最外层那个体整个消失**
  // （2026-10-11 实测：三个 MCP 连接器从表里凭空不见，看起来像「体量健康」）。
  const maskedLines = scan(src).masked.split('\n');
  const depths: Array<{ before: number; after: number; text: string }> = [];
  let depth = 0;
  for (const text of maskedLines) {
    const before = depth;
    depth += (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
    depths.push({ before, after: depth, text });
  }

  /**
   * 从 i 往后找**收尾行**：第一个「起始深度 == 开括号行的起始深度」的行。
   *
   * ⚠️ 判据用的是 `after`（收尾行的**到达**深度）而不是 `before` —— 这两者只差一行，
   * 但差的那一行正是最后一个体的收尾 `}`：用 `before` 会把尾部的空元素当成收尾行，
   * **读数整体 +1**（2026-10-11 实测：265 被读成 266，三个 MCP 连接器的读数同时虚高）。
   */
  const spanEnd = (i: number, before: number): number | null => {
    for (let j = i + 1; j < depths.length; j++) {
      if (depths[j]!.after === before) return j;
    }
    return null;
  };

  const spans: CallableSpan[] = [];
  let i = 0;
  while (i < depths.length) {
    const { before, after, text } = depths[i]!;
    if (after === before + 1 && text.trim() !== '') {
      const { start, signature, indent } = signatureAt(depths, i, 0);
      if (LEGAL_INDENTS.has(indent)) {
        const end = spanEnd(i, before);
        if (end !== null) {
          const skip =
            CONTROL_FLOW.test(signature) ||
            NON_CALLABLE_DECL.test(signature) ||
            ASSIGN_OBJECT.test(signature) ||
            (!signature.includes('(') && !signature.includes('=>'));
          if (!skip) {
            const named = /(?:function\s+)?([#\w$]+)\s*[(=<]/.exec(signature);
            spans.push({
              file,
              start: start + 1,
              end: end + 1,
              lines: end - start + 1,
              name: named?.[1] ?? signature.slice(0, 40),
              kind: indent === 0 ? 'top-level' : indent === 2 ? 'method' : 'closure',
            });
            i = end + 1; // 跳过整个体：嵌套回调不算独立体
            continue;
          }
        }
      }
    }
    i += 1;
  }

  return spans;
}
