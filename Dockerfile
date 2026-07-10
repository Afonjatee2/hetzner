FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep docker.io \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 8081
CMD ["node", "apps/mcp-gateway/dist/server.js"]
