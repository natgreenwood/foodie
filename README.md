# foodie

Import recipes from the web, plan a week of meals, and generate shopping lists.

## Running locally

### With Docker (recommended)

Requires Docker with Compose v2.

```sh
cp .env.example .env   # optional: same values as the compose defaults
docker compose up --build
```

Postgres applies `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` only
when it first creates its volume. If you change them after the first run,
recreate the volume with `docker compose down -v` (this deletes local data).

This starts:

- `postgres` — Postgres 18, data kept in the `postgres-data` named volume.
- `api` — the Fastify API on <http://localhost:3000>. It applies database
  migrations on start, then runs with hot reload: edits under `apps/api/src`
  restart the server.
- `web` — the React app (Vite dev server) on <http://localhost:5173>, with hot
  module replacement for edits under `apps/web/src`. It shows the API's health;
  requests to `/api/*` are proxied to the `api` service with the `/api` prefix
  removed, so `/api/health` reaches `GET /health`.

Check it is up:

```sh
curl localhost:3000/health
# {"status":"ok","db":"up"}   (HTTP 200; HTTP 503 with "db":"down" if Postgres is unreachable)
```

Stop with `docker compose down`; add `-v` to also delete the database volume.

The production web image (`docker build -f apps/web/Dockerfile .`) serves the
static build with nginx on port 8080 as a non-root user and proxies `/api/*` to
`API_UPSTREAM` (default `http://api:3000`). nginx resolves that host when it
starts, so the api must be reachable by then.

### Without Docker

Requires Node 24 (see `.nvmrc`) and pnpm (`corepack enable` picks up the
version pinned in `package.json`). You still need a Postgres; the easiest is
`docker compose up postgres`.

```sh
pnpm install
cp .env.example .env
set -a; . ./.env; set +a          # export DATABASE_URL etc.
pnpm --filter @foodie/api db:migrate
pnpm --filter @foodie/api dev
pnpm --filter @foodie/web dev     # in another shell; proxies /api to localhost:3000
```

### Checks

Run from the repository root; CI runs the same three on every pull request.

```sh
pnpm lint        # ESLint + Prettier check (pnpm format to fix formatting)
pnpm typecheck
pnpm test
```

### Database migrations

Schema lives in `apps/api/src/db/schema.ts` (Drizzle). After changing it:

```sh
pnpm --filter @foodie/api db:generate   # writes a migration to apps/api/drizzle
pnpm --filter @foodie/api db:migrate    # applies pending migrations
```

## Secrets

This repository is public. `.github/workflows/secrets-scan.yml` runs
[Gitleaks](https://github.com/gitleaks/gitleaks) on every push, every pull
request and weekly. Each run scans the full history of every branch and tag,
not just the new commits, so a leak anywhere in the repository fails every
run until it is removed from history. Never commit `.env`; only
`.env.example`, with local-dev values, belongs in git.
