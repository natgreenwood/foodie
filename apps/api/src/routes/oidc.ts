import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { sessionUser } from "../auth/accounts.js";
import {
  connectOidcIdentity,
  disconnectOidc,
  oidcConnection,
  signInWithOidc,
  startOidcLogin,
  takeOidcLogin,
  type OidcConnectRefusal,
  type OidcSignInRefusal,
} from "../auth/oidc.js";
import type { OidcClaims, OidcProvider } from "../auth/oidc-provider.js";
import { describeError } from "../db/errors.js";
import { SESSION_COOKIE, startSession, type AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

export interface OidcDeps extends AuthDeps {
  // The configured provider; absent or null when OIDC sign-in is off.
  oidc?: OidcProvider | null;
}

export interface OidcConfigResponse {
  enabled: boolean;
  displayName: string | null;
}

// The oidc_error a callback redirects to the web app with, on /sign-in for
// a sign-in and on /profile for a connect:
// - expired: no trip in progress for this browser, or it timed out, or the
//   user who started a connect is no longer the one signed in.
// - provider_unavailable: the provider could not be reached to start.
// - failed: the provider answered with an error, or its response did not
//   check out.
export type OidcRedirectError =
  | OidcSignInRefusal
  | OidcConnectRefusal
  | "expired"
  | "provider_unavailable"
  | "failed";

// Holds the token for one trip to the provider and back.
export const OIDC_COOKIE = "foodie_oidc";

const SIGN_IN_PAGE = "/sign-in";
const PROFILE_PAGE = "/profile";

function redirectWithError(
  reply: FastifyReply,
  page: string,
  error: OidcRedirectError,
) {
  return reply.redirect(`${page}?oidc_error=${error}`);
}

function notConfigured(reply: FastifyReply) {
  return sendError(reply, 404, "not_found", "oidc sign-in is not configured");
}

// The open OIDC routes: whether it is on, and the sign-in round trip.
// Browser navigations, not fetches, except /auth/oidc/config: they answer
// with redirects, to the provider or back to a web app page.
export const oidcRoutes: FastifyPluginCallback<OidcDeps> = (
  app,
  deps,
  done,
) => {
  const { db, oidc } = deps;
  app.setErrorHandler(apiErrorHandler("oidc"));

  app.get("/auth/oidc/config", (): OidcConfigResponse => {
    return { enabled: !!oidc, displayName: oidc?.displayName ?? null };
  });

  // Sends the browser to the provider to sign in.
  app.get("/auth/oidc/start", async (request, reply) => {
    if (!oidc) return notConfigured(reply);
    const url = await beginTrip(request, reply, deps, oidc, null);
    if (!url) {
      return redirectWithError(reply, SIGN_IN_PAGE, "provider_unavailable");
    }
    return reply.redirect(url.href);
  });

  // Where the provider sends the browser back, for a sign-in or a connect.
  // The trip is used up whatever happens, so a repeated callback answers
  // expired and changes nothing.
  app.get("/auth/oidc/callback", async (request, reply) => {
    if (!oidc) return notConfigured(reply);
    const token = request.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: oidc.callbackPath });
    const trip = token ? await takeOidcLogin(db, token) : null;
    const page = trip?.userId ? PROFILE_PAGE : SIGN_IN_PAGE;
    if (!trip) return redirectWithError(reply, page, "expired");

    let claims: OidcClaims;
    try {
      const query = request.url.includes("?")
        ? request.url.slice(request.url.indexOf("?"))
        : "";
      claims = await oidc.claims(query, trip.checks);
    } catch (err) {
      request.log.warn(
        { ip: request.ip, error: describeError(err) },
        "auth: oidc callback failed",
      );
      return redirectWithError(reply, page, "failed");
    }

    if (trip.userId !== null) {
      return finishConnect(request, reply, deps, trip.userId, claims);
    }

    const result = await signInWithOidc(db, claims).catch((err: unknown) => {
      request.log.error(
        { error: describeError(err) },
        "auth: oidc sign-in failed to resolve the account",
      );
      return null;
    });
    if (!result) return redirectWithError(reply, page, "failed");
    if (result.refused) {
      // The same line a failed local sign-in writes.
      request.log.warn(
        { email: claims.email, ip: request.ip, reason: result.refused },
        "auth: sign-in failed",
      );
      return redirectWithError(reply, page, result.refused);
    }
    await startSession(deps, reply, result.user.id);
    request.log.info(
      { userId: result.user.id, outcome: result.outcome },
      "auth: oidc sign-in",
    );
    return reply.redirect("/");
  });

  done();
};

// The signed-in OIDC routes: connect an identity to the account, and see
// or remove it. Registered behind requireUser.
export const oidcAccountRoutes: FastifyPluginCallback<OidcDeps> = (
  app,
  deps,
  done,
) => {
  const { db, oidc } = deps;
  app.setErrorHandler(apiErrorHandler("oidc"));

  // Answers { authorizationUrl } for the web app to send the browser to; the
  // callback then lands on /profile. A POST, so another site cannot start
  // it.
  app.post("/auth/oidc/connect", async (request, reply) => {
    if (!oidc) return notConfigured(reply);
    const url = await beginTrip(request, reply, deps, oidc, request.user!.id);
    if (!url) {
      return sendError(
        reply,
        502,
        "provider_unavailable",
        "the sign-in provider could not be reached",
      );
    }
    return { authorizationUrl: url.href };
  });

  // { connected, hasPassword }: whether an identity is linked, and whether
  // the account could still sign in without it.
  app.get("/auth/oidc/connection", (request) =>
    oidcConnection(db, request.user!.id),
  );

  // Unlinks the account's identity: 204, also when there was none. 409
  // password_required for an account with no local password.
  app.delete("/auth/oidc/connection", async (request, reply) => {
    const { refused } = await disconnectOidc(db, request.user!.id);
    if (refused) {
      return sendError(
        reply,
        409,
        "password_required",
        "an account without a password cannot disconnect its sign-in provider",
      );
    }
    request.log.info({ userId: request.user!.id }, "auth: oidc disconnected");
    return reply.code(204).send();
  });

  done();
};

// Records a trip to the provider and sets its cookie; the URL to send the
// browser to, or null when the provider could not be reached.
async function beginTrip(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OidcDeps,
  oidc: OidcProvider,
  userId: number | null,
): Promise<URL | null> {
  const checks = oidc.newChecks();
  let url: URL;
  try {
    url = await oidc.authorizationUrl(checks);
  } catch (err) {
    request.log.error(
      { error: describeError(err) },
      "auth: oidc provider unavailable",
    );
    return null;
  }
  const { token, expiresAt } = await startOidcLogin(deps.db, checks, userId);
  reply.setCookie(OIDC_COOKIE, token, {
    // Sent back only to the callback.
    path: oidc.callbackPath,
    httpOnly: true,
    // Lax, so it comes back on the provider's top-level redirect.
    sameSite: "lax",
    secure: deps.secureCookies,
    expires: expiresAt,
  });
  return url;
}

// The end of a connect: only for the user who started it, still signed in
// in this browser.
async function finishConnect(
  request: FastifyRequest,
  reply: FastifyReply,
  { db }: OidcDeps,
  userId: number,
  claims: OidcClaims,
) {
  const token = request.cookies[SESSION_COOKIE];
  const current = token ? await sessionUser(db, token) : null;
  if (current?.id !== userId) {
    return redirectWithError(reply, PROFILE_PAGE, "expired");
  }
  const { refused } = await connectOidcIdentity(db, userId, claims);
  if (refused) {
    request.log.warn(
      { userId, email: claims.email, ip: request.ip, reason: refused },
      "auth: oidc connect refused",
    );
    return redirectWithError(reply, PROFILE_PAGE, refused);
  }
  request.log.info({ userId }, "auth: oidc connected");
  return reply.redirect(`${PROFILE_PAGE}?oidc=connected`);
}
