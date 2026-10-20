import { Writable } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm";
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
        level: 50,
        route: "DELETE /recipes/:id",
        module: "recipes",
        errorName: "Error",
        code: null,
      }),
    ]);
    expect(JSON.stringify(logLines)).not.toContain("secret@x.test");
  });

  // NATG-365: a request value can reach a log line through any message in the
  // cause chain. Here it is a query parameter in Drizzle's message, one with a
  // newline that makes the next line look like a stack frame, and the value
  // Postgres quotes in the error Drizzle wraps.
  it("logs nothing of any message in a failed query's cause chain", async () => {
    const { app, logLines } = start();
    const marker = "MARKER-3c91";
    app.get("/recipes/broken", () => {
      const pgError = Object.assign(
        new Error(`invalid input syntax for type uuid: "${marker}"`),
        { name: "error", code: "22P02", detail: marker },
      );
      throw new DrizzleQueryError(
        "select * from recipe where id = $1",
        [`${marker}\n    at ${marker} (file:///app/x.js:1:1)`],
        pgError,
      );
    });

    const res = await app.inject({ method: "GET", url: "/recipes/broken" });

    expect(res.statusCode).toBe(500);
    expect(logLines).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: "recipes: request failed",
        route: "GET /recipes/broken",
        module: "recipes",
        errorName: "DrizzleQueryError",
        code: "22P02",
      }),
    );
    const serialised = JSON.stringify(logLines);
    expect(serialised).not.toContain(marker);
    expect(serialised).not.toContain("Failed query");
    expect(serialised).not.toContain("invalid input syntax");
  });

  it("logs where an error was thrown, but not its message", async () => {
    const { app, logLines } = start();
    app.get("/recipes/typo", () => {
      const missing: { title?: { trim(): string } } = {};
      return missing.title!.trim();
    });

    await app.inject({ method: "GET", url: "/recipes/typo" });

    const failure = logLines.find((l) => l.msg === "recipes: request failed");
    expect(failure).toMatchObject({ errorName: "TypeError", code: null });
    const frames = failure?.frames as string[];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(5);
    expect(frames[0]).toMatch(/^at .*errors\.test\.ts:\d+:\d+\)?$/);
    expect(JSON.stringify(logLines)).not.toContain("reading 'trim'");
  });

  it("logs no property name a function was called through", async () => {
    const { app, logLines } = start();
    const handlers: Record<string, () => never> = {};
    app.get<{ Params: { kind: string } }>("/recipes/kind/:kind", (request) => {
      handlers[request.params.kind] = function () {
        throw new Error("unexpected kind");
      };
      return handlers[request.params.kind]!();
    });

    await app.inject({ method: "GET", url: "/recipes/kind/kind-7e2b" });

    const failure = logLines.find((l) => l.msg === "recipes: request failed");
    expect((failure?.frames as string[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(failure)).not.toContain("kind-7e2b");
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

  it("keeps the status of Fastify's own 4xx errors and logs them at warn", async () => {
    const { app, logLines } = start();

    const res = await app.inject({
      method: "POST",
      url: "/recipes",
      headers: { "content-type": "application/xml" },
      payload: "<recipe/>",
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({
      error: "invalid_request",
      message: "content type is not supported",
    });
    expect(logLines.filter((l) => (l.level as number) >= 50)).toEqual([]);
    expect(logLines).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: "recipes: request refused",
        route: "POST /recipes",
        status: 415,
      }),
    );
  });

  it("never sends or logs the message of a Fastify validation error", async () => {
    const { app, logLines } = start();
    // A validator whose error message carries request data, which Fastify
    // wraps as FST_ERR_VALIDATION with status 400.
    app.post(
      "/recipes/validated",
      {
        schema: { body: {} },
        validatorCompiler: () => () => ({
          error: new Error("private-marker-7f3a"),
        }),
      },
      () => ({ ok: true }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/recipes/validated",
      payload: { title: "x" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_request",
      message: "request was not accepted",
    });
    expect(logLines).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: "recipes: request refused",
        code: "FST_ERR_VALIDATION",
      }),
    );
    expect(JSON.stringify(logLines)).not.toContain("private-marker-7f3a");
  });

  it("answers a thrown 4xx that is not Fastify's with 500", async () => {
    const { app } = start();
    app.get("/recipes/teapot", () => {
      throw Object.assign(new Error("detail not for clients"), {
        statusCode: 418,
      });
    });

    const res = await app.inject({ method: "GET", url: "/recipes/teapot" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "internal_error",
      message: "something went wrong",
    });
  });
});
