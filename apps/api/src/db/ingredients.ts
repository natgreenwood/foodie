import { asc, eq, sql, type SQL } from "drizzle-orm";
import type { Db, Profile } from "../auth/accounts.js";
import { ingredient, ingredientName, normalised } from "./schema.js";

// The shared ingredient catalogue (NATG-210). Every signed-in user sees every
// ingredient; created_by says who may change one. Seeded rows have none and
// only an admin may change them.

// How a name is scored against a search text. `similarity` compares the whole
// name, so a typo still matches. `word_similarity` compares the text with the
// best-matching run of the name's words, so a prefix (`cor` for `coriander`)
// matches too. The trigram GIN index on normalised_name serves both.
export type NameScore = "similarity" | "word_similarity";

const thresholdSetting: Record<NameScore, string> = {
  similarity: "pg_trgm.similarity_threshold",
  word_similarity: "pg_trgm.word_similarity_threshold",
};

// The index is only used through the operators, `%` and `<%`, which compare
// against a pg_trgm setting. Sets it for the current transaction only, so a
// different server default cannot drop matches.
export async function setNameScoreThreshold(
  tx: Db,
  score: NameScore,
  threshold: number,
): Promise<void> {
  await tx.execute(
    sql`select set_config(${thresholdSetting[score]}, ${String(threshold)}, true)`,
  );
}

// A subquery: the ingredients with a name scoring strictly above `threshold`
// against `text` (already normalised), one row each for its best name, with
// columns ingredient_id, name, locale, similarity (the score) and
// same_locale. A name in `locale` goes ahead of one with the same score in
// another; no locale is left out. For word_similarity, names that tie (`oil`
// and `vegetable oil` both contain `oil` whole) go by whole-name similarity,
// which is also a column, name_similarity. Run after setNameScoreThreshold
// for the same score, in the same transaction.
export function bestNamePerIngredient(
  text: SQL,
  locale: string,
  score: NameScore,
  threshold: number,
): SQL {
  const whole = sql`similarity(n.normalised_name, ${text})`;
  const [matches, value, tieBreak] =
    score === "similarity"
      ? [sql`n.normalised_name % ${text}`, whole, null]
      : [
          sql`${text} <% n.normalised_name`,
          sql`word_similarity(${text}, n.normalised_name)`,
          whole,
        ];
  return sql`
    select distinct on (n.ingredient_id) n.ingredient_id, n.name, n.locale,
      ${value} as similarity, n.locale = ${locale} as same_locale
      ${tieBreak ? sql`, ${tieBreak} as name_similarity` : sql``}
    from ingredient_name n
    where ${matches} and ${value} > ${threshold}
    order by n.ingredient_id, ${value} desc,
      ${tieBreak ? sql`${tieBreak} desc,` : sql``}
      n.locale = ${locale} desc, n.id
  `;
}

// The name an ingredient is shown by to someone whose locale is `locale`:
// its canonical name there, else any canonical name, else any name. A lateral
// subquery over `i`, with columns name, locale and normalised_name, or no row
// for an ingredient with no names.
function displayName(locale: string): SQL {
  return sql`
    select n.name, n.locale, n.normalised_name
    from ingredient_name n
    where n.ingredient_id = i.id
    order by n.is_canonical and n.locale = ${locale} desc, n.is_canonical desc,
      n.locale, n.id
    limit 1
  `;
}

// The creator or an admin. Computed here so a client never re-implements it.
export function canEditIngredient(
  viewer: Pick<Profile, "id" | "isAdmin">,
  createdBy: number | null,
): boolean {
  return viewer.isAdmin || (createdBy !== null && createdBy === viewer.id);
}

// An ingredient in a list or search page. `name` and `locale` are its display
// name (see displayName); null only for an ingredient with no names.
export interface IngredientSummary {
  id: number;
  name: string | null;
  locale: string | null;
  category: string | null;
  source: string | null;
  canEdit: boolean;
}

// A search result: the ingredient, and the name of it that matched best.
export interface IngredientSearchHit extends IngredientSummary {
  match: { name: string; locale: string; similarity: number };
}

export interface IngredientPage<T> {
  ingredients: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export const PAGE_SIZE = 25;
// A word_similarity a name must beat to be a search hit: pg_trgm's default.
// `cor` scores 0.75 against `coriander` and `corriander` 0.82; one letter
// scores 0.5 against everything that starts with it, so it finds nothing.
export const SEARCH_THRESHOLD = 0.6;

export interface ListQuery {
  page: number;
  // Only rows with source = 'user'.
  userAdded: boolean;
}

interface SummaryRow extends Record<string, unknown> {
  id: number | string;
  category: string | null;
  source: string | null;
  created_by: number | string | null;
  display_name: string | null;
  display_locale: string | null;
}

function summary(viewer: Profile, row: SummaryRow): IngredientSummary {
  const createdBy = row.created_by === null ? null : Number(row.created_by);
  return {
    id: Number(row.id),
    name: row.display_name,
    locale: row.display_locale,
    category: row.category,
    source: row.source,
    canEdit: canEditIngredient(viewer, createdBy),
  };
}

// One more row than the page holds says whether there is a next page.
function paged<T>(rows: T[], page: number): IngredientPage<T> {
  return {
    ingredients: rows.slice(0, PAGE_SIZE),
    page,
    pageSize: PAGE_SIZE,
    hasMore: rows.length > PAGE_SIZE,
  };
}

function userAddedFilter(userAdded: boolean): SQL {
  return userAdded ? sql`i.source = 'user'` : sql`true`;
}

// Every ingredient, by display name (normalised, so case does not split
// them), ingredients with no names last.
export async function listIngredients(
  db: Db,
  viewer: Profile,
  { page, userAdded }: ListQuery,
): Promise<IngredientPage<IngredientSummary>> {
  const { rows } = await db.execute<SummaryRow>(sql`
    select i.id, i.category, i.source, i.created_by,
      d.name as display_name, d.locale as display_locale
    from ingredient i
    left join lateral (${displayName(viewer.locale)}) d on true
    where ${userAddedFilter(userAdded)}
    order by d.normalised_name nulls last, i.id
    limit ${PAGE_SIZE + 1} offset ${(page - 1) * PAGE_SIZE}
  `);
  return paged(
    rows.map((row) => summary(viewer, row)),
    page,
  );
}

// Ingredients with a name in any locale like `text`, best first: by the
// word_similarity of their best name, then its whole-name similarity (so
// `oil` ranks the ingredient named oil above olive oil, which both contain
// it whole), then a name in the viewer's locale, then that name. `text` is
// normalised as normalised_name is, in SQL.
export async function searchIngredients(
  db: Db,
  viewer: Profile,
  text: string,
  { page, userAdded }: ListQuery,
): Promise<IngredientPage<IngredientSearchHit>> {
  const rows = await db.transaction(async (tx) => {
    await setNameScoreThreshold(tx, "word_similarity", SEARCH_THRESHOLD);
    const { rows } = await tx.execute<
      SummaryRow & {
        match_name: string;
        match_locale: string;
        similarity: number;
      }
    >(sql`
      select i.id, i.category, i.source, i.created_by,
        d.name as display_name, d.locale as display_locale,
        best.name as match_name, best.locale as match_locale, best.similarity
      from (select ${normalised(sql`${text}::text`)} as text) q
      cross join lateral (
        ${bestNamePerIngredient(sql`q.text`, viewer.locale, "word_similarity", SEARCH_THRESHOLD)}
      ) best
      join ingredient i on i.id = best.ingredient_id
      left join lateral (${displayName(viewer.locale)}) d on true
      where ${userAddedFilter(userAdded)}
      order by best.similarity desc, best.name_similarity desc,
        best.same_locale desc, best.name, i.id
      limit ${PAGE_SIZE + 1} offset ${(page - 1) * PAGE_SIZE}
    `);
    return rows;
  });
  return paged(
    rows.map((row) => ({
      ...summary(viewer, row),
      match: {
        name: row.match_name,
        locale: row.match_locale,
        similarity: row.similarity,
      },
    })),
    page,
  );
}

export interface IngredientDetail {
  id: number;
  category: string | null;
  source: string | null;
  canEdit: boolean;
  // By locale, the canonical name first in each.
  names: { id: number; name: string; locale: string; isCanonical: boolean }[];
}

// The ingredient with all its names, or null if there is none with this id.
export async function findIngredient(
  db: Db,
  viewer: Profile,
  id: number,
): Promise<IngredientDetail | null> {
  const [row] = await db
    .select({
      id: ingredient.id,
      category: ingredient.category,
      source: ingredient.source,
      createdBy: ingredient.createdBy,
    })
    .from(ingredient)
    .where(eq(ingredient.id, id));
  if (!row) return null;
  const names = await db
    .select({
      id: ingredientName.id,
      name: ingredientName.name,
      locale: ingredientName.locale,
      isCanonical: ingredientName.isCanonical,
    })
    .from(ingredientName)
    .where(eq(ingredientName.ingredientId, id))
    .orderBy(
      asc(ingredientName.locale),
      sql`${ingredientName.isCanonical} desc`,
      asc(ingredientName.normalisedName),
      asc(ingredientName.id),
    );
  return {
    id: row.id,
    category: row.category,
    source: row.source,
    canEdit: canEditIngredient(viewer, row.createdBy),
    names,
  };
}

export interface NewIngredient {
  // Locales in canonical form. The first name in each locale is canonical.
  names: { name: string; locale: string }[];
  category: string | null;
}

// An existing name that a new ingredient's name clashes with, and the
// ingredient it belongs to, by its display name.
export interface TakenName {
  ingredient: { id: number; name: string | null };
  name: { name: string; locale: string };
}

export type CreateOutcome =
  | { created: IngredientDetail }
  | { taken: TakenName }
  // Two of the new names are the same name in the same locale.
  | { repeated: true };

class NameClash extends Error {}

// Creates the ingredient and its names as the creator's, source 'user'. All
// or nothing: if any name is already in the catalogue in its locale, nothing
// is written and the outcome names the first such name, in request order.
// The same holds for a concurrent create of the same name, and for a retry
// of a create that succeeded, which finds its own names.
export async function createIngredient(
  db: Db,
  creator: Profile,
  input: NewIngredient,
): Promise<CreateOutcome> {
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(ingredient)
        .values({
          category: input.category,
          source: "user",
          createdBy: creator.id,
        })
        .returning({ id: ingredient.id });
      if (!row) throw new Error("ingredient insert returned no row");
      const locales = new Set<string>();
      const values = input.names.map(({ name, locale }) => {
        const isCanonical = !locales.has(locale);
        locales.add(locale);
        return {
          ingredientId: row.id,
          name,
          locale,
          isCanonical,
          source: "user",
          createdBy: creator.id,
        };
      });
      // Skips a name that clashes with one already there, or with an
      // earlier name in the same insert, rather than failing the statement.
      const inserted = await tx
        .insert(ingredientName)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: ingredientName.id });
      if (inserted.length < values.length) throw new NameClash();
      return row.id;
    });
    const created = await findIngredient(db, creator, id);
    if (!created) throw new Error(`created ingredient ${id} not found`);
    return { created };
  } catch (err) {
    if (!(err instanceof NameClash)) throw err;
  }
  const taken = await findTakenName(db, creator, input.names);
  return taken ? { taken } : { repeated: true };
}

async function findTakenName(
  db: Db,
  viewer: Profile,
  names: NewIngredient["names"],
): Promise<TakenName | null> {
  const { rows } = await db.execute<{
    ingredient_id: number | string;
    name: string;
    locale: string;
    display_name: string | null;
  }>(sql`
    select i.id as ingredient_id, n.name, n.locale, d.name as display_name
    from jsonb_array_elements(${JSON.stringify(names)}::jsonb)
      with ordinality as r(value, position)
    join ingredient_name n
      on n.locale = r.value->>'locale'
      and n.normalised_name = ${normalised(sql`(r.value->>'name')`)}
    join ingredient i on i.id = n.ingredient_id
    left join lateral (${displayName(viewer.locale)}) d on true
    order by r.position
    limit 1
  `);
  const [row] = rows;
  if (!row) return null;
  return {
    ingredient: { id: Number(row.ingredient_id), name: row.display_name },
    name: { name: row.name, locale: row.locale },
  };
}
