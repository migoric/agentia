import { TIMED_OUT, TimeoutError, withTimeout } from '../core/timeout.js';

/**
 * Agentia —— MCP **协议面**：桥（`mcp.ts`）与两个内置连接器（`mcp-stdio.ts` /
 * `mcp-http.ts`）**共用**的结构类型与 helper。
 *
 * **这个文件为什么存在**（2026-09-28，第 4 件「文件级无环守卫」咬出来的）：在此之前这些
 * 声明住在 `mcp.ts` 里，而 `mcp.ts` 又 re-export 两个连接器（`export { … }` 自
 * `mcp-stdio.ts` / `mcp-http.ts`）—— 于是「桥 → 连接器」（值 re-export）与「连接器 → 桥」
 * （取下面这些 helper 的值）构成一条**真实的值环**（运行期环，靠 ESM 函数提升与调用时机
 * 侥幸无恙）。把它们落到本文件后，依赖成一条**单向**的 DAG：
 *
 *     mcp.ts ──► mcp-protocol.ts ◄── mcp-stdio.ts / mcp-http.ts
 *        └──────────────► mcp-stdio.ts / mcp-http.ts（仅 re-export 连接器）
 *
 * 本文件**只依赖 core**（`core/timeout.js`），不反过来引桥或连接器 —— 那条无环是**构造性**的。
 * 新增「桥与连接器都要用」的东西请加在这里，别再加回 `mcp.ts`（会把环加回来）。
 *
 * ⚠️ 本注释**刻意不写出带引号的相对导入字面量**（如 `from '…/x.js'`）：`tests/architecture`
 * 里的依赖图解析器按正则抓 `from '…'`、不剥注释，写出来会**凭空造一条边**（踩过）。
 *
 * 公共面不变：这些符号仍由 `mcp.ts` re-export（`src/index.ts` 取用点未改）。
 */

/** MCP server 的 `tools/list` 条目（结构面子集：多出来的字段一律忽略） */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** MCP 协议里已是 JSON Schema → 直接当框架的 `inputSchema` 用 */
  inputSchema?: unknown;
}

/**
 * `callTool` 的第三参（桥与两个连接器**共用**这一份 —— 2026-10-12 SEP-414 起多了
 * `traceparent`，形状只许有一处定义）。
 */
export interface McpCallOptions {
  /**
   * 裁判（引擎 `toolTimeoutMs` / 桥兜底超时）**放弃等待**的通知信号。
   * 放弃 ≠ 取消 —— 但连接器应借此清掉这次调用的簿记（stdio 的 pending 条目、
   * HTTP 的在飞 fetch），否则「server 活着但不回包」时每超时一次就泄漏一条。
   */
  abandoned?: AbortSignal;
  /**
   * 出站传播（SEP-414，Final）：本次调用的 W3C `traceparent`，连接器把它放进
   * `params._meta.traceparent`（**裸键，不加前缀**；与 `name` / `arguments` 平级，
   * **绝不进 `arguments`** —— 那是模型可见的工具签名，trace 上下文进去就污染 schema）。
   * 缺席时 params **不落 `_meta` 键**：「没有上下文可传」与「传一个空上下文」不是一回事。
   * 不认识该字段的旧客户端忽略即可（可选参数，鸭子类型）。
   */
  traceparent?: string;
}

/**
 * MCP client 的最小结构面：任何实现了 `tools/list` + `tools/call` 的客户端都能接，
 * 无需继承、无需 import 任何 SDK（duck-typed，与 `RedisLike` 同款）。
 *
 * 约定：`callTool` 失败请**抛错**（框架会包成 `is_error` 的 tool_result 回给模型，
 * 不中断 run —— 与本地工具抛错同语义）。MCP 协议层的 `isError: true` 请由连接器
 * 转成抛错，否则模型看不到失败。
 */
export interface McpClientLike {
  listTools(): Promise<McpToolInfo[]>;
  /** 选项见 {@link McpCallOptions}；只实现两个参数的旧客户端依然兼容（可选参数，鸭子类型）。 */
  callTool(name: string, args: Record<string, unknown>, opts?: McpCallOptions): Promise<unknown>;
}

/**
 * 连接器公共面：`McpClientLike` + 一个关闭句柄（两个内置连接器都返回它）。
 *
 * 缝的形状没有变化 —— 需要自己的传输（官方 SDK / 远程 server / 复用长连接）时，
 * 实现 `McpClientLike` 两个方法即可，不必碰这里。
 */
export interface McpConnector extends McpClientLike {
  /**
   * 释放底层资源，**幂等**；stdio 侧**保证返回时子进程已终止**：
   * 先 SIGTERM，宽限期（`MCP_CLOSE_GRACE_MS`，见 `mcp-stdio.ts`）后 SIGKILL，然后**等真正的
   * `'exit'`**（2026-09-18 收紧：此前到点即返回、不等 reap，会留下孤儿进程而调用方无从知晓）。
   * HTTP 侧 = 尽力 `DELETE` 终止会话（server 不认也无所谓，失败不抛）。
   *
   * 关闭后再调用 `listTools` / `callTool` 会抛出可读错误（不静默挂死）。
   */
  close(): Promise<void>;
}

/**
 * 装配期超时的落点：**握手 + `tools/list`**。
 *
 * 为什么不给 `callTool` 也套一个：一次调用只有一个裁判（见 `McpToolsOptions.timeoutMs`）。
 * 走 `mcpTools` 时 `callTool` 由引擎 / 桥判定；而握手与 `tools/list` 发生在**装配期**，
 * 没有任何别的裁判 —— server 卡住会让 `createApp` 永久挂起，必须在这里兜住。
 */
export type Guard = <T>(p: Promise<T>, label: string) => Promise<T>;

/** 缺省超时：MCP server 可能去连外部系统，60s 是「明显卡死」与「慢但正常」的分界 */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 缺省 `clientInfo`（`initialize` 握手要发，协议要求该字段存在）。
 *
 * **刻意不写框架自身版本**：`integrations` 层不 import 公共面（`AGENTIA_VERSION` 在
 * `src/index.ts`），且 `scripts/release-surface.mjs` 的发版面按**精确版本串**计数 ——
 * 这里多一处版本字面量会让它的 count 断言失配。需要真实版本请自行传 `clientInfo`。
 */
export const DEFAULT_CLIENT_INFO: { name: string; version: string } = {
  name: 'agentia',
  version: '0.0.0',
};

/** `initialize` 缺省请求的协议版本（e2e 已验证的版本；要对齐新版 server 请显式传） */
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/**
 * 给一次 MCP 调用套超时。⚠️ 与引擎的工具超时同样是**放弃等待**而非取消 ——
 * MCP 的 `notifications/cancelled` 属于连接器职责，桥这一层拿不到取消句柄。
 *
 * 实现是 `core/timeout.ts` 共享原语的**薄封装**（2026-09-17 单源化，见 spec §10 2026-09-17 ①）：
 * 「一次调用只有一个预算判定」在引擎与桥之间只允许有一份实现。此前桥自带一份**纯竞速**
 * 版本，于是 2026-09-14 的「超时是硬的」收紧只落进引擎，桥继续把**超预算**的调用记成成功。
 *
 * 转导导出（module 级，**不进公共面**）只为可测：`tests/fixtures/timeoutLivenessProbe.ts`
 * 拿它验「截止计时器不得 unref」—— 那是「被 await 的超时到底会不会触发」的唯一分界点。
 */
export async function withDeadline<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const out = await withTimeout(p, timeoutMs);
  if (out === TIMED_OUT) {
    // 类型化超时（code='timeout'）⇒ 引擎记 errorKind='timeout'，与它自己判的超时同一类账。
    throw new TimeoutError(`MCP 工具 "${label}" 调用超时（超过 ${timeoutMs}ms）`);
  }
  return out;
}

/** 把可能很大的值截成可读片段（错误消息要能进日志，不能是一兆的 JSON） */
export function brief(value: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (typeof s !== 'string') s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** JSON-RPC 错误对象 → `Error`（`code` 进文案：`classifyError` 只认数值 `status`，这里不冒充它） */
export function jsonRpcError(err: unknown): Error {
  if (typeof err === 'object' && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    return new Error(`MCP error ${String(code)}: ${String(message)}`);
  }
  return new Error(`MCP error: ${brief(err)}`);
}

/** server 混进 stdout / SSE 的非 JSON 行 */
export function isJsonRpcResponse(msg: unknown): msg is {
  id: number;
  result?: unknown;
  error?: unknown;
} {
  return (
    typeof msg === 'object' && msg !== null && typeof (msg as { id?: unknown }).id === 'number'
  );
}

/** 从一条已解析的报文里取结果；带 `error` 则抛 */
export function unwrap(msg: { result?: unknown; error?: unknown }, method: string): unknown {
  if (msg.error !== undefined) throw jsonRpcError(msg.error);
  if (!('result' in msg)) throw new Error(`MCP ${method}：响应里既没有 result 也没有 error`);
  return msg.result;
}

// ───────────────────────── 下面这一组：两个内置连接器**共用**的纯件（2026-10-11 抽） ─────────────────────────
//
// 为什么抽在这里：它们此前**逐字重复**在两个连接器里（`tools/list` 与 `tools/call` 的结果校验
// 一字不差地写了两遍），或者只属于协议面的知识（SSE 帧 / JSON-RPC 信封 / id 配对）——
// 正是本文件头注那句「新增『桥与连接器都要用』的东西请加在这里」。
//
// ⚠️ 抽出去的另一半效果是**读数**：`integrations/mcp-http.ts` 与 `mcp-stdio.ts` 的
// 「最大可调用体」因此从 265 / 252 降下来（见 `tests/architecture/method-size.test.ts`）。
// 那不是目的、是副作用 —— 目的是这两条连接器从此只有「各自传输那一份」的代码。

/**
 * 读响应体文本；读失败**返回空串而非抛**。
 *
 * 为什么吞：调用方用它的地方（排空、错误文案、SSE 解析）都不该因为「body 读不出来」二次失败
 * —— 真正的原因由 `res.status` / 网络层给出，这里再抛只会把第一条错误盖掉。
 */
export async function readMcpText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** HTTP 层失败：带上数值 `status`，让 `classifyError` 能按状态分流 */
export function mcpHttpError(status: number, method: string, body: string): Error {
  const e = new Error(`MCP ${method} HTTP ${status}${body ? `：${body}` : ''}`);
  (e as { status?: number }).status = status;
  return e;
}

/**
 * 非 SSE 报文（单条 JSON-RPC）→ 取 result。
 *
 * ⚠️ id 必须**等值**配对（与 SSE 分支同款）：只验「是带 id 的响应」会把别的请求的结果
 * 当本次的返回（代理串包 / 通知帧），**静默错值比报错难查得多**。
 */
export function pickJsonRpcResult(msg: unknown, id: number, method: string): unknown {
  if (!isJsonRpcResponse(msg) || msg.id !== id) {
    throw new Error(`MCP ${method}：响应里没有 id 为 ${id} 的 JSON-RPC 报文`);
  }
  return unwrap(msg, method);
}

/**
 * 从 HTTP 响应取结果 —— 两种响应形态**都要接**（StreamableHTTP 的规范面）。
 *
 * SSE 分支一次性读完整个 body 再解析：StreamableHTTP 约定 server 发完响应即关流，
 * 读全比手写增量解析器稳（`text/event-stream` 里 `data:` 行按规范可跨多行拼接）。
 * SSE 里可能有别的通知帧或别的请求的应答，**只取与 `id` 配对的**那一条。
 */
export async function readMcpResult(res: Response, id: number, method: string): Promise<unknown> {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const text = await readMcpText(res);
  if (ct.includes('text/event-stream')) {
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data === '') continue;
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        continue;
      }
      if (isJsonRpcResponse(msg) && msg.id === id) return unwrap(msg, method);
    }
    throw new Error(`MCP ${method}：SSE 响应里没有 id 为 ${id} 的报文`);
  }
  if (text.trim() === '') {
    throw new Error(`MCP ${method}：响应体为空（期望 id 为 ${id} 的 JSON-RPC 报文）`);
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new Error(`MCP ${method}：响应不是合法 JSON：${brief(text)}`);
  }
  return pickJsonRpcResult(msg, id, method);
}

/**
 * `tools/list` 的应答 → 工具表。**两条连接器共用一份**（此前逐字写了两遍）。
 *
 * 形状不对一律**响亮失败**：把协议不符吞成空菜单，用户看到的是「这个 server 一个工具都没有」
 * 而不是「server 坏了」—— 前者会被当成正常结果排错到别处去。只有 `tools` **缺席**才当空表
 * （那是合法的「没有工具」）。
 */
export function parseToolList(r: unknown): McpToolInfo[] {
  if (typeof r !== 'object' || r === null) {
    throw new Error(`MCP tools/list 返回了非对象：${brief(r)}`);
  }
  const listed = (r as { tools?: unknown }).tools;
  if (listed === undefined) return [];
  if (!Array.isArray(listed)) {
    throw new Error(`MCP tools/list 的 tools 不是数组：${brief(listed)}`);
  }
  return listed as McpToolInfo[];
}

/**
 * `tools/call` 的结果里协议层 `isError: true` ⇒ **必须转成抛错**。
 *
 * 承重：这个位只有连接器看得见，吞了它模型会收到一条「成功」的结果、trace 也记成成功调用
 * （见 `McpClientLike` 的约定）。两条连接器共用一份。
 */
export function assertToolResultNotError(r: unknown, name: string): void {
  if (typeof r === 'object' && r !== null && (r as { isError?: unknown }).isError) {
    throw new Error(
      `MCP 工具 ${name} 返回 isError: ${brief((r as { content?: unknown }).content)}`,
    );
  }
}

/**
 * **会话过期自愈**的判定（MCP Streamable HTTP 的规范语义）。
 *
 * 带会话 id 收到 `404` 的含义是「这个会话我不认识」⇒ **该请求没有被执行** ⇒ 丢会话、
 * 重新握手、把这一次**重试一次**是安全的（不会重复执行副作用）；规范也要求客户端此时
 * **必须**新建会话。`allowReinit` 那一位保证**只重试一次**：第二次再 404 说明对面不是
 * 「会话过期」而是别的问题，直接抛（不循环）。
 *
 * 抽成纯函数是为了让这三条判据**可以被单独钉住** —— 它此前内联在 `rpc` 的 `if` 里，
 * 三个条件任意一个写反都没有用例看得见（症状是「重试带着旧会话再 404」或「无限重握」）。
 */
export function canSelfHealSession(
  status: number,
  hasSessionId: boolean,
  allowReinit: boolean,
): boolean {
  return status === 404 && hasSessionId && allowReinit;
}

/**
 * 拼 `tools/call` 的 params（**两条连接器共用一份** —— 承载 SEP-414 的 `_meta` 形状
 * 只许存在一处，否则改一处漏一处没有任何用例看得见）。
 *
 * `traceparent`（W3C 串）落在 params 的**兄弟键 `_meta`**：SEP-414 明说这是 `_meta`
 * DNS 前缀惯例的**例外**（裸键 `traceparent`，不许加成 `io.modelcontextprotocol.traceparent`
 * —— 加了前缀跨实现的链就断了）。⚠️ **绝不进 `arguments`**：那是模型可见、server 按
 * inputSchema 校验的工具签名，trace 上下文进去会污染契约（纪律②）。
 * `traceparent` 缺席时**不落 `_meta` 键**（纪律③：不造空上下文 —— 空 `_meta` 对宽容的
 * server 无害，但它让「这次到底有没有链路」变得不可判）。
 */
export function toolsCallParams(
  name: string,
  args: Record<string, unknown>,
  traceparent: string | undefined,
): Record<string, unknown> {
  return {
    name,
    arguments: args,
    ...(traceparent !== undefined ? { _meta: { traceparent } } : {}),
  };
}
