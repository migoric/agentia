/**
 * 回合请求的**装配**（纯）：把引擎侧的取值摊成客户端 `messages.stream` 的入参。
 *
 * 从 turn.ts 的 streamTurn 里外移（2026-09-20，turn 拆分第二步）。这里没有一行逻辑算"难"，
 * 但三处**条件展开**是容易写错的地方 —— **键在不在场是语义**：
 * - `system` / `tools` / `signal` 缺省时**不带该键**（不是传 `undefined`、更不是空数组）：
 *   适配器按「键是否在场」决定是否写进请求体，带一个空数组会被某些端点读成「声明了零个工具」；
 * - `system: ''` 这种空值同样不带键（`!system` 判定）—— 与抽取前的行内写法逐字一致。
 *
 * 纯的边界：只做取值搬运，不读 ctx、不碰 recorder、不认识重试。
 */
import type { MessageParam, ToolParam } from '../core/message.js';
import type { ModelClient } from '../core/tool.js';
import type { SystemParam } from './types.js';

type StreamParams = Parameters<ModelClient['messages']['stream']>[0];

export function buildTurnRequest(opts: {
  model: string;
  maxTokens: number;
  system?: SystemParam | undefined;
  apiTools: ToolParam[];
  messages: MessageParam[];
  signal?: AbortSignal | undefined;
}): StreamParams {
  const { model, maxTokens, system, apiTools, messages, signal } = opts;
  return {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(apiTools.length ? { tools: apiTools } : {}),
    // 快照而不是引用：`ctx.messages` 是**同一条活历史**，本轮结束后 loop 会继续往里
    // push（assistant 回复、工具结果、审批事件）。直接交出引用，等于让客户端在它不知道
    // 的情况下看到「未来」的消息 —— 任何把 params 排队/缓存/录制的实现（重试队列、
    // 批处理、审计日志、测试替身）都会读到被后续轮次污染的数组（实测：调用时 3 条，
    // 同一个引用事后变 4 条）。
    messages: [...messages],
    ...(signal ? { signal } : {}),
  };
}
