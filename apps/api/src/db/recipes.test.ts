import { asc, eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  createOwnedRecipe,
  deleteOwnedRecipe,
  findOwnedRecipe,
  listOwnedRecipes,
  type NewRecipe,
} from "./recipes.js";
import {
  ingredient,
  measurement,
  recipe,
  recipeIngredient,
  recipeStep,
  recipeTag,
  user,
} from "./schema.js";

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

describe("createOwnedRecipe", () => {
  const SOURCE = "https://www.example.com/recipes/dal";

  async function catalogue(tx: TestTransaction) {
    const [lentils] = await tx
      .insert(ingredient)
      .values({ source: "test" })
      .returning({ id: ingredient.id });
    const [gram] = await tx
      .insert(measurement)
      .values({ type: "mass", factorToBase: "1" })
      .returning({ id: measurement.id });
    return { lentilsId: lentils!.id, gramId: gram!.id };
  }

  function draft(
    ids: { lentilsId: number; gramId: number },
    overrides: Partial<NewRecipe> = {},
  ): NewRecipe {
    return {
      title: "Dal",
      sourceUrl: SOURCE,
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 30,
      ingredients: [
        {
          position: 1,
          ingredientId: ids.lentilsId,
          measurementId: ids.gramId,
          quantity: "250",
          prepNotes: "rinsed",
          notes: null,
        },
        {
          position: 2,
          ingredientId: ids.lentilsId,
          measurementId: null,
          quantity: null,
          prepNotes: null,
          notes: "to serve",
        },
      ],
      steps: [
        { position: 1, text: "Simmer the lentils." },
        { position: 2, text: "Serve." },
      ],
      tags: ["Dinner", " dinner ", "vegan"],
      ...overrides,
    };
  }

  dbTest(
    "creates the recipe with its lines, steps and tags for the owner",
    async ({ tx }) => {
      const owner = await newUser(tx);
      const ids = await catalogue(tx);

      const result = await createOwnedRecipe(tx, owner, draft(ids));

      if (!("recipe" in result)) throw new Error("expected a recipe");
      expect(result.alreadyImported).toBe(false);
      expect(result.recipe).toMatchObject({
        title: "Dal",
        sourceUrl: SOURCE,
        servings: 4,
        prepMinutes: 10,
        cookMinutes: 30,
      });
      const id = result.recipe.id;
      expect(await findOwnedRecipe(tx, owner, id)).toEqual(result.recipe);
      expect(
        await tx
          .select({
            position: recipeIngredient.position,
            ingredientId: recipeIngredient.ingredientId,
            measurementId: recipeIngredient.measurementId,
            quantity: recipeIngredient.quantity,
            prepNotes: recipeIngredient.prepNotes,
            notes: recipeIngredient.notes,
          })
          .from(recipeIngredient)
          .where(eq(recipeIngredient.recipeId, id))
          .orderBy(asc(recipeIngredient.position)),
      ).toEqual(draft(ids).ingredients);
      expect(
        await tx
          .select({ position: recipeStep.position, text: recipeStep.text })
          .from(recipeStep)
          .where(eq(recipeStep.recipeId, id))
          .orderBy(asc(recipeStep.position)),
      ).toEqual(draft(ids).steps);
      // " dinner " normalises to the same tag as "Dinner": kept once.
      expect(
        await tx
          .select({ tag: recipeTag.tag })
          .from(recipeTag)
          .where(eq(recipeTag.recipeId, id))
          .orderBy(asc(recipeTag.normalisedTag)),
      ).toEqual([{ tag: "Dinner" }, { tag: "vegan" }]);
    },
  );

  dbTest(
    "creates a second recipe for a URL the owner already has, and says so",
    async ({ tx }) => {
      const owner = await newUser(tx);
      const ids = await catalogue(tx);
      const first = await createOwnedRecipe(tx, owner, draft(ids));

      const second = await createOwnedRecipe(tx, owner, draft(ids));

      if (!("recipe" in first) || !("recipe" in second)) {
        throw new Error("expected recipes");
      }
      expect(second.alreadyImported).toBe(true);
      expect(second.recipe.id).not.toBe(first.recipe.id);
      expect(await listOwnedRecipes(tx, owner)).toHaveLength(2);
    },
  );

  dbTest(
    "does not count another user's recipe from the same URL",
    async ({ tx }) => {
      const ids = await catalogue(tx);
      await createOwnedRecipe(tx, await newUser(tx), draft(ids));

      const result = await createOwnedRecipe(tx, await newUser(tx), draft(ids));

      expect(result).toMatchObject({ alreadyImported: false });
    },
  );

  dbTest(
    "rejects lines naming an ingredient or unit that does not exist, writing nothing",
    async ({ tx }) => {
      const owner = await newUser(tx);
      const ids = await catalogue(tx);
      // Ids past every row this transaction or the seed wrote.
      const missing = Math.max(ids.lentilsId, ids.gramId) + 1000;
      const [first, second] = draft(ids).ingredients;
      const input = draft(ids, {
        ingredients: [
          { ...first!, position: 3, ingredientId: missing },
          { ...second!, position: 1 },
          { ...first!, position: 2, measurementId: missing },
        ],
      });

      const result = await createOwnedRecipe(tx, owner, input);

      expect(result).toEqual({ unresolvedPositions: [2, 3] });
      expect(await listOwnedRecipes(tx, owner)).toEqual([]);
    },
  );

  dbTest("creates a recipe with no lines, steps or tags", async ({ tx }) => {
    const owner = await newUser(tx);
    const ids = await catalogue(tx);

    const result = await createOwnedRecipe(
      tx,
      owner,
      draft(ids, { ingredients: [], steps: [], tags: [] }),
    );

    expect(result).toMatchObject({
      recipe: { title: "Dal" },
      alreadyImported: false,
    });
  });
});
