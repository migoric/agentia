import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFullView, hasStructuredBody } from '../src/full-view.js';
import { createTraceView } from '../src/view.js';
import { playTrace } from '../src/fromTrace.js';

/**
 * 结构化展开正文（`.tr-full`）的门禁 —— 2026-11-11。
 *
 * 钉的是「**展开不再是一大坨无缩进的 JSON**」这件事本身，分两层：
 *   1. 渲染件：任意值 → 有缩进 / 有着色的行，且**截断必须说出来**（静默截断比糊成一坨更坏：
 *      会让人以为工具就返回了这么点东西）；
 *   2. 接线：`full` 是对象/数组时挂块并隐藏 `.tr-io`；是字符串时**不挂**（纯文本正文继续
 *      走老路，`test/style.test.js` 的两个 CSS 不变量靠那条路活着）。
 *
 * ⚠️ 第二层是这次改动最容易悄悄退化的地方：把 `fromTrace.eventFull` 改回返回字符串，
 * 第一层照样全绿、页面也不报错，只是用户又看到一坨 JSON。所以必须在**真实 playTrace** 上验。
 */

/** 与 view.test.js 同款的最小 DOM stub（多补了 dataset / 递归取文本） */
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
    get clickable() {
      return (handlers.click || []).length > 0;
    },
  };
}

/** 递归拼出节点下的全部文本（stub 里 textContent 与 children 是各自独立的字段） */
function textOf(node) {
  let s = node.textContent || '';
  for (const c of node.children || []) s += textOf(c);
  return s;
}

/** 按类名找后代（stub 没有 querySelector） */
function allByClass(node, cls, out = []) {
  if ((node.className || '').split(' ').includes(cls)) out.push(node);
  for (const c of node.children || []) allByClass(c, cls, out);
  return out;
}

/** 所有可折叠的行（`data-fold` = 该容器的路径） */
const foldRows = (box) => allByClass(box, 'tr-full-line').filter((n) => n.dataset?.fold);

/** 把块里所有折叠的容器点开。⚠️ 每次点击都会重画正文（节点全部换新），所以每轮必须重新查询 */
function expandAll(box) {
  for (let i = 0; i < 20; i++) {
    const closed = foldRows(box).filter((n) => textOf(n).includes('▸'));
    if (!closed.length) return;
    closed[0].click();
  }
}

before(() => {
  globalThis.document = { createElement: () => makeNode() };
});
after(() => {
  delete globalThis.document;
  delete globalThis.navigator;
});
beforeEach(() => {
  delete globalThis.navigator;
});

describe('full-view：任意值 → 有层级的行', () => {
  it('对象：一个键一行，键名与值分开；嵌套值在下一层缩进', () => {
    const box = createFullView({ query: 'agentia', limit: 5, nested: { a: 1 } });
    const keys = allByClass(box, 'tr-full-key').map((n) => n.textContent);
    assert.deepEqual(keys, ['query:', 'limit:', 'nested:', 'a:'], '键名逐层出现，父键单独一行');
    // 嵌套那一行的缩进比父层多两个空格
    const lines = allByClass(box, 'tr-full-line');
    const indentOf = (n) => {
      const i = n.children.find((c) => (c.className || '') === 'tr-full-indent');
      return i ? i.textContent.length : 0;
    };
    const nestedKeyLine = lines.find((l) => textOf(l).includes('nested:'));
    const leaf = lines.find((l) => textOf(l).includes('a:'));
    assert.equal(indentOf(nestedKeyLine), 0);
    assert.equal(indentOf(leaf), 2, '子项缩进一层（2 空格）');
  });

  it('数组用 [i] 标位置，元素按顺序铺开', () => {
    const box = createFullView(['x', 'y']);
    const keys = allByClass(box, 'tr-full-key').map((n) => n.textContent);
    assert.deepEqual(keys, ['[0]', '[1]']);
  });

  it('值的类型分得开：字符串带引号、数字与布尔各自成色', () => {
    const box = createFullView({ s: 'hi', n: 42, b: true, z: null });
    assert.equal(allByClass(box, 'tr-full-str').length, 1);
    assert.equal(allByClass(box, 'tr-full-num').length, 1);
    assert.equal(allByClass(box, 'tr-full-bool').length, 1);
    assert.equal(allByClass(box, 'tr-full-null').length, 1);
    assert.ok(
      textOf(allByClass(box, 'tr-full-str')[0]).includes('"hi"'),
      '字符串带引号才看得出类型',
    );
  });

  it('长字符串截断，但**说出还剩多少**（静默截断会让人以为工具就返回了这么点）', () => {
    const long = '甲'.repeat(400);
    const box = createFullView({ text: long });
    const s = textOf(box);
    assert.ok(s.includes('还有 160 字符'), `截断说明缺失：${s.slice(0, 120)}`);
    assert.ok(!s.includes('甲'.repeat(400)), '不该把 400 字符全铺出来');
  });

  it('集合超量：只铺前 40 项并说明还剩多少', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    const s = textOf(createFullView(many));
    assert.ok(s.includes('还有 20 项未展开'), s.slice(-120));
  });

  it('深层容器压成一行，但标明它是个容器（不伪装成标量）', () => {
    // 造 8 层嵌套，超过 MAX_DEPTH(6)。默认只铺两层，所以先逐层点开才走得到压平那一档
    let deep = { v: 1 };
    for (let i = 0; i < 8; i++) deep = { child: deep };
    const box = createFullView(deep);
    expandAll(box);
    const s = textOf(box);
    assert.ok(s.includes('<object · 1 项>'), '压平时要保留「它是个容器」这个事实');
  });

  it('循环引用不抛（调试面板不该因为一条坏数据白屏）', () => {
    const cyc = { name: 'x' };
    cyc.self = cyc;
    assert.doesNotThrow(() => createFullView(cyc));
  });

  it('头部写明类型与规模', () => {
    const box = createFullView({ a: 1, b: 2 });
    assert.equal(allByClass(box, 'tr-full-type')[0].textContent, 'object · 2 项');
    const arr = createFullView([1, 2, 3]);
    assert.equal(allByClass(arr, 'tr-full-type')[0].textContent, 'array · 3 项');
  });

  it('没有剪贴板实现时，点「复制」不谎报成功', () => {
    const box = createFullView({ a: 1 });
    const copy = allByClass(box, 'tr-full-copy')[0];
    assert.equal(copy.clickable, true, '按钮仍可点（只是什么都不做）');
    copy.click();
    assert.equal(copy.textContent, '复制', '不能把没做到的事显示成「已复制」');
  });
});

describe('full-view 第二档：折叠 / 成表 / 路径（2026-11-11 晚）', () => {
  it('默认只铺两层：第三层的容器折成 { object · N 项 }，点一下才铺开', () => {
    const box = createFullView({ l1: { l2: { l3: { deep: 1 } } } });
    assert.ok(textOf(box).includes('{ object · 1 项 }'), textOf(box).slice(0, 200));
    assert.ok(!textOf(box).includes('deep:'), '第三层不该在首屏就铺开（那正是"一坨"的来源）');

    const closed = foldRows(box).find((r) => textOf(r).includes('▸'));
    assert.ok(closed, '折叠的容器必须带 ▸（否则没人知道它能点）');
    closed.click();
    assert.ok(textOf(box).includes('deep:'), '点开后子键出现');
  });

  it('折叠状态由调用方持有：拿同一份 fold 重建，折叠不会自己弹开', () => {
    // 这条是这次改动最容易退化的地方：块每次渲染都是新的，
    // 状态若放在块里 ⇒ 实时 run 里刚折起来的容器，下一条事件到达就弹开了。
    const fold = new Map();
    const value = { a: { x: { y: 1 } } };
    const box = createFullView(value, { fold });
    foldRows(box)
      .find((r) => textOf(r).includes('a:'))
      .click();
    assert.ok(!textOf(box).includes('x:'), '点一下应折起 a');

    const again = createFullView(value, { fold });
    assert.ok(!textOf(again).includes('x:'), '重建后必须延续折叠（状态活在渲染之外）');
  });

  it('同构对象数组 → 表格：表头是列名，每行一条记录（键名不再逐元素重复）', () => {
    const box = createFullView({
      rows: [
        { n: 'a', v: 1 },
        { n: 'b', v: 2 },
      ],
    });
    assert.equal(allByClass(box, 'tr-full-table').length, 1);
    assert.deepEqual(
      allByClass(box, 'tr-full-col').map((n) => n.textContent),
      ['n', 'v'],
      '表头 = 列名，且只出现一次',
    );
    // 树形的逐元素键名（`n:` / `v:`）在表里不该再出现，只剩数组自己的那个键
    assert.deepEqual(
      allByClass(box, 'tr-full-key').map((n) => n.textContent),
      ['rows:'],
    );
  });

  it('不成表就回落树形（表格里没法逐层展开，判错一次就是丢数据）', () => {
    const tableCount = (v) => allByClass(createFullView(v), 'tr-full-table').length;
    assert.equal(tableCount([{ a: 1 }, { b: 2 }]), 0, '键集不一致（缺键那条）');
    // 超集：第二行多一个键。只查"表头那几列在不在"是挡不住的 —— 多的那列会被**静默丢掉**，
    // 所以判据必须是"键数完全相等"（这条用例就是为它写的，2026-11-11 晚的反向验证发现的洞）
    assert.equal(
      tableCount([
        { a: 1, b: 2 },
        { a: 1, b: 2, c: 3 },
      ]),
      0,
      '键集不一致（超集那条）',
    );
    assert.equal(tableCount([{ a: { b: 1 } }, { a: { b: 2 } }]), 0, '有嵌套值（表格里展不开）');
    assert.equal(tableCount([{ a: 1 }]), 0, '只有一行不值得成表');
    const wide = Array.from({ length: 2 }, () =>
      Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`c${i}`, i])),
    );
    assert.equal(tableCount(wide), 0, '超过 6 列横向没法看');
  });

  it('表头路径带 [*]（它是一整列），叶子路径带真实下标', () => {
    const box = createFullView({
      rows: [
        { n: 'a', v: 1 },
        { n: 'b', v: 2 },
      ],
    });
    const titles = allByClass(box, 'tr-full-path').map((n) => n.title);
    assert.ok(
      titles.includes('复制路径 rows[*].n') && titles.includes('复制路径 rows[*].v'),
      `表头路径要带 [*]：${titles.join(' / ')}`,
    );

    const tree = createFullView({ a: [{ n: 'x' }] }); // 单元素 → 不成表，回落树形
    const leaf = allByClass(tree, 'tr-full-path').map((n) => n.title);
    assert.ok(leaf.includes('复制路径 a[0].n'), leaf.join(' / '));
  });

  it('点 ⧉ 写剪贴板并回声「已复制」；没有剪贴板则保持原样（不谎报）', async () => {
    const wrote = [];
    globalThis.navigator = {
      clipboard: {
        writeText(s) {
          wrote.push(s);
          return Promise.resolve();
        },
      },
    };
    const box = createFullView({ a: [{ n: 'x' }] });
    const btn = allByClass(box, 'tr-full-path').find((n) => n.title === '复制路径 a[0].n');
    btn.click();
    await Promise.resolve();
    assert.deepEqual(wrote, ['a[0].n'], '写进去的是路径本身，不是值');
    assert.equal(btn.textContent, '已复制');

    delete globalThis.navigator;
    const box2 = createFullView({ a: 1 });
    const btn2 = allByClass(box2, 'tr-full-path')[0];
    btn2.click();
    assert.equal(btn2.textContent, '⧉', '没有剪贴板实现时不许显示「已复制」');
  });
});

/** 一棵最小 trace：run → llm.turn（一条对象入参 + 一条字符串出参） */
function traceFixture() {
  return {
    traceId: 't1',
    rootSpanId: 's0',
    status: 'ok',
    spans: [
      {
        spanId: 's0',
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
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'deepseek-chat',
        startedAt: 10,
        endedAt: 40,
        status: 'ok',
        attributes: {},
        events: [
          { time: 20, name: 'tool.input', body: { tool: 'echo', input: { q: '甲'.repeat(200) } } },
          {
            time: 30,
            name: 'tool.output',
            body: { tool: 'echo', ok: true, content: '纯文本结果' },
          },
        ],
      },
    ],
  };
}

const evRows = (root) => root.children.filter((r) => (r.className || '').includes('tr-ev'));
const isOpen = (row) => (row.className || '').includes('tr-open');

/**
 * 字符串里套着的 JSON（2026-11-12）。
 *
 * 业务里「结构被序列化后塞回文本字段」是常态：`tool.output.content` 常是
 * `JSON.stringify(...)` 的结果、MCP 的 text block、SSE 的 `data:`。这些值的类型是**字符串**，
 * 此前只能显示成 `{\"a\":1` 的反斜杠汤 —— 比无缩进的 JSON 更难读。
 *
 * 这一组钉的**不是**「能解析就行」，而是三条容易被做丢的：
 *   1. **必须标出来**（`str→json`）—— 不标，读者会以为工具真的返回了对象，事实被改写；
 *   2. **判据是首尾字符，不是 parse 成功** —— `"123"`/`"null"`/`"true"` 都能 parse，
 *      显示成数字/null/布尔就是换了类型；
 *   3. **只解析一层** —— 一层套一层是真实现象，逐层展开会让 10KB 放大成十万个节点。
 */
describe('字符串里套着 JSON：按容器铺开，但如实标出它原本是字符串（2026-11-12）', () => {
  const badges = (box) => allByClass(box, 'tr-full-json');

  it('嵌套字符串（`content: "{\\"rows\\":[...]}"`）⇒ 铺成容器，行里打 str→json 标记', () => {
    const box = createFullView({ content: JSON.stringify({ rows: [{ f: 'a.ts' }] }) });
    const s = textOf(box);
    assert.ok(!s.includes('\\"rows\\"'), '不该再看到反斜杠汤');
    assert.ok(s.includes('rows:'), '内层键名要铺出来');
    assert.equal(badges(box).length, 1, '必须标出它原本是字符串');
  });

  it('根字符串（工具出参 content 就是 JSON）⇒ 铺开，且头部同时写出「原本是字符串」与解析后的规模', () => {
    const raw = JSON.stringify({ rows: [{ f: 'a.ts' }] });
    const box = createFullView(raw);
    const head = allByClass(box, 'tr-full-type')[0];
    assert.match(head.textContent, /^string · \d+ 字符 → object · 1 项$/, '两件事都要写出来');
    assert.ok(textOf(box).includes('rows:'), '正文按对象铺');
    assert.equal(badges(box).length, 1);
  });

  it('标记带说明：原文在哪、内部路径要先 parse（这两件最容易误会）', () => {
    const box = createFullView({ content: '[1,2]' });
    const badge = badges(box)[0];
    assert.match(badge.title, /字符串/);
    assert.match(badge.title, /JSON\.parse/);
  });

  it('判据是首尾字符：能 parse 成功的标量字符串一律不认（那会改写工具返回的事实）', () => {
    for (const s of ['123', 'null', 'true', ' 42 ', '0.5', '"x"']) {
      const box = createFullView({ v: s });
      assert.equal(badges(box).length, 0, `${s} 不该被当成 JSON`);
      assert.ok(textOf(box).includes(JSON.stringify(s)), `${s} 要按字符串原样显示`);
    }
  });

  it('首尾不吻合 / 解析失败 ⇒ 静默回落成原样字符串（普通文本占绝大多数）', () => {
    for (const s of ['{not json}', '[1,2', '{"a":1} 后面还有字', '{ }x', '']) {
      const box = createFullView({ v: s });
      assert.equal(badges(box).length, 0, `${JSON.stringify(s)} 不该被当成 JSON`);
      assert.ok(textOf(box).includes(JSON.stringify(s)), '原样显示，不吞不改');
    }
  });

  it('只解析一层：解析结果内部的字符串不再二次解析（防嵌套放大）', () => {
    const box = createFullView({ a: JSON.stringify({ nested: JSON.stringify({ deep: 1 }) }) });
    assert.ok(textOf(box).includes('nested:'), '第一层要铺开');
    assert.equal(badges(box).length, 1, '只有一个 str→json 标记');
    assert.ok(
      textOf(box).includes('\\"deep\\"'),
      '内层字符串保持原样 —— 逐层解析会把 10KB 放大成十万个节点',
    );
  });

  it('空容器字符串（"{}" / "[]"）也照原样标出来（否则「解析失败」与「里面真是空的」分不清）', () => {
    const box = createFullView({ a: '{}', b: '[]' });
    assert.equal(badges(box).length, 2);
    assert.ok(textOf(box).includes('{}'));
    assert.ok(textOf(box).includes('[]'));
  });

  it('普通文本连 parse 都不试（首尾字符先筛；绝大多数值走这条负路径）', () => {
    const real = JSON.parse;
    let calls = 0;
    JSON.parse = (s) => {
      calls++;
      return real(s);
    };
    try {
      createFullView({ a: '普通的说明文字', b: '123', c: 'null', d: 'a: b', e: '一段中文' });
      assert.equal(calls, 0, '看着不像 JSON 的字符串不该付反序列化成本');

      createFullView({ a: '{"k":1}' });
      assert.equal(calls, 1, '像 JSON 的才试一次（也只试一次）');
    } finally {
      JSON.parse = real;
    }
  });

  it('谓词与块内判据同源：能 parse 的标量字符串在 `hasStructuredBody` 里也是 false', () => {
    // ⚠️ 这条不是重复：渲染分支会把「123 被当成数字」悄悄盖住（叶子一律显示原字符串），
    // 真正会漏到用户面前的是**接线** —— 谓词说 true 就会给一条纯文本事件挂上结构化块。
    for (const s of ['123', 'null', 'true', '0.5', '"x"', '普通文本', '']) {
      assert.equal(hasStructuredBody(s), false, `${JSON.stringify(s)} 没有结构化正文`);
    }
    for (const v of ['{"a":1}', '[1]', '[]', {}, [], { a: 1 }]) {
      assert.equal(hasStructuredBody(v), true, `${JSON.stringify(v)} 有结构化正文`);
    }
  });

  it('超长字符串不尝试解析（100k 以上连 parse 都不做）', () => {
    const box = createFullView({ a: JSON.stringify({ pad: 'x'.repeat(120_000) }) });
    assert.equal(badges(box).length, 0);
  });

  it('表格单元格不解析（同构表已放弃逐层展开，单元格里放不下嵌套块）', () => {
    const box = createFullView({
      rows: [
        { k: '1', j: JSON.stringify({ z: 1 }) },
        { k: '2', j: JSON.stringify({ z: 2 }) },
      ],
    });
    assert.equal(allByClass(box, 'tr-full-table').length, 1, '仍然成表');
    assert.equal(badges(box).length, 0, '单元格里的 JSON 字符串保持原样');
  });

  it('解析出来的容器照样能折叠（标记不破坏折叠交互）', () => {
    const box = createFullView({ a: JSON.stringify({ x: 1, y: 2 }) }, { fold: new Map() });
    assert.ok(textOf(box).includes('x:'), '默认铺开');
    foldRows(box)
      .find((r) => r.dataset.fold === 'a')
      .click();
    assert.ok(!textOf(box).includes('x:'), '收起后子行消失');
    assert.equal(badges(box).length, 1, '收起态也要留着标记 —— 否则看不出这是个字符串');
  });

  it('根字符串的「复制」复制的是**原文**（拿到直接能喂 jq，而不是缩进后的重排）', async () => {
    const wrote = [];
    globalThis.navigator = {
      clipboard: {
        writeText(s) {
          wrote.push(s);
          return Promise.resolve();
        },
      },
    };
    const raw = '{"a":1,"b":[2,3]}';
    const box = createFullView(raw);
    allByClass(box, 'tr-full-copy')[0].click();
    await Promise.resolve();
    assert.deepEqual(wrote, [raw]);
  });
});

describe('接线：对象入参挂结构化块，字符串出参仍走老路', () => {
  it('对象入参展开 ⇒ 有 .tr-full 块、行标 tr-structured、.tr-io 仍持原文', () => {
    const root = makeNode();
    const view = createTraceView(root);
    playTrace(view, traceFixture());

    evRows(root)[0].click();
    const row = evRows(root)[0];
    assert.equal(isOpen(row), true);
    assert.ok(row.className.includes('tr-structured'), '行要标出来，CSS 才会隐藏 .tr-io');

    const block = root.children.find((r) => (r.className || '') === 'tr-full');
    assert.ok(block, '展开行之后必须有结构化块');
    assert.ok(textOf(block).includes('object · 1 项'), '块里是结构化内容');

    // 原文仍在 .tr-io 里（选中复制 / 既有断言都靠它）
    const io = row.children.find((c) => c.className === 'tr-io');
    assert.equal(io.textContent, JSON.stringify({ q: '甲'.repeat(200) }), '.tr-io 未被改成结构化');
  });

  it('字符串出参展开 ⇒ 不挂结构化块（纯文本那条路与它的 CSS 不变量保持原样）', () => {
    const root = makeNode();
    const view = createTraceView(root);
    playTrace(view, traceFixture());

    evRows(root)[1].click();
    const row = evRows(root)[1];
    assert.equal(isOpen(row), true);
    assert.ok(!row.className.includes('tr-structured'), '字符串正文不该被当成结构化');
    assert.equal(
      root.children.some((r) => (r.className || '') === 'tr-full'),
      false,
      '字符串正文不挂块',
    );
  });

  it('工具出参 content 是**装着 JSON 的字符串** ⇒ 照样挂块（此前是一串反斜杠汤）', () => {
    const root = makeNode();
    const view = createTraceView(root);
    const trace = traceFixture();
    const raw = JSON.stringify({ rows: [{ f: 'a.ts' }] });
    trace.spans[1].events[1].body.content = raw;
    playTrace(view, trace);

    evRows(root)[1].click();
    const row = evRows(root)[1];
    assert.ok(row.className.includes('tr-structured'), '装着 JSON 的字符串也要走结构化');
    const block = root.children.find((r) => (r.className || '') === 'tr-full');
    assert.ok(block, '展开行之后必须有结构化块');
    assert.ok(textOf(block).includes('rows:'), '按对象铺开');
    assert.ok(textOf(block).includes('str→json'), '并且标出它原本是字符串');

    // 原文仍在 .tr-io：复制出去的是工具真正返回的那个字符串，不是重排后的 JSON
    const io = row.children.find((c) => c.className === 'tr-io');
    assert.equal(io.textContent, raw);
  });

  it('出参是「看着像 JSON 的普通文本」（"123" / "null"）⇒ 仍走老路，不挂块', () => {
    for (const raw of ['123', 'null']) {
      const root = makeNode();
      const view = createTraceView(root);
      const trace = traceFixture();
      trace.spans[1].events[1].body.content = raw;
      playTrace(view, trace);

      evRows(root)[1].click();
      assert.ok(
        !evRows(root)[1].className.includes('tr-structured'),
        `${raw} 是字符串，不该被当成结构化正文（挂上块等于把类型换掉了）`,
      );
      assert.equal(
        root.children.some((r) => (r.className || '') === 'tr-full'),
        false,
        `${raw} 不该挂块`,
      );
    }
  });

  it('收起后结构化块消失（不留孤儿节点）', () => {
    const root = makeNode();
    const view = createTraceView(root);
    playTrace(view, traceFixture());

    evRows(root)[0].click();
    assert.equal(
      root.children.some((r) => (r.className || '') === 'tr-full'),
      true,
    );
    evRows(root)[0].click();
    assert.equal(
      root.children.some((r) => (r.className || '') === 'tr-full'),
      false,
      '收起必须把块一起清掉（渲染是全量重建，残留就是泄漏）',
    );
  });

  it('块内折叠跨「下一条事件」保持（状态活在 renderTrace 之外）', () => {
    const root = makeNode();
    const view = createTraceView(root);
    const trace = traceFixture();
    trace.spans[1].events[0].body.input = { q: 'x', meta: { mode: 'strict' } };
    playTrace(view, trace);

    evRows(root)[0].click();
    const block = () => root.children.find((r) => (r.className || '') === 'tr-full');
    foldRows(block())
      .find((r) => textOf(r).includes('meta:'))
      .click();
    assert.ok(!textOf(block()).includes('mode:'), '点一下应折起 meta');

    // 等价于「下一条事件到达」：渲染是 rootEl.innerHTML = '' 的全量重建
    view.render();
    assert.ok(
      !textOf(block()).includes('mode:'),
      '重建后仍折叠 —— 否则实时 run 里折起的容器会在下一条事件到达时自己弹开',
    );
  });
});

/**
 * 宿主注入的正文（Markdown）—— 2026-11-12 晚。
 *
 * 解析器只有一份（`packages/cli/src/markdown.ts`），而本包是**独立发布单元**、不能反向
 * 依赖 CLI ⇒ 走注入：宿主给 `textBody(text)`，返回元素就渲染、返回 null 就保持原文。
 * 这里不验 Markdown 的排版（那是 CLI 包的事），只验本包负责的四件事：
 * ① 注入的正文用上、且**不再铺树**（同一段内容两套呈现并存，比不渲染更糟）；
 * ② 头部写清「原本是字符串 + md」，复制取**原文**；
 * ③ `textBody` 只在**展开时**调用 —— 折叠态每条事件都会重画，挂那儿等于把历史正文白解析一遍；
 * ④ 宿主抛错 ⇒ 回落原文，不许让整棵树白屏。
 */
describe('宿主注入的正文（Markdown）：挂同一个块，不铺树', () => {
  const mdText = '# 标题\n\n- a';

  it('给了 body ⇒ 原样挂上、不铺树，头部写 `string · N 字符 · md` 并打 md 标记', () => {
    const injected = makeNode();
    injected.className = 'md';
    const box = createFullView(mdText, { body: injected });

    assert.equal(box.dataset.kind, 'md');
    const head = textOf(allByClass(box, 'tr-full-head')[0]);
    // 头部只写「原本是字符串 + 字符数」；`md` 由标记说 —— 同一行说两遍会让人以为
    // 其中一个是别的意思
    assert.ok(head.includes(`string · ${mdText.length} 字符`), `头部要说清原本是字符串：${head}`);
    assert.equal(head.includes('· md'), false, '不要和 md 标记重复');
    assert.ok(textOf(allByClass(box, 'tr-full-md')[0]).includes('md'), '要有 md 标记');

    const body = allByClass(box, 'tr-full-body')[0];
    assert.deepEqual(body.children, [injected], '宿主节点原样挂进 body');
    assert.equal(allByClass(box, 'tr-full-line').length, 0, '注入正文时不许再铺树');
  });

  it('复制取的是**原文**（Markdown 源文），不是宿主渲染出来的东西', async () => {
    const wrote = [];
    globalThis.navigator = {
      clipboard: {
        writeText(s) {
          wrote.push(s);
          return Promise.resolve();
        },
      },
    };
    const box = createFullView(mdText, { body: makeNode() });
    allByClass(box, 'tr-full-copy')[0].click();
    await Promise.resolve();
    assert.deepEqual(wrote, [mdText]);
  });
});

describe('接线：宿主 `textBody` 认得的字符串正文', () => {
  it('命中 ⇒ 挂块 + 行标 tr-structured + `.tr-io` 仍是原文', () => {
    const root = makeNode();
    const injected = makeNode();
    const view = createTraceView(root, { textBody: () => injected });
    playTrace(view, traceFixture());

    evRows(root)[1].click();
    const row = evRows(root)[1];
    assert.ok(row.className.includes('tr-structured'), '标出来，CSS 才会隐藏 .tr-io');

    const block = root.children.find((r) => (r.className || '') === 'tr-full');
    assert.ok(block, '展开行之后必须有块');
    assert.ok(textOf(allByClass(block, 'tr-full-md')[0]).includes('md'), '标出「渲染过」');

    const io = row.children.find((c) => c.className === 'tr-io');
    assert.equal(io.textContent, '纯文本结果', '.tr-io 仍是原文（复制 / 选中都靠它）');
  });

  it('返回 null（不是那种正文）⇒ 与没注入完全一样：不挂块', () => {
    const root = makeNode();
    const view = createTraceView(root, { textBody: () => null });
    playTrace(view, traceFixture());

    evRows(root)[1].click();
    assert.ok(!evRows(root)[1].className.includes('tr-structured'));
    assert.equal(
      root.children.some((r) => (r.className || '') === 'tr-full'),
      false,
      '不是 Markdown 就别挂块',
    );
  });

  it('**只在展开时调用** —— 折叠态每条事件都会重画，挂那儿等于白解析所有历史正文', () => {
    const root = makeNode();
    let calls = 0;
    const view = createTraceView(root, {
      textBody: () => {
        calls += 1;
        return null;
      },
    });
    playTrace(view, traceFixture());
    assert.equal(calls, 0, '折叠态一次都不该调');

    evRows(root)[1].click();
    assert.ok(calls > 0, '展开之后才调');
  });

  it('宿主渲染器抛错 ⇒ 回落原文，整棵树不白屏', () => {
    const root = makeNode();
    const view = createTraceView(root, {
      textBody: () => {
        throw new Error('boom');
      },
    });
    playTrace(view, traceFixture());

    assert.doesNotThrow(() => evRows(root)[1].click());
    assert.ok(!evRows(root)[1].className.includes('tr-structured'));
    assert.equal(
      root.children.some((r) => (r.className || '') === 'tr-full'),
      false,
    );
    assert.ok(evRows(root).length >= 2, '一条坏正文不该让整棵树消失');
  });
});
