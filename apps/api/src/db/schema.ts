// Drizzle table definitions live here. Run `pnpm db:generate` after changing
// this file to create a migration in ./drizzle.
import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Lowercase, trimmed, internal whitespace (spaces, tabs, newlines) collapsed
// to one space. Used for the per-locale uniqueness of names; accents are kept.
function normalised(column: AnyPgColumn): SQL {
  return sql`lower(btrim(regexp_replace(${column}, '\\s+', ' ', 'g')))`;
}

// Quantities only add up within a type: millilitres to grams needs the
// ingredient's density, which the database does not know.
export const measurementType = pgEnum("measurement_type", [
  "mass",
  "volume",
  "count",
]);

// One row per unit of measure. `id` is the MeasurementID recipe lines
// reference. Names are per locale, in measurement_name.
export const measurement = pgTable(
  "measurement",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    type: measurementType("type").notNull(),
    // How many of the type's base unit (gram, millilitre) one of this unit
    // is: kilogram is 1000. Null for count units, which have no base unit:
    // they only sum with quantities of the same measurement.
    factorToBase: numeric("factor_to_base"),
    // Shipped by migration rather than created by a user. Nothing here stops
    // a system unit being edited or deleted; that is application behaviour.
    isSystem: boolean("is_system").notNull().default(false),
    // A stable name for a system unit that code can refer to ("cup_us"), the
    // seed's key. Null for a unit a user creates.
    key: text("key"),
  },
  (t) => [
    uniqueIndex("measurement_key_key").on(t.key),
    // Postgres sorts NaN above Infinity above every number, so `> 0` alone
    // accepts both, and either one turns any sum it is part of into NaN.
    check(
      "measurement_factor_to_base_positive",
      sql`${t.factorToBase} > 0 AND ${t.factorToBase} < 'Infinity'`,
    ),
  ],
);

// Every name and abbreviation a unit is shown or found by, tagged with a
// BCP-47 locale, because both spelling and meaning vary by region: `cup` is
// 236.6 ml in en-US and 250 ml in en-AU. Plurals are left to the UI.
export const measurementName = pgTable(
  "measurement_name",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    measurementId: bigint("measurement_id", { mode: "number" })
      .notNull()
      .references(() => measurement.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalisedName: text("normalised_name")
      .notNull()
      .generatedAlwaysAs((): SQL => normalised(measurementName.name)),
    // Nullable: count units such as clove have none, and a second name for a
    // unit in the same locale cannot repeat the first name's abbreviation.
    abbreviation: text("abbreviation"),
    normalisedAbbreviation: text("normalised_abbreviation").generatedAlwaysAs(
      (): SQL => normalised(measurementName.abbreviation),
    ),
    locale: text("locale").notNull(),
    isCanonical: boolean("is_canonical").notNull().default(false),
  },
  (t) => [
    uniqueIndex("measurement_name_locale_name_key").on(
      t.locale,
      t.normalisedName,
    ),
    uniqueIndex("measurement_name_locale_abbreviation_key").on(
      t.locale,
      t.normalisedAbbreviation,
    ),
    // One canonical (display) name per unit per locale.
    uniqueIndex("measurement_name_canonical_key")
      .on(t.measurementId, t.locale)
      .where(sql`${t.isCanonical}`),
    // Serves the join from measurement and the cascade on delete.
    index("measurement_name_measurement_id_idx").on(t.measurementId),
    check("measurement_name_name_not_blank", sql`${t.normalisedName} <> ''`),
    check(
      "measurement_name_abbreviation_not_blank",
      sql`${t.normalisedAbbreviation} <> ''`,
    ),
  ],
);

// One row per real-world ingredient. `id` is the IngredientID recipe lines
// reference. Region-neutral attributes only; names are per locale, in
// ingredient_name.
export const ingredient = pgTable("ingredient", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  // Free text for now; a lookup table can come with shopping-list aisles.
  category: text("category"),
  // Provenance, for example seed, user or import.
  source: text("source"),
});

// Every name an ingredient is found by, tagged with a BCP-47 locale: the same
// text can mean different ingredients by region (`biscuit` in en-GB and
// en-US), and one ingredient has many names (`coriander`, `cilantro`).
export const ingredientName = pgTable(
  "ingredient_name",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    ingredientId: bigint("ingredient_id", { mode: "number" })
      .notNull()
      .references(() => ingredient.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalisedName: text("normalised_name")
      .notNull()
      .generatedAlwaysAs((): SQL => normalised(ingredientName.name)),
    locale: text("locale").notNull(),
    isCanonical: boolean("is_canonical").notNull().default(false),
    source: text("source"),
  },
  (t) => [
    // Serves exact lookup by locale and normalised name.
    uniqueIndex("ingredient_name_locale_name_key").on(
      t.locale,
      t.normalisedName,
    ),
    // Serves fuzzy candidate search (similarity, %, ILIKE '%term%') across
    // locales. Needs pg_trgm, which the migration enables by hand.
    index("ingredient_name_normalised_name_trgm_idx").using(
      "gin",
      t.normalisedName.op("gin_trgm_ops"),
    ),
    // One canonical (display) name per ingredient per locale.
    uniqueIndex("ingredient_name_canonical_key")
      .on(t.ingredientId, t.locale)
      .where(sql`${t.isCanonical}`),
    // Serves the join from ingredient and the cascade on delete.
    index("ingredient_name_ingredient_id_idx").on(t.ingredientId),
    check("ingredient_name_name_not_blank", sql`${t.normalisedName} <> ''`),
  ],
);

// One recipe, imported from a URL or entered by hand. There is no owner yet:
// auth adds owner_id in its own migration. source_url is not unique, so
// importing the same page twice gives two recipes.
export const recipe = pgTable(
  "recipe",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    sourceUrl: text("source_url"),
    servings: integer("servings"),
    prepMinutes: integer("prep_minutes"),
    cookMinutes: integer("cook_minutes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set on insert only; whatever updates a recipe sets it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("recipe_title_not_blank", sql`${normalised(t.title)} <> ''`),
    check("recipe_servings_positive", sql`${t.servings} > 0`),
    check("recipe_prep_minutes_not_negative", sql`${t.prepMinutes} >= 0`),
    check("recipe_cook_minutes_not_negative", sql`${t.cookMinutes} >= 0`),
  ],
);

// One ingredient line of a recipe, in `position` order. "Salt to taste" is a
// line with notes and no measurement or quantity. The same ingredient may
// appear on several lines. Catalogue rows a line uses cannot be deleted.
export const recipeIngredient = pgTable(
  "recipe_ingredient",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    recipeId: bigint("recipe_id", { mode: "number" })
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    ingredientId: bigint("ingredient_id", { mode: "number" })
      .notNull()
      .references(() => ingredient.id, { onDelete: "restrict" }),
    measurementId: bigint("measurement_id", { mode: "number" }).references(
      () => measurement.id,
      { onDelete: "restrict" },
    ),
    // A single amount: ½ is 0.5, and "2 to 3" stores 2 with the range in
    // notes, so lines can be summed through measurement.factor_to_base.
    quantity: numeric("quantity"),
    // Modifiers such as crushed or diced.
    prepNotes: text("prep_notes"),
    notes: text("notes"),
  },
  (t) => [
    // Also serves the join from recipe and the cascade on delete.
    uniqueIndex("recipe_ingredient_recipe_position_key").on(
      t.recipeId,
      t.position,
    ),
    // Serve the restrict check when an ingredient or measurement is deleted.
    index("recipe_ingredient_ingredient_id_idx").on(t.ingredientId),
    index("recipe_ingredient_measurement_id_idx").on(t.measurementId),
    // Finite as well as positive: see measurement_factor_to_base_positive.
    check(
      "recipe_ingredient_quantity_positive",
      sql`${t.quantity} > 0 AND ${t.quantity} < 'Infinity'`,
    ),
  ],
);

// One method step of a recipe, in `position` order.
export const recipeStep = pgTable(
  "recipe_step",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    recipeId: bigint("recipe_id", { mode: "number" })
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    // Also serves the join from recipe and the cascade on delete.
    uniqueIndex("recipe_step_recipe_position_key").on(t.recipeId, t.position),
    check("recipe_step_text_not_blank", sql`${normalised(t.text)} <> ''`),
  ],
);

// Free-text tags such as high-protein or gluten-free; there is no catalogue.
// Keyed on the normalised tag, so `High-Protein` and ` high-protein ` cannot
// both be on one recipe.
export const recipeTag = pgTable(
  "recipe_tag",
  {
    recipeId: bigint("recipe_id", { mode: "number" })
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    normalisedTag: text("normalised_tag")
      .notNull()
      .generatedAlwaysAs((): SQL => normalised(recipeTag.tag)),
  },
  (t) => [
    // Leads with recipe_id, so it also serves the join and the cascade.
    primaryKey({ columns: [t.recipeId, t.normalisedTag] }),
    // Serves finding recipes by tag.
    index("recipe_tag_normalised_tag_idx").on(t.normalisedTag),
    check("recipe_tag_tag_not_blank", sql`${t.normalisedTag} <> ''`),
  ],
);

// The last successful fetch of each page an import asked for, so a repeat
// within the cache lifetime does not hit the site again. Keyed on the
// normalised URL. Failed fetches are not stored. Nothing here is a recipe.
export const pageFetch = pgTable("page_fetch", {
  normalisedUrl: text("normalised_url").primaryKey(),
  // Where redirects ended.
  finalUrl: text("final_url").notNull(),
  status: integer("status").notNull(),
  // The FetchStrategy name that got the page, for example http or impit.
  strategy: text("strategy").notNull(),
  html: text("html").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});
