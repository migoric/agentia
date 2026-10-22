/**
 * Agentia 巡检服务 —— 一个**真的在干活**的可交付 Agent 服务。
 *
 * 跟 [../deploy/](../deploy/) 的区别：那个示例的菜单里只有一个 `echo`（证明接线），
 * 这个示例的菜单是五个真工具 + 一条人工审批闸，跑的是真任务（对真目录做只读巡检、
 * 产出真报告），所以它才配被拿去对 [`docs/deployment.md`](../../docs/deployment.md)
 * 的十条上线清单逐条对拍。
 *
 * 接线刻意**贴着那十条**写，注释里标了 §N 的就是对应条：
 *   §1 密钥由宿主显式传入（框架不读 env）      §2 SqliteTaskStore + resumePending
 *   §3 authenticate（token）+ /metrics 不鉴权的边界    §4 /healthz 的 draining
 *   §5 SIGTERM → drain，宽限 > timeoutMs，store.close() 排在 drain 之后
 *   §6 四个预算旋钮（token / 成本 / 迭代 / 工具超时）+ 非 Anthropic 端点的价目表
 *   §7 两个 sink（指标 + JSONL trace）        §9 回滚要看迁移小节（见 README）
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AsyncRunner,
  HttpException,
  SqliteTaskStore,
  SystemPrompt,
  createApp,
  createHttpHandler,
  gracefulShutdown,
  jsonlTraceSink,
  metricsSink,
  serve,
} from '@migor/agentia';
import { wireModel } from './model.js';
import { buildProviders } from './registry.js';
import { Workspace } from './workspace.js';

// ── 配置（宿主自己的 env 约定；框架不读 env，见 deployment.md §1）────────────
const PORT = Number(process.env.PORT ?? 3000);
const ROOT = resolve(process.env.PATROL_ROOT ?? 'sample-workspace');
const REPORTS = resolve(process.env.PATROL_REPORTS ?? 'patrol-reports');
/**
 * SQLite 的「内存库」哨兵 `:memory:` **必须原样交给驱动** —— 先 `resolve()` 就毁了。
 *
 * 这里踩过一次（实测）：写成 `resolve(process.env.PATROL_DB ?? 'patrol.db')` 时，
 * `resolve(':memory:')` 得到的是 `…/patrol/:memory:`（一个**绝对路径**），于是 ①
 * `DB_PATH !== ':memory:'` 那个保护判据**恒真**、② 驱动拿到的是个普通文件路径 ——
 * 结果「要内存库」**静默变成一个名叫 `:memory:` 的磁盘文件**（还会污染仓库根）。
 * ⇒ 判据放在**原始字符串**上，resolve 只对真正的路径做。
 */
const DB_RAW = process.env.PATROL_DB ?? 'patrol.db';
const DB_PATH = DB_RAW === ':memory:' ? DB_RAW : resolve(DB_RAW);
const TOKEN = process.env.PATROL_TOKEN ?? '';
const DRAIN_TIMEOUT_MS = Number(process.env.PATROL_DRAIN_TIMEOUT_MS ?? 15_000);
/** 兜底宽限：compose 的 stop_grace_period 必须**大于** drain 超时（§5） */
const RUN_TIMEOUT_MS = Number(process.env.PATROL_RUN_TIMEOUT_MS ?? 180_000);

mkdirSync(REPORTS, { recursive: true });
if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

// ── §1 模型接线（含 §6 的价目表：不给价，钱的上限会**静默不生效**）──────────
const { client, model, priceOverrides, pricingIsPlaceholder } = wireModel();

// ── §3 鉴权：**安全缺省**。没配 token 就拒绝启动，除非显式认领「只有反代可达」──
if (!TOKEN && process.env.PATROL_ALLOW_NO_AUTH !== '1') {
  console.error(
    '[boot] 拒绝启动：没有 PATROL_TOKEN。\n' +
      '  · 生产：用编排平台的 secret 注入 token；\n' +
      '  · 或明确决定「只有反代可达」——那就在运维文档里写明，并设 PATROL_ALLOW_NO_AUTH=1 认领它。',
  );
  process.exit(2);
}

const ws = new Workspace({ root: ROOT, reportsDir: REPORTS });

// ── §7 观测出口：一个聚合指标、一个落盘 trace（都满足 TraceSink，出口仍只有一条缝）──
const metrics = metricsSink({ prefix: 'patrol_' });
const traceDir = resolve(REPORTS, 'traces');
mkdirSync(traceDir, { recursive: true });

// ── 装配 ─────────────────────────────────────────────────────────────────
const app = createApp({
  name: 'patrol',
  providers: buildProviders(ws),
  system: new SystemPrompt().add(
    'role',
    [
      '你是代码巡检 agent。你的唯一交付物是一份 Markdown 报告。',
      '',
      '工作方式：',
      '1. 先用 list_files 看巡检根的顶层结构；',
      '2. 用 read_file / search_text 收集证据——**只报告你亲眼看到的证据**，不要推测；',
      '3. 用 write_report 写出报告（filename 用 patrol.md）。报告要含：目录概况、发现的问题',
      '   （每条附 文件路径:行号 与原文片段）、以及你认为该隔离哪些文件及理由；',
      '4. 若你认为某个文件该隔离，**在报告写完后**调用 quarantine_path —— 它会挂起等人工审批，',
      '   这是预期行为，不是错误。',
      '',
      '边界：read_file / list_files / search_text 只能看巡检根之下；写只能写进产出目录。',
      '看不到的东西不要编。',
    ].join('\n'),
    true,
  ),
  model,
  priceOverrides,
  sinks: [metrics, jsonlTraceSink({ path: resolve(traceDir, 'trace.jsonl') })],
  // §6 四个旋钮：没设值就没有保险丝
  maxTotalTokens: Number(process.env.PATROL_MAX_TOKENS ?? 200_000),
  maxCostUsd: Number(process.env.PATROL_MAX_COST_USD ?? 2),
  maxIterations: Number(process.env.PATROL_MAX_ITERATIONS ?? 24),
  toolTimeoutMs: 20_000,
  // 工具输出无框架层大小闸（usage-guide §7）⇒ 记账侧开大一点，便于事后分析真实尺寸
  maxEventChars: 4_000,
  onUnpricedModel: ({ model: m }) => console.warn(`[warn] 模型无价目表，成本上限对它不生效：${m}`),
});

// ── §2 耐久存储 + 重启续跑 ─────────────────────────────────────────────────
const store = new SqliteTaskStore(DB_PATH);
const runner = new AsyncRunner(app, {
  store,
  client,
  runTimeoutMs: RUN_TIMEOUT_MS,
  // 审批等人不无限等：到点自动按「拒绝」恢复，让模型换路（惰性判定，不起定时器）
  approvalTimeoutMs: Number(process.env.PATROL_APPROVAL_TIMEOUT_MS ?? 900_000),
  maxQueued: 64,
  // 落库失败别静默（否则任务永远停在 running，重启被重跑 = 副作用发生两次）
  onPersistError: (info) => console.error('[persist-error]', JSON.stringify(info)),
});

const resumed = await runner.resumePending();
if (resumed) console.log(`[boot] 续跑 ${resumed} 个未完成任务`);

// ── §3/§4 HTTP 宿主 ───────────────────────────────────────────────────────
const handler = createHttpHandler(app, {
  runner,
  maxConcurrentRuns: 8,
  metrics, // /metrics 由框架挂（**不鉴权** —— 生产必须由反代限制，见 §3）
  authenticate: (req) => {
    if (!TOKEN) return; // 显式认领过「只有反代可达」
    const got = req.headers.authorization ?? '';
    if (got !== `Bearer ${TOKEN}`) {
      throw new HttpException(401, { error: 'unauthorized' }, 'token 不匹配');
    }
  },
});

// `serve` = createServer + listen + 等真的在听；`port` 是**实际**端口（PORT=0 时由 OS 分配）
const { server, port } = await serve(handler, { port: PORT });

// ⚠️ 首行是**就绪信号**（drill.ts 从它解析实际端口）——改文案要同步改那边的正则
console.log(`[boot] listening on :${port}`);
console.log(`[boot] root=${ROOT}`);
console.log(`[boot] reports=${REPORTS}`);
console.log(`[boot] db=${DB_PATH}`);
console.log(`[boot] model=${model}${pricingIsPlaceholder ? '（价目表是占位值）' : ''}`);
if (!TOKEN) console.warn('[boot] ⚠️ 未启用 authenticate（PATROL_ALLOW_NO_AUTH=1）');
if (pricingIsPlaceholder) {
  console.warn('[boot] ⚠️ 用的是占位价目表 —— maxCostUsd 的读数不可信，请设 PATROL_PRICE_IN/OUT');
}

// ── §5 优雅停机：框架不订阅信号，传 `signals` 即宿主显式认领；顺序是死的 ─────
gracefulShutdown({
  server,
  // ① 拒新单 → 等在飞收尾（超时强制收口 SSE）
  drain: () => handler.drain({ timeoutMs: DRAIN_TIMEOUT_MS }),
  signals: ['SIGTERM', 'SIGINT'],
  timeoutMs: DRAIN_TIMEOUT_MS,
  onSecondSignal: () => process.exit(1),
  onShutdown: (clean) => {
    // ② 关服务器已由本原语做完；③ store.close() **排在 drain 之后**
    //    （drain 不关 store：同一个 store 可能被共用）
    store.close();
    console.log(clean ? '[bye] 已排空退出' : '[bye] 超时收口，剩余任务下次启动续跑');
    process.exit(clean ? 0 : 1);
  },
});
