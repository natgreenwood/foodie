import { and, eq, isNotNull, sql } from "drizzle-orm";
import { session, user } from "../db/schema.js";
import { lockActor, type Actor, type Db } from "./accounts.js";

// The admin making a change, and the session they make it through.
export type AdminActor = Actor;

// Why asAdmin refused: the actor's session is gone or their account is
// disabled (unauthenticated), or they are no longer an admin (forbidden).
export type AdminRefusal = "unauthenticated" | "forbidden";

// Runs one privileged change in a transaction, after re-checking with
// lockActor that the actor is still an enabled admin with a live session
// (SEC-1). The target's row, when there is one, is locked with the actor's.
export async function asAdmin<T>(
  db: Db,
  actor: AdminActor,
  targetId: number | null,
  work: (t: Db) => Promise<T>,
): Promise<{ refused: AdminRefusal } | { refused: null; value: T }> {
  return db.transaction(async (t) => {
    const live = await lockActor(t, actor, targetId);
    if (!live) return { refused: "unauthenticated" };
    if (!live.isAdmin) return { refused: "forbidden" };
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
// sign-in straight away. Sessions are left alone. An account with no
// password signs in only through OIDC, whose provider manages its
// credentials (NATG-226), so it is not given one: "no_password". Null when
// there is no such account.
export async function setPasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
): Promise<AdminUser | "no_password" | null> {
  const [row] = await db
    .update(user)
    .set({ passwordHash, updatedAt: sql`now()` })
    .where(and(eq(user.id, id), isNotNull(user.passwordHash)))
    .returning(adminUserColumns);
  if (row) return row;
  const [exists] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, id));
  return exists ? "no_password" : null;
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
