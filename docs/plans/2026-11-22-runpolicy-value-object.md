# RunPolicy：把「两个三十字段的选项面」收成不可变值对象（设计两次）

> 2026-11-22，APoSD 评审的第四批。**本文只出设计，不动代码** —— 它是 Ch11「设计两次」的
> 产物：两版方案并列、给出选择与理由，然后才轮到实现。
>
> 起因：结构评审把复杂度重心判成「配置面与跨包复制，而非文件大小」。本轮前三批
> （单源文案收口 / `async.ts` 按知识拆两块 / 类型级环清单预算）收的是「同一句话写在
> 多处」；这一件是同一病理在**类型面**上的版本，规模最大，也最值得先想清楚再动。
> ⚠️ 刻意不写提交号：文档引用的提交必须已在主干上（`tests/docs/commit-refs.test.ts`），
> 而这几批还在分支里 —— 需要定位时看 `git log --oneline` 的提交标题。

## 0. 结论先行

**选 A（扁平不可变快照 + 单一解析入口）。**

三条理由：

1. 它把「缺省值谁定」收敛成**一个函数**，而当前有三个答案（`loop.ts` 的 `??`、
   `run-config.ts` 再算一遍、`limits.ts` 的 0 语义表各说一部分）。
2. 它**不改公共入口**（`run(messages, opts)` 仍收 partial options）—— 我此前把它列为
   「破坏性变更」，设计时核了调用面，那个判断是**错的**：变的只是内部签名。
3. B（分层）能在「按层传参」上省一点，但代价是每层边界要再设计一次，且 17 个消费点
   全要改写成 `policy.tools.x`；收益不抵迁移成本与新增的分组规则（一个新概念要学）。

## 1. 事实（都可复算，别照抄结论）

| 事实 | 数 | 复算方式 |
|---|---:|---|
| `RunAgentOptions` 字段 / 其中可选 | 33 / 32 | 见附录 A 的脚本 |
| `RunInvocationOptions` 字段 / 其中可选 | 30 / 30 | 同上 |
| **两者同名**字段 | **25** | 见下方清单 |
| 13 个策略键的「逐字段搬运」行数（`k: x.k` 形态） | **87** | `grep -rnE '^\s+(maxEventChars\|maxTotalTokens\|…)…'` |
| 提到 `RunAgentOptions` 的文件 / 处 | 14 / 47 | `grep -r` |
| 提到 `RunInvocationOptions` 的文件 / 处 | 17 / 52 | `grep -r` |
| `maxEventChars?: number \| false` 的**声明**处 | **9 处 / 8 文件** | `grep -rn 'maxEventChars?:'` |
| `maxEventChars` 的引用总数 | 74 | `grep -r \| wc -l` |
| `?? DEFAULT_*` / `?? 常量` 形态的缺省决策 | 88 | 含非策略项，需按字段核对 |

**25 个同名字段**（两边都有，且语义相同）：

```
tools  model  maxTokens  maxIterations  client  fallbacks  traceContent  labels
onText  signal  traceContext  contextPolicy  retry  maxTotalTokens  usageOffset
maxCostUsd  priceOverrides  toolTimeoutMs  maxToolConcurrency  maxEventChars
maxToolResultChars  sessionId  approvals  approvalEpoch  events
```

也就是说：两个类型各自 30+ 字段里，**25 个是同一件事的两次声明** —— `RunInvocationOptions`
（任务里可序列化的那份）实际上是 `RunAgentOptions`（进程内可带函数的那份）的子集。
17 个文件在两者之间来回搬，其中 `transport/run-call-options.ts` 一个函数就用
`...restOptions` + 6 个条件展开把一份拼成另一份。

### 已有的半成品（别推倒重来）

- `core/limits.ts`：**每个旋钮的 0 是什么意思**的可执行表（`unlimited` / `disabled` /
  `immediate` / `invalid`），已有 `tests/limits.test.ts` 驱动真实站点对账。
- `engine/run-config.ts` 的 `resolveTraceLimits`：校验 + 定值（trace 三件）。
- `engine/run-config.ts` 的 `runConfigSnapshot`：本 run **生效值**的快照 —— 但它把
  `options.maxTokens ?? DEFAULT_MAX_TOKENS` **又算了一遍**（与 `loop.ts:489` 同一个决定、
  两个实现）。这是「缺省值三个答案」里最刺眼的一处。

## 2. 判据（APoSD 第 4/5/7 章）

- **变更放大**：加一个策略旋钮，当前要改：`RunAgentOptions` 声明、`RunInvocationOptions`
  声明、`loop.ts` 取值 + 缺省、`run-config.ts` 快照 + 缺省、`limits.ts` 表（若可 0）、
  `toolkit/module.ts` 的装配、文档。**≥ 7 处，其中 3 处是纯搬运。**
- **信息泄漏**：「缺省值是什么」的知识同时存在于 `loop.ts` 与 `run-config.ts`。
- **后门泄漏**：`undefined`（没配）/ `false`（不截断）/ `0`（按表可能是「不限」也可能是
  「非法」）三态，在 74 处引用里各自重新解释一遍。
- **未知的未知**：读 `options` 的人无法从类型上知道「这一份是不是已经解析过」——
  于是每个消费点都要自己再 `??` 一次。

## 3. 设计 A：扁平不可变快照 + 单一解析入口

```ts
/** 解析后的策略：**全字段必填**，没有 `?`。缺省值只在一个函数里出现一次。 */
export interface RunPolicy {
  readonly model: string;
  readonly maxTokens: number;
  readonly maxIterations: number;
  readonly maxEventChars: number | false; // ⚠️ false 保留（不截断），不折成 Infinity
  readonly toolTimeoutMs: number;         // 0 = 不限（limits 表口径）
  // …其余 28 个
}

/** 唯一的解析入口：partial → 定值。非法值在这里响亮失败（复用 limits 表文案）。 */
export function resolveRunPolicy(over: RunOptions = {}): RunPolicy;
```

- **`RunOptions`** = 现在的 `RunAgentOptions`（partial，公共入口原样收它）。
  对外 API 一个字符都不变：`run(messages, opts)` / `executeRun` / `AsyncRunner` 全收 partial。
- 内部（`runLoop` → `turn` → `mcp-server` → `toolkit`）一律传 `RunPolicy`，不再传 partial，
  也不再各自 `??`。
- `runConfigSnapshot(policy)` 直接读 `policy`，**不再自己算缺省** —— 两个答案变成一个。
- 三态收敛规则（全部落在 `resolveRunPolicy` 里，且逐条引用 `limits.ts` 的表）：
  `undefined → 缺省值`；`false → 不截断`（只对 `maxEventChars` / `maxToolResultChars`）；
  `0 → 按表`（`unlimited` 的保持 0，`invalid` 的抛 TypeError 并带上 `zeroClauseOf`）。

**为什么它不破坏兼容**：变的只有 `src/**` 内部签名。三处公共类型
（`RunAgentOptions` / `ExecuteRunOptions` / `RunInvocationOptions`）**保留**，仍然是「输入」
类型 —— 用户照旧传 partial。内部函数换成 `RunPolicy` 是 `src/` 内可见的变更，不需要
major bump（本仓 0.x，且 `index.ts` 的导出面不动）。

## 4. 设计 B：分层策略对象

```ts
export interface RunPolicy {
  readonly model: ModelPolicy;   // model / fallbacks / maxTokens / priceOverrides
  readonly tools: ToolPolicy;    // tools / toolTimeoutMs / maxToolConcurrency / maxToolResultChars
  readonly trace: TracePolicy;   // traceContent / maxEventChars / traceContext / labels
  readonly budget: BudgetPolicy; // maxIterations / maxTotalTokens / maxCostUsd / usageOffset
  readonly guards: GuardPolicy;  // approvals / approvalEpoch / events / retry
}
```

- **真优点**：`buildRunCallOptions` 这类「只关心一两层」的地方可以只传那一层，接口更窄。
- **真代价**：
  1. **分组边界要再设计一次**（哪个字段归哪层），而这条边界没有唯一答案 ——
     `maxEventChars` 归 trace 还是 tools？两边都有人说得出理由。
  2. 17 个消费点全要改写成 `policy.<层>.x`，逐字段搬运的 87 行**不会减少**，只是变成
     `policy.tools.maxEventChars` 形态。
  3. 迁移期必须同时维护两条路径（partial 与分层），而「两条路径一致」本身要一条断言 ——
     这跟我们要消除的病（同一件事两处）是同一类。
- **结论：不采用。** 它不是错的设计，是**这一刀不该切在分层上** —— 先解决「缺省值三处」，
  分层可以等某天某一层真的独立演化时再做（那时边界有事实依据，不是猜的）。

## 5. 对比

| 维度 | A 扁平快照 | B 分层 |
|---|---|---|
| 新增一个旋钮的改动面 | 2（类型 + 解析） | 3+（类型 + 归层 + 解析） |
| 缺省值决策点 | **1** | 1（但散在 5 个层的解析里） |
| 17 个消费点的改动 | 传参类型变，取值不变 | 取值路径也要变 |
| 迁移期并存风险 | 低（一条路径 + 对拍） | 高（两条路径并存） |
| 新增要学的概念 | 0（就是「解析后的选项」） | 5 个分组名 |
| 对外兼容 | 不变 | 不变 |

## 6. 落地顺序（三刀，每刀独立可发、独立可回）

1. **建而不接**：加 `RunPolicy` / `RunOptions` / `resolveRunPolicy`，与现有路径并存；
   加一条**对拍用例**：对同一组输入，`resolveRunPolicy(x)` 的每个字段 === 现路径的生效值。

   ⚠️ **这条用例的真实射程**：`runConfigSnapshot` 只记 16 个键（`config.model` /
   `maxTokens` / `maxIterations` / `maxTotalTokens` / `maxCostUsd` / `toolTimeoutMs` /
   `maxToolConcurrency` / `maxEventChars` / `maxToolResultChars` / `traceLimits.maxEvents` /
   `retry.maxAttempts` / `contextPolicy*` / `priceOverrides` / `fallbacks` / `labels` /
   `traceContent` / `resultSchema`），**覆盖不到** `client` / `tools` / `signal` /
   `onText` / `sessionId` / `approvals` / `events` 这类**函数与进程内对象**（它们本来
   就不可序列化，快照只记「配没配」）。所以第 1 刀的对拍管**标量策略**那一半，
   剩下那一半只能靠第 2 刀「每替换一个消费点就跑全门禁」逐点验 —— 别把这条用例
   说成「全部字段都有机器证据」，那是它做不到的。
2. **逐文件接线**：`loop.ts` → `turn.ts` → `mcp-server.ts` → `toolkit/module.ts` →
   `transport/run-call-options.ts`。每步只动一个文件、跑全门禁；`88` 处 `??` 里属于
   策略的那批逐个消失。
3. **删搬运**：删掉 `RunInvocationOptions` 里与 `RunAgentOptions` 重复的 25 个字段中
   **只用于内部传递**的那些（保留公开的那份声明），删掉 87 行逐字段搬运；
   `maxEventChars?:` 的**可选**声明从 **9 → 1**（只剩输入侧的 `RunOptions`；`RunPolicy` 里那处
   是必填，不算 `?:`）。

**每刀的验收指标**（可 grep，不靠感觉）：

```bash
grep -rn 'maxEventChars?:' src/ | wc -l    # 9 → 1（只剩输入侧那处可选声明；策略里是必填）
grep -rnE '^\s+maxEventChars: ' src/ | wc -l  # 搬运行数下降
npm test && npm run typecheck && npx biome ci . --error-on-warnings
```

## 7. 明确不做

- **不动 `AsyncRunnerOptions`**：那是**宿主**旋钮（并发、排队、流缓冲），与「一次 run 的
  策略」是两件事。混在一起会把宿主配置也塞进 RunPolicy，反而扩大接口。
- **不动 `TaskStore`**（另一件待定，属能力接口，见下一轮）。
- **不引 schema 库**：形状判定已有 `util/shape.ts` 那类纯件（harness）与各模块的构造期校验，
  本仓口径是零运行时依赖。

## 8. 风险与反证条件

| 风险 | 处理 |
|---|---|
| `false`（不截断）被折成 `Infinity` | 类型保留 `number \| false`；`runConfigSnapshot` 记 `'off'` 的口径不变 |
| 某字段在 3 个以上后台消费点需要**不同**缺省 | 它就不该进 `RunPolicy` —— 留在原处，本设计不追求「全字段收编」 |
| 迁移期两条路径算出不同值 | 第 1 刀的**对拍用例**就是为此存在；它红了说明缺省值还是两个答案，别往下走 |
| 公共类型删多了 | `index.ts` 三处导出（`RunAgentOptions` / `ExecuteRunOptions` / `RunInvocationOptions`）**一个都不删** |

**反证条件（出现任一条就回退到本文重写）**：① 第 1 刀的对拍用例需要按字段写 30 条例外；
② 接线过程中发现某消费点要读的其实是「**用户原样传了什么**」（而不是生效值）——
那说明 partial 也是一种真实的输入，A 的「内部只传生效值」前提不成立。

## 附录 A：复算脚本（上面每个数字都能重跑出来）

```bash
# 两个接口的字段数 / 可选数 / 同名字段
node -e '
const fs=require("fs");
function fields(file,name){
  const t=fs.readFileSync(file,"utf8");
  const start=t.indexOf("export interface "+name);
  let depth=0,i=t.indexOf("{",start),end=-1;
  for(let k=i;k<t.length;k++){ if(t[k]==="{")depth++; if(t[k]==="}"){depth--; if(depth===0){end=k;break;}} }
  const out=[];
  for(const line of t.slice(i+1,end).split("\n")){
    const m=line.match(/^  ([A-Za-z_][A-Za-z0-9_]*)(\?)?:/);
    if(m) out.push(m[1]+(m[2]?"?":""));
  }
  return out;
}
const a=fields("src/engine/types.ts","RunAgentOptions");
const b=fields("src/engine/spec.ts","RunInvocationOptions");
console.log(a.length, a.filter(x=>x.endsWith("?")).length);
console.log(b.length, b.filter(x=>x.endsWith("?")).length);
const bn=new Set(b.map(x=>x.replace("?","")));
console.log([...new Set(a.map(x=>x.replace("?","")))].filter(x=>bn.has(x)).join(", "));
'

# 声明处 / 引用数 / 逐字段搬运
grep -rn 'maxEventChars?:' src/ | wc -l          # 声明处（9）
grep -rn 'maxEventChars' src/ | wc -l            # 引用数（74）
grep -rnE '^\s+(maxEventChars|maxToolResultChars|maxTotalTokens|maxCostUsd|maxIterations|maxTokens|toolTimeoutMs|maxToolConcurrency|traceContent|approvals|approvalEpoch|usageOffset|priceOverrides):' src/ | wc -l   # 搬运（87）
```
