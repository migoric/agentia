/**
 * dev 命令：本地 inspector 面板 + **常驻 runner 子进程**。
 *
 * ## 形状（D9(d)：harness 在 CLI 里，用户工程没有 dev 文件）
 *
 * ```
 *   dev.ts（CLI，本文件）                        ← 唯一的进程所有者
 *     ├─ inspector 服务（面板 + POST /run）       ← 面板的读写入口
 *     ├─ dev-watch.ts：fs.watch(src/**) + fs.watch(项目根, 只认 .env)  ← 「代码变了要重启」的**唯一**触发源
 *     └─ 子进程：node <tsx> dist/dev-runner.js     ← 常驻；import 用户的 src/app.ts 并驱动它
 *          └─ 用户代码 → trace 经 sink POST /ingest 回面板
 * ```
 *
 * ⚠️ 子进程是 `node <tsx/cli>`，**不是** `npx tsx` —— 后者会吞掉 IPC 通道，理由见
 * `dev-child.ts` 的 `resolveTsxCli()`（那不是一条风格偏好，是一次实测出来的静默故障）。
 *
 * 与旧实现的三个区别，都记在 docs/plans/2026-09-22-dev-debug-loop.md：
 * 1. **watch 收编进 dev 环**。旧实现把「文件变 → 重跑」交给 `tsx watch`，而「面板 → 重启」
 *    要归 dev.ts ⇒ 两个触发源就有竞态（保存的瞬间恰好点了运行 = 双双 spawn、端口/SSE 串台）。
 *    现在只有一条路径、一个所有者；顺带解掉「`.md` 不在 tsx 的 import 图里所以不被 watch」。
 *    （C 阶段起 watch 件住在 `dev-watch.ts`，本文件只在启动时接线。）
 * 2. **子进程跑 runner 而不是用户的 main.ts**。四个控件（能力选择 / 多轮 / 工作目录 /
 *    prompt）全是 `createApp` / `app.run` 的选项，而**调用者**能设它们 —— CLI 成了调用者，
 *    于是用户工程里一个 dev 文件都不需要。
 * 3. **trace sink 在 runner 里注册**（不再用 `NODE_OPTIONS=--import` 的 preload）：
 *    CLI 代码本来就在子进程里了，那套注入的存在理由消失了。
 *
 * ## 本文件只剩「薄接线」（B 阶段，方案 docs/plans/2026-09-23-cli-structure.md §3 B；
 * ## C 阶段把 watch 件与子进程原语切到 dev-watch.ts / dev-child.ts，见 §3 C）
 *
 * 曾经这里有一台隐式状态机（15 个 `let`、40 处写入点、15 个入口；F1/F4/G1/G2 都是它的
 * 直接后果）。现在**所有「什么情况下该做什么」的判定都在 `dev-machine.ts` 的 `update()`
 * 里**：每个入口把现实翻译成事件（`DevEventIn`）派发给机器，机器返回新状态与效果清单
 * （`DevEffect[]`），本文件只负责**执行**效果 —— spawn / kill / IPC / HTTP / fs / 计时器。
 *
 * 接线层的纪律：
 * - **进程身份归属在这里判**（机器看不到句柄）：迟到的消息只可能来自已经不在台上的
 *   进程，一律不派发给机器；唯一例外是过时进程的 exit 仍要把它**自己那次 spawn 的
 *   Promise** 收掉（否则启动期被杀的旧进程会把 `await` 它的人永远挂住）。
 * - `restart` 效果自带「串行链 + 起跑时广播 runner-restart」（旧语义：广播发生在链任务
 *   真正起跑时，且 closing 后整条链跳过 —— 所以它不是一条 emit 效果）。
 * - `reject` / `send-ipc` / `arm-abort-timer` / `pick-folder` / `exit-now` 只出现在
 *   专用流程里，由各 handler 就地解释（要能中断效果序列、把 reject 翻译成 HttpError）。
 *
 * ## 什么会重启 runner
 *
 * | 变化 | 动作 | 为什么 |
 * |---|---|---|
 * | 能力选择（`toolSources`） | **重启进程** | 它是 `createApp` 的输入；而框架没有 `AgentApp.close()`，进程内反复重建会攒孤儿 MCP 子进程 ⇒ 进程边界是唯一的回收口（D8 第三轮补充） |
 * | 代码 / 文本资产变更 | **重启进程** | Node 的 import 按 URL 缓存，常驻进程收不到源码改动 |
 * | 工作目录 / prompt / 多轮 / 会话 id | **不重启** | 目录是 per-run 输入，runner 内部按目录重建 app（毫秒级）；prompt / 多轮 / 会话 id 本来就是 per-run |
 * | 面板点「中止」 | **先不重启**（优雅 abort） | 框架的 `signal` 是协作式的 ⇒ 中止后 run 以 `stopReason='aborted'` 正常返回、**trace 保得住**；但工具若不读 `signal` 就没人理 ⇒ 5 s 后升级为重启进程兜底（`ABORT_GRACE_MS`），否则 run 相位永远不落、面板锁死 |
 * | 面板点「清空对话」 | **不重启** | 只是换 sessionId（+ 落盘），下一次 run 换个 id 而已 |
 *
 * 面板是增强项，任何一步失败都只告警、不阻断 dev：inspector 起不来时**降级**成
 * 「首次 run + 改代码自动重启」（不 spawn 面板，但 runner 照起 —— 见 `startPanel`），
 * sink 挂不上 / runner 重启失败之类一律走**响亮**通道（`warning` / `lastError` / 告警条）。
 * ⚠️ 承诺的是「降级 + 说清」，不是「假装没事」：告警文案必须写出**这次少了什么**。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KILL_GRACE_MS, killTree, resolveTsxCli } from './dev-child.js';
import { type ClaimResult, claimWriterLock, releaseWriterLock } from './dev-lock.js';
import {
  createInitialState,
  type DevEffect,
  type DevEventIn,
  type DevMachineState,
  READY_TIMEOUT_MS,
  resolveWorkdir,
  runGateFlags,
  startupExitMessage,
  update,
} from './dev-machine.js';
import {
  APP_ENTRY_REL,
  DEV_SESSION_ID,
  type DevState,
  type RunAck,
  type RunRequest,
  type RunnerMessage,
  SESSION_ID_REL,
  SESSION_REL,
  type SessionMessageLike,
  TRACE_LOG_REL,
} from './dev-protocol.js';
import { watchRootEnvFiles, watchTree } from './dev-watch.js';
import { HttpError, startInspector, type InspectorServer } from './inspector.js';
import { killActivePickers, pickFolderNative } from './native-pick.js';

// nextSessionId 已随状态机迁到 dev-machine（纯件）；shouldWatch / watchTree /
// watchRootEnvFiles 已随 C 阶段迁到 dev-watch —— 本文件继续 re-export 它们的出口：
// packages/cli/test/panel-logic.test.mjs 从 dist/dev.js 取这些纯件，出口不能断。
export { nextSessionId } from './dev-machine.js';
export { shouldWatch, watchRootEnvFiles, watchTree } from './dev-watch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'dev-runner.js');

/**
 * 收尾的**硬上限**：超过它就硬退。
 *
 * 必须 > `KILL_GRACE_MS`（3 s）—— 上限的本意是兜「面板还有连接没关掉」这类卡死，
 * 而不是替 SIGKILL 兜底计时器的班（那个兜底只在宽限期到点时才会发出来）。
 */
const SHUTDOWN_DEADLINE_MS = KILL_GRACE_MS + 2_000;

/**
 * @param argv 透传给 dev 环的参数：`agentia dev -- "问题"` 时 argv[0] 是**首次 run 的 prompt**。
 *   脚手架把 `npm run dev` 指到本命令，而工程 README 文档化的用法正是
 *   `npm run dev -- "你的问题"` —— 不能把参数吃掉。
 *   （与旧实现一致；区别是不给参数时**不再**自动跑一次默认 prompt —— 面板就是输入口。）
 */
export function devServer(argv: string[] = []): number {
  const projectRoot = process.cwd();
  const entry = join(projectRoot, APP_ENTRY_REL);

  if (!existsSync(entry)) {
    // 破坏性模板变更的**响亮**失败点：老工程的 main.ts 里有 createApp，但没有 app.ts。
    // 静默降级成「面板能用但什么都驱动不了」是最糟的形状，所以这里直接不启动。
    const legacy = join(projectRoot, 'src', 'main.ts');
    if (existsSync(legacy)) {
      console.error(
        `错误：当前工程的 src/main.ts 存在，但没有 ${APP_ENTRY_REL}。\n` +
          'dev 环需要 app.ts 导出一个接受选项的工厂（装配与启动分离），这样 CLI 才能替你设\n' +
          '「能力选择 / 工作目录 / 多轮 / prompt」这四个控件。\n' +
          '迁移是机械的：把 main.ts 里 createApp(...) 那一段整体搬进 src/app.ts 并包成\n' +
          'export function createAgentApp(opts) { … }，main.ts 只留「读 .env → 调工厂 → 处理 result.error」。\n' +
          '见 CHANGELOG 的迁移小节，或直接照新模板（agentia create 生成的那份）改。',
      );
      process.exitCode = 1;
      return 1;
    }
    console.error(
      '错误：当前目录下未找到 src/app.ts，请先用 agentia create <name> 创建项目（或 cd 到项目根目录）',
    );
    process.exitCode = 1;
    return 1;
  }

  // ---------- 接线层持有的句柄（不进机器状态：不可序列化，机器只管「相位 + 数据」） ----------
  let inspector: InspectorServer | null = null;
  /**
   * 面板端口（0 = 没起来）。单独存一份是因为 `inspector` 只在 `startPanel` 里赋值，
   * 而 TS 的控制流分析看不到闭包里的赋值 —— 外面读 `inspector.port` 会被窄成 `null`。
   */
  let panelPort = 0;
  let stopWatch: (() => void) | null = null;
  /** 项目根那份 `.env` / `.env.local` 的 watch —— 与 `stopWatch` 是**两个**，两者都要收 */
  let stopEnvWatch: (() => void) | null = null;
  /** 当代子进程句柄（机器状态的 `child` 相位对应的实物；身份归属判定靠它） */
  let currentProc: ChildProcess | null = null;
  /** 中止在飞 run 的兜底计时器（机器侧对应 `run: 'aborting'` 相位 + arm/disarm 效果） */
  let abortTimer: NodeJS.Timeout | null = null;
  /** 重启串行化：两次重启不能交叠（否则会留下没人管的子进程） */
  let chain: Promise<void> = Promise.resolve();
  /** dev token（D0）：每个 dev 会话一个，进程退出即失效 */
  const token = randomBytes(16).toString('hex');

  // ---------- 写者锁（同一工程第二个 dev 实例） ----------

  /**
   * 锁挨着**它保护的那个文件**放：`dev-runner` 往 `.agentia/traces.jsonl` 追加，
   * 锁就叫 `.agentia/traces.jsonl.lock`（`cat` 一下就知道被谁占着）。
   *
   * ⚠️ 由**父进程**持锁，不是 runner：runner 每次改代码都要重启，拿子进程 pid 做判据
   * 会把「自己的下一世」当成「另一个实例」—— 每次热重载都误报一次，比不报更坏
   * （人会学会无视它）。「一个 dev 实例」的身份是父进程，它跨 runner 重启不变。
   */
  const lockPath = join(projectRoot, `${TRACE_LOG_REL}.lock`);
  let writerLock: ClaimResult = { owned: false, warning: null };

  // ---------- 会话 id（面板的「清空对话」） ----------

  /**
   * 当前会话 id 的初值：从 `.agentia/dev-session-id` 读，读不到就用 `DEV_SESSION_ID`。
   *
   * 为什么要落盘：只放内存的话，用户「清空对话」之后重启 `npm run dev`，
   * 刚清掉的那段对话会**自己回来** —— 静默不一致。
   * 为什么另存一个文件而不是写进 `session.json`：后者是 `SessionStore` 的账，
   * 面板对它是只读的（见 `readSession` 的注释）。
   */
  const readSessionId = (): string => {
    try {
      const raw = readFileSync(join(projectRoot, SESSION_ID_REL), 'utf8').trim();
      return raw.length > 0 ? raw : DEV_SESSION_ID;
    } catch {
      // 文件不存在 = 从没用过「清空」⇒ 初始 id。这里**不该**告警（首次运行是常态）
      return DEV_SESSION_ID;
    }
  };

  const writeSessionId = (id: string): void => {
    try {
      mkdirSync(join(projectRoot, '.agentia'), { recursive: true });
      writeFileSync(join(projectRoot, SESSION_ID_REL), `${id}\n`);
    } catch (e) {
      // 写不下去 ⇒ 换 id 只在本次进程有效（重启会退回旧 id）。响亮说清，不静默降级。
      console.warn(
        `[agentia] 会话 id 落盘失败（${(e as Error).message}）：本次「清空对话」在重启 dev 后会失效`,
      );
    }
  };

  // ---------- 状态机 ----------
  // 全部可变状态收敛在这一个对象里（15 个 let → DevMachineState 的显式字段）；
  // 迁移只经 update()，写入点只有 dispatch 与各 handler 里的 `state = r.state`。

  let state: DevMachineState = createInitialState({ projectRoot, sessionId: readSessionId() });

  const clearAbortTimer = (): void => {
    if (abortTimer !== null) {
      clearTimeout(abortTimer);
      abortTimer = null;
    }
  };

  /** 机器效果里只允许专用流程解释的几种（走到通用执行器就是接线错了，响亮失败） */
  const SPECIAL_ONLY = new Set([
    'reject',
    'send-ipc',
    'arm-abort-timer',
    'pick-folder',
    'exit-now',
  ]);

  /**
   * 通用效果执行器：同步效果立即按序执行；异步效果（restart / spawn-child / stop-child /
   * close-inspector）按序 await，返回的 Promise 由调用方决定等不等。
   * 异步函数在第一个 await 之前是同步执行的 ⇒ 纯同步效果序列（如 emit）保持同步语义。
   */
  const runEffects = async (effects: DevEffect[]): Promise<void> => {
    for (const e of effects) {
      switch (e.kind) {
        case 'emit':
          inspector?.emitDev(e.event);
          break;
        case 'note-run':
          inspector?.noteRun(e.traceId, e.note);
          break;
        case 'log':
          if (e.level === 'error') console.error(e.message);
          else if (e.level === 'warn') console.warn(e.message);
          else console.log(e.message);
          break;
        case 'persist-session-id':
          writeSessionId(e.id);
          break;
        case 'disarm-abort-timer':
          clearAbortTimer();
          break;
        case 'stop-watchers':
          stopWatch?.();
          stopEnvWatch?.();
          break;
        case 'kill-pickers':
          killActivePickers();
          break;
        case 'kill-child':
          if (currentProc) killTree(currentProc, 'SIGKILL');
          break;
        case 'restart':
          await restartExec(e.reason, e.toolSources);
          break;
        case 'spawn-child':
          // 首次拉起：失败归 boot-failed（机器：lastError + 终端 error + 唯一一帧 runner-error）
          await spawnExec(e.toolSources).catch((err: unknown) => {
            void dispatch({ type: 'boot-failed', message: (err as Error).message });
          });
          break;
        case 'stop-child':
          await stopChildExec();
          break;
        case 'close-inspector':
          if (inspector) await inspector.close();
          break;
        default:
          throw new Error(
            `效果「${String((e as DevEffect).kind)}」不该走通用执行器（SPECIAL_ONLY：${[...SPECIAL_ONLY].join('/')}）`,
          );
      }
    }
  };

  /** 派发一个事件：状态迁移**同步**生效，效果随后执行（返回效果的 Promise） */
  const dispatch = (ev: DevEventIn): Promise<void> => {
    const r = update(state, ev);
    state = r.state;
    return runEffects(r.effects);
  };

  // ---------- 子进程（spawn / stop / restart 三个执行器） ----------

  /**
   * 拉起一代 runner 并等到它 ready（或失败）。状态迁移全部由派发事件完成；
   * 这里只管：spawn、挂监听、归属判定、就绪超时。
   */
  const spawnExec = async (toolSources: string[] | null): Promise<void> => {
    // 每次 spawn 都重解析一次：tsx 是启动期才知道存不存在的东西（用户可能刚 `npm i -D tsx`），
    // 缓存住会让「装好了但还报找不到」这种话变成一句谎。
    const tsxCli = resolveTsxCli(projectRoot, import.meta.url);
    if (tsxCli === null) {
      throw new Error(
        '找不到 tsx —— dev 环要用它跑 TypeScript 源码（runner 会 import 你的 src/app.ts）。\n' +
          '装一个即可：npm i -D tsx（脚手架生成的工程已经声明了它；手写工程把它加进 devDependencies）',
      );
    }
    void dispatch({ type: 'child-spawned', toolSources });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // ⚠️ cwd 必须仍是**项目根**：loadEnvFile() 按 cwd 找 .env、discover 的相对路径也按 cwd。
      // 把 cwd 设成「agent 工作目录」会让 .env 静默读错 —— 工作目录走 DI 注入，不走 chdir。
      AGENTIA_DEV_ROOT: projectRoot,
      AGENTIA_INSPECT_PORT: String(inspector ? inspector.port : 0),
      AGENTIA_INSPECT_TOKEN: token,
      ...(toolSources === null ? {} : { AGENTIA_DEV_TOOL_SOURCES: JSON.stringify(toolSources) }),
    };
    // `process.execPath` + tsx 的 CLI 入口，而不是 `npx tsx`（理由见 dev-child.ts 的
    // resolveTsxCli）：直接子进程 ⇒ fd 3 的 IPC 通道可用；也顺带丢掉 npx 那一层启动开销
    // 与 spinner 噪音。
    const proc = spawn(process.execPath, [tsxCli, RUNNER], {
      cwd: projectRoot,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      // 进程组：killTree 要能一次收编整棵树（tsx 自己还会 spawn）
      detached: process.platform !== 'win32',
      env,
    });
    // 立刻挂上（不是等到 ready）：ready 之前崩掉的进程也得能被 stopChildExec 收掉，
    // 否则每失败一次就留一个孤儿 tsx 进程树。
    currentProc = proc;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (currentProc === proc) {
          // 机器：lastError = 超时文案 + kill-child 效果（就地执行 ⇒ killTree 这个孩子）
          void dispatch({ type: 'child-ready-timeout' });
          currentProc = null;
          reject(new Error(state.lastError as string));
        } else {
          // 过时进程（已被摘掉）：只收掉自己的 Promise，不碰机器状态
          reject(new Error(`dev runner 启动超时（${READY_TIMEOUT_MS} ms 内没有就绪信号）`));
        }
      }, READY_TIMEOUT_MS);

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (currentProc === proc) {
          // spawn 失败（ENOENT/EACCES）：不会再有 exit。摘掉当代（机器的迁移）+ 拒 Promise
          void dispatch({ type: 'child-spawn-failed', message: err.message });
          currentProc = null;
          reject(new Error(state.lastError as string));
        } else {
          reject(err);
        }
      });

      proc.on('message', (raw: unknown) => {
        // 归属判定用**进程身份**而不是代号：迟到的消息只可能来自已经不在台上的那个进程
        if (currentProc !== proc) return;
        const msg = raw as RunnerMessage;
        if (msg.type === 'ready') {
          void dispatch({
            type: 'child-ready',
            capabilities: msg.capabilities,
            multiTurn: msg.multiTurn,
            defaultWorkdir: msg.defaultWorkdir,
            budget: msg.budget,
            warning: msg.warning,
          });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (msg.type === 'run-start') {
          void dispatch({ type: 'ipc-run-start' });
          return;
        }
        if (msg.type === 'run-done') {
          void dispatch({
            type: 'ipc-run-done',
            traceId: msg.traceId,
            ok: msg.ok,
            stopReason: msg.stopReason,
            error: msg.error,
            finalText: msg.finalText,
          });
          return;
        }
        if (msg.type === 'run-error') {
          void dispatch({ type: 'ipc-run-error', message: msg.message });
        }
      });

      proc.on('exit', (code, sig) => {
        const how = `code=${code ?? 'null'}${sig ? `, signal=${sig}` : ''}`;
        const isCurrent = currentProc === proc;
        if (isCurrent) {
          currentProc = null;
          // 机器按相位分流：starting ⇒ 启动失败归因（**不 emit**，F4：发射权在等 spawn 的
          // 那一侧）；ready ⇒ 意外退出 + emit runner-error；closing ⇒ 静默摘除
          void dispatch({ type: 'child-exit', how });
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // 当代进程：机器刚把原因写进 lastError（exitReason，G1 判据），Promise 用它拒；
          // 过时进程：不碰机器状态（lastError 与新一代共享，写给上一代 = 张冠李戴），
          // 但它自己这次 spawn 的 Promise 必须收掉，否则启动期被杀的旧进程会挂住等待方。
          reject(
            new Error(
              isCurrent ? (state.lastError ?? startupExitMessage(how)) : startupExitMessage(how),
            ),
          );
        }
      });
    });
  };

  const stopChildExec = async (): Promise<void> => {
    const proc = currentProc;
    currentProc = null;
    if (!proc) return;
    // 子进程要没了 ⇒ 不可能再有在飞 run：机器的 child-stopped 迁移把 run 相位落下来
    // （旧代码这里漏过 running=false，症状是「中止超时 ⇒ 重启兜底」之后面板永久 409）。
    // 派完之后这个进程的 exit 到来时已不是当代 ⇒ 不会再触发归因（与旧 isCurrent 早退一致）。
    void dispatch({ type: 'child-stopped' });
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        killTree(proc, 'SIGKILL');
        done();
      }, KILL_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      killTree(proc, 'SIGTERM');
    });
  };

  /** 重启 = 停旧的 + 起新的；串行化，且把「重启」这件事广播给面板（不静默）。
   *  广播在**链任务真正起跑时**发（与旧 restart 一致）：排在后面的重启不提前广播，
   *  closing 之后整条链跳过。 */
  const restartExec = (reason: string, toolSources: string[] | null): Promise<void> => {
    chain = chain.then(async () => {
      if (state.closing) return;
      inspector?.emitDev({ kind: 'runner-restart', reason });
      await stopChildExec();
      try {
        await spawnExec(toolSources);
      } catch (e) {
        // 失败归 restart-failed（机器：lastError + 唯一一帧 runner-error）
        void dispatch({ type: 'restart-failed', message: (e as Error).message });
      }
    });
    return chain;
  };

  // ---------- 面板侧（hooks：把 HTTP 翻译成事件，把效果翻译成响应） ----------

  const devState = (): DevState => ({
    available: true,
    projectRoot,
    home: process.env.HOME ?? '',
    capabilities: state.capabilities,
    multiTurn: state.multiTurn,
    // 两个来源共用一条通道：runner 报的（dev.config / 能力菜单 / 会话文件）+
    // 父进程自己的（写者锁）。面板只读这一个字段，所以任何一侧漏接都等于「面板不说」。
    warning:
      [state.warning, writerLock.warning].filter((w): w is string => w !== null).join('\n') || null,
    defaultWorkdir: state.defaultWorkdir,
    // 生效值由 runner 报（就绪前是缺省值）—— 面板显示与实际生效必须是同一份
    budget: state.budget,
    sessionId: state.sessionId,
    running: runGateFlags(state).running,
    lastError: state.lastError,
  });

  /** 专用流程共用：从效果清单里取出 reject 并抛成 HttpError（机器的「拒绝」出面） */
  const throwIfRejected = (effects: DevEffect[]): void => {
    const rej = effects.find((e) => e.kind === 'reject');
    if (rej && rej.kind === 'reject') throw new HttpError(rej.status, rej.message);
  };

  const submitRun = async (req: RunRequest): Promise<RunAck> => {
    const workdir = resolveWorkdir(req, state.defaultWorkdir);
    // 查盘是副作用 ⇒ 接线层做，机器只拿事实判 400。响亮失败：目录写错时**不能**退回
    // 项目根 —— 那会让 agent 对着错的目录乱写（D5）。
    const workdirExists = existsSync(workdir) && statSync(workdir).isDirectory();
    const r = update(state, { type: 'ui-run-requested', req, workdir, workdirExists });
    state = r.state;
    throwIfRejected(r.effects);

    /** 发出前任何一步失败：机器复位 + 补延后重启（旧 finally 的职责），再以 500 出面 */
    const failLaunch = (message: string): never => {
      const r2 = update(state, { type: 'run-launch-failed', message });
      state = r2.state;
      void runEffects(r2.effects.filter((e) => e.kind !== 'reject'));
      throwIfRejected(r2.effects);
      throw new Error(message); // 不可达（run-launch-failed 必带 reject），只喂类型
    };

    let restarted = false;
    for (const e of r.effects) {
      if (e.kind === 'disarm-abort-timer') {
        // 上一轮中止留下的兜底计时器不该跨到这一轮来（否则会掐掉一次正常的 run）
        clearAbortTimer();
      } else if (e.kind === 'restart') {
        restarted = true;
        await restartExec(e.reason, e.toolSources);
        if (state.child !== 'ready') failLaunch(state.lastError ?? 'runner 起不来');
      } else if (e.kind === 'send-ipc') {
        const proc = currentProc;
        if (!proc) failLaunch(state.lastError ?? 'runner 起不来');
        let sent = false;
        try {
          sent = (proc as ChildProcess).send(e.message);
        } catch (e2) {
          // 通道刚断开时 `send()` **会抛**（`ERR_IPC_CHANNEL_CLOSED`），不只是返回 false。
          // 不翻译成失败事件的话机器相位会停在 launching ⇒ 面板之后每次 POST /run 都 409。
          failLaunch(`runner 通道已断（${(e2 as Error).message}），稍后再试`);
        }
        if (!sent) failLaunch('runner 通道已断（进程可能刚退出），稍后再试');
      }
    }
    void dispatch({ type: 'run-launched' });
    return { accepted: true, restarted };
  };

  /**
   * 中止在飞 run（§6 待定 5 的「显式 kill 按钮」）。
   *
   * 两条路，按顺序（状态迁移在机器里，这里只管计时器与等待）：
   * 1. **优雅**：给 runner 发 `run-abort`，它 abort 掉 `app.run` 的 `signal` ⇒ 引擎在回合边界
   *    以 `stopReason='aborted'` **正常返回** ⇒ **trace 照常落盘**（框架契约：不抛异常）。
   * 2. **兜底**：`signal` 是**协作式**的 —— 工具若不读 `ToolRunContext.signal`（本仓已知
   *    「MCP 在途中止 ⇒ Promise 永不 settle」那类），abort 就没人理。那就重启进程收编它
   *    （代价是这次 run 的 trace 丢掉，但**面板不至于永久锁死**）。
   */
  const abortRun = async (): Promise<{ accepted: boolean; escalated: boolean }> => {
    const r = update(state, { type: 'ui-abort-requested' });
    state = r.state;
    throwIfRejected(r.effects);
    const arm = r.effects.find((e) => e.kind === 'arm-abort-timer');
    if (arm?.kind !== 'arm-abort-timer') {
      // 幂等：中止已发出（机器相位已是 aborting），不挂第二个计时器
      return { accepted: true, escalated: false };
    }
    const sendEff = r.effects.find((e) => e.kind === 'send-ipc');
    const proc = currentProc;
    let sent = false;
    try {
      sent = proc && sendEff && sendEff.kind === 'send-ipc' ? proc.send(sendEff.message) : false;
    } catch (e) {
      // 相位退回 running（中止没生效，run 还在飞）；错误原样上抛（HTTP 层映射 500）
      void dispatch({ type: 'abort-send-failed', message: (e as Error).message });
      throw e;
    }
    if (!sent) {
      const message = 'runner 通道已断（进程可能刚退出），稍后再试';
      void dispatch({ type: 'abort-send-failed', message });
      throw new HttpError(500, message);
    }
    const escalated = await new Promise<boolean>((resolve) => {
      let tick: NodeJS.Timeout | null = null;
      let deadline: NodeJS.Timeout | null = null;
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        if (tick !== null) clearInterval(tick);
        if (deadline !== null) clearTimeout(deadline);
        clearAbortTimer();
        resolve(value);
      };
      abortTimer = setTimeout(() => {
        abortTimer = null;
        // 还在跑 ⇒ signal 没人理 ⇒ 必须升级（机器：lastError + restart 效果），否则面板锁死
        void dispatch({ type: 'abort-grace-expired' });
        finish(true);
      }, arm.ms);
      /**
       * 轮询的**自己的**上限。没有它就有一种挂死：run 正常收尾时 run-done 会先
       * disarm（清掉上面的升级计时器）再把相位落到 idle，而轮询是 50 ms 一拍 ——
       * 若这 50 ms 内又起了一个新 run，轮询永远等不到 idle，而升级计时器已经没了
       * ⇒ 这个 Promise **无人 resolve**，`POST /run/abort` 挂住不还。
       * 上限比升级刻度略长：正常升级总是先到。
       */
      deadline = setTimeout(() => finish(false), arm.ms + 500);
      // 正常收尾（run-done / run-error）会把相位落下来，轮询据此 resolve(false)
      tick = setInterval(() => {
        if (!runGateFlags(state).running) finish(false);
      }, 50);
      tick.unref();
    });
    return { accepted: true, escalated };
  };

  /**
   * 清空对话 = **换一个 sessionId**（§6 待定 3）。
   *
   * 不删 `session.json` 里的东西：那是 `SessionStore` 的账，面板对它是只读的
   * （见 `readSession`）。旧对话留在盘上，run 列表里那些 run 也还指得到它 ——
   * 而新的 run 用新 id ⇒ 模型看到的上下文是空的。
   */
  const clearSession = async (): Promise<{ sessionId: string }> => {
    const r = update(state, { type: 'ui-clear-session' });
    state = r.state;
    throwIfRejected(r.effects);
    for (const e of r.effects) {
      if (e.kind === 'persist-session-id') writeSessionId(e.id);
    }
    return { sessionId: state.sessionId };
  };

  /**
   * 原生文件夹选择框（面板工作目录控件的「用系统选择器…」按钮）。
   *
   * **串行化**在机器里（picking 相位）：同时只许一个在飞，第二个请求 409。
   * 没有面板侧超时（用户可能慢慢选）；进程退出时由 `killActivePickers()` 收编。
   */
  const pickFolder = async (): Promise<string | null> => {
    // ui-pick-requested 发出的 pick-folder 效果是**纯标记**：它没有任何执行器，
    // SPECIAL_ONLY 的作用只是让它万一走到通用执行器时响亮失败 —— 真 spawn 就是下面
    // 这行 pickFolderNative()。机器只负责把 picking 相位立起来（串行化闸），不碰进程。
    const r = update(state, { type: 'ui-pick-requested' });
    state = r.state;
    throwIfRejected(r.effects);
    try {
      const picked = await pickFolderNative();
      void dispatch({ type: 'ui-pick-resolved' });
      return picked;
    } catch (e) {
      // 平台不支持 / 命令缺失（native-pick 的报错已指向降级路径「浏览…」）⇒ 501
      const r2 = update(state, { type: 'ui-pick-failed', message: (e as Error).message });
      state = r2.state;
      throwIfRejected(r2.effects);
      throw e; // 不可达（ui-pick-failed 必带 reject），只喂类型
    }
  };

  /**
   * 客户端断开（刷新 / 关标签页）时收掉在飞的选择框（G2 的出口）：机器给出
   * kill-pickers 效果 ⇒ kill 子进程 ⇒ pickFolderNative 那侧走「视同取消」
   * （resolve null）⇒ ui-pick-resolved 把 picking 落下来。没有这条出口：
   * 选择框挂在桌面上没人看、picking 永远不落、之后每次点「系统选择…」都 409。
   */
  const cancelPick = (): void => {
    void dispatch({ type: 'ui-pick-cancelled' });
  };

  const readSession = async (): Promise<{ messages: SessionMessageLike[] } | null> => {
    // 面板**只读**会话文件：它记的是「我发了什么」，而模型看到的是「store 里有什么」，
    // 两者一旦漂开（历史被裁剪、run 失败没回写、手工改了文件），面板就会显示一份
    // **不存在的对话** —— 正是本仓一直在猎的那类静默不一致。
    // 路径取 dev-protocol 的常量，不在这里就地写字符串 —— 就地写一份就是
    // 「同一个事实两个写法」，而这两处漂开的后果是**面板显示一份不存在的对话**。
    // ⚠️ 这条耦合是**约定**而非机制：`SESSION_REL` 必须与用户工程 `src/app.ts` 的
    // `SESSION_FILE` 一致（模板里两者是一致的）。要根治得让 runner 把真实路径报回来。
    const file = join(projectRoot, SESSION_REL);
    if (!existsSync(file)) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const parsed = JSON.parse(await readFile(file, 'utf8')) as {
        sessions?: Record<string, SessionMessageLike[]>;
      };
      // 读**当前** id（不是常量）：清空对话之后面板必须立刻显示空，而不是旧对话
      const messages = parsed.sessions?.[state.sessionId];
      return { messages: Array.isArray(messages) ? messages : [] };
    } catch (e) {
      throw new HttpError(500, `读会话文件失败：${(e as Error).message}`);
    }
  };

  // ---------- 收尾 ----------

  /**
   * 收尾后退出（SIGINT / SIGTERM 共用同一条出口）。迁移规则在机器里
   * （第一次 ⇒ closing + 收尾效果序列；第二次 ⇒ exit-now 立即硬退）。
   *
   * ## 为什么不能沿用「固定 50 ms 后 `process.exit(0)`」（实测，不是风格偏好）
   *
   * `stopChildExec()` 给子进程的宽限期是 `KILL_GRACE_MS`（3 s）—— 它 SIGTERM 之后等 3 s
   * 才补 SIGKILL。而固定 50 ms 就 exit 会让父进程在这 3 s 之前消失：
   * - 那段宽限连同 **SIGKILL 兜底**一起没了（计时器随父进程消失）；
   * - `process.on('exit')` 那条兜底此刻也是空操作 —— 句柄早已被摘掉。
   * ⇒ 一个**不响应 SIGTERM** 的 runner（连同它自己 spawn 的 MCP 子进程）活成孤儿。
   *
   * 上限仍然要有：面板若还有挂着的连接，收尾可能卡住 ⇒ `SHUTDOWN_DEADLINE_MS` 到点硬退；
   * 再按一次 Ctrl+C 立即硬退（机器的 exit-now）。
   */
  const shutdownAndExit = (code: number): void => {
    const r = update(state, { type: 'shutdown' });
    state = r.state;
    if (r.effects.some((e) => e.kind === 'exit-now')) {
      process.exit(code);
    }
    const deadline = setTimeout(() => process.exit(code), SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void runEffects(r.effects).finally(() => {
      clearTimeout(deadline);
      process.exit(code);
    });
  };

  process.on('SIGINT', () => shutdownAndExit(0));
  process.on('SIGTERM', () => shutdownAndExit(0));
  // 最后一道兜底：任何路径走到进程退出都不该留下子进程树（含上面那条硬退路径）——
  // 含还挂着的原生文件夹选择框（同步 kill，与 killTree 同一条纪律）
  process.on('exit', () => {
    killActivePickers();
    if (currentProc) killTree(currentProc, 'SIGKILL');
  });

  // ---------- 启动 ----------

  /**
   * 起面板。失败**不阻断** dev（文件头那条「面板是增强项」的承诺）—— 但要响亮说清
   * 「这一次没有面板」，而不是含糊的「dev 照常运行」。
   *
   * 为什么要真的降级而不是退出：`agentia dev -- "问题"` 这条**文档化的用法**不需要面板
   * （首次 run 由 argv 给，改代码照样重启），而且「面板起不来 ⇒ 连 runner 都不 spawn、
   * 进程随即以 code=1 退出」正是那句旧文案在说谎的地方（它说照常运行，事实是 dev 根本没起来）。
   */
  const startPanel = async (): Promise<void> => {
    try {
      inspector = await startInspector({
        token,
        dev: {
          state: devState,
          run: submitRun,
          session: readSession,
          abort: abortRun,
          clearSession,
          pickFolder,
          cancelPick,
          /**
           * ① 实时右栏：runner 逐笔 POST 上来的增量记账事件**原样广播**给面板
           * （机器只有一条 emit 效果，刻意零解释 —— 折回是面板的活）。
           */
          traceEvent: (e) => {
            void dispatch({ type: 'trace-event', event: e });
          },
        },
      });
      panelPort = inspector.port;
      console.log(
        `Inspector: http://127.0.0.1:${inspector.port}/?t=${token}\n` +
          '  （带 token 的完整 URL —— 打开一次就会种进 cookie，之后刷新不用再带）',
      );
    } catch (err) {
      inspector = null;
      console.warn(
        `[agentia] inspector 起不来（${(err as Error).message}）⇒ 这一次**没有面板**：\n` +
          '  trace / 对话视图 / 「中止」都不可用；dev 只保留「首次 run（`npm run dev -- "问题"`）」\n' +
          '  与「改代码自动重启」两条路，run 的正文与失败原因打在终端上。',
      );
    }
  };

  void (async () => {
    await startPanel();
    // 写者锁：判据、三条边界与「为什么只出声不拒绝启动」都在 dev-lock.ts 的头注。
    // 放在面板起来之后是为了把端口写进锁（另一个实例的报错里能直接对上「是哪一个」）；
    // 面板没起来也照抢 —— 落盘 sink 跟面板没关系，两个实例照样会交错。
    writerLock = claimWriterLock({ lockPath, port: panelPort });
    if (writerLock.owned) process.on('exit', () => releaseWriterLock(lockPath));
    if (writerLock.warning !== null) console.warn(`[agentia] ${writerLock.warning}`);

    // 拉起第一代 runner（boot ⇒ spawn-child 效果；失败归 boot-failed：终端 error +
    // 唯一一帧 runner-error —— 见机器里那条迁移的注释）
    await dispatch({ type: 'boot' });
    // 「文件变了 ⇒ 重启」的**唯一**出口：两处 watch 都走它，理由文案因此只有一种写法。
    const onFileChange = (abs: string): void => {
      void dispatch({ type: 'file-changed', rel: relative(projectRoot, abs) });
    };
    // 代码与文本资产都在 `src/` 下（`.md` 必须在允许清单里 —— 见 dev-watch.ts 的 WATCH_EXT）
    stopWatch = watchTree(join(projectRoot, 'src'), onFileChange);
    // `.env` / `.env.local` 在**项目根**、不在 `src/` 下 ⇒ 单独盯。
    // 少了这一句，「改 .env 会重启」就是一句没人执行的承诺（真跑抓出来的）。
    stopEnvWatch = watchRootEnvFiles(projectRoot, onFileChange);
    // `agentia dev -- "问题"` / `npm run dev -- "问题"`：文档化的用法，首次 run 用这个 prompt。
    // ⚠️ 必须把分隔符 `--` 自己挑掉：`npm run dev -- "问题"` 里 npm 会吃掉那个 `--`
    // （CLI 收到的是 `dev "问题"`），但**裸 CLI** 那条（cli.ts 的 usage 就写着
    // `agentia dev [-- "问题"]`）会把 `--` 原样放进 rest ⇒ 取第一个非空参数时
    // 拿到的是 `"--"`：首次 run 的 prompt 变成两个连字符，而模型照样会回话
    // （所以它**不会**报错，只是问了另一件事 —— 静默错到底）。
    const initial = argv.filter((a) => a !== '--').find((a) => a.trim().length > 0);
    if (initial !== undefined) {
      try {
        await submitRun({ prompt: initial });
      } catch (e) {
        console.error(`[agentia] 首次 run 没起来：${(e as Error).message}`);
      }
    }
  })();

  return 0;
}
