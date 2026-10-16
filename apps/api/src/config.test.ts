import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const databaseUrl = "postgres://foodie:s3cret@localhost:5432/foodie";

describe("loadConfig", () => {
  it("applies defaults when only DATABASE_URL is set", () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toEqual({
      host: "0.0.0.0",
      port: 3000,
      logLevel: "info",
      databaseUrl,
      admin: null,
      secureCookies: true,
    });
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
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
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, PORT: port })).toThrow(
      ConfigError,
    );
  });

  it("reads the admin account when both variables are set", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
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
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, ...admin })).toThrow(
      new ConfigError(
        "ADMIN_USER and ADMIN_PASSWORD must be set together, or neither",
      ),
    );
  });

  it("treats empty admin variables as unset", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      ADMIN_USER: "",
      ADMIN_PASSWORD: "",
    });
    expect(config.admin).toBeNull();
  });

  it("rejects an ADMIN_USER that is not an email address", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        ADMIN_USER: "admin",
        ADMIN_PASSWORD: "correct horse",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a short ADMIN_PASSWORD without echoing it", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
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
      loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "development" })
        .secureCookies,
    ).toBe(false);
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "production" })
        .secureCookies,
    ).toBe(true);
  });
});
