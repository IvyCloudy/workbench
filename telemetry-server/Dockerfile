# ===== 构建阶段 =====
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json ./
# 仅安装生产依赖，最小化镜像
RUN npm install --omit=dev --no-audit --no-fund

# ===== 运行阶段 =====
FROM node:20-alpine

# 时区设置为东八区，方便日志/日报
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# 非 root 用户运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8080

# 容器内健康探针（K8s 也可独立配置 readinessProbe 走 /readyz）
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
