/*
 * 架构守卫 —— AGENTS.md「零运行时依赖」的**可执行版本**。
 *
 * 为什么需要它：这条铁律从 2026-09-17 达成至今只写在 AGENTS.md §硬约定 里，**没有任何测试兜底**。
 * 而它的失效方式恰好是最隐蔽的一种 —— 加一行 `import { z } from 'zod'` 就能让「零依赖」变成
 * 「一个依赖」：`npm test` 全绿、`tsc` 全绿、`npm publish` 照常成功，直到使用者装上包才发现
 * 多了一个（可能带漏洞、可能与框架版本冲突的）传递依赖。同类教训本仓库已有先例：
 * 分层约定写在 AGENTS.md 里、没有守卫，于是 `store → runtime` 悄悄存在了很久
 * （见 layering.test.ts 头注）。
 *
 * ## 本守卫断言什么
 *
 *   ① **源码层**：`src/**`、`packages/cli/src/**`、`packages/trace-view/src/**` 的
 *      **模块说明符**只能是相对路径或 Node 内置模块 —— 其余（含 `@migor/*`）一律违规；
 *   ② **元数据层**：这三个包的 `package.json` 不得有非空 `dependencies`；
 *   ③ **范围层**：`packages/` 下每个目录必须在 IN_SCOPE 或 EXCLUDED 里登记
 *      （新加包不能悄悄逃出铁律）。
 *
 * ## 为什么源码层干净 ⇒ 产物层干净
 *
 * 全仓**没有任何打包器**（无 esbuild / rollup / webpack / vite，已核）：
 *   - `@migor/agentia`：`tsc -p tsconfig.json` —— 1:1 转译，import 说明符**逐字保留**；
 *   - `@migor/cli`：`tsc -p packages/cli/tsconfig.json` —— 同上（templates 另走一个只做检查的 tsconfig）；
 *   - `@migor/trace-view`：`scripts/build.mjs` 是**纯文件拷贝**（src/*.js|css → dist/）。
 * 既然没有「构建期内联第三方」这一步，源码里没有第三方 import ⇒ 产物里也没有。
 * （哪天引入打包器，本推理失效 —— 那时必须补一条**产物层**守卫，见文件末 §待办。）
 *
 * ## 扫描器（`lib/source-scan.ts`）为什么必须存在
 *
 * 朴素正则在**真实语料**上会产生 5 处假阳性，全部实测过：
 *   - `src/toolkit/zod.ts`、`asset.ts`、`env.ts`：JSDoc **块注释**里的用法示例
 *     （`import { z } from 'zod';`）—— 注释不是代码；
 *   - `packages/cli/src/harvest.ts`：**模板字符串**里生成的脚手架文本，含整行
 *     `import { defineEval, scriptedClient } from '@migor/agentia';` —— 那是**给用户项目**的文本；
 *   - `packages/cli/src/registry.ts`：模板字符串里生成 `import X from '${source}';`
 *     —— `agentia add` 登记的第三方包，**用户项目当然可以引**。
 * 而它还必须认得出 `packages/cli/src/npm-bin.ts` 里那颗**同时含双引号与反引号**的正则
 * `/([()\][%!^"`<>&|;, *?])/g` —— 不认正则的扫描器会在那里错位，把后面的真 import 一起吞掉
 * （**假阴性**方向，比假阳性危险得多）。
 * 也**没有**改用 TypeScript 编译器 API：本仓的 typescript 是 7.x（Go 原生移植版），
 * 完整 AST 面只在 `typescript/unstable/*` 下 —— 拿**不稳定 API** 当架构守卫的地基不合适。
 *
 * ## 新增例外
 *
 * 往 ALLOWLIST 里加，**必须**写明理由（且同步改 AGENTS.md §硬约定）。
 * 目前它是空的 —— 这是设计意图（AGENTS.md：「框架永不 import」第三方客户端）。
 *
 * ## §待办（已知缺口，刻意留着）
 *
 * 产物层没有独立守卫：本文件靠「全仓无打包器」这条事实把源码层结论推到产物层。
 * 若将来引入打包器（或开始 `import` 编译期宏），需补一条扫 `dist/**` 的守卫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SpecKind, classify, scan } from './lib/source-scan.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 铁律覆盖的源码目录（**只**这三个包的 src）。
 *
 * ⚠️ `packages/pg/src` 刻意**不在**这里，理由是它的情况与铁律的前提相反：
 * 本包的存在意义就是复用框架的公共面（`TaskStore` 类型 + `serializeTaskRecord` /
 * `parseTaskRecord` 这两个"落库/读回唯一入口"），必须 `import '@migor/agentia'`。
 * 铁律防的是"框架 import 第三方客户端"（ioredis / kafkajs / pg 驱动）；`@migor/agentia`
 * 是**自家框架的 peer**，不是第三方，且它不进任何人的依赖树。
 * 第三方运行时依赖对它仍是零：PG 客户端 duck-typed，PGlite 在 devDependencies ——
 * 这一半由下方 IN_SCOPE_PACKAGES 的元数据层继续守着（它不许有非空 `dependencies`）。
 */
const IN_SCOPE = ['src', join('packages', 'cli', 'src'), join('packages', 'trace-view', 'src')];

/** 铁律覆盖的包清单（元数据层用）。注意它比 IN_SCOPE 多一个 `pg` —— 见上方注释。 */
const IN_SCOPE_PACKAGES = [
  'package.json',
  join('packages', 'cli', 'package.json'),
  join('packages', 'trace-view', 'package.json'),
  join('packages', 'pg', 'package.json'),
];

/**
 * `packages/` 下**不在**铁律内的包 —— 必须有理由，且理由要能对上 AGENTS.md。
 * 这条断言防的是「新加一个包，顺手引一堆依赖，而铁律守卫看不见」。
 */
const EXCLUDED: Record<string, string> = {
  website:
    '私有 Astro 站点（AGENTS.md「官网（Astro）」：只影响官网，与框架本体和两个 npm 包无关）；' +
    '不进任何 npm 产物，故不受零运行时依赖约束',
};

/**
 * 允许的第三方说明符 → 理由。**当前为空是设计意图**，不是「还没人违规」：
 * AGENTS.md「宿主 / 集成接入不打包」的判别规则是「客户端是不是标准库」，
 * 要引第三方客户端的（gRPC / Kafka）只留 duck-typed 缝 + 配方 / 示例，框架永不 import。
 * 真要开例外，在这里写明理由（≥ 20 字）并同步改 AGENTS.md。
 */
const ALLOWLIST: Record<string, string> = {};

// ─────────────────────────── 语料收集 ───────────────────────────

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

interface Site {
  /** 仓库相对路径（报错用） */
  file: string;
  spec: string;
  kind: SpecKind;
  /** 1-based 行号 */
  line: number;
}

const sites: Site[] = [];
/** 扫到的**相对**说明符总数 —— 「防真空变绿」下限断言用 */
let relativeCount = 0;
/** 扫到的说明符总数 */
let totalCount = 0;
/** 扫到 ≥ 1 个说明符的文件数 —— 比总数更细的防真空护栏 */
let filesWithSpecs = 0;

const files = IN_SCOPE.flatMap((d) => walkFiles(join(repoRoot, d)));

for (const abs of files) {
  const raw = readFileSync(abs, 'utf8');
  const { specs } = scan(raw);
  const rel = relative(repoRoot, abs);
  if (specs.length > 0) filesWithSpecs += 1;
  for (const { spec, index } of specs) {
    totalCount += 1;
    const kind = classify(spec, isBuiltin);
    if (kind === 'relative') {
      relativeCount += 1;
      continue;
    }
    if (kind === 'builtin') continue;
    if (kind === 'external' && spec in ALLOWLIST) continue;
    sites.push({ file: rel, spec, kind, line: raw.slice(0, index).split('\n').length });
  }
}

// ─────────────────────────── ① 源码层 ───────────────────────────

test('源码层：三个包的 src 只 import 相对路径 / node: 内置模块', () => {
  assert.deepEqual(
    sites.map((s) => `${s.file}:${s.line}  →  '${s.spec}'（${s.kind}）`),
    [],
    [
      '零运行时依赖是**全仓铁律**（AGENTS.md §硬约定），以上 import 会破坏它：',
      '',
      '  · external —— 引入第三方运行时依赖：把代码改成 duck-typed 缝 + 配方/示例，',
      '    或（若确实是标准库能力）直接用 Node 内置模块；',
      '  · workspace —— src 不得 import 兄弟包（CLI 尤其：AGENTS.md 要求 CLI 包零 @migor/* 依赖，',
      '    需要框架实例时走 req.resolve() 由**用户工程**解析，见 packages/cli/src/dev-runner.ts）。',
      '',
      "注意：`import type ... from 'x'` 同样计入 —— AGENTS.md 对可选能力（zod / redis 客户端）",
      '的口径是 duck-typed / peer，即**结构类型**，不 import。',
      '',
      '确有例外时：在本文件的 ALLOWLIST 里写明理由，并同步更新 AGENTS.md ——',
      '两边不一致会在这里失败（这是设计意图，不是障碍）。',
    ].join('\n'),
  );
});

// ─────────────────────────── ①-b PG 适配包源码层 ───────────────────────────

/**
 * `packages/pg/src` 不在主 `IN_SCOPE` 里，但也不能完全裸奔：它必须允许
 * `@migor/agentia`（自家 peer），禁止任何**第三方**运行时 import。否则以后有人
 * 在 pg 包里 `import { Pool } from 'pg'`，零依赖铁律就会从这里漏过去。
 */
test('packages/pg/src：只允许相对路径 / node: / 自家 @migor/agentia', () => {
  const bad: string[] = [];
  for (const abs of walkFiles(join(repoRoot, 'packages', 'pg', 'src'))) {
    const raw = readFileSync(abs, 'utf8');
    for (const { spec, index } of scan(raw).specs) {
      const kind = classify(spec, isBuiltin);
      if (kind === 'relative' || kind === 'builtin') continue;
      if ((kind === 'external' || kind === 'workspace') && spec === '@migor/agentia') continue;
      bad.push(
        `${relative(repoRoot, abs)}:${raw.slice(0, index).split('\n').length}  →  '${spec}'（${kind}）`,
      );
    }
  }
  assert.deepEqual(
    bad,
    [],
    'packages/pg/src 只允许 node: / 相对路径 / @migor/agentia（PG 客户端必须 duck-typed）',
  );
});

// ─────────────────────────── ② 元数据层 ───────────────────────────

test('元数据层：登记的每个包 package.json 无非空 dependencies', () => {
  const bad: string[] = [];
  for (const rel of IN_SCOPE_PACKAGES) {
    const abs = join(repoRoot, rel);
    assert.ok(existsSync(abs), `${rel} 不存在 —— IN_SCOPE_PACKAGES 写错了`);
    const pkg = JSON.parse(readFileSync(abs, 'utf8')) as {
      dependencies?: Record<string, string>;
      name?: string;
    };
    const names = Object.keys(pkg.dependencies ?? {});
    if (names.length > 0) {
      bad.push(`${rel}（${pkg.name ?? '?'}）有 ${names.length} 个运行时依赖：${names.join(', ')}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `铁律要求这三个包零运行时依赖（依赖只能进 devDependencies）：\n${bad.join('\n')}`,
  );
});

// ─────────────────────────── ③ 范围层 ───────────────────────────

test('范围层：packages/ 下每个包都已登记（IN_SCOPE 或 EXCLUDED）', () => {
  const inScopePkgNames = new Set(
    IN_SCOPE_PACKAGES.map((p) => p.split(sep)[1]).filter((x): x is string => Boolean(x)),
  );
  const unknown: string[] = [];
  for (const e of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (inScopePkgNames.has(e.name) || e.name in EXCLUDED) continue;
    unknown.push(
      `packages/${e.name}/ 未登记 —— 若它进 npm 产物，请加进 IN_SCOPE / IN_SCOPE_PACKAGES；` +
        '若它与框架无关（如私有站点），加进 EXCLUDED 并写明理由',
    );
  }
  assert.deepEqual(unknown, [], `发现未登记的包：\n${unknown.join('\n')}`);
});

test('EXCLUDED 的每一项都带非空理由（防「加个名字就豁免」）', () => {
  const thin = Object.entries(EXCLUDED)
    .filter(([, reason]) => reason.trim().length < 20)
    .map(([name]) => `packages/${name}/ 的理由过短（< 20 字），等于没写`);
  assert.deepEqual(thin, [], thin.join('\n'));
  for (const name of Object.keys(EXCLUDED)) {
    assert.ok(
      existsSync(join(repoRoot, 'packages', name)),
      `EXCLUDED 里的 packages/${name}/ 不存在 —— 清理掉这条豁免`,
    );
  }
});

// ─────────────────────────── ④ ALLOWLIST 的诚实性 ───────────────────────────

test('ALLOWLIST 为空（AGENTS.md「框架永不 import」第三方客户端）', () => {
  assert.deepEqual(
    Object.keys(ALLOWLIST),
    [],
    'ALLOWLIST 被加了例外。这是**有意的摩擦**：开例外必须同步改 AGENTS.md 的硬约定并在此写明理由；' +
      '若确属有意，请连同本断言一起改（让 review 看见这个决定）。',
  );
});

test('ALLOWLIST 若有条目，理由必须够长', () => {
  const thin = Object.entries(ALLOWLIST)
    .filter(([, reason]) => reason.trim().length < 20)
    .map(([spec]) => `${spec} 的理由过短（< 20 字）`);
  assert.deepEqual(thin, [], thin.join('\n'));
});

// ─────────────────────────── ⑤ 防真空变绿 ───────────────────────────

test('扫描器没有吞掉真代码（解析计数下限护栏）', () => {
  // ⚠️ 这是护栏，不是指标：扫描器若在某处错位（例如不认 npm-bin.ts 那颗含引号的正则），
  // 后面的真 import 会被一起遮蔽 —— 那时「没有第三方 import」是**假**绿。
  // 实测水位（2026-09-22，113 个文件）：相对说明符 417 / 说明符总数 480 / 有说明符的文件 89。
  // 跌破下限说明扫描器漏了某种形式，而不是「代码没有导入了」。
  assert.ok(files.length >= 100, `只扫到 ${files.length} 个文件 —— IN_SCOPE 走空了`);
  assert.ok(
    relativeCount >= 250,
    `只扫到 ${relativeCount} 处相对说明符 —— 扫描器大概率错位吞掉了真代码（① 号断言在空转）`,
  );
  assert.ok(totalCount >= 300, `只扫到 ${totalCount} 处说明符 —— 同上，扫描器可疑`);
  assert.ok(
    filesWithSpecs >= 60,
    `只有 ${filesWithSpecs} 个文件扫到说明符 —— 多数文件被整篇遮蔽了（假阴性方向）`,
  );
});

// ─────────────────────────── ⑥ 扫描器自身的合成样本 ───────────────────────────

test('扫描器：注释 / 字符串 / 模板 / 正则里的 import 一律不算（真实假阳性形态）', () => {
  const samples: Array<[string, string]> = [
    ['块注释里的用法示例（src/toolkit/zod.ts 形态）', "/*\n * import { z } from 'zod';\n */\n"],
    ['行注释（harvest.ts 尾部形态）', "// import { createApp } from '@migor/agentia';\n"],
    [
      '模板字符串里的整行 import（harvest.ts 形态）',
      "const s = `\nimport { defineEval } from '@migor/agentia';\n`;\n",
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 夹具**就是**含 ${} 的源码文本，改成模板字符串语义就变了
    ['模板插值里生成 import（registry.ts 形态）', "const l = `import ${P} from '${src}';`;\n"],
    ['普通字符串里像 import 的文本', 'const doc = "import x from \'lodash\';";\n'],
    ['正则字面量含引号与反引号（npm-bin.ts 形态）', 'const re = /([()\\][%!^"`<>&|;, *?])/g;\n'],
    ['return 后的正则（/ 不是除号）', 'function f() { return /a\\/b/.test(s); }\n'],
    ['Array.from 不是说明符引导词', "const a = Array.from('abc');\n"],
    ['对象字面量里的 from 键', "const o = { from: 'lodash' };\n"],
    ['字符串里带 from 的散文', "const s = 'copied from \\'zod\\' docs';\n"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上 —— 夹具是含 ${} 的源码文本
    ['模板插值里的字符串', 'const s = `${"zod"}`;\n'],
  ];
  for (const [label, src] of samples) {
    const found = scan(src).specs.map((f) => f.spec);
    assert.deepEqual(found, [], `${label} —— 非代码文本被当成了依赖边：${JSON.stringify(found)}`);
  }
});

test('扫描器：真 import 必须被看见（阳性对照 —— 没有它「0 处违规」不可证伪）', () => {
  // 这是本文件最关键的一条：若扫描器退化成「什么都遮蔽」，上面所有断言会 vacuous 全绿。
  const cases: Array<[string, string, string]> = [
    ['具名导入', "import { z } from 'zod';\n", 'zod'],
    ['默认导入', "import lodash from 'lodash';\n", 'lodash'],
    ['副作用导入', "import 'reflect-metadata';\n", 'reflect-metadata'],
    ['再导出', "export { x } from '@migor/agentia';\n", '@migor/agentia'],
    ['export *', "export * from './mod.js';\n", './mod.js'],
    ['动态 import 字面量', "const m = await import('node:fs');\n", 'node:fs'],
    ['内联类型导入', "type T = import('zod').ZodType;\n", 'zod'],
    ['import type', "import type { ZodType } from 'zod';\n", 'zod'],
    ['跨行导入', "import {\n  a,\n  b,\n} from 'zod';\n", 'zod'],
    ['import = require', "import fs = require('node:fs');\n", 'node:fs'],
    ['require 调用', "const fs = require('node:fs');\n", 'node:fs'],
    ['双引号形式', 'import x from "zod";\n', 'zod'],
    ['from 后换行', "import x from\n  'zod';\n", 'zod'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上 —— 夹具是含 ${} 的源码文本
    ['模板字符串之后紧跟的真 import', "const s = `a${1}b`;\nimport x from 'zod';\n", 'zod'],
  ];
  for (const [label, src, want] of cases) {
    const found = scan(src).specs.map((f) => f.spec);
    assert.ok(found.includes(want), `${label}：应解析到 '${want}'，实际 ${JSON.stringify(found)}`);
  }
});

test('扫描器：真 import 与真实假阳性同处一个文件时各归各位（综合样本）', () => {
  // 把真实语料里的危险形态与真 import 混在一起 —— 既要放过前者，又不能吞掉后者。
  const src = [
    '/*',
    " * 用法：import { z } from 'zod';",
    ' */',
    "import { readFileSync } from 'node:fs';",
    "import { helper } from './helper.js';",
    'const scaffold = `',
    "import { createApp } from '@migor/agentia';",
    '`;',
    'const re = /([()\\][%!^"`<>&|;, *?])/g;',
    "import('zod').then(() => {});",
    "const from = 'not-a-dep';",
    '',
  ].join('\n');
  assert.deepEqual(
    scan(src)
      .specs.map((f) => f.spec)
      .sort(),
    ['./helper.js', 'node:fs', 'zod'].sort(),
    '真 import（node:fs / ./helper.js / 动态 zod）要留，注释与模板里的要遮蔽',
  );
});

test('扫描器保长度与换行（报错行号不失真）', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 夹具是含 ${} 的源码文本（要测的正是模板字符串的遮蔽）
  const src = "import 'a';\nconst s = `x\n${1 + 2}\ny`;\n/* c\nc */\nconst r = /[/'\"`]/;\n";
  const { masked } = scan(src);
  assert.equal(masked.length, src.length, '遮蔽不得改变长度');
  assert.equal(
    masked.split('\n').length,
    src.split('\n').length,
    '遮蔽不得增删换行（行号用于报错定位）',
  );
});

test('扫描器报出的行号与源文件一致', () => {
  const src = "const a = 1;\n\nimport { z } from 'zod';\n";
  const found = scan(src).specs;
  assert.equal(found.length, 1);
  assert.equal(src.slice(0, found[0].index).split('\n').length, 3, '应报在第 3 行');
});

// ─────────────────────────── ⑦ 真实语料的定点回归钉 ───────────────────────────

test('回归钉：5 处真实假阳性站点必须判零违规', () => {
  // 这 5 处是「用朴素正则写本守卫」时**必然误报**的站点，逐个钉住。
  const pins: Array<[string, string]> = [
    ['src/toolkit/zod.ts', '块注释里的 zod 用法示例'],
    ['src/toolkit/asset.ts', "块注释里的 import { SubAgent, asset } from 'agentia'"],
    ['src/toolkit/env.ts', "块注释里的 '@migor/agentia' 示例"],
    ['packages/cli/src/harvest.ts', '模板字符串里生成的脚手架 import 行'],
    ['packages/cli/src/registry.ts', '模板字符串里生成用户项目的 import 行'],
  ];
  for (const [rel, why] of pins) {
    const abs = join(repoRoot, rel);
    assert.ok(existsSync(abs), `${rel} 不存在 —— 回归钉要跟着代码走`);
    const bad = scan(readFileSync(abs, 'utf8'))
      .specs.map((s) => s.spec)
      .filter((s) => {
        const k = classify(s, isBuiltin);
        return k === 'external' || k === 'workspace';
      });
    assert.deepEqual(
      bad,
      [],
      `${rel}（${why}）被判出 ${JSON.stringify(bad)} —— 扫描器在这个形态上失灵了`,
    );
  }
});

test('回归钉：@migor/agentia 出现在 req.resolve() 字符串参数里不算 import', () => {
  // packages/cli/src/dev-runner.ts：`req.resolve('@migor/agentia')` 是**运行期**解析用户工程里的
  // 框架实例，不是 CLI 的依赖 —— 这正是 AGENTS.md 允许 CLI 零 @migor/* 依赖的机制。
  const abs = join(repoRoot, 'packages', 'cli', 'src', 'dev-runner.ts');
  const raw = readFileSync(abs, 'utf8');
  assert.ok(raw.includes("req.resolve('@migor/agentia')"), '前提变了：该文件不再用 req.resolve');
  const specs = scan(raw).specs.map((s) => s.spec);
  assert.ok(
    !specs.includes('@migor/agentia'),
    `req.resolve 的字符串参数被误判成 import：${JSON.stringify(specs)}`,
  );
});

test('回归钉：扫描器在 npm-bin.ts 那颗含引号与反引号的正则处不错位', () => {
  // 那颗正则同时含 " 与 `，是扫描器最容易错位的形态。错位后它会从 `"` 开始吞，
  // 一路遮蔽到下一个 `"`（第 34 行）—— 中间的 escapeCmdCommand / escapeCmdArg 会从遮蔽文本里消失。
  // 注意：该文件**本身没有任何 import**，所以不能靠「说明符数」判错位，得看代码是否还在。
  const abs = join(repoRoot, 'packages', 'cli', 'src', 'npm-bin.ts');
  const raw = readFileSync(abs, 'utf8');
  assert.ok(raw.includes('"`'), '前提变了：那颗含引号与反引号的正则不在了（回归钉需重挑样本）');
  const { masked, specs } = scan(raw);
  assert.equal(masked.length, raw.length, '遮蔽不得改变长度');
  assert.deepEqual(
    specs.map((s) => s.spec),
    [],
    '该文件没有任何 import —— 判出说明符说明扫描器在正则处错位后「读」出了假说明符',
  );
  for (const ident of ['CMD_META_CHARS', 'escapeCmdCommand', 'escapeCmdArg', 'npmSpawn']) {
    assert.ok(
      masked.includes(ident),
      `错位迹象：${ident} 在遮蔽文本里消失了 —— 扫描器从第 20 行的 \`"\` 开始吞代码`,
    );
  }
});

test('回归钉：全语料逐文件不吞真代码（有行首 import 就必须扫到说明符）', () => {
  // 比总数下限更细的护栏：总数达标可能是「多数文件正常、个别文件整篇被吞」。
  // 独立信号用**行首 `import`**（真实代码的导入都在行首；不用 `export` ——
  // `export function/interface/type` 不是依赖边，src/core/json.ts 就一条 import 都没有）。
  const suspicious: string[] = [];
  let filesWithLineStartImport = 0;
  for (const abs of files) {
    const raw = readFileSync(abs, 'utf8');
    const lineStartImports = (raw.match(/^[ \t]*import\b/gm) ?? []).length;
    if (lineStartImports === 0) continue;
    filesWithLineStartImport += 1;
    if (scan(raw).specs.length === 0) {
      suspicious.push(
        `${relative(repoRoot, abs)}：有 ${lineStartImports} 处行首 import，却扫到 0 个说明符`,
      );
    }
  }
  assert.ok(
    filesWithLineStartImport >= 60,
    `只有 ${filesWithLineStartImport} 个文件有行首 import —— 信号本身可疑，本断言在空转`,
  );
  assert.deepEqual(
    suspicious,
    [],
    `以下文件疑似被整篇遮蔽（假阴性方向）：\n${suspicious.join('\n')}`,
  );
});
