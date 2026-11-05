import type { IncomingMessage, ServerResponse } from 'node:http';
import { AsyncRunner } from './async.js';
import type { AppCallable } from './async.js';
import { handleRoute } from './http-endpoints.js';
import type { HttpCtx, HttpState } from './http-endpoints.js';
import { errMessage, sendInternalError, sendJson } from './http-io.js';
import { isPreAuthRoute, routeRequest } from './http-route.js';
import type { ResolveRunOptionsHook } from './run-options.js';
import { zeroClauseOf } from '../core/limits.js';

/**
 * Agentia —— HTTP 宿主（spec §6.6：换宿主不换语义，roadmap R3）。
 *
 * 只产出一个 (req, res) handler，不做 listen —— 交给用户
 * `http.createServer(createHttpHandler(app)).listen(...)`，可挂进任意 Node HTTP 框架。
 *
 * **本文件管三件事**（模块拆分第三步之后，另两件事各有其主，别再往这里塞）：
 * ① **宿主契约**：选项与类型（`HttpHandlerOptions` / `HttpHandler` / `HttpException` / 转出）；
 * ② **宿主级状态**：在飞同步 run 计数、停机态、SSE 收口表（`HttpState`，一处创建、按引用共享）；
 * ③ **准入与停机**：构造期把坏配置**响亮拒掉**、每个请求过鉴权闸、`drain()` 的排空编排。
 * 端点契约（每条路读什么 body、回什么、什么状态码）见 `http-endpoints.ts`；
 * 路由判定见 `http-route.ts`；收发原语见 `http-io.ts`。
 *
 * 鉴权（B1）：配了 `authenticate` 时，**除 /healthz 与 /metrics 外的所有路径**先过钩子，
 * 且必须在读 body 之前 —— 未通过即回错误并断开连接，**不接收 body**（省资源）。框架只给缝：
 * token / JWT / 签名策略是宿主或反代的事（框架不读 env、不碰凭据）。
 *
 * 优雅停机（B2）：`handler.drain()` 拒新单（POST /run 与 /tasks → 503）、等异步任务与
 * 在飞同步 run 收尾、强制收口仍开着的 SSE 流；`GET /tasks/<id>` 停机中照常可轮询
 * （否则调用方拿不到在飞任务的结果）。
 */

/**
 * 出入站的形状口径（响应体 / 任务提交体 / 审批体）与它们的类型住在
 * `./http-shapes.js`；这里转出以保持既有 import 路径不变（公开面名字与位置都未变）。
 */
export type { RunHttpResponse, TaskSubmitBody } from './http-shapes.js';

/**
 * `GET /healthz` 的响应形态随它的实现搬到了 `./http-endpoints.js`，这里转出 ——
 * 与上面两个形状类型同一个理由（`src/index.ts` 一行未改，公开面逐字不变）。
 */
export type { HealthResponse } from './http-endpoints.js';

export type HttpResponseMode = 'full' | 'public';
export type TaskControlAction = 'poll' | 'approve' | 'cancel' | 'event' | 'stream';

export type TaskAuthorizationHook = (
  req: IncomingMessage,
  info: {
    action: TaskControlAction;
    taskId: string;
    task: import('../store/store.js').TaskRecord;
    principal: unknown;
  },
) => unknown | Promise<unknown>;

export type ApprovalActorHook = (
  req: IncomingMessage,
  principal: unknown,
) => string | undefined | Promise<string | undefined>;

export interface HttpHandlerOptions {
  /** 异步任务宿主；缺省 new AsyncRunner(app)（InMemoryTaskStore） */
  runner?: AsyncRunner;
  /** 请求 body 上限（字节），超限回 413；缺省 1 MiB */
  maxBodyBytes?: number;
  /**
   * 同时在执行的 POST /run 上限；缺省 32，超限回 503 + `Retry-After`。
   * 传 `Infinity` 恢复无上限（旧行为）。**行为变更**：旧版本无此闸门。
   * 闸门针对同步 RPC —— 每次请求都会真跑一次 run，不设上限时少量并发请求
   * 就能把宿主压垮（上游模型并发也一起打满）；异步走 POST /tasks（runner 自带上限）。
   */
  maxConcurrentRuns?: number;
  /**
   * 是否把内部异常原文回给调用方；缺省 false。
   * false 时 500 只回通用文案，细节走 `console.error` —— 否则
   * `ECONNREFUSED 10.0.0.7:6379` 这类内部拓扑会回给未鉴权的调用方。
   */
  exposeErrors?: boolean;
  /**
   * SSE 下游积压上限（字节）：`res.writableLength` 超过它即收口该 SSE 流（见 `sseWriter`）。
   * 缺省 8 MiB —— 正常客户端远达不到，实际只拦「连得上但不读」的消费者。
   *
   * **收口会连带中止对应的 run**：客户端已经不消费了，继续逐 token 生成只是白花模型钱，
   * 同时把内存堆高。要高限额传更大的值；要记录/告警请自行在 `sseWriter` 之上包一层 sink。
   */
  sseMaxBufferedBytes?: number;
  /**
   * 入口鉴权钩子。请求进入时调用，**除 /healthz 与 /metrics 外所有路径**都过它，且**在读 body 之前**
   * （未通过就不接收 body，省资源）。/metrics 与 /healthz 同档不鉴权（见 `metrics` 选项）。
   * - 正常返回 → 视为通过。**返回值不再丢弃**：它作为 `principal` 交给
   *   `resolveRunOptions(req, { route, principal })`（2026-11-04 起；此前注释写的是
   *   「返回值框架不转交，请存在钩子自己的闭包里」—— 那条路走不通：闭包与 run 之间
   *   没有任何关联手段，runId 是 run 开始后才有的。身份入 run 的唯一可信通道就是这一条）。
   * - 抛出 `HttpException` → 按其 `status` / `body` 回响应（想回 403 就抛 `status: 403`）；
   * - 抛出其它错误 → 回 401 `{ error: '未通过鉴权' }`，原文只进服务端日志
   *   （与 `exposeErrors` 同理：不把内部拓扑回给未鉴权的调用方）。
   *
   * 框架**不实现策略**（token / JWT / 签名都不做）—— 那是宿主或反代的事（框架不读 env、
   * 不碰凭据）。为什么不做成 middleware：middleware 拦的是**能力调用**（run 内部），
   * 而鉴权要拦的是 **run 入口**，且必须早于 body 读取。
   */
  authenticate?: (req: IncomingMessage) => unknown | Promise<unknown>;
  /**
   * 按请求给 run 选项（**身份 / 租户 / 配额封顶的唯一可信通道**）。与 `authenticate` 配对使用：
   * 后者的返回值会作为 `principal` 传进来。
   *
   * 为什么需要它：`POST /tasks` 的 `body.options` 此前整体透传给引擎 —— 任何能调它的人都能
   * 自填 `blackboard: { tenant: '别人的租户' }`（而 usage-guide §6.6 的多租户配方正是
   * 「用黑板存 tenant」），于是配额记到别人头上。现在客户端选项走**白名单**
   * （见 `run-options.ts`），身份只能从这里进，且服务端值**覆盖**客户端值。
   *
   * 两条口径：`blackboard` 整体替换、`labels` 按键盘合并（服务端胜）、预算与客户端值
   * 取**更严者**（上限不能由叫价方抬高）。抛 `HttpException` 按其状态码回。
   */
  resolveRunOptions?: ResolveRunOptionsHook;
  /**
   * 任务控制面的对象级授权。`authenticate` 只回答「你是谁」，本钩子回答
   * 「你能不能对这个 task 做这件事」。在读取审批/事件 body 之前执行；
   * 返回 `false` 回 403，抛 `HttpException` 按其状态码回，其余异常走 500。
   */
  authorizeTask?: TaskAuthorizationHook;
  /**
   * 从认证结果生成可信审批人。配置后其返回值覆盖审批 body 的 `decidedBy`；
   * 返回 `undefined` 表示不记审批人。空字符串是宿主配置错误，按 500 处理。
   */
  resolveApprovalActor?: ApprovalActorHook;
  /**
   * HTTP 响应暴露面。`full`（缺省）保留历史形状；`public` 去掉 run/task 响应里的
   * trace、任务消息、挂起历史和内部 ownerId，并默认关闭 SSE 的 trace.event 帧。
   * 它只影响 HTTP 输出，不影响 TaskStore 与 TraceSink 的完整记录。
   */
  responseMode?: HttpResponseMode;
  /** 是否开放 `/run` 与 `/tasks/:id/stream` 的 trace 事件；缺省 = responseMode 为 full */
  exposeTraceEvents?: boolean;
  /**
   * 指标出口（G4）：提供后 `GET /metrics` 输出其 `render()` 的文本。
   * 通常直接传 `metricsSink()`（它有 `render()`）。
   *
   * 响应的 Content-Type 跟提供者的 `contentType` 字段走（metricsSink 会按自己的
   * `export` 模式声明：openmetrics 模式 ⇒ `application/openmetrics-text`，
   * 带 exemplar 的文本必须配这个头）；没有这个字段（或传的是纯函数）⇒
   * 缺省 `text/plain; version=0.0.4`，与既有行为一致。
   *
   * 与 `/healthz` 同档处理：**不鉴权**、停机中仍可拉（拉取端在集群内网）。要保护它，
   * 请放到反代之后，或不要传这个选项、自己在 handler 外层挂路由。
   *
   * 框架只给缝：它不知道指标从哪来 —— 传 sink、传读快照的闭包都行。
   */
  metrics?: { render(): string; contentType?: string } | (() => string);
}

/**
 * 鉴权钩子可抛出的异常：显式携带 HTTP 状态与响应体。
 * 钩子抛别的错误一律按 401 处理（设计 F4：与「工具抛错即 is_error」的既有风格一致）。
 *
 * 它**刻意留在本文件**（而不是随应答原语去 `http-io.ts`）：`HttpException` 是**宿主契约**
 * 的一部分（公开导出、鉴权钩子的抛出类型），而 `http-io.ts` 是零内部依赖的原语层 ——
 * 搬过去会让原语层反向依赖宿主，只为了让 `sendUnauthorized` 能 `instanceof` 一下。
 */
export class HttpException extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body?: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpException';
    this.status = status;
    this.body = body ?? { error: `HTTP ${status}` };
  }
}

/** createHttpHandler 的产物：可直接传给 http.createServer，另带停机控制面 */
export interface HttpHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * 优雅停机：拒新单（POST /run、/tasks → 503）→ 等异步任务与在飞同步 run 收尾
   * （或超时）→ 强制收口仍开着的 SSE 流。返回是否排空干净（超时/仍有在飞为 false）。
   * 未完成的任务仍在 store 里，下次启动由 `resumePending` 续跑。
   * 框架**不订阅 SIGTERM**：`process.on('SIGTERM', () => handler.drain())` 是宿主的事。
   */
  drain(opts?: { timeoutMs?: number }): Promise<boolean>;
  /** 内部 AsyncRunner —— 需要时手动控制（resumePending / awaitTask / list 等） */
  readonly runner: AsyncRunner;
}

/** body 上限缺省值：1 MiB —— 本宿主只接 messages JSON，正常远小于此 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** POST /run 并发上限缺省值：32 —— 够单机跑满，又不至于让上游被单宿主打爆 */
const DEFAULT_MAX_CONCURRENT_RUNS = 32;

/**
 * 鉴权未通过（B1）。`HttpException` 按其 status/body 回；其它错误回 401 通用文案，
 * 原文只进日志（除非 exposeErrors）。
 *
 * **连接处理**：这里在读到 body 之前就回了响应，请求体没被消费 —— 连接不能复用，
 * 否则残留字节会被当成下一个请求（与 413 同理）。故 `req.complete` 为假时显式
 * `connection: close`，让客户端尽早停止上传（这也正是「省资源」的落点）。
 *
 * 留在这里而不是随其余应答原语去 `http-io.ts`：它是**唯一** `instanceof HttpException`
 * 的落点，而 `HttpException` 是宿主契约（见其类注释）。
 */
function sendUnauthorized(
  req: IncomingMessage,
  res: ServerResponse,
  e: unknown,
  exposeErrors: boolean,
): void {
  // 在读到 body 之前就回了响应：请求体没被消费 → 连接不能复用
  // （残留字节会被当成下一个请求，与 413 同理）。这也正是「不收 body 省资源」的落点。
  if (!req.complete) res.setHeader('connection', 'close');
  if (e instanceof HttpException) {
    sendJson(res, e.status, e.body);
    return;
  }
  if (exposeErrors) {
    sendJson(res, 401, { error: errMessage(e) });
    return;
  }
  console.error('[agentia:http] 鉴权钩子异常:', e);
  sendJson(res, 401, { error: '未通过鉴权' });
}

/**
 * 轮询等待条件成立，直到 deadline（`Infinity` = 一直等）。返回是否等到了。
 * 用于 drain 里等同步 run 收尾 —— 事件驱动没有「在飞数变 0」的回调，轮询足够。
 */
async function waitUntil(cond: () => boolean, deadline: number): Promise<boolean> {
  while (!cond()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

export function createHttpHandler(app: AppCallable, opts: HttpHandlerOptions = {}): HttpHandler {
  const runner = opts.runner ?? new AsyncRunner(app);
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!(maxBodyBytes > 0)) {
    // 判据是 `size > maxBytes` ⇒ 0 时**任何字节**都超限 ⇒ 所有带 body 的请求 413。
    // 与同一接口里的 maxConcurrentRuns（0 ⇒ 全部 503）同款：配置错误，构造期响亮失败。
    // ⚠️ 还挡 `Number('') === 0`（空的环境变量）这类静默事故。要「不限」用 Infinity。
    throw new Error(
      `maxBodyBytes 必须为正数（${zeroClauseOf('HttpHandlerOptions.maxBodyBytes')}），收到 ${String(opts.maxBodyBytes)}`,
    );
  }
  if (opts.sseMaxBufferedBytes !== undefined && !(opts.sseMaxBufferedBytes > 0)) {
    // 透传给 `sseWriter`（它自己也会拦），这里拦是为了**构造期**就响亮失败，
    // 而不是等到第一个 SSE 请求才炸（那时响应头可能已写出，只能回 200 再断流）。
    throw new Error(
      `sseMaxBufferedBytes 必须为正数（${zeroClauseOf('SseWriterOptions.maxBufferedBytes')}），收到 ${String(opts.sseMaxBufferedBytes)}`,
    );
  }
  const maxConcurrentRuns = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  if (!(maxConcurrentRuns > 0)) {
    // NaN 会让 `inFlightRuns >= maxConcurrentRuns` 恒 false（闸门静默失效）；
    // 0 / 负数则全部 503 —— 都是配置错误，宁可在构造期响亮失败。
    // Infinity 合法（`Infinity > 0` 成立）：无上限（见选项注释）。
    throw new Error(
      `maxConcurrentRuns 必须为正数（${zeroClauseOf('HttpHandlerOptions.maxConcurrentRuns')}），收到 ${opts.maxConcurrentRuns}`,
    );
  }
  const exposeErrors = opts.exposeErrors ?? false;
  const responseMode = opts.responseMode ?? 'full';
  if (responseMode !== 'full' && responseMode !== 'public') {
    throw new TypeError(`responseMode 只接受 'full' | 'public'，收到 ${String(opts.responseMode)}`);
  }
  const exposeTraceEvents = opts.exposeTraceEvents ?? responseMode === 'full';
  const sseMaxBufferedBytes = opts.sseMaxBufferedBytes;
  const authenticate = opts.authenticate;
  const resolveRunOptions = opts.resolveRunOptions;
  const authorizeTask = opts.authorizeTask;
  const resolveApprovalActor = opts.resolveApprovalActor;
  const metrics = opts.metrics;
  const startedAt = Date.now();

  /**
   * 宿主级可变状态：**一处创建、按引用共享**（HTTP 路径上的每一方拿到的都是这一个对象）。
   * 拆成对象而不是三个闭包变量，是为了让它能交给 `http-endpoints.ts` 的端点表 ——
   * 而「只此一份」这条不变量同时被 `drain()`（读在飞数、置停机态、收 SSE）与
   * `/healthz`（读同一份）依赖：复制即失效。见 `HttpState`。
   */
  const state: HttpState = {
    inFlightRuns: 0,
    draining: false,
    openSse: new Set(),
  };

  /**
   * 强制收口全部仍开着的 SSE 流，返回**切掉了几条在飞的 run**
   * （只关旁观者的长连不计 —— 判据在 `OpenSseHandle.cutsRun` 上，别在这里重新推导）。
   */
  const closeStreams = (): number => {
    let cutRuns = 0;
    for (const s of [...state.openSse]) {
      if (s.cutsRun) cutRuns++;
      s.close();
    }
    return cutRuns;
  };

  /**
   * 优雅停机（B2）：拒新单 → 等异步任务与在飞同步 run → 强制收口 SSE。
   *
   * ⚠️ `timeoutMs` 缺省 0 = **对在飞工作**一直等；**活连接（SSE）不享受无限窗口** ——
   * 没有 deadline 时先把它们收口再等，否则等待没有终点（见下面那段顺序陷阱的注）。
   */
  const drain = async (drainOpts: { timeoutMs?: number } = {}): Promise<boolean> => {
    state.draining = true; // 先拒新单，再等存量
    const timeoutMs = drainOpts.timeoutMs ?? 0;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

    // 异步任务：排在 waitQueue 里的也一并等（它们的记录在 store 里，超时未跑完则下次启动续跑）。
    //
    // ⚠️「不限」与「已到点」不能混为一谈：async.ts 的 drain 把 `timeoutMs <= 0` 读作
    // **不限**（一直等），而「剩余时间」在 deadline 已过时恰好是 0 —— 直接把 remaining()
    // 透传下去，等于把「已经到点了」说成「不限」：优雅停机永不返回、也永不报 false，
    // SIGTERM 的容器只能在宽限期后被强杀，在飞任务硬切。已到点就自己认账（false），
    // 不交给下游按「0 = 不限」去猜。
    let tasksDrained: boolean;
    if (deadline === Number.POSITIVE_INFINITY) {
      tasksDrained = await runner.drain({});
    } else {
      const left = deadline - Date.now();
      tasksDrained = left > 0 ? await runner.drain({ timeoutMs: left }) : false;
    }
    // 同步 /run（含 SSE 流）也在 inFlightRuns 里计数 —— 同样给到 deadline。
    //
    // ⚠️ 顺序陷阱（2026-09-28 修）：SSE 的**强制收口必须先于这次等待**地做出判断。
    // 此前收口排在等待**之后** ⇒ 若某条 SSE 的 run 自己不结束（客户端不断线 + 长跑），
    // `waitUntil(..., Infinity)`（`timeoutMs` 缺省 0 = 一直等）永不返回，而**唯一**能结束
    // 它的机制（收口 = 关流 + abort 对应 run）排在等待后面 ⇒ 死锁：`drain()` 既不返回也不报
    // false，SIGTERM 的容器只能在宽限期后被强杀（正是本函数上面那段注释要避免的事）。
    //
    // 为什么只在「无 deadline」时提前：**「一直等」承诺的是「等在飞工作自己收尾」**，而活连接
    // （SSE）没有「自己收尾」的义务，不该给它无限窗口。有 deadline 时保持既有优雅：先给流到
    // deadline 的窗口自己收尾，到点再硬收（那条路径行为逐字不变）。
    const unbounded = deadline === Number.POSITIVE_INFINITY;
    const cutEarly = unbounded ? closeStreams() : 0;
    const runsDrained =
      state.inFlightRuns === 0 || (await waitUntil(() => state.inFlightRuns === 0, deadline));
    // 收口：仍挂着的 SSE 流强制关闭。closeSse 会同时 abort 对应 run（stopReason='aborted'）
    // ——只 close 不 abort 的话，res.end() 让 writableEnded 同步变 true，onClose 守卫永不触发，
    // run 会在后台继续烧 token（实测复现）。
    closeStreams();
    // ⚠️ 返回值如实分两种收口（`OpenSseHandle.cutsRun`）：**切过在飞的 run** ⇒ 不算排空干净
    // （工作是被 abort 收尾的，回 true 等于把「切了」说成「等干净了」）；只关掉旁观者的长连
    // （`/tasks/<id>/stream`）⇒ 不损失任何工作，不参与这个判断（记成 false 是另一种说错话）。
    return tasksDrained && runsDrained && cutEarly === 0;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const pathname = (req.url ?? '/').split('?')[0];
    // 路由判定是**纯函数**（见 http-route.ts）：这里只按判定结果去编排。
    // 顺序陷阱写在那边的头注里，最要命的一条：免鉴权组（/healthz、/metrics）
    // 连同它们自己的 405 都在鉴权**之前**回，其余一律**先鉴权再判方法/路径**。
    const route = routeRequest(pathname, method, metrics !== undefined);
    try {
      // 鉴权缝：必须在读 body 之前（未通过即断开，body 一个字节都不收）。
      // 写成**否定条件**（「不是免鉴权组才过闸」）而不是「先 if (免鉴权组) { 一大段应答 }」：
      // 这样 `handler` 里只剩「谁被豁免」这一处判据可读，而被豁免者**回什么**在端点表里 ——
      // 豁免名单只有一份真源（`http-route.ts` 的 `isPreAuthRoute`）。
      let principal: unknown;
      if (!isPreAuthRoute(route) && authenticate) {
        try {
          // 返回值**不再是丢弃的**：它就是 `principal`，交给 `resolveRunOptions`。
          // 身份 → run 只该有这一条路（见 `HttpHandlerOptions.authenticate` 的注释）。
          principal = await authenticate(req);
        } catch (e) {
          sendUnauthorized(req, res, e, exposeErrors);
          return;
        }
      }
      // 一个请求一份 ctx：`state` 按引用共享，其余是构造期已解析好的值（不再有 `?? 缺省`）。
      // 放在鉴权之后建，是因为 `principal` 是 ctx 的字段（身份随请求走，不存闭包）。
      const ctx: HttpCtx = {
        req,
        res,
        pathname,
        method,
        route,
        app,
        runner,
        state,
        maxBodyBytes,
        maxConcurrentRuns,
        sseMaxBufferedBytes,
        exposeErrors,
        startedAt,
        metrics,
        principal,
        resolveRunOptions,
        authorizeTask,
        resolveApprovalActor,
        responseMode,
        exposeTraceEvents,
      };
      // 至此路由已定、鉴权已过 —— 剩下的全是「走到这条路上做什么」，在 http-endpoints.ts
      await handleRoute(route, ctx);
    } catch (e) {
      // 端点（或 `resolveRunOptions` 钩子）抛 `HttpException` ⇒ 它自带状态码与响应体。
      // 认领点刻意放在**宿主**这一层：端点模块不 import 宿主的值（依赖方向单向，
      // 见 http-endpoints.ts 文件头），而钩子的错误语义属于宿主契约。
      if (e instanceof HttpException) {
        sendJson(res, e.status, e.body);
        return;
      }
      sendInternalError(res, e, exposeErrors);
    }
  };

  // 把停机控制面挂在 handler 上（不破坏 (req, res) 的调用形状）
  return Object.assign(handler, { drain, runner });
}
