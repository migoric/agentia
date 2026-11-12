/* 面板「说真话」的三条**源码级**守卫（2026-11-12 二次修）。
 *
 * 为什么读源码断言，而不是断言行为：这三处都落在**浏览器渲染层**或**类型层**，
 * Node 里跑不出它们的失败态 ——
 *   - `.r2/.r3` 是裸 `<span>`，`overflow` / `text-overflow` 对 inline 元素无效。
 *     删掉 `display: block` 后页面照样「能跑」，只是长文案横向顶出按钮；单测无 DOM 布局可测。
 *   - 「非正常收尾才拼分隔符」在 `<script>` 里，而 panel-logic 是纯逻辑、不碰 DOM。
 *   - `ConversationRunLike` 的价值就在**编译期**：改回手抄 interface 后当前代码依然能编译，
 *     只有下次服务端改字段时才会漂 —— 那正是上一轮的 bug。
 *
 * 所以这里钉的是「那三行还在不在」。它们本身很短，改错的样子也很短。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const PAGE = readFileSync(join(SRC, 'inspector-page.html'), 'utf8');
const LOGIC = readFileSync(join(SRC, 'panel-logic.ts'), 'utf8');

it('列表第二/三行是块级：否则 ellipsis 与 3px 间距都是装饰', () => {
  // 同一条 CSS 规则可能被拆成多条（颜色一条、溢出行为一条），只要求其中有 display:block
  const rules = [...PAGE.matchAll(/\.run \.r2, \.run \.r3 \{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(rules.length > 0, '找不到 `.run .r2, .run .r3` 规则 —— 选择器改名了？');
  assert.ok(
    rules.some((r) => /display:\s*block/.test(r)),
    '`.r2` / `.r3` 是 <button> 的直接子节点（裸 span），没有 display:block 时 ' +
      'overflow/text-overflow 与垂直 margin 全部不生效（第二行会顶出按钮而不是省略）',
  );
});

it('收尾原因为空时不拼分隔符：老 trace 不该在行尾挂一个孤立的「 · 」', () => {
  assert.ok(
    /const whyText = cls === 'ok' \? '' : stopReasonText\(r\.stopReason\);/.test(PAGE),
    '找不到 whyText 那一行 —— 第二行文案的拼接方式变了？',
  );
  assert.ok(
    /const why = whyText \? ` · \$\{whyText\}` : '';/.test(PAGE),
    'why 必须**先判空再拼分隔符**：直接模板拼会在 stopReason 为 null 时留下孤立的「 · 」',
  );
});

it('打开一条 run 失败必须出声（裸 return 会把上一条的树留在右栏）', () => {
  const at = PAGE.indexOf('async function open(id)');
  assert.ok(at >= 0, '找不到 open(id) —— 改名了？那这条守卫要跟着改');
  const end = PAGE.indexOf('async function openLatest', at);
  assert.ok(end > at, '找不到 openLatest —— 解析范围错了');
  const body = PAGE.slice(at, end);
  assert.ok(/打开 run 失败/.test(body), '失败分支必须有用户可见的提示（本档最忌张冠李戴）');
  assert.ok(
    !/if \(!res\.ok\) return;/.test(body),
    '不许裸 return：右栏仍是上一条的树，而用户以为「打开的就是这条」',
  );
  assert.ok(/catch \(e\)/.test(body), '网络异常也要出声 —— 否则只是一个 unhandled rejection');
});

it('run 列表形状是 RunSummary 的投影，不是手抄的 interface', () => {
  assert.ok(
    /export type ConversationRunLike = Pick<\s*RunSummary,/.test(LOGIC),
    'ConversationRunLike 必须从 RunSummary 投影。手抄的形状不会随服务端字段一起变 —— ' +
      '上一轮「失败轮一轮都 join 不出来」就是这么来的',
  );
  assert.ok(
    !/export interface ConversationRunLike/.test(LOGIC),
    '别改回 interface：手抄形状在编译期看不出漂移',
  );
});
