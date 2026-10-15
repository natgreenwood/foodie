import type { FastifyPluginCallback } from "fastify";

export interface HealthDeps {
  pingDatabase: () => Promise<void>;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  db: "up" | "down";
}

// 200 when Postgres answers, 503 when it doesn't, so orchestrators can treat
// this as a readiness check. The underlying error is logged, not returned.
export const healthRoutes: FastifyPluginCallback<HealthDeps> = (
  app,
  { pingDatabase },
  done,
) => {
  app.get("/health", async (request, reply): Promise<HealthResponse> => {
    try {
      await pingDatabase();
      return { status: "ok", db: "up" };
    } catch (err) {
      request.log.warn({ err }, "health check: database unreachable");
      return reply.code(503).send({ status: "degraded", db: "down" });
    }
  });
  done();
};
