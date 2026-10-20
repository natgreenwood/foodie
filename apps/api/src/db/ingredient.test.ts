import { eq, sql } from "drizzle-orm";
import { describe, expect } from "vitest";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  ingredient,
  ingredientName,
  recipe,
  recipeIngredient,
  user,
} from "./schema.js";

async function newIngredient(tx: TestTransaction): Promise<number> {
  const [row] = await tx
    .insert(ingredient)
    .values({})
    .returning({ id: ingredient.id });
  if (!row) throw new Error("ingredient insert returned no row");
  return row.id;
}

// Tests whose names the seeded en-GB and en-US catalogue (0015) already
// holds use x-test locales, so they do not collide with it.
describe("ingredient_name", () => {
  dbTest(
    "rejects a name that matches another in the same locale after normalisation",
    async ({ tx }) => {
      const id = await newIngredient(tx);
      await tx
        .insert(ingredientName)
        .values({ ingredientId: id, name: "coriander", locale: "x-test" });

      for (const name of ["Coriander", " coriander "]) {
        await expect(
          tx.transaction((sp) =>
            sp
              .insert(ingredientName)
              .values({ ingredientId: id, name, locale: "x-test" }),
          ),
        ).rejects.toMatchObject({
          cause: { constraint: "ingredient_name_locale_name_key" },
        });
      }
    },
  );

  dbTest(
    "allows the same name in different locales on different ingredients",
    async ({ tx }) => {
      const gb = await newIngredient(tx);
      const us = await newIngredient(tx);

      await tx.insert(ingredientName).values([
        { ingredientId: gb, name: "biscuit", locale: "en-GB" },
        { ingredientId: us, name: "biscuit", locale: "en-US" },
      ]);
    },
  );

  dbTest(
    "keeps one canonical name per ingredient per locale",
    async ({ tx }) => {
      const id = await newIngredient(tx);
      await tx.insert(ingredientName).values([
        {
          ingredientId: id,
          name: "coriander",
          locale: "x-test-gb",
          isCanonical: true,
        },
        {
          ingredientId: id,
          name: "cilantro",
          locale: "x-test-us",
          isCanonical: true,
        },
      ]);

      await expect(
        tx.transaction((sp) =>
          sp.insert(ingredientName).values({
            ingredientId: id,
            name: "coriander leaf",
            locale: "x-test-gb",
            isCanonical: true,
          }),
        ),
      ).rejects.toMatchObject({
        cause: { constraint: "ingredient_name_canonical_key" },
      });
    },
  );

  dbTest("rejects a blank name", async ({ tx }) => {
    const id = await newIngredient(tx);

    await expect(
      tx.transaction((sp) =>
        sp
          .insert(ingredientName)
          .values({ ingredientId: id, name: " \t ", locale: "en-GB" }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "ingredient_name_name_not_blank" },
    });
  });

  // Scraped HTML is full of &nbsp;, which Postgres's own \s does not match.
  dbTest(
    "rejects a name that matches another once non-breaking spaces are collapsed",
    async ({ tx }) => {
      const id = await newIngredient(tx);
      await tx
        .insert(ingredientName)
        .values({ ingredientId: id, name: "coriander leaf", locale: "en-GB" });

      for (const name of [
        "coriander leaf\u00a0",
        "\u00a0coriander\u00a0leaf",
        "coriander\u202fleaf",
      ]) {
        await expect(
          tx.transaction((sp) =>
            sp
              .insert(ingredientName)
              .values({ ingredientId: id, name, locale: "en-GB" }),
          ),
        ).rejects.toMatchObject({
          cause: { constraint: "ingredient_name_locale_name_key" },
        });
      }
    },
  );

  dbTest("rejects a name that is only a non-breaking space", async ({ tx }) => {
    const id = await newIngredient(tx);

    await expect(
      tx.transaction((sp) =>
        sp
          .insert(ingredientName)
          .values({ ingredientId: id, name: "\u00a0", locale: "en-GB" }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "ingredient_name_name_not_blank" },
    });
  });

  dbTest("is removed with its ingredient", async ({ tx }) => {
    const id = await newIngredient(tx);
    await tx.insert(ingredientName).values([
      { ingredientId: id, name: "coriander", locale: "x-test-gb" },
      { ingredientId: id, name: "cilantro", locale: "x-test-us" },
    ]);

    await tx.delete(ingredient).where(eq(ingredient.id, id));

    const names = await tx
      .select()
      .from(ingredientName)
      .where(eq(ingredientName.ingredientId, id));
    expect(names).toEqual([]);
  });

  dbTest("serves fuzzy name search from the trigram index", async ({ tx }) => {
    // The table is near-empty, so the planner would otherwise prefer a scan;
    // this checks the index can serve the query, not the planner's costing.
    await tx.execute(sql`set local enable_seqscan = off`);

    for (const condition of [
      sql`${ingredientName.normalisedName} % 'corriander'`,
      sql`${ingredientName.normalisedName} ilike '%riand%'`,
    ]) {
      const plan = await tx.execute<{ "QUERY PLAN": string }>(
        sql`explain select ${ingredientName.id} from ${ingredientName} where ${condition}`,
      );
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
        "ingredient_name_normalised_name_trgm_idx",
      );
    }
  });

  dbTest(
    "serves word-similarity (prefix) search from the trigram index",
    async ({ tx }) => {
      await tx.execute(sql`set local enable_seqscan = off`);

      const plan = await tx.execute<{ "QUERY PLAN": string }>(
        sql`explain select ${ingredientName.id} from ${ingredientName} where 'cor' <% ${ingredientName.normalisedName}`,
      );
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
        "ingredient_name_normalised_name_trgm_idx",
      );
    },
  );
});

describe("created_by", () => {
  dbTest(
    "goes null on the ingredient and its names when the author is deleted",
    async ({ tx }) => {
      const [author] = await tx
        .insert(user)
        .values({ email: `author-${crypto.randomUUID()}@ingredient.test` })
        .returning({ id: user.id });
      const [cook] = await tx
        .insert(user)
        .values({ email: `cook-${crypto.randomUUID()}@ingredient.test` })
        .returning({ id: user.id });
      if (!author || !cook) throw new Error("user insert returned no row");
      const [row] = await tx
        .insert(ingredient)
        .values({ source: "user", createdBy: author.id })
        .returning({ id: ingredient.id });
      if (!row) throw new Error("ingredient insert returned no row");
      await tx.insert(ingredientName).values({
        ingredientId: row.id,
        name: "za'atar",
        locale: "en-GB",
        createdBy: author.id,
      });
      // Another user's recipe uses it: a cascade would hit the restrict on
      // recipe_ingredient and block the user delete.
      const [dish] = await tx
        .insert(recipe)
        .values({ ownerId: cook.id, title: "Flatbread" })
        .returning({ id: recipe.id });
      if (!dish) throw new Error("recipe insert returned no row");
      await tx
        .insert(recipeIngredient)
        .values({ recipeId: dish.id, position: 1, ingredientId: row.id });

      await tx.delete(user).where(eq(user.id, author.id));

      const [kept] = await tx
        .select({ createdBy: ingredient.createdBy, source: ingredient.source })
        .from(ingredient)
        .where(eq(ingredient.id, row.id));
      expect(kept).toEqual({ createdBy: null, source: "user" });
      const names = await tx
        .select({ createdBy: ingredientName.createdBy })
        .from(ingredientName)
        .where(eq(ingredientName.ingredientId, row.id));
      expect(names).toEqual([{ createdBy: null }]);
    },
  );
});
