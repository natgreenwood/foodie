import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";

// Applies pending migrations from apps/api/drizzle. Safe to re-run: Drizzle
// records applied migrations in drizzle.__drizzle_migrations and skips them.
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const config = loadConfig();
const database = createDatabase(config.databaseUrl, (err) => {
  console.error("postgres idle client error:", err.message);
});

try {
  await migrate(database.db, { migrationsFolder });
  console.log(`migrations applied from ${migrationsFolder}`);
} catch (err) {
  console.error("migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await database.close();
}
