# __PROJECT_NAME__

一个最小 Agentia 应用：一个入口文件、一个裸工具，没有装饰器、DI 或服务端样板。

## 运行

```bash
npm install
$EDITOR .env                 # 填 ANTHROPIC_API_KEY
npm run dev -- "你的问题"     # tsx src/main.ts，跑一次并退出
```

构建后运行：

```bash
npm run typecheck
npm run build
npm start -- "你的问题"       # node dist/main.js
```

`src/main.ts` 里的 `result` 主要包含：

- `finalText`：最终文本；先检查 `result.error`，不要只看它是否为空。
- `stopReason` / `error`：结束原因与结构化错误，失败时进程退出码非零。
- `trace`：完整调用树、token 与成本；需要文件、指标或 OTLP 出口时接 `TraceSink`。

## 需要更多能力时

当前 minimal 模板**不包含** inspector 面板、能力目录/registry、异步任务或 HTTP 宿主。
需要这些时，用默认完整模板另建项目：

```bash
npx @migor/cli create my-service
```

也可以直接在当前 `tools` 数组里继续添加裸 `AgentTool`，不必先引入装饰器。
