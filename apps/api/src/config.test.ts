import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const databaseUrl = "postgres://foodie:s3cret@localhost:5432/foodie";
// Not a secret: a test value, the bytes 0 to 31.
const settingsKeyBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const settingsKey = settingsKeyBytes.toString("hex");

describe("loadConfig", () => {
  it("applies defaults when only the required variables are set", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 3000,
      logLevel: "info",
      databaseUrl,
      admin: null,
      secureCookies: true,
      settingsEncryptionKey: settingsKeyBytes,
      trustProxy: false,
    });
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      SETTINGS_ENCRYPTION_KEY: settingsKey,
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "debug",
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      logLevel: "debug",
    });
  });

  it("fails when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it.each(["0", "65536", "abc", "30.5"])("rejects invalid PORT %s", (port) => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        PORT: port,
      }),
    ).toThrow(ConfigError);
  });

  it("reads the admin account when both variables are set", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      SETTINGS_ENCRYPTION_KEY: settingsKey,
      ADMIN_USER: " Admin@Example.com ",
      ADMIN_PASSWORD: "correct horse",
    });
    expect(config.admin).toEqual({
      email: "Admin@Example.com",
      password: "correct horse",
    });
  });

  it.each([
    ["ADMIN_USER", { ADMIN_USER: "admin@example.com" }],
    ["ADMIN_PASSWORD", { ADMIN_PASSWORD: "correct horse" }],
  ])("fails when only %s is set", (_, admin) => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        ...admin,
      }),
    ).toThrow(
      new ConfigError(
        "ADMIN_USER and ADMIN_PASSWORD must be set together, or neither",
      ),
    );
  });

  it("treats empty admin variables as unset", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      SETTINGS_ENCRYPTION_KEY: settingsKey,
      ADMIN_USER: "",
      ADMIN_PASSWORD: "",
    });
    expect(config.admin).toBeNull();
  });

  it("rejects an ADMIN_USER that is not an email address", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        ADMIN_USER: "admin",
        ADMIN_PASSWORD: "correct horse",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a short ADMIN_PASSWORD without echoing it", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        ADMIN_USER: "admin@example.com",
        ADMIN_PASSWORD: "hunter2",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "ConfigError",
        message: expect.not.stringContaining("hunter2") as string,
      }) as Error,
    );
  });

  it("drops Secure from the session cookie only in development", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        NODE_ENV: "development",
      }).secureCookies,
    ).toBe(false);
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        NODE_ENV: "production",
      }).secureCookies,
    ).toBe(true);
  });

  it.each([
    ["hex", settingsKey],
    ["base64", settingsKeyBytes.toString("base64")],
    ["unpadded base64url", settingsKeyBytes.toString("base64url")],
  ])("reads SETTINGS_ENCRYPTION_KEY as %s", (_, raw) => {
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, SETTINGS_ENCRYPTION_KEY: raw })
        .settingsEncryptionKey,
    ).toEqual(settingsKeyBytes);
  });

  it.each([undefined, ""])(
    "fails when SETTINGS_ENCRYPTION_KEY is %j",
    (raw) => {
      expect(() =>
        loadConfig({ DATABASE_URL: databaseUrl, SETTINGS_ENCRYPTION_KEY: raw }),
      ).toThrow(ConfigError);
    },
  );

  it.each([
    ["31 bytes of hex", settingsKey.slice(2)],
    ["33 bytes of base64", Buffer.alloc(33, 7).toString("base64")],
    ["16 bytes of base64", Buffer.alloc(16, 7).toString("base64")],
    ["a passphrase", "correct horse battery staple, but longer than that"],
  ])("rejects a SETTINGS_ENCRYPTION_KEY of %s without echoing it", (_, raw) => {
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, SETTINGS_ENCRYPTION_KEY: raw }),
    ).toThrow(
      expect.objectContaining({
        name: "ConfigError",
        message: expect.not.stringContaining(raw) as string,
      }) as Error,
    );
  });

  it.each([
    ["one address", "127.0.0.1", ["127.0.0.1"]],
    [
      "a list of ranges",
      " 10.0.0.0/8, 172.16.0.0/12 ",
      ["10.0.0.0/8", "172.16.0.0/12"],
    ],
    ["IPv6", "::1,fd00::/8", ["::1", "fd00::/8"]],
  ])("reads TRUST_PROXY as %s", (_, raw, expected) => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        TRUST_PROXY: raw,
      }).trustProxy,
    ).toEqual(expected);
  });

  it("treats an empty TRUST_PROXY as unset", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        TRUST_PROXY: "",
      }).trustProxy,
    ).toBe(false);
  });

  // "1" is the hop count of the original proposal, which Fastify ignores.
  it.each([
    "1",
    "0",
    "true",
    "yes",
    "loopback",
    "10.0.0.0/99",
    "::1/129",
    "10.0.0.0/8/8",
    "10.0.0.0/",
    "256.0.0.1",
    "127.0.0.1,",
  ])("rejects TRUST_PROXY %j", (raw) => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        SETTINGS_ENCRYPTION_KEY: settingsKey,
        TRUST_PROXY: raw,
      }),
    ).toThrow(ConfigError);
  });
});
