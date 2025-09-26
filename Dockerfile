# Multi-stage Dockerfile for trader app (backend + worker via pm2)
# - Builder stage installs dependencies and builds the frontend
# - Runtime stage runs backend or worker via pm2-runtime with tsx interpreter

FROM node:20-alpine AS builder
WORKDIR /app

# Install deps (include dev deps because runtime uses tsx interpreter)
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Copy sources and build frontend
COPY . .
RUN npm run build


FROM node:20-alpine AS runtime
WORKDIR /app

# System packages (curl for healthchecks), PM2 for process manager
RUN apk add --no-cache curl \
  && npm i -g pm2

# Copy only necessary artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/ecosystem.config.js ./ecosystem.config.js
COPY --from=builder /app/server ./server
COPY --from=builder /app/services ./services
COPY --from=builder /app/temporal ./temporal
COPY --from=builder /app/types ./types
COPY --from=builder /app/config ./config
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/vite.config.mts ./vite.config.mts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
ENV PORT=8789

EXPOSE 8789

# Basic healthcheck hitting API settings endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/trading/settings" >/dev/null || exit 1

# Default command runs backend; docker-compose overrides for the worker
CMD ["pm2-runtime", "ecosystem.config.js", "--only", "trader-backend"]




