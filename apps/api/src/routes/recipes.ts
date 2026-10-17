import type { FastifyPluginCallback, FastifyReply } from "fastify";
import {
  deleteOwnedRecipe,
  findOwnedRecipe,
  listOwnedRecipes,
  type Recipe,
} from "../db/recipes.js";
import type { AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

export interface RecipeListResponse {
  recipes: Recipe[];
}

// A recipe id from the path, or null for anything that cannot be one. Ids
// past Number.MAX_SAFE_INTEGER are refused rather than rounded onto
// another recipe.
function parseRecipeId(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Someone else's recipe, a deleted one and a malformed id all get this.
function notFound(reply: FastifyReply) {
  return sendError(reply, 404, "not_found", "recipe not found");
}

// GET /recipes, GET /recipes/:id and DELETE /recipes/:id: the signed-in
// user's own recipes. Registered behind requireUser, so request.user is
// always set here. Creating recipes is the import's job (NATG-250).
export const recipeRoutes: FastifyPluginCallback<AuthDeps> = (
  app,
  { db },
  done,
) => {
  app.setErrorHandler(apiErrorHandler("recipes"));

  app.get("/recipes", async (request): Promise<RecipeListResponse> => {
    return { recipes: await listOwnedRecipes(db, request.user!) };
  });

  app.get<{ Params: { id: string } }>(
    "/recipes/:id",
    async (request, reply) => {
      const id = parseRecipeId(request.params.id);
      const found =
        id === null ? null : await findOwnedRecipe(db, request.user!, id);
      if (!found) return notFound(reply);
      return found;
    },
  );

  // 204 once deleted. A retry after a successful delete gets 404.
  app.delete<{ Params: { id: string } }>(
    "/recipes/:id",
    async (request, reply) => {
      const id = parseRecipeId(request.params.id);
      if (id === null || !(await deleteOwnedRecipe(db, request.user!, id))) {
        return notFound(reply);
      }
      request.log.info(
        { userId: request.user!.id, recipeId: id },
        "recipe deleted",
      );
      return reply.code(204).send();
    },
  );

  done();
};
