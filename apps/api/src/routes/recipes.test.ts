import { eq } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { describe, expect, onTestFinished } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/accounts.js";
import { recipe, user } from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { SESSION_COOKIE } from "./auth.js";

const unused = () => Promise.reject(new Error("not used by these tests"));

function start(tx: TestTransaction) {
  const app = buildApp({
    pingDatabase: () => Promise.resolve(),
    fetchPage: unused,
    loadUnits: unused,
    db: tx,
    secureCookies: true,
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
): Promise<{ id: number; token: string }> {
  const [row] = await tx
    .insert(user)
    .values({ email: `cook-${crypto.randomUUID()}@recipe-routes.test` })
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
  dbTest("returns the caller's recipe", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newRecipe(tx, me.id);

    const res = await request("GET", `/recipes/${id}`, me.token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, title: "Shakshuka" });
    expect(res.json()).not.toHaveProperty("ownerId");
  });

  dbTest("returns 404 for another user's recipe", async ({ tx }) => {
    const { request } = start(tx);
    const me = await signedInUser(tx);
    const id = await newRecipe(tx, (await signedInUser(tx)).id);

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
