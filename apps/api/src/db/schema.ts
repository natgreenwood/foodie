// Drizzle table definitions live here. Run `pnpm db:generate` after changing
// this file to create a migration in ./drizzle.
import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
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
  },
  (t) => [
    check("measurement_factor_to_base_positive", sql`${t.factorToBase} > 0`),
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
