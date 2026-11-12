/* Agentia trace 调用树渲染器 —— 数据无关、零依赖。
 *
 * 只认五个动作：reset 开树 / start 开 span / event 记事件 / end 收 span / finish 收 run。
 * 谁喂它都行：官网 playground 的模拟回放脚本，或 fromTrace.js 的 playTrace（真实 Trace）。
 *
 * 视觉语言与语义（逐字取自 packages/website/src/scripts/playground.js，行为不变）：
 *   - 事件行（tool.input / tool.output）没有状态圈、没有耗时，比 span 行更轻；
 *   - 事件与子 span 按发生顺序混排（input 先于它触发的 capability span、output 后于它）——
 *     这个先后本身就是语义，不能拍平成一类；
 *   - 四类能力标识符（⚙ tool / ◆ skill / ¶ prompt / ⊕ subagent）只靠字形区分、不上类型色。
 *
 * 展开：折叠态**一字不变**（省略号收敛，事件行比 span 行更轻），点事件行可展开看**完整正文**。
 * 展开状态存在渲染之外（每次事件都会全量重建 DOM），否则实时 run 里刚点开的行会在下一条事件
 * 到来时自己合上。数据侧「行内摘要」与「展开全文」是两个字段：`text` 是摘要（入参经 fmtArg
 * 砍到 62 字符），`full` 才是原文 —— 只有全文能撑起「调试时看工具结果」这件事。
 *
 * 宿主需提供的 CSS 变量：--ice --faint --text（见 trace-view.css）。
 */

/* 展开态的正文有三种形状（2026-11-11，2026-11-12 扩了两档）：
 *   - 纯文本字符串 → 老路：`.tr-io` 里放原文，靠 `.tr-open` 换行（纯文本正文、官网模拟回放）；
 *   - 对象/数组 → 追加一个 `.tr-full` 结构化块（折叠 / 成表 / 路径复制），`.tr-io` 由 CSS 隐藏；
 *   - **装着 JSON 的字符串**（`content: "{\"rows\":[...]}"`，工具把结构序列化后塞回文本字段）
 *     → 同上一档，块头写明「string · N 字符 → object · M 项」并打 `str→json` 标记；
 *   - **一整篇 Markdown 的字符串**（工具出参就是一份 SKILL.md / 报告）→ 由宿主注入的
 *     `opts.textBody(text)` 渲染成正文块，块头打 `md` 标记。注入是刻意的：本包是独立
 *     发布单元，解析器只有一份（在宿主里），两边各带一份必然漂移。
 * 判据与块内完全同源（`hasStructuredBody`），「挂不挂块」与「块里画什么」因此不会跑偏。
 * 前两档并存是刻意的：纯文本那条路有 test/style.test.js 的两个不变量守着（最小宽度、caret 常显），
 * 全换成本件会让那两个守卫失去落点。 */
import { createFullView, hasStructuredBody } from './full-view.js';

export const CAP_ICO = { tool: '⚙', skill: '◆', prompt: '¶', subagent: '⊕' };

/** 能力类型取自名字前缀（tool: / skill: / prompt: / subagent:） */
export function capabilityTypeOf(name) {
  const t = String(name || '').split(':')[0];
  return CAP_ICO[t] ? t : '';
}

export const fmtNum = (n) => n.toLocaleString('en-US');
export const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms');

/* span 入参摘要：写进 trace 行，否则同名 capability（如两次 tool:get_weather）无法区分 */
export function fmtArg(v) {
  if (v == null) return '';
  let s;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return ''; // 无入参就不显示，避免行里多一个 "{}"
    s =
      '{ ' +
      keys
        .slice(0, 4)
        .map((k) => {
          let sv = typeof v[k] === 'object' ? JSON.stringify(v[k]) : String(v[k]);
          if (sv.length > 22) sv = sv.slice(0, 21) + '…';
          return k + ': ' + sv;
        })
        .join(', ') +
      (keys.length > 4 ? ', …' : '') +
      ' }';
  } else s = String(v);
  return s.length > 62 ? s.slice(0, 61) + '…' : s;
}

/* span 入参**原文** —— fmtArg 的对偶：摘要给折叠态，原文给展开态。
 * 两者必须定义在同一处：哪个宿主自己搓一个「原文」，「展开」就会在那里退回摘要
 * （点开什么都没多出来），而两个宿主共用这一份渲染器，正是为了不让这种漂移发生。 */
export function rawArg(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 建一个绑定到 rootEl 的 trace 视图。
 * opts.price   = { input, output }（$/M tokens）或 null（无公开单价则不估算成本）
 * opts.usage   = { in, out, cost } 三个 DOM 节点（可选；给了才更新计数器）
 * opts.onUsage = (acc) => void（可选；每次累计后回调，便于宿主自定义展示）
 */
export function createTraceView(rootEl, opts = {}) {
  let price = opts.price ?? null;
  const onUsage = opts.onUsage ?? null;
  const usageEls = opts.usage ?? null;
  /* 字符串正文的宿主渲染器（可选）：`(text) => Element | null`。返回 null = 「不是那种
     正文，保持原文」。本包不自带 Markdown 解析器 —— 见文件头注。 */
  const textBody = typeof opts.textBody === 'function' ? opts.textBody : null;

  let traceRoot = null;
  const spanMap = new Map();
  const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  /* 批量渲染（2026-11-13）。此前每来一条 span 动作就整树重建一次 ⇒ `playTrace` 是 O(N²)：
     实测 50 span 触发 151 次全树重建、600 span 触发 1801 次（假 DOM 就 172ms），而在飞时
     `renderLive` 每个 rAF 还会再调一次 `playTrace`。这不是「慢一点」，是长跑时面板直接卡死。
     语义不变：**渲染仍是全量重建**（那是折叠态必须外部持有的原因），只是把「一批动作之间
     的 N 次重建」压成「结束后一次」。
     ⚠️ 嵌套是安全的（计数器），且批内抛错也会在 finally 里补画 —— 否则异常路径之后整棵树
     停在中间状态，而下一条事件又会被 `dirty` 吞掉。 */
  let batchDepth = 0;
  let batchDirty = false;
  /* 树内检索（2026-11-13）：**不改结构**，只给命中的行加类 + 提供「跳到下一处」。
     为什么不裁剪节点：树形是「谁挂在谁下面」的事实，隐藏父节点会让子节点看起来属于别人；
     而裁剪后「有多少条被藏起来了」又要另一处交代。高亮 + 跳转在不改事实的前提下解决
     「一百个 span 里找那一条」。 */
  let query = '';
  let hitIndex = -1;
  /* 时间轴开关（2026-11-13）：轨道占 72px，窄面板里是从名字里抢的 ⇒ 允许关掉。
     默认开 —— 它是「谁和谁并行 / 8 秒被谁吃掉」唯一的落点，而那条信息此前完全没有。 */
  let timeline = true;
  /* 展开态的行 key 集合 + 事件 key 发号器。两者都必须活在 renderTrace 之外：
     渲染是【全量重建】（rootEl.innerHTML = ''），状态放进 DOM 或渲染过程里就活不过下一次事件。 */
  const expanded = new Set();
  /* 结构化块内部的折叠状态，按事件键一份（`ev.key` → 路径 → 是否展开）。
     与 `expanded` 同一条理由，而且更硬：块本身每次重建都会 new 一个，状态只能挂在树上。 */
  const folds = new Map();
  let evSeq = 0;

  /** 正在选文本时不要收起/展开 —— 鼠标拖选到行外松手会补一次 click，否则选完就自己合上了 */
  function hasSelection() {
    try {
      return String(globalThis.getSelection?.() ?? '') !== '';
    } catch {
      return false;
    }
  }

  function toggleExpand(key) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    renderTrace();
  }

  /** 宿主渲染器包一层：**只在展开时调用**（折叠态每条事件都会重画，挂在那儿等于白解析
   *  一遍所有历史正文）；宿主抛错也不许让整棵树白屏 —— 回落原文即可。 */
  function textBodyOf(v) {
    if (!textBody || typeof v !== 'string') return null;
    try {
      return textBody(v) || null;
    } catch {
      return null;
    }
  }

  /** 把一批渲染动作压成一次重画（见 `batchDepth` 的头注）。没在批里就直接画。 */
  function renderTrace() {
    if (batchDepth > 0) {
      batchDirty = true;
      return;
    }
    drawTree();
  }

  function batch(fn) {
    batchDepth += 1;
    try {
      fn();
    } finally {
      batchDepth -= 1;
      // 批内一次都没标脏（例如只读了状态）⇒ 不白画一遍
      if (batchDepth === 0 && batchDirty) {
        batchDirty = false;
        drawTree();
      }
    }
  }

  /** 检索：这一行的文本是否命中。空查询恒 false（「没在搜」不等于「全都命中」） */
  function hits(texts) {
    if (!query) return false;
    const q = query.toLowerCase();
    for (const t of texts) if (t && String(t).toLowerCase().includes(q)) return true;
    return false;
  }

  function drawTree() {
    rootEl.innerHTML = '';
    hitIndex = -1;
    // 还没 reset 过（视图刚建出来）：清空即返回。setTimeline / setQuery 可能先于第一棵树
    // 被调用 —— 没有这一条，`traceRoot.order` 会抛，而调用方只是在设一个开关。
    if (!traceRoot) return;
    /* 时间轴的归一化基准：根 span 的起点与整棵树的终点。两者缺一就**不画条**
       （手写 trace / 官网模拟回放没有时间戳 —— 画一条人人占满的条比不画更误导）。 */
    const t0 = traceRoot && typeof traceRoot.startedAt === 'number' ? traceRoot.startedAt : null;
    let tMax = t0;
    if (t0 !== null) {
      for (const n of spanMap.values()) {
        const e = typeof n.endAt === 'number' ? n.endAt : n.startedAt;
        if (typeof e === 'number' && e > tMax) tMax = e;
      }
    }
    const total = t0 !== null && tMax !== null ? Math.max(0, tMax - t0) : 0;

    const rows = [];
    /* 每个节点下【事件】与【子 span】按发生顺序混排：tool.input 先于它触发的 capability span、
       tool.output 后于它，这个先后本身就是语义，不能拍平成一类。 */
    (function walk(node, prefix, isLast, isRoot) {
      rows.push({ node, prefix, isRoot, last: isLast, ev: null });
      const items = node.order || [];
      items.forEach((it, i) => {
        const last = i === items.length - 1;
        const next = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
        if (it.t === 'span') walk(it.n, next, last, false);
        else rows.push({ node, prefix: next, isRoot: false, last, ev: it.e });
      });
    })(traceRoot, '', true, true);

    rows.forEach(({ node, prefix, isRoot, last, ev }) => {
      const branch = isRoot ? '' : prefix + (last ? '└─ ' : '├─ ');

      /* 事件行：没有 status 圈、没有耗时、不参与 usage 计数，只带入参/出参摘要 */
      if (ev) {
        const open = expanded.has(ev.key);
        const row = el('div', 'tr-row tr-ev' + (ev.ok === false ? ' error' : ''));
        row.dataset.ev = ev.type;
        /* 检索只扫摘要与类型/工具名，**不扫完整正文**：`full` 常见 10KB 级，每帧每行
             indexOf 一遍会让「搜索」本身成为掉帧的原因（600 行 × 10KB ≈ 6MB/帧）。
             2000 字符以内才扫 —— 那个尺度上全文搜索才有意义（再长就是文档，不是一行）。 */
        const fullShort = typeof ev.full === 'string' && ev.full.length <= 2000 ? ev.full : '';
        if (hits([ev.type, ev.tool, ev.text, fullShort])) row.className += ' tr-hit';
        row.dataset.capability = capabilityTypeOf(ev.tool);
        row.appendChild(el('span', 'tr-pre', branch));
        row.appendChild(el('span', 'tr-evv', ev.type === 'tool.output' ? '◂' : '▸'));
        row.appendChild(el('span', 'tr-evtype', ev.type));
        // 非 tool.* 事件（usage.unpriced / llm.retry / budget.* / context.budget）没有工具名 ——
        // 这一格整个不渲染，别把「无工具」显示成假工具名（.tr-name 是 flex:none，.tr-io 自然占满）
        if (ev.tool) row.appendChild(el('span', 'tr-name', ev.tool));
        // 展开态用全文（ev.full），折叠态用摘要（ev.text）—— 折叠态因此与加展开之前逐字一致。
        // `full` 是对象/数组、装着 JSON 的字符串、或宿主认得的正文（Markdown）时
        // （2026-11-11 / 2026-11-12）：`.tr-io` 仍放**原文**（结构化块挂在行后、由 CSS 隐藏本格），
        // 所以「展开拿到的是原文而不是 62 字符摘要」这条不变量原样成立。
        const structured = hasStructuredBody(ev.full);
        const mdBody = open && !structured ? textBodyOf(ev.full) : null;
        const blocked = structured || mdBody !== null;
        const fullText = blocked ? rawArg(ev.full) : ev.full || '';
        const io = el('span', 'tr-io', (open ? fullText : ev.text) || '');
        // 展开后正文已在行里，再挂一个占满整行的原生 tooltip 只会挡视线
        io.title = open ? '' : ev.text || '';
        row.appendChild(io);
        if (ev.full) {
          row.dataset.expandable = '1'; // 可展开标记：CSS 靠它出 caret / cursor，测试靠它找行
          row.appendChild(el('span', 'tr-caret', open ? '▾' : '▸'));
          if (open) row.className += ' tr-open' + (blocked ? ' tr-structured' : '');
          row.addEventListener('click', () => {
            if (!hasSelection()) toggleExpand(ev.key);
          });
        }
        rootEl.appendChild(row);
        // 结构化正文是**兄弟块**而不是 `.tr-io` 的子节点：行是 flex + nowrap，
        // 塞进去会把树的列对齐打乱；独立成块才能自己换行、自己缩进。
        // 折叠状态按事件键取一份带进去（2026-11-11 晚）：块每次重建都 new，状态不能放块里。
        // `body` 是宿主渲染好的正文（Markdown），交给同一条挂载路径：块头、复制、`.tr-io`
        // 隐藏这些行为必须一致，否则「哪种正文」会从**外观**上分叉成两套。
        if (open && blocked) {
          let fold = folds.get(ev.key);
          if (!fold) {
            fold = new Map();
            folds.set(ev.key, fold);
          }
          rootEl.appendChild(createFullView(ev.full, { fold, body: mdBody }));
        }
        return;
      }

      const bad = node.done && node.status === 'error';
      const row = el('div', 'tr-row' + (node.done ? '' : ' running') + (bad ? ' error' : ''));
      row.dataset.kind = node.kind;
      const ut = node.kind === 'capability' ? capabilityTypeOf(node.name) : '';
      if (ut) row.dataset.capability = ut;
      const attrKeys = node.attributes ? Object.keys(node.attributes) : [];
      const attrKey = 'sp:' + node.id;
      const attrOpen = attrKeys.length > 0 && expanded.has(attrKey);
      /* 命中面：名字 / 入参摘要 / 错误原文 / **已展开的**属性值。
         属性只在展开时才算：折叠态那些值本来就没显示 —— 高亮一个看不见的东西只会让
         「N 处匹配」对不上眼睛看到的。 */
      const attrVals = attrOpen
        ? Object.values(node.attributes).map((v) => (typeof v === 'string' ? v : String(v)))
        : [];
      if (hits([node.name, node.arg, bad ? node.error?.message : '', ...attrVals])) {
        row.className += ' tr-hit';
      }
      row.appendChild(el('span', 'tr-pre', branch));
      row.appendChild(el('span', 'tr-dot', node.done ? (bad ? '✕' : '●') : '◌'));
      if (ut) row.appendChild(el('span', 'tr-ico', CAP_ICO[ut]));
      row.appendChild(el('span', 'tr-name', node.name));
      if (node.arg) {
        const arg = el('span', 'tr-arg', node.arg);
        arg.title = node.arg;
        row.appendChild(arg);
      }
      let meta;
      if (node.done) {
        const parts = [fmtMs(node.ms)];
        if (node.usage) {
          parts.push(fmtNum(node.usage.input + node.usage.output) + ' tok');
          const cr = node.usage.cacheRead || 0;
          const cc = node.usage.cacheCreation || 0;
          if (cr || cc) parts.push('cache ↑' + fmtNum(cr) + ' ↓' + fmtNum(cc));
        }
        if (bad) parts.push(node.error?.type || 'error');
        meta = parts.join(' · ');
      } else meta = '…';
      /* 时间轴条（2026-11-13）：按 run 的总时长归一化 —— 「8 秒被谁吃掉 / 谁和谁并行」
         只有结构视角是看不见的。放在 meta **之前**并自己吃掉 `margin-left: auto`，
         让「耗时读数 — 轨道」贴在一起（两者说的是同一件事）。根行不画：它恒占满全宽。 */
      if (!isRoot && timeline && t0 !== null && total > 0 && typeof node.startedAt === 'number') {
        const offset = node.startedAt - t0;
        const left = Math.min(1, Math.max(0, offset / total));
        const dur = node.done && node.ms > 0 ? node.ms : Math.max(total - offset, 0);
        const width = Math.min(1 - left, dur / total);
        const track = el('span', 'tr-tl');
        const bar = el('span', 'tr-tl-bar');
        // 几何只能走 style（宽度是**数据**，不是样式选择）；两端都 clamp 过 ⇒ 不会溢出轨道
        bar.style.cssText = `left:${(left * 100).toFixed(2)}%;width:${Math.max(width * 100, 0.6).toFixed(2)}%`;
        track.appendChild(bar);
        track.title = `起点 ${Math.round(offset)}ms · 时长 ${Math.round(dur)}ms`;
        row.dataset.tl = '1';
        row.appendChild(track);
      }
      const metaEl = el('span', 'tr-meta', meta);
      if (bad && node.error?.message) metaEl.title = node.error.message;
      row.appendChild(metaEl);
      /* span 属性（2026-11-13）：`model` / `system.version` / `tools.names` / `retry.attempt` /
         `handoff.*` / `guardrail.*` 全在 attributes 里，此前树上一格都不显示 ——
         「这次是不是提示词版本没换」「是不是重试了三次」只能靠猜。
         块体复用 `full-view.js`（纯 DOM 构造，不再写第二套渲染）。 */
      if (attrKeys.length > 0) {
        row.dataset.expandable = '1';
        row.appendChild(el('span', 'tr-caret', attrOpen ? '▾' : '▸'));
        row.addEventListener('click', () => {
          if (!hasSelection()) toggleExpand(attrKey);
        });
      }
      rootEl.appendChild(row);
      if (attrOpen) {
        let fold = folds.get(attrKey);
        if (!fold) {
          fold = new Map();
          folds.set(attrKey, fold);
        }
        rootEl.appendChild(createFullView(node.attributes, { fold }));
      }
      // 失败原文必须**看得见** —— 只塞进 title（hover 才显）等于没显示。首次运行最常见的失败
      // （没配 API key）就靠这一行定位；单起一行，不去挤占 nowrap 的 span 行。
      if (bad && node.error?.message) {
        const errLine = el('div', 'tr-errm');
        errLine.appendChild(el('span', 'tr-pre', branch + '  '));
        errLine.appendChild(el('span', 'tr-errm-msg', node.error.message));
        rootEl.appendChild(errLine);
      }
    });
  }

  function renderUsage(acc) {
    if (onUsage) onUsage(acc);
    if (!usageEls) return;
    if (usageEls.in) usageEls.in.textContent = fmtNum(acc.input);
    if (usageEls.out) usageEls.out.textContent = fmtNum(acc.output);
    if (!usageEls.cost) return;
    if (price == null || price.input == null || price.output == null) {
      usageEls.cost.textContent = '—'; // 无公开单价的端点不做估算（如 DeepSeek）
      return;
    }
    const cost = (acc.input * price.input + acc.output * price.output) / 1e6;
    usageEls.cost.textContent = '$' + cost.toFixed(4);
  }

  /**
   * 开树。rootName 为 run 根显示名（如 'run · 审查一份文档'）。
   *
   * `rootId` = **框架给这个根 span 的真 `spanId`**（`fromTrace.js` 的 `playTrace` 会传）。
   * 为什么必须传：根节点上的事件（`score` / `trace.truncated` / `approval.decided`）由
   * `event(span.spanId, …)` 投递，而旧实现只把根登记在字面量 `'root'` 上 ⇒ `spanMap.get`
   * 落空 ⇒ `event()` 静默 return。症状不是报错，是**评估结论与截断警告整类消失**，而子 span
   * 的事件一切正常（排查时最容易被判成「框架没记」）。字面量 `'root'` 仍登记：官网
   * playground 的模拟脚本用它当根 id，两个键指向同一节点，零成本。
   */
  function reset(rootName, rootId, startedAt, attributes) {
    traceRoot = {
      id: rootId || 'root',
      kind: 'run',
      name: rootName || 'run',
      children: [],
      events: [],
      order: [],
      done: false,
      ms: 0,
      /* 时间轴的基准（2026-11-13）：根 span 的起点。缺省 null ⇒ 整棵树不画条
         （手写 trace / 官网模拟回放没有时间戳，画一条人人占满的条比不画更误导）。 */
      startedAt: typeof startedAt === 'number' ? startedAt : null,
      endAt: null,
      /* 根 span 的属性（2026-11-13）：`model` / `system.version` / `tools.names` /
         `prompts.versions` / `stop_reason` **只写在根上**。根行不经过 `start()`
         （它由 reset 建），所以不在这里接一手，这些键在面板上就一格都看不到 ——
         「这次是不是提示词版本没换」只能去翻 JSON。空对象当没有。 */
      attributes:
        attributes && typeof attributes === 'object' && Object.keys(attributes).length > 0
          ? attributes
          : null,
      usage: { input: 0, output: 0 },
    };
    spanMap.clear();
    spanMap.set('root', traceRoot);
    if (rootId && rootId !== 'root') spanMap.set(rootId, traceRoot);
    expanded.clear(); // 展开态属于上一棵树：reset 开新树时一并清掉
    folds.clear(); // 块内折叠同理：留着只会在下一次点开时出现"莫名已折叠"的状态
    usageAcc.input = 0;
    usageAcc.output = 0;
    usageAcc.cacheRead = 0;
    usageAcc.cacheCreation = 0;
    renderTrace();
  }

  function start(s) {
    const node = {
      id: s.id,
      kind: s.kind,
      name: s.name,
      arg: s.arg || '',
      children: [],
      events: [],
      order: [],
      done: false,
      ms: 0,
      startedAt: typeof s.startedAt === 'number' ? s.startedAt : null,
      endAt: null,
      attributes: s.attributes && typeof s.attributes === 'object' ? s.attributes : null,
      status: 'ok',
      error: null,
      usage: null,
    };
    spanMap.set(s.id, node);
    const parent = spanMap.get(s.parent) || traceRoot;
    parent.children.push(node);
    parent.order.push({ t: 'span', n: node });
    renderTrace();
  }

  /* span 事件：框架把普通工具 / @Prompt 调用记成【turn 上的事件】，不给它们建 capability span
     （只有 skill / subagent 会 recorder.begin('capability', …)，见 engine/loop.ts）。
     events 与 order 并存：events 是数据、order 负责与子 span 的先后顺序。

     `text` = 行内摘要，`full` = 展开看的原文（省略时同 text —— 出参与多数事件本来就是原文，
     只有 tool.input 的摘要被 fmtArg 砍过，调用方需要显式给 full）。
     `key` 是展开状态的稳定标识：事件对象跨全量重建存活，所以键也稳定。 */
  function event(id, type, tool, text, ok, full) {
    const node = spanMap.get(id);
    if (!node) return;
    const e = {
      type,
      tool,
      text,
      ok: ok !== false,
      full: full === undefined ? text : full,
      key: 'ev' + ++evSeq,
    };
    node.events.push(e);
    node.order.push({ t: 'ev', e });
    renderTrace();
  }

  function end(s) {
    const node = spanMap.get(s.id);
    if (!node) return;
    node.done = true;
    node.ms = s.ms || 0;
    /* 终点优先取框架的真 `endedAt`（时间轴的右端）；没有就按起点 + 时长推。
       两者都没有（手写 trace）⇒ 留 null，那一段不画条。 */
    node.endAt =
      typeof s.endedAt === 'number'
        ? s.endedAt
        : typeof node.startedAt === 'number'
          ? node.startedAt + node.ms
          : null;
    node.status = s.status || 'ok';
    node.error = s.error || null;
    if (s.arg) node.arg = s.arg;
    node.usage = s.usage
      ? {
          input: s.usage.input || 0,
          output: s.usage.output || 0,
          cacheRead: s.usage.cacheRead || 0,
          cacheCreation: s.usage.cacheCreation || 0,
        }
      : null;
    // 计数器只累加 llm.turn（capability span 的 usage 是子 span 聚合，重复计入会双算）
    if (s.usage && node.kind === 'llm.turn') {
      usageAcc.input += node.usage.input;
      usageAcc.output += node.usage.output;
      usageAcc.cacheRead += node.usage.cacheRead;
      usageAcc.cacheCreation += node.usage.cacheCreation;
      renderUsage(usageAcc);
    }
    renderTrace();
  }

  function finish(ms, status, error) {
    if (!traceRoot) return;
    traceRoot.done = true;
    traceRoot.ms = ms;
    if (typeof traceRoot.startedAt === 'number' && typeof ms === 'number') {
      traceRoot.endAt = traceRoot.startedAt + ms;
    }
    // run 失败时根 span 也要标红：原先 status 恒为 ok，错误只体现在子 span 上
    traceRoot.status = status || 'ok';
    traceRoot.error = error || null;
    traceRoot.usage = { input: usageAcc.input, output: usageAcc.output };
    renderTrace();
  }

  /** 当前命中行（`.tr-hit`）。宿主没有 `querySelectorAll`（stub / 极简 DOM）时返回空集 */
  function hitRows() {
    try {
      if (typeof rootEl.querySelectorAll !== 'function') return [];
      return Array.from(rootEl.querySelectorAll('.tr-hit'));
    } catch {
      return [];
    }
  }

  /** 加/去一个类名（不依赖 classList：stub DOM 未必实现它） */
  function setFlag(node, cls, on) {
    const parts = String(node.className || '')
      .split(/\s+/)
      .filter((c) => c && c !== cls);
    if (on) parts.push(cls);
    node.className = parts.join(' ');
  }

  return {
    reset,
    start,
    event,
    end,
    finish,
    /** 把一批动作压成一次重画（`playTrace` 必用；宿主自己批量喂时也可以用） */
    batch,
    render: renderTrace,
    /**
     * 树内检索：**只高亮 + 跳转，不改结构**（理由见 `query` 的头注）。返回命中行数。
     * 空串 = 结束检索（清掉所有高亮）。
     */
    setQuery(q) {
      const next = typeof q === 'string' ? q.trim() : '';
      if (next === query) return hitRows().length;
      query = next;
      renderTrace();
      return hitRows().length;
    },
    get hitCount() {
      return hitRows().length;
    },
    /**
     * 跳到下一处命中（`dir < 0` 向上），返回 **1 基序号**；没有命中返回 0。
     * 越界绕回：搜索框里按 Enter 一路按到底再回到第一处，比「按不动了」更符合预期。
     */
    nextHit(dir = 1) {
      const list = hitRows();
      if (list.length === 0) return 0;
      hitIndex = (hitIndex + (dir > 0 ? 1 : -1) + list.length) % list.length;
      const cur = list[hitIndex];
      for (const r of list) setFlag(r, 'tr-hit-cur', r === cur);
      try {
        cur.scrollIntoView?.({ block: 'center' });
      } catch {
        /* 没有滚动能力（stub / 老浏览器）：序号仍然对，只是没把行带进视野 */
      }
      return hitIndex + 1;
    },
    setUsage: renderUsage,
    /** 时间轴开关（默认开）。关掉只是不画轨道，数据与命中都不受影响 */
    setTimeline(on) {
      const next = on !== false;
      if (next === timeline) return;
      timeline = next;
      renderTrace();
    },
    get timeline() {
      return timeline;
    },
    /** 换单价（如真实模式切服务商）：null 表示无公开单价 → 成本显示为 — */
    setPrice(p) {
      price = p ?? null;
      renderUsage(usageAcc);
    },
    get usage() {
      return usageAcc;
    },
  };
}
