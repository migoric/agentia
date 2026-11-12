/**
 * dev 环的**协议单源**：面板 ⇄ `dev.ts` ⇄ runner 三方的消息形状都在这里。
 *
 * 为什么单独一个文件：同一批字段要在三个地方各自被读到（HTTP body 校验、IPC 收发、
 * 面板渲染），散着写就是三份会漂的副本。这里是唯一一份，三方 import 同一个类型。
 *
 * ⚠️ 本文件**只放类型与常量**，不放逻辑 —— 它同时被 CLI 进程与 runner 子进程 import，
 * 任何副作用都会在子进程里被跑一遍。
 */

// ---------- 面板 → dev.ts（POST /run） ----------

/**
 * 一次 run 的四个控件（D9 那张表）：能力选择 / 多轮开关 / 目标文件夹 / prompt。
 *
 * 四个**都是 per-run 的输入**，但落到哪一层不同（能力选择与文件夹是 `createApp` 的
 * 输入 ⇒ 换它们要重建 app；prompt 与多轮是 `app.run` 的输入 ⇒ 只起新 run）。
 */
export interface RunRequest {
  /** 用户输入（必填，非空） */
  prompt: string;
  /** 目标工作目录（绝对路径）；不传 = dev.config 的 workdir ?? 项目根 */
  workdir?: string;
  /** 能力选择（token 白名单）；不传 = 全量 */
  toolSources?: string[];
  /** 多轮开关；不传 = 所选能力声明的 OR */
  multiTurn?: boolean;
}

/** POST /run 的应答 */
export interface RunAck {
  accepted: boolean;
  /** 这次是否为了换 app 级选项**重启了 runner 进程**（D8：换 toolSources 必重启） */
  restarted: boolean;
}

// ---------- runner ⇄ dev.ts（IPC） ----------

/** runner → dev.ts */
export type RunnerMessage =
  /** 装配完毕（或装配失败），可以收 run 指令了 */
  | {
      type: 'ready';
      /** 能力菜单（token = 能力文件夹名） */
      capabilities: string[];
      /** `dev.config.ts` 里声明多轮的能力 */
      multiTurn: string[];
      /**
       * 缺省工作目录（`dev.config.ts` 的 `workdir` ?? 项目根）。
       * 由 runner 报上来而不是 dev.ts 自己读 —— `dev.config.ts` 是用户工程里的 TS，
       * 只有跑在用户工程里的那个进程读得动（读了也算「同一份数据只读一处」）。
       */
      defaultWorkdir: string;
      /**
       * **生效的**预算护栏（`DEFAULT_BUDGET` ⊕ `dev.config.ts` 的 `budget`）。
       *
       * 为什么必须报上来：面板要显示「实际生效的那份」。父进程自己算一遍不行 ——
       * 解析 `dev.config.ts` 的代码只在 runner 里（同 `defaultWorkdir` 的理由），
       * 而两边各算一次就会漂：漂开的症状是面板显示 $1、实际按 `dev.config.ts` 里的 $10 跑。
       */
      budget: { maxCostUsd: number; maxTotalTokens: number };
      /**
       * dev 环的**响亮告警**（能跑，但有东西不对劲）：`dev.config.ts` 读/解析失败、
       * `app.ts` 没导出 `CAPABILITY_DIRS`（能力选择器不可用）、会话文件读不出来等。
       * 面板原样显示 —— 本仓最忌讳的就是这类「静默降级」。
       */
      warning: string | null;
    }
  /** 已经开始跑（面板据此禁用运行按钮） */
  | { type: 'run-start' }
  /** 跑完了。`traceId` 取自 `result.trace.traceId`（trace 本身走 POST /ingest 另路） */
  | {
      type: 'run-done';
      traceId: string | null;
      ok: boolean;
      stopReason: string;
      error: string | null;
      /** 回复正文。trace 上**没有**它（`engine/loop.ts` 只把它当返回值）—— 面板要显示就得由这里带 */
      finalText: string;
    }
  /** run 都没起来（app.ts 缺失 / 装配抛错）—— 这不是「run 失败」，是 dev 环本身坏了 */
  | { type: 'run-error'; message: string };

/** dev.ts → runner */
export type DevMessage =
  | {
      type: 'run';
      request: {
        prompt: string;
        workdir: string;
        multiTurn: boolean;
        /**
         * 这次 run 用哪个会话 id —— **由父进程填**，不是面板传上来的。
         *
         * 为什么`RunRequest`（面板 → dev.ts）里**没有**这一项（曾经有，是条死腿：
         * 协议声明了、面板也发了，而 HTTP 层的 `parseRunRequest` 根本不解析它 ——
         * 2026-09-22 复核删掉）：面板只是视图，它那份 `sessionId` 是**读来的**；
         * 「清空对话」换的是父进程手里这个值。若让它成为请求参数，一个停留在
         * 「清空」之前的页面（或手工改 URL）就能把新 run 写回**旧**会话 ⇒
         * 刚清掉的对话自己回来，正是本仓最忌讳的静默不一致。
         * 单一真源 = 父进程（跨 runner 重启与跨面板刷新都稳定）。
         */
        sessionId: string;
        toolSources: string[] | null;
      };
    }
  /**
   * 中止在飞的 run（§6 待定 5 的后半：「显式 kill 按钮」）。
   *
   * 为什么走 IPC 让 runner 自己 abort，而不是父进程杀子进程：框架的
   * `RunInvocationOptions.signal` 是**协作式**的 —— 中止后在回合边界以
   * `stopReason='aborted'` **正常返回**（不抛），于是**trace 照常落盘**。
   * 杀进程那条路会把这次 run 的 trace 整个丢掉（trace 是收尾才 POST 的）。
   */
  | { type: 'run-abort' }
  | { type: 'shutdown' };

// ---------- 面板读的 dev 环状态（GET /api/dev） ----------

export interface DevState {
  /**
   * false = 这个 inspector 不是被 `agentia dev` 起的（没有 runner）。
   * 面板据此**不显示输入条** —— 不做空壳（§6 的「没配 session 也不出现」同一条纪律）。
   */
  available: boolean;
  /** 项目根（= 子进程 cwd；`loadEnvFile()` 与 discover 相对路径都按它解析） */
  projectRoot: string;
  home: string;
  /** 能力菜单（token 列表，升序） */
  capabilities: string[];
  /** 声明多轮的能力 */
  multiTurn: string[];
  /** dev 环的响亮告警（读配置/列菜单时的问题）；没有则 null */
  warning: string | null;
  /** 缺省工作目录（`dev.config.ts` 的 `workdir` ?? 项目根） */
  defaultWorkdir: string;
  /**
   * 缺省预算护栏（D9 评审补充）：`POST /run` 让「点一下就跑一次真 agent」成立，
   * 而真 agent 真花钱 —— 一个跑偏的循环就是一张账单。runner 替「还没想到要配」
   * 的开发者先把护栏立上（框架既有机制：`maxCostUsd` / `maxTotalTokens`）。
   */
  budget: { maxCostUsd: number; maxTotalTokens: number };
  /**
   * 当前 dev 会话 id（面板的「清空对话」就是把它换成下一个；见 `RunRequest.sessionId`）。
   * 面板**必须**用它去读 `/api/session`，不能自己拼字面量 —— 否则清空后显示的是旧对话。
   */
  sessionId: string;
  running: boolean;
  /** 最近一次 runner 启动失败 / run 失败的原因；面板显示，不许静默 */
  lastError: string | null;
}

// ---------- 增量记账事件（框架 `onTraceEvent` 的原样转发） ----------

/**
 * 框架 `core/trace.ts` 的 `TraceRecordEvent` 在协议里的**结构性镜像**。
 *
 * 为什么原样转发而不是在 CLI 侧重新包装成「精简事件」：框架已经钉着一条不变量 ——
 * 按 `seq` 升序把同一次 run 的全部事件应用到 `span.begin` 建出的 span 上，结果**逐字等于**
 * 收尾的 `snapshot()`（`tests/engine/trace-events.test.ts`）。面板照这条规则折回就得到
 * 与收尾一致的树，**不需要**知道任何「哪些字段重要」的本地判断；包装一层反而多一处会漂的口径。
 *
 * 为什么形状在协议文件里再写一遍而不是 `import type` 框架：CLI 零运行时依赖，
 * 且框架实例来自**用户工程**（`req.resolve('@migor/agentia')`），不是 CLI 的依赖。
 */
export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** span 的**增量形状**：结构与框架的 `Span` 一致（`span.begin` 给初值，其余事件各补一摊） */
export interface TraceSpanLike {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  kind: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  error?: { type?: string; message?: string };
  links?: unknown[];
  usage?: UsageLike;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; time?: number; body?: unknown }>;
}

/** 一条增量记账事件（与框架 `TraceRecordEvent` 同形的五类 + `seq`） */
export type TraceRecordEventLike =
  | { seq: number; type: 'span.begin'; span: TraceSpanLike }
  | {
      seq: number;
      type: 'span.end';
      spanId: string;
      endedAt: number;
      status: string;
      error?: { type?: string; message?: string };
      usage?: UsageLike;
    }
  | {
      seq: number;
      type: 'span.event';
      spanId: string;
      event: { name: string; time?: number; body?: unknown };
    }
  | {
      seq: number;
      type: 'span.attribute';
      spanId: string;
      key: string;
      value: string | number | boolean;
    }
  | { seq: number; type: 'span.link'; spanId: string; link: unknown };

// ---------- dev.ts → 面板（SSE 命名事件 `dev`） ----------

export type DevEvent =
  | {
      kind: 'run-start';
      prompt: string;
      workdir: string;
      toolSources: string[] | null;
      multiTurn: boolean;
    }
  | {
      kind: 'run-done';
      traceId: string | null;
      ok: boolean;
      /**
       * 收尾原因（`end_turn` / `aborted` / `budget_exceeded` / …）。
       *
       * ⚠️ 面板**必须**先看它、再看 `ok` —— 被中止时 `ok` 是 **false**：
       * 引擎的 `abortedResult()` 刻意带上结构化 `error`（取消不是失败，但原因要可查，
       * 见 `engine/loop-result.ts`），而 `ok = !result.error`。所以「只看 ok」会把
       * 「我按了中止」显示成「run 失败」—— 判别中止的**唯一**判据是 `stopReason`。
       */
      stopReason: string;
      error: string | null;
      /** 回复正文（面板在输入条下方显示；trace 上没有它） */
      finalText: string;
    }
  /** 换 app 级选项 ⇒ 重启 runner 进程（D8 第三轮补充：理由是回收口，不是成本） */
  | { kind: 'runner-restart'; reason: string }
  /**
   * runner 装配完成、可以接 run 了。
   *
   * 为什么必须有这一条（而不是让面板自己去查）：面板在加载时**只**查一次 `/api/dev`，
   * 而 runner 装配要晚 1~2 秒 —— 那次查询拿到的 `capabilities` 还是父进程的初值 `[]`。
   * 没有这个事件，面板的能力选择器就会**空着且没有任何解释**，一直等到用户先跑一次
   * （`run-done` 才会触发刷新）。生命周期里有 restart / error / run-start / run-done
   * 却没有「就绪」，本身就是缺一环。
   */
  | { kind: 'runner-ready' }
  | { kind: 'runner-error'; message: string }
  /**
   * run **在飞期间**的一条增量记账事件（`span.begin` / `span.end` / `span.event` /
   * `span.attribute` / `span.link`）—— 右栏的树靠它「长出来」。
   *
   * 为什么要有这条：`playTrace` 此前唯一的调用点在 `open()`，而 `open()` 跑在 run
   * **收尾之后**（trace 经 `POST /ingest` 回到面板才会触发）⇒ 一次十几秒的 run 期间右栏
   * 是死的（只有一句「正在跑…」）。框架的增量出口（`onTraceEvent`，0.8.3）本来就是为
   * 这类消费者准备的，计划 §D7 的评审补充也点名要求接上（P1b）。
   *
   * ⚠️ 两条纪律：
   * - **不保证送达**（与框架同名出口一致）：宿主自己的流断了就断了。所以面板折回的这棵树
   *   是**临时**的 —— 收尾那份整棵 trace 回来时**覆盖**它，缺的 span 由那份补齐。
   * - 它是**观察**，不是控制：丢了不影响 run，也不影响收尾的 trace。
   */
  | { kind: 'trace-event'; event: TraceRecordEventLike };

// ---------- CLI 侧记账（面板发出去的东西，CLI 自己记一笔） ----------

/** 会话文件里的一条消息（只取面板要用的两个字段，不把框架类型搬进 CLI） */
export interface SessionMessageLike {
  role?: unknown;
  content?: unknown;
}

/**
 * 每条 run 的 dev 侧元信息。
 *
 * 为什么由 CLI 记账而不是进 trace：`toolSources` 是**数组**、`workdir` 走的是 DI
 * （D3-D），两个都上不了 `runConfigSnapshot` 的标量表。而它们本来就是**面板自己
 * 发出去的** ⇒ CLI 侧记一笔即可（丢的只是「生产环境的 run 也带这条」，而本方案要
 * 解决的本来就是开发期的可见性）。P3 若改走 D3-C，workdir 那项会同时来自
 * `config.workdir`。
 */
export interface RunNote {
  prompt: string;
  workdir: string;
  /** null = 全量（与 `toolSources` 的实参同义） */
  toolSources: string[] | null;
  multiTurn: boolean;
  /**
   * 这一轮模型最后回的那段正文 —— **唯一一份能在收尾之后重新取回的回复**。
   *
   * 为什么放这里：`finalText` 是 `app.run()` 的**返回值**，`engine/loop.ts` 不把它写进
   * trace（trace 是执行账，不是对话账），所以它只活在 `run-done` 的那一帧 SSE 里。
   * 面板此前就是这么用的（`state.reply = ev.finalText`）⇒ **切到别的 run、或页面重开一次，
   * 回复就没了**，而用户会以为 agent 没回。note 与 run 同生命周期、同一条淘汰线
   * （`MAX_NOTES`），是它唯一合理的落点。
   *
   * 缺省（undefined）= 这一轮没有回复（失败 / 中止 / 空回复），与空串同义 ——
   * 不写 `''` 是为了「没有这个键」与「回复是空串」在磁盘/JSON 上仍可区分。
   */
  finalText?: string;
}

// ---------- 缺省预算护栏 ----------

/**
 * runner 的缺省预算。刻意**保守**：$1 / 20 万 token 够跑完一次正常调试，
 * 又不足以让一个跑偏的循环刷出账单。可在 `dev.config.ts` 覆盖。
 */
export const DEFAULT_BUDGET = { maxCostUsd: 1, maxTotalTokens: 200_000 } as const;

/** dev 环读取的用户配置文件名（相对项目根的 `src/`）—— **数据**，不是逻辑（D8 ②） */
export const DEV_CONFIG_REL = 'src/dev.config.ts';
/** 用户 `app.ts` 的相对路径（模板生成；老工程需要按迁移说明拆出来） */
export const APP_ENTRY_REL = 'src/app.ts';
/** 会话文件（对话型能力的可选件）相对项目根的位置 */
export const SESSION_REL = '.agentia/session.json';
/**
 * dev 环**当前会话 id** 的落盘位置（相对项目根）。
 *
 * ⚠️ 这是 CLI 自己的状态，**不是** `session.json` 的一部分 —— `session.json` 是
 * `SessionStore` 的账，面板对它是**只读**的（写它会造出「面板显示的对话」与
 * 「模型真正看到的对话」不一致）。而「当前用哪个 id」纯粹是 dev 环的界面状态，
 * 所以另存一个小文件。落盘而不是只放内存：否则重启 `npm run dev` 之后，
 * 用户刚「清空」掉的对话会**自己回来**（那是最典型的静默不一致）。
 */
export const SESSION_ID_REL = '.agentia/dev-session-id';
/**
 * dev 环**落盘 trace** 的位置（相对项目根）。
 *
 * 为什么与 `session.json` 同目录：`.agentia/` 已被脚手架 gitignore（`templates/gitignore`），
 * 它就是 dev 环的本机状态目录 —— 落在这里的东西不进版本库、不用再问一次「要不要 ignore」。
 *
 * 文件格式 = `jsonlTraceSink` 的格式（一行一条**裸** `Trace`），而那正是 CLI 四个命令的
 * **输入**：`agentia report` / `diff` / `harvest` / `export`（`src/integrations/file-sink.ts`
 * 的头注逐字点名了前三个，`export` 是R8-P3b 加的同族）。⇒ dev 环跑过的 run 直接可被它们读。
 *
 * ⚠️ **只增不减**：刻意不轮转、不自动清（dev 单条 trace 以百 KB 计；真要清是用户自己
 * `rm`）。要长期开着一个 dev 环的得知道这件事 —— 写在 `usage-guide.md` §2.2。
 */
export const TRACE_LOG_REL = '.agentia/traces.jsonl';
/** dev 环**初始** sessionId（面板「清空」后依次变成 `dev-2` / `dev-3` …） */
export const DEV_SESSION_ID = 'dev';
