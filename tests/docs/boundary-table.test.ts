/**
 * `usage-guide.md` §7「已知边界」的守卫（2026-09-26）。
 *
 * ## 为什么需要它
 *
 * §7 是一张 **93 行**的表，逐条说明框架**不保证什么**。它是使用者判断「我能不能用这个框架」
 * 的唯一依据 —— 也是仓库里**最厚的一张对外承诺表**。
 *
 * 而它此前**零守卫**，且是被解析器**结构性**排除的：`usage-guide.test.ts` 的 `parseTables`
 * 只采集「首列**恰好是一个反引号标识符**」的行（那条规则服务于字段名对账），§7 的首列是散文
 * ⇒ **整表零采集**。本仓给导出面、旧术语、帧名、提交引用、官网版式都立了守卫，唯独没有这页。
 *
 * 退化的样子：某天有人实现了出站注入、换了默认 client、改了 store 的幂等档位或指标口径，
 * 表里那几行就**变成假话而全绿**。这与本仓记过的「假守卫」是同一失败类（断言是真的、绿的，
 * 只是它守的是另一件事），而这一处更隐蔽 —— **连断言都没有**。
 *
 * ## 四条判据（全部机械可判）
 *
 * - **A1 标识符不悬空**：§7 里每个反引号 token 都要指向真实存在的东西 —— 纯标识符
 *   （`^[A-Za-z_$][\w$]*$`）**逐字**必须出现在源码语料里；复合写法（调用形状 / 路径 / JSON 指针）
 *   允许其**首段或末段**命中（`ctx.delete` 是使用方写法，框架里是 `RunContext.delete`）。
 *   ⚠️ 边界：`id` / `name` / `ok` 这类短通用标识符在拼接语料里**几乎恒真** ——
 *   A1 的实际防漂移能力集中在长/特异标识符上，别把这条读成「每个 token 都被真核」。
 * - **A2 行集合 == 登记表**：双向。新写一条边界不登记 ⇒ 红；删了边界留登记 ⇒ 红。
 * - **A3 `pin` 可证伪**：`{ file, marker }` —— 文件必须在场，且 `marker` 必须真的出现在
 *   该文件里（用例文件里要求落在某条 `it(...)` 的标题内）。⇒ 「我钉的是哪条用例」是**写下来**
 *   且**机械可验**的，不是我说了算。
 * - **A4 三态在场且有下限**：`pin` / `choice`（设计选择，带理由）/ `gap`（机制有测试，
 *   但「这条边界仍然成立」这句话本身没有任何东西可证伪 —— 附最可能接上的用例）。
 *
 * ## `gap` 是什么、不是什么
 *
 * 它**不是「功能缺失」**，而是「这句话今天为真、明天可能为假，而没人会发现」。
 * 这份清单是 §7 的「下一次 review 从这里开始」，与 `docs/guards.md §2 待守` 同一哲学。
 *
 * ## 已知限制（如实标注）
 *
 * - `gap` 的判定是**本轮的读法**，不是仓库已声明的候选。规则：该行声称的机制有没有用例
 *   （机械可查）+ 有没有用例钉住**这句话**（读用例标题判）。标 `gap` 的行都给了候选文件。
 * - **行文改动会让守卫红**（key 是首列的归一形态）。这是**有意**的：一条边界的措辞改了
 *   就是它的断言口径改了，本来就该重读登记项。报错文案直接给出「请更新登记表」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GUIDE = join(ROOT, 'docs/usage-guide.md');

/** §7 的起止锚（改标题会让本文件红 —— 那是期望行为，一起改） */
const SECTION_START = '## 7. 已知边界';
const SECTION_END = '## 8.';

/** 源码语料：§7 里的 token 必须指向这里真实存在的东西 */
const CORPUS_DIRS: ReadonlyArray<[string, string[]]> = [
  ['src', ['.ts', '.html']],
  ['packages/cli/src', ['.ts', '.html']],
  ['packages/cli/test', ['.mjs', '.js']],
  ['packages/trace-view/src', ['.js']],
  ['tests', ['.ts', '.mjs']],
  ['scripts', ['.ts', '.mjs', '.sh']],
  ['packages/website/src', ['.astro', '.html', '.ts']],
];

/** 归一化首列 → 登记表的 key（去 markdown 记号、压空白；行文改动会让对应登记项找不到） */
function rowKey(firstCell: string): string {
  return firstCell.replace(/\\\|/g, '|').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
}

interface Row {
  key: string;
  line: number;
  text: string;
}

function parseBoundaryRows(): Row[] {
  const lines = readFileSync(GUIDE, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(SECTION_START));
  assert.ok(start >= 0, `找不到 ${SECTION_START} —— §7 被改名或删掉了`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith(SECTION_END));
  assert.ok(end > start, `找不到 ${SECTION_END} —— §7 与第 8 节之间结构变了`);

  const rows: Row[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (/^\|[\s:\-|]+\|$/.test(line.trim())) continue; // 分隔行
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (cells.length < 2) continue;
    const first = cells[0].trim();
    if (first === '边界') continue; // 表头
    rows.push({ key: rowKey(first), line: i + 1, text: line });
  }
  return rows;
}

function corpusText(): string {
  const parts: string[] = [];
  for (const [dir, exts] of CORPUS_DIRS) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const rel of walk(base)) {
      if (rel.includes('node_modules') || rel.includes('/dist/')) continue;
      if (!exts.some((e) => rel.endsWith(e))) continue;
      parts.push(readFileSync(rel, 'utf8'));
    }
  }
  parts.push(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return parts.join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 一条边界 ↔ 守卫的登记项 */
type Entry =
  | { key: string; pin: { file: string; marker: string } }
  | { key: string; choice: string }
  | { key: string; gap: string; candidate: string };

/**
 * 登记表（93 条，与 §7 的行一一对应；2026-09-29 复核：7 条 gap 已回填为 pin；2026-10-12
 * 新增 1 条 choice：OTLP trace 导出只发 JSON）。
 *
 * `pin` 的 `marker` 是目标用例 `it(...)` 标题里的**一段原文**（或脚本里的原文），
 * A3 会逐条断言它在场 —— 引用一条其实不相关的用例会当场红。
 */
const REGISTRY: ReadonlyArray<Entry> = [
  {
    key: '方法入参要自己标注',
    choice: 'TS 语言事实：不从 JSON Schema 反推形参类型；strict 下不标注即隐式 any',
  },
  {
    key: '裸 schema 不校验签名',
    gap: '裸 schema 时方法签名与 schema 互不关联这件事，没有用例钉住',
    candidate: 'tests/toolkit/zod.test.ts',
  },
  { key: '黑板键默认无类型', choice: '类型层取舍：不合并 Blackboard 就是裸 string + unknown' },
  { key: '没有「能力清单」类型', choice: 'API 形状决策：能力由装饰器注册表在运行时收集' },
  {
    key: 'strict 只是透传',
    pin: {
      file: 'tests/toolkit/collect.test.ts',
      marker: '@Tool：收集方法、绑定 this、schema/strict 透传',
    },
  },
  {
    key: 'schema 校验是子集',
    pin: { file: 'tests/core/schema.test.ts', marker: '未覆盖的关键字放行（护栏不是完整校验器）' },
  },
  {
    key: '历史畸形就放弃裁剪',
    pin: {
      file: 'tests/engine/trimming.test.ts',
      marker: 'trimToolPairs：非严格交替（连续两条 assistant 带 tool_use）→ 放弃裁剪，不切出孤立块',
    },
  },
  {
    key: '同键去重的能力边界',
    pin: {
      file: 'tests/transport/async.test.ts',
      marker: '幂等键去重（异步 store）：同键在飞时并发提交只执行一次',
    },
  },
  {
    key: '增量出口与 sink 是两条缝',
    gap: '「onTraceEvent 不保证送达」这半句没有用例钉住（sink 那半有）',
    candidate: 'tests/engine/trace-events.test.ts',
  },
  {
    key: '任务进度流的边界（内存 / 跨进程）',
    pin: {
      file: 'tests/transport/taskStream.test.ts',
      marker: '跨进程（同一 store、另一 runner）：stream.unavailable + task.end，不假装实时',
    },
  },
  {
    key: '异步任务的排队段边界（内存）',
    pin: {
      file: 'tests/transport/max-queued.test.ts',
      marker: '排队满 → submit 同步抛 TaskQueueFullError（status 503）；额度内的每一条都真的受理',
    },
  },
  {
    key: 'traceLimits 与 maxEventChars 各管一头',
    pin: {
      file: 'tests/engine/trace-limits.test.ts',
      marker: '超限即停止记账，并在 run 根留两笔 trace.truncated（起点标记 + 收尾摘要，不静默）',
    },
  },
  {
    key: '采样是导出决策，不是记账决策',
    choice: '采样刻意不内建（配方见 observability.md 2.3）；被采样掉的 trace 在框架内仍完整记账',
  },
  {
    key: '`approve` 只收**待决的** id（多一个 → 400 整批拒）',
    pin: {
      file: 'tests/transport/approve-limits.test.ts',
      marker: '多出来的 id ⇒ 整批拒（400），记录**一字不动**（不写进 approvals、状态不变）',
    },
  },
  {
    key: '`TaskRecord.approvals` 有界但**不清**',
    choice:
      '有意为之的取舍：单次 approve 能写的键被钉在当前 pendingApprovals 里（单次输入无法放大体积；跨轮累计历次待决的并集，增长只随真实运行）⇒ 天然有界（**不加**常量上限 —— 那会是永远触发不到的死代码）；终态也不清 —— 审批记录是审计的一部分',
  },
  {
    // 2026-09-29 复核：原先登记为 gap，实为**写下时就错** —— 「缺省不限（旧行为）：不淘汰」
    // 用例在登记日之前 16 天就已存在（working memory 记的抽样证据）。回填为 pin。
    key: '缺省内存 store 不淘汰',
    pin: { file: 'tests/store/memoryStore.test.ts', marker: '缺省不限（旧行为）：不淘汰' },
  },
  {
    // 2026-09-29 复核：同「缺省内存 store 不淘汰」—— 用例早于登记 11 天，回填为 pin。
    // 该用例钉住 §7 括号里的「装配期校验，名字不存在即抛错」。
    key: '能力引用两种粒度',
    pin: {
      file: 'tests/toolkit/module.test.ts',
      marker: '@SubAgent tools 引用未注册 provider → 装配期抛错（不延迟到运行时）',
    },
  },
  {
    key: '能力名有格式校验',
    pin: {
      file: 'tests/toolkit/module.test.ts',
      marker: '非法装饰器能力名在 createApp 即抛可读错误（不延迟到首次模型调用 400）',
    },
  },
  {
    key: 'discover 入口会回落',
    pin: {
      file: 'tests/toolkit/discover.test.ts',
      marker: '.ts 与编译产物并存：首选失败时回落下一候选并留告警',
    },
  },
  {
    key: 'asset() 的 rel 必须是相对路径',
    pin: {
      file: 'tests/toolkit/discover.test.ts',
      marker: '带 scheme 的 rel 显式拒绝（new URL 会整个忽略 base，静默读到别处）',
    },
  },
  {
    key: '取消要传进客户端才有效',
    gap: '自定义 ModelClient 不转发 signal 时只能「放弃等待」这半句没有用例钉住',
    candidate: 'tests/integrations/anthropic.test.ts',
  },
  {
    key: '默认 client 的真端点验证范围',
    gap: '「mock 全绿发现不了厂商真实行为」是这条边界本身，没有东西能证伪它',
    candidate: 'scripts/e2e-live.ts',
  },
  {
    key: 'thinking 块「能收、不主动请求」',
    pin: {
      file: 'tests/integrations/anthropic.test.ts',
      marker: 'thinking 块：thinking_delta 收拼、signature_delta 累积进 signature',
    },
  },
  {
    key: '工具阶段的 abort 有盲区',
    gap: '挂死工具在 abort 之后仍不返回这个盲区没有用例钉住',
    candidate: 'tests/engine/tool-context.test.ts',
  },
  {
    key: '观测失败被吞',
    pin: {
      file: 'tests/runtime/sinks.test.ts',
      marker: 'sink 抛错：run 结果不受影响，且不阻断后续 sink（吞错）',
    },
  },
  {
    key: '框架不自动读 .env',
    gap: '「除 AGENTIA_MODEL / OPENAI_API_KEY 外不翻环境变量」没有用例钉住',
    candidate: 'packages/cli/test/templates.test.mjs',
  },
  { key: '鉴权只是缝', choice: '策略是宿主 / 反代的事：框架只承诺「拦在入口、读 body 之前」' },
  {
    key: '运行时是 Node',
    pin: { file: 'scripts/check-import-floor.mjs', marker: '需要 Node ≥ 22' },
  },
  {
    key: '停机不由框架触发',
    gap: '「框架不订阅 SIGTERM / SIGINT」没有用例钉住（`drain()` 那半有）',
    candidate: 'tests/transport/host-hardening.test.ts',
  },
  {
    key: '停机可能切断 SSE',
    pin: {
      file: 'tests/transport/host-hardening.test.ts',
      marker: '收口长连 SSE：drain 会关掉仍挂着的流，并中止对应 run（不再后台空烧 token）',
    },
  },
  {
    key: '`drain()` 之后本进程不再推进任何任务（单向闩）',
    pin: {
      file: 'tests/transport/drain-race.test.ts',
      marker: '拒绝要出声（不静默）：停机窗口里被拒的派发打一条 warn —— 且只有一条',
    },
  },
  {
    key: '鉴权失败即断连',
    gap: '未通过鉴权时 connection: close 这条没有用例钉住',
    candidate: 'tests/transport/httpApproval.test.ts',
  },
  {
    // 2026-09-29 复核：**只覆盖了半句**。前半句「一回合记账完才判」已由 budget.test.ts
    // 那条「工具执行期间…回合入口再判拦住」用例钉住（超支发生在工具执行期间 ⇒ 下一回合入口拦）；
    // 仍 gap 的是后半句：并行子循环（一回合多个子 agent）各自过闸、超支上限是「每个在飞分支
    // 各一个回合」而非「总共一个回合」—— budget.test.ts 里没有并行分支用例。
    key: '预算护栏不是硬实时',
    gap: '「并行子循环（一回合多个子 agent）各过各的闸、超支上限是『每个在飞分支各一个回合』」这半句没有用例钉住（前半句「一回合记账完才判」已由 budget.test.ts 覆盖）',
    candidate: 'tests/engine/budget.test.ts',
  },
  {
    key: 'maxCostUsd 依赖价格表',
    pin: {
      file: 'tests/integrations/metrics.test.ts',
      marker: '未定价 turn 计入 unpricedTurns（成本护栏失效的显式信号）',
    },
  },
  {
    key: '价格表按模型名精确匹配',
    pin: {
      file: 'tests/engine/pricing.test.ts',
      marker: '模型名是精确匹配：带日期后缀的 id 与不带日期的别名互不相通',
    },
  },
  {
    key: '缓存写的缺省乘数只对 5 分钟 档正确',
    pin: {
      file: 'tests/engine/pricing.test.ts',
      marker: '乘数可逐模型覆盖：ttl 1h 的写 2× / Opus 5.5 的读 0.05×',
    },
  },
  {
    key: '图片块的 token 只能估、且按上界估',
    pin: {
      file: 'tests/engine/trimming.test.ts',
      marker: '估算不随 base64 长度增长（图片按尺寸上界，不按文件字节数）',
    },
  },
  {
    key: '工具超时不强制取消工具',
    pin: {
      file: 'tests/engine/tool-context.test.ts',
      marker: '必填四项原样在场（client / recorder / parentSpanId / abandoned）',
    },
  },
  {
    key: '会话只存对话轮次',
    pin: {
      file: 'tests/transport/async.test.ts',
      marker: '带 session 的任务挂起 → 批准 → 成功：恢复段 messages 无重复历史；会话只多一轮对话',
    },
  },
  {
    key: '同 session 并发 run 要自行串行化',
    gap: '并发写同一 sessionId 撞角色交替校验（400）没有用例钉住',
    candidate: 'tests/runtime/session.test.ts',
  },
  {
    // 2026-09-29 复核：用例已在场（此前登记为 gap）⇒ 回填为 pin。
    key: 'OpenAI 适配器听端点的话',
    pin: {
      file: 'tests/integrations/openaiStream.test.ts',
      marker: '端点忽略 stream:true 直接回 JSON → 自动退回 JSON 路径（不炸）',
    },
  },
  {
    key: 'OpenAI 流式的上游故障按失败处理',
    pin: {
      file: 'tests/integrations/openaiStream.test.ts',
      marker:
        '流被提前截断（已吐出半句、无 [DONE]、无 finish_reason）→ 抛错，不得报成 end_turn 成功',
    },
  },
  {
    key: 'OpenAI 兼容端点回 legacy function_call 形态时**不支持**',
    pin: {
      file: 'tests/integrations/openai.test.ts',
      marker: 'legacy function_call 形态：响亮失败，不得报成 end_turn 把工具调用丢掉',
    },
  },
  { key: 'MCP 只做 tools', choice: 'YAGNI（spec §10）：sampling / resources / prompts 原语不做' },
  {
    key: 'MCP 反向桥不校验会话（无状态 server）',
    pin: {
      file: 'tests/engine/mcp-server.test.ts',
      marker: 'initialize 响应带 mcp-session-id；后续**不带**该头的请求照常服务（无状态宽容）',
    },
  },
  {
    key: 'MCP 的协议层错误框架看不见',
    pin: {
      file: 'tests/integrations/mcpConnector.test.ts',
      marker: '协议层 isError 转成抛错 —— 否则模型与 trace 都会以为这调用成功了',
    },
  },
  {
    key: 'MCP 超时同样是「不等了」',
    pin: {
      file: 'tests/integrations/mcp.test.ts',
      marker: '单一裁判：引擎设了 toolTimeoutMs ⇒ 桥的 timeoutMs 不参与判定（更短也不抢）',
    },
  },
  {
    key: '已中止的 MCP 调用不发请求',
    pin: {
      file: 'tests/integrations/mcpConnector.test.ts',
      marker: '信号已中止：不发送、立即 AbortError 收场，且连接器仍可用',
    },
  },
  {
    // 2026-09-29 复核：用例已在场（此前登记为 gap）⇒ 回填为 pin。
    key: 'MCP 连接器的超时只管装配期',
    pin: {
      file: 'tests/integrations/mcpConnector.test.ts',
      marker: 'tools/call 不起第二个计时器：超过连接器 timeoutMs 的调用照常等完（裁判是引擎）',
    },
  },
  {
    key: 'MCP 连接的 close() 保证子进程已终止',
    pin: {
      file: 'tests/integrations/mcpConnector.test.ts',
      marker: 'close() 返回时子进程**已被回收**（连忽略 SIGTERM 的 server 也照杀）',
    },
  },
  {
    key: 'StreamableHTTP 会话过期自愈',
    pin: {
      file: 'tests/integrations/mcpConnector.test.ts',
      marker: '会话过期（404）→ 自动重握手并把**这一次**重试一次（自愈成功）',
    },
  },
  {
    key: 'MCP 名字可能被归一化',
    pin: {
      file: 'tests/integrations/mcp.test.ts',
      marker: '模型调归一化名 → 桥回调用**原名** → 结果回模型，且原名落进 turn attribute',
    },
  },
  {
    key: 'MCP 工具不能进 DI 容器',
    gap: '「没有 provider token、不能被别的能力引用」没有用例钉住',
    candidate: 'tests/integrations/mcp.test.ts',
  },
  {
    key: '指标分位是窗口内精确值',
    pin: {
      file: 'tests/integrations/metrics.test.ts',
      marker: '分位是窗口内精确值（最近 rank 法），根未收尾的 run 不进延迟样本',
    },
  },
  {
    key: '指标是进程内累加',
    gap: '「不做分布式聚合、重启即清零」没有用例钉住',
    candidate: 'src/integrations/metrics-state.ts',
  },
  {
    // 2026-09-29 复核：candidate 原指向 src 源码（等于自认没有用例），实为**写下时就错** ——
    // metrics.test.ts「reset 之后导出…窗口起点严格前移（CUMULATIVE 不得倒退）」用例体注释
    // 明确测的就是 OTLP CUMULATIVE 在同一 startTime 下 counter 不得倒退。回填为 pin。
    key: 'OTLP metrics 只推当前累计',
    pin: {
      file: 'tests/integrations/metrics.test.ts',
      marker: 'reset 之后导出：值回到 1，且窗口起点严格前移（CUMULATIVE 不得倒退）',
    },
  },
  {
    key: 'OTLP trace 导出**只发 JSON**（直打 Phoenix 会 415）',
    choice:
      '零运行时依赖 > 内建 protobuf 编码器（手写 varint/length-delimited 几百行进核心不值）；处置是缝外配方 —— collector 收 JSON 转 binary（docs/observability.md §7）',
  },
  {
    key: 'GET /metrics 不鉴权',
    pin: {
      file: 'tests/transport/metricsRoute.test.ts',
      marker: '与 /healthz 同档：**不鉴权**（鉴权钩子不会被调用）',
    },
  },
  {
    // 2026-09-29 复核：candidate 原指向 report.test.ts，但真正逐字钉住「工具没有 token/成本」
    // 的是 metrics.test.ts 那条（用例体含 `// 工具没有 token 语义 → 不产出 token/cost 行`
    // 与显式正则负断言）。回填为 pin。
    key: '工具没有 token/成本指标',
    pin: {
      file: 'tests/integrations/metrics.test.ts',
      marker: 'snapshot().capabilities 给排序无关的键值视图；工具 tokens/costUsd 为 null',
    },
  },
  {
    key: '@Prompt 没有能力指标',
    gap: '「资产类能力不建 span、不进能力排行」没有用例钉住',
    candidate: 'tests/integrations/metrics.test.ts',
  },
  {
    key: '能力标签有基数上限',
    pin: {
      file: 'tests/integrations/metrics.test.ts',
      marker: 'maxCapabilities 上限：新能力归 __other__，droppedCapabilities 记被归并的不同能力数',
    },
  },
  {
    key: '模型 / 评分维度也有基数上限',
    pin: {
      file: 'tests/integrations/metrics.test.ts',
      marker: 'maxModels=1 + 3 个模型 → 三个 *_dropped_keys gauge，且折叠数对得上 snapshot',
    },
  },
  {
    key: '提示词版本只是标记',
    pin: {
      file: 'tests/runtime/systemPrompt.test.ts',
      marker: 'SystemPrompt({ version }) 暴露只读 version；不传则 undefined，add 不改它',
    },
  },
  {
    key: 'agentia harvest 的产物是轨迹骨架',
    gap: '「用例脚本里的 text 块是占位」没有用例钉住（移植对拍有）',
    candidate: 'packages/cli/test/harvest.test.mjs',
  },
  {
    key: '分叉重放不是续跑',
    gap: '「起的是新 run，不是接着原 run 的循环位置」没有用例钉住',
    candidate: 'tests/engine/fork.test.ts',
  },
  {
    key: '评分来自 run 之外',
    gap: '「attachScore 找不到根 span 时静默忽略」没有用例钉住',
    candidate: 'tests/integrations/metrics.test.ts',
  },
  {
    // 2026-10-12：SEP-414 落地后「出站只给读取器」多了 MCP 桥这个例外（桥自己发 tools/call
    // 请求 ⇒ 它能注入 params._meta.traceparent）—— 首列措辞与登记 key 同步改过。
    key: '链路关联：入站自动、出站默认只给读取器（MCP 桥除外）',
    pin: {
      file: 'tests/engine/traceLink.test.ts',
      marker: '不给 traceContext：run 根**没有** links 字段（不是空数组）',
    },
  },
  {
    key: '配额不是框架子系统',
    choice: '只给缝（middleware + TraceSink + BudgetGuard）：计数放哪与超限怎么办都是宿主的策略',
  },
  {
    key: '人工审批两种形态',
    pin: {
      file: 'tests/transport/approval.test.ts',
      marker:
        'approve → 恢复 → 成功：框架回填 decidedAt/requestedAt；恢复段 trace 经 link 挂到上一段',
    },
  },
  {
    key: '审批超时是**惰性**判定',
    pin: {
      file: 'tests/transport/approval.test.ts',
      marker: 'approvalTimeoutMs：惰性判定 —— 读到一个已超时的挂起任务 ⇒ 自动全拒并重派',
    },
  },
  {
    key: '挂起段与恢复段是两棵 trace',
    pin: {
      file: 'tests/transport/approval.test.ts',
      marker:
        'approve → 恢复 → 成功：框架回填 decidedAt/requestedAt；恢复段 trace 经 link 挂到上一段',
    },
  },
  {
    key: '审批是 at-least-once',
    gap: '「批准后恢复执行中崩溃 ⇒ 副作用工具会重执行」没有用例钉住',
    candidate: 'tests/transport/approval.test.ts',
  },
  {
    key: '挂起/恢复间预算重新起算',
    gap: '「恢复段从 0 重新计」没有用例钉住',
    candidate: 'tests/transport/async.test.ts',
  },
  {
    key: '恢复段的会话回写是进程内快照',
    gap: '「崩在挂起与 approve 之间会丢一次会话回写」没有用例钉住',
    candidate: 'tests/transport/async.test.ts',
  },
  {
    key: '嵌套能力内的审批不支持挂起',
    gap: '「子循环里的 approval 无法挂起整个 run」没有用例钉住',
    candidate: 'tests/transport/httpApproval.test.ts',
  },
  {
    // 2026-09-29 复核：用例已在场（此前登记为 gap）⇒ 回填为 pin。http-shapes 用
    // `Object.keys(body).sort()` 断言**恰好这 7 个键** ⇒ 等价于「响应体不含 suspendedMessages」。
    key: '同步 /run 撞上审批没人可批',
    pin: {
      file: 'tests/transport/http-shapes.test.ts',
      marker: '7 个字段全在场（typed / error 为 undefined 也在场）',
    },
  },
  {
    key: 'Scheduler 调度表不落库',
    gap: '「未来某刻再触发」的调度在重启后不存在，没有用例钉住',
    candidate: 'tests/transport/scheduler.test.ts',
  },
  {
    key: 'file store 的撕裂写只在启动时自愈',
    pin: {
      file: 'tests/store/fsStore.test.ts',
      marker: '尾部残行自愈：半截 JSON 截掉后，新记录不会与残行粘成一行',
    },
  },
  {
    key: '终态落库失败 ⇒ 重启会重跑',
    pin: {
      file: 'tests/transport/async.test.ts',
      marker: '终态落库失败：onPersistError 必须收到（不再静默），且库里确实停在 running',
    },
  },
  {
    key: 'contextPolicy 不进子循环',
    gap: '「应用级 contextPolicy 只对主循环生效」没有用例钉住',
    candidate: 'tests/engine/run-config.test.ts',
  },
  {
    key: '记忆没有删除语义',
    gap: '「ctx.delete 掉的键下一轮水合会复活」没有用例钉住',
    candidate: 'tests/runtime/memory.test.ts',
  },
  {
    key: '同 keys 的并发回写不合并',
    pin: {
      file: 'tests/runtime/memory.test.ts',
      marker: '并发丢写被抓：读之后别人写过同一份 store ⇒ 本次回写被拒、一个字都不写、并出声',
    },
  },
  {
    key: '内容护栏不给实现',
    choice: '只给缝（入参包 app.run / 工具前 middleware / 出参包返回值或 sinks）：策略是宿主的',
  },
  {
    key: '框架不执行模型生成的代码',
    choice: '定位决定：模型输出只成文本 / tool_result；代码执行工具的隔离是工具实现内部的事',
  },
  {
    // R8 候选 3（spec §10 2026-09-27 ref-menu-drift-signals）：续跑时菜单漂移**只标记**（事件 / 属性 / console.warn），
    // 不判失败 —— 「不判失败」是 decision 不是缺陷：挂起是合法态、改代码是发布常态。
    // 标记本身有用例钉（pin）；严格模式是 spec §11 开放项。
    key: '菜单漂移只**标记**、不判失败',
    pin: {
      file: 'tests/engine/menu-drift.test.ts',
      marker: '工具被删 ⇒ menu.drift 事件 + 父 span 属性 + console.warn；run 仍照常收尾',
    },
  },
  // ---- 2026-09-28 ref-deep-review-p1-rest：外部深评剩余五条 P1 收口带来的六条新边界 ----
  {
    key: '能力引用**成环 ⇒ 装配期抛错**（2026-09-28）',
    pin: {
      file: 'tests/toolkit/capability-refs.test.ts',
      marker: '自引用（整片引用自己所在的 provider）→ createApp 抛错，文案给出环的路径',
    },
  },
  {
    key: '多进程共库：续跑认领靠**租约**，不靠时间（2026-09-28）',
    pin: {
      file: 'tests/transport/async.test.ts',
      marker:
        'resumePending({staleAfterMs})：同主机按 **pid 存活**判租约 —— 主人活着的不抢、主人没了的立刻抢',
    },
  },
  {
    key: '`ownerId` 是**内部标识**，别解析它',
    pin: {
      file: 'tests/transport/owner-liveness.test.ts',
      marker: '旧格式（没有 @host）⇒ 判不了：不知道是哪台机器写的',
    },
  },
  {
    key: '租约判定的两个**残留风险**：只晚捡、不抢错（2026-09-28）',
    gap: '「PID 复用 / 僵尸进程会被判成主人在」这半句没有任何用例能证伪（要么真造一个撞号 pid，要么探 /proc —— mac 上不存在）',
    candidate: 'tests/transport/owner-liveness.test.ts',
  },
  {
    key: '`beforeTurn` 抛错 ⇒ 本回合降级，不判死 run（2026-09-28）',
    pin: {
      file: 'tests/engine/policy.test.ts',
      marker: '策略抛错 → run 照常跑完，且 run 根留下 context.policy_failed（出声不静默）',
    },
  },
  {
    key: '压缩失败**不烧**滞回额度（2026-09-28）',
    pin: {
      file: 'tests/engine/policy.test.ts',
      marker: '压缩失败不烧滞回额度：下一回合仍会重试（滞回记的是「上次成功」）',
    },
  },
  // ---- 2026-10-02：TB 4.0 轨迹形态复核带来的两条主循环边界 ----
  // 都在「运行时 + 可观测」两层，与射程复核的结论一致（TB 只走了 app.run() 返回值这条路）。
  {
    // 登记为 gap 而非 pin：run-config.test.ts 里 `config.contextPolicy === false` 那条断言
    // 会在「缺省行为改变」时红（配置值就是裁不裁的唯一开关），但它钉的是**配置读数**；
    // 「不注入 ⇒ 一个回合都不裁」这个**行为**本身，没有任何用例能证伪 —— 把 turn.ts 里
    // `if (args.contextPolicy)` 的判据改掉，全套测试仍然全绿。
    key: '缺省**不裁剪**上下文（长跑每回合重发全量历史 ⇒ 成本随回合数平方增长）',
    gap: '「缺省不注入 contextPolicy ⇒ 主循环一个回合都不裁」这半句没有用例钉住 —— run-config.test.ts 只钉配置读数（config.contextPolicy 缺省为 false），「裁不裁」这个行为它管不到',
    candidate: 'tests/engine/run-config.test.ts',
  },
  {
    // 这条有真 pin：eventChars.test.ts 那条用例是**专门**为「这个开关会不会悄悄改变 agent
    // 行为」立的门禁（把 trace 侧 content 截成 7 字符，断言回给模型的 tool_result 仍完整）。
    // 与 traceLimits / maxEventChars 那两条（记账侧）正交 —— 记账侧有闸，模型侧没有。
    key: '回给模型的 `tool_result` **不截断、也没有大小闸**',
    pin: {
      file: 'tests/engine/eventChars.test.ts',
      marker: '回给模型的 tool_result 不受截断影响（截断只在记账侧）',
    },
  },
];

const rows = parseBoundaryRows();
const byKey = new Map(rows.map((r) => [r.key, r]));

describe('usage-guide §7 已知边界：行 ↔ 守卫登记（2026-09-26）', () => {
  it('解析器没退化：§7 至少有 70 行（解析崩了会红，而不是空转绿）', () => {
    assert.ok(
      rows.length >= 70,
      `只解析出 ${rows.length} 行 —— §7 的表格结构变了或解析器坏了（预期 93 行）`,
    );
  });

  // ---------- A2：行集合 ↔ 登记表，双向 ----------
  it('A2 每条边界都有登记项；每条登记项都对应一条边界（双向）', () => {
    // key 一律过与文档侧同一个归一化（去 markdown 记号 / 压空白）—— 登记表里留 `**` 这类
    // 标记不该造成落差（第一版本就是这么红的，守卫咬到了它自己的作者）。
    const registryKeys = new Set(REGISTRY.map((e) => rowKey(e.key)));
    const missing = rows
      .filter((r) => !registryKeys.has(r.key))
      .map((r) => `第 ${r.line} 行「${r.key}」`);
    const stale = [...registryKeys].filter((k) => !byKey.has(k));
    assert.deepEqual(
      { 文档有边界但没登记: missing, 登记了但文档里没有: stale },
      { 文档有边界但没登记: [], 登记了但文档里没有: [] },
      '新写一条边界必须登记（pin / choice / gap 三选一）；删掉边界要把登记项一起删',
    );
    assert.ok(REGISTRY.length === registryKeys.size, '登记表里有重复 key（归一化后撞车）');
  });

  // ---------- A3：pin 可证伪 ----------
  it('A3 每条 pin 都真的落地：文件在场 + marker 是那条用例的**整条标题**', () => {
    const pins = REGISTRY.filter((e): e is Extract<Entry, { pin: unknown }> => 'pin' in e);
    const problems: string[] = [];
    for (const { key, pin } of pins) {
      const full = join(ROOT, pin.file);
      if (!existsSync(full)) {
        problems.push(`「${key}」引的 ${pin.file} 不存在`);
        continue;
      }
      const text = readFileSync(full, 'utf8');
      const isTest = /\.test\.(ts|mjs|js)$/.test(pin.file);
      if (isTest) {
        // ⚠️ **整条标题相等**，不是子串包含 —— 第一版用的 `includes`，把用例标题
        // `…只执行一次` 改成 `…只执行一次啊` 后**照样绿**（变异 M4）。这与本仓记过的
        // `rawArg` → `rawArgument`（子串匹配照样绿，M76 exit 0）是同一个坑：
        // 子串判定让「被引用用例还在不在」无从证伪。
        const titles = [...text.matchAll(/\bit\(\s*(['"`])(.+?)\1/gs)].map((m) => m[2]);
        if (!titles.includes(pin.marker)) {
          problems.push(
            `「${key}」的 marker 不是 ${pin.file} 里任何一条 it(...) 的整条标题：${pin.marker}`,
          );
        }
      } else if (!text.includes(pin.marker) || pin.marker.length < 12) {
        // 非用例文件（脚本 / 源码）：没有「用例标题」这个概念，退回「逐字在场 + 长度下限」。
        // 这条不对称是**有意的**，写在这里以免下一轮误以为漏了。
        problems.push(
          `「${key}」的 marker 在 ${pin.file} 里不逐字在场（或短于 12 字符）：${pin.marker}`,
        );
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(
      pins.length >= 30,
      `pin 只有 ${pins.length} 条（下限 30）—— 被批量降级成 choice/gap 了？`,
    );
  });

  it('A3b 每条 gap 都指了一条真实存在的候选（否则清单不可行动）', () => {
    const gaps = REGISTRY.filter((e): e is Extract<Entry, { gap: unknown }> => 'gap' in e);
    const bad = gaps
      .filter((g) => !existsSync(join(ROOT, g.candidate)))
      .map((g) => `「${g.key}」→ ${g.candidate}`);
    assert.deepEqual(bad, [], `gap 的候选文件不存在：\n${bad.join('\n')}`);
    for (const g of gaps) {
      assert.ok(g.gap.length >= 8, `「${g.key}」的 gap 理由太短（写清「哪半句没人钉」）`);
    }
  });

  // ---------- A4：三态计数 ----------
  it('A4 三态都在场：pin ≥ 30、choice ≥ 8、gap 有清单（数字变了就改这一段）', () => {
    const pins = REGISTRY.filter((e) => 'pin' in e).length;
    const choices = REGISTRY.filter((e) => 'choice' in e).length;
    const gaps = REGISTRY.filter((e) => 'gap' in e).length;
    assert.ok(pins >= 30, `pin ${pins} < 30`);
    assert.ok(choices >= 8, `choice ${choices} < 8 —— 「设计选择」不许被用来把表洗绿`);
    assert.equal(pins + choices + gaps, REGISTRY.length);
    for (const e of REGISTRY) {
      if ('choice' in e) assert.ok(e.choice.length >= 8, `「${e.key}」的 choice 理由太短`);
    }
    // 当前读数（2026-10-12 更新）：pin 57 / choice 11 / gap 25 = 93 行。
    // 本轮新增 1 行（choice：OTLP trace 导出只发 JSON ⇒ 直打 Phoenix 415，处置是 collector
    // 转码配方）—— 依据 docs/reviews/2026-10-12/observability-deep-dive.md 的 G10。
    // 上轮（2026-10-02 复核）是 pin 57 / choice 10 / gap 25 = 92 —— 那轮新增 2 行
    // （TB 4.0 轨迹形态复核带来的主循环两条边界）：一条 pin（模型侧无输出闸，
    // 由 eventChars.test.ts 那条「记多少 ≠ 模型看到多少」的门禁钉住）、一条 gap（缺省不裁
    // —— 配置读数 `config.contextPolicy=false` 会在缺省行为改变时红，但**裁剪行为本身**没人钉）。
    // 上轮（2026-09-29）是 pin 56 / choice 10 / gap 24 = 90 —— 那次把 7 条 gap 回填为 pin
    // （缺省内存 store 不淘汰 / 能力引用两种粒度 / OpenAI 适配器听端点的话 / MCP 连接器的超时
    // 只管装配期 / OTLP metrics 只推当前累计 / 工具没有 token 成本指标 / 同步 /run 撞上审批没
    // 人可批），另订正 1 条 gap 的理由（预算护栏不是硬实时）。
    // 首版（2026-09-26）是 38 / 9 / 30 = 77 —— 上面 §7 里那几个行数数字与这段都要一起改：
    // 它们是**读数**，写死在注释里就是为了让「表长大了而没人发现」在 review 时可见。
  });

  // ---------- A1：标识符不悬空 ----------
  it('A1 §7 的每个反引号 token 都指向真实存在的东西（纯标识符逐字、复合写法按首/末段）', () => {
    const text = corpusText();
    assert.ok(text.length > 500_000, `语料只有 ${text.length} 字符 —— 语料目录没读到（防真空）`);

    const tokens = new Map<string, number>();
    for (const r of rows) {
      for (const m of r.text.matchAll(/`([^`]+)`/g)) {
        const t = m[1].replace(/\\\|/g, '|').trim();
        if (t) tokens.set(t, r.line);
      }
    }
    const pure = [...tokens.keys()].filter((t) => /^[A-Za-z_$][\w$]*$/.test(t));
    assert.ok(tokens.size >= 200, `只抽到 ${tokens.size} 个 token（预期 ≥200）—— 抽取器退化了`);
    assert.ok(pure.length >= 100, `只抽到 ${pure.length} 个纯标识符（预期 ≥100）`);

    const dangling: string[] = [];
    for (const [t, line] of tokens) {
      if (text.includes(t)) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(t)) {
        dangling.push(`第 ${line} 行 \`${t}\` —— 纯标识符，源码语料里逐字找不到`);
        continue;
      }
      // 复合写法（调用形状 / 路径 / JSON 指针）：首段或末段命中即可 ——
      // 例：`ctx.delete` 是使用方写法，框架里是 RunContext.delete（src/runtime/context.ts）
      const segs = t.split(/[^\w$]+/).filter(Boolean);
      const ok = [segs[0], segs[segs.length - 1]].some((s) => s && text.includes(s));
      if (!ok) dangling.push(`第 ${line} 行 \`${t}\` —— 首/末段都不在源码语料里`);
    }
    assert.deepEqual(dangling, [], dangling.join('\n'));
  });
});
