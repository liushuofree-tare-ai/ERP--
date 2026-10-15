# 汽配 ERP 生产镜像：两段构建——
#   Stage 1 构建前端（SINGLE_FILE=0：代码分割 + 资源 hash，服务器模式）
#   Stage 2 只带 server/ 生产依赖 + dist 静态产物（node:22-alpine 基底）
# 运行时数据（SQLite/文件仓库/备份）放 /app/server/data，由 compose 挂卷。
#   --- 多阶段构建
FROM node:22-alpine AS frontend
# 构建时可换 npm 源（国内服务器用镜像快得多）：
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY app/package.json app/package-lock.json ./app/
RUN cd app && npm ci --registry="$NPM_REGISTRY"
COPY app/ ./app/
ENV SINGLE_FILE=0
RUN cd app && npm run build

FROM node:22-alpine AS runtime
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --registry="$NPM_REGISTRY"
COPY server/src ./src
COPY --from=frontend /app/app/dist ../app/dist
ENV NODE_ENV=production
EXPOSE 3100
CMD ["node", "src/index.js"]
