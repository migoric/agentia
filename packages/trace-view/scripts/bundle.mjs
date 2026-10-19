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
 * 「bundle 与 src 同源」由 `test/bundle.test.js` 钉住（确定性重建 + 内容覆盖 + 公共面一致）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

  const exported = new Set();
  for (const file of order) {
    for (const name of exportedNamesOf(sources.get(file))) exported.add(name);
  }
  if (exported.size === 0)
    throw new Error('[trace-view] src/ 里解析不到任何导出 —— 正则可能已失灵');

  const body = order
    .map((f) => `/* ===== src/${f} ===== */\n${stripModuleSyntax(sources.get(f)).trim()}`)
    .join('\n\n');
  const exports = [...exported]
    .sort()
    .map((n) => `  ${n},`)
    .join('\n');
  return `${BANNER}\n\n${body}\n\nexport {\n${exports}\n};\n`;
}
