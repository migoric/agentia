import { Tool } from '@migor/agentia';
import type { Sandbox } from './sandbox.js';

/**
 * Worker 的三个工具 —— 全部是**普通业务代码**，没有一处知道「自己是 Worker」。
 *
 * 这正是这套架构该有的形状：编排（谁跑、跑几个、要不要审批）在 orchestrator 与
 * AsyncRunner 上；工具只管干活。换个宿主、换个编排方式，这三个类一行不用改。
 */

/** 读文件 —— 只读工具，两个 Worker 都有 */
export class ReadFile {
  constructor(private readonly sandbox: Sandbox) {}

  @Tool({
    name: 'read_file',
    description: '读一个文件的完整内容。路径相对工单的工作区根。',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径，如 src/pricing.ts' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  })
  read_file(input: { path: string }): { path: string; content: string } {
    return { path: input.path, content: this.sandbox.read(input.path) };
  }
}

/** 全文搜索 —— 只读工具，两个 Worker 都有 */
export class SearchText {
  constructor(private readonly sandbox: Sandbox) {}

  @Tool({
    name: 'search_text',
    description: '在全部文件里按子串搜索（区分大小写），返回命中的路径 / 行号 / 该行内容。',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '要搜的子串' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  })
  search_text(input: { query: string }): {
    hits: Array<{ path: string; line: number; text: string }>;
  } {
    return { hits: this.sandbox.search(input.query) };
  }
}

/**
 * 写文件 —— **本示例唯一不可逆的动作**，因此标了 `approval: 'required'`。
 *
 * 这条闸的机制（usage-guide §7「人工审批」、deployment.md §2）：
 *   模型调用它 ⇒ 该回合**挂起**（status='suspended'，不是失败、不占并发槽）
 *   ⇒ 待决清单随 `TaskRecord.pendingApprovals` 落库 ⇒ 宿主 `POST /tasks/:taskId/approve`
 *   给决定 ⇒ 恢复执行。
 *
 * ⚠️ 三个配套事实（都写在示例里，因为最容易踩）：
 *   ① `suspended` **不是终态** —— 拿 `awaitTask` 等它只会等到超时（见 orchestrator 的 `settle`）；
 *   ② 挂起段与恢复段是**两棵 trace**（同一任务两条链，靠根 span 的 link 连起来）；
 *   ③ 审批是 **at-least-once** —— 崩溃在「批准后、执行中」会重跑，所以写操作得自己幂等。
 *      本示例的沙箱是覆盖写（天然幂等），真文件系统上要另想办法。
 */
export class WriteFile {
  constructor(private readonly sandbox: Sandbox) {}

  @Tool({
    name: 'write_file',
    description:
      '写入一个文件的完整内容（覆盖）。这是**不可逆**的改动，会挂起等待人工审批后才真正执行。',
    approval: 'required',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 src/pricing.ts' },
        content: { type: 'string', description: '写入后的完整文件内容' },
        reason: { type: 'string', description: '为什么要改它（会进审批请求，供人判断）' },
      },
      required: ['path', 'content', 'reason'],
      additionalProperties: false,
    },
    strict: true,
  })
  write_file(input: { path: string; content: string; reason: string }): {
    ok: true;
    path: string;
    bytes: number;
  } {
    this.sandbox.write(input.path, input.content);
    return { ok: true, path: input.path, bytes: input.content.length };
  }
}
