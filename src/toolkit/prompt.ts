import {
  assertMethodTarget,
  scanDecoratedMethods,
  capabilityName,
  isScannableInstance,
} from './collect.js';
import type { CapabilityDecoratorContext } from './collect.js';
import type { AgentTool, JsonSchema } from '../core/tool.js';

/**
 * Agentia —— Prompt 能力（spec §3：纯文本资产 —— 模板/宏/playbook，被选中时注入上下文）。
 *
 * 运行时本质：把 prompt 编译成主 agent 菜单里一个**无副作用拉取型 AgentTool** ——
 * 模型判定“这活儿需要该资产”时调用它，返回文本以 tool_result 进上下文。这是
 * 我们现成唯一的“被选中”机制（capability 本身不跑循环、不调模型）。
 *
 * 声明形态（标准装饰器下字段装饰器拿不到值/类引用，故只支持方法形态，与
 * spec §4 草图的 `static brand = '…'` 用 `static method` 同效表达）：
 * - 实例方法：`@Prompt({ description }) asset()` 返回 string —— 每次调用重新执行 → volatile 资产新鲜；
 * - 静态方法：`@Prompt({ description }) static brand()` 返回常量 string —— 纯静态资产。
 * 方法可带一个入参（spec.schema 声明）做模板化。
 */
export interface PromptSpec {
  /** 菜单名（缺省取被装饰方法名，建议 snake_case） */
  name?: string;
  /** 何时该拉取该资产的指引（模型据此决定调用） */
  description: string;
  /** 模板化入参 schema；缺省空对象（无参资产） */
  schema?: JsonSchema;
  /**
   * 资产版本号（git hash / 'v3' 等）。装配时随能力名收集成 { 能力名: 版本 } 表，
   * 每次 run 落到 run 根 span 的 `prompts.versions` attribute（engine 拼成 name@ver 逗号串）——
   * 回答「质量退化是不是换了这个 prompt 资产导致的」。缺省（无版本）则该能力不进表。
   */
  version?: string;
}

const promptSpecs = new WeakMap<Function, PromptSpec>();

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** 方法装饰器（实例或 static 均可 —— 唯一支持静态的能力类）：登记 prompt spec。返回值 = 资产文本。 */
export function Prompt(spec: PromptSpec) {
  return (value: Function, context: CapabilityDecoratorContext): void => {
    assertMethodTarget(context, '@Prompt', { allowStatic: true });
    promptSpecs.set(value, spec);
  };
}

/** collectPromptEntries 的产物：菜单工具 + 带版本能力的 name→version 表（最终菜单名口径）。 */
export interface CollectedPrompts {
  tools: AgentTool[];
  /** 带 version 的 @Prompt 的 { 最终菜单名: 版本 }；无版本能力不进表 */
  versions: Record<string, string>;
}

/**
 * 收集容器实例（+ 其类上的静态方法）里所有 @Prompt，产出 AgentTool[] 与版本表。
 * 实例方法沿原型链（含继承）；静态方法同样沿构造函数原型链（含继承的父类静态 @Prompt）。
 *
 * collectPrompts 是公共面（只回 AgentTool[]，历史形状不动）；装配侧需要版本表，
 * 故内核收两份 —— module 级 export，不进公共导出面（src/index.ts）。
 */
export function collectPromptEntries(instance: object): CollectedPrompts {
  const tools: AgentTool[] = [];
  const versions: Record<string, string> = {};
  // null/undefined/原始值 provider（useValue 合法形态）：无装饰器能力可收，空结果
  if (!isScannableInstance(instance)) return { tools, versions };
  // 传 key 而非捕获的 fn：子类「未装饰地 override」时 spec 继承自父类，
  // 但实现必须取**实例/类上**的（否则会绕开子类实现，与 @Tool 语义不一致）。
  const pushTool = (
    name: string,
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    spec: PromptSpec,
  ): void => {
    tools.push({
      name: spec.name ?? name,
      description: spec.description,
      inputSchema: spec.schema ?? EMPTY_SCHEMA,
      run: (input: unknown) => Reflect.apply(target[key] as Function, target, [input]),
    });
    // 版本表以最终菜单名（capabilityName 校验后的 name）为键；缺省无版本不进表
    if (spec.version !== undefined) versions[spec.name ?? name] = spec.version;
  };

  // 实例方法（沿原型链）
  const found = scanDecoratedMethods(instance, promptSpecs);
  const inst = instance as Record<string | symbol, unknown>;
  for (const { key, spec } of found) {
    pushTool(capabilityName(spec, key, '@Prompt'), inst, key, spec);
  }

  // 静态方法：沿构造函数原型链（含父类静态 @Prompt），Reflect.ownKeys 含 symbol key。
  // target 取**最外层**构造函数：子类「未装饰地 override」静态方法时调用走子类实现
  //（与实例侧 override 语义一致）；只看自身属性会把父类静态资产静默丢掉。
  //
  // 静态这一侧**不拿实例 key 播种 seen**：ctor 上的静态方法与原型上的实例方法是两处
  // 独立资产，key 撞了不代表同一个东西。以前拿实例 key 播种，`static brand()` 撞上
  // 实例 `brand()` 时静态资产被静默丢弃 —— 丢的恰恰是本来不可能重名的资产，而
  // `module.ts` 按**菜单名**查重永远看不到它。真正的实例↔静态重名交给 module.ts 抛
  // 「菜单能力重名」（spec §7：装配期统一查重、重名即抛），不在这里悄悄吞掉。
  //
  // 去重口径 = **解析后的菜单名**（而非方法 key）：父子类「改了方法名但同菜单名」的
  // 静态也算覆写。沿链从最外层 ctor 往上走，所以子类先占据该名字。
  const seenKeys = new Set<string | symbol>();
  const seenNames = new Set<string>();
  const root: unknown = (instance as { constructor?: unknown }).constructor;
  let ctor = root;
  while (typeof ctor === 'function' && ctor !== Function.prototype) {
    const rec = ctor as unknown as Record<string | symbol, unknown>;
    for (const key of Reflect.ownKeys(rec)) {
      if (seenKeys.has(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(rec, key);
      if (!desc || typeof desc.value !== 'function') continue;
      const spec = promptSpecs.get(desc.value as Function);
      if (!spec) continue; // 未装饰的 override 不标 seen，父类静态 spec 继续生效
      const name = capabilityName(spec, key, '@Prompt');
      if (seenNames.has(name)) continue; // 子类已占据该菜单名 → 父类静态视为被覆写
      seenKeys.add(key);
      seenNames.add(name);
      pushTool(name, root as Record<string | symbol, unknown>, key, spec);
    }
    ctor = Object.getPrototypeOf(ctor);
  }
  return { tools, versions };
}

/**
 * 收集容器实例（+ 其类上的静态方法）里所有 @Prompt，产出 AgentTool[]。
 * 实例方法沿原型链（含继承）；静态方法同样沿构造函数原型链（含继承的父类静态 @Prompt）。
 */
export function collectPrompts(instance: object): AgentTool[] {
  return collectPromptEntries(instance).tools;
}
