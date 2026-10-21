import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { canonicalLocale } from "../auth/credentials.js";
import {
  addIngredientName,
  changeIngredientName,
  createIngredient,
  deleteIngredient,
  deleteIngredientName,
  findIngredient,
  listIngredients,
  MAX_NAMES,
  PAGE_SIZE,
  searchIngredients,
  setIngredientCategory,
  type EditRefusal,
  type ListQuery,
  type NameChange,
  type NewIngredient,
  type TakenName,
} from "../db/ingredients.js";
import { isRecord, requestActor, type AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

// In code points, like the recipe tag cap: at most 400 UTF-8 bytes, far
// under the ~2.7 kB btree entry limit on ingredient_name's (locale,
// normalised_name) key.
export const MAX_NAME_CHARS = 100;
export const MAX_CATEGORY_CHARS = 100;

// An ingredient or name id from the path, or null for anything that cannot
// be one.
function parseIngredientId(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function notFound(reply: FastifyReply) {
  return sendError(reply, 404, "not_found", "ingredient not found");
}

function nameNotFound(reply: FastifyReply) {
  return sendError(reply, 404, "not_found", "name not found");
}

// The same answers requireUser and a get would give now.
function refused(reply: FastifyReply, { refused }: EditRefusal) {
  switch (refused) {
    case "unauthenticated":
      return sendError(reply, 401, "unauthenticated", "sign in required");
    case "not_found":
      return notFound(reply);
    case "forbidden":
      return sendError(
        reply,
        403,
        "forbidden",
        "only the ingredient's creator or an admin can change it",
      );
  }
}

// 409 for a name already in the catalogue in its locale, with the ingredient
// that has it, so the UI can point at it. Null when the name that clashed
// cannot be found: deleted since, or stored differently from how the lookup
// compares it. Still a clash.
function nameTaken(
  request: FastifyRequest,
  reply: FastifyReply,
  taken: TakenName | null,
  action: string,
) {
  const userId = request.user!.id;
  if (taken === null) {
    request.log.warn({ userId }, `${action}: name taken, owner not found`);
    return sendError(
      reply,
      409,
      "name_taken",
      "a name is already in the catalogue",
    );
  }
  const { ingredient, name } = taken;
  request.log.info(
    { userId, ingredientId: ingredient.id },
    `${action}: name taken`,
  );
  return reply.code(409).send({
    error: "name_taken",
    message: `${name.locale} already has the name "${name.name}"`,
    ingredient,
    name,
  });
}

// Text Postgres can store and a person can read: well-formed Unicode (a
// lone surrogate would be stored as U+FFFD, NATG-350), no NUL, not only
// whitespace, at most `max` code points.
function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    !value.includes("\0") &&
    value.trim() !== "" &&
    [...value].length <= max
  );
}

type Parsed<T> = { ok: T } | { invalid: string };

export function parseListQuery(
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
    const name = parseName(entry, defaultLocale);
    if ("invalid" in name) return name;
    parsed.push(name.ok);
  }
  const parsedCategory = parseCategory(category);
  if ("invalid" in parsedCategory) return parsedCategory;
  return { ok: { names: parsed, category: parsedCategory.ok } };
}

// { name, locale? }, in a create's names or added on its own.
function parseName(
  entry: unknown,
  defaultLocale: string,
): Parsed<NewIngredient["names"][number]> {
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
  // The profile locale is checked as a sent one is: one stored before
  // the length cap could be over it.
  const locale =
    entry.locale === undefined
      ? canonicalLocale(defaultLocale)
      : typeof entry.locale === "string"
        ? canonicalLocale(entry.locale)
        : null;
  if (locale === null) {
    return {
      invalid:
        entry.locale === undefined
          ? "your profile locale is not a usable BCP-47 language tag: send a locale with each name, or change it"
          : "locale must be a BCP-47 language tag",
    };
  }
  return { ok: { name: entry.name.trim(), locale } };
}

function parseCategory(category: unknown): Parsed<string | null> {
  if (category !== null && !isText(category, MAX_CATEGORY_CHARS)) {
    return {
      invalid: `category must be null or text of 1 to ${MAX_CATEGORY_CHARS} characters`,
    };
  }
  return { ok: category === null ? null : category.trim() };
}

// { category }, null to clear it.
function parseCategoryBody(body: unknown): Parsed<string | null> {
  if (
    !isRecord(body) ||
    !("category" in body) ||
    Object.keys(body).length !== 1
  ) {
    return { invalid: "body must be { category }" };
  }
  return parseCategory(body.category);
}

// { name?, isCanonical? }, at least one. isCanonical can only be true: a
// name stops being canonical when another is made canonical.
function parseNameChange(body: unknown): Parsed<NameChange> {
  if (
    !isRecord(body) ||
    Object.keys(body).length === 0 ||
    Object.keys(body).some((key) => key !== "name" && key !== "isCanonical")
  ) {
    return { invalid: "body must be { name?, isCanonical? }, at least one" };
  }
  const change: NameChange = {};
  if (body.name !== undefined) {
    if (!isText(body.name, MAX_NAME_CHARS)) {
      return {
        invalid: `a name must be text of 1 to ${MAX_NAME_CHARS} characters`,
      };
    }
    change.name = body.name.trim();
  }
  if (body.isCanonical !== undefined) {
    if (body.isCanonical !== true) {
      return {
        invalid:
          "isCanonical can only be true: make another name canonical instead",
      };
    }
    change.isCanonical = true;
  }
  return { ok: change };
}

// GET /ingredients, GET /ingredients/:id and POST /ingredients: the shared
// catalogue (NATG-210). Registered behind requireUser, so request.user is
// always set here. Every signed-in user sees every ingredient; canEdit on
// each says whether this user may change it. The PATCH, POST and DELETE
// routes under /ingredients/:id change one (NATG-343): the same rule, so a
// user canEdit is false for gets 403.
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
  // If that ingredient cannot be found, still 409, without it.
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
      return nameTaken(request, reply, outcome.taken, "ingredient create");
    }
    request.log.info(
      { userId: user.id, ingredientId: outcome.created.id },
      "ingredient created",
    );
    return reply.code(201).send(outcome.created);
  });

  // The ingredient's category, null to clear it. 200 with the ingredient.
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/ingredients/:id",
    async (request, reply) => {
      const user = request.user!;
      const id = parseIngredientId(request.params.id);
      if (id === null) return notFound(reply);
      const parsed = parseCategoryBody(request.body);
      if ("invalid" in parsed) {
        return sendError(reply, 400, "invalid_request", parsed.invalid);
      }
      const outcome = await setIngredientCategory(
        db,
        requestActor(request),
        id,
        parsed.ok,
      );
      if ("refused" in outcome) return refused(reply, outcome);
      request.log.info(
        { userId: user.id, ingredientId: id },
        "ingredient category changed",
      );
      return outcome.changed;
    },
  );

  // Deletes the ingredient and its names. 204, or 409 if a recipe uses it.
  // A retry after a successful delete gets 404.
  app.delete<{ Params: { id: string } }>(
    "/ingredients/:id",
    async (request, reply) => {
      const user = request.user!;
      const id = parseIngredientId(request.params.id);
      if (id === null) return notFound(reply);
      const outcome = await deleteIngredient(db, requestActor(request), id);
      if ("refused" in outcome) return refused(reply, outcome);
      if ("inUse" in outcome) {
        return sendError(
          reply,
          409,
          "in_use",
          "a recipe uses this ingredient, so it cannot be deleted",
        );
      }
      request.log.info(
        { userId: user.id, ingredientId: id },
        "ingredient deleted",
      );
      return reply.code(204).send();
    },
  );

  // { name, locale? }: a name, by the create rules. 201 with the ingredient.
  // A retry of an add that succeeded gets 409 naming this ingredient. 409
  // name_limit when the ingredient has MAX_NAMES already.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/ingredients/:id/names",
    async (request, reply) => {
      const user = request.user!;
      const id = parseIngredientId(request.params.id);
      if (id === null) return notFound(reply);
      const parsed = parseName(request.body, user.locale);
      if ("invalid" in parsed) {
        return sendError(reply, 400, "invalid_request", parsed.invalid);
      }
      const outcome = await addIngredientName(
        db,
        requestActor(request),
        id,
        parsed.ok,
      );
      if ("refused" in outcome) return refused(reply, outcome);
      if ("taken" in outcome) {
        return nameTaken(request, reply, outcome.taken, "ingredient add name");
      }
      if ("nameLimit" in outcome) {
        return sendError(
          reply,
          409,
          "name_limit",
          `an ingredient can have at most ${MAX_NAMES} names: delete one first`,
        );
      }
      request.log.info(
        { userId: user.id, ingredientId: id },
        "ingredient name added",
      );
      return reply.code(201).send(outcome.changed);
    },
  );

  // { name?, isCanonical: true? }: renames the name, makes it the canonical
  // name in its locale, or both. 200 with the ingredient.
  app.patch<{ Params: { id: string; nameId: string }; Body: unknown }>(
    "/ingredients/:id/names/:nameId",
    async (request, reply) => {
      const user = request.user!;
      const id = parseIngredientId(request.params.id);
      if (id === null) return notFound(reply);
      const nameId = parseIngredientId(request.params.nameId);
      if (nameId === null) return nameNotFound(reply);
      const parsed = parseNameChange(request.body);
      if ("invalid" in parsed) {
        return sendError(reply, 400, "invalid_request", parsed.invalid);
      }
      const outcome = await changeIngredientName(
        db,
        requestActor(request),
        id,
        nameId,
        parsed.ok,
      );
      if ("refused" in outcome) return refused(reply, outcome);
      if ("nameNotFound" in outcome) return nameNotFound(reply);
      if ("taken" in outcome) {
        return nameTaken(
          request,
          reply,
          outcome.taken,
          "ingredient change name",
        );
      }
      request.log.info(
        { userId: user.id, ingredientId: id, nameId },
        "ingredient name changed",
      );
      return outcome.changed;
    },
  );

  // 204, or 409 for the ingredient's last name. Deleting the canonical name
  // makes another in its locale canonical, if there is one. A retry after a
  // successful delete gets 404.
  app.delete<{ Params: { id: string; nameId: string } }>(
    "/ingredients/:id/names/:nameId",
    async (request, reply) => {
      const user = request.user!;
      const id = parseIngredientId(request.params.id);
      if (id === null) return notFound(reply);
      const nameId = parseIngredientId(request.params.nameId);
      if (nameId === null) return nameNotFound(reply);
      const outcome = await deleteIngredientName(
        db,
        requestActor(request),
        id,
        nameId,
      );
      if ("refused" in outcome) return refused(reply, outcome);
      if ("nameNotFound" in outcome) return nameNotFound(reply);
      if ("lastName" in outcome) {
        return sendError(
          reply,
          409,
          "last_name",
          "an ingredient's last name cannot be deleted: delete the ingredient instead",
        );
      }
      request.log.info(
        { userId: user.id, ingredientId: id, nameId },
        "ingredient name deleted",
      );
      return reply.code(204).send();
    },
  );

  done();
};
