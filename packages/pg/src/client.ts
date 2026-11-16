/**
 * Agentia-PG —— 客户端最小结构面（**duck-typed**：本包不 import `pg`，也不 import
 * `postgres`，与 `@migor/agentia` 的 `RedisLike` / `RedisSessionClient` 同一条路线）。
 *
 * 为什么是鸭子类型而不是直接依赖 `pg`：
 * - 同一份实现要能跑在 node-postgres（`pg` / `@neondatabase/serverless`）、PGlite（WASM）、
 *   以及各云厂商的兼容驱动上 —— 它们的公共交集恰好就是 `query(text, params)`；
 * - 依赖 `pg` 会把「装了我们这个包」变成「装了一个具体的驱动」，而宿主通常已经有自己的
 *   连接池与生命周期管理（`pool.end()` 该由谁调是宿主的决定，不该由 store 决定）。
 *
 * ⚠️ **`postgres.js` 不在这个结构面内**：它的调用形态是标签模板 `sql\`...\``，与
 * `query(text, params)` 签名相反。用它的话包一层即可 —— 注意 `unsafe()` 返回的是
 * **行数组本身**（带 `count` 元数据），不是 `{ rows }`：
 *
 * ```ts
 * const client: PgClient = {
 *   query: async (text, params) => {
 *     const rows = await sql.unsafe(text, (params ?? []) as ParameterOrJSON<never>[]);
 *     return { rows, rowCount: rows.count };
 *   },
 * };
 * ```
 */

/**
 * `query` 的返回结构面 —— 只要求 `rows`；`rowCount`/`affectedRows` 有则用于 `prune` 之类的计数。
 *
 * `rows` 是 `readonly unknown[]` 而不是泛型数组，这是刻意的：**泛型方法无法被包装**。
 * `PgClient.query` 一旦声明成 `<R>(...) => Promise<{rows: R[]}>`，任何中间层
 * （`{ query: (t, p) => pool.query(t, p) }`、带日志的包装、测试替身）都会被 TS 判为
 * 「非泛型函数不能赋值给泛型签名」（TS2322，`R could be instantiated with an arbitrary type`），
 * 而那一层的作者只能写 `as unknown as` 双重断言 —— 每个使用者都要付一次这个税。
 *
 * 行形状的断言因此落在**本包内部**（5 个调用点各一次），而不是落在每个宿主身上。
 */
export interface PgQueryResult {
  /**
   * 返回行。`readonly` 让 `postgres.js` 的 `readonly Row[]` 也能直接对上，不必先复制一份。
   */
  rows: readonly unknown[];
  /**
   * 受影响行数。node-postgres 给 `number | null`，PGlite 给 `number` —— 两者都接受。
   * 缺省时依赖它的方法（`prune`）返回 0 而不是编一个数。
   */
  rowCount?: number | null;
  /**
   * 受影响行数的**另一个常见别名**。PGlite 两个都给，但一些包装层（ORM / 中间件）
   * 只转出 `affectedRows`。`prune` 按 `rowCount ?? affectedRows ?? 0` 读，
   * 免得"删了 500 行却报 0"这种看起来像 bug 的读数。
   */
  affectedRows?: number | null;
}

/**
 * 本包要求的 PG 客户端能力：一条参数化查询。
 *
 * `params` 里的值按位置绑定到 `$1..$n`。调用方（本包内部）**从不**把用户数据拼进 SQL
 * 文本 —— 表名/前缀在构造期经标识符校验后拼入，其余一律走占位符。
 *
 * `pg` 的 `Pool` / `Client`、PGlite、`@neondatabase/serverless` 都**直接满足**这个结构面，
 * 传实例本身即可（别把 `pool.query` 解构出来 —— 它依赖 `this`，见 README）。
 */
export interface PgClient {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
}

/**
 * 构造期校验客户端形状。缺失时**响亮失败**（与 `RedisTaskStore` 对 `get`/`set` 的
 * 处理同一口径）：一个不满足结构面的对象传进来，报错会延迟到第一次 save 才炸，
 * 那时错误信息通常变成「`client.query is not a function`」这种指不到配置现场的样子。
 */
export function assertPgClient(client: unknown, who: string): PgClient {
  if (client === null || typeof client !== 'object') {
    throw new TypeError(
      `${who} 需要一个 PG 客户端对象（提供 query(text, params)），收到 ${String(client)}`,
    );
  }
  const q = (client as { query?: unknown }).query;
  if (typeof q !== 'function') {
    throw new TypeError(
      `${who} 的客户端缺少 query(text, params) —— ` +
        '请传 node-postgres 的 Pool/Client、PGlite 实例，或任何同形的对象',
    );
  }
  return client as PgClient;
}
