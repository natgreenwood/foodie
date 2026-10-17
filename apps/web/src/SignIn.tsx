import { useEffect, useRef, useState } from "react";
import { signIn } from "./auth";
import { AuthErrorMessage } from "./AuthErrorMessage";
import {
  OIDC_START_URL,
  oidcName,
  signInRefusal,
  useOidcConfig,
  usePageRestored,
} from "./oidc";
import { Link, leaveFor, useLocation } from "./router";
import { useSession } from "./session";

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; error: unknown }
  | { kind: "redirecting" };

// Signing in sets the session; App then sends the user on to ?next.
export function SignIn({ expired }: { expired: boolean }) {
  const session = useSession();
  const { search } = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const submitting = state.kind === "submitting";
  const redirecting = state.kind === "redirecting";
  // Nothing about OIDC shows until the api says it is on.
  const config = useOidcConfig();
  const name = config?.enabled ? oidcName(config) : null;
  // A refused OIDC sign-in comes back as a page load with ?oidc_error=.
  const refusedCode = new URLSearchParams(search).get("oidc_error");
  const [refusalDismissed, setRefusalDismissed] = useState(false);
  const refusal =
    name && refusedCode && !refusalDismissed
      ? signInRefusal(refusedCode, name)
      : null;
  const refusalAlert = useRef<HTMLDivElement>(null);

  // Read before the form, as it is what the page load is about.
  useEffect(() => {
    if (refusal) refusalAlert.current?.focus();
  }, [refusal]);

  usePageRestored(() => setState({ kind: "idle" }));

  return (
    <section aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading">Sign in</h2>
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
      {expired && (
        <p className="notice">
          Your session has ended. Sign in again to carry on.
        </p>
      )}
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
          setRefusalDismissed(true);
          setState({ kind: "submitting" });
          signIn(email, password).then(session.signedIn, (err: unknown) => {
            console.error("sign-in failed", err);
            setState({ kind: "error", error: err });
          });
        }}
      >
        <label htmlFor="sign-in-email">Email</label>
        <input
          id="sign-in-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="sign-in-password">Password</label>
        <input
          id="sign-in-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={submitting || redirecting}>
          Sign in
        </button>
      </form>

      {submitting && (
        <p role="status" className="health" data-tone="pending">
          Signing in…
        </p>
      )}
      {state.kind === "error" && <AuthErrorMessage error={state.error} />}

      {name && (
        <div className="sso">
          <p className="sso-divider">or</p>
          <button
            type="button"
            disabled={submitting || redirecting}
            onClick={() => {
              setRefusalDismissed(true);
              setState({ kind: "redirecting" });
              leaveFor(OIDC_START_URL);
            }}
          >
            Sign in with {name}
          </button>
        </div>
      )}
      {redirecting && name && (
        <p role="status" className="health" data-tone="pending">
          Taking you to {name}…
        </p>
      )}

      <p>
        No account yet? <Link to={`/register${search}`}>Register</Link>
      </p>
    </section>
  );
}
