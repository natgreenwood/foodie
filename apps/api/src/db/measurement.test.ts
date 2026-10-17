import { sql } from "drizzle-orm";
import { describe, expect } from "vitest";
import { normaliseUnit } from "../import/measurement-lookup.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { measurement, measurementName } from "./schema.js";

async function newMeasurement(tx: TestTransaction): Promise<number> {
  const [row] = await tx
    .insert(measurement)
    .values({ type: "count" })
    .returning({ id: measurement.id });
  if (!row) throw new Error("measurement insert returned no row");
  return row.id;
}

// Every code point JavaScript's \s matches, which is what normaliseUnit
// collapses and trims.
const JS_WHITESPACE = Array.from({ length: 0x10000 }, (_, c) =>
  String.fromCharCode(c),
).filter((c) => /\s/.test(c));

// Near misses that are not whitespace to JavaScript, so must be kept: NEL
// (musl's \s matches it), the Mongolian vowel separator (whitespace before
// Unicode 6.3), zero-width space, word joiner and soft hyphen.
const NOT_WHITESPACE = ["\u0085", "\u180e", "\u200b", "\u2060", "\u00ad"];

describe("measurement", () => {
  dbTest(
    "sums 0.5 kg and 200 g to 700 g through factor_to_base",
    async ({ tx }) => {
      const [kg, g] = await tx
        .insert(measurement)
        .values([
          { type: "mass", factorToBase: "1000" },
          { type: "mass", factorToBase: "1" },
        ])
        .returning({ id: measurement.id });

      // Quantities as a recipe line holds them: an amount and a measurement id.
      const result = await tx.execute<{ total: string }>(sql`
      select sum(q.amount * m.factor_to_base) as total
      from (values (0.5, ${kg?.id}::bigint), (200, ${g?.id}::bigint))
        as q(amount, measurement_id)
      join ${measurement} m on m.id = q.measurement_id
    `);

      // numeric is exact, so the total is 700.0, not a float near it.
      expect(result.rows).toEqual([{ total: "700.0" }]);
    },
  );

  // NaN sorts above every number in Postgres, so a bare `> 0` lets it in.
  dbTest.for(["NaN", "Infinity"])(
    "rejects a factor_to_base of %s",
    async (factorToBase, { tx }) => {
      await expect(
        tx.transaction((sp) =>
          sp.insert(measurement).values({ type: "mass", factorToBase }),
        ),
      ).rejects.toMatchObject({
        cause: { constraint: "measurement_factor_to_base_positive" },
      });
    },
  );

  dbTest("holds a count unit with no factor_to_base", async ({ tx }) => {
    await tx.insert(measurement).values({ type: "count" });
  });
});

describe("measurement_name", () => {
  dbTest(
    "rejects a name or abbreviation that matches another once non-breaking spaces are collapsed",
    async ({ tx }) => {
      const id = await newMeasurement(tx);
      await tx.insert(measurementName).values({
        measurementId: id,
        name: "heaped spoon",
        abbreviation: "h sp",
        locale: "x-test",
      });

      for (const [values, constraint] of [
        [
          { name: "heaped\u00a0spoon\u00a0" },
          "measurement_name_locale_name_key",
        ],
        [
          { name: "other", abbreviation: "\u00a0h\u00a0sp" },
          "measurement_name_locale_abbreviation_key",
        ],
      ] as const) {
        await expect(
          tx.transaction((sp) =>
            sp
              .insert(measurementName)
              .values({ measurementId: id, locale: "x-test", ...values }),
          ),
        ).rejects.toMatchObject({ cause: { constraint } });
      }
    },
  );

  dbTest(
    "rejects a name or abbreviation that is only a non-breaking space",
    async ({ tx }) => {
      const id = await newMeasurement(tx);

      for (const [values, constraint] of [
        [{ name: "\u00a0" }, "measurement_name_name_not_blank"],
        [
          { name: "heaped spoon", abbreviation: "\u00a0" },
          "measurement_name_abbreviation_not_blank",
        ],
      ] as const) {
        await expect(
          tx.transaction((sp) =>
            sp
              .insert(measurementName)
              .values({ measurementId: id, locale: "x-test", ...values }),
          ),
        ).rejects.toMatchObject({ cause: { constraint } });
      }
    },
  );

  // The import matches unit text with normaliseUnit against names the
  // database normalised, so the two must agree on every input.
  dbTest("normalises names exactly as normaliseUnit does", async ({ tx }) => {
    const id = await newMeasurement(tx);
    const inputs = [...JS_WHITESPACE, ...NOT_WHITESPACE].map(
      (c) => `${c}${c}Heaped${c}${c}Spoon${c}`,
    );
    // One locale per input, so inputs that normalise alike do not collide.
    const rows = await tx
      .insert(measurementName)
      .values(
        inputs.map((name, i) => ({
          measurementId: id,
          name,
          abbreviation: name,
          locale: `x-test-${i}`,
        })),
      )
      .returning({
        name: measurementName.name,
        normalisedName: measurementName.normalisedName,
        normalisedAbbreviation: measurementName.normalisedAbbreviation,
      });

    expect(JS_WHITESPACE).toHaveLength(25);
    expect(rows.map((r) => r.name).sort()).toEqual([...inputs].sort());
    expect(rows).toEqual(
      rows.map(({ name }) => ({
        name,
        normalisedName: normaliseUnit(name),
        normalisedAbbreviation: normaliseUnit(name),
      })),
    );
  });
});
