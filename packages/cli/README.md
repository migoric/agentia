# @migor/cli

Agentia 框架的命令行工具：脚手架、能力生成、本地调试与 **trace 观测**。

```bash
npx @migor/cli create my-app       # 脚手架：四分类目录 + src/registry.ts + src/app.ts + src/main.ts + src/batch.ts
cd my-app && npm install           # 框架与 CLI 都进工程（CLI 在 devDependencies）
npx agentia g subagent doc-reviewer # 生成能力并自动登记到注册表
npm run dev                        # = agentia dev：本地 inspector 面板（输入 prompt / 选能力 / 选工作目录）
npx agentia doctor                 # 装配体检：未登记 / 悬空能力、命名规范、重复条目
npx agentia add <pkg>              # 安装第三方能力包并登记
npx agentia --version              # 版本（= -v）
```

> 首次创建必须带 scope（`npx @migor/cli`）—— npm 上另有一个别人的 `agentia` 包。
> 工程内用短名 `npx agentia` 走的是本地 bin（CLI 已进 `devDependencies`：离线可用、版本与框架同批 pin）。
> 想全局装：`npm i -g @migor/cli`。

## 命令

| 命令 | 作用 |
|---|---|
| `agentia create <name>` | 脚手架新项目：`src/tools` · `src/skills` · `src/prompts` · `src/subagents` 四分类目录、`src/registry.ts` 注册表、`src/app.ts`（装配工厂）+ `src/main.ts`（**默认入口 —— HTTP 服务**，`npm start` 起的就是它）+ `src/batch.ts`（一次性入口，`npm run start:batch`）+ `src/dev.config.ts`、tsconfig。CLI 本身也装进工程的 `devDependencies` |
| `agentia g <type> <name>` | 生成能力（`tool` / `skill` / `subagent` / `prompt`）到对应分类目录 `src/<分类>/<name>/` 并登记注册表；长文本资产（`system.md` / `asset.md`）一并生成 |
| `agentia dev [-- "首次 run 的 prompt"]` | 起本地 inspector 面板：面板上输入 prompt 驱动一次真 run（`↑`/`↓` 调历史）、**多选能力**（收窄菜单）、**选工作目录**、**开关多轮**，再在 trace-view 里看调用树。CLI 自己管文件监视（允许清单含 `.md` —— 改文本资产不用重启）与子进程重启。首个非空参数作为第一次 run 的 prompt（`npm run dev -- "问题"` 就是这么走的） |
| `agentia doctor [--json]` | 纯静态体检，不加载用户代码。`--json` 出结构化结果（有错误仍退出 1） |
| `agentia report <trace.jsonl> [--json]` | 从 trace 落盘文件生成调优报告（能力耗时 / 成本 / 错误率排行）。`--json` 出单个 JSON 文档，便于 CI 断言 |
| `agentia harvest <trace.jsonl>` | trace → eval 用例骨架（`--out` / `--force` / `--failed` / `--limit`）。**无 `--json`**：它的 stdout 本身就是产物 |
| `agentia diff <a.jsonl> <b.jsonl> [--json]` | 两条 trace 的调用树 A/B 比对（有差异时退出码 1）。`--json` 出结构化差异，退出码语义不变 |
| `agentia add <pkg>` | 安装第三方能力包（`defineModule` 能力包）并登记到注册表 |
| `agentia --version` / `-v` | 报出 CLI 版本（读包自身 `package.json`，不另存常量） |

## 可观测（trace）

框架的观测面 **Turn 0 起内建**：一次 run == 一条 trace（`runId == traceId`）。CLI 把这份 trace 带进本地开发流程，**不需要另装追踪后端**：

- **`agentia dev`** —— 起一个本地 inspector 面板：**在面板上驱动一次 run**（prompt / 能力多选 / 工作目录 / 多轮四个旋钮），再实时看这次 run 的调用树（`llm.turn` / 能力 span / 每步 token 与成本）。面板的渲染器与官网 Playground 共用同一份 `@migor/trace-view` —— 两处一套代码，不漂移。只绑 `127.0.0.1`，并带 `Origin` 校验 + 每次启动一次性 token。
- **`agentia report <trace.jsonl>`** —— 把落盘的 trace 汇成调优报告：「**哪个能力慢 / 贵 / 爱失败**」的排行。面对一堆旋钮时，这是「该拧哪个」的依据。
- **`agentia create` 建出来的工程默认就落盘** —— `src/app.ts` 里接了一条 `jsonlTraceSink`，trace 落在工程根的 `.agentia/traces.jsonl`（已 gitignore）⇒ `report` / `diff` / `harvest` 开箱可读。删那一行即关，**关掉之后异步 `/tasks` 的 trace 落进任务库没人导出**；`agentia doctor` 会查这一行并告警。

落库检索 / 采样 / 脱敏、指标与 OTLP 导出都在框架侧的 `TraceSink` 缝上做 —— **策略归宿主，框架只给缝**。详见 [`@migor/agentia`](https://www.npmjs.com/package/@migor/agentia) 的「可观测性与成本」一节，以及仓库的 [`docs/observability.md`](https://github.com/migoric/agentia/blob/main/docs/observability.md)。

## 目录约定

新项目的四类能力各占一个自解释的目录，一能力一文件夹（目录名即类型）：

```
src/
├─ app.ts              # createAgentApp 装配工厂（能力 / 工作目录 / .env）
├─ main.ts             # 默认入口：npm start → HTTP 服务
├─ batch.ts            # 一次性入口：npm run start:batch
├─ tools/<name>/       # @Tool
├─ skills/<name>/      # @Skill
├─ prompts/<name>/     # @Prompt（含 asset.md）
├─ subagents/<name>/   # @SubAgent（含 system.md）
└─ registry.ts         # 显式注册表（create / g / add 维护，doctor 校验）
```

<!-- no-legacy-terms: allow -->
> 老项目（根 `units/` + `units.ts`）**运行时不受影响** —— `discover` 收的是路径，
> `discover: 'units'` 照跑；但 `g` / `doctor` 撞见老布局会**明确提示迁移**，绝不悄悄
> 在旁边新建第二棵目录树。
<!-- /no-legacy-terms: allow -->

## 与框架的关系

CLI 生成的项目的框架依赖是 `@migor/agentia`。框架用法见
[`@migor/agentia`](https://www.npmjs.com/package/@migor/agentia)；
完整说明见仓库的 `docs/usage-guide.md`。

## 许可

MIT
