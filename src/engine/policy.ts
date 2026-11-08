import type { ContextPolicy } from './types.js';
import {
  compactMessages,
  createTokenCounter,
  defaultEstimateTokens,
  trimToolPairs,
} from './trimming.js';

/**
 * Agentia —— 预算驱动的上下文策略（spec §5 compaction / §6 budget）。
 *
 * 规则（带滞回，避免每回合反复压缩）：
 * 1. 估算整组消息 token；≤ budgetTokens → 原样放行（快路径）。
 * 2. 超预算：先 **context editing**（trimToolPairs 丢旧工具对，不额外调模型）；
 *    若裁剪后回到预算内即止。
 * 3. 仍超预算且有 summarize（compaction 摘要器）→ 压缩：旧前缀做成摘要，只留最近 keepRecent 条。
 *    距上次**成功**压缩 < compactEvery 个回合则跳过（滞回，防抖）；压缩抛错**不**记额度
 *    （失败不该连带吃掉后面几回合的重试机会，见 beforeTurn 里的注）。
 * 4. 无 summarize 时 compaction 不可用，编辑已是上限（返回裁剪后消息）。
 *
 * summarize 未提供时 policy 不会自己调模型 —— 框架不替你造 token（spec：不主动黑名单，
 * 预算只是护栏；真机可注入按 /count_tokens 的 estimate 与走模型的 summarize）。
 */
export interface BudgetPolicyOptions {
  /** 预算（估算 input tokens）；缺省 60_000 */
  budgetTokens?: number;
  /** compaction 保留的最近消息**条数**；缺省 20（喂给 compactMessages） */
  keepRecent?: number;
  /**
   * context editing（trimToolPairs）保留的最近工具**对数**；缺省 1。
   *
   * 与 `keepRecent` 刻意分开：一个是「消息条数」（compaction 用），一个是
   * 「tool_use→tool_result 对数」（编辑用）——同一个值套两种单位会让调用方
   * 调出来的效果与预期不符。
   */
  keepToolPairs?: number;
  /** token 估算函数（预算决策用，非精确记账）；缺省 CJK 感知启发式 */
  estimateTokens?: (text: string) => number;
  /** 是否先编辑再压缩；缺省 true */
  editBeforeCompact?: boolean;
  /** 提供则允许 compaction（旧前缀→摘要）。框架不自动造摘要器 */
  summarize?: (historyText: string) => string | Promise<string>;
  /** 距上次压缩至少隔几个回合才再次压缩（滞回）；缺省 1 */
  compactEvery?: number;
}

export function createBudgetPolicy(opts: BudgetPolicyOptions = {}): ContextPolicy {
  const budgetTokens = opts.budgetTokens ?? 60_000;
  const keepRecent = Math.max(1, opts.keepRecent ?? 20);
  const keepToolPairs = Math.max(0, opts.keepToolPairs ?? 1);
  const estimate = opts.estimateTokens ?? defaultEstimateTokens;
  const editBeforeCompact = opts.editBeforeCompact ?? true;
  const summarize = opts.summarize;
  const compactEvery = Math.max(1, opts.compactEvery ?? 1);
  let lastCompactAt = Number.NEGATIVE_INFINITY;
  // 增量计数：历史只追加时只估新增部分，把 O(回合 × 上下文) 压成 O(上下文)
  const countTokens = createTokenCounter(estimate);

  return {
    budgetTokens,
    // per-run 隔离（ContextPolicy.forRun 契约）：lastCompactAt 滞回与 countTokens 缓存都是
    // per-run 状态 —— 策略实例被配成应用级单例复用时，引擎对每条 run 调 forRun 拿全新实例，
    // 否则「run A 刚压缩过」会卡住「run B 前 compactEvery 回合不压缩」、并发 run 还会互相
    // 把对方的计数缓存打回零重算。
    forRun: () => createBudgetPolicy(opts),
    async beforeTurn(messages, info) {
      if (countTokens(messages) <= budgetTokens) return messages;

      // 1) context editing：先丢旧工具对（按「对数」计，见 keepToolPairs）
      let current = messages;
      if (editBeforeCompact) {
        const trimmed = trimToolPairs(current, { keepToolPairs });
        if (trimmed.length < current.length) {
          current = trimmed;
          if (countTokens(current) <= budgetTokens) return current;
        }
      }

      // 2) compaction：仍超预算且有摘要器
      if (!summarize) return current;
      if (info.iteration - lastCompactAt < compactEvery) return current;
      // ⚠️ 滞回记的是「上次**成功**压缩的回合」（2026-09-28 修）：原实现在 `compactMessages(...)`
      // **之前**就写 `lastCompactAt` —— 摘要器走模型（429 / 超时都常见），压缩失败时额度却已被
      // 烧掉，于是「这一回合没压成」还连带让后面 `compactEvery - 1` 个回合都不再尝试。
      // 失败不记账 ⇒ 下一回合自然重试。代价要说清：**摘要器持续失败时每回合都会再调一次**
      // （每次多一次失败的模型往返）；要抑制请在 `summarize` 里自己退避，别靠滞回额度兜。
      const compacted = await compactMessages(current, { keepRecent, summarize });
      // no-op 不算「成功压缩」（2026-11-07 深评）：compactMessages 在「消息不够 / 尾段
      // 工具不自洽」时会原样返回。把这次也记进滞回，会让 compactEvery:N 白等 N-1 回合，
      // 而上下文继续涨。只有真的换了数组才消耗额度。
      if (compacted !== current) lastCompactAt = info.iteration;
      return compacted;
    },
  };
}
