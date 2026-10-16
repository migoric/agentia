# 2026-10-17 rapid 分片前置 + 方法级体量闸的三处外移（附：棘轮腾余量的实证结论）

**依据**：本轮深度评估的两个实测结论 —— ① `rapid` 分片「不需要构建产物」是假承诺；
② 方法级体量闸 TOP2 的余量只剩 4~5 行。

## 0. 两条判据

1. **缺前置条件时响亮失败，不给假信号**：`rapid` 在缺 `dist` 时吐 30 条 `TS2307` 级联，
   那 30 条里没有一条是真缺陷 —— 它比报错更坏（让人以为自己改坏了东西）。
2. **纯搬移，零行为变化**：拆分不夹带任何语义调整；每处的「为什么抽」写在函数头注里。

## 1. rapid：读数是 1/3 与 3/3

| 条件 | 实测 |
|---|---|
| 干净克隆（无 `dist`）跑 `bash scripts/verify-all.sh rapid` | **1/3**，30 条 TS 错误（`TS2307` + 由它引发的 `Unused '@ts-expect-error'`） |
| `npm run build` 之后 | **3/3** |

那 30 条错误的**成因链**：`tests/types/dx.types.ts` / `scripts/e2e-cli.ts` 从
`../../dist/index.js` 导入（`e2e-cli.ts:20` 的注释写明「从 dist 而非 src 导入」是刻意的）
⇒ 缺产物时模块解析失败 ⇒ 类型退化成 `any` ⇒ 依赖「应当报错」的 `@ts-expect-error`
变成 unused。**修复不是**把它们移出 `rapid`（那三步确实该一起跑），而是在缺产物时停下。

## 2. 方法级体量闸：三处外移的读数

闸在 `tests/architecture/method-size.test.ts`（单个体 ≤ **240** 行）。抽前读数：

| 可调用体 | 抽前 | 余量 | 抽后 | 新余量 |
|---|---:|---:|---:|---:|
| `toolkit/module.ts :: constructor` | 236 | 4 | **195** | 45 |
| `integrations/mcp-stdio.ts :: createStdioMcpConnector` | 235 | 5 | **206** | 34 |
| `integrations/metrics-render.ts :: renderPrometheus` | 224 | 16 | **187** | 53 |

抽后全仓 TOP1：`engine/loop.ts :: agentLoop` **218**（余量 22）。

### 抽出的三件（都是「同源但不同责」）

| 抽出物 | 落点 | 依据 |
|---|---|---|
| `assertNoCapabilityCycle` / `assertNoDuplicateToolNames` | `module.ts` 模块级（与既有 `assertNoSubmenuDuplicate` / `warnDuplicateTokens` 同处） | 装配期的**一趟完整校验**，与构造里「读选项、建容器」不同源 |
| `attachResponseReader` | `mcp-stdio.ts` 模块级 | 与连接器状态的交互只有三处（stream / pending / onOverflow）；`buf` 只在该 handler 里用（已核：文件其余位置零引用）⇒ 随它搬进去当局部状态 |
| `appendRunFamilies` | `metrics-render.ts` 模块级 | 四个 run 级家族是同一件事（「全局 + 每类标签」的并列展开） |

### 刻意**没有**做的

**不拆 `agentLoop`（218 行）**：它是主循环、回合间状态收在 `LoopContext` 里一气呵成。
本仓对「不该拆的大函数」有既定态度（`source-size.test.ts` 头注：「报告 §2 那批最长也只有
260 行**代码**」）⇒ 拆它换来的余量不抵可读性损失。

## 3. 附：棘轮「真腾余量」的实证结论（**未完成，如实标注**）

用户选择的口径是「真腾余量：拆代码」。实证下来这条路**比预期窄得多**：

| 可能路径 | 实证 | 结论 |
|---|---|---|
| 删死代码 | 全仓口径扫描：`packages/cli/src` 的 190 个导出里，**除定义处外零出现的是 0 个** | 腾不出 |
| 合并重复 | `duplicated-blocks.test.ts` **已覆盖 `packages/*/src`**（含 CLI），剩下的逐字副本都登记在 EXEMPT 里 | 腾不出 |
| 拆到新文件 | 棘轮按 `readdirSync(src)` 统计**顶层平铺文件** ⇒ 搬移后总量**不变**（HTML 少 249 行、新文件多 249 行） | 无效 |
| 拆到子目录 / `src` 外 | 不入统计面 ⇒ 总量"降"而代码一行没少 | **绕过，不做**（违反棘轮本意） |

⇒ **真降总量的唯一诚实路径是「精简实现」**（合并相似逻辑、缩短冗余写法），那是逐文件审读
9560 行的深水区，收益不确定且要动行为。**本轮不做**，留给下一轮单独决策。
⚠️ 所以本轮的结论是：`packages/cli` 的 `TOTAL_BUDGET` 余量**仍是 0** —— 不变，但也不假装变了。

## 4. 验证

| 项 | 结果 |
|---|---|
| `tests/toolkit/**` + `engine/loop.test.ts` | 180 pass / 0 fail |
| `tests/integrations/mcpConnector.test.ts` | 48 pass / 0 fail |
| `tests/integrations/metrics.test.ts` | 59 pass / 0 fail |
| `bash scripts/verify-all.sh` | **8/8 全绿** |
| 缺产物跑 `rapid` | exit 2 + 明确下一步（有产物时 3/3，与改前一致） |
