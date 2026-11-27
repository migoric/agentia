# 2026-11-16 面板 Markdown 图片渲染：只认本地路径，外链一律原文

**背景**：`packages/cli/src/markdown.ts` 一直以来明写「不做图片（`![]()`）—— 面板**不去外网取图**：
一次 run 的正文不该触发网络请求」（`markdown.ts:28`）。现在要开图片渲染。本文是实施前的设计，
**不含代码改动**。范围已拍定：本地（workspace 内）图片真渲染；**http/https 外链一律按原文显示**，
既不自动拉取，也不给点击加载。

## 0. 定案

| 开关 | 取值 | 落点 |
|---|---|---|
| 谁发请求 | **浏览器发，但只发给本机路由** | `GET /api/fs/raw?p=` |
| 支持哪些 src | 绝对路径 + 相对路径（仅本地）；外链 / `data:` / `file:` / `://` 一律原文 | `markdown.ts` 判形态 |
| 显示形态 | 限高 `max-height: 240px`，点开新标签看原图 | `<a><img></a>`，零新状态 |
| 作用域 | 模型正文 **+** trace 树正文（同一函数两处调用） | `inspector-page.html:1332`、`:1355` |

## 1. 现状（实测，不是推测）

```
![截图](https://x.dev/a.png)  →  [{text:'!'}, {link href:'https://x.dev/a.png' text:'截图'}]
![a](/abs/local.png)          →  整条字面文本
![a](screenshots/x.png)       →  整条字面文本（相对路径过不了 isSafeHref）
```

即：**外链图片现在就是「一个孤零零的 `!` + 可点链接」**，点开就是原图。这一条决定了下面 §2。

三个可直接复用的既成条件（省掉三笔原以为要付的成本）：

| 已具备 | 位置 | 省掉什么 |
|---|---|---|
| 面板已知工作目录 | `DevState.projectRoot` / `defaultWorkdir`（`dev-protocol.ts:120`），面板存在 `state.dev`（`inspector-page.html:796`） | 不需要动协议传 base |
| fs 路由的鉴权与立场 | 三道闸在 `inspector.ts`；`inspector-routes.ts:495` 明写「越界不是威胁（本机 dev 工具，token 已经挡住了其它进程）」 | 不需要 realpath 白名单式防穿越 |
| 二进制响应写法 | `handleStatic`（`inspector-routes.ts` 尾部）已示范 `readFile` + `ctx.text` 之外的写法 | 不需要新建响应原语 |

## 2. 为什么外链不做（连「点击才加载」也不做）

| 方案 | 收益 | 代价 |
|---|---|---|
| 自动 `<img src>` | 省一次点击 | 渲染即发请求；`![](http://169.254.169.254/…)` 让面板变成内网探针 |
| 点击才加载 | 省一次切窗口 | 用户手势挡不住「他为什么要看这张图」；仍需私网/重定向判定，**客户端判据不可靠**（DNS 重绑定、302 都能绕） |
| 服务端代理 + 白名单 | 唯一可防 | 新子系统：URL 解析、私网/回环/链路本地、逐跳重定向重验、超时、体积、缓存淘汰 —— 约 300 行 + 一轮安全评审 |
| **原文显示（本方案）** | 承诺可写死：**渲染只请求本机** | 少一个「顺手看图」的便利 |

判据不是「风险有多大」，而是**「本机进程能不能真的防住」**：不能，就不该把它写进面板。

## 3. 设计

### 3.1 解析层（`markdown.ts`）

新增 token：`{ type: 'image'; src: string; alt: string }`，插在 `MdInline`（`markdown.ts:36-41`）。

在 `parseInline`（`markdown.ts:363`）里、链接分支（`:390`）**之前**插一条 `!` 分支：

```
c === '!' && text[i+1] === '['  →  /^!\[([^\]]*)\]\(([^)\s]*)\)/
```

- 匹配且 `isLocalImageSrc(src)` ⇒ 出 image token；
- 否则 ⇒ **整条原样进 buf**（连 `!` 一起），与 `isSafeHref` 失败时的降级同款 ——
  使用者一眼看出「这是一张图，我没渲染」。⚠️ 这会把现在的「`!` + 链接」改成整条字面，
  **是有意的行为变更**：孤立 `!` 加一个链接既不像图也不像文字。

`isLocalImageSrc(src)` 判据（解析器只判**形态**）：无 scheme（`/^[a-z][a-z0-9+.-]*:/i` 不命中）
且扩展名在 `png|jpe?g|gif|webp` 内。**不含** `svg`（见 §4）、不含 `?`/`#` 后缀、不含 `=100x` 尺寸语法。

### 3.2 路由层（`inspector-routes.ts`）

```
GET /api/fs/raw?p=<路径>        （路径可以未归一化，服务端 resolve() 收口）
```

| 判据 | 处理 |
|---|---|
| 无 dev 钩子（静态 inspector） | 403，文案与 `/api/fs` 同款 |
| 缺 `p` | 400 |
| `resolve(p)` 后不是普通文件 | 404（不区分「不存在」与「是目录」—— 与 `:495` 的立场一致） |
| 扩展名不在 `png/jpe?g/gif/webp` | 415，**先于读盘** |
| `size > 8MB` | 413（`statSync` 后判，不读内容） |
| 正常 | 200 + 按扩展名映射的 `content-type` + `content-length` + `cache-control: max-age=300` |

`resolve()` 已实测能收口三件事：多余斜杠、`..`、绝对路径直通（不必自己写归一化）。

### 3.3 渲染层（`inspector-page.html`）

`appendInline`（`:1219`）加一个 image 分支：

- `<a class="md-img" href="/api/fs/raw?p=…" target="_blank" rel="noopener noreferrer">` 包 `<img>`；
- `<img>` 只设 `src` / `alt` / `referrerPolicy='no-referrer'` —— **不用 innerHTML**（`innerHTML` 赋值全页仍只有 `renderSummary` 一处，`:1635`）；
- 绝对路径直传，相对路径 `base + '/' + src`（`base = state.dev?.defaultWorkdir ?? state.dev?.projectRoot`；没有 dev（静态面板）⇒ 相对路径降级为字面）；
- 每篇上限 `LOCAL_IMG_MAX = 20` 张，超出降级字面；
- `onerror` ⇒ 记进 `failedImages`（模块级 Set，**跨重画**）并替换成文本 `🖼 alt（加载失败）`；重画时命中 Set 的直接降级，避免每次重画都打一次必败请求；
- CSS 5 行：`.md-img img { max-width: 100%; max-height: 240px; border-radius: 4px }` + 失败态颜色。

**不需要资源缓存层**（修正评估稿里那笔 15 行 `Map + Blob` 释放）：img 每次重画都会重建，但 URL
逐字相同 ⇒ 浏览器 HTTP 缓存直接命中（响应带 `max-age=300`），既无网络请求也不占 JS 内存。
原先那笔成本是「以为要自己缓存」，实测交给浏览器更省。

## 4. 安全

| src 形态 | 处置 | 理由 |
|---|---|---|
| 本地相对/绝对路径 | 渲染 | 请求只到本机 127.0.0.1 + token 闸内 |
| `http(s)://` | 原文 | 渲染不得产生跨源请求（§2） |
| `data:` | 原文 | 正文里几乎不出现；无上限的 base64 会撑爆 DOM |
| `file:` | 原文 | http 页面加载 `file:` 被浏览器拦，写进设计只会是假的 |
| `*.svg` | 原文 | `<img>` 里虽不执行脚本，但 `/api/fs/raw?p=…` 可被直接从地址栏打开 ⇒ 同源 SVG 那时就是可执行文档。排除比加 `content-disposition` 便宜 |

`referrerPolicy='no-referrer'` 在只请求本机时不是必需项，但它把「以后有人放开外链」这条路
提前堵住，成本一个属性。

## 5. 成本实算

| 文件 | 新增 | 现状 | 预算 | 抬不抬 |
|---|---:|---:|---:|---|
| `markdown.ts` | +24（token 1 / 分支 18 / 头注改写 5） | 454 | 476 | **抬** → `ceil(478×1.05) = 502` |
| `inspector-routes.ts` | +55（handler 48 / 路由表 1 / 常量 6） | 702 | 730 | **抬** → `ceil(757×1.05) = 795` |
| `inspector-page.html` | +34（分支 20 / CSS 5 / 上限+失败集合 9） | 2109 | 2166 | 不抬（吃缓冲，余 23） |
| **产品码合计** | **+113** | | | 两处补账注 |

| 测试/文档 | 量 |
|---|---|
| `markdown.test.mjs`：8 例（本地/外链/`data:`/`file:`/空 alt/`!!`/表格与列表内/`svg` 拒） | ~60 行 |
| `inspector.test.mjs`：5 例（403 / 400 / 404 / 415 / 200 + content-type；沿用 `:901` 那套 fixture 写法） | ~55 行 |
| `panel-truth.test.mjs`：4 条源码断言（img 只在 image 分支创建 / 有 `referrerPolicy` / 有 `LOCAL_IMG_MAX` / 无新增 `innerHTML`） | ~35 行 |
| `structure.test.mjs`：两处预算补账注 | ~12 行 |
| `docs/spec.md`：1 条（含「渲染只请求本机」这句承诺的改写） | ~18 行 |

**总计约 +290 行改动。人日：实现 0.5、测试 0.5、文档与账 0.25、评审往返 0.5 ⇒ 1.5–2 人日。**
（与评估稿一致；§3.3 那笔缓存成本被浏览器缓存省掉，§3.1 的 base 成本被 `DevState` 省掉，
两笔省下来的额度补给了 routes 的 415/413 两条判据。）

## 6. 验证

1. `node --test packages/cli/test/markdown.test.mjs packages/cli/test/panel-truth.test.mjs`
2. `npm run build:cli` → `node --test packages/cli/test/inspector.test.mjs`
3. 反向验证（四条，必须各自咬住）：
   - 把 image 分支的 `isLocalImageSrc` 改成恒 `true` ⇒ 外链用例红；
   - 把 415 判据删掉 ⇒ svg 用例红；
   - 把 `failedImages` 删掉 ⇒ 源码断言红（这是「重画不再重试」的唯一守卫）；
   - 把 `markdown.test.mjs` 的 `ALLOWED` 白名单里 `image` 删掉 ⇒ 安全用例红（证明白名单仍是闸）。
4. 手动看一眼（不可自动化那部分）：跑一次带本地截图的 agent，确认缩略图、点开原图、坏路径失败态、20 张上限。

## 7. 边界（如实标注）

- **base 是猜的，不是传下来的**。相对路径按「面板当前工作目录」解析，而正文可能来自别的目录
  （trace 树里尤其）⇒ 表现为**加载失败**，不会错渲染。要精确，得给 `MdBlock` 加来源、三个调用点
  各传 base，那是另一轮。
- **`looksLikeMarkdown` 不给图片计分**（`markdown.ts:336`）。纯截图报告（只有 `![](a.png)`）
  仍走原文 —— 那条判据只认块级记号，加图片会让一份日志里的一个 `![]` 凭空触发整篇渲染。
- **图片仍是「渲染视图」的事**：原文一个字节不改（与 HTML 注释同款口径）。
- **不做的**：lightbox/缩放（点开新标签已够）、`data:`、`svg`、`file:`、外链任何形式的加载、
  图片 alt 之外的图注、`=WxH` 尺寸语法。
- `panel-logic.ts` 实测 1182 = 预算 1182（**余量 0**）⇒ 本轮所有判断刻意留在解析层与页面，
  不去那里开口子；若后续要把它做成可复用判定，得先还那一笔账。
