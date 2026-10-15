// Mirrors HealthResponse in apps/api/src/routes/health.ts.
export interface HealthResponse {
  status: "ok" | "degraded";
  db: "up" | "down";
}

export class HealthCheckError extends Error {
  override name = "HealthCheckError";
}

function isHealthResponse(body: unknown): body is HealthResponse {
  if (typeof body !== "object" || body === null) return false;
  const { status, db } = body as Record<string, unknown>;
  return (
    (status === "ok" || status === "degraded") && (db === "up" || db === "down")
  );
}

// The api answers 200 when healthy and 503 when degraded; both carry a
// HealthResponse body. Anything else means we did not reach the api itself.
export async function fetchHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  let res: Response;
  try {
    res = await fetch("/api/health", {
      headers: { Accept: "application/json" },
      ...(signal && { signal }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new HealthCheckError("the request failed before a response arrived");
  }

  if (res.status !== 200 && res.status !== 503) {
    throw new HealthCheckError(`the server answered with HTTP ${res.status}`);
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!isHealthResponse(body)) {
    throw new HealthCheckError("its response was not a health report");
  }
  return body;
}
