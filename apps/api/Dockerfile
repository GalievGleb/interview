FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile || pnpm install
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @interview/shared build
RUN pnpm --filter @interview/api db:generate
RUN pnpm --filter @interview/api build

FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
