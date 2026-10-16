import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  measurements,
  UNIT,
  unitKeys,
} from "../import/extract/__fixtures__/units.js";
import {
  FetchFailedError,
  InvalidUrlError,
  NotPermittedError,
  type FetchedPage,
  type FetchFailureReason,
} from "../import/fetch.js";
import type { ImportDeps } from "./imports.js";

const URL_ = "https://www.example.com.au/recipes/spaghetti";
const FETCHED_AT = new Date("2026-10-16T12:00:00Z");

function fixture(name: string): string {
  return readFileSync(
    new URL(`../import/extract/__fixtures__/${name}`, import.meta.url),
    "utf8",
  );
}

function page(html: string, overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    html,
    finalUrl: URL_,
    status: 200,
    strategy: "impit",
    fetchedAt: FETCHED_AT,
    cached: false,
    ...overrides,
  };
}

let app: FastifyInstance;
let logLines: Record<string, unknown>[];

// The fetch is mocked: these tests cover the route and its error mapping.
function start(
  fetchPage: ImportDeps["fetchPage"],
  loadUnits?: ImportDeps["loadUnits"],
) {
  logLines = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  app = buildApp(
    {
      pingDatabase: () => Promise.resolve(),
      fetchPage,
      loadUnits:
        loadUnits ?? (() => Promise.resolve({ measurements, unitKeys })),
    },
    { logger: { level: "info", stream } },
  );
  return app;
}

function preview(payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/imports/preview",
    payload: payload as object,
  });
}

function previewLog() {
  return logLines.filter((l) => String(l.msg).startsWith("import preview"));
}

afterEach(async () => {
  await app.close();
});

describe("POST /imports/preview", () => {
  it("returns the page's recipe as a draft", async () => {
    const fetchPage = vi.fn(() =>
      Promise.resolve(page(fixture("json-ld-single.html"))),
    );
    start(fetchPage);

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      sourceUrl: URL_,
      fetchedAt: "2026-10-16T12:00:00.000Z",
      fetchStrategy: "impit",
      extraction: "json-ld",
      warnings: [],
      recipe: {
        title: "Spaghetti with Tomato & Basil Sauce",
        servings: 4,
        prepMinutes: 15,
        cookMinutes: 90,
        tags: ["pasta", "Dinner", "vegetarian", "Main course"],
      },
    });
    expect(Object.keys(body)).toEqual([
      "sourceUrl",
      "fetchedAt",
      "fetchStrategy",
      "extraction",
      "warnings",
      "recipe",
    ]);
    expect((body.recipe as { ingredients: unknown[] }).ingredients[0]).toEqual({
      position: 1,
      rawText: "1 1/2 cups plain flour, sifted",
      quantity: "1.5",
      quantityText: "1 1/2",
      unit: { measurementId: UNIT.cupMetric, key: "cup_metric" },
      unitText: "cups",
      ingredientText: "plain flour, sifted",
      prepNotes: null,
      notes: null,
      flags: [],
      section: null,
    });
    expect(fetchPage).toHaveBeenCalledWith(URL_, { refresh: false });
  });

  it("passes refresh through to the fetch", async () => {
    const fetchPage = vi.fn(() =>
      Promise.resolve(page(fixture("json-ld-single.html"))),
    );
    start(fetchPage);

    await preview({ url: URL_, refresh: true });

    expect(fetchPage).toHaveBeenCalledWith(URL_, { refresh: true });
  });

  it("logs one line per preview with URL, strategy, extraction and ingredient count", async () => {
    start(() =>
      Promise.resolve(
        page(fixture("json-ld-two-recipes.html"), { cached: true }),
      ),
    );

    await preview({ url: URL_ });

    expect(previewLog()).toEqual([
      expect.objectContaining({
        level: 30,
        msg: "import preview",
        url: URL_,
        strategy: "impit",
        cached: true,
        extraction: "json-ld",
        ingredients: 2,
        warnings: ["multiple_recipes_found"],
      }),
    ]);
  });

  it("reads microdata when the page has no JSON-LD recipe", async () => {
    start(() => Promise.resolve(page(fixture("microdata.html"))));

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      extraction: "microdata",
      recipe: { title: "Grandma's Scones" },
    });
  });

  it("returns 404 no_recipe_found for a page with neither", async () => {
    start(() => Promise.resolve(page(fixture("no-recipe.html"))));

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "no_recipe_found",
      message: "the page has no schema.org Recipe in JSON-LD or microdata",
      url: URL_,
    });
    expect(previewLog()).toEqual([
      expect.objectContaining({ extraction: null, ingredients: 0 }),
    ]);
  });

  it.each([
    ["no body", undefined, "", "url must be a string"],
    ["a non-string url", { url: 42 }, "", "url must be a string"],
    [
      "a non-boolean refresh",
      { url: URL_, refresh: "yes" },
      URL_,
      "refresh must be a boolean",
    ],
  ])("returns 400 invalid_url for %s", async (_, payload, url, message) => {
    const fetchPage = vi.fn();
    start(fetchPage);

    const res = await preview(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_url", message, url });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON that does not parse", "{bad json"],
    ["an empty JSON body", ""],
  ])("returns 400 invalid_url for %s", async (_, payload) => {
    const fetchPage = vi.fn();
    start(fetchPage);

    const res = await app.inject({
      method: "POST",
      url: "/imports/preview",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_url",
      message: "body must be JSON",
      url: "",
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_url when fetchPage rejects the URL, without logging it", async () => {
    const raw = "ftp://user:hunter2@example.com/pie";
    start(() =>
      Promise.reject(
        new InvalidUrlError(
          `invalid URL: ftp: is not http or https (${JSON.stringify(raw)})`,
        ),
      ),
    );

    const res = await preview({ url: raw });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_url", url: raw });
    expect(JSON.stringify(logLines)).not.toContain("hunter2");
  });

  it("returns 451 import_not_permitted for an HTTP 402", async () => {
    start(() => Promise.reject(new NotPermittedError(URL_, "http")));

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(451);
    expect(res.json()).toEqual({
      error: "import_not_permitted",
      message: `${URL_} does not permit import: HTTP 402 to http`,
      url: URL_,
    });
  });

  it.each<FetchFailureReason>([
    "unreachable",
    "blocked",
    "challenged",
    "http_error",
  ])("returns 422 fetch_failed with reason %s", async (reason) => {
    const err = new FetchFailedError(URL_, reason, 503, ["http: 503"]);
    start(() => Promise.reject(err));

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: "fetch_failed",
      message: err.message,
      url: URL_,
      reason,
    });
  });

  it("returns 500 without the cause when the fetch fails unexpectedly", async () => {
    start(() =>
      Promise.reject(
        new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
      ),
    );

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "internal_error",
      message: "the page could not be fetched",
      url: URL_,
    });
    expect(res.body).not.toContain("hunter2");
  });

  it("returns 500 without the cause when the units cannot be loaded", async () => {
    start(
      () => Promise.resolve(page(fixture("json-ld-single.html"))),
      () => Promise.reject(new Error("relation measurement does not exist")),
    );

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "internal_error",
      message: "the page could not be read",
      url: URL_,
    });
  });
});
