import { normaliseEmail, passwordProblem } from "./auth/credentials.js";

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  // The account made an admin on every start, from ADMIN_USER and
  // ADMIN_PASSWORD; null when neither is set.
  admin: { email: string; password: string } | null;
  // Secure on the session cookie, so it is only sent over HTTPS. Off only
  // when NODE_ENV is development, as in the compose dev image.
  secureCookies: boolean;
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

// Both or neither. The password is never echoed back.
function parseAdmin(
  env: NodeJS.ProcessEnv,
): { email: string; password: string } | null {
  const rawEmail = env.ADMIN_USER || undefined;
  const password = env.ADMIN_PASSWORD || undefined;
  if (rawEmail === undefined && password === undefined) return null;
  if (rawEmail === undefined || password === undefined) {
    throw new ConfigError(
      "ADMIN_USER and ADMIN_PASSWORD must be set together, or neither",
    );
  }
  const email = normaliseEmail(rawEmail);
  if (email === null) {
    throw new ConfigError("ADMIN_USER must be an email address");
  }
  const problem = passwordProblem(password);
  if (problem !== null) {
    throw new ConfigError(`ADMIN_PASSWORD: ${problem}`);
  }
  return { email, password };
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
    admin: parseAdmin(env),
    secureCookies: env.NODE_ENV !== "development",
  };
}
