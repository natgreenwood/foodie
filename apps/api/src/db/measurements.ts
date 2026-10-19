import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../auth/accounts.js";
import { measurement, measurementName } from "./schema.js";

// One name or abbreviation a unit is shown by, in one locale.
export interface MeasurementNameEntry {
  locale: string;
  name: string;
  abbreviation: string | null;
  isCanonical: boolean;
}

// A unit as the api returns it: its id is the measurementId a recipe line
// takes (POST /imports), key is null for a unit a user created.
export interface Measurement {
  id: number;
  key: string | null;
  type: (typeof measurement.type.enumValues)[number];
  names: MeasurementNameEntry[];
}

// Every unit, with every name it has in every locale; a unit with no names
// still appears, with none. Units by type (mass, volume, count), then by
// the alphabetically first of their canonical names across locales, so the
// order does not favour one locale; a client showing one locale sorts by its
// own names. Names by locale, canonical first.
export async function listMeasurements(db: Db): Promise<Measurement[]> {
  const sortName = db
    .select({ name: sql`min(${measurementName.name})` })
    .from(measurementName)
    .where(
      and(
        eq(measurementName.measurementId, measurement.id),
        measurementName.isCanonical,
      ),
    );
  const rows = await db
    .select({
      id: measurement.id,
      key: measurement.key,
      type: measurement.type,
      locale: measurementName.locale,
      name: measurementName.name,
      abbreviation: measurementName.abbreviation,
      isCanonical: measurementName.isCanonical,
    })
    .from(measurement)
    .leftJoin(
      measurementName,
      eq(measurementName.measurementId, measurement.id),
    )
    .orderBy(
      asc(measurement.type),
      sql`(${sortName}) nulls last`,
      asc(measurement.id),
      asc(measurementName.locale),
      desc(measurementName.isCanonical),
      asc(measurementName.name),
    );

  const units: Measurement[] = [];
  for (const row of rows) {
    let unit = units.at(-1);
    if (unit?.id !== row.id) {
      unit = { id: row.id, key: row.key, type: row.type, names: [] };
      units.push(unit);
    }
    if (row.locale !== null && row.name !== null && row.isCanonical !== null) {
      unit.names.push({
        locale: row.locale,
        name: row.name,
        abbreviation: row.abbreviation,
        isCanonical: row.isCanonical,
      });
    }
  }
  return units;
}
