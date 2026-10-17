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
