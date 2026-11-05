/*
 * 穷尽转发的**类型级**守卫（`docs/guards.md` §2 的「手写转发列表不得漏字段」）。
 * 只做类型检查、不运行（文件名不是 *.test.ts，node:test 不收它）—— 由
 * `npm run typecheck:types` 校验（verify-all 第 3 步；`tsconfig.tests.json` 显式
 * 排除 `tests/types`，所以 typecheck:tests 管不到本文件）。
 *
 * 守的是什么：`ToolRunContext` 上「嵌套能力必须原样往下交」的字段清单
 * （`src/engine/forwarded.ts`）。新增一个可选字段而**没有归类**（既不在转发组、
 * 也不在「引擎自装配」组）时，`UnclassifiedToolContextKey` 就不再是 `never`
 * ⇒ 下面那条赋值编译失败。
 *
 * 为什么非要在类型层守：字段全是可选的，TS 的结构类型对「少写一个键」不报错 ——
 * 历史事故 `runAgentScoped` 漏 `toolTimeoutMs` 就是这种静默漏（跨 engine → toolkit → ctx
 * 三层没人发现）。运行期补不了这一课：`interface` 的键在运行期**枚举不出来**。
 */
import type {
  ForwardedToolContext,
  ForwardedToolContextKey,
  ToolContextNotForwardedKey,
  UnclassifiedToolContextKey,
} from '../../src/engine/forwarded.js';
import type { FORWARDED_TOOL_CONTEXT_KEYS } from '../../src/engine/forwarded.js';
import type { ToolRunContext } from '../../src/core/tool.js';

/* ============ ① 归类必须穷尽 ============ */

/**
 * 全部归好类时 `UnclassifiedToolContextKey` 是 `never` ⇒ 条件类型的真分支 ⇒ `true` ⇒ 通过。
 *
 * 一旦 `ToolRunContext` 多了一个两边都没收的字段，它就变成那个**字段名**，条件类型走假分支
 * ⇒ 类型是 `never` ⇒ 而 `never` 只接受 `never` ⇒ 赋 `true` 当场报错（报错里带着字段名）。
 */
type AssertAllClassified = UnclassifiedToolContextKey extends never ? true : never;
export const allToolContextKeysClassified: AssertAllClassified = true;

/**
 * 反向验证：**故意**造一个未归类字段，喂给同一套断言 —— 必须报错。
 * `@ts-expect-error` 标在下一行；若哪天不再报错，tsc 以 2578（未使用的指令）判本文件失败。
 * 这条证明的是「①那条断言不是恒真」，也就是守卫真的会咬。
 */
type CtxWithBrandNewKnob = ToolRunContext & { someBrandNewKnob?: number };
type UnclassifiedOfThat = Exclude<
  keyof CtxWithBrandNewKnob,
  ForwardedToolContextKey | ToolContextNotForwardedKey
>;
// @ts-expect-error 混进未归类字段时，`…extends never ? true : never` 应为 never ⇒ 赋 true 报错
export const _probeUnclassifiedIsCaught: UnclassifiedOfThat extends never ? true : never = true;

/* ============ ② 交由调用点播开的那组值：全部键**必填** ============ */

/**
 * 少一个键必须报错 —— 这正是「调用点漏字段不可能发生」的机制
 * （调用点只写 `...forwardToolContext(ctx)`，键由本类型要求齐）。
 * `@ts-expect-error` 反向钉住：真空了会以 2578 失败。
 */
// @ts-expect-error 故意漏掉 toolTimeoutMs：全必填的类型必须拦住
export const _missingOneKeyIsRejected: ForwardedToolContext = {
  signal: undefined,
  priceOverrides: undefined,
  onUnpricedModel: undefined,
  maxEventChars: undefined,
  maxToolResultChars: undefined,
  traceContent: undefined,
  usageOffset: undefined,
  maxTotalTokens: undefined,
  maxCostUsd: undefined,
};

declare const forwarded: ForwardedToolContext;

/** 正面：全部键在场时可赋值（`undefined` 是合法值 —— 「本 run 没设」不是「没转发」）。 */
export const _completeIsAccepted: ForwardedToolContext = {
  signal: forwarded.signal,
  priceOverrides: forwarded.priceOverrides,
  onUnpricedModel: forwarded.onUnpricedModel,
  maxEventChars: forwarded.maxEventChars,
  maxToolResultChars: forwarded.maxToolResultChars,
  traceContent: forwarded.traceContent,
  usageOffset: forwarded.usageOffset,
  maxTotalTokens: forwarded.maxTotalTokens,
  maxCostUsd: forwarded.maxCostUsd,
  toolTimeoutMs: forwarded.toolTimeoutMs,
};

/**
 * 清单与类型的键集必须**互相**构成对方（多一个 / 少一个都报错）——
 * 它把运行期的 `FORWARDED_TOOL_CONTEXT_KEYS` 数组和类型层那份（映射类型）钉在一起，
 * 免得有人只改了数组或只改了映射类型。
 */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
export const _typeMatchesRuntimeList: SameKeys<
  ForwardedToolContext,
  Record<(typeof FORWARDED_TOOL_CONTEXT_KEYS)[number], unknown>
> = true;
