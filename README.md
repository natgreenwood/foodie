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

`/health`, the three `/auth` routes above and the open OIDC routes below are
open. Routes registered inside the
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

### Signing in with OIDC

Users can also sign in through one OpenID Connect provider, any that follows
the standard (verified against PocketID). The api finds everything about the
provider from its discovery document, `<issuer>/.well-known/openid-configuration`,
and signs in as a confidential client with the authorization code flow, PKCE
and the scopes `openid profile email`. Set all four of these, or none (in
`.env` for compose):

- `OIDC_ISSUER_URL`: the provider's issuer, e.g. `https://id.example.com`.
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: Foodie's client at the provider.
- `OIDC_REDIRECT_URL`: the callback as the browser reaches it, which is the
  URL to register at the provider. Through the web app that is
  `<web origin>/api/auth/oidc/callback`, e.g.
  `http://localhost:5173/api/auth/oidc/callback` in development.
- `OIDC_DISPLAY_NAME` (optional): the sign-in button's label.

With none set, OIDC is off. Setting only some stops the api from starting.
Both URLs must be `https`, except in development (`NODE_ENV=development`).
With `bws run`, name the secrets `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`,
as for [the settings key](#supplying-the-key-from-bitwarden-secrets-manager-bws).

**PocketID:** turn on its `EMAILS_VERIFIED` setting. PocketID leaves it off,
and then reports every email as unverified, so a first OIDC sign-in with the
email of an existing Foodie account is refused instead of linked.

How accounts are matched:

- An identity is linked to one account by the provider's issuer and `sub`,
  and always signs in to it, even if its email changes at the provider.
- A first sign-in whose email matches no account creates one, with no
  password; who may sign in is decided at the provider. The `name` claim
  becomes the display name, and later sign-ins never change it.
- A first sign-in whose email matches an account (ignoring case) is linked
  to it only when the provider sends `email_verified: true`; otherwise it is
  refused.
- A disabled account is refused. A deleted account's identity gets a new,
  empty account.
- The admin role is never read from or changed by the provider.

Routes. `start`, `callback` and `connect` are full-page browser navigations
that answer with redirects; the callback lands on `/` signed in, or on
`/sign-in?oidc_error=<code>`:

- `GET /auth/oidc/config`: `{ enabled, displayName }`, `displayName` null
  when `OIDC_DISPLAY_NAME` is unset. Open.
- `GET /auth/oidc/start`: redirects to the provider. Open.
- `GET /auth/oidc/callback`: where the provider sends the browser back.
  Open. Each trip to the provider can come back once, within 10 minutes.
- `POST /auth/oidc/connect`: signed in, submitted as a form. Redirects to the
  provider; the callback then lands on `/profile?oidc=connected` or
  `/profile?oidc_error=<code>`. Accepted only when the provider's email is
  the account's, ignoring case.
- `DELETE /auth/oidc/connection`: signed in. Disconnects the identity, 204;
  409 `no_local_password` for an account with no password, which would have
  no way left to sign in.
- `GET /me` says how the account signs in: `hasPassword`, and
  `oidc: { connected, connectedAt }`.

`oidc_error` is a code, never text; the web app owns the wording. It is one
of `email_unverified`, `account_disabled` (sign-in), `email_mismatch`
(connect), `already_connected` (either: the identity or the account is
already linked elsewhere) and `provider_error` (either: the provider could
not be reached or refused, its answer did not check out, it sent no email,
or the trip was missing, expired or no longer signed in).

An account with no password cannot sign in with a password: the sign-in form
answers it exactly as it answers a wrong password. Signing out of Foodie does
not sign out of the provider.

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
  straight away; the account's sessions are left alone. 409
  `password_not_allowed` for an account with no password, which signs in
  only through OIDC.
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
