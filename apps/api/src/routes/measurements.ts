import type { FastifyPluginCallback } from "fastify";
import { listMeasurements, type Measurement } from "../db/measurements.js";
import type { AuthDeps } from "./auth.js";
import { apiErrorHandler } from "./errors.js";

export interface MeasurementListResponse {
  measurements: Measurement[];
}

// GET /measurements: every unit of measure with its names, for a unit
// picker whose ids POST /imports takes as measurementId. Units are shared,
// not owned, so every signed-in user sees the same list. Registered behind
// requireUser.
export const measurementRoutes: FastifyPluginCallback<AuthDeps> = (
  app,
  { db },
  done,
) => {
  app.setErrorHandler(apiErrorHandler("measurements"));

  app.get("/measurements", async (): Promise<MeasurementListResponse> => {
    return { measurements: await listMeasurements(db) };
  });

  done();
};
