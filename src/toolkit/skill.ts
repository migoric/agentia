import { assertMethodTarget, scanDecoratedMethods, capabilityName } from './collect.js';
import type { CapabilityDecoratorContext } from './collect.js';
import type { MessageParam } from '../core/message.js';
import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import type { AgentTool, CapabilityMetadata, JsonSchema, ToolRunContext } from '../core/tool.js';
import type { SpanError } from '../core/trace.js';
import type { AgentStopReason } from '../engine/types.js';
import { isSuccessStopReason } from '../engine/types.js';
import { runAgentScoped } from '../engine/loop.js';
import { forwardToolContext } from '../engine/forwarded.js';
import { withCurrentSpan } from '../engine/span-scope.js';
import { classifyError } from '../engine/errors.js';
import { SystemPrompt } from '../runtime/systemPrompt.js';

/**
 * Agentia —— Skill 能力（spec §3：指令 + 脚本，受限子运行，回产物/结论）。
 *
 * 与 @SubAgent 的可感知区别：
 * - 子 agent = **模型自主循环**：你只给 role/任务/工具，走几步、何时停由模型决定；
 * - Skill     = **代码控制的流程**：方法体是确定性脚本，把“要不要调模型、调几次、
 *   拿结果怎么算”写死在代码里 —— 模型调用只在你显式 `ctx.llm()` 时发生（受限子运行），
 *   每次都在 skill 自己的 `capability` span 下开 llm.turn 记账，中间结果可继续加工，
 *   方法返回值即产物/结论，以 tool_result 交回主 agent。
 *
 * trace：skill = 主 trace 里一个 `capability` span（attribute `skill`），内部 ctx.llm() 的
 * llm.turn 递归成它的子孙 —— 与 @SubAgent 同款 parentSpanId 传播，不双开 run 根。
 */
export interface SkillSpec {
  /** 菜单名（缺省取被装饰方法名，建议 snake_case） */
  name?: string;
  description: string;
  /** 主 agent 填给 skill 的结构化入参 schema；缺省空对象（无入参） */
  schema?: JsonSchema;
  /** ctx.llm() 缺省模型；不给走 engine 缺省（AGENTIA_MODEL / claude-opus-5） */
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  /** skill 内 ctx.llm() 可调工具：容器 provider token 列表，或 `<token>/<能力名>` 能力级路径（只引该 provider 菜单里的单个能力）；缺省 = 无工具纯文本 */
  tools?: string[];
  /** 团队协作元数据：owner / 契约版本 / 风险 / 副作用幂等性 */
  metadata?: CapabilityMetadata;
}

export interface SkillLlmOptions {
  /** 二选一：直接给 prompt（包成单条 user），或给完整 messages */
  prompt?: string;
  messages?: MessageParam[];
  /** 本次受限子运行的系统提示；SystemPrompt 实例自动打缓存 breakpoint */
  system?: string | SystemPrompt;
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
}

export interface SkillLlmResult {
  /** 子运行最终文本 */
  text: string;
  stopReason: AgentStopReason;
}

/** 方法体收到的运行句柄：只暴露“受限模型调用”，其余脚本逻辑由作者代码控制。 */
export interface SkillContext {
  /** 本次 skill 的缺省模型（spec.model 或 undefined → engine 缺省） */
  readonly model?: string | undefined;
  /** 受限子运行：每次调用在 skill capability span 下开一轮独立 agent 循环（无工具则纯文本）。 */
  llm(opts: SkillLlmOptions): Promise<SkillLlmResult>;
}

export interface SkillCapability {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  spec: SkillSpec;
  /** 内部：绑定 instance 的方法执行器（装饰时拿到 this，供 skillToTool 调用） */
  invoke: (input: unknown, skillCtx: SkillContext) => unknown | Promise<unknown>;
}

/** 方法函数 → spec（与 @Tool 同款 WeakMap 注册表，零反射） */
const skillSpecs = new WeakMap<Function, SkillSpec>();

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** 方法装饰器：登记 skill spec。被装饰方法体由运行时以 (input, skillCtx) 调用。 */
export function Skill(spec: SkillSpec) {
  return (value: Function, context: CapabilityDecoratorContext): void => {
    assertMethodTarget(context, '@Skill');
    skillSpecs.set(value, spec);
  };
}

/** 把容器实例上所有 @Skill 方法收集成 SkillCapability[]（沿原型链）。 */
export function collectSkills(instance: object): SkillCapability[] {
  // 动态查表而非捕获 fn：子类「未装饰地 override」时 spec 继承自父类，
  // 实现必须取实例上的（与 @Tool 的 run 同款），否则子类 override 被静默绕过。
  const inst = instance as Record<string | symbol, unknown>;
  return scanDecoratedMethods(instance, skillSpecs).map(({ key, spec }) => ({
    name: capabilityName(spec, key, '@Skill'),
    description: spec.description,
    inputSchema: spec.schema ?? EMPTY_SCHEMA,
    spec,
    invoke: (input: unknown, skillCtx: SkillContext) =>
      Reflect.apply(inst[key] as Function, instance, [input, skillCtx]),
  }));
}

/**
 * 把 SkillCapability 变成主 agent 菜单里的 AgentTool。
 * run(input, ctx) 需要 ToolRunContext（engine 调用时必有）；手动直调会抛错提示。
 * 开 `capability` span → 构造 SkillContext（llm 闭包挂 capability 下）→ 执行方法体 →
 * 返回值字符串化交回；抛错关 capability error 后重抛（引擎包成 is_error，不中断 run）。
 */
export function skillToTool(
  capability: SkillCapability,
  resolveTools: () => AgentTool[],
): AgentTool {
  const { name, spec } = capability;
  return {
    name,
    description: spec.description,
    inputSchema: capability.inputSchema,
    capability: 'skill',
    ...(spec.metadata ? { metadata: spec.metadata } : {}),
    run: async (input: unknown, ctx?: ToolRunContext): Promise<unknown> => {
      if (!ctx) {
        throw new Error(
          `skill "${name}" 只能在主 agent 运行中被调用（engine 会注入 ToolRunContext）`,
        );
      }
      const recorder = ctx.recorder;
      const capabilityId = recorder.begin('capability', name, ctx.parentSpanId);
      recorder.setAttribute(capabilityId, 'skill', name);
      let closed = false;
      const close = (patch: { status: 'ok' | 'error'; error?: SpanError }): void => {
        if (closed) return;
        closed = true;
        recorder.end(capabilityId, patch);
      };
      // 引擎超时「放弃等待」（toolTimeoutMs）时：span 立刻以 error 收尾 + 中止子循环
      // （与 subagent.ts 同款：trace 交付是浅拷，迟到的 close 进不了已交付的 trace；
      // 不中止的话子循环在后台继续烧 token，且不进任何观测面）。
      const onAbandoned = (): void => {
        close({
          status: 'error',
          error: {
            type: 'timeout',
            message: `skill(${name}) 执行超时被引擎放弃等待`,
            retryable: true,
          },
        });
      };
      ctx.abandoned?.addEventListener('abort', onAbandoned, { once: true });
      const combined = combineSignals(ctx.signal, ctx.abandoned);
      // llm 子运行失败的丰富错误（type/retryable 比通用 Error 信息量大）先存在这里，
      // 由外层 catch 兜底时取用 —— **不在 llm 闭包里直接 close**：方法体是用户代码，
      // 可以 try/catch 掉 llm 失败再继续（降级路径），提前 close 会把一次整体成功的
      // 调用永久误标成 error（close 幂等，ok 再也写不进去）。
      let llmError: SpanError | undefined;
      // 与 llmError **同点赋值**：记录 llm 闭包实际抛出的错误对象本身。外层 catch 按
      // **引用相等**判定「这次冒上来的是不是那次 llm 失败」—— 方法体 catch 掉 llm 失败
      // （降级）后又因**别的原因**抛错时，e !== llmThrew ⇒ 回落 classifyError(e)，
      // 不会拿残留的 llmError 给无关异常贴错标签（type/retryable 全错、真实分类被丢弃）。
      // 不能用「调用前重置」：那会把主路径（方法体不 catch）的 llmError 一并清掉。
      let llmThrew: unknown;

      const skillCtx: SkillContext = {
        model: spec.model,
        llm: async (opts) => {
          const messages =
            opts.prompt != null
              ? [{ role: 'user' as const, content: opts.prompt }]
              : (opts.messages ?? []);
          if (messages.length === 0) {
            throw new Error(`skill "${name}".llm 需要 prompt 或 messages`);
          }
          const system =
            opts.system instanceof SystemPrompt ? opts.system.build({ cache: true }) : opts.system;
          const loop = await runAgentScoped({
            // 七个「必须往下交」的旋钮一次取自单源（见 engine/forwarded.ts）—— 与 subagent.ts 同源
            ...forwardToolContext(ctx),
            client: ctx.client,
            model: opts.model ?? spec.model,
            maxTokens: opts.maxTokens ?? spec.maxTokens,
            maxIterations: opts.maxIterations ?? spec.maxIterations,
            system,
            messages,
            tools: spec.tools?.length ? resolveTools() : [],
            recorder,
            parentSpanId: capabilityId,
            // 唯一需要**覆盖**的一项：同 subagent.ts（子循环还要能被「放弃等待」打断）
            signal: combined,
          });
          if (!isSuccessStopReason(loop.stopReason)) {
            const report = `skill "${name}".llm ${loop.stopReason}: ${(
              loop.finalText || loop.error?.message || ''
            ).slice(0, 2000)}`;
            // 丰富错误（type/retryable）存起来交给外层 catch 收尾，**不在这里 close** ——
            // 用户方法体可以 catch 掉这次失败并降级继续，提前 close 会把一次整体成功的
            // 调用永久误标成 error（幂等守卫会让后来的 ok 写不进去）。
            llmError = loop.error ?? {
              type: 'agent_error',
              message: report,
              retryable: true,
            };
            const failure = new Error(report);
            llmThrew = failure; // 与 llmError 同点赋值：外层 catch 按引用相等认领
            throw failure;
          }
          return { text: loop.finalText, stopReason: loop.stopReason };
        },
      };

      try {
        // 调用期 span 作用域（spec §9.2 出站传播）：方法体里 `currentTraceparent()` 指向
        // **本次 skill 的 capability span**（不是发起它的那个 llm.turn）—— 粒度落到能力调用。
        const out = await withCurrentSpan({ traceId: recorder.traceId, spanId: capabilityId }, () =>
          capability.invoke(input ?? {}, skillCtx),
        );
        close({ status: 'ok' });
        return out;
      } catch (e) {
        // 引用相等认领：冒上来的是 llm 闭包抛的那个对象 ⇒ 用它的丰富错误收尾；
        // 否则（方法体降级后又因别的原因抛错）按真实异常分类 —— 不拿残留 llmError 贴错标签
        close({ status: 'error', error: e === llmThrew ? llmError! : classifyError(e) });
        throw e;
      } finally {
        // 摘除监听：宿主级共享 signal 是长寿的，不摘会按调用次数累积
        ctx.abandoned?.removeEventListener('abort', onAbandoned);
        releaseCombinedSignal(combined);
      }
    },
  };
}
