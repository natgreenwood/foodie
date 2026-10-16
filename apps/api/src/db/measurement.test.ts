import { sql } from "drizzle-orm";
import { describe, expect } from "vitest";
import { dbTest } from "../test/db.js";
import { measurement } from "./schema.js";

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
