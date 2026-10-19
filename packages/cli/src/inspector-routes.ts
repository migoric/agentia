/**
 * inspector 的**路由表** —— 2026-09-23 自 `inspector.ts` 切出（方案
 * `docs/plans/2026-09-23-cli-structure.md` §3 C 的收尾那一刀）。
 *
 * 切分口径（两边各管什么，越界就是新的乱源）：
 * - `inspector.ts` = **服务**：监听、三道鉴权闸（Host / Origin / token）、应答原语
 *   （`json` / `text` / `readBody` / `parseRunRequest`）、公开类型（`DevHooks` /
 *   `InspectorServer` / `TraceLike` / `RunSummary`）、`HttpError`；
 * - 本文件 = **路由**：路径匹配 → 入参校验 → 应答，外加**只被路由用到**的那几件
 *   （`validateTrace` / `validateTraceEvent` / `summarize` / `unavailableDevState` /
 *   `isDirLikeEntry` / 静态资源白名单 `STATIC`）。
 *
 * 为什么不是「换个 HTTP 框架」：**零运行时依赖是全仓铁律**
 * （`tests/architecture/no-runtime-deps.test.ts`），hono / express 永久出局。
 * 所以这次是**纯搬移** —— 不改行为、不换框架、不改任何路由语义与状态码。
 *
 * 依赖方向（单向，运行期无环）：本文件只从 `inspector.js` 取**类型**（`import type`，
 * 编译期擦除），值（`json` / `readBody` / `parseRunRequest` / …）由 `inspector.ts`
 * 经 `RouteCtx` 注入。反向的那两个常量（`TOKEN_COOKIE` / `TOKEN_HEADER`）定义在**这里**
 * 并被 `inspector.ts` 的鉴权闸 import —— 它们描述的是 **HTTP 面**（面板首帧种哪个 cookie、
 * 脚本带哪个头），路由与闸共用同一份；放这边是为了让依赖只有「服务 → 路由」一个方向。
 */
import { readFile } from 'node:fs/promises';
import { type Dirent, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BUDGET,
  type DevState,
  type RunNote,
  type RunRequest,
  type TraceRecordEventLike,
} from './dev-protocol.js';
// 并排 A/B：复用 `diff.ts` 那份**去类型移植副本**（CLI 零运行时依赖、不能 import 框架）
// ⇒ 面板看到的差异与 `agentia diff a.jsonl b.jsonl` 逐字相同。
// 可比性判据放 panel-logic（不是 diff.ts）：它判的是**面板四个输入**的差异，
// 与 span 配对算法无关；放一起会让两个不同的关注点混在一个文件里。
//
// ⚠️ 严格 Trace 类型用 `Parameters<typeof diffTraces>[0]` 取，**不从 diff.ts 导出它**：
// 那边的 `interface Trace` 是「逐字同形移植」的**内部**声明，导出它等于给这份副本开
// 公共面（旁人会开始 import 它，于是改算法时它也成了要同步的第二个副本 —— 正是
// 逐字对拍要防的那件事）。用 Parameters 取，签名改了这里自动跟着变，零漂。
import { diffTraces } from './diff.js';
import { comparability } from './panel-logic.js';
import type { DevHooks, RunSummary, TraceLike } from './inspector.js';

/**
 * `diffTraces` 要的**严格** `Trace` 形状（从签名反推，不另写一份 interface ——
 * 另写就是第二处会漂的形状声明）。
 */
type StrictTrace = Parameters<typeof diffTraces>[0];

/**
 * 宽松 `TraceLike` → `diffTraces` 能吃的形状，**补上缺省的空容器**。
 *
 * ⚠️ **为什么不直接强转**（`ta as unknown as StrictTrace`，本仓的坏习惯）：
 * `diffTraces` 内部有 `pushAttrDiffs` / `pushEventDiffs`，两者都**直接** `Object.keys(x)` /
 * `x.length`，参数为 `undefined` 时抛 `Cannot convert undefined or null to object`。
 * 而 `validateTrace`（入站校验）**只**要求 `spanId` / `name` / `startedAt` ——
 * `attributes` 与 `events` 不在必填之列 ⇒ 一条裁剪过的 trace 能合法进 `/ingest`，
 * 于是 compare 路由会500。
 *
 * ⚠️ **为什么不改 `diff.ts`**：它是 `src/engine/trace-diff.ts` 的**逐字同形移植副本**
 * （注释与 `structure.test.mjs` 都声明「改算法必须两边同步」）⇒ 在CLI 侧单方面加固会让
 * 两侧**分叉**，而逐字对拍守护（`test/diff.test.mjs`）会当场红。那条路的正解是**框架侧
 * 一起改**（`attributes ?? {}` / `events ?? []`），属`src/` 语义变更，要走 spec §10 ——
 * **不在本稿范围**。这里在**消费侧**归一化，是零核心改动的正解。
 *
 * 归一化只补「缺省空容器」，**不改任何真值**：span 树、usage、rootSpanId、以及
 * **已存在的 events 一律原样保留**（⚠️ 把 `events` 清空是静默失真 —— 那样「事件序列
 * 差异」永远测不出来，而 diff 看起来仍然「正常」，比抛错更坏）。
 */
function normalizeForDiff(t: TraceLike): StrictTrace {
  return {
    ...t,
    spans: (t.spans ?? []).map((s) => ({
      ...s,
      attributes: s.attributes ?? {},
      // ⚠️ `TraceLike`（面板的宽松投影）**漏了`events` 字段** —— 运行时它是有的
      //（`POST /ingest` 收到的是裸 `Trace`），但类型上访问不到 ⇒ 只能按索引读。
      // `Array.isArray` 守卫是必要的：缺失时补 `[]`，**存在时原样保留**。
      events: Array.isArray((s as { events?: unknown }).events)
        ? (s as { events?: unknown }).events
        : [],
    })),
  } as unknown as StrictTrace;
}

/** token 的 cookie 名（面板首帧带 `?t=` 拿到它之后，后续请求自动带上） */
export const TOKEN_COOKIE = 'agentia_dev_token';
/** token 的自定义头名（非浏览器客户端 / 脚本用；不进 URL、不留痕） */
export const TOKEN_HEADER = 'x-agentia-token';

/**
 * 「我走了，把在飞的系统选择框收掉」的路径 —— 面板在 `pagehide` 时用 `sendBeacon` 打它。
 *
 * 为什么需要它（**不是锦上添花**）：只靠连接断开（`res.on('close')`）**漏得掉一个真实场景**。
 * 2026-09-23 实测（带插桩的产物副本 + 真浏览器）：刷新页面 / 卸载体之后，那条连接**还开着**
 * （`lsof` 上浏览器侧仍是 ESTABLISHED），服务端**收不到 close** ⇒ 在飞的选择框没人收、
 * 之后每次点「系统选择…」都 409。而 beacon 是**一次新的请求**，与服务端看不看得见断开无关。
 * 两条路互补：beacon 覆盖「页面自己知道要走了」（刷新 / 关标签页 / 跳走），
 * `res.on('close')` 覆盖「进程直接没了」（浏览器崩溃 / 被 kill / 非浏览器客户端断开）。
 *
 * 面板侧写的是**同一个字面量**（页面不能 import 本模块）⇒ `inspector.test.mjs` 有一条
 * 逐字对拍断言钉住两侧一致（与模板 `.env` 那条同款）。
 */
export const PICK_CANCEL_PATH = '/api/fs/pick/cancel';

/**
 * 路由直接读写的共享状态（**引用共享**：路由拿到的是 `inspector.ts` 里那个对象本身）。
 *
 * 为什么不做成模块级单例：一个进程里可能起多个 inspector（`inspector.test.mjs` 就并行起
 * 好几个）—— 模块级状态会让它们互相串台。所以状态由 `startInspector` 的闭包拥有、注入。
 */
export interface InspectorState {
  /** traceId → 整棵 trace */
  runs: Map<string, TraceLike>;
  /** 到达顺序（淘汰与列表排序都按它） */
  order: string[];
  /** CLI 侧记账（**有自己的上限**，见 `panel-logic` 的 `rememberNote`） */
  notes: Map<string, RunNote>;
  /** SSE 订阅者 */
  clients: Set<ServerResponse>;
}

/**
 * 每个请求一份的路由上下文。
 *
 * ⚠️ **鉴权不在这里**：Host / Origin / token 三道闸由 `inspector.ts` 的 handler 在调用
 * `handleRoutes` 之前做完 —— 本文件的每个 handler 都假定自己只在「已放行的请求」上跑。
 * 这条边界是有意的：把闸留在服务侧，路由才是一堆能被逐条读懂的「路径 → 应答」。
 */
export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** `url.pathname`（拆出来只为少写几次 `.pathname`） */
  path: string;
  /** 首帧 `?t=` 的原始值（`/` 种 cookie 用）；**校验已在上游做完** */
  queryToken: string | null;
  /** 配置的 dev token；`undefined` = 不校验（`/` 据此决定种不种 cookie） */
  token: string | undefined;
  /** dev 钩子；`undefined` = 只读面板（写接口一律 503/403） */
  dev: DevHooks | undefined;
  /** 环形缓冲 + SSE 订阅者 */
  state: InspectorState;
  /** run 环形缓冲上限（`/ingest` 淘汰用；与 `inspector.ts` 的 `MAX_NOTES` 同源） */
  maxRuns: number;
  json: (res: ServerResponse, code: number, body: unknown) => void;
  text: (
    res: ServerResponse,
    code: number,
    type: string,
    body: string,
    headers?: Record<string, string>,
  ) => void;
  readBody: (req: IncomingMessage, maxBytes?: number) => Promise<string>;
  parseRunRequest: (raw: unknown) => RunRequest;
  broadcast: (s: RunSummary) => void;
}

/**
 * `GET /api/fs` 一次最多回多少个**文件**名（目录不设限：一个位置要列几百个目录，本身就
 * 说明位置选错了）。超限回 `filesTruncated: true` —— 截断必须**明示**，不许静默少给。
 */
const FILE_LIMIT = 200;
/** 静态资源目录（构建期由 scripts/copy-assets.mjs 就位） */
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, 'inspector');
const PAGE = join(HERE, 'inspector-page.html');
/**
 * 静态资源白名单：**只有这里列出的名字**能被读出来。
 *
 * `panel-logic.js` 是 CLI 自己编译出来的模块（面板纯逻辑，单测直接 import 它），
 * 落在 dist 根而不是 dist/inspector/ —— 与 `inspector-page.html` 同处一层。
 */
const STATIC = new Map<string, string>([
  ['index.js', join(ASSETS, 'index.js')],
  ['view.js', join(ASSETS, 'view.js')],
  ['fromTrace.js', join(ASSETS, 'fromTrace.js')],
  ['summary.js', join(ASSETS, 'summary.js')],
  ['trace-view.css', join(ASSETS, 'trace-view.css')],
  /* 单文件 bundle（`agentia view` 内联进自包含 HTML 用）。⚠️ **页面不 import 它** ——
   * 面板仍走上面的分文件；它是 CLI 自己 readFile 后内联的（`src/view.ts`）。
   * 之所以还列进白名单：copy-assets 是**整树**拷 trace-view 的 dist ⇒ 它必然出现在
   * dist/inspector/，而 `structure.test.mjs` 的 W5 要求「dist/inspector 的每个文件都在
   * 白名单里」（防 trace-view 拆模块后浏览器 404 白屏）。与其放宽那条守卫的安全语义，
   * 不如显式批一个本来就公开的前端渲染器文件。 */
  ['trace-view.bundle.js', join(ASSETS, 'trace-view.bundle.js')],
  ['panel-logic.js', join(HERE, 'panel-logic.js')],
  // 面板的 Markdown 解析器（零依赖、按构造不产生 HTML —— 见 src/markdown.ts 的头注）。
  // 与 panel-logic.js 同处 dist 根：两个都是 CLI 自己编译出来的模块，单测直接 import 它们。
  ['markdown.js', join(HERE, 'markdown.js')],
]);

/** 入站校验：结构不符的 trace 直接拒（400），不让 NaN 之类的坏数据流进面板与 SSE 广播 */
function validateTrace(t: unknown): string | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'trace 必须是对象';
  const trace = t as TraceLike;
  if (typeof trace.traceId !== 'string' || trace.traceId.length === 0) return 'traceId 缺失';
  if (trace.spans !== undefined && !Array.isArray(trace.spans)) return 'spans 必须是数组';
  for (const s of trace.spans ?? []) {
    if (!s || typeof s !== 'object') return 'span 必须是对象';
    if (typeof s.spanId !== 'string' || s.spanId.length === 0) return 'span.spanId 缺失';
    if (typeof s.name !== 'string') return `span ${s.spanId} 缺 name`;
    if (typeof s.startedAt !== 'number' || !Number.isFinite(s.startedAt)) {
      return `span ${s.spanId} 缺 startedAt（必须是有穷 number）`;
    }
    if (s.endedAt !== undefined && (typeof s.endedAt !== 'number' || !Number.isFinite(s.endedAt))) {
      return `span ${s.spanId} 的 endedAt 非法`;
    }
  }
  return null;
}

/**
 * 入站校验：**增量记账事件**的形状（`POST /ingest-event`，① 实时右栏）。
 *
 * 为什么卡得比 `validateTrace` 还细：面板拿这些字段**直接建树**，而坏帧的报错现场在
 * 浏览器里（最难查的地方）。缺一个 `spanId` 的表现是「树上少一个节点」而不是任何报错 ——
 * 所以宁可在这里响亮拒（400 会被 runner 的 event sink 静默吞掉，但至少不会污染面板）。
 */
function validateTraceEvent(e: unknown): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return '事件必须是对象';
  const ev = e as TraceRecordEventLike;
  if (typeof ev.seq !== 'number' || !Number.isFinite(ev.seq)) return 'seq 必须是有穷 number';
  switch (ev.type) {
    case 'span.begin': {
      const s = ev.span;
      if (!s || typeof s !== 'object') return 'span.begin 缺 span';
      if (typeof s.spanId !== 'string' || s.spanId.length === 0)
        return 'span.begin 的 span.spanId 缺失';
      if (typeof s.traceId !== 'string' || s.traceId.length === 0) {
        return 'span.begin 的 span.traceId 缺失';
      }
      if (typeof s.name !== 'string') return 'span.begin 的 span.name 缺失';
      if (typeof s.startedAt !== 'number' || !Number.isFinite(s.startedAt)) {
        return 'span.begin 的 span.startedAt 非法';
      }
      return null;
    }
    case 'span.end': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0) return 'span.end 缺 spanId';
      if (typeof ev.endedAt !== 'number' || !Number.isFinite(ev.endedAt))
        return 'span.end 的 endedAt 非法';
      if (typeof ev.status !== 'string') return 'span.end 的 status 缺失';
      return null;
    }
    case 'span.event': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0) return 'span.event 缺 spanId';
      if (!ev.event || typeof ev.event.name !== 'string') return 'span.event 缺 event.name';
      return null;
    }
    case 'span.attribute': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0)
        return 'span.attribute 缺 spanId';
      if (typeof ev.key !== 'string' || ev.key.length === 0) return 'span.attribute 缺 key';
      return null;
    }
    case 'span.link': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0) return 'span.link 缺 spanId';
      return null;
    }
    default:
      return `不认识的事件类型：${String((ev as { type?: unknown }).type)}`;
  }
}

/**
 * 目录判定要**解引用软链**：pnpm store / monorepo 里 `src/tools/foo` 常是软链，
 * 它的 `isDirectory()` 为 false —— 直接用会把真目录静默漏掉（discover.ts 同一条教训）。
 */
function isDirLikeEntry(full: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/** 没有 dev 钩子时的状态（面板据此隐藏输入条） */
function unavailableDevState(): DevState {
  return {
    available: false,
    projectRoot: '',
    home: '',
    capabilities: [],
    multiTurn: [],
    warning: null,
    defaultWorkdir: '',
    budget: { ...DEFAULT_BUDGET },
    running: false,
    lastError: null,
    // 没有 dev 环 ⇒ 没有会话可谈（面板只在 available 时才读它）
    sessionId: '',
  };
}

function summarize(t: TraceLike, note: RunNote | null): RunSummary {
  const spans = t.spans || [];
  const root = spans.find((s) => s.kind === 'run') || spans[0];
  const startedAt = root ? root.startedAt : 0;
  const endedAt = root && root.endedAt != null ? root.endedAt : startedAt;
  const u = t.totalUsage || {};
  const status = t.status || root?.status || 'ok';
  const sid = root?.attributes?.['session.id'];
  // 收尾原因由引擎写在 run 根 span 的 `stop_reason` 上（`engine/loop.ts` 的
  // `recorder.setAttribute(rootId, 'stop_reason', …)`）—— 面板判中止**必须**看它，
  // 因为 `aborted` 的 `ok` 也是 false（见 `RunSummary.stopReason`）
  const sr = root?.attributes?.stop_reason;
  return {
    traceId: t.traceId,
    status,
    name: root ? root.name : 'run',
    startedAt,
    ms: endedAt - startedAt,
    tokens: (u.inputTokens || 0) + (u.outputTokens || 0),
    ok: status !== 'error',
    stopReason: typeof sr === 'string' && sr.length > 0 ? sr : null,
    sessionId: typeof sid === 'string' && sid.length > 0 ? sid : null,
    note,
  };
}

async function handleIngest(ctx: RouteCtx): Promise<void> {
  const body = await ctx.readBody(ctx.req); // 超 413 走外层 catch
  let trace: unknown;
  try {
    trace = JSON.parse(body);
  } catch {
    ctx.json(ctx.res, 400, { error: 'body 不是合法 JSON' });
    return;
  }
  const problem = validateTrace(trace);
  if (problem) {
    ctx.json(ctx.res, 400, { error: problem });
    return;
  }
  const valid = trace as TraceLike;
  const { runs, order, notes } = ctx.state;
  if (!runs.has(valid.traceId)) {
    order.push(valid.traceId);
    if (order.length > ctx.maxRuns) {
      const evicted = order.shift() as string;
      runs.delete(evicted);
      notes.delete(evicted);
    }
  }
  runs.set(valid.traceId, valid);
  ctx.broadcast(summarize(valid, notes.get(valid.traceId) ?? null));
  ctx.json(ctx.res, 200, { ok: true });
}

/**
 * **在飞 run 的增量记账事件**（① 实时右栏）：`POST /ingest-event`。
 *
 * 与 `POST /ingest` 的分工是刻意的两条缝（框架侧同名区分）：
 * - 这条 = **此刻看到**：高频、逐笔、不落库、**不保证送达**；
 * - 那条 = **最终账**：收尾一次、进 run 列表、被 `/api/runs` 读。
 *
 * 所以这里**只广播**、不建 run 记录：面板拿它把树「长」出来，收尾那份整棵 trace
 * 回来时覆盖（`open()` 的渲染永远以收尾那份为准）。
 *
 * 202 而不是 200：已经广播出去了，但面板收没收到不归这里管（SSE 是单向流）。
 * 没有 dev 钩子时回 503 —— 与 `/run` / `/run/abort` 同一口径（没有面板消费它）。
 */
async function handleIngestEvent(ctx: RouteCtx): Promise<void> {
  if (!ctx.dev) {
    ctx.json(ctx.res, 503, { error: '这个 inspector 不是 agentia dev 起的（没有 runner）' });
    return;
  }
  const body = await ctx.readBody(ctx.req);
  let ev: unknown;
  try {
    ev = JSON.parse(body);
  } catch {
    ctx.json(ctx.res, 400, { error: 'body 不是合法 JSON' });
    return;
  }
  const problem = validateTraceEvent(ev);
  if (problem) {
    ctx.json(ctx.res, 400, { error: problem });
    return;
  }
  ctx.dev.traceEvent(ev as TraceRecordEventLike);
  ctx.json(ctx.res, 202, { ok: true });
}

function handleListRuns(ctx: RouteCtx): void {
  const { runs, order, notes } = ctx.state;
  ctx.json(
    ctx.res,
    200,
    order
      .slice()
      .reverse()
      .map((id) => summarize(runs.get(id) as TraceLike, notes.get(id) ?? null)),
  );
}

function handleRunDetail(ctx: RouteCtx): void {
  const id = decodeURIComponent(ctx.path.slice('/api/runs/'.length));
  const t = ctx.state.runs.get(id);
  if (!t) {
    ctx.json(ctx.res, 404, { error: 'run 不存在（可能已被淘汰）' });
    return;
  }
  ctx.json(ctx.res, 200, t);
}

/**
 * 并排 A/B：`GET /api/runs/compare?a=<id>&b=<id>` → `{ diff, comparability }`。
 *
 * **为什么在服务端算diff，不在浏览器里算**：`diffTraces` 是框架的纯函数，而 CLI 侧
 * 已有一份**去类型移植副本**（`diff.ts`；CLI 零运行时依赖、不能 import 框架，注释
 * 声明「改算法必须两边同步」、逐字对拍守护在 `test/diff.test.mjs`）。复用那一份
 * 才能保证「面板里看到的差异」与「`agentia diff a.jsonl b.jsonl` 得到的差异」**逐字
 * 相同** —— 另写一份就是本仓反复踩的「两处口径会漂」。
 *
 * ⚠️ **可比性判据一起返回**（档 B §3.3）：`diffTraces` 不知道面板四个输入里哪些变了，
 * 跨了能力选择（app 级、重启进程）的两条 run 比出来的差异多半与用户改的那句话无关。
 * 服务端算完一起给，面板**必须**把它显示出来 —— 静默给一份没意义的 diff 比不给更糟。
 */
function handleRunCompare(ctx: RouteCtx): void {
  const a = ctx.url.searchParams.get('a');
  const b = ctx.url.searchParams.get('b');
  if (!a || !b) {
    ctx.json(ctx.res, 400, { error: '缺少 a 或 b 参数（各给一个 traceId）' });
    return;
  }
  if (a === b) {
    // 不是「无害的重复」：同一条跟自己比恒等于无差异，面板会显示一份「没有差异」的
    // 结论，而用户以为自己选了两条不同的 run。
    ctx.json(ctx.res, 400, { error: 'a 与 b 是同一条 run —— 选两条不同的才能比出差异' });
    return;
  }
  const { runs, notes } = ctx.state;
  // ⚠️ 两个 `get` 都要，**且都要用 `!` 显式收窄** —— 只查一次（`const ta = ...; if (!ta) 404`）
  // 之后 TS 不会把「另一个也非空」这件事带过 `return`（Map.get 的返回是 `| undefined`，
  // 与局部变量的控制流分析无关）。写成 `!ta || !tb` 才既短又能让 TS 收窄。
  const ta = runs.get(a);
  const tb = runs.get(b);
  if (!ta || !tb) {
    const missing = ta ? b : a;
    ctx.json(ctx.res, 404, { error: `run 不存在（可能已被淘汰）：${missing}` });
    return;
  }
  const noteA = notes.get(a) ?? null;
  const noteB = notes.get(b) ?? null;
  // 形状转换与 `diff.ts` 的 `readFirstTrace`（`:356`）**同款思路**（宽松投影 → 严格源类型），
  // 但**多一步 `normalizeForDiff`** —— 直接强转会在裁剪过的 trace 上 500（那里讲清了原因）。
  ctx.json(ctx.res, 200, {
    diff: diffTraces(normalizeForDiff(ta), normalizeForDiff(tb)),
    comparability: comparability(noteA, noteB),
    // note 一起回：面板要显示「这两条当时用了什么能力 / 在哪个目录」，
    // 否则一个「不可比」的结论没有上下文（用户不知道为什么这次比对不可信）。
    notes: { a: noteA, b: noteB },
  });
}

function handleDevState(ctx: RouteCtx): void {
  ctx.json(ctx.res, 200, ctx.dev ? ctx.dev.state() : unavailableDevState());
}

/**
 * 目录浏览器：`GET /api/fs?path=<绝对路径>` →
 * `{ path, parent, dirs, dotDirs, files, filesTruncated }`。
 *
 * 为什么需要它：浏览器**拿不到**用户选的文件夹的绝对路径 —— `<input webkitdirectory>`
 * 只给相对路径，File System Access API 只给 handle.name。而 dev 环要的是绝对路径
 * （工具按它解析）。⇒ 要么让用户手打路径，要么服务端列目录。后者才是「工作目录是
 * 主控件」（D3/D7）该有的手感。
 *
 * 三条口径（2026-09-22 复核后改，前两条是实测出来的缺口）：
 * - **文件也列**（`files`，只给名字、不读内容）：面板据此提供「选这个文件」——
 *   工作目录取它所在目录、prompt 空时填文件名。只列目录时，「让 agent 看某个文件」
 *   只能靠用户自己把文件名打进 prompt。
 * - **隐藏目录单列**（`dotDirs`，不在 `dirs` 里）：以前一批过滤掉，于是
 *   `~/xxx/.yyy` 这类目录**根本点不进去**（`..` 只能退到它上面，进不去）。
 *   单列是为了不把 `.git` / `.cache` 混进正常浏览，同时保证**可达**。
 * - `files` 有上限（`FILE_LIMIT`）并回 `filesTruncated`：一次列几千个文件的名
 *   没有意义，但**必须明示**截断（本仓纪律：不许静默少给）。
 *
 * 只列名字、**不读文件内容**；且只在 dev 钩子在场时开放（只读面板不暴露文件树）。
 * 越界不是威胁（本机 dev 工具，token 已经挡住了其它进程），但**不存在 / 不是目录**
 * 要响亮报错 —— 静默回退到项目根会让 agent 对着错的目录乱写（D5）。
 */
function handleFsList(ctx: RouteCtx): void {
  if (!ctx.dev) {
    ctx.json(ctx.res, 403, { error: '这个 inspector 不是 agentia dev 起的，不提供目录浏览' });
    return;
  }
  const target = ctx.url.searchParams.get('path');
  if (!target) {
    ctx.json(ctx.res, 400, { error: '缺少 path 参数' });
    return;
  }
  const abs = resolve(target);
  let entries: Dirent[];
  try {
    if (!statSync(abs).isDirectory()) {
      ctx.json(ctx.res, 400, { error: `不是文件夹：${abs}` });
      return;
    }
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    ctx.json(ctx.res, 400, { error: `读不了这个目录：${(e as Error).message}` });
    return;
  }
  const dirs: string[] = [];
  const dotDirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    if (isDirLikeEntry(join(abs, e.name), e)) {
      (e.name.startsWith('.') ? dotDirs : dirs).push(e.name);
      continue;
    }
    // 读不了内容的条目（管道 / socket / 权限）也当文件列出来 —— 列名字不需要读它
    if (!e.name.startsWith('.')) files.push(e.name);
  }
  ctx.json(ctx.res, 200, {
    path: abs,
    parent: dirname(abs),
    dirs: dirs.sort(),
    dotDirs: dotDirs.sort(),
    files: files.sort().slice(0, FILE_LIMIT),
    filesTruncated: files.length > FILE_LIMIT,
  });
}

/**
 * 原生文件夹选择框：`POST /api/fs/pick` → `{ path }`（取消时 `path: null`）。
 *
 * 浏览器拿不到所选文件夹的**绝对路径**，而 CLI 是本机进程 —— 替用户拉起 OS 原生
 * 选择框就是这条路由存在的理由（`GET /api/fs` 的「浏览…」是它的降级路径）。
 * 状态码：200 选中/取消；**409** 已有一个选择框在等（串行化在钩子里）；
 * **501** 平台不支持 / 命令缺失（报错文案指向降级路径）—— 两者都由钩子抛
 * HttpError，走外层 catch 的统一映射。与 /api/fs 同一条闸：只在 dev 钩子在场时开放。
 */
async function handleFsPick(ctx: RouteCtx): Promise<void> {
  const { res } = ctx;
  if (!ctx.dev) {
    ctx.json(res, 403, { error: '这个 inspector 不是 agentia dev 起的，不提供目录选择' });
    return;
  }
  // 客户端断开出口：等待选择期间用户刷新 / 关了标签页 ⇒ 桌面上的选择框没人看了，
  // 通知钩子收掉它（否则钩子里的「在飞」标志永远不落，之后每次点都 409）。
  // ⚠️ 判据用「是否还在 await」而不是只看 close：409/501 那条路会**立即**抛错走
  //    外层 catch，那时若再 cancel 会把**别人**的在飞选择框杀掉。
  let awaiting = false;
  res.on('close', () => {
    if (awaiting) ctx.dev?.cancelPick?.();
  });
  try {
    awaiting = true;
    const picked = await ctx.dev.pickFolder();
    awaiting = false;
    // 断开后的响应写入没有必要（也写不进去）—— 客户端已经走了
    if (!res.destroyed) ctx.json(res, 200, { path: picked });
  } finally {
    awaiting = false;
  }
}

/**
 * 面板自己说「我要走了」：`pagehide` 时的 beacon（见 `PICK_CANCEL_PATH` 的说明）。
 *
 * **幂等且无副作用**：机器侧 `picking=false` 时它就是一个空操作（没有在飞的选择框可收），
 * 所以在飞／不在飞都安全 —— 面板因此可以**无条件**发它，不必先判断自己有没有在等。
 * 与其余 fs 路由同一条闸：没有 dev 钩子（statically 起的 inspector）一律 403。
 */
async function handleFsPickCancel(ctx: RouteCtx): Promise<void> {
  if (!ctx.dev) {
    ctx.json(ctx.res, 403, { error: '这个 inspector 不是 agentia dev 起的，不提供目录选择' });
    return;
  }
  // beacon 是即发即弃的：响应体没人读，但仍然照常回（脚本直连时能看到语义）
  ctx.dev.cancelPick?.();
  ctx.json(ctx.res, 200, { cancelled: true });
}

async function handleRun(ctx: RouteCtx): Promise<void> {
  if (!ctx.dev) {
    ctx.json(ctx.res, 503, {
      error: '这个 inspector 不是 agentia dev 起的（没有 runner），不能驱动 run',
    });
    return;
  }
  const body = await ctx.readBody(ctx.req);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    ctx.json(ctx.res, 400, { error: 'body 不是合法 JSON' });
    return;
  }
  const ack = await ctx.dev.run(ctx.parseRunRequest(raw));
  ctx.json(ctx.res, 202, ack);
}

async function handleAbort(ctx: RouteCtx): Promise<void> {
  if (!ctx.dev) {
    ctx.json(ctx.res, 503, { error: '这个 inspector 不是 agentia dev 起的（没有 runner）' });
    return;
  }
  // 202 而不是 200：中止是**请求已受理**，run 真正收尾要走 SSE 的 `run-done`
  // （优雅路径要在回合边界才生效，不是同步的）。
  ctx.json(ctx.res, 202, await ctx.dev.abort());
}

async function handleSessionClear(ctx: RouteCtx): Promise<void> {
  if (!ctx.dev) {
    ctx.json(ctx.res, 503, { error: '这个 inspector 不是 agentia dev 起的（没有 runner）' });
    return;
  }
  ctx.json(ctx.res, 200, await ctx.dev.clearSession());
}

async function handleSession(ctx: RouteCtx): Promise<void> {
  if (!ctx.dev) {
    ctx.json(ctx.res, 200, { session: null });
    return;
  }
  ctx.json(ctx.res, 200, { session: await ctx.dev.session() });
}

function handleStream(ctx: RouteCtx): void {
  const { req, res } = ctx;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  ctx.state.clients.add(res);
  req.on('close', () => ctx.state.clients.delete(res));
}

async function handlePage(ctx: RouteCtx): Promise<void> {
  // 首帧带了合法 token ⇒ 种进 cookie（SameSite=Strict + HttpOnly）：
  // 之后面板自己的 fetch / EventSource 自动带上，token 不进 URL 历史、不进截图。
  const headers: Record<string, string> =
    ctx.token !== undefined && ctx.queryToken !== null
      ? { 'set-cookie': `${TOKEN_COOKIE}=${ctx.token}; Path=/; HttpOnly; SameSite=Strict` }
      : {};
  ctx.text(ctx.res, 200, 'text/html; charset=utf-8', await readFile(PAGE, 'utf8'), headers);
}

async function handleStatic(ctx: RouteCtx): Promise<void> {
  const name = ctx.path.slice(1);
  const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
  ctx.text(ctx.res, 200, type, await readFile(STATIC.get(name) as string, 'utf8'));
}

/**
 * 路由分发：按（方法, 路径）分派给上面的命名 handler，最后落到兜底 404。
 *
 * 调用方（`inspector.ts` 的 handler）已经做完 Host / Origin / token 三道闸 ——
 * 本函数只管**路由**，不再鉴权。handler 里 `await` 到的 `HttpError`（由 `DevHooks`
 * 的实现抛出，如 `pickFolder` 的 409/501）会**穿过本函数**冒泡给调用方的 catch，
 * 由那里统一映射成状态码。
 *
 * ⚠️ 顺序即优先级：`/api/runs` 必须排在 `/api/runs/` 之前（后者是前缀匹配），
 * **而 `/api/runs/compare` 必须排在 `/api/runs/` 之前** —— 它是那条前缀的**子路径**，
 * 放后面会被 `handleRunDetail` 先吃掉，而那个 handler 会把 `compare?a=…&b=…`
 * 整段当成 traceId 去查表 ⇒ 恒 404，且报错信息是「run 不存在」，完全指错方向。
 * （`ctx.path` 是 `url.pathname`、**不含** query，所以前缀匹配按 `/api/runs/compare` 判。）
 */
export async function handleRoutes(ctx: RouteCtx): Promise<void> {
  const { req, path } = ctx;
  if (req.method === 'POST' && path === '/ingest') return handleIngest(ctx);
  if (req.method === 'POST' && path === '/ingest-event') return handleIngestEvent(ctx);
  if (req.method === 'GET' && path === '/api/runs') return handleListRuns(ctx);
  // ⚠️ 顺序咬人：`compare` **必须**在下一行之前 —— 它是 `/api/runs/` 的子路径，
  // 放后面会被 `handleRunDetail` 先吃掉（traceId 变成 "compare" ⇒ 恒 404 且报错指错方向）。
  if (req.method === 'GET' && path === '/api/runs/compare') return handleRunCompare(ctx);
  if (req.method === 'GET' && path.startsWith('/api/runs/')) return handleRunDetail(ctx);
  if (req.method === 'GET' && path === '/api/dev') return handleDevState(ctx);
  if (req.method === 'GET' && path === '/api/fs') return handleFsList(ctx);
  if (req.method === 'POST' && path === '/api/fs/pick') return handleFsPick(ctx);
  // 面板卸载时的显式收口（`pagehide` beacon）—— 必须与上一条**并列**存在，不是替代关系：
  // 断开那条路在浏览器刷新时看不见（见 PICK_CANCEL_PATH 的说明）。
  if (req.method === 'POST' && path === PICK_CANCEL_PATH) return handleFsPickCancel(ctx);
  if (req.method === 'POST' && path === '/run') return handleRun(ctx);
  if (req.method === 'POST' && path === '/run/abort') return handleAbort(ctx);
  if (req.method === 'POST' && path === '/session/clear') return handleSessionClear(ctx);
  if (req.method === 'GET' && path === '/api/session') return handleSession(ctx);
  if (req.method === 'GET' && path === '/stream') return handleStream(ctx);
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) return handlePage(ctx);
  if (req.method === 'GET' && STATIC.has(path.slice(1))) return handleStatic(ctx);
  ctx.json(ctx.res, 404, { error: 'not found' });
}
