import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { sessionUser } from "../auth/accounts.js";
import {
  connectOidcIdentity,
  disconnectOidc,
  discardOidcLogin,
  signInWithOidc,
  startOidcLogin,
  takeOidcLogin,
  type OidcConnectRefusal,
  type OidcSignInRefusal,
} from "../auth/oidc.js";
import type { OidcClaims, OidcProvider } from "../auth/oidc-provider.js";
import { slidingWindow, type SlidingWindow } from "../auth/sliding-window.js";
import { describeError } from "../db/errors.js";
import { SESSION_COOKIE, startSession, type AuthDeps } from "./auth.js";
import { apiErrorHandler, sendError } from "./errors.js";

export interface OidcDeps extends AuthDeps {
  // The configured provider; absent or null when OIDC sign-in is off.
  oidc?: OidcProvider | null;
}

// What the routes are registered with: the app's deps and the one window
// that counts starts per client, shared by sign-in and connect.
export interface OidcRouteDeps extends OidcDeps {
  oidcStarts: SlidingWindow;
}

// Client addresses the start window remembers at most.
export const OIDC_START_KEYS = 10_000;

// The per-client window for an app; per api process, like the app.
export function oidcStartWindow(oidc: OidcProvider | null | undefined) {
  return slidingWindow({
    limit: oidc?.startsPerMinute ?? 10,
    windowMs: 60_000,
    maxKeys: OIDC_START_KEYS,
  });
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
export const oidcRoutes: FastifyPluginCallback<OidcRouteDeps> = (
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
    const trip = await beginTrip(request, reply, deps, oidc, null);
    if (trip === "rate_limited") return rateLimited(reply);
    if (trip === "provider_error") {
      return redirectWithError(reply, SIGN_IN_PAGE, "provider_error");
    }
    return reply.redirect(trip.href);
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
export const oidcAccountRoutes: FastifyPluginCallback<OidcRouteDeps> = (
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
  // provider, and the callback lands back on /profile. Another site cannot
  // start it for a signed-in user because the session cookie is
  // SameSite=Lax, so a cross-site form POST arrives signed out; being a POST
  // alone would not stop it.
  app.post("/auth/oidc/connect", async (request, reply) => {
    if (!oidc) return notConfigured(reply);
    const trip = await beginTrip(request, reply, deps, oidc, request.user!.id);
    if (trip === "rate_limited") return rateLimited(reply);
    if (trip === "provider_error") {
      return redirectWithError(reply, PROFILE_PAGE, "provider_error");
    }
    return reply.redirect(trip.href);
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

// 429 for a start over either admission limit. A JSON body, as for any
// other refusal: the page that sent the browser here shows it as is.
function rateLimited(reply: FastifyReply) {
  return sendError(
    reply,
    429,
    "rate_limited",
    "too many sign-in attempts; try again in a minute",
  );
}

// Records a trip to the provider and sets its cookie; the URL to send the
// browser to. rate_limited, with nothing recorded and the provider not
// contacted, when this client has started too many trips in the last minute
// or too many are in progress across all clients. provider_error when the
// provider could not be reached.
async function beginTrip(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OidcRouteDeps,
  oidc: OidcProvider,
  userId: number | null,
): Promise<URL | "rate_limited" | "provider_error"> {
  // request.ip: the client, once TRUST_PROXY names the proxy in front of
  // the api (NATG-281); until then every client behind a proxy shares one.
  const key = request.ip;
  if (!deps.oidcStarts.admit(key)) {
    request.log.warn(
      { reason: "client_starts", key },
      "auth: oidc start refused",
    );
    return "rate_limited";
  }
  const checks = oidc.newChecks();
  const started = await startOidcLogin(
    deps.db,
    checks,
    userId,
    oidc.maxPendingLogins,
  );
  if (!started) {
    request.log.warn(
      { reason: "pending_logins", key },
      "auth: oidc start refused",
    );
    return "rate_limited";
  }
  const { token, expiresAt } = started;
  let url: URL;
  try {
    url = await oidc.authorizationUrl(checks);
  } catch (err) {
    request.log.error(
      { error: describeError(err) },
      "auth: oidc provider unavailable",
    );
    await discardOidcLogin(deps.db, token);
    return "provider_error";
  }
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
  { db }: OidcRouteDeps,
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
