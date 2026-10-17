import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { sessionUser } from "../auth/accounts.js";
import { clientKey } from "../auth/client-key.js";
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
import type { OidcProviderId } from "../config.js";
import { slidingWindow, type SlidingWindow } from "../auth/sliding-window.js";
import { describeError } from "../db/errors.js";
import { SESSION_COOKIE, startSession, type AuthDeps } from "./auth.js";
import { apiErrorHandler, RateLimitedError, sendError } from "./errors.js";

export interface OidcDeps extends AuthDeps {
  // The generic provider (NATG-226); absent or null when it is off.
  oidc?: OidcProvider | null;
  // Google (NATG-291); absent or null when it is off.
  google?: OidcProvider | null;
}

// The configured providers, generic then google.
export function configuredProviders(deps: OidcDeps): OidcProvider[] {
  return [deps.oidc, deps.google].filter((p): p is OidcProvider => !!p);
}

// What the routes are registered with: the app's deps and the one window
// that counts starts per client, shared by sign-in and connect.
export interface OidcRouteDeps extends OidcDeps {
  oidcStarts: SlidingWindow;
}

// Client keys the start window remembers at most.
export const OIDC_START_KEYS = 10_000;

// The per-client window for an app; per api process, like the app. Every
// provider reads the same OIDC_STARTS_PER_MINUTE, so the first one's is
// everyone's.
export function oidcStartWindow(providers: OidcProvider[]) {
  return slidingWindow({
    limit: providers[0]?.startsPerMinute ?? 10,
    windowMs: 60_000,
    maxKeys: OIDC_START_KEYS,
  });
}

const RATE_LIMITED_MESSAGE = "too many sign-in attempts; try again in a minute";

// @fastify/rate-limit's limit on start, callback, connect and disconnect:
// per client key, a fixed minute per route, so all providers' requests to
// /auth/oidc/:provider/start share one count. Before the handler, so a
// refused start writes nothing. The start window above stays the sliding
// count that sign-in and connect share across every route; this one also
// covers the callback.
function perClientLimit(providers: OidcProvider[]) {
  return {
    max: providers[0]?.startsPerMinute ?? 10,
    timeWindow: 60_000,
    errorResponseBuilder: () => new RateLimitedError(RATE_LIMITED_MESSAGE),
  };
}

export interface OidcConfigResponse {
  // Whether any provider is configured.
  enabled: boolean;
  // One per configured provider, generic then google.
  providers: { id: OidcProviderId; displayName: string | null }[];
  // The generic provider's display name, as the web app read it before it
  // read providers; until NATG-291's web change lands.
  displayName: string | null;
}

// The route parameter naming a provider.
interface ProviderParams {
  provider: string;
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

// The configured provider a :provider parameter names, or null; "generic"
// for the unprefixed alias routes.
function providerFor(providers: OidcProvider[], id = "generic") {
  return providers.find((provider) => provider.id === id) ?? null;
}

// The open OIDC routes: whether it is on, and the sign-in round trip.
// Browser navigations, not fetches, except /auth/oidc/config: they answer
// with redirects, to the provider or back to a web app page.
export const oidcRoutes: FastifyPluginCallback<OidcRouteDeps> = (
  app,
  deps,
  done,
) => {
  const { db } = deps;
  const providers = configuredProviders(deps);
  const limited = { config: { rateLimit: perClientLimit(providers) } };
  app.setErrorHandler(apiErrorHandler("oidc"));

  app.get("/auth/oidc/config", (): OidcConfigResponse => {
    return {
      enabled: providers.length > 0,
      providers: providers.map(({ id, displayName }) => ({ id, displayName })),
      displayName: deps.oidc?.displayName ?? null,
    };
  });

  // Sends the browser to the provider to sign in.
  async function signInStart(
    request: FastifyRequest,
    reply: FastifyReply,
    oidc: OidcProvider | null,
  ) {
    if (!oidc) return notConfigured(reply);
    const trip = await beginTrip(request, reply, deps, oidc, null);
    if (trip === "rate_limited") return rateLimited(reply);
    if (trip === "provider_error") {
      return redirectWithError(reply, SIGN_IN_PAGE, "provider_error");
    }
    return reply.redirect(trip.href);
  }

  // Where the provider sends the browser back, for a sign-in or a connect.
  // The trip is used up whatever happens, so a repeated callback answers
  // provider_error and changes nothing. Each provider's trip cookie is
  // scoped to its own callback path, so a callback only sees its own.
  async function callback(
    request: FastifyRequest,
    reply: FastifyReply,
    oidc: OidcProvider | null,
  ) {
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
        { ip: request.ip, provider: oidc.id, error: describeError(err) },
        "auth: oidc callback failed",
      );
      return redirectWithError(reply, page, "provider_error");
    }

    if (trip.userId !== null) {
      return finishConnect(request, reply, deps, oidc, trip.userId, claims);
    }

    const result = await signInWithOidc(db, claims).catch((err: unknown) => {
      request.log.error(
        { provider: oidc.id, error: describeError(err) },
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
      { userId: result.user.id, provider: oidc.id, outcome: result.outcome },
      "auth: oidc sign-in",
    );
    return reply.redirect("/");
  }

  app.get<{ Params: ProviderParams }>(
    "/auth/oidc/:provider/start",
    limited,
    (request, reply) =>
      signInStart(
        request,
        reply,
        providerFor(providers, request.params.provider),
      ),
  );
  app.get<{ Params: ProviderParams }>(
    "/auth/oidc/:provider/callback",
    limited,
    (request, reply) =>
      callback(request, reply, providerFor(providers, request.params.provider)),
  );
  // The generic provider's routes before providers had ids (NATG-226).
  app.get("/auth/oidc/start", limited, (request, reply) =>
    signInStart(request, reply, providerFor(providers)),
  );
  app.get("/auth/oidc/callback", limited, (request, reply) =>
    callback(request, reply, providerFor(providers)),
  );

  done();
};

// The signed-in OIDC routes: connect an identity to the account, or remove
// it; GET /me says whether one is connected. Registered behind requireUser.
export const oidcAccountRoutes: FastifyPluginCallback<OidcRouteDeps> = (
  app,
  deps,
  done,
) => {
  const { db } = deps;
  const providers = configuredProviders(deps);
  const limited = { config: { rateLimit: perClientLimit(providers) } };
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
  async function connect(
    request: FastifyRequest,
    reply: FastifyReply,
    oidc: OidcProvider | null,
  ) {
    if (!oidc) return notConfigured(reply);
    const trip = await beginTrip(request, reply, deps, oidc, request.user!.id);
    if (trip === "rate_limited") return rateLimited(reply);
    if (trip === "provider_error") {
      return redirectWithError(reply, PROFILE_PAGE, "provider_error");
    }
    return reply.redirect(trip.href);
  }

  // Unlinks the account's identity from the provider: 204, also when there
  // was none. 409 no_other_sign_in when the account would be left with no
  // way to sign in: no local password and no identity from another
  // configured provider. 404 like the other OIDC routes when the provider is
  // off, leaving any link as it is for when it is configured again.
  async function disconnect(
    request: FastifyRequest,
    reply: FastifyReply,
    oidc: OidcProvider | null,
  ) {
    if (!oidc) return notConfigured(reply);
    const others = providers.filter((provider) => provider !== oidc);
    const { refused } = await disconnectOidc(
      db,
      request.user!.id,
      oidc,
      others,
    );
    if (refused) {
      return sendError(
        reply,
        409,
        "no_other_sign_in",
        "an account cannot disconnect its only way to sign in",
      );
    }
    request.log.info(
      { userId: request.user!.id, provider: oidc.id },
      "auth: oidc disconnected",
    );
    return reply.code(204).send();
  }

  app.post<{ Params: ProviderParams }>(
    "/auth/oidc/:provider/connect",
    limited,
    (request, reply) =>
      connect(request, reply, providerFor(providers, request.params.provider)),
  );
  app.delete<{ Params: ProviderParams }>(
    "/auth/oidc/:provider/connection",
    limited,
    (request, reply) =>
      disconnect(
        request,
        reply,
        providerFor(providers, request.params.provider),
      ),
  );
  // The generic provider's routes before providers had ids (NATG-226).
  app.post("/auth/oidc/connect", limited, (request, reply) =>
    connect(request, reply, providerFor(providers)),
  );
  app.delete("/auth/oidc/connection", limited, (request, reply) =>
    disconnect(request, reply, providerFor(providers)),
  );

  done();
};

// 429 for a start over either admission limit. A JSON body, as for any
// other refusal: the page that sent the browser here shows it as is.
function rateLimited(reply: FastifyReply) {
  return sendError(reply, 429, "rate_limited", RATE_LIMITED_MESSAGE);
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
  // The same key as the per-route limits (see clientKey). It follows
  // TRUST_PROXY (NATG-281); without it every client behind a proxy shares one.
  const key = clientKey(request);
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
  oidc: OidcProvider,
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
      {
        userId,
        provider: oidc.id,
        email: claims.email,
        ip: request.ip,
        reason: refused,
      },
      "auth: oidc connect refused",
    );
    return redirectWithError(reply, PROFILE_PAGE, refused);
  }
  request.log.info({ userId, provider: oidc.id }, "auth: oidc connected");
  return reply.redirect(`${PROFILE_PAGE}?oidc=connected`);
}
