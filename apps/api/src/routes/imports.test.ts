import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppSeams } from "../app.js";
import { createSession } from "../auth/accounts.js";
import { ingredient, measurement, recipe, user } from "../db/schema.js";
import { measurements, UNIT } from "../import/extract/__fixtures__/units.js";
import {
  FetchFailedError,
  InvalidUrlError,
  NotPermittedError,
  type FetchedPage,
  type FetchFailureReason,
} from "../import/fetch.js";
import { MAX_LINE_CHARS } from "../import/extract/extract.js";
import { AI_NOT_CONFIGURED_MESSAGE } from "../import/match-ingredients.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { SESSION_COOKIE, type AuthDeps } from "./auth.js";
import {
  MAX_LINES,
  MAX_STEPS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  type ImportDeps,
} from "./imports.js";

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

// Every request is signed in as this user without a database: the session
// check itself is covered in auth.test.ts and below.
const signedInAsCook: AppSeams = {
  requireUser: (request) => {
    request.user = {
      id: 1,
      email: "cook@imports.test",
      displayName: null,
      locale: "en-GB",
      isAdmin: false,
    };
    return Promise.resolve();
  },
};

// Every line unmatched, with no candidates and the model never asked. The
// match itself is covered in match-ingredients.test.ts.
const noMatches: ImportDeps["matchIngredients"] = (ingredients) =>
  Promise.resolve({
    ingredients: ingredients.map((line) => ({
      ...line,
      flags: [...line.flags, "ingredient_unmatched" as const],
    })),
    matching: { status: "ok" },
  });

// The fetch is mocked: these tests cover the route and its error mapping.
function start(
  fetchPage: ImportDeps["fetchPage"],
  loadUnits?: ImportDeps["loadUnits"],
  {
    db = {} as AuthDeps["db"],
    seams = signedInAsCook,
    matchIngredients = noMatches,
  }: {
    db?: AuthDeps["db"];
    seams?: AppSeams;
    matchIngredients?: ImportDeps["matchIngredients"];
  } = {},
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
      loadUnits: loadUnits ?? (() => Promise.resolve({ measurements })),
      matchIngredients,
      db,
      secureCookies: false,
      settingsKey: Buffer.alloc(32),
    },
    { logger: { level: "info", stream } },
    seams,
  );
  return app;
}

function preview(payload: unknown, token?: string) {
  return app.inject({
    method: "POST",
    url: "/imports/preview",
    payload: payload as object,
    cookies: token ? { [SESSION_COOKIE]: token } : {},
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
      "ingredientMatching",
    ]);
    expect((body.recipe as { ingredients: unknown[] }).ingredients[0]).toEqual({
      position: 1,
      rawText: "1 1/2 cups plain flour, sifted",
      quantity: "1.5",
      quantityText: "1 1/2",
      unit: { measurementId: UNIT.cupMetric, key: "cup_metric" },
      unitText: "cups",
      ingredientText: "plain flour",
      prepNotes: "sifted",
      notes: null,
      flags: ["ingredient_unmatched"],
      section: null,
      ingredientId: null,
      candidates: [],
    });
    expect(body.ingredientMatching).toEqual({ status: "ok" });
    expect(fetchPage).toHaveBeenCalledWith(URL_, { refresh: false });
  });

  it("carries each line's proposed ingredient and candidates", async () => {
    const candidate = {
      ingredientId: 7,
      name: "plain flour",
      locale: "en-GB",
      similarity: 1,
    };
    const matchIngredients = vi.fn<ImportDeps["matchIngredients"]>(
      (ingredients) =>
        Promise.resolve({
          ingredients: ingredients.map((line) =>
            line.position === 1
              ? { ...line, ingredientId: 7, candidates: [candidate] }
              : {
                  ...line,
                  flags: [...line.flags, "ingredient_unmatched" as const],
                },
          ),
          matching: { status: "ok" },
        }),
    );
    start(
      () => Promise.resolve(page(fixture("json-ld-single.html"))),
      undefined,
      {
        matchIngredients,
      },
    );

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      recipe: { ingredients: Record<string, unknown>[] };
    }>();
    expect(body.recipe.ingredients[0]).toMatchObject({
      ingredientText: "plain flour",
      ingredientId: 7,
      candidates: [candidate],
      flags: [],
    });
    expect(body.recipe.ingredients[1]).toMatchObject({
      ingredientId: null,
      flags: ["ingredient_unmatched"],
    });
    // The page's host decides the locale tie-break.
    expect(matchIngredients).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ position: 1, ingredientText: "plain flour" }),
      ]),
      expect.objectContaining({ sourceHost: "www.example.com.au" }),
    );
    expect(previewLog()).toEqual([
      expect.objectContaining({
        msg: "import preview",
        matched: 1,
        matching: "ok",
      }),
    ]);
  });

  it("still returns the preview when AI is not configured, saying why", async () => {
    start(
      () => Promise.resolve(page(fixture("json-ld-single.html"))),
      undefined,
      {
        matchIngredients: (ingredients) =>
          Promise.resolve({
            ingredients: ingredients.map((line) => ({
              ...line,
              flags: [...line.flags, "ingredient_unmatched" as const],
            })),
            matching: {
              status: "ai_not_configured",
              message: AI_NOT_CONFIGURED_MESSAGE,
            },
          }),
      },
    );

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ingredientMatching: {
        status: "ai_not_configured",
        message: AI_NOT_CONFIGURED_MESSAGE,
      },
    });
  });

  it("answers 500 when the match fails for any other reason", async () => {
    start(
      () => Promise.resolve(page(fixture("json-ld-single.html"))),
      undefined,
      {
        matchIngredients: () => Promise.reject(new Error("connection lost")),
      },
    );

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "internal_error",
      message: "the ingredients could not be matched",
      url: URL_,
    });
    expect(previewLog()).toEqual([
      expect.objectContaining({
        level: 50,
        msg: "import preview: ingredient match error",
      }),
    ]);
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

  it("returns 404 no_recipe_found for a page past the extraction budget", async () => {
    const html = `<html><body><div itemscope itemtype="https://schema.org/Recipe">${'<meta itemprop="name" content="a">'.repeat(2_000)}</div></body></html>`;
    start(() => Promise.resolve(page(html)));

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "no_recipe_found",
      message: "the page has no schema.org Recipe that could be read",
      url: URL_,
    });
    expect(previewLog()).toEqual([
      expect.objectContaining({
        level: 40,
        msg: "import preview: extraction budget exceeded",
        url: URL_,
        budgetExceeded: "valuesPerProperty",
      }),
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

  // NATG-257: a 2xx that is not an HTML page, or is too big to read.
  it.each<[FetchFailureReason, string]>([
    ["not_html", "http: 200 not_html (application/pdf)"],
    ["too_large", "http: 200 too_large (over 5242880 bytes)"],
  ])(
    "returns 422 fetch_failed with reason %s for a 200 fetchPage refuses",
    async (reason, attempt) => {
      const err = new FetchFailedError(URL_, reason, 200, [attempt]);
      start(() => Promise.reject(err));

      const res = await preview({ url: URL_ });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error: "fetch_failed",
        message: err.message,
        url: URL_,
        reason,
      });
      expect(previewLog()).toEqual([
        expect.objectContaining({
          msg: "import preview: fetch failed",
          reason,
        }),
      ]);
    },
  );

  it("returns 400 invalid_url for a destination fetchPage refuses", async () => {
    const err = new FetchFailedError(URL_, "blocked_destination", 302, [
      "http: 302 to 10.0.0.5, blocked_destination (private address 10.0.0.5)",
    ]);
    start(() => Promise.reject(err));

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_url",
      message: "destination not allowed",
      url: URL_,
    });
    expect(res.body).not.toContain("10.0.0.5");
    expect(previewLog()).toEqual([
      expect.objectContaining({
        msg: "import preview: fetch failed",
        reason: "blocked_destination",
      }),
    ]);
  });

  it("returns 422 fetch_failed with reason too_many_redirects", async () => {
    const err = new FetchFailedError(URL_, "too_many_redirects", 301, [
      "http: 301 too_many_redirects (over 5)",
    ]);
    start(() => Promise.reject(err));

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: "fetch_failed",
      message: err.message,
      url: URL_,
      reason: "too_many_redirects",
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

// The real session check, not the seam above.
describe("POST /imports/preview session", () => {
  it("returns 401 without a session, before fetching", async () => {
    const fetchPage = vi.fn(() =>
      Promise.resolve(page(fixture("json-ld-single.html"))),
    );
    start(fetchPage, undefined, { seams: {} });

    const res = await preview({ url: URL_ });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthenticated",
      message: "sign in required",
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  dbTest("returns 401 for a session that does not exist", async ({ tx }) => {
    const fetchPage = vi.fn(() =>
      Promise.resolve(page(fixture("json-ld-single.html"))),
    );
    start(fetchPage, undefined, { db: tx, seams: {} });

    const res = await preview({ url: URL_ }, "no-such-session");

    expect(res.statusCode).toBe(401);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  dbTest("returns the draft for a signed-in request", async ({ tx }) => {
    const [cook] = await tx
      .insert(user)
      .values({ email: "cook@imports.test" })
      .returning({ id: user.id });
    const { token } = await createSession(tx, cook!.id);
    start(
      () => Promise.resolve(page(fixture("json-ld-single.html"))),
      undefined,
      {
        db: tx,
        seams: {},
      },
    );

    const res = await preview({ url: URL_ }, token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sourceUrl: URL_,
      recipe: { title: "Spaghetti with Tomato & Basil Sauce" },
    });
  });
});

describe("POST /imports", () => {
  const SOURCE = "https://www.example.com/recipes/dal";
  const noFetch = () => Promise.reject(new Error("save never fetches"));

  // A signed-in cook with a session, and a catalogue ingredient and unit.
  async function setUp(tx: TestTransaction) {
    const [cook] = await tx
      .insert(user)
      .values({ email: `cook-${crypto.randomUUID()}@imports.test` })
      .returning({ id: user.id });
    const { token } = await createSession(tx, cook!.id);
    const [lentils] = await tx
      .insert(ingredient)
      .values({ source: "test" })
      .returning({ id: ingredient.id });
    const [gram] = await tx
      .insert(measurement)
      .values({ type: "mass", factorToBase: "1" })
      .returning({ id: measurement.id });
    start(noFetch, undefined, { db: tx, seams: {} });
    return {
      cookId: cook!.id,
      token,
      lentilsId: lentils!.id,
      gramId: gram!.id,
    };
  }

  // A reviewed draft as the web app posts it back: the preview's lines, each
  // with the catalogue ids the cook settled on.
  function reviewed(
    ids: { lentilsId: number; gramId: number },
    lines?: Record<string, unknown>[],
  ) {
    return {
      sourceUrl: SOURCE,
      recipe: {
        title: "Dal",
        servings: 4,
        prepMinutes: 10,
        cookMinutes: 30,
        ingredients: lines ?? [
          {
            position: 1,
            rawText: "250 g red lentils, rinsed",
            quantity: "250",
            unit: { measurementId: ids.gramId, key: null },
            ingredientText: "red lentils",
            prepNotes: "rinsed",
            notes: null,
            ingredientId: ids.lentilsId,
            measurementId: ids.gramId,
          },
          {
            position: 2,
            rawText: "Salt to taste",
            quantity: null,
            unit: null,
            ingredientText: "Salt",
            prepNotes: null,
            notes: "to taste",
            ingredientId: ids.lentilsId,
            measurementId: null,
          },
        ],
        steps: [{ position: 1, text: "Simmer the lentils." }],
        tags: ["dinner"],
      },
    };
  }

  function save(payload: unknown, token?: string) {
    return app.inject({
      method: "POST",
      url: "/imports",
      payload: payload as object,
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });
  }

  function rejectionLog() {
    return logLines.filter((l) => l.msg === "import save: rejected");
  }

  it("returns 401 without a session", async () => {
    start(noFetch, undefined, { seams: {} });

    const res = await save({ sourceUrl: SOURCE, recipe: {} });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthenticated",
      message: "sign in required",
    });
  });

  dbTest("saves the draft as the cook's recipe", async ({ tx }) => {
    const ids = await setUp(tx);

    const res = await save(reviewed(ids), ids.token);

    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      title: "Dal",
      sourceUrl: SOURCE,
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 30,
      alreadyImported: false,
    });
    expect(body).not.toHaveProperty("ownerId");
    const [row] = await tx
      .select({ ownerId: recipe.ownerId })
      .from(recipe)
      .where(eq(recipe.id, body.id as number));
    expect(row).toEqual({ ownerId: ids.cookId });
  });

  dbTest(
    "saves a URL the cook already has, normalised as fetchPage does, and says so",
    async ({ tx }) => {
      const ids = await setUp(tx);
      await save(reviewed(ids), ids.token);

      const res = await save(
        { ...reviewed(ids), sourceUrl: `${SOURCE}/?utm_source=x#method` },
        ids.token,
      );

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        sourceUrl: SOURCE,
        alreadyImported: true,
      });
    },
  );

  dbTest(
    "rejects unresolved lines with their positions, and logs them",
    async ({ tx }) => {
      const ids = await setUp(tx);
      const missing = Math.max(ids.lentilsId, ids.gramId) + 1000;
      const line = (position: number, extra: Record<string, unknown>) => ({
        position,
        quantity: "1",
        ingredientId: ids.lentilsId,
        measurementId: ids.gramId,
        ...extra,
      });

      const res = await save(
        reviewed(ids, [
          line(1, {}),
          line(2, { ingredientId: undefined }),
          line(3, { measurementId: undefined }),
          line(4, { ingredientId: missing }),
        ]),
        ids.token,
      );

      // Missing ids are caught before the database is asked.
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error: "unresolved_lines",
        message:
          "every line needs an ingredientId, and a measurementId or null for no unit",
        positions: [2, 3],
      });
      expect(rejectionLog()).toEqual([
        expect.objectContaining({
          userId: ids.cookId,
          error: "unresolved_lines",
          positions: [2, 3],
        }),
      ]);

      const again = await save(
        reviewed(ids, [line(1, {}), line(4, { ingredientId: missing })]),
        ids.token,
      );

      expect(again.statusCode).toBe(422);
      expect(again.json()).toMatchObject({
        error: "unresolved_lines",
        positions: [4],
      });
      expect(
        await tx.select().from(recipe).where(eq(recipe.ownerId, ids.cookId)),
      ).toEqual([]);
    },
  );

  // A private-link URL can carry a secret in its path or query (SEC-1).
  dbTest(
    "logs a rejection without any part of the source URL",
    async ({ tx }) => {
      const ids = await setUp(tx);
      const sourceUrl =
        "https://example.com/share/PATHTOKEN9f3a/dal?token=QUERYTOKEN7c1e";
      const tooMany = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
      const unresolved = reviewed(ids, [{ position: 1, quantity: "1" }]);

      const invalid = await save(
        {
          ...reviewed(ids),
          sourceUrl,
          recipe: { ...reviewed(ids).recipe, tags: tooMany },
        },
        ids.token,
      );
      const unprocessable = await save({ ...unresolved, sourceUrl }, ids.token);

      expect(invalid.statusCode).toBe(400);
      expect(unprocessable.statusCode).toBe(422);
      expect(rejectionLog()).toEqual([
        expect.objectContaining({
          userId: ids.cookId,
          error: "invalid_request",
        }),
        expect.objectContaining({
          userId: ids.cookId,
          error: "unresolved_lines",
          positions: [1],
        }),
      ]);
      for (const line of rejectionLog()) {
        expect(line).not.toHaveProperty("sourceUrl");
      }
      const everything = JSON.stringify(logLines);
      expect(everything).not.toContain("PATHTOKEN9f3a");
      expect(everything).not.toContain("QUERYTOKEN7c1e");
    },
  );

  dbTest(
    "rejects a quantity of 0 and over-long notes as invalid lines",
    async ({ tx }) => {
      const ids = await setUp(tx);
      const [first, second] = reviewed(ids).recipe.ingredients;

      const res = await save(
        reviewed(ids, [
          { ...first, quantity: "0" },
          { ...second, notes: "x".repeat(MAX_LINE_CHARS + 1) },
          { ...first, position: 3, quantity: 1.5 },
        ]),
        ids.token,
      );

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: "invalid_lines",
        positions: [1, 2],
      });
    },
  );

  dbTest("rejects a blank step as an invalid step", async ({ tx }) => {
    const ids = await setUp(tx);
    const body = reviewed(ids);
    body.recipe.steps = [
      { position: 1, text: "Simmer." },
      { position: 2, text: " \n " },
    ];

    const res = await save(body, ids.token);

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: "invalid_steps",
      positions: [2],
    });
  });

  dbTest.for([
    ["a sourceUrl that is not http", { sourceUrl: "ftp://example.com/dal" }],
    ["a blank title", { title: "  " }],
    ["duplicate line positions", { duplicate: true }],
    ["a zero servings", { servings: 0 }],
  ] as const)(
    "answers 400 invalid_request for %s",
    async ([, change], { tx }) => {
      const ids = await setUp(tx);
      const body = reviewed(ids);
      if ("sourceUrl" in change) body.sourceUrl = change.sourceUrl;
      if ("title" in change) body.recipe.title = change.title;
      if ("servings" in change) body.recipe.servings = change.servings;
      if ("duplicate" in change) {
        body.recipe.ingredients = [
          body.recipe.ingredients[0]!,
          body.recipe.ingredients[0]!,
        ];
      }

      const res = await save(body, ids.token);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
      expect(rejectionLog()).toHaveLength(1);
    },
  );

  // Counts and tag size are capped so a body under the byte limit cannot
  // fail the insert (NATG-316, NATG-317).
  function sized(
    ids: { lentilsId: number; gramId: number },
    counts: { lines?: number; steps?: number; tags?: readonly string[] },
  ) {
    const body = reviewed(
      ids,
      Array.from({ length: counts.lines ?? 1 }, (_, i) => ({
        position: i + 1,
        quantity: "1",
        ingredientId: ids.lentilsId,
        measurementId: null,
      })),
    );
    body.recipe.steps = Array.from({ length: counts.steps ?? 1 }, (_, i) => ({
      position: i + 1,
      text: `Step ${i + 1}.`,
    }));
    body.recipe.tags = [...(counts.tags ?? [])];
    return body;
  }

  const tagsOf = (n: number) => Array.from({ length: n }, (_, i) => `tag ${i}`);

  dbTest.for([
    ["ingredient lines", { lines: MAX_LINES }, { lines: MAX_LINES + 1 }],
    ["steps", { steps: MAX_STEPS }, { steps: MAX_STEPS + 1 }],
    ["tags", { tags: tagsOf(MAX_TAGS) }, { tags: tagsOf(MAX_TAGS + 1) }],
    [
      "tag characters",
      { tags: ["t".repeat(MAX_TAG_CHARS)] },
      { tags: ["t".repeat(MAX_TAG_CHARS + 1)] },
    ],
    [
      "tag characters of 4-byte code points",
      { tags: ["\u{1F345}".repeat(MAX_TAG_CHARS)] },
      { tags: ["\u{1F345}".repeat(MAX_TAG_CHARS + 1)] },
    ],
  ] as const)(
    "takes the most %s allowed and answers 400 for one more",
    async ([, atCap, overCap], { tx }) => {
      const ids = await setUp(tx);

      const ok = await save(sized(ids, atCap), ids.token);
      const over = await save(sized(ids, overCap), ids.token);

      expect(ok.statusCode).toBe(201);
      expect(over.statusCode).toBe(400);
      expect(over.json()).toMatchObject({ error: "invalid_request" });
      expect(
        await tx.select().from(recipe).where(eq(recipe.ownerId, ids.cookId)),
      ).toHaveLength(1);
    },
  );

  dbTest(
    "answers 400 for the NATG-317 tag, leaving no recipe",
    async ({ tx }) => {
      const ids = await setUp(tx);
      // 1,000 CJK characters, 3,000 UTF-8 bytes: past the index entry limit.
      let tag = "";
      for (let i = 0; i < 1000; i++) {
        tag += String.fromCharCode(0x4e00 + ((i * 7919) % 20000));
      }

      const res = await save(
        {
          sourceUrl: "https://example.com/probe",
          recipe: { title: "Probe", ingredients: [], steps: [], tags: [tag] },
        },
        ids.token,
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
      expect(
        await tx.select().from(recipe).where(eq(recipe.ownerId, ids.cookId)),
      ).toEqual([]);
    },
  );

  dbTest("answers an unparseable body in the api's shape", async ({ tx }) => {
    const ids = await setUp(tx);

    const res = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { "content-type": "application/json" },
      payload: "{",
      cookies: { [SESSION_COOKIE]: ids.token },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_request",
      message: "body must be JSON",
    });
  });
});
