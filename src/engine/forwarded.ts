/**
 * 「嵌套能力（@SubAgent / @Skill）必须原样交下去的旋钮」—— **穷尽转发的单一真源**。
 *
 * 为什么要有这个文件（`docs/guards.md` §2 的「手写转发列表不得漏字段」）：
 *
 * 主循环把一批旋钮经 `ToolRunContext` 交给工具，子 agent / skill 拉起自己的 llm 循环时
 * **必须**再把它们交下去。这份清单此前手写在**两个**调用点（`toolkit/subagent.ts` 与
 * `toolkit/skill.ts`），每处七八行 `ctx.X,` —— 而 TS 的结构类型对「少写一个键」**不报错**
 * （键都是可选的），`exactOptionalPropertyTypes` 也只堵住「显式传 undefined」那一半。
 * 于是漏字段是**静默**的：历史事故就是 `runAgentScoped` 漏 `toolTimeoutMs`，跨 engine →
 * toolkit → ctx 三层没人发现，后果还是**反的** —— 子循环 `withTimeout(p, 0)` 永不超时，
 * 而 MCP 桥又另起自己的 60s 兜底计时器（双计时器、双账本）。
 *
 * 本文件的机制有两半，缺一不可：
 *
 * 1. **取值收一处**：`forwardToolContext(ctx)` 是唯一的取值点，映射类型写成
 *    `{ [K in Key]-?: … }` —— 全部键**必填**（值可以是 `undefined`）。少写一行 = 编译错误，
 *    而不是静默漏。调用点播 `...forwardToolContext(ctx)` 即可，**没有**可漏的地方。
 * 2. **归类要穷尽**：`ToolRunContext` 的每个键必须在「转发」或「引擎自装配」里各就各位。
 *    新增一个可选字段而两边都没归类 ⇒ `UnclassifiedToolContextKey` 不再是 `never`
 *    ⇒ `tests/types/forwarding.types.ts` 的断言编译失败（`typecheck:types` 是 verify-all 第 3 步）。
 *
 * ⚠️ 唯一需要**覆盖**而不是直取的是 `signal`：两个调用点交下去的是
 * `combineSignals(ctx.signal, ctx.abandoned)`（子循环还要能被「放弃等待」打断），
 * 所以那里写成 `{ ...forwardToolContext(ctx), signal: combined }` —— 覆盖是显式的，
 * 其余键仍然不可能漏。
 *
 * ⚠️ 本模块不是公共 API（不进 `src/index.ts`）：它是内部纪律的落点。
 */
import type { ToolRunContext } from '../core/tool.js';

/**
 * 从 `ToolRunContext` 转进子循环的键。顺序即文档顺序。
 *
 * 加/删这里**必须**同时改 `forwardToolContext` 的返回对象 —— 映射类型要求每个键都出现。
 */
export const FORWARDED_TOOL_CONTEXT_KEYS = [
  /** 中断信号（调用点通常再 combine 上 「放弃等待」） */
  'signal',
  /** 宿主价格表（漏了 ⇒ 子循环里自定义定价模型退化成「未定价」，`maxCostUsd` 静默失效） */
  'priceOverrides',
  /** 未定价告警回调（漏了 ⇒ 子循环里算不出成本却没人知道） */
  'onUnpricedModel',
  /** 正文截断口径（漏了 ⇒ 同一棵树上主/子 agent 的可见性不一致） */
  'maxEventChars',
  /** 工具结果回模型的上限（漏了 ⇒ 子循环可以把上下文重新撑爆） */
  'maxToolResultChars',
  /** assistant 文本记录口径（漏了 ⇒ 同一棵树上主 agent 有 output.text、子 agent 没有） */
  'traceContent',
  /** 成本护栏（漏了 ⇒ 护栏在子循环期间离线） */
  'usageOffset',
  'maxTotalTokens',
  'maxCostUsd',
  /** 超时裁判权（漏了 ⇒ 永不超时 + 桥另起计时器，见文件头） */
  'toolTimeoutMs',
] as const;

export type ForwardedToolContextKey = (typeof FORWARDED_TOOL_CONTEXT_KEYS)[number];

/**
 * 交给子循环的那一组值：**全部键必填**（值可以是 `undefined` —— 那表示「本 run 没设」，
 * 与「忘了转发」是两件事，后者在类型上写不出来）。
 */
export type ForwardedToolContext = {
  [K in ForwardedToolContextKey]-?: ToolRunContext[K];
};

/**
 * 引擎自己装配、**刻意不**转发的键。每一个都要写清理由 —— 不写的代价是下一个人
 * 不知道该不该转发，于是又手写一遍清单。
 */
export type ToolContextNotForwardedKey =
  /** 模型客户端：子循环用**它自己**的一份（capability 的 client 由调用点从别处拿） */
  | 'client'
  /** 记账器：子循环写**同一条** trace，但由引擎显式传 `recorder`，不走这组旋钮 */
  | 'recorder'
  /** 父 span：子循环的父是 capability span，由调用点显式给 */
  | 'parentSpanId'
  /** 「放弃等待」信号：折进 `signal`（见文件头的 combine），子循环的工具会拿到**它自己**的 */
  | 'abandoned'
  /** 审批决定：属于**本次工具调用**（外层那个工具被批没批），不该灌进子循环的每一次调用 */
  | 'approval'
  /**
   * 延后请求口：与 `approval` 同一类 —— 它是**本次工具调用所在的那个回合**的产物
   * （请求由外层哪一次调用提出、就记在外层那个回合上）。灌进子循环会让子循环里某次工具
   * 调用的「再问我」记到**外层回合**的收集器上：外层整批作废重跑，而请求它的那个工具
   * 可能根本不在这批里 —— 张冠李戴。子循环自己的回合有自己的收集器（同一个入口装配）。
   */
  | 'deferUntil';

/**
 * 未归类的键。全部归类时是 `never`；一旦 `ToolRunContext` 新增字段而上面两组都没收，
 * 它就变成那个字段名 —— 于是 `tests/types/forwarding.types.ts` 里那句赋 `true` 编译失败。
 */
export type UnclassifiedToolContextKey = Exclude<
  keyof ToolRunContext,
  ForwardedToolContextKey | ToolContextNotForwardedKey
>;

/**
 * 取值：把 `ctx` 上该转发的键原样取出（**不判空** —— `undefined` 是有信息的值，
 * 表示「本 run 没设这个旋钮」，子循环该用它自己的缺省；判空会把它吃成「没转发」）。
 *
 * ⚠️ 不做真值判定：`maxEventChars: false`（不截断）与 `maxTotalTokens: 0` 都是有意义的值，
 * 真值判定会把它们变成「没设」。这与 `engine/tool-context.ts` 的三档判定口径一致。
 */
export function forwardToolContext(ctx: ToolRunContext): ForwardedToolContext {
  return {
    signal: ctx.signal,
    priceOverrides: ctx.priceOverrides,
    onUnpricedModel: ctx.onUnpricedModel,
    maxEventChars: ctx.maxEventChars,
    maxToolResultChars: ctx.maxToolResultChars,
    traceContent: ctx.traceContent,
    usageOffset: ctx.usageOffset,
    maxTotalTokens: ctx.maxTotalTokens,
    maxCostUsd: ctx.maxCostUsd,
    toolTimeoutMs: ctx.toolTimeoutMs,
  };
}
