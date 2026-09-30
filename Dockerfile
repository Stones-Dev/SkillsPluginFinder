# Base image
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Builder stage
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Runner stage
FROM base AS runner
WORKDIR /app
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

# Solo dependencias de produccion
RUN pnpm install --frozen-lockfile --prod

# Entrypoint via CLI
ENTRYPOINT ["node", "apps/worker/dist/cli.js"]
