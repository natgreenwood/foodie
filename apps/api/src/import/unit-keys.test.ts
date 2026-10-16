import { expect } from "vitest";
import { measurement } from "../db/schema.js";
import { dbTest } from "../test/db.js";
import { loadMeasurementLookup } from "./measurement-lookup.js";
import { loadUnitKeys } from "./unit-keys.js";

dbTest("gives every seeded unit its seed key", async ({ tx }) => {
  const keys = await loadUnitKeys(tx);

  const systemUnits = await tx.select({ id: measurement.id }).from(measurement);
  expect(keys.size).toBe(25);
  expect(new Set(keys.values()).size).toBe(25);
  expect([...keys.keys()].sort()).toEqual(systemUnits.map((u) => u.id).sort());
});

dbTest("keys the cups the lookup resolves by volume", async ({ tx }) => {
  const [keys, lookup] = await Promise.all([
    loadUnitKeys(tx),
    loadMeasurementLookup(tx),
  ]);

  expect(keys.get(lookup.cup.cup_us)).toBe("cup_us");
  expect(keys.get(lookup.cup.cup_metric)).toBe("cup_metric");
});
