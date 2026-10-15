import { TransactionRollbackError } from "drizzle-orm";
import { test } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { testDatabaseUrl } from "./env.js";

export type TestTransaction = Parameters<
  Parameters<Database["db"]["transaction"]>[0]
>[0];

// `test` with a `tx` fixture: a Drizzle transaction on the test database that
// is rolled back when the test ends, pass or fail. Rows a test writes are
// never seen by another test; rows the migrations wrote are never removed.
//
// A statement that fails inside `tx` aborts the whole transaction. To assert
// on an expected error and keep going, run it in a nested
// `tx.transaction(...)`, which Drizzle wraps in a savepoint.
export const dbTest = test.extend<{
  $file: { database: Database };
  $test: { tx: TestTransaction };
}>({
  database: [
    // eslint-disable-next-line no-empty-pattern -- Vitest reads fixture dependencies from the destructuring pattern.
    async ({}, use) => {
      const database = createDatabase(testDatabaseUrl(), (err) => {
        console.error("postgres idle client error:", err.message);
      });
      try {
        await use(database);
      } finally {
        await database.close();
      }
    },
    { scope: "file" },
  ],
  tx: async ({ database }, use) => {
    try {
      await database.db.transaction(async (tx) => {
        await use(tx);
        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  },
});
