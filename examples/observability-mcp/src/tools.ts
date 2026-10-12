/**
 * 两个**只读**能力 —— 本 server 的整个对外面。
 *
 * 刻意小：`report_trace`（一份报告）与 `diff_traces`（两条 run 的差异）。它们是
 * `buildRunReport` / `diffTraces` 的薄壳，不做自己的聚合（聚合口径见 `traces.ts`）。
 * 为什么值得存在：trace 落盘之后，能问「我上一轮慢在哪」的目前只有人和 CLI —— 这个 server
 * 把那两个问题变成 agent 自己能调的**工具**（MCP 是通用接口，不绑定任何一家宿主）。
 */
import { SystemPrompt, Tool, createApp } from '@migor/agentia';
import type { AgentApp } from '@migor/agentia';
import { diffOf, reportOf, resolveInsideRoot } from './traces.js';

/** 入参 schema 里反复出现的两句 —— 写一次，别让两个 schema 悄悄说叉 */
const FILE_DESC = 'trace 文件路径：相对 trace 根（AGENTIA_TRACE_ROOT，缺省 cwd），或它的绝对路径';
const RUN_DESC = '第几条 run（从 1 数）；缺省 = 文件里**最后一条**（最近一次跑的那条）';

class TraceViews {
  @Tool({
    description:
      '从一个 trace 落盘文件（JSONL，`jsonlTraceSink` 写出的形状）出**调优报告**：能力排行' +
      '（调用数 / 错误数 / 总耗时 / 最大耗时 / token / 成本，按总耗时降序）、模型归因、' +
      '未定价模型清单，以及按会话归组的成功率与「每成功任务成本」。' +
      '用来回答「我上一轮慢在哪 / 贵在哪 / 哪个能力爱失败」。',
    schema: {
      type: 'object',
      properties: { file: { type: 'string', description: FILE_DESC } },
      required: ['file'],
      additionalProperties: false,
    },
  })
  async report_trace(input: { file: string }): Promise<unknown> {
    return reportOf(await resolveInsideRoot(input.file));
  }

  @Tool({
    description:
      '比对两条 run 的**结构化差异**（换模型 / 改 prompt / 改菜单之后的 A/B）：返回 run 级差异' +
      '（status、usage、根 span attributes —— 换模型第一眼就看 attributes.model）与逐 span 的' +
      '字段级差异（按配对路径定位，缺侧只留标记）。差异 span 最多返回 40 条，截掉多少会如实报出。',
    schema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: `基准侧：${FILE_DESC}` },
        after: { type: 'string', description: `对照侧：${FILE_DESC}` },
        beforeRun: { type: 'number', description: `基准侧：${RUN_DESC}` },
        afterRun: { type: 'number', description: `对照侧：${RUN_DESC}` },
      },
      required: ['before', 'after'],
      additionalProperties: false,
    },
  })
  async diff_traces(input: {
    before: string;
    after: string;
    beforeRun?: number;
    afterRun?: number;
  }): Promise<unknown> {
    const [before, after] = await Promise.all([
      resolveInsideRoot(input.before),
      resolveInsideRoot(input.after),
    ]);
    // exactOptionalPropertyTypes：显式 undefined 不是合法的 `beforeRun?: number`
    return diffOf(before, after, {
      ...(input.beforeRun !== undefined ? { beforeRun: input.beforeRun } : {}),
      ...(input.afterRun !== undefined ? { afterRun: input.afterRun } : {}),
    });
  }
}

/**
 * 装配成 `AgentApp` —— 走 `createApp` + `@Tool` 真装配，不是手拼 `{ tools: [...] }`。
 *
 * `createMcpServer` 的 app 入参是鸭子类型（`{ tools }`），手拼也收；但真装配才顺带验到
 * 「菜单 = 装配后、过中间件的那份」。本 server **不跑模型**：两个工具都是纯读 + 纯算，
 * 但 `McpServerOptions.client` 是**惰性**的（第一次 `tools/call` 才构造），所以这里
 * 也不需要 API key 在场。
 */
export function buildApp(): AgentApp {
  return createApp({
    name: 'observability-mcp',
    system: new SystemPrompt().add(
      'role',
      '你是 trace 观测台的只读查询端：只报告痕迹里真实存在的数字，读不出就说读不出。',
      true,
    ),
    providers: [{ provide: 'traceViews', useClass: TraceViews }],
  });
}
