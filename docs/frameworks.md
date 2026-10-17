# 框架兼容性：同一个 handler，挂进哪个宿主都行

> **结论先行**：`createHttpHandler(app)` 返回的就是标准的 `(req: IncomingMessage, res: ServerResponse) => void`。
> 它不碰任何宿主 API ⇒ 任何能挂「原始 node handler」的地方都能挂它，不需要适配层。
>
> 本文记录的是 **2026-10-17 的实测**（版本见下表），**不是承诺** —— 承诺的面只有
> `engines.node` 声明的区间（`docs/usage-guide.md` §7「运行时」那行）。Bun / Deno 跑得通，
> 但不在 `engines` 承诺内，也不在 CI 上；edge 运行时未验证。

## 判定标准（四步，缺一步就不算「可用」）

| 步 | 判什么 | 为什么不能省 |
|---|---|---|
| ① 导入 | 宿主进程里 `import` / `require` 框架不炸 | CJS/ESM 互操作是第一道坎，且它在 Node 22.12 前后行为不同 |
| ② 装配 | `createApp()` 在该运行时构造成功 | 装饰器元数据在个别运行时/配置下会静默丢失 |
| ③ HTTP | 发真请求：`POST /run` 同步、`GET /tasks/:id` 轮询行为正确 | 只验「端口起来了」发现不了路由/前缀问题 |
| ④ 副作用 | 一次真 run 落下该落的：trace 落盘、task 记录、工具的文件副作用 | 导入期副作用被 tree-shaking / 惰性加载吞掉的病，只有这一步能发现 |

## 实测环境

| 运行时 / 框架 | 版本 |
|---|---|
| Node | 22.13.1 |
| Bun | 1.4.3 |
| Deno | 2.9.6 |
| NestJS | 12.1.3（CJS 与 ESM 两种模式各跑一遍） |
| Egg.js | 4.0.10（单进程 + cluster 2 worker） |
| `@migor/agentia`（被测本体） | 0.10.3 |

## 结论表

### 运行时轴

| 运行时 | 导入 | 装配 | HTTP | 副作用 | 关键配置 |
|---|---|---|---|---|---|
| Node 22 · ESM 宿主 | ✅ | ✅ | ✅ | ✅ | 无 |
| Node 22 · CJS 宿主 | ✅ `require(ESM)` | ✅ | ✅ | ✅ | **Node ≥ 22.12** 才能 `require()` ESM 包；更早版本用 `await import()` |
| Bun 1.4.3 | ✅ | ✅ | ✅ | ✅（文件副作用已验证） | 装饰器**默认生效**，不需要 tsconfig / `experimentalDecorators` |
| Deno 2.9.6 | ✅ | ✅ | ✅ | ✅ | 权限 flag 见下，少一个是**运行时**炸、不是编译期 |

Deno 的四个权限（对应框架会碰的东西，缺哪个炸哪个）：

```bash
deno run \
  --allow-net \      # HTTP：模型端点
  --allow-read \     # trace 落盘、store 读
  --allow-write \    # store 写
  --allow-run \      # 仅 MCP stdio：spawn 子进程
  server.ts
```

`node:sqlite` 在 Bun 与 Deno 下都存在（`DatabaseSync` 是 function），
`new SqliteTaskStore()` 两边都构造成功，读写（save / get / update / byIdempotency /
list / missing → undefined）与 Node 一致。

### Web 框架轴

| 宿主 | 结论 | 最小接入 | 必须配的 |
|---|---|---|---|
| `node:http`（基线） | ✅ | `createServer(createHttpHandler(app, { runner }))` | 无 |
| NestJS 12 · ESM | ✅ | `nestApp.use('/agent', handler)` 三行 | 无 |
| NestJS 12 · CJS | ✅ | 同上 | Node ≥ 22.12，或 `await import()` |
| Egg 4 | ✅ | 中间件 + `ctx.respond = false` | **2 条 config**（CSRF / bodyParser ignore），见「Egg 的三个坑」 |

**未验证（如实标注）**：Express / Fastify / Koa 作为**独立宿主**的最小片段未逐一实测
（`examples/agent-endpoint/` 是 `node:http` + 一条分支的形态）；Node 18 / 20 未跑 ——
「`require(ESM)` 在 22.12 前不可用」是按 Node 发布时间线的**推断**，按 `await import()` 写可避开；
edge 运行时（Workers 等）未验证。

## 最小接入代码

### `node:http`（基线，也是 Bun / Deno 的用法）

```ts
import { createServer } from 'node:http';
import { createHttpHandler } from '@migor/agentia';

createServer(createHttpHandler(app, { runner })).listen(8080);
```

Bun 与 Deno 都实现了 `node:http`，**同一份代码原样跑**，没有第二行宿主相关代码。

### NestJS（CJS 与 ESM 同一形态）

```ts
import { createHttpHandler } from '@migor/agentia';

// Nest 的 use 走的是 Express 中间件栈：前缀 '/agent' 自动剥、不碰 Nest 的 DI 图
nestApp.use('/agent', createHttpHandler(app, { runner }));
```

CJS 宿主（`main.ts` 是 CommonJS）跨版本可靠的写法是动态 import ——
`require(ESM)` 要 Node ≥ 22.12，且 CJS 里没有顶层 `await`，包一层：

```ts
void (async () => {
  const { createHttpHandler } = await import('@migor/agentia');
  nestApp.use('/agent', createHttpHandler(app, { runner }));
})();
```

两套 DI 各管各的：Nest 的 provider 图与 Agentia 的装饰器注册表互不感知，挂载不产生任何耦合。
（实测地址形如 `http://[::1]:PORT`，本地 fetch 时把 host 换成 `127.0.0.1`。）

### Egg 4

```js
// app/middleware/agent.js
module.exports = (options, app) => {
  const { createHttpHandler } = require('@migor/agentia');
  const handler = createHttpHandler(app.agentia, { runner: app.agentiaRunner });

  return async (ctx, next) => {
    if (!ctx.path.startsWith('/agent')) return next(); // 业务路由优先
    ctx.respond = false; // 绕过 Koa/Egg 的响应流，handler 自己写 res
    ctx.req.url = ctx.req.url.slice('/agent'.length) || '/'; // Koa 不改 req.url，自己剥前缀
    await handler(ctx.req, ctx.res);
  };
};
```

外加 `config/config.default.js` 里两条 ignore（缺一不可，理由见下）：

```js
exports.security   = { csrf:       { ignore: (ctx) => ctx.path.startsWith('/agent') } };
exports.bodyParser = {             ignore: (ctx) => ctx.path.startsWith('/agent') } };
```

⚠️ `ignore` **不能用字符串**：字符串形式走 path-to-regexp，写 `'/agent/**'` 会让 worker
**启动即崩**（`Unexpected MODIFIER`）—— 必须是函数。

## Egg 的三个坑（都是实测撞出来的）

**① CSRF 默认拦 POST → 403**

Egg 的 security 插件对 POST 做 CSRF 校验，agent 端点是机器调用，没有 token。
修法是 `csrf.ignore`；不修的话 POST 全 403，而 GET 探活是好的 —— 只看健康检查会漏判。

**② bodyParser 提前消费请求流 → POST 挂死（最阴的一个）**

Egg 的 bodyParser 在中间件之前就把 `req` 读空了，handler 再读 body 得到空。
症状是 **`GET /healthz` 一直 200，只有 POST 无响应**（连接挂着，不报错）。
修法是 `bodyParser.ignore`。

**③ cluster 下每个 worker 各持一份内存 store → 同 taskId 轮询 `404 200 404 200` 完美交替**

2 worker 实测：POST `/run` 通，但轮询落到另一个 worker 就是 404。
这不是 bug 是**内存 store 的结构性质** ⇒ cluster / 多实例必须换共享 store：

| 部署形态 | 可用 store |
|---|---|
| 单进程 | `InMemoryTaskStore` |
| 多机 / 真集群 | `RedisTaskStore` |
| 共享卷多进程 | `SqliteTaskStore`（`node:sqlite`，需 Node ≥ 22.5） |
| 单机落盘续跑 | `FileTaskStore`（**不跨进程**） |

store 选型与优雅停机的完整清单见 [`docs/deployment.md`](./deployment.md)。

## `ctx.respond = false` 的代价

置 false 意味着绕过 Egg 的响应中间件（`egg-onerror`、压缩等）：handler 的响应不再经过它们，
错误格式与压缩行为由 agent handler 自己决定。要 Egg 的统一错误格式，就在中间件里包一层 try/catch。

## 什么时候别指望它

- **edge 运行时**（Workers 等）：未验证，别按「Web 标准所以一定能跑」推断 —— 框架碰
  `node:http` 原语，edge 的兼容层是另一个问题。
- **想走宿主自己的 DI / Controller 生命周期**：agent handler 是**旁挂**的，不参与 Nest 的
  provider 图、不继承 Egg 的中间件约定（`ctx.respond = false` 就是明证）。要的是「在现有服务里
  加一个端点」，这个形态正好；要的是「agent 成为框架的一等公民」，那是另一种设计。
