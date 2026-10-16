// Mirrors the POST /imports/preview contract in NATG-245
// (apps/api/src/routes/imports.ts once it lands).
export interface PreviewIngredient {
  position: number;
  rawText: string;
  quantity: string | null;
  quantityText: string | null;
  unit: { measurementId: number; key: string } | null;
  unitText: string | null;
  ingredientText: string;
  prepNotes: string | null;
  notes: string | null;
  flags: string[];
}

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
}

// `code` is the api's error code (invalid_url, no_recipe_found, fetch_failed,
// import_not_permitted) or null when we never got a contract error back.
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
  const { recipe, warnings } = body as Record<string, unknown>;
  if (typeof recipe !== "object" || recipe === null) return false;
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
