# syntax=docker/dockerfile:1
# Agentia 完整示例 —— 多阶段构建。
#
# ⚠️ 构建上下文 = **仓库根**（不是本目录）：示例刻意跑仓库里的框架源码，
#    所以镜像里先从源码构建框架，再构建应用。
#
#   docker build -f examples/complete/Dockerfile -t agentia-complete .
#   docker compose -f examples/complete/docker-compose.yml up --build
#
# 想改用 npm 发布版，把应用 package.json 的依赖从 `file:../..` 改成 `^0.10.4`，
# 即可退回常规单包 Dockerfile（`npm install && npm run build`）。

# ---------- 构建期：框架 → 应用 ----------
FROM node:24-slim AS build
WORKDIR /repo

# 1) 框架本体。它零运行时依赖（公共消息类型自有，厂商 SDK 只做构建期类型门禁），
#    这里装的是构建期的 tsc。
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# npm run build 会跑 scripts/copy-assets.mjs —— 找不到 docs/usage-guide.md 就 exit 1
COPY docs ./docs
RUN npm install --no-audit --no-fund \
 && npm run build

# 2) 观测栈示例包 @migor/agentia-observability。它是 examples/complete 的 file: 依赖，
#    且 package.json 只声明了 `files: ["dist"]` —— **必须先构建**：否则下一步 install 会把它
#    当成「只有 README + package.json」的空包拷进去，examples/complete 的 tsc 当场
#    TS2307 Cannot find module '@migor/agentia-observability'（本机按同一套步骤复现过）。
COPY examples ./examples
WORKDIR /repo/examples/observability
RUN npm install --install-links --no-audit --no-fund \
 && npm run build

# 3) 示例应用。它的依赖 `file:../..` 指向 /repo —— 上面刚构建出的 dist。
WORKDIR /repo/examples/complete
# --install-links：file: 依赖按普通包**拷贝**而非软链，运行期 stage 才能整体搬运
RUN npm install --install-links --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# ---------- 运行期：只带产物（无 tsx / typescript） ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/examples/complete/node_modules ./node_modules
COPY --from=build /repo/examples/complete/dist ./dist
COPY --from=build /repo/examples/complete/package.json ./package.json

# 数据卷（SQLite 库 + WAL 文件），非 root 运行
RUN mkdir -p /data && chown node:node /data
ENV AGENTIA_DB=/data/agentia.db \
    PORT=3000
VOLUME ["/data"]
EXPOSE 3000

USER node
CMD ["node", "dist/main.js"]
