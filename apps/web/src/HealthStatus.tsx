import { useEffect, useState } from "react";
import { fetchHealth, HealthCheckError, type HealthResponse } from "./health";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; health: HealthResponse }
  | { kind: "error"; reason: string };

function describe(state: State): { tone: string; message: string } {
  switch (state.kind) {
    case "loading":
      return { tone: "pending", message: "Checking the API…" };
    case "error":
      return {
        tone: "bad",
        message: `Can't reach the API: ${state.reason}. Check the api container is running (docker compose ps), then check again.`,
      };
    case "loaded":
      return state.health.db === "up"
        ? {
            tone: "good",
            message: "The API is up and connected to the database.",
          }
        : {
            tone: "warn",
            message:
              "The API is up but can't reach the database. Check the postgres container is running (docker compose ps), then check again.",
          };
  }
}

export function HealthStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal).then(
      (health) => setState({ kind: "loaded", health }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        console.error("health check failed", err);
        setState({
          kind: "error",
          reason:
            err instanceof HealthCheckError
              ? err.message
              : "an unexpected error",
        });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const { tone, message } = describe(state);

  return (
    <section aria-labelledby="health-heading">
      <h2 id="health-heading">System status</h2>
      <p role="status" className="health" data-tone={tone}>
        {message}
      </p>
      <button
        type="button"
        onClick={() => {
          setState({ kind: "loading" });
          setAttempt((n) => n + 1);
        }}
      >
        Check again
      </button>
    </section>
  );
}
