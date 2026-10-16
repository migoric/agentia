# Agentia 使用说明（给 AI 与人）

> 本文件是 **AI 辅助编码的权威入口**，也是人类速查表。
> 仓库根部的 `AGENTS.md` 讲的是「怎么改这个仓库」；**本文件讲的是「怎么用这个框架」**。

包名：`@migor/agentia`（框架）/ `@migor/cli`（命令行）。Node ≥ 18，ESM，TypeScript 7。

**目录**
- [0. 心智模型（先读这一段）](#0-心智模型先读这一段)
- [1. 最小可运行示例](#1-最小可运行示例)
- [2. 项目结构（CLI 约定）](#2-项目结构cli-约定)
- [3. 装饰器 spec 字段速查](#3-装饰器-spec-字段速查)
- [4. createApp 与 app.run 选项](#4-createapp-与-apprun-选项)
- [5. 类型链路（这块决定「编辑器给不给提示」）](#5-类型链路这块决定编辑器给不给提示)
- [6. 运行时 API](#6-运行时-api)
- [7. 已知边界（如实标注，不要指望框架替你兜）](#7-已知边界如实标注不要指望框架替你兜)
- [8. 常见错误](#8-常见错误)

---

## 0. 心智模型（先读这一段）

一次 **run** = 一个 agent 循环跑完一件事，产出一条 **trace**（`traceId === runId`）。

你声明 **四类能力**，它们进同一个「工具菜单」；**主 agent 的模型按 `description` 自己选**：

| 能力 | 装饰器 | 谁决定流程 | 典型用途 |
|---|---|---|---|
| 工具 | `@Tool` | 你的代码（一次调用 = 一个函数） | 确定性操作：查库、算数、调 API |
| 技能 | `@Skill` | 你的代码（脚本式，可显式调模型） | 「先取数 → 再让模型写 → 再加工」这种固定流程 |
| 子 agent | `@SubAgent` | **模型自己**（独立循环 + 裁剪上下文） | 需要自主多步、且中间过程不该污染主上下文 |
| 提示资产 | `@Prompt` | 模型拉取（本质是「按需注入的文本」） | 长文规范/模板，平时不进上下文，需要时拉 |

**关键推论**：能力是**运行时**从装饰器注册表收集的，所以 TypeScript 里**没有**「你的能力清单」这种类型 ——
不要写 `app.hello()`。模型通过 `description` 选能力，你通过 `schema` 约束入参。

**同样是一等公民的是可观测**：这条 trace 带每步的 token / 成本 / 耗时 / 错误类型，run 收尾经 `TraceSink`
出口交给你（落库 / 采样 / 脱敏都在缝外，见 §6「观测」）。一句话——**四类能力决定它能做什么，trace 决定你敢不敢上线**。

---

## 1. 最小可运行示例

```ts
import { Tool, createApp, SystemPrompt } from '@migor/agentia';

const OBJ = { type: 'object', properties: {} } as const;

class Greeter {
  @Tool({
    description: '向某人打招呼',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  })
  say_hello(input: { name: string }): string {
    return `你好，${input.name}`;
  }
}

const app = createApp({
  name: 'greeter',
  providers: [{ provide: 'greeter', useClass: Greeter }],
  system: new SystemPrompt().add('role', '你是友好的助手。', true),
});

const { result } = await app.run([{ role: 'user', content: '跟小明打个招呼' }]);
console.log(result.finalText, result.stopReason, result.trace.totalUsage);
```

要点：
- `@Tool` 方法的**入参必须显式标注类型**（TS 无法从 JSON Schema 反向推断方法形参；`strict` 下不标注会报隐式 any）。
- `schema` 是给**模型**看的契约；方法形参类型是给**你和编译器**看的。想避免两处双写，见第 5 节 `fromZod<T>`。
- 相对 import 必须带 `.js` 后缀（NodeNext）。

---

## 2. 项目结构（CLI 约定）

```bash
npx @migor/cli create my-app     # 首次创建：必须带 scope（短名 agentia 在 npm 上是别人的包）
cd my-app && npm install         # 框架与 CLI 都装进工程
$EDITOR .env                     # 填 ANTHROPIC_API_KEY（脚手架已生成，且已被 .gitignore 挡住）
npm run dev                      # = agentia dev：本地 inspector 面板（输入 prompt / 选能力 / 选工作目录）
npx agentia g tool fetch-weather   # 生成到 src/tools/fetch-weather/（skill/prompt/subagent 同理）
npx agentia doctor               # 静态体检（未登记/悬空/命名/重复）
npx agentia --version            # CLI 版本（= -v）
```

> **命令从哪来**：脚手架把 `@migor/cli` 装进工程的 `devDependencies`，所以**工程内**用短名
> `npx agentia …` 即可（走本地 bin：离线可用、版本与工程一同 pin）。**首次创建**必须用带 scope 的
> `npx @migor/cli create` —— npm 上另有一个别人的 `agentia` 包，短名会装错东西。
> 想全局装上（到处都能敲 `agentia`）：`npm i -g @migor/cli`。

四分类目录，一能力一文件夹：`src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/` —— **目录名就是类型**，不用记别名。每个文件夹的 `index.ts` 是入口，`default export` 支持三种形态：**类**（token = 文件夹名）、**Provider 对象**、**Provider 数组**。类形态要注入依赖时，在类上写 `static readonly deps = ['WORKDIR']` —— `discover` 会把它带上（**不必**把该能力挪到显式 `providers` 再注册一遍，那样同一 token 会有两份、靠「后注册覆盖先注册」碰巧成立）；`deps` 写成非字符串数组会**响亮报错**，不当成「没有依赖」。显式注册表在 `src/registry.ts`（`agentia g` 自动维护，也可手改）。

### 2.1 脚手架生成的文件（**装配与启动是分开的**）

| 文件 | 作用 |
|---|---|
| `src/app.ts` | **装配**：导出 `createAgentApp({ toolSources?, workdir? })` 工厂 + `CAPABILITY_DIRS` + `createSessionStore()`，并在模块顶部 `loadEnvFile()` 读 `.env` |
| `src/main.ts` | **默认入口 = HTTP 服务**：`createAgentApp()` → `createHttpHandler` + `AsyncRunner` + `SqliteTaskStore`（崩溃续跑）→ SIGTERM/SIGINT 触发 `drain` 优雅停机。`npm run build && npm start` 即是带 `/healthz`、异步任务、可选 `AGENTIA_TOKEN` Bearer 鉴权的服务 |
| `src/batch.ts` | **一次性入口（Job 形态）**：薄入口 —— `createAgentApp()` → `app.run(...)`，再处理 `result.error`；`npm run start:batch -- "你的问题"` 跑一次就退出（cron / CI / 容器） |
| `src/dev.config.ts` | **数据**（不是逻辑）：开发期的声明，如 `multiTurn: ['trip-planner']`；见 §2.2 |
| `src/session-store.ts` | `FileSessionStore`：把多轮对话落成 `.agentia/session.json`（原子写）；见 §6.4「对话历史」 |
| `src/registry.ts` | 显式注册表（`agentia g` 自动维护） |
| `src/tools/read-file/` | 示例工具（两个）：`list_files` 列**工作目录**的内容（输出首行带工作目录绝对路径），`read_file` 读其中一个文本文件（工作目录由 DI 注入，见 §2.2） |

**为什么拆**：`agentia dev` 的调试环要**复用同一个工厂**，才能把「这次调哪个能力 / 工作目录是哪个」
喂进 `createApp`。所以装配必须在 `app.ts` 里、以**函数**形态存在 —— 别把 `createApp(...)` 搬回
任一个入口（`main.ts` / `batch.ts`；搬回去 dev 环就起不来了）。

> **脚手架 `src/app.ts` 怎么找这些目录**：按**本文件位置**解析（`fileURLToPath(new URL('tools/', import.meta.url))`），
> 所以 dev 解析到 `src/`、`npm run build` 之后解析到 `dist/` —— 从任何目录启动都成立，也不受 cwd 影响。
> 别改成 cwd 相对写法（形如 `src/tools` 的字符串）：那样 `node dist/main.js` 会去加载 `src/` 下的 `.ts`
> 源码，而装饰器不是可擦除的类型语法，Node 直接跑不了。空分类目录（还没有该类型的能力 ⇒ 构建后没有
> 对应 `dist/<分类>/`）要过滤掉，否则 `discover` 会因「显式给出的路径不存在」而报错。

> **进程外资源的所有权**（`app.ts` 里最容易写错的一处）：MCP 连接器、数据库句柄、定时器这类
> **进程外资源一律在模块作用域创建、再以 `useValue` 注入**，不许在 provider 的构造函数里建。
> 理由见 §2.2 的重启策略：框架没有 `AgentApp.close()`，构造函数里建的东西会随每次重建攒下孤儿进程。

### 2.2 开发期调试环（`agentia dev`）

`npm run dev` 起一个**本地 inspector 面板**，四组输入都在面板上（不用改代码重跑）。
另有两个操作按钮（都不是「装饰」—— 缺了各自的后果见下面两段）：**■ 中止**（只在有 run 在飞时出现）
与**清空对话**（只在对话视图出现时显示）：

| 输入 | 口径 |
|---|---|
| **prompt** | 输入框 + `↑`/`↓` 调回历史（像 shell）。面板上「点一下 = 一次**真** run」 |
| **能力** | 多选，缺省全选。收窄的是**菜单**（主 agent 仍在环里），不是「只可能调它」—— 别的能力 `tools` 里的显式引用仍能调到被排除的那个 |
| **工作目录** | 目录选择器（`浏览…`）+ 「系统选择…」原生对话框。**它是这个环的主控件**：任务型 agent 的 prompt 几乎不变，变的是目录。三个点击语义：点**目录名**进去 / 点 `..` 上一层 / **点文件名** = 把它**所在的**目录当工作目录（prompt 为空时顺手把文件名填进去，你写好的话一个字不动）；`.git` 这类**隐藏目录**单列在选择器末尾（可达但靠后）。`浏览…` **总是**按输入框里的路径打开 —— 敲了路径再点它就是打开那个路径（不是「再点一次关掉」）；点面板外面收起。`系统选择…` 拉 **OS 原生文件夹对话框**（由 CLI 本机进程弹出，因为浏览器拿不到所选目录的绝对路径），选完直接填进输入框。⚠️ 「换了目录」要让**模型**感知到，靠脚手架 `read-file` 能力里的 `list_files`：它输出首行就是工作目录绝对路径 —— 没有这类工具时模型不知道自己在哪、只能瞎猜文件名（行为看起来「没变」） |
| **多轮** | 跟能力走：`src/dev.config.ts` 里 `multiTurn: [...]` 声明哪些能力该多轮，混选时取 **OR** 且面板**标出来源**（`多轮·trip-planner`） |

`npm run dev -- "你的问题"` 可以直接把第一句 prompt 带上（等价于启动后在输入框里敲）。

**右栏是实时的（在飞就看得到）**：run 一开跑，右栏就从空树开始，**span 一个个长出来**
（`◌` = 还没结束，`●` = 已结束），收尾时用**整棵 trace** 覆盖一遍。实现走框架的增量记账出口
（`onTraceEvent`，0.8.3）：runner 订阅 → 逐笔 `POST /ingest-event` → 父进程广播 → 面板按 `seq` 折回。
两条边界（与框架同名出口一致，都写在文档里以免被当成缺陷）：

- **不保证送达**：SSE 断了就断了，没有重放。所以「在飞的那棵树」是**临时的** —— 刷新页面之后
  早先那些 span 不会回来（收尾的整棵 trace 会补齐它们），**收尾那份永远覆盖在飞的这份**。
- 它只影响「此刻看到什么」，**不影响 run 本身**，也不影响落盘的 trace（那是另一条缝）。

**模型正文按 Markdown 渲染**（最终回复 + 对话视图的助手轮）：标题 / 粗斜体 / 行内码 / 围栏码 /
列表 / 引用 / 分隔线 / 链接。解析器是本仓自己写的（零依赖），**只产出 token 树、不碰 HTML** ——
模型输出里的 `<script>` 只会显示成字面文本；链接只认 `http` / `https` / `mailto`，其余协议
（`javascript:` 等）**整条降级成字面文本**（连 `[]()` 一起显示）。你自己那一轮保持字面 ——
那是你打的字，面板不改写它。

**长正文默认折叠**：超过 12 行或 1200 字符的正文卡在 216px + 底部渐隐，下方左对齐一个
「展开全文（共 N 行）▾」，展开后变「收起 ▴」。**短正文不挂控件**。

**滚动分三层，各管一段**：整页**不滚**（输入条永远贴在底部，不会被内容推走）；左栏列表自己滚；
右栏**只有调用树是滚动区** —— 它随 span 数无界增长，而回复 / 能力排行 / 用量固定在下方、
各有上限（回复很长时在**它自己那块**里滚，不会把树挤出屏幕）。窄屏（≤860px）回落成单列 + 整页滚动。

**为什么用 `agentia dev` 而不是 `tsx watch`**：`agentia dev` 自己 import 你的 `src/app.ts` 并驱动它，
于是**它才是调用方**，四个输入才可能生效。它也**自己管文件监视**（不再叠一层 `tsx watch`）：

- **看什么**：`.ts` / `.mts` / `.cts` / `.tsx` / `.js` / `.mjs` / `.cjs` / `.json` / **`.md`** / `.env` / `.env.local`。
  `.md` **必须在**里面 —— 文本资产（`@Prompt` 拉的 `.md`、子 agent 的 `system.md`）不在 tsx 的
  import 图里，交给 `tsx watch` 会**静默无感**：改了没反应、也不提示。
- **看哪里**：代码与文本资产看 `<项目根>/src/` **整棵树**（含启动后新建的子目录）；
  `.env` / `.env.local` 在**项目根**，所以那两份**单独**盯。**只有**这两份 —— 项目根的
  `README.md` / `package.json` 不触发重启（把根抬到项目根会让「改文档也重启」）。
- **不看什么**：`node_modules` / `dist` / `.git` / `.agentia` / `coverage`（`.agentia` 是 dev 环自己的
  对话历史，看它就变成「每次 run 重启一次」的自噬循环）。
- **什么时候重启**：改代码或**改能力选择** ⇒ 重启子进程；改**工作目录** / prompt / 多轮 ⇒ 不重启。
  在飞 run 期间需要重启时**延后到它结束**，不杀在飞的 run。
- **面板怎么知道它起来了**：runner 装配完成会广播 `runner-ready`，面板收到就重刷 `/api/dev`。
  少了这条事件，面板加载时那次查询（早于装配完成）拿到的 `capabilities` 是父进程的初值空数组，
  能力选择器会**空着且没有任何解释**，要等你先跑一次才填上。

**子进程是 `node <tsx/cli>`，不是 `npx tsx`**：`npx` 是包装器，它**不给孙进程转发 fd 3 的 IPC 通道**，
于是 runner 里 `process.send` 变成 `undefined` —— 而代码写的是 `process.send?.()`（可选链），
所以所有协议消息被**静默**丢弃：面板永远等不到 `ready`、`POST /run` 永远回不来；没有 IPC 通道后
事件循环排空，进程还会以 `code=0` 干净退出（看起来像「用户代码自己跑完了」）。这条有 e2e 钉着
（`scripts/e2e-dev.ts`）。

**`.env` 由 `src/app.ts` 读**：runner 只 import `app.ts`、**从不执行入口**（`main.ts` /
`batch.ts`），所以读 `.env` 的那一行必须在装配模块里 —— 放进入口会让 `npm run dev` 静默读不到、
而 `npm start` 读得到。

**安全**：面板只绑 `127.0.0.1`，并做两层校验 —— `Origin` 校验（缺失放行，`Origin: null` 拒绝）
+ **每次启动生成的一次性 token**（首帧 `?t=` 换成 `HttpOnly` cookie，后续请求带着走）。
token 的作用是挡住**本机其它进程**，别把它当网络边界：这个面板**不要**暴露到 `0.0.0.0`。

**成本**：面板缺省给每次 run 套一层预算护栏（`maxCostUsd: 1` / `maxTotalTokens: 200_000`，
可用 `dev.config.ts` 的 `budget` 覆盖）。手快点两下就是两次真 run —— 护栏就是为这个存在的。

**会话历史**：开了多轮的能力才有对话视图，对话落在 `.agentia/session.json`（已被 `.gitignore` 挡住）。
失败的轮次**不在会话文件里**（框架只在成功轮次回写），面板靠 trace 的 `session.id` 把它们 join 回来。
对话视图旁边有一个**「清空对话」**按钮：清空 = **换一个 `sessionId`**（`dev` → `dev-2` → …），
**不删** `session.json` —— 旧对话还在盘上、run 列表里也还指得到，只是模型不再带着它跑。
当前用哪个 id 记在 `.agentia/dev-session-id`（**不是** `session.json` 的一部分）：只放内存的话，
重启 `npm run dev` 之后刚清空的对话会**自己回来**。有 run 在飞时不能清空（会 409）。

**每次 run 的 trace 都落盘**：收尾时追加一行到 `.agentia/traces.jsonl`（已被 `.gitignore` 挡住）。
那个格式**恰好就是** `agentia report` / `diff` / `harvest` / `export` 四个命令的输入 ——
所以面板里跑过的每一次 run，都可以直接：

```bash
agentia report .agentia/traces.jsonl      # 哪个能力慢 / 贵 / 爱失败
agentia diff  .agentia/traces.jsonl  ...  # 改 prompt 前后逐 span 比对（有差异时退出码 1）
agentia harvest .agentia/traces.jsonl --failed   # 失败的 run → eval 用例骨架
agentia export  .agentia/traces.jsonl    # → 训练数据集 JSONL
```

落盘**不替代**右栏的实时树：那是两条缝（落盘管「事后能查」，`onTraceEvent` 管「此刻看到」）。
三条如实标注：① 文件**只增不减**（要清是你自己 `rm`）；② 落盘是**同步写**，单条 trace 以百 KB
计、且 `traceLimits.maxEvents` 本来兜上限；③ 面板的 run 列表是**内存** ring（50 条），
重启就空了 —— 落盘让数据**没丢**，但面板不会替你回看历史。

**并排 A/B（比两条 run差在哪）**：run 列表里 **⌘/Ctrl + 单击**选两条（再点一次取消、
选第三条挤掉最早那条），右栏切**双栏**并排两棵调用树，顶部一条差异摘要
（run 级 summary + 逐 span 字段级差异，与 `agentia diff` 逐字同源）。

⚠️ **可比性分三档，显式不静默**：能力选择与工作目录是 **app 级**的（换它们要重启进程）⇒
两条跨了能力选择的 run，配置整个变了，diff 出来的差异**多半与你改的那句话无关**。
所以跨能力 / 跨目录 / 元信息缺失都给出**显式降级提示**（含可执行的出路：建议只改 prompt 后重跑），
而不是静默给一份没意义的 diff。可比时**不显示**提示条（每次都飘噪声等于没有提示）。

⚠️ **并排是「事后回看」，不是「同时跑」**：单飞闸没解除 —— 解除会连带改变「文件变更延后重启」
的语义（两条判据今天刻意共用同一条忙闲判据），且 A/B 的收益全在「事后并排看差在哪」，
同时跑还多烧一倍 token。普通单击任意一条即退出并排。

**重跑后自动补对**：已经选了一条（还没选第二条）时，新 run 一收尾就**自动**并排 ——
面板会播一条 notice 说清「为什么屏幕变双栏了」。三种情况**不**自动：空选择（没表达
对比意图，自动切双栏是替用户决定）、已选两条（再塞一条会挤掉你刚选的）、同一条。
所以「改一句 prompt → 重跑 → 看差在哪」是**两步**，不是三步。

**中止在飞的 run**：run 跑着的时候输入条上会多一个**「■ 中止」**按钮（没在飞时不显示）。
点了之后：
- run 在**回合边界**以 `stopReason='aborted'` **正常收尾**，**trace 照常落盘**（面板也会说「已中止」，
  不是「失败」—— 中止的 `ok` 是 `false`，判别看 `stopReason`）；
- 在飞时的第二次 `POST /run` 会被**拒绝**（409，提示先等它结束或先中止）；
- ⚠️ 中断是**协作式**的：工具若不读 `signal`（例如某些 MCP 在途调用）就没人理。所以 5 秒后
  **兜底重启 runner**，此时这次 run 的 trace 会丢 —— 面板会**明说**这一点（不静默）。

> **陷阱**：装饰器注册表是模块级 `WeakMap`。框架必须是**单一模块实例** —— 混用 `src` 与 `dist`、或在一个仓库里装两份 agentia，会让能力收集为空。让 CLI 生成的 `package.json` 里只依赖一份框架即可。

---

## 3. 装饰器 spec 字段速查

四个装饰器都只接**实例方法**：私有方法（`#method`）与静态方法（`static`）都在装饰期直接抛错
—— 能力收集沿实例原型链扫描（调用要绑定 `this`），私有名不可见、静态方法挂在构造函数上，
不拦的话能力会静默从菜单里消失。唯一例外是 `@Prompt`（纯文本资产），静态方法同样收集（见下）。

### `@Tool(spec: ToolSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 模型据此判断何时调用（**必填**，写好它比什么都重要） |
| `schema` | 入参 JSON Schema；传 `fromZod<T>(...)` 可获得签名校验 |
| `name` | 模型可见的工具名，缺省取方法名（建议 snake_case） |
| `strict` | 透传给 Anthropic 的 strict 模式（**框架不校验 schema 合规性**） |
| `approval` | `'required'` = 每次调用先挂起等人工审批（HITL，见 §6.6「人工审批」） |

### `@Skill(spec: SkillSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 同 `@Tool` |
| `schema` | 主 agent 传给技能的入参 schema |
| `name` | 缺省取方法名 |
| `model` | `ctx.llm()` 的缺省模型 |
| `maxTokens` | 同上 |
| `maxIterations` | 同上 |
| `tools` | `ctx.llm()` 可调工具：**provider token 列表**（复用该 provider 的能力菜单），或 `'<token>/<能力名>'` 能力级路径（只引菜单里的单个能力） |

技能方法体拿到的第二参是 `SkillContext`：`ctx.llm({ prompt })` 才会真正调模型（脚本式，调几次由你写死）。

### `@SubAgent(spec: SubAgentSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 同 `@Tool` |
| `schema` | 主 agent 填给子 agent 的任务入参 schema |
| `name` | 缺省取方法名 |
| `system` | 子 agent 的角色提示：`string` / `SystemPrompt` / `(task) => SystemParam`。⚠️ 前两形态会**自动追加**一句运行提示（「你运行在独立上下文，全部中间过程不外传；你的最终回复将作为报告原样交回主 agent」），**函数形态不会** —— 要这句提示请在函数里自己拼 |
| `tools` | 子 agent 可调工具：**provider token 列表**，或 `'<token>/<能力名>'` 能力级路径 |
| `model` | 子 agent 自己的模型 |
| `maxTokens` | 同上 |
| `maxIterations` | 同上 |
| `resultSchema` | 给出后子 agent 用隐藏 `submit_result` 提交结构化结果 |

子 agent 是**独立循环 + 裁剪上下文**：主 agent 的历史它看不到，只有最终文本（或 `{ report, result }`）以 tool_result 回流。

### `@Prompt(spec: PromptSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 描述**何时该拉取**这段文本 |
| `name` | 缺省取方法名 |
| `schema` | 模板化入参 schema；缺省空对象（无参资产） |
| `version` | 资产版本号（git hash / `'v3'` 等）；装配期随能力名收集，每次 run 落 run 根 span 的 `prompts.versions` attribute —— 见 §6「提示词版本化」。缺省（无版本）则该能力不进表 |

`@Prompt` **只支持方法形态**（标准装饰器下字段拿不到值/类引用）。实例方法与静态方法都**沿继承链**收集（父类的 `@Prompt` 资产子类自动带上）。方法体内用 `asset(import.meta.url, './x.md')` 读同目录长文本。

---

## 4. `createApp` 与 `app.run` 选项

### `createApp(options: AppOptions)`

| 选项 | 说明 |
|---|---|
| `system` | **必填**。`SystemPrompt` 实例（自动打 cache breakpoint）或已拼好的 `SystemParam` |
| `name` | 应用名，同时作为 run 名写进 trace |
| `providers` | DI providers：`useValue` / `useClass` / `useFactory` + `deps` |
| `modules` | 能力包（`defineModule({ providers, middleware })`），模块级先注册、应用级可覆盖同 token |
| `discover` | 能力目录路径：**一个目录或一组目录**（数组顺序即装配顺序，典型是四分类目录）。给出后 `createApp` 返回 `Promise<AgentApp>`；数组里任一目录不存在会**报错**（显式给出的搜索路径不该静默落空） |
| `model` | 缺省模型；不给则 `AGENTIA_MODEL` env，再回落 `claude-opus-5` |
| `fallbacks` | 缺省模型 fallback 链（可被单次 run 覆盖）：`[{ model, client? }]`，主模型本回合最终失败且错误可换（rate_limit / server / timeout / connection）时按序换环；每环独立 llm.turn span（成本归对模型），切换记 `llm.fallback` 事件。护栏：aborted 永不换、吐过字不换、每回合从主环重新起；子 agent / skill 子循环不继承。⚠️ 链环的 `client` 是进程内对象：持久化异步任务崩溃续跑后读回的是空壳（run 入口响亮抛 TypeError），跨重启仍成立的链只写 `model` |
| `traceContent` | `'full'` = 每回合的 assistant 文本落 llm.turn span 的 `output.text` 属性（过 `maxEventChars` 同一道截断闸 —— 它管「多长」，这个管「记不记」）；缺省不记。⚠️ 体积显著增大，且模型输出从此进入要脱敏的面（出库前走 `docs/observability.md` 配方 2.4）。可被单次 run 覆盖 |
| `labels` | 缺省归因标签（`Record<string, string>`，可被单次 run 覆盖 —— 注意是**整体替换**不是合并）：落 run 根的 `labels.<key>` 属性（trace 侧无基数问题，随便加；与框架自写的 `source` 触发来源审计正交）。键值都必须是字符串（键非空），否则 run 入口抛 `TypeError`；可序列化，异步任务随 TaskRecord 落库、续跑不丢。⚠️ 进 metrics 是**另一个开关**：`metricsSink({ labelKeys })` 显式点名哪些键上指标标签（缺省一个都不上，防 Prometheus 基数爆炸） |
| `maxTokens` | 缺省 `max_tokens` |
| `maxIterations` | 缺省循环上限 |
| `retry` | 缺省模型请求重试策略（可被单次 run 覆盖）：缺省**开启**（`DEFAULT_RETRY`：maxAttempts=3、指数退避 + 抖动）；`false` 关闭 |
| `contextPolicy` | 上下文预算策略（`createBudgetPolicy(...)`）；带状态的策略应实现 `forRun()` 按 run 隔离（见 §长上下文） |
| `toolSources` | 白名单：只把这些 provider 的能力放进主菜单 |
| `tools` | 直接追加到主菜单的**裸工具**（`AgentTool[]`）：给「构造期才知道有哪些工具」的场合（典型：MCP 桥，见 §6）。与能力**同过中间件、同进重名查重**，不是旁路。重名查重覆盖**主菜单 + 子菜单**（@SubAgent/@Skill 的 `tools` 引用展开结果也查，报错指到哪个能力的哪个引用片） |
| `middleware` | 能力调用中间件（洋葱链，链序 = 注册顺序） |
| `sinks` | trace 出口，run 收尾投递 |
| `onTraceEvent` | **增量记账出口的缺省值**：run **进行中**逐笔回调（`span.begin` / `span.end` / `span.event` / `span.attribute` / `span.link`），给等不了收尾的消费者（面板 / SSE / 任务流）。与 `sinks` 是**两条缝**、可同时配；单次 run 给了自己的那个是**叠加**（应用级在前）而非覆盖。⚠️ **不保证送达**（宿主自己的流断了就断了），也不替代 `sinks` |
| `maxTotalTokens` | 缺省成本硬管控：整条 run（**含子 agent / skill 子循环**，上限经 `ToolRunContext` 透传）累计 token 上限（可被单次 run 覆盖） |
| `maxCostUsd` | 缺省成本硬管控：累计成本（美元）上限（**依赖模型在价格表内**，见 `priceOverrides`；未定价模型会留 `usage.unpriced` 事件，所以「护栏有没有真的生效」看得见） |
| `priceOverrides` | 价格表覆盖/追加（`$/1M tokens`）：覆盖内置同名项，或给非 Anthropic 模型定价（如 `{ 'deepseek-chat': { in: 0.27, out: 1.10 } }`）。⚠️ **模型名是精确匹配**：Anthropic 每个型号都发两个 id（不带日期的别名 + 带日期的快照，如 `claude-haiku-4-5` / `claude-haiku-4-5-20251001`），**互不相通** —— 用哪个 id 就得按哪个 id 定价，否则 `maxCostUsd` 不触发（会留 `usage.unpriced`，见下）。条目还可带**缓存乘数** `cacheRead` / `cacheWrite`（缺省 `0.1` / `1.25`，相对 `in`；写 `0` 就是**乘数为零** = 该模型的缓存读 / 写不花钱，**不是**「未设」—— 实现用 `??` 而非 `||`）：缓存写缺省只对 **5 分钟** 档正确，用了 `cache_control: { ttl: '1h' }` 就写 `cacheWrite: 2`；缓存读的逐模型例外（Opus 5.5 = `0.05`、Fable 5.1 / Mythos 5.1 = `0.025`）同理。**透传给子 agent/skill 的子循环** —— 不会「主 agent 有成本、子 agent 恒 0」。非法单价与非法乘数都在**第一次 llm 调用之前**就失败：run 以 `status: error` 收口（错误记在 run 根 span 上、`totalUsage` 全 0、client 一次都不被调用）—— ⚠️ **不是抛异常给调用方**（`buildPricing` 的错被 `runAgent` 收成 result，别写成 `try/catch` 等它抛） |
| `onUnpricedModel` | 遇到价格表外的模型时回调（`{ model, spanId }`，每个循环作用域内每模型一次）；抛错被吞，**不改变 run 结局**（定价缺失是宿主配置问题）。用它接告警 |
| `toolTimeoutMs` | 缺省单工具超时（毫秒）；超时该条 tool_result 记 is_error，不杀 run |
| `maxToolConcurrency` | 缺省同回合并行工具上限；不设 = 不限（全并行） |
| `maxEventChars` | 缺省 trace 事件正文截断上限（可被单次 run 覆盖）：数字 = 入参/出参统一用该上限，`false` = **不截断**（完整正文进 trace，面板里能展开看全文）；不设 = 框架缺省 |
| `traceLimits` | **记账的数量上限** `{ maxEvents? }`（可被单次 run 覆盖）：整条 trace 的事件总数闸。超限即停止记账，并在 run 根留**两笔** `trace.truncated` —— **起点标记** `{limit}`（断点在这里）＋ **收尾摘要** `{droppedEvents, limit}`（丢了多少），两笔**同时**进交付的 trace 与 `onTraceEvent` 增量流。缺口位置可预测（尾巴）且**有计数**。与管**长度**的 `maxEventChars` 正交（一个管「多长」、一个管「多少」）；不设 = 不限（全量记账是本框架的承诺）。坏值（NaN / 负数 / 小数）在 run 入口抛 `TypeError` |

### `app.run(messages, opts?: RunAppOptions)`

| 选项 | 说明 |
|---|---|
| `system` | 单次覆盖 system（volatile 段建议每 run 重建） |
| `model` | 单次覆盖模型 |
| `fallbacks` | 单次覆盖模型 fallback 链（`[{ model, client? }]`）；语义同 `createApp` 的 `fallbacks` |
| `traceContent` | 单次覆盖 assistant 文本记录开关（`'full'`）；语义同 `createApp` 的 `traceContent` |
| `labels` | 单次覆盖归因标签（**整体替换**缺省，不是合并）；语义同 `createApp` 的 `labels` |
| `maxTokens` | 单次覆盖 |
| `maxIterations` | 单次覆盖 |
| `client` | 注入 `ModelClient`（换 OpenAI 兼容端点等） |
| `onText` | 文本增量回调（SSE/终端） |
| `onTraceEvent` | 单次 run 的**增量记账出口**（见 `createApp` 同名项）：与**应用级那个叠加**（应用级在前），不是覆盖 |
| `traceLimits` | 单次 run 的记账数量上限（覆盖应用级缺省）；见 `createApp` 同名项 |
| `signal` | `AbortSignal`：中止则在飞请求被取消，run 以 `stopReason='aborted'` 收尾（算失败） |
| `traceContext` | 入站链路上下文 `{ traceId, spanId? }`：触发本次 run 的上游 span 记成 run 根的一条 `links`（不改 `traceId == runId`）。HTTP 宿主认 `traceparent` 头，自动填 —— 见 §6「跨进程关联」 |
| `blackboard` | 预置黑板种子（配 `Blackboard` 声明合并有键补全） |
| `contextPolicy` | 单次覆盖上下文策略 |
| `retry` | 单次覆盖重试策略：`false` 关闭，或 `{ maxAttempts, baseDelayMs, maxDelayMs, jitter, onRetry }` 调参（只重试「本次尝试尚未产出文本」的可重试失败） |
| `idempotencyKey` | 幂等键（异步宿主的 at-least-once 去重依据） |
| `rethrow` | 硬失败是否抛出；缺省 `true`（异步宿主置 `false`，落 failed 记录而非冒泡） |
| `tools` | 单次覆盖工具菜单（**同样过装配期那条中间件链**，不是旁路 —— 否则 per-run 覆盖就绕开了鉴权/限流/审计） |
| `resultSchema` | 结构化结果 schema；配 `fromZod<T>` 可让 `result.typed` 自动是 `T` |
| `maxTotalTokens` | 成本硬管控：整条 run（**含子 agent / skill 子循环**，各级共享同一 recorder 的累计账单）累计 token 上限；超限以 `stopReason='budget_exceeded'` 收尾（**算失败**） |
| `maxCostUsd` | 成本硬管控：累计成本（美元）上限；模型不在价格表内时**不触发**（用 `priceOverrides` 定价，或用 `maxTotalTokens` 兜底） |
| `priceOverrides` | 单次覆盖价格表（`$/1M tokens`）；语义同 `createApp` 的 `priceOverrides` |
| `onUnpricedModel` | 单次覆盖未定价回调（**是函数，因此不在 transport 的 `RunInvocationOptions` 里** —— 异步宿主不会替你传） |
| `toolTimeoutMs` | 单个工具执行超时（毫秒）；超时该条 tool_result 记 is_error，run 继续 |
| `maxToolConcurrency` | 同回合并行工具上限；缺省不限 |
| `maxEventChars` | trace 事件正文截断上限（字符）：数字 = 入参/出参统一用该上限，`false` = **不截断**；缺省按类型收敛（入参/成功出参 2000、失败出参 1000）。**透传给子 agent/skill 的子循环** —— 同一棵调用树上口径一致。只影响**记账**，回给模型的 tool_result 永远完整 |
| `session` | 会话持久化 `{ store, id }`：run 前拼历史、成功收尾追加本轮（见 `SessionStore`） |
| `sessionId` | 会话**引用**（可序列化）：**只被异步宿主消费** —— 「`sessionId` + runner 的 `sessionStore`」那条路（任务里只落 id，store 实例不可序列化；runner 没配 `sessionStore` 而任务带了它 ⇒ submit 当场报错）。⚠️ 直接 `app.run` 传它**不生效**（不建 `session.id`、不接历史），入口会 `console.warn` 一次指出改用上一行的 `session: { store, id }`；只要 run 根的 `session.id` 标记而不要历史，直连 `executeRun` / `runAgent` 的引擎级 `sessionId`（见 §6.4「提示词版本化与会话标记」） |
| `memory` | 跨 run 记忆 `{ store, keys }`：run 前水合进 blackboard（用户种子优先）、收尾写回；与 `session` 正交（见 `MemoryStore`） |
| `beforeFlush` | `(trace, result) => void \| Promise<void>`：**sinks 冲刷之前**的最后一笔（run 正常收尾后调一次，抛错被吞）。给「**拿到结果才判得出**的结论」用的缝 —— 典型是 `defineEval` 的 score：等 `app.run` 返回再 `attachScore`，`metricsSink` 早在导出那一刻聚完账，分数就永远进不了指标。读 trace 就够的判断不必用它，写进 sinks 里即可（见 §6 判官配方） |
| `approvals` | HITL 审批决定（`Record<tool_use_id, ApprovalDecision>`）：恢复 `suspended` 的 run 时传入（异步宿主会自动带，见 §6.6「人工审批」）；手工续跑「assistant 结尾带 tool_use」的消息历史时也可直接给 |
| `events` | run 事件（`TaskEvent[]`，`{ eventId?, type, payload }` 全是字符串）：挂起期间投递、随 `TaskRecord` 落库的事件，续跑段由引擎在**未决 tool_use 解决之后**渲染成 user 文本消息注入消息流（异步宿主经 `signalTask` 自动带，见 §6.6「事件投递」）；手工续跑时也可直接给 |

返回 `AgentRunOutput`：`{ run, result }`。`result` 含 `trace` / `stopReason` / `finalText` / `iterations` / `error` / `typed`；
`stopReason === 'suspended'`（挂起：等人工审批 / 等一个时刻）时另有 `suspendedMessages`（完整消息历史，末尾是含未决 tool_use 的 assistant 消息）、`pendingApprovals`（待决 tool_use_id 列表）与 `suspendedReason`（`'approval'` / `'timer'`），未挂起时三者皆为 `undefined`。

---

## 5. 类型链路（这块决定「编辑器给不给提示」）

三条链路默认是**关闭**的（为向后兼容），声明后才生效。**写 AI 代码时优先用它们**，因为它把「两处双写」变成「一处声明、编译器兜底」。

### 5.1 黑板键：`Blackboard` 声明合并

不声明时 `ctx.get('任意字符串')` 返回 `unknown`（人肉记键名）。声明一次，全局生效：

```ts
declare module '@migor/agentia' {
  interface Blackboard {
    profile: { name: string; vip: boolean };
    turnCount: number;
  }
}
// 之后：
ctx.get('profile');   // { name: string; vip: boolean } | undefined
ctx.set('turnCount', 1);
ctx.get('profil');    // ✗ 编译期报错（键不存在）
```

动态键（运行期算出来的 `string`）拿不到字面量联合，按文档断言：`ctx.get(key as BlackboardKey)`。

#### 嵌套能力**共用同一块黑板**（不隔离，有意为之）

`@SubAgent` / `@Skill` 的执行体跑在**同一个** `RunContext` 上：单例 ALS 只在 run 创建时进一次
（`runtime/context.ts` 的 `withRunContext` 全仓只有 `src/runtime/run.ts` 那一个调用点），子循环不会再进一层。

- **所以**：子 agent / 技能里 `RunContext.current()?.get('k')` 读到的就是**父 run 的那块黑板**
  （同一份 `Map`），子 agent 写的键父 run 也看得见 —— 这是**有意**的，「把你的发现留在黑板上」
  正是子 agent 的用法（也是 `@Skill` 第二参能拿到 ctx 的原因）。
- **代价是「没有隔离」**：并发跑的两个子 agent 若写同一个键，是**后者覆盖前者**（last-wins），
  与跨 run 记忆 `flushMemory` 的取舍同款。要隔离就**自己命名空间**（`agentA.state` /
  `agentB.state`），框架不替你拆键、也不做深拷贝。（「要不要按子树隔离」是开放项，见 `spec.md` §11。）

### 5.2 schema 即单一事实来源：`fromZod<T>`

```ts
const Weather = z.object({ city: z.string(), days: z.number().int().min(1).max(7) });

class WeatherTools {
  @Tool({
    description: '查天气',
    schema: fromZod<z.infer<typeof Weather>>(z.toJSONSchema(Weather) as JsonSchema, Weather),
  })
  get_weather(input: { city: string; days: number }): string {
    return `${input.city} ${input.days}`;
  }
}
```

- 框架**永不 import zod**（duck-typed，只认 `safeParse`）；
- `fromZod<T>` 之后，**方法签名与 `T` 不一致会编译期报错** —— 不用手写泛型；
- 不写 `<T>`（或直接用裸 JsonSchema）→ 入参回落 `any`，**不校验**（旧行为，不算错，只是没护栏）。

### 5.3 结构化结果：`typed` 自动推导

```ts
const { result } = await app.run(messages, {
  resultSchema: fromZod<{ answer: string }>(schema, zodSchema),
});
result.typed;   // { answer: string } | undefined
```

模型没提交就是 `undefined`（不是失败）。`stopReason` 仍以 `end_turn` 正常收尾。

### 5.4 消息类型族（自有公共类型，与厂商 SDK 结构兼容）

`messages` 与模型响应的类型是框架**自有定义**（不从 `@anthropic-ai/sdk` 引类型），字段口径与
Anthropic Messages API 逐字对齐（snake_case），并与 SDK 的对应类型**结构兼容**：
手里的 `Anthropic.MessageParam[]` 可以直接喂给 `app.run` / `executeRun`；装框架**不会**连带安装厂商 SDK。

| 类型 | 说明 |
|---|---|
| `MessageParam` | 请求消息 `{ role, content: string \| ContentBlockParam[] }`（`Role` 含 `'system'`，与 SDK 逐字对齐；发给端点仍是 user/assistant 语义） |
| `ContentBlockParam` | 请求块联合：text / image / tool_use / tool_result + `{ type: string }` 兜底成员（厂商新块型原样携带，读字段先按 `type` 收窄） |
| `Message` | 模型响应（`finalMessage()` 的产物）：`{ id, type, role, content, model, stop_reason, stop_sequence, usage }` |
| `ContentBlock` | 响应块联合：text / tool_use / thinking + `{ type: string }` 兜底成员 |
| `ToolParam` | 发给模型的工具定义（**避让 @Tool 装饰器**，故不叫 Tool） |
| `MessageUsage` | 响应的 token 计量（**避让 trace 的 `Usage`**，故不叫 Usage） |
| `TextBlockParam` / `ImageBlockParam` / `ToolUseBlockParam` / `ToolResultBlockParam` | 请求侧具体块（与 SDK 同名类型逐字对齐） |
| `TextBlock` / `ToolUseBlock` / `ThinkingBlock` / `CacheControl` / `Role` | 响应侧具体块 / cache 断点标记 / 角色联合 |

注意命名避让：`Tool` 是装饰器、`Usage` 是 trace 的聚合用量（camelCase）—— 消息侧对应物分别是 `ToolParam` 与 `MessageUsage`（snake_case）。

---

## 6. 运行时 API

### 6.1 运行时上下文与装配

run 内取上下文（黑板 / `@Skill` 第二参）、把装饰器装配成 app、环境变量与 `.env` 的读法。

#### `RunContext`（`RunContext.current()`，run 内任意异步上下文可取）

| 成员 | 说明 |
|---|---|
| `runId` | 本次 run 的 id（== traceId） |
| `get` | 读黑板（配 `Blackboard` 有键类型） |
| `set` | 写黑板（链式返回 this） |
| `has` | 键是否存在 |
| `delete` | 删除键 |
| `keys` | 当前全部键 |

#### `SkillContext`（`@Skill` 方法第二参）

| 成员 | 说明 |
|---|---|
| `model` | 本次技能的缺省模型 |
| `llm` | 受限子运行：`await ctx.llm({ prompt })` / `{ messages, system, model, maxTokens, maxIterations }` |

#### 装配与执行

| API | 说明 |
|---|---|
| `createApp` | 装配应用（同步；带 `discover` 时为 `Promise<AgentApp>`） |
| `AgentApp` | `run` / `tools` / `container` / `name` |
| `defineModule` | 定义能力包 |
| `executeRun` | 低层 run 入口（自己管 `Run`/trace sink/记忆） |
| `runAgent` | 更底层：只要一个循环 + trace，不管 run 生命周期 |
| `SystemPrompt` | 系统提示拼装 + cache 布局 |
| `Container` | 显式 DI：`register` / `resolve` / `has` / `registered` |
| `validateJsonSchema` | 框架的 JSON Schema 子集校验（含路径的可读错误） |
| `classifyError` | 异常 → `{ type, message, retryable }` |
| `isSuccessStopReason` | `end_turn` / `stop_sequence` 都算正常收尾 |
| `resolveDefaultModel` | 显式 > `AGENTIA_MODEL` > `claude-opus-5` |

#### 环境变量与 `.env`（`loadEnvFile`）

| API | 说明 |
|---|---|
| `loadEnvFile` | 读一份 `.env` 进 `process.env`，返回**本次真正生效**的键；选项 `LoadEnvOptions`：`{ path?, override? }` |

```ts
import { createApp, loadEnvFile } from '@migor/agentia';

loadEnvFile(); // 缺省 cwd/.env；文件不存在 = 静默返回 {}（首次 clone、CI 的正常路径）
const app = await createApp({ ... });
```

三条语义（都刻意，别当成实现细节）：

- **框架不自动读 `.env`** —— 读哪个文件、什么时候读是宿主的启动决策。塞进 `createApp` 里自动做，会让「同一份代码换个目录跑结果不同」变成要花时间排查的悬案；而放 CLI 里只有 `agentia dev` 生效。写在**你的** `app.ts` 里，`npm run dev`、`node dist/main.js`、docker、别的宿主都一样读得到。
- **真实环境变量优先**（缺省不覆盖）：`process.env` 里已定义（哪怕空串）的键保持不动 —— CI / docker / `FOO=bar npm start` 永远赢过文件。要让文件里的值压过环境变量就 `loadEnvFile({ override: true })`。
- **想知道「生效没」看返回值**，别去看文件：被挡下的键不在返回对象里。

`agentia create` 生成的脚手架把 `.env`、`.env.example` 与 `app.ts` 里的 `loadEnvFile();` 都备好了，并在 `.gitignore` 里挡住 `.env` —— 生成 `.env` 却不 ignore，等于把 key 送进用户的第一个 commit。

> ⚠️ **`loadEnvFile()` 必须在 `app.ts`，不能在入口（`main.ts` / `batch.ts`）**：`agentia dev` 的
> runner 只 import `app.ts`、**从不执行入口**。放错一侧的失败形状是静默的 —— `npm run dev` 读不到
> `.env` 而 `npm start` 读得到，用户只会看到「没配 key」然后去怀疑框架。这条有 e2e 钉着
> （`scripts/e2e-dev.ts`）。

> ⚠️ **本机 export 过 `ANTHROPIC_API_KEY` 的人**（比如同时用 Claude Code）：按上面的优先级，脚手架 `.env` 里的 key 会被**静默压住**。改了 `.env` 却「没生效」时，先 `echo $ANTHROPIC_API_KEY` 看看环境里是不是已经有一份。

解析规则（刻意窄，够用就好）：`KEY=VALUE`，允许 `export ` 前缀与 `=` 两侧空白；`#` 整行注释；单引号内原样、双引号内认 `\n \r \t \" \\`；未加引号的值里 ` #` 起为行内注释。键名 `__proto__` **显式报错**（它会走原型 setter 被静默吞掉 —— 正是「以为配上了其实没配上」）。**不做变量展开、不合并续行**（需要就上专门的库）；既不像 `KEY=VALUE` 又不是注释的行**直接报错并指出行号** —— 静默跳过等于让你以为「配上了其实没配上」。

### 6.2 触发与宿主

同一个 app 换宿主不换语义：HTTP handler、异步任务、定时、取消与并发闸门。

#### 宿主（换宿主不换语义）

| API | 说明 |
|---|---|
| `createHttpHandler` | `(req,res)` handler：`POST /run` 同步（带 `Accept: text/event-stream` 则 SSE 流式）、`POST /tasks` 异步、`GET /tasks/:id`、`GET /healthz`；返回值另带 `drain()` 与 `runner` |
| `AsyncRunner` | 异步任务宿主（`submit` / `poll` / `awaitTask` / `approve` / `signalTask` / `cancel` / `resumePending` / `drain`）；`approve(taskId, decisions, { decidedBy? })` 审批挂起任务（HITL，见 §6.6「人工审批」）；`signalTask(taskId, event)` 投事件给挂起任务（见 §6.6「事件投递」） |
| `TaskSink` | 任务完成回调 `{ onFinished(rec) }`，配 `AsyncRunner({ taskSinks })`；抛错被吞 |
| `HttpException` | 鉴权钩子抛出以自定 HTTP 状态与响应体（抛别的错误一律按 401 处理） |
| `Scheduler` | 定时触发（`every` / `at`） |
| `runSync` | 同步 RPC（`(input, opts?) => result`） |
| `InMemoryTaskStore` | 内存任务存储（可设 `maxRecords` 做内存闸门） |
| `FileTaskStore` | JSONL 耐久存储（`compact()` 可压实日志） |
| `SqliteTaskStore` | `node:sqlite` 耐久存储（WAL + busy_timeout） |
| `RedisTaskStore` | duck-typed Redis 存储（可设 `ttlSeconds`）；客户端结构面 `get` / `set` / `del` / `keys`（或 `scanIterator`），外加设 TTL 时必需的 `expire`。`set` **只传两参** —— 尾参的选项形状两家相反：ioredis 认位置参数 `('EX', n)`、node-redis 认对象 `{ EX: n }`，取任何一种都会在另一家上失效（ioredis 会把对象字符串化成 `"[object Object]"` 报语法错；**node-redis 的 `SET` 只声明三个形参，位置参数被静默丢弃**）。所以 TTL 一律走 `expire(key, seconds)`（两家同名同形）；设了 `ttlSeconds > 0` 却没给 `expire` 时**构造期抛错**，不静默丢掉 TTL |

**`compact()` / `close()` 是接口上的可选能力，但由宿主按需调**：`FileTaskStore.compact()`
（压实 JSONL：一 task 一行、丢掉历史覆写行）与 `SqliteTaskStore.close()` 此前只活在具体类上 ——
宿主拿到的若是 `TaskStore` 类型（DI / 工厂 / 配置驱动选 store 都是这形态），想调只能 `as` 强转，
而强转**不报错**（换 store 后没有那个方法，要到运行期才炸）。现在它们在 `TaskStore` 上是**可选成员**，
调用点写 `store.compact?.()` 即可（`tsc` 知道它可能有、也可能没有）。
⚠️ 框架**刻意不替你调**：`drain()` 不关 store（同一个 store 可能被调度器或另一个宿主共用，
关掉它是**宿主的**生命周期决定）。压实频率建议低频（如 cron 每小时一次）。

**副本契约（自定义 store 必读）**：`save` 存**副本**、`get` / `byIdempotency` / `list` 交**副本** ——
内存推进只许由 `save` 驱动。内建实现经 `cloneTaskRecord` 坐实（深拷纯数据；`AbortSignal` /
函数等进程内对象按引用保留，不是序列化往返）；sqlite / redis 走序列化天然满足。自实现若交
活引用，「改 rec → `await save`」的纪律会让未落库的中间态对其他读者可见，save 失败时
污染留在库里（approve 重试撞 409、任务搁死到重启那一类）。

#### gRPC 宿主（第 4 个宿主，**框架不内置**）

gRPC 不是「另一种 broker」，它与 HTTP 是同一档的东西：**触发宿主**。所以正确形状与 HTTP 宿主
同构 —— 只产服务实现、不 listen（监听/端口/信号都是宿主的职责）：

```ts
const out = await app.run(normalizeMessages(req.input), {
  signal: ac.signal,                                        // ① 中断
  ...(traceContext !== undefined ? { traceContext } : {}),  // ② 入站链路
  rethrow: false,                                           // 跑失败是业务结果，不是传输错误
});
```

**为什么框架不内置 gRPC**（与「MCP 连接器内置」不矛盾，判别规则只有一条）：
MCP stdio 只用标准库（`spawn` + 全局 `fetch`）⇒ **内置不新增一个第三方依赖**；
gRPC 必须引第三方客户端（`@grpc/grpc-js`）⇒ 落在「可选能力一律 duck-typed / peer」那一侧。
「零运行时依赖」是公开承诺（`package.json` 三个依赖字段全空），所以它只能以**配方 + 示例**存在。
真有第二个使用方要同一份逻辑时再考虑独立包，且粒度是**一个第三方客户端一个包** ——
不是把所有集成塞进一个「服务包」（理由见 spec §10 2026-09-18 ref-host-integration-recipe）。

**宿主必须自己接上的四处**（漏掉任何一条都**不会报错**，只会静默丢东西）：

```
① deadline / 客户端取消  →  AbortSignal  →  options.signal
   不接 = 客户端已经走了，服务端还把这次 run 跑完（token 照烧），trace 里也看不出「白跑了一轮」
② metadata `traceparent` →  options.traceContext  →  run 根一条 link
   不接 = 跨进程关联在服务边界上断掉（§6.4「跨进程关联」那条缝在 gRPC 宿主上同样成立）
③ 框架错误 → gRPC 状态码（照抄 classifyError 的分类，别自己 instanceof 厂商错误类）
   不接 = 全部塌成一个 UNKNOWN，调用方的重试策略随之失效
④ trace → sink（落盘 / OTLP / 指标）
   不接 = RPC 回了结果，但「这次为什么慢 / 贵 / 失败」没有证据 —— trace 决定你敢不敢上线
```

**错误 → 状态码**照着引擎的分类口径写（`classifyError` 认的是**数据属性**：数值 `status` /
errno `code`，不是 `instanceof`）：

```ts
const t = classifyError(e).type;
t === 'rate_limit'                ? grpc.status.RESOURCE_EXHAUSTED
: t === 'server' || t === 'connection' ? grpc.status.UNAVAILABLE
: t === 'timeout'                 ? grpc.status.DEADLINE_EXCEEDED
: t === 'aborted'                 ? grpc.status.CANCELLED
: t === 'api'                     ? grpc.status.INVALID_ARGUMENT  // 4xx：调用方写错了
:                                   grpc.status.INTERNAL
```

**run 失败 ≠ RPC 失败**：与 HTTP 宿主 200 + `status: failed` 同口径 —— run 的硬失败是**业务结果**
（`rethrow: false`，看 `status` / `error` 字段），别翻成 UNKNOWN 让调用方以为是基础设施故障。
只有宿主层面的失败（入参不可规整、停机中）才用非 OK 状态码。

**流式**走同一个 `onText` 缝（不是 gRPC 特例）：`onText: (d) => call.write({ textDelta: d })`，
末帧下发整份结果 —— 与 HTTP 宿主的 SSE 事件一一对应（`text.delta` / `run.end`），
前端能把两套传输共用一套渲染逻辑。

**调用方怎么带上游链路**：metadata 里放 W3C `traceparent`（与 HTTP 头同格式、同一个
`parseTraceparent` 解析）；**畸形头静默当作没有上游**，不打回失败 —— 链路是观测行为，
一个畸形头不该把业务请求打成错误。

**现成可跑**：仓库 `examples/grpc-host/`（proto + 宿主 + 客户端 + e2e；四个 RPC：一元 /
服务端流 / 异步投递 / 查任务态），README 里每条都是可执行命令：

```bash
npm run build               # 仓库根：先出框架 dist（示例以 file:../.. 依赖它）
cd examples/grpc-host && npm install && npm run build
npm run serve     # 起宿主；PORT=0 时它打印实际端口（不靠外部探端口，没有抢占窗口）
npm run client    # 另一个终端：把四个 RPC 跑一遍
```

它的 e2e（`npm run e2e:grpc`）守的正是上面四处语义：deadline 到期后**服务端的 run 真被 abort**
（trace 里 `error.type=aborted`，而不是跑完）、`traceparent` 落成 run 根 link、
同 `session_id` 的两轮 run 共享历史、同 `idempotency-key` 重投不重复执行。

#### HTTP 端点速查（`createHttpHandler` 的路由）

| 端点 | 请求 | 响应 |
|---|---|---|
| `POST /run` | body 是 `RunInput`（string / messages / `{prompt\|text\|messages}`）；带 `Accept: text/event-stream` 则走 SSE | 200 `{ runId, status, stopReason, finalText, typed?, trace, error? }` —— **`status=failed` 也照返 200**（`rethrow:false` 语义：硬失败以 `error` 字段表达，不用 HTTP 错误码） |
| `POST /tasks` | `{ input, idempotencyKey?, options? }` —— `input` 同 `RunInput`；`options` 是 `RunInvocationOptions` | 202 `TaskRecord`（`status: 'queued'`）；同 `idempotencyKey` 未失败则去重、直接返回既有记录（**同步 store** 当场判定；**异步 store** 下只保证**同进程内并发提交**不重复执行，跨进程与终态后重提仍是 at-least-once —— 见 §7「同键去重的能力边界」） |
| `GET /tasks/:id` | — | 200 `TaskRecord`；不存在 → 404。**停机中仍可轮询**（否则拿不到在飞任务的结果） |
| `GET /tasks/:id/stream` | — | **任务进度流（SSE）**：先在 `id:` 里给流序号，逐帧下发 `trace.event`（body 即 `TraceRecordEvent`），终态发 `task.end` 并关闭。断线重连带 `Last-Event-ID`（或 `?from=<序号>`）即可续订 —— 只补该序号之后的事件。缓冲超限先发一帧 `stream.truncated{droppedBefore}`；别的进程在跑的任务发 `stream.unavailable` 后收口（**不假装实时**）。任务不存在 → 404；方法不对 → 405。⚠️ 它的读者是**旁观者**：背压/断开只收口这条流，**不中止任务** |
| `POST /tasks/:id/approve` | `{ decisions: { <tool_use_id>: { approved, reason? } }, decidedBy? }` | 200 `TaskRecord`（HITL 审批：批准/拒绝挂起任务，见 §6.6「人工审批」）；任务不存在 → 404；**挂起原因不是 `approval`**（含未挂起）→ 409；`decisions` 里有不在该任务 `pendingApprovals` 里的 id → **400（整批拒，记录一字不动）**；body 非法 → 400。**停机中仍可审批**（与 GET 轮询同理由） |
| `POST /tasks/:id/cancel` | 无 body | 200 `TaskRecord`（取消：在跑的**真中断**、在睡的**不再醒**、在排队的**绝不起跑**）。落库 `status: 'cancelled'` + `error.type: 'aborted'`（取消不是失败，但原因可查）。任务不存在 → 404；已终态 → 409；**在跑但本进程没有它的句柄、或宿主不认 `signal`**（宽限 2s 内没收尾）→ 409 —— 取消**未发生**就如实说，不假装。**停机中仍可用**（停机窗口正是最想取消在飞任务的时候） |
| `POST /tasks/:id/events` | `{ eventId?, type, payload }` —— **白名单**：全是字符串，多一个字段 → 400；`payload` 的字节上限就是 `maxBodyBytes` 那一道闸（超限 413） | 200 `TaskRecord`（事件投递：把一条事件投给**挂起**的任务，投完即续跑，事件渲染成一条 user 文本消息进消息历史 —— 见 §6.6「事件投递」）。任务不存在 → 404；**不在 `suspended` 状态**（含已终态）→ 409；同 `eventId` 重复投递 → 409（不给 `eventId` 则没有恰好一次：重复投递 = 重复进历史）；**待注入事件已达上限（64 条）→ 409**（本次事件**没有被记录** —— 先让这条 run 跑起来）。**停机中仍可用**（与审批同理由：挂起的任务只有外部输入能推进） |
| `GET /healthz` | — | 200 `HealthResponse`；**不鉴权**，停机中也回 200 |
| `GET /metrics` | — | 200 指标文本（Content-Type 跟 sink 的 `contentType` 走：缺省 `text/plain; version=0.0.4`，`export:'openmetrics'` 的 sink 发 `application/openmetrics-text`）；**需在 `createHttpHandler` 里传 `metrics`**，**不鉴权**（与 `/healthz` 同档），停机中也回 |

方法不符 → 405（带 `Allow` 头）；路径不符 → 404；body 非法 JSON → 400；body 超 `maxBodyBytes` → 413；
`POST /run` 超 `maxConcurrentRuns` → 503 + `Retry-After`；停机中 `POST /run`、`POST /tasks` → 503。

**换 model client 的缝**：HTTP 宿主**不持有 client** —— 同步 `/run` 走的是 `app.run(messages, opts)`，
而 `AppCallable` 就是 `{ name, run }`。所以要换 provider（OpenAI 兼容端点 / 自建 client），
**包一层**把 `client` 补进 `opts` 即可：

```ts
const callable = { name: app.name, run: (msgs, opts) => app.run(msgs, { ...opts, client: myClient }) };
const handler = createHttpHandler(callable, { runner });
```

异步侧更直接：`AsyncRunner` 的构造选项就有 `client`。完整可跑写法见仓库 `examples/complete/`
（**不随 npm 包发布** —— 包里只有 `dist/`、README、LICENSE 与本说明）：
<https://github.com/retrychx/agentia/tree/main/examples/complete>

#### `createHttpHandler(app, opts?: HttpHandlerOptions)`

| 选项 | 说明 |
|---|---|
| `authenticate` | 入口鉴权钩子：**除 `/healthz` 与 `/metrics` 外所有路径**都过它，且在**读 body 之前**（未通过就不收 body）。正常返回即通过；抛 `HttpException` 按其 `status`/`body` 回；抛别的错误回 401，原文只进服务端日志。框架**不实现策略**（不读 env、不碰凭据） |
| `metrics` | 指标出口：给 `metricsSink()`（或任意 `{ render() }` / 返回字符串的闭包）后，`GET /metrics` 回它的 Prometheus 文本。**不鉴权**（拉取端在集群内网）；要保护请放反代后面。不给则该路径 404。⚠️ 这只管**渲染** —— 数字要真的累计，必须把**同一个** sink 注册进 `createApp({ sinks: [metrics] })`（它靠 run 收尾投递，不自己埋点），否则 `/metrics` 恒为 0 **且不报错** |
| `maxBodyBytes` | 请求 body 上限（字节），超限回 413；缺省 1 MiB。构造期校验：必须 > 0 或 `Infinity` —— 0 会让**每个带 body 的请求**都 413（`POST /run` / `POST /tasks` / 审批全废），故直接抛错。⚠️ 还挡 `Number('') === 0`：从**空的环境变量**读出来的配置会静默变成「拒绝一切」 |
| `maxConcurrentRuns` | 同时在跑的 `POST /run` 上限，超限回 503 + `Retry-After`；缺省 32（传 `Infinity` 恢复无上限）。构造期校验：必须 > 0 或 Infinity —— NaN 会让闸门静默失效、0/负数会全部 503，故直接抛错 |
| `sseMaxBufferedBytes` | SSE 下游积压上限（字节，`res.writableLength` 超过即收口该 SSE 流并 **abort 对应 run** —— 客户端已经不消费了，继续逐 token 生成只是白烧 token）；缺省 8 MiB。构造期校验：必须 > 0 或 `Infinity` —— 判据是**写入前**的 `pending > 上限`，0 时第 1 帧照写、**第 2 帧必收口**（流活不过一帧），故直接抛错 |
| `exposeErrors` | 是否把内部异常原文回给调用方；缺省 `false`（细节只进服务端日志） |
| `runner` | 注入 `AsyncRunner`（共用 store / 并发上限 / `resumePending`）；缺省内部 `new AsyncRunner(app)` |

返回值另外挂着两样（不影响 `(req,res)` 的调用形状）：

- **`handler.drain(opts?)`** —— 优雅停机：拒新单（`POST /run` 与 `/tasks` → 503，`GET /tasks/:id` 仍可轮询）→ 等异步任务与在飞同步 run 收尾 → 强制收口仍开着的 SSE 流（**收口同时 abort 对应 run**，以 `stopReason='aborted'` 收尾 —— 只关流不中止会让 run 在后台继续烧 token）。返回是否排空干净；超时返回 `false`，**未完成的任务留在 store 里**，下次启动由 `resumePending` 续跑（不是丢弃）。`timeoutMs` 缺省 0 = 一直等。
  - ⚠️ **「一直等」只对在飞工作成立，活连接（SSE）不享受无限窗口**（2026-09-28 修）：唯一能结束一条
    「自己不结束的流」的机制就是收口，而收口原先排在等待**之后** ⇒ 缺省调用会死等。现在没有 deadline
    时**先收口再等**；给了 `timeoutMs` 时保持既有的优雅等待。
  - 返回值**如实分两种收口**：收口切掉了**在飞的 run**（`/run` 的流）⇒ `false` —— 那些工作是被
    `abort` 收尾的，不是排空的；只关掉**旁观者长连**（`GET /tasks/:id/stream`）⇒ 不损失任何工作，
    不影响这个布尔。宿主的 SIGTERM 决策（退出 / 再等）就依赖它。
  **框架不订阅信号** —— `process.on('SIGTERM', () => handler.drain())` 是宿主的事（同「框架不读 env」）。
- **`handler.runner`** —— 内部 `AsyncRunner`，需要时手动控制（`resumePending` / `awaitTask` / `list`）。

```ts
const handler = createHttpHandler(app, {
  // 只给缝：token/JWT/签名策略由你的宿主或反代实现
  authenticate: (req) => {
    if (req.headers['x-api-key'] !== expected) throw new HttpException(401, { error: '无效凭据' });
  },
});
http.createServer(handler).listen(3000);

process.on('SIGTERM', async () => {
  const clean = await handler.drain({ timeoutMs: 15_000 });
  console.log(clean ? '已排空' : '超时收口，剩余任务下次启动续跑');
  process.exit(0);
});
```

#### `GET /healthz` → `HealthResponse`

| 字段 | 说明 |
|---|---|
| `ok` | 恒 `true` —— 能回这个响应就说明进程活着（停机中也是 `true`，就绪与否看 `draining`） |
| `inFlight` | 在飞工作量 = 正在处理的同步 run（含 SSE 流）+ 已受理未完成的异步任务（queued + running）；与 `drain()` 等的范围一致 |
| `uptimeMs` | 本 handler 创建至今的毫秒数 |
| `draining` | 是否已进入优雅停机 —— 负载均衡据此摘流量 |
| `suspended` | 挂起读数（配套 6）：按原因分组的条数 + 最早的目标时刻，由下面三项组成。口径 = **本进程**看得见的记录（与 `inFlight` 同一张表）—— 跨进程部署要合并看板请自己聚合，这里不假装是全局面 |
| `approval` | `suspended` 里：等人工决定（HITL）的挂起条数 |
| `timer` | `suspended` 里：等一个时刻（durable timer）的挂起条数 |
| `nextWakeAt` | `suspended` 里：最早的目标时刻（epoch ms）；一条时间挂起都没有时为 `null` —— **不是 `0`**：`0` 在 JSON 里是个合法时刻，监控端拿它算 `nextWakeAt - now` 会得到巨大的负数，看着像「早就该醒却没人醒」 |

**不鉴权**（探针带不了凭据），且停机中也照回 200。非 `GET` 回 405。

#### 取消 / 重试 / 流式 / 并发闸门

| API | 说明 |
|---|---|
| `combineSignals` | 合成多个中断源（调用方 / 超时 / 断连），任一触发即中止 |
| `DEFAULT_RETRY` | 缺省重试参数（maxAttempts=3、指数退避 + 抖动）—— 缺省**开启** |
| `isAbortError` | 判定异常是否为中断（`name === 'AbortError'`） |
| `mapWithConcurrency` | 有界并发 map（结果保序）；`maxToolConcurrency` 的底座，也可自用 |

- **取消**：`app.run(messages, { signal })` 传 `AbortSignal` —— 框架会 abort 在飞请求（内置 Anthropic / OpenAI 适配器都转发 `signal`），run 以 `stopReason='aborted'` 收尾（算失败）。`createHttpHandler` 已内置「客户端断开即中止」；`AsyncRunner.runTimeoutMs` 到点同样是**真中止**（构造期校验：必须 ≥ 0 的有限数、且不超过 `2^31-1`ms ≈ 24.86 天 —— NaN/Infinity 与超上限的值都会被 `setTimeout` 钳到 1ms，等于每个任务立即超时，故直接抛错；要「不限」传 0 或不设）。
- **重试**：缺省自动重试可重试失败（429 / 5xx / 连接失败），指数退避 + 抖动。`retry: false` 关闭，或 `retry: { maxAttempts, baseDelayMs, maxDelayMs, jitter, onRetry }` 调参。**只在本次尝试尚未产出任何文本时重试**（已吐出的字无法撤回）。⚠️ 与底层 client 的**内置重试**叠加 —— **两条内置适配器口径一致**（`createAnthropicClient` / `createOpenAIClient` 都有 `maxRetries`，缺省 2，重试同一状态码集合 408/409/429/5xx）—— 建议二选一调（这里 `maxAttempts: 1`，或 `<适配器>({ maxRetries: 0 })`）。`maxRetries` 在**构造期**校验：只收非负安全整数（`0` = 不重试），NaN / ±Infinity / 负数 / 小数一律抛 `TypeError` —— 判定是 `attempt >= maxRetries`，NaN 恒假、Infinity 永不达到，两者都等于**无限重试**（且静默）。引擎层 `retry` 的数值旋钮同款纪律：`maxAttempts` 只收非负安全整数（`0` = 关闭重试），`baseDelayMs` / `maxDelayMs` 只收 0 ~ 2^31-1ms 的有限数（`0` = 不退避 / 封顶为零），`jitter` 只收 0~1 —— 坏值在 run 入口抛 `TypeError`（`maxAttempts: NaN` 曾静默关闭重试、`baseDelayMs: NaN` 曾被误报成「用户取消」）。
- **流式**：`POST /run` 带 `Accept: text/event-stream` → SSE 逐帧下发（`text.delta` / `run.end` / `error`，外加一族 **`trace.event`** —— 增量记账事件，body 即 `TraceRecordEvent`，用它做实时面板；不认识这一族的老客户端行为零变化）；不带该头仍回一元 JSON。
- **工具超时 / 并发闸门**：`toolTimeoutMs` 超时**不杀 run**（该条 tool_result 记 `is_error`，模型可换路）；`maxToolConcurrency` 给同回合的并行工具设上限（默认全并行）。⚠️ 超时 = **放弃等待**：`AgentTool.run` 没有 signal 参数，**副作用可能已发生**；但引擎放弃等待时会 abort `ToolRunContext.abandoned` —— 想真停的工具监听它自行收尾（框架自带的 @SubAgent / @Skill 已这么做：超时即中止子循环，capability span 以 error 收尾）。**超时判定只有一个裁判**：`toolTimeoutMs` 是唯一判据 —— 工具自带的超时（如 MCP 桥的 `timeoutMs`）在设了本项时**不参与**判定；反过来说，工具自判的超时（抛 `code='timeout'` 的错误）与引擎判的记**同一类账**（`errorKind='timeout'`），并同样回 `is_error`。

### 6.3 上下文预算与成本

长上下文怎么裁、成本怎么硬停 —— 两套独立旋钮，各自的选项表跟在对应小节后。

#### 长上下文

| API | 说明 |
|---|---|
| `createBudgetPolicy` | 预算策略：超预算先 `trimToolPairs` 编辑，再 `compactMessages` 压缩（带滞回） |
| `trimToolPairs` | context editing：丢旧 tool 对（按**对数**，`keepToolPairs`） |
| `compactMessages` | compaction：旧前缀做摘要（摘要器由你注入，框架不替你造 token） |
| `estimateMessages` | 估算一组消息的 token（预算决策用，不是精确记账）。⚠️ **图片块按上界估**：块里没有宽高，而官方图片计费按**尺寸**（28×28 像素 = 1 token，与文件字节数无关）⇒ 框架按「长边缩到 1568px」的**上界 3136 token/块**计（宁可高估让 `maxTotalTokens` 提前拦，也不要低估让它迟触发）。未知块按**未截断**负载估（同上理由） |
| `defaultEstimateTokens` | 缺省的单文本估算函数（CJK 感知启发式：CJK ≈ 1.5 字/token、其余 ≈ 4 字符/token） |
| `renderMessages` | 把 messages 渲染成纯文本 —— 喂给你注入的 compaction 摘要器（`summarize`）用。⚠️ **产物是有界的**：图片块只给 `[image image/png ~150000B]` 这类占位（**含 `tool_result` 正文里嵌套的图片** —— 工具返回截图是常见的入图路径）、未知块截断到 200 字符、**工具参数**截断到 2000 字符，两种截断都**留计数**（不静默丢）—— 这三处**一律不展开 base64**（否则等于把整段 payload 当输入 token 发给摘要模型，真金白银 + 摘要质量一起毁）。⚠️ **纯文本**（`text` 块与 `tool_result` 的字符串正文）**不按长度截断**：那是摘要器要读的内容，截掉等于让 compaction 永久丢掉历史。但**纯载荷长串会被折叠**：字符集落在 base64/hex 内、**连续 ≥ 4000 字符**的串折成 `⟨载荷 N 字符已折叠⟩`（工具把截图 base64 / 大文件当**字符串**返回时，这是唯一的收口 —— 判据是**字符集**而非「无空白」，所以中文与英文散文一字不折）。⚠️ **这不是上界保证**：折行载荷（PEM 式每 76 字符换行）够不着下限，照样整段进摘要器 |

**per-run 隔离（`ContextPolicy.forRun`）**：策略可能被配成应用级单例（`createApp({ contextPolicy })`）
被所有 run 复用。带状态的实现（滞回计数、token 缓存等）应实现可选的 `forRun(): ContextPolicy` ——
引擎在每条 run 开始时调一次，拿**本 run 专用**的实例（`createBudgetPolicy` 已实现它）；
不实现的自定义策略按单例复用，状态跨 run（含并发 run）共享 —— 适合无状态策略，有状态请实现 `forRun`。

#### 成本硬管控（**别与上面的上下文预算混为一谈**）

| API | 说明 |
|---|---|
| `createBudgetGuard` | 执行 `check({ totalUsage })` → `'tokens' \| 'cost' \| null` 的护栏（也可只用来自己记账） |

两者是**互补的两件事**，取舍点完全不同：

| | `createBudgetPolicy`（§长上下文） | `BudgetGuard`（本节） |
|---|---|---|
| 时机 | **发送前** | **记账后** |
| 干什么 | 改 messages（丢旧 tool 对 / 压缩旧前缀） | 改 run 结局（超限即停） |
| 为解决 | 历史太长把请求撞 400 / 过早压缩 | **控制花钱** |
| 怎么开 | `contextPolicy` | `maxTotalTokens` / `maxCostUsd` |

- 超限后 run 以 `stopReason='budget_exceeded'` 收尾（**算失败**），run 根记一条 `budget.exceeded` 事件（带 `{ kind, limit, actual, totalTokens, costUsd }`）。
- **不是硬实时**：一回合跑完才判，实际用量可能超上限一个回合的量。
- **模型自然收尾的那一回合超限不改判失败**（只留事件）—— 那次 run 的任务其实做完了，不该追认成失败。同理，超预算的回合仍照常处理 `submit_result`（纯内部的结构化提交、零副作用）—— 模型已把最终结果交出来，连同回合丢弃等于白烧这一回合。
- **超预算当回合的普通工具不执行**：判出超限后，本回合模型要求的工具调用被**连带丢弃** —— 不执行、不回灌 tool_result，trace 里**也没有**对应的 `tool.input` / `tool.output` 事件（「避免超预算的 run 继续产生副作用」）；run 随即以 `budget_exceeded` 收尾。所以别指望「超限那一回合的工具结果会进 trace」—— 它们根本没有发生；唯一例外是上面说的 `submit_result`。
- 预算是**整条 run（含各级子 agent / skill 子循环）**的口径：上限经 `ToolRunContext` 透传，各级循环共享同一 recorder 的累计账单、每回合各自检查。子循环超限以 `budget_exceeded` 收尾（该次能力调用记 `is_error`，capability span 上记 `budget.exceeded` 事件），主循环在下一回合**入口**拦住、不再发出新请求，整条 run 以 `budget_exceeded` 收尾。

```ts
const { result } = await app.run(messages, { maxTotalTokens: 200_000 });
if (result.stopReason === 'budget_exceeded') console.warn('这次 run 被预算拦下了', result.error);
```

选项字段（`TrimOptions` / `CompactOptions` / `BudgetPolicyOptions`）：

#### `TrimOptions`（`trimToolPairs` 的选项）

| 字段 | 说明 |
|---|---|
| `keepToolPairs` | 保留的最近工具**对数**（tool_use→tool_result）；缺省 1 |

#### `CompactOptions`（`compactMessages` 的选项）

| 字段 | 说明 |
|---|---|
| `keepRecent` | 保留的最近消息**条数**；缺省 20 |
| `summarize` | 摘要器：输入被弃旧前缀的渲染文本，返回摘要（框架不替你造 token） |

#### `BudgetPolicyOptions`（`createBudgetPolicy` 的选项）

| 字段 | 说明 |
|---|---|
| `budgetTokens` | 预算（**估算 `messages` 的** input tokens；**不含 system prompt 与 tools schema** —— 真实请求的 input tokens 恒 ≥ 这个数）；缺省 60000 |
| `keepRecent` | compaction 保留的最近消息**条数**；缺省 20 |
| `keepToolPairs` | context editing 保留的最近工具**对数**；缺省 1 |
| `estimateTokens` | token 估算函数（预算决策用，非精确记账） |
| `editBeforeCompact` | 超预算时是否先编辑再压缩；缺省 true |
| `summarize` | 提供则允许 compaction（旧前缀→摘要） |
| `compactEvery` | 距上次压缩至少隔几个回合（滞回）；缺省 1 |

> `keepRecent`（**消息条数**，compaction 用）与 `keepToolPairs`（**工具对数**，context editing 用）是两种单位，刻意分开命名 —— 别拿同一个值套过去。

### 6.4 观测与调优

trace 出去之后能干什么：指标、调用树面板、调优报告、生效配置快照、资产版本与会话标记。

#### 观测

| API | 说明 |
|---|---|
| `TraceSink` | `{ export(trace) }`，run 收尾（成功/失败）都投递，抛错被吞（吞之前落一条 `console.warn`，文案含「trace sink」） |
| `registerDefaultTraceSink` | 注册全局默认 sink（构造期快照合并） |
| `TraceRecorder` | 内存 recorder（一次 run 一个）；`addLink(spanId, { traceId, spanId? })` 记一条跨 trace 链路（见 §6「跨进程关联」） |
| `parseTraceparent` | 解析 W3C `traceparent` 头 → `{ traceId, spanId? }`；**非法 / 缺头一律返回 `undefined`**（不抛、不打 400）—— 结果直接交给 `traceContext` 选项，见 §6「跨进程关联」 |
| `createOtlpExporter` | OTLP/JSON 导出，零依赖；选项见下面「`OtlpExporterOptions`」表 |
| `jsonlTraceSink` | JSONL 文件 sink：`jsonlTraceSink({ path })` → `TraceSink`，一行一条裸 Trace 追加落盘（父目录自动创建、追加不覆盖）—— **`agentia report` / `diff` / `harvest` / `export` 的输入格式**，见 §6「调优报告」。⚠️ **同一路径进程内幂等**（两次调用返回同一个 sink）：两条 sink 对口一个文件会让一次 run 落两行同 traceId，而下面的命令按「一行 = 一次 run」计数 ⇒ 一次 run 被数两次（不报错，比不落盘更难发现）。所以「应用级 `sinks` 与 `registerDefaultTraceSink` 都往 `.agentia/traces.jsonl` 写」是安全的 |
| `TraceRecordEvent` | **增量记账事件**（`onTraceEvent` 的回调参数）：`span.begin` / `span.end` / `span.event` / `span.attribute` / `span.link`，每条带单调 `seq`。载荷是**增量 + 此刻的拷贝**（`span.begin` 只给初始形状，属性/事件/链路各走自己的类型）；按 `seq` 升序折回必须**逐字等于**收尾时的 trace |
| `metricsSink` | 指标累加器（Prometheus 文本 / OTLP metrics），满足 `TraceSink` 即接入 —— 见 §6「指标」 |
| `buildRunReport` | 从一条 trace 生成**调优报告**（能力/模型的耗时、token、成本、错误率排行）—— 见 §6「调优报告」 |
| `Score` | 质量评分：`{ name; value; source?; comment? }` —— LLM-judge / 人工标注 / eval 结论挂到 trace 上；约定 `value` 为 0–1（布尔结论用 0/1），`source` 记评分来源（eval 名 / `'human'` / judge 模型 id） |
| `attachScore` | `attachScore(trace, score)`：把评分挂到 run 根 span（一条 `score` 事件，body 即 `Score`）。评分通常来自 run **之外**（跑完才评），所以走事件而非 span 字段；trace 找不到根 span 时静默忽略（观测不击穿业务） |

#### `OtlpExporterOptions`（`createOtlpExporter` 的选项）

| 字段 | 说明 |
|---|---|
| `endpoint` | collector 基地址（如 `http://localhost:4318`）；导出即 POST `${endpoint}/v1/traces` |
| `headers` | 追加的请求头（鉴权 / 租户标） |
| `serviceName` | OTLP resource 的 `service.name`，缺省 `agentia` |
| `timeoutMs` | 单次导出请求超时（毫秒，缺省 10000，非正数 = 不限）——裸 `fetch` 没有超时，collector 半开连接会让 run 收尾**永久挂起**；超时按导出失败处理 |
| `onExportError` | 导出失败回调：给了它，**所有**失败（非 2xx / 超时 / **HTTP 200 但 collector 报部分接收**）都交给它、不再向 `TraceSink` 调用方抛；不给则维持既有行为（抛出，由 `flushSinks` 吞掉并落 `console.warn` —— 观测失败不击穿业务）。存在理由：`TraceSink` 的失败缺省只有一条泛化的 warn，「导出其实少了一半数据」这类**带分类的**消息得有人能收到 |
| `projectToolSpans` | 把 span 上按 `tool_use_id` 配对的 `tool.input` / `tool.output` 事件**投影**成 `execute_tool` child span，缺省 **false**（关闭时导出产物与既往一致）：name 为 `execute_tool <工具名>`、带 `gen_ai.operation.name=execute_tool` + `gen_ai.tool.name`，start/end 取两事件的真实记账时刻；`ok:false` → status Error + `error.type=errorKind`；孤儿 input（`traceLimits.maxEvents` 截断可造出）→ **不写 `endTimeUnixNano` / status** 并带 `agentia.projection.orphan: true`（不编零时长）。原事件保留在父 span 上，engine 记账点不动 |

导出器的两条线缆口径（都有守卫钉着，别按直觉改）：

- **enum 一律整数编码**：`status.code` = `1`（ok）/ `2`（error）、`kind` = `1`（INTERNAL）。
  OTLP 规范是**明文 MUST**，且专门区别于 protobuf 的通用 JSON 映射：*「Values of enum fields
  MUST be encoded as integer values… only integer enum values are allowed in OTLP JSON Protobuf
  Encoding; the enum name strings MUST NOT be used.」*（曾经发的是 `'STATUS_CODE_OK'` 这种字符串，
  本地假 collector 只做 `JSON.parse`，所以一直没被发现）。**代价取决于 collector 的宽容度**：
  照规范校验的会整批拒收（数据没落库、框架只见 HTTP 200），按通用 protobuf JSON 映射的能收下。
- **HTTP 200 不等于全部接收**：collector 可以回 `200 + partialSuccess`（部分接收 / 拒收若干）。
  导出器把「**真拒收**（键在场且值 > 0）**或**非空 `errorMessage`」判为失败；`{}` 与
  `rejectedSpans: 0` 属于「全部接收」的另一种写法（有 collector 恒发），不算失败。

**评分链路**：`attachScore` 写 run 根 `score` 事件 → OTLP 导出时译为 `gen_ai.evaluation.result`
（`gen_ai.evaluation.name` / `.score.value`，`source` / `comment` 走自有 `agentia.score.*` 键）→
`metricsSink` 聚合成 `agentia_score` 指标族（见 §6「指标」）。eval / 在线评估怎么用见 §6「evals」与「在线评估采样」。

**OTLP 的 `gen_ai.*` 对齐**（对齐 `open-telemetry/semantic-conventions-genai` @ `6fd0d763`（2026-10-09）—— GenAI 约定自 v1.42（2026-06-12）起移出语义约定主线、该独立仓**无 tag、未版本化**，所以基准钉 commit，**additive** —— 只追加 `gen_ai.*` 键，既有 `usage.*` 等键一律保留）：
run 根 → `gen_ai.operation.name=invoke_agent` + `gen_ai.agent.name`（attributes 有 `session.id` 时另发 `gen_ai.conversation.id`）；
`llm.turn` → `gen_ai.operation.name=chat` + `gen_ai.request.model` + `gen_ai.usage.input_tokens` / `output_tokens`；
缓存读数 > 0 时另发 `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_write.input_tokens`（上游口径「when applicable」：0 = 没走缓存 ⇒ 不留键，与自有 `usage.cache*` 键双发不替换）；
父 span 上有早于本回合开始的 `context.budget` 事件 ⇒ `gen_ai.conversation.compacted: true`（上游口径：只在能可靠判定时置真，**不设 false**）；
capability span 按 **attributes** 分（`subagent` / `skill`；span 的 `name` 是**裸能力名**）：`subagent` → `invoke_agent` + `gen_ai.agent.name`，`skill` → `execute_tool` + `gen_ai.tool.name`；
`score` 事件 → `gen_ai.evaluation.result`。映射集中在 `createOtlpExporter` 一处。
普通 @Tool 只有 `tool.input` / `tool.output` 事件、没有 span（刻意口径）；要上游六家框架同款的 `execute_tool` span，开 `projectToolSpans`（导出侧投影，见上表）。
从 Tempo / Grafana 按 run 找回 trace 的做法（id 的 hex 投影、run 根按 `invoke_agent` 过滤）见 `docs/observability.md` §2.7。

> **生产落地**（按 runId 落库检索 / 日志关联 / 采样 / 脱敏）见 `docs/observability.md` ——
> 框架只保证 trace 出口，这些都在缝外用 sink 组合；四条现成 sink 的实码在
> `examples/observability/`。**完整的示例**（四类能力 + 三种触发 + 鉴权 + 全观测栈）在 `examples/complete/`；
> 最小可交付示例（Dockerfile + compose）在 `examples/deploy/`。

#### 跨进程关联（这条 run 是谁触发的）

一次 run 仍是一条**自洽**的 trace（`traceId == runId` 的 1:1 不变量不变），但可以用一条 **link**
把它接回上游 —— 触发它的那个 span（网关请求 / 队列消息 / 另一个服务）记在 run 根 span 的 `links` 上，
OTLP 导出时就是标准的 **span links**，后端能把因果边画出来。

**入站三种给法**：

| 场景 | 写法 |
|---|---|
| HTTP 宿主（网关 / 消费者通过 HTTP 打过来） | 请求头 `traceparent: 00-<32位trace>-<16位span>-01`（W3C）—— `createHttpHandler` 自动解析，`POST /run` 与 `POST /tasks` 都认；**畸形头静默当作没有上游**，不会打 400 |
| MCP 反向桥（Claude Code / 别的 agent 框架经 `tools/call` 调你的工具） | 请求 `params._meta.traceparent`（**SEP-414** 定的载体：`_meta` 里的**裸键**，不加前缀）—— `createMcpServer` 自动解析，合法即记成该次 trace run 根的一条 `links`；**缺失 / 畸形静默当作没有上游**（不造空上下文、不影响调用成败） |
| 程序内直接调 `app.run` / `runner.submit` | `options.traceContext: { traceId, spanId? }` —— 也可写 `parseTraceparent(头值)` 自己解析 |

**队列消费者（Kafka / RabbitMQ / SQS）的形态**：拿消息键当 `idempotencyKey`，把消息里带的
`traceparent` 一并传进去 —— 它随 `spec.options` 落进 `TaskRecord`，所以**另一个进程
`resumePending` 接着跑的那次 run 也带得上**，关联不断链：

```ts
// 消费者回调里（不要 await run 跑完：位移提交点与 run 终态不是一个时刻，重复靠幂等键兜）
runner.submit(msg.value, {
  idempotencyKey: msg.key,
  options: { traceContext: parseTraceparent(msg.headers.traceparent) },
});
```

这条配方**有门禁真跑**：`tests/transport/queueConsumer.test.ts`（内存版 broker + 真
`AsyncRunner` + 真引擎）把三件事逐条跑出来 —— 同键重投**不重复执行**（断言的是副作用计数，
不只是 taskId）、`traceparent` 随 `spec.options` 落库后**他进程 `resumePending` 续跑**那次 run
仍带得上同一条 link、失败不 ack 必须 nack 重投（且**失败**的键允许新任务，否则重投永远拿不到
第二次执行）。真接 broker 时仍然要自己接：门禁守的是**提交位移与幂等的时机**，不是协议实现。

异步任务可以在 `POST /tasks` 的 body 里显式给 `options.traceContext`，它优先于 `traceparent` 头。
换宿主这条缝不变：gRPC 宿主把 metadata 的 `traceparent` 翻进 `options.traceContext`，
见 §6.2「gRPC 宿主」。

**出站（反过来：你调别人）**：在 run 内用 `currentTraceparent()` 取当前 span 的 W3C 头，
自己带在出站请求上 —— 下游若也是 agentia（或任何认 `traceparent` 的服务），接到的就是一条指向
**具体 span**（回合 / 能力调用）的 link，而不是只到 run 粒度：

```ts
import { Tool, currentTraceparent } from '@migor/agentia';

class OrderTools {
  @Tool({
    description: '把工单交给订单服务',
    schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
  })
  async placeOrder(input: { sku: string }) {
    const tp = currentTraceparent();          // 不在 run 内 → undefined（那时不该编一个）
    const res = await fetch(orderSvc, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tp ? { traceparent: tp } : {}) },
      body: JSON.stringify(input),
    });
    return res.json();
  }
}
```

- **粒度**：普通工具与 `@Prompt` **不建 span**，它们的「当前 span」就是发起它们的那次 `llm.turn`；
  `@Skill` / `@SubAgent` 的方法体内则是它自己的 `capability` span。内层覆盖外层。
- **不自动注入**（一个例外）：框架不替你创建出站请求，注入那一行是你自己的
  （同上 `fetch`；gRPC 宿主塞进 metadata）。例外是 **MCP 正向桥**：`tools/call` 的请求由桥自己发，
  所以在 run 内经 `mcpTools` 调 MCP 工具时，桥自动把当前 span 的 `traceparent` 放进
  `params._meta`（SEP-414 裸键，**不进 `arguments`**；不在 run 内则不带；对端不认 `_meta`
  静默忽略 —— 这是观测，不是协议要求）。
- 与入站同一个格式、同一份 id 投影：`currentTraceparent()` 的输出喂回 `parseTraceparent()` 逐字还原，
  下游 OTLP 里看到的 span id 与本地 collector 里的是**同一个数**（见 §7 已知边界）。

> **出站的边界（如实）**：`run` 根 span 由 `runAgent` 打开，所以比它更早的环节 ——
> `contextInit`、记忆水合（`MemoryStore.load`）—— `currentTraceparent()` 返回 `undefined`：
> 那时确实还没有 span 可指。flags 位恒 `00`（本框架**不采样**，不替下游声明「已采样」）。

#### 指标（从 trace 派生）

| API | 说明 |
|---|---|
| `metricsSink` | 进程内累加 + Prometheus 文本 / OTLP metrics；**天然满足 `TraceSink`** → `createApp({ sinks: [metricsSink()] })` 即接入，零新出口 |
| `DEFAULT_BUCKETS` | 时长直方图的缺省桶边界（毫秒），可用 `buckets` 覆盖 |

四个维度，全部从既有 trace 派生，**不需要在业务代码里埋点**：

- **run 级** —— 总数 / 失败数 /四类 token / 成本 / 时长；
- **能力级** —— 每个 `tool` / `skill` / `subagent` 的**调用次数、失败次数、耗时、token、成本**。
  工具的数据来自 turn 上的 `tool.output` 事件（框架已补 `durationMs` / `ok`）；`skill`/`subagent`
  来自 `capability` span。**`@Prompt` 不建 span、无独立耗时，因此不产出能力指标**（如实缺省，不硬凑）。
- **模型级** —— 按模型（`llm.turn` 的 span name）归因 turn 数 / token / 成本 / 耗时，并单独给出
  `model_unpriced_turns_total`（算不出成本的 turn 数 —— **成本护栏失效的显式信号**）。
  同理，**标签基数折叠不是静默的**：`agentia_dropped_keys{kind="capability"|"model"|"score"}`
  （恒定发三个样本，即使为 0 —— 「0 → N」这个变化本身就是要告警的信号）；开了 `labelKeys` 时
  另按每键加 `kind="label:<key>"`、组合数封顶时加 `kind="label:combos"`（没开那几行一个都没有）。
- **评分级** —— 来自 run 根 span 的 `score` 事件（`attachScore` 写入）：
  `agentia_score{name,source}` gauge 记**最近一次**值（分数不是累加量），`agentia_score_total{name,source}` counter 记条数；
  `snapshot().scores` 以 `name@source` 为键（source 缺省时裸 name）暴露 `{ value, count, sum }`（平均 = sum/count），
  OTLP metrics payload 同样带这两个家族，`reset()` 一并清空。

接完 `GET /metrics` 直接回 `render()` 即可 —— 交给 `createHttpHandler({ metrics })` 就是一行的事
（见 §6 HTTP 端点速查）。

时长同时给两种口径，**并存不冲突**：

- **histogram**（`*_bucket` / `*_sum` / `*_count`，累积语义）—— 抓取端可**跨实例任意聚合**；
- **窗口内精确分位**（`*_last{quantile="..."}` gauge，如 `agentia_run_duration_ms_last`）—— 单实例排障时更好读。
  分位 gauge 与 histogram **必须不同名**（同名指标只允许一种 TYPE，混发会被 expfmt 判硬错误、整次 scrape 失败），
  故分位家族统一带 `_last` 后缀；capability / model 维度同理（`capability_duration_ms_last` / `model_duration_ms_last`）。

#### `MetricsSinkOptions`（`metricsSink` 的选项）

| 字段 | 说明 |
|---|---|
| `export` | 输出形态；缺省 `'prometheus'`。`'openmetrics'` 出带 exemplars 的 OpenMetrics 文本（指标 ↔ trace 互跳，见 `docs/observability.md` §4）。`'otlp'` 走 OTLP/JSON 导出（**必须同时给 `endpoint`**，不给就构造期抛错） |
| `endpoint` | OTLP 采集端基地址（如 `http://localhost:4318`）；尾部斜杠会被去掉 |
| `intervalMs` | OTLP 导出间隔（毫秒，缺省 60000）；`0` = 每次 run 收尾立即导出。定时器已 `unref()`，不阻止进程退出 |
| `resourceAttributes` / `serviceName` | OTLP resource 属性（`service.name` 缺省 `agentia`） |
| `timeoutMs` | OTLP 单次导出请求超时（毫秒，缺省 10000，非正数 = 不限）——collector 半开连接时兜底，`intervalMs: 0` 模式不被挂死；超时按导出失败处理 |
| `onExportError` | 导出失败回调（缺省每次失败落一条 `console.warn` —— 观测失败不得击穿业务，但不零信号） |
| `windowSize` | 时长分位保留的样本数（环形窗口，缺省 1024，**run / 能力 / 模型各自独立**）；非正数抛错 |
| `prefix` | 指标名前缀，缺省 `agentia_` |
| `labelMode` | 能力标签粒度：`'capability'`（缺省，`tool:search` 这种）/ `'kind'`（只按类型，基数极小）/ `'none'`（不产出能力指标） |
| `maxCapabilities` | 能力标签基数上限（缺省 200）：超出后新能力归入 `capability="__other__"`（防标签爆炸）；非正数抛错 |
| `maxModels` | 模型维度基数上限（缺省 50）：超出后新模型归入 `model="__other__"` ——`model` 是 per-run 可覆盖的，上游把版本号拼进模型 id 时键会无界增长；非正数抛错 |
| `maxScores` | 评分维度基数上限（缺省 200）：评分键是 `name@source`，eval 名带时间戳时同样无界；超出的归入 `name="__other__"`；非正数抛错 |
| `labelKeys` | 归因标签维度（R8-P4）：**显式点名** run 根 `labels.<key>` 里哪些键上指标标签（缺省 `[]` 一个都不上）。键必须是合法 Prometheus 标签名（`/^[a-zA-Z_][a-zA-Z0-9_]*$/`），否则构造期抛错。出口形态：`runs_total` / `runs_failed_total` / `tokens_total` / `cost_usd_total` 四个家族在全局样本之外追加带标签样本（全局那行仍是总量）。⚠️ 开了它以后 `sum(agentia_runs_total)` 会把全局行与分行**重复计数** —— 总量用不带标签的序列 |
| `maxLabelValues` | 每个 labelKey 的相异值数上限（缺省 100，**必须为正数**）：超出归入 `__other__`（折叠只丢粒度不丢量）；被折叠的不同值数见 `snapshot().droppedLabelValues` 与 `agentia_dropped_keys{kind="label:<key>"}`。这道上限刻意不可关 —— opt-in 挡不住「明知几千租户偏要上」，sink 内存不变量要求每个新基数维度都有 cap |
| `maxLabelCombos` | **标签组合数**上限（缺省 200，**必须为正数**）：`maxLabelValues` 封的是**每个键的值域**，而进内存的是键的**组合**（叉乘 —— 值域 100 配 3 个键就是一百万条常驻条目，且 `droppedLabelValues` 只报每键折叠数、看不出组合已经爆了）。超限的**新组合**折进一个全 `__other__` 的桶（量照收、只丢标签粒度）；被折的组合数见 `snapshot().droppedLabelCombos` 与 `agentia_dropped_keys{kind="label:combos"}`。与 `maxLabelValues` 一样刻意不可关；单键配置（最常见）下组合数 ≈ 值数，行为不变 |
| `buckets` | 直方图桶边界（毫秒，严格升序）；缺省 `DEFAULT_BUCKETS` |

#### `MetricsSink`（`metricsSink()` 的返回值）

| 成员 | 说明 |
|---|---|
| `export` | `TraceSink` 的实现（run 收尾投递）—— 也是接进 `sinks` 的形状 |
| `snapshot` | `{ runs, failed, latencyP50, latencyP95, tokens, costUsd, capabilities, models, scores, runLabels, droppedCapabilities, droppedModels, droppedScores, droppedLabelValues, droppedLabelCombos, exemplars }` |
| `render` | Prometheus 文本（`/metrics` 直接回它） |
| `contentType` | `render()` 产物的 Content-Type（随 `export` 模式走）：内置 `/metrics` 路由读它发响应头，自己挂端点时**也该读它而不是写死** —— `0.0.4` 与 OpenMetrics 不是可互换的两种写法，拿 `0.0.4` 的头去发带 exemplar 的文本，严格的抓取端会解析失败。可选成员（兼容手写的 `MetricsSink` 实现；本工厂返回的一定带） |
| `flush` | 主动导出一次（`export:'otlp'` 时有意义；prometheus 模式为空操作） |
| `stop` | 停掉定时导出（进程收尾 / 测试用） |
| `reset` | 清空累计（含能力 / 模型 / 评分三个维度，以及各自的基数配额） |

- `tokens` 口径 = **四类之和**（input + output + cacheRead + cacheCreation），与 `BudgetGuard` 一致；分项在 `render()` 里以 label 给出，不会丢。
- 分位是**窗口内精确值**（最近 rank 法），只反映最近 `windowSize` 条样本；**直方图计数是累积的**（全历史），两者语义不同、各有各的用处。
- **内存上限** ≈ `(1 + 能力数 + 模型数) × windowSize` —— 三个维度都由基数上限封顶（`maxCapabilities` / `maxModels` / `maxScores`），长跑宿主不会被拖住。
- 超上限的键折叠进 `__other__`：**丢的只是标签粒度，量不丢** —— `__other__` 桶照常累加，`snapshot()` 里各维度的总数仍然对得上。被折叠的**不同**键数见 `droppedCapabilities` / `droppedModels` / `droppedScores`（各自最多记账 1024 个键，满了以后是下界），归因标签维度另见 `droppedLabelValues`（按 labelKey 分键计）与 `droppedLabelCombos`（组合数上限折掉的那批）。
**同样的数在 `/metrics` 上也看得见**（`render()`）：`agentia_dropped_keys{kind=…}` —— 只看 Prometheus
不看 `snapshot()` 的部署不会漏掉折叠。
- `costUsd` 依赖模型在价格表内（不在表里时不计、并计入 `unpricedTurns` 与 `usage.unpriced` 事件）；**上游没回报 usage** 时另计入 `usageMissingTurns` 并记 `usage.missing` 事件 —— 那种情况下成本会**看起来**是 0（`maxCostUsd` 因此不可用），与「模型没定价」是两件事、分开计数（指标侧 `agentia_model_unpriced_turns_total` / `agentia_model_usage_missing_turns_total` 各一条）；根 span 未收尾（如失败路径的半截 trace）的 run 不进延迟样本。

#### 调用树面板（`agentia dev` 的本地面板 / 官网 Playground）

同一份 `@migor/trace-view` 渲染器，**面板 / Playground / `report` 的能力排行三处共用**，不各写一套。

- **折叠态是「一行一件事」**：事件行（`tool.input` / `tool.output`）只显示省略号收敛的摘要。
- **点事件行展开看完整正文**（正文可选中复制），再点收起。展开的正文**默认仍与标签同一行**，
  只有在放不下时才整段换到下一行 —— 官网 Playground 的 trace 列（约 320px）就属于放不下。
- **可展开的行右端常显一个 caret**（`▸` / `▾`）：这一行能不能展开随时看得见，不必先悬停才发现。
- **展开只能展开 trace 里存着的正文** —— 想看到被截断掉的部分，得在**记账时**就别截：`maxEventChars: false`（见 §4）。缺省截到 2000 字符，展开了也只有那 2000 字符。
- 入参折叠态的摘要被砍到 62 字符（4 个键 / 每值 21 字符）；**展开拿到的是原文**，不是那份摘要 ——
  本地面板与官网 Playground 两个宿主都是如此（两个宿主都不该只喂摘要，否则点开什么都没多出来）。

> 本地面板比 Playground 多一层**输入端**（prompt / 能力 / 工作目录 / 多轮四组控件 + 输入框历史），
> 见 §2.2。Playground 是只读展示 trace 的。

#### 对话历史（多轮）从哪来

开了**多轮**的能力，面板上多一个「对话」页签，内容 = 会话文件里的消息 **∪ 失败的 run**。

| 概念 | 落点 | 说明 |
|---|---|---|
| 会话存储 | `SessionStore` 接口 | `load()` / `append()`；脚手架给的是 `FileSessionStore`（写 `.agentia/session.json`，**原子写**：临时文件 + rename） |
| 会话标识 | `RunInvocationOptions.sessionId` | 同 id 的多次 run 共享历史；面板的 dev 环固定用 `'dev'` |
| 回写时机 | `runtime/run.ts` | ⚠️ **只在成功轮次回写** ⇒ 失败的轮次**在会话文件里不存在** |
| 面板怎么补上失败轮 | run 根 span 的 `attributes['session.id']` | 用它与 run 列表 join，再按 prompt 文本对上；少了这一步就是「显示一份**少了**一轮的对话」 |

**两层「历史」别混**（这是开发期最容易误导人的一处）：

- **prompt 回显**（输入框 `↑`/`↓`）：只是把文字填回输入框，**模型看不见** —— 你还能改，
  模型收到的仍是你最终回车的那句。与多轮开关无关，**永远有**。
- **对话历史**（对话页签）：前面说过的话**真的进模型上下文**（更长、更贵、可能被裁剪）。
  **只在开了多轮时出现** —— 没开多轮时一次 run = 一句输入 + 一段输出，凭空多一个对话视图
  会让人以为上个仓库的评审被带进来了（它没有，而且不该有）。

#### 调优报告（**哪个能力慢 / 贵 / 爱失败**）

指标回答「整体怎么样」，报告回答「**该拧哪个旋钮**」：

| API | 说明 |
|---|---|
| `buildRunReport(trace)` | 一条 trace → `RunReport`：能力排行（按总耗时降序；嵌套能力的 usage **只计顶层行** —— 内层行的 `tokens`/`costUsd` 为 `null`，各行可加总，与 `agentia report` 同口径）、模型归因、未定价模型清单 |
| `mergeRunReports(reports)` | 跨 run 汇总（**分位只在多条 run 上才有统计意义**）；按 `traceId` 去重、同一 traceId 只留最后一份（append-only 落盘的同一棵 trace 会被写多次，与 `agentia report` 同口径） |
| `renderRunReport(report)` | 人类可读的纯文本表（CLI / 日志用） |

```ts
import { buildRunReport, mergeRunReports, renderRunReport } from '@migor/agentia';

const report = buildRunReport(trace);
console.log(renderRunReport(report));
// capability                              calls  err   total     max       tokens    cost
// subagent:researcher               1      0     400ms     400ms     60        0.004000
// tool:search                       2      1     325ms     300ms     -         -
```

CLI 侧有薄壳：`agentia report <trace.jsonl>` —— 每行一个 JSON（裸 Trace，或含 `result.trace` /
`trace` 的 TaskRecord，如 `FileTaskStore` 的导出），跨行按能力合并后打印排行。
加 `--json` 得到机器可读输出：stdout 只有一个 JSON 文档（`{ file, runs, failed, skippedLines,
failures, capabilities, sessions, totals }`）、没有人类装饰，适合脚本与 CI 断言；出错仍走 stderr
（`错误：…`）并把退出码置 1、stdout 保持为空 —— 脚本据此区分「有结果」与「没跑成」。

**会话 / 任务维度（`sessions[]`）**：能力排行之外另打一张按**分组键**归组的表 —— 键取 run 根
span 的 `session.id`（宿主传 `session: { store, id }` 才会写，见 §6.4「提示词版本化与会话标记」），没有就退到记录
里的 `taskId`（`FileTaskStore` / `SqliteTaskStore` 的导出），再没有落 `(无会话)` 桶。
每组给 `runs / ok / fail / total / cost / cost-ok` 六列。三条口径值得记住：
**成功率一定带分母**（小组上只报百分比是噪声，所以 `runs` 与 `ok` 都单独出列）；
**成功数为 0 时 `cost-ok` 是 `-`（JSON 里 `null`），不是 0** —— 「除不了」不等于「不花钱」；
**挂起计入 `ok`** —— 成败判据与引擎同一条（`trace.status !== 'error'`），而引擎的口径是
「挂起不是失败」（取消才是 `error`）⇒ 10 条 run 全挂在审批上会报「成功率 100%」。
这是刻意的取舍，读数时把「等审批」与「跑成了」分开看。
成本取该 run 的 `totalUsage.costEstimate`（= 各 `llm.turn` 之和，**不含** capability 聚合 ⇒
`@SubAgent` 里套 `@Skill` 时不会把同一批 token 数两遍）。
能力排行的 tokens / cost 列同一条纪律：**只认顶层 capability**（没有 capability 祖先的）——
capability span 的 usage 是其子孙 `llm.turn` 的聚合，嵌套时内层行的 tokens / cost 显示为 `-`
（那批 token 已在外层行里 ⇒ 各行的 tokens / cost 可加总、不重复计数）；内层行的
calls / err / 耗时照记（那是它自己这次调用的真账）。

> ⚠️ **单条 run 内样本常 < 5，分位没有意义** —— 所以报告以 `total` / `max` 为主；
> 要看分位请用 `mergeRunReports` 汇总多条，或用 `metricsSink` 的直方图。
> CLI 报告的聚合口径与 `agentia dev` 面板的能力排行同源（同一份 `@migor/trace-view` 实现）。

那个 jsonl 从哪来 —— 框架内置了文件 sink，一行接入（零依赖）。它产出的格式就是
**CLI 四件套的输入**：`agentia report` / `agentia diff` / `agentia harvest` / `agentia export`
都吃这个文件（一行一个 JSON，裸 Trace）：

```ts
import { createApp, jsonlTraceSink } from '@migor/agentia';

const app = await createApp({ /* … */ sinks: [jsonlTraceSink({ path: 'trace.jsonl' })] });
// 之后：agentia report trace.jsonl / agentia diff a.jsonl b.jsonl / agentia harvest trace.jsonl / agentia export trace.jsonl
```

父目录不存在会自动递归创建；**追加不覆盖**（多跑几次就累积多行）；写失败抛给 `flushSinks`
吞掉并落 `console.warn`（观测失败不击穿业务，但不再零信号）。

异步宿主更省事：把 `FileTaskStore` 的落盘文件直接喂给它 —— `TaskRecord` 里带 `result.trace`，
`report` 认这种形态，不用另写 sink。⚠️ 它是 **append-only**（每次 save 追加一行）：审批流里
同一棵挂起段 trace 会出现多行（挂起 / approve / 接管各 save 一次）。`report` 按 **`traceId`
去重、只留最后一行**（append-only 里后面的是新状态），runs / 成功率 / 成本不会按行数翻倍。

#### 生效配置快照（「这条 run 用了哪套旋钮」）

每个 run 的**根 span** 都带一组 `config.*` attributes（`config.maxTokens` / `config.maxCostUsd` /
`config.retry.maxAttempts` / `config.contextPolicy.budgetTokens` / `config.priceOverrides` /
`config.maxEventChars` / `config.traceLimits.maxEvents` …）。
带缺省值的那几项（`maxTokens` / `maxIterations` / `contextPolicy` / `retry`）**缺省值也记**——
「没配」与「配了缺省值」因此可区分；可选项（`toolTimeoutMs` / `maxToolConcurrency` /
`maxEventChars`）只在设了才记。换参数前后对比、复现线上行为都有据可查。
函数型选项（`summarize` / `confirm` 之类）只记「配没配」，不记函数体。
截断关掉时记的是 `'off'` 而不是 `false` —— 后者在日志/看板里会被读成「上限为 0」。

#### 提示词版本化与会话标记（run 根 attribute）

- `new SystemPrompt({ version: 'git-abc123' })` → 自动写到 **run 根 span 的 `system.version` attribute**：trace 里能查出「这个结果是哪个版本的提示词产出的」（换 prompt 前后对比、排查回归都靠它）。
- 版本号怎么来（git sha / 语义版本 / 手工）由你决定 —— 框架**不做**版本库与回滚平台。
- 单次 `app.run(..., { system })` 覆盖时，版本**跟当次那个 `SystemPrompt` 走**；`system` 传已拼好的 `SystemParam` 则无版本可记（不写空串冒充实有版本）。
- 直连 `runAgent` / `executeRun` 时可用引擎级选项 `systemVersion` 显式给。
- **`@Prompt` 资产版本**：`@Prompt({ version })` 声明后，装配期把菜单里全部带版本的 @Prompt 收集成 `{ 能力名: 版本 }` 表（与主菜单同一条收集路径，`toolSources` 收窄同样生效），每次 run 落 run 根 span 的 `prompts.versions` attribute（`name@ver` 逗号拼接、按名排序、空表不记）—— 质量回归能定位到具体资产版本。直连 `runAgent` 时用引擎级选项 `promptVersions` 显式给。
- **会话标识**：`app.run(..., { session })` / `executeRun` 给了 `session` 时，session id 自动落 run 根 span 的 `session.id` attribute（OTLP 导出时映射 `gen_ai.conversation.id`）—— 多轮对话的 run 由此可按会话聚合，不用手填。直连 `runAgent` / `executeRun` 时用引擎级选项 `sessionId` 显式给。⚠️ **别把 `sessionId` 传给 `app.run`**：那个字段是异步宿主的可序列化会话引用（见 §4 选项表），`app.run` 不消费它 —— 直传会 `console.warn` 一次且不生效。
- **菜单签名**：每次 run 落 run 根 span 的 `tools.names`（装配后菜单的名字、按名排序、超长截断带 `…(+N)`）与 `tools.menuHash`（12 位摘要，材料 = 排序后的「名字 + **输入 schema**」规范序列化）—— 与 `prompts.versions` 同动机：质量回归能回答「这两段 run 跑在同一个菜单上吗」。口径：与菜单顺序、schema 键序无关；**`description` 不参与**（润色文案不算菜单变化，代价是「只改描述」看不见 —— 有意）。给了 `tools` 就自动记，无需开关。
- **菜单漂移（续跑时菜单变了）**：挂起段之后**续跑**时，未决 tool_use 引用的工具若已不在当前菜单（删了 / 改名了），框架记**三处信号**：`menu.drift` 事件（含 `{ missing, tool_use_ids, menu_size }`；时间线与 `GET /tasks/:id/stream` 都看得到）、父 span 的 `menu.drift` attribute（如 `missing:danger`）、一条 `console.warn`。⚠️ **run 照常收尾**（不判失败）：那些 tool_use 会以 `unknown tool` 回给模型 —— 为什么不做严格模式见 spec §10 2026-09-27 ref-menu-drift-signals。注意这与「回合内模型编了个不存在的工具名」不同：那个是幻觉，走既有 `unknown_tool` 路径、**不**报漂移。

#### 交接与护栏（`agentia.handoff.*` / `agentia.guardrail.*`）

**交接**（agent → agent）与**护栏**（审批）在这个框架里都不是 span：前者就是一条 `capability`
span 本身（`attributes.subagent`），后者**只是事件**（`approval.requested` / `approval.decided`）。
这两样对外部 OTLP 消费者都等于「要解析才看得见」⇒ 各补一个 additive 属性当入口：

| 键 | 值 | 写在哪 | 何时 |
|---|---|---|---|
| `agentia.handoff.from` | **调用方** agent 名 | 被调 `@SubAgent` 的 capability span | 该 span 由另一个 agent 的回合发起时 |
| `agentia.handoff.to` | **被调** agent 名 | 同上 | 同上 |
| `agentia.guardrail.name` | 待决的**首个**工具名 | 与 `approval.requested` **同一个 span**：首段是发起回合的 `llm.turn`；**续跑段再挂起时是 run 根**（续跑入口把 run 根 id 当 turnId，本段没有对应 `llm.turn`） | 记 `approval.requested` 时 |
| `agentia.guardrail.triggered` | `true` | 同上 | 同上 |

- 名字从哪来：run 根用 `runName`（默认 `agent.run`，与 OTLP 的 `gen_ai.agent.name` 同源），
  子 agent 用它注册的 `name`。嵌套交接会**逐层换名**（内层 `from` 是外层子 agent，不是应用）。
- ⚠️ **刻意不做**：不把审批**升级成 span**。它现在是事件、与「普通 `@Tool` 只发
  `tool.input` / `tool.output`」同形；升级会动引擎记账点，且下游已能按事件消费。
- ⚠️ 两处**只发一半**是口径不是遗漏：`guardrail.*` **只在触发时发**，不设 `false`
  （与 `gen_ai.conversation.compacted` 同款）；`handoff.*` 拿不到调用方身份时（宿主手搓
  `recorder` + `ctx` 直调 `subagentToTool`）**两个键都不发** —— 编不出来就不编。
- **视图**：`@migor/trace-view` 的 summary（`agentia report` 与 `agentia dev` 面板同源）把
  `approval.decided` 聚成 `guardrail:<工具名>` 一行 —— `calls` = 走到决定的次数、
  `err` = **被拒**次数（护栏真挡下的）、`total` / `max` = 等审批时长（事件的 `waitedMs`；
  宿主没回填 `requestedAt` 时记 0，**不编造**）。聚合**不限 span kind**（首段的决定记在
  `llm.turn`、恢复段的记在 run 根，两处都聚）。⚠️ 只有 `approval.requested` 而始终没恢复的
  挂起**不产出行**：它没有结论也没有时长。

### 6.5 集成

换模型 / 接 MCP / 离线 eval / prompt 与模型的 A-B。

#### 多模型 / 记忆 / 重放

| API | 说明 |
|---|---|
| `createAnthropicClient` | 默认 ModelClient（Anthropic）：自定义只传 `apiKey` / `baseURL`；框架**零运行时依赖**，不装厂商 SDK |
| `createOpenAIClient` | OpenAI 兼容端点适配（DeepSeek 等；**真流式**、图片块转 `image_url`、DeepSeek 的 `prompt_cache_hit_tokens` 映射进 `cache_read_input_tokens` 并从 input_tokens 拆出不双计，其余端点 cache token 恒 0） |
| `InMemoryMemoryStore` | 跨 run 的**键值黑板**记忆（`{ store, keys }` 配 `executeRun`） |
| `InMemorySessionStore` | 跨 run 的**对话历史**（`{ store, id }` 配 `executeRun` / `app.run`）；与前者正交，可同时用 |
| `traceToMessages` | 把 trace 还原成 messages（重放基底） |
| `forkMessages` | 分叉重放：在主循环第 `atTurn` 回合之前截断重放历史、拼上 `append` 新消息喂回 `app.run`（「从第 N 回合换个问法重跑」的基底，**不是续跑**） |
| `diffTraces` | 两条 trace 的 A/B 比对（prompt / 模型实验）：run 级 summary + 逐 span 字段差；纯函数，llm.turn 配对**忽略模型名**，缺省忽略墙钟 |
| `applyMiddleware` | 手动包裹配置菜单（装配层已自动做） |

#### 并发 run 共用同一 keys（回写会不会互相覆盖）

`memory: { store, keys }` 的水合/回写是**读 → 改 → 写**三步：`load` 在 run 开始，`save` 在收尾。
两条 run 拿**同一份 store + 同一批 keys** 并发跑时，后写的那条会把先写那条改过的键**整片覆盖**回去，
而它自己看不出任何异常 —— 这就是 lost update（**落后写赢**：先写完的那条被静默丢掉）。
框架能发现它的**唯一依据是版本号**，所以这是一对**可选**成员：

```ts
class MyMemoryStore implements MemoryStore {
  load(keys: string[]): Record<string, unknown> | Promise<Record<string, unknown>> { /* 必填 */ }
  save(entries: Record<string, unknown>): void | Promise<void> { /* 必填 */ }

  // 可选①：带版本号的读 —— 多回一个**不透明**句柄（框架不解释它，只在本 run 回写时原样递回）
  loadWithRev(keys: string[]): MemorySnapshot { /* → { values, rev } */ }

  // 可选②：CAS 写 —— 版本对不上就**一个字都不写**，并如实回报
  saveIfRev(entries: Record<string, unknown>, rev: unknown): MemoryWriteResult {
    // 版本对不上 ⇒ return { committed: false, reason: 'conflict' }   // 写成功的路径不许半写
    // 写成功     ⇒ return { committed: true }
  }
}
```

三条规则：

1. **成对实现**：只实现一个是**装配错误** —— `executeRun` 入口当场抛 `TypeError`。
   半个 CAS 与「不支持」等效（回写照旧静默覆盖），却让「有没有被覆盖」看起来有据可查 ——
   本仓把这类「看起来在岗、其实不在岗」一律当错误处理。
2. **冲突时框架不写、也不替你合并**：`saveIfRev` 回 `committed: false` ⇒ 本轮回写被拒
   （一个字都没写）+ 一条 `console.warn`（带 keys 与冲突事实）。「后写赢 / 逐键赢 / 按时间戳赢」
   都是策略，属于 store 与宿主的决定 —— 框架只负责把「丢了一条写」变成**有声**。
3. **回写被拒不改 run 结局**（仍是 `succeeded`）—— 与 sink 抛错、store 故障同款：辅助动作
   不击穿业务。**代价如实**：这一轮的记忆**没落库**，所以它是一条日志而不是一句承诺。
   要重试请在自己的 store 里做（合并策略是你的）：

   ```ts
   for (let attempt = 0; attempt < 3; attempt++) {
     const { values, rev } = store.loadWithRev(keys);
     const merged = { ...values, ...myChanges };   // ← 「怎么合并」由你定，框架不猜
     if (store.saveIfRev(merged, rev).committed) break;
   }
   ```

⚠️ **不实现这一对**（只有 `load` / `save`）：**保持原行为**（last-write-wins），框架照常跑 ——
但**第一次**用这个 store 时会打一条**一次性**提示（每个 store 实例一次），说明「同 keys 的并发
回写丢写不会被发现」，让装配的人自己决定要不要补 CAS。框架**检测不了**没有版本号的覆盖：
这不是「暂时不查」，是没有依据可查。
`InMemoryMemoryStore` 已带版本号（**整店一个单调计数**，粒度粗 ⇒ 宁可多报冲突，也不漏报真实覆盖）。

#### MCP 桥与连接器（MCP 是「工具来源」，不是新机制）

| API | 说明 |
|---|---|
| `mcpTools` | 把 MCP server 的 `tools/list` 映射成框架 `AgentTool[]`（进 `createApp({ tools })`） |
| `McpClientLike` | 最小结构面：`listTools()` + `callTool(name, args, opts?)`（`opts` 带 `abandoned` 与 SEP-414 的 `traceparent`，均可选）；框架**不 import** MCP SDK |
| `createStdioMcpConnector` | **出厂 stdio 连接器**：spawn 一个 MCP server 子进程，走换行分隔 JSON-RPC（只用 `node:child_process`） |
| `createStreamableHttpMcpConnector` | **出厂 StreamableHTTP 连接器**：一个 endpoint POST JSON-RPC；`application/json` 与 `text/event-stream` 两种响应都接（只用全局 `fetch`） |
| `McpConnector` | 两个连接器的公共面 = `McpClientLike` + `close()`。自己写传输时实现 `McpClientLike` 即可，不必碰它 |
| `MCP_DEFAULT_TIMEOUT_MS` | 桥的**兜底**单次调用超时（60000 ms）—— 引擎设了 `toolTimeoutMs` 时**不参与**判定 |
| `MCP_CLOSE_GRACE_MS` | `close()` 里 SIGTERM → SIGKILL 的宽限期（2000 ms） |

- **名字**：`prefix + 归一化原名`（MCP 名里的 `-` / `.` / 空格 → `_`）。归一化后**空名（原名不含任何 ASCII 字母/数字/下划线时产物为空，如全 emoji 名）/ 撞名 / 超 64 字符**一律**装配期抛错**（静默改名会得到一个调不回去的名字，比启动期报错难查得多）。
- **原名**：每次调用写进发起 turn 的两条 attribute —— `mcp.tool.<菜单名>`（每次调用各一条，并行调用互不覆盖，审计 / 回放靠它把菜单名还原成 server 认识的原名）与 `mcp.tool`（本次 turn **最近一次**的原名，兼容既有查询）。
- **入参 schema**：MCP 的 `inputSchema` 已是 JSON Schema → 原样透传，由 engine 的子集校验器在 `callTool` **之前**校验（非法入参根本不会发给 server，模型自己会改）。
- **失败**：`callTool` 抛错 → 该条 `tool_result` 记 `is_error`，**不杀 run**（与本地工具抛错同语义）。⚠️ **协议层的 `isError: true` 框架看不见** —— 连接器必须转成抛错，否则模型以为成功了（出厂连接器已代你处理）。
- **超时**：**只有一个裁判**。引擎设了 `toolTimeoutMs` 时，桥的 `timeoutMs`（缺省 `MCP_DEFAULT_TIMEOUT_MS` = 60000）**不参与判定**；它只在「桥脱离引擎单用」或「引擎没设 `toolTimeoutMs`」时作为兜底。两条路径共用同一判定（`core/timeout.ts`：**看实测耗时，不看竞速**），超时都记 `errorKind='timeout'` + `is_error` 回模型、**不杀 run**。你自己写的工具要报超时，抛一个 `code === 'timeout'` 的错误即可（不必 import 框架的类）。
- **连接器出厂自带，但仍只给缝**：两个连接器只用标准库（`node:child_process` + 全局 `fetch`）⇒ **不新增任何第三方依赖**。要接官方 SDK / 远程 server / 自研传输，实现 `McpClientLike` 两个方法即可（同 `RedisLike` 的形状）。
- **连接器替你兜住三件只有它能做的事**：① spawn 失败（命令不存在 → `ENOENT`）是**异步 `'error'` 事件**，不接住会把宿主进程带崩；② stdout 的分帧 —— 一条报文可能跨多个 chunk；③ **协议层 `isError: true` 转成抛错**。
- **trace 上下文（SEP-414）**：在 run 内调用时，桥把当前 span 的 W3C `traceparent` 放进 `tools/call` 的 `params._meta`（**裸键、不加前缀**；两个出厂连接器都做），认出它的 server 就能把这次调用链回你的 trace；不在 run 内（桥脱离引擎单用）则不带 —— 不造空上下文。自己实现 `McpClientLike` 时读 `callTool` 第三参的 `traceparent` 即可对齐（不读也兼容，只是链路断在你的传输上）。
- **连接器的 `timeoutMs` 只管装配期**（握手 + `tools/list`）：那两步**没有任何别的裁判**，server 卡住会让 `createApp` 永久挂起；`callTool` 的裁判仍是引擎 / 桥（一次调用只有一个）。

```ts
// 出厂连接器：stdio（spawn 子进程）
const mcp = createStdioMcpConnector(['uvx', 'mcp-server-time']);
const tools = await mcpTools(mcp, { server: 'time' }); // → mcp_time_get_current_time …

// 远程 server：StreamableHTTP
const remote = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
  headers: { authorization: 'Bearer …' },
});
const remoteTools = await mcpTools(remote, { server: 'remote' });

// 也可以用你自己的传输：任意实现了 listTools/callTool 的对象都能接（duck-typed，无需继承）
const mine = await mcpTools(myOwnConnector, { server: 'time' });

// 与本地 @Tool 同池：同过中间件链、同进重名查重
const app = createApp({ system, providers: [...], tools });
```

#### `McpToolsOptions`（`mcpTools` 的选项）

| 字段 | 说明 |
|---|---|
| `prefix` | 工具名前缀；缺省 `mcp_<server>_`（没给 `server` 时 `mcp_`）；`''` = 不加前缀（撞名自负） |
| `server` | server 标识，只用于拼缺省前缀（不会发给 server） |
| `timeoutMs` | 单次 `callTool` 超时（毫秒）；缺省 60000，非正数 = 不限 |

#### `StdioMcpConnectorOptions`（`createStdioMcpConnector` 的选项）

| 字段 | 说明 |
|---|---|
| `env` | 追加 / 覆盖的环境变量（缺省继承 `process.env`） |
| `cwd` | 子进程工作目录 |
| `stderr` | 子进程 stderr 去向：`'inherit'`（缺省，server 日志直通终端）或 `'ignore'` |
| `clientInfo` | `initialize` 握手要发的 `{ name, version }`（协议要求存在） |
| `protocolVersion` | 请求的协议版本，缺省 `2024-11-05` |
| `timeoutMs` | **装配期**超时（握手 + `tools/list`），缺省 60000，非正数 = 不限 |

#### `StreamableHttpMcpConnectorOptions`（`createStreamableHttpMcpConnector` 的选项）

| 字段 | 说明 |
|---|---|
| `headers` | 附加请求头（鉴权等）；会覆盖缺省的 `content-type` / `accept` 同名字段 |
| `clientInfo` | 同 stdio |
| `protocolVersion` | 请求的协议版本，缺省 `2024-11-05`；协商结果以 server 回的为准 |
| `timeoutMs` | **装配期**超时（握手 + `tools/list`），缺省 60000，非正数 = 不限 |
| `onSessionExpired` | 会话过期自愈时被调一次（见「已知边界」）—— 要计数 / 告警 / 打日志就挂它 |
| `fetchImpl` | 注入 `fetch`（测试用；缺省全局 `fetch`，与 `createOpenAIClient` 同款） |

#### MCP 反向桥（把能力菜单暴露成 MCP server）

正向桥是「接进来」（`mcpTools` 把外部 server 的工具接进菜单）；反向桥是「**暴露出去**」：
`createMcpServer(app, opts)` 把 `app.tools`（装配后、过了中间件的那份菜单）变成一个 MCP
server —— Claude Code / Cursor / 任何 MCP 宿主都能直接调你的 `@Tool`。`app` 入参是鸭子类型
（`AgentApp` 结构满足），也可以手拼 `{ tools: [...] }`。

| API | 说明 |
|---|---|
| `createMcpServer` | 把能力菜单暴露成 MCP server（协议范围**只到 tools**：`initialize` / `notifications/initialized` / `tools/list` / `tools/call`，另有 `ping`；其余 method 一律 -32601，params 形状坏 -32602） |
| `McpServerApp` | `app` 入参的鸭子类型：`{ tools: AgentTool[] }` |
| `McpServerOptions` | 传输与行为选项（见下表） |
| `McpServer` | 返回句柄：`url`（http 模式的实际 endpoint；stdio 为 `undefined`）/ `ready` / `close()`（幂等，中止在飞调用的 signal；自有 server 才关，挂进来的只摘 handler） |

- **两个传输都只用标准库**：stdio = stdin/stdout 换行分隔 JSON-RPC（日志只去 stderr，stdout 是协议面）；http = StreamableHTTP（POST 收报文、应答 `application/json`，简单应答不上 SSE；GET → 405、DELETE → 200）。
- **trace 叙事不破**：每次 `tools/call` 造一棵 trace —— run 根 `mcp.tools/call` 下挂一个 capability span（name = 工具名），记 `tool.input` / `tool.output` 事件（与引擎同账目形状），收尾投递 `sinks`；`initialize` / `tools/list` 不建 trace。capability span 无 skill/subagent 属性 ⇒ metrics 里以 `capability:<工具名>` 标签进能力指标。
- **入站 trace 上下文（SEP-414）**：`tools/call` 的 `params._meta.traceparent` 合法时记成那棵 trace run 根的一条 `links`（与 HTTP 宿主认 `traceparent` 头同款缝合）；缺失 / 畸形静默当作孤立根 —— 不报错、不影响调用成败、不造空上下文。对端是 agentia 正向桥（或 MCP Python SDK 等已按 SEP-414 注入的实现）时这条链自动接上。
- **结果映射与正向桥方向对称**：工具返回 string → `content: [{ type: 'text', text }]`，其他 JSON 化进 text；抛错 → 协议层成功 + `isError: true`（MCP 惯例；正向桥的连接器正好把 `isError` 转回抛错）。
- **取消是协作式**：客户端断连 / `close()` 会中止该次调用的 `ToolRunContext.signal`；`toolTimeoutMs` 与引擎同款语义（非正数 / 不设 = 不限；超时 = **放弃等待** + abort `abandoned`，该次调用回 `isError`，server 不挂）。
- **默认 client 是惰性构造的**：`client` 不给时第一次 `tools/call` 才走 `createAnthropicClient()`（与引擎默认同款）—— 纯工具 server 不需要 API key 在场。
- **想看一个真用它干活的例子**：`examples/observability-mcp/` 把 `buildRunReport` / `diffTraces` 包成两个只读工具（`report_trace` / `diff_traces`）暴露给任意 MCP 宿主，让 agent 自己查「我上一轮慢在哪」；还带一条**实边界**（工具参数由模型给 ⇒ 只读 trace 根内的文件，realpath 比前缀），以及一条端到端的验收脚本（起真 server ⇐ 出厂连接器 + `mcpTools`）。

```ts
import { createMcpServer, jsonlTraceSink } from '@migor/agentia';

// stdio（Claude Code / Cursor 这类宿主：它们 spawn 这个进程）
createMcpServer(app, { transport: 'stdio', sinks: [jsonlTraceSink({ path: 'mcp-trace.jsonl' })] });

// http（服务形态）：port 0 = 系统分配，读返回值的 url 拿实际端口
const mcp = createMcpServer(app, {
  transport: 'http',
  port: 8787,
  auth: (req) => {
    // 只给缝：token/JWT 策略是你的（与 createHttpHandler 的 authenticate 同纪律）
    if (req.headers['x-api-key'] !== expected) throw new Error('bad key');
  },
});
await mcp.ready;
console.log(mcp.url); // http://127.0.0.1:8787/mcp
```

#### `McpServerOptions`（反向桥的选项）

| 字段 | 说明 |
|---|---|
| `transport` | `'stdio'` / `'http'`（必填） |
| `host` | http 监听地址，缺省 `127.0.0.1` |
| `port` | http 监听端口，缺省 `0`（系统分配）；自带 `server` 时无效 |
| `path` | http endpoint 路径，缺省 `/mcp` |
| `server` | 挂进**既有** `http.Server`（框架不替它 listen；`close()` 只摘本 handler 不关它）。非本 `path` 的请求本 handler 直接忽略（交给宿主自己的路由） |
| `client` | 进 `ToolRunContext.client`（子 agent / skill 类工具要它拉子循环）；缺省惰性 `createAnthropicClient()` |
| `sinks` | trace 出口：每次 `tools/call` 收尾投递（抛错被吞 + `console.warn`，观测不击穿业务） |
| `traceLimits` | 每次 `tools/call` 那棵 trace 的事件数闸（与引擎 `traceLimits` 同款：超限停记 + run 根留 `trace.truncated` 簿记；缺省 = 不限；坏值构造期抛 TypeError） |
| `maxEventChars` | 事件正文截断上限（与引擎 `maxEventChars` 同款；`false` = 不截断；缺省 = 引擎缺省） |
| `toolTimeoutMs` | 单次 `tools/call` 的工具执行超时（毫秒），语义与引擎 `toolTimeoutMs` 同款；非正数 / 不设 = 不限 |
| `auth` | http 侧鉴权钩子：在读 body 之前调用，抛错即 401（原文只进服务端日志）；stdio 侧信任父进程、本项不生效 |
| `name` | `serverInfo.name`（握手回给客户端），缺省 `'agentia'` |

#### evals（把 mockClient 提升为一等能力）

| API | 说明 |
|---|---|
| `scriptedClient` | 按脚本依次返回模型响应（**真把文本块经 `on('text')` 吐出去**）；脚本耗时报错 |
| `defineEval` | 定义「用例 + 断言」，`run()` 返回 `EvalReport` |

- **为什么需要**：单测覆盖的是框架语义，evals 覆盖的是**你的 agent 语义** —— 改 prompt / 换模型 / 加工具之后有没有回归，靠断言而不是人眼。
- 断言源是既有 `Trace`：「先 `search` 才 `summarize`」这类顺序断言全从 trace 读，框架不为此新增埋点。
- `run()` **不抛**（用例失败进报告，一次跑完能看到所有回归，而不是修一个跑一次）；只有「应用建不起来」才冒泡 —— 那是环境错误，不是回归。失败 case 带 `trace`，直接看现场。
- `scriptedClient` 的步骤**在 `finalMessage()` 成功返回后才前进**：抛错的步骤（函数步骤 `throw` 模拟 429）会在重试时**重放同一步**，想验重试就这么写。
- **脚本消息要带 `usage`，否则记账全 0**：脚本是模型响应的线缆形状，`usage` 用 snake_case 四字段 —— `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`（缺了的字段按 0 计）。整个 `usage` 缺省**不报错**，但该回合的 token 与成本记账为 0 —— 想在 eval 里演示 `maxTotalTokens` / `maxCostUsd` 护栏时，护栏会永远「不触发」。现成形状见 `tests/helpers.ts` 的 `U`。
- **用例结论自动落 score**：每个用例跑完，结论以 `{ name: 'eval', value: 0|1, source: eval 名, comment: 失败原因 }` 自动 `attachScore` 到该用例的 trace —— eval 的 trace 自带质量结论，下游 sink / `metricsSink` 可直接聚合「这个 eval 的通过率」（`app.run` 抛错拿不到 trace 时不挂）。

```ts
const ev = defineEval<{ summary: string }>({
  name: 'doc-review',
  app: () => createApp({ system: new SystemPrompt({ version: 'v3' }).add('role', R), providers: [...] }),
  // 每 case 可带 opts（透传 app.run）：注入 resultSchema 就能断言 result.typed
  cases: [{ name: '先检索再总结', input: '总结这份文档', client: scriptedClient([searchMsg, submitMsg]) }],
  expect: (r, { trace }) => {
    assert.equal(r.stopReason, 'end_turn');
    const order = trace.spans.flatMap((s) => s.events)
      .filter((e) => e.name === 'tool.input')
      .map((e) => (e.body as { tool: string }).tool);
    assert.deepEqual(order, ['search', 'summarize']); // 顺序断言从 trace 读
  },
});
const report = await ev.run();
if (!report.ok) console.error(report.cases.filter((c) => !c.ok));
```

#### 线上 trace 回流 eval 数据集（`agentia harvest`）

线上事故 → 回归用例：CLI 把 trace 落盘文件翻成 eval 用例脚手架。

```bash
agentia harvest trace.jsonl                    # 全部记录 → 脚手架打到 stdout
agentia harvest trace.jsonl --failed --limit 5 --out evals/harvested.ts
agentia harvest trace.jsonl --out evals/harvested.ts --force   # 覆盖已存在的产物（默认拒绝）
```

- 输入同 `agentia report`：每行一个 JSON（裸 Trace，或含 `result.trace` / `trace` 的 TaskRecord，如 `FileTaskStore` 的导出）；`--failed` 只留失败记录。
- 产物是**可粘贴进 eval 文件的用例字面量**：`client: scriptedClient([...])` 按 trace 的主循环 llm.turn 逐回合重建，`expect` 预填「主循环工具序列」的轨迹断言（文件顶部附跑法注释）。
- `--out` 指向已存在的文件时**默认拒绝覆盖**（产物是要人工核对的脚手架，重跑一次就抹掉你改过的断言与 input）；要覆盖显式加 `--force`。
- ⚠️ **脚手架不是成品，人工核对后再进 CI**：
  - **trace 不记 assistant 文本**（llm.turn 只记 usage/事件），脚本里的 text 块是占位 `'[harvest] assistant 文本未入 trace'`；
  - 只重建**直属 run 根**的主循环回合 —— 子 agent 的嵌套回合不走主循环脚本（要覆盖子 agent 请单独写 eval）；
  - 预填的 `expect` 是从原 trace **抄录的实际轨迹** —— 发生过 ≠ 应该发生；
  - `EvalCase` 没有 `expect` 字段，粘贴时把断言搬进 `defineEval({ expect })`（脚手架注释会教）。

#### trace → 训练数据集（`agentia export`）

harvest 的孪生（R8-P3b）：harvest 产**回归用例**，export 产**训练数据**（JSONL，一行一份
`{ messages, meta }`）。配 `traceContent: 'full'`（§4）跑出来的 trace 导出的是带真 assistant
文本的完整对话；没开的导出工具轨迹（text 块缺席**不造占位** —— 占位文本进训练数据是投毒）。

```bash
agentia export trace.jsonl                                # 全部记录 → JSONL 打到 stdout
agentia export trace.jsonl --ok-only --min-score 0.8 --out dataset.jsonl
```

- 输入同 `agentia report` / `harvest`；`--min-score` 按 run 根 score 事件的最大值过滤
  （**没带分数的 run 在此过滤下被排除**：没判过 ≠ 及格）；`--ok-only` 只留 status ok。
- 每条记录的 `meta.incomplete` 如实标注缺口，值是机器可 grep 的固定词：`input` = 原始输入
  未入 trace（首条 user 恒为占位）；`assistant-text` = 模型正文缺席（终端回合没记到，
  或**整棵 trace 一行正文都没有**且本 run 没开 `traceContent` —— 后者连混合回合的真文本
  也拿不回来）；`no-final-assistant` = 末条是 user，**这条样本没有 loss 目标**（半截 run /
  只剩工具往返；`--ok-only` 挡不住它 —— status ok ≠ 有终答）。`meta.nestedTurns` 记略去的
  子 agent 嵌套回合数（它们不进主线 —— 其能力出参已在主线的 tool_result 里）。
- 缺输出的 tool_use 补 is_error 占位块（协议要求配对合法）；有输出配不上对的计数进
  `meta.droppedOutputs`，不静默丢。

#### prompt / 模型 A/B（trace diff 与分叉重放）

同一份输入跑两条 run（换模型、换 `SystemPrompt` 版本、换 prompt 都行），用 `diffTraces` 比出**结构与成本差**；
想「从第 3 回合换个问法重跑」，用 `forkMessages` 在分叉点截断、拼上新消息喂回 `app.run`：

```ts
import { diffTraces, forkMessages } from '@migor/agentia';

// A/B：同输入，只换模型（或换 system 版本），各跑一条
const a = await app.run(input, { model: 'claude-sonnet-5' });
const b = await app.run(input, { model: 'claude-opus-5' });

const diff = diffTraces(a.result.trace, b.result.trace);
// diff.summary：status / totalUsage.* / 根 attributes 差 —— A/B 模型第一眼就看 attributes.model
// diff.spans：逐 span 字段级差异，path 形如 run:main/llm.turn#0/capability:search
if (!diff.equal) console.log(diff.summary, diff.spans);

// 分叉重放：在主循环第 3 回合（0-based）之前截断，该回合及其后丢弃，换个问法继续
const messages = forkMessages(a.result.trace, {
  atTurn: 3, // 合法范围 0..主循环回合数-1，越界抛可读错误
  append: [{ role: 'user', content: '换个思路：先给结论，再补证据。' }],
});
const c = await app.run(messages); // 起一条新 run，沿着分叉点前的真实 tool 历史继续
```

不落代码也可以直比两份 trace 导出：`agentia diff a.jsonl b.jsonl`（输入形态同 `agentia report`），
打印 run 级 summary + 逐 span 差异，**有差异时退出码 1**（diff(1) 语义）——可直接进 CI 挡
「换 prompt / 模型后轨迹漂移」。`--json` 给出结构化差异（`{ a, b, equal, summary, spans }`，
每个 span 带 `path` / `missing` / `fields`），**退出码语义不变**（有差异仍为 1）—— 门禁照旧可用，
只是「差在哪」也能被读。`agentia doctor --json` 同理（体检结果结构化，有错误仍退出 1）。

> `report` / `diff` / `doctor` 支持 `--json`；`harvest` / `export` **没有**：它们的 stdout
> 本身就是产物（生成的 eval 文件源码 / 训练数据 JSONL），加 `--json` 会自相矛盾。

- **配对语义**（结构性配对，字段差异不影响配对）：llm.turn 按回合序配对、**忽略 span name** ——
  name 是模型 id，而「换模型重跑」正是 A/B 主用例，按 name 配对会把两侧所有 turn 报成缺失；
  模型差异降格为配对 turn 的 `name` 字段差。capability span 按 `kind:name` 配对
  （`skill:foo` vs `skill:bar` 是不同能力，不该配上）。一侧多出的调用树记**一条缺侧记录**
  （`SpanDiff.fields` 为空、`path` 照给），整支子树不再下钻。
- **墙钟缺省不比**：`ignoreTiming` 缺省 true（A/B 不关心时序）；传 `false` 改比 span 时长
  （`duration`），绝对时间戳永不比；`traceId` 是身份不是行为，同样永不比。
- ⚠️ **有损边界（与 `traceToMessages` / harvest 同源）**：trace **不记 assistant 文本与 run 的
  原始输入** —— 重放里 assistant 是标注占位（非逐字原文）、首尾说明性 user 是合成。
  因此 `forkMessages` **不是「续跑」**：它产出的是一份喂回 `app.run` / `runAgent` 的 messages，
  跑的是一条**新 run**，不是接着原 run 的循环位置。分叉的 blackboard 种子由调用方自带
  （`app.run(messages, { blackboard: {…} })` —— trace 不记 blackboard）。

### 6.6 横切缝（框架只给缝，不建子系统）

以下五件事策略千差万别（正则 / 分类模型 / 外部审核 API / 你自己的配额口径），框架硬编码必错 —— 所以只给缝，每节给出可直接粘贴的拼法。

#### 在线评估采样

生产流量按 N% 采样跑 LLM-judge、把分数回挂 trace —— 用**现有 sink 机制**拼：采样（`examples/observability` 的 `sampleSink` 配方）+ 对抽中的 run 调一次 judge（一次 `app.run` 或裸 client 调用）+ `attachScore` 回挂 + `metricsSink` 聚合。框架不提供 judge 子系统 —— 评什么、用什么模型评、采样率多少，都是你的策略：

```ts
import { attachScore, createAnthropicClient, metricsSink } from '@migor/agentia';
import { sampleSink } from '@migor/agentia-observability'; // examples/observability

const metrics = metricsSink();
const judge = createAnthropicClient(); // judge 也可以就是同一个 app 的一次 run

const onlineEval = sampleSink({
  rate: 0.05,                      // 抽 5%（失败 run 永不采样掉，见 observability.md 配方 2.3）
  sinks: [{
    async export(trace) {
      // 你的 judge：读 trace 给个 0–1 分（一次 app.run / 裸 client 调用随你）
      const { value, comment } = await runMyJudge(judge, trace);
      // 回挂到这条 trace 的根 span：score 事件 → OTLP gen_ai.evaluation.result / metrics agentia_score
      attachScore(trace, { name: 'faithfulness', value, source: 'judge:claude-opus-5', comment });
    },
  }],
});

createApp({ /* … */ sinks: [onlineEval, metrics] }); // metrics 必须同链，才聚合得到分
```

- 顺序要紧：**judge sink 在 `metricsSink` 之前**，分数事件才进指标（sink 数组顺序即投递顺序）。
- judge 本身的 run 也会产生 trace —— 给它单独一个 app / runName，或按 run 名在 judge sink 里跳过自己，避免「评估评估的评估」。
- 成本自控：judge 调一次模型就是一份钱，采样率与 judge 模型档位是你的旋钮（judge 的 run 同样受 `maxCostUsd` 等护栏约束）。

#### 多租户配额

框架不提供配额组件 —— 用 `middleware`（拦在能力调用前）+ `TraceSink`（收尾后记账）+ `BudgetGuard`（单次 run 上限）组合即可，存储与策略是你的事：

```ts
declare module '@migor/agentia' { interface Blackboard { tenant: string } }

const spentTokens = new Map<string, number>(); // 真实场景换成 Redis / DB
const TENANT_LIMIT = 200_000;

const quota: CapabilityMiddleware = async (call, next) => {
  const tenant = RunContext.current()?.get('tenant');
  if (tenant && (spentTokens.get(tenant) ?? 0) >= TENANT_LIMIT) {
    throw new Error(`租户 ${tenant} 的额度已用满`); // → 该条 tool_result 记 is_error，不杀 run
  }
  return next(); // 额度内放行
};

const billing: TraceSink = {
  export(trace) {
    const tenant = RunContext.current()?.get('tenant'); // sink 在 run 的 async 上下文里投递，读得到黑板
    if (!tenant) return;
    const u = trace.totalUsage;
    spentTokens.set(tenant, (spentTokens.get(tenant) ?? 0) + u.inputTokens + u.outputTokens);
  },
};

createApp({ system, providers: [...], middleware: [quota], sinks: [billing] });
// 单次 run 再有上限就叠加 C1：app.run(msgs, { maxTotalTokens: 50_000 })
```

- 拦下来的那次 run **仍然要记账**（模型的钱已经花了）—— 记账在 sink 里、拦截在 middleware 里，两者独立。
- 被拦下的能力**不会执行**（副作用不发生），但 run 继续跑（模型可以换路）。

#### 人工审批

两种形态，按「人什么时候在场」选：

**A. 进程内闸门（middleware）** —— 审批方能被一次 `await` 等到（同进程回调 / 短等待）时用，
不需要任何新机制 —— `middleware` 可以 `await` 决策再放行，引擎会等工具结果
（`Promise.resolve(tool.run(...))`）：

```ts
const DANGEROUS = new Set(['send_email', 'deploy', 'delete_records']);

const requireApproval: CapabilityMiddleware = async (call, next) => {
  if (!DANGEROUS.has(call.capability.name)) return next();
  const ok = await askHuman(call.capability.name, call.input); // 在这里 await —— run 就地停着等人
  if (!ok) throw new Error(`调用 ${call.capability.name} 未获批准`); // → tool_result 记 is_error，run 不中断
  return next();
};

createApp({ system, providers: [...], middleware: [requireApproval] });
```

三种结局都有对应写法：

- **放行**：`next()`；**拒绝**（副作用不发生）：不调 `next()` —— 短路；**拒绝并让模型改道**：抛错 → 该条
  `tool_result` 记 `is_error`，模型换路，run 不中断。
- 决策依据随你：`call.capability.name` / `call.input`，或在中间件里 `RunContext.current()?.get('…')` 读黑板
  （ALS 传播，见上一节）。
- 等待不会被默认掐断（`toolTimeoutMs` 缺省 0 = 不限）；真设了它，注意别把人的思考时间算进去。

**B. 挂起式审批（HITL，跨进程耐久）** —— 审批在**另一个系统**里发生（工单 / IM / 后台台帐），
可能要等几小时甚至跨进程重启时用：给工具声明 `approval: 'required'`，模型每次调用它都会把
任务**挂起**，等决定到达后从断点恢复。

```ts
class DeployTools {
  @Tool({ description: '部署到生产环境', schema: deploySchema, approval: 'required' })
  async deploy(input: DeployInput) { /* … */ }
}
```

流程（异步任务宿主）：

1. `POST /tasks` 提交任务；模型调到 `deploy` 时 run **挂起**：任务状态变
   `suspended`，**整个回合一个工具都不执行**（全有或全无 —— 协议要求每个
   tool_use 配对 tool_result，部分执行 + 部分挂起会产出配不平的历史）。
2. 轮询 `GET /tasks/:id` 看到 `status: 'suspended'` + `pendingApprovals`
   （待决的 tool_use_id 列表）+ `spec.messages`（完整消息历史，末尾是含未决 tool_use
   的那条 assistant 消息）。挂起**不占并发槽**、不算终态（`awaitTask` 继续等）、
   `resumePending` 不会把它当孤儿捡走。
3. 人批了：`POST /tasks/:id/approve`，body
   `{ decisions: { '<tool_use_id>': { approved: true } }, decidedBy: 'alice' }`
   （或直接 `runner.approve(taskId, decisions, { decidedBy })`）。**逐 tool_use_id 幂等**
   （第一次决定赢，重复提交不推翻）。决定**随任务落库**（`TaskRecord.approvals`，
   进程重启不丢）；待决集合齐了任务自动恢复执行。
4. 恢复时：**批准**的工具正常执行（工具体内经 `ToolRunContext.approval` 读到自己的决定 —
   谁批的、什么时候、什么理由）；**拒绝**的工具得到 `tool_result(is_error: true,
   content: '审批被拒绝：…')` —— 理由回给模型，可自行换路。恢复后再遇未决审批 ⇒
   再次挂起（可等多轮）。

##### `ApprovalDecision`（审批决定）的字段

| 字段 | 说明 |
|---|---|
| `approved` | `true` = 批准执行；`false` = 拒绝（tool_result 记 `is_error`） |
| `reason` | 拒绝理由 / 备注（回给模型） |
| `decidedBy` | 审批人标识（审计用） |
| `decidedAt` | 决定时刻；缺省由框架在收到决定时填 |
| `requestedAt` | 挂起时刻（框架回填；trace 的 `approval.decided` 事件据此算 `waitedMs`） |

观测与兜底：

- trace：挂起段在发起回合的 turn span 记 `approval.requested`（带待决 id 列表）；
  恢复执行时记 `approval.decided`（带 tool_use_id / approved / decidedBy / reason /
  waitedMs）。**挂起段与恢复段是两棵独立的 trace**，恢复段经根 span 的 `links` 挂到
  上一段 runId（跨段关联不断链）；挂起段的 trace 照常投递 sinks（「任务为什么在等」
  必须可观测）。
- 超时兜底：`new AsyncRunner(app, { approvalTimeoutMs })`（缺省 0 = 一直等）。**惰性判定，
  不起定时器**：`approve` / `poll` / `resumePending` 读到一个挂起已超过该值的任务时，
  自动把全部待决项写成「拒绝：审批超时」并恢复执行（模型收到理由、任务走向终态）。
  没人读的任务不会自己超时 —— 要定期扫就靠 `resumePending()`。

**已知边界**（也收录在 §7）：见 §7 表的「审批」相关行。

#### 时间挂起（睡到某个时刻，durable timer）

与「人工审批」是**同一套挂起骨架的两种原因**：审批 = 执行**前**等一个人的决定，
时间挂起 = 执行**中**等一个时刻到来。差别决定了用法：

- 审批由**宿主**在执行前给决定（`approval: 'required'` 的工具，`args.approvals` 里没有决定
  就整回合挂起、一个工具都不跑）；
- 时间挂起由**工具自己**在跑的时候提出来 —— 所以那个回合的工具**已经跑过了**（见下面的整批语义）。

```ts
import type { AgentTool } from '@migor/agentia';

const waitForBatch: AgentTool = {
  name: 'fetch_daily_report',
  description: '取当天的批处理报表（没跑完就到明天早上再问）',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_input, ctx) {
    const due = await nextBatchWindow();          // 你自己的判据（外部系统回填 / 限流窗口 / 收盘）
    if (due.getTime() > Date.now()) {
      ctx?.deferUntil?.(due);                     // 「现在还不是时候，T 之后再问我」
      return 'deferred';                          // 返回值会被丢弃（见整批语义）
    }
    return await fetchReport();
  },
};
```

宿主侧（`AsyncRunner`）：引擎把该回合收尾成 `stopReason: 'suspended'` +
`suspendedReason: 'timer'` + 目标时刻，任务落库为 `status: 'suspended'`、`wakeAt` 进
`TaskRecord`（**活得比进程久**）。到点由 `resumePending()` / `poll()` 的**惰性**扫描唤醒
（与审批超时同一套纪律：不起定时器、不养在飞回调），醒来后**重跑那一批**工具、拿到结果接着跑。

三条要写进心里的：

1. **时刻必须是将来**：`deferUntil` 传非有限数或 `≤ 现在` 会**当场抛 TypeError** ——
   该条 `tool_result` 记 `is_error`、run 照常往前走（模型能看到「时刻必须在将来」并自己换路）。
   这不是苛刻：允许过去时刻就等于允许「醒来 → 再请求同一个过去时刻」**自己打转**。
2. **整批语义（副作用会重复）**：挂起是回合级的（协议要求每个 `tool_use` 都有配对
   `tool_result`），所以同回合**已经执行完**的其他工具会在醒来后**重跑**一遍。框架把它
   变成看得见的：trace 记 `defer.requested`（`{ wake_at, tool_use_ids, discarded }`），
   真有兄弟工具被作废时落一条 `console.warn`。**要精确控制就让模型单独调这个工具，或者把它
   做成幂等读。** 同回合多条请求取**最早**的那个时刻。
3. **停机与可见性**：`drain()` 之后**不再唤醒**睡着的 run（停机 = 不再往前推，否则部署要等一条
   天级任务）；重启后由新进程的首次 `resumePending()` 唤醒。`GET /healthz` 的
   `suspended: { approval, timer, nextWakeAt }` 就是运维要看的那半（口径 = **本进程**看得见的
   记录；无时间挂起时 `nextWakeAt` 是 `null`，不是 `0`）。

**取消**：`runner.cancel(taskId)` / `POST /tasks/:id/cancel`（见 §6.6 与上面的路由表）——
对一条在睡的 run 调 `cancel` 就是「不再醒」的合法出路（落终态 `cancelled`，两条唤醒闸
随之失效）。对一条 `timer` 挂起调 `approve()`
会回 409（原因不对，不是状态不对）。

**已知边界**：`resumePending()` 的扫描是 **O(全表)**（挂起读数重建 / 审批超时 / 孤儿认领
三条职责的输入仍是全表）；其中「到期唤醒」那一半在 **sqlite** 上走 `listDue` 到期索引
（派生列 + `(status, wake_at)` 索引，O(到期数) 而不是 O(全表) —— 实测 10k 记录：
全表 list ~38ms vs listDue ~0.1ms；file / memory store 的 list 本来就在内存里，不实现）。
`wakeAt` 到点后**必须有人读**才会醒（没人调 `resumePending()` / `poll()` 的宿主里，
任务不会自己动 —— 与审批超时同一条纪律）。

#### 事件投递（run 事件投入口：webhook / 外部系统叫醒一条挂起的 run）

审批是「人等决定」的特例；**事件投递**是一般形：外部系统（webhook、另一个模块、定时
巡查脚本）把一条**事件**投给一条挂起的任务，任务醒来时事件进消息历史。

- 入口两个（与 approve/cancel 对称）：宿主方法 `runner.signalTask(taskId, event)` 与
  `POST /tasks/:id/events`。事件体是**白名单** `{ eventId?, type, payload }` ——
  **全是字符串**，多一个字段即 400。这是外部输入第一次进入消息历史：外部永远不能构造
  消息块（投毒面只到「内容注入」为止），事件由引擎渲染成**一条 user 文本消息**，
  在未决 tool_use 解决之后注入（直接追加到历史末尾会破坏续跑判定，见 spec §10 ⑥）。
- **只对挂起生效**：任务不存在 → 404；不在 `suspended` 状态（含已终态）→ 409。
  投完即续跑（先落库再派发：崩在窗口里不丢事件）；对 timer 挂起这就是**提前醒**
  （不沿旧 `wakeAt` —— 醒来重跑那一批时工具可以重新 `deferUntil` 落定新时刻）；
  对审批挂起，决定仍不齐就再挂起（零模型调用），事件留在 `TaskRecord.pendingEvents`
  里等真正跑通的那次续跑注入。
- **幂等**：给了 `eventId` 就按它去重（簿记在 `TaskRecord.deliveredEventIds`，随记录
  落库、有界 FIFO 256 条）—— 同一任务重复投递同一个 `eventId` ⇒ 409。**不给
  `eventId` 就没有恰好一次**：重复投递 = 重复进历史（webhook 重试场景请带上 id）。
- **待注入缓冲有上限（64 条）**：满了 → 409，且**不收下**（「本次事件没有被记录」，与
  「重复投递」（那条本来就在里面）是两种不同的 409）。缓冲在下次跑通时注入并清空 ——
  上限只管「一个挂起窗口里能攒多少」；满了说明该先让这条 run 走起来，而不是拿它当队列。
- **留痕**：注入时续跑段的 run 根记 `task.event` 事件（`{ injected, event_type,
  event_id? }` —— `injected` 的口径是「注入进本段消息流」，**不等于**「模型已看到」：
  该段若在首个模型请求前就中止/失败，事件不进持久化历史，但这条留痕仍成立）；
  离开挂起态时 `/healthz` 的挂起读数照常除名。

**已知边界**：事件由**收到它的那个进程**派发（落库先于派发，所以进程崩了不丢 ——
重启后由 `resumePending` 认领续跑）；事件不进**会话历史**（会话只存对话轮次，
事件属于 run 的内部过程，完整过程在 trace 里）。

#### 内容护栏

和「多租户配额」同一个形状：策略千差万别（正则 / 分类模型 / 外部审核 API），框架硬编码必错，**只给缝**。

| 关卡 | 缝 |
|---|---|
| 入参（run 之前）| 包一层 `app.run`；HTTP 侧用 `createHttpHandler({ authenticate })`，拦在**读 body 之前** |
| 工具调用前 | `middleware`（见上；能短路，也能用 `next(newInput)` 改写入参）|
| 出参 / 结果 | 包返回值，或挂 `sinks: [...]`（`TraceSink`）在收尾处审 |

```ts
const callable = {
  name: app.name,
  async run(msgs, opts) {
    const out = await app.run(redactInput(msgs), opts);      // 入参护栏
    if (flagged(out.result.finalText)) throw new Error('输出被护栏拦下'); // 出参护栏
    return out;
  },
};
```

#### 代码执行隔离

**框架从不执行模型生成的代码** —— `@Skill` 跑的是你写的方法体、`@Tool` 是你写的函数，
模型输出只会变成文本 / `tool_result`。所以「要不要沙箱」等价于「你那个*代码执行工具*要不要隔离」：
在**工具实现内部**做（Docker / 子进程 / 微 VM 随你），框架不参与也不该参与 ——
`AgentTool.run(input) → output` 这个契约把隔离整个挡在实现里。

唯一沾边的一条：工具起了子进程，**取消时要自己 kill**。框架的 `toolTimeoutMs` 是「不等了」，
放弃等待时会 abort `ToolRunContext.abandoned` —— 要能真停，让工具监听它（或读 `ToolRunContext.signal` 响应整条 run 的中止）。

---

## 7. 已知边界（如实标注，不要指望框架替你兜）

| 边界 | 说明 |
|---|---|
| 方法入参要自己标注 | TS 不会从 JSON Schema 反向推断方法形参；`strict` 下不标注会报隐式 any |
| 裸 schema 不校验签名 | 只给 `schema: {...}` 时，schema 与方法签名**互不关联**（要护栏就用 `fromZod<T>`） |
| 黑板键默认无类型 | 不合并 `Blackboard` 就是裸 `string` + `unknown`；动态键需 `as BlackboardKey` |
| 没有「能力清单」类型 | 能力是运行时从装饰器注册表收集的，所以 `app.my_tool()` 这种写法不存在 |
| `strict` 只是透传 | 框架**不校验** schema 的合规性（是否 `additionalProperties:false` 等） |
| schema 校验是**子集** | 只覆盖 `type/properties/required/additionalProperties/enum/items`；`format`/`minimum`/`oneOf` 一律放行 |
| 历史畸形就放弃裁剪 | `trimToolPairs` 遇到非严格交替历史会整体放弃（宁可少裁，也不切出孤立 tool_use 让请求 400） |
| 同键去重的能力边界 | `idempotencyKey` 的去重分三档：**同步 store** 下 `submit` 当场返回既有记录；**异步 store**（Redis / SQLite 等）下 `submit` 是同步门面、无法 await，去重靠**进程内认领表**，只覆盖「**同进程内并发提交**」（2026-09-21 修复前这里会两次都执行）；**跨进程并发**与**终态之后重提同键**仍是 at-least-once —— store 的 idem 索引是 last-wins（重提即新任务，`redisStore` / `fsStore` / `sqliteStore` 头注释同口径）。要严格一次，请让副作用自身幂等（或在 store 层做唯一约束） |
| 增量出口与 sink 是**两条缝** | `onTraceEvent` 是「运行期逐笔」，`sinks` 是「收尾拿整棵」——消费者与保证都不同：sink 的抛错被吞但仍会**投递**（有兜底语义），`onTraceEvent` **不保证送达**（宿主自己的流断了就断了，没有重试/重放）。要「一条都不能少」用 `sinks`；要「现在就看到」用 `onTraceEvent` |
| 任务进度流的边界（内存 / 跨进程） | `GET /tasks/:id/stream` 的事件缓冲在**跑任务的进程内存**里：每任务最近 500 条（可用 `AsyncRunner` 的 `streamBufferEvents` 调，须为正整数，坏值构造期抛错），超限丢**最旧**并先发一帧 `stream.truncated`；终态流只留最近 16 条。**没跑完**的流另有一道**缓冲配额**（`streamNonTerminalBuffers`，缺省 32 条流；`0` = 不留）：超出即从最旧、**没有订阅者**的流开始回收**回放历史** —— 表项与序号都留着，连上来的读者先收一帧 `stream.truncated` 再转实时（**不会**变成 `stream.unavailable`，那是对别的进程说的话）；正在被订阅的流不受配额约束（不抽走正在读的数据）。**跨进程**（队列消费者在别的进程）时没有实时流：发一帧 `stream.unavailable` 后**立即收口** —— 任务已终态则补 `task.end`（随后关连接）；**非终态**则补一帧 `stream.closed`（流级收尾，不是伪造终态）并关连接，客户端此后应转去轮询 `GET /tasks/:id`。要跨进程实时请用 `onTraceEvent` 把事件转发到宿主自己的总线（Redis Streams / Kafka） |
| 异步任务的**排队段**边界（内存） | `concurrency` 管「同时在跑几个」，**不管**「跑不上、排在后面」那一段 —— 缺省**排队段无上限**：`submit` 总是收单、`POST /tasks` 总是 202，灌多少就在内存里排多少（每条 = 一条记录 + 一棵悬挂的 `#execute` promise + 一个槽位等待者）。要背压就配 `AsyncRunner({ maxQueued })`：超限 `submit` 抛 `TaskQueueFullError`、HTTP 回 **503 + `Retry-After`**（**只在 `submit` 判** —— 恢复路径推进的是已受理任务，拦下来等于把它搁死在 store 里；幂等键命中的重复提交也不吃 503）。`runner.queued` 是实时读数（与闸同一判据）。⚠️ 进程内拒单**不等于**集群级背压：多副本各算各的，要全局就得上队列 |
| `traceLimits` 与 `maxEventChars` 各管一头 | `maxEventChars` 管**单个事件正文多长**（既有），`traceLimits.maxEvents` 管**整条 trace 记多少条记录事件**（本版）。两者正交、都「不设 = 不限」；超限即**停止记账**，并在 run 根留**两笔** `trace.truncated`：**起点标记** `{limit}`（断点在这里）+ **收尾摘要** `{droppedEvents, limit}`（丢了多少）—— 两笔**同时**进交付的 trace 与 `onTraceEvent` 增量流（⇒ 按 `seq` 折回仍逐字等于收尾那份；两笔簿记**不占** `maxEvents` 配额）。⚠️ 实测 `maxEventChars: false` + 大出参会让 trace 放大 **13.7×**（`npm run bench:trace` 可复现）—— 先收长度再谈采样，收益顺序比反过来大 |
| 回给模型的 `tool_result` **不截断、也没有大小闸** | `maxEventChars` / `traceContent` 管的是**记账侧**（trace 记多长、记不记正文）—— 回给模型的工具结果**永远完整**，框架里没有「单条工具结果超过多大就裁」的那条缝。一次 `cat` 大文件、一次刷屏回显就能让**下一回合**的输入爆掉上下文窗口，以 api 错误收尾（长跑里尤其容易撞）。要设输出上限请在**工具实现内部**做（按行数 / 字节截断并附「已截断」标记）—— 框架不替你兜 |
| **采样是导出决策，不是记账决策** | 采样在 `sink` 外做（配方见 `docs/observability.md` 2.3）：被采样掉的 trace 在框架内**仍然完整记账**，只是没发给下游。所以别拿「有采样」当「可以少记账」；也正因如此，出站 `traceparent` 的 flags 恒 `00`（记录/导出决策发生在收尾之后，运行期不可知——不替下游声明） |
| 菜单漂移只**标记**、不判失败 | 续跑时未决 tool_use 的工具不在当前菜单 ⇒ 三处信号（`menu.drift` 事件 / 父 span attribute / `console.warn`），run **照常收尾**（那些 tool_use 以 `unknown tool` 回给模型）。**射程如实标注**：判据只看**名字** —— 「工具还在、schema 变了」能被 `tools.menuHash` 比出来，但**不会**在续跑时报 `menu.drift`；**只改 `description`** 连签名都不变（有意：润色文案不算漂移）。严格模式（带具名 error 的收尾）与「结果级字段」记在 spec §11 开放项 |
| `approve` 只收**待决的** id（多一个 → 400 整批拒） | `decisions` 的键必须都在该任务的 `pendingApprovals` 里（调用方从记录的 `pendingApprovals` 读）。多出任何一个 ⇒ **400 + 整批拒 + 记录一字不动**。不校验的代价（已修，2026-09-28 外部深评）：多出来的键会写进 `TaskRecord.approvals`，随每次 `save` 全文重写、且终态也不清 ⇒ 一个**认证调用方**单次请求就能把记录撑大（实证：一次 5000 个无关键 = +419 KB），反复调用可无限叠加 |
| `TaskRecord.approvals` 有界但**不清** | 单次 approve 能写的键被钉在当前 `pendingApprovals` 里 ⇒ 单次输入无法放大体积；跨多轮挂起会累计**历次**待决的并集（每轮都对应真跑出来的模型回合），增长只随真实运行发生 ⇒ 天然有界，**不需要**常量上限；但**终态也不清**（审批记录是审计的一部分）—— 想减负请换 store 的清理/TTL 策略 |
| 缺省内存 store 不淘汰 | 长跑宿主请设 `InMemoryTaskStore({ maxRecords })` 或换 `FileTaskStore` / `SqliteTaskStore` |
| 能力引用两种粒度 | `tools` 写 **provider token** = 整片能力菜单；写 `'<token>/<能力名>'` = 只引单个能力（@Tool/@Skill/@SubAgent/@Prompt 都可点名，装配期校验，名字不存在即抛错并列出可用名单） |
| 能力引用**成环 ⇒ 装配期抛错**（2026-09-28） | `@SubAgent` / `@Skill` 的 `tools` 不得绕回自己（直接自引用，或经另一个 provider 绕回来都算）。为什么必须要拦：`subagentToTool` 的引用解析是**延迟求值**的，环只在**运行期**成立，而 `maxIterations` 只限一回合的**宽度**、深度没有任何闸 ⇒ 模型一次自我调用就无限递归（树按 `宽度^深度` 炸开）。抛错信息给出**环上的节点序列**。没有「深度上限」可以配 —— 这是装配错误，不是运行参数 |
| 能力名有格式校验 | 装饰器能力名（`name` 或缺省的方法名）必须匹配 `^[A-Za-z0-9_-]{1,64}$`（与 MCP 桥同口径），非法名在 `createApp` **装配期即抛错** —— 含空格/点/中文的名字会让模型 API 400，宁可在启动期拦住 |
| `discover` 入口会回落 | 能力目录里源码与编译产物并存（`index.ts` + `index.js`）时，首选 `.ts` 加载失败会**回落 `.js` 并 warn** —— 命中的可能是**陈旧编译产物**（刚改过源码时注意）；全部候选都失败才抛错并列出各自原因 |
| `asset()` 的 rel 必须是相对路径 | 带 scheme（`file:` / `https:` …）的 rel 会让 `new URL(rel, base)` 整个忽略 base（「以为读了能力目录、实际读了别处」），显式抛错；`../` 越出能力目录是**有意放行**（共享资产如 `../../shared/x.md` 是合法用法） |
| 取消要传进客户端才有效 | 传 `signal` 后框架会 abort 在飞请求（内置 Anthropic / OpenAI 适配器都转发）；不转发 `signal` 的自定义 `ModelClient` 只能「放弃等待」（请求在后台跑完、产物丢弃） |
| 默认 client 的真端点验证范围 | `e2e:live` 跑在 DeepSeek 的 Anthropic **兼容**端点上；官方 Anthropic 端点的行为差异（thinking 细节、cache TTL 语义、新块型）目前只有本地假端点测试在守 —— mock 全绿发现不了厂商真实行为 —— 接入官方端点前自己跑一遍 `npm run e2e:live` |
| thinking 块「能收、不主动请求」 | 框架**从不**在请求里开 extended thinking；默认 client 能收拼 thinking 块（`signature_delta` 会累积），`redacted_thinking` 与未知块型**原样透传**不丢 —— 但官方 API 的 thinking 回灌要求带合法 `signature`，自定义 client 开 thinking 时自己验证这条链 |
| 工具阶段的 abort 有盲区 | abort 只在三处被观察：**回合边界 / 在飞模型请求 / 重试退避 sleep**。没设 `toolTimeoutMs` 且工具挂死时，abort 之后 run 也不会返回（工具的 Promise 永不 settle）—— 挂死的工具要么设超时，要么自己读 `ToolRunContext.signal` |
| 观测失败被吞 | sink 抛错不影响 run（观测是辅助动作）；但吞之前落一条 `console.warn`（含「trace sink」字样）—— sink 天天挂不再零信号。同理记忆水合/回写失败也不击穿 run |
| 框架不自动读 .env | 除 `AGENTIA_MODEL`（缺省模型覆盖）与 `OPENAI_API_KEY`（OpenAI 适配器）外，框架自己不去翻环境变量，也不读 `.env`；要读就在启动代码里调 `loadEnvFile()`（脚手架已内置那行），**真实环境变量优先**于文件 |
| 鉴权只是缝 | 框架**不实现** token / JWT / 签名策略，也不碰凭据 env —— `authenticate` 只承诺「拦在入口、读 body 之前」；策略是宿主或反代的事 |
| 运行时是 Node | 按 Node ≥ 18 设计与测试（`engines` 写明；CI 覆盖 18 / 20 / 24 —— `import-floor` 矩阵跑下限、其余 job 跟当前 LTS）；**未对 Deno / edge 做验证**。`SqliteTaskStore` 需 Node ≥ 22.5（`node:sqlite`），未提供时构造期抛可读报错 |
| 停机不由框架触发 | 框架给 `drain()` 但**不订阅** `SIGTERM`/`SIGINT`（不做进程级决策）；信号处理是宿主的 |
| 停机可能切断 SSE | `drain()` 收口时会强制关闭仍开着的 SSE 流，`/run` 的流被收口时其 run 以 `stopReason='aborted'` 收尾（客户端应把断流当作可重试）。**没有 `timeoutMs` 时也收口**（否则等待没有终点，见上）；只关旁观者长连（`/tasks/:id/stream`）**不损失工作**，那种收口不影响 `drain()` 的返回值 |
| 多进程共库：续跑认领靠**租约**，不靠时间（2026-09-28） | `resumePending({ staleAfterMs })` 的 `staleAfterMs` **不是**租约而是**兜底启发式**。`> 0` 时按两档判他进程的记录：① `ownerId` 里的主机名是本机 ⇒ **问那个 pid 还在不在**（`process.kill(pid, 0)`）——**在的绝不抢**（不管记录多老）、**不在的立刻可抢**（崩溃孤儿不等保鲜期）；② **判不了**（异主机 / 升级前写下的旧格式 `ownerId` / 自定义串）⇒ 才用 `staleAfterMs`（「记录看起来还新」）。缺省 `0` = 不问他进程，与升级前逐字一致 |
| `ownerId` 是**内部标识**，别解析它 | 形状 `p<pid>@<host>-<8 位十六进制>`（2026-09-28 起带主机名，**此前没有**）。混版本部署安全：旧进程写下的无 `@host` 记录一律走「判不了 ⇒ 新鲜度」，行为与升级前一致。宿主如果需要自己的任务归属标记，请写进 `spec.options`，别依赖这个字段的格式 |
| 租约判定的两个**残留风险**：只晚捡、不抢错（2026-09-28） | **PID 复用**与**僵尸进程**（父进程未收尸，pid 仍在进程表里）都会被判成「主人在」⇒ 那条孤儿记录要等那个 pid 真的消失才可捡。框架刻意**不加时间硬上限**兜它们 —— 加上限 = 把租约换回新鲜度启发式，「长跑被抢」那个 bug 原样回来。取舍一句话：宁可偶尔晚捡，不可偶尔抢跑 |
| `beforeTurn` 抛错 ⇒ 本回合降级，不判死 run（2026-09-28） | `ContextPolicy.beforeTurn` 里**可能走网络**（compaction 的 `summarize` 是模型调用）⇒ 一次 429 / 超时原先会让整条 run 以「请求失败」收尾。现在降级为「本回合原样放行」，**且出声**：run 根记 `context.policy_failed` + 一条 `console.warn`。⚠️ 代价：降级只是「这一回合不压」，不是「不再压」——历史偏长时先看有没有这条事件 |
| 压缩失败**不烧**滞回额度（2026-09-28） | `compactEvery` 的语义是「距上次**成功**压缩至少隔几个回合」——失败不记账、下一回合重试（原先失败也记，于是摘要器抖一下会让后面几个回合都不再尝试）。代价说清：摘要器**持续**失败时每回合都会再调一次（多一次失败的模型往返），要抑制请在 `summarize` 里自己退避 |
| `drain()` 之后本进程不再推进任何任务（单向闩） | 置位后**没有复位路径**，且 `false`（排空超时）同样意味着**宿主必须退出**：停机窗口里已落库的记录（`running`/`queued` + 本进程 ownerId）在本进程内**没有自愈路径** —— `resumePending` 按 `own-process` 跳过、`submit` 已整体关闭 ⇒ 只能等下一次启动认领（ownerId 含 pid）。宿主若不退出，那些记录会一直停在 `running`（`awaitTask` 不返回、`GET /tasks/:id/stream` 还会说 `not-in-this-process`）。首次被拒时有 `[agentia] 停机中：…` 的 `console.warn`（可 grep），别忽略 |
| 鉴权失败即断连 | 未通过鉴权时在读到 body 之前就回响应，连接**不可复用**（显式 `connection: close`）；这是「不收body省资源」的代价 |
| 预算护栏不是硬实时 | 一回合记账完才判，实际用量可能超上限一个回合的量；并行子循环（一回合多个子 agent）各自过闸，超支上限是「**每个在飞分支**各一个回合」而非「总共一个回合」；模型自然收尾的那回合超限**不算失败**（只留 `budget.exceeded` 事件） |
| `maxCostUsd` 依赖价格表 | 模型不在价格表内（且未用 `priceOverrides` 覆盖）时成本恒为 0，这条护栏**不触发** —— 要无条件兜底用 `maxTotalTokens`。**失效会响**：turn 上会记 `usage.unpriced` 事件、指标有 `model_unpriced_turns_total`、可回调 `onUnpricedModel` |
| 价格表按模型名**精确匹配** | 别名与带日期快照是两个不同的键：内置表收了 `claude-haiku-4-5`，那么 `claude-haiku-4-5-20251001` 就是**未定价**（成本算不出、`maxCostUsd` 不触发，会留 `usage.unpriced`）。照抄官方文档里的带日期 id 最容易踩这一条 —— 要么改用不带日期的别名，要么 `priceOverrides` 里按**你实际传的那个 id** 补一条 |
| 缓存写的缺省乘数只对 **5 分钟** 档正确 | 官方是 5m 写 1.25×、**1h 写 2×**、读 0.1×。而 `Usage` 是四项**聚合**的，分不出这一回合的缓存写走的是哪个 TTL（SDK 的 `Usage.cache_creation` 有拆分，框架没把它带上）⇒ 你在块上用了 `cache_control: { ttl: '1h' }` 就必须在 `priceOverrides` 里写 `cacheWrite: 2`，否则成本**低估 37.5%**、`maxCostUsd` 会迟触发。框架自己的调用点都不设 ttl，所以不改也对 |
| 图片块的 token 只能估、且按**上界**估 | 块里没有宽高（`source` 只有 base64 的 `data` 或 `url`），而官方图片计费按**尺寸**（28×28 像素 = 1 visual token），与文件字节数**无关** —— 一张 200KB 纯色 PNG 和一张 200KB 细节图的成本能差两个数量级。框架取「长边缩到 1568px」的**上界 3136 token/块**：宁可高估（`maxTotalTokens` 提前拦）也不低估（护栏迟触发）。渲染 / 摘要侧则只给 `[image …]` 占位，**不展开 base64** |
| 工具超时**不强制取消**工具 | `AgentTool.run` 没有 signal 参数，超时首先是「不等了」；副作用可能已发生。想真停：监听 `ToolRunContext.abandoned`（引擎放弃等待时 abort 它）自行收尾。框架自带的 @SubAgent / @Skill 已这么做 —— 超时即中止子循环（在飞请求被掐、不再后台烧 token），capability span 立刻以 error 收尾 |
| 会话只存对话轮次 | `SessionStore` 存「用户输入 + 最终回复」，run 内部的 tool 往返**不进历史**（要完整过程用 `traceToMessages`）；且只有**跑成功**的轮次才回写 |
| 同 session 并发 run 要自行串行化 | `SessionStore` 是 **append-only**：并发写不互相覆盖、不丢数据，但**不保证角色交替** —— 两个并发 run 共用同一 sessionId 时，各自追加的轮次可能交错成「连续两条 user」，下一轮 load 出来撞角色交替校验（400）。同一 session 的并发 run 请调用方自行串行化（每 session 一把锁 / 一条队列） |
| OpenAI 适配器听端点的话 | 请求发 `stream:true`，但**按响应形态解析**：端点回 JSON 就退回一次性（没有打字机效果），回 `event-stream` 才逐 token |
| OpenAI 流式的上游故障按失败处理 | 三种形态都**抛错**按失败处理：流中 `error` 分片（上游把故障塞进 200 的流；按 `type`/`code` 反推 status，限流能被引擎重试认出）；**未收到 `[DONE]` 也无 `finish_reason`**（流被上游/代理截断 —— 哪怕已吐出半句、有累积文本，也按不完整响应抛错，不报 `end_turn`）；正常终止却无任何文本与工具调用（与非流式空 `choices` 同一守卫）。**例外**：`finish_reason=content_filter` 的空流是合法 refusal，不抛 —— 与非流式路径同一个响应同一个结论 |
| OpenAI 兼容端点回 legacy `function_call` 形态时**不支持** | 适配器只认现代 `tool_calls`（请求侧也只发这个形态）。收到 `finish_reason=function_call` 会**响亮失败**（400，落 `api`／不可重试），**不**按 `end_turn` 收尾 —— 那种回法里的调用在 `message.function_call` 里、读不出来，报成正常收尾会让「模型要调工具、工具却没执行」记成成功。换支持 `tool_calls` 的端点或模型即可（legacy `functions` 形态 OpenAI 2023 已废弃） |
| MCP 只做 tools | `sampling`（server 反向请求模型）/ `resources` / `prompts` 原语不做；出厂连接器同样只做 `tools/list` + `tools/call` |
| MCP 反向桥不校验会话（无状态 server） | `createMcpServer` 的 http 模式：`initialize` 铸 `mcp-session-id` 头但后续请求**不带也服务**（宽容是有意的）；GET → 405、DELETE → 200；鉴权只有 `auth` 钩子一道（stdio 信任父进程）。范围同样只到 tools（与正向桥同一张 YAGNI 清单） |
| MCP 的协议层错误框架看不见 | `isError: true` 只有连接器能看见 —— 它必须转成抛错，否则模型收到的是一条「成功」的结果（出厂连接器已代你处理） |
| MCP 超时同样是「不等了」 | 桥的 `timeoutMs` 取消不了 server 侧执行（拿不到取消句柄）；它只是**兜底** —— 引擎设了 `toolTimeoutMs` 时**不参与**判定（一次调用只有一个裁判；**显式 `toolTimeoutMs: 0` 也算设了** —— 那是引擎表态「不限」，桥不会再自作主张判 60s），两条路径**同判定、同账**（`errorKind='timeout'`） |
| 已中止的 MCP 调用**不发请求** | 信号在**发送前**就已中止 ⇒ 立刻以 `AbortError` 收场，请求不出门（2026-09-21 前是「照样 write、Promise 永不 settle」：副作用真送达、调用方永久挂起）。发送**之后**才中止的，请求已在路上、取消不了 server 侧的执行，但返回的 Promise 同样立刻以 `AbortError` 收场、簿记同步清掉 —— 直接 await 连接器 API 的宿主不会永久挂起（2026-09-22 前是「只删簿记不 reject」：Promise 永不 settle，与 HTTP 连接器的在途中止行为不一致）；取消不了的只是 server 侧执行，这点与 `toolTimeoutMs` 同口径 |
| MCP 连接器的超时只管装配期 | 连接器自带的 `timeoutMs` 只作用于**握手 + `tools/list`**（那两步**没有任何别的裁判** —— server 卡住会让 `createApp` 永久挂起）；`callTool` 仍是引擎 / 桥那一个裁判 |
| MCP 连接的 `close()` 保证子进程已终止 | stdio 先 `SIGTERM`、`MCP_CLOSE_GRACE_MS`（2000 ms）后 `SIGKILL`，然后**等真正的 `'exit'`** —— **返回即代表进程已被回收**（此前到点即返回，会留孤儿进程而调用方无从知晓）；HTTP 尽力 `DELETE` 会话（server 不认也无所谓） |
| StreamableHTTP 会话过期**自愈** | 带会话 id 收到 `404` = 会话已终止、**该请求未被 server 执行** ⇒ 丢会话 → 重新握手 → 把**这一次**重试一次（**只一次**，不再循环）。自愈本身是静默的 ⇒ 用 `onSessionExpired` 去计数 / 告警，否则它和「静默失效」在监控上看不出区别。`404` **之外**的失败仍按 `classifyError` 分流抛出，不重试 |
| MCP 名字可能被归一化 | 原名含 `-` / `.` / 空格 → 进菜单时变成 `_`；回调 server 用的仍是原名（`mcp.tool.<菜单名>` attribute 逐次可查；`mcp.tool` 是最近一次） |
| MCP 工具不能进 DI 容器 | 它没有 provider token，也不能被别的能力的 `tools` 引用（两种引用粒度都要先有 token） |
| 指标分位是窗口内精确值 | `*_last{quantile=...}` 只反映最近 `windowSize`（缺省 1024）条样本；要跨实例聚合请用直方图（`*_bucket` / `_sum` / `_count`，累积语义） |
| 指标是**进程内**累加 | 不做分布式聚合与持久化：多实例各算各的（直方图可相加），重启即清零。要长期保留请把 `render()` 抓走或用 `export:'otlp'` 推给采集端 |
| OTLP metrics 只推当前累计 | 按 `intervalMs` 周期导出**累积值**（CUMULATIVE），不做增量/背压；导出失败按 `onExportError` 处理（缺省每次失败落一条 `console.warn`，不重试、不阻塞 run）。`reset()` 语义是**开启新窗口**：计数清零**且**数据点起点前移（同一 `startTime` 下 counter 只能单调不减，只清零会让后端算出负增量或丢样本） |
| OTLP trace 导出**只发 JSON**（直打 Phoenix 会 415） | `createOtlpExporter` 的 content-type 写死 `application/json`，`OtlpExporterOptions` **没有编码选项**；只收 `application/x-protobuf` 的接收端（Phoenix 的 traces 路由对别的 content-type 回 415，源码级核实 2026-10-12）**直打不进去** —— OTLP 规范对接收端只是 SHOULD 双收，Phoenix 未遵循推荐但不违规。处置：中间加一层 OTLP Collector 收 JSON、转 binary（最小配置见 `docs/observability.md` §7）。**不内建 protobuf 编码器**：零运行时依赖是硬约定，手写编码器几百行进核心不值 |
| `GET /metrics` 不鉴权 | 与 `/healthz` 同档（拉取端在集群内网）。要保护请放反代之后，或不传 `metrics` 选项自行在外层挂路由 |
| 工具没有 token/成本指标 | 工具是**你的代码**、本身不消耗 token，所以只产出调用数/失败数/耗时；token 与成本只对 `skill`/`subagent`（有 `capability` span）与模型维度产出 |
| `@Prompt` 没有能力指标 | 资产类能力不建 span、无独立耗时，故不出现在能力排行里（这是刻意的：硬凑一个假耗时会误导调优） |
| 能力标签有基数上限 | `labelMode:'capability'`（缺省）+ `maxCapabilities`（缺省 200），超出的能力归入 `capability="__other__"`；`snapshot().droppedCapabilities` 给出被归并的能力个数。要完整明细请用 `buildRunReport`（不设上限） |
| 模型 / 评分维度也有基数上限 | `maxModels`（缺省 50）/ `maxScores`（缺省 200）：`model` 与评分键（`name@source`）都可能是无界键（上游把版本号拼进模型 id、eval 名带时间戳），而每个模型键都持一份时长窗口 —— 光是能力封顶不够。折叠只丢标签粒度，`__other__` 桶照常累加，总数仍对得上；被折叠的不同键数见 `droppedModels` / `droppedScores` |
| 提示词版本只是标记 | 框架不存版本库、不回滚：`version` 只落 run 根 attribute；`system` 传已拼好的 `SystemParam` 时无版本可记 |
| `agentia harvest` 的产物是轨迹骨架 | trace **不记 assistant 文本**（llm.turn 只记 usage/事件），故 harvest 用例脚本里的 text 块是占位、预填 `expect` 是从原 trace 抄录的实际轨迹 —— 脚手架不是成品，人工核对后再进 CI（见 §6「线上 trace 回流」） |
| 分叉重放不是续跑 | `forkMessages` 与 `traceToMessages` / harvest **同源有损**：trace **缺省**不记 assistant 文本（opt-in 例外：`traceContent: 'full'`，见 §4）与 run 原始输入（重放里 assistant 是标注占位、首尾 user 是合成），也不记 blackboard（分叉种子经 `RunInvocationOptions.blackboard` 自带）；它产出喂回 `app.run` 的 messages、起的是**新 run**，不是接着原 run 的循环位置跑 |
| 评分来自 run 之外 | `Score` 走 run 根 `score` **事件**而非 span 字段（评分通常在 run 跑完后才产生）；`attachScore` 找不到根 span 时静默忽略，多次调用即多条事件（不同维度各记各的） |
| 链路关联：入站自动、出站默认只给读取器（MCP 桥除外） | `traceContext` / `traceparent` 头把**上游**接进来（run 根的 `links`）；出站方向给 `currentTraceparent()`（当前 span 的 W3C 串，回合 / 能力调用粒度），但框架**不替你做注入** —— 它不创建出站请求，那一行由宿主的 `fetch` / metadata 自己写。**唯一的例外是 MCP 正向桥**：`tools/call` 的请求由桥自己发，故 run 内经 `mcpTools` 的调用自动带 `params._meta.traceparent`（SEP-414）。两个边界：① `run` 根 span 由 `runAgent` 打开 ⇒ 更早的 `contextInit` / 记忆水合取到 `undefined`（那时确实没有 span）；② flags 恒 `00`（本框架不采样）。id 宽度经**同一份投影**压到 16 位（与 OTLP 导出共用，单一真源）—— 故下游收到的 span id 与 collector 里的是同一个数。另：link 只落在 run 根（子 span 不散），且**一进程内**不跨进程自动传播 —— 队列场景要自己把 `traceContext` 传下去（HTTP 头带走，或随 `TaskRecord.spec.options` 落库） |
| 配额不是框架子系统 | 只给缝（middleware + TraceSink + BudgetGuard），计数放哪（内存 / Redis / DB）与超限怎么办都是你的策略 |
| 人工审批两种形态 | 进程内闸门用 `middleware`（`await` 决策再放行）；跨进程耐久审批用 `@Tool({ approval: 'required' })` + `POST /tasks/:id/approve`（挂起/恢复，见 §6.6「人工审批」） |
| 审批超时是**惰性**判定 | `approvalTimeoutMs` 不起定时器：`approve` / `poll` / `resumePending` 读到过期挂起任务时才自动全拒并重派 —— 没人读的任务不会自己超时（要定期扫就调 `resumePending()`） |
| 挂起段与恢复段是两棵 trace | 每段执行一棵独立的树（`traceId == runId`），恢复段经根 span 的 `links` 挂到上一段；指标按段计（挂起段算一次 ok 的 run —— 「等人」不算失败，区分看 `stop_reason` attribute） |
| 审批是 at-least-once | 崩溃发生在「批准后、恢复执行中」时，副作用工具会重执行（与 `resumePending` 续跑同口径）—— 副作用工具自己保证幂等 |
| 挂起/恢复间预算重新起算 | `maxTotalTokens` / `maxCostUsd` 在恢复段从 0 重新计（新树新账，与 `resumePending` 续跑同口径） |
| 恢复段的会话回写是进程内快照 | 带 `sessionId` 的任务挂起时，「本轮用户输入」快照只存进程内存（恢复段由 AsyncRunner 自己补写「用户输入 + 最终回复」，不再经 run 层重复拼历史）—— 进程崩在「挂起 → 重启 → approve」之间会**丢这一次会话回写**（会话少一轮，但绝不写进坏历史；审批决定本身已落库） |
| 嵌套能力内的审批不支持挂起 | @SubAgent / @Skill 子循环里的 `approval: 'required'` 工具无法把整个 run 挂起 —— 子循环挂起会以 `is_error` 交回主 agent（要审批的能力请放主菜单） |
| 同步 `/run` 撞上审批没人可批 | 同步 RPC 会带着 `stopReason: 'suspended'` 收尾返回 —— 但响应体（`toHttpBody`）**不含** `suspendedMessages`，也没有任务记录可审批（待决清单只能去 trace 的 `approval.requested` 事件里看）。**要审批请走 `POST /tasks` 异步宿主** |
| Scheduler 调度表不落库 | `every` / `at` 的调度本身只在内存：已 submit 的任务记录能经 `resumePending` 续跑，但「未来某刻再触发」的调度在重启后不存在（远期单发由宿主自己的 cron 驱动）。另：`drain()` 不停 Scheduler —— 停机窗口内到点的 tick 会打一条触发失败日志（无害但吵），介意就 `scheduler.stop()` 先行 |
| file store 的撕裂写只在启动时自愈 | 写入中途失败（磁盘满等）留下的残行由 `healTail` 在**构造期**修复；同进程内继续 append 会把新记录粘在残行尾部、下次启动时一起丢弃 —— 磁盘满告警后先恢复写入能力再继续依赖它 |
| 终态落库失败 ⇒ 重启会重跑 | AsyncRunner 终态 `save` 失败**不遮罩主流程**（「不击穿业务」的代价）：store 抖动时任务可能永远停在 `running`，重启后 `resumePending` 会重跑一个**实际已成功**（副作用已发生）的任务 —— 所以副作用工具必须自身幂等。**但失败本身不再静默**：`new AsyncRunner(app, { onPersistError })` 会收到 `{ record, error, phase }`（`phase: 'initial' \| 'outcome'`，后者就是这条）。⚠️ 框架**修不了**它（写不进去就是写不进去）—— 出口的职责是让你能对账、让「记录无声丢失」不再是默认行为（与 `createOtlpExporter({ onExportError })` 同因同形） |
| 缺省**不裁剪**上下文（长跑每回合重发全量历史 ⇒ 成本随回合数平方增长） | `contextPolicy` 不注入就一个回合都不裁：每回合把**整段历史**重发给模型，于是回合数翻倍、总输入约翻两番。框架给了缝与一份参考实现（`createBudgetPolicy`），但**不替你决定** —— 裁剪有损（截在哪、留什么会影响答案），是宿主的策略。长任务（几十回合以上）请在 `createApp` 里显式注入 `contextPolicy` |
| `contextPolicy` 不进子循环 | 应用级 `contextPolicy` / `onText` 只对主循环生效：@SubAgent / @Skill 的子运行不做上下文裁剪（长跑子 agent 撞上下文上限会以 api 错误收尾）。预算护栏（`maxTotalTokens` / `maxCostUsd`）正常透传 |
| 记忆没有删除语义 | `MemoryStore` 只有 load/save：run 内 `ctx.delete` 掉的键回写时不会从 store 移除（下一轮水合会复活）。要真删请直接操作 store 实现 |
| 同 keys 的并发回写不合并 | CAS（`loadWithRev` + `saveIfRev`）只做到「冲突时**不写 + 出声**」：框架**不合并、不重试**（合并语义是 store 与宿主的决定，配方见 §6.5）。只有 `load` / `save` 的 store 连冲突都**看不见** —— 版本号是唯一依据，没有它就检测不了覆盖；`InMemoryMemoryStore` 的版本粒度是**整店一个计数**（宁可多报冲突，不漏报真实覆盖） |
| 内容护栏不给实现 | 同「配额」：只给缝（入参包 `app.run` / 工具前 `middleware` / 出参包返回值或 `sinks`），策略（正则 / 分类器 / 外部 API）是你的 |
| 框架不执行模型生成的代码 | 无沙箱可言：`@Skill` 跑你写的方法、`@Tool` 是你写的函数，模型输出只成文本 / `tool_result`；代码执行工具的隔离是**工具实现内部**的事；工具起的子进程取消时要自己 kill |

---

## 8. 常见错误

| 症状 | 原因与修法 |
|---|---|
| 菜单里没有我的能力 | ① 方法没写装饰器；② 类没注册进 `providers`；③ 框架双实例（见第 2 节陷阱）；④ `toolSources` 白名单把它排除了 |
| `菜单能力重名` / `子菜单能力重名` 装配期抛错 | 四类能力**共用命名空间**，改名即可；查重覆盖主菜单与 @SubAgent/@Skill 的 `tools` 引用展开出的子菜单（两个 provider 各有同名能力被同一能力整片引用时，报错会指到哪个能力的哪个引用片，用能力级路径 `<token>/<能力名>` 收窄即可） |
| 编译错 `不能把 X 赋给 Y` | 用了 `fromZod<T>`，方法签名与 `T` 不一致（这是护栏，不是 bug） |
| 模型传的入参没被拦 | 只填了 `schema` 没写 `strict`；且框架的校验是**子集校验**（`format`/`minimum` 等不校验） |
| `ctx.get('k')` 没有类型 | 没做 `Blackboard` 声明合并（见 5.1） |
| `result.typed` 是 `unknown` | `resultSchema` 用的是裸 JsonSchema；改 `fromZod<T>`（见 5.3） |
| TS 里想 `app.my_tool(...)` | 不要这样写：能力由模型选择，不是你的方法。要确定性调用就**直接调类方法** |
| 子 agent 调不到工具 | `tools` 的元素是 **provider token** 或 `'<token>/<能力名>'` 路径，不是裸工具名（裸名字会按「未注册 provider」在装配期抛错） |
| 长跑内存涨 | 缺省内存 store 不淘汰；设 `InMemoryTaskStore({ maxRecords })` 或换耐久 store |
| 鉴权钩子抛错，客户端只看到「未通过鉴权」 | 这是设计：非 `HttpException` 的错误原文只进服务端日志（要回给调用方就抛 `HttpException(status, body)`） |
| 停机后 `POST /tasks` 回 503 | `drain()` 已被调用（或注入的 runner 已 drain）—— 这是「拒新单」的正常行为，任务没丢 |
| `drain()` 之后有些任务停在 `running` 不动 | **宿主没退出**。`drain()` 是**单向闩**：返回之后本进程不再推进任何任务，且没有任何复位路径。停机窗口里被拒掉的记录已落库（`running`/`queued` + **本进程的 ownerId**）⇒ 本进程的 `resumePending` 按 `own-process` 跳过、`submit` 已整体关闭 ⇒ **本进程内没有自愈路径**，只能等**下一次启动**认领（ownerId 含 pid）。所以 `drain()` 返回 `false`（排空超时）同样意味着「必须退出」——参考宿主都是 `await drain(...)` 后 `process.exit(...)`。首次被拒时会打一条 `[agentia] 停机中：…` 的 `console.warn`（可 grep），别忽略它 |
| `stopReason` 是 `budget_exceeded`、任务被判失败 | 这是设计（护栏拦下的 run **没跑完**）。只想「记一笔」不想改结局，就自己用 `createBudgetGuard` 读 trace |
| 工具超时了，副作用却还是发生了 | 超时是「放弃等待」不是强制取消。引擎放弃时会 abort `ToolRunContext.abandoned`（@SubAgent/@Skill 已靠它自中止）—— 你自己的工具要真停就监听它 |
| 用 OpenAI 端点没看到打字机效果 | 端点没按 `stream:true` 回 `event-stream`（回了一整份 JSON）—— 适配器按响应形态解析，此时退回一次性 |
| 改了框架源码却看不到效果 | 确认 import 的是同一份构建产物（`npm run build` 后跑 `dist`） |
| MCP 工具没出现在菜单里 | `mcpTools()` 的返回值没传进 `createApp({ tools })` —— 它不走装饰器收集，也不进 DI 容器（裸工具缝） |
| 装配期报「归一化后撞名」 | server 侧两个工具名只差非法字符（`a-b` / `a.b`）→ 归一化后同名；给个 `prefix` 或改 server 侧名字 |
| MCP 调用「成功」但内容是错误文本 | 连接器没把协议层 `isError: true` 转成抛错（框架只认抛错） |
| eval 里模型调了不存在的工具 | 脚本里的工具名必须是**菜单里的名字**（MCP 工具是归一化后的 `mcp_<server>_<name>`） |
| `metricsSink` 的数字一直是 0 | 没接进 `createApp({ sinks })`（或 `registerDefaultTraceSink`）—— 它靠 run 收尾投递，不自己埋点 |
| `metricsSink({ export: 'otlp' })` 构造期报错 | 没给 `endpoint` —— OTLP 导出必须知道往哪发，响亮失败好过静默不导出；补上 `endpoint`（如 `http://localhost:4318`）即可。`windowSize` / `maxCapabilities` / `maxModels` / `maxScores` 非正数、`buckets` 非严格升序同理是构造期配置校验 |

