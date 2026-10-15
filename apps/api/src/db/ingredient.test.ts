import { eq, sql } from "drizzle-orm";
import { describe, expect } from "vitest";
import { dbTest, type TestTransaction } from "../test/db.js";
import { ingredient, ingredientName } from "./schema.js";

async function newIngredient(tx: TestTransaction): Promise<number> {
  const [row] = await tx
    .insert(ingredient)
    .values({})
    .returning({ id: ingredient.id });
  if (!row) throw new Error("ingredient insert returned no row");
  return row.id;
}

describe("ingredient_name", () => {
  dbTest(
    "rejects a name that matches another in the same locale after normalisation",
    async ({ tx }) => {
      const id = await newIngredient(tx);
      await tx
        .insert(ingredientName)
        .values({ ingredientId: id, name: "coriander", locale: "en-GB" });

      for (const name of ["Coriander", " coriander "]) {
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
          locale: "en-GB",
          isCanonical: true,
        },
        {
          ingredientId: id,
          name: "cilantro",
          locale: "en-US",
          isCanonical: true,
        },
      ]);

      await expect(
        tx.transaction((sp) =>
          sp.insert(ingredientName).values({
            ingredientId: id,
            name: "coriander leaf",
            locale: "en-GB",
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

  dbTest("is removed with its ingredient", async ({ tx }) => {
    const id = await newIngredient(tx);
    await tx.insert(ingredientName).values([
      { ingredientId: id, name: "coriander", locale: "en-GB" },
      { ingredientId: id, name: "cilantro", locale: "en-US" },
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
});
