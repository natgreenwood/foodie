import Fastify, { type FastifyServerOptions } from "fastify";
import { healthRoutes, type HealthDeps } from "./routes/health.js";
import { importRoutes, type ImportDeps } from "./routes/imports.js";

export type AppDeps = HealthDeps & ImportDeps;

export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  app.register(healthRoutes, deps);
  app.register(importRoutes, deps);
  return app;
}
