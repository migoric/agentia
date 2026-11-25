/**
 * Agentia —— **一轮 run 要写进会话的 assistant 正文**（单源口径）。
 *
 * ## 为什么需要它
 *
 * `AgentRunResult.finalText` 是「**模型说的话**」，不是「这一轮对外的回复」：
 * 声明了 `resultSchema` 的 run 靠 hidden `submit_result` 收尾，而模型提交结构化结果那一回合
 * **常常不留散文** ⇒ `finalText === ''`，完整答案在 `typed` 里（`finalText` 的类型注释自己
 * 就写着「提交结构化结果的回合若带文本则取之，可空」）。
 *
 * 只读 `finalText` 的后果不是崩溃，是**会话失忆**（2026-11-25 业务侧真机复现）：巡检 agent
 * 的 1369 字报告落在 `typed.report`，run 成功、`stopReason=end_turn`、报告也回给了调用方，
 * 会话历史里那一轮却是「（本次无文本输出）」；下一轮同会话追问「上一轮巡检哪个系统」，
 * 模型据历史回答「该轮未产出结论，本工单的前提不成立」。**失败方向最坏的那种**：
 * 它不报错，只是把已经产出的结论说成不存在。
 *
 * ## 为什么住在 `core` 而不是 `runtime/session.ts`
 *
 * 两个回写点分属两层：`runtime/run.ts` 的 `appendSession` 与 `transport/async.ts` 的
 * `#appendResumedSession`（HITL 恢复段，那个坑一模一样）。而分层守卫里 `transport` 只许依赖
 * `core` / `engine` / `store` —— **不许依赖 `runtime`**（见 `tests/architecture/layering.test.ts`
 * 的 `ALLOWED`）。所以口径必须落在两层的公共下游；本件是纯函数（无 IO、无 trace、不读配置），
 * 与 `core/text.ts` 同性质。
 *
 * ## 为什么不直接把 `finalText` 改成非空
 *
 * 那会污染证据：`finalText` 参与评测断言、进 trace、进 HTTP 响应，把 `typed` 塞进去等于
 * 「模型说了它没说的话」。会话正文是**另一个概念**（给下一轮看的这段话），所以另开取值，
 * 引擎层一个字不动。
 */

/**
 * 两样都没东西可说时写进会话的占位。
 *
 * **这条不变量必须保留**：历史必须以 assistant 结尾，否则下一轮拼进去就是连续两条 user，
 * 撞 Messages API 的角色交替校验（400）。
 *
 * ⚠️ 文案是**对外可识别的**（下游按字符串识别它，见 CHANGELOG 0.10.15），改字要单独标注。
 */
export const EMPTY_REPLY_MARK = '（本次无文本输出）';

/**
 * 单条会话消息的正文上限。
 *
 * 结构化结果经 `JSON.stringify` 兜底后可能几十 KB，而会话历史每轮都会**整段重发**给模型
 * —— 一次巡检把历史撑爆，之后每一轮都在为它付 token。超限只影响**会话历史**，
 * `typed` 本身与 trace / 落库路径一个字不动。
 */
export const SESSION_REPLY_MAX_CHARS = 8000;

/**
 * 结构化结果里的「正文键」白名单，**按序取第一个非空字符串**。
 *
 * `report` 在前：本仓 `runAgentScoped` 交回子 agent 结果的形态就是
 * `{ report, result }`（见 `toolkit/subagent.ts`），巡检/报告类业务 schema 沿用同一命名。
 * `reply` 次之：客服类（对话型）schema 的正文键。其余是各类 schema 最常见的同义名。
 */
export const SESSION_REPLY_KEYS = [
  'report',
  'reply',
  'text',
  'content',
  'summary',
  'answer',
] as const;

/** 截断标记（单独成常量：两条调用路径不该各写一套） */
const TRUNCATION_MARK = '…[truncated]';

/** 取一段「给人看的话」的输入面 —— 只要这两个字段，不绑 `AgentRunResult` 的具体泛型 */
export interface SessionReplySource {
  readonly finalText?: string | undefined;
  readonly typed?: unknown;
}

/**
 * 从 run 结果里取要写进会话的正文；`undefined` = 两样都没东西说（由调用方落占位符）。
 *
 * 口径逐条（与业务侧 `extractResultText` 对齐，改动请两边一起改）：
 * 1. `finalText.trim()` 非空 → 直接用它。**不 JSON 化、不改标点** —— 那是模型真说过的话。
 * 2. 否则看 `typed`：白名单键的第一个非空字符串，命中即止，值 `trim()`（**保内部换行**，
 *    报告是 markdown）。
 * 3. 白名单全落空 → `JSON.stringify(typed)` 兜底；`{}` / `[]` 序列化后只有 2 个字符，
 *    用 `length > 2` 把空壳挡在占位符之前（结构未知也要把内容交出去，总比说「没返回」有用）。
 * 4. 根类型是**字符串**（`resultSchema` 不限制根类型）→ 它本身就是正文；这里**刻意不**
 *    JSON 化，否则历史里会出现带引号的一行。
 * 5. 两样都空 → `undefined`。
 */
export function sessionReplyText(result: SessionReplySource): string | undefined {
  const text = result.finalText?.trim();
  if (text) return text;

  const typed = result.typed;
  if (typed === undefined || typed === null) return undefined;

  if (typeof typed === 'string') return typed.trim() || undefined;

  if (typeof typed === 'object') {
    const bag = typed as Record<string, unknown>;
    for (const key of SESSION_REPLY_KEYS) {
      const v = bag[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }

  // 数组 / 数字 / 布尔 / 白名单全落空的对象都走这里
  const json = stringifySafely(typed);
  return json !== undefined && json.length > 2 ? json : undefined;
}

/**
 * 超长截断。**总长（含标记）不超过 `SESSION_REPLY_MAX_CHARS`** —— 上限说的是「这条消息正文
 * 多长」，不是「前缀多长」。
 */
export function clipSessionReply(text: string): string {
  if (text.length <= SESSION_REPLY_MAX_CHARS) return text;
  return text.slice(0, SESSION_REPLY_MAX_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

/**
 * **两个回写点唯一该调的函数**：取值 → 截断 → 空则占位，一步到位。
 *
 * 为什么合成一个而不是让调用点自己拼 `clip(x ?? EMPTY_REPLY_MARK)`：这个 bug 的成因正是
 * 「同一个语义写了两份拷贝」，把合成也留给调用方，下一个回写点就会漏掉其中一步。
 * 返回值**恒非空**（占位符兜底）⇒ 调用点不必再判空，不变量只有一个守门人。
 */
export function sessionReplyContent(result: SessionReplySource): string {
  return clipSessionReply(sessionReplyText(result) ?? EMPTY_REPLY_MARK);
}

/**
 * `JSON.stringify` 的安全版。
 *
 * 理论上 `typed` 来自 JSON 校验、不会带环或 BigInt；但这条路径在会话回写里，
 * 一次抛错就是「这一轮白聊」（异常会被 `appendSession` 吞成 warn）。宁可退回占位符。
 */
function stringifySafely(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
