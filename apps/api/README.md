# @foodie/api

The Fastify API. Running it, the repository-wide checks and migrations are
covered in the [root README](../../README.md); this file covers the tests.

## Tests

`pnpm test` runs every test in `src/**/*.test.ts`. Some mock the database;
the rest run against a real Postgres, and they always run: there is no
skip and no separate script. Without a reachable database the run fails
before any test starts, with an error naming `TEST_DATABASE_URL`.

### Running them locally

Start the Postgres from `docker-compose.yml` and point `TEST_DATABASE_URL` at
a `foodie_test` database on it (the value in `.env.example` does this):

```sh
docker compose up -d postgres
cp .env.example .env              # if you have not already
set -a; . ./.env; set +a          # exports TEST_DATABASE_URL among others
pnpm --filter @foodie/api test
```

Or set only the one variable:

```sh
TEST_DATABASE_URL=postgres://foodie:foodie@localhost:5432/foodie_test pnpm --filter @foodie/api test
```

Before any test runs, `src/test/global-setup.ts`:

1. Drops and recreates the database named in `TEST_DATABASE_URL`, so every
   run starts empty. It connects to the server's `postgres` database to do
   this, so the user needs `CREATEDB` (the compose user is a superuser). The
   name must end in `_test`; anything else is refused, so a mistyped URL
   cannot wipe the `foodie` database the api uses.
2. Applies the migrations in `apps/api/drizzle`, the same ones
   `pnpm db:migrate` applies.

Two test runs against the same database at once will interfere: the second
drops the database the first is using.

### Writing a database test

Use `dbTest` from `src/test/db.ts` in place of Vitest's `test`. It gives the
test a `tx`: a Drizzle transaction on the test database that is rolled back
when the test ends, pass or fail.

```ts
import { dbTest } from "../test/db.js";

dbTest("does something with the database", async ({ tx }) => {
  await tx.insert(measurement).values({ type: "mass", factorToBase: "1" });
  // ...
});
```

- Rows a test writes are not visible to any other test. Migration seed data
  is restored when the test transaction rolls back.
- A statement that fails aborts the whole transaction. To assert on an
  expected error and carry on, run it inside `tx.transaction(...)`, which
  Drizzle wraps in a savepoint:

  ```ts
  await expect(
    tx.transaction((sp) => sp.insert(measurement).values({ ... })),
  ).rejects.toMatchObject({ cause: { constraint: "..." } });
  ```

- Do not commit: the rollback is what keeps tests independent.
- Test files run in parallel, each on its own connections. Tests in different
  files that insert the same unique key can briefly wait on each other until
  one rolls back; they do not see each other's rows.

The test database includes the ingredient catalogue seeded by
`0015_seed_ingredient_catalogue.sql`. Tests that insert catalogue names must
start from an empty catalogue using the auto `emptyCatalogue` fixture (see
`src/routes/ingredients.test.ts` and `src/routes/recipes.test.ts`), or use names
the seed cannot contain. The fixture deletes the catalogue inside the test
transaction; rollback restores it afterward.

### In CI

`.github/workflows/ci.yml` runs Postgres as a GitHub Actions service container
with `postgres:18-alpine`, the image `docker-compose.yml` uses, and sets
`TEST_DATABASE_URL` for the job. The database tests run as part of
`pnpm test` on every pull request and every push to `main`, and a failure
fails the job.
