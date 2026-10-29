# syntax=docker/dockerfile:1
# 浴族 yuzu 应用镜像：构建前端与后端，运行时只保留生产依赖。
# 官方 node 镜像同时提供 amd64 与 arm64（Apple Silicon）版本。

ARG NODE_IMAGE=node:22-alpine

# ── 构建 ──
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY . .
RUN npm run build

# ── 生产依赖 ──
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY}

# ── 运行 ──
FROM ${NODE_IMAGE}
WORKDIR /app
ARG APP_VERSION=0.3.1
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist/client \
    APP_VERSION=${APP_VERSION}
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
