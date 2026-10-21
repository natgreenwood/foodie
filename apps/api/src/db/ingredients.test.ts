import { asc, eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import {
  createSession,
  sessionId,
  type Actor,
  type Profile,
} from "../auth/accounts.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  addIngredientName,
  changeIngredientName,
  createIngredient,
  deleteIngredient,
  deleteIngredientName,
  setIngredientCategory,
} from "./ingredients.js";
import { ingredient, ingredientName, session, user } from "./schema.js";

async function creator(tx: TestTransaction): Promise<Profile> {
  const [row] = await tx
    .insert(user)
    .values({ email: `cook-${crypto.randomUUID()}@ingredients.test` })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  return {
    id: row.id,
    email: "",
    displayName: null,
    locale: "en-GB",
    isAdmin: false,
  };
}

// The route refuses text that is not well-formed Unicode (NATG-350); these
// call createIngredient directly, so a clash it was not meant to see still
// gets an answer rather than a failed query.
describe("createIngredient", () => {
  dbTest(
    "finds the owner of a clash the same way the insert stored the name",
    async ({ tx }) => {
      const me = await creator(tx);
      // pg sends a lone surrogate as U+FFFD, so this is stored as "x-�".
      const input = {
        names: [{ name: "x-\ud800", locale: "en" }],
        category: null,
      };

      const first = await createIngredient(tx, me, input);
      const retry = await createIngredient(tx, me, input);

      if (!("created" in first)) throw new Error("first create failed");
      expect(retry).toEqual({
        taken: {
          ingredient: { id: first.created.id, name: "x-�" },
          name: { name: "x-�", locale: "en" },
        },
      });
    },
  );

  dbTest(
    "says two names repeat when they are one name once stored",
    async ({ tx }) => {
      const me = await creator(tx);

      const outcome = await createIngredient(tx, me, {
        names: [
          { name: "y-\ud800", locale: "en" },
          { name: "y-\ud801", locale: "en" },
        ],
        category: null,
      });

      expect(outcome).toEqual({ repeated: true });
    },
  );
});

// A signed-in user as the actor of a change.
async function actor(
  tx: TestTransaction,
  { isAdmin = false } = {},
): Promise<Actor> {
  const [row] = await tx
    .insert(user)
    .values({ email: `cook-${crypto.randomUUID()}@ingredients.test`, isAdmin })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  const { token } = await createSession(tx, row.id);
  return { userId: row.id, sessionId: sessionId(token) };
}

// An ingredient named `${tag}` and `${tag} seeds` in en-GB, and its name ids.
async function twoNames(
  tx: TestTransaction,
  tag: string,
  createdBy: number | null,
): Promise<{ id: number; first: number; second: number }> {
  const [row] = await tx
    .insert(ingredient)
    .values({ createdBy, source: createdBy ? "user" : "seed" })
    .returning({ id: ingredient.id });
  if (!row) throw new Error("ingredient insert returned no row");
  const [first, second] = await tx
    .insert(ingredientName)
    .values([
      { ingredientId: row.id, name: tag, locale: "en-GB", isCanonical: true },
      { ingredientId: row.id, name: `${tag} seeds`, locale: "en-GB" },
    ])
    .returning({ id: ingredientName.id });
  if (!first || !second) throw new Error("name insert returned no rows");
  return { id: row.id, first: first.id, second: second.id };
}

async function stored(tx: TestTransaction, id: number) {
  return {
    ingredient: await tx.select().from(ingredient).where(eq(ingredient.id, id)),
    names: await tx
      .select()
      .from(ingredientName)
      .where(eq(ingredientName.ingredientId, id))
      .orderBy(asc(ingredientName.id)),
  };
}

// Every write, by the actor `who`, to `target`.
const writes = [
  [
    "setIngredientCategory",
    (tx: TestTransaction, who: Actor, t: { id: number }) =>
      setIngredientCategory(tx, who, t.id, "spices"),
  ],
  [
    "addIngredientName",
    (tx: TestTransaction, who: Actor, t: { id: number }) =>
      addIngredientName(tx, who, t.id, {
        name: `powder ${t.id}`,
        locale: "en-GB",
      }),
  ],
  [
    "changeIngredientName",
    (tx: TestTransaction, who: Actor, t: { id: number; second: number }) =>
      changeIngredientName(tx, who, t.id, t.second, { isCanonical: true }),
  ],
  [
    "deleteIngredientName",
    (tx: TestTransaction, who: Actor, t: { id: number; second: number }) =>
      deleteIngredientName(tx, who, t.id, t.second),
  ],
  [
    "deleteIngredient",
    (tx: TestTransaction, who: Actor, t: { id: number }) =>
      deleteIngredient(tx, who, t.id),
  ],
] as const;

// What happens to an admin between requireUser letting the request in and
// the write running (SEC-1), and how the write is then refused.
const revocations = [
  [
    "demoted",
    (tx: TestTransaction, id: number) =>
      tx.update(user).set({ isAdmin: false }).where(eq(user.id, id)),
    "forbidden",
  ],
  [
    "disabled, session kept",
    (tx: TestTransaction, id: number) =>
      tx.update(user).set({ disabledAt: new Date() }).where(eq(user.id, id)),
    "unauthenticated",
  ],
  [
    "signed out",
    (tx: TestTransaction, id: number) =>
      tx.delete(session).where(eq(session.userId, id)),
    "unauthenticated",
  ],
] as const;

describe("changes to an ingredient re-check the actor (SEC-1)", () => {
  dbTest.for(
    writes.flatMap(([name, write]) =>
      revocations.map(
        ([what, revoke, refusal]) =>
          [name, what, write, revoke, refusal] as const,
      ),
    ),
  )(
    "%s refuses an admin %s since the request arrived, changing nothing",
    async ([, , write, revoke, refusal], { tx }) => {
      const admin = await actor(tx, { isAdmin: true });
      const target = await twoNames(tx, `mace ${admin.userId}`, null);
      const before = await stored(tx, target.id);

      await revoke(tx, admin.userId);
      const outcome = await write(tx, admin, target);

      expect(outcome).toEqual({ refused: refusal });
      expect(await stored(tx, target.id)).toEqual(before);
    },
  );

  dbTest.for(writes)(
    "%s lets a creator who has never been an admin change their own",
    async ([, write], { tx }) => {
      const creator = await actor(tx);
      const target = await twoNames(
        tx,
        `mace ${creator.userId}`,
        creator.userId,
      );

      const outcome = await write(tx, creator, target);

      expect(outcome).not.toHaveProperty("refused");
    },
  );

  dbTest(
    "reads the role as committed now: an admin granted since is allowed",
    async ({ tx }) => {
      const promoted = await actor(tx);
      const target = await twoNames(tx, `mace ${promoted.userId}`, null);

      await tx
        .update(user)
        .set({ isAdmin: true })
        .where(eq(user.id, promoted.userId));
      const outcome = await setIngredientCategory(
        tx,
        promoted,
        target.id,
        "spices",
      );

      expect(outcome).toMatchObject({ changed: { category: "spices" } });
    },
  );
});
