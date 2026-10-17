import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { sessionUser } from "../auth/accounts.js";
import {
  connectOidcIdentity,
  disconnectOidc,
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

// The oidc_error the web app is redirected back with, on /sign-in for a
// sign-in and on /profile for a connect. A code, never text: the web app
// owns the wording, so a crafted link cannot put words on our pages.
// Besides the refusals, provider_error covers a provider that could not be
// reached, answered with an error or a response that did not check out, and
// a trip that is missing, timed out, or was started by a user no longer
// signed in.
export type OidcRedirectError =
  OidcSignInRefusal | OidcConnectRefusal | "provider_error";

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
      return redirectWithError(reply, SIGN_IN_PAGE, "provider_error");
    }
    return reply.redirect(url.href);
  });

  // Where the provider sends the browser back, for a sign-in or a connect.
  // The trip is used up whatever happens, so a repeated callback answers
  // provider_error and changes nothing.
  app.get("/auth/oidc/callback", async (request, reply) => {
    if (!oidc) return notConfigured(reply);
    const token = request.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: oidc.callbackPath });
    const trip = token ? await takeOidcLogin(db, token) : null;
    const page = trip?.userId ? PROFILE_PAGE : SIGN_IN_PAGE;
    if (!trip) return redirectWithError(reply, page, "provider_error");

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
      return redirectWithError(reply, page, "provider_error");
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
    if (!result) return redirectWithError(reply, page, "provider_error");
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

// The signed-in OIDC routes: connect an identity to the account, or remove
// it; GET /me says whether one is connected. Registered behind requireUser.
export const oidcAccountRoutes: FastifyPluginCallback<OidcDeps> = (
  app,
  deps,
  done,
) => {
  const { db, oidc } = deps;
  app.setErrorHandler(apiErrorHandler("oidc"));
  // POST /auth/oidc/connect is submitted by a plain HTML form, which sends
  // an empty urlencoded body. Nothing is read from it; this scope only.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    (_request, _payload, parse) => parse(null, undefined),
  );

  // A full-page navigation from the profile: sends the browser to the
  // provider, and the callback lands back on /profile. A POST, so another
  // site cannot start it.
  app.post("/auth/oidc/connect", async (request, reply) => {
    if (!oidc) return notConfigured(reply);
    const url = await beginTrip(request, reply, deps, oidc, request.user!.id);
    if (!url) {
      return redirectWithError(reply, PROFILE_PAGE, "provider_error");
    }
    return reply.redirect(url.href);
  });

  // Unlinks the account's identity: 204, also when there was none. 409
  // no_local_password for an account with no local password.
  app.delete("/auth/oidc/connection", async (request, reply) => {
    const { refused } = await disconnectOidc(db, request.user!.id);
    if (refused) {
      return sendError(
        reply,
        409,
        "no_local_password",
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
    return redirectWithError(reply, PROFILE_PAGE, "provider_error");
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
