/**
 * Agentia 完整示例 —— 一个「可上线」的 agent 服务该有的样子。
 *
 * 覆盖框架的完整表面：
 *   装配      显式注册表 + 四类能力（@Tool / @Skill / @SubAgent / @Prompt）
 *   观测      指标 + 采样 + 脱敏 + 落库 + 结构化日志（见 observability.ts）
 *   触发      POST /run（同步/SSE）· POST /tasks（异步）· Scheduler（定时）
 *   宿主      鉴权缝 + 并发闸门 + /healthz + 优雅停机 + 重启续跑
 *
 * 运行（在仓库根先 `npm run build`，再 `cd examples/complete && npm install`）：
 *   ANTHROPIC_API_KEY=sk-ant-... npm start
 *
 * 也可指向 **OpenAI 兼容端点**（DeepSeek / vLLM / Ollama…）—— 见下面「注入 model client」：
 *   OPENAI_BASE_URL=https://api.deepseek.com OPENAI_API_KEY=sk-... AGENTIA_MODEL=deepseek-chat npm start
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AsyncRunner,
  HttpException,
  Scheduler,
  SqliteTaskStore,
  SystemPrompt,
  createApp,
  createHttpHandler,
  createOpenAIClient,
  gracefulShutdown,
  serve,
} from '@migor/agentia';
import type { AppCallable } from '@migor/agentia';
import { buildObservability } from './observability.js';
import { providers } from './registry.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.AGENTIA_DB ?? 'agentia.db';
const SAMPLE_RATE = Number(process.env.AGENTIA_SAMPLE_RATE ?? 1); // 示例默认全留；生产按量调
const API_KEY = process.env.API_KEY; // 不设 = 不鉴权（本地开发）
const CHECK_INTERVAL_MS = Number(process.env.AGENTIA_CHECK_INTERVAL_MS ?? 0); // 0 = 关闭定时任务
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL; // 设了就走 OpenAI 兼容端点

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

// —— 1) 观测栈 ——
const obs = buildObservability({ dbPath: DB_PATH, sampleRate: SAMPLE_RATE });

// —— 2) 装配：四类能力 + 全观测栈 ——
const app = await createApp({
  name: 'complete-example',
  providers,
  system: new SystemPrompt().add(
    'role',
    '你是示例服务的主 agent。先判断要做什么：需要文风规范就拉取 house_style，' +
      '需要独立调研就委派 researcher，需要固定流程（如写提纲）就用 outline_writer。',
    true, // 静态段（打缓存 breakpoint）
  ),
  sinks: obs.sinks,
  maxTotalTokens: 200_000, // 成本硬管控：超限以 budget_exceeded 收尾（算失败）
  retry: { maxAttempts: 3 }, // 默认就开；显式写出来是因为示例要看得见
});

// —— 3) 注入 model client（可选）——
// 框架的 HTTP 宿主**不持有 client**：同步 `/run` 走 `app.run(messages, opts)`。所以要换
// provider，用 `AppCallable` 包一层把 client 补进 opts（异步侧另可直接给 AsyncRunner 传 client）。
// 不设 OPENAI_BASE_URL 就用框架默认的 Anthropic client（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。
const openaiClient = OPENAI_BASE_URL
  ? createOpenAIClient({
      baseURL: OPENAI_BASE_URL,
      ...(process.env.OPENAI_API_KEY !== undefined ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    })
  : undefined;

const callable: AppCallable = openaiClient
  ? {
      name: app.name,
      run: (messages, opts) => app.run(messages, { ...opts, client: openaiClient }),
    }
  : app;

// —— 4) 耐久任务存储 + 异步宿主（三种触发共用同一份 RunInput 契约）——
const store = new SqliteTaskStore(DB_PATH);
const runner = new AsyncRunner(callable, {
  store,
  ...(openaiClient !== undefined ? { client: openaiClient } : {}),
  runTimeoutMs: 120_000,
});

const resumed = await runner.resumePending(); // 重启续跑未完成任务（不是丢弃）
if (resumed) console.log(`[boot] 续跑 ${resumed} 个未完成任务`);

// —— 5) 定时触发（演示；用 AGENTIA_CHECK_INTERVAL_MS 打开，例如 60000 = 每分钟）——
// 周期任务幂等键按 interval 窗口分片；maxInFlight=1 保证上一片没跑完就跳过本次 tick。
const scheduler = new Scheduler(runner);
const job =
  CHECK_INTERVAL_MS > 0
    ? scheduler.every(CHECK_INTERVAL_MS, '巡检：用 echo 回显 ok，确认服务链路正常。', {
        idempotencyPrefix: 'healthcheck',
        source: 'schedule:healthcheck',
        maxInFlight: 1,
      })
    : undefined;
if (job) console.log(`[boot] 定时任务已启用，每 ${CHECK_INTERVAL_MS}ms 一次（id=${job.id}）`);

// —— 6) HTTP 宿主（鉴权缝：框架只给缝，策略是你的）——
const handler = createHttpHandler(callable, {
  runner,
  maxConcurrentRuns: 32,
  // /metrics 由 handler 提供（与 /healthz 同档不鉴权，Content-Type 跟 sink 走）。
  // ⚠️ 别在 createServer 里手写 /metrics 旁路 —— 那是 handler 还没有这个选项时的写法。
  metrics: obs.metrics,
  // 除 /healthz 外的所有路径都先过这里，且在读 body 之前
  ...(API_KEY
    ? {
        authenticate: (req: { headers: Record<string, string | string[] | undefined> }) => {
          if (req.headers['x-api-key'] !== API_KEY) {
            throw new HttpException(401, { error: '无效凭据' });
          }
        },
      }
    : {}),
});

// `serve` = createServer + listen + 等到真的在听；`port` 是**实际**端口（PORT=0 时由 OS 分配）。
const { server, port } = await serve(handler, { port: PORT });

// ⚠️ 首行是**就绪信号**（scripts/e2e-examples.ts 从它解析实际端口判定服务可用）——
//    改文案要同步改那边的正则。
console.log(
  `[boot] listening on :${port}（db=${DB_PATH}，鉴权=${API_KEY ? '开' : '关'}，` +
    `provider=${OPENAI_BASE_URL ? `openai 兼容 ${OPENAI_BASE_URL}` : 'anthropic'}）`,
);
console.log('  POST /run        同步 run（Accept: text/event-stream → SSE）');
console.log('  POST /tasks      异步任务（body { input, idempotencyKey?, options? }）');
console.log('  GET  /tasks/:id  轮询任务记录');
console.log('  GET  /healthz    健康检查（不鉴权）');
console.log('  GET  /metrics    Prometheus 指标');

// —— 7) 优雅停机 ——
// 手写版约 17 行，其中四个静默错（清单见 docs/plans/2026-10-22-serve-graceful-shutdown.md §1）：
// 连接没收干净 / 先 close 再 drain 切断在飞请求 / `if (stopping) return` 吞掉第二次信号 /
// 停完不 exit。`gracefulShutdown` 收走这四条，只把编排留给你：
gracefulShutdown({
  server,
  drain: () => {
    job?.cancel(); // 先停定时，别再派新任务
    return handler.drain({ timeoutMs: 15_000 });
  },
  signals: ['SIGTERM', 'SIGINT'], // 不传 = 一个都不订阅（框架不做进程级决策）
  timeoutMs: 15_000,
  onSecondSignal: () => process.exit(1),
  onShutdown: (clean) => {
    obs.close(); // sink 冲完再退（drain → 关连接 → 冲 sink → exit，顺序不能反）
    console.log(clean ? '[bye] 已排空退出' : '[bye] 超时收口，剩余任务下次启动续跑');
    process.exit(clean ? 0 : 1);
  },
});
