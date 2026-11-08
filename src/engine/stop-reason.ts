/**
 * 回合收尾的**纯判定**：把模型返回的 `stop_reason` 映射成循环该做什么。
 *
 * 从 turn.ts 外移（2026-09-20）。理由与 transport 那批一致：这张映射表混在 700 行的回合执行机里
 * 时，只能透过 `loop.test.ts` 的端到端用例间接观察 —— 而它恰恰是「非正常收尾必须带结构化 error」
 * 这条不变量的唯一落点（`tool_use_no_blocks` 曾经漏挂 error：run 以 failed 收尾却看不出原因）。
 *
 * 纯的边界：只读 `message.stop_reason` 与 `message.content`，不碰引擎、不记账、不落库。
 */
import type { Message, ToolUseBlock } from '../core/message.js';
import type { SpanError } from '../core/trace.js';
import type { AgentStopReason } from './types.js';
import { textOf } from './text.js';

export type StopResolution =
  | { kind: 'finish'; stopReason: AgentStopReason; finalText: string; error?: SpanError }
  | { kind: 'tools'; toolUses: ToolUseBlock[] };

/**
 * —— 终止/边界分支（每个都给出终止结论，退出循环不再兜底改判）——
 * 五种已知 stop_reason 各有归宿；剩余形态按「有没有可执行块」区分：
 * 畸形 tool_use（块为空）与框架不认识的 stop_reason。
 */
export function resolveStopReason(message: Message, maxTokens: number): StopResolution {
  const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
  if (message.stop_reason === 'end_turn') {
    // 兼容端点可能回 `finish_reason=stop` 却仍带 tool_calls：静默丢弃工具调用会让 run
    // 以成功收尾、而模型要的副作用从未发生（2026-11-07 深评）。按 tool_use 处理。
    if (toolUses.length > 0) return { kind: 'tools', toolUses };
    return { kind: 'finish', stopReason: 'end_turn', finalText: textOf(message) };
  }
  if (message.stop_reason === 'refusal') {
    return {
      kind: 'finish',
      stopReason: 'refusal',
      finalText: textOf(message),
      error: { type: 'refusal', message: 'model refused the request', retryable: false },
    };
  }
  if (
    message.stop_reason === 'max_tokens' ||
    message.stop_reason === 'model_context_window_exceeded'
  ) {
    const contextWindow = message.stop_reason === 'model_context_window_exceeded';
    if (contextWindow) {
      return {
        kind: 'finish',
        stopReason: 'model_context_window_exceeded',
        finalText: textOf(message),
        error: {
          type: 'model_context_window_exceeded',
          message: '模型上下文窗口已耗尽（model_context_window_exceeded）',
          retryable: false,
        },
      };
    }
  }
  if (message.stop_reason === 'max_tokens') {
    // 与 budget_exceeded / refusal 同口径：非正常收尾都带结构化 error（进 run 根 span），
    // 否则 trace 里这类 run「失败却没有原因」
    return {
      kind: 'finish',
      stopReason: 'max_tokens',
      finalText: textOf(message),
      error: {
        type: 'max_tokens',
        message: `模型输出触顶被截断（max_tokens=${maxTokens}）`,
        retryable: false,
      },
    };
  }
  if (message.stop_reason === 'pause_turn') {
    // 无 server tools 时正常不会到；避免无限循环直接停
    return {
      kind: 'finish',
      stopReason: 'pause_turn',
      finalText: textOf(message),
      error: {
        type: 'pause_turn',
        message: '模型返回 pause_turn（无 server tools 的场景不应出现），防死循环直接收尾',
        retryable: false,
      },
    };
  }
  if (message.stop_reason === 'stop_sequence') {
    // 命中 stop 序列 = 正常收尾（与 end_turn 同类），不是失败
    return { kind: 'finish', stopReason: 'stop_sequence', finalText: textOf(message) };
  }

  if (toolUses.length === 0) {
    // 到这里的剩余 stop_reason 不会产生可执行块，防死循环直接停：
    // 'tool_use' 但块为空（畸形响应）与「本框架不认识的 stop_reason」区分开。
    //
    // **两种都属非正常收尾，都必须挂结构化 error** —— engine/loop.ts 的不变量是
    // 「非正常收尾都带结构化 error」（与 budget_exceeded / refusal / max_iterations 同口径）。
    // 此前只有 unknown_stop_reason 带 error，tool_use_no_blocks 不带：run 以
    // status:'failed' 收尾、result.error 却是 undefined，HTTP body 与任务记录里
    // 看不出「为什么失败」，只能看到一句 stopReason 字符串。
    const stopReason =
      message.stop_reason === 'tool_use' ? 'tool_use_no_blocks' : 'unknown_stop_reason';
    return {
      kind: 'finish',
      stopReason,
      finalText: textOf(message),
      error: {
        type: 'agent_error',
        message:
          stopReason === 'tool_use_no_blocks'
            ? '模型以 stop_reason=tool_use 收尾，但响应里没有任何 tool_use 块（畸形响应）'
            : `模型返回了未识别的 stop_reason: ${String(message.stop_reason)}`,
        retryable: false,
      },
    };
  }
  return { kind: 'tools', toolUses };
}
