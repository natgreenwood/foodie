import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { describeError, describeTarget } from "../db/errors.js";
import { testDatabaseUrl } from "./env.js";

// The same folder `pnpm db:migrate` applies.
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

// Runs once before any test file: drops and recreates the test database so
// every run starts from nothing, then applies the repo's migrations to it.
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const target = describeTarget(url);
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  // The database is dropped on every run; refuse anything that is not
  // obviously a throwaway, such as the `foodie` database the api uses.
  if (!name.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL must name a database ending in _test, because the test run drops and recreates it; got "${name}"`,
    );
  }

  // DROP/CREATE DATABASE cannot run while connected to that database, so
  // connect to the server's default `postgres` database to do it.
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 5_000,
  });
  try {
    await admin.connect();
    const quoted = admin.escapeIdentifier(name);
    // FORCE ends connections a previous, interrupted run left open.
    await admin.query(`drop database if exists ${quoted} with (force)`);
    await admin.query(`create database ${quoted}`);
  } catch (err) {
    throw new Error(
      `could not recreate the test database from TEST_DATABASE_URL (${target}): ${describeError(err)}`,
      { cause: err },
    );
  } finally {
    await admin.end().catch(() => undefined);
  }

  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } catch (err) {
    throw new Error(
      `could not migrate the test database (${target}): ${describeError(err)}`,
      { cause: err },
    );
  } finally {
    await pool.end();
  }
}
