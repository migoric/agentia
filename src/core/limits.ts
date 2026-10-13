/**
 * Agentia —— **limits 语义的单一真源**。
 *
 * 为什么要有这个文件（`docs/guards.md` §2 的第一条待守形状）：
 *
 * 本仓把「非正数 = 机制关掉」当成一条统一口径，但它被**每个旋钮各自解释**了一遍 ——
 * 同一个 `0` 在这里是「不限」、在那里是「一次都不做」、在第三个地方是「配置错误」。
 * 历史事故就出在这条缝上：`handler.drain({ timeoutMs: 1 })` 跨过 deadline 后**永不返回**
 * （调用方按「1 毫秒 = 马上就超时」写，代码里却是另一套读法），而当时没有任何一处
 * 集中写着「这个旋钮的 0 是什么意思」。改到相关代码时只能靠人去猜 —— 于是又猜错。
 *
 * 本文件把「每个旋钮的 0 是什么」变成**可执行的数据**，`tests/limits.test.ts` 再拿这份
 * 表去**驱动真实站点**逐条对账：表里声明 `0 = 不限`，用例就去调那个真 API 并断言它真的
 * 不限。所以：
 *
 * - 表与实现漂了 ⇒ 集中用例红（不是文档过期，是构建失败）；
 * - 表加了旋钮而探针没加 ⇒ 用例里 `Record<LimitKnob, …>` 少一项，`typecheck:tests` 红。
 *
 * ⚠️ 守卫方向的如实口径：`LimitKnob` 类型**来自这张表本身**，所以
 * `Record<LimitKnob, …>` 只守得住「表 ↔ 探针」这一个方向的对账（表加了没探针、
 * 探针加了表里摘了，都会被拦住）；它**抓不到**「代码里新增了旋钮却根本没进表」——
 * 那一步只能靠改代码的人主动登记（这张表就是登记处），别把它当成全自动的网。
 * 表与探针的互查另有一条运行期用例兜底（`tests/limits.test.ts` 末尾）——
 * tsx 不跑类型检查，光有 `Record` 的编译期守卫在单跑测试时看不见。
 *
 * ⚠️ 本模块**不是公共 API**（不进 `src/index.ts`）：它是内部口径的真源，不是给使用者的旋钮。
 * 面向使用者的口径在 `docs/usage-guide.md` 的「边界」一节。
 *
 * ⚠️ 表里的 `zeroClause` 是**报错文案的一部分**：有构造期校验的旋钮由实现代码直接把它插进
 * 错误消息里（`…（0 = 不重试），收到 -1 —— …`）。所以「文案里怎么解释 0」与「代码里怎么实现 0」
 * 是同一个值，改一处等于同时改另一处 —— 这正是先前缺的那条单源。
 *
 * ⚠️ **别在这里写死「几处」，也别在这里列举是哪些**：计数会随旋钮增减立刻过期 —— 本行曾写
 * 「五处」并列举五个，而漏掉的正是**同一次改动里新增**的 `retainTerminal`；2026-09-26 又发现
 * `Scheduler.every` 的两条**表里有 `zeroClause`、代码里却手写文案**（`intervalMs` 是漂了很久的
 * 一条，`maxInFlight` 是当天新加的）。要核对当前全集：`grep -rn 'zeroClauseOf' src/`。
 * 清单本身有价值，计数没有 —— 而且**列举出来的清单会和计数一样过期**。
 */

/**
 * 一个旋钮在取 `0`（或「非正数」）时的**含义分类**。四选一，没有第五种：
 *
 * - `unlimited` —— **0 = 不限**。时间是「等多久 / 最多多久」的上限，0 表示去掉这个上限。
 *   使用者的直觉通常是这个；本仓只有一部分旋钮真的是这个意思，这正是要对账的原因。
 * - `disabled` —— **0 = 机制关掉 / 一次都不做**。数量是「做几次」，0 次就是不做。
 *   ⚠️ 与 `unlimited` 是**相反的**读法：`maxRetries: 0` 是「不重试」而不是「无限重试」；
 *   `maxEvents: 0` 是「一条都不记」而不是「不限条数」。
 * - `immediate` —— **0 = 立即执行，不等**。等待预算为 0 ⇒ 这次等待压根不存在。
 *   与 `disabled` 的区别：机制没被关掉，只是这一次立刻发生（`metricsSink` 的
 *   `intervalMs: 0` = 立即导出；`interruptibleSleep(0)` = 不睡）。
 * - `invalid` —— **0 = 非法配置，构造期响亮失败**。0 在这里没有任何合理读法
 *   （`concurrency: 0` 没有 worker；`Scheduler.every(0)` 是空转），静默接受只会
 *   把它变成另一件事（Node 会把 `setInterval(0)` 钳到 1ms ⇒ 每毫秒一轮的忙轮询）。
 */
export type ZeroMeaning = 'unlimited' | 'disabled' | 'immediate' | 'invalid';

/** 坏值（非有限 / 负数 / 小数 / 类型不对）的处理方式 */
export type BadValuePolicy =
  /** 构造期抛错 —— 使用者以为自己设了上限，静默接受就会变成别的行为 */
  | 'throws'
  /** 一律视为「不限」（旧行为），不报错 */
  | 'coerced-to-unlimited'
  /** 无校验（该旋钮只做算术，坏值无处可藏） */
  | 'none'
  /**
   * 只拒 `NaN`（2026-09-29 盘点 C5b）：`NaN` 是唯一让「实际值 > 上限」恒假、**闸静默失效**的
   * 坏值（方向与「设了个上限」相反）；`0` / 负数 / `±Infinity` 都还有可辩护的读法（全停 / 不限），
   * 照旧放行。需要独立一类，是因为现有三类都表达不了它 —— `throws` 会把负数的合法读法一起拒掉，
   * `coerced-to-unlimited` / `none` 又不会拒 `NaN`。
   */
  | 'rejects-nan';

export interface LimitSemantic {
  /** 稳定标识（用例按它建表；改名 = 用例红，故意的） */
  readonly knob: string;
  /** 实现位置（文件名:符号），改代码时的入口 */
  readonly where: string;
  readonly unit: 'ms' | 'count' | 'chars' | 'bytes' | 'n/a';
  readonly zero: ZeroMeaning;
  /**
   * 报错文案里那句「0 = 什么」（无报错的旋钮也写上 —— 文档与用例都读它）。
   * 有构造期校验的旋钮由实现代码直接插进错误消息。
   */
  readonly zeroClause: string;
  readonly badValue: BadValuePolicy;
  /** 为什么是这个读法（一句话；踩过坑的把坑写上） */
  readonly note: string;
}

/**
 * 全部 limits 旋钮的 0 语义。**分组按读法**，好让人一眼看出哪几个是相反的。
 */
export const LIMIT_SEMANTICS = [
  // ── 0 = 不限（时间的上限被去掉）──────────────────────────────────────────
  {
    knob: 'AsyncRunner.runTimeoutMs',
    where: 'transport/async.ts',
    unit: 'ms',
    zero: 'unlimited',
    zeroClause: '0 = 不限',
    badValue: 'throws',
    note: 'NaN/Infinity 会被 setTimeout 钳到 1ms ⇒ 每个任务立即「超时」失败，且 NaN 会绕过 `< 0` 静默通过；所以要「不限」必须显式传 0。⚠️ 2026-09-28 补上界：**超过 2^31-1ms（约 24.86 天）同样会被钳到 1ms**，构造期一并拒掉 —— 此前只查「非负有限」，于是「配 30 天超时 = 每个任务立即超时」这种配置合法、行为相反的坑能静默上线（上限单源在 core/timeout.ts）。',
  },
  {
    knob: 'AsyncRunner.approvalTimeoutMs',
    where: 'transport/async.ts',
    unit: 'ms',
    zero: 'unlimited',
    zeroClause: '0 = 不限',
    badValue: 'throws',
    note: '同 runTimeoutMs：非有限数会让「已挂起多久」的比较静默失效或立即超时。',
  },
  {
    knob: 'AsyncRunner.maxQueued',
    where: 'transport/async.ts',
    unit: 'count',
    zero: 'unlimited',
    zeroClause: '0 = 不限（不设排队上限）',
    badValue: 'throws',
    note: '2026-09-28 外部深评 T5 补登的**新旋钮**，也刻意是「数量 + 0 = 不限」的**第二个**样本（第一个是 `mapWithConcurrency.limit`）。⚠️ 它必须登记的理由不是形式：`maxQueued: 0` 的直觉读法是「一条都不许排」（= `disabled`），而**那样读的后果正是本旋钮要防的反面** —— 并发一满，每个提交都 503。所以 0 = 不限是**刻意选的**（缺省行为与加本旋钮之前逐字一致），探针必须把这两种读法分开：`concurrency: 1` + `maxQueued: 0` 下灌 3 条，断言**都受理**且都跑完（若读成 disabled，第 2 条就抛）。',
  },
  {
    knob: 'AsyncRunner.drain.timeoutMs',
    where: 'transport/drain-gate.ts',
    unit: 'ms',
    zero: 'unlimited',
    zeroClause: '非正 = 一直等',
    badValue: 'none',
    note: '**历史事故现场**：`http.ts` 的优雅停机把剩余预算算成 `timeoutMs - elapsed` 再交给它，deadline 已过时算出 1 或 0 ⇒ 旧读法（`0` = 已到点）让它跨过 deadline 后**永不返回**。现在 `http.ts` 自己先判「已到点就认账」，不把 0 交给下游去猜。⚠️ 2026-09-28：`NaN` 与超过 2^31-1ms 的预算在闸口拒掉（超上限会被钳到 1ms ⇒「等 30 天排空」变成「1ms 后返回 false」，而 `false` 的语义是「宿主必须退出」，静默拿到它代价很高）。',
  },
  {
    knob: 'mapWithConcurrency.limit',
    where: 'engine/concurrency.ts',
    unit: 'count',
    zero: 'unlimited',
    zeroClause: '非正 = 不限',
    badValue: 'coerced-to-unlimited',
    note: '⚠️ 与 `maxToolConcurrency` 成对：这是**唯一**「数量」旋钮取 0 却读作「不限」的。另有一条反向的坑：`(0,1)` 区间的小数若交给 `Math.floor` 会压成 0 worker ⇒ 工具被静默丢弃，所以正数一律至少 1 个 worker（`maxToolConcurrency: cpus().length / 8` 在多核 < 8 的机器上正落在那个区间）。',
  },

  // ── 0 = 机制关掉 / 一次都不做（数量旋钮；与上面相反）─────────────────────
  {
    knob: 'traceLimits.maxEvents',
    where: 'engine/tracer.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 一条都不记',
    badValue: 'throws',
    note: '⚠️ 与 `maxEventChars`（管「多长」）正交，一个管「多少」。0 是**有意义的值**（一条都不记，但计数照记）—— 不是「不限条数」。',
  },
  {
    knob: 'maxRetries',
    where: 'integrations/adapter-options.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 不重试',
    badValue: 'throws',
    note: '坏值必须响亮失败：判定是 `attempt >= maxRetries` ⇒ `NaN` 比较恒假、`Infinity` 永远达不到，两者都是**无限重试**（429 场景下每一次都是真金白银）；`-1` 静默变成「不重试」；`1.5` 实际只允许 1 次。',
  },
  {
    knob: 'RetryOptions.maxAttempts',
    where: 'engine/retry.ts（resolveRetry）',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 关闭重试',
    badValue: 'throws',
    note: '含首次尝试（1 = 只试一次不重试）。⚠️ 2026-10-13 深评 A1 补登 + 补校验：`maxAttempts: NaN` 曾让 `!(NaN >= 1)` 成立 ⇒ 重试被**静默关闭**，run 根快照记 `config.retry.maxAttempts: 0`，看着像用户主动关的；与 client 层 maxRetries 同纪律改为 `resolveRetry` 抛 TypeError（runAgent 入口另有一次同款校验，配置错不收成「失败的 run」）。',
  },
  {
    knob: 'RetryOptions.jitter',
    where: 'engine/retry.ts（resolveRetry）',
    unit: 'n/a',
    zero: 'disabled',
    zeroClause: '0 = 不加抖动',
    badValue: 'throws',
    note: '抖动比例 0~1。>1 会把退避拉成负数再被 `Math.max(0, …)` 静默钳回 0（抖动与退避一起失效，429 场景变热重试）；NaN 让退避算成 NaN。2026-10-13 深评 A1 补登。',
  },
  {
    knob: 'maxEventChars',
    where: 'engine/tool-events.ts',
    unit: 'chars',
    zero: 'disabled',
    zeroClause: '0 = 截到零长度；false = 不截断',
    badValue: 'none',
    note: '两个「关掉」的写法语义不同：`false` 才是「不截断」（调试期看全文），`0` 是把正文截成空串。⚠️ 靠 `!= null` 判定透传（真值判定会吃掉 `false`）。',
  },
  {
    knob: 'runAgent.maxIterations',
    where: 'engine/loop.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 一次都不跑',
    badValue: 'none',
    note: '循环写成 `for (iteration = 0; iteration < maxIterations; ...)` ⇒ 0 时循环体一次不执行，直接以「达到循环上限」收尾（**算失败**）。是「已到点」而非「不限」，与 `mapToolConcurrency` 的读法**相反**。',
  },
  {
    knob: 'withTimeout.ms',
    where: 'core/timeout.ts',
    unit: 'ms',
    zero: 'disabled',
    zeroClause: '非正 = 不设超时（原样透传）',
    badValue: 'throws',
    note: '`toolTimeoutMs` 的底座。⚠️ 漏透传这个值不是「少一层保险」而是**反的**：`withTimeout(p, 0)` 直接返回原 promise = 永不超时，同时 MCP 桥找不到引擎预算又起自己的 60s 兜底 ⇒ 双计时器、双账本（`toolkit/subagent.ts` / `skill.ts` 的透传注释指的就是这条）。⚠️ 2026-09-28 起 `NaN` 与超过 2^31-1ms 的值在入口拒掉（`assertTimerDelay`）：`NaN` 会**静默**落进上面那句「非正 = 不设超时」（判据是 `!(x > 0)`，NaN 满足），与「我设了个预算」的预期正好相反；超上限则被钳到 1ms ⇒ 每个工具调用立即超时。`0` / 负数仍是合法的「不设超时」。',
  },

  {
    knob: 'TaskEventStreams.retainTerminal',
    where: 'transport/task-events.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 不留终态流（终态即忘）',
    badValue: 'throws',
    note: '判定是 `excess <= 0 提前返回` ⇒ NaN 恒假、**全部**无订阅者的终态流被清空（保留机制静默失效，方向与 maxEvents 的「闸失效」相反、同族）。⚠️ 只跳过「还有订阅者」的终态流 —— 那是还没被读完的流，丢了下游会莫名断在半路。',
  },

  {
    knob: 'TaskEventStreams.nonTerminalBuffers',
    where: 'transport/task-events.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 不为没人读的非终态流保留回放缓冲（有订阅者的照旧留着）',
    badValue: 'throws',
    note: '判定是 `buffered <= quota 提前返回` ⇒ NaN 恒假 ⇒ **每条**非终态流的回放缓冲都被立刻回收（回放历史静默全没，与 retainTerminal 那条「保留机制失效」同族、方向相反）。⚠️ 回收的是**缓冲**不是**表项**：`has()` 仍为真、序号接着走，缺口由 `firstAvailable` 明示（读者先收一帧 `stream.truncated`）—— 连表项一起删会让恢复段的序号从 1 重来，拿 `Last-Event-ID` 续订的读者从此静默收不到东西。⚠️ 只跳过「还有订阅者」的流（正在被读的不抽走）⇒ 被实时读的流不受配额约束。',
  },

  // ── 0 = 立即执行（等待预算为 0 ⇒ 这次等待不存在）─────────────────────────
  {
    knob: 'interruptibleSleep.ms',
    where: 'core/timeout.ts',
    unit: 'ms',
    zero: 'immediate',
    zeroClause: '非正 = 不睡',
    badValue: 'throws',
    note: '⚠️ 这一判**先于** aborted 检查 —— 别把它「修」成「已中止就该 reject」。2026-09-19 外部复核把它当一致性缺口改反过一次，被 `tests/core/timeout.test.ts` + `tests/core/sse-text-stats.test.ts` 拦住。⚠️ 2026-09-28 起 `NaN` 与超 2^31-1ms 在入口拒掉（`assertTimerDelay`，判在「非正」**之前** —— `NaN <= 0` 是 false，不先挡就会穿透直落 `setTimeout(NaN)`，被钳成 1ms ⇒「退避」变成「立刻重试」）。上游给的荒谬 `Retry-After` 不走这条：它在 `backoffMs` 里被**夹**到上限（外部数据不该把一次 429 升级成硬失败）。',
  },
  {
    knob: 'metricsSink.intervalMs',
    where: 'integrations/metrics.ts',
    unit: 'ms',
    zero: 'immediate',
    zeroClause: '0 = 立即导出',
    badValue: 'none',
    note: '⚠️ **同名反义**：`Scheduler.every` 的 `intervalMs: 0` 是**配置错误**（抛错），这里却是「关掉定时器、每次累加后立即导出」。两个同名旋钮两种读法 —— 改任何一个之前先看这张表。',
  },
  {
    knob: 'RetryOptions.baseDelayMs',
    where: 'engine/retry.ts（resolveRetry）',
    unit: 'ms',
    zero: 'immediate',
    zeroClause: '0 = 不退避（立即重试）',
    badValue: 'throws',
    note: '⚠️ 2026-10-13 深评 A1 补登 + 补校验：`baseDelayMs: NaN` 让 backoffDelay 算出 NaN ⇒ `interruptibleSleep` 的 `assertTimerDelay` 抛 RangeError —— 它曾被 turn.ts 退避处的裸 `catch` 吞成「用户取消」（配置错被谎报成取消，实测 `retry:{baseDelayMs:NaN}` + 429 → stopReason:aborted）。超 2^31-1ms 同理拒（Node 钳到 1ms ⇒ 热重试；上限单源 core/timeout.ts）。',
  },
  {
    knob: 'RetryOptions.maxDelayMs',
    where: 'engine/retry.ts（resolveRetry）',
    unit: 'ms',
    zero: 'immediate',
    zeroClause: '0 = 退避封顶为零（立即重试）',
    badValue: 'throws',
    note: '同 baseDelayMs：NaN 穿透 `Math.min` 让封顶失效（`Math.min(x, NaN)` = NaN）；超上限被 Node 钳到 1ms。2026-10-13 深评 A1 补登。⚠️ 正向抖动可能把最终退避推过 maxDelayMs（±jitter 是有意的），但 `backoffDelay` 会把它夹在 2^31-1ms 以内，sleep 不会因此抛。',
  },

  {
    knob: 'BudgetGuardOptions.maxTotalTokens',
    where: 'engine/budget.ts（createBudgetGuard；由 RunAgentOptions.maxTotalTokens 传进来）',
    unit: 'count',
    zero: 'immediate',
    zeroClause: '0 = 第一次记账就超预算（等价于「任何用量都不许」）',
    badValue: 'rejects-nan',
    note: '闸门判据是 `totalTokens > maxTotalTokens`（**严格大于**）：0 时任何非零用量立刻撞线；负数同理（`> -1` 恒真）。对 `0` / 负数**刻意不抛错** —— 预算是运行期累计量，配成 0 是「这次 run 一条都别花」的合法意图（与 `maxIterations: 0` 同档），不是坏配置。⚠️ **但 `NaN` 必须构造期拒**（2026-09-29 盘点 C5b）：`totalTokens > NaN` **恒 false** ⇒ 闸永不触发、**静默失效**，方向与「设了个上限」正好相反；`createBudgetGuard` 对 `NaN` 抛 `RangeError`（`0` / 负数 / `±Infinity` 照旧）。⚠️ 与 `maxCostUsd` 是两个独立闸，**tokens 先判、撞了就返回**（不再看 cost）。⚠️ 2026-09-28 补登：这两个旋钮自 v0.5.0 起就存在，却一直没进这张表（「改 0 的读法不改表就构建红」这条纪律对它们曾是空的）。',
  },
  {
    knob: 'BudgetGuardOptions.maxCostUsd',
    where: 'engine/budget.ts（createBudgetGuard；由 RunAgentOptions.maxCostUsd 传进来）',
    unit: 'n/a',
    zero: 'immediate',
    zeroClause: '0 = 第一笔成本就超预算（等价于「一分钱都不许花」）',
    badValue: 'rejects-nan',
    note: '判据 `costUsd > maxCostUsd`，而 `costUsd` 取 `usage.costEstimate ?? 0` ⇒ **模型不在价格表内时它恒为 0**，这个闸对未定价模型**永不触发**（静默失效；要无条件兜底请用 `maxTotalTokens`）。这一句在 `BudgetGuardOptions` 的注释里已如实写着，这里登记是为了让「0 的读法」也有单一真源。⚠️ 同 `maxTotalTokens`：`NaN`（2026-09-29 盘点 C5b）会让 `costUsd > NaN` 恒 false ⇒ 闸静默失效，`createBudgetGuard` 对 `NaN` 构造期抛 `RangeError`。',
  },
  {
    knob: 'metricsSink.maxCapabilities',
    where: 'integrations/metrics.ts（metricsSink）',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '0 = 一个能力都认不下（配置错误）',
    badValue: 'throws',
    note: '与 `maxModels` / `maxScores` / `maxLabelValues` / `maxLabelCombos` 同族：都是**基数封顶**，0 会让所有条目折进同一个桶 ⇒ 看板看起来「只剩一个能力」，而没有任何报错。2026-09-28 补登（这三个此前不在表里 —— 与 `BudgetGuardOptions` 那两个同一种漏登记）。',
  },
  {
    knob: 'metricsSink.maxModels',
    where: 'integrations/metrics.ts（metricsSink）',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '0 = 一个模型都认不下（配置错误）',
    badValue: 'throws',
    note: '同 `maxCapabilities`（该组同款判据、同款文案）。',
  },
  {
    knob: 'metricsSink.maxScores',
    where: 'integrations/metrics.ts（metricsSink）',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '0 = 一个分数都认不下（配置错误）',
    badValue: 'throws',
    note: '同 `maxCapabilities`。',
  },

  // ── 0 = 非法配置（响亮失败）─────────────────────────────────────────────
  {
    knob: 'AsyncRunner.concurrency',
    where: 'transport/async.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '0 = 没有 worker',
    badValue: 'throws',
    note: '0 个 worker 的池子会让每个任务永远排在队列里（既不跑也不失败）。',
  },
  {
    knob: 'Scheduler.every.maxInFlight',
    where: 'transport/scheduler.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: 'Infinity = 关闸门；0 = 没有在飞名额，周期任务永不派发',
    badValue: 'throws',
    note: '与 `AsyncRunner.concurrency` **同族**（「在飞名额」数量旋钮）：闸门判据是 `inFlight.size >= maxInFlight`，0 时恒真 ⇒ 每次 tick 都跳过，周期任务**既不跑也不失败**（探针实测 60ms 内派发 0 次、无任何报错/日志；负数同理）。⚠️ 旧实现 `opts.maxInFlight ?? 1` 把 0 静默留下，而写成 `||` 又会把它静默抬成 1 —— **两个方向都在替使用者改配置**（与 `streamBufferEvents` 记的旧 `Math.max(1, …)` 是同一个反模式）。',
  },
  {
    knob: 'HttpHandlerOptions.maxBodyBytes',
    where: 'transport/http.ts（createHttpHandler）',
    unit: 'bytes',
    zero: 'invalid',
    zeroClause: '0 = 每个带 body 的请求都 413',
    badValue: 'throws',
    note: "与**同一个选项接口里**的 `maxConcurrentRuns` 同款 —— 那条写着「0 / 负数则全部 503 —— 都是配置错误，宁可在构造期响亮失败」，这条是同一形状：`readBody` 的判据是 `size > maxBytes`，0 时**任何字节**都超限 ⇒ `POST /run` / `POST /tasks` / 审批全部 413（实测 3 条 POST 全 413），服务器看着在跑却收不了任何输入。⚠️ 还挡一类事故：`Number('') === 0` —— 从**空的环境变量**读出来的配置会静默变成「拒绝一切」。要「不限」用 `Infinity`（`size > Infinity` 恒假），**别用 0**。",
  },
  {
    knob: 'HttpHandlerOptions.maxConcurrentRuns',
    where: 'transport/http.ts（createHttpHandler）',
    unit: 'count',
    zero: 'invalid',
    zeroClause: 'Infinity = 无上限（0 = 全部 503）',
    badValue: 'throws',
    note: '闸门判据是 `inFlightRuns >= maxConcurrentRuns`：0 / 负数时恒真 ⇒ 每个 `POST /run` 都 503（服务器看着在跑却一个 run 都不收）；NaN 让它恒假 ⇒ 闸门静默失效。它是**存量旋钮**（校验早就有），2026-09-27 复核时发现始终没登记进这张表（文案也没走 `zeroClauseOf`），补登。',
  },
  {
    knob: 'SseWriterOptions.maxBufferedBytes',
    where:
      'transport/sse.ts（sseWriter）+ transport/http.ts（createHttpHandler 的 sseMaxBufferedBytes 透传）',
    unit: 'bytes',
    zero: 'invalid',
    zeroClause: '0 = 流活不过一帧',
    badValue: 'throws',
    note: '判据是**写入前**的 `pending > limitBytes` ⇒ 0 时第 1 帧照写（pending 还是 0），**第 2 帧必收口**（实测：`closed=true` / `ended=true` / `onBackpressure` 回调 1 次）—— 流活不过一帧，没有任何正当用法：这个旋钮的定位是「只拦连上但不读的病态消费者」，而 0 会让**每个**消费者都被判成病态。要「关掉」用 `Infinity`。',
  },
  {
    knob: 'AsyncRunner.streamBufferEvents',
    where: 'transport/task-events.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '必须为正安全整数（0 没有「缓冲几条」的读法）',
    badValue: 'throws',
    note: '0 既不是「关掉流」（live 推送仍在工作）也不是「不限」，三种合法读法都不沾 ⇒ 配置错误；旧实现 `Math.max(1, …)` 把 0 静默抬成 1（替使用者改配置），且 NaN 穿过后 `length > NaN` 恒假 ⇒ 每任务内存闸静默失效（使用者以为设了上限）。',
  },
  {
    knob: 'Scheduler.every.intervalMs',
    where: 'transport/scheduler.ts',
    unit: 'ms',
    zero: 'invalid',
    zeroClause: '必须为正有限数（0 会空转）',
    badValue: 'throws',
    note: '`setInterval(0)` 退化成「尽快重复」的空转循环（Node 钳到 1ms，仍是每毫秒一轮忙轮询）；超过 2^31-1ms 的延迟**不会被遵守**（Node 只在 stderr 留一行 `TimeoutOverflowWarning`，随后钳到 1ms），同款失败。上限单源 2026-09-28 上提到 core/timeout.ts，与其余五处直喂 `setTimeout` 的站点共用。',
  },
  {
    knob: 'createAnthropicClient.timeout',
    where: 'integrations/anthropic.ts',
    unit: 'ms',
    zero: 'invalid',
    zeroClause: '不设 = 不限；0 = 非法',
    badValue: 'throws',
    note: '「不限」的表达方式是**不传**，不是传 0 —— 与 `runTimeoutMs` 的读法**相反**（那个要求显式传 0）。⚠️ 2026-09-28 补上界：超过 2^31-1ms 的值同样被钳到 1ms ⇒「30 天超时」变成「每个请求立即超时」，构造期一并拒掉。',
  },
  {
    knob: 'metricsSink.windowSize',
    where: 'integrations/metrics.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '0 = 窗口里什么都没有',
    badValue: 'throws',
    note: '同款的还有 `maxCapabilities` / `maxModels` / `maxScores` —— 都是「必须为正数」。',
  },
  {
    knob: 'metricsSink.maxLabelValues',
    where: 'integrations/metrics.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '0 = 一个标签值都认不下',
    badValue: 'throws',
    note: '归因标签（R8-P4）的基数上限，与 `maxCapabilities` / `maxModels` / `maxScores` 同族。0 时**每个**值都折叠进 `__other__` —— 「opt-in 了标签维度却一个值都区分不开」没有正当读法，是配置错误；且这道上限刻意不可关（opt-in 挡不住「明知几千租户偏要上」，内存不变量要求每个新基数维度都有 cap）。',
  },
  {
    knob: 'metricsSink.maxLabelCombos',
    where: 'integrations/metrics.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '0 = 一个标签组合都认不下，全折进一个桶',
    badValue: 'throws',
    note: '**组合数**上限（2026-09-27 ⑧ 补的第四条基数上限）。`maxLabelValues` 只封每个键的**值域**，而进内存的是组合，数量是叉乘 `(maxLabelValues+1)^labelKeys.length` —— 缺省 100 × 3 键就是一百万条，且每键的 dropped 计数看不见它。与另外三道同款：超限折进一个全 `__other__` 的桶（量不丢），折叠数见 `droppedLabelCombos` / `dropped_keys{kind="label:combos"}`。',
  },
] as const satisfies readonly LimitSemantic[];

/** 表里全部旋钮的标识（用例按它建穷尽表：少一项 `typecheck:tests` 就红） */
export type LimitKnob = (typeof LIMIT_SEMANTICS)[number]['knob'];

/** 按旋钮取那行（拼错旋钮名 = 编译期报错，不是运行期 undefined） */
export function limitSemanticOf(knob: LimitKnob): LimitSemantic {
  const found = LIMIT_SEMANTICS.find((s) => s.knob === knob);
  // 表是 `as const` 的封闭集合，knob 类型来自它 ⇒ 这里不可能落到 undefined；
  // 保留分支是为了让「表被改空」时给出可读的失败而不是 TypeError。
  if (!found) throw new Error(`limits 表里没有旋钮 ${knob}（表被改空了？）`);
  return found;
}

/**
 * 报错文案里那句「（0 = …）」。**构造期校验直接插它**，所以文案与表不可能各说各话。
 */
export function zeroClauseOf(knob: LimitKnob): string {
  return limitSemanticOf(knob).zeroClause;
}
