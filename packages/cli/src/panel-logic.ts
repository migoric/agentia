/**
 * 面板的**纯逻辑**（零 DOM、零依赖、零副作用）—— 从 `inspector-page.html` 的
 * `<script type="module">` 里抽出来，让 CLI 测试套件能真的覆盖它。
 *
 * 为什么必须抽出来：面板是手写无框架 HTML，P1b/P1c 之后长出输入条 / 能力多选 /
 * 文件夹选择器 / 多轮开关 / 对话视图 —— 这是这批工作里**最大的一块**逻辑。
 * 留在 `<script>` 里就等于「本仓唯一没有测试的复杂逻辑」，而本仓的纪律是
 * 「文档承诺可跑就得有守卫」。
 *
 * ⚠️ 约束：本文件**不许碰 DOM**（不出现 `document` / `window` / `EventSource`）——
 * 它要在 Node 里被直接 import 做单测。DOM 接线留在 HTML 里，且只做
 * 「取值 → 调这里 → 写回」，不再自己判断业务规则。
 */
import type { SessionMessageLike, TraceRecordEventLike, TraceSpanLike } from './dev-protocol.js';
/** 形状单源：run 列表的**生产形状**在服务端（`/api/runs` 的响应类型），不在这里手抄 */
import type { RunSummary } from './inspector.js';

// ---------- 能力多选（D8） ----------

/**
 * 多选结果 → `AppOptions.toolSources` 的实参。
 *
 * 三条口径（都来自 D8「形态已定 · ①多选」）：
 * - **全选 ⇒ `undefined`**：与「不传即全量」同义，且省掉一次白跑的孤儿能力告警
 *   （`module.ts` 的 `if (opts.toolSources)` 分支）。
 * - **固定顺序**（字典序），不用点击顺序 —— 调试要可复现，否则同一组能力两次跑出
 *   不同菜单序。
 * - **空集也当全量**：`toolSources: []` 会收窄到**空菜单**（每个 provider 都成了孤儿），
 *   是个纯陷阱值；UI 另外禁止「取消最后一个」，这里兜住程序性调用。
 *
 * 不在 `all` 里的名字（能力被删了、面板缓存旧了）**静默丢弃**——它不该让整次 run 失败，
 * 但也**不是**无声的：调用方拿到的是「归一化之后」的数组，面板据此回写选中态。
 */
export function normalizeToolSources(selected: string[], all: string[]): string[] | undefined {
  const known = new Set(all);
  const picked = [...new Set(selected)].filter((s) => known.has(s)).sort();
  if (picked.length === 0 || picked.length === all.length) return undefined;
  return picked;
}

/** 「已选/总数」计数（D7：`3/3` 一眼看出这次是全量还是收窄，不是装饰） */
export function capabilityBadge(selected: string[], all: string[]): string {
  return `${selected.length}/${all.length}`;
}

/**
 * 渲染前丢掉**已失效**的 token（能力被删 / runner 重启后菜单变了）。不过滤徽标就说谎：
 * 分子里混着菜单上已不存在的名字 ⇒ `4/3`。空集返回空数组（「回落全选」是**调用方**的
 * 规则），且保留入参顺序 —— 过滤不重排，排序是 `normalizeToolSources` 发送前的活。
 */
export function filterSelected(selected: string[], all: string[]): string[] {
  const known = new Set(all);
  return [...new Set(selected)].filter((s) => known.has(s));
}

/**
 * 一条 run 的「已选来源」显示口径（`null` = 全量，与 `RunNote.toolSources` 同义）。
 * **两处共用一份**：run 列表第三行与 `run-start` 提示条 —— 各写一份就会出现「同一组
 * 能力两个说法」，而面板的纪律是「显示的就是生效的那份」。
 */
export function formatToolSources(sources: string[] | null): string {
  return sources === null ? '全量' : sources.join(',');
}

// ---------- 多轮开关（D8 ②③） ----------

export interface MultiTurnDefault {
  /** 初始值 = 所选能力声明的 **OR** */
  value: boolean;
  /** 声明了多轮、且这次被选中的能力（升序）—— 用于在开关上**标出来源** */
  sources: string[];
}

/**
 * 多轮开关的初始值。
 *
 * 多选之后必然出现「`trip-planner`（多轮）+ `code-review`（单轮）同选」，
 * 此时默认值**有歧义** —— 规则是 **OR**（只要有一个声明多轮就默认多轮），
 * 并把**来源**一并返回，好让面板标出来（`多轮·trip-planner`）。
 *
 * 本仓一贯的偏好：**不要静默行为**。宁可多显示一句来源，也不要让用户面对
 * 一个「为什么这次带了上下文」的谜。
 */
export function multiTurnDefault(selected: string[], declared: string[]): MultiTurnDefault {
  const decl = new Set(declared);
  const sources = [...new Set(selected)].filter((s) => decl.has(s)).sort();
  return { value: sources.length > 0, sources };
}

/**
 * 开关文案。**必须说清「现在是几轮」和「为什么」** —— 混选时默认值有歧义，
 * 而一个没有来源标注的开关会让人面对「为什么这次带了上下文」的谜。
 *
 * - `多轮·trip-planner` —— 开关在默认位上，来源就是声明多轮的那个能力
 * - `单轮（覆盖默认：trip-planner 声明多轮）` —— 用户手动关掉了（调试就是要试开/关）
 * - `多轮（手动开）` —— 没有任何能力声明多轮，用户自己开的
 */
export function multiTurnLabel(value: boolean, sources: string[], isDefault: boolean): string {
  if (value) {
    if (sources.length > 0) return `多轮·${sources.join(',')}`;
    return isDefault ? '多轮' : '多轮（手动开）';
  }
  if (sources.length > 0) return `单轮（覆盖默认：${sources.join(',')} 声明多轮）`;
  return '单轮';
}

// ---------- prompt 回显（§6 的 (乙)） ----------

/** 回显栈上限（与 shell 的 HISTSIZE 同量级；面板只保证「调得回最近这些条」） */
export const PROMPT_HISTORY_LIMIT = 50;

/**
 * 把一条 prompt 压进回显栈。
 *
 * 口径照 shell 的 `HISTCONTROL=ignoredups`：**只与栈顶比**，连续重复不入栈
 * （按两次回车不该占两格）。空白串直接丢弃。
 *
 * ⚠️ 这是 (乙) **prompt 回显**，不是 (甲) 对话历史：它只是把文字填回输入框，
 * **模型看不见**（模型收到的仍是你最终回车的那句），所以永远可用、零成本 ——
 * 与「多轮开关」无关（§6 的两层读法）。
 */
export function pushPromptHistory(
  history: string[],
  prompt: string,
  limit: number = PROMPT_HISTORY_LIMIT,
): string[] {
  const p = prompt.trim();
  if (p.length === 0) return history;
  if (history[history.length - 1] === p) return history;
  const next = [...history, p];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** 游标停在草稿（当前输入框内容）上 */
export const HISTORY_DRAFT = -1;

/**
 * ↑/↓ 的游标推进。游标语义 = **距栈尾的距离**：`-1` 是草稿、`0` 是最新一条、
 * `n-1` 是最旧一条。`older`（↑）加一、`newer`（↓）减一，两端夹住不绕回
 * —— 绕回会在按过头时把用户送回一个他没想到的位置。
 */
export function historyStep(history: string[], cursor: number, dir: 'older' | 'newer'): number {
  if (history.length === 0) return HISTORY_DRAFT;
  const next = cursor + (dir === 'older' ? 1 : -1);
  if (next < HISTORY_DRAFT) return HISTORY_DRAFT;
  if (next > history.length - 1) return history.length - 1;
  return next;
}

/** 游标处的文本（草稿位返回草稿本身 —— 按 ↓ 回到你还没发出去的那句） */
export function historyText(history: string[], cursor: number, draft: string): string {
  if (cursor === HISTORY_DRAFT || history.length === 0) return draft;
  return history[history.length - 1 - cursor] ?? draft;
}

// ---------- 对话视图（§6 的 (甲)，含 D6 的 join） ----------

export interface ConversationTurn {
  /** 该轮的用户输入（= 面板发出去的 prompt） */
  user: string;
  /** 该轮的回复；失败轮 / 中止轮 / 尚未回写时为 null */
  assistant: string | null;
  /**
   * 按 run 的**实际终态**标失败（D6 的规则）。
   *
   * 为什么需要它：`runtime/run.ts` 只在**成功**轮次回写 session ⇒ 失败的那轮在
   * 会话文件里**根本不存在**，谈不上「标失败」。所以面板必须把 **run 列表**与
   * **会话文件**对上 —— 键是 run 根 span 的 `session.id`。
   * 漏了这个 join 的症状是「显示一份**少了**一轮的对话」，同样是「一份不存在的
   * 对话」，只是方向相反、且更难发现（人天然以为失败那次没跑）。
   *
   * ⚠️ **中止不算失败**（见 `runIsFailure`）：`abortedResult()` 刻意给已取消的 run
   * 带结构化 error，只看 `ok` 会把「我按了中止」记成「这一轮失败了」—— 与通知条
   * （`runDoneNotice`）同一类错，只是它从另一个表面（`ok`）漏出来。
   */
  failed: boolean;
  /** 该轮是**人被中止**的（既不是成功也不是失败）：面板据此换一句文案与一种左边线 */
  aborted: boolean;
  /** 该轮对应的 run（能对上时有值） */
  traceId: string | null;
}

/** 会话文件里的一条消息（形状的单源在 dev-protocol，这里只是给面板侧一个短名字） */
export type { SessionMessageLike };

/**
 * run 列表里与对话有关的那几列 —— **从 `RunSummary` 投影，不再手抄一份**。
 *
 * 为什么改成投影（2026-11-12 二次修）：这里原先手写着 `prompt?: string | null`，
 * 而 `/api/runs` 的真实形状是 `note: { prompt }` ⇒ 类型上「编译得过」、单测里
 * 「喂的也是手抄的形状」，于是失败轮 / 中止轮**一轮都 join 不出来**也没人发现。
 * 手抄的形状就是那次 bug 的根因：它不会随生产形状一起变。用 `Pick` 之后，服务端
 * 改字段名 / 挪位置，`tsc` 当场红 —— 不再靠「记得同步」。
 */
export type ConversationRunLike = Pick<
  RunSummary,
  'traceId' | 'ok' | 'stopReason' | 'sessionId' | 'note'
>;

/**
 * 收尾原因在**看板上的四类**（`AgentStopReason` 有 14 个成员，一色一个没法认：
 * 13 种收尾里三对是同一件事的不同强度）。
 *
 *   正常收尾   end_turn / stop_sequence
 *   人中止     aborted        —— 不是失败，是用户按了按钮
 *   等人审批   suspended      —— **既不是成功也不是失败**：run 带着完整消息历史挂起，
 *                                决定之后从原处继续。渲染成一个蓝点会让用户以为跑完了
 *   被拦住     ok === false 的其余全部（max_tokens / budget_exceeded / max_iterations / …）
 *
 * 第四类刻意**不逐个列举**：它是「不在这三张白名单里的都算」，所以框架新增一个
 * `AgentStopReason` 时面板不会把它静默归成「正常完成」—— 新原因默认落进「被拦住」并
 * 显示原文（`stopReasonText` 对不认识的串原样返回）。反面做法（列全 14 个值再兜底成 ok）
 * 一旦漏一个新成员，症状是**新护栏被显示成正常收尾**，正是这次要修的错。
 */
export type StopClass = 'ok' | 'aborted' | 'suspended' | 'failed';

export function stopReasonClass(r: { ok: boolean; stopReason?: string | null }): StopClass {
  const sr = r.stopReason ?? null;
  if (sr === 'aborted') return 'aborted';
  // suspended 先于 ok 判：引擎的 `isSuccessStopReason` 不把它算成功，而 trace 状态记 ok
  // （挂起段本身执行无误）⇒ 只看 ok 就漏了「这一轮其实还等着人」。
  if (sr === 'suspended') return 'suspended';
  return r.ok ? 'ok' : 'failed';
}

/**
 * 收尾原因的**中文短语**（面板显示用）。
 *
 * 未知串**原样返回**（不回落成「完成」、也不回落成空串）：面板不认识的
 * `stop_reason` 只能说明面板落后于框架，把原文亮出来才能一眼看出是哪个新原因。
 * 要覆盖的成员由 `test/stop-reason.test.mjs` 对着 `src/engine/types.ts` 的
 * `AgentStopReason` 逐个数 —— 框架加了成员而这里没表态，那条守卫就红。
 */
const STOP_REASON_TEXT: Record<string, string> = {
  end_turn: '模型自然收尾',
  stop_sequence: '命中停止序列',
  max_tokens: '撞到输出上限',
  model_context_window_exceeded: '撞到上下文窗口',
  refusal: '模型拒绝回答',
  pause_turn: '模型请求暂停',
  max_iterations: '撞到迭代上限',
  result_missing: '没提交结构化结果',
  budget_exceeded: '撞到预算护栏',
  aborted: '已中止',
  tool_use_no_blocks: '回合里没有可执行块',
  suspended: '等人审批',
  unknown_stop_reason: '未识别的收尾原因',
  error: '出错',
};

export function stopReasonText(sr: string | null | undefined): string {
  if (!sr) return '';
  return STOP_REASON_TEXT[sr] ?? sr;
}

/**
 * 这个 run 算不算**失败**？
 *
 * ⚠️ 这是语义判别，不能在各处直接读 `ok` —— 引擎的 `abortedResult()` 刻意给
 * 「被人中止」的 run 带上结构化 error（取消不是失败，但原因要可查，见 `loop-result.ts`），
 * 于是 `ok === false`。只看 `ok` 的两个表面会一起说谎：
 * - run 列表把它标成红点（用户会以为是自己把工程改坏了）；
 * - 对话视图给这一轮打红边「（这一轮失败了…）」，而同一个 run 的通知条写着「已中止」。
 *
 * 判别顺序归 `stopReasonClass`（**先 stopReason 后 ok**），与 `runDoneNotice` 同一条语义。
 * 这里只是它的一元投影 —— 别在两处各写一遍：
 * `suspended` 也不是失败（挂着等人，`ok` 同样可能是 false），旧实现漏掉它。
 */
export function runIsFailure(r: { ok: boolean; stopReason?: string | null }): boolean {
  return stopReasonClass(r) === 'failed';
}

/** `MessageParam.content` 可能是 string，也可能是 content block 数组 —— 只取文本块 */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

/**
 * 把「会话文件里的消息」与「run 列表里失败的那些 run」拼成对话流。
 *
 * 合并规则（D6 评审补充落成的形状）：
 *
 * > 对话流的每一轮 = 「会话文件里的一条消息」**∪**
 * > 「run 列表里 `session.id` 相同、但没有回写会话的（失败 / 被中止）run」
 *
 * 失败轮的去重键用 **prompt 文本**：会话文件里已经有同一句 user 消息（说明那轮
 * 其实回写成功了）就不重复追加。这比按序号对更稳 —— 会话文件会被裁剪、也会被
 * 手工改（那正是「面板显示一份不存在的对话」的入口，所以面板**只读**它）。
 *
 * ⚠️ **中止轮也走这条 join**（`failed: false` / `aborted: true`）：框架只在**成功**路径
 * 回写会话，所以被中止的那轮同样「会话文件里没有」；把它排除掉会让面板显示一份
 * **少了一轮**的对话 —— 与「多了一轮」同类的静默不一致，只是更难发现。
 * 但它绝不能像失败轮那样标红（判别走 `runIsFailure`）。
 */
export function mergeConversation(
  messages: SessionMessageLike[],
  runs: ConversationRunLike[],
  sessionId: string,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;

  for (const m of messages) {
    const text = textOfContent(m.content);
    if (m.role === 'user') {
      current = { user: text, assistant: null, failed: false, aborted: false, traceId: null };
      turns.push(current);
      continue;
    }
    if (m.role === 'assistant' && current) {
      current.assistant = current.assistant === null ? text : `${current.assistant}\n${text}`;
    }
    // 其它角色（tool_result 等）不进对话流：它是实现细节，不是「对话」
  }

  // 失败 / 中止轮：同 session、终态非成功、且没在会话文件里出现过的那次输入
  const seen = new Set(turns.map((t) => t.user));
  for (const r of runs) {
    if (r.ok) continue;
    if ((r.sessionId ?? null) !== sessionId) continue;
    const prompt = (r.note?.prompt ?? '').trim();
    if (prompt.length === 0 || seen.has(prompt)) continue;
    seen.add(prompt);
    // 判别顺序（先 stopReason 后 ok）在 runIsFailure 里，与通知条同一条语义
    const failed = runIsFailure(r);
    turns.push({ user: prompt, assistant: null, failed, aborted: !failed, traceId: r.traceId });
  }
  return turns;
}

/**
 * 对话视图出不出现。三条**都**满足才显示，不做空壳：① dev 环在场且可用（只读面板没有
 * 输入条 ⇒ 没有多轮）；② 多轮开着（单轮不写会话文件）；③ 会话文件读得到（工程没配
 * `SessionStore` 时它是 null）。缺一条就只剩空壳 —— 那比不显示更糟：用户以为对话跑丢了。
 */
export function chatViewVisible(
  dev: { available: boolean } | null,
  multiTurn: boolean,
  session: { messages: unknown[] } | null,
): boolean {
  return dev?.available === true && multiTurn && session !== null;
}

/**
 * 对话轮折叠态的键：**必须混进 sessionId**。清空对话换 id 后下标从 0 重来，
 * 只用下标当键会把旧会话第 0 轮的展开态套到新会话第 0 轮上（张冠李戴）。
 */
export function turnKey(sessionId: string, index: number): string {
  return `turn:${sessionId}:${index}`;
}

// ---------- CLI 侧记账（面板发出去的东西，CLI 自己记一笔） ----------

/**
 * 往 notes 表里记一条，并**按插入序**把表压在 `max` 以内。
 *
 * 为什么淘汰必须在这里（而不是只跟着 `runs`）：`noteRun` 记的 traceId 可能
 * **永远进不了** `runs` —— trace 是 run 收尾时经 `POST /ingest` 另一路投递的，
 * sink 失败 / agent 进程被杀就没有那条 trace，这条 note 便无人认领。而 dev 是**长跑**
 * 进程（一次调试会话里反复运行）⇒ 无人认领的 note 只涨不降。
 *
 * ⚠️ 旧实现把淘汰只挂在「traceId 进 `runs`」那一条路上，注释却写着「与 runs 同步淘汰」
 * —— 「注释与事实不符」本身也是本仓在猎的东西，所以这段落到有单测的 panel-logic 里。
 */
export function rememberNote<T>(
  notes: Map<string, T>,
  traceId: string,
  note: T,
  max: number,
): void {
  // 重新 set 同一个 key 不改变插入序（Map 语义）⇒ 不需要先 delete 再 set
  notes.set(traceId, note);
  while (notes.size > max) {
    const oldest = notes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    notes.delete(oldest);
  }
}

// ---------- 并排 A/B 的可比性判据（档 B / plans/2026-10-05-dev-workbench.md §3.3） ----------

/** 对比选择态的**上限**：并排就是并排两块，第三块没有版面（也读不过来） */
export const COMPARE_MAX = 2;

/**
 * 点 run 条目时**对比选择**该怎么变（⌘/Ctrl + 单击；普通单击仍是「打开」）。
 *
 * 三条口径：
 * - **再点已选中的那条 ⇒ 取消它**（而不是「凑不满两块就不动」）—— 用户要能改主意；
 * - **超过两块 ⇒ 挤掉最早选的那条**（FIFO）：不静默丢弃后来的选择；
 * - **单选状态下重复点同一条** ⇒ 原样返回（幂等，不产生 `[a, a]`）。
 *
 * 为什么不设「未满两块时点了就退出对比」：那会让「我想退出对比」需要额外的按钮
 * （面板已经有「打开」这个天然出口了 —— 普通单击就回到单run 视图）。
 */
export function toggleCompare(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  if (selected.length < COMPARE_MAX) return [...selected, id];
  return [selected[1], id];
}

/** 并排对比要看的两条 run 的**开发侧元信息**（`RunNote` 的形状，见 dev-protocol.ts） */
export interface ComparableNote {
  /**
   * 能力选择的**三种全量表示**都要收（`null` / `undefined` / `[]`）—— 见 `capsKey`。
   * `RunNote.toolSources` 声明的是 `string[] | null`，但面板侧的
   * `normalizeToolSources` 会回 `undefined`、且把空集也当全量；判据若只认一种
   * 就会把「全量 vs 全量」判成不同 ⇒ 每次正常 A/B 都飘一条假警告（实测踩过）。
   */
  toolSources: string[] | null | undefined;
  workdir: string;
}

/** 可比性判定的结果。`level` 决定面板显示多强的提示 —— 见 `comparability` 的注释 */
export interface Comparability {
  level: 'comparable' | 'workdir-differs' | 'capabilities-differ';
  /** 给面板直接显示的一句话（中文，与面板其余文案同口径） */
  message: string;
}

/**
 * 「全量」的归一化键：空/null/undefined **都是**全量（与 `normalizeToolSources` 同口径）。
 *
 * ⚠️ **分隔符用 `'\\n'`，不是 `'\u0000'`** —— 别照抄 `dev-logic.sameToolSources` 的 NUL：
 * 它比的是**拼接后的字符串**（NUL 不可能出现在能力名里，安全），而这里若把**字面 NUL
 * 字符**打进 `.ts` 源文件，整个文件会被 `file`/grep 判成 **binary**（实测踩过：
 * `grep` 报「Binary file matches」、`tsc` 照过，但源码审查工具与 diff 全废）。
 * 能力名走 `^[A-Za-z0-9_-]{1,64}$`（框架装配期校验），换行同样不可能出现。
 */
function capsKey(toolSources: string[] | null | undefined): string {
  if (toolSources === null || toolSources === undefined || toolSources.length === 0) return '*';
  return [...toolSources].sort().join('\n');
}

/**
 * 面板此刻该显示成什么样子（档 B 的视图判定，从 DOM 里抽出来以便单测）。
 *
 * ⚠️ 三个态而不是「并排 / 不并排」两态 —— 中间那态（**选了一条、还没选第二条**）必须
 * 独立出来：它显示单 run 视图但**保留选择**。若把它并进「不并排」，两种后果二选一：
 * ① 每次取消选择都把用户已选的第一条也清掉（选第二条得从头点两下）；
 * ② 保留选择但显示双栏 ⇒「并排」只有一栏，比不显示更让人困惑。
 *
 * 判据用 `COMPARE_MAX`（=2）而不是硬编码 2：上限若被改，这里跟着改；
 * ⚠️ 面板里**不许**再写 `length < 2` 这类字面量 —— 那是本文件存在的意义（单源）。
 */
export type CompareView = 'single' | 'picking' | 'dual';

export function compareView(compare: string[]): CompareView {
  if (compare.length === 0) return 'single';
  return compare.length < COMPARE_MAX ? 'picking' : 'dual';
}

/**
 * 新 run 收尾后**自动**把它补进对比（把「改 prompt → 重跑 → 对照」这一跳补上）。
 *
 * 为什么要有：档 B 落地时那条承诺是「改一句 prompt 就能**立刻重跑对照**」，可配对要用户
 * 手动 ⌘ 点两条 —— 三步操作不是「立刻」。这个判定把中间那一步吞掉。
 *
 * 为什么**只在 picking 态**（已选一条、还没选第二条）触发：
 * - 空选择 ⇒ 用户还没表达对比意图，自动切双栏是**替用户决定**（会被读成面板在乱跳）；
 * - 已选两条 ⇒ 用户已经选好了，再塞一条等于**挤掉**他刚选的那条；
 * - dev 环是**单飞**的 ⇒ picking 态下新收尾的那条必然是用户刚跑的那条，而他在 picking
 *   态下的意图几乎必然是「拿它跟刚跑的这条比」⇒ 误伤概率极低。
 *
 * ⚠️ **不静默**：触发时面板播一条 notice（调用侧负责），所以「为什么屏幕变双栏了」用户
 * 立刻知道；退出路径 = 普通单击任意一条（那条路径有单测，且本批刚补过「必须走
 * `exitCompare()`」的守卫 W4）。
 *
 * ⚠️ **不动单飞**：这是「事后回看」的自动化，不是「同时跑」—— 真并发要改
 * `shouldDeferRestart` 那条单源化判据（设计稿 §8 的「不做」）。
 *
 * @returns 新的选择数组；`null` = 不该自动配对（调用侧保持原样，别自己改成 `[]`）
 */
export function autoPairTarget(selected: string[], incomingId: string): string[] | null {
  if (selected.length !== 1) return null;
  const base = selected[0];
  if (base === incomingId) return null;
  return [base, incomingId];
}

/**
 * 一条差异该怎么显示（`renderDiff` 里的分支，抽出来以便单测）。
 *
 * 为什么值得抽：`sp.missing` 那条判错的后果是**静默指错方向** —— 缺侧记录会显示成
 * 「B侧少一个能力」，而真相是 A 侧独有。`diff-a` / `diff-b` 是**展示用**的标签
 * （`diffTraces` 的 `missing` 真值是 `'a' | 'b'`，由 `packages/cli/src/diff.ts` 定）。
 */
export function diffSideLabel(missing: string): 'A' | 'B' {
  return missing === 'a' ? 'A' : 'B';
}

/**
 * 差异值的一行文本（`null` / `undefined` ⇒「（无）」）。
 *
 * ⚠️ **不能用 `??` 把缺省折成空串或 0**：那会让「字段不存在」显示成「值是 0/空」——
 * 本仓反复踩的那类假读数（读数与「读不出」在业务上可分时，不许拿缺省值糊过去）。
 */
export function diffValueText(v: unknown): string {
  if (v === null || v === undefined) return '（无）';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * compare 端点**失败**时的那句提示（档 B）。
 *
 * ⚠️ **不能用 `body.error || res.status`**：`||` 把「服务端返回了空串 / 没有 error 字段」
 * 一律折成状态码 —— 那是本仓反复踩的「读不出伪装成读数」同族（`?? 0` 那条纪律的字符串版）。
 * 口径：`error` 是**非空字符串**才用它，否则回落 HTTP 状态码（那个一定是真的）。
 * ⚠️ 也不要把「读body 失败」折成空对象就完事 —— 那样显示的是「读差异失败：500」而真相是
 * 「响应不是 JSON」（网关插了页 / token 过期返回 HTML）。
 */
export function diffFetchErrorText(
  status: number,
  body: { error?: unknown } | null,
  parseFailed: boolean,
): string {
  if (parseFailed) return `读差异失败：响应不是合法 JSON（HTTP ${status}）`;
  const e = body?.error;
  return `读差异失败：${typeof e === 'string' && e.length > 0 ? e : `HTTP ${status}`}`;
}

/**
 * 两条 run 的差异**能不能归因到「我改了什么」**。
 *
 * ⚠️ **这是本档最容易做错的地方**：`diffTraces` 比的是 span 路径与字段，它**不知道**
 * 面板的四个输入里哪些变了。能力选择与工作目录是 **app 级**的（换它们要重启进程，
 * `RunRequest` 的注释已写明）⇒ 两条跨了能力选择的 run，`runConfigSnapshot` 整个变了，
 * diff 出来的差异**大部分与「我改的那句话」无关**。此时静默给一份 diff = 让用户
 * 误读（本仓最忌讳的那类假绿）。所以口径是**显式分三档**：
 *
 * - `comparable` —— 同能力 + 同工作目录 ⇒ 差异可归因（**推荐路径**：只改 prompt / 多轮）；
 * - `workdir-differs` —— 能力同、目录不同 ⇒ 可比，但摘要必须显示目录不同，
 *     否则「差在哪」会被读成「模型变了」；
 * - `capabilities-differ` —— 能力选择不同（**跨了进程重启**）⇒ 提示比对意义有限。
 *
 * 判据用 `capsKey` 归一化：`null`（`RunNote` 的全量）、`undefined`（面板侧
 * `normalizeToolSources` 的全量）、`[]`（被它归一化成全量的那个陷阱值）**三者同义**。
 * 直接比数组会把「全量 vs 全量」判成不同 ⇒ 每次正常 A/B 都飘一条假警告。
 */
export function comparability(a: ComparableNote | null, b: ComparableNote | null): Comparability {
  // note 缺失（trace 落盘后重启面板、或 note 先于 trace 被淘汰）⇒ **不猜**，按不可比处理
  if (a === null || b === null) {
    return {
      level: 'capabilities-differ',
      message: '这两条 run 里有一条缺少开发期元信息（能力选择 / 工作目录不可知），比对意义有限',
    };
  }
  if (capsKey(a.toolSources) !== capsKey(b.toolSources)) {
    return {
      level: 'capabilities-differ',
      message: '这两条 run 的能力选择不同（跨了进程重启），比对意义有限 —— 建议只改 prompt 后重跑',
    };
  }
  if (a.workdir !== b.workdir) {
    return {
      level: 'workdir-differs',
      message: `注意：这两条 run 的工作目录不同（${a.workdir} vs ${b.workdir}）`,
    };
  }
  return { level: 'comparable', message: '' };
}

// ---------- run 收尾的反馈语 ----------

/**
 * `run-done` → 面板底部那句操作反馈。
 *
 * 为什么这是一条**规则**而不是 HTML 里的三行 if（那份没有单测）：判别顺序是语义。
 * 引擎的 `abortedResult()` **刻意**给已取消的 run 带上结构化 error（取消不是失败，
 * 但原因要可查）⇒ 中止时 `ok` 也是 **false**。所以必须**先**认 `stopReason`：
 * 反过来先看 `ok`，用户按的「中止」就会被显示成一句吓人的「run 失败」。
 * 这个顺序错一次很难在 code review 里看出来，所以钉在单测里。
 *
 * 四类模板（`stopReasonClass`）：原文一起给 —— 「撞到预算护栏」是给人读的，
 * `budget_exceeded` 是给人 grep 的，两者都要。
 */
export function runDoneNotice(ev: { ok: boolean; stopReason: string; error: string | null }): {
  text: string;
  isError: boolean;
} {
  const cls = stopReasonClass(ev);
  const text = stopReasonText(ev.stopReason);
  // 中文短语与标识符不同才拼（未识别的串 `text === sr`，只显示一次）
  const why = text && text !== ev.stopReason ? `${text} · ${ev.stopReason}` : ev.stopReason;
  if (cls === 'aborted') {
    return { text: 'run 已中止（trace 保住了）', isError: false };
  }
  if (cls === 'suspended') {
    // 挂起不是结束：run 带着完整消息历史等人裁决，之后从原处继续。
    // 旧文案把它写成「run 完成（suspended）」—— 那是在说一件没发生的事。
    return { text: `run 停在审批（${why}）：裁决之后从挂起处继续`, isError: false };
  }
  if (cls === 'failed') {
    return { text: `run 失败（${why}）：${ev.error || '未知原因'}`, isError: true };
  }
  return { text: `run 完成（${ev.stopReason}）`, isError: false };
}

// ---------- ⑤ run 级总账（打开一条 run，先给「这一趟的账」） ----------

/**
 * 面板算得出来的那部分 trace 形状（只列总账要用的字段）。
 *
 * 为什么不 import 框架的 `Trace`：CLI 零运行时依赖，且框架实例来自**用户工程**
 * （`req.resolve('@migor/agentia')`）—— 类型在这里再写一遍是既有口径（见 dev-protocol）。
 */
export interface LedgerTraceLike {
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costEstimate?: number;
  } | null;
  spans?: Array<{
    kind?: string;
    status?: string;
    attributes?: Record<string, unknown>;
    events?: Array<{ name?: string }>;
    /** 根 span 上的这两个数就是「这一趟跑了多久」的唯一来源（别从 usage / 事件推） */
    startedAt?: number;
    endedAt?: number;
  }> | null;
}

/** 总账的一项。`tone` 只影响颜色（`err` = 真的有人失败，不是「有风险」） */
export interface LedgerItem {
  key: string;
  value: string;
  /** 悬停才显示的**口径**说明：读数与它的算法必须一起给，否则「77%」是没法核对的 */
  title?: string;
  tone?: 'err' | 'warn';
}

/**
 * 时长显示（**唯一一份**）：run 列表第二行、总账的「耗时」、在飞占位共用。
 * `>= 1s` 用两位小数秒（`12.40s`），否则毫秒 —— 1.5 秒显示成 `1500ms` 比 `1.50s` 难读。
 * 负数 / NaN 一律当 0（宁可显示 `0ms`，也不让 `NaNs` 出现在账上）。
 */
export function fmtMs(ms: number): string {
  const n = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

function ledNum(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 一条 run 的账：`3 轮 · 7 次工具 · 2 失败 · in 8.1k / out 1.5k · cache 6.2k · 77% · $0.014`。
 *
 * 为什么值得单独一条纯函数：这五个数此前**一个都没有**（页面上只有 footer 的 in / out），
 * 而它们全都在 `Trace.totalUsage` 与 span 上。其中**cache 命中率**是这类面板最该给、又最常
 * 缺的一个数 —— 它直接对应账单（缓存读的单价通常只有未命中的 1/10）。
 *
 * 三条口径（都是「不给假读数」）：
 * - 分母为 0 / 字段缺失的那一项**整项不出现**，不显示 `0%` / `$0.0000`。
 *   「成本是 0」与「没有单价表」是两件事，折成同一个 `$0` 就是在说谎。
 * - cache 命中率 = 读 /(读 + 写 + 未命中输入)。**分母含缓存写入**：只算读除以输入会让
 *   「刚写了一大块缓存」的那次 run 显示成 100% 命中 —— 那正是最容易误读的时刻。
 * - 轮次/工具数**从 span 与事件里数**，不读 `AgentRunResult.iterations`：后者不在 trace 上
 *   （`engine/loop.ts` 只把它写进返回值），而面板手上只有 trace。数出来的口径写在 title 里。
 */
export function runLedger(
  trace: LedgerTraceLike | null,
  budget?: { maxCostUsd?: number } | null,
): LedgerItem[] {
  const items: LedgerItem[] = [];
  if (!trace) return items;
  const spans = Array.isArray(trace.spans) ? trace.spans : [];

  const turns = spans.filter((s) => s && s.kind === 'llm.turn').length;
  if (turns > 0)
    items.push({
      key: '轮次',
      value: `${turns} 轮`,
      title: '按 llm.turn span 数（一次模型往返 = 一轮）',
    });

  let toolCalls = 0;
  for (const s of spans) {
    for (const ev of s?.events ?? []) {
      if (ev && ev.name === 'tool.input') toolCalls += 1;
    }
  }
  if (toolCalls > 0) {
    items.push({
      key: '工具',
      value: `${fmtCount(toolCalls)} 次`,
      title: '按 tool.input 事件数（普通工具不建 span）',
    });
  }

  const errors = spans.filter((s) => s && s.status === 'error').length;
  if (errors > 0) {
    items.push({ key: '失败', value: `${fmtCount(errors)} 个 span`, tone: 'err' });
  }

  /* 耗时：根 span 的 `endedAt − startedAt`。此前总账里没有这一项（review P1-1 点名的
     「12.4s」），而它是「这一趟到底花在哪儿」的基线 —— 没有它，8.1k in / 1.5k out 是
     悬空的。**缺任一端就不显示**（在飞的 trace 没有 endedAt）：记 0 会被读成「瞬间跑完」。 */
  const root = spans.find((s) => s && s.kind === 'run') ?? spans[0];
  const st = ledNum(root?.startedAt);
  const en = ledNum(root?.endedAt);
  if (st > 0 && en > st) {
    items.push({
      key: '耗时',
      value: fmtMs(en - st),
      title: 'run 根 span 的 endedAt − startedAt（含等待与重试；在飞时不显示）',
    });
  }

  const u = trace.totalUsage ?? null;
  if (u) {
    const inTok = ledNum(u.inputTokens);
    const outTok = ledNum(u.outputTokens);
    if (inTok + outTok > 0) {
      items.push({ key: 'in / out', value: `${fmtCount(inTok)} / ${fmtCount(outTok)}` });
    }
    const cr = ledNum(u.cacheReadTokens);
    const cc = ledNum(u.cacheCreationTokens);
    const miss = inTok;
    const base = cr + cc + miss;
    if (cr + cc > 0 && base > 0) {
      const rate = Math.round((cr / base) * 100);
      items.push({
        key: 'cache',
        value: `${fmtCount(cr)} 读 · ${rate}% 命中`,
        title: `缓存读 ${cr} / 缓存写 ${cc} / 未命中输入 ${miss}；命中率 = 读 ÷（读 + 写 + 未命中）`,
      });
    }
    // 成本：只有框架给得出估算时才显示（无公开单价的服务商给不出 —— 那是「不知道」，
    // 不是「花了 0 元」）
    if (typeof u.costEstimate === 'number' && Number.isFinite(u.costEstimate)) {
      const cap = ledNum(budget?.maxCostUsd);
      items.push({
        key: '成本',
        value:
          cap > 0 ? `$${u.costEstimate.toFixed(4)} / $${cap}` : `$${u.costEstimate.toFixed(4)}`,
        title: '由 token × 单价估算（框架的总账，不是账单）',
      });
    }
  }

  const model = root?.attributes?.model;
  if (typeof model === 'string' && model.length > 0) items.push({ key: '模型', value: model });

  return items;
}

// ---------- ⑥ run 列表的检索 ----------

/** 搜索能命中的几个字段（= 列表上真的看得到的那些 + 收尾原因的中文短语） */
export interface SearchRunLike {
  traceId: string;
  name?: string;
  ok: boolean;
  stopReason?: string | null;
  note?: { prompt?: string | null; workdir?: string | null } | null;
}

/**
 * 一条 run 是否命中关键词。大小写不敏感、纯子串（不做正则：`(` 之类会让输入直接炸）。
 *
 * 搜的字段包含 `stopReasonText`（中文短语）—— 用户想找「撞预算那条」时会打「预算」，
 * 而数据里存的是 `budget_exceeded`。只搜原文等于逼人记住标识符。
 */
export function matchRunQuery(r: SearchRunLike, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle.length === 0) return true;
  const fields = [
    r.note?.prompt ?? '',
    r.name ?? '',
    r.note?.workdir ?? '',
    r.stopReason ?? '',
    stopReasonText(r.stopReason ?? null),
    r.traceId,
  ];
  return fields.some((f) => String(f).toLowerCase().includes(needle));
}

/**
 * 列表过滤：关键词 **且**（可选）「只看异常」。
 *
 * 「异常」= `stopReasonClass !== 'ok'`（失败 / 中止 / 等审批三种都算）。为什么这三种都算：
 * 用户点「只看异常」时想找的是「没正常跑完的那些」，而中止与挂起恰恰是最需要回看的两类 ——
 * 只过滤 `ok === false` 会把挂起的 run（trace 状态是 ok）漏掉。
 */
export function filterRuns<T extends SearchRunLike>(
  runs: readonly T[],
  q: string,
  opts: { onlyAbnormal?: boolean } = {},
): T[] {
  const onlyAbnormal = opts.onlyAbnormal === true;
  return runs.filter((r) => {
    if (onlyAbnormal && stopReasonClass({ ok: r.ok, stopReason: r.stopReason ?? null }) === 'ok') {
      return false;
    }
    return matchRunQuery(r, q);
  });
}

// ---------- ⑦ 深链 / 重跑 ----------

/**
 * `location.search` → 要打开的 run id（`?run=<traceId>`）。
 *
 * 解析失败 / 没有这个参数 / 空串一律 `null`（= 照旧打开最新那条）。不抛：一个手改坏的
 * URL 不该让面板白屏。
 */
export function runIdFromSearch(search: string): string | null {
  const s = String(search ?? '').trim();
  if (s.length === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(s.startsWith('?') ? s.slice(1) : s);
  } catch {
    return null;
  }
  const id = (params.get('run') ?? '').trim();
  return id.length > 0 ? id : null;
}

/**
 * 「重跑」要回填的那四个输入（`RunNote` 里全都有 —— 这正是它值得存的原因）。
 *
 * 三条口径：
 * - **不自动提交**：回填之后由用户按运行。一个自己跑起来的按钮会在误触时花钱。
 * - 能力选择**过滤掉已失效的 token**（能力被删过），过滤后为空则回落全量 ——
 *   `toolSources: []` 在框架侧是「每个 provider 都成了孤儿」的纯陷阱值。
 * - `note` 缺失（trace 不是 dev 环起的 / 已被淘汰）⇒ `null`，调用方负责说「这条 run 没有
 *   开发期元信息，重跑不了」。不猜一个空的 prompt 出来。
 */
export function rerunFromNote(
  note: {
    prompt?: string | null;
    workdir?: string | null;
    toolSources?: string[] | null;
    multiTurn?: boolean;
  } | null,
  all: string[],
): { prompt: string; workdir: string; toolSources: string[]; multiTurn: boolean } | null {
  if (!note) return null;
  const picked =
    note.toolSources === null || note.toolSources === undefined
      ? [...all]
      : filterSelected(note.toolSources, all);
  return {
    prompt: typeof note.prompt === 'string' ? note.prompt : '',
    workdir: typeof note.workdir === 'string' ? note.workdir : '',
    toolSources: picked.length > 0 ? picked : [...all],
    multiTurn: note.multiTurn === true,
  };
}

// ---------- 路径显示 ----------

/**
 * 把绝对路径压短给面板看（`~/proj/a`）。
 *
 * 只影响**显示**：发给子进程的永远是完整绝对路径（工具按它解析），
 * 所以压短不会让「我以为在 A，其实在 B」发生 —— 那正是 D5 要防的时刻。
 */
export function shortenPath(abs: string, opts: { home?: string; cwd?: string } = {}): string {
  if (abs.length === 0) return '';
  const home = opts.home ?? '';
  const cwd = opts.cwd ?? '';
  if (home && (abs === home || abs.startsWith(`${home}/`))) return `~${abs.slice(home.length)}`;
  if (cwd && (abs === cwd || abs.startsWith(`${cwd}/`))) return `.${abs.slice(cwd.length)}`;
  return abs;
}

// ---------- ① 实时右栏：把增量记账帧折回成一棵树 ----------

/**
 * 面板侧的 trace 累加器：**按 `seq` 把增量记账事件应用到一个一个 span 上**。
 *
 * 为什么在面板侧复刻这条折叠规则、而不是让父进程折好再发：框架已经钉着一条不变量
 * （`tests/engine/trace-events.test.ts`）—— 按 `seq` 升序把同一次 run 的全部事件应用到
 * `span.begin` 建出的 span 上，结果**逐字等于**收尾的 `snapshot()`。照它折回就得到与
 * 收尾一致的树，**不需要**任何「哪些字段重要」的本地判断；父进程插一手只会多一处会漂的口径。
 *
 * 两条纪律（与框架同名出口一致）：
 * - **不保证送达**：宿主自己的流断了就断了。所以折出来的这棵是**临时**的 ——
 *   收尾那份整棵 trace 回来时**覆盖**它（面板据此把累加器丢掉），缺的 span 由那份补齐。
 * - **是观察，不是控制**：丢了不影响 run，也不影响收尾的 trace。
 */
export interface TraceAccumulator {
  /** 已应用的最大 `seq` —— 重复投递 / 乱序靠它丢掉（送达的那些只能应用一次） */
  lastSeq: number;
  /** 从第一个 `span.begin` 上读到的 traceId（还没建出节点时是空串） */
  traceId: string;
  spans: TraceSpanLike[];
}

/** 空累加器：`state.live` 的初值，也是 e2e 折回的起点 */
export function emptyTraceAccumulator(): TraceAccumulator {
  return { lastSeq: 0, traceId: '', spans: [] };
}

/**
 * 应用一条增量记账事件。返回**它有没有被用上**（false = 丢了）。
 *
 * 丢的三种情形都是刻意的、**都不抛**：
 * - `seq` 不前进（重复投递、迟到的旧帧）—— SSE 不保证送达，但送达的只能应用一次；
 * - 指向**没见过的 `spanId`**（面板连上得晚，那个 `span.begin` 没收到）—— 绝不能凭空建
 *   节点：那会造出一棵缺了上半截的假树。收尾那份会补齐；
 * - 形状不认识（框架将来加了新事件类型）—— 静默放过，别让整个右栏停摆。
 */
export function applyTraceEvent(acc: TraceAccumulator, ev: TraceRecordEventLike): boolean {
  // 先卡 seq：它同时挡住「重复投递」与「乱序的旧帧」
  if (!ev || typeof ev.seq !== 'number' || ev.seq <= acc.lastSeq) return false;
  const find = (spanId: string): TraceSpanLike | undefined =>
    acc.spans.find((s) => s.spanId === spanId);
  switch (ev.type) {
    case 'span.begin': {
      const src = ev.span;
      // 拷一份：折回不该持有（更不该改写）协议对象 —— 面板会重画很多次
      const copy: TraceSpanLike = {
        ...src,
        attributes: { ...src.attributes },
        events: (src.events ?? []).map((e) => ({ ...e })),
      };
      const seen = find(src.spanId);
      // 同一个 `spanId` 再来一次 ⇒ **原地刷新**（重放幂等），不再挂一个同 id 的节点
      if (seen) Object.assign(seen, copy);
      else {
        acc.spans.push(copy);
        if (!acc.traceId) acc.traceId = src.traceId;
      }
      break;
    }
    case 'span.end': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.endedAt = ev.endedAt;
      s.status = ev.status;
      if (ev.error) s.error = { ...ev.error };
      if (ev.usage) s.usage = { ...ev.usage };
      break;
    }
    case 'span.event': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.events.push({ ...ev.event });
      break;
    }
    case 'span.attribute': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.attributes = { ...s.attributes, [ev.key]: ev.value };
      break;
    }
    case 'span.link': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.links = [...(s.links ?? []), ev.link];
      break;
    }
    default:
      return false;
  }
  acc.lastSeq = ev.seq;
  return true;
}

/**
 * 当前已知的这棵树（交给 `playTrace` 画）。返回的是**副本** —— 渲染层拿它排序 / 展开，
 * 不该回头改到累加器（下一次重画还要用同一份账）。
 *
 * `status` 只区分**在飞**与**已收尾**：根 span 还没有 `endedAt` 就是「在飞」，渲染层据此
 * **不收尾**（否则根会被画成「已在某一刻完成」，那是个假事实）。收尾后取根自己的状态
 * （`ok` / `error`），与框架口径一致。
 */
export function partialTrace(acc: TraceAccumulator): {
  traceId: string;
  spans: TraceSpanLike[];
  status: string;
} {
  const spans = acc.spans.map((s) => ({
    ...s,
    attributes: { ...s.attributes },
    events: s.events.map((e) => ({ ...e })),
  }));
  const root = spans.find((s) => s.parentSpanId === null);
  const status = root && root.endedAt === undefined ? 'running' : (root?.status ?? 'running');
  return { traceId: acc.traceId, spans, status };
}

// ---------- ② 回复正文的归属 ----------

/**
 * 「`open(id)` 该不该**保留**屏幕上这条回复」。
 *
 * 背景：`run-done` 把回复正文写上去之后，面板会**自动 open 刚跑完的那一轮** ——
 * 而 `open()` 原本无条件清掉回复区，于是那句回复在十几毫秒后被自己擦掉（看起来像「没回复」）。
 *
 * 口径与 `open()` 的原意图对齐：只有「现在打开的就是这条回复的主人」才保留；其余一律清
 * （打开一条历史 run 时若还挂着**别人**的回复，那是张冠李戴 —— 比空白更糟）。
 * `replyFor` 为 null（还没跑过 / 已清）**不等于**「谁都对」：默认清。
 */
export function replyBelongsTo(openId: string | null, replyFor: string | null): boolean {
  if (!openId || !replyFor) return false;
  return openId === replyFor;
}

// ---------- ③ 目录浏览 / 选文件 ----------

/**
 * 点「浏览…」时该打开哪个目录：**总是**按输入框的值。
 *
 * 旧实现把它当**开关**（面板开着时再点一次就关掉），于是「在输入框敲了目标路径 → 点浏览…」
 * 这个最自然的动作反而是把面板关掉，用户就以为「选不了别的目录」。空值才回落到缺省工作目录；
 * 首尾空白不该让路径读错。
 */
export function browseTarget(value: string, defaultDir: string): string {
  const v = value.trim();
  return v.length > 0 ? v : defaultDir;
}

/**
 * 点一个**文件**之后的 prompt 该是什么。
 *
 * 口径：**只在 prompt 为空时**填文件名（省一次打字）；用户已经写好的话**一个字都不动** ——
 * 悄悄改写用户输入比少填一次糟得多。`filled` 是给面板回话用的（提示文案不同）。
 * 工作目录的切换（取该文件**所在的**目录）由调用方做，不在这个纯判定里。
 */
export function promptAfterFilePick(
  current: string,
  name: string,
): { prompt: string; filled: boolean } {
  if (current.trim().length > 0) return { prompt: current, filled: false };
  return { prompt: name, filled: true };
}

// ---------- ③ 消息折叠：长正文默认收起，短的不加控件 ----------

/**
 * 超过这么多行就默认折叠。12 行是「一屏大致读得完」的量级 —— 面板右栏在 1223px 下正文行高
 * 约 18px，12 行 ≈ 216px，正好是不把调用树挤出去的上限。
 */
export const COLLAPSE_MAX_LINES = 12;
/** 单行长正文的兜底阈值：一行 2000 字符（模型不换行时很常见）同样该收起来 */
export const COLLAPSE_MAX_CHARS = 1200;

/**
 * 「这段正文要不要折叠」。**判定是纯逻辑** —— 渲染层只管按结果挂控件，
 * 不自己量高度（量高度依赖布局与字体，单测里量不出来，等于把规则藏进浏览器）。
 *
 * 为什么不按像素量：像素阈值在字体/缩放/窄屏下会漂，同一个回复在不同机器上折叠与否都不一样；
 * 行数 + 字符数是**输入本身的属性**，可复现、可断言。
 *
 * `hint` 是给展开控件用的文案（面板拿它当按钮标题，再加个 caret）；不折叠时是空串 ——
 * **短消息上挂一个「展开」是噪声**，所以控件只在真的长时出现。
 */
export function collapseDecision(
  text: string,
  opts: { maxLines?: number; maxChars?: number } = {},
): { collapsed: boolean; lines: number; chars: number; hint: string } {
  const t = String(text ?? '');
  const lines = t.length === 0 ? 0 : t.split('\n').length;
  const chars = t.length;
  const maxLines = opts.maxLines ?? COLLAPSE_MAX_LINES;
  const maxChars = opts.maxChars ?? COLLAPSE_MAX_CHARS;
  const collapsed = lines > maxLines || chars > maxChars;
  const hint = collapsed
    ? lines > 1
      ? `展开全文（共 ${lines} 行）`
      : `展开全文（共 ${chars} 字符）`
    : '';
  return { collapsed, lines, chars, hint };
}

// ---------- ④ 右栏三块的标题栏读数：**收起不等于失明** ----------

/**
 * 右栏三块（调用树 / 能力排行 / 回复）都能折叠（2026-11-12 ref-panel-panes）。
 *
 * 折叠后标题栏是这一块**唯一**还看得见的东西 ⇒ 它必须自己回答「值不值得展开」。
 * 这不是装饰：把整块收起来却一个数都不留，用户就只能在「占屏」与「失明」之间二选一 ——
 * 那恰好是这次改动之前的状态（三块挤在一列，谁都不够高）。
 *
 * 三条都是**纯格式化**（不量 DOM、不读时钟、不看窗口），所以它们进得了单测；
 * 面板那边只负责把返回值写进 `textContent`。
 */
function fmtCount(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1000) return String(v);
  const k = v / 1000;
  // 一万以上不保留小数：标题栏只有一行，`12.3k` 比 `12k` 多不出信息
  return `${k < 10 ? k.toFixed(1) : String(Math.round(k))}`.replace(/\.0$/, '') + 'k';
}

/** 调用树：`58 span`。span 数是这一块「有没有东西看」的最小信号，也随在飞帧增长 */
export function traceMeta(spanCount: number): string {
  return `${fmtCount(spanCount)} span`;
}

/**
 * 能力排行：`7 项 · 24 次 · 2 失败`。
 *
 * 失败数**只在真的有人失败时**出现 —— 恒挂一个「0 失败」等于给每一行加噪声，
 * 与 `collapseDecision` 的 `hint` 同一条纪律（空的话就别占位置）。
 * `errors` 的语义是**工具/护栏报错次数**（`summarizeTrace` 的账），不是「有几个能力出错」。
 */
export function summaryMeta(rows: ReadonlyArray<{ calls: number; errors: number }>): string {
  if (!Array.isArray(rows) || rows.length === 0) return '0 项';
  let calls = 0;
  let errors = 0;
  for (const r of rows) {
    calls += Number.isFinite(r?.calls) ? r.calls : 0;
    errors += Number.isFinite(r?.errors) ? r.errors : 0;
  }
  const head = `${rows.length} 项 · ${fmtCount(calls)} 次`;
  return errors > 0 ? `${head} · ${fmtCount(errors)} 失败` : head;
}

/**
 * 回复：`32 行 · 1.4k 字符`。
 *
 * 行/字符数的算法**复用 `collapseDecision`**（同一个 `split('\n')` 口径）——
 * 标题栏说「32 行」而正文折叠控件说「共 31 行」是最难查的一类不一致。
 */
export function replyMeta(text: string): string {
  const d = collapseDecision(text);
  return d.lines > 1 ? `${d.lines} 行 · ${fmtCount(d.chars)} 字符` : `${fmtCount(d.chars)} 字符`;
}
