import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../auth/accounts.js";
import { recipe } from "./schema.js";

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
