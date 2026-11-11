# @migor/trace-view

Agentia **trace 调用树渲染器** —— 框架无关、零依赖的 ESM 模块。
把一条 `Trace` 渲染成终端风格的调用树（`llm.turn` / 能力 span / 事件）与用量汇总。

`"private": true`，**不单独发布**。它是官网 Playground 与 CLI inspector 的**共用底座** ——
两处渲染同一份代码，避免「同一个 trace 在两个地方长得不一样」这类漂移。

## 为什么值得单独有这一层

Agentia 把**可观测性当核心卖点**，而不是事后外挂：一次 run == 一条 trace（`runId == traceId`），
Turn 0 起内建。框架本体只负责**产出**这条 trace 的数据结构，**长什么样归这里** ——
呈现与内核解耦，宿主（官网 / CLI / 你自己的面板）可以各自取用同一份渲染。

## API

| 导出 | 说明 |
|---|---|
| `createTraceView(rootEl, opts?)` | 建一个绑定到 `rootEl` 的视图。`opts.price` 给单价（`$/M tokens`；传 `null` 表示不估成本）；`opts.usage` 传 `{ in, out, cost }` 三个 DOM 节点以更新计数器；`opts.onUsage` 每次累计后回调（便于宿主自定义展示） |
| `playTrace(view, trace)` | 把一条真实 `Trace` **一次性同步回放**给视图（用于 run 结束后的静态展示）。trace 为空时返回 `false` 且不渲染 |
| `summarizeTrace(trace)` | 从 trace 算**能力排行**：`{ capability, calls, errors, totalMs, maxMs, tokens, costUsd }`，按 `totalMs` 降序 |
| `renderSummary(rows)` | 把上面的排行渲成小表格（返回 HTML 字符串，样式由 `trace-view.css` 提供） |
| `createFullView(value, opts?)` | 把任意值铺成**结构化正文块**：嵌套容器可折叠（默认铺两层）、同构对象数组成表、键旁 `⧉` 复制 JSON 路径、类型着色。`full` 是对象或数组时，渲染器自动把它挂在展开行下方；字符串正文仍走 `.tr-io` 的纯文本换行（那条路有两个 CSS 不变量守着）。`opts.fold` 传一份 `Map<路径, 是否展开>` 让折叠状态活在重建之外（渲染器内部按事件键存一份） |
| `capabilityTypeOf(name)` / `CAP_ICO` | 能力类型判定与其图标 |
| `fmtArg` / `rawArg` | 入参展示的一对：`fmtArg` 给**折叠态摘要**（砍到 62 字符），`rawArg` 给**序列化原文**（展开行的 `.tr-io` 正文与「展开拿到的是原文、不是摘要」这条不变量都靠它） |
| `fmtNum` / `fmtMs` | 数字 / 耗时的展示格式化 |

样式单独导出：`import '@migor/trace-view/style.css'`。

## 用法

```js
import { createTraceView, playTrace } from '@migor/trace-view';
import '@migor/trace-view/style.css';

const view = createTraceView(document.querySelector('#trace'), {
  price: { input: 3, output: 15 }, // $/M tokens
  usage: {
    in: document.querySelector('#u-in'),
    out: document.querySelector('#u-out'),
    cost: document.querySelector('#u-cost'),
  },
});

playTrace(view, trace); // trace 即框架 run 结束后的 result.trace
```

## 测试

```bash
node --test test/*.test.js
```

## 许可

MIT
