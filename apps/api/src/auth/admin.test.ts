import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "../db/client.js";
import { user } from "../db/schema.js";
import { testDatabaseUrl } from "../test/env.js";
import { createSession, sessionId } from "./accounts.js";
import {
  asAdmin,
  disableUser,
  enableUser,
  setAdmin,
  type AdminActor,
} from "./admin.js";

// These tests are about two connections seeing each other's committed
// writes, so they cannot use dbTest's rolled-back transaction: they commit,
// and delete what they made afterwards.
const database = createDatabase(testDatabaseUrl(), (err) => {
  console.error("postgres idle client error:", err.message);
});
const { db } = database;
const made: number[] = [];

afterAll(async () => {
  if (made.length > 0) await db.delete(user).where(inArray(user.id, made));
  await database.close();
});

// A committed admin account with a live session.
async function admin(): Promise<AdminActor> {
  const [row] = await db
    .insert(user)
    .values({
      email: `admin-${crypto.randomUUID()}@admin-race.test`,
      isAdmin: true,
    })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  made.push(row.id);
  const { token } = await createSession(db, row.id);
  return { userId: row.id, sessionId: sessionId(token) };
}

async function state(id: number) {
  const [row] = await db
    .select({ isAdmin: user.isAdmin, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, id));
  return row;
}

// Resolves once at least `n` backends are waiting on a row lock taken by
// FOR UPDATE.
async function rowLockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await database.pool.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike '%for update%'`,
    );
    if (Number(rows[0]!.n) >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fewer than ${n} backends started waiting on a row lock`);
}

describe("asAdmin (SEC-1)", () => {
  test("refuses a self-enable by an admin disabled after the guard passed", async () => {
    const mallory = await admin();
    const other = await admin();
    // Mallory's request has passed requireAdmin; another admin disables
    // Mallory before the handler runs.
    await asAdmin(db, other, mallory.userId, (t) =>
      disableUser(t, mallory.userId),
    );

    const result = await asAdmin(db, mallory, mallory.userId, (t) =>
      enableUser(t, mallory.userId),
    );

    expect(result).toEqual({ refused: "unauthenticated" });
    expect((await state(mallory.userId))?.disabledAt).not.toBeNull();
  });

  test("refuses a self-grant by an admin revoked after the guard passed", async () => {
    const mallory = await admin();
    const other = await admin();
    await asAdmin(db, other, mallory.userId, (t) =>
      setAdmin(t, mallory.userId, false),
    );

    const result = await asAdmin(db, mallory, mallory.userId, (t) =>
      setAdmin(t, mallory.userId, true),
    );

    expect(result).toEqual({ refused: "forbidden" });
    expect((await state(mallory.userId))?.isAdmin).toBe(false);
  });

  test("waits for a disable in flight, then refuses", async () => {
    const mallory = await admin();
    const other = await admin();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const disableHoldsLock = new Promise<void>((r) => (locked = r));

    // The other admin's disable, held open after its writes.
    const disabling = asAdmin(db, other, mallory.userId, async (t) => {
      const row = await disableUser(t, mallory.userId);
      locked();
      await released;
      return row;
    });
    await disableHoldsLock;
    let settled = false;
    const enabling = asAdmin(db, mallory, mallory.userId, (t) =>
      enableUser(t, mallory.userId),
    ).finally(() => (settled = true));
    await rowLockWaiters(1);
    expect(settled).toBe(false);

    release();

    expect((await disabling).refused).toBeNull();
    expect(await enabling).toEqual({ refused: "unauthenticated" });
    expect((await state(mallory.userId))?.disabledAt).not.toBeNull();
  });

  test("two admins disabling each other at once: one wins, no deadlock", async () => {
    const low = await admin();
    const high = await admin();
    expect(low.userId).toBeLessThan(high.userId);
    // A third connection holds the higher row, so both changes queue up
    // behind it in a known order: high's first, then low's. Locking actor
    // first would now deadlock (high holds high and wants low, low holds low
    // and wants high). In id order, high's change takes low first, so low's
    // change waits behind it holding nothing.
    const holder = await database.pool.connect();
    try {
      await holder.query("begin");
      await holder.query('select 1 from "user" where id = $1 for update', [
        high.userId,
      ]);
      const highDisablesLow = asAdmin(db, high, low.userId, (t) =>
        disableUser(t, low.userId),
      );
      await rowLockWaiters(1);
      const lowDisablesHigh = asAdmin(db, low, high.userId, (t) =>
        disableUser(t, high.userId),
      );
      await rowLockWaiters(2);
      await holder.query("commit");

      const results = await Promise.all([highDisablesLow, lowDisablesHigh]);

      expect(results.map((r) => r.refused).sort()).toEqual([
        null,
        "unauthenticated",
      ]);
      const after = [await state(low.userId), await state(high.userId)];
      expect(after.filter((s) => s?.disabledAt !== null)).toHaveLength(1);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });
});
