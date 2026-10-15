import Fastify, { type FastifyServerOptions } from "fastify";
import { healthRoutes, type HealthDeps } from "./routes/health.js";

export type AppDeps = HealthDeps;

export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  app.register(healthRoutes, deps);
  return app;
}
