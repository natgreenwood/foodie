import argon2 from "argon2";
import { eq, sql } from "drizzle-orm";
import { describe, expect } from "vitest";
import { session, user } from "../db/schema.js";
import { dbTest } from "../test/db.js";
import {
  checkCredentials,
  createSession,
  createUser,
  ensureAdmin,
  SESSION_TTL_MS,
  sessionUser,
} from "./accounts.js";

const admin = { email: "admin@example.com", password: "correct horse" };

describe("user table", () => {
  dbTest(
    "refuses a second account whose email differs only in case",
    async ({ tx }) => {
      await tx.insert(user).values({ email: "cook@example.com" });

      await expect(
        tx.transaction((sp) =>
          sp.insert(user).values({ email: "COOK@Example.com" }),
        ),
      ).rejects.toMatchObject({ cause: { constraint: "user_email_key" } });
    },
  );

  dbTest(
    "defaults locale to en-GB and the role to non-admin",
    async ({ tx }) => {
      const [row] = await tx
        .insert(user)
        .values({ email: "cook@example.com" })
        .returning();
      expect(row).toMatchObject({
        locale: "en-GB",
        isAdmin: false,
        passwordHash: null,
        disabledAt: null,
      });
    },
  );
});

describe("createUser", () => {
  dbTest("stores an argon2id hash, never the password", async ({ tx }) => {
    const created = await createUser(tx, {
      email: "cook@example.com",
      password: "correct horse",
    });

    const [row] = await tx.select().from(user).where(eq(user.id, created!.id));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(row!.passwordHash!, "correct horse")).toBe(true);
  });

  dbTest("returns null for an email taken in another case", async ({ tx }) => {
    await createUser(tx, { email: "cook@example.com", password: "password1" });

    expect(
      await createUser(tx, {
        email: "Cook@Example.COM",
        password: "password2",
      }),
    ).toBeNull();
  });
});

describe("checkCredentials", () => {
  dbTest("refuses an account with no password", async ({ tx }) => {
    await tx.insert(user).values({ email: "oidc@example.com" });

    expect(await checkCredentials(tx, "oidc@example.com", "")).toBeNull();
  });
});

describe("sessionUser", () => {
  dbTest("refuses and deletes an expired session", async ({ tx }) => {
    const created = await createUser(tx, {
      email: "cook@example.com",
      password: "correct horse",
    });
    const { token } = await createSession(
      tx,
      created!.id,
      new Date(Date.now() - SESSION_TTL_MS - 1000),
    );

    expect(await sessionUser(tx, token)).toBeNull();
    expect(
      await tx.select().from(session).where(eq(session.userId, created!.id)),
    ).toEqual([]);
  });

  dbTest("keeps the token out of the table", async ({ tx }) => {
    const created = await createUser(tx, {
      email: "cook@example.com",
      password: "correct horse",
    });
    const { token } = await createSession(tx, created!.id);

    const [row] = await tx
      .select()
      .from(session)
      .where(eq(session.userId, created!.id));
    expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.id).not.toBe(token);
  });
});

describe("ensureAdmin", () => {
  dbTest(
    "creates the admin, then does nothing on a second run",
    async ({ tx }) => {
      expect(await ensureAdmin(tx, admin)).toBe("created");
      const [before] = await tx
        .select()
        .from(user)
        .where(eq(user.email, admin.email));

      expect(await ensureAdmin(tx, admin)).toBe("unchanged");

      const rows = await tx
        .select()
        .from(user)
        .where(eq(sql`lower(${user.email})`, admin.email));
      expect(rows).toEqual([before]);
      expect(before).toMatchObject({ isAdmin: true });
      expect(
        await checkCredentials(tx, admin.email, admin.password),
      ).toMatchObject({
        isAdmin: true,
      });
    },
  );

  dbTest(
    "promotes an existing account and keeps its password",
    async ({ tx }) => {
      await createUser(tx, {
        email: "Admin@Example.com",
        password: "their own one",
      });

      expect(await ensureAdmin(tx, admin)).toBe("promoted");

      expect(
        await checkCredentials(tx, admin.email, "their own one"),
      ).toMatchObject({ isAdmin: true });
      expect(
        await checkCredentials(tx, admin.email, admin.password),
      ).toBeNull();
    },
  );

  // JavaScript lowercases İ (U+0130) to i + U+0307, Postgres to plain i.
  dbTest(
    "finds an existing account whose email Postgres and JavaScript lowercase differently",
    async ({ tx }) => {
      const email = "İzmir-admin@example.com";
      await createUser(tx, { email, password: "their own one" });

      expect(await ensureAdmin(tx, { email, password: "correct horse" })).toBe(
        "promoted",
      );
      expect(await checkCredentials(tx, email, "their own one")).toMatchObject({
        email,
        isAdmin: true,
      });
    },
  );
});
