import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import type { Trace, TraceSink } from '../core/trace.js';

/**
 * Agentia —— JSONL 文件 sink：一行一条**裸 Trace** 追加落盘。
 *
 * 这是 CLI 四件套 `agentia report` / `agentia diff` / `agentia harvest` / `agentia export`
 * 的**输入格式**（每行一个 JSON，裸 Trace）—— 消费侧早就吃这个文件，产出侧此前要用户手写
 * `appendFileSync` 的 sink，这里把它收进框架。
 *
 * 语义：
 * - 父目录不存在时**构造期**递归创建（同 FileTaskStore：建一次，不落在每次 append 的热路径上）；
 * - 每次 `export` 追加一行（同步写，进程内串行）；**追加不覆盖**，文件已有时接着写；
 * - 写失败**抛给调用方**（`flushSinks` 会吞掉并落 console.warn —— 观测失败不击穿业务）；
 *   构造期 mkdir 失败同样抛（配置错误要响亮）。
 *
 * 前提：**单进程写者**（同 FileTaskStore）—— 多进程写同一文件会交错，
 * 跨进程协调（锁 / 队列）属部署层职责，不在本实现内。
 *
 * **同一路径进程内返回同一个 sink**（2026-10-16 ref-sink-exactly-once）：`jsonlTraceSink({ path: X })`
 * 调两次得到的是**同一个对象**，而不是两个各自 append 的写者。为什么必须幂等 ——
 * 两条 sink 对口同一个文件时，一次 run 会落**两行**同 traceId 的记录，而
 * `report` / `diff` / `harvest` 是把「一行 = 一次 run」当前提的 ⇒ 表现不是「报错」，
 * 而是「这次 run 被数了两次」（成本翻倍、错误率减半）。**比不落盘更难发现**：不落盘
 * 是「没有数据」，重复落盘是「数据看起来很正常，但错了」。
 * 现实里撞到它的形状：脚手架的 `createApp({ sinks })` 与 `agentia dev` 的
 * `registerDefaultTraceSink` 都往 `.agentia/traces.jsonl` 写（各自都合理）⇒ 幂等让
 * 「两处都接」退化成「恰好一次」，而不是「谁也不知道对方也写了」。
 * ⚠️ 幂等的粒度是**进程内按解析后的绝对路径**；跨进程仍受上面「单进程写者」前提约束。
 *
 * ⚠️ **`fsync` 不是缓存键的一部分**（2026-11-09 深评 P3-1）：键带 `fsync` 会回到「同一文件两个
 * 写者 ⇒ 一次 run 落两行」那个更贵的问题上。所以同路径永远共用一个 sink，而**第二次请求的
 * `fsync` 与既有 sink 不一致时出一次声** —— 此前是静默忽略，于是「我明明开了 fsync」这类
 * 持久性承诺会无声失效（`fsync` 只影响性能与耐久，不影响内容，所以不会有任何东西报错）。
 *
 * ## 按天轮转（`rotate: 'daily'`，2026-11-13 ref-checklist-four）
 *
 * 缺省**关**（逐字保持旧行为）。开了之后跨天时把 `path` 里已有内容 `rename` 成
 * `<stem>.<YYYY-MM-DD><ext>`，随后 `path` 仍作为「当前文件」继续追加 —— **消费侧不用改**：
 * `agentia report` / `diff` / `harvest` / `export` 与 dev 面板读的都是固定路径
 * `.agentia/traces.jsonl`，若改成「每天一个新文件名」它们会集体读不到新数据。
 *
 * 三条口径（都是「不丢数据」）：
 * - **UTC 自然日**，取 trace 根 span 的 `startedAt`（手写 trace 没有时间戳时回退写盘时刻）；
 *   日期按**单调不减**推进，乱序到达 / 回放昨天的 trace 不会把今天的内容归档成昨天。
 * - 进程重启后 `path` 里还留着前一天的内容 ⇒ 用**文件 mtime** 初始化当前日，第一条新一天的
 *   trace 会先把旧内容归档，不会把两天混进同一个文件。
 * - 归档目标已存在 ⇒ **不覆盖、不删除**，出一次声并继续追加 `path`。宁可混日期，也不丢历史。
 *
 * ⚠️ 边界如实写在这里：mtime 与「按 trace 业务日切片」是**近似**（积压到今天才落盘的昨天
 * trace 会落在今天的文件里）；要精确按业务日分文件，请自行按 `startedAt` 选 sink 路径。
 * 轮转同样受上面「单进程写者」前提约束 —— 跨进程 rename 不在本实现内协调。
 */
interface SinkEntry {
  readonly sink: TraceSink;
  readonly fsync: boolean;
  readonly rotate: boolean;
  /** 不一致告警是否已出过（同路径只说一次，别按 run 刷屏） */
  warned: boolean;
  rotateWarned: boolean;
}

const sinkByPath = new Map<string, SinkEntry>();

/**
 * 这条 trace 属于哪个 **UTC 自然日**。优先根 span 的业务起点，手写 trace 没有时间戳
 * 时回退 `now`（写盘时刻）。`module` 级 export 供单测直接钉边界，不进公共导出面。
 */
export function dayKeyOf(trace: Trace, now: number): string {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId) ?? trace.spans[0];
  const started = root?.startedAt;
  const t = typeof started === 'number' && Number.isFinite(started) ? started : now;
  return new Date(t).toISOString().slice(0, 10);
}

/** `…/traces.jsonl` + `2026-11-13` ⇒ `…/traces.2026-11-13.jsonl`（无扩展名时直接补 `.日期`）。 */
export function dailyArchivePath(path: string, day: string): string {
  const ext = extname(path);
  return `${path.slice(0, path.length - ext.length)}.${day}${ext}`;
}

export function jsonlTraceSink(options: {
  path: string;
  fsync?: boolean;
  /** 缺省关；开了按 UTC 自然日把旧内容归档，`path` 仍是当前文件（见文件头） */
  rotate?: 'daily';
}): TraceSink {
  const path = resolve(options.path);
  const fsync = options.fsync === true;
  const rotate = options.rotate === 'daily';
  const existing = sinkByPath.get(path);
  if (existing !== undefined) {
    if (existing.fsync !== fsync && !existing.warned) {
      existing.warned = true;
      console.warn(
        `[agentia] jsonlTraceSink：同路径已存在一个 fsync=${existing.fsync} 的 sink（${path}），` +
          `本次请求的 fsync=${fsync} 不会生效。` +
          '同路径进程内只保留一个 sink（否则一次 run 会落两行同 traceId 的记录）；' +
          '要换持久性口径，请在进程启动时统一整份配置。',
      );
    }
    if (existing.rotate !== rotate && !existing.rotateWarned) {
      existing.rotateWarned = true;
      console.warn(
        `[agentia] jsonlTraceSink：同路径已存在一个 rotate=${existing.rotate ? 'daily' : 'off'} 的 sink（${path}），` +
          `本次请求的 rotate=${rotate ? 'daily' : 'off'} 不会生效。` +
          '同路径进程内只保留一个 sink；轮转会改写入目标，请在进程启动时统一整份配置。',
      );
    }
    return existing.sink;
  }
  mkdirSync(dirname(path), { recursive: true });
  // 进程重启后 `path` 里可能还留着前一天的内容：用文件 mtime 认出它属于哪天，
  // 第一条新一天的 trace 才会先把旧内容归档，而不是把两天混进同一个文件。
  let currentDay: string | null =
    rotate && existsSync(path) && statSync(path).size > 0
      ? new Date(statSync(path).mtimeMs).toISOString().slice(0, 10)
      : null;

  const rotateIfNeeded = (day: string): void => {
    if (currentDay === null) {
      currentDay = day;
      return;
    }
    // 单调不减：乱序 / 回放的旧 trace 不触发归档，否则会把今天的内容归档成昨天。
    if (day <= currentDay) return;
    const archive = dailyArchivePath(path, currentDay);
    if (existsSync(path) && statSync(path).size > 0) {
      if (existsSync(archive)) {
        console.warn(
          `[agentia] jsonlTraceSink：归档 ${archive} 已存在，本次不覆盖也不删除 ${path}，` +
            '继续追加到当前文件（宁可混日期，也不丢历史）。请检查是否有别的写者或手工归档。',
        );
      } else {
        renameSync(path, archive);
      }
    }
    currentDay = day;
  };

  const sink: TraceSink = {
    export(trace: Trace): void {
      const line = `${JSON.stringify(trace)}\n`;
      if (rotate) rotateIfNeeded(dayKeyOf(trace, Date.now()));
      if (!fsync) {
        // 保持旧行为：appendFileSync 一次 open/write/close（进程内串行、按行原子）。
        const fd = openSync(path, 'a');
        try {
          writeSync(fd, line);
        } finally {
          closeSync(fd);
        }
        return;
      }
      // opt-in 持久性：fsync 之后才承诺「已落盘」。代价是每次 run 收尾多一次磁盘同步，
      // 高吞吐宿主应只在关键 trace 上开（2026-11-07 深评）。
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
  sinkByPath.set(path, { sink, fsync, rotate, warned: false, rotateWarned: false });
  return sink;
}
