import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTraceView } from '../src/view.js';
// ⚠️ `playTrace` 在 `fromTrace.js`（线性 span 事件序列 → 视图动作），**不在** `view.js` ——
// 公共面是 `index.js` 的 re-export，两处同名容易记混。
import { playTrace } from '../src/fromTrace.js';

/**
 * 树形状 / 错误行 / usage 汇总 —— `renderTrace`（view.js 89 行）里**注释最密的那三块**的
 * 行为门禁。
 *
 * ⚠️ **为什么这三块此前没有断言，而它们最该有**：`test/view.test.js` 的 9 个用例全部
 * 围绕「行展开」（`.tr-open` / `fmtArg` / `rawArg`）—— 那是最近一次加的功能。
 * 而下面这三条对应的代码里全是**踩过坑写下的注释**（分支图标、失败原文单独起行、
 * usage 只算 llm.turn），也就是说：**注释在讲「为什么不能改错」，测试却没钉住它们。**
 * 注释会腐烂，人不会去看；断言会红。
 *
 * 跑的是真的 `createTraceView` + `playTrace`（DOM stub 与 `view.test.js` 同款），
 * 所以类名 / `dataset` / 文本都是线上那份渲染器的真实产物。
 */

/** 极简 DOM stub（与 view.test.js 同款；这里不需要 click，故不补 addEventListener） */
function makeNode() {
  return {
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    /** 时间轴条的几何走 `style.cssText`（宽度是数据、不是样式选择）—— stub 得有这个字段 */
    style: { cssText: '' },
    children: [],
    set innerHTML(_v) {
      this.children = [];
    },
    get innerHTML() {
      return '';
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener() {},
  };
}

before(() => {
  globalThis.document = { createElement: () => makeNode() };
});
after(() => {
  delete globalThis.document;
  delete globalThis.getSelection;
});
beforeEach(() => {
  delete globalThis.getSelection;
});

// ---------- 取DOM 的小工具（全部走 className 判定，不认样式） ----------

const rowsOf = (root) => root.children;
const cn = (row) => row.className || '';
const spanRows = (root) =>
  rowsOf(root).filter((r) => cn(r).includes('tr-row') && !cn(r).includes('tr-ev'));
const errRows = (root) => rowsOf(root).filter((r) => cn(r).includes('tr-errm'));
const cellOf = (row, cls) => row.children.find((c) => c.className === cls);
const nameOf = (row) => cellOf(row, 'tr-name')?.textContent || '';
const metaOf = (row) => cellOf(row, 'tr-meta')?.textContent || '';
const dotOf = (row) => cellOf(row, 'tr-dot')?.textContent || '';
const preOf = (row) => cellOf(row, 'tr-pre')?.textContent || '';

/** 建视图并灌一棵 trace（每条用例自带 fixture，互不干扰） */
function mount(trace) {
  const root = makeNode();
  const view = createTraceView(root);
  assert.equal(playTrace(view, trace), true, 'fixture 必须非空（playTrace 对空 trace 返回 false）');
  return { root, view };
}

/** 一个 span 的最小骨架（只写用例关心的字段，其余由 fromTrace 兜默认值） */
function span(over) {
  return {
    spanId: 'x',
    traceId: 't',
    parentSpanId: null,
    kind: 'capability',
    name: 'cap',
    startedAt: 0,
    status: 'ok',
    attributes: {},
    events: [],
    ...over,
  };
}

describe('树形状（renderTrace 的 walk 展平）', () => {
  it('三层嵌套：每个子 span 带**对应的树形前缀**（└─ / ├─ / 竖线），不是平铺', () => {
    // 判据错的后果：前缀算错 ≠ 树画错，而是「层级关系看丢了」—— 一棵 3 层的树
    // 画成 3 个并列的兄弟，用户读不出谁是谁的子调用，而**任何单条 span 断言都照样绿**。
    const { root } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 100,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'llm.turn',
          name: 'm1',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 20,
        }),
        span({
          spanId: 's2',
          kind: 'capability',
          name: 'child',
          parentSpanId: 's1',
          startedAt: 2,
          endedAt: 10,
        }),
        span({
          spanId: 's3',
          kind: 'capability',
          name: 'sibling',
          parentSpanId: 's0',
          startedAt: 15,
          endedAt: 18,
        }),
      ],
    });

    const rows = spanRows(root);
    assert.equal(rows.length, 4, 'run 根 + 三个子 span = 4 行');
    assert.equal(nameOf(rows[0]), 'run · demo', '根行是 run 根（名字带前缀）');

    // 根的孩子有两个（m1 与 sibling）⇒ m1 是**非独子**所以是 ├─，sibling 是最后一个所以是 └─。
    // ⚠️ 写断言时我一度把m1 写成「独子⇒└─」，实测红了 —— **这正是要的效果**：
    // 树形前缀算错时读起来仍像棵树，只有断言能把它抓住。
    assert.match(
      preOf(rows[1]),
      /^├─ /,
      `m1 是根的非独子（实际：${JSON.stringify(preOf(rows[1]))}）`,
    );
    assert.match(
      preOf(rows[3]),
      /^└─ /,
      `sibling 是根的最后一个孩子（实际：${JSON.stringify(preOf(rows[3]))}）`,
    );
    // child 是 m1 的独子 ⇒ └─，且**必须带它父层的竖线缩进**（这一条才是「层级」的判据：
    // 只看 └─/├─ 两个字符的话，一棵 2 层的树和 3 层的长得一样）
    assert.match(
      preOf(rows[2]),
      /^│\s+└─ /,
      `child 应带父层缩进（实际：${JSON.stringify(preOf(rows[2]))}）`,
    );
    assert.ok(
      preOf(rows[2]).length > preOf(rows[3]).length,
      `深层前缀必须比浅层长（child=${JSON.stringify(preOf(rows[2]))} sibling=${JSON.stringify(preOf(rows[3]))}）`,
    );
  });

  it('事件与子 span **按发生顺序混排**（不拍平成两类）', () => {
    // 注释原文：「每个节点下【事件】与【子 span】按发生顺序混排：tool.input 先于它触发的
    // capability span、tool.output 后于它，这个先后本身就是语义，不能拍平成一类」。
    //
    // ⚠️ 「混排」发生在**同一个父节点的孩子列表**里，不是「事件行插到别的 span 行之间」。
    // 事件是**所属 span 的子节点**（`order` 里 `t:'ev'` 与 `t:'span'` 交替）⇒ 行序是
    // 「span 行 → 它自己的子行们…」。我第一版把 `mid` 挂成 m1 的**兄弟**、以为它会夹在
    // 两个事件行之间，实测红了—— 那是我把「混排」读成了跨 span 交错。改挂成 m1 的**子**后即绿。
    //
    // 真正要钉的是：**同一个 span 的两个事件之间，能不能插进它的子 span**。
    // 拍平成「先全部事件、再全部子 span」的后果：用户看到「先输入、后进 capability」，
    // 因果倒置（工具输入在 t=2、capability 在 t=2.5）。
    const { root } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 100,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'llm.turn',
          name: 'm1',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 20,
          events: [
            { time: 2, name: 'tool.input', body: { tool: 'echo', input: { a: 1 } } },
            { time: 9, name: 'tool.output', body: { tool: 'echo', ok: true, content: 'done' } },
          ],
        }),
        // m1 的子 span，在 t=2.5 触发 ⇒ 应夹在 input(2) 与 output(9) 之间
        span({
          spanId: 's2',
          kind: 'capability',
          name: 'mid',
          parentSpanId: 's1',
          startedAt: 2.5,
          endedAt: 5,
        }),
      ],
    });

    // 行序：根 → m1 → input事件 → mid → output事件（5 行）
    const seq = rowsOf(root).map((r) => {
      const cn = r.className || '';
      if (cn.includes('tr-errm')) return 'err';
      if (cn.includes('tr-ev')) return cellOf(r, 'tr-evtype')?.textContent ?? 'ev';
      return 'span:' + nameOf(r);
    });
    assert.deepEqual(
      seq,
      ['span:run · demo', 'span:m1', 'tool.input', 'span:mid', 'tool.output'],
      `事件与子 span 必须按发生顺序混排（实际：${JSON.stringify(seq)}）`,
    );
  });
});

describe('错误行的渲染（renderTrace 里注释最密的一块）', () => {
  it('失败 span：行标 error、meta 带error.type、且**原文单独起一行**', () => {
    // 为什么「原文单独起行」要钉：注释写着「失败原文必须**看得见** —— 只塞进 title
    // （hover 才显）等于没显示。首次运行最常见的失败（没配 API key）就靠这一行定位。
    // ⇒ 哪天有人省掉那行、或改回 title，两条断言都发现不了。
    const { root } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'error',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 100,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'capability',
          name: 'search',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 5,
          status: 'error',
          error: { type: 'ToolError', message: '未配置 ANTHROPIC_API_KEY', retryable: false },
        }),
      ],
    });

    const rows = spanRows(root);
    const fail = rows.find((r) => nameOf(r) === 'search');
    assert.ok(fail, '失败的 span 必须有一行');
    assert.match(fail.className, /error/, '失败行要带 error 类');
    assert.equal(dotOf(fail), '✕', '失败态是 ✕（与在飞的 ◌、正常的 ● 区分）');
    assert.match(
      metaOf(fail),
      /ToolError/,
      `meta 要带 error.type（实际：${JSON.stringify(metaOf(fail))}）`,
    );

    // 原文**单独一行**，不是塞进 title
    const errs = errRows(root);
    assert.equal(errs.length, 1, `失败原文必须单独起一行（实际 ${errs.length} 行）`);
    const msg = cellOf(errs[0], 'tr-errm-msg');
    assert.ok(msg, '原文行的消息格存在');
    assert.equal(msg.textContent, '未配置 ANTHROPIC_API_KEY', '原文逐字，不能被截断或改写');
  });

  it('run 根失败时根行也标红（不是只有子 span 标）', () => {
    // 注释原文：「run 失败时根 span 也要标红：原先 status 恒为 ok，错误只体现在子 span 上」
    // —— 这条是**已修过的缺陷**，钉住它不许回退。
    //
    // ⚠️ fixture 的 status 要写在**根 span 自己**上，不是 trace 顶层：渲染器的状态全部
    // 来自 `span.status`（`fromTrace.js` 的 `view.finish(root.ms, root.status, root.error)`
    // 读的是根 span 那个字段）。trace 顶层的 `status` 在本渲染器里**不参与渲染**。
    // 我第一版只把它写在顶层 ⇒ 根行显示正常的 ●，断言红了 —— 那是fixture 写错，不是代码。
    // （框架产出的 trace 里两者一致，所以真实数据下看不出差别；但守卫要写明读的是哪个。）
    const { root } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'error',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 10,
          parentSpanId: null,
          status: 'error',
          error: { type: 'RunError', message: '根挂了' },
        }),
      ],
    });
    const runRow = spanRows(root)[0];
    assert.match(runRow.className, /error/, 'run 根失败时根行也要标 error');
    assert.equal(dotOf(runRow), '✕');
    assert.match(metaOf(runRow), /RunError/, '根行的meta 要带 error.type');
    const errs = errRows(root);
    assert.equal(errs.length, 1, '根的失败原文也单独起一行');
    assert.equal(cellOf(errs[0], 'tr-errm-msg').textContent, '根挂了');
  });

  it('正常 span **不加** error 类（判据的反面：别把三态塌成两态）', () => {
    // 为什么要这条：若有人写 `className += node.status === 'ok' ? '' : ' error'`，
    // 「在飞」（status undefined）会被误标成错误 ⇒ 一次正常调试满屏红。
    const { root } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 10,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'capability',
          name: 'ok-cap',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 3,
        }),
      ],
    });
    const ok = spanRows(root).find((r) => nameOf(r) === 'ok-cap');
    assert.doesNotMatch(ok.className, /error/, '正常的span 不该带 error 类');
    assert.equal(dotOf(ok), '●', '已完成是 ●');
  });
});

describe('usage 汇总（最容易错算的地方）', () => {
  it('**只累加 llm.turn**：capability span 的 usage 不重复计入', () => {
    // 注释原文：「计数器只累加 llm.turn（capability span 的 usage 是子 span 聚合，
    // 重复计入会双算）」—— 双算的后果是「这一轮花了多少」直接翻倍，且**页面上看不出异常**
    // （数字依然像个合理的 token 数），是本仓最忌讳的那类静默错。
    const { view } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 100,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'llm.turn',
          name: 'm1',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 20,
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2 },
        }),
        // 这个 capability 的 usage 是它内部子 span 的聚合（= 上面那个 turn）
        span({
          spanId: 's2',
          kind: 'capability',
          name: 'subagent',
          parentSpanId: 's0',
          startedAt: 2,
          endedAt: 18,
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2 },
        }),
      ],
    });
    const u = view.usage;
    assert.equal(u.input, 100, `input 只算 turn 那一层（实际 ${u.input}，双算会是 200）`);
    assert.equal(u.output, 10);
    assert.equal(u.cacheRead, 5, 'cache 读也要只算一次');
    assert.equal(u.cacheCreation, 2, 'cache 写也要只算一次');
  });

  it('两个 turn ⇒ 累加成两倍（证明上条不是「压根不累加」）', () => {
    // 与上条**成对**：只钉「不双算」的话，把累加整个删掉也能绿。
    const { view } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 100,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'llm.turn',
          name: 'm1',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 10,
          usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
        span({
          spanId: 's2',
          kind: 'llm.turn',
          name: 'm2',
          parentSpanId: 's0',
          startedAt: 11,
          endedAt: 20,
          usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
      ],
    });
    assert.equal(view.usage.input, 30, '两个 turn 累加');
    assert.equal(view.usage.output, 3);
  });

  it('span 行上的 tok 读数用**本 span 自己的** usage（不是全局累加值）', () => {
    // 判据错的后果：每行都显示同一份总数⇒ 多回合的树里所有行数字相同，调试时毫无信息量。
    const { root } = mount({
      traceId: 't',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: 100,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'llm.turn',
          name: 'm1',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 10,
          usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
        span({
          spanId: 's2',
          kind: 'llm.turn',
          name: 'm2',
          parentSpanId: 's0',
          startedAt: 11,
          endedAt: 20,
          usage: { inputTokens: 33, outputTokens: 44, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
      ],
    });
    const r1 = spanRows(root).find((r) => nameOf(r) === 'm1');
    const r2 = spanRows(root).find((r) => nameOf(r) === 'm2');
    assert.match(
      metaOf(r1),
      /33 tok/,
      `m1 本行应显示自己那份 11+22（实际 ${JSON.stringify(metaOf(r1))}）`,
    );
    assert.match(
      metaOf(r2),
      /77 tok/,
      `m2 本行应显示自己那份 33+44（实际 ${JSON.stringify(metaOf(r2))}）`,
    );
  });

  it('根未结束时**不收尾**（在飞的树不能显示成已完成）', () => {
    // fromTrace 注释：「根 span 还没结束 ⇒ 不收尾：finish() 会把根标成已完成（● + 耗时），
    // 而这棵树其实还在长 —— 在飞时看到「已完成」是假事实。」
    const root = makeNode();
    const view = createTraceView(root);
    playTrace(view, {
      traceId: 't',
      rootSpanId: 's0',
      status: 'ok',
      spans: [
        span({
          spanId: 's0',
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          endedAt: null,
          parentSpanId: null,
        }),
        span({
          spanId: 's1',
          kind: 'llm.turn',
          name: 'm1',
          parentSpanId: 's0',
          startedAt: 1,
          endedAt: 5,
          usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
      ],
    });
    const runRow = spanRows(root)[0];
    assert.equal(dotOf(runRow), '◌', '在飞的根是 ◌（不是 ●）');
    assert.match(runRow.className, /running/, '在飞行要带 running 类');
  });
});
