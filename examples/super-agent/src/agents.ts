import { createApp } from '@migor/agentia';
import type { AgentApp, JsonSchema, Provider, TraceSink } from '@migor/agentia';
import { BUDGETS } from './config.js';
import type { Sandbox } from './sandbox.js';
import { ReadFile, SearchText, WriteFile } from './tools.js';

/**
 * 三个 agent 身份：Router 一个、两种 Worker 各一个。
 *
 * 为什么 Router 与 Worker 是**三个不同的 app** 而不是一个 app 的三个提示词：
 * 菜单隔离是安全边界 —— 「能改代码」这个能力不该出现在复现工单的菜单里，
 * 否则模型在只该看一眼的场合也可能发起一个需要审批的写操作。三个 app = 三份菜单，
 * 每个工单拿到的工具集正好是它需要的那些（usage-guide §7「能力引用两种粒度」）。
 */

/** 工单：Router 的结构化产出，也是 Worker 的输入 */
export interface Ticket {
  /** 工单 id（同时用作 `idempotencyKey`，重复派发不会重复执行） */
  id: string;
  /** 工单类型 —— 决定用哪个 Worker app */
  kind: 'repro' | 'fix';
  /** 一句话目标（会原样交给 Worker） */
  goal: string;
}

/**
 * Router 的结构化结果 schema。
 *
 * 给出它之后引擎会追加一个**隐藏的 `submit_result` 工具**：模型必须调它提交，
 * `result.typed` 才有值；自然收尾却没提交 ⇒ 以 `result_missing` 失败收尾
 * （这不是本项目自己判断的，是引擎的契约，见 usage-guide §4 的 resultSchema）。
 *
 * ⇒ 「拆单」这一步是**可校验的**，不是从一段自由文本里正则抠 JSON。
 */
export const TICKETS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      description: '把用户目标拆成可独立执行的工单；相互独立的才拆开（它们会被并行执行）',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '短 id，如 T1；同一目标内唯一' },
          kind: {
            type: 'string',
            enum: ['repro', 'fix'],
            description: 'repro = 只读复现与定位；fix = 需要改动代码（会走人工审批）',
          },
          goal: { type: 'string', description: '这个工单要达成什么，一句话说清' },
        },
        required: ['id', 'kind', 'goal'],
        additionalProperties: false,
      },
    },
  },
  required: ['tickets'],
  additionalProperties: false,
};

/** Router：**短 run**，只做判断与拆单，不执行任何业务动作 */
export function createRouterApp(opts: { sinks?: TraceSink[] } = {}): AgentApp {
  return createApp({
    name: 'router',
    providers: [],
    ...(opts.sinks ? { sinks: opts.sinks } : {}),
    system:
      '你是一个多工单协调器的「拆单」环节。你的唯一职责是把用户的一句话目标拆成若干可独立执行的工单。\n' +
      '规则：\n' +
      '1. 只拆**相互独立、可并行**的部分；有先后依赖的（必须先复现才知道怎么改）不要硬拆成两单，' +
      '交给同一个 fix 工单里按顺序做。\n' +
      '2. 需要改动代码的工单用 kind=fix（这类动作会走人工审批）；只读排查用 kind=repro。\n' +
      '3. 工单数量克制：2~3 个足够，不要为了「看起来并行」而拆碎。\n' +
      '4. 必须调用 submit_result 提交结果，不要只用文本回答。',
  });
}

/** repro Worker 的菜单：**没有**写工具 —— 菜单隔离是安全边界，不是风格问题 */
function reproProviders(sandbox: Sandbox): Provider[] {
  return [
    { provide: 'sandbox', useValue: sandbox },
    { provide: 'read_file', useClass: ReadFile, deps: ['sandbox'] },
    { provide: 'search_text', useClass: SearchText, deps: ['sandbox'] },
  ];
}

/** fix Worker 的菜单：多了 write_file（它是 `approval: 'required'`，会挂起等人批） */
function fixProviders(sandbox: Sandbox): Provider[] {
  return [
    ...reproProviders(sandbox),
    { provide: 'write_file', useClass: WriteFile, deps: ['sandbox'] },
  ];
}

const WORKER_SYSTEM: Record<Ticket['kind'], string> = {
  repro:
    '你在一个独立工单里做只读排查。用 search_text / read_file 定位问题，' +
    '最后用一段话说清：缺陷在哪（文件 + 行）、为什么会这样、正确行为应该是什么。' +
    '你**不能**改任何文件（菜单里没有写工具），不要假装改动已发生。',
  fix:
    '你在一个独立工单里修复缺陷。先读代码确认根因，再用 write_file 提交完整的新文件内容' +
    '（reason 里写清改了什么、为什么）。写操作会挂起等待人工审批 —— 这是正常的，不要因为' +
    '没立刻看到结果就重复提交。最后说明改了哪一行、修复后的行为。',
};

/** Worker：**一个 app 对应一种工单类型**，任务本身由 AsyncRunner 承载 */
export function createWorkerApp(
  kind: Ticket['kind'],
  sandbox: Sandbox,
  opts: { sinks?: TraceSink[] } = {},
): AgentApp {
  return createApp({
    name: `worker-${kind}`,
    providers: kind === 'fix' ? fixProviders(sandbox) : reproProviders(sandbox),
    system: WORKER_SYSTEM[kind],
    ...(opts.sinks ? { sinks: opts.sinks } : {}),
    ...BUDGETS,
  });
}
