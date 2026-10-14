# 参与贡献

感谢你愿意贡献。本仓的**详细约定只有一份** —— 见 [`AGENTS.md`](./AGENTS.md)（它同时是 AI 编码助手的权威入口）。
本文只讲**人**的流程，不重复那份约定，避免出现两套说法。

## 快速上手

```bash
git clone https://github.com/retrychx/agentia.git
cd agentia
npm install
npm run build          # 编译到 dist/
bash scripts/verify-all.sh   # 8 步验证链（第 1 步含 lint），全绿才算完
```

> Node ≥ 18（`engines` 声明）。CI 覆盖 **18 / 20 / 24** —— `import-floor` 矩阵跑下限、其余 job 跟
> 当前 LTS（改 matrix 前先读 `.github/workflows/ci.yml` 顶部那条：**matrix 取值会进必需检查名**）。
> 若 `npm run dev`（tsx）报缺 esbuild，先 `npm approve-scripts` 批准 postinstall。

## 提交前必须跑

```bash
bash scripts/verify-all.sh    # 8 步：typecheck + lint → build → typecheck:types → typecheck:tests
                              #        → build:cli → test → e2e → build:website
npm run lint                  # 只想跑 lint 时用这个（`biome check .`，与链里同一个工具）
npm run lint:fix              # 格式化 / 安全修，别手工调格式
```

链的第 1 步会跑 `npx biome ci .` —— 与 CI 那个独立 `lint` job **同一条命令**，所以本地全绿就意味着
lint 也过了。**要往链上加检查，请折进已有步骤，不要加第 9 步**：CI 的 `verify` job 名（= 分支保护的
必需状态检查）写死了步数，加一步这名就成了假话，改名则会让所有 PR 卡死等一个永不出现的检查。

动了 `src/integrations/mcp.ts` 还要跑 `npm run e2e:mcp`；动了 `src/engine/mcp-server.ts` 还要跑 `npm run e2e:mcp:server`。

想让静态问题更早暴露，可以开**仓内的 git 钩子**（每个克隆各开一次，git 不会自动启用仓库里的钩子）：

```bash
git config core.hooksPath .githooks   # 之后每次 push 前只跑静态三步（约 15 秒）
SKIP_VERIFY=1 git push                # 急着推时跳过
```

⚠️ 它**不是门禁**：只覆盖 `bash scripts/verify-all.sh rapid` 那三步，真正的门禁是 CI。

## 提 PR 的流程

`main` 是**受保护分支**：

1. 从 `main` 开分支（`feat/…` · `fix/…` · `docs/…` · `chore/…`）
2. 提交、推送
3. 开 PR —— CI 必须全绿才能合并（`verify` · `lint` · `import-floor` · `e2e:mcp` · `e2e:mcp:server`）
4. 用 **squash** 合并（仓库要求线性历史）

> 直接 `git push origin main` 会被拒 —— 这是设计，不是故障。

> 动分支保护后跑 `node scripts/check-branch-protection.mjs` 对一眼（需 `gh` 认证）：
> 拿仓内 `ci_only` 与 GitHub 实配集合对拍 —— 少检查 ⇒ 红着能合，多检查 ⇒ PR 卡死。

## 提交信息

沿用 Conventional Commits 前缀（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:` / `perf:`），
正文用中文讲清**为什么**（而不只是做了什么）。语义有变更的用 `!` 标记并在正文说明兼容性影响。

## 几条最容易踩的坑

| 坑 | 说明 |
|---|---|
| 忘了 `AGENTS.md` 的约定 | 尤其是**分层单向**（改了依赖方向必须同步改 `tests/architecture/layering.test.ts` 的 `ALLOWED`）与**零新增运行时依赖** |
| 改了 `docs/usage-guide.md` 没重建派生物 | 它是**单源**，跑 `npm run build` / `build:cli` / `build:website` 重新生成 `dist/AGENTS.md` 与 `llms.txt` |
| 新增了公共导出没改官网 | `tests/docs/api-page.test.ts` 做**反向全覆盖**：`src/index.ts` 的每个导出都必须出现在 `packages/website/src/fragments/api.html`（含页头统计数字） |
| 某步验证「本地过了」但 CI 挂了 | 先分清是哪个 job。`verify-all.sh` 现在**含 lint**（第 1 步），但它**不含** CI 独有的 `import-floor`（Node 18/20 导入下限）、`e2e:mcp` 与 `e2e:mcp:server` —— 这四个是必需检查，本地得单独跑 |
| 语义变更没留决策记录 | 改语义要同步 `docs/spec.md` §10；方向性工作更新 `docs/roadmap.md` |
| §10 引用写成圈号 | 圈号是位置号、会漂 ⇒ 一律写 `（日期 ref-名）`；写法见 `AGENTS.md`「设计决策」 |

## 发版流程

发布面有 10 余个文件（根包 + CLI 包 + 文档 + 官网 + 锁文件），手工改必漏 ⇒ **只有两条显式命令**，
其余机械步骤交给 `scripts/release.mjs`（发布面清单在 `scripts/release-surface.mjs`，
计数断言闸门是 `scripts/check-release.mjs`）：

```bash
node scripts/release.mjs bump 0.9.6 --dry-run   # 先看它打算改哪些文件、各几处
node scripts/release.mjs bump 0.9.6             # 真写（任何计数不符 ⇒ 中止，且一个字节都不写）
```

`bump` 会把当前版本改到全部发布面，并插入两处 **TODO 骨架**（CHANGELOG 本版条目、`spec.md` §11
进度链说明）—— **那两处是给人填的**，闸门会把没填的骨架拦下来。然后：

```bash
bash scripts/verify-all.sh                       # 8 步全绿
# 开 PR，等必需检查全绿（见上一节）
npm publish --registry https://registry.npmjs.org/          # ← 先发布
npm publish -w @migor/cli --registry https://registry.npmjs.org/
# 合并 PR（squash）
node scripts/release.mjs tag 0.9.6 --title '一句话概括本版'
```

**顺序「发布 → 合并 → 打 tag」不能换**：反过来（先合并）会让 `main` 上挂着「已发布」而 registry
还没有 —— 这条链唯一不撒谎的顺序就是先发。`tag` 会先核对 registry 产物与仓库树同源
（单源文档哈希对拍 + 产物里的版本常量 + CLI 不含 `@migor/*` 依赖），再打 **annotated** tag 并建
GitHub Release；tag 消息走 `-F <文件>`（消息里全是反引号与星号，走 `-m "…"` 会被 shell 当命令替换，
本仓真踩过）。

几条纪律：

- **版本号只能往前走**，`0.x` 阶段的破坏性变更走 **minor**（见 README「稳定性与版本策略」）；
- 破坏性变更必须让 `bump` 生成的那一节**写清「你要改什么」**，并把提交标题打上 `!`；
- 改了 `scripts/release*.mjs` 要跑 `node --import tsx --test tests/scripts/release-scripts.test.ts`
  （护栏自己失灵会写坏整棵树，且发生在发版当天）；
- `packages/trace-view` 的 `private: true` 是**有意**的（产物随 CLI 拷进用户项目），它跟着 bump
  只是保持 workspace 内版本一致。

## 报 issue

用 issue 模板（Bug 报告 / 功能建议）。安全漏洞**不要**开公开 issue —— 见 [`SECURITY.md`](./SECURITY.md)。

## 许可

贡献即表示同意以本仓的 [MIT 许可](./LICENSE) 发布你的贡献。
