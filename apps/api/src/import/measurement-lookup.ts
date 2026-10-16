import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { measurement, measurementName } from "../db/schema.js";
import { CUP_ML, type CupSize } from "./cup.js";

// Unit text to measurement rows, built once from measurement and
// measurement_name and passed to parseIngredientLine, which stays pure.
export interface MeasurementLookup {
  // Normalised name or abbreviation, any locale, to every measurement it
  // names. Locale is deliberately dropped: an import does not know the
  // page's locale reliably, and "cup" naming two rows is resolved by the
  // cup rules, not by locale.
  byName: ReadonlyMap<string, readonly number[]>;
  cup: Readonly<Record<CupSize, number>>;
  // measurement id to measurement.key, for the units that have one (the
  // system units the seed shipped).
  keys: ReadonlyMap<number, string>;
}

export interface MeasurementNameRow {
  measurementId: number;
  type: "mass" | "volume" | "count";
  factorToBase: string | null;
  name: string;
  abbreviation: string | null;
  key: string | null;
}

export function buildMeasurementLookup(
  rows: readonly MeasurementNameRow[],
): MeasurementLookup {
  const byName = new Map<string, number[]>();
  const keys = new Map<number, string>();
  for (const row of rows) {
    if (row.key !== null) keys.set(row.measurementId, row.key);
    for (const text of [row.name, row.abbreviation]) {
      if (text === null) continue;
      const key = normaliseUnit(text);
      const ids = byName.get(key) ?? [];
      if (!ids.includes(row.measurementId)) ids.push(row.measurementId);
      byName.set(key, ids);
    }
  }
  return {
    byName,
    cup: {
      cup_us: cupId(rows, "cup_us"),
      cup_metric: cupId(rows, "cup_metric"),
    },
    keys,
  };
}

// The cup rows are found by volume rather than by name, because their names
// differ by locale ("cup" is the metric cup in en-GB).
function cupId(rows: readonly MeasurementNameRow[], size: CupSize): number {
  const row = rows.find(
    (r) =>
      r.type === "volume" &&
      r.factorToBase !== null &&
      Number(r.factorToBase) === CUP_ML[size],
  );
  if (row === undefined) {
    throw new Error(
      `measurement lookup: no ${size} row (volume, factor_to_base ${CUP_ML[size]})`,
    );
  }
  return row.measurementId;
}

// Same normalisation as measurement_name.normalised_name: lowercase, trimmed,
// internal whitespace collapsed to one space.
export function normaliseUnit(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function loadMeasurementLookup(
  db: Pick<Database["db"], "select">,
): Promise<MeasurementLookup> {
  const rows = await db
    .select({
      measurementId: measurementName.measurementId,
      type: measurement.type,
      factorToBase: measurement.factorToBase,
      name: measurementName.name,
      abbreviation: measurementName.abbreviation,
      key: measurement.key,
    })
    .from(measurementName)
    .innerJoin(measurement, eq(measurement.id, measurementName.measurementId));
  return buildMeasurementLookup(rows);
}
