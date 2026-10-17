import { buildApp, logRedactPaths, logSerializers } from "./app.js";
import { ensureAdmin } from "./auth/accounts.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { describeError } from "./db/errors.js";
import { importDeps } from "./routes/imports.js";

const config = loadConfig();

const database = createDatabase(config.databaseUrl, (err) => {
  app.log.error({ err }, "postgres idle client error");
});

const app = buildApp(
  {
    pingDatabase: () => database.ping(),
    ...importDeps(database.db),
    db: database.db,
    secureCookies: config.secureCookies,
    settingsKey: config.settingsEncryptionKey,
  },
  {
    logger: {
      level: config.logLevel,
      redact: logRedactPaths,
      serializers: logSerializers,
    },
  },
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

if (config.admin) {
  try {
    const outcome = await ensureAdmin(database.db, config.admin);
    app.log.info({ email: config.admin.email, outcome }, "admin bootstrap");
  } catch (err) {
    // describeError keeps the first line of a failed query, not its
    // parameters, which include the password hash.
    app.log.error({ error: describeError(err) }, "admin bootstrap failed");
    await database.close();
    process.exit(1);
  }
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, "failed to start server");
  await database.close();
  process.exit(1);
}
