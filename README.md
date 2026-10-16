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
NODE_ENV=development pnpm --filter @foodie/api dev
pnpm --filter @foodie/web dev     # in another shell; proxies /api to localhost:3000
```

`NODE_ENV=development` lets the session cookie work over plain HTTP; see
[Accounts and sign-in](#accounts-and-sign-in).

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

### Accounts and sign-in

Anyone can register with an email and password; there is no email sending,
so no verification and no password reset. Signing in sets an HttpOnly,
SameSite=Lax session cookie, `foodie_session`, backed by the `session` table,
so sessions survive an api restart. A session lasts 30 days from sign-in.

The cookie is `Secure` (sent only over HTTPS) unless `NODE_ENV` is
`development`, which the compose dev image sets. Anything else, including an
unset `NODE_ENV`, is treated as production.

Routes (the web app reaches them under `/api`, e.g. `/api/auth/login`):

- `POST /auth/register` `{ email, password, displayName? }`: creates the
  account and signs it in. 409 if the email is taken, ignoring case.
- `POST /auth/login` `{ email, password }`: 401 `invalid_credentials` for an
  unknown email, a wrong password or a disabled account alike.
- `POST /auth/logout`: ends the cookie's session. Always 204.
- `GET /me`, `PATCH /me` `{ displayName?, locale? }`: the signed-in user's
  profile. `locale` is a BCP-47 tag, default `en-GB`.

`/health` and the three `/auth` routes are open. Routes registered inside the
signed-in scope in `apps/api/src/app.ts` answer 401 `unauthenticated` without
a valid session.

To have an admin account, set both of these (in `.env` for compose):

- `ADMIN_USER`: the admin's email address.
- `ADMIN_PASSWORD`: their password, at least 8 characters.

On every start the api makes sure that account exists and is an admin. If it
already exists, its password is left alone, so changing `ADMIN_PASSWORD`
later does not change the password. Setting only one of the two stops the
api from starting.

## Secrets

This repository is public. `.github/workflows/secrets-scan.yml` runs
[Gitleaks](https://github.com/gitleaks/gitleaks) on every push, every pull
request and weekly. Each run scans the full history of every branch and tag,
not just the new commits, so a leak anywhere in the repository fails every
run until it is removed from history. Never commit `.env`; only
`.env.example`, with local-dev values, belongs in git.
