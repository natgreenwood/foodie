import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { clientKey } from "./auth/client-key.js";
import { adminAiRoutes, type AdminAiDeps } from "./routes/admin-ai.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import {
  authRoutes,
  registerSessionSupport,
  requireAdmin,
  requireUser,
} from "./routes/auth.js";
import { healthRoutes, type HealthDeps } from "./routes/health.js";
import { importRoutes, type ImportDeps } from "./routes/imports.js";
import { meRoutes } from "./routes/me.js";
import {
  configuredProviders,
  oidcAccountRoutes,
  oidcRoutes,
  oidcStartWindow,
  type OidcDeps,
} from "./routes/oidc.js";
import { recipeRoutes } from "./routes/recipes.js";
import { pathForLog, sendError } from "./routes/errors.js";

export type AppDeps = HealthDeps & ImportDeps & AdminAiDeps & OidcDeps;

// Log paths pino replaces with "[Redacted]". Nothing logs a request body,
// an AI provider credential or an authentication secret; this is the
// backstop should a later change start to, so a key sent to /admin/ai, a
// password, the OIDC client secret, a trip's checks, the code the provider
// sends back, a token or a cookie never reaches a log line. Only fields:
// a secret inside a message or error string is not caught. Bare `code` is
// left alone, since lines log a Fastify or driver error code under it; the
// authorization code is caught under `query`, where it arrives.
// err.rawPacket is the request bytes, query and cookies included, on the
// parser error Fastify logs at trace level for a malformed request.
export const logRedactPaths = [
  "req.body",
  "body",
  "apiKey",
  "baseUrl",
  "*.apiKey",
  "*.baseUrl",
  "err.rawPacket",
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "clientSecret",
  "*.clientSecret",
  "client_secret",
  "*.client_secret",
  "checks",
  "*.checks",
  "codeVerifier",
  "*.codeVerifier",
  "code_verifier",
  "*.code_verifier",
  "query.code",
  "*.query.code",
  "token",
  "*.token",
  "access_token",
  "*.access_token",
  "id_token",
  "*.id_token",
  "refresh_token",
  "*.refresh_token",
  "cookies",
  "*.cookies",
  "headers.cookie",
  "*.headers.cookie",
  'headers["set-cookie"]',
  '*.headers["set-cookie"]',
  "headers.authorization",
  "*.headers.authorization",
];

// Fastify's request log line, with the path only: no route logs its query
// string, so the OIDC callback's authorization code and state, or a key a
// client put in an admin URL, never reach a log line whatever the spelling.
export const logSerializers = {
  req(request: FastifyRequest) {
    const port = request.socket.remotePort;
    return {
      method: request.method,
      url: pathForLog(request.url),
      host: request.host,
      remoteAddress: request.ip,
      ...(port === undefined ? {} : { remotePort: port }),
    };
  },
};

export interface AppSeams {
  // Replaces the signed-in scope's session check, so a route test can sign a
  // request in without a database. The server never passes this.
  requireUser?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;
}

export function buildApp(
  deps: AppDeps,
  options: FastifyServerOptions = {},
  seams: AppSeams = {},
) {
  const app = Fastify(options);
  // Fastify's own 404 puts the full URL, query and all, in its message and
  // its log line.
  app.setNotFoundHandler((request, reply) => {
    request.log.info(
      { method: request.method, path: pathForLog(request.url) },
      "route not found",
    );
    return sendError(reply, 404, "not_found", "route not found");
  });
  // Limits only the routes that set config.rateLimit, per client (see
  // clientKey). A refusal is a RateLimitedError, which the routes'
  // apiErrorHandler answers as 429 rate_limited.
  app.register(rateLimit, { global: false, keyGenerator: clientKey });
  registerSessionSupport(app);
  // Sign-in and connect starts share one count per client, across providers.
  const oidcDeps = {
    ...deps,
    oidcStarts: oidcStartWindow(configuredProviders(deps)),
  };
  app.register(healthRoutes, deps);
  app.register(authRoutes, deps);
  app.register(oidcRoutes, oidcDeps);
  // Every route that needs a signed-in user is registered in here, behind
  // requireUser, which answers 401 or sets request.user.
  app.register((signedIn, _opts, done) => {
    signedIn.addHook("onRequest", seams.requireUser ?? requireUser(deps));
    signedIn.register(meRoutes, deps);
    signedIn.register(oidcAccountRoutes, oidcDeps);
    signedIn.register(recipeRoutes, deps);
    signedIn.register(importRoutes, deps);
    // Admin-only routes: requireAdmin answers 403 to everyone else.
    signedIn.register((admin, _opts, adminDone) => {
      admin.addHook("onRequest", requireAdmin);
      admin.register(adminUserRoutes, deps);
      admin.register(adminAiRoutes, deps);
      adminDone();
    });
    done();
  });
  return app;
}
