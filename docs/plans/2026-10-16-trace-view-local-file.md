# 本地 trace 查看：业界调研（2026-10-16）

**状态**：调研稿（第 0–3 节）**＋ 已定案并实施**（第 4–6 节）。
目标是回答「落盘 / 生产的 trace 该用什么看」。**结论已落地为 `agentia view`**（O2 单文件 HTML），
决策登记在 `docs/spec.md` §10 2026-10-16 ⑤ ref-view-single-file-html。
⚠️ 第 6 节「调研边界」依然有效 —— 那里如实标了哪些证据是一手、哪些是二手。

## 0. 一句话结论

**业界在 2026 年已经收敛了答案：不是「起个本地服务」，是「渲成单文件自包含 HTML」。**
四个互不相干的 agent 项目（agentskit / telltrace / claude-tap / AgentCanvas）不约而同选了同一形态，
且都带同一个附加动作 —— **渲染时默认脱敏**。这对我们不是「多一个选项」，而是「别再自己发明」。

⚠️ 但这跟我们仓里一条**已定死的缝**正面撞上（脱敏划在 sink 缝外）。第 4 节专门处理，那是本设计唯一的硬决策。

## 1. 要回答的问题

`agentia dev` 的面板是**在飞**的：run 列表是内存 ring（50 条），重启即空。
`.agentia/traces.jsonl` 让数据**没丢**，但 CLI 9 个子命令里没有任何一个能**把它画出来** ——
`report` 给排行、`diff` 给逐 span 差异、`harvest` / `export` 给文本产物，**全是文本侧**。

所以缺的是「事后看一棵树 / 把一棵树发给别人」。问题拆成三个：

1. 形态：起服务（`agentia dev` 同款）还是出文件？
2. 输入：读 `.jsonl` 自有格式，还是转 OTLP 交给现成查看器？
3. 出口：产物天然要被转发 ⇒ 谁负责脱敏？

## 2. 业界四族

| 族 | 代表 | 怎么拿到数据 | 形态 | 证据强度 |
|---|---|---|---|---|
| **A 推送式本地查看器** | otel-desktop-viewer | 只收 OTLP（:8000 UI） | 常驻服务 + DuckDB | 一手（仓库 + commit） |
| | Arize Phoenix | 只收 OTLP（:6006 UI + :4317） | 常驻服务 + SQLite | 二手（教程站） |
| | otel-tui | OTLP **或 `--from-json-file`** | 终端 UI | 一手 README（经镜像） |
| **B 文件 → 单文件 HTML** | Speedscope | `speedscope <file>` | 浏览器 / 自包含 zip | **一手（官方 README）** |
| | agentskit | `renderTraceViewerHtml(report)` | 单文件 HTML | **一手（官方文档站）** |
| | telltrace | `telltrace <x.jsonl> --open` | 单文件 HTML | 二手（npm 聚合页） |
| | claude-tap | 运行结束自动出 HTML | 单文件 HTML | 二手（中文博客） |
| | AgentCanvas | Logfire → `-o report.html` | 单文件 HTML | 二手（新闻聚合） |
| **C SaaS 分享链接** | LangSmith / Langfuse | 云端 | public link | **一手（官方文档）** |
| **D 通用 trace 平台** | Jaeger / Tempo / Grafana | 需要部署后端 | 服务 | —— 不在射程内 |

### 族 A：推送式，且标杆自己也在补「读文件」

otel-desktop-viewer（1,250★，Apache-2.0，单 Go 二进制 + 内嵌 collector + DuckDB + Svelte UI）的设计哲学写得很直白：

> 本地调试器和生产工具的需求不同……我们本地可能总共就四条 trace，根本不该先让你搜索。
> 所以它像 `tail -f` 一样**数据到了就全展示**。

值得抄的是这句**判据**，不是它的架构。它对我们是**反例**：它是「先把服务跑起来、再把数据喂进去」，
而我们的场景是「数据已经在盘上」。

⚠️ 一个容易误报的点：它**没有** CLI 级 `--file`。2026-10-10 的 #592 加了「从 Web UI 导入 OTLP JSON/JSONL」，
但导入路径是**前端解析 → 发回本机 OTLP HTTP 端口**（20 MiB 一批）—— 文件只是入口，摄取仍走网络。
谁要是说「otel-desktop-viewer 支持打开文件」，那是把 UI 导入当成了 CLI 能力。

`otel-tui` 才是真有 CLI 文件入口的那个：`--from-json-file <OTLP JSON 导出文件>`。
AWS 的 Strands 项目文档里给的就是这条命令 —— 说明生态里「OTLP JSONL，一行一个 export request」已经是**公认的落盘格式**。

### 族 B：单文件 HTML 是 agent trace 的事实标准

这一族的共同点惊人地一致，值得逐条抄：

- **agentskit**：`createFileTraceSink('./traces')` 落盘 + `renderTraceViewerHtml(report)` 出 HTML。
  官方原话：「a single-file gantt view」「self-contained page with no external requests」「open offline, share as an artifact」。
- **telltrace**：`telltrace <session.jsonl> --open`，「One self-contained HTML file. No server, no login, works offline. Drop it in Slack, attach it to a PR」。
  **并且渲染时自动 redact** 常见凭证形态（`sk-` / `ghp_` / `AKIA` / JWT / `Bearer` / `password=`），替换成 `[redacted]`；
  还明写「Redaction is best-effort」、以及「所有会话内容先 HTML-escape，恶意字符串不能在查看器里执行脚本」。
- **claude-tap**：双模 —— `--tap-live` 实时看，每次运行结束**自动**生成自包含 HTML；`dashboard` 看历史；auth header 脱敏。
- **AgentCanvas**（Pydantic AI + Logfire）：单文件 HTML、可离线、可发同事，CLI 有 `--list` / `--trace-id` / `-o` / `--no-open`。

**CLI flag 的共性**（照抄即可，别再发明）：`--open`（渲完直接开浏览器）/ `-o <file>` / `--no-open` / `--list` / `--trace-id <id>`。

### 族 C：分享链接 —— 与我们定位不符，但有一条要抄

LangSmith 官方文档在「Share a trace」页正文第一句就是加粗警告：

> Sharing a trace publicly will make it accessible to anyone with the link. **Make sure you're not sharing sensitive information.**

Langfuse 同理（public link 免登录可读）。它们要云端账号，与 agentia 的 local-first 不合；
但**「可分享 ⇒ 先警告敏感信息」这条纪律要抄进我们的产物**。

## 3. 收敛出的三条事实标准

1. **形态**：单文件自包含 HTML（无外链、无 server、离线可开、天然可转发）。
   理由是它同时解决了三个问题：看、存、发。起服务只解决「看」。
2. **CLI 形态**：`<file> --open -o <out> --list --trace-id <id>`，退出码/静默与否照 `harvest` / `export` 的既有口味。
3. **脱敏默认开**：产物的默认命运是「被转发」，所以默认必须脱敏 + 明示 best-effort + HTML-escape。
   这不是洁癖，是 telltrace / claude-tap 两个独立项目各自得出的结论。

## 4. 落到 agentia

### 4.1 仓内已有（先数清楚，别重复造）

| 现成的 | 位置 | 说明 |
|---|---|---|
| 渲染器 | `packages/trace-view/src/` | 零依赖 ESM，**35,510 字节**（index 407 + view 13,392 + fromTrace 7,401 + summary 7,572 + css 6,738） |
| 已有构建步骤 | `packages/trace-view/package.json` → `scripts/build.mjs` | 所以「再产一个 bundle」是**构建期**的事，**不动运行时零依赖** |
| 现在怎么分发 | `inspector-routes.ts` 发 `/index.js` `/trace-view.css` `/markdown.js` | 面板 `inspector-page.html` 是 `import ... from './index.js'`，**靠 HTTP 分文件** |
| 脱敏实现 | `examples/observability/src/index.ts` 的 `redactSink` | **有真实现且被 `tests/docs/observability.test.ts` 测着**（6 个预设：bearer/jwt/aws-access-key/llm-api-key/email/phone-cn，深拷贝不改原 trace） |
| 用户输入解析 | `packages/cli/src/report.ts` 的 `extractTrace` | 裸 Trace / `result.trace` / `trace` 三种记录形态都认，**直接复用** |

⇒ 单文件 HTML 的可行性由「35KB 渲染器 + 已有 build.mjs + 已有 extractTrace + 已有 redactSink」四项共同支撑。
**唯一的新东西是把 ESM 分文件变成单文件**（构建期打包），其余全是接线。

### 4.2 三个方案

| | O1 起服务 | **O2 单文件 HTML（推荐）** | O3 转 OTLP 交给别人 |
|---|---|---|---|
| 命令 | `agentia view <f>` 起本地 server | `agentia view <f> [-o out.html]` | `agentia export --otlp` + `otel-tui --from-json-file` |
| 新代码 | 复用 inspector 静态路由，小 | 中（trace-view 加 bundle 产物 + 一个拼装模块） | 小（OTLP 落盘），**但查看器零代码** |
| 端口 / 鉴权 | **要**再付一遍 D0 两道闸（Origin + token） | **零**：没有 server 就没有面 | 别人的 |
| 可转发 | ❌ 只能自己开着看 | ✅ 贴 PR / 发同事 | ✅（OTLP 文件本身可转发） |
| 信息保真 | 100% | 100%（自有格式直渲） | ❌ 只剩 OTLP 投影，丢 `agentia.*` 与工具 I/O 配对语义 |
| 用户负担 | 无 | 无 | **要装一个 Go 二进制** |
| 与 `agentia dev` 关系 | 概念重叠（两个 server） | 互补（dev=在飞，view=归档） | 无关 |

**推荐 O2**，理由按重要性排：
① 一次性看文件不该再付一遍鉴权税（inspector 那套 D0 是「有 server」的代价）；
② 「可转发」是 `report` / `diff` 给不了的能力；
③ 与 `agentia dev` 互补而非重叠 —— claude-tap 的「live + 归档」双模正是这个分工。

### 4.3 唯一的硬决策：脱敏

**冲突**：`src/core/trace.ts:79` 白纸黑字 ——

> 脱敏**不在框架内** —— 那是 sink 缝外的事（spec §9.3），框架只保证出口形状。

`docs/observability.md` §2.4 还补了一句更狠的：「顶部那张『不内建表』里它仍标 ❌，**不要当成待办把它搬回框架**」。
而族 B 全部项目在出 HTML 时**默认脱敏**。

**调和（我的建议）**：这两条并不矛盾，因为**CLI 不是框架**。
§2.4 自己的措辞就是「脱敏划在 sink 缝外（**宿主职责**）」—— CLI 正是宿主。
所以「CLI 出 HTML 时默认脱敏」是**执行**既定缝，不是把脱敏搬回框架；`src/` 仍然零改动。

具体做法（沿用仓内既有纪律）：像 `harvest` / `export` 那样做**去类型移植**，把 `redactSink` 的 6 个预设
搬进 CLI 的一个小模块（CLI 零运行时依赖，不能直接 import `examples/`），由对拍测试钉住「与 `examples/observability` 逐字同形」——
这跟 `export.test.mjs` 现在守的事是同一件。

**必须同时做的三件事**（缺一件就是假账）：
1. 产物里**可见**地标「已脱敏 · best-effort · 覆盖 X 类」（trace-view 那边的既有口味：替换文案带类别标签，不静默）；
2. 全量 HTML-escape（trace 含模型输出，等于不可信输入 —— 面板那条 XSS 修复过一次，别在同一个面上再犯）；
3. `--raw` 显式关闭脱敏，且此时产物打**水印** + stderr 打一句警告（对齐族 C 那条「分享前先警告」）。

### 4.4 体量与闸门（新增代码要过的坎）

- `packages/cli` 有 **LINE_BUDGET + TOTAL_BUDGET 棘轮**（`packages/cli/test/structure.test.mjs`）⇒ 新文件要补账 + 写「为什么」。
- 单文件 HTML 会**全量内联 trace** ⇒ 必须有上限（`--limit N` / 只取前 N 条 + 超了明说，不许静默截断——这是本仓最忌的形状）。
- 新守卫照 `docs/guards.md` §1.2 登记一条（模板/产物对拍类）。

## 5. 三个开放问题的处置（2026-10-16 已定）

1. **转不转 OTLP**：**不转**（先只做 O2）。理由照旧 —— 族 B 已证明自有格式直渲更保真，
   而 OTLP 那条是**给别人**用的（otel-tui / otel-desktop-viewer），等真有人要再做。
   ⇒ 附带结论：`export --otlp` **不做**，不在本轮范围。
2. **`--list` 值不值**：**不做**。`agentia view --list` 与 `report` 重叠（都列 id / 时间 /
   status / 成本），新开一个命令只会让「该用哪个」变成新的问题。
   ⇒ `view` 只做**渲染**这一件事；要看清单用 `report`，要挑一条用 `--trace-id`。
3. **bundle 会不会变成第二份渲染**：**不会，前提是它是构建期从 `src/` 自动派生的**。
   这一条是整个方案成立与否的关键，所以机制上钉死三点：
   - 导出名与依赖顺序**现场解析**（不硬编码清单）⇒ src 加模块 / 加导出会自动跟上；
   - 撞名 / 循环依赖 / 引用不存在的模块 ⇒ 构建期**响亮报错**（拼坏了是整页白屏，不能静默）；
   - `test/bundle.test.js` 钉「导出面一致 + 每个模块都进了 bundle + 两次构建字节相同」。
   ⇒ 面板与官网**继续用分文件**（它们不需要内联），所以「同一个 trace 在两个地方长得不一样」
   这个病不会发生：三种形态同源，`src/` 仍是唯一真源。

## 5.1 实测（2026-10-16，动手前跑的探针 —— 第 4.1 节那些数字是推算的，这里是跑出来的）

探针在 `.workbuddy/probes/`（已 gitignore，不进仓）：

| 项 | 推算 | **实测** |
|---|---|---|
| 一条带工具调用的 trace 体积 | —— | **2,045 字节**（`spans` 3 / 事件挂在 `spans[].events[]`，**顶层没有 `events`**） |
| 敏感串落在哪 | 猜在 tool I/O | `$.spans[1].events[1].body.content`（**span 内事件的 body**）⇒ 脱敏必须递归到这一层 |
| bundle 能否被真 import | 未验 | ✅ 10 个导出符号，与 `dist/index.js` **逐字一致** |
| `playTrace` 能否真渲 | 未验 | ✅ 29 个 DOM 节点，树形文本完整（`run → llm.turn → tool.input/tool.output`） |
| 不脱敏会不会泄密 | 推断 | ✅ **三种形态（sk- / Bearer / password=）原文全在渲染文本里** —— 不是推理，是抓到的现场 |
| 内联基线 | 35,510 字节（src 合计） | bundle **29,012 B** + css **6,738 B** + 一条 trace 2,045 B ≈ **38 KB**；50 条 ≈ 138 KB |

⚠️ 实测反而**推翻**了一条乐观假设：预设 6 类里**没有 `password=`**，所以「默认脱敏」的覆盖面
比业界（telltrace 明确覆盖它）**窄**。处置不是偷偷加规则（那会与 `examples/observability` 漂移），
而是把类名与边界**写进产物 banner**，并给 `--redact-key` 作为业务字段的兜底口子。

## 6. 调研边界（如实）

- **一手核实过**：Speedscope（官方 README）、LangSmith / Langfuse（官方文档）、agentskit（官方文档站）、
  otel-desktop-viewer（官方仓库，但 README 未全文取到，结论来自仓库描述 + commit 信息）。
- **二手（转述，存在误差可能）**：otel-tui（GitHub README，经镜像站）、telltrace（npm 聚合页）、
  claude-tap（中文博客）、AgentCanvas（新闻聚合）、Phoenix（教程站）。
  ⇒ 这几条里**凡是带具体数字/flag 的**，动手前建议回源核一次。
- **没做**：没有真跑这几个工具（本机没装），也没有实测「35KB 内联后浏览器表现」。
  单文件可行性是按体量**推算**的，不是跑出来的。
- **没查**：没有系统检索 npm / PyPI 上的全部同类（只覆盖了搜得到的头部），不排除有更贴近的先例。
