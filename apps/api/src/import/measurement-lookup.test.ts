import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { measurement, measurementName } from "../db/schema.js";
import { dbTest } from "../test/db.js";
import { loadMeasurementLookup } from "./measurement-lookup.js";

// The keys drizzle/0001_seed_measurement_units.sql gave the system units,
// which drizzle/0006_measurement_key.sql stores.
const SEED_KEYS = [
  "gram",
  "kilogram",
  "ounce",
  "pound",
  "millilitre",
  "litre",
  "teaspoon",
  "tablespoon",
  "cup_us",
  "cup_metric",
  "fl_oz_us",
  "fl_oz_imperial",
  "pint_us",
  "pint_imperial",
  "quart_us",
  "each",
  "clove",
  "pinch",
  "dash",
  "slice",
  "can",
  "bunch",
  "sprig",
  "handful",
  "packet",
];

describe("measurement.key", () => {
  dbTest("holds its seed key for every seeded unit", async ({ tx }) => {
    const rows = await tx
      .select({ key: measurement.key })
      .from(measurement)
      .where(eq(measurement.isSystem, true));

    expect(rows.map((r) => r.key).sort()).toEqual([...SEED_KEYS].sort());
  });

  dbTest("is null for a unit a user creates", async ({ tx }) => {
    const [row] = await tx
      .insert(measurement)
      .values({ type: "count" })
      .returning({ key: measurement.key });

    expect(row?.key).toBeNull();
  });

  dbTest("is unique", async ({ tx }) => {
    await expect(
      tx.transaction((sp) =>
        sp.insert(measurement).values({ type: "count", key: "cup_us" }),
      ),
    ).rejects.toMatchObject({ cause: { constraint: "measurement_key_key" } });
  });
});

describe("loadMeasurementLookup", () => {
  dbTest("reads every seeded unit's key from the table", async ({ tx }) => {
    const lookup = await loadMeasurementLookup(tx);

    expect([...lookup.keys.values()].sort()).toEqual([...SEED_KEYS].sort());
    expect(lookup.keys.get(lookup.cup.cup_us)).toBe("cup_us");
    expect(lookup.keys.get(lookup.cup.cup_metric)).toBe("cup_metric");
  });

  dbTest("finds a unit without a key but gives it none", async ({ tx }) => {
    const [row] = await tx
      .insert(measurement)
      .values({ type: "count" })
      .returning({ id: measurement.id });
    const id = row?.id ?? 0;
    await tx
      .insert(measurementName)
      .values({ measurementId: id, locale: "en-GB", name: "jar" });
    const lookup = await loadMeasurementLookup(tx);

    expect(lookup.byName.get("jar")).toEqual([id]);
    expect(lookup.keys.has(id)).toBe(false);
  });
});
