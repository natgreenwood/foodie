# Build context is the repository root so the pnpm workspace and lockfile are
# available: `docker build -f apps/api/Dockerfile .`

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Install every dependency of the api package (dev included) from the lockfile.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @foodie/api

# Local development: source is bind-mounted by docker-compose, tsx watches it.
FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY apps/api apps/api
WORKDIR /app/apps/api
# tsx is exec'd directly (not via pnpm) so it receives SIGTERM and stops promptly.
CMD ["node_modules/.bin/tsx", "watch", "src/server.ts"]

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN pnpm --filter @foodie/api build

FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @foodie/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --chown=node:node apps/api/drizzle apps/api/drizzle
COPY --chown=node:node apps/api/package.json apps/api/
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/server.js"]
