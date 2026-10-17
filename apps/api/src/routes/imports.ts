import type {
  FastifyError,
  FastifyPluginCallback,
  FastifyReply,
} from "fastify";
import type { Database } from "../db/client.js";
import {
  createOwnedRecipe,
  type NewRecipe,
  type NewRecipeLine,
  type Recipe,
} from "../db/recipes.js";
import { BudgetExceededError } from "../import/extract/budget.js";
import {
  extractRecipe,
  MAX_LINE_CHARS,
  type ExtractedRecipe,
} from "../import/extract/extract.js";
import {
  defaultStrategies,
  FetchFailedError,
  fetchPage,
  InvalidUrlError,
  normaliseUrl,
  NotPermittedError,
  type FetchedPage,
  type FetchPageOptions,
} from "../import/fetch.js";
import {
  loadMeasurementLookup,
  type MeasurementLookup,
} from "../import/measurement-lookup.js";
import type { AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError as sendApiError } from "./errors.js";

export interface ImportDeps {
  // fetchPage with the api's database and strategies bound.
  fetchPage: (url: string, opts: FetchPageOptions) => Promise<FetchedPage>;
  // Read on every preview, so a unit added since is matched.
  loadUnits: () => Promise<{ measurements: MeasurementLookup }>;
}

export function importDeps(db: Database["db"]): ImportDeps {
  return {
    fetchPage: (url, opts) =>
      fetchPage(url, { db, strategies: defaultStrategies }, opts),
    loadUnits: async () => ({ measurements: await loadMeasurementLookup(db) }),
  };
}

export type PreviewResponse = {
  sourceUrl: string;
  fetchedAt: string;
  fetchStrategy: FetchedPage["strategy"];
} & ExtractedRecipe;

export type PreviewErrorCode =
  | "invalid_url"
  | "no_recipe_found"
  | "fetch_failed"
  | "import_not_permitted"
  | "internal_error";

export type SaveResponse = Recipe & { alreadyImported: boolean };

// POST /imports/preview { url, refresh? }: the page's recipe as a draft, read
// from its structured data (NATG-245). Nothing is stored as a recipe; the
// fetched page is cached by fetchPage.
//
// POST /imports { sourceUrl, recipe }: saves a reviewed draft as a recipe
// owned by the signed-in user (NATG-250). See saveRoute.
export const importRoutes: FastifyPluginCallback<
  ImportDeps & Pick<AuthDeps, "db">
> = (app, deps, done) => {
  app.register(saveRoute, { db: deps.db });

  // A body Fastify cannot parse as JSON never reaches the handler; answer it
  // in the contract's shape too (NATG-266). Scoped to this plugin.
  app.setErrorHandler<FastifyError>((err, request, reply) => {
    if (
      err.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      err.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      request.log.info({ code: err.code }, "import preview: unparseable body");
      return sendError(reply, 400, "invalid_url", "body must be JSON", "");
    }
    throw err;
  });

  app.post<{ Body: unknown }>(
    "/imports/preview",
    async (request, reply): Promise<PreviewResponse> => {
      const body = isRecord(request.body) ? request.body : {};
      if (typeof body.url !== "string") {
        return sendError(reply, 400, "invalid_url", "url must be a string", "");
      }
      const url = body.url;
      if (body.refresh !== undefined && typeof body.refresh !== "boolean") {
        return sendError(
          reply,
          400,
          "invalid_url",
          "refresh must be a boolean",
          url,
        );
      }

      let page: FetchedPage;
      try {
        page = await deps.fetchPage(url, { refresh: body.refresh === true });
      } catch (err) {
        // The URL is the caller's own input and may carry credentials, so
        // neither it nor the message (which can quote it) is logged.
        if (err instanceof InvalidUrlError) {
          request.log.info("import preview: invalid url");
          return sendError(reply, 400, "invalid_url", err.message, url);
        }
        if (err instanceof NotPermittedError) {
          request.log.warn(
            { url: err.url, strategy: err.strategy },
            "import preview: import not permitted",
          );
          return sendError(
            reply,
            451,
            "import_not_permitted",
            err.message,
            err.url,
          );
        }
        if (err instanceof FetchFailedError) {
          request.log.warn(
            {
              url: err.url,
              reason: err.reason,
              status: err.status,
              attempts: err.attempts,
            },
            "import preview: fetch failed",
          );
          // A private or otherwise refused address, the URL's own or a
          // redirect's (SEC-1). The message is fixed: the attempts name the
          // refused address, which is for the log, not the caller.
          if (err.reason === "blocked_destination") {
            return sendError(
              reply,
              400,
              "invalid_url",
              "destination not allowed",
              err.url,
            );
          }
          return reply.code(422).send({
            error: "fetch_failed",
            message: err.message,
            url: err.url,
            reason: err.reason,
          });
        }
        request.log.error({ err }, "import preview: fetch error");
        return sendError(
          reply,
          500,
          "internal_error",
          "the page could not be fetched",
          url,
        );
      }

      let extracted: ExtractedRecipe | null;
      try {
        const units = await deps.loadUnits();
        extracted = extractRecipe(page.html, {
          sourceHost: new URL(page.finalUrl).hostname,
          ...units,
        });
      } catch (err) {
        // A page past the extraction budget is answered as having no recipe;
        // the log says which limit it hit.
        if (err instanceof BudgetExceededError) {
          request.log.warn(
            {
              url: page.finalUrl,
              strategy: page.strategy,
              cached: page.cached,
              budgetExceeded: err.limit,
            },
            "import preview: extraction budget exceeded",
          );
          return sendError(
            reply,
            404,
            "no_recipe_found",
            "the page has no schema.org Recipe that could be read",
            page.finalUrl,
          );
        }
        request.log.error(
          { err, url: page.finalUrl },
          "import preview: extraction error",
        );
        return sendError(
          reply,
          500,
          "internal_error",
          "the page could not be read",
          page.finalUrl,
        );
      }

      request.log.info(
        {
          url: page.finalUrl,
          strategy: page.strategy,
          cached: page.cached,
          extraction: extracted?.extraction ?? null,
          ingredients: extracted?.recipe.ingredients.length ?? 0,
          warnings: extracted?.warnings ?? [],
        },
        "import preview",
      );
      if (extracted === null) {
        return sendError(
          reply,
          404,
          "no_recipe_found",
          "the page has no schema.org Recipe in JSON-LD or microdata",
          page.finalUrl,
        );
      }
      return {
        sourceUrl: page.finalUrl,
        fetchedAt: page.fetchedAt.toISOString(),
        fetchStrategy: page.strategy,
        ...extracted,
      };
    },
  );
  done();
};

// The preview's draft after review: `recipe` is the preview's DraftRecipe,
// and each ingredient line also carries `ingredientId` and `measurementId`,
// the catalogue rows the cook settled on. `measurementId: null` says the
// line has no unit; a line without the key, or naming a row that does not
// exist, is unresolved. The draft's `unit` and other parse fields are
// ignored. The answer is 201 with the recipe and `alreadyImported`, true
// when the user already has a recipe from the same URL (it is saved anyway).
// A bad line or step is 422 with the offending `positions`; anything else
// wrong with the body is 400. A retry saves a second copy, flagged as
// alreadyImported.
const saveRoute: FastifyPluginCallback<Pick<AuthDeps, "db">> = (
  app,
  { db },
  done,
) => {
  app.setErrorHandler(apiErrorHandler("imports"));

  app.post<{ Body: unknown }>("/imports", async (request, reply) => {
    const userId = request.user!.id;
    const parsed = parseSaveBody(request.body);
    let rejection: Rejection;
    if ("rejection" in parsed) {
      rejection = parsed.rejection;
    } else {
      const result = await createOwnedRecipe(db, request.user!, parsed.recipe);
      if ("recipe" in result) {
        request.log.info(
          {
            userId,
            recipeId: result.recipe.id,
            alreadyImported: result.alreadyImported,
          },
          "import saved",
        );
        const body: SaveResponse = {
          ...result.recipe,
          alreadyImported: result.alreadyImported,
        };
        return reply.code(201).send(body);
      }
      rejection = {
        status: 422,
        error: "unresolved_lines",
        message: "some lines name an ingredient or unit that does not exist",
        positions: result.unresolvedPositions,
      };
    }
    request.log.info(
      {
        userId,
        sourceUrl: parsed.sourceUrl,
        error: rejection.error,
        positions: rejection.positions ?? [],
      },
      "import save: rejected",
    );
    if (rejection.status === 400) {
      return sendApiError(reply, 400, "invalid_request", rejection.message);
    }
    return reply.code(422).send({
      error: rejection.error,
      message: rejection.message,
      positions: rejection.positions,
    });
  });
  done();
};

type Rejection =
  | {
      status: 400;
      error: "invalid_request";
      message: string;
      positions?: undefined;
    }
  | {
      status: 422;
      error: "invalid_lines" | "invalid_steps" | "unresolved_lines";
      message: string;
      positions: number[];
    };

// The largest value an integer column holds.
const MAX_INT = 2_147_483_647;

// Real recipes stay near 60 lines, 40 steps and 20 tags. These caps keep
// each bulk insert well under Postgres's bind-parameter limit (NATG-316).
export const MAX_LINES = 200;
export const MAX_STEPS = 100;
export const MAX_TAGS = 50;
// A tag is in recipe_tag's primary key and an index, whose entries Postgres
// caps at about 2.7 kB (NATG-317). Characters are code points; the byte cap
// bounds the key whatever they are.
export const MAX_TAG_CHARS = 100;
export const MAX_TAG_BYTES = 400;

// Every check the recipe tables' constraints make is made here first, so bad
// input is a 400 or 422 rather than a failed insert. sourceUrl is the
// normalised URL, for the log; null until it is known to be one.
function parseSaveBody(
  body: unknown,
):
  | { sourceUrl: string; recipe: NewRecipe }
  | { sourceUrl: string | null; rejection: Rejection } {
  const invalid = (sourceUrl: string | null, message: string) => ({
    sourceUrl,
    rejection: { status: 400, error: "invalid_request", message } as const,
  });
  if (!isRecord(body)) return invalid(null, "body must be an object");
  if (typeof body.sourceUrl !== "string") {
    return invalid(null, "sourceUrl must be a string");
  }
  let sourceUrl: string;
  try {
    // As fetchPage stores it, so the same page compares equal.
    sourceUrl = normaliseUrl(body.sourceUrl);
  } catch (err) {
    if (!(err instanceof InvalidUrlError)) throw err;
    return invalid(null, "sourceUrl must be an http or https URL");
  }
  const draft = body.recipe;
  if (!isRecord(draft)) return invalid(sourceUrl, "recipe must be an object");
  if (!isText(draft.title) || isBlank(draft.title)) {
    return invalid(
      sourceUrl,
      `recipe.title must be text of 1 to ${MAX_LINE_CHARS} characters`,
    );
  }
  const servings = optionalInt(draft.servings, 1);
  const prepMinutes = optionalInt(draft.prepMinutes, 0);
  const cookMinutes = optionalInt(draft.cookMinutes, 0);
  if (servings === false || prepMinutes === false || cookMinutes === false) {
    return invalid(
      sourceUrl,
      "recipe.servings must be a positive whole number, and the minutes whole numbers, or null",
    );
  }
  const lines = positioned(draft.ingredients, MAX_LINES);
  if (lines === null) {
    return invalid(
      sourceUrl,
      `recipe.ingredients must be a list of at most ${MAX_LINES} lines with distinct whole-number positions`,
    );
  }
  const steps = positioned(draft.steps, MAX_STEPS);
  if (steps === null) {
    return invalid(
      sourceUrl,
      `recipe.steps must be a list of at most ${MAX_STEPS} steps with distinct whole-number positions`,
    );
  }
  const tags = draft.tags ?? [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || !tags.every(isTag)) {
    return invalid(
      sourceUrl,
      `recipe.tags must be a list of at most ${MAX_TAGS} tags of 1 to ${MAX_TAG_CHARS} characters`,
    );
  }

  const reject = (
    error: "invalid_lines" | "invalid_steps" | "unresolved_lines",
    message: string,
    positions: number[],
  ) => ({
    sourceUrl,
    rejection: { status: 422, error, message, positions } as const,
  });
  const badLines = lines
    .filter(
      (l) =>
        quantity(l.quantity) === false ||
        !isOptionalText(l.prepNotes) ||
        !isOptionalText(l.notes),
    )
    .map((l) => l.position);
  if (badLines.length > 0) {
    return reject(
      "invalid_lines",
      `a quantity must be a number above 0, and notes at most ${MAX_LINE_CHARS} characters`,
      badLines,
    );
  }
  const badSteps = steps
    .filter((s) => !isText(s.text) || isBlank(s.text))
    .map((s) => s.position);
  if (badSteps.length > 0) {
    return reject(
      "invalid_steps",
      `a step must be text of 1 to ${MAX_LINE_CHARS} characters`,
      badSteps,
    );
  }
  const unresolved = lines
    .filter(
      (l) =>
        !isId(l.ingredientId) ||
        (l.measurementId !== null && !isId(l.measurementId)),
    )
    .map((l) => l.position);
  if (unresolved.length > 0) {
    return reject(
      "unresolved_lines",
      "every line needs an ingredientId, and a measurementId or null for no unit",
      unresolved,
    );
  }

  return {
    sourceUrl,
    recipe: {
      title: draft.title,
      sourceUrl,
      servings,
      prepMinutes,
      cookMinutes,
      ingredients: lines.map((l): NewRecipeLine => ({
        position: l.position,
        ingredientId: l.ingredientId as number,
        measurementId: l.measurementId as number | null,
        quantity: quantity(l.quantity) as string | null,
        prepNotes: (l.prepNotes ?? null) as string | null,
        notes: (l.notes ?? null) as string | null,
      })),
      steps: steps.map((s) => ({
        position: s.position,
        text: s.text as string,
      })),
      tags,
    },
  };
}

// The entries of a list of at most `max` objects with distinct positions, or
// null.
function positioned(
  value: unknown,
  max: number,
): (Record<string, unknown> & { position: number })[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const seen = new Set<number>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { position } = entry;
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 1 ||
      position > MAX_INT ||
      seen.has(position)
    ) {
      return null;
    }
    seen.add(position);
  }
  return value as (Record<string, unknown> & { position: number })[];
}

// Absent and null are null; false for anything but a whole number in range.
function optionalInt(value: unknown, min: number): number | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= MAX_INT
    ? value
    : false;
}

// A quantity as numeric text, null for none, or false. The draft's quantity is
// text ("0.5"); a JSON number is taken too. Only plain decimals above 0, so
// the insert's quantity check cannot fail; 32 characters is far past any real
// amount.
function quantity(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  return text.length <= 32 &&
    /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) &&
    /[1-9]/.test(text)
    ? text
    : false;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

// Text Postgres will store and no longer than a line may be. Postgres text
// cannot hold NUL.
function isText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_LINE_CHARS &&
    !value.includes("\0")
  );
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || isText(value);
}

// Blank as the tables' not-blank checks see it.
function isBlank(text: string): boolean {
  return text.replace(/\s+/g, " ").trim() === "";
}

function isTag(value: unknown): value is string {
  return (
    isText(value) &&
    !isBlank(value) &&
    [...value].length <= MAX_TAG_CHARS &&
    Buffer.byteLength(value, "utf8") <= MAX_TAG_BYTES
  );
}

function sendError(
  reply: FastifyReply,
  status: number,
  error: PreviewErrorCode,
  message: string,
  url: string,
) {
  return reply.code(status).send({ error, message, url });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
