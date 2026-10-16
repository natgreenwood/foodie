import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, onTestFinished } from "vitest";
import { apiErrorHandler } from "./errors.js";

// A one-route app whose handler throws, with its log lines collected.
function start() {
  const logLines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  const app = Fastify({ logger: { level: "info", stream } });
  onTestFinished(() => app.close());
  app.setErrorHandler(apiErrorHandler("recipes"));
  app.delete("/recipes/:id", () => {
    throw new Error("Failed query: delete from recipe\nparams: secret@x.test");
  });
  app.post("/recipes", () => ({ ok: true }));
  return { app, logLines };
}

describe("apiErrorHandler", () => {
  it("logs a 500 with the module and route, and answers internal_error", async () => {
    const { app, logLines } = start();

    const res = await app.inject({ method: "DELETE", url: "/recipes/42" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "internal_error",
      message: "something went wrong",
    });
    const failures = logLines.filter(
      (l) => l.msg === "recipes: request failed",
    );
    expect(failures).toEqual([
      expect.objectContaining({
        route: "DELETE /recipes/:id",
        error: "Failed query: delete from recipe",
      }),
    ]);
    expect(JSON.stringify(logLines)).not.toContain("secret@x.test");
  });

  it("answers an unparseable body with 400 invalid_request", async () => {
    const { app } = start();

    const res = await app.inject({
      method: "POST",
      url: "/recipes",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_request",
      message: "body must be JSON",
    });
  });
});
