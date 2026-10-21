import { describe, expect } from "vitest";
import type { Profile } from "../auth/accounts.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { createIngredient } from "./ingredients.js";
import { user } from "./schema.js";

async function creator(tx: TestTransaction): Promise<Profile> {
  const [row] = await tx
    .insert(user)
    .values({ email: `cook-${crypto.randomUUID()}@ingredients.test` })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  return {
    id: row.id,
    email: "",
    displayName: null,
    locale: "en-GB",
    isAdmin: false,
  };
}

// The route refuses text that is not well-formed Unicode (NATG-350); these
// call createIngredient directly, so a clash it was not meant to see still
// gets an answer rather than a failed query.
describe("createIngredient", () => {
  dbTest(
    "finds the owner of a clash the same way the insert stored the name",
    async ({ tx }) => {
      const me = await creator(tx);
      // pg sends a lone surrogate as U+FFFD, so this is stored as "x-�".
      const input = {
        names: [{ name: "x-\ud800", locale: "en" }],
        category: null,
      };

      const first = await createIngredient(tx, me, input);
      const retry = await createIngredient(tx, me, input);

      if (!("created" in first)) throw new Error("first create failed");
      expect(retry).toEqual({
        taken: {
          ingredient: { id: first.created.id, name: "x-�" },
          name: { name: "x-�", locale: "en" },
        },
      });
    },
  );

  dbTest(
    "says two names repeat when they are one name once stored",
    async ({ tx }) => {
      const me = await creator(tx);

      const outcome = await createIngredient(tx, me, {
        names: [
          { name: "y-\ud800", locale: "en" },
          { name: "y-\ud801", locale: "en" },
        ],
        category: null,
      });

      expect(outcome).toEqual({ repeated: true });
    },
  );
});
