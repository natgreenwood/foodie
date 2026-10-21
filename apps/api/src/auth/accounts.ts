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

export const profileColumns = {
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  locale: user.locale,
  isAdmin: user.isAdmin,
};

// Both sides lowercased by Postgres, as the unique index is: JavaScript's
// toLowerCase() disagrees with it on some characters (İ, for one).
export function byEmail(email: string) {
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

// The session table's id for a cookie token.
export function sessionId(token: string): string {
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

// A signed-in user making a change, and the session they make it through.
export interface Actor {
  userId: number;
  sessionId: string;
}

// Re-checks, inside the transaction `t` that makes a change, that the actor
// may still act: requireUser checked when the request arrived, but the body
// can arrive much later, and in between the account may have been disabled,
// demoted or signed out (SEC-1). The actor's profile as committed now, or
// null when the account is gone or disabled or the session is gone or
// expired.
//
// The actor's user row is locked in `mode`, so the check waits for any
// disable, demotion or delete in flight, then sees its committed result, and
// none can land until the change commits: both "update" and "share"
// conflict with the UPDATE or DELETE that makes one. "update" is for a change
// that will itself modify the user rows it locks (asAdmin). "share" is for
// any other change (the catalogue writes): it does not conflict with the
// KEY SHARE lock a foreign key check takes on the user, so a transaction
// that inserts a row referencing the user (an import's recipe) cannot close
// a lock cycle with this one (NATG-371). `otherUserId`'s row, when given, is
// locked too, always in ascending id order, so two actors acting on each
// other wait rather than deadlock. The session row is locked FOR SHARE so a
// sign-out waits for the change as well. Call it before taking any other
// lock in `t`.
export async function lockActor(
  t: Db,
  actor: Actor,
  mode: "update" | "share",
  otherUserId: number | null = null,
): Promise<Profile | null> {
  const ids = [...new Set([actor.userId, otherUserId ?? actor.userId])].sort(
    (a, b) => a - b,
  );
  let actorRow: (Profile & { disabledAt: Date | null }) | undefined;
  for (const id of ids) {
    const [row] = await t
      .select({ ...profileColumns, disabledAt: user.disabledAt })
      .from(user)
      .where(eq(user.id, id))
      .for(mode);
    if (id === actor.userId) actorRow = row;
  }
  if (!actorRow || actorRow.disabledAt) return null;
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
  if (!live) return null;
  return {
    id: actorRow.id,
    email: actorRow.email,
    displayName: actorRow.displayName,
    locale: actorRow.locale,
    isAdmin: actorRow.isAdmin,
  };
}

export type AdminBootstrapOutcome = "created" | "promoted" | "unchanged";

// Makes sure the account configured by ADMIN_USER exists and is an admin.
// An account that is already an admin is never touched, so a restart is a
// no-op and a password changed since the first start is kept. An existing
// account that is not yet an admin is promoted: there is no email
// verification, so whoever registered the address may not be the operator.
// Promotion therefore also sets the password to ADMIN_PASSWORD and ends
// every session of that account, in one transaction so a crash cannot leave
// the old password or sessions in place. A disabled account stays disabled.
// Safe to run on every start, and from two api instances at once.
export async function ensureAdmin(
  db: Db,
  admin: { email: string; password: string },
): Promise<AdminBootstrapOutcome> {
  const [existing] = await db
    .select({ isAdmin: user.isAdmin })
    .from(user)
    .where(byEmail(admin.email));
  if (existing?.isAdmin) return "unchanged";
  const passwordHash = await hashPassword(admin.password);
  if (!existing) {
    const [created] = await db
      .insert(user)
      .values({ email: admin.email, passwordHash, isAdmin: true })
      .onConflictDoNothing()
      .returning({ id: user.id });
    if (created) return "created";
  }
  // Exists without the role, or another instance or a registration created
  // it just now. Matches nothing if that row is already an admin.
  return db.transaction(async (t) => {
    const [promoted] = await t
      .update(user)
      .set({ isAdmin: true, passwordHash, updatedAt: sql`now()` })
      .where(and(byEmail(admin.email), eq(user.isAdmin, false)))
      .returning({ id: user.id });
    if (!promoted) return "unchanged";
    await t.delete(session).where(eq(session.userId, promoted.id));
    return "promoted";
  });
}
