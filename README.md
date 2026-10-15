# foodie

Import recipes from the web, plan a week of meals, and generate shopping lists.

## Running locally

### With Docker (recommended)

Requires Docker with Compose v2.

```sh
cp .env.example .env   # optional: compose has local-dev defaults for every value
docker compose up --build
```

This starts:

- `postgres` — Postgres 18, data kept in the `postgres-data` named volume.
- `api` — the Fastify API on <http://localhost:3000>. It applies database
  migrations on start, then runs with hot reload: edits under `apps/api/src`
  restart the server.

Check it is up:

```sh
curl localhost:3000/health
# {"status":"ok","db":"up"}   (HTTP 200; HTTP 503 with "db":"down" if Postgres is unreachable)
```

Stop with `docker compose down`; add `-v` to also delete the database volume.

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

This repository is public. Every push and pull request is scanned with
[Gitleaks](https://github.com/gitleaks/gitleaks) over the full git history
(`.github/workflows/secrets-scan.yml`). Never commit `.env`; only
`.env.example`, with placeholder values, belongs in git.
