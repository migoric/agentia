import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseTraceparent } from '../core/trace.js';
import { TaskInputError, normalizeMessages } from '../engine/spec.js';
import type { TaskRecord } from '../store/store.js';
import {
  type AsyncRunner,
  TaskApproveError,
  TaskCancelError,
  TaskEventError,
  TaskQueueFullError,
  TaskStreamError,
} from './async.js';
import type { AppCallable, TaskStreamFrame } from './async.js';
import {
  PARSE_FAILED,
  RETRY_AFTER_SECONDS,
  errMessage,
  headerValue,
  methodNotAllowed,
  parseJsonBody,
  sendInternalError,
  sendJson,
  sendPrometheus,
  sendShuttingDown,
} from './http-io.js';
import type { HttpRoute } from './http-route.js';
import { parseApproveBody, parseEventBody, toHttpBody, toTaskSubmitBody } from './http-shapes.js';
import { sseWriter } from './sse.js';

/**
 * Agentia —— HTTP 宿主的**端点体**（`transport/http.ts` 拆分第三步的两半之一）。
 *
 * 走到一条路上之后**具体做什么**：读 body → 调 runner / 跑 run → 写响应 → 选状态码。
 * 本文件是这一步的**全部落点** —— `http.ts` 里不再有任何一条路由的体。
 *
 * 与邻居的分界（三件事各有其主，越界即乱源）：
 * - `http-route.ts` = **这是哪条路**：`(pathname, method, 有无 metrics) → HttpRoute`，纯函数；
 * - 本文件 = **走到这条路上做什么**：`HttpRoute` 已有定论，这里只按 kind 派发/执行；
 * - `http-io.ts` = **怎么收发**：读 body / 写 JSON / 405 / 413 / 503 / 500 的机械动作。
 *
 * 为什么要有 `HttpCtx`（而不是像拆分前那样靠闭包）：端点体原先住在 `createHttpHandler`
 * 的闭包里，共享 `inFlightRuns` / `draining` / `openSse` 三个 `let` 与一组旋钮。
 * 搬出闭包就得把这份上下文**显式化**：`HttpCtx` 就是它。顺带的好处是那三个 `let`
 * 终于有了名字（`HttpState`）—— 「在飞计数」不再是散在 840 行里的一个变量，
 * 而是一个有名字、有注释、只由宿主创建一次的**状态对象**。
 *
 * ⚠️ `state` 是**引用共享**的（本模块拿到的是 `createHttpHandler` 里那个对象本身）：
 * 想改在飞计数或停机态，只能通过它。`drain()` 与 `/healthz` 读的也是同一份 ——
 * 「健康检查和停机判断看的是同一个数」这条就是这么保住的（复制一份即失效）。
 *
 * 依赖方向（单向，**运行期无环**）：本模块引 `http-io` / `http-route`（类型）/
 * `http-shapes` / `sse` / `async`，**不 import `http.ts` 的任何值** ——
 * ctx 与状态类型都定义在本模块，`http.ts` 反向以 `import type` 取（编译期擦除）。
 * 派发表本身**不认识宿主**：它不知道有没有鉴权钩子、不知道停机闸在哪
 * —— 那是 `http.ts` 的 `handler` 在调用本模块**之前**做完的事。
 */

/**
 * 指标出口（`HttpHandlerOptions.metrics` 的形状，宿主透传进来）。
 *
 * 这里刻意**不** import `HttpHandlerOptions` —— ctx 只装「已解析好的值」，
 * 不装宿主的选项包。两处形状若漂移由 `http.ts` 构造 ctx 时的那次赋值在编译期拦住。
 */
export type MetricsProvider = { render(): string; contentType?: string } | (() => string);

/** GET /healthz 的响应形态 */
export interface HealthResponse {
  /** 恒为 true：能回这个响应就说明进程活着（停机中也是 true，就绪与否看 draining） */
  ok: true;
  /**
   * 在飞工作量 = **正在处理的同步 run**（并发闸门计数，含 SSE 流）
   *            + **已受理未完成的异步任务**（queued + running）。
   * 与 `drain()` 等的范围一致 —— 这样健康检查和停机判断看的是同一个数。
   */
  inFlight: number;
  /** 本 handler 创建至今的毫秒数 */
  uptimeMs: number;
  /** 是否已进入优雅停机（drain 之后）—— 负载均衡据此摘流量 */
  draining: boolean;
  /**
   * 挂起读数（配套 6）：按原因分组的条数 + 最早的目标时刻。
   *
   * 口径 = **本进程**看得见的记录（与 `inFlight` 同一张表）—— 多进程部署要合并看板请自己
   * 聚合，这里不假装是全局面。值直接来自 `runner.suspendedSummary`（**不查 store**：
   * `/healthz` 是秒级频率的探针端点，全表反序列化的代价比它回答的问题大得多）。
   */
  suspended: {
    /** 等人工决定（HITL）的条数 */
    approval: number;
    /** 等一个时刻（durable timer）的条数 */
    timer: number;
    /** 最早的目标时刻（epoch ms）；一条时间挂起都没有 ⇒ `null`（不是 `0`） */
    nextWakeAt: number | null;
  };
}

/**
 * 一条仍开着的 SSE 流的**收口句柄**（`HttpState.openSse` 的元素）。
 *
 * `cutsRun` 不是装饰：两条 SSE 路径的收口语义**不同**，而 `drain()` 的返回值要如实区分
 * 它们 —— `/run` 收口**连带中止在飞的 run**（工作被切，回 `true` 就是谎称排空干净），
 * `/tasks/<id>/stream` 只是旁观者退订（关掉它不损失任何工作，把它算成「没排干净」是另一种
 * 说错话，2026-09-28）。
 */
export interface OpenSseHandle {
  readonly close: () => void;
  /** 收口是否**中止在飞的 run**（`/run` = true；`/tasks/<id>/stream` = false） */
  readonly cutsRun: boolean;
}

/**
 * 宿主级的**可变状态**（原先散在 `createHttpHandler` 里的三个 `let`）。
 *
 * 由宿主创建**一份**、按引用交给每个请求的 ctx：`drain()` 与 `/healthz`/`/run` 读写的
 * 必须是同一份，复制即失效（「健康检查与停机判断看同一个数」这条承诺靠它成立）。
 */
export interface HttpState {
  /**
   * 在飞的**同步 run**（含 SSE 长连）—— 它同时是 `/run` 的并发闸门与 `/healthz`
   * 的 `inFlight` 的一半（另一半是 `runner.inFlight`，异步任务那份在 runner 手里）。
   * ⚠️ 增量与减量必须配对（`handleRun` 用 try/finally 兜），漏一次就永久占住一个槽。
   */
  inFlightRuns: number;
  /** 是否已进入优雅停机（`drain()` 置真，**单向**：本进程此后不再接单、不再派发新 run） */
  draining: boolean;
  /**
   * 仍开着的 SSE 流的收口句柄 —— `drain` 时强制 close，否则长连会把进程吊住。
   * 两条 SSE 路径（`/run` 与 `/tasks/<id>/stream`）各自登记，语义差别见 `OpenSseHandle`。
   */
  readonly openSse: Set<OpenSseHandle>;
}

/**
 * 一个请求的上下文：把端点体原先从闭包里拿到的东西**显式化**。
 *
 * 旋钮字段装的是**构造期已解析好的值**（缺省已落定、坏值已在构造期抛过），
 * 所以端点体里不该再出现 `?? 缺省值`。
 */
export interface HttpCtx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** 已剥掉 query 的路径（404 文案用；判定在 `http-route.ts` 里做过了） */
  readonly pathname: string;
  /** 已兜过缺省的方法（405 文案用） */
  readonly method: string;
  /** `routeRequest` 的结论。**只读**：本模块不重新判定路由 */
  readonly route: HttpRoute;
  readonly app: AppCallable;
  readonly runner: AsyncRunner;
  /** 与宿主同生共死的可变状态（见 `HttpState`） */
  readonly state: HttpState;
  readonly maxBodyBytes: number;
  readonly maxConcurrentRuns: number;
  readonly sseMaxBufferedBytes: number | undefined;
  /** 是否把内部异常原文回给调用方（500 与鉴权失败共用同一个旋钮） */
  readonly exposeErrors: boolean;
  readonly startedAt: number;
  readonly metrics: MetricsProvider | undefined;
}

/**
 * **派发表**：`HttpRoute` 的每个 kind → 谁来做。
 *
 * 免鉴权组（`healthz` / `metrics`）与它们的 405 也在这张表里 —— 调用方
 * （`http.ts` 的 `handler`）只在**调用本函数之前**决定要不要过鉴权闸，
 * 表本身不认识「鉴权」这回事（见文件头注的分界）。
 *
 * `case` 顺序在这里**没有语义**（不像 `http-route.ts` 那边顺序即全部内容）：
 * `kind` 已经是一个被判定完的判别联合成员，落到这里只剩「谁接」。
 * 这点值得单独说：**判定与派发是两件事**，把顺序陷阱留在判定那一侧，
 * 才能让这张表纯粹到「读一眼就是全部」。
 *
 * 末尾 `default` 是**编译期穷尽性断言**：12 个 kind 全被 `case` 覆盖后
 * `route` 收窄为 `never`，新增成员即 TS2322 —— 而不是被静默吞成 404。
 * （拆分前这里是 `const residual: 'healthz' | 'metrics' | 'notFound' = route.kind`：
 * 因为免鉴权组在上游提前 return 了，只能断言「剩下的只可能是这三个」。现在 12 条
 * 全在一张表里，断言可以更强、也不必再解释「前两个已经回过了」。）
 */
export async function handleRoute(route: HttpRoute, ctx: HttpCtx): Promise<void> {
  switch (route.kind) {
    case 'healthz':
      return handleHealthz(ctx);
    case 'metrics':
      return handleMetrics(ctx);
    case 'methodNotAllowed':
      return methodNotAllowed(ctx.res, ctx.method, route.allowed);
    case 'run':
      return handleRun(ctx);
    case 'submit':
      return handleSubmit(ctx);
    case 'approve':
      return handleApprove(route.taskId, ctx);
    case 'poll':
      return handlePoll(route.taskId, ctx);
    case 'cancel':
      return handleCancel(route.taskId, ctx);
    case 'taskEvent':
      return handleTaskEvent(route.taskId, ctx);
    case 'taskStream':
      return handleTaskStream(route.taskId, ctx);
    case 'badTaskId':
      // 残缺的 % 转义会抛 URIError —— 是调用方的输入问题（400），不是服务端 500
      return sendJson(ctx.res, 400, { error: 'taskId 不是合法的 URL 编码' });
    case 'notFound':
      return sendJson(ctx.res, 404, { error: `路径不存在: ${ctx.pathname}` });
    default: {
      const _never: never = route;
      void _never;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 免鉴权组：探针与指标抓取（不鉴权、停机中也照回），以及它们的 405
// ────────────────────────────────────────────────────────────────────────────

/** GET /healthz：进程活着就回 200；就绪与否看 `draining`，在飞口径见 `HealthResponse` */
function handleHealthz(ctx: HttpCtx): void {
  const { res, runner, state, startedAt } = ctx;
  sendJson(res, 200, {
    ok: true,
    inFlight: state.inFlightRuns + runner.inFlight,
    uptimeMs: Date.now() - startedAt,
    draining: state.draining,
    // 挂起读数（配套 6）：在飞 ≠ 在等 —— 「几条在睡、最早什么时候醒」是运维要看的那半
    suspended: runner.suspendedSummary,
  } satisfies HealthResponse);
}

/**
 * GET /metrics（G4）：输出提供者 `render()` 的文本，与 `/healthz` 同档（不鉴权、
 * 停机中仍可拉 —— 抓取端在集群内网）。
 *
 * `?.` 只为让类型收窄（这条分支只在配了 metrics 出口时可达），行为与原来一致。
 * Content-Type 跟提供者走：metricsSink 在 openmetrics 模式下会声明
 * `application/openmetrics-text`（带 exemplar 的文本拿 0.0.4 的头去发，
 * 严格抓取端会解析失败）；纯函数形态的提供者没有这个字段 ⇒ 回落 0.0.4。
 */
function handleMetrics(ctx: HttpCtx): void {
  const provider = ctx.metrics;
  sendPrometheus(
    ctx.res,
    typeof provider === 'function' ? provider() : (provider?.render() ?? ''),
    typeof provider === 'function' ? undefined : provider?.contentType,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 同步 RPC
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /run：同步 RPC。body = `RunInput`（string / messages / `{prompt|text|messages}`），
 * 走 `normalizeMessages` 规整后同步执行。
 *
 * 两个出口：
 * - `Accept: text/event-stream` ⇒ SSE 逐帧下发（`text.delta` / `trace.event` /
 *   `run.end`，异常时 `error`）；
 * - 其余 ⇒ 一元 JSON（旧行为逐字不变）。
 *
 * 状态码：输入无法规整为 messages → 400；并发 run 超 `maxConcurrentRuns` → 503 +
 * `Retry-After`；`status=failed` **也照返 200**（`rethrow:false` 语义：硬失败以
 * `error` 字段返回，不用 HTTP 错误码表达）。
 */
async function handleRun(ctx: HttpCtx): Promise<void> {
  const { req, res, app, state, maxConcurrentRuns, sseMaxBufferedBytes } = ctx;
  if (state.draining) {
    sendShuttingDown(req, res);
    return;
  }
  const input = await parseJsonBody(req, res, ctx.maxBodyBytes);
  if (input === PARSE_FAILED) return;
  let messages: ReturnType<typeof normalizeMessages>;
  try {
    messages = normalizeMessages(input);
  } catch (e) {
    sendJson(res, 400, { error: errMessage(e) });
    return;
  }
  // 并发闸门：body 已读完（连接可复用），只是暂时不给跑 —— 回 503 让调用方退避重试
  if (state.inFlightRuns >= maxConcurrentRuns) {
    res.setHeader('retry-after', RETRY_AFTER_SECONDS);
    sendJson(res, 503, {
      error: `并发 run 已达上限 ${maxConcurrentRuns}，请稍后重试`,
    });
    return;
  }
  state.inFlightRuns++;
  // 客户端中途断开 → 中止本次 run（省 token）。res 'close' 正常结束也会触发，
  // 故以 writableEnded 区分：只有响应还没写完才算「断开」。
  const runAc = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) runAc.abort();
  };
  res.once('close', onClose);
  // 内容协商：`Accept: text/event-stream` → SSE 逐帧下发；否则一元 JSON（旧行为逐字不变）
  const wantsSse = String(req.headers.accept ?? '').includes('text/event-stream');
  // 入站链路（spec §9.2）：W3C `traceparent` 头 → run 根的 links。
  // 畸形/缺头一律静默当作「没有上游上下文」（parseTraceparent 统一判定）——
  // 链路是观测行为，不该因为一个坏头把业务请求打成 400。
  const traceContext = parseTraceparent(headerValue(req, 'traceparent'));
  try {
    if (wantsSse) {
      const sse = sseWriter(res, {
        maxBufferedBytes: sseMaxBufferedBytes,
        // 下游积压超限 → 收口并中止本次 run（见 sseWriter 的背压说明）
        onBackpressure: () => runAc.abort(),
      });
      const heartbeat = setInterval(() => sse.comment('ping'), 15_000);
      heartbeat.unref?.();
      // 登记收口函数：drain 时强制关闭（SSE 是长连，不关会把进程吊住）。
      // 收口必须同时 abort 对应 run：sse.close() → res.end() 后 writableEnded 同步
      // 变 true，上面的 onClose 守卫（`!writableEnded`）在 close 事件时不成立，
      // 只 close 不 abort 会让 run 在后台继续烧 token（与背压收口路径的
      // onBackpressure → abort 对齐；run 已正常结束时 abort 是无害 no-op）。
      const closeSse = (): void => {
        clearInterval(heartbeat);
        runAc.abort();
        sse.close();
      };
      // `cutsRun: true` —— 收口连带中止本次 run（见 `OpenSseHandle`：drain 的返回值靠它如实）
      const sseHandle: OpenSseHandle = { close: closeSse, cutsRun: true };
      state.openSse.add(sseHandle);
      try {
        // rethrow:false —— 与 AsyncRunner 对齐：硬失败也以 run.end 下发（status/error 字段）
        const out = await app.run(messages, {
          rethrow: false,
          signal: runAc.signal,
          onText: (delta) => sse.event('text.delta', { text: delta }),
          // 增量记账出口（F3 当初判「架构代价大、后置」的那半）：既有三帧
          //（text.delta / run.end / error）逐字不变，这里只**追加**一族帧 ——
          // 不认识 `trace.event` 的老客户端行为零变化。
          // 帧名取一族（body 里的 type 区分）而不是每类型一帧：将来加新事件类型时，
          // 老客户端只是漏掉一种 type，而不是漏掉一种**帧名**（后者更隐蔽）。
          onTraceEvent: (e) => sse.event('trace.event', e),
          ...(traceContext !== undefined ? { traceContext } : {}),
        });
        sse.event('run.end', toHttpBody(out));
      } catch (e) {
        // 流已开（200 与头已发出）→ 只能以 error 事件收尾，不能再改 HTTP 状态码
        sse.event('error', { message: errMessage(e) });
      } finally {
        state.openSse.delete(sseHandle);
        closeSse();
      }
      return;
    }
    // rethrow:false —— 与 AsyncRunner 对齐：硬失败也以 status/error 字段返回 200
    const out = await app.run(messages, {
      rethrow: false,
      signal: runAc.signal,
      ...(traceContext !== undefined ? { traceContext } : {}),
    });
    sendJson(res, 200, toHttpBody(out));
  } finally {
    res.off('close', onClose);
    state.inFlightRuns--;
  }
}

/**
 * POST /tasks：异步任务。body `{ input, idempotencyKey?, options? }`
 * → `runner.submit` → 202 `TaskRecord`（queued，幂等键去重照常生效）。
 */
async function handleSubmit(ctx: HttpCtx): Promise<void> {
  const { req, res, runner, state } = ctx;
  // 停机中不再接单（含直接 drain 了 runner 的情况）；GET /tasks/<id> 不受影响
  if (state.draining || runner.isDraining) {
    sendShuttingDown(req, res);
    return;
  }
  const body = await parseJsonBody(req, res, ctx.maxBodyBytes);
  if (body === PARSE_FAILED) return;
  const submitBody = toTaskSubmitBody(body);
  if (!submitBody) {
    sendJson(res, 400, { error: 'body 需为 { input, idempotencyKey?, options? }' });
    return;
  }
  // 入站链路（spec §9.2）：body 显式给的 `options.traceContext` 优先，否则取
  // `traceparent` 头。它随 `spec.options` 落进 TaskRecord —— 所以**跨进程续跑**
  // 的那次 run（另一个进程 `resumePending` 接着跑）也带得上，关联不断链。
  const submitTrace = parseTraceparent(headerValue(req, 'traceparent'));
  let rec: TaskRecord;
  try {
    rec = runner.submit(submitBody.input, {
      ...(submitBody.idempotencyKey !== undefined
        ? { idempotencyKey: submitBody.idempotencyKey }
        : {}),
      options:
        submitBody.options?.traceContext !== undefined
          ? submitBody.options
          : {
              ...submitBody.options,
              ...(submitTrace !== undefined ? { traceContext: submitTrace } : {}),
            },
      source: 'http',
    });
  } catch (e) {
    // `submit` 是同步的：入参校验失败与 store 落库故障从同一个 catch 出去。
    // 前者是调用方的错（400 + 原因），后者是服务端的错 —— 必须走与 500 路径同一套
    // `exposeErrors` 策略，否则一次磁盘/Redis 故障会被报成「你参数写错了」，
    // 并把内部错误消息原样回给调用方（500/401 路径都不这么干）。
    if (e instanceof TaskInputError) {
      sendJson(res, 400, { error: errMessage(e) });
      return;
    }
    // 排队段满（T5）：**不是**调用方的错，回 503 让它退避重试 —— 与 `maxConcurrentRuns`
    // 那一支同款（同一种情况在「已跑满」与「排满了」两个阶段各有一道闸，状态码就该一致）。
    // 放在 `TaskInputError` 之后：入参不合法仍是 400（那是它能自己修好的），
    // 排在 `isDraining` 之前：停机文案说「服务正在优雅停机」，而这条说的是「排队满了」——
    // 两句话对运维的指示不同（前者别再来，后者稍后再来），不能混成一句。
    if (e instanceof TaskQueueFullError) {
      res.setHeader('retry-after', RETRY_AFTER_SECONDS);
      sendJson(res, 503, { error: errMessage(e) });
      return;
    }
    // 上面的停机闸门与 `submit` 之间隔着一次 `await parseJsonBody`：读 body 期间
    // drain 可能刚开始，此时 submit 抛「正在优雅停机」。这是 503 而不是 500 ——
    // 调用方应该退避重试，跟闸门本身回的是同一句话。
    if (runner.isDraining) {
      sendShuttingDown(req, res);
      return;
    }
    sendInternalError(res, e, ctx.exposeErrors);
    return;
  }
  sendJson(res, 202, rec);
}

// ────────────────────────────────────────────────────────────────────────────
// 任务控制面（四条：approve / poll / cancel / events —— 停机中仍可用）
//
// 它们与 POST /run、POST /tasks 的关键差别是：**停机窗口里照常受理**。
// 理由是同一个 —— 挂起的任务只有人能推进（approve / events），而停机窗口正是
// 最想取消在飞任务的时候（cancel）；GET 轮询更是调用方拿回在飞任务结果的唯一途径。
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /tasks/<id>/approve（HITL）：审批挂起的任务。body
 * `{ decisions: { <tool_use_id>: { approved, reason? } }, decidedBy? }`。
 * 任务不存在 → 404；不在 suspended 状态 → 409；body 非法 → 400。
 */
async function handleApprove(taskId: string, ctx: HttpCtx): Promise<void> {
  const { req, res, runner } = ctx;
  const body = await parseJsonBody(req, res, ctx.maxBodyBytes);
  if (body === PARSE_FAILED) return;
  const parsed = parseApproveBody(body);
  if (!parsed) {
    sendJson(res, 400, {
      error:
        'body 需为 { decisions: { <tool_use_id>: { approved: boolean, reason?: string } }, decidedBy?: string }',
    });
    return;
  }
  try {
    const rec = await runner.approve(
      taskId,
      parsed.decisions,
      parsed.decidedBy !== undefined ? { decidedBy: parsed.decidedBy } : {},
    );
    sendJson(res, 200, rec);
  } catch (e) {
    // 404（任务不存在）/ 409（状态不对）是调用方语义；其余按内部错误处理
    if (e instanceof TaskApproveError) {
      sendJson(res, e.status, { error: errMessage(e) });
      return;
    }
    sendInternalError(res, e, ctx.exposeErrors);
  }
}

/** GET /tasks/<id>：轮询任务记录 → 200 `TaskRecord`；不存在 → 404。停机中照常可轮询 */
async function handlePoll(taskId: string, ctx: HttpCtx): Promise<void> {
  const rec = await ctx.runner.poll(taskId); // MaybePromise：异步 store 下必须 await
  if (!rec) {
    sendJson(ctx.res, 404, { error: `task 不存在: ${taskId}` });
    return;
  }
  sendJson(ctx.res, 200, rec);
}

/**
 * POST /tasks/<id>/cancel：取消一个任务（在跑的真中断 / 在睡的不再醒 / 在排队的绝不起跑）。
 * 无 body。不存在 → 404；已终态、或在跑的 run 不在本进程 → 409。
 */
async function handleCancel(taskId: string, ctx: HttpCtx): Promise<void> {
  try {
    const rec = await ctx.runner.cancel(taskId); // MaybePromise：异步 store 下必须 await
    sendJson(ctx.res, 200, rec);
  } catch (e) {
    // 404（不存在）/ 409（已终态、或在跑的 run 不在本进程）是调用方语义
    if (e instanceof TaskCancelError) {
      sendJson(ctx.res, e.status, { error: errMessage(e) });
      return;
    }
    sendInternalError(ctx.res, e, ctx.exposeErrors);
  }
}

/**
 * POST /tasks/<id>/events（run 事件投入口，2026-09-28 ref-run-event-input）：投一个事件给挂起的任务
 * —— 事件落 `pendingEvents`、状态回 running，先落库再派发，醒来进消息历史。
 * body `{ eventId?, type, payload }`（白名单，全是字符串，多一个字段 → 400）；
 * 不存在 → 404；不在 suspended 状态、或同 eventId 重复投递 → 409。
 */
async function handleTaskEvent(taskId: string, ctx: HttpCtx): Promise<void> {
  const { req, res, runner } = ctx;
  const body = await parseJsonBody(req, res, ctx.maxBodyBytes);
  if (body === PARSE_FAILED) return;
  const event = parseEventBody(body);
  if (!event) {
    sendJson(res, 400, {
      error:
        'body 需为 { eventId?: string, type: string, payload: string }（白名单：多一个字段即拒）',
    });
    return;
  }
  try {
    const rec = await runner.signalTask(taskId, event);
    sendJson(res, 200, rec);
  } catch (e) {
    // 404（不存在）/ 409（不在挂起态、同 eventId 重复投递）是调用方语义
    if (e instanceof TaskEventError) {
      sendJson(res, e.status, { error: errMessage(e) });
      return;
    }
    sendInternalError(res, e, ctx.exposeErrors);
  }
}

/**
 * GET /tasks/<id>/stream：订阅某任务的记账事件流（SSE）。帧名与语义见
 * `docs/usage-guide.md §7`：`trace.event`（带 SSE `id:` 供断线续订）、
 * `stream.truncated` / `stream.unavailable` / `stream.closed` / `task.end`。
 *
 * 与 `/run` 的 SSE 那条**气质不同**（背压时处置相反）：
 * 这条流的读者是**旁观者**，所以背压只收口本流（不 abort 任务）——
 * 任务不该因为看的人慢而变慢。
 */
async function handleTaskStream(taskId: string, ctx: HttpCtx): Promise<void> {
  const { req, res, runner, state, sseMaxBufferedBytes } = ctx;
  // 先查一次记录：任务不存在要回 **404**，而 SSE 一旦写出响应头状态码就定死 200 了
  //（见 sse.ts 的语义约束），所以「存不存在」必须在建流之前问。
  const known = await runner.poll(taskId);
  if (!known) {
    sendJson(res, 404, { error: `task 不存在: ${taskId}` });
    return;
  }
  // 续订锚点：SSE 标准头 `Last-Event-ID` 优先，其次 `?from=`（非 EventSource 的客户端用）
  const fromRaw =
    headerValue(req, 'last-event-id') ??
    new URL(req.url ?? '/', 'http://localhost').searchParams.get('from');
  const from = fromRaw === null || fromRaw === undefined ? undefined : Number(fromRaw);
  let unsubscribe: () => void = () => {};
  let finished = false;
  let heartbeat: NodeJS.Timeout | undefined;
  // 登记的收口句柄（下面三处 add / delete 都用**同一个对象**）：`closeStream` 自己也要把
  // 这条从 openSse 摘掉（客户端断连、任务终态、背压都走它）。句柄先声明、赋值在 add 处 ——
  // `closeStream` 只会在 `runner.streamTask`（本函数尾部）之后被调用，那时它一定已就位。
  let sseHandle: OpenSseHandle | undefined;
  const closeStream = (): void => {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    if (sseHandle !== undefined) state.openSse.delete(sseHandle);
    sse.close();
  };
  const sse = sseWriter(res, {
    maxBufferedBytes: sseMaxBufferedBytes,
    // ⚠️ 背压**不 abort 任务**：这条流的读者是**旁观者**，任务不该因为看的人慢而变慢。
    //（对比 /run 的 SSE：那里的下游就是 run 的所有者，背压等于「别继续烧 token 了」。）
    onBackpressure: () => closeStream(),
  });
  heartbeat = setInterval(() => sse.comment('ping'), 15_000);
  heartbeat.unref?.();
  // 登记收口函数：drain 时强制关闭（SSE 是长连，不关会把进程吊住）。
  // `cutsRun: false` —— 关掉本流只是旁观者退订，**不**中止任务、也不损失工作（见 `OpenSseHandle`）
  sseHandle = { close: closeStream, cutsRun: false };
  state.openSse.add(sseHandle);
  // 客户端断开 ⇒ 退订（不退订订阅者会一直挂在 runner 的表里）
  res.once('close', () => {
    if (!res.writableEnded) closeStream();
  });
  const write = (frame: TaskStreamFrame): void => {
    if (finished) return;
    switch (frame.type) {
      case 'trace':
        // 帧名一族 + SSE `id:` 给流序号 ⇒ 断线重连带 Last-Event-ID 就能续上
        sse.event('trace.event', frame.event, String(frame.index));
        return;
      case 'truncated':
        sse.event('stream.truncated', { droppedBefore: frame.droppedBefore });
        return;
      case 'unavailable':
        sse.event('stream.unavailable', { reason: frame.reason });
        return;
      case 'closed':
        // 流级收尾（任务未终态，见 TaskStreamFrame）：帧先发出去再关连接 ——
        // 客户端据此知道「没有更多帧了，去轮询」，而不是对着断线猜
        sse.event('stream.closed', { reason: frame.reason });
        closeStream();
        return;
      case 'end':
        sse.event('task.end', frame.record);
        closeStream();
        return;
      default: {
        // 编译期穷尽性断言：`TaskStreamFrame` 新增成员时这里会编译失败，
        // 而不是被静默丢掉 —— 静默丢帧的客户端只会对着流干等，最后靠超时猜。
        const _never: never = frame;
        void _never;
      }
    }
  };
  try {
    const off = await runner.streamTask(taskId, write, from !== undefined ? { from } : {});
    // 重放阶段就可能已收口（终态任务）：那时 finished 为真，别再登记退订
    if (finished) off();
    else unsubscribe = off;
  } catch (e) {
    if (e instanceof TaskStreamError) {
      // 理论上不可达（上面已查过存在性），但保留这条：状态码还没写出去就还能回 404
      if (!res.headersSent) {
        sendJson(res, e.status, { error: errMessage(e) });
      } else {
        sse.event('error', { message: errMessage(e) });
        closeStream();
      }
      return;
    }
    sse.event('error', { message: errMessage(e) });
    closeStream();
  }
}
