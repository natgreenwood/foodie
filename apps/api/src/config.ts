import { BlockList, isIP } from "node:net";
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
  // Fastify's trustProxy: the addresses or CIDR ranges of the proxies whose
  // X-Forwarded-For is believed, or false to believe none and use the socket
  // address. Never true or a hop count, which would let a client that
  // reaches the api directly choose its own request.ip.
  trustProxy: string[] | false;
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

// Why one TRUST_PROXY entry is refused, or null if it is an IPv4 or IPv6
// address with an optional /prefix in range for it. Beyond malformed input
// this catches only the obvious trust-everyone values: a list whose ranges
// add up to everything still passes, so the README's proxy-only rule is
// the real control.
function trustProxyProblem(entry: string): string | null {
  if (entry.includes("%")) {
    return `"${entry}" has a zone identifier (%), which is not accepted`;
  }
  const [address = "", prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  const malformed = `"${entry}" is not an IP address or CIDR range, e.g. "127.0.0.1" or "10.0.0.0/8"`;
  if (family === 0 || rest.length > 0) return malformed;
  if (prefix === undefined) return null;
  if (!/^\d{1,3}$/.test(prefix)) return malformed;
  const length = Number(prefix);
  if (length > (family === 4 ? 32 : 128)) return malformed;
  if (length === 0) return `"${entry}" would trust every peer`;
  // Fastify matches an IPv4 peer, including one arriving IPv4-mapped on a
  // dual-stack socket, against ::ffff:0.0.0.0/96 too.
  if (family === 6 && length <= 96) {
    const range = new BlockList();
    range.addSubnet(address, length, "ipv6");
    if (range.check("::ffff:0.0.0.0", "ipv6")) {
      return `"${entry}" contains ::ffff:0.0.0.0/96, so it would trust every IPv4 peer`;
    }
  }
  return null;
}

// Comma-separated proxy addresses or CIDRs; unset or empty means trust none.
// A bare number such as "1" is refused rather than read as a hop count.
function parseTrustProxy(raw: string | undefined): string[] | false {
  if (raw === undefined || raw.trim() === "") return false;
  const entries = raw.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const problem = trustProxyProblem(entry);
    if (problem !== null) {
      throw new ConfigError(`TRUST_PROXY: ${problem}`);
    }
  }
  return entries;
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
