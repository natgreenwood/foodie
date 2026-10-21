import { reportUnauthenticated } from "./auth";

// Mirrors the catalogue routes in apps/api/src/routes/ingredients.ts
// (NATG-341) and GET /measurements in apps/api/src/routes/measurements.ts
// (NATG-339).

// The locales the catalogue's names are written in (PageLocale in
// apps/api/src/import/locale.ts).
export const CATALOGUE_LOCALES: Record<string, string> = {
  "en-GB": "English (UK)",
  "en-US": "English (US)",
};

export function localeLabel(locale: string): string {
  return CATALOGUE_LOCALES[locale] ?? locale;
}

const EN_GB_SUFFIXES: readonly string[] = [".uk", ".ie", ".au", ".nz"];

// The catalogue locale a page's ingredient names are most likely written
// in, as the api decides it (localeForHost in apps/api/src/import/locale.ts).
export function localeForHost(sourceHost: string): string {
  const host = sourceHost.trim().toLowerCase().replace(/\.$/, "");
  return EN_GB_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ? "en-GB"
    : "en-US";
}

// `code` is the api's error code (invalid_request, name_taken, not_found,
// unauthenticated, internal_error) or null when we never got a contract
// error back.
export class CatalogueError extends Error {
  override name = "CatalogueError";
  constructor(
    readonly code: string | null,
    message: string,
    // For name_taken: the ingredient that already has the name, and the name.
    readonly taken?: {
      ingredient: { id: number; name: string | null };
      name: { name: string; locale: string };
    },
  ) {
    super(message);
  }
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ res: Response; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new CatalogueError(
      null,
      "the request failed before a response arrived",
    );
  }
  if (res.status === 401) reportUnauthenticated();
  return { res, body: await res.json().catch(() => undefined) };
}

function failure(res: Response, body: unknown): CatalogueError {
  if (typeof body === "object" && body !== null) {
    const { error, message } = body as Record<string, unknown>;
    if (typeof error === "string") {
      return new CatalogueError(
        error,
        typeof message === "string" ? message : `HTTP ${res.status} ${error}`,
      );
    }
  }
  return new CatalogueError(
    null,
    `the server answered with HTTP ${res.status}`,
  );
}

// A search result, by the name it is shown by in the viewer's locale.
export interface IngredientHit {
  id: number;
  name: string;
  locale: string;
}

// The first page of GET /ingredients?q=, best first. Ingredients with no
// names have nothing to show and are left out.
export async function searchIngredients(
  q: string,
  signal?: AbortSignal,
): Promise<IngredientHit[]> {
  const { res, body } = await request(
    "GET",
    `/ingredients?q=${encodeURIComponent(q)}`,
    undefined,
    signal,
  );
  if (!res.ok) throw failure(res, body);
  const { ingredients } = (body ?? {}) as { ingredients?: unknown };
  if (!Array.isArray(ingredients)) {
    throw new CatalogueError(null, "its response was not a search result");
  }
  return ingredients.flatMap((hit: Record<string, unknown>) =>
    typeof hit?.id === "number" &&
    typeof hit.name === "string" &&
    typeof hit.locale === "string"
      ? [{ id: hit.id, name: hit.name, locale: hit.locale }]
      : [],
  );
}

// An ingredient as GET /ingredients/:id and the create's 201 return it:
// names by locale, the canonical name first in each.
export interface Ingredient {
  id: number;
  category: string | null;
  names: { name: string; locale: string; isCanonical: boolean }[];
}

function isIngredient(body: unknown): body is Ingredient {
  if (typeof body !== "object" || body === null) return false;
  const { id, names } = body as Record<string, unknown>;
  return typeof id === "number" && Array.isArray(names);
}

// POST /ingredients. A name already in the catalogue in its locale is a
// CatalogueError with code name_taken and `taken` set when the api says
// which ingredient has it.
export async function createIngredient(input: {
  names: { name: string; locale: string }[];
  category: string | null;
}): Promise<Ingredient> {
  const { res, body } = await request("POST", "/ingredients", input);
  if (res.status === 201) {
    if (isIngredient(body)) return body;
    throw new CatalogueError(null, "its response was not an ingredient");
  }
  const error = failure(res, body);
  if (error.code === "name_taken") {
    const { ingredient, name } = (body ?? {}) as Record<string, unknown>;
    const taken =
      typeof ingredient === "object" &&
      ingredient !== null &&
      typeof (ingredient as { id?: unknown }).id === "number" &&
      typeof name === "object" &&
      name !== null
        ? {
            ingredient: ingredient as { id: number; name: string | null },
            name: name as { name: string; locale: string },
          }
        : undefined;
    throw new CatalogueError(error.code, error.message, taken);
  }
  throw error;
}

export type MeasurementType = "mass" | "volume" | "count";

export interface Measurement {
  id: number;
  key: string | null;
  type: MeasurementType;
  names: {
    locale: string;
    name: string;
    abbreviation: string | null;
    isCanonical: boolean;
  }[];
}

export async function fetchMeasurements(
  signal?: AbortSignal,
): Promise<Measurement[]> {
  const { res, body } = await request(
    "GET",
    "/measurements",
    undefined,
    signal,
  );
  if (!res.ok) throw failure(res, body);
  const { measurements } = (body ?? {}) as { measurements?: unknown };
  if (!Array.isArray(measurements)) {
    throw new CatalogueError(null, "its response was not a list of units");
  }
  return measurements as Measurement[];
}

function sameLocale(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

// The name a unit is shown by to someone in `locale`: its canonical name
// there, else its canonical name in another locale (en-GB first), else any
// name it has. Null for a unit with no names at all.
export function unitName(unit: Measurement, locale: string) {
  const canonical = unit.names.filter((n) => n.isCanonical);
  return (
    canonical.find((n) => sameLocale(n.locale, locale)) ??
    canonical.find((n) => sameLocale(n.locale, "en-GB")) ??
    canonical[0] ??
    unit.names[0] ??
    null
  );
}

// How a recipe line shows its unit: the abbreviation in the user's locale
// when it has one ("tsp"), otherwise the unit's name ("clove"). Not
// pluralised: measurement_name has no plural.
export function unitAbbreviation(unit: Measurement, locale: string): string {
  const local = unit.names.filter((n) => sameLocale(n.locale, locale));
  const abbreviation =
    local.find((n) => n.isCanonical && n.abbreviation)?.abbreviation ??
    local.find((n) => n.abbreviation)?.abbreviation;
  return abbreviation ?? unitName(unit, locale)?.name ?? "";
}

export const UNIT_TYPES: { type: MeasurementType; label: string }[] = [
  { type: "mass", label: "Mass" },
  { type: "volume", label: "Volume" },
  { type: "count", label: "Count" },
];

// The units a picker offers, by type, each sorted by its label in the
// user's locale. The api's order within a type is not locale-aware, so it
// is not used. Units with no names are left out.
export function unitOptions(units: Measurement[], locale: string) {
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale);
  } catch {
    collator = new Intl.Collator();
  }
  return UNIT_TYPES.map(({ type, label }) => ({
    type,
    label,
    units: units
      .filter((unit) => unit.type === type)
      .flatMap((unit) => {
        const name = unitName(unit, locale);
        if (!name) return [];
        return [
          {
            id: unit.id,
            label:
              name.abbreviation && name.abbreviation !== name.name
                ? `${name.name} (${name.abbreviation})`
                : name.name,
          },
        ];
      })
      .sort((a, b) => collator.compare(a.label, b.label)),
  })).filter((group) => group.units.length > 0);
}
