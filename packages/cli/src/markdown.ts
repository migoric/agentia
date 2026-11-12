/**
 * 面板的 **Markdown 最小渲染器** —— 纯逻辑、零 DOM、零依赖。
 *
 * 为什么自己写而不引 `marked` / `markdown-it`：
 * - **零运行时依赖是本 CLI 的硬承诺**（`package.json` 里没有 `dependencies`）。为了面板把一份
 *   解析器 + 一份消毒器（DOMPurify 之类）塞进 dist，等于在 dev 链路里引入两个第三方供应链面，
 *   而它们的产物**没法被本仓的单测验证**（我们只能验「我写的那部分」）。
 * - 面板只需要**模型正文**这一种输入可读：标题 / 粗体 / 斜体 / 行内码 / 围栏码 / 列表 /
 *   引用 / 分隔线 / 链接。这套子集手写不到 200 行，且**每条规则都能配一条单测**。
 * - 最要紧的是**它按构造不产生 HTML**：返回值是一棵 token 树（`MdBlock` / `MdInline`），
 *   没有任何「原样透传的 HTML」这一类。页面的渲染器只准用 `createElement` + `textContent`
 *   把它变成 DOM ⇒ **模型输出里的 `<script>` 只会是字面文本**，不存在「忘了转义」这条路径。
 *
 * ⚠️ 本文件**不许碰 DOM**（不出现 `document` / `window`）—— 它要在 Node 里被直接 import 做单测。
 *
 * 支持的子集（刻意不做的都在「不做」里）：
 * - 块：`#` 标题（1–6 级）、围栏码块（``` / ~~~，带语言标注）、无序/有序列表（**一层**）、
 *   引用（合并成一段正文）、`---` 分隔线、**GFM 表格**（表头 / 分隔行 / 对齐 / `\|` 转义）、段落
 * - 行内：行内码、`**粗**`、`*斜*`、`[文字](链接)`、`<https://…>` 自动链接
 * - **HTML 注释被丢弃**（`<!-- … -->`，可跨行）：注释不是正文。真实素材里最常见的就是
 *   「迁移自 …」「TODO: 这条规则已废弃」这类作者旁注，让它们以字面文本占掉开头三四行，
 *   比不渲染更糟。原文一个字节都不改（调用方手里仍是原串）⇒ 「隐藏」只发生在**渲染视图**里。
 *
 * 不做（都是刻意的，不是漏）：
 * - **不做 HTML 透传**（安全前提，见上）—— 注释是唯一的例外，且是**丢掉**而不是渲染
 * - **不做任务列表 / 嵌套列表 / 脚注 / 数学** —— 面板是调试视图，不是文档站
 * - 不做 setext 标题（`===` 下划线式）—— 与分隔线歧义大、收益小
 * - 不做图片（`![]()`）—— 面板**不去外网取图**：一次 run 的正文不该触发网络请求
 * - 不做**词内** `_` 强调（`read_file_tool` 原样显示）—— 与 CommonMark 同口径，见 `parseInline`
 *
 * ⚠️ 表格是 2026-11-12 补的（原先明写「不做表格」）。**那个判断是错的**：agent 的产出里
 * 「错误汇总 / 逐项统计 / 参数对照」天然就是表，砍掉表格等于把最有信息量的几种结果打回
 * 一行行 `| a | b |` 加上 `|---|---|` 的源文 —— 面板的读者被迫在脑子里做列对齐。
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'link'; href: string; text: string };

/** 格子对齐（GFM 的 `:---` / `---:` / `:---:`）；`null` = 没标，交给宿主决定 */
export type MdAlign = 'left' | 'right' | 'center' | null;

export type MdBlock =
  | { type: 'p'; inline: MdInline[] }
  | { type: 'h'; level: number; inline: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'quote'; inline: MdInline[] }
  | { type: 'table'; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] }
  | { type: 'hr' };

/**
 * 链接协议白名单。**这是安全边界，不是风格选择**：
 * 模型输出里的 `[点我](javascript:alert(1))` 若被渲染成可点链接，面板就成了 XSS 的跳板
 * （`href` 是唯一一处「我们主动写进属性」的值 —— 文本全走 `textContent` 是安全的，
 * 属性不是）。不合法 ⇒ 这一条**整个降级成字面文本**（连 `[]()` 都照原样显示），
 * 使用者一眼看得出「这里有个链接我没渲染」，而不是看到一个空链接或点不动的链接。
 */
export function isSafeHref(href: string): boolean {
  // 允许 http/https/mailto；**不允许** javascript: / data: / vbscript: / file: 等
  return /^(https?:|mailto:)/i.test(href.trim());
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL = /^(\s*)([-*+])\s+(.*)$/;
const OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const BLANK = /^\s*$/;
/**
 * 表格的分隔行：`| --- | :--: |` / `--- | ---` 两种写法都收。
 * 至少**两列**（`(\|…)+` 强制的）—— 单列「表格」在面板里就是一段带竖线的文本，
 * 成表只会白占一行表头，还容易被 `a | b` 这种正文误判。
 */
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
/** 「这个字符串值不值得渲染」的长度上限（见 `looksLikeMarkdown`）—— 几百 KB 逐行建 DOM 只会卡住面板 */
const MAX_RENDER_CHARS = 100_000;
/** 「单词字符」：`_` 的词内排除用它判边界（与 CommonMark 的 intraword 规则同口径） */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** 下标可能越界（`text[-1]` / `text[len]` 都是 `undefined`）⇒ 越界一律当「不是单词字符」 */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * 把一段 Markdown 文本解析成块序列。
 *
 * 四条与「真 Markdown」不同但**刻意**的口径：
 * - 缩进 ≥2 空格的续行归上一条列表项（列表只解析**一层**：更深一层当正文，不递归建树）；
 * - 未闭合的围栏码块吃掉到文末（**不静默丢内容** —— 模型被截断时最常见的就是这个形态）；
 * - 引用（`>`）合并成**一段正文**（面板里引用几乎总是模型在引日志，逐行建块只会更碎）；
 * - 表格按**表头**宽度对齐：缺的列补空、多出来的列丢掉（与 GFM 同口径）。表格之后紧接的
 *   非 `|` 行立刻收尾 —— 表格没有围栏，边界只能靠「下一行还像不像表格」来判断。
 */
export function parseMarkdown(text: string): MdBlock[] {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const blocks: MdBlock[] = [];
  const comment = { open: false };
  let i = 0;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    const joined = para.join('\n').trim();
    para = [];
    if (joined) blocks.push({ type: 'p', inline: parseInline(joined, 0) });
  };

  while (i < lines.length) {
    // 注释先剥掉再看这一行是什么（围栏码块的内容由下面的内层循环整段吞掉，不会走到这里 ⇒
    // 码块里的 `<!-- … -->` 原样保留，这正是「代码是字面量」的意思）
    const line = stripComments(lines[i] as string, comment);

    // —— 围栏码块 ——
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = (fence[1] as string)[0] as string;
      const min = (fence[1] as string).length;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i] as string;
        const close = new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{${min},}\\s*$`);
        if (close.test(cur)) {
          i++;
          break;
        }
        body.push(cur);
        i++;
      }
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    // —— 空行：段落到此为止 ——
    if (BLANK.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // —— 分隔线（必须在列表之前判：`---` 也是无序列表的标记） ——
    if (HR.test(line)) {
      flushPara();
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // —— 标题 ——
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      blocks.push({
        type: 'h',
        level: (h[1] as string).length,
        inline: parseInline((h[2] as string).trim(), 0),
      });
      i++;
      continue;
    }

    // —— 引用：连续 `>` 行合成一段 ——
    if (QUOTE.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        quoted.push((QUOTE.exec(lines[i] as string) as RegExpExecArray)[1] as string);
        i++;
      }
      const joined = quoted.join('\n').trim();
      blocks.push({ type: 'quote', inline: parseInline(joined, 0) });
      continue;
    }

    // —— 列表（无序 / 有序，各收一段连续的） ——
    const ul = UL.exec(line);
    const ol = olAt(line);
    if (ul || ol) {
      flushPara();
      const ordered = ol !== null;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const cur = lines[i] as string;
        const m = ordered ? olAt(cur) : UL.exec(cur);
        if (m) {
          items.push(parseInline(m[3].trim(), 0));
          i++;
          continue;
        }
        // 续行：缩进 ≥2 且不是新的一条 ⇒ 并进上一项
        if (items.length > 0 && /^\s{2,}\S/.test(cur) && !BLANK.test(cur)) {
          const last = items[items.length - 1] as MdInline[];
          last.push(...parseInline(cur.trim(), 0));
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // —— 表格（GFM）：表头行 + 分隔行**同时**成立才算 ——
    // 两条都要，是这条判据的全部要害：只要「行里有 `|`」就成表，`a | b` 这种正文会被
    // 吞成一行表头；只要「下一行像分隔行」就成表，`---` 分隔线下面那段会被吃掉。
    if (isTableStart(line, lines[i + 1])) {
      flushPara();
      const header = splitRow(line).map((c) => parseInline(c, 0));
      const align = splitRow(stripComments(lines[i + 1] as string, { open: comment.open })).map(
        alignOf,
      );
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length) {
        // 表格没有围栏：边界只能靠「下一行还像不像表格」。空白、另一个块的起始、
        // 不含 `|` 的行，三者任一条都收尾（否则后面的正文会被当成格子吃掉）。
        const raw = lines[i] as string;
        if (!raw.includes('|') || BLANK.test(raw)) break;
        if (FENCE.test(raw) || HR.test(raw) || HEADING.test(raw) || QUOTE.test(raw)) break;
        if (UL.test(raw) || olAt(raw)) break;
        const cells = splitRow(raw).slice(0, header.length);
        while (cells.length < header.length) cells.push('');
        rows.push(cells.map((c) => parseInline(c, 0)));
        i++;
      }
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    // —— 其余：段落（连续非空行合并，行内换行保留） ——
    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

/**
 * 剥掉 HTML 注释（可跨行）。`state.open` 跨行携带 —— 块级解析是逐行扫的，
 * 没有这个开关，一段被空行隔开的三行注释会被当成三段正文（每段都带着半截 `<!--`）。
 *
 * 只在**非码块**的行上调用。码块内容由围栏那段内层循环整段吞掉，走不到这里 ——
 * 所以「代码里的 `<!-- -->` 原样保留」不是靠额外判断，是靠调用点。
 */
function stripComments(line: string, state: { open: boolean }): string {
  let s = line;
  for (;;) {
    if (state.open) {
      const end = s.indexOf('-->');
      if (end < 0) return '';
      s = s.slice(end + 3);
      state.open = false;
      continue;
    }
    const start = s.indexOf('<!--');
    if (start < 0) return s;
    const end = s.indexOf('-->', start + 4);
    if (end < 0) {
      state.open = true;
      return s.slice(0, start);
    }
    s = s.slice(0, start) + s.slice(end + 3);
  }
}

/**
 * 一行表格 → 格子文本（已 trim，`\|` 解成 `|`）。
 * 首尾的定界竖线去掉；**但**以 `\|` 结尾时不能去 —— 那是最后一个格子里的字面竖线。
 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\\' && s[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  cells.push(buf.trim());
  return cells;
}

/** 分隔行的单个格子 → 对齐方式 */
function alignOf(cell: string): MdAlign {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** 这一行是不是表格的开头：表头含 `|`、下一行是分隔行、且两行列数**相等** */
function isTableStart(head: string, sep: string | undefined): boolean {
  if (sep === undefined || !head.includes('|') || !TABLE_SEP.test(sep)) return false;
  return splitRow(head).length === splitRow(sep).length;
}

/**
 * 这段正文「值不值得按 Markdown 渲染」—— 给**宿主**用（trace 树里展开的工具出参）。
 *
 * 判据只认**块级**记号，且要求**至少两分**（围栏码块与表格各算两分，其余各一分）：
 * 标题 + 列表 = 2 分 ✅；只有一堆 `#` 注释 ❌；只有一处围栏码块 ✅。
 *
 * 为什么这么严：判错的代价不是「少渲染一点」，而是**把一段本来好读的文本毁掉** ——
 * 日志行被并成段落、原有缩进被吃掉、行首的 `#` 与 `|` 凭空消失。所以宁可漏（保持原文），
 * 不可错。
 *
 * 刻意**不**看行内记号（`**粗**` / `[x](y)`）：`**kwargs` / `*args` 是 Python 源码里最常见
 * 的东西，按行内记号判会把整份源码判成 Markdown —— 而那正是工具出参的另一种常见形态。
 *
 * 超过 `MAX_RENDER_CHARS` 一律不渲染：几百 KB 的正文逐行建 DOM 只会把面板卡住，
 * 而这种长度的东西本来就该用「复制」拿走。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (typeof text !== 'string' || text.length > MAX_RENDER_CHARS) return false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kinds = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (FENCE.test(line)) kinds.add('fence');
    else if (isTableStart(line, lines[i + 1])) kinds.add('table');
    else if (HEADING.test(line)) kinds.add('h');
    else if (QUOTE.test(line)) kinds.add('q');
    else if (UL.test(line) || olAt(line)) kinds.add('list');
  }
  let score = 0;
  for (const k of kinds) score += k === 'fence' || k === 'table' ? 2 : 1;
  return score >= 2;
}

/** 有序列表标记（`1.` / `1)`），返回与 UL 同形的三组：缩进 / 标记 / 正文 */
function olAt(line: string): RegExpExecArray | null {
  const m = OL.exec(line);
  return m ? (m as unknown as RegExpExecArray) : null;
}

/**
 * 行内解析。`depth` 是**递归上限**：`**a *b* c**` 这类嵌套只展开到第 3 层，
 * 再深就按字面留着 —— 递归无上限时，一条构造出来的正文就能把面板卡死。
 */
export function parseInline(text: string, depth: number): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  let i = 0;
  const pushText = (): void => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };

  while (i < text.length) {
    const c = text[i] as string;

    // 行内码：`...`（不跨行；两端各去掉一个空格 —— 与 CommonMark 同款）
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        pushText();
        let inner = text.slice(i + 1, end);
        if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim())
          inner = inner.slice(1, -1);
        out.push({ type: 'code', text: inner });
        i = end + 1;
        continue;
      }
    }

    // 链接：[文字](地址) —— 地址不过白名单就整条降级成字面文本（见 isSafeHref）
    if (c === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(i));
      if (m) {
        const raw = text.slice(i, i + (m[0] as string).length);
        const href = (m[2] as string).trim();
        if (isSafeHref(href)) {
          pushText();
          out.push({ type: 'link', href, text: (m[1] as string).trim() });
        } else {
          buf += raw; // 字面保留（连 []() 一起）—— 让使用者看见「这里有个链接我没渲染」
        }
        i += (m[0] as string).length;
        continue;
      }
    }

    // 自动链接：<https://…>（裸的 `<` 一律当文本 —— 这正是「不做 HTML 透传」的落点）
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s>]+)>/.exec(text.slice(i));
      if (m) {
        pushText();
        out.push({ type: 'link', href: m[1] as string, text: m[1] as string });
        i += (m[0] as string).length;
        continue;
      }
    }

    // 强调：**粗** / *斜*（`__` / `_` 同义）
    if (c === '*' || c === '_') {
      const strong = text.startsWith(c + c, i);
      const mark = strong ? c + c : c;
      const end = text.indexOf(mark, i + mark.length);
      if (end > i + mark.length) {
        const inner = text.slice(i + mark.length, end);
        /**
         * `_` 的**词内排除**（CommonMark 的 intraword 规则）：两侧只要有一边紧贴单词字符，
         * 就不构成强调。
         *
         * 没有这条，`read_file_tool` 会被切成 `read` + <em>file</em> + `tool`、
         * `src/my_dir/my_file.ts` 同理 —— 而面板渲染的正是**模型正文**，标识符是那里最常见的东西。
         * 单下划线（`read_file`）本来就不配对、不受影响；真正被切开的是有两个及以上 `_` 的标识符。
         *
         * ⚠️ `*` **不做**这条限制：CommonMark 里 `a*b*c` **就是** `a<em>b</em>c`。
         * 只修 `_`、不修 `*`，是照口径修，不是照直觉修。
         */
        const intraword =
          c === '_' && (isWordChar(text[i - 1]) || isWordChar(text[end + mark.length]));
        if (!intraword && inner.trim() && !inner.startsWith(' ') && !inner.endsWith(' ')) {
          pushText();
          const children =
            depth < 3 ? parseInline(inner, depth + 1) : [{ type: 'text' as const, text: inner }];
          out.push(strong ? { type: 'strong', children } : { type: 'em', children });
          i = end + mark.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  pushText();
  return out;
}
