import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  ingredient,
  measurement,
  recipe,
  recipeIngredient,
  recipeStep,
  recipeTag,
} from "./schema.js";

async function newRecipe(tx: TestTransaction): Promise<number> {
  const [row] = await tx
    .insert(recipe)
    .values({ title: "Shakshuka" })
    .returning({ id: recipe.id });
  if (!row) throw new Error("recipe insert returned no row");
  return row.id;
}

async function newIngredient(tx: TestTransaction): Promise<number> {
  const [row] = await tx
    .insert(ingredient)
    .values({})
    .returning({ id: ingredient.id });
  if (!row) throw new Error("ingredient insert returned no row");
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

describe("recipe", () => {
  dbTest("rejects a blank title", async ({ tx }) => {
    await expect(
      tx.transaction((sp) => sp.insert(recipe).values({ title: " \t " })),
    ).rejects.toMatchObject({
      cause: { constraint: "recipe_title_not_blank" },
    });
  });

  dbTest("removes its lines, steps and tags when deleted", async ({ tx }) => {
    const id = await newRecipe(tx);
    await tx.insert(recipeIngredient).values({
      recipeId: id,
      position: 1,
      ingredientId: await newIngredient(tx),
    });
    await tx
      .insert(recipeStep)
      .values({ recipeId: id, position: 1, text: "Fry the onions." });
    await tx.insert(recipeTag).values({ recipeId: id, tag: "vegetarian" });

    await tx.delete(recipe).where(eq(recipe.id, id));

    for (const [table, column] of [
      [recipeIngredient, recipeIngredient.recipeId],
      [recipeStep, recipeStep.recipeId],
      [recipeTag, recipeTag.recipeId],
    ] as const) {
      expect(await tx.select().from(table).where(eq(column, id))).toEqual([]);
    }
  });
});

describe("recipe_ingredient", () => {
  dbTest(
    "holds a line with no measurement or quantity, such as salt to taste",
    async ({ tx }) => {
      const id = await newRecipe(tx);
      await tx.insert(recipeIngredient).values({
        recipeId: id,
        position: 1,
        ingredientId: await newIngredient(tx),
        notes: "to taste",
      });
    },
  );

  dbTest(
    "allows the same ingredient on two lines of one recipe",
    async ({ tx }) => {
      const id = await newRecipe(tx);
      const salt = await newIngredient(tx);
      await tx.insert(recipeIngredient).values([
        { recipeId: id, position: 1, ingredientId: salt },
        { recipeId: id, position: 2, ingredientId: salt },
      ]);
    },
  );

  dbTest("rejects two lines in the same position", async ({ tx }) => {
    const id = await newRecipe(tx);
    await tx.insert(recipeIngredient).values({
      recipeId: id,
      position: 1,
      ingredientId: await newIngredient(tx),
    });

    await expect(
      tx.transaction(async (sp) =>
        sp.insert(recipeIngredient).values({
          recipeId: id,
          position: 1,
          ingredientId: await newIngredient(sp),
        }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "recipe_ingredient_recipe_position_key" },
    });
  });

  dbTest("rejects a quantity of zero", async ({ tx }) => {
    const id = await newRecipe(tx);
    const ingredientId = await newIngredient(tx);

    await expect(
      tx.transaction((sp) =>
        sp
          .insert(recipeIngredient)
          .values({ recipeId: id, position: 1, ingredientId, quantity: "0" }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "recipe_ingredient_quantity_positive" },
    });
  });

  dbTest("blocks deleting an ingredient a line uses", async ({ tx }) => {
    const ingredientId = await newIngredient(tx);
    await tx
      .insert(recipeIngredient)
      .values({ recipeId: await newRecipe(tx), position: 1, ingredientId });

    await expect(
      tx.transaction((sp) =>
        sp.delete(ingredient).where(eq(ingredient.id, ingredientId)),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "recipe_ingredient_ingredient_id_ingredient_id_fk" },
    });
  });

  dbTest("blocks deleting a measurement a line uses", async ({ tx }) => {
    const measurementId = await newMeasurement(tx);
    await tx.insert(recipeIngredient).values({
      recipeId: await newRecipe(tx),
      position: 1,
      ingredientId: await newIngredient(tx),
      measurementId,
      quantity: "0.5",
    });

    await expect(
      tx.transaction((sp) =>
        sp.delete(measurement).where(eq(measurement.id, measurementId)),
      ),
    ).rejects.toMatchObject({
      cause: {
        constraint: "recipe_ingredient_measurement_id_measurement_id_fk",
      },
    });
  });
});

describe("recipe_step", () => {
  dbTest("rejects two steps in the same position", async ({ tx }) => {
    const id = await newRecipe(tx);
    await tx
      .insert(recipeStep)
      .values({ recipeId: id, position: 1, text: "Fry the onions." });

    await expect(
      tx.transaction((sp) =>
        sp
          .insert(recipeStep)
          .values({ recipeId: id, position: 1, text: "Add the eggs." }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "recipe_step_recipe_position_key" },
    });
  });

  dbTest("rejects blank step text", async ({ tx }) => {
    const id = await newRecipe(tx);

    await expect(
      tx.transaction((sp) =>
        sp
          .insert(recipeStep)
          .values({ recipeId: id, position: 1, text: " \t\n " }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "recipe_step_text_not_blank" },
    });
  });
});

describe("recipe_tag", () => {
  dbTest(
    "rejects a tag that matches another on the recipe after normalisation",
    async ({ tx }) => {
      const id = await newRecipe(tx);
      await tx.insert(recipeTag).values({ recipeId: id, tag: "High-Protein" });

      for (const tag of [" high-protein ", "HIGH-PROTEIN"]) {
        await expect(
          tx.transaction((sp) =>
            sp.insert(recipeTag).values({ recipeId: id, tag }),
          ),
        ).rejects.toMatchObject({
          cause: { constraint: "recipe_tag_recipe_id_normalised_tag_pk" },
        });
      }
    },
  );

  dbTest(
    "stores the tag lowercased, trimmed and with whitespace collapsed",
    async ({ tx }) => {
      const id = await newRecipe(tx);
      const [row] = await tx
        .insert(recipeTag)
        .values({ recipeId: id, tag: "  Gluten \t Free " })
        .returning({ normalisedTag: recipeTag.normalisedTag });

      expect(row).toEqual({ normalisedTag: "gluten free" });
    },
  );

  dbTest("allows the same tag on different recipes", async ({ tx }) => {
    await tx.insert(recipeTag).values([
      { recipeId: await newRecipe(tx), tag: "gluten-free" },
      { recipeId: await newRecipe(tx), tag: "gluten-free" },
    ]);
  });

  dbTest("rejects a blank tag", async ({ tx }) => {
    const id = await newRecipe(tx);

    await expect(
      tx.transaction((sp) =>
        sp.insert(recipeTag).values({ recipeId: id, tag: " \n " }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "recipe_tag_tag_not_blank" },
    });
  });
});
