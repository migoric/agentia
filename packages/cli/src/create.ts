/** create 命令：生成 Agentia 项目脚手架 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appTs,
  batchTs,
  CAPABILITY_DIR_LIST,
  cleanMjs,
  copyAssetsMjs,
  devConfigTs,
  emptyRegistryTemplate,
  mainTs,
  projectDotEnv,
  projectDotEnvExample,
  projectGitignore,
  projectPackageJson,
  projectReadme,
  projectTsconfig,
  readFileToolIndexTs,
  REGISTRY_PATH,
  sessionStoreTs,
  toolIndexTs,
} from './templates.js';
import { registerCapability } from './registry.js';
import { GUIDE_VERSION_MARKER, readCliVersion } from './version.js';
import { createMinimalProject } from './create-minimal.js';

function write(dir: string, rel: string, content: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

/**
 * 使用者向 AI 说明（项目里的 AGENTS.md）的单源 = 仓库根 `docs/usage-guide.md`。
 * - 发布物：构建时由 `scripts/copy-assets.mjs` 拷成 `dist/AGENTS.md`（here = dist）；
 * - 源码直跑（tsx）：here = src，回退三级到仓库根。
 * 找不到就**明确失败**（不生成缺说明的项目）—— 说明是 AI 写对代码的前提。
 */
function readUsageGuide(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'AGENTS.md'), // 发布物：dist/AGENTS.md
    join(here, '..', '..', '..', 'docs', 'usage-guide.md'), // 源码直跑：packages/cli/src → 仓库根
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(
    `找不到 AI 使用说明（docs/usage-guide.md）。查找过：\n  ${candidates.join('\n  ')}`,
  );
}

export type CreateProjectOptions = { minimal?: boolean };
export function createProject(
  name: string,
  parent: string | undefined,
  options: CreateProjectOptions = {},
): number {
  const dir = resolve(parent ?? process.cwd(), name);

  let guide: string;
  try {
    guide = readUsageGuide();
  } catch (e) {
    console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return 1;
  }

  // 路径存在但不是目录时 readdirSync 会抛原始 ENOTDIR（栈里全是 node:fs 内部帧），
  // 下面那句友好文案根本轮不到 —— 先判类型（`agentia create my-app` 而 my-app 是
  // 个文件是常见手误）。
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    console.error(`错误：${dir} 已存在且不是目录`);
    process.exitCode = 1;
    return 1;
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    console.error(`错误：目录 ${dir} 已存在且非空`);
    process.exitCode = 1;
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  if (options.minimal === true) return createMinimalProject(dir, name, guide);

  write(dir, 'package.json', projectPackageJson(name));
  write(dir, 'tsconfig.json', projectTsconfig());
  // 装配（app.ts）与启动分离：dev 环要复用 app.ts 的工厂，
  // 才能把「能力选择 / 工作目录」喂进 createApp（见 templates.ts 的 appTs 注释）。
  write(dir, 'src/app.ts', appTs(name));
  // 默认入口 = **服务**（与 app.ts 的工厂同一个）：build 之后 `npm start` 即得可上线的
  // HTTP 服务（/healthz、异步任务、崩溃续跑、优雅停机、可选鉴权）
  write(dir, 'src/main.ts', mainTs(name));
  // 一次性入口（cron / CI / 容器里的 Job 形态）：`npm run start:batch -- "问题"`
  write(dir, 'src/batch.ts', batchTs(name));
  // dev 环的**数据**声明（只有数据，没有逻辑；生产路径不读它）
  write(dir, 'src/dev.config.ts', devConfigTs());
  // 对话型能力用的文件后端会话存储（可选件，但生成出来省得用户自己写）
  write(dir, 'src/session-store.ts', sessionStoreTs());
  write(dir, 'src/tools/hello/index.ts', toolIndexTs('hello'));
  // 第二个能力：它把面板上的「工作目录」控件接通（根由 DI 注入），
  // 同时让「能力多选」在新建工程里立刻有东西可选。
  write(dir, 'src/tools/read-file/index.ts', readFileToolIndexTs());
  write(dir, 'scripts/copy-assets.mjs', copyAssetsMjs());
  // 清 dist 那一步（build 的第一步）：**必须真写出去**，否则生成的项目 `npm run build`
  // 直接 MODULE_NOT_FOUND（模板目录里有它、build 脚本引用它，只有 create 忘了写）。
  write(dir, 'scripts/clean.mjs', cleanMjs());
  write(dir, REGISTRY_PATH, emptyRegistryTemplate());
  write(dir, 'README.md', projectReadme(name));
  write(dir, '.gitignore', projectGitignore());
  // 四个分类目录都建出来：目录名自解释，用户一看就知道新能力往哪放
  // （.gitkeep 让空目录能进版本库；discover 只认目录，会忽略它）
  for (const relDir of CAPABILITY_DIR_LIST) {
    write(dir, `${relDir}/.gitkeep`, '');
  }
  // .env 是「填上就能跑」的入口（app.ts 的 loadEnvFile() 读它 —— 放 app.ts 而不是 main.ts，
  // 因为 dev 环只 import app.ts，见 templates/src/app.ts 的注释）；
  // .env.example 进版本库当变量清单。**两者必须与 gitignore 的 .env 同时存在** ——
  // 生成 .env 却不忽略它，等于把 key 直接送进用户的第一个 commit。
  write(dir, '.env', projectDotEnv());
  write(dir, '.env.example', projectDotEnvExample());
  // AI 使用说明：让 Claude Code / Cursor / Copilot 等一进项目就拿到权威 API 速查。
  // ⚠️ 头部带一行**版本标记**（2026-10-16 ref-scaffold-observability-gap）：这份说明是
  // `docs/usage-guide.md` 的**快照**，而 CLI **没有任何命令会更新它** —— 升级框架后它会
  // 静默过期，偏偏 AI 就是照它写代码的。有了标记，`agentia doctor` 才能把
  // 「说明是 vX 写的、当前 CLI 是 vY」说出口（此前只能靠人记得对拍）。
  write(dir, 'AGENTS.md', `${GUIDE_VERSION_MARKER(readCliVersion())}\n${guide}`);

  registerCapability(dir, 'hello', 'tool');
  // read-file 的构造器要一个工作目录（DI 注入）。它的依赖声明**写在能力类上**
  //（`static readonly deps = ['WORKDIR']`，discover 会带上），所以默认路由（discover）
  // 下 `app.ts` 不必为它再注册一遍 —— 这里登记是给**显式装配路线**（registry.ts）
  // 用的：那份 providers 里要带上 deps，顺带也让 `agentia doctor` 不报「存在但未登记」
  //（新生成的工程不该自带一条警告）。
  registerCapability(dir, 'read-file', 'tool', ['WORKDIR']);

  console.log(`已创建项目 ${dir}

后续步骤：
  cd ${dir}
  npm install
  把 API key 填进 .env（已生成，且已被 .gitignore 忽略）
  npm run dev                  # = agentia dev：本地 inspector 面板（可输入 prompt / 选能力 / 选工作目录）

生产构建：npm run build && npm start（先清 dist/，再 tsc → dist/，.md 资产由 scripts/copy-assets.mjs 跟随拷贝）
          dev 跑 src/、start 跑 dist/ —— 能力目录按文件位置解析，两边都成立。
          npm start 起的是**服务**（node dist/main.js：/healthz · POST /run · POST /tasks ·
          崩溃续跑 · 优雅停机 · AGENTIA_TOKEN 可选鉴权；需 Node ≥ 22.5）。
          跑一次就退出的批处理：npm run start:batch -- "你的问题"（node dist/batch.js）

目录约定：src/tools/ · src/skills/ · src/prompts/ · src/subagents/（一能力一文件夹）

CLI 已装进本工程（devDependencies），所以在工程内直接 npx agentia g / doctor / dev 即可
（走本地 bin，离线可用、版本与工程一同 pin）。注意创建时要用带 scope 的 npx @migor/cli create
—— 短名 agentia 在 npm 上是别人的包。

提示：项目内 AGENTS.md 是本框架的使用说明（API 速查 + 已知边界），
      交给 AI 辅助编码时会自动被读，能显著减少猜 API 的错。`);
  return 0;
}
