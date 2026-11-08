/**
 * Agentia —— 最小显式 DI 容器（spec §4/§10：标准装饰器 + 显式 DI，不用
 * experimentalDecorators/emitDecoratorMetadata/reflect-metadata）。
 *
 * Provider 三态：useValue / useClass / useFactory(+deps)。
 * 依赖以字符串 token 显式声明，靠工厂解析期惰性求值；无构造器参数反射。
 * 容器按 app 粒度单例缓存；run 作用域的黑板/上下文不经过 DI，而由
 * RunContext(AsyncLocalStorage) 在 executeRun 内注入（见 runtime/context.ts）。
 */
export type Token = string;

export interface ValueProvider<T = unknown> {
  provide: Token;
  useValue: T;
}
export interface ClassProvider<T = unknown> {
  provide: Token;
  useClass: new (...args: never[]) => T;
  /** 构造器参数对应的依赖 token（按序注入）；无依赖可省略 */
  deps?: Token[];
}
export interface FactoryProvider<T = unknown> {
  provide: Token;
  /**
   * 工厂函数。形参用 `never[]` 而非 `unknown[]` —— 函数参数是**逆变**的，
   * 写 `(...deps: unknown[]) => T` 会拒掉一切带类型形参的正常工厂
   * （`(cfg: Config) => T` 不可赋值）。`never` 是最小类型，任何形参列表都能赋值，
   * 与 `ClassProvider.useClass` 的 `new (...args: never[])` 保持一致。
   */
  useFactory: (...deps: never[]) => T;
  /** 与 useFactory 形参一一对应的依赖 token */
  deps?: Token[];
}

export type Provider<T = unknown> = ValueProvider<T> | ClassProvider<T> | FactoryProvider<T>;

export function isProvider(p: unknown): p is Provider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { provide?: unknown }).provide === 'string' &&
    ('useValue' in (p as object) || 'useClass' in (p as object) || 'useFactory' in (p as object))
  );
}

export class Container {
  private readonly bindings = new Map<Token, Provider>();
  private readonly cache = new Map<Token, unknown>();
  /** 正在解析的 token 链，用于循环依赖检测 */
  private resolving: Token[] = [];

  /**
   * 覆盖式注册（后注册覆盖先注册；同一 app 内同 token 重复注册视为升级）。
   *
   * ⚠️ **注册不会刷新已装配的能力菜单**：`AgentApp.tools` 是**构建期**从容器解析的快照
   * （见 `toolkit/module.ts` 的 `get tools()`）。`createApp()` 之后再 `register()` 一个新
   * `@Tool` 的 provider，容器里确实有了，但主菜单**不会**多出这个工具 —— 菜单是静态稳定的。
   * 要让新能力进菜单，得在装配**之前**注册（或重新 `createApp()`）。
   */
  register(...providers: Provider[]): this {
    for (const p of providers) {
      if (!isProvider(p)) {
        throw new Error(`非法 provider: ${JSON.stringify(p)}`);
      }
      this.bindings.set(p.provide, p);
      // 已解析过的缓存必须一起失效：否则「后注册覆盖先注册」只在首次 resolve 前成立
      // （重复 module 装配是常见场景，升级了 provider 却仍拿到旧实例）。
      // 传递失效：依赖它的下游若已解析并缓存，也必须一起失效 —— 否则拿到的是
      // 「旧依赖构造出来的」旧实例，升级对下游完全不可见。
      this.cache.delete(p.provide);
      for (const dep of this.dependentsOf(p.provide)) this.cache.delete(dep);
    }
    return this;
  }

  /** token 的全部传递下游（直接或间接依赖它的 token），用于注册时传递失效缓存 */
  private dependentsOf(root: Token): Set<Token> {
    const out = new Set<Token>();
    const queue: Token[] = [root];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const [token, binding] of this.bindings) {
        if (token === root || out.has(token)) continue;
        const deps = (binding as { deps?: Token[] }).deps;
        if (deps?.includes(cur)) {
          out.add(token);
          queue.push(token);
        }
      }
    }
    return out;
  }

  has(token: Token): boolean {
    return this.bindings.has(token);
  }

  resolve<T = unknown>(token: Token): T {
    // 用 has 判定命中：provider 值可以是 undefined，get 返回 undefined 不等于未缓存
    if (this.cache.has(token)) return this.cache.get(token) as T;

    const cycleAt = this.resolving.indexOf(token);
    if (cycleAt !== -1) {
      const chain = [...this.resolving.slice(cycleAt), token].join(' -> ');
      throw new Error(`循环依赖（DI）: ${chain}`);
    }

    const binding = this.bindings.get(token);
    if (!binding) {
      throw new Error(`未注册的 provider: "${token}"`);
    }

    this.resolving.push(token);
    let value: unknown;
    try {
      if ('useValue' in binding) {
        value = binding.useValue;
      } else if ('useClass' in binding) {
        const deps = (binding.deps ?? []).map((d) => this.resolve(d));
        value = new binding.useClass(...(deps as never[]));
      } else {
        const deps = (binding.deps ?? []).map((d) => this.resolve(d));
        // 工厂形参声明为 never[]（见 FactoryProvider 注释）：调用点按实际 deps 断言
        value = (binding.useFactory as (...a: unknown[]) => unknown)(...deps);
      }
    } finally {
      this.resolving.pop();
    }

    // Promise 检测（外部深评 K4；判据 2026-09-29 收紧 —— 外部深评 D1）：容器是**同步**解析的 ——
    // `async` 工厂返回的 Promise 会原样被当成「值」缓存，下游注入到的是 Promise 本身：
    // 首次属性访问全 `undefined`、零报错、`tsc` 也看不出来（类型断言成 T 了）。这类
    // 「静默给错东西」必须在解析期响亮失败。
    //
    // ⚠️ 判据是 `instanceof Promise`，**不是**「有 `then`」（或「有 `then` + `catch`」）：后者会
    // 误伤一大类**同步**对象 —— knex / mongoose 的 query builder、各类 chainable 为实现
    // 「可被 await」都带 `then`，而 knex / mongoose 连 `catch` 都有（2026-09-29 查两家源码实证），
    // 它们是完全合法的注入值。「忘了 await」的产物**恒为原生 Promise**（async 函数语义），
    // 故 `instanceof` 精确命中本意、不误伤 builder。
    // 如实边界：**跨 realm** 的 Promise（`vm` / 其他上下文产物）`instanceof` 会漏 —— 装配期
    // 几乎不出现，真要注入本体请走下面的逃逸口。
    //
    // ⚠️ 检测器**就地写**、不从别处 import：`container` 是纯叶子（`layering.test.ts` 里
    // `container: []`，不许引内部任何模块），为几行逻辑破叶子边界不值得。
    // 逃逸口：确实要注入 Promise **本体**，包一层即可（`useValue: { promise }`）。
    if (value instanceof Promise) {
      // 抛类型错前先消费 rejection（2026-11-07 深评）：一个会 reject 的 async 工厂此前会
      // 留下 unhandledRejection，Node ≥15 默认终止宿主进程 —— 装配错误已经报了，不该再死一次。
      value.catch(() => undefined);
      throw new TypeError(
        `provider "${token}" 解析出的是 Promise：容器同步解析，它会被原样缓存成「值」，` +
          '下游拿到 Promise 而非 await 过的结果（首次属性访问全 undefined、且零报错）。' +
          '异步初始化请在装配前 await 好再用 useValue 注入；确实要注入 Promise 本体，包一层：useValue: { promise }',
      );
    }

    this.cache.set(token, value);
    return value as T;
  }

  /** 调试辅助 */
  registered(): Token[] {
    return [...this.bindings.keys()];
  }
}
