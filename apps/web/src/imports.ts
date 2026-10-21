import { reportUnauthenticated } from "./auth";

// Mirrors the POST /imports/preview contract in NATG-245
// (apps/api/src/routes/imports.ts once it lands).

// A catalogue ingredient the preview proposes for a line (NATG-321), best
// first.
export interface IngredientCandidate {
  ingredientId: number;
  name: string;
  locale: string;
  similarity: number;
}

export interface PreviewIngredient {
  position: number;
  rawText: string;
  quantity: string | null;
  quantityText: string | null;
  unit: { measurementId: number; key: string | null } | null;
  unitText: string | null;
  ingredientText: string;
  prepNotes: string | null;
  // The parser keeps what it could not split here: the whole line for mixed
  // amounts and ranges ("1 lb 4 oz chicken"), and "to taste".
  notes: string | null;
  // The page's group header, such as "For the sauce"; null when there is none.
  section: string | null;
  flags: string[];
  // The proposed catalogue ingredient, one of `candidates`; null when none
  // was matched (the line is then also flagged ingredient_unmatched).
  ingredientId: number | null;
  candidates: IngredientCandidate[];
}

// Whether ingredients were matched; when not, a message for the review.
export type IngredientMatching =
  | { status: "ok" }
  | { status: "ai_not_configured" | "ai_failed"; message: string };

export interface ImportPreview {
  sourceUrl: string;
  fetchedAt: string;
  fetchStrategy: string;
  extraction: string;
  warnings: string[];
  recipe: {
    title: string;
    servings: number | null;
    prepMinutes: number | null;
    cookMinutes: number | null;
    ingredients: PreviewIngredient[];
    steps: { position: number; text: string }[];
    tags: string[];
  };
  ingredientMatching: IngredientMatching;
}

// `code` is the api's error code (invalid_url, no_recipe_found, fetch_failed,
// import_not_permitted, unauthenticated) or null when we never got a contract error back.
export class ImportPreviewError extends Error {
  override name = "ImportPreviewError";
  constructor(
    readonly code: string | null,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

function isPreview(body: unknown): body is ImportPreview {
  if (typeof body !== "object" || body === null) return false;
  const { recipe, warnings, ingredientMatching } = body as Record<
    string,
    unknown
  >;
  if (typeof recipe !== "object" || recipe === null) return false;
  if (typeof ingredientMatching !== "object" || ingredientMatching === null) {
    return false;
  }
  const { title, ingredients, steps, tags } = recipe as Record<string, unknown>;
  return (
    Array.isArray(warnings) &&
    typeof title === "string" &&
    Array.isArray(ingredients) &&
    Array.isArray(steps) &&
    Array.isArray(tags)
  );
}

function errorBody(body: unknown): { error: string; reason?: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { error, reason } = body as Record<string, unknown>;
  if (typeof error !== "string") return null;
  return typeof reason === "string" ? { error, reason } : { error };
}

export async function previewImport(
  url: string,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<ImportPreview> {
  let res: Response;
  try {
    res = await fetch("/api/imports/preview", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(refresh ? { url, refresh: true } : { url }),
      ...(signal && { signal }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ImportPreviewError(
      null,
      "the request failed before a response arrived",
    );
  }

  if (res.status === 401) reportUnauthenticated();
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) {
    if (isPreview(body)) return body;
    throw new ImportPreviewError(null, "its response was not a recipe preview");
  }
  const error = errorBody(body);
  if (error) {
    throw new ImportPreviewError(
      error.error,
      `the server answered with HTTP ${res.status} ${error.error}`,
      error.reason,
    );
  }
  throw new ImportPreviewError(
    null,
    `the server answered with HTTP ${res.status}`,
  );
}

// A reviewed line as POST /imports takes it: `measurementId: null` is a line
// with no unit, and `quantity` is a plain decimal or null.
export interface SaveLine {
  position: number;
  ingredientId: number;
  measurementId: number | null;
  quantity: string | null;
  prepNotes: string | null;
  notes: string | null;
}

export interface SaveRequest {
  sourceUrl: string;
  recipe: {
    title: string;
    servings: number | null;
    prepMinutes: number | null;
    cookMinutes: number | null;
    ingredients: SaveLine[];
    steps: { position: number; text: string }[];
    tags: string[];
  };
}

// The 201 body: the new recipe's own columns (SaveResponse in
// apps/api/src/routes/imports.ts). alreadyImported is true when the user had
// a recipe from the same page before; the new one is saved anyway.
export interface SavedRecipe {
  id: number;
  title: string;
  alreadyImported: boolean;
}

// `code` is the api's error code (invalid_request, invalid_lines,
// invalid_steps, unresolved_lines, unauthenticated) or null when we never
// got a contract error back. `positions` are the offending lines (or steps,
// for invalid_steps) of a 422.
export class SaveImportError extends Error {
  override name = "SaveImportError";
  constructor(
    readonly code: string | null,
    message: string,
    readonly positions: number[] = [],
  ) {
    super(message);
  }
}

function isSaved(body: unknown): body is SavedRecipe {
  if (typeof body !== "object" || body === null) return false;
  const { id, title, alreadyImported } = body as Record<string, unknown>;
  return (
    typeof id === "number" &&
    typeof title === "string" &&
    typeof alreadyImported === "boolean"
  );
}

export async function saveImport(request: SaveRequest): Promise<SavedRecipe> {
  let res: Response;
  try {
    res = await fetch("/api/imports", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch {
    throw new SaveImportError(
      null,
      "the request failed before a response arrived",
    );
  }

  if (res.status === 401) reportUnauthenticated();
  const body: unknown = await res.json().catch(() => undefined);
  if (res.status === 201) {
    if (isSaved(body)) return body;
    throw new SaveImportError(null, "its response was not a saved recipe");
  }
  const error = errorBody(body);
  if (error) {
    const { positions } = body as { positions?: unknown };
    throw new SaveImportError(
      error.error,
      `the server answered with HTTP ${res.status} ${error.error}`,
      Array.isArray(positions)
        ? positions.filter((p): p is number => typeof p === "number")
        : [],
    );
  }
  throw new SaveImportError(
    null,
    `the server answered with HTTP ${res.status}`,
  );
}
