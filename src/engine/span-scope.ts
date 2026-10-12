import { AsyncLocalStorage } from 'node:async_hooks';
import { type SpanId, formatTraceparent } from '../core/trace.js';

/**
 * Agentia —— **调用期**「当前 span」作用域（spec §9.2 出站传播）。
 *
 * 为什么不是 run 级：run 级 ALS 只有一个值，并行工具调用会互相覆盖 ⇒ 父子关系错。
 * spec §9.2 正是因此锁定「span 句柄**不放** `RunContext`」（那里只有 blackboard）。
 * 这里**每次调用一份** —— `withCurrentSpan` 进入的是该次调用的 async 上下文，
 * 并行调用天然互不干扰（`tests/engine/spanScope.test.ts` 钉着这条）。
 *
 * 写入点由粗到细三层，内层覆盖外层：
 * - `run` 根 —— `engine/loop.ts` 包住整轮循环；
 * - `llm.turn` —— `engine/turn.ts` 包住每次工具调用（普通工具与 `@Prompt` **刻意不建 span**，
 *   它们的「当前 span」就是发起它的那个回合，与 `ToolRunContext.parentSpanId` 同一个值）；
 * - `capability` —— `toolkit/skill.ts` / `toolkit/subagent.ts` 包住自己的方法体 / 子循环。
 *
 * 三层各自登记自己的 `agentName`（run 根 = 应用名、capability = 子 agent 名）；夹在中间的
 * `llm.turn` **不知道身份**，靠 `withCurrentSpan` 的**继承**把上一层的值留住（见该函数注释）。
 *
 * 边界（如实）：`run` 根 span 由 `runAgent` 打开，故 `executeRun` 里更早的 `contextInit` /
 * 记忆水合**没有**作用域 —— 那时确实还没有 span 可指，`currentTraceparent()` 返回 `undefined`。
 */

/** 作用域内容：一次调用同时知道自己是哪条 trace 的哪个 span（两件都要，才能编出合法头） */
export interface SpanScope {
  traceId: string;
  spanId: SpanId;
  /**
   * 当前正在跑的是**哪个 agent**（run 根 = 应用名；子 agent 的 capability span = 该 subagent 名）。
   *
   * 为什么需要它（2026-10-12 G7 交接）：`@SubAgent` 的 capability span 上要写
   * `agentia.handoff.from` —— 值是**调用方** agent 名，而调用点手上只有 `recorder`
   * （**只写不读**，`RecorderBackend` 没有任何查 span 树的口子）与 `ctx.parentSpanId`
   * （一个 id，反查不出名字）。唯一拿得到它的地方就是「当前调用期」，即这里。
   *
   * ⚠️ 值是**人读的名字**（run 根用 `runName`、子 agent 用它注册的 `name`），不是 span id、
   * 也不是 `<类型>:<名>` 那种展示串 —— 它要直接写进 `agentia.handoff.from` 给外部消费。
   */
  agentName?: string;
}

const store = new AsyncLocalStorage<SpanScope>();

/**
 * 在指定 span 作用域内执行。返回类型随 fn 而定（async fn → Promise<T>，同步 fn → T）。
 *
 * 传的是**值**而不是「读 ctx」：写入者手上只有 recorder 与 span id，这里不去反向依赖
 * runtime 的 `RunContext`（`engine` 不能引 `runtime`，分层单向）。
 */
export function withCurrentSpan<T>(scope: SpanScope, fn: () => Promise<T>): Promise<T>;
export function withCurrentSpan<T>(scope: SpanScope, fn: () => T): T;
export function withCurrentSpan<T>(scope: SpanScope, fn: () => T | Promise<T>): T | Promise<T> {
  // ⚠️ 是**合并**（内层同名键覆盖外层），不是整条替换 —— `agentName` 是**跨层不变的身份**，
  // 而三个写入点各自只知道「自己这一层的 span id」：run 根（loop.ts）知道应用名、capability
  // （skill/subagent）知道子 agent 名，夹在中间的 `llm.turn`（turn.ts）**两个都不知道**。
  // 用整条替换的话，turn.ts 每次包工具执行都会把 run 根写下的 agent 名抹成 undefined ⇒
  // 交接属性永远拿不到值。`traceId` / `spanId` 仍由每个写入点显式给 ⇒ 收窄语义逐字不变
  // （`tests/engine/spanScope.test.ts` 的「并行链互不干扰、内层不外泄」继续钉着这一条）。
  const outer = store.getStore();
  return store.run({ ...outer, ...scope }, fn);
}

/** 当前调用期的 span 作用域；不在任何 run / 调用内时 undefined。 */
export function currentSpan(): SpanScope | undefined {
  return store.getStore();
}

/**
 * 当前调用期的 W3C `traceparent`（**公共 API**，spec §9.2 出站传播）。
 *
 * 玩法：在自己发起的出站请求里带上它，下游就能把「谁触发了这次调用」记成一条指向
 * **具体 span** 的 link（粒度到 turn / capability，不再是 run 级）。
 *
 * ```ts
 * await fetch(url, { headers: { traceparent: currentTraceparent()! } });
 * ```
 *
 * - 不在 run 内、或在 `run` 根 span 打开之前的环节（`contextInit` / 记忆水合）→ `undefined`；
 * - flags 位恒 `00`：本框架不采样，不替下游声明「已采样」；
 * - 框架**不替你做**出站注入（它不创建出站请求）—— 这一行是你自己的。
 */
export function currentTraceparent(): string | undefined {
  const scope = store.getStore();
  if (!scope) return undefined;
  return formatTraceparent(scope.traceId, scope.spanId);
}
