import { useEffect, useRef, useState } from "react";
import { AuthError } from "./auth";
import { AuthErrorMessage } from "./AuthErrorMessage";
import {
  connectRefusal,
  disconnectOidc,
  fetchOidcConnection,
  OIDC_CONNECT_URL,
  oidcLabel,
  oidcName,
  useOidcConfig,
  usePageRestored,
  type OidcConnection,
} from "./oidc";
import { useLocation } from "./router";

type Load =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "loaded"; connection: OidcConnection };

type Action =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "confirming" }
  | { kind: "disconnecting" }
  | { kind: "disconnected" }
  | { kind: "disconnectFailed"; error: unknown };

// The profile's OIDC section; nothing at all unless the api says it is on.
export function ConnectedIdentities({ email }: { email: string }) {
  const config = useOidcConfig();
  if (!config?.enabled) return null;
  return (
    <Identities
      name={oidcName(config)}
      label={oidcLabel(config)}
      email={email}
    />
  );
}

// The api returns no identity email, so the account's is shown: they are
// the same at the time of linking.
function Identities({
  name,
  label,
  email,
}: {
  name: string;
  label: string;
  email: string;
}) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  // Where a connect comes back to: ?oidc=connected or ?oidc_error=<code>.
  const refusedCode = params.get("oidc_error");
  const justConnected = params.get("oidc") === "connected";
  // That outcome is news only until the user does something here.
  const [outcomeCurrent, setOutcomeCurrent] = useState(true);

  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [action, setAction] = useState<Action>({ kind: "idle" });

  const connectButton = useRef<HTMLButtonElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const refusalAlert = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchOidcConnection(controller.signal).then(
      (connection) => setLoad({ kind: "loaded", connection }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        console.error("loading the OIDC connection failed", err);
        setLoad({
          kind: "error",
          reason:
            err instanceof AuthError ? err.message : "an unexpected error",
        });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  usePageRestored(() => setAction({ kind: "idle" }));

  const loaded = load.kind === "loaded";
  const refusal =
    loaded && refusedCode && outcomeCurrent
      ? connectRefusal(refusedCode, name)
      : null;

  useEffect(() => {
    if (refusal) refusalAlert.current?.focus();
  }, [refusal]);

  useEffect(() => {
    if (action.kind === "confirming") confirmButton.current?.focus();
    if (action.kind === "disconnected") connectButton.current?.focus();
    if (action.kind === "idle" && cancelled.current) {
      cancelled.current = false;
      disconnectButton.current?.focus();
    }
  }, [action.kind]);

  function cancel() {
    cancelled.current = true;
    setAction({ kind: "idle" });
  }

  function disconnect() {
    setAction({ kind: "disconnecting" });
    disconnectOidc().then(
      () => {
        setLoad({
          kind: "loaded",
          connection: { connected: false, hasPassword: true },
        });
        setAction({ kind: "disconnected" });
      },
      (err: unknown) => {
        console.error("disconnecting OIDC failed", err);
        if (err instanceof AuthError && err.code === "no_local_password") {
          setLoad({
            kind: "loaded",
            connection: { connected: true, hasPassword: false },
          });
        }
        setAction({ kind: "disconnectFailed", error: err });
      },
    );
  }

  return (
    <section className="identities" aria-labelledby="identities-heading">
      <h3 id="identities-heading">Connected identities</h3>

      {load.kind === "loading" && (
        <p role="status" className="health" data-tone="pending">
          Loading connected identities…
        </p>
      )}
      {load.kind === "error" && (
        <>
          <div role="alert" className="health" data-tone="bad">
            <p>Couldn't load connected identities: {load.reason}. Try again.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setLoad({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </>
      )}

      {loaded && !load.connection.connected && (
        <>
          <p>No identity connected.</p>
          <p id="identities-hint" className="hint">
            Connect {name} to sign in with it as well as your password. It must
            return the same email as this account.
          </p>
          {/* The browser submits it with an empty urlencoded body and follows
              the api's redirect to the provider. */}
          <form
            method="post"
            action={OIDC_CONNECT_URL}
            onSubmit={() => {
              setOutcomeCurrent(false);
              setAction({ kind: "connecting" });
            }}
          >
            <button
              ref={connectButton}
              type="submit"
              aria-describedby="identities-hint"
              disabled={action.kind === "connecting"}
            >
              Connect {name}
            </button>
          </form>
        </>
      )}

      {loaded && load.connection.connected && (
        <>
          <dl className="facts">
            <dt>{label}</dt>
            <dd>{email}</dd>
          </dl>
          {!load.connection.hasPassword && (
            <p className="hint">
              This account was created through {name} and has no password, so it
              can't be disconnected.
            </p>
          )}
          {load.connection.hasPassword && action.kind !== "confirming" && (
            <button
              ref={disconnectButton}
              type="button"
              disabled={action.kind === "disconnecting"}
              onClick={() => {
                setOutcomeCurrent(false);
                setAction({ kind: "confirming" });
              }}
            >
              Disconnect
            </button>
          )}
          {load.connection.hasPassword && action.kind === "confirming" && (
            <div
              role="group"
              aria-labelledby="disconnect-confirm"
              className="notice"
              onKeyDown={(event) => {
                if (event.key === "Escape") cancel();
              }}
            >
              <p id="disconnect-confirm">
                Disconnect {name}? You'll sign in with your password only.
              </p>
              <div className="actions">
                <button ref={confirmButton} type="button" onClick={disconnect}>
                  Disconnect
                </button>
                <button type="button" onClick={cancel}>
                  Keep connected
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {action.kind === "connecting" && (
        <p role="status" className="health" data-tone="pending">
          Taking you to {name}…
        </p>
      )}
      {action.kind === "disconnecting" && (
        <p role="status" className="health" data-tone="pending">
          Disconnecting…
        </p>
      )}
      {action.kind === "disconnected" && (
        <p role="status" className="health" data-tone="good">
          Disconnected {name}.
        </p>
      )}
      {loaded &&
        load.connection.connected &&
        justConnected &&
        outcomeCurrent && (
          <p role="status" className="health" data-tone="good">
            Connected {name}. You can now sign in with it.
          </p>
        )}
      {refusal && (
        <div
          ref={refusalAlert}
          tabIndex={-1}
          role="alert"
          className="health"
          data-tone="bad"
        >
          <p>{refusal}</p>
        </div>
      )}
      {action.kind === "disconnectFailed" && (
        <FailureMessage
          error={action.error}
          message={(code) =>
            code === "no_local_password"
              ? `This account has no password, so ${name} can't be disconnected.`
              : undefined
          }
        />
      )}
    </section>
  );
}

// An api refusal in this section's own words where it has them, and the
// shared auth error message otherwise. A 401 has already sent the user to
// sign-in, so it shows nothing.
function FailureMessage({
  error,
  message,
}: {
  error: unknown;
  message: (code: string) => string | undefined;
}) {
  if (!(error instanceof AuthError)) return <AuthErrorMessage error={error} />;
  if (error.code === "unauthenticated") return null;
  const own = error.code === null ? undefined : message(error.code);
  if (!own) return <AuthErrorMessage error={error} />;
  return (
    <div role="alert" className="health" data-tone="bad">
      <p>{own}</p>
    </div>
  );
}
