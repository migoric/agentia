import type { TraceRecordEvent } from '../core/trace.js';
import { zeroClauseOf } from '../core/limits.js';

/**
 * 任务记账事件流 —— **每任务的事件缓冲 + 订阅表**（`AsyncRunner` 拆分的又一块纯件）。
 *
 * 为什么单独一件：`GET /tasks/:id/stream` 要「连上就能重放 + 之后转实时 + 终态收口」，
 * 这三件事全是**纯记账**，与 store / 引擎 / 槽位无关；留在 855 行的 `AsyncRunner` 里
 * 只会让它再长一截，而这块恰好是最容易用单测钉住的（内存边界、丢最旧、序号连续性）。
 *
 * ## 三条设计约束（都有理由，别按直觉改）
 *
 * 1. **序号是流自己的，不是 recorder 的 `seq`。** 一个异步任务可能跨**多个 run 段**
 *    （HITL 挂起→恢复、崩溃恢复重投）：每段是**独立的一次 run**（新 recorder，`seq` 从 1 重来），
 *    而流的读者要的是一条**连续的**流。所以本类给每条流维护自己的单调序号（从 1 起），
 *    SSE 的 `Last-Event-ID` 与 `?from=` 都指它。事件体里那个 `seq` 原样保留（属于那一段 run）。
 * 2. **有界 + 丢最旧 + 明示。** 内存不能被「跑了就不管的任务」拖垮：每条流最多存
 *    `maxEvents` 条，超了丢**最旧**的，并把「小于 `droppedBefore` 的序号已不在缓冲里」
 *    告诉订阅者（`replay()` 的返回值 / `stream.truncated` 帧）—— **不静默**。
 * 3. **终态缓冲区只保留最近 `retainTerminal` 条。** 留下的意义是「刚跑完就连上来也能重放」；
 *    更早的任务连接上来只能拿到终态（不假装还能重放）。留多了等于把内存换成没人看的历史。
 * 4. **非终态流的缓冲也回收（配额 `nonTerminalBuffers`）。** 终态那条闸只管**跑完的**任务，
 *    而「挂着不动的任务」才是真常态：等审批的、等事件的、等定时器的每条都占一份 ≤`maxEvents` 条
 *    的缓冲（约 1 MB），**且永远不会走到终态** ⇒ 表项只增不减（2026-09-28 外部深评 T4）。
 *    回收的是**缓冲**，不是**表项**：表项留着当**桩**（`has()` 仍为真、`nextIndex` 接着走），
 *    只把回放历史丢掉并用 `firstAvailable` 明示缺口 —— 详见 `#recycleNonTerminal()` 的三条纪律。
 *    ⚠️ 反过来做（连表项一起删）会**静默破坏约束 1**：恢复段的 `open()` 会给一个不存在的任务
 *    新建 `nextIndex = 1` 的流，于是拿 `Last-Event-ID` 续订的读者的 `replay(from=N)` 永远筛不出
 *    东西（`index > N` 恒假）—— 读者从此只等到收口帧，中间一片空白。
 *
 * ⚠️ 内存量级（文档里要给使用者一个数）：单条事件正文受 `maxEventChars` 约束（入参/成功出参
 * 缺省 2000 字符），所以 500 条 × 2 KB ≈ 1 MB/任务。**缓冲**总量 ≈
 * （`nonTerminalBuffers` 32 + `retainTerminal` 16）× 1 MB ≈ 48 MB 上限（有订阅者的流不受配额约束，
 * 见约束 4）；此外每条非终态任务留一个**桩**（约百字节），桩本身不设上限，理由同约束 4。
 */
export interface TaskEventStreamsOptions {
  /**
   * 每条流最多保留多少条事件（超出丢最旧）；缺省 500。
   * 必须是**正**安全整数：坏值（NaN/Infinity/负数/小数/0）构造期抛 TypeError ——
   * `NaN` 会让 `length > maxEvents` 恒假（内存闸静默失效，使用者以为设了上限），
   * `0` 没有「缓冲几条」的读法（既不是「关掉流」—— live 推送仍在，也不是「不限」），
   * 静默抬成 1 是替使用者改配置。0 语义归类见 `core/limits.ts` 的
   * `AsyncRunner.streamBufferEvents` 行。
   */
  maxEvents?: number;
  /** 终态流的保留条数（LRU，超出即丢最旧的终态流）；缺省 16 */
  retainTerminal?: number;
  /**
   * **非终态**流的**缓冲**配额（条数，不是事件数）：本进程最多为多少条非终态流保留
   * 「可回放的事件缓冲」；缺省 32。超出即从**最旧**的、**无订阅者**的非终态流开始回收缓冲
   * （表项与序号都留着，见类注释约束 4）。`0` 读作 disabled ＝ **没人读的**非终态流一律不留
   * 回放缓冲（只有实时转发；有订阅者的流照旧留着 —— 见 `#recycleNonTerminal` 的纪律）。
   *
   * 为什么是**条数**而不是字节数：真正的量纲是「任务数 × 每任务 ≤`maxEvents` 条」，
   * 每任务那半已经被 `maxEvents` 钉住了，剩下的变量就是**多少条流**在占缓冲 —— 按字节设限
   * 还要去估正文长度（`maxEventChars` 只是缺省、用户可改），反而不准。
   * 0 语义归类见 `core/limits.ts` 的 `TaskEventStreams.nonTerminalBuffers` 行。
   */
  nonTerminalBuffers?: number;
}

/** 一条事件在**流**里的位置（`index` 是流自己的序号，不是 recorder 的 seq） */
export interface TaskStreamEvent {
  index: number;
  event: TraceRecordEvent;
}

export interface TaskReplay {
  /** 待补发的事件（`from` 之后，或全部可用的） */
  events: TaskStreamEvent[];
  /** 小于它的序号已不在缓冲里（缺席 = 没有任何丢弃）；订阅者应据此发 `stream.truncated` */
  droppedBefore?: number;
  /** 该任务是否已到终态（调用方据此发 `task.end` 并关闭） */
  done: boolean;
}

/** 缺省上限 —— 与文档里写的数字必须一致（`usage-guide` §7） */
export const TASK_STREAM_DEFAULT_MAX_EVENTS = 500;
export const TASK_STREAM_DEFAULT_RETAIN_TERMINAL = 16;
export const TASK_STREAM_DEFAULT_NON_TERMINAL_BUFFERS = 32;

interface StreamState {
  /** 已缓冲的事件（有界，丢最旧；也可能被配额**整体回收** —— 见 `#recycleNonTerminal()`） */
  events: TaskStreamEvent[];
  /** 下一条事件的**流**序号 */
  nextIndex: number;
  /** 小于它的序号已不在缓冲里（0 = 从未丢弃） */
  firstAvailable: number;
  done: boolean;
  subscribers: Set<(e: TaskStreamEvent) => void>;
  /** 终态通知（markDone 时调一次）—— 实时订阅者靠它收口（否则流永远不结束） */
  doneListeners: Set<() => void>;
}

export class TaskEventStreams {
  private readonly streams = new Map<string, StreamState>();
  private readonly maxEvents: number;
  private readonly retainTerminal: number;
  private readonly nonTerminalBuffers: number;
  /**
   * 「非终态**且**缓冲非空」的流数 —— 配额判据的**增量**计数。
   *
   * 为什么不每次现数：判定点在 `push` 上（每条事件都可能让一条流从空变非空），
   * 每次全表扫一遍会把这道内存闸本身变成 O(流数 × 事件数) 的开销。
   * 增量的代价是必须有**唯二**的增减点（`#recycleNonTerminal` 减、`push`/`open` 增），
   * 所以三处各有一句注释钉着 —— 谁新开一条改缓冲的路径，得同时改这里。
   */
  private buffered = 0;

  constructor(opts: TaskEventStreamsOptions = {}) {
    // 坏值响亮失败（口径与 resolveTraceLimits / resolveMaxRetries 同款）：
    // 判定是 `length > maxEvents` ⇒ NaN 恒假（上限根本不生效）、Infinity 永不触发、
    // 负数/小数与「缓冲几条」对不上；0 的读法见 limits 表（invalid —— 构造期抛）。
    const maxEvents = opts.maxEvents ?? TASK_STREAM_DEFAULT_MAX_EVENTS;
    if (typeof maxEvents !== 'number' || !Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
      throw new TypeError(
        `streamBufferEvents 必须是正安全整数（${zeroClauseOf('AsyncRunner.streamBufferEvents')}），收到 ${String(opts.maxEvents)} —— ` +
          'NaN 会让「超出条数上限」的判定恒假（每任务内存闸静默失效），0 / 负数 / 小数没有「缓冲几条」的读法',
      );
    }
    this.maxEvents = maxEvents;
    // retainTerminal 同款校验：判定是 `excess <= 0 提前返回` ⇒ NaN 恒假、终态流被**全部清空**
    // （保留机制静默失效，方向与 maxEvents 相反、同族）。0 有读法：不留终态流（disabled）。
    const retainTerminal = opts.retainTerminal ?? TASK_STREAM_DEFAULT_RETAIN_TERMINAL;
    if (
      typeof retainTerminal !== 'number' ||
      !Number.isSafeInteger(retainTerminal) ||
      retainTerminal < 0
    ) {
      throw new TypeError(
        `retainTerminal 必须是非负安全整数（${zeroClauseOf('TaskEventStreams.retainTerminal')}），收到 ${String(opts.retainTerminal)} —— ` +
          'NaN 会让「超出保留条数」的判定恒假（终态流被静默清空），负数 / 小数没有「留几条」的读法',
      );
    }
    this.retainTerminal = retainTerminal;
    // nonTerminalBuffers 同款校验：判定是 `buffered <= quota 提前返回` ⇒ NaN 恒假
    // ⇒ **每条**非终态流的缓冲都被立刻回收（回放历史静默全没，与 retainTerminal 的
    // 「保留机制失效」同族、方向相反）。0 有读法：非终态流不留回放缓冲（只做实时转发）。
    const nonTerminalBuffers = opts.nonTerminalBuffers ?? TASK_STREAM_DEFAULT_NON_TERMINAL_BUFFERS;
    if (
      typeof nonTerminalBuffers !== 'number' ||
      !Number.isSafeInteger(nonTerminalBuffers) ||
      nonTerminalBuffers < 0
    ) {
      throw new TypeError(
        `nonTerminalBuffers 必须是非负安全整数（${zeroClauseOf('TaskEventStreams.nonTerminalBuffers')}），收到 ${String(opts.nonTerminalBuffers)} —— ` +
          'NaN 会让「超出配额」的判定恒假（没人读的非终态流的回放缓冲被静默回收），负数 / 小数没有「留几条」的读法',
      );
    }
    this.nonTerminalBuffers = nonTerminalBuffers;
  }

  /** 这条流在场吗（在场 = 本进程见过它的记账） */
  has(taskId: string): boolean {
    return this.streams.has(taskId);
  }

  /** 开一条流（已存在则**复用**：HITL 恢复 / 崩溃重投都是同一个任务，序号必须接着走） */
  open(taskId: string): void {
    const existing = this.streams.get(taskId);
    if (!existing) {
      this.streams.set(taskId, {
        events: [],
        nextIndex: 1,
        firstAvailable: 0,
        done: false,
        subscribers: new Set(),
        doneListeners: new Set(),
      });
      return;
    }
    // 复用：只把「已完成」摘掉 —— 恢复段是同一个任务的续篇，缓冲与序号都接着用。
    // 从终态回到非终态且缓冲非空 ⇒ 它重新计入配额（计数 +1，见 `buffered` 的注释）并当场对账。
    const backInQuota = existing.done && existing.events.length > 0;
    existing.done = false;
    if (backInQuota) {
      this.buffered += 1;
      this.#recycleNonTerminal();
    }
  }

  /**
   * 记一条事件：入缓冲 + 广播给订阅者。
   * 超上限时丢**最旧**的一条（`firstAvailable` 前移）—— 读者据此知道前面被截了。
   *
   * ⚠️ **终态之后到达的事件直接忽略**：流已经以 `task.end` 收口，再往里塞会让下游看到
   * 「结束后还有事件」这种自相矛盾的流。丢掉的只有收尾残尾（超时工具的后台事件那一类）；
   * 权威的完整 trace 仍由 sink 出口交付（那条路不受本类影响）。
   */
  push(taskId: string, event: TraceRecordEvent): void {
    const s = this.streams.get(taskId);
    if (!s || s.done) return;
    // 从「空」变「非空」⇒ 这条流开始占配额（计数 +1，见 `buffered` 的注释）。
    // 判据取在 push 之前：push 之后一定非空（`maxEvents ≥ 1` 由构造期保证）。
    const wasEmpty = s.events.length === 0;
    const item: TaskStreamEvent = { index: s.nextIndex++, event };
    s.events.push(item);
    if (s.events.length > this.maxEvents) {
      const dropped = s.events.shift()!;
      s.firstAvailable = dropped.index + 1;
    }
    if (wasEmpty) {
      this.buffered += 1;
      // 超配额就从 Map 中最旧的非空、**无订阅者**候选开始回收（遍历的是 `open()` 的插入序，
      // 不是 push 序）。⚠️ 若更早 open 的流都空着、或已被回收成桩，**被回收的可能就是刚 push 的
      // 这条**（缺口由 `droppedBefore` 明示，见 `#recycleNonTerminal`）—— 那句「不会回收刚 push 的
      // 这条」是**假的**（2026-09-29 外部深评 B1 实证：这条流非空正是它被选中的理由，不是豁免）。
      this.#recycleNonTerminal();
    }
    // 广播：先拷订阅者集合（回调里可能退订），单个抛错不影响其它订阅者
    for (const l of [...s.subscribers]) {
      try {
        l(item);
      } catch {
        /* 观测不击穿业务（与 flushSinks 同款） */
      }
    }
  }

  /**
   * 订阅实时事件 + 终态通知；返回退订函数。**不含**重放（重放走 `replay()`，调用方先补后订）。
   *
   * 为什么要 `onDone`：**终态是流的一部分**，不是「没有更多事件」了事 —— 没有它，
   * 实时订阅者永远等不到收口（HTTP 那条流就永远挂着，客户端以为任务还在跑）。
   */
  subscribe(
    taskId: string,
    listener: (e: TaskStreamEvent) => void,
    onDone?: () => void,
  ): () => void {
    const s = this.streams.get(taskId);
    if (!s) return () => {};
    s.subscribers.add(listener);
    if (onDone) s.doneListeners.add(onDone);
    return () => {
      s.subscribers.delete(listener);
      if (onDone) s.doneListeners.delete(onDone);
    };
  }

  /** 该任务的订阅者数（用例要断言「流关掉后没人还挂在表里」） */
  subscriberCount(taskId: string): number {
    const s = this.streams.get(taskId);
    return s ? s.subscribers.size + s.doneListeners.size : 0;
  }

  /**
   * 取待补发的事件。`from` 语义 = 「我手上已有到 `from` 为止，给我之后的」
   *（SSE 的 `Last-Event-ID` 就是它，`?from=` 也是）。
   */
  replay(taskId: string, from?: number): TaskReplay {
    const s = this.streams.get(taskId);
    if (!s) return { events: [], done: false };
    const lower = Number.isFinite(from) ? (from as number) : 0;
    return {
      events: s.events.filter((e) => e.index > lower),
      ...(s.firstAvailable > 0 ? { droppedBefore: s.firstAvailable } : {}),
      done: s.done,
    };
  }

  /**
   * 丢掉一条**本进程从未推进过、也没人在读**的空流表项（2026-11-14：跟随放弃后的清理）。
   *
   * 场景：`submit` 在同步段就 `open()` 了流（保证「返回 taskId 后立刻可订阅」），但随后的
   * 提交仲裁发现这条任务归**别的进程**，本进程放弃跟随 —— 这条流就成了一块永远不会有事件、
   * 也永远不会 `markDone` 的空桩（`#evictTerminal` 只回收终态流）。
   *
   * 为什么删表项在这里**不违反**约束 4/1：被删的前提是「缓冲为空、从未终态、无订阅者」——
   * 没有 `nextIndex` 走过的历史可丢，也就不存在「拿 `Last-Event-ID` 续订的读者筛不出东西」。
   * 有事件或有订阅者的流一律不动：那不是空桩，删了会真的静默丢历史/正文。
   */
  releaseUnwatched(taskId: string): void {
    const s = this.streams.get(taskId);
    if (!s || s.done || s.events.length > 0) return;
    if (s.subscribers.size > 0 || s.doneListeners.size > 0) return;
    this.streams.delete(taskId);
  }

  /** 标记终态：此后不再有事件（`task.end` 由调用方发），并按 LRU 丢掉最旧的终态流 */
  markDone(taskId: string): void {
    const s = this.streams.get(taskId);
    if (!s) return;
    // 终态不再计入「非终态缓冲」配额（计数 -1，见 `buffered` 的注释）。
    // 幂等：重复 markDone 不重复减（计数少减一次会让配额**多**留几条，方向是漏不是错，
    // 但那也是漂 —— 判据取在赋值之前）。
    if (!s.done && s.events.length > 0) this.buffered -= 1;
    s.done = true;
    // 先广播终态再考虑淘汰：订阅者要能收口（单个抛错不影响其它订阅者）
    for (const l of [...s.doneListeners]) {
      try {
        l();
      } catch {
        /* 观测不击穿业务（与 push 同款） */
      }
    }
    this.#evictTerminal();
  }

  /**
   * **非终态**流的**缓冲**回收（配额 = `nonTerminalBuffers`）。2026-09-28 外部深评 T4 的收口。
   *
   * 回收的是**缓冲**，不是**表项**：`has()` 仍为真（任务确实在本进程），`nextIndex` 不动
   * （序号接着走），只把回放历史丢掉并用 `firstAvailable = nextIndex` 明示缺口 ——
   * 于是 `replay()` 回空 + `droppedBefore`，HTTP 层据此**先**发一帧 `stream.truncated`
   * 再转实时。连表项一起删是**错的**，理由写在类注释约束 4（恢复段的序号会从 1 重来，
   * 拿 `Last-Event-ID` 续订的读者从此静默收不到东西）。
   *
   * 三条纪律（每条都有代价，别按直觉改）：
   *
   * - **有订阅者的不回收**：那是一条正在被读的流，回收等于从读者手里抽走数据。
   *   代价如实：**被实时读的流不受配额约束** ⇒ 同时被读的流很多时，缓冲总量仍会超配额 ——
   *   这是「不抽走正在读的东西」的代价，不是漏洞（与 `#evictTerminal` 同款取舍）。
   *   ⚠️ 另一条代价（2026-09-29 外部深评 B1）：**退订不触发回收**（回收只在「某条流从空变非空」
   *   这个判定点跑）⇒ 一条「曾被实时读过、之后退订」的非空流会**一直占着配额**，直到下一次判定点。
   *   所以配额的真实上界是 `nonTerminalBuffers + 曾有订阅者的流数`（仍有界，但别把它当
   *   「缓冲总量 ≤ nonTerminalBuffers」来承诺）。
   * - **终态的不归这里管**：它走 `#evictTerminal()` 的 LRU（那条丢的是**表项**）。
   * - **只在缓冲增长时判**（`push` 让某条流从空变非空 / `open()` 把终态流拉回非终态）：
   *   每次 push 都全表扫会把这道内存闸本身变成开销（见 `buffered` 的注释）。
   *   代价如实：判定点之间会**短暂**多出几条 —— 但每条增长都会当场触发一次回收，所以超额是
   *   「本轮一个事件」的量级，不是无界累积。
   */
  #recycleNonTerminal(): void {
    if (this.buffered <= this.nonTerminalBuffers) return;
    // Map 的插入序即「最旧优先」：挂得最久的任务（等审批 / 等事件 / 等定时器）先被回收 ——
    // 它们正是这条闸要治的那一类（永远不会走到终态，缓冲只增不减）。
    for (const s of this.streams.values()) {
      if (this.buffered <= this.nonTerminalBuffers) return;
      if (s.done || s.events.length === 0 || s.subscribers.size > 0) continue;
      s.events = [];
      s.firstAvailable = s.nextIndex; // 缺口从「下一条」开始 ⇒ 已缓冲的全不在
      this.buffered -= 1;
    }
  }

  /**
   * 终态流超过保留条数 ⇒ 从最旧的开始丢（Map 的插入序即 LRU 序；恢复段 `open()` 会把它当新流）。
   *
   * ⚠️ 这里**曾经**还有一个公开方法 `forget(taskId)`（「丢弃某条流」）。2026-09-28 外部深评
   * 复核时确认它**全仓零调用点**（`grep` 命中的 `forget()` 全是 `scheduler.ts` 里那个操作
   * `inFlight` 的同名**局部函数**，与此无关）—— 删掉，不留死承诺。
   * 淘汰这件事**唯一的真实机制就是本方法**：终态流按 LRU 丢、有订阅者的不丢。
   * 将来若真要「外部显式丢弃某条流」，请连同**谁在什么场景会调**一起设计再加回来
   * （报告当初的建议「给 forget 写个测试」是反的：那等于给死代码上锁）。
   */
  #evictTerminal(): void {
    const doneIds: string[] = [];
    for (const [taskId, s] of this.streams) {
      if (s.done) doneIds.push(taskId);
    }
    let excess = doneIds.length - this.retainTerminal;
    for (const taskId of doneIds) {
      if (excess <= 0) return;
      // 还有订阅者的终态流**不丢**：那是一条还没被读完的流（丢了下游会莫名断在半路）。
      // 跳过它但不算「减掉一个」，于是继续往后找真正能丢的。
      if (this.streams.get(taskId)!.subscribers.size > 0) continue;
      this.streams.delete(taskId);
      excess -= 1;
    }
  }
}
