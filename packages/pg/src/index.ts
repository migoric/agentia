/**
 * `@migor/agentia-pg` —— 把 Agentia 的宿主存储落到普通 PostgreSQL 表上。
 *
 * 两个实现，都是 `@migor/agentia` 既有接口的实现（不是新抽象）：
 * - `PgTaskStore`    → `TaskStore`：任务记录/幂等键/到期索引，多 pod 共享同一份队列；
 * - `PgSessionStore` → `SessionStore`：对话历史 append-only，按轮次裁剪。
 *
 * 外加 `ensureSchema` / `schemaDdl`：幂等建表，以及"给没有 DDL 权限的实例"用的纯 SQL。
 *
 * 客户端是 **duck-typed** 的（`query(text, params)`），本包不依赖 `pg` —— 见 `client.ts`。
 */

export { type PgClient, type PgQueryResult, assertPgClient } from './client.js';

export {
  type PgSchemaNames,
  type PgSchemaOptions,
  ensureSchema,
  resolveSchemaNames,
  schemaDdl,
} from './schema.js';

export { PgTaskStore, type PgTaskStoreOptions } from './taskStore.js';
export { PgSessionStore, type PgSessionStoreOptions } from './sessionStore.js';
