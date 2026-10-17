# foodie

Import recipes from the web, plan a week of meals, and generate shopping lists.

## Running locally

### With Docker (recommended)

Requires Docker with Compose v2.

```sh
cp .env.example .env
# then set SETTINGS_ENCRYPTION_KEY in .env, e.g. to the output of:
openssl rand -base64 32
docker compose up --build
```

The api will not start without `SETTINGS_ENCRYPTION_KEY`; see
[AI provider settings](#ai-provider-settings). The other values in
`.env.example` are the compose defaults.

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

By default the api logs the address of whatever connected to it, which behind
nginx is nginx. To log the client's address instead, for example on a failed
sign-in, set `TRUST_PROXY` on the api to the address or CIDR range of the
proxy in front of it, e.g. `TRUST_PROXY=10.0.0.5` or a comma-separated list
such as `10.0.0.0/8,172.16.0.0/12`. The api then takes the client's address
from the `X-Forwarded-For` header, which the nginx config already sends, but
only on requests that come from a listed address.

- List only the proxy in front of the api. Any address on the list can set
  the client address the api logs.
- When it is set, the api's port must be reachable only through that proxy.
  Otherwise a client that connects from inside a listed range can send its
  own `X-Forwarded-For`.
- It takes addresses, not a hop count: `TRUST_PROXY=1` stops the api from
  starting, as does any entry that is not an IP address or CIDR range.
- The api also refuses obvious trust-everyone values, such as `0.0.0.0/0`,
  `::/0` or `::ffff:0.0.0.0/96`, but it does not detect a list of narrower
  ranges that adds up to the same thing.

Compose leaves it unset. There is no nginx in the compose setup, the Vite dev
proxy does not send `X-Forwarded-For`, and the api's port is published to the
host, so the logs there show the dev proxy's or your own address.

### Without Docker

Requires Node 24 (see `.nvmrc`) and pnpm (`corepack enable` picks up the
version pinned in `package.json`). You still need a Postgres; the easiest is
`docker compose up postgres`.

```sh
pnpm install
cp .env.example .env              # and set SETTINGS_ENCRYPTION_KEY, as above
set -a; . ./.env; set +a          # export DATABASE_URL etc.
pnpm --filter @foodie/api db:migrate
NODE_ENV=development pnpm --filter @foodie/api dev
pnpm --filter @foodie/web dev     # in another shell; proxies /api to localhost:3000
```

`NODE_ENV=development` lets the session cookie work over plain HTTP; see
[Accounts and sign-in](#accounts-and-sign-in).

### Supplying the key from Bitwarden Secrets Manager (`bws`)

Instead of writing the key into `.env`, you can inject it with
[`bws run`](https://bitwarden.com/help/secrets-manager-cli/). `bws run` sets
one environment variable per secret, named after the secret's key, so the
secret must be named exactly `SETTINGS_ENCRYPTION_KEY`. It needs
`BWS_ACCESS_TOKEN` set; pass `--project-id <id>` to limit it to one project.

Both the migration and the server read the key, so both must run under
`bws run`:

```sh
# Docker: the api container migrates, then starts, with the injected key.
bws run -- 'docker compose up --build'

# Without Docker: source .env first, then run both commands under bws.
set -a; . ./.env; set +a
bws run -- 'pnpm --filter @foodie/api db:migrate && NODE_ENV=development pnpm --filter @foodie/api dev'
```

Delete the `SETTINGS_ENCRYPTION_KEY=` line from your `.env` when you use
`bws`. Sourcing a `.env` that still has it empty, after `bws run` has injected
the key (for example `bws run -- sh -c '. ./.env && …'`), replaces the key
with an empty value and the api refuses to start.

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

- `GET /recipes`: the signed-in user's recipes, newest first, as
  `{ recipes: [...] }`.
- `GET /recipes/:id`, `DELETE /recipes/:id`: one of the signed-in user's
  recipes. Another user's recipe answers 404 `not_found`, the same as one
  that does not exist. Delete answers 204, and 404 if repeated.

Recipes are private to the account that owns them, and deleting an account
deletes its recipes. Recipes that existed before accounts were given to the
lowest-id admin by migration `0008_recipe_owner`, which refuses to run if
there are recipes and no admin.

`/health` and the three `/auth` routes are open. Routes registered inside the
signed-in scope in `apps/api/src/app.ts` answer 401 `unauthenticated` without
a valid session.

To have an admin account, set both of these (in `.env` for compose):

- `ADMIN_USER`: the admin's email address.
- `ADMIN_PASSWORD`: their password, at least 8 characters.

On every start the api makes sure that account exists and is an admin. An
account that is already an admin is left alone, so changing `ADMIN_PASSWORD`
later does not change its password. If someone registered that email before
it was made admin, the api takes the account over: it sets the password to
`ADMIN_PASSWORD` and signs out all its sessions. Setting only one of the two
stops the api from starting.

### Administration

Routes under `/admin` are for admins only: they answer 401 `unauthenticated`
without a session and 403 `forbidden` to a signed-in user who is not an
admin. Every change is idempotent and logged with the acting admin's id.
Each change also re-checks the acting admin when it is made, not only when
the request arrived: a request still in flight when its sender is disabled
or demoted answers 401 or 403 and changes nothing.

- `GET /admin/users`: every account as `{ users: [...] }`, with `isAdmin`,
  `disabledAt` and `hasPassword`; never a password hash.
- `POST /admin/users/:id/disable` and `/enable`: disabling ends all the
  account's sessions at once and stops it signing in.
- `POST /admin/users/:id/grant-admin` and `/revoke-admin`: take effect on
  that user's next request.
- `PUT /admin/users/:id/password` `{ password }`: the new password works
  straight away; the account's sessions are left alone.
- `DELETE /admin/users/:id`: deletes the account, its sessions and its
  recipes. 204, then 404.

An admin cannot disable, delete or revoke their own account: 409
`cannot_change_own_account`. An unknown or malformed id answers 404
`not_found`.

### AI provider settings

An admin sets one API key per provider for the whole app (Anthropic, OpenAI,
OpenRouter), or for Ollama its server's base URL, and chooses the provider and
model each AI procedure uses. In v1 there is one procedure, `default`.

- `GET /admin/ai`: `providers`, a list of `{ provider, configured }`, and
  `models`, a list of `{ procedure, provider, model }` with null provider and
  model for a procedure not yet set. Only whether a provider is configured,
  never its key or URL.
- `PUT /admin/ai/providers/:provider` `{ apiKey }`, or `{ baseUrl }` for
  `ollama`; `DELETE` the same path clears it (204 either way).
- `PUT /admin/ai/models/:procedure` `{ provider, model }`.

Keys and URLs are stored in the `ai_provider_setting` table encrypted with
AES-256-GCM under `SETTINGS_ENCRYPTION_KEY` (32 random bytes, base64 or hex;
`openssl rand -base64 32`). The api refuses to start if it is missing or the
wrong length. Nothing writes a key to the log, and the logger redacts
`apiKey`, `baseUrl` and request bodies should anything try. Keep the key in
your secrets store, not in git. If it changes, the stored values can no longer
be read; set them again on the admin page.

## Secrets

This repository is public. `.github/workflows/secrets-scan.yml` runs
[Gitleaks](https://github.com/gitleaks/gitleaks) on every push, every pull
request and weekly. Each run scans the full history of every branch and tag,
not just the new commits, so a leak anywhere in the repository fails every
run until it is removed from history. Never commit `.env`; only
`.env.example`, with local-dev values, belongs in git.
