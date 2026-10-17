import { randomBytes } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
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

// Records a trip to the provider and returns the token for its cookie. For
// a signed-in user connecting an identity, userId is theirs; null for a
// sign-in. Expired trips are deleted on the way.
export async function startOidcLogin(
  db: Db,
  checks: OidcChecks,
  userId: number | null,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + OIDC_LOGIN_TTL_MS);
  await db.delete(oidcLogin).where(lte(oidcLogin.expiresAt, sql`now()`));
  await db.insert(oidcLogin).values({
    id: sessionId(token),
    state: checks.state,
    nonce: checks.nonce,
    codeVerifier: checks.codeVerifier,
    userId,
    expiresAt,
  });
  return { token, expiresAt };
}

// The trip a cookie's token started, deleted so it can be used only once;
// null if unknown or expired.
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
  if (!row?.live) return null;
  const { state, nonce, codeVerifier, userId } = row;
  return { checks: { state, nonce, codeVerifier }, userId };
}

// Why a sign-in through the provider was refused:
// - account_exists: the email belongs to an account this identity is not
//   linked to, and the provider does not say the email is verified (or the
//   account already has another identity from this provider).
// - account_disabled: the account is disabled.
// - email_missing: a new identity with no usable email.
export type OidcSignInRefusal =
  "account_exists" | "account_disabled" | "email_missing";

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
    if (email === null) return { refused: "email_missing" };

    const [existing] = await t
      .select({ ...profileColumns, disabledAt: user.disabledAt })
      .from(user)
      .where(byEmail(email))
      .for("update");
    if (existing) {
      const { disabledAt, ...profile } = existing;
      if (!claims.emailVerified) return { refused: "account_exists" };
      if (disabledAt) return { refused: "account_disabled" };
      const added = await addIdentity(t, profile.id, claims);
      if (!added) return { refused: "account_exists" };
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
// - identity_in_use: the identity signs in to another account.
// - already_connected: the account has another identity from this provider.
export type OidcConnectRefusal =
  "email_mismatch" | "identity_in_use" | "already_connected";

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
      return { refused: linked.userId === userId ? null : "identity_in_use" };
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

// Whether the account has an identity linked, and whether it has a local
// password to sign in with if that identity were disconnected.
export async function oidcConnection(
  db: Db,
  userId: number,
): Promise<{ connected: boolean; hasPassword: boolean }> {
  const [row] = await db
    .select({
      connected: sql<boolean>`${oidcIdentity.id} IS NOT NULL`,
      hasPassword: sql<boolean>`${user.passwordHash} IS NOT NULL`,
    })
    .from(user)
    .leftJoin(oidcIdentity, eq(oidcIdentity.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? { connected: false, hasPassword: false };
}

// Unlinks the account's identities, only when it has a local password: an
// account made through the provider would otherwise have no way to sign in.
// Disconnecting with nothing connected succeeds.
export async function disconnectOidc(
  db: Db,
  userId: number,
): Promise<{ refused: "password_required" | null }> {
  return db.transaction(async (t) => {
    const [row] = await t
      .select({ passwordHash: user.passwordHash })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (!row?.passwordHash) return { refused: "password_required" };
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
