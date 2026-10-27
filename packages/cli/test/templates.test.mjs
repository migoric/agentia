import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错）。 */
const DIST = fileURLToPath(new URL('../dist/templates.js', import.meta.url));
let T = null;
let M = null;
if (existsSync(DIST)) {
  T = await import(new URL('../dist/templates.js', import.meta.url).href);
  M = await import(new URL('../dist/create-minimal.js', import.meta.url).href);
}
const SKIP = !T || !M ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

/**
 * 只看**代码**，不看注释。
 *
 * 断言「模板里没有 X」时必须过这一道：模板的注释恰恰要**解释**那条规矩（比如
 * main.ts 里写着「别把 createApp(...) 搬回这里」），逐字匹配会把解释当成违例 ——
 * 于是为了过测试，只能把注释写得含糊。那是让测试把文档质量压下去，方向反了。
 */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

describe('templates 目录约定（四分类目录，无伞形词）', { skip: SKIP }, () => {
  it('四个分类目录都在 src/ 下，且与四个能力类型一一对应', () => {
    assert.deepEqual(T.CAPABILITY_DIR_LIST, [
      'src/tools',
      'src/skills',
      'src/prompts',
      'src/subagents',
    ]);
    assert.deepEqual(Object.keys(T.CAPABILITY_DIRS).sort(), [...T.CAPABILITY_TYPES].sort());
  });

  it('脚手架 tsconfig 的 include 覆盖全部能力目录', () => {
    // 原实现是 include: ['src', 'capabilities.ts']，漏了能力目录本身 ——
    // 未登记进注册表的能力（discover 路线允许不登记）静默不参与类型检查。
    const ts = JSON.parse(T.projectTsconfig());
    assert.deepEqual(ts.include, ['src']);
    for (const dir of T.CAPABILITY_DIR_LIST) {
      assert.ok(dir.startsWith('src/'), `${dir} 必须在 include 的 src 下`);
    }
  });

  it('注册表落在 src/ 下（不再是项目根的伞形词文件）', () => {
    assert.equal(T.REGISTRY_PATH, 'src/registry.ts');
  });

  it('app.ts 模板的 discover 按【本文件位置】解析，且列全四分类目录（顺序即装配顺序）', () => {
    // 原实现是 cwd 相对的 'src/tools' 等：dev（tsx src/main.ts）恰好对，但 `node dist/main.js`
    // 会去加载 src 下的 .ts 源码 —— 装饰器不是可擦除的类型语法，Node 直接抛
    // "Invalid or unexpected token"，即**生产路径从未通过**；换个 cwd 跑则连目录都找不到。
    // 装配从 main.ts 搬进 app.ts 之后（dev 环要复用工厂），这条守卫跟着搬。
    const app = T.appTs('demo');
    for (const dir of T.CAPABILITY_DIR_LIST) {
      const bare = dir.replace(/^src\//, '');
      assert.ok(app.includes(`'${bare}'`), `app.ts 缺分类目录 ${bare}`);
    }
    assert.ok(app.indexOf("'tools'") < app.indexOf("'skills'"), '分类顺序即装配顺序，不能被重排');
    assert.ok(app.includes('import.meta.url'), 'app.ts 必须按本文件位置解析（而非 cwd）');
    assert.ok(!app.includes("'src/tools'"), "app.ts 不该出现 cwd 相对的 'src/tools'");
    assert.ok(
      app.includes('existsSync'),
      'app.ts 必须过滤不存在的分类目录：tsc 不为空目录产出 dist/<分类>/，而 discover 对显式给出的不存在路径是报错的',
    );
  });

  it('app.ts 模板：导出 dev 环要的三件套（工厂 / CAPABILITY_DIRS / 会话后端）', () => {
    // 这三件是「CLI 驱动用户代码」的接口面（D9(d)）。少一件 = dev 环缺一条能力，
    // 而缺的那条**不会**在单测里现形（它们问的是模板返回了什么，不是 dev 环读到了什么）。
    const app = T.appTs('demo');
    assert.ok(
      /export\s+async\s+function\s+createAgentApp\s*\(/.test(app),
      'app.ts 必须导出 createAgentApp 工厂（dev 环靠它喂四个控件）',
    );
    assert.ok(
      /export\s+const\s+CAPABILITY_DIRS\s*=/.test(app),
      'app.ts 必须导出 CAPABILITY_DIRS —— 它同时是面板能力选择器的菜单来源（两侧同一个常量）',
    );
    assert.ok(
      /export\s+function\s+createSessionStore\s*\(/.test(app),
      'app.ts 必须导出 createSessionStore —— 多轮开关打开时 dev 环要用它',
    );
    assert.ok(
      /toolSources/.test(app) && /workdir/.test(app),
      'createAgentApp 必须接受 toolSources 与 workdir 两个选项（能力选择 / 工作目录）',
    );
    assert.ok(
      /deps:\s*\[\s*'WORKDIR'\s*\]/.test(app),
      "app.ts 必须给 read-file 声明 deps: ['WORKDIR']（discover 自动注册的 provider 没有 deps）",
    );
  });

  it('batch.ts 模板是薄入口（一次性 Job）：装配搬去 app.ts，这里只留「调工厂 → 处理 result」', () => {
    const batch = T.batchTs('demo');
    const body = code(batch); // 注释里会出现「别把 createApp(...) 搬回这里」，那不是违例
    assert.ok(
      !body.includes('createApp('),
      'batch.ts 不该再直接调 createApp —— 装配搬进 app.ts，否则 dev 环拿不到那个工厂',
    );
    assert.ok(
      /from\s+'\.\/app\.js'/.test(body),
      "batch.ts 必须从 './app.js' 取工厂（注意 .js 后缀：NodeNext 的产物路径）",
    );
    assert.ok(body.includes('createAgentApp()'), 'batch.ts 必须真的调用那个工厂');
    // 反面：也不该自己调 run 之外的装配动作（比如再建一个 createApp 的旁路）
    assert.ok(!/createApp\s*\(/.test(body), 'batch.ts 里不该有 createApp 调用');
    // 它是**一次性**形态：HTTP 宿主不许塞进来（那会把「跑一次就退出」变成起服务）
    assert.ok(
      !/createHttpHandler|\.listen\(/.test(body),
      'batch.ts 是一次性 Job 形态，不该起服务 —— HTTP 宿主在 main.ts',
    );
  });

  it('main.ts 模板是**默认入口**（可上线的 HTTP 服务）：复用 app.ts 的工厂，不许旁路 createApp', () => {
    // 与 batch.ts 同一道闸（见上一条）：默认入口若自己 createApp 一份装配，
    // 「能力选择 / 工作目录 / .env 读取」就会在 dev 与生产长出两个行为。
    const main = T.mainTs('demo');
    const body = code(main); // 头注里解释「别旁路」时会提到 createApp，那不是违例
    assert.ok(
      /from\s+'\.\/app\.js'/.test(body),
      "main.ts 必须从 './app.js' 取工厂（注意 .js 后缀：NodeNext 的产物路径）",
    );
    assert.ok(body.includes('createAgentApp()'), 'main.ts 必须真的调用 createAgentApp() 工厂');
    assert.ok(!/createApp\s*\(/.test(body), 'main.ts 里不该有 createApp 调用（装配在 app.ts）');
    // 服务面的四根柱子：异步任务 + HTTP 宿主 + 优雅停机 + 崩溃续跑，少一根就不是
    // 「可以直接上线」的承诺（缺的那根不会在单测里现形，只会在用户部署后现形）。
    for (const needle of ['AsyncRunner', 'createHttpHandler', 'SqliteTaskStore', 'resumePending']) {
      assert.ok(body.includes(needle), `main.ts 缺 ${needle}`);
    }
    assert.ok(/\.drain\(\{/.test(body), 'main.ts 必须接 drain 优雅停机');
    assert.ok(body.includes("'SIGTERM'"), 'main.ts 必须订阅 SIGTERM（框架不订阅，是宿主的职责）');
    // **默认入口**这层身份：它必须真的 listen —— 否则「build 完 run 起来就是个服务」是空话
    assert.ok(/\.listen\(/.test(body), 'main.ts 必须真的起服务（.listen）');
  });

  it('main.ts 模板：AGENTIA_TOKEN 缺省时必须响亮警告，设了才挂 authenticate', () => {
    // 鉴权取舍（与 examples/deploy 同档）：不强制（框架「鉴权只是缝」），但不静默 ——
    // 无鉴权起服务却不吭声，等于替用户做了一个他没做的决定。
    const main = T.mainTs('demo');
    const body = code(main);
    assert.ok(
      /AGENTIA_TOKEN/.test(body) && /authorization/i.test(body),
      'main.ts 必须读 AGENTIA_TOKEN 并做 Bearer 校验（authorization 头）',
    );
    assert.ok(
      main.includes('未设 AGENTIA_TOKEN') && main.includes('无任何鉴权'),
      'AGENTIA_TOKEN 缺省时必须打印响亮警告（不静默、不强制）',
    );
    // 条件展开：没设 token 时**不传**钩子（显式 undefined 与「不提供」在
    // exactOptionalPropertyTypes 下是两回事 —— 框架侧开着这个开关）
    assert.ok(
      /\.\.\.\(authenticate \? \{ authenticate \} : \{\}\)/.test(body),
      'authenticate 必须条件展开（缺省 = 不挂钩子，不是传 undefined）',
    );
  });

  it('main.ts 模板：就绪标记按 server.address() 的实际端口打（PORT=0 可解析）', () => {
    // e2e 用 PORT=0 起服务并从这行解析实际端口 —— 打 PORT 变量本身会让 PORT=0 的
    // 测试永远无法连上（操作系统分的端口没人知道）。文案与 e2e-cli.ts 的正则互为锚点。
    const main = T.mainTs('demo');
    assert.ok(main.includes('server.address()'), '就绪行必须取 server.address() 的实际端口');
    assert.ok(
      main.includes('[server] listening on :'),
      '就绪标记 `[server] listening on :<port>` 是 e2e 的解析锚点，改文案要同步改 scripts/e2e-cli.ts',
    );
  });

  it('main.ts 模板：AGENTIA_DB 缺省落工程根（不是 cwd 相对），PORT 空串当缺省', () => {
    // 两条都是评审实报的**静默**（2026-10-09）：
    //   ① `?? 'agentia.db'` 是 cwd 相对 —— 服务形态常换工作目录启动（systemd / 容器 `-w`），
    //      同一个工程会用上**两个库**，而 resumePending() 静默找不到上个进程的任务；
    //   ② `Number(process.env.PORT ?? 3000)` 在 `PORT=`（空串）时得 `0` ⇒ 静默**随机端口**。
    const main = code(T.mainTs('demo'));
    assert.ok(
      /PROJECT_ROOT/.test(main) && !/\?\?\s*'agentia\.db'/.test(main),
      "AGENTIA_DB 的缺省必须按本文件位置落工程根（PROJECT_ROOT），不能是 cwd 相对的 'agentia.db'",
    );
    assert.ok(
      /rawPort\s*===\s*undefined\s*\|\|\s*rawPort\.trim\(\)\s*===\s*''/.test(main),
      "PORT 的空串必须显式当缺省 —— `Number('')` 是 0，会让服务静默落到随机端口",
    );
    assert.ok(
      /Number\.isInteger\(PORT\)/.test(main),
      'PORT 非整数 / 越界必须响亮报错（不是让 server.listen 去抛栈里全是 node:net 的原始错）',
    );
    assert.ok(
      !/\|\|\s*3000/.test(main),
      '别用 `|| 3000` 兜底：那会把 PORT=0（OS 分配端口，冒烟测试依赖它）一起吃掉',
    );
  });

  it('dev.config.ts 模板只放数据（且 multiTurn 缺省为空 = 全部单轮）', () => {
    // 判据（D8 ②）：逻辑副本会漂移，数据不会 ⇒ dev.ts（逻辑）不要，dev.config.ts（数据）可以。
    const cfg = T.devConfigTs();
    assert.ok(
      /export\s+default\s*\{/.test(cfg),
      'dev.config.ts 应是 export default {...} 的数据声明',
    );
    assert.ok(
      /multiTurn:\s*\[\s*\]/.test(cfg),
      'multiTurn 缺省必须是空数组（任务型是安全默认：不会把上一个仓库的上下文串进来）',
    );
    assert.ok(
      !/\bimport\b/.test(code(cfg)),
      'dev.config.ts 不该 import 任何东西 —— 它是数据，一旦有逻辑就会漂移',
    );
  });

  it('read-file 工具：构造期校验注入值 + 越界响亮报错（不静默截断）', () => {
    // 它是「工作目录」这条线的落点：面板上那个文件夹控件，只有某个能力真的消费了注入的根，
    // 才有可观测的效果。两条纪律都不能少：
    //   ① 没注入就**响亮报错**（否则容器无参构造出 root=undefined，工具静默按 cwd 解析）；
    //   ② 越界**抛错**（否则 agent 能跑到工作目录外面读写）。
    const tool = T.readFileToolIndexTs();
    assert.ok(
      /constructor\s*\(/.test(tool) && tool.includes('throw new Error'),
      'read-file 必须在构造期校验注入的工作目录（缺失时抛错，不静默回退 cwd）',
    );
    assert.ok(
      tool.includes('safeResolve') && /startsWith\(base \+ sep\)/.test(tool),
      'read-file 必须把模型给的路径约束在工作目录内（越界响亮报错）',
    );
    /* 归一化（补的，2026-09-22 复核）：工作目录由调用方给 —— 面板输入框、`dev.config.ts`、
     * 从 Finder 粘过来的路径都可能带尾斜杠，而越界判定是**字符串前缀**比较
     * （`base + sep`）。不归一化时前缀会拼成 `/a/b//`，判定恒为假 ⇒ **每一次**
     * read_file 都报「路径越出工作目录」：不是误报，是工具整个变坏（还会误导模型）。 */
    assert.ok(
      /const base = resolve\(root\)/.test(tool) && /this\.root = resolve\(root\)/.test(tool),
      'read-file 必须归一化工作目录（尾斜杠 ⇒ 越界判定恒假 ⇒ 工具全挂）',
    );
    assert.ok(/export\s+default\s+class/.test(tool), 'discover 只认 default export 的类');
  });

  it('read-file 工具：list_files 进菜单（模型「知道自己在哪个目录」的通道）', () => {
    /* 真用户反馈（2026-09-22）：面板上换了文件夹，agent 行为看起来没变。链路是通的
     * （workdir 确实注入到工具），缺口在**模型感知** —— prompt 不变、菜单里没有
     * 「列目录」的工具 ⇒ 模型不知道自己在哪、里面有什么，只能瞎猜文件名。
     * 修法落在模板（零框架改动）：同一个类里加一个 list_files。三条契约都要钉住： */
    const tool = T.readFileToolIndexTs();
    assert.ok(
      tool.includes('async list_files('),
      'read-file 必须带 list_files 工具（先看有什么 → 再读，与 read_file 同一个类、同一个 provider）',
    );
    // ① 输出**第一行**是工作目录的绝对路径 —— 那是模型「知道自己在哪」的通道，
    //    且 description 里必须把这一点写给模型看（模型是按 description 选工具的）。
    assert.ok(
      tool.includes('工作目录：$' + '{this.root}'),
      'list_files 的输出第一行必须写工作目录的绝对路径（工作目录：/abs/path）',
    );
    assert.ok(
      /description:[\s\S]*?绝对路径/.test(tool),
      'list_files 的 description 必须写明「输出带工作目录绝对路径」—— 模型按 description 选工具',
    );
    // ② 输出有上限且**截断明示**（本仓纪律：不许静默少给）。
    assert.ok(
      /LIST_LIMIT/.test(tool) && /截断/.test(tool),
      'list_files 必须有输出上限且截断时明示（不静默少给）',
    );
    // ③ 越界判定复用 safeResolve —— 读目录也是读，同一道闸。
    assert.ok(
      /async list_files[\s\S]*?safeResolve\(/.test(tool),
      'list_files 必须用 safeResolve 判越界（读目录也是读）',
    );
    // snake_case 由下面「模板里的能力名统一 snake_case」那条钉住（list_files 本身合规）。
  });

  it('subagent 的 system.md 自带「你的回复就是报告」约定（函数形态不追加 REPORT_HINT）', () => {
    /* 为什么这条要钉在这儿：模板把 `system` 写成**函数形态**（改 `.md` 立刻生效；
     * 值形态在**类定义时**就把文件读死了 —— 而 `.md` 不在 tsx 的 import 图里，
     * 连「改了要重启」都不会提示你）。但框架只对**值形态**追加 `REPORT_HINT`：
     * `src/toolkit/subagent.ts` 的 `resolveSubSystem` 里 `typeof spec === 'function'`
     * 直接 `return spec(task)`，值形态 / SystemPrompt 才追加那句约定
     * （单测 `tests/toolkit/subagent.test.ts` 也只覆盖值形态）。
     * ⇒ 这句约定**只能由模板自己写**：少了它，子代理不知道最终回复就是交付物，
     * 会退化成「一句话交差」，而所有测试照样全绿（没有任何东西在看这段文本）。
     */
    const md = T.subagentSystemMd('demo');
    assert.match(md, /最终回复/, 'system.md 必须写明「最终回复会原样交回主 agent」');
    assert.match(
      md,
      /REPORT_HINT/,
      '必须点明「框架只在值形态追加 REPORT_HINT」——否则下一个人会以为框架会补这句',
    );
  });

  it('模板里的能力名统一 snake_case（模型看到的就是那个方法名）', () => {
    /* 判据不是框架的硬规则 —— 框架只校验 `^[A-Za-z0-9_-]{1,64}$`，并在 spec 里**建议**
     * snake_case。这里守的是**本仓自己模板的一致性**，理由是使用者的实际成本：
     * 被装饰的方法名就是模型看到的工具名，而同一个名字还要被 `dev.config.ts` 的
     * `multiTurn: [...]` 与面板的能力选择器逐字引用 ⇒ 生成物里两种写法混着来，
     * 使用者得先猜「到底写 doc_reviewer 还是 docReviewer」，猜错就是静默不生效。
     *
     * 这条是**补的**：`read-file` 模板最初写成 `readFile`，单测全绿（它只断言
     * `safeResolve` / `constructor` 那些形状），是 e2e-cli 那份整菜单断言把它抓出来的。 */
    const root = fileURLToPath(new URL('../templates', import.meta.url));
    const tsFiles = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? tsFiles(join(dir, e.name))
          : e.name.endsWith('.ts')
            ? [join(dir, e.name)]
            : [],
      );

    const bad = [];
    let seen = 0;
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, 'utf8');
      const dec = /@(Tool|Skill|SubAgent|Prompt)\s*\(/g;
      let m = dec.exec(src);
      while (m !== null) {
        // 按**括号配平**跳过装饰器实参再读方法名：schema 里全是括号，非贪婪正则会提前收尾。
        // 扫的时候跳过字符串字面量 —— 描述文案里出现一个孤立的 `(` 就再也配不平了。
        let i = dec.lastIndex - 1;
        let depth = 0;
        for (; i < src.length; i += 1) {
          const c = src[i];
          if (c === '"' || c === "'" || c === '`') {
            i += 1;
            while (i < src.length && src[i] !== c) {
              if (src[i] === '\\') i += 1;
              i += 1;
            }
            continue;
          }
          if (c === '(') depth += 1;
          else if (c === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const name = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(
          // 跳过装饰器与方法之间的**注释与空行** —— subagent / read-file 都在那里写了说明，
          // 而 `^\s*` 匹配不到 `//`（最初就是这么漏掉 2 个的）
          src.slice(i + 1).replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, ''),
        )?.[1];
        if (name !== undefined) {
          seen += 1;
          // `__METHOD_NAME__` 是能力模板的占位符，由 `kebabToSnake()` 渲染（下面单独测它）；
          // 其余是手写字面名，必须自己就是 snake_case。
          if (name !== '__METHOD_NAME__' && !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name)) {
            bad.push(`${file.slice(root.length + 1)}: @${m[1]} ${name}`);
          }
        }
        m = dec.exec(src);
      }
    }
    // 抽词器退化（比如模板换了写法）必须**响亮**失败，否则这条守卫会变成永远绿的空断言
    assert.ok(seen >= 5, `只解析到 ${seen} 个被装饰的方法名 —— 抽词器可能退化了`);
    assert.deepEqual(bad, [], `这些能力名不是 snake_case（模型看到的名字）：\n${bad.join('\n')}`);

    // 占位符那一半：`__METHOD_NAME__` 渲染成什么，决定了**生成物**里的能力名。
    // 它此前没有直测（只被 e2e-cli 的整菜单断言间接盖到 doc-reviewer 一个名字）。
    for (const [kebab, snake] of [
      ['doc-reviewer', 'doc_reviewer'],
      ['note-writer', 'note_writer'],
      ['hello', 'hello'],
      ['read-file', 'read_file'],
      ['style-guide', 'style_guide'],
    ]) {
      const got = T.kebabToSnake(kebab);
      assert.equal(got, snake, `kebabToSnake('${kebab}')`);
      assert.match(got, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `渲染出的能力名必须 snake_case：${got}`);
    }
  });

  it('.gitignore 挡住 dev 环的本地状态（.agentia/）', () => {
    // 会话文件是**本机调试产物**（对话历史），进版本库等于把对话内容提交上去。
    const ignore = T.projectGitignore();
    assert.ok(
      ignore.split('\n').includes('.agentia/'),
      `.gitignore 模板必须忽略 .agentia/（对话历史等本地状态），实际：${JSON.stringify(ignore)}`,
    );
  });

  it('脚手架 package.json：dev 走 CLI 的 dev，且 CLI 装进 devDependencies（版本与框架同批）', () => {
    const pkg = JSON.parse(T.projectPackageJson('demo'));
    assert.equal(
      pkg.scripts.dev,
      'agentia dev',
      'npm run dev 应与 agentia dev 同一条路（含 inspector）',
    );
    assert.ok(
      pkg.devDependencies['@migor/cli'],
      'CLI 必须进 devDependencies：否则工程内 npx agentia 会去 registry 拉最新版（无 pin、需联网）',
    );
    assert.ok(pkg.dependencies['@migor/agentia'], '框架仍应是 dependencies');
    assert.equal(
      pkg.devDependencies['@migor/cli'],
      pkg.dependencies['@migor/agentia'],
      '两包同批发布，pin 的版本必须一致',
    );
  });

  it('batch.ts 模板在 run 失败时给出原因并置非零退出码', () => {
    // run 失败**不抛**（硬失败记进 result.error），模板若不显式检查就会「打印空行 + 退出 0」，
    // 让首次运行（如没配 ANTHROPIC_API_KEY）看起来像成功 —— 实测过这个静默失败。
    const batch = T.batchTs('demo');
    assert.ok(batch.includes('result.error'), 'batch.ts 应检查 result.error');
    assert.ok(batch.includes('result.stopReason'), 'batch.ts 应打印 stopReason');
    assert.ok(batch.includes('process.exitCode = 1'), 'batch.ts 失败时应置非零退出码');
  });

  it('.env 三件套：生成 .env / .env.example，且 .gitignore 必须挡住 .env', () => {
    // 这三行是一组契约，少一行就是事故：生成 .env 却不 ignore = 把 key 送进用户的第一个 commit；
    // ignore 了 .env 却没有 loadEnvFile() = 文件形同废纸（用户只会看到「没配 key」）。
    const ignore = T.projectGitignore();
    assert.ok(
      ignore.split('\n').includes('.env'),
      `.gitignore 模板必须含独立的 .env 行，实际：${JSON.stringify(ignore)}`,
    );
    assert.ok(ignore.split('\n').includes('.env.local'), '.gitignore 模板应含 .env.local');

    const env = T.projectDotEnv();
    assert.ok(env.includes('ANTHROPIC_API_KEY='), '.env 模板应给出 key 的空位');
    assert.ok(
      !env.includes('sk-ant-'),
      '.env 模板不得预填假 key（会让首次运行变成 401 而不是「没配」）',
    );

    const example = T.projectDotEnvExample();
    assert.ok(example.includes('ANTHROPIC_API_KEY='), '.env.example 应列 key');
    assert.ok(example.includes('.env'), '.env.example 应说明「复制成 .env」的用法');

    // 接线：**app.ts**（不是 main.ts）里必须有一句独立调用（框架不自动读 .env）。
    // 事故（2026-09-22）：装配/启动拆开时，loadEnvFile() 留在了 main.ts —— 而 dev 环
    // （agentia dev）只 import app.ts、**从不执行 main.ts** ⇒ `npm run dev` 静默读不到 .env，
    // `npm start` 读得到。当时这条断言指着 main.ts，所以它一路绿到真跑探针才发现。
    // 下面成对写：**该在哪** + **不该在哪** —— 只写一半就还是能被搬到错的一侧。
    const app = T.appTs('demo');
    assert.ok(/^loadEnvFile\(\);$/m.test(app), 'app.ts 模板应有独立的 loadEnvFile(); 调用');
    assert.ok(
      /import \{[^}]*\bloadEnvFile\b[^}]*\} from/.test(app),
      'app.ts 模板应从框架导入 loadEnvFile（否则生成的项目编译不过）',
    );
    // ⚠️ 反断言只锚**精确形态**（独立调用 / import 语句），不能拿裸标识符判 ——
    // main.ts 的报错文案里就有 `loadEnvFile()` 这个词（给用户看的提示），裸判会误红。
    const mainCode = code(T.mainTs('demo'));
    assert.ok(
      !/^loadEnvFile\(\);$/m.test(mainCode) &&
        !/import \{[^}]*\bloadEnvFile\b[^}]*\} from/.test(mainCode),
      'main.ts 模板不得再调 loadEnvFile —— dev 环不执行 main.ts，放这儿等于 npm run dev 读不到 .env',
    );
  });
});

/**
 * 模板目录 ↔ CLI 源码的**双向**一致性。
 *
 * 事故（2026-09-21）：模板目录加了 `scripts/clean.mjs`、`package.json` 的 build 脚本也引用了它，
 * 但 `create.ts` 忘了把它写出去 —— 生成的项目 `npm run build` 第一步就 MODULE_NOT_FOUND。
 * 所有单元测试全绿：它们问的都是「某个模板函数返回了什么」，**没人从模板目录出发反问「谁用了它」**。
 * 是 e2e 里那句**字面跑 `npm run build`** 照出来的（测试自己复刻命令时也照不出来 —— 复刻的那份
 * 绕过了产物自己那条链）。
 *
 * 这个描述块不依赖 dist（只读仓库里的模板与源码），所以未构建时也照跑。
 */
describe('模板目录 ↔ CLI 源码：双向引用必须成立', () => {
  const cliRoot = fileURLToPath(new URL('..', import.meta.url));
  const templatesDir = join(cliRoot, 'templates');
  const srcDir = join(cliRoot, 'src');

  /** 列 templates/ 下所有文件的相对路径（POSIX 分隔符，与 renderTemplate 的写法一致） */
  const templateFiles = (dir = templatesDir, base = '') =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? templateFiles(join(dir, e.name), `${base}${e.name}/`)
        : [`${base}${e.name}`],
    );

  /** CLI 源码全文（src/ 下的 .ts）—— 引用检查用「名字确实出现过」就够 */
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  const read = (f) => readFileSync(join(srcDir, f), 'utf8');
  const srcText = srcFiles.map(read).join('\n');
  /** 除模板访问层之外的全部源码：**只有它们才算「有人真写了这个文件」** */
  const callersText = srcFiles
    .filter((f) => f !== 'templates.ts')
    .map(read)
    .join('\n')
    // 掐掉 import 语句：`import { cleanMjs } from './templates.js'` 也算「名字出现过」，
    // 靠它过闸就等于放行「导入了但从不调用」—— 那正是事故形态（写进 import、没写进 create）。
    .replace(/^import[\s\S]*?from\s+'[^']+';/gm, '');
  const templatesText = read('templates.ts');

  it('模板目录里每个文件都被源码字面引用（防拼错/防改名漏改）', () => {
    const orphans = templateFiles().filter((rel) => !srcText.includes(`'${rel}'`));
    assert.deepEqual(
      orphans,
      [],
      `这些模板文件没有任何源码引用它们：\n${orphans.join('\n')}\n` +
        '—— 生成的项目会缺这个文件，而单测大概率还是绿的（见本描述块头注释）',
    );
  });

  it('模板访问层的每个 accessor 都必须有调用方（漏写 = 生成物缺文件）', () => {
    // 这一步才是 2026-09-21 那个事故的真正守卫：`cleanMjs()` 存在、路径也存在，只是**没人调它**
    // —— 生成的项目缺 `scripts/clean.mjs`，而 build 脚本第一步就要跑它（MODULE_NOT_FOUND）。
    // 判据是「**除访问层之外**有人引用这个 accessor」，不是「这个名字在仓库里出现过」。
    // 只查 accessor（体内调了 renderTemplate 的函数）—— 纯 helper（如 kebabToSnake）只在层内用，合法。
    const code = templatesText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const accessors = code
      .split(/\nexport\s+/)
      .slice(1)
      .map((block) => ({
        name: /^(?:function|const)\s+([A-Za-z_$][\w$]*)/.exec(block)?.[1],
        block,
      }))
      .filter((a) => a.name && /renderTemplate\(/.test(a.block))
      .map((a) => a.name);
    assert.ok(
      accessors.length >= 10,
      `只解析到 ${accessors.length} 个 accessor —— 抽词器可能退化了`,
    );
    const unused = accessors.filter((n) => !new RegExp(`\\b${n}\\b`).test(callersText));
    assert.deepEqual(
      unused,
      [],
      `templates.ts 的 accessor 没有任何调用方（模板写了却没被写出去）：\n${unused.join('\n')}\n` +
        '—— 生成的项目会缺对应文件（真发生过：clean.mjs）',
    );
  });

  it('源码里每个 renderTemplate 路径都真实存在（防拼错）', () => {
    const refs = [...srcText.matchAll(/renderTemplate\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(refs.length >= 10, `只解析到 ${refs.length} 个模板引用 —— 抽词器可能退化了`);
    const missing = refs.filter((rel) => !existsSync(join(templatesDir, rel)));
    assert.deepEqual(missing, [], `源码引用了不存在的模板：\n${missing.join('\n')}`);
  });
});

describe('minimal 模板（单文件 + 裸工具）', { skip: SKIP }, () => {
  it('入口不含 decorator / DI / HTTP 宿主，保留 .env 与失败退出码', () => {
    const main = T.minimalMainTs('demo');
    assert.ok(main.includes('createApp({'));
    assert.ok(main.includes('tools: [echo]'));
    assert.ok(/^loadEnvFile\(\);$/m.test(main));
    assert.ok(main.includes('result.error') && main.includes('process.exitCode = 1'));
    assert.ok(main.includes('result.trace'));
    for (const absent of ['@Tool', 'createHttpHandler', 'AsyncRunner', 'registry']) {
      assert.ok(!main.includes(absent), `minimal 入口不该引入 ${absent}`);
    }
  });

  it('minimal scripts 收敛但依赖与版本 pin 仍和完整模板同源', () => {
    const minimal = JSON.parse(M.minimalPackageJson('demo'));
    const full = JSON.parse(T.projectPackageJson('demo'));
    assert.deepEqual(minimal.scripts, {
      dev: 'tsx src/main.ts',
      build: 'tsc -p tsconfig.json',
      start: 'node dist/main.js',
      typecheck: 'tsc --noEmit -p tsconfig.json',
    });
    assert.deepEqual(minimal.dependencies, full.dependencies);
    assert.deepEqual(minimal.devDependencies, full.devDependencies);
  });
});
