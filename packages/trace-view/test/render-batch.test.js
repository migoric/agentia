/**
 * 2026-11-13 三件事的落地守卫：**批量渲染 / span 属性 / 时间轴 / 树内检索**。
 *
 * 为什么单独一个文件：这四条都不是「画得好看」而是**事实与性能**——
 *   1. 批量渲染：此前每个动作都整树重建，600 span 触发 1801 次（假 DOM 172ms）⇒ 长跑卡死；
 *   2. 属性：`model` / `retry.attempt` / `tools.names` 全在 attributes 里，树上一格不显示
 *      ⇒「这次是不是提示词版本没换」只能靠猜；
 *   3. 时间轴：每个 span 的起止本来就在数据里，没有它就看不出「8 秒被谁吃掉」；
 *   4. 检索：几十上百个 span，没有高亮 + 跳转只能肉眼扫。
 *
 * 每条都做过反向变异（把实现改坏后这里必须红）：
 *   - 去掉 `batch` 的挂起（让 `renderTrace` 直接画）⇒ 次数断言红；
 *   - 不给 `start` 传 attributes ⇒ 属性用例红；
 *   - 时间轴不传 startedAt ⇒ 轨道断言红；
 *   - `nextHit` 不夹下标（不取模）⇒ 环绕断言红。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTraceView } from '../src/view.js';
import { playTrace } from '../src/fromTrace.js';

/** 极简 DOM stub：比 view.test.js 多两件 —— `style`（时间轴几何）与 `querySelectorAll`（检索） */
function makeNode() {
  const handlers = Object.create(null);
  const node = {
    className: '',
    textContent: '',
    title: '',
    dataset: {},
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
    addEventListener(type, fn) {
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(fn);
    },
    click() {
      for (const fn of handlers.click || []) fn({});
    },
    scrollIntoView() {
      this.scrolled = (this.scrolled || 0) + 1;
    },
    /** 只支持 `.cls` 这一种选择器 —— 渲染器只用这一种，多写就是假实现 */
    querySelectorAll(sel) {
      const want = String(sel).replace(/^\./, '');
      const out = [];
      walk(node, (n) => {
        if (
          want &&
          String(n.className || '')
            .split(/\s+/)
            .includes(want)
        )
          out.push(n);
      });
      return out;
    },
  };
  return node;
}

function walk(n, fn) {
  fn(n);
  for (const c of n.children || []) walk(c, fn);
}

const allNodes = (root) => {
  const out = [];
  walk(root, (n) => out.push(n));
  return out;
};

const textOf = (n) =>
  allNodes(n)
    .map((x) => x.textContent || '')
    .join(' ');
const rowOf = (root, kind) => allNodes(root).find((n) => n.dataset && n.dataset.kind === kind);
const barOf = (root) => allNodes(root).find((n) => n.className === 'tr-tl-bar');

/**
 * 计数版根节点：`innerHTML = ''` 就是一次全量重画（渲染器每画一次都会先清空）。
 * 这个计数是**唯一**能证明「N 次动作 → 1 次重建」的证据 —— 断言 DOM 长得对不出来的。
 */
function makeCountedRoot() {
  const node = makeNode();
  const state = { clears: 0 };
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set: (v) => {
      if (v === '') {
        state.clears += 1;
        node.children = [];
      }
    },
  });
  return { node, state };
}

/** n 个 llm.turn 串在 run 根下；每个 turn 带一条 tool.input 事件 */
function traceFixture(n, opts = {}) {
  const t0 = 1000;
  const spans = [
    {
      spanId: 'run1',
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: t0,
      endedAt: t0 + n * 10,
      status: 'ok',
      attributes: { model: 'claude-x', 'session.id': 'dev', 'retry.attempt': 2 },
      events: [],
    },
  ];
  for (let i = 0; i < n; i += 1) {
    spans.push({
      spanId: `s${i}`,
      parentSpanId: 'run1',
      kind: 'llm.turn',
      name: 'claude-x',
      startedAt: t0 + i * 10,
      endedAt: t0 + i * 10 + 8,
      status: 'ok',
      attributes: opts.attrs ? { 'gen_ai.request.model': 'claude-x' } : {},
      events: [{ name: 'tool.input', time: t0 + i * 10, body: { tool: 'echo', input: { i } } }],
    });
  }
  return { traceId: 'trace-1', spans };
}

before(() => {
  globalThis.document = { createElement: () => makeNode() };
});
after(() => {
  delete globalThis.document;
  delete globalThis.getSelection;
});

describe('批量渲染：N 次动作压成 1 次重建', () => {
  it('playTrace 对一棵 50 span 的树**只重画 1 次**（此前是 151 次）', () => {
    const { node, state } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(50));
    assert.equal(state.clears, 1, '整次回放只能触发一次全量重建 —— 否则 playTrace 就是 O(N²)');
  });

  it('逐条喂（宿主自己批量时）仍然每条各画一次 —— 批量是**显式**的，不是全局延迟', () => {
    const { node, state } = makeCountedRoot();
    const view = createTraceView(node);
    view.reset('run · x', 'run1', 1000);
    const afterReset = state.clears;
    view.start({ id: 'a', parent: 'root', kind: 'tool', name: 't', startedAt: 1000 });
    view.event('a', 'tool.output', 't', 'ok', true, 'ok');
    assert.equal(state.clears, afterReset + 2, '没在批里 ⇒ 每个动作各画一次');
  });

  it('`batch(fn)` 内抛错也要把这一批画出来（否则整棵树停在中间状态）', () => {
    const { node, state } = makeCountedRoot();
    const view = createTraceView(node);
    view.reset('run · x', 'run1', 1000);
    const before = state.clears;
    assert.throws(() =>
      view.batch(() => {
        view.start({ id: 'a', parent: 'root', kind: 'tool', name: 't', startedAt: 1000 });
        throw new Error('boom');
      }),
    );
    assert.equal(state.clears, before + 1, '异常路径之后必须补画一次');
    assert.ok(rowOf(node, 'tool'), '批里的动作不该因为抛错而丢掉');
  });

  it('空的批不白画（没标脏就不重建）', () => {
    const { node, state } = makeCountedRoot();
    const view = createTraceView(node);
    view.reset('run · x', 'run1', 1000);
    const before = state.clears;
    view.batch(() => {});
    assert.equal(state.clears, before);
  });
});

describe('span 属性（2026-11-13）', () => {
  it('有属性的 span 行可展开，展开后出现属性块（值可读）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(2, { attrs: true }));

    const row = rowOf(node, 'llm.turn');
    assert.equal(row.dataset.expandable, '1', '有 attributes 的行必须能展开（否则属性永远看不到）');
    row.click();

    const again = rowOf(node, 'llm.turn');
    const box = allNodes(node).find((n) => String(n.className).includes('tr-full'));
    assert.ok(box, '展开后必须挂一个结构化块（复用 full-view.js，不另写一套）');
    assert.match(textOf(box), /gen_ai\.request\.model/, '块里要出现属性键');
    assert.match(textOf(box), /claude-x/, '块里要出现属性值');
    assert.equal(
      String(again.className).includes('tr-open'),
      false,
      'span 行不换行（属性在兄弟块里）',
    );
  });

  it('根 span 的属性也能展开 —— `model` / `system.version` / `tools.names` 只写在根上', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(2));

    // 根行由 `reset` 建、**不走** `start()`，所以属性得单独递一路 —— 这是最容易漏的一格
    const root = rowOf(node, 'run');
    assert.equal(
      root.dataset.expandable,
      '1',
      '根行有 attributes ⇒ 必须能展开，否则这些键永远看不到',
    );
    root.click();

    const box = allNodes(node).find((n) => String(n.className).includes('tr-full'));
    assert.ok(box, '根行展开后同样走完整块');
    assert.match(textOf(box), /session\.id/, '根上的属性要出现');
    assert.match(textOf(box), /dev/);
  });

  it('根没有属性时不挂空块（reset 的第 4 个参数缺省）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    view.reset('run · x', 'root');
    assert.equal(rowOf(node, 'run').dataset.expandable, undefined);
  });

  it('没有属性的 span 行不可展开（挂一个空块比不挂更糟）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(2));
    assert.equal(rowOf(node, 'llm.turn').dataset.expandable, undefined);
  });

  it('属性展开态活在渲染之外：下一条事件到达后不会自己合上', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(2, { attrs: true }));
    rowOf(node, 'llm.turn').click();
    assert.ok(allNodes(node).some((n) => String(n.className).includes('tr-full')));

    view.event('s0', 'tool.output', 'echo', 'done', true, 'done');
    assert.ok(
      allNodes(node).some((n) => String(n.className).includes('tr-full')),
      '重建后属性块仍要在（状态存在 folds 里，不在 DOM 里）',
    );
  });
});

describe('时间轴（2026-11-13）', () => {
  it('每个子 span 一条轨道，几何按 run 总时长归一化（不是每行占满）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(4));

    const tlRows = allNodes(node).filter((n) => n.dataset && n.dataset.tl === '1');
    assert.equal(tlRows.length, 4, '4 个子 span 各一条（根不画：它恒占满全宽）');

    const bar = barOf(node);
    assert.match(bar.style.cssText, /^left:0\.00%;width:20\.00%/, '第一个 span：起点 0、时长 8/40');
  });

  it('没有时间戳的 trace 不画轨道（画一条人人占满的条比不画更误导）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, {
      traceId: 'no-time',
      spans: [
        {
          spanId: 'r',
          parentSpanId: null,
          kind: 'run',
          name: 'run',
          status: 'ok',
          attributes: {},
          events: [],
        },
      ],
    });
    assert.equal(allNodes(node).filter((n) => n.dataset?.tl).length, 0);
  });

  it('失败 span 的条走告警色（靠行的 error 类，不是另写一套几何）', () => {
    const trace = traceFixture(2);
    trace.spans[1].status = 'error';
    trace.spans[1].error = { type: 'http', message: 'boom' };
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, trace);
    const row = allNodes(node).find((n) => String(n.className).includes('tr-row error'));
    assert.ok(row, '前提：失败行带 error 类');
    assert.ok(
      allNodes(row).some((n) => n.className === 'tr-tl-bar'),
      '条在失败行内 —— 颜色由 .tr-row.error 的 CSS 决定',
    );
  });
});

describe('树内检索：只高亮 + 跳转，不改结构', () => {
  it('setQuery 命中数 = 匹配行数；不裁剪节点（行数不变）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(3));
    const rowsBefore = allNodes(node).filter((n) => String(n.className).includes('tr-row')).length;

    const hits = view.setQuery('i: 1');
    assert.equal(hits, 1, '只有 `{ i: 1 }` 那一条事件命中');
    const rowsAfter = allNodes(node).filter((n) => String(n.className).includes('tr-row')).length;
    assert.equal(rowsAfter, rowsBefore, '检索不裁剪 —— 树形是「谁挂在谁下面」的事实');
  });

  it('nextHit 顺序推进并环绕；返回 1 基序号', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(3));
    assert.equal(view.setQuery('claude-x'), 3, '三条 llm.turn 的名字都命中');

    assert.equal(view.nextHit(1), 1);
    assert.equal(view.nextHit(1), 2);
    assert.equal(view.nextHit(1), 3);
    assert.equal(view.nextHit(1), 1, '到底后绕回第一处（按不动了才不符合预期）');
    assert.equal(view.nextHit(-1), 3, '向上同理');
  });

  it('清空查询后命中归零、高亮消失', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(2));
    view.setQuery('claude-x');
    assert.equal(view.setQuery(''), 0);
    assert.equal(node.querySelectorAll('.tr-hit').length, 0);
  });

  it('当前跳到的那一处有独立标记（连按 Enter 时不迷路）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    playTrace(view, traceFixture(3));
    view.setQuery('claude-x');
    view.nextHit(1);
    assert.equal(node.querySelectorAll('.tr-hit-cur').length, 1, '只能有一处是「当前」');
  });
});

/**
 * 全量重画会把**属于这棵树、不属于这一次渲染**的状态一起清掉：展开态、检索位置、滚动位置。
 * 在飞时 `playTrace` 每帧被调一次（SSE 增量）⇒ 这三样每 16ms 归零一次。
 *
 * 这些失败态的共同点是「页面看着能动」：树照样画出来、命中数照样对，只是用户刚做的操作
 * 无声撤销 —— 所以只能靠这组断言咬住。
 */
describe('重画不吃视图状态（在飞时每帧重画）', () => {
  const openRows = (node) => allNodes(node).filter((n) => String(n.className).includes('tr-open'));

  it('同一棵树再回放一次，展开态保留', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    const t = traceFixture(3);
    playTrace(view, t);
    const row = allNodes(node).find(
      (n) => n.dataset && n.dataset.expandable === '1' && String(n.className).includes('tr-ev'), // 事件行（span 行的 attributes 块是另一套标记）
    );
    assert.ok(row, '前提：有可展开的事件行');
    row.click();
    assert.equal(openRows(node).length, 1, '展开生效');

    playTrace(view, t); // 在飞的下一帧
    assert.equal(
      openRows(node).length,
      1,
      '同一 rootId 重画后仍展开 —— 否则用户每展开一个节点，下一帧就自己合上',
    );
  });

  it('换一条 run 才回顶部（同一棵树的重画保留滚动位置）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    const t = traceFixture(3);
    playTrace(view, t);
    node.scrollTop = 200;
    playTrace(view, t);
    assert.equal(node.scrollTop, 200, '同一棵树重画要搬回滚动位置');

    view.reset('run · b', 'run2', 1000);
    assert.equal(node.scrollTop, 0, '换 run 回顶部 —— 新树从头读');
  });

  it('重画后 nextHit 接着上次的位置（序号不跳回第一处）', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    const t = traceFixture(3);
    playTrace(view, t);
    assert.equal(view.setQuery('claude-x'), 3);
    assert.equal(view.nextHit(1), 1);
    assert.equal(view.nextHit(1), 2);

    playTrace(view, t);
    assert.equal(view.nextHit(1), 3, '重画不能把序号打回 1（那正是「检索序号跳回」）');
  });

  it('重画后「当前命中」的标记还在', () => {
    const { node } = makeCountedRoot();
    const view = createTraceView(node);
    const t = traceFixture(3);
    playTrace(view, t);
    view.setQuery('claude-x');
    view.nextHit(1);

    playTrace(view, t);
    assert.equal(
      node.querySelectorAll('.tr-hit-cur').length,
      1,
      '行是重建出来的，标记必须一起补回去 —— 否则序号还在、视觉上「第几处」没了',
    );
  });
});
