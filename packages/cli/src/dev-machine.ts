/**
 * dev 环的**显式状态机** —— 方案 docs/plans/2026-09-23-cli-structure.md §3 B 的落点。
 *
 * 这里收编的是 `dev.ts` 里那台隐式状态机（曾经：15 个 `let`、40 处写入点、15 个入口，
 * F1/F4/G1/G2 四条真缺陷全是它的直接后果）。现在**所有「什么情况下该做什么」的判定
 * 都在本文件的 `update()` 里**；`dev.ts` 只剩执行 effects 的薄接线（spawn / kill /
 * IPC / HTTP / fs 这些真副作用）。
 *
 * 纯件纪律（与 dev-logic 同档）：零副作用、零 `node:*` import ⇒ 单测直接 import dist 产物。
 * 判据**不另写一份**：受理闸 / 延后重启 / 退出原因 / 中止幂等 / 选择器串行 / 能力比较
 * 仍调 `dev-logic` 的单源（相位先折算回那对布尔 —— `runGateFlags`），多轮缺省与菜单归一
 * 走 `panel-logic`。dev-logic.test.mjs 钉判据本身，dev-machine.test.mjs 钉迁移规则。
 *
 * 关键建模决策（与旧闭包变量的对应）：
 * - `child` 与 `run` 是**两个独立相位**：「runner 在不在」和「run 在不在飞」本就正交
 *   （启动窗口内可以没有 run；在飞 run 的 runner 可以暴毙）。
 * - `run: 'launching'` 是**类型里的一相**（旧的 `launching` 占位布尔）⇒ 受理闸写成
 *   「非 idle 即拒」，F1 那类「漏看一个布尔」在结构上写不出来。
 * - `run: 'aborting'` 吸收旧的 `abortTimer !== null`：中止幂等判定就是相位判定。
 * - `errBaseline` 从 spawnChild 的局部 const **升为状态字段**（G1：「这一代有没有写出
 *   新原因」这个判据从此有名字、有单测）。
 * - 实际进程句柄（ChildProcess / 计时器 / watcher）**不进状态** —— 它们不可序列化，
 *   由接线层持有；状态里只有「相位 + 数据」。
 */
import {
  DEFAULT_BUDGET,
  DEV_SESSION_ID,
  type DevEvent,
  type DevMessage,
  type RunNote,
  type RunRequest,
  type TraceRecordEventLike,
} from './dev-protocol.js';
import {
  abortDecision,
  canAcceptRun,
  exitReason,
  pickGate,
  sameToolSources,
  shouldDeferRestart,
} from './dev-logic.js';
import { multiTurnDefault, normalizeToolSources } from './panel-logic.js';

/** 子进程就绪的等待上限（消息文本进状态 ⇒ 常量由本文件持有，接线层回引） */
export const READY_TIMEOUT_MS = 60_000;
/**
 * 「中止」发出后等它优雅收尾的宽限：超时就重启进程兜底。取 5s —— 优雅路径要在
 * **回合边界**才生效（在飞的模型请求先被取消），给足一个回合；再长就等于按钮按了没反应。
 */
export const ABORT_GRACE_MS = 5_000;

/** 子进程相位：`starting` = 已 spawn、还没等到 ready（就绪前崩 = 启动失败，归因走 G1 判据） */
export type ChildPhase = 'absent' | 'starting' | 'ready';
/**
 * run 相位。`launching` = 已受理、还没发进通道（中间隔着一次 `await restart`，
 * 这就是 F1 的那条窄窗口）；`aborting` = 中止已发出、在等优雅收尾或兜底升级。
 */
export type RunPhase = 'idle' | 'launching' | 'running' | 'aborting';

/** dev 环状态（机器的全部输入；与面板读的 `dev-protocol.DevState` 不是同一个类型） */
export interface DevMachineState {
  /** 项目根（child 代际更替时 defaultWorkdir 的回落值；创建后不变） */
  readonly projectRoot: string;
  child: ChildPhase;
  run: RunPhase;
  /**
   * 当代子进程的能力选择（null = 全量）。child 离场时归 null —— 对应旧代码的
   * `child?.toolSources ?? null`：进程没了，「它跑的是什么选择」这个事实也一起没了。
   */
  toolSources: string[] | null;
  /** 以下五个字段都是「当代 runner 报上来 / 待报」的：就绪前是初值（空菜单、缺省预算） */
  capabilities: string[];
  multiTurn: string[];
  defaultWorkdir: string;
  /** 生效的预算护栏（由 runner 经 ready 报上来；它就绪前只能给缺省值） */
  budget: { maxCostUsd: number; maxTotalTokens: number };
  /** dev 环的响亮告警（装配期发现的问题）；没有则 null */
  warning: string | null;
  /** 当前会话 id（「清空对话」换的就是它；跨 runner 重启稳定 —— 所以它在父进程手里） */
  sessionId: string;
  /** 在飞 run 期间来的文件变更：等 run 收尾再重启（不在飞的 run 不该被掐掉） */
  pendingRestart: string | null;
  /** 等挂 traceId 的 CLI 侧记账（run 真发出去之前挂上，run-done 时按 traceId 落） */
  pendingNote: RunNote | null;
  /** 最近一次失败的原因；面板告警条。成功 run 会把它摘下（它是「此刻哪儿坏了」不是历史日志） */
  lastError: string | null;
  /**
   * 这一代进程 spawn 那一刻的 lastError —— 「这一代有没有写出新原因」的判据（G1 的落点；
   * 为什么不能判 `lastError === null`，见 `dev-logic.exitReason`）。
   */
  errBaseline: string | null;
  /** 原生文件夹选择框在飞（串行化：同时只许一个；客户端断开经 ui-pick-cancelled 收编 —— G2） */
  picking: boolean;
  /** 收尾中（停机后再来的事件一律不重启、不广播；第二次 shutdown ⇒ exit-now） */
  closing: boolean;
}

/** 初始状态（sessionId 由接线层从盘上读出来后传入 —— 读盘是副作用，不进机器） */
export function createInitialState(init: {
  projectRoot: string;
  sessionId: string;
}): DevMachineState {
  return {
    projectRoot: init.projectRoot,
    child: 'absent',
    run: 'idle',
    toolSources: null,
    capabilities: [],
    multiTurn: [],
    defaultWorkdir: init.projectRoot,
    budget: { ...DEFAULT_BUDGET },
    warning: null,
    sessionId: init.sessionId,
    pendingRestart: null,
    pendingNote: null,
    lastError: null,
    errBaseline: null,
    picking: false,
    closing: false,
  };
}

/**
 * 15 个入口 → 事件。进程身份归属（消息来自**当代**子进程）由接线层在派发前判定
 * （它持有句柄）；过时进程的迟到消息根本不成为事件 —— 唯一例外见 dev.ts 的 exit 处理器
 * （过时进程的退出要负责把**自己那次 spawn 的 Promise** 收掉，但不碰机器状态）。
 */
export type DevEventIn =
  /** 启动序列开始（面板起来之后）：拉起第一代 runner */
  | { type: 'boot' }
  /** 一次 spawn 开始（handle 已安装）：进入 starting，记 errBaseline，菜单/预算回落初值 */
  | { type: 'child-spawned'; toolSources: string[] | null }
  /** 子进程 'error'（spawn 失败那类，ENOENT/EACCES —— 不会再有 exit） */
  | { type: 'child-spawn-failed'; message: string }
  /** READY_TIMEOUT_MS 内没等到 ready */
  | { type: 'child-ready-timeout' }
  /** runner 装配完毕（它报上来生效的菜单 / 多轮 / 缺省目录 / 预算 / 告警） */
  | {
      type: 'child-ready';
      capabilities: string[];
      multiTurn: string[];
      defaultWorkdir: string;
      budget: { maxCostUsd: number; maxTotalTokens: number };
      warning: string | null;
    }
  /** 当代子进程退出。`how` = `code=X[, signal=Y]`（文案素材；拼文案是机器的事） */
  | { type: 'child-exit'; how: string }
  /** 接线层主动停掉了当代子进程（restart / shutdown 的 stop-child 效应执行完摘除句柄时） */
  | { type: 'child-stopped' }
  | { type: 'ipc-run-start' }
  | {
      type: 'ipc-run-done';
      traceId: string | null;
      ok: boolean;
      stopReason: string;
      error: string | null;
      finalText: string;
    }
  /** run 都没起来（装配抛错等）—— 是 dev 环本身坏了，不是「run 失败」 */
  | { type: 'ipc-run-error'; message: string }
  /**
   * 面板 POST /run。`workdir` 已由接线层解析（`resolveWorkdir`），`workdirExists` 由
   * 接线层查过 fs —— 机器只负责「拿这个事实判 400」（查盘是副作用，不进机器）。
   * 顺序守恒：闸（409）先于目录（400），与旧 submitRun 一致。
   */
  | { type: 'ui-run-requested'; req: RunRequest; workdir: string; workdirExists: boolean }
  /** run 成功发进 IPC 通道（内部事件，接线层在 send 成功之后派发） */
  | { type: 'run-launched' }
  /** 发出前任何一步失败（重启没起来 / 通道已断）—— 复位 + 补上延后重启 + 500 */
  | { type: 'run-launch-failed'; message: string }
  | { type: 'ui-abort-requested' }
  /** run-abort 没发出去（通道断）：相位退回 running（中止没生效，run 还在飞） */
  | { type: 'abort-send-failed'; message: string }
  /** 中止宽限到点（ABORT_GRACE_MS）：signal 没人理 ⇒ 升级重启兜底 */
  | { type: 'abort-grace-expired' }
  | { type: 'ui-clear-session' }
  | { type: 'ui-pick-requested' }
  /** 选择框收了（选中或取消都算 —— pickFolderNative resolve 了） */
  | { type: 'ui-pick-resolved' }
  /** 平台不支持 / 命令缺失（501） */
  | { type: 'ui-pick-failed'; message: string }
  /** 客户端在等待期间断开（G2 的出口：收掉选择框子进程，picking 由随后的 resolved 落下） */
  | { type: 'ui-pick-cancelled' }
  /** 文件变更（两处 watch 的唯一出口；rel 已按项目根相对论） */
  | { type: 'file-changed'; rel: string }
  /** restart 链上的 spawn 失败（换能力 / 文件变更 / 中止升级 / 延后重启共用这条收尾） */
  | { type: 'restart-failed'; message: string }
  /** 首次 spawn 失败（与 restart-failed 的差别只在多一条终端 error 日志） */
  | { type: 'boot-failed'; message: string }
  /** 在飞 run 的增量记账事件（原样转发，父进程不做任何解释） */
  | { type: 'trace-event'; event: TraceRecordEventLike }
  /** SIGINT / SIGTERM。第二次 = 立即硬退（exit-now） */
  | { type: 'shutdown' };

/**
 * 效果（判别联合对象，**不是闭包**）—— `deepEqual` 可断言。
 *
 * F4 的结构化解法：effects 是**返回值**，一个事件只产出一份 ⇒ 「同一条错误广播两帧」
 * 写不出来（启动失败的 emit 只在 restart-failed / boot-failed 上，child-exit 的
 * starting 分支刻意不 emit）。
 *
 * 执行语义（接线层的纪律）：
 * - `restart` 自带「串行链 + 起跑时广播 runner-restart」：emit 不进本联合，因为旧语义里
 *   它在**链任务真正起跑时**才发（排在后面的重启不能提前广播），且 closing 时被跳过；
 * - `send-ipc` / `arm-abort-timer` / `reject` / `pick-folder` / `exit-now` 只出现在
 *   专用流程（submitRun / abortRun / pickFolder / shutdownAndExit）里，由那里的
 *   接线代码就地解释（要能中断序列、要把 reject 翻译成 HttpError）；
 * - 其余都是即发即弃，通用执行器按序执行。
 */
export type DevEffect =
  | { kind: 'emit'; event: DevEvent }
  | { kind: 'note-run'; traceId: string; note: RunNote }
  /** 首次拉起（boot）；失败由执行器转 `boot-failed` */
  | { kind: 'spawn-child'; toolSources: string[] | null }
  /** 停旧 + 起新（串行链）；失败由执行器转 `restart-failed` */
  | { kind: 'restart'; reason: string; toolSources: string[] | null }
  /** 优雅停当代子进程（SIGTERM + 宽限 + SIGKILL 兜底 —— stopChild 语义） */
  | { kind: 'stop-child' }
  /** 立即 SIGKILL（ready 超时专用 —— 它从没就绪过，谈不上优雅） */
  | { kind: 'kill-child' }
  | { kind: 'send-ipc'; message: DevMessage }
  | { kind: 'persist-session-id'; id: string }
  | { kind: 'arm-abort-timer'; ms: number }
  | { kind: 'disarm-abort-timer' }
  | { kind: 'stop-watchers' }
  | { kind: 'close-inspector' }
  | { kind: 'kill-pickers' }
  | { kind: 'pick-folder' }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** 请求被拒（接线层翻译成 HttpError(status, message) 抛给 HTTP 层） */
  | { kind: 'reject'; status: number; message: string }
  /** 第二次 Ctrl+C：不等收尾，立即硬退 */
  | { kind: 'exit-now' };

/** 「清空对话」换到的下一个 id：`dev` → `dev-2` → …（从 dev.ts 迁来；语义与注释见其测试） */
export function nextSessionId(current: string, base: string = DEV_SESSION_ID): string {
  // base 是**参数**（导出为单测用）⇒ 进正则前先转义
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}(?:-(\\d+))?$`).exec(current);
  if (m === null) return `${base}-2`;
  const n = m[1] === undefined ? 1 : Number(m[1]);
  return `${base}-${n + 1}`;
}

/** 工作目录解析：空值回落缺省目录（接线层拿结果去查 fs，再把事实交回机器判 400） */
export function resolveWorkdir(req: RunRequest, defaultWorkdir: string): string {
  return req.workdir !== undefined && req.workdir.length > 0 ? req.workdir : defaultWorkdir;
}

/**
 * 相位 → dev-logic 那对布尔的折算。dev-logic 的判据（F1 的闸、延后重启）是按
 * `{running, launching}` 写的单源；机器不复制条件，只负责折算 ——
 * `aborting` 算 running（旧代码里中止宽限期内 `running` 一直是 true）。
 */
export function runGateFlags(state: DevMachineState): { running: boolean; launching: boolean } {
  return {
    running: state.run === 'running' || state.run === 'aborting',
    launching: state.run === 'launching',
  };
}

/** 「没等到 ready 就退」的通用文案（机器与接线层的过时进程兜底共用一份，不各写） */
export function startupExitMessage(how: string): string {
  return `dev runner 退出（${how}）—— 多半是用户代码 import 期就抛了，看上面的输出`;
}

/** run 相位落下：running/aborting → idle；**launching 不动**（launch 流程自己拥有它 ——
 *  旧代码里这些路径写的是 `running = false`，对 launching 原本就是无操作） */
function idleUnlessLaunching(run: RunPhase): RunPhase {
  return run === 'running' || run === 'aborting' ? 'idle' : run;
}

/** run 收尾后处理「在飞期间攒下的重启请求」（旧 `afterRun`；关机中不重启） */
function afterRun(state: DevMachineState, effects: DevEffect[]): DevMachineState {
  if (state.pendingRestart === null || state.closing) return state;
  effects.push({ kind: 'restart', reason: state.pendingRestart, toolSources: state.toolSources });
  return { ...state, pendingRestart: null };
}

/**
 * 状态机本体：纯函数，同一份 `(state, ev)` 永远给出同一份 `(state, effects)`。
 * 不 mutate 入参（返回新对象），不改写句柄 —— 句柄根本不在状态里。
 */
export function update(
  state: DevMachineState,
  ev: DevEventIn,
): { state: DevMachineState; effects: DevEffect[] } {
  switch (ev.type) {
    case 'boot':
      return { state, effects: [{ kind: 'spawn-child', toolSources: null }] };

    case 'child-spawned':
      // 每一代从干净的事实开始：菜单/预算/告警是初值（ready 再报真值），
      // errBaseline 记下此刻的 lastError（G1：「这一代有没有写出新原因」的基线）
      return {
        state: {
          ...state,
          child: 'starting',
          toolSources: ev.toolSources,
          capabilities: [],
          multiTurn: [],
          defaultWorkdir: state.projectRoot,
          budget: { ...DEFAULT_BUDGET },
          warning: null,
          errBaseline: state.lastError,
        },
        effects: [],
      };

    case 'child-spawn-failed':
      // spawn 失败（'error' 事件）：不会有 exit。摘掉当代（旧代码 fail() 的硬要求：
      // 留着死 handle ⇒ 下次 POST /run 往断通道 send ⇒ running 卡死 ⇒ 面板锁死）
      return {
        state: {
          ...state,
          child: 'absent',
          toolSources: null,
          lastError: `启动 dev runner 失败：${ev.message}`,
        },
        effects: [],
      };

    case 'child-ready-timeout':
      return {
        state: {
          ...state,
          child: 'absent',
          toolSources: null,
          lastError: `dev runner 启动超时（${READY_TIMEOUT_MS} ms 内没有就绪信号）`,
        },
        effects: [{ kind: 'kill-child' }],
      };

    case 'child-ready': {
      const effects: DevEffect[] = [];
      if (ev.warning !== null) {
        effects.push({ kind: 'log', level: 'warn', message: `[agentia] ${ev.warning}` });
      }
      // 广播「就绪」：面板加载时那次 /api/dev 拿到的还是初值（空菜单），没有这条它就一直空着
      effects.push({ kind: 'emit', event: { kind: 'runner-ready' } });
      return {
        state: {
          ...state,
          child: 'ready',
          capabilities: ev.capabilities,
          multiTurn: ev.multiTurn,
          defaultWorkdir: ev.defaultWorkdir,
          budget: ev.budget,
          warning: ev.warning,
        },
        effects,
      };
    }

    case 'child-exit': {
      if (state.child === 'starting') {
        // 没等到 ready 就退 = **启动失败**。⚠️ 这里刻意**不 emit**（F4）：发射权在等
        // spawn 的那一侧 —— 它会以 restart-failed / boot-failed 发出唯一的那一帧；
        // 两边都走就是同一条消息广播两次。
        const reason = exitReason({
          lastError: state.lastError,
          errBaseline: state.errBaseline,
          generic: startupExitMessage(ev.how),
        });
        return {
          state: {
            ...state,
            child: 'absent',
            toolSources: null,
            lastError: reason,
            run: idleUnlessLaunching(state.run),
          },
          effects: [{ kind: 'disarm-abort-timer' }],
        };
      }
      if (state.child === 'ready') {
        // 关机中：摘掉当代就够了，不归因、不广播（旧代码 `if (!isCurrent || closing) return`）
        if (state.closing) {
          return { state: { ...state, child: 'absent', toolSources: null }, effects: [] };
        }
        // 跑着跑着意外退出：归因同 G1 判据（这一代没写出新原因才用通用文案）
        const lastError = exitReason({
          lastError: state.lastError,
          errBaseline: state.errBaseline,
          generic: `dev runner 意外退出（${ev.how}）`,
        });
        return {
          state: {
            ...state,
            child: 'absent',
            toolSources: null,
            lastError,
            run: idleUnlessLaunching(state.run),
          },
          effects: [
            { kind: 'disarm-abort-timer' },
            { kind: 'emit', event: { kind: 'runner-error', message: lastError } },
          ],
        };
      }
      return { state, effects: [] };
    }

    case 'child-stopped':
      // 主动停（restart / shutdown）：不可能再有在飞 run ⇒ run 相位落下。
      // 旧代码这里漏过 running=false，症状是「中止超时 ⇒ 重启兜底」之后面板永久 409。
      return {
        state: {
          ...state,
          child: 'absent',
          toolSources: null,
          run: idleUnlessLaunching(state.run),
        },
        effects: [{ kind: 'disarm-abort-timer' }],
      };

    case 'ipc-run-start':
      return { state: { ...state, run: 'running' }, effects: [] };

    case 'ipc-run-done': {
      const note = state.pendingNote;
      let lastError = state.lastError;
      // 中止的 run 也带 error（abortedResult 刻意如此）⇒ 只看 stopReason 判「环坏了」
      if (!ev.ok && ev.stopReason !== 'aborted') lastError = ev.error;
      // 成功 ⇒ 环是好的，把旧失败从告警条摘下（也是 G1 所需的清零点）
      if (ev.ok) lastError = null;
      const effects: DevEffect[] = [{ kind: 'disarm-abort-timer' }];
      if (ev.traceId !== null && note !== null) {
        // 回复（`finalText`）只有这一帧带 ⇒ 必须与 note 一起落账，否则面板切走再切回来
        // 就再也取不到了（它不在 trace 上）。新建对象而不是改 `note`：pendingNote 是
        // 上一事件的 state，就地改会让「同一份 note 被两条 run 共享」成为可能。
        effects.push({
          kind: 'note-run',
          traceId: ev.traceId,
          note: ev.finalText ? { ...note, finalText: ev.finalText } : note,
        });
      }
      effects.push({
        kind: 'emit',
        event: {
          kind: 'run-done',
          traceId: ev.traceId,
          ok: ev.ok,
          stopReason: ev.stopReason,
          error: ev.error,
          finalText: ev.finalText,
        },
      });
      const next = afterRun({ ...state, run: 'idle', pendingNote: null, lastError }, effects);
      return { state: next, effects };
    }

    case 'ipc-run-error': {
      const effects: DevEffect[] = [
        { kind: 'disarm-abort-timer' },
        { kind: 'emit', event: { kind: 'runner-error', message: ev.message } },
      ];
      const next = afterRun(
        { ...state, run: 'idle', pendingNote: null, lastError: ev.message },
        effects,
      );
      return { state: next, effects };
    }

    case 'ui-run-requested': {
      // 闸的判据单源在 dev-logic.canAcceptRun（F1：launching 窄窗口必须拒）
      if (!canAcceptRun(runGateFlags(state))) {
        return {
          state,
          effects: [
            {
              kind: 'reject',
              status: 409,
              message:
                '上一次 run 还在跑。等它结束，或先「中止」它再发新的（并发语义见计划 §6 待定 5）',
            },
          ],
        };
      }
      // 与旧 submitRun 同序：闸之后才清上一轮的兜底计时器、才判目录（400）
      if (!ev.workdirExists) {
        return {
          state,
          effects: [
            { kind: 'disarm-abort-timer' },
            {
              kind: 'reject',
              status: 400,
              message: `工作目录不存在或不是文件夹：${ev.workdir}`,
            },
          ],
        };
      }
      const caps = state.capabilities;
      const toolSources = normalizeToolSources(ev.req.toolSources ?? caps, caps);
      const multiTurn =
        ev.req.multiTurn ?? multiTurnDefault(toolSources ?? caps, state.multiTurn).value;
      const note: RunNote = {
        prompt: ev.req.prompt,
        workdir: ev.workdir,
        toolSources: toolSources ?? null,
        multiTurn,
      };
      // 换能力选择 ⇒ 重启进程（D8：进程边界是孤儿 MCP 子进程的唯一回收口）；
      // 子进程不在 ⇒ 同样要先起
      const needRestart =
        state.child === 'absent' || !sameToolSources(state.toolSources, toolSources);
      const effects: DevEffect[] = [{ kind: 'disarm-abort-timer' }];
      if (needRestart) {
        effects.push({
          kind: 'restart',
          reason: '能力选择变化（toolSources）',
          toolSources: toolSources ?? null,
        });
      }
      // 会话 id 由父进程给：它是面板级状态，且必须跨 runner 重启稳定
      effects.push({
        kind: 'send-ipc',
        message: {
          type: 'run',
          request: {
            prompt: ev.req.prompt,
            workdir: ev.workdir,
            multiTurn,
            sessionId: state.sessionId,
            toolSources: toolSources ?? null,
          },
        },
      });
      // launching 占位：从这里到「run 发出」之间，受理闸必须把第二个请求挡在 409
      return { state: { ...state, run: 'launching', pendingNote: note }, effects };
    }

    case 'run-launched': {
      const note = state.pendingNote;
      return {
        state: { ...state, run: 'running' },
        effects:
          note === null
            ? []
            : [
                {
                  kind: 'emit',
                  event: {
                    kind: 'run-start',
                    prompt: note.prompt,
                    workdir: note.workdir,
                    toolSources: note.toolSources,
                    multiTurn: note.multiTurn,
                  },
                },
              ],
      };
    }

    case 'run-launch-failed': {
      // 任何一步失败都必须复位两处：run 相位（留着 ⇒ 面板永久 409）与 pendingNote
      // （留着 ⇒ 挂到下一轮 run 的 traceId 上，张冠李戴）。没发成功 ⇒ 延后重启在这里
      // 立刻补上（旧 finally 的职责；发成功的情形由 run-done 的 afterRun 接手）。
      const effects: DevEffect[] = [];
      const next = afterRun({ ...state, run: 'idle', pendingNote: null }, effects);
      effects.push({ kind: 'reject', status: 500, message: ev.message });
      return { state: next, effects };
    }

    case 'ui-abort-requested': {
      if (!runGateFlags(state).running || state.child === 'absent') {
        return {
          state,
          effects: [{ kind: 'reject', status: 409, message: '当前没有在飞的 run' }],
        };
      }
      // 幂等（单源在 dev-logic.abortDecision）：升级等待中再点一次，不挂第二个计时器
      if (abortDecision({ hasTimer: state.run === 'aborting' }) === 'idempotent') {
        return { state, effects: [] };
      }
      return {
        state: { ...state, run: 'aborting' },
        effects: [
          { kind: 'send-ipc', message: { type: 'run-abort' } },
          { kind: 'arm-abort-timer', ms: ABORT_GRACE_MS },
        ],
      };
    }

    case 'abort-send-failed':
      // 中止没发出去 ⇒ run 还在正常飞，相位退回（否则闸会一直 409，却没人能再中止）
      return { state: { ...state, run: 'running' }, effects: [] };

    case 'abort-grace-expired':
      // 兜底计时器只可能在 aborting 相位到点；否则是已被 disarm 的残余（防御性忽略）
      if (state.run !== 'aborting') return { state, effects: [] };
      // ⚠️ 相位语义在此处有意弱化：相位随 restart 效果**发出**就落 idle（受理闸随之打开），
      // 不等 stopChild 真把旧子进程停掉 —— 旧代码是「关到真停」。之所以安全：此刻 restart 链
      // 必为空（aborting 只可能从 running 进，launching 期闸在 409 挡着；file-changed 在飞时
      // 只记 pendingRestart 不排队），且派发的效果链在微任务内连跑到 stopChild，HTTP 请求
      // 插不进这个窗口。哪天链上插进了会先 await 的环节，先重审这句再动。
      return {
        state: {
          ...state,
          run: 'idle',
          // 记进 lastError：被掐掉的 run 是个「发生过的事」，不该只闪一下就没了
          lastError: '中止超时（工具不响应 signal）⇒ 已重启 runner 兜底：这次 run 的 trace 丢了',
        },
        effects: [
          {
            kind: 'restart',
            reason: '中止超时：run 不响应 signal（工具可能不可取消）',
            toolSources: state.toolSources,
          },
        ],
      };

    case 'ui-clear-session': {
      // 与旧代码同口径：只看「在飞」（running/aborting）——launching 窗口内允许
      // （sessionId 在 send-ipc 那一刻才读，换 id 会落到新 run 上）
      if (runGateFlags(state).running) {
        return {
          state,
          effects: [
            {
              kind: 'reject',
              status: 409,
              message: '有 run 在飞时不能清空对话（它会写回当前会话）。先中止或等它结束',
            },
          ],
        };
      }
      const id = nextSessionId(state.sessionId);
      return {
        state: { ...state, sessionId: id },
        effects: [{ kind: 'persist-session-id', id }],
      };
    }

    case 'ui-pick-requested':
      if (pickGate({ inFlight: state.picking }) === 'reject') {
        return {
          state,
          effects: [
            {
              kind: 'reject',
              status: 409,
              message: '已有一个文件夹选择框在等 —— 先把它选完或取消',
            },
          ],
        };
      }
      return { state: { ...state, picking: true }, effects: [{ kind: 'pick-folder' }] };

    case 'ui-pick-resolved':
      return { state: { ...state, picking: false }, effects: [] };

    case 'ui-pick-failed':
      return {
        state: { ...state, picking: false },
        effects: [{ kind: 'reject', status: 501, message: ev.message }],
      };

    case 'ui-pick-cancelled':
      // G2 的出口：客户端断开 ⇒ 收掉在飞选择框（kill 之后 native 侧 resolve null ⇒
      // ui-pick-resolved 把 picking 落下来）。没在飞时它是空操作（旧代码同样无条件 kill）
      return { state, effects: state.picking ? [{ kind: 'kill-pickers' }] : [] };

    case 'file-changed': {
      if (state.closing) return { state, effects: [] };
      const reason = `文件变更：${ev.rel}`;
      // 在飞（含 launching 窄窗口）时重启会把刚 send 出去的 run 连进程一起 TERM 掉（F1）——
      // 判据与受理闸同一条单源（shouldDeferRestart 委托 canAcceptRun）
      if (shouldDeferRestart(runGateFlags(state))) {
        return { state: { ...state, pendingRestart: reason }, effects: [] };
      }
      return { state, effects: [{ kind: 'restart', reason, toolSources: state.toolSources }] };
    }

    case 'restart-failed':
      // restart 链上 spawn 失败的**唯一** emit 点（F4：child-exit 的 starting 分支不 emit）
      return {
        state: { ...state, lastError: ev.message },
        effects: [{ kind: 'emit', event: { kind: 'runner-error', message: ev.message } }],
      };

    case 'boot-failed':
      // 首次 spawn 失败的**唯一** emit 点（同上），外加终端一行 error（首次启动没人看面板）
      return {
        state: { ...state, lastError: ev.message },
        effects: [
          { kind: 'log', level: 'error', message: `[agentia] ${ev.message}` },
          { kind: 'emit', event: { kind: 'runner-error', message: ev.message } },
        ],
      };

    case 'trace-event':
      // 增量记账事件原样广播：父进程不做任何解释（折回是面板的活，插一手就多一处会漂的口径）
      return {
        state,
        effects: [{ kind: 'emit', event: { kind: 'trace-event', event: ev.event } }],
      };

    case 'shutdown':
      if (state.closing) {
        // 第二次 Ctrl+C：立即硬退（不让用户面对一个按不动的 Ctrl+C）
        return { state, effects: [{ kind: 'exit-now' }] };
      }
      return {
        state: { ...state, closing: true },
        effects: [
          { kind: 'stop-watchers' },
          { kind: 'kill-pickers' },
          { kind: 'stop-child' },
          { kind: 'close-inspector' },
        ],
      };
  }
}
