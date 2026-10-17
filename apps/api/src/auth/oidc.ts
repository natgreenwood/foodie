import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { oidcIdentity, oidcLogin, user } from "../db/schema.js";
import {
  byEmail,
  profileColumns,
  sessionId,
  type Db,
  type Profile,
} from "./accounts.js";
import { displayNameProblem, normaliseEmail } from "./credentials.js";
import type { OidcChecks, OidcClaims } from "./oidc-provider.js";

// How long a browser has to come back from the provider.
export const OIDC_LOGIN_TTL_MS = 10 * 60 * 1000;

// The most expired trips one start or callback deletes, so no caller can
// make the api work through the whole table.
export const OIDC_LOGIN_CLEANUP_BATCH = 100;

// The pg_advisory_xact_lock key that serialises starts, so two cannot both
// count the trips in progress below the bound and both insert ("oidc").
const OIDC_LOGIN_LOCK = 0x6f696463;

// Deletes up to OIDC_LOGIN_CLEANUP_BATCH expired trips, oldest first, and
// returns how many it deleted.
export async function deleteExpiredOidcLogins(db: Db): Promise<number> {
  const expired = db
    .select({ id: oidcLogin.id })
    .from(oidcLogin)
    .where(lte(oidcLogin.expiresAt, sql`now()`))
    .orderBy(oidcLogin.expiresAt)
    .limit(OIDC_LOGIN_CLEANUP_BATCH);
  const deleted = await db
    .delete(oidcLogin)
    .where(inArray(oidcLogin.id, expired))
    .returning({ id: oidcLogin.id });
  return deleted.length;
}

// Records a trip to the provider and returns the token for its cookie, or
// null when maxPending trips are in progress already. For a signed-in user
// connecting an identity, userId is theirs; null for a sign-in. Some expired
// trips are deleted on the way.
export async function startOidcLogin(
  db: Db,
  checks: OidcChecks,
  userId: number | null,
  maxPending: number,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date } | null> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + OIDC_LOGIN_TTL_MS);
  return db.transaction(async (t) => {
    // Held to the end of this transaction, around the count and the insert.
    await t.execute(sql`SELECT pg_advisory_xact_lock(${OIDC_LOGIN_LOCK})`);
    await deleteExpiredOidcLogins(t);
    // Counts no further than the bound.
    const inProgress = t
      .select({ one: sql`1` })
      .from(oidcLogin)
      .where(gt(oidcLogin.expiresAt, sql`now()`))
      .limit(maxPending)
      .as("in_progress");
    const [counted] = await t
      .select({ pending: sql<number>`count(*)::int` })
      .from(inProgress);
    if ((counted?.pending ?? 0) >= maxPending) return null;
    await t.insert(oidcLogin).values({
      id: sessionId(token),
      state: checks.state,
      nonce: checks.nonce,
      codeVerifier: checks.codeVerifier,
      userId,
      expiresAt,
    });
    return { token, expiresAt };
  });
}

// Deletes the trip a token started, when the browser is not sent on it after
// all.
export async function discardOidcLogin(db: Db, token: string): Promise<void> {
  await db.delete(oidcLogin).where(eq(oidcLogin.id, sessionId(token)));
}

// The trip a cookie's token started, deleted so it can be used only once;
// null if unknown or expired. Some expired trips are deleted too.
export async function takeOidcLogin(
  db: Db,
  token: string,
): Promise<{ checks: OidcChecks; userId: number | null } | null> {
  const [row] = await db
    .delete(oidcLogin)
    .where(eq(oidcLogin.id, sessionId(token)))
    .returning({
      state: oidcLogin.state,
      nonce: oidcLogin.nonce,
      codeVerifier: oidcLogin.codeVerifier,
      userId: oidcLogin.userId,
      live: sql<boolean>`${oidcLogin.expiresAt} > now()`,
    });
  await deleteExpiredOidcLogins(db);
  if (!row?.live) return null;
  const { state, nonce, codeVerifier, userId } = row;
  return { checks: { state, nonce, codeVerifier }, userId };
}

// Why a sign-in through the provider was refused:
// - email_unverified: the email belongs to an account this identity is not
//   linked to, and the provider does not say the email is verified.
// - already_connected: the account with that email already has another
//   identity from this provider.
// - account_disabled: the account is disabled.
// - provider_error: a new identity with no usable email.
export type OidcSignInRefusal =
  | "email_unverified"
  | "already_connected"
  | "account_disabled"
  | "provider_error";

export type OidcSignIn =
  | { refused: null; user: Profile; outcome: "existing" | "linked" | "created" }
  | { refused: OidcSignInRefusal };

// The account an identity signs in to. An identity already linked always
// signs in to its account. Otherwise it is linked to the account with its
// email when the provider says the email is verified, or gets a new account
// with no password when no account has that email. Never reads or changes
// the admin role.
export async function signInWithOidc(
  db: Db,
  claims: OidcClaims,
): Promise<OidcSignIn> {
  return db.transaction(async (t) => {
    const [linked] = await t
      .select({ ...profileColumns, disabledAt: user.disabledAt })
      .from(oidcIdentity)
      .innerJoin(user, eq(user.id, oidcIdentity.userId))
      .where(
        and(
          eq(oidcIdentity.issuer, claims.issuer),
          eq(oidcIdentity.subject, claims.subject),
        ),
      );
    if (linked) {
      const { disabledAt, ...profile } = linked;
      if (disabledAt) return { refused: "account_disabled" };
      return { refused: null, user: profile, outcome: "existing" };
    }

    const email = claims.email === null ? null : normaliseEmail(claims.email);
    if (email === null) return { refused: "provider_error" };

    const [existing] = await t
      .select({ ...profileColumns, disabledAt: user.disabledAt })
      .from(user)
      .where(byEmail(email))
      .for("update");
    if (existing) {
      const { disabledAt, ...profile } = existing;
      if (!claims.emailVerified) return { refused: "email_unverified" };
      if (disabledAt) return { refused: "account_disabled" };
      const added = await addIdentity(t, profile.id, claims);
      if (!added) return { refused: "already_connected" };
      return { refused: null, user: profile, outcome: "linked" };
    }

    const name = claims.name?.trim() ?? null;
    const [created] = await t
      .insert(user)
      .values({
        email,
        passwordHash: null,
        displayName: name && displayNameProblem(name) === null ? name : null,
      })
      .onConflictDoNothing()
      .returning(profileColumns);
    // Another request created the account or linked the identity since the
    // reads above; signing in again will find it.
    if (!created || !(await addIdentity(t, created.id, claims))) {
      throw new Error("oidc sign-in raced another for the same account");
    }
    return { refused: null, user: created, outcome: "created" };
  });
}

// Why connecting an identity to the signed-in account was refused:
// - email_mismatch: the provider's email is not the account's (ignoring
//   case), or there is none.
// - already_connected: the identity signs in to another account, or the
//   account has another identity from this provider.
export type OidcConnectRefusal = "email_mismatch" | "already_connected";

// Links the identity to the account. Connecting the identity that is already
// linked to the account changes nothing and succeeds.
export async function connectOidcIdentity(
  db: Db,
  userId: number,
  claims: OidcClaims,
): Promise<{ refused: OidcConnectRefusal | null }> {
  return db.transaction(async (t) => {
    const [linked] = await t
      .select({ userId: oidcIdentity.userId })
      .from(oidcIdentity)
      .where(
        and(
          eq(oidcIdentity.issuer, claims.issuer),
          eq(oidcIdentity.subject, claims.subject),
        ),
      );
    if (linked) {
      return { refused: linked.userId === userId ? null : "already_connected" };
    }
    const [account] =
      claims.email === null
        ? []
        : await t
            .select({ id: user.id })
            .from(user)
            .where(
              and(
                eq(user.id, userId),
                byEmail(claims.email.trim()),
                isNull(user.disabledAt),
              ),
            )
            .for("update");
    if (!account) return { refused: "email_mismatch" };
    const added = await addIdentity(t, userId, claims);
    return { refused: added ? null : "already_connected" };
  });
}

export interface SignInMethods {
  // Whether the account has a local password, so could still sign in if
  // its identity were disconnected.
  hasPassword: boolean;
  oidc: { connected: boolean; connectedAt: string | null };
}

// How the account can sign in, for GET /me. Null when it no longer exists.
export async function signInMethods(
  db: Db,
  userId: number,
): Promise<SignInMethods | null> {
  const [row] = await db
    .select({
      hasPassword: sql<boolean>`${user.passwordHash} IS NOT NULL`,
      connectedAt: oidcIdentity.createdAt,
    })
    .from(user)
    .leftJoin(oidcIdentity, eq(oidcIdentity.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    hasPassword: row.hasPassword,
    oidc: {
      connected: row.connectedAt !== null,
      connectedAt: row.connectedAt?.toISOString() ?? null,
    },
  };
}

// Unlinks the account's identities, only when it has a local password: an
// account made through the provider would otherwise have no way to sign in.
// Disconnecting with nothing connected succeeds.
export async function disconnectOidc(
  db: Db,
  userId: number,
): Promise<{ refused: "no_local_password" | null }> {
  return db.transaction(async (t) => {
    const [row] = await t
      .select({ passwordHash: user.passwordHash })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (!row?.passwordHash) return { refused: "no_local_password" };
    await t.delete(oidcIdentity).where(eq(oidcIdentity.userId, userId));
    return { refused: null };
  });
}

// False when the identity is linked already, or the account already has one
// from this issuer.
async function addIdentity(
  db: Db,
  userId: number,
  claims: OidcClaims,
): Promise<boolean> {
  const added = await db
    .insert(oidcIdentity)
    .values({ userId, issuer: claims.issuer, subject: claims.subject })
    .onConflictDoNothing()
    .returning({ id: oidcIdentity.id });
  return added.length > 0;
}
