import { createServer } from 'node:http';
import {
  AsyncRunner,
  createApp,
  createHttpHandler,
  HttpException,
  InMemoryTaskStore,
  jsonlTraceSink,
  SystemPrompt,
} from '@migor/agentia';
import type { AppCallable } from '@migor/agentia';
import { handleOrders } from './orders.js';
import { providers } from './registry.js';

/**
 * 在**已有** REST 服务上增量加一个 agent 端点。
 *
 * 改造清单（全部改动都在本文件，`orders.ts` 一行未动）：
 *   ① 装一个包（`@migor/agentia`，零运行时依赖）；
 *   ② 把已有业务函数包成 `@Tool`（`tools/lookup-order`）；
 *   ③ **复用**同一个鉴权（`requireApiKey` 同时给业务路由与 agent 路由用）；
 *   ④ 在 `createServer` 里加**一条分支**：业务路由优先，其余交给 agent handler；
 *   ⑤ 把 `drain()` 接进已有的 SIGTERM 流程；
 *   ⑥ 四个预算旋钮设上（没设 = 没有保险丝）。
 */

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.API_KEY; // 不设 = 不鉴权（仅本地开发）

/**
 * **已有的**鉴权 —— 注意它是业务侧的职责，框架不实现策略、只给缝。
 * agent 路由与业务路由共用这一个函数，不是两份规则。
 */
function requireApiKey(headers: Record<string, string | string[] | undefined>): void {
  if (API_KEY !== undefined && headers['x-api-key'] !== API_KEY) {
    throw new HttpException(401, { error: '无效凭据' });
  }
}

// —— ① 装配（同步返回；带 discover 才是 Promise）——
const app = await createApp({
  name: 'orders-service',
  providers,
  system: new SystemPrompt().add(
    'role',
    '你是订单服务的助手。用户问订单状态或金额时，用 lookup_order 工具查；' +
      '查不到就如实说没有，不要编造单号。',
    true,
  ),
  // ② trace 落盘 —— 与 `agentia report / diff / harvest / export` 的输入格式一致
  sinks: [jsonlTraceSink({ path: '.agentia/traces.jsonl' })],
  // ⑥ 四个旋钮：没设值就没有保险丝；超限以 budget_exceeded 收尾（算失败）
  maxTotalTokens: 200_000,
  maxCostUsd: 0.5,
  maxIterations: 12,
});

const callable: AppCallable = app;

// ③ 耐久面：示例用内存 store（重启即丢）；生产换 SqliteTaskStore / RedisTaskStore
const store = new InMemoryTaskStore();
const runner = new AsyncRunner(callable, { store, runTimeoutMs: 120_000 });

// ④ 宿主：鉴权缝在**读 body 之前**生效（除 /healthz 外所有路径）
const handler = createHttpHandler(callable, {
  runner,
  maxConcurrentRuns: 16,
  authenticate: (req) => requireApiKey(req.headers),
});

const server = createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0] ?? '/';

  // —— 原有业务路由：先判、先走，行为与加 agent 之前完全一致 ——
  if (url.startsWith('/api/')) {
    requireApiKey(req.headers); // 同一份鉴权；抛 HttpException 由下面的兜底转成 401
    if (handleOrders(req, res)) return;
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: '未知业务路由' }));
    return;
  }

  // —— 新增的一条分支：其余路径交给 agent（/run · /tasks · /tasks/:id · /healthz · /metrics）——
  void handler(req, res);
});

server.listen(PORT, () => {
  const addr = server.address();
  const actual = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  console.log(`[boot] :${actual}  业务=/api/orders/:id  agent=/run /tasks /healthz`);
  console.log(`[boot] 鉴权=${API_KEY ? '开（x-api-key）' : '关'}   trace=.agentia/traces.jsonl`);
});

// ⑤ 优雅停机：框架**不订阅**信号 —— 在已有流程里加一步 drain 即可
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[${sig}] 先排空在飞 run，再关服务……`);
    void (async () => {
      // ⚠️ 停机宽限（compose 的 stop_grace_period）必须**大于**这个 timeoutMs，
      //    否则宽限先到、容器被 SIGKILL，drain 等于没做（见 docs/deployment.md §5）
      const clean = await handler.drain({ timeoutMs: 15_000 });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      console.log(clean ? '[bye] 已排空' : '[bye] 超时收口（挂起的任务下次启动续跑）');
      process.exit(0);
    })();
  });
}
