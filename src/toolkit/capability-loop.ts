import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import type { MessageParam } from '../core/message.js';
import type { AgentTool, JsonSchema, SchemaType, ToolRunContext } from '../core/tool.js';
import type { SpanError, SpanId } from '../core/trace.js';
import { runAgentScoped } from '../engine/loop.js';
import { classifyError } from '../engine/errors.js';
import { forwardToolContext } from '../engine/forwarded.js';
import { normalizeMessages } from '../engine/spec.js';
import { withCurrentSpan } from '../engine/span-scope.js';
import { isSuccessStopReason } from '../engine/types.js';
import type { AgentStopReason, ContextPolicy, SystemParam } from '../engine/types.js';

/**
 * Agentia —— **代码控制顺序的子循环**原语（spec §10 2026-11-04 run-capability-loop）。
 *
 * ## 它补的是哪一格
 *
 * 四类能力里，「谁定流程」有两个极端：`@SubAgent` / `@Skill` 的子循环由**模型**驱动
 * （前者整段交给模型，后者由你的方法体决定何时调 `ctx.llm`），而「这件事会不会活过
 * 这次请求」的判据又把长跑 / 要审批的活儿推给 `AsyncRunner` 的 task。中间那一格是空的：
 *
 * > 顺序由**我的代码**定（不是模型）、生命周期**不超出**这次请求（不进 task 状态机）、
 * > 但要能挂到**同一棵** trace 上、要能裁剪上下文、要能被外层工具的 `approval` 拦住。
 *
 * 从前做这件事只有一条路：手写 `runAgentScoped` + 自己逐个转发 `ToolRunContext` 的旋钮。
 * 那条路在 `engine/forwarded.ts` 的文件头里有完整的事故记录 —— 漏一个 `toolTimeoutMs`
 * 是**静默**的（TS 的可选字段不会报错），后果还是反的（子循环永不超时）。所以本模块
 * **不是**把 `runAgentScoped` 直接搬上公共面，而是把它包成「旋钮不可漏」的形状：
 * `...forwardToolContext(ctx)` 一次取自单源，使用方接触不到那七个键。
 *
 * ## 与另外三行的分工（选型只看两个问题）
 *
 * | 问题 | 是 ⇒ | 否 ⇒ |
 * |---|---|---|
 * | 顺序要不要模型定？ | `@SubAgent`（整段）/ `@Skill`（方法体里 `ctx.llm`） | **本模块** |
 * | 会不会活过这次请求？ | `AsyncRunner.submit`（task：耐久 / 崩溃续跑 / 审批原生） | **本模块** |
 *
 * 要审批的动作：把调用本模块的那个方法标成 `@Tool({ approval: 'required' })` ——
 * 审批发生在**外层工具调用**上，于是一个「子循环里要改数据」的活儿既能挂起等人批
 * （`POST /tasks/:id/approve`），又不必为它造一条任务。这正是 `@SubAgent` / `@Skill`
 * 做不到的那半（子循环内部的 `approval` 无法挂起整条 run，见 usage-guide §7）。
 *
 * ## 边界（都是刻意留白，不是缺口）
 *
 * - **不做策略**：不替你拆步、不重试、不汇总多个子循环 —— 顺序写在你的方法体里。
 * - **不自开 run 根**：`llm.turn` 挂在 `ctx.parentSpanId` 下的一个 `capability` span 里，
 *   与本条 run 同树；`traceId` 不变，`runId` 也不会多出来一个。
 * - **不给 `client` 缺省之外的聪明**：不传 `model` 就走引擎缺省；子循环**不继承**主 run
 *   的 `fallbacks` 链（同 `runAgentScoped` 的有意边界）。
 * - **挂起不穿透**：子循环里调用了 `deferUntil` / 触发审批挂起时，语义同其它嵌套能力 ——
 *   以 `is_error` 交回，整条 run 不挂起。要挂起请用 task。
 */
export interface CapabilityLoopOptions<S extends JsonSchema = JsonSchema> {
  /**
   * trace 里那个 `capability` span 的名字。缺省 `'capability-loop'` ——
   * 建议给一个业务名（`'ledger-review'`），否则看板上一排同名 span 分不出是谁。
   */
  name?: string;
  /** 子循环的输入：一段文本或完整 messages（与 `app.run` 同一套规整口径） */
  input: string | MessageParam[];
  /** 子循环的 system（独立上下文：主 agent 的历史**不可见**） */
  system?: SystemParam;
  /** 子循环可见的工具（缺省空 = 纯文本回合） */
  tools?: AgentTool[];
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  /**
   * 子循环自己的上下文裁剪策略。**这是本原语存在的理由之一** ——
   * 应用级 `contextPolicy` 不进子循环（usage-guide §7），长跑子循环想不撞上限
   * 只能在这里显式给。
   */
  contextPolicy?: ContextPolicy;
  /** 结构化结果 schema：给出后追加隐藏 `submit_result` 工具，校验结果落在 `typed` */
  resultSchema?: S;
  /** 逐字回调（转发给子循环的 `llm.turn`，不写 trace 时也能做流式） */
  onText?: (delta: string) => void;
}

/** 子循环的产物（只回「这次子循环发生了什么」，不夹带整棵 trace） */
export interface CapabilityLoopResult<S extends JsonSchema = JsonSchema> {
  /** 子循环最终文本（隔离报告：中间往返不外传） */
  text: string;
  /** `resultSchema` 校验通过的结构化结果；未给 schema 或模型未提交时为 undefined */
  typed: SchemaType<S> | undefined;
  /** 收尾原因。调用方自己判成败（`isSuccessStopReason`）—— 框架不替它抛 */
  stopReason: AgentStopReason;
  iterations: number;
  /** 本次子循环的 capability span id（要补事件 / 属性时用） */
  spanId: SpanId;
  /** 非正常收尾时的错误（与 `stopReason` 同源，不另造一份口径） */
  error?: SpanError;
}

/**
 * 在**当前工具调用**里拉起一条子循环。
 *
 * `ctx` 必须是引擎注入的 `ToolRunContext`（`AgentTool.run` 的第二个参数）——
 * 它带着 recorder / 父 span / 取消信号 / 预算与超时护栏。从别处手搓一个 ctx 只会
 * 得到一个「看起来在跑、实际不进树、护栏全离线」的子循环，所以这里不做任何兜底。
 */
export async function runCapabilityLoop<S extends JsonSchema = JsonSchema>(
  ctx: ToolRunContext,
  opts: CapabilityLoopOptions<S>,
): Promise<CapabilityLoopResult<S>> {
  const messages = normalizeMessages(opts.input);
  const name = opts.name ?? 'capability-loop';
  const recorder = ctx.recorder;
  const spanId = recorder.begin('capability', name, ctx.parentSpanId);

  let closed = false;
  const finish = (status: 'ok' | 'error', error?: SpanError): void => {
    if (closed) return;
    closed = true;
    recorder.end(spanId, { status, ...(error !== undefined ? { error } : {}) });
  };
  // 引擎超时「放弃等待」时：capability span 立刻以 error 收尾（与 @SubAgent / @Skill 同口径）
  // —— 等子循环自己 settle 再关，交付的 trace 里会留一个永不闭合的半截 span。
  const onAbandoned = (): void => {
    finish('error', {
      type: 'timeout',
      message: `capability-loop(${name}) 执行超时被引擎放弃等待`,
      retryable: true,
    });
  };
  ctx.abandoned?.addEventListener('abort', onAbandoned, { once: true });
  // 子循环除了本 run 的取消，还要能被「放弃等待」打断（在飞请求掐掉，不再后台烧 token）
  const combined = combineSignals(ctx.signal, ctx.abandoned);

  try {
    const loop = await withCurrentSpan({ traceId: recorder.traceId, spanId }, () =>
      runAgentScoped<S>({
        // 七个「必须往下交」的旋钮一次取自单源（engine/forwarded.ts）——
        // 手写清单的代价是静默漏字段，历史事故就是 toolTimeoutMs 跨三层没人发现。
        ...forwardToolContext(ctx),
        client: ctx.client,
        model: opts.model,
        maxTokens: opts.maxTokens,
        maxIterations: opts.maxIterations,
        system: opts.system,
        messages,
        tools: opts.tools ?? [],
        recorder,
        parentSpanId: spanId,
        // 唯一需要**覆盖**的一项（见 engine/forwarded.ts 文件头对 combineSignals 的说明）
        signal: combined,
        contextPolicy: opts.contextPolicy,
        resultSchema: opts.resultSchema,
        onText: opts.onText,
      }),
    );
    recorder.setAttribute(spanId, 'stop_reason', loop.stopReason);
    finish(isSuccessStopReason(loop.stopReason) ? 'ok' : 'error', loop.error);
    return {
      text: loop.finalText,
      typed: loop.typed,
      stopReason: loop.stopReason,
      iterations: loop.iterations,
      spanId,
      ...(loop.error !== undefined ? { error: loop.error } : {}),
    };
  } catch (e) {
    // 请求级异常（recorder / 输入校验）此前还没收尾 —— 兜底标记，别留半截 span
    finish('error', classifyError(e));
    throw e;
  } finally {
    // 摘除监听：宿主级共享 signal 是长寿的，不摘会按调用次数累积
    ctx.abandoned?.removeEventListener('abort', onAbandoned);
    releaseCombinedSignal(combined);
  }
}
