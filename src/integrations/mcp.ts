import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import type { AgentTool, JsonSchema, ToolRunContext } from '../core/tool.js';
import { formatTraceparent } from '../core/trace.js';
import { MCP_DEFAULT_TIMEOUT_MS, withDeadline } from './mcp-protocol.js';
import type { McpCallOptions, McpClientLike } from './mcp-protocol.js';

/**
 * Agentia —— MCP 桥（D1）+ 两个内置连接器（spec §10 决策记录）。
 *
 * **桥**：框架只定义**结构面** —— 不 import `@modelcontextprotocol/sdk`，任何实现了
 * `McpClientLike` 的客户端都能接（同 `RedisLike` 的 duck-typing）。本文件只依赖 core，
 * 符合分层约定（`integrations` → `core`）。
 *
 * **连接器**（2026-09-18 起**内置**，见文末「连接器」一节与 spec §10 同日条）：
 * `createStdioMcpConnector` / `createStreamableHttpMcpConnector`。二者只用标准库
 * （`node:child_process` + 全局 `fetch`），**不新增任何第三方依赖**。
 * 2026-09-20 起两个连接器各居其文件（`mcp-stdio.ts` / `mcp-http.ts`，纯结构拆分、
 * 零行为变化），本文件保留桥并 re-export —— 公共面不变。
 * 2026-09-28 起桥与连接器**共用**的结构类型与 helper 抽到 `mcp-protocol.ts`（为了断开
 * `mcp.ts ↔ mcp-stdio.ts` 那条**值环**，见该文件头注），本文件从那里 import 并继续 re-export。
 *
 * 用法（接入点是 `AppOptions.tools` 这条**裸工具缝**）：
 * ```ts
 * const mcp = createStdioMcpConnector(['uvx', 'mcp-server-time']);
 * createApp({ system: '…', tools: await mcpTools(mcp, { server: 'time' }) });
 * ```
 * ⚠️ **不是** `providers: [{ provide: 'mcp', useFactory: … }]` —— 那条路落地时不成立
 * （菜单只从装饰器注册表收集，`useFactory` 的返回值根本不进菜单；见 spec §10 2026-09-11）。
 * 复用既有装配 / 查重 / 中间件，**零新机制**（MCP 工具与本地 @Tool 同处一个命名空间，
 * 重名由 AgentApp 的装配期查重拦下）。
 *
 * 不做（YAGNI，见 spec §10）：`sampling`（server 反向请求模型）、`resources` / `prompts`
 * 原语（只做 tools）、连接池。
 */

export interface McpToolsOptions {
  /**
   * 工具名前缀，避免与本地能力撞名。缺省 `mcp_<server>_`；没给 `server` 时缺省 `mcp_`。
   * 传 `''` 表示不加前缀（此时 MCP 原名直接进菜单，撞名风险自负）。
   */
  prefix?: string;
  /** server 标识，只用于拼缺省前缀（不会发给 server） */
  server?: string;
  /**
   * **兜底**单次 `callTool` 超时（毫秒），缺省 60000；非正数 = 不限。
   *
   * ⚠️ 语义（见 spec §10 2026-09-17 ①）：**引擎设了 `toolTimeoutMs` 时本项不参与判定** ——
   * 一次调用只有一个裁判，否则同一件事会有两个计时器、两种账。它只在两种情况生效：
   * ① 桥脱离引擎单用（直接 `tool.run(...)`，没有 ctx）；② 引擎没设 `toolTimeoutMs`。
   *
   * 超时**不杀 run**：该条 tool_result 记 `is_error`、`errorKind='timeout'` 回模型。
   * 与 engine 的 `toolTimeoutMs` **同判定、同账目**（共用 `core/timeout.ts` 的实测耗时兜底）。
   */
  timeoutMs?: number;
}

/**
 * 工具名归一化：MCP 名可含 `-` / `.` / `/` / 空格等（对 LLM API 不友好或非法）
 * → 一律转 `_`，并把连续分隔符收成一个（`foo..bar` → `foo_bar`）。
 * 归一化后仍非法（空名 / 超长）直接抛错，**不静默改名** —— 静默截断会得到一个
 * 调用不回去的名字，比启动期报错难查得多。
 */
function normalizeToolName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned;
}

/**
 * 把一个 MCP server 的工具映射成框架的 `AgentTool[]`（可直接进 `tools` / providers）。
 *
 * - **名字**：`prefix + 归一化原名`；归一化后同名的两条直接抛错（否则装配期查重只会报
 *   「菜单能力重名」，看不出根因是 MCP 名撞了）；
 * - **原名**：每次调用时写进发起 turn 的 `mcp.tool` attribute（审计 / 回放要还原出
 *   回调 server 用的原名）；
 * - **入参 schema**：MCP 的 `inputSchema` 已是 JSON Schema → 原样透传，由 engine 的
 *   子集校验器在 `callTool` 之前先校验（非法入参根本不会发出，模型自己会改）；
 * - **返回结构**：MCP 的结果对象（`content` 数组等）原样交给 engine 序列化，
 *   不做「把 content 拼成字符串」这类有损加工 —— 需要塑形请自行包一层工具。
 */
export async function mcpTools(
  client: McpClientLike,
  opts: McpToolsOptions = {},
): Promise<AgentTool[]> {
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const prefix =
    opts.prefix ?? (opts.server === undefined ? 'mcp_' : `mcp_${normalizeToolName(opts.server)}_`);

  const listed = await client.listTools();
  const seen = new Map<string, string>(); // 归一化名 → 首个占位的 MCP 原名
  const tools: AgentTool[] = [];

  for (const info of listed) {
    const original = info.name;
    if (typeof original !== 'string' || original.trim() === '') {
      throw new Error(`MCP server 返回了空工具名：${JSON.stringify(info.name)}`);
    }
    const cleaned = normalizeToolName(original);
    if (cleaned === '') {
      // 原名不含任何 ASCII 字母/数字/下划线（如 "🔥🔥"、"获取时间"）时归一化产物为空串 ——
      // 不拦下的话最终名只剩前缀也能注册成功，与「空名直接抛错」的承诺相反。
      // 必须在撞名检查之前抛出（裸前缀名还可能与下一个空名工具撞出误导性报错）。
      throw new Error(
        `MCP 工具名 ${JSON.stringify(original)} 归一化后为空（原名不含任何 ASCII 字母/数字/下划线）—— ` +
          '请在 server 侧改用可辨识的工具名，或检查其 tools/list 实现',
      );
    }
    const name = `${prefix}${cleaned}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new Error(
        `MCP 工具名 "${original}" 归一化后为 "${name}"，不满足 ^[A-Za-z0-9_-]{1,64}$` +
          `（前缀 "${prefix}" 过长或原名含过多非法字符）—— 请换个更短的 prefix`,
      );
    }
    const dup = seen.get(name);
    if (dup !== undefined) {
      throw new Error(
        `MCP 工具名归一化后撞名：${JSON.stringify(dup)} 与 ${JSON.stringify(original)} ` +
          `都变成 "${name}" —— 请给其中一个在 server 侧改名，或用 prefix 区分`,
      );
    }
    seen.set(name, original);

    const schema =
      info.inputSchema && typeof info.inputSchema === 'object' && !Array.isArray(info.inputSchema)
        ? (info.inputSchema as JsonSchema)
        : ({ type: 'object' } as JsonSchema);

    // 外部 server 的 tools/list 是**外部输入**：description 不是 string（数字/对象）时
    // 直接 `.trim()` 会让整个装配期崩 —— 与上面 name / inputSchema 的类型防御保持一致。
    const description = typeof info.description === 'string' ? info.description.trim() : '';
    tools.push({
      name,
      description: description || `MCP 工具 ${original}`,
      inputSchema: schema,
      run: async (input: unknown, ctx?: ToolRunContext) => {
        // 原名先落账再调用：连接器抛错/超时时，trace 里仍留得下「本想调谁」
        if (ctx) {
          try {
            // 两条键：`mcp.tool` 是「本次 turn 最近一次」的兼容键（既有看板/查询照旧）；
            // `mcp.tool.<菜单名>` 每次调用各写一条 —— 同回合并行调多个 MCP 工具时单值键会被
            // 后者覆盖，审计/回放就拿不回被覆盖那个（按菜单名分键即无此问题）。
            ctx.recorder.setAttribute(ctx.parentSpanId, 'mcp.tool', original);
            ctx.recorder.setAttribute(ctx.parentSpanId, `mcp.tool.${name}`, original);
          } catch {
            /* 观测是辅助动作：记账失败不得把一次正常调用变成失败 */
          }
        }
        const args =
          input && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        // 出站传播（SEP-414）：把「发起本次调用的那个 span」的 traceparent 带给 server，
        // 由连接器放进 params._meta（裸键）。
        // 落点在**桥**而不在连接器里调 `currentTraceparent()`：分层上 integrations 够不到
        // engine 的 span-scope（只许依赖 core）—— 但 ctx 里**已经有同一份投影的原料**
        // （`recorder.traceId` + `parentSpanId`；turn.ts 包工具执行的 `withCurrentSpan`
        // 用的就是这两个值，二者与 currentTraceparent() 同源同格式，经 core 的
        // formatTraceparent 编出同一个串）。ctx 缺席（桥脱离引擎单用）⇒ 不带
        // —— 没有上下文可传时不造空值（纪律③）。
        const traceparent = ctx
          ? formatTraceparent(ctx.recorder.traceId, ctx.parentSpanId)
          : undefined;
        const baseOpts: McpCallOptions = {
          ...(ctx?.abandoned !== undefined ? { abandoned: ctx.abandoned } : {}),
          ...(traceparent !== undefined ? { traceparent } : {}),
        };
        // 裁判权（2026-09-17，见 spec §10 2026-09-17 ①）：引擎**表过态**时，桥不启动自己的计时器 ——
        // 两个计时器判同一件事，只会得到两种账（桥那份曾被记成 error(unknown)/errorKind=threw），
        // 而且桥的纯竞速还会把超了预算的调用记成成功。`timeoutMs` 退化为兜底（只在脱离引擎单用、
        // 或引擎压根没设 toolTimeoutMs 时生效）。
        //
        // 判据是 `!= null` 而**不是** `> 0`：`toolTimeoutMs: 0` 的文档语义是「引擎不设超时」，
        // 那同样是引擎的表态。用 `> 0` 的话，用户显式写下 0（不限），桥却自作主张判 60s ——
        // 与「一次调用只有一个裁判」相反：说了不限就该不限。
        const engineBudget = ctx?.toolTimeoutMs;
        if (engineBudget != null) {
          // 引擎是裁判：它的 toolTimeoutMs 到点会 fire ctx.abandoned —— 连接器据此
          // 清掉这次调用的簿记（stdio 的 pending 条目），不留下等不到回收的残骸。
          return client.callTool(original, args, baseOpts);
        }
        // 桥兜底裁判（脱离引擎单用 / 引擎没设超时）：到点除了放弃等待，还要通知连接器
        // 清理簿记 —— 与引擎路径共用同一个 `abandoned` 缝（`core/abort.ts` 合成）。
        const ac = new AbortController();
        const abandoned =
          ctx?.abandoned !== undefined ? combineSignals(ctx.abandoned, ac.signal) : ac.signal;
        try {
          return await withDeadline(
            client.callTool(original, args, { ...baseOpts, abandoned }),
            timeoutMs,
            original,
          );
        } finally {
          ac.abort(); // 无论成败都摘掉：成功时条目已被响应清掉，超时/出错时靠这次 abort 清
          releaseCombinedSignal(abandoned); // 摘除挂在 ctx.abandoned 上的监听器
        }
      },
    });
  }

  return tools;
}

/* ═══════════════════════════ 连接器（内置默认件） ═══════════════════════════
 *
 * 2026-09-18 决策（spec §10 同日条）：连接器从「独立可选包 `@migor/mcp`」改为**内置**。
 * 判据是仓库自己的两份先例（`store/` 的三层形状）：
 *
 *   - 只用**标准库**的平台能力 → 直接内置在 `src/`
 *     （`transport/http.ts` 的 `node:http`、`store/sqliteStore.ts` 的 `node:sqlite`、
 *      `runtime/context.ts` 的 `node:async_hooks`、`engine/tracer.ts` 的 `node:crypto`）；
 *   - 需要**第三方客户端** → 只留 duck-typed 缝、框架永不 import
 *     （`store/redisStore.ts` 的 `RedisLike`，以及 `mcp-protocol.ts` 的 `McpClientLike`）。
 *
 * `spawn`（`node:child_process`）与 `fetch`（Node 18+ 全局）都是标准库 ⇒ 内置**不增加**
 * 任何第三方依赖。「零运行时依赖」那条口径（= 不依赖第三方包，见 `package.json` 三个依赖
 * 字段全空）不受影响 —— 它从来不是「不 import node 内建」的意思，`node:http` 一直在用。
 *
 * 结构面**不变**：`McpClientLike` 仍是最小缝，用户照旧可以接官方 SDK / 远程 server /
 * 自研传输。这里给出的只是**默认件** —— 与 `FileTaskStore` / `SqliteTaskStore` 之于
 * `TaskStore` 完全同构（默认件内置 + 缝保留 + 特殊后端仍由用户带 client）。
 *
 * 2026-09-20 结构拆分：两个连接器实现各居 `mcp-stdio.ts` / `mcp-http.ts`（零行为变化）。
 * 2026-09-28：与桥共用的结构类型与 helper 移居 `mcp-protocol.ts`（断开值环），
 * 下方统一 re-export —— 公共面仍由本文件出口。
 */

// 与连接器共用的协议面（结构类型 + helper）：定义在 mcp-protocol.ts，此处 re-export 保持公共面
export {
  DEFAULT_CLIENT_INFO,
  DEFAULT_PROTOCOL_VERSION,
  MCP_DEFAULT_TIMEOUT_MS,
  brief,
  isJsonRpcResponse,
  jsonRpcError,
  unwrap,
  withDeadline,
} from './mcp-protocol.js';
export type { Guard, McpClientLike, McpConnector, McpToolInfo } from './mcp-protocol.js';

// 两个内置连接器（2026-09-20 起各居其文件；公共面不变，index.ts 仍从这里取）
export { createStdioMcpConnector, MCP_CLOSE_GRACE_MS } from './mcp-stdio.js';
export type { StdioMcpConnectorOptions } from './mcp-stdio.js';
export { createStreamableHttpMcpConnector } from './mcp-http.js';
export type { StreamableHttpMcpConnectorOptions } from './mcp-http.js';
