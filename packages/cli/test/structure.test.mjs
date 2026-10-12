import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/*
 * CLI（packages/cli）结构守卫 —— 方案 docs/plans/2026-09-23-cli-structure.md §3 横切 W。
 *
 * 为什么 CLI 需要单独一套：框架侧的 `tests/architecture/layering.test.ts` 守的是
 * 「分层单向 + 无环」，而 CLI 是**扁平**的一堆文件（没有分层可守）。真正会坏的形状是：
 *  - W1：文件越长越大却没人察觉（dev.ts 长到 1148 行、长出一台隐式状态机，就是这么来的）；
 *  - W2/W3：下发浏览器的模块悄悄多一条**值导入** ⇒ 产物带 `import './dev-protocol.js'` ⇒
 *    浏览器取不到（STATIC 白名单没有它）⇒ 面板白屏，而 node 侧单测照样全绿
 *    （它们 import 的是 TS 源，不受白名单约束）。
 *  - W4：并排 A/B 的**状态与 DOM 必须同源** —— 面板无 jsdom 单测，只能在文本层守
 *    「清空 `state.compare` 必须走 `exitCompare()`」（评审实证：漏一次就留下张冠李戴的
 *    右栏与差异摘要）。详见该用例的注释。
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const DIST_URL = new URL('../dist/', import.meta.url);

/** 下发浏览器的 CLI 自有模块（`inspector-routes.ts` 的 STATIC 白名单里、由页面 import 的那批） */
const BROWSER_MODULES = ['panel-logic', 'markdown'];

describe('CLI 结构守卫（W1 规模棘轮 / W2 产物零 import / W3 源码只 import type）', () => {
  // ---------- W1：规模棘轮（只许降不许升）----------
  // 基线 = 2026-09-23 治理启动时的实测（`wc -l packages/cli/src/*`）。
  // 纪律：存量条目只能**往下**调（拆分真做完了才调）；新增文件**必须**在这里登记
  // （不登记 = 「每个文件都在表里」那条断言会红）。棘轮在拆分期间持续偏红是有意的摩擦。
  const LINE_BUDGET = {
    // 2026-10-05（dev 调试工作台档 B —— **新功能**）：1241 → 1452（+211）= 双栏 DOM +
    // 差异摘要区 + CSS + 渲染函数 + ⌘/Ctrl 点击交互。设计稿
    // `docs/plans/2026-10-05-dev-workbench.md`。
    // ⚠️ **这一笔的测试覆盖率为零**：面板是本仓**唯一没有单测**的复杂逻辑
    //（`panel-logic.ts` 头注写明「所有判断都走 panel-logic，那份有单测，这份没有」）⇒
    // 这里的渲染逻辑只有 `scripts/e2e-dev.ts` 间接兜。**如实标注，不假装已被验。**
    // 下一步若还要长这个文件，该做的是**把这 211 行的判断抽进 panel-logic**，不是再抬基线。
    // 2026-10-05（面板那211 行的**补债**，见下）：1452 → 1459（+7 = import 两行 +
    // 接线改写）。**判断本身被搬走了**（`compareView` / `diffSideLabel` /
    // `diffValueText` / `diffFetchErrorText` 四条进panel-logic，本文件只剩 DOM 接线）
    // ⇒ 净增的是「接线 + 注释」，而**可测的判定面积变大**。
    // 2026-10-05（**评审修复**）：1459 → 1477（+18）。三笔，**都是评审实证的缺陷**：
    //   +14 普通单击改走 `exitCompare()`（原先只清 `state.compare`、不复位 DOM ⇒ 右栏与
    //       差异摘要留在屏幕上而选中标记已消失，张冠李戴）+ 抽出 `resetCompareDom()`
    //       消掉三处逐字重复的复位序列 + 那一大段「为什么必须走 exitCompare」的注；
    //   +5 `refreshCompare` 的 `!res.ok` 分支不再 `continue`（静默留白）而是显式说
    //       「读不到这条 run 的调用树（可能已被淘汰）」；
    //   −1 删掉只写不读的 `state.diff` 字段（同批 3 处引用）与其承诺了不存在渲染的注释。
    // 2026-10-05（**A/B 闭环补最后一跳**）：1477 → 1493（+16）= 收尾帧 `onmessage` 里
    //   `autoPairTarget` 判定 + 自动进双栏 + 列表高亮跟着左栏走 + 一条说明用处的 notice。
    //   判定本身在 panel-logic（可单测），本文件只留接线。
    'inspector-page.html': 1493,
    // 2026-09-23 A 阶段（抽纯判定 → dev-logic.ts）：1148 → 1133
    // 2026-09-23 B 阶段（显式状态机 → dev-machine.ts）：1133 → 1054
    // 2026-09-23 C 阶段（按职责切文件）：1054 → 776
    // （watch 件 → dev-watch.ts、子进程原语 → dev-child.ts；spawn/stop/restart 三个
    //   执行器读写机器状态，留在 dev.ts 接线层）
    // 2026-09-27 复核尾巴：776 → 779（+3，纯注释 —— pickFolder 的 pick-folder
    //   「纯标记效果」谜面注，见下方总量补账）
    'dev.ts': 779,
    // 2026-09-23（inspector 路由表拆分）：818 → 413。切走的 431 行去了
    // inspector-routes.ts；本文件只剩「服务」——监听 / 三道鉴权闸 / 应答原语 /
    // 公开类型（`DevHooks` 等）/ `HttpError`。那两个导出（`HttpError` / `startInspector`）
    // 是 `dev.ts` 与 `inspector.test.mjs` 的 dist 出口，不能动。
    'inspector.ts': 413,
    // 2026-09-23 新增（同上，**纯搬移**）：路由表（14 条路由各抽成命名函数）
    // + `RouteCtx` / `InspectorState` + `handleRoutes` 分发器 + 只被路由用到的件。
    // 2026-09-23 追加（面板卸载收口）：545 → 578（+33）= **15 条**路由 ——
    // 新增 `POST /api/fs/pick/cancel`（面板 `pagehide` beacon 打它）+ `PICK_CANCEL_PATH`。
    // 2026-10-05（档 B，**新功能**）：578 → 688（+110）= `handleRunCompare`（并排 A/B
    // 端点）+ `normalizeForDiff`。⚠️ 后者是**一笔自认的债**：它存在只因 `diffTraces` 的
    // `pushAttrDiffs` / `pushEventDiffs` 不接受 `undefined`，而 `diff.ts` 是
    // `src/engine/trace-diff.ts` 的**逐字同形移植副本** ⇒ 根治必须框架侧一起改
    // （`?? {}` / `?? []`），那属`src/` 语义变更、要走 spec §10。本次取「消费侧归一化」
    // 的零核心改动解 —— 如实记债，不假装它是必要开销。
    'inspector-routes.ts': 688,
    // 2026-10-05（档 B，**新功能**）：578 → 671（+93= 96 −3，biome 把 `comparability`
    // 的签名收成单行）= `toggleCompare` / `COMPARE_MAX` / `capsKey` / `comparability`
    // + 各自的口径注。**这一档的实质全在这里**（纯判定、可单测）。
    // 2026-10-05（**补债**：把面板里的判断搬进来）：671 → 735（+64）=
    //   `compareView`（三态视图判定）/ `diffSideLabel`（缺侧标签）/ `diffValueText`（差异取值）
    //   / `diffFetchErrorText`（失败文案）+ 各自的「判错会怎样」注。
    //   这四条原先长在 `inspector-page.html` 里**没有任何单测**（面板是本仓唯一
    //   没单测的复杂逻辑）⇒ 搬进来之后它们进了 `panel-logic.test.mjs` 的射程。
    //   净增 64 里大头是「为什么」的注释（判错的后果比函数体长，这是本仓记账惯例）。
    // 2026-10-05（A/B 闭环补最后一跳）：735 → 763（+28）= `autoPairTarget`（新 run 收尾
    //   在 **picking 态**时自动补第二条，把「改 prompt → 重跑 → 对照」从三步收成两步）
    //   + 它的判据注（为什么空选择/已选两条/同一 id 都**不**配对：前两者是替用户决定、
    //   挤掉刚选的那条）。**+28 里 22 行是注** —— 判据只有 3 行。
    'panel-logic.ts': 763,
    // 2026-10-05（档 A，**新功能**）：547 → 599（+52）= `registerJsonlSink()`（含它自己
    // 的三条纪律 + 「两个导出都要，缺一不可」那条实测坑）+ `main()` 里一行调用。
    'dev-runner.ts': 599,
    'diff.ts': 443,
    'harvest.ts': 389,
    // 2026-10-05（档 A，**新功能**）：323 → 337（+14）= `TRACE_LOG_REL` 常量 + 它的
    // 「为什么」注（含「只增不减」这个代价的如实标注）。**只是数据，零行为。**
    'dev-protocol.ts': 337,
    'markdown.ts': 296,
    // 2026-10-09（脚手架服务入口 start:server）：259 → 271（+12 = serverTs accessor +
    //   它的口径注「无条件生成 / 不许旁路 createApp」）
    // 2026-10-09 同日（脚手架默认入口翻成服务 —— **默认值翻转**，不是新功能）：271 → 280（+9）。
    //   改：mainTs 的口径注整段重写成「默认入口 = HTTP 服务」；增：batchTs accessor + 它的口径注、
    //   projectPackageJson 多一条「start / start:prod 同物」的注。
    //   ⚠️ serverTs **收敛成了** mainTs（同一个函数名换了模板），不是删了一个 accessor ——
    //   所以本表条目数不变。见 docs/plans/2026-10-09-scaffold-default-service.md。
    'templates.ts': 280,
    'doctor.ts': 213,
    // 2026-09-27（R8-P3b `agentia export` 命令注册）：206 → 219（+13 = import/帮助表/
    //   USAGE 表/分发分支，全是接线；新命令的本体在 export.ts）
    'cli.ts': 219,
    'native-pick.ts': 198,
    // 2026-10-12（**G6 会话 / 任务维度 —— 新功能**，设计稿
    //   `docs/plans/2026-10-12-observability-g6-g7-g8.md` §2）：194 → 339（+145）。
    //   实测构成（`git diff -U0` 数出来的，不是估的）：新增 150 行、改写掉 5 行 ⇒ 净 +145；
    //   新增的 150 行里 **55 行是注释或空行、95 行是代码**。
    //   ⚠️ 比设计稿估的「+60~90」**超了**。超出的是两处，都不打算省：
    //     ① `runCostUsd` 那段（含 7 行注）—— 它记的是**对设计稿的一处修正**：口径从
    //        「能力行 `costUsd` 相加」改成 `totalUsage.costEstimate`，因为前者在
    //        `@SubAgent` 套 `@Skill` 时会**重复计数**（capability span 的 usage 是子孙
    //        `llm.turn` 的聚合）。这类「为什么不用设计稿那个写法」的注删不得。
    //     ② `pad` 改成按**显示宽度**补齐（+10）—— `(无会话)` 是没配会话时的**唯一**一行，
    //        字符串长度补齐会把整张表右推 3 格。**纯展示、零行为**，但它是新表的第一印象。
    'report.ts': 339,
    // 2026-10-09（脚手架服务入口 start:server）：140 → 146（+6 = import + write 一行 +
    //   后续步骤文案两行 + serverTs 的接线注 —— `serverTs` 同批改名成 `mainTs`，见上一条）
    // 2026-10-09 同日（默认入口翻成服务）：146 → 148（+2 = 写出那两行的注释改写 +
    //   后续步骤文案多一行「跑一次就退出的批处理」）。新模板本体在
    //   templates/src/{main,batch}.ts，不在这个棘轮面内（归 tsconfig.templates.json
    //   与 templates.test.mjs 的形状断言照看）。
    'create.ts': 148,
    'dev-logic.ts': 58, // 2026-09-23 A 阶段新增（server 侧纯判定，单源化后注释只留一份）
    // 2026-09-23 B 阶段新增（显式状态机：类型 + update 纯函数；零副作用零 node:* import）
    // 2026-09-27 复核尾巴：703 → 708（+5，纯注释 —— abort-grace-expired 的相位弱化边界注）
    'dev-machine.ts': 708,
    // 2026-09-23 C 阶段新增（自 dev.ts 纯搬移；dev.ts 保留 re-export 守住 dist/dev.js 出口）
    'dev-watch.ts': 224,
    // 2026-09-26：82 → 112（+30）—— `killPlanFor` + `KillPlan` 判别联合 + 「为什么必须抽」的注释，
    // 见下方总量补账。
    'dev-child.ts': 112,
    'registry.ts': 93,
    'generate.ts': 82,
    'inspector-sink.ts': 75,
    // 2026-09-27 R8-P3b 新增：`agentia export`（trace → 训练数据 JSONL）。
    // 框架侧生成器（src/eval/export.ts）的去类型移植副本 + CLI 薄壳（过滤/落盘），
    // 逐字对拍守护在 test/export.test.mjs（同 harvest/diff 模式）
    // 2026-09-27（R8 评审 ⑨⑩⑪⑫ 修复 —— **行为变更**，不是搬移）：298 → 330（+32）。
    //   与框架侧 src/eval/export.ts 的 +31 同源：那条是**生成器本体**、这条是它的移植副本，
    //   两侧必须逐字对拍，所以不能只在一侧抽件（抽了就散了）。净增 = 两条收尾判据
    //   （正文缺席合取 / no-final-assistant）+ stdout 汇总 + 「为什么这么判」的注释。
    'export.ts': 330,
    'add.ts': 72,
    'npm-bin.ts': 59,
    'layout.ts': 51,
  };
  // 2026-09-23 实测总行数（`wc -l packages/cli/src/*`，wc 的计数 = 换行数）。
  // A 阶段后实测仍恰好 7410：dev.ts 1148→1133、新增 dev-logic 58，差额由同期
  // panel-logic 的收窄（578→535）吸收 —— 棘轮不抬。
  // ⚠️ B 阶段（2026-09-23）**抬了一次总量**：7410 → 8034。状态机文件的类型声明 +
  //   迁移规则注释（DevEventIn / DevEffect 两个判别联合）是净新增，而 dev.ts 里的
  //   watch / killTree / spawn 接线件要等 C 阶段才切出去 —— 方案 §3 B 预估的
  //   「dev.ts ~300 行 + dev-machine ~200 行」是 **B+C 做完之后**的形状。C 阶段
  //   拆分时必须把总量压回去（届时本条注释与基线一起调）。
  // C 阶段（2026-09-23）落账：8034 → 8062。B 注释里「C 阶段压回去」的承诺**只兑现了
  //   一半**：dev.ts 1054 → 776（watch 件与子进程原语各归各家），但总量**压不回 7410**
  //   —— 纯搬移的净增是 +28 行（两个新文件的头部注释 + import/re-export 行；搬走的
  //   「为什么」注释随代码走、行数原样带走），而 B 抬上来的 624 行里大头是
  //   dev-machine.ts 的类型与迁移注释本体，不是待切走的接线件。再往下降只能靠删注释
  //   或真删行为，都不是「纯搬移」该做的事 —— 如实记 8062，不留谎。
  // 补账（2026-09-23）：8062 → 8102（+40）。`inspector-page.html` 已经 import 了
  //   `filterSelected` / `formatToolSources` / `chatViewVisible` / `turnKey` 四个名字、
  //   `panel-logic.test.mjs` 也逐条钉了它们的行为，但 `panel-logic.ts` 里**没有实现** ——
  //   当时的工作区是**面板白屏**状态（浏览器 import 一个不存在的导出 = 整块模块求值失败）。
  //   这 40 行不是新功能，是把页面与测试**已经欠着**的东西补上；不补则面板起不来。
  //   `panel-logic.ts` 的单文件基线**没有为它抬价**（575 ≤ 578，走原基线）。
  // 补账（2026-09-23，inspector 路由表拆分）：8102 → 8242（+140）。
  //   搬移本身只带走 431 行，净增的 140 行**全是新文件的结构开销**，逐项：
  //     +21  inspector-routes.ts 头注（切分口径 / 依赖方向 / 为什么不是换 HTTP 框架）
  //     +15  import 块（原文件那批 import 要按「谁用谁引」在两个文件间重分）
  //     +14  InspectorState（4 个集合收成一个对象，好在 ctx 里整体传递）
  //     +30  RouteCtx（每请求一份的上下文；字段 = 原来闭包捕获的那批）
  //     +25  handleRoutes 分发器（原来是 handler 里一串 if，现在是「路径 → 命名 handler」）
  //      +9  14 个 handler 的函数签名与分隔空行
  //     +26  inspector.ts 侧：baseCtx 注入面 + state 对象化 + 解释「为什么切」的注释
  //   与 B / C 两次抬价的理由同类：**净增是注释与类型声明本体，不是待搬走的代码**。
  //   再往下降只能删注释或删行为 —— 都不是「纯搬移」该做的事，如实记 8242。
  // 补账（2026-09-23，面板卸载收口 —— **行为变更**，不是搬移）：8242 → 8290（+48）。
  //   +33  inspector-routes.ts：`PICK_CANCEL_PATH` 常量（含为什么必须有它那条实测记录）
  //       + `handleFsPickCancel`（403 闸 / 幂等 / 注释）+ 路由表那一行 + 两行顺序说明
  //   +15  inspector-page.html：`pagehide` → `sendBeacon` 的接线与它为什么不能只靠连接断开
  //   这一笔与前面几笔不同：**前几笔是「同一批代码换位置」，这一笔是真新增行为**。
  // 补账（2026-09-26，`killTree` 的平台分派可测化）：8290 → 8320（+30，全在 dev-child.ts）。
  //   这一笔与前几笔类别不同：**不是搬移、也不是新功能**，是把一条**测试够不着的平台分支**
  //   （win32 的 `taskkill /T /F` —— 它直接读 `process.platform`，于是 CI（ubuntu）与
  //   macOS 的 POSIX 分支都走不到它）变成可注入的纯函数 `killPlanFor(platform, pid, signal)`。
  //   净增 = 判别联合的类型声明 + 计划函数本体 + 「为什么必须抽」的注释；
  //   换来的是三平台分支各有用例（`packages/cli/test/dev-child.test.mjs`）。
  // 补账（2026-09-27，复核尾巴 —— **纯注释**，零行为变更）：8320 → 8328（+8）。
  //   +5  dev-machine.ts：abort-grace-expired 的相位弱化边界（相位随 restart 效果发出
  //       就落 idle、不等 stopChild 真停，以及为什么当前不可达）—— 评审建议级
  //   +3  dev.ts：pickFolder 的「pick-folder 是纯标记效果」谜面注 —— 评审建议级
  // 补账（2026-09-27，R8-P3b `agentia export` —— **新功能**，不是搬移）：8328 → 8639（+311）。
  //   +298  export.ts（新文件）：框架侧 src/eval/export.ts 的去类型移植副本 + CLI 薄壳
  //       （--out / --ok-only / --min-score 过滤与报错），逐字对拍守护在 test/export.test.mjs
  //   +13   cli.ts：命令注册接线（import / 帮助表 / USAGE 表 / 分发分支）
  // 补账（2026-09-27，R8 评审 ⑨⑩⑪⑫ 修复 —— **行为变更**，不是搬移）：8639 → 8671（+32）。
  //   全部落在 export.ts（见上方单文件基线的说明）——「CLI 移植副本与框架侧逐字对拍」
  //   这条不变量决定了这个涨幅不能靠抽件摊掉：两侧同增是**设计**，不是失守。
  // 补账（2026-10-05，dev 调试工作台档 A + 档 B —— **新功能**）：8671 → 9154（+483）。
  // 五笔逐项（与上面各文件的补账注一一对应，此处不重复解释）：
  //     +14   dev-protocol.ts      `TRACE_LOG_REL` 常量 +注（只是数据，零行为）
  //     +52   dev-runner.ts        `registerJsonlSink()` + `main()` 一行调用
  //    +110   inspector-routes.ts  `handleRunCompare` + `normalizeForDiff`（后者是自认的债）
  //     +93   panel-logic.ts       `toggleCompare` / `COMPARE_MAX` / `capsKey` / `comparability`（biome 格式化 −3）
  //    +211   inspector-page.html  双栏 DOM + 摘要区 + CSS + 渲染 + ⌘/Ctrl 交互
  //   ─────
  //    +483   五笔之和；实测总量 +486（差 3 = `dev-machine.ts` 等未动文件在同批的净变化，
  //           以 `TOTAL_BUDGET` 的实测值为准，逐文件基线见上）
  //⚠️ 上行那句「差 3」的成因**没有逐行核过**，故只作备注、不当结论 —— 记账纪律与
  //  §2「数字会腐烂，能现算的别信这里写的」同源：总量以断言实测为准。
  //
  // ⚠️ **这一笔的性质与前面十笔都不同，必须说清**：前面那些是「纯搬移的净增是结构开销」
  // 或「纯注释」，本笔是**真新功能**，且其中 **211 行（面板）+ 110 行（路由）此前无单测**
  // —— 守卫覆盖到的是**基线数字本身**，不是这批新行为。真正的行为断言在
  // `test/inspector.test.mjs`（compare 路由三态：顺序 / 可比性 / 归一化）与
  // `test/panel-logic.test.mjs`（判据六条），两者都做过**变异反向验证**。
  //
  // 补账（同日，**补债**：把面板里的判断搬进 panel-logic）：9154 → 9225（+71）。
  // 两笔：panel-logic +64（四条新纯判定，详见该文件的补账注）、inspector-page.html +7
  // （import 两行 + 接线改写；**判断本身是搬走的**，净增里大头是接线与注释）。
  // ⚠️ 这一笔**不是**「零测试覆盖的新功能」，而是**把已有行为从无测试区搬进有测试区**
  // —— 与上一笔性质相反，两笔都留着才看得出这笔的分量。上行「面板 211 行仍是覆盖缺口」
  // 那句**在同日已部分兑现**（四条判断搬出来了；纯 DOM 接线仍未覆盖，如实保留该句）。
  //
  // 补账（同批，**评审修复**）：9225 → 9243（+18，**全在 `inspector-page.html`**）。
  // 三笔都是评审实证的**缺陷**，不是新功能：① 普通单击不复位 DOM（那次评审里唯一
  // 用户可见的一个）；② `refreshCompare` 读不到 trace 时静默留白；③ 删只写不读的
  // `state.diff`。⚠️ ① 的修复**顺带补了文本层守卫 W4**（`state.compare = []` 只许在
  // `exitCompare` 里）—— 面板无 jsdom 单测，这 +18 里**真正被自动验证的只有 W4
  // 覆盖的那个形态**；其余两笔的验证仍是「读代码 + e2e-dev 兜端到端」，如实标注。
  //
  // 补账（同批，**A/B 闭环补最后一跳**）：9243 → 9287（+44 = panel-logic +28 +
  // inspector-page.html +16）。**新功能，但很小**：一个纯判定（3 行）+ 一处接线。
  // ⚠️ 与上一笔的分野：那条 +18 修的是**缺陷**，这笔加的是**承诺兑现**（设计稿 §0 说
  // 「改一句 prompt 就能立刻重跑对照」，原先要手动 ⌘ 点两条）。判据 `autoPairTarget`
  // 有单测（6 个断言）且做过变异验证（把 `length !== 1` 改成 `!== 2` ⇒ 红）。
  // 补账（2026-10-09，脚手架服务入口 start:server —— **新功能**）：9287 → 9305（+18）。
  //   两笔：templates.ts +12（serverTs accessor —— 即今日的 `mainTs`，同批改的名；+ 口径注）、
  //   create.ts +6（接线 + 文案）。新模板本体当时在 templates/src/server.ts（87 行），
  //   不在这个棘轮面内（它归 tsconfig.templates.json 与 templates.test.mjs 的形状断言照看）。
  //   ⚠️ 路径与函数名都已随下面那笔改名（`server.ts` → `main.ts`、`serverTs` → `mainTs`），
  //   此处保留旧名只为对齐当时的提交。
  // 补账（2026-10-09 同日，脚手架默认入口翻成服务 —— **默认值翻转**）：9305 → 9316（+11 =
  //   templates.ts +9 + create.ts +2，两处都在**原位**改了数值并各自写明组成）。
  //   ⚠️ 本笔的性质：**不是新功能** —— HTTP 宿主与批处理两个入口此前都在（#224 刚落的），
  //   这一笔翻的是「哪一个才叫 `npm start`」。之所以还是要补账：棘轮管的是行数，不是功能。
  // 补账（2026-10-12，G6 会话 / 任务维度 —— **新功能**）：9316 → 9461（+145，**全在
  //   `report.ts`**，逐块与「为什么超了设计稿估算」见上方该文件的基线条目）。
  //   ⚠️ 本笔与「纯搬移」「纯注释」那几笔不同：是**真新增行为**，且带 6 条新用例
  //   （`report.test.mjs`：归组 / 无会话桶 / task 回退键 / 降序 / 成功数为 0 ⇒ `-` 的
  //   **反向断言** / 成本读不出 ⇒ `-`），四条变异体各自咬住了预期的那一条。
  const TOTAL_BUDGET = 9461;

  it('W1 规模棘轮：单文件不超基线、总量不超基线、每个文件都登记在表', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts') || f.endsWith('.html'));
    let total = 0;
    const problems = [];
    for (const f of files) {
      // 与 `wc -l` 同口径：数换行符（文件末的尾换行使 split('\n').length 会多 1）
      const lines = (
        readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').match(/\n/g) ?? []
      ).length;
      total += lines;
      const budget = LINE_BUDGET[f];
      if (budget === undefined) {
        problems.push(`新文件 ${f} 没在 LINE_BUDGET 里登记（新增文件必须显式登记基线）`);
      } else if (lines > budget) {
        problems.push(`${f} 超了：${lines} 行 > 基线 ${budget}（棘轮只许降不许升）`);
      }
    }
    const unregistered = Object.keys(LINE_BUDGET).filter((f) => !files.includes(f));
    for (const f of unregistered) {
      problems.push(`${f} 在基线表里但文件不存在了（删文件要把基线条目一起删）`);
    }
    if (total > TOTAL_BUDGET) {
      problems.push(`总行数 ${total} > 基线 ${TOTAL_BUDGET}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  // ---------- W3：源码侧前置（不依赖 dist 就能红）----------
  it('W3 下发浏览器的模块只许 `import type`（值导入 ⇒ 产物带真 import ⇒ 浏览器 404 ⇒ 白屏）', () => {
    for (const name of BROWSER_MODULES) {
      const src = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
      assert.equal(
        /^import\s+(?!type\b)/m.test(src),
        false,
        `${name}.ts 出现了值导入 —— 它会随产物下发浏览器，而 STATIC 白名单里没有它的依赖`,
      );
      assert.equal(
        /^export\s*(\*|\{[^}]*\})\s*from/m.test(src),
        false,
        `${name}.ts 出现了 re-export —— 同上，产物会带真 import`,
      );
    }
  });

  // ---------- W2：产物侧（真 import 在编译后才现形）----------
  const distMissing = BROWSER_MODULES.some((f) => !existsSync(new URL(`${f}.js`, DIST_URL)));
  if (distMissing) {
    distReadyOrLoud(
      fileURLToPath(new URL('../dist/panel-logic.js', import.meta.url)),
      'CLI 构建产物',
    );
  }
  it('W2 产物 panel-logic.js / markdown.js 运行期零 import', { skip: distMissing }, () => {
    for (const name of BROWSER_MODULES) {
      const built = readFileSync(new URL(`${name}.js`, DIST_URL), 'utf8');
      // 只看**行首**：tsc 会保留注释（块注释里可能出现 "import" 字样），行首的才是真语句
      assert.equal(
        /^import\s/m.test(built),
        false,
        `dist/${name}.js 带有运行期 import —— 浏览器取不到它的依赖（STATIC 白名单），面板白屏`,
      );
      assert.equal(
        /^export\s*(\*|\{[^}]*\})\s*from/m.test(built),
        false,
        `dist/${name}.js 带有 re-export —— 同上`,
      );
    }
  });

  // ---------- W4：并排态的状态与 DOM 必须同源 ----------
  it('W4 并排态：`state.compare = []` 只许出现在 exitCompare 里（清状态必须伴随 DOM 复位）', () => {
    // **为什么这条存在**（2026-10-05 入库前评审实证的缺陷）：run 列表的**普通单击**分支
    // 只做 `state.compare = []` 而**不复位 DOM** ⇒ 右栏残留上一对的调用树、差异摘要还是
    // 上一对的 diff、`cmp-on` 布局仍在，而列表里的 `.run.cmp` 标记已经消失 ⇒ 用户按看到的
    // 读，读到的是**张冠李戴**（正是该段注释自己写明要避免的形态）。
    //
    // 修法就是让「清空」只能走 `exitCompare()`（它内部调 `resetCompareDom()`）。
    // 面板是本仓唯一没有单测的复杂逻辑（无 jsdom），所以只能在**文本层**守这一条。
    //
    // ⚠️ **射程**：守的是「裸清空」这个**已知形态**。`state.compare.length = 0` /
    // `splice(0)` 之类绕过不在射程内 —— 与 W2/W3 同款定位：守卫不是证明，是「有人
    // 再犯同一个形态时会被叫醒」。面板若将来有了 jsdom 单测，这条可以退成备忘。
    const html = readFileSync(new URL('../src/inspector-page.html', import.meta.url), 'utf8');
    const clears = [...html.matchAll(/state\.compare\s*=\s*\[\s*\]/g)];
    assert.equal(
      clears.length,
      1,
      `\`state.compare = []\` 出现了 ${clears.length} 次（只许 1 次，在 exitCompare 里）——` +
        ' 别处清空会让 DOM 留在屏幕上（右栏与差异摘要还是上一对的）',
    );
    const fnStart = html.indexOf('function exitCompare()');
    assert.ok(fnStart > 0, '找不到 `function exitCompare()`（改名了？那这条守卫要跟着改）');
    const fnEnd = html.indexOf('\n      }', fnStart);
    const at = clears[0].index;
    assert.ok(
      at > fnStart && at < fnEnd,
      '清空 `state.compare` 不在 `exitCompare` 内 —— 新加的清空点必须调 `exitCompare()`',
    );
  });
});
