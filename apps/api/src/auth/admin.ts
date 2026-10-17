import { and, eq, gt, sql } from "drizzle-orm";
import { session, user } from "../db/schema.js";
import type { Db } from "./accounts.js";

// The admin making a change, and the session they make it through.
export interface AdminActor {
  userId: number;
  sessionId: string;
}

// Why asAdmin refused: the actor's session is gone or their account is
// disabled (unauthenticated), or they are no longer an admin (forbidden).
export type AdminRefusal = "unauthenticated" | "forbidden";

// Runs one privileged change in a transaction, after re-checking that the
// actor is still an enabled admin with a live session. requireAdmin checked
// that when the request arrived, but the body can arrive much later, and in
// between another admin may have disabled or demoted the actor (SEC-1).
//
// The actor's user row is locked FOR UPDATE, so the check waits for any
// disable or revoke of the actor in flight, then sees its committed result,
// and nothing can change the actor until this change commits. The target's
// row, when there is one, is locked too, always in ascending id order, so
// two admins acting on each other wait rather than deadlock. The session row
// is locked FOR SHARE so a sign-out waits for the change as well.
export async function asAdmin<T>(
  db: Db,
  actor: AdminActor,
  targetId: number | null,
  work: (t: Db) => Promise<T>,
): Promise<{ refused: AdminRefusal } | { refused: null; value: T }> {
  return db.transaction(async (t) => {
    const ids = [...new Set([actor.userId, targetId ?? actor.userId])].sort(
      (a, b) => a - b,
    );
    let actorRow: { isAdmin: boolean; disabledAt: Date | null } | undefined;
    for (const id of ids) {
      const [row] = await t
        .select({ isAdmin: user.isAdmin, disabledAt: user.disabledAt })
        .from(user)
        .where(eq(user.id, id))
        .for("update");
      if (id === actor.userId) actorRow = row;
    }
    if (!actorRow || actorRow.disabledAt) return { refused: "unauthenticated" };
    const [live] = await t
      .select({ id: session.id })
      .from(session)
      .where(
        and(
          eq(session.id, actor.sessionId),
          eq(session.userId, actor.userId),
          gt(session.expiresAt, sql`now()`),
        ),
      )
      .for("share");
    if (!live) return { refused: "unauthenticated" };
    if (!actorRow.isAdmin) return { refused: "forbidden" };
    return { refused: null, value: await work(t) };
  });
}

// What the user administration routes (NATG-277) show of an account. Never
// the password hash; hasPassword says whether there is one, since an account
// may only sign in another way (OIDC, NATG-226).
export interface AdminUser {
  id: number;
  email: string;
  displayName: string | null;
  locale: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  hasPassword: boolean;
  createdAt: Date;
}

const adminUserColumns = {
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  locale: user.locale,
  isAdmin: user.isAdmin,
  disabledAt: user.disabledAt,
  hasPassword: sql<boolean>`${user.passwordHash} IS NOT NULL`,
  createdAt: user.createdAt,
};

// Every account, oldest first.
export async function listUsers(db: Db): Promise<AdminUser[]> {
  return db.select(adminUserColumns).from(user).orderBy(user.id);
}

// Disables the account and ends all its sessions, in one transaction. An
// account that is already disabled keeps its original disabled_at. Null when
// there is no such account.
export async function disableUser(
  db: Db,
  id: number,
): Promise<AdminUser | null> {
  return db.transaction(async (t) => {
    const [row] = await t
      .update(user)
      .set({
        disabledAt: sql`coalesce(${user.disabledAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(eq(user.id, id))
      .returning(adminUserColumns);
    if (!row) return null;
    await t.delete(session).where(eq(session.userId, id));
    return row;
  });
}

export async function enableUser(
  db: Db,
  id: number,
): Promise<AdminUser | null> {
  const [row] = await db
    .update(user)
    .set({ disabledAt: null, updatedAt: sql`now()` })
    .where(eq(user.id, id))
    .returning(adminUserColumns);
  return row ?? null;
}

export async function setAdmin(
  db: Db,
  id: number,
  isAdmin: boolean,
): Promise<AdminUser | null> {
  const [row] = await db
    .update(user)
    .set({ isAdmin, updatedAt: sql`now()` })
    .where(eq(user.id, id))
    .returning(adminUserColumns);
  return row ?? null;
}

// Sets the account's password hash (from hashPassword, made before the
// transaction so no lock is held while hashing); the password works for
// sign-in straight away. Sessions are left alone.
export async function setPasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
): Promise<AdminUser | null> {
  const [row] = await db
    .update(user)
    .set({ passwordHash, updatedAt: sql`now()` })
    .where(eq(user.id, id))
    .returning(adminUserColumns);
  return row ?? null;
}

// Deletes the account; its sessions and recipes go with it (on delete
// cascade). False when there was no such account.
export async function deleteUser(db: Db, id: number): Promise<boolean> {
  const deleted = await db
    .delete(user)
    .where(eq(user.id, id))
    .returning({ id: user.id });
  return deleted.length > 0;
}
