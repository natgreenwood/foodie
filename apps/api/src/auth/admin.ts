import { eq, sql } from "drizzle-orm";
import { session, user } from "../db/schema.js";
import { hashPassword, type Db } from "./accounts.js";

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

// Sets the account's password; it works for sign-in straight away. Sessions
// are left alone.
export async function setPassword(
  db: Db,
  id: number,
  password: string,
): Promise<AdminUser | null> {
  const passwordHash = await hashPassword(password);
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
