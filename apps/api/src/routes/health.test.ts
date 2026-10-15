import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

describe("GET /health", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 and db up when the database answers", async () => {
    app = buildApp({ pingDatabase: () => Promise.resolve() });

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "up" });
  });

  it("returns 503 and db down when the database is unreachable", async () => {
    app = buildApp({
      pingDatabase: () =>
        Promise.reject(
          new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
        ),
    });

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", db: "down" });
    expect(res.body).not.toContain("hunter2");
  });
});
