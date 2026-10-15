import type { MessageParam } from '../core/message.js';
import type { AgentTool, JsonSchema, ModelPricing, SchemaType } from '../core/tool.js';
import type { ModelFallbackLink, SystemParam } from '../engine/types.js';
import { SystemPrompt } from '../runtime/systemPrompt.js';
import { executeRun } from '../runtime/run.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import type { SessionStore } from '../runtime/session.js';
import type { MemoryStore } from '../runtime/memory.js';
import type { AgentRunResult } from '../engine/types.js';
import { composeTraceEvents } from '../core/trace.js';
import type { Trace, TraceRecordEvent, TraceSink } from '../core/trace.js';
import type { TraceLimits } from '../engine/tracer.js';
import { Container } from '../container/container.js';
import type { Provider, Token } from '../container/container.js';
import type { BlackboardKey } from '../core/blackboard.js';
import { omitUndefined } from '../core/object.js';
import { discoverProviders } from './discover.js';
import {
  buildCapabilitySlice,
  capabilityCount,
  capabilityToolNames,
  capabilityVersions,
  collectCapabilities,
} from './capability-slice.js';
import type { CollectedByKind } from './capability-slice.js';
import { applyMiddleware } from './middleware.js';
import type { CapabilityMiddleware } from './middleware.js';
import { buildCapabilityGraph, findCapabilityCycle } from './capability-cycles.js';
import type { CapabilityRefInput } from './capability-cycles.js';
import type { ContextPolicy } from '../engine/types.js';
import type { RetryOptions } from '../engine/retry.js';

/**
 * 能力包（roadmap R5）：第三方包把「能力 providers + 中间件」打包成 AgentModule 分发，
 * 应用侧经 AppOptions.modules 一次性装配。模块的 providers 先于应用级 providers 注册
 *（同 token 应用级覆盖模块级）；中间件拼接顺序同样模块在前。
 */
export interface AgentModule {
  /** 模块携带的 DI providers（能力类 / 值 / 工厂） */
  providers: Provider[];
  /** 模块级能力调用中间件（拼在应用级 middleware 之前，即更外层） */
  middleware?: CapabilityMiddleware[];
}

/** 定义能力包：identity 函数，仅给第三方包一个类型锚点与导出约定 */
export function defineModule(m: AgentModule): AgentModule {
  return m;
}

const defaultSinks: TraceSink[] = [];

/** 注册全局默认 trace sink（观测 / dev 工具用）。createApp 构造期快照合并，已建应用不受后续注册影响。 */
export function registerDefaultTraceSink(sink: TraceSink): void {
  defaultSinks.push(sink);
}

/**
 * 子菜单重名查重（2026-10-13，装配期纯件，与 capability-cycles.ts 同款纪律）：
 * @SubAgent / @Skill 的 `tools` 引用展开结果与主菜单受同一条「模型 API 要求工具名唯一」
 * 约束 —— 主菜单查重只管 sources 合并后的主菜单，子菜单是运行期展开的，两个 provider
 * 各有同名能力被同一能力整片引用时，不在这里拦就会以 API 400 在运行期显形。
 *
 * 逐引用片展开（不调 resolveRefTools 的整体 thunk）：报错要带**引用片**来源，
 * 整体展开会把来源信息丢掉。同一 provider 内部的重名（两个方法同显式 name、且该
 * provider 被 toolSources 收窄逃过主菜单查重）同样被网住（报成「来自 "p" + "p"」）。
 *
 * `sliceOf` = 「token → 中间件包装后的该 provider 菜单」（wrappedByToken 的读法）。
 */
function assertNoSubmenuDuplicate(
  providers: readonly Provider[],
  collectedByToken: ReadonlyMap<Token, CollectedByKind>,
  sliceOf: (token: Token) => AgentTool[],
): void {
  for (const p of providers) {
    const collected = collectedByToken.get(p.provide);
    if (collected === undefined) continue;
    const nestedOwners: Array<{ label: string; refs: string[] }> = [
      ...collected.subagent.map((c) => ({
        label: `@SubAgent "${c.name}"`,
        refs: c.spec.tools ?? [],
      })),
      ...collected.skill.map((c) => ({
        label: `@Skill "${c.name}"`,
        refs: c.spec.tools ?? [],
      })),
    ];
    for (const { label, refs } of nestedOwners) {
      if (refs.length === 0) continue;
      // 能力名 → 提供它的引用片（同一 ref 写重也算，那同样是重名进菜单）
      const originsByName = new Map<string, string[]>();
      for (const ref of refs) {
        const slash = ref.indexOf('/');
        const token = slash === -1 ? ref : ref.slice(0, slash);
        const refName = slash === -1 ? undefined : ref.slice(slash + 1);
        const wrapped = sliceOf(token);
        const slice = refName === undefined ? wrapped : wrapped.filter((t) => t.name === refName);
        for (const t of slice) {
          const origins = originsByName.get(t.name);
          if (origins === undefined) originsByName.set(t.name, [ref]);
          else origins.push(ref);
        }
      }
      const dups = [...originsByName.entries()].filter(([, origins]) => origins.length > 1);
      if (dups.length > 0) {
        const detail = dups
          .map(([n, origins]) => `"${n}"（来自 ${origins.map((r) => `"${r}"`).join(' + ')}）`)
          .join(', ');
        throw new Error(
          `子菜单能力重名：${label} 的 tools 引用展开后 ${detail} —— ` +
            '子 agent / skill 的菜单与主菜单受同一条「模型 API 要求工具名唯一」约束；' +
            '请改用能力级路径（<token>/<能力名>）收窄引用，或给能力改名',
        );
      }
    }
  }
}

export interface AppOptions {
  /** 应用名；同时作为 run 名写入 trace */
  name?: string;
  /** DI providers：值 / 类 / 工厂；与 discover 可混用（同 token 后者覆盖） */
  providers?: Provider[];
  /** 能力包：providers 并入（在 providers 之前注册）、middleware 拼接（在 middleware 之前） */
  modules?: AgentModule[];
  /**
   * 能力目录发现：`<目录>/<name>/index.ts` 约定（一能力一文件夹）。
   * 给**一个目录**或**一组目录**（数组顺序即装配顺序）——典型布局是四分类目录
   * `src/tools` / `src/skills` / `src/prompts` / `src/subagents`。
   * 启动期扫描装配；因动态 import，带 discover 的 createApp 返回 Promise<AgentApp>。
   */
  discover?: string | string[];
  /** 主 agent system：SystemPrompt 实例（自动打缓存）或拼好的 SystemParam */
  system: SystemPrompt | SystemParam;
  /** 缺省模型；不给则走 engine 默认（claude-opus-5） */
  model?: string;
  /** 缺省模型 fallback 链（可被单次 run 覆盖）；见 `RunAgentOptions.fallbacks`（R8-P2） */
  fallbacks?: ModelFallbackLink[];
  /** 缺省记录 assistant 文本进 trace（`'full'`；可被单次 run 覆盖）；见 `RunAgentOptions.traceContent`（R8-P3a） */
  traceContent?: 'full';
  /** 缺省归因标签（可被单次 run 覆盖 —— 注意是**整体替换**不是合并）；见 `RunAgentOptions.labels`（R8-P4） */
  labels?: Record<string, string>;
  /** 缺省 maxTokens（流式给足避免中途截断） */
  maxTokens?: number;
  /** 缺省循环上限 */
  maxIterations?: number;
  /** 缺省上下文预算策略（compaction / context editing） */
  contextPolicy?: ContextPolicy;
  /** 缺省模型请求重试策略（可被单次 run 覆盖）；见 RunAgentOptions.retry */
  retry?: RetryOptions | false;
  /** 缺省成本硬管控：整条 run 累计 token 上限（可被单次 run 覆盖） */
  maxTotalTokens?: number;
  /** 缺省成本硬管控：累计成本（美元）上限（可被单次 run 覆盖） */
  maxCostUsd?: number;
  /**
   * 价格表覆盖/追加（$/1M tokens，可被单次 run 覆盖）；见 `RunAgentOptions.priceOverrides`。
   * 给非 Anthropic 端点（DeepSeek / 自建）定价，否则 `maxCostUsd` 会静默不生效。
   */
  priceOverrides?: Record<string, ModelPricing>;
  /** 未定价模型回调（可被单次 run 覆盖）；见 `RunAgentOptions.onUnpricedModel` */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
  /** 缺省单个工具执行超时（毫秒，可被单次 run 覆盖）；0/不设 = 不限 */
  toolTimeoutMs?: number;
  /** 缺省同回合并行工具上限（可被单次 run 覆盖）；不设 = 不限 */
  maxToolConcurrency?: number;
  /**
   * 缺省 trace 事件正文截断上限（可被单次 run 覆盖）；不设 = 框架缺省
   * （入参/成功出参 2000、失败出参 1000），`false` = 不截断。
   * 调试期在应用级开一次 `false`，不必每个调用点重复传。见 `RunAgentOptions.maxEventChars`。
   */
  maxEventChars?: number | false;
  /** 只收集这些 token 的 provider 上的能力（@Tool / @SubAgent / @Skill / @Prompt 四类同样收窄）；缺省扫全部 providers */
  toolSources?: Token[];
  /**
   * 直接追加到主菜单的**裸工具**（`AgentTool[]`）—— 给「构造期才知道有哪些工具」的场景
   * （典型：MCP 桥 `mcpTools()` 的返回值，见 integrations/mcp.ts）。
   *
   * 与装饰器收集来的能力**完全同等**：同样过中间件链、同样进重名查重、同样受
   * `toolSources` 之外的一切装配规则约束（不受 `toolSources` 收窄影响 —— 这是显式追加）。
   * 不经装饰器、不进 DI 容器（它没有 provider token，也不是任何能力的 tools 引用目标）。
   */
  tools?: AgentTool[];
  /** 能力调用中间件（洋葱模型，链序 = 注册顺序）；装配期包裹整个菜单 */
  middleware?: CapabilityMiddleware[];
  /** trace 出口（观测）：每次 run 收尾投递；与全局默认 sink 合并（本字段在前） */
  sinks?: TraceSink[];
  /**
   * **增量记账出口的缺省值**（观测）：每次 run **进行中**逐笔回调 —— 见
   * `RunInvocationOptions.onTraceEvent`。
   *
   * ⚠️ 与 per-run 的那个是**叠加**关系（应用级在前），**不是覆盖**：它是「观察者注册」
   * 而不是「值覆盖」（同 `sinks`：应用级与全局默认 sink 一起收）。per-run 给了回调就顶掉
   * 应用级那个的话，宿主在某次 run 顺手传一个面板回调，就会让应用级那条静默失聪 ——
   * 那是可观测性的**静默回退**（本仓最忌讳的那类）。
   *
   * 与 `sinks` 的分工：`sinks` 是「收尾拿整棵」（落库 / 导出 / 指标），本项是
   * 「运行期逐笔」（进度流 / 面板）。两者可以同时配，互不影响。
   *
   * ⚠️ 载荷只读：增量事件的载荷与最终交付的 trace **共享引用**（浅拷 —— 事件的
   * `body`、`span.end` 的 `error` / `usage` 等与 trace 里是同一个对象）。订阅者
   * **不得变异载荷**：改了它就等于改了落库 / 导出的那份 trace。
   */
  onTraceEvent?: (e: TraceRecordEvent) => void;
  /**
   * 记账的数量上限的缺省值（spec §9.4）：见 `RunInvocationOptions.traceLimits`。
   * 单次 run 给了自己的就以单次为准（这是个**值**，不是观察者 —— 与 onTraceEvent 的叠加语义相反）。
   */
  traceLimits?: TraceLimits;
}

/** 单次调用参数 = 通用调用参数 + 单次可覆盖 system（spec.ts 的 RunInvocationOptions 为单源） */
export interface RunAppOptions<S extends JsonSchema = JsonSchema> extends RunInvocationOptions {
  /** 单次覆盖 system（volatile 段建议每 run 重建以拾取最新值） */
  system?: SystemPrompt | SystemParam;
  /**
   * 结构化结果 schema（R2）：语义同 `RunAgentOptions.resultSchema`（engine 追加隐藏
   * submit_result 工具，校验通过的结果写入 `result.typed`）。
   * 传 `fromZod<T>(...)` 时 `app.run` 的返回类型自动带上 `typed: T | undefined`。
   */
  resultSchema?: S;
  /**
   * 会话持久化（C4）：语义同 `ExecuteRunOptions.session` —— run 开始把历史拼在传入
   * messages 之前，成功收尾把本轮消息 + 回复追加回去。与 `blackboard`（键值黑板）正交。
   *
   * 只在程序内直接 `app.run` 时可用（store 实例不可序列化）。**异步宿主**的会话走
   * `RunInvocationOptions.sessionId` + `AsyncRunner` 的 `sessionStore` —— 任务里只落
   * 可序列化的 id，store 实例由 runner 持有、执行前注入（重启续跑也接得上）。
   */
  session?: { store: SessionStore; id: string };
  /**
   * 跨 run 记忆（R4）：语义同 `ExecuteRunOptions.memory` —— run 开始把
   * `store.load(keys)` 水合进 blackboard（用户种子优先，同名 key 不被覆盖），
   * 收尾（成功/失败两条路径）把这些 key 的当前值写回。
   *
   * 与 `session`（对话历史）正交，可同时用；边界也与它相同：只在程序内直接
   * `app.run` 时可用（store 实例不可序列化，因此**不在** transport 的
   * `RunInvocationOptions` 里 —— 异步宿主不会替你传它）。
   */
  memory?: { store: MemoryStore; keys: string[] };
  /**
   * 未定价模型回调（单次覆盖应用级）；见 `RunAgentOptions.onUnpricedModel`。
   * 是函数，因此**不在** transport 的 `RunInvocationOptions` 里（异步宿主不替你传）。
   */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
  /**
   * trace 交给 sinks 之前的最后一笔账（R7 时序缝）：语义同 `ExecuteRunOptions.beforeFlush`
   * —— `run.finish` 之后、`flushSinks` 之前调一次，用于挂上**拿到 run 结果才判得出**的结论。
   * 典型（也是框架内唯一的）使用者是 `defineEval`：它的 score 必须在这个时点挂上，
   * 否则 `metricsSink` 聚合时还看不到，eval 的通过率就进不了指标。
   *
   * 是函数，因此**不在** transport 的 `RunInvocationOptions` 里（异步宿主不替你传）。
   */
  beforeFlush?: (trace: Trace, result: AgentRunResult<SchemaType<S>>) => void | Promise<void>;
}

export interface AgentRunOutput<T = unknown> {
  run: import('../runtime/run.js').Run;
  result: AgentRunResult<T>;
}

/**
 * Agentia —— 应用装配（spec §4/§6：主 agent + 可调工具菜单）。
 *
 * createApp 组装：DI 容器注册 providers（手动和/或 discover 目录发现）→
 * 从容器实例自动扫描 @Tool / @SubAgent / @Skill / @Prompt 收集成本 app 的工具菜单
 * → agent.run(messages) 带着菜单走 executeRun。装配期统一静态校验（§7）：
 * 菜单查重、tools 引用存在性、toolSources 指向。
 * 主 agent 的 system 可由 SystemPrompt 实例给出（内部 build({cache:true})
 * 打稳定前缀 breakpoint），也接受已拼好的 SystemParam 原样透传。
 */
export class AgentApp {
  readonly name: string;
  private readonly di: Container;
  private readonly system: SystemPrompt | SystemParam;
  private readonly base: {
    model?: string | undefined;
    fallbacks?: ModelFallbackLink[] | undefined;
    traceContent?: 'full' | undefined;
    labels?: Record<string, string> | undefined;
    maxTokens?: number | undefined;
    maxIterations?: number | undefined;
    contextPolicy?: ContextPolicy | undefined;
    retry?: RetryOptions | false | undefined;
    maxTotalTokens?: number | undefined;
    maxCostUsd?: number | undefined;
    priceOverrides?: Record<string, ModelPricing> | undefined;
    onUnpricedModel?: ((info: { model: string; spanId: string }) => void) | undefined;
    toolTimeoutMs?: number | undefined;
    maxToolConcurrency?: number | undefined;
    maxEventChars?: number | false | undefined;
    traceLimits?: TraceLimits | undefined;
  };
  private _tools: AgentTool[] = [];
  /**
   * 装配期收集的 @Prompt 资产版本表（{ 最终菜单名: 版本 }，R7 质量闭环）：
   * 与 this._tools 同一条收集路径（toolSources 收窄同样生效）；run() 固定传给
   * engine 落 run 根 span 的 `prompts.versions`。菜单里没有任何带版本的 @Prompt 时为 undefined。
   */
  private readonly promptVersions: Record<string, string> | undefined;
  private readonly sinks: TraceSink[];
  /**
   * 增量记账出口的应用级缺省：与 per-run 的那个是**叠加**关系（应用级在前，
   * run() 里 composeTraceEvents 合成），**不是覆盖** —— 见 AppOptions.onTraceEvent
   */
  private readonly onTraceEvent: ((e: TraceRecordEvent) => void) | undefined;
  /** 装配期那条中间件链的包裹函数：主菜单构造期已包好；per-run tools 覆盖在 run() 里现包 */
  private readonly wrapTools: (tools: AgentTool[]) => AgentTool[];

  constructor(opts: AppOptions) {
    this.name = opts.name ?? 'app';
    const modules = opts.modules ?? [];
    const explicitProviders = opts.providers ?? [];
    // 同 token 去重（后注册覆盖先注册，与 Container.register 语义一致）——
    // 模块 providers 在前、应用级 providers 在后：应用级可覆盖模块级同 token；
    // providers 与 discover 混用/重复给出同一 token 时不会重复收集菜单。
    //
    // ⚠️ **但显式侧的重复要出声**（2026-10-16 ref-di-dup-loud）：「后注册覆盖先注册」
    // 是容器语义，不是警告语义 —— 而真实工程里最易撞的是「同一份值被声明两次」：
    // `discover` 扫出来的与 `registry.ts` / 应用级手写的各给一份 `WORKDIR`，谁生效取决于
    // 拼接顺序，且此前**零信号**（表现是「面板上改了工作目录却没生效」）。
    // 模块级 → 应用级那条覆盖是**设计好的**（应用覆盖模块缺省），故不告警 —— 只比对
    // `providers` 这一条数组（它含 `createApp` 已并入的 discover 结果，见 `warnDuplicateTokens`）。
    warnDuplicateTokens(explicitProviders);
    const providerList = [
      ...new Map(
        [...modules.flatMap((m) => m.providers), ...explicitProviders].map((p) => [p.provide, p]),
      ).values(),
    ];
    this.di = new Container().register(...providerList);
    this.system = opts.system;
    // trace 出口：应用级 sinks 在前，全局默认 sink 在后（构造期快照，注册表后续变化不影响本应用）
    this.sinks = [...(opts.sinks ?? []), ...defaultSinks];
    // 增量记账出口的应用级缺省（构造期快照，同 sinks 语义）；与 per-run 叠加
    //（应用级在前，run() 里 composeTraceEvents 合成）—— 不是覆盖
    this.onTraceEvent = opts.onTraceEvent;
    this.base = {
      model: opts.model,
      fallbacks: opts.fallbacks,
      traceContent: opts.traceContent,
      labels: opts.labels,
      maxTokens: opts.maxTokens,
      maxIterations: opts.maxIterations,
      contextPolicy: opts.contextPolicy,
      retry: opts.retry,
      maxTotalTokens: opts.maxTotalTokens,
      maxCostUsd: opts.maxCostUsd,
      priceOverrides: opts.priceOverrides,
      onUnpricedModel: opts.onUnpricedModel,
      toolTimeoutMs: opts.toolTimeoutMs,
      maxToolConcurrency: opts.maxToolConcurrency,
      maxEventChars: opts.maxEventChars,
      traceLimits: opts.traceLimits,
    };

    // 先为每个 provider 解析实例并预收集它的四类能力（@Tool / @SubAgent / @Skill / @Prompt）。
    // 「四类」这件事只活在 `capability-slice.ts` 的注册表里 —— 本文件按类**遍历**，不按类分支，
    // 所以新增第五类能力不会在这里留下一处「忘了改」的静默点（外部深评 K2）。
    // 子 agent / skill 的 tools token 在装配期即解析到该 provider 的 @Tool 菜单（静态校验）。
    const collectedByToken = new Map<Token, CollectedByKind>();
    for (const p of providerList) {
      const inst = this.di.resolve<object>(p.provide);
      collectedByToken.set(p.provide, collectCapabilities(inst));
    }

    // 能力调用中间件：装配期包裹整个菜单（洋葱模型，对 engine 零侵入）；
    // 模块级中间件在前（更外层），应用级在后。
    const middleware = [...modules.flatMap((m) => m.middleware ?? []), ...(opts.middleware ?? [])];
    const wrap = (tools: AgentTool[]): AgentTool[] =>
      middleware.length ? applyMiddleware(tools, middleware) : tools;
    this.wrapTools = wrap;

    /**
     * 中间件包装**之后**的每 provider 菜单。
     *
     * 嵌套能力（子 agent / skill）解析自身 tools 引用时必须从这里取 —— 若取
     * 「中间件包装之前的原始菜单」，子 agent 内部调用的每一个工具都会绕过中间件
     * （鉴权 / 限流 / 审计 / 结果缓存全部失效），是 spec §10 记录在案的既知问题。
     * 该 map 在 resolveRefTools 的 thunk 被真正调用（运行时）前已填充完毕。
     */
    const wrappedByToken = new Map<Token, AgentTool[]>();

    // 装配期立即解析 tools 引用（§7 启动期静态校验）：引用未注册 provider 在
    // createApp 即抛错，不延迟到模型调用该能力的运行时。实际取值延迟到运行时
    // （惰性 thunk）—— 那时 wrappedByToken 已就绪。
    //
    // 引用有两种形态，混写合法：
    // - `'token'`：整片引用该 provider 的菜单（@Tool + 它的 subagent/skill/prompt 工具）；
    // - `'token/能力名'`：能力级路径，只引菜单里的单个能力。按第一个 '/' 切分
    //   （能力名经 collect 校验不含 '/'，右段必然干净；token 含 '/' 查不到，
    //   按「未注册 provider」报错即可，不特殊处理）。
    const resolveRefTools = (owner: string, refs: string[] | undefined): (() => AgentTool[]) => {
      const parsed = (refs ?? []).map((ref) => {
        const slash = ref.indexOf('/');
        return slash === -1
          ? { token: ref, name: undefined as string | undefined }
          : { token: ref.slice(0, slash), name: ref.slice(slash + 1) };
      });
      for (const { token, name } of parsed) {
        if (!collectedByToken.has(token)) {
          throw new Error(`${owner} tools 引用未注册 provider: "${token}"`);
        }
        if (name !== undefined) {
          // 可用名单 = 该 provider 收集菜单全量（@Tool 与它的 subagent/skill/prompt
          // 工具名），按名排序给出，方便作者对照改正。
          const collected = collectedByToken.get(token);
          const available = (collected === undefined ? [] : capabilityToolNames(collected)).sort();
          if (!available.includes(name)) {
            throw new Error(
              `${owner} tools 引用 "${token}" 中不存在的能力: "${name}"（可用: ${available.join(', ')}）`,
            );
          }
        }
      }
      return () =>
        parsed.flatMap(({ token, name }) => {
          const wrapped = wrappedByToken.get(token) ?? [];
          // 能力级引用按名从**包装后**的菜单 filter（见上方 wrappedByToken 记档的教训）
          // —— 中间件不得被绕过。
          return name === undefined ? wrapped : wrapped.filter((t) => t.name === name);
        });
    };

    // 一路「按类展开」：每类怎么变成工具由 `capability-slice.ts` 的注册表决定（含它的
    // 引用提示词 `@SubAgent "x"` / `@Skill "x"`），本文件不再有四路展开。
    const buildSlice = (token: Token): AgentTool[] => {
      const collected = collectedByToken.get(token);
      return collected === undefined ? [] : buildCapabilitySlice(collected, resolveRefTools);
    };

    // 全部 provider 都切片并包装：主菜单只取 sources，但被 toolSources 排除的
    // provider 上的能力仍可被其他能力的 tools 引用（引用是作者显式声明，不受收窄影响）——
    // 因此包装必须覆盖全部 provider，否则 ref 解析会拿到未包装（可绕过中间件）的工具。
    for (const p of providerList) {
      wrappedByToken.set(p.provide, wrap(buildSlice(p.provide)));
    }

    // ── 子菜单重名查重（2026-10-13）──────────────────────────────────────────────
    // @SubAgent / @Skill 的 tools 引用是**运行期**展开的（resolveTools thunk）：两个 provider
    // 各有同名能力被同一能力整片引用时，主菜单查重（下方）看不见它 —— 装配全绿，
    // 第一次模型调用才由 API 400（tool names must be unique）暴露。
    // 实现是模块级纯件 assertNoSubmenuDuplicate（与成环检测同款的装配期纯件纪律）。
    assertNoSubmenuDuplicate(
      providerList,
      collectedByToken,
      (token) => wrappedByToken.get(token) ?? [],
    );

    // ── 能力引用图成环检测（2026-09-28）────────────────────────────────────────────
    // 上面那次切片已经把**引用存在性**校验完了（未注册 provider / 不存在的能力名都在
    // `resolveRefTools` 里抛过），所以这里可以放心按 token 扇出。
    //
    // 为什么要挡成环：能力是**运行期**展开的（`subagentToTool` 的 resolveTools 是延迟 thunk，
    // `wrappedByToken` 此刻已全部建满）⇒ 一旦成环，模型点一次就是无限递归；而 `maxIterations`
    // 只限每层的**宽度**、深度没有任何闸 ⇒ 树按 宽度^深度 炸开（token 与内存双爆），
    // 且要到运行期才显形。DI 容器有环检测（`container.ts`），能力图此前没有。
    // 实现在 `capability-cycles.ts`（纯件：不碰 DI、可单独单测）。
    // ⚠️ 这里**刻意只取两类**（不遍历 CAPABILITY_KINDS）：只有 @SubAgent / @Skill 有
    // `tools` 引用，@Tool 与 @Prompt 没有「能力引用」这回事 —— 那是语义上的不对称，不是漏项
    //（同一条说明也在 capability-slice.ts 的文件头，别为了「看起来整齐」改成遍历）。
    const graphInputs: CapabilityRefInput[] = providerList.flatMap((p) => {
      const collected = collectedByToken.get(p.provide);
      if (collected === undefined) return [];
      return [
        ...collected.subagent.map((c) => ({
          token: p.provide,
          kind: 'subagent' as const,
          name: c.name,
          refs: c.spec.tools ?? [],
        })),
        ...collected.skill.map((c) => ({
          token: p.provide,
          kind: 'skill' as const,
          name: c.name,
          refs: c.spec.tools ?? [],
        })),
      ];
    });
    const cycle = findCapabilityCycle(buildCapabilityGraph(graphInputs));
    if (cycle !== undefined) {
      throw new Error(
        `能力引用成环：${cycle.map((n) => n.label).join(' → ')}。` +
          '@SubAgent / @Skill 的 tools 引用不得绕回自己 —— 递归能力没有深度闸，' +
          '模型一次自我调用就是无限递归（拆掉环，或把「递归」改成普通工具自己实现）',
      );
    }

    // toolSources 是「取哪些 provider 的能力」的白名单，同一 token 写重只该取一次：
    // 不去重则会 flatMap 收两遍该 provider 的能力，最后撞上「菜单能力重名」——
    // 报错指向能力定义（错误来源），而真正的问题是这份清单里重复写了 token。
    const sources = opts.toolSources
      ? [...new Set(opts.toolSources)]
      : providerList.map((p) => p.provide);
    // @Prompt 资产版本表（R7）：沿主菜单同一条收集路径（sources 口径，toolSources
    // 收窄同样生效）汇总各 @Prompt 的 最终菜单名→version；run() 固定传给 engine。
    const promptVersions: Record<string, string> = {};
    for (const token of sources) {
      const collected = collectedByToken.get(token);
      if (collected !== undefined) Object.assign(promptVersions, capabilityVersions(collected));
    }
    this.promptVersions = Object.keys(promptVersions).length > 0 ? promptVersions : undefined;
    this._tools = [
      ...sources.flatMap((token) => {
        if (!this.di.has(token)) {
          throw new Error(`toolSources 指向未注册 provider: "${token}"`);
        }
        return wrappedByToken.get(token) ?? [];
      }),
      // 裸工具（AppOptions.tools）：与装饰器收集来的能力同等 —— 一样过中间件、
      // 一样进下面的重名查重。**不是旁路**（旁路会绕过鉴权/限流/审计）。
      ...wrap(opts.tools ?? []),
    ];

    // §7 静态校验（最小落地）：菜单统一查重 —— 重名会让模型在歧义菜单里猜，直接报错。
    const dup = new Map<string, number>();
    for (const t of this._tools) dup.set(t.name, (dup.get(t.name) ?? 0) + 1);
    const dupNames = [...dup.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    if (dupNames.length > 0) {
      throw new Error(
        `菜单能力重名（tool/skill/subagent/prompt 共用命名空间）: ${dupNames.join(', ')}`,
      );
    }

    // 孤儿能力告警：toolSources 显式收窄时，被排除 provider 上的能力不在主菜单
    // （模型无法直接调用）；但**仍可被其他能力的 tools 引用**（引用是作者显式声明），
    // 所以只是「不在主菜单」而非「不可达」。
    if (opts.toolSources) {
      const included = new Set(opts.toolSources);
      for (const p of providerList) {
        if (included.has(p.provide)) continue;
        const collected = collectedByToken.get(p.provide);
        const orphanCount = collected === undefined ? 0 : capabilityCount(collected);
        if (orphanCount > 0) {
          console.warn(
            `[agentia] 孤儿能力告警：provider "${p.provide}" 上的 ${orphanCount} 个能力不在 toolSources 内，` +
              `不进主菜单（模型无法直接调用）；若被其他能力的 tools 引用仍可被调用`,
          );
        }
      }
    }
  }

  /** app 已装配好的工具菜单（构建期即从容器解析，静态稳定） */
  get tools(): AgentTool[] {
    return this._tools;
  }

  /** 容器访问点 */
  get container(): Container {
    return this.di;
  }

  /**
   * 执行一次主 agent run。system 每 run 从 SystemPrompt 重建，保证 volatile 新鲜。
   * 传 `resultSchema: fromZod<T>(...)` 时返回值 `result.typed` 为 `T | undefined`。
   */
  run<S extends JsonSchema = JsonSchema>(
    messages: MessageParam[],
    opts: RunAppOptions<S> = {},
  ): Promise<AgentRunOutput<SchemaType<S>>> {
    // 会话引用的出声闸（2026-10-12 ref-session-id-warn）：sessionId 是**异步宿主**的可序列化会话引用
    //（AsyncRunner 配 sessionStore 时由它在执行前换成 session 注入，见 spec.ts 该字段注释），
    // 本入口不消费它 —— 此前直传它被**静默丢弃**（run 根没有 session.id、会话历史接不上、
    // 零信号），与 0.9.5 那批「把静默换成有声」同口径，改为每条 run 告警一次。
    // 内部链路踩不到它：AsyncRunner 在 buildRunCallOptions 里已把它消费掉、不再透传
    //（见 transport/run-call-options.ts —— 续跑段不注入 session，若不剥掉会在这里误报）。
    if (opts.sessionId !== undefined && opts.session === undefined) {
      console.warn(
        '[agentia] app.run 收到了 sessionId，但它在这个入口不生效：sessionId 是给异步宿主' +
          '（AsyncRunner + sessionStore）的可序列化会话引用，程序内的 app.run 不消费它 —— ' +
          '本次 run 不会带 session.id（OTLP 的 gen_ai.conversation.id），也不接会话历史。' +
          '要会话维度 + 历史请用 session: { store, id }（见 usage-guide §4 `app.run` 选项表）；' +
          '只要 trace 标记不要历史，直连 executeRun / runAgent 的引擎级 sessionId。',
      );
    }
    const sys = opts.system ?? this.system;
    const system: SystemParam = sys instanceof SystemPrompt ? sys.build({ cache: true }) : sys;

    const seed = opts.blackboard;
    return executeRun<S>({
      system,
      messages,
      // per-run tools 覆盖与 AppOptions.tools 同语义：同样过装配期那条中间件链，**不是旁路**
      //（否则 per-run 覆盖就绕开了鉴权/限流/审计）。this._tools 构造期已包裹好（直接复用，
      // 不二次包裹）；opts.tools 是调用方给的裸菜单，此处现包一次 —— applyMiddleware 产出
      // 新数组新对象（不改写入参），与装配期结果无共享，不会双重包裹。
      tools: opts.tools ? this.wrapTools(opts.tools) : this._tools,
      runName: this.name,
      sinks: this.sinks,
      // per-run 覆盖：值为 undefined 的键**整体摘掉**再交出去。
      // 为什么：`exactOptionalPropertyTypes` 下 `{foo: x}`（x: T | undefined）不是合法的
      // `foo?: T` —— 显式 undefined 与「不传这个键」是有区别的（那正是 `retry.ts` 被
      // 显式 undefined 覆盖缺省的事故）。语义上与「不传」完全一致：引擎对这些字段
      // 一律 `?? 缺省` 取值。
      ...omitUndefined({
        model: opts.model ?? this.base.model,
        fallbacks: opts.fallbacks ?? this.base.fallbacks,
        traceContent: opts.traceContent ?? this.base.traceContent,
        labels: opts.labels ?? this.base.labels,
        maxTokens: opts.maxTokens ?? this.base.maxTokens,
        maxIterations: opts.maxIterations ?? this.base.maxIterations,
        client: opts.client,
        onText: opts.onText,
        // ⚠️ 取消传播（B1）：signal 是 RunInvocationOptions 的契约字段，必须原样进引擎。
        // 宿主全都经 app.run 传它（HTTP 客户端断开 / drain 收口 / AsyncRunner.runTimeoutMs），
        // 漏掉这一行 = 取消在 app.run 门口静默断掉：断开后 run 照跑到收尾、继续烧 token，
        // 而三处宿主测试都用**假 app** 断言「signal 交到了 app」，真 AgentApp 这一跳无人测。
        signal: opts.signal,
        // 入站链路（spec §9.2）：宿主给的触发来源上下文原样进引擎 —— 与 signal 同一条
        // 「契约字段必须原样透传」的规则（漏掉这一行 = traceparent 头解析出来了却没人用）。
        traceContext: opts.traceContext,
        idempotencyKey: opts.idempotencyKey,
        // 增量记账出口：应用级 + per-run **叠加**（应用级在前，与 sinks 的次序一致）。
        // ⚠️ 必须在这个 omitUndefined 里：`exactOptionalPropertyTypes` 下显式传 undefined
        // 不是合法的 `foo?: T`（与上面那段注释同一个原因）。
        onTraceEvent: composeTraceEvents(this.onTraceEvent, opts.onTraceEvent),
        // 记账闸：per-run 覆盖应用级缺省（**值**语义 —— 与上面 onTraceEvent 的叠加相反）
        traceLimits: opts.traceLimits ?? this.base.traceLimits,
        // HITL：审批决定（tool_use_id → 决定）原样进引擎；恢复挂起任务时由
        // AsyncRunner 经它把落库的决定喂回来
        approvals: opts.approvals,
        // 事件投入口（2026-09-28 ref-run-event-input）：与 approvals 同一条「契约字段必须原样透传」的规则
        // （漏掉这一行 = AsyncRunner 投递的事件在 app.run 门口静默丢掉）
        events: opts.events,
        contextPolicy: opts.contextPolicy ?? this.base.contextPolicy,
        retry: opts.retry ?? this.base.retry,
        maxTotalTokens: opts.maxTotalTokens ?? this.base.maxTotalTokens,
        maxCostUsd: opts.maxCostUsd ?? this.base.maxCostUsd,
        priceOverrides: opts.priceOverrides ?? this.base.priceOverrides,
        onUnpricedModel: opts.onUnpricedModel ?? this.base.onUnpricedModel,
        toolTimeoutMs: opts.toolTimeoutMs ?? this.base.toolTimeoutMs,
        maxToolConcurrency: opts.maxToolConcurrency ?? this.base.maxToolConcurrency,
        maxEventChars: opts.maxEventChars ?? this.base.maxEventChars,
        resultSchema: opts.resultSchema,
        // 提示词版本化（D4）：system 是 SystemPrompt 实例时自动带上它的 version
        // （run 根 attribute `system.version`）；传已拼好的 SystemParam 则无版本可记。
        systemVersion: sys instanceof SystemPrompt ? sys.version : undefined,
        // @Prompt 资产版本表（R7）：固定来自装配期收集（per-run opts 无此字段）；
        // 无版本表的 app 传 undefined，engine 空表不记。
        promptVersions: this.promptVersions,
        session: opts.session,
        memory: opts.memory,
        rethrow: opts.rethrow,
        // 冲刷前的最后一笔（见 RunAppOptions.beforeFlush）：per-run 字段原样透传 ——
        // 与 sinks 不同，它**不是**应用级配置（defineEval 每个用例各挂各的结论）。
        beforeFlush: opts.beforeFlush,
      }),
      contextInit: (ctx) => {
        if (seed) {
          // 种子键是运行期字符串，类型上无从与「用户声明的 Blackboard」对齐 ——
          // 走文档里给用户的同一条逃生口：断言为 BlackboardKey。
          const entries = seed as Record<string, unknown>;
          for (const key of Object.keys(entries)) ctx.set(key as BlackboardKey, entries[key]);
        }
      },
    });
  }
}

/**
 * 同一 DI token 在**显式 providers** 里出现多次 ⇒ 出声（2026-10-16 ref-di-dup-loud）。
 *
 * 「后注册覆盖先注册」是 `Container.register` 的语义，但它**不是**告警语义：覆盖发生时
 * 没有任何东西会响，于是「我在装配里配的值被另一份顶掉了」只能靠人读出来。真实工程里
 * 最易撞的是同一个**值**被声明两次（`WORKDIR` 最典型）：`discover` 扫出来的那份与
 * `registry.ts` / 应用级手写那份，谁生效取决于拼接顺序。
 *
 * 只管 `providers` 这一条数组 —— 它**含 discover 并入的那批**（`createApp` 把扫描结果拼在
 * 显式声明之前一起传进构造函数，见本文件末尾）⇒ 「discover 扫出来一份、手写又一份」
 * 也算重名，那正是要抓的一类。模块级 → 应用级那条覆盖是设计好的（应用覆盖模块缺省），
 * 不在本数组的比对范围内，不告警。
 */
function warnDuplicateTokens(providers: Provider[]): void {
  const counts = new Map<string, number>();
  for (const p of providers) counts.set(p.provide, (counts.get(p.provide) ?? 0) + 1);
  const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([token]) => `"${token}"`);
  if (dups.length === 0) return;
  console.warn(
    '[agentia] 同一 DI token 重复注册（后注册覆盖先注册，生效的是最后一份）：' +
      dups.join('、') +
      ' —— 常见于 discover 扫出来的能力与 registry.ts / 应用级手写 providers 各声明一份；' +
      '要哪份生效就让它排在后头，或干脆只留一份。',
  );
}

/**
 * 装配应用。不带 discover 时同步返回 AgentApp；带 discover（能力目录路径，一个或一组）时
 * 先扫描装配，返回 Promise<AgentApp>（动态 import 决定）。
 */
export function createApp(opts: AppOptions & { discover: string | string[] }): Promise<AgentApp>;
export function createApp(opts: AppOptions): AgentApp;
export function createApp(opts: AppOptions): AgentApp | Promise<AgentApp> {
  if (opts.discover) {
    return discoverProviders(opts.discover).then(
      // 显式 providers 放在发现结果**之后**：AppOptions.providers 是应用级显式声明，
      // 同 token 时应覆盖「目录里扫出来的」（后注册覆盖先注册）。反过来会让
      // capabilities/ 下一个同名文件夹悄悄顶掉调用方手写的 provider。
      (found) => new AgentApp({ ...opts, providers: [...found, ...(opts.providers ?? [])] }),
    );
  }
  return new AgentApp(opts);
}
