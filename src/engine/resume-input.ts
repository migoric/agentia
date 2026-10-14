import type { MessageParam, ToolUseBlock } from '../core/message.js';
import type { TaskEvent } from '../core/run.js';

/**
 * Agentia —— 续跑入口的**读取件**（engine/loop.ts 的拆分第三步）。
 *
 * 两个函数只服务同一条路径：**HITL 挂起后的续跑**（也是通用续跑入口）。
 *
 *   ① `tailToolUses`：识别这次进循环是「续跑」还是「新起一段」—— 判据是**历史末尾**
 *      那条 assistant 里还有没有未解决的 tool_use。判错的后果不对称：漏判 = 把续跑
 *      当新对话（重新请求模型、花费翻倍、同一批工具再跑一遍）；误判 = 一个工具都没
 *      声明就发请求。所以它只认末尾一条，且把「不是 assistant / content 不是块数组」
 *      一律当**不是续跑**（宁可不续，不可乱续）。
 *   ② `textOfParam`：续跑落定时从历史里取那段文本（`submit_result` 校验通过后，
 *      finalText 要取**该 assistant 消息**的文本块，而不是刚 push 进去的 tool_results）。
 *
 * 文件分工：文本口径的单源仍是 `engine/text.ts`（多块用 `\n` 连接）；这里不直接用
 * `textOf()` 是因为**请求侧消息的形状不同** —— `content` 可能是裸字符串，且块的
 * `text` 是可选的（`?? ''`），与响应侧 Message 的必填 `text` 不是同一个类型。
 * 编排（什么时候调用、调用完做什么）留在 engine/loop.ts。
 */

/**
 * 取消息历史**末尾**那条 assistant 消息里待解决的 tool_use 块（恢复模式检测）。
 * 空数组 = 不是恢复场景（正常从 user 消息起跑）。
 */
export function tailToolUses(messages: MessageParam[]): ToolUseBlock[] {
  const tail = messages[messages.length - 1];
  if (tail?.role !== 'assistant' || !Array.isArray(tail.content)) return [];
  // ToolUseBlockParam 结构上兼容 ToolUseBlock（多一个可选 cache_control）
  return tail.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/** 取 MessageParam（请求侧）里的文本块拼成的文本（恢复模式收尾时用） */
export function textOfParam(message: MessageParam): string {
  if (!Array.isArray(message.content))
    return typeof message.content === 'string' ? message.content : '';
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n');
}

/**
 * run 事件 → **一条 user 文本消息**（2026-09-28 ref-run-event-input 的 B1：外部永远不能构造 block ——
 * 进来的只有文本，投毒面只到「内容注入」为止）。
 *
 * `eventId` **不进正文**：它是投递簿记（幂等去重依据），不是内容 —— 模型不需要知道
 * 去重键，把它放进去只会给「同一件事换 id 再投一次」留语义噪音。留痕走 trace
 * （`task.event` 事件，见 loop.ts 的注入点），不进消息。
 */
export function renderTaskEvent(ev: TaskEvent): MessageParam {
  return { role: 'user', content: `[事件 type=${ev.type}]\n${ev.payload}` };
}
