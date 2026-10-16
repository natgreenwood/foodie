import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { session, user } from "../db/schema.js";
import type * as schema from "../db/schema.js";

// The api's database or a transaction on it.
export type Db = PgDatabase<NodePgQueryResultHKT, typeof schema>;

// What the api knows about the signed-in user, and what GET /me returns.
export interface Profile {
  id: number;
  email: string;
  displayName: string | null;
  locale: string;
  isAdmin: boolean;
}

// A session lasts this long from sign-in; it is not extended by use.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const profileColumns = {
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  locale: user.locale,
  isAdmin: user.isAdmin,
};

// Both sides lowercased by Postgres, as the unique index is: JavaScript's
// toLowerCase() disagrees with it on some characters (İ, for one).
function byEmail(email: string) {
  return eq(sql`lower(${user.email})`, sql`lower(${email})`);
}

// argon2id with the library's defaults (64 MiB, 3 passes, 4 lanes).
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// Verified against when the email is unknown or has no password, so that
// case costs the same hash as a wrong password and cannot be told apart by
// timing. Made when the module loads so the first such sign-in does not
// also pay for making it.
const dummyHash = hashPassword(randomBytes(16).toString("base64url"));

// The profile when the email and password match an enabled account, null
// otherwise. Always runs exactly one argon2 verification.
export async function checkCredentials(
  db: Db,
  email: string,
  password: string,
): Promise<Profile | null> {
  const [row] = await db
    .select({
      ...profileColumns,
      passwordHash: user.passwordHash,
      disabledAt: user.disabledAt,
    })
    .from(user)
    .where(byEmail(email));
  const hash = row?.passwordHash ?? (await dummyHash);
  const matches = await argon2.verify(hash, password);
  if (!row || row.passwordHash === null || !matches || row.disabledAt) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    locale: row.locale,
    isAdmin: row.isAdmin,
  };
}

// The new account, or null when the email is already taken (ignoring case).
export async function createUser(
  db: Db,
  values: { email: string; password: string; displayName?: string | null },
): Promise<Profile | null> {
  const passwordHash = await hashPassword(values.password);
  const [row] = await db
    .insert(user)
    .values({
      email: values.email,
      passwordHash,
      displayName: values.displayName ?? null,
    })
    .onConflictDoNothing()
    .returning(profileColumns);
  return row ?? null;
}

export async function updateProfile(
  db: Db,
  userId: number,
  changes: { displayName?: string | null; locale?: string },
): Promise<Profile | null> {
  const [row] = await db
    .update(user)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(user.id, userId))
    .returning(profileColumns);
  return row ?? null;
}

function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Starts a session for the user and returns the token for the cookie.
export async function createSession(
  db: Db,
  userId: number,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(session).values({ id: sessionId(token), userId, expiresAt });
  return { token, expiresAt };
}

// The user a cookie's token signs in, or null if the session is unknown,
// expired, or belongs to a disabled account. A refused session is deleted.
export async function sessionUser(
  db: Db,
  token: string,
): Promise<Profile | null> {
  const id = sessionId(token);
  const [row] = await db
    .select(profileColumns)
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.id, id),
        gt(session.expiresAt, sql`now()`),
        isNull(user.disabledAt),
      ),
    );
  if (row) return row;
  await db.delete(session).where(eq(session.id, id));
  return null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sessionId(token)));
}

export type AdminBootstrapOutcome = "created" | "promoted" | "unchanged";

// Makes sure the account configured by ADMIN_USER exists and is an admin.
// An existing account keeps its password, so a password changed after the
// first start is not reset by the next one; a disabled account stays
// disabled. Safe to run on every start, and from two api instances at once.
export async function ensureAdmin(
  db: Db,
  admin: { email: string; password: string },
): Promise<AdminBootstrapOutcome> {
  const [existing] = await db
    .select({ isAdmin: user.isAdmin })
    .from(user)
    .where(byEmail(admin.email));
  if (existing?.isAdmin) return "unchanged";
  if (!existing) {
    const [created] = await db
      .insert(user)
      .values({
        email: admin.email,
        passwordHash: await hashPassword(admin.password),
        isAdmin: true,
      })
      .onConflictDoNothing()
      .returning({ id: user.id });
    if (created) return "created";
  }
  // Exists without the role, or another instance created it just now.
  const promoted = await db
    .update(user)
    .set({ isAdmin: true, updatedAt: sql`now()` })
    .where(and(byEmail(admin.email), eq(user.isAdmin, false)))
    .returning({ id: user.id });
  return promoted.length > 0 ? "promoted" : "unchanged";
}
