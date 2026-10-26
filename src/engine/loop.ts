import type { MessageParam } from '../core/message.js';
import { truncateWithMark } from '../core/json.js';
import { createAnthropicClient } from '../integrations/anthropic.js';
import type {
  AgentTool,
  JsonSchema,
  ModelClient,
  ModelPricing,
  RecorderBackend,
  SchemaType,
} from '../core/tool.js';
import type { SpanError, SpanId } from '../core/trace.js';
import type { TaskEvent } from '../core/run.js';
import { withCurrentSpan } from './span-scope.js';
import type { AgentLoopResult } from './loop-result.js';
import { abortedResult, failedResult, finishedResult, suspendedResult } from './loop-result.js';
import { tailToolUses, renderTaskEvent, textOfParam } from './resume-input.js';
import { detectMenuDrift, menuSignature } from './menu-drift.js';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  resolveDefaultModel,
  resolveModelChain,
  runConfigSnapshot,
  validateLabels,
} from './run-config.js';
import type { ResolvedModelLink } from './run-config.js';
import type { RetryOptions } from './retry.js';
import { validateRetryOptions } from './retry.js';
import { TraceRecorder } from './tracer.js';
import {
  abortedError,
  budgetError,
  buildLoopContext,
  checkTurnEntry,
  executeTurnTools,
  recordTurnUsage,
  streamTurn,
} from './turn.js';
import { textOf } from './text.js';
import { resolveStopReason } from './stop-reason.js';
import { classifyError } from './errors.js';
import type { AgentLoopArgs } from './turn.js';
import type {
  AgentRunResult,
  AgentStopReason,
  ContextPolicy,
  RunAgentOptions,
  SystemParam,
} from './types.js';
import { isSuccessStopReason } from './types.js';

/**
 * Agentia —— 主循环（manual loop，流式）—— spec §5。
 *
 * 结构：核心是 `agentLoop` —— 不自开 run 根，所有 llm.turn 挂在给定的
 * parentSpanId 下。同一套循环既能当主 agent（run 根为其父，由 runAgent 开），
 * 也能当子 agent（capability span 为其父，见 toolkit/subagent.ts），llm.turn 与 usage
 * 递归进同一条 trace（spec §9：子 agent = 一个 capability span，内部能力递归成它的子孙）。
 *
 * 工具执行经 ctx: ToolRunContext 把 {client, recorder, parentSpanId: 当前 turn}
 * 交给 tool.run —— 普通工具忽略；子 agent 用它在正确位置开 capability span。
 *
 * 文件分工：本文件只留入口（runAgent / runAgentScoped）与 agentLoop 编排骨架 +
 * run 根的装配；「一回合执行步骤」的实现机（回合上下文、请求/重试、记账、stop_reason
 * 分流、工具执行）拆在同层 turn.ts，「缺省旋钮解析 + 生效配置快照」拆在同层
 * run-config.ts，「出口的结果形状」拆在同层 loop-result.ts ——
 * 「续跑入口的读取件」拆在同层 resume-input.ts ——
 * 依赖方向单向 loop.ts → { turn.ts, run-config.ts, loop-result.ts, resume-input.ts }。
 */

/**
 * 上下文策略按 run 隔离：实现提供 `forRun` 时每条 run 拿一个全新实例 ——
 * 内置 createBudgetPolicy 的滞回计数（lastCompactAt）与增量 token 缓存都是
 * **per-run 状态**，应用级单例（AppOptions.contextPolicy）被多 run 复用时，
 * 不隔离会让「run A 第 39 回合刚压缩过」卡住「run B 前 40 回合永不压缩」，
 * 并发 run 交替调用还会让计数缓存每次从零重算。
 * 未实现 forRun 的自定义策略原样复用（无状态策略本来就不需要隔离）。
 */
function forkPolicyPerRun(policy: ContextPolicy | undefined): ContextPolicy | undefined {
  return policy?.forRun ? policy.forRun() : policy;
}

/**
 * 事件注入（2026-09-28 ref-run-event-input，run 事件投入口）：挂起期间投递的事件（`args.events`，
 * 随 `TaskRecord.pendingEvents` 落库到这里）在**未决 tool_use 解决之后**渲染成
 * user 文本消息追加进消息流，每条并在父 span 上记一条 `task.event` 事件留痕
 * （`injected: true` —— 口径是「**注入进本段消息流**」，不是「模型已看到」：
 * 该段若在首个模型请求之前就中止/失败，事件不进持久化历史（终态分支无条件清
 * 簿记，见 async.ts），但这条留痕仍然成立 —— 它记的是注入动作本身。
 * 2026-09-28 外部深评 P3-2：原名 `delivered` 超前于事实）。
 * （投毒面是「看得见」的第一道防线）。
 *
 * 为什么注入点在 loop 而不是宿主往 `rec.spec.messages` 末尾追加：
 * ① `tailToolUses` 只认历史**末尾一条** —— 末尾被一条 user 事件消息占住，
 *    未决 tool_use 就不在末尾了，续跑会被判成新对话（同一批工具再跑一遍）；
 * ② 协议要求 tool_result 紧邻 tool_use —— 事件只能排在 tool_result **之后**；
 * ③ 再次挂起的出口**不**走这里（调用方在 suspended/deferred 分支直接返回）——
 *    注入了会把 user 消息留在历史末尾，毁掉下一次续跑判定；那种情况下事件留在
 *    `TaskRecord.pendingEvents` 里，等真正跑通的那次续跑再注入。
 */
function deliverTaskEvents(
  ctx: {
    messages: MessageParam[];
    args: AgentLoopArgs;
    /** 与 `args.progress` 同一个对象（LoopContext 的必要字段，故意要它的非 optional 形态） */
    progress: { iterations: number; eventsDelivered?: boolean };
  },
  events: readonly TaskEvent[] | undefined,
): void {
  if (!events || events.length === 0) return;
  const where = ctx.args.parentSpanId ?? '';
  for (const ev of events) {
    ctx.args.recorder.event(where, 'task.event', {
      injected: true,
      event_type: ev.type,
      ...(ev.eventId !== undefined ? { event_id: ev.eventId } : {}),
    });
    ctx.messages.push(renderTaskEvent(ev));
  }
  // 置位：出口把它带进结果（eventsDelivered），宿主据此清 pendingEvents ——
  // 注入过的簿记留到下一次续跑就是**重复注入**
  // 置在**跨段共享**的 progress 上（不是内层 ctx）：外层 catch 也要读它（外部深评 E4）
  ctx.progress.eventsDelivered = true;
}

/**
 * 循环体核心：带父 span 跑一轮 manual loop。请求失败按 error 收掉 turn 后抛出，由外层收尾。
 *
 * 本体只是「一回合执行步骤」的编排骨架，各步骤的实现见 turn.ts 同名小函数：
 *   checkTurnEntry（回合入口检查 + 上下文策略）→ streamTurn（发流式请求，含重试）
 *   → recordTurnUsage（记账关 span）→ resolveStopReason（stop_reason 收尾分流）
 *   → executeTurnTools（tool_use 过滤与并发执行）。
 * 回合间共享的状态收在 LoopContext 一个对象里（不拖长参数列）。
 */
async function agentLoop<S extends JsonSchema = JsonSchema>(
  args: AgentLoopArgs<S>,
): Promise<AgentLoopResult<SchemaType<S>>> {
  const ctx = buildLoopContext(args);

  let stopReason: AgentStopReason = 'end_turn';
  let error: SpanError | undefined;
  let finalText = '';
  let finished = false;

  // 恢复模式（HITL 挂起续跑，也是通用续跑入口）：messages 末尾是含 tool_use 的
  // assistant 消息 ⇒ 这些 tool_use 尚未解决。跳过模型请求，先把它们解决掉再进正常
  // 循环 —— assistant 消息已在历史里，**不重复 push**。决定仍不齐则再次挂起
  // （不发请求、零花费）。
  const resumeUses = tailToolUses(ctx.messages);
  if (resumeUses.length > 0) {
    // 已取消：不执行任何工具（副作用不该在取消后发生），按 aborted 收尾。
    // 放在漂移检测**之前**：已取消的续跑不会再跑任何工具，菜单对不对得上它都不在乎 ——
    // 先发 menu.drift 事件 + console.warn 是纯噪音（还会误导读成「这条要续跑」）。
    if (args.signal?.aborted) {
      return abortedResult();
    }
    const drift = detectMenuDrift(resumeUses, args.tools, { resultSchema: args.resultSchema });
    // 菜单漂移（R8 候选 3 / durable 调研 §4.1 + §6 候选 3）：**续跑**时未决 tool_use 引用的
    // 工具在当前菜单里找不到了 —— 上一段与这一段跑在不同的代码版本上（删了 / 改名了一个工具）。
    // 这与回合内「模型编了个不存在的工具名」不同类：那个模型拿一句 `unknown tool` 就能自我
    // 修正（既有路径，钉在 tests/engine/toolTiming.test.ts）；这个是**我们的部署动作**把一条
    // 在飞 run 的意图作废了 —— 而它此前**完全静默**（run 照常收尾、调用方零信号，见 spec §10 ⑧）。
    //
    // 动作（本轮立项的取舍，理由写在 spec §10）：**不改 run 的成败** —— 挂起是合法态、改代码
    // 是发布常态，判失败会让「续跑」在正常迭代节奏下频繁失败。但把它变成三处看得见：
    //   ① `menu.drift` 事件（时间线；经 onTraceEvent 也进 `GET /tasks/:id/stream`）
    //   ② 父 span 属性 `menu.drift`（可查询：`TaskRecord.result.trace` 里就带得到）
    //   ③ `console.warn`（运维面立即看见，与「sink 失败落 warn」同款，见 spec §10 2026-09-27 ref-sink-failure-warn）
    // 「严格失败」若要做，是把这里换成带具名 error 的收尾 —— 那要动公共选项面 + limits 真源表，
    // 留给后续决策，别在这里先斩后奏。
    if (drift.missing.length > 0) {
      const where = args.parentSpanId ?? '';
      args.recorder.event(where, 'menu.drift', {
        missing: drift.missing,
        tool_use_ids: drift.toolUseIds,
        menu_size: args.tools.length,
      });
      if (where) {
        args.recorder.setAttribute(
          where,
          'menu.drift',
          `missing:${truncateWithMark(drift.missing.join(','), 200)}`,
        );
      }
      console.warn(
        `[agentia] 续跑时菜单漂移：未决工具在当前菜单里不存在（${drift.missing.join(', ')}）` +
          '—— 这条 run 是上一段代码版本留下的；这些 tool_use 会以 "unknown tool" 回给模型、' +
          'run 照常收尾（trace 上记了 menu.drift 事件与属性）。要按原样续跑就把它们加回菜单。',
      );
    }
    // 工具事件记到父 span：被恢复的回合属于挂起段的旧 trace，本段没有对应 llm.turn
    const outcome = await executeTurnTools(ctx, args.parentSpanId ?? '', resumeUses, null);
    if (outcome.kind === 'suspended') {
      return suspendedResult(ctx, { reason: 'approval', pending: outcome.pending });
    }
    if (outcome.kind === 'deferred') {
      // 恢复段（醒来后重跑这一批）里工具**又**请求延后：说明条件仍未成熟 ⇒ 再挂一次。
      // 目标时刻以**本次**请求为准（不是沿用上一段的 wakeAt —— 工具看到的状态更近）。
      return suspendedResult(ctx, {
        reason: 'timer',
        pending: outcome.pending,
        wakeAt: outcome.wakeAt,
      });
    }
    if (outcome.results.length > 0) ctx.messages.push({ role: 'user', content: outcome.results });
    // 事件注入（2026-09-28 ref-run-event-input）：在 tool_result **落定之后**进历史（纪律见 deliverTaskEvents）。
    // 上面两个再挂起出口刻意**不**经过这里 —— 事件留在 pendingEvents 里等下一次续跑。
    deliverTaskEvents(ctx, args.events);
    if (ctx.submitted && (args.events === undefined || args.events.length === 0)) {
      // 恢复的回合里 submit_result 校验通过：直接落定（finalText 取该 assistant 消息的文本块）
      // ⚠️ 有待注入事件时**不**直接落定：事件是新输入，落定等于让模型对着旧信息收尾 ——
      // 注入后接着进正常循环，让模型看到事件再决定（可以再 submit_result，先到先得）。
      // （能进这个分支 ⇒ 无事件 ⇒ tail 的下标与原先一致：刚 push 的 tool_results 之前那条）
      const tail = ctx.messages[ctx.messages.length - 2]; // 刚 push 了 tool_results，前一条是那条 assistant
      // iterations 0：本段没发过模型请求（恢复的工具执行不计往返）
      return finishedResult({
        stopReason: 'end_turn',
        finalText: tail ? textOfParam(tail) : '',
        iterations: 0,
        typed: ctx.typed,
      });
    }
  } else {
    // 防御：事件只投给挂起任务 ⇒ 经宿主来的必有未决 tool_use（走上面分支）；
    // 手工直传 `events` 给 app.run 而没有未决 tool_use 时，照样注入（诚实：给了就进历史）
    deliverTaskEvents(ctx, args.events);
  }

  for (let iteration = 0; iteration < args.maxIterations; iteration++) {
    const halt = await checkTurnEntry(ctx, iteration);
    if (halt) {
      stopReason = halt.stopReason;
      error = halt.error;
      finished = true;
      break;
    }

    const { turnId, message, aborted, model: modelUsed } = await streamTurn(ctx);
    if (aborted || !message) {
      stopReason = 'aborted';
      error = abortedError();
      finished = true;
      break;
    }
    ctx.progress.iterations++;

    recordTurnUsage(ctx, turnId, message, modelUsed);

    // 成本硬管控（C1）：本回合 usage 已落账 → 立刻判一次（超限会触发 onExceed 记事件）。
    // 结果**留到「循环是否还要继续」确定后再用**：
    // - 模型本回合自然收尾 → 不因「最后一回合把额度用超了」把已成功的 run 改判失败
    //   （只留 budget.exceeded 事件，可观测）；
    // - 循环还要继续（模型要求调工具）→ 停在这里，不再发下一个请求 = 不再花钱。
    const overBudget = ctx.budget ? ctx.budget.check({ totalUsage: args.recorder.usage() }) : null;

    ctx.messages.push({ role: 'assistant', content: message.content });

    // 每回合刷新 finalText：max_iterations 耗尽出口也保留已产出文本
    // （与 max_tokens / refusal / budget_exceeded 同口径；下方各收尾分支会按终态语义覆写）
    finalText = textOf(message);

    const resolution = resolveStopReason(message, args.maxTokens);
    if (resolution.kind === 'finish') {
      stopReason = resolution.stopReason;
      finalText = resolution.finalText;
      if (resolution.error) error = resolution.error;
      if (args.resultSchema !== undefined && !ctx.submitted && isSuccessStopReason(stopReason)) {
        stopReason = 'result_missing';
        error = {
          type: 'result_missing',
          message: '已声明 resultSchema，但模型自然收尾时仍未提交合法结构化结果',
          retryable: false,
        };
      }
      finished = true;
      break;
    }

    // 「消息已收、工具未跑」窗口：abort 落在这里时整批工具的副作用不该再发生 ——
    // 与续跑入口（resumeUses 分支）「已取消不执行任何工具」同一口径
    if (args.signal?.aborted) {
      stopReason = 'aborted';
      error = abortedError();
      finished = true;
      break;
    }

    const outcome = await executeTurnTools(ctx, turnId, resolution.toolUses, overBudget);
    if (outcome.kind === 'suspended') {
      // HITL 挂起：assistant 消息（含未决 tool_use）已在历史里、**不推任何 tool_result**
      // （全有或全无，见 executeTurnTools 的审批闸）；approval.requested 已记在 turn span 上。
      // error 保持 undefined —— 挂起不是失败。
      stopReason = 'suspended';
      finalText = textOf(message);
      return suspendedResult(ctx, { reason: 'approval', pending: outcome.pending }, finalText);
    }
    if (outcome.kind === 'deferred') {
      // abort 优先于挂起（2026-09-28 复审收口）：本回合若已被中止（runTimeoutMs 到点 /
      // cancel），意图是「停」—— 不能挂成 timer 之后到点再醒，那等于把取消/超时**吃掉**
      // （审批挂起要人来推、timer 会自己醒，所以这条判据对 deferred 比对 approval 更要紧；
      // 审批那条由 cancel 对 suspended 的翻转兜底，timer 没有这兜底的下一棒）。
      if (args.signal?.aborted) {
        stopReason = 'aborted';
        error = abortedError();
        finished = true;
        break;
      }
      // 时间挂起（durable timer）：与上面同形 —— 这批工具**跑过但结果作废**
      // （defer.requested 已记在 turn span 上），assistant 消息留在历史末尾，
      // 醒来后由续跑入口重跑这一批。error 保持 undefined。
      stopReason = 'suspended';
      finalText = textOf(message);
      return suspendedResult(
        ctx,
        { reason: 'timer', pending: outcome.pending, wakeAt: outcome.wakeAt },
        finalText,
      );
    }
    if (outcome.results.length > 0) ctx.messages.push({ role: 'user', content: outcome.results });

    if (ctx.submitted) {
      // submit_result 校验通过：结构化结果落定，循环正常收尾（finalText 取该回合文本，可空）
      stopReason = 'end_turn';
      finalText = textOf(message);
      finished = true;
      break;
    }

    // 超预算且本回合未落定结构化结果：不再发起下一回合，以 budget_exceeded 收尾
    if (overBudget) {
      stopReason = 'budget_exceeded';
      finalText = textOf(message);
      error = budgetError(args, overBudget);
      finished = true;
      break;
    }
  }

  if (!finished) {
    // 循环因 maxIterations 上限退出而非正常终止（所有置 stopReason 的分支都已同时置 finished）。
    // 与 budget_exceeded / refusal 同口径：非正常收尾都带结构化 error（进 run 根 span）。
    stopReason = 'max_iterations';
    error = {
      type: 'max_iterations',
      message: `达到循环上限（maxIterations=${args.maxIterations}）仍未收尾`,
      retryable: false,
    };
  }

  return finishedResult({
    stopReason,
    finalText,
    iterations: ctx.progress.iterations,
    typed: ctx.typed,
    error,
    ...(ctx.progress.eventsDelivered !== undefined
      ? { eventsDelivered: ctx.progress.eventsDelivered }
      : {}),
  });
}

/** 主入口：开 run 根 span，循环跑在其下。返回完整 trace（traceId 即 runId）。 */
export async function runAgent<S extends JsonSchema = JsonSchema>(
  options: RunAgentOptions<S>,
): Promise<AgentRunResult<SchemaType<S>>> {
  const recorder = options.recorder ?? new TraceRecorder();
  const rootName = options.runName ?? 'agent.run';
  const rootId = recorder.begin('run', rootName, null);
  // 入口段（属性记账 + 模型链 / 标签 / retry 校验）整体进 try：这一段抛错是**配置错**，
  // 必须照常响亮抛出（catch 只收尾、原样 rethrow，行为对外不变）—— 但 run 根已开，
  // 抛出前必须先合拢（error 状态 + 结构化 error + endedAt），否则交付 sink 的 trace 里
  // status='error' 而根 span 是 ok、无 endedAt、无结构化 error，违反「非正常收尾必带
  // 结构化 error」的不变量（2026-10-13 深评 A2）。runtime/run.ts 的 fail() 只在根未开时
  // 补记，根已开就信任这里已收尾（recorder.end 幂等，不双记）。
  let client: ModelClient;
  let model: string;
  let modelChain: ResolvedModelLink[];
  try {
    recorder.setAttribute(rootId, 'model', resolveDefaultModel(options.model));
    // 提示词版本化（D4）：版本号落 run 根，便于按版本筛 trace
    if (options.systemVersion)
      recorder.setAttribute(rootId, 'system.version', options.systemVersion);
    // @Prompt 资产版本（R7）：菜单里各 prompt 的版本表落 run 根 —— 质量回归能定位到具体资产版本
    if (options.promptVersions) {
      const joined = Object.entries(options.promptVersions)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([n, v]) => `${n}@${v}`)
        .join(',');
      if (joined) recorder.setAttribute(rootId, 'prompts.versions', joined);
    }
    // 会话标识（R7 thread 维度）：多轮 run 按 session 聚合；OTLP 侧映射 gen_ai.conversation.id
    if (options.sessionId) recorder.setAttribute(rootId, 'session.id', options.sessionId);
    // 归因标签（R8-P4）：labels.* 落 run 根（trace 侧无基数问题；进 metrics 是
    // metricsSink 的 labelKeys 那道显式开关 —— 两套纪律在各自的注释里互相指）
    if (options.labels) {
      for (const [k, v] of Object.entries(options.labels)) {
        recorder.setAttribute(rootId, `labels.${k}`, v);
      }
    }
    // 入站链路（spec §9.2 跨进程关联）：把「谁触发了这次 run」记成 run 根的一条 link。
    // 与 `traceId == runId` 共存 —— 上游是被**链接**而不是被继承成父 span，所以本 run
    // 的树永远自洽（上游采样掉/已结束都不影响），因果关系仍然可查。见 core/trace.ts。
    if (options.traceContext) {
      recorder.addLink(rootId, {
        traceId: options.traceContext.traceId,
        ...(options.traceContext.spanId ? { spanId: options.traceContext.spanId } : {}),
      });
    }
    // 菜单版本化（R8 候选 3）：名字清单（人读、有界）+ 摘要（比对）。
    // 与 `prompts.versions` 同一动机 —— 质量回归要能定位到具体菜单版本；摘要覆盖 schema，
    // 所以「工具还在、签名变了」也算漂移。**只在 run 根记**：子循环走 `runAgentScoped`
    // （不开 run 根、不设根属性），所以不会把子菜单覆写到根上。
    if (options.tools && options.tools.length > 0) {
      const { names, hash } = menuSignature(options.tools);
      recorder.setAttribute(rootId, 'tools.names', names);
      recorder.setAttribute(rootId, 'tools.menuHash', hash);
    }
    // 生效配置快照（G3）：本 run 真正用着的旋钮写进 run 根 —— 事后能回答
    // 「这条 run 的 maxCostUsd 设了没 / 重试几次」，换参数前后的对比才有据可查。
    // 只记可序列化标量；函数型选项（summarize / estimateTokens）不记内容。
    for (const [k, v] of Object.entries(runConfigSnapshot(options)))
      recorder.setAttribute(rootId, k, v);

    // fallback 链（R8-P2）在这里解析 + 校验：坏环 / 死 client（持久化反序列化的空壳）
    // 是调用方的配置错，必须在 run 入口响亮抛 TypeError —— 上面的 catch 只给根 span
    // 收尾就原样 rethrow，不会收成「一条失败的 run」（配置错被记成运行失败是静默降级的一种）。
    client = options.client ?? createAnthropicClient();
    model = resolveDefaultModel(options.model);
    modelChain = resolveModelChain({ model, client, fallbacks: options.fallbacks });
    // 归因标签（R8-P4）同一条入口校验纪律：配置错响亮抛，不收成失败的 run
    validateLabels(options.labels);
    // retry 数值旋钮同款（2026-10-13 深评 A1）：NaN / 负数 / 超上限在这里响亮抛 ——
    // 否则 `maxAttempts: NaN` 静默关重试、`baseDelayMs: NaN` 的 RangeError 会被退避处的
    // catch 误报成「用户取消」（各旋钮 0 的读法见 core/limits.ts 真源表）
    validateRetryOptions(options.retry);
  } catch (e) {
    recorder.end(rootId, { status: 'error', error: classifyError(e) });
    throw e;
  }

  const progress = { iterations: 0, eventsDelivered: false };
  let result: AgentLoopResult<SchemaType<S>>;
  try {
    // run 根作用域（spec §9.2 出站传播）：循环内任何地方（工具 / 子能力 / 中间件）都读得到
    // 「我正处在哪个 span」—— 更内层的作用域由 turn / skill / subagent 逐层收窄。
    // `agentName` 一并登记（G7 交接）：run 根 = 应用名，是「调用方是主 agent」时
    // `agentia.handoff.from` 的值（子 agent 会在自己的 capability 作用域里换掉它）。
    result = await withCurrentSpan(
      { traceId: recorder.traceId, spanId: rootId, agentName: rootName },
      () =>
        agentLoop<S>({
          client,
          model,
          modelChain,
          maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          system: options.system,
          messages: options.messages,
          tools: options.tools ?? [],
          recorder,
          parentSpanId: rootId,
          onText: options.onText,
          signal: options.signal,
          retry: options.retry,
          // 按 run 分叉策略实例：per-run 状态（滞回/计数缓存）不跨 run 泄漏
          contextPolicy: forkPolicyPerRun(options.contextPolicy),
          resultSchema: options.resultSchema,
          progress,
          maxTotalTokens: options.maxTotalTokens,
          maxCostUsd: options.maxCostUsd,
          toolTimeoutMs: options.toolTimeoutMs,
          maxToolConcurrency: options.maxToolConcurrency,
          maxEventChars: options.maxEventChars,
          traceContent: options.traceContent,
          priceOverrides: options.priceOverrides,
          onUnpricedModel: options.onUnpricedModel,
          approvals: options.approvals,
          events: options.events,
        }),
    );
  } catch (e) {
    // 硬写 0 会把「第 3 回合请求失败」报成「一次模型都没调」——按实际进度报
    // eventsDelivered 同期照实传：这条出口可能发生在**事件注入之后**（见 failedResult 头注）
    result = failedResult(e, progress.iterations, progress.eventsDelivered);
  }

  // suspended 不是失败：挂起段本身执行无误（「等人」不该被看板算成「失败」），
  // trace 记 ok；它与成功的区分由 stop_reason attribute 承担。
  const runStatus =
    result.stopReason === 'suspended' || isSuccessStopReason(result.stopReason) ? 'ok' : 'error';
  recorder.setAttribute(rootId, 'stop_reason', result.stopReason);
  recorder.end(rootId, { status: runStatus, ...(result.error ? { error: result.error } : {}) });
  const trace = recorder.snapshot(runStatus);
  return {
    trace,
    stopReason: result.stopReason,
    finalText: result.finalText,
    iterations: result.iterations,
    error: result.error,
    typed: result.typed,
    suspendedMessages: result.suspendedMessages,
    pendingApprovals: result.pendingApprovals,
    suspendedReason: result.suspendedReason,
    wakeAt: result.wakeAt,
    eventsDelivered: result.eventsDelivered,
  };
}

/**
 * 嵌套能力（子 agent）入口：不自开 run 根，llm.turn 挂在给定 parentSpanId 下的同一条 trace。
 * resultSchema 语义与 runAgent 一致（隐藏 submit_result → AgentLoopResult.typed），
 * 供子 agent 产出结构化结果（见 toolkit/subagent.ts 的交回逻辑）。
 */
export async function runAgentScoped<S extends JsonSchema = JsonSchema>(opts: {
  client?: ModelClient | undefined;
  system?: SystemParam | undefined;
  messages: MessageParam[];
  tools?: AgentTool[] | undefined;
  model?: string | undefined;
  maxTokens?: number | undefined;
  maxIterations?: number | undefined;
  recorder: RecorderBackend;
  parentSpanId: SpanId;
  onText?: ((delta: string) => void) | undefined;
  /** 中断信号（由发起它的能力从 ToolRunContext.signal 透传，取消能传播到子 agent） */
  signal?: AbortSignal | undefined;
  /** 模型请求重试策略（缺省开启） */
  retry?: RetryOptions | false | undefined;
  contextPolicy?: ContextPolicy | undefined;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（同 RunAgentOptions.resultSchema） */
  resultSchema?: S | undefined;
  /** 单个工具执行超时（毫秒）；同 RunAgentOptions.toolTimeoutMs */
  toolTimeoutMs?: number | undefined;
  /** 同回合并行工具上限；同 RunAgentOptions.maxToolConcurrency */
  maxToolConcurrency?: number | undefined;
  /** 事件正文截断上限；同 RunAgentOptions.maxEventChars */
  maxEventChars?: number | false | undefined;
  /** opt-in 记录 assistant 文本（R8-P3a）；同 RunAgentOptions.traceContent（由转发机制透传下来） */
  traceContent?: 'full' | undefined;
  /** 价格表覆盖（F1）：由发起它的能力从 ToolRunContext.priceOverrides 透传 */
  priceOverrides?: Record<string, ModelPricing> | undefined;
  /** 未定价模型回调（F2）：由发起它的能力透传 */
  onUnpricedModel?: ((info: { model: string; spanId: string }) => void) | undefined;
  /**
   * 成本硬管控（C1）：由发起它的能力从 ToolRunContext 透传 —— 预算是整条 run 的口径
   * （各级循环共享同一 recorder，按同一份累计账单判断），子循环每回合同样检查；
   * 子循环超限以 stopReason='budget_exceeded' 收尾，由能力层包成 is_error 回主循环，
   * 主循环回合入口的预算检查随即将整条 run 停掉。
   */
  maxTotalTokens?: number | undefined;
  /** 成本硬管控（C1）：累计成本（美元）上限；同 maxTotalTokens */
  maxCostUsd?: number | undefined;
}): Promise<AgentLoopResult<SchemaType<S>>> {
  return agentLoop<S>({
    client: opts.client ?? createAnthropicClient(),
    model: resolveDefaultModel(opts.model),
    // 不传 modelChain：子 agent 子循环**不继承**主 run 的 fallback 链（R8-P2 的有意边界 ——
    // 子循环的 model/client 由能力层显式给，跨厂商的链继承下来会让子 agent 悄悄换厂商）
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools ?? [],
    recorder: opts.recorder,
    parentSpanId: opts.parentSpanId,
    onText: opts.onText,
    signal: opts.signal,
    retry: opts.retry,
    contextPolicy: forkPolicyPerRun(opts.contextPolicy),
    resultSchema: opts.resultSchema,
    toolTimeoutMs: opts.toolTimeoutMs,
    maxToolConcurrency: opts.maxToolConcurrency,
    maxEventChars: opts.maxEventChars,
    traceContent: opts.traceContent,
    priceOverrides: opts.priceOverrides,
    onUnpricedModel: opts.onUnpricedModel,
    maxTotalTokens: opts.maxTotalTokens,
    maxCostUsd: opts.maxCostUsd,
  });
}
