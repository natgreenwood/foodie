# Build context is the repository root so the pnpm workspace and lockfile are
# available: `docker build -f apps/web/Dockerfile .`

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Install every dependency of the web package (dev included) from the lockfile.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @foodie/web

# Local development: source is bind-mounted by docker-compose, Vite serves it
# with hot module replacement.
FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY apps/web apps/web
WORKDIR /app/apps/web
EXPOSE 5173
# vite is exec'd directly (not via pnpm) so it receives SIGTERM and stops promptly.
CMD ["node_modules/.bin/vite"]

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN pnpm --filter @foodie/web build

# Static build served by nginx as a non-root user. /api/* is proxied to
# API_UPSTREAM, so the browser only talks to this origin.
FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime
ENV API_UPSTREAM=http://api:3000
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
