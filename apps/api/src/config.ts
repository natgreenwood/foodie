export interface Config {
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `PORT must be an integer between 1 and 65535, got "${raw}"`,
    );
  }
  return port;
}

// Reads configuration from the environment and fails fast on anything
// missing or malformed. Values are never echoed back for DATABASE_URL because
// it carries the database password.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError("DATABASE_URL is required");
  }
  return {
    host: env.HOST || "0.0.0.0",
    port: parsePort(env.PORT),
    logLevel: env.LOG_LEVEL || "info",
    databaseUrl,
  };
}
