# 近期代码复评：`agentia view` 链 + trace→eval 闭环（2026-10-21）

> 基准：main @ `50ea226`（v0.10.3 + #275 之后）。工作树干净。
> 范围：**最近 10 天 45 个提交**里真正动代码的 4 个 —— `#275`（view 链）、`#262`（计时器族 flaky）、
> `#259`（三处出声）、`#257`（v0.10.3）。其余 41 个是文档/依赖/分发面。
> 方法：不靠读代码提意见 —— **每条结论都跑过一遍**。凡写「实测」的都是本机命令输出，argv 与读数在文内。
> 没验的也写在 §4，不假装覆盖。

## 总评

这轮改动**方向是对的**：`agentia view` 补的是「事后看一棵树」这段真空，形态（单文件自包含 +
默认脱敏）与业界收敛一致，安全面（`<` 转义、零外链）都验住了。

但有两条**自己的新代码**在边界上塌了，而且都是本仓最忌的形状 ——「产物坏了却没人报错」：

- `view` 的 `--limit` **取的是最早的 N 条**，而它要读的那个文件（`.agentia/traces.jsonl`）
  设计上**只增不减**。跑完一次 run 想看「刚才那次」，默认看不到。注释还自称「与 dev 面板
  ring 50 对齐」—— ring 保留最新，方向正好相反。
- `bundle.mjs` 有一条**静默失效**：`src/` 里出现副作用 `import './x.js'` 时，构建绿、测试绿、
  `agentia view` 也**打印「已生成」**，而产出的 HTML 在浏览器里白屏（普通 `<script>` 里的
  `import` 是 SyntaxError）。实测见 F2。

还有一条不是新代码，但和你刚修的 #259 同族：`traceContent: 'full'` 这条缝，`export` 接上了，
`harvest` 没接，**而 harvest 产物的注释把「trace 不记文本」写成既定事实** —— 开关开了、没人接、
不报错。

---

## 1. 功能问题

### F1（P1）`--limit` 取最早 N 条，与「只增不减的落盘文件」正面相撞

| | |
|---|---|
| 位置 | `packages/cli/src/view.ts:275-280`（`traces.slice(0, cap)`）|
| 对照 | `packages/cli/src/dev-runner.ts:151-153`：「**不轮转、不清空** … 代价是**长跑 dev 环会攒一个只增不减的文件**」|
| 自相矛盾 | `view.ts:29-30` 注释写「与 `agentia dev` 面板的 ring 50 对齐」—— ring 丢最老、留最新 |

**实测**（4 行文件模拟 append-only：`t1-old` / `t2` / `t3`，再追加一次 `t1-old` 的重写）：

```
$ agentia view /tmp/viewtest/traces.jsonl --limit 2 -o a.html
已生成 a.html（2 条 trace，30.1 KiB，单文件自包含）
⚠️ 源文件共 4 行记录 / 3 条 trace，本页只含前 2 条 —— 用 --limit 调整
$ grep -o 't[0-9]-[a-z]*' a.html | sort -u
t1-old        ← 最早的一条
t2            ← 第二条
```

`t3`（最新的那次 run）不在页里。**使用场景直接失效**：`agentia dev` 跑一天攒下 200 条，
晚上想复盘刚才那次，`view` 给的是早上第一批。

**附带的半个 bug**：同一 `traceId` 重写时 `Map.set` 不移动位置 ⇒ 顺序是「**首次出现**」而不是
「最后写入」。内容对（后写胜），位置错。注释「留最后一行」只兑现了一半。

**修法**：`slice(-cap)` 取最近；去重时先 `delete` 再 `set` 让重写者排到末尾；`--limit` 与
banner / stdout 文案改「最近 N 条」并同步 `view.test.mjs:252` 那条断言。
⚠️ 这是**语义变更** —— 若还想保留「从头看」，加 `--head` 而不是两意混在一个 flag 里。

### F2（P2）`bundle.mjs`：副作用 `import` 会**静默**产出一张白屏页

**这条判断我改过两次，把过程留着**（判断错在哪比结论更值得记）：
1. 初版按 `export { foo as bar }` 举例说「构建绿、测试绿、白屏」—— **三点全错**；
2. 第二版用自己写的 `stripExports` 模拟验 `export default`，得出「白屏」—— **也错**（真实
   `stripExports` 有第二道 `export` 检查会拦住它）；
3. 直到**拿真实 `dist/` 的 bundle 换成坏产物、跑真实 CLI** 才定死：白屏只有**一种**形态。

| 形态 | 构建 | `bundle.test.js:140`（ESM import）| `agentia view` | 定性 |
|---|---|---|---|---|
| `import './x.js'`（副作用）| ✅ 成功 | ✅ 通过 | ✅ **打印「已生成」** → 页面白屏 | **静默失效（P2）** |
| `export default` | ✅ 成功 | ✅ 通过 | ❌ 抛错、不产出 | 响亮，但发现点在运行期（P3）|
| `export * from './x'` | ✅ 成功 | ✅ 通过 | ❌ 抛错、不产出 | 同上（P3）|
| `export { a as b }` | ✅ 成功 | ❌ `Export 'b' is not defined` | ⚠️ 内联不白屏 | CI 能拦（P3）|

**实测（副作用 import；真实 `dist/inspector/` 替换 + 真实 CLI，验完已恢复）**：

```
$ cli.js view traces.jsonl -o side.html
已生成 side.html（2 条 trace，7.4 KiB，单文件自包含）      ← 全程零报错
$ grep -n 'import "' side.html
255:import "./missing-sidecar.js";                            ← 残留进普通 <script>
```

产物 9524 字节照常写出，退出码 0。普通 `<script>` 里的 `import` 是 SyntaxError ⇒ **打开即白屏**，
而 CLI 说「已生成」。这是本仓最忌的形状：**少给了、还说了给了**。

**根因是两条叠起来才成立**：
1. `stripExports`（`view.ts:75-84`）只查 `export`，不查 `import`；
2. `bundle.test.js:140` 用 **ESM import** 验产物 —— `import` 在 ESM 里合法。`view` 用 classic
   script 消费同一份产物，**两种语法集不同，而只测了宽松的那一种**。

**修法**：`buildBundle` 末尾对 `body`（不含末尾 `export {}`）跑一次 `new Function(body)`，按
classic script 解析。**实测不误报也不漏**：

```
真实 bundle 的 body                → new Function 通过 ✓
new Function("import './x.js'")    → Cannot use import statement outside a module ✓
new Function('export default 1')   → Unexpected token 'export' ✓
```

`export default` / `export *` 现在在**运行期**就被 `stripExports` 的第二道检查拦住（实测 exit 1、
不产出文件）—— 加自检的价值是**把发现点从「用户跑 view 时」提前到构建期**，不是修一个新 bug。

`export { a as b }` 建议**直接拒绝**：`exportedNamesOf`（`:76-84`）把 `as` 后的名字当导出名，
产物尾部引用一个不存在的标识符。CI 能拦，但错误信息指不到 `bundle.mjs` 的 `as` 处理 ——
报一句「bundle 不支持重命名导出，请在模块内声明 `b`」比支持它便宜。

**同族未覆盖形态**（`src/` 目前全平铺，属未来）：`localDepsOf`（`:18-22`）只认 `from './x'`，
且 `readdirSync` 不递归 ⇒ `from '../x.js'` 既不匹配依赖正则（不触发「模块不存在」那条检查）、
也不在文件集里 ⇒ **静默漏**；`bundle.test.js:110` 只遍历根目录 `.js`，同样看不见。

### F3（P2）`traceContent: 'full'` 这条缝：export 接了、harvest 没接

| 处 | 状态 |
|---|---|
| `src/engine/turn.ts:491-501` | opt-in 把 assistant 文本写进 `llm.turn` 的 `output.text` ✅ |
| `src/eval/export.ts:123` | **读** `output.text`（缺了不造占位，防投毒）✅ |
| `packages/cli/src/export.ts:124` | **读** `run 根` 的 `config.traceContent` 判缺口 ✅ |
| `src/eval/harvest.ts:36` / `packages/cli/src/harvest.ts:42` | **硬编码占位** `'[harvest] assistant 文本未入 trace'` ❌ |
| `packages/cli/src/harvest.ts:171` | 产物注释写「trace 不记 assistant 文本」—— opt-in 下**是假断言** ❌ |

**影响**：用户为了让 harvest 出**可跑**的用例，专门开 `traceContent: 'full'`（体积变大、
模型输出进入要脱敏的面 —— 两条代价都真实），结果脚本里 assistant 还是占位。

这正是 #259 修的三条同一个形状：**框架给了缝、消费方没接上、而没接上不报错**。区别是这条
代价更隐蔽 —— 用户以为「我开了」。

**修法**：harvest 读 `turn.attributes?.['output.text']`（照 `export.ts:123` 的宽容读法），有真值
就用、没有才占位；产物注释按 `config.traceContent === 'full'` 分两种措辞（「本 run 没开」vs
「开了但这回合确实没说话」）。文档 `usage-guide.md:1468` / `:1890` 两处「trace 不记 assistant
文本」补 opt-in 条件（`:1891` 已有，这两处没有）。

### F4（P3）空 `spans` 的 trace 会进列表，选中后残留上一条的树

- `extractTrace` 只要求 `Array.isArray(spans)` ⇒ `{"spans":[]}` **通过**（实测：产物里
  traceId 列表含 `ok1` 与 `empty`）。
- `playTrace`（`fromTrace.js:95-96`）在 `spans.length === 0` 时 `return false`，而这一步在
  `view.reset()` **之前** ⇒ 不 reset；`show()`（`view.ts:166-171`）不看返回值
  ⇒ 下拉框写「0 spans」，画布还挂着上一条的树。**静默显示错数据**。

**修法**：解析期就过滤空 spans（并计入 `badLines`/明说）；或 `show()` 对 `false` 清空并写
「这条没有 span」。

### F5（P3）一致性三小项

| # | 问题 | 处 |
|---|---|---|
| a | 「CLI **四件套**」没跟 view ⇒ 应五件套 | `docs/usage-guide.md:1161`；`:883` 的 `jsonlTraceSink` 输入方列表同样少 view |
| b | 缺省产物落在源文件旁 ⇒ `.agentia/traces.jsonl` → **`.agentia/traces.html`**（点目录、Finder 看不见、转发要翻隐藏目录）| `view.ts:320` |
| c | `-o` 目标已存在时**静默覆盖**（`harvest` 有 `--force` 保护，`view` 没有）| `view.ts:321` |
| d | `--open` 在 Windows 用 `spawn('start')`：`start` 是 cmd 内建，直接 spawn 会 ENOENT（有 error 回调出声，但功能不可用）| `view.ts:50-52` |

---

## 2. 核对过、确认没问题的面（不写「应该没问题」）

- **redact 覆盖面完整**：`Trace` 的字符串面只有三处 —— `spans[].attributes`（**扁平**
  `Record<string, string|number|boolean>`，`src/core/trace.ts:206`）、`spans[].events[].body`、
  `span.error.message`。三处全走 `redactValue`/`applyRules`；`totalUsage` 是纯数字，无需处理。
  比 `examples/observability` 多覆盖的顶层 `events` 是**多脱不是少脱**，方向对。
- **`<` 转义足够**：内联走 `<script type="application/json">` + `textContent`，转义 `<` 后不存在
  `</script` 提前闭合路径；`\u2028/\u2029` 在 textContent 语义下无害。
- **`stripExports` 的失败是响亮的**（残留 `export` 直接抛，不会产出白屏页）。
- **`extractTrace` 三种形态**（裸 Trace / `result.trace` / `trace`）都认，与 `report`/`diff`/`export` 同源。
- **`playTrace` 幂等**：内部 `view.reset`，切换 trace 不叠加（F4 是它提前 return 的例外）。

## 3. 没验的（边界声明）

- 真实浏览器里的渲染效果 —— 只验了产物文本与 node 下 `import` bundle，没开浏览器点过。
- `--open` 三平台真机（只读了代码路径）。
- `#262`（计时器族 flaky）与 `#259` 的 src 改动**未逐行审** —— 那两批有完整变异反验记录，
  本轮只抽看 #259 的 diff。
- `examples/agent-endpoint`（新示例）走 `tsconfig.tests.json`，CI 已 typecheck 覆盖，未另跑。

## 4. 产品方向建议

最近 41/45 个提交在文档与分发面（README 451→303、promotion、frameworks 实测、npm metadata
英文化）—— 说明瓶颈认知已经从「工程质量」转到「采用面」。基于这个前提，接下来三格的价值排序：

### ① 官网 playground 支持「拖入自己的 trace.jsonl」（零后端，文件不出浏览器）

现在 `agentia view` 要经过「装包 → 跑命令 → 在 `.agentia/` 里找产物」三步才看到自己的树；
而**没装包的人完全看不到**。官网 playground 已经内联了同一份 `trace-view` bundle，
缺的只是一个 `<input type=file>` + JSONL 解析。

- **判据**：这是从「看到效果」到「看到自己的问题」的那一步，也是从官网到装包最短的一跳。
- **零成本论证**：`FileReader` 本地读、文件不上传 ⇒ **不需要前端脱敏**（不是「忘了做」，
  是「不需要」）。这一条要写在页面上，否则用户会怀疑。
- 不违反定位：无服务端、无外链、复用同一份渲染器。

### ② harvest 接 opt-in 文本（= F3）

闭环里最便宜的一格：`trace → eval 用例` 已经通了 80%，差的是「用例里的 assistant 是真实
文本」。修完之后「把线上失败翻成可跑回归」才第一次**真的能跑**，而不是一份需要手写的骨架。

### ③ `view --md`：给出一段能贴进 IM / PR 的摘要

现在的产物是 30–40 KB 的 HTML —— **贴不进对话**。而排查一个问题的第一动作通常是「把结论
发给同事」。`report` 给的是跨 trace 的聚合排行，没有「**这一次 run**」的单条结论。

一段几十行的 markdown（run 状态 / 耗时 / 成本 / 失败点 + 缩进的调用树 + 关键工具 IO）就是
「证据包」，成本低、使用频率高，且与单文件 HTML 是同一份数据的两个出口。

### 不建议做的两件

- **给 `view` 加托管 / 分享链接**：要服务端，违反零依赖零后端。LangSmith 那种分享页是 SaaS
  的前提，不是框架的。
- **把 redact 搬进 `trace-view`**：渲染器不该管脱敏；一旦搬进去，CLI 与前端就有了两份规则，
  正是本仓最忌的漂移。

## 5. 建议处置顺序

| 序 | 项 | 代价 | 为什么要先做 |
|---|---|---|---|
| 1 | **F1** | 改 1 处 + 1 条断言 + 文案 | 唯一一条让**今天的主场景直接失效**的；但语义要你拍板（`slice(-cap)` 还是加 `--head`）|
| 2 | **F2** | 约 10 行 + 1 条测试 | 一行 `new Function` 兜住唯一的静默白屏形态，并把其余三种的发现点从运行期提到构建期 |
| 3 | **F3** | 约 30 行 + 2 处文档 | 与 #259 同族；且是产品建议 ② 的技术本体 |
| 4 | F4 / F5 | 零散 | 清账，随手做 |

## 6. 修复落地（同日）

F1–F5 全部已修，决策登记在 `docs/spec.md` §10 2026-10-21 ① ref-view-limit-harvest-text。
与本文档上文措辞不一致处，以那一节为准（例如 F2 的修法最终用 `vm.Script` 而不是 `new Function`
—— 前者按 script 解析、连顶层 `return` 也拦得住）。落地时按方向拍板的结果：

- **F1**：取**最近** N 条（`--head` 保留从头看）。理由：落盘只增不减，最新在末尾，而「复盘刚才那次」
  是绝对主场景；两个方向都留，文案按方向说，不写含糊的「前 N 条」。
- **F2**：修在 `bundle.mjs`（构建期），不是修在 `view.ts`（运行期）—— 前者一次兜全族，
  后者只能挡住已经存在的那一种。运行期仍保留「残留 import」检查作第二道。
- **F3**：纯 tool_use 回合**不补占位**（占位是假事实），只有终端空回合才占位。
- **F4**：修在 `playTrace`（渲染层），不是修在 `view` 的页面脚本 —— 切换 trace 清旧树是所有消费方
  的不变式，`agentia dev` 面板共用同一份实现。
- **F5**：缺省产物避开点目录；`-o` 覆盖出声但**不加** `--force`（HTML 是派生物，重跑是常态）。
