# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────
#  kepler-free-gate — 多阶段 Docker 构建
#  输出镜像约 80MB（基于 oven/bun:alpine）
# ──────────────────────────────────────────────────────────────

# ── 阶段 1: 安装依赖 ────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS deps

WORKDIR /app

# 单独 COPY package.json 让这一层被缓存（依赖不变就不重装）
COPY package.json ./
RUN bun install --production

# ── 阶段 2: 运行时镜像 ──────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS runtime

# OCI 标签
LABEL org.opencontainers.image.title="kepler-free-gate" \
      org.opencontainers.image.description="Kepler AI 免费模型反代网关" \
      org.opencontainers.image.source="https://github.com/GuJi08233/kepler-free-gate" \
      org.opencontainers.image.licenses="MIT"

# 安装 wget（健康检查用）
RUN apk add --no-cache wget tini

# 创建非 root 用户
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# 从 deps 阶段复制依赖和代码
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app gate.ts ./
COPY --chown=app:app package.json ./

USER app

# 默认端口
ENV PORT=13339 \
    NODE_ENV=production

EXPOSE 13339

# 健康检查：拉一次模型列表（10s 内必须有响应）
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider \
      "http://127.0.0.1:${PORT}/v1/models" || exit 1

# tini 负责收割僵尸进程，PID 1 信号处理
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "gate.ts"]
