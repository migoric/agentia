import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { stringifySafe } from '../core/json.js';
import { validateJsonSchema } from '../core/schema.js';
import { TIMED_OUT, isTimeoutError, withTimeout } from '../core/timeout.js';
import type { AgentTool, ModelClient, ToolRunContext } from '../core/tool.js';
import type { SpanError, TraceContext, TraceSink } from '../core/trace.js';
import { flushTraceSinks } from '../core/trace-sink.js';
import { TOOL_INPUT_EVENT, TOOL_OUTPUT_EVENT, parseTraceparent } from '../core/trace.js';
import { DEFAULT_PROTOCOL_VERSION } from '../integrations/mcp.js';
import { createAnthropicClient } from '../integrations/anthropic.js';
import { classifyError } from './errors.js';
import { startHttpTransport } from './mcp-server-http.js';
import { startStdioTransport } from './mcp-server-stdio.js';
import { buildToolRunContext } from './tool-context.js';
import { toolInputPayload, toolOutputPayload } from './tool-events.js';
import { TraceRecorder, resolveTraceLimits } from './tracer.js';
import type { TraceLimits } from './tracer.js';

/**
 * Agentia —— **MCP 反向桥**（R8-P5）：把 app 的能力菜单暴露成 MCP server
 * （正向桥 `integrations/mcp.ts` 是把外部 MCP server 的工具接进来，本文件是反方向）。
 *
 * **本文件是「桥」**：协议面（`initialize` / `tools/list` / `tools/call` 的报文分派与
 * 入参校验）、执行面（一次能力调用的 trace 记账 + 超时 + 错误分类 + sink 投递）、
 * 以及装配（校验 → 状态 → 选传输）。两条**传输**各居其文件
 * （`mcp-server-stdio.ts` / `mcp-server-http.ts`，2026-09-28 纯结构拆分、零行为变化），
 * 与正向桥的排布（`mcp.ts` + `mcp-stdio.ts` / `mcp-http.ts`）同款。
 * ⚠️ 一处**刻意不同**：正向桥的 `mcp.ts ↔ mcp-stdio/mcp-http` 是一条**真实的值环**
 * （桥 re-export 连接器、连接器又反向 import 桥的共享 helper，靠 ESM 函数提升与调用时机
 * 侥幸无恙）；这里改成**注入式单向** —— 传输只从本文件取**类型**，值由 `createMcpServer`
 * 经 `McpCore` 传进去 ⇒ 无环是**构造性**的，不靠运气。
 *
 * **落点为什么在 engine**（2026-09-28 用真实 import 复核过，结论成立）：
 * 本文件需要 **engine 侧四个值** —— `TraceRecorder`（每次 tools/call 一棵 trace）、
 * `classifyError`、`buildToolRunContext`、`tool-events` 的记账载荷；同时需要
 * **integrations 侧两个值** —— `DEFAULT_PROTOCOL_VERSION`（正向桥那份协议版本常量）与
 * `createAnthropicClient`（`ToolRunContext.client` 的惰性缺省）。而
 * `integrations` 只许依赖 core，`transport` 够不到 integrations，engine 是分层图上**唯一**
 * 能同时够到两边的层。放进 integrations 需要一条 `integrations → engine`（4 个值），
 * 既越权又与既有的 `engine → integrations` 成环。
 * ⚠️ 顺带订正 AGENTS.md 的一句旧文案：`engine → integrations` 这条边**不止**
 * 「取默认 ModelClient」一个用途 —— 本文件用的 `DEFAULT_PROTOCOL_VERSION` 是第二个
 * （`loop.ts` 那处才是取 client）。它仍是一条边（不新增方向），故分层表的 ALLOWED 不动。
 *
 * **协议范围只到 tools**：`initialize` / `notifications/initialized` / `tools/list` /
 * `tools/call`（顺手支持 `ping`）；其余 method 一律 -32601，params 形状坏 → -32602。
 *
 * **trace 叙事不破**：每次 `tools/call` 造一个 `TraceRecorder`：根 span（kind `run`，
 * name `mcp.tools/call`）下挂一个 capability span（kind `capability`、name = 工具名 ——
 * metrics 的 `capabilityKindOf` 把它归为 `capability:<name>` 标签，自动进能力指标），
 * 并按 `tool-events.ts` 的口径记同名 `tool.input` / `tool.output` 事件（账目形状与引擎
 * 一致）；收尾 snapshot 投递 `opts.sinks`（抛错或超时只告警，观测不击穿业务）。
 * 入站链路（SEP-414）：`params._meta.traceparent` 合法时记成 run 根的一条 `links`
 * （与 HTTP 宿主的 `traceparent` 头同款缝合；缺失 / 畸形静默当作孤立根）。
 * `tools/list` / `initialize` 不建 trace。
 *
 * **不做（YAGNI，与正向桥同款清单）**：resources / prompts / sampling（server 反向请求模型）/
 * SSE 推送（server→client 流）/ 会话强制校验（HTTP 侧发 `mcp-session-id` 头但**不校验**：
 * 无状态 server，带了接受、不带也服务 —— 宽容选择，文档写明）。
 */

/** MCP server 的入口应用面（鸭子类型）：`AgentApp` 结构满足（`app.tools` 即装配后的菜单） */
export interface McpServerApp {
  tools: AgentTool[];
}

export interface McpServerOptions {
  /** 传输：`'stdio'`（CLI 场景，父进程 spawn）或 `'http'`（服务场景，StreamableHTTP） */
  transport: 'stdio' | 'http';
  /** http：监听地址，缺省 `'127.0.0.1'`（MCP server 不该默认暴露到公网） */
  host?: string;
  /** http：监听端口，缺省 `0`（系统分配，读返回值的 `url` 拿实际端口）。自带 `server` 时无效 */
  port?: number;
  /** http：endpoint 路径，缺省 `'/mcp'` */
  path?: string;
  /**
   * http：**挂进既有的 `http.Server`**（框架不替它 listen；`close()` 只摘除本 handler，
   * 不关 server）。此时非本 `path` 的请求本 handler 直接忽略（交给宿主自己的路由）。
   */
  server?: Server;
  /**
   * `ToolRunContext.client` 是必填字段（子 agent / skill 类工具要它拉子循环）。
   * 缺省**惰性**走 `createAnthropicClient()`（与引擎默认同款）—— 第一次 `tools/call`
   * 才构造，不在 `createMcpServer` 时构造（纯工具菜单的 server 不该要求 API key 在场）。
   */
  client?: ModelClient;
  /** trace 出口：每次 `tools/call` 收尾投递（抛错或超时只告警，观测不击穿业务） */
  sinks?: TraceSink[];
  /**
   * 每次 `tools/call` 那棵 trace 的事件数闸（语义与引擎 `traceLimits` **同款**：
   * 超限停记 + run 根两笔 `trace.truncated` 簿记；缺省 = 不限）。子 agent 类工具
   * 在桥内长跑时，没有这道闸 trace 体积就无界。坏值在**构造期**抛 TypeError
   * （与 run 入口的 `resolveTraceLimits` 同一个判定器）。
   */
  traceLimits?: TraceLimits;
  /**
   * 事件正文截断上限；语义与引擎 `maxEventChars` **同款**（`false` = 不截断，
   * 缺省 = 引擎缺省 `DEFAULT_EVENT_CHARS`）。透传给 tool.input / tool.output 的载荷装配。
   */
  maxEventChars?: number | false;
  /**
   * 单次 `tools/call` 的工具执行超时（毫秒），语义与引擎 `toolTimeoutMs` **同款**：
   * 非正数 / 不设 = 不限；超时 = **放弃等待**（abort `abandoned` 通知工具自行收尾，
   * 该次调用回 `isError`，server 不挂）。复用既有语义，故不进 `limits.ts` 真源表。
   */
  toolTimeoutMs?: number;
  /**
   * http 侧鉴权钩子（与 `transport/http.ts` 的 `authenticate` **同纪律**）：框架不实现
   * token / JWT 策略，只留钩子 —— 在**读 body 之前**调用，抛错即 401（原文只进服务端日志）。
   * stdio 侧信任父进程，本项不生效。
   */
  auth?: (req: IncomingMessage) => unknown | Promise<unknown>;
  /** `serverInfo.name`（`initialize` 握手回给客户端），缺省 `'agentia'` */
  name?: string;
}

/** `createMcpServer` 的返回值（也是两条传输各自的返回值） */
export interface McpServer {
  /** http 模式的实际 endpoint（如 `http://127.0.0.1:54321/mcp`）；stdio 模式恒为 `undefined` */
  readonly url: string | undefined;
  /** http：listen 完成的承诺（`url` 此时可用）；stdio：立即 resolve */
  readonly ready: Promise<void>;
  /**
   * 关闭（幂等）：中止全部在飞 `tools/call` 的 signal；stdio 侧停读 stdin；
   * http 侧关掉**自有** server（挂进来的既有 server 只摘除本 handler）。
   */
  close(): Promise<void>;
}

/**
 * 传输层看得见的**协议面**（`createMcpServer` 组装好后注入，两条传输共用同一份）。
 *
 * 为什么是这几个：传输的职责是「把字节搬进搬出」，凡是**协议语义**（这条报文该怎么应答、
 * 什么形状才算合法报文、在飞调用怎么记账）都不该由它决定 —— 但它需要在正确的时刻调用它们。
 */
export interface McpCore {
  /**
   * 报文分派（两条传输共用）。返回 `null` = 通知，不应答。
   * 协议范围只到 tools（见文件头）；其余 method 一律 -32601，params 形状坏 → -32602。
   */
  dispatch(msg: unknown, signal: AbortSignal): Promise<Record<string, unknown> | null>;
  /**
   * 造一条 JSON-RPC 错误应答 —— 传输层**自己发现坏报文**时用它
   * （目前只有 stdio：一行不是合法 JSON ⇒ -32700）。让传输层调它而不是自己拼
   * `{ error: { code } }`：错误码是协议面的知识，api 面漂移时只该改一处。
   */
  rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown>;
  /** 为一次请求登记中止句柄（close() / 传输侧断连时中止它），返回其 signal */
  trackCall(ac: AbortController): AbortSignal;
  untrackCall(ac: AbortController): void;
  /** 中止全部在飞调用（close() 用） */
  abortAll(): void;
}

/** serverInfo.version 刻意不写真版本字面量（与 DEFAULT_CLIENT_INFO 同纪律，release-surface 按精确版本串计数） */
const SERVER_INFO_VERSION = '0.0.0';

type JsonRpcId = number | string | null;

/** 造一条 JSON-RPC 错误应答 */
function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 造一条 JSON-RPC 成功应答 */
function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** 执行面的共享依赖（`createMcpServer` 一次性装好，两个传输共用同一份） */
interface CallDeps {
  /** trace 出口：每次调用收尾投递（抛错被吞，观测不击穿业务） */
  readonly sinks: readonly TraceSink[];
  /** 单次执行的超时（见 `McpServerOptions.toolTimeoutMs`）；undefined = 不限 */
  readonly toolTimeoutMs: number | undefined;
  /** 每次调用那棵 trace 的事件数闸（见 `McpServerOptions.traceLimits`）；undefined = 不限 */
  readonly traceLimits: TraceLimits | undefined;
  /** 事件正文截断上限（见 `McpServerOptions.maxEventChars`）；undefined = 引擎缺省 */
  readonly maxEventChars: number | false | undefined;
  /** client 惰性构造（见 `McpServerOptions.client`）：第一次 `tools/call` 才建 */
  readonly clientOf: () => ModelClient;
}

/** 报文分派的依赖 = 执行依赖 + 协议面自己要知道的两件 */
interface DispatchDeps extends CallDeps {
  readonly tools: readonly AgentTool[];
  readonly serverInfo: { readonly name: string; readonly version: string };
}

/**
 * 入站链路（SEP-414）：从 `tools/call` 的 params 里取 `_meta.traceparent` 并解析。
 *
 * 纪律（与 HTTP 宿主的 `traceparent` 头同款，见 transport/http-endpoints.ts）：
 * `_meta` 缺失 / 非对象、`traceparent` 非字符串或畸形，一律**静默当作「没有上游上下文」**
 * —— 链路到不到是观测行为，不该因为一个坏 `_meta` 把一次工具调用打成协议错误；
 * 也**不造空 TraceContext**（空上下文会把 span 变成孤儿 —— MCP Python SDK 的
 * `extract_trace_context` docstring 给的就是这个理由）。
 */
function metaTraceContext(params: object): TraceContext | undefined {
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
  const tp = (meta as { traceparent?: unknown }).traceparent;
  return typeof tp === 'string' ? parseTraceparent(tp) : undefined;
}

/**
 * 执行一次 `tools/call`：造一棵 trace（run 根 + capability span + tool.input/tool.output
 * 事件），收尾投递 sinks，然后把结果映射成 MCP 形状。
 *
 * 独立成顶层函数（而不是 `createMcpServer` 闭包里的一支）：它是本文件里最大的一块，
 * 且**只依赖 `deps` 三件**，不碰装配期的任何状态 —— 拆前它藏在 441 行的闭包里无名可分。
 */
async function callTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
  deps: CallDeps,
  /** 入站链路（SEP-414）：调用方经 `params._meta.traceparent` 带来的上游 span；undefined = 孤立根 */
  link: TraceContext | undefined,
): Promise<Record<string, unknown>> {
  const { sinks, toolTimeoutMs, maxEventChars } = deps;
  const recorder = new TraceRecorder({
    ...(deps.traceLimits?.maxEvents !== undefined ? { maxEvents: deps.traceLimits.maxEvents } : {}),
  });
  const rootId = recorder.begin('run', 'mcp.tools/call', null);
  // 与引擎 run 入口（loop.ts 的 traceContext）同形状：上游被**链接**而不是被继承成
  // 父 span —— 这棵 trace 永远自洽（`traceId == runId` 不变），因果关系仍然可查
  if (link) {
    recorder.addLink(rootId, {
      traceId: link.traceId,
      ...(link.spanId ? { spanId: link.spanId } : {}),
    });
  }
  const capId = recorder.begin('capability', tool.name, rootId);
  // tool_use_id 与引擎同义（同名工具并行时靠 id 配对入参/出参事件）
  const use = { type: 'tool_use' as const, id: randomUUID(), name: tool.name, input: args };
  const startedAt = Date.now();
  recorder.event(capId, TOOL_INPUT_EVENT, toolInputPayload(use, maxEventChars));
  // 超时「放弃等待」的通知信号（与引擎 executeOneTool 同款：判超时分支里 abort）
  const abandonAc = new AbortController();
  const toolCtx: ToolRunContext = buildToolRunContext({
    client: deps.clientOf(),
    recorder,
    parentSpanId: capId,
    abandoned: abandonAc.signal,
    signal,
    toolTimeoutMs,
  });

  let ok = true;
  let content: unknown = '';
  let errorKind: 'timeout' | 'threw' | undefined;
  let spanError: SpanError | undefined;
  try {
    // 与引擎同一判定原语（core/timeout.ts，实测耗时兜底）：超时 = 放弃等待，不杀 server
    const out = await withTimeout(Promise.resolve(tool.run(args, toolCtx)), toolTimeoutMs ?? 0);
    if (out === TIMED_OUT) {
      abandonAc.abort(); // 通知工具「没人等结果了」（@SubAgent/@Skill 靠它自中止）
      ok = false;
      errorKind = 'timeout';
      content = `error(timeout): 工具执行超过 ${toolTimeoutMs}ms`;
      spanError = { type: 'timeout', message: String(content), retryable: true };
    } else {
      content = out;
    }
  } catch (e) {
    ok = false;
    if (isTimeoutError(e)) {
      // 工具自判的超时与引擎判的归同一类账（与 turn.ts 同口径）
      errorKind = 'timeout';
      content = `error(timeout): ${e instanceof Error ? e.message : String(e)}`;
      spanError = { type: 'timeout', message: String(content), retryable: true };
    } else {
      errorKind = 'threw';
      const err = classifyError(e);
      content = `error(${err.type}): ${err.message}`;
      spanError = err;
    }
  }
  recorder.event(
    capId,
    TOOL_OUTPUT_EVENT,
    toolOutputPayload({ use, ok, errorKind, startedAt, now: Date.now(), content, maxEventChars }),
  );
  recorder.end(
    capId,
    ok
      ? {}
      : {
          status: 'error',
          // exactOptionalPropertyTypes：显式 undefined 不是合法的 `error?: SpanError`
          ...(spanError !== undefined ? { error: spanError } : {}),
        },
  );
  recorder.end(
    rootId,
    ok
      ? {}
      : {
          status: 'error',
          ...(spanError !== undefined ? { error: spanError } : {}),
        },
  );
  const trace = recorder.snapshot(ok ? 'ok' : 'error');
  // 抛错或永久挂起都不击穿业务；与 runtime 共用同一份投递与超时口径
  await flushTraceSinks(sinks, trace);

  // 结果映射：抛错 → 协议层成功 + isError（MCP 惯例；正向桥那头正好把 isError 转回抛错，
  // 方向对称）；string 原样进 text；其他 JSON 化进 text
  if (!ok) return { content: [{ type: 'text', text: String(content) }], isError: true };
  const text = typeof content === 'string' ? content : stringifySafe(content);
  return { content: [{ type: 'text', text }] };
}

/**
 * 报文分派（两个传输共用）。返回 `null` = 通知，不应答。
 * 协议范围只到 tools（见文件头）；其余 method 一律 -32601，params 形状坏 → -32602。
 */
async function dispatch(
  msg: unknown,
  signal: AbortSignal,
  deps: DispatchDeps,
): Promise<Record<string, unknown> | null> {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return rpcError(null, -32600, '报文不是 JSON-RPC 对象');
  }
  const m = msg as { id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId =
    typeof m.id === 'number' || typeof m.id === 'string' || m.id === null ? m.id : null;
  if (typeof m.method !== 'string') {
    return m.id === undefined ? null : rpcError(id, -32600, '报文缺 method 字段');
  }
  const method = m.method;
  // 通知（含 notifications/initialized）一律不应答；无 id 的非通知报文不是请求
  if (method.startsWith('notifications/') || m.id === undefined) return null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: deps.serverInfo,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      // 不建 trace（见文件头）：菜单查询不是一次「能力调用」
      return rpcResult(id, {
        tools: deps.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      const params = m.params;
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return rpcError(id, -32602, 'tools/call 的 params 必须是对象（{ name, arguments? }）');
      }
      const name = (params as { name?: unknown }).name;
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'tools/call 的 params.name 必须是非空字符串');
      }
      const rawArgs = (params as { arguments?: unknown }).arguments;
      if (
        rawArgs !== undefined &&
        (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))
      ) {
        return rpcError(id, -32602, 'tools/call 的 params.arguments 必须是对象');
      }
      const tool = deps.tools.find((t) => t.name === name);
      if (!tool) {
        return rpcError(id, -32602, `未知工具: ${name}`);
      }
      // 入参契约与引擎**同一份校验器**（core/schema.ts，与 turn.ts 进方法体之前那次同源）：
      // 反向桥若跳过它，同一份 @Tool 就会有两条契约 —— 引擎那边缺必填项记 errorKind
      // 'invalid_input' 且不进方法体，这边却把畸形入参一路带进副作用。MCP 规范把
      // 「未知工具 / 入参不合法」都归为协议错误（Invalid params），故回 -32602 而非
      // result.isError（后者留给「工具真执行了但失败了」）。
      const badInput = validateJsonSchema(tool.inputSchema, rawArgs ?? {});
      if (badInput !== null) {
        return rpcError(id, -32602, `工具 ${name} 的入参不满足 inputSchema：${badInput}`);
      }
      return rpcResult(
        id,
        await callTool(
          tool,
          (rawArgs ?? {}) as Record<string, unknown>,
          signal,
          deps,
          metaTraceContext(params),
        ),
      );
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * 把 app 的能力菜单暴露成 MCP server。两个传输都只用标准库：
 * - **stdio**：stdin/stdout 换行分隔 JSON-RPC（每行一个完整报文）；日志只去 stderr；
 * - **StreamableHTTP**：POST 收 JSON-RPC，应答 `application/json`（简单应答不上 SSE）；
 *   `initialize` 响应发 `mcp-session-id` 头（生成的 uuid），后续请求带了就接受、不带也服务
 *   （无状态 server，**宽容是有意的**）；GET（server→client 流）→ 405；DELETE → 200；
 *   客户端断连会中止该次工具调用的 `signal`。
 *
 * 本函数只做**装配**：构造期校验 → 状态（惰性 client / 在飞句柄表）→ 组装 `McpCore`
 * → 交给选中的传输。协议与执行见 `dispatch` / `callTool`，传输见各自的文件。
 */
export function createMcpServer(app: McpServerApp, opts: McpServerOptions): McpServer {
  if (typeof app !== 'object' || app === null || !Array.isArray(app.tools)) {
    throw new TypeError(
      'createMcpServer：app 必须是鸭子类型 { tools: AgentTool[] }（如 AgentApp）',
    );
  }
  if (opts.transport !== 'stdio' && opts.transport !== 'http') {
    throw new TypeError(
      `createMcpServer：transport 只认 'stdio' | 'http'，收到 ${String(opts.transport)}`,
    );
  }

  /** client 惰性构造（见 McpServerOptions.client）：第一次 tools/call 才建 */
  let cachedClient: ModelClient | undefined;
  const deps: DispatchDeps = {
    tools: app.tools,
    serverInfo: { name: opts.name ?? 'agentia', version: SERVER_INFO_VERSION },
    sinks: opts.sinks ?? [],
    toolTimeoutMs: opts.toolTimeoutMs,
    // 构造期校验（坏值响亮抛 TypeError，与 run 入口同一个判定器）
    traceLimits: resolveTraceLimits(opts.traceLimits, 'createMcpServer'),
    maxEventChars: opts.maxEventChars,
    clientOf: () => {
      cachedClient ??= opts.client ?? createAnthropicClient();
      return cachedClient;
    },
  };

  /** 在飞 tools/call 的中止句柄 —— close() 中止它们（服务器关闭 = 调用方没了） */
  const inFlight = new Set<AbortController>();
  const core: McpCore = {
    dispatch: (msg, signal) => dispatch(msg, signal, deps),
    rpcError,
    trackCall: (ac) => {
      inFlight.add(ac);
      return ac.signal;
    },
    untrackCall: (ac) => {
      inFlight.delete(ac);
    },
    abortAll: () => {
      for (const ac of inFlight) ac.abort();
      inFlight.clear();
    },
  };

  return opts.transport === 'stdio' ? startStdioTransport(core) : startHttpTransport(core, opts);
}
