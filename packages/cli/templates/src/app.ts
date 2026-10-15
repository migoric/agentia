import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, jsonlTraceSink, loadEnvFile, SystemPrompt } from '@migor/agentia';
import type { AgentApp, SessionStore } from '@migor/agentia';
import { FileSessionStore } from './session-store.js';

/**
 * 应用装配 —— **与启动分离**（app.ts 只负责「造一个 app」，不负责「跑一次」）。
 *
 * 为什么分开：开发期的调试环（`agentia dev` 的面板）需要把四个控件喂进应用 ——
 * 调哪个能力（`toolSources`）、工作目录（`workdir`）、要不要多轮、以及每次的 prompt。
 * 前两个是 `createApp` 的选项、后两个是 `app.run` 的选项，**都是调用者才能设的东西**。
 * 拆出这个工厂之后，`agentia dev` 就是调用者，于是**工程里一个 dev 文件都不需要**。
 *
 * ⚠️ 别把 `createApp(...)` 直接写回 main.ts：那样 dev 环就拿不到这个工厂，
 * `agentia dev` 会明确报错（不是静默降级）。
 *
 * ⚠️ 进程外资源（MCP 连接器最典型；sqlite 句柄、定时器同理）必须在**模块作用域**创建、
 * 用 `useValue` 注入给能力，**不许写在某个 provider 的 constructor 里**。理由：
 * dev 环换能力选择时会重建 app，构造函数里建 ⇒ 资源跟 **app** 同寿 ⇒ 每次重建重 spawn
 * （MCP 冷握手实测 78 ms）且旧子进程变孤儿（框架没有 `AgentApp.close()`）。
 * 模块作用域建 ⇒ 资源跟**进程**同寿，重建只是重解析实例、不动连接。
 * 形状见 docs/plans/2026-09-22-dev-debug-loop.md 的「(d) 附一条硬约定」。
 */

/**
 * 读项目根的 `.env`（key 写文件里即可，不必每次 export）。框架**不自动**读 `.env` ——
 * 读哪个文件、什么时候读由这里决定；已存在的真实环境变量优先，不会被文件覆盖。
 * 想换路径/顺序：`loadEnvFile({ path: '.env.local' })`，或直接删掉这一行改用自己的加载器。
 *
 * ⚠️ 必须在 **app.ts（装配模块）**，不能在任一个入口（`main.ts` / `batch.ts`）：`agentia dev`
 * 的 runner 只 import 本文件、**从不执行入口**。放在入口里会让 `npm run dev` 静默读不到
 * `.env`，而 `npm start` 读得到 —— 同一份 `.env` 两个行为，且失败的形状是「忘了配 key」。
 */
loadEnvFile();

/**
 * 能力分类目录（**顺序即装配顺序**）。
 *
 * 这个常量同时是 `agentia dev` 的能力选择器的**菜单来源** —— dev runner 读它、
 * `readdir` 这些目录即得能力 token 列表。两侧同一个常量，不会漂移。
 * ⚠️ 别改回 cwd 相对写法（形如 `src/tools` 的字符串）：那样 `node dist/main.js`
 * 会去加载 src 下的 .ts 源码，而装饰器不是可擦除的类型语法，Node 直接跑不了。
 */
export const CAPABILITY_DIRS = ['tools', 'skills', 'prompts', 'subagents'];

/** 能力目录按**本文件位置**解析，不是 cwd：开发态（src/app.ts）→ src/<分类>/，构建后（dist/app.js）→ dist/<分类>/ */
function capabilityPaths(): string[] {
  return CAPABILITY_DIRS.map((d) => fileURLToPath(new URL(`${d}/`, import.meta.url))).filter((dir) =>
    // 空分类目录在构建后不存在（tsc 不为空目录产出 dist/<分类>/），而 discover 对
    // 显式给出的不存在路径是报错的 ——「这类暂时没有能力」不该让启动失败。
    existsSync(dir),
  );
}

/** 项目根（= app.ts / app.js 的上一层）。生产里它是工具缺省看到的树 */
export const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** 会话文件：整段对话历史（跨进程重启接得上）。已进 .gitignore */
export const SESSION_FILE = resolve(PROJECT_ROOT, '.agentia', 'session.json');

/**
 * trace 落盘文件（一行一条裸 Trace）。已进 .gitignore。
 *
 * 为什么**默认就接上**：框架的差异化是「每次 run 都产出可观测调用树」，但框架刻意
 * **不内建**任何出口（spec §9.3 —— 出口只有 `sinks` 这条缝），于是「缝在那儿、没人接」
 * 时表现是：同步 `/run` 的 trace 随响应回去了，而**异步 `/tasks` 的 trace 落进任务库里
 * 没有任何人导出**，「这个任务为什么慢」要排查时它正好不在。接上这一条之后
 * `agentia report` / `diff` / `harvest` / `export` 开箱可读。
 *
 * ⚠️ 落的是**完整 trace**（含 prompt 与工具出入参）⇒ 上线前按你自己的合规要求处置
 * （删这一行即关掉；换 OTLP / 指标见 docs/observability.md 的配方）。
 */
export const TRACE_FILE = resolve(PROJECT_ROOT, '.agentia', 'traces.jsonl');

export interface CreateAgentAppOptions {
  /** 只收集这些 token（能力文件夹名）上的能力；不传 = 全量。dev 环的「能力选择」喂这里 */
  toolSources?: string[];
  /** agent 的工作目录（工具读写数据的那棵树）；不传 = 项目根 */
  workdir?: string;
}

export async function createAgentApp(opts: CreateAgentAppOptions = {}): Promise<AgentApp> {
  return createApp({
    name: '__PROJECT_NAME__',
    discover: capabilityPaths(),
    providers: [
      // 工作目录以**值**注入给需要它的能力（D3-D：现成 DI，零框架改动）。
      // 消费侧两选一，推荐第一种（依赖声明跟着能力走，装配文件不必知道）：
      //   ① 能力类自带 `static readonly deps = ['WORKDIR']` —— discover 扫到就带上，
      //      脚手架的 read-file 就是这么接的；
      //   ② 在这里显式声明 `{ provide: '<token>', useClass: Xxx, deps: ['WORKDIR'] }`
      //      （能力不走 discover、或依赖是装配期才知道的值时用这个）。
      // ⚠️ **别两条同时用**：同一 token 出现两份时框架会告警（后注册覆盖先注册，
      // 谁生效取决于顺序）。`src/registry.ts` 里也有一份 `WORKDIR`（显式装配路线），
      // 值与这里相同 ⇒ 混用不会改变语义，但真要二选一时留 `app.ts` 这份。
      { provide: 'WORKDIR', useValue: opts.workdir ?? PROJECT_ROOT },
    ],
    // 收窄发生在 createApp 期：toolSources 是 token 级白名单，一次收窄顺带把装配期
    // 静态校验与 prompts.versions 那本账一起收窄。不传 = 全量（缺省路径）。
    ...(opts.toolSources && opts.toolSources.length > 0 ? { toolSources: opts.toolSources } : {}),
    // trace 出口（观测）。框架刻意不内建 ⇒ 不接就是「跑得挺好、什么都看不见」；
    // 接入后 dev 面板、同步 /run、异步 /tasks 三条路都经 `app.run` ⇒ 这一处全覆盖。
    // 删掉即关闭；换 OTLP / 指标配方见框架 docs/observability.md。
    sinks: [jsonlTraceSink({ path: TRACE_FILE })],
    system: new SystemPrompt().add(
      'role',
      '你是 __PROJECT_NAME__ 的主 agent，按任务自主调度菜单里的能力。',
      true,
    ),
  });
}

/**
 * 对话历史后端（多轮用）。**只在开了多轮时才会被读到**（dev 环按需调用）——
 * 单轮 run 不碰它，所以任务型能力（code-review 那种「每次独立、跨仓库会串味」的）
 * 天然不受影响。
 *
 * 想换成别的后端（sqlite / Redis / 内存）：改这里就行，`SessionStore` 只有两个方法。
 */
export function createSessionStore(): SessionStore {
  return new FileSessionStore(SESSION_FILE);
}
