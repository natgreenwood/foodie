import { normaliseEmail, passwordProblem } from "./auth/credentials.js";
import { parseEncryptionKey } from "./settings/encryption.js";

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
  // AES-256 key for settings stored encrypted, such as AI provider API keys.
  settingsEncryptionKey: Buffer;
  // The OIDC provider users may sign in with (NATG-226); null when none of
  // OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URL
  // is set.
  oidc: OidcConfig | null;
}

export interface OidcConfig {
  issuerUrl: URL;
  clientId: string;
  clientSecret: string;
  // Where the provider sends the browser back: the api's
  // /auth/oidc/callback as the browser reaches it, e.g. through /api/.
  redirectUrl: URL;
  // The sign-in button's label; null for the web app's generic one.
  displayName: string | null;
  // Trips to the provider that may be in progress at once, across all
  // browsers; a start beyond it is refused (OIDC_MAX_PENDING_LOGINS).
  maxPendingLogins: number;
  // Starts one client address may make in any minute, per api process
  // (OIDC_STARTS_PER_MINUTE).
  startsPerMinute: number;
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

// Required: without it no AI provider key could be stored or read. The value
// is never echoed back.
function parseSettingsKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new ConfigError(
      "SETTINGS_ENCRYPTION_KEY is required: 32 random bytes as base64 or hex, e.g. from `openssl rand -base64 32`",
    );
  }
  const key = parseEncryptionKey(raw);
  if (key === null) {
    throw new ConfigError(
      "SETTINGS_ENCRYPTION_KEY must be exactly 32 bytes, as 64 hex characters or base64",
    );
  }
  return key;
}

const OIDC_REQUIRED = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URL",
] as const;

// A whole number of at least 1, or the default when unset or empty.
function parseLimit(
  env: NodeJS.ProcessEnv,
  name: "OIDC_MAX_PENDING_LOGINS" | "OIDC_STARTS_PER_MINUTE",
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError(
      `${name} must be a whole number of at least 1, got "${raw}"`,
    );
  }
  return value;
}

// All four or none. Plain http is accepted only in development, where a
// local provider may have no certificate. The secret is never echoed back.
function parseOidc(
  env: NodeJS.ProcessEnv,
  development: boolean,
): OidcConfig | null {
  const set = OIDC_REQUIRED.filter((name) => env[name]);
  if (set.length === 0) return null;
  if (set.length < OIDC_REQUIRED.length) {
    const missing = OIDC_REQUIRED.filter((name) => !env[name]);
    throw new ConfigError(
      `${OIDC_REQUIRED.join(", ")} must be set together, or none; missing ${missing.join(", ")}`,
    );
  }
  const url = (name: "OIDC_ISSUER_URL" | "OIDC_REDIRECT_URL") => {
    const raw = env[name]!;
    const parsed = URL.canParse(raw) ? new URL(raw) : null;
    if (
      !parsed ||
      !(
        parsed.protocol === "https:" ||
        (development && parsed.protocol === "http:")
      )
    ) {
      throw new ConfigError(
        `${name} must be an https URL${development ? " (or http in development)" : ""}, got "${raw}"`,
      );
    }
    return parsed;
  };
  return {
    issuerUrl: url("OIDC_ISSUER_URL"),
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!,
    redirectUrl: url("OIDC_REDIRECT_URL"),
    displayName: env.OIDC_DISPLAY_NAME?.trim() || null,
    maxPendingLogins: parseLimit(env, "OIDC_MAX_PENDING_LOGINS", 1000),
    startsPerMinute: parseLimit(env, "OIDC_STARTS_PER_MINUTE", 10),
  };
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
    settingsEncryptionKey: parseSettingsKey(env.SETTINGS_ENCRYPTION_KEY),
    oidc: parseOidc(env, env.NODE_ENV === "development"),
  };
}
