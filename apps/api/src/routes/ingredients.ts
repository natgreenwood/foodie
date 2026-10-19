import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { canonicalLocale } from "../auth/credentials.js";
import {
  createIngredient,
  findIngredient,
  listIngredients,
  PAGE_SIZE,
  searchIngredients,
  type ListQuery,
  type NewIngredient,
} from "../db/ingredients.js";
import { isRecord, type AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

// Real ingredients have a handful of names. In code points, like the recipe
// tag cap: at most 400 UTF-8 bytes, far under the ~2.7 kB btree entry limit
// on ingredient_name's (locale, normalised_name) key.
export const MAX_NAMES = 20;
export const MAX_NAME_CHARS = 100;
export const MAX_CATEGORY_CHARS = 100;

// An ingredient id from the path, or null for anything that cannot be one.
function parseIngredientId(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function notFound(reply: FastifyReply) {
  return sendError(reply, 404, "not_found", "ingredient not found");
}

// Text Postgres can store and a person can read: no NUL, not only
// whitespace, at most `max` code points.
function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    value.trim() !== "" &&
    [...value].length <= max
  );
}

type Parsed<T> = { ok: T } | { invalid: string };

function parseListQuery(
  query: Record<string, unknown>,
): Parsed<ListQuery & { q: string }> {
  const { q = "", page = "1", userAdded = "false" } = query;
  // Blank is allowed (it lists); anything else is checked as a name is.
  if (
    typeof q !== "string" ||
    (q.trim() !== "" && !isText(q, MAX_NAME_CHARS))
  ) {
    return {
      invalid: `q must be text of at most ${MAX_NAME_CHARS} characters, without NUL`,
    };
  }
  const pageNumber =
    typeof page === "string" && /^[1-9][0-9]*$/.test(page)
      ? Number(page)
      : null;
  if (
    pageNumber === null ||
    !Number.isSafeInteger((pageNumber - 1) * PAGE_SIZE)
  ) {
    return { invalid: "page must be a whole number from 1" };
  }
  if (userAdded !== "true" && userAdded !== "false") {
    return { invalid: "userAdded must be true or false" };
  }
  return {
    ok: { q: q.trim(), page: pageNumber, userAdded: userAdded === "true" },
  };
}

// { names: [{ name, locale? }, ...], category? }. A name's locale defaults
// to the caller's and is stored in its canonical form.
function parseCreateBody(
  body: unknown,
  defaultLocale: string,
): Parsed<NewIngredient> {
  if (!isRecord(body)) return { invalid: "body must be an object" };
  const unknown = Object.keys(body).filter(
    (key) => key !== "names" && key !== "category",
  );
  if (unknown.length > 0) {
    return { invalid: `unknown field: ${unknown.join(", ")}` };
  }
  const { names, category = null } = body;
  if (!Array.isArray(names) || names.length === 0) {
    return { invalid: "names must be a list of at least one name" };
  }
  if (names.length > MAX_NAMES) {
    return { invalid: `names must list at most ${MAX_NAMES} names` };
  }
  const parsed: NewIngredient["names"] = [];
  for (const entry of names as unknown[]) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => key !== "name" && key !== "locale")
    ) {
      return { invalid: "each name must be { name, locale? }" };
    }
    if (!isText(entry.name, MAX_NAME_CHARS)) {
      return {
        invalid: `a name must be text of 1 to ${MAX_NAME_CHARS} characters`,
      };
    }
    const locale =
      entry.locale === undefined
        ? defaultLocale
        : typeof entry.locale === "string"
          ? canonicalLocale(entry.locale)
          : null;
    if (locale === null) {
      return { invalid: "locale must be a BCP-47 language tag" };
    }
    parsed.push({ name: entry.name.trim(), locale });
  }
  if (category !== null && !isText(category, MAX_CATEGORY_CHARS)) {
    return {
      invalid: `category must be null or text of 1 to ${MAX_CATEGORY_CHARS} characters`,
    };
  }
  return {
    ok: {
      names: parsed,
      category: category === null ? null : category.trim(),
    },
  };
}

// GET /ingredients, GET /ingredients/:id and POST /ingredients: the shared
// catalogue (NATG-210). Registered behind requireUser, so request.user is
// always set here. Every signed-in user sees every ingredient; canEdit on
// each says whether this user may change it. Editing and deleting are
// NATG-343.
export const ingredientRoutes: FastifyPluginCallback<AuthDeps> = (
  app,
  { db },
  done,
) => {
  app.setErrorHandler(apiErrorHandler("ingredients"));

  // ?q= searches every name in every locale; without it, lists by name.
  // ?page= from 1, PAGE_SIZE a page. ?userAdded=true keeps only ingredients
  // users created.
  app.get<{ Querystring: Record<string, unknown> }>(
    "/ingredients",
    async (request, reply) => {
      const parsed = parseListQuery(request.query);
      if ("invalid" in parsed) {
        return sendError(reply, 400, "invalid_request", parsed.invalid);
      }
      const { q, ...query } = parsed.ok;
      return q === ""
        ? listIngredients(db, request.user!, query)
        : searchIngredients(db, request.user!, q, query);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/ingredients/:id",
    async (request, reply) => {
      const id = parseIngredientId(request.params.id);
      const found =
        id === null ? null : await findIngredient(db, request.user!, id);
      if (!found) return notFound(reply);
      return found;
    },
  );

  // 201 with the ingredient as GET /ingredients/:id returns it. A name
  // already in the catalogue in its locale is 409 with the ingredient that
  // has it, so a retry of a create that succeeded gets 409 naming the
  // ingredient it created.
  app.post<{ Body: unknown }>("/ingredients", async (request, reply) => {
    const user = request.user!;
    const parsed = parseCreateBody(request.body, user.locale);
    if ("invalid" in parsed) {
      return sendError(reply, 400, "invalid_request", parsed.invalid);
    }
    const outcome = await createIngredient(db, user, parsed.ok);
    if ("repeated" in outcome) {
      return sendError(
        reply,
        400,
        "invalid_request",
        "names must not repeat a name in the same locale",
      );
    }
    if ("taken" in outcome) {
      const { ingredient, name } = outcome.taken;
      request.log.info(
        { userId: user.id, ingredientId: ingredient.id },
        "ingredient create: name taken",
      );
      return reply.code(409).send({
        error: "name_taken",
        message: `${name.locale} already has the name "${name.name}"`,
        ingredient,
        name,
      });
    }
    request.log.info(
      { userId: user.id, ingredientId: outcome.created.id },
      "ingredient created",
    );
    return reply.code(201).send(outcome.created);
  });

  done();
};
