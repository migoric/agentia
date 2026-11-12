# Inspector 调试看板评审：它现在是「trace 查看器」，还不是「调试看板」

> 范围：`main` @ `6739c17`（右栏三块折叠 #304 之后）。判据两条：`docs/spec.md` §9 对 trace 的承诺
> （「调试表面 + 审计记录」「便于回放调试」「少了一半数据必须有人收到」），以及同类工具
> （LangSmith run 详情 / Langfuse / OTel-Jaeger / DevTools）必备的「面」。
> 只评审**已提交**内容；每条结论都钉到可复现的代码位置或实测脚本。

一句话结论：**「看一棵树」这件事做得比多数开源面板细**（结构折叠、结构化正文、str→json、
A/B 差异与服务端同源），**但「看一趟 run 的账」和「在一堆 run 里找到那一条」几乎是空的**。
更要紧的是有 5 处**在说谎**：回复会自己消失、失败轮不出现在对话里、run 根上的事件被静默丢弃、
每条 run 都叫同一个名字、13 种收尾原因只呈现 3 种。看板的第一职责是「说的和真的一样」，
这一层没打平之前，加功能只是把坑摊大。

---

## 0. 复现基线（本机实跑，脚本在 `/tmp`，不入仓）

| 探针 | 结果 | 说明 |
|---|---|---|
| 树渲染次数 | 50 span → **151** 次全树重建；200 → **601**；600 → **1801**（172 ms 仅假 DOM） | 每来一条 span 动作就 `renderTrace()` 一次 ⇒ `playTrace` 是 O(N²)；在飞时每帧一次 |
| 根事件可见性 | `score` **false**、`trace.truncated` **false**、子 span 的 `tool.input` **true** | `view.reset` 把根存成 key `'root'`，`fromTrace` 用真 `spanId` 回放 ⇒ `spanMap.get` 落空、静默 return |
| 失败轮 join | 生产形状（`note.prompt`）→ **多不出任何一轮**；测试形状（顶层 `prompt`）→ 多一轮 | `RunSummary` 没有 `prompt` 字段，`mergeConversation` 读的 `r.prompt` 恒为 `undefined` |

命令形态：`node /tmp/measure-render.mjs 600`、`node /tmp/check-root-event.mjs`、
以及 `packages/cli/dist/panel-logic.js` 直接 import 后喂两种形状跑 `mergeConversation`。

---

## 1. 能力盘点（按「一个看板该有的六个面」）

| 面 | 现在有什么 | 判断 | 证据 |
|---|---|---|---|
| 入口与配置 | 能力多选 / 工作目录（列目录 + 系统选择器）/ 多轮 / prompt 历史 / 中止 / 清空对话 | **强**。同类产品通常没有「本地面板直接驱动真 run」这一层 | `inspector-page.html` footer、`inspector-routes.ts` 的 `/run` `/api/fs*` |
| 运行与实时 | SSE 增量树、能力排行、回复、在飞占位 | **中**。树会长出来，但没有「现在在跑哪个 span」、没有已耗时、没有自动滚到最新 | `applyTraceEvent` / `renderLive` |
| 单 run 诊断 | 结构树（折叠 / 成表 / 路径复制）、工具出入参、错误行、排行表 | **前半强，后半空**：树很好读，但 run 级的账（轮数、失败数、cache、成本、预算、模型、结构化产物）一个都没有 | 见 §2 P0、§3 P1-1 |
| 检索与对比 | 无搜索；⌘ 点两条并排 + 服务端 diff | **弱**。50 条 run 只能肉眼扫；对比没有基线概念 | `renderList` 无输入框；`COMPARE_MAX = 2` |
| 复现与流转 | 无。没有重跑、没有深链、没有导出 | **空**。而 `note` 里四个输入齐备、`agentia view` 已能产出单文件 HTML | `RunNote` 四字段；`view.ts` |
| 诚实性 | 失败不静默、403 有文案、截断有说明 | **有一处系统性缺口**：根事件被丢、回复会消失、收尾原因折叠成三态 | 见 §2 |

---

## 2. P0：面板在说谎（先修这一层）

### P0-1 回复只在「刚跑完且没切走」的那一瞬可见

- 现象：跑完看到回复，去点一眼旧 run，再点回来 —— 回复没了。刷新页面更不用说。
- 证据：`state.reply` 只由 `run-done` 事件写入（`inspector-page.html` 的 SSE 分支）；`open()` 里
  `if (!replyBelongsTo(id, state.replyFor))` 会清空它。而 `dev-protocol.ts` 的 `run-done` 注释
  自己写着「trace 上**没有**它 —— 面板要显示就得由这里带」。
- 影响：调试的主循环是「跑完 → 读回复 → 看树 → 改 → 再跑」。第二步和第三步不可兼得。
- 修法：`RunNote` 增 `finalText`（截断到上限，比如 8k 字符，超出显式标注），随 note 进 ring。
  `open()` 时用它回填 `state.reply`。代价：CLI 侧一处字段 + 路由一处透传 + 面板一处回填。

### P0-2 失败轮 / 中止轮**永远不会**出现在对话视图

- 现象：对话页签里少了几轮，看起来像「模型没回过」。
- 证据：`mergeConversation` 读 `r.prompt`，但 `/api/runs` 返回的 `RunSummary` 没有 `prompt`，
  只有 `note.prompt`。上面探针实测：生产形状下 join 出 0 轮。
- 为什么没被发现：`panel-logic.test.mjs` 直接喂了顶层 `prompt` —— 一个**生产不会产出的形状**。
  这是「测试喂的形状与生产不同源」，比没有测试更危险。
- 修法：`mergeConversation` 改读 `r.note?.prompt ?? r.prompt`（兼容旧形状），并在测试里补一条
  「按 `RunSummary` 的真实形状喂」的用例（带 `note`、不带顶层 `prompt`）。

### P0-3 run 根上的事件全被丢弃

- 现象：评估结论（`score`）、trace 被截断的警告（`trace.truncated`）、恢复段的
  `approval.decided` —— 这些事件都挂在 run 根上，面板与 `agentia view` 都**一行都不显示**。
- 证据：`view.js` 的 `reset()` 把根存成 `spanMap.set('root', traceRoot)`；`fromTrace.js` 回放时
  传的是真 `spanId`，`view.event()` 里 `spanMap.get(id)` 落空直接 `return`。实测脚本三条断言：
  `score` false / `trace.truncated` false / 子 span 事件 true。
- 影响：spec §9.4 明写「少了一半数据**必须有人能收到**」，§9.2 的 R7 质量闭环也落在这里。
  排行表能算出 `guardrail:` 行（它扫的是原始 trace），树里却看不到那次审批 —— 两个表面互相矛盾。
- 修法：`reset()` 用真 `rootSpanId` 注册根节点（`playTrace` 把它传进去），或给 `event()` 一个
  「根」的回退键。同时补一条守卫：根上有事件时树里必须出现该事件行。

### P0-4 每条 run 都叫 `agent.run`，而真正区分它们的那句话没显示

- 现象：左栏一列同样的名字，只能靠「3m 前 / 5m 前」找。用户截图里那种「JS 错误巡检」在 dev 里
  并不存在 —— `runName` 只有 module 调用才设，`dev-runner` 直接 `app.run()`，缺省是 `agent.run`
  （`engine/loop.ts:395`）。
- 证据：`renderList` 的第三行只拼 `short(note.workdir)` + 能力 + 多轮，**没有 prompt**；
  而 `RunNote.prompt` 一直在，`/api/runs` 也已经返回。
- 影响：这是「感觉功能差了不少」最直接的来源 —— 不是缺高级功能，是**找不回刚才那一条**。
- 修法：列表首行显示 prompt 单行摘要（截断 + title 全文），名字退到次要位置；顺带把
  `note.prompt` 做成搜索键（P1-3）。

### P0-5 13 种收尾原因，看板只呈现 3 种

- 证据：`src/engine/types.ts` 的 `AgentStopReason` 有 13 个成员（`end_turn` / `stop_sequence` /
  `max_tokens` / `model_context_window_exceeded` / `refusal` / `pause_turn` / `max_iterations` /
  `result_missing` / `aborted` / `budget_exceeded` / `tool_use_no_blocks` / `suspended` /
  `unknown_stop_reason` / `error`）；面板只用 `stopReason === 'aborted'` 分出第三态，
  其余全部落在「正常」或「失败」两桶里。
- 具体说谎的两例：`suspended`（HITL 等审批）trace 记 `ok` ⇒ 列表显示**正常跑完**，实际在等人；
  `budget_exceeded` / `max_iterations` 是护栏拦下的，列表看起来和 `end_turn` 没区别。
- 修法：列表第二行直接写收尾原因（`end_turn` 可省，其余照写）；`suspended` 单列一色 + 一行说明
  「在等审批 / 等唤醒」；`ok` 不再作为唯一判据（沿用 `runIsFailure`，但补「非成功非失败」第三态）。

---

## 3. P1：看板骨架缺的四块

### P1-1 run 级总账（打开一条 run，先给「这一趟的账」）

现在只有 footer 的 `in / out` 两个数，而 `Trace.totalUsage` 里有 `cacheReadTokens` /
`cacheCreationTokens` / `costEstimate`，`AgentRunResult` 里有 `iterations`、`typed`（结构化产物）、
`pendingApprovals`。`DevState.budget` 也有，页面 0 处使用。

该有的一行（放在 `#ttl` 下、`#panes` 上）：`3 轮 · 7 次工具 · 2 失败 · 12.4s · in 8.1k / out 1.5k ·
cache 6.2k(77%) · $0.014 · 模型 claude-x · end_turn`，右侧挂预算条（$0.014 / $1）。
其中「cache 命中率」是这类面板最该给、又最常缺的一个数 —— 它直接对应账单。

### P1-2 span 属性完全不可见

`model`（根）、`prompt 版本`、`system.version`、`tools.names`、`retry.attempt`、`mcp.tool`、
`handoff.from/to`、`guardrail.*` 都在 `attributes` 里，树上一格都不显示（页面与 `view.js` 里
`attributes` 出现次数均为 0）。「这次是不是提示词版本没换」「是不是重试了三次」全靠猜。

修法：span 行展开时追加一段 `k=v` 属性区（复用 `full-view.js` 的结构化块，不要再写一套）。
注意：`attributes` 是 `Record<string, string|number|boolean>`，是纯标量集合，用成表那档最合适。

### P1-3 搜索与过滤（列表 + 树）

- 列表：按 prompt / 目录 / 收尾原因 / 是否失败过滤，`/` 聚焦。
- 树：按名字、kind、`只看错误`、`只看工具`、`耗时 > N` 过滤；`n` / `N` 跳到下一个/上一个错误。
- 为什么这是 P1 而不是 P2：一次真跑几十上百个 span、环里 50 条 run，没有检索就只能靠肉眼，
  这一条直接决定「能不能用」而不只是「好不好用」。

### P1-4 时间轴（瀑布）

数据齐全（`startedAt` / `endedAt` 每个 span 都有），纯前端可画，零新依赖。现在只有结构视角，
「谁和谁并行、8 秒被谁吃掉、首 token 等了多久」全都看不见。最小形态：树行右侧一条按 run 时长
归一化的细条（同一套行，不改结构），够用且不引入第二套布局。

### P1-5 深链 / 重跑 / 导出（三件都在「一步之遥」）

| 能力 | 现状 | 缺什么 |
|---|---|---|
| 深链 | 无 URL 状态（`location` / `pushState` 在页面里出现 0 次） | `?run=<id>` 读写；刷新回到那条而不是最新 |
| 重跑 | `note` 里 prompt / workdir / toolSources / multiTurn **四个输入全在** | 一个按钮：回填 footer 并 submit（不自动跑，避免误触花钱） |
| 导出 | `agentia view` 已能产出单文件 HTML（含脱敏） | 面板里一个「导出 HTML / 复制 JSON」入口；后者直接 `fetch('/api/runs/:id')` |

### P1-6 树渲染是 O(N²)，长跑会卡死

实测：600 span 的 trace，`playTrace` 触发 **1801 次全树重建**（每次重画 600 行），假 DOM 下
172 ms，真 DOM 是数量级更糟；而在飞时 `renderLive` 每个 rAF 调一次 `playTrace`。
修法：给 `createTraceView` 一个 `batch(fn)`（或让 `playTrace` 内部用 `suspend()` 包一层），
把 N 次渲染压成 1 次。这是**所有后续功能的地基** —— 加搜索/时间轴之前必须先修，否则越加越慢。

---

## 4. P2：增强（等骨架补齐再说）

- 对比升级：baseline pin（「以这条为基准」）、diff 行点击跳到对应 span、同 prompt 多次 run 自动成组。
- 对话轮点击打开对应 run（`ConversationTurn.traceId` 已经在了，接线缺）。
- 在飞体验：当前 span 高亮 + 自动滚到底 + 已耗时计时器。
- 历史文件入口：面板只读内存 50 条，而 `.agentia/traces.jsonl` 是全量；给一个「从文件打开」入口
  （或直接把 `view` 的产物链过来）。
- 图片块缩略图（需 MIME 白名单与体积上限）、键盘全套。

---

## 5. 建议分三批落地

| 批次 | 内容 | 为什么先做它 | 大致面 |
|---|---|---|---|
| **A 诚实性** | P0-1 … P0-5 | 全是数据/文案层，没有新 UI 面；修完面板说的每句话都为真 | CLI 协议 + 面板 + trace-view 各一处 |
| **B 账与检索** | P1-1、P1-2、P1-3 | 「看一趟的账」+「找到那一条」，把查看器变成看板 | 面板为主，`panel-logic` 出纯函数 |
| **C 时间与流转** | P1-6 先行，再 P1-4、P1-5 | 性能是地基；时间轴与导出是「能不能贴给别人」 | trace-view 一次结构性改动 |

每批都要按本仓既有纪律走：新判据做反向变异（改坏必须变红）、`structure.test.mjs` 基线显式抬、
spec §10 记一条决策、`verify-all.sh rapid` 全绿。

## 6. 明确不做

- **不做服务端持久化 / 账号体系**：这是本机 dev 工具，历史归档由 `.agentia/traces.jsonl` 与
  `agentia view` 承担。
- **不引入图表库**：零运行时依赖是全仓铁律，时间轴用 CSS 宽度画。
- **不做在线 eval / judge 面板**：那是 `examples/eval-gate` 与 `buildRunReport` 的活；
  面板只负责**显示**已经挂在 trace 上的 `score`（这正是 P0-3 修完的副产品）。
