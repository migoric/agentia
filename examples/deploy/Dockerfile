# syntax=docker/dockerfile:1
# Agentia 部署示例 —— 最小可交付服务的多阶段构建。
#
# ⚠️ 构建上下文 = **仓库根**（不是本目录）：示例刻意跑仓库里的框架源码，
#    所以镜像里先从源码构建框架，再构建应用。
#
#   docker build -f examples/deploy/Dockerfile -t agentia-deploy-example .
#   docker compose -f examples/deploy/docker-compose.yml up --build
#
# 想改用 npm 发布版，把应用 package.json 的依赖从 `file:../..` 改成 `^0.10.3`，
# 即可退回常规单包 Dockerfile（`npm install && npm run build`）。
#
# 另：/healthz 是探针端点（框架不鉴权），drain 超时 15s → compose 的
# stop_grace_period 必须大于它，优雅停机才跑得完。

# ---------- 构建期：框架 → 应用 ----------
FROM node:24-slim AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# npm run build 会跑 scripts/copy-assets.mjs —— 找不到 docs/usage-guide.md 就 exit 1
COPY docs ./docs
RUN npm install --no-audit --no-fund \
 && npm run build

COPY examples ./examples
WORKDIR /repo/examples/deploy
# --install-links：file: 依赖按普通包**拷贝**而非软链，运行期 stage 才能整体搬运
RUN npm install --install-links --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# ---------- 运行期：只带产物（无 tsx / typescript） ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/examples/deploy/node_modules ./node_modules
COPY --from=build /repo/examples/deploy/dist ./dist
COPY --from=build /repo/examples/deploy/package.json ./package.json

# 数据卷：SQLite 库（WAL 模式下 ≤3 个文件），非 root 运行
RUN mkdir -p /data && chown node:node /data
ENV AGENTIA_DB=/data/agentia.db \
    PORT=3000
VOLUME ["/data"]
EXPOSE 3000

USER node
CMD ["node", "dist/main.js"]
