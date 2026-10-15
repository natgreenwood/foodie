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
});
