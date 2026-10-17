import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../auth/accounts.js";
import {
  ingredient,
  measurement,
  recipe,
  recipeIngredient,
  recipeStep,
  recipeTag,
} from "./schema.js";

// Recipes are private to their owner. Every read or write of a recipe on
// behalf of a user goes through here, so a recipe id from a request can
// never reach another user's row. A recipe that is someone else's looks the
// same as one that does not exist.

// A recipe as the api returns it. The owner is always the caller, so it is
// left out.
export type Recipe = Omit<typeof recipe.$inferSelect, "ownerId">;

const recipeColumns = {
  id: recipe.id,
  title: recipe.title,
  sourceUrl: recipe.sourceUrl,
  servings: recipe.servings,
  prepMinutes: recipe.prepMinutes,
  cookMinutes: recipe.cookMinutes,
  createdAt: recipe.createdAt,
  updatedAt: recipe.updatedAt,
};

function ownedBy(owner: { id: number }, recipeId: number) {
  return and(eq(recipe.id, recipeId), eq(recipe.ownerId, owner.id));
}

// The recipe if `owner` owns it; null if it does not exist or is someone
// else's. Routes answer null with 404.
export async function findOwnedRecipe(
  db: Db,
  owner: { id: number },
  recipeId: number,
): Promise<Recipe | null> {
  const [row] = await db
    .select(recipeColumns)
    .from(recipe)
    .where(ownedBy(owner, recipeId));
  return row ?? null;
}

// The owner's recipes, newest first.
export function listOwnedRecipes(
  db: Db,
  owner: { id: number },
): Promise<Recipe[]> {
  return db
    .select(recipeColumns)
    .from(recipe)
    .where(eq(recipe.ownerId, owner.id))
    .orderBy(desc(recipe.createdAt), desc(recipe.id));
}

// Deletes the recipe, with its lines, steps and tags, if `owner` owns it.
// False if it does not exist or is someone else's. One statement, so nothing
// can change the recipe between the ownership check and the delete.
export async function deleteOwnedRecipe(
  db: Db,
  owner: { id: number },
  recipeId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(recipe)
    .where(ownedBy(owner, recipeId))
    .returning({ id: recipe.id });
  return deleted.length > 0;
}

// One ingredient line of a recipe being created. measurementId null is a line
// with no unit ("3 eggs", "salt to taste").
export interface NewRecipeLine {
  position: number;
  ingredientId: number;
  measurementId: number | null;
  quantity: string | null;
  prepNotes: string | null;
  notes: string | null;
}

export interface NewRecipe {
  title: string;
  sourceUrl: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: NewRecipeLine[];
  steps: { position: number; text: string }[];
  tags: string[];
}

export type CreateOwnedRecipeResult =
  | { recipe: Recipe; alreadyImported: boolean }
  | { unresolvedPositions: number[] };

// Creates the recipe, its lines, steps and tags for `owner`, in one
// transaction. If any line names an ingredient or measurement that does not
// exist, nothing is written and the result lists those lines' positions. The
// catalogue rows the lines name are locked until commit, so one deleted
// meanwhile cannot fail the insert. alreadyImported says the owner already
// had a recipe with this source_url; the new one is created anyway
// (NATG-209). The caller checks everything else the constraints check.
export function createOwnedRecipe(
  db: Db,
  owner: { id: number },
  input: NewRecipe,
): Promise<CreateOwnedRecipeResult> {
  return db.transaction(async (t) => {
    const unresolvedPositions = await unresolvedLines(t, input.ingredients);
    if (unresolvedPositions.length > 0) return { unresolvedPositions };

    const alreadyImported =
      input.sourceUrl !== null &&
      (
        await t
          .select({ id: recipe.id })
          .from(recipe)
          .where(
            and(
              eq(recipe.ownerId, owner.id),
              eq(recipe.sourceUrl, input.sourceUrl),
            ),
          )
          .limit(1)
      ).length > 0;

    const [created] = await t
      .insert(recipe)
      .values({
        ownerId: owner.id,
        title: input.title,
        sourceUrl: input.sourceUrl,
        servings: input.servings,
        prepMinutes: input.prepMinutes,
        cookMinutes: input.cookMinutes,
      })
      .returning(recipeColumns);
    if (!created) throw new Error("recipe insert returned no row");

    if (input.ingredients.length > 0) {
      await t
        .insert(recipeIngredient)
        .values(
          input.ingredients.map((line) => ({ recipeId: created.id, ...line })),
        );
    }
    if (input.steps.length > 0) {
      await t
        .insert(recipeStep)
        .values(input.steps.map((step) => ({ recipeId: created.id, ...step })));
    }
    if (input.tags.length > 0) {
      // Tags that normalise the same ("Dinner", " dinner") are one tag.
      await t
        .insert(recipeTag)
        .values(input.tags.map((tag) => ({ recipeId: created.id, tag })))
        .onConflictDoNothing();
    }
    return { recipe: created, alreadyImported };
  });
}

// The positions of the lines whose ingredient or measurement does not exist,
// in order. One query per table, each locking the rows it finds.
async function unresolvedLines(
  db: Db,
  lines: readonly NewRecipeLine[],
): Promise<number[]> {
  const ingredientIds = [...new Set(lines.map((l) => l.ingredientId))];
  const measurementIds = [
    ...new Set(
      lines.flatMap((l) => (l.measurementId === null ? [] : [l.measurementId])),
    ),
  ];
  const ingredients = new Set(
    ingredientIds.length === 0
      ? []
      : (
          await db
            .select({ id: ingredient.id })
            .from(ingredient)
            .where(inArray(ingredient.id, ingredientIds))
            .for("key share")
        ).map((r) => r.id),
  );
  const measurements = new Set(
    measurementIds.length === 0
      ? []
      : (
          await db
            .select({ id: measurement.id })
            .from(measurement)
            .where(inArray(measurement.id, measurementIds))
            .for("key share")
        ).map((r) => r.id),
  );
  return lines
    .filter(
      (l) =>
        !ingredients.has(l.ingredientId) ||
        (l.measurementId !== null && !measurements.has(l.measurementId)),
    )
    .map((l) => l.position)
    .sort((a, b) => a - b);
}
