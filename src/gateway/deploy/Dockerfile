# syntax=docker/dockerfile:1
# 小程序网关的小镜像（docs/DEPLOY_GATEWAY.md）：运行层只有打包好的网关一个文件（src/gateway/deploy/build.mjs），
# 不带 yuzu 的后端、管理后台、数据库工具和 node_modules。网关服务器在公网上，上面的东西越少越好。
# 在仓库根目录构建：docker build -f src/gateway/deploy/Dockerfile .（网关服务器上由同目录的 compose.yaml 构建）

ARG NODE_IMAGE=node:22-alpine

# ── 打包 ──
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
# 按锁文件装（与 CI 测过的版本一致），只为打包用；不跑依赖的安装脚本
RUN npm ci --ignore-scripts --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY src/shared ./src/shared
COPY src/gateway ./src/gateway
RUN node src/gateway/deploy/build.mjs /app/out/gateway.mjs

# ── 运行 ──
FROM ${NODE_IMAGE}
WORKDIR /app
# 部署的提交（update.sh 传入），docker inspect 能看到
ARG GATEWAY_COMMIT=
LABEL org.opencontainers.image.title="yuzu-gateway" \
      org.opencontainers.image.revision="${GATEWAY_COMMIT}"
ENV NODE_ENV=production \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8300
COPY --from=build /app/out/ ./
USER node
EXPOSE 8300
# 只看网关进程活着没有（/v1/live 不问门店）：门店断外网时网关照样健康，小程序照样拿得到旧的展示内容
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8300)+'/v1/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "gateway.mjs"]
