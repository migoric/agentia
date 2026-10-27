// CLI 端到端验证：目录约定 + 发现机制 + CLI 端到端。
// agentia create 脚手架 → agentia g 生成四类能力 → 注册表 codemod →
// discoverProviders/createApp({discover}) 装配 → mock 模型跑通一次 run。
// 运行：npm run e2e（先 build 框架与 CLI，再 tsx 跑本脚本）
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 注意：从 dist 而非 src 导入 —— 生成项目 import '@migor/agentia' 解析到 dist/index.js，
// 装饰器注册表（WeakMap）必须在同一模块实例里，否则 collect* 收不到 spec。
import { createApp, discoverProviders, SystemPrompt } from '../dist/index.js';
// 共用 mock 走 tests/helpers（AGENTS.md：那是**共用** mock client）—— 别在本脚本里手搓一份
import { mockClient, toolUseMsg, endTurnMsg } from '../tests/helpers.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

const execFileAsync = promisify(execFile);
/** 异步跑子进程并拿回退出码/输出。**不能用 spawnSync** —— 假 Anthropic 端点跑在本进程里，
 *  同步等待会阻塞事件循环，子进程永远等不到响应（实测直接死锁到超时）。 */
const runChild = async (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number; stdout: string; stderr: string }> => {
  try {
    const r = await execFileAsync(file, args, { ...opts, encoding: 'utf8' });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      status: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
};
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const tmp = mkdtempSync(join(tmpdir(), 'agentia-cli-'));
const npmCache = mkdtempSync(join(tmpdir(), 'agentia-npm-cache-'));
const cli = (args: string[], cwd: string): string =>
  execFileSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
/**
 * 在生成项目里跑**产物自己的 npm 脚本**（`npm run build` / `typecheck`）。
 *
 * 为什么必须走这一层而不是照抄脚本里的两步命令：本仓的硬教训是「**测产物必须用产物自己的
 * 输入**」（见 AGENTS.md 与 guards.md 附 B.1 —— discover 必崩那五层失效，第一层就是测试
 * 自己算路径而不是用模板那句）。脚本内容会变（清 dist、换编译器、加一步拷贝），照抄一份的
 * 测试会在脚本变的那一刻**静默测旧形态**。这里只给依赖解析（`node_modules` 里的软链），
 * 命令本身字面来自生成物 `package.json`。
 */
const npmRun = (script: string, cwd: string, env: NodeJS.ProcessEnv = process.env): void => {
  execFileSync('npm', ['run', script], {
    cwd,
    stdio: 'inherit',
    // 不碰宿主 npm 缓存（与步骤 8 的 pack/install 同一套临时 cache）
    env: { ...env, npm_config_cache: npmCache, npm_config_update_notifier: 'false' },
  });
};

/** 给生成工程接依赖解析；实际执行的仍是工程自己的 scripts 与 tsconfig。 */
const linkProjectDeps = (proj: string): void => {
  mkdirSync(join(proj, 'node_modules', '@migor'), { recursive: true });
  symlinkSync(repoRoot, join(proj, 'node_modules', '@migor', 'agentia'), 'dir');
  symlinkSync(
    join(repoRoot, 'node_modules', '@types'),
    join(proj, 'node_modules', '@types'),
    'dir',
  );
  mkdirSync(join(proj, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    join(proj, 'node_modules', '.bin', 'tsc'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ` +
      `${JSON.stringify(join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(proj, 'node_modules', '.bin', 'tsx'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ` +
      `${JSON.stringify(join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'))} "$@"\n`,
    { mode: 0o755 },
  );
};

try {
  // —— 1) create：项目骨架 ——
  cli(['create', 'demo-app', '--dir', tmp], tmp);
  const proj = join(tmp, 'demo-app');
  for (const f of [
    'package.json',
    'tsconfig.json',
    // 装配（app.ts）与启动分离：dev 环要复用 app.ts 的工厂
    'src/app.ts',
    // 默认入口 = 服务（无条件生成）：build 之后 `npm start` 即得可上线的 HTTP 服务
    'src/main.ts',
    // 一次性入口（Job 形态）：`npm run start:batch -- "你的问题"`
    'src/batch.ts',
    'src/dev.config.ts',
    'src/session-store.ts',
    'src/registry.ts',
    'src/tools/hello/index.ts',
    'src/tools/read-file/index.ts',
    'scripts/copy-assets.mjs',
    'scripts/clean.mjs',
    'AGENTS.md',
  ]) {
    assert(existsSync(join(proj, f)), `create 缺文件: ${f}`);
  }
  // 四个分类目录都建出来（空目录靠 .gitkeep 进版本库）：目录名自解释，用户一看就知道新能力往哪放
  for (const d of ['src/tools', 'src/skills', 'src/prompts', 'src/subagents']) {
    assert(existsSync(join(proj, d, '.gitkeep')), `create 应建出 ${d}/（含 .gitkeep）`);
  }
  // .env 三件套必须同时到位 —— 生成 .env 却不把它写进 .gitignore，等于把 key 送进用户的第一个 commit
  for (const f of ['.env', '.env.example', '.gitignore']) {
    assert(existsSync(join(proj, f)), `create 缺文件: ${f}`);
  }
  const ignoreLines = readFileSync(join(proj, '.gitignore'), 'utf8').split('\n');
  assert(
    ignoreLines.includes('.env'),
    `.gitignore 必须忽略 .env（否则脚手架生成的 .env 会被提交），实际：${ignoreLines.join(' | ')}`,
  );
  // 接线：生成的 **app.ts** 真的调了 loadEnvFile —— 框架**不自动**读 .env，全靠这一行。
  // 必须锚到**独立语句行**（`^loadEnvFile();$`）：先写成「文本里含 loadEnvFile()」，
  // 结果被同文件注释里的那句说明满足了 —— 把调用删掉门禁照样绿（反向验证抓到的假绿）。
  // 这一条是语法层面的（要知道它真能被读到，见下面 4b 的行为验证）。
  //
  // ⚠️ 位置是 app.ts，不是入口（2026-09-22 修）：装配/启动拆开后 dev 环只 import app.ts、
  // **从不执行入口**，所以读 .env 必须在装配模块里。这条断言原先指着当时的那个入口 ——
  // 于是 `npm run dev` 静默读不到 .env 而 `npm start` 读得到，一路绿到真跑探针才发现。
  // 2026-10-09 起入口有**两个**（main.ts = 服务、batch.ts = 一次性），两个都要查。
  const appSrc = readFileSync(join(proj, 'src/app.ts'), 'utf8');
  assert(
    /^loadEnvFile\(\);$/m.test(appSrc),
    'src/app.ts 里应有独立的 `loadEnvFile();` 调用（否则生成的 .env 形同废纸，且 npm run dev 读不到它）',
  );
  for (const entry of ['src/main.ts', 'src/batch.ts']) {
    const entrySrc = readFileSync(join(proj, entry), 'utf8');
    assert(
      !/^loadEnvFile\(\);$/m.test(entrySrc),
      `${entry} 不该再调 loadEnvFile —— dev 环不执行入口，放这儿等于两个入口两个行为`,
    );
  }
  // tsconfig 必须只 include 'src' —— 能力目录/注册表全在 src 下，一个 include 全覆盖。
  // 曾经是 ['src', 'capabilities.ts'] 却漏掉能力目录本身 → 未登记的能力静默不参与类型检查。
  const tsconfig = JSON.parse(readFileSync(join(proj, 'tsconfig.json'), 'utf8'));
  assert(
    JSON.stringify(tsconfig.include) === JSON.stringify(['src']),
    `脚手架 tsconfig.include 应为 ['src']，实际 ${JSON.stringify(tsconfig.include)}`,
  );

  // 使用者向 AI 说明：单源 docs/usage-guide.md → 构建拷进 dist/AGENTS.md → create 写进项目。
  // 三段任一断掉，AI 辅助编码就退化成「猜 API」，所以这里按内容验。
  const guide = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  for (const needle of [
    'declare module', // Blackboard 声明合并
    'fromZod', // schema 单一事实来源
    'RunContext',
    'createApp',
    '@SubAgent',
    '已知边界', // 如实标注的边界（不写就没有）
  ]) {
    assert(guide.includes(needle), `项目 AGENTS.md 缺少关键内容: ${needle}`);
  }
  assert(guide.length > 5000, `项目 AGENTS.md 过短（${guide.length}）`);

  // —— 2) g：四类能力各一个 ——
  cli(['g', 'subagent', 'doc-reviewer'], proj);
  cli(['g', 'skill', 'note-writer'], proj);
  cli(['g', 'prompt', 'style-guide'], proj);
  cli(['g', 'tool', 'echo-back'], proj);
  assert(existsSync(join(proj, 'src/subagents/doc-reviewer/system.md')), 'subagent 应带 system.md');
  assert(existsSync(join(proj, 'src/prompts/style-guide/asset.md')), 'prompt 应带 asset.md');

  // 分类落位：type → 目录（目录名就是类型）
  assert(existsSync(join(proj, 'src/tools/echo-back/index.ts')), 'tool 应落在 src/tools/');
  assert(existsSync(join(proj, 'src/skills/note-writer/index.ts')), 'skill 应落在 src/skills/');
  assert(existsSync(join(proj, 'src/prompts/style-guide/index.ts')), 'prompt 应落在 src/prompts/');
  assert(
    existsSync(join(proj, 'src/subagents/doc-reviewer/index.ts')),
    'subagent 应落在 src/subagents/',
  );

  // —— 3) 注册表 codemod ——
  const registry = readFileSync(join(proj, 'src/registry.ts'), 'utf8');
  // 注册表 codemod：hello 与 read-file 都该在（read-file 带 deps —— discover 自动注册的
  // provider 没有 deps，所以它只能走显式注册；不登记会让 doctor 报「存在但未登记」）。
  for (const tok of [
    'hello',
    'read-file',
    'doc-reviewer',
    'note-writer',
    'style-guide',
    'echo-back',
  ]) {
    assert(registry.includes(`'${tok}'`), `src/registry.ts 缺 token: ${tok}`);
  }
  assert(
    /\{\s*provide:\s*'read-file',\s*useClass:\s*ReadFile,\s*deps:\s*\[\s*'WORKDIR'\s*\]\s*\}/.test(
      registry,
    ),
    "registry.ts 里 read-file 必须带 deps: ['WORKDIR']（否则容器无参构造它，构造期就抛）",
  );
  assert(
    /\{\s*provide:\s*'WORKDIR',\s*useValue:/.test(registry),
    'registry.ts 必须提供 WORKDIR（read-file 的依赖），否则显式装配路线跑不起来',
  );
  // import 前缀按分类目录走（相对 src/registry.ts）
  for (const rel of [
    './tools/hello/index.js',
    './subagents/doc-reviewer/index.js',
    './skills/note-writer/index.js',
    './prompts/style-guide/index.js',
    './tools/echo-back/index.js',
  ]) {
    assert(registry.includes(`from '${rel}'`), `src/registry.ts 缺 import: ${rel}`);
  }

  // 幂等/错误路径：同名再 g 报错
  let dupFailed = false;
  try {
    cli(['g', 'tool', 'echo-back'], proj);
  } catch {
    dupFailed = true;
  }
  assert(dupFailed, '重复 g 同名应失败');

  // —— 4) 让生成项目的 `import '@migor/agentia'` 可解析（symlink 回仓库根，框架已 build 到 dist）——
  // 另外两条软链只为**依赖解析**：临时项目没有 `npm install`（也不该有 —— e2e 不联网、不装包），
  // 而产物自己的 `tsc` / `tsconfig.json`（`types: ["node"]`）需要 `node_modules/.bin/tsc` 与
  // `@types/node` 可解析。给了它们，后面 4c/4d 才能**字面跑 `npm run typecheck` / `npm run build`**，
  // 而不是测试自己复刻一遍脚本里的命令。
  linkProjectDeps(proj);

  // —— 4b) .env 真的会被读到（跑一遍脚手架入口的同一句，而不是只看文件在不在）——
  // 这里最危险的是**静默失败**：文件生成得漂漂亮亮、key 却没进 process.env，用户只会看到
  // 「没配 key」的报错，然后去怀疑框架。所以按行为验，不按存在性验。
  writeFileSync(
    join(proj, '.env'),
    `${readFileSync(join(proj, '.env'), 'utf8')}AGENTIA_E2E_DOTENV=ok\n`,
  );
  writeFileSync(
    join(proj, 'env-probe.mjs'),
    "import { loadEnvFile } from '@migor/agentia';\nprocess.stdout.write(JSON.stringify(loadEnvFile()));\n",
  );
  // 先清掉环境里可能同名的键：**真实环境变量优先**是刻意语义（单测里钉着），
  // 不清就分不清「文件被读了」和「环境里本来就有」—— 本机 export 过 key 的人最容易踩
  const probeEnv = { ...process.env };
  delete probeEnv.AGENTIA_E2E_DOTENV;
  const applied = JSON.parse(
    execFileSync(process.execPath, ['env-probe.mjs'], {
      cwd: proj,
      encoding: 'utf8',
      env: probeEnv,
    }),
  ) as Record<string, string>;
  assert(
    applied.AGENTIA_E2E_DOTENV === 'ok',
    `.env 没被 loadEnvFile 读到：${JSON.stringify(applied)}`,
  );
  rmSync(join(proj, 'env-probe.mjs'), { force: true });

  // —— 4c) 脚手架模板过 tsc：跑**产物自己的 `npm run typecheck`**（`tsc --noEmit -p tsconfig.json`）——
  // 模板此前从未经 tsc 检查：模板里一个类型错误要等用户 npm install 后才暴露。
  // 不自己拼 tsc 命令、也不写 overlay tsconfig：`@types/node` 与 `.bin/tsc` 已由 4) 的软链解决
  // ⇒ 检查用的是生成物**自己那份 tsconfig.json**（strict / NodeNext / include / types 全生效）。
  npmRun('typecheck', proj);

  // —— 4d) 生产构建链真跑一遍：**字面跑产物自己的 `npm run build`** ——
  // 此前脚手架只有 dev/typecheck，没有 build/start —— 「拿去部署」第一步就断（外部 review
  // 抓出；且 asset() 按文件位置解析，.md 不拷进 dist 时生产形态必坏）。
  // 命令来自生成物 package.json（清 dist → tsc -p tsconfig.json → copy-assets），
  // 测试**不再复刻**这三步：脚本内容变了（换编译器 / 加一步 / 改 tsconfig），这里跟着变。
  npmRun('build', proj);
  for (const f of [
    // 默认入口（服务）的产物 —— 下面 4f 真起它
    'dist/main.js',
    // 一次性入口的产物 —— 下面 4e 真跑它（两种 cwd 各一次）
    'dist/batch.js',
    // 装配搬进 app.ts 之后，生产路径也依赖它 —— 少一个产物 `node dist/main.js` 立刻 MODULE_NOT_FOUND
    'dist/app.js',
    'dist/session-store.js',
    'dist/prompts/style-guide/asset.md',
    'dist/subagents/doc-reviewer/system.md',
  ]) {
    assert(existsSync(join(proj, f)), `生产构建缺产物: ${f}（npm run build 的承诺没兑现）`);
  }
  // 脚手架 package.json 的 scripts 承诺（build/start 都在，用户拿到的是完整打包链）
  const scaffoldPkg = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const s of ['dev', 'build', 'start', 'start:prod', 'start:batch', 'typecheck']) {
    assert(typeof scaffoldPkg.scripts[s] === 'string', `脚手架 package.json 缺 scripts.${s}`);
  }
  // 构建**必须先清 dist**：tsc 不删不再产出的文件，而生产入口是按本文件位置 discover
  // `dist/<分类>/` 的 —— 于是「删掉一个能力」之后旧产物仍在，模型还能调它（源码里找不到、
  // 进程里却有）。所以这条不是清理癖，是行为正确性；**断言方式是真删真建（下面 4d-bis）**，
  // 不去读 `scripts.build` 的字符串 —— 清 dist 那一步换个文件名/换个写法（都是合法重构）就会
  // 让字面量断言误报，而行为断言不问实现细节。

  // —— 4d-bis) 重复构建不得留下**已删除能力**的陈旧产物（真删真建，不是读脚本字面量）——
  //    重建走**同一条产物命令**（`npm run build`）—— 拆开复刻会让「清 dist」这一步被绕过去，
  //    那样本用例反而变成假绿（也就失去了检验「build 真的会清」的资格）。
  //    用一个临时探针能力做实验（不碰 4e 要断言的那 5 个菜单项）。
  const buildOnce = (): void => npmRun('build', proj);
  cli(['g', 'tool', 'stale-probe'], proj);
  buildOnce();
  const staleProbe = join(proj, 'dist', 'tools', 'stale-probe', 'index.js');
  assert(existsSync(staleProbe), '探针能力应被构建出来 —— 否则下面的「消失」断言是假绿');
  // 删能力：源码目录 + 注册表那一行（少删注册表会让 tsc 因 import 目标不存在而失败，那是另一回事）
  rmSync(join(proj, 'src', 'tools', 'stale-probe'), { recursive: true, force: true });
  const registryPath = join(proj, 'src', 'registry.ts');
  const registryText = readFileSync(registryPath, 'utf8');
  assert(
    registryText.includes('stale-probe'),
    '注册表里应有 stale-probe 的条目 —— 没有的话本用例没真删干净',
  );
  // `agentia g` 会写**两行**（import + entries 各一行），所以不按行数算 —— 断言的是
  // 「一行都不剩，且没把别的能力一起滤掉」这个语义。
  const kept = registryText.split('\n').filter((l) => !l.includes('stale-probe'));
  assert(
    !kept.some((l) => l.includes('stale-probe')),
    '注册表里仍有 stale-probe 的行（本用例没真删干净）',
  );
  assert(
    kept.some((l) => l.includes('hello')),
    '删 stale-probe 时把别的条目也滤掉了（滤过头，本用例的对照失效）',
  );
  writeFileSync(registryPath, kept.join('\n'));
  buildOnce();
  assert(
    !existsSync(staleProbe),
    '重复构建后仍留着已删除能力的产物 dist/tools/stale-probe/index.js —— ' +
      '生产形态会把删掉的能力继续加载进菜单（build 少了清 dist 那一步？）',
  );
  assert(existsSync(join(proj, 'dist', 'main.js')), '清 dist 不该把本次该产出的东西也弄丢');

  // —— 4e) 生产产物【真跑】一遍，两种 cwd 各跑一次 ——
  //    只断言「dist 产物存在」不够：那条断言在上述状态下全绿，却没发现 dist/main.js 一跑就崩
  //    —— 能力目录曾是 cwd 相对字符串（'src/tools' 等），生产形态下会去加载 src 里的 .ts 源码，
  //    而装饰器不是可擦除的类型语法 ⇒ "Invalid or unexpected token"；换个 cwd 跑连目录都找不到。
  //    模型侧接本地假 Anthropic 端点：零网络、零 token，且能断言「能力真进了模型菜单」。
  const seenBodies: string[] = [];
  const fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      seenBodies.push(raw);
      // ⚠️ 必须写成块体（`{ res.write(...) }`）：箭头函数标了 `: void` 又返回表达式的值，
      //    简洁体下 `res.write()` 的 boolean 就成了返回值 ⇒ tsc 报 TS2322（typecheck:tests 挂）。
      const ev = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'fake-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'PROD_OK' },
      });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const fakeAddr = fake.address();
  assert(typeof fakeAddr === 'object' && fakeAddr !== null, '假端点没拿到端口');
  const fakeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: 'sk-fake-for-e2e',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(fakeAddr as { port: number }).port}`,
  };
  delete fakeEnv.ANTHROPIC_AUTH_TOKEN; // 环境里可能有真实凭据，别让它盖过假端点
  try {
    for (const [label, cwd, entry] of [
      ['从工程根', proj, 'dist/batch.js'],
      ['从无关目录（cwd 无关性）', repoRoot, join(proj, 'dist', 'batch.js')],
    ] as const) {
      const r = await runChild(process.execPath, [entry, '生产路径冒烟'], { cwd, env: fakeEnv });
      assert(
        r.status === 0,
        `${label} 跑 dist/batch.js 应退出 0\n  stdout=${r.stdout}\n  stderr=${r.stderr}`,
      );
      assert(
        r.stdout.includes('PROD_OK'),
        `${label} 应打印模型回复（生产路径没真跑通）：stdout=${r.stdout}`,
      );
    }
    assert(seenBodies.length === 2, `假端点应收到两次模型请求，实际 ${seenBodies.length}`);
    for (const b of seenBodies) {
      assert(
        b.includes('"hello"'),
        `生产形态的能力菜单里应有脚手架生成的 hello 能力（请求体开头：${b.slice(0, 300)}）`,
      );
    }

    // —— 4e-min) minimal 的全部 scripts 真跑：单文件 + 裸工具也必须能 dev / typecheck / build / start。
    cli(['create', 'minimal-app', '--minimal', '--dir', tmp], tmp);
    const minimalProj = join(tmp, 'minimal-app');
    for (const f of [
      'package.json',
      'tsconfig.json',
      'README.md',
      'src/main.ts',
      '.env',
      '.env.example',
      '.gitignore',
      'AGENTS.md',
    ]) {
      assert(existsSync(join(minimalProj, f)), `minimal 缺文件：${f}`);
    }
    for (const f of ['src/app.ts', 'src/registry.ts', 'src/batch.ts', 'src/dev.config.ts']) {
      assert(!existsSync(join(minimalProj, f)), `minimal 不该生成完整模板文件：${f}`);
    }
    linkProjectDeps(minimalProj);
    const minimalCallsBefore = seenBodies.length;
    npmRun('typecheck', minimalProj);
    // 假端点在本进程内：dev/start 必须异步等待，同步 execFileSync 会把事件循环堵死。
    const minimalDev = await runChild('npm', ['run', 'dev'], { cwd: minimalProj, env: fakeEnv });
    assert(
      minimalDev.status === 0 && minimalDev.stdout.includes('PROD_OK'),
      `minimal dev 没跑通：stdout=${minimalDev.stdout}\nstderr=${minimalDev.stderr}`,
    );
    npmRun('build', minimalProj);
    const minimalStart = await runChild('npm', ['start'], { cwd: minimalProj, env: fakeEnv });
    assert(
      minimalStart.status === 0 && minimalStart.stdout.includes('PROD_OK'),
      `minimal start 没跑通：stdout=${minimalStart.stdout}\nstderr=${minimalStart.stderr}`,
    );
    assert(
      seenBodies.length === minimalCallsBefore + 2,
      `minimal 的 dev 与 start 都应真调一次模型：新增请求=${seenBodies.length - minimalCallsBefore}`,
    );
    for (const b of seenBodies.slice(minimalCallsBefore)) {
      assert(b.includes('"echo"'), `minimal 的裸工具应进入模型菜单：${b.slice(0, 300)}`);
    }

    // —— 4f) 默认入口（服务）【真起一遍】：`npm start` 跑的就是 `node dist/main.js` ——
    //    「build 产物 run 起来就能用」那条承诺的正身 —— 就绪标记（PORT=0 由 OS 分配，
    //    从 `[server] listening on :<port>` 解析实际端口）→ /healthz 200 → 无 token
    //    POST /run 401 → 带 token 真跑一轮 200 → SIGTERM 干净退出。就绪标记的文案与模板的
    //    main.ts 互为锚点（模板头注也钉着这条）。假端点还开着，模型侧零网络。
    const e2eToken = 'e2e-token-0123456789';
    const srv = spawn(process.execPath, ['dist/main.js'], {
      cwd: proj,
      env: {
        ...fakeEnv,
        PORT: '0',
        AGENTIA_TOKEN: e2eToken,
        AGENTIA_DB: join(tmp, 'e2e-server-db', 'tasks.db'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvStdout = '';
    let srvStderr = '';
    srv.stderr.on('data', (c: Buffer) => {
      srvStderr += c.toString('utf8');
    });
    let srvExit: number | null = null;
    try {
      const actualPort = await new Promise<number>((resolvePort, rejectPort) => {
        const timer = setTimeout(
          () => rejectPort(new Error(`server 就绪超时\nstdout=${srvStdout}\nstderr=${srvStderr}`)),
          30_000,
        );
        srv.stdout.on('data', (c: Buffer) => {
          srvStdout += c.toString('utf8');
          const m = /\[server\] listening on :(\d+)/.exec(srvStdout);
          if (m) {
            clearTimeout(timer);
            resolvePort(Number(m[1]));
          }
        });
        srv.once('exit', (code) =>
          rejectPort(
            new Error(
              `server 在就绪前退出（code=${code}）\nstdout=${srvStdout}\nstderr=${srvStderr}`,
            ),
          ),
        );
      });
      const base = `http://127.0.0.1:${actualPort}`;
      const health = await fetch(`${base}/healthz`);
      assert(health.status === 200, `/healthz 应 200，实际 ${health.status}`);
      const noAuth = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert(noAuth.status === 401, `无 token POST /run 应 401，实际 ${noAuth.status}`);
      const authed = await fetch(`${base}/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${e2eToken}`,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: '生产服务冒烟' }] }),
      });
      const authedBody = await authed.text();
      assert(
        authed.status === 200,
        `带 token POST /run 应 200，实际 ${authed.status}：${authedBody.slice(0, 300)}`,
      );
      assert(
        authedBody.includes('PROD_OK'),
        `POST /run 应真跑一轮并回模型文本：${authedBody.slice(0, 300)}`,
      );
    } finally {
      // 不管断言过没过都收口子进程；退出的断言在 finally 外做（不掩盖原始失败）
      srv.kill('SIGTERM');
      srvExit = await new Promise<number | null>((r) => {
        const timer = setTimeout(() => r(null), 15_000);
        srv.once('exit', (code) => {
          clearTimeout(timer);
          r(code);
        });
      });
    }
    assert(
      srvExit === 0,
      `SIGTERM 后 server 应干净退出（code=0），实际 ${srvExit}\nstderr=${srvStderr}`,
    );
    assert(
      srvStdout.includes('[server] 已排空退出'),
      `优雅停机应打「已排空退出」（没在飞任务时应排空）：stdout=${srvStdout}`,
    );
  } finally {
    fake.close();
  }

  // —— 5) 发现机制：discoverProviders（四分类目录数组，顺序即装配顺序）——
  const capabilityDirs = ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'].map((d) =>
    join(proj, d),
  );
  const discovered = await discoverProviders(capabilityDirs);
  const tokens = discovered.map((p) => p.provide).sort();
  assert(
    JSON.stringify(tokens) ===
      JSON.stringify([
        'doc-reviewer',
        'echo-back',
        'hello',
        'note-writer',
        'read-file',
        'style-guide',
      ]),
    `发现 token=${tokens}`,
  );

  // —— 6) createApp({ discover }) + mock 模型：装配六能力并真跑一个工具 ——
  // 复用 tests/helpers.ts 的共用 mock：手搓那份的类型不完整，是给 scripts/ 接上类型检查时才暴露的
  // （共用版在 helpers 里以 `as never` 收口，且被全部单测覆盖）。onParams 用来抓第二次往返的入参。
  let secondParams: unknown = null;
  const { client } = mockClient([
    toolUseMsg('echo_back', { text: 'smoke' }),
    {
      onParams: (p) => {
        secondParams = p;
      },
      message: endTurnMsg('done'),
    },
  ]);

  // read-file 的构造器要一个工作目录，而 discover 自动注册的 provider **没有 deps**
  // ⇒ 走显式 providers 覆盖它（与模板 src/app.ts 里那两行同形）。不覆盖的话构造期就抛。
  const { default: ReadFile } = await import(`${proj}/src/tools/read-file/index.ts`);
  const app = await createApp({
    name: 'cli-app',
    discover: capabilityDirs,
    providers: [
      { provide: 'WORKDIR', useValue: proj },
      { provide: 'read-file', useClass: ReadFile, deps: ['WORKDIR'] },
    ],
    system: new SystemPrompt().add('role', '测试装配', true),
  });
  const menu = app.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(menu) ===
      JSON.stringify([
        'doc_reviewer',
        'echo_back',
        'hello',
        // read-file 类带两个工具：list_files（看有什么）+ read_file（读文件）
        'list_files',
        'note_writer',
        'read_file',
        'style_guide',
      ]),
    `菜单=${menu}`,
  );

  const { run, result } = await app.run([{ role: 'user', content: '回显一下' }], { client });
  assert(run.status === 'succeeded', `run.status=${run.status}`);
  assert(result.stopReason === 'end_turn', `stopReason=${result.stopReason}`);
  const s = JSON.stringify(secondParams);
  assert(
    s.includes('tool_result') && s.includes('echo: smoke'),
    '发现的工具应真的被执行并回 tool_result',
  );

  // —— 7) 注册表路线：import 生成的 src/registry.ts 显式装配 ——
  const registryMod = await import(`${proj}/src/registry.ts`);
  const app2 = createApp({
    name: 'cli-registry',
    providers: registryMod.providers,
    system: new SystemPrompt().add('role', '测试装配', true),
  });
  assert(app2.tools.length === 7, `注册表路线菜单=${app2.tools.map((t) => t.name)}`);

  // —— 8) 发布物完整性：CHANGELOG.md 必须在两个 npm 包里（npm 的「总是包含」只覆盖
  // README/LICENSE，CHANGELOG 不在其列 —— 曾因 files 只写 dist 漏发，外部 review 抓出）——
  // npm cache 走临时目录：runner / 沙箱的 ~/.npm 属主异常（EPERM）会把环境问题误判成
  // 代码问题（外部 review 真踩到），门禁不该依赖宿主 npm 缓存的健康。
  for (const [label, dir] of [
    ['@migor/agentia', repoRoot],
    ['@migor/cli', join(repoRoot, 'packages', 'cli')],
  ] as const) {
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', npmCache], {
        cwd: dir,
        encoding: 'utf8',
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const paths = packed[0]!.files.map((f) => f.path);
    assert(
      paths.includes('CHANGELOG.md'),
      `${label} 的 npm 包里没有 CHANGELOG.md（files: ${JSON.stringify(paths.slice(0, 5))}…）`,
    );
  }

  // —— 9) npm tarball「装出来跑」：真 pack 两包 → 临时项目离线 file: 安装 → 用装出来的产物真跑 ——
  // 步骤 8 只验 pack 的**内容清单**（dry-run），「装出来的包能不能跑」是另一件事：dist 漏文件、
  // bin 指向不存在的路径、exports 写错，都只在「真装一次再真跑」时现形（与 4e 的「产物存在 ≠
  // 产物能跑」同一条教训，这里守的是发布形态）。两包都是零运行时依赖 ⇒ `--offline` file: 安装
  // 不触 registry（实测 ~1s）。mock client 内联手写 —— tests/helpers 不在发布物里，
  // 能 import 的只能是包装出来的东西。
  const packDir = mkdtempSync(join(tmpdir(), 'agentia-pack-'));
  const probe = mkdtempSync(join(tmpdir(), 'agentia-install-probe-'));
  try {
    const tarballs: string[] = [];
    for (const dir of [repoRoot, join(repoRoot, 'packages', 'cli')]) {
      const out = JSON.parse(
        execFileSync(
          'npm',
          ['pack', '--json', '--pack-destination', packDir, '--cache', npmCache],
          {
            cwd: dir,
            encoding: 'utf8',
          },
        ),
      ) as Array<{ filename: string }>;
      tarballs.push(join(packDir, out[0]!.filename));
    }
    writeFileSync(
      join(probe, 'package.json'),
      JSON.stringify({ name: 'install-probe', private: true, type: 'module' }),
    );
    execFileSync(
      'npm',
      ['install', '--offline', '--no-audit', '--no-fund', '--cache', npmCache, ...tarballs],
      { cwd: probe, stdio: 'inherit' },
    );
    // 框架包：从装出来的 node_modules 里跑一次最小 run（模型侧是内联 mock，零网络）
    writeFileSync(
      join(probe, 'run-probe.mjs'),
      `import { runAgent } from '@migor/agentia';\n` +
        `const client = { messages: { stream: () => ({ on() {}, finalMessage: async () => ({\n` +
        `  id: 'm', model: 'm', stop_reason: 'end_turn',\n` +
        `  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },\n` +
        `  content: [{ type: 'text', text: 'TARBALL_OK' }],\n` +
        `}) }) } };\n` +
        `const r = await runAgent({ client, messages: [{ role: 'user', content: 'hi' }] });\n` +
        `if (r.finalText !== 'TARBALL_OK') throw new Error('意外收尾: ' + r.finalText);\n` +
        `console.log('TARBALL_OK');\n`,
    );
    const probeOut = execFileSync(process.execPath, ['run-probe.mjs'], {
      cwd: probe,
      encoding: 'utf8',
    });
    assert(probeOut.includes('TARBALL_OK'), `装出来的框架包跑不通：${probeOut}`);
    // CLI 包：装出来的 bin 入口真跑 --version（读的是**包内**的 package.json —
    // 装漏了 package.json 或 dist/cli.js 都会在这里炸）
    const cliBin = join(probe, 'node_modules', '@migor', 'cli', 'dist', 'cli.js');
    const cliVersion = execFileSync(process.execPath, [cliBin, '--version'], {
      cwd: probe,
      encoding: 'utf8',
    }).trim();
    const expectedCliVersion = (
      JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    assert(
      cliVersion === expectedCliVersion,
      `装出来的 CLI --version=${cliVersion}，应为 ${expectedCliVersion}`,
    );
    // 光报版本不够：**模板是随包发的**（`dist/templates/`），而「模板没进 tarball /
    // 新加的文件漏了」这类问题 `--version` 一个都抓不到 —— 它们只在用户 `agentia create`
    // 的那一刻才炸。所以这里用**装出来的** CLI 真建一个工程，逐个点验关键文件。
    execFileSync(process.execPath, [cliBin, 'create', 'packed-app'], {
      cwd: probe,
      encoding: 'utf8',
    });
    for (const rel of [
      'src/app.ts', // 装配工厂（dev 环的入口）
      'src/main.ts', // 默认入口：HTTP 服务（npm start）
      'src/batch.ts', // 一次性入口（npm run start:batch）
      'src/dev.config.ts', // 开发期数据声明
      'src/session-store.ts', // 多轮的会话后端
      'src/tools/hello/index.ts',
      'src/tools/read-file/index.ts',
      'src/registry.ts',
      'AGENTS.md',
    ]) {
      assert(
        existsSync(join(probe, 'packed-app', rel)),
        `装出来的 CLI 建出的工程缺 ${rel} —— 模板没进 tarball 或漏了文件`,
      );
    }
    execFileSync(process.execPath, [cliBin, 'create', 'packed-minimal', '--minimal'], {
      cwd: probe,
      encoding: 'utf8',
    });
    assert(
      existsSync(join(probe, 'packed-minimal', 'src/main.ts')),
      '发布物里的 minimal 模板必须能生成 src/main.ts',
    );
    assert(
      !existsSync(join(probe, 'packed-minimal', 'src/registry.ts')),
      'minimal 不应生成 registry —— 发布物混入了完整模板文件',
    );
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(probe, { recursive: true, force: true });
  }

  console.log('E2E-CLI PASS');
  console.log(
    JSON.stringify(
      {
        scaffolded: proj.replace(tmp, '<tmp>'),
        discoveredTokens: tokens,
        menu,
        runStatus: run.status,
        toolResultReachedModel: s.includes('echo: smoke'),
        registryRouteTools: app2.tools.length,
        projectAgentsMdBytes: guide.length,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(npmCache, { recursive: true, force: true });
}
