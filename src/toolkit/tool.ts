import type { AgentTool, CapabilityMetadata, JsonSchema, SchemaInput } from '../core/tool.js';
import { assertMethodTarget, scanDecoratedMethods, capabilityName } from './collect.js';
import type { CapabilityDecoratorContext } from './collect.js';

/**
 * Agentia —— 声明式工具层（spec §4：标准装饰器 + 显式 DI，无 param 反射）。
 *
 * `@Tool({ description, schema })` 方法装饰器 —— 把类方法变成
 * 主 agent 可调的 AgentTool。方法签名固定为单参数：模型按 input_schema
 * 解析出的结构化入参（JSON Schema 由开发者在 spec 里显式给出，不靠反射猜）。
 * 装饰器只把「方法 → spec」登记到 WeakMap；真正的 AgentTool 由
 * `collectTools(instance)` 对已解析的容器实例扫描生成（此时才拿到 this）。
 *
 * 装饰器不含副作用、不依赖 TS 编译产物细节，用标准 (value, context) 语义，
 * 与 tsgo/esbuild 均兼容。当前 run 作用域经 AsyncLocalStorage 传播，
 * 方法体内可随时 `RunContext.current()` 读 blackboard/runId。
 */
export interface ToolSpec<S extends JsonSchema = JsonSchema> {
  /** 模型可见工具名；缺省取被装饰方法名 */
  name?: string;
  description: string;
  /**
   * input_schema：v1 用裸 JSON Schema（对应 engine/core 的 JsonSchema）。
   *
   * 传 `fromZod<T>(...)`（TypedSchema<T>）时，被装饰方法的**入参类型会被自动校验**：
   * 签名与 T 不一致直接编译期报错（不用手写 `@Tool<I, O>` 泛型）。
   * 传裸 JsonSchema 时回落 any —— 不校验（旧行为）。
   */
  schema: S;
  /** strict 参数校验（透传给 Anthropic 的 strict 模式） */
  strict?: boolean;
  /**
   * 人工审批闸（HITL）：`'required'` 时该工具的每次调用都先挂起等审批
   * （回合级全有或全无，见 `AgentTool.approval`）；批准/拒绝经
   * `AsyncRunner.approve` / `POST /tasks/<id>/approve` 到达。
   */
  approval?: 'required';
  /** 团队协作元数据：owner / 契约版本 / 风险 / 副作用幂等性 */
  metadata?: CapabilityMetadata;
}

/** 方法函数 → spec。WeakMap 不阻碍 GC，也不要求 globalThis 注册表。 */
const toolSpecs = new WeakMap<Function, ToolSpec>();

/**
 * 方法装饰器：登记 spec。被装饰方法入参即结构化 tool input，
 * 返回值（或 Promise）即 tool_result。抛错由 engine 包成 is_error，不中断 run。
 *
 * 类型检查由 **schema 驱动**：
 * - `schema: fromZod<T>(…)`（TypedSchema<T>）→ 方法入参必须是 `T`，签名与 schema
 *   不一致直接编译期报错 —— schema 即单一事实来源，不用两处双写；
 * - `schema: {…}`（裸 JsonSchema）→ 入参回落 `any`，不校验（宽松旧行为）。
 *
 * 第二个泛型 `O` 用于显式约束返回值（缺省 `any`，不校验）。
 */
// biome-ignore lint/suspicious/noExplicitAny: 返回值泛型缺省 any 是刻意留的放宽口（上面注释），收紧会让既有调用方编译失败
export function Tool<S extends JsonSchema = JsonSchema, O = any>(spec: ToolSpec<S>) {
  return (
    value: (input: SchemaInput<S>) => O | Promise<O>,
    context: CapabilityDecoratorContext,
  ): void => {
    assertMethodTarget(context, '@Tool');
    // spec 的 schema 在类型上更精确（S），登记表按擦除后的形态存（与 collect 一致）
    toolSpecs.set(value, spec as ToolSpec);
  };
}

/** 把容器实例上所有 @Tool 方法收集成 AgentTool[]（沿原型链，含继承的父类工具）。 */
export function collectTools(instance: object): AgentTool[] {
  return scanDecoratedMethods(instance, toolSpecs).map(({ key, spec }) =>
    buildTool(instance, key, spec),
  );
}

function buildTool(instance: object, key: string | symbol, spec: ToolSpec): AgentTool {
  return {
    name: capabilityName(spec, key, '@Tool'),
    description: spec.description,
    inputSchema: spec.schema,
    capability: 'tool',
    ...(spec.metadata ? { metadata: spec.metadata } : {}),
    ...(spec.strict ? { strict: true } : {}),
    ...(spec.approval ? { approval: spec.approval } : {}),
    run: (input: unknown) =>
      Reflect.apply(
        (instance as Record<string | symbol, (...args: unknown[]) => unknown>)[key],
        instance,
        [input],
      ),
  };
}
