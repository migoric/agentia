/**
 * dev runner —— `agentia dev` 起的**子进程**，由 CLI 自己拥有（**不是**用户工程里的文件）。
 *
 * 它做的事只有一件：**import 用户的 `src/app.ts` 并驱动它**。
 *
 * 为什么要在 CLI 里（D9(d)）：四个控件（能力选择 / 多轮 / 工作目录 / prompt）全都是
 * `createApp` / `app.run` 的选项，而**调用者**能设它们。如果 `agentia dev` 自己 import
 * 用户的 app 并调用，CLI 就是调用者 ⇒ 用户工程里**一个 dev 文件都不需要**。
 * 反过来说，把 harness 放用户工程里等于每个工程一份会漂移的**逻辑副本**（CLI 修了 bug，
 * 那些副本一个都不会变）—— 这正是 `dev.ts`（逻辑）被否掉、`dev.config.ts`（数据）留下的判据。
 *
 * ⚠️ 进程 cwd 必须仍是**项目根**（dev.ts 负责）：`loadEnvFile()` 按 cwd 找 `.env`、
 * `discover` 的相对路径也按 cwd —— 把 cwd 设成「agent 工作目录」会让 `.env` 静默读错。
 * 工作目录走 DI 注入（D3-D），不走 chdir。
 *
 * 与父进程的协议见 dev-protocol.ts（单一来源）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createInspectEventSink,
  createInspectSink,
  type InspectEventSink,
} from './inspector-sink.js';
import {
  APP_ENTRY_REL,
  DEFAULT_BUDGET,
  DEV_CONFIG_REL,
  type DevMessage,
  type RunnerMessage,
  TRACE_LOG_REL,
} from './dev-protocol.js';

/** 框架侧对象的最小结构面（CLI 不 import 框架包 —— 保持零运行时依赖） */
interface RunnerResult {
  trace: { traceId: string };
  stopReason: string;
  error?: { message: string } | undefined;
  finalText: string;
}
interface RunnerApp {
  run(messages: unknown[], opts: Record<string, unknown>): Promise<{ result: RunnerResult }>;
  container: { registered(): unknown[] };
}
interface RunnerSessionStore {
  load(id: string): unknown[] | Promise<unknown[]>;
  append(id: string, messages: unknown[]): void | Promise<void>;
}
interface AppModule {
  createAgentApp?: (opts: { toolSources?: string[]; workdir?: string }) => Promise<RunnerApp>;
  createSessionStore?: () => RunnerSessionStore;
  CAPABILITY_DIRS?: unknown;
}

export interface DevConfig {
  /** 这些能力按多轮调试（累积 session）；未列出的按单轮 */
  multiTurn?: string[];
  /** 缺省工作目录（面板的初始值） */
  workdir?: string;
  /** 缺省预算护栏覆盖 */
  budget?: { maxCostUsd?: number; maxTotalTokens?: number };
}

const root = process.env.AGENTIA_DEV_ROOT || process.cwd();

function send(msg: RunnerMessage): void {
  process.send?.(msg);
}

// ---------- trace 出口（必须早于 import 用户的 app） ----------

/**
 * 把 trace sink 注册进框架的**进程级**注册表。
 *
 * 为什么在 runner 里做而不是靠 `NODE_OPTIONS=--import` 的 preload：preload 那套是
 * 「CLI 代码不在子进程里」时代的产物（当时子进程跑的是用户的 `main.ts`）。现在子进程
 * 跑的就是 CLI 自己的 runner，于是两件事一起消失：
 * - `--import` 的 Node 版本门槛（≥20.6 / ≥18.19）；
 * - 拼接 `NODE_OPTIONS`（沙箱 / 工具链里它是被改写的常客，而改写是静默的）。
 *
 * ⚠️ 时序：必须在 **import 用户的 app.ts 之前** await 它 —— `createApp` 构造期对
 * `defaultSinks` 做快照，晚注册的 sink 对已建应用不可见（静默丢 trace）。
 *
 * ⚠️ 必须从**用户项目**（root）解析 `@migor/agentia`，不是从 CLI 的安装位置 ——
 * 否则拿到另一个模块实例，注册表不共享，sink 静默失效。
 */
async function registerTraceSink(): Promise<void> {
  const port = Number(process.env.AGENTIA_INSPECT_PORT || 0);
  if (port <= 0) return;
  const token = process.env.AGENTIA_INSPECT_TOKEN || undefined;
  try {
    const req = createRequire(join(root, 'package.json'));
    const entry = req.resolve('@migor/agentia');
    const mod = (await import(pathToFileURL(entry).href)) as {
      registerDefaultTraceSink?: (sink: unknown) => void;
    };
    if (typeof mod.registerDefaultTraceSink !== 'function') {
      throw new Error('@migor/agentia 未导出 registerDefaultTraceSink（版本过旧？）');
    }
    mod.registerDefaultTraceSink(createInspectSink({ port, ...(token ? { token } : {}) }));
  } catch (e) {
    // 面板是增强项：观测挂不上不该阻断 dev（与旧 preload 同一条纪律）
    console.warn(`[agentia] inspector 未挂载：${(e as Error).message}`);
  }
}

/**
 * ① 实时右栏：**增量**记账事件的出口（框架 `onTraceEvent` 的落点）。
 *
 * 与上面那个 trace sink 是**两条缝**，差别都是刻意的：
 * - trace sink 走收尾的 `snapshot()`（一次、被 `flushSinks` await、保证送达）；
 * - 这里走运行期的 `onTraceEvent`（逐笔、同步派发、**不保证送达**）——「此刻看到」。
 *
 * 为什么必须有它：此前右栏唯一的画树点在 run **收尾之后**，一次十几秒的 run 期间
 * 面板上的树是死的（只有一句「正在跑…」）。框架的增量出口本来就是为这类消费者准备的
 * （`RunInvocationOptions.onTraceEvent`，0.8.3），计划 §D7 的评审补充也点名要求接上。
 *
 * 纪律（与框架同名出口一致）：不 await、失败静默、由 sink 自己排 FIFO 链保序
 * （见 `createInspectEventSink`）。**丢帧只会让树少长一会儿**：收尾那份整棵 trace
 * 会把面板上折回的临时树覆盖掉，缺的 span 由它补齐 —— 不会让面板看到一棵错的树。
 */
function registerEventSink(): void {
  const port = Number(process.env.AGENTIA_INSPECT_PORT || 0);
  if (port <= 0) return;
  const token = process.env.AGENTIA_INSPECT_TOKEN || undefined;
  eventSink = createInspectEventSink({ port, ...(token ? { token } : {}) });
}

/**
 * ③ **落盘** trace（档A / `docs/plans/2026-10-05-dev-workbench.md` §2）：每次 run 收尾往
 * `.agentia/traces.jsonl` 追加一行裸Trace。
 *
 * 为什么值得挂：那个文件的格式**恰好就是** CLI 三个命令的输入（`jsonlTraceSink` 的头注
 * 逐字点名了 `agentia report` / `diff` / `harvest`，加上 `export` 是四个）⇒ 挂上之后
 * 面板里跑过的每一次 run，立刻变成「`agentia report` 看哪个能力慢/贵/爱失败」、
 * 「`agentia diff` 改 prompt 后轨迹漂没漂」这两件事的**现成输入**。开发期最贵的
 * 一件事是「拿不到刚才那次 run 的数据」，这一行就把它解决了。
 *
 * 三条纪律（每条都有代价，如实标注）：
 * - **写失败不阻断 run**（`catch` + `console.warn`）：与 `registerTraceSink` 同款 ——
 *   观测是增强项，磁盘满 / 目录只读不该让dev 起不来。
 * - **不轮转、不清空**：dev 单条 trace 以百 KB 计，而 `.agentia/` 已被脚手架 gitignore。
 *   代价是**长跑 dev 环会攒一个只增不减的文件**；要清就是用户自己 `rm`（文档里写一句）。
 * - **单进程写者前提天然满足**：该 sink 的契约是「多进程写同一文件会交错」，而 dev环
 *   只有 runner 这一个写者（父进程走HTTP 收，不碰这个文件）。
 *
 * ⚠️ **两条缝，不是替代关系**：落盘管「事后能查」，`onTraceEvent` 管「此刻看到」。
 * 挂落盘**不碰** `opts.onTraceEvent`（那行仍在 `runOnce` 里），反之亦然。
 *
 * ⚠️ **顺序**：`createApp` 构造期对 `defaultSinks` 取快照 ⇒ 任何 sink 都必须早于
 * 用户 app 的 import（`main()` 里 `registerTraceSink` 那条注释已为这件事把关）。
 */
async function registerJsonlSink(): Promise<void> {
  try {
    const req = createRequire(join(root, 'package.json'));
    const entry = req.resolve('@migor/agentia');
    const mod = (await import(pathToFileURL(entry).href)) as {
      jsonlTraceSink?: (options: { path: string }) => unknown;
      registerDefaultTraceSink?: (sink: unknown) => void;
    };
    if (typeof mod.jsonlTraceSink !== 'function') {
      throw new Error('@migor/agentia 未导出 jsonlTraceSink（版本过旧？）');
    }
    // ⚠️ 两个导出都要，缺一不可：`jsonlTraceSink` 只是**工厂**（返回 `TraceSink`），
    // 真正让框架每run 收尾调它的是 `registerDefaultTraceSink`（与上面 inspector 那条同款）。
    // 只写前者 = 建了个 sink 变量没人用 ⇒ 静默不落盘（本仓最忌讳的那类假绿）。
    if (typeof mod.registerDefaultTraceSink !== 'function') {
      throw new Error('@migor/agentia 未导出 registerDefaultTraceSink（版本过旧？）');
    }
    mod.registerDefaultTraceSink(mod.jsonlTraceSink({ path: join(root, TRACE_LOG_REL) }));
  } catch (e) {
    // 同 registerTraceSink：挂不上是增强项缺失，不阻断 dev。**不静默** —— 打在终端上，
    // 否则「跑了一堆 run 却发现 report 没数据」会查不到原因。
    console.warn(`[agentia] trace 未落盘（${TRACE_LOG_REL}）：${(e as Error).message}`);
  }
}

// ---------- dev.config.ts（**数据**，不是逻辑） ----------

/**
 * 读 `src/dev.config.ts`。
 *
 * 口径（D8 ②）：**文件缺失 ⇒ 全部单轮**（任务型是安全默认，不会串味）。
 * 内容不合法 ⇒ **响亮告警 + 按缺省走**，绝不静默吞掉 —— 一份写错的 dev 配置
 * 让人以为「我声明了多轮」，而实际每次都是单轮，那正是本仓最忌讳的静默不一致。
 */
async function loadDevConfig(): Promise<{ config: DevConfig; warning: string | null }> {
  const file = join(root, DEV_CONFIG_REL);
  if (!existsSync(file)) return { config: {}, warning: null };
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    return {
      config: {},
      warning: `${DEV_CONFIG_REL} 读不了（${(e as Error).message}）：本次全部按单轮处理`,
    };
  }
  const raw = mod.default;
  if (raw === undefined || raw === null) return { config: {}, warning: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: {},
      warning: `${DEV_CONFIG_REL} 的 default export 必须是对象：本次全部按单轮处理`,
    };
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  let multiTurn: string[] = [];
  if (obj.multiTurn !== undefined) {
    if (Array.isArray(obj.multiTurn) && obj.multiTurn.every((x) => typeof x === 'string')) {
      multiTurn = obj.multiTurn as string[];
    } else {
      problems.push('multiTurn 必须是字符串数组');
    }
  }
  let workdir: string | undefined;
  if (obj.workdir !== undefined) {
    if (typeof obj.workdir === 'string' && obj.workdir.length > 0) workdir = obj.workdir;
    else problems.push('workdir 必须是非空字符串');
  }
  let budget: DevConfig['budget'];
  if (obj.budget !== undefined) {
    if (obj.budget && typeof obj.budget === 'object' && !Array.isArray(obj.budget)) {
      const b = obj.budget as Record<string, unknown>;
      budget = {};
      if (b.maxCostUsd !== undefined) {
        if (typeof b.maxCostUsd === 'number' && Number.isFinite(b.maxCostUsd) && b.maxCostUsd > 0) {
          budget.maxCostUsd = b.maxCostUsd;
        } else problems.push('budget.maxCostUsd 必须是正数');
      }
      if (b.maxTotalTokens !== undefined) {
        if (
          typeof b.maxTotalTokens === 'number' &&
          Number.isSafeInteger(b.maxTotalTokens) &&
          b.maxTotalTokens > 0
        ) {
          budget.maxTotalTokens = b.maxTotalTokens;
        } else problems.push('budget.maxTotalTokens 必须是正整数');
      }
    } else {
      problems.push('budget 必须是对象');
    }
  }
  return {
    config: {
      multiTurn,
      ...(workdir === undefined ? {} : { workdir }),
      ...(budget === undefined ? {} : { budget }),
    },
    warning:
      problems.length > 0 ? `${DEV_CONFIG_REL}：${problems.join('；')}（这几项按缺省走）` : null,
  };
}

// ---------- 能力菜单 ----------

/**
 * 列出可收窄的能力 token。
 *
 * token 就是**能力文件夹名**（`discover.ts`：`{ provide: name, useClass: exported }`），
 * 所以「读目录」和「装配收集」用的是同一个常量 —— 两侧不会漂移。
 *
 * 为什么要与 `container.registered()` **取交集**：目录里可能有个文件夹没有入口
 * （discover 会跳过并告警），或者它的 provider 被显式 `providers` 顶掉了。
 * 不取交集的话，面板会列出一个选了也没用的 token —— 那就是个静默的空操作。
 */
function listCapabilities(
  app: RunnerApp,
  dirs: unknown,
): { names: string[]; warning: string | null } {
  if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== 'string')) {
    return {
      names: [],
      warning:
        'src/app.ts 没导出 CAPABILITY_DIRS（能力文件夹名数组）—— 能力选择器不可用，全量菜单照常。' +
        '新模板会带上它；老工程按迁移说明补一行即可。',
    };
  }
  let registered: Set<string>;
  try {
    registered = new Set(app.container.registered().map((t) => String(t)));
  } catch (e) {
    return { names: [], warning: `读容器注册表失败（${(e as Error).message}）：能力选择器不可用` };
  }
  const names = new Set<string>();
  for (const d of dirs as string[]) {
    const abs = join(root, 'src', d);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = join(abs, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        // 软链目录（pnpm store / monorepo）的 isDirectory() 为 false —— 解引用后再判，
        // 否则真能力目录被静默漏掉（discover.ts 的 isDirLike 同一条教训）
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      if (registered.has(e.name)) names.add(e.name);
    }
  }
  return { names: [...names].sort(), warning: null };
}

// ---------- 装配 ----------

interface BuildResult {
  app: RunnerApp;
  capabilities: string[];
  multiTurn: string[];
  warning: string | null;
  workdir: string;
  /** **生效的**预算护栏（DEFAULT_BUDGET ⊕ dev.config.budget）—— 父进程/面板照它显示 */
  budget: { maxCostUsd: number; maxTotalTokens: number };
}

/** 用户的 app 模块（import 缓存命中，重复 import 不重跑模块体） */
let appModule: AppModule | null = null;

async function importAppModule(): Promise<AppModule> {
  if (appModule) return appModule;
  const entry = join(root, APP_ENTRY_REL);
  if (!existsSync(entry)) {
    throw new Error(
      `找不到 ${APP_ENTRY_REL}。dev 环需要它导出 createAgentApp 工厂（装配与启动分离）——` +
        '老工程按 CHANGELOG 的迁移说明，把 main.ts 里 createApp(...) 那一段整体搬进 app.ts 并包成工厂。',
    );
  }
  const mod = (await import(pathToFileURL(entry).href)) as AppModule;
  if (typeof mod.createAgentApp !== 'function') {
    throw new Error(
      `${APP_ENTRY_REL} 没有导出 createAgentApp（应为函数）。` +
        'dev 环靠它拿到「接受选项的工厂」——四个控件都要从这里喂进去。',
    );
  }
  appModule = mod;
  return mod;
}

/**
 * 启动期**验一次会话文件**（只有导出 `createSessionStore` 的工程才有这件东西）。
 *
 * 为什么必须有人验：`FileSessionStore` 对损坏的 JSON 是**响亮抛错**的（注释里承诺
 * 「不静默当成空历史」），但框架在 `runtime/run.ts` 的 `loadSession` / `appendSession`
 * 里**刻意吞掉**会话侧异常（既定口径：辅助动作不击穿 run；memory 水合同款防护，有单测钉着）。
 * 两条纪律各自都对，合起来的后果却是最坏的一种：文件一坏，历史被当成「第一轮」，
 * 而 `append` 里的 `readAll()` 同样抛 ⇒ **新历史永远写不进去**，且从头到尾一声不响。
 * ⇒ 在 dev 环（唯一能让开发者当场看见的地方）启动期主动读一次，把原因送上 warning 通道。
 *
 * 只做一次、只在启动期：run 期间不再重复读（那是 store 自己的活）。
 * 用一次性 id 触发即可 —— `readAll()` 读的是**整份**文件，id 是什么不影响解析。
 */
async function probeSessionFile(mod: AppModule): Promise<string | null> {
  if (typeof mod.createSessionStore !== 'function') return null;
  try {
    await mod.createSessionStore().load('__dev_startup_probe__');
    return null;
  } catch (e) {
    return (
      `会话文件读不出来（${(e as Error).message}）⇒ 对话历史会被当成「第一轮」，` +
      '而且之后的每一轮都写不进去（框架刻意不让会话故障打断 run，所以它不会自己报）。' +
      '按提示删掉那个文件即可重新开始一段干净的对话。'
    );
  }
}

async function build(): Promise<BuildResult> {
  const mod = await importAppModule();
  const { config, warning: configWarning } = await loadDevConfig();
  const budget = { ...DEFAULT_BUDGET, ...(config.budget ?? {}) };
  const toolSources = parseToolSources(process.env.AGENTIA_DEV_TOOL_SOURCES);
  // 缺省工作目录：dev.config 说了算，否则项目根。
  // ⚠️ **不**用 chdir 实现它（D3 已排除 A 方案）：项目根与 agent 工作目录是两件事，
  //    而 `.env` / discover 相对路径都按 cwd 解析 —— 搬 cwd 会把它们一起搬走。
  const workdir = config.workdir ?? root;

  const app = await (mod.createAgentApp as NonNullable<AppModule['createAgentApp']>)({
    ...(toolSources === null ? {} : { toolSources }),
    workdir,
  });
  const { names, warning: menuWarning } = listCapabilities(app, mod.CAPABILITY_DIRS);
  // multiTurn 里写了不存在的能力名 ⇒ 静默落空（该能力永远按单轮跑，用户却以为声明生效了）。
  // 求差集、走 warning 通道响亮说清。⚠️ 菜单本身没起来（menuWarning 在场）时**不判** ——
  // 那时 names 是空的，把每个 multiTurn 条目都报成「不认识」是噪声，真原因已在 menuWarning 里。
  const unknownTurns = (config.multiTurn ?? []).filter((n) => !names.includes(n));
  const turnWarning =
    menuWarning === null && unknownTurns.length > 0
      ? `${DEV_CONFIG_REL} 的 multiTurn 里有不认识的能力：${unknownTurns.join('、')} —— 是不是改名了？`
      : null;
  // 孤儿能力（= 被 toolSources 收窄排除的那些）：框架**自己**在 `toolkit/module.ts` 里
  // 用 `console.warn` 报这件事，而子进程的 stdio 全 inherit ⇒ 那句话只落在启动的那个终端里，
  // 面板的告警条（只读 `warning` 通道）永远看不到 —— 实测症状就是「终端滚过去就没了」。
  // 两侧数据这里都在手边（`names` = 能力文件夹名 ∩ 容器注册，`toolSources` = 收窄白名单），
  // 所以补一条进同一条通道，文案与框架那句同义。
  // ⚠️ 菜单本身没起来（`menuWarning` 在场）时不判：那时 `names` 是空的，判了只会是 0 条。
  const orphan =
    toolSources === null || menuWarning !== null
      ? []
      : names.filter((n) => !toolSources.includes(n));
  const orphanWarning =
    orphan.length > 0
      ? `能力已装配但不在 toolSources 内：${orphan.join('、')} —— 不进主菜单（模型无法直接调用），` +
        '若被其他能力的 tools 引用仍可被调用'
      : null;
  const sessionWarning = await probeSessionFile(mod);
  const warnings = [configWarning, menuWarning, turnWarning, orphanWarning, sessionWarning].filter(
    (w): w is string => w !== null,
  );
  return {
    app,
    capabilities: names,
    multiTurn: config.multiTurn ?? [],
    warning: warnings.length > 0 ? warnings.join('\n') : null,
    workdir,
    budget,
  };
}

/** 父进程经 env 传进来的能力选择（JSON 数组）；解析不了就当全量 + 告警 */
function parseToolSources(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0) {
      return v as string[];
    }
  } catch {
    /* 落到下面的告警 */
  }
  console.warn('[agentia:dev-runner] AGENTIA_DEV_TOOL_SOURCES 解析失败，本次按全量装配');
  return null;
}

// ---------- 主循环 ----------

/**
 * 常驻进程内的 app 缓存。
 *
 * 为什么工作目录变了是**进程内重建**而不是重启进程（D8 的配套形状：文件夹只起新 run）：
 * 重启一次要 ~0.67 s（其中 ~0.5 s 是 node+tsx 启动本身），而进程内重建是毫秒级。
 * 换**能力选择**则相反 —— 那条路走重启，理由是**资源回收口**而不是成本：
 * 框架没有 `AgentApp.close()`，MCP 连接器由用户代码持有，进程内反复重建会攒孤儿子进程。
 * 这两条不对称是刻意的，见计划 §D8 的第三轮补充。
 */
let current: { key: string; app: RunnerApp } | null = null;

function appKey(workdir: string, toolSources: string[] | null): string {
  return JSON.stringify([toolSources, workdir]);
}

async function ensureApp(workdir: string, toolSources: string[] | null): Promise<RunnerApp> {
  const key = appKey(workdir, toolSources);
  if (current && current.key === key) return current.app;
  const mod = await importAppModule();
  const app = await (mod.createAgentApp as NonNullable<AppModule['createAgentApp']>)({
    ...(toolSources === null ? {} : { toolSources }),
    workdir,
  });
  current = { key, app };
  return app;
}

/**
 * 在飞 run 的 AbortController（同一时刻只有一个 run —— 面板侧 `running` 已挡住并发）。
 *
 * 为什么不是「父进程直接杀子进程」：框架的 `signal` 是**协作式**的，abort 之后
 * run 以 `stopReason='aborted'` **正常返回**（不抛）⇒ trace 照常落盘。
 * 杀进程会把这次 run 的 trace 整个丢掉（trace 是收尾才 POST 的）。
 */
let currentAbort: AbortController | null = null;

/**
 * 「已经收到 `run`、还没收尾」—— 含 `currentAbort` **还没建出来**的那段窗口。
 *
 * 为什么要单独一个标志（而不是只看 `currentAbort`）：`runOnce` 的顺序是
 * `send('run-start')` → `await ensureApp(...)` → 才 `new AbortController()`。窗口内到达的
 * `run-abort` 只能看到 `currentAbort === null`，旧写法据此把它当「没在跑」**静默丢掉**
 * ⇒ run 照跑，而父进程 `ABORT_GRACE_MS`（5 s）到点会把这次**健康的** run 升级成
 * 「重启兜底」：trace 丢掉、`lastError` 写成「工具不响应 signal」（一个错误的归因）。
 */
let runInFlight = false;
/** 窗口内到达的中止请求：建完 controller 立刻补一次 `abort()`（见 `runOnce` 的 await 顺序） */
let abortRequested = false;

/** ① 增量记账事件的出口（`registerEventSink()` 建；端口没给就是 null —— 面板没开） */
let eventSink: InspectEventSink | null = null;

async function runOnce(msg: Extract<DevMessage, { type: 'run' }>): Promise<void> {
  const { request } = msg;
  send({ type: 'run-start' });
  // 从这一行起就算「在飞」—— `run-abort` 在这个窗口里必须被记住（见 runInFlight）
  runInFlight = true;
  const app = await ensureApp(request.workdir, request.toolSources);
  const { config } = await loadDevConfig();
  const budget = { ...DEFAULT_BUDGET, ...(config.budget ?? {}) };
  const ac = new AbortController();
  currentAbort = ac;
  // 装配窗口内来过的中止：此刻补上。引擎在已 abort 的 signal 上会立刻以
  // `stopReason='aborted'` 收尾 ⇒ **trace 照样落盘**（这正是「不杀进程」换来的东西）
  if (abortRequested) {
    abortRequested = false;
    ac.abort();
  }
  const opts: Record<string, unknown> = {
    maxCostUsd: budget.maxCostUsd,
    maxTotalTokens: budget.maxTotalTokens,
    signal: ac.signal,
  };
  // ① 实时右栏：**在 run 之前**挂上（框架只在运行期派发 —— 晚一步就等于整轮都收不到）。
  // 单次 run 的 `onTraceEvent` 与应用级缺省是**叠加**的（不是覆盖），所以这里挂上
  // 不会把用户在 `createApp` 里配的那个挤掉。
  if (eventSink) opts.onTraceEvent = (e: unknown) => eventSink?.send(e);
  try {
    if (request.multiTurn) {
      const mod = await importAppModule();
      if (typeof mod.createSessionStore !== 'function') {
        throw new Error(
          '开了多轮，但 src/app.ts 没有导出 createSessionStore() —— ' +
            '对话历史需要它（模板生成的是文件后端，跨进程重启接得上）。',
        );
      }
      // 会话 id 由**父进程**给（「清空对话」换的就是它）—— 不在这里就地写常量，
      // 否则面板换完 id、runner 还写旧的那本账。
      opts.session = { store: mod.createSessionStore(), id: request.sessionId };
    }
    const { result } = await app.run([{ role: 'user', content: request.prompt }], opts);
    send({
      type: 'run-done',
      traceId: result.trace?.traceId ?? null,
      ok: !result.error,
      stopReason: result.stopReason,
      error: result.error ? result.error.message : null,
      finalText: result.finalText ?? '',
    });
    // 与旧的 `tsx watch src/main.ts` 一致：回复正文打一份到终端（stdout 是 inherit 的）
    if (result.finalText) console.log(result.finalText);
    if (result.error) {
      // 中止也带结构化 error（引擎刻意如此：取消不是失败，但原因要可查）——
      // 在终端把它打成「run 失败」会让人以为是自己把工程改坏了
      if (result.stopReason === 'aborted') console.error('[agentia] run 已中止（面板点的中止）');
      else console.error(`run 失败（stopReason=${result.stopReason}）：${result.error.message}`);
    }
  } finally {
    // 只清自己那一个：并发被面板挡住了，但 abort 与收尾之间仍可能插进下一次 run
    if (currentAbort === ac) currentAbort = null;
    runInFlight = false;
    abortRequested = false;
  }
}

async function main(): Promise<void> {
  // ⚠️ 顺序不能换：sink 必须早于用户 app 的 import（createApp 构造期对 defaultSinks 快照）
  await registerTraceSink();
  // 落盘 sink（档 A）：同样必须早于 import —— 它也是 defaultSinks 的一员。
  await registerJsonlSink();
  // 增量出口只是个 HTTP 出口（不碰框架注册表），但同样在这里建：一个进程一次。
  registerEventSink();
  let built: BuildResult;
  try {
    built = await build();
  } catch (e) {
    // 装配失败不是「run 失败」：dev 环本身坏了，面板要能把原因显示出来（不静默）
    send({ type: 'run-error', message: (e as Error).message });
    console.error(`[agentia] dev runner 装配失败：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const toolSources = parseToolSources(process.env.AGENTIA_DEV_TOOL_SOURCES);
  current = { key: appKey(built.workdir, toolSources), app: built.app };
  send({
    type: 'ready',
    capabilities: built.capabilities,
    multiTurn: built.multiTurn,
    defaultWorkdir: built.workdir,
    budget: built.budget,
    warning: built.warning,
  });

  process.on('message', (raw: unknown) => {
    const msg = raw as DevMessage;
    if (msg?.type === 'shutdown') {
      process.exit(0);
    }
    if (msg?.type === 'run-abort') {
      // 两条：controller 已建 ⇒ 直接 abort；还在装配窗口里 ⇒ 记下来、建完立刻补
      // （父进程已挡住「没在飞还发中止」，这里是第二道 —— 但它**不能**把在飞的请求丢掉）
      if (currentAbort) currentAbort.abort();
      else if (runInFlight) abortRequested = true;
      return;
    }
    if (msg?.type === 'run') {
      void runOnce(msg).catch((e: unknown) => {
        // 装配/启动就失败时 `runOnce` 的 finally 还没轮到 ⇒ 在这里把在飞标志落下来，
        // 否则下一个「中止」会被当成「上一个 run 的」记进 abortRequested（张冠李戴）
        runInFlight = false;
        abortRequested = false;
        send({ type: 'run-error', message: (e as Error).message });
        console.error(`[agentia] run 起不来：${(e as Error).message}`);
      });
    }
  });

  // 父进程没了就跟着走（避免留下孤儿 runner 占着端口）
  process.on('disconnect', () => process.exit(0));
}

void main();
