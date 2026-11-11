/* 展开态的**结构化正文** —— 把「一大坨 JSON」拆成可折叠、可成表、可复制路径的块。
 *
 * ## 为什么需要它
 *
 * 展开此前只有一条路：把 `rawArg(v)`（= `JSON.stringify(v)`，**无缩进**）整串塞进
 * `.tr-io` 再靠 CSS 换行。一个 20 键的工具入参在 400px 宽的右栏里会折成十几行连续的
 * `{"a":"b","c":{"d":` —— 页面不报错、无溢出、构建全绿，只是**人读不了**。工具出参更糟：
 * 它是 `content` 的原始序列化，长文本与图片块混在一起，一行到底。
 *
 * 缩进只是第一档。第二档（2026-11-11 晚，本文件的现状）解决缩进解决不了的三件事：
 *
 * 1. **静态文本没有"收起"**：深度 6 全铺开，一个出参就能把整棵树顶到屏幕外。现在容器
 *    默认只铺两层（`OPEN_DEPTH`），其余折成 `{ object · 4 项 }`，点一下展开。折叠状态由
 *    调用方传入（`opts.fold`）—— 渲染是全量重建，状态放本文件里活不过下一条事件。
 * 2. **同构对象数组在浪费行**：`[{name,score},{...},{...}]` 每个元素重复一遍键名，3 行数据
 *    吃掉 9 行。同构且各列都是标量时改成表格，表头一行、数据一行。
 * 3. **路径拿不到**：想引用 `results[0].name` 只能用手数层级。每个键悬停出一个 `⧉`，
 *    点一下把路径写进剪贴板（表头写的是 `results[*].name`，因为它是一整列）。
 *
 * ## 边界（都是「不这么做就会坏」的地方，不是口味）
 *
 * - **只在 `full` 不是字符串时接手**：字符串正文（工具返回的纯文本、官网模拟回放）
 *   继续走 `.tr-io` + `.tr-open` 的老路 —— 那条路有 `test/style.test.js` 的两个不变量守着
 *   （最小宽度、caret 常显），换成本件就会让那两个守卫失去落点。两档并存是刻意的。
 * - **不改 `.tr-io` 的文本**：本件只是**追加**一个兄弟块，`.tr-io` 仍持有原文（展开时由
 *   CSS 隐藏）。既有断言（`textContent === JSON.stringify(...)`）因此逐字保留 ——
 *   展开的正文依旧是"原文"，只是多了一层可读的呈现。
 * - **截断必须说出来**：长字符串与超大集合会截断，但截断处标明「还有 N 字符 / N 项」。
 *   静默截断会让人以为工具就返回了这么点东西 —— 比糊成一坨更坏。表格单元格同样走
 *   `primitive()`，所以这条在表里也成立（不做「表格例外」）。
 * - **循环引用不抛**：手写的 trace 可能有环（`rawArg` 对它会回落 `[object Object]`），
 *   这里同样只回落、不抛错：调试面板不该因为一条坏数据整棵树白屏。
 * - **折叠状态必须外部持有**：`opts.fold` 是调用方的 Map（`view.js` 按事件键存一份）。
 *   本文件只读写它、不 new 一份长期状态 —— 否则「点开一个容器，下一条事件到达时它自己合上」
 *   会原样复现（这正是 `view.js` 的 `expanded` 集合存在的原因）。
 * - **表格化只在"真的同构"时发生**：元素必须全是普通对象、键集完全一致、列数 1..6、
 *   每列都是标量。任一不满足就回落树形 —— 表格里没法逐层展开，判错一次就是**丢数据**。
 *
 * 零依赖、纯 DOM 构造（只用 createElement / appendChild / textContent / className /
 * dataset / innerHTML=''），与 view.js 共用同一套 DOM stub 跑测试。
 */

/** 单个字符串值最多显示多少字符（超过就说出来，不静默截断） */
const MAX_STR = 240;
/** 一层里最多铺开多少项（再多就没法看了，留着类型与计数） */
const MAX_ITEMS = 40;
/** 嵌套深度上限：再深就整体序列化成一行，避免缩进把宽度吃光 */
const MAX_DEPTH = 6;
/** 默认展开到第几层（容器自身深度 < 它 ⇒ 默认铺开）。两层 = 根 + 一层子节点 */
const OPEN_DEPTH = 2;
/** 表格最多几列：再多横向就没法看了，回落树形 */
const MAX_COLS = 6;

function fvEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 安全序列化：循环引用 / BigInt / 自定义 toJSON 抛错都回落成一句人话，绝不冒泡 */
function safeStringify(v) {
  try {
    const s = JSON.stringify(v, null, 2);
    return s === undefined ? String(v) : s;
  } catch {
    return '[无法序列化 —— 可能是循环引用]';
  }
}

/** 该值是否值得走结构化视图（字符串交给 .tr-io 的老路） */
function isStructured(v) {
  return v !== null && typeof v === 'object';
}

/** 普通对象（排除数组与 null）—— 表格化与"容器"判定都只要这一种 */
function isPlainObject(v) {
  return isStructured(v) && !Array.isArray(v);
}

/** 容器规模：数组算元素数，对象算键数 */
function sizeOf(v) {
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}

/** 头部那句类型说明：`object · 6 项` / `array · 12 项` / `string · 4,096 字符` */
function typeLabelOf(v) {
  if (Array.isArray(v)) return `array · ${v.length} 项`;
  if (isStructured(v)) return `object · ${Object.keys(v).length} 项`;
  if (typeof v === 'string') return `string · ${v.length} 字符`;
  return typeof v;
}

/** 基本类型的着色类与展示文本 */
function primitive(v) {
  if (v === null) return { cls: 'tr-full-null', text: 'null' };
  if (v === undefined) return { cls: 'tr-full-null', text: 'undefined' };
  const t = typeof v;
  if (t === 'string') {
    const clipped = v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
    const rest = v.length > MAX_STR ? `… 还有 ${v.length - MAX_STR} 字符` : '';
    return { cls: 'tr-full-str', text: JSON.stringify(clipped) + rest };
  }
  if (t === 'number') return { cls: 'tr-full-num', text: String(v) };
  if (t === 'boolean') return { cls: 'tr-full-bool', text: String(v) };
  return { cls: 'tr-full-null', text: String(v) };
}

/** 深层容器压成单行时的表示：保留"它是个容器"这个事实，不伪装成标量 */
function oneLine(v) {
  const kind = Array.isArray(v) ? 'array' : 'object';
  const s = safeStringify(v).replace(/\s+/g, ' ');
  const clipped = s.length > MAX_STR ? s.slice(0, MAX_STR) + '…' : s;
  return `<${kind} · ${sizeOf(v)} 项> ${clipped}`;
}

/** 子键的 JSON 路径：对象用 `.key`，数组用 `[i]`。根是空串，所以 `[0]` 不会变成 `.[0]` */
function pathOf(parent, key, isArr) {
  return isArr ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key;
}

/** 剪贴板：没有实现时**什么都不做**，绝不把没做到的事显示成「已复制」 */
function copyInto(btn, text, done) {
  const clip = globalThis.navigator?.clipboard;
  if (!clip || typeof clip.writeText !== 'function') return;
  Promise.resolve(clip.writeText(text)).then(
    () => {
      btn.textContent = done;
    },
    () => {
      btn.textContent = '复制失败';
    },
  );
}

/** 正在选文本时不要收起/展开 —— 鼠标拖选到行外松手会补一次 click，否则选完就自己合上了 */
function hasSelection() {
  try {
    return String(globalThis.getSelection?.() ?? '') !== '';
  } catch {
    return false;
  }
}

/** 悬停才露出的 `⧉`：点它复制路径，**不**触发所在容器的折叠 */
function pathBtn(path) {
  const btn = fvEl('span', 'tr-full-path', '⧉');
  btn.title = '复制路径 ' + path;
  btn.addEventListener('click', (e) => {
    // 真实 DOM 里会冒泡到容器行的折叠处理；stub 的 click() 传的是空对象，故双保险
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    copyInto(btn, path, '已复制');
  });
  return btn;
}

/**
 * 这一层要不要铺开。显式折叠/展开优先（`fold` 里有记录），否则按深度给默认值。
 * @param {Map<string, boolean>} fold 路径 → 是否展开
 */
function isOpen(fold, path, depth) {
  return fold.has(path) ? fold.get(path) === true : depth < OPEN_DEPTH;
}

/**
 * 同构对象数组 → 列名；不是"真同构"就返回 null（调用方回落树形）。
 *
 * 判据全部是「表格会丢东西」的地方，松一条就丢一类数据：元素必须是普通对象、
 * 键集**完全一致**（缺键/多键都回落）、列数 1..6、每列都是标量（表格里没法逐层展开）。
 */
function tableColsOf(arr) {
  if (!Array.isArray(arr) || arr.length < 2 || arr.length > MAX_ITEMS) return null;
  if (!isPlainObject(arr[0])) return null;
  const cols = Object.keys(arr[0]);
  if (cols.length === 0 || cols.length > MAX_COLS) return null;
  for (const item of arr) {
    if (!isPlainObject(item)) return null;
    if (Object.keys(item).length !== cols.length) return null;
    for (const c of cols) {
      if (!Object.hasOwn(item, c)) return null;
      if (isStructured(item[c])) return null;
    }
  }
  return cols;
}

/**
 * 同构数组铺成表格。缩进用 `data-depth`（值为 0 时不写）—— CSS 靠属性选择器补左外边距，
 * 因为列数是动态的、行数也是动态的，没有一个能写死的 inline style 可靠活在 stub 里。
 */
function renderTable(ctx, arr, cols, depth, path) {
  const table = fvEl('table', 'tr-full-table');
  if (depth > 0) table.dataset.depth = String(depth);

  const thead = fvEl('thead');
  const headRow = fvEl('tr');
  for (const c of cols) {
    const th = fvEl('th');
    th.appendChild(fvEl('span', 'tr-full-col', c));
    // 列的路径带 `[*]`：复制出去能直接用于过滤/取值，而不是某一行的那一份
    th.appendChild(pathBtn(pathOf(path + '[*]', c, false)));
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = fvEl('tbody');
  for (const item of arr) {
    const tr = fvEl('tr');
    for (const c of cols) {
      const td = fvEl('td');
      const p = primitive(item[c]); // 表里同样截断并说出剩余（不做「表格例外」）
      td.appendChild(fvEl('span', p.cls, p.text));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  ctx.body.appendChild(table);
}

/** 缩进空格的落点：0 层不占位（否则每条顶级键都白带两个空格） */
function indentOf(depth) {
  return depth > 0 ? fvEl('span', 'tr-full-indent', '  '.repeat(depth)) : null;
}

/** 折叠箭头的槽位。叶子行也占一格（传空串），否则同层键名会在「有箭头」与「没箭头」之间
 *  左右跳 10px —— 一列键名对齐是这类面板最基本的可读性，不能靠行首参差来区分有没有子项。 */
function caretSlot(glyph) {
  return fvEl('span', 'tr-full-caret', glyph);
}

/** 一行 = 缩进 + 箭头槽位（+ 稍后追加的键名/值）。所有行都从同一个入口起头，
 *  这样才能保证「同一层的键名在同一条竖线上」—— 逐处手写就迟早漏一处。 */
function startRow(depth, caret) {
  const row = fvEl('div', 'tr-full-line');
  const indent = indentOf(depth);
  if (indent) row.appendChild(indent);
  row.appendChild(caretSlot(caret));
  return row;
}

/**
 * 把一个值铺进 `ctx.body`。
 * @param {{body: Element, fold: Map<string, boolean>, repaint: () => void}} ctx
 * @param {any} v         值
 * @param {number} depth  当前缩进层级（根为 0）
 * @param {string} path   当前值的 JSON 路径（根为空串）
 */
function renderInto(ctx, v, depth, path) {
  const box = ctx.body;

  if (!isStructured(v)) {
    const p = primitive(v);
    const row = startRow(depth, '');
    row.appendChild(fvEl('span', p.cls, p.text));
    box.appendChild(row);
    return;
  }

  const isArr = Array.isArray(v);
  const cols = isArr ? tableColsOf(v) : null;
  if (cols) {
    renderTable(ctx, v, cols, depth, path);
    return;
  }

  const keys = isArr ? v.map((_, i) => String(i)) : Object.keys(v);
  const show = keys.slice(0, MAX_ITEMS);

  for (const k of show) {
    const child = isArr ? v[Number(k)] : v[k];
    const keyText = isArr ? `[${k}]` : `${k}:`;
    const childPath = pathOf(path, k, isArr);
    // 「能否折叠」只看三件事：是容器、非空、没到深度上限 —— 与下面几个分支同一套判据。
    // 先算出来是为了让箭头槽位在起行时就有正确字形（叶子行留空格位，键名才会对齐）。
    const foldable = isStructured(child) && sizeOf(child) > 0 && depth < MAX_DEPTH;
    const open = foldable && isOpen(ctx.fold, childPath, depth);
    const row = startRow(depth, foldable ? (open ? '▾' : '▸') : '');

    // 叶子：同一行里写完（缩进 + 键名 + 路径 + 值）
    if (!isStructured(child)) {
      const p = primitive(child);
      row.appendChild(fvEl('span', 'tr-full-key', keyText));
      row.appendChild(pathBtn(childPath));
      row.appendChild(fvEl('span', p.cls, ' ' + p.text));
      box.appendChild(row);
      continue;
    }

    // 深度用尽 ⇒ 整体压成一行（并标明它是个容器），避免缩进吃掉全部宽度
    if (depth >= MAX_DEPTH) {
      row.appendChild(fvEl('span', 'tr-full-key', keyText));
      row.appendChild(fvEl('span', 'tr-full-null', ' ' + oneLine(child)));
      box.appendChild(row);
      continue;
    }

    // 空容器：留一对括号，别让它看起来像"展开失败"
    if (sizeOf(child) === 0) {
      row.appendChild(fvEl('span', 'tr-full-key', keyText));
      row.appendChild(fvEl('span', 'tr-full-null', Array.isArray(child) ? ' []' : ' {}'));
      box.appendChild(row);
      continue;
    }

    row.appendChild(fvEl('span', 'tr-full-key', keyText));
    row.appendChild(pathBtn(childPath));
    if (!open) {
      const kind = Array.isArray(child) ? 'array' : 'object';
      row.appendChild(fvEl('span', 'tr-full-hint', ` { ${kind} · ${sizeOf(child)} 项 }`));
    } else if (Array.isArray(child) && tableColsOf(child)) {
      // 成表时行内不铺子项，只在键名后标一句规模 —— 否则 `▾ targets:` 后面直接跟着表格，
      // 看不出这是个数组、也看不出表格是不是全部内容（是不是被截断了）
      row.appendChild(fvEl('span', 'tr-full-hint', ` array · ${child.length} 项`));
    }
    row.dataset.fold = childPath;
    row.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (hasSelection()) return;
      ctx.fold.set(childPath, !open);
      ctx.repaint();
    });
    box.appendChild(row);

    if (open) renderInto(ctx, child, depth + 1, childPath);
  }

  if (keys.length > show.length) {
    const row = startRow(depth, '');
    row.appendChild(fvEl('span', 'tr-full-null', `… 还有 ${keys.length - show.length} 项未展开`));
    box.appendChild(row);
  }
}

/**
 * 建一个结构化正文块。
 * @param {any} value  `ev.full` 的**原值**（不是序列化后的字符串）
 * @param {{fold?: Map<string, boolean>}} [opts]
 *   `fold` 是**调用方持有**的折叠状态（路径 → 是否展开）。省略时本块自建一份，
 *   此时折叠状态活不过下一次「全量重建」—— 只对一次性渲染（测试、静态快照）够用。
 * @returns {Element}  `.tr-full` 块；调用方负责 append 到展开行之后
 */
export function createFullView(value, opts = {}) {
  const fold = opts.fold instanceof Map ? opts.fold : new Map();

  const box = fvEl('div', 'tr-full');
  box.dataset.kind = Array.isArray(value) ? 'array' : 'object';

  const head = fvEl('div', 'tr-full-head');
  head.appendChild(fvEl('span', 'tr-full-type', typeLabelOf(value)));
  const copy = fvEl('span', 'tr-full-copy', '复制');
  copy.dataset.copy = '1';
  copy.addEventListener('click', () => copyInto(copy, safeStringify(value), '已复制'));
  head.appendChild(copy);
  box.appendChild(head);

  const body = fvEl('div', 'tr-full-body');
  const ctx = { body, fold, repaint: null };
  // 只重画正文（不动头部）：折叠不需要重建整棵树，滚动位置与头部反馈都留着
  ctx.repaint = () => {
    body.innerHTML = '';
    renderInto(ctx, value, 0, '');
  };
  ctx.repaint();

  box.appendChild(body);
  return box;
}
