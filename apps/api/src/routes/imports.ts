import type {
  FastifyError,
  FastifyPluginCallback,
  FastifyReply,
} from "fastify";
import type { Database } from "../db/client.js";
import { BudgetExceededError } from "../import/extract/budget.js";
import {
  extractRecipe,
  type ExtractedRecipe,
} from "../import/extract/extract.js";
import {
  defaultStrategies,
  FetchFailedError,
  fetchPage,
  InvalidUrlError,
  NotPermittedError,
  type FetchedPage,
  type FetchPageOptions,
} from "../import/fetch.js";
import {
  loadMeasurementLookup,
  type MeasurementLookup,
} from "../import/measurement-lookup.js";
import { loadUnitKeys } from "../import/unit-keys.js";

export interface ImportDeps {
  // fetchPage with the api's database and strategies bound.
  fetchPage: (url: string, opts: FetchPageOptions) => Promise<FetchedPage>;
  // Read on every preview, so a unit added since is matched.
  loadUnits: () => Promise<{
    measurements: MeasurementLookup;
    unitKeys: ReadonlyMap<number, string>;
  }>;
}

export function importDeps(db: Database["db"]): ImportDeps {
  return {
    fetchPage: (url, opts) =>
      fetchPage(url, { db, strategies: defaultStrategies }, opts),
    loadUnits: async () => {
      const [measurements, unitKeys] = await Promise.all([
        loadMeasurementLookup(db),
        loadUnitKeys(db),
      ]);
      return { measurements, unitKeys };
    },
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

// POST /imports/preview { url, refresh? }: the page's recipe as a draft, read
// from its structured data (NATG-245). Nothing is stored as a recipe; the
// fetched page is cached by fetchPage.
export const importRoutes: FastifyPluginCallback<ImportDeps> = (
  app,
  deps,
  done,
) => {
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
