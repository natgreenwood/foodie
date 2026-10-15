import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";

const config = loadConfig();

const database = createDatabase(config.databaseUrl, (err) => {
  app.log.error({ err }, "postgres idle client error");
});

const app = buildApp(
  { pingDatabase: () => database.ping() },
  { logger: { level: config.logLevel } },
);

app.addHook("onClose", async () => {
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, "failed to start server");
  await database.close();
  process.exit(1);
}
