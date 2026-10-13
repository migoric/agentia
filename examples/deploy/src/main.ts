/**
 * Agentia 部署示例 —— 最小「可交付 Agent 服务」。
 *
 * 演示定位里那一脚（spec §1「交付物是可上线的 Agent 服务」）：
 *   耐久任务存储（SqliteTaskStore，WAL + busy_timeout，多进程安全）
 *   + 重启续跑（resumePending）
 *   + 健康检查（/healthz，探针不鉴权）
 *   + 指标（/metrics，Prometheus 文本）
 *   + 优雅停机（drain，框架不订阅信号 —— 这里是宿主自己的事）
 *
 * 观测配方（落库 / 采样 / 脱敏 / 日志关联）见 ../observability/ 与 docs/observability.md。
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import {
  AsyncRunner,
  SqliteTaskStore,
  SystemPrompt,
  createApp,
  createHttpHandler,
  metricsSink,
} from '@migor/agentia';
import { providers } from './registry.js';

// `PORT=`（空串）不是「用缺省」的写法，但 `Number('')` 恰好是 0 ⇒ 静默变成**随机端口**
// （没人知道的端口 = 看起来就是起不来）。这里把空串显式当缺省，并对非整数 / 越界响亮报错。
// ⚠️ 别改成 `Number(process.env.PORT) || 3000` —— 那会把 `PORT=0`（由 OS 分配端口，
//    e2e 正是靠它拿随机端口）一起吃掉。与脚手架模板 templates/src/main.ts 同款判据。
const rawPort = process.env.PORT;
const PORT = rawPort === undefined || rawPort.trim() === '' ? 3000 : Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error(
    `PORT 必须是 0–65535 的整数（0 = 由操作系统分配），实际：${JSON.stringify(rawPort)}`,
  );
}
const DB_PATH = process.env.AGENTIA_DB ?? 'agentia.db';

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

// —— 1) 观测出口：指标 sink（满足 TraceSink 即接入，零新出口）——
// 需要 OTLP 再加一个：sinks: [metrics, createOtlpExporter({ endpoint: process.env.OTEL_ENDPOINT! })]
const metrics = metricsSink({ prefix: 'agentia_' });

// —— 2) 装配 ——
const app = await createApp({
  name: 'deploy-example',
  providers,
  system: new SystemPrompt().add(
    'role',
    '你是部署示例的主 agent，按任务自主调度菜单里的能力。',
    true,
  ),
  sinks: [metrics],
  maxTotalTokens: 200_000, // 单条 run 的 token 上限（硬管控，超限以 budget_exceeded 收尾）
});

// —— 3) 耐久任务存储 ——
const store = new SqliteTaskStore(DB_PATH);
const runner = new AsyncRunner(app, { store, runTimeoutMs: 120_000 });

// 重启续跑上次未完成的 queued/running 任务（不是丢弃）；多进程共库时按 ownerId 跳过本进程记录
const resumed = await runner.resumePending();
if (resumed) console.log(`[boot] 续跑 ${resumed} 个未完成任务`);

// —— 4) HTTP 宿主 ——
const handler = createHttpHandler(app, { runner, maxConcurrentRuns: 32 });

const server = createServer((req, res) => {
  // 额外运维端点：/metrics（Prometheus 抓取）。⚠️ 走 handler 之外，不受 authenticate 管 ——
  // 生产请由反代 / 内网限制其可达性（探针端点通常如此）。
  if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metrics.render());
    return;
  }
  void handler(req, res);
});

server.listen(PORT, () => {
  // PORT=0 时端口由操作系统分配，以 server.address() 拿到的实际端口为准
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  // ⚠️ 首行是**就绪信号**（scripts/e2e-deploy.ts 从它解析实际端口判定服务可用）——
  //    改文案要同步改那边的正则。
  console.log(`[boot] listening on :${actualPort}（db=${DB_PATH}）`);
  console.log('  POST /run        同步 run（带 Accept: text/event-stream → SSE 逐帧）');
  console.log('  POST /tasks      异步任务（轮询 GET /tasks/:id）');
  console.log('  GET  /healthz    健康检查（探针用，不鉴权）');
  console.log('  GET  /metrics    Prometheus 指标');
});

// —— 5) 优雅停机（框架不订阅信号 —— 这是宿主的职责）——
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return; // 第二次信号不再拦截，便于强杀
    stopping = true;
    console.log(`[${sig}] 优雅停机……`);
    void (async () => {
      // 拒新单 → 等在飞同步 run 与异步任务收尾 → 超时强制收口 SSE
      const clean = await handler.drain({ timeoutMs: 15_000 });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      console.log(clean ? '[bye] 已排空退出' : '[bye] 超时收口，剩余任务下次启动续跑');
      process.exit(0);
    })();
  });
}
