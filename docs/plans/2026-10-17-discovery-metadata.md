# 发现性：包元数据与 README 首屏（2026-10-17）

## 1. 问题（实测，不是推测）

用 `registry.npmjs.org/-/v1/search` 与 GitHub `search/repositories` 现场查的：

| 入口 | 查询 | 事实 |
|---|---|---|
| npm | `agent framework` / `typescript agent` / `ai agent typescript` / `llm agent node` / `mcp framework` | `@migor/agentia` **全部在前 15 名之外** |
| npm | `agentia` | 第 **9**；前 5 里 4 个是 `@copado/agentia-*`（另一家公司的同名产品线） |
| GitHub | `typescript agent framework` | 前 10 名门槛 **4412 star**，本仓 5 star |
| GitHub | `nestjs agent` | 前 10 名门槛 **59 star**，第 8 名 `irzix/nestjs-agentic` 62 star |

两个可直接修的**错误**（不是「优化」）：

1. `package.json` 的 `description` 是**纯中文**。npm 搜索按英文 token 匹配 ⇒ 该字段对英文查询的贡献为 **0**。
   GitHub 的 `about` 同理（Google 与 GitHub 搜索都吃不到）。
2. `keywords` 只有 7 个，缺 `typescript` / `nodejs` / `ai-agent` / `agent-framework` /
   `model-context-protocol` / `observability` / `tracing` 这批高频检索词。

## 2. 改动

| # | 位置 | 改动 |
|---|---|---|
| ① | `package.json` | `description` → 英文一段（中文原文移进 `README.md` 首屏，不丢） |
| ② | `package.json` | `keywords` 7 → 20：补 `typescript` `nodejs` `ai-agent` `agent-framework` `agent-orchestration` `mcp` `model-context-protocol` `observability` `tracing` `opentelemetry` `self-hosted` `service-framework` `backend` |
| ③ | `packages/cli/package.json` | 同样的两件事（它也在 `agentia` 搜索里排第 8，且描述同样纯中文） |
| ④ | `README.md` 首屏 | 中文描述**之前**加一段英文 tagline（npm 包页首屏就是它，英文访客第一眼看到的是这行） |
| ⑤ | GitHub repo `about` | 改用英文（搜索字段）；中文留在 README |

**不做**：`keywords` 里不放 `nestjs` —— 本包没有 NestJS 集成，放进去是蹭词、会让人误解。
「NestJS 场景」靠文档与落地页去命中，不靠 keywords 误导。

## 3. 生效时机（关键限制）

- **npm 元数据改动要等下一次发版才生效** —— 搜索索引读的是已发布的包文档，本地改 `package.json` 不会改变线上排名。本次只是把「错的元数据」改成「对的」，不是即时见效。
- **GitHub `about` 是立即生效的**（走 API 改仓库元数据）。
- 即便生效，**排名也不会大幅前移**：npm 的排序含下载量（本包 150/天），GitHub 含 star。
  keywords 改变的是「能命中哪些长尾查询」，不是「在泛词里排第几」。

## 4. 验证

1. `bash scripts/verify-all.sh` 八步全绿（`no-legacy-terms` 检查 `package.json` 与 README，
   词表是中文禁用词，英文化不触发；`scoreboard` 只读 `dependencies`，不读 description）。
2. `README.md` 首屏渲染检查：英文段与中文段衔接不重复。
3. 改完用 `registry.npmjs.org` 复核 `keywords` 落盘正确（本地 JSON 有效）。

## 5. 边界

- 这是**消除明显错误**，不是增长手段。真正的发现性瓶颈是「搜到了也不装」，
  5 star / 150 下载/天的仓库即使排到第一页，转化也有限。
- 没有验证「改完排名会上升」——那需要发版后观察 1~2 周，现在无法给结论。
