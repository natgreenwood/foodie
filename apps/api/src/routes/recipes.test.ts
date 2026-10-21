import { eq } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { describe, expect, onTestFinished } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/accounts.js";
import {
  ingredient,
  ingredientName,
  measurement,
  recipe,
  recipeIngredient,
  recipeStep,
  recipeTag,
  user,
} from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { SESSION_COOKIE } from "./auth.js";

const unused = () => Promise.reject(new Error("not used by these tests"));

function start(tx: TestTransaction) {
  const app = buildApp({
    pingDatabase: () => Promise.resolve(),
    fetchPage: unused,
    loadUnits: unused,
    matchIngredients: unused,
    db: tx,
    secureCookies: true,
    settingsKey: Buffer.alloc(32),
  });
  onTestFinished(() => app.close());

  const request = (
    method: "GET" | "DELETE",
    url: string,
    token?: string,
  ): Promise<Response> =>
    app.inject({
      method,
      url,
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });
  return { request };
}

// A user with a signed-in session, and the session's token.
async function signedInUser(
  tx: TestTransaction,
  { locale = "en-GB" } = {},
): Promise<{ id: number; token: string }> {
  const [row] = await tx
    .insert(user)
    .values({
      email: `cook-${crypto.randomUUID()}@recipe-routes.test`,
      locale,
    })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  const { token } = await createSession(tx, row.id);
  return { id: row.id, token };
}

async function newRecipe(
  tx: TestTransaction,
  ownerId: number,
  title = "Shakshuka",
): Promise<number> {
  const [row] = await tx
    .insert(recipe)
    .values({ ownerId, title, servings: 4 })
    .returning({ id: recipe.id });
  if (!row) throw new Error("recipe insert returned no row");
  return row.id;
}

// A catalogue ingredient with these names, each canonical in its locale.
async function newIngredient(
  tx: TestTransaction,
  names: { name: string; locale: string }[],
): Promise<number> {
  const [row] = await tx
    .insert(ingredient)
    .values({ source: "seed" })
    .returning({ id: ingredient.id });
  if (!row) throw new Error("ingredient insert returned no row");
  if (names.length > 0) {
    await tx
      .insert(ingredientName)
      .values(
        names.map((n) => ({ ...n, ingredientId: row.id, isCanonical: true })),
      );
  }
  return row.id;
}

async function newMeasurement(tx: TestTransaction): Promise<number> {
  const [row] = await tx
    .insert(measurement)
    .values({ type: "mass", factorToBase: "1" })
    .returning({ id: measurement.id });
  if (!row) throw new Error("measurement insert returned no row");
  return row.id;
}

const notFound = { error: "not_found", message: "recipe not found" };

describe("GET /recipes", () => {
  dbTest("lists only the caller's recipes", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const other = await signedInUser(tx);
    const mine = await newRecipe(tx, me.id, "Dal");
    await newRecipe(tx, other.id, "Not mine");

    const res = await request("GET", "/recipes", me.token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      recipes: [
        {
          id: mine,
          title: "Dal",
          sourceUrl: null,
          servings: 4,
          prepMinutes: null,
          cookMinutes: null,
          createdAt: expect.any(String) as string,
          updatedAt: expect.any(String) as string,
        },
      ],
    });
  });

  dbTest("leaves out lines, steps and tags", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newRecipe(tx, me.id);
    const salt = await newIngredient(tx, [{ name: "salt", locale: "en-GB" }]);
    await tx
      .insert(recipeIngredient)
      .values({ recipeId: id, position: 1, ingredientId: salt });
    await tx
      .insert(recipeStep)
      .values({ recipeId: id, position: 1, text: "Season." });
    await tx.insert(recipeTag).values({ recipeId: id, tag: "quick" });

    const res = await request("GET", "/recipes", me.token);

    expect(res.statusCode).toBe(200);
    const [item] = res.json<{ recipes: object[] }>().recipes;
    expect(item).toMatchObject({ id });
    expect(item).not.toHaveProperty("ingredients");
    expect(item).not.toHaveProperty("steps");
    expect(item).not.toHaveProperty("tags");
  });

  dbTest("returns an empty list to a user with none", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    await newRecipe(tx, (await signedInUser(tx)).id);

    const res = await request("GET", "/recipes", me.token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recipes: [] });
  });
});

describe("GET /recipes/:id", () => {
  dbTest(
    "returns the caller's recipe, with empty lists when it has none",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newRecipe(tx, me.id);

      const res = await request("GET", `/recipes/${id}`, me.token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id,
        title: "Shakshuka",
        sourceUrl: null,
        servings: 4,
        prepMinutes: null,
        cookMinutes: null,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
        ingredients: [],
        steps: [],
        tags: [],
      });
    },
  );

  dbTest(
    "returns lines by position, named in the caller's locale or the closest",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx, { locale: "en-US" });
      const id = await newRecipe(tx, me.id);
      const coriander = await newIngredient(tx, [
        { name: "Coriander", locale: "en-GB" },
        { name: "cilantro", locale: "en-US" },
      ]);
      // No en-US name: the en-GB one, not the German.
      const aubergine = await newIngredient(tx, [
        { name: "Aubergine", locale: "de" },
        { name: "aubergine", locale: "en-GB" },
      ]);
      const nameless = await newIngredient(tx, []);
      const gram = await newMeasurement(tx);
      // Inserted out of order, to show the order comes from position.
      await tx.insert(recipeIngredient).values([
        {
          recipeId: id,
          position: 3,
          ingredientId: nameless,
          measurementId: null,
          quantity: "2",
        },
        {
          recipeId: id,
          position: 1,
          ingredientId: aubergine,
          measurementId: gram,
          quantity: "1.5",
          prepNotes: "diced",
          notes: "or courgette",
        },
        {
          recipeId: id,
          position: 2,
          ingredientId: coriander,
          measurementId: gram,
          quantity: "10",
        },
      ]);

      const res = await request("GET", `/recipes/${id}`, me.token);

      expect(res.statusCode).toBe(200);
      expect(res.json<{ ingredients: unknown }>().ingredients).toEqual([
        {
          position: 1,
          ingredient: { id: aubergine, name: "aubergine", locale: "en-GB" },
          measurementId: gram,
          quantity: "1.5",
          prepNotes: "diced",
          notes: "or courgette",
        },
        {
          position: 2,
          ingredient: { id: coriander, name: "cilantro", locale: "en-US" },
          measurementId: gram,
          quantity: "10",
          prepNotes: null,
          notes: null,
        },
        {
          position: 3,
          ingredient: { id: nameless, name: null, locale: null },
          measurementId: null,
          quantity: "2",
          prepNotes: null,
          notes: null,
        },
      ]);
    },
  );

  dbTest("returns a line with no unit and no quantity", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newRecipe(tx, me.id);
    const salt = await newIngredient(tx, [{ name: "salt", locale: "en-GB" }]);
    await tx.insert(recipeIngredient).values({
      recipeId: id,
      position: 1,
      ingredientId: salt,
      notes: "to taste",
    });

    const res = await request("GET", `/recipes/${id}`, me.token);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ ingredients: unknown }>().ingredients).toEqual([
      {
        position: 1,
        ingredient: { id: salt, name: "salt", locale: "en-GB" },
        measurementId: null,
        quantity: null,
        prepNotes: null,
        notes: "to taste",
      },
    ]);
  });

  dbTest(
    "returns steps by position and tags as entered, by normalised tag",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newRecipe(tx, me.id);
      await tx.insert(recipeStep).values([
        { recipeId: id, position: 2, text: "Crack in the eggs." },
        { recipeId: id, position: 1, text: "Simmer the tomatoes." },
      ]);
      await tx.insert(recipeTag).values([
        { recipeId: id, tag: "Vegetarian" },
        { recipeId: id, tag: "brunch" },
        { recipeId: id, tag: " One-Pan" },
      ]);

      const res = await request("GET", `/recipes/${id}`, me.token);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        steps: [
          { position: 1, text: "Simmer the tomatoes." },
          { position: 2, text: "Crack in the eggs." },
        ],
        tags: ["brunch", " One-Pan", "Vegetarian"],
      });
    },
  );

  dbTest("returns 404 for another user's recipe", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newRecipe(tx, (await signedInUser(tx)).id);
    await tx
      .insert(recipeStep)
      .values({ recipeId: id, position: 1, text: "Stir." });

    const res = await request("GET", `/recipes/${id}`, me.token);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(notFound);
  });

  dbTest.for(["abc", "0", "-1", "1.5", "99999999999999999999"])(
    "returns 404 for the id %s",
    async (id, { tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);

      const res = await request("GET", `/recipes/${id}`, me.token);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(notFound);
    },
  );
});

describe("DELETE /recipes/:id", () => {
  dbTest("deletes the caller's recipe, then 404s a retry", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newRecipe(tx, me.id);

    const res = await request("DELETE", `/recipes/${id}`, me.token);

    expect(res.statusCode).toBe(204);
    expect(await tx.select().from(recipe).where(eq(recipe.id, id))).toEqual([]);
    expect(
      (await request("DELETE", `/recipes/${id}`, me.token)).statusCode,
    ).toBe(404);
  });

  dbTest(
    "returns 404 for another user's recipe and keeps it",
    async ({ tx }) => {
      const { request } = start(tx);
      const me = await signedInUser(tx);
      const id = await newRecipe(tx, (await signedInUser(tx)).id);

      const res = await request("DELETE", `/recipes/${id}`, me.token);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(notFound);
      expect(
        await tx
          .select({ id: recipe.id })
          .from(recipe)
          .where(eq(recipe.id, id)),
      ).toEqual([{ id }]);
    },
  );
});

describe("without a session", () => {
  dbTest.for<["GET" | "DELETE", string]>([
    ["GET", "/recipes"],
    ["GET", "/recipes/1"],
    ["DELETE", "/recipes/1"],
  ])("%s %s returns 401", async ([method, url], { tx }) => {
    const { request } = start(tx);

    const res = await request(method, url);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthenticated",
      message: "sign in required",
    });
  });

  dbTest("an unknown session token cannot delete", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newRecipe(tx, me.id);

    const res = await request("DELETE", `/recipes/${id}`, "not-a-session");

    expect(res.statusCode).toBe(401);
    expect(
      await tx.select({ id: recipe.id }).from(recipe).where(eq(recipe.id, id)),
    ).toEqual([{ id }]);
  });
});
