/* @migor/trace-view 的**单文件 bundle** 生成器（构建期，零运行时依赖）。
 *
 * 为什么要有它：`agentia view <trace.jsonl>` 要出**单文件自包含 HTML**（无外链、离线可开、
 * 可转发）—— 那就不能靠 HTTP 分文件提供 `index.js` / `view.js` / ...，得把它们合成一个
 * <script> 内联进去。
 *
 * ⚠️ **它不是第二份渲染器**：本文件不写任何渲染逻辑，只是把 `src/` 下各模块按依赖序
 * 去掉 `import/export` 后拼起来，导出名与依赖顺序**都从 src 现场解析**（不硬编码清单）。
 * 所以官网 playground、CLI inspector（用分文件 `dist/`）与本产物（用 bundle）三者
 * 共用同一份真源 `src/` —— 加模块 / 加导出都会自动跟上，不会漂。
 * 「bundle 与 src 同源」由 `test/bundle.test.js` 钉住（确定性重建 + 内容覆盖 + 公共面一致 +
 * 真渲一棵树）；「拼出来能当 classic script 跑」由本文件末尾的 `assertClassicScript` 兜住
 * （构建期，不等浏览器白屏）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

/** 本地相对 import / re-export 的模块名（只认 `./x.js` 这种同目录引用） */
function localDepsOf(code) {
  const deps = new Set();
  for (const m of code.matchAll(/from\s*'\.\/([^']+)'/g)) deps.add(m[1]);
  return [...deps];
}

/**
 * 依赖拓扑序（被依赖者在前）。
 * ⚠️ 环必须**响亮报错**：拼出来的 bundle 会静默地引用到尚未声明的 const（TDZ），
 * 浏览器里表现为「白屏 + 一条看不懂的 ReferenceError」，比构建期失败难查得多。
 */
function topoOrder(sources) {
  const order = [];
  const state = new Map();
  const stack = [];
  const visit = (file) => {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'visiting') {
      throw new Error(
        `[trace-view] src/ 存在循环依赖，无法拼成单文件：${[...stack, file].join(' → ')}`,
      );
    }
    state.set(file, 'visiting');
    stack.push(file);
    for (const dep of localDepsOf(sources.get(file))) {
      if (!sources.has(dep)) {
        throw new Error(`[trace-view] ${file} 引用了 src/ 里不存在的模块：./${dep}`);
      }
      visit(dep);
    }
    stack.pop();
    state.set(file, 'done');
    order.push(file);
  };
  for (const file of [...sources.keys()].sort()) visit(file);
  return order;
}

/**
 * 去掉模块边界语法：本地 import、re-export、`export` 声明前缀。
 * 只动**行首**的 `import`/`export` —— src 里两者都只在行首出现，不会误伤字符串或注释。
 */
function stripModuleSyntax(code) {
  return code
    .replace(/^import\s[\s\S]*?from\s*'\.\/[^']+';?[ \t]*$/gm, '')
    .replace(/^export\s*\{[\s\S]*?\}\s*from\s*'\.\/[^']+';?[ \t]*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:const|let|var|function\*?|class)\b)/gm, '');
}

/** 解析一个模块导出的名字（声明式 + `export { a, b as c }` 两种） */
function exportedNamesOf(code) {
  const names = new Set();
  for (const m of code.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/^export\s*\{([\s\S]*?)\}\s*(?:from\s*'[^']+'\s*)?;?[ \t]*$/gm)) {
    for (const part of m[1].split(',')) {
      const token = part.trim();
      if (!token) continue;
      const as = token.split(/\s+as\s+/);
      const name = (as[1] ?? as[0]).trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** 顶层声明名 —— 用于查「拼进同一作用域后撞名」（构建期报错，别等浏览器白屏） */
function topLevelNamesOf(code) {
  const names = new Map();
  const decl =
    /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of stripModuleSyntax(code).matchAll(decl)) {
    names.set(m[1], (names.get(m[1]) ?? 0) + 1);
  }
  return names;
}

/**
 * 构建期最后一道闸：把拼好的 body 按 **classic script** 编译一次。
 *
 * 为什么必须是 classic script 而不是 ESM：`agentia view` 把 bundle 内联进普通
 * `<script>`（module script 在 `file://` 下走 CORS，双击打开有失败风险）。两种消费
 * 方式的语法集**不同**，而 `test/bundle.test.js` 的「bundle 可 import」用的是宽松的
 * 那一种 ⇒ 凡是「合法 ESM、非法 classic script」的形态（`export default` / `export *` /
 * 残留副作用 `import './x.js'`）都会构建绿、测试绿，到浏览器里整页白屏 —— 而 CLI 已经
 * 打印了「已生成」（2026-10-21 实测：`import "./missing.js"` 就是这样溜过去的）。
 * `vm.Script` 按 script 而不是 function body 解析（比 `new Function` 严：顶层 `return`
 * 也拦得住），一次兜住整族。
 */
function assertClassicScript(body) {
  const filename = 'trace-view.bundle.js';
  try {
    new Script(body, { filename });
  } catch (e) {
    // 报错定位回 src 模块：body 里每个模块前都有 `/* ===== src/xxx.js ===== */`
    let where = '';
    const line = Number((/:(\d+)\b/.exec(String(e.stack ?? '').split('\n')[0]) ?? [])[1]);
    if (Number.isInteger(line) && line > 0) {
      const lines = body.split('\n');
      for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
        const m = /^\/\* ===== src\/(.+) ===== \*\/$/.exec(lines[i]);
        if (m) {
          where = `（src/${m[1]} 第 ${line - i} 行）`;
          break;
        }
      }
    }
    throw new Error(
      `[trace-view] 拼出的 bundle 不是合法 classic script${where}：${e.message}\n` +
        '  `agentia view` 把它内联进普通 <script> ⇒ 浏览器整页白屏（而 CLI 已打印「已生成」）。\n' +
        '  常见成因：`export default` / `export *` / 副作用 `import "./x.js"` / 子目录 import ' +
        '—— stripModuleSyntax 只剥行首那四类带 from 的写法。',
    );
  }
}

const BANNER = `/* @migor/trace-view —— 单文件 bundle（由 scripts/bundle.mjs 从 src/ 自动生成，请勿手改）。
 * 用途：\`agentia view\` 出的单文件自包含 HTML 内联本文件（无外链 / 离线可开 / 可转发）。
 * 真源仍是 src/；改渲染逻辑请改那里再跑 build。零依赖、纯 ESM。 */`;

/**
 * 生成 bundle 文本。
 * @param {string} srcDir `packages/trace-view/src`
 * @returns {string} bundle 源码
 */
export function buildBundle(srcDir) {
  const files = readdirSync(srcDir)
    .filter((f) => f.endsWith('.js'))
    .sort();
  const sources = new Map(files.map((f) => [f, readFileSync(join(srcDir, f), 'utf8')]));
  const order = topoOrder(sources);

  // 撞名检测：拼进同一作用域后，`const X` 出现两次是 SyntaxError（整页白屏）
  const seen = new Map();
  for (const file of order) {
    for (const [name] of topLevelNamesOf(sources.get(file))) {
      const prev = seen.get(name);
      if (prev !== undefined) {
        throw new Error(
          `[trace-view] 顶层名字 "${name}" 在 ${prev} 与 ${file} 各声明了一次 —— 拼成单文件后是 ` +
            '重复声明（SyntaxError，浏览器整页白屏）。请改名或把它们收进同一个模块。',
        );
      }
      seen.set(name, file);
    }
  }

  // 拼 body 并按 classic script 编译一次 —— **放在导出面检查之前**：畸形语法（`export
  // default` / 副作用 import / `export *`）本来就解析不出导出名，先跑导出面检查只会报
  // 「解析不到任何导出 —— 正则可能已失灵」，把真正的错误指到别处去（实测踩过）。
  const body = order
    .map((f) => `/* ===== src/${f} ===== */\n${stripModuleSyntax(sources.get(f)).trim()}`)
    .join('\n\n');
  assertClassicScript(body);

  const exported = new Set();
  for (const file of order) {
    for (const name of exportedNamesOf(sources.get(file))) exported.add(name);
  }
  if (exported.size === 0)
    throw new Error('[trace-view] src/ 里解析不到任何导出 —— 正则可能已失灵');

  const exports = [...exported]
    .sort()
    .map((n) => `  ${n},`)
    .join('\n');
  return `${BANNER}\n\n${body}\n\nexport {\n${exports}\n};\n`;
}
