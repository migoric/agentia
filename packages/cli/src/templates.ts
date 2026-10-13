/** 命名工具与脚手架模板加载（零依赖）
 *
 * 模板是 `packages/cli/templates/` 下的**真文件**，不再是本文件里的字符串 ——
 * 字符串不过编译器：模板代码对仓库自己的 typecheck/lint 不可见，缺陷要等用户
 * npm install 后才暴露（discover 路径「生产必崩」就是这么漏出去的）。真文件化后
 * 模板被仓库自己的工具链全程照看：`tsconfig.templates.json` 把它纳入 tsc
 * （'@migor/agentia' 经 paths 映射到框架 src）；Biome 收 lint，formatter 对 templates/** 关闭（生成物字节是兼容契约，见 biome.jsonc）。
 *
 * 占位符纪律：token 只许出现在**字符串 / 注释 / 标识符**位置
 * （`__PROJECT_NAME__` / `__NAME__` / `__CLASS_NAME__` / `__METHOD_NAME__`），
 * 不许出现在类型位置或语法关键位置 —— 这样模板文件自身就是合法的 TS/JSON，
 * 能过 tsc 与 Biome。渲染 = 读文件 + replaceAll。
 *
 * 点文件在包里用**无点文件名**（`gitignore` / `env` / `env.example`，写出时才补点）：
 * `.env` 会被仓库根 .gitignore 吞掉（根本进不了版本库），`.gitignore` 会被
 * npm pack 静默剥掉（CRA 当年就是这么踩的）—— 模板文件必须在 tarball 里活着。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** hello-world → HelloWorld */
export function kebabToPascal(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** hello-world → hello_world */
export function kebabToSnake(name: string): string {
  return name.replace(/-/g, '_');
}

export type CapabilityType = 'tool' | 'skill' | 'prompt' | 'subagent';

export const CAPABILITY_TYPES: readonly CapabilityType[] = ['tool', 'skill', 'prompt', 'subagent'];

export function isCapabilityType(value: string): value is CapabilityType {
  return (CAPABILITY_TYPES as readonly string[]).includes(value);
}

// ---------- 目录约定（spec §7：四分类目录，一能力一文件夹，无伞形词） ----------

/**
 * 能力类型 → 分类目录。目录名即「里面装什么」，不再用一个需要图例解释的伞形词：
 * 用户看一眼 `src/tools/weather/index.ts` 就知道它是工具。
 */
export const CAPABILITY_DIRS: Record<CapabilityType, string> = {
  tool: 'src/tools',
  skill: 'src/skills',
  prompt: 'src/prompts',
  subagent: 'src/subagents',
};

/** 全部能力目录（顺序即 discover 的装配顺序） */
export const CAPABILITY_DIR_LIST: readonly string[] = CAPABILITY_TYPES.map(
  (t) => CAPABILITY_DIRS[t],
);

/** 显式注册表位置（`agentia g` / `agentia add` 维护，`agentia doctor` 校验） */
export const REGISTRY_PATH = 'src/registry.ts';

// ---------- 注册表标记（registry.ts codemod 的锚点，模板文件里就是这几行字面量） ----------

export const IMPORTS_END_MARKER = '// @agentia:imports-end';
export const ENTRIES_END_MARKER = '// @agentia:entries-end';

// ---------- 模板文件加载 ----------

/**
 * 定位模板文件：发布物里在 dist/templates/（构建时由 scripts/copy-assets.mjs 拷入），
 * 源码直跑（tsx src/…）时在包根 templates/。找不到就**明确失败**，不生成缺件项目。
 */
function templatePath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'templates', rel), // 发布物：dist/templates/
    join(here, '..', 'templates', rel), // 源码直跑：src/ → 包根 templates/
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`找不到脚手架模板 ${rel}。查找过：\n  ${candidates.join('\n  ')}`);
}

/** 读模板文件并替换占位符（token 只许在字符串/注释/标识符位置，见文件头说明） */
function renderTemplate(rel: string, vars: Record<string, string> = {}): string {
  let text = readFileSync(templatePath(rel), 'utf8');
  for (const [token, value] of Object.entries(vars)) text = text.replaceAll(token, value);
  return text;
}

/** 能力模板的三类占位符：名字本身（注释/描述串）+ 类名 + 方法名 */
function capabilityVars(name: string): Record<string, string> {
  return {
    __NAME__: name,
    __CLASS_NAME__: kebabToPascal(name),
    __METHOD_NAME__: kebabToSnake(name),
  };
}

// ---------- create 命令模板 ----------

/**
 * 脚手架 package.json（templates/package.json）。两处口径钉在这里，改动前先读：
 * - `scripts.dev` 走 CLI 的 dev（本地 inspector 面板 + CLI 自己管的 runner）：与文档/其它命令同一条路，
 *   而不是「npm run dev 少一个面板、CLI dev 多一个面板」两种 dev；`npm run dev -- "你的问题"`
 *   的参数由 CLI 原样透传给脚本。
 * - `@migor/cli` 装进 devDependencies（而不是让用户每次 npx 去 registry 拉）：工程内
 *   `npx agentia …` 走本地 bin —— 离线可用，且版本被 pin 住与框架同批。
 *   这两条 pin（框架 + CLI）是**版本发布面**（scripts/release-surface.mjs），格式不能动。
 * - `start` / `start:prod` **同物**（都是 `node dist/main.js`）是刻意的：本脚手架的 dev 路径
 *   是 `npm run dev`，所以 `start` 已经是「跑 dist 的那条」——`start:prod` 只是把
 *   「这是生产入口」显式写出来（NestJS 用户会敲这个名字）。多一行 script，不是第二条路。
 */
export function projectPackageJson(name: string): string {
  return renderTemplate('package.json', { __PROJECT_NAME__: name });
}

/**
 * 脚手架 tsconfig（templates/tsconfig.json）。两处口径：
 * - `rootDir: src` + `outDir: dist`：编译产物落 dist/（npm run build → npm start 跑
 *   dist/main.js）；.md 文本资产由 scripts/copy-assets.mjs 跟随同相对路径拷过去
 *   （asset(import.meta.url, './x.md') 按**文件位置**解析，.md 必须跟着 .js 走）。
 * - `types: ['node']`：框架零运行时依赖（不再有厂商 SDK 经传递链把 @types/node 带进
 *   编译程序），node 全局类型必须显式声明。
 */
export function projectTsconfig(): string {
  return renderTemplate('tsconfig.json');
}

/**
 * 装配模块 app.ts（templates/src/app.ts）—— **与启动分离**的那个工厂。
 *
 * 为什么单独一个文件（D9(d)）：dev 环要驱动用户的 app，就得有个「接受选项的工厂」
 * 能喂进能力选择与工作目录。`CAPABILITY_DIRS` 也在它里面，且**同时是面板能力选择器的
 * 菜单来源** —— 两侧同一个常量，不会漂移。
 *
 * ⚠️ 它是**破坏性模板变更**的一部分：老工程只有 main.ts，`agentia dev` 会明确报错
 * 并给出迁移指引（不静默降级）。迁移是机械的：把 main.ts 里 createApp(...) 那一段
 * 整体搬进 app.ts 并包成工厂。
 */
export function appTs(name: string): string {
  return renderTemplate('src/app.ts', { __PROJECT_NAME__: name });
}

/**
 * dev 环的数据声明（templates/src/dev.config.ts）。
 *
 * 只放**数据**，不放逻辑 —— 逻辑副本会漂移（CLI 修了 bug，工程里那份不会变），
 * 数据不会。所以 `dev.ts` 被否掉，`dev.config.ts` 留下（D8 ②）。
 */
export function devConfigTs(): string {
  return renderTemplate('src/dev.config.ts');
}

/**
 * 文件后端 SessionStore（templates/src/session-store.ts）。
 *
 * 放在**模板**而不是框架里：它是对话型能力的**可选件**（任务型能力根本不需要对话历史，
 * 对它们是负担 —— 跨仓库串味）。用户能直接改，换 sqlite / Redis 只改这一个文件。
 */
export function sessionStoreTs(): string {
  return renderTemplate('src/session-store.ts');
}

/**
 * 脚手架自带的第二个能力：read-file 工具（templates/src/tools/read-file/index.ts）。
 *
 * 它存在的理由是**把「工作目录」这条线接通**：面板上那个文件夹控件，只有某个能力真的
 * 消费了注入进来的根，才有可观测的效果。顺带它也是能力多选的第一个演示对象
 * （一个工程里 ≥2 个能力，选择器才有东西可选）。
 */
export function readFileToolIndexTs(): string {
  return renderTemplate('src/tools/read-file/index.ts');
}

/**
 * 默认入口 main.ts（templates/src/main.ts）—— **HTTP 服务**：`npm run build && npm start`
 * 起来的就是它，在 `PORT` 上长期监听（NestJS 的 `main.ts` 那条口径）。
 * `createHttpHandler` + `AsyncRunner` + `SqliteTaskStore`（崩溃续跑）+ drain 优雅停机 +
 * 可选 Bearer 鉴权（AGENTIA_TOKEN）。
 *
 * **无条件生成、而且是默认**：脚手架的交付承诺是「build 产物 run 起来就是个能用的服务」。
 * 服务化不该让用户自己去 examples/deploy 抄，也不该让用户先翻 README 才知道该起哪个入口。
 * ⚠️ 与 batch.ts 同一道闸：必须复用 app.ts 的 `createAgentApp()` 工厂，
 * 不许旁路 createApp（templates.test.mjs 钉着）。
 */
export function mainTs(name: string): string {
  return renderTemplate('src/main.ts', { __PROJECT_NAME__: name });
}

/**
 * 一次性入口 batch.ts（templates/src/batch.ts）。**薄入口**：调工厂 → 处理 result。
 *
 * 「跑一次就退出」的 Job 形态（cron / CI / 容器一次性任务）。它此前叫 `main.ts` ——
 * 2026-10-09 把默认入口翻成服务时挪到这个名字，好让 `main.ts` 就是 `npm start` 跑的那个
 * （见 docs/plans/2026-10-09-scaffold-default-service.md）。
 *
 * 两件事的顺序与语义都不能变 —— 尤其 `result.error` 那段：run 失败**不抛**，
 * 不检查就是「打印空行 + 退出 0」，让首次运行（比如忘了配 ANTHROPIC_API_KEY）看起来像成功。
 *
 * ⚠️ `loadEnvFile()` **不在**这里，在 app.ts —— dev 环只 import app.ts、从不执行入口，
 * 把读 .env 留在这边会让 `npm run dev` 与 `npm start` 对同一份 `.env` 有两个行为。
 */
export function batchTs(name: string): string {
  return renderTemplate('src/batch.ts', { __PROJECT_NAME__: name });
}

export function projectReadme(name: string): string {
  return renderTemplate('README.md', { __PROJECT_NAME__: name });
}

export function projectGitignore(): string {
  return renderTemplate('gitignore');
}

/** 脚手架生成的 .env：填上就能跑，已进 .gitignore */
export function projectDotEnv(): string {
  return renderTemplate('env');
}

/** 随脚手架提交的 .env.example：进版本库的变量清单，值一律留空 */
export function projectDotEnvExample(): string {
  return renderTemplate('env.example');
}

/** 空注册表模板（无任何能力条目；templates/src/registry.ts） */
export function emptyRegistryTemplate(): string {
  return renderTemplate('src/registry.ts');
}

/** 脚手架的 scripts/copy-assets.mjs：把 src 下的 .md 文本资产拷进 dist/（同相对路径） */
export function copyAssetsMjs(): string {
  return renderTemplate('scripts/copy-assets.mjs');
}

/**
 * 脚手架的 scripts/clean.mjs：构建前清 dist/（`npm run build` 的第一步）。
 *
 * ⚠️ 它必须**被 create 真写出去** —— 模板目录里放着它、build 脚本里引用它，但 create 忘了写，
 * 生成的项目 `npm run build` 就第一步 MODULE_NOT_FOUND（2026-09-21 真发生过，由 e2e 里那句
 * **字面跑 `npm run build`** 抓住；`templates.test.mjs` 现在也有「模板文件必须被引用」的守卫）。
 */
export function cleanMjs(): string {
  return renderTemplate('scripts/clean.mjs');
}

// ---------- g 命令能力模板 ----------

export function toolIndexTs(name: string): string {
  return renderTemplate('capabilities/tool/index.ts', capabilityVars(name));
}

export function promptIndexTs(name: string): string {
  return renderTemplate('capabilities/prompt/index.ts', capabilityVars(name));
}

export function promptAssetMd(name: string): string {
  return renderTemplate('capabilities/prompt/asset.md', { __NAME__: name });
}

export function subagentIndexTs(name: string): string {
  return renderTemplate('capabilities/subagent/index.ts', capabilityVars(name));
}

export function subagentSystemMd(name: string): string {
  return renderTemplate('capabilities/subagent/system.md', { __NAME__: name });
}

export function skillIndexTs(name: string): string {
  return renderTemplate('capabilities/skill/index.ts', capabilityVars(name));
}
