import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { measurement } from "../db/schema.js";
import { dbTest } from "./db.js";

// The harness itself: these depend on running in order, which Vitest does
// for the tests in one file.
describe("dbTest", () => {
  // Unlikely to be used by any migration-shipped unit.
  const marker = "987654321";

  dbTest("writes a row inside the test transaction", async ({ tx }) => {
    await tx
      .insert(measurement)
      .values({ type: "count", factorToBase: marker });

    const rows = await tx
      .select()
      .from(measurement)
      .where(eq(measurement.factorToBase, marker));
    expect(rows).toHaveLength(1);
  });

  dbTest("does not see rows a previous test wrote", async ({ tx }) => {
    const rows = await tx
      .select()
      .from(measurement)
      .where(eq(measurement.factorToBase, marker));
    expect(rows).toEqual([]);
  });

  dbTest("continues after an expected constraint violation", async ({ tx }) => {
    await expect(
      tx.transaction(async (sp) => {
        await sp
          .insert(measurement)
          .values({ type: "mass", factorToBase: "0" });
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "measurement_factor_to_base_positive" },
    });

    const [row] = await tx
      .insert(measurement)
      .values({ type: "mass", factorToBase: "1" })
      .returning({ id: measurement.id });
    expect(row?.id).toBeTypeOf("number");
  });
});
