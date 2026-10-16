import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { measurement, measurementName } from "../db/schema.js";

// The preview contract names a unit by a stable key ("cup_us") next to its
// id. The keys are the seed's (drizzle/0001_seed_measurement_units.sql), but
// the seed does not store them, so the system units are found here by their
// canonical en-GB name, which the seed gave each one. A unit created later,
// or a system unit whose en-GB name was edited, has no key.
const KEY_BY_GB_NAME: ReadonlyMap<string, string> = new Map([
  ["gram", "gram"],
  ["kilogram", "kilogram"],
  ["ounce", "ounce"],
  ["pound", "pound"],
  ["millilitre", "millilitre"],
  ["litre", "litre"],
  ["teaspoon", "teaspoon"],
  ["tablespoon", "tablespoon"],
  ["US cup", "cup_us"],
  ["cup", "cup_metric"],
  ["US fluid ounce", "fl_oz_us"],
  ["fluid ounce", "fl_oz_imperial"],
  ["US pint", "pint_us"],
  ["pint", "pint_imperial"],
  ["US quart", "quart_us"],
  ["each", "each"],
  ["clove", "clove"],
  ["pinch", "pinch"],
  ["dash", "dash"],
  ["slice", "slice"],
  ["tin", "can"],
  ["bunch", "bunch"],
  ["sprig", "sprig"],
  ["handful", "handful"],
  ["packet", "packet"],
]);

// measurement id to seed key, for the system units.
export async function loadUnitKeys(
  db: Pick<Database["db"], "select">,
): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: measurementName.measurementId, name: measurementName.name })
    .from(measurementName)
    .innerJoin(measurement, eq(measurement.id, measurementName.measurementId))
    .where(
      and(
        eq(measurement.isSystem, true),
        eq(measurementName.locale, "en-GB"),
        eq(measurementName.isCanonical, true),
      ),
    );
  const keys = new Map<number, string>();
  for (const { id, name } of rows) {
    const key = KEY_BY_GB_NAME.get(name);
    if (key !== undefined) keys.set(id, key);
  }
  return keys;
}
