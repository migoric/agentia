/* 把框架的 Trace.spans[] 归一成渲染动作，喂给 createTraceView 建出的视图。
 *
 * 框架的 trace 是【扁平 spans[] + parentSpanId】，渲染器要的是【嵌套树 + 每个节点内
 * 事件与子 span 按发生顺序混排的 order】。本文件就是那座桥 —— 同一份渲染器因此
 * 既能吃官网的模拟回放，也能吃真实 run 的 trace。
 *
 * 归一规则：
 *   1. 全局时间线：每个 span 的 start / end 与它的每个 event 汇到一起，按时间排序。
 *      tie-break：同一毫秒 start(0) → event(1) → end(2)，且 start 按深度浅的在前 ——
 *      保证父 span 先于子 span 打开、tool.input 落在它所属 turn 打开之后。
 *   2. 显示名合成：框架的 capability span 名是【裸名】（类型记在 attributes，如 {subagent:'x'}），
 *      这里补成 `type:name`，与渲染器的四类标识符对齐；事件里的工具名若是某个 capability span
 *      的裸名，同样补前缀（否则回落 tool:）。
 *   3. usage 只由 llm.turn 累计（capability span 的 usage 是子 span 聚合，计入会双算）。
 */

import { fmtArg, rawArg, capabilityTypeOf, CAP_ICO } from './view.js';

/** 从 span.attributes 认能力类型（框架用 `setAttribute(capabilityId, 'subagent', name)` 记类型） */
function spanType(s) {
  const attrs = s.attributes || {};
  for (const t of Object.keys(CAP_ICO)) {
    if (attrs[t] != null) return t;
  }
  return '';
}

/** 显示名：capability span 补 `type:` 前缀（已是 type:name 形态则原样保留） */
function displayName(s) {
  const raw = String(s.name || '');
  const t = spanType(s);
  if (!raw) return t || s.kind || '';
  if (capabilityTypeOf(raw)) return raw; // 已带前缀
  return t ? `${t}:${raw}` : raw;
}

function usageOf(s) {
  if (!s.usage) return null;
  return {
    input: s.usage.inputTokens || 0,
    output: s.usage.outputTokens || 0,
    cacheRead: s.usage.cacheReadTokens || 0,
    cacheCreation: s.usage.cacheCreationTokens || 0,
  };
}

/** 事件工具名：**只有 `tool.*` 事件带工具名**。
 *  框架的事件里 `usage.unpriced` / `llm.retry` / `budget.exceeded` / `context.budget` 的事件体
 *  根本没有 `tool` 字段 —— 一律套前缀只会得到 `tool:?` 这种把「无工具」显示成「名字叫 ? 的工具」
 *  的误导标签（面板与官网 playground 共用本渲染器，等于把假工具摆给使用者看）。
 *  工具裸名靠兄弟 capability span 反查类型，找不到按 tool 算。 */
function eventToolName(evName, bodyTool, typeMap) {
  if (!String(evName || '').startsWith('tool.')) return '';
  const raw = String(bodyTool || '?');
  if (capabilityTypeOf(raw)) return raw;
  return `${typeMap.get(raw) || 'tool'}:${raw}`;
}

/** 事件摘要：input 走 fmtArg（与 span 入参同一形态），output 走文本内容 */
function eventText(ev) {
  const body = ev.body;
  if (ev.name === 'tool.input') return fmtArg(body?.input);
  if (ev.name === 'tool.output') {
    const c = body?.content;
    return typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c);
  }
  return body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * 事件全文（展开态用）。
 *
 * 只有 `tool.input` 需要单独取：`fmtArg` 把入参摘要**砍到 4 个键 / 每值 21 字符 / 整串 62 字符**，
 * 直接拿摘要当全文就是「假展开」—— 点开看到的还是那 62 个字符。出参与其他事件本身就是原文
 * （`eventText` 原样返回 content），无需二次处理。
 * 原文口径统一在 view.js 的 `rawArg`：官网 playground 的模拟回放也要用它，两处一处定义。
 */
function eventFull(ev) {
  if (ev.name === 'tool.input') return rawArg(ev.body?.input);
  return eventText(ev);
}

/**
 * 把真实 Trace 线性回放给视图（同步、一次性）。
 *
 * 两种用途共用本函数（这也是它必须呆在 trace-view 里、不进 CLI 的理由）：
 * - **收尾的整棵 trace**（run 结束后一次画完）；
 * - **在飞的那棵树**（CLI inspector 的实时右栏：每收到一条增量记账事件就整体重画一次，
 *   见 `packages/cli/src/panel-logic.ts` 的 `applyTraceEvent`）。重画是幂等的 ——
 *   同一棵 spans 交给它多少次，画出来的都是同一棵树。
 *
 * 返回 false 表示 trace 空、未做任何渲染。
 */
export function playTrace(view, trace) {
  const spans = Array.isArray(trace?.spans) ? trace.spans : [];
  // ⚠️ 空 spans 也**必须 reset**：playTrace 的契约是「把这个 view 变成这棵树」——
  // 直接 return 会把**上一条 trace 的树**留在页面上，而下拉里选中的是这一条
  // （切换后看到别人的数据，比看到空白更坏；2026-10-21 在 `agentia view` 的多 trace
  // 下拉里实测到：先选一个正常 trace，再选一个 0 spans 的，树原样不动）。
  if (!spans.length) {
    const label = trace?.traceId ? String(trace.traceId) : '空 trace';
    view.reset(`run · ${label}（无 spans）`);
    return false;
  }

  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const root = spans.find((s) => s.kind === 'run') || spans[0];

  // 裸名 → 能力类型（供事件补前缀）
  const typeMap = new Map();
  for (const s of spans) {
    const t = spanType(s);
    if (s.kind === 'capability' && t) typeMap.set(String(s.name || ''), t);
  }

  const depthOf = (s) => {
    let d = 0;
    let cur = s;
    const seen = new Set();
    while (cur?.parentSpanId && byId.has(cur.parentSpanId) && !seen.has(cur.spanId)) {
      seen.add(cur.spanId);
      d += 1;
      cur = byId.get(cur.parentSpanId);
    }
    return d;
  };

  const items = [];
  let seq = 0; // 出现顺序：时间缺失 / 并列时的确定性回退（NaN 参与比较会让排序结果随引擎不定）
  const timeOf = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  for (const s of spans) {
    const start = timeOf(s.startedAt, 0);
    items.push({ t: start, ord: 0, d: depthOf(s), s, kind: 'start', seq: seq++ });
    if (s.endedAt != null)
      items.push({ t: timeOf(s.endedAt, start), ord: 2, d: 0, s, kind: 'end', seq: seq++ });
    for (const ev of s.events || [])
      items.push({ t: timeOf(ev.time, start), ord: 1, d: 0, s, kind: 'event', ev, seq: seq++ });
  }
  items.sort((a, b) => a.t - b.t || a.ord - b.ord || a.d - b.d || a.seq - b.seq);

  const rootRaw = String(root.name || 'run');
  // 框架的 run 根名可能是 runName（如 'app'）或已是 'run · x' 形态，避免重复前缀
  view.reset(rootRaw.startsWith('run') ? rootRaw : 'run · ' + rootRaw);

  for (const it of items) {
    if (it.kind === 'start') {
      if (it.s === root) continue; // 根由 reset 建，不重复开
      view.start({
        id: it.s.spanId,
        parent: it.s.parentSpanId,
        kind: it.s.kind,
        name: displayName(it.s),
        arg: '',
      });
    } else if (it.kind === 'event') {
      view.event(
        it.s.spanId,
        it.ev.name,
        eventToolName(it.ev.name, it.ev.body?.tool, typeMap),
        eventText(it.ev),
        it.ev.body?.ok !== false,
        eventFull(it.ev),
      );
    } else {
      view.end({
        id: it.s.spanId,
        ms: it.s.endedAt - it.s.startedAt,
        usage: usageOf(it.s),
        status: it.s.status,
        error: it.s.error,
        arg: '',
      });
    }
  }

  // 根 span 还没结束（`span.end` 尚未到达）⇒ **不收尾**：`finish()` 会把根标成已完成
  // （● + 耗时），而这棵树其实还在长 —— 在飞时看到「已完成」是假事实。留 ◌ 才对。
  // 收尾的整棵 trace 根必有 `endedAt`，所以这条分支只对「在飞 / 截断」的树生效。
  if (root.endedAt != null) view.finish(root.endedAt - root.startedAt, root.status, root.error);
  return true;
}
