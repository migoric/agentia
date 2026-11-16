/**
 * 测试共用件。
 *
 * 测试打的是 **`dist/`**，不是 `src/` —— 所以"改了 src 忘了 build"会让套件绿得毫无意义
 * （跑的是旧产物）。`scripts/test-all.mjs` 对 CLI 套件明确记着这个坑但**没有断言守**；
 * 这里补一条：`dist/index.js` 比任何 `src/*.ts` 旧就直接失败。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = join(here, '..');

function mtimeOf(dir, filter) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, mtimeOf(p, filter));
    else if (filter(e.name)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/** dist 新鲜度守卫：在 import dist 之前调用一次即可 */
export function assertDistFresh() {
  let distMtime;
  try {
    distMtime = statSync(join(pkgRoot, 'dist', 'index.js')).mtimeMs;
  } catch {
    throw new Error(
      'dist/index.js 不存在 —— 先构建：npm run build -w @migor/agentia-pg ' +
        '（且根包的 dist 也要新鲜：npm run build）',
    );
  }
  const srcMtime = mtimeOf(join(pkgRoot, 'src'), (n) => n.endsWith('.ts'));
  if (srcMtime > distMtime) {
    throw new Error(
      'dist/ 比 src/ 旧 —— 这轮测试会跑旧产物，绿得没有意义。先 npm run build -w @migor/agentia-pg',
    );
  }
}

assertDistFresh();

/**
 * 起一个真 PostgreSQL 引擎（PGlite = PG 编译到 WASM，不是模拟器）。
 *
 * ⚠️ **边界**：PGlite 是单连接、单进程、无并发。它能验证 SQL 语义（UPSERT 的
 * last-wins、`nextval` 单调、jsonb 往返与转义、部分索引、`payload->>'role'`），
 * 但**验证不了多写者并发**（两个 pod 同时 save / 同时 resumePending）。
 * 那一档由 `test-live/` 的真实 PG + 多连接 / 独立 OS 进程套件覆盖，需显式设置
 * `AGENTIA_PG_TEST_URL`；不要拿这里的 PGlite 绿灯冒充多写者证据。
 */
export async function freshClient() {
  const db = new PGlite();
  return {
    db,
    client: { query: (text, params) => db.query(text, params) },
    /** 清空两张表（测试间复用同一个引擎时用） */
    async truncate(tasks, sessions) {
      await db.exec(`TRUNCATE ${tasks}, ${sessions}`);
    },
  };
}

/** 造一条最小合法 TaskRecord */
let n = 0;
export function rec(over = {}) {
  return {
    taskId: `task_${++n}`,
    status: 'queued',
    spec: { messages: [{ role: 'user', content: 'a' }] },
    createdAt: 1000 + n,
    ...over,
  };
}
