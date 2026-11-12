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
 * 4. 无 summarize 时 compaction 不可用，编辑已是上限（返回裁剪后消息）；
 *    **summarize 抛错时也回到「编辑后的消息」**（2026-11-13 ref-checklist-four）——
 *    此前异常一路抛到 `turn.ts` 的 catch，那里把 `next` 留在 undefined，于是连已经安全
 *    做完的 context editing 也一起丢了：压缩失败不只是「没省到 token」，还倒退成「一条
 *    都没裁」。现在从 `info.onCompactionFailure` 走同一个出声出口，只丢压缩、不丢编辑。
 *
 * summarize 未提供时 policy 不会自己调模型 —— 框架不替你造 token（spec：不主动黑名单，
 * 预算只是护栏；真机可注入按 /count_tokens 的 estimate 与走模型的 summarize）。
 *
 * ⚠️ **旋钮的 0 读法本轮不改**：`Math.max(1, keepRecent)` / `Math.max(1, compactEvery)`
 * 对 0 的钳位是存量行为（把 0 改成抛错或「不限」都是对外行为变更，属另一次设计）。
 * 本轮只挡**坏值**（NaN / ±Infinity / 负数 / 小数 / 非数）—— 它们的症状是静默且贵的：
 * `budgetTokens: NaN` 让 `countTokens(...) <= NaN` 恒假 ⇒ **每回合都走压缩**，而压缩是
 * 业务注入的模型调用；`compactEvery: NaN` 让滞回判据恒假 ⇒ 每回合都重试压缩。
 * 与 `core/limits.ts` 里 `maxTotalTokens` / `maxLabelValues` 的 NaN 事故同一族。
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

/** 坏值构造期响亮失败；0 仍按存量读法（见文件头「旋钮的 0 读法本轮不改」）。 */
function policyCount(
  name: keyof BudgetPolicyOptions,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `createBudgetPolicy: ${name} 必须是非负安全整数（0 的读法见文件头），收到 ${String(value)}`,
    );
  }
  return value;
}

export function createBudgetPolicy(opts: BudgetPolicyOptions = {}): ContextPolicy {
  const budgetTokens = policyCount('budgetTokens', opts.budgetTokens, 60_000);
  const keepRecent = Math.max(1, policyCount('keepRecent', opts.keepRecent, 20));
  const keepToolPairs = policyCount('keepToolPairs', opts.keepToolPairs, 1);
  const estimate = opts.estimateTokens ?? defaultEstimateTokens;
  const editBeforeCompact = opts.editBeforeCompact ?? true;
  const summarize = opts.summarize;
  const compactEvery = Math.max(1, policyCount('compactEvery', opts.compactEvery, 1));
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
      // 摘要器是业务注入的模型调用，429 / 超时常见。失败时**保留已做完的 context editing**
      // 并从引擎给的那个出口出声（事件 + warn 与「整个 beforeTurn 抛错」逐字一致）。
      // 不在这里 console.warn：那样 trace 里就没有 context.policy_failed 事件了。
      const compacted = await compactMessages(current, { keepRecent, summarize }).catch(
        (e: unknown): typeof current => {
          // 没有引擎给的降级出口（例如单测直接调 beforeTurn、或自定义宿主）时**照旧抛**：
          // 吞掉异常却没有出声的地方，比抛出去更坏。这也是对旧调用的向后兼容。
          if (!info.onCompactionFailure) throw e;
          info.onCompactionFailure(e instanceof Error ? e.message : String(e));
          return current;
        },
      );
      // no-op 不算「成功压缩」（2026-11-07 深评）：compactMessages 在「消息不够 / 尾段
      // 工具不自洽」时会原样返回。把这次也记进滞回，会让 compactEvery:N 白等 N-1 回合，
      // 而上下文继续涨。只有真的换了数组才消耗额度。
      // 压缩失败时返回的也是 `current`（同一引用）⇒ 同样不消耗额度，下回合自然重试。
      if (compacted !== current) lastCompactAt = info.iteration;
      return compacted;
    },
  };
}
