import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  deleteOwnedRecipe,
  findOwnedRecipe,
  listOwnedRecipes,
} from "./recipes.js";
import { recipe, user } from "./schema.js";

async function newUser(tx: TestTransaction): Promise<{ id: number }> {
  const [row] = await tx
    .insert(user)
    .values({ email: `cook-${crypto.randomUUID()}@recipes-helper.test` })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  return row;
}

async function newRecipe(
  tx: TestTransaction,
  owner: { id: number },
  title = "Shakshuka",
): Promise<number> {
  const [row] = await tx
    .insert(recipe)
    .values({ ownerId: owner.id, title })
    .returning({ id: recipe.id });
  if (!row) throw new Error("recipe insert returned no row");
  return row.id;
}

describe("findOwnedRecipe", () => {
  dbTest("returns the owner's recipe, without the owner", async ({ tx }) => {
    const owner = await newUser(tx);
    const id = await newRecipe(tx, owner);

    const found = await findOwnedRecipe(tx, owner, id);

    expect(found).toMatchObject({ id, title: "Shakshuka" });
    expect(found).not.toHaveProperty("ownerId");
  });

  dbTest("returns null for someone else's recipe", async ({ tx }) => {
    const id = await newRecipe(tx, await newUser(tx));

    expect(await findOwnedRecipe(tx, await newUser(tx), id)).toBeNull();
  });

  dbTest("returns null for a recipe that does not exist", async ({ tx }) => {
    const owner = await newUser(tx);
    const id = await newRecipe(tx, owner);
    await tx.delete(recipe).where(eq(recipe.id, id));

    expect(await findOwnedRecipe(tx, owner, id)).toBeNull();
  });
});

describe("listOwnedRecipes", () => {
  dbTest("returns only the owner's recipes, newest first", async ({ tx }) => {
    const owner = await newUser(tx);
    const first = await newRecipe(tx, owner, "Dal");
    const second = await newRecipe(tx, owner, "Shakshuka");
    await newRecipe(tx, await newUser(tx), "Not mine");

    const listed = await listOwnedRecipes(tx, owner);

    // Both rows share the transaction's now(), so id breaks the tie.
    expect(listed.map((r) => r.id)).toEqual([second, first]);
  });

  dbTest("returns nothing for a user with no recipes", async ({ tx }) => {
    await newRecipe(tx, await newUser(tx));

    expect(await listOwnedRecipes(tx, await newUser(tx))).toEqual([]);
  });
});

describe("deleteOwnedRecipe", () => {
  dbTest("deletes the owner's recipe", async ({ tx }) => {
    const owner = await newUser(tx);
    const id = await newRecipe(tx, owner);

    expect(await deleteOwnedRecipe(tx, owner, id)).toBe(true);
    expect(await tx.select().from(recipe).where(eq(recipe.id, id))).toEqual([]);
    // Already gone.
    expect(await deleteOwnedRecipe(tx, owner, id)).toBe(false);
  });

  dbTest("leaves someone else's recipe alone", async ({ tx }) => {
    const id = await newRecipe(tx, await newUser(tx));

    expect(await deleteOwnedRecipe(tx, await newUser(tx), id)).toBe(false);
    expect(
      await tx.select({ id: recipe.id }).from(recipe).where(eq(recipe.id, id)),
    ).toEqual([{ id }]);
  });
});
