import { assertMethodTarget, scanDecoratedMethods, capabilityName } from './collect.js';
import type { CapabilityDecoratorContext } from './collect.js';
import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import type { AgentTool, JsonSchema, ToolRunContext } from '../core/tool.js';
import type { SpanError } from '../core/trace.js';
import type { SystemParam, SystemTextBlock } from '../engine/types.js';
import { isSuccessStopReason } from '../engine/types.js';
import { runAgentScoped } from '../engine/loop.js';
import { forwardToolContext } from '../engine/forwarded.js';
import { currentSpan, withCurrentSpan } from '../engine/span-scope.js';
import { classifyError } from '../engine/errors.js';
import { SystemPrompt } from '../runtime/systemPrompt.js';

/**
 * Agentia —— 子 agent 能力（spec §3/§5：独立 agent 循环 + 裁剪上下文 + 隔离报告）。
 *
 * 语义（spec §5）：
 * - 子 agent = **完整独立循环**：自己的 system（role）、自己的工具、自己的 model；
 * - **裁剪上下文**：它只见「role + 主 agent 塞给它的任务」+ 自己声明的工具，
 *   主 agent 的对话历史完全不可见；
 * - **隔离报告**：它的中间往返全部不进主上下文，唯一回流主 agent 的是
 *   stop_reason=end_turn 的最终文本 —— 以 tool_result 交回（非 end_turn 则抛错 → is_error）。
 *
 * trace：子 agent 是主 trace 里的一个 `capability` span（挂在发起它的 llm.turn 下），
 * 其内部 llm.turn 递归成它的子孙 —— 见 engine/loop.ts 的 runAgentScoped。
 */
export interface SubAgentSpec {
  /** 菜单名（缺省取被装饰方法名，建议 snake_case） */
  name?: string;
  description: string;
  /** 主 agent 填给子 agent 的任务入参 schema */
  schema: JsonSchema;
  /**
   * 子 agent 自己的 system：
   * - string / SystemPrompt 实例 → 追加一行“最终输出即交回主 agent 的报告”提示；
   * - (task) => SystemParam | Promise<SystemParam> → 按任务动态拼，框架不附加（作者全权）。
   * 注意：这是裁剪上下文的源头 —— 只写子 agent 完成该任务所需的角色/约束。
   */
  system:
    | string
    | SystemPrompt
    | ((task: Record<string, unknown>) => SystemParam | Promise<SystemParam>);
  /** 子 agent 可调工具：容器 provider token 列表，或 `<token>/<能力名>` 能力级路径（只引该 provider 菜单里的单个能力）；缺省 = 无工具纯文本 */
  tools?: string[];
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  /**
   * 子 agent 的结构化结果 schema（R6）：给出后子 agent 循环追加隐藏 submit_result 工具，
   * 校验通过的结果随最终报告一起交回主 agent —— tool_result 为
   * { report: 最终文本报告, result: 结构化结果 }（模型未提交则以 result_missing 失败回主 agent）。
   */
  resultSchema?: JsonSchema;
}

export interface SubAgentCapability {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  spec: SubAgentSpec;
}

/** 方法函数 → spec（与 @Tool 同款 WeakMap 注册表，零反射） */
const subAgentSpecs = new WeakMap<Function, SubAgentSpec>();

/** 方法装饰器：登记子 agent spec。被装饰方法体不执行 —— 运行时拉起独立循环。 */
export function SubAgent(spec: SubAgentSpec) {
  return (value: Function, context: CapabilityDecoratorContext): void => {
    assertMethodTarget(context, '@SubAgent');
    subAgentSpecs.set(value, spec);
  };
}

/** 把容器实例上所有 @SubAgent 方法收集成 SubAgentCapability[]（沿原型链）。 */
export function collectSubAgents(instance: object): SubAgentCapability[] {
  return scanDecoratedMethods(instance, subAgentSpecs).map(({ key, spec }) => ({
    name: capabilityName(spec, key, '@SubAgent'),
    description: spec.description,
    inputSchema: spec.schema,
    spec,
  }));
}

const REPORT_HINT =
  '（运行提示：你运行在独立上下文，全部中间过程不外传；你的最终回复将作为报告原样交回主 agent。）';

/** 按 spec.system 解析本轮子 agent 的 system。 */
async function resolveSubSystem(
  spec: SubAgentSpec['system'],
  task: Record<string, unknown>,
): Promise<SystemParam> {
  if (typeof spec === 'function') return spec(task);
  if (spec instanceof SystemPrompt) {
    const blocks = spec.build({ cache: true }) as SystemTextBlock[];
    return [...blocks, { type: 'text', text: REPORT_HINT }];
  }
  return `${spec}\n\n${REPORT_HINT}`;
}

/**
 * 把 SubAgentCapability 变成主 agent 菜单里的 AgentTool。
 * run(input, ctx) 需要 ToolRunContext（engine 调用时必有）；手动直调会抛错提示。
 * tools 引用（整片 token / `<token>/<能力名>` 能力级路径）→ resolveTools() 由装配层给出。
 */
export function subagentToTool(
  capability: SubAgentCapability,
  resolveTools: () => AgentTool[],
): AgentTool {
  const { name, spec } = capability;
  return {
    name: capability.name,
    description: capability.description,
    inputSchema: capability.inputSchema,
    run: async (input: unknown, ctx?: ToolRunContext): Promise<unknown> => {
      if (!ctx) {
        throw new Error(
          `subagent "${name}" 只能在主 agent 运行中被调用（engine 会注入 ToolRunContext）`,
        );
      }
      const recorder = ctx.recorder;
      const capabilityId = recorder.begin('capability', name, ctx.parentSpanId);
      recorder.setAttribute(capabilityId, 'subagent', name);
      // G7 交接：这条 capability span 就是「agent → agent 的交接」本身，故把两端都写上
      // （`agentia.handoff.from` / `.to`）。调用方名字只能从**当前调用期作用域**拿 ——
      // 手上其余的东西（`recorder` 只写不读、`ctx.parentSpanId` 是个查不出名字的 id）
      // 都推不出它，见 `engine/span-scope.ts` 的 `SpanScope.agentName`。
      // ⚠️ 必须在进入自己的 capability 作用域**之前**读：之后 currentSpan() 指向的就是自己了。
      // 作用域里没有 agentName（如宿主手搓 recorder 直调）⇒ **不发这两个键**，不编造。
      const callerAgent = currentSpan()?.agentName;
      if (callerAgent !== undefined) {
        recorder.setAttribute(capabilityId, 'agentia.handoff.from', callerAgent);
        recorder.setAttribute(capabilityId, 'agentia.handoff.to', name);
      }
      let closed = false;
      const close = (patch: { status: 'ok' | 'error'; error?: SpanError }): void => {
        if (closed) return;
        closed = true;
        recorder.end(capabilityId, patch);
      };
      // 引擎超时「放弃等待」（toolTimeoutMs）时：capability span **立刻**以 error 收尾
      // —— trace 在 run 结束时浅拷交付，等子循环自己 settle 再关，交付的那份里这个 span
      // 永远没有 endedAt、status 停在缺省 ok（与同回合 tool.output 事件的 timeout 矛盾）。
      // 同时合成 signal 中止子循环：在飞请求被掐掉，后台不再继续烧 token。
      const onAbandoned = (): void => {
        close({
          status: 'error',
          error: {
            type: 'timeout',
            message: `subagent(${name}) 执行超时被引擎放弃等待`,
            retryable: true,
          },
        });
      };
      ctx.abandoned?.addEventListener('abort', onAbandoned, { once: true });
      const combined = combineSignals(ctx.signal, ctx.abandoned);

      try {
        const raw: unknown = input ?? {};
        const task: Record<string, unknown> =
          typeof raw === 'string' ? { task: raw } : (raw as Record<string, unknown>);
        // 调用期 span 作用域（spec §9.2 出站传播）：子 agent 自己的东西都算在它的
        // capability span 下 —— `system` 若是函数形态，那次调用也是**用户代码**，同样在域内。
        const system = await withCurrentSpan(
          { traceId: recorder.traceId, spanId: capabilityId, agentName: name },
          () => resolveSubSystem(spec.system, task),
        );
        const tools = spec.tools?.length ? resolveTools() : [];

        const loop = await withCurrentSpan(
          // `agentName` 换成自己（G7 交接）：这之后所有内层调用（含它再拉起子 agent）
          // 读到的「调用方」都是**本子 agent**，正是交接关系该有的样子。
          { traceId: recorder.traceId, spanId: capabilityId, agentName: name },
          () =>
            runAgentScoped({
              // 七个「必须往下交」的旋钮一次取自单源（见 engine/forwarded.ts）——
              // 手写清单的代价是**静默**漏字段，历史事故就是 toolTimeoutMs 跨三层没人发现。
              ...forwardToolContext(ctx),
              client: ctx.client,
              model: spec.model,
              maxTokens: spec.maxTokens,
              maxIterations: spec.maxIterations,
              system,
              messages: [{ role: 'user', content: JSON.stringify(task) }],
              tools,
              recorder,
              parentSpanId: capabilityId,
              // 唯一需要**覆盖**的一项：子循环除了本 run 的取消，还要能被「放弃等待」打断
              // （见 engine/forwarded.ts 文件头对 combineSignals 的说明）
              signal: combined,
              resultSchema: spec.resultSchema,
            }),
        );
        recorder.setAttribute(capabilityId, 'stop_reason', loop.stopReason);

        if (isSuccessStopReason(loop.stopReason)) {
          close({ status: 'ok' });
          // 隔离报告：默认只回最终文本。子 agent 提交了结构化结果（resultSchema +
          // submit_result 校验通过）时，连同报告以结构化 tool_result 交回 —— engine 会把
          // 该对象 JSON.stringify 进 tool_result，report 字段在前保持可读性，主 agent
          // 既可读报告也可直接取 result 做后续结构化处理。
          if (loop.typed !== undefined) {
            return { report: loop.finalText, result: loop.typed };
          }
          return loop.finalText;
        }
        // 子 agent 没正常收尾 → 作为可重试语义的失败回主 agent（is_error）
        const report = `subagent(${name}) ${loop.stopReason}: ${(
          loop.finalText || loop.error?.message || ''
        ).slice(0, 2000)}`;
        const error: SpanError = loop.error ?? {
          type: 'agent_error',
          message: report,
          retryable: true,
        };
        close({ status: 'error', error });
        throw new Error(report);
      } catch (e) {
        // runAgentScoped 抛出的请求级异常（此前 capability 未关）在此兜底标记
        close({ status: 'error', error: classifyError(e) });
        throw e;
      } finally {
        // 摘除监听：宿主级共享 signal（ctx.signal）是长寿的，不摘会按调用次数累积
        ctx.abandoned?.removeEventListener('abort', onAbandoned);
        releaseCombinedSignal(combined);
      }
    },
  };
}
