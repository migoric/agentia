/**
 * Agentia —— 能力收集器共用内核。
 *
 * 四类能力（tool/skill/subagent/prompt）的装饰器都只把「方法函数 → spec」登记进
 * 各自的 WeakMap；收集器在容器实例解析后沿原型链扫描出被装饰的方法。
 * 本模块是这一扫描的唯一实现，四个 collect* 只做各自能力形态的组装。
 */

/** 一次扫描命中：方法 key、登记的 spec。 */
export interface DecoratedMethod<S> {
  key: string | symbol;
  spec: S;
}

/**
 * 能力收集的对象守卫：useValue: null/undefined/原始值 是类型上合法的 provider
 *（容器本身支持 undefined 值），它们不可能挂装饰器能力 —— 收集侧直接给空结果，
 * 不放任 `Object.getPrototypeOf(null)` 抛无上下文 TypeError。
 */
export function isScannableInstance(instance: unknown): instance is object {
  return (typeof instance === 'object' && instance !== null) || typeof instance === 'function';
}

/**
 * 沿实例原型链扫描被装饰的方法（子类 → 父类）。
 * override 语义：只在命中装饰器时标记 key —— 子类未装饰的 override 不挡
 * 父类的 spec（spec 沿原型链继承，调用仍走实例上的子类实现）。
 */
export function scanDecoratedMethods<S>(
  instance: object,
  registry: WeakMap<Function, S>,
): DecoratedMethod<S>[] {
  if (!isScannableInstance(instance)) return [];
  const found: DecoratedMethod<S>[] = [];
  const seen = new Set<string | symbol>();

  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    // Reflect.ownKeys 含 symbol key：symbol 命名的装饰方法也会被找到，
    // 无显式 name 时由 capabilityName 抛出提示（而非静默忽略）
    for (const key of Reflect.ownKeys(proto)) {
      if (seen.has(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.value !== 'function') continue;
      const spec = registry.get(desc.value as Function);
      if (!spec) continue; // 未装饰的 override 不标 seen，父类 spec 继续生效
      seen.add(key);
      found.push({ key, spec });
    }
    proto = Object.getPrototypeOf(proto);
  }
  return found;
}

/** 装饰器收到的标准 context 子集（本框架只用到这四个字段） */
export interface CapabilityDecoratorContext {
  kind: string;
  name: string | symbol;
  /** 标准装饰器 context 的私有方法标记（`#method` 的 kind 同样是 'method'） */
  private?: boolean;
  /** 标准装饰器 context 的静态方法标记 */
  static?: boolean;
}

/**
 * 四类能力装饰器共用的目标守卫：只接类方法，且**拒绝私有方法**；
 * 除 @Prompt 外（纯文本资产，静态收集是显式支持形态，见 prompt.ts）同时**拒绝静态方法**。
 *
 * 收集走 `Reflect.ownKeys`，私有名（#method）在其中不可见；静态方法挂在**构造函数**上，
 * 而 `scanDecoratedMethods` 只扫实例原型链 —— 不拦的话能力会静默从菜单里消失，
 * 作者只能靠「模型说没有这个工具」反推。
 */
export function assertMethodTarget(
  context: CapabilityDecoratorContext,
  kind: string,
  opts?: { allowStatic?: boolean },
): void {
  if (context.kind !== 'method') {
    throw new Error(`${kind} 只能修饰类方法，收到 kind=${String(context.kind)}`);
  }
  if (context.private) {
    throw new Error(`${kind} 不支持私有方法（#method）：收集用 Reflect.ownKeys，私有名不可见`);
  }
  if (context.static === true && opts?.allowStatic !== true) {
    throw new Error(
      `${kind} 不支持静态方法（static）：收集只扫实例原型链，静态方法挂在构造函数上不会被收进菜单` +
        `（@Tool/@SubAgent/@Skill 的能力调用需要实例 this；@Prompt 是唯一支持静态的能力类）`,
    );
  }
}

/**
 * 能力名合法性：与 MCP 桥（integrations/mcp.ts）同口径 `^[A-Za-z0-9_-]{1,64}$`。
 * 非法名（引号/空格/点/中文/超 64 字符）会让模型 API 直接 400 —— 装配期拦下，
 * 比「首次模型调用才暴露」好查得多；也让装饰器侧与 MCP 侧的错误口径一致。
 */
const CAPABILITY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 能力名解析：spec.name 缺省取方法名；私有符号方法名必须显式给 name。 */
export function capabilityName(
  spec: { name?: string },
  key: string | symbol,
  kind: string,
): string {
  let name: string;
  if (typeof spec.name === 'string') {
    name = spec.name;
  } else if (typeof key === 'string') {
    name = key;
  } else {
    throw new Error(`${kind} 需要显式 name（方法名为私有符号 ${String(key)}）`);
  }
  if (!CAPABILITY_NAME_RE.test(name)) {
    throw new Error(
      `${kind} 能力名 ${JSON.stringify(name)} 非法：须匹配 ^[A-Za-z0-9_-]{1,64}$` +
        '（与 MCP 桥同口径；含引号/空格/点/中文或超 64 字符的名字会让模型 API 400）',
    );
  }
  return name;
}
