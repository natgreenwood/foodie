import { buildMeasurementLookup } from "../../measurement-lookup.js";

// A few of the seeded units (drizzle/0001_seed_measurement_units.sql) with
// their en-GB names (and en-US for the cups, which "cup" names both of),
// keyed as the seed keys them, and made-up ids.
export const UNIT = {
  gram: 1,
  tablespoon: 8,
  cupUs: 9,
  cupMetric: 10,
  clove: 17,
  handful: 24,
} as const;

export const measurements = buildMeasurementLookup([
  {
    measurementId: UNIT.gram,
    type: "mass",
    factorToBase: "1",
    name: "gram",
    abbreviation: "g",
  },
  {
    measurementId: UNIT.tablespoon,
    type: "volume",
    factorToBase: "15",
    name: "tablespoon",
    abbreviation: "tbsp",
  },
  {
    measurementId: UNIT.cupUs,
    type: "volume",
    factorToBase: "236.5882365",
    name: "US cup",
    abbreviation: "US cup",
  },
  {
    measurementId: UNIT.cupUs,
    type: "volume",
    factorToBase: "236.5882365",
    name: "cup",
    abbreviation: "cup",
  },
  {
    measurementId: UNIT.cupMetric,
    type: "volume",
    factorToBase: "250",
    name: "cup",
    abbreviation: "cup",
  },
  {
    measurementId: UNIT.cupMetric,
    type: "volume",
    factorToBase: "250",
    name: "metric cup",
    abbreviation: "metric cup",
  },
  {
    measurementId: UNIT.clove,
    type: "count",
    factorToBase: null,
    name: "clove",
    abbreviation: null,
  },
  {
    measurementId: UNIT.handful,
    type: "count",
    factorToBase: null,
    name: "handful",
    abbreviation: null,
  },
]);

// The handful is left out, as a unit without a seed key would be.
export const unitKeys: ReadonlyMap<number, string> = new Map([
  [UNIT.gram, "gram"],
  [UNIT.tablespoon, "tablespoon"],
  [UNIT.cupUs, "cup_us"],
  [UNIT.cupMetric, "cup_metric"],
  [UNIT.clove, "clove"],
]);
