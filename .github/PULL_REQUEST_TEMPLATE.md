<!--
提交 PR 前请确认：
- `bash scripts/verify-all.sh` 8/8 全绿；改过 mcp.ts 另跑 `npm run e2e:mcp`，改过 mcp-server.ts 另跑 `npm run e2e:mcp:server`
- 新行为带了测试；语义变更同步了 `docs/spec.md` §10
- 改了 `docs/usage-guide.md` 时已重建派生物（dist/AGENTS.md、llms.txt）
- 新增公共导出已同步官网 api.html
-->

## 做了什么

<!-- 一两句话说明这个 PR 解决的问题。关联 issue：Fixes #123 -->

## 为什么这么做

<!-- 设计取舍、被否掉的替代方案、以及任何"看起来可以更简单"的地方为什么不行 -->

## 兼容性

- [ ] 无破坏性变更
- [ ] 有破坏性变更（在下方说明迁移方式，并在提交信息里用 `!` 标记）

## 验证

<!-- 贴关键输出。若是修 bug，说明"修复前的现象"与"为什么以前没被发现" -->

```
bash scripts/verify-all.sh
→ 8/8 全绿
```

## 自查

- [ ] 分层未越界（改了依赖方向则同步改了 `layering.test.ts` 的 `ALLOWED`）
- [ ] 没引入新的运行时依赖（可选能力走 duck-typed / peer）
- [ ] 文档与代码没有漂移（单源 + 守卫测试已跑）
- [ ] **新增/修改的守卫做过反向验证**：回退实现 → 该测试确实变红 → 恢复。
      没做过反向验证的守卫很可能是永远绿的空断言（本仓库有「真空变绿」的教训）
- [ ] 新增/修改的不变量已登记进 `docs/guards.md`（§1 已挂 / §2 待守）

## 危险类自查（答完再合）

> 这 5 问是从 2026-09-18 那轮 16 条缺陷反推出来的。**问对比写规则便宜，且能覆盖规则没预见到的形状。**
> 答「否」的历史事故，写在 `docs/guards.md §2`。

1. **成对实现对称吗？** 这个改动有没有「另一条同契约的路」——anthropic↔openai、同步↔异步
   store、实例↔静态 `@Prompt`、`trimToolPairs`↔`compactMessages`？有的话，**同一场景表跑了两边吗**？
2. **转发链会漏字段吗？** 新增/修改的可选属性，经 `runAgentScoped` / `ToolRunContext` /
   transport 的 `RunInvocationOptions` 一路传到底了吗？（TS 不会报「少传可选字段」）
3. **错误可分类吗？** 新增的错误路径，`classifyError` 判得出可重试吗？文案里带了 HTTP 状态码、
   对象却没有数值 `status` 吗？（`tests/architecture/transport-errors.test.ts` 会拦这一条）
4. **边界值走过吗？** 新增的解析 / 分派 / 计时逻辑，`0` / 正小数 / `null` / `undefined` / 空
   都走过吗？其中 `0` 有没有被两处代码读成不同语义（「不限」vs「已到点」）？
5. **这是「静默失效」吗？** 如果这条路径出错，是**响亮失败**还是**继续跑但账不对**？
   后者必须有一格测试钉住它现在的行为。

