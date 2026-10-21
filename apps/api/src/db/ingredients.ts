import { and, asc, count, eq, sql, type SQL } from "drizzle-orm";
import {
  lockActor,
  type Actor,
  type Db,
  type Profile,
} from "../auth/accounts.js";
import {
  ingredient,
  ingredientName,
  normalised,
  recipeIngredient,
} from "./schema.js";

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

// The name an ingredient is shown by to someone whose locale is `locale`,
// by how close its locale is (for en-GB): en-GB itself, then bare en, then
// another en-* by locale code, then any other locale. Within each, a
// canonical name goes first, so the last step is any canonical name, then
// any name. So an en-GB user never sees a German name while an English one
// exists. A lateral subquery over `i`, with columns name, locale and
// normalised_name, or no row for an ingredient with no names.
export function displayName(locale: string): SQL {
  const language = sql`lower(split_part(${locale}, '-', 1))`;
  return sql`
    select n.name, n.locale, n.normalised_name
    from ingredient_name n
    where n.ingredient_id = i.id
    order by
      case
        when lower(n.locale) = lower(${locale}) then 0
        when lower(n.locale) = ${language} then 1
        when lower(split_part(n.locale, '-', 1)) = ${language} then 2
        else 3
      end,
      n.is_canonical desc, n.locale, n.id
    limit 1
  `;
}

// The creator or an admin. Computed here so a client never re-implements it,
// and the one check every change to an ingredient makes (changeIngredient).
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
// The most names one ingredient may have, given on create or added since.
// Real ingredients have a handful.
export const MAX_NAMES = 20;
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
  // Null when the name that clashed cannot be found: deleted since, or
  // stored differently from how the lookup compares it. Still a clash.
  | { taken: TakenName | null }
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
  if (taken) return { taken };
  return (await repeatsItself(db, input.names))
    ? { repeated: true }
    : { taken: null };
}

// The new names as rows (name, locale, position), each sent as an ordinary
// text parameter, so Postgres sees exactly the text the insert stored: pg
// sends a lone surrogate as U+FFFD, where a jsonb cast refuses it (NATG-350).
function requested(names: NewIngredient["names"]): SQL {
  const column = (pick: (n: NewIngredient["names"][number]) => string) =>
    sql`array[${sql.join(
      names.map((n) => sql`${pick(n)}`),
      sql`, `,
    )}]::text[]`;
  return sql`unnest(${column((n) => n.name)}, ${column((n) => n.locale)})
    with ordinality as r(name, locale, position)`;
}

// Whether two of the names are one name in one locale once normalised.
async function repeatsItself(
  db: Db,
  names: NewIngredient["names"],
): Promise<boolean> {
  const { rows } = await db.execute<{ repeats: boolean }>(sql`
    select count(*) > count(distinct (r.locale, ${normalised(sql`r.name`)}))
      as repeats
    from ${requested(names)}
  `);
  return rows[0]?.repeats ?? false;
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
    from ${requested(names)}
    join ingredient_name n
      on n.locale = r.locale and n.normalised_name = ${normalised(sql`r.name`)}
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

// Why a change to an ingredient was refused before anything was written:
// the actor may no longer act at all (signed out, disabled), there is no
// such ingredient, or the actor may not change it.
export type EditRefusal = {
  refused: "unauthenticated" | "not_found" | "forbidden";
};

// Runs `change` in a transaction if the actor may still act (lockActor),
// there is an ingredient `id`, and the actor may change it by
// canEditIngredient: the rule canEdit reports, reading created_by only, and
// the actor's role as committed now, not as it was when the request
// arrived (SEC-1). `change` gets that live profile as the editor.
//
// The actor's user row is locked first, then the ingredient's: the only
// order in use, so this cannot deadlock with asAdmin. The ingredient lock
// makes changes to one ingredient run one at a time (two canonical swaps in
// a locale cannot interleave, two adds cannot both take the last free name),
// and a recipe line cannot start using an ingredient that is being deleted:
// its foreign key check waits for the lock.
async function changeIngredient<T>(
  db: Db,
  actor: Actor,
  id: number,
  change: (tx: Db, editor: Profile) => Promise<T>,
): Promise<EditRefusal | T> {
  return db.transaction(async (tx) => {
    const editor = await lockActor(tx, actor);
    if (!editor) return { refused: "unauthenticated" } as const;
    const [row] = await tx
      .select({ createdBy: ingredient.createdBy })
      .from(ingredient)
      .where(eq(ingredient.id, id))
      .for("update");
    if (!row) return { refused: "not_found" } as const;
    if (!canEditIngredient(editor, row.createdBy)) {
      return { refused: "forbidden" } as const;
    }
    return change(tx, editor);
  });
}

// The ingredient as GET /ingredients/:id returns it, after a change to it in
// the same transaction.
async function changed(
  tx: Db,
  viewer: Profile,
  id: number,
): Promise<{ changed: IngredientDetail }> {
  const found = await findIngredient(tx, viewer, id);
  if (!found) throw new Error(`changed ingredient ${id} not found`);
  return { changed: found };
}

export async function setIngredientCategory(
  db: Db,
  actor: Actor,
  id: number,
  category: string | null,
): Promise<EditRefusal | { changed: IngredientDetail }> {
  return changeIngredient(db, actor, id, async (tx, editor) => {
    await tx.update(ingredient).set({ category }).where(eq(ingredient.id, id));
    return changed(tx, editor, id);
  });
}

// Adds a name as the editor's, source 'user'. It is canonical if the
// ingredient has no canonical name in its locale yet, as the first name in
// a locale is on create. A name already in the catalogue in its locale is
// not added, and the outcome names it, so a retry of an add that succeeded
// finds this ingredient, even once that add filled the ingredient. Nor is
// a name added to an ingredient that has MAX_NAMES already (SEC-2): counted
// under the ingredient lock, so simultaneous adds cannot pass it.
export async function addIngredientName(
  db: Db,
  actor: Actor,
  id: number,
  name: { name: string; locale: string },
): Promise<
  | EditRefusal
  | { changed: IngredientDetail }
  | { taken: TakenName | null }
  | { nameLimit: true }
> {
  return changeIngredient(db, actor, id, async (tx, editor) => {
    const [{ names } = { names: 0 }] = await tx
      .select({ names: count() })
      .from(ingredientName)
      .where(eq(ingredientName.ingredientId, id));
    if (names >= MAX_NAMES) {
      const taken = await findTakenName(tx, editor, [name]);
      return taken ? { taken } : ({ nameLimit: true } as const);
    }
    const [canonical] = await tx
      .select({ id: ingredientName.id })
      .from(ingredientName)
      .where(
        and(
          eq(ingredientName.ingredientId, id),
          eq(ingredientName.locale, name.locale),
          eq(ingredientName.isCanonical, true),
        ),
      );
    const inserted = await tx
      .insert(ingredientName)
      .values({
        ingredientId: id,
        ...name,
        isCanonical: !canonical,
        source: "user",
        createdBy: editor.id,
      })
      .onConflictDoNothing()
      .returning({ id: ingredientName.id });
    if (inserted.length === 0) {
      return { taken: await findTakenName(tx, editor, [name]) };
    }
    return changed(tx, editor, id);
  });
}

// A change to one name: new text, and or making it the canonical name in
// its locale. A name cannot be made not canonical: making another canonical
// does that, and a locale is never left without one that way.
export interface NameChange {
  name?: string;
  isCanonical?: true;
}

// Whether `err` is Postgres refusing a write for breaking `constraint`.
function violates(err: unknown, constraint: string): boolean {
  const cause = err instanceof Error ? err.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505" &&
    (cause as { constraint?: unknown }).constraint === constraint
  );
}

// Renaming to a name already in the catalogue in the name's locale (another
// of this ingredient's, too) changes nothing, and the outcome names it.
export async function changeIngredientName(
  db: Db,
  actor: Actor,
  id: number,
  nameId: number,
  change: NameChange,
): Promise<
  | EditRefusal
  | { changed: IngredientDetail }
  | { taken: TakenName | null }
  | { nameNotFound: true }
> {
  return changeIngredient(db, actor, id, async (tx, editor) => {
    const [row] = await tx
      .select({
        locale: ingredientName.locale,
        isCanonical: ingredientName.isCanonical,
      })
      .from(ingredientName)
      .where(
        and(eq(ingredientName.id, nameId), eq(ingredientName.ingredientId, id)),
      );
    if (!row) return { nameNotFound: true } as const;
    if (change.name !== undefined) {
      const name = change.name;
      try {
        // A savepoint, so a clash leaves the transaction usable to find
        // the name it clashed with.
        await tx.transaction((sp) =>
          sp
            .update(ingredientName)
            .set({ name })
            .where(eq(ingredientName.id, nameId)),
        );
      } catch (err) {
        if (!violates(err, "ingredient_name_locale_name_key")) throw err;
        return {
          taken: await findTakenName(tx, editor, [
            { name, locale: row.locale },
          ]),
        };
      }
    }
    if (change.isCanonical && !row.isCanonical) {
      // Unset, then set: ingredient_name_canonical_key is checked row by
      // row, so one statement swapping both could see two at once.
      await tx
        .update(ingredientName)
        .set({ isCanonical: false })
        .where(
          and(
            eq(ingredientName.ingredientId, id),
            eq(ingredientName.locale, row.locale),
            eq(ingredientName.isCanonical, true),
          ),
        );
      await tx
        .update(ingredientName)
        .set({ isCanonical: true })
        .where(eq(ingredientName.id, nameId));
    }
    return changed(tx, editor, id);
  });
}

// Deletes one name. An ingredient's last name is kept: an ingredient no one
// can find or read is no use. A canonical name passes canonical to another
// name in its locale, if there is one, by name order as findIngredient
// lists them.
export async function deleteIngredientName(
  db: Db,
  actor: Actor,
  id: number,
  nameId: number,
): Promise<
  EditRefusal | { deleted: true } | { lastName: true } | { nameNotFound: true }
> {
  return changeIngredient(db, actor, id, async (tx) => {
    const names = await tx
      .select({
        id: ingredientName.id,
        locale: ingredientName.locale,
        isCanonical: ingredientName.isCanonical,
      })
      .from(ingredientName)
      .where(eq(ingredientName.ingredientId, id))
      .orderBy(asc(ingredientName.normalisedName), asc(ingredientName.id));
    const target = names.find((n) => n.id === nameId);
    if (!target) return { nameNotFound: true } as const;
    if (names.length === 1) return { lastName: true } as const;
    await tx.delete(ingredientName).where(eq(ingredientName.id, nameId));
    const heir = target.isCanonical
      ? names.find((n) => n.id !== nameId && n.locale === target.locale)
      : undefined;
    if (heir) {
      await tx
        .update(ingredientName)
        .set({ isCanonical: true })
        .where(eq(ingredientName.id, heir.id));
    }
    return { deleted: true } as const;
  });
}

// Deletes the ingredient and its names, unless a recipe line uses it.
// Checked first rather than left to recipe_ingredient's restrict, whose
// error says nothing a client can act on.
export async function deleteIngredient(
  db: Db,
  actor: Actor,
  id: number,
): Promise<EditRefusal | { deleted: true } | { inUse: true }> {
  return changeIngredient(db, actor, id, async (tx) => {
    const [used] = await tx
      .select({ id: recipeIngredient.id })
      .from(recipeIngredient)
      .where(eq(recipeIngredient.ingredientId, id))
      .limit(1);
    if (used) return { inUse: true } as const;
    await tx.delete(ingredient).where(eq(ingredient.id, id));
    return { deleted: true } as const;
  });
}
