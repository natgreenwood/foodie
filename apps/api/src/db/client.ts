import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export interface Database {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
  /** Resolves if Postgres answers a trivial query within `timeoutMs`. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(
  databaseUrl: string,
  onIdleError: (err: Error) => void,
): Database {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  // An idle client losing its connection (e.g. Postgres restarting) emits
  // 'error' on the pool; without a listener that crashes the process.
  pool.on("error", onIdleError);

  return {
    db: drizzle(pool, { schema }),
    pool,
    async ping(timeoutMs = 2_000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`database ping timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      try {
        await Promise.race([pool.query("select 1"), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => pool.end(),
  };
}
