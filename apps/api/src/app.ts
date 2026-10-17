import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { adminAiRoutes, type AdminAiDeps } from "./routes/admin-ai.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import {
  authRoutes,
  registerSessionSupport,
  requireAdmin,
  requireUser,
} from "./routes/auth.js";
import { sendError } from "./routes/errors.js";
import { healthRoutes, type HealthDeps } from "./routes/health.js";
import { importRoutes, type ImportDeps } from "./routes/imports.js";
import { meRoutes } from "./routes/me.js";
import { recipeRoutes } from "./routes/recipes.js";

export type AppDeps = HealthDeps & ImportDeps & AdminAiDeps;

// Log paths pino replaces with "[Redacted]". Nothing logs a request body or
// an AI provider credential; this is the backstop should a later change
// start to, so a key sent to /admin/ai never reaches a log line.
export const logRedactPaths = [
  "req.body",
  "body",
  "apiKey",
  "baseUrl",
  "*.apiKey",
  "*.baseUrl",
];

// Pino serializers for the server's logger. The req serializer gives the
// same fields as Fastify's default (which Fastify does not export), except
// that an /admin URL is logged without its query string: the admin routes
// never read one, so a key a client puts there must not reach a log line.
export const logSerializers = {
  req(req: FastifyRequest) {
    const isAdmin = /^\/admin(?:[/?#]|$)/.test(req.url);
    const version = req.headers["accept-version"];
    const remotePort = req.socket?.remotePort;
    // Fastify's default sets these to undefined, which pino leaves out of
    // the line; leaving them off here writes the same line.
    return {
      method: req.method,
      url: isAdmin ? req.url.replace(/[?#].*$/, "") : req.url,
      ...(typeof version === "string" ? { version } : {}),
      host: req.host,
      remoteAddress: req.ip,
      ...(remotePort === undefined ? {} : { remotePort }),
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
  // Fastify's own 404 logs and answers "Route GET:<url> not found" with the
  // raw URL, query string included; this one repeats nothing the client sent.
  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, "not_found", "route not found"),
  );
  registerSessionSupport(app);
  app.register(healthRoutes, deps);
  app.register(authRoutes, deps);
  // Every route that needs a signed-in user is registered in here, behind
  // requireUser, which answers 401 or sets request.user.
  app.register((signedIn, _opts, done) => {
    signedIn.addHook("onRequest", seams.requireUser ?? requireUser(deps));
    signedIn.register(meRoutes, deps);
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
