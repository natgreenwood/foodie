import { reportUnauthenticated } from "./auth";

// Mirrors GET /recipes/:id as NATG-370 extends it
// (apps/api/src/routes/recipes.ts): the recipe's own columns plus its lines,
// steps and tags. Each line's ingredient is named by the catalogue's
// display-name rule for the viewer's locale; `name` is null only for an
// ingredient with no names.
export interface RecipeLine {
  position: number;
  ingredient: { id: number; name: string | null; locale: string | null };
  measurementId: number | null;
  quantity: string | null;
  prepNotes: string | null;
  notes: string | null;
}

export interface Recipe {
  id: number;
  title: string;
  sourceUrl: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  ingredients: RecipeLine[];
  steps: { position: number; text: string }[];
  tags: string[];
}

// `code` is the api's error code (not_found, unauthenticated,
// internal_error) or null when we never got a contract error back.
export class RecipeError extends Error {
  override name = "RecipeError";
  constructor(
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

function isRecipe(body: unknown): body is Recipe {
  if (typeof body !== "object" || body === null) return false;
  const { id, title, ingredients, steps, tags } = body as Record<
    string,
    unknown
  >;
  return (
    typeof id === "number" &&
    typeof title === "string" &&
    Array.isArray(ingredients) &&
    Array.isArray(steps) &&
    Array.isArray(tags)
  );
}

export async function fetchRecipe(
  id: number,
  signal?: AbortSignal,
): Promise<Recipe> {
  let res: Response;
  try {
    res = await fetch(`/api/recipes/${id}`, {
      headers: { Accept: "application/json" },
      ...(signal && { signal }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new RecipeError(null, "the request failed before a response arrived");
  }
  if (res.status === 401) reportUnauthenticated();
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) {
    if (isRecipe(body)) return body;
    throw new RecipeError(null, "its response was not a recipe");
  }
  const { error } = (body ?? {}) as { error?: unknown };
  if (typeof error === "string") {
    throw new RecipeError(
      error,
      `the server answered with HTTP ${res.status} ${error}`,
    );
  }
  throw new RecipeError(null, `the server answered with HTTP ${res.status}`);
}
