import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTraceView, fmtArg, rawArg } from '../src/view.js';
import { playTrace } from '../src/fromTrace.js';

/**
 * 行展开（.tr-open）的 DOM 级门禁。
 *
 * 这里跑的**不是**缩小版实现，而是真的 createTraceView + playTrace —— stub 只补了
 * `document.createElement` / `addEventListener`，所以断言的类名、`dataset`、文本
 * 都是线上那份渲染器的真实产物。
 *
 * 三件事必须钉住（缺一条都会让展开悄悄变成「假展开」）：
 *   1. **折叠态一字不变** —— 行内文本仍是摘要，等于加展开之前；
 *   2. **入参展开拿的是原文**，不是 `fmtArg` 那份 62 字符摘要（fromTrace 单独给了 `full`）；
 *   3. **展开态活在渲染之外** —— 每次事件都会全量重建 DOM，刚点开的行不能自己合上。
 *
 * ⚠️ 用法约定：**点击后必须重新取行**。渲染是全量重建，`click()` 之后旧的行对象已经
 * 不在树里了（它仍持有旧 handler）—— 抱着旧对象断言只会得到「展开没生效」的假失败。
 */

/** 极简 DOM stub：多补了 addEventListener / click，否则「点一下」根本无从断言 */
function makeNode() {
  const handlers = Object.create(null);
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
    addEventListener(type, fn) {
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(fn);
    },
    click() {
      for (const fn of handlers.click || []) fn({});
    },
    /** 该行是否挂了 click（未挂 = 不可展开） */
    get clickable() {
      return (handlers.click || []).length > 0;
    },
  };
}

const LONG_INPUT = { text: '甲'.repeat(200), other: '乙'.repeat(80) };
const LONG_OUTPUT = `${'丙'.repeat(4000)}END`;

/** run → llm.turn（一条长入参 + 一条长出参事件） */
function traceFixture() {
  return {
    traceId: 't1',
    rootSpanId: 's0',
    status: 'ok',
    totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: 's0',
        traceId: 't1',
        parentSpanId: null,
        kind: 'run',
        name: 'run · demo',
        startedAt: 0,
        endedAt: 100,
        status: 'ok',
        attributes: {},
        events: [],
      },
      {
        spanId: 's1',
        traceId: 't1',
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'deepseek-chat',
        startedAt: 10,
        endedAt: 40,
        status: 'ok',
        attributes: {},
        events: [
          { time: 20, name: 'tool.input', body: { tool: 'echo', input: LONG_INPUT } },
          { time: 30, name: 'tool.output', body: { tool: 'echo', ok: true, content: LONG_OUTPUT } },
        ],
      },
    ],
  };
}

const rowsOf = (root) => root.children;
const evRows = (root) => rowsOf(root).filter((r) => (r.className || '').includes('tr-ev'));
const ioOf = (row) => row.children.find((c) => c.className === 'tr-io');
const caretOf = (row) => row.children.find((c) => c.className === 'tr-caret');
const isOpen = (row) => (row.className || '').includes('tr-open');

/** 取第 i 行并点击它；返回**重建后**的行（点击会触发全量重建） */
function clickRow(root, i) {
  evRows(root)[i].click();
  return evRows(root)[i];
}

/** 建视图 + 灌一棵 fixture */
function mount() {
  const root = makeNode();
  const view = createTraceView(root);
  playTrace(view, traceFixture());
  return { root, view };
}

before(() => {
  globalThis.document = { createElement: () => makeNode() };
});
after(() => {
  delete globalThis.document;
  delete globalThis.getSelection;
});
// getSelection 默认不存在（Node 无 DOM）—— 每条用例自己决定要不要模拟选区
beforeEach(() => {
  delete globalThis.getSelection;
});

describe('trace 行展开（.tr-open）', () => {
  it('折叠态：行内文本是摘要、无 tr-open、caret 为 ▸ —— 与加展开之前一致', () => {
    const { root } = mount();
    const inRow = evRows(root)[0];
    const outRow = evRows(root)[1];
    assert.equal(fmtArg(LONG_INPUT).length, 62, '（前提）入参摘要是被砍过的');
    assert.equal(ioOf(inRow).textContent, fmtArg(LONG_INPUT), '折叠态仍是 fmtArg 摘要');
    assert.equal(ioOf(outRow).textContent, LONG_OUTPUT, '出参折叠态是 content 原文（靠 CSS 收敛）');
    assert.equal(isOpen(inRow), false);
    assert.equal(isOpen(outRow), false);
    assert.equal(caretOf(inRow).textContent, '▸');
    // 只有事件行可展开：run 根 / llm.turn 行没有 caret
    assert.equal(rowsOf(root).filter((r) => r.dataset.expandable).length, 2);
  });

  it('出参行的展开态是 CSS 状态（文本不变），行与 caret 一起切换', () => {
    const { root } = mount();
    assert.equal(evRows(root)[1].clickable, true, '可展开的行必须挂 click');

    let row = clickRow(root, 1);
    assert.equal(isOpen(row), true);
    assert.equal(caretOf(row).textContent, '▾');
    assert.equal(ioOf(row).textContent, LONG_OUTPUT, '文本不变 —— 换行由 .tr-open 的 CSS 负责');
    assert.equal(ioOf(row).title, '', '展开后撤掉占满整行的原生 tooltip');

    row = clickRow(root, 1);
    assert.equal(isOpen(row), false, '再点一次收起');
    assert.equal(ioOf(row).title, LONG_OUTPUT, '收起后 title 复原');
  });

  it('入参行展开拿到的是**原文**，不是 62 字符摘要（否则是假展开）', () => {
    const { root } = mount();
    const row = clickRow(root, 0);
    const shown = ioOf(row).textContent;
    assert.equal(shown, JSON.stringify(LONG_INPUT), '展开 = JSON 原文');
    assert.equal(shown.length > 62, true);
    assert.notEqual(shown, fmtArg(LONG_INPUT), '展开的不能还是那份摘要');
  });

  it('展开态活在渲染之外：下一条事件到来后，刚点开的行不会自己合上', () => {
    const { root, view } = mount();
    clickRow(root, 0);
    assert.equal(isOpen(evRows(root)[0]), true);

    // 全量重建（渲染器每次事件都重建整棵 DOM）
    view.event('s1', 'tool.input', 'echo', '另一个工具的入参', true);
    assert.equal(isOpen(evRows(root)[0]), true, '重建后展开的行必须仍然展开');
    assert.equal(
      ioOf(evRows(root)[0]).textContent,
      JSON.stringify(LONG_INPUT),
      '展开的还是原来那一行',
    );
    assert.equal(isOpen(evRows(root)[2]), false, '新来的行不该跟着展开');
  });

  it('正在选文本时点击不收起/展开（拖选到行外松手会补一次 click）', () => {
    const { root } = mount();
    assert.equal(isOpen(clickRow(root, 0)), true);

    globalThis.getSelection = () => '选中的文字';
    assert.equal(isOpen(clickRow(root, 0)), true, '选区非空时不得把行收起来');

    delete globalThis.getSelection;
    assert.equal(isOpen(clickRow(root, 0)), false, '没有选区时照常切换');
  });

  it('reset 之后重灌：新树不带上一棵树的展开态', () => {
    // 展开态存在渲染之外（Set），所以 reset 必须显式清 —— 否则既会「新树继承旧展开」
    // （键可能撞上），也会让 Set 随 run 无限增长。
    const { root, view } = mount();
    assert.equal(isOpen(clickRow(root, 0)), true);
    view.reset('run · 新的一棵');
    playTrace(view, traceFixture());
    assert.equal(
      evRows(root).some((r) => isOpen(r)),
      false,
    );
  });

  it('正文为空的事件行不可展开（不给 caret、不挂 click）', () => {
    const { root, view } = mount();
    view.event('s1', 'tool.output', 'echo', '', true, '');
    const blank = evRows(root).find((r) => ioOf(r).textContent === '');
    assert.ok(blank, '空正文事件行已渲染');
    assert.equal(blank.dataset.expandable, undefined, '空正文不该标可展开');
    assert.equal(caretOf(blank), undefined, '空正文不该有 caret');
    assert.equal(blank.clickable, false, '空正文不该挂 click');
  });
});

describe('入参的一对函数：fmtArg（折叠态摘要）与 rawArg（展开态原文）', () => {
  it('摘要被砍到 62 字符，原文是完整 JSON —— 两者不能是同一个东西', () => {
    const obj = {
      task: 'x'.repeat(30),
      focus: 'y'.repeat(30),
      area: 'z'.repeat(30),
      note: 'w'.repeat(30),
      extra: 1,
    };
    assert.equal(fmtArg(obj).length, 62, '（前提）摘要是被砍过的');
    assert.equal(rawArg(obj), JSON.stringify(obj), '原文 = JSON 完整序列化');
    assert.ok(rawArg(obj).length > 62);
    assert.notEqual(rawArg(obj), fmtArg(obj), '原文不能等于摘要，否则点开什么都没多出来');
  });

  it('边界口径：null/undefined → 空串，字符串原样，不可序列化回落 String()', () => {
    assert.equal(rawArg(null), '');
    assert.equal(rawArg(undefined), '');
    assert.equal(rawArg('本来就是一段文本'), '本来就是一段文本');
    const circular = {};
    circular.self = circular;
    assert.equal(rawArg(circular), '[object Object]');
  });
});
