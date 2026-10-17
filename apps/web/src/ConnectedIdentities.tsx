import { useEffect, useRef, useState } from "react";
import { AuthError } from "./auth";
import { AuthErrorMessage } from "./AuthErrorMessage";
import {
  connectRefusal,
  disconnectOidc,
  fetchOidcConnection,
  oidcConnectUrl,
  oidcLabel,
  oidcName,
  returningProviderName,
  useOidcConfig,
  usePageRestored,
  type OidcConnection,
  type OidcProvider,
  type ProviderConnection,
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

// The profile's OIDC section; nothing at all unless the api lists a provider.
export function ConnectedIdentities({ email }: { email: string }) {
  const config = useOidcConfig();
  if (!config || config.providers.length === 0) return null;
  return <Identities providers={config.providers} email={email} />;
}

function Identities({
  providers,
  email,
}: {
  providers: OidcProvider[];
  email: string;
}) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  // Where a connect comes back to: ?oidc=connected or ?oidc_error=<code>,
  // with ?oidc_provider=<id> saying which provider it was.
  const refusedCode = params.get("oidc_error");
  const justConnected = params.get("oidc") === "connected";
  const returnedName = returningProviderName(params, providers);
  // That outcome is news only until the user does something here.
  const [outcomeCurrent, setOutcomeCurrent] = useState(true);

  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const refusalAlert = useRef<HTMLDivElement>(null);

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

  // After the api refuses a disconnect, what it now says about the account,
  // without leaving the rows (and the refusal shown in one) for a reload.
  function refresh() {
    fetchOidcConnection().then(
      (connection) => setLoad({ kind: "loaded", connection }),
      (err: unknown) =>
        console.error("reloading the OIDC connection failed", err),
    );
  }

  const loaded = load.kind === "loaded";
  const refusal =
    loaded && refusedCode && outcomeCurrent
      ? connectRefusal(refusedCode, returnedName)
      : null;
  // A connect that names a listed provider is done when that one is
  // connected; one that names none, or one not listed, when anything is.
  const returnedFrom =
    load.kind === "loaded"
      ? load.connection.providers.find(
          (row) => row.id === params.get("oidc_provider"),
        )
      : undefined;
  const connectedNow =
    loaded &&
    (returnedFrom
      ? returnedFrom.connected
      : load.connection.providers.some((row) => row.connected));

  useEffect(() => {
    if (refusal) refusalAlert.current?.focus();
  }, [refusal]);

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

      {justConnected && connectedNow && outcomeCurrent && (
        <p role="status" className="health" data-tone="good">
          Connected {returnedName}. You can now sign in with it.
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

      {load.kind === "loaded" && (
        <ul className="identity-list" aria-labelledby="identities-heading">
          {load.connection.providers.map((row) => (
            <Identity
              key={row.id}
              row={row}
              connection={load.connection}
              email={email}
              onAction={() => setOutcomeCurrent(false)}
              onDisconnected={() =>
                setLoad({
                  kind: "loaded",
                  connection: {
                    ...load.connection,
                    providers: load.connection.providers.map((entry) =>
                      entry.id === row.id
                        ? { ...entry, connected: false }
                        : entry,
                    ),
                  },
                })
              }
              onRefused={refresh}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// What else signs in to the account if this provider goes: the password and
// any other provider the api lists as connected.
function remainingSignIns(row: ProviderConnection, connection: OidcConnection) {
  const others = connection.providers
    .filter((entry) => entry.id !== row.id && entry.connected)
    .map(oidcName);
  return connection.hasPassword ? ["your password", ...others] : others;
}

// One provider's row. The api returns no identity email, so the account's is
// shown: they are the same at the time of linking.
function Identity({
  row,
  connection,
  email,
  onAction,
  onDisconnected,
  onRefused,
}: {
  row: ProviderConnection;
  connection: OidcConnection;
  email: string;
  onAction: () => void;
  onDisconnected: () => void;
  onRefused: () => void;
}) {
  const name = oidcName(row);
  const remaining = remainingSignIns(row, connection);
  const canDisconnect = remaining.length > 0;
  const [action, setAction] = useState<Action>({ kind: "idle" });

  const connectButton = useRef<HTMLButtonElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);

  const nameId = `identity-${row.id}-name`;
  const hintId = `identity-${row.id}-hint`;
  const confirmId = `identity-${row.id}-confirm`;

  usePageRestored(() => setAction({ kind: "idle" }));

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
    disconnectOidc(row.id).then(
      () => {
        onDisconnected();
        setAction({ kind: "disconnected" });
      },
      (err: unknown) => {
        console.error(`disconnecting OIDC provider ${row.id} failed`, err);
        if (err instanceof AuthError && err.code === "no_other_sign_in") {
          onRefused();
        }
        setAction({ kind: "disconnectFailed", error: err });
      },
    );
  }

  return (
    <li className="identity">
      <p id={nameId} className="identity-name">
        {oidcLabel(row)}
      </p>

      {!row.connected && (
        <>
          <p id={hintId} className="hint">
            {connection.hasPassword
              ? `Connect ${name} to sign in with it as well as your password. It must return the same email as this account.`
              : `Connect ${name} to sign in with it too. It must return the same email as this account.`}
          </p>
          {/* The browser submits it with an empty urlencoded body and follows
              the api's redirect to the provider. */}
          <form
            method="post"
            action={oidcConnectUrl(row.id)}
            onSubmit={() => {
              onAction();
              setAction({ kind: "connecting" });
            }}
          >
            <button
              ref={connectButton}
              type="submit"
              aria-describedby={hintId}
              disabled={action.kind === "connecting"}
            >
              Connect {name}
            </button>
          </form>
        </>
      )}

      {row.connected && (
        <>
          <p className="identity-detail">{email}</p>
          {!canDisconnect && (
            <p className="hint">
              {capitalised(name)} is the only way to sign in to this account, so
              it can't be disconnected.
            </p>
          )}
          {canDisconnect && action.kind !== "confirming" && (
            <button
              ref={disconnectButton}
              type="button"
              aria-describedby={nameId}
              disabled={action.kind === "disconnecting"}
              onClick={() => {
                onAction();
                setAction({ kind: "confirming" });
              }}
            >
              Disconnect
            </button>
          )}
          {canDisconnect && action.kind === "confirming" && (
            <div
              role="group"
              aria-labelledby={confirmId}
              className="notice"
              onKeyDown={(event) => {
                if (event.key === "Escape") cancel();
              }}
            >
              <p id={confirmId}>
                Disconnect {name}? You'll still be able to sign in with{" "}
                {remaining.join(" or ")}.
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
      {action.kind === "disconnectFailed" && (
        <FailureMessage
          error={action.error}
          message={(code) =>
            code === "no_other_sign_in"
              ? `${capitalised(name)} is the only way to sign in to this account, so it can't be disconnected.`
              : undefined
          }
        />
      )}
    </li>
  );
}

// For the lines that start with a provider's name, which may be the
// lower-case generic one.
function capitalised(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
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
