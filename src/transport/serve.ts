import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertTimerDelay } from '../core/timeout.js';

/**
 * 起服务 + 优雅停机 —— 两个**正交**的宿主原语。
 *
 * 为什么需要它们（2026-10-22，`docs/plans/2026-10-22-serve-graceful-shutdown.md`）：
 * 参考宿主（`examples/` 各目录的 `src/main.ts`）里约 35 行是「与业务无关的 server 样板」，而这 35 行藏着
 * 四个**静默错** —— keep-alive 连接不关（`close()` 等满超时）、先 close 再 drain（切断在飞请求）、
 * 二次信号被吞（`if (stopping) return` 拦住信号却不放行默认行为）、超时后不退出
 * （`drain()` 返回 `false` 的契约是「本进程此后不再推进任何任务 ⇒ 宿主必须退出」）。
 * 这四条都不是「多写几行」能解决的，是**必须知道才会写**。
 *
 * ## 边界：这不是「做进程级决策」
 *
 * 判据是**谁发起**，不是「有没有碰 process」：
 * - `createApp()` 里偷偷 `listen` / `process.on('SIGTERM')` ⇒ 越界（框架替宿主决定）；
 * - 宿主写 `serve(handler, { port })` / 传 `signals: [...]` ⇒ 不越界，与 Nest 的
 *   `app.listen()` / `enableShutdownHooks()` 同构（那边的信号订阅**也是显式 opt-in**，
 *   默认关 —— 官方理由是 listener 占资源、一进程多实例会 listener 泄漏）。
 *
 * ⇒ 本文件**不调用 `process.exit`**（退出码与「关池 / 冲 sink 之后再退」是宿主的编排），
 * 也**不在缺省下订阅任何信号**。
 */

/** `serve` 的选项。端口给 0 = 由操作系统分配（测试与容器里常用）。 */
export interface ServeOptions {
  port: number;
  /** 监听地址；缺省所有接口（Node 默认语义）。 */
  host?: string;
  /** listen backlog；缺省 Node 默认。 */
  backlog?: number;
}

export interface Served {
  readonly server: Server;
  /** **实际**端口 —— `port: 0` 时是 OS 分配的那个（日志与 e2e 都靠它）。 */
  readonly port: number;
  /**
   * 停止监听并把连接收干净（`gracefulShutdown` 的最后一步也是它）。
   * 单独给出来是为了「只要关服务器、不要 drain」的手动编排。返回是否干净收口。
   */
  close(opts?: { timeoutMs?: number }): Promise<boolean>;
}

/**
 * 起监听并等到**真的在听**才 resolve。
 *
 * `EADDRINUSE` / `EACCES` 直接 reject（不 swallow）：boot 阶段静默起不来比崩更难查。
 * 返回前把 `error` 监听摘掉，避免后续运行时错误被这个一次性监听吃掉。
 */
export function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  opts: ServeOptions,
): Promise<Served> {
  const server = createServer((req, res) => {
    // handler 允许返回 Promise（`HttpHandler` 就是）；这里不收它 —— 收与不收都改变不了
    // 「请求已交给 handler」这个事实，而漏掉的 rejection 由 handler 自己负责（它内部已在
    // 端点层把错误转成响应）。用 `void` 显式表态，免得读代码的人以为忘了 await。
    void handler(req, res);
  });

  return new Promise<Served>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(
      {
        port: opts.port,
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.backlog ? { backlog: opts.backlog } : {}),
      },
      () => {
        server.off('error', onError);
        const addr = server.address();
        resolve({
          server,
          port: typeof addr === 'object' && addr !== null ? addr.port : opts.port,
          close: (o) => closeServer(server, budgetOf(o?.timeoutMs)),
        });
      },
    );
  });
}

export interface GracefulShutdownOptions {
  server: Server;
  /**
   * 排空业务：通常是 `() => handler.drain({ timeoutMs })`（它返回 `Promise<boolean>`）。
   * 返回 `false` 表示没排干净（语义见 `DrainGate`：此后本进程不再推进任何任务 ⇒ 必须退出）；
   * 返回别的（含 `undefined`）按「排干净」处理，方便 `async () => { await closePool() }` 这类写法。
   * 抛错按 `false` 处理，**但仍然会关服务器** —— 业务排空失败不该让监听继续挂着。
   */
  drain: () => unknown;
  /**
   * 要订阅的信号。**不传 = 不订阅**（框架不做进程级决策）。
   * 传了即「宿主显式认领」—— 与 Nest 的 `enableShutdownHooks()` 同构。
   */
  signals?: readonly NodeJS.Signals[];
  /** 总预算（drain + 关连接共用一份），缺省 15_000；`<= 0` = 不设时限。 */
  timeoutMs?: number;
  /**
   * 第二次信号时调用（通常是 `() => process.exit(1)`）。
   * **不传时不吞信号**：解除本原语的监听，让 Node 默认行为接管（直接终止）——
   * 参考宿主里那句 `if (stopping) return;` 就是反例：信号已被拦截，默认行为不会发生。
   */
  onSecondSignal?: (signal: NodeJS.Signals) => void;
  /**
   * 停机**完成后**调用一次（`clean` = 业务排空**且**连接关干净）。
   * 典型实现是 `process.exit(clean ? 0 : 1)` —— 本原语自己不 exit（退出码与「关池 / 冲 sink
   * 之后再退」是宿主的编排），这是留给它的缝。
   * 信号触发与手动 `stop()` 都会调；`stop()` 幂等 ⇒ 只会调一次。
   * ⚠️ 它抛错会从 `stop()` 抛出；信号路径上的 `stop()` 没人 await ⇒ 表现为 unhandled
   * rejection —— 宿主钩子的错必须响，本原语不替宿主擦屁股。
   */
  onShutdown?: (clean: boolean) => void;
}

/**
 * 停机编排：`drain` → `close()` + 关空闲连接 → 等关闭（超时则强收）。
 *
 * 返回**幂等**的 `stop()`：重复 / 并发调用返回**同一个** in-flight promise（不是第二次返回
 * `false` —— 那会让调用方误以为没排干净）。返回 `true` = 业务已排空**且**连接已干净关闭。
 *
 * ⚠️ 顺序不可参数化：先 `close()` 再 `drain()` 会把在飞请求切断（`close()` 只是不再接受
 * 新连接，已建立的连接仍可写）—— 那就把排空这层保护作废了。
 */
export function gracefulShutdown(opts: GracefulShutdownOptions): () => Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let running: Promise<boolean> | undefined;

  const stop = (): Promise<boolean> => {
    running ??= runShutdown(opts.server, opts.drain, timeoutMs, opts.onShutdown);
    return running;
  };

  const signals = opts.signals ?? [];
  if (signals.length > 0) {
    let first = true;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (!first) {
        // 第二次：交还给调用方或 Node 默认行为 —— **不吞**
        if (opts.onSecondSignal) {
          opts.onSecondSignal(signal);
          return;
        }
        for (const s of signals) process.off(s, onSignal);
        return;
      }
      first = false;
      void stop();
    };
    for (const s of signals) process.on(s, onSignal);
  }

  return stop;
}

/** 缺省停机预算 —— 与 `examples/` 各参考宿主的取值一致 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

/** `timeoutMs` → 绝对截止时刻；`undefined` 取缺省，`<= 0` 表示不设时限（Infinity） */
function budgetOf(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return Date.now() + DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (timeoutMs <= 0) return Number.POSITIVE_INFINITY;
  assertTimerDelay(timeoutMs, 'gracefulShutdown.timeoutMs');
  return Date.now() + timeoutMs;
}

async function runShutdown(
  server: Server,
  drain: GracefulShutdownOptions['drain'],
  timeoutMs: number,
  onShutdown: GracefulShutdownOptions['onShutdown'],
): Promise<boolean> {
  const deadline = budgetOf(timeoutMs);
  let drained = false;
  try {
    drained = (await drain()) !== false;
  } catch {
    // 排空失败也要继续关服务器（见 GracefulShutdownOptions.drain 的注释）
    drained = false;
  }
  const closed = await closeServer(server, deadline);
  const clean = drained && closed;
  onShutdown?.(clean);
  return clean;
}

/**
 * 停监听 + 收连接。返回**是否在预算内关干净**。
 *
 * 三步缺一不可：
 * 1. `close()` —— 不再接受新连接（回调在「所有连接结束」时触发）；
 * 2. `closeIdleConnections()` —— **为 `engines: ">=18"` 的地板而调**。Node **19.0.0** 起
 *    `close()` 自己就会收空闲连接（nodejs/node#43522），官方文档的措辞是「19 之后没必要
 *    再配合调它，但调也无害，且对要支持 <19 的库有用」⇒ 在 22 上这行是冗余的，在 18 上
 *    它是承重的（不调的话 `close()` 会等 keep-alive 挂到 `keepAliveTimeout` = 5s，
 *    K8s 里表现成滚动更新卡满 gracePeriod 再被 SIGKILL）。⚠️ 官方建议它**在 `close()`
 *    之后**调，避免两次调用之间新进的连接漏掉 —— 本函数正是这个顺序。
 *    ⇒ 这条**无法用行为断言钉住**（当前运行时是 22），测试里只能用调用断言。
 * 3. 预算耗尽 → `closeAllConnections()` 强收（否则 `close()` 永不回调，停机卡死）。
 *    「已连接但还没发过请求」的裸 TCP 连接不在 http 的 idle 列表里，只有这一步能收掉它。
 */
function closeServer(server: Server, deadline: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (clean: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(clean);
    };

    if (deadline !== Number.POSITIVE_INFINITY) {
      const delay = Math.max(0, deadline - Date.now());
      timer = setTimeout(() => {
        server.closeAllConnections?.();
        // 强收之后 close 回调通常会紧跟着触发，但**不依赖它**：预算已耗尽，控制权交回宿主
        finish(false);
      }, delay);
      timer.unref?.(); // 定时器不该把进程留住
    }

    server.close((err) => {
      // 没在 listen 的 server 调 close 会回 ERR_SERVER_NOT_RUNNING —— 对宿主来说
      // 「本来就没开」和「关干净了」是同一件事，不该算失败。
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      finish(code === undefined || code === 'ERR_SERVER_NOT_RUNNING');
    });
    server.closeIdleConnections?.();
  });
}
